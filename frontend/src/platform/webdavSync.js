/**
 * Shared Android WebDAV implementation for the v0.11.x manual sync contract.
 *
 * Android never runs Python/FastAPI, so the device talks to the user's own
 * WebDAV server directly through the Capacitor native HTTP plugin (RijiHttp).
 * This module owns the protocol, validation, route logic and status handling;
 * the two local data layers only provide storage, export and package validation
 * through `createSyncRoutes`.
 *
 * Password handling: a remembered password lives in the local SQLite config
 * row. Session-only passwords stay in this module's process memory. The config
 * row is outside the portable JSON package and never appears in responses.
 */

import { ApiError } from '../api/errors.js';
import { NativeRequestError, nativeRequest } from './nativeHttp.js';

export const DEFAULT_REMOTE_DIRECTORY = 'daytrace';
export const DEFAULT_REMOTE_FILENAME = 'daytrace-latest.json';
const PROBE_FILENAME = '.daytrace-write-probe.json';
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/>'
  + '</d:prop></d:propfind>';

export const SYNC_ERROR_MESSAGES = Object.freeze({
  WEBDAV_URL_INVALID: '服务器地址格式不正确',
  WEBDAV_INSECURE_HTTP: '当前服务器地址未使用 HTTPS，需要先确认安全风险',
  WEBDAV_NETWORK_ERROR: '无法连接 WebDAV 服务器，请检查地址和网络',
  WEBDAV_TLS_ERROR: '服务器证书校验失败',
  WEBDAV_AUTH_FAILED: '用户名或应用密码错误',
  WEBDAV_FORBIDDEN: '没有访问或写入权限',
  WEBDAV_NOT_FOUND: '远端文件或目录不存在',
  WEBDAV_METHOD_NOT_ALLOWED: '当前服务器不支持所需 WebDAV 操作',
  WEBDAV_CONFLICT: '远端文件已被其他设备修改，请重新读取后再上传',
  WEBDAV_QUOTA_EXCEEDED: '远端空间不足',
  WEBDAV_INVALID_PACKAGE: '远端文件不是有效的日迹数据包',
  WEBDAV_UNSUPPORTED_SCHEMA: '数据包 schema_version 不受支持',
  SYNC_BUSY: '当前正在同步，请稍后重试',
  SYNC_PASSWORD_REQUIRED: '请先填写 WebDAV 密码',
  SYNC_CONFIRMATION_REQUIRED: '需要用户确认后才能上传',
});

const STATUS_TO_CODE = new Map([
  [401, 'WEBDAV_AUTH_FAILED'],
  [403, 'WEBDAV_FORBIDDEN'],
  [404, 'WEBDAV_NOT_FOUND'],
  [405, 'WEBDAV_METHOD_NOT_ALLOWED'],
  [409, 'WEBDAV_CONFLICT'],
  [412, 'WEBDAV_CONFLICT'],
  [423, 'WEBDAV_CONFLICT'],
  [507, 'WEBDAV_QUOTA_EXCEEDED'],
]);

/** Build an ApiError so the client keeps the documented WebDAV error code. */
export function syncError(code, message = null, detail = null) {
  return new ApiError(message || SYNC_ERROR_MESSAGES[code] || 'WebDAV 操作失败', {
    status: 400,
    code,
    detail,
  });
}

function statusError(status) {
  const code = STATUS_TO_CODE.get(status) || 'WEBDAV_NETWORK_ERROR';
  return syncError(code, SYNC_ERROR_MESSAGES[code], { remote_status: status });
}

// ---------------------------------------------------------------------------
// input validation (mirrors the backend rules)
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 2048 || /\s/.test(value)) throw syncError('WEBDAV_URL_INVALID');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw syncError('WEBDAV_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw syncError('WEBDAV_URL_INVALID');
  if (parsed.username || parsed.password) throw syncError('WEBDAV_URL_INVALID', '服务器地址不能包含用户名或密码');
  if (parsed.search || parsed.hash) throw syncError('WEBDAV_URL_INVALID', '服务器地址不能包含查询参数或锚点');
  const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
  return `${parsed.protocol}//${parsed.host}${path}`;
}

