import test from 'node:test';
import assert from 'node:assert/strict';
import { getScheduleSegment, plannedBlockLayout } from './scheduleLayout.js';

const date = '2026-10-10';
const plan = (id, start, end) => ({ id, name: `计划${id}`, is_planned: true,
  start_time: start, end_time: end });
const sameDay = (id, start, end) => plan(id, `${date}T${start}:00`, `${date}T${end}:00`);

test('uses Beijing time for naive and explicitly zoned dates', () => {
  const naive = sameDay(1, '09:00', '10:30');
  const zoned = plan(2, '2026-10-10T01:00:00Z', '2026-10-10T02:30:00Z');
  assert.deepEqual(getScheduleSegment(naive, date), getScheduleSegment(zoned, date));
  assert.deepEqual(getScheduleSegment(naive, date), {
    startMinutes: 540, durationMinutes: 90, startsBefore: false, endsAfter: false,
  });
  const [item] = plannedBlockLayout([naive], date);
  assert.equal(item.top, 192);
  assert.equal(item.height, 96);
});

test('clips overnight and multi-day plans at each Beijing day boundary', () => {
  const overnight = plan(1, '2026-10-09T23:00:00', '2026-10-10T07:00:00');
  const [clipped] = plannedBlockLayout([overnight], date);
  assert.equal(clipped.top, 0);
  assert.equal(clipped.height, 64);
  assert.equal(clipped.segment.startsBefore, true);
  const [expanded] = plannedBlockLayout([overnight], date, 0);
  assert.equal(expanded.height, 448);
  const outgoing = plan(2, '2026-10-10T23:00:00', '2026-10-11T01:00:00');
  const [last] = plannedBlockLayout([outgoing], date);
  assert.equal(last.top, 1088);
  assert.equal(last.height, 64);
  assert.equal(last.segment.endsAfter, true);
  const multi = plan(3, '2026-10-09T10:00:00', '2026-10-12T10:00:00');
  assert.equal(plannedBlockLayout([multi], date)[0].height, 1152);
});

test('folded early plans disappear and crossing plans clip at 06:00', () => {
  const schedules = [sameDay(1, '01:00', '02:00'), sameDay(2, '05:30', '06:15'), sameDay(3, '05:00', '06:00')];
  const folded = plannedBlockLayout(schedules, date);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].schedule.id, 2);
  assert.equal(folded[0].top, 0);
  assert.equal(folded[0].height, 16);
  assert.equal(plannedBlockLayout(schedules, date, 0).length, 3);
});

test('short plans keep exact height; labels near midnight remain inside the grid', () => {
  const short = sameDay(1, '09:00', '09:05');
  const [item] = plannedBlockLayout([short], date);
  assert.ok(Math.abs(item.height - 16 / 3) < 1e-9);
  assert.equal(item.labelHeight, 16);
  const last = plan(2, '2026-10-10T23:59:30', '2026-10-11T00:00:00');
  const [edge] = plannedBlockLayout([last], date);
  assert.ok(edge.height < 1);
  assert.equal(edge.top + edge.labelTop + edge.labelHeight, 1152);
});

test('overlapping plans get separate reusable columns; disjoint clusters regain full width', () => {
  const schedules = [sameDay(1, '09:00', '11:00'), sameDay(2, '09:30', '10:00'),
    sameDay(3, '10:00', '10:30'), sameDay(4, '12:00', '13:00')];
  const layout = plannedBlockLayout(schedules, date);
  const byId = new Map(layout.map(item => [item.schedule.id, item]));
  assert.equal(byId.get(1).columnCount, 2);
  assert.notEqual(byId.get(1).column, byId.get(2).column);
  assert.equal(byId.get(2).column, byId.get(3).column);
  assert.equal(byId.get(4).columnCount, 1);
  assert.deepEqual(plannedBlockLayout([...schedules].reverse(), date), layout);
});

test('many concurrent plans and adjacent short labels never cover each other in a column', () => {
  const schedules = Array.from({ length: 6 }, (_, i) => sameDay(i, '09:00', '10:00'));
  schedules.push(sameDay(8, '11:00', '11:01'), sameDay(9, '11:02', '11:03'));
  const layout = plannedBlockLayout(schedules, date);
  assert.equal(layout[0].columnCount, 6);
  for (const a of layout) for (const b of layout) {
    if (a === b || a.column !== b.column) continue;
    assert.ok(a.layoutEnd <= b.layoutStart || b.layoutEnd <= a.layoutStart);
  }
});

test('ignores actual records, invalid times and exact outside-day endpoints without mutating inputs', () => {
  const schedules = [sameDay(1, '09:00', '09:00'), sameDay(2, '10:00', '09:00'),
    plan(3, 'invalid', 'invalid'), { ...sameDay(4, '09:00', '10:00'), is_planned: false },
    plan(5, '2026-10-09T23:00:00', '2026-10-10T00:00:00'),
    plan(6, '2026-10-11T00:00:00', '2026-10-11T01:00:00'),
    { ...sameDay(7, '09:00', '10:00'), is_time_block: true }, sameDay(8, '09:00', '10:00')];
  const before = JSON.stringify(schedules);
  const layout = plannedBlockLayout(schedules, date);
  assert.deepEqual(layout.map(item => item.schedule.id), [8]);
  assert.equal(JSON.stringify(schedules), before);
});
