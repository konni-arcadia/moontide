// Pure module for Moontide's History view: the row texts, the time format and the history model
// reducer. No DOM access at import time, so this module can be imported directly by node:test
// and by page/main.js without a build step. Mirrors HistoryVersion, HistoryWindow and the
// history messages of src/protocol.ts by hand.

import { extractTracks } from './tracks.js';

/** Page-visible copy for the History view. */
export const HISTORY_COPY = {
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
};

/** How long a click on a version waits for its new entry before the page says it did not finish. */
export const RESTORE_TIMEOUT_MS = 5000;

/** How long a click on Show older versions waits for its answer before the page says it did not arrive. */
export const SHOW_MORE_TIMEOUT_MS = 5000;

/** The label of the control that loads the next older versions. */
export function showMoreText(remaining) {
  return `Show older versions (${remaining} more)`;
}

/** How the origin of a version is written in a row. */
export const ORIGIN_NAMES = { claude: 'Claude', hand: 'Hand edit', page: 'Page' };

/** The version number exactly as the top bar writes it. */
export function versionText(id) {
  return `v${id}`;
}

/**
 * The accessible name of a row's restore button. It offers a restore only while the button can
 * restore: the current row and every row while disconnected say why they do nothing.
 */
export function restoreAriaLabel(id, { isCurrent = false, connected = true } = {}) {
  if (isCurrent) return `Current version ${versionText(id)}`;
  if (!connected) return `Version ${versionText(id)}, restoring is off`;
  return `Restore ${versionText(id)}`;
}

/** The accessible name of a row's Changes / Hide button: it keeps the visible word and adds the version. */
export function toggleAriaLabel(id, open) {
  return `${open ? 'Hide' : 'Show'} changes in ${versionText(id)}`;
}

/** The header count: the total number of versions on disk, not the number loaded. */
export function versionCountText(total) {
  return total === 1 ? '1 version' : `${total} versions`;
}

/**
 * The one status slot at the right end of a row, so the row never jumps: Current for the version
 * playing now, Restoring… while a click waits for the server, Restore as the hint on a hovered or
 * focused row, else nothing. Checked in that order.
 */
export function restoreStatusText({ isCurrent, isPending, isHot }) {
  if (isCurrent) return HISTORY_COPY.current;
  if (isPending) return HISTORY_COPY.restoring;
  if (isHot) return HISTORY_COPY.restore;
  return '';
}

/**
 * The sentence shown in place of the list: loading, the load error, or the empty state; null
 * when the list itself is to be shown.
 */
export function historyMessageText(model) {
  if (model.status === 'loading') return HISTORY_COPY.loading;
  if (model.status === 'error') return HISTORY_COPY.loadError;
  if (model.versions.length === 0) return HISTORY_COPY.empty;
  return null;
}

/**
 * The label shown in a row: a restored entry says where it came from in the page's own words
 * ("Restored from v12"; the stored "restored from #12" uses a hash the page never shows), else
 * the stored label, else nothing.
 */
export function rowLabelText(version) {
  if (Number.isInteger(version.restoredFrom) && version.restoredFrom > 0) {
    return `Restored from ${versionText(version.restoredFrom)}`;
  }
  return version.label ?? '';
}

/**
 * Hour and minute of a version's time. `locale` undefined means the browser's locale;
 * `timeZone` exists so tests do not depend on the machine's zone.
 */
export function formatRowTime(at, { locale, timeZone } = {}) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(at));
}

/**
 * Day and time of a session start, as the divider says it: "New session · Sep 28, 2026, 02:02 PM".
 * `locale` undefined means the browser's locale; `timeZone` exists so tests do not depend on the
 * machine's zone.
 */
export function formatDividerText(at, { locale, timeZone } = {}) {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(at));
  return `New session · ${date}, ${formatRowTime(at, { locale, timeZone })}`;
}

/**
 * The session start to draw directly below row `index`, or null. A version carries the time of the
 * session start that sits just before it in the file, so its divider goes below it (the list is
 * newest first). A divider is drawn only between two versions: the very first version of the file
 * has nothing older, and the last loaded row has an older version only when `beyond` is set.
 */
