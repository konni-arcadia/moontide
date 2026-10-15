// Pure module for Moontide's browser page: what the Song grid shows for a song the page has read. It turns the reading
// of page/structure.js into columns (one per section entry, in play order), rows (groups with their fold state, tracks
// with one cell per section, statements outside the song plan), the live state of each section header, the playing
// section and the keyboard moves between the controls. It has no DOM access at import time and no state, so
// node:test and page/main.js import it without a build step; page/song-grid-view.js draws what it returns.

import { readHarmonyText } from './harmony.js';
import { arrangementPosition } from './parts.js';
import {
  SONG_COPY,
  SONG_REFUSALS,
  countText,
  displayHarmony,
  displayName,
  cleanText,
  fillSong,
  harmonyParts,
  quoted,
  summaryText,
} from './structure.js';

/** From this nesting level on (the top level is 1), a group's indent stops growing, so a deep tree keeps room for names. */
export const SONG_GRID_DEEP_FROM = 5;

/** The launch choices of the toolbar, by value. */
const IDLE_TITLES = { section: SONG_COPY.idleTitleSection, phrase: SONG_COPY.idleTitlePhrase, bar: SONG_COPY.idleTitleBar };

/** The three launch choices of the toolbar in order: `{ value, label, name }`, the visible words and the accessible name. */
export function launchOptions() {
  return [
    { value: 'section', label: SONG_COPY.launchSection, name: SONG_COPY.launchSectionName },
    { value: 'phrase', label: SONG_COPY.launchPhrase, name: SONG_COPY.launchPhraseName },
    { value: 'bar', label: SONG_COPY.launchBar, name: SONG_COPY.launchBarName },
  ];
}

/** The key of a group: the names from the root down, as JSON text. */
export function groupKey(path) {
  return JSON.stringify(path);
}

/** The words a cell shows while its change waits for the line it takes over on, by the timing the person set. */
const WAIT_TEXTS = { bar: SONG_COPY.waitBar, phrase: SONG_COPY.waitPhrase };

/** The cell of one track in one section as the grid shows it: its text, its title and whether its section is shared. */
function cellModel(track, cell, section, shared, fit = null) {
  const values = { track: quoted(track.name), section: quoted(section.name) };
  // What the fit query found for a fixed variation in this section, once it has answered.
  const found = cell.kind === 'fixed' && fit !== null ? fit(track.name, cell.section, cell.key) : null;
  let title;
  if (cell.kind === 'rest') title = fillSong(SONG_COPY.cellTitleRest, values);
  else if (cell.kind === 'degrees') title = fillSong(SONG_COPY.cellTitleDegrees, { ...values, variation: quoted(cell.key) });
  else if (cell.kind === 'fixed') {
    title = found !== null ? found.title : fillSong(SONG_COPY.cellTitleFixed, { ...values, variation: quoted(cell.key), harmony: displayHarmony(cell.fixedHarmony) });
  } else title = fillSong(SONG_COPY.cellTitle, { ...values, variation: quoted(cell.key) });
  return {
    section: cell.section,
    key: cell.key,
    kind: cell.kind,
    text: cell.kind === 'rest' ? SONG_COPY.cellRest : displayName(cell.key),
    title,
    shared,
    wait: null,
    fit: found === null ? null : { state: found.state, line: found.line, outside: found.outsideText },
  };
}

/**
 * The cell as it is while the person's own change to it waits for its line: the name that was chosen, with the words that
 * say it is not playing yet. `choice` is `{ key }` or `{ rest: true }`.
 */
function waitingCellModel(track, cell, section, shared, waiting) {
  let chosen;
  if (waiting.choice.rest === true) chosen = { section: cell.section, key: null, kind: 'rest', fixedHarmony: null };
  else {
    const variation = track.variations.find((candidate) => candidate.key === waiting.choice.key);
    if (variation === undefined) throw new Error(`Moontide: the waiting change names variation '${String(waiting.choice.key)}', which track '${track.name}' does not have.`);
    chosen = { section: cell.section, key: variation.key, kind: variation.kind, fixedHarmony: variation.fixedHarmony };
  }
  return { ...cellModel(track, chosen, section, shared), wait: WAIT_TEXTS[waiting.at] };
}

