// Unit tests for page/history.js: the History view's pure helpers (row texts, exact copy, the
// model reducer). No DOM, so no build step: imports the page module directly, like test/parts.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import {
  HISTORY_COPY,
  ORIGIN_NAMES,
  RESTORE_TIMEOUT_MS,
  SHOW_MORE_TIMEOUT_MS,
  showMoreText,
  sessionDividerAfter,
  formatDividerText,
  scrollTopAfterInsert,
  versionText,
  rowLabelText,
  restoreAriaLabel,
  toggleAriaLabel,
  versionCountText,
  restoreStatusText,
  formatRowTime,
  emptyHistoryModel,
  applyHistoryMessage,
  historyMessageText,
  summarizeChange,
  diffLines,
  countChanges,
  previousVersionOf,
  foldDiff,
  unchangedLinesText,
  noChangesText,
  diffHeaderText,
  MAX_DIFF_CELLS,
  computeLanes,
  laneGeometry,
  branchColor,
  historyKeyAction,
  moveSelection,
} from '../page/history.js';

const version = (id, extra = {}) => ({ id, at: '2026-01-02T14:02:00Z', origin: 'claude', code: `s("v${id}")`, ...extra });

test('HISTORY_COPY holds exactly the pinned strings', () => {
  assert.deepEqual(HISTORY_COPY, {
    restore: 'Restore',
    restoring: 'Restoring…',
    current: 'Current',
    loading: 'Loading history…',
    empty: 'No versions yet — the first one appears when music plays.',
    loadError: "Couldn't load the history — reload the page to try again.",
    disconnected: 'Disconnected — restoring is off until Moontide reconnects.',
    restoreDidNotComplete: 'restore did not complete — try again.',
    firstVersion: 'First version',
    noChange: 'No change',
    codeChanged: 'Code changed',
    otherLinesChanged: 'other lines changed',
    tooLarge: 'Too large to compare line by line.',
    detailPlaceholder: 'Choose Changes on a version to see its lines.',
    toggleShow: 'Changes',
    toggleHide: 'Hide',
    loadingOlder: 'Loading older versions…',
    loadOlderFailed: "Couldn't load older versions — try again.",
    favoriteTitle: 'Favorite',
    modeList: 'List',
    modeTree: 'Tree',
    modeGroupLabel: 'History display',
  });
});

test('ORIGIN_NAMES writes the three origins in their pinned wording', () => {
  assert.deepEqual(ORIGIN_NAMES, { claude: 'Claude', hand: 'Hand edit', page: 'Page' });
});

test('RESTORE_TIMEOUT_MS is 5000', () => {
  assert.equal(RESTORE_TIMEOUT_MS, 5000);
});

test('versionText writes the number the way the top bar does', () => {
  assert.equal(versionText(12), 'v12');
});

test('restoreAriaLabel names the version', () => {
  assert.equal(restoreAriaLabel(12), 'Restore v12');
});

test('restoreAriaLabel only offers a restore while the row can restore', () => {
  assert.equal(restoreAriaLabel(12, { isCurrent: false, connected: true }), 'Restore v12');
  assert.equal(restoreAriaLabel(12, { isCurrent: true, connected: true }), 'Current version v12');
  assert.equal(restoreAriaLabel(12, { isCurrent: false, connected: false }), 'Version v12, restoring is off');
  assert.equal(restoreAriaLabel(12, { isCurrent: true, connected: false }), 'Current version v12');
});

test('toggleAriaLabel names the version and the action', () => {
  assert.equal(toggleAriaLabel(12, false), 'Show changes in v12');
  assert.equal(toggleAriaLabel(12, true), 'Hide changes in v12');
});

test('versionCountText is singular for one and plural for zero and many', () => {
  assert.equal(versionCountText(1), '1 version');
  assert.equal(versionCountText(0), '0 versions');
  assert.equal(versionCountText(31), '31 versions');
});

test('restoreStatusText picks Current, then Restoring…, then Restore, else nothing', () => {
  assert.equal(restoreStatusText({ isCurrent: true, isPending: true, isHot: true }), 'Current');
  assert.equal(restoreStatusText({ isCurrent: false, isPending: true, isHot: true }), 'Restoring…');
  assert.equal(restoreStatusText({ isCurrent: false, isPending: false, isHot: true }), 'Restore');
  assert.equal(restoreStatusText({ isCurrent: false, isPending: false, isHot: false }), '');
});

