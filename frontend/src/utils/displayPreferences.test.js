import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_PREFERENCES_EVENT, DISPLAY_PREFERENCES_STORAGE_KEY, readDisplayPreferences, writeDisplayPreferences } from './displayPreferences.js';

test('old, missing or invalid preferences use one upcoming item without losing other flags', () => {
  const original = globalThis.localStorage;
  try {
    for (const value of [undefined, -1, 3, '2', null]) {
      globalThis.localStorage = { getItem: () => JSON.stringify({ homeUpcomingScheduleCount: value, timeFormat: '12h', homeModules: { currentSchedule: false } }) };
      const prefs = readDisplayPreferences();
      assert.equal(prefs.homeUpcomingScheduleCount, 1);
      assert.equal(prefs.timeFormat, '12h');
      assert.equal(prefs.homeModules.currentSchedule, false);
    }
    globalThis.localStorage = { getItem: () => '{invalid' };
    assert.equal(readDisplayPreferences().homeUpcomingScheduleCount, 1);
  } finally { globalThis.localStorage = original; }
});

test('0/1/2 persist in the existing local preference key and broadcast immediately', () => {
  const originalStorage = globalThis.localStorage, originalWindow = globalThis.window;
  let stored;
  const events = [];
  try {
    globalThis.localStorage = { getItem: key => key === DISPLAY_PREFERENCES_STORAGE_KEY ? stored : null,
      setItem: (key, value) => { assert.equal(key, DISPLAY_PREFERENCES_STORAGE_KEY); stored = value; } };
    globalThis.window = { dispatchEvent: event => events.push(event) };
    for (const count of [0, 1, 2]) {
      const saved = writeDisplayPreferences({ ...readDisplayPreferences(), homeUpcomingScheduleCount: count });
      assert.equal(saved.homeUpcomingScheduleCount, count);
      assert.equal(saved.homeModules.currentSchedule, true);
      assert.equal(readDisplayPreferences().homeUpcomingScheduleCount, count);
      assert.equal(events.at(-1).type, DISPLAY_PREFERENCES_EVENT);
      assert.equal(events.at(-1).detail.homeUpcomingScheduleCount, count);
    }
  } finally { globalThis.localStorage = originalStorage; globalThis.window = originalWindow; }
});
