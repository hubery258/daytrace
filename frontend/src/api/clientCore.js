import { Capacitor } from '@capacitor/core';

import { getCapability, matchCapability } from './capabilities.js';
import {
  ApiError,
  createHttpApiError,
  createInvalidResponseError,
  normalizeApiError,
} from './errors.js';

const BASE_URL = '/api';
const BOUND_CAPABILITY = Symbol('boundCapability');

function contractError(message, capabilityId, detail = null) {
  return new ApiError(message, {
    code: 'CONTRACT_CONFIGURATION_ERROR',
    detail,
    capabilityId,
  });
}

function assertRequestMatchesCapability(capabilityId, path, options) {
  const capability = getCapability(capabilityId);
  if (!capability) throw contractError(`未知 API 能力：${capabilityId}`, capabilityId);
  const method = String(options?.method || 'GET').toUpperCase();
  const match = matchCapability(method, path);
  if (!match || match.capability.id !== capabilityId) {
    throw contractError(
      `API 能力与请求路径不匹配：${capabilityId}`,
      capabilityId,
      { method, path, matchedCapabilityId: match?.capability.id || null },
    );
  }
  return capability;
}

async function readResponseText(response, capabilityId) {
  try {
    return await response.text();
  } catch (error) {
    throw normalizeApiError(error, {
      capabilityId,
      defaultCode: 'RESPONSE_READ_ERROR',
      defaultMessage: '读取服务响应失败',
    });
  }
}

async function webRequest(capabilityId, path, options) {
  const url = `${BASE_URL}${path}`;
  const { headers: suppliedHeaders = {}, ...rest } = options;
  const config = {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...suppliedHeaders },
  };

  let response;
  try {
    response = await fetch(url, config);
  } catch (error) {
    throw normalizeApiError(error, {
      capabilityId,
      defaultCode: 'NETWORK_ERROR',
      defaultMessage: '网络连接失败',
    });
  }

  if (response.status === 204) return null;
  const text = await readResponseText(response, capabilityId);
  let payload = null;
  let parseError = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      parseError = error;
    }
  }

  if (!response.ok) {
    if (parseError) payload = { detail: text || response.statusText };
    throw createHttpApiError({
      status: response.status,
      statusText: response.statusText,
      payload,
      capabilityId,
    });
  }
  if (!text || parseError) {
    throw createInvalidResponseError({ detail: text || null, capabilityId, cause: parseError || undefined });
  }
  return payload;
}

async function request(capabilityId, path, options = {}) {
  assertRequestMatchesCapability(capabilityId, path, options);
  if (Capacitor.isNativePlatform()) {
    try {
      const { mobileRequest } = await import('../data/mobileDatabase.js');
      return await mobileRequest(path, options);
    } catch (error) {
      throw normalizeApiError(error, {
        capabilityId,
        defaultCode: 'MOBILE_DATA_ERROR',
        defaultMessage: '安卓本地数据操作失败',
      });
    }
  }
  return webRequest(capabilityId, path, options);
}

function bindCapability(capabilityId, buildRequest) {
  if (!getCapability(capabilityId)) throw contractError(`未知 API 能力：${capabilityId}`, capabilityId);
  const bound = (...args) => {
    const spec = buildRequest(...args);
    return request(capabilityId, spec.path, spec.options || {});
  };
  Object.defineProperty(bound, BOUND_CAPABILITY, { value: capabilityId });
  return bound;
}

function queryPath(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, value);
  });
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function jsonOptions(method, data) {
  return { method, body: JSON.stringify(data) };
}

export const projectApi = {
  list: bindCapability('projects.list', (params = {}) => ({ path: queryPath('/projects/', params) })),
  get: bindCapability('projects.get', (id) => ({ path: `/projects/${id}` })),
  overview: bindCapability('projects.overview', (id) => ({ path: `/projects/${id}/overview` })),
  create: bindCapability('projects.create', (data) => ({ path: '/projects/', options: jsonOptions('POST', data) })),
  update: bindCapability('projects.update', (id, data) => ({ path: `/projects/${id}`, options: jsonOptions('PUT', data) })),
  delete: bindCapability('projects.delete', (id) => ({ path: `/projects/${id}`, options: { method: 'DELETE' } })),
};