export function sessionDividerAfter(model, index) {
  const version = model.versions[index];
  if (!version || version.sessionStart === undefined) return null;
  const hasOlder = index + 1 < model.versions.length || model.beyond !== null;
  return hasOlder ? version.sessionStart : null;
}

/**
 * Where the list must scroll to after rows were inserted above what the user is reading, so the
 * rows on screen stay exactly where they were: the inserted height is added to the scroll
 * position. At the top (scrollTop 0) the list simply grows downward and stays at 0.
 */
export function scrollTopAfterInsert({ scrollTop, heightBefore, heightAfter }) {
  if (scrollTop <= 0) return scrollTop;
  return scrollTop + (heightAfter - heightBefore);
}

// Row ids whose malformed parent was already reported, so a redraw never repeats the report.
const reportedBadParents = new Set();

/**
 * The parent the tree may draw for a row, or null (a root). Only a positive whole number older than
 * the row counts; anything else is a root, and a parent that is not older than its row is reported
 * once per row id (the server's reader rejects such a line, so seeing one here is a bug worth a loud
 * line, not a guess).
 */
function usableParent(row) {
  const { id, parent } = row;
  if (parent === undefined || parent === null) return null;
  if (Number.isInteger(parent) && parent >= 1 && parent < id) return parent;
  if (!reportedBadParents.has(id)) {
    reportedBadParents.add(id);
    console.error(`Moontide: version ${id} has a parent that is not older than it; drawn as a root.`);
  }
  return null;
}

/**
 * The branch lanes of the loaded rows, given newest first as `{ id, parent }` (parent undefined for
 * a root). One pass, top down, over the parent the server sent; nothing is ever guessed. Each open
 * column waits for one parent id: a row takes the leftmost column waiting for its id, else the
 * lowest free column, else a new one; every other column waiting for the same id ends on this row
 * (a fork point, drawn as an elbow) and is freed. The row's column then waits for its own parent, or
 * is freed for a root. Returns `{ rows, maxLanes }` where each row is `{ id, column, lineAbove,
 * lineBelow, ends, through, lanesAfter }`: `lineAbove` a line arrives from above in its column,
 * `lineBelow` a line leaves below it, `ends` the columns that end on it, `through` the other columns
 * whose line runs straight past it, `lanesAfter` which columns still wait after it (a session divider
 * right below it draws those). `maxLanes` is the most columns in use on any row, at least 1.
 */
export function computeLanes(rows) {
  const waiting = [];
  const out = [];
  let maxLanes = 1;
  for (const row of rows) {
    const before = waiting.slice();
    let column = waiting.indexOf(row.id);
    if (column === -1) {
      column = waiting.indexOf(null);
      if (column === -1) column = waiting.length;
    }
    const ends = [];
    waiting.forEach((waitsFor, c) => {
      if (waitsFor === row.id && c !== column) {
        ends.push(c);
        waiting[c] = null;
      }
    });
    const parent = usableParent(row);
    waiting[column] = parent;
    const through = [];
    waiting.forEach((waitsFor, c) => {
      if (waitsFor !== null && c !== column && before[c] === waitsFor) through.push(c);
    });
    const lanesAfter = waiting.map((waitsFor) => waitsFor !== null);
    const lastWaiting = lanesAfter.lastIndexOf(true);
    maxLanes = Math.max(maxLanes, column + 1, lastWaiting + 1, ...ends.map((c) => c + 1));
    out.push({ id: row.id, column, lineAbove: before[column] === row.id, lineBelow: parent !== null, ends, through, lanesAfter });
  }
  return { rows: out, maxLanes };
}

/**
 * How wide the graph column is: one lane per 1rem up to eight lanes,
 * then the pitch shrinks to 8rem / lanes so the gutter stays at 8rem, never below 0.25rem a lane.
 */
export function laneGeometry(maxLanes) {
  const lanes = Math.max(1, maxLanes);
  const pitchRem = lanes <= 8 ? 1 : Math.max(0.25, 8 / lanes);
  return { pitchRem, widthRem: lanes * pitchRem };
}

