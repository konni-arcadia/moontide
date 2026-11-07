// The Scratchpad's Listen player: it plays the motif's notes, lengths and velocities on an output the user chose, by handing timed notes to an
// injected `emit`. It holds no browser global and no timer of its own (the page gives it the clock, the timer and the output, like
// page/midi-in.js), so node:test drives it with fakes, and it knows nothing of Web MIDI: `emit` is page/midi-out.js's sendListenNote.
//
// A pass runs every LISTEN_PASS_MS and hands over only the notes due within LISTEN_AHEAD_MS, because Chrome cannot take back a message that
// has a time stamp. Each note's time is worked out when it is next to go, never far ahead, so a tempo ramp of the music is followed. The player
// keeps its own record of every note-on it handed over and of every note that sounds, and Stop ends exactly those, with targeted note-offs
// (never an All Notes Off, which would cut a playing track on a shared channel): an off now for a note that sounds, and an off a moment after
// the stamp of a note handed over for later.
//
// Start 'now' begins a short look-ahead after the press and runs at the music's tempo. Start 'music' begins on a cycle line of the music, so
// the motif is heard in context. With Loop on the player reads the motif again at each lap, so an edit is heard from the next pass.

import { UNITS_PER_CYCLE, listenSchedule, motifUnits } from './scratch-model.js';

/** How often a pass runs, in milliseconds. */
export const LISTEN_PASS_MS = 25;
/** How far ahead of now a note may be handed over: above the page's measured margin for a stamped note, far below its fault limit. */
export const LISTEN_AHEAD_MS = 150;
/** How long after the press a start at once begins. */
export const LISTEN_LEAD_MS = 100;
/** A cycle line nearer than this when Listen is pressed is too close to catch: the next one is taken. */
export const LISTEN_LINE_MARGIN_MS = 60;
/** A note ends this long before its written end, as the music's own MIDI path ends its notes, so two notes of one pitch back to back both sound. */
export const LISTEN_OFF_EARLY_MS = 10;
/** The note-off of a note handed over for later goes out this long after its stamp (the same constant as page/midi-out.js). */
export const LISTEN_QUEUED_OFF_AFTER_MS = 1;

const STARTS = ['now', 'music'];

/**
 * Builds the player and returns `{ play, stop, setLoop, position, state }`.
 *
 * - `perfNow()` is the page clock in milliseconds, the clock the stamps are on; `setTimer(fn, ms)` and `clearTimer(handle)` run the passes.
 * - `emit({ instrumentId, channel, kind, pitch, velocity, at })` plays one note on or off at the stamp `at` (none: at once) and answers
 *   `{ ok: true }` or `{ refused: word, ... }`. A refusal ends the play.
 * - `stampOfCycle(cycle)` gives the stamp of a cycle line of the music, or null; `musicCycle()` the music's cycle now, or null while it does not
 *   play; `readCps()` the tempo in cycles a second.
 * - `onState(state)` is told every change: `{ kind: 'waiting', cycle }`, `{ kind: 'playing', loop }`, `{ kind: 'ended' }`, `{ kind: 'stopped', reason }` or
 *   `{ kind: 'refused', refused, ..., mid }`, each with `instrumentId` and `channel`; `mid` says whether a note had been handed over.
 *
 * `play({ readMotif, instrumentId, channel, start, loop })` starts a play ('now' or 'music'; `readMotif()` gives the motif, read again at each lap),
 * ends one that is playing without a word, and answers whether the new one started. `stop(reason)` silences what the play started and reports it;
 * it does nothing when nothing plays. `setLoop(on)` changes what happens at the end of the pass. `position()` is the unit in the motif now, or null
 * while it waits or nothing plays.
 */
