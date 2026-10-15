// Pure module for Moontide's browser page: checks what a structured piece really plays against what its song declares.
// After each version plays, the page asks every unmuted play() track for its own pattern (the same per-track program the
// Timeline uses) and compares the first cycle of every section entry, repeated names included, with the cell the song
// declares there. The declared side is built by the page itself from the code's own constants and the reader's static
// cells, never through the code's play() helper, so a helper that was changed (or a one-sided edit) shows as a difference.
//
// What is compared, for one section entry of one track: the onsets in the first cycle of the entry. The counts must be
// equal; each declared onset needs a played onset with the same whole begin and end (a declared whole that runs past the
// end of the section is cut there, the way the section clock cuts a held note) whose value holds every key of the declared
// value with an equal value. Extra keys on the played side (a gain, a velocity) are ignored and function values count as
// equal. A rest declares no onset. The check never changes the code, the music or the editor: it only queries patterns.
//
// A chain written after play() that changes notes or time (a speed change, a transposition) is a real difference between
// what is declared and what plays, and it is reported as one.
//
// Timing, cancel and failure follow the Timeline's loop: a clock, a budget, a yield to the page between tracks and an
// `isCancelled` check after every await. `playedPattern`, `declared` and the clock are injected, so this module has no DOM
// access at import time and node:test drives it with fake patterns.

import { soloPrelude } from './tracks.js';

/** The tolerance when two edges of a whole are compared, in cycles. */
const EDGE_TOLERANCE = 1e-9;

const AsyncFunctionConstructor = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Where each section entry starts on the section clock, which repeats every `total` cycles: shift plus the lengths before
 * the entry, taken modulo the total, so a negative or fractional shift checks the same places the clock plays.
 * Returns `[{ index, name, start, end }]` with start in [0, total) and end = start + length.
 */
export function sectionStarts(reading) {
  const { total } = reading;
  return reading.sections.map((section, index) => {
    let start = section.start % total;
    if (start < 0) start += total;
    if (start >= total) start = 0;
    return { index, name: section.name, start, end: start + section.length };
  });
}

/**
 * The (track, section entry) pairs the declared side holds a pattern for, in the order of the array that expectedSource
 * returns: tracks in code order (muted ones skipped), then section entries in order, a rest skipped.
 * Returns `[{ track, section }]` with both as positions in the reading.
 */
export function expectedPairs(reading) {
  const pairs = [];
  reading.tracks.forEach((track, trackIndex) => {
    if (track.muted) return;
    track.cells.forEach((cell, sectionIndex) => {
      if (cell.kind !== 'rest') pairs.push({ track: trackIndex, section: sectionIndex });
    });
  });
  return pairs;
}

/**
 * The body of an async function that returns the declared cells as an array, one pattern per pair of expectedPairs. It
 * starts with the same declarations and string rewrites the per-track programs start with (soloPrelude), then reads each
 * cell from the track's constant by the key the reader found: a function is called with the harmony of the section (its
 * own text, or the code's harmony constant), the second element of a two-element list is the pattern, any other value is
 * the pattern itself. Keys and harmony texts enter only through JSON.stringify; constant names are the identifier names the
 * parser gave the reader. The helper that picks the cell is called through `this`, so no name in the code can shadow it.
 */
export function expectedSource(code, reading, { parse }) {
  const entries = expectedPairs(reading).map(({ track, section }) => {
    const { constName, cells } = reading.tracks[track];
    const { harmony } = reading.sections[section];
    const harmonyOf = harmony.from === 'own' ? JSON.stringify(harmony.text) : 'harmony';
    return `this.cell(${constName}[${JSON.stringify(cells[section].key)}], () => ${harmonyOf})`;
  });
  const cell = "(value, harmonyOf) => (typeof value === 'function' ? value(harmonyOf()) : Array.isArray(value) ? value[1] : value)";
  return `${soloPrelude(code, { parse })}return (function () {\nreturn [\n${entries.join(',\n')}\n];\n}).call({ cell: ${cell} });`;
}

/**
 * Builds and awaits an AsyncFunction from `body` (an expectedSource result), never through the editor's evaluate, so it never
 * touches the scheduler. Throws a 'Moontide: ...' error when the result is not a list of patterns with queryArc.
 */
export async function evaluateDeclared(body) {
  const result = await new AsyncFunctionConstructor(body)();
  if (!Array.isArray(result) || result.some((pattern) => !pattern || typeof pattern.queryArc !== 'function')) {
    throw new Error('Moontide: the declared cells did not come out as a list of patterns with queryArc.');
  }
  return result;
}

/**
 * Deterministic string for one value, stable regardless of key order; every function counts as the same value. Mirrors
 * stableStringify in page/timeline.js; keep the two in step.
 */
