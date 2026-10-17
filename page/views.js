// Pure module: which view and layout are open, the keyboard-shortcut decision (also reused by
// the clickable top-bar buttons), stored preferences and the motion switch. No DOM access at
// import time, so this module can be imported directly by node:test and by page/main.js without
// a build step.

import { CHANGE_TIMINGS } from './change-timing.js';
import { parseStoredSplit } from './split-model.js';

/** View numbers are fixed forever: 1 History, 2 Timeline, 3 Mixer, 4 Parts, 5 Jam, 6 Instruments. */
export const VIEW_KEYS = { '1': 'history', '2': 'timeline', '3': 'mixer', '4': 'parts', '5': 'jam', '6': 'instruments' };

/** Views built so far. A key whose view is not in this list does nothing. */
export const BUILT_VIEWS = ['history', 'timeline', 'mixer', 'parts', 'jam', 'instruments'];

/** Display name for a built view, used by viewButtonParts(). */
export const VIEW_TITLES = { history: 'History', timeline: 'Timeline', mixer: 'Mixer', parts: 'Parts', jam: 'Jam', instruments: 'Instruments' };

/** a = bottom strip, b = side panel, c = full screen over faint code. */
export const LAYOUTS = ['a', 'b', 'c'];
/** Plain-word names of the layouts, used as the accessible name and tooltip of the top-bar layout buttons. */
export const LAYOUT_TITLES = { a: 'bottom strip', b: 'side panel', c: 'full screen over faint code' };
export const DEFAULT_LAYOUT = 'a';

/** The two ways the History view can be shown: a plain list or a branching tree. */
export const HISTORY_MODES = ['list', 'tree'];

/** The two instruments the Jam view can draw: the two-octave piano or the guitar fretboard. */
export const JAM_INSTRUMENTS = ['piano', 'guitar'];

/** The two values of the Jam "Chord tones" overlay: marks the notes of the chord sounding now, or not. */
export const JAM_CHORD_TONES = ['on', 'off'];

/** When a section launched from the Song grid starts: at the end of the section that plays, on the next phrase or on the next bar. */
export const SONG_LAUNCHES = ['section', 'phrase', 'bar'];
export const DEFAULT_SONG_LAUNCH = 'section';

/** Browser-storage keys for the remembered layout, view, motion switch, History display, the two Jam preferences, the change timing of hand evaluations, the Song grid's launch choice and the size of the view in layout a and in layout b. */
export const STORAGE_KEYS = {
  layout: 'moontide.layout',
  view: 'moontide.view',
  motion: 'moontide.motion',
  historyMode: 'moontide.historyMode',
  jamInstrument: 'moontide.jamInstrument',
  jamChordTones: 'moontide.jamChordTones',
  changeTiming: 'moontide.changeTiming',
  songLaunch: 'moontide.songLaunch',
  splitA: 'moontide.split.a',
  splitB: 'moontide.split.b',
};

const SONG_LAUNCH_LIST = `${SONG_LAUNCHES.slice(0, -1).join(', ')} or ${SONG_LAUNCHES[SONG_LAUNCHES.length - 1]}`;

/**
 * The console line for a stored song launch choice that is not in the list. It is built from the storage key and
 * the allowed values only, never from the stored text, so nothing a stranger wrote into storage is echoed.
 */
export const VIEW_PREFS_COPY = Object.freeze({
  badSongLaunch: `Moontide: the stored song launch choice under '${STORAGE_KEYS.songLaunch}' is not ${SONG_LAUNCH_LIST}; sections start at the end of the section that plays.`,
});

/** Plain-word motion switch labels. */
export const MOTION_LABELS = { on: 'Motion: on', off: 'Motion: off' };

