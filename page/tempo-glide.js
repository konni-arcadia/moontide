// A tempo ramp for Moontide's browser page: the tempo moves in small steps from the tempo that plays to the tempo
// the code sets, over a number of bars. No DOM access at import time, so node:test can import it.

// Why the page owns the ramp. setcps and setcpm read their value once, when the code runs, so a ramp cannot live in
// the code; it has to be a series of tempo steps made by the page.
//
// Why the plan is in cycles. The steps follow the music's own position (the cycle the scheduler has queried up to),
// never the wall clock, so a scheduler that stalls or is throttled stalls the ramp with it, and the ramp always
// ends exactly on the cycle it was planned for.
//
// How a step is taken. The driver hooks the scheduler's own queries: every query the scheduler makes asks it to look at
// the music's position, and about 25 ms later it sets the step of that position. The wait matters. The scheduler takes a
// new tempo over at its next tick, and the page's MIDI clock reads the takeover on its own 10 ms passes; a step set in
// the very task of the tick that took the previous step over would replace that takeover before the clock could read
// it, and the clock would drift from the music. A step 25 ms after the tick leaves every takeover in place for at
// least two clock passes. At most one step is set for each pair of scheduler ticks (about 100 ms), which is also the
// finest the scheduler can follow.
//
// Steps reach the scheduler only through the injected `apply`, which the page backs with the tempo guard, so a step is
// never recorded as the tempo a program asked for.

import { BEATS_PER_CYCLE } from './change-timing.js';

// The shortest and longest ramp, in whole bars (one bar is one cycle). src/protocol.ts mirrors both by hand, and a test
// checks both sides.
export const MIN_GLIDE_BARS = 1;
export const MAX_GLIDE_BARS = 64;
// No step lasts less than this at the fastest tempo of the ramp.
export const GLIDE_STEP_SECONDS = 0.1;
// No step is finer than this in BPM, the one decimal the tempo readout shows.
export const GLIDE_FINEST_STEP_BPM = 0.1;
// How long after the scheduler query that found a step the step is set.
export const GLIDE_APPLY_DELAY_MS = 25;

// Cycle positions and tempo distances are floats; a boundary or a count within this of a whole number counts as it.
const TOLERANCE = 1e-9;

const bpmOfCps = (cps) => cps * 60 * BEATS_PER_CYCLE;

function requireCps(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Moontide: the ramp's ${name} must be a finite tempo above 0, got ${String(value)}.`);
  }
}

/**
 * The number of bars of a ramp: undefined (no ramp asked for) gives null, a whole number from MIN_GLIDE_BARS to
 * MAX_GLIDE_BARS gives itself, and anything else throws a `Moontide:` Error naming the value.
 */
export function parseGlideBars(value) {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_GLIDE_BARS || value > MAX_GLIDE_BARS) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    throw new Error(`Moontide: glideBars ${shown} is not a whole number from ${MIN_GLIDE_BARS} to ${MAX_GLIDE_BARS}.`);
  }
  return value;
}

/**
 * The plan of a ramp from `fromCps` to `toCps` over `bars` bars, starting at the cycle `startCycle`. Returns a frozen
 * { fromCps, toCps, bars, startCycle, endCycle, steps } (endCycle is startCycle + bars). The number of steps follows
 * from the distance and the length, never from a timer: the most that keeps every step at least GLIDE_STEP_SECONDS
 * long at the fastest tempo of the ramp, but no more than keeps every step at least GLIDE_FINEST_STEP_BPM wide, and
 * at least one. Throws a `Moontide:` Error for a tempo that is not finite and above 0, equal tempos, a number of bars
 * parseGlideBars refuses, or a start cycle that is not finite.
 */
export function planGlide({ fromCps, toCps, bars, startCycle }) {
  requireCps('start tempo', fromCps);
  requireCps('end tempo', toCps);
  if (fromCps === toCps) {
    throw new Error('Moontide: a ramp needs two different tempos, but the start and the end tempo are equal.');
  }
  if (bars === undefined || parseGlideBars(bars) === null) {
    throw new Error('Moontide: a ramp needs a number of bars.');
  }
  if (typeof startCycle !== 'number' || !Number.isFinite(startCycle)) {
    throw new Error(`Moontide: a ramp needs a finite start cycle, got ${String(startCycle)}.`);
  }
  const distanceBpm = Math.abs(bpmOfCps(toCps) - bpmOfCps(fromCps));
  const byLength = Math.floor(bars / (GLIDE_STEP_SECONDS * Math.max(fromCps, toCps)) + TOLERANCE);
  const byDistance = Math.floor(distanceBpm / GLIDE_FINEST_STEP_BPM + TOLERANCE);
  const steps = Math.max(1, Math.min(byLength, byDistance));
  return Object.freeze({ fromCps, toCps, bars, startCycle, endCycle: startCycle + bars, steps });
}

