// Pure module for Moontide's browser page: the edit of one note on the Timeline. It turns the token a note leads back to
// into its neighbour a semitone away, builds the one-token edit list and writes it through the page's shared rewrite path
// after the page has read the edited track back. The text written is built from a closed grammar (a note letter, its
// accidentals, an octave digit, or a number) and never from free text, and the rest of the code stays byte for byte as it
// was. Nothing here touches the DOM or a global: the write goes through the dependencies it is given, so node:test drives
// it with fakes and page/main.js passes the real ones.

import { applyEdits } from './mixer-rewrite.js';
import { compareReadBack, sameTokenEvents } from './note-locate.js';
import { noteHistoryLabel } from './note-panel.js';
import { NOTE_NAME_TOKEN, noteNameToMidi } from './timeline.js';

/** The reasons an edit is refused by this module (the shared rewrite path has its own). */
export const NOTE_EDIT_REFUSALS = Object.freeze(['stale', 'read-back']);

/** Raised to stop an edit before anything is written; `reason` is one of NOTE_EDIT_REFUSALS. */
export class NoteEditStop extends Error {
  constructor(reason) {
    if (!NOTE_EDIT_REFUSALS.includes(reason)) throw new Error(`Moontide: unknown note edit refusal '${String(reason)}'.`);
    super(`Moontide: the note edit stopped (${reason}).`);
    this.name = 'NoteEditStop';
    this.reason = reason;
  }
}

/** The token that stands for a rest in a mini-notation string: a slot that plays nothing and keeps the step count. */
export const REST_TOKEN = '~';

/** The lowest and the highest note number. */
const LOWEST_NOTE = 0;
const HIGHEST_NOTE = 127;

/** The octave a note name is in when it has no digit: the default of the pinned Strudel. */
const DEFAULT_OCTAVE = 3;

const NUMBER_TOKEN = /^-?\d+(\.\d+)?$/;

const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLAT_NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

/**
 * The token `delta` semitones from `text`, a note name (`c3`, `Eb`, `cs4`) or a number. Gives `{ text, midi }` or, at the end
 * of the note range (0 to 127), `{ limit: 'lowest' | 'highest' }`. A name is respelled the way the old one was written: a
 * flat becomes a flat, a sharp keeps its sign (`#` or `s`), the case of the letter stays, and an octave digit is left out only
 * when the old token had none and the new note is in octave 3. A number stays a number. Text that is neither throws.
 */
export function stepPitch(text, delta) {
  if (typeof text !== 'string') throw new Error(`Moontide: a note token is text, got ${String(text)}.`);
  if (!Number.isInteger(delta)) throw new Error(`Moontide: a pitch step is a whole number of semitones, got ${String(delta)}.`);
  if (NUMBER_TOKEN.test(text)) {
    const next = Math.round((Number(text) + delta) * 1e6) / 1e6;
    if (next < LOWEST_NOTE) return { limit: 'lowest' };
    if (next > HIGHEST_NOTE) return { limit: 'highest' };
    return { text: String(next), midi: next };
  }
  const match = NOTE_NAME_TOKEN.exec(text);
  const midi = match === null ? null : noteNameToMidi(text);
  if (match === null || midi === null) throw new Error(`Moontide: '${text}' is neither a note name nor a number, so its pitch cannot be stepped.`);
  const next = midi + delta;
  if (next < LOWEST_NOTE) return { limit: 'lowest' };
  if (next > HIGHEST_NOTE) return { limit: 'highest' };
  const [, letter, accidentals, digits] = match;
  const flat = /[bf]/.test(accidentals);
  const names = flat ? FLAT_NAMES : SHARP_NAMES;
  let name = names[next % 12];
  if (name.length === 2) {
    const sign = flat ? (accidentals.includes('f') ? 'f' : 'b') : accidentals.includes('s') ? 's' : '#';
    name = name[0] + sign;
  }
  if (letter === letter.toUpperCase()) name = name[0].toUpperCase() + name.slice(1);
  const octave = Math.floor(next / 12) - 1;
  const written = digits === undefined && octave === DEFAULT_OCTAVE ? name : `${name}${octave}`;
  return { text: written, midi: next };
}

