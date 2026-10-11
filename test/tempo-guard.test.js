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
  assert.deepEqual(result, { requested: 0.75 });
  assert.equal(scheduler.cps, 0.5);
  assert.deepEqual(scheduler.asked, [0.75, 0.5]);
});

test('end returns the requested tempo and keeps it without hold, and nothing without setCps or on failure', () => {
  const kept = fakeScheduler(0.5);
  const keptGuard = createTempoGuard(kept);
  keptGuard.begin();
  kept.setCps(0.75);
  assert.deepEqual(keptGuard.end(false), { requested: 0.75 });
  assert.equal(kept.cps, 0.75);

  const failed = fakeScheduler(0.5);
  const failedGuard = createTempoGuard(failed);
  failedGuard.begin();
  failed.setCps(0.75);
  assert.deepEqual(failedGuard.end(true), { requested: undefined });
  assert.equal(failed.cps, 0.5);

  const untouched = fakeScheduler(0.5);
  const untouchedGuard = createTempoGuard(untouched);
  untouchedGuard.begin();
  assert.deepEqual(untouchedGuard.end(false), { requested: undefined });
  untouchedGuard.begin();
  assert.deepEqual(untouchedGuard.end(false, { hold: true }), { requested: undefined });
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
  assert.deepEqual(guard.end(false), { requested: 1 });
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
  assert.deepEqual(guard.end(false, { hold: true }), { requested: 2 });
  assert.equal(scheduler.cps, 0.75);
});

test('an apply during an evaluation that never set a tempo leaves the applied tempo', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  guard.apply(0.75);
  assert.deepEqual(guard.end(true), { requested: undefined });
  assert.equal(scheduler.cps, 0.75);
});

test('a tempo set by the program after an apply stays, without being asked again', () => {
  const scheduler = fakeScheduler(0.5);
  const guard = createTempoGuard(scheduler);
  guard.begin();
  guard.apply(0.75);
  scheduler.setCps(1.5);
  assert.deepEqual(guard.end(false), { requested: 1.5 });
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