/** The color number (1 to 8) of a lane: the column number, cycling back to 1 after eight. */
export function branchColor(column) {
  return (column % 8) + 1;
}

/** The model before the server has answered: nothing loaded yet. */
export function emptyHistoryModel() {
  return { status: 'loading', versions: [], beyond: null, total: 0, remaining: 0 };
}

/**
 * Applies one server history message and returns the new model (never mutates the old one).
 * 'history' is the newest window; 'history-error' marks the list as unreadable; 'history-older-error'
 * (an older batch that could not be read) leaves the model as it is; 'history-add'
 * puts the newly recorded version first, or replaces the entry when its id is already present;
 * 'history-older' appends the next older batch below the loaded rows (returning the same model
 * when the batch does not continue them); 'history-favorite' names one loaded version.
 * Any other type throws (a loud error, not a silent skip).
 */
export function applyHistoryMessage(model, msg) {
  if (msg.type === 'history-error') {
    return { ...model, status: 'error' };
  }
  if (msg.type === 'history-older-error') {
    // A failed read of older versions: the rows already loaded stay exactly as they are.
    return model;
  }
  if (msg.type === 'history') {
    return {
      status: 'ready',
      versions: msg.versions,
      beyond: msg.beyond,
      total: msg.total,
      remaining: msg.remaining,
    };
  }
  if (msg.type === 'history-older') {
    // Only the batch that starts right below the oldest loaded row is appended: the version just
    // older than that row is the model's `beyond`. Anything else is an answer to a list the page
    // no longer holds (a fresh window replaced it), and appending it would leave a gap.
    if (!model.beyond || msg.versions.length === 0 || msg.versions[0].id !== model.beyond.id) return model;
    const loaded = new Set(model.versions.map((version) => version.id));
    const fresh = msg.versions.filter((version) => {
      if (loaded.has(version.id)) return false;
      loaded.add(version.id);
      return true;
    });
    return { ...model, versions: [...model.versions, ...fresh], beyond: msg.beyond, remaining: msg.remaining };
  }
  if (msg.type === 'history-favorite') {
    // Names a loaded version (a rename replaces the name). A version that is not loaded is
    // simply not on screen: it arrives with its favorite name when it is loaded.
    if (!model.versions.some((version) => version.id === msg.id)) return model;
    return {
      ...model,
      versions: model.versions.map((version) => (version.id === msg.id ? { ...version, favorite: msg.name } : version)),
    };
  }
  if (msg.type === 'history-add') {
    const index = model.versions.findIndex((version) => version.id === msg.version.id);
    const versions =
      index === -1
        ? [msg.version, ...model.versions]
        : model.versions.map((version, i) => (i === index ? msg.version : version));
    return { ...model, versions, total: msg.total };
  }
  throw new Error(`Moontide: applyHistoryMessage cannot handle a '${msg.type}' message`);
}

/**
 * The most line pairs (old lines x new lines, after the common prefix and suffix are trimmed)
 * the line diff will compute. Above it the diff is refused, so a huge paste can never freeze
 * the page.
 */
export const MAX_DIFF_CELLS = 4_000_000;

function normalizeNewlines(code) {
  return code.replace(/\r\n/g, '\n');
}

/**
 * The line diff of two codes as ordered ops `{ type: 'ctx' | 'del' | 'add', text }`, a deletion
 * before the addition that replaces it. `oldCode` null means there is no previous version, so
 * every line is an addition. CRLF is read as LF. Returns null when the changed middle is too
 * large to compare (see MAX_DIFF_CELLS). A small LCS over the lines between the common prefix
 * and the common suffix.
 */