test('rowLabelText prefers "Restored from v12" over a stored label, else the label, else nothing', () => {
  assert.equal(rowLabelText(version(13, { label: 'restored from #12', restoredFrom: 12 })), 'Restored from v12');
  assert.equal(rowLabelText(version(13, { label: 'slower drums' })), 'slower drums');
  assert.equal(rowLabelText(version(13)), '');
});

test('formatRowTime writes hour and minute in the given locale and zone', () => {
  assert.equal(formatRowTime('2026-01-02T14:02:00Z', { locale: 'en-GB', timeZone: 'UTC' }), '14:02');
});

test('emptyHistoryModel starts loading with nothing in it', () => {
  assert.deepEqual(emptyHistoryModel(), { status: 'loading', versions: [], beyond: null, total: 0, remaining: 0 });
});

test('applyHistoryMessage: history makes the model ready with the message contents', () => {
  const next = applyHistoryMessage(emptyHistoryModel(), {
    type: 'history',
    versions: [version(2), version(1)],
    beyond: { id: 0, code: 'x' },
    total: 9,
    remaining: 7,
  });
  assert.equal(next.status, 'ready');
  assert.deepEqual(
    next.versions.map((v) => v.id),
    [2, 1],
  );
  assert.deepEqual(next.beyond, { id: 0, code: 'x' });
  assert.equal(next.total, 9);
  assert.equal(next.remaining, 7);
});

test('applyHistoryMessage: history-add puts the new version first and takes the new total, without touching the old model', () => {
  const ready = applyHistoryMessage(emptyHistoryModel(), {
    type: 'history',
    versions: [version(2), version(1)],
    beyond: null,
    total: 2,
    remaining: 0,
  });
  const next = applyHistoryMessage(ready, { type: 'history-add', version: version(3), total: 3 });
  assert.deepEqual(
    next.versions.map((v) => v.id),
    [3, 2, 1],
  );
  assert.equal(next.total, 3);
  assert.equal(ready.versions.length, 2);
});

test('applyHistoryMessage: a history-add whose id is already present replaces it rather than duplicating', () => {
  const ready = applyHistoryMessage(emptyHistoryModel(), {
    type: 'history',
    versions: [version(2), version(1)],
    beyond: null,
    total: 2,
    remaining: 0,
  });
  const next = applyHistoryMessage(ready, { type: 'history-add', version: version(2, { label: 'again' }), total: 2 });
  assert.deepEqual(
    next.versions.map((v) => v.id),
    [2, 1],
  );
  assert.equal(next.versions[0].label, 'again');
});

test('showMoreText names how many versions remain, and the timeout is 5000', () => {
  assert.equal(showMoreText(150), 'Show older versions (150 more)');
  assert.equal(showMoreText(1), 'Show older versions (1 more)');
  assert.equal(SHOW_MORE_TIMEOUT_MS, 5000);
});

const readyWindow = () =>
  applyHistoryMessage(emptyHistoryModel(), {
    type: 'history',
    versions: [version(5), version(4)],
    beyond: { id: 3, code: 's("v3")' },
    total: 5,
    remaining: 3,
  });

test('applyHistoryMessage: history-older appends the batch below, takes beyond and remaining, keeps the total', () => {
  const before = readyWindow();
  const next = applyHistoryMessage(before, {
    type: 'history-older',
    versions: [version(3), version(2)],
    beyond: { id: 1, code: 's("v1")' },
    remaining: 1,
  });
  assert.deepEqual(next.versions.map((v) => v.id), [5, 4, 3, 2]);
  assert.deepEqual(next.beyond, { id: 1, code: 's("v1")' });
  assert.equal(next.remaining, 1);
  assert.equal(next.total, 5);
  assert.equal(next.status, 'ready');
  assert.deepEqual(before.versions.map((v) => v.id), [5, 4]);
});

test('applyHistoryMessage: history-older skips ids already loaded and reaches the end with no beyond', () => {
  const next = applyHistoryMessage(readyWindow(), {
    type: 'history-older',
    versions: [version(3), version(2), version(1)],
    beyond: null,
    remaining: 0,
  });
  assert.deepEqual(next.versions.map((v) => v.id), [5, 4, 3, 2, 1]);
  assert.equal(next.beyond, null);
  assert.equal(next.remaining, 0);
  const again = applyHistoryMessage(readyWindow(), {
    type: 'history-older',
    versions: [version(3), version(3)],
    beyond: null,
    remaining: 0,
  });
  assert.deepEqual(again.versions.map((v) => v.id), [5, 4, 3]);
});

