import { ApiError } from '../../api/errors.js';

const TODO_STATUSES = new Set(['waiting_reply', 'focusing', 'not_focusing']);
const DDL_TYPES = new Set(['none', 'hard', 'soft']);
const PROJECT_STATUSES = new Set(['active', 'paused', 'completed', 'archived', 'canceled']);
const SCHEDULE_NATURES = new Set(['no_other_task', 'relax', 'free_arrange']);
const RULE_ENTITY_TYPES = new Set(['todo', 'schedule']);
const RULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const RULE_STATUSES = new Set(['active', 'paused', 'archived']);

export function mobileError(status, code, message, detail = null) {
  return new ApiError(message, { status, code, detail });
}

export function validationError(message, detail = null) {
  return mobileError(422, 'VALIDATION_ERROR', message, detail);
}

export function notFound(message) {
  return mobileError(404, 'NOT_FOUND', message);
}

export function conflict(message) {
  return mobileError(409, 'CONFLICT', message);
}

function requiredText(value, field, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw validationError(`${field} 不能为空`);
  if (normalized.length > maxLength) throw validationError(`${field} 不能超过 ${maxLength} 个字符`);
  return normalized;
}

function optionalId(value, field) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw validationError(`${field} 必须是正整数`);
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value == null || value === '') return null;
  const normalized = String(value);
  if (normalized.length > maxLength) throw validationError(`${field} 不能超过 ${maxLength} 个字符`);
  return normalized;
}

function nonNegativeInteger(value, field) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) throw validationError(`${field} 必须是非负整数`);
  return normalized;
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) throw validationError(`${field} 的值无效`);
  return value;
}

export function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw validationError('布尔参数格式无效');
}

export function parseDateTime(value, field = 'datetime') {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw validationError(`${field} 不是有效时间`);
    return value;
  }
  const text = String(value ?? '').trim().replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(text);
  const normalized = hasZone ? text : `${text}+08:00`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw validationError(`${field} 不是有效时间`);
  return parsed;
}

