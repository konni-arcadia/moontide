// Pure module for Moontide's browser page: the line maths and the edits of a section launch from the Song grid. A launch
// reads the scheduler's frontier, computes the line the section must start on (the end of the section that plays, the next
// phrase or the next bar), writes the shift that puts the section on that line into the code and evaluates it, all in one
// turn; the takeover is then pinned to the very line the shift was written for, so the two cannot disagree. This was
// measured in the real page before it was built: the line agreed with the landing in every launch of the page's own path.
// Nothing here touches the DOM or the editor: the functions take a reading of the code (page/structure.js) and give back
// numbers and edit lists, so node:test and page/main.js import them without a build step.

import { boundaryCycle, DEFAULT_PHRASE_CYCLES } from './change-timing.js';
import { launchOffset } from './parts.js';
import { SONG_LAUNCHES } from './views.js';

/** The decimals a shift literal is written with; a fraction needs no more than a cycle split into a thousand million. */
const SHIFT_DECIMALS = 9;

/** Two shifts closer than this give the same position (floating-point noise of a few additions). */
const SHIFT_TOLERANCE = 1e-9;

function finite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Moontide: ${name} must be a finite number, got ${String(value)}.`);
  }
  return value;
}

/**
 * Where every section of the read song starts while its shift is 0, in entry order: the start the reader gives (the shift
 * is already in it) minus the shift. Starts are whole numbers (lengths are whole), so a result within rounding noise of a
 * whole number is that number.
 */
export function unshiftedStarts(reading) {
  return reading.sections.map((section) => {
    const value = section.start - reading.shift;
    const whole = Math.round(value);
    return Math.abs(value - whole) < SHIFT_TOLERANCE ? whole : value;
  });
}

/**
 * The line a launch at the end of the section that plays starts on: the first section start of the shifted structure that
 * is strictly after the scheduler frontier and at least `minLeadSeconds` ahead of it at tempo `cps`. A request in the last
 * half second of a section therefore lands on the end of the next section. `starts` are the unshifted section starts in
 * ascending order and `total` the length of the whole structure; the search covers four passes of the structure and throws
 * when it finds no line, and when an argument is not usable.
 */
export function sectionEndLine({ frontier, cps, shift, total, starts, minLeadSeconds }) {
  finite('the frontier', frontier);
  finite('the shift', shift);
  finite('the minimum lead', minLeadSeconds);
  if (finite('the tempo', cps) <= 0) throw new Error(`Moontide: the tempo must be above 0, got ${String(cps)}.`);
  if (finite('the length of the structure', total) <= 0) throw new Error(`Moontide: the length of the structure must be above 0, got ${String(total)}.`);
  if (!Array.isArray(starts) || starts.length === 0) throw new Error('Moontide: a section line needs the starts of the sections.');
  starts.forEach((start, i) => {
    finite('a section start', start);
    if (i > 0 && start <= starts[i - 1]) throw new Error('Moontide: the section starts must ascend.');
  });
  const first = Math.floor((frontier - shift) / total) - 1;
  for (let pass = first; pass <= first + 3; pass++) {
    for (const start of starts) {
      const cycle = shift + pass * total + start;
      if (cycle > frontier && (cycle - frontier) / cps >= minLeadSeconds) return cycle;
    }
  }
  throw new Error('Moontide: no section line was found ahead of the scheduler.');
}

/**
 * The line of a launch and the word the takeover knows it by: `kind` is one of the toolbar's choices ('section', 'phrase',
 * 'bar'). Returns a frozen { line, at } with `at` 'section', 'phrase' or 'bar'. Bar and phrase lines are multiples of 1 and
 * of the page's phrase length counted from Play, at least `minLeadSeconds` ahead of the frontier; the end of the section
 * that plays comes from the read song. Any other kind throws.
 */
export function launchLine({ kind, frontier, cps, reading, minLeadSeconds }) {
  if (!SONG_LAUNCHES.includes(kind)) {
    throw new Error(`Moontide: unknown launch choice '${String(kind)}' (expected one of ${SONG_LAUNCHES.join(', ')}).`);
  }
  if (kind === 'section') {
    const line = sectionEndLine({ frontier, cps, shift: reading.shift, total: reading.total, starts: unshiftedStarts(reading), minLeadSeconds });
    return Object.freeze({ line, at: 'section' });
  }
  const lineLength = kind === 'bar' ? 1 : DEFAULT_PHRASE_CYCLES;
  return Object.freeze({ line: boundaryCycle({ frontier, cps, lineLength, minLeadSeconds }), at: kind });
}

/** The shift that puts section `sectionIndex` of the read song on cycle `line`. */
export function launchShift(reading, sectionIndex, line) {
  const starts = unshiftedStarts(reading);
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= starts.length) {
    throw new Error(`Moontide: the song has no section ${String(sectionIndex)} to launch.`);
  }
  finite('the launch line', line);
  return launchOffset(line, starts[sectionIndex], reading.total);
}

/** True when shifts `a` and `b` give the same position in a structure of `total` cycles (they differ by a whole number of structures). */
export function sameShift(a, b, total) {
  finite('a shift', a);
  finite('a shift', b);
  if (finite('the length of the structure', total) <= 0) throw new Error(`Moontide: the length of the structure must be above 0, got ${String(total)}.`);
  const rest = (((a - b) % total) + total) % total;
  return rest < SHIFT_TOLERANCE || total - rest < SHIFT_TOLERANCE;
}

/**
 * The number literal to write for a shift: whole numbers as digits, a fraction rounded to nine decimals with no trailing
 * zero, a negative zero as '0'. A value that is not finite throws.
 */
export function shiftText(value) {
  finite('a shift', value);
  const fixed = value.toFixed(SHIFT_DECIMALS);
  const text = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return text === '-0' ? '0' : text;
}

/** The edit list that replaces the shift literal of the read song with `value`. */
export function shiftEdit(reading, value) {
  const range = reading.shiftRange;
  if (range === undefined || range === null) throw new Error('Moontide: the reading of the song has no range for its shift.');
  return [{ from: range.start, to: range.end, insert: shiftText(value) }];
}

/**
 * The edit that makes Play start a piece from its first section: the scheduler's cycle count restarts at 0 at every Play, so
 * a shift left in the code starts the music inside the structure. null when the shift is 0 already (Play changes nothing);
 * otherwise the one edit that writes 0 over the shift literal and touches nothing else.
 */
export function playResetEdit(reading) {
  if (reading.shift === 0) return null;
  const range = reading.shiftRange;
  if (range === undefined || range === null) throw new Error('Moontide: the reading of the song has no range for its shift.');
  return [{ from: range.start, to: range.end, insert: '0' }];
}

/**
 * What the editor holds again when a launch from the grid is over without having taken over (canceled, or the sound
 * stopped while it waited). The launch wrote only the shift into the code, so the code that plays goes back, but only while
 * the editor still holds exactly the text the launch wrote. Text the person typed since is never replaced: the answer is
 * then null and the editor is left as it is. Also null when the launch never recorded its text.
 */
export function textAfterCanceledLaunch({ editorCode, launchCode, playingCode }) {
  if (typeof editorCode !== 'string' || typeof playingCode !== 'string') {
    throw new Error('Moontide: a canceled launch needs the text of the editor and the code that plays.');
  }
  return typeof launchCode === 'string' && editorCode === launchCode ? playingCode : null;
}

/** null when section `index` of the read song still has the name and length the person saw, else 'section-gone'. */
export function checkSection(reading, { index, name, length }) {
  const section = reading.sections[index];
  return section !== undefined && section.name === name && section.length === length ? null : 'section-gone';
}

// ---- changing a cell of the plan ----

/** The sentence each refusal id of the cell edits stands for, so an error says what was refused. */
const EDIT_REFUSALS = {
  'name-unwritable': "Moontide: that variation's name cannot be written into the plan as it is.",
};

/** Raised when an edit cannot be built from what the person chose; `reason` is the id the grid turns into a sentence. */
export class SongEditRefusal extends Error {
  constructor(reason) {
    const message = Object.hasOwn(EDIT_REFUSALS, reason) ? EDIT_REFUSALS[reason] : null;
    if (message === null) throw new Error(`Moontide: unknown song edit refusal '${String(reason)}'.`);
    super(message);
    this.name = 'SongEditRefusal';
    this.reason = reason;
  }
}

/** The plan reads this name as a rest, so a variation called so cannot be chosen by name. */
const REST_KEY = '-';

/** The literal the plan holds for a rest. */
const REST_LITERAL = "'-'";

/** Characters that cannot sit in a single-quoted literal on one line: controls, line separator, paragraph separator. */
const UNWRITABLE = /[\u0000-\u001F\u007F\u2028\u2029]/;

/**
 * The text to write into the plan for the variation called `key`: a single-quoted literal with the backslash and the single
 * quote escaped. A name that holds a control, line separator or paragraph separator character, or the name '-' (the plan reads
 * it as a rest), is refused with SongEditRefusal('name-unwritable').
 */
export function quoteKey(key) {
  if (typeof key !== 'string') throw new Error(`Moontide: a variation name must be text, got ${String(key)}.`);
  if (key === REST_KEY || UNWRITABLE.test(key)) throw new SongEditRefusal('name-unwritable');
  return `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The cell of `track` in section entry `index`, or undefined. */
