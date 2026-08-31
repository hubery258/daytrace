import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateGradeSummary,
  dedupeExternalItems,
  expandZdbkTimetable,
  normalizeCourseItems,
  normalizeGradeItem,
  normalizePintiaItems,
  parseExternalDateTime,
  parseZdbkQueryItems,
  selectGradesByStrategy,
  sha1Hex,
} from '../src/data/mobile/zjuNormalize.js';

test('SHA-1 and external datetime normalization match backend semantics', () => {
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(parseExternalDateTime('2024-09-01T00:00:00Z'), '2024-09-01T08:00:00');
  assert.equal(parseExternalDateTime('2024-09-01 08:00:00'), '2024-09-01T08:00:00');
  assert.equal(parseExternalDateTime('not-a-date'), null);
});

test('grade normalization and repeated-course strategies preserve desktop calculation rules', () => {
  const first = normalizeGradeItem({
    xkkh: '(2023-2024-1)-MATH100-01', kch: 'MATH100', kcmc: '高等数学', xf: '3', cj: '80',
  });
  const repeat = normalizeGradeItem({
    xkkh: '(2024-2025-1)-MATH100-02', kch: 'MATH100', kcmc: '高等数学', xf: '3', cj: '90',
  });
  assert.equal(first.five_point, 4);
  assert.equal(first.four_point, 3.3);
  assert.equal(first.gpa_included, true);
  assert.equal(selectGradesByStrategy([repeat, first], 'scholarship')[0].original_score, '80');
  assert.equal(selectGradesByStrategy([first, repeat], 'abroad')[0].original_score, '90');

  const scholarship = calculateGradeSummary([first, repeat], 'scholarship');
  assert.equal(scholarship.total_credit, 6);
  assert.equal(scholarship.gpa_credit, 3);
  assert.equal(scholarship.gpa_five, 4);
  const abroad = calculateGradeSummary([first, repeat], 'abroad');
  assert.equal(abroad.gpa_five, 4.8);
  const all = calculateGradeSummary([first, repeat], 'all_attempts');
  assert.equal(all.gpa_credit, 6);
  assert.equal(all.gpa_five, 4.4);
});

test('non-GPA pass grades earn credit without entering GPA', () => {
  const pass = normalizeGradeItem({ kch: 'PE1', kcmc: '体育', xf: 1, cj: '合格' });
  assert.equal(pass.gpa_included, false);
  assert.equal(pass.credit_included, true);
  const summary = calculateGradeSummary([pass]);
  assert.equal(summary.earned_credit, 1);
  assert.equal(summary.gpa_credit, 0);
  assert.equal(summary.gpa_five, null);
});

test('timetable expansion applies semester halves, calendar exchange and section times', () => {
  const calendar = {
    startEnd: ['20240902', '20240908', '20240909', '20240915'],
    exchange: { 2024090320240902: true },
    holiday: {},
    dummy: {},
  };
  const items = [{
    jxb_id: 'class-1', kcmc: '数据结构', xm: '张老师', cdmc: '紫金港东1-101',
    xqj: '1', djj: '1', skcd: '2', dsz: '', xxq: '秋',
  }];
  const output = expandZdbkTimetable(items, calendar, '2024-2025', 1);
  assert.equal(output.length, 1);
  assert.equal(output[0].start_time, '2024-09-03T08:00:00');
  assert.equal(output[0].end_time, '2024-09-03T09:35:00');
  assert.equal(output[0].week, 1);
  assert.equal(output[0].sections, '1-2');
  assert.match(output[0].external_id, /^zdbk:2024-2025:1:class-1:/);
});

test('timetable expansion blocks holidays and rejects incomplete calendars', () => {
  const item = { jxb_id: 'class-2', kcmc: '课程', xqj: 1, djj: 1, skcd: 1, dsz: '', xxq: '秋' };
  const calendar = {
    startEnd: ['20240902', '20240908', '20240909', '20240915'],
    holiday: { 20240902: 'holiday' },
  };
  assert.deepEqual(expandZdbkTimetable([item], calendar, '2024-2025', 1), []);
  assert.throws(() => expandZdbkTimetable([item], {}, '2024-2025', 1), /CALENDAR_START_END_MISSING/);
});

test('course and Pintia todo normalization filters completed and expired entries', () => {
  const now = new Date('2025-01-01T00:00:00Z').getTime();
  const course = { id: 7, name: '软件工程' };
  const todos = normalizeCourseItems(course, {
    activities: [
      { id: 1, published: true, type: 'homework', title: '作业一', start_time: '2024-01-01T00:00:00Z', end_time: '2025-01-02T00:00:00Z' },
      { id: 2, published: true, type: 'homework', title: '已交', start_time: '2024-01-01T00:00:00Z', end_time: '2025-01-02T00:00:00Z' },
    ],
    homeworkStatus: [{ id: 2, status_code: 'submitted' }],
    exams: [], submittedExams: [], classrooms: [],
  }, now);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].external_id, 'courses.zju:homework:1');

  const pintia = normalizePintiaItems([
    { id: 'p1', name: '题集', endAt: '2025-01-03T00:00:00Z' },
    { id: 'old', name: '过期', endAt: '2024-01-01T00:00:00Z' },
  ], now);
  assert.deepEqual(pintia.map((item) => item.external_id), ['pintia:problem-set:p1']);
});

test('ZDBK response parsing and external identity de-duplication are explicit', () => {
  assert.deepEqual(parseZdbkQueryItems('{"items":[{"kcmc":"课程"}]}'), [{ kcmc: '课程' }]);
  assert.throws(() => parseZdbkQueryItems('<form action="cas/login">统一身份认证</form>'), /ZDBK_SESSION_EXPIRED/);
  assert.throws(() => parseZdbkQueryItems('<html>bad</html>'), /ZDBK_RESPONSE_INVALID/);
  const values = [
    { source: 'zju', external_id: '1' },
    { source: 'zju', external_id: '1' },
    { source: 'zju', external_id: '2' },
  ];
  assert.equal(dedupeExternalItems(values).length, 2);
});
