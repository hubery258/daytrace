import { Capacitor } from '@capacitor/core';
import {
  NATIVE_REQUEST_CATEGORY,
  NativeRequestError,
  nativeRequest,
} from '../platform/nativeHttp.js';
import {
  getSecureValue,
  removeSecureValue,
  setSecureValue,
} from '../platform/secureStorage.js';

export const AI_STORAGE_KEYS = Object.freeze({
  apiKey: 'simpletasker_api_key',
  apiBase: 'simpletasker_api_base',
  model: 'simpletasker_ai_model',
  prompt: 'simpletasker_ai_prompt',
});

export const DEFAULT_AI_API_BASE = 'https://api.deepseek.com';
export const DEFAULT_AI_MODEL = 'deepseek-chat';
export const DEFAULT_AI_TIMEOUT_MS = 45_000;

export const AI_REQUEST_CATEGORY = Object.freeze({
  CONFIG: 'config',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  OFFLINE: 'offline',
  TLS: 'tls',
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  HTTP: 'http',
  INVALID_RESPONSE: 'invalid_response',
  UNKNOWN: 'unknown',
});

const ANDROID_SECURE_KEY = 'ai.api-key.v1';
// This non-secret marker keeps legacy synchronous UI checks working. The real
// key is held by AndroidKeyStore-backed storage and never enters localStorage.
const ANDROID_CONFIGURED_MARKER = '__RIJI_ANDROID_SECURE_KEY__';
const MAX_PROVIDER_MESSAGE_LENGTH = 300;
let androidApiKeyCache = null;

export class AiRequestError extends Error {
  constructor(message, { code = 'AI_REQUEST_FAILED', category = AI_REQUEST_CATEGORY.UNKNOWN, status = null } = {}) {
    super(message);
    this.name = 'AiRequestError';
    this.code = code;
    this.category = category;
    this.status = status;
  }
}

function isAndroidRuntime() {
  return Capacitor.getPlatform() === 'android';
}

function storageGet(key) {
  try {
    return globalThis.localStorage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function storageSet(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // A storage marker is only a UI hint; secure storage remains authoritative.
  }
}

function storageRemove(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // See storageSet: failure here never moves the secret out of secure storage.
  }
}

function publicApiKeyValue() {
  const stored = storageGet(AI_STORAGE_KEYS.apiKey);
  if (!isAndroidRuntime()) return stored;
  return stored ? ANDROID_CONFIGURED_MARKER : '';
}

export function getAiConfig() {
  return {
    apiKey: publicApiKeyValue(),
    apiBase: (storageGet(AI_STORAGE_KEYS.apiBase) || DEFAULT_AI_API_BASE).replace(/\/+$/, ''),
    model: storageGet(AI_STORAGE_KEYS.model) || DEFAULT_AI_MODEL,
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        return typeof part?.text === 'string' ? part.text : '';
      })
      .join('');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

export function extractChatCompletionResult(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message;
  const content = message?.content;
  const text = contentToText(content);
  const contentFormat = !text.trim()
    ? 'empty'
    : Array.isArray(content)
      ? 'parts'
      : typeof content === 'string'
        ? 'text'
        : content == null
          ? 'empty'
          : typeof content;
  const reasoningContent = message?.reasoning_content;

  return {
    text,
    responseMeta: {
      finishReason: choice?.finish_reason ?? null,
      model: typeof data?.model === 'string' ? data.model : null,
      contentFormat,
      hasReasoningContent: typeof reasoningContent === 'string'
        ? !!reasoningContent.trim()
        : Array.isArray(reasoningContent) && reasoningContent.length > 0,
      completionTokens: Number.isFinite(data?.usage?.completion_tokens)
        ? data.usage.completion_tokens
        : null,
    },
  };
}

export async function loadAiConfig() {
  const config = getAiConfig();
  if (!isAndroidRuntime()) return config;

  if (androidApiKeyCache === null) {
    let key = await getSecureValue(ANDROID_SECURE_KEY);
    const legacyValue = storageGet(AI_STORAGE_KEYS.apiKey);

    // One-way migration for v0.7.x Android installs. Only remove the legacy
    // value after AndroidKeyStore-backed persistence succeeds.
    if (!key && legacyValue && legacyValue !== ANDROID_CONFIGURED_MARKER) {
      await setSecureValue(ANDROID_SECURE_KEY, legacyValue);
      key = legacyValue;
    }

    androidApiKeyCache = key || '';
    if (androidApiKeyCache) storageSet(AI_STORAGE_KEYS.apiKey, ANDROID_CONFIGURED_MARKER);
    else storageRemove(AI_STORAGE_KEYS.apiKey);
  }

  return { ...config, apiKey: androidApiKeyCache };
}

