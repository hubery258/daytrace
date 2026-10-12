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
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
let backupDirectory;

async function call(path, method = 'GET', body = undefined) {
  if (path === '/data/import' && !body.preview_token) {
    const preview = await call('/data/import/preview','POST',body);
    body = {...body,preview_token:preview.token};
  }
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
  backupDirectory = await mkdtemp(join(tmpdir(),'riji-runtime-backup-'));
  await __installDatabaseForTests(connection, async pack=>{
    const path=join(backupDirectory,'before-import.json'),data=JSON.stringify(pack);
    await writeFile(path,data);
    assert.equal(await readFile(path,'utf8'),data);
    return path;
  });
  server = new FakeWebDavServer();
  __setWebdavTransportForTests((request) => server.handle(request));
});

afterEach(async () => {
  __setWebdavTransportForTests(null);
  __resetDatabaseForTests();
  await connection.close();
  await rm(backupDirectory,{recursive:true,force:true});
});

test('the shipped schema carries a single webdav config row', async () => {
  const table = (await connection.query("SELECT name FROM sqlite_master WHERE type='table' AND name='webdav_config'")).values;
  assert.equal(table.length, 1);
  const config = await call('/sync/webdav/config');
  assert.equal(config.base_url, '');
  assert.equal(config.has_password, false);
  assert.equal((await connection.query('SELECT COUNT(*) AS count FROM webdav_config')).values[0].count, 1);
});

test('Android imports and exports legal 0.8 packages with recurrence exceptions without duplication', async () => {
  const pack = validPackage();
  pack.schema_version = '0.8.0';
  const ruleUuid = '123e4567-e89b-42d3-a456-426614174080';
  const exceptionUuid = '123e4567-e89b-42d3-a456-426614174081';
  pack.entities.recurrence_rules = [{
    uuid: ruleUuid, entity_type: 'todo', frequency: 'daily', start_date: '2026-10-01',
    template_json: { name: 'repeat' }, status: 'active',
    created_at: '2026-10-01T00:00:00', updated_at: '2026-10-01T00:00:00',
  }];
  pack.entities.recurrence_exceptions = [{
    uuid: exceptionUuid, recurrence_rule_uuid: ruleUuid, entity_type: 'todo',
    recurrence_date: '2026-10-11', action: 'deleted', created_at: '2026-10-11T00:00:00',
  }];
  await call('/data/import/preview', 'POST', { package: pack });
  await call('/data/import', 'POST', { package: pack });
  await call('/data/import', 'POST', { package: pack });
  // A second device can assign a different UUID to the same rule/date exception.
  pack.entities.recurrence_exceptions[0].uuid = '123e4567-e89b-42d3-a456-426614174082';
  const preview = await call('/data/import/preview', 'POST', { package: pack });
  assert.equal(preview.entities.recurrence_exceptions.create, 0);
  assert.equal(preview.entities.recurrence_exceptions.update, 0);
  assert.equal(preview.entities.recurrence_exceptions.skip, 1);
  await call('/data/import', 'POST', { package: pack });
  const exported = await call('/data/export');
  assert.equal(exported.entities.recurrence_exceptions.length, 1);
  assert.equal(exported.entities.recurrence_exceptions[0].recurrence_rule_uuid, ruleUuid);
  assert.equal(exported.entities.recurrence_exceptions[0].recurrence_date, '2026-10-11');
  assert.equal(exported.entities.recurrence_exceptions[0].action, 'deleted');
});

test('Android rolls back a package with a dangling recurrence exception', async () => {
  const pack = validPackage('must not survive');
  pack.entities.recurrence_exceptions = [{
    uuid: '123e4567-e89b-42d3-a456-426614174081',
    recurrence_rule_uuid: '123e4567-e89b-42d3-a456-426614174080',
    entity_type: 'todo', recurrence_date: '2026-10-11', action: 'deleted',
    created_at: '2026-10-11T00:00:00',
  }];
  await assert.rejects(call('/data/import', 'POST', { package: pack }), /引用不存在/);
  const exported = await call('/data/export');
  assert.equal(exported.entities.todos.length, 0);
  assert.equal(exported.entities.recurrence_exceptions.length, 0);
});