test('applyHistoryMessage: a history-older that does not continue the loaded rows leaves the model as it was', () => {
  const before = readyWindow();
  const stale = { type: 'history-older', versions: [version(2)], beyond: null, remaining: 0 };
  assert.equal(applyHistoryMessage(before, stale), before);
  const empty = { type: 'history-older', versions: [], beyond: null, remaining: 0 };
  assert.equal(applyHistoryMessage(before, empty), before);
  const noBeyond = { ...before, beyond: null };
  assert.equal(applyHistoryMessage(noBeyond, { ...stale, versions: [version(3)] }), noBeyond);
});

test('sessionDividerAfter: the first version of the file never gets a divider, a middle row does', () => {
  const model = {
    ...emptyHistoryModel(),
    status: 'ready',
    versions: [version(3), version(2, { sessionStart: '2026-01-02T09:00:00Z' }), version(1, { sessionStart: '2026-01-01T09:00:00Z' })],
    beyond: null,
  };
  assert.equal(sessionDividerAfter(model, 0), null);
  assert.equal(sessionDividerAfter(model, 1), '2026-01-02T09:00:00Z');
  assert.equal(sessionDividerAfter(model, 2), null);
});

test('sessionDividerAfter: the last loaded row gets a divider only when an older version exists beyond it', () => {
  const versions = [version(3), version(2, { sessionStart: '2026-01-02T09:00:00Z' })];
  const base = { ...emptyHistoryModel(), status: 'ready', versions };
  assert.equal(sessionDividerAfter({ ...base, beyond: null }, 1), null);
  assert.equal(sessionDividerAfter({ ...base, beyond: { id: 1, code: 's("v1")' } }, 1), '2026-01-02T09:00:00Z');
});

test('sessionDividerAfter: a row without a session start has no divider', () => {
  const model = { ...emptyHistoryModel(), status: 'ready', versions: [version(2), version(1)], beyond: null };
  assert.equal(sessionDividerAfter(model, 0), null);
  assert.equal(sessionDividerAfter(model, 5), null);
});

test('formatDividerText writes "New session · date, time" from the locale and zone given', () => {
  const at = '2026-09-28T14:02:00Z';
  const options = { locale: 'en-US', timeZone: 'UTC' };
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(at));
  assert.equal(formatDividerText(at, options), `New session · ${date}, ${formatRowTime(at, options)}`);
  assert.match(formatDividerText(at, options), /^New session · Sep 28, 2026, 02:02 PM$/);
});

test('applyHistoryMessage: history-favorite sets the favorite of the loaded version and a rename replaces it', () => {
  const before = readyWindow();
  const named = applyHistoryMessage(before, { type: 'history-favorite', id: 4, name: 'first name' });
  assert.equal(named.versions.find((v) => v.id === 4).favorite, 'first name');
  assert.equal(named.versions.find((v) => v.id === 5).favorite, undefined);
  const renamed = applyHistoryMessage(named, { type: 'history-favorite', id: 4, name: 'second name' });
  assert.equal(renamed.versions.find((v) => v.id === 4).favorite, 'second name');
  assert.equal(before.versions.find((v) => v.id === 4).favorite, undefined);
});

test('applyHistoryMessage: a history-favorite for a version that is not loaded changes nothing', () => {
  const before = readyWindow();
  const next = applyHistoryMessage(before, { type: 'history-favorite', id: 99, name: 'elsewhere' });
  assert.deepEqual(next, before);
});

test('applyHistoryMessage: history-error sets status error', () => {
  assert.equal(applyHistoryMessage(emptyHistoryModel(), { type: 'history-error' }).status, 'error');
});

test('applyHistoryMessage: history-older-error leaves the loaded model exactly as it was', () => {
  const before = readyWindow();
  assert.equal(applyHistoryMessage(before, { type: 'history-older-error' }), before);
});

test('applyHistoryMessage throws on an unknown type', () => {
  assert.throws(() => applyHistoryMessage(emptyHistoryModel(), { type: 'version', id: 1 }), /'version'/);
});

test('historyMessageText: loading text while loading, the error text on error, the empty text when ready with nothing, else null', () => {
  assert.equal(historyMessageText(emptyHistoryModel()), HISTORY_COPY.loading);
  assert.equal(historyMessageText({ ...emptyHistoryModel(), status: 'error' }), HISTORY_COPY.loadError);
  assert.equal(historyMessageText({ ...emptyHistoryModel(), status: 'ready' }), HISTORY_COPY.empty);
  assert.equal(historyMessageText({ ...emptyHistoryModel(), status: 'ready', versions: [version(1)] }), null);
});

