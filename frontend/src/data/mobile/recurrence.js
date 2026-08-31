import {
  beijingNow,
  createUuid,
  insert,
  one,
  rows,
  run,
  update,
  withTransaction,
  withWriteLock,
} from './database.js';
import {
  buildScheduleFromRule,
  buildTodoFromRule,
  dateOnly,
  normalizeRecurrenceRule,
  normalizeScheduleUpdate,
  normalizeTodoUpdate,
  notFound,
  parseBoolean,
  recurrenceDays,
  recurrenceMatches,
  validationError,
} from './domain.js';
import { findScheduleOverlaps, insertScheduleRecord } from './schedules.js';
import { enrichTodo, getTodo, insertTodoRecord } from './projectsTodos.js';

const TODO_TEMPLATE_FIELDS = new Set([
  'name', 'position', 'ddl_type', 'ddl_date', 'reminder_days', 'category',
  'status', 'waiting_reply_person', 'notes',
]);
const SCHEDULE_TEMPLATE_FIELDS = new Set([
  'name', 'start_time', 'end_time', 'category', 'nature', 'relax_suggestion',
  'linked_todo_ids', 'location', 'notes', 'is_planned',
]);

function changedRows(result) {
  if (typeof result?.changes === 'number') return result.changes;
  return Number(result?.changes?.changes || 0);
}

async function getRule(id) {
  return one('recurrence_rules', 'id = ?', [id]);
}

async function claimInstance(rule, day) {
  const result = await run(
    `INSERT OR IGNORE INTO recurrence_instance_claims
      (rule_uuid, entity_type, recurrence_date, created_at) VALUES (?, ?, ?, ?)`,
    [rule.uuid, rule.entity_type, day, beijingNow()],
    false,
  );
  return changedRows(result) > 0;
}

async function rebuildClaimsForRule(rule) {
  await run('DELETE FROM recurrence_instance_claims WHERE rule_uuid = ?', [rule.uuid], false);
  const table = rule.entity_type === 'todo' ? 'todos' : 'schedules';
  const instances = await rows(table, 'recurrence_rule_id = ? AND recurrence_date IS NOT NULL', [rule.id]);
  const exceptions = await rows(
    'recurrence_exceptions',
    'recurrence_rule_id = ? AND entity_type = ?',
    [rule.id, rule.entity_type],
  );
  for (const day of new Set([...instances, ...exceptions].map((item) => item.recurrence_date).filter(Boolean))) {
    await run(
      `INSERT OR IGNORE INTO recurrence_instance_claims
        (rule_uuid, entity_type, recurrence_date, created_at) VALUES (?, ?, ?, ?)`,
      [rule.uuid, rule.entity_type, day, beijingNow()],
      false,
    );
  }
}

async function hasInstance(rule, day) {
  const table = rule.entity_type === 'todo' ? 'todos' : 'schedules';
  return Boolean(await one(table, 'recurrence_rule_id = ? AND recurrence_date = ?', [rule.id, day]));
}

async function hasDeletedException(rule, day) {
  return Boolean(await one(
    'recurrence_exceptions',
    'recurrence_rule_id = ? AND entity_type = ? AND recurrence_date = ? AND action = ?',
    [rule.id, rule.entity_type, day, 'deleted'],
  ));
}

