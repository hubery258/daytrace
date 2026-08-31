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
  conflict,
  dateOnly,
  notFound,
  parseDateTime,
  timerElapsedSeconds,
  validateTemplateInput,
  validationError,
} from './domain.js';

function timerOutput(timer) {
  return timer ? { ...timer, elapsed_seconds: timerElapsedSeconds(timer) } : null;
}

async function getActiveTimer() {
  const active = await rows(
    'timer_sessions',
    "uuid = (SELECT timer_uuid FROM active_timer_claim WHERE singleton = 1) AND status IN ('running', 'paused')",
    [],
    'created_at DESC, id DESC',
  );
  return active[0] || null;
}

async function updateActiveTimer(timer, data) {
  return timerOutput(await update('timer_sessions', timer.id, { ...data, updated_at: beijingNow() }, false));
}

export async function timerRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/timer/current') return timerOutput(await getActiveTimer());
  if (method === 'GET' && pathname === '/timer/recent') {
    const rawLimit = Number(params.get('limit') ?? 10);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) throw validationError('limit 必须在 1 到 50 之间');
    const found = await rows('timer_sessions', "status IN ('completed', 'canceled')", [], 'updated_at DESC');
    return found.slice(0, rawLimit).map(timerOutput);
  }
  if (method === 'POST' && pathname === '/timer/start') {
    return withWriteLock(() => withTransaction(async () => {
      if (await getActiveTimer()) throw conflict('已有进行中的计时');
      await run(
        `DELETE FROM active_timer_claim
         WHERE NOT EXISTS (
           SELECT 1 FROM timer_sessions
           WHERE timer_sessions.uuid = active_timer_claim.timer_uuid
             AND timer_sessions.status IN ('running', 'paused')
         )`,
        [],
        false,
      );
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 200) throw validationError('name 不能为空且不能超过 200 个字符');
      const stamp = beijingNow();
      const uuid = createUuid();
      try {
        await run(
          'INSERT INTO active_timer_claim(singleton, timer_uuid, updated_at) VALUES (1, ?, ?)',
          [uuid, stamp],
          false,
        );
      } catch (error) {
        throw conflict('已有进行中的计时');
      }
      const timer = await insert('timer_sessions', {
        uuid,
        name,
        status: 'running',
        project_id: body.project_id ?? null,
        linked_todo_id: body.linked_todo_id ?? null,
        started_at: stamp,
        last_resumed_at: stamp,
        paused_at: null,
        paused_seconds: 0,
        ended_at: null,
        created_schedule_id: null,
        notes: String(body.notes ?? ''),
        created_at: stamp,
        updated_at: stamp,
      }, false);
      return timerOutput(timer);
    }));
  }
  if (method === 'PUT' && pathname === '/timer/current') {
    return withWriteLock(() => withTransaction(async () => {
      const timer = await getActiveTimer();
      if (!timer) throw notFound('没有进行中的计时');
      const data = {};
      if (Object.hasOwn(body, 'name')) {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 200) throw validationError('name 不能为空且不能超过 200 个字符');
        data.name = name;
      }
      for (const field of ['project_id', 'linked_todo_id', 'notes']) {
        if (Object.hasOwn(body, field)) data[field] = body[field];
      }
      return updateActiveTimer(timer, data);
    }));
  }
  if (method === 'POST' && ['/timer/pause', '/timer/resume', '/timer/finish', '/timer/cancel'].includes(pathname)) {
    return withWriteLock(() => withTransaction(async () => {
      const timer = await getActiveTimer();
      if (!timer) throw notFound('没有进行中的计时');
      const stamp = beijingNow();
      if (pathname === '/timer/pause') {
        if (timer.status !== 'running') throw conflict('计时当前不是运行状态');
        return updateActiveTimer(timer, { status: 'paused', paused_at: stamp });
      }
      if (pathname === '/timer/resume') {
        if (timer.status !== 'paused' || !timer.paused_at) throw conflict('计时当前不是暂停状态');
        const pausedSeconds = Number(timer.paused_seconds || 0)
          + Math.max(0, Math.floor((parseDateTime(stamp) - parseDateTime(timer.paused_at)) / 1000));
        return updateActiveTimer(timer, {
          status: 'running',
          last_resumed_at: stamp,
          paused_at: null,
          paused_seconds: pausedSeconds,
        });
      }
      let pausedSeconds = Number(timer.paused_seconds || 0);
      if (timer.status === 'paused' && timer.paused_at) {
        pausedSeconds += Math.max(0, Math.floor((parseDateTime(stamp) - parseDateTime(timer.paused_at)) / 1000));
      }
      const completed = pathname === '/timer/finish';
      const result = await updateActiveTimer(timer, {
        status: completed ? 'completed' : 'canceled',
        ended_at: stamp,
        paused_at: null,
        paused_seconds: pausedSeconds,
      });
      await run('DELETE FROM active_timer_claim WHERE singleton = 1', [], false);
      return result;
    }));
  }
  const attachMatch = pathname.match(/^\/timer\/(\d+)\/schedule$/);
  if (method === 'POST' && attachMatch) {
    return withWriteLock(() => withTransaction(async () => {
      const timer = await one('timer_sessions', 'id = ?', [Number(attachMatch[1])]);
      if (!timer) throw notFound('计时记录不存在');
      if (timer.status !== 'completed') throw conflict('只有已结束计时可以关联日程');
      const schedule = await one('schedules', 'id = ?', [Number(body.schedule_id)]);
      if (!schedule) throw notFound('日程不存在');
      return timerOutput(await update('timer_sessions', timer.id, {
        created_schedule_id: schedule.id,
        updated_at: beijingNow(),
      }, false));
    }));
  }
  return undefined;
}

