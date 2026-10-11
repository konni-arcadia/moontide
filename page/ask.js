// Pure module for the Ask Claude box: the copy, the length rules, the context
// descriptors, the box placement and the request status sequencing. No DOM access at import time,
// so node:test and page/main.js import it directly with no build step. The box's own DOM lives in
// page/ask-view.js.

import { BEATS_PER_CYCLE } from './change-timing.js';
import { MAX_MOMENT_NOTES } from './timeline.js';

/** Mirrors src/protocol.ts's MAX_ASK_TEXT_LENGTH by hand (test/ask.test.js checks both are 2000). */
export const MAX_ASK_TEXT_LENGTH = 2000;

/** Mirrors src/protocol.ts's MAX_REQUEST_LINE_BYTES by hand (test/ask.test.js checks both are 8192). */
export const MAX_REQUEST_LINE_BYTES = 8192;

/** Mirrors src/ask.ts's REQUEST_LINE_PREFIX by hand (test/ask.test.js checks both). */
export const REQUEST_LINE_PREFIX = 'Request from the Moontide page:';

/** Mirrors src/protocol.ts's MAX_ASK_CONTEXT_LENGTH by hand (test/ask.test.js checks both are 200). */
export const MAX_ASK_CONTEXT_LENGTH = 200;

/** Mirrors src/web-server.ts's PAGE_TOKEN_PLACEHOLDER by hand (test/ask.test.js checks both). */
export const PAGE_TOKEN_PLACEHOLDER = '__MOONTIDE_PAGE_TOKEN__';

/** No answer from the server within this long: the request is reported as not confirmed. */
export const ASK_CONFIRM_TIMEOUT_MS = 5000;

/** A non-error status stays readable at least this long before the next one replaces it. */
export const STATUS_MIN_SHOWN_MS = 600;

/** "Claude received it" is shown this long, then the status hides. */
export const RECEIVED_SHOWN_MS = 4000;

/** From this many characters the box shows a counter, so the limit is seen before it is hit. */
export const COUNTER_FROM = 1800;

/** The most characters of the error the Ask field is prefilled with (the rest of the 2000 is for the question). */
export const MAX_ERROR_PREFILL = 1500;

/** The margin kept to the viewport edge and the offset from the pointer, in rem. */
export const BOX_GAP_REM = 0.5;

/** Page-visible copy for the Ask Claude box. The refusal lines carry no
 * 'Error: ' prefix: errorLineText adds it. */
export const ASK_COPY = {
  boxLabel: 'Ask Claude',
  fieldLabel: 'Request for Claude',
  placeholder: 'Ask Claude…',
  hint: 'Enter sends · Shift+Enter new line · Esc closes',
  wholeSession: 'Whole session',
  currentChip: 'Current v',
  disconnected: 'Disconnected — asking Claude is off until Moontide reconnects.',
  notSent: 'This request was not sent. Press Enter to try again.',
  notSentToken: 'This request was not sent.',
  sent: 'Sent to Claude',
  received: 'Claude received it',
  waiting: 'Claude will see it on its next action',
  tooLong: 'request too long — 2000 characters at most.',
  lineTooLong: 'request too long to send — some characters take extra room, so shorten the text.',
  rateLimit: 'too many requests — wait a moment, then send again.',
  queueFull: 'Claude has too many requests waiting — send again after it has read them.',
  token: "Moontide refused this page's token — reload the page.",
  didNotConfirm: 'Moontide did not confirm the request — try again.',
  contextUnreadable: 'could not read what was right-clicked — this request is about the whole session.',
  partsAsk: 'Ask Claude to add sections',
  partsRequest: 'Organize this code into sections with arrange()',
  shiftRightClickTitle: "Shift + right-click keeps the browser's own menu.",
  // A failed change sent to Claude from the banner (the chip's lead and the first words of the prefill).
  errorChipLead: 'Failed change',
  errorPrefillLead: 'The last change failed with this error:',
};

