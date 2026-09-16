/**
 * Pure helpers behind the v0.11.0 WebDAV settings UI.
 *
 * Keeping validation, modal summaries and error text in pure functions lets the
 * React panel stay thin and lets the logic be unit tested without a DOM.
 */

export const DEFAULT_REMOTE_DIRECTORY = 'daytrace';
export const DEFAULT_REMOTE_FILENAME = 'daytrace-latest.json';
export const WEBDAV_INSECURE_WARNING = '当前服务器地址未使用 HTTPS。WebDAV 密码会以明文经过网络，请确认你信任该服务器后再继续。';
export const WEBDAV_REMEMBER_HINT = 'Windows 和 Android 使用系统安全存储；Web 端使用加密后的浏览器本地存储，安全性低于系统钥匙串。关闭记住密码后，关闭页面需要重新输入。';
export const WEBDAV_UPLOAD_WARNING = '上传会用本机数据覆盖远端 daytrace-latest.json。该操作不合并远端数据。如果远端文件更新时间更晚，请先下载并确认。';
export const WEBDAV_DOWNLOAD_NOTICE = '下载后会先进入导入预览，不会直接覆盖本机数据。具体合并规则沿用现有 JSON 合并逻辑。';
export const WEBDAV_AUTO_SYNC_TEASER = '自动同步将在 v0.11.1 提供：应用运行期间按设定间隔自动上传；应用关闭后不继续后台同步。';

export const WEBDAV_ENTITY_LABELS = Object.freeze({
  projects: '项目',
  todos: '待办',
  schedules: '计划日程',
  time_block_categories: '时间块属性',
  time_blocks: '实际时间块',
  daily_logs: '每日总结',
  log_templates: '日志模板',
  timer_sessions: '计时会话',
  recurrence_rules: '重复规则',
  recurrence_exceptions: '重复例外',
});

export const SYNC_ERROR_MESSAGES = Object.freeze({
  WEBDAV_URL_INVALID: '服务器地址格式不正确。',
  WEBDAV_INSECURE_HTTP: '当前服务器地址未使用 HTTPS，需要先确认安全风险。',
  WEBDAV_NETWORK_ERROR: '无法连接 WebDAV 服务器，请检查地址和网络。',
  WEBDAV_TLS_ERROR: '服务器证书校验失败。',
  WEBDAV_AUTH_FAILED: '用户名或应用密码错误。',
  WEBDAV_FORBIDDEN: '没有访问或写入权限。',
  WEBDAV_NOT_FOUND: '远端文件或目录不存在。',
  WEBDAV_METHOD_NOT_ALLOWED: '当前服务器不支持所需 WebDAV 操作。',
  WEBDAV_CONFLICT: '远端文件已被其他设备修改，请重新读取后再上传。',
  WEBDAV_QUOTA_EXCEEDED: '远端空间不足。',
  WEBDAV_INVALID_PACKAGE: '远端文件不是有效的日迹数据包。',
  WEBDAV_UNSUPPORTED_SCHEMA: '数据包 schema_version 不受支持。',
  SYNC_BUSY: '当前正在同步，请稍后重试。',
  SYNC_PASSWORD_REQUIRED: '请先填写 WebDAV 密码。',
  SYNC_CONFIRMATION_REQUIRED: '需要确认后才能上传。',
});

export function emptyWebdavForm(overrides = {}) {
  return {
    base_url: '',
    username: '',
    password: '',
    remember_password: false,
    remote_directory: DEFAULT_REMOTE_DIRECTORY,
    remote_filename: DEFAULT_REMOTE_FILENAME,
    allow_insecure_http: false,
    show_password: false,
    show_advanced: false,
    ...overrides,
  };
}

export function validateBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { valid: false, isHttps: false, error: '请填写服务器地址。' };
  if (value.length > 2048 || /\s/.test(value)) return { valid: false, isHttps: false, error: '服务器地址格式不正确。' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { valid: false, isHttps: false, error: '服务器地址格式不正确。' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    return { valid: false, isHttps: false, error: '服务器地址格式不正确。' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, isHttps: false, error: '服务器地址中不要包含用户名或密码。' };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, isHttps: false, error: '服务器地址不要包含查询参数或锚点。' };
  }
  const isHttps = parsed.protocol === 'https:';
  return {
    valid: true,
    isHttps,
    normalized: `${parsed.protocol}//${parsed.host}${parsed.pathname ? parsed.pathname.replace(/\/+$/, '') : ''}`,
    warning: isHttps ? '' : WEBDAV_INSECURE_WARNING,
  };
}