/** The title of a shown name when the shown text is not the whole of it, else null. */
function wholeName(name) {
  const whole = cleanText(name);
  return displayName(name) === whole ? null : whole;
}

/** One column per section entry: its name, length, harmony and how many entries share its name. */
function buildColumns(reading) {
  const columnsOf = new Map();
  reading.sections.forEach((section, index) => {
    const list = columnsOf.get(section.name) ?? [];
    list.push(index);
    columnsOf.set(section.name, list);
  });
  return reading.sections.map((section, index) => {
    const harmony = harmonyParts(section.harmony);
    const useColumns = columnsOf.get(section.name);
    const uses = useColumns.length;
    return {
      index,
      name: section.name,
      length: section.length,
      text: displayName(section.name),
      title: wholeName(section.name),
      lengthText: countText(section.length, SONG_COPY.cycleOne, SONG_COPY.cycleMany),
      harmonyText: harmony.text,
      harmonyTitle: harmony.whole ?? harmony.text,
      uses,
      useColumns,
      usedText: uses > 1 ? fillSong(SONG_COPY.usedTimes, { n: uses }) : null,
      usedTitle: uses > 1 ? fillSong(SONG_COPY.usedTitle, { n: uses, columns: useColumns.map((i) => i + 1).join(', ') }) : null,
    };
  });
}

/**
 * The groups and the tracks inside them in display order, walked without recursion: each entry has its depth and `hidden`
 * (true below a folded group, whatever its own fold state), and `counts` holds, by group key, every track below the group
 * at any depth.
 */
function walkGroups(reading, folds) {
  const list = [];
  const counts = new Map();
  const stack = [{ items: reading.groups.map((group) => ({ group })), index: 0, path: [], key: null, hidden: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length) {
      stack.pop();
      continue;
    }
    const item = frame.items[frame.index];
    frame.index += 1;
    if (item.track !== undefined) {
      list.push({ kind: 'track', name: item.track, depth: frame.path.length, hidden: frame.hidden });
      // Every group on the way up has one more track below it.
      for (let i = 1; i < stack.length; i++) counts.set(stack[i].key, counts.get(stack[i].key) + 1);
      continue;
    }
    const path = [...frame.path, item.group.name];
    const key = groupKey(path);
    const open = !folds.has(key);
    list.push({ kind: 'group', name: item.group.name, path, key, open, depth: frame.path.length, hidden: frame.hidden });
    counts.set(key, 0);
    stack.push({ items: item.group.items, index: 0, path, key, hidden: frame.hidden || !open });
  }
  return { list, counts };
}

/**
 * The grid for a read song. `folds` is a Set of group keys that are folded, `launchChoice` one of 'section', 'phrase',
 * 'bar'. `fit` is null while the fit query has not answered (a fixed variation then shows no fit words), else the lookup of
 * page/song-fit.js, `(track, sectionIndex, key) => fit or null`. Returns `{ title, corner, columns, rows, sections,
 * launchChoice, listFor }`:
 * - `columns[i]`: `{ index, name, length, text, title, lengthText, harmonyText, harmonyTitle, uses, useColumns, usedText,
 *   usedTitle }` for the i-th section entry in code order;
 * - a fixed cell is `{ section, key, kind, text, title, shared, wait, fit }` where `fit` is null until the answer is in, else
 *   `{ state, line, outside }` with `state` 'fits', 'does-not-fit' or 'cannot-check', the words of the second line and the
 *   outside notes joined by ', ' (null unless they do not fit); the cell's title then holds the whole fit text;
 * - `cellWaiting` is `{ track, section, choice, at }` for a change of the person's own to a cell that waits for its line, or
 *   null: `section` is the section's name, so every column of that name shows the chosen name and the waiting words, and `at`
 *   is 'bar' or 'phrase';
 * - `rows`, in display order: group rows `{ kind: 'group', key, path, name, text, title, count, countText, depth, level, open,
 *   hidden }`, track rows `{ kind: 'track', key, name, text, title, trackIndex, depth, level, hidden, cells }` and rows of
 *   statements the plan does not build `{ kind: 'outside', key, name, text, title, note, depth, level, hidden }`. A row
 *   below a folded group is hidden whatever its own fold state; the keys are stable ('g:' + group key, 't:' + track name,
 *   'o:' + statement index).
 */
