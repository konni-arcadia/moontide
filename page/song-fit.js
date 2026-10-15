// Pure module for Moontide's browser page: whether the notes of a fixed variation fit the harmony of the section they play
// in. The page asks each fixed variation for its own pattern, by a query of the code's own constants (never through the
// code's play() helper), keeps which pitch classes it plays in each cycle, and compares those of the cycles a section covers
// with the scale of the section's harmony, over the nine scales the Jam view knows. It only says words: nothing here
// changes the code, the music or a launch.
//
// The query follows the same shape as the check of what a song declares: the code's top-level declarations are evaluated by
// the prelude the per-track programs start with, then each variation is read from its track's constant. The clock, the
// budget, the yield to the page and the cancel flag are injected, so this module has no DOM access at import time and
// node:test drives it with fake patterns.

import { soloPrelude } from './tracks.js';
import { pitchOf } from './timeline.js';
import { MICROTONE, MODES, scalePcs, spellTable } from './jam-analysis.js';
import { readHarmonyText } from './harmony.js';
import { SONG_COPY, displayHarmony, fillSong, quoted } from './structure.js';

/** Why a variation's fit cannot be checked, by id; each has one sentence in SONG_COPY.fitReasons. */
export const FIT_REASONS = Object.freeze(['no-harmony', 'harmony-unreadable', 'harmony-unknown', 'no-notes', 'not-read', 'too-slow']);

/** How many outside notes the line under a variation names before it says how many more there are. */
const NAMED_OUTSIDE = 3;

/** How many cycles are read between two looks at the clock and the cancel flag. */
const CHECK_EVERY_CYCLES = 4;

const AsyncFunctionConstructor = Object.getPrototypeOf(async function () {}).constructor;

const mod12 = (n) => ((n % 12) + 12) % 12;

/** The key of one variation of one track in the answer: the track's name and the variation's key, as JSON text. */
export function pairKey(track, key) {
  return JSON.stringify([track, key]);
}

/**
 * The (track, variation) pairs the fit query holds a pattern for: every fixed variation of every play track, muted tracks
 * included, used or not, tracks in code order and then variations in code order. Returns `[{ track, key }]` with the
 * track's name and the variation's key.
 */
export function fitPairs(reading) {
  const pairs = [];
  for (const track of reading.tracks) {
    for (const variation of track.variations) {
      if (variation.kind === 'fixed') pairs.push({ track: track.name, key: variation.key });
    }
  }
  return pairs;
}

/**
 * The body of an async function that returns one entry per pair of fitPairs: the pattern of the variation, or null. It
 * starts with the declarations and string rewrites the per-track programs start with (soloPrelude), then reads each
 * variation from the track's constant by the key the reader found, through a helper called by `this` so no name in the code
 * can shadow it: the second element of the pair when it can be queried, else null. Keys enter only through JSON.stringify
 * and constant names are the identifier names the parser gave the reader.
 */
export function fitSource(code, reading, { parse }) {
  const constants = new Map(reading.tracks.map((track) => [track.name, track.constName]));
  const entries = fitPairs(reading).map(({ track, key }) => `this.pick(${constants.get(track)}[${JSON.stringify(key)}])`);
  const pick = "(value) => (Array.isArray(value) && value[1] && typeof value[1].queryArc === 'function' ? value[1] : null)";
  return `${soloPrelude(code, { parse })}return (function () {\nreturn [\n${entries.join(',\n')}\n];\n}).call({ pick: ${pick} });`;
}

/**
 * Builds and awaits an AsyncFunction from `body` (a fitSource result), never through the editor's evaluate, so it never
 * touches the scheduler and never calls the code's play(). Throws a 'Moontide: ...' error when the result is not a list.
 */
export async function evaluateFit(body) {
  const result = await new AsyncFunctionConstructor(body)();
  if (!Array.isArray(result)) throw new Error('Moontide: the fit query did not come out as a list of patterns.');
  return result;
}

/** The 12-bit set of the pitch classes of the onsets that begin in one cycle of `pattern`. A note farther than MICROTONE from a semitone is left out. */
function maskOfCycle(pattern, cycle) {
  let mask = 0;
  for (const hap of pattern.queryArc(cycle, cycle + 1)) {
    if (!hap.whole || !hap.hasOnset()) continue;
    const pitch = pitchOf(hap.value);
    if (pitch === null) continue;
    const midi = Math.round(pitch);
    if (Math.abs(pitch - midi) > MICROTONE) continue;
    mask |= 1 << mod12(midi);
  }
  return mask;
}

