const REQUIRED_PLATFORMS = Object.freeze({
  web: 'required',
  android: 'required',
});

export const TRANSACTION = Object.freeze({
  READ_ONLY: 'read-only',
  SINGLE_WRITE: 'single-write',
  ATOMIC_MULTI_WRITE: 'atomic-multi-write',
  SERIALIZED_ATOMIC: 'serialized-atomic',
  SECURE_WRITE: 'secure-write',
  NETWORK: 'network',
  NETWORK_AND_WRITE: 'network-and-write',
});

const COMMON_READ_ERRORS = Object.freeze(['NOT_FOUND', 'VALIDATION_ERROR', 'INTERNAL_ERROR']);
const COMMON_WRITE_ERRORS = Object.freeze(['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR']);
const NETWORK_ERRORS = Object.freeze([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NETWORK_ERROR',
  'REQUEST_ABORTED',
  'INTERNAL_ERROR',
]);

function defineCapability({
  id,
  method,
  pathTemplate,
  query = null,
  body = null,
  response,
  successStatus = 200,
  errors = COMMON_READ_ERRORS,
  transaction = TRANSACTION.READ_ONLY,
  platform = REQUIRED_PLATFORMS,
}) {
  return Object.freeze({
    id,
    method,
    pathTemplate,
    query,
    body,
    response,
    successStatus,
    errors,
    transaction,
    platform,
  });
}

/**
 * Canonical public API contract.
 *
 * `platform.* = "required"` describes the v0.8 target contract. It is not an
 * implementation-status claim. Android support is verified separately by the
 * adapter contract tests.
 */
