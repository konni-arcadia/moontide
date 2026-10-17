// Pure module for Moontide's browser page: the words of the note panel under the Timeline lanes. Every sentence is built
// from TIMELINE_COPY (page/timeline.js), so the panel, the history entry and the tests read the same text. Names that come
// from the code (a lane, a section, a token) are cut to 40 code points in a sentence. An id this module does not know
// (a reason a note cannot be edited, a refusal, a notice, a hint) throws, so a new one cannot be shown as a blank.
// Nothing here touches the DOM, so node:test and page/main.js import the module without a build step.

import { TIMELINE_COPY } from './timeline.js';
import { displayName } from './structure.js';
import { clipMixerLabel } from './mixer-model.js';

/** Fills the `{name}` places of a TIMELINE_COPY string; a place without a value throws (never a blank). */
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Moontide: the note panel copy needs a value for {${key}}.`);
    return String(values[key]);
  });
}

/** The sentence that says why a note cannot be edited. An unknown reason throws. */
export function reasonText(reason) {
  const text = Object.hasOwn(TIMELINE_COPY.noteReasons, reason) ? TIMELINE_COPY.noteReasons[reason] : undefined;
  if (typeof text !== 'string') throw new Error(`Moontide: unknown reason '${String(reason)}' for a note that cannot be edited.`);
  return text;
}

/** The word at the right of the identity line: Editable or Not editable. */
export function stateWord(info) {
  return info.editable ? TIMELINE_COPY.noteEditable : TIMELINE_COPY.noteNotEditable;
}

/** The muted part of the identity line after the lane name: the cycle and beat, and the section when the piece has one. */
export function positionText(info) {
  const where = fill(TIMELINE_COPY.notePosition, { cycle: info.cycle, beat: info.beat });
  return info.section === null || info.section === undefined ? where : where + fill(TIMELINE_COPY.noteSection, { section: displayName(info.section) });
}

/** What the panel says with no note selected. */
export function noneText() {
  return TIMELINE_COPY.noteNone;
}

/** The pitch as written, then its note number (`c3 · 48`); a note written as a number shows the number alone; a drum lane
 * adds the name of the drum. */
export function pitchValueText(info) {
  const written = String(info.noteText);
  const isNumber = /^-?\d+(\.\d+)?$/.test(written);
  const value = isNumber ? written : fill(TIMELINE_COPY.notePitchValue, { note: written, midi: info.midi });
  return typeof info.drum === 'string' && info.drum !== '' ? fill(TIMELINE_COPY.notePitchDrum, { value, drum: info.drum }) : value;
}

/** The velocity the Timeline computes (gain times velocity), two decimals; the word for a velocity it cannot compute. */
export function velocityValueText(velocity) {
  return typeof velocity === 'number' && Number.isFinite(velocity) ? velocity.toFixed(2) : TIMELINE_COPY.noteVelocityUnknown;
}

/**
 * The names of the sections a token plays in, as the sentence lists them: `'x'`, `'x' and 'z'`, `'x', 'y' and 'z'`, and from
 * five names on the first three and the number that are left (`'a', 'b', 'c' and 2 more`). At least one name.
 */
export function sectionList(names) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('Moontide: a list of sections needs at least one name.');
  const quoted = names.map((name) => fill(TIMELINE_COPY.noteSectionName, { name: displayName(name) }));
  if (quoted.length === 1) return quoted[0];
  if (quoted.length <= 4) return fill(TIMELINE_COPY.noteListAnd, { first: quoted.slice(0, -1).join(', '), last: quoted[quoted.length - 1] });
  return fill(TIMELINE_COPY.noteListMore, { first: quoted.slice(0, 3).join(', '), n: quoted.length - 3 });
}

/**
 * The sentence that says a token plays in several places, or null when it plays in one. `perCycle` is how many notes the
 * token draws in each cycle (a piece without a structure); `count` and `sections` are the places of a structured piece, and
 * `onPage` says they were counted on the drawn page alone.
 */
export function placesText({ count = 0, sections = [], perCycle = 0, onPage = false }) {
  if (perCycle > 1) return fill(TIMELINE_COPY.notePlacesPerCycle, { n: perCycle });
  if (count > 1) return fill(onPage ? TIMELINE_COPY.notePlacesOnPage : TIMELINE_COPY.notePlaces, { n: count, list: sectionList(sections) });
  return null;
}

/** The words that repeat the count after a change: ` in 3 places` (` in 3 places on this page`), nothing for one place. */
export function placesWords(count, onPage = false) {
  if (!(count > 1)) return '';
  return fill(onPage ? TIMELINE_COPY.notePlacesPageWords : TIMELINE_COPY.notePlacesWords, { n: count });
}

/**
 * The words that repeat the count of notes sharing a velocity number: `, for 4 notes on this page`, nothing for one note. With
 * `onPage` the places words before them already say "on this page", so they are not said twice: `, for 4 notes`.
 */
export function notesWords(count, onPage = false) {
  if (!(count > 1)) return '';
  return fill(onPage ? TIMELINE_COPY.noteVelocityNotesShort : TIMELINE_COPY.noteVelocityNotes, { n: count });
}

/**
 * The sentence that stands while nothing else is said: what the token's places are told as soon as they are known, or the
 * token an edit rewrites, or the reason the note is refused. `places` is `{ count, sections, onPage }` once the places of a
 * structured piece are counted, null before that; a piece without a structure carries its count in `info.perCycle`.
 */
export function standingText(info, places = null) {
  if (!info.editable) return reasonText(info.reason);
  const told = placesText(places === null ? { perCycle: info.perCycle ?? 0 } : places);
  if (told !== null) return told;
  return fill(TIMELINE_COPY.noteStanding, { token: displayName(info.seen.token.text) });
}

/** The size of a pitch change in words: `+1 semitone`, `-3 semitones`, `+1 octave`, `+2 octaves` (a multiple of 12 reads in octaves). */
export function deltaText(semitones) {
  if (!Number.isInteger(semitones) || semitones === 0) throw new Error(`Moontide: a pitch change is a whole number of semitones other than 0, got ${String(semitones)}.`);
  const sign = semitones > 0 ? '+' : '-';
  const size = Math.abs(semitones);
  if (size % 12 === 0) {
    const octaves = size / 12;
    return octaves === 1 ? fill(TIMELINE_COPY.noteDeltaOctave, { sign }) : fill(TIMELINE_COPY.noteDeltaOctaves, { sign, n: octaves });
  }
  return size === 1 ? fill(TIMELINE_COPY.noteDeltaSemitone, { sign }) : fill(TIMELINE_COPY.noteDeltaSemitones, { sign, n: size });
}

/**
 * The sentence while a note the page cannot edit is dragged: `Release to ask Claude: raise this note by 2 semitones.` or
 * `lower this note by 1 octave.` The change is never 0; nothing is written, the release prepares a request.
 */
export function refusedPreviewText(semitones) {
  // deltaText checks the change and writes it with its sign (`+2 semitones`); the sentence has the verb instead.
  const amount = deltaText(Math.abs(semitones)).slice(1);
  return fill(TIMELINE_COPY.noteRefusedPreview, { verb: semitones > 0 ? TIMELINE_COPY.noteRaise : TIMELINE_COPY.noteLower, amount });
}

/** The sentence after a request was put in the Ask box: nothing is sent until the person presses Enter. */
export function requestReadyText() {
  return TIMELINE_COPY.noteRequestReady;
}

/** One end of the preview: the note as written, then what a drum lane calls it. `drum` is null (not a drum lane), the drum's
 * name, or `{ map }` for a note the lane's map does not name (it reads like the drum rows do: `d2 · not in GM`). */
function previewEnd(written, drum) {
  const name = displayName(written);
  if (drum === null || drum === undefined) return name;
  if (typeof drum === 'string') return `${name} ${displayName(drum)}`;
  return fill(TIMELINE_COPY.drumNotInMap, { note: name, map: displayName(drum.map) });
}

/**
 * The sentence while a note is dragged: `c3 → d3 (+2 semitones). Release to write.` With `waiting` it is the sentence of steps
 * that wait for the pause before they are written: `c3 → d3 (+2 semitones). Writing in a moment.` The change is never 0. With
 * `places` above 1 the sentence repeats the count: `c3 → d3 (+2 semitones), in 3 places. Release to write.`
 */
export function previewText({ from, to, semitones, drumFrom = null, drumTo = null, waiting = false, places = 0, onPage = false }) {
  const template = waiting ? TIMELINE_COPY.noteStepPreview : TIMELINE_COPY.notePreview;
  const count = placesWords(places, onPage);
  return fill(template, { from: previewEnd(from, drumFrom), to: previewEnd(to, drumTo), delta: deltaText(semitones), places: count === '' ? '' : `,${count}` });
}

/** A velocity as the panel writes it: two decimals. */
function velocityWord(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Moontide: a velocity is a finite number, got ${String(value)}.`);
  return value.toFixed(2);
}

