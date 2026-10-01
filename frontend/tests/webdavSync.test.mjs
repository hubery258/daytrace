/**
 * v0.11.0 WebDAV settings logic: form validation, upload confirmation,
 * download summary, error text, the unified SyncAdapter and the platform
 * password stores. These are the pure layers behind the settings panel, so the
 * behaviours the UI promises can be asserted without a DOM.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { createSyncAdapter } = await import('../src/sync/syncAdapter.js');
const {
  createMemoryKeyStorage,
  createPasswordStore,
  createWebSecretStore,
  WEBDAV_SECRET_KEY,
} = await import('../src/sync/passwordStore.js');
const {
  WEBDAV_DOWNLOAD_NOTICE,
  WEBDAV_UPLOAD_WARNING,
  applyConfigToForm,
  buildDownloadSummaryView,
  buildUploadConfirmView,
  describeSyncError,
  emptyWebdavForm,
  entityCountRows,
  formatBytes,
  syncStatusView,
  validateBaseUrl,
  validateRemoteDirectory,
  validateRemoteFilename,
  validateWebdavForm,
} = await import('../src/sync/webdavPresentation.js');
const {
  __resetDownloadBridgeForTests,
  publishDownloadedPackage,
  subscribeDownloadedPackage,
  takeDownloadedPackage,
} = await import('../src/sync/downloadBridge.js');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const LOCAL_EXPORT = {
  schema_version: '0.10.0',
  exported_at: '2026-09-16T10:00:00+00:00',
  entity_counts: { projects: 2, todos: 5, time_blocks: 12 },
  total: 19,
};
const REMOTE_FILE = {
  exists: true,
  path: '/remote.php/dav/files/alice/daytrace/daytrace-latest.json',
  etag: '"abc123"',
  last_modified: 'Mon, 15 Sep 2026 09:00:00 GMT',
  content_length: 123456,
  exported_at: '2026-09-15T08:50:00+00:00',
};

test('base url validation accepts https and flags plain http for confirmation', () => {
  assert.equal(validateBaseUrl('').valid, false);
  assert.equal(validateBaseUrl('dav.example.com').valid, false);
  assert.equal(validateBaseUrl('ftp://dav.example.com').valid, false);
  assert.equal(validateBaseUrl('https://user:pass@dav.example.com').valid, false);
  assert.equal(validateBaseUrl('https://dav.example.com/dav/').normalized, 'https://dav.example.com/dav');

  const http = validateBaseUrl('http://dav.example.com/dav');
  assert.equal(http.valid, true);
  assert.equal(http.isHttps, false);
  assert.match(http.warning, /HTTPS/);
  assert.equal(validateBaseUrl('https://dav.example.com').isHttps, true);
});

test('remote path validation blocks traversal and separators', () => {
  assert.equal(validateRemoteDirectory('daytrace').valid, true);
  assert.equal(validateRemoteDirectory('a/b').normalized, 'a/b');
  assert.equal(validateRemoteDirectory('../etc').valid, false);
  assert.equal(validateRemoteDirectory('').valid, false);
  assert.equal(validateRemoteDirectory('back\\slash').valid, false);
  assert.equal(validateRemoteFilename('daytrace-latest.json').valid, true);
  assert.equal(validateRemoteFilename('nested/file.json').valid, false);
  assert.equal(validateRemoteFilename('..').valid, false);
  assert.equal(validateRemoteFilename('').valid, false);
});

test('settings form requires the documented fields', () => {
  const empty = validateWebdavForm(emptyWebdavForm());
  assert.equal(empty.valid, false);
  assert.deepEqual(empty.invalidFields, ['base_url', 'username', 'password']);

  const filled = validateWebdavForm(emptyWebdavForm({
    base_url: 'https://dav.example.com/dav',
    username: 'alice',
    password: 'app-password',
    remote_directory: 'daytrace',
    remote_filename: 'daytrace-latest.json',
  }));
  assert.equal(filled.valid, true);
  assert.equal(filled.needsHttpConfirmation, false);
  assert.equal(filled.normalized.remote_filename, 'daytrace-latest.json');

  const savedPassword = validateWebdavForm(emptyWebdavForm({
    base_url: 'http://dav.example.com/dav', username: 'alice', has_password: true,
  }));
  assert.equal(savedPassword.errors.password, undefined);
  assert.equal(savedPassword.needsHttpConfirmation, true);
});

test('upload confirmation shows local and remote facts before overwriting', () => {
  const view = buildUploadConfirmView({ local: LOCAL_EXPORT, remote: REMOTE_FILE });
  const labels = view.rows.map((row) => row.label);
  for (const required of [
    '本机数据版本', '本机导出时间', '远端文件路径', '远端文件是否存在',
    '远端导出时间', '远端最后修改时间', '远端文件大小', '远端 ETag',
  ]) {
    assert.ok(labels.includes(required), `missing ${required}`);
  }
  assert.equal(view.rows.find((row) => row.key === 'etag').value, '"abc123"');
  assert.equal(view.rows.find((row) => row.key === 'content_length').value, '120.6 KB');
  assert.ok(view.rows.some((row) => row.value === '5 条'));
  assert.equal(view.warnings[0], WEBDAV_UPLOAD_WARNING);
  assert.equal(view.expectedRemoteEtag, '"abc123"');
  assert.equal(view.expectedRemoteExists, true);
  assert.equal(view.remoteNewer, false);
});

test('upload confirmation warns when the remote export is newer', () => {
  const view = buildUploadConfirmView({
    local: LOCAL_EXPORT,
    remote: { ...REMOTE_FILE, exported_at: '2026-09-16T12:00:00+00:00' },
  });
  assert.equal(view.remoteNewer, true);
  assert.equal(view.warnings.length, 2);
  assert.match(view.warnings[1], /先下载/);
});

test('upload confirmation handles a first-time upload without remote ETag', () => {
  const view = buildUploadConfirmView({
    local: LOCAL_EXPORT,
    remote: { exists: false, path: '/dav/daytrace/daytrace-latest.json', etag: null, last_modified: null, content_length: null },
  });
  assert.equal(view.expectedRemoteEtag, null);
  assert.equal(view.expectedRemoteExists, false);
  assert.equal(view.rows.find((row) => row.key === 'exists').value, '不存在');
  assert.equal(view.rows.find((row) => row.key === 'etag').value, '未提供');
});

test('download summary shows remote metadata and entity counts', () => {
  const view = buildDownloadSummaryView({
    remote: {
      path: REMOTE_FILE.path, etag: REMOTE_FILE.etag,
      last_modified: REMOTE_FILE.last_modified, content_length: REMOTE_FILE.content_length,
    },
    package: { app: 'riji', schema_version: '0.10.0', exported_at: '2026-09-15T08:50:00+00:00' },
    summary: { entity_counts: { projects: 2, todos: 5, time_blocks: 12 }, total: 19 },
  });
  const values = Object.fromEntries(view.rows.map((row) => [row.key, row.value]));
  assert.equal(values.etag, '"abc123"');
  assert.equal(values.schema_version, '0.10.0');
  assert.equal(values.total, '19 条');
  assert.equal(view.notice, WEBDAV_DOWNLOAD_NOTICE);
  assert.deepEqual(view.entityRows.map((item) => `${item.label}:${item.count}`), ['项目:2', '待办:5', '实际时间块:12']);
  assert.match(view.notice, /不会直接覆盖本机数据/);
});

test('entity rows skip empty collections and unknown names stay readable', () => {
  assert.deepEqual(entityCountRows({ todos: 0, projects: 0 }), []);
  const rows = entityCountRows({ unknown_entity: 3 });
  assert.deepEqual(rows, [{ key: 'unknown_entity', label: 'unknown_entity', count: 3 }]);
});

test('error descriptions cover every documented WebDAV code', () => {
  const codes = [
    'WEBDAV_URL_INVALID', 'WEBDAV_NETWORK_ERROR', 'WEBDAV_TLS_ERROR', 'WEBDAV_AUTH_FAILED',
    'WEBDAV_NOT_FOUND', 'WEBDAV_METHOD_NOT_ALLOWED', 'WEBDAV_FORBIDDEN', 'WEBDAV_QUOTA_EXCEEDED',
    'WEBDAV_CONFLICT', 'WEBDAV_INVALID_PACKAGE', 'WEBDAV_UNSUPPORTED_SCHEMA', 'SYNC_BUSY',
    'SYNC_PASSWORD_REQUIRED', 'SYNC_CONFIRMATION_REQUIRED',
  ];
  for (const code of codes) {
    const described = describeSyncError({ code, message: 'internal detail' });
    assert.equal(described.code, code);
    assert.ok(described.message.endsWith('。'), `${code} needs a readable sentence`);
    assert.doesNotMatch(described.message, /internal detail/);
  }
  assert.match(describeSyncError({ code: 'WEBDAV_CONFLICT' }).hint, /重新点击上传/);
  assert.equal(describeSyncError(null).message, '');
});

test('status view reports configured, failed and busy states', () => {
  const unconfigured = syncStatusView({ configured: false, has_password: false, busy: false }, null);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.rows[0].value, '尚未配置');

  const failed = syncStatusView({
    configured: true,
    has_password: true,
    busy: false,
    last_sync_at: '2026-09-16T10:00:00',
    last_error: '用户名或应用密码错误',
    last_remote_etag: '"abc"',
    last_remote_modified_at: '2026-09-15T09:00:00',
    remote_path: '/dav/daytrace/daytrace-latest.json',
  }, { remote_filename: 'daytrace-latest.json' });
  const labels = failed.rows.map((row) => row.label);
  assert.ok(labels.includes('上次失败'));
  assert.ok(labels.includes('当前远端 ETag'));
  assert.equal(failed.busy, false);
  assert.equal(failed.rows.find((row) => row.key === 'remote_etag').value, '"abc"');

  const busy = syncStatusView({ configured: true, has_password: true, busy: true }, null);
  assert.equal(busy.busy, true);
  assert.equal(busy.rows.some((row) => row.key === 'password'), false);
  assert.equal(syncStatusView({ configured: true, has_password: false, busy: false }, null)
    .rows.find((row) => row.key === 'password').value, '未保存，需要重新输入密码');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '未知');
});

test('config values fill the form without ever prefilling a password', () => {
  const form = applyConfigToForm({
    base_url: 'https://dav.example.com/dav',
    username: 'alice',
    remote_directory: 'daytrace',
    remote_filename: 'daytrace-latest.json',
    remember_password: true,
    has_password: true,
  });
  assert.equal(form.base_url, 'https://dav.example.com/dav');
  assert.equal(form.remember_password, true);
  assert.equal(form.password, '');
  assert.equal(form.has_password, true);
});

test('sync adapter drives the API contract and remembers the password explicitly', async () => {
  const calls = [];
  const api = {
    getConfig: async () => ({ base_url: 'https://dav.example.com/dav', username: 'alice', has_password: false, remember_password: true, remote_directory: 'daytrace', remote_filename: 'daytrace-latest.json' }),
    saveConfig: async (data) => { calls.push(['saveConfig', data]); return { ...data, has_password: Boolean(data.password), remember_password: data.remember_password }; },
    testConnection: async (data) => { calls.push(['testConnection', data]); return { ok: true, checks: { reachable: true, authenticated: true, directory_exists: true, directory_writable: true }, message: '连接成功' }; },
    preflightUpload: async () => ({ local: LOCAL_EXPORT, remote: REMOTE_FILE }),
    upload: async (data) => { calls.push(['upload', data]); return { ok: true, path: REMOTE_FILE.path, etag: '"new"', content_length: 10, uploaded_at: '2026-09-16T10:05:00' }; },
    download: async () => ({ remote: REMOTE_FILE, package: { app: 'riji', schema_version: '0.10.0' }, summary: { entity_counts: {} } }),
    status: async () => ({ configured: true, busy: false }),
  };
  const adapter = createSyncAdapter({ api });

  const config = await adapter.getConfig();
  assert.equal(config.username, 'alice');

  const saved = await adapter.saveConfig({
    ...emptyWebdavForm({ base_url: 'https://dav.example.com/dav', username: 'alice', password: 'app-password', remember_password: true }),
  });
  assert.equal(saved.has_password, true);
  assert.equal(calls[0][1].password, 'app-password');
  assert.deepEqual(calls[0][1].allow_insecure_http, false);

  const tested = await adapter.testConnection({ ...emptyWebdavForm({ base_url: 'https://dav.example.com/dav', username: 'alice', password: 'app-password' }) });
  assert.equal(tested.ok, true);

  const preflight = await adapter.preflightUpload();
  assert.equal(preflight.remote.exists, true);

  const uploaded = await adapter.uploadLatest({ confirmed: true, expectedRemoteEtag: '"abc123"', expectedRemoteExists: true });
  assert.equal(uploaded.ok, true);
  const uploadCall = calls.find(([name]) => name === 'upload')[1];
  assert.equal(uploadCall.confirmed, true);
  assert.equal(uploadCall.expected_remote_etag, '"abc123"');
  assert.equal(uploadCall.expected_remote_exists, true);

  await assert.rejects(
    adapter.uploadLatest({ confirmed: false }),
    (error) => error.code === 'SYNC_CONFIRMATION_REQUIRED',
  );

  const downloaded = await adapter.downloadLatest();
  assert.equal(downloaded.package.app, 'riji');

  await adapter.saveConfig({ ...emptyWebdavForm({ base_url: 'https://dav.example.com/dav', username: 'alice', remember_password: false }) });
  assert.equal(calls.at(-1)[1].remember_password, false);
});

test('session-only WebDAV config is saved without a persistent password', async () => {
  const calls = [];
  const adapter = createSyncAdapter({
    api: {
      getConfig: async () => ({ has_password: false }),
      saveConfig: async (data) => { calls.push(data); return { ...data, has_password: true, remember_password: data.remember_password }; },
    },
  });
  const saved = await adapter.saveConfig({
    ...emptyWebdavForm({ base_url: 'https://dav.example.com/dav', username: 'alice', password: 'session-password', remember_password: false }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].remember_password, false);
  assert.equal(calls[0].password, 'session-password');
  assert.equal(saved.password_storage_warning, undefined);
});

test('disabling remembered password clears the local password field', async () => {
  const calls = [];
  const adapter = createSyncAdapter({
    api: {
      getConfig: async () => ({ has_password: true, remember_password: true }),
      saveConfig: async (data) => { calls.push(data); return { ...data, has_password: false, remember_password: false }; },
    },
  });
  const saved = await adapter.saveConfig({
    ...emptyWebdavForm({ base_url: 'https://dav.example.com/dav', username: 'alice', password: '', remember_password: false }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].remember_password, false);
  assert.equal(calls[0].password, '');
  assert.equal(saved.password_storage_warning, undefined);
});

test('sync adapter trusts the database-backed config after a restart', async () => {
  const api = {
    getConfig: async () => ({
      base_url: 'https://dav.example.com/dav', username: 'alice', has_password: true,
      remember_password: true, remote_directory: 'daytrace', remote_filename: 'daytrace-latest.json',
    }),
  };
  const adapter = createSyncAdapter({ api });
  const result = await adapter.restoreRememberedPassword();
  assert.equal(result.restored, false);
  assert.equal(result.config.has_password, true);
});

test('sync adapter migrates a legacy platform password into the local config row', async () => {
  const saved = [];
  const api = {
    getConfig: async () => ({
      base_url: 'https://dav.example.com/dav', username: 'alice', has_password: false,
      remember_password: true, remote_directory: 'daytrace', remote_filename: 'daytrace-latest.json',
    }),
    saveConfig: async (data) => { saved.push(data); return { ...data, has_password: true }; },
  };
  let removed = false;
  const adapter = createSyncAdapter({
    api,
    passwordStore: {
      async get() { return 'legacy-password'; },
      async remove() { removed = true; },
    },
  });
  const result = await adapter.restoreRememberedPassword();
  assert.equal(result.restored, true);
  assert.equal(saved[0].password, 'legacy-password');
  assert.equal(removed, true);
});

test('web password storage encrypts the secret with a non-extractable key', async () => {
  const storage = new MemoryStorage();
  const keyStorage = createMemoryKeyStorage();
  const store = await createWebSecretStore({ storage, keyStorage });
  await store.set('app-password-never-log');
  const raw = storage.getItem(WEBDAV_SECRET_KEY);
  assert.match(raw, /"v":1/);
  assert.equal(raw.includes('app-password-never-log'), false);
  const key = await keyStorage.load();
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(await store.get(), 'app-password-never-log');
  await store.remove();
  assert.equal(await store.get(), null);
  assert.equal(storage.getItem(WEBDAV_SECRET_KEY), null);
});

test('web password storage migrates the legacy raw key and keeps the saved password readable', async () => {
  const { webcrypto } = await import('node:crypto');
  const storage = new MemoryStorage();
  const keyStorage = createMemoryKeyStorage();
  const rawKey = new Uint8Array(32).fill(7);
  const legacyKey = await webcrypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, legacyKey, new TextEncoder().encode('legacy-password'),
  );
  storage.setItem(WEBDAV_SECRET_KEY, JSON.stringify({
    v: 1,
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(ciphertext).toString('base64'),
  }));
  await keyStorage.save(rawKey);
  const store = await createWebSecretStore({ storage, keyStorage });
  assert.equal(await store.get(), 'legacy-password');
  const migratedKey = await keyStorage.load();
  assert.equal(migratedKey.extractable, false);
  assert.equal(await store.get(), 'legacy-password');
});

test('web password storage survives a corrupted blob with a null result', async () => {
  const storage = new MemoryStorage();
  const store = await createWebSecretStore({ storage, keyStorage: createMemoryKeyStorage() });
  storage.setItem(WEBDAV_SECRET_KEY, 'not-json');
  assert.equal(await store.get(), null);
  assert.equal(storage.getItem(WEBDAV_SECRET_KEY), null);
});

test('password store selects the platform backend', async () => {
  const calls = [];
  const desktopBridge = {
    isAvailable: () => true,
    async set(key, value) { calls.push(['set', key, value]); },
    async get(key) { calls.push(['get', key]); return 'desktop-secret'; },
    async remove(key) { calls.push(['remove', key]); },
  };
  const desktop = await createPasswordStore({ platform: 'win32', desktopBridge });
  assert.equal(desktop.kind, 'electron-safe-storage');
  await desktop.set(WEBDAV_SECRET_KEY, 'desktop-secret');
  assert.equal(await desktop.get(), 'desktop-secret');
  await desktop.remove();
  assert.deepEqual(calls.map(([name]) => name), ['set', 'get', 'remove']);

  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  try {
    const memory = await createPasswordStore({ platform: 'web', desktopBridge: null });
    assert.equal(memory.kind, 'session-memory');
    await memory.set('x');
    assert.equal(await memory.get(), 'x');
    await memory.remove();
    assert.equal(await memory.get(), null);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }

  const android = await createPasswordStore({ platform: 'android', forceAndroid: true });
  assert.equal(android.kind, 'android-keystore');
});

test('download bridge hands the package to the existing import flow once', () => {
  __resetDownloadBridgeForTests();
  const received = [];
  const unsubscribe = subscribeDownloadedPackage((payload) => received.push(payload));
  publishDownloadedPackage({ app: 'riji', entities: {} }, { remote: REMOTE_FILE });
  assert.equal(received.length, 1);
  assert.equal(received[0].meta.remote.etag, '"abc123"');
  assert.equal(takeDownloadedPackage().package.app, 'riji');
  assert.equal(takeDownloadedPackage(), null);
  unsubscribe();
  __resetDownloadBridgeForTests();
});

let storageBackup;
beforeEach(() => {
  storageBackup = globalThis.localStorage;
});
afterEach(() => {
  globalThis.localStorage = storageBackup;
  __resetDownloadBridgeForTests();
});