export function createScratchListen({ perfNow, setTimer, clearTimer, emit, stampOfCycle, musicCycle, readCps, onState = () => {} }) {
  for (const [name, value] of Object.entries({ perfNow, setTimer, clearTimer, emit, stampOfCycle, musicCycle, readCps, onState })) {
    if (typeof value !== 'function') throw new TypeError(`Moontide: the Listen player needs ${name}, a function.`);
  }

  // The play in progress, or null: { readMotif, instrumentId, channel, start, loop, laps, handed, started, finishAt, waiting, timer }.
  let run = null;
  let last = { kind: 'idle' };

  function report(state) {
    last = state;
    onState(state);
  }

  const here = () => ({ instrumentId: run.instrumentId, channel: run.channel });

  // One note handed to the output. A refusal comes back as the answer's word; an exception counts as a refusal, so a pass never dies.
  function send(kind, pitch, velocity, at) {
    try {
      const answer = emit({ instrumentId: run.instrumentId, channel: run.channel, kind, pitch, velocity, at });
      if (answer !== null && typeof answer === 'object' && answer.refused !== undefined) return answer;
      return null;
    } catch {
      return { refused: 'send-failed' };
    }
  }

  // Ends what the play started: an off now for a note that sounds, an off just after the stamp of a note whose on is still to come. Best
  // effort: an output that has gone refuses these too, and there is nothing more to do for it.
  function silence() {
    const now = perfNow();
    for (const entry of run.handed) {
      if (entry.offAt !== null && entry.offAt <= now) continue;
      if (entry.onAt > now) send('off', entry.pitch, 0, entry.onAt + LISTEN_QUEUED_OFF_AFTER_MS);
      else send('off', entry.pitch, 0, undefined);
    }
    run.handed = [];
  }

  // Ends the play with a state to report: the sound is cut, the pass is cancelled and nothing is left to run.
  function finish(state) {
    const closing = run;
    if (closing.timer !== null) clearTimer(closing.timer);
    closing.timer = null;
    if (state.kind !== 'ended') silence();
    run = null;
    report({ ...state, instrumentId: closing.instrumentId, channel: closing.channel });
  }

  const refuse = (answer, extra = {}) => finish({ kind: 'refused', ...answer, ...extra, mid: run.started });

  // The next lap of the play, or null after it has finished the play with the reason. `after` is the lap before it (null for the first).
  // A lap holds the events of the motif as read now, `timeOf(unit)` (the stamp of a unit of the lap, or null when the music's clock gives none),
  // `unitAt()` (the unit the lap is at now, or null before it begins) and `begun()`.
  function startLap(after) {
    const motif = run.readMotif();
    const events = listenSchedule(motif);
    if (events.length === 0) return refuse({ refused: 'empty' }) ?? null;
    const units = motifUnits(motif);
    const lap = { events, units, next: 0, onAt: new Map() };
    if (run.start === 'music') {
      let line;
      if (after === null) {
        const cycleNow = musicCycle();
        if (cycleNow === null) return refuse({ refused: 'music-not-playing' }) ?? null;
        line = Math.floor(cycleNow) + 1;
        let stamp = stampOfCycle(line);
        if (stamp !== null && stamp - perfNow() < LISTEN_LINE_MARGIN_MS) {
          line += 1;
          stamp = stampOfCycle(line);
        }
        if (stamp === null) return refuse({ refused: 'no-clock' }) ?? null;
      } else {
        line = after.line + after.units / UNITS_PER_CYCLE;
      }
      return {
        ...lap,
        line,
        timeOf: (unit) => stampOfCycle(line + unit / UNITS_PER_CYCLE),
        unitAt: () => {
          const cycle = musicCycle();
          if (cycle === null) return null;
          const unit = (cycle - line) * UNITS_PER_CYCLE;
          return unit < 0 ? null : Math.min(unit, units);
        },
        begun: () => {
          const cycle = musicCycle();
          return cycle !== null && cycle >= line;
        },
      };
    }
    const cps = readCps();
    if (typeof cps !== 'number' || !(cps > 0) || !Number.isFinite(cps)) return refuse({ refused: 'tempo' }) ?? null;
    const msPerUnit = 1000 / (cps * UNITS_PER_CYCLE);
    const startPerf = after === null ? perfNow() + LISTEN_LEAD_MS : after.endPerf;
    return {
      ...lap,
      endPerf: startPerf + units * msPerUnit,
      timeOf: (unit) => startPerf + unit * msPerUnit,
      unitAt: () => {
        const unit = (perfNow() - startPerf) / msPerUnit;
        return unit < 0 ? null : Math.min(unit, units);
      },
      begun: () => perfNow() >= startPerf,
    };
  }

  // The stamp an event goes out at: its time, with a note ended a little before its written end but never less than 1 ms after it began. Null
  // when the music's clock gives no time.
  function stampOf(lap, event) {
    const at = lap.timeOf(event.unit);
    if (at === null || event.kind === 'on') return at;
    return Math.max(at - LISTEN_OFF_EARLY_MS, (lap.onAt.get(event.pitch) ?? -Infinity) + 1);
  }

  // Records what a handed-over note adds to what is sounding.
  function note(lap, event, at) {
    if (event.kind === 'on') {
      lap.onAt.set(event.pitch, at);
      run.handed.push({ pitch: event.pitch, onAt: at, offAt: null });
      return;
    }
    const open = run.handed.find((entry) => entry.pitch === event.pitch && entry.offAt === null && entry.onAt <= at);
    if (open !== undefined) open.offAt = at;
    run.finishAt = Math.max(run.finishAt, at);
  }

  function pass() {
    run.timer = null;
    const now = perfNow();
    // In the music, the play ends when the music does: there is no cycle line to play on any more.
    if (run.start === 'music' && musicCycle() === null) {
      finish({ kind: 'stopped', reason: 'music-stopped' });
      return;
    }
    run.handed = run.handed.filter((entry) => entry.offAt === null || entry.offAt > now);
    while (run.laps.length > 1 && run.laps[1].begun()) run.laps.shift();
    if (run.waiting && run.laps[0].begun()) {
      run.waiting = false;
      report({ kind: 'playing', ...here(), loop: run.loop });
    }
    for (;;) {
      let lap = run.laps[run.laps.length - 1];
      if (lap.next >= lap.events.length) {
        if (run.loop) {
          lap = startLap(lap);
          if (lap === null) return;
          run.laps.push(lap);
          continue;
        }
        if (now >= run.finishAt) {
          finish({ kind: 'ended' });
          return;
        }
        break;
      }
      const event = lap.events[lap.next];
      const at = stampOf(lap, event);
      if (at === null) {
        refuse({ refused: 'no-clock' });
        return;
      }
      if (at - now > LISTEN_AHEAD_MS) break;
      const refused = send(event.kind, event.pitch, event.velocity, at);
      if (refused !== null) {
        refuse(refused);
        return;
      }
      run.started = true;
      note(lap, event, at);
      lap.next += 1;
    }
    run.timer = setTimer(pass, LISTEN_PASS_MS);
  }

  function play({ readMotif, instrumentId, channel, start, loop }) {
    if (typeof readMotif !== 'function') throw new TypeError('Moontide: the Listen player needs readMotif, a function that gives the motif.');
    if (!STARTS.includes(start)) throw new Error(`Moontide: a Listen start is 'now' or 'music', got ${String(start)}`);
    if (run !== null) {
      if (run.timer !== null) clearTimer(run.timer);
      silence();
      run = null;
    }
    run = { readMotif, instrumentId, channel, start, loop: loop === true, laps: [], handed: [], started: false, finishAt: -Infinity, waiting: start === 'music', timer: null };
    const lap = startLap(null);
    if (lap === null) return false;
    run.laps.push(lap);
    report(run.waiting ? { kind: 'waiting', ...here(), cycle: lap.line } : { kind: 'playing', ...here(), loop: run.loop });
    pass();
    return run !== null;
  }

  function stop(reason = 'stop') {
    if (run === null) return;
    finish({ kind: 'stopped', reason });
  }

  function setLoop(on) {
    if (run === null) return;
    run.loop = on === true;
    if (!run.waiting) report({ kind: 'playing', ...here(), loop: run.loop });
  }

  function position() {
    if (run === null) return null;
    for (let index = run.laps.length - 1; index >= 0; index--) {
      const unit = run.laps[index].unitAt();
      if (unit !== null) return unit;
    }
    return null;
  }

  return { play, stop, setLoop, position, state: () => last };
}