/**
 * The sentence while velocity steps wait for the pause: `Velocity 0.80 → 0.90. Writing in a moment.` With `notes` above 1
 * (the notes of the page that share the number) it says so: `Velocity 0.80 → 0.90, for 4 notes on this page. ...`, and with `places`
 * above 1 (where the number plays in a piece with a structure) it names them the way the result does: `Velocity 0.80 → 0.90
 * in 3 places, for 4 notes on this page. ...`
 */
export function velocityPreviewText({ from, to, notes = 0, places = 0, onPage = false }) {
  return fill(TIMELINE_COPY.noteVelocityPreview, { from: velocityWord(from), to: velocityWord(to), places: placesWords(places, onPage), notes: notesWords(notes, onPage && places > 1) });
}

/** The sentence of steps that were aimed at a note the lanes no longer hold as it was. */
export function stepsDroppedText() {
  return TIMELINE_COPY.noteStepsDropped;
}

/** The sentence of a rest or a drag that was aimed at a note the lanes no longer hold as it was. */
export function changeDroppedText() {
  return TIMELINE_COPY.noteChangeDropped;
}

/** The sentence of a rest or a drag the page could not write when it was due: the person makes it again. */
export function changeNotWrittenText() {
  return TIMELINE_COPY.noteChangeNotWritten;
}

