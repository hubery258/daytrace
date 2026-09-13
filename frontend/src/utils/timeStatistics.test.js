import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTimeStatistics, fetchTimeBlocksRange, formatStatisticsMinutes,
  shiftStatisticsAnchor, statisticsRange,
} from './timeStatistics.js';

test('day, week, year and custom ranges use inclusive natural days', () => {
  assert.deepEqual(statisticsRange('day', '2026-09-13'), { from: '2026-09-13', to: '2026-09-13' });
  assert.deepEqual(statisticsRange('week', '2026-09-13'), { from: '2026-09-07', to: '2026-09-13' });
  assert.deepEqual(statisticsRange('year', '2024-02-29'), { from: '2024-01-01', to: '2024-12-31' });
  assert.deepEqual(statisticsRange('custom', '2026-09-13', '2026-08-20', '2026-08-20'),
    { from: '2026-08-20', to: '2026-08-20' });
  assert.equal(shiftStatisticsAnchor('week', '2026-09-13', -1), '2026-09-06');
  assert.equal(shiftStatisticsAnchor('year', '2024-02-29', 1), '2025-01-01');
  assert.throws(() => statisticsRange('custom', '2026-09-13', '2026-09-14', '2026-09-13'));
});

test('yearly time blocks are read in bounded chunks', async () => {
  const calls = [];
  const api = { list: async (from, to) => {
    calls.push([from, to]);
    return [{ block_date: from }];
  } };
  const result = await fetchTimeBlocksRange(api, '2026-01-01', '2026-12-31');
  assert.equal(result.length, 8);
  assert.equal(calls[0][0], '2026-01-01');
  assert.equal(calls.at(-1)[1], '2026-12-31');
  for (const [from, to] of calls) {
    assert.ok((Date.parse(to) - Date.parse(from)) / 86400000 <= 45);
  }
  for (let index = 1; index < calls.length; index++) {
    assert.equal((Date.parse(calls[index][0]) - Date.parse(calls[index - 1][1])) / 86400000, 1);
  }
});

test('category events, tasks and projects use actual block minutes', () => {
  const categories = [{ id: 1, name: '学习', color: '#347f88' }, { id: 2, name: '开发', color: '#536fba' }];
  const todos = [{ id: 10, name: '英语练习', project_id: 1 }, { id: 11, name: '阅读', project_id: 2 }];
  const projects = [{ id: 1, name: '语言', color: '#aaa' }, { id: 2, name: '课程', color: '#bbb' }];
  const blocks = [
    { block_date: '2026-09-12', start_minute: 540, end_minute: 555, category_id: 1, notes: '英语', linked_todo_id: 10, project_id: 2 },
    { block_date: '2026-09-12', start_minute: 555, end_minute: 570, category_id: 1, notes: '英语', linked_todo_id: 10, project_id: 2 },
    { block_date: '2026-09-13', start_minute: 600, end_minute: 615, category_id: 1, notes: '英语', linked_todo_id: 11, project_id: 2 },
    { block_date: '2026-09-13', start_minute: 840, end_minute: 870, category_id: 2, notes: '写代码', linked_todo_id: null, project_id: 1 },
  ];
  const result = aggregateTimeStatistics(blocks, categories, todos, projects);
  assert.equal(result.totalMinutes, 75);
  assert.equal(result.linkedMinutes, 45);
  assert.equal(result.activeDays, 2);
  assert.deepEqual(result.categories.map(item => item.minutes), [45, 30]);
  assert.deepEqual(result.categories[0].events.map(item => item.minutes), [30, 15]);
  assert.deepEqual(result.tasks.map(item => item.minutes), [30, 15]);
  assert.deepEqual(result.projects.map(item => item.name), ['语言', '课程']);
  assert.deepEqual(result.projects.map(item => item.minutes), [30, 15]);
  assert.equal(formatStatisticsMinutes(result.totalMinutes), '1小时15分钟');
});

test('empty statistics are safe to render', () => {
  assert.deepEqual(aggregateTimeStatistics([], [], [], []), {
    totalMinutes: 0, linkedMinutes: 0, activeDays: 0, categories: [], tasks: [], projects: [],
  });
  assert.equal(formatStatisticsMinutes(0), '0分钟');
});