export function buildSongGrid({ reading, folds, launchChoice, cellWaiting = null, fit = null }) {
  if (reading === null || typeof reading !== 'object' || reading.state !== 'read') {
    throw new Error('Moontide: buildSongGrid needs a read song.');
  }
  if (!Object.hasOwn(IDLE_TITLES, launchChoice)) throw new Error(`Moontide: unknown launch choice '${String(launchChoice)}'.`);
  if (cellWaiting !== null && !Object.hasOwn(WAIT_TEXTS, cellWaiting.at)) {
    throw new Error(`Moontide: a change waits on 'bar' or 'phrase', not '${String(cellWaiting.at)}'.`);
  }
  const columns = buildColumns(reading);
  const byName = new Map(reading.tracks.map((track, trackIndex) => [track.name, { track, trackIndex }]));
  const trackRow = (name, depth, hidden) => {
    const { track, trackIndex } = byName.get(name);
    return {
      kind: 'track',
      key: `t:${name}`,
      name,
      text: displayName(name),
      title: wholeName(name),
      trackIndex,
      depth,
      level: depth + 1,
      hidden,
      cells: track.cells.map((cell) => {
        const section = reading.sections[cell.section];
        const shared = columns[cell.section].uses > 1;
        const waits = cellWaiting !== null && cellWaiting.track === name && cellWaiting.section === section.name;
        return waits ? waitingCellModel(track, cell, section, shared, cellWaiting) : cellModel(track, cell, section, shared, fit);
      }),
    };
  };

  const { list, counts } = walkGroups(reading, folds);
  const rows = [];
  for (const entry of list) {
    if (entry.kind === 'track') {
      rows.push(trackRow(entry.name, entry.depth, entry.hidden));
      continue;
    }
    const count = counts.get(entry.key);
    rows.push({
      kind: 'group',
      key: `g:${entry.key}`,
      groupKey: entry.key,
      path: entry.path,
      name: entry.name,
      text: displayName(entry.name),
      title: wholeName(entry.name),
      foldTitle: fillSong(entry.open ? SONG_COPY.foldTitle : SONG_COPY.openTitle, { group: quoted(entry.name) }),
      count,
      countText: countText(count, SONG_COPY.trackOne, SONG_COPY.trackMany),
      depth: entry.depth,
      level: entry.depth + 1,
      open: entry.open,
      hidden: entry.hidden,
    });
  }
  for (const entry of reading.ungrouped) {
    if (entry.structured) rows.push(trackRow(entry.name, 0, false));
    else {
      rows.push({
        kind: 'outside',
        key: `o:${entry.index}`,
        name: entry.name,
        text: displayName(entry.name),
        title: wholeName(entry.name),
        note: SONG_COPY.outside,
        depth: 0,
        level: 1,
        hidden: false,
      });
    }
  }
  return {
    title: SONG_COPY.viewTitle,
    corner: summaryText(reading),
    columns,
    rows,
    sections: reading.sections,
    launchChoice,
    // The list that opens on a cell, built when it is asked for and from the very reading this grid was drawn from.
    listFor: (trackName, sectionIndex) => cellList({ reading, trackName, sectionIndex, fit }),
  };
}

/**
 * The muted words after a variation's name in the list: `follows the harmony` for a degree variation, for a fixed one the
 * fit words for the section being edited (nothing while the fit query has not answered), nothing for a plain one.
 */
function optionNote(variation, trackName, sectionIndex, fit) {
  if (variation.kind === 'degrees') return SONG_COPY.cellFollows;
  if (variation.kind !== 'fixed' || fit === null) return null;
  const found = fit(trackName, sectionIndex, variation.key);
  return found === null ? null : found.line;
}