/** The sentence of an edit the page gave no answer to in time: it may or may not have been written. */
export function editTimeoutText() {
  return TIMELINE_COPY.noteEditTimeout;
}

/**
 * A sentence about the edit of a note that is not the one the panel shows, named after that note: `c3 on t1: Changed c3 to
 * c#3.` The note and the lane are cut like every name in a sentence.
 */
export function namedText({ note, lane, text }) {
  if (typeof text !== 'string' || text === '') throw new Error('Moontide: a sentence about another note needs its words.');
  return fill(TIMELINE_COPY.noteNamed, { note: displayName(String(note)), lane: displayName(String(lane)), text });
}

/** The sentence of steps the page could not write when they were due: the person presses them again. */
export function stepsNotWrittenText() {
  return TIMELINE_COPY.noteStepsNotWritten;
}

/** The sentence when the velocity is at the end of its range: `lowest` or `highest`. */
export function velocityLimitText(kind) {
  if (kind === 'lowest') return TIMELINE_COPY.noteVelocityLowest;
  if (kind === 'highest') return TIMELINE_COPY.noteVelocityHighest;
  throw new Error(`Moontide: unknown limit '${String(kind)}' of a velocity.`);
}

/** The muted words after a velocity the page cannot write. */
export function velocityFixedText() {
  return TIMELINE_COPY.noteVelocityFixed;
}

