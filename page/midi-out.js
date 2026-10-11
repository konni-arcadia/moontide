// The page's MIDI IO layer: enables Web MIDI right before the first evaluation whose code contains
// a `.midi(` call (and waits for the answer, so the first beat is heard), and publishes the MIDI
// facts of page/midi-plan.js whenever they change. Every side effect is injected and there is no
// DOM, so node:test can drive it with fakes. Imported directly by page/main.js without a build step.
// It never keeps a webmidi Output or a native MIDIOutput in a variable across calls: a port can be
// replaced at any time, so the current list is read each time.

import { MIDI_LIMITS, buildMidiFacts, channelSilence, panicMessages, panicOrder, panicTargetsFrom, portState, readMidiCalls, readMidiSetup, usesMidi } from './midi-plan.js';
import { checkSetup as checkRigSetup } from './midi-rig.js';
import { controlsByCc, defaultOf, midiStops, notesToStop, readMidiSlots } from './midi-controls.js';
import { cutText } from './ask.js';
import { createPageClock } from './midi-clock.js';

function defaultOnError(text, err) {
  console.error(text, err);
}

function defaultOnInfo(text) {
  console.info(text);
}

// How long an evaluation waits for the user to answer the browser's MIDI permission prompt. A prompt
// nobody answers must not block the page's serial chain of evaluations: after this the code plays
// without MIDI, and MIDI starts by itself when the user answers.
export const MIDI_PERMISSION_CEILING_MS = 120000;

/**
 * True for the rejection Strudel's own enable produces when the MIDI permission is denied (Chrome
 * names it NotAllowedError or SecurityError). Strudel asks again on every evaluation of code that
 * has a `.midi(` call while Web MIDI is not enabled, and each denial is an unhandled rejection.
 */
export function isKnownMidiRejection(reason) {
  return reason !== null && typeof reason === 'object' && (reason.name === 'NotAllowedError' || reason.name === 'SecurityError');
}

/**
 * Makes `.midi()` a silent trigger, for a browser without Web MIDI. Strudel's own `.midi()` enables Web MIDI
 * while the pattern is built and throws there, which fails the whole piece, browser tracks included. A
 * trigger with one argument is dominant, so the track makes no browser sound, as `.midi()` does. Install it
 * only where `navigator.requestMIDIAccess` is not a function. Throws when Strudel's Pattern is not usable.
 */
export function installNoMidiShim(PatternClass) {
  if (typeof PatternClass !== 'function') {
    throw new Error("Moontide: Strudel's Pattern is not available, so .midi() could not be made silent in a browser without Web MIDI.");
  }
  if (typeof PatternClass.prototype.onTrigger !== 'function') {
    throw new Error("Moontide: Strudel's Pattern has no onTrigger, so .midi() could not be made silent in a browser without Web MIDI.");
  }
  PatternClass.prototype.midi = function noMidi() {
    return this.onTrigger(() => {});
  };
}

// The pause after a setup step (a program change) before the evaluation that plays the new code, so a
// sound change never shares the instant of a note. The base is a starting value,
// 50 ms; the wire time of the bytes just sent is added (31.25 kbaud, 10 bits per byte). Kept as is after the
// 2026-10-02 bench: no note was cut at a sound change. The old note heard with a new sound there came from the
// old code's queued notes, which the stale-channel rule now drops; this guard does not address it.
export const SETUP_GUARD_MS = 50;

// At a sound change while old code plays, the channel's bank select, program change and controls go this long after
// the last note-on of the old code already queued on that channel (Chrome cannot take it back), so that note sounds
// with its own sound and the new sound starts after it. The new code's first note comes more than 150 ms later
// (measured 334 to 373 ms).
export const SETUP_AFTER_QUEUED_MS = 0.5;

// The setup of a change that waits for a bar or phrase line (sounds, controls) is timed this long before the line, so
// it lands after every note of the old code (all of them are stamped before the line) and before the first note of
// the new code (stamped on the line). Web MIDI keeps the order of messages by timestamp, so the 1 ms is enough.
export const SETUP_BEFORE_LINE_MS = 1;
export const SETUP_WIRE_MS_PER_BYTE = 0.32;

// How long an instrument that appeared (its port came back, Munt was started again) is left alone before
// its reset, so the device can finish starting. 500 ms is about twice what a
// software synth needs. At the 2026-10-02 bench it was enough for a software synth started again; a USB
// interface replug needs the second setup too (RECONNECT_REPEAT_MS). A createMidiOut option, so tests use the fake clock.
export const RESET_SETTLE_MS = 500;

// How long after a reconnect's setup the page sends the same setup a second time (never the reset message).
// An instrument or its USB interface may not take the first setup right after a replug: at the 2026-10-02
// bench an SC-55 behind an interface played the wrong sounds after a replug although the right bytes had been
// sent, and sending the setup again later fixed it. Until that second setup has gone out, Strudel's messages to
// the returning port are dropped. A starting value, to be tuned on the bench (the hold could end after the first
// setup if the bench says that one is enough). A time on the injected clock, like RESET_SETTLE_MS.
export const RECONNECT_REPEAT_MS = 1000;

// The events of the page's MIDI facts (a reset, a sound that may cut a note, a sound kept after a failed
// evaluation, a send that failed) wait here until the next publish carries them to the server once.
// src/protocol.ts holds the same number (MAX_MIDI_EVENTS); test/protocol.test.js checks both sides.
export const MAX_PAGE_EVENTS = 20;

// How long after a MIDI track's notes were ended (its channel silenced, or its own note-offs sent) the same
// bytes go out once more. Strudel queues the notes of the next 0.1 s ahead of time (latency 0.1 s and a 0.1 s
// query window in the pinned bundle) and no page code can cancel them, so a note queued just before the stop
// still starts afterwards. Kept after the 2026-10-02 bench: a muted pad ended at once and
// the second pass came about this long later.
export const SILENCE_REPEAT_MS = 300;

// How long before its timestamp a stamped MIDI message leaves the page. The OS holds the message and
// delivers it at its timestamp, so a main-thread stall shorter than this does not move the note. Measured on the
// IAC loopback: no late send under stalls of 30 to 90 ms from 60 ms on, so 120 ms keeps
// a margin. It must stay below CLOCK_HORIZON_MS minus CLOCK_INTERVAL_MS (a unit test asserts it), so the clock
// plans a joining instrument's Start before the first note that must follow it. A starting value, to be tuned on
// the bench.
export const NOTE_AHEAD_MS = 120;

// Chrome has no MIDIOutput.clear(), so a stamped note-on already handed to the OS cannot be taken back. When the page
// must silence it (Stop, a mute), it sends that note's note-off this long after the note's own timestamp: Web MIDI
// keeps the order of messages with the same timestamp, and the 1 ms keeps them apart on any driver.
export const QUEUED_NOTE_OFF_AFTER_MS = 1;

// Stamped messages that are not notes (a control change such as the sustain pedal, pitch bend, NRPN, SysEx) are queued
// ahead just like notes, and Chrome cannot take them back either. When Stop or a mute ends the queued messages of a
// channel that has such a message still queued, the sustain release (CC64 = 0) of that channel is sent a second time
// with a timestamp this long after the latest such message, so a pedal pressed by the stopped code is released after it
// went down and its notes end (every queued note-on has its own note-off, so no All Notes Off is needed). The 2 ms is
// after the latest queued message that is not a note; a note-on queued later still ends with its own note-off.
export const QUEUED_SILENCE_AFTER_MS = 2;

// How far ahead of now a timestamp may be and still be used. Strudel triggers a hap 0.2 to 0.3 s before it sounds, so
// a timestamp further ahead is a fault of the mapping: the message then goes out without one and the page says so
// once (a far timestamp would park bytes in the OS queue, which cannot take them back).
export const NOTE_STAMP_MAX_AHEAD_MS = 1000;

// The Strudel version the page pins (named in the messages about a seam that does not match it).
const PINNED_STRUDEL = '1.3.0';

// While code with a `.midi(` call is prepared, the page clock's stamp is read every NOTE_PREWARM_INTERVAL_MS for at
// most NOTE_PREWARM_MAX_MS, so the page-wide alignment is warm before the first note (five distinct output-timestamp
// pairs take about 50 ms) and even the first notes after a page load carry a timestamp. Starting values.
export const NOTE_PREWARM_INTERVAL_MS = 10;
export const NOTE_PREWARM_MAX_MS = 300;

// The Pattern classes whose `.midi()` already carries the note stamps: a second install on one would stack two.
const stampedPatternClasses = new WeakSet();

// The most results of the rig check kept for a code string (a Mixer drag evaluates the same code often).
const SETUP_MEMO_SIZE = 16;

// The most readings of the MIDI slots kept for a code string (the stop reads the code that played and the one that plays).
const SLOTS_MEMO_SIZE = 4;

/**
 * The bank a sound is sent with, as the shadow keeps it: null when no bank select goes out (a model with
 * none, or a rhythm channel of a model that does not set rhythmBank), else { msb } or { msb, lsb }
 * with 0 for a value the sound does not give, so a sound with no bank brings the capital tone back after a
 * variation tone. `!== true`, not `=== false`: an instrument built without the field keeps today's bytes.
 */
function bankOf(instrument, role, bank) {
  if (instrument.bankSelect === 'none') return null;
  if (role === 'rhythm' && instrument.rhythmBank !== true) return null;
  const msb = bank?.msb ?? 0;
  return instrument.bankSelect === 'msb' ? { msb } : { msb, lsb: bank?.lsb ?? 0 };
}

/**
 * The messages that select one sound on one channel, in the order the instrument needs them: bank select
 * (CC0, then CC32 when the model takes an LSB), then the program change. `entry` is { role, program, bank }.
 * A rhythm channel gets a bank select only when its model sets rhythmBank; every other rhythm channel
 * gets the program change alone. The reset sends the same messages.
 */
export function setupMessages(instrument, channel, entry) {
  const status = channel - 1;
  const bank = bankOf(instrument, entry.role, entry.bank);
  const messages = [];
  if (bank !== null) {
    messages.push([0xb0 | status, 0, bank.msb]);
    if (bank.lsb !== undefined) messages.push([0xb0 | status, 32, bank.lsb]);
  }
  messages.push([0xc0 | status, entry.program]);
  return messages;
}

// The clock and transport status bytes (clock tick, start, continue, stop): Moontide sends them itself, so Strudel's are dropped by the guard.
const TRANSPORT_STATUSES = [0xf8, 0xfa, 0xfb, 0xfc];

