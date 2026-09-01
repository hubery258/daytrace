import { Capacitor, registerPlugin } from '@capacitor/core'

export const RijiHttp = registerPlugin('RijiHttp')

export const NATIVE_REQUEST_CATEGORY = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  UNAVAILABLE: 'unavailable',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  DNS: 'dns',
  TLS: 'tls',
  CONNECTION: 'connection',
  NETWORK: 'network',
  REDIRECT: 'redirect',
  RESPONSE: 'response',
  HTTP: 'http',
  UNKNOWN: 'unknown',
})

const ERROR_CATEGORIES = Object.freeze({
  INVALID_ARGUMENT: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
  DUPLICATE_REQUEST_ID: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
  UNIMPLEMENTED: NATIVE_REQUEST_CATEGORY.UNAVAILABLE,
  UNAVAILABLE: NATIVE_REQUEST_CATEGORY.UNAVAILABLE,
  REQUEST_CANCELLED: NATIVE_REQUEST_CATEGORY.CANCELLED,
  TIMEOUT: NATIVE_REQUEST_CATEGORY.TIMEOUT,
  DNS_ERROR: NATIVE_REQUEST_CATEGORY.DNS,
  TLS_ERROR: NATIVE_REQUEST_CATEGORY.TLS,
  SECURITY_ERROR: NATIVE_REQUEST_CATEGORY.TLS,
  CONNECTION_ERROR: NATIVE_REQUEST_CATEGORY.CONNECTION,
  NETWORK_ERROR: NATIVE_REQUEST_CATEGORY.NETWORK,
  PROTOCOL_ERROR: NATIVE_REQUEST_CATEGORY.NETWORK,
  REDIRECT_DISALLOWED: NATIVE_REQUEST_CATEGORY.REDIRECT,
  TOO_MANY_REDIRECTS: NATIVE_REQUEST_CATEGORY.REDIRECT,
  INVALID_REDIRECT: NATIVE_REQUEST_CATEGORY.REDIRECT,
  INSECURE_REDIRECT: NATIVE_REQUEST_CATEGORY.REDIRECT,
  RESPONSE_TOO_LARGE: NATIVE_REQUEST_CATEGORY.RESPONSE,
})

export class NativeRequestError extends Error {
  constructor(message, { code = 'REQUEST_FAILED', category, status = null, response = null, cause } = {}) {
    super(message)
    this.name = 'NativeRequestError'
    this.code = code
    this.category = category || ERROR_CATEGORIES[code] || NATIVE_REQUEST_CATEGORY.UNKNOWN
    this.status = status
    this.response = response
    if (cause !== undefined) this.cause = cause
  }
}

export function classifyNativeRequestError(error) {
  if (error instanceof NativeRequestError) return error

  const code = typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED'
  const category = ERROR_CATEGORIES[code] || NATIVE_REQUEST_CATEGORY.UNKNOWN
  const safeMessage = category === NATIVE_REQUEST_CATEGORY.UNKNOWN
    ? 'Native request failed'
    : (typeof error?.message === 'string' ? error.message : 'Native request failed')

  return new NativeRequestError(safeMessage, { code, category, cause: error })
}

export function isNativeHttpAvailable() {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('RijiHttp')
}

export async function nativeRequest(options = {}) {
  if (!isNativeHttpAvailable()) {
    throw new NativeRequestError('Android native HTTP is unavailable', {
      code: 'UNAVAILABLE',
      category: NATIVE_REQUEST_CATEGORY.UNAVAILABLE,
    })
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new NativeRequestError('Native request options must be an object', {
      code: 'INVALID_ARGUMENT',
      category: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
    })
  }

  const {
    signal,
    throwHttpErrors = false,
    body,
    headers,
    requestId = createRequestId(),
    ...nativeOptions
  } = options

  if (signal != null && typeof signal.addEventListener !== 'function') {
    throw new NativeRequestError('signal must be an AbortSignal', {
      code: 'INVALID_ARGUMENT',
      category: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
    })
  }
  if (signal?.aborted) {
    throw new NativeRequestError('Request was cancelled', {
      code: 'REQUEST_CANCELLED',
      category: NATIVE_REQUEST_CATEGORY.CANCELLED,
    })
  }

  const normalizedHeaders = normalizeHeaders(headers)
  const normalizedBody = normalizeBody(body, normalizedHeaders)
  const abort = () => {
    void RijiHttp.cancel({ requestId }).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    const response = await RijiHttp.request({
      ...nativeOptions,
      requestId,
      headers: normalizedHeaders,
      body: normalizedBody,
    })

    if (throwHttpErrors && (response.status < 200 || response.status >= 300)) {
      throw new NativeRequestError(`HTTP request failed with status ${response.status}`, {
        code: 'HTTP_ERROR',
        category: NATIVE_REQUEST_CATEGORY.HTTP,
        status: response.status,
        response,
      })
    }
    return response
  } catch (error) {
    throw classifyNativeRequestError(error)
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

export async function cancelNativeRequest(requestId) {
  try {
    const result = await RijiHttp.cancel({ requestId })
    return result?.cancelled === true
  } catch (error) {
    throw classifyNativeRequestError(error)
  }
}

export async function clearNativeCookies() {
  if (!isNativeHttpAvailable()) {
    throw new NativeRequestError('Android native HTTP is unavailable', {
      code: 'UNAVAILABLE',
      category: NATIVE_REQUEST_CATEGORY.UNAVAILABLE,
    })
  }
  try {
    await RijiHttp.clearCookies()
  } catch (error) {
    throw classifyNativeRequestError(error)
  }
}

function normalizeHeaders(headers) {
  if (headers == null) return {}
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new NativeRequestError('headers must be an object', {
      code: 'INVALID_ARGUMENT',
      category: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
    })
  }

  const normalized = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[name] = value
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      normalized[name] = [...value]
    } else {
      throw new NativeRequestError('header values must be strings or string arrays', {
        code: 'INVALID_ARGUMENT',
        category: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
      })
    }
  }
  return normalized
}

function normalizeBody(body, headers) {
  if (body == null) return null
  if (typeof body === 'string') return body
  if (typeof body === 'object') {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8'
    try {
      return JSON.stringify(body)
    } catch {
      throw new NativeRequestError('request body is not JSON serializable', {
        code: 'INVALID_ARGUMENT',
        category: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
      })
    }
  }
  throw new NativeRequestError('request body must be a string or JSON value', {
    code: 'INVALID_ARGUMENT',
    category: NATIVE_REQUEST_CATEGORY.INVALID_REQUEST,
  })
}

function hasHeader(headers, target) {
  return Object.keys(headers).some((name) => name.toLowerCase() === target)
}

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const random = Math.random().toString(36).slice(2)
  return `riji-${Date.now().toString(36)}-${random}`
}