export function diffLines(oldCode, newCode) {
  const newLines = normalizeNewlines(newCode).split('\n');
  if (oldCode === null) return newLines.map((text) => ({ type: 'add', text }));
  const oldLines = normalizeNewlines(oldCode).split('\n');

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const n = oldMid.length;
  const m = newMid.length;
  if (n * m > MAX_DIFF_CELLS) return null;

  // table[i * width + j] is the length of the longest common subsequence of oldMid[i..] and
  // newMid[j..]. Uint16 is enough: it is at most min(n, m), and n * m is capped.
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldMid[i] === newMid[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const ops = [];
  for (let k = 0; k < prefix; k += 1) ops.push({ type: 'ctx', text: oldLines[k] });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldMid[i] === newMid[j]) {
      ops.push({ type: 'ctx', text: oldMid[i] });
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      ops.push({ type: 'del', text: oldMid[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: newMid[j] });
      j += 1;
    }
  }
  for (let k = oldLines.length - suffix; k < oldLines.length; k += 1) ops.push({ type: 'ctx', text: oldLines[k] });
  return ops;
}

/** How many lines were added and removed in a diff (null ops, too large to compare, count as null). */
export function countChanges(ops) {
  if (ops === null) return null;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    if (op.type === 'del') removed += 1;
  }
  return { added, removed };
}

/**
 * The version a row is compared against: the next older row, else the window's `beyond` version
 * for the oldest loaded row, else null (nothing older on disk: a first version).
 */
export function previousVersionOf(model, index) {
  const older = model.versions[index + 1];
  if (older) return { id: older.id, code: older.code };
  if (model.beyond) return { id: model.beyond.id, code: model.beyond.code };
  return null;
}

/** Tracks of one code through the cache: { tracks } or { failed: true }, parsed once per distinct code. */
function tracksOf(code, parse, cache) {
  const cached = cache ? cache.get(code) : undefined;
  if (cached) return cached;
  let result;
  try {
    result = { tracks: extractTracks(code, { parse }) };
  } catch (err) {
    // A parse failure is expected on old or invalid code; anything else is a bug in the track
    // extraction and must be seen once (the result is cached, so it is not logged again).
    if (!(err instanceof SyntaxError)) console.error('Moontide: could not read the tracks of a version:', err);
    result = { failed: true };
  }
  if (cache) cache.set(code, result);
  return result;
}

/**
 * One line saying what changed between two codes, by track, in the names the Timeline uses
 * (tracks match by identity; a name is shown without the mixer's solo marker and the mute underscore): "drums changed, claps added". Order: changed (newer
 * order), added (newer order), removed (older order). A missing or throwing parse says "Code
 * changed" instead of guessing; a change outside every track says "other lines changed".
 * `cache` is an optional Map so each distinct code is parsed once.
 */
export function summarizeChange(olderCode, newerCode, { parse, cache } = {}) {
  if (olderCode === null) return HISTORY_COPY.firstVersion;
  const older = normalizeNewlines(olderCode);
  const newer = normalizeNewlines(newerCode);
  if (older === newer) return HISTORY_COPY.noChange;
  if (typeof parse !== 'function') return HISTORY_COPY.codeChanged;

  const olderResult = tracksOf(older, parse, cache);
  const newerResult = tracksOf(newer, parse, cache);
  if (olderResult.failed || newerResult.failed) return HISTORY_COPY.codeChanged;

  const olderByIdentity = new Map(olderResult.tracks.map((track) => [track.identity, track]));
  const newerIdentities = new Set(newerResult.tracks.map((track) => track.identity));
  const changed = [];
  const added = [];
  for (const track of newerResult.tracks) {
    const before = olderByIdentity.get(track.identity);
    // A mute or a solo changes only the label, so a different label counts as a change too.
    if (!before) {
      added.push(`${track.displayName ?? track.name} added`);
    } else if (older.slice(before.start, before.end) !== newer.slice(track.start, track.end) || before.label !== track.label) {
      changed.push(`${track.displayName ?? track.name} changed`);
    }
  }
  const removed = olderResult.tracks
    .filter((track) => !newerIdentities.has(track.identity))
    .map((track) => `${track.displayName ?? track.name} removed`);

  const entries = [...changed, ...added, ...removed];
  if (entries.length === 0) return HISTORY_COPY.otherLinesChanged;
  if (entries.length <= 3) return entries.join(', ');
  return `${entries.slice(0, 3).join(', ')}, +${entries.length - 3} more`;
}

