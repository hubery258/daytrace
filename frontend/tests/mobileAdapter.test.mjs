import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __installDatabaseForTests,
  __resetDatabaseForTests,
} from '../src/data/mobile/database.js';
import { mobileRequest } from '../src/data/mobile/router.js';
import { createSqlJsConnection } from './helpers/sqlJsDatabase.mjs';

process.env.NODE_ENV = 'test';

let connection;

async function call(path, method = 'GET', body = undefined) {
  return mobileRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectApiError(promise, status, code) {
  await assert.rejects(promise, (error) => error?.status === status && error?.code === code);
}

beforeEach(async () => {
  connection = await createSqlJsConnection();
  await __installDatabaseForTests(connection);
});

afterEach(async () => {
  __resetDatabaseForTests();
  await connection.close();
});

test('migrations are ordered, versioned, and keep identity claim tables', async () => {
  const migrations = (await connection.query('SELECT version, name FROM mobile_schema_migrations ORDER BY version')).values;
  const version = (await connection.query('PRAGMA user_version')).values[0].user_version;
  const claimTable = (await connection.query("SELECT name FROM sqlite_master WHERE type='table' AND name='recurrence_instance_claims'")).values;
  assert.deepEqual(migrations.map((item) => item.version), [1, 2, 3, 4, 5]);
  assert.equal(version, 5);
  assert.equal(claimTable.length, 1);
});

test('projects and todos enforce overview ordering, focus limit, and atomic completion log', async () => {
  const project = await call('/projects/', 'POST', { name: 'Android 项目' });
  const positioned = await call('/todos/', 'POST', {
    name: '手动第一', project_id: project.id, position: 0, status: 'focusing',
  });
  await call('/todos/', 'POST', {
    name: '较早 DDL', project_id: project.id, ddl_type: 'hard',
    ddl_date: '2026-08-20T09:00:00', reminder_days: 1, status: 'focusing',
  });
  await call('/todos/', 'POST', {
    name: '第三项', project_id: project.id, status: 'focusing',
  });
  await expectApiError(call('/todos/', 'POST', {
    name: '超限', project_id: project.id, status: 'focusing',
  }), 409, 'CONFLICT');

  const overview = await call(`/projects/${project.id}/overview`);
  assert.equal(overview.next_todo.id, positioned.id);
  await call(`/todos/${positioned.id}/complete`, 'POST', { log_date: '2026-08-19' });
  await call(`/todos/${positioned.id}/complete`, 'POST', { log_date: '2026-08-19' });
  const log = await call('/logs/2026-08-19');
  assert.deepEqual(log.completed_todo_ids, [positioned.id]);

  await call(`/projects/${project.id}`, 'DELETE');
  const detached = await call(`/todos/${positioned.id}`);
  assert.equal(detached.project_id, null);
});

test('schedules use lane overlap detection and strict week intersection boundaries', async () => {
  const first = await call('/schedules/', 'POST', {
    name: '计划', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T10:00:00', is_planned: true,
  });
  await expectApiError(call('/schedules/', 'POST', {
    name: '重叠', start_time: '2026-08-19T09:30:00', end_time: '2026-08-19T10:30:00', is_planned: true,
  }), 409, 'CONFLICT');
  const actual = await call('/schedules/', 'POST', {
    name: '实际轨', start_time: '2026-08-19T09:30:00', end_time: '2026-08-19T10:30:00', is_planned: false,
  });
  await call('/schedules/', 'POST', {
    name: '右边界外', start_time: '2026-08-24T00:00:00', end_time: '2026-08-24T01:00:00', is_planned: true,
  });
  const week = await call('/schedules/week/?start_date=2026-08-17');
  assert.deepEqual(week.map((item) => item.id), [first.id, actual.id]);
});

test('recurrence generation is idempotent and deleted instances never revive', async () => {
  const rule = await call('/recurrence-rules/', 'POST', {
    entity_type: 'todo',
    frequency: 'daily',
    start_date: '2099-01-05',
    template_json: { name: '每日复盘' },
  });
  const request = { date_from: '2099-01-05', date_to: '2099-01-05' };
  const first = await call('/recurrence-rules/generate', 'POST', request);
  const second = await call('/recurrence-rules/generate', 'POST', request);
  assert.equal(first.created_todo_ids.length, 1);
  assert.deepEqual(second.created_todo_ids, []);

  await call(`/todos/${first.created_todo_ids[0]}`, 'DELETE');
  const afterDelete = await call('/recurrence-rules/generate', 'POST', request);
  assert.deepEqual(afterDelete.created_todo_ids, []);
  const exceptions = (await connection.query(
    'SELECT * FROM recurrence_exceptions WHERE recurrence_rule_id = ? AND recurrence_date = ?',
    [rule.id, '2099-01-05'],
  )).values;
  assert.equal(exceptions.length, 1);
});

test('overlapping recurring schedules do not leave a stale claim', async () => {
  const blocker = await call('/schedules/', 'POST', {
    name: '占位', start_time: '2099-02-01T09:00:00', end_time: '2099-02-01T10:00:00', is_planned: true,
  });
  await call('/recurrence-rules/', 'POST', {
    entity_type: 'schedule', frequency: 'daily', start_date: '2099-02-01',
    template_json: {
      name: '重复日程', start_time: '2020-01-01T09:00:00', end_time: '2020-01-01T10:00:00',
    },
  });
  const request = { date_from: '2099-02-01', date_to: '2099-02-01', entity_type: 'schedule' };
  assert.deepEqual((await call('/recurrence-rules/generate', 'POST', request)).created_schedule_ids, []);
  assert.equal((await connection.query('SELECT * FROM recurrence_instance_claims')).values.length, 0);
  await call(`/schedules/${blocker.id}`, 'DELETE');
  assert.equal((await call('/recurrence-rules/generate', 'POST', request)).created_schedule_ids.length, 1);
});

test('timer state restores from persisted timestamps and templates never fake success', async () => {
  const started = await call('/timer/start', 'POST', { name: '深度工作' });
  __resetDatabaseForTests();
  await __installDatabaseForTests(connection, { migrate: false });
  assert.equal((await call('/timer/current')).id, started.id);
  await call('/timer/pause', 'POST');
  await call('/timer/resume', 'POST');
  await call('/timer/finish', 'POST');
  assert.equal(await call('/timer/current'), null);
  assert.equal((await call('/timer/recent?limit=8'))[0].status, 'completed');

  await expectApiError(call('/templates/9999', 'PUT', { name: '不存在' }), 404, 'NOT_FOUND');
  await expectApiError(call('/templates/9999', 'DELETE'), 404, 'NOT_FOUND');
});

test('portable export excludes secrets and replace import rolls back on broken references', async () => {
  const project = await call('/projects/', 'POST', { name: '保留项目' });
  const pack = await call('/data/export');
  assert.equal(pack.schema_version, '0.8.0');
  for (const forbidden of ['zju_preferences', 'zju_calendar_caches', 'zju_grade_snapshots', 'external_items']) {
    assert.equal(Object.hasOwn(pack.entities, forbidden), false);
  }

  const broken = structuredClone(pack);
  broken.entities.todos.push({
    uuid: '123e4567-e89b-42d3-a456-426614174000',
    name: '断引用', ddl_type: 'none', category: '计划箱', status: 'not_focusing',
    project_uuid: '123e4567-e89b-42d3-a456-426614174999',
    created_at: '2026-08-19T00:00:00',
    updated_at: '2026-08-19T00:00:00',
  });
  await expectApiError(call('/data/import', 'POST', { package: broken, mode: 'replace' }), 422, 'VALIDATION_ERROR');
  assert.equal((await call(`/projects/${project.id}`)).name, '保留项目');
});
