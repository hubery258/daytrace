const STATUS_CODES = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
});

function stablePayloadCode(payload) {
  const candidate = payload?.code ?? payload?.error?.code;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]*$/.test(candidate)
    ? candidate
    : null;
}

export function codeForHttpStatus(status, payload = null) {
  const supplied = stablePayloadCode(payload);
  if (supplied) return supplied;
  if (STATUS_CODES[status]) return STATUS_CODES[status];
  if (status >= 500) return 'SERVER_ERROR';
  return 'HTTP_ERROR';
}

export function normalizeFieldErrors(detail) {
  if (!Array.isArray(detail)) return [];
  return detail.map((item) => {
    const location = Array.isArray(item?.loc) ? item.loc.map(String) : [];
    return Object.freeze({
      path: location.filter((part) => !['body', 'query', 'path'].includes(part)).join('.'),
      location: Object.freeze(location),
      message: String(item?.msg || item?.message || '字段无效'),
      code: String(item?.type || item?.code || 'invalid_value'),
    });
  });
}

function messageFromDetail(detail, fallback) {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const first = detail.find((item) => item?.msg || item?.message);
    if (first) return String(first.msg || first.message);
  }
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
    return detail.message;
  }
  return fallback;
}

export class ApiError extends Error {
  constructor(message, {
    status = 0,
    code = 'UNKNOWN_ERROR',
    detail = null,
    fieldErrors = [],
    capabilityId = null,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = Number.isFinite(Number(status)) ? Number(status) : 0;
    this.code = code;
    this.detail = detail;
    this.fieldErrors = fieldErrors;
    this.capabilityId = capabilityId;
  }
}

export function createHttpApiError({ status, statusText = '', payload = null, capabilityId = null }) {
  const detail = payload?.detail ?? payload?.message ?? payload ?? null;
  const fallback = statusText || `请求失败（HTTP ${status}）`;
  return new ApiError(messageFromDetail(detail, fallback), {
    status,
    code: codeForHttpStatus(status, payload),
    detail,
    fieldErrors: normalizeFieldErrors(detail),
    capabilityId,
  });
}

export function createInvalidResponseError({ detail = null, capabilityId = null, cause } = {}) {
  return new ApiError('服务返回了无法解析的数据', {
    status: 0,
    code: 'INVALID_RESPONSE',
    detail,
    capabilityId,
    cause,
  });
}

export function normalizeApiError(error, {
  capabilityId = null,
  defaultCode = 'UNKNOWN_ERROR',
  defaultMessage = '请求失败',
} = {}) {
  if (error instanceof ApiError) {
    if (capabilityId && !error.capabilityId) error.capabilityId = capabilityId;
    return error;
  }
  const aborted = error?.name === 'AbortError';
  return new ApiError(
    aborted ? '请求已取消' : (error?.message || defaultMessage),
    {
      status: 0,
      code: aborted ? 'REQUEST_ABORTED' : defaultCode,
      detail: error?.message || null,
      capabilityId,
      cause: error,
    },
  );
}
