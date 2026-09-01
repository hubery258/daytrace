import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScheduleFromRule,
  buildTodoFromRule,
  normalizeProjectCreate,
  normalizeRecurrenceRule,
  normalizeScheduleCreate,
  normalizeTodoCreate,
  normalizeTodoUpdate,
  parseDateTime,
  recurrenceDays,
  recurrenceMatches,
  timerElapsedSeconds,
} from '../src/data/mobile/domain.js';
import {
  createEmptyDataPackage,
  PORTABLE_ENTITY_ORDER,
  validateDataPackage,
} from '../src/data/mobile/portability.js';

function assertValidationError(callback) {
  assert.throws(callback, (error) => error?.status === 422 && error?.code === 'VALIDATION_ERROR');
}

test('naive mobile timestamps always use Beijing wall time', () => {
  assert.equal(parseDateTime('2026-08-19T08:30:00').toISOString(), '2026-08-19T00:30:00.000Z');
  assert.equal(parseDateTime('2026-08-19T00:30:00Z').toISOString(), '2026-08-19T00:30:00.000Z');
});

test('todo validation matches final DDL and waiting-reply state', () => {
  assertValidationError(() => normalizeTodoCreate({ name: 'DDL', ddl_type: 'hard' }));
  assertValidationError(() => normalizeTodoCreate({ name: '等待', status: 'waiting_reply' }));
  assertValidationError(() => normalizeTodoCreate({ name: '位置', position: Number.POSITIVE_INFINITY }));

  const created = normalizeTodoCreate({
    name: '等待',
    status: 'waiting_reply',
    waiting_reply_person: '  同学  ',
  });
  assert.equal(created.waiting_reply_person, '同学');
  assert.equal(created.category, '计划箱');

  const current = { ...created, id: 1, is_completed: false };
  assertValidationError(() => normalizeTodoUpdate({ ddl_type: 'soft' }, current));
});

test('schedule and project limits reject invalid values instead of truncating', () => {
  assertValidationError(() => normalizeProjectCreate({ name: '项目', color: 'x'.repeat(33) }));
  assertValidationError(() => normalizeScheduleCreate({
    name: '倒置日程',
    start_time: '2026-08-19T10:00:00',
    end_time: '2026-08-19T09:00:00',
  }));
  assertValidationError(() => normalizeScheduleCreate({
    name: '关联过多',
    start_time: '2026-08-19T09:00:00',
    end_time: '2026-08-19T10:00:00',
    linked_todo_ids: [1, 2, 3],
  }));
});

test('recurrence validation and matching cover daily weekly monthly boundaries', () => {
  const weekly = normalizeRecurrenceRule({
    entity_type: 'todo',
    frequency: 'weekly',
    start_date: '2026-08-17',
    end_date: '2026-08-31',
    weekdays: [1, 3, 3],
    template_json: { name: '复盘' },
  });
  assert.deepEqual(weekly.weekdays, [1, 3]);
  assert.equal(recurrenceMatches(weekly, '2026-08-19'), true);
  assert.equal(recurrenceMatches(weekly, '2026-08-20'), false);
  const daily = normalizeRecurrenceRule({
    entity_type: 'todo',
    frequency: 'daily',
    start_date: '2026-08-17',
    template_json: { name: '复盘' },
  });
  assertValidationError(() => normalizeRecurrenceRule({ frequency: 'weekly' }, daily));
  assertValidationError(() => normalizeRecurrenceRule({ entity_type: 'schedule' }, weekly));
  assert.deepEqual(recurrenceDays('2026-08-19', '2026-08-21'), [
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
  ]);
});

test('recurrence builders preserve Beijing time and DDL offsets', () => {
  const todo = buildTodoFromRule({
    entity_type: 'todo',
    project_id: null,
    template_json: {
      name: '提前截止',
      ddl_mode: 'offset_days',
      ddl_offset_days: 2,
      ddl_time: '21:30',
      reminder_days: 1,
    },
  }, '2026-08-19');
  assert.equal(todo.ddl_date, '2026-08-21T21:30:00');

  const schedule = buildScheduleFromRule({
    entity_type: 'schedule',
    project_id: null,
    template_json: {
      name: '跨日',
      start_time: '2026-01-01T23:30:00',
      end_time: '2026-01-02T01:00:00',
    },
  }, '2026-08-19');
  assert.equal(schedule.start_time, '2026-08-19T23:30:00');
  assert.equal(schedule.end_time, '2026-08-20T01:00:00');
});

test('timer elapsed time is based on persisted timestamps', () => {
  const elapsed = timerElapsedSeconds({
    started_at: '2026-08-19T09:00:00',
    ended_at: '2026-08-19T10:00:00',
    paused_seconds: 600,
    status: 'completed',
  });
  assert.equal(elapsed, 3000);
});

test('portable schema is v0.8, accepts v0.6, and excludes sensitive stores', () => {
  const empty = createEmptyDataPackage();
  assert.equal(empty.schema_version, '0.8.0');
  assert.deepEqual(Object.keys(empty.entities), PORTABLE_ENTITY_ORDER);
  for (const forbidden of ['zju_preferences', 'zju_calendar_caches', 'zju_grade_snapshots', 'external_items', 'active_timer_claim']) {
    assert.equal(Object.hasOwn(empty.entities, forbidden), false);
  }

  const legacy = {
    app: 'riji',
    schema_version: '0.6.0',
    entities: Object.fromEntries(PORTABLE_ENTITY_ORDER.filter((name) => name !== 'recurrence_exceptions').map((name) => [name, []])),
  };
  const normalized = validateDataPackage(legacy);
  assert.deepEqual(normalized.entities.recurrence_exceptions, []);
});