export function validateRemoteDirectory(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 300) throw syncError('WEBDAV_URL_INVALID', '远程目录不合法');
  if (value.includes('\\')) throw syncError('WEBDAV_URL_INVALID', '远程目录不允许反斜杠');
  const segments = value.split('/').filter((segment) => segment !== '');
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw syncError('WEBDAV_URL_INVALID', '远程目录不允许 . 或 ..');
  }
  return segments.join('/');
}

export function validateRemoteFilename(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 200) throw syncError('WEBDAV_URL_INVALID', '远程文件名不合法');
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw syncError('WEBDAV_URL_INVALID', '远程文件名不能包含路径分隔符');
  }
  return value;
}

function quoteSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildTarget(config, password) {
  const baseUrl = normalizeBaseUrl(config.base_url);
  const username = String(config.username ?? '').trim();
  if (!username || username.length > 200) throw syncError('WEBDAV_URL_INVALID', '用户名不能为空');
  const allowInsecureHttp = config.allow_insecure_http === true;
  if (baseUrl.startsWith('http://') && !allowInsecureHttp) throw syncError('WEBDAV_INSECURE_HTTP');
  const remoteDirectory = validateRemoteDirectory(config.remote_directory || DEFAULT_REMOTE_DIRECTORY);
  const remoteFilename = validateRemoteFilename(config.remote_filename || DEFAULT_REMOTE_FILENAME);
  const directoryUrl = `${baseUrl}/${remoteDirectory.split('/').map(quoteSegment).join('/')}`;
  const fileUrl = `${directoryUrl}/${quoteSegment(remoteFilename)}`;
  return {
    baseUrl,
    username,
    password: password || '',
    remoteDirectory,
    remoteFilename,
    allowInsecureHttp,
    directoryUrl,
    fileUrl,
    probeUrl: `${directoryUrl}/${quoteSegment(PROBE_FILENAME)}`,
    displayPath: new URL(fileUrl).pathname,
  };
}

export function summarizePackage(packageValue) {
  const entities = packageValue?.entities && typeof packageValue.entities === 'object' ? packageValue.entities : {};
  const counts = {};
  for (const [name, items] of Object.entries(entities)) {
    if (Array.isArray(items)) counts[name] = items.length;
  }
  return {
    schema_version: packageValue?.schema_version ?? null,
    exported_at: packageValue?.exported_at ?? null,
    entity_counts: counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

// ---------------------------------------------------------------------------
// native transport
// ---------------------------------------------------------------------------

function headerValue(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value != null && value !== '') return String(value);
  }
  return null;
}

function basicAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${globalThis.btoa(binary)}`;
}

async function defaultTransport({ url, method, headers, body }) {
  return nativeRequest({ url, method, headers, body, responseType: 'text' });
}

let transport = defaultTransport;

/** Test hook: swap the native transport for a fake WebDAV server. */
export function __setWebdavTransportForTests(replacement) {
  if (typeof process === 'undefined' || process?.env?.NODE_ENV !== 'test') {
    throw new Error('The WebDAV transport test hook is only available with NODE_ENV=test');
  }
  transport = replacement || defaultTransport;
}

function mapTransportError(error) {
  if (error instanceof NativeRequestError) {
    if (error.code === 'TLS_ERROR' || error.category === 'tls') return syncError('WEBDAV_TLS_ERROR');
    if (error.code === 'REQUEST_CANCELLED' || error.category === 'cancelled') {
      return syncError('WEBDAV_NETWORK_ERROR', '请求已取消');
    }
    if (error.category === 'http') return syncError('WEBDAV_NETWORK_ERROR');
    return syncError('WEBDAV_NETWORK_ERROR');
  }
  if (error?.code && SYNC_ERROR_MESSAGES[error.code]) return error;
  return syncError('WEBDAV_NETWORK_ERROR');
}

async function request(target, method, url, { headers = {}, body = null } = {}) {
  if (url.startsWith('http://') && !target.allowInsecureHttp) throw syncError('WEBDAV_INSECURE_HTTP');
  const requestHeaders = { Authorization: basicAuth(target.username, target.password), Accept: '*/*', ...headers };
  try {
    return await transport({ url, method, headers: requestHeaders, body });
  } catch (error) {
    throw mapTransportError(error);
  }
}

function propfindEntry(xml) {
  // A minimal, namespace-tolerant reader: WebDAV servers vary in prefixes.
  const block = String(xml ?? '');
  const statuses = [...block.matchAll(/<[^>]*status[^>]*>([^<]*)</gi)].map((match) => match[1]);
  const notFound = statuses.length > 0 && statuses.every((status) => status.includes('404'));
  if (notFound) return { exists: false };
  const pick = (tag) => {
    const match = block.match(new RegExp(`<[^>]*:?${tag}[^>]*>([^<]*)<`, 'i'));
    return match ? match[1].trim() : null;
  };
  const length = pick('getcontentlength');
  return {
    exists: true,
    etag: pick('getetag'),
    last_modified: pick('getlastmodified'),
    content_length: length === null || length === '' ? null : Number(length),
    is_collection: /<[^>]*collection/i.test(block),
  };
}

function fileInfo(target, response, protocol = 'propfind', exists = true) {
  const length = headerValue(response?.headers, 'Content-Length');
  return {
    exists,
    path: target.displayPath,
    etag: headerValue(response?.headers, 'ETag'),
    last_modified: headerValue(response?.headers, 'Last-Modified'),
    content_length: length === null || length === '' ? null : Number(length),
    protocol,
  };
}

export function createWebdavProtocol({ requestImpl = request } = {}) {
  const propfind = (target, url, depth = 0) => requestImpl(target, 'PROPFIND', url, {
    headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  });

  const mkcol = (target, url) => requestImpl(target, 'MKCOL', url, { body: '' });

  async function ensureDirectory(target) {
    const response = await propfind(target, target.directoryUrl, 0);
    if (response.status === 207 || response.status === 200) return false;
    if (response.status !== 404) throw statusError(response.status);
    // Create only the segments the user added on top of the base URL.
    const baseSegments = new URL(target.baseUrl).pathname.split('/').filter(Boolean);
    const allSegments = target.remoteDirectory.split('/').filter(Boolean);
    const prefixMatches = baseSegments.every((segment, index) => allSegments[index] === segment);
    const extra = prefixMatches && baseSegments.length <= allSegments.length
      ? allSegments.slice(baseSegments.length)
      : allSegments;
    let current = target.baseUrl;
    let created = false;
    for (const segment of extra) {
      current = `${current}/${quoteSegment(segment)}`;
      const result = await mkcol(target, current);
      if ([200, 201, 204, 405].includes(result.status)) {
        if (result.status !== 405) created = true;
        continue;
      }
      if (result.status === 409) throw syncError('WEBDAV_CONFLICT', '远端父目录不存在或目录状态冲突');
      throw statusError(result.status);
    }
    return created;
  }

  async function stat(target) {
    const response = await propfind(target, target.fileUrl, 0);
    if (response.status === 207 || response.status === 200) {
      const entry = propfindEntry(response.body);
      if (!entry.exists) return fileInfo(target, response, 'propfind', false);
      return {
        exists: true,
        path: target.displayPath,
        etag: entry.etag,
        last_modified: entry.last_modified,
        content_length: entry.content_length,
        protocol: 'propfind',
      };
    }
    if (response.status === 405 || response.status === 501) {
      const head = await requestImpl(target, 'HEAD', target.fileUrl);
      if (head.status === 200 || head.status === 204) return fileInfo(target, head, 'head');
      if ([404, 405, 501].includes(head.status)) return fileInfo(target, head, 'head', false);
      throw statusError(head.status);
    }
    if (response.status === 404) {
      return { exists: false, path: target.displayPath, etag: null, last_modified: null, content_length: null, protocol: 'propfind' };
    }
    throw statusError(response.status);
  }

  async function testConnection(target) {
    const checks = { reachable: false, authenticated: false, directory_exists: false, directory_writable: false };
    const notes = [];
    let response;
    try {
      response = await propfind(target, target.directoryUrl, 0);
    } catch (error) {
      return { ok: false, code: error.code, message: error.message, checks, unknown: [], notes, protocol: null, directory_created: false };
    }
    checks.reachable = true;
    if (response.status === 401 || response.status === 403) {
      const error = statusError(response.status);
      return { ok: false, code: error.code, message: error.message, checks, unknown: [], notes, protocol: 'propfind', directory_created: false };
    }
    if (response.status === 405 || response.status === 501) {
      checks.authenticated = true;
      notes.push('当前服务器不支持 PROPFIND，已降级为文件探测，目录状态未能确认。');
      const head = await requestImpl(target, 'HEAD', target.fileUrl);
      if (head.status === 401 || head.status === 403) {
        const error = statusError(head.status);
        checks.authenticated = false;
        return { ok: false, code: error.code, message: error.message, checks, unknown: [], notes, protocol: 'head', directory_created: false };
      }
      checks.directory_exists = head.status === 200 || head.status === 204;
      return {
        ok: true,
        code: null,
        message: '服务器可达且认证成功；该服务器不支持 PROPFIND，未能确认目录状态。',
        checks,
        unknown: checks.directory_exists ? ['directory_writable'] : ['directory_exists', 'directory_writable'],
        notes,
        protocol: 'head',
        directory_created: false,
      };
    }
    let directoryCreated = false;
    if (response.status === 404) {
      try {
        directoryCreated = await ensureDirectory(target);
      } catch (error) {
        notes.push('远程目录不存在，且自动创建失败；请手动创建该目录。');
        return { ok: false, code: error.code, message: error.message, checks, unknown: [], notes, protocol: 'propfind', directory_created: false };
      }
    } else if (response.status !== 207 && response.status !== 200) {
      const error = statusError(response.status);
      return { ok: false, code: error.code, message: error.message, checks, unknown: [], notes, protocol: 'propfind', directory_created: false };
    }
    checks.authenticated = true;
    checks.directory_exists = true;
    if (directoryCreated) notes.push('远程目录原本不存在，已自动创建。');
    const probe = await requestImpl(target, 'PUT', target.probeUrl, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{"probe":true}',
    });
    if ([200, 201, 204].includes(probe.status)) {
      checks.directory_writable = true;
      await requestImpl(target, 'DELETE', target.probeUrl);
      return {
        ok: true,
        code: null,
        message: directoryCreated ? '连接成功，目录已创建且可写。' : '连接成功，目录可写。',
        checks,
        unknown: [],
        notes,
        protocol: 'propfind',
        directory_created: directoryCreated,
      };
    }
    const error = statusError(probe.status);
    if (probe.status === 403) notes.push('目标目录没有写入权限。');
    return { ok: false, code: error.code, message: error.message, checks, unknown: [], notes, protocol: 'propfind', directory_created: directoryCreated };
  }

  async function download(target) {
    const response = await requestImpl(target, 'GET', target.fileUrl);
    if (![200, 203, 206].includes(response.status)) throw statusError(response.status);
    const info = fileInfo(target, response, 'get');
    const payload = response.body ?? '';
    return { body: payload, info: { ...info, content_length: info.content_length || payload.length } };
  }

  async function upload(target, payload, { expectedEtag = null, createOnly = false } = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (expectedEtag) headers['If-Match'] = expectedEtag;
    if (createOnly) headers['If-None-Match'] = '*';
    const response = await requestImpl(target, 'PUT', target.fileUrl, { headers, body: payload });
    if (![200, 201, 204].includes(response.status)) throw statusError(response.status);
    const info = fileInfo(target, response, 'put');
    // A PUT response usually reports Content-Length: 0 for its empty body.
    const sized = { ...info, content_length: info.content_length || payload.length };
    if (!sized.etag) {
      const current = await stat(target);
      return { ...sized, etag: current.etag, last_modified: current.last_modified };
    }
    return sized;
  }

  return { propfind, mkcol, ensureDirectory, stat, testConnection, download, upload };
}

// ---------------------------------------------------------------------------
// route handlers, parameterised by the local data layer
// ---------------------------------------------------------------------------

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

/**
 * Build the `/sync/webdav/*` handlers for one local data layer.
 *
 * @param {object} options
 * @param {object} options.store `{ getRow, insertRow, updateRow }` for the single webdav config row.
 * @param {Function} options.exportPackage `async () => package` using that layer's export.
 * @param {Function} options.assertPackage `(raw) => void` validating a package or throwing.
 * @param {string[]} options.supportedSchemaVersions schema versions that layer accepts.
 */