/**
 * Folds a diff for reading: keeps `context` unchanged lines on each side of every change and
 * replaces each longer unchanged run with `{ type: 'gap', count }`. A leading or trailing run
 * keeps only the lines next to the change. A diff with no change folds to [].
 */
export function foldDiff(ops, context = 2) {
  const keep = new Array(ops.length).fill(false);
  let anyChange = false;
  ops.forEach((op, index) => {
    if (op.type === 'ctx') return;
    anyChange = true;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });
  if (!anyChange) return [];

  const folded = [];
  let hidden = 0;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (hidden > 0) folded.push({ type: 'gap', count: hidden });
      hidden = 0;
      folded.push(op);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) folded.push({ type: 'gap', count: hidden });
  return folded;
}

/** The text of a folded stretch: "1 unchanged line", "6 unchanged lines". */
export function unchangedLinesText(count) {
  return count === 1 ? '1 unchanged line' : `${count} unchanged lines`;
}

/** The diff view's sentence when the two codes are identical. */
export function noChangesText(previousId) {
  return `No changes against ${versionText(previousId)}.`;
}

/** The diff view's header: "v12 against v11", or "v1 · first version" with nothing older. */
export function diffHeaderText(id, previousId) {
  if (previousId === null) return `${versionText(id)} · first version`;
  return `${versionText(id)} against ${versionText(previousId)}`;
}

/**
 * The keyboard decision of the History view for one keydown. `focusKind` says where the cursor is:
 * 'editor', 'body' (nothing focused), 'history-main' (a row's restore button), 'history-toggle',
 * 'history-more' or 'other-control' (Stop, the motion switch, the List / Tree switch, ...).
 * `selectionKind` is 'row', 'more' or 'none'. Returns `{ action, preventDefault }`, action being
 * 'up', 'down', 'restore', 'toggle', 'loadMore' or 'none'. Only arrows, Enter and Space count, only
 * with the view open and no modifier held, and never while the cursor is in the code editor or on
 * another control (Enter there only presses that control).
 */
export function historyKeyAction({ key, viewOpen, focusKind, repeat, selectionKind, ctrlKey, metaKey, altKey }) {
  const none = { action: 'none', preventDefault: false };
  if (ctrlKey || metaKey || altKey || !viewOpen) return none;
  if (focusKind === 'editor' || focusKind === 'other-control') return none;
  if (key === 'ArrowUp') return { action: 'up', preventDefault: true };
  if (key === 'ArrowDown') return { action: 'down', preventDefault: true };
  if (key !== 'Enter' && key !== ' ') return none;
  // A held key never acts twice, and never fires a native button click either.
  if (repeat) return { action: 'none', preventDefault: true };
  const onList = focusKind === 'body' || focusKind === 'history-main';
  if (key === 'Enter') {
    if (!onList) return none;
    if (selectionKind === 'row') return { action: 'restore', preventDefault: true };
    if (selectionKind === 'more') return { action: 'loadMore', preventDefault: true };
    return none;
  }
  // Space: on the list it opens or closes the selected diff. On a row's restore button the native
  // click must not also restore, so its default is prevented even when nothing else happens.
  if (!onList) return none;
  if (selectionKind === 'row') return { action: 'toggle', preventDefault: true };
  return { action: 'none', preventDefault: focusKind === 'history-main' };
}

/**
 * Moves the History selection one step. `ids` are the loaded version ids, newest first (dividers
 * are never in the list); `selected` is an id, 'more' or null; `direction` is 'up' (newer) or
 * 'down' (older). Down from the last id reaches 'more' only when `hasMore`; up from 'more' returns
 * to the last id; the ends stay where they are; nothing selected goes to the first id.
 */
export function moveSelection({ ids, hasMore, selected, direction }) {
  if (ids.length === 0) return hasMore && selected === 'more' ? 'more' : null;
  if (selected === 'more') {
    return direction === 'up' ? ids[ids.length - 1] : 'more';
  }
  const index = selected === null ? -1 : ids.indexOf(selected);
  if (index === -1) return ids[0];
  if (direction === 'up') return ids[Math.max(0, index - 1)];
  if (index === ids.length - 1) return hasMore ? 'more' : ids[index];
  return ids[index + 1];
}
