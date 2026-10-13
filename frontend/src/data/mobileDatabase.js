import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

import { createSyncRoutes, createWebdavProtocol } from '../platform/webdavSync.js';
import { buildMergePlan, canonical } from './mergePlan.js';
import { createScheduleLinkRepair } from './scheduleLinkRepair.js';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

const connection = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'riji';
const SCHEMA_VERSION = '0.10.0';
const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_VERSION, '0.8.0', '0.6.0'];
let databasePromise;
let databaseOverride = null;

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', ddl_date TEXT,
  color TEXT, completed_at TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recurrence_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
  template_json TEXT NOT NULL DEFAULT '{}', frequency TEXT NOT NULL, start_date TEXT NOT NULL,
  end_date TEXT, weekdays TEXT, month_day INTEGER, project_id INTEGER, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, project_id INTEGER,
  position INTEGER,
  recurrence_rule_id INTEGER, recurrence_date TEXT, is_recurrence_exception INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL, ddl_type TEXT NOT NULL DEFAULT 'none', ddl_date TEXT, reminder_days INTEGER,
  category TEXT NOT NULL DEFAULT '任务', status TEXT NOT NULL DEFAULT 'not_focusing',
  waiting_reply_person TEXT, notes TEXT NOT NULL DEFAULT '', is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recurrence_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  recurrence_rule_id INTEGER NOT NULL, entity_type TEXT NOT NULL,
  recurrence_date TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'deleted',
  created_at TEXT NOT NULL,
  UNIQUE(recurrence_rule_id, entity_type, recurrence_date)
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, project_id INTEGER,
  recurrence_rule_id INTEGER, recurrence_date TEXT, is_recurrence_exception INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, category TEXT NOT NULL DEFAULT '普通日程',
  nature TEXT NOT NULL DEFAULT 'no_other_task', relax_suggestion TEXT, linked_todo_ids TEXT NOT NULL DEFAULT '[]',
  location TEXT, notes TEXT NOT NULL DEFAULT '', is_planned INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS time_block_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS time_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, block_date TEXT NOT NULL,
  start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL, granularity INTEGER NOT NULL,
  category_id INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', linked_todo_id INTEGER,
  manual_project_id INTEGER, source TEXT NOT NULL DEFAULT 'manual', source_timer_id INTEGER,
  coverage_seconds INTEGER, origin_uuid TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_time_blocks_date ON time_blocks(block_date, start_minute);