test('a row summary names the tracks that changed and counts the lines', () => {
  const older = 'drums: s("bd")\nhats: s("hh")';
  const newer = 'drums: s("bd*2")\nhats: s("hh")\nclaps: s("cp")';
  assert.equal(summarizeChange(older, newer, { parse }), 'drums changed, claps added');
  assert.deepEqual(countChanges(diffLines(older, newer)), { added: 2, removed: 1 });
});

const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n');
const kinds = (ops) => ops.map((op) => `${op.type} ${op.text}`);

test('diffLines lists context, a deletion before its replacing addition, and a trailing addition', () => {
  assert.deepEqual(kinds(diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne')), [
    'ctx a',
    'del b',
    'add B',
    'ctx c',
    'ctx d',
    'add e',
  ]);
});

test('diffLines reads CRLF as LF, so the same code with either line ending is all context', () => {
  const ops = diffLines('a\r\nb', 'a\nb');
  assert.deepEqual(kinds(ops), ['ctx a', 'ctx b']);
});

test('diffLines with no previous version adds every line; equal codes give only context', () => {
  assert.deepEqual(kinds(diffLines(null, 'x\ny')), ['add x', 'add y']);
  assert.ok(diffLines('x\ny', 'x\ny').every((op) => op.type === 'ctx'));
});

test('diffLines handles a change at the very start, at the very end, and a whole-code replacement', () => {
  assert.deepEqual(kinds(diffLines('a\nb', 'z\nb')), ['del a', 'add z', 'ctx b']);
  assert.deepEqual(kinds(diffLines('a\nb', 'a\nz')), ['ctx a', 'del b', 'add z']);
  assert.deepEqual(kinds(diffLines('a', 'b')), ['del a', 'add b']);
  assert.deepEqual(countChanges(diffLines('a\nb', 'a')), { added: 0, removed: 1 });
});

test('diffLines refuses a trimmed middle above the cap and computes one at the cap', () => {
  assert.equal(MAX_DIFF_CELLS, 4_000_000);
  assert.equal(diffLines(lines('o', 4000), lines('n', 2000)), null);
  const ops = diffLines(lines('o', 2000), lines('n', 2000));
  assert.ok(Array.isArray(ops));
  assert.deepEqual(countChanges(ops), { added: 2000, removed: 2000 });
  assert.equal(countChanges(null), null);
});

test('the diff cap counts the trimmed middle only: a huge shared prefix and suffix still compute', () => {
  const shared = lines('same', 6000);
  const ops = diffLines(`${shared}\nold\n${shared}`, `${shared}\nnew\n${shared}`);
  assert.ok(Array.isArray(ops));
  assert.deepEqual(countChanges(ops), { added: 1, removed: 1 });
});

test('foldDiff keeps two lines of context around a change and folds each longer unchanged run', () => {
  const ops = diffLines(
    `${lines('a', 6)}\nold\n${lines('b', 6)}\nold2\n${lines('c', 3)}`,
    `${lines('a', 6)}\nnew\n${lines('b', 6)}\nnew2\n${lines('c', 3)}`,
  );
  assert.deepEqual(kinds(foldDiff(ops).map((op) => (op.type === 'gap' ? { type: 'gap', text: String(op.count) } : op))), [
    'gap 4',
    'ctx a4',
    'ctx a5',
    'del old',
    'add new',
    'ctx b0',
    'ctx b1',
    'gap 2',
    'ctx b4',
    'ctx b5',
    'del old2',
    'add new2',
    'ctx c0',
    'ctx c1',
    'gap 1',
  ]);
});

test('foldDiff leaves a short unchanged stretch alone and gives [] when nothing changed', () => {
  const ops = diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne');
  assert.deepEqual(foldDiff(ops).map((op) => op.type), ['ctx', 'del', 'add', 'ctx', 'ctx', 'gap']);
  assert.deepEqual(foldDiff(diffLines('a\nb', 'a\nb')), []);
  assert.deepEqual(foldDiff(diffLines(lines('x', 50), lines('x', 50))), []);
});

test('the diff copy: gap, unchanged and header texts', () => {
  assert.equal(unchangedLinesText(1), '1 unchanged line');
  assert.equal(unchangedLinesText(6), '6 unchanged lines');
  assert.equal(noChangesText(4), 'No changes against v4.');
  assert.equal(diffHeaderText(12, 11), 'v12 against v11');
  assert.equal(diffHeaderText(1, null), 'v1 · first version');
});