/**
 * What the list that opens on a cell shows: `{ label, note, currentText, options }`. `label` is the accessible name, `note`
 * the line that says the change applies to every use of a section that is used more than once (else null), and `options` the
 * track's variations in code order, used or not, then `rest`: `{ id, key, rest, text, title, note, current }` with `key` null
 * for the rest, `note` the muted words after the name (`follows the harmony` for a degree variation, the fit words for the
 * section being edited for a fixed one once `fit` has answered) and `current` true for what the cell holds. The reading must have the track and the section.
 */
export function cellList({ reading, trackName, sectionIndex, fit = null }) {
  const track = reading.tracks.find((candidate) => candidate.name === trackName);
  const section = reading.sections[sectionIndex];
  const cell = track === undefined ? undefined : track.cells.find((candidate) => candidate.section === sectionIndex);
  if (track === undefined || section === undefined || cell === undefined) {
    throw new Error(`Moontide: the song has no cell for track '${String(trackName)}' in section ${String(sectionIndex)}.`);
  }
  const options = track.variations.map((variation, i) => ({
    id: `song-option-${i}`,
    key: variation.key,
    rest: false,
    text: displayName(variation.key),
    title: wholeName(variation.key),
    note: optionNote(variation, trackName, sectionIndex, fit),
    current: cell.key === variation.key,
  }));
  options.push({ id: `song-option-${options.length}`, key: null, rest: true, text: SONG_COPY.cellRest, title: null, note: null, current: cell.kind === 'rest' });
  const uses = reading.sections.filter((candidate) => candidate.name === section.name).length;
  return {
    label: fillSong(SONG_COPY.listLabel, { track: quoted(trackName), section: quoted(section.name) }),
    note: uses > 1 ? fillSong(SONG_COPY.listShared, { section: quoted(section.name), n: uses }) : null,
    currentText: SONG_COPY.listCurrent,
    options,
  };
}

/**
 * Where the list that opens on a cell goes, in the pixels of the viewport: `cell` is the cell's `{ left, top, bottom }`,
 * `size` the list's `{ width, height }` as it would be drawn, `viewport` its `{ width, height }`. The list opens below the
 * cell, above it when the room below is too short for it and the room above is not, and when neither holds it all it takes
 * the larger side with a `maxHeight` of that room, so it scrolls inside itself. It never leaves the viewport. Returns
 * `{ left, top, maxHeight, above }` (`maxHeight` null when the list keeps its own height).
 */
export function listPlacement({ cell, size, viewport }) {
  const below = viewport.height - cell.bottom;
  const above = cell.top;
  let top;
  let maxHeight = null;
  let isAbove = false;
  if (size.height <= below) top = cell.bottom;
  else if (size.height <= above) {
    top = cell.top - size.height;
    isAbove = true;
  } else if (below >= above) {
    maxHeight = Math.max(0, below);
    top = cell.bottom;
  } else {
    maxHeight = Math.max(0, above);
    top = cell.top - maxHeight;
    isAbove = true;
  }
  const height = maxHeight === null ? size.height : maxHeight;
  top = Math.max(0, Math.min(top, viewport.height - height));
  const left = Math.max(0, Math.min(cell.left, viewport.width - size.width));
  return { left, top, maxHeight, above: isAbove };
}

/** The history label of a cell change: `changed bass in verse: vb`, or `: rest`. `choice` is `{ key }` or `{ rest: true }`. */
export function cellRecordLabel({ track, section, choice }) {
  const chosen = choice.rest === true ? SONG_COPY.cellRest : displayName(choice.key);
  return fillSong(SONG_COPY.cellRecord, { track: displayName(track), section: displayName(section), choice: chosen });
}

/**
 * The section that plays at `cycle`: `{ index, cycleIn, progress }`. The position is the cycle within the structure
 * (arrangementPosition with the shift and the total); each section covers [start, start + length) of the unshifted
 * structure, so on a section line the section that starts there plays. `cycleIn` counts from 1; `progress` is the
 * fraction of the section behind.
 */
