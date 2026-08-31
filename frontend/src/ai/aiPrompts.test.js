import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_DRAFT_SYSTEM_PROMPT,
  buildAiCreateDraftUserMessage,
  buildDailyDraftUserMessage,
  buildProjectNextDraftUserMessage,
  buildScheduleGapDraftUserMessage,
} from './aiPrompts.js';

test('draft system prompt contains the current JSON-only safety contract', () => {
  assert.doesNotMatch(AI_DRAFT_SYSTEM_PROMPT, /v0\.5\.x/i);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /exactly one JSON object/i);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /Do not output Markdown, prose, or code fences/i);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /Omit unknown optional values/i);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /YYYY-MM-DDTHH:mm:ss/);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /current version does not allow AI to create recurring/i);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /Never generate project drafts/i);
  assert.match(AI_DRAFT_SYSTEM_PROMPT, /Never write data to the database/i);
});

test('draft system prompt includes a parseable minimal example', () => {
  const prefix = '- Minimal valid example: ';
  const line = AI_DRAFT_SYSTEM_PROMPT.split('\n').find(value => value.startsWith(prefix));
  assert.ok(line);

  const example = JSON.parse(line.slice(prefix.length));
  assert.equal(example.type, 'drafts');
  assert.ok(Array.isArray(example.items));
  assert.equal(example.items.length, 1);
  assert.equal(example.items[0].draft_type, 'todo');
  assert.ok(example.items[0].name);
});

test('every draft user message repeats the one-object response contract', () => {
  const emptyContext = { projects: [], todos: [], schedules: [] };
  const messages = [
    buildAiCreateDraftUserMessage({
      text: 'Plan tomorrow',
      dateContext: { today: '2026-08-19', tomorrow: '2026-08-20' },
      ...emptyContext,
    }),
    buildDailyDraftUserMessage({
      selectedDate: '2026-08-19',
      logText: '',
      completedTodos: [],
      pendingTodos: [],
      todaySchedules: [],
      tomorrowSchedules: [],
      projects: [],
    }),
    buildProjectNextDraftUserMessage({
      project: { id: 1, name: 'Launch', description: '', status: 'active', ddl_date: null },
      todos: [],
      schedules: [],
    }),
    buildScheduleGapDraftUserMessage({
      date: '2026-08-20',
      ...emptyContext,
    }),
  ];

  for (const message of messages) {
    assert.match(message, /Return exactly one JSON object/i);
    assert.match(message, /Output no Markdown, prose, or code fence/i);
  }
});