export function validateRemoteDirectory(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { valid: false, error: '远程目录不能为空。' };
  if (value.length > 300) return { valid: false, error: '远程目录过长。' };
  if (value.includes('\\')) return { valid: false, error: '远程目录不允许反斜杠。' };
  const segments = value.split('/').filter((segment) => segment !== '');
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    return { valid: false, error: '远程目录不允许 . 或 .. 。' };
  }
  return { valid: true, normalized: segments.join('/') };
}

export function validateRemoteFilename(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { valid: false, error: '远程文件名不能为空。' };
  if (value.length > 200) return { valid: false, error: '远程文件名过长。' };
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    return { valid: false, error: '远程文件名不能包含路径分隔符。' };
  }
  return { valid: true, normalized: value };
}

export function validateWebdavForm(form) {
  const errors = {};
  const url = validateBaseUrl(form.base_url);
  if (!url.valid) errors.base_url = url.error;
  if (!String(form.username ?? '').trim()) errors.username = '请填写用户名。';
  if (!form.password && !form.has_password) errors.password = '请填写密码或应用密码。';
  const directory = validateRemoteDirectory(form.remote_directory || DEFAULT_REMOTE_DIRECTORY);
  if (!directory.valid) errors.remote_directory = directory.error;
  const filename = validateRemoteFilename(form.remote_filename || DEFAULT_REMOTE_FILENAME);
  if (!filename.valid) errors.remote_filename = filename.error;
  const fieldOrder = ['base_url', 'username', 'password', 'remote_directory', 'remote_filename'];
  const invalidFields = fieldOrder.filter((field) => errors[field]);
  return {
    valid: invalidFields.length === 0,
    errors,
    fieldOrder,
    invalidFields,
    firstError: invalidFields.length ? errors[invalidFields[0]] : '',
    needsHttpConfirmation: Boolean(url.valid && !url.isHttps),
    normalized: {
      base_url: url.valid ? url.normalized : String(form.base_url ?? '').trim(),
      username: String(form.username ?? '').trim(),
      remote_directory: directory.valid ? directory.normalized : String(form.remote_directory ?? '').trim(),
      remote_filename: filename.valid ? filename.normalized : String(form.remote_filename ?? '').trim(),
    },
  };
}

export function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

export function formatSyncTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const parsed = new Date(text.includes('T') || text.includes(' ') ? text.replace(' ', 'T') : text);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

export function entityCountRows(entityCounts) {
  if (!entityCounts || typeof entityCounts !== 'object') return [];
  return Object.entries(entityCounts)
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => ({ key: name, label: WEBDAV_ENTITY_LABELS[name] || name, count: Number(count) }));
}

function remoteFileRows(remote, { includeExport = true } = {}) {
  const rows = [
    { key: 'path', label: '远端文件路径', value: remote?.path || '—' },
    { key: 'exists', label: '远端文件是否存在', value: remote?.exists ? '存在' : '不存在' },
  ];
  if (includeExport) {
    rows.push({ key: 'remote_exported_at', label: '远端导出时间', value: formatSyncTime(remote?.exported_at) });
  }
  rows.push(
    { key: 'last_modified', label: '远端最后修改时间', value: formatSyncTime(remote?.last_modified) },
    { key: 'content_length', label: '远端文件大小', value: formatBytes(remote?.content_length) },
    { key: 'etag', label: '远端 ETag', value: remote?.etag || '未提供' },
  );
  return rows;
}

export function buildUploadConfirmView({ local, remote } = {}) {
  const rows = [
    { key: 'local_schema', label: '本机数据版本', value: local?.schema_version || '—' },
    { key: 'local_exported_at', label: '本机导出时间', value: formatSyncTime(local?.exported_at) },
    ...entityCountRows(local?.entity_counts).map((item) => ({
      key: `local_${item.key}`, label: `本机${item.label}`, value: `${item.count} 条`,
    })),
    ...remoteFileRows(remote, { includeExport: true }),
  ];
  const localTime = Date.parse(String(local?.exported_at ?? ''));
  const remoteTime = Date.parse(String(remote?.exported_at ?? ''));
  const remoteNewer = Number.isFinite(localTime) && Number.isFinite(remoteTime) && remoteTime > localTime;
  const warnings = [WEBDAV_UPLOAD_WARNING];
  if (remoteNewer) warnings.push('远端导出时间晚于本机导出时间，建议先下载并确认远端数据。');
  if (remote?.package_error) warnings.push(`远端文件信息读取失败：${remote.package_error}`);
  return {
    title: '上传本机数据',
    confirmLabel: '确认上传',
    cancelLabel: '取消',
    rows,
    warnings,
    remoteNewer,
    expectedRemoteEtag: remote?.exists ? (remote?.etag ?? null) : null,
    expectedRemoteExists: Boolean(remote?.exists),
  };
}

