import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const connection = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'riji';
const SCHEMA_VERSION = '0.6.0';
let databasePromise;

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
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, project_id INTEGER,
  recurrence_rule_id INTEGER, recurrence_date TEXT, is_recurrence_exception INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, category TEXT NOT NULL DEFAULT '普通日程',
  nature TEXT NOT NULL DEFAULT 'no_other_task', relax_suggestion TEXT, linked_todo_ids TEXT NOT NULL DEFAULT '[]',
  location TEXT, notes TEXT NOT NULL DEFAULT '', is_planned INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
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
  status TEXT NOT NULL DEFAULT 'running', project_id INTEGER, linked_todo_id INTEGER,
  started_at TEXT NOT NULL, last_resumed_at TEXT, paused_at TEXT, paused_seconds INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT, created_schedule_id INTEGER, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_uuid ON projects(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_uuid ON todos(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_uuid ON schedules(uuid);
`;

const jsonColumns = new Set(['template_json', 'weekdays', 'linked_todo_ids', 'completed_todo_ids']);
const booleanColumns = new Set(['is_recurrence_exception', 'is_completed', 'is_planned']);
const entitySpecs = {
  projects: ['name', 'description', 'status', 'ddl_date', 'color', 'completed_at', 'archived_at', 'created_at', 'updated_at'],
  recurrence_rules: ['entity_type', 'template_json', 'frequency', 'start_date', 'end_date', 'weekdays', 'month_day', 'status', 'created_at', 'updated_at'],
  todos: ['name', 'position', 'ddl_type', 'ddl_date', 'reminder_days', 'category', 'status', 'waiting_reply_person', 'notes', 'is_completed', 'completed_at', 'recurrence_date', 'is_recurrence_exception', 'created_at', 'updated_at'],
  schedules: ['name', 'start_time', 'end_time', 'category', 'nature', 'relax_suggestion', 'location', 'notes', 'is_planned', 'recurrence_date', 'is_recurrence_exception', 'created_at', 'updated_at'],
  daily_logs: ['log_date', 'log_text', 'created_at', 'updated_at'],
  log_templates: ['name', 'content', 'created_at'],
  timer_sessions: ['name', 'status', 'started_at', 'last_resumed_at', 'paused_at', 'paused_seconds', 'ended_at', 'notes', 'created_at', 'updated_at'],
};
const entityOrder = Object.keys(entitySpecs);
const requiredFields = {
  projects: ['name'], recurrence_rules: ['entity_type', 'frequency', 'start_date'],
  todos: ['name', 'ddl_type', 'category', 'status'],
  schedules: ['name', 'start_time', 'end_time', 'category', 'nature'],
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

async function getDatabase() {
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
      const todoColumns = await db.query('PRAGMA table_info(todos)');
      if (!(todoColumns.values || []).some(column => column.name === 'position')) {
        await db.execute('ALTER TABLE todos ADD COLUMN position INTEGER');
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
  for (const key of jsonColumns) if (key in result) result[key] = parseJson(result[key], key.endsWith('_ids') || key === 'weekdays' ? [] : {});
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
  const schedules = await rows('schedules', 'project_id = ?', [project.id], 'start_time DESC');
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
    const schedules = await rows('schedules', 'project_id = ?', [id], 'start_time ASC');
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
    await run('UPDATE todos SET project_id = NULL WHERE project_id = ?', [id]);
    await run('UPDATE schedules SET project_id = NULL WHERE project_id = ?', [id]);
    await run('UPDATE recurrence_rules SET project_id = NULL WHERE project_id = ?', [id]);
    await run('DELETE FROM projects WHERE id = ?', [id]);
    return null;
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
  if (method === 'GET') return current;
  if (method === 'PUT') {
    const data = normalizeTodoInput(body, current);
    if (data.status === 'focusing') await ensureFocusLimit(id);
    if (data.is_completed === true && !data.completed_at) data.completed_at = now();
    if (data.is_completed === false) data.completed_at = null;
    if (current.recurrence_rule_id && Object.keys(data).some((key) => !['is_completed', 'completed_at'].includes(key))) data.is_recurrence_exception = true;
    return update('todos', id, { ...data, updated_at: now() });
  }
  if (method === 'DELETE') { await run('DELETE FROM todos WHERE id = ?', [id]); return null; }
}

async function schedulesRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/schedules/current') {
    const stamp = Date.now();
    const found = await rows('schedules', '', [], 'start_time ASC');
    return found.find((item) => parseDateTime(item.start_time).getTime() <= stamp && parseDateTime(item.end_time).getTime() > stamp) || null;
  }
  if (method === 'GET' && (pathname === '/schedules/' || pathname === '/schedules/week/')) {
    const clauses = []; const values = [];
    if (params.has('is_planned')) { clauses.push('is_planned = ?'); values.push(params.get('is_planned') === 'true' ? 1 : 0); }
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
    const start = body.start_time || current.start_time; const end = body.end_time || current.end_time;
    if (new Date(end) <= new Date(start)) throw new Error('结束时间必须晚于开始时间');
    const data = { ...body, updated_at: now() };
    if (current.recurrence_rule_id && Object.keys(body).length) data.is_recurrence_exception = true;
    return update('schedules', id, data);
  }
  if (method === 'DELETE') { await run('DELETE FROM schedules WHERE id = ?', [id]); return null; }
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
  const found = await rows('timer_sessions', "status IN ('running', 'paused')", [], 'created_at DESC');
  return found[0] || null;
}

async function timerRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/timer/current') return getActiveTimer();
  if (method === 'GET' && pathname === '/timer/recent') {
    const limit = Math.max(1, Math.min(50, Number(params.get('limit') || 10)));
    const found = await rows('timer_sessions', "status IN ('completed', 'canceled')", [], 'updated_at DESC');
    return found.slice(0, limit);
  }
  if (method === 'POST' && pathname === '/timer/start') {
    if (await getActiveTimer()) throw new Error('已有进行中的计时');
    const stamp = beijingNow();
    return insert('timer_sessions', {
      uuid: uuid(), name: body.name, status: 'running', project_id: body.project_id ?? null,
      linked_todo_id: body.linked_todo_id ?? null, started_at: stamp, last_resumed_at: stamp,
      paused_at: null, paused_seconds: 0, ended_at: null, created_schedule_id: null,
      notes: body.notes || '', created_at: stamp, updated_at: stamp,
    });
  }
  if (method === 'PUT' && pathname === '/timer/current') {
    const timer = await getActiveTimer();
    if (!timer) throw new Error('没有进行中的计时');
    return update('timer_sessions', timer.id, { ...body, updated_at: beijingNow() });
  }
  if (method === 'POST' && ['/timer/pause', '/timer/resume', '/timer/finish', '/timer/cancel'].includes(pathname)) {
    const timer = await getActiveTimer();
    if (!timer) throw new Error('没有进行中的计时');
    const stamp = beijingNow();
    if (pathname === '/timer/pause') {
      if (timer.status !== 'running') throw new Error('计时当前不是运行状态');
      return update('timer_sessions', timer.id, { status: 'paused', paused_at: stamp, updated_at: stamp });
    }
    if (pathname === '/timer/resume') {
      if (timer.status !== 'paused') throw new Error('计时当前不是暂停状态');
      const pausedSeconds = Number(timer.paused_seconds || 0)
        + Math.max(0, Math.floor((parseDateTime(stamp) - parseDateTime(timer.paused_at)) / 1000));
      return update('timer_sessions', timer.id, {
        status: 'running', last_resumed_at: stamp, paused_at: null, paused_seconds: pausedSeconds, updated_at: stamp,
      });
    }
    let pausedSeconds = Number(timer.paused_seconds || 0);
    if (timer.status === 'paused' && timer.paused_at) {
      pausedSeconds += Math.max(0, Math.floor((parseDateTime(stamp) - parseDateTime(timer.paused_at)) / 1000));
    }
    return update('timer_sessions', timer.id, {
      status: pathname === '/timer/finish' ? 'completed' : 'canceled', ended_at: stamp,
      paused_at: null, paused_seconds: pausedSeconds, updated_at: stamp,
    });
  }
  const attachMatch = pathname.match(/^\/timer\/(\d+)\/schedule$/);
  if (method === 'POST' && attachMatch) {
    const timer = await one('timer_sessions', 'id = ?', [Number(attachMatch[1])]);
    if (!timer) throw new Error('计时记录不存在');
    if (timer.status !== 'completed') throw new Error('只有已结束计时可以关联日程');
    return update('timer_sessions', timer.id, { created_schedule_id: body.schedule_id, updated_at: beijingNow() });
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
  if (!raw || raw.app !== 'riji' || raw.schema_version !== SCHEMA_VERSION || typeof raw.entities !== 'object') throw new Error(`仅支持日迹 ${SCHEMA_VERSION} 数据包`);
  for (const table of entityOrder) {
    const items = raw.entities[table] || [];
    if (!Array.isArray(items)) throw new Error(`entities.${table} 必须是数组`);
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || !isUuid(item.uuid) || seen.has(item.uuid)) throw new Error(`entities.${table} 含无效或重复 UUID`);
      const missing = requiredFields[table].filter((field) => !Object.hasOwn(item, field));
      if (missing.length) throw new Error(`entities.${table} 缺少字段：${missing.join(', ')}`);
      seen.add(item.uuid);
    }
  }
  return raw;
}

async function exportData() {
  const source = {};
  for (const table of entityOrder) source[table] = await rows(table);
  const maps = {};
  for (const table of entityOrder) maps[table] = new Map(source[table].map((item) => [item.id, item.uuid]));
  const entities = {};
  for (const table of entityOrder) entities[table] = source[table].map((item) => {
    const output = { uuid: item.uuid };
    for (const field of entitySpecs[table]) output[field] = item[field] ?? null;
    return output;
  });
  source.recurrence_rules.forEach((item, index) => { entities.recurrence_rules[index].project_uuid = maps.projects.get(item.project_id) || null; delete entities.recurrence_rules[index].template_json?.project_id; });
  source.todos.forEach((item, index) => { entities.todos[index].project_uuid = maps.projects.get(item.project_id) || null; entities.todos[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null; });
  source.schedules.forEach((item, index) => { entities.schedules[index].project_uuid = maps.projects.get(item.project_id) || null; entities.schedules[index].recurrence_rule_uuid = maps.recurrence_rules.get(item.recurrence_rule_id) || null; entities.schedules[index].linked_todo_uuids = (item.linked_todo_ids || []).map((id) => maps.todos.get(id)).filter(Boolean); });
  source.daily_logs.forEach((item, index) => { entities.daily_logs[index].completed_todo_uuids = (item.completed_todo_ids || []).map((id) => maps.todos.get(id)).filter(Boolean); });
  source.timer_sessions.forEach((item, index) => { entities.timer_sessions[index].project_uuid = maps.projects.get(item.project_id) || null; entities.timer_sessions[index].linked_todo_uuid = maps.todos.get(item.linked_todo_id) || null; entities.timer_sessions[index].created_schedule_uuid = maps.schedules.get(item.created_schedule_id) || null; });
  return { app: 'riji', schema_version: SCHEMA_VERSION, exported_at: now(), entities };
}

async function previewImport(raw, mode = 'merge') {
  const pack = assertPackage(raw);
  const entities = {};
  for (const table of entityOrder) {
    const existing = await rows(table);
    const uuids = new Set(existing.map((item) => item.uuid));
    const dates = table === 'daily_logs' ? new Set(existing.map((item) => item.log_date)) : new Set();
    const total = (pack.entities[table] || []).length;
    const incoming = pack.entities[table] || [];
    const updateCount = incoming.filter((item) => uuids.has(item.uuid) || (table === 'daily_logs' && dates.has(item.log_date))).length;
    const matchedLocalIds = new Set(existing
      .filter(local => incoming.some(item => item.uuid === local.uuid || (table === 'daily_logs' && item.log_date === local.log_date)))
      .map(local => local.id));
    entities[table] = {
      total,
      create: total - updateCount,
      update: updateCount,
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

async function importData(raw, mode = 'merge') {
  const pack = assertPackage(raw);
  const db = await getDatabase();
  const result = {}; let created = 0; let updated = 0; let deleted = 0;
  await db.beginTransaction();
  try {
    for (const table of entityOrder) {
      result[table] = { created: 0, updated: 0 };
      for (const item of pack.entities[table] || []) {
        let current = await one(table, 'uuid = ?', [item.uuid]);
        if (!current && table === 'daily_logs') current = await one(table, 'log_date = ?', [item.log_date]);
        const data = { uuid: item.uuid };
        for (const field of entitySpecs[table]) if (field in item) data[field] = item[field];
        if (current) {
          await update(table, current.id, data, false); result[table].updated += 1; updated += 1;
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
    for (const item of pack.entities.recurrence_rules || []) await update('recurrence_rules', maps.recurrence_rules.get(item.uuid), { project_id: resolve('projects', item.project_uuid) }, false);
    for (const item of pack.entities.todos || []) await update('todos', maps.todos.get(item.uuid), { project_id: resolve('projects', item.project_uuid), recurrence_rule_id: resolve('recurrence_rules', item.recurrence_rule_uuid) }, false);
    for (const item of pack.entities.schedules || []) await update('schedules', maps.schedules.get(item.uuid), { project_id: resolve('projects', item.project_uuid), recurrence_rule_id: resolve('recurrence_rules', item.recurrence_rule_uuid), linked_todo_ids: (item.linked_todo_uuids || []).map((value) => resolve('todos', value)) }, false);
    for (const item of pack.entities.daily_logs || []) await update('daily_logs', maps.daily_logs.get(item.uuid), { completed_todo_ids: (item.completed_todo_uuids || []).map((value) => resolve('todos', value)) }, false);
    for (const item of pack.entities.timer_sessions || []) await update('timer_sessions', maps.timer_sessions.get(item.uuid), { project_id: resolve('projects', item.project_uuid), linked_todo_id: resolve('todos', item.linked_todo_uuid), created_schedule_id: resolve('schedules', item.created_schedule_uuid) }, false);
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
    await db.commitTransaction();
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }
  return { schema_version: SCHEMA_VERSION, mode, conflict_policy: mode === 'replace' ? 'replace_local_data' : 'incoming_package_wins_by_uuid', entities: result, created, updated, deleted };
}

async function portabilityRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/data/export') return exportData();
  if (method === 'POST' && pathname === '/data/import/preview') return previewImport(body.package, body.mode || 'merge');
  if (method === 'POST' && pathname === '/data/import') return importData(body.package, body.mode || 'merge');
}

export async function mobileRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const url = new URL(path, 'https://riji.local');
  const pathname = url.pathname;
  const handlers = [projectsRequest, todosRequest, schedulesRequest, logsRequest, timerRequest];
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
