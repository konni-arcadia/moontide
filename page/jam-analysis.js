// Pure module for Moontide's browser page: reads the scale the playing music is in from the
// notes that actually play. It takes the events the Timeline's own query returned (hap-shaped
// `{ begin, end, value, track }`), keeps the ones that carry a pitch, and scores the nine known
// scales by how much of the played weight each one covers. Nothing is read from the code text and
// nothing is declared by anyone: the scale comes from played notes only. No DOM access at import
// time, so this module can be imported directly by node:test and by page/main.js without a build
// step.

import { pitchOf, PAGE_CYCLES } from './timeline.js';
import { sectionSpans } from './parts.js';

/** Float tolerance for cycle positions: Strudel's cycles are floats (1.7999999999999998). */
export const EPS = 1e-6;
/** A quarter cycle: shorter than this is brief. */
export const BRIEF = 0.25;
/** A brief vertical group that names a chord still counts when it lasts at least this long. */
export const STAB_MIN = 0.125;
/** Harmonic segmentation: a note lasts at least this long to count for the chord line and the tonic. */
export const HARMONIC_MIN = 0.5;
/** Score = coverage + TONIC_BONUS * tonic emphasis of the candidate's root. */
export const TONIC_BONUS = 0.1;
/** A scale is clear only when the runner-up scores at least this much lower. */
export const CLEAR_GAP = 0.01;
/** Below this best coverage, none of the nine scales fits. */
export const MIN_COVERAGE = 0.9;
/** A freq farther than this many semitones from a semitone is dropped and counted. */
export const MICROTONE = 0.25;
/** A reading over this many pitched events is refused (bounded cost). */
export const MAX_PITCHED_EVENTS = 20000;
/** Two warnings of the same chord and outside notes at most this many cycles apart are one warning. */
export const MERGE_GAP = 0.5;
/** How far ahead the status and the coming-up list look: the Timeline's page length, in cycles. */
export const LOOK_AHEAD = PAGE_CYCLES;

/** The nine known scales; `parent` is the offset of the parent major key's tonic, used for spelling. */
export const MODES = [
  { id: 'ionian', label: 'major', offsets: [0, 2, 4, 5, 7, 9, 11], parent: 0, degrees: ['1', '2', '3', '4', '5', '6', '7'] },
  { id: 'dorian', label: 'Dorian', offsets: [0, 2, 3, 5, 7, 9, 10], parent: 2, degrees: ['1', '2', '♭3', '4', '5', '6', '♭7'] },
  { id: 'phrygian', label: 'Phrygian', offsets: [0, 1, 3, 5, 7, 8, 10], parent: 4, degrees: ['1', '♭2', '♭3', '4', '5', '♭6', '♭7'] },
  { id: 'lydian', label: 'Lydian', offsets: [0, 2, 4, 6, 7, 9, 11], parent: 5, degrees: ['1', '2', '3', '♯4', '5', '6', '7'] },
  { id: 'mixolydian', label: 'Mixolydian', offsets: [0, 2, 4, 5, 7, 9, 10], parent: 7, degrees: ['1', '2', '3', '4', '5', '6', '♭7'] },
  { id: 'aeolian', label: 'minor', offsets: [0, 2, 3, 5, 7, 8, 10], parent: 9, degrees: ['1', '2', '♭3', '4', '5', '♭6', '♭7'] },
  { id: 'locrian', label: 'Locrian', offsets: [0, 1, 3, 5, 6, 8, 10], parent: 11, degrees: ['1', '♭2', '♭3', '4', '♭5', '♭6', '♭7'] },
  { id: 'harmonic-minor', label: 'harmonic minor', offsets: [0, 2, 3, 5, 7, 8, 11], parent: 9, degrees: ['1', '2', '♭3', '4', '5', '♭6', '7'] },
  { id: 'melodic-minor', label: 'melodic minor', offsets: [0, 2, 3, 5, 7, 9, 11], parent: 9, degrees: ['1', '2', '♭3', '4', '5', '6', '7'] },
];