/**
 * The keyboard-shortcut decision for one keydown. `state` is `{ layout, view, motion,
 * motionChosen }`, where `view` is `'none'` or a view name. Returns `{ state, handled,
 * blurEditor }`:
 * - a held ctrl/meta/alt makes every key unhandled (never intercepts a real shortcut/modifier);
 * - with a number field, a text field, a select or a text area holding focus (`focusInTextEntry`),
 *   every key is unhandled and the state is returned unchanged, so typing `a` or `3` in a field never
 *   switches layout or view;
 * - with the cursor in the code editor, only Escape counts, and it blurs the editor without
 *   opening or closing a view;
 * - otherwise a lowercase 'a', 'b' or 'c' sets the remembered layout, with or without a view
 *   open; a digit whose view is built toggles that view (opening one view replaces another —
 *   at most one view is ever open); Escape closes the open view; anything else (including a
 *   digit for a view that is not built yet) is unhandled.
 */
export function applyKey(state, { key, focusInEditor, focusInTextEntry, ctrlKey, metaKey, altKey }) {
  if (ctrlKey || metaKey || altKey) {
    return { state, handled: false, blurEditor: false };
  }
  if (focusInTextEntry) {
    return { state, handled: false, blurEditor: false };
  }
  if (focusInEditor) {
    if (key === 'Escape') {
      return { state, handled: true, blurEditor: true };
    }
    return { state, handled: false, blurEditor: false };
  }
  if (key === 'Escape') {
    if (state.view === 'none') {
      return { state, handled: false, blurEditor: false };
    }
    return { state: { ...state, view: 'none' }, handled: true, blurEditor: false };
  }
  if (LAYOUTS.includes(key)) {
    return { state: { ...state, layout: key }, handled: true, blurEditor: false };
  }
  const viewName = VIEW_KEYS[key];
  if (viewName && BUILT_VIEWS.includes(viewName)) {
    const nextView = state.view === viewName ? 'none' : viewName;
    return { state: { ...state, view: nextView }, handled: true, blurEditor: false };
  }
  return { state, handled: false, blurEditor: false };
}

/**
 * Reads the ten stored preferences from `storage` (a Storage-like object, or null). Each
 * value is validated against its closed set — layout in LAYOUTS; view 'none' or in
 * BUILT_VIEWS; motion 'on' or 'off'; historyMode in HISTORY_MODES; jamInstrument in
 * JAM_INSTRUMENTS; jamChordTones in JAM_CHORD_TONES; changeTiming in CHANGE_TIMINGS; songLaunch in SONG_LAUNCHES; splitA and splitB a plain number from 15 to 85 (page/split-model.js) — and
 * becomes undefined when missing or invalid, so a stray/legacy value is never interpolated into selectors, HTML or code.
 * `rejected` lists the storage keys of the sizes that were stored but refused (a missing key is not
 * listed), so the page can say so once, loudly. `songLaunchRejected` is true when a launch choice was stored but is
 * not in SONG_LAUNCHES (a missing key is not), so the page can say that once too; it is false when storage is unavailable. Returns `available: false`, with every value undefined, when storage is
 * null or any read throws (private window, blocked storage).
 */
