import {
  beijingNow,
  createUuid,
  insert,
  one,
  parseJson,
  query,
  rows,
  run,
  update,
  withTransaction,
  withWriteLock,
} from './database.js';
import { mobileError, validationError } from './domain.js';
import {
  getSecureValue,
  removeSecureValue,
  setSecureValue,
} from '../../platform/secureStorage.js';
import {
  fetchCalendar,
  fetchExternalTodos,
  fetchZdbkGrades,
  fetchZdbkTimetable,
  ZjuNetworkError,
} from './zjuNetwork.js';
import {
  calculateGradeSummary,
  dedupeExternalItems,
  expandZdbkTimetable,
  normalizeGradeItem,
  normalizeGradeStrategy,
  parseExternalDateTime,
} from './zjuNormalize.js';

const PASSWORD_KEY = 'zju.password.v1';
const PINTIA_COOKIE_KEY = 'zju.pintia-cookie.v1';
const KNOWN_PATHS = new Set([
  '/zju/credentials',
  '/zju/credentials/password',
  '/zju/credentials/pintia',
  '/zju/preview',
  '/zju/import',
  '/zju/undo-last',
  '/zju/calendar/cache',
  '/zju/calendar/fetch',
  '/zju/schedule/preview',
  '/zju/schedule/import',
  '/zju/schedule/undo-last',
  '/zju/grades/cache',
  '/zju/grades/fetch',
  '/zju/grades/clear-cache',
]);

function bool(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw validationError('布尔字段格式无效');
  return value;
}

function reminderDays(value, fallback = 1) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 60) {
    throw validationError('default_reminder_days 必须是 0 到 60 的整数');
  }
  return number;
}

function text(value, field, { required = false, max = 300 } = {}) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw validationError(`${field} 不能为空`);
  if (normalized.length > max) throw validationError(`${field} 不能超过 ${max} 个字符`);
  return normalized;
}

function academicTerm(academicYear, semester) {
  const year = text(academicYear, 'academic_year', { required: true, max: 20 });
  if (!/^\d{4}-\d{4}$/.test(year) || Number(year.slice(5)) !== Number(year.slice(0, 4)) + 1) {
    throw validationError('academic_year 必须是 YYYY-YYYY 格式的连续学年');
  }
  const term = Number(semester);
  if (![1, 2].includes(term)) throw validationError('semester 必须是 1 或 2');
  return { academicYear: year, semester: term };
}

function networkError(error) {
  if (error instanceof ZjuNetworkError) {
    return mobileError(400, error.code || 'ZJU_NETWORK_ERROR', error.message);
  }
  return mobileError(400, 'ZJU_RESPONSE_INVALID', '学校系统返回的数据无法解析');
}

async function secureRead(key) {
  try {
    return await getSecureValue(key);
  } catch {
    throw mobileError(503, 'SECURE_STORAGE_UNAVAILABLE', 'Android 安全存储不可用，无法读取 ZJU 凭据');
  }
}

async function secureWrite(key, value) {
  try {
    if (value == null || value === '') await removeSecureValue(key);
    else await setSecureValue(key, value);
  } catch {
    throw mobileError(503, 'SECURE_STORAGE_UNAVAILABLE', 'Android 安全存储不可用，无法保存 ZJU 凭据');
  }
}

async function preference() {
  return (await one('zju_preferences', 'id = 1')) || {
    id: 1,
    username: '',
    save_password: false,
    save_pintia_cookie: false,
    default_reminder_days: 1,
  };
}

async function credentialState() {
  const [settings, password, pintiaCookie] = await Promise.all([
    preference(),
    secureRead(PASSWORD_KEY),
    secureRead(PINTIA_COOKIE_KEY),
  ]);
  return { settings, password: password || '', pintiaCookie: pintiaCookie || '' };
}

function credentialOutput(state) {
  return {
    username: state.settings.username || '',
    has_password: Boolean(state.password),
    has_pintia_cookie: Boolean(state.pintiaCookie),
    save_password: Boolean(state.settings.save_password),
    save_pintia_cookie: Boolean(state.settings.save_pintia_cookie),
    default_reminder_days: Number(state.settings.default_reminder_days ?? 1),
  };
}

async function restoreSecret(key, value) {
  if (value) await setSecureValue(key, value);
  else await removeSecureValue(key);
}