/**
 * Page-visible copy for the top-bar page-requests status, its (i) and the (i)'s popover. Plain words that never use the word for listening: in a music tool it would read as
 * listening to the sound. The popover says how in the Code tab of the Claude app (ask Claude, which calls the
 * set_page_requests tool) and in a terminal (the two commands). onCommand and offCommand mirror
 * src/ask.ts's prompt names by hand (test/ask.test.js checks both); they assume the server was added
 * as moontide (README says so).
 */
export const PAGE_REQUESTS_COPY = {
  live: 'Page requests: live',
  waiting: 'Page requests: wait for Claude',
  infoText: 'i',
  infoLabel: 'How page requests work',
  helpIntro: 'Page requests are what you ask Claude with a right-click in this page.',
  appText: 'In the Code tab of the Claude app, ask Claude to turn page requests on or off.',
  onLead: 'In a terminal, type',
  onCommand: '/mcp__moontide__page-requests-on',
  onRest: 'to make them live, or',
  offCommand: '/mcp__moontide__page-requests-off',
  offRest: 'to make them wait.',
  monitorText:
    'Live, Claude runs a monitor that brings each request right away; a monitor lasts at most 30 minutes, and Claude restarts it when a tool reply asks. Waiting, requests reach Claude with its next action.',
};

/**
 * The status text for the server's page-requests message (src/protocol.ts, mirrored here by hand):
 * live is true while a Moontide monitor is connected. Anything but a boolean throws.
 */
export function pageRequestsText(live) {
  if (live === true) return PAGE_REQUESTS_COPY.live;
  if (live === false) return PAGE_REQUESTS_COPY.waiting;
  throw new Error(`Moontide: the page-requests state must be true or false, got ${JSON.stringify(live)}.`);
}

/** The status text for requests handed to Claude: one, or a count. */
export function receivedText(count) {
  return count === 1 ? ASK_COPY.received : `Claude received ${count} requests`;
}

/** The status text for requests that wait on the server: one, or a count. */
export function waitingText(count) {
  return count === 1 ? ASK_COPY.waiting : `Claude will see ${count} requests on its next action`;
}

/**
 * The short forms of the status texts, shown at fit step 3 of the top bar when the long
 * sentence no longer fits. They are made here, next to the long texts, and travel with them: nothing shortens a long
 * text by matching strings afterwards. The long text stays in the accessibility tree.
 */
export const ASK_SHORT_COPY = Object.freeze({ sent: 'Sent', received: 'Received', waiting: 'Waiting' });

/** The short form of receivedText(count). */
export function receivedShortText(count) {
  return count === 1 ? ASK_SHORT_COPY.received : `${count} received`;
}

/** The short form of waitingText(count). */
export function waitingShortText(count) {
  return count === 1 ? ASK_SHORT_COPY.waiting : `${count} waiting`;
}

/** 'empty' | 'too-long' | null for the text the user typed (counted on the trimmed text, in UTF-16 units,
 * the same count the server uses). */
export function askTextProblem(text) {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if (trimmed.length > MAX_ASK_TEXT_LENGTH) return 'too-long';
  return null;
}

/** The counter line for a text of `length` characters, or null while it is not needed yet. */
export function counterText(length) {
  if (length < COUNTER_FROM) return null;
  if (length <= MAX_ASK_TEXT_LENGTH) return `${length} / ${MAX_ASK_TEXT_LENGTH}`;
  return `${length} / ${MAX_ASK_TEXT_LENGTH} — too long. Shorten it to send.`;
}

/** The one muted message line of the box, in the spec's priority order, or null when none applies. */
export function askMessage({ connected, length, notSent, tokenRefused, lineTooLong = false }) {
  if (!connected) return ASK_COPY.disconnected;
  const counter = counterText(length);
  if (counter !== null && !(lineTooLong && length <= MAX_ASK_TEXT_LENGTH)) return counter;
  if (lineTooLong) return ASK_COPY.lineTooLong;
  if (notSent && tokenRefused) return ASK_COPY.notSentToken;
  if (notSent) return ASK_COPY.notSent;
  return null;
}