/** Note names when no scale is known: the usual chord-name spelling. */
export const DEFAULT_SPELL = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Parent major F, Bb, Eb, Ab, Db spell with flats; every other parent (and F#/Gb) spells with sharps.
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1]);
// Root-relative offsets whose outside note is a lowered one (spelled flat, avoids the scale note above).
const LOWERED = new Set([1, 3, 5, 8, 10]);

const mod12 = (n) => ((n % 12) + 12) % 12;

/** The seven pitch classes of a scale, in scale order from its root. */
export const scalePcs = (root, mode) => mode.offsets.map((offset) => (root + offset) % 12);

/**
 * The 12-entry spelling table of one reading. Notes of the scale are spelled by letter: the seven
 * degrees take seven consecutive letters from the root's letter, and the accidental is the distance
 * to that letter's natural note, so a sharp-key scale reads F# G# A# B C# D# E# and D# harmonic
 * minor ends on C##. The root's own letter follows the key-signature convention (a natural root
 * keeps its letter; a black-key root is flat for the parent majors F, Bb, Eb, Ab, Db and their
 * modes, sharp otherwise). Notes outside the scale are spelled by root-relative alteration
 * (offsets 1, 3, 5, 8, 10 flat, the others sharp, a natural keeps its letter), so D Dorian reads
 * C C# D Eb E F F# G G# A Bb B.
 */
export function spellTable(root, mode) {
  const flats = FLAT_MAJORS.has(mod12(root - mode.parent));
  const table = Array.from({ length: 12 }, (_, pc) => {
    if (WHITE.has(pc)) return FLAT[pc];
    return LOWERED.has(mod12(pc - root)) ? FLAT[pc] : SHARP[pc];
  });
  const rootName = WHITE.has(root) || flats ? FLAT[root] : SHARP[root];
  const firstLetter = LETTERS.indexOf(rootName[0]);
  scalePcs(root, mode).forEach((pc, degree) => {
    const letter = LETTERS[(firstLetter + degree) % 7];
    const shift = mod12(pc - NATURAL[letter] + 6) - 6; // -2 (double flat) .. +2 (double sharp)
    table[pc] = letter + (shift < 0 ? 'b'.repeat(-shift) : '#'.repeat(shift));
  });
  return table;
}

/** The scale's name: its root spelled by the reading's own table, a space, then the mode label. */
export function scaleName(root, mode) {
  return `${spellTable(root, mode)[root]} ${mode.label}`;
}

/**
 * The single scale note an outside pitch class replaces (the note to avoid), as a pitch class,
 * or null (null never happens for the nine scales). A lowered outside note (root-relative offset
 * 1, 3, 5, 8 or 10) avoids the scale note a semitone above; every other outside note avoids the
 * one a semitone below.
 */
export function avoidFor(outsidePc, root, mode) {
  const offset = mod12(outsidePc - root);
  const avoid = LOWERED.has(offset) ? (outsidePc + 1) % 12 : (outsidePc + 11) % 12;
  return scalePcs(root, mode).includes(avoid) ? avoid : null;
}

// --- chord naming ---

// [symbol, intervals]; the fifth may be omitted only from seventh and ninth chords.
const SHAPES = [
  ['', [0, 4, 7]], ['m', [0, 3, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]],
  ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['m7b5', [0, 3, 6, 10]], ['dim7', [0, 3, 6, 9]],
  ['mMaj7', [0, 3, 7, 11]], ['7sus4', [0, 5, 7, 10]], ['add9', [0, 2, 4, 7]], ['madd9', [0, 2, 3, 7]],
  ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['9', [0, 2, 4, 7, 10]], ['m9', [0, 2, 3, 7, 10]], ['maj9', [0, 2, 4, 7, 11]],
].map(([symbol, intervals]) => {
  const hasSeventh = intervals.includes(10) || intervals.includes(11) || symbol === 'dim7';
  return {
    symbol,
    mask: intervals.reduce((m, i) => m | (1 << i), 0),
    required: intervals.filter((i) => i !== 7 || !hasSeventh).reduce((m, i) => m | (1 << i), 0),
  };
});
// A slash (pedal bass) name is tried only for plain triads and common sevenths.
const SLASH_OK = new Set(['', 'm', 'dim', '7', 'maj7', 'm7', 'm7b5']);

