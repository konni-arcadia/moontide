import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTempoGuard } from '../page/tempo-guard.js';

// A scheduler like the pinned Cyclist: setCps takes effect at once (it assigns cps), and the clock tick can
// also assign cps directly when a hap carries a cps control. `asked` records every setCps call.
function fakeScheduler(cps = 0.5) {
  const asked = [];
  return {
    cps,
    asked,
    setCps(value) {
      asked.push(value);
      this.cps = value;
    },
  };
}

test('a failed evaluation that changed the tempo puts the tempo from before it back', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(2);
  guard.end(true);
  assert.deepEqual(scheduler.asked, [2, 0.5]);
  assert.equal(scheduler.cps, 0.5);
});

test('a successful evaluation keeps its tempo, and a later failure restores that tempo', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(2);
  guard.end(false);
  assert.deepEqual(scheduler.asked, [2]);
  guard.begin();
  scheduler.setCps(3);
  guard.end(true);
  assert.deepEqual(scheduler.asked, [2, 3, 2]);
  assert.equal(scheduler.cps, 2);
});

test('a tempo set by a cps control between evaluations (not through setCps) is the tempo a later failure restores', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  // Change A: setcps(0.5).
  guard.begin();
  scheduler.setCps(0.5);
  guard.end(false);
  // Change B: the pattern uses the cps control, and the clock tick sets the tempo itself.
  scheduler.cps = 0.8;
  // Change C: plain code, no setcps and no cps control; it keeps playing at 0.8.
  guard.begin();
  guard.end(false);
  // Change D: setcps(1) and a failure; the tempo that plays is 0.8, not the 0.5 of the last setCps call.
  guard.begin();
  scheduler.setCps(1);
  guard.end(true);
  assert.equal(scheduler.cps, 0.8);
  assert.deepEqual(scheduler.asked, [0.5, 1, 0.8]);
});

test('an evaluation that never called setCps asks for nothing, failed or not', () => {
  const scheduler = fakeScheduler(0.75);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  guard.end(true);
  guard.begin();
  guard.end(false);
  assert.deepEqual(scheduler.asked, []);
});

test('with several setCps calls in a failed evaluation the tempo from before the evaluation comes back', () => {
  const scheduler = fakeScheduler(0.75);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(1);
  scheduler.setCps(1.5);
  guard.end(true);
  assert.deepEqual(scheduler.asked, [1, 1.5, 0.75]);
});

test('the wrapped setCps passes the value and the return value through, with the scheduler as this', () => {
  const scheduler = { cps: 1, seen: null, setCps(value) { this.seen = value; return 'done'; } };
  const guard = createTempoGuard(scheduler);
  guard.begin();
  assert.equal(scheduler.setCps(4), 'done');
  assert.equal(scheduler.seen, 4);
  guard.end(false);
});

test('a scheduler with no setCps function or no numeric cps is a loud error', () => {
  assert.throws(() => createTempoGuard({ cps: 1 }), /no setCps function/);
  assert.throws(() => createTempoGuard({ setCps() {} }), /no numeric cps/);
});

test('end with hold puts the tempo from before back at once and returns the tempo the program asked for', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(0.75);
  const result = guard.end(false, { hold: true });
  assert.deepEqual(result, { requested: 0.75, glide: 'none' });
  assert.equal(scheduler.cps, 0.5);
  assert.deepEqual(scheduler.asked, [0.75, 0.5]);
});

test('end returns the requested tempo and keeps it without hold, and nothing without setCps or on failure', () => {
  const kept = fakeScheduler(0.5);
  const keptGuard = createTempoGuard(kept);
  keptGuard.begin();
  kept.setCps(0.75);
  assert.deepEqual(keptGuard.end(false), { requested: 0.75, glide: 'none' });
  assert.equal(kept.cps, 0.75);

  const failed = fakeScheduler(0.5);
  const failedGuard = createTempoGuard(failed);
  failedGuard.begin();
  failed.setCps(0.75);
  assert.deepEqual(failedGuard.end(true), { requested: undefined, glide: 'none' });
  assert.equal(failed.cps, 0.5);

  const untouched = fakeScheduler(0.5);
  const untouchedGuard = createTempoGuard(untouched);
  untouchedGuard.begin();
  assert.deepEqual(untouchedGuard.end(false), { requested: undefined, glide: 'none' });
  untouchedGuard.begin();
  assert.deepEqual(untouchedGuard.end(false, { hold: true }), { requested: undefined, glide: 'none' });
  assert.deepEqual(untouched.asked, []);
});

test('apply sets the tempo through the raw setter and leaves an open evaluation record alone', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.apply(0.75);
  assert.equal(scheduler.cps, 0.75);
  guard.begin();
  scheduler.setCps(1);
  guard.apply(2);
  assert.equal(scheduler.cps, 2);
  assert.deepEqual(guard.end(false), { requested: 1, glide: 'none' });
  assert.equal(scheduler.cps, 1, 'the program\'s own tempo plays and is the one reported');
});