/** The sentence when a velocity button is pressed for a velocity the page cannot write. */
export function velocityRefusalText() {
  return TIMELINE_COPY.noteVelocityRefusal;
}

/** The sentence when a drag is held at the end of the note range: `lowest` or `highest`. */
export function limitText(kind) {
  if (kind === 'lowest') return TIMELINE_COPY.noteLowest;
  if (kind === 'highest') return TIMELINE_COPY.noteHighest;
  throw new Error(`Moontide: unknown limit '${String(kind)}' of a note.`);
}

/** The sentence of a notice: `disconnected`, `waiting` or `unevaluated`. */
export function noticeText(kind) {
  const text = { disconnected: TIMELINE_COPY.noteNoticeDisconnected, waiting: TIMELINE_COPY.noteNoticeWaiting, unevaluated: TIMELINE_COPY.noteNoticeUnevaluated }[kind];
  if (typeof text !== 'string') throw new Error(`Moontide: unknown note panel notice '${String(kind)}'.`);
  return text;
}

/** The sentence of a refused edit: the id is one of the edit's own (`stale`, `read-back`) or one of the shared rewrite path. */
export function refusalText(reason) {
  switch (reason) {
    case 'stale':
      return TIMELINE_COPY.noteStale;
    case 'velocity-fixed':
      return TIMELINE_COPY.noteVelocityRefusal;
    case 'closed':
      return noticeText('disconnected');
    case 'waiting':
      return noticeText('waiting');
    case 'dirty':
      return noticeText('unevaluated');
    // The page hit an error it did not expect before it wrote the edit.
    case 'error':
      return TIMELINE_COPY.noteEditError;
    // The edit could not be proven, or the editor did not take it: the code is as it was and Claude can make the change.
    case 'read-back':
    case 'write-mismatch':
    case 'not-played':
    case 'no-parser':
      return TIMELINE_COPY.noteReadBack;
    default:
      throw new Error(`Moontide: unknown refusal '${String(reason)}' of a note edit.`);
  }
}

/**
 * The bold part of the identity line of a range: `Range · t1`. The lane name is as the Timeline shows it; the panel's element
 * carries it through textContent only.
 */
export function rangeWhereText(track) {
  if (typeof track !== 'string' || track === '') throw new Error('Moontide: a range needs the name of its lane.');
  return fill(TIMELINE_COPY.noteRangeWhere, { lane: track });
}

/** The longest section part of a range's identity line, the same 200 characters as every text of a request. */
const MAX_RANGE_SECTIONS_TEXT = 200;

/**
 * The section part of a range's identity line for `sections` (names in playing order) and the `moreSections` names a list already
 * left out. A list that fits shows whole; a longer one keeps the first names that, with ' and N more', fit 200 characters (at least
 * the first), and N counts every name not shown.
 */
function rangeSectionsText(sections, moreSections) {
  const quoted = sections.map((name) => `'${displayName(name)}'`);
  if (sections.length === 1 && moreSections === 0) return fill(TIMELINE_COPY.noteSection, { section: displayName(sections[0]) });
  const build = (shown) => {
    const left = sections.length - shown + moreSections;
    return fill(TIMELINE_COPY.noteRangeSectionList, { list: quoted.slice(0, shown).join(', ') }) + (left > 0 ? fill(TIMELINE_COPY.noteRangeSectionsMore, { n: left }) : '');
  };
  let shown = sections.length;
  while (shown > 1 && build(shown).length > MAX_RANGE_SECTIONS_TEXT) shown--;
  return build(shown);
}

/**
 * The muted part of the identity line of a range: ` · cycles 12 to 15` (` · cycle 12` for one), the sections it crosses when the
 * piece has a song (` · section 'y'`, ` · sections 'z', 'x', 'y'` in playing order, a section that comes back named again) and the
 * notes (` · 14 notes`, ` · 1 note`, ` · no notes`). `range` is `{ from, to, sections, moreSections, count }`; `sections` is a
 * list of names or absent (a piece without a song) and `moreSections` counts the names the list left out.
 */
