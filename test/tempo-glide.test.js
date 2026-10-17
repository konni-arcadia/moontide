// The tempo ramp: the plan, the step function and the driver, with a fake scheduler and timers fired by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLIDE_APPLY_DELAY_MS,
  GLIDE_FINEST_STEP_BPM,
  GLIDE_REFUSALS,
  GLIDE_STEP_SECONDS,
  MAX_GLIDE_BARS,
  MIN_GLIDE_BARS,
  createTempoGlide,
  glideCpsOf,
  glideLagSeconds,
  glideSeconds,
  glideStepAt,
  lineTempoAction,
  parseGlideBars,
  planGlide,
} from '../page/tempo-glide.js';

const cpsOf = (bpm) => bpm / 60 / 4;
const bpmOf = (cps) => cps * 240;

test('the bounds are 1 to 64 bars, a step of 100 ms and 0.1 BPM, applied 25 ms after its tick', () => {
  assert.equal(MIN_GLIDE_BARS, 1);
  assert.equal(MAX_GLIDE_BARS, 64);
  assert.equal(GLIDE_STEP_SECONDS, 0.1);
  assert.equal(GLIDE_FINEST_STEP_BPM, 0.1);
  assert.equal(GLIDE_APPLY_DELAY_MS, 25);
});

test('parseGlideBars: nothing asked gives null, 1 and 64 give themselves, anything else throws a Moontide error naming it', () => {
  assert.equal(parseGlideBars(undefined), null);
  assert.equal(parseGlideBars(1), 1);
  assert.equal(parseGlideBars(64), 64);
  for (const value of [0, 65, 1.5, -1, Number.NaN, '8', null, Number.POSITIVE_INFINITY, true]) {
    assert.throws(
      () => parseGlideBars(value),
      (err) => err.message.startsWith('Moontide:') && err.message.includes(typeof value === 'string' ? JSON.stringify(value) : String(value)),
      `glideBars ${String(value)}`,
    );
  }
});

test('planGlide refuses equal tempos, a tempo that is not above 0, bars out of range and a start cycle that is not finite', () => {
  const ok = { fromCps: 0.4, toCps: 0.5, bars: 4, startCycle: 10 };
  assert.doesNotThrow(() => planGlide(ok));
  for (const bad of [
    { ...ok, toCps: ok.fromCps },
    { ...ok, fromCps: 0 },
    { ...ok, toCps: -0.5 },
    { ...ok, fromCps: Number.NaN },
    { ...ok, toCps: Number.POSITIVE_INFINITY },
    { ...ok, bars: 0 },
    { ...ok, bars: 65 },
    { ...ok, bars: undefined },
    { ...ok, startCycle: Number.NaN },
    { ...ok, startCycle: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => planGlide(bad), /^Error: Moontide:/, JSON.stringify(bad));
  }
});

test('planGlide: the end is the start plus the bars, the plan is frozen, and 100 to 120 BPM over 1 bar takes 20 steps of 100 ms', () => {
  const plan = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 1, startCycle: 7 });
  assert.equal(plan.endCycle, 8);
  assert.equal(plan.steps, 20);
  assert.ok(Object.isFrozen(plan));
});

test('planGlide: 120 to 121 BPM over 64 bars takes 10 steps, a distance of 0.1 BPM per step', () => {
  const plan = planGlide({ fromCps: cpsOf(120), toCps: cpsOf(121), bars: 64, startCycle: 0 });
  assert.equal(plan.steps, 10);
});

test('planGlide: a tiny distance takes one step', () => {
  assert.equal(planGlide({ fromCps: cpsOf(120), toCps: cpsOf(120.05), bars: 8, startCycle: 0 }).steps, 1);
});

