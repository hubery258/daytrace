import { addDays, dateStrInBeijing, parseAsLocal } from './time.js';
import { normalizeUpcomingCount } from './displayPreferences.js';

function scheduleTimes(schedule) {
  if (!schedule.is_planned || !schedule.start_time || !schedule.end_time) return null;
  const start = parseAsLocal(schedule.start_time).getTime();
  const end = parseAsLocal(schedule.end_time).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function compareSchedules(a, b) {
  const byStart = parseAsLocal(a.start_time) - parseAsLocal(b.start_time);
  if (byStart) return byStart;
  const aId = Number(a.id), bId = Number(b.id);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return aId - bId;
  const aKey = String(a.uuid || a.id || ''), bKey = String(b.uuid || b.id || '');
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function upcomingSchedules(schedules, now, count) {
  const day = dateStrInBeijing(new Date(now).toISOString());
  return schedules.filter(schedule => {
    const times = scheduleTimes(schedule);
    return times && times.start > now && dateStrInBeijing(schedule.start_time) === day;
  }).sort(compareSchedules).slice(0, normalizeUpcomingCount(count));
}

export function currentScheduleAt(schedules, now, preferred = null) {
  const active = schedule => {
    const times = scheduleTimes(schedule);
    return times && times.start <= now && times.end > now;
  };
  if (preferred && active(preferred)) return preferred;
  return schedules.filter(active).sort(compareSchedules)[0] || null;
}

export function untilScheduleStart(schedule, now) {
  const remaining = parseAsLocal(schedule.start_time).getTime() - now;
  if (remaining < 60000) return '不到 1 分钟后开始';
  const minutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}后开始` : `${minutes} 分钟后开始`;
}

export function homeScheduleRefreshDelay(schedules, now) {
  const day = dateStrInBeijing(new Date(now).toISOString());
  const midnight = parseAsLocal(`${addDays(day, 1)}T00:00:00`).getTime();
  const boundaries = [midnight, ...schedules.flatMap(schedule => {
    const times = scheduleTimes(schedule);
    return times ? [times.start, times.end] : [];
  })].filter(stamp => stamp > now);
  // Repaint countdowns at least once a minute and exactly at schedule/day boundaries.
  return Math.max(1, Math.min(60000, Math.min(...boundaries) - now));
}

export function createHomeScheduleLoader({ scheduleApi, recurrenceApi, projectApi, now = Date.now }) {
  const generatedDays = new Set();
  let requested = 0;
  let flight = null;
  return {
    refresh() {
      requested += 1;
      if (flight) return flight;
      flight = (async () => {
        while (true) {
          const revision = requested;
          const date = dateStrInBeijing(new Date(now()).toISOString());
          if (!generatedDays.has(date)) {
            await recurrenceApi.generate({ entity_type: 'schedule', date_from: date, date_to: date });
            generatedDays.add(date);
          }
          const [current, schedules, projects] = await Promise.all([
            scheduleApi.current(),
            scheduleApi.list({ is_planned: true, date_from: `${date}T00:00:00`, date_to: `${addDays(date, 1)}T00:00:00` }),
            projectApi.list(),
          ]);
          // A resume/edit during a request, or a midnight rollover, must not
          // publish an obsolete day or overwrite the more recent refresh.
          if (revision !== requested || date !== dateStrInBeijing(new Date(now()).toISOString())) continue;
          return { date, current, schedules, projects };
        }
      })().finally(() => { flight = null; });
      return flight;
    },
  };
}
