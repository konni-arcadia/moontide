import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_KEYS,
  BUILT_VIEWS,
  LAYOUTS,
  DEFAULT_LAYOUT,
  STORAGE_KEYS,
  applyKey,
  readViewPrefs,
  writeViewPref,
  initialViewState,
} from '../page/views.js';
// Namespace import: a named import of a
// missing export is a module-load SyntaxError that crashes the whole file;
// a namespace property access instead fails inside each
// test as a normal TypeError, a targeted failure for the behavior under test.
import * as views from '../page/views.js';

const NONE = { view: 'none' };
const NO_MODIFIERS = { ctrlKey: false, metaKey: false, altKey: false };

test('VIEW_KEYS fixes all six view numbers; BUILT_VIEWS ships history, timeline, mixer, parts, jam and instruments', () => {
  assert.deepEqual(VIEW_KEYS, { '1': 'history', '2': 'timeline', '3': 'mixer', '4': 'parts', '5': 'jam', '6': 'instruments' });
  assert.deepEqual(BUILT_VIEWS, ['history', 'timeline', 'mixer', 'parts', 'jam', 'instruments']);
});

test("'1' toggles the history view open, then closed again", () => {
  const opened = applyKey(NONE, { key: '1', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(opened, { state: { view: 'history' }, handled: true, blurEditor: false });

  const closed = applyKey(opened.state, { key: '1', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(closed, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test("'2' toggles the timeline view open, then closed again", () => {
  const opened = applyKey(NONE, { key: '2', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(opened, { state: { view: 'timeline' }, handled: true, blurEditor: false });

  const closed = applyKey(opened.state, { key: '2', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(closed, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test("'3' toggles the mixer view open, then closed again", () => {
  const opened = applyKey(NONE, { key: '3', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(opened, { state: { view: 'mixer' }, handled: true, blurEditor: false });

  const closed = applyKey(opened.state, { key: '3', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(closed, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test("'5' toggles the jam view open, then closed again", () => {
  const opened = applyKey(NONE, { key: '5', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(opened, { state: { view: 'jam' }, handled: true, blurEditor: false });

  const closed = applyKey(opened.state, { key: '5', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(closed, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test("'6' toggles the instruments view open, then closed again", () => {
  const opened = applyKey(NONE, { key: '6', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(opened, { state: { view: 'instruments' }, handled: true, blurEditor: false });

  const closed = applyKey(opened.state, { key: '6', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(closed, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test("'6' does nothing while the cursor is in the code editor or a text field", () => {
  const inEditor = applyKey(NONE, { key: '6', focusInEditor: true, ...NO_MODIFIERS });
  assert.deepEqual(inEditor, { state: NONE, handled: false, blurEditor: false });
  const inField = applyKey(NONE, { key: '6', focusInEditor: false, focusInTextEntry: true, ...NO_MODIFIERS });
  assert.deepEqual(inField, { state: NONE, handled: false, blurEditor: false });
});

test("'4' toggles the parts view open, then closed again", () => {
  const opened = applyKey(NONE, { key: '4', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(opened, { state: { view: 'parts' }, handled: true, blurEditor: false });

  const closed = applyKey(opened.state, { key: '4', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(closed, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test('Escape closes the open view', () => {
  const open = { view: 'timeline' };
  const result = applyKey(open, { key: 'Escape', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(result, { state: { view: 'none' }, handled: true, blurEditor: false });
});

test('Escape with no view open is unhandled', () => {
  const result = applyKey(NONE, { key: 'Escape', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(result, { state: NONE, handled: false, blurEditor: false });
});

test("focusInEditor with '2' is unhandled — typing in the code never opens a view", () => {
  const result = applyKey(NONE, { key: '2', focusInEditor: true, ...NO_MODIFIERS });
  assert.deepEqual(result, { state: NONE, handled: false, blurEditor: false });
});

test('focusInEditor with Escape blurs the editor and keeps the view state unchanged', () => {
  const open = { view: 'timeline' };
  const result = applyKey(open, { key: 'Escape', focusInEditor: true, ...NO_MODIFIERS });
  assert.deepEqual(result, { state: open, handled: true, blurEditor: true });
});

test('a held ctrl/meta/alt makes every key unhandled, even outside the editor', () => {
  for (const modifiers of [{ ctrlKey: true, metaKey: false, altKey: false }, { ctrlKey: false, metaKey: true, altKey: false }, { ctrlKey: false, metaKey: false, altKey: true }]) {
    for (const key of ['2', 'Escape']) {
      const result = applyKey(NONE, { key, focusInEditor: false, ...modifiers });
      assert.deepEqual(result, { state: NONE, handled: false, blurEditor: false }, `key ${key} with ${JSON.stringify(modifiers)}`);
    }
  }
});

test('LAYOUTS and DEFAULT_LAYOUT are the three fixed layouts, defaulting to the strip', () => {
  assert.deepEqual(LAYOUTS, ['a', 'b', 'c']);
  assert.equal(DEFAULT_LAYOUT, 'a');
});

test('a, b and c set the layout, with no view open', () => {
  const start = { layout: 'a', view: 'none' };
  for (const key of ['a', 'b', 'c']) {
    const result = applyKey(start, { key, focusInEditor: false, ...NO_MODIFIERS });
    assert.deepEqual(result, { state: { layout: key, view: 'none' }, handled: true, blurEditor: false }, `key ${key}`);
  }
});

test('a, b and c set the layout while a view is open, leaving the view open', () => {
  const start = { layout: 'a', view: 'timeline' };
  const result = applyKey(start, { key: 'b', focusInEditor: false, ...NO_MODIFIERS });
  assert.deepEqual(result, { state: { layout: 'b', view: 'timeline' }, handled: true, blurEditor: false });
});

test('a, b and c with focus in the editor are unhandled', () => {
  const start = { layout: 'a', view: 'none' };
  for (const key of ['a', 'b', 'c']) {
    const result = applyKey(start, { key, focusInEditor: true, ...NO_MODIFIERS });
    assert.deepEqual(result, { state: start, handled: false, blurEditor: false }, `key ${key}`);
  }
});

test('readViewPrefs returns valid stored values and undefined for invalid ones', () => {
  const values = new Map([
    [STORAGE_KEYS.layout, 'b'],
    [STORAGE_KEYS.view, 'timeline'],
    [STORAGE_KEYS.motion, 'off'],
    [STORAGE_KEYS.historyMode, 'tree'],
    [STORAGE_KEYS.jamInstrument, 'guitar'],
    [STORAGE_KEYS.jamChordTones, 'on'],
    [STORAGE_KEYS.changeTiming, 'bar'],
    [STORAGE_KEYS.songLaunch, 'phrase'],
    [STORAGE_KEYS.splitA, '44'],
    [STORAGE_KEYS.splitB, '37.5'],
  ]);
  const fakeStorage = { getItem: (key) => (values.has(key) ? values.get(key) : null) };
  assert.deepEqual(readViewPrefs(fakeStorage), {
    layout: 'b',
    view: 'timeline',
    motion: 'off',
    historyMode: 'tree',
    jamInstrument: 'guitar',
    jamChordTones: 'on',
    changeTiming: 'bar',
    songLaunch: 'phrase',
    splitA: 44,
    splitB: 37.5,
    rejected: [],
    songLaunchRejected: false,
    available: true,
  });
});

test('readViewPrefs rejects values outside the closed sets', () => {
  const values = new Map([
    [STORAGE_KEYS.layout, 'd'],
    [STORAGE_KEYS.view, 'sketch'],
    [STORAGE_KEYS.motion, 'maybe'],
    [STORAGE_KEYS.historyMode, 'graph'],
    [STORAGE_KEYS.jamInstrument, 'banjo'],
    [STORAGE_KEYS.jamChordTones, 'maybe'],
    [STORAGE_KEYS.changeTiming, 'later'],
    [STORAGE_KEYS.songLaunch, 'sometime'],
    [STORAGE_KEYS.splitA, '90'],
    [STORAGE_KEYS.splitB, 'calc(1px)'],
  ]);
  const fakeStorage = { getItem: (key) => (values.has(key) ? values.get(key) : null) };
  assert.deepEqual(readViewPrefs(fakeStorage), {
    layout: undefined,
    view: undefined,
    motion: undefined,
    historyMode: undefined,
    jamInstrument: undefined,
    jamChordTones: undefined,
    changeTiming: undefined,
    songLaunch: undefined,
    splitA: undefined,
    splitB: undefined,
    rejected: [STORAGE_KEYS.splitA, STORAGE_KEYS.splitB],
    songLaunchRejected: true,
    available: true,
  });
});

test('readViewPrefs reads the two split sizes: a number from 15 to 85 is kept, anything else is rejected by name', () => {
  assert.equal(STORAGE_KEYS.splitA, 'moontide.split.a');
  assert.equal(STORAGE_KEYS.splitB, 'moontide.split.b');
  const stored = (a, b) => ({ getItem: (key) => (key === STORAGE_KEYS.splitA ? a : key === STORAGE_KEYS.splitB ? b : null) });
  const good = readViewPrefs(stored('42.5', '15'));
  assert.equal(good.splitA, 42.5);
  assert.equal(good.splitB, 15);
  assert.deepEqual(good.rejected, []);
  const bad = readViewPrefs(stored('90', null));
  assert.equal(bad.splitA, undefined);
  assert.equal(bad.splitB, undefined);
  assert.deepEqual(bad.rejected, ['moontide.split.a'], 'a rejected key is listed, a missing key is not');
  for (const text of ['abc', '', '14.9', '85.1', '-1', '1e9', 'calc(1px)']) {
    const result = readViewPrefs(stored(null, text));
    assert.equal(result.splitB, undefined, JSON.stringify(text));
    assert.deepEqual(result.rejected, ['moontide.split.b'], JSON.stringify(text));
  }
  const nothing = readViewPrefs(stored(null, null));
  assert.equal(nothing.splitA, undefined);
  assert.equal(nothing.splitB, undefined);
  assert.deepEqual(nothing.rejected, []);
});

test('readViewPrefs accepts a stored history view', () => {
  const values = new Map([[STORAGE_KEYS.view, 'history']]);
  const fakeStorage = { getItem: (key) => (values.has(key) ? values.get(key) : null) };
  assert.equal(readViewPrefs(fakeStorage).view, 'history');
});

test('readViewPrefs accepts a stored jam view', () => {
  const values = new Map([[STORAGE_KEYS.view, 'jam']]);
  const fakeStorage = { getItem: (key) => (values.has(key) ? values.get(key) : null) };
  assert.equal(readViewPrefs(fakeStorage).view, 'jam');
});

test('readViewPrefs accepts a stored instruments view and ignores any other unknown view', () => {
  const stored = (value) => ({ getItem: (key) => (key === STORAGE_KEYS.view ? value : null) });
  assert.equal(readViewPrefs(stored('instruments')).view, 'instruments');
  assert.equal(readViewPrefs(stored('gallery')).view, undefined);
  assert.equal(readViewPrefs(stored('7')).view, undefined);
});

test('readViewPrefs with a throwing storage reports unavailable and every value undefined', () => {
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readViewPrefs(throwing), {
    layout: undefined,
    view: undefined,
    motion: undefined,
    historyMode: undefined,
    jamInstrument: undefined,
    jamChordTones: undefined,
    changeTiming: undefined,
    songLaunch: undefined,
    splitA: undefined,
    splitB: undefined,
    rejected: [],
    songLaunchRejected: false,
    available: false,
  });
});

test('readViewPrefs with null storage reports unavailable and every value undefined', () => {
  assert.deepEqual(readViewPrefs(null), {
    layout: undefined,
    view: undefined,
    motion: undefined,
    historyMode: undefined,
    jamInstrument: undefined,
    jamChordTones: undefined,
    changeTiming: undefined,
    songLaunch: undefined,
    splitA: undefined,
    splitB: undefined,
    rejected: [],
    songLaunchRejected: false,
    available: false,
  });
});

test('writeViewPref with a throwing storage returns false and never throws', () => {
  const throwing = {
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(writeViewPref(throwing, STORAGE_KEYS.layout, 'b'), false);
});

test('writeViewPref with null storage returns false', () => {
  assert.equal(writeViewPref(null, STORAGE_KEYS.layout, 'b'), false);
});

test('writeViewPref writes and returns true on a working storage', () => {
  const store = new Map();
  const fakeStorage = { setItem: (key, value) => store.set(key, value) };
  assert.equal(writeViewPref(fakeStorage, STORAGE_KEYS.layout, 'c'), true);
  assert.equal(store.get(STORAGE_KEYS.layout), 'c');
});

test('initialViewState with empty prefs and prefersReducedMotion true defaults to the strip, no view, motion off', () => {
  const state = initialViewState({ prefs: {}, prefersReducedMotion: true });
  assert.deepEqual(state, { layout: 'a', view: 'none', motion: 'off', motionChosen: false, historyMode: 'list', jamInstrument: 'piano', jamChordTones: 'off', changeTiming: 'now', songLaunch: 'section' });
});

test('initialViewState with empty prefs and prefersReducedMotion false defaults motion on', () => {
  const state = initialViewState({ prefs: {}, prefersReducedMotion: false });
  assert.deepEqual(state, { layout: 'a', view: 'none', motion: 'on', motionChosen: false, historyMode: 'list', jamInstrument: 'piano', jamChordTones: 'off', changeTiming: 'now', songLaunch: 'section' });
});

test('initialViewState with a stored motion wins over the OS setting and marks it chosen', () => {
  const state = initialViewState({ prefs: { motion: 'on' }, prefersReducedMotion: true });
  assert.deepEqual(state, { layout: 'a', view: 'none', motion: 'on', motionChosen: true, historyMode: 'list', jamInstrument: 'piano', jamChordTones: 'off', changeTiming: 'now', songLaunch: 'section' });
});

test('initialViewState with a stored layout and view uses them', () => {
  const state = initialViewState({ prefs: { layout: 'c', view: 'timeline' }, prefersReducedMotion: false });
  assert.deepEqual(state, { layout: 'c', view: 'timeline', motion: 'on', motionChosen: false, historyMode: 'list', jamInstrument: 'piano', jamChordTones: 'off', changeTiming: 'now', songLaunch: 'section' });
});

const BUTTON_VIEW_LISTS = [
  BUILT_VIEWS,
  ['timeline'],
  ['parts', 'timeline'],
  ['history', 'timeline', 'mixer', 'parts', 'jam', 'instruments'],
];

test('viewButtonParts lists the six built views in key order with digit, name, label and title', () => {
  assert.deepEqual(views.viewButtonParts(), [
    { key: '1', digit: '1', name: 'History', label: '1 History', title: 'History (key 1)' },
    { key: '2', digit: '2', name: 'Timeline', label: '2 Timeline', title: 'Timeline (key 2)' },
    { key: '3', digit: '3', name: 'Mixer', label: '3 Mixer', title: 'Mixer (key 3)' },
    { key: '4', digit: '4', name: 'Parts', label: '4 Parts', title: 'Parts (key 4)' },
    { key: '5', digit: '5', name: 'Jam', label: '5 Jam', title: 'Jam (key 5)' },
    { key: '6', digit: '6', name: 'Instruments', label: '6 Instruments', title: 'Instruments (key 6)' },
  ]);
});

test('viewButtonParts names only the given built views, in key order, whatever order they are given in', () => {
  assert.deepEqual(views.viewButtonParts(['timeline']).map((part) => part.label), ['2 Timeline']);
  assert.deepEqual(views.viewButtonParts(['parts', 'timeline']).map((part) => part.label), ['2 Timeline', '4 Parts']);
  assert.deepEqual(views.viewButtonParts([]), []);
});

test('viewButtonParts can call a view by another name: the key and the order stay, only the name, label and title change', () => {
  const parts = views.viewButtonParts(BUILT_VIEWS, { ...views.VIEW_TITLES, parts: 'Song' });
  assert.deepEqual(parts[3], { key: '4', digit: '4', name: 'Song', label: '4 Song', title: 'Song (key 4)' });
  assert.deepEqual(
    parts.filter((_, index) => index !== 3),
    views.viewButtonParts().filter((_, index) => index !== 3),
  );
  assert.equal(views.viewButtonParts()[3].name, 'Parts', 'the default titles are unchanged');
});

test('viewButtonParts keys are the digits of the built views in key order', () => {
  const builtDigits = Object.keys(VIEW_KEYS)
    .filter((digit) => BUILT_VIEWS.includes(VIEW_KEYS[digit]))
    .sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(views.viewButtonParts(BUILT_VIEWS).map((part) => part.key), builtDigits);
  assert.deepEqual(views.viewButtonParts().map((part) => part.key), ['1', '2', '3', '4', '5', '6']);
});

test('layoutButtonParts lists a, b and c with the letter as text and a plain-word label', () => {
  assert.deepEqual(views.layoutButtonParts(), [
    { key: 'a', text: 'a', label: 'Layout a: bottom strip' },
    { key: 'b', text: 'b', label: 'Layout b: side panel' },
    { key: 'c', text: 'c', label: 'Layout c: full screen over faint code' },
  ]);
});

test('LAYOUT_TITLES uses plain words', () => {
  assert.deepEqual(views.LAYOUT_TITLES, { a: 'bottom strip', b: 'side panel', c: 'full screen over faint code' });
});

test('the text hint is gone: the module exports no hint text or hint parts, only button parts and button state', () => {
  const hintExports = Object.keys(views).filter((name) => /hint/i.test(name)).sort();
  assert.deepEqual(hintExports, ['hintButtonState']);
});

test('applyKey handles every button key while a view is open and focus is outside the editor: a button never does nothing', () => {
  for (const list of BUTTON_VIEW_LISTS.slice(0, 3)) {
    const keys = [...views.layoutButtonParts().map((part) => part.key), ...views.viewButtonParts(list).map((part) => part.key)];
    for (const key of keys) {
      const result = applyKey({ layout: 'a', view: 'history' }, {
        key,
        focusInEditor: false,
        focusInTextEntry: false,
        ...NO_MODIFIERS,
      });
      assert.equal(result.handled, true, `key ${key} must be handled`);
    }
  }
});

test('pressing the pressed view button closes the view and pressing it again brings it back', () => {
  const press = (state, key) => applyKey(state, { key, focusInEditor: false, focusInTextEntry: false, ...NO_MODIFIERS });
  const open = { layout: 'a', view: 'timeline' };
  const closed = press(open, '2');
  assert.deepEqual(closed.state, { layout: 'a', view: 'none' });
  assert.equal(closed.handled, true);
  assert.deepEqual(press(closed.state, '2').state, { layout: 'a', view: 'timeline' });
});

test('hintButtonState marks only the current layout letter as pressed and never returns a disabled flag', () => {
  const state = { layout: 'b', view: 'none' };
  assert.deepEqual(views.hintButtonState(state, 'a'), { pressed: false });
  assert.deepEqual(views.hintButtonState(state, 'b'), { pressed: true });
  assert.deepEqual(views.hintButtonState(state, 'c'), { pressed: false });
});

test('hintButtonState marks only the open view digit as pressed', () => {
  assert.deepEqual(views.hintButtonState({ layout: 'a', view: 'timeline' }, '2'), { pressed: true });
  assert.deepEqual(views.hintButtonState({ layout: 'a', view: 'timeline' }, '1'), { pressed: false });
  assert.deepEqual(views.hintButtonState({ layout: 'a', view: 'none' }, '2'), { pressed: false });
});

test('hintButtonState presses the 6 button while the instruments view is open', () => {
  assert.deepEqual(views.hintButtonState({ layout: 'a', view: 'instruments' }, '6'), { pressed: true });
  assert.deepEqual(views.hintButtonState({ layout: 'a', view: 'instruments' }, '5'), { pressed: false });
  assert.deepEqual(views.hintButtonState({ layout: 'a', view: 'none' }, '6'), { pressed: false });
});

test('hintButtonState throws a loud error naming any key outside the closed set, Escape included (no button exists for it)', () => {
  for (const key of ['x', '9', 'Enter', 'Escape']) {
    assert.throws(() => views.hintButtonState({ layout: 'a', view: 'none' }, key), new RegExp(key));
  }
});

test('MOTION_LABELS gives the two plain-word switch states', () => {
  assert.deepEqual(views.MOTION_LABELS, { on: 'Motion: on', off: 'Motion: off' });
});

test('toggleMotion flips motion and marks it chosen', () => {
  const on = { layout: 'a', view: 'none', motion: 'off', motionChosen: false };
  assert.deepEqual(views.toggleMotion(on), { layout: 'a', view: 'none', motion: 'on', motionChosen: true });

  const off = { layout: 'a', view: 'none', motion: 'on', motionChosen: true };
  assert.deepEqual(views.toggleMotion(off), { layout: 'a', view: 'none', motion: 'off', motionChosen: true });
});

test('motionAfterOsChange follows the OS while motion has never been chosen', () => {
  const state = { layout: 'a', view: 'none', motion: 'on', motionChosen: false };
  assert.deepEqual(views.motionAfterOsChange(state, true), { layout: 'a', view: 'none', motion: 'off', motionChosen: false });
  assert.deepEqual(views.motionAfterOsChange(state, false), { layout: 'a', view: 'none', motion: 'on', motionChosen: false });
});

test('motionAfterOsChange returns the same state unchanged once motion has been chosen', () => {
  const state = { layout: 'a', view: 'none', motion: 'off', motionChosen: true };
  assert.equal(views.motionAfterOsChange(state, false), state);
});

test('readViewPrefs reads a stored tree back and ignores a stray History display value', () => {
  const tree = { getItem: (key) => (key === STORAGE_KEYS.historyMode ? 'tree' : null) };
  assert.equal(readViewPrefs(tree).historyMode, 'tree');
  const stray = { getItem: (key) => (key === STORAGE_KEYS.historyMode ? 'graph' : null) };
  assert.equal(readViewPrefs(stray).historyMode, undefined);
});

test('initialViewState uses a stored History display and defaults to the list', () => {
  assert.equal(initialViewState({ prefs: { historyMode: 'tree' }, prefersReducedMotion: false }).historyMode, 'tree');
  assert.equal(initialViewState({ prefs: {}, prefersReducedMotion: false }).historyMode, 'list');
});

test('HISTORY_MODES is the closed set list and tree, stored under moontide.historyMode', () => {
  assert.deepEqual(views.HISTORY_MODES, ['list', 'tree']);
  assert.equal(STORAGE_KEYS.historyMode, 'moontide.historyMode');
});

test('setHistoryMode returns a new state for a known mode and throws on any other', () => {
  const start = { layout: 'a', view: 'none', motion: 'on', motionChosen: false, historyMode: 'list' };
  const next = views.setHistoryMode(start, 'tree');
  assert.notEqual(next, start);
  assert.equal(next.historyMode, 'tree');
  assert.equal(start.historyMode, 'list');
  assert.throws(() => views.setHistoryMode(start, 'graph'), /graph/);
});

// --- The two remembered Jam preferences ---

test('JAM_INSTRUMENTS and JAM_CHORD_TONES are closed sets stored under moontide.jamInstrument and moontide.jamChordTones', () => {
  assert.deepEqual(views.JAM_INSTRUMENTS, ['piano', 'guitar']);
  assert.deepEqual(views.JAM_CHORD_TONES, ['on', 'off']);
  assert.equal(STORAGE_KEYS.jamInstrument, 'moontide.jamInstrument');
  assert.equal(STORAGE_KEYS.jamChordTones, 'moontide.jamChordTones');
});

test('readViewPrefs reads a stored Jam instrument and chord-tones value, and ignores stray ones', () => {
  const stored = { getItem: (key) => ({ [STORAGE_KEYS.jamInstrument]: 'guitar', [STORAGE_KEYS.jamChordTones]: 'on' })[key] ?? null };
  assert.equal(readViewPrefs(stored).jamInstrument, 'guitar');
  assert.equal(readViewPrefs(stored).jamChordTones, 'on');
  const stray = { getItem: (key) => ({ [STORAGE_KEYS.jamInstrument]: 'banjo', [STORAGE_KEYS.jamChordTones]: 'maybe' })[key] ?? null };
  assert.equal(readViewPrefs(stray).jamInstrument, undefined);
  assert.equal(readViewPrefs(stray).jamChordTones, undefined);
});

test('initialViewState defaults the Jam instrument to piano and chord tones to off, and uses stored values', () => {
  const defaults = initialViewState({ prefs: {}, prefersReducedMotion: false });
  assert.equal(defaults.jamInstrument, 'piano');
  assert.equal(defaults.jamChordTones, 'off');
  const stored = initialViewState({ prefs: { jamInstrument: 'guitar', jamChordTones: 'on' }, prefersReducedMotion: false });
  assert.equal(stored.jamInstrument, 'guitar');
  assert.equal(stored.jamChordTones, 'on');
});

test('setJamInstrument returns a new state for a known instrument and throws on any other', () => {
  const start = { layout: 'a', view: 'jam', motion: 'on', motionChosen: false, historyMode: 'list', jamInstrument: 'piano', jamChordTones: 'off' };
  const next = views.setJamInstrument(start, 'guitar');
  assert.notEqual(next, start);
  assert.equal(next.jamInstrument, 'guitar');
  assert.equal(start.jamInstrument, 'piano');
  assert.throws(() => views.setJamInstrument(start, 'banjo'), /^Error: Moontide: unknown Jam instrument/);
});

test('setJamChordTones accepts on and off and throws on any other value', () => {
  const start = { layout: 'a', view: 'jam', motion: 'on', motionChosen: false, historyMode: 'list', jamInstrument: 'piano', jamChordTones: 'off' };
  const next = views.setJamChordTones(start, 'on');
  assert.notEqual(next, start);
  assert.equal(next.jamChordTones, 'on');
  assert.equal(views.setJamChordTones(next, 'off').jamChordTones, 'off');
  assert.throws(() => views.setJamChordTones(start, 'maybe'), /^Error: Moontide: unknown Chord tones value/);
  assert.throws(() => views.setJamChordTones(start, true), /^Error: Moontide: unknown Chord tones value/);
});

// --- Text entry keeps its keys ---

test('while a number field, a text field or a select holds focus, no view key does anything', () => {
  const open = { layout: 'a', view: 'mixer' };
  for (const key of ['a', 'b', 'c', '1', '2', '3', '4', '6', 'Escape']) {
    const result = applyKey(open, { key, focusInEditor: false, focusInTextEntry: true, ...NO_MODIFIERS });
    assert.deepEqual(result, { state: open, handled: false, blurEditor: false }, `key ${key}`);
    assert.equal(result.state, open, `key ${key} must return the same state object`);
  }
  const closed = { layout: 'b', view: 'none' };
  assert.deepEqual(applyKey(closed, { key: 'a', focusInEditor: false, focusInTextEntry: true, ...NO_MODIFIERS }), { state: closed, handled: false, blurEditor: false });
});

test('without text entry focus the view keys behave as before', () => {
  const open = { layout: 'a', view: 'mixer' };
  assert.deepEqual(applyKey(open, { key: 'b', focusInEditor: false, focusInTextEntry: false, ...NO_MODIFIERS }), {
    state: { layout: 'b', view: 'mixer' },
    handled: true,
    blurEditor: false,
  });
  assert.deepEqual(applyKey(open, { key: 'Escape', focusInEditor: false, ...NO_MODIFIERS }), { state: { layout: 'a', view: 'none' }, handled: true, blurEditor: false });
});

test('readViewPrefs reads bar and phrase from the stored change timing and ignores later or a missing value', () => {
  const read = (value) => readViewPrefs({ getItem: (key) => (key === STORAGE_KEYS.changeTiming ? value : null) }).changeTiming;
  assert.equal(STORAGE_KEYS.changeTiming, 'moontide.changeTiming');
  assert.equal(read('bar'), 'bar');
  assert.equal(read('phrase'), 'phrase');
  assert.equal(read('now'), 'now');
  assert.equal(read('later'), undefined);
  assert.equal(read(null), undefined);
});

test('initialViewState gives change timing now when nothing is stored and the stored value otherwise', () => {
  assert.equal(initialViewState({ prefs: {}, prefersReducedMotion: false }).changeTiming, 'now');
  assert.equal(initialViewState({ prefs: { changeTiming: 'phrase' }, prefersReducedMotion: false }).changeTiming, 'phrase');
});

test('setChangeTiming reaches each of the three timings from any other, in any order, and never changes its input', () => {
  // The cycling button is gone (three buttons set a value directly), so the cases of cycleChangeTiming
  // (each value reachable, a new state each time, the old state untouched) are asserted on setChangeTiming.
  for (const from of ['now', 'bar', 'phrase']) {
    const start = { changeTiming: from, view: 'none' };
    for (const to of ['now', 'bar', 'phrase']) {
      const next = views.setChangeTiming(start, to);
      assert.notEqual(next, start);
      assert.equal(next.changeTiming, to);
      assert.equal(next.view, 'none');
      assert.equal(start.changeTiming, from);
    }
  }
});

test('the cycling helper is gone: the three buttons set a value directly', () => {
  assert.equal(views.cycleChangeTiming, undefined);
});

test('setChangeTiming returns a new state for a known timing and throws a Moontide error on any other', () => {
  const start = { changeTiming: 'now' };
  const next = views.setChangeTiming(start, 'bar');
  assert.notEqual(next, start);
  assert.equal(next.changeTiming, 'bar');
  assert.throws(() => views.setChangeTiming(start, 'later'), /^Error: Moontide:/);
});

test('readViewPrefs reads the Song launch choice from its closed set and ignores any other stored value', () => {
  const read = (value) => readViewPrefs({ getItem: (key) => (key === STORAGE_KEYS.songLaunch ? value : null) }).songLaunch;
  assert.equal(STORAGE_KEYS.songLaunch, 'moontide.songLaunch');
  assert.deepEqual(views.SONG_LAUNCHES, ['section', 'phrase', 'bar']);
  assert.equal(views.DEFAULT_SONG_LAUNCH, 'section');
  assert.equal(read('section'), 'section');
  assert.equal(read('phrase'), 'phrase');
  assert.equal(read('bar'), 'bar');
  for (const bad of ['now', 'later', '', 'Section', '__proto__', null]) assert.equal(read(bad), undefined, String(bad));
});

test('readViewPrefs flags a stored launch choice outside the list, and nothing for a valid or missing one', () => {
  const read = (value) => readViewPrefs({ getItem: (key) => (key === STORAGE_KEYS.songLaunch ? value : null) });
  const bad = read('sometime');
  assert.equal(bad.songLaunch, undefined);
  assert.equal(bad.songLaunchRejected, true);
  assert.deepEqual(bad.rejected, [], 'rejected keeps meaning the refused split sizes only');
  assert.equal(read('phrase').songLaunchRejected, false);
  assert.equal(read(null).songLaunchRejected, false);
  assert.equal(read(undefined).songLaunchRejected, false);
  const noStorage = readViewPrefs(null);
  assert.equal(noStorage.available, false);
  assert.equal(noStorage.songLaunchRejected, false);
});

test('VIEW_PREFS_COPY.badSongLaunch names the storage key and the three launch values and holds no stored text', () => {
  const line = views.VIEW_PREFS_COPY.badSongLaunch;
  assert.ok(Object.isFrozen(views.VIEW_PREFS_COPY));
  assert.ok(line.includes(STORAGE_KEYS.songLaunch));
  for (const value of views.SONG_LAUNCHES) assert.ok(line.includes(value), value);
  assert.ok(line.includes(`is not ${views.SONG_LAUNCHES.slice(0, -1).join(', ')} or ${views.SONG_LAUNCHES.at(-1)};`), 'the list is built from SONG_LAUNCHES');
  assert.ok(line.includes('is not section, phrase or bar;'), 'the wording of the sentence');
  assert.match(line, /sections start at the end of the section that plays/);
  assert.equal(line.includes('sometime'), false);
});

test('initialViewState gives the Song launch choice end of section when nothing is stored and the stored value otherwise', () => {
  assert.equal(initialViewState({ prefs: {}, prefersReducedMotion: false }).songLaunch, 'section');
  assert.equal(initialViewState({ prefs: { songLaunch: 'bar' }, prefersReducedMotion: false }).songLaunch, 'bar');
});

test('setSongLaunch returns a new state for a known choice and throws a Moontide error on any other', () => {
  const start = { songLaunch: 'section', view: 'none' };
  for (const to of ['section', 'phrase', 'bar']) {
    const next = views.setSongLaunch(start, to);
    assert.equal(next.songLaunch, to);
    assert.equal(next.view, 'none');
  }
  assert.equal(start.songLaunch, 'section');
  assert.throws(() => views.setSongLaunch(start, 'now'), /^Error: Moontide:/);
});