test('planGlide: every step lasts at least 100 ms at the fastest tempo and is no finer than 0.1 BPM, up and down', () => {
  for (const bars of [1, 4, 8, 64]) {
    for (const distance of [0.5, 1, 7.3, 20, 60, 140]) {
      for (const [from, to] of [[60, 60 + distance], [200, 200 - distance], [100, 100 + distance]]) {
        const plan = planGlide({ fromCps: cpsOf(from), toCps: cpsOf(to), bars, startCycle: 0 });
        const label = `${from} to ${to} BPM over ${bars} bars`;
        assert.ok(plan.steps >= 1, label);
        assert.ok(bars / plan.steps / Math.max(plan.fromCps, plan.toCps) >= GLIDE_STEP_SECONDS - 1e-9, `${label}: a step lasts under 100 ms`);
        if (plan.steps > 1) {
          assert.ok(Math.abs(bpmOf(plan.toCps) - bpmOf(plan.fromCps)) / plan.steps >= GLIDE_FINEST_STEP_BPM - 1e-9, `${label}: a step is finer than 0.1 BPM`);
        }
      }
    }
  }
});

test('glideStepAt: 0 before the first boundary, steps at and after the end, and a cycle exactly on a boundary counts as that step', () => {
  const plan = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 2, startCycle: 10 });
  assert.equal(plan.steps, 40);
  assert.equal(glideStepAt(plan, 9), 0);
  assert.equal(glideStepAt(plan, 10), 0);
  assert.equal(glideStepAt(plan, 10.049), 0);
  assert.equal(glideStepAt(plan, 10.05), 1, 'the boundary of step 1 is 10 + 2 / 40');
  assert.equal(glideStepAt(plan, 11), 20);
  assert.equal(glideStepAt(plan, 11.95), 39);
  assert.equal(glideStepAt(plan, 12), 40);
  assert.equal(glideStepAt(plan, 500), 40);
  assert.throws(() => glideStepAt(plan, Number.NaN), /^Error: Moontide:/);
});

test('glideCpsOf: the start tempo for 0, the end tempo exactly for the last step, linear in BPM between', () => {
  for (const [from, to] of [[100, 120], [120, 100], [98.7, 120]]) {
    const plan = planGlide({ fromCps: cpsOf(from), toCps: cpsOf(to), bars: 8, startCycle: 0 });
    assert.equal(glideCpsOf(plan, 0), plan.fromCps);
    assert.equal(glideCpsOf(plan, plan.steps), plan.toCps, `${from} to ${to} ends exactly on the target`);
    let previous = plan.fromCps;
    for (let k = 1; k <= plan.steps; k++) {
      const cps = glideCpsOf(plan, k);
      assert.ok(to > from ? cps > previous : cps < previous, `step ${k} moves in the direction of the ramp`);
      previous = cps;
    }
    const k = Math.floor(plan.steps / 2);
    assert.ok(Math.abs(bpmOf(glideCpsOf(plan, k)) - (from + ((to - from) * k) / plan.steps)) < 1e-9);
  }
  // A target such as 0.5 cps reached from 98.7 BPM is exact too.
  const plan = planGlide({ fromCps: cpsOf(98.7), toCps: 0.5, bars: 4, startCycle: 0 });
  assert.strictEqual(glideCpsOf(plan, plan.steps), 0.5);
  assert.throws(() => glideCpsOf(plan, plan.steps + 1), /^Error: Moontide:/);
  assert.throws(() => glideCpsOf(plan, 1.5), /^Error: Moontide:/);
});