async function saveCredentialSettings(body) {
  return withWriteLock(async () => {
    const previous = await credentialState();
    const username = text(body.username ?? '', 'username', { max: 100 });
    const savePassword = bool(body.save_password, false);
    const savePintiaCookie = bool(body.save_pintia_cookie, false);
    const nextPassword = savePassword ? (String(body.password || '') || previous.password) : '';
    const nextPintiaCookie = savePintiaCookie ? (String(body.pintia_cookie || '') || previous.pintiaCookie) : '';
    const days = reminderDays(body.default_reminder_days, 1);
    try {
      await secureWrite(PASSWORD_KEY, nextPassword);
      await secureWrite(PINTIA_COOKIE_KEY, nextPintiaCookie);
      await withTransaction(async () => {
        const stamp = beijingNow();
        const current = await one('zju_preferences', 'id = 1');
        const values = {
          username,
          save_password: savePassword,
          save_pintia_cookie: savePintiaCookie,
          default_reminder_days: days,
          updated_at: stamp,
        };
        if (current) await update('zju_preferences', 1, values, false);
        else await insert('zju_preferences', { id: 1, ...values, created_at: stamp }, false);
      });
    } catch (error) {
      try {
        await Promise.all([
          restoreSecret(PASSWORD_KEY, previous.password),
          restoreSecret(PINTIA_COOKIE_KEY, previous.pintiaCookie),
        ]);
      } catch {
        throw mobileError(500, 'SECURE_STORAGE_ROLLBACK_FAILED', 'ZJU 凭据保存失败，且安全存储回滚失败；请清除凭据后重试');
      }
      throw error;
    }
    return credentialOutput(await credentialState());
  });
}

async function clearCredential(kind) {
  const previous = await credentialState();
  return saveCredentialSettings({
    username: previous.settings.username,
    password: '',
    pintia_cookie: '',
    save_password: kind === 'password' ? false : Boolean(previous.settings.save_password),
    save_pintia_cookie: kind === 'pintia' ? false : Boolean(previous.settings.save_pintia_cookie),
    default_reminder_days: previous.settings.default_reminder_days,
  });
}

async function resolvedCredentials(body) {
  const state = await credentialState();
  const username = (Object.hasOwn(body, 'username') && body.username !== null
    ? String(body.username)
    : state.settings.username).trim();
  const password = String(body.password || state.password || '');
  const pintiaCookie = String(body.pintia_cookie || state.pintiaCookie || '');
  if (!username || !password) {
    throw mobileError(400, 'ZJU_CREDENTIALS_REQUIRED', '请填写 ZJU 学号和密码，或先保存凭据');
  }
  return { username, password, pintiaCookie, state };
}

async function markExisting(items, entityType) {
  const mappings = await rows('external_items', 'entity_type = ?', [entityType]);
  const existing = new Map(mappings.map((item) => [`${item.source}\u0000${item.external_id}`, item.local_entity_id]));
  return dedupeExternalItems(items).map((item) => {
    const localId = existing.get(`${item.source}\u0000${item.external_id}`);
    if (localId == null) return { ...item, action: 'create', reason: '可导入' };
    return {
      ...item,
      action: 'exists',
      reason: '已导入',
      [entityType === 'todo' ? 'imported_todo_id' : 'imported_schedule_id']: Number(localId),
    };
  });
}

function todoNotes(item) {
  const lines = [
    '来源：ZJU 集成',
    `平台：${item.source}`,
    `外部 ID：${item.external_id}`,
  ];
  if (item.course_name) lines.push(`课程：${item.course_name}`);
  if (item.type) lines.push(`类型：${item.type}`);
  if (item.url) lines.push(`链接：${item.url}`);
  return lines.join('\n');
}

function scheduleNotes(item) {
  const lines = [
    '来源：ZJU 课表导入',
    `平台：${item.source}`,
    `外部 ID：${item.external_id}`,
    `周次：第 ${item.week} 周`,
    `节次：${item.sections}`,
  ];
  if (item.teacher) lines.push(`教师：${item.teacher}`);
  if (item.location) lines.push(`地点：${item.location}`);
  return lines.join('\n');
}

