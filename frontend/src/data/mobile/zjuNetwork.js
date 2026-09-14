import { clearNativeCookies, nativeRequest } from '../../platform/nativeHttp.js';
import {
  dedupeExternalItems,
  normalizeCourseItems,
  normalizePintiaItems,
  parseZdbkQueryItems,
} from './zjuNormalize.js';

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/142 Mobile Safari/537.36';
const ALLOWED_HOSTS = new Set([
  'zjuam.zju.edu.cn',
  'courses.zju.edu.cn',
  'zdbk.zju.edu.cn',
  'pintia.cn',
  'calendar.celechron.top',
]);
let networkSessionTail = Promise.resolve();

export class ZjuNetworkError extends Error {
  constructor(message, code = 'ZJU_NETWORK_ERROR') {
    super(message);
    this.name = 'ZjuNetworkError';
    this.code = code;
  }
}

function safeNetworkError(error, prefix = '网络请求失败') {
  if (error instanceof ZjuNetworkError) return error;
  const category = String(error?.category || '').toLowerCase();
  const messages = {
    timeout: '请求超时',
    dns: '无法解析服务器地址',
    tls: '安全连接失败',
    connection: '无法连接服务器',
    cancelled: '请求已取消',
    unavailable: 'Android 原生网络组件不可用',
    response: '服务器响应过大或格式异常',
  };
  const codes = {
    timeout: 'ZJU_TIMEOUT',
    dns: 'ZJU_DNS_ERROR',
    tls: 'ZJU_TLS_ERROR',
    connection: 'ZJU_CONNECTION_ERROR',
    cancelled: 'ZJU_CANCELLED',
    unavailable: 'ZJU_NATIVE_HTTP_UNAVAILABLE',
    response: 'ZJU_RESPONSE_INVALID',
  };
  return new ZjuNetworkError(`${prefix}：${messages[category] || '网络连接异常'}`, codes[category] || 'ZJU_NETWORK_ERROR');
}

function requireAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ZjuNetworkError('学校服务返回了无效地址', 'ZJU_REDIRECT_INVALID');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new ZjuNetworkError('已阻止不安全的学校服务地址', 'ZJU_REDIRECT_BLOCKED');
  }
  return url;
}

function header(response, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(response?.headers || {}).find(([key]) => key.toLowerCase() === target);
  return entry ? String(entry[1]) : '';
}