export const todoApi = {
  list: bindCapability('todos.list', (params = {}) => ({ path: queryPath('/todos/', params) })),
  get: bindCapability('todos.get', (id) => ({ path: `/todos/${id}` })),
  create: bindCapability('todos.create', (data) => ({ path: '/todos/', options: jsonOptions('POST', data) })),
  update: bindCapability('todos.update', (id, data) => ({ path: `/todos/${id}`, options: jsonOptions('PUT', data) })),
  complete: bindCapability('todos.complete', (id, logDate) => ({ path: `/todos/${id}/complete`, options: jsonOptions('POST', { log_date: logDate }) })),
  delete: bindCapability('todos.delete', (id) => ({ path: `/todos/${id}`, options: { method: 'DELETE' } })),
  focusing: bindCapability('todos.focusing', () => ({ path: '/todos/focusing' })),
  waitingReply: bindCapability('todos.waitingReply', () => ({ path: '/todos/waiting-reply' })),
  ddlNear: bindCapability('todos.ddlNear', () => ({ path: '/todos/ddl-near' })),
};

export const scheduleApi = {
  list: bindCapability('schedules.list', (params = {}) => ({ path: queryPath('/schedules/', params) })),
  get: bindCapability('schedules.get', (id) => ({ path: `/schedules/${id}` })),
  create: bindCapability('schedules.create', (data) => ({ path: '/schedules/', options: jsonOptions('POST', data) })),
  update: bindCapability('schedules.update', (id, data) => ({ path: `/schedules/${id}`, options: jsonOptions('PUT', data) })),
  delete: bindCapability('schedules.delete', (id) => ({ path: `/schedules/${id}`, options: { method: 'DELETE' } })),
  current: bindCapability('schedules.current', () => ({ path: '/schedules/current' })),
  week: bindCapability('schedules.week', (startDate) => ({ path: queryPath('/schedules/week/', { start_date: startDate.toISOString() }) })),
};

export const recurrenceApi = {
  list: bindCapability('recurrence.list', (params = {}) => ({ path: queryPath('/recurrence-rules/', params) })),
  get: bindCapability('recurrence.get', (id) => ({ path: `/recurrence-rules/${id}` })),
  create: bindCapability('recurrence.create', (data) => ({ path: '/recurrence-rules/', options: jsonOptions('POST', data) })),
  update: bindCapability('recurrence.update', (id, data) => ({ path: `/recurrence-rules/${id}`, options: jsonOptions('PUT', data) })),
  syncTodo: bindCapability('recurrence.syncTodo', (todoId, data) => ({ path: `/recurrence-rules/from-todo/${todoId}/sync`, options: jsonOptions('POST', data) })),
  syncSchedule: bindCapability('recurrence.syncSchedule', (scheduleId, data) => ({ path: `/recurrence-rules/from-schedule/${scheduleId}/sync`, options: jsonOptions('POST', data) })),
  delete: bindCapability('recurrence.delete', (id, deleteFutureInstances = false) => ({
    path: queryPath(`/recurrence-rules/${id}`, { delete_future_instances: deleteFutureInstances }),
    options: { method: 'DELETE' },
  })),
  generate: bindCapability('recurrence.generate', (data) => ({ path: '/recurrence-rules/generate', options: jsonOptions('POST', data) })),
};

export const timerApi = {
  current: bindCapability('timer.current', () => ({ path: '/timer/current' })),
  start: bindCapability('timer.start', (data) => ({ path: '/timer/start', options: jsonOptions('POST', data) })),
  updateCurrent: bindCapability('timer.updateCurrent', (data) => ({ path: '/timer/current', options: jsonOptions('PUT', data) })),
  pause: bindCapability('timer.pause', () => ({ path: '/timer/pause', options: { method: 'POST' } })),
  resume: bindCapability('timer.resume', () => ({ path: '/timer/resume', options: { method: 'POST' } })),
  finish: bindCapability('timer.finish', () => ({ path: '/timer/finish', options: { method: 'POST' } })),
  cancel: bindCapability('timer.cancel', () => ({ path: '/timer/cancel', options: { method: 'POST' } })),
  attachSchedule: bindCapability('timer.attachSchedule', (timerId, scheduleId) => ({
    path: `/timer/${timerId}/schedule`,
    options: jsonOptions('POST', { schedule_id: scheduleId }),
  })),
  recent: bindCapability('timer.recent', (limit = 10) => ({ path: queryPath('/timer/recent', { limit }) })),
};