async function generate(body) {
  const days = recurrenceDays(body.date_from, body.date_to);
  return withWriteLock(() => withTransaction(async () => {
    const clauses = ["status = 'active'"];
    const values = [];
    if (body.entity_type != null) {
      if (!['todo', 'schedule'].includes(body.entity_type)) throw validationError('entity_type 的值无效');
      clauses.push('entity_type = ?');
      values.push(body.entity_type);
    }
    const rules = await rows('recurrence_rules', clauses.join(' AND '), values, 'created_at DESC');
    const createdTodoIds = [];
    const createdScheduleIds = [];
    for (const rule of rules) {
      for (const day of days) {
        if (!recurrenceMatches(rule, day)) continue;
        if (await hasInstance(rule, day) || await hasDeletedException(rule, day)) {
          await run(
            `INSERT OR IGNORE INTO recurrence_instance_claims
              (rule_uuid, entity_type, recurrence_date, created_at) VALUES (?, ?, ?, ?)`,
            [rule.uuid, rule.entity_type, day, beijingNow()],
            false,
          );
          continue;
        }
        if (rule.entity_type === 'schedule') {
          const data = buildScheduleFromRule(rule, day);
          const overlaps = await findScheduleOverlaps({
            startTime: data.start_time,
            endTime: data.end_time,
            isPlanned: true,
          });
          if (overlaps.length) continue;
          if (!(await claimInstance(rule, day))) continue;
          const schedule = await insertScheduleRecord(data, {
            recurrence_rule_id: rule.id,
            recurrence_date: day,
          }, false);
          createdScheduleIds.push(schedule.id);
        } else {
          if (!(await claimInstance(rule, day))) continue;
          const todo = await insertTodoRecord(buildTodoFromRule(rule, day), {
            recurrence_rule_id: rule.id,
            recurrence_date: day,
          }, false);
          createdTodoIds.push(todo.id);
        }
      }
    }
    return { created_todo_ids: createdTodoIds, created_schedule_ids: createdScheduleIds };
  }));
}

function syncTodoDdlTemplate(template, todo, updateData) {
  const ddlType = updateData.ddl_type ?? todo.ddl_type;
  template.ddl_type = ddlType;
  if (ddlType === 'none') {
    template.ddl_mode = 'none';
    template.ddl_date = null;
    template.reminder_days = null;
    return template;
  }
  const ddlDate = updateData.ddl_date ?? todo.ddl_date;
  if (ddlDate && todo.recurrence_date) {
    const ddlDay = dateOnly(ddlDate, 'ddl_date');
    const recurrenceDay = dateOnly(todo.recurrence_date, 'recurrence_date');
    const offset = Math.round((Date.parse(`${ddlDay}T00:00:00Z`) - Date.parse(`${recurrenceDay}T00:00:00Z`)) / 86400000);
    template.ddl_mode = offset === 0 ? 'same_day_time' : 'offset_days';
    template.ddl_offset_days = Math.max(0, offset);
    template.ddl_time = String(ddlDate).match(/T(\d{2}:\d{2})/)?.[1] || '23:59';
  }
  template.reminder_days = updateData.reminder_days ?? todo.reminder_days;
  return template;
}

async function syncTodo(todoId, body) {
  return withWriteLock(() => withTransaction(async () => {
    const todo = await one('todos', 'id = ?', [todoId]);
    if (!todo?.recurrence_rule_id) throw notFound('重复待办实例不存在');
    const rule = await getRule(todo.recurrence_rule_id);
    if (!rule || rule.entity_type !== 'todo') throw notFound('重复待办规则不存在');
    const updateData = normalizeTodoUpdate(body, todo);
    const template = { ...(rule.template_json || {}) };
    for (const [key, value] of Object.entries(updateData)) {
      if (key === 'project_id') rule.project_id = value;
      else if (TODO_TEMPLATE_FIELDS.has(key)) template[key] = value;
    }
    syncTodoDdlTemplate(template, todo, updateData);
    await update('recurrence_rules', rule.id, {
      project_id: rule.project_id,
      template_json: template,
      updated_at: beijingNow(),
    }, false);
    const refreshedRule = { ...rule, project_id: rule.project_id, template_json: template };
    const today = beijingNow().slice(0, 10);
    const instances = await rows(
      'todos',
      'recurrence_rule_id = ? AND recurrence_date >= ? AND is_completed = 0 AND is_recurrence_exception = 0',
      [rule.id, today],
    );
    for (const instance of instances) {
      const generated = buildTodoFromRule(refreshedRule, instance.recurrence_date);
      await update('todos', instance.id, { ...generated, updated_at: beijingNow() }, false);
    }
    return getTodo(todoId);
  }));
}

