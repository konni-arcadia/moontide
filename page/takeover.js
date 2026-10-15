// The timed takeover of Moontide's browser page: the gate pattern that holds the old music until
// a cycle line, and the waiting-change record that decides what follows the takeover. No DOM access at
// import time and every dependency injected, so node:test can import it with fakes.

import { boundaryCycle, MIN_TAKEOVER_LEAD_SECONDS, TAKEOVER_HOOK_LEAD_SECONDS } from './change-timing.js';

/**
 * A pattern that is `oldPattern` for every query span before cycle `boundary` and `newPattern` from there on,
 * so the takeover lands exactly on the line whatever the scheduler's slice grid is. A span that crosses the
 * line is split: the old pattern is queried over [begin, boundary) and the new one over [boundary, end), each
 * half through state.setSpan so the controls (the scheduler's `cyclist` marker, `_cps`) stay on both halves.
 * Built with the constructor of the new pattern (never a global Pattern that user code could reassign).
 * `onLead` fires once, when the span end reaches `boundary - leadCycles`; `onReached` fires once, on the first
 * span whose end is past the boundary; lead always before reached. Only the scheduler's own queries (those that
 * carry the `cyclist` control) fire the hooks; the pattern is still gated for every other query. Both run inside the scheduler's slice
 * callback, where a throw would lose the whole 50 ms slice of music, so every hook call is caught, reported
 * through `onError` and never rethrown. Fractions are compared with lte/gte/gt, never with === or <.
 */
export function gatePattern(oldPattern, newPattern, boundary, { TimeSpan, leadCycles, onLead, onReached, onError }) {
  if (typeof TimeSpan !== 'function') {
    throw new Error('Moontide: the pinned Strudel has no TimeSpan constructor, so a timed change cannot be built.');
  }
  if (typeof newPattern.constructor !== 'function') {
    throw new Error('Moontide: the new pattern has no constructor, so a timed change cannot be built.');
  }
  function safely(fn) {
    try {
      fn();
    } catch (err) {
      try {
        onError('Moontide: a takeover hook failed:', err);
      } catch {
        // A failing reporter must not break the music either.
      }
    }
  }
  let leadFired = false;
  let reachedFired = false;
  return new newPattern.constructor((state) => {
    const begin = state.span.begin;
    const end = state.span.end;
    // Only the scheduler's own playback query (it carries the `cyclist` control) counts as "the line is near" or
    // "the line is reached". The Drawer's lookahead of up to 2 cycles, the Timeline, Jam and the MIDI stop sweep
    // query the same pattern without it and must not trigger the takeover bookkeeping early.
    const fromScheduler = typeof state.controls?.cyclist === 'string';
    if (fromScheduler && !leadFired && Number(end) >= boundary - leadCycles) {
      leadFired = true;
      safely(onLead);
    }
    if (fromScheduler && !reachedFired && end.gt(boundary)) {
      reachedFired = true;
      safely(onReached);
    }
    if (end.lte(boundary)) return oldPattern.query(state);
    if (begin.gte(boundary)) return newPattern.query(state);
    return [
      ...oldPattern.query(state.setSpan(new TimeSpan(begin, boundary))),
      ...newPattern.query(state.setSpan(new TimeSpan(boundary, end))),
    ];
  });
}

/**
 * The waiting change of the page: one record at most (a newer change replaces it, last wins). The factory
 * only keeps the record and calls the injected hooks; the page decides what follows the takeover.
 *   getScheduler() -> the scheduler (started, pattern, cps, lastEnd), getTypes() -> { TimeSpan },
 *   getTiming() -> the parsed timing of the change being evaluated ({ at, lineLength }, plus atCycle when the change is written for one given line),
 *   getCps() -> the tempo that plays now (cycles per second), for the line and the lead hook; the scheduler's own cps
 *   by default, but a program's setcps has already reached the scheduler when a change is armed, so the page gives the
 *   tempo from before the evaluation,
 *   isPlaying() -> whether a version plays now (a first Play and a Play after Stop take over at once),
 *   msUntil(cycle) -> milliseconds until that cycle is audible, setTimer/clearTimer -> the timer functions,
 *   onArmed(record), onLead(record), onReached(record), onCancel(record, reason), onError(text, err).
 * onLead and onReached are called through queueMicrotask, never inside the scheduler's query.
 */