test('summarizeChange lists changed tracks first, then added, then removed', () => {
  const older = 'drums: s("bd")\nhats: s("hh")\nbass: s("sawtooth")';
  const newer = 'drums: s("bd*2")\nhats: s("hh")\nclaps: s("cp")';
  assert.equal(summarizeChange(older, newer, { parse }), 'drums changed, claps added, bass removed');
});

test('summarizeChange keeps three entries and counts the rest', () => {
  const older = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}: s("${n}")`).join('\n');
  const newer = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}: s("${n}1")`).join('\n');
  assert.equal(summarizeChange(older, newer, { parse }), 'a changed, b changed, c changed, +2 more');
});

test('summarizeChange names a muted or soloed track without the mixer\'s marker or the mute underscore', () => {
  assert.equal(summarizeChange('drums: s("bd")', '_drums: s("bd")', { parse }), 'drums changed');
  assert.equal(summarizeChange('_drums: s("bd")', 'drums: s("bd")', { parse }), 'drums changed');
  assert.equal(summarizeChange('drums: s("bd")\nhats: s("hh")', 'drums: s("bd")\nS_hats: s("hh")', { parse }), 'hats changed');
  assert.equal(summarizeChange('stack(s("bd"), s("hh"))', 'stack(s("bd").hush(), s("hh"))', { parse }), 'bd changed');
});

test('summarizeChange says "other lines changed" when the change is outside every track', () => {
  assert.equal(summarizeChange('drums: s("bd")\nsetcps(1)', 'drums: s("bd")\nsetcps(2)', { parse }), 'other lines changed');
});

test('summarizeChange says "No change" for equal code, even unparseable or with another line ending', () => {
  assert.equal(summarizeChange('drums: s("bd"', 'drums: s("bd"', { parse }), 'No change');
  assert.equal(summarizeChange('drums: s("bd")\r\nhats: s("hh")', 'drums: s("bd")\nhats: s("hh")', { parse }), 'No change');
});

test('summarizeChange says "Code changed" when either side cannot be read, or there is no parser', () => {
  assert.equal(summarizeChange('drums: s("bd"', 'drums: s("bd")', { parse }), 'Code changed');
  assert.equal(summarizeChange('drums: s("bd")', 'drums: s("bd"', { parse }), 'Code changed');
  assert.equal(summarizeChange('drums: s("bd")', 'drums: s("hh")', {}), 'Code changed');
  assert.equal(summarizeChange('drums: s("bd")', 'drums: s("hh")', { parse: null }), 'Code changed');
});

test('summarizeChange logs a failure that is not a parse error once, and still says "Code changed"', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const cache = new Map();
  const broken = () => {
    throw new TypeError('boom');
  };
  assert.equal(summarizeChange('drums: s("bd")', 'drums: s("hh")', { parse: broken, cache }), 'Code changed');
  assert.equal(errors.mock.callCount(), 2, 'one line per distinct code, the two codes differ');
  assert.equal(summarizeChange('drums: s("bd")', 'drums: s("hh")', { parse: broken, cache }), 'Code changed');
  assert.equal(errors.mock.callCount(), 2, 'the cache keeps a repeat from logging again');
  assert.match(String(errors.mock.calls[0].arguments[1]), /boom/);
});

test('summarizeChange stays silent for a real acorn parse error', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  assert.equal(summarizeChange('drums: s("bd"', 'drums: s("bd")', { parse }), 'Code changed');
  assert.equal(errors.mock.callCount(), 0);
});

test('summarizeChange says "First version" when there is nothing older', () => {
  assert.equal(summarizeChange(null, 'drums: s("bd")', { parse }), 'First version');
});

test('summarizeChange reads a renamed label as removed plus added', () => {
  assert.equal(summarizeChange('drums: s("bd")', 'kick: s("bd")', { parse }), 'kick added, drums removed');
});

test('summarizeChange on $: tracks: a string edit reads as removed plus added, a numeric edit as changed', () => {
  assert.equal(summarizeChange('$: s("bd")', '$: s("hh")', { parse }), 'hh added, bd removed');
  assert.equal(summarizeChange('$: s("bd").gain(0.5)', '$: s("bd").gain(0.8)', { parse }), 'bd changed');
});