export function createMidiOut({
  getWebMidi,
  enableWebMidi,
  supportsMidi,
  parse,
  isPlaying,
  isHidden,
  publish,
  queryPermission,
  setTimer,
  clearTimer,
  queryTrackPattern,
  clock,
  // The MIDI clock: the Strudel scheduler and the shared AudioContext, read at each
  // pass; `perfNow` is performance.now() time, the time base of MIDIOutput timestamps. The option named
  // `clock` above is another thing (the reader of the playing position).
  getScheduler,
  getAudioContext,
  perfNow,
  onClockState = () => {},
  resetSettleMs = RESET_SETTLE_MS,
  now = () => Date.now(),
  onError = defaultOnError,
  onInfo = defaultOnInfo,
}) {
  let access = 'idle';
  let failure = null;
  let triedCode = '';
  let activeCode = '';
  // The code the hello replay evaluates, counted as playing while it replays, so a reload never refuses the code
  // that was playing when an instrument was switched off (set by setReplayBase, null outside the replay).
  let replayCode = null;
  // Every output name observed in this page session: tells "unplugged" from "misnamed".
  const seen = new Set();
  let lastPublished = null;
  let pendingEnable = null;
  // The port watcher: installed once when access first becomes 'enabled'; one pending read at a time.
  let watching = false;
  let readTimer = null;
  // True once the permission ceiling has run out for the enable that is still pending.
  let ceilingPassed = false;
  // Stop targets: the port names any evaluated code has named since page load, in first-use order,
  // and whether a port could not be pinned to a name once (an unreadable port, an index or a call
  // without a port: then Stop silences every connected output).
  const panicNames = [];
  let panicAll = false;
  // The setup file's rig as the server last pushed it, what the page actually SENT to each
  // instrument (instrument id -> channel -> { program, bank }), and the sounds of the code that plays.
  let rig = { setup: 'absent' };
  const shadows = new Map();
  // What the page last SENT as a control to each instrument (instrument id -> channel -> Map from cc to
  // value, previews included), and the controls of the code that plays (a Map keyed like the sounds: slot
  // `<instrument id>:<channel>` -> { instrument, port, channel, values: Map<cc, { id, value }> }).
  const controlShadows = new Map();
  let activeControls = null;
  let activePlan = null;
  // The last valid rig the page saw (null after the file went absent): a file that passes through an
  // invalid state between two valid ones is compared against it, not against the invalid state.
  let lastValid = null;
  // The desired sounds of the evaluation being prepared (a reset that runs meanwhile sends them),
  // and what the page knows of each rig instrument's connection: { key, present, settleTimer, repeatTimer,
  // holding, holdLogged, epoch, resetPromise, resets, resetAt } by instrument id. `holding` is true from the instant a
  // returning port is seen until its second setup has gone out: Strudel's messages to
  // that port are dropped meanwhile. `epoch` counts the cancellations of a connection. A tab that lost the
  // active role is not `active`: it resets and sets up nothing.
  let pendingPlan = null;
  let pendingControls = null;
  // The plan (prepareSetup call) that owns pendingPlan: the same code checked twice gives the same desired Map, so the
  // Map cannot tell two plans apart.
  let pendingOwner = null;
  // The cause of the last preview that could not be sent: each cause is reported once until a preview succeeds.
  let previewCause = null;
  // The channels the evaluation being prepared changed, so a rollback can undo or report each one. A reset
  // that sends the pending sounds adds its channels here too (it wiped them first: nothing to send back).
  let pendingChanges = null;
  let active = true;
  const states = new Map();
  // The rig check of a code string depends on the rig, the connected outputs and the playing flag; it
  // is kept per code so an unchanged evaluation reads and checks nothing again.
  let rigVersion = 0;
  const setupMemo = new Map();
  const slotsMemo = new Map();
  // Events for Claude, sent once with the next facts (see MAX_PAGE_EVENTS).
  const events = [];
  let overflowLogged = false;

  /** The output names Strudel searches right now (empty while Web MIDI is not enabled). */
  function readOutputs() {
    const webMidi = getWebMidi();
    if (!webMidi || typeof webMidi !== 'object' || webMidi.enabled !== true || !Array.isArray(webMidi.outputs)) {
      return [];
    }
    const names = webMidi.outputs.map((output) => output.name);
    for (const name of names) seen.add(name);
    return names;
  }

  /**
   * The output names the browser lists now, only while Web MIDI is enabled in this page (an empty list otherwise). It
   * never enables Web MIDI, so opening the Instruments view's settings editor raises no permission prompt.
   */
  function outputNames() {
    return access === 'enabled' ? readOutputs() : [];
  }

  function facts() {
    return {
      ...buildMidiFacts({
        access,
        failure,
        triedCode,
        activeCode,
        outputs: readOutputs(),
        seen,
        hidden: isHidden(),
        playing: isPlaying(),
        parse,
      }),
      events: events.slice(),
    };
  }

  /** Queues one event for Claude; past MAX_PAGE_EVENTS the oldest is dropped, and that is logged once. */
  function addEvent(event) {
    events.push(event);
    if (events.length <= MAX_PAGE_EVENTS) return;
    events.shift();
    if (overflowLogged) return;
    overflowLogged = true;
    onError(`Moontide: more than ${MAX_PAGE_EVENTS} MIDI events were waiting to be sent, so the oldest were dropped.`);
  }

  // While held, only a forced publish goes out: the page holds the facts during a take-over replay, when
  // the code this tab last evaluated is not the code that plays any more.
  let factsHeld = false;
  function holdFacts(held) {
    factsHeld = held === true;
  }

  /**
   * Sends the facts when they differ from the last ones that went out, when an event waits, or when
   * forced. The events that went out are dropped once the publish returned true, so each is sent once;
   * what is remembered is the facts with an empty event list.
   */
  function publishFacts({ force = false } = {}) {
    if (factsHeld && !force) return;
    const current = facts();
    const json = JSON.stringify({ ...current, events: [] });
    if (!force && current.events.length === 0 && json === lastPublished) return;
    if (publish(current) === true) {
      lastPublished = json;
      events.splice(0, current.events.length);
      overflowLogged = false;
    }
  }

  // Strudel sends its notes through the Output.send of webmidi; the page's own bytes go to the native port
  // and never through it. One wrapper per Output decides whether a message of Strudel's path is dropped.
  const guardedOutputs = new WeakSet();
  // Ports whose clock note hold was logged: one line per hold, not one per dropped note.
  const clockHoldLogged = new Set();
  // Rig instrument ids whose switched-off notes were logged: one line per switch-off, not one per dropped note.
  const offLogged = new Set();
  // Output -> channels (1 to 16) whose messages it drops (the stale-channel rule).
  // Strudel picks the Output when it triggers a note, up to 0.3 s ahead, and plays on that same object
  // later: the notes the old code triggered before a sound change hold the old Output, so the Output's
  // identity, not a time window, tells old notes from new ones.
  const staleChannels = new WeakMap();

  /** True for a note-on: a status of 0x90 to 0x9F and a velocity above 0, both numbers (the data is untrusted). */
  function isNoteOn(data) {
    if (data === null || typeof data !== 'object') return false;
    const status = data[0];
    const velocity = data[2];
    return typeof status === 'number' && status >= 0x90 && status <= 0x9f && typeof velocity === 'number' && velocity > 0;
  }

  /** True for a note-off: a status of 0x80 to 0x8F, or a note-on status with a velocity of exactly 0 (the data is untrusted). */
  function isNoteOff(data) {
    if (data === null || typeof data !== 'object') return false;
    const status = data[0];
    if (typeof status !== 'number') return false;
    return (status >= 0x80 && status <= 0x8f) || (status >= 0x90 && status <= 0x9f && data[2] === 0);
  }

  /** The status byte of a message of Strudel's path (a number or a byte array; the data is untrusted), else undefined. */
  function statusOf(data) {
    if (typeof data === 'number') return data;
    return data !== null && typeof data === 'object' ? data[0] : undefined;
  }

  // The code that already got its clock-dropped event: the Mixer re-evaluates the same code often, and
  // midicmd("clock*96") drops 96 messages per cycle, so the notice is once per distinct code.
  let reportedTransportFor = null;
  let transportPublishTimer = null;

  /**
   * Strudel's clock or transport byte was just dropped. Queues one clock-dropped event for the playing code and
   * arms one deferred publish: nothing else runs inside the send call. Strudel's implicit Start (every .midi()
   * track sends one at cycle 0) looks the same as a written midicmd("start"), so a Start counts only once the
   * scheduler is at cycle 1 or later; with no readable position it is dropped without a notice. The test is a
   * limit, not exact: Strudel sends that Start for every hap with whole.begin 0, so a Start it sends once the
   * scheduler is past cycle 0 (a pattern with an event that begins at cycle 0 later) is taken for a written one and
   * raises the notice (documented in reference/midi.md and docs/decisions.md).
   */
  function noteTransportDropped(status) {
    if (status === 0xfa) {
      let position;
      try {
        position = typeof clock === 'function' ? clock().now : undefined;
      } catch {
        position = undefined;
      }
      if (typeof position !== 'number' || !Number.isFinite(position) || position < 1) return;
    }
    if (reportedTransportFor === activeCode) return;
    reportedTransportFor = activeCode;
    addEvent({ kind: 'clock-dropped' });
    if (transportPublishTimer !== null) return;
    transportPublishTimer = setTimer(() => {
      transportPublishTimer = null;
      try {
        publishFacts();
      } catch (err) {
        onError('Moontide: the MIDI clock notice could not be sent:', err);
      }
    }, 0);
  }

  /**
   * True when `output` drops this message. Five rules, in order: the message is clock or transport (status 0xF8,
   * 0xFA, 0xFB or 0xFC): Moontide sends these itself, so Strudel's are dropped on every port; the message is a channel
   * message (status 0x80 to 0xEF) of a channel the Output is stale on; the Output is the one of a port whose
   * instrument the user switched off (`enabled` is false, every message of Strudel's path to it is dropped,
   * the notes of code already playing included); the Output is the one of a port that is held (a rig instrument whose
   * presence state has `holding`; both rules test whether the output's name contains the port: the substring rule of
   * nativeFor, never broader); or the message is a note-on for a clock instrument that waits for its Start (see
   * below). SysEx and the like pass unless the instrument is off. `data` is untrusted: its type is checked before the
   * status byte is masked. `ts` is the timestamp the message carries (the page clock's mapping) or undefined: a stamped note-on is
   * held by its own timestamp, and the other rules apply to a stamped message as they do to any other.
   */
  function dropsMessage(output, data, ts) {
    const status = statusOf(data);
    if (TRANSPORT_STATUSES.includes(status)) {
      noteTransportDropped(status);
      return true;
    }
    const stale = staleChannels.get(output);
    if (stale !== undefined) {
      if (typeof status === 'number' && status >= 0x80 && status <= 0xef && stale.has((status & 0x0f) + 1)) return true;
    }
    if (rig.setup !== 'valid' || typeof output.name !== 'string') return false;
    for (const instrument of rig.instruments) {
      // Only an explicit false is off: an instrument built without the field (a hand-built test rig) stays on.
      if (instrument.enabled === false && output.name.includes(instrument.port)) {
        if (!offLogged.has(instrument.id)) {
          offLogged.add(instrument.id);
          onInfo(`Moontide: the notes for "${instrument.id}" on MIDI port "${instrument.port}" are dropped while it is switched off.`);
        }
        return true;
      }
      const state = states.get(instrument.id);
      if (state?.holding !== true || !output.name.includes(instrument.port)) continue;
      // One line per hold, not one per dropped note: without it the gap in the music looks like a bug.
      if (!state.holdLogged) {
        state.holdLogged = true;
        onInfo(`Moontide: the notes for "${instrument.id}" on MIDI port "${instrument.port}" wait until its setup is done after the reconnect.`);
      }
      return true;
    }
    // The clock hold: a note-on for an instrument that joined mid-play waits until CLOCK_NOTE_LEAD_MS
    // before its Start, so its first note goes out with its Start. Only note-ons (status 0x90 to 0x9F, velocity
    // above 0): a note already sounding can still end, and control changes pass. A stamped note-on is held by its own
    // timestamp (it leaves up to NOTE_AHEAD_MS before it sounds). `data` is untrusted.
    if (pageClock !== null && isNoteOn(data)) {
      for (const instrument of rig.instruments) {
        if (instrument.clock !== true || !output.name.includes(instrument.port) || !pageClock.holdsNotes(instrument.port, ts)) continue;
        if (!clockHoldLogged.has(instrument.port)) {
          clockHoldLogged.add(instrument.port);
          onInfo(`Moontide: the notes for "${instrument.id}" on MIDI port "${instrument.port}" wait for its MIDI clock Start on the next cycle.`);
        }
        return true;
      }
    }
    return false;
  }

  // The causes of an unstamped note that were already said: one Moontide: line per cause per page session.
  const saidOnce = new Set();
  function sayOnce(cause, text, err) {
    if (saidOnce.has(cause)) return;
    saidOnce.add(cause);
    onError(text, err);
  }

  // { ts, now, triggerAt } of the stamped Output call in progress: set by the Output proxies of a stamped trigger around
  // each method call, read by guardedSend, else null. `triggerAt` is the moment Strudel's trigger ran (the
  // hap was queried), which tells the haps of the code that was playing from those of the code that took over.
  let noteIntent = null;

  /** The arguments of a send whose time option Moontide does not recognize, unchanged, with one loud line per page session. */
  function leftAsItIs(args) {
    sayOnce(
      'rewrite-unknown',
      `Moontide: a MIDI message with a time option Moontide does not recognize went out without a timestamp, so it arrives about ${NOTE_AHEAD_MS} ms early (the page pins @strudel/repl ${PINNED_STRUDEL}).`,
    );
    return args;
  }

  /**
   * The arguments of an Output.send call with the time option moved to the stamped time. Strudel's options object
   * is copied, never changed. An absent time (undefined, null, false, 0: what webmidi passes for "now") becomes the
   * timestamp; a time that is a number above 0 is a note-off webmidi computed from the moment its playNote ran, so
   * it moves by the same amount as the note-on (the note-off is then the timestamp plus the note length). Anything
   * else (a legacy argument list, a string time) is left as it is, and that is said once: the trigger's target was moved
   * NOTE_AHEAD_MS earlier, so such a message goes out without a timestamp and arrives that much early. The data is
   * untrusted: types are checked first.
   */
  function stampedArgs(args, intent) {
    const options = args[1];
    if (options === undefined) return [args[0], { time: intent.ts }, ...args.slice(2)];
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return leftAsItIs(args);
    const time = options.time;
    let moved;
    if (time === undefined || time === null || time === false || time === 0) moved = intent.ts;
    else if (typeof time === 'number' && Number.isFinite(time) && time > 0) moved = time + (intent.ts - intent.now);
    else return leftAsItIs(args);
    return [args[0], { ...options, time: moved }, ...args.slice(2)];
  }

  /** stampedArgs that never throws inside output.send (a throw would break Strudel's trigger): a fault sends the original arguments. */
  function safeStampedArgs(args, intent) {
    try {
      return stampedArgs(args, intent);
    } catch (err) {
      sayOnce('rewrite', `Moontide: a MIDI message could not be given its timestamp, so it went out without one and arrives about ${NOTE_AHEAD_MS} ms early:`, err);
      return args;
    }
  }

  // Native port id -> the stamped messages handed to that port whose timestamp is still ahead, [{ channel, note, ts, on,
  // triggerAt }] (`triggerAt`: when Strudel's trigger for the hap ran, so a stop can tell the stopped track's haps from
  // the haps triggered after the new code took over)
  // (Chrome cannot take them back: Stop, a mute and a sound change use this record). A note-on has `on` true and its
  // pitch in `note`; every other message that is not a note-off (a control change, pitch bend, NRPN, SysEx) has `on`
  // false and no pitch, and `channel` null when the message belongs to no channel (SysEx). Keyed by the id of the native
  // port, not by its name: two ports can share a name, and Stop swaps the Outputs but each new Output sits on the same
  // native port, so the id survives the swap (webmidi's Output.id is the native's id).
  const queuedNotes = new Map();
  let queuedFailureSaid = false;

  /** Drops the records whose timestamp is at or before now, and the ports left empty. */
  function pruneQueued() {
    if (queuedNotes.size === 0 || typeof perfNow !== 'function') return;
    const now = perfNow();
    for (const [id, list] of queuedNotes) {
      const kept = list.filter((record) => record.ts > now);
      if (kept.length === 0) queuedNotes.delete(id);
      else if (kept.length !== list.length) queuedNotes.set(id, kept);
    }
  }

  /**
   * The largest timestamp of the stamped messages (notes or not) still queued on one native port (by id) and channel,
   * or null when none is ahead. A message of no channel (SysEx) counts for every channel.
   */
  function lastQueuedOn(id, channel) {
    pruneQueued();
    let last = null;
    for (const record of queuedNotes.get(id) ?? []) {
      if ((record.channel === channel || record.channel === null) && (last === null || record.ts > last)) last = record.ts;
    }
    return last;
  }

  /**
   * A stamped message was just handed to `output` (sent with `sendArgs`): remembers it while its timestamp is still
   * ahead, a note-on with its pitch for its note-off, any other message but a note-off for the timed silence (a
   * note-off ends a note and needs no compensation). Never throws (a failure is one logged line per page session): it
   * runs inside Strudel's send. `triggerAt` is the moment the hap's trigger ran.
   */
  function recordQueued(output, data, sendArgs, triggerAt) {
    try {
      const on = isNoteOn(data);
      if (!on && isNoteOff(data)) return;
      if (typeof output.id !== 'string') throw new Error('Moontide: the MIDI Output has no id to keep its queued messages under.');
      const options = sendArgs[1];
      const ts = options !== null && typeof options === 'object' ? options.time : undefined;
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
      pruneQueued();
      if (ts <= perfNow()) return;
      const status = statusOf(data);
      const channel = typeof status === 'number' && status >= 0x80 && status <= 0xef ? (status & 0x0f) + 1 : null;
      if (!queuedNotes.has(output.id)) queuedNotes.set(output.id, []);
      queuedNotes.get(output.id).push({ channel, note: on ? data[1] : undefined, ts, on, triggerAt });
    } catch (err) {
      if (queuedFailureSaid) return;
      queuedFailureSaid = true;
      onError('Moontide: a queued MIDI message could not be recorded, so Stop may not end it:', err);
    }
  }

  // Native port id -> channel -> the timestamp of the timed sustain release (CC64 = 0) still ahead there. A hold the page
  // writes on that channel meanwhile (a setup, a resync, a dragged control) goes out after it, or the release would lift
  // it for good while the control shadow still says the pedal is down. Read by `sendCc`; pruned by time.
  const pendingReleases = new Map();

  /** The timestamp of the timed sustain release still ahead on a native port (by id) and channel, or null. */
  function pendingReleaseOn(id, channel) {
    const channels = pendingReleases.get(id);
    const at = channels?.get(channel);
    if (at === undefined) return null;
    if (typeof perfNow === 'function' && at <= perfNow()) {
      channels.delete(channel);
      if (channels.size === 0) pendingReleases.delete(id);
      return null;
    }
    return at;
  }

  /**
   * Sends one control change to a native port, untimed or with the timestamp `at`. A sustain control (CC64) for a channel
   * whose timed release is still ahead goes out QUEUED_NOTE_OFF_AFTER_MS after that release (or at `at` when that is
   * later), so the hold the page writes is the one in force at the end. Throws like `native.send`.
   */
  function sendCc(native, channel, cc, value, at) {
    const release = cc === 64 ? pendingReleaseOn(native.id, channel) : null;
    const message = [0xb0 | (channel - 1), cc, value];
    const ts = release === null ? at : Math.max(at ?? -Infinity, release + QUEUED_NOTE_OFF_AFTER_MS);
    if (ts === undefined) native.send(message);
    else native.send(message, ts);
  }

  /**
   * Ends the queued messages of each native (of one channel when `channel` is given, of those pitches when `pitches`
   * is given; a pitch filter matches note-ons only; of the records whose trigger ran at or before `triggeredBefore`
   * when it is given, so the hap of a track that kept playing and triggered after the takeover is left alone): a
   * note-off at each note-on's own timestamp plus QUEUED_NOTE_OFF_AFTER_MS, on the native port itself. A message of
   * no channel (SysEx) is matched, and forgotten, only when no channel is given (Stop). With `release`, a channel that
   * has a matched message that is not a note still queued (a pedal, a control change) also gets a sustain release
   * (CC64 = 0) with a timestamp QUEUED_SILENCE_AFTER_MS after the latest such message, so it lands after it; no All
   * Notes Off, since each note-on has its own note-off. The matched records are forgotten. A port that throws is
   * logged once by name, whichever message failed, and the others still get theirs.
   */
  function endQueuedNotes(natives, { channel, pitches, triggeredBefore } = {}, release = false) {
    pruneQueued();
    for (const native of natives) {
      const list = queuedNotes.get(native.id);
      if (list === undefined) continue;
      const kept = [];
      const lastOther = new Map();
      let portFailed = false;
      for (const record of list) {
        const onChannel = channel === undefined || record.channel === channel;
        const onPitch = pitches === undefined || (record.on && pitches.includes(record.note));
        const triggered = triggeredBefore === undefined || record.triggerAt <= triggeredBefore;
        if (!onChannel || !onPitch || !triggered) {
          kept.push(record);
          continue;
        }
        if (!record.on) {
          if (record.channel !== null) lastOther.set(record.channel, Math.max(lastOther.get(record.channel) ?? -Infinity, record.ts));
          continue;
        }
        // A port that threw is gone or broken: the other records of it are forgotten without more attempts or lines.
        if (portFailed) continue;
        try {
          native.send([0x80 | (record.channel - 1), record.note, 0], record.ts + QUEUED_NOTE_OFF_AFTER_MS);
        } catch (err) {
          portFailed = true;
          onError(`Moontide: could not end a queued note on MIDI port "${native.name}":`, err);
        }
      }
      if (kept.length === 0) queuedNotes.delete(native.id);
      else queuedNotes.set(native.id, kept);
      if (!release || portFailed) continue;
      for (const [ch, last] of lastOther) {
        const at = last + QUEUED_SILENCE_AFTER_MS;
        try {
          native.send([0xb0 | (ch - 1), 64, 0], at);
        } catch (err) {
          onError(`Moontide: could not release the sustain on MIDI port "${native.name}" after the control changes queued there:`, err);
          break;
        }
        if (!pendingReleases.has(native.id)) pendingReleases.set(native.id, new Map());
        const channels = pendingReleases.get(native.id);
        channels.set(ch, Math.max(channels.get(ch) ?? -Infinity, at));
      }
    }
  }

  /**
   * Stop: ends every queued note-on on every native port that holds one and, with `release`, follows with a timed
   * sustain release on each channel where a control change is queued, then empties the record.
   */
  function endAllQueued(webMidi, release) {
    pruneQueued();
    const natives = Array.from(webMidi.interface.outputs.values()).filter((native) => queuedNotes.has(native.id));
    try {
      endQueuedNotes(natives, {}, release);
    } finally {
      queuedNotes.clear();
    }
  }

  /** Wraps `output.send` once: a dropped message returns the Output without sending, like webmidi's send. */
  function guardOutput(output) {
    if (guardedOutputs.has(output) || typeof output.send !== 'function') return;
    guardedOutputs.add(output);
    const original = output.send;
    output.send = function guardedSend(...args) {
      const intent = noteIntent;
      if (dropsMessage(output, args[0], intent === null ? undefined : intent.ts)) return output;
      if (intent === null) return original.apply(output, args);
      const sendArgs = safeStampedArgs(args, intent);
      const result = original.apply(output, sendArgs);
      recordQueued(output, args[0], sendArgs, intent.triggerAt);
      return result;
    };
  }

  /**
   * One Proxy of an Output for one stamped trigger: reads pass through, and every method call sets the intent
   * { ts, now, triggerAt } for its duration, so the Output.send the method makes knows the time its message is meant for. The
   * real Output runs the method (`this` is the Output, not the proxy), so its own rules keep working. A callback
   * that runs after its timestamp stamps its send moment: a late note goes out at once and keeps its length.
   */
  function outputProxy(output, ts, triggerAt) {
    if (output === null || typeof output !== 'object') return output;
    return new Proxy(output, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return function intentCall(...callArgs) {
          const saved = noteIntent;
          const callNow = perfNow();
          noteIntent = { ts: Math.max(ts, callNow), now: callNow, triggerAt };
          try {
            return value.apply(target, callArgs);
          } finally {
            noteIntent = saved;
          }
        };
      },
    });
  }

  /**
   * Wraps one trigger function of Strudel's `.midi()`. With a timestamp from the page clock for the hap's target
   * time (its 4th argument), the trigger runs with its target moved so that its sends fire NOTE_AHEAD_MS before
   * that timestamp, and WebMidi.outputs is shadowed for the synchronous call by proxies that tell the guard the
   * timestamp. Without one (nothing to give it yet) the trigger runs unchanged.
   */
  function stampTrigger(fn) {
    if (typeof fn !== 'function') return fn;
    return function stampedTrigger(...args) {
      const webMidi = getWebMidi();
      if (pageClock === null || !webMidi || typeof webMidi !== 'object' || webMidi.enabled !== true) return fn.apply(this, args);
      if (!Array.isArray(webMidi.outputs)) {
        sayOnce('outputs', `Moontide: WebMidi.outputs is not a list, so MIDI messages go out without a timestamp (the page pins @strudel/repl ${PINNED_STRUDEL}).`);
        return fn.apply(this, args);
      }
      let stamp;
      try {
        stamp = pageClock.stamp(args[3]);
      } catch (err) {
        sayOnce('stamp', 'Moontide: the page clock could not give a timestamp, so MIDI messages go out without one:', err);
        return fn.apply(this, args);
      }
      // null: the mapping is not warm yet, or the AudioContext does not run. The pre-warm says so once if it stays so.
      if (stamp === null) return fn.apply(this, args);
      const now = perfNow();
      if (stamp - now > NOTE_STAMP_MAX_AHEAD_MS) {
        sayOnce('far', `Moontide: a MIDI timestamp more than ${NOTE_STAMP_MAX_AHEAD_MS} ms ahead was not used, so MIDI messages go out without a timestamp when that happens.`);
        return fn.apply(this, args);
      }
      // A note whose time has passed goes out at once and keeps its length.
      const ts = Math.max(stamp, now);
      const shifted = getAudioContext().currentTime + Math.max(0, ts - now - NOTE_AHEAD_MS) / 1000;
      const proxies = webMidi.outputs.map((output) => outputProxy(output, ts, now));
      // The real webmidi keeps `outputs` as a getter on its prototype; a fake may keep an own property: the own
      // descriptor is put back exactly, and with none the shadow is removed.
      const saved = Object.getOwnPropertyDescriptor(webMidi, 'outputs');
      try {
        Object.defineProperty(webMidi, 'outputs', { configurable: true, get: () => proxies });
      } catch (err) {
        sayOnce('shadow', 'Moontide: WebMidi.outputs could not be shadowed, so MIDI messages go out without a timestamp:', err);
        return fn.apply(this, args);
      }
      try {
        return fn.apply(this, [args[0], args[1], args[2], shifted, ...args.slice(4)]);
      } finally {
        if (saved !== undefined) Object.defineProperty(webMidi, 'outputs', saved);
        else delete webMidi.outputs;
      }
    };
  }

  /**
   * Makes Strudel's `.midi()` send its messages NOTE_AHEAD_MS early, each with the timestamp the page clock gives its
   * hap's target time. `.midi()` is wrapped to run the original on a view of the pattern whose onTrigger
   * wraps Strudel's trigger function; nothing else of the pattern changes. Install it only where Web MIDI exists
   * (the other branch is installNoMidiShim). Throws an Error when Strudel's Pattern, its onTrigger or its midi is
   * missing, or when it was installed on that Pattern already.
   */
  function installNoteStamps(PatternClass) {
    const lost = 'so its MIDI messages would go out without a timestamp';
    if (typeof PatternClass !== 'function') {
      throw new Error(`Moontide: Strudel's Pattern is not available, ${lost}.`);
    }
    const originalOnTrigger = PatternClass.prototype.onTrigger;
    const originalMidi = PatternClass.prototype.midi;
    if (typeof originalOnTrigger !== 'function') {
      throw new Error(`Moontide: Strudel's Pattern has no onTrigger, ${lost}.`);
    }
    if (typeof originalMidi !== 'function') {
      throw new Error(`Moontide: Strudel's Pattern has no midi, ${lost}.`);
    }
    if (stampedPatternClasses.has(PatternClass)) {
      throw new Error("Moontide: the note stamps are already installed on Strudel's Pattern.");
    }
    stampedPatternClasses.add(PatternClass);
    PatternClass.prototype.midi = function stampedMidi(...args) {
      const view = Object.create(this, {
        onTrigger: { value: (fn, ...rest) => originalOnTrigger.call(this, stampTrigger(fn), ...rest) },
      });
      return originalMidi.apply(view, args);
    };
  }

  /** Guards every Output of WebMidi.outputs while Web MIDI is enabled. Never throws. */
  function guardOutputs() {
    try {
      const webMidi = getWebMidi();
      if (!webMidi || typeof webMidi !== 'object' || webMidi.enabled !== true || !Array.isArray(webMidi.outputs)) return;
      for (const output of webMidi.outputs) if (output !== null && typeof output === 'object') guardOutput(output);
    } catch (err) {
      onError('Moontide: could not guard the MIDI outputs:', err);
    }
  }

  /**
   * Watches the port list. The listener goes on the MIDIAccess object through the standard event
   * API: the access object's own statechange handler property belongs to webmidi (it keeps its
   * output list up to date with it) and is never assigned here. webmidi updates its list inside that
   * handler, so the read happens one macrotask later, and Chrome fires several events per plug, so
   * only one read is pending at a time and publishFacts sends only when the facts changed.
   */
  function watchPorts() {
    if (watching) return;
    const webMidi = getWebMidi();
    const native = webMidi && typeof webMidi === 'object' ? webMidi.interface : null;
    if (!native || typeof native.addEventListener !== 'function') return;
    watching = true;
    native.addEventListener('statechange', () => {
      // A returning port is held from this very tick, before the deferred read: Strudel may send a note to it
      // in between. webmidi has updated its list by now (its own handler runs first); the deferred read
      // looks once more.
      guardOutputs();
      syncPresence();
      if (readTimer !== null) return;
      readTimer = setTimer(() => {
        readTimer = null;
        try {
          publishFacts();
        } catch (err) {
          onError('Moontide: MIDI ports could not be read after a change:', err);
        }
        guardOutputs();
        syncPresence();
      }, 0);
    });
  }

  /** Web MIDI is on: remember the outputs there now and start watching the port list. */
  function markEnabled() {
    access = 'enabled';
    readOutputs();
    guardOutputs();
    watchPorts();
    syncPresence();
    syncClock();
  }

  /**
   * The enable itself: asks the permission state first, so a denial never reaches the prompt and a
   * grant never publishes 'pending'. A failed permission query (a browser without the midi
   * permission name) counts as a prompt. Never rejects: every outcome is an access state.
   */
  async function runEnable(knownState) {
    if (!supportsMidi()) {
      access = 'unsupported';
      return;
    }
    let state = knownState;
    if (state === undefined) {
      try {
        state = await queryPermission();
      } catch {
        state = 'prompt';
      }
    }
    if (state === 'denied') {
      access = 'denied';
      return;
    }
    if (state !== 'granted') {
      access = 'pending';
      failure = null;
      publishFacts();
    }
    try {
      await enableWebMidi();
      markEnabled();
    } catch (err) {
      const name = err && typeof err.name === 'string' ? err.name : 'Error';
      if (name === 'SecurityError' || name === 'NotAllowedError') {
        access = 'denied';
      } else {
        access = 'failed';
        failure = name;
      }
      onError('Moontide: Web MIDI could not start:', err);
    }
  }

  /** One shared enable for every evaluation that waits on it. */
  function ensureEnabled(knownState) {
    if (pendingEnable === null) {
      // The outcome is published here, not only by the evaluation that waited: after the ceiling
      // nobody waits any more, and Claude still has to hear that MIDI came up (or was denied).
      pendingEnable = runEnable(knownState)
        .then(() => publishFacts())
        .catch((err) => {
          onError('Moontide: Web MIDI could not be enabled:', err);
        })
        .finally(() => {
          pendingEnable = null;
          ceilingPassed = false;
        });
    }
    return pendingEnable;
  }

  /**
   * Waits for the enable, but not longer than the ceiling. When the ceiling wins the enable keeps
   * running (its outcome still sets the access and publishes) and later evaluations do not wait again.
   */
  async function waitForAnswer(enable) {
    if (ceilingPassed) return;
    let timer = null;
    const ceiling = new Promise((resolve) => {
      timer = setTimer(() => resolve('ceiling'), MIDI_PERMISSION_CEILING_MS);
    });
    const winner = await Promise.race([enable.then(() => 'answered'), ceiling]);
    if (winner === 'ceiling') {
      ceilingPassed = true;
      onError('Moontide: the MIDI permission prompt was not answered in 120 s; the code plays without MIDI until it is answered.');
    } else {
      clearTimer(timer);
    }
  }

  // The pre-warm: one pending timer at most, when it started, and whether its "no timestamp" line was said.
  let prewarmTimer = null;
  let prewarmStarted = 0;
  let prewarmSaid = false;

  /** The page clock's stamp for "now", or undefined when there is no clock or AudioContext to ask. */
  function prewarmStamp() {
    if (pageClock === null) return undefined;
    const ctx = getAudioContext();
    if (ctx === null || ctx === undefined) return undefined;
    return pageClock.stamp(ctx.currentTime);
  }

  function prewarmStep() {
    prewarmTimer = null;
    try {
      const stamp = prewarmStamp();
      if (stamp === undefined || typeof stamp === 'number') return;
      if (perfNow() - prewarmStarted >= NOTE_PREWARM_MAX_MS) {
        if (prewarmSaid) return;
        prewarmSaid = true;
        onInfo("Moontide: MIDI notes go out without a timestamp until the page's audio clock is ready.");
        return;
      }
      prewarmTimer = setTimer(prewarmStep, NOTE_PREWARM_INTERVAL_MS);
    } catch (err) {
      onError('Moontide: MIDI preparation failed:', err);
    }
  }

  /**
   * Polls the page clock's stamp every NOTE_PREWARM_INTERVAL_MS for at most NOTE_PREWARM_MAX_MS, so the mapping the
   * notes are stamped with is warm before the first one. Never awaited, never throws; a pending poll is not doubled.
   * When the time runs out without a timestamp, one info line per page session says notes go out without one.
   */
  function startPrewarm() {
    if (pageClock === null || prewarmTimer !== null) return;
    prewarmStarted = perfNow();
    try {
      const stamp = prewarmStamp();
      if (stamp === undefined || typeof stamp === 'number') return;
      prewarmTimer = setTimer(prewarmStep, NOTE_PREWARM_INTERVAL_MS);
    } catch (err) {
      onError('Moontide: MIDI preparation failed:', err);
    }
  }

  /** Cancels a pending pre-warm (Stop, page hide and losing the playing role). */
  function stopPrewarm() {
    if (prewarmTimer === null) return;
    clearTimer(prewarmTimer);
    prewarmTimer = null;
  }

  /**
   * Runs before every evaluation (the page wraps editor.repl.evaluate). Never rejects: a problem
   * here is one logged error, never a missing reply.
   */
  async function beforeEvaluate(code) {
    try {
      triedCode = code;
      const midi = usesMidi(code, { parse });
      // 'denied' and 'unsupported' stay for the page session; 'failed' is tried again here.
      if (midi && access !== 'enabled' && access !== 'denied' && access !== 'unsupported') {
        await waitForAnswer(ensureEnabled());
      }
      publishFacts();
      // The first notes after a page load must be stamped too: warm the clock's mapping while the code is prepared.
      if (midi && access === 'enabled') startPrewarm();
    } catch (err) {
      onError('Moontide: MIDI preparation failed:', err);
    }
  }

  /**
   * Page start: enables Web MIDI only when the browser already says the permission is granted, so
   * no prompt can appear and the page's first MIDI evaluation finds it ready. Never rejects.
   */
  async function enableIfGranted() {
    try {
      if (!supportsMidi() || access !== 'idle') return;
      let state;
      try {
        state = await queryPermission();
      } catch {
        return;
      }
      if (state !== 'granted') return;
      await ensureEnabled(state);
    } catch (err) {
      onError('Moontide: Web MIDI could not be enabled at page start:', err);
    }
  }

  /** Adds the ports `code` names to the Stop targets; a name already listed keeps its place. */
  function rememberPanicTargets(code) {
    const read = readMidiCalls(code, { parse });
    if (!read.ok) return;
    const { names, all } = panicTargetsFrom(read.calls);
    for (const name of names) if (!panicNames.includes(name)) panicNames.push(name);
    if (all) panicAll = true;
  }

  /** The webmidi object when Web MIDI is enabled and its native interface is there, else null. */
  function enabledWebMidi() {
    const webMidi = getWebMidi();
    if (!webMidi || typeof webMidi !== 'object' || webMidi.enabled !== true) return null;
    if (!Array.isArray(webMidi.outputs) || !webMidi.interface || !webMidi.interface.outputs) return null;
    return webMidi;
  }

  /** Makes an Output send nothing; the call still returns the Output, like the original send. */
  function makeInert(output) {
    output.send = function retiredSend() {
      return output;
    };
  }

  /**
   * Puts a fresh Output on the same native port at `index` of WebMidi.outputs and returns the old one,
   * or null when its native port is gone (nothing to swap).
   */
  function freshOutputAt(webMidi, index) {
    const old = webMidi.outputs[index];
    const native = webMidi.interface.outputs.get(old.id);
    if (!native) return null;
    webMidi.outputs[index] = new old.constructor(native);
    return old;
  }

  // webmidi never prunes WebMidi._disconnectedOutputs, and when a port comes back it puts back the FIRST
  // Output of that list whose native is the returning one. A retired Output left there would return on
  // the next replug and swallow every note, so the list is emptied and each Output in it that is not live
  // is made inert. An Output still in WebMidi.outputs is never touched.
  let disconnectedLogged = false;
  /** The disconnected list of webmidi, or null (one loud line per page session) when it is not there. */
  function disconnectedListOf(webMidi) {
    const list = webMidi._disconnectedOutputs;
    if (Array.isArray(list)) return list;
    if (!disconnectedLogged) {
      disconnectedLogged = true;
      onError('Moontide: WebMidi has no _disconnectedOutputs list, so a retired MIDI output could come back after a replug.');
    }
    return null;
  }

  function emptyDisconnected(webMidi) {
    const list = disconnectedListOf(webMidi);
    if (list === null) return;
    for (const output of list.splice(0)) {
      if (!webMidi.outputs.includes(output)) makeInert(output);
    }
  }

  /**
   * Retires every webmidi Output the page used: a fresh Output on the same native port takes its
   * place in WebMidi.outputs and the old one sends nothing, so callbacks frozen from the stopped code
   * (they close over the old Output) cannot sound after Stop + Play. The disconnected list of webmidi
   * is emptied too (see emptyDisconnected), so a replug after any number of Stops builds or finds a
   * live Output. Strudel looks the port up by name on every note, so the fresh Output is found and
   * unplug/replug still resumes. It also ends, before any panic byte, every note-on already queued ahead with a
   * timestamp (Chrome cannot take it back): its note-off goes QUEUED_NOTE_OFF_AFTER_MS after the note's own
   * timestamp. A channel that also has a control change or pitch bend queued ahead gets a sustain release (CC64 = 0)
   * timestamped QUEUED_SILENCE_AFTER_MS after the latest of them, so a pedal the stopped code pressed is released after
   * it; a hold the page writes on that channel before then goes out after the release (see sendCc). `timedRelease`
   * false leaves the release out: a tab that lost the active role cannot know what the tab that took over sets up
   * on the same ports, and a release landing after that setup would lift its hold. The record is emptied. Synchronous;
   * a failure is one logged error and never blocks the stop.
   */
  function retireOutputs({ timedRelease = true } = {}) {
    stopPrewarm();
    let webMidi;
    try {
      webMidi = enabledWebMidi();
    } catch (err) {
      onError('Moontide: could not retire the MIDI outputs:', err);
      return;
    }
    if (webMidi === null) {
      queuedNotes.clear();
      return;
    }
    // First, before any panic byte: the note-ons already queued ahead cannot be taken back, so each gets its note-off.
    try {
      endAllQueued(webMidi, timedRelease === true);
    } catch (err) {
      onError('Moontide: could not end the queued MIDI notes:', err);
    }
    for (let index = 0; index < webMidi.outputs.length; index++) {
      try {
        const old = freshOutputAt(webMidi, index);
        if (old !== null) makeInert(old);
      } catch (err) {
        onError('Moontide: could not retire a MIDI output:', err);
      }
    }
    try {
      emptyDisconnected(webMidi);
    } catch (err) {
      onError('Moontide: could not empty the list of disconnected MIDI outputs:', err);
    }
    // The fresh Outputs carry the guard too: a Stop during a reconnect hold does not lift it.
    guardOutputs();
  }

  /**
   * Stop's silence, synchronous and raw (native MIDIOutput.send, no timestamp, never Strudel's
   * scheduler): on every port the code has named since page load (on every connected output once a
   * port was given by index, left out or unreadable), CC64 = 0 then CC123 on all 16 channels. The
   * natives are read at call time. One port that throws is logged by name and the
   * others still get their bytes. Sends nothing when no port was named or Web MIDI is not enabled.
   */
  function panic() {
    let natives;
    try {
      const webMidi = enabledWebMidi();
      if (webMidi === null || (panicNames.length === 0 && !panicAll)) return;
      natives = panicOrder(panicNames, panicAll, Array.from(webMidi.interface.outputs.values()));
    } catch (err) {
      onError('Moontide: could not list the MIDI ports to silence:', err);
      return;
    }
    const messages = panicMessages();
    for (const native of natives) {
      try {
        for (const message of messages) native.send(message);
      } catch (err) {
        onError(`Moontide: could not silence MIDI port "${native.name}":`, err);
      }
    }
    // The panic put the sustain pedal up (CC64 = 0) on all 16 channels of every port it silenced: the control shadow
    // forgets what it sent for cc 64 there, so a `hold` the code writes is sent again by the next evaluation.
    if (rig.setup !== 'valid') return;
    for (const instrument of rig.instruments) {
      if (!natives.some((native) => typeof native.name === 'string' && native.name.includes(instrument.port))) continue;
      for (const shadow of controlShadows.get(instrument.id)?.values() ?? []) shadow.delete(64);
    }
  }

  /**
   * The page is going away (close or reload): retire the outputs (which ends the queued note-ons) and send the same
   * panic, best effort.
   */
  function onPageHide() {
    retireOutputs();
    // The followers get their Stop before the panic: a clock left running would keep a sequencer going.
    stopClock();
    panic();
  }

  /** The MIDI slots of `code` (see readMidiSlots), kept per code like the setup check. */
  function slotsOf(code) {
    if (slotsMemo.has(code)) return slotsMemo.get(code);
    const read = readMidiSlots(code, { parse });
    slotsMemo.set(code, read);
    if (slotsMemo.size > SLOTS_MEMO_SIZE) slotsMemo.delete(slotsMemo.keys().next().value);
    return read;
  }

  // The ports whose targeted stop was refused for an ambiguous match, each logged once.
  const ambiguousStops = new Set();

  /** The connected native outputs whose name contains `port` (Strudel's substring rule, never every output). */
  function nativesNamed(port) {
    const webMidi = enabledWebMidi();
    if (webMidi === null) return [];
    return panicOrder([port], false, Array.from(webMidi.interface.outputs.values()));
  }

  /**
   * Sends `messages` to every connected output whose name contains `port`, raw and with no timestamp (like Stop), or,
   * with `sole`, only when exactly one output matches (a send for a stopped track never reaches a second device). A
   * port that throws is logged by name and the others still get their bytes. With `endQueued` ({ channel, pitches }),
   * each matched output first gets the note-offs of the note-ons already queued on it for that channel (and those
   * pitches when given), so the messages never come before a note that was sent ahead; with `followUp` the channel also
   * gets a sustain release timed after the latest control change still queued on it (see endQueuedNotes).
   * Whole numbers only: a channel from 1 to 16 is checked by the callers, a pitch from 0 to 127 here.
   */
  function sendToPort(port, messages, what, { sole = false, endQueued, followUp = false } = {}) {
    let natives;
    try {
      natives = nativesNamed(port);
    } catch (err) {
      onError('Moontide: could not list the MIDI ports to stop:', err);
      return [];
    }
    if (sole && natives.length > 1) {
      // A targeted send never reaches the wrong device (the rule of nativeFor): with several matches nothing goes out.
      if (!ambiguousStops.has(port)) {
        ambiguousStops.add(port);
        onError(`Moontide: more than one MIDI output contains the port "${port}", so a stopped track's notes and channel silence were not sent to either; the notes end at their natural end.`);
      }
      return [];
    }
    for (const native of natives) {
      if (endQueued !== undefined) endQueuedNotes([native], endQueued, followUp);
      try {
        for (const message of messages) native.send(message);
      } catch (err) {
        onError(`Moontide: could not ${what} on MIDI port "${native.name}":`, err);
      }
    }
    return natives;
  }

  /**
   * Silences channels of the ports a stopped track named: sustain off, then All Notes Off, on each target
   * `{ port, channel }`, on the one output the port names (nothing when several match, like the note-offs;
   * only Stop's panic keeps the broad rule). Afterwards the control shadow forgets the sustain value of that channel on the rig
   * instruments that port reaches, so a hold the code writes is sent again by the next evaluation. It also ends first
   * every note-on already queued ahead on that output and channel (Chrome cannot take it back), and releases the
   * sustain a second time after the latest control change still queued on that channel; a hold written on that channel
   * before then (a quick unmute) goes out after that release.
   */
  function sendSilence(targets) {
    for (const { port, channel } of targets) {
      if (!Number.isInteger(channel) || channel < 1 || channel > 16) continue;
      const natives = sendToPort(port, channelSilence(channel), `silence channel ${channel}`, { sole: true, endQueued: { channel }, followUp: true });
      if (rig.setup !== 'valid') continue;
      for (const instrument of rig.instruments) {
        if (!natives.some((native) => typeof native.name === 'string' && native.name.includes(instrument.port))) continue;
        controlShadows.get(instrument.id)?.get(channel)?.delete(64);
      }
    }
  }

  /**
   * Ends the notes with these pitches on one channel of the one output `port` names: a note-off for each (nothing when
   * several match). The note-ons of those pitches already queued ahead on that output and channel are ended first,
   * those whose trigger ran at or before `triggeredBefore` (the takeover instant of the stop) when it is given.
   */
  function sendNoteOffs(port, channel, pitches, triggeredBefore) {
    if (!Number.isInteger(channel) || channel < 1 || channel > 16) return;
    const valid = pitches.filter((pitch) => Number.isInteger(pitch) && pitch >= 0 && pitch <= 127);
    const messages = valid.map((pitch) => [0x80 | (channel - 1), pitch, 0]);
    if (messages.length > 0) sendToPort(port, messages, `end notes on channel ${channel}`, { sole: true, endQueued: { channel, pitches: valid, triggeredBefore } });
  }

  /** True while this tab plays: the stops of a stopped page (Stop's panic did it) or a superseded tab (another tab plays) go nowhere. */
  function mayStop() {
    return active && isPlaying() === true;
  }

  /** The name of a track for a logged line: its label, or its identity for a `$:` track. */
  function trackName(identity) {
    return cutText(identity.startsWith('label:') ? identity.slice('label:'.length) : identity, MIDI_LIMITS.name);
  }

  /** True when the page's playing code has an unmuted track with this identity on this port and channel. */
  function stillPlays(identity, port, channel) {
    const current = slotsOf(activeCode);
    if (!current.ok) return false;
    const track = current.tracks.get(identity);
    return track !== undefined && !track.muted && track.slots.some((slot) => slot.port === port && slot.channel === channel);
  }

  let targetedUnavailable = false;

  /**
   * Ends the sounding notes of one stopped track on a channel another track still plays: its own pattern, from the
   * code that played, is queried around the scheduler's now (the stop instant, read at once) for the pitches that
   * sound, and a note-off goes out for each, again after SILENCE_REPEAT_MS. Both passes also end the matching note-ons
   * queued ahead, but only those whose trigger ran before the takeover, so the note-ons the track that keeps the channel
   * triggers later are left alone. It never blocks the evaluation: the query runs after this returns. `pitches` caches
   * the query of a track that is stopped on several slots.
   */
  function stopTrackNotes(previous, { port, channel, track }, pitches) {
    // The takeover instant, read synchronously: both passes end only the queued note-ons the old code triggered up to it.
    // The record cannot tell which track sent a note, but a note triggered after the takeover is never the stopped track's.
    const takeoverAt = typeof perfNow === 'function' ? perfNow() : undefined;
    if (typeof queryTrackPattern !== 'function' || typeof clock !== 'function') {
      if (!targetedUnavailable) {
        targetedUnavailable = true;
        onError(`Moontide: the notes of "${trackName(track.identity)}" could not be ended: the page has no way to read its sounding notes.`);
      }
      return;
    }
    let instant;
    try {
      instant = clock();
      if (!Number.isFinite(instant.now) || !Number.isFinite(instant.cps) || instant.cps <= 0) throw new Error('Moontide: the scheduler clock is not a finite position and tempo.');
    } catch (err) {
      onError(`Moontide: the notes of "${trackName(track.identity)}" could not be ended:`, err);
      return;
    }
    if (!pitches.has(track.identity)) {
      pitches.set(
        track.identity,
        (async () => {
          const pattern = await queryTrackPattern(previous, track.index);
          if (pattern === null || typeof pattern !== 'object' || typeof pattern.queryArc !== 'function') {
            throw new Error('Moontide: the stopped track did not give a pattern that can be queried.');
          }
          return notesToStop(pattern, instant.now, instant.cps);
        })(),
      );
    }
    pitches.get(track.identity).then(
      (list) => {
        try {
          if (!mayStop() || list.length === 0) return;
          sendNoteOffs(port, channel, list, takeoverAt);
          setTimer(() => {
            try {
              if (!mayStop() || stillPlays(track.identity, port, channel)) return;
              sendNoteOffs(port, channel, list, takeoverAt);
            } catch (err) {
              onError(`Moontide: the notes of "${trackName(track.identity)}" could not be ended:`, err);
            }
          }, SILENCE_REPEAT_MS);
        } catch (err) {
          onError(`Moontide: the notes of "${trackName(track.identity)}" could not be ended:`, err);
        }
      },
      (err) => onError(`Moontide: the notes of "${trackName(track.identity)}" could not be ended:`, err),
    );
  }

  /**
   * After a successful evaluation: ends the notes of the MIDI tracks that stopped sounding between `previous` (the
   * code that played) and `code` (the code that plays now). A channel nothing else plays gets its silence now and
   * once more after SILENCE_REPEAT_MS (the second pass skips a channel the page's code has taken up again meanwhile);
   * a channel another track still plays only has the stopped track's own notes ended. Nothing goes out from a stopped
   * page (Stop's panic did it) or a superseded tab (another tab plays). Never throws: a failure is one logged error.
   */
  function stopRemoved(previous, code) {
    try {
      if (!mayStop() || previous === code) return;
      const stops = midiStops(slotsOf(previous), slotsOf(code));
      if (stops.skipped.length > 0) {
        onError(`Moontide: the port or channel of ${stops.skipped.map((identity) => `"${trackName(identity)}"`).join(', ')} could not be read, so its notes end at their natural end.`);
      }
      if (stops.silence.length > 0) {
        sendSilence(stops.silence);
        setTimer(() => {
          try {
            if (!mayStop()) return;
            const current = slotsOf(activeCode);
            const left = current.ok
              ? stops.silence.filter((slot) => ![...current.tracks.values()].some((track) => !track.muted && track.slots.some((candidate) => candidate.port === slot.port && candidate.channel === slot.channel)))
              : stops.silence;
            sendSilence(left);
          } catch (err) {
            onError('Moontide: a MIDI track could not be silenced:', err);
          }
        }, SILENCE_REPEAT_MS);
      }
      const pitches = new Map();
      for (const stop of stops.targeted) stopTrackNotes(previous, stop, pitches);
    } catch (err) {
      onError('Moontide: a MIDI track could not be silenced:', err);
    }
  }

  /** Called when an evaluation succeeded: `code` is the code that plays now. */
  function recordSuccess(code) {
    const previous = activeCode;
    upcomingCode = null;
    try {
      activeCode = code;
      rememberPanicTargets(code);
      publishFacts();
    } catch (err) {
      onError('Moontide: MIDI state could not be read:', err);
    }
    syncClock();
    stopRemoved(previous, code);
  }

  /** Forgets everything the page knows it sent to one instrument (its sounds and its controls). */
  function forgetShadows(id) {
    shadows.delete(id);
    controlShadows.delete(id);
  }

  /** The Map from cc to the value last sent on one channel of one instrument, created on first use. */
  function controlShadowOf(id, channel) {
    if (!controlShadows.has(id)) controlShadows.set(id, new Map());
    const channels = controlShadows.get(id);
    if (!channels.has(channel)) channels.set(channel, new Map());
    return channels.get(channel);
  }

  /**
   * Off means unplug: silences each instrument that is off in the current rig and was on, on the same port and
   * model, in `base` (the rig it replaces): sustain release then All Notes Off on each of its declared channels, to its
   * one output at once and again SILENCE_REPEAT_MS later (Strudel's own look-ahead may still send a note meanwhile; the
   * guard drops those from the same tick). sendSilence ends the note-ons already queued ahead first, since Chrome
   * cannot take them back. No reset, program change, volume or control byte goes out: the device is not reset, only
   * quieted. Nothing for the first rig of a page (no base), a stopped page or a superseded tab. Never throws.
   */
  function silenceSwitchedOff(base) {
    try {
      if (base === null || base.setup !== 'valid' || rig.setup !== 'valid' || !mayStop()) return;
      const targets = [];
      for (const instrument of rig.instruments) {
        if (instrument.enabled !== false) continue;
        const was = base.instruments.find((candidate) => candidate.id === instrument.id);
        if (was === undefined || was.enabled === false || was.port !== instrument.port || was.model !== instrument.model) continue;
        for (const { channel } of instrument.channels) targets.push({ id: instrument.id, port: instrument.port, channel });
      }
      if (targets.length === 0) return;
      sendSilence(targets);
      setTimer(() => {
        try {
          if (!mayStop() || rig.setup !== 'valid') return;
          sendSilence(targets.filter((target) => rig.instruments.some((candidate) => candidate.id === target.id && candidate.enabled === false)));
        } catch (err) {
          onError('Moontide: a switched-off MIDI instrument could not be silenced:', err);
        }
      }, SILENCE_REPEAT_MS);
    } catch (err) {
      onError('Moontide: a switched-off MIDI instrument could not be silenced:', err);
    }
  }

  /**
   * Stores the rig the server pushed. The remembered checks are dropped, and so are the shadows of
   * instruments the rig no longer has or whose port or model changed (the device behind them is not the
   * one that was set up). The sounds of the playing code that the file no longer backs are forgotten too.
   * An instrument the new rig has switched off is silenced first (silenceSwitchedOff); presence then treats it as
   * absent (syncPresence), so it is reset and set up when it is switched on again.
   */
  function setRig(next) {
    const previous = rig;
    // The rig the new one is compared with for an instrument just switched off: the previous one when valid, else the last valid one.
    const offBase = previous.setup === 'valid' ? previous : lastValid;
    rig = next;
    rigVersion++;
    setupMemo.clear();
    const known = (state, id) => (state.setup === 'valid' ? state.instruments.find((instrument) => instrument.id === id) : undefined);
    for (const id of new Set([...shadows.keys(), ...controlShadows.keys()])) {
      const was = known(previous, id);
      const current = known(rig, id);
      if (current === undefined || was === undefined || was.port !== current.port || was.model !== current.model) forgetShadows(id);
    }
    // The sounds of the playing code are no longer true when the file went away, or when an instrument it
    // names left the file or changed its port or model: a later reset must not send them.
    if (activePlan !== null && (rig.setup === 'absent' || rig.setup === 'valid')) {
      const base = previous.setup === 'valid' ? previous : (lastValid ?? previous);
      const kept = new Map();
      for (const [slot, entry] of activePlan) {
        const was = known(base, entry.instrument);
        const current = known(rig, entry.instrument);
        const gone = rig.setup === 'absent' || current === undefined || (was !== undefined && (was.port !== current.port || was.model !== current.model));
        if (!gone) kept.set(slot, entry);
      }
      activePlan = kept;
    }
    if (activeControls !== null && (rig.setup === 'absent' || rig.setup === 'valid')) {
      const base = previous.setup === 'valid' ? previous : (lastValid ?? previous);
      const kept = new Map();
      for (const [slot, entry] of activeControls) {
        const was = known(base, entry.instrument);
        const current = known(rig, entry.instrument);
        const gone = rig.setup === 'absent' || current === undefined || (was !== undefined && (was.port !== current.port || was.model !== current.model));
        if (!gone) kept.set(slot, entry);
      }
      activeControls = kept;
    }
    if (rig.setup === 'valid') lastValid = rig;
    else if (rig.setup === 'absent') lastValid = null;
    // An instrument that is on again (or gone) logs its next switch-off.
    for (const id of [...offLogged]) if (!known(rig, id) || known(rig, id).enabled !== false) offLogged.delete(id);
    silenceSwitchedOff(offBase);
    syncPresence();
    syncClock();
  }

  /**
   * The one connected native output whose name contains the instrument's port (Strudel's substring
   * rule), read now; null when there is none or when several match (a send must never reach the
   * wrong device: the MIDI notices say why nothing goes out). It does not know the user's on/off choice:
   * the page clock uses it for the Stop of an instrument that was just switched off (see nativeFor).
   */
  function portNative(instrument) {
    const webMidi = enabledWebMidi();
    if (webMidi === null) return null;
    const matches = Array.from(webMidi.interface.outputs.values()).filter(
      (native) => native.state === 'connected' && typeof native.name === 'string' && native.name.includes(instrument.port),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * portNative, except null while the current rig has the instrument switched off: every send of the page
   * that goes through here (setup, sounds, controls, previews, rollbacks) skips an off instrument, as it skips a port
   * that is gone. It reads the current rig at each call, so an off that arrives while a send waits stops that send.
   */
  function nativeFor(instrument) {
    if (rig.setup === 'valid' && rig.instruments.some((candidate) => candidate.id === instrument.id && candidate.enabled === false)) return null;
    return portNative(instrument);
  }

  // The page clock, one per page: it sends Start, ticks and Stop to the ports of the instruments that follow MIDI
  // clock and that the playing code names. Null when the page gave no scheduler (a loud error says so once).
  const pageClock =
    typeof getScheduler === 'function'
      ? createPageClock({
          getScheduler,
          getAudioContext,
          perfNow,
          setTimer,
          clearTimer,
          isPlaying,
          onError,
          // portNative, not nativeFor: a clock instrument just switched off is no longer wanted and still gets its Stop.
          resolveNative: (entry) => portNative(entry),
          // Never start into a device that is being reset or that is held after a reconnect.
          isEligible: (entry) => {
            const state = states.get(entry.id);
            return state !== undefined && state.holding !== true && state.resetPromise === null;
          },
          onState: (port, state) => {
            // The hold of a port is over when its state leaves 'waiting': its next hold logs its own line.
            if (state !== 'waiting') clockHoldLogged.delete(port);
            onClockState();
          },
        })
      : null;
  let clockMissingReported = false;

  // The code of a waiting change from its lead until its takeover (or its cancel): the clock serves the ports it names
  // as well as the ports the playing code names, so a new clock instrument gets its Start on the line.
  let upcomingCode = null;

  /** The ports the given codes (default: the playing code) name in a `.midi()` call (the reading the indicator's `used` flag uses too). */
  function namedPorts(codes = [activeCode]) {
    const names = new Set();
    for (const code of codes) {
      const read = readMidiCalls(code, { parse });
      if (read.ok) for (const call of read.calls) if (call.kind === 'name') names.add(call.name);
    }
    return names;
  }

  /**
   * Tells the clock which ports to serve: the rig instruments that follow MIDI clock and whose port the playing
   * code names (a track of `silence` is enough to name it) and that the user has not switched off (an off clock
   * instrument leaves the wanted set, so the clock's own Stop rule sends its Stop once). Nothing while this tab does
   * not play, the rig is not valid or Web MIDI is not enabled. Never throws.
   */
  function syncClock() {
    try {
      const wantedEntries = [];
      if (active && rig.setup === 'valid' && access === 'enabled') {
        const named = namedPorts(upcomingCode === null ? [activeCode] : [activeCode, upcomingCode]);
        for (const instrument of rig.instruments) if (instrument.clock === true && instrument.enabled !== false && named.has(instrument.port)) wantedEntries.push({ port: instrument.port, id: instrument.id });
      }
      if (pageClock === null) {
        if (wantedEntries.length > 0 && !clockMissingReported) {
          clockMissingReported = true;
          onError('Moontide: the page clock is not available, so no MIDI clock is sent.');
        }
        return;
      }
      pageClock.want(wantedEntries);
    } catch (err) {
      onError('Moontide: the MIDI clock could not be updated:', err);
    }
  }

  /**
   * The clock's add half of a waiting change, at its lead: from now the clock serves the clock instruments the playing
   * code names and those `code` names (the union), so a new instrument gets its Start on the line. The remove half
   * stays in recordSuccess at the takeover: an instrument only the old code names gets its Stop there. Never throws.
   */
  function prepareTakeover(code) {
    upcomingCode = typeof code === 'string' ? code : null;
    syncClock();
  }

  /** A waiting change was canceled: the clock serves the playing code's instruments only again. Never throws. */
  function abandonTakeover() {
    if (upcomingCode === null) return;
    upcomingCode = null;
    syncClock();
  }

  /**
   * The Stop rule for every clock port at once (the Stop button and tool, Strudel's stop shortcut, a page that is
   * going away). Synchronous, and called before the MIDI panic. The ports stay wanted, so the same code plays
   * again with a fresh Start. Never throws.
   */
  function stopClock() {
    if (pageClock === null) return;
    try {
      pageClock.stop();
    } catch (err) {
      onError('Moontide: the MIDI clock could not be stopped:', err);
    }
  }

  function sameSound(a, b) {
    return a.program === b.program && JSON.stringify(a.bank) === JSON.stringify(b.bank);
  }

  /**
   * The rig check of `code` against the current outputs and playing flag: null when there is nothing to
   * check (code without a `.midi(` call, code that does not parse), else { refusal, desired, controls }. Kept per
   * code, rig, outputs and playing flag, so the same code evaluated again is not read again.
   */
  function checkedSetup(code) {
    const outputs = readOutputs();
    const playing = isPlaying() === true;
    // The refusal of newly aimed code depends on what plays and on the replay base, so both are in the key.
    const key = `${rigVersion}\u0000${playing}\u0000${outputs.join('\u0001')}\u0000${activeCode}\u0000${replayCode ?? ''}\u0000${code}`;
    if (setupMemo.has(key)) return setupMemo.get(key);
    let result = null;
    if (usesMidi(code, { parse })) {
      const read = readMidiSetup(code, { parse });
      if (read.ok) {
        // The playing code counts only while the tab plays: after Stop, activeCode is stale and must not excuse a call
        // that is newly aimed at a switched-off instrument. The replay base counts whenever it is set.
        const counted = [];
        if (playing) counted.push(activeCode);
        if (replayCode !== null) counted.push(replayCode);
        const playingPorts = namedPorts(counted);
        result = checkRigSetup({ read, rig, outputs, playing, playingPorts });
      }
    }
    setupMemo.set(key, result);
    if (setupMemo.size > SETUP_MEMO_SIZE) setupMemo.delete(setupMemo.keys().next().value);
    return result;
  }

  /**
   * Sends the messages of one channel's sound; false (and an event, a log) when the port refuses them. With `at` (a
   * timestamp on the page clock's time base) each message carries it, so the sound lands after the notes already
   * queued with an earlier timestamp (see SETUP_AFTER_QUEUED_MS); without it they go out at once, as always.
   */
  function sendSound(native, instrument, channel, entry, bytesSent, at) {
    let went = 0;
    try {
      for (const message of setupMessages(instrument, channel, entry)) {
        if (at === undefined) native.send(message);
        else native.send(message, at);
        went += message.length;
      }
    } catch (err) {
      onError(`Moontide: could not send a sound to MIDI port "${native.name}":`, err);
      const name = err && typeof err.name === 'string' && err.name !== '' ? err.name : 'Error';
      addEvent({ kind: 'send-failed', instrument: cutText(instrument.id, MIDI_LIMITS.name), what: 'setup', failure: cutText(name, MIDI_LIMITS.failure) });
      bytesSent.count += went;
      return { ok: false, partial: went > 0 };
    }
    bytesSent.count += went;
    return { ok: true, partial: false };
  }

  /**
   * Sends one control (CC `cc` = `value`) on one channel of one instrument and remembers it in the control
   * shadow; false (and an event, a log, the cc forgotten) when the port refuses it. Its 3 bytes count toward the
   * guard like the bytes of a sound.
   */
  function sendControl(native, instrument, channel, cc, value, bytesSent, at) {
    try {
      sendCc(native, channel, cc, value, at);
    } catch (err) {
      onError(`Moontide: could not send a control to MIDI port "${native.name}":`, err);
      const name = err && typeof err.name === 'string' && err.name !== '' ? err.name : 'Error';
      addEvent({ kind: 'send-failed', instrument: cutText(instrument.id, MIDI_LIMITS.name), what: 'setup', failure: cutText(name, MIDI_LIMITS.failure) });
      controlShadows.get(instrument.id)?.get(channel)?.delete(cc);
      return false;
    }
    bytesSent.count += 3;
    controlShadowOf(instrument.id, channel).set(cc, value);
    return true;
  }

  /**
   * The controls of one channel the page must send now, in the model's order (the first control of each cc):
   * [{ cc, value }]. `slot` is the controls the code writes there (or undefined), `shadow` the Map from cc to the
   * value last sent (or undefined); `force` (a Set of cc numbers, or undefined) lists controls that are sent anyway. A control wants the number the code writes, else the model's default
   * (defaultOf: cc 7 is the instrument's defaultVolume everywhere). It is sent when the shadow holds another
   * value, or when the shadow knows nothing and the code writes it (after a reset the device holds its
   * defaults, so an unwritten control the page never sent needs nothing).
   */
  function controlsToSend(instrument, slot, shadow, force) {
    const list = [];
    for (const control of controlsByCc(instrument)) {
      const written = slot?.values.get(control.cc);
      const wanted = written === undefined ? defaultOf(instrument, control) : written.value;
      const known = shadow?.get(control.cc);
      // A control in `force` is sent whatever the shadow says: a stamped message of a canceled change is still queued
      // ahead of it and would land after an earlier send of the same value.
      if (force?.has(control.cc) === true || (known === undefined ? written !== undefined : known !== wanted)) list.push({ cc: control.cc, value: wanted });
    }
    return list;
  }

  /**
   * Sends what `controlsToSend` says for one channel (timed with `at` when given); false when a send failed (the rest of
   * the instrument waits). `record` (an array) gets { instrument, channel, cc } of every control that went out, `force`
   * is passed on to `controlsToSend`.
   */
  function sendControls(native, instrument, channel, slot, bytesSent, at, { record, force } = {}) {
    for (const { cc, value } of controlsToSend(instrument, slot, controlShadows.get(instrument.id)?.get(channel), force)) {
      if (!sendControl(native, instrument, channel, cc, value, bytesSent, at)) return false;
      record?.push({ instrument, channel, cc });
    }
    return true;
  }

  /** The channels an instrument has a control slot or a control shadow on, ascending (with `extra` channels). */
  function controlChannels(instrument, slots, extra = []) {
    return Array.from(new Set([...extra, ...slots.map((slot) => slot.channel), ...(controlShadows.get(instrument.id)?.keys() ?? [])])).sort((a, b) => a - b);
  }

  /**
   * The timestamp for bytes that undo a timed sound change made at `changeAt`: SETUP_AFTER_QUEUED_MS after it while it
   * is still ahead, else undefined (they go out at once: the change already sounds, the new bytes follow it anyway).
   */
  function afterTimed(changeAt) {
    if (typeof changeAt !== 'number' || typeof perfNow !== 'function' || changeAt <= perfNow()) return undefined;
    return changeAt + SETUP_AFTER_QUEUED_MS;
  }

  /**
   * Puts every instrument back to what the code that plays writes (previews included in what the shadow holds):
   * the single repair function, used by a rollback, by a gesture that ended without a release and by a failed
   * release. It waits for a reset that is running, sends nothing from a superseded tab or to a port that is not
   * exactly one connected output, and never rejects. When no reset is running it sends before its first await,
   * so an evaluation queued right after it sees the repaired shadow. With `after` (the timestamp of a timed sound
   * change that is being undone) the controls go SETUP_AFTER_QUEUED_MS after it while it is still ahead, so they land
   * after the refused change; once it has passed they go out at once. With `controls` the instruments are put back to
   * those controls (the newer change's, a Map like `activeControls`) instead of the code that plays, and `resend` (a
   * list of { instrument, channel, cc }) names the controls that are sent even when the shadow already holds the value.
   */
  async function resync({ after, controls, resend } = {}) {
    try {
      if (rig.setup !== 'valid') return;
      for (const instrument of rig.instruments) {
        const pendingReset = states.get(instrument.id)?.resetPromise ?? null;
        if (pendingReset !== null) await pendingReset;
        if (!active) return;
        const native = nativeFor(instrument);
        if (native === null) continue;
        const source = controls !== undefined ? controls : activeControls;
        const slots = source === null ? [] : Array.from(source.values()).filter((slot) => slot.instrument === instrument.id);
        const bytesSent = { count: 0 };
        const at = afterTimed(after);
        for (const channel of controlChannels(instrument, slots)) {
          const slot = slots.find((candidate) => candidate.channel === channel);
          const forced = (resend ?? []).filter((item) => item.instrument.id === instrument.id && item.channel === channel);
          const force = forced.length > 0 ? new Set(forced.map((item) => item.cc)) : undefined;
          if (!sendControls(native, instrument, channel, slot, bytesSent, at, { force })) break;
        }
      }
    } catch (err) {
      onError('Moontide: the MIDI controls could not be put back:', err);
    }
  }

  /**
   * Starts dropping the messages of `channel` on every live Output of the instrument's port, just before
   * the program change of that channel goes out, and records each pair in `filtered`. Only the Outputs in
   * WebMidi.outputs now: the closures of the playing code hold exactly these objects.
   */
  function filterStaleChannel(instrument, channel, filtered) {
    const webMidi = enabledWebMidi();
    if (webMidi === null) return;
    for (const output of webMidi.outputs) {
      if (output === null || typeof output !== 'object' || typeof output.name !== 'string' || !output.name.includes(instrument.port)) continue;
      guardOutput(output);
      if (!staleChannels.has(output)) staleChannels.set(output, new Set());
      staleChannels.get(output).add(channel);
      filtered.push({ output, channel });
    }
  }

  /** Lifts the recorded filters (of one channel only when `channel` is given) and forgets them. */
  function liftStaleFilters(filtered, channel) {
    for (let index = filtered.length - 1; index >= 0; index--) {
      if (channel !== undefined && filtered[index].channel !== channel) continue;
      staleChannels.get(filtered[index].output)?.delete(filtered[index].channel);
      filtered.splice(index, 1);
    }
  }

  /**
   * After the new code took over: every filtered Output still in WebMidi.outputs gets a fresh guarded
   * Output on the same native port, and leaves webmidi's disconnected list, so it can never come back on
   * a replug. The old Output keeps dropping its changed channels (the old code's last notes on the
   * channels that did not change still play) and is not made inert. An Output that cannot be swapped has
   * its filters lifted instead, so no filtered Output can return on a replug.
   */
  function swapFilteredOutputs(filtered) {
    if (filtered.length === 0) return;
    const webMidi = enabledWebMidi();
    if (webMidi === null) return;
    for (const output of new Set(filtered.map((item) => item.output))) {
      const index = webMidi.outputs.indexOf(output);
      if (index === -1) {
        // The port left between the program change and the takeover: the Output sits in webmidi's disconnected
        // list and would come back on a replug still dropping the channel. The playing code can no longer
        // reach it, so its filters go and it leaves that list.
        staleChannels.delete(output);
        const gone = disconnectedListOf(webMidi);
        if (gone !== null) for (let at = gone.length - 1; at >= 0; at--) if (gone[at] === output) gone.splice(at, 1);
        continue;
      }
      let old = null;
      try {
        old = freshOutputAt(webMidi, index);
      } catch (err) {
        onError('Moontide: could not swap a MIDI output after a sound change:', err);
      }
      if (old === null) {
        for (const channel of new Set(filtered.filter((item) => item.output === output).map((item) => item.channel))) staleChannels.get(output)?.delete(channel);
        continue;
      }
      guardOutput(webMidi.outputs[index]);
      const list = disconnectedListOf(webMidi);
      if (list === null) continue;
      for (let at = list.length - 1; at >= 0; at--) if (list[at] === old) list.splice(at, 1);
    }
  }

  /**
   * The refusal text the rig check gives `code` (the evaluation then fails at once and the old music keeps playing),
   * or null when it passes or there is nothing to check. Only checks: nothing is sent and no pending sounds are
   * kept, so a reset during a wait sends the sounds of the code that plays. Throws where prepareSetup's check throws.
   */
  function checkSetup(code) {
    if (rig.setup === 'absent') return null;
    const checked = checkedSetup(code);
    return checked === null ? null : checked.refusal;
  }

  /**
   * The remembered stamped setup of one channel of a native port (a message that is not a note), recorded at the line
   * itself, so a later setup on that channel (lastQueuedOn) goes after the line, and Stop's timed sustain release
   * covers it like any queued message.
   * Never throws (a failure is one logged line per page session).
   */
  function recordSetupQueued(native, channel, ts) {
    try {
      pruneQueued();
      if (ts <= perfNow()) return;
      if (!queuedNotes.has(native.id)) queuedNotes.set(native.id, []);
      queuedNotes.get(native.id).push({ channel, note: undefined, ts, on: false, triggerAt: perfNow() });
    } catch (err) {
      if (queuedFailureSaid) return;
      queuedFailureSaid = true;
      onError('Moontide: a queued MIDI message could not be recorded, so Stop may not end it:', err);
    }
  }

  /**
   * The timestamp for the setup of a change that waits for cycle `atCycle`: the page clock's stamp of that line minus
   * SETUP_BEFORE_LINE_MS. When no stamp can be given or it is more than NOTE_STAMP_MAX_AHEAD_MS ahead (a far timestamp
   * would park bytes in the OS queue, which cannot take them back), says so in one Moontide: line, waits until the
   * line through the injected timer and resolves undefined: the setup then goes out without a timestamp. `track` gets
   * { cancel } while that wait runs, so a dropped plan ends it. Never rejects.
   */
  async function timedSetupAt(atCycle, track) {
    let line = null;
    try {
      line = pageClock === null ? null : pageClock.stampOfCycle(atCycle);
    } catch (err) {
      onError('Moontide: the page clock could not give the timestamp of the line:', err);
    }
    const now = perfNow();
    if (line !== null && line - now <= NOTE_STAMP_MAX_AHEAD_MS) return line - SETUP_BEFORE_LINE_MS;
    let waitMs = 0;
    let why;
    if (line !== null) {
      waitMs = line - now;
      why = `the line is more than ${NOTE_STAMP_MAX_AHEAD_MS} ms ahead`;
    } else {
      why = 'the page clock has no timestamp for it yet';
      try {
        const position = typeof clock === 'function' ? clock() : null;
        if (position !== null && Number.isFinite(position.now) && Number.isFinite(position.cps) && position.cps > 0) {
          waitMs = ((atCycle - position.now) / position.cps) * 1000;
        }
      } catch {
        waitMs = 0;
      }
    }
    onError(`Moontide: the MIDI setup of the change that waits for its line goes out without a timestamp at the line, because ${why}.`);
    if (!(waitMs > 0)) return undefined;
    await new Promise((resolve) => {
      const timer = setTimer(resolve, waitMs);
      track({
        cancel() {
          clearTimer(timer);
          resolve();
        },
      });
    });
    return undefined;
  }

  /**
   * The setup step of one evaluation: null when there is no rig, else { refusal, send,
   * commit, rollback }. Code with nothing to check (no `.midi(` call, or code that does not parse) gets a
   * plan with nothing to send, whose `commit` forgets the sounds of the code that played before: that code
   * no longer plays them, so a later reset must not send them again. A refusal is the text of a failed
   * evaluation and the other three do nothing. Without
   * one, `send` puts the bank select and program change of every sound that differs from what was last
   * sent on its channel on the wire and waits the guard (only when bytes went out), `commit` runs after a
   * successful evaluation, and `rollback` after a failed one sends the previous sound back for the
   * channels that changed (a channel that had none keeps the new sound, and Claude is told by an event),
   * after a reset of that instrument that is still running. `send` and `rollback` never reject.
   * While old code plays, `send` also makes the live Outputs of the port drop the messages of each channel
   * whose sound changes (so no note of the old code plays with the new sound); `commit`
   * swaps those Outputs for fresh ones and `rollback` lifts the filters first. Notes the old code already queued
   * ahead with a timestamp cannot be dropped, so the bank select, program change and controls of a changed channel
   * go SETUP_AFTER_QUEUED_MS after the last of them (the old notes sound with the old sound); `rollback` times its
   * bytes after that change, never before it.
   *
   * With `{ atCycle }` (a change that waits for a line, prepared at its lead) the plan is timed: `send` stamps every
   * bank select, program change and control of every changed channel with the page clock's stamp of that cycle minus
   * SETUP_BEFORE_LINE_MS, never arms the stale-channel drop (the old code's notes are all stamped before the line)
   * and remembers each stamped channel, so a later setup on it goes after it. When no stamp can be given, or it is
   * more than NOTE_STAMP_MAX_AHEAD_MS ahead, one Moontide: line says so and `send` waits for the line and sends
   * without a timestamp. `drop` forgets a plan that was not committed (a canceled change) and stops that wait. Bytes
   * it already stamped cannot be recalled: the playing code's sounds and controls are put back after them (the shadows
   * follow what was sent), except when an immediate change replaces the plan and has prepared its own setup, which
   * stays (see the comment in `drop`).
   */
  function prepareSetup(code, { atCycle } = {}) {
    const timed = atCycle !== undefined;
    pendingPlan = null;
    pendingControls = null;
    pendingOwner = null;
    pendingChanges = null;
    if (rig.setup === 'absent') return null;
    const checked = checkedSetup(code);
    if (checked === null) {
      return {
        refusal: null,
        send: async () => {},
        commit: () => {
          activePlan = new Map();
          activeControls = new Map();
        },
        rollback: async () => {},
        drop: () => {},
      };
    }
    const { refusal, desired, controls } = checked;
    if (refusal !== null) {
      return { refusal, send: async () => {}, commit: () => {}, rollback: async () => {}, drop: () => {} };
    }
    // A reset that runs while this evaluation is being prepared sends these sounds, so a later reset
    // never wipes a sound this evaluation is about to send.
    const owner = {};
    pendingPlan = desired;
    pendingControls = controls;
    pendingOwner = owner;
    const changes = [];
    pendingChanges = changes;
    // The { output, channel } pairs this evaluation filters (see filterStaleChannel).
    const filtered = [];
    // The latest timestamp this evaluation's timed setup carries, or null when nothing was timed (a rollback goes after it).
    let latestTimed = null;
    // A timed plan only: dropped (the change was canceled), the wait for the line that is running, whether its
    // stamped bytes went out (they cannot be taken back), and whether the change took over.
    let dropped = false;
    let wait = null;
    let sentStamped = false;
    let committed = false;
    // The controls this plan stamped on the line ({ instrument, channel, cc }): they cannot be recalled, so a newer
    // immediate change that wants those channels sends its own value after them (see drop).
    const stampedControls = [];
    /** Forgets the pending sounds of this plan (a timed plan only when they are still its own: a newer plan may hold them). */
    function releasePending() {
      if (timed && pendingOwner !== owner) return;
      pendingPlan = null;
      pendingControls = null;
      pendingOwner = null;
      pendingChanges = null;
    }
    return {
      refusal: null,
      async send() {
        try {
          // A superseded tab sets nothing up.
          if (!active) return;
          // The stamp every byte of a timed plan carries, or undefined after a wait for the line.
          let lineAt;
          if (timed) {
            lineAt = await timedSetupAt(atCycle, (state) => {
              wait = state;
            });
            if (dropped || !active) return;
            // The stamped bytes below cannot be taken back once they are queued: a cancel puts the playing code's
            // sounds and controls back after them (see drop).
            if (lineAt !== undefined) {
              sentStamped = true;
              latestTimed = lineAt;
            }
          }
          const bytesSent = { count: 0 };
          for (const instrument of rig.instruments) {
            const wanted = Array.from(desired.values())
              .filter((entry) => entry.instrument === instrument.id)
              .sort((a, b) => a.channel - b.channel);
            const slots = Array.from(controls.values()).filter((slot) => slot.instrument === instrument.id);
            // An instrument the code does not name is still brought back to its defaults for a control that left the code.
            const leaving = controlChannels(instrument, []).some((channel) => controlsToSend(instrument, undefined, controlShadows.get(instrument.id)?.get(channel)).length > 0);
            if (wanted.length === 0 && slots.length === 0 && !leaving) continue;
            // A reset in its wait finishes first; it sends this evaluation's sounds itself, and the bytes it
            // sent count toward the guard.
            const pendingReset = states.get(instrument.id)?.resetPromise ?? null;
            if (pendingReset !== null) bytesSent.count += await pendingReset;
            if (!active || dropped) return;
            const native = nativeFor(instrument);
            if (native === null) continue;
            if (!shadows.has(instrument.id)) shadows.set(instrument.id, new Map());
            const shadow = shadows.get(instrument.id);
            // Channels ascending; on each, the sound goes first, then the controls the code writes (after the
            // program change, so a control never lands before the sound it belongs to).
            const channels = controlChannels(instrument, slots, wanted.map((entry) => entry.channel));
            for (const channel of channels) {
              const entry = wanted.find((candidate) => candidate.channel === channel);
              // A timed plan stamps the whole channel with the line; otherwise `at` is set only for a channel whose sound
              // changes while old code plays, and the other channels go out at once.
              let at = lineAt;
              if (lineAt !== undefined) recordSetupQueued(native, channel, lineAt + SETUP_BEFORE_LINE_MS);
              if (entry !== undefined) {
                const previous = shadow.get(channel) ?? null;
                const next = { role: entry.role, program: entry.program, bank: bankOf(instrument, entry.role, entry.bank) };
                if (previous === null || !sameSound(previous, next)) {
                  // Only while old code plays: at the first evaluation and after a Stop the scheduler may trigger
                  // the new code's first notes inside the evaluation, before the commit swaps the Output, and
                  // there are no old notes to drop anyway (Stop retired the old Outputs).
                  if (!timed && isPlaying() === true && activeCode !== '') {
                    filterStaleChannel(instrument, channel, filtered);
                    const lastQueued = lastQueuedOn(native.id, channel);
                    if (lastQueued !== null) {
                      at = lastQueued + SETUP_AFTER_QUEUED_MS;
                      if (latestTimed === null || at > latestTimed) latestTimed = at;
                    }
                  }
                  const sent = sendSound(native, instrument, channel, next, bytesSent, at);
                  if (!sent.ok) {
                    liftStaleFilters(filtered, channel);
                    // A partly sent change leaves the channel in a state nobody knows: forget it, so it is sent whole next time.
                    if (sent.partial) shadow.delete(channel);
                    break;
                  }
                  shadow.set(channel, next);
                  changes.push({ instrument, channel, previous, sound: entry.sound });
                  // A held note on this channel may be cut by the change: the playing code used the channel.
                  if (previous !== null && isPlaying() === true && activePlan !== null && activePlan.has(`${instrument.id}:${channel}`)) {
                    addEvent({ kind: 'sound-cut', instrument: cutText(instrument.id, MIDI_LIMITS.name), channel });
                  }
                }
              }
              const slot = slots.find((candidate) => candidate.channel === channel);
              if (!sendControls(native, instrument, channel, slot, bytesSent, at, { record: lineAt !== undefined ? stampedControls : undefined })) break;
            }
          }
          // A timed plan goes out at the lead and nothing waits for it, so there is no guard to wait out.
          if (!timed && bytesSent.count > 0) {
            await new Promise((resolve) => setTimer(resolve, Math.ceil(SETUP_GUARD_MS + bytesSent.count * SETUP_WIRE_MS_PER_BYTE)));
          }
        } catch (err) {
          onError('Moontide: the MIDI setup could not be sent:', err);
        }
      },
      commit() {
        committed = true;
        // The facts, events included, went out with recordSuccess inside the evaluation.
        activePlan = desired;
        activeControls = controls;
        releasePending();
        try {
          swapFilteredOutputs(filtered);
        } catch (err) {
          onError('Moontide: could not swap the MIDI outputs after a sound change:', err);
        }
      },
      drop() {
        dropped = true;
        if (wait !== null) wait.cancel();
        // An immediate change that replaces this one has prepared (and sent) its own setup before its pattern is
        // installed, and that setup is still pending here: it is what the instrument must end on. A timed newer change
        // prepares its setup later, at its own lead, so it finds nothing here and goes after the put-back.
        const successor = timed && pendingOwner !== null && pendingOwner !== owner ? { plan: pendingPlan, controls: pendingControls } : null;
        releasePending();
        // Bytes stamped on the line are already queued on the port and cannot be recalled: when the change is canceled
        // after they went out, the instrument would switch to the canceled change's sounds and controls on the line
        // while the playing code goes on. The playing code's sounds and controls are sent back right after them, so
        // what stays is the stretch between the stamped bytes and the corrective ones (SETUP_AFTER_QUEUED_MS). When an
        // immediate change replaces this one, the sounds it sets up stay (its own setup went after the stamped bytes)
        // and its controls are sent again after them; the playing code's sounds are put back only on the channels it
        // does not set up.
        if (timed && sentStamped && !committed) {
          void putBack(successor).then(() => {
            try {
              if (events.length > 0) publishFacts();
            } catch (err) {
              onError('Moontide: MIDI state could not be read:', err);
            }
          });
        }
      },
      async rollback() {
        // First and synchronous: the old code keeps playing, so its notes must pass again at once.
        liftStaleFilters(filtered);
        pendingPlan = null;
        pendingControls = null;
        pendingOwner = null;
        pendingChanges = null;
        await putBack();
        // The evaluation failed, so nothing else will publish: the events (kept sounds, cut notes) go out here,
        // before the failed reply that Claude reads.
        try {
          if (events.length > 0) publishFacts();
        } catch (err) {
          onError('Moontide: MIDI state could not be read:', err);
        }
      },
    };
    /**
     * Sends the sounds this plan changed back to what the channels held before it, then the controls the playing code
     * writes; both after the plan's own timed change while it is still ahead, never before it. With a `successor` (an
     * immediate change that replaces this plan: { plan, controls }) a channel it sets up keeps the sound it holds, and
     * the controls it writes are sent again after this plan's stamped ones. Never rejects.
     */
    async function putBack(successor = null) {
      try {
        for (const { instrument, channel, previous, sound } of changes) {
          // The successor's own setup went out after this plan's bytes (or the sound is the same one): the shadow is true.
          if (successor !== null && successor.plan.has(`${instrument.id}:${channel}`)) continue;
          if (previous === null) {
            // Nothing is known to send back: the channel keeps the new sound until the next change.
            addEvent({ kind: 'sound-kept', instrument: cutText(instrument.id, MIDI_LIMITS.name), channel, sound: cutText(sound, MIDI_LIMITS.name) });
            continue;
          }
          // A device in a reset drops what it is sent: wait for the reset, as send() does, so the old
          // sound goes to a ready device and the shadow the reset left stays true.
          const pendingReset = states.get(instrument.id)?.resetPromise ?? null;
          if (pendingReset !== null) await pendingReset;
          // A superseded tab sends nothing back (also when the role went during the wait): another tab controls the device now.
          if (!active) continue;
          const native = nativeFor(instrument);
          if (native === null) continue;
          const bytesSent = { count: 0 };
          // After the timed change of this evaluation while it is still ahead, so no old note sounds with the refused sound.
          const sent = sendSound(native, instrument, channel, previous, bytesSent, afterTimed(latestTimed));
          if (sent.ok) shadows.get(instrument.id)?.set(channel, previous);
          else if (sent.partial) shadows.get(instrument.id)?.delete(channel);
        }
      } catch (err) {
        onError('Moontide: the MIDI setup could not be rolled back:', err);
      }
      // The controls go back to what the playing code writes: a control change of this evaluation, and a preview
      // that left the instrument at a value the code does not hold (the shadow knows what was sent, the code is the truth).
      await resync(
        successor === null
          ? { after: latestTimed ?? undefined }
          : { after: latestTimed ?? undefined, controls: successor.controls ?? undefined, resend: stampedControls },
      );
    }
  }

  /** True when `instrument`'s port is exactly one connected output of the list (the same rule as the indicator). */
  function isPresent(instrument, outputs) {
    return portState(instrument.port, outputs, seen).state === 'connected';
  }

  /** Ends the hold of a returning port: Strudel's messages to it pass again. */
  function releaseHold(state) {
    state.holding = false;
  }

  /**
   * Ends everything a connection still has waiting: the settle timer, the timer of the second setup and the
   * hold. A reset already running notices through `epoch` that its connection was cancelled.
   */
  function cancelSettle(state) {
    state.epoch++;
    if (state.settleTimer !== null) {
      clearTimer(state.settleTimer);
      state.settleTimer = null;
    }
    if (state.repeatTimer !== null) {
      clearTimer(state.repeatTimer);
      state.repeatTimer = null;
    }
    releaseHold(state);
  }

  /**
   * Compares the output list with what each rig instrument was last known to be. Presence is read from the
   * list, never counted from events, so a noisy statechange burst changes nothing. A new instrument that is
   * present is reset now; one that came back after being absent is held from that instant (Strudel's messages to
   * its port are dropped), reset once after the settle delay and set up a second time RECONNECT_REPEAT_MS after
   * the first setup, and the hold ends there; one that left has its pending reset, second setup and hold
   * cancelled and its shadow cleared. `adopt` records the presence without any reset or hold (taking the active
   * role back). Does nothing for a superseded tab, without access or without a valid
   * rig. Never throws.
   */
  function syncPresence({ adopt = false } = {}) {
    try {
      if (!active || access !== 'enabled' || rig.setup !== 'valid') return;
      const outputs = readOutputs();
      const ids = new Set(rig.instruments.map((instrument) => instrument.id));
      for (const [id, state] of states) {
        if (ids.has(id)) continue;
        cancelSettle(state);
        states.delete(id);
      }
      for (const instrument of rig.instruments) {
        const key = `${instrument.model}\u0000${instrument.port}`;
        // An instrument the user switched off is treated as absent, so off takes the "left" branch below and
        // on the "returned" branch (hold, settle, one reset, setup, second setup): no new reset path.
        const present = instrument.enabled !== false && isPresent(instrument, outputs);
        let state = states.get(instrument.id);
        if (state !== undefined && state.key !== key) {
          // Another port or model is another device: a new instrument.
          cancelSettle(state);
          states.delete(instrument.id);
          state = undefined;
        }
        if (state === undefined) {
          state = { key, present, settleTimer: null, repeatTimer: null, holding: false, epoch: 0, resetPromise: null, resets: 0, resetAt: null, holdLogged: false };
          states.set(instrument.id, state);
          if (present && !adopt) startReset(instrument, state, 'start');
          continue;
        }
        if (state.present === present) continue;
        state.present = present;
        cancelSettle(state);
        if (!present) {
          forgetShadows(instrument.id);
          continue;
        }
        if (adopt) continue;
        state.holding = true;
        state.holdLogged = false;
        state.settleTimer = setTimer(() => {
          state.settleTimer = null;
          // The rig or the ports may have changed during the settle delay: look again before sending anything.
          const current = connectedInstrument(state, instrument.id);
          if (current === undefined) {
            releaseHold(state);
            return;
          }
          startReset(current, state, 'reconnect');
        }, resetSettleMs);
      }
    } catch (err) {
      onError('Moontide: MIDI ports could not be compared with the setup file:', err);
    }
  }

  /** Starts one reset of an instrument; one that is still running finishes first. The promise never rejects. */
  function startReset(instrument, state, reason) {
    const previous = state.resetPromise;
    const epoch = state.epoch;
    const run = (previous === null ? resetInstrument(instrument, state, reason, epoch) : previous.then(() => resetInstrument(instrument, state, reason, epoch))).then((bytes) => {
      if (state.resetPromise === run) state.resetPromise = null;
      return bytes;
    });
    state.resetPromise = run;
  }

  /**
   * The instrument of the rig that a timer of `state` may still act on: the tab is the active one, the state is
   * still the instrument's, the rig is valid, the instrument is in it and its port is exactly one connected
   * output, and the user has not switched it off meanwhile. undefined when anything of that changed while the timer waited.
   */
  function connectedInstrument(state, id) {
    if (!active || states.get(id) !== state || rig.setup !== 'valid') return undefined;
    const current = rig.instruments.find((candidate) => candidate.id === id);
    return current !== undefined && current.enabled !== false && isPresent(current, readOutputs()) ? current : undefined;
  }

  /** Arms the second setup of a reconnect: the same setup goes out again RECONNECT_REPEAT_MS after the first. */
  function armRepeat(state, id) {
    if (state.repeatTimer !== null) clearTimer(state.repeatTimer);
    state.repeatTimer = setTimer(() => {
      state.repeatTimer = null;
      const current = connectedInstrument(state, id);
      if (current === undefined) {
        releaseHold(state);
        return;
      }
      startReset(current, state, 'repeat');
    }, RECONNECT_REPEAT_MS);
  }

  /**
   * For each declared channel ascending: the sound the code declares there (the evaluation being prepared
   * first, else the code that plays), then the volume the code writes (same order) else the model's default,
   * always, then every other control the code writes there, in the model's order. The shadows take what was
   * sent. `wiped` is true for a reset, which cleared the instrument first: a sound of the evaluation being
   * prepared is then listed in the change list, so a rollback tells Claude the channel kept it. Returns the
   * number of bytes sent; a send that throws throws out of here.
   */
  function sendDeclaredSetup(instrument, native, { wiped = false } = {}) {
    let setupBytes = 0;
    if (!shadows.has(instrument.id)) shadows.set(instrument.id, new Map());
    const shadow = shadows.get(instrument.id);
    const channels = instrument.channels.map((entry) => entry.channel).sort((a, b) => a - b);
    for (const channel of channels) {
      const slot = `${instrument.id}:${channel}`;
      const pending = pendingPlan?.get(slot);
      const entry = pending ?? activePlan?.get(slot);
      if (entry !== undefined) {
        // The evaluation being prepared may still fail: the channel was wiped by the reset, so a rollback
        // has no previous sound to send back and tells Claude the channel keeps the new one.
        // A slot that send() already changed keeps its own entry: that one holds the real earlier sound.
        if (wiped && pending !== undefined && pendingChanges?.some((change) => change.instrument.id === instrument.id && change.channel === channel) === false) {
          pendingChanges.push({ instrument, channel, previous: null, sound: pending.sound });
        }
        const next = { role: entry.role, program: entry.program, bank: bankOf(instrument, entry.role, entry.bank) };
        for (const message of setupMessages(instrument, channel, next)) {
          native.send(message);
          setupBytes += message.length;
        }
        shadow.set(channel, next);
      }
      const controlSlot = pendingControls?.get(slot) ?? activeControls?.get(slot);
      const volume = controlSlot?.values.get(7)?.value ?? defaultOf(instrument, { cc: 7 });
      native.send([0xb0 | (channel - 1), 7, volume]);
      controlShadowOf(instrument.id, channel).set(7, volume);
      setupBytes += 3;
      for (const control of controlsByCc(instrument)) {
        const written = control.cc === 7 ? undefined : controlSlot?.values.get(control.cc);
        if (written === undefined) continue;
        sendCc(native, channel, control.cc, written.value);
        controlShadowOf(instrument.id, channel).set(control.cc, written.value);
        setupBytes += 3;
      }
    }
    return setupBytes;
  }

  /**
   * The second setup of a reconnect: the setup of this instant, sent synchronously to
   * exactly one connected output, with no reset message, no wait, no change-list entry and no 'reset' event.
   * The hold ends here whatever happens. A send that fails is one log line and a send-failed event.
   */
  function sendSecondSetup(instrument, state, epoch) {
    // A cancellation since the request ended this connection (and may have started a newer hold): do nothing.
    if (state.epoch !== epoch) return 0;
    try {
      const native = active ? nativeFor(instrument) : null;
      if (native === null) return 0;
      try {
        return sendDeclaredSetup(instrument, native);
      } catch (err) {
        forgetShadows(instrument.id);
        onError(`Moontide: could not send the second setup to MIDI port "${native.name}":`, err);
        const name = err && typeof err.name === 'string' && err.name !== '' ? err.name : 'Error';
        addEvent({ kind: 'send-failed', instrument: cutText(instrument.id, MIDI_LIMITS.name), what: 'reset', failure: cutText(name, MIDI_LIMITS.failure) });
        publishFacts();
        return 0;
      }
    } catch (err) {
      onError('Moontide: the second MIDI setup could not be sent:', err);
      return 0;
    } finally {
      releaseHold(state);
    }
  }

  /**
   * The reset of one instrument, in the order the instrument needs: the model's reset messages, a
   * cleared shadow, the model's wait, then the declared setup of every channel (sendDeclaredSetup: sound,
   * volume, written controls). Resolves with the number of setup bytes sent after the wait; never rejects. A
   * reset that cannot be sent is told to Claude and does not count. A 'reconnect' reset holds the port (see
   * syncPresence): when its setup has gone out the second setup is armed, and every other way out releases
   * the hold. Reason 'repeat' is that second setup, not a reset (see sendSecondSetup).
   */
  async function resetInstrument(instrument, state, reason, epoch) {
    if (reason === 'repeat') return sendSecondSetup(instrument, state, epoch);
    const id = cutText(instrument.id, MIDI_LIMITS.name);
    // A cancellation since the request (the port left, the role went) already ended this connection's hold.
    const leave = () => {
      if (reason === 'reconnect' && state.epoch === epoch) releaseHold(state);
      return 0;
    };
    let native = nativeFor(instrument);
    // A port that is ambiguous or gone is never a reset target.
    if (native === null || !active) return leave();
    let setupBytes = 0;
    let failed = null;
    try {
      const reset = instrument.reset;
      if (reset !== null) for (const message of reset.messages) native.send(message);
      shadows.set(instrument.id, new Map());
      controlShadows.set(instrument.id, new Map());
      const wait = reset === null ? 0 : reset.waitMs;
      if (wait > 0) await new Promise((resolve) => setTimer(resolve, wait));
      // The tab may have lost the role, or the device left, during the wait.
      if (!active) return leave();
      native = nativeFor(instrument);
      if (native === null) {
        forgetShadows(instrument.id);
        return leave();
      }
      setupBytes = sendDeclaredSetup(instrument, native, { wiped: true });
      state.resets++;
      state.resetAt = now();
    } catch (err) {
      failed = err;
      forgetShadows(instrument.id);
      onError(`Moontide: could not reset MIDI port "${native.name}":`, err);
    }
    if (reason === 'reconnect' && state.epoch === epoch) {
      if (failed === null && active && states.get(instrument.id) === state) armRepeat(state, instrument.id);
      else releaseHold(state);
    }
    try {
      if (failed === null) {
        addEvent({ kind: 'reset', instrument: id, reason });
      } else {
        const name = failed && typeof failed.name === 'string' && failed.name !== '' ? failed.name : 'Error';
        addEvent({ kind: 'send-failed', instrument: id, what: 'reset', failure: cutText(name, MIDI_LIMITS.failure) });
      }
      publishFacts();
    } catch (err) {
      onError('Moontide: MIDI state could not be read:', err);
    }
    return setupBytes;
  }

  /**
   * What the page shows of the setup file: { setup: 'absent' }, { setup: 'invalid', problems, more }
   * (plus `unreadable: true` or `buildMismatch: true` when the rig carries that flag, never as an undefined key),
   * or { setup: 'valid', instruments } in file order, each { id, port, state, matches, resetAt, used }.
   * `state` and `matches` come from portState over the outputs now and the outputs seen in this page
   * session (the rule the facts use, so the page and Claude read the same state); the state is null while
   * Web MIDI is not enabled. `resetAt` is the time of the instrument's last completed reset in this page
   * session, or null. `used` is true when the code that plays names the instrument's port. `enabled` is false when
   * the user switched the instrument off in the page (an instrument built without the field reads on). `clock` is the clock
   * state of the instrument: 'none' | 'waiting' | 'running'. It is 'none' unless the instrument follows the
   * clock, is connected and is not switched off; the page clock decides the rest (a port that names no instrument of the code, or a
   * stopped music, is 'none' there). The page clock pushes each change through the onClockState option.
   */
  function rigView() {
    if (rig.setup === 'absent') return { setup: 'absent' };
    if (rig.setup === 'invalid') {
      const view = { setup: 'invalid', problems: rig.problems, more: rig.more };
      if (rig.unreadable === true) view.unreadable = true;
      if (rig.buildMismatch === true) view.buildMismatch = true;
      return view;
    }
    const enabled = access === 'enabled';
    const outputs = enabled ? readOutputs() : [];
    const named = namedPorts();
    return {
      setup: 'valid',
      instruments: rig.instruments.map((instrument) => {
        const { state, matches } = enabled ? portState(instrument.port, outputs, seen) : { state: null, matches: [] };
        return {
          id: instrument.id,
          port: instrument.port,
          state,
          matches: matches.slice(0, MIDI_LIMITS.outputs),
          resetAt: states.get(instrument.id)?.resetAt ?? null,
          used: named.has(instrument.port),
          // The user's on/off choice: the card's switch and the top bar's count read it.
          enabled: instrument.enabled !== false,
          clock: instrument.enabled !== false && instrument.clock === true && pageClock !== null && state === 'connected' ? pageClock.stateOf(instrument.port) : 'none',
        };
      }),
    };
  }

  /** One preview that could not be sent: logged once per cause until a preview succeeds again; always false. */
  function previewFailed(cause, text, err) {
    if (previewCause !== cause) {
      previewCause = cause;
      onError(text, err);
    }
    return false;
  }

  /**
   * Sends one control's CC now, while the user drags it (the page's own live gesture; nothing is evaluated).
   * `target` is { instrumentId, channel, cc, value }. Synchronous and it never throws: whole numbers only (channel
   * 1 to 16, cc and value 0 to 127), only to the one connected output whose name contains the instrument's port,
   * and nothing from a superseded tab. The control shadow takes the value, so the release evaluation's setup step
   * sends nothing more for it. Returns false (and one logged error per cause) when the CC could not be sent;
   * the release still writes the code. A preview during another evaluation may be corrected by the next resync.
   */
  function previewControl({ instrumentId, channel, cc, value }) {
    try {
      if (!Number.isInteger(channel) || channel < 1 || channel > 16 || !Number.isInteger(cc) || cc < 0 || cc > 127 || !Number.isInteger(value) || value < 0 || value > 127) {
        return previewFailed('invalid', 'Moontide: a MIDI preview needs a channel from 1 to 16 and a controller and value from 0 to 127.');
      }
      if (!active) return previewFailed('superseded', 'Moontide: a MIDI preview was not sent: another tab plays now.');
      if (rig.setup !== 'valid') return previewFailed('no-rig', 'Moontide: a MIDI preview was not sent: there is no valid instruments.json.');
      const instrument = rig.instruments.find((candidate) => candidate.id === instrumentId);
      if (instrument === undefined) return previewFailed('no-instrument', `Moontide: a MIDI preview was not sent: instrument "${String(instrumentId)}" is not in instruments.json.`);
      if (instrument.enabled === false) return previewFailed('off', `Moontide: a MIDI preview was not sent: instrument "${instrument.id}" is switched off.`);
      // While the instrument resets it drops what it is sent: a preview now would be remembered as sent and never heard,
      // so the release's setup step (which waits for the reset) is the one that sends the value.
      // The same while the port is held after a replug: the device may drop it as well.
      if (states.get(instrument.id)?.resetPromise != null || states.get(instrument.id)?.holding === true) {
        return previewFailed('resetting', `Moontide: a MIDI preview was not sent: instrument "${instrument.id}" is being reset; the value goes out when the drag is released.`);
      }
      const native = nativeFor(instrument);
      if (native === null) {
        return previewFailed('no-output', `Moontide: a MIDI preview was not sent: no single connected output contains the port "${instrument.port}".`);
      }
      sendCc(native, channel, cc, value);
      controlShadowOf(instrument.id, channel).set(cc, value);
      previewCause = null;
      return true;
    } catch (err) {
      return previewFailed('send-failed', 'Moontide: a MIDI preview could not be sent:', err);
    }
  }

  /**
   * Tells the page whether it is the tab that plays. A superseded tab (false) resets and sets up nothing and
   * its pending settle timers are cancelled. Taking the role back (true) is not a connection: the shadows
   * are cleared, because another tab may have changed the sounds, and the presence is adopted without a
   * reset; the replay's evaluation sends the sounds the code declares again.
   */
  function setActive(next) {
    const value = next === true;
    if (value === active) return;
    active = value;
    if (!active) {
      stopPrewarm();
      for (const state of states.values()) cancelSettle(state);
      // A superseded tab wants no clock: every port whose Start went out gets its Stop at once, and no tick follows.
      syncClock();
      return;
    }
    shadows.clear();
    controlShadows.clear();
    syncPresence({ adopt: true });
    // Back in the role: the clock instruments the playing code names get a new Start on the next cycle boundary.
    syncClock();
  }

  /**
   * The hello replay re-plays the code the server says was playing. While it runs, that code counts as playing for
   * the refusal of newly aimed code (S3), so an instrument switched off since does not make it "new". A string sets
   * the base, anything else (null) clears it. Page code sets it only around the replay and clears it in a finally.
   */
  function setReplayBase(code) {
    replayCode = typeof code === 'string' ? code : null;
  }

  return {
    beforeEvaluate,
    enableIfGranted,
    setReplayBase,
    recordSuccess,
    publishFacts,
    holdFacts,
    facts,
    outputNames,
    retireOutputs,
    panic,
    onPageHide,
    stopClock,
    setRig,
    rigView,
    checkSetup,
    prepareSetup,
    prepareTakeover,
    abandonTakeover,
    previewControl,
    resync,
    setActive,
    installNoteStamps,
  };
}