/**
 * The whole step number, 0 to `plan.steps`, that plays at `cycle`: 0 before the first boundary, `steps` from the end
 * of the ramp on. Step k begins at startCycle + bars * k / steps; a cycle exactly on a boundary counts as that step.
 */
export function glideStepAt(plan, cycle) {
  if (typeof cycle !== 'number' || !Number.isFinite(cycle)) {
    throw new Error(`Moontide: a ramp step is read at a finite cycle, got ${String(cycle)}.`);
  }
  const reached = Math.floor(((cycle - plan.startCycle + TOLERANCE) * plan.steps) / plan.bars);
  return Math.min(plan.steps, Math.max(0, reached));
}

/**
 * The tempo of step `k` (whole, 0 to `plan.steps`): the start tempo for 0, the end tempo itself for the last step, so
 * no float drift is left after the ramp, and linear in BPM between.
 */
export function glideCpsOf(plan, k) {
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k > plan.steps) {
    throw new Error(`Moontide: a ramp of ${plan.steps} steps has no step ${String(k)}.`);
  }
  if (k === 0) return plan.fromCps;
  if (k === plan.steps) return plan.toCps;
  return plan.fromCps + ((plan.toCps - plan.fromCps) * k) / plan.steps;
}

/**
 * The seconds the music takes to play the cycles from `fromCycle` to `toCycle` while the ramp of `plan` moves the tempo: 0
 * when `toCycle` is not above `fromCycle`, the span divided by the start tempo before the ramp starts and by the end tempo
 * after it ends, and in between the sum over the steps of the cycles of each divided by the tempo of that step (the same steps
 * glideStepAt and glideCpsOf name). It is pure and grows with `toCycle`; a span split in two sums to the whole. A cycle that
 * is not finite throws a `Moontide:` Error.
 */
export function glideSeconds(plan, fromCycle, toCycle) {
  for (const [name, value] of [['first', fromCycle], ['last', toCycle]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Moontide: the ${name} cycle of a ramp's time must be finite, got ${String(value)}.`);
    }
  }
  if (toCycle <= fromCycle) return 0;
  const stepCycles = plan.bars / plan.steps;
  // Step k plays from startCycle + k * stepCycles to the next boundary; step 0 reaches back and the last step on.
  const first = Math.max(0, glideStepAt(plan, fromCycle) - 1);
  const last = Math.min(plan.steps, glideStepAt(plan, toCycle) + 1);
  let seconds = 0;
  for (let k = first; k <= last; k++) {
    const begin = k === 0 ? Number.NEGATIVE_INFINITY : plan.startCycle + k * stepCycles;
    const end = k === plan.steps ? Number.POSITIVE_INFINITY : plan.startCycle + (k + 1) * stepCycles;
    const cycles = Math.min(toCycle, end) - Math.max(fromCycle, begin);
    if (cycles > 0) seconds += cycles / glideCpsOf(plan, k);
  }
  return seconds;
}

/**
 * The most that the seconds of `glideSeconds` can be wrong because the tempo that plays trails the plan by one step: a step
 * is set a little after its cycle (a timer after the scheduler's query) and the scheduler takes it over at its next tick, so
 * on a rising ramp the music runs a little slower than the plan and on a falling ramp a little faster. It is the sum, over
 * the cycles from `fromCycle` to `toCycle`, of the cycles of each step times how much its seconds per cycle differ from the
 * step before. 0 when `toCycle` is not above `fromCycle`. Pure; a cycle that is not finite throws a `Moontide:` Error.
 */
