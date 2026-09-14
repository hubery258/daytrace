const DEFAULT_SESSION_TIME = Object.freeze([
  [],
  ['08:00', '08:45'],
  ['08:50', '09:35'],
  ['09:50', '10:35'],
  ['10:40', '11:25'],
  ['11:30', '12:15'],
  ['13:15', '14:00'],
  ['14:05', '14:50'],
  ['14:55', '15:40'],
  ['15:55', '16:40'],
  ['16:45', '17:30'],
  ['18:30', '19:15'],
  ['19:20', '20:05'],
  ['20:10', '20:55'],
  ['21:00', '21:45'],
  ['21:50', '22:35'],
  ['22:40', '23:25'],
]);

const GRADE_HUNDRED_MAP = Object.freeze({
  'A+': 95, A: 92, 'A-': 88, 'B+': 85, B: 82, 'B-': 78,
  'C+': 75, C: 72, 'C-': 68, D: 62, F: 0,
  优秀: 95, 良好: 85, 中等: 75, 及格: 65, 不及格: 0, 合格: 75, 不合格: 0,
});

const GRADE_FIVE_MAP = Object.freeze({
  'A+': 5, A: 4.8, 'A-': 4.5, 'B+': 4.2, B: 3.8, 'B-': 3.5,
  'C+': 3.2, C: 2.8, 'C-': 2.5, D: 1.5, F: 0,
  优秀: 5, 良好: 4, 中等: 3, 及格: 1.5, 不及格: 0,
});

const NON_GPA_SCORES = new Set(['', '合格', '不合格', '弃修', '待录', '缓考', '无效', '缺考', '免修', '通过', '未通过']);
const NON_CREDIT_SCORES = new Set(['', '不合格', '弃修', '待录', '缓考', '无效', '缺考', '未通过', 'F']);

function pad(value) {
  return String(value).padStart(2, '0');
}