/** The lowest and the highest velocity a step reaches, and the size of a step. */
const LOWEST_VELOCITY = 0.1;
const HIGHEST_VELOCITY = 1;
const VELOCITY_STEP = 0.1;

const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * The velocity `steps` steps of 0.10 from `shown`, kept between 0.10 and 1.00, in two decimals. A velocity already at an end
 * stays there when the step goes further out, so a step never moves a velocity the wrong way.
 */
export function velocityTarget({ shown, steps }) {
  if (!Number.isInteger(steps)) throw new Error(`Moontide: a velocity step is a whole number of steps, got ${String(steps)}.`);
  const now = round2(shown);
  if (steps > 0 && now >= HIGHEST_VELOCITY) return now;
  if (steps < 0 && now <= LOWEST_VELOCITY) return now;
  return Math.max(LOWEST_VELOCITY, Math.min(HIGHEST_VELOCITY, round2(now + steps * VELOCITY_STEP)));
}

/**
 * The velocity token that makes a note play `steps` steps of 0.10 louder (softer when negative) than the `shown` velocity,
 * which is gain times the velocity written. Gives `{ token, target }` (`token` is the number to write, `target` the velocity
 * that will be shown: the token is `target / gain` in three decimals, so on a browser lane at the default gain 0.8 it may
 * be above 1), `{ limit: 'lowest' | 'highest' }` when the velocity is already at that end, or `{ fixed: true }` when no token
 * can give the target: the gain is 0 or not a finite number, or the rounded token does not play as the target.
 */
export function velocityStep({ shown, gain, steps }) {
  if (typeof shown !== 'number' || !Number.isFinite(shown)) throw new Error(`Moontide: the velocity shown is a finite number, got ${String(shown)}.`);
  const target = velocityTarget({ shown, steps });
  if (target === round2(shown)) return { limit: steps > 0 ? 'highest' : 'lowest' };
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain <= 0) return { fixed: true };
  const token = round3(target / gain);
  if (!(token > 0) || !Number.isFinite(token) || round2(gain * token) !== target) return { fixed: true };
  return { token: String(token), target };
}

/**
 * The edit list that replaces `token` (`{ start, end, text }`, read from `code`) by `insert`: one `{ from, to, insert }`. The
 * code at the token's place must be the token's text; anything else throws, because the place no longer belongs to the code.
 */
export function tokenEdit(code, token, insert) {
  if (typeof insert !== 'string' || insert === '') throw new Error('Moontide: a token edit needs the text to write.');
  if (code.slice(token.start, token.end) !== token.text) {
    throw new Error(`Moontide: the code at ${token.start} to ${token.end} is not the token '${token.text}' any more.`);
  }
  return [{ from: token.start, to: token.end, insert }];
}

