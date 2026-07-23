const BASE_URL = '/api';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };

  const res = await fetch(url, config);
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || '请求失败');
  }
  return res.json();
}

// ============ Projects ============
export const projectApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.set(k, v);
    });
    return request(`/projects/?${qs.toString()}`);
  },
  get: (id) => request(`/projects/${id}`),
  overview: (id) => request(`/projects/${id}/overview`),
  create: (data) => request('/projects/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
};
// ============ Todos ============
export const todoApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.set(k, v);
    });
    return request(`/todos/?${qs.toString()}`);
  },
  get: (id) => request(`/todos/${id}`),
  create: (data) => request('/todos/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => request(`/todos/${id}`, { method: 'DELETE' }),
  focusing: () => request('/todos/focusing'),
  waitingReply: () => request('/todos/waiting-reply'),
  ddlNear: () => request('/todos/ddl-near'),
};

// ============ Schedules ============
export const scheduleApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.set(k, v);
    });
    return request(`/schedules/?${qs.toString()}`);
  },
  get: (id) => request(`/schedules/${id}`),
  create: (data) => request('/schedules/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => request(`/schedules/${id}`, { method: 'DELETE' }),
  current: () => request('/schedules/current'),
  week: (startDate) => request(`/schedules/week/?start_date=${startDate.toISOString()}`),
};

// ============ DailyLog ============
export const logApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.set(k, v);
    });
    return request(`/logs/?${qs.toString()}`);
  },
  get: (date) => request(`/logs/${date}`),
  upsert: (data) => request('/logs/', { method: 'POST', body: JSON.stringify(data) }),
};

// ============ LogTemplate ============
export const templateApi = {
  list: () => request('/templates'),
  create: (data) => request('/templates', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
};

// ============ ZJU Todo Import ============
export const zjuApi = {
  getCredentials: () => request('/zju/credentials'),
  saveCredentials: (data) => request('/zju/credentials', { method: 'PUT', body: JSON.stringify(data) }),
  clearPassword: () => request('/zju/credentials/password', { method: 'DELETE' }),
  clearPintiaCookie: () => request('/zju/credentials/pintia', { method: 'DELETE' }),
  preview: (data) => request('/zju/preview', { method: 'POST', body: JSON.stringify(data) }),
  importTodos: (data) => request('/zju/import', { method: 'POST', body: JSON.stringify(data) }),
  undoLast: () => request('/zju/undo-last', { method: 'POST' }),
  getCalendarCache: ({ academic_year, semester }) => {
    const qs = new URLSearchParams({ academic_year, semester });
    return request(`/zju/calendar/cache?${qs.toString()}`);
  },
  fetchCalendar: (data) => request('/zju/calendar/fetch', { method: 'POST', body: JSON.stringify(data) }),
  previewSchedule: (data) => request('/zju/schedule/preview', { method: 'POST', body: JSON.stringify(data) }),
  importSchedule: (data) => request('/zju/schedule/import', { method: 'POST', body: JSON.stringify(data) }),
  undoLastSchedule: () => request('/zju/schedule/undo-last', { method: 'POST' }),
  getGradeCache: (strategy = 'scholarship') => request(`/zju/grades/cache?${new URLSearchParams({ strategy }).toString()}`),
  fetchGrades: (data) => request('/zju/grades/fetch', { method: 'POST', body: JSON.stringify(data) }),
  clearGradeCache: () => request('/zju/grades/clear-cache', { method: 'POST' }),
};

// ============ Health ============
export const healthApi = {
  check: () => request('/health/'),
};
