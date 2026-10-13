import test from 'node:test';
import assert from 'node:assert/strict';
import { projectItemDisplayName, scheduleDisplayName } from './displayName.js';
import { groupsAsEvents } from './timeBlocks.js';

test('project labels use current project names without altering portable or editable data', () => {
  const item = Object.freeze({ id: 7, project_id: 12, name: '读书', notes: '原始备注' });
  const before = JSON.stringify(item);
  const projects = [{ id: 12, name: '学习', status: 'archived' }];
  assert.equal(projectItemDisplayName(item, projects), '学习·读书');
  projects[0].name = '秋季学习';
  assert.equal(projectItemDisplayName(item, projects), '秋季学习·读书');
  assert.equal(JSON.stringify(item), before);
  assert.equal(item.name, '读书');
});

test('absent or missing projects keep the original name; selector IDs can be strings', () => {
  const projects = [{ id: 12, name: '学习' }];
  for (const project_id of [null, undefined, '', 99]) {
    assert.equal(projectItemDisplayName({ name: '原名', project_id }, projects), '原名');
  }
  assert.equal(projectItemDisplayName({ name: '原名', project_id: 12 }), '原名');
  assert.equal(projectItemDisplayName({ name: '原名', project_id: '12' }, projects), '学习·原名');
  assert.equal(projectItemDisplayName(undefined, projects), '');
});

test('only planned schedules get prefixes; actual event snapshots stay unchanged', () => {
  const projects = [{ id: 12, name: '新项目名' }];
  const planned = { name: '阅读', project_id: 12, is_planned: true };
  assert.equal(scheduleDisplayName(planned, projects), '新项目名·阅读');
  const actual = { ...planned, name: '历史记录名', is_planned: false };
  assert.equal(scheduleDisplayName(actual, projects), '历史记录名');
  const events = groupsAsEvents([{
    block_date: '2026-10-10', start_minute: 540, end_minute: 600,
    project_id: 12, category_id: 1, notes: '历史备注', linked_todo_id: 7,
  }], [{ id: 1, name: '学习' }], [{ id: 7, name: '原待办' }], projects);
  const before = JSON.stringify(events);
  assert.equal(scheduleDisplayName(events[0], projects), '历史备注');
  assert.equal(scheduleDisplayName({ ...events[0], is_planned: true }, projects), '历史备注');
  projects[0].name = '再次重命名';
  assert.equal(scheduleDisplayName(events[0], projects), '历史备注');
  assert.equal(JSON.stringify(events), before);
});
