// Pure module: the sliced 32-cycle Timeline query, the solo-evaluation helper and the
// Timeline's own copy. No DOM access at import time, so this module can be imported directly
// by node:test and by page/main.js without a build step.

import { BEATS_PER_CYCLE } from './change-timing.js';

/** Fixed page size for the Timeline: pages of 32 cycles. */
export const PAGE_CYCLES = 32;

/** Wall-time budget for one 32-cycle query (measured live; tuned by the probe). */
export const TIMELINE_BUDGET_MS = 2000;

/** How many cycles are queried per slice, with a yield to the page between slices. */
export const TIMELINE_SLICE_CYCLES = 4;

/**
 * Strudel records a .timeline(id) anchor only on its own scheduler query, so the Timeline
 * waits one scheduler tick plus margin after a new version starts playing before it queries —
 * the same span as FIRST_CYCLE_WATCH_MS (page/ui-state.js) — so every new .timeline(id) anchor
 * the new version writes has already landed before the Timeline reads it.
 */
export const TIMELINE_SETTLE_MS = 250;

export const TIMELINE_COPY = {
  nothingPlaying: 'Nothing is playing yet.',
  computing: 'Computing timeline…',
  tooSlow: "Timeline couldn't compute in time — showing the code instead.",
  failed: "Timeline couldn't compute this code — showing the code instead.",
  // Drum names on a MIDI rhythm lane whose map is known.
  drumTooltip: '{note} {name}',
  drumNotInMap: '{note} · not in {map}',
  drumsLabel: 'Drums: {names}',
  drumNumbered: 'note {note}',
  drumMapUnknown: ' · drum map unknown',
  drumRowsMax: 8,
  // The words of the note panel under the lanes: what it says about the selected note, what a change did and why a
  // note cannot be edited. page/note-panel.js builds every sentence from these strings and nowhere else.
  noteNone: 'No note selected',
  noteEditable: 'Editable',
  noteNotEditable: 'Not editable',
  notePosition: ' · cycle {cycle}, beat {beat}',
  noteSection: " · section '{section}'",
  notePitchLabel: 'Pitch',
  noteVelocityLabel: 'Velocity',
  notePitchValue: '{note} · {midi}',
  notePitchDrum: '{value} · {drum}',
  noteVelocityUnknown: 'unknown',
  notePitchDown: 'Pitch down',
  notePitchDownName: 'Lower pitch by a semitone',
  notePitchDownTitle: 'Lower pitch by a semitone (Down). Shift: an octave.',
  notePitchUp: 'Pitch up',
  notePitchUpName: 'Raise pitch by a semitone',
  notePitchUpTitle: 'Raise pitch by a semitone (Up). Shift: an octave.',
  noteVelocityDown: '−',
  noteVelocityDownName: 'Lower velocity',
  noteVelocityDownTitle: 'Lower velocity by 0.10',
  noteVelocityUp: '+',
  noteVelocityUpName: 'Raise velocity',
  noteVelocityUpTitle: 'Raise velocity by 0.10',
  noteVelocityFixed: 'fixed in the code',
  noteMakeRest: 'Make a rest',
  noteMakeRestName: 'Turn this note into a rest',
  noteMakeRestTitle: 'Turn this note into a rest (Delete)',
  noteAsk: 'Ask Claude',
  noteAskName: 'Ask Claude about this note',
  noteAskTitle: 'Opens the Ask box for this note.',
  // What a gesture on a note the page cannot edit does: the sentence while it is dragged, and the one after it is released.
  noteRefusedPreview: 'Release to ask Claude: {verb} this note by {amount}.',
  noteRaise: 'raise',
  noteLower: 'lower',
  noteRequestReady: 'Request ready in the Ask box. Nothing is sent until you press Enter.',
  noteHintNone: 'Click a note to edit it. Drag across an empty part of a lane to ask Claude about those cycles.',
  noteHintEditable: 'Drag the note or press Up / Down: a semitone, with Shift an octave. Delete makes a rest. Each edit is one History entry.',
  noteHintRefused: 'Up, Down, Make a rest, − and + prepare a request for Claude. Nothing is sent until you press Enter.',
  noteHintRange: 'Press Enter or Ask Claude to ask about these cycles. Esc clears the range.',
  // A range of cycles on one lane: the panel's identity line, built by page/note-panel.js, and what the Ask Claude button says then.
  noteRangeWhere: 'Range · {lane}',
  noteRangeCycles: ' · cycles {a} to {b}',
  noteRangeCycle: ' · cycle {a}',
  noteRangeSectionList: ' · sections {list}',
  noteRangeSectionsMore: ' and {n} more',
  noteRangeNotes: ' · {n} notes',
  noteRangeOneNote: ' · 1 note',
  noteRangeNoNotes: ' · no notes',
  noteRangeAskName: 'Ask Claude about these cycles',
  noteRangeAskTitle: 'Opens the Ask box for these cycles.',
  // The keyboard cursor on a lane that has no note on the page: the panel's identity line, its hint and what Ask Claude says then.
  noteCursorPosition: ' · no notes on this page',
  noteHintCursor: 'Press Enter or Ask Claude to ask about this lane. Shift+Left or Shift+Right selects cycles.',
  noteLaneAskName: 'Ask Claude about this lane',
  noteLaneAskTitle: 'Opens the Ask box for this lane.',
  // The name a screen reader gives the active note of the lanes (the lanes point at it with aria-activedescendant).
  noteActiveName: '{lane}, cycle {cycle}, beat {beat}: note {note}, velocity {velocity}. {state}',
  noteActiveEditable: 'Editable.',
  noteActiveNotEditable: 'Not editable. {reason}',
  noteActiveCursor: '{lane}, cycle {cycle}: no notes on this page.',
  noteStanding: 'An edit rewrites one token in the code: {token}.',
  // Where a token plays: the standing sentences, and the count the preview and the result repeat.
  notePlaces: 'Plays in {n} places: sections {list}. An edit changes all of them.',
  notePlacesOnPage:
    'Plays in {n} places on this page: sections {list}. An edit changes every place it plays, on this page and after it.',
  notePlacesPerCycle: 'This token draws {n} notes in each cycle. An edit changes all of them.',
  notePlacesWords: ' in {n} places',
  notePlacesPageWords: ' in {n} places on this page',
  noteVelocityNotes: ', for {n} notes on this page',
  noteVelocityNotesShort: ', for {n} notes',
  noteSectionName: "'{name}'",
  noteListAnd: '{first} and {last}',
  noteListMore: '{first} and {n} more',
  // The steps of a key or a button that were not written because the note they were aimed at is gone.
  noteStepsDropped: 'The steps you pressed were not written: the note changed in the code. Select it again.',
  noteStepsNotWritten: 'The steps you pressed were not written. Select the note and press them again.',
  noteChangeDropped: 'The change was not written: the note changed in the code. Select it again.',
  noteChangeNotWritten: 'The change you made was not written. Select the note and make it again.',
  noteEditTimeout: 'The page did not answer this edit in time, so check the code.',
  noteNamed: '{note} on {lane}: {text}',
  noteChanged: 'Changed {from} to {to}{places}.',
  noteChangedRest: 'Changed {from} to a rest{places}.',
  noteVelocityNow: 'Velocity of {note} is now {v}{places}{notes}.',
  noteWaitingBar: 'Waiting for the next bar — {from} becomes {to}.',
  noteWaitingPhrase: 'Waiting for the next phrase — {from} becomes {to}.',
  noteWaitingBarRest: 'Waiting for the next bar — {from} becomes a rest.',
  noteWaitingPhraseRest: 'Waiting for the next phrase — {from} becomes a rest.',
  noteWaitingBarVelocity: 'Waiting for the next bar — {note} velocity becomes {v}.',
  noteWaitingPhraseVelocity: 'Waiting for the next phrase — {note} velocity becomes {v}.',
  // The sentence while a note is dragged, and the size of the change in it.
  notePreview: '{from} → {to} ({delta}){places}. Release to write.',
  noteDeltaSemitone: '{sign}1 semitone',
  noteDeltaSemitones: '{sign}{n} semitones',
  noteDeltaOctave: '{sign}1 octave',
  noteDeltaOctaves: '{sign}{n} octaves',
  // The sentence while steps of a key or a button wait for the pause before they are written.
  noteStepPreview: '{from} → {to} ({delta}){places}. Writing in a moment.',
  noteVelocityPreview: 'Velocity {from} → {to}{places}{notes}. Writing in a moment.',
  noteLowest: 'Already the lowest note.',
  noteHighest: 'Already the highest note.',
  noteVelocityLowest: 'Velocity is already at the lowest (0.10).',
  noteVelocityHighest: 'Velocity is already at the highest (1.00).',
  noteVelocityRefusal:
    "The velocity of this note comes from something the page can't change here, like a signal or an option of .midi(). Ask Claude to change it.",
  noteStale: 'That note changed in the code since you selected it. Nothing was changed. Select it again, or ask Claude.',
  noteReadBack: "The page couldn't confirm this edit, so the code is as it was. Ask Claude to make it.",
  noteEditError: 'The page ran into a problem before it changed this note, so the code is as it was. Ask Claude to make the change.',
  noteEditErrorWritten: 'The page ran into a problem after it wrote this change, so check the code.',
  noteNotEvaluated: 'The change did not evaluate, so the code is as it was. Ask Claude to make it.',
  noteNoticeDisconnected: 'Disconnected — editing is off until Moontide reconnects.',
  noteNoticeWaiting: 'A change is waiting for its bar line. Editing works again when it takes over.',
  noteNoticeUnevaluated: 'The editor has changes that are not playing yet. Evaluate them first — editing works on the playing code.',
  // The history entry of one written edit.
  noteRecord: 'changed {track}: {from} to {to}{places}',
  noteRecordRest: 'changed {track}: {from} to a rest{places}',
  noteRecordVelocity: 'changed {track}: velocity of {note} to {v}{places}',
  // Why a note cannot be edited, one sentence for each reason page/note-locate.js gives (NOTE_REASONS).
  noteReasons: {
    'no-token':
      'Made by a function or by chance, or written in a single-quoted string, so no single place in the code holds this note. Ask Claude to change it.',
    'no-pitch': 'This is a sample, not a pitched note, so there is no pitch to change. Ask Claude to change it.',
    several:
      'Shaped by several places in the code (an added note or a factor like *2), so no one place can be edited. Ask Claude to change it.',
    degrees: "Written in degrees. The page doesn't edit those directly yet. Ask Claude to change it.",
    escape:
      "The string that holds this note has an escape sequence, so the page can't find the note in the code. Ask Claude to change it.",
    shifted: 'The pitch you hear is not the pitch written: something adds to it or copies it. Ask Claude to change it.',
    outside:
      "Written outside this track's own code (its statement, or its variations in a song), so the page doesn't edit it here. Ask Claude to change it.",
    shared: 'Comes from code shared by several tracks, so an edit here would change them too. Ask Claude to change it.',
  },
};

