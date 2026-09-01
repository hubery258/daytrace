import { projectRequest, todoRequest } from './projectsTodos.js';
import { scheduleRequest } from './schedules.js';
import { recurrenceRequest } from './recurrence.js';
import { logRequest, templateRequest, timerRequest } from './support.js';
import { portabilityRequest } from './portability.js';
import { mobileError, validationError } from './domain.js';
import { zjuRequest } from './zju.js';
const COLLECTION_PATHS = new Set([
  '/health',
  '/projects',
  '/todos',
  '/schedules',
  '/schedules/week',
  '/recurrence-rules',
  '/logs',
]);


function parseBody(options) {
  if (options.body == null || options.body === '') return {};
  if (typeof options.body === 'object') return options.body;
  try {
    const parsed = JSON.parse(options.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw validationError('请求体不是有效的 JSON 对象');
  }
}

export async function mobileRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = parseBody(options);
  const url = new URL(path, 'https://riji.local');
  const rawPathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const pathname = COLLECTION_PATHS.has(rawPathname) ? `${rawPathname}/` : rawPathname;
  const handlers = [
    projectRequest,
    todoRequest,
    scheduleRequest,
    recurrenceRequest,
    logRequest,
    timerRequest,
  ];
  for (const handler of handlers) {
    const value = await handler(method, pathname, url.searchParams, body);
    if (value !== undefined) return value;
  }
  const templateValue = await templateRequest(method, pathname, body);
  if (templateValue !== undefined) return templateValue;
  const portabilityValue = await portabilityRequest(method, pathname, body);
  if (portabilityValue !== undefined) return portabilityValue;
  const zjuValue = await zjuRequest(method, pathname, url.searchParams, body);
  if (zjuValue !== undefined) return zjuValue;
  if (method === 'GET' && pathname === '/health/') {
    return { status: 'ok', storage: 'capacitor-sqlite', schema_version: '0.8.0' };
  }
  throw mobileError(501, 'NOT_IMPLEMENTED', `Android 本地数据层未实现：${method} ${pathname}`);
}
