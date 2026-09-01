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
  addDays,
  conflict,
  dateOnly,
  normalizeScheduleCreate,
  normalizeScheduleUpdate,
  notFound,
  parseBoolean,
  parseDateTime,
} from './domain.js';

export async function getSchedule(id) {
  return one('schedules', 'id = ?', [id]);
}

export async function findScheduleOverlaps({ startTime, endTime, isPlanned, excludeId = null }) {
  const candidates = await rows('schedules', 'is_planned = ?', [isPlanned ? 1 : 0], 'start_time ASC');
  const start = parseDateTime(startTime).getTime();
  const end = parseDateTime(endTime).getTime();
  return candidates.filter((item) => (
    Number(item.id) !== Number(excludeId)
    && parseDateTime(item.start_time).getTime() < end
    && parseDateTime(item.end_time).getTime() > start
  ));
}

export async function insertScheduleRecord(data, metadata = {}, transaction = false) {
  const stamp = beijingNow();
  return insert('schedules', {
    uuid: metadata.uuid || createUuid(),
    project_id: data.project_id ?? null,
    recurrence_rule_id: metadata.recurrence_rule_id ?? null,
    recurrence_date: metadata.recurrence_date ?? null,
    is_recurrence_exception: Boolean(metadata.is_recurrence_exception),
    name: data.name,
    start_time: data.start_time,
    end_time: data.end_time,
    category: data.category,
    nature: data.nature,
    relax_suggestion: data.relax_suggestion ?? null,
    linked_todo_ids: data.linked_todo_ids || [],
    location: data.location ?? null,
    notes: data.notes ?? '',
    is_planned: data.is_planned !== false,
    created_at: metadata.created_at || stamp,
    updated_at: metadata.updated_at || stamp,
  }, transaction);
}

export async function ensureDeletedScheduleException(schedule) {
  if (!schedule?.recurrence_rule_id || !schedule?.recurrence_date) return;
  const existing = await one(
    'recurrence_exceptions',
    'recurrence_rule_id = ? AND entity_type = ? AND recurrence_date = ? AND action = ?',
    [schedule.recurrence_rule_id, 'schedule', schedule.recurrence_date, 'deleted'],
  );
  if (!existing) {
    await insert('recurrence_exceptions', {
      uuid: createUuid(),
      recurrence_rule_id: schedule.recurrence_rule_id,
      entity_type: 'schedule',
      recurrence_date: schedule.recurrence_date,
      action: 'deleted',
      created_at: beijingNow(),
    }, false);
  }
}

export async function scheduleRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/schedules/current') {
    const stamp = Date.now();
    const found = await rows('schedules', '', [], 'start_time ASC');
    return found.find((item) => (
      parseDateTime(item.start_time).getTime() <= stamp
      && parseDateTime(item.end_time).getTime() > stamp
    )) || null;
  }
  if (method === 'GET' && (pathname === '/schedules/' || pathname === '/schedules/week/')) {
    const clauses = [];
    const values = [];
    if (params.has('is_planned')) {
      clauses.push('is_planned = ?');
      values.push(parseBoolean(params.get('is_planned')) ? 1 : 0);
    }
    if (params.has('project_id')) {
      clauses.push('project_id = ?');
      values.push(params.get('project_id'));
    }
    let dateFrom = params.get('date_from');
    let dateTo = params.get('date_to');
    if (pathname === '/schedules/week/') {
      const start = dateOnly(params.get('start_date'), 'start_date');
      dateFrom = `${start}T00:00:00`;
      dateTo = `${addDays(start, 7)}T00:00:00`;
    }
    const found = await rows('schedules', clauses.join(' AND '), values, 'start_time ASC');
    const fromMs = dateFrom ? parseDateTime(dateFrom, 'date_from').getTime() : null;
    const toMs = dateTo ? parseDateTime(dateTo, 'date_to').getTime() : null;
    return found.filter((item) => (
      (fromMs == null || parseDateTime(item.end_time).getTime() > fromMs)
      && (toMs == null || parseDateTime(item.start_time).getTime() < toMs)
    ));
  }
  if (method === 'POST' && pathname === '/schedules/') {
    return withWriteLock(async () => {
      const data = normalizeScheduleCreate(body);
      const overlaps = await findScheduleOverlaps({
        startTime: data.start_time,
        endTime: data.end_time,
        isPlanned: data.is_planned,
      });
      if (overlaps.length) throw conflict('日程与同一类型中的已有日程重叠');
      return insertScheduleRecord(data, {}, true);
    });
  }
  const match = pathname.match(/^\/schedules\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (method === 'GET') {
    const current = await getSchedule(id);
    if (!current) throw notFound('日程不存在');
    return current;
  }
  if (method === 'PUT') {
    return withWriteLock(async () => {
      const current = await getSchedule(id);
      if (!current) throw notFound('日程不存在');
      const data = normalizeScheduleUpdate(body, current);
      const effective = { ...current, ...data };
      const overlaps = await findScheduleOverlaps({
        startTime: effective.start_time,
        endTime: effective.end_time,
        isPlanned: effective.is_planned,
        excludeId: id,
      });
      if (overlaps.length) throw conflict('日程与同一类型中的已有日程重叠');
      if (current.recurrence_rule_id && Object.keys(data).length) data.is_recurrence_exception = true;
      return update('schedules', id, { ...data, updated_at: beijingNow() });
    });
  }
  if (method === 'DELETE') {
    return withWriteLock(() => withTransaction(async () => {
      const current = await getSchedule(id);
      if (!current) throw notFound('日程不存在');
      await ensureDeletedScheduleException(current);
      await run('DELETE FROM external_items WHERE entity_type = ? AND local_entity_id = ?', ['schedule', id], false);
      await run('UPDATE timer_sessions SET created_schedule_id = NULL WHERE created_schedule_id = ?', [id], false);
      await run('DELETE FROM schedules WHERE id = ?', [id], false);
      return null;
    }));
  }
  return undefined;
}