function rotate(mask, by) {
  let out = 0;
  for (let pc = 0; pc < 12; pc++) if (mask & (1 << pc)) out |= 1 << mod12(pc - by);
  return out;
}
function popCount(mask) {
  let count = 0;
  for (let m = mask; m; m >>= 1) count += m & 1;
  return count;
}
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// The best shape for a pitch-class set: { r, symbol } (r = root pitch class) or null; the root must be in the set.
function nameDirect(mask, bassPc, slashOnly = false) {
  if (popCount(mask) < 3) return null;
  let best = null;
  for (let r = 0; r < 12; r++) {
    if (!(mask & (1 << r))) continue;
    const rotated = rotate(mask, r);
    SHAPES.forEach((shape, order) => {
      if (slashOnly && !SLASH_OK.has(shape.symbol)) return;
      if ((rotated & ~shape.mask) !== 0) return; // no note outside the shape
      if ((rotated & shape.required) !== shape.required) return; // every required tone present
      // full match first, then root in the bass, then dictionary order, then the lowest root
      const key = [rotated === shape.mask ? 0 : 1, r === bassPc ? 0 : 1, order, r];
      if (!best || compareKeys(key, best.key) < 0) best = { key, r, symbol: shape.symbol };
    });
  }
  return best;
}

/**
 * The name of the chord a pitch-class set forms ('Dm7', 'A7/D' over a pedal bass), its notes
 * spelled by `spell`, or null when its shape is unknown (the caller then lists the notes).
 * `mask` has bit `pc` set for every pitch class present; `bassPc` is the lowest note's class.
 */
export function nameChord(mask, bassPc, spell) {
  const direct = nameDirect(mask, bassPc);
  if (direct) return `${spell[direct.r]}${direct.symbol}`;
  if (bassPc != null && popCount(mask) >= 4) {
    const inner = nameDirect(mask & ~(1 << bassPc), null, true);
    if (inner) return `${spell[inner.r]}${inner.symbol}/${spell[bassPc]}`;
  }
  return null;
}

// The root pitch class of the chord nameDirect finds for a set (or of its pedal-bass inner chord), else null.
function chordRootOf(mask, bassPc) {
  const direct = nameDirect(mask, bassPc);
  if (direct) return direct.r;
  if (bassPc != null && popCount(mask) >= 4) {
    const inner = nameDirect(mask & ~(1 << bassPc), null, true);
    if (inner) return inner.r;
  }
  return null;
}

/** The note names of a pitch-class set, starting at the bass and going upward, spelled by `spell`. */
export function noteList(mask, spell, bassPc) {
  const pcs = [];
  for (let pc = 0; pc < 12; pc++) if (mask & (1 << pc)) pcs.push(pc);
  const start = bassPc ?? pcs[0];
  return pcs.sort((x, y) => mod12(x - start) - mod12(y - start)).map((pc) => spell[pc]);
}

// --- events ---

/**
 * The events that carry a pitch, as `{ begin, end, midi, pc, track }`. pitchOf decides (a note
 * name, a note number or a freq); drums, bare sample indexes and unvoiced chord symbols have no
 * pitch and are ignored. A freq farther than MICROTONE from a semitone is dropped and counted in
 * the returned array's `dropped`, never guessed. Two events with the same begin, end and rounded
 * MIDI number count once (jux, doubled layers); the kept event's `tracks` is the set of every track
 * that plays it, `track` being the first.
 */
export function pitchedEvents(events) {
  const out = [];
  const seen = new Map();
  let dropped = 0;
  for (const event of events) {
    const pitch = pitchOf(event.value);
    if (pitch === null) continue;
    const midi = Math.round(pitch);
    if (Math.abs(pitch - midi) > MICROTONE) {
      dropped++;
      continue;
    }
    const key = `${event.begin.toFixed(6)}|${event.end.toFixed(6)}|${midi}`;
    const kept = seen.get(key);
    if (kept !== undefined) {
      kept.tracks.add(event.track);
      continue;
    }
    const entry = { begin: event.begin, end: event.end, midi, pc: mod12(midi), track: event.track, tracks: new Set([event.track]) };
    seen.set(key, entry);
    out.push(entry);
  }
  out.dropped = dropped;
  return out;
}

