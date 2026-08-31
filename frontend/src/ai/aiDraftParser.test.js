import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAiDraftResponse } from './aiDraftParser.js';

test('parses direct JSON and returns complete diagnostics', () => {
  const rawText = '  {"type":"drafts","items":[{"draft_type":"todo","name":"Plan tomorrow"}]}\n';
  const result = parseAiDraftResponse(rawText);

  assert.equal(result.rawText, rawText);
  assert.equal(result.extractedText, rawText.trim());
  assert.equal(result.parseError, null);
  assert.equal(result.parsedType, 'drafts');
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('extracts and parses JSON from a Markdown code fence', () => {
  const extractedText = '{"type":"drafts","items":[{"draft_type":"todo","name":"Read notes"}]}';
  const rawText = `Here is the draft:\n\n\`\`\`json\n${extractedText}\n\`\`\``;
  const result = parseAiDraftResponse(rawText);

  assert.equal(result.rawText, rawText);
  assert.equal(result.extractedText, extractedText);
  assert.equal(result.parseError, null);
  assert.equal(result.parsedType, 'drafts');
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(result.errors, []);
});

test('keeps the raw response and parse exception for non-JSON text', () => {
  const rawText = 'I cannot produce that draft right now.';
  const result = parseAiDraftResponse(rawText);

  assert.equal(result.rawText, rawText);
  assert.equal(result.extractedText, rawText);
  assert.equal(typeof result.parseError, 'string');
  assert.ok(result.parseError.length > 0);
  assert.equal(result.parsedType, null);
  assert.deepEqual(result.drafts, []);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.warnings, []);
});

test('reports an empty model response without a fake JSON parse exception', () => {
  const result = parseAiDraftResponse('   ');

  assert.equal(result.rawText, '   ');
  assert.equal(result.extractedText, '');
  assert.equal(result.parseError, null);
  assert.equal(result.parsedType, null);
  assert.deepEqual(result.drafts, []);
  assert.ok(result.errors.some(error => error.includes('空内容')));
});

test('reports valid JSON that contains no drafts', () => {
  const rawText = '{"type":"drafts","items":[]}';
  const result = parseAiDraftResponse(rawText);

  assert.equal(result.rawText, rawText);
  assert.equal(result.parseError, null);
  assert.equal(result.parsedType, 'drafts');
  assert.deepEqual(result.drafts, []);
  assert.ok(result.errors.some(error => error.includes('items 数组为空')));
});

test('keeps diagnostics when parsed JSON has invalid draft fields', () => {
  const rawText = JSON.stringify({
    type: 'drafts',
    items: [{
      draft_type: 'todo',
      name: 'Submit report',
      ddl_type: 'hard',
      ddl_date: 'not-a-date',
    }],
  });
  const result = parseAiDraftResponse(rawText);

  assert.equal(result.rawText, rawText);
  assert.equal(result.extractedText, rawText);
  assert.equal(result.parseError, null);
  assert.equal(result.parsedType, 'drafts');
  assert.deepEqual(result.drafts, []);
  assert.ok(result.errors.some(error => error.includes('DDL')));
});

test('reports when every parsed draft is skipped by validation rules', () => {
  const rawText = JSON.stringify({
    type: 'drafts',
    items: [{
      draft_type: 'schedule',
      name: 'Conflicting meeting',
      start_time: '2026-09-01T09:00:00',
      end_time: '2026-09-01T10:00:00',
    }],
  });
  const result = parseAiDraftResponse(rawText, {
    schedules: [{
      name: 'Existing meeting',
      start_time: '2026-09-01T09:30:00',
      end_time: '2026-09-01T10:30:00',
    }],
  });

  assert.deepEqual(result.drafts, []);
  assert.ok(result.warnings.some(warning => warning.includes('冲突')));
  assert.ok(result.errors.some(error => error.includes('全部被校验规则跳过')));
  assert.equal(result.rawText, rawText);
});

test('reports the parsed type for wrong-shape JSON', () => {
  const typed = parseAiDraftResponse('{"type":"clarification","items":[]}');
  assert.equal(typed.parsedType, 'clarification');
  assert.equal(typed.parseError, null);
  assert.ok(typed.errors.length > 0);

  const cases = [
    ['[]', 'array'],
    ['null', 'null'],
    ['{}', 'object'],
    ['"drafts"', 'string'],
    ['42', 'number'],
    ['true', 'boolean'],
  ];

  for (const [rawText, expectedType] of cases) {
    const result = parseAiDraftResponse(rawText);
    assert.equal(result.parsedType, expectedType);
    assert.equal(result.parseError, null);
    assert.equal(result.rawText, rawText);
    assert.equal(result.extractedText, rawText);
    assert.ok(result.errors.length > 0);
  }
});