test('summarizeChange with a shared cache parses each distinct code once', () => {
  let calls = 0;
  const counting = (code, options) => {
    calls += 1;
    return parse(code, options);
  };
  const cache = new Map();
  const v1 = 'drums: s("bd")';
  const v2 = 'drums: s("bd*2")';
  const v3 = 'drums: s("bd*4")';
  summarizeChange(v2, v3, { parse: counting, cache });
  summarizeChange(v1, v2, { parse: counting, cache });
  assert.equal(calls, 3);
  summarizeChange(v1, v2, { parse: counting, cache });
  assert.equal(calls, 3);
});

test('previousVersionOf is the next older row, then the beyond version, then null', () => {
  const model = {
    versions: [version(5), version(4), version(3)],
    beyond: { id: 2, code: 's("v2")' },
  };
  assert.deepEqual(previousVersionOf(model, 0), { id: 4, code: 's("v4")' });
  assert.deepEqual(previousVersionOf(model, 2), { id: 2, code: 's("v2")' });
  assert.equal(previousVersionOf({ ...model, beyond: null }, 2), null);
});

test('scrollTopAfterInsert: at the top the list grows downward and the scroll stays 0', () => {
  assert.equal(scrollTopAfterInsert({ scrollTop: 0, heightBefore: 1000, heightAfter: 1050 }), 0);
});

test('scrollTopAfterInsert: scrolled down, the inserted height is added so the rows on screen stay put', () => {
  assert.equal(scrollTopAfterInsert({ scrollTop: 400, heightBefore: 1000, heightAfter: 1050 }), 450);
});

test('scrollTopAfterInsert: no height change returns the same scroll position', () => {
  assert.equal(scrollTopAfterInsert({ scrollTop: 400, heightBefore: 1000, heightAfter: 1000 }), 400);
  assert.equal(scrollTopAfterInsert({ scrollTop: 0, heightBefore: 1000, heightAfter: 1000 }), 0);
});

// --- Tree lanes: rows are given newest first as { id, parent }, parent undefined for a root ---

const columnsOf = (rows) => computeLanes(rows).rows.map((row) => row.column);

test('computeLanes: a linear history of five versions is one column with one line running through', () => {
  const { rows, maxLanes } = computeLanes([
    { id: 5, parent: 4 },
    { id: 4, parent: 3 },
    { id: 3, parent: 2 },
    { id: 2, parent: 1 },
    { id: 1 },
  ]);
  assert.deepEqual(rows.map((row) => row.column), [0, 0, 0, 0, 0]);
  assert.equal(maxLanes, 1);
  assert.equal(rows[4].lineBelow, false);
  assert.deepEqual(rows.slice(0, 4).map((row) => row.lineBelow), [true, true, true, true]);
  assert.deepEqual(rows.map((row) => row.lineAbove), [false, true, true, true, true]);
  assert.deepEqual(rows.map((row) => row.ends), [[], [], [], [], []]);
});

test('computeLanes: one fork puts the older tip on a second column and ends it at the fork point', () => {
  const { rows, maxLanes } = computeLanes([
    { id: 7, parent: 6 },
    { id: 6, parent: 2 },
    { id: 5, parent: 4 },
    { id: 4, parent: 3 },
    { id: 3, parent: 2 },
    { id: 2, parent: 1 },
    { id: 1 },
  ]);
  assert.deepEqual(rows.map((row) => row.column), [0, 0, 1, 1, 1, 0, 0]);
  assert.equal(rows[2].lineAbove, false, 'row 5 is a branch tip');
  assert.deepEqual([rows[2].through, rows[3].through, rows[4].through], [[0], [0], [0]]);
  assert.deepEqual(rows[5].ends, [1]);
  assert.equal(maxLanes, 2);
});

test('computeLanes: two forks off the same version take three columns and the version ends both extra ones', () => {
  const { rows, maxLanes } = computeLanes([
    { id: 6, parent: 1 },
    { id: 5, parent: 4 },
    { id: 4, parent: 1 },
    { id: 3, parent: 2 },
    { id: 2, parent: 1 },
    { id: 1 },
  ]);
  assert.deepEqual(rows.map((row) => row.column), [0, 1, 1, 2, 2, 0]);
  assert.deepEqual(rows[5].ends, [1, 2]);
  assert.equal(maxLanes, 3);
});

test('computeLanes: a parent that is not loaded yet keeps its line running to the bottom edge', () => {
  const { rows } = computeLanes([
    { id: 3, parent: 2 },
    { id: 2, parent: 1 },
  ]);
  assert.equal(rows[1].lineBelow, true);
  assert.deepEqual(rows[1].lanesAfter, [true]);
});