export const CAPABILITIES = Object.freeze([
  // Projects (6)
  defineCapability({ id: 'projects.list', method: 'GET', pathTemplate: '/projects', query: ['status?', 'include_hidden?'], response: 'ProjectOut[]' }),
  defineCapability({ id: 'projects.get', method: 'GET', pathTemplate: '/projects/{projectId}', response: 'ProjectOut' }),
  defineCapability({ id: 'projects.overview', method: 'GET', pathTemplate: '/projects/{projectId}/overview', response: 'ProjectOverview' }),
  defineCapability({ id: 'projects.create', method: 'POST', pathTemplate: '/projects', body: 'ProjectCreate', response: 'ProjectOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'projects.update', method: 'PUT', pathTemplate: '/projects/{projectId}', body: 'ProjectUpdate', response: 'ProjectOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'projects.delete', method: 'DELETE', pathTemplate: '/projects/{projectId}', response: 'null', successStatus: 204, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),

  // Todos (9)
  defineCapability({ id: 'todos.list', method: 'GET', pathTemplate: '/todos', query: ['category?', 'status?', 'is_completed?', 'project_id?'], response: 'TodoOut[]' }),
  defineCapability({ id: 'todos.get', method: 'GET', pathTemplate: '/todos/{todoId}', response: 'TodoOut' }),
  defineCapability({ id: 'todos.create', method: 'POST', pathTemplate: '/todos', body: 'TodoCreate', response: 'TodoOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'todos.update', method: 'PUT', pathTemplate: '/todos/{todoId}', body: 'TodoUpdate', response: 'TodoOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'todos.complete', method: 'POST', pathTemplate: '/todos/{todoId}/complete', body: 'TodoCompleteRequest', response: 'TodoOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'todos.delete', method: 'DELETE', pathTemplate: '/todos/{todoId}', response: 'null', successStatus: 204, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'todos.focusing', method: 'GET', pathTemplate: '/todos/focusing', response: 'TodoOut[]' }),
  defineCapability({ id: 'todos.waitingReply', method: 'GET', pathTemplate: '/todos/waiting-reply', response: 'TodoOut[]' }),
  defineCapability({ id: 'todos.ddlNear', method: 'GET', pathTemplate: '/todos/ddl-near', response: 'TodoOut[]' }),

  // Schedules (7)
  defineCapability({ id: 'schedules.list', method: 'GET', pathTemplate: '/schedules', query: ['is_planned?', 'date_from?', 'date_to?', 'project_id?'], response: 'ScheduleOut[]' }),
  defineCapability({ id: 'schedules.get', method: 'GET', pathTemplate: '/schedules/{scheduleId}', response: 'ScheduleOut' }),
  defineCapability({ id: 'schedules.create', method: 'POST', pathTemplate: '/schedules', body: 'ScheduleCreate', response: 'ScheduleOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'schedules.update', method: 'PUT', pathTemplate: '/schedules/{scheduleId}', body: 'ScheduleUpdate', response: 'ScheduleOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'schedules.delete', method: 'DELETE', pathTemplate: '/schedules/{scheduleId}', response: 'null', successStatus: 204, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'schedules.current', method: 'GET', pathTemplate: '/schedules/current', response: 'ScheduleOut|null' }),
  defineCapability({ id: 'schedules.week', method: 'GET', pathTemplate: '/schedules/week', query: ['start_date'], response: 'ScheduleOut[]', errors: Object.freeze(['VALIDATION_ERROR', 'INTERNAL_ERROR']) }),

  // Recurrence rules (8)
  defineCapability({ id: 'recurrence.list', method: 'GET', pathTemplate: '/recurrence-rules', query: ['entity_type?', 'include_archived?'], response: 'RecurrenceRuleOut[]' }),
  defineCapability({ id: 'recurrence.get', method: 'GET', pathTemplate: '/recurrence-rules/{ruleId}', response: 'RecurrenceRuleOut' }),
  defineCapability({ id: 'recurrence.create', method: 'POST', pathTemplate: '/recurrence-rules', body: 'RecurrenceRuleCreate', response: 'RecurrenceRuleOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'recurrence.update', method: 'PUT', pathTemplate: '/recurrence-rules/{ruleId}', body: 'RecurrenceRuleUpdate', response: 'RecurrenceRuleOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'recurrence.syncTodo', method: 'POST', pathTemplate: '/recurrence-rules/from-todo/{todoId}/sync', body: 'TodoUpdate', response: 'TodoOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'recurrence.syncSchedule', method: 'POST', pathTemplate: '/recurrence-rules/from-schedule/{scheduleId}/sync', body: 'ScheduleUpdate', response: 'ScheduleOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'recurrence.delete', method: 'DELETE', pathTemplate: '/recurrence-rules/{ruleId}', query: ['delete_future_instances?'], response: 'null', successStatus: 204, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'recurrence.generate', method: 'POST', pathTemplate: '/recurrence-rules/generate', body: 'RecurrenceGenerateRequest', response: 'RecurrenceGenerateOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),

  // Timer (9)
  defineCapability({ id: 'timer.current', method: 'GET', pathTemplate: '/timer/current', response: 'TimerOut|null' }),
  defineCapability({ id: 'timer.start', method: 'POST', pathTemplate: '/timer/start', body: 'TimerStart', response: 'TimerOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'timer.updateCurrent', method: 'PUT', pathTemplate: '/timer/current', body: 'TimerUpdate', response: 'TimerOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'timer.pause', method: 'POST', pathTemplate: '/timer/pause', response: 'TimerOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'timer.resume', method: 'POST', pathTemplate: '/timer/resume', response: 'TimerOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'timer.finish', method: 'POST', pathTemplate: '/timer/finish', response: 'TimerOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'timer.cancel', method: 'POST', pathTemplate: '/timer/cancel', response: 'TimerOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),
  defineCapability({ id: 'timer.attachSchedule', method: 'POST', pathTemplate: '/timer/{timerId}/schedule', body: 'TimerAttachSchedule', response: 'TimerOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'timer.recent', method: 'GET', pathTemplate: '/timer/recent', query: ['limit?'], response: 'TimerOut[]', errors: Object.freeze(['VALIDATION_ERROR', 'INTERNAL_ERROR']) }),

  // Daily logs (3)
  defineCapability({ id: 'logs.list', method: 'GET', pathTemplate: '/logs', query: ['date_from?', 'date_to?'], response: 'DailyLogOut[]' }),
  defineCapability({ id: 'logs.get', method: 'GET', pathTemplate: '/logs/{logDate}', response: 'DailyLogOut' }),
  defineCapability({ id: 'logs.upsert', method: 'POST', pathTemplate: '/logs', body: 'DailyLogCreate', response: 'DailyLogOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SERIALIZED_ATOMIC }),

  // Log templates (4)
  defineCapability({ id: 'templates.list', method: 'GET', pathTemplate: '/templates', response: 'LogTemplateOut[]' }),
  defineCapability({ id: 'templates.create', method: 'POST', pathTemplate: '/templates', body: 'LogTemplateCreate', response: 'LogTemplateOut', successStatus: 201, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'templates.update', method: 'PUT', pathTemplate: '/templates/{templateId}', body: 'LogTemplateUpdate', response: 'LogTemplateOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),
  defineCapability({ id: 'templates.delete', method: 'DELETE', pathTemplate: '/templates/{templateId}', response: 'null', successStatus: 204, errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),

  // ZJU read-only integration (15)
  defineCapability({ id: 'zju.getCredentials', method: 'GET', pathTemplate: '/zju/credentials', response: 'ZjuCredentialOut' }),
  defineCapability({ id: 'zju.saveCredentials', method: 'PUT', pathTemplate: '/zju/credentials', body: 'ZjuCredentialIn', response: 'ZjuCredentialOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SECURE_WRITE }),
  defineCapability({ id: 'zju.clearPassword', method: 'DELETE', pathTemplate: '/zju/credentials/password', response: 'ZjuCredentialOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SECURE_WRITE }),
  defineCapability({ id: 'zju.clearPintiaCookie', method: 'DELETE', pathTemplate: '/zju/credentials/pintia', response: 'ZjuCredentialOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SECURE_WRITE }),
  defineCapability({ id: 'zju.preview', method: 'POST', pathTemplate: '/zju/preview', body: 'ZjuPreviewRequest', response: 'ZjuPreviewOut', errors: NETWORK_ERRORS, transaction: TRANSACTION.NETWORK_AND_WRITE }),
  defineCapability({ id: 'zju.importTodos', method: 'POST', pathTemplate: '/zju/import', body: 'ZjuImportRequest', response: 'ZjuImportOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'zju.undoLast', method: 'POST', pathTemplate: '/zju/undo-last', response: 'ZjuUndoOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'zju.getCalendarCache', method: 'GET', pathTemplate: '/zju/calendar/cache', query: ['academic_year', 'semester'], response: 'ZjuCalendarCacheOut' }),
  defineCapability({ id: 'zju.fetchCalendar', method: 'POST', pathTemplate: '/zju/calendar/fetch', body: 'ZjuCalendarFetchRequest', response: 'ZjuCalendarCacheOut', errors: NETWORK_ERRORS, transaction: TRANSACTION.NETWORK_AND_WRITE }),
  defineCapability({ id: 'zju.previewSchedule', method: 'POST', pathTemplate: '/zju/schedule/preview', body: 'ZjuSchedulePreviewRequest', response: 'ZjuSchedulePreviewOut', errors: NETWORK_ERRORS, transaction: TRANSACTION.NETWORK }),
  defineCapability({ id: 'zju.importSchedule', method: 'POST', pathTemplate: '/zju/schedule/import', body: 'ZjuScheduleImportRequest', response: 'ZjuScheduleImportOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'zju.undoLastSchedule', method: 'POST', pathTemplate: '/zju/schedule/undo-last', response: 'ZjuUndoOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.ATOMIC_MULTI_WRITE }),
  defineCapability({ id: 'zju.getGradeCache', method: 'GET', pathTemplate: '/zju/grades/cache', query: ['strategy?'], response: 'ZjuGradeOut' }),
  defineCapability({ id: 'zju.fetchGrades', method: 'POST', pathTemplate: '/zju/grades/fetch', body: 'ZjuGradeFetchRequest', response: 'ZjuGradeOut', errors: NETWORK_ERRORS, transaction: TRANSACTION.NETWORK_AND_WRITE }),
  defineCapability({ id: 'zju.clearGradeCache', method: 'POST', pathTemplate: '/zju/grades/clear-cache', response: 'ZjuGradeOut', errors: COMMON_WRITE_ERRORS, transaction: TRANSACTION.SINGLE_WRITE }),

  // Data portability (3)
  defineCapability({ id: 'data.export', method: 'GET', pathTemplate: '/data/export', response: 'DataPackage' }),
  defineCapability({ id: 'data.previewImport', method: 'POST', pathTemplate: '/data/import/preview', body: 'DataImportRequest', response: 'DataImportPreview', errors: Object.freeze(['VALIDATION_ERROR', 'INVALID_DATA_PACKAGE', 'INTERNAL_ERROR']) }),
  defineCapability({ id: 'data.import', method: 'POST', pathTemplate: '/data/import', body: 'DataImportRequest', response: 'DataImportResult', errors: Object.freeze(['VALIDATION_ERROR', 'INVALID_DATA_PACKAGE', 'CONFLICT', 'INTERNAL_ERROR']), transaction: TRANSACTION.SERIALIZED_ATOMIC }),

  // Health (1)
  defineCapability({ id: 'health.check', method: 'GET', pathTemplate: '/health', response: 'HealthOut', errors: Object.freeze(['NETWORK_ERROR', 'INTERNAL_ERROR']) }),
]);

export const CAPABILITIES_BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));

function normalizePathname(pathname) {
  let parsed;
  try {
    parsed = new URL(pathname, 'https://riji.local').pathname;
  } catch (_) {
    parsed = String(pathname || '').split(/[?#]/, 1)[0];
  }
  if (!parsed.startsWith('/')) parsed = `/${parsed}`;
  return parsed.length > 1 ? parsed.replace(/\/+$/, '') : parsed;
}

function compileTemplate(pathTemplate) {
  const names = [];
  const normalized = decodeURIComponent(normalizePathname(pathTemplate));
  const pattern = normalized
    .split('/')
    .map((segment) => {
      const placeholder = segment.match(/^\{([A-Za-z][A-Za-z0-9_]*)\}$/);
      if (placeholder) {
        names.push(placeholder[1]);
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { names, regex: new RegExp(`^${pattern}$`) };
}

const MATCHERS = CAPABILITIES
  .map((capability, index) => {
    const compiled = compileTemplate(capability.pathTemplate);
    return {
      capability,
      index,
      ...compiled,
      dynamicCount: compiled.names.length,
      segmentCount: normalizePathname(capability.pathTemplate).split('/').length,
    };
  })
  .sort((left, right) => (
    left.dynamicCount - right.dynamicCount
    || right.segmentCount - left.segmentCount
    || left.index - right.index
  ));

export function getCapability(capabilityId) {
  return CAPABILITIES_BY_ID.get(capabilityId) || null;
}

/** Match an HTTP method and pathname, ignoring query strings and trailing slashes. */
export function matchCapability(method, pathname) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = normalizePathname(pathname);
  for (const matcher of MATCHERS) {
    if (matcher.capability.method !== normalizedMethod) continue;
    const match = normalizedPath.match(matcher.regex);
    if (!match) continue;
    const params = Object.fromEntries(matcher.names.map((name, index) => {
      const raw = match[index + 1];
      try {
        return [name, decodeURIComponent(raw)];
      } catch (_) {
        return [name, raw];
      }
    }));
    return Object.freeze({ capability: matcher.capability, params: Object.freeze(params) });
  }
  return null;
}

export { normalizePathname };
