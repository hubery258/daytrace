import {
  beijingNow,
  createUuid,
  insert,
  one,
  query,
  rows,
  run,
  update,
  withTransaction,
  withWriteLock,
} from './database.js';
import {
  conflict,
  dateOnly,
  isDdlNear,
  normalizeProjectCreate,
  normalizeProjectUpdate,
  normalizeTodoCreate,
  normalizeTodoUpdate,
  notFound,
  parseBoolean,
} from './domain.js';

const FOCUS_LIMIT = 3;

function todoOrder(left, right) {
  const leftHasPosition = left.position != null;
  const rightHasPosition = right.position != null;
  if (leftHasPosition !== rightHasPosition) return leftHasPosition ? -1 : 1;
  if (leftHasPosition && Number(left.position) !== Number(right.position)) return Number(left.position) - Number(right.position);
  if (Boolean(left.ddl_date) !== Boolean(right.ddl_date)) return left.ddl_date ? -1 : 1;
  if (left.ddl_date && left.ddl_date !== right.ddl_date) return String(left.ddl_date).localeCompare(String(right.ddl_date));
  return String(left.created_at || '').localeCompare(String(right.created_at || '')) || Number(left.id) - Number(right.id);
}

export function enrichTodo(todo, at = new Date()) {
  if (!todo) return null;
  const near = isDdlNear(todo, at);
  return {
    ...todo,
    is_hard_ddl_near: near && todo.ddl_type === 'hard',
    is_soft_ddl_near: near && todo.ddl_type === 'soft',
  };
}

export async function getTodo(id) {
  return enrichTodo(await one('todos', 'id = ?', [id]));
}

async function ensureFocusLimit(excludeId = null) {
  const values = [];
  let clause = "status = 'focusing' AND is_completed = 0";
  if (excludeId != null) {
    clause += ' AND id != ?';
    values.push(excludeId);
  }
  const found = await query(`SELECT COUNT(*) AS count FROM todos WHERE ${clause}`, values);
  if (Number(found[0]?.count || 0) >= FOCUS_LIMIT) throw conflict(`关注中的待办最多 ${FOCUS_LIMIT} 个`);
}

export async function insertTodoRecord(data, metadata = {}, transaction = false) {
  const stamp = beijingNow();
  return enrichTodo(await insert('todos', {
    uuid: metadata.uuid || createUuid(),
    project_id: data.project_id ?? null,
    position: data.position ?? null,
    recurrence_rule_id: metadata.recurrence_rule_id ?? null,
    recurrence_date: metadata.recurrence_date ?? null,
    is_recurrence_exception: Boolean(metadata.is_recurrence_exception),
    name: data.name,
    ddl_type: data.ddl_type,
    ddl_date: data.ddl_date ?? null,
    reminder_days: data.reminder_days ?? null,
    category: data.category,
    status: data.status,
    waiting_reply_person: data.waiting_reply_person ?? null,
    notes: data.notes ?? '',
    is_completed: Boolean(metadata.is_completed),
    completed_at: metadata.completed_at ?? null,
    created_at: metadata.created_at || stamp,
    updated_at: metadata.updated_at || stamp,
  }, transaction));
}

export async function ensureDeletedTodoException(todo) {
  if (!todo?.recurrence_rule_id || !todo?.recurrence_date) return;
  const existing = await one(
    'recurrence_exceptions',
    'recurrence_rule_id = ? AND entity_type = ? AND recurrence_date = ? AND action = ?',
    [todo.recurrence_rule_id, 'todo', todo.recurrence_date, 'deleted'],
  );
  if (!existing) {
    await insert('recurrence_exceptions', {
      uuid: createUuid(),
      recurrence_rule_id: todo.recurrence_rule_id,
      entity_type: 'todo',
      recurrence_date: todo.recurrence_date,
      action: 'deleted',
      created_at: beijingNow(),
    }, false);
  }
}

