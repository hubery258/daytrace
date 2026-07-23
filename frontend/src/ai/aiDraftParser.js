const TODO_STATUSES = new Set(['not_focusing', 'focusing', 'waiting_reply']);
const DDL_TYPES = new Set(['none', 'hard', 'soft']);

function extractJson(text) {
  const trimmed = (text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function toDate(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : normalized;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  const startA = new Date(aStart).getTime();
  const endA = new Date(aEnd).getTime();
  const startB = new Date(bStart).getTime();
  const endB = new Date(bEnd).getTime();
  return startA < endB && startB < endA;
}

function normalizeId(value, allowedIds) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return allowedIds.has(id) ? id : null;
}

function normalizeTodo(item, index, projectIds) {
  const errors = [];
  const name = String(item.name || '').trim();
  if (!name) errors.push(`第 ${index + 1} 条待办草稿缺少名称`);

  const ddlType = DDL_TYPES.has(item.ddl_type) ? item.ddl_type : 'none';
  const ddlDate = ddlType === 'none' ? null : toDate(item.ddl_date);
  if (ddlType !== 'none' && !ddlDate) errors.push(`待办「${name || index + 1}」的 DDL 日期不可解析`);

  const reminderDays = ddlType === 'none'
    ? null
    : Math.max(0, Number.isFinite(Number(item.reminder_days)) ? Number(item.reminder_days) : 1);

  return {
    errors,
    draft: {
      id: `todo-${index}-${Date.now()}`,
      draft_type: 'todo',
      name,
      ddl_type: ddlType,
      ddl_date: ddlDate,
      reminder_days: reminderDays,
      category: String(item.category || '任务').trim() || '任务',
      status: TODO_STATUSES.has(item.status) ? item.status : 'not_focusing',
      waiting_reply_person: item.status === 'waiting_reply' ? String(item.waiting_reply_person || '').trim() : '',
      project_id: normalizeId(item.project_id, projectIds),
      notes: String(item.notes || '').trim(),
      reason: String(item.reason || '').trim(),
    },
  };
}

function normalizeSchedule(item, index, projectIds, todoIds, schedules) {
  const errors = [];
  const warnings = [];
  const name = String(item.name || '').trim();
  if (!name) errors.push(`第 ${index + 1} 条日程草稿缺少名称`);

  const startTime = toDate(item.start_time);
  const endTime = toDate(item.end_time);
  if (!startTime || !endTime) {
    errors.push(`日程「${name || index + 1}」的开始或结束时间不可解析`);
  } else if (new Date(endTime) <= new Date(startTime)) {
    errors.push(`日程「${name || index + 1}」的结束时间必须晚于开始时间`);
  } else {
    const conflict = schedules.find(s => overlaps(startTime, endTime, s.start_time, s.end_time));
    if (conflict) {
      warnings.push(`日程「${name}」与已有日程「${conflict.name}」冲突，已跳过`);
      return { errors, warnings, draft: null };
    }
  }

  const linkedTodoIds = Array.isArray(item.linked_todo_ids)
    ? item.linked_todo_ids.map(id => Number(id)).filter(id => todoIds.has(id)).slice(0, 2)
    : [];

  return {
    errors,
    warnings,
    draft: {
      id: `schedule-${index}-${Date.now()}`,
      draft_type: 'schedule',
      name,
      start_time: startTime,
      end_time: endTime,
      category: String(item.category || '普通日程').trim() || '普通日程',
      nature: 'no_other_task',
      relax_suggestion: null,
      linked_todo_ids: linkedTodoIds,
      location: String(item.location || '').trim(),
      notes: String(item.notes || '').trim(),
      is_planned: item.is_planned !== false,
      project_id: normalizeId(item.project_id, projectIds),
      reason: String(item.reason || '').trim(),
    },
  };
}

export function parseAiDraftResponse(rawText, { projects = [], todos = [], schedules = [] } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    return {
      drafts: [],
      errors: ['AI 返回的内容不是可解析的 JSON，请重试'],
      warnings: [],
    };
  }

  if (parsed?.type !== 'drafts' || !Array.isArray(parsed.items)) {
    return {
      drafts: [],
      errors: ['AI 返回 JSON 缺少 type="drafts" 或 items 数组'],
      warnings: [],
    };
  }

  const projectIds = new Set(projects.map(p => Number(p.id)));
  const todoIds = new Set(todos.map(t => Number(t.id)));
  const drafts = [];
  const errors = [];
  const warnings = [];

  parsed.items.forEach((item, index) => {
    if (item?.draft_type === 'todo') {
      const result = normalizeTodo(item, index, projectIds);
      errors.push(...result.errors);
      if (!result.errors.length) drafts.push(result.draft);
      return;
    }

    if (item?.draft_type === 'schedule') {
      const result = normalizeSchedule(item, index, projectIds, todoIds, schedules);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      if (!result.errors.length && result.draft) drafts.push(result.draft);
      return;
    }

    errors.push(`第 ${index + 1} 条草稿类型无效：只允许 todo 或 schedule`);
  });

  return { drafts, errors, warnings };
}

export function todoDraftToPayload(draft) {
  return {
    project_id: draft.project_id || null,
    name: draft.name,
    ddl_type: draft.ddl_type,
    ddl_date: draft.ddl_type === 'none' ? null : draft.ddl_date,
    reminder_days: draft.ddl_type === 'none' ? null : Number(draft.reminder_days || 0),
    category: draft.category || '任务',
    status: draft.status || 'not_focusing',
    waiting_reply_person: draft.status === 'waiting_reply' ? draft.waiting_reply_person || null : null,
    notes: draft.notes || '',
  };
}

export function scheduleDraftToPayload(draft) {
  return {
    project_id: draft.project_id || null,
    name: draft.name,
    start_time: draft.start_time,
    end_time: draft.end_time,
    category: draft.category || '普通日程',
    nature: 'no_other_task',
    relax_suggestion: null,
    linked_todo_ids: Array.isArray(draft.linked_todo_ids) ? draft.linked_todo_ids.slice(0, 2) : [],
    location: draft.location || null,
    notes: draft.notes || '',
    is_planned: draft.is_planned !== false,
  };
}

export function parseAiQuestionsResponse(rawText, expectedType) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    return { questions: [], errors: ['AI returned non-JSON questions. Please retry.'] };
  }

  if (expectedType && parsed?.type !== expectedType) {
    return { questions: [], errors: [`AI returned type ${parsed?.type || 'unknown'}, expected ${expectedType}.`] };
  }

  const questions = Array.isArray(parsed?.questions)
    ? parsed.questions.map(q => String(q || '').trim()).filter(Boolean).slice(0, 3)
    : [];

  if (!questions.length) {
    return { questions: [], errors: ['AI did not return any usable questions.'] };
  }

  return { questions, errors: [] };
}