CREATE TABLE IF NOT EXISTS daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, log_date TEXT NOT NULL UNIQUE,
  completed_todo_ids TEXT NOT NULL DEFAULT '[]', log_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timer_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', is_parked INTEGER NOT NULL DEFAULT 0, project_id INTEGER, linked_todo_id INTEGER,
  started_at TEXT NOT NULL, last_resumed_at TEXT, paused_at TEXT, paused_seconds INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT, created_schedule_id INTEGER, active_intervals TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_uuid ON projects(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_uuid ON todos(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_uuid ON schedules(uuid);
CREATE TABLE IF NOT EXISTS webdav_config (
  id INTEGER PRIMARY KEY CHECK (id = 1), uuid TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  remote_directory TEXT NOT NULL DEFAULT 'daytrace',
  remote_filename TEXT NOT NULL DEFAULT 'daytrace-latest.json',
  remember_password INTEGER NOT NULL DEFAULT 0,
  allow_insecure_http INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT, last_success_at TEXT, last_download_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'idle', last_error TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '', last_remote_etag TEXT,
  last_remote_modified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const jsonColumns = new Set(['template_json', 'weekdays', 'linked_todo_ids', 'completed_todo_ids', 'active_intervals']);
const booleanColumns = new Set(['is_recurrence_exception', 'is_completed', 'is_planned', 'is_parked', 'remember_password', 'allow_insecure_http']);
const entitySpecs = {
  projects: ['name', 'description', 'status', 'ddl_date', 'color', 'completed_at', 'archived_at', 'created_at', 'updated_at'],
  recurrence_rules: ['entity_type', 'template_json', 'frequency', 'start_date', 'end_date', 'weekdays', 'month_day', 'status', 'created_at', 'updated_at'],
  recurrence_exceptions: ['entity_type', 'recurrence_date', 'action', 'created_at'],
  todos: ['name', 'position', 'ddl_type', 'ddl_date', 'reminder_days', 'category', 'status', 'waiting_reply_person', 'notes', 'is_completed', 'completed_at', 'recurrence_date', 'is_recurrence_exception', 'created_at', 'updated_at'],
  schedules: ['name', 'start_time', 'end_time', 'category', 'nature', 'relax_suggestion', 'location', 'notes', 'is_planned', 'recurrence_date', 'is_recurrence_exception', 'created_at', 'updated_at'],
  time_block_categories: ['name', 'color', 'created_at', 'updated_at'],
  time_blocks: ['block_date', 'start_minute', 'end_minute', 'granularity', 'category_id', 'notes', 'source', 'coverage_seconds', 'origin_uuid', 'created_at', 'updated_at'],
  daily_logs: ['log_date', 'log_text', 'created_at', 'updated_at'],
  log_templates: ['name', 'content', 'created_at'],
  timer_sessions: ['name', 'status', 'started_at', 'last_resumed_at', 'paused_at', 'paused_seconds', 'active_intervals', 'ended_at', 'notes', 'is_parked', 'created_at', 'updated_at'],
};
const entityOrder = Object.keys(entitySpecs);
const requiredFields = {
  projects: ['name'], recurrence_rules: ['entity_type', 'frequency', 'start_date'],
  recurrence_exceptions: ['entity_type', 'recurrence_date', 'recurrence_rule_uuid'],
  todos: ['name', 'ddl_type', 'category', 'status'],
  schedules: ['name', 'start_time', 'end_time', 'category', 'nature'],
  time_block_categories: ['name', 'color'], time_blocks: ['block_date', 'start_minute', 'end_minute', 'granularity', 'category_uuid'],
  daily_logs: ['log_date'], log_templates: ['name'], timer_sessions: ['name', 'status', 'started_at'],
};

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function now() {
  return new Date().toISOString();
}

function beijingNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/Z$/, '');
}

function parseDateTime(value) {
  if (!value) return new Date(Number.NaN);
  const text = String(value);
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return new Date(text);
  return new Date(`${text.length === 10 ? `${text}T00:00:00` : text}+08:00`);
}

function compareTodoPriority(left, right) {
  if (left.position != null || right.position != null) {
    if (left.position == null) return 1;
    if (right.position == null) return -1;
    const positionDifference = Number(left.position) - Number(right.position);
    if (positionDifference) return positionDifference;
  }
  if (left.ddl_date && right.ddl_date) {
    const ddlDifference = parseDateTime(left.ddl_date) - parseDateTime(right.ddl_date);
    if (ddlDifference) return ddlDifference;
  } else if (left.ddl_date) return -1;
  else if (right.ddl_date) return 1;
  return String(left.created_at).localeCompare(String(right.created_at)) || Number(left.id) - Number(right.id);
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

async function ensureRuntimeColumns(db) {
  const todoColumns = await db.query('PRAGMA table_info(todos)');
  if (!(todoColumns.values || []).some(column => column.name === 'position')) {
    await db.execute('ALTER TABLE todos ADD COLUMN position INTEGER');
  }
  const timerColumns = await db.query('PRAGMA table_info(timer_sessions)');
  if (!(timerColumns.values || []).some(column => column.name === 'is_parked')) {
    await db.execute('ALTER TABLE timer_sessions ADD COLUMN is_parked INTEGER NOT NULL DEFAULT 0');
  }
  const blockColumns = await db.query('PRAGMA table_info(time_blocks)');
  if (!(blockColumns.values || []).some(column => column.name === 'origin_uuid')) {
    await db.execute('ALTER TABLE time_blocks ADD COLUMN origin_uuid TEXT');
  }
  if (!(timerColumns.values || []).some(column => column.name === 'active_intervals')) {
    await db.execute("ALTER TABLE timer_sessions ADD COLUMN active_intervals TEXT NOT NULL DEFAULT '[]'");
  }
  const webdavColumns = await db.query('PRAGMA table_info(webdav_config)');
  if (!(webdavColumns.values || []).some(column => column.name === 'password')) {
    await db.execute("ALTER TABLE webdav_config ADD COLUMN password TEXT NOT NULL DEFAULT ''");
  }
}

async function getDatabase() {
  if (databaseOverride) return databaseOverride;
  if (!databasePromise) {
    databasePromise = (async () => {
      const consistency = await connection.checkConnectionsConsistency();
      const connected = await connection.isConnection(DB_NAME, false);
      let db;
      if (consistency.result && connected.result) {
        db = await connection.retrieveConnection(DB_NAME, false);
      } else {
        db = await connection.createConnection(DB_NAME, false, 'no-encryption', 1, false);
      }
      await db.open();
      await db.execute(schema);
      await ensureRuntimeColumns(db);
      const categoryCount = await db.query('SELECT COUNT(*) AS count FROM time_block_categories');
      if (!Number(categoryCount.values?.[0]?.count)) {
        const defaults = [['学习', '#347f88'], ['娱乐', '#d89b50'], ['运动', '#4c9b67'], ['开发', '#536fba'], ['休息', '#8a85a9']];
        for (const [name, color] of defaults) {
          await db.run('INSERT OR IGNORE INTO time_block_categories (uuid, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [uuid(), name, color, beijingNow(), beijingNow()], false);
        }
      }
      return db;
    })();
  }
  return databasePromise;
}

async function query(sql, values = []) {
  const db = await getDatabase();
  const result = await db.query(sql, values);
  return result.values || [];
}

async function run(sql, values = [], transaction = true) {
  const db = await getDatabase();
  return db.run(sql, values, transaction);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeRow(table, row) {
  const result = { ...row };
  for (const key of jsonColumns) if (key in result) result[key] = key === 'weekdays' && result[key] == null ? null : parseJson(result[key], key === 'template_json' ? {} : []);
  for (const key of booleanColumns) if (key in result) result[key] = Boolean(result[key]);
  if (table === 'todos') {
    result.is_hard_ddl_near = ddlNear(result, 'hard');
    result.is_soft_ddl_near = ddlNear(result, 'soft');
  }
  if (table === 'timer_sessions') result.elapsed_seconds = elapsedSeconds(result);
  return result;
}

function ddlNear(todo, type) {
  if (todo.ddl_type !== type || !todo.ddl_date || todo.reminder_days == null || todo.is_completed) return false;
  return parseDateTime(todo.ddl_date).getTime() - Date.now() <= Number(todo.reminder_days) * 86400000;
}

function elapsedSeconds(timer) {
  const end = timer.ended_at ? parseDateTime(timer.ended_at) : new Date();
  let paused = Number(timer.paused_seconds || 0);
  if (timer.status === 'paused' && timer.paused_at) paused += Math.max(0, (end - parseDateTime(timer.paused_at)) / 1000);
  return Math.max(0, Math.floor((end - parseDateTime(timer.started_at)) / 1000 - paused));
}

async function rows(table, where = '', values = [], order = 'id ASC') {
  const found = await query(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ${order}`, values);
  return found.map((item) => normalizeRow(table, item));
}

async function one(table, where, values = []) {
  const found = await query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, values);
  return found[0] ? normalizeRow(table, found[0]) : null;
}

function dbValue(key, value) {
  if (key === 'weekdays' && value == null) return null;
  if (jsonColumns.has(key)) return JSON.stringify(value ?? (key === 'template_json' ? {} : []));
  if (booleanColumns.has(key)) return value ? 1 : 0;
  return value ?? null;
}

async function insert(table, data, transaction = true) {
  const columns = Object.keys(data);
  const result = await run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((key) => dbValue(key, data[key])),
    transaction,
  );
  return one(table, 'id = ?', [result.changes?.lastId]);
}

async function update(table, id, data, transaction = true) {
  const columns = Object.keys(data).filter((key) => data[key] !== undefined);
  if (!columns.length) return one(table, 'id = ?', [id]);
  await run(`UPDATE ${table} SET ${columns.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((key) => dbValue(key, data[key])), id,
  ], transaction);
  return one(table, 'id = ?', [id]);
}

function projectOutput(project, todos = [], schedules = []) {
  const completed = todos.filter((item) => item.is_completed).length;
  const nextTodo = todos
    .filter((item) => !item.is_completed)
    .sort(compareTodoPriority)[0] || null;
  return {
    ...project,
    todo_count: todos.length,
    completed_todo_count: completed,
    progress: todos.length ? completed / todos.length : null,
    next_todo: nextTodo,
    recent_schedules: schedules.slice(0, 3),
  };
}

async function projectWithOverview(project) {
  if (!project) return null;
  const todos = (await rows('todos', 'project_id = ?', [project.id], 'created_at DESC')).sort(compareTodoPriority);
  const schedules = await rows('schedules', 'project_id = ? AND is_planned = 1', [project.id], 'start_time DESC');
  return projectOutput(project, todos, schedules);
}

async function projectsRequest(method, pathname, params, body) {
  const match = pathname.match(/^\/projects\/(\d+)(?:\/overview)?$/);
  if (method === 'GET' && pathname === '/projects/') {
    const clauses = []; const values = [];
    if (params.get('status')) { clauses.push('status = ?'); values.push(params.get('status')); }
    else if (params.get('include_hidden') !== 'true') clauses.push("status NOT IN ('archived', 'canceled')");
    const found = await rows('projects', clauses.join(' AND '), values, 'updated_at DESC');
    return Promise.all(found.map(projectWithOverview));
  }
  if (method === 'POST' && pathname === '/projects/') {
    const stamp = now();
    return projectWithOverview(await insert('projects', {
      uuid: uuid(), name: body.name, description: body.description || '', status: body.status || 'active',
      ddl_date: body.ddl_date || null, color: body.color || null,
      completed_at: body.status === 'completed' ? stamp : null,
      archived_at: body.status === 'archived' ? stamp : null, created_at: stamp, updated_at: stamp,
    }));
  }
  if (!match) return undefined;
  const id = Number(match[1]);
  const current = await one('projects', 'id = ?', [id]);
  if (!current) throw new Error('项目不存在');
  if (method === 'GET' && pathname.endsWith('/overview')) {
    const project = await projectWithOverview(current);
    const todos = (await rows('todos', 'project_id = ?', [id], 'created_at DESC')).sort(compareTodoPriority);
    const schedules = await rows('schedules', 'project_id = ? AND is_planned = 1', [id], 'start_time ASC');
    return { project, todos, schedules, progress: project.progress, todo_count: project.todo_count, completed_todo_count: project.completed_todo_count, next_todo: project.next_todo, recent_schedules: project.recent_schedules };
  }
  if (method === 'GET') return projectWithOverview(current);
  if (method === 'PUT') {
    const stamp = now();
    if ('status' in body) {
      body.completed_at = body.status === 'completed' ? (current.completed_at || stamp) : null;
      body.archived_at = body.status === 'archived' ? (current.archived_at || stamp) : null;
    }
    return projectWithOverview(await update('projects', id, { ...body, updated_at: stamp }));
  }
  if (method === 'DELETE') {
    return deleteWithReferences('projects',id);
  }
}

function normalizeTodoInput(body, existing = {}) {
  const data = { ...body };
  const ddlType = data.ddl_type ?? existing.ddl_type ?? 'none';
  if (ddlType === 'none') {
    data.ddl_date = null; data.reminder_days = null;
    if (!data.category || data.category === '任务') data.category = '计划箱';
  } else if (!data.category || data.category === '计划箱') data.category = '任务';
  const status = data.status ?? existing.status ?? 'not_focusing';
  if (status !== 'waiting_reply') data.waiting_reply_person = null;
  return data;
}

async function ensureFocusLimit(excludeId = null) {
  const values = excludeId ? [excludeId] : [];
  const found = await query(`SELECT COUNT(*) AS count FROM todos WHERE status = 'focusing' AND is_completed = 0${excludeId ? ' AND id != ?' : ''}`, values);
  if (Number(found[0]?.count || 0) >= 3) throw new Error('关注中的待办最多 3 个');
}

async function todosRequest(method, pathname, params, body) {
  if (method === 'GET' && ['/todos/', '/todos/focusing', '/todos/waiting-reply', '/todos/ddl-near'].includes(pathname)) {
    const clauses = []; const values = [];
    if (pathname === '/todos/focusing') clauses.push("status = 'focusing'", 'is_completed = 0');
    if (pathname === '/todos/waiting-reply') clauses.push("status = 'waiting_reply'", 'is_completed = 0');
    for (const [key, column] of [['category', 'category'], ['status', 'status'], ['project_id', 'project_id']]) {
      if (params.has(key)) { clauses.push(`${column} = ?`); values.push(params.get(key)); }
    }
    if (params.has('is_completed')) { clauses.push('is_completed = ?'); values.push(params.get('is_completed') === 'true' ? 1 : 0); }
    const found = await rows('todos', clauses.join(' AND '), values, 'created_at DESC');
    return pathname === '/todos/ddl-near' ? found.filter((item) => item.is_hard_ddl_near || item.is_soft_ddl_near) : found;
  }
  if (method === 'POST' && pathname === '/todos/') {
    const data = normalizeTodoInput(body);
    if ((data.status || 'not_focusing') === 'focusing') await ensureFocusLimit();
    const stamp = now();
    return insert('todos', {
      uuid: uuid(), project_id: data.project_id ?? null, recurrence_rule_id: null, recurrence_date: null,
      position: data.position ?? null,
      is_recurrence_exception: false, name: data.name, ddl_type: data.ddl_type || 'none', ddl_date: data.ddl_date || null,
      reminder_days: data.reminder_days ?? null, category: data.category || '任务', status: data.status || 'not_focusing',
      waiting_reply_person: data.waiting_reply_person || null, notes: data.notes || '', is_completed: false,
      completed_at: null, created_at: stamp, updated_at: stamp,
    });
  }
  const completeMatch = pathname.match(/^\/todos\/(\d+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const id = Number(completeMatch[1]);
    const db = await getDatabase();
    await db.beginTransaction();
    try {
      const current = await one('todos', 'id = ?', [id]);
      if (!current) throw new Error('待办不存在');
      const stamp = beijingNow();
      await update('todos', id, { is_completed: true, completed_at: current.completed_at || stamp, updated_at: stamp }, false);

      const logDate = body.log_date;
      const log = await one('daily_logs', 'log_date = ?', [logDate]);
      if (log) {
        const completedIds = Array.from(new Set([...(log.completed_todo_ids || []), id]));
        await update('daily_logs', log.id, { completed_todo_ids: completedIds, updated_at: stamp }, false);
      } else {
        await insert('daily_logs', {
          uuid: uuid(), log_date: logDate, completed_todo_ids: [id], log_text: '', created_at: stamp, updated_at: stamp,
        }, false);
      }
      await db.commitTransaction();
      return one('todos', 'id = ?', [id]);
    } catch (error) {
      await db.rollbackTransaction();
      throw error;
    }
  }
  const match = pathname.match(/^\/todos\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  const current = await one('todos', 'id = ?', [id]);
  if (!current) throw new Error('待办不存在');
  if (method === 'GET') { if (!current.is_planned) throw new Error('日程不存在'); return current; }
  if (method === 'PUT') {
    const data = normalizeTodoInput(body, current);
    if (data.status === 'focusing') await ensureFocusLimit(id);
    if (data.is_completed === true && !data.completed_at) data.completed_at = now();
    if (data.is_completed === false) data.completed_at = null;
    if (current.recurrence_rule_id && Object.keys(data).some((key) => !['is_completed', 'completed_at'].includes(key))) data.is_recurrence_exception = true;
    return update('todos', id, { ...data, updated_at: now() });
  }
  if (method === 'DELETE') return deleteWithReferences('todos',id);
}

async function schedulesRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/schedules/current') {
    const stamp = Date.now();
    const found = await rows('schedules', 'is_planned = 1', [], 'start_time ASC');
    return found.find((item) => parseDateTime(item.start_time).getTime() <= stamp && parseDateTime(item.end_time).getTime() > stamp) || null;
  }
  if (method === 'GET' && (pathname === '/schedules/' || pathname === '/schedules/week/')) {
    if (params.get('is_planned') === 'false') return [];
    const clauses = ['is_planned = 1']; const values = [];
    if (params.has('project_id')) { clauses.push('project_id = ?'); values.push(params.get('project_id')); }
    const found = await rows('schedules', clauses.join(' AND '), values, 'start_time ASC');
    const dateFrom = params.has('date_from') ? parseDateTime(params.get('date_from')).getTime() : null;
    const dateTo = params.has('date_to') ? parseDateTime(params.get('date_to')).getTime() : null;
    return found.filter((item) => {
      const start = parseDateTime(item.start_time).getTime();
      const end = parseDateTime(item.end_time).getTime();
      return (dateFrom == null || end > dateFrom) && (dateTo == null || start < dateTo);
    });
  }
  if (method === 'POST' && pathname === '/schedules/') {
    if (body.is_planned === false) throw new Error('实际记录请使用时间块');
    if (new Date(body.end_time) <= new Date(body.start_time)) throw new Error('结束时间必须晚于开始时间');
    const stamp = now();
    return insert('schedules', {
      uuid: uuid(), project_id: body.project_id ?? null, recurrence_rule_id: null, recurrence_date: null,
      is_recurrence_exception: false, name: body.name, start_time: body.start_time, end_time: body.end_time,
      category: body.category || '普通日程', nature: body.nature || 'no_other_task', relax_suggestion: body.relax_suggestion || null,
      linked_todo_ids: body.linked_todo_ids || [], location: body.location || null, notes: body.notes || '',
      is_planned: body.is_planned !== false, created_at: stamp, updated_at: stamp,
    });
  }
  const match = pathname.match(/^\/schedules\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  const current = await one('schedules', 'id = ?', [id]);
  if (!current) throw new Error('日程不存在');
  if (method === 'GET') return current;
  if (method === 'PUT') {
    if (!current.is_planned || body.is_planned === false) throw new Error('实际记录请使用时间块');
    const start = body.start_time || current.start_time; const end = body.end_time || current.end_time;
    if (new Date(end) <= new Date(start)) throw new Error('结束时间必须晚于开始时间');
    const data = { ...body, updated_at: now() };
    if (current.recurrence_rule_id && Object.keys(body).length) data.is_recurrence_exception = true;
    return update('schedules', id, data);
  }
  if (method === 'DELETE') return deleteWithReferences('schedules',id);
}

async function blockRows(where, values = [], order = 'b.block_date ASC, b.start_minute ASC') {
  const found = await query(
    'SELECT b.*, t.project_id AS todo_project_id FROM time_blocks b LEFT JOIN todos t ON t.id = b.linked_todo_id' +
      (where ? ' WHERE ' + where : '') + ' ORDER BY ' + order,
    values,
  );
  return found.map(row => {
    const { todo_project_id: todoProjectId, ...block } = normalizeRow('time_blocks', row);
    return { ...block, project_id: block.linked_todo_id ? todoProjectId ?? null : block.manual_project_id };
  });
}

async function timeBlocksRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/time-blocks/categories') {
    return rows('time_block_categories', '', [], 'id ASC');
  }
  if (method === 'POST' && pathname === '/time-blocks/categories') {
    if (!body.name?.trim() || !/^#[0-9a-f]{6}$/i.test(body.color)) throw new Error('属性名称或颜色无效');
    if (await one('time_block_categories', 'name = ?', [body.name.trim()])) throw new Error('属性名称已存在');
    const stamp = beijingNow();
    return insert('time_block_categories', { uuid: uuid(), name: body.name.trim(), color: body.color, created_at: stamp, updated_at: stamp });
  }
  const categoryMatch = pathname.match(/^\/time-blocks\/categories\/(\d+)$/);
  if (categoryMatch) {
    const id = Number(categoryMatch[1]);
    const current = await one('time_block_categories', 'id = ?', [id]);
    if (!current) throw new Error('属性分类不存在');
    if (method === 'PUT') {
      if (!body.name?.trim() || !/^#[0-9a-f]{6}$/i.test(body.color)) throw new Error('属性名称或颜色无效');
      const duplicate = await one('time_block_categories', 'name = ? AND id != ?', [body.name.trim(), id]);
      if (duplicate) throw new Error('属性名称已存在');
      return update('time_block_categories', id, { name: body.name.trim(), color: body.color, updated_at: beijingNow() });
    }
    if (method === 'DELETE') {
      if (await one('time_blocks', 'category_id = ?', [id])) throw new Error('该属性已有时间块，不能删除');
      await run('DELETE FROM time_block_categories WHERE id = ?', [id]);
      return null;
    }
  }
  if (method === 'GET' && pathname === '/time-blocks/') {
    const from = params.get('date_from');
    const to = params.get('date_to') || from;
    if (!from || !to || to < from || (parseDateTime(to + 'T00:00:00') - parseDateTime(from + 'T00:00:00')) / 86400000 > 45) throw new Error('日期范围无效');
    return blockRows('b.block_date >= ? AND b.block_date <= ?', [from, to]);
  }
  if (method === 'PUT' && pathname === '/time-blocks/range') {
    const { block_date: date, start_minute: start, end_minute: end, blocks = [] } = body;
    if (!date || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start || start % 15 || end % 15) throw new Error('时间范围无效');
    let previous = start;
    for (const block of [...blocks].sort((a, b) => a.start_minute - b.start_minute)) {
      if (![15, 30].includes(block.granularity) || block.start_minute % block.granularity ||
          block.end_minute - block.start_minute !== block.granularity ||
          block.start_minute < start || block.end_minute > end || block.start_minute < previous ||
          !['manual', 'timer'].includes(block.source || 'manual')) throw new Error('时间块不连续或粒度无效');
      if (!await one('time_block_categories', 'id = ?', [block.category_id])) throw new Error('属性分类不存在');
      if (block.linked_todo_id && !await one('todos', 'id = ?', [block.linked_todo_id])) throw new Error('关联待办不存在');
      if (!block.linked_todo_id && block.manual_project_id && !await one('projects', 'id = ?', [block.manual_project_id])) throw new Error('关联项目不存在');
      previous = block.end_minute;
    }
    const db = await getDatabase();
    await db.beginTransaction();
    try {
      const existing = await rows('time_blocks', 'block_date = ? AND start_minute < ? AND end_minute > ?', [date, end, start]);
      for (const old of existing) {
        await run('DELETE FROM time_blocks WHERE id = ?', [old.id], false);
        for (const [a, b] of [[old.start_minute, Math.min(old.end_minute, start)], [Math.max(old.start_minute, end), old.end_minute]]) {
          for (let minute = a; minute + 15 <= b; minute += 15) {
            await insert('time_blocks', { ...Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'id' && key !== 'project_id')), uuid: uuid(), start_minute: minute,
              end_minute: minute + 15, granularity: 15,
              coverage_seconds: old.coverage_seconds == null ? null : Math.min(old.coverage_seconds, 900) }, false);
          }
        }
      }
      for (const block of blocks) {
        const stamp = beijingNow();
        await insert('time_blocks', { uuid: uuid(), block_date: date, start_minute: block.start_minute,
          end_minute: block.end_minute, granularity: block.granularity, category_id: block.category_id,
          notes: block.notes || '', linked_todo_id: block.linked_todo_id || null,
          manual_project_id: block.linked_todo_id ? null : block.manual_project_id || null,
          source: block.source || 'manual', source_timer_id: block.source_timer_id || null,
          coverage_seconds: block.coverage_seconds ?? null, created_at: stamp, updated_at: stamp }, false);
      }
      await db.commitTransaction();
    } catch (error) { await db.rollbackTransaction(); throw error; }
    return timeBlocksRequest('GET', '/time-blocks/', new URLSearchParams({ date_from: date }), {});
  }
  const timerMatch = pathname.match(/^\/time-blocks\/from-timer\/(\d+)$/);
  if (method === 'POST' && timerMatch) {
    const timer = await one('timer_sessions', 'id = ?', [Number(timerMatch[1])]);
    if (!timer || timer.status !== 'completed') throw new Error('只能折算已结束的计时');
    if (![15, 30].includes(body.granularity)) throw new Error('粒度必须为 15 或 30 分钟');
    if (!await one('time_block_categories', 'id = ?', [body.category_id])) throw new Error('属性分类不存在');
    if (!timer.active_intervals?.length && timer.paused_seconds) throw new Error('旧计时缺少暂停分段，无法准确折算；可在日程页手动补录');
    const intervals = timer.active_intervals?.length ? timer.active_intervals : [[timer.started_at, timer.ended_at]];
    const coverage = new Map();
    for (const [rawStart, rawEnd] of intervals) {
      const start = parseDateTime(rawStart).getTime();
      const end = parseDateTime(rawEnd).getTime();
      if (end <= start) continue;
      for (let dayMs = Math.floor((start + 28800000) / 86400000) * 86400000 - 28800000; dayMs < end; dayMs += 86400000) {
        const date = new Date(dayMs + 28800000).toISOString().slice(0, 10);
        for (let minute = 0; minute < 1440; minute += body.granularity) {
          const seconds = Math.max(0, Math.floor((Math.min(end, dayMs + (minute + body.granularity) * 60000) -
            Math.max(start, dayMs + minute * 60000)) / 1000));
          if (seconds) {
            const key = date + ':' + minute;
            coverage.set(key, (coverage.get(key) || 0) + seconds);
          }
        }
      }
    }
    const db = await getDatabase();
    await db.beginTransaction();
    try {
    for (const [key, seconds] of coverage) {
      if (seconds * 2 < body.granularity * 60) continue;
      const [date, minuteText] = key.split(':');
      const minute = Number(minuteText);
      const existing = await rows('time_blocks', 'block_date = ? AND start_minute < ? AND end_minute > ?',
        [date, minute + body.granularity, minute]);
      if (existing.some(block => block.source !== 'timer' || (block.coverage_seconds || 0) >= seconds)) continue;
      for (const block of existing) {
        await run('DELETE FROM time_blocks WHERE id = ?', [block.id], false);
        for (const [a, b] of [[block.start_minute, Math.min(block.end_minute, minute)],
          [Math.max(block.start_minute, minute + body.granularity), block.end_minute]]) {
          for (let fragment = a; fragment + 15 <= b; fragment += 15) {
            await insert('time_blocks', { ...Object.fromEntries(Object.entries(block).filter(([field]) => field !== 'id' && field !== 'project_id')),
              uuid: uuid(), start_minute: fragment, end_minute: fragment + 15, granularity: 15,
              coverage_seconds: Math.min(block.coverage_seconds || 0, 900) }, false);
          }
        }
      }
      const stamp = beijingNow();
      await insert('time_blocks', { uuid: uuid(), block_date: date, start_minute: minute,
        end_minute: minute + body.granularity, granularity: body.granularity,
        category_id: body.category_id, notes: timer.name + (timer.notes ? ' · ' + timer.notes : ''),
        linked_todo_id: timer.linked_todo_id, manual_project_id: timer.linked_todo_id ? null : timer.project_id,
        source: 'timer', source_timer_id: timer.id, coverage_seconds: seconds,
        created_at: stamp, updated_at: stamp }, false);
    }
    await db.commitTransaction();
    } catch (error) { await db.rollbackTransaction(); throw error; }
    return blockRows('b.source_timer_id = ?', [timer.id]);
  }
  return undefined;
}

async function logsRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/logs/') {
    const clauses = []; const values = [];
    if (params.has('date_from')) { clauses.push('log_date >= ?'); values.push(params.get('date_from')); }
    if (params.has('date_to')) { clauses.push('log_date <= ?'); values.push(params.get('date_to')); }
    return rows('daily_logs', clauses.join(' AND '), values, 'log_date DESC');
  }
  if (method === 'GET' && pathname.startsWith('/logs/')) {
    const found = await one('daily_logs', 'log_date = ?', [decodeURIComponent(pathname.slice(6))]);
    if (!found) throw new Error('日志不存在');
    return found;
  }
  if (method === 'POST' && pathname === '/logs/') {
    const current = await one('daily_logs', 'log_date = ?', [body.log_date]);
    if (current) return update('daily_logs', current.id, {
      completed_todo_ids: Array.from(new Set([...(current.completed_todo_ids || []), ...(body.completed_todo_ids || [])])),
      log_text: body.log_text || '',
      updated_at: beijingNow(),
    });
    const stamp = now();
    return insert('daily_logs', { uuid: uuid(), log_date: body.log_date, completed_todo_ids: body.completed_todo_ids || [], log_text: body.log_text || '', created_at: stamp, updated_at: stamp });
  }
}

async function getActiveTimer() {
  const found = await rows('timer_sessions', "status IN ('running', 'paused') AND is_parked = 0", [], 'created_at DESC');
  return found[0] || null;
}

async function timerRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/timer/current') return getActiveTimer();
  if (method === 'GET' && pathname === '/timer/recent') {
    const limit = Math.max(1, Math.min(50, Number(params.get('limit') || 10)));
    const found = await rows('timer_sessions', "status IN ('completed', 'canceled') OR is_parked = 1", [], 'updated_at DESC');
    return found.slice(0, limit);
  }
  if (method === 'POST' && pathname === '/timer/start') {
    if (await getActiveTimer()) throw new Error('已有进行中的计时');
    const stamp = beijingNow();
    return insert('timer_sessions', {
      uuid: uuid(), name: body.name, status: 'running', project_id: body.project_id ?? null,
      linked_todo_id: body.linked_todo_id ?? null, started_at: stamp, last_resumed_at: stamp,
      paused_at: null, paused_seconds: 0, active_intervals: [], ended_at: null, created_schedule_id: null,
      notes: body.notes || '', created_at: stamp, updated_at: stamp,
    });
  }
  if (method === 'PUT' && pathname === '/timer/current') {
    const timer = await getActiveTimer();
    if (!timer) throw new Error('没有进行中的计时');
    return update('timer_sessions', timer.id, { ...body, updated_at: beijingNow() });
  }
  if (method === 'POST' && ['/timer/pause', '/timer/resume', '/timer/finish', '/timer/cancel'].includes(pathname)) {
    let timer = await getActiveTimer();
    if (pathname === '/timer/resume' && body.timer_id) {
      if (timer) throw new Error('请先结束当前计时，再继续暂存记录');
      timer = await one('timer_sessions','id = ?', [body.timer_id]);
      if (!timer?.is_parked) throw new Error('不是暂存的暂停计时');
    }
    if (!timer) throw new Error('没有进行中的计时');
    const stamp = beijingNow();
    if (pathname === '/timer/pause') {
      if (timer.status !== 'running') throw new Error('计时当前不是运行状态');
      const intervals = [...(timer.active_intervals || [])];
      if (timer.last_resumed_at) intervals.push([timer.last_resumed_at, stamp]);
      return update('timer_sessions', timer.id, { status: 'paused', paused_at: stamp, active_intervals: intervals, updated_at: stamp });
    }
    if (pathname === '/timer/resume') {
      if (timer.status !== 'paused') throw new Error('计时当前不是暂停状态');
      const pausedSeconds = Number(timer.paused_seconds || 0)
        + Math.max(0, Math.floor((parseDateTime(stamp) - parseDateTime(timer.paused_at)) / 1000));
      return update('timer_sessions', timer.id, {
        status: 'running', is_parked:false, last_resumed_at: stamp, paused_at: null, paused_seconds: pausedSeconds, updated_at: stamp,
      });
    }
    let pausedSeconds = Number(timer.paused_seconds || 0);
    if (timer.status === 'paused' && timer.paused_at) {
      pausedSeconds += Math.max(0, Math.floor((parseDateTime(stamp) - parseDateTime(timer.paused_at)) / 1000));
    }
    const intervals = [...(timer.active_intervals || [])];
    if (pathname === '/timer/finish' && timer.status === 'running' && timer.last_resumed_at) {
      intervals.push([timer.last_resumed_at, stamp]);
    }
    return update('timer_sessions', timer.id, {
      status: pathname === '/timer/finish' ? 'completed' : 'canceled', ended_at: stamp,
      active_intervals: intervals,
      paused_at: null, paused_seconds: pausedSeconds, updated_at: stamp,
    });
  }
  return undefined;
}