async function attachProjectOverview(project) {
  if (!project) return null;
  const projectTodos = (await rows('todos', 'project_id = ?', [project.id], 'created_at DESC')).map((todo) => enrichTodo(todo));
  const projectSchedules = await rows('schedules', 'project_id = ?', [project.id], 'start_time ASC');
  const incomplete = projectTodos.filter((todo) => !todo.is_completed).sort(todoOrder);
  const completedCount = projectTodos.filter((todo) => todo.is_completed).length;
  return {
    ...project,
    todo_count: projectTodos.length,
    completed_todo_count: completedCount,
    progress: projectTodos.length ? completedCount / projectTodos.length : null,
    next_todo: incomplete[0] || null,
    recent_schedules: projectSchedules.slice(0, 3),
  };
}

async function projectOverview(project) {
  const enriched = await attachProjectOverview(project);
  const projectTodos = (await rows('todos', 'project_id = ?', [project.id], 'created_at DESC')).map((todo) => enrichTodo(todo)).sort(todoOrder);
  const projectSchedules = await rows('schedules', 'project_id = ?', [project.id], 'start_time ASC');
  return {
    project: enriched,
    todos: projectTodos,
    schedules: projectSchedules,
    progress: enriched.progress,
    todo_count: enriched.todo_count,
    completed_todo_count: enriched.completed_todo_count,
    next_todo: enriched.next_todo,
    recent_schedules: enriched.recent_schedules,
  };
}