function cellOf(track, index) {
  return track.cells.find((cell) => cell.section === index);
}

/**
 * null when the cell the person clicked is still what they saw, else the id of what changed: `section-gone` (entry `index`
 * has another name or length now), `cell-gone` (the track is gone, or its cell in that section no longer holds `key`; a
 * `key` of null stands for a rest) or `variation-gone` (`choice.key` is no longer a variation of that track). `choice` is
 * `{ key }` or `{ rest: true }`.
 */
export function checkCell(reading, { index, name, length, track, key }, choice) {
  const section = reading.sections[index];
  if (section === undefined || section.name !== name || section.length !== length) return 'section-gone';
  const found = reading.tracks.find((candidate) => candidate.name === track);
  if (found === undefined) return 'cell-gone';
  const cell = cellOf(found, index);
  if (cell === undefined || cell.key !== key) return 'cell-gone';
  if (choice.rest !== true && !found.variations.some((variation) => variation.key === choice.key)) return 'variation-gone';
  return null;
}

/**
 * The edit that puts `choice` (`{ key }` or `{ rest: true }`) into the cell of `track` in section entry `index`: one
 * `{ from, to, insert }` over the plan string of that cell and nothing else (entries that share a section name share the
 * string, so one edit changes every column of that name). `changed` is false, with no edit, when the choice is what the cell
 * holds already. A name that cannot be written throws SongEditRefusal; a track or section the reading does not have throws.
 */
export function cellEdit(reading, { index, track }, choice) {
  const found = reading.tracks.find((candidate) => candidate.name === track);
  const cell = found === undefined ? undefined : cellOf(found, index);
  if (cell === undefined) throw new Error(`Moontide: the song has no cell for track '${String(track)}' in section ${String(index)}.`);
  const rest = choice !== null && typeof choice === 'object' && choice.rest === true;
  if (!rest && (choice === null || typeof choice !== 'object' || typeof choice.key !== 'string')) {
    throw new Error('Moontide: a cell choice is { key } or { rest: true }.');
  }
  if (rest ? cell.key === null : cell.key === choice.key) return { edits: [], changed: false };
  const insert = rest ? REST_LITERAL : quoteKey(choice.key);
  return { edits: [{ from: cell.range.start, to: cell.range.end, insert }], changed: true };
}