async function templatesRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/templates') return rows('log_templates', '', [], 'created_at ASC');
  if (method === 'POST' && pathname === '/templates') return insert('log_templates', { uuid: uuid(), name: body.name, content: body.content || '', created_at: now() });
  const match = pathname.match(/^\/templates\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (method === 'PUT') return update('log_templates', id, body);
  if (method === 'DELETE') { await run('DELETE FROM log_templates WHERE id = ?', [id]); return null; }
}

function assertPackage(raw) {
  if (!raw || raw.app !== 'riji' || !SUPPORTED_SCHEMA_VERSIONS.includes(raw.schema_version) || (!raw.entities || Array.isArray(raw.entities) || typeof raw.entities !== 'object')) throw new Error(`仅支持日迹 ${SUPPORTED_SCHEMA_VERSIONS.join('、')} 数据包`);
  for (const table of entityOrder) {
    const items = raw.entities[table] || [];
    if (!Array.isArray(items)) throw new Error(`entities.${table} 必须是数组`);
    const seen = new Set();
    const exceptionKeys = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || !isUuid(item.uuid) || seen.has(item.uuid)) throw new Error(`entities.${table} 含无效或重复 UUID`);
      const missing = requiredFields[table].filter((field) => !Object.hasOwn(item, field));
      if (missing.length) throw new Error(`entities.${table} 缺少字段：${missing.join(', ')}`);
      if (table === 'recurrence_exceptions') {
        if (!isUuid(item.recurrence_rule_uuid)) throw new Error('重复例外引用的规则 UUID 无效');
        const key = `${item.recurrence_rule_uuid}:${item.entity_type}:${item.recurrence_date}`;
        if (exceptionKeys.has(key)) throw new Error('存在重复规则日期例外');
        exceptionKeys.add(key);
      }
      seen.add(item.uuid);
    }
  }
  for (const category of raw.entities.time_block_categories || []) {
    if (typeof category.name !== 'string' || !category.name.trim() || category.name.length > 100 ||
        typeof category.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(category.color)) {
      throw new Error('时间块属性名称或颜色无效');
    }
  }
  const categoryNames = (raw.entities.time_block_categories || []).map(item => item.name);
  if (new Set(categoryNames).size !== categoryNames.length) throw new Error('数据包中的时间块属性名称重复');
  const byDay = new Map();
  for (const block of raw.entities.time_blocks || []) {
    const { block_date: date, start_minute: start, end_minute: end, granularity: size } = block;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00+08:00')) || ![start, end, size].every(Number.isInteger) ||
        ![15, 30].includes(size) || start < 0 || end > 1440 || end - start !== size || start % size || !['manual', 'timer'].includes(block.source || 'manual')) {
      throw new Error('时间块日期、范围或粒度无效');
    }
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push([start, end]);
  }
  for (const ranges of byDay.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, index) => index > 0 && ranges[index - 1][1] > range[0])) {
      throw new Error('数据包中的时间块互相重叠');
    }
  }
  return { ...raw, entities: { ...raw.entities,
    schedules: (raw.entities.schedules || []).filter(item => item.is_planned !== false),
    recurrence_rules: (raw.entities.recurrence_rules || []).filter(item =>
      item.entity_type !== 'schedule' || item.template_json?.is_planned !== false),
    time_block_categories: raw.entities.time_block_categories || [],
    time_blocks: raw.entities.time_blocks || [],
  } };
}

