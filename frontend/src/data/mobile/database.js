import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const connection = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'riji';

let databasePromise;
let writeTail = Promise.resolve();

const BASE_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS recurrence_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, recurrence_rule_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL, recurrence_date TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'deleted',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, project_id INTEGER, position INTEGER,
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
CREATE TABLE IF NOT EXISTS zju_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL DEFAULT '',
  save_password INTEGER NOT NULL DEFAULT 0, save_pintia_cookie INTEGER NOT NULL DEFAULT 0,
  default_reminder_days INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS zju_calendar_caches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, academic_year TEXT NOT NULL, semester INTEGER NOT NULL,
  calendar TEXT NOT NULL DEFAULT '{}', fetched_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(academic_year, semester)
);
CREATE TABLE IF NOT EXISTS zju_grade_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'zju_zdbk_grade', fetched_at TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}', payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
  summary TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, local_entity_id INTEGER NOT NULL, import_batch_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recurrence_instance_claims (
  rule_uuid TEXT NOT NULL, entity_type TEXT NOT NULL, recurrence_date TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (rule_uuid, entity_type, recurrence_date)
);
CREATE TABLE IF NOT EXISTS active_timer_claim (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), timer_uuid TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mobile_schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
);
`;

const JSON_COLUMNS = new Set([
  'template_json',
  'weekdays',
  'linked_todo_ids',
  'completed_todo_ids',
  'calendar',
  'summary_json',
  'payload_json',
  'summary',
  'payload',
]);

const BOOLEAN_COLUMNS = new Set([
  'is_recurrence_exception',
  'is_completed',
  'is_planned',
  'save_password',
  'save_pintia_cookie',
]);

function isoNow() {
  return new Date().toISOString();
}

async function rawQuery(db, sql, values = []) {
  const result = await db.query(sql, values);
  return result.values || [];
}

async function ensureColumn(db, table, column, definition) {
  const columns = await rawQuery(db, `PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`, false);
  }
}

async function backfillMissingUuids(db, table) {
  const missing = await rawQuery(db, `SELECT id FROM ${table} WHERE uuid IS NULL OR uuid = ''`);
  for (const item of missing) {
    await db.run(`UPDATE ${table} SET uuid = ? WHERE id = ?`, [createUuid(), item.id], false);
  }
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'v0.6-v0.7 baseline compatibility',
    up: async (db) => {
      await db.execute(BASE_SCHEMA, false);
      await ensureColumn(db, 'todos', 'position', 'position INTEGER');
      for (const table of ['projects', 'todos', 'schedules', 'daily_logs', 'log_templates', 'timer_sessions', 'recurrence_rules']) {
        await ensureColumn(db, table, 'uuid', 'uuid TEXT');
        await backfillMissingUuids(db, table);
        await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uuid ON ${table}(uuid)`, false);
      }
    },
  },
  {
    version: 2,
    name: 'v0.8 recurrence exceptions and idempotency',
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS recurrence_exceptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, recurrence_rule_id INTEGER NOT NULL,
          entity_type TEXT NOT NULL, recurrence_date TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'deleted',
          created_at TEXT NOT NULL
        );
      `, false);
      await ensureColumn(db, 'recurrence_exceptions', 'uuid', 'uuid TEXT');
      await backfillMissingUuids(db, 'recurrence_exceptions');
      await db.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recurrence_exceptions_uuid ON recurrence_exceptions(uuid);
        CREATE INDEX IF NOT EXISTS idx_recurrence_exception_identity
          ON recurrence_exceptions(recurrence_rule_id, entity_type, recurrence_date, action);
        CREATE INDEX IF NOT EXISTS idx_todo_recurrence_instance
          ON todos(recurrence_rule_id, recurrence_date);
        CREATE INDEX IF NOT EXISTS idx_schedule_recurrence_instance
          ON schedules(recurrence_rule_id, recurrence_date);
      `, false);
    },
  },
  {
    version: 3,
    name: 'v0.8 local ZJU caches and import bookkeeping',
    up: async (db) => {
      await db.execute(BASE_SCHEMA, false);
      await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_external_item_identity
          ON external_items(source, external_id, entity_type);
        CREATE INDEX IF NOT EXISTS idx_zju_calendar_semester
          ON zju_calendar_caches(academic_year, semester);
      `, false);
    },
  },
  {
    version: 4,
    name: 'v0.8 active timer lookup',
    up: async (db) => {
      await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_active_timer
          ON timer_sessions(status, created_at);
      `, false);
    },
  },
  {
    version: 5,
    name: 'v0.8 non-destructive runtime identity claims',
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS recurrence_instance_claims (
          rule_uuid TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          recurrence_date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (rule_uuid, entity_type, recurrence_date)
        );
        CREATE TABLE IF NOT EXISTS active_timer_claim (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          timer_uuid TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `, false);
      const stamp = isoNow();
      await db.run(`
        INSERT OR IGNORE INTO recurrence_instance_claims(rule_uuid, entity_type, recurrence_date, created_at)
        SELECT r.uuid, 'todo', t.recurrence_date, ?
        FROM todos t JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
        WHERE t.recurrence_date IS NOT NULL
      `, [stamp], false);
      await db.run(`
        INSERT OR IGNORE INTO recurrence_instance_claims(rule_uuid, entity_type, recurrence_date, created_at)
        SELECT r.uuid, 'schedule', s.recurrence_date, ?
        FROM schedules s JOIN recurrence_rules r ON r.id = s.recurrence_rule_id
        WHERE s.recurrence_date IS NOT NULL
      `, [stamp], false);
      await db.run(`
        INSERT OR IGNORE INTO recurrence_instance_claims(rule_uuid, entity_type, recurrence_date, created_at)
        SELECT r.uuid, e.entity_type, e.recurrence_date, ?
        FROM recurrence_exceptions e JOIN recurrence_rules r ON r.id = e.recurrence_rule_id
      `, [stamp], false);
      await db.run(`
        INSERT OR REPLACE INTO active_timer_claim(singleton, timer_uuid, updated_at)
        SELECT 1, uuid, ? FROM timer_sessions
        WHERE status IN ('running', 'paused')
        ORDER BY created_at DESC, id DESC LIMIT 1
      `, [stamp], false);
    },
  },
];

async function applyMigrations(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS mobile_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = await rawQuery(db, 'SELECT version FROM mobile_schema_migrations');
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await db.beginTransaction();
    try {
      await migration.up(db);
      await db.run(
        'INSERT INTO mobile_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, isoNow()],
        false,
      );
      await db.execute(`PRAGMA user_version = ${migration.version}`, false);
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction();
      throw new Error(`Android 数据库升级到 v${migration.version} 失败：${error.message || error}`);
    }
  }
}

export async function getDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      const consistency = await connection.checkConnectionsConsistency();
      const connected = await connection.isConnection(DB_NAME, false);
      const db = consistency.result && connected.result
        ? await connection.retrieveConnection(DB_NAME, false)
        : await connection.createConnection(DB_NAME, false, 'no-encryption', 5, false);
      await db.open();
      await applyMigrations(db);
      return db;
    })().catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function query(sql, values = []) {
  const db = await getDatabase();
  return rawQuery(db, sql, values);
}

export async function run(sql, values = [], transaction = true) {
  const db = await getDatabase();
  return db.run(sql, values, transaction);
}

export function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeRow(table, row) {
  if (!row) return null;
  const result = { ...row };
  for (const key of JSON_COLUMNS) {
    if (key in result) {
      const fallback = key.endsWith('_ids') || key === 'weekdays' ? [] : {};
      result[key] = parseJson(result[key], fallback);
    }
  }
  for (const key of BOOLEAN_COLUMNS) {
    if (key in result) result[key] = Boolean(result[key]);
  }
  return result;
}

export function dbValue(key, value) {
  if (JSON_COLUMNS.has(key)) {
    const fallback = key.endsWith('_ids') || key === 'weekdays' ? [] : {};
    return JSON.stringify(value ?? fallback);
  }
  if (BOOLEAN_COLUMNS.has(key)) return value ? 1 : 0;
  return value ?? null;
}

export async function rows(table, where = '', values = [], order = 'id ASC') {
  const found = await query(
    `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ${order}`,
    values,
  );
  return found.map((item) => normalizeRow(table, item));
}

export async function one(table, where, values = []) {
  const found = await query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, values);
  return found[0] ? normalizeRow(table, found[0]) : null;
}

export async function insert(table, data, transaction = true) {
  const columns = Object.keys(data);
  const result = await run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((key) => dbValue(key, data[key])),
    transaction,
  );
  return one(table, 'id = ?', [result.changes?.lastId]);
}

export async function update(table, id, data, transaction = true) {
  const columns = Object.keys(data).filter((key) => data[key] !== undefined);
  if (!columns.length) return one(table, 'id = ?', [id]);
  await run(
    `UPDATE ${table} SET ${columns.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((key) => dbValue(key, data[key])), id],
    transaction,
  );
  return one(table, 'id = ?', [id]);
}

