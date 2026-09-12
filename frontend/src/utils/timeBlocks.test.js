import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTimeBlocks, groupsAsEvents } from './timeBlocks.js';

test('actual groups merge only consecutive blocks with identical details', () => {
  const base = { block_date: '2026-09-12', category_id: 1, notes: '复习',
    linked_todo_id: 3, project_id: 5 };
  const blocks = [
    { ...base, start_minute: 15, end_minute: 30 },
    { ...base, start_minute: 0, end_minute: 15 },
    { ...base, start_minute: 30, end_minute: 45, notes: '整理' },
    { ...base, start_minute: 60, end_minute: 75 },
  ];
  const groups = groupTimeBlocks(blocks);
  assert.deepEqual(groups.map(item => [item.start_minute, item.end_minute]), [[0, 30], [30, 45], [60, 75]]);
  const events = groupsAsEvents(groups, [{ id: 1, name: '学习', color: '#347f88' }],
    [{ id: 3, name: '考试' }], [{ id: 5, name: '课程' }]);
  assert.equal(events[0].name, '复习');
  assert.match(events[0].notes, /学习 · 考试 · 课程/);
  assert.equal(events[0].is_time_block, true);
});

test('a block ending at midnight has a next-day timeline boundary', () => {
  const group = groupTimeBlocks([{ block_date: '2026-09-12', start_minute: 1425,
    end_minute: 1440, category_id: 1 }])[0];
  const event = groupsAsEvents([group], [{ id: 1, name: '休息' }], [], [])[0];
  assert.equal(event.end_time, '2026-09-13T00:00:00');
});