/**
 * Reads, for every pair, which pitch classes its pattern plays in each of the first `cycles` cycles (a variation restarts at
 * its first cycle in every section, so cycle 0 is the section's first). `patterns[i]` belongs to `pairs[i]`; a null pattern
 * is a variation the page could not read. Resolves to `{ state: 'ready', byPair, failures }` or `{ state: 'cancelled' }`:
 * `byPair` maps pairKey(track, key) to `{ masks }` (one 12-bit set per cycle, a note counted in the cycle it begins in) or
 * to `{ reason: 'not-read' | 'too-slow' }`; `failures` lists `{ track, key, message }` for each query that threw. The
 * clock and the cancel flag are looked at before each variation and every few cycles; a variation the budget cuts short and
 * every one after it are 'too-slow'. It yields to the page after each variation and never throws.
 */
export async function collectFit({ patterns, pairs, cycles, budgetMs, clock, yieldToPage, isCancelled }) {
  const begun = clock();
  const byPair = new Map();
  const failures = [];
  if (!Array.isArray(patterns) || patterns.length !== pairs.length) {
    return { state: 'ready', byPair: new Map(pairs.map((pair) => [pairKey(pair.track, pair.key), { reason: 'not-read' }])), failures: [{ track: null, key: null, message: 'the fit query did not match the variations of the reading' }] };
  }
  let overBudget = false;
  for (let at = 0; at < pairs.length; at++) {
    const { track, key } = pairs[at];
    const id = pairKey(track, key);
    if (isCancelled()) return { state: 'cancelled' };
    if (!overBudget && clock() - begun > budgetMs) overBudget = true;
    if (overBudget) {
      byPair.set(id, { reason: 'too-slow' });
      continue;
    }
    const pattern = patterns[at];
    if (pattern === null || pattern === undefined || typeof pattern.queryArc !== 'function') {
      byPair.set(id, { reason: 'not-read' });
      continue;
    }
    const masks = [];
    try {
      for (let cycle = 0; cycle < cycles; cycle++) {
        masks.push(maskOfCycle(pattern, cycle));
        if (cycle % CHECK_EVERY_CYCLES === CHECK_EVERY_CYCLES - 1 && clock() - begun > budgetMs) {
          overBudget = true;
          break;
        }
      }
    } catch (err) {
      failures.push({ track, key, message: err instanceof Error ? err.message : String(err) });
      byPair.set(id, { reason: 'not-read' });
      continue;
    }
    byPair.set(id, overBudget ? { reason: 'too-slow' } : { masks });
    await yieldToPage();
    if (isCancelled()) return { state: 'cancelled' };
  }
  return { state: 'ready', byPair, failures };
}

/**
 * The scale a section's harmony gives to compare with: `{ rootPc, modeId, text }`, or `{ reason }` with a reason of
 * FIT_REASONS when there is none to compare with: no harmony anywhere, a piece harmony the page cannot read, text the reader
 * rejects, chord text, or a scale outside the nine. `section` is an entry of a read song.
 */
export function sectionHarmony(section) {
  const { harmony } = section;
  if (harmony.from === 'none') return { reason: 'no-harmony' };
  if (harmony.from === 'piece-unreadable') return { reason: 'harmony-unreadable' };
  const read = readHarmonyText(harmony.text);
  if (read === null) return { reason: 'harmony-unreadable' };
  if (read.scale === null) return { reason: 'harmony-unknown' };
  return { rootPc: read.scale.rootPc, modeId: read.scale.modeId, text: harmony.text };
}

/**
 * Whether the notes of one variation fit one section. `masks` is what collectFit read for the variation (one set per cycle),
 * `length` the section's length in cycles (only the first `length` cycles count; a note that begins exactly at the length
 * belongs to the next cycle), `harmony` the sectionHarmony result, and `readReason` the reason collectFit gave when it could
 * not read the variation. Returns `{ state: 'fits' }`, `{ state: 'does-not-fit', outside }` with the outside notes spelled the
 * way the Jam view spells the section's scale and listed upward from its root, each once, or `{ state: 'cannot-check', reason }`.
 * The harmony's reason comes first, then the reason the variation was not read, then a variation with no pitched note.
 */
export function fitOf({ masks, length, harmony, readReason = null }) {
  if (harmony.reason !== undefined) return { state: 'cannot-check', reason: harmony.reason };
  if (readReason !== null) {
    if (!FIT_REASONS.includes(readReason)) throw new Error(`Moontide: unknown fit reason '${String(readReason)}'.`);
    return { state: 'cannot-check', reason: readReason };
  }
  if (!Array.isArray(masks) || masks.length < length) {
    throw new Error(`Moontide: the fit of a section of ${String(length)} cycles needs the notes of that many cycles.`);
  }
  let played = 0;
  for (let cycle = 0; cycle < length; cycle++) played |= masks[cycle];
  if (played === 0) return { state: 'cannot-check', reason: 'no-notes' };
  const mode = MODES.find((candidate) => candidate.id === harmony.modeId);
  if (mode === undefined) throw new Error(`Moontide: no scale called '${String(harmony.modeId)}' to compare with.`);
  const inScale = new Set(scalePcs(harmony.rootPc, mode));
  const outside = [];
  for (let pc = 0; pc < 12; pc++) {
    if ((played & (1 << pc)) !== 0 && !inScale.has(pc)) outside.push(pc);
  }
  if (outside.length === 0) return { state: 'fits' };
  outside.sort((a, b) => mod12(a - harmony.rootPc) - mod12(b - harmony.rootPc));
  const spelling = spellTable(harmony.rootPc, mode);
  return { state: 'does-not-fit', outside: outside.map((pc) => spelling[pc]) };
}

