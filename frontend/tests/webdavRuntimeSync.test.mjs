/**
 * Android runtime data-layer tests for the v0.11.0 WebDAV sync.
 *
 * The Capacitor Android app talks to `src/data/mobileDatabase.js`; the modular
 * `src/data/mobile/*` layer is used by the contract tests. Both wire the same
 * `createSyncRoutes` factory, and these tests run the runtime layer against an
 * in-memory WebDAV server with a real SQL database, so the path that actually
 * ships on Android is verified end to end.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __installDatabaseForTests,
  __resetDatabaseForTests,
  mobileRequest,
} from '../src/data/mobileDatabase.js';
import { __setWebdavTransportForTests } from '../src/platform/webdavSync.js';
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

let connection;
let server;

async function call(path, method = 'GET', body = undefined) {
  return mobileRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function baseConfig(overrides = {}) {
  return {
    base_url: server.baseUrl,
    username: FAKE_USERNAME,
    password: FAKE_PASSWORD,
    remember_password: true,
    remote_directory: 'daytrace',
    remote_filename: 'daytrace-latest.json',
    allow_insecure_http: true,
    ...overrides,
  };
}

function validPackage(todoName) {
  return {
    app: 'riji',
    schema_version: '0.10.0',
    exported_at: '2026-09-15T08:50:00.000Z',
    entities: {
      projects: [],
      recurrence_rules: [],
      recurrence_exceptions: [],
      todos: todoName ? [{
        uuid: '123e4567-e89b-42d3-a456-426614174021',
        name: todoName,
        ddl_type: 'none',
        category: '任务',
        status: 'not_focusing',
        created_at: '2026-09-15T00:00:00',
        updated_at: '2026-09-15T00:00:00',
      }] : [],
      time_block_categories: [],
      time_blocks: [],
      schedules: [],
      daily_logs: [],
      log_templates: [],
      timer_sessions: [],
    },
  };
}

beforeEach(async () => {
  connection = await createSqlJsConnection();
  await __installDatabaseForTests(connection);
  server = new FakeWebDavServer();
  __setWebdavTransportForTests((request) => server.handle(request));
});

afterEach(async () => {
  __setWebdavTransportForTests(null);
  __resetDatabaseForTests();
  await connection.close();
});

test('the shipped schema carries a single webdav config row', async () => {
  const table = (await connection.query("SELECT name FROM sqlite_master WHERE type='table' AND name='webdav_config'")).values;
  assert.equal(table.length, 1);
  const config = await call('/sync/webdav/config');
  assert.equal(config.base_url, '');
  assert.equal(config.has_password, false);
  assert.equal((await connection.query('SELECT COUNT(*) AS count FROM webdav_config')).values[0].count, 1);
});

test('the runtime layer saves config without storing the password', async () => {
  const saved = await call('/sync/webdav/config', 'PUT', baseConfig());
  assert.equal(saved.has_password, true);
  assert.equal(JSON.stringify(saved).includes(FAKE_PASSWORD), false);
  const row = (await connection.query('SELECT * FROM webdav_config')).values[0];
  assert.equal(Object.keys(row).includes('password'), false);
  assert.equal(JSON.stringify(row).includes(FAKE_PASSWORD), false);
});

test('the runtime layer uploads v0.10 time-block data and downloads it again', async () => {
  await connection.run(
    "INSERT INTO time_block_categories (uuid, name, color, created_at, updated_at) VALUES ('123e4567-e89b-42d3-a456-426614174030', '学习', '#347f88', '2026-09-16T00:00:00', '2026-09-16T00:00:00')",
  );
  await connection.run(
    "INSERT INTO time_blocks (uuid, block_date, start_minute, end_minute, granularity, category_id, notes, source, coverage_seconds, created_at, updated_at) VALUES ('123e4567-e89b-42d3-a456-426614174031', '2026-09-16', 0, 30, 30, 1, '专注', 'manual', 1800, '2026-09-16T00:00:00', '2026-09-16T00:00:00')",
  );
  await call('/sync/webdav/config', 'PUT', baseConfig());

  const preflight = await call('/sync/webdav/upload/preflight', 'POST', {});
  assert.equal(preflight.remote.exists, false);
  assert.equal(preflight.local.schema_version, '0.10.0');
  assert.equal(preflight.local.entity_counts.time_blocks, 1);

  const uploaded = await call('/sync/webdav/upload', 'POST', {
    confirmed: true,
    expected_remote_etag: null,
    expected_remote_exists: false,
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.schema_version, '0.10.0');
  assert.equal(uploaded.directory_created, true);
  assert.equal(uploaded.etag, etagFor(server.files.get(FAKE_REMOTE_PATH)));

  const stored = JSON.parse(server.files.get(FAKE_REMOTE_PATH));
  assert.equal(stored.entities.time_blocks.length, 1);
  assert.equal(JSON.stringify(stored).includes(FAKE_PASSWORD), false);
  assert.equal(JSON.stringify(stored).includes('zju'), false);

  const downloaded = await call('/sync/webdav/download', 'POST', {});
  assert.equal(downloaded.package.schema_version, '0.10.0');
  assert.equal(downloaded.package.entities.time_blocks.length, 1);
  assert.equal(downloaded.summary.entity_counts.time_blocks, 1);
});

test('the runtime layer refuses to overwrite a remotely changed file', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  await call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false });
  const stale = (await call('/sync/webdav/status')).last_remote_etag;

  server.store(FAKE_REMOTE_PATH, JSON.stringify(validPackage('另一台设备')));
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: stale, expected_remote_exists: true }),
    (error) => error.code === 'WEBDAV_CONFLICT',
  );
  assert.equal(JSON.parse(server.files.get(FAKE_REMOTE_PATH)).entities.todos[0].name, '另一台设备');
  assert.equal((await call('/sync/webdav/status')).last_error_code, 'WEBDAV_CONFLICT');
});

test('a download never writes local data and rejects unsupported packages', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add(`${FAKE_ROOT}/daytrace`);
  server.store(FAKE_REMOTE_PATH, JSON.stringify(validPackage('远端待办')));

  const downloaded = await call('/sync/webdav/download', 'POST', {});
  assert.equal(downloaded.package.entities.todos[0].name, '远端待办');
  assert.equal((await connection.query('SELECT COUNT(*) AS count FROM todos')).values[0].count, 0);

  server.store(FAKE_REMOTE_PATH, 'not json');
  await assert.rejects(call('/sync/webdav/download', 'POST', {}), (error) => error.code === 'WEBDAV_INVALID_PACKAGE');

  server.store(FAKE_REMOTE_PATH, JSON.stringify({ app: 'riji', schema_version: '9.9.9', entities: {} }));
  await assert.rejects(call('/sync/webdav/download', 'POST', {}), (error) => error.code === 'WEBDAV_UNSUPPORTED_SCHEMA');

  server.store(FAKE_REMOTE_PATH, JSON.stringify({ app: 'other', schema_version: '0.10.0', entities: {} }));
  await assert.rejects(call('/sync/webdav/download', 'POST', {}), (error) => error.code === 'WEBDAV_INVALID_PACKAGE');
});

test('the runtime layer maps remote failures to documented codes', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add(`${FAKE_ROOT}/daytrace`);
  server.quotaExceeded = true;
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false }),
    (error) => error.code === 'WEBDAV_QUOTA_EXCEEDED',
  );

  server.quotaExceeded = false;
  await assert.rejects(call('/sync/webdav/download', 'POST', {}), (error) => error.code === 'WEBDAV_NOT_FOUND');

  await call('/sync/webdav/config', 'PUT', baseConfig({ password: 'wrong-password' }));
  await assert.rejects(call('/sync/webdav/download', 'POST', {}), (error) => error.code === 'WEBDAV_AUTH_FAILED');
});

test('the runtime layer keeps one sync task at a time', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add(`${FAKE_ROOT}/daytrace`);
  server.store(FAKE_REMOTE_PATH, JSON.stringify(validPackage(null)));
  const first = call('/sync/webdav/download', 'POST', {});
  await assert.rejects(call('/sync/webdav/download', 'POST', {}), (error) => error.code === 'SYNC_BUSY');
  await first;
  assert.equal((await call('/sync/webdav/status')).busy, false);
});