export async function withTransaction(callback) {
  const db = await getDatabase();
  await db.beginTransaction();
  try {
    const result = await callback(db);
    await db.commitTransaction();
    return result;
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }
}

export function withWriteLock(callback) {
  const operation = writeTail.then(callback, callback);
  writeTail = operation.catch(() => undefined);
  return operation;
}

export function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

export function now() {
  return isoNow();
}

export function beijingNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/Z$/, '');
}

export async function getAppliedMigrationVersions() {
  return rows('mobile_schema_migrations', '', [], 'version ASC');
}

function assertTestRuntime() {
  if (typeof process === 'undefined' || process?.env?.NODE_ENV !== 'test') {
    throw new Error('The mobile database test hook is only available with NODE_ENV=test');
  }
}

/**
 * Install a SQLite-compatible connection for adapter contract tests.
 * Production code never calls this hook; keeping the actual request modules
 * unchanged lets the tests exercise the same SQL, migrations and transactions.
 */
export async function __installDatabaseForTests(db, { migrate = true } = {}) {
  assertTestRuntime();
  if (!db || typeof db.query !== 'function' || typeof db.run !== 'function') {
    throw new TypeError('A SQLite-compatible test connection is required');
  }
  databasePromise = Promise.resolve(db);
  writeTail = Promise.resolve();
  if (migrate) await applyMigrations(db);
}

export function __resetDatabaseForTests() {
  assertTestRuntime();
  databasePromise = undefined;
  writeTail = Promise.resolve();
}