/**
 * 将 datetime-local 输入值转为后端可接收的 ISO 字符串。
 * 不携带时区信息，后端当作本地时间（北京时间）直接存储和返回。
 */
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
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 格式化时间为 HH:MM（北京时间）。
 */
export function formatTime(datetimeStr) {
  const d = parseAsLocal(datetimeStr);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 格式化日期为 YYYY年M月D日（北京时间）。
 */
export function formatDate(datetimeStr) {
  const d = parseAsLocal(datetimeStr);
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
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