/** Every lane event of a computeTimeline 'ok' result, carrying its lane's track index. */
export function flattenLanes(result) {
  return result.lanes.flatMap((lane) => lane.events.map((event) => ({ ...event, track: lane.index })));
}

// --- solid events and segments ---

const groupKey = (e) => `${e.begin.toFixed(6)}|${e.end.toFixed(6)}`;

/**
 * Marks each pitched event `solid` when it lasts at least `minDur`, or when it is a brief member
 * of a named vertical group (same begin and end, at least three pitch classes that name a chord,
 * lasting at least STAB_MIN). Sets `solid` and `inChord` on the given events and returns them;
 * pass copies when two segmentations run over the same events.
 */
export function markSolid(events, minDur = BRIEF) {
  const groups = new Map();
  for (const e of events) {
    const key = groupKey(e);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(e);
  }
  for (const group of groups.values()) {
    const inChord = new Set(group.map((e) => e.pc)).size >= 3;
    for (const e of group) e.inChord = inChord;
  }
  for (const e of events) e.solid = e.end - e.begin >= minDur - EPS;
  for (const group of groups.values()) {
    if (group.every((e) => e.solid) || !group[0].inChord || group[0].end - group[0].begin < STAB_MIN - EPS) continue;
    let mask = 0;
    let low = Infinity;
    for (const e of group) {
      mask |= 1 << e.pc;
      low = Math.min(low, e.midi);
    }
    if (nameChord(mask, mod12(low), DEFAULT_SPELL) !== null) for (const e of group) e.solid = true;
  }
  return events;
}

/**
 * The slices between solid event boundaries, `{ begin, end, mask, bassPc, bassMidi, poly }`,
 * merged when the pitch-class set stays equal across a boundary. `from` and `to` clip the window.
 * The sounding set comes from a sorted sweep (events sorted by begin, an active set dropping the
 * events whose end has passed), so the cost stays near-linear in the number of events.
 */
export function segments(events, from = -Infinity, to = Infinity) {
  const solid = events.filter((e) => e.solid && e.end > from && e.begin < to).sort((a, b) => a.begin - b.begin);
  const cutSet = new Set();
  for (const e of solid) {
    cutSet.add(Math.round(Math.max(e.begin, from) / EPS) * EPS);
    cutSet.add(Math.round(Math.min(e.end, to) / EPS) * EPS);
  }
  const cuts = [...cutSet].sort((a, b) => a - b);
  const out = [];
  let next = 0;
  let active = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < EPS) continue;
    const mid = (a + b) / 2;
    while (next < solid.length && solid[next].begin <= mid) active.push(solid[next++]);
    active = active.filter((e) => mid < e.end);
    if (active.length === 0) continue;
    let mask = 0;
    let low = Infinity;
    for (const e of active) {
      mask |= 1 << e.pc;
      if (e.midi < low) low = e.midi;
    }
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - a) < 1e-4 && last.mask === mask) {
      last.end = b;
      last.poly = Math.max(last.poly, active.length);
      continue;
    }
    out.push({ begin: a, end: b, mask, bassPc: mod12(low), bassMidi: low, poly: active.length });
  }
  return out;
}

// --- warnings ---

// The pitch classes of a segment mask that are outside the scale, upward from the scale's root.
function outsidePcsOf(mask, root, inScale) {
  const out = [];
  for (let pc = 0; pc < 12; pc++) if (mask & (1 << pc) && !inScale.has(pc)) out.push(pc);
  return out.sort((a, b) => mod12(a - root) - mod12(b - root));
}

/**
 * The warnings of the solid segments of one part, for that part's clear `scale` (its `root`, `mode`
 * and spelling table `spell`): one `{ begin, end, chord, notes, outsidePcs, avoidPcs, outside,
 * avoid, backInKey }` for every segment holding a pitch class outside the scale. `chord` is the
 * dictionary name or null; `notes` lists the segment's notes from its bass upward; outside and
 * avoid pitch classes (and their names) go upward from the scale's root, the avoid notes without
 * duplicates. A warning covers the half-open span [begin, end). Segments with the same chord label
 * and outside notes at most MERGE_GAP apart merge; `backInKey` is the end of the run of warnings
 * at most MERGE_GAP apart, the moment nothing outside sounds any more.
 */