export function playingSection(reading, cycle) {
  const position = arrangementPosition(cycle, reading.shift, reading.total);
  let start = 0;
  for (let index = 0; index < reading.sections.length; index++) {
    const { length } = reading.sections[index];
    if (position >= start && position < start + length) {
      return { index, cycleIn: Math.floor(position - start) + 1, progress: (position - start) / length };
    }
    start += length;
  }
  // Floating-point rounding at the very end of the structure: the last section plays.
  const last = reading.sections.length - 1;
  return { index: last, cycleIn: reading.sections[last].length, progress: 1 };
}

/**
 * The harmony the Jam view's Declared line shows while `section` (an entry of a read song) plays, in the shape of a
 * reading's `declared`: the section's own text or the piece's, `{ state: 'none' }` when neither is declared, and for a
 * piece harmony the page cannot read `pieceDeclared`, the reading of the piece's harmony, which holds the reason. A
 * harmony text the page cannot read throws (the song reader has refused such text already).
 */
export function sectionDeclared(section, pieceDeclared) {
  const { harmony } = section;
  if (harmony.from === 'none') return { state: 'none' };
  if (harmony.from === 'piece-unreadable') return pieceDeclared;
  const read = readHarmonyText(harmony.text);
  if (read === null) throw new Error(`Moontide: the harmony of section '${String(section.name)}' cannot be read for the Jam view.`);
  return { state: 'declared', ...read, text: harmony.text };
}

/**
 * What one section header shows: `{ state, stateText, action, title, progress }`. `playing` is the playingSection result
 * (or null); `stopped` is true while the page makes no sound, and then every header is idle. `motion` 'off' steps the
 * progress to whole cycles. `action` is the visible word after the state ('' when the section plays). `queued` is
 * `{ index, countdownText, line }` for the section a launch waits for, or null: that header says `Queued — {countdown}`
 * with the word Cancel, whatever else it was (a launch of the section that plays is queued too), and carries the `line`
 * the launch takes over on.
 */
export function headerLive({ column, playing, stopped, launchChoice, motion, queued = null }) {
  if (!Object.hasOwn(IDLE_TITLES, launchChoice)) throw new Error(`Moontide: unknown launch choice '${String(launchChoice)}'.`);
  if (queued !== null && queued.index === column.index) {
    return {
      state: 'queued',
      stateText: fillSong(SONG_COPY.queuedState, { countdown: queued.countdownText }),
      action: SONG_COPY.cancelWord,
      title: SONG_COPY.queuedTitle,
      progress: 0,
      line: queued.line,
    };
  }
  if (!stopped && playing !== null && playing !== undefined && playing.index === column.index) {
    const values = { n: playing.cycleIn, length: column.length };
    const raw = motion === 'off' ? Math.floor(playing.progress * column.length) / column.length : playing.progress;
    return {
      state: 'playing',
      stateText: fillSong(SONG_COPY.playingState, values),
      action: '',
      title: fillSong(SONG_COPY.playingTitle, values),
      progress: Math.max(0, Math.min(1, raw)),
    };
  }
  return {
    state: 'idle',
    stateText: column.lengthText,
    action: SONG_COPY.launchWord,
    title: stopped ? SONG_COPY.stoppedTitle : IDLE_TITLES[launchChoice],
    progress: 0,
  };
}

/** The sentence under the toolbar while a section plays: `Playing section 'y', cycle 3 of 8.`, or null when none does. */
export function nowText(reading, playing) {
  if (playing === null || playing === undefined) return null;
  const section = reading.sections[playing.index];
  return fillSong(SONG_COPY.now, { section: quoted(section.name), n: playing.cycleIn, length: section.length });
}

/**
 * The one sentence under the toolbar, as `{ kind, text }`, or null when there is nothing to say. The first of these that
 * applies is shown, in this order: `disconnected` (the socket is closed), `queued` (a launch of the person's own waits,
 * `launch` is `{ kind: 'queued', section }`), `already` (a launch that needs no code change, `launch` is
 * `{ kind: 'already', section }`), `waiting` (another change waits for its line), `dirty` (the editor holds text that was
 * never evaluated) and `refused` (a gesture was refused, `refused` is the reason id of SONG_COPY.refusals). A reason id
 * the copy does not know throws, whatever else applies.
 */