// A driver on a fake scheduler and timers that a test fires by hand.
function makeDriver({ cps = cpsOf(100), lastEnd = 0, started = true } = {}) {
  const scheduler = { cps, lastEnd, started };
  const applied = [];
  const timers = [];
  const events = [];
  const errors = [];
  const glide = createTempoGlide({
    scheduler,
    apply: (value) => {
      applied.push(value);
      scheduler.cps = value;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    onEvent: (event) => events.push(event),
    onError: (text) => errors.push(text),
  });
  const live = () => timers.filter((timer) => !timer.cleared && !timer.fired);
  const fire = () => {
    const timer = live()[0];
    assert.ok(timer, 'a timer is waiting');
    timer.fired = true;
    timer.fn();
  };
  return { scheduler, applied, timers, events, errors, glide, live, fire };
}

const RAMP = { fromCps: cpsOf(100), toCps: cpsOf(120), bars: 4, startCycle: 0 };

test('the driver checks its collaborators loudly', () => {
  const fns = { apply() {}, setTimer() {}, clearTimer() {} };
  assert.throws(() => createTempoGlide({ scheduler: {}, ...fns }), /numeric cps/);
  assert.throws(() => createTempoGlide({ scheduler: null, ...fns }), /numeric cps/);
  for (const name of ['apply', 'setTimer', 'clearTimer']) {
    assert.throws(() => createTempoGlide({ scheduler: { cps: 0.5 }, ...fns, [name]: undefined }), new RegExp(name));
  }
});

test('a scheduler query sets one timer of 25 ms and a second query before it fires sets none', () => {
  const d = makeDriver();
  d.glide.start(RAMP);
  d.glide.onSchedulerQuery();
  d.glide.onSchedulerQuery();
  assert.equal(d.live().length, 1);
  assert.equal(d.timers[0].ms, GLIDE_APPLY_DELAY_MS);
  d.scheduler.lastEnd = 0.5;
  d.fire();
  d.glide.onSchedulerQuery();
  assert.equal(d.live().length, 1, 'after the timer fired the next query sets the next one');
});

test('the timer applies the step of the scheduler frontier through apply only', () => {
  const d = makeDriver();
  const plan = d.glide.start(RAMP);
  d.scheduler.lastEnd = 1; // a quarter of the ramp
  d.glide.onSchedulerQuery();
  assert.deepEqual(d.applied, [], 'nothing is applied inside the query');
  d.fire();
  assert.deepEqual(d.applied, [glideCpsOf(plan, glideStepAt(plan, 1))]);
  assert.equal(d.glide.current().applied, glideStepAt(plan, 1));
  assert.equal(d.glide.current().stepCps, d.applied[0]);
  assert.equal(d.glide.targetCps(), plan.toCps);
  assert.equal(d.glide.running(), true);
});

test('a query while no ramp runs sets nothing, and a stopped scheduler applies nothing', () => {
  const d = makeDriver();
  d.glide.onSchedulerQuery();
  assert.equal(d.timers.length, 0);
  d.glide.start(RAMP);
  d.glide.onSchedulerQuery();
  d.scheduler.started = false;
  d.scheduler.lastEnd = 2;
  d.fire();
  assert.deepEqual(d.applied, [], 'no step is applied while the scheduler is stopped');
  assert.equal(d.glide.running(), true, 'a stop that is not canceled keeps the ramp for the caller to cancel');
  d.scheduler.started = true;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.equal(d.applied.length, 1);
});

test('a stall applies the step of its position once, never the steps in between, and the ramp goes on from there', () => {
  const d = makeDriver();
  const plan = d.glide.start(RAMP);
  d.scheduler.lastEnd = 0.4;
  d.glide.onSchedulerQuery();
  d.fire();
  const first = d.applied.length;
  assert.equal(first, 1);
  // The scheduler stalls and comes back at 70 % of the ramp.
  d.scheduler.lastEnd = 2.8;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.equal(d.applied.length, first + 1, 'one step for the whole stall');
  assert.equal(d.applied.at(-1), glideCpsOf(plan, glideStepAt(plan, 2.8)));
  // The next position continues from there.
  d.scheduler.lastEnd = 2.9;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.equal(d.applied.at(-1), glideCpsOf(plan, glideStepAt(plan, 2.9)));
  assert.ok(d.applied.every((cps, index) => index === 0 || cps > d.applied[index - 1]), 'the steps only rise');
});

test('the last step is applied exactly once, it is the target exactly, and finished is emitted once', () => {
  const d = makeDriver();
  const plan = d.glide.start(RAMP);
  d.scheduler.lastEnd = 3.9;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.equal(d.glide.running(), true);
  d.scheduler.lastEnd = 4;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.strictEqual(d.applied.at(-1), plan.toCps);
  assert.equal(d.glide.running(), false);
  assert.equal(d.glide.current(), null);
  assert.equal(d.glide.targetCps(), null);
  assert.deepEqual(d.events.map((event) => event.kind), ['started', 'finished']);
  const count = d.applied.length;
  d.scheduler.lastEnd = 10;
  d.glide.onSchedulerQuery();
  assert.equal(d.live().length, 0, 'no timer after the ramp ended');
  assert.equal(d.applied.length, count);
});

test('a stall past the end applies the last step at once and does not skip it', () => {
  const d = makeDriver();
  const plan = d.glide.start(RAMP);
  d.scheduler.lastEnd = 400;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.deepEqual(d.applied, [plan.toCps]);
  assert.deepEqual(d.events.map((event) => event.kind), ['started', 'finished']);
});

test('a throwing apply cancels the ramp with the reason error and reports once', () => {
  const scheduler = { cps: cpsOf(100), lastEnd: 1, started: true };
  const timers = [];
  const events = [];
  const errors = [];
  const glide = createTempoGlide({
    scheduler,
    apply: () => {
      throw new Error('boom');
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer() {},
    onEvent: (event) => events.push(event),
    onError: (text) => errors.push(text),
  });
  glide.start(RAMP);
  glide.onSchedulerQuery();
  timers.shift()();
  assert.equal(glide.running(), false);
  assert.deepEqual(events.map((event) => event.kind), ['started', 'canceled']);
  assert.equal(events[1].reason, 'error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('Moontide:'));
  // The same failure again, in a second ramp, is not reported a second time.
  glide.start(RAMP);
  glide.onSchedulerQuery();
  timers.shift()();
  assert.equal(errors.length, 1);
});

test('a hook that throws inside onSchedulerQuery never reaches the scheduler', () => {
  const errors = [];
  const glide = createTempoGlide({
    scheduler: { cps: 0.4, lastEnd: 0, started: true },
    apply() {},
    setTimer() {
      throw new Error('no timers');
    },
    clearTimer() {},
    onError: (text) => errors.push(text),
  });
  glide.start(RAMP);
  assert.doesNotThrow(() => glide.onSchedulerQuery());
  assert.doesNotThrow(() => glide.onSchedulerQuery());
  assert.equal(errors.length, 1);
});

test('start while a ramp runs emits canceled replaced and then started, and a refused start changes nothing', () => {
  const d = makeDriver();
  d.glide.start(RAMP);
  d.glide.onSchedulerQuery();
  const second = d.glide.start({ ...RAMP, fromCps: cpsOf(110), bars: 2 });
  assert.deepEqual(d.events.map((event) => event.kind), ['started', 'canceled', 'started']);
  assert.equal(d.events[1].reason, 'replaced');
  assert.equal(d.events[1].cps, d.scheduler.cps);
  assert.equal(d.live().length, 0, 'the timer of the replaced ramp is cleared');
  assert.equal(d.glide.current().bars, 2);
  assert.equal(d.glide.current().fromCps, second.fromCps);
  assert.throws(() => d.glide.start({ ...RAMP, bars: 0 }), /^Error: Moontide:/);
  assert.deepEqual(d.events.map((event) => event.kind), ['started', 'canceled', 'started'], 'a refused start changes nothing');
  assert.equal(d.glide.running(), true);
});

test('cancel returns true once and false the second time, and clears the pending timer', () => {
  const d = makeDriver();
  d.glide.start(RAMP);
  d.glide.onSchedulerQuery();
  assert.equal(d.glide.cancel('stop'), true);
  assert.equal(d.live().length, 0);
  assert.equal(d.glide.cancel('stop'), false);
  assert.deepEqual(d.events.map((event) => event.kind), ['started', 'canceled']);
  assert.equal(d.events[1].reason, 'stop');
  assert.equal(d.glide.current(), null);
  d.glide.onSchedulerQuery();
  assert.equal(d.timers.length, 1, 'no new timer after the cancel');
});

test('a timer left over from a replaced ramp does nothing', () => {
  const d = makeDriver();
  d.glide.start(RAMP);
  d.glide.onSchedulerQuery();
  const old = d.timers[0];
  d.glide.start({ ...RAMP, bars: 2 });
  d.scheduler.lastEnd = 1;
  old.fn();
  assert.deepEqual(d.applied, []);
});

test('runs(plan) is true only for the plan of the ramp that runs, and false once it is canceled, replaced or finished', () => {
  const d = makeDriver();
  assert.equal(d.glide.runs(undefined), false, 'no ramp runs');
  assert.equal(d.glide.runs(null), false);
  const first = d.glide.start(RAMP);
  assert.equal(d.glide.runs(first), true);
  assert.equal(d.glide.runs({ ...first }), false, 'a copy of the plan is not the plan');
  assert.equal(d.glide.runs(d.glide.current()), false, 'the snapshot of current() is not the plan');
  const second = d.glide.start({ ...RAMP, bars: 2 });
  assert.equal(d.glide.runs(first), false, 'a replaced ramp no longer runs');
  assert.equal(d.glide.runs(second), true);
  d.glide.cancel('stop');
  assert.equal(d.glide.runs(second), false, 'a canceled ramp no longer runs');
  const third = d.glide.start({ ...RAMP, bars: 1 });
  d.scheduler.lastEnd = 1;
  d.glide.onSchedulerQuery();
  d.fire();
  assert.equal(d.glide.running(), false);
  assert.equal(d.glide.runs(third), false, 'a finished ramp no longer runs');
});

test('the tempo of a whole ramp driven by fake queries rises and ends exactly on the target', () => {
  const d = makeDriver();
  const plan = d.glide.start({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 2, startCycle: 0 });
  // The scheduler asks about every 0.05 s of music: a query, the timer, a tick.
  for (let lastEnd = 0; lastEnd <= 2.2; lastEnd += 0.05) {
    d.scheduler.lastEnd = lastEnd;
    d.glide.onSchedulerQuery();
    if (d.live().length > 0) d.fire();
  }
  assert.strictEqual(d.applied.at(-1), plan.toCps);
  assert.ok(d.applied.length <= plan.steps);
  assert.ok(d.applied.every((cps, index) => index === 0 || cps > d.applied[index - 1]));
  assert.equal(d.glide.running(), false);
});

test('lineTempoAction: a change that asks for a ramp starts one at its line, whether or not another runs', () => {
  assert.equal(lineTempoAction({ running: false, targetCps: null, newCps: 0.5, startsGlide: true }), 'start-glide');
  assert.equal(lineTempoAction({ running: true, targetCps: 0.5, newCps: 0.5, startsGlide: true }), 'start-glide');
  assert.equal(lineTempoAction({ running: true, targetCps: 0.5, newCps: 0.6, startsGlide: true }), 'start-glide');
});

test('lineTempoAction: a running ramp is kept for its own target, canceled for no tempo, and canceled with the new tempo applied for another', () => {
  assert.equal(lineTempoAction({ running: true, targetCps: 0.5, newCps: 0.5, startsGlide: false }), 'keep');
  assert.equal(lineTempoAction({ running: true, targetCps: 0.5, newCps: null, startsGlide: false }), 'cancel-no-tempo');
  assert.equal(lineTempoAction({ running: true, targetCps: 0.5, newCps: 0.45, startsGlide: false }), 'cancel-and-apply');
});

test('lineTempoAction: with no ramp a stated tempo applies and no tempo does nothing', () => {
  assert.equal(lineTempoAction({ running: false, targetCps: null, newCps: 0.45, startsGlide: false }), 'apply');
  assert.equal(lineTempoAction({ running: false, targetCps: null, newCps: null, startsGlide: false }), 'nothing');
});

test('lineTempoAction: the target is compared as the same number, with no rounding to a BPM', () => {
  const target = cpsOf(100);
  assert.equal(lineTempoAction({ running: true, targetCps: target, newCps: cpsOf(100), startsGlide: false }), 'keep');
  assert.equal(lineTempoAction({ running: true, targetCps: target, newCps: cpsOf(100.04), startsGlide: false }), 'cancel-and-apply');
});

test('lineTempoAction refuses a change that asks for a ramp without a tempo above 0', () => {
  for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.throws(() => lineTempoAction({ running: false, targetCps: null, newCps: bad, startsGlide: true }), /^Error: Moontide:/);
  }
});

test('GLIDE_REFUSALS: three fixed sentences without a digit, nothing-plays says to send the change again without glideBars', () => {
  assert.deepEqual(Object.keys(GLIDE_REFUSALS).sort(), ['nothingPlays', 'noTempo', 'sameTempo'].sort());
  assert.ok(Object.isFrozen(GLIDE_REFUSALS));
  for (const text of Object.values(GLIDE_REFUSALS)) {
    assert.equal(typeof text, 'string');
    assert.notEqual(text.trim(), '');
    assert.doesNotMatch(text, /[0-9]/);
  }
  assert.match(GLIDE_REFUSALS.nothingPlays, /without glideBars/);
});

// The seconds of the music across a tempo that moves: the countdown's reply seconds, the finish timer and the leads follow it.
test('glideSeconds: a span before the ramp runs at the start tempo and a span after it at the end tempo', () => {
  const plan = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 4, startCycle: 10 });
  assert.ok(Math.abs(glideSeconds(plan, 2, 8) - 6 / plan.fromCps) < 1e-9);
  assert.ok(Math.abs(glideSeconds(plan, 14, 20) - 6 / plan.toCps) < 1e-9);
  assert.equal(glideSeconds(plan, 5, 5), 0);
  assert.equal(glideSeconds(plan, 8, 5), 0);
});