export function createSyncRoutes({
  store,
  exportPackage,
  assertPackage,
  supportedSchemaVersions,
  generateUuid = defaultUuid,
  now = () => new Date().toISOString(),
  protocol = createWebdavProtocol(),
}) {
  /** Process-memory secret, mirroring the backend's session-only password. */
  let sessionPassword = null;
  let busy = false;

  async function getOrCreateConfigRow() {
    const current = await store.getRow();
    if (current) return current;
    await store.insertRow({
      id: 1,
      uuid: generateUuid(),
      base_url: '',
      username: '',
      password: '',
      remote_directory: DEFAULT_REMOTE_DIRECTORY,
      remote_filename: DEFAULT_REMOTE_FILENAME,
      remember_password: false,
      allow_insecure_http: false,
      last_status: 'idle',
      last_error: '',
      last_error_code: '',
      created_at: now(),
      updated_at: now(),
    });
    return store.getRow();
  }

  function configPayload(row) {
    const hasPassword = Boolean(sessionPassword || (row.remember_password && row.password));
    return {
      base_url: row.base_url || '',
      username: row.username || '',
      remote_directory: row.remote_directory || DEFAULT_REMOTE_DIRECTORY,
      remote_filename: row.remote_filename || DEFAULT_REMOTE_FILENAME,
      remember_password: Boolean(row.remember_password),
      allow_insecure_http: Boolean(row.allow_insecure_http),
      has_password: hasPassword,
      last_sync_at: row.last_sync_at || null,
      last_success_at: row.last_success_at || null,
      last_download_at: row.last_download_at || null,
      last_error: row.last_error || '',
      last_error_code: row.last_error_code || '',
    };
  }

  function storedPassword(row) {
    return sessionPassword || (row.remember_password ? row.password || '' : '');
  }

  function describeRemoteDocument(raw) {
    const summary = summarizePackage(raw);
    if (!raw || typeof raw !== 'object' || raw.app !== 'riji') {
      return { summary, error: SYNC_ERROR_MESSAGES.WEBDAV_INVALID_PACKAGE, error_code: 'WEBDAV_INVALID_PACKAGE' };
    }
    if (!supportedSchemaVersions.includes(raw.schema_version)) {
      return { summary, error: SYNC_ERROR_MESSAGES.WEBDAV_UNSUPPORTED_SCHEMA, error_code: 'WEBDAV_UNSUPPORTED_SCHEMA' };
    }
    try {
      assertPackage(raw);
      return { summary, error: null, error_code: null };
    } catch (error) {
      return { summary, error: error?.message || SYNC_ERROR_MESSAGES.WEBDAV_INVALID_PACKAGE, error_code: 'WEBDAV_INVALID_PACKAGE' };
    }
  }

  async function stampResult({ success, download = false, info = null, error = null }) {
    const row = await getOrCreateConfigRow();
    const stamp = now();
    const data = { last_sync_at: stamp, updated_at: stamp };
    if (success) {
      data.last_success_at = stamp;
      data.last_status = 'success';
      data.last_error = '';
      data.last_error_code = '';
      if (download) data.last_download_at = stamp;
      if (info?.etag) data.last_remote_etag = info.etag;
      if (info?.last_modified) data.last_remote_modified_at = info.last_modified;
    } else if (error) {
      data.last_status = 'failed';
      data.last_error = String(error.message || '').slice(0, 300);
      data.last_error_code = error.code || '';
    }
    await store.updateRow(row.id, data);
    return row;
  }

  async function withBusy(operation) {
    if (busy) throw syncError('SYNC_BUSY');
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }

  function requireTarget(config) {
    const password = storedPassword(config);
    if (!password) throw syncError('SYNC_PASSWORD_REQUIRED');
    return buildTarget(config, password);
  }

  async function syncRequest(method, pathname, body) {
    if (method === 'GET' && pathname === '/sync/webdav/config') {
      return configPayload(await getOrCreateConfigRow());
    }

    if (method === 'PUT' && pathname === '/sync/webdav/config') {
      const row = await getOrCreateConfigRow();
      const allowInsecureHttp = body.allow_insecure_http === undefined || body.allow_insecure_http === null
        ? Boolean(row.allow_insecure_http)
        : Boolean(body.allow_insecure_http);
      const next = {
        base_url: body.base_url === undefined || body.base_url === null ? row.base_url : String(body.base_url).trim(),
        username: body.username === undefined || body.username === null ? row.username : String(body.username).trim(),
        remote_directory: body.remote_directory ? String(body.remote_directory).trim() : row.remote_directory,
        remote_filename: body.remote_filename ? String(body.remote_filename).trim() : row.remote_filename,
        remember_password: Boolean(body.remember_password),
        allow_insecure_http: allowInsecureHttp,
        password: '',
      };
      const password = String(body.password || '') || (next.remember_password ? storedPassword(row) : '');
      buildTarget(next, password); // validate before persisting
      if (password) {
        sessionPassword = password;
        next.password = next.remember_password ? password : '';
      } else if (!next.remember_password) {
        sessionPassword = null;
        next.password = '';
      } else if (!sessionPassword) {
        throw syncError('SYNC_PASSWORD_REQUIRED');
      }
      await store.updateRow(row.id, {
        ...next,
        remember_password: next.remember_password,
        allow_insecure_http: next.allow_insecure_http,
        updated_at: now(),
      });
      return configPayload(await getOrCreateConfigRow());
    }

    if (method === 'POST' && pathname === '/sync/webdav/test') {
      const row = await getOrCreateConfigRow();
      const password = body.password || storedPassword(row);
      if (!password) throw syncError('SYNC_PASSWORD_REQUIRED');
      // Enter the busy guard first so a duplicate tap can never start a second task.
      return withBusy(async () => {
        const draft = {
          base_url: body.base_url || row.base_url,
          username: body.username || row.username,
          remote_directory: body.remote_directory || row.remote_directory,
          remote_filename: body.remote_filename || row.remote_filename,
          allow_insecure_http: body.allow_insecure_http === undefined || body.allow_insecure_http === null
            ? Boolean(row.allow_insecure_http)
            : Boolean(body.allow_insecure_http),
        };
        let target;
        try {
          target = buildTarget(draft, password);
        } catch (error) {
          return {
            ok: false,
            code: error.code,
            message: error.message,
            checks: { reachable: false, authenticated: false, directory_exists: false, directory_writable: false },
            unknown: [],
            notes: [],
            protocol: null,
            directory_created: false,
          };
        }
        return protocol.testConnection(target);
      });
    }

    if (method === 'POST' && pathname === '/sync/webdav/upload/preflight') {
      return withBusy(async () => {
        const row = await getOrCreateConfigRow();
        const localPackage = await exportPackage();
        const target = requireTarget(row);
        let info;
        try {
          info = await protocol.stat(target);
        } catch (error) {
          await stampResult({ success: false, error });
          throw error;
        }
        const remote = {
          ...info,
          exported_at: null,
          schema_version: null,
          entity_counts: {},
          package_error: null,
        };
        if (info.exists) {
          try {
            const downloaded = await protocol.download(target);
            Object.assign(remote, downloaded.info);
            let raw = null;
            try {
              raw = JSON.parse(downloaded.body);
            } catch {
              remote.package_error = SYNC_ERROR_MESSAGES.WEBDAV_INVALID_PACKAGE;
            }
            if (raw) {
              const described = describeRemoteDocument(raw);
              remote.exported_at = described.summary.exported_at;
              remote.schema_version = described.summary.schema_version;
              remote.entity_counts = described.summary.entity_counts;
              remote.package_error = described.error;
            }
          } catch (error) {
            await stampResult({ success: false, error });
            throw error;
          }
        }
        return { local: summarizePackage(localPackage), remote };
      });
    }

    if (method === 'POST' && pathname === '/sync/webdav/upload') {
      if (!body.confirmed) throw syncError('SYNC_CONFIRMATION_REQUIRED');
      return withBusy(async () => {
        const row = await getOrCreateConfigRow();
        const localPackage = await exportPackage();
        const payload = JSON.stringify(localPackage);
        const target = requireTarget(row);
        const expectedEtag = body.expected_remote_etag ?? null;
        const expectedExists = body.expected_remote_exists ?? null;
        try {
          if (payload.length > MAX_PACKAGE_BYTES) throw syncError('WEBDAV_INVALID_PACKAGE', '本机数据包过大，已拒绝上传');
          const directoryCreated = await protocol.ensureDirectory(target);
          const current = await protocol.stat(target);
          if (expectedExists === null) throw syncError('WEBDAV_CONFLICT');
          if (current.exists) {
            if (expectedExists === false || expectedEtag === null || !current.etag || current.etag !== expectedEtag) {
              throw syncError('WEBDAV_CONFLICT');
            }
          } else if (expectedExists === true || expectedEtag !== null) {
            throw syncError('WEBDAV_CONFLICT');
          }
          const info = await protocol.upload(target, payload, {
            expectedEtag: current.exists ? expectedEtag : null,
            createOnly: !current.exists,
          });
          const stamped = await stampResult({ success: true, info });
          return {
            ok: true,
            path: info.path,
            etag: info.etag,
            last_modified: info.last_modified,
            content_length: info.content_length ?? payload.length,
            uploaded_at: stamped.last_success_at,
            exported_at: localPackage.exported_at,
            schema_version: localPackage.schema_version,
            directory_created: directoryCreated,
          };
        } catch (error) {
          await stampResult({ success: false, error });
          throw error;
        }
      });
    }

    if (method === 'POST' && pathname === '/sync/webdav/download') {
      return withBusy(async () => {
        const row = await getOrCreateConfigRow();
        const target = requireTarget(row);
        try {
          const downloaded = await protocol.download(target);
          if (downloaded.body.length > MAX_PACKAGE_BYTES) {
            throw syncError('WEBDAV_INVALID_PACKAGE', '远端文件过大，已拒绝下载');
          }
          let raw;
          try {
            raw = JSON.parse(downloaded.body);
          } catch {
            throw syncError('WEBDAV_INVALID_PACKAGE');
          }
          const described = describeRemoteDocument(raw);
          if (described.error_code) throw syncError(described.error_code, described.error);
          assertPackage(raw);
          const validated = raw;
          const stamped = await stampResult({ success: true, download: true, info: downloaded.info });
          return {
            remote: {
              path: downloaded.info.path,
              etag: downloaded.info.etag,
              last_modified: downloaded.info.last_modified,
              content_length: downloaded.info.content_length ?? downloaded.body.length,
            },
            package: validated,
            summary: summarizePackage(validated),
            downloaded_at: stamped.last_download_at,
          };
        } catch (error) {
          await stampResult({ success: false, error });
          throw error;
        }
      });
    }

    if (method === 'GET' && pathname === '/sync/webdav/status') {
      const row = await getOrCreateConfigRow();
      const password = storedPassword(row);
      let remotePath = '';
      try {
        remotePath = buildTarget(row, password || 'session').displayPath;
      } catch {
        remotePath = '';
      }
      return {
        configured: Boolean(row.base_url && row.username && password),
        has_password: Boolean(password),
        busy,
        remote_path: remotePath,
        last_sync_at: row.last_sync_at || null,
        last_success_at: row.last_success_at || null,
        last_download_at: row.last_download_at || null,
        last_error: row.last_error || '',
        last_error_code: row.last_error_code || '',
        last_remote_etag: row.last_remote_etag || null,
        last_remote_modified_at: row.last_remote_modified_at || null,
        allow_insecure_http: Boolean(row.allow_insecure_http),
        remember_password: Boolean(row.remember_password),
      };
    }

    return undefined;
  }

  function resetState() {
    sessionPassword = null;
    busy = false;
  }

  return { syncRequest, resetState, getConfigRow: getOrCreateConfigRow };
}