export function glideLagSeconds(plan, fromCycle, toCycle) {
  for (const [name, value] of [['first', fromCycle], ['last', toCycle]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Moontide: the ${name} cycle of a ramp's lag must be finite, got ${String(value)}.`);
    }
  }
  if (toCycle <= fromCycle) return 0;
  const stepCycles = plan.bars / plan.steps;
  const first = Math.max(1, glideStepAt(plan, fromCycle) - 1);
  const last = Math.min(plan.steps, glideStepAt(plan, toCycle) + 1);
  let seconds = 0;
  // The lag is one step long: the end tempo is reached one step late, then the lag is over.
  for (let k = first; k <= last; k++) {
    const begin = plan.startCycle + k * stepCycles;
    const end = plan.startCycle + (k + 1) * stepCycles;
    const cycles = Math.min(toCycle, end) - Math.max(fromCycle, begin);
    if (cycles > 0) seconds += cycles * Math.abs(1 / glideCpsOf(plan, k - 1) - 1 / glideCpsOf(plan, k));
  }
  return seconds;
}

/**
 * What a change that waited for its bar or phrase line does to the tempo when its line is reached, as one word:
 * - a change that asks for a ramp: 'start-glide' (the ramp starts at the line from the tempo that plays then);
 * - a ramp runs and the change states its target: 'keep' (nothing is applied, the step that plays stays);
 * - a ramp runs and the change states no tempo: 'cancel-no-tempo' (the ramp ends, the tempo stays);
 * - a ramp runs and the change states another tempo: 'cancel-and-apply' (that tempo applies at once, the ramp ends);
 * - no ramp runs: 'apply' for a stated tempo and 'nothing' for none (the usual path of a waiting change).
 * `newCps` is the tempo the waiting code stated, or null. The target is compared with `===`: it came from the same
 * program text as the target of the ramp, so a program that restates it yields the same number, and no rounding to
 * a BPM enters the rule. A change that asks for a ramp must state a tempo (a finite number above 0), or this throws.
 */
export function lineTempoAction({ running, targetCps, newCps, startsGlide }) {
  if (startsGlide) {
    requireCps('target tempo', newCps);
    return 'start-glide';
  }
  if (running) {
    if (newCps === null) return 'cancel-no-tempo';
    return newCps === targetCps ? 'keep' : 'cancel-and-apply';
  }
  return newCps === null ? 'nothing' : 'apply';
}

/**
 * The words of the three refusals of a change that asks for a ramp it cannot make. Each says that nothing was changed.
 */
export const GLIDE_REFUSALS = Object.freeze({
  nothingPlays:
    'Nothing plays, so there is no tempo to ramp from. Nothing was changed. Send the change again without glideBars.',
  noTempo:
    'The code sets no tempo with setcps or setcpm, so there is nothing to ramp to. Nothing was changed.',
  sameTempo:
    'The code sets the tempo that already plays, so there is nothing to ramp. Nothing was changed.',
});

/**
 * The driver of one ramp at a time. `scheduler` is read for `cps`, `lastEnd` (the cycle a new tempo starts at) and
 * `started`; `apply(cps)` sets a tempo (the page's tempo guard); `setTimer` and `clearTimer` are the page's timers.
 * `onEvent` hears { kind: 'started', plan }, { kind: 'finished', plan } and { kind: 'canceled', reason, plan, cps }
 * (`cps` is the scheduler's tempo when the ramp was canceled); `onError(text, err)` hears an error once for each text.
 * Returns:
 * - `start({ fromCps, toCps, bars, startCycle })`: plans the ramp (a refusal throws and changes nothing), cancels a
 *   running one with the reason 'replaced' first, and returns the plan;
 * - `onSchedulerQuery()`: called on every query the scheduler itself makes; it never throws;
 * - `cancel(reason)`: ends the ramp where it is and returns true, or returns false when none runs;
 * - `running()`, `current()` (null or a frozen { ...plan, applied, stepCps }) and `targetCps()` (null or the end tempo);
 * - `runs(plan)`: whether `plan` (as `start` returned it) is the ramp that runs now; false once it finished, was canceled
 *   or was replaced, and for anything that is not such a plan. A report of a ramp goes to the server only while this is
 *   true, so every end of that ramp is told after the report and the server's record of it can always be cleared;
 * - `secondsBetween(fromCycle, toCycle)`: the seconds of the music between two cycles through the ramp's own tempo
 *   (glideSeconds on the running plan), null with no ramp;
 * - `lagSecondsBetween(fromCycle, toCycle)`: how far that can be off when the tempo trails the plan by a step
 *   (glideLagSeconds on the running plan), null with no ramp;
 * - `fastestCps()`: the fastest tempo the ramp still reaches, the larger of the step that plays and the end tempo, null with
 *   no ramp;
 * - `barsLeft(cycle)`: the bars to the end of the ramp at `cycle`, rounded up, never below 1 and never above the ramp's
 *   length, null with no ramp.
 */
