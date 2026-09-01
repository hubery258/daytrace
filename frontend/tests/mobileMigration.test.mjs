import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __installDatabaseForTests,
  __resetDatabaseForTests,
} from '../src/data/mobile/database.js';
import { mobileRequest } from '../src/data/mobile/router.js';
import { createSqlJsConnection } from './helpers/sqlJsDatabase.mjs';

process.env.NODE_ENV = 'test';

test('v5 migration preserves historical duplicates and derives one runtime claim', async () => {
  const connection = await createSqlJsConnection();
  try {
    await __installDatabaseForTests(connection);
    await connection.execute(`
      DROP TABLE recurrence_instance_claims;
      DROP TABLE active_timer_claim;
      DELETE FROM mobile_schema_migrations WHERE version = 5;
      PRAGMA user_version = 4;
    `);
    const stamp = '2026-08-19T00:00:00';
    await connection.run(`
      INSERT INTO recurrence_rules
        (uuid, entity_type, template_json, frequency, start_date, status, created_at, updated_at)
      VALUES (?, 'todo', '{}', 'daily', '2099-01-01', 'active', ?, ?)
    `, ['123e4567-e89b-42d3-a456-426614170001', stamp, stamp]);
    for (const [uuid, name] of [
      ['123e4567-e89b-42d3-a456-426614170002', '历史实例 A'],
      ['123e4567-e89b-42d3-a456-426614170003', '历史实例 B'],
    ]) {
      await connection.run(`
        INSERT INTO todos
          (uuid, recurrence_rule_id, recurrence_date, name, ddl_type, category, status, notes, created_at, updated_at)
        VALUES (?, 1, '2099-01-01', ?, 'none', '计划箱', 'not_focusing', '', ?, ?)
      `, [uuid, name, stamp, stamp]);
    }
    for (const uuid of [
      '123e4567-e89b-42d3-a456-426614170004',
      '123e4567-e89b-42d3-a456-426614170005',
    ]) {
      await connection.run(`
        INSERT INTO recurrence_exceptions
          (uuid, recurrence_rule_id, entity_type, recurrence_date, action, created_at)
        VALUES (?, 1, 'todo', '2099-01-01', 'deleted', ?)
      `, [uuid, stamp]);
    }
    for (const [uuid, name, createdAt] of [
      ['123e4567-e89b-42d3-a456-426614170006', '旧活动计时', '2026-08-18T00:00:00'],
      ['123e4567-e89b-42d3-a456-426614170007', '最新活动计时', '2026-08-19T00:00:00'],
    ]) {
      await connection.run(`
        INSERT INTO timer_sessions
          (uuid, name, status, started_at, paused_seconds, notes, created_at, updated_at)
        VALUES (?, ?, 'running', ?, 0, '', ?, ?)
      `, [uuid, name, createdAt, createdAt, createdAt]);
    }

    __resetDatabaseForTests();
    await __installDatabaseForTests(connection);

    assert.equal((await connection.query('SELECT COUNT(*) AS count FROM todos')).values[0].count, 2);
    assert.equal((await connection.query('SELECT COUNT(*) AS count FROM recurrence_exceptions')).values[0].count, 2);
    assert.equal((await connection.query('SELECT COUNT(*) AS count FROM recurrence_instance_claims')).values[0].count, 1);
    assert.equal((await mobileRequest('/timer/current')).name, '最新活动计时');

    const exported = await mobileRequest('/data/export');
    assert.equal(exported.entities.recurrence_exceptions.length, 1);
    assert.equal(exported.entities.recurrence_exceptions[0].recurrence_rule_uuid, '123e4567-e89b-42d3-a456-426614170001');
  } finally {
    __resetDatabaseForTests();
    await connection.close();
  }
});