/**
 * The Parts view's "Ask Claude to add sections" button: disabled while asking is off or its request is
 * pending, with the line under it saying why. `statusText` is the top-bar
 * status text of that request, or null.
 */
export function partsAskState({ connected, pending, statusText }) {
  if (!connected) return { disabled: true, line: ASK_COPY.disconnected };
  if (pending) return { disabled: true, line: statusText ?? null };
  return { disabled: false, line: null };
}

/** The error-line text for a server refusal (the caller passes it through errorLineText). */
export function refusalText(reason, detail) {
  if (reason === 'too-long') return ASK_COPY.tooLong;
  if (reason === 'line-too-long') return ASK_COPY.lineTooLong;
  if (reason === 'rate-limit') return ASK_COPY.rateLimit;
  if (reason === 'queue-full') return ASK_COPY.queueFull;
  if (reason === 'token') return ASK_COPY.token;
  return `Moontide refused the request (${detail || reason}).`;
}

/**
 * Cuts `text` to at most `max` UTF-16 units, the cut marked with '…' (max - 1 units, then the ellipsis).
 * Walks code points, so a surrogate pair is never split. The server rejects a longer string and never
 * trims, so the page cuts every string it sends in a context.
 */
export function cutText(text, max = MAX_ASK_CONTEXT_LENGTH) {
  if (text.length <= max) return text;
  let kept = '';
  for (const point of Array.from(text)) {
    if (kept.length + point.length > max - 1) break;
    kept += point;
  }
  return `${kept}\u2026`;
}

function missing(kind, field) {
  return new Error(`Moontide: ask context ${kind} needs ${field}`);
}

/** A required non-empty string field, cut to the context limit. */
function requiredText(descriptor, field) {
  const value = descriptor[field];
  if (typeof value !== 'string' || value === '') throw missing(descriptor.kind, `a non-empty ${field}`);
  return cutText(value);
}