test('computeLanes: a version without a parent is a root and frees its column for the next row', () => {
  const { rows } = computeLanes([{ id: 5, parent: 4 }, { id: 4 }, { id: 3, parent: 2 }, { id: 2 }]);
  assert.equal(rows[1].lineBelow, false);
  assert.deepEqual(rows[1].lanesAfter, [false]);
  assert.deepEqual(rows.map((row) => row.column), [0, 0, 0, 0]);
  assert.equal(rows[2].lineAbove, false, 'nothing draws into a row whose parent link was dropped');
});

test('computeLanes: a parent not older than its row is a root, reported once per row id even across redraws', () => {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    const rows = [{ id: 9101, parent: 9101 }, { id: 9100, parent: 9200 }];
    const first = computeLanes(rows);
    computeLanes(rows);
    assert.deepEqual(first.rows.map((row) => row.lineBelow), [false, false]);
    assert.equal(calls.length, 2, 'one report per row id, not per call');
    assert.match(String(calls[0][0]), /9101/);
  } finally {
    console.error = original;
  }
});

test('computeLanes: a parent that is not a whole number is a root and never draws a link', () => {
  const original = console.error;
  console.error = () => {};
  try {
    const { rows } = computeLanes([{ id: 9301, parent: 'x' }, { id: 9300, parent: 1.5 }, { id: 9299, parent: 0 }]);
    assert.deepEqual(rows.map((row) => row.lineBelow), [false, false, false]);
  } finally {
    console.error = original;
  }
});

test('computeLanes: ten tips off version 1 give ten lanes and version 1 ends nine of them', () => {
  const tips = [];
  for (let id = 11; id >= 2; id -= 1) tips.push({ id, parent: 1 });
  const { rows, maxLanes } = computeLanes([...tips, { id: 1 }]);
  assert.equal(maxLanes, 10);
  assert.deepEqual(rows[10].ends, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(rows[10].column, 0);
});

test('computeLanes: a restore then a change forks a new branch, the older trunk moves right', () => {
  // 1 <- 2 <- 3 <- 4, then a restore of 2 (id 5, parent 2), then a change (id 6, parent 5).
  assert.deepEqual(
    columnsOf([
      { id: 6, parent: 5 },
      { id: 5, parent: 2 },
      { id: 4, parent: 3 },
      { id: 3, parent: 2 },
      { id: 2, parent: 1 },
      { id: 1 },
    ]),
    [0, 0, 1, 1, 0, 0],
  );
});

test('computeLanes: an empty list has one lane of width and no rows', () => {
  assert.deepEqual(computeLanes([]), { rows: [], maxLanes: 1 });
});

test('laneGeometry: one lane per rem up to eight, then the pitch shrinks so the gutter stays at eight rem', () => {
  assert.deepEqual(laneGeometry(1), { pitchRem: 1, widthRem: 1 });
  assert.deepEqual(laneGeometry(8), { pitchRem: 1, widthRem: 8 });
  assert.deepEqual(laneGeometry(10), { pitchRem: 0.8, widthRem: 8 });
  assert.deepEqual(laneGeometry(40), { pitchRem: 0.25, widthRem: 10 });
});

test('branchColor: the column number one to eight, cycling after eight', () => {
  assert.equal(branchColor(0), 1);
  assert.equal(branchColor(7), 8);
  assert.equal(branchColor(8), 1);
});

// --- Keyboard ---

const keyBase = { key: 'Enter', viewOpen: true, focusKind: 'body', repeat: false, selectionKind: 'row', ctrlKey: false, metaKey: false, altKey: false };
const keyAction = (extra) => historyKeyAction({ ...keyBase, ...extra });
const NONE = { action: 'none', preventDefault: false };

test('historyKeyAction: a held modifier or a closed view gives none for every key', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ']) {
    assert.deepEqual(keyAction({ key, ctrlKey: true }), NONE);
    assert.deepEqual(keyAction({ key, metaKey: true }), NONE);
    assert.deepEqual(keyAction({ key, altKey: true }), NONE);
    assert.deepEqual(keyAction({ key, viewOpen: false }), NONE);
  }
});

test('historyKeyAction: the code editor and other controls never trigger anything', () => {
  for (const focusKind of ['editor', 'other-control']) {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ']) {
      assert.deepEqual(keyAction({ key, focusKind }), NONE, `${key} on ${focusKind}`);
      assert.deepEqual(keyAction({ key, focusKind, repeat: true }), NONE, `held ${key} on ${focusKind}`);
    }
  }
});

