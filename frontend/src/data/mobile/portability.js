import {
  createUuid,
  insert,
  one,
  rows,
  run,
  update,
  withTransaction,
  withWriteLock,
} from './database.js';
import { mobileError, validationError } from './domain.js';
import { rebuildAllRecurrenceClaims } from './recurrence.js';

export const DATA_SCHEMA_VERSION = '0.8.0';
const SUPPORTED_SCHEMA_VERSIONS = new Set(['0.6.0', DATA_SCHEMA_VERSION]);
export const PORTABLE_ENTITY_ORDER = [
  'projects',
  'recurrence_rules',
  'recurrence_exceptions',
  'todos',
  'schedules',
  'daily_logs',
  'log_templates',
  'timer_sessions',
];

const ENTITY_FIELDS = {
  projects: ['name', 'description', 'status', 'ddl_date', 'color', 'completed_at', 'archived_at', 'created_at', 'updated_at'],
  recurrence_rules: ['entity_type', 'template_json', 'frequency', 'start_date', 'end_date', 'weekdays', 'month_day', 'status', 'created_at', 'updated_at'],
  recurrence_exceptions: ['entity_type', 'recurrence_date', 'action', 'created_at'],
  todos: ['name', 'position', 'ddl_type', 'ddl_date', 'reminder_days', 'category', 'status', 'waiting_reply_person', 'notes', 'is_completed', 'completed_at', 'recurrence_date', 'is_recurrence_exception', 'created_at', 'updated_at'],
  schedules: ['name', 'start_time', 'end_time', 'category', 'nature', 'relax_suggestion', 'location', 'notes', 'is_planned', 'recurrence_date', 'is_recurrence_exception', 'created_at', 'updated_at'],
  daily_logs: ['log_date', 'log_text', 'created_at', 'updated_at'],
  log_templates: ['name', 'content', 'created_at'],
  timer_sessions: ['name', 'status', 'started_at', 'last_resumed_at', 'paused_at', 'paused_seconds', 'ended_at', 'notes', 'created_at', 'updated_at'],
};

const REQUIRED_FIELDS = {
  projects: ['name'],
  recurrence_rules: ['entity_type', 'frequency', 'start_date'],
  recurrence_exceptions: ['entity_type', 'recurrence_date'],
  todos: ['name', 'ddl_type', 'category', 'status'],
  schedules: ['name', 'start_time', 'end_time', 'category', 'nature'],
  daily_logs: ['log_date'],
  log_templates: ['name'],
  timer_sessions: ['name', 'status', 'started_at'],
};

function uuidIsValid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function validateMode(mode) {
  if (!['merge', 'replace'].includes(mode)) throw validationError('mode 必须是 merge 或 replace');
  return mode;
}

function exceptionNaturalKey(item) {
  return `${item.recurrence_rule_uuid || ''}:${item.entity_type || ''}:${String(item.recurrence_date || '').slice(0, 10)}:${item.action || 'deleted'}`;
}

export function validateDataPackage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validationError('数据包必须是 JSON 对象');
  if (raw.app !== 'riji') throw validationError('不是日迹数据包');
  if (!SUPPORTED_SCHEMA_VERSIONS.has(raw.schema_version)) {
    throw validationError(`不支持的 schema_version：${raw.schema_version ?? 'null'}`);
  }
  if (!raw.entities || typeof raw.entities !== 'object' || Array.isArray(raw.entities)) throw validationError('数据包缺少 entities');
  const normalized = { ...raw, entities: {} };
  for (const table of PORTABLE_ENTITY_ORDER) {
    const incoming = raw.entities[table] ?? [];
    if (!Array.isArray(incoming)) throw validationError(`entities.${table} 必须是数组`);
    const seenUuids = new Set();
    const seenNaturalKeys = new Set();
    normalized.entities[table] = incoming.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw validationError(`entities.${table}[${index}] 必须是对象`);
      if (!uuidIsValid(item.uuid) || seenUuids.has(item.uuid)) throw validationError(`entities.${table} 含无效或重复 UUID`);
      const missing = REQUIRED_FIELDS[table].filter((field) => !Object.hasOwn(item, field));
      if (missing.length) throw validationError(`entities.${table}[${index}] 缺少字段：${missing.join(', ')}`);
      if (table === 'recurrence_exceptions') {
        if (!uuidIsValid(item.recurrence_rule_uuid)) throw validationError(`entities.${table}[${index}] 缺少有效 recurrence_rule_uuid`);
        const key = exceptionNaturalKey(item);
        if (seenNaturalKeys.has(key)) throw validationError(`entities.${table} 存在重复规则日期例外`);
        seenNaturalKeys.add(key);
      }
      seenUuids.add(item.uuid);
      return { ...item };
    });
  }
  return normalized;
}