export function buildDownloadSummaryView({ remote, package: dataPackage, summary } = {}) {
  const counts = summary?.entity_counts || {};
  const rows = [
    { key: 'path', label: '远端文件路径', value: remote?.path || '—' },
    { key: 'etag', label: '远端 ETag', value: remote?.etag || '未提供' },
    { key: 'last_modified', label: '远端最后修改时间', value: formatSyncTime(remote?.last_modified) },
    { key: 'content_length', label: '远端文件大小', value: formatBytes(remote?.content_length) },
    { key: 'schema_version', label: 'schema_version', value: dataPackage?.schema_version || '—' },
    { key: 'exported_at', label: '远端导出时间', value: formatSyncTime(dataPackage?.exported_at) },
    { key: 'total', label: '实体总数', value: `${Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0)} 条` },
  ];
  return {
    title: '下载远端数据',
    confirmLabel: '继续预览',
    cancelLabel: '取消',
    notice: WEBDAV_DOWNLOAD_NOTICE,
    rows,
    entityRows: entityCountRows(counts),
  };
}

export function describeSyncError(error) {
  if (!error) return { code: null, message: '', hint: '' };
  const code = error.code || null;
  const message = SYNC_ERROR_MESSAGES[code] || error.message || '同步失败，请稍后重试。';
  const hints = {
    WEBDAV_CONFLICT: '远端文件在预览后被修改。请重新点击上传，先读取最新的远端信息。',
    WEBDAV_AUTH_FAILED: '建议使用应用密码，不要直接使用主账号密码。',
    WEBDAV_FORBIDDEN: '请确认远程目录存在且当前账号有写入权限。',
    WEBDAV_NOT_FOUND: '请确认远程目录已经存在，必要时先在 WebDAV 客户端中手动创建。',
    WEBDAV_QUOTA_EXCEEDED: '请清理远端空间或更换远程目录。',
    SYNC_BUSY: '当前正在同步，按钮会在结束后恢复。',
  };
  return { code, message, hint: hints[code] || '' };
}

export function syncStatusView(status, config) {
  if (!status && !config) return { configured: false, rows: [] };
  const configured = Boolean(status?.configured);
  const hasPassword = Boolean(status?.has_password ?? config?.has_password);
  const rows = [];
  if (!configured) {
    rows.push({ key: 'state', label: '状态', value: hasPassword ? '尚未同步' : '尚未配置' });
  } else if (status?.last_error) {
    rows.push({ key: 'last_error', label: '上次失败', value: `${formatSyncTime(status.last_sync_at)}：${status.last_error}` });
  } else if (status?.last_success_at) {
    rows.push({ key: 'last_success', label: '上次上传成功', value: formatSyncTime(status.last_success_at) });
  } else {
    rows.push({ key: 'state', label: '状态', value: '尚未同步' });
  }
  if (status?.last_download_at) {
    rows.push({ key: 'last_download', label: '上次下载预览', value: formatSyncTime(status.last_download_at) });
  }
  rows.push(
    { key: 'remote_file', label: '当前远端文件', value: config?.remote_filename || DEFAULT_REMOTE_FILENAME },
    { key: 'remote_path', label: '当前远端路径', value: status?.remote_path || '—' },
    { key: 'remote_etag', label: '当前远端 ETag', value: status?.last_remote_etag || '未读取' },
    { key: 'remote_modified', label: '当前远端最后修改时间', value: formatSyncTime(status?.last_remote_modified_at) },
  );
  if (!hasPassword) rows.push({ key: 'password', label: '密码状态', value: '未保存，需要重新输入密码' });
  return { configured, hasPassword, busy: Boolean(status?.busy), rows };
}

export function applyConfigToForm(config, form = emptyWebdavForm()) {
  if (!config) return form;
  return {
    ...form,
    base_url: config.base_url || '',
    username: config.username || '',
    remember_password: Boolean(config.remember_password),
    remote_directory: config.remote_directory || DEFAULT_REMOTE_DIRECTORY,
    remote_filename: config.remote_filename || DEFAULT_REMOTE_FILENAME,
    allow_insecure_http: Boolean(config.allow_insecure_http),
    has_password: Boolean(config.has_password),
    password: '',
  };
}