/**
 * Writes one edit of the note the person saw. `seen` is `{ code, trackIndex, track, event, events, token, pageStart,
 * velocity, places, placesWindow }` as they saw it (`events` the lane as drawn, `event` the note, `token` its place in `code`,
 * `perCycle` how many notes the token draws in each cycle in a piece without a structure, `velocity` what page/note-locate.js says of its velocity, `places` what the page worked out of where the token plays: a
 * promise or a value of `{ count, sections, onPage, events }`, absent for a piece without a structure, and `placesWindow` the
 * `{ from, to }` stretch of the structure that `events` are the notes of, or null; `velocityPlaces` and `velocityWindow` are the same for the
 * number that holds the velocity, which a velocity edit counts and reads back over the whole stretch just as a pitch does), `change` is `{ kind: 'pitch', semitones }`,
 * `{ kind: 'rest' }` or `{ kind: 'velocity', steps }` (a whole number of steps of 0.10) and `deps` is `{ readBack(code, span)
 * -> promise of the track's events over the drawn page, or over `span` (`{ from, to }`) when one is given, apply(request)
 * (the shared rewrite path), timing, autostart, record(code, label), whenFinished(record, fn), activeCode() }`.
 *
 * The count of places is awaited before anything is built, so an edit is never written without it, and the result and the
 * history entry carry it when it is above 1 (a velocity also carries how many notes of the page share its number). The edited code
 * is read back first: the edit is written only when the read-back shows the same notes at the same times
 * with the new pitch on the notes of the token (without them for a rest, or playing the new velocity for a velocity) and
 * nothing else changed, over the drawn page and over the whole stretch the places were counted on, so
 * an edit that would change a note outside the places it named is refused (a velocity number that plays at another gain in another section is refused that way). The write itself refuses unless the code that plays is the code the note was read from. Resolves one
 * outcome, each with `what` (`pitch`, `rest` or `velocity`): `{ kind: 'written', what, label, from, to }` (for a velocity
 * `from` is the note and `to` the new velocity in two decimals), `{ kind: 'waiting', what, label, from, to, at, record }` (the
 * change waits for its line and is recorded when it takes over), `{ kind: 'refused', reason }` (`stale`, `read-back`,
 * `velocity-fixed` or a refusal of the rewrite path), `{ kind: 'refused', reason: 'error', afterWrite: true, error }` (an error
 * the page did not plan for, thrown by the rewrite path or after it, so the code may have been written), `{ kind: 'refused',
 * reason: 'error', error }` (the evaluation threw and the rewrite path put the editor text back: nothing was written), `{ kind: 'failed' }`
 * (the edited code did not evaluate; the editor is set back), or `{ kind: 'unchanged' }` (`limit` says which end of the note
 * range or of the velocities stopped it). An error before the write reaches the caller as it is: nothing was written then.
 */