export async function saveAiConfig({ apiKey, apiBase, model, prompt } = {}) {
  const normalizedKey = String(apiKey || '').trim();
  const normalizedBase = String(apiBase || DEFAULT_AI_API_BASE).trim().replace(/\/+$/, '');
  const normalizedModel = String(model || DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL;

  if (isAndroidRuntime()) {
    if (normalizedKey) {
      await setSecureValue(ANDROID_SECURE_KEY, normalizedKey);
      androidApiKeyCache = normalizedKey;
      storageSet(AI_STORAGE_KEYS.apiKey, ANDROID_CONFIGURED_MARKER);
    } else {
      await removeSecureValue(ANDROID_SECURE_KEY);
      androidApiKeyCache = '';
      storageRemove(AI_STORAGE_KEYS.apiKey);
    }
  } else if (normalizedKey) {
    storageSet(AI_STORAGE_KEYS.apiKey, normalizedKey);
  } else {
    storageRemove(AI_STORAGE_KEYS.apiKey);
  }

  storageSet(AI_STORAGE_KEYS.apiBase, normalizedBase || DEFAULT_AI_API_BASE);
  storageSet(AI_STORAGE_KEYS.model, normalizedModel);
  if (prompt !== undefined) storageSet(AI_STORAGE_KEYS.prompt, String(prompt));

  return { apiKey: normalizedKey, apiBase: normalizedBase, model: normalizedModel };
}

export async function clearAiApiKey() {
  if (isAndroidRuntime()) {
    await removeSecureValue(ANDROID_SECURE_KEY);
    androidApiKeyCache = '';
  }
  storageRemove(AI_STORAGE_KEYS.apiKey);
}

function normalizeApiEndpoint(apiBase, android) {
  let url;
  try {
    url = new URL(`${String(apiBase || '').replace(/\/+$/, '')}/v1/chat/completions`);
  } catch {
    throw new AiRequestError('AI API 地址无效', {
      code: 'AI_INVALID_API_BASE',
      category: AI_REQUEST_CATEGORY.CONFIG,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new AiRequestError('AI API 地址无效', {
      code: 'AI_INVALID_API_BASE',
      category: AI_REQUEST_CATEGORY.CONFIG,
    });
  }
  if (android && url.protocol !== 'https:') {
    throw new AiRequestError('Android 上的 AI API 必须使用 HTTPS', {
      code: 'AI_HTTPS_REQUIRED',
      category: AI_REQUEST_CATEGORY.CONFIG,
    });
  }
  return url.toString();
}

function createDeadline(externalSignal, timeoutMs) {
  const normalizedTimeout = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeout) || normalizedTimeout < 1_000 || normalizedTimeout > 120_000) {
    throw new AiRequestError('AI 请求超时时间无效', {
      code: 'AI_INVALID_TIMEOUT',
      category: AI_REQUEST_CATEGORY.CONFIG,
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, normalizedTimeout);

  return {
    signal: controller.signal,
    timeoutMs: Math.floor(normalizedTimeout),
    didTimeOut: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function safeProviderMessage(raw, apiKey) {
  if (typeof raw !== 'string') return '';
  let message = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (apiKey) message = message.split(apiKey).join('[redacted]');
  return message.slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
}

function providerErrorMessage(responseText, apiKey) {
  try {
    const payload = JSON.parse(responseText);
    return safeProviderMessage(payload?.error?.message || payload?.message || '', apiKey);
  } catch {
    return '';
  }
}

function httpError(status, responseText, apiKey) {
  const providerMessage = providerErrorMessage(responseText, apiKey);
  if (status === 401 || status === 403) {
    return new AiRequestError(providerMessage || 'AI API 身份验证失败，请检查 API Key', {
      code: 'AI_AUTH_ERROR',
      category: AI_REQUEST_CATEGORY.AUTH,
      status,
    });
  }
  if (status === 429) {
    return new AiRequestError(providerMessage || 'AI API 请求过于频繁，请稍后再试', {
      code: 'AI_RATE_LIMIT',
      category: AI_REQUEST_CATEGORY.RATE_LIMIT,
      status,
    });
  }
  return new AiRequestError(providerMessage || `AI 请求失败 (${status})`, {
    code: 'AI_HTTP_ERROR',
    category: AI_REQUEST_CATEGORY.HTTP,
    status,
  });
}

function mapNativeError(error, deadline) {
  if (deadline.didTimeOut() || error?.category === NATIVE_REQUEST_CATEGORY.TIMEOUT) {
    return new AiRequestError('AI 请求超时，请稍后重试', {
      code: 'AI_TIMEOUT',
      category: AI_REQUEST_CATEGORY.TIMEOUT,
    });
  }
  if (error?.category === NATIVE_REQUEST_CATEGORY.CANCELLED) {
    return new AiRequestError('AI 请求已取消', {
      code: 'AI_CANCELLED',
      category: AI_REQUEST_CATEGORY.CANCELLED,
    });
  }
  if (error?.category === NATIVE_REQUEST_CATEGORY.TLS) {
    return new AiRequestError('AI 服务安全连接失败，请检查证书或系统时间', {
      code: 'AI_TLS_ERROR',
      category: AI_REQUEST_CATEGORY.TLS,
    });
  }
  if ([NATIVE_REQUEST_CATEGORY.DNS, NATIVE_REQUEST_CATEGORY.CONNECTION, NATIVE_REQUEST_CATEGORY.NETWORK].includes(error?.category)) {
    return new AiRequestError('无法连接 AI 服务，请检查网络', {
      code: 'AI_OFFLINE',
      category: AI_REQUEST_CATEGORY.OFFLINE,
    });
  }
  return new AiRequestError('Android 原生 AI 请求失败', {
    code: error instanceof NativeRequestError ? `AI_NATIVE_${error.code}` : 'AI_NATIVE_ERROR',
    category: AI_REQUEST_CATEGORY.UNKNOWN,
  });
}

async function performRequest({ endpoint, apiKey, payload, deadline, android }) {
  if (android) {
    let response;
    try {
      response = await nativeRequest({
        url: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: payload,
        signal: deadline.signal,
        connectTimeoutMs: Math.min(15_000, deadline.timeoutMs),
        readTimeoutMs: deadline.timeoutMs,
        maxResponseBytes: 2 * 1024 * 1024,
        maxRedirects: 3,
        redirect: 'follow',
        allowInsecureRedirects: false,
      });
    } catch (error) {
      throw mapNativeError(error, deadline);
    }
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status, response.body || '', apiKey);
    }
    return response.body || '';
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: deadline.signal,
    });
  } catch (error) {
    if (deadline.didTimeOut()) {
      throw new AiRequestError('AI 请求超时，请稍后重试', {
        code: 'AI_TIMEOUT',
        category: AI_REQUEST_CATEGORY.TIMEOUT,
      });
    }
    if (deadline.signal.aborted) {
      throw new AiRequestError('AI 请求已取消', {
        code: 'AI_CANCELLED',
        category: AI_REQUEST_CATEGORY.CANCELLED,
      });
    }
    throw new AiRequestError('无法连接 AI 服务，请检查网络', {
      code: 'AI_OFFLINE',
      category: AI_REQUEST_CATEGORY.OFFLINE,
    });
  }

  const responseText = await response.text();
  if (!response.ok) throw httpError(response.status, responseText, apiKey);
  return responseText;
}

export async function callChatCompletion({
  systemPrompt,
  userMessage,
  maxTokens = 1200,
  temperature = 0.4,
  signal,
  timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  includeResponseMetadata = false,
}) {
  const { apiKey, apiBase, model } = await loadAiConfig();
  if (!apiKey) {
    throw new AiRequestError('请先在设置页配置 API Key', {
      code: 'AI_API_KEY_REQUIRED',
      category: AI_REQUEST_CATEGORY.CONFIG,
    });
  }

  const android = isAndroidRuntime();
  const endpoint = normalizeApiEndpoint(apiBase, android);
  const deadline = createDeadline(signal, timeoutMs);
  try {
    const responseText = await performRequest({
      endpoint,
      apiKey,
      deadline,
      android,
      payload: {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature,
      },
    });

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new AiRequestError('AI 服务返回了无效 JSON', {
        code: 'AI_INVALID_JSON',
        category: AI_REQUEST_CATEGORY.INVALID_RESPONSE,
      });
    }
    const content = data?.choices?.[0]?.message?.content;
    const hasSupportedContent = typeof content === 'string'
      || Array.isArray(content)
      || (content && typeof content.text === 'string');
    if (!hasSupportedContent) {
      throw new AiRequestError('AI 服务响应缺少消息内容', {
        code: 'AI_INVALID_RESPONSE',
        category: AI_REQUEST_CATEGORY.INVALID_RESPONSE,
      });
    }
    const result = extractChatCompletionResult(data);
    return includeResponseMetadata ? result : result.text;
  } finally {
    deadline.cleanup();
  }
}
