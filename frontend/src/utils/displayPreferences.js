export const DISPLAY_PREFERENCES_STORAGE_KEY = 'riji_display_preferences_v1';
export const DISPLAY_PREFERENCES_EVENT = 'riji:display-preferences-changed';

export const DEFAULT_DISPLAY_PREFERENCES = Object.freeze({
  timeFormat: '24h',
  actualDisplayMode: 'blocks',
  timeBlockGranularity: 15,
  pages: Object.freeze({
    home: true,
    schedule: true,
    timer: true,
    projects: true,
    todos: true,
    summary: true,
    zju: true,
  }),
  homeModules: Object.freeze({
    currentSchedule: true,
    waitingReplies: true,
    focusingTodos: true,
    projects: true,
    nearDeadlines: true,
  }),
});

function mergeKnownFlags(defaults, candidate) {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      typeof candidate?.[key] === 'boolean' ? candidate[key] : fallback,
    ]),
  );
}

export function readDisplayPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY) || '{}');
    return {
      timeFormat: stored.timeFormat === '12h' ? '12h' : '24h',
      actualDisplayMode: stored.actualDisplayMode === 'timeline' ? 'timeline' : 'blocks',
      timeBlockGranularity: stored.timeBlockGranularity === 30 ? 30 : 15,
      pages: mergeKnownFlags(DEFAULT_DISPLAY_PREFERENCES.pages, stored.pages),
      homeModules: mergeKnownFlags(DEFAULT_DISPLAY_PREFERENCES.homeModules, stored.homeModules),
    };
  } catch {
    return {
      timeFormat: DEFAULT_DISPLAY_PREFERENCES.timeFormat,
      actualDisplayMode: DEFAULT_DISPLAY_PREFERENCES.actualDisplayMode,
      timeBlockGranularity: DEFAULT_DISPLAY_PREFERENCES.timeBlockGranularity,
      pages: { ...DEFAULT_DISPLAY_PREFERENCES.pages },
      homeModules: { ...DEFAULT_DISPLAY_PREFERENCES.homeModules },
    };
  }
}

export function writeDisplayPreferences(preferences) {
  const normalized = {
    timeFormat: preferences.timeFormat === '12h' ? '12h' : '24h',
    actualDisplayMode: preferences.actualDisplayMode === 'timeline' ? 'timeline' : 'blocks',
    timeBlockGranularity: preferences.timeBlockGranularity === 30 ? 30 : 15,
    pages: mergeKnownFlags(DEFAULT_DISPLAY_PREFERENCES.pages, preferences.pages),
    homeModules: mergeKnownFlags(DEFAULT_DISPLAY_PREFERENCES.homeModules, preferences.homeModules),
  };
  localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(DISPLAY_PREFERENCES_EVENT, { detail: normalized }));
  return normalized;
}