export function warningsFor(solidSegments, scale) {
  const inScale = new Set(scalePcs(scale.root, scale.mode));
  const { spell } = scale;
  const out = [];
  for (const segment of solidSegments) {
    const outsidePcs = outsidePcsOf(segment.mask, scale.root, inScale);
    if (outsidePcs.length === 0) continue;
    const avoidPcs = [...new Set(outsidePcs.map((pc) => avoidFor(pc, scale.root, scale.mode)).filter((pc) => pc !== null))].sort(
      (a, b) => mod12(a - scale.root) - mod12(b - scale.root),
    );
    out.push({
      begin: segment.begin,
      end: segment.end,
      chord: nameChord(segment.mask, segment.bassPc, spell),
      notes: noteList(segment.mask, spell, segment.bassPc),
      outsidePcs,
      avoidPcs,
      outside: outsidePcs.map((pc) => spell[pc]),
      avoid: avoidPcs.map((pc) => spell[pc]),
    });
  }
  const label = (w) => w.chord ?? w.notes.join(' ');
  const merged = [];
  for (const warning of out) {
    const last = merged[merged.length - 1];
    if (last && label(last) === label(warning) && last.outsidePcs.join() === warning.outsidePcs.join() && warning.begin - last.end <= MERGE_GAP + EPS) {
      last.end = warning.end;
    } else {
      merged.push({ ...warning });
    }
  }
  for (let i = 0; i < merged.length; ) {
    let j = i;
    while (j + 1 < merged.length && merged[j + 1].begin - merged[j].end <= MERGE_GAP + EPS) j++;
    for (let k = i; k <= j; k++) merged[k].backInKey = merged[j].end;
    i = j + 1;
  }
  return merged;
}

// --- scale detection ---

/**
 * Reads the scale of a set of pitched events (brief ones too). `harmonicSegments` (segments of
 * the half-cycle segmentation) add tonic evidence: bass notes of segments with at least two
 * notes and chord roots, weighted 2, 2 and 1 with all notes, renormalized over the components
 * that have evidence. Returns
 * - `{ status: 'clear', root, mode, name, spell, notes, coverage }`, notes being the seven
 *   `{ pc, name, degree }` in scale order from the root;
 * - `{ status: 'ambiguous', kind: 'tie' | 'near', candidates }`, candidates `{ root, mode, name, coverage }`
 *   in score order (a tie means the candidates cover the same weight, near that they do not);
 * - `{ status: 'no-fit' }` when no scale covers MIN_COVERAGE of the weight;
 * - `{ status: 'none' }` when no event has any duration.
 */
export function detectScale(events, harmonicSegments = []) {
  const weight = new Array(12).fill(0);
  let total = 0;
  for (const event of events) {
    const length = event.end - event.begin;
    weight[event.pc] += length;
    total += length;
  }
  if (total === 0) return { status: 'none' };
  const bass = new Array(12).fill(0);
  const roots = new Array(12).fill(0);
  for (const segment of harmonicSegments) {
    const length = segment.end - segment.begin;
    if (segment.poly >= 2) bass[segment.bassPc] += length; // a lone melody is not bass evidence
    const root = chordRootOf(segment.mask, segment.bassPc);
    if (root !== null) roots[root] += length;
  }
  const components = [[bass, 2], [roots, 2], [weight, 1]]
    .map(([values, k]) => [values, k, values.reduce((x, y) => x + y, 0)])
    .filter((component) => component[2] > 0);
  const kSum = components.reduce((x, component) => x + component[1], 0);
  const tonic = new Array(12).fill(0);
  for (const [values, k, sum] of components) {
    for (let pc = 0; pc < 12; pc++) tonic[pc] += (k / kSum) * (values[pc] / sum);
  }
  const candidates = [];
  for (const mode of MODES) {
    for (let root = 0; root < 12; root++) {
      let inside = 0;
      for (const pc of scalePcs(root, mode)) inside += weight[pc];
      const coverage = inside / total;
      candidates.push({ root, mode, coverage, score: coverage + TONIC_BONUS * tonic[root] });
    }
  }
  if (Math.max(...candidates.map((c) => c.coverage)) < MIN_COVERAGE) return { status: 'no-fit' };
  candidates.sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.mode.parent - b.mode.parent);
  const top = candidates[0];
  const unresolved = candidates.filter((c) => top.score - c.score < CLEAR_GAP);
  if (unresolved.length === 1) {
    const spell = spellTable(top.root, top.mode);
    return {
      status: 'clear',
      root: top.root,
      mode: top.mode,
      name: scaleName(top.root, top.mode),
      spell,
      notes: scalePcs(top.root, top.mode).map((pc, i) => ({ pc, name: spell[pc], degree: top.mode.degrees[i] })),
      coverage: top.coverage,
    };
  }
  const tie = unresolved.every((c) => Math.abs(c.coverage - top.coverage) < 1e-9);
  return {
    status: 'ambiguous',
    kind: tie ? 'tie' : 'near',
    candidates: unresolved.map((c) => ({ root: c.root, mode: c.mode, name: scaleName(c.root, c.mode), coverage: c.coverage })),
  };
}