/**
 * The words for one fit. `fit` is a fitOf result; the rest names the cell: `track`, `section` and `variation` as written,
 * `fixedHarmony` the harmony text of the variation, `sectionHarmonyText` the section's harmony text (needed for a fit and a
 * non-fit). Returns `{ line, title, chip }`: `line` is `fits`, `does not fit (F#, A)` naming at most three notes and then
 * ` and {n} more`, or `cannot check`; `title` holds every outside note or the one reason sentence; `chip` is the line with
 * the separator the Ask chip of the cell ends with. An unknown state or reason throws.
 */
export function fitText(fit, { track, section, variation, fixedHarmony, sectionHarmonyText }) {
  const values = { track: quoted(track), section: quoted(section), variation: quoted(variation), harmony: displayHarmony(fixedHarmony) };
  const sectionText = () => displayHarmony(sectionHarmonyText);
  if (fit.state === 'fits') {
    const line = SONG_COPY.fitFits;
    return { line, title: fillSong(SONG_COPY.fitTitleFits, { ...values, sectionHarmony: sectionText() }), chip: fillSong(SONG_COPY.fitChip, { fit: line }) };
  }
  if (fit.state === 'does-not-fit') {
    const named = fit.outside.slice(0, NAMED_OUTSIDE).join(', ');
    const more = fit.outside.length - NAMED_OUTSIDE;
    const notes = more > 0 ? fillSong(SONG_COPY.fitMore, { notes: named, count: more }) : named;
    const line = fillSong(SONG_COPY.fitNot, { notes });
    const title = fillSong(SONG_COPY.fitTitleNot, { ...values, sectionHarmony: sectionText(), notes: fit.outside.join(', ') });
    return { line, title, chip: fillSong(SONG_COPY.fitChip, { fit: line }) };
  }
  if (fit.state === 'cannot-check') {
    if (!Object.hasOwn(SONG_COPY.fitReasons, fit.reason)) throw new Error(`Moontide: unknown fit reason '${String(fit.reason)}'.`);
    const line = SONG_COPY.fitCannot;
    return { line, title: fillSong(SONG_COPY.fitTitleCannot, { ...values, reason: SONG_COPY.fitReasons[fit.reason] }), chip: fillSong(SONG_COPY.fitChip, { fit: line }) };
  }
  throw new Error(`Moontide: unknown fit state '${String(fit.state)}'.`);
}

/**
 * The lookup the grid and the cell list use: `lookup(trackName, sectionIndex, key)` gives the fit of that fixed variation in
 * that section entry as `{ ...fitOf result, ...fitText result }`, from the answer of collectFit, or null when the variation is
 * not a fixed one of the reading. Each entry of a section that is used more than once gets its own length and harmony.
 * Results are made once per variation and section entry.
 */
export function fitLookup({ reading, byPair }) {
  const made = new Map();
  const harmonies = reading.sections.map((section) => sectionHarmony(section));
  return (trackName, sectionIndex, key) => {
    const track = reading.tracks.find((candidate) => candidate.name === trackName);
    const variation = track === undefined ? undefined : track.variations.find((candidate) => candidate.key === key);
    const section = reading.sections[sectionIndex];
    if (variation === undefined || variation.kind !== 'fixed' || section === undefined) return null;
    const id = `${sectionIndex}\u0000${pairKey(trackName, key)}`;
    if (!made.has(id)) {
      const entry = byPair.get(pairKey(trackName, key));
      if (entry === undefined) throw new Error(`Moontide: the fit answer has nothing for variation '${String(key)}' of track '${String(trackName)}'.`);
      const harmony = harmonies[sectionIndex];
      const fit = fitOf({ masks: entry.masks, length: section.length, harmony, readReason: entry.reason ?? null });
      const words = fitText(fit, {
        track: trackName,
        section: section.name,
        variation: key,
        fixedHarmony: variation.fixedHarmony,
        sectionHarmonyText: harmony.text ?? '',
      });
      made.set(id, { ...fit, ...words, outsideText: fit.state === 'does-not-fit' ? fit.outside.join(', ') : null });
    }
    return made.get(id);
  };
}