test('glideSeconds: across the whole ramp it is the sum over the steps of their cycles divided by their tempo', () => {
  for (const [from, to] of [[100, 120], [120, 100], [60, 180], [118.5, 119.5]]) {
    const plan = planGlide({ fromCps: cpsOf(from), toCps: cpsOf(to), bars: 4, startCycle: 10 });
    let expected = 0;
    for (let k = 0; k < plan.steps; k++) expected += plan.bars / plan.steps / glideCpsOf(plan, k);
    assert.ok(Math.abs(glideSeconds(plan, plan.startCycle, plan.endCycle) - expected) < 1e-9, `${from} to ${to}`);
  }
});

test('glideSeconds: it grows with the end cycle, and a span split in two sums to the whole', () => {
  const plan = planGlide({ fromCps: cpsOf(90), toCps: cpsOf(150), bars: 8, startCycle: 3.3 });
  let last = 0;
  for (let b = 0; b <= 20; b += 0.37) {
    const seconds = glideSeconds(plan, 0, b);
    assert.ok(seconds >= last, `at ${b}`);
    last = seconds;
  }
  for (const [a, mid, b] of [[0, 5, 20], [4, 4.1, 9], [3.3, 7.3, 11.3], [-2, 11.3, 30], [6.123, 6.9, 7.2]]) {
    assert.ok(Math.abs(glideSeconds(plan, a, b) - (glideSeconds(plan, a, mid) + glideSeconds(plan, mid, b))) < 1e-9, `${a} ${mid} ${b}`);
  }
});