// --- the reading ---

/**
 * The first arrangement, in source order, whose owner track plays pitched notes; an arrangement
 * with no owner counts when any pitched note plays. Null when none qualifies. `pitched` is the
 * pitchedEvents() result, events carrying their `tracks` set.
 */
export function chooseArrangement(arrangements, pitched) {
  for (const arrangement of arrangements) {
    if (arrangement.owner === null ? pitched.length > 0 : pitched.some((e) => e.tracks.has(arrangement.owner))) {
      return arrangement;
    }
  }
  return null;
}

// The scale of a pool of pitched events with that pool's own half-cycle chord segments.
function scaleOfPool(pool) {
  const harmonic = segments(markSolid(pool.map((e) => ({ ...e })), HARMONIC_MIN));
  return detectScale(pool, harmonic);
}

/**
 * The reading of one window of cycles: `events` are the window's hap-shaped events, plus the notes
 * of earlier pages that still sound at the window start (they count from the window start on; an
 * event that ended before the window is ignored), and `arrangements` the arrange() calls of the
 * playing code. Returns `{ status: 'too-dense', count }`
 * when the pitched events exceed MAX_PITCHED_EVENTS, else `{ status: 'none' | 'ready', windowStart,
 * windowEnd, dropped, whole, spans, arrangement, warnings }`. `whole` is the scale of the whole
 * window. Without an arrangement `spans` is one span named null; with one (chooseArrangement) each
 * instance of a section is a span `{ name, begin, end, length, scale, warnings }`, carrying the
 * scale pooled over every pitched event whose begin falls in any span of the same name.
 *
 * Warnings are computed per span, from the solid segmentation of the events that begin in the
 * span, with the span's own scale and spelling (none when that scale is not clear). `warnings`
 * lists every span's warnings in begin order, each also carrying its `index` in that list, its
 * `spanIndex` and its `scaleName`. Each span also carries `harmonic`, the half-cycle segmentation of
 * its own events, from which the chord sounding now is read. With two or more arrangements `partOwner` names the chosen
 * one the way the Parts view does (the owner track's name among `tracks`, else `arrange() N`).
 * `partial` (default false) says the window is shorter than the look-ahead because the page after
 * the playing one could not be read: the reading carries it and the model then promises nothing ahead.
 * `declared` (default `{ state: 'none' }`) is the harmony the code declares (readHarmony of page/harmony.js):
 * the reading only carries it to the model; it is never an input of the scale detection.
 * `excludeTracks` (default empty; anything with a `has` method) holds the indexes of tracks whose events
 * are ignored before anything else, the drum tracks of the rig (drumTrackIndexes of page/timeline.js): their
 * numeric notes are drum-map keys, not pitches.
 */