function todoPreview(item) {
  const source = text(item?.source, 'source', { required: true, max: 50 });
  const externalId = text(item?.external_id, 'external_id', { required: true, max: 300 });
  const title = text(item?.title, 'title', { required: true, max: 500 });
  const ddl = item?.ddl_at == null || item.ddl_at === '' ? null : parseExternalDateTime(item.ddl_at);
  if (item?.ddl_at && !ddl) throw validationError('ddl_at 不是有效时间');
  return {
    source,
    external_id: externalId,
    title,
    course_name: text(item?.course_name, 'course_name', { max: 300 }),
    ddl_at: ddl,
    type: text(item?.type, 'type', { max: 100 }),
    url: text(item?.url, 'url', { max: 2000 }),
    raw: item?.raw && typeof item.raw === 'object' && !Array.isArray(item.raw) ? item.raw : {},
    action: item?.action === 'exists' ? 'exists' : 'create',
    reason: String(item?.reason || '可导入'),
    imported_todo_id: item?.imported_todo_id == null ? null : Number(item.imported_todo_id),
  };
}

function schedulePreview(item) {
  const start = parseExternalDateTime(item?.start_time);
  const end = parseExternalDateTime(item?.end_time);
  if (!start || !end) throw validationError('课程日程必须包含有效的开始和结束时间');
  if (new Date(`${end}+08:00`) <= new Date(`${start}+08:00`)) throw validationError('课程日程结束时间必须晚于开始时间');
  const weekday = Number(item?.weekday);
  const week = Number(item?.week);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw validationError('weekday 必须是 1 到 7');
  if (!Number.isInteger(week) || week < 1) throw validationError('week 必须是正整数');
  return {
    source: text(item?.source, 'source', { required: true, max: 50 }),
    external_id: text(item?.external_id, 'external_id', { required: true, max: 300 }),
    course_name: text(item?.course_name, 'course_name', { required: true, max: 500 }),
    teacher: text(item?.teacher, 'teacher', { max: 300 }),
    location: text(item?.location, 'location', { max: 300 }),
    start_time: start,
    end_time: end,
    weekday,
    week,
    sections: text(item?.sections, 'sections', { max: 100 }),
    action: item?.action === 'exists' ? 'exists' : 'create',
    reason: String(item?.reason || '可导入'),
    imported_schedule_id: item?.imported_schedule_id == null ? null : Number(item.imported_schedule_id),
    raw: item?.raw && typeof item.raw === 'object' && !Array.isArray(item.raw) ? item.raw : {},
  };
}

async function previewTodos(body) {
  const credentials = await resolvedCredentials(body);
  const shouldSave = bool(body.save_credentials, false);
  if (shouldSave) await saveCredentialSettings(body);
  const includePintia = bool(body.include_pintia, true);
  let fetched;
  try {
    fetched = await fetchExternalTodos({
      username: credentials.username,
      password: credentials.password,
      pintiaCookie: credentials.pintiaCookie,
      includePintia,
    });
  } catch (error) {
    throw networkError(error);
  }
  return {
    items: await markExisting(fetched.items, 'todo'),
    errors: fetched.errors || [],
    saved_credentials: shouldSave,
  };
}