export function readViewPrefs(storage) {
  const UNAVAILABLE_PREFS = { layout: undefined, view: undefined, motion: undefined, historyMode: undefined, jamInstrument: undefined, jamChordTones: undefined, changeTiming: undefined, songLaunch: undefined, splitA: undefined, splitB: undefined, rejected: [], songLaunchRejected: false, available: false };
  if (!storage) {
    return { ...UNAVAILABLE_PREFS };
  }
  try {
    const rawLayout = storage.getItem(STORAGE_KEYS.layout);
    const rawView = storage.getItem(STORAGE_KEYS.view);
    const rawMotion = storage.getItem(STORAGE_KEYS.motion);
    const rawHistoryMode = storage.getItem(STORAGE_KEYS.historyMode);
    const rawJamInstrument = storage.getItem(STORAGE_KEYS.jamInstrument);
    const rawJamChordTones = storage.getItem(STORAGE_KEYS.jamChordTones);
    const rawChangeTiming = storage.getItem(STORAGE_KEYS.changeTiming);
    const rawSongLaunch = storage.getItem(STORAGE_KEYS.songLaunch);
    const rawSplitA = storage.getItem(STORAGE_KEYS.splitA);
    const rawSplitB = storage.getItem(STORAGE_KEYS.splitB);
    const splitA = parseStoredSplit(rawSplitA);
    const splitB = parseStoredSplit(rawSplitB);
    const rejected = [];
    if (rawSplitA !== null && rawSplitA !== undefined && splitA === undefined) rejected.push(STORAGE_KEYS.splitA);
    if (rawSplitB !== null && rawSplitB !== undefined && splitB === undefined) rejected.push(STORAGE_KEYS.splitB);
    const songLaunchRejected = rawSongLaunch !== null && rawSongLaunch !== undefined && !SONG_LAUNCHES.includes(rawSongLaunch);
    return {
      layout: LAYOUTS.includes(rawLayout) ? rawLayout : undefined,
      view: rawView === 'none' || BUILT_VIEWS.includes(rawView) ? rawView : undefined,
      motion: rawMotion === 'on' || rawMotion === 'off' ? rawMotion : undefined,
      historyMode: HISTORY_MODES.includes(rawHistoryMode) ? rawHistoryMode : undefined,
      jamInstrument: JAM_INSTRUMENTS.includes(rawJamInstrument) ? rawJamInstrument : undefined,
      jamChordTones: JAM_CHORD_TONES.includes(rawJamChordTones) ? rawJamChordTones : undefined,
      changeTiming: CHANGE_TIMINGS.includes(rawChangeTiming) ? rawChangeTiming : undefined,
      songLaunch: SONG_LAUNCHES.includes(rawSongLaunch) ? rawSongLaunch : undefined,
      splitA,
      splitB,
      rejected,
      songLaunchRejected,
      available: true,
    };
  } catch {
    return { ...UNAVAILABLE_PREFS };
  }
}

/**
 * Writes one preference to `storage`. Never throws: returns true when written,
 * false when storage is null or the write throws (private window, blocked storage).
 */