export function createTempoGlide({ scheduler, apply, setTimer, clearTimer, onEvent = () => {}, onError = (text, err) => console.error(text, err) }) {
  if (scheduler === null || typeof scheduler !== 'object' || typeof scheduler.cps !== 'number') {
    throw new Error('Moontide: the tempo ramp needs a scheduler with a numeric cps.');
  }
  for (const [name, fn] of [['apply', apply], ['setTimer', setTimer], ['clearTimer', clearTimer]]) {
    if (typeof fn !== 'function') throw new Error(`Moontide: the tempo ramp needs a ${name} function.`);
  }
  let ramp = null; // { plan, applied } while a ramp runs
  let pending = false;
  let timer = null;
  const reported = new Set();

  const report = (text, err) => {
    if (reported.has(text)) return;
    reported.add(text);
    try {
      onError(text, err);
    } catch {
      // Reporting must not be able to break the scheduler either.
    }
  };
  const emit = (event) => {
    try {
      onEvent(event);
    } catch (err) {
      report('Moontide: a tempo ramp listener failed:', err);
    }
  };
  const clearPending = () => {
    if (pending) clearTimer(timer);
    pending = false;
    timer = null;
  };

  function cancel(reason) {
    if (ramp === null) return false;
    const { plan } = ramp;
    ramp = null;
    clearPending();
    emit({ kind: 'canceled', reason, plan, cps: scheduler.cps });
    return true;
  }

  function fire(mine) {
    pending = false;
    timer = null;
    try {
      if (ramp !== mine) return;
      if (scheduler.started === false) return;
      if (typeof scheduler.lastEnd !== 'number' || !Number.isFinite(scheduler.lastEnd)) return;
      const k = glideStepAt(mine.plan, scheduler.lastEnd);
      if (k > mine.applied) {
        apply(glideCpsOf(mine.plan, k));
        mine.applied = k;
      }
      if (mine.applied >= mine.plan.steps) {
        ramp = null;
        emit({ kind: 'finished', plan: mine.plan });
      }
    } catch (err) {
      cancel('error');
      report(`Moontide: a tempo ramp step failed, so the ramp was canceled: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }

  return {
    start(input) {
      const plan = planGlide(input);
      cancel('replaced');
      ramp = { plan, applied: 0 };
      emit({ kind: 'started', plan });
      return plan;
    },
    onSchedulerQuery() {
      try {
        if (ramp === null || pending) return;
        const mine = ramp;
        pending = true;
        timer = setTimer(() => fire(mine), GLIDE_APPLY_DELAY_MS);
      } catch (err) {
        pending = false;
        timer = null;
        report('Moontide: the tempo ramp could not follow the scheduler:', err);
      }
    },
    cancel,
    running: () => ramp !== null,
    runs: (plan) => ramp !== null && ramp.plan === plan,
    current() {
      if (ramp === null) return null;
      return Object.freeze({ ...ramp.plan, applied: ramp.applied, stepCps: glideCpsOf(ramp.plan, ramp.applied) });
    },
    targetCps: () => (ramp === null ? null : ramp.plan.toCps),
    secondsBetween: (fromCycle, toCycle) => (ramp === null ? null : glideSeconds(ramp.plan, fromCycle, toCycle)),
    lagSecondsBetween: (fromCycle, toCycle) => (ramp === null ? null : glideLagSeconds(ramp.plan, fromCycle, toCycle)),
    fastestCps: () => (ramp === null ? null : Math.max(glideCpsOf(ramp.plan, ramp.applied), ramp.plan.toCps)),
    barsLeft(cycle) {
      if (typeof cycle !== 'number' || !Number.isFinite(cycle)) {
        throw new Error(`Moontide: the bars left of a ramp are read at a finite cycle, got ${String(cycle)}.`);
      }
      if (ramp === null) return null;
      const { plan } = ramp;
      return Math.min(plan.bars, Math.max(1, Math.ceil(plan.endCycle - cycle - TOLERANCE)));
    },
  };
}