async function syncSchedule(scheduleId, body) {
  return withWriteLock(() => withTransaction(async () => {
    const schedule = await one('schedules', 'id = ?', [scheduleId]);
    if (!schedule?.recurrence_rule_id) throw notFound('重复日程实例不存在');
    const rule = await getRule(schedule.recurrence_rule_id);
    if (!rule || rule.entity_type !== 'schedule') throw notFound('重复日程规则不存在');
    const updateData = normalizeScheduleUpdate(body, schedule);
    const template = { ...(rule.template_json || {}) };
    for (const [key, value] of Object.entries(updateData)) {
      if (key === 'project_id') rule.project_id = value;
      else if (SCHEDULE_TEMPLATE_FIELDS.has(key)) template[key] = value;
    }
    template.is_planned = true;
    await update('recurrence_rules', rule.id, {
      project_id: rule.project_id,
      template_json: template,
      updated_at: beijingNow(),
    }, false);
    const refreshedRule = { ...rule, project_id: rule.project_id, template_json: template };
    const today = beijingNow().slice(0, 10);
    const instances = await rows(
      'schedules',
      'recurrence_rule_id = ? AND recurrence_date >= ? AND is_recurrence_exception = 0',
      [rule.id, today],
    );
    for (const instance of instances) {
      const generated = buildScheduleFromRule(refreshedRule, instance.recurrence_date);
      const overlaps = await findScheduleOverlaps({
        startTime: generated.start_time,
        endTime: generated.end_time,
        isPlanned: true,
        excludeId: instance.id,
      });
      if (!overlaps.length) await update('schedules', instance.id, { ...generated, updated_at: beijingNow() }, false);
    }
    return one('schedules', 'id = ?', [scheduleId]);
  }));
}

export async function recurrenceRequest(method, pathname, params, body) {
  if (method === 'POST' && pathname === '/recurrence-rules/generate') return generate(body);
  const todoSync = pathname.match(/^\/recurrence-rules\/from-todo\/(\d+)\/sync$/);
  if (method === 'POST' && todoSync) return syncTodo(Number(todoSync[1]), body);
  const scheduleSync = pathname.match(/^\/recurrence-rules\/from-schedule\/(\d+)\/sync$/);
  if (method === 'POST' && scheduleSync) return syncSchedule(Number(scheduleSync[1]), body);
  if (method === 'GET' && pathname === '/recurrence-rules/') {
    const clauses = [];
    const values = [];
    if (params.has('entity_type')) {
      clauses.push('entity_type = ?');
      values.push(params.get('entity_type'));
    }
    if (!parseBoolean(params.get('include_archived'), false)) clauses.push("status != 'archived'");
    return rows('recurrence_rules', clauses.join(' AND '), values, 'created_at DESC');
  }
  if (method === 'POST' && pathname === '/recurrence-rules/') {
    return withWriteLock(async () => {
      const data = normalizeRecurrenceRule(body);
      const stamp = beijingNow();
      return insert('recurrence_rules', { uuid: createUuid(), ...data, created_at: stamp, updated_at: stamp });
    });
  }
  const match = pathname.match(/^\/recurrence-rules\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (method === 'GET') {
    const rule = await getRule(id);
    if (!rule) throw notFound('重复规则不存在');
    return rule;
  }
  if (method === 'PUT') {
    return withWriteLock(async () => {
      const current = await getRule(id);
      if (!current) throw notFound('重复规则不存在');
      const normalized = normalizeRecurrenceRule(body, current);
      return update('recurrence_rules', id, { ...normalized, updated_at: beijingNow() });
    });
  }
  if (method === 'DELETE') {
    return withWriteLock(() => withTransaction(async () => {
      const rule = await getRule(id);
      if (!rule) throw notFound('重复规则不存在');
      await update('recurrence_rules', id, { status: 'archived', updated_at: beijingNow() }, false);
      if (parseBoolean(params.get('delete_future_instances'), false)) {
        const today = beijingNow().slice(0, 10);
        if (rule.entity_type === 'todo') {
          await run(
            'DELETE FROM todos WHERE recurrence_rule_id = ? AND recurrence_date >= ? AND is_completed = 0',
            [id, today],
            false,
          );
        } else {
          await run(
            'DELETE FROM schedules WHERE recurrence_rule_id = ? AND recurrence_date >= ?',
            [id, today],
            false,
          );
        }
        await rebuildClaimsForRule(rule);
      }
      return null;
    }));
  }
  return undefined;
}

export async function rebuildAllRecurrenceClaims() {
  const rules = await rows('recurrence_rules');
  await run('DELETE FROM recurrence_instance_claims', [], false);
  for (const rule of rules) await rebuildClaimsForRule(rule);
}