test('the runtime layer stores the password locally without exposing it', async () => {
  const saved = await call('/sync/webdav/config', 'PUT', baseConfig());
  assert.equal(saved.has_password, true);
  assert.equal(JSON.stringify(saved).includes(FAKE_PASSWORD), false);
  const row = (await connection.query('SELECT * FROM webdav_config')).values[0];
  assert.equal(Object.keys(row).includes('password'), true);
  assert.equal(row.password, FAKE_PASSWORD);
});

test('portable import leaves the local WebDAV credential untouched', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  await call('/data/import', 'POST', { package: validPackage('来自远端'), mode: 'replace' });
  const row = (await connection.query('SELECT password, remember_password FROM webdav_config')).values[0];
  assert.equal(row.password, FAKE_PASSWORD);
  assert.equal(row.remember_password, 1);
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

test('the runtime layer refuses an existing remote file without an ETag', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add(`${FAKE_ROOT}/daytrace`);
  const original = JSON.stringify(validPackage('保留远端'));
  server.store(FAKE_REMOTE_PATH, original);
  server.includeEtag = false;
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: true }),
    (error) => error.code === 'WEBDAV_CONFLICT',
  );
  assert.equal(server.files.get(FAKE_REMOTE_PATH), original);
});

test('the runtime layer uses create-only PUT to catch a file created after stat', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  const otherDevice = JSON.stringify(validPackage('另一台设备'));
  server.beforePut = (path) => server.store(path, otherDevice);
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', { confirmed: true, expected_remote_etag: null, expected_remote_exists: false }),
    (error) => error.code === 'WEBDAV_CONFLICT',
  );
  assert.equal(server.files.get(FAKE_REMOTE_PATH), otherDevice);
});