export async function logRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/logs/') {
    const clauses = [];
    const values = [];
    if (params.has('date_from')) {
      clauses.push('log_date >= ?');
      values.push(dateOnly(params.get('date_from'), 'date_from'));
    }
    if (params.has('date_to')) {
      clauses.push('log_date <= ?');
      values.push(dateOnly(params.get('date_to'), 'date_to'));
    }
    return rows('daily_logs', clauses.join(' AND '), values, 'log_date DESC');
  }
  const match = pathname.match(/^\/logs\/(\d{4}-\d{2}-\d{2})$/);
  if (method === 'GET' && match) {
    const log = await one('daily_logs', 'log_date = ?', [dateOnly(match[1], 'log_date')]);
    if (!log) throw notFound('日志不存在');
    return log;
  }
  if (method === 'POST' && pathname === '/logs/') {
    return withWriteLock(() => withTransaction(async () => {
      const logDate = dateOnly(body.log_date, 'log_date');
      if (body.completed_todo_ids != null && !Array.isArray(body.completed_todo_ids)) {
        throw validationError('completed_todo_ids 必须是数组');
      }
      const current = await one('daily_logs', 'log_date = ?', [logDate]);
      const stamp = beijingNow();
      if (current) {
        return update('daily_logs', current.id, {
          completed_todo_ids: [...new Set([...(current.completed_todo_ids || []), ...(body.completed_todo_ids || [])].map(Number))],
          log_text: String(body.log_text ?? ''),
          updated_at: stamp,
        }, false);
      }
      return insert('daily_logs', {
        uuid: createUuid(),
        log_date: logDate,
        completed_todo_ids: [...new Set((body.completed_todo_ids || []).map(Number))],
        log_text: String(body.log_text ?? ''),
        created_at: stamp,
        updated_at: stamp,
      }, false);
    }));
  }
  return undefined;
}

export async function templateRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/templates') return rows('log_templates', '', [], 'created_at DESC');
  if (method === 'POST' && pathname === '/templates') {
    return withWriteLock(async () => {
      const data = validateTemplateInput(body);
      return insert('log_templates', {
        uuid: createUuid(),
        name: data.name,
        content: data.content ?? '',
        created_at: beijingNow(),
      });
    });
  }
  const match = pathname.match(/^\/templates\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (method === 'PUT') {
    return withWriteLock(async () => {
      const current = await one('log_templates', 'id = ?', [id]);
      if (!current) throw notFound('总结模板不存在');
      return update('log_templates', id, validateTemplateInput(body, current));
    });
  }
  if (method === 'DELETE') {
    return withWriteLock(async () => {
      const current = await one('log_templates', 'id = ?', [id]);
      if (!current) throw notFound('总结模板不存在');
      await run('DELETE FROM log_templates WHERE id = ?', [id]);
      return null;
    });
  }
  return undefined;
}