export function formatBeijingDateTime(value) {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const pad = (part) => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

export function dateOnly(value, field = 'date') {
  const text = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw validationError(`${field} 不是有效日期`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw validationError(`${field} 不是有效日期`);
  }
  return text;
}

export function addDays(day, amount) {
  const parsed = new Date(`${dateOnly(day)}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(amount));
  return parsed.toISOString().slice(0, 10);
}

export function compareDateTimes(left, right) {
  return parseDateTime(left).getTime() - parseDateTime(right).getTime();
}

export function normalizeProjectCreate(input = {}) {
  const status = enumValue(input.status ?? 'active', PROJECT_STATUSES, 'status');
  return {
    name: requiredText(input.name, 'name'),
    description: String(input.description ?? ''),
    status,
    ddl_date: input.ddl_date == null || input.ddl_date === '' ? null : dateOnly(input.ddl_date, 'ddl_date'),
    color: optionalText(input.color, 'color', 32),
  };
}

export function normalizeProjectUpdate(input = {}, current) {
  if (!current) throw notFound('项目不存在');
  const data = {};
  if (Object.hasOwn(input, 'name')) data.name = requiredText(input.name, 'name');
  if (Object.hasOwn(input, 'description')) data.description = String(input.description ?? '');
  if (Object.hasOwn(input, 'status')) data.status = enumValue(input.status, PROJECT_STATUSES, 'status');
  if (Object.hasOwn(input, 'ddl_date')) data.ddl_date = input.ddl_date == null || input.ddl_date === '' ? null : dateOnly(input.ddl_date, 'ddl_date');
  if (Object.hasOwn(input, 'color')) data.color = optionalText(input.color, 'color', 32);
  return data;
}

function validateTodoState(effective) {
  enumValue(effective.ddl_type, DDL_TYPES, 'ddl_type');
  enumValue(effective.status, TODO_STATUSES, 'status');
  if (effective.ddl_type !== 'none') {
    if (!effective.ddl_date) throw validationError('hard 或 soft DDL 必须提供 ddl_date');
    parseDateTime(effective.ddl_date, 'ddl_date');
    if (!Number.isInteger(Number(effective.reminder_days)) || Number(effective.reminder_days) < 0) {
      throw validationError('hard 或 soft DDL 必须提供非负 reminder_days');
    }
  }
  if (effective.status === 'waiting_reply') {
    const person = String(effective.waiting_reply_person ?? '').trim();
    if (!person) throw validationError('等待答复状态必须填写 waiting_reply_person');
    if (person.length > 100) throw validationError('waiting_reply_person 不能超过 100 个字符');
  }
}

export function normalizeTodoCreate(input = {}) {
  const ddlType = input.ddl_type ?? 'none';
  const status = input.status ?? 'not_focusing';
  const effective = {
    ddl_type: ddlType,
    ddl_date: ddlType === 'none' ? null : input.ddl_date,
    reminder_days: ddlType === 'none' ? null : input.reminder_days,
    status,
    waiting_reply_person: input.waiting_reply_person,
  };
  validateTodoState(effective);
  const category = ddlType === 'none'
    ? (!input.category || input.category === '任务' ? '计划箱' : String(input.category))
    : (!input.category || input.category === '计划箱' ? '任务' : String(input.category));
  return {
    project_id: optionalId(input.project_id, 'project_id'),
    position: nonNegativeInteger(input.position, 'position'),
    name: requiredText(input.name, 'name'),
    ddl_type: ddlType,
    ddl_date: effective.ddl_date ?? null,
    reminder_days: effective.reminder_days == null ? null : Number(effective.reminder_days),
    category,
    status,
    waiting_reply_person: status === 'waiting_reply' ? String(input.waiting_reply_person).trim() : null,
    notes: String(input.notes ?? ''),
  };
}

export function normalizeTodoUpdate(input = {}, current) {
  if (!current) throw notFound('待办不存在');
  const effective = { ...current, ...input };
  if (effective.ddl_type === 'none') {
    effective.ddl_date = null;
    effective.reminder_days = null;
  }
  validateTodoState(effective);
  const data = {};
  if (Object.hasOwn(input, 'project_id')) data.project_id = optionalId(input.project_id, 'project_id');
  if (Object.hasOwn(input, 'position')) data.position = nonNegativeInteger(input.position, 'position');
  if (Object.hasOwn(input, 'name')) data.name = requiredText(input.name, 'name');
  for (const field of ['ddl_type', 'ddl_date', 'reminder_days', 'category', 'status', 'waiting_reply_person', 'notes', 'is_completed', 'completed_at']) {
    if (Object.hasOwn(input, field)) data[field] = input[field];
  }
  if (Object.hasOwn(input, 'ddl_type')) {
    if (effective.ddl_type === 'none') {
      data.ddl_date = null;
      data.reminder_days = null;
      if (!input.category || input.category === '任务') data.category = '计划箱';
    } else if (!input.category || input.category === '计划箱') {
      data.category = '任务';
    }
  }
  if (effective.ddl_type !== 'none' && Object.hasOwn(data, 'reminder_days')) data.reminder_days = Number(data.reminder_days);
  if (Object.hasOwn(input, 'status') || Object.hasOwn(input, 'waiting_reply_person')) {
    data.waiting_reply_person = effective.status === 'waiting_reply'
      ? String(effective.waiting_reply_person).trim()
      : null;
  }
  if (Object.hasOwn(data, 'is_completed')) data.is_completed = parseBoolean(data.is_completed);
  return data;
}

function validateScheduleState(effective) {
  requiredText(effective.name, 'name');
  enumValue(effective.nature, SCHEDULE_NATURES, 'nature');
  if (compareDateTimes(effective.end_time, effective.start_time) <= 0) {
    throw validationError('end_time 必须晚于 start_time');
  }
}

export function normalizeScheduleCreate(input = {}) {
  const effective = {
    ...input,
    nature: input.nature ?? 'no_other_task',
  };
  validateScheduleState(effective);
  const linkedTodoIds = Array.isArray(input.linked_todo_ids) ? input.linked_todo_ids.map((value) => optionalId(value, 'linked_todo_ids')) : [];
  if (linkedTodoIds.length > 2) throw validationError('linked_todo_ids 最多只能包含 2 项');
  return {
    project_id: optionalId(input.project_id, 'project_id'),
    name: requiredText(input.name, 'name'),
    start_time: String(input.start_time),
    end_time: String(input.end_time),
    category: String(input.category || '普通日程'),
    nature: effective.nature,
    relax_suggestion: optionalText(input.relax_suggestion, 'relax_suggestion', 500),
    linked_todo_ids: linkedTodoIds,
    location: optionalText(input.location, 'location', 300),
    notes: String(input.notes ?? ''),
    is_planned: parseBoolean(input.is_planned, true),
  };
}

export function normalizeScheduleUpdate(input = {}, current) {
  if (!current) throw notFound('日程不存在');
  const effective = { ...current, ...input };
  validateScheduleState(effective);
  const data = {};
  if (Object.hasOwn(input, 'project_id')) data.project_id = optionalId(input.project_id, 'project_id');
  if (Object.hasOwn(input, 'name')) data.name = requiredText(input.name, 'name');
  for (const field of ['start_time', 'end_time', 'category', 'nature', 'notes']) {
    if (Object.hasOwn(input, field)) data[field] = input[field];
  }
  if (Object.hasOwn(input, 'relax_suggestion')) data.relax_suggestion = optionalText(input.relax_suggestion, 'relax_suggestion', 500);
  if (Object.hasOwn(input, 'location')) data.location = optionalText(input.location, 'location', 300);
  if (Object.hasOwn(input, 'linked_todo_ids')) {
    if (!Array.isArray(input.linked_todo_ids) || input.linked_todo_ids.length > 2) throw validationError('linked_todo_ids 必须是最多 2 项的数组');
    data.linked_todo_ids = input.linked_todo_ids.map((value) => optionalId(value, 'linked_todo_ids'));
  }
  if (Object.hasOwn(input, 'is_planned')) data.is_planned = parseBoolean(input.is_planned);
  return data;
}

export function normalizeRecurrenceRule(input = {}, current = null) {
  if (current && Object.hasOwn(input, 'entity_type') && input.entity_type !== current.entity_type) {
    throw validationError('重复规则的 entity_type 不可修改');
  }
  const merged = current ? { ...current, ...input, entity_type: current.entity_type } : { status: 'active', template_json: {}, ...input };
  const entityType = enumValue(merged.entity_type, RULE_ENTITY_TYPES, 'entity_type');
  const frequency = enumValue(merged.frequency, RULE_FREQUENCIES, 'frequency');
  const status = enumValue(merged.status ?? 'active', RULE_STATUSES, 'status');
  const startDate = dateOnly(merged.start_date, 'start_date');
  const endDate = merged.end_date == null || merged.end_date === '' ? null : dateOnly(merged.end_date, 'end_date');
  if (endDate && endDate < startDate) throw validationError('end_date 不能早于 start_date');
  let weekdays = null;
  let monthDay = null;
  if (frequency === 'weekly') {
    if (!Array.isArray(merged.weekdays) || !merged.weekdays.length) throw validationError('weekly 重复必须提供 weekdays');
    weekdays = [...new Set(merged.weekdays.map(Number))].sort((a, b) => a - b);
    if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw validationError('weekdays 必须使用 1-7，周一为 1');
    }
  }
  if (frequency === 'monthly') {
    monthDay = Number(merged.month_day);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) throw validationError('monthly 重复必须提供 1-31 的 month_day');
  }
  if (!merged.template_json || typeof merged.template_json !== 'object' || Array.isArray(merged.template_json)) {
    throw validationError('template_json 必须是对象');
  }
  const template = { ...merged.template_json };
  if (entityType === 'schedule') template.is_planned = true;
  return {
    entity_type: entityType,
    template_json: template,
    frequency,
    start_date: startDate,
    end_date: endDate,
    weekdays,
    month_day: monthDay,
    project_id: optionalId(merged.project_id, 'project_id'),
    status,
  };
}

export function recurrenceMatches(rule, day) {
  const candidate = dateOnly(day);
  if (candidate < dateOnly(rule.start_date)) return false;
  if (rule.end_date && candidate > dateOnly(rule.end_date)) return false;
  if (rule.frequency === 'daily') return true;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (rule.frequency === 'weekly') {
    const isoWeekday = parsed.getUTCDay() === 0 ? 7 : parsed.getUTCDay();
    return (rule.weekdays || []).map(Number).includes(isoWeekday);
  }
  if (rule.frequency === 'monthly') return parsed.getUTCDate() === Number(rule.month_day);
  return false;
}

export function recurrenceDays(dateFrom, dateTo, maxDays = 3660) {
  const start = dateOnly(dateFrom, 'date_from');
  const end = dateOnly(dateTo, 'date_to');
  if (end < start) throw validationError('date_to 不能早于 date_from');
  const result = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    result.push(cursor);
    if (result.length > maxDays) throw validationError(`重复生成窗口不能超过 ${maxDays} 天`);
  }
  return result;
}

function timePart(value, fallback) {
  if (!value) return fallback;
  const match = String(value).match(/(?:T|^)(\d{2}):(\d{2})(?::(\d{2}))?/);
  return match ? `${match[1]}:${match[2]}:${match[3] || '00'}` : fallback;
}

export function buildTodoFromRule(rule, day) {
  const template = { ...(rule.template_json || {}) };
  const ddlMode = template.ddl_mode || 'none';
  if (!['none', 'same_day_time', 'offset_days'].includes(ddlMode)) throw validationError('ddl_mode 的值无效');
  const ddlTime = timePart(template.ddl_time, '23:59:00');
  const ddlOffset = nonNegativeInteger(template.ddl_offset_days ?? 0, 'ddl_offset_days');
  delete template.recurrence;
  delete template.ddl_mode;
  delete template.ddl_time;
  delete template.ddl_offset_days;
  const data = normalizeTodoCreate({
    ...template,
    name: template.name || 'Recurring todo',
    project_id: rule.project_id,
    ddl_type: ddlMode === 'none' ? 'none' : (template.ddl_type === 'none' ? 'hard' : template.ddl_type || 'hard'),
    ddl_date: ddlMode === 'none' ? null : `${addDays(day, ddlMode === 'offset_days' ? ddlOffset : 0)}T${ddlTime}`,
    reminder_days: ddlMode === 'none' ? null : (template.reminder_days ?? 0),
  });
  return data;
}

export function buildScheduleFromRule(rule, day) {
  const template = { ...(rule.template_json || {}) };
  const startTemplate = template.start_time;
  const endTemplate = template.end_time;
  const startTime = `${day}T${timePart(startTemplate, '09:00:00')}`;
  let duration = 60 * 60 * 1000;
  if (startTemplate && endTemplate) {
    const computed = parseDateTime(endTemplate).getTime() - parseDateTime(startTemplate).getTime();
    if (computed > 0) duration = computed;
  }
  const endDate = new Date(parseDateTime(startTime).getTime() + duration);
  const endTime = formatBeijingDateTime(endDate);
  return normalizeScheduleCreate({
    ...template,
    name: template.name || 'Recurring schedule',
    project_id: rule.project_id,
    start_time: startTime,
    end_time: endTime,
    is_planned: true,
  });
}

export function timerElapsedSeconds(timer, at = new Date()) {
  if (!timer?.started_at) return 0;
  const end = timer.ended_at ? parseDateTime(timer.ended_at) : at;
  let paused = Number(timer.paused_seconds || 0);
  if (timer.status === 'paused' && timer.paused_at) {
    paused += Math.max(0, Math.floor((end.getTime() - parseDateTime(timer.paused_at).getTime()) / 1000));
  }
  return Math.max(0, Math.floor((end.getTime() - parseDateTime(timer.started_at).getTime()) / 1000) - paused);
}

export function isDdlNear(todo, at = new Date()) {
  if (todo.is_completed || !['hard', 'soft'].includes(todo.ddl_type) || !todo.ddl_date || todo.reminder_days == null) return false;
  return parseDateTime(todo.ddl_date).getTime() - at.getTime() <= Number(todo.reminder_days) * 86400000;
}

export function validateTemplateInput(input = {}, current = null) {
  const name = Object.hasOwn(input, 'name') ? requiredText(input.name, 'name') : current?.name;
  if (!name) throw validationError('name 不能为空');
  return {
    ...(Object.hasOwn(input, 'name') ? { name } : {}),
    ...(Object.hasOwn(input, 'content') ? { content: String(input.content ?? '') } : {}),
  };
}
