import { parseAsLocal } from './time.js';

// A day's visible schedule segment, always measured from Beijing midnight.
export function getScheduleSegment(schedule, dateStr) {
  if (!schedule.start_time || !schedule.end_time) return null;
  const dayStart = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  const dayEnd = dayStart + 86400000;
  const start = parseAsLocal(schedule.start_time).getTime();
  const end = parseAsLocal(schedule.end_time).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= dayEnd || end <= dayStart) return null;
  return {
    startMinutes: (Math.max(start, dayStart) - dayStart) / 60000,
    durationMinutes: (Math.min(end, dayEnd) - Math.max(start, dayStart)) / 60000,
    startsBefore: start < dayStart,
    endsAfter: end > dayEnd,
  };
}

export function plannedBlockLayout(schedules, date, visibleStart = 360, hourHeight = 64) {
  const pixelsPerMinute = hourHeight / 60;
  const gridHeight = (1440 - visibleStart) * pixelsPerMinute;
  const items = schedules.flatMap(schedule => {
    if (!schedule.is_planned || schedule.is_time_block) return [];
    const segment = getScheduleSegment(schedule, date);
    if (!segment) return [];
    const end = segment.startMinutes + segment.durationMinutes;
    const start = Math.max(visibleStart, segment.startMinutes);
    if (end <= start) return [];
    const top = (start - visibleStart) * pixelsPerMinute;
    const height = (end - start) * pixelsPerMinute;
    // Labels for very short plans may extend beyond the exact time bar. Include
    // that space in overlap packing, and keep labels inside the day at midnight.
    const labelHeight = Math.min(34, Math.max(16, height));
    const labelTop = Math.min(top, gridHeight - labelHeight);
    return [{ schedule, segment, top, height, labelTop: labelTop - top, labelHeight,
      layoutStart: Math.min(top, labelTop), layoutEnd: Math.max(top + height, labelTop + labelHeight) }];
  }).sort((a, b) => a.layoutStart - b.layoutStart || b.layoutEnd - a.layoutEnd ||
    String(a.schedule.id).localeCompare(String(b.schedule.id)));

  let cluster = [];
  let columnEnds = [];
  let clusterEnd = -Infinity;
  const finishCluster = () => {
    for (const item of cluster) item.columnCount = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };
  for (const item of items) {
    if (item.layoutStart >= clusterEnd) finishCluster();
    let column = columnEnds.findIndex(end => end <= item.layoutStart);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = item.layoutEnd;
    item.column = column;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.layoutEnd);
  }
  finishCluster();
  return items;
}