export async function writeNoteEdit({ seen, change, deps }) {
  const known = change !== null && typeof change === 'object' && (change.kind === 'pitch' || change.kind === 'rest' || change.kind === 'velocity');
  if (!known) throw new Error(`Moontide: a note edit does not know the change ${JSON.stringify(change)}.`);
  // What is replaced, by what, how the read-back judges it, and the words of the outcome and the history entry.
  let place;
  let insert;
  let proofChange;
  let to;
  let label;
  if (change.kind === 'pitch') {
    const step = stepPitch(seen.token.text, change.semitones);
    if (step.limit !== undefined) return { kind: 'unchanged', what: 'pitch', limit: step.limit };
    place = seen.token;
    insert = step.text;
    proofChange = { kind: 'pitch', midi: step.midi };
    to = step.text;
    label = noteHistoryLabel({ track: seen.track, from: seen.token.text, to: step.text });
  } else if (change.kind === 'rest') {
    place = seen.token;
    insert = REST_TOKEN;
    proofChange = { kind: 'rest' };
    to = REST_TOKEN;
    label = noteHistoryLabel({ track: seen.track, from: seen.token.text, rest: true });
  } else {
    const velocity = seen.velocity;
    if (velocity === undefined || velocity === null || velocity.writable !== true) return { kind: 'refused', reason: 'velocity-fixed' };
    const step = velocityStep({ shown: velocity.shown, gain: velocity.gain, steps: change.steps });
    if (step.limit !== undefined) return { kind: 'unchanged', what: 'velocity', limit: step.limit };
    if (step.fixed === true) return { kind: 'refused', reason: 'velocity-fixed' };
    place = velocity.token;
    insert = step.token;
    proofChange = { kind: 'velocity', target: step.target, gain: velocity.gain };
    to = step.target.toFixed(2);
    label = noteHistoryLabel({ track: seen.track, from: seen.token.text, velocity: step.target });
  }
  // Where the token plays is known before anything is written: a gesture made while it is still being counted waits for it here. A
  // velocity edit is about the number that holds the velocity, which may play in other places than the pitch token does.
  const counting = change.kind === 'velocity' ? seen.velocityPlaces : seen.places;
  const stretch = change.kind === 'velocity' ? seen.velocityWindow : seen.placesWindow;
  let places = null;
  if (counting !== undefined && counting !== null) {
    try {
      places = await counting;
    } catch (error) {
      return { kind: 'refused', reason: 'read-back', error };
    }
  }
  const edits = tokenEdit(seen.code, place, insert);
  const code = applyEdits(seen.code, edits);
  // Every kind of edit changes every note of its token, so the stretch the places were counted on is read back as well.
  const span = places !== null && stretch !== undefined && stretch !== null ? stretch : null;
  let after;
  let afterWindow = null;
  try {
    after = await deps.readBack(code);
    if (span !== null) afterWindow = await deps.readBack(code, span);
  } catch (error) {
    return { kind: 'refused', reason: 'read-back', error };
  }
  const proof = compareReadBack({ before: seen.events, after, token: place, change: proofChange });
  if (!proof.ok) return { kind: 'refused', reason: 'read-back', why: proof.why };
  if (span !== null) {
    const wider = compareReadBack({ before: places.events, after: afterWindow, token: place, change: proofChange });
    if (!wider.ok) return { kind: 'refused', reason: 'read-back', why: `places-${wider.why}` };
  }
  // What the result and the history entry add: where the token plays, or how many notes of the page share the velocity.
  const count = places === null ? (change.kind === 'velocity' ? 0 : (seen.perCycle ?? 0)) : places.count;
  const onPage = places !== null && places.onPage === true;
  const notes = change.kind === 'velocity' ? sameTokenEvents({ events: seen.events, token: place }).length : 0;
  if (change.kind === 'pitch') label = noteHistoryLabel({ track: seen.track, from: seen.token.text, to, places: count, onPage });
  else if (change.kind === 'rest') label = noteHistoryLabel({ track: seen.track, from: seen.token.text, rest: true, places: count, onPage });
  else label = noteHistoryLabel({ track: seen.track, from: seen.token.text, velocity: proofChange.target, places: count, onPage });
  const told = (outcome) => {
    if (count > 1) {
      outcome.places = count;
      if (onPage) outcome.onPage = true;
    }
    if (notes > 1) outcome.notes = notes;
    return outcome;
  };

  let result;
  try {
    result = await deps.apply({
      timing: deps.timing,
      autostart: deps.autostart,
      flash: false,
      build(base) {
        // The place belongs to the code the note was read from and to no other.
        if (base !== seen.code) throw new NoteEditStop('stale');
        return { code, edits };
      },
    });
  } catch (error) {
    if (error instanceof NoteEditStop) return { kind: 'refused', reason: error.reason };
    // An evaluation that threw after which the rewrite path put the editor text back: nothing was written or armed.
    if (error !== null && typeof error === 'object' && error.restored === true) return { kind: 'refused', reason: 'error', error };
    // The rewrite path may have set the editor text or evaluated it before it threw: the code may have changed.
    return { kind: 'refused', reason: 'error', afterWrite: true, error };
  }
  if (result.status === 'refused') return { kind: 'refused', reason: result.reason };
  if (result.status === 'unchanged') return { kind: 'unchanged', what: change.kind };
  if (result.status === 'failed') return { kind: 'failed' };

  // The code is written from here on: an error now is told as one that came after the write.
  try {
    const deferred = result.run.deferred;
    if (deferred === null || deferred === undefined) {
      deps.record(deps.activeCode(), label);
      return told({ kind: 'written', what: change.kind, label, from: seen.token.text, to });
    }
    deps.whenFinished(deferred, () => deps.record(typeof deferred.code === 'string' ? deferred.code : deps.activeCode(), label));
    return told({ kind: 'waiting', what: change.kind, label, from: seen.token.text, to, at: deps.timing.at, record: deferred });
  } catch (error) {
    return { kind: 'refused', reason: 'error', afterWrite: true, error };
  }
}
