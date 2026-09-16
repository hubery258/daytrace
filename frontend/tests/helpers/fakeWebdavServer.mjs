/**
 * In-memory WebDAV server used by the Android adapter tests.
 *
 * It implements the subset the v0.11.0 client uses: PROPFIND (Depth 0), MKCOL,
 * PUT with If-Match, GET, HEAD and DELETE, plus optional failures (auth,
 * read-only directory, quota). No network access is required.
 */

import { createHash } from 'node:crypto';

export const FAKE_USERNAME = 'alice';
export const FAKE_PASSWORD = 'app-password-never-log';
export const FAKE_ROOT = '/dav';
export const FAKE_REMOTE_PATH = `${FAKE_ROOT}/daytrace/daytrace-latest.json`;

export function etagFor(body) {
  return `"${createHash('md5').update(body).digest('hex').slice(0, 16)}"`;
}

export function encodeBasic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export class FakeWebDavServer {
  constructor({ root = FAKE_ROOT } = {}) {
    this.root = root;
    this.files = new Map();
    this.directories = new Set([root]);
    this.propfindSupported = true;
    this.writeForbidden = false;
    this.quotaExceeded = false;
    this.requests = [];
  }

  get baseUrl() {
    return `http://dav.example.test${this.root}`;
  }

  directoryExists(path) {
    if (this.directories.has(path)) return true;
    for (const directory of this.directories) {
      if (directory.startsWith(`${path.replace(/\/+$/, '')}/`)) return true;
    }
    return false;
  }

  parent(path) {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  store(path, body) {
    this.files.set(path, body);
    return etagFor(body);
  }

  propfindXml(path, isCollection) {
    const body = this.files.get(path) ?? '';
    const props = isCollection
      ? '<d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 15 Sep 2026 08:00:00 GMT</d:getlastmodified>'
      : `<d:resourcetype/><d:getcontentlength>${body.length}</d:getcontentlength>`
        + `<d:getlastmodified>Mon, 15 Sep 2026 09:00:00 GMT</d:getlastmodified><d:getetag>${etagFor(body)}</d:getetag>`;
    return '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response>'
      + `<d:href>${path}</d:href><d:propstat><d:prop>${props}</d:prop>`
      + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  }

  handle({ url, method, headers = {}, body = null }) {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    this.requests.push([method, path]);
    if (headers.Authorization !== encodeBasic(FAKE_USERNAME, FAKE_PASSWORD)) {
      return { status: 401, headers: {}, body: '' };
    }

    if (method === 'PROPFIND') {
      if (!this.propfindSupported) return { status: 405, headers: {}, body: '' };
      if (this.files.has(path)) return { status: 207, headers: { 'Content-Type': 'application/xml' }, body: this.propfindXml(path, false) };
      if (this.directoryExists(path)) return { status: 207, headers: { 'Content-Type': 'application/xml' }, body: this.propfindXml(path, true) };
      return { status: 404, headers: {}, body: '' };
    }
    if (method === 'MKCOL') {
      if (this.writeForbidden) return { status: 403, headers: {}, body: '' };
      if (this.directoryExists(path) || this.files.has(path)) return { status: 405, headers: {}, body: '' };
      if (!this.directoryExists(this.parent(path))) return { status: 409, headers: {}, body: '' };
      this.directories.add(path);
      return { status: 201, headers: {}, body: '' };
    }
    if (method === 'PUT') {
      if (this.writeForbidden) return { status: 403, headers: {}, body: '' };
      if (this.quotaExceeded) return { status: 507, headers: {}, body: '' };
      if (!this.directoryExists(this.parent(path))) return { status: 409, headers: {}, body: '' };
      const current = this.files.get(path);
      if (headers['If-Match'] !== undefined && (current === undefined || etagFor(current) !== headers['If-Match'])) {
        return { status: 412, headers: {}, body: '' };
      }
      const etag = this.store(path, body);
      return {
        status: current === undefined ? 201 : 204,
        headers: { ETag: etag, 'Last-Modified': 'Mon, 15 Sep 2026 10:00:00 GMT' },
        body: '',
      };
    }
    if (method === 'DELETE') {
      if (this.files.delete(path)) return { status: 204, headers: {}, body: '' };
      if (this.directories.delete(path)) return { status: 204, headers: {}, body: '' };
      return { status: 404, headers: {}, body: '' };
    }
    if (method === 'GET' || method === 'HEAD') {
      if (!this.files.has(path)) return { status: 404, headers: {}, body: '' };
      const content = this.files.get(path);
      return {
        status: 200,
        headers: {
          ETag: etagFor(content),
          'Last-Modified': 'Mon, 15 Sep 2026 09:00:00 GMT',
          'Content-Length': String(content.length),
        },
        body: method === 'HEAD' ? '' : content,
      };
    }
    return { status: 405, headers: {}, body: '' };
  }
}