function deduplicateExportExceptions(items, ruleUuids) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${ruleUuids.get(item.recurrence_rule_id) || ''}:${item.entity_type}:${item.recurrence_date}:${item.action || 'deleted'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function exportDataPackage() {
  const source = {};
  for (const table of PORTABLE_ENTITY_ORDER) source[table] = await rows(table);
  const maps = Object.fromEntries(PORTABLE_ENTITY_ORDER.map((table) => [
    table,
    new Map(source[table].map((item) => [item.id, item.uuid])),
  ]));
  source.recurrence_exceptions = deduplicateExportExceptions(source.recurrence_exceptions, maps.recurrence_rules);
  const entities = {};
  for (const table of PORTABLE_ENTITY_ORDER) {
    entities[table] = source[table].map((item) => {
      const output = { uuid: item.uuid };
      for (const field of ENTITY_FIELDS[table]) output[field] = item[field] ?? null;
      return output;
    });
  }
  source.recurrence_rules.forEach((item, index) => {
    entities.recurrence_rules[index].project_uuid = maps.projects.get(item.project_id) || null;
    entities.recurrence_rules[index].template_json = { ...(entities.recurrence_rules[index].template_json || {}) };
    delete entities.recurrence_rules[index].template_json.project_id;
  });
  source.recurrence_exceptions.forEach((item, index) => {
    entities.recurrence_exceptions[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null;
  });
  source.todos.forEach((item, index) => {
    entities.todos[index].project_uuid = maps.projects.get(item.project_id) || null;
    entities.todos[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null;
  });
  source.schedules.forEach((item, index) => {
    entities.schedules[index].project_uuid = maps.projects.get(item.project_id) || null;
    entities.schedules[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null;
    entities.schedules[index].linked_todo_uuids = (item.linked_todo_ids || []).map((id) => maps.todos.get(id)).filter(Boolean);
  });
  source.daily_logs.forEach((item, index) => {
    entities.daily_logs[index].completed_todo_uuids = (item.completed_todo_ids || []).map((id) => maps.todos.get(id)).filter(Boolean);
  });
  source.timer_sessions.forEach((item, index) => {
    entities.timer_sessions[index].project_uuid = maps.projects.get(item.project_id) || null;
    entities.timer_sessions[index].linked_todo_uuid = maps.todos.get(item.linked_todo_id) || null;
    entities.timer_sessions[index].created_schedule_uuid = maps.schedules.get(item.created_schedule_id) || null;
  });
  return {
    app: 'riji',
    schema_version: DATA_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    entities,
  };
}

async function existingRuleUuidMap() {
  return new Map((await rows('recurrence_rules')).map((rule) => [rule.id, rule.uuid]));
}

function matchesIncoming(table, local, incoming, ruleUuidById) {
  if (local.uuid === incoming.uuid) return true;
  if (table === 'daily_logs') return local.log_date === incoming.log_date;
  if (table === 'recurrence_exceptions') {
    return ruleUuidById.get(local.recurrence_rule_id) === incoming.recurrence_rule_uuid
      && local.entity_type === incoming.entity_type
      && String(local.recurrence_date).slice(0, 10) === String(incoming.recurrence_date).slice(0, 10)
      && (local.action || 'deleted') === (incoming.action || 'deleted');
  }
  return false;
}

export async function previewDataImport(raw, mode = 'merge') {
  validateMode(mode);
  const pack = validateDataPackage(raw);
  const ruleUuidById = await existingRuleUuidMap();
  const entities = {};
  for (const table of PORTABLE_ENTITY_ORDER) {
    const existing = await rows(table);
    const incoming = pack.entities[table];
    const matchedLocalIds = new Set();
    let updates = 0;
    for (const item of incoming) {
      const match = existing.find((local) => matchesIncoming(table, local, item, ruleUuidById));
      if (match) {
        updates += 1;
        matchedLocalIds.add(match.id);
      }
    }
    entities[table] = {
      total: incoming.length,
      create: incoming.length - updates,
      update: updates,
      delete: mode === 'replace' ? existing.length - matchedLocalIds.size : 0,
    };
  }
  return {
    app: pack.app,
    schema_version: pack.schema_version,
    exported_at: pack.exported_at,
    mode,
    conflict_policy: mode === 'replace' ? 'replace_local_data' : 'incoming_package_wins_by_uuid',
    entities,
    total: Object.values(entities).reduce((sum, item) => sum + item.total, 0),
    delete_total: Object.values(entities).reduce((sum, item) => sum + item.delete, 0),
  };
}

function resolveMap(maps, table, value, label = table) {
  if (!value) return null;
  const record = maps[table].get(String(value));
  if (!record) throw validationError(`数据包引用了不存在的 ${label} UUID：${value}`);
  return record.id;
}

async function upsertSimple(table, item) {
  let current = await one(table, 'uuid = ?', [item.uuid]);
  if (!current && table === 'daily_logs') current = await one(table, 'log_date = ?', [item.log_date]);
  const data = { uuid: item.uuid };
  for (const field of ENTITY_FIELDS[table]) if (Object.hasOwn(item, field)) data[field] = item[field];
  if (current) return { record: await update(table, current.id, data, false), created: false };
  return { record: await insert(table, data, false), created: true };
}

async function upsertException(item, maps) {
  const ruleId = resolveMap(maps, 'recurrence_rules', item.recurrence_rule_uuid, '重复规则');
  let current = await one('recurrence_exceptions', 'uuid = ?', [item.uuid]);
  if (!current) {
    current = await one(
      'recurrence_exceptions',
      'recurrence_rule_id = ? AND entity_type = ? AND recurrence_date = ? AND action = ?',
      [ruleId, item.entity_type, item.recurrence_date, item.action || 'deleted'],
    );
  }
  const data = { uuid: item.uuid, recurrence_rule_id: ruleId };
  for (const field of ENTITY_FIELDS.recurrence_exceptions) if (Object.hasOwn(item, field)) data[field] = item[field];
  if (!Object.hasOwn(data, 'action') || !data.action) data.action = 'deleted';
  if (!Object.hasOwn(data, 'created_at') || !data.created_at) data.created_at = new Date().toISOString();
  if (current) return { record: await update('recurrence_exceptions', current.id, data, false), created: false };
  return { record: await insert('recurrence_exceptions', data, false), created: true };
}

async function rebuildActiveTimerClaim() {
  await run('DELETE FROM active_timer_claim', [], false);
  const active = await rows('timer_sessions', "status IN ('running', 'paused')", [], 'created_at DESC, id DESC');
  if (active[0]) {
    await run(
      'INSERT INTO active_timer_claim(singleton, timer_uuid, updated_at) VALUES (1, ?, ?)',
      [active[0].uuid, new Date().toISOString()],
      false,
    );
  }
}

export async function importDataPackage(raw, mode = 'merge') {
  validateMode(mode);
  const pack = validateDataPackage(raw);
  return withWriteLock(() => withTransaction(async () => {
    const maps = Object.fromEntries(PORTABLE_ENTITY_ORDER.map((table) => [table, new Map()]));
    const result = Object.fromEntries(PORTABLE_ENTITY_ORDER.map((table) => [table, { created: 0, updated: 0 }]));
    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const table of PORTABLE_ENTITY_ORDER) {
      for (const item of pack.entities[table]) {
        const outcome = table === 'recurrence_exceptions'
          ? await upsertException(item, maps)
          : await upsertSimple(table, item);
        maps[table].set(item.uuid, outcome.record);
        if (outcome.created) {
          result[table].created += 1;
          created += 1;
        } else {
          result[table].updated += 1;
          updated += 1;
        }
      }
    }
    for (const item of pack.entities.recurrence_rules) {
      const record = maps.recurrence_rules.get(item.uuid);
      const template = { ...(record.template_json || {}) };
      delete template.project_id;
      await update('recurrence_rules', record.id, {
        project_id: resolveMap(maps, 'projects', item.project_uuid, '项目'),
        template_json: template,
      }, false);
    }
    for (const item of pack.entities.todos) {
      await update('todos', maps.todos.get(item.uuid).id, {
        project_id: resolveMap(maps, 'projects', item.project_uuid, '项目'),
        recurrence_rule_id: resolveMap(maps, 'recurrence_rules', item.recurrence_rule_uuid, '重复规则'),
      }, false);
    }
    for (const item of pack.entities.schedules) {
      await update('schedules', maps.schedules.get(item.uuid).id, {
        project_id: resolveMap(maps, 'projects', item.project_uuid, '项目'),
        recurrence_rule_id: resolveMap(maps, 'recurrence_rules', item.recurrence_rule_uuid, '重复规则'),
        linked_todo_ids: (item.linked_todo_uuids || []).map((value) => resolveMap(maps, 'todos', value, '待办')),
      }, false);
    }
    for (const item of pack.entities.daily_logs) {
      await update('daily_logs', maps.daily_logs.get(item.uuid).id, {
        completed_todo_ids: (item.completed_todo_uuids || []).map((value) => resolveMap(maps, 'todos', value, '待办')),
      }, false);
    }
    for (const item of pack.entities.timer_sessions) {
      await update('timer_sessions', maps.timer_sessions.get(item.uuid).id, {
        project_id: resolveMap(maps, 'projects', item.project_uuid, '项目'),
        linked_todo_id: resolveMap(maps, 'todos', item.linked_todo_uuid, '待办'),
        created_schedule_id: resolveMap(maps, 'schedules', item.created_schedule_uuid, '日程'),
      }, false);
    }
    if (mode === 'replace') {
      for (const table of [...PORTABLE_ENTITY_ORDER].reverse()) {
        const keepIds = new Set([...maps[table].values()].map((record) => record.id));
        const removeIds = (await rows(table)).map((record) => record.id).filter((id) => !keepIds.has(id));
        if (!removeIds.length) continue;
        if (table === 'todos' || table === 'schedules') {
          const type = table === 'todos' ? 'todo' : 'schedule';
          await run(
            `DELETE FROM external_items WHERE entity_type = ? AND local_entity_id IN (${removeIds.map(() => '?').join(', ')})`,
            [type, ...removeIds],
            false,
          );
        }
        await run(`DELETE FROM ${table} WHERE id IN (${removeIds.map(() => '?').join(', ')})`, removeIds, false);
        deleted += removeIds.length;
      }
    }
    await rebuildAllRecurrenceClaims();
    await rebuildActiveTimerClaim();
    return {
      schema_version: DATA_SCHEMA_VERSION,
      mode,
      conflict_policy: mode === 'replace' ? 'replace_local_data' : 'incoming_package_wins_by_uuid',
      entities: result,
      created,
      updated,
      deleted,
    };
  })).catch((error) => {
    if (error?.code) throw error;
    throw mobileError(422, 'IMPORT_FAILED', error?.message || '导入失败');
  });
}

export async function portabilityRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/data/export') return exportDataPackage();
  if (method === 'POST' && pathname === '/data/import/preview') return previewDataImport(body.package, body.mode || 'merge');
  if (method === 'POST' && pathname === '/data/import') return importDataPackage(body.package, body.mode || 'merge');
  return undefined;
}

export function createEmptyDataPackage() {
  return {
    app: 'riji',
    schema_version: DATA_SCHEMA_VERSION,
    entities: Object.fromEntries(PORTABLE_ENTITY_ORDER.map((table) => [table, []])),
    exported_at: new Date().toISOString(),
    package_uuid: createUuid(),
  };
}
