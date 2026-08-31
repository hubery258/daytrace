import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); },
};

const originalFetch = globalThis.fetch;
const ai = await import('../src/ai/aiClient.js');
const native = await import('../src/platform/nativeHttp.js');

afterEach(() => {
  values.clear();
  globalThis.fetch = originalFetch;
});

test('web AI settings preserve the existing local-only behavior', async () => {
  await ai.saveAiConfig({
    apiKey: 'test-key-never-log',
    apiBase: 'https://ai.example.test/',
    model: 'test-model',
    prompt: 'test prompt',
  });

  assert.deepEqual(ai.getAiConfig(), {
    apiKey: 'test-key-never-log',
    apiBase: 'https://ai.example.test',
    model: 'test-model',
  });
  assert.equal(values.get(ai.AI_STORAGE_KEYS.prompt), 'test prompt');
});

test('chat completion sends an OpenAI-compatible request and parses content', async () => {
  await ai.saveAiConfig({ apiKey: 'test-key-never-log', apiBase: 'https://ai.example.test', model: 'test-model' });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }] }); },
    };
  };

  const content = await ai.callChatCompletion({ systemPrompt: 'system', userMessage: 'user' });
  assert.equal(content, 'ok');
  assert.equal(request.url, 'https://ai.example.test/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key-never-log');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
});

test('chat completion distinguishes cancellation and invalid responses', async () => {

  await ai.saveAiConfig({ apiKey: 'test-key-never-log', apiBase: 'https://ai.example.test', model: 'test-model' });
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_url, options) => {
    if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
    throw new Error('unexpected request');
  };

  await assert.rejects(
    ai.callChatCompletion({ systemPrompt: 'system', userMessage: 'user', signal: controller.signal }),
    error => error.code === 'AI_CANCELLED' && error.category === ai.AI_REQUEST_CATEGORY.CANCELLED,
  );

  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return '{}'; } });
  await assert.rejects(
    ai.callChatCompletion({ systemPrompt: 'system', userMessage: 'user' }),
    error => error.code === 'AI_INVALID_RESPONSE' && error.category === ai.AI_REQUEST_CATEGORY.INVALID_RESPONSE,
  );
});

test('chat completion returns diagnostics metadata through the unified transport', async () => {
  await ai.saveAiConfig({ apiKey: 'test-key-never-log', apiBase: 'https://ai.example.test', model: 'test-model' });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        model: 'provider-model',
        choices: [{
          finish_reason: 'stop',
          message: {
            content: [{ type: 'text', text: '{"type":"drafts",' }, { type: 'text', text: '"items":[]}' }],
          },
        }],
        usage: { completion_tokens: 42 },
      });
    },
  });

  const result = await ai.callChatCompletion({
    systemPrompt: 'system',
    userMessage: 'user',
    includeResponseMetadata: true,
  });

  assert.equal(result.text, '{"type":"drafts","items":[]}');
  assert.equal(result.responseMeta.model, 'provider-model');
  assert.equal(result.responseMeta.contentFormat, 'parts');
  assert.equal(result.responseMeta.completionTokens, 42);
});

test('native transport exposes stable network error categories', () => {
  assert.equal(
    native.classifyNativeRequestError({ code: 'TIMEOUT', message: 'request timed out' }).category,
    native.NATIVE_REQUEST_CATEGORY.TIMEOUT,
  );
  assert.equal(
    native.classifyNativeRequestError({ code: 'TLS_ERROR', message: 'secure connection failed' }).category,
    native.NATIVE_REQUEST_CATEGORY.TLS,
  );
  assert.equal(
    native.classifyNativeRequestError({ code: 'REQUEST_CANCELLED', message: 'cancelled' }).category,
    native.NATIVE_REQUEST_CATEGORY.CANCELLED,
  );
});