test('an apply during an evaluation is the tempo a failed evaluation restores, not the one from before it', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(2);
  guard.apply(0.75); // a waiting change reached its line while this evaluation ran
  guard.end(true);
  assert.equal(scheduler.cps, 0.75);
});

test('an apply during a held evaluation keeps the applied tempo playing and returns the held tempo', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(2);
  guard.apply(0.75);
  assert.deepEqual(guard.end(false, { hold: true }), { requested: 2, glide: 'none' });
  assert.equal(scheduler.cps, 0.75);
});

test('an apply during an evaluation that never set a tempo leaves the applied tempo', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  guard.apply(0.75);
  assert.deepEqual(guard.end(true), { requested: undefined, glide: 'none' });
  assert.equal(scheduler.cps, 0.75);
});

test('a tempo set by the program after an apply stays, without being asked again', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  guard.apply(0.75);
  scheduler.setCps(1.5);
  assert.deepEqual(guard.end(false), { requested: 1.5, glide: 'none' });
  assert.deepEqual(scheduler.asked, [0.75, 1.5]);
});

test('apply refuses a cps that is not a finite number above 0', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, '0.5', undefined]) {
    assert.throws(() => guard.apply(bad), /^Error: Moontide:/);
  }
  assert.deepEqual(scheduler.asked, []);
});

test('after a hold, a newer failed evaluation restores the held-back tempo', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  scheduler.setCps(0.75);
  guard.end(false, { hold: true });
  guard.begin();
  scheduler.setCps(0.9);
  guard.end(true);
  assert.equal(scheduler.cps, 0.5);
});

test('playing is the scheduler tempo outside an evaluation and the tempo from before it (or the last apply) during one', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  assert.equal(guard.playing(), 0.5);
  guard.begin();
  scheduler.setCps(2);
  assert.equal(scheduler.cps, 2);
  assert.equal(guard.playing(), 0.5, 'the program\'s tempo is not the one that plays yet');
  guard.apply(0.75);
  assert.equal(guard.playing(), 0.75);
  guard.end(false);
  assert.equal(guard.playing(), scheduler.cps);
});

// --- the tempo ramp: what an evaluation does to a ramp that runs (one test per cell of the table in the module's comment) ---

// A ramp like the page's: running, a target, and a cancel that records the reason and the tempo the scheduler held at that moment.
function fakeGlide(scheduler, target = 0.5) {
  const canceled = [];
  let runs = target !== null;
  return {
    canceled,
    running: () => runs,
    targetCps: () => (runs ? target : null),
    cancel(reason) {
      canceled.push({ reason, cps: scheduler.cps });
      runs = false;
      return true;
    },
  };
}

const STEP = 0.4; // the step that plays while a ramp toward 0.5 runs

function rampSetup(target = 0.5) {
  const scheduler = fakeScheduler(STEP);
  const glide = fakeGlide(scheduler, target);
  const guard = createTempoGuard(scheduler, { glide });
  return { scheduler, glide, guard };
}

test('a glide must have running, targetCps and cancel functions', () => {
  const scheduler = fakeScheduler(0.5);
  assert.throws(() => createTempoGuard(scheduler, { glide: { running() {}, targetCps() {} } }), /^Error: Moontide:.*cancel/);
  assert.throws(() => createTempoGuard(fakeScheduler(0.5), { glide: {} }), /^Error: Moontide:/);
});

test('table: no ramp runs, so every evaluation is as before and the result is none', () => {
  const scheduler = fakeScheduler(0.4);
  const glide = fakeGlide(scheduler, null);
  const guard = createTempoGuard(scheduler, { glide });
  guard.begin();
  scheduler.setCps(0.6);
  assert.deepEqual(guard.end(false), { requested: 0.6, glide: 'none' });
  assert.equal(scheduler.cps, 0.6);
  guard.begin();
  assert.deepEqual(guard.end(false), { requested: undefined, glide: 'none' });
  assert.deepEqual(glide.canceled, []);
});

test('table: a failed evaluation mid-ramp puts the step back and keeps the ramp', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.9);
  assert.deepEqual(guard.end(true), { requested: undefined, glide: 'kept' });
  assert.equal(scheduler.cps, STEP);
  assert.deepEqual(scheduler.asked, [0.9, STEP]);
  assert.deepEqual(glide.canceled, []);
  guard.begin();
  assert.deepEqual(guard.end(true), { requested: undefined, glide: 'kept' });
  assert.deepEqual(glide.canceled, []);
});

test('table: a program that restates the target keeps the ramp and the step is put back in the same call', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.5);
  assert.equal(scheduler.cps, 0.5, 'the program sees its tempo while it runs');
  assert.deepEqual(guard.end(false), { requested: 0.5, glide: 'kept' });
  assert.deepEqual(scheduler.asked, [0.5, STEP], 'the target by the program, then the step, both before end returns');
  assert.equal(scheduler.cps, STEP);
  assert.deepEqual(glide.canceled, []);
});

test('table: a program that states another tempo wins at once and cancels the ramp, which reads the tempo after the cancel', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.3);
  assert.deepEqual(guard.end(false), { requested: 0.3, glide: 'other-tempo' });
  assert.equal(scheduler.cps, 0.3);
  assert.deepEqual(scheduler.asked, [0.3]);
  assert.deepEqual(glide.canceled, [{ reason: 'other-tempo', cps: 0.3 }]);
});