export function rangePositionText({ from, to, sections = null, moreSections = 0, count }) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new Error('Moontide: a range has whole cycles, the last not before the first.');
  if (!Number.isInteger(count) || count < 0) throw new Error('Moontide: a range has a count of notes of at least 0.');
  if (!Number.isInteger(moreSections) || moreSections < 0) throw new Error('Moontide: a range has a count of more sections of at least 0.');
  if (sections !== null && sections.length === 0) throw new Error('Moontide: a range that names its sections names at least one section.');
  if (sections === null && moreSections > 0) throw new Error('Moontide: a range cannot have more sections without a list of sections.');
  let text = from === to ? fill(TIMELINE_COPY.noteRangeCycle, { a: from }) : fill(TIMELINE_COPY.noteRangeCycles, { a: from, b: to });
  if (sections !== null) text += rangeSectionsText(sections, moreSections);
  if (count === 0) return text + TIMELINE_COPY.noteRangeNoNotes;
  return text + (count === 1 ? TIMELINE_COPY.noteRangeOneNote : fill(TIMELINE_COPY.noteRangeNotes, { n: count }));
}

/** The muted part of the identity line of the keyboard cursor on a lane that has no note on the page. */
export function cursorPositionText() {
  return TIMELINE_COPY.noteCursorPosition;
}

/**
 * The name a screen reader gives the active note: `t1, cycle 0, beat 1: note c3, velocity 0.80. Editable.`, or `... Not editable.`
 * and the sentence of the reason. The lane is named whole.
 */
export function activeNoteName(info) {
  const state = info.editable ? TIMELINE_COPY.noteActiveEditable : fill(TIMELINE_COPY.noteActiveNotEditable, { reason: reasonText(info.reason) });
  return fill(TIMELINE_COPY.noteActiveName, {
    lane: info.track,
    cycle: info.cycle,
    beat: info.beat,
    note: info.noteText,
    velocity: velocityValueText(info.velocity),
    state,
  });
}

/** The name a screen reader gives the keyboard cursor on a lane with no note on the page: `bass, cycle 12: no notes on this page.` */
export function activeCursorName({ lane, cycle }) {
  if (typeof lane !== 'string' || lane === '') throw new Error('Moontide: the cursor of a lane needs the name of its lane.');
  if (!Number.isInteger(cycle)) throw new Error('Moontide: the cursor of a lane needs a whole cycle.');
  return fill(TIMELINE_COPY.noteActiveCursor, { lane, cycle });
}

/** The sentence of one hint: `none`, `editable`, `refused`, `range` or `cursor`. */
export function hintText(kind) {
  const text = {
    none: TIMELINE_COPY.noteHintNone,
    editable: TIMELINE_COPY.noteHintEditable,
    refused: TIMELINE_COPY.noteHintRefused,
    range: TIMELINE_COPY.noteHintRange,
    cursor: TIMELINE_COPY.noteHintCursor,
  }[kind];
  if (typeof text !== 'string') throw new Error(`Moontide: unknown note panel hint '${String(kind)}'.`);
  return text;
}

/**
 * What the sentence slot says about the outcome of one edit, `{ text, kind }` (`kind` is `result` or `refused`), or null
 * when the edit changed nothing and there is nothing to say. `outcome.what` is the kind of change, `pitch` (the default),
 * `rest` or `velocity`. An outcome the panel does not know throws.
 */