export function buildReading({ events, windowStart, windowLength, arrangements = [], tracks = [], partial = false, declared = { state: 'none' }, excludeTracks = new Set() }) {
  // A note that began before the window and still sounds at its start (a pad, a drone) is carried in,
  // clipped to begin at the window start; one that ended before the window is left out.
  const inWindow = events
    .filter((e) => !excludeTracks.has(e.track))
    .filter((e) => e.end > windowStart + EPS)
    .map((e) => (e.begin < windowStart ? { ...e, begin: windowStart } : e));
  const pitched = pitchedEvents(inWindow);
  if (pitched.length > MAX_PITCHED_EVENTS) return { status: 'too-dense', count: pitched.length };
  const windowEnd = windowStart + windowLength;
  const whole = scaleOfPool(pitched);
  const arrangement = chooseArrangement(arrangements, pitched);
  let spans;
  let spanEvents;
  if (arrangement === null) {
    spans = [{ name: null, begin: windowStart, end: windowEnd, length: windowLength, scale: whole }];
    spanEvents = [pitched];
  } else {
    spans = sectionSpans(arrangement, windowStart, windowLength).map((span) => ({
      name: span.name,
      begin: windowStart + span.x,
      end: windowStart + span.x + span.width,
      length: span.length,
      scale: null,
    }));
    spanEvents = spans.map(() => []);
    const pools = new Map(spans.map((span) => [span.name, []]));
    for (const e of pitched) {
      // spans are contiguous and sorted: binary search for the one holding the event's begin
      let lo = 0;
      let hi = spans.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (spans[mid].begin <= e.begin + EPS) lo = mid;
        else hi = mid - 1;
      }
      if (e.begin >= spans[0].begin - EPS && e.begin < spans[spans.length - 1].end - EPS) {
        pools.get(spans[lo].name).push(e);
        spanEvents[lo].push(e);
      }
    }
    const scales = new Map();
    for (const [name, pool] of pools) scales.set(name, pool.length === 0 ? { status: 'none' } : scaleOfPool(pool));
    for (const span of spans) span.scale = scales.get(span.name);
  }
  const warnings = [];
  spans.forEach((span, spanIndex) => {
    span.harmonic = segments(markSolid(spanEvents[spanIndex].map((e) => ({ ...e })), HARMONIC_MIN), span.begin, span.end);
    span.warnings =
      span.scale.status === 'clear'
        ? warningsFor(segments(markSolid(spanEvents[spanIndex].map((e) => ({ ...e })), BRIEF), span.begin, span.end), span.scale)
        : [];
    for (const warning of span.warnings) {
      warning.spanIndex = spanIndex;
      warning.scaleName = span.scale.name;
      warning.index = warnings.length;
      warnings.push(warning);
    }
  });
  let partOwner = null;
  if (arrangement !== null && arrangements.length >= 2) {
    const ownerTrack = arrangement.owner !== null ? tracks.find((track) => track.index === arrangement.owner) : undefined;
    partOwner = ownerTrack ? ownerTrack.name : `arrange() ${arrangement.index + 1}`;
  }
  return {
    status: pitched.length === 0 ? 'none' : 'ready',
    windowStart,
    windowEnd,
    dropped: pitched.dropped,
    whole,
    spans,
    arrangement,
    warnings,
    partOwner,
    partial,
    declared,
  };
}

// The chord sounding at `cycle`: the span's harmonic segment (notes of at least half a cycle plus named
// stabs, so a fast melody never changes it) that holds the cycle, when it has at least two pitch
// classes; `{ name, notes, pcs }` spelled by `spell`, or null.
function chordAt(span, cycle, spell) {
  const segment = (span.harmonic ?? []).find((s) => cycle >= s.begin - EPS && cycle < s.end - EPS);
  if (segment === undefined) return null;
  const pcs = [];
  for (let pc = 0; pc < 12; pc++) if (segment.mask & (1 << pc)) pcs.push(pc);
  if (pcs.length < 2) return null;
  return { name: nameChord(segment.mask, segment.bassPc, spell), notes: noteList(segment.mask, spell, segment.bassPc), pcs };
}