/** Cycle count from which the next page starts computing in the background, while the current
 * page keeps showing (the Timeline is recomputed at every new version and never shows something
 * false; the turn is a plain cut to an already-computed page whenever possible). */
export const PREFETCH_FROM_CYCLE = 24;

/** The 32-cycle page containing `cycle`, clamped to at least 0 first (a negative or NaN clock
 * reading — see page/main.js's own clamp — must never produce a negative page). */
export function pageStartOf(cycle) {
  const clamped = Math.max(0, cycle);
  return Math.floor(clamped / PAGE_CYCLES) * PAGE_CYCLES;
}

/** The playhead's own cycle position: the exact (fractional) cycle with motion on, floored to
 * the last whole cycle with motion off. */
export function playheadCycle(now, motion) {
  return motion === 'off' ? Math.floor(now) : now;
}

/**
 * Which side of the playhead line its cycle reading is drawn on. The reading is drawn right
 * after the line while it fits inside the track column, and right before it otherwise; its
 * measured width is the same on both sides. All three arguments are viewport x positions or
 * widths in px, measured in the page: the line's right edge, the reading's width and the track
 * column's right edge. A hidden Timeline body measures as all zeros, which answers 'right'.
 */
export function playheadReadingSide(lineRight, readingWidth, columnRight) {
  for (const [name, value] of [['lineRight', lineRight], ['readingWidth', readingWidth], ['columnRight', columnRight]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`playheadReadingSide: ${name} must be a finite number, got ${String(value)}`);
    }
  }
  return lineRight + readingWidth > columnRight ? 'left' : 'right';
}