function redirectLocation(currentUrl, response) {
  const location = header(response, 'location');
  if (!location) throw new ZjuNetworkError('学校登录跳转缺少目标地址', 'ZJU_REDIRECT_INVALID');
  return requireAllowedUrl(new URL(location, currentUrl).toString()).toString();
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

async function request(url, options = {}) {
  const safeUrl = requireAllowedUrl(url).toString();
  try {
    return await nativeRequest({
      url: safeUrl,
      method: options.method || 'GET',
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      body: options.body ?? null,
      redirect: options.redirect || 'manual',
      maxRedirects: options.maxRedirects ?? 8,
      connectTimeoutMs: options.connectTimeoutMs ?? 15000,
      readTimeoutMs: options.readTimeoutMs ?? 30000,
      maxResponseBytes: options.maxResponseBytes ?? 8 * 1024 * 1024,
      responseType: 'text',
    });
  } catch (error) {
    throw safeNetworkError(error);
  }
}

function requireSuccess(response, message) {
  const status = Number(response?.status || 0);
  if (status < 200 || status >= 300) {
    throw new ZjuNetworkError(`${message}（HTTP ${status || '未知'}）`, 'ZJU_HTTP_ERROR');
  }
  return response;
}

function parseJsonResponse(response, message) {
  requireSuccess(response, message);
  try {
    return JSON.parse(String(response.body || ''));
  } catch {
    throw new ZjuNetworkError(`${message}：服务器返回格式异常`, 'ZJU_RESPONSE_INVALID');
  }
}

function formBody(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.set(key, String(value ?? ''));
  return params.toString();
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

export function encryptCasPassword(password, exponentHex, modulusHex) {
  if (!/^[0-9a-f]+$/i.test(String(exponentHex)) || !/^[0-9a-f]+$/i.test(String(modulusHex))) {
    throw new ZjuNetworkError('CAS 公钥格式异常', 'ZJU_CAS_KEY_INVALID');
  }
  let value = 0n;
  for (const character of String(password)) {
    value = value * 256n + BigInt(character.codePointAt(0));
  }
  const modulus = BigInt(`0x${modulusHex}`);
  const encrypted = modPow(value, BigInt(`0x${exponentHex}`), modulus);
  return encrypted.toString(16).padStart(String(modulusHex).length, '0');
}

function casMessage(html) {
  const match = String(html || '').match(/<span[^>]+id=["']msg["'][^>]*>([^<]+)<\/span>/i);
  return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
}

async function readCasExecution(loginUrl) {
  const response = await request(loginUrl, { redirect: 'manual' });
  if (isRedirect(response.status)) return { execution: '', redirectUrl: redirectLocation(loginUrl, response) };
  requireSuccess(response, '读取统一身份认证页面失败');
  const html = String(response.body || '');
  const match = html.match(/name=["']execution["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']+)["'][^>]*name=["']execution["']/i);
  if (!match) throw new ZjuNetworkError('无法读取统一身份认证参数', 'ZJU_CAS_EXECUTION_MISSING');
  return { execution: match[1], redirectUrl: '' };
}

async function casPublicKey() {
  const response = await request('https://zjuam.zju.edu.cn/cas/v2/getPubKey');
  const data = parseJsonResponse(response, '读取统一身份认证公钥失败');
  if (!data?.modulus || !data?.exponent) {
    throw new ZjuNetworkError('统一身份认证公钥缺失', 'ZJU_CAS_KEY_INVALID');
  }
  return data;
}

async function postCasLogin(loginUrl, execution, username, password) {
  const key = await casPublicKey();
  const encrypted = encryptCasPassword(password, key.exponent, key.modulus);
  const response = await request(loginUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: formBody({
      username,
      password: encrypted,
      execution,
      _eventId: 'submit',
      authcode: '',
    }),
  });
  if (isRedirect(response.status)) return redirectLocation(loginUrl, response);
  const message = casMessage(response.body);
  if (message) throw new ZjuNetworkError(`统一身份认证失败：${message}`, 'ZJU_AUTH_FAILED');
  throw new ZjuNetworkError(`统一身份认证失败（HTTP ${response.status}）`, 'ZJU_AUTH_FAILED');
}

async function casLoginService(serviceUrl, username, password) {
  const login = new URL('https://zjuam.zju.edu.cn/cas/login');
  login.searchParams.set('service', serviceUrl);
  const state = await readCasExecution(login.toString());
  if (state.redirectUrl) return state.redirectUrl;
  return postCasLogin(login.toString(), state.execution, username, password);
}

async function casLoginBase(username, password) {
  const loginUrl = 'https://zjuam.zju.edu.cn/cas/login';
  const state = await readCasExecution(loginUrl);
  if (state.redirectUrl) return;
  await postCasLogin(loginUrl, state.execution, username, password);
}

function requireCredentials(username, password) {
  if (!String(username || '').trim() || !String(password || '')) {
    throw new ZjuNetworkError('请填写 ZJU 学号和密码，或先保存凭据', 'ZJU_CREDENTIALS_REQUIRED');
  }
}

async function loginCourses(username, password) {
  requireCredentials(username, password);
  let url = 'https://courses.zju.edu.cn/user/index';
  for (let count = 0; count < 12 && new URL(url).hostname !== 'zjuam.zju.edu.cn'; count += 1) {
    const response = await request(url, { redirect: 'manual' });
    if (!isRedirect(response.status)) {
      requireSuccess(response, 'ZJU Courses 登录失败');
      return;
    }
    url = redirectLocation(url, response);
  }
  if (new URL(url).hostname !== 'zjuam.zju.edu.cn') {
    throw new ZjuNetworkError('ZJU Courses 登录跳转过多', 'ZJU_REDIRECT_LIMIT');
  }
  const service = new URL(url).searchParams.get('service');
  if (!service) throw new ZjuNetworkError('ZJU Courses 登录地址缺少 service 参数', 'ZJU_REDIRECT_INVALID');
  url = await casLoginService(service, username.trim(), password);
  for (let count = 0; count < 12; count += 1) {
    const response = await request(url, { redirect: 'manual' });
    const body = String(response.body || '');
    if (Number(response.status) === 200 && /meta\s+http-equiv=["']refresh["']/i.test(body)) {
      const match = body.match(/meta\s+http-equiv=["']refresh["']\s+content=["']0;\s*URL=([^"']+)["']/i);
      if (!match) throw new ZjuNetworkError('ZJU Courses 登录刷新地址无法解析', 'ZJU_REDIRECT_INVALID');
      url = requireAllowedUrl(new URL(match[1], url).toString()).toString();
    } else if (isRedirect(response.status)) {
      url = redirectLocation(url, response);
    } else if ([200, 204].includes(Number(response.status))) {
      return;
    } else {
      throw new ZjuNetworkError(`ZJU Courses 登录失败（HTTP ${response.status}）`, 'ZJU_AUTH_FAILED');
    }
  }
  throw new ZjuNetworkError('ZJU Courses 登录跳转过多', 'ZJU_REDIRECT_LIMIT');
}

async function loginZdbk(username, password) {
  requireCredentials(username, password);
  const serviceUrl = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html';
  let ticketUrl;
  try {
    ticketUrl = await casLoginService(serviceUrl, username.trim(), password);
  } catch (error) {
    if (!(error instanceof ZjuNetworkError) || error.code !== 'ZJU_CAS_EXECUTION_MISSING') throw error;
    await casLoginBase(username.trim(), password);
    ticketUrl = await casLoginService(serviceUrl, username.trim(), password);
  }
  let url = ticketUrl;
  for (let count = 0; count < 8; count += 1) {
    const response = await request(url, { redirect: 'manual' });
    if (isRedirect(response.status)) {
      url = redirectLocation(url, response);
      continue;
    }
    requireSuccess(response, 'ZDBK 登录失败');
    if (/login_ssologin|cas\/login|统一身份认证/i.test(String(response.body || ''))) {
      throw new ZjuNetworkError('ZDBK 登录未建立有效会话', 'ZJU_AUTH_FAILED');
    }
    return;
  }
  throw new ZjuNetworkError('ZDBK 登录跳转过多', 'ZJU_REDIRECT_LIMIT');
}

async function fetchJson(url, options = {}) {
  const response = await request(url, options);
  return parseJsonResponse(response, options.message || '读取学校数据失败');
}

async function fetchJsonOr(url, fallback, message) {
  try {
    return await fetchJson(url, { message });
  } catch {
    return fallback;
  }
}

async function mapConcurrent(items, limit, callback) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function fetchCoursesTodos(username, password) {
  await loginCourses(username, password);
  const semesters = await fetchJson(
    'https://courses.zju.edu.cn/api/my-semesters?fields=id,name,sort,is_active,code',
    { message: '读取 ZJU 学期失败' },
  );
  const semesterIds = [];
  for (const semester of semesters?.semesters || []) {
    if (!semester?.is_active || semester.id == null) continue;
    const numeric = Number(semester.id);
    if (Number.isFinite(numeric)) semesterIds.push(numeric, numeric + 1, numeric + 2);
    else semesterIds.push(semester.id);
  }
  const conditions = {
    role: [], semester_id: [...new Set(semesterIds)], academic_year_id: [],
    status: ['ongoing', 'notStarted'], course_type: [], effectiveness: [], published: [],
    display_studio_list: false,
  };
  const params = new URLSearchParams({
    page: '1', page_size: '1000', sort: 'all',
    normal: JSON.stringify({ version: 7, apiVersion: '1.1.0' }),
    conditions: JSON.stringify(conditions),
    fields: 'id,name,course_code',
  });
  const courseData = await fetchJson(`https://courses.zju.edu.cn/api/my-courses?${params}`, { message: '读取 ZJU 课程失败' });
  const unique = new Map((courseData?.courses || []).filter((course) => course?.id != null).map((course) => [course.id, course]));
  const nowEpoch = Date.now();
  const groups = await mapConcurrent([...unique.values()], 3, async (course) => {
    const id = encodeURIComponent(course.id);
    const [activities, exams, homework, submitted, classrooms] = await Promise.all([
      fetchJsonOr(`https://courses.zju.edu.cn/api/courses/${id}/activities`, {}, '读取课程活动失败'),
      fetchJsonOr(`https://courses.zju.edu.cn/api/courses/${id}/exams`, {}, '读取课程测验失败'),
      fetchJsonOr(`https://courses.zju.edu.cn/api/course/${id}/homework/submission-status?no-intercept=true`, {}, '读取作业状态失败'),
      fetchJsonOr(`https://courses.zju.edu.cn/api/courses/${id}/submitted-exams?no-intercept=true`, {}, '读取测验状态失败'),
      fetchJsonOr(`https://courses.zju.edu.cn/api/courses/${id}/classroom-list`, {}, '读取互动课堂失败'),
    ]);
    return normalizeCourseItems(course, {
      activities: activities.activities || [],
      exams: exams.exams || [],
      homeworkStatus: homework.homework_activities || [],
      submittedExams: submitted.exam_ids || [],
      classrooms: classrooms.classrooms || [],
    }, nowEpoch);
  });
  return groups.flat().sort((left, right) => (left.ddl_at || '9999').localeCompare(right.ddl_at || '9999'));
}

async function fetchPintiaTodos(cookie) {
  if (!String(cookie || '').trim()) return [];
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const params = new URLSearchParams({
    filter: JSON.stringify({ endAtAfter: midnight.toISOString() }),
    limit: '100', order_by: 'END_AT', asc: 'true',
  });
  const data = await fetchJson(`https://pintia.cn/api/problem-sets?${params}`, {
    headers: {
      Accept: 'application/json;charset=UTF-8',
      'Accept-Language': 'zh-CN',
      Cookie: String(cookie).trim(),
      Referer: 'https://pintia.cn/problem-sets/dashboard',
    },
    message: '读取 Pintia 题集失败',
  });
  return normalizePintiaItems(data?.problemSets || []);
}

async function runFreshCookieSession(callback) {
  try {
    try {
      await clearNativeCookies();
    } catch (error) {
      throw safeNetworkError(error, '初始化学校网络会话失败');
    }
    return await callback();
  } finally {
    try {
      await clearNativeCookies();
    } catch {
      // The original operation result is more useful; cookies remain memory-only.
    }
  }
}

function withFreshCookieSession(callback) {
  const operation = networkSessionTail.then(() => runFreshCookieSession(callback), () => runFreshCookieSession(callback));
  networkSessionTail = operation.catch(() => undefined);
  return operation;
}

export async function fetchExternalTodos({ username, password, pintiaCookie, includePintia }) {
  return withFreshCookieSession(async () => {
    const items = [];
    const errors = [];
    try {
      items.push(...await fetchCoursesTodos(username, password));
    } catch (error) {
      errors.push(`ZJU Courses：${safeNetworkError(error).message}`);
    }
    if (includePintia && String(pintiaCookie || '').trim()) {
      try {
        items.push(...await fetchPintiaTodos(pintiaCookie));
      } catch (error) {
        errors.push(`Pintia：${safeNetworkError(error).message}`);
      }
    }
    return { items: dedupeExternalItems(items), errors };
  });
}

export async function fetchCalendar(academicYear, semester) {
  const year = Number.parseInt(String(academicYear).split('-')[0], 10);
  if (!Number.isInteger(year)) throw new ZjuNetworkError('学年格式无效', 'ZJU_VALIDATION_ERROR');
  let response;
  try {
    response = await request(`https://calendar.celechron.top/${year}-${year + 1}-${semester}.json`);
  } catch (error) {
    if (error instanceof ZjuNetworkError && error.code === 'ZJU_TLS_ERROR') {
      throw new ZjuNetworkError(
        '校历源当前不支持安全连接；Android 已拒绝降级到明文 HTTP',
        'ZJU_CALENDAR_SECURE_TRANSPORT_UNAVAILABLE',
      );
    }
    throw error;
  }
  if (Number(response.status) === 404) {
    throw new ZjuNetworkError(`暂时没有 ${academicYear} ${Number(semester) === 1 ? '秋冬' : '春夏'} 学期的校历数据`, 'ZJU_CALENDAR_NOT_FOUND');
  }
  const data = parseJsonResponse(response, '拉取校历失败');
  if (!data || typeof data !== 'object' || !Array.isArray(data.startEnd)) {
    throw new ZjuNetworkError('校历数据格式异常', 'ZJU_RESPONSE_INVALID');
  }
  return data;
}

export async function fetchZdbkTimetable(username, password, academicYear, semester) {
  return withFreshCookieSession(async () => {
    await loginZdbk(username, password);
    const response = await request('https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: formBody({
        xnm: String(academicYear).split('-')[0].trim(),
        xqm: Number(semester) === 1 ? '3' : '12',
        kzlx: 'ck',
      }),
    });
    const data = parseJsonResponse(response, '读取 ZDBK 课表失败');
    if (!data || typeof data !== 'object' || !Array.isArray(data.kbList || [])) {
      throw new ZjuNetworkError('ZDBK 课表响应格式异常', 'ZJU_RESPONSE_INVALID');
    }
    return data.kbList || [];
  });
}

async function fetchGradeItems(url) {
  const response = await request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Connection: 'close',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html',
    },
  });
  requireSuccess(response, '读取 ZDBK 成绩失败');
  try {
    return parseZdbkQueryItems(response.body);
  } catch (error) {
    if (error?.message === 'ZDBK_SESSION_EXPIRED') {
      throw new ZjuNetworkError('ZDBK 会话已失效，请重试', 'ZJU_SESSION_EXPIRED');
    }
    throw new ZjuNetworkError('ZDBK 成绩响应格式异常', 'ZJU_RESPONSE_INVALID');
  }
}

export async function fetchZdbkGrades(username, password, includeMajor = true) {
  return withFreshCookieSession(async () => {
    await loginZdbk(username, password);
    const items = await fetchGradeItems(
      'https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000',
    );
    const errors = [];
    let majorItems = [];
    if (includeMajor) {
      try {
        majorItems = await fetchGradeItems(
          'https://zdbk.zju.edu.cn/jwglxt/zycjtj/xszgkc_cxXsZgkcIndex.html?doType=query&queryModel.showCount=5000',
        );
      } catch (error) {
        errors.push(`主修成绩读取失败：${safeNetworkError(error).message}`);
      }
    }
    return { items, majorItems, errors };
  });
}