function stableStringify(value) {
  if (typeof value === 'function') return '"[function]"';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The onsets of `pattern` in [from, to) as `{ begin, end, value, texts }`, `texts` caching the string of each key. */
function onsetsOf(pattern, from, to, shiftBy, cutAt) {
  const onsets = [];
  for (const hap of pattern.queryArc(from, to)) {
    if (!hap.whole || !hap.hasOnset()) continue;
    const end = hap.whole.end.valueOf();
    onsets.push({
      begin: hap.whole.begin.valueOf() + shiftBy,
      end: (cutAt === null ? end : Math.min(end, cutAt)) + shiftBy,
      value: hap.value,
      texts: new Map(),
    });
  }
  return onsets;
}

/** The string of one key of an onset's value, or of the whole value when the key is null; computed once per onset. */
function textOf(onset, key) {
  const id = key === null ? '' : key;
  if (!onset.texts.has(id)) {
    onset.texts.set(id, stableStringify(key === null ? onset.value : onset.value[key]));
  }
  return onset.texts.get(id);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** True when the played onset has the declared one's edges and holds every key of the declared value with an equal value. */
function onsetMatches(declared, played) {
  if (Math.abs(declared.begin - played.begin) > EDGE_TOLERANCE || Math.abs(declared.end - played.end) > EDGE_TOLERANCE) return false;
  if (!isRecord(declared.value)) return textOf(declared, null) === textOf(played, null);
  if (!isRecord(played.value)) return false;
  return Object.keys(declared.value).every((key) => textOf(declared, key) === textOf(played, key));
}

/**
 * True when the declared onsets and the played onsets pair up one to one: the counts are equal and every declared onset
 * gets its own played onset (a played onset serves one declared onset only).
 */
function sameOnsets(declared, played) {
  if (declared.length !== played.length) return false;
  const candidates = declared.map((one) => played.flatMap((other, at) => (onsetMatches(one, other) ? [at] : [])));
  if (candidates.some((list) => list.length === 0)) return false;
  const takenBy = new Array(played.length).fill(-1);
  const place = (at, seen) => {
    for (const candidate of candidates[at]) {
      if (seen[candidate]) continue;
      seen[candidate] = true;
      if (takenBy[candidate] === -1 || place(takenBy[candidate], seen)) {
        takenBy[candidate] = at;
        return true;
      }
    }
    return false;
  };
  return declared.every((_, at) => place(at, new Array(played.length).fill(false)));
}

/**
 * Compares the first cycle of every section entry of every unmuted play() track with what the song declares there.
 * `reading` is a 'read' reading of page/structure.js, `starts` is sectionStarts(reading), `playedPattern(track)` resolves to
 * the pattern a track plays on its own, `declared()` resolves to the list that expectedSource describes (one pattern per
 * pair of expectedPairs). Resolves to one of:
 * - `{ state: 'agrees', ms }`
 * - `{ state: 'differs', first: { section, track }, more, ms }`: the first place in section order then track order, as names,
 *   and how many other places differ;
 * - `{ state: 'failed', message, ms }`: something threw;
 * - `{ state: 'too-slow', ms }`: the budget passed before the answer;
 * - `{ state: 'cancelled' }`: `isCancelled()` turned true, and nothing else is said.
 * It yields to the page after each track and never throws.
 */
export async function checkSections({ reading, starts, playedPattern, declared, budgetMs, clock, yieldToPage, isCancelled }) {
  const begun = clock();
  const elapsed = () => clock() - begun;
  try {
    const pairs = expectedPairs(reading);
    const patterns = await declared();
    if (isCancelled()) return { state: 'cancelled' };
    if (!Array.isArray(patterns) || patterns.length !== pairs.length) {
      throw new Error('Moontide: the declared cells do not match the cells of the reading.');
    }
    const declaredAt = new Map(pairs.map((pair, at) => [`${pair.track}:${pair.section}`, patterns[at]]));
    const played = await Promise.all(reading.tracks.map((track) => (track.muted ? null : playedPattern(track))));
    if (isCancelled()) return { state: 'cancelled' };
    if (elapsed() > budgetMs) return { state: 'too-slow', ms: elapsed() };

    const places = [];
    for (let trackIndex = 0; trackIndex < reading.tracks.length; trackIndex++) {
      if (played[trackIndex] === null) continue;
      for (const { index, start } of starts) {
        const length = reading.sections[index].length;
        const pattern = declaredAt.get(`${trackIndex}:${index}`);
        const expected = pattern === undefined ? [] : onsetsOf(pattern, 0, 1, start, length);
        const actual = onsetsOf(played[trackIndex], start, start + 1, 0, null);
        if (!sameOnsets(expected, actual)) places.push({ section: index, track: trackIndex });
      }
      if (elapsed() > budgetMs) return { state: 'too-slow', ms: elapsed() };
      await yieldToPage();
      if (isCancelled()) return { state: 'cancelled' };
    }

    if (places.length === 0) return { state: 'agrees', ms: elapsed() };
    places.sort((a, b) => a.section - b.section || a.track - b.track);
    const [first] = places;
    return {
      state: 'differs',
      first: { section: reading.sections[first.section].name, track: reading.tracks[first.track].name },
      more: places.length - 1,
      ms: elapsed(),
    };
  } catch (err) {
    return { state: 'failed', message: err instanceof Error ? err.message : String(err), ms: elapsed() };
  }
}