export function createTakeover({
  getScheduler,
  getTypes,
  getTiming,
  getCps = () => getScheduler().cps,
  isPlaying,
  msUntil,
  setTimer,
  clearTimer,
  onArmed,
  onLead,
  onReached,
  onCancel,
  onError,
}) {
  let current = null;
  let lastFinished = null; // { gate, newPattern } of the newest record that finished
  let counter = 0;

  function safely(fn) {
    try {
      fn();
    } catch (err) {
      onError('Moontide: a takeover callback failed:', err);
    }
  }

  // The page's reached hook (the tempo of the waiting code), run exactly once: from the microtask after the gate's
  // first query past the line, or earlier when the record is finished or settled before that microtask ran.
  function runReached(record) {
    if (record.reachedRun || record.canceled) return;
    record.reachedRun = true;
    safely(() => onReached(record));
  }

  function finish(record) {
    if (record.finished || record.canceled || current !== record) return;
    if (record.reached) runReached(record);
    record.finished = true;
    lastFinished = { gate: record.gate, newPattern: record.newPattern };
    current = null;
    if (record.timer !== null) clearTimer(record.timer);
    record.timer = null;
    const finishers = record.finishers;
    record.finishers = [];
    for (const finisher of finishers) safely(finisher);
  }

  function settleReached() {
    if (current !== null && current.reached) finish(current);
  }

  function cancel(reason) {
    const record = current;
    if (record === null) return;
    current = null;
    record.canceled = true;
    record.cancelReason = reason;
    if (record.timer !== null) clearTimer(record.timer);
    record.timer = null;
    record.finishers = [];
    safely(() => onCancel(record, reason));
  }

  return {
    /**
     * null when the change takes over at once; otherwise { boundary }. A timing that carries `atCycle` (a change written
     * for one given line, see pinnedTiming) takes that line while it is still at least MIN_TAKEOVER_LEAD_SECONDS ahead
     * of the scheduler frontier: { boundary: atCycle, pinned: true }; once it is closer, the next line of the timing's
     * own length is taken and the result says { pinned: false }, so the caller can write its change again for that line.
     * Changes no state.
     */
    plan() {
      const timing = getTiming();
      if (timing.at === 'now' || !isPlaying()) return null;
      const scheduler = getScheduler();
      const cps = getCps();
      const pinnedLine = timing.atCycle;
      if (pinnedLine !== undefined && (pinnedLine - scheduler.lastEnd) / cps >= MIN_TAKEOVER_LEAD_SECONDS) {
        return { boundary: pinnedLine, pinned: true };
      }
      const boundary = boundaryCycle({
        frontier: scheduler.lastEnd,
        cps,
        lineLength: timing.lineLength,
        minLeadSeconds: MIN_TAKEOVER_LEAD_SECONDS,
      });
      return pinnedLine === undefined ? { boundary } : { boundary, pinned: false };
    },

    /**
     * Records the change that waits for `boundary` and returns the gate the scheduler must play meanwhile.
     * A waiting record is replaced (reason 'replaced'). The gate is built over the pattern that actually
     * plays: the waiting record's own, never over a waiting gate and never over a finished one.
     */
    arm({ boundary, pattern, playingCode, onReached: onReachedNow }) {
      const scheduler = getScheduler();
      settleReached();
      const waiting = current;
      let playingPattern;
      if (waiting !== null) playingPattern = waiting.playingPattern;
      else if (lastFinished !== null && scheduler.pattern === lastFinished.gate) playingPattern = lastFinished.newPattern;
      else playingPattern = scheduler.pattern;
      const code = waiting !== null ? waiting.playingCode : playingCode;
      if (waiting !== null) cancel('replaced');
      counter += 1;
      const record = {
        id: counter,
        boundary,
        code: null,
        evaluateId: null,
        playingPattern,
        playingCode: code,
        newPattern: pattern,
        gate: null,
        finishers: [],
        timer: null,
        finished: false,
        canceled: false,
        cancelReason: null, // why it was canceled ('stop', 'replaced', ...), for a reply that comes after the cancel
        reached: false, // true once the gate queried past the line: the new code is queued and plays from the line
        reachedRun: false,
        newCps: null, // the tempo the waiting code asked for, applied at the line (set by the page)
        replied: false, // true once the page sent the reply that announced the change
        midiPlan: null, // the timed MIDI setup prepared at the lead (set by the page)
      };
      record.gate = gatePattern(playingPattern, pattern, boundary, {
        TimeSpan: getTypes().TimeSpan,
        leadCycles: TAKEOVER_HOOK_LEAD_SECONDS * getCps(),
        onLead() {
          queueMicrotask(() => {
            if (!record.canceled) safely(() => onLead(record));
          });
        },
        onReached() {
          if (record.canceled) return;
          record.reached = true;
          // The cheap part runs inside the query; everything else waits for a microtask or the timer.
          // A throw of the cheap part is reported and must not skip the tempo apply or the finish timer below.
          safely(onReachedNow);
          queueMicrotask(() => runReached(record));
          record.timer = setTimer(() => {
            if (current === record) finish(record);
          }, msUntil(boundary));
        },
        onError,
      });
      current = record;
      onArmed(record);
      return record.gate;
    },

    /**
     * A record whose gate already queried past its line plays (the scheduler queued its code from the line on):
     * it is finished here, with its bookkeeping, before a newer change replaces it or is built over it. A record
     * that has not reached its line yet stays waiting. No-op without a record.
     */
    settleReached,

    /** An immediate change took over: a waiting record is replaced, a record that already plays is finished first. */
    replaceForImmediate() {
      settleReached();
      cancel('replaced');
    },

    /** The waiting record, or null. */
    pending() {
      return current;
    },

    /** Runs `fn` at the finish of `record`, after the earlier continuations; never when the record is canceled. */
    whenFinished(record, fn) {
      if (record.canceled) return;
      if (record.finished) {
        safely(fn);
        return;
      }
      record.finishers.push(fn);
    },

    /**
     * Drops the waiting record (no-op without one); its continuations never run. `reason` says why: 'stop' (the sound
     * stopped), 'replaced' (a newer change took its place), 'superseded' and 'unload' (this tab lost its role or closes) and
     * 'canceled', the person's own cancel of a waiting section launch.
     */
    cancel,

    /** The poll fallback: finishes the waiting record when the scheduler's cycle has reached its boundary. */
    finishIfDue(nowCycle) {
      if (current !== null && nowCycle >= current.boundary) finish(current);
    },
  };
}
