export * from './clientCore.js';

import { Capacitor } from '@capacitor/core';

const BASE_URL = '/api';
async function requestTimeBlock(path, options = {}) {
  if (Capacitor.isNativePlatform()) {
    const { mobileRequest } = await import('../data/mobileDatabase.js');
    return mobileRequest(path, options);
  }
  const response = await fetch(`${BASE_URL}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || '请求失败');
  return payload;
}

// v0.10 actual time-block endpoints are kept as an additive API while the
// v0.8 capability manifest remains stable for the shared Android contract.
export const timeBlockApi = {
  list: (dateFrom, dateTo = dateFrom) => requestTimeBlock('/time-blocks/?' + new URLSearchParams({ date_from: dateFrom, date_to: dateTo })),
  replaceRange: (data) => requestTimeBlock('/time-blocks/range', { method: 'PUT', body: JSON.stringify(data) }),
  categories: () => requestTimeBlock('/time-blocks/categories'),
  createCategory: (data) => requestTimeBlock('/time-blocks/categories', { method: 'POST', body: JSON.stringify(data) }),
  updateCategory: (id, data) => requestTimeBlock('/time-blocks/categories/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCategory: (id) => requestTimeBlock('/time-blocks/categories/' + id, { method: 'DELETE' }),
  fromTimer: (timerId, data) => requestTimeBlock('/time-blocks/from-timer/' + timerId, { method: 'POST', body: JSON.stringify(data) }),
};