export function writeViewPref(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The page's state at first render, before any keypress: the stored layout/view/motion/historyMode and
 * Jam preferences, else the defaults (layout 'a', view 'none', motion following the OS reduce-motion
 * setting, history 'list', Jam instrument 'piano', Jam chord tones 'off', change timing 'now', Song launch 'section').
 * motionChosen is true only when a motion value was actually stored — while false, the motion
 * value keeps following the OS live (see motionAfterOsChange).
 */
export function initialViewState({ prefs, prefersReducedMotion }) {
  return {
    layout: prefs.layout ?? DEFAULT_LAYOUT,
    view: prefs.view ?? 'none',
    motion: prefs.motion ?? (prefersReducedMotion ? 'off' : 'on'),
    motionChosen: prefs.motion !== undefined,
    historyMode: prefs.historyMode ?? 'list',
    jamInstrument: prefs.jamInstrument ?? 'piano',
    jamChordTones: prefs.jamChordTones ?? 'off',
    changeTiming: prefs.changeTiming ?? 'now',
    songLaunch: prefs.songLaunch ?? DEFAULT_SONG_LAUNCH,
  };
}

/** Sets how the History view is shown. Throws on a value outside HISTORY_MODES (a loud error). */
export function setHistoryMode(state, mode) {
  if (!HISTORY_MODES.includes(mode)) {
    throw new Error(`Moontide: unknown History display '${String(mode)}' (expected one of ${HISTORY_MODES.join(', ')})`);
  }
  return { ...state, historyMode: mode };
}

/** Sets which instrument the Jam view shows. Throws on a value outside JAM_INSTRUMENTS (a loud error). */
export function setJamInstrument(state, name) {
  if (!JAM_INSTRUMENTS.includes(name)) {
    throw new Error(`Moontide: unknown Jam instrument '${String(name)}' (expected one of ${JAM_INSTRUMENTS.join(', ')})`);
  }
  return { ...state, jamInstrument: name };
}

/** Sets the Jam "Chord tones" overlay. Throws on a value outside JAM_CHORD_TONES (a loud error). */
export function setJamChordTones(state, value) {
  if (!JAM_CHORD_TONES.includes(value)) {
    throw new Error(`Moontide: unknown Chord tones value '${String(value)}' (expected one of ${JAM_CHORD_TONES.join(', ')})`);
  }
  return { ...state, jamChordTones: value };
}

/** Sets how a hand evaluation takes over: 'now', 'bar' or 'phrase'. Throws on a value outside CHANGE_TIMINGS (a loud error). */
export function setChangeTiming(state, value) {
  if (!CHANGE_TIMINGS.includes(value)) {
    throw new Error(`Moontide: unknown change timing '${String(value)}' (expected one of ${CHANGE_TIMINGS.join(', ')})`);
  }
  return { ...state, changeTiming: value };
}

/** Sets when a section launched from the Song grid starts: 'section', 'phrase' or 'bar'. Throws on a value outside SONG_LAUNCHES (a loud error). */
export function setSongLaunch(state, value) {
  if (!SONG_LAUNCHES.includes(value)) {
    throw new Error(`Moontide: unknown song launch '${String(value)}' (expected one of ${SONG_LAUNCHES.join(', ')})`);
  }
  return { ...state, songLaunch: value };
}

/**
 * The view buttons of the top bar as an ordered list, listing only the given built views in key order (1..6)
 * whatever order `builtViews` lists them in. Each part is { key, digit, name, label, title }: `key` is the digit the
 * button sends to applyKey, `name` the view title, `label` the accessible name `{digit} {Name}` (it contains the
 * visible text at every fit step) and `title` the tooltip `{Name} (key {digit})`. A view without a fixed key
 * (VIEW_KEYS) is ignored. `titles` replaces VIEW_TITLES, so a view can be called by another name (the Parts view is called
 * Song while the code declares a song); the key and the view itself never change.
 */
export function viewButtonParts(builtViews = BUILT_VIEWS, titles = VIEW_TITLES) {
  return Object.entries(VIEW_KEYS)
    .filter(([, view]) => builtViews.includes(view))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([digit, view]) => {
      const name = titles[view];
      return { key: digit, digit, name, label: `${digit} ${name}`, title: `${name} (key ${digit})` };
    });
}

/**
 * The layout buttons of the top bar: a, b and c in order. Each part is { key, text, label }: the visible text is the
 * letter and the accessible name is the plain-word `Layout {letter}: {title}`.
 */
export function layoutButtonParts() {
  return LAYOUTS.map((letter) => ({ key: letter, text: letter, label: `Layout ${letter}: ${LAYOUT_TITLES[letter]}` }));
}

/**
 * How a top-bar button looks for the given state: `pressed` is true for the current layout letter and the open view's
 * digit and false for the others. The closed set of keys is LAYOUTS and the digits of built views; any other key
 * (Escape included: it has no button) throws, because a button for it should not exist.
 */
export function hintButtonState(state, key) {
  if (LAYOUTS.includes(key)) {
    return { pressed: state.layout === key };
  }
  const viewName = VIEW_KEYS[key];
  if (viewName && BUILT_VIEWS.includes(viewName)) {
    return { pressed: state.view === viewName };
  }
  throw new Error(`Moontide: no top-bar button for key '${String(key)}'`);
}

/** Flips motion on<->off and marks it as explicitly chosen — from then on the OS setting is
 * never followed again (see motionAfterOsChange). */
export function toggleMotion(state) {
  return { ...state, motion: state.motion === 'on' ? 'off' : 'on', motionChosen: true };
}

/**
 * Applies a live OS reduce-motion change. While the user has never pressed the motion switch
 * (motionChosen false), motion keeps following the OS live, including mid-session. Once the
 * user has pressed it, the stored pick wins forever after — this returns `state` unchanged
 * (same reference, so callers can skip a re-render/write when nothing changed).
 */
export function motionAfterOsChange(state, prefersReducedMotion) {
  if (state.motionChosen) return state;
  return { ...state, motion: prefersReducedMotion ? 'off' : 'on' };
}