/** 32 ruler marks for the page starting at `pageStart`: `{ cycle, x, labeled }`, `x` is the
 * cycle's offset within the page (0..31), `labeled` true every 4 cycles. */
export function rulerMarks(pageStart) {
  const marks = [];
  for (let offset = 0; offset < PAGE_CYCLES; offset++) {
    marks.push({ cycle: pageStart + offset, x: offset, labeled: offset % 4 === 0 });
  }
  return marks;
}

// --- Pitch, lane shapes, loop detection, track colors ---

/** Number of colors in the track identification palette: a 9th distinct track reuses color 1. */
export const TRACK_COLOR_COUNT = 8;

const NOTE_BASE_SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * The spelling of a note name that Strudel itself plays: a letter in either case, lower-case accidentals (`#`, `s`, `b`, `f`) and an
 * optional octave. noteNameToMidi reads a capital accidental too (`EB3`), which Strudel does not play, so a token is edited only when it
 * matches this: the spelling the page edits and the one the sound engine plays are the same.
 */
export const NOTE_NAME_TOKEN = /^([a-gA-G])([#sbf]*)(-?\d+)?$/;
const DEFAULT_NOTE_OCTAVE = 3;

/**
 * MIDI note number from a Strudel note name — letter (a-g, case-insensitive), any number of
 * `#`/`s` (sharp, +1 each) and/or `b`/`f` (flat, -1 each) accidentals, and an optional octave
 * (default 3, matching Strudel's own default). `null` for anything that doesn't parse as a
 * plain note name (a mini-notation pattern string, for example).
 */
export function noteNameToMidi(note) {
  const match = /^([a-g])((?:[#sbf])*)(-?\d+)?$/.exec(note.toLowerCase());
  if (!match) return null;
  const [, letter, accidentals, octaveText] = match;
  let semitone = NOTE_BASE_SEMITONE[letter];
  for (const accidental of accidentals) {
    semitone += accidental === '#' || accidental === 's' ? 1 : -1;
  }
  const octave = octaveText !== undefined ? Number(octaveText) : DEFAULT_NOTE_OCTAVE;
  // An octave digit string long enough to overflow Number() (e.g. hundreds of digits) parses to
  // Infinity/-Infinity rather than NaN — reject it here so it can never reach pitchOf() as a
  // non-finite pitch.
  if (!Number.isFinite(octave)) return null;
  // A finite but huge octave (hundreds of digits) still overflows once multiplied by 12, so the
  // result is checked too.
  const midi = (octave + 1) * 12 + semitone;
  return Number.isFinite(midi) ? midi : null;
}

/**
 * The pitch (MIDI note number, possibly fractional for a freq-derived value) of one event's
 * value, or `null` for a value with no note or freq — percussion, a bare sample index, or
 * anything not shaped like a hap value at all.
 */
export function pitchOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.note === 'number') return Number.isFinite(value.note) ? value.note : null;
  if (typeof value.note === 'string') return noteNameToMidi(value.note);
  if (typeof value.freq === 'number' && Number.isFinite(value.freq) && value.freq > 0) {
    return 69 + 12 * Math.log2(value.freq / 440);
  }
  return null;
}

/**
 * The note number of one event's value when it is a drum note: `value.note` is a whole number from 0 to 127,
 * or a note name that reads as one. `null` otherwise; a frequency never counts (a drum is a note number, never a
 * pitch). The Timeline's drum rows and the moment both use it, so note("c2") and note("36") behave alike.
 */
export function drumNoteOf(value) {
  if (!value || typeof value !== 'object') return null;
  let note = null;
  if (typeof value.note === 'number') note = value.note;
  else if (typeof value.note === 'string') note = noteNameToMidi(value.note);
  return Number.isInteger(note) && note >= 0 && note <= 127 ? note : null;
}

/**
 * The set of `index` of every track whose `identity` is in `drums`. `drums` is what page/main.js laneTags() returns
 * (a track identity to its drum-map use; a Set of identities works too). The rig's rhythm channel is the only rule:
 * a note range never makes a track a drum track, so a track whose port is unreadable or not in the rig is not found.
 */
export function drumTrackIndexes(tracks, drums) {
  const out = new Set();
  for (const track of tracks) if (drums.has(track.identity)) out.add(track.index);
  return out;
}

/** True when two sets of track indexes hold the same indexes (the drum set before and after a rig message). */
export function sameIndexSet(a, b) {
  if (a.size !== b.size) return false;
  for (const index of a) if (!b.has(index)) return false;
  return true;
}

/** The narrowest a note is drawn, in cycles: a shorter note still shows as this wide, and a moment counts that width. */
export const MIN_DRAWN_WIDTH = 0.05;

/**
 * Render shapes for one lane's already page-sliced events: a note event (pitchOf(value) !==
 * null) gets `{ kind: 'note', x, width, y }` with `y` placed within THIS lane's own pitch range
 * (0 = highest pitch, 1 = lowest; a lane with only one distinct pitch centers at 0.5). An event
 * with no pitch gets `{ kind: 'tick', x, width }` (drawn at full lane height by the caller). `x`
 * is `begin - pageStart`; `width` is clipped to the page end (`pageStart + PAGE_CYCLES`), never
 * below MIN_DRAWN_WIDTH.
 */
export function laneShapes(events, pageStart) {
  const pageEnd = pageStart + PAGE_CYCLES;
  const pitches = events.map((event) => pitchOf(event.value)).filter((pitch) => pitch !== null);
  const minPitch = pitches.length ? Math.min(...pitches) : 0;
  const maxPitch = pitches.length ? Math.max(...pitches) : 0;
  return events.map((event) => {
    const x = event.begin - pageStart;
    const width = Math.max(Math.min(event.end, pageEnd) - event.begin, MIN_DRAWN_WIDTH);
    const pitch = pitchOf(event.value);
    if (pitch === null) {
      return { kind: 'tick', x, width };
    }
    const y = maxPitch === minPitch ? 0.5 : 1 - (pitch - minPitch) / (maxPitch - minPitch);
    return { kind: 'note', x, width, y };
  });
}

/** Stable key for one event's value, ignoring the keys in `ignoreKeys` (a slow filter's
 * own moving control never hides a note loop that repeats underneath it). */
function loopValueKey(value, ignoreKeys) {
  if (ignoreKeys.length === 0 || !value || typeof value !== 'object') return stableStringify(value);
  const filtered = {};
  for (const key of Object.keys(value)) {
    if (!ignoreKeys.includes(key)) filtered[key] = value[key];
  }
  return stableStringify(filtered);
}

/**
 * The smallest period `p` (1..16 cycles) such that every event beginning in
 * `[pageStart, pageStart + 32 - p)`, shifted forward by `p` cycles, equals as a multiset every
 * event beginning in `[pageStart + p, pageStart + 32)` (value compared with `ignoreKeys`
 * dropped) — or `null` when no such period exists. A period that would compare two empty
 * windows is skipped (never reported as a "loop" of a lane with nothing playing in it).
 */
export function loopPeriod(events, pageStart, ignoreKeys = []) {
  const pageEnd = pageStart + PAGE_CYCLES;
  for (let period = 1; period <= 16; period++) {
    const earlyEnd = pageEnd - period;
    const lateStart = pageStart + period;
    const early = events.filter((event) => event.begin >= pageStart && event.begin < earlyEnd);
    const late = events.filter((event) => event.begin >= lateStart && event.begin < pageEnd);
    if (early.length === 0 || early.length !== late.length) continue;

    const counts = new Map();
    for (const event of early) {
      const key = `${(event.begin + period).toFixed(9)}|${(event.end + period).toFixed(9)}|${loopValueKey(event.value, ignoreKeys)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let matched = true;
    for (const event of late) {
      const key = `${event.begin.toFixed(9)}|${event.end.toFixed(9)}|${loopValueKey(event.value, ignoreKeys)}`;
      const count = counts.get(key);
      if (!count) {
        matched = false;
        break;
      }
      if (count === 1) counts.delete(key);
      else counts.set(key, count - 1);
    }
    if (matched && counts.size === 0) return period;
  }
  return null;
}

/** Plain-word label for a loop period (the lane sub-label). Empty string for
 * `null` (no loop found — page/main.js shows nothing for that lane). */
export function loopLabel(period) {
  if (period === null) return '';
  return period === 1 ? 'repeats every cycle' : `repeats every ${period} cycles`;
}

/**
 * A registry assigning each distinct track identity one of TRACK_COLOR_COUNT colors (1-based),
 * in first-seen order, wrapping back to 1 after the 8th — kept for the whole page session, not reset per version or per Timeline open.
 */
export function createTrackColors() {
  const assigned = new Map();
  return {
    colorOf(identity) {
      const existing = assigned.get(identity);
      if (existing !== undefined) return existing;
      const color = (assigned.size % TRACK_COLOR_COUNT) + 1;
      assigned.set(identity, color);
      return color;
    },
  };
}

/**
 * One `[x, y]` point per event whose value carries a finite, positive `control` value (a filter curve), `x` at `begin - pageStart`, `y` on a LOG scale between the
 * lane's own min (bottom, y=1) and max (top, y=0) control value — 0.5 when every value is
 * equal. `[]` when no event in `events` carries the control at all.
 */
export function curvePoints(events, control, pageStart) {
  const values = events
    .map((event) => event.value && event.value[control])
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (values.length === 0) return [];
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const logMin = Math.log(minValue);
  const logMax = Math.log(maxValue);
  const points = [];
  for (const event of events) {
    const value = event.value && event.value[control];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const y = maxValue === minValue ? 0.5 : 1 - (Math.log(value) - logMin) / (logMax - logMin);
    points.push([event.begin - pageStart, y]);
  }
  return points;
}

// rand/perlin/choose/degradeBy/someCyclesBy are ALL built on a pure hash of (cycle position,
// randSeed) — never Math.random(). Querying ahead of playback returns the exact values the
// scheduler will produce when it actually gets there.

const AsyncFunctionConstructor = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Builds and awaits an AsyncFunction from `body` (a soloSource() result) — the same
 * `Function(...)`-based mechanism the pinned bundle's own safeEval uses internally, but never
 * through editor.repl.evaluate(), so it never touches the scheduler or starts real playback.
 * Throws a 'Moontide: ...' error when the result is not a queryable pattern.
 */
export async function evaluateSolo(body) {
  const fn = new AsyncFunctionConstructor(body);
  const result = await fn();
  if (!result || typeof result.queryArc !== 'function') {
    throw new Error('Moontide: solo evaluation did not produce a pattern with queryArc.');
  }
  return result;
}

/** Deterministic string key for one event, stable regardless of key order or arrival order. */
export function eventKey(event) {
  return `${event.begin.toFixed(9)}|${event.end.toFixed(9)}|${stableStringify(event.value)}`;
}

function stableStringify(value) {
  if (typeof value === 'function') return '"[function]"';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Multiset equality of two event arrays by eventKey — order never matters, count does. */
export function sameEvents(a, b) {
  if (a.length !== b.length) return false;
  const counts = new Map();
  for (const event of a) {
    const key = eventKey(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const event of b) {
    const key = eventKey(event);
    const count = counts.get(key);
    if (!count) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
  }
  return counts.size === 0;
}

function toEvent(hap) {
  return { begin: hap.whole.begin.valueOf(), end: hap.whole.end.valueOf(), value: hap.value };
}

/**
 * One event of a lane: the same fields as the real pattern's events, plus `locations`, plain copies of the places in the
 * code the note was read from, `[{ start, end }]` offsets into the code that was evaluated, or null when the note has none
 * (a value made by a function, a hap without a context such as a test double). The real pattern's events keep no
 * locations, so the check that the lanes add up to the real pattern never looks at them. Exported so the page reads the
 * edited track back into the same shape.
 */
export function toLaneEvent(hap) {
  const raw = hap.context && Array.isArray(hap.context.locations) ? hap.context.locations : null;
  const locations = raw === null ? null : raw.map((location) => ({ start: location.start, end: location.end }));
  return { begin: hap.whole.begin.valueOf(), end: hap.whole.end.valueOf(), value: hap.value, locations };
}

/**
 * Queries the real pattern and every unmuted track's own solo pattern over `pageCycles`
 * cycles starting at `pageStart`, in slices of `sliceCycles` with a yield to the page between
 * slices, and proves the union of every track's events equals the real pattern's events
 * before returning any lane data. Never draws a partial or unproven timeline: `ok` is the
 * only state carrying lane data, and it is returned only when every slice of every track has
 * been queried and the union check has passed.
 */
export async function computeTimeline({
  tracks,
  soloPattern,
  combinedPattern,
  pageStart,
  pageCycles,
  budgetMs,
  sliceCycles,
  clock,
  yieldToPage,
  isCancelled,
}) {
  const start = clock();
  try {
    // soloPattern(track) is async (it goes through evaluateSolo's own await) — every track's
    // solo pattern must be resolved before any queryArc call below, or trackPatterns[index]
    // would still be a Promise, not a queryable Pattern.
    const trackPatterns = await Promise.all(tracks.map((track) => (track.muted ? null : soloPattern(track))));
    if (isCancelled()) return { state: 'cancelled' };
    if (clock() - start > budgetMs) return { state: 'too-slow', computeMs: clock() - start };

    const laneEvents = tracks.map(() => []);
    const realEvents = [];
    let longestSliceMs = 0;

    for (let offset = 0; offset < pageCycles; offset += sliceCycles) {
      const sliceStart = clock();
      const from = pageStart + offset;
      const to = Math.min(pageStart + offset + sliceCycles, pageStart + pageCycles);

      for (const hap of combinedPattern.queryArc(from, to)) {
        if (hap.whole && hap.hasOnset()) realEvents.push(toEvent(hap));
      }
      tracks.forEach((track, index) => {
        const pattern = trackPatterns[index];
        if (!pattern) return;
        for (const hap of pattern.queryArc(from, to)) {
          if (hap.whole && hap.hasOnset()) laneEvents[index].push(toLaneEvent(hap));
        }
      });

      const now = clock();
      const sliceMs = now - sliceStart;
      if (sliceMs > longestSliceMs) longestSliceMs = sliceMs;
      if (now - start > budgetMs) return { state: 'too-slow', computeMs: now - start };
      await yieldToPage();
      if (isCancelled()) return { state: 'cancelled' };
    }

    const unionEvents = laneEvents.flat();
    if (!sameEvents(unionEvents, realEvents)) {
      return { state: 'failed', reason: 'mismatch', trackCount: unionEvents.length, realCount: realEvents.length };
    }
    return {
      state: 'ok',
      lanes: tracks.map((track, index) => ({ index: track.index, events: laneEvents[index] })),
      computeMs: clock() - start,
      longestSliceMs,
    };
  } catch (err) {
    return { state: 'failed', reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// --- A moment of the music under the pointer ---

/** The sixteenths of one bar (one cycle): four beats of four. */
export const SIXTEENTHS_PER_CYCLE = BEATS_PER_CYCLE * 4;

/**
 * The most notes one moment carries; the rest are counted in `more`. Mirrors src/protocol.ts's
 * MAX_MOMENT_NOTES by hand (test/ask.test.js checks both are 32).
 */
export const MAX_MOMENT_NOTES = 32;

/**
 * The most cycles one range covers: the cycles of a page. Mirrors src/protocol.ts's MAX_RANGE_CYCLES by hand
 * (test/ask.test.js checks both are 32).
 */
export const MAX_RANGE_CYCLES = 32;

// Float noise allowed when an event edge is compared with the instant, in cycles.
const MOMENT_EPSILON = 1e-9;

// The pinned Strudel bundle's defaults for the level of a note: a browser track plays at gain 0.8 x
// velocity 1, a MIDI track sends velocity 0.9 at gain 1 (velocity = gain x velocity).
const BROWSER_LEVEL = { gain: 0.8, velocity: 1 };
const MIDI_LEVEL = { gain: 1, velocity: 0.9 };

/**
 * The cycle under the pointer on a Timeline lane: `fraction` is how far along the lane's event area the
 * pointer is (0 at its left edge, 1 at its right edge), clamped inside the page's cycles. The one rule for
 * the cycle: a lane's context cycle and a moment's cycle both come from here.
 */
export function cycleAt({ pageStart, fraction }) {
  return pageStart + Math.min(PAGE_CYCLES - 1, Math.floor(Math.max(0, fraction) * PAGE_CYCLES));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * gain x velocity of one event, or undefined when a factor on the event is not a finite number or the
 * product is negative. A velocity or gain written only in the `.midi(port, { ... })` options is not on
 * the event and is not seen here: such a note reads the default 0.9 (the reference documents
 * `.velocity()` on the pattern).
 */
export function velocityOf(value, midi) {
  const defaults = midi ? MIDI_LEVEL : BROWSER_LEVEL;
  const set = value && typeof value === 'object' ? value : {};
  const gain = set.gain === undefined ? defaults.gain : set.gain;
  const velocity = set.velocity === undefined ? defaults.velocity : set.velocity;
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return undefined;
  if (typeof velocity !== 'number' || !Number.isFinite(velocity)) return undefined;
  const product = gain * velocity;
  return product < 0 ? undefined : Math.round(product * 100) / 100;
}

/**
 * The gain of one event as the pinned bundle would apply it: the gain set on the event, else the default of a browser track
 * (0.8) or a MIDI track (1). It may not be a number (a signal), which the caller must check.
 */
export function gainOf(value, midi) {
  const set = value && typeof value === 'object' ? value : {};
  return set.gain === undefined ? (midi ? MIDI_LEVEL : BROWSER_LEVEL).gain : set.gain;
}

function momentNote(lane, event, state) {
  const value = event.value && typeof event.value === 'object' ? event.value : {};
  const note = { track: lane.track };
  if (typeof lane.instrument === 'string' && lane.instrument !== '') note.instrument = lane.instrument;
  if ((typeof value.note === 'string' && value.note !== '') || (typeof value.note === 'number' && Number.isFinite(value.note))) {
    note.note = value.note;
  }
  // The drum name the lane's own map gives the note; absent when there is no map or it does not name the note.
  if (lane.drumMap !== null && lane.drumMap !== undefined) {
    const drumNote = drumNoteOf(event.value);
    if (drumNote !== null && lane.drumMap.byNote.has(drumNote)) note.drum = lane.drumMap.byNote.get(drumNote);
  }
  if (typeof value.s === 'string' && value.s !== '') note.sound = value.s;
  const velocity = velocityOf(event.value, lane.midi === true);
  if (velocity !== undefined) note.velocity = velocity;
  note.start = round3(event.begin);
  note.end = round3(event.end);
  note.state = state;
  return note;
}

/**
 * What the Timeline shows at the instant under the pointer: `{ cycle, beat, at, version, notes, more }`.
 * `pageStart` is the first cycle of the drawn page, `fraction` how far along the lane's event area the
 * pointer is (clamped to 0..1), `lanes` what was drawn, `[{ track, midi, instrument, drumMap, events }]` with events
 * `{ begin, end, value }` as the Timeline queried them and `drumMap` null, absent or `{ name, byNote: Map<number, string> }`
 * (the drum map of a rhythm lane, which names the drum of each of its notes the map holds), `version` the version playing at the click (null
 * when unknown). A note is `sounding` when its drawn span holds the instant (end exclusive; a note shorter than
 * MIN_DRAWN_WIDTH is drawn that wide and counts that wide) and `starts` when it begins after the instant and
 * before the end of the sixteenth of the bar that holds it; a note that began earlier in that sixteenth and
 * already ended is not in the moment, and nothing else is. `notes` keeps lane order then start, at most
 * MAX_MOMENT_NOTES; `more` counts the rest. `focusTrack`, the shown name of the lane the user right-clicked,
 * puts that lane's notes first, so the cap never drops the notes the user pointed at in favor of other lanes.
 * Bad input is a loud TypeError.
 */
export function momentAt({ pageStart, fraction, lanes, version, focusTrack }) {
  if (!Number.isInteger(pageStart) || pageStart < 0) {
    throw new TypeError(`momentAt: pageStart must be a non-negative integer, got ${String(pageStart)}`);
  }
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    throw new TypeError(`momentAt: fraction must be a finite number, got ${String(fraction)}`);
  }
  if (!Array.isArray(lanes)) {
    throw new TypeError(`momentAt: lanes must be an array, got ${String(lanes)}`);
  }
  if (version !== null && !(Number.isInteger(version) && version > 0)) {
    throw new TypeError(`momentAt: version must be null or a positive integer, got ${String(version)}`);
  }
  if (focusTrack !== undefined && typeof focusTrack !== 'string') {
    throw new TypeError(`momentAt: focusTrack must be undefined or a string, got ${String(focusTrack)}`);
  }
  for (const { drumMap } of lanes) {
    if (drumMap === null || drumMap === undefined) continue;
    if (typeof drumMap !== 'object' || typeof drumMap.name !== 'string' || !(drumMap.byNote instanceof Map)) {
      throw new TypeError(`momentAt: drumMap must be null or { name, byNote: Map }, got ${String(drumMap)}`);
    }
  }
  const cycle = cycleAt({ pageStart, fraction });
  const raw = Math.min(1, Math.max(0, fraction)) * PAGE_CYCLES - (cycle - pageStart);
  // Fraction 1 (or more) lands just before the end of the last cycle, never on the next one.
  const offset = Math.min(raw, 1 - MOMENT_EPSILON);
  // The instant is the one Claude reads (three decimals, never reaching the next cycle: 40.9996 is 40.999, still
  // beat 4 of cycle 40); the beat, the sixteenth and every note are worked out from it, never from the
  // unrounded pointer, so `at` and `beat` cannot disagree.
  const instant = Math.min(round3(cycle + offset), cycle + 0.999);
  const thousandths = Math.round((instant - cycle) * 1000);
  const beat = Math.floor((thousandths * BEATS_PER_CYCLE) / 1000) + 1;
  const sixteenth = Math.floor((thousandths * SIXTEENTHS_PER_CYCLE) / 1000);
  const cellEnd = cycle + (sixteenth + 1) / SIXTEENTHS_PER_CYCLE;
  const notes = [];
  const ordered =
    focusTrack === undefined
      ? lanes
      : [...lanes.filter((lane) => lane.track === focusTrack), ...lanes.filter((lane) => lane.track !== focusTrack)];
  for (const lane of ordered) {
    const laneNotes = [];
    for (const event of lane.events) {
      // The drawn span, so a note the user can see under the pointer is a note of the moment.
      const drawnEnd = event.begin + Math.max(event.end - event.begin, MIN_DRAWN_WIDTH);
      const sounding = event.begin <= instant + MOMENT_EPSILON && instant < drawnEnd - MOMENT_EPSILON;
      if (sounding) {
        laneNotes.push(momentNote(lane, event, 'sounding'));
      } else if (event.begin > instant + MOMENT_EPSILON && event.begin < cellEnd - MOMENT_EPSILON) {
        laneNotes.push(momentNote(lane, event, 'starts'));
      }
    }
    laneNotes.sort((a, b) => a.start - b.start);
    notes.push(...laneNotes);
  }
  return {
    cycle,
    beat,
    at: instant,
    version,
    notes: notes.slice(0, MAX_MOMENT_NOTES),
    more: Math.max(0, notes.length - MAX_MOMENT_NOTES),
  };
}

/**
 * The notes of one lane that start in the whole cycles `from` to `to` (both included): `{ notes, more }`. A note counts when its
 * start is at least `from` and before `to + 1`, so one that started earlier and still sounds is not in it, and one that starts
 * exactly at `to + 1` is not either. `lane` is `{ track, midi, instrument, drumMap, events }` as `momentAt` takes it. Each
 * note is shaped like a moment note (the same fields, built by the same code) without its state, in order of start and then of
 * pitch, the lower first; at most MAX_MOMENT_NOTES are kept and `more` counts the rest. Bad input is a loud TypeError.
 */
export function rangeNotes(lane, from, to) {
  if (lane === null || typeof lane !== 'object' || !Array.isArray(lane.events)) {
    throw new TypeError(`rangeNotes: lane must hold an events array, got ${String(lane)}`);
  }
  if (!Number.isInteger(from) || from < 0) throw new TypeError(`rangeNotes: from must be a non-negative integer, got ${String(from)}`);
  if (!Number.isInteger(to) || to < from || to - from >= MAX_RANGE_CYCLES) {
    throw new TypeError(`rangeNotes: to must be an integer from ${from} to ${from + MAX_RANGE_CYCLES - 1}, got ${String(to)}`);
  }
  const inside = lane.events.filter((event) => event.begin >= from - MOMENT_EPSILON && event.begin < to + 1 - MOMENT_EPSILON);
  const keyed = inside.map((event) => ({ event, pitch: pitchOf(event.value) }));
  // A note without a pitch (a sample, a tick) sorts after the pitched notes that start with it.
  keyed.sort((a, b) => a.event.begin - b.event.begin || (a.pitch ?? Infinity) - (b.pitch ?? Infinity) || 0);
  const notes = keyed.slice(0, MAX_MOMENT_NOTES).map(({ event }) => {
    const note = momentNote(lane, event, 'sounding');
    delete note.state;
    return note;
  });
  return { notes, more: Math.max(0, keyed.length - MAX_MOMENT_NOTES) };
}