export function resultText(outcome) {
  const what = outcome.what === undefined ? 'pitch' : outcome.what;
  if (what !== 'pitch' && what !== 'rest' && what !== 'velocity') {
    throw new Error(`Moontide: unknown kind of change '${String(what)}' in the outcome of a note edit.`);
  }
  switch (outcome.kind) {
    case 'written':
      if (what === 'rest') return { kind: 'result', text: fill(TIMELINE_COPY.noteChangedRest, { from: displayName(outcome.from), places: placesWords(outcome.places, outcome.onPage === true) }) };
      if (what === 'velocity') return { kind: 'result', text: fill(TIMELINE_COPY.noteVelocityNow, { note: displayName(outcome.from), v: outcome.to, places: placesWords(outcome.places, outcome.onPage === true), notes: notesWords(outcome.notes, outcome.onPage === true && outcome.places > 1) }) };
      return { kind: 'result', text: fill(TIMELINE_COPY.noteChanged, { from: displayName(outcome.from), to: displayName(outcome.to), places: placesWords(outcome.places, outcome.onPage === true) }) };
    case 'waiting': {
      if (outcome.at !== 'bar' && outcome.at !== 'phrase') {
        throw new Error(`Moontide: a waiting note edit has the timing 'bar' or 'phrase', got '${String(outcome.at)}'.`);
      }
      const bar = outcome.at === 'bar';
      if (what === 'rest') {
        return { kind: 'result', text: fill(bar ? TIMELINE_COPY.noteWaitingBarRest : TIMELINE_COPY.noteWaitingPhraseRest, { from: displayName(outcome.from) }) };
      }
      if (what === 'velocity') {
        return { kind: 'result', text: fill(bar ? TIMELINE_COPY.noteWaitingBarVelocity : TIMELINE_COPY.noteWaitingPhraseVelocity, { note: displayName(outcome.from), v: outcome.to }) };
      }
      return { kind: 'result', text: fill(bar ? TIMELINE_COPY.noteWaitingBar : TIMELINE_COPY.noteWaitingPhrase, { from: displayName(outcome.from), to: displayName(outcome.to) }) };
    }
    case 'unchanged':
      if (outcome.limit === 'lowest') return { kind: 'result', text: what === 'velocity' ? TIMELINE_COPY.noteVelocityLowest : TIMELINE_COPY.noteLowest };
      if (outcome.limit === 'highest') return { kind: 'result', text: what === 'velocity' ? TIMELINE_COPY.noteVelocityHighest : TIMELINE_COPY.noteHighest };
      return null;
    case 'refused':
      // An error that came at or after the write leaves code that may have changed: the sentence does not say it is as it was.
      if (outcome.reason === 'error' && outcome.afterWrite === true) return { kind: 'refused', text: TIMELINE_COPY.noteEditErrorWritten };
      return { kind: 'refused', text: refusalText(outcome.reason) };
    case 'failed':
      return { kind: 'refused', text: TIMELINE_COPY.noteNotEvaluated };
    default:
      throw new Error(`Moontide: unknown outcome '${String(outcome.kind)}' of a note edit.`);
  }
}

/**
 * The history entry of one written edit, cut to the length the server keeps: `changed t1: c3 to c#3`, with `rest: true`
 * `changed t1: c3 to a rest`, and with `velocity` (the new velocity, a number) `changed t1: velocity of c3 to 0.90` (`from` is
 * the note). With `places` above 1 an entry ends with the count: `changed t1: c3 to c#3 in 3 places`, `changed t1: velocity of c3 to 0.90 in 3 places`.
 */
export function noteHistoryLabel({ track, from, to, rest = false, velocity = undefined, places = 0, onPage = false }) {
  const where = placesWords(places, onPage);
  if (rest) return clipMixerLabel(fill(TIMELINE_COPY.noteRecordRest, { track: displayName(track), from: displayName(from), places: where }));
  if (velocity !== undefined) return clipMixerLabel(fill(TIMELINE_COPY.noteRecordVelocity, { track: displayName(track), note: displayName(from), v: velocityWord(velocity), places: where }));
  return clipMixerLabel(fill(TIMELINE_COPY.noteRecord, { track: displayName(track), from: displayName(from), to: displayName(to), places: where }));
}