export async function projectRequest(method, pathname, params, body) {
  if (method === 'GET' && pathname === '/projects/') {
    const status = params.get('status');
    const includeHidden = parseBoolean(params.get('include_hidden'), false);
    const clauses = [];
    const values = [];
    if (status) {
      clauses.push('status = ?');
      values.push(status);
    } else if (!includeHidden) {
      clauses.push("status NOT IN ('archived', 'canceled')");
    }
    const found = await rows('projects', clauses.join(' AND '), values, 'updated_at DESC');
    return Promise.all(found.map(attachProjectOverview));
  }
  if (method === 'POST' && pathname === '/projects/') {
    return withWriteLock(async () => {
      const data = normalizeProjectCreate(body);
      const stamp = beijingNow();
      const project = await insert('projects', {
        uuid: createUuid(),
        ...data,
        completed_at: data.status === 'completed' ? stamp : null,
        archived_at: data.status === 'archived' ? stamp : null,
        created_at: stamp,
        updated_at: stamp,
      });
      return attachProjectOverview(project);
    });
  }
  const overviewMatch = pathname.match(/^\/projects\/(\d+)\/overview$/);
  if (method === 'GET' && overviewMatch) {
    const project = await one('projects', 'id = ?', [Number(overviewMatch[1])]);
    if (!project) throw notFound('项目不存在');
    return projectOverview(project);
  }
  const match = pathname.match(/^\/projects\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (method === 'GET') {
    const project = await one('projects', 'id = ?', [id]);
    if (!project) throw notFound('项目不存在');
    return attachProjectOverview(project);
  }
  if (method === 'PUT') {
    return withWriteLock(async () => {
      const current = await one('projects', 'id = ?', [id]);
      const data = normalizeProjectUpdate(body, current);
      const stamp = beijingNow();
      if (Object.hasOwn(data, 'status')) {
        data.completed_at = data.status === 'completed' ? (current.completed_at || stamp) : null;
        data.archived_at = data.status === 'archived' ? (current.archived_at || stamp) : null;
      }
      return attachProjectOverview(await update('projects', id, { ...data, updated_at: stamp }));
    });
  }
  if (method === 'DELETE') {
    return withWriteLock(() => withTransaction(async () => {
      const current = await one('projects', 'id = ?', [id]);
      if (!current) throw notFound('项目不存在');
      for (const table of ['todos', 'schedules', 'recurrence_rules', 'timer_sessions']) {
        await run(`UPDATE ${table} SET project_id = NULL WHERE project_id = ?`, [id], false);
      }
      await run('DELETE FROM projects WHERE id = ?', [id], false);
      return null;
    }));
  }
  return undefined;
}

export async function todoRequest(method, pathname, params, body) {
  if (method === 'GET' && ['/todos/', '/todos/focusing', '/todos/waiting-reply', '/todos/ddl-near'].includes(pathname)) {
    const clauses = [];
    const values = [];
    if (pathname === '/todos/focusing') clauses.push("status = 'focusing'", 'is_completed = 0');
    if (pathname === '/todos/waiting-reply') clauses.push("status = 'waiting_reply'", 'is_completed = 0');
    for (const [key, column] of [['category', 'category'], ['status', 'status'], ['project_id', 'project_id']]) {
      if (params.has(key)) {
        clauses.push(`${column} = ?`);
        values.push(params.get(key));
      }
    }
    if (params.has('is_completed')) {
      clauses.push('is_completed = ?');
      values.push(parseBoolean(params.get('is_completed')) ? 1 : 0);
    }
    const order = params.has('project_id') ? 'position IS NULL ASC, position ASC, ddl_date IS NULL ASC, ddl_date ASC, created_at ASC' : 'created_at DESC';
    const found = (await rows('todos', clauses.join(' AND '), values, order)).map((todo) => enrichTodo(todo));
    return pathname === '/todos/ddl-near' ? found.filter((item) => item.is_hard_ddl_near || item.is_soft_ddl_near) : found;
  }
  if (method === 'POST' && pathname === '/todos/') {
    return withWriteLock(async () => {
      const data = normalizeTodoCreate(body);
      if (data.status === 'focusing') await ensureFocusLimit();
      return insertTodoRecord(data, {}, true);
    });
  }
  const completeMatch = pathname.match(/^\/todos\/(\d+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    return withWriteLock(() => withTransaction(async () => {
      const id = Number(completeMatch[1]);
      const current = await one('todos', 'id = ?', [id]);
      if (!current) throw notFound('待办不存在');
      const logDate = dateOnly(body.log_date, 'log_date');
      const stamp = beijingNow();
      await update('todos', id, {
        is_completed: true,
        completed_at: current.completed_at || stamp,
        updated_at: stamp,
      }, false);
      const log = await one('daily_logs', 'log_date = ?', [logDate]);
      if (log) {
        await update('daily_logs', log.id, {
          completed_todo_ids: [...new Set([...(log.completed_todo_ids || []), id])],
          updated_at: stamp,
        }, false);
      } else {
        await insert('daily_logs', {
          uuid: createUuid(),
          log_date: logDate,
          completed_todo_ids: [id],
          log_text: '',
          created_at: stamp,
          updated_at: stamp,
        }, false);
      }
      return getTodo(id);
    }));
  }
  const match = pathname.match(/^\/todos\/(\d+)$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (method === 'GET') {
    const current = await getTodo(id);
    if (!current) throw notFound('待办不存在');
    return current;
  }
  if (method === 'PUT') {
    return withWriteLock(async () => {
      const current = await one('todos', 'id = ?', [id]);
      if (!current) throw notFound('待办不存在');
      const data = normalizeTodoUpdate(body, current);
      const effectiveStatus = data.status ?? current.status;
      const effectiveCompleted = data.is_completed ?? current.is_completed;
      if (effectiveStatus === 'focusing' && !effectiveCompleted) await ensureFocusLimit(id);
      const stamp = beijingNow();
      if (Object.hasOwn(data, 'is_completed')) {
        data.completed_at = data.is_completed ? (data.completed_at || current.completed_at || stamp) : null;
      }
      if (current.recurrence_rule_id && Object.keys(data).some((key) => !['is_completed', 'completed_at'].includes(key))) {
        data.is_recurrence_exception = true;
      }
      await update('todos', id, { ...data, updated_at: stamp });
      return getTodo(id);
    });
  }
  if (method === 'DELETE') {
    return withWriteLock(() => withTransaction(async () => {
      const current = await one('todos', 'id = ?', [id]);
      if (!current) throw notFound('待办不存在');
      await ensureDeletedTodoException(current);
      await run('DELETE FROM external_items WHERE entity_type = ? AND local_entity_id = ?', ['todo', id], false);
      await run('DELETE FROM todos WHERE id = ?', [id], false);
      return null;
    }));
  }
  return undefined;
}