export function songLine({ connected, launch = null, waiting = false, dirty = false, refused = null }) {
  if (refused !== null && refused !== undefined && !SONG_REFUSALS.includes(refused)) {
    throw new Error(`Moontide: unknown song refusal '${String(refused)}' (expected one of ${SONG_REFUSALS.join(', ')}).`);
  }
  if (launch !== null && launch !== undefined && launch.kind !== 'queued' && launch.kind !== 'already') {
    throw new Error(`Moontide: unknown launch line '${String(launch.kind)}' (expected queued or already).`);
  }
  if (!connected) return { kind: 'disconnected', text: SONG_COPY.lineDisconnected };
  if (launch !== null && launch !== undefined) {
    const template = launch.kind === 'queued' ? SONG_COPY.lineQueued : SONG_COPY.lineAlready;
    return { kind: launch.kind, text: fillSong(template, { section: quoted(launch.section) }) };
  }
  if (waiting) return { kind: 'waiting', text: SONG_COPY.lineWaiting };
  if (dirty) return { kind: 'dirty', text: SONG_COPY.lineDirty };
  if (refused !== null && refused !== undefined) return { kind: 'refused', text: SONG_COPY.refusals[refused] };
  return null;
}

/**
 * Which controls the line switches off: `{ headers, cells }`, true meaning aria-disabled. Off: `disconnected`, `waiting` and
 * `dirty` switch off both; `queued` switches off the cells only (the headers stay usable to cancel or to replace the launch);
 * `already` and `refused` switch off nothing. No line (null) switches off nothing; any other kind throws.
 */
export function controlsDisabled(kind) {
  if (kind === null || kind === undefined) return { headers: false, cells: false };
  const off = { disconnected: [true, true], queued: [false, true], already: [false, false], waiting: [true, true], dirty: [true, true], refused: [false, false] };
  if (!Object.hasOwn(off, kind)) throw new Error(`Moontide: unknown song line kind '${String(kind)}'.`);
  return { headers: off[kind][0], cells: off[kind][1] };
}

/**
 * The control a key moves to: `{ row, column }` or null. `layout` lists the visible rows, each the sorted columns that
 * hold a control (column 0 is the name column, 1..N the sections; a row without a control is an empty list and is
 * skipped); `from` is the `{ row, column }` of the focused control. Left and Right stay in the row, Up and Down go to the
 * next row with a control, at the same column or the nearest one (a row is entered at its first control from the name
 * column), Home and End go to the first and last control of the row, Ctrl+Home and Ctrl+End to those of the grid. An
 * edge gives null; any other key gives null.
 */
export function gridMove(layout, from, key, { ctrl = false } = {}) {
  const columns = layout[from.row] ?? [];
  const at = columns.indexOf(from.column);
  if (at < 0) return null;
  const firstRow = layout.findIndex((list) => list.length > 0);
  const lastRow = layout.findLastIndex((list) => list.length > 0);
  if (key === 'ArrowLeft') return at > 0 ? { row: from.row, column: columns[at - 1] } : null;
  if (key === 'ArrowRight') return at < columns.length - 1 ? { row: from.row, column: columns[at + 1] } : null;
  if (key === 'Home' && ctrl) return firstRow < 0 ? null : { row: firstRow, column: layout[firstRow][0] };
  if (key === 'End' && ctrl) return lastRow < 0 ? null : { row: lastRow, column: layout[lastRow].at(-1) };
  if (key === 'Home') return { row: from.row, column: columns[0] };
  if (key === 'End') return { row: from.row, column: columns.at(-1) };
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step = key === 'ArrowUp' ? -1 : 1;
    for (let row = from.row + step; row >= 0 && row < layout.length; row += step) {
      const candidates = layout[row];
      if (candidates.length === 0) continue;
      if (candidates.includes(from.column)) return { row, column: from.column };
      let best = candidates[0];
      for (const column of candidates) {
        if (Math.abs(column - from.column) < Math.abs(best - from.column)) best = column;
      }
      return { row, column: best };
    }
    return null;
  }
  return null;
}