test('historyKeyAction: arrows move the selection from the page, a row button, a toggle and the More control', () => {
  for (const focusKind of ['body', 'history-main', 'history-toggle', 'history-more']) {
    assert.deepEqual(keyAction({ key: 'ArrowUp', focusKind }), { action: 'up', preventDefault: true });
    assert.deepEqual(keyAction({ key: 'ArrowDown', focusKind }), { action: 'down', preventDefault: true });
  }
  // A held arrow keeps moving.
  assert.deepEqual(keyAction({ key: 'ArrowDown', repeat: true }), { action: 'down', preventDefault: true });
});

test('historyKeyAction: Enter restores a row selection and loads older for the More selection, on the page or a row button', () => {
  for (const focusKind of ['body', 'history-main']) {
    assert.deepEqual(keyAction({ key: 'Enter', focusKind, selectionKind: 'row' }), { action: 'restore', preventDefault: true });
    assert.deepEqual(keyAction({ key: 'Enter', focusKind, selectionKind: 'more' }), { action: 'loadMore', preventDefault: true });
    assert.deepEqual(keyAction({ key: 'Enter', focusKind, selectionKind: 'none' }), NONE);
  }
});

test('historyKeyAction: Enter on a toggle or the More control is left to the native button', () => {
  assert.deepEqual(keyAction({ key: 'Enter', focusKind: 'history-toggle' }), NONE);
  assert.deepEqual(keyAction({ key: 'Enter', focusKind: 'history-more', selectionKind: 'more' }), NONE);
});

test('historyKeyAction: Space toggles the selected diff and prevents the default, never restores', () => {
  for (const focusKind of ['body', 'history-main']) {
    assert.deepEqual(keyAction({ key: ' ', focusKind, selectionKind: 'row' }), { action: 'toggle', preventDefault: true });
  }
  // With the More control selected Space does nothing, but a focused row button must not click.
  assert.deepEqual(keyAction({ key: ' ', focusKind: 'body', selectionKind: 'more' }), NONE);
  assert.deepEqual(keyAction({ key: ' ', focusKind: 'history-main', selectionKind: 'more' }), { action: 'none', preventDefault: true });
  // On a toggle the native button toggles once.
  assert.deepEqual(keyAction({ key: ' ', focusKind: 'history-toggle' }), NONE);
});

test('historyKeyAction: a repeated Enter or Space does nothing but still prevents a native click', () => {
  for (const key of ['Enter', ' ']) {
    for (const focusKind of ['body', 'history-main', 'history-toggle', 'history-more']) {
      assert.deepEqual(keyAction({ key, focusKind, repeat: true }), { action: 'none', preventDefault: true }, `${key} on ${focusKind}`);
    }
  }
});

test('historyKeyAction: every other key is left alone', () => {
  for (const key of ['a', '1', 'Escape', 'Tab', 'ArrowLeft', 'Shift']) {
    assert.deepEqual(keyAction({ key }), NONE, key);
  }
});

test('moveSelection: down goes to the next older id and stops at the last unless more remain', () => {
  const ids = [9, 8, 7];
  assert.equal(moveSelection({ ids, hasMore: false, selected: 9, direction: 'down' }), 8);
  assert.equal(moveSelection({ ids, hasMore: false, selected: 7, direction: 'down' }), 7);
  assert.equal(moveSelection({ ids, hasMore: true, selected: 7, direction: 'down' }), 'more');
  assert.equal(moveSelection({ ids, hasMore: true, selected: 'more', direction: 'down' }), 'more');
});

test('moveSelection: up goes to the next newer id, from More back to the last id, and stays on the first', () => {
  const ids = [9, 8, 7];
  assert.equal(moveSelection({ ids, hasMore: true, selected: 7, direction: 'up' }), 8);
  assert.equal(moveSelection({ ids, hasMore: true, selected: 'more', direction: 'up' }), 7);
  assert.equal(moveSelection({ ids, hasMore: false, selected: 9, direction: 'up' }), 9);
});

test('moveSelection: nothing selected goes to the first id, and an id that vanished does too', () => {
  const ids = [9, 8, 7];
  assert.equal(moveSelection({ ids, hasMore: false, selected: null, direction: 'down' }), 9);
  assert.equal(moveSelection({ ids, hasMore: false, selected: null, direction: 'up' }), 9);
  assert.equal(moveSelection({ ids, hasMore: false, selected: 42, direction: 'down' }), 9);
  assert.equal(moveSelection({ ids: [], hasMore: false, selected: null, direction: 'down' }), null);
});
