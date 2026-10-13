import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeScheduleLoader, currentScheduleAt, homeScheduleRefreshDelay, upcomingSchedules, untilScheduleStart } from './homeSchedules.js';

const stamp = text => new Date(text + '+08:00').getTime();
const plan = (id, start, end) => ({ id, name: `日程${id}`, is_planned: true, start_time: start, end_time: end });
const day = '2026-10-10';
const sameDay = (id, start, end) => plan(id, `${day}T${start}:00`, `${day}T${end}:00`);

test('0/1/2 select only today’s future plans in stable start-time/id order', () => {
  const plans = [sameDay(10, '11:00', '12:00'), sameDay(3, '10:00', '10:30'), sameDay(2, '10:00', '10:30'),
    sameDay(1, '08:00', '09:00'), sameDay(5, '09:00', '10:00'),
    plan(6, '2026-10-11T00:00:00', '2026-10-11T01:00:00'),
    { ...sameDay(7, '09:30', '10:00'), is_planned: false }, sameDay(8, '09:30', '09:00')];
  const now = stamp(day + 'T09:00:00');
  const before = JSON.stringify(plans);
  assert.deepEqual(upcomingSchedules(plans, now, 0), []);
  assert.deepEqual(upcomingSchedules(plans, now, 1).map(p => p.id), [2]);
  assert.deepEqual(upcomingSchedules(plans, now, 2).map(p => p.id), [2, 3]);
  assert.deepEqual(upcomingSchedules([...plans].reverse(), now, 2).map(p => p.id), [2, 3]);
  assert.equal(JSON.stringify(plans), before);
});

test('start and end boundaries transition between upcoming/current/finished without duplicates', () => {
  const plans = [sameDay(1, '10:00', '11:00'), sameDay(2, '11:00', '12:00')];
  const before = stamp(day + 'T09:59:59');
  assert.equal(currentScheduleAt(plans, before), null);
  assert.equal(upcomingSchedules(plans, before, 1)[0].id, 1);
  const start = stamp(day + 'T10:00:00');
  assert.equal(currentScheduleAt(plans, start).id, 1);
  assert.deepEqual(upcomingSchedules(plans, start, 2).map(p => p.id), [2]);
  const end = stamp(day + 'T11:00:00');
  assert.equal(currentScheduleAt(plans, end, plans[0]).id, 2);
  assert.deepEqual(upcomingSchedules(plans, end, 2), []);
  assert.equal(currentScheduleAt(plans, stamp(day + 'T12:00:00')), null);
});

test('Beijing day filtering, overnight current schedules and countdowns', () => {
  const now = stamp(day + 'T23:30:00');
  const overnight = plan(1, '2026-10-09T23:00:00', '2026-10-11T00:30:00');
  const todayUtc = plan(2, '2026-10-10T15:45:00Z', '2026-10-10T16:15:00Z');
  const tomorrowUtc = plan(3, '2026-10-10T16:00:00Z', '2026-10-10T17:00:00Z');
  assert.equal(currentScheduleAt([overnight], now).id, 1);
  assert.deepEqual(upcomingSchedules([overnight, todayUtc, tomorrowUtc], now, 2).map(p => p.id), [2]);
  assert.deepEqual(upcomingSchedules([todayUtc, tomorrowUtc], stamp('2026-10-11T00:00:00'), 2), []);
  assert.equal(untilScheduleStart(todayUtc, now), '15 分钟后开始');
  assert.equal(untilScheduleStart(todayUtc, stamp(day + 'T23:44:30')), '不到 1 分钟后开始');
  assert.equal(untilScheduleStart(sameDay(4, '11:05', '12:00'), stamp(day + 'T10:00:00')), '1 小时 5 分钟后开始');
});

test('refresh waits at most a minute and wakes exactly at start/end/midnight', () => {
  const schedules = [sameDay(1, '10:00', '11:00')];
  assert.equal(homeScheduleRefreshDelay(schedules, stamp(day + 'T09:59:40')), 20000);
  assert.equal(homeScheduleRefreshDelay(schedules, stamp(day + 'T10:59:50')), 10000);
  assert.equal(homeScheduleRefreshDelay([], stamp(day + 'T23:59:55')), 5000);
  assert.equal(homeScheduleRefreshDelay([], stamp(day + 'T12:00:00')), 60000);
});

test('refreshes data after edits/resume without regenerating the same day; regenerates the new day', async () => {
  let clock = stamp(day + 'T09:00:00');
  const generations = [], queries = [];
  let data = [sameDay(1, '10:00', '11:00')];
  const loader = createHomeScheduleLoader({ now: () => clock,
    recurrenceApi: { generate: async payload => generations.push(payload) },
    scheduleApi: { current: async () => null, list: async query => { queries.push(query); return data; } },
    projectApi: { list: async () => [] },
  });
  assert.equal((await loader.refresh()).schedules[0].id, 1);
  data = [sameDay(2, '11:00', '12:00')];
  assert.equal((await loader.refresh()).schedules[0].id, 2);
  await loader.refresh();
  assert.equal(generations.length, 1);
  clock = stamp('2026-10-11T00:00:00');
  assert.equal((await loader.refresh()).date, '2026-10-11');
  assert.deepEqual(generations.map(p => p.date_from), [day, '2026-10-11']);
  assert.deepEqual(queries.at(-1), { is_planned: true, date_from: '2026-10-11T00:00:00', date_to: '2026-10-12T00:00:00' });
});

test('concurrent resume/edit refreshes and midnight during a request publish only the latest day', async () => {
  let clock = stamp(day + 'T23:59:59');
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const queried = new Promise(resolve => { started = resolve; });
  const generations = [];
  let calls = 0;
  const loader = createHomeScheduleLoader({ now: () => clock,
    recurrenceApi: { generate: async p => generations.push(p.date_from) },
    scheduleApi: { current: async () => null, list: async query => {
      if (++calls === 1) { started(); await blocked; }
      return [plan(calls, query.date_from, query.date_to)];
    } }, projectApi: { list: async () => [] },
  });
  const first = loader.refresh();
  await queried;
  const second = loader.refresh();
  assert.equal(first, second);
  clock = stamp('2026-10-11T00:00:01');
  release();
  const result = await first;
  assert.equal(result.date, '2026-10-11');
  assert.equal(result.schedules[0].id, 2);
  assert.deepEqual(generations, [day, '2026-10-11']);
});

test('failed generation can retry instead of falsely marking the day complete', async () => {
  let attempts = 0;
  const loader = createHomeScheduleLoader({ now: () => stamp(day + 'T09:00:00'),
    recurrenceApi: { generate: async () => { if (++attempts === 1) throw new Error('offline'); } },
    scheduleApi: { current: async () => null, list: async () => [] }, projectApi: { list: async () => [] },
  });
  await assert.rejects(loader.refresh(), /offline/);
  assert.equal((await loader.refresh()).date, day);
  await loader.refresh();
  assert.equal(attempts, 2);
});