// Events within LOOK_AHEAD cycles after `cycle`, strictly after it: the warnings to come (only while
// the current scale is clear) and the part changes, soonest first, a part change before a warning
// at the same cycle.
function upcomingOf(reading, cycle, scaleIsClear) {
  const ahead = (begin) => begin > cycle + EPS && begin - cycle <= LOOK_AHEAD + EPS;
  const out = [];
  reading.spans.forEach((span, spanIndex) => {
    // the first span of the window is never a part change: it may be clipped at the window start
    if (span.name === null || spanIndex === 0 || !ahead(span.begin)) return;
    const previous = reading.spans[spanIndex - 1].scale;
    let change = 'changes';
    if (span.scale.status !== 'clear') change = 'unclear';
    else if (previous.status === 'clear' && previous.root === span.scale.root && previous.mode.id === span.scale.mode.id) change = 'same';
    out.push({
      kind: 'part',
      begin: span.begin,
      spanIndex,
      name: span.name,
      length: span.length,
      change,
      scaleName: span.scale.status === 'clear' ? span.scale.name : null,
    });
  });
  if (scaleIsClear) {
    for (const w of reading.warnings) if (ahead(w.begin)) out.push({ kind: 'warning', begin: w.begin, end: w.end, warningIndex: w.index });
  }
  const order = (e) => (e.kind === 'part' ? 0 : 1);
  return out.sort((a, b) => (Math.abs(a.begin - b.begin) < EPS ? order(a) - order(b) : a.begin - b.begin));
}

/**
 * The reading at one playing position: the span whose `[begin, end)` holds `cycle`, else a
 * whole-window span. Throws a loud error when `cycle` is not finite or `cps` is not a finite
 * positive number (a caller bug: the page checks the tempo first). With a clear current scale it
 * also gives `warning` (the warning whose `[begin, end)` holds the cycle, else null), `backInKey`
 * (that warning's back-in-key cycle, or null when it lies LOOK_AHEAD cycles or more ahead or at the
 * window's end) and `nextWarning` (the first warning starting after the cycle, at most LOOK_AHEAD
 * cycles ahead); all three are null when the scale is not clear. `upcoming` lists what comes
 * within LOOK_AHEAD cycles, strictly after the cycle and soonest first: `{ kind: 'warning', begin,
 * end, warningIndex }` (only while the scale is clear) and `{ kind: 'part', begin, spanIndex, name,
 * length, change, scaleName }` for each named span after the first of the window, `change` being
 * 'same', 'changes' or 'unclear'; a part change comes before a warning at the same cycle. `chord` is
 * the chord sounding now (`{ name, notes, pcs }`, name null for an unknown shape, spelled by the
 * current scale when clear, else the default table), or null when fewer than two pitch classes sound
 * together in the span's harmonic segmentation.
 */
export function readingAt(reading, { cycle, cps, playing }) {
  if (typeof cycle !== 'number' || !Number.isFinite(cycle)) {
    throw new Error(`Moontide: the Jam reading needs a finite cycle, got ${String(cycle)}`);
  }
  if (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0) {
    throw new Error(`Moontide: the Jam reading needs a finite positive tempo in cycles per second, got ${String(cps)}`);
  }
  let span = reading.spans.find((s) => cycle >= s.begin - EPS && cycle < s.end - EPS);
  if (span === undefined) {
    span = {
      name: null,
      begin: reading.windowStart,
      end: reading.windowEnd,
      length: reading.windowEnd - reading.windowStart,
      scale: reading.whole,
      warnings: [],
    };
  }
  const position = { reading, cycle, cps, playing, span, scale: span.scale, warning: null, backInKey: null, nextWarning: null };
  position.chord = chordAt(span, cycle, span.scale.status === 'clear' ? span.scale.spell : DEFAULT_SPELL);
  position.upcoming = upcomingOf(reading, cycle, span.scale.status === 'clear');
  if (span.scale.status !== 'clear') return position;
  position.warning = reading.warnings.find((w) => cycle >= w.begin - EPS && cycle < w.end - EPS) ?? null;
  if (position.warning !== null) {
    const back = position.warning.backInKey;
    if (back - cycle < LOOK_AHEAD - EPS && back < reading.windowEnd - EPS) position.backInKey = back;
  }
  position.nextWarning = reading.warnings.find((w) => w.begin > cycle + EPS && w.begin - cycle <= LOOK_AHEAD + EPS) ?? null;
  return position;
}