async function deleteWithReferences(table,id) {
  const db=await getDatabase();await db.beginTransaction();
  try {
    if (table==='projects') for (const [name,field] of [['todos','project_id'],['schedules','project_id'],['recurrence_rules','project_id'],['timer_sessions','project_id'],['time_blocks','manual_project_id']]) await run(`UPDATE ${name} SET ${field}=NULL WHERE ${field}=?`,[id],false);
    if (table==='todos') {
      for (const name of ['time_blocks','timer_sessions']) await run(`UPDATE ${name} SET linked_todo_id=NULL WHERE linked_todo_id=?`,[id],false);
      for (const [name,field] of [['schedules','linked_todo_ids'],['daily_logs','completed_todo_ids']]) for (const row of await rows(name)) if ((row[field]||[]).includes(id)) await update(name,row.id,{[field]:row[field].filter(value=>value!==id)},false);
      for (const rule of await rows('recurrence_rules')) if ((rule.template_json?.linked_todo_ids||[]).includes(id)) await update('recurrence_rules',rule.id,{template_json:{...rule.template_json,linked_todo_ids:rule.template_json.linked_todo_ids.filter(value=>value!==id)}},false);
    }
    if (table==='schedules') await run('UPDATE timer_sessions SET created_schedule_id=NULL WHERE created_schedule_id=?',[id],false);
    await run(`DELETE FROM ${table} WHERE id=?`,[id],false);await db.commitTransaction();
  } catch (error) {await db.rollbackTransaction();throw error;}
  return null;
}

