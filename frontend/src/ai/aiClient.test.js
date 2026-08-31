import test from 'node:test';
import assert from 'node:assert/strict';

import { extractChatCompletionResult } from './aiClient.js';

test('extracts ordinary chat completion text and safe response metadata', () => {
  const result = extractChatCompletionResult({
    model: 'chat-model',
    choices: [{ finish_reason: 'stop', message: { content: '{"type":"drafts","items":[]}' } }],
    usage: { completion_tokens: 42 },
  });

  assert.equal(result.text, '{"type":"drafts","items":[]}');
  assert.deepEqual(result.responseMeta, {
    finishReason: 'stop',
    model: 'chat-model',
    contentFormat: 'text',
    hasReasoningContent: false,
    completionTokens: 42,
  });
});

test('joins text content parts returned by compatible APIs', () => {
  const result = extractChatCompletionResult({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: [
          { type: 'text', text: '{"type":"drafts",' },
          { type: 'text', text: '"items":[]}' },
        ],
      },
    }],
  });

  assert.equal(result.text, '{"type":"drafts","items":[]}');
  assert.equal(result.responseMeta.contentFormat, 'parts');
});

test('keeps safe metadata when a reasoning response has no final content', () => {
  const result = extractChatCompletionResult({
    model: 'reasoning-model',
    choices: [{
      finish_reason: 'length',
      message: { content: '', reasoning_content: 'internal reasoning is intentionally not exposed' },
    }],
    usage: { completion_tokens: 1800 },
  });

  assert.equal(result.text, '');
  assert.equal(result.responseMeta.finishReason, 'length');
  assert.equal(result.responseMeta.contentFormat, 'empty');
  assert.equal(result.responseMeta.hasReasoningContent, true);
  assert.equal(result.responseMeta.completionTokens, 1800);
  assert.equal(Object.hasOwn(result.responseMeta, 'reasoningContent'), false);
});