test('table: a program with no tempo statement cancels the ramp and the tempo stays where the ramp was', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  assert.deepEqual(guard.end(false), { requested: undefined, glide: 'no-tempo' });
  assert.equal(scheduler.cps, STEP);
  assert.deepEqual(scheduler.asked, []);
  assert.deepEqual(glide.canceled, [{ reason: 'no-tempo', cps: STEP }]);
});

test('table: a change that waits keeps the ramp whatever its program states, and its tempo is held back', () => {
  for (const stated of [0.5, 0.3, undefined]) {
    const { scheduler, glide, guard } = rampSetup();
    guard.begin();
    if (stated !== undefined) scheduler.setCps(stated);
    assert.deepEqual(guard.end(false, { hold: true }), { requested: stated, glide: 'kept' });
    assert.equal(scheduler.cps, STEP);
    assert.deepEqual(glide.canceled, []);
  }
});

test('table: a change that asks for a ramp gets the step back and leaves the cancel and the new ramp to the caller', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.9);
  assert.deepEqual(guard.end(false, { startsGlide: true }), { requested: 0.9, glide: 'kept' });
  assert.equal(scheduler.cps, STEP);
  assert.deepEqual(glide.canceled, []);
  // With no ramp running the result is none, and the tempo is held back just the same.
  const idle = fakeScheduler(0.4);
  const idleGuard = createTempoGuard(idle, { glide: fakeGlide(idle, null) });
  idleGuard.begin();
  idle.setCps(0.9);
  assert.deepEqual(idleGuard.end(false, { startsGlide: true }), { requested: 0.9, glide: 'none' });
  assert.equal(idle.cps, 0.4);
});

test('table: a step applied during an evaluation that restates the target is the step that stays', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.5);
  guard.apply(0.45);
  assert.deepEqual(guard.end(false), { requested: 0.5, glide: 'kept' });
  assert.equal(scheduler.cps, 0.45);
  assert.deepEqual(glide.canceled, []);
});

test('table: a step applied during an evaluation that states another tempo leaves the program tempo', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.3);
  guard.apply(0.45);
  assert.deepEqual(guard.end(false), { requested: 0.3, glide: 'other-tempo' });
  assert.equal(scheduler.cps, 0.3);
  assert.deepEqual(glide.canceled, [{ reason: 'other-tempo', cps: 0.3 }]);
});

test('table: a step applied during a failed evaluation is the tempo after it, and the ramp goes on', () => {
  const { scheduler, glide, guard } = rampSetup();
  guard.begin();
  scheduler.setCps(0.9);
  guard.apply(0.45);
  assert.deepEqual(guard.end(true), { requested: undefined, glide: 'kept' });
  assert.equal(scheduler.cps, 0.45);
  assert.deepEqual(glide.canceled, []);
});

test('a Mixer drag: several evaluations in a row that restate the target each end on the step that played', () => {
  const { scheduler, glide, guard } = rampSetup();
  let step = STEP;
  for (let i = 0; i < 5; i += 1) {
    guard.begin();
    scheduler.setCps(0.5);
    guard.end(false);
    assert.equal(scheduler.cps, step, `evaluation ${i} ends on the step`);
    // A step lands between two evaluations.
    step += 0.01;
    guard.apply(step);
  }
  guard.begin();
  scheduler.setCps(0.5);
  guard.apply(step + 0.01);
  guard.end(false);
  assert.equal(scheduler.cps, step + 0.01);
  assert.deepEqual(glide.canceled, []);
});

test('end without begin returns none and touches neither the scheduler nor the glide', () => {
  const { scheduler, glide, guard } = rampSetup();
  assert.deepEqual(guard.end(false), { requested: undefined, glide: 'none' });
  assert.deepEqual(guard.end(true, { hold: true, startsGlide: true }), { requested: undefined, glide: 'none' });
  assert.deepEqual(scheduler.asked, []);
  assert.deepEqual(glide.canceled, []);
});

test('requestedSoFar: undefined before begin and while no tempo is set, the program value after setCps, undefined after end', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  assert.equal(guard.requestedSoFar(), undefined);
  guard.begin();
  assert.equal(guard.requestedSoFar(), undefined);
  scheduler.setCps(0.7);
  assert.equal(guard.requestedSoFar(), 0.7);
  scheduler.setCps(0.8);
  assert.equal(guard.requestedSoFar(), 0.8);
  guard.apply(0.6);
  assert.equal(guard.requestedSoFar(), 0.8, 'an apply is not the program\'s tempo');
  guard.end(false);
  assert.equal(guard.requestedSoFar(), undefined);
});

test('without the glide option the glide result is none for every kind of end', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  for (const options of [{}, { hold: true }, { startsGlide: true }]) {
    for (const failed of [false, true]) {
      guard.begin();
      scheduler.setCps(0.9);
      assert.equal(guard.end(failed, options).glide, 'none');
    }
  }
});