async function exportData() {
  const source = {};
  for (const table of entityOrder) source[table] = await rows(table);
  const references={recurrence_rules:{project_id:'projects'},recurrence_exceptions:{recurrence_rule_id:'recurrence_rules'},todos:{project_id:'projects',recurrence_rule_id:'recurrence_rules'},schedules:{project_id:'projects',recurrence_rule_id:'recurrence_rules',linked_todo_ids:'todos'},time_blocks:{category_id:'time_block_categories',linked_todo_id:'todos',manual_project_id:'projects',source_timer_id:'timer_sessions'},daily_logs:{completed_todo_ids:'todos'},timer_sessions:{project_id:'projects',linked_todo_id:'todos',created_schedule_id:'schedules'}};
  const localIds=Object.fromEntries(entityOrder.map(name=>[name,new Set(source[name].map(row=>row.id))]));
  for (const [name,fields] of Object.entries(references)) for (const row of source[name]) for (const [field,target] of Object.entries(fields)) {
    const value=row[field],values=field.endsWith('_ids')?(value||[]):value==null?[]:[value];
    if (values.some(id=>!localIds[target].has(id))) throw new Error(`本机 ${name}.${field} 含断裂关联${name === 'schedules' ? `（计划：${row.name}）` : ''}，请先修复`);
  }
  source.schedules = source.schedules.filter(item => item.is_planned);
  source.recurrence_rules = source.recurrence_rules.filter(item =>
    item.entity_type !== 'schedule' || item.template_json?.is_planned !== false);
  const maps = {};
  for (const table of entityOrder) maps[table] = new Map(source[table].map((item) => [item.id, item.uuid]));
  const entities = {};
  for (const table of entityOrder) entities[table] = source[table].map((item) => {
    const output = { uuid: item.uuid };
    for (const field of entitySpecs[table]) output[field] = item[field] ?? null;
    return output;
  });
  source.recurrence_rules.forEach((item, index) => { entities.recurrence_rules[index].project_uuid = maps.projects.get(item.project_id) || null; delete entities.recurrence_rules[index].template_json?.project_id; });
  source.recurrence_rules.forEach((item,index)=>{
    const template = {...(entities.recurrence_rules[index].template_json||{})};
    const ids = template.linked_todo_ids || [];
    entities.recurrence_rules[index].template_linked_todo_uuids = ids.map(id=>maps.todos.get(id));
    if (entities.recurrence_rules[index].template_linked_todo_uuids.some(value=>!value)) throw new Error('重复计划模板含断裂任务关联，请先修复');
    delete template.linked_todo_ids;
    entities.recurrence_rules[index].template_json = template;
  });
  source.recurrence_exceptions.forEach((item, index) => {
    const ruleUuid = maps.recurrence_rules.get(item.recurrence_rule_id);
    if (!ruleUuid) throw new Error('无法导出孤立的重复例外');
    entities.recurrence_exceptions[index].recurrence_rule_uuid = ruleUuid;
  });
  source.todos.forEach((item, index) => { entities.todos[index].project_uuid = maps.projects.get(item.project_id) || null; entities.todos[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null; });
  source.schedules.forEach((item, index) => { entities.schedules[index].project_uuid = maps.projects.get(item.project_id) || null; entities.schedules[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null; entities.schedules[index].linked_todo_uuids = (item.linked_todo_ids || []).map((id) => maps.todos.get(id)).filter(Boolean); });
  source.time_blocks.forEach((item, index) => {
    delete entities.time_blocks[index].category_id;
    entities.time_blocks[index].category_uuid = maps.time_block_categories.get(item.category_id) || null;
    entities.time_blocks[index].linked_todo_uuid = maps.todos.get(item.linked_todo_id) || null;
    entities.time_blocks[index].manual_project_uuid = item.linked_todo_id ? null : maps.projects.get(item.manual_project_id) || null;
    entities.time_blocks[index].source_timer_uuid = maps.timer_sessions.get(item.source_timer_id) || null;
  });
  source.daily_logs.forEach((item, index) => { entities.daily_logs[index].completed_todo_uuids = (item.completed_todo_ids || []).map((id) => maps.todos.get(id)).filter(Boolean); });
  source.timer_sessions.forEach((item, index) => { entities.timer_sessions[index].project_uuid = maps.projects.get(item.project_id) || null; entities.timer_sessions[index].linked_todo_uuid = maps.todos.get(item.linked_todo_id) || null; entities.timer_sessions[index].created_schedule_uuid = maps.schedules.get(item.created_schedule_id) || null; });
  return { app: 'riji', schema_version: SCHEMA_VERSION, exported_at: now(), entities };
}

async function updatePortable(table, id, data) {
  const current = await one(table, 'id = ?', [id]);
  const changed = Object.fromEntries(Object.entries(data).filter(([key,value]) => canonical(current?.[key] ?? null) !== canonical(value ?? null)));
  if (Object.keys(changed).length) return update(table, id, changed, false);
  return current;
}

async function _writeData(raw, mode = 'merge') {
  const pack = assertPackage(raw);
  const db = await getDatabase();
  const result = {}; let created = 0; let updated = 0; let deleted = 0;
  try {
    for (const table of entityOrder) {
      result[table] = { created: 0, updated: 0 };
      for (const item of pack.entities[table] || []) {
        let current = await one(table, 'uuid = ?', [item.uuid]);
        let exceptionRule;
        if (table === 'recurrence_exceptions') {
          exceptionRule = await one('recurrence_rules', 'uuid = ?', [item.recurrence_rule_uuid]);
          if (!exceptionRule) throw new Error('重复例外引用了不存在的规则 UUID');
          if (!current) current = await one(table, 'recurrence_rule_id = ? AND entity_type = ? AND recurrence_date = ?',
            [exceptionRule.id, item.entity_type, item.recurrence_date]);
        }
        if (!current && table === 'daily_logs') current = await one(table, 'log_date = ?', [item.log_date]);
        const data = { uuid: item.uuid };
        for (const field of entitySpecs[table]) if (field in item && !(table === 'recurrence_rules' && field === 'template_json')) data[field] = item[field];
        if (table === 'recurrence_exceptions') {
          data.recurrence_rule_id = exceptionRule.id;
          data.action = item.action || 'deleted';
          data.created_at = item.created_at || beijingNow();
        }
        if (table === 'time_blocks') {
          const category = await one('time_block_categories', 'uuid = ?', [item.category_uuid]);
          if (!category) throw new Error('数据包引用了不存在的属性 UUID');
          data.category_id = category.id;
        }
        if (current) {
          await updatePortable(table, current.id, data); result[table].updated += 1; updated += 1;
        } else {
          await insert(table, data, false); result[table].created += 1; created += 1;
        }
      }
    }
    const maps = {};
    for (const table of entityOrder) maps[table] = new Map((await rows(table)).map((item) => [item.uuid, item.id]));
    const resolve = (table, value) => {
      if (!value) return null;
      const id = maps[table].get(value);
      if (!id) throw new Error(`数据包引用了不存在的 ${table} UUID：${value}`);
      return id;
    };
    for (const item of pack.entities.recurrence_rules || []) {
      const template={...(item.template_json||{})};delete template.linked_todo_ids;
      if (item.entity_type==='schedule') template.linked_todo_ids=(item.template_linked_todo_uuids||[]).map(value=>resolve('todos',value));
      await updatePortable('recurrence_rules', maps.recurrence_rules.get(item.uuid), { project_id: resolve('projects', item.project_uuid), template_json:template });
    }
    for (const item of pack.entities.todos || []) await updatePortable('todos', maps.todos.get(item.uuid), { project_id: resolve('projects', item.project_uuid), recurrence_rule_id: resolve('recurrence_rules', item.recurrence_rule_uuid) });
    for (const item of pack.entities.schedules || []) await updatePortable('schedules', maps.schedules.get(item.uuid), { project_id: resolve('projects', item.project_uuid), recurrence_rule_id: resolve('recurrence_rules', item.recurrence_rule_uuid), linked_todo_ids: (item.linked_todo_uuids || []).map((value) => resolve('todos', value)) });
    for (const item of pack.entities.time_blocks || []) await update('time_blocks', maps.time_blocks.get(item.uuid), {
      linked_todo_id: resolve('todos', item.linked_todo_uuid),
      manual_project_id: item.linked_todo_uuid ? null : resolve('projects', item.manual_project_uuid),
      source_timer_id: resolve('timer_sessions', item.source_timer_uuid),
    }, false);
    for (const item of pack.entities.daily_logs || []) await updatePortable('daily_logs', maps.daily_logs.get(item.uuid), { completed_todo_ids: (item.completed_todo_uuids || []).map((value) => resolve('todos', value)) });
    for (const item of pack.entities.timer_sessions || []) await updatePortable('timer_sessions', maps.timer_sessions.get(item.uuid), { project_id: resolve('projects', item.project_uuid), linked_todo_id: resolve('todos', item.linked_todo_uuid), created_schedule_id: maps.schedules.has(item.created_schedule_uuid) ? resolve('schedules', item.created_schedule_uuid) : null });
    if (mode === 'replace') {
      for (const table of [...entityOrder].reverse()) {
        const keepIds = new Set((pack.entities[table] || []).map(item => maps[table].get(item.uuid)).filter(Boolean));
        const removeIds = (await rows(table)).map(item => item.id).filter(id => !keepIds.has(id));
        if (removeIds.length) {
          await run(`DELETE FROM ${table} WHERE id IN (${removeIds.map(() => '?').join(', ')})`, removeIds, false);
          deleted += removeIds.length;
        }
      }
    }
  } catch (error) {
    throw error;
  }
  return { schema_version: SCHEMA_VERSION, mode, conflict_policy: mode === 'replace' ? 'replace_local_data' : 'incoming_package_wins_by_uuid', entities: result, created, updated, deleted };
}

let testBackupWriter = null;
async function saveOperationBackup(pack, prefix = 'before-import') {
  if (testBackupWriter) return testBackupWriter(pack);
  const path = `日迹/${prefix}-${uuid()}.json`, data = JSON.stringify(pack);
  const saved = await Filesystem.writeFile({path, data, directory:Directory.Documents, encoding:Encoding.UTF8, recursive:true});
  const read = await Filesystem.readFile({path, directory:Directory.Documents, encoding:Encoding.UTF8});
  if (read.data !== data) throw new Error('操作前副本校验失败，未执行导入');
  return saved.uri;
}

async function previewImport(raw, mode = 'merge', choices = {}) {
  assertPackage(raw);
  const {package: finalPackage, ...preview} = await buildMergePlan(await exportData(), raw, mode, choices);
  return preview;
}

async function importData(raw, mode = 'merge', choices = {}, previewToken) {
  if (!previewToken) throw new Error('请先预览并确认当前数据包');
  assertPackage(raw);
  const db = await getDatabase();
  await db.beginTransaction();
  try {
    const local = await exportData(), plan = await buildMergePlan(local, raw, mode, choices);
    if (plan.token !== previewToken) throw new Error('本机数据、数据包或选择已变化，请重新预览');
    if (plan.unresolved) throw new Error('还有未解决的冲突，不能执行导入');
    assertPackage(plan.package);
    const backup = await saveOperationBackup(local);
    const names = new Map(plan.package.entities.time_block_categories.map(r=>[r.uuid,r.name]));
    for (const row of await rows('time_block_categories')) if (!names.has(row.uuid) || names.get(row.uuid)!==row.name) await update('time_block_categories',row.id,{name:`__import_${row.uuid}`},false);
    if (mode === 'merge') {
      const finalExceptions=new Map(plan.package.entities.recurrence_exceptions.map(r=>[r.uuid,r]));
      for (const before of local.entities.recurrence_exceptions) {
        const after=finalExceptions.get(before.uuid);
        if (after && ['recurrence_rule_uuid','entity_type','recurrence_date'].some(k=>before[k]!==after[k])) await run('DELETE FROM recurrence_exceptions WHERE uuid = ?', [before.uuid], false);
      }
    }
    if (mode === 'merge') {
      const keep = new Set(plan.package.entities.time_blocks.map(r=>r.uuid));
      for (const row of await rows('time_blocks')) if (!keep.has(row.uuid)) await run('DELETE FROM time_blocks WHERE id = ?', [row.id], false);
    }
    await _writeData(plan.package, mode);
    await db.commitTransaction();
    return {mode,schema_version:plan.schema_version,entities:plan.entities,created:Object.values(plan.entities).reduce((s,r)=>s+r.create,0),updated:Object.values(plan.entities).reduce((s,r)=>s+r.update,0),deleted:plan.delete_total,skipped:Object.values(plan.entities).reduce((s,r)=>s+r.skip,0),backup_path:backup};
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }
}

async function portabilityRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/data/references/schedules') return scheduleLinks.preview();
  if (method === 'POST' && pathname === '/data/references/schedules/repair') return scheduleLinks.repair(body);
  if (method === 'GET' && pathname === '/data/export') return exportData();
  if (method === 'POST' && pathname === '/data/import/preview') return previewImport(body.package, body.mode || 'merge', body.choices || {});
  if (method === 'POST' && pathname === '/data/import') return importData(body.package, body.mode || 'merge', body.choices || {}, body.preview_token);
}

const scheduleLinks = createScheduleLinkRepair({rows,run,getDatabase,backupWriter:saveOperationBackup});

// v0.11.0 manual WebDAV sync. The protocol lives in src/platform/webdavSync.js
// and is shared with the modular mobile data layer; this runtime layer only
// supplies its own SQLite helpers, export and package validation.
const webdavRoutes = createSyncRoutes({
  store: {
    getRow: () => enqueueLocal(() => one('webdav_config', 'id = 1')),
    insertRow: (data) => enqueueLocal(() => insert('webdav_config', data)),
    updateRow: (id, data) => enqueueLocal(() => update('webdav_config', id, data)),
  },
  exportPackage: () => enqueueLocal(exportData),
  assertPackage: (raw) => assertPackage(raw),
  supportedSchemaVersions: SUPPORTED_SCHEMA_VERSIONS,
  generateUuid: uuid,
  now,
  protocol: createWebdavProtocol(),
});

async function dispatchMobileRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const url = new URL(path, 'https://riji.local');
  const pathname = url.pathname;
  const syncValue = await webdavRoutes.syncRequest(method, pathname, body);
  if (syncValue !== undefined) return syncValue;
  const handlers = [projectsRequest, todosRequest, schedulesRequest, timeBlocksRequest, logsRequest, timerRequest];
  for (const handler of handlers) {
    const value = await handler(method, pathname, url.searchParams, body);
    if (value !== undefined) return value;
  }
  const templateValue = await templatesRequest(method, pathname, body);
  if (templateValue !== undefined) return templateValue;
  const dataValue = await portabilityRequest(method, pathname, body);
  if (dataValue !== undefined) return dataValue;
  if (method === 'POST' && pathname === '/recurrence-rules/generate') return { created_todo_ids: [], created_schedule_ids: [] };
  if (method === 'GET' && pathname === '/recurrence-rules/') return rows('recurrence_rules');
  if (method === 'GET' && pathname === '/health/') return { status: 'ok', storage: 'capacitor-sqlite' };
  if (pathname.startsWith('/zju/')) throw new Error('安卓体验版暂不支持 ZJU 集成');
  if (pathname.startsWith('/recurrence-rules/')) throw new Error('安卓体验版暂不支持重复规则编辑');
  throw new Error(`安卓本地数据层尚未实现：${method} ${pathname}`);
}

