/**
 * 将 datetime-local 输入值转为后端可接收的 ISO 字符串。
 * 不携带时区信息，后端当作本地时间（北京时间）直接存储和返回。
 */
export const BEIJING_TIME_ZONE = 'Asia/Shanghai';

export function toLocalISO(datetimeLocalValue) {
  if (!datetimeLocalValue) return null;
  return datetimeLocalValue + ':00';
}

/**
 * 将后端返回的 naive datetime 字符串（无时区）当作北京时间解析为 Date。
 */
export function parseAsLocal(datetimeStr) {
  if (!datetimeStr) return new Date();
  // 如果字符串已带时区标记（Z/+08:00），直接 parse
  if (datetimeStr.endsWith('Z') || datetimeStr.includes('+') || datetimeStr.includes('-', 10)) {
    return new Date(datetimeStr);
  }
  // 否则是 naive 时间，当作北京时间
  return new Date(datetimeStr + '+08:00');
}

/**
 * 获取今天的日期字符串 YYYY-MM-DD（北京时间）。
 */
export function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function dateStrInBeijing(datetimeStr) {
  if (!datetimeStr) return todayStr();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(datetimeStr)) return datetimeStr.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parseAsLocal(datetimeStr));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * 格式化时间为 HH:MM（北京时间）。
 */
export function formatTime(datetimeStr) {
  const d = parseAsLocal(datetimeStr);
  return d.toLocaleTimeString('zh-CN', { timeZone: BEIJING_TIME_ZONE, hour: '2-digit', minute: '2-digit' });
}

/**
 * 格式化日期为 YYYY年M月D日（北京时间）。
 */
export function formatDate(datetimeStr) {
  const d = parseAsLocal(datetimeStr);
  return d.toLocaleDateString('zh-CN', { timeZone: BEIJING_TIME_ZONE, month: 'long', day: 'numeric', weekday: 'short' });
}

/**
 * 获取某天 00:00:00 的北京时间 Date 对象。
 */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 获取某天 23:59:59 的北京时间 Date 对象。
 */
export function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}