function beijingNaiveFromEpoch(epoch) {
  const date = new Date(epoch + 8 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function parseExternalDateTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim().replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const parsed = new Date(hasZone ? text : `${text}+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return beijingNaiveFromEpoch(parsed.getTime());
}

export function beijingEpoch(value) {
  const normalized = parseExternalDateTime(value);
  if (!normalized) return Number.NaN;
  return new Date(`${normalized}+08:00`).getTime();
}

function parseFloatOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function decodeHtml(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtml(value) {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '\n')
    .trim();
}

function utf8Bytes(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  const encoded = unescape(encodeURIComponent(value));
  return Uint8Array.from(encoded, (char) => char.charCodeAt(0));
}

export function sha1Hex(value) {
  const source = Array.from(utf8Bytes(String(value)));
  const bitLength = source.length * 8;
  source.push(0x80);
  while ((source.length % 64) !== 56) source.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) source.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) source.push((low >>> shift) & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const rotate = (word, bits) => ((word << bits) | (word >>> (32 - bits))) >>> 0;

  for (let offset = 0; offset < source.length; offset += 64) {
    const words = new Uint32Array(80);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = ((source[start] << 24) | (source[start + 1] << 16) | (source[start + 2] << 8) | source[start + 3]) >>> 0;
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotate(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f;
      let k;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotate(a, 5) + (f >>> 0) + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}: ${stableStringify(value[key])}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeGradeStrategy(strategy) {
  const value = String(strategy || 'scholarship').trim().toLowerCase();
  return new Set(['scholarship', 'abroad', 'all_attempts']).has(value) ? value : 'scholarship';
}

function scoreToHundred(originalScore) {
  const text = String(originalScore || '').trim();
  const numeric = parseFloatOrNull(text);
  if (numeric != null) return numeric;
  return GRADE_HUNDRED_MAP[text.toUpperCase()] ?? GRADE_HUNDRED_MAP[text] ?? null;
}

function scoreToFive(originalScore, hundredPoint) {
  const text = String(originalScore || '').trim();
  const mapped = GRADE_FIVE_MAP[text.toUpperCase()] ?? GRADE_FIVE_MAP[text];
  if (mapped != null) return mapped;
  if (hundredPoint == null) return null;
  if (hundredPoint >= 95) return 5;
  if (hundredPoint >= 90) return 4.8;
  if (hundredPoint >= 85) return 4.5;
  if (hundredPoint >= 80) return 4;
  if (hundredPoint >= 75) return 3.5;
  if (hundredPoint >= 70) return 3;
  if (hundredPoint >= 65) return 2.5;
  if (hundredPoint >= 60) return 1.5;
  return 0;
}

function parseZdbkCourseId(courseId) {
  const text = String(courseId || '').trim();
  let match = text.match(/^\((\d{4}-\d{4})-([^)]*)\)-([^-]+)/);
  if (match) return [match[1], match[2], match[3].trim()];
  match = text.match(/\)-([^-]+)/);
  return match ? ['', '', match[1].trim()] : ['', '', ''];
}

export function normalizeGradeItem(item = {}, major = false) {
  const courseId = String(item.xkkh || item.jxb_id || item.jxbid || '').trim();
  const [parsedYear, parsedSemester, parsedCourseCode] = parseZdbkCourseId(courseId);
  const courseCode = String(item.kch || item.kch_id || item.kcdm || parsedCourseCode || '').trim();
  const courseName = String(item.kcmc || item.kcmc_zw || '未命名课程').trim();
  const credit = parseFloatOrNull(item.xf) || 0;
  const originalScore = String(item.cj || item.bfzcj || item.zcj || '').trim();
  const hundredPoint = scoreToHundred(originalScore);
  const fivePoint = parseFloatOrNull(item.jd) ?? scoreToFive(originalScore, hundredPoint);
  const fourPoint = fivePoint == null ? null : Math.min(4.3, Math.max(0, fivePoint - 0.7));
  const fourPointLegacy = fivePoint == null ? null : Math.min(4, Math.max(0, fivePoint - 1));
  const academicYear = String(item.xnmmc || item.xnm || item.xn || parsedYear || '').trim();
  const semester = String(item.xqmmc || item.xqm || item.xq || parsedSemester || '').trim();
  const courseNature = String(item.kcxzmc || item.kclbmc || item.kcsxmc || '').trim();
  const seed = courseId || courseCode || `${academicYear}:${semester}:${courseName}:${originalScore}`;
  const scoreKey = originalScore.toUpperCase();
  return {
    source: 'zju_zdbk_grade',
    external_id: `zdbk:${sha1Hex(seed).slice(0, 16)}`,
    course_id: courseId,
    course_code: courseCode,
    course_name: courseName,
    credit,
    original_score: originalScore,
    hundred_point: hundredPoint,
    five_point: fivePoint,
    four_point: fourPoint,
    four_point_legacy: fourPointLegacy,
    gpa_included: credit > 0 && fivePoint != null && !NON_GPA_SCORES.has(scoreKey),
    credit_included: credit > 0 && !NON_CREDIT_SCORES.has(scoreKey) && (fivePoint == null || fivePoint > 0 || originalScore === '合格'),
    major: Boolean(major),
    academic_year: academicYear,
    semester,
    course_nature: courseNature,
    raw: item,
  };
}

export function parseZdbkQueryItems(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text === 'null') return [];
  if (/login_ssologin|cas\/login|统一身份认证/i.test(text)) {
    throw new Error('ZDBK_SESSION_EXPIRED');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const match = text.match(/"items"\s*:\s*(\[.*?\])\s*,\s*"limit"/s);
    if (!match) throw new Error('ZDBK_RESPONSE_INVALID');
    try {
      data = { items: JSON.parse(match[1]) };
    } catch {
      throw new Error('ZDBK_RESPONSE_INVALID');
    }
  }
  const items = data && typeof data === 'object' && !Array.isArray(data) ? (data.items || data.rows || []) : null;
  if (!Array.isArray(items)) throw new Error('ZDBK_RESPONSE_INVALID');
  return items.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function normalizeCourseName(value) {
  return String(value || '').trim().replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '').toLowerCase();
}

function gradeCourseGroupKey(grade) {
  if (grade.course_code) return grade.course_code.trim().toLowerCase();
  const parsed = parseZdbkCourseId(grade.course_id)[2];
  return parsed ? parsed.toLowerCase() : normalizeCourseName(grade.course_name);
}

function gradeTermKey(grade) {
  return [grade.academic_year || '', grade.semester || '', grade.external_id || ''];
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const order = String(left[index] ?? '').localeCompare(String(right[index] ?? ''));
    if (order) return order;
  }
  return 0;
}

export function selectGradesByStrategy(grades = [], strategy = 'scholarship') {
  const normalized = normalizeGradeStrategy(strategy);
  const valid = grades.filter((grade) => grade.gpa_included || grade.credit_included);
  if (normalized === 'all_attempts') return valid;
  const groups = new Map();
  for (const grade of valid) {
    const key = gradeCourseGroupKey(grade);
    groups.set(key, [...(groups.get(key) || []), grade]);
  }
  const selected = [];
  for (const group of groups.values()) {
    group.sort((left, right) => {
      if (normalized === 'abroad') {
        const leftHundred = left.hundred_point ?? -1;
        const rightHundred = right.hundred_point ?? -1;
        if (leftHundred !== rightHundred) return leftHundred - rightHundred;
        const leftFive = left.five_point ?? -1;
        const rightFive = right.five_point ?? -1;
        if (leftFive !== rightFive) return leftFive - rightFive;
      }
      return compareTuple(gradeTermKey(left), gradeTermKey(right));
    });
    selected.push(normalized === 'abroad' ? group[group.length - 1] : group[0]);
  }
  return selected.sort((left, right) => compareTuple(gradeTermKey(left), gradeTermKey(right)));
}

function rounded(value, digits = 3) {
  return value == null ? null : Number(value.toFixed(digits));
}

function weighted(items, key) {
  const usable = items.filter((grade) => grade[key] != null && Number(grade.credit) > 0);
  const totalCredit = usable.reduce((sum, grade) => sum + Number(grade.credit), 0);
  if (totalCredit <= 0) return null;
  return usable.reduce((sum, grade) => sum + Number(grade[key] || 0) * Number(grade.credit), 0) / totalCredit;
}

export function calculateGradeSummary(grades = [], strategy = 'scholarship', majorGrades = []) {
  const normalized = normalizeGradeStrategy(strategy);
  const selected = selectGradesByStrategy(grades, normalized);
  const allCounted = grades.filter((grade) => grade.gpa_included || grade.credit_included);
  const allCredit = grades.filter((grade) => grade.credit_included && Number(grade.credit) > 0);
  const gpaItems = selected.filter((grade) => grade.gpa_included && Number(grade.credit) > 0);
  const majorGpaItems = selectGradesByStrategy(majorGrades, normalized)
    .filter((grade) => grade.gpa_included && Number(grade.credit) > 0);
  const sumCredit = (items) => items.reduce((sum, grade) => sum + Number(grade.credit || 0), 0);
  return {
    strategy: normalized,
    course_count: selected.length,
    gpa_course_count: gpaItems.length,
    total_credit: rounded(sumCredit(allCounted)),
    earned_credit: rounded(sumCredit(allCredit)),
    gpa_credit: rounded(sumCredit(gpaItems)),
    gpa_five: rounded(weighted(gpaItems, 'five_point')),
    gpa_four: rounded(weighted(gpaItems, 'four_point')),
    gpa_four_legacy: rounded(weighted(gpaItems, 'four_point_legacy')),
    average_hundred: rounded(weighted(gpaItems, 'hundred_point')),
    major_gpa_five: rounded(weighted(majorGpaItems, 'five_point')),
    major_gpa_four: rounded(weighted(majorGpaItems, 'four_point')),
    major_gpa_four_legacy: rounded(weighted(majorGpaItems, 'four_point_legacy')),
    major_average_hundred: rounded(weighted(majorGpaItems, 'hundred_point')),
  };
}

function calendarDay(value) {
  if (!/^\d{8}$/.test(String(value))) throw new Error('CALENDAR_DATE_INVALID');
  const year = Number(String(value).slice(0, 4));
  const month = Number(String(value).slice(4, 6));
  const day = Number(String(value).slice(6, 8));
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new Error('CALENDAR_DATE_INVALID');
  }
  return epoch;
}

function calendarKey(epoch) {
  const date = new Date(epoch);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function isoWeekday(epoch) {
  const weekday = new Date(epoch).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function buildHalfWeekdayDates(start, end) {
  const dates = Array.from({ length: 2 }, () => Array.from({ length: 8 }, () => []));
  let oddEvenWeek = 0;
  for (let current = start; current <= end; current += 86400000) {
    const weekday = isoWeekday(current);
    dates[oddEvenWeek][weekday].push(current);
    if (weekday === 7) oddEvenWeek = 1 - oddEvenWeek;
  }
  return dates;
}

function halfFlags(item) {
  const text = String(item.xxq || item.xq || '');
  const first = text.includes('秋') || text.includes('春');
  const second = text.includes('冬') || text.includes('夏');
  return [first, second, Boolean(text.trim())];
}

function matchesSemester(item, semester) {
  const [first, second, marker] = halfFlags(item);
  if (!marker || (!first && !second)) return true;
  const text = String(item.xxq || item.xq || '');
  if (semester === 1) return (text.includes('秋') || text.includes('冬')) && !(text.includes('春') || text.includes('夏'));
  return (text.includes('春') || text.includes('夏')) && !(text.includes('秋') || text.includes('冬'));
}

function halfIndexes(item) {
  const [first, second, marker] = halfFlags(item);
  if (!marker || (!first && !second)) return [0, 1];
  return [first ? 0 : null, second ? 1 : null].filter((value) => value != null);
}

function courseParts(item) {
  const text = [item.kcb, item.kcmc, item.cdmc].filter(Boolean).map(stripHtml).join('\n');
  const parts = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  let name = String(item.kcmc || parts[0] || '未命名课程').trim();
  let teacher = String(item.xm || '').trim();
  let location = String(item.cdmc || item.jxdd || '').trim();
  for (const part of parts.slice(1)) {
    if (!teacher && !/校区|教室|楼|室|线上/.test(part)) {
      teacher = part;
    } else if (!location && /校区|教室|楼|室|线上/.test(part)) {
      location = part;
    }
  }
  name = name || '未命名课程';
  return [name, teacher, location];
}

function courseKey(item, name, teacher, location) {
  for (const key of ['jxb_id', 'jxbid', 'kch', 'kch_id', 'xkkh']) {
    if (item[key]) return String(item[key]);
  }
  return sha1Hex(`${name}|${teacher}|${location}|${stableStringify(item)}`).slice(0, 12);
}

export function expandZdbkTimetable(items, calendar, academicYear, semester) {
  if (!Array.isArray(items)) throw new Error('TIMETABLE_INVALID');
  const startEnd = calendar?.startEnd || [];
  if (!Array.isArray(startEnd) || startEnd.length < 4) throw new Error('CALENDAR_START_END_MISSING');
  let sessionTime = calendar?.sessionTime || DEFAULT_SESSION_TIME;
  if (!Array.isArray(sessionTime) || sessionTime.length < 2) sessionTime = DEFAULT_SESSION_TIME;
  const ranges = [
    [calendarDay(startEnd[0]), calendarDay(startEnd[1])],
    [calendarDay(startEnd[2]), calendarDay(startEnd[3])],
  ];
  const dates = ranges.map(([start, end]) => buildHalfWeekdayDates(start, end));
  const blocked = new Set([
    ...Object.keys(calendar?.holiday || {}),
    ...Object.keys(calendar?.dummy || {}),
  ]);
  const exchangeByOriginal = new Map(
    Object.keys(calendar?.exchange || {})
      .filter((key) => key.length >= 16)
      .map((key) => [key.slice(8, 16), key.slice(0, 8)]),
  );
  const output = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || !matchesSemester(item, semester)) continue;
    const weekday = parseInteger(item.xqj, 0);
    const sectionStart = parseInteger(item.djj, 0);
    const sectionCount = parseInteger(item.skcd, 1);
    if (weekday < 1 || weekday > 7 || sectionStart < 1) continue;
    const sectionEnd = sectionStart + Math.max(sectionCount, 1) - 1;
    if (sectionStart >= sessionTime.length || sectionEnd >= sessionTime.length) continue;
    if (!Array.isArray(sessionTime[sectionStart]) || !Array.isArray(sessionTime[sectionEnd])) continue;
    const oddEven = [];
    if (String(item.dsz || '') !== '1') oddEven.push(0);
    if (String(item.dsz || '') !== '0') oddEven.push(1);
    const [name, teacher, location] = courseParts(item);
    const key = courseKey(item, name, teacher, location);
    const startClock = sessionTime[sectionStart][0];
    const endClock = sessionTime[sectionEnd][1];
    if (!/^\d{2}:\d{2}$/.test(startClock) || !/^\d{2}:\d{2}$/.test(endClock)) continue;
    for (const halfIndex of halfIndexes(item)) {
      for (const oddEvenIndex of oddEven) {
        dates[halfIndex][oddEvenIndex][weekday].forEach((scheduledDate, occurrenceIndex) => {
          const dateKey = calendarKey(scheduledDate);
          if (blocked.has(dateKey)) return;
          const actualKey = exchangeByOriginal.get(dateKey) || dateKey;
          if (blocked.has(actualKey)) return;
          const actualDate = actualKey.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(actualDate)) return;
          const week = halfIndex * 8 + occurrenceIndex * 2 + oddEvenIndex + 1;
          output.push({
            source: 'zju_zdbk',
            external_id: `zdbk:${academicYear}:${semester}:${key}:half${halfIndex}:week${week}:day${weekday}:section${sectionStart}`,
            course_name: name,
            teacher,
            location,
            start_time: `${actualDate}T${startClock}:00`,
            end_time: `${actualDate}T${endClock}:00`,
            weekday,
            week,
            sections: `${sectionStart}-${sectionEnd}`,
            raw: { academic_year: academicYear, semester, half_index: halfIndex, item },
          });
        });
      }
    }
  }
  return output.sort((left, right) => left.start_time.localeCompare(right.start_time) || left.course_name.localeCompare(right.course_name));
}

export function normalizeCourseItems(course, detail, nowEpoch = Date.now()) {
  const courseId = course?.id;
  if (courseId == null) return [];
  const courseName = course?.name || '';
  const submittedHomework = new Set((detail.homeworkStatus || [])
    .filter((item) => item?.status_code === 'submitted').map((item) => item.id));
  const submittedExams = new Set(detail.submittedExams || []);
  const output = [];
  for (const activity of detail.activities || []) {
    const end = parseExternalDateTime(activity?.end_time);
    const start = parseExternalDateTime(activity?.start_time);
    if (!activity?.published || !end || beijingEpoch(end) <= nowEpoch) continue;
    if (start && beijingEpoch(start) > nowEpoch) continue;
    if (activity.type === 'homework' && submittedHomework.has(activity.id)) continue;
    if (activity.completion_criterion_key === 'score' && Number(activity.score_percentage || 0) >= 1) continue;
    output.push({
      source: 'zju_courses',
      external_id: `courses.zju:${activity.type || 'activity'}:${activity.id}`,
      title: activity.title || '未命名 ZJU 任务',
      course_name: courseName,
      ddl_at: end,
      type: activity.type || 'activity',
      url: `https://courses.zju.edu.cn/course/${courseId}/learning-activity#/${activity.id}`,
      raw: { course_id: courseId, activity },
    });
  }
  for (const exam of detail.exams || []) {
    const end = parseExternalDateTime(exam?.end_time);
    const start = parseExternalDateTime(exam?.start_time);
    if (!exam?.published || !end || beijingEpoch(end) <= nowEpoch) continue;
    if (start && beijingEpoch(start) > nowEpoch) continue;
    if (submittedExams.has(exam.id)) continue;
    output.push({
      source: 'zju_courses',
      external_id: `courses.zju:quiz:${exam.id}`,
      title: exam.title || '未命名测验',
      course_name: courseName,
      ddl_at: end,
      type: 'quiz',
      url: `https://courses.zju.edu.cn/course/${courseId}/learning-activity#/${exam.id}`,
      raw: { course_id: courseId, exam },
    });
  }
  for (const classroom of detail.classrooms || []) {
    const end = parseExternalDateTime(classroom?.end_at);
    const start = parseExternalDateTime(classroom?.start_at);
    if (classroom?.status !== 'start') continue;
    if (start && beijingEpoch(start) > nowEpoch) continue;
    if (end && beijingEpoch(end) <= nowEpoch) continue;
    output.push({
      source: 'zju_courses',
      external_id: `courses.zju:interaction:${classroom.id}`,
      title: classroom.title || '未命名互动',
      course_name: courseName,
      ddl_at: end,
      type: 'interaction',
      url: `https://courses.zju.edu.cn/course/${courseId}/content#/`,
      raw: { course_id: courseId, classroom },
    });
  }
  return output;
}

export function normalizePintiaItems(items, nowEpoch = Date.now()) {
  const output = [];
  for (const item of items || []) {
    const end = parseExternalDateTime(item?.endAt);
    if (!end || beijingEpoch(end) <= nowEpoch) continue;
    output.push({
      source: 'pintia',
      external_id: `pintia:problem-set:${item.id}`,
      title: item.name || '未命名 Pintia 题集',
      course_name: item.organizationName || item.ownerNickname || 'Pintia',
      ddl_at: end,
      type: 'problem_set',
      url: `https://pintia.cn/problem-sets/${item.id}/exam/problems`,
      raw: item,
    });
  }
  return output.sort((left, right) => (left.ddl_at || '').localeCompare(right.ddl_at || ''));
}

export function dedupeExternalItems(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = `${item.source}\u0000${item.external_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