/** An optional string field: cut, or undefined when absent or empty. */
function optionalText(descriptor, field) {
  const value = descriptor[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw missing(descriptor.kind, `${field} as a string`);
  return cutText(value);
}

function requiredInteger(descriptor, field, min) {
  const value = descriptor[field];
  if (!Number.isInteger(value) || value < min) throw missing(descriptor.kind, `a whole number ${field} of at least ${min}`);
  return value;
}

function requiredBus(descriptor) {
  if (descriptor.bus !== 'reverb' && descriptor.bus !== 'delay') throw missing(descriptor.kind, "a bus of 'reverb' or 'delay'");
  return descriptor.bus;
}

const SEPARATOR = ' \u00B7 ';

/** The bus name a bus chip shows: 'Reverb bus', with the orbit while several orbits are in use. */
function busTitle(bus, orbit, multipleOrbits) {
  const name = `${bus === 'reverb' ? 'Reverb' : 'Delay'} bus`;
  return multipleOrbits === true ? `${name}${SEPARATOR}orbit ${orbit}` : name;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The keys checkedMoment may copy into a moment note, in the order it copies them. The server's moment note
 * schema (askMomentNoteShape in src/protocol.ts) names the same keys: a key it does not name is dropped there
 * without a word, so test/ask.test.js pins the two lists equal.
 */
export const MOMENT_NOTE_FIELDS = Object.freeze(['track', 'instrument', 'sound', 'note', 'drum', 'velocity', 'start', 'end', 'state']);

/**
 * A copy of the moment the Timeline described, checked and with every string cut to the context limit
 * (numbers are untouched). The server refuses what is out of bounds and never trims, so a moment the page got
 * wrong is a loud error here instead of a request that is refused later. The input is never mutated.
 */
function checkedMoment(kind, moment) {
  if (moment === null || typeof moment !== 'object') throw missing(kind, 'a moment that is an object');
  if (!isNonNegativeInteger(moment.cycle)) throw missing(kind, 'a whole number moment cycle of at least 0');
  if (!Number.isInteger(moment.beat) || moment.beat < 1 || moment.beat > BEATS_PER_CYCLE) {
    throw missing(kind, `a whole number moment beat from 1 to ${BEATS_PER_CYCLE}`);
  }
  if (!isNonNegativeNumber(moment.at)) throw missing(kind, 'a finite moment instant of at least 0');
  if (moment.version !== null && !(Number.isInteger(moment.version) && moment.version > 0)) {
    throw missing(kind, 'a moment version that is null or a positive whole number');
  }
  if (!Array.isArray(moment.notes) || moment.notes.length > MAX_MOMENT_NOTES) {
    throw missing(kind, `at most ${MAX_MOMENT_NOTES} moment notes`);
  }
  if (!isNonNegativeInteger(moment.more)) throw missing(kind, 'a whole number moment count of more notes of at least 0');
  const notes = moment.notes.map((note, index) => {
    const where = `moment note ${index + 1}`;
    if (note === null || typeof note !== 'object') throw missing(kind, `${where} as an object`);
    if (typeof note.track !== 'string' || note.track === '') throw missing(kind, `a non-empty track in ${where}`);
    if (note.state !== 'sounding' && note.state !== 'starts') throw missing(kind, `a state of sounding or starts in ${where}`);
    if (!isNonNegativeNumber(note.start) || !isNonNegativeNumber(note.end)) {
      throw missing(kind, `a finite start and end of at least 0 in ${where}`);
    }
    const copy = { track: cutText(note.track) };
    for (const field of ['instrument', 'sound']) {
      if (note[field] === undefined) continue;
      if (typeof note[field] !== 'string' || note[field] === '') throw missing(kind, `${field} as a non-empty string in ${where}`);
      copy[field] = cutText(note[field]);
    }
    if (note.note !== undefined) {
      if (typeof note.note === 'string' && note.note !== '') copy.note = cutText(note.note);
      else if (typeof note.note === 'number' && Number.isFinite(note.note)) copy.note = note.note;
      else throw missing(kind, `note as a non-empty string or a finite number in ${where}`);
    }
    if (note.drum !== undefined) {
      if (typeof note.drum !== 'string' || note.drum === '') throw missing(kind, `drum as a non-empty string in ${where}`);
      copy.drum = cutText(note.drum);
    }
    if (note.velocity !== undefined) {
      if (!isNonNegativeNumber(note.velocity)) throw missing(kind, `a finite velocity of at least 0 in ${where}`);
      copy.velocity = note.velocity;
    }
    copy.start = note.start;
    copy.end = note.end;
    copy.state = note.state;
    return copy;
  });
  return { cycle: moment.cycle, beat: moment.beat, at: moment.at, version: moment.version, notes, more: moment.more };
}

/**
 * The size in bytes (UTF-8) of the line the server builds from one request: src/ask.ts's requestLine, the
 * prefix, a space and the JSON of the fields in the same order (U+2028 and U+2029 escaped), so the page can
 * tell before it sends whether the server will take the line.
 */
export function requestLineBytes({ id, text, context, chip, current, moment }) {
  const fields = moment === undefined ? { id, text, context, chip, current } : { id, text, context, chip, current, moment };
  const json = JSON.stringify(fields).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return new TextEncoder().encode(`${REQUEST_LINE_PREFIX} ${json}`).length;
}

/**
 * The moment of a request cut to what the line holds: notes come off the end, one at a time, and are counted in
 * `more`, until the whole line is at most MAX_REQUEST_LINE_BYTES (or no note is left: the rest of the line is
 * the user's text and the server decides). The input is never mutated; a moment that fits is returned as it
 * is, and undefined stays undefined. The chip counts notes and `more` together, so it needs no change.
 */
export function fitMomentToLine(fields) {
  const { moment } = fields;
  if (moment === undefined) return undefined;
  let notes = moment.notes;
  let more = moment.more;
  while (notes.length > 0 && requestLineBytes({ ...fields, moment: { ...moment, notes, more } }) > MAX_REQUEST_LINE_BYTES) {
    notes = notes.slice(0, -1);
    more += 1;
  }
  return notes === moment.notes ? moment : { ...moment, notes, more };
}

/**
 * Whether the request fits one line once its moment is cut as far as `fitMomentToLine` cuts it. False means the
 * text, the context and the chip alone are over MAX_REQUEST_LINE_BYTES: a text within the character limit can
 * still get here (JSON writes a control character as six bytes, and some scripts take three), so the box does
 * not send it and says so, instead of letting the server refuse it with the wrong reason.
 */
export function requestFitsLine(fields) {
  return requestLineBytes({ ...fields, moment: fitMomentToLine(fields) }) <= MAX_REQUEST_LINE_BYTES;
}

/** The part of a chip that says where and what: 'cycle 34, beat 3 · 3 notes'. */
function momentChipPart(moment) {
  const count = moment.notes.length + moment.more;
  const notes = count === 0 ? 'no notes' : count === 1 ? '1 note' : `${count} notes`;
  return `cycle ${moment.cycle}, beat ${moment.beat}${SEPARATOR}${notes}`;
}

/**
 * What a right-click pointed at, as the context the server receives and the chip the user sees.
 * `descriptor` is what a view reports about an element:
 * a kind plus the strings and numbers that identify the target, exactly as the view shows them.
 * Every string field and the finished chip are cut at the context limit; display-only flags such as
 * `multipleOrbits` never reach `context`. A descriptor a view got wrong throws: a bug is loud, never
 * a blank chip.
 */
export function describeContext(descriptor) {
  const kind = descriptor && descriptor.kind;
  let moment = descriptor ? descriptor.moment : undefined;
  // A moment is the Timeline's facts at the pointer: a lane, a part header over the lanes and the rest of the
  // Timeline (a session descriptor) carry one; nothing else does.
  if (moment !== undefined && kind !== 'lane' && kind !== 'part' && kind !== 'session') throw new Error(`Moontide: ask context ${kind} cannot carry a moment`);
  let context;
  let chip;
  switch (kind) {
    case 'session': {
      if (moment === undefined) return { context: { kind: 'session' }, chip: ASK_COPY.wholeSession };
      moment = checkedMoment(kind, moment);
      context = { kind };
      chip = `Moment${SEPARATOR}${momentChipPart(moment)}`;
      break;
    }
    case 'version': {
      const id = requiredInteger(descriptor, 'id', 1);
      const label = optionalText(descriptor, 'label');
      context = label === undefined ? { kind, id } : { kind, id, label };
      chip = label === undefined ? `Version v${id}` : `Version v${id}${SEPARATOR}${label}`;
      break;
    }
    case 'line': {
      const line = requiredInteger(descriptor, 'line', 1);
      if (typeof descriptor.text !== 'string') throw missing(kind, 'text as a string');
      const text = cutText(descriptor.text.trim());
      context = { kind, line, text };
      chip = text === '' ? `Line ${line} (empty)` : `Line ${line}${SEPARATOR}${text}`;
      break;
    }
    case 'track': {
      const track = requiredText(descriptor, 'track');
      context = { kind, track };
      chip = `Track ${track}`;
      break;
    }
    case 'instrument': {
      const id = requiredText(descriptor, 'id');
      context = { kind, id };
      chip = `Instrument ${id}`;
      break;
    }
    case 'error': {
      // A failed change. The descriptor carries the full message; the context and the chip carry its
      // first non-empty line, cut, so the request stays small. The rest of the error travels in the Ask field's prefill.
      if (typeof descriptor.text !== 'string') throw missing(kind, 'text as a string');
      const firstLine = descriptor.text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? 'unknown error';
      const text = cutText(firstLine);
      context = { kind, text };
      chip = `${ASK_COPY.errorChipLead}${SEPARATOR}${cutText(firstLine, MAX_ASK_CONTEXT_LENGTH - SEPARATOR.length - ASK_COPY.errorChipLead.length)}`;
      break;
    }
    case 'fader': {
      const track = requiredText(descriptor, 'track');
      const value = requiredText(descriptor, 'value');
      context = { kind, track, value };
      chip = `${track}${SEPARATOR}fader ${value}`;
      break;
    }
    case 'send': {
      const track = requiredText(descriptor, 'track');
      const bus = requiredBus(descriptor);
      const value = requiredText(descriptor, 'value');
      context = { kind, track, bus, value };
      chip = `${track}${SEPARATOR}${bus} send ${value}`;
      break;
    }
    case 'effect': {
      const track = requiredText(descriptor, 'track');
      const effect = requiredText(descriptor, 'effect');
      const bypassed = descriptor.bypassed === true;
      context = { kind, track, effect, bypassed };
      chip = `${track}${SEPARATOR}${effect}${bypassed ? ' (off)' : ''}`;
      break;
    }
    case 'effect-param': {
      const track = requiredText(descriptor, 'track');
      const effect = requiredText(descriptor, 'effect');
      const parameter = requiredText(descriptor, 'parameter');
      const value = requiredText(descriptor, 'value');
      context = { kind, track, effect, parameter, value };
      chip = `${track}${SEPARATOR}${effect}${SEPARATOR}${parameter} ${value}`;
      break;
    }
    case 'bus': {
      const bus = requiredBus(descriptor);
      const orbit = requiredInteger(descriptor, 'orbit', 0);
      context = { kind, bus, orbit };
      chip = busTitle(bus, orbit, descriptor.multipleOrbits);
      break;
    }
    case 'bus-param': {
      const bus = requiredBus(descriptor);
      const orbit = requiredInteger(descriptor, 'orbit', 0);
      const parameter = requiredText(descriptor, 'parameter');
      const value = requiredText(descriptor, 'value');
      context = { kind, bus, orbit, parameter, value };
      chip = `${busTitle(bus, orbit, descriptor.multipleOrbits)}${SEPARATOR}${parameter} ${value}`;
      break;
    }
    case 'part': {
      const name = requiredText(descriptor, 'name');
      const owner = optionalText(descriptor, 'owner');
      context = owner === undefined ? { kind, name } : { kind, name, owner };
      const base = `Part "${name}"${owner === undefined ? '' : `${SEPARATOR}${owner}`}`;
      if (moment === undefined) {
        chip = base;
      } else {
        moment = checkedMoment(kind, moment);
        // Same rule as a lane: the base (name and owner) is cut to the room left, never the moment part.
        const part = momentChipPart(moment);
        chip = `${cutText(base, MAX_ASK_CONTEXT_LENGTH - SEPARATOR.length - part.length)}${SEPARATOR}${part}`;
      }
      break;
    }
    case 'lane': {
      const track = requiredText(descriptor, 'track');
      if (moment !== undefined) {
        moment = checkedMoment(kind, moment);
        const cycle = requiredInteger(descriptor, 'cycle', 0);
        if (cycle !== moment.cycle) throw missing(kind, 'a cycle equal to the moment cycle');
        context = { kind, track, cycle };
        // The moment part is built first and the name is cut to the room left, so a long name never costs the
        // part that says where and what.
        const part = momentChipPart(moment);
        chip = `${cutText(`Lane ${track}`, MAX_ASK_CONTEXT_LENGTH - SEPARATOR.length - part.length)}${SEPARATOR}${part}`;
      } else if (descriptor.cycle === undefined || descriptor.cycle === null) {
        context = { kind, track };
        chip = `Lane ${track}`;
      } else {
        const cycle = requiredInteger(descriptor, 'cycle', 0);
        context = { kind, track, cycle };
        chip = `Lane ${track}${SEPARATOR}cycle ${cycle}`;
      }
      break;
    }
    case 'note': {
      const note = requiredText(descriptor, 'note');
      const role = descriptor.role === null ? undefined : descriptor.role;
      const scale = optionalText(descriptor, 'scale');
      if ((role === undefined) !== (scale === undefined)) throw missing(kind, 'role and scale together, or neither');
      if (role === undefined) {
        context = { kind, note };
        chip = `Note ${note}`;
        break;
      }
      const phrases = {
        root: `root of ${scale}`,
        scale: `in ${scale}`,
        avoid: `to avoid in ${scale}`,
        outside: `outside ${scale}`,
        off: `not in ${scale}`,
      };
      const phrase = Object.hasOwn(phrases, role) ? phrases[role] : undefined;
      if (phrase === undefined) throw missing(kind, 'a role of root, scale, avoid, outside or off');
      context = { kind, note, role, scale };
      chip = `Note ${note}${SEPARATOR}${phrase}`;
      break;
    }
    case 'warning': {
      const chord = requiredText(descriptor, 'chord');
      const outside = requiredText(descriptor, 'outside');
      const avoid = optionalText(descriptor, 'avoid');
      const seconds = requiredInteger(descriptor, 'seconds', 0);
      const scale = requiredText(descriptor, 'scale');
      context = avoid === undefined ? { kind, chord, outside, seconds, scale } : { kind, chord, outside, avoid, seconds, scale };
      chip = `Warning${SEPARATOR}${chord} brings ${outside}${avoid === undefined ? '' : `, avoid ${avoid}`}, ${seconds === 0 ? 'now' : `in ${seconds} s`}`;
      break;
    }
    default:
      throw new Error(`Moontide: unknown ask context kind ${kind}`);
  }
  return moment === undefined ? { context, chip: cutText(chip) } : { context, chip: cutText(chip), moment };
}

/**
 * The text the Ask field starts with when the user asks Claude about a failed change: the lead, a blank line, the
 * error cut at MAX_ERROR_PREFILL characters with an ellipsis, and two newlines, so the user types the question after it.
 * The server instructions label the context as data; this text is visible and editable and is sent only on Enter.
 */
export function errorAskPrefill(fullText) {
  if (typeof fullText !== 'string') throw new Error('Moontide: the error prefill needs the error text as a string');
  return `${ASK_COPY.errorPrefillLead}\n\n${cutText(fullText, MAX_ERROR_PREFILL)}\n\n`;
}

// The cycle under the pointer on a Timeline lane lives in page/timeline.js next to momentAt, so a lane's
// context cycle and a moment's cycle share one rule; it stays importable from here.
export { cycleAt } from './timeline.js';

/**
 * The 1-based line whose block holds `y`, or null. `blocks` are the editor's line blocks in order, each
 * `{ top, height }` in the same coordinates as `y`.
 */
export function lineAtY(blocks, y) {
  const index = blocks.findIndex((block) => block.top <= y && y < block.top + block.height);
  return index === -1 ? null : index + 1;
}

/**
 * Where the box goes: right of the pointer, flipped left when its right edge would pass the viewport
 * minus the margin. Vertically, the side is chosen from `maxBoxHeight` (the box's height at six field
 * lines): below the pointer when the six-line box fits there, else above. `above` keeps a side already
 * chosen (true or false; null or undefined chooses again), so a height change never flips the box
 * across the pointer. The anchored edge stays while the field grows: the top edge at the pointer plus
 * the offset below, the bottom edge at the pointer minus the offset above, whatever `boxHeight` (the
 * box's height now) is. Then both axes are clamped inside the viewport with the current size (a box
 * larger than the viewport gets its top-left at the margin). Returns { left, top, above }.
 */
export function placeBox({ pointerX, pointerY, boxWidth, boxHeight, maxBoxHeight, viewportWidth, viewportHeight, margin, offset, above }) {
  if (typeof maxBoxHeight !== 'number' || !Number.isFinite(maxBoxHeight)) {
    throw new Error(`Moontide: placeBox needs maxBoxHeight as a finite number, got ${String(maxBoxHeight)}.`);
  }
  let left = pointerX + offset;
  if (left + boxWidth > viewportWidth - margin) left = pointerX - offset - boxWidth;
  const opensAbove =
    typeof above === 'boolean' ? above : pointerY + offset + Math.max(maxBoxHeight, boxHeight) > viewportHeight - margin;
  let top = opensAbove ? pointerY - offset - boxHeight : pointerY + offset;
  left = Math.max(margin, Math.min(left, viewportWidth - boxWidth - margin));
  top = Math.max(margin, Math.min(top, viewportHeight - boxHeight - margin));
  return { left, top, above: opensAbove };
}

/** A request id the page makes up so answers can be matched: at most 64 characters. */
export function newAskId(counter, nowMs) {
  return `ask-${nowMs.toString(36)}-${counter}`;
}

/**
 * The top-bar status of the latest request, as a small state machine with injected time (the
 * page/mixer-gesture.js style). `render(text, short)` receives a string or null and, with a string, its short form (the
 * second argument is left out when hiding). `onTimeout(id)` is called
 * for a request the server did not answer in time, or whose connection dropped.
 *
 * Every non-error text becomes visible no sooner than `minShownMs` after the previous non-error text
 * appeared (a later text is scheduled, never lost); hiding for an error or a refusal is immediate and
 * cancels anything scheduled.
 */
export function createAskStatus({
  render,
  onTimeout,
  setTimer,
  clearTimer,
  now,
  minShownMs = STATUS_MIN_SHOWN_MS,
  receivedShownMs = RECEIVED_SHOWN_MS,
  confirmTimeoutMs = ASK_CONFIRM_TIMEOUT_MS,
}) {
  // The request the status describes.
  let latestId = null;
  // Requests sent and not yet answered: id -> confirm timer.
  const unconfirmed = new Map();
  // When the text on screen appeared; null while nothing shows.
  let shownAt = null;
  let scheduled = null;
  let hideTimer = null;

  function cancelScheduled() {
    if (scheduled !== null) clearTimer(scheduled);
    scheduled = null;
  }

  function cancelHide() {
    if (hideTimer !== null) clearTimer(hideTimer);
    hideTimer = null;
  }

  function hideNow() {
    cancelScheduled();
    cancelHide();
    shownAt = null;
    render(null);
  }

  function reveal(text, short, hideAfterMs) {
    scheduled = null;
    render(text, short);
    shownAt = now();
    if (hideAfterMs !== null) {
      hideTimer = setTimer(() => {
        hideTimer = null;
        hideNow();
      }, hideAfterMs);
    }
  }

  /** Shows a non-error text now, or as soon as the text on screen has been readable long enough. */
  function present(text, short, hideAfterMs) {
    cancelScheduled();
    cancelHide();
    const wait = shownAt === null ? 0 : Math.max(0, minShownMs - (now() - shownAt));
    if (wait === 0) {
      reveal(text, short, hideAfterMs);
    } else {
      scheduled = setTimer(() => reveal(text, short, hideAfterMs), wait);
    }
  }

  function forget(id) {
    const timer = unconfirmed.get(id);
    if (timer === undefined) return;
    clearTimer(timer);
    unconfirmed.delete(id);
  }

  function expire(id) {
    unconfirmed.delete(id);
    onTimeout(id);
    if (id === latestId) hideNow();
  }

  return {
    /** A request was sent: it becomes the latest and waits for the server's answer. */
    sent(id) {
      latestId = id;
      unconfirmed.set(id, setTimer(() => expire(id), confirmTimeoutMs));
      present(ASK_COPY.sent, ASK_SHORT_COPY.sent, null);
    },
    /** The server's ask-result for a request. */
    answered(msg) {
      forget(msg.id);
      if (msg.id !== latestId) return;
      if (msg.status === 'received') present(receivedText(1), receivedShortText(1), receivedShownMs);
      else if (msg.status === 'waiting') present(waitingText(msg.waiting), waitingShortText(msg.waiting), null);
      else hideNow();
    },
    /** The server's ask-received: waiting requests were just handed to Claude. */
    handedOver(ids) {
      for (const id of ids) forget(id);
      if (latestId !== null && ids.includes(latestId)) present(receivedText(ids.length), receivedShortText(ids.length), receivedShownMs);
    },
    /** The connection is gone: nothing sent and unanswered will be answered any more. */
    dropAll() {
      for (const [id, timer] of unconfirmed) {
        clearTimer(timer);
        onTimeout(id);
      }
      unconfirmed.clear();
      hideNow();
    },
  };
}
