/**
 * Android WebDAV adapter tests for the modular mobile data layer
 * (`src/data/mobile/*`).
 *
 * The layer implements the same logical contract as the local backend without
 * Python. These tests run it against an in-memory WebDAV server injected
 * through the module's test transport hook, so conflict detection, error
 * mapping and "download never writes local data" are verified with real SQL.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __installDatabaseForTests,
  __resetDatabaseForTests,
} from '../src/data/mobile/database.js';
import { mobileRequest } from '../src/data/mobile/router.js';
import { __resetWebdavSyncStateForTests, __setWebdavTransportForTests } from '../src/data/mobile/sync.js';
import {
  FAKE_PASSWORD,
  FAKE_REMOTE_PATH,
  FAKE_ROOT,
  FAKE_USERNAME,
  FakeWebDavServer,
  etagFor,
} from './helpers/fakeWebdavServer.mjs';
import { createSqlJsConnection } from './helpers/sqlJsDatabase.mjs';

process.env.NODE_ENV = 'test';

const USERNAME = FAKE_USERNAME;
const PASSWORD = FAKE_PASSWORD;
const REMOTE_PATH = FAKE_REMOTE_PATH;
async function call(path, method = 'GET', body = undefined) {
  return mobileRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function baseConfig(overrides = {}) {
  return {
    base_url: server.baseUrl,
    username: USERNAME,
    password: PASSWORD,
    remember_password: true,
    remote_directory: 'daytrace',
    remote_filename: 'daytrace-latest.json',
    allow_insecure_http: true,
    ...overrides,
  };
}

let connection;
let server;

beforeEach(async () => {
  connection = await createSqlJsConnection();
  await __installDatabaseForTests(connection);
  server = new FakeWebDavServer();
  __setWebdavTransportForTests((request) => server.handle(request));
  __resetWebdavSyncStateForTests();
});

afterEach(async () => {
  __setWebdavTransportForTests(null);
  __resetWebdavSyncStateForTests();
  __resetDatabaseForTests();
  await connection.close();
});

test('migration 7 adds local WebDAV credential storage', async () => {
  const migrations = (await connection.query('SELECT version FROM mobile_schema_migrations ORDER BY version')).values;
  assert.deepEqual(migrations.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  const version = (await connection.query('PRAGMA user_version')).values[0].user_version;
  assert.equal(version, 7);
  const table = (await connection.query("SELECT name FROM sqlite_master WHERE type='table' AND name='webdav_config'")).values;
  assert.equal(table.length, 1);
});

test('android config endpoints hide the password while SQLite persists it locally', async () => {
  const initial = await call('/sync/webdav/config');
  assert.deepEqual(initial, {
    base_url: '', username: '', remote_directory: 'daytrace', remote_filename: 'daytrace-latest.json',
    remember_password: false, allow_insecure_http: false, has_password: false,
    last_sync_at: null, last_success_at: null, last_download_at: null, last_error: '', last_error_code: '',
  });

  const saved = await call('/sync/webdav/config', 'PUT', baseConfig());
  assert.equal(saved.has_password, true);
  assert.equal(JSON.stringify(saved).includes(PASSWORD), false);
  assert.equal(Object.hasOwn(saved, 'password'), false);

  const stored = (await connection.query('SELECT * FROM webdav_config')).values;
  assert.equal(stored.length, 1);
  assert.equal(Object.keys(stored[0]).includes('password'), true);
  assert.equal(stored[0].password, PASSWORD);

  __resetWebdavSyncStateForTests();
  const afterRestart = await call('/sync/webdav/config');
  assert.equal(afterRestart.has_password, true);
  const status = await call('/sync/webdav/status');
  assert.equal(status.has_password, true);
  assert.equal(status.configured, true);
  const tested = await call('/sync/webdav/test', 'POST', {});
  assert.equal(tested.ok, true, JSON.stringify(tested));
});

test('android config validation rejects unsafe input', async () => {
  await assert.rejects(
    call('/sync/webdav/config', 'PUT', baseConfig({ base_url: 'not-a-url' })),
    (error) => error.code === 'WEBDAV_URL_INVALID',
  );
  await assert.rejects(
    call('/sync/webdav/config', 'PUT', baseConfig({ remote_directory: '../etc' })),
    (error) => error.code === 'WEBDAV_URL_INVALID',
  );
  await assert.rejects(
    call('/sync/webdav/config', 'PUT', baseConfig({ remote_filename: 'nested/file.json' })),
    (error) => error.code === 'WEBDAV_URL_INVALID',
  );
  await assert.rejects(
    call('/sync/webdav/config', 'PUT', baseConfig({ base_url: 'http://dav.example.test/dav', allow_insecure_http: false })),
    (error) => error.code === 'WEBDAV_INSECURE_HTTP',
  );
  await assert.rejects(
    call('/sync/webdav/test', 'POST', { base_url: 'https://dav.example.test/dav', username: USERNAME }),
    (error) => error.code === 'SYNC_PASSWORD_REQUIRED',
  );
});

test('unchecking remember password forgets the session secret', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  assert.equal((await call('/sync/webdav/config')).has_password, true);
  const cleared = await call('/sync/webdav/config', 'PUT', baseConfig({ password: '', remember_password: false }));
  assert.equal(cleared.has_password, false);
  await assert.rejects(
    call('/sync/webdav/upload/preflight', 'POST', {}),
    (error) => error.code === 'SYNC_PASSWORD_REQUIRED',
  );
});

test('portable import leaves the local WebDAV credential untouched', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  const pack = {
    app: 'riji', schema_version: '0.8.0', exported_at: '2026-09-15T08:50:00.000Z',
    entities: {
      projects: [], recurrence_rules: [], recurrence_exceptions: [], todos: [],
      time_block_categories: [], time_blocks: [], schedules: [], daily_logs: [],
      log_templates: [], timer_sessions: [],
    },
  };
  await call('/data/import', 'POST', { package: pack, mode: 'replace' });
  const row = (await connection.query('SELECT password, remember_password FROM webdav_config')).values[0];
  assert.equal(row.password, PASSWORD);
  assert.equal(row.remember_password, 1);
});

test('test connection reports checks and creates the remote directory', async () => {
  const result = await call('/sync/webdav/test', 'POST', baseConfig());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks, {
    reachable: true, authenticated: true, directory_exists: true, directory_writable: true,
  });
  assert.equal(result.directory_created, true);
  assert.equal(server.directories.has('/dav/daytrace'), true);
  assert.equal(server.files.has('/dav/daytrace/.daytrace-write-probe.json'), false);

  const draftOnly = await call('/sync/webdav/test', 'POST', baseConfig({ base_url: 'http://dav.example.test/dav' }));
  assert.equal(draftOnly.ok, true);
  assert.equal((await call('/sync/webdav/config')).base_url, '', 'a draft test must not persist config');
});

test('test connection reports authentication and permission failures', async () => {
  server.directories.add('/dav/daytrace');
  const authFailed = await call('/sync/webdav/test', 'POST', baseConfig({ password: 'wrong' }));
  assert.equal(authFailed.ok, false);
  assert.equal(authFailed.code, 'WEBDAV_AUTH_FAILED');
  assert.equal(authFailed.checks.reachable, true);
  assert.equal(authFailed.checks.authenticated, false);

  server.writeForbidden = true;
  const readonly = await call('/sync/webdav/test', 'POST', baseConfig());
  assert.equal(readonly.ok, false);
  assert.equal(readonly.code, 'WEBDAV_FORBIDDEN');
  assert.equal(readonly.checks.directory_writable, false);
});

test('test connection degrades to HEAD when PROPFIND is unsupported', async () => {
  server.propfindSupported = false;
  server.directories.add('/dav/daytrace');
  server.store(REMOTE_PATH, '{"app":"riji"}');
  const result = await call('/sync/webdav/test', 'POST', baseConfig());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.protocol, 'head');
  assert.equal(result.unknown.includes('directory_writable'), true);
});

test('preflight shows local data and an empty remote', async () => {
  await connection.run(
    "INSERT INTO todos (uuid, name, ddl_type, category, status, notes, created_at, updated_at) VALUES (?, '待办', 'none', '任务', 'not_focusing', '', '2026-09-16T00:00:00', '2026-09-16T00:00:00')",
    ['123e4567-e89b-42d3-a456-426614174010'],
  );
  await call('/sync/webdav/config', 'PUT', baseConfig());
  const preflight = await call('/sync/webdav/upload/preflight', 'POST', {});
  assert.equal(preflight.remote.exists, false);
  assert.equal(preflight.local.schema_version, '0.8.0');
  assert.equal(preflight.local.entity_counts.todos, 1);
});

test('upload requires confirmation, uploads, then downloads the same package', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: false }),
    (error) => error.code === 'SYNC_CONFIRMATION_REQUIRED',
  );

  const preflight = await call('/sync/webdav/upload/preflight', 'POST', {});
  const uploaded = await call('/sync/webdav/upload', 'POST', {
    confirmed: true,
    expected_remote_etag: preflight.remote.etag,
    expected_remote_exists: preflight.remote.exists,
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.path, REMOTE_PATH);
  assert.equal(uploaded.etag, etagFor(server.files.get(REMOTE_PATH)));
  assert.equal(uploaded.directory_created, true);

  const status = await call('/sync/webdav/status');
  assert.equal(status.configured, true);
  assert.equal(status.last_error, '');
  assert.equal(status.last_remote_etag, uploaded.etag);
  assert.equal(status.remote_path, REMOTE_PATH);

  const downloaded = await call('/sync/webdav/download', 'POST', {});
  assert.equal(downloaded.remote.etag, uploaded.etag);
  assert.equal(downloaded.package.app, 'riji');
  assert.equal(downloaded.summary.total, 0);
  assert.equal(JSON.parse(server.files.get(REMOTE_PATH)).app, 'riji');
  assert.equal(String(server.files.get(REMOTE_PATH)).includes(PASSWORD), false);
});

test('upload conflicts when the remote file changed after the preflight', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  const preflight = await call('/sync/webdav/upload/preflight', 'POST', {});
  assert.equal(preflight.remote.exists, false);

  server.directories.add('/dav/daytrace');
  server.store(REMOTE_PATH, '{"app":"riji","other":true}');
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false }),
    (error) => error.code === 'WEBDAV_CONFLICT',
  );
  assert.equal(server.files.get(REMOTE_PATH), '{"app":"riji","other":true}');
  assert.equal((await call('/sync/webdav/status')).last_error_code, 'WEBDAV_CONFLICT');
});

test('upload conflicts when the remote etag changed and keeps local data intact', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  await call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false });
  const stale = (await call('/sync/webdav/status')).last_remote_etag;
  server.store(REMOTE_PATH, '{"app":"riji","changed":true}');

  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: stale, expected_remote_exists: true }),
    (error) => error.code === 'WEBDAV_CONFLICT',
  );
  assert.equal(server.files.get(REMOTE_PATH), '{"app":"riji","changed":true}');
  const config = await call('/sync/webdav/config');
  assert.equal(config.has_password, true, 'a conflict must not damage the stored configuration');
});

test('download never writes local data and rejects broken packages', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add('/dav/daytrace');

  server.store(REMOTE_PATH, JSON.stringify({
    app: 'riji',
    schema_version: '0.8.0',
    exported_at: '2026-09-15T08:50:00.000Z',
    entities: {
      projects: [], recurrence_rules: [], recurrence_exceptions: [], todos: [
        {
          uuid: '123e4567-e89b-42d3-a456-426614174011',
          name: '远端待办', ddl_type: 'none', category: '任务', status: 'not_focusing',
          created_at: '2026-09-15T00:00:00', updated_at: '2026-09-15T00:00:00',
        },
      ],
      schedules: [], daily_logs: [], log_templates: [], timer_sessions: [],
    },
  }));

  const downloaded = await call('/sync/webdav/download', 'POST', {});
  assert.equal(downloaded.package.entities.todos.length, 1);
  assert.equal(downloaded.summary.entity_counts.todos, 1);
  assert.equal((await connection.query('SELECT COUNT(*) AS count FROM todos')).values[0].count, 0);

  server.store(REMOTE_PATH, 'not json');
  await assert.rejects(
    call('/sync/webdav/download', 'POST', {}),
    (error) => error.code === 'WEBDAV_INVALID_PACKAGE',
  );

  server.store(REMOTE_PATH, JSON.stringify({ app: 'riji', schema_version: '9.9.9', entities: {} }));
  await assert.rejects(
    call('/sync/webdav/download', 'POST', {}),
    (error) => error.code === 'WEBDAV_UNSUPPORTED_SCHEMA',
  );

  server.store(REMOTE_PATH, JSON.stringify({ app: 'other', schema_version: '0.8.0', entities: {} }));
  await assert.rejects(
    call('/sync/webdav/download', 'POST', {}),
    (error) => error.code === 'WEBDAV_INVALID_PACKAGE',
  );
});

test('remote failures map to the documented codes', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add('/dav/daytrace');
  server.quotaExceeded = true;
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false }),
    (error) => error.code === 'WEBDAV_QUOTA_EXCEEDED',
  );

  server.quotaExceeded = false;
  server.writeForbidden = true;
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false }),
    (error) => error.code === 'WEBDAV_FORBIDDEN',
  );

  server.writeForbidden = false;
  await assert.rejects(
    call('/sync/webdav/download', 'POST', {}),
    (error) => error.code === 'WEBDAV_NOT_FOUND',
  );

  await call('/sync/webdav/config', 'PUT', baseConfig({ password: 'wrong' }));
  await assert.rejects(
    call('/sync/webdav/download', 'POST', {}),
    (error) => error.code === 'WEBDAV_AUTH_FAILED',
  );
});

test('a second sync request while busy is rejected instead of running twice', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add('/dav/daytrace');
  server.store(REMOTE_PATH, '{"app":"riji","schema_version":"0.8.0","entities":{}}');
  const first = call('/sync/webdav/download', 'POST', {});
  await assert.rejects(
    call('/sync/webdav/download', 'POST', {}),
    (error) => error.code === 'SYNC_BUSY',
  );
  await first;
  assert.equal((await call('/sync/webdav/status')).busy, false);
});