test('glideSeconds: a rising ramp takes less time than the start tempo and a falling one more, both between the two tempos', () => {
  const up = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 4, startCycle: 0 });
  const down = planGlide({ fromCps: cpsOf(120), toCps: cpsOf(100), bars: 4, startCycle: 0 });
  assert.ok(glideSeconds(up, 0, 4) < 4 / up.fromCps && glideSeconds(up, 0, 4) > 4 / up.toCps);
  assert.ok(glideSeconds(down, 0, 4) > 4 / down.fromCps && glideSeconds(down, 0, 4) < 4 / down.toCps);
});

test('glideSeconds: a cycle that is not finite throws', () => {
  const plan = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 4, startCycle: 0 });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', undefined, null]) {
    assert.throws(() => glideSeconds(plan, bad, 4), /^Error: Moontide:/, String(bad));
    assert.throws(() => glideSeconds(plan, 0, bad), /^Error: Moontide:/, String(bad));
  }
});

test('glideLagSeconds: it is the time a one-step lag adds or takes off, zero outside the ramp and for an empty span', () => {
  const plan = planGlide({ fromCps: cpsOf(80), toCps: cpsOf(160), bars: 4, startCycle: 10 });
  assert.equal(glideLagSeconds(plan, 2, 8), 0, 'before the ramp the tempo is the start tempo');
  assert.equal(glideLagSeconds(plan, 5, 5), 0);
  assert.equal(glideLagSeconds(plan, 8, 5), 0);
  assert.ok(Math.abs(glideLagSeconds(plan, 20, 30)) < 1e-9, 'long after the ramp the tempo is the end tempo');
  // Over the whole ramp it is the sum over the steps of their cycles times how much their seconds per cycle differ from the step
  // before, the end tempo's own lagging step included.
  let expected = 0;
  for (let k = 1; k <= plan.steps; k++) expected += (plan.bars / plan.steps) * Math.abs(1 / glideCpsOf(plan, k - 1) - 1 / glideCpsOf(plan, k));
  assert.ok(Math.abs(glideLagSeconds(plan, plan.startCycle, plan.endCycle + 5) - expected) < 1e-9);
  assert.ok(glideLagSeconds(plan, plan.startCycle, plan.endCycle + 5) > 0);
});