// Serialize the shipped runtime's requests, including reads, so previews never observe half a transaction.
let requestTail = Promise.resolve();
function enqueueLocal(action) {
  const result = requestTail.then(action);
  requestTail = result.catch(()=>{});
  return result;
}
export function mobileRequest(path, options = {}) {
  // Network sync has its own busy guard and must not hold the SQLite queue while waiting for transport.
  if (new URL(path, 'https://riji.local').pathname.startsWith('/sync/webdav/')) return dispatchMobileRequest(path, options);
  return enqueueLocal(()=>dispatchMobileRequest(path, options));
}

function assertTestRuntime() {
  if (typeof process === 'undefined' || process?.env?.NODE_ENV !== 'test') {
    throw new Error('The Android runtime database test hook is only available with NODE_ENV=test');
  }
}

/**
 * Install a SQLite-compatible connection for tests and apply this layer's
 * schema. Production never calls this hook, so the real request modules keep
 * using the Capacitor SQLite plugin.
 */
export async function __installDatabaseForTests(db, backupWriter = null) {
  assertTestRuntime();
  await db.open();
  await db.execute(schema);
  await ensureRuntimeColumns(db);
  databaseOverride = db;
  testBackupWriter = backupWriter;
}

export function __resetDatabaseForTests() {
  assertTestRuntime();
  databaseOverride = null;
  testBackupWriter = null;
}