async function importTodos(body) {
  if (!Array.isArray(body.items)) throw validationError('items 必须是数组');
  const days = reminderDays(body.reminder_days, 1);
  const requested = body.items.map(todoPreview);
  return withWriteLock(() => withTransaction(async () => {
    const stamp = beijingNow();
    const batch = await insert('import_batches', {
      source: 'zju', status: 'completed', summary: {}, created_at: stamp, updated_at: stamp,
    }, false);
    const todoIds = [];
    let skipped = 0;
    const seen = new Set();
    for (const item of requested) {
      const key = `${item.source}\u0000${item.external_id}`;
      if (item.action === 'exists' || seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      if (await one('external_items', 'source = ? AND external_id = ? AND entity_type = ?', [item.source, item.external_id, 'todo'])) {
        skipped += 1;
        continue;
      }
      const todo = await insert('todos', {
        uuid: createUuid(),
        project_id: null,
        position: null,
        recurrence_rule_id: null,
        recurrence_date: null,
        is_recurrence_exception: false,
        name: `${item.course_name ? `[${item.course_name}] ` : ''}${item.title}`.slice(0, 200),
        ddl_type: item.ddl_at ? 'hard' : 'none',
        ddl_date: item.ddl_at,
        reminder_days: item.ddl_at ? days : null,
        category: item.ddl_at ? '课程' : '计划箱',
        status: 'not_focusing',
        waiting_reply_person: null,
        notes: todoNotes(item),
        is_completed: false,
        completed_at: null,
        created_at: stamp,
        updated_at: stamp,
      }, false);
      await insert('external_items', {
        source: item.source,
        external_id: item.external_id,
        entity_type: 'todo',
        local_entity_id: todo.id,
        import_batch_id: batch.id,
        payload: item,
        created_at: stamp,
        updated_at: stamp,
      }, false);
      todoIds.push(todo.id);
    }
    await update('import_batches', batch.id, {
      summary: { created_count: todoIds.length, skipped_count: skipped },
      updated_at: stamp,
    }, false);
    return { batch_id: batch.id, created_count: todoIds.length, skipped_count: skipped, todo_ids: todoIds };
  }));
}

async function latestBatch(source) {
  const found = await query(
    "SELECT * FROM import_batches WHERE source = ? AND status = 'completed' ORDER BY created_at DESC, id DESC LIMIT 1",
    [source],
  );
  if (!found[0]) return null;
  return { ...found[0], summary: parseJson(found[0].summary, {}) };
}

async function undoImport(source, entityType) {
  return withWriteLock(() => withTransaction(async () => {
    const batch = await latestBatch(source);
    if (!batch) return { batch_id: null, deleted_count: 0, skipped_count: 0 };
    const mappings = await rows('external_items', 'import_batch_id = ? AND entity_type = ?', [batch.id, entityType]);
    let deleted = 0;
    let skipped = 0;
    for (const mapping of mappings) {
      const entity = await one(entityType === 'todo' ? 'todos' : 'schedules', 'id = ?', [mapping.local_entity_id]);
      const canDelete = entityType === 'schedule' ? Boolean(entity) : Boolean(entity && !entity.is_completed);
      if (canDelete) {
        if (entityType === 'schedule') {
          await run('UPDATE timer_sessions SET created_schedule_id = NULL WHERE created_schedule_id = ?', [entity.id], false);
        } else {
          await run('UPDATE timer_sessions SET linked_todo_id = NULL WHERE linked_todo_id = ?', [entity.id], false);
        }
        await run(`DELETE FROM ${entityType === 'todo' ? 'todos' : 'schedules'} WHERE id = ?`, [entity.id], false);
        deleted += 1;
      } else {
        skipped += 1;
      }
      await run('DELETE FROM external_items WHERE id = ?', [mapping.id], false);
    }
    const stamp = beijingNow();
    await update('import_batches', batch.id, {
      status: 'undone',
      summary: { ...(batch.summary || {}), undo_deleted_count: deleted, undo_skipped_count: skipped },
      updated_at: stamp,
    }, false);
    return { batch_id: Number(batch.id), deleted_count: deleted, skipped_count: skipped };
  }));
}

function calendarOutput(cache, academicYear, semester) {
  if (!cache) return { academic_year: academicYear, semester, has_cache: false, fetched_at: null, calendar: {} };
  return {
    academic_year: cache.academic_year,
    semester: Number(cache.semester),
    has_cache: true,
    fetched_at: cache.fetched_at,
    calendar: cache.calendar || {},
  };
}

async function getCalendarCache(academicYear, semester) {
  const term = academicTerm(academicYear, semester);
  const cache = await one('zju_calendar_caches', 'academic_year = ? AND semester = ?', [term.academicYear, term.semester]);
  return calendarOutput(cache, term.academicYear, term.semester);
}

async function fetchAndCacheCalendar(body) {
  const term = academicTerm(body.academic_year, body.semester);
  let calendar;
  try {
    calendar = await fetchCalendar(term.academicYear, term.semester);
  } catch (error) {
    throw networkError(error);
  }
  return withWriteLock(() => withTransaction(async () => {
    const stamp = beijingNow();
    const current = await one('zju_calendar_caches', 'academic_year = ? AND semester = ?', [term.academicYear, term.semester]);
    const values = { calendar, fetched_at: stamp, updated_at: stamp };
    const cache = current
      ? await update('zju_calendar_caches', current.id, values, false)
      : await insert('zju_calendar_caches', {
        academic_year: term.academicYear,
        semester: term.semester,
        ...values,
        created_at: stamp,
      }, false);
    return calendarOutput(cache, term.academicYear, term.semester);
  }));
}

async function previewSchedule(body) {
  const credentials = await resolvedCredentials(body);
  const term = academicTerm(body.academic_year, body.semester);
  const cache = await one('zju_calendar_caches', 'academic_year = ? AND semester = ?', [term.academicYear, term.semester]);
  if (!cache) throw mobileError(400, 'ZJU_CALENDAR_REQUIRED', '请先手动拉取并缓存该学期校历');
  try {
    const raw = await fetchZdbkTimetable(credentials.username, credentials.password, term.academicYear, term.semester);
    const items = expandZdbkTimetable(raw, cache.calendar || {}, term.academicYear, term.semester);
    return { items: await markExisting(items, 'schedule'), errors: [], calendar_fetched_at: cache.fetched_at };
  } catch (error) {
    const safe = networkError(error);
    return { items: [], errors: [safe.message], calendar_fetched_at: cache.fetched_at };
  }
}

async function importSchedules(body) {
  if (!Array.isArray(body.items)) throw validationError('items 必须是数组');
  const requested = body.items.map(schedulePreview);
  return withWriteLock(() => withTransaction(async () => {
    const stamp = beijingNow();
    const batch = await insert('import_batches', {
      source: 'zju_schedule', status: 'completed', summary: {}, created_at: stamp, updated_at: stamp,
    }, false);
    const scheduleIds = [];
    let skipped = 0;
    const seen = new Set();
    for (const item of requested) {
      const key = `${item.source}\u0000${item.external_id}`;
      if (item.action === 'exists' || seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      if (await one('external_items', 'source = ? AND external_id = ? AND entity_type = ?', [item.source, item.external_id, 'schedule'])) {
        skipped += 1;
        continue;
      }
      const schedule = await insert('schedules', {
        uuid: createUuid(),
        project_id: null,
        recurrence_rule_id: null,
        recurrence_date: null,
        is_recurrence_exception: false,
        name: item.course_name.slice(0, 200),
        start_time: item.start_time,
        end_time: item.end_time,
        category: '课程',
        nature: 'no_other_task',
        relax_suggestion: null,
        linked_todo_ids: [],
        location: item.location || null,
        notes: scheduleNotes(item),
        is_planned: true,
        created_at: stamp,
        updated_at: stamp,
      }, false);
      await insert('external_items', {
        source: item.source,
        external_id: item.external_id,
        entity_type: 'schedule',
        local_entity_id: schedule.id,
        import_batch_id: batch.id,
        payload: item,
        created_at: stamp,
        updated_at: stamp,
      }, false);
      scheduleIds.push(schedule.id);
    }
    await update('import_batches', batch.id, {
      summary: { created_count: scheduleIds.length, skipped_count: skipped },
      updated_at: stamp,
    }, false);
    return {
      batch_id: batch.id,
      created_count: scheduleIds.length,
      skipped_count: skipped,
      schedule_ids: scheduleIds,
    };
  }));
}

function storedGrade(item = {}) {
  return {
    source: String(item.source || 'zju_zdbk_grade'),
    external_id: String(item.external_id || ''),
    course_id: String(item.course_id || ''),
    course_code: String(item.course_code || ''),
    course_name: String(item.course_name || ''),
    credit: Number(item.credit || 0),
    original_score: String(item.original_score || ''),
    hundred_point: item.hundred_point == null ? null : Number(item.hundred_point),
    five_point: item.five_point == null ? null : Number(item.five_point),
    four_point: item.four_point == null ? null : Number(item.four_point),
    four_point_legacy: item.four_point_legacy == null ? null : Number(item.four_point_legacy),
    gpa_included: Boolean(item.gpa_included),
    credit_included: Boolean(item.credit_included),
    major: Boolean(item.major),
    academic_year: String(item.academic_year || ''),
    semester: String(item.semester || ''),
    course_nature: String(item.course_nature || ''),
    raw: item.raw && typeof item.raw === 'object' ? item.raw : {},
  };
}

function gradesOutput(items, majorItems, strategy, fetchedAt, hasCache, fromCache, errors = []) {
  const grades = (items || []).map(storedGrade);
  const majors = (majorItems || []).map(storedGrade);
  return {
    items: grades,
    major_items: majors,
    summary: calculateGradeSummary(grades, strategy, majors),
    fetched_at: fetchedAt || null,
    has_cache: Boolean(hasCache),
    from_cache: Boolean(fromCache),
    errors: Array.isArray(errors) ? errors.map(String) : [],
  };
}

async function latestGradeSnapshot() {
  const found = await rows('zju_grade_snapshots', 'source = ?', ['zju_zdbk_grade'], 'fetched_at DESC, id DESC');
  return found[0] || null;
}

async function getGradeCache(strategy) {
  const normalized = normalizeGradeStrategy(strategy);
  const snapshot = await latestGradeSnapshot();
  if (!snapshot) return gradesOutput([], [], normalized, null, false, true);
  const payload = snapshot.payload_json || {};
  return gradesOutput(
    payload.items || [],
    payload.major_items || [],
    normalized,
    snapshot.fetched_at,
    true,
    true,
    payload.errors || [],
  );
}

async function fetchGrades(body) {
  const credentials = await resolvedCredentials(body);
  const includeMajor = bool(body.include_major, true);
  const strategy = normalizeGradeStrategy(body.strategy);
  let fetched;
  try {
    fetched = await fetchZdbkGrades(credentials.username, credentials.password, includeMajor);
  } catch (error) {
    throw networkError(error);
  }
  const items = fetched.items.map((item) => normalizeGradeItem(item, false));
  const majorItems = fetched.majorItems.map((item) => normalizeGradeItem(item, true));
  const stamp = beijingNow();
  await withWriteLock(() => withTransaction(async () => {
    const current = await latestGradeSnapshot();
    const summary = calculateGradeSummary(items, strategy, majorItems);
    const values = {
      source: 'zju_zdbk_grade',
      fetched_at: stamp,
      summary_json: summary,
      payload_json: { items, major_items: majorItems, errors: fetched.errors || [] },
      updated_at: stamp,
    };
    if (current) await update('zju_grade_snapshots', current.id, values, false);
    else await insert('zju_grade_snapshots', { ...values, created_at: stamp }, false);
  }));
  return gradesOutput(items, majorItems, strategy, stamp, true, false, fetched.errors || []);
}

async function clearGradeCache() {
  return withWriteLock(async () => {
    await run('DELETE FROM zju_grade_snapshots WHERE source = ?', ['zju_zdbk_grade']);
    return gradesOutput([], [], 'scholarship', null, false, true);
  });
}

export async function zjuRequest(method, pathname, params, body) {
  if (!pathname.startsWith('/zju/')) return undefined;
  if (method === 'GET' && pathname === '/zju/credentials') return credentialOutput(await credentialState());
  if (method === 'PUT' && pathname === '/zju/credentials') return saveCredentialSettings(body);
  if (method === 'DELETE' && pathname === '/zju/credentials/password') return clearCredential('password');
  if (method === 'DELETE' && pathname === '/zju/credentials/pintia') return clearCredential('pintia');
  if (method === 'POST' && pathname === '/zju/preview') return previewTodos(body);
  if (method === 'POST' && pathname === '/zju/import') return importTodos(body);
  if (method === 'POST' && pathname === '/zju/undo-last') return undoImport('zju', 'todo');
  if (method === 'GET' && pathname === '/zju/calendar/cache') {
    return getCalendarCache(params.get('academic_year'), params.get('semester'));
  }
  if (method === 'POST' && pathname === '/zju/calendar/fetch') return fetchAndCacheCalendar(body);
  if (method === 'POST' && pathname === '/zju/schedule/preview') return previewSchedule(body);
  if (method === 'POST' && pathname === '/zju/schedule/import') return importSchedules(body);
  if (method === 'POST' && pathname === '/zju/schedule/undo-last') return undoImport('zju_schedule', 'schedule');
  if (method === 'GET' && pathname === '/zju/grades/cache') return getGradeCache(params.get('strategy') || 'scholarship');
  if (method === 'POST' && pathname === '/zju/grades/fetch') return fetchGrades(body);
  if (method === 'POST' && pathname === '/zju/grades/clear-cache') return clearGradeCache();
  if (KNOWN_PATHS.has(pathname)) {
    throw mobileError(405, 'METHOD_NOT_ALLOWED', `Android ZJU 接口不支持 ${method} ${pathname}`);
  }
  throw mobileError(404, 'NOT_FOUND', `Android ZJU 接口不存在：${pathname}`);
}