test('glideLagSeconds: it grows with the span and with the slope, the same for a rising and a falling ramp', () => {
  const up = planGlide({ fromCps: cpsOf(80), toCps: cpsOf(160), bars: 4, startCycle: 0 });
  const down = planGlide({ fromCps: cpsOf(160), toCps: cpsOf(80), bars: 4, startCycle: 0 });
  assert.ok(glideLagSeconds(up, 0, 2) < glideLagSeconds(up, 0, 3));
  assert.ok(glideLagSeconds(up, 1, 2) > 0);
  const gentle = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 8, startCycle: 0 });
  assert.ok(glideLagSeconds(gentle, 1, 2) < glideLagSeconds(up, 1, 2) / 5, 'a gentle ramp lags far less than a steep one');
  // One second to a line on the steep ramp is off by a few milliseconds, not by tenths of a second.
  assert.ok(glideLagSeconds(up, 1, 1.5) < 0.02);
  assert.ok(Math.abs(glideLagSeconds(up, 1, 2) - glideLagSeconds(down, 1, 2)) < 0.01);
});

test('glideLagSeconds: a cycle that is not finite throws', () => {
  const plan = planGlide({ fromCps: cpsOf(100), toCps: cpsOf(120), bars: 4, startCycle: 0 });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', undefined, null]) {
    assert.throws(() => glideLagSeconds(plan, bad, 4), /^Error: Moontide:/, String(bad));
    assert.throws(() => glideLagSeconds(plan, 0, bad), /^Error: Moontide:/, String(bad));
  }
});