export const logApi = {
  list: bindCapability('logs.list', (params = {}) => ({ path: queryPath('/logs/', params) })),
  get: bindCapability('logs.get', (date) => ({ path: `/logs/${date}` })),
  upsert: bindCapability('logs.upsert', (data) => ({ path: '/logs/', options: jsonOptions('POST', data) })),
};

export const templateApi = {
  list: bindCapability('templates.list', () => ({ path: '/templates' })),
  create: bindCapability('templates.create', (data) => ({ path: '/templates', options: jsonOptions('POST', data) })),
  update: bindCapability('templates.update', (id, data) => ({ path: `/templates/${id}`, options: jsonOptions('PUT', data) })),
  delete: bindCapability('templates.delete', (id) => ({ path: `/templates/${id}`, options: { method: 'DELETE' } })),
};

export const zjuApi = {
  getCredentials: bindCapability('zju.getCredentials', () => ({ path: '/zju/credentials' })),
  saveCredentials: bindCapability('zju.saveCredentials', (data) => ({ path: '/zju/credentials', options: jsonOptions('PUT', data) })),
  clearPassword: bindCapability('zju.clearPassword', () => ({ path: '/zju/credentials/password', options: { method: 'DELETE' } })),
  clearPintiaCookie: bindCapability('zju.clearPintiaCookie', () => ({ path: '/zju/credentials/pintia', options: { method: 'DELETE' } })),
  preview: bindCapability('zju.preview', (data) => ({ path: '/zju/preview', options: jsonOptions('POST', data) })),
  importTodos: bindCapability('zju.importTodos', (data) => ({ path: '/zju/import', options: jsonOptions('POST', data) })),
  undoLast: bindCapability('zju.undoLast', () => ({ path: '/zju/undo-last', options: { method: 'POST' } })),
  getCalendarCache: bindCapability('zju.getCalendarCache', ({ academic_year, semester }) => ({ path: queryPath('/zju/calendar/cache', { academic_year, semester }) })),
  fetchCalendar: bindCapability('zju.fetchCalendar', (data) => ({ path: '/zju/calendar/fetch', options: jsonOptions('POST', data) })),
  previewSchedule: bindCapability('zju.previewSchedule', (data) => ({ path: '/zju/schedule/preview', options: jsonOptions('POST', data) })),
  importSchedule: bindCapability('zju.importSchedule', (data) => ({ path: '/zju/schedule/import', options: jsonOptions('POST', data) })),
  undoLastSchedule: bindCapability('zju.undoLastSchedule', () => ({ path: '/zju/schedule/undo-last', options: { method: 'POST' } })),
  getGradeCache: bindCapability('zju.getGradeCache', (strategy = 'scholarship') => ({ path: queryPath('/zju/grades/cache', { strategy }) })),
  fetchGrades: bindCapability('zju.fetchGrades', (data) => ({ path: '/zju/grades/fetch', options: jsonOptions('POST', data) })),
  clearGradeCache: bindCapability('zju.clearGradeCache', () => ({ path: '/zju/grades/clear-cache', options: { method: 'POST' } })),
};

export const dataApi = {
  export: bindCapability('data.export', () => ({ path: '/data/export' })),
  previewImport: bindCapability('data.previewImport', (dataPackage, mode = 'merge') => ({ path: '/data/import/preview', options: jsonOptions('POST', { package: dataPackage, mode }) })),
  import: bindCapability('data.import', (dataPackage, mode = 'merge') => ({ path: '/data/import', options: jsonOptions('POST', { package: dataPackage, mode }) })),
};

export const healthApi = {
  check: bindCapability('health.check', () => ({ path: '/health/' })),
};

function bindingMap(api) {
  return Object.freeze(Object.fromEntries(Object.entries(api).map(([methodName, fn]) => {
    const capabilityId = fn?.[BOUND_CAPABILITY];
    if (!capabilityId) throw contractError(`客户端方法未绑定 API 能力：${methodName}`, null);
    return [methodName, capabilityId];
  })));
}

export const clientCapabilityBindings = Object.freeze({
  projectApi: bindingMap(projectApi),
  todoApi: bindingMap(todoApi),
  scheduleApi: bindingMap(scheduleApi),
  recurrenceApi: bindingMap(recurrenceApi),
  timerApi: bindingMap(timerApi),
  logApi: bindingMap(logApi),
  templateApi: bindingMap(templateApi),
  zjuApi: bindingMap(zjuApi),
  dataApi: bindingMap(dataApi),
  healthApi: bindingMap(healthApi),
});