test('the runtime layer uses If-Match to catch a remote change after stat', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  server.directories.add(`${FAKE_ROOT}/daytrace`);
  const original = JSON.stringify(validPackage('原始远端'));
  const otherDevice = JSON.stringify(validPackage('另一台设备'));
  server.store(FAKE_REMOTE_PATH, original);
  server.beforePut = (path) => server.store(path, otherDevice);
  await assert.rejects(
    call('/sync/webdav/upload', 'POST', {
      confirmed: true,
      expected_remote_etag: etagFor(original),
      expected_remote_exists: true,
    }),
    (error) => error.code === 'WEBDAV_CONFLICT',
  );
  assert.equal(server.files.get(FAKE_REMOTE_PATH), otherDevice);
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

test('historical dangling schedule links block both upload routes before transport', async () => {
  await call('/sync/webdav/config', 'PUT', baseConfig());
  await connection.run(`INSERT INTO schedules (uuid,name,start_time,end_time,linked_todo_ids,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, ['123e4567-e89b-42d3-a456-426614174099','历史计划',
    '2026-09-16T09:00:00','2026-09-16T10:00:00','[999]',
    '2026-09-16T00:00:00','2026-09-16T00:00:00']);
  for (const path of ['/sync/webdav/upload/preflight','/sync/webdav/upload']) {
    await assert.rejects(call(path,'POST',{confirmed:true,expected_remote_exists:false}), error => {
      assert.equal(error.code,'SYNC_LOCAL_DATA_INVALID');
      assert.match(error.message,/schedules.linked_todo_ids/);
      assert.ok(!error.message.includes(FAKE_PASSWORD));
      return true;
    });
  }
  assert.deepEqual(server.requests,[]);
  assert.equal((await connection.query('SELECT linked_todo_ids FROM schedules')).values[0].linked_todo_ids,'[999]');
  await connection.run("UPDATE schedules SET linked_todo_ids='[]'");
  await call('/sync/webdav/upload/preflight','POST');
  assert.equal((await call('/sync/webdav/upload','POST',{confirmed:true,expected_remote_exists:false})).ok,true);
});

test('schedule repair previews dates, saves original links, preserves content and rejects stale confirmation', async () => {
  const todo=await call('/todos/','POST',{name:'有效任务',ddl_type:'none',category:'任务',status:'not_focusing'});
  await connection.run(`INSERT INTO schedules (uuid,name,start_time,end_time,linked_todo_ids,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,['123e4567-e89b-42d3-a456-426614174098','历史计划','2020-01-02T09:00:00',
    '2020-01-02T10:00:00',JSON.stringify([todo.id,999]),'保留正文','2020-01-02T00:00:00','2020-01-02T00:00:00']);
  let preview=await call('/data/references/schedules');
  assert.equal(preview.items[0].start_time,'2020-01-02T09:00:00');
  assert.deepEqual(preview.items[0].missing_ids,[999]);
  await assert.rejects(call('/data/references/schedules/repair','POST',{preview_token:preview.token,confirmed:false}));
  await connection.run("UPDATE schedules SET notes='检查后的修改'");
  await assert.rejects(call('/data/references/schedules/repair','POST',{preview_token:preview.token,confirmed:true}),/重新检查/);
  preview=await call('/data/references/schedules');
  const result=await call('/data/references/schedules/repair','POST',{preview_token:preview.token,confirmed:true});
  const backup=JSON.parse(await readFile(result.backup_path,'utf8'));
  assert.deepEqual(backup.before[0].linked_todo_ids,[todo.id,999]);
  const row=(await connection.query('SELECT * FROM schedules')).values[0];
  assert.equal(row.linked_todo_ids,JSON.stringify([todo.id]));
  assert.equal(row.notes,'检查后的修改');
  await call('/data/export');
  preview=await call('/data/references/schedules');
  assert.deepEqual(preview.items,[]);
  assert.equal((await call('/data/references/schedules/repair','POST',{preview_token:preview.token,confirmed:true})).repaired,0);
  assert.deepEqual(server.requests,[]);
});

test('schedule repair backup and partial write failure never change historical records',async()=>{
  for (let i=0;i<2;i++) await connection.run(`INSERT INTO schedules (uuid,name,start_time,end_time,linked_todo_ids,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`,[`123e4567-e89b-42d3-a456-42661417409${i}`,'历史计划','2020-01-02T09:00:00',
    '2020-01-02T10:00:00','[999]','2020-01-02T00:00:00','2020-01-02T00:00:00']);
  let preview=await call('/data/references/schedules');
  await __installDatabaseForTests(connection,async()=>{throw new Error('副本失败');});
  await assert.rejects(call('/data/references/schedules/repair','POST',{preview_token:preview.token,confirmed:true}),/副本失败/);
  assert.deepEqual((await connection.query('SELECT linked_todo_ids FROM schedules')).values.map(r=>r.linked_todo_ids),['[999]','[999]']);
  await __installDatabaseForTests(connection,async pack=>{
    const path=join(backupDirectory,'repair.json'),data=JSON.stringify(pack);
    await writeFile(path,data);assert.equal(await readFile(path,'utf8'),data);return path;
  });
  preview=await call('/data/references/schedules');
  const original=connection.run.bind(connection);let updates=0;
  connection.run=async(sql,...args)=>{
    if (sql.startsWith('UPDATE schedules') && ++updates===2) throw new Error('模拟写入失败');
    return original(sql,...args);
  };
  try {await assert.rejects(call('/data/references/schedules/repair','POST',{preview_token:preview.token,confirmed:true}),/模拟写入失败/);}
  finally {connection.run=original;}
  assert.deepEqual((await connection.query('SELECT linked_todo_ids FROM schedules')).values.map(r=>r.linked_todo_ids),['[999]','[999]']);
});