test('the ramp helpers are null with no ramp', () => {
  const d = makeDriver();
  assert.equal(d.glide.secondsBetween(0, 4), null);
  assert.equal(d.glide.lagSecondsBetween(0, 4), null);
  assert.equal(d.glide.fastestCps(), null);
  assert.equal(d.glide.barsLeft(1), null);
});

test('secondsBetween is glideSeconds on the running plan', () => {
  const d = makeDriver();
  const plan = d.glide.start(RAMP);
  assert.equal(d.glide.secondsBetween(0.5, 6), glideSeconds(plan, 0.5, 6));
});

test('fastestCps is the larger of the step that plays and the end tempo, for a rising and a falling ramp', () => {
  const up = makeDriver();
  const upPlan = up.glide.start(RAMP);
  assert.equal(up.glide.fastestCps(), upPlan.toCps);
  up.scheduler.lastEnd = 2;
  up.glide.onSchedulerQuery();
  up.fire();
  assert.equal(up.glide.fastestCps(), upPlan.toCps);
  const down = makeDriver({ cps: cpsOf(120) });
  const downPlan = down.glide.start({ fromCps: cpsOf(120), toCps: cpsOf(100), bars: 4, startCycle: 0 });
  assert.equal(down.glide.fastestCps(), downPlan.fromCps, 'a falling ramp starts at its fastest');
  down.scheduler.lastEnd = 2;
  down.glide.onSchedulerQuery();
  down.fire();
  assert.equal(down.glide.fastestCps(), down.glide.current().stepCps, 'then the step that plays is still the fastest left');
  assert.ok(down.glide.fastestCps() < downPlan.fromCps);
});

test('barsLeft rounds up, counts down once per bar, is never below 1 and never above the ramp length', () => {
  const d = makeDriver();
  d.glide.start({ ...RAMP, startCycle: 10.4 });
  assert.equal(d.glide.barsLeft(9), 4, 'before the ramp starts it still reads its length');
  assert.equal(d.glide.barsLeft(10.4), 4);
  assert.equal(d.glide.barsLeft(10.5), 4);
  assert.equal(d.glide.barsLeft(11.4), 3);
  assert.equal(d.glide.barsLeft(11.5), 3);
  assert.equal(d.glide.barsLeft(13.5), 1);
  assert.equal(d.glide.barsLeft(14.3), 1);
  assert.equal(d.glide.barsLeft(14.4), 1);
  assert.equal(d.glide.barsLeft(20), 1);
  assert.throws(() => d.glide.barsLeft(Number.NaN), /^Error: Moontide:/);
});
