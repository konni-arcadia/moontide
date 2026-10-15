import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTakeover, gatePattern } from '../page/takeover.js';
import { installQueryCheck, createSchedulerQueryScope } from '../page/query-check.js';
import { createOncePerChange } from '../page/ui-state.js';

// Fractions in the pinned Strudel are objects: the gate must use lte/gte/gt and valueOf, never === or <.
class FakeFraction {
  constructor(value) {
    this.value = Number(value);
  }
  lte(other) {
    return this.value <= Number(other);
  }
  gte(other) {
    return this.value >= Number(other);
  }
  gt(other) {
    return this.value > Number(other);
  }
  valueOf() {
    return this.value;
  }
}

class FakeTimeSpan {
  constructor(begin, end) {
    this.begin = new FakeFraction(begin);
    this.end = new FakeFraction(end);
  }
}

class FakeState {
  constructor(span, controls) {
    this.span = span;
    this.controls = controls;
  }
  setSpan(span) {
    return new FakeState(span, this.controls);
  }
}

// The constructor of every fake pattern, so a gate built with `new newPattern.constructor(fn)` is a FakePattern too.
class FakePattern {
  constructor(query) {
    this.query = query;
  }
}

/** A pattern that records the spans it is asked for and returns one event tagged with its side. */
function leaf(side, calls) {
  return new FakePattern((state) => {
    calls.push({ side, begin: Number(state.span.begin), end: Number(state.span.end), controls: state.controls });
    return [{ side, begin: Number(state.span.begin), end: Number(state.span.end) }];
  });
}

const query = (pattern, begin, end, controls = { cyclist: 'cyclist', _cps: 0.5 }) =>
  pattern.query(new FakeState(new FakeTimeSpan(begin, end), controls));

function makeGate({ boundary = 3, leadCycles = 0.15, onLead = () => {}, onReached = () => {}, onError = () => {} } = {}) {
  const calls = [];
  const oldPattern = leaf('old', calls);
  const newPattern = leaf('new', calls);
  const gate = gatePattern(oldPattern, newPattern, boundary, { TimeSpan: FakeTimeSpan, leadCycles, onLead, onReached, onError });
  return { gate, calls, oldPattern, newPattern };
}

test('gatePattern: a span that ends at or before the line queries only the old pattern', () => {
  const { gate, calls } = makeGate();
  const events = query(gate, 1, 2);
  assert.deepEqual(events.map((e) => e.side), ['old']);
  assert.deepEqual(calls.map((c) => c.side), ['old']);
  query(gate, 2, 3);
  assert.deepEqual(calls.map((c) => c.side), ['old', 'old']);
});

test('gatePattern: a span that begins at or after the line queries only the new pattern', () => {
  const { gate, calls } = makeGate();
  const events = query(gate, 3, 4);
  assert.deepEqual(events.map((e) => e.side), ['new']);
  assert.deepEqual(calls.map((c) => c.side), ['new']);
});

test('gatePattern: a span that crosses the line is split, each half with the controls', () => {
  const { gate, calls } = makeGate();
  const controls = { cyclist: 'cyclist', _cps: 0.5 };
  const events = query(gate, 2.75, 3.25, controls);
  assert.deepEqual(events.map((e) => e.side), ['old', 'new']);
  assert.deepEqual(
    calls.map((c) => [c.side, c.begin, c.end]),
    [
      ['old', 2.75, 3],
      ['new', 3, 3.25],
    ],
  );
  assert.equal(calls[0].controls, controls);
  assert.equal(calls[1].controls, controls);
});

test('gatePattern: once past the line the old pattern is never queried again', () => {
  const { gate, calls } = makeGate();
  query(gate, 3.25, 3.5);
  query(gate, 3.5, 3.75);
  assert.equal(calls.some((c) => c.side === 'old'), false);
});

test('gatePattern: is built with the constructor of the new pattern', () => {
  const { gate } = makeGate();
  assert.ok(gate instanceof FakePattern);
});

test('gatePattern: the lead hook fires once when the span end reaches the lead, the reached hook once past the line, lead first', () => {
  const order = [];
  const { gate } = makeGate({
    boundary: 3,
    leadCycles: 0.15,
    onLead: () => order.push('lead'),
    onReached: () => order.push('reached'),
  });
  query(gate, 0, 0.5);
  query(gate, 2.5, 2.75);
  assert.deepEqual(order, []);
  query(gate, 2.75, 2.9);
  assert.deepEqual(order, ['lead']);
  query(gate, 2.9, 3);
  assert.deepEqual(order, ['lead']);
  query(gate, 3, 3.1);
  assert.deepEqual(order, ['lead', 'reached']);
  query(gate, 3.1, 3.2);
  query(gate, 3.2, 3.3);
  assert.deepEqual(order, ['lead', 'reached']);
});

test('gatePattern: a first query already past the line fires lead before reached', () => {
  const order = [];
  const { gate } = makeGate({ onLead: () => order.push('lead'), onReached: () => order.push('reached') });
  query(gate, 3.5, 3.75);
  assert.deepEqual(order, ['lead', 'reached']);
});

test('gatePattern: a query without the cyclist control (the Drawer, the Timeline) fires no hook but is still gated', () => {
  const order = [];
  const { gate, calls } = makeGate({ onLead: () => order.push('lead'), onReached: () => order.push('reached') });
  const events = query(gate, 2.5, 4.6, { painters: [] });
  assert.deepEqual(events.map((e) => e.side), ['old', 'new'], 'the line still splits the span');
  assert.deepEqual(calls.map((c) => c.side), ['old', 'new']);
  query(gate, 2.9, 3.5, null);
  query(gate, 2.9, 3.5, { cyclist: 5 });
  assert.deepEqual(order, [], 'neither lead nor reached fired');
  query(gate, 2.9, 3.1);
  assert.deepEqual(order, ['lead', 'reached'], 'the scheduler query still fires them, once');
});

test('gatePattern: a hook that throws is reported once and never changes the query result', () => {
  const errors = [];
  let leadCalls = 0;
  const { gate } = makeGate({
    onLead: () => {
      leadCalls += 1;
      throw new Error('lead broke');
    },
    onError: (text, err) => errors.push([text, err.message]),
  });
  const events = query(gate, 2.75, 3.25);
  assert.deepEqual(events.map((e) => e.side), ['old', 'new']);
  assert.deepEqual(errors, [['Moontide: a takeover hook failed:', 'lead broke']]);
  query(gate, 3.25, 3.5);
  query(gate, 3.5, 3.75);
  assert.equal(leadCalls, 1);
  assert.equal(errors.length, 1);
});

test('gatePattern: a missing TimeSpan constructor is a loud error', () => {
  assert.throws(
    () => gatePattern(leaf('old', []), leaf('new', []), 3, { TimeSpan: undefined, leadCycles: 0.1, onLead() {}, onReached() {}, onError() {} }),
    /^Error: Moontide: /,
  );
});

function makeTakeover({ timing = { at: 'bar', lineLength: 1 }, playing = true, getCps } = {}) {
  const calls = [];
  const initial = leaf('playing', calls);
  const scheduler = {
    started: true,
    pattern: initial,
    cps: 0.5,
    lastEnd: 2.3,
    num_cycles_at_cps_change: 0,
    seconds_at_cps_change: 0,
    latency: 0.1,
  };
  const state = { timing, playing };
  const timers = [];
  const log = { armed: [], lead: [], reached: [], cancel: [], errors: [] };
  const takeover = createTakeover({
    getScheduler: () => scheduler,
    getTypes: () => ({ TimeSpan: FakeTimeSpan }),
    getTiming: () => state.timing,
    ...(getCps === undefined ? {} : { getCps }),
    isPlaying: () => state.playing,
    msUntil: () => 1000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    onArmed: (record) => log.armed.push(record),
    onLead: (record) => log.lead.push(record),
    onReached: (record) => log.reached.push(record),
    onCancel: (record, reason) => log.cancel.push([record, reason]),
    onError: (text, err) => log.errors.push([text, err instanceof Error ? err.message : String(err)]),
  });
  return { takeover, scheduler, state, timers, log, calls, initial };
}

/** Arms a record over the scheduler's pattern and installs its gate as the scheduler's pattern, as setPattern would. */
function arm(ctx, { boundary = 3, side = 'next', playingCode = 'old code', onReached = () => {} } = {}) {
  const pattern = leaf(side, ctx.calls);
  const gate = ctx.takeover.arm({ boundary, pattern, playingCode, onReached });
  ctx.scheduler.pattern = gate;
  return { gate, pattern, record: ctx.takeover.pending() };
}

test('plan: null for now, null while nothing plays, otherwise the boundary after the frontier', () => {
  const ctx = makeTakeover({ timing: { at: 'now', lineLength: 0 } });
  assert.equal(ctx.takeover.plan(), null);
  ctx.state.timing = { at: 'bar', lineLength: 1 };
  ctx.state.playing = false;
  assert.equal(ctx.takeover.plan(), null);
  ctx.state.playing = true;
  assert.deepEqual(ctx.takeover.plan(), { boundary: 3 });
  ctx.state.timing = { at: 'phrase', lineLength: 4 };
  assert.deepEqual(ctx.takeover.plan(), { boundary: 4 });
  assert.equal(ctx.takeover.pending(), null);
});

test('plan: a timing pinned to a line takes that line while it is at least the minimum lead ahead, and says so', () => {
  const ctx = makeTakeover({ timing: { at: 'section', lineLength: 1, atCycle: 18 } });
  assert.deepEqual(ctx.takeover.plan(), { boundary: 18, pinned: true });
  // The scheduler frontier at 2.5 and half a cycle a second: a quarter of a cycle is exactly the half second of minimum lead.
  ctx.scheduler.lastEnd = 2.5;
  ctx.state.timing = { at: 'section', lineLength: 1, atCycle: 2.75 };
  assert.deepEqual(ctx.takeover.plan(), { boundary: 2.75, pinned: true }, 'a lead of exactly 0.5 s still counts');
  ctx.state.timing = { at: 'section', lineLength: 1, atCycle: 2.7 };
  assert.deepEqual(ctx.takeover.plan(), { boundary: 3, pinned: false }, 'closer than that: the next line of the timing instead');
  ctx.state.timing = { at: 'phrase', lineLength: 4, atCycle: 2.7 };
  assert.deepEqual(ctx.takeover.plan(), { boundary: 4, pinned: false }, 'a phrase falls back to the next phrase line');
  ctx.state.timing = { at: 'bar', lineLength: 1, atCycle: 3 };
  assert.deepEqual(ctx.takeover.plan(), { boundary: 3, pinned: true });
  assert.equal(ctx.takeover.pending(), null, 'planning changes no state');
});

test('plan: a pinned timing is null for now and while nothing plays, like any timing', () => {
  const ctx = makeTakeover({ timing: { at: 'now', lineLength: 0, atCycle: 18 } });
  assert.equal(ctx.takeover.plan(), null);
  ctx.state.timing = { at: 'section', lineLength: 1, atCycle: 18 };
  ctx.state.playing = false;
  assert.equal(ctx.takeover.plan(), null);
});

test('plan: a pinned line is read against the tempo that plays (getCps)', () => {
  const ctx = makeTakeover({ timing: { at: 'section', lineLength: 1, atCycle: 3 }, getCps: () => 2 });
  ctx.scheduler.cps = 0.25;
  // At 2 cycles a second a line 0.7 cycles ahead is 0.35 s ahead: too close; at the scheduler's own 0.25 it would be fine.
  assert.deepEqual(ctx.takeover.plan(), { boundary: 4, pinned: false });
});

test('cancel: a launch the person cancels says why, and nothing of it follows', () => {
  const ctx = makeTakeover();
  const { record } = arm(ctx);
  let followed = false;
  ctx.takeover.whenFinished(record, () => {
    followed = true;
  });
  ctx.takeover.cancel('canceled');
  assert.equal(ctx.takeover.pending(), null);
  assert.equal(record.canceled, true);
  assert.equal(record.cancelReason, 'canceled');
  assert.deepEqual(ctx.log.cancel, [[record, 'canceled']]);
  assert.equal(followed, false);
});

test('plan and the lead hook use the tempo that plays (getCps), not the scheduler cps a program just set', async () => {
  // The scheduler already holds the new, slower tempo (0.25 cps) while the old music plays at 2 cps.
  const ctx = makeTakeover({ getCps: () => 2 });
  ctx.scheduler.cps = 0.25;
  // Half a second of the playing tempo is one cycle: the line 0.7 cycles ahead is too close, the next one is used.
  assert.deepEqual(ctx.takeover.plan(), { boundary: 4 });
  const slow = makeTakeover();
  slow.scheduler.cps = 0.25;
  assert.deepEqual(slow.takeover.plan(), { boundary: 3 }, 'without getCps the scheduler cps is read');
  // The lead hook is 0.3 s of the playing tempo (0.6 cycles) before the line.
  const { gate, record } = arm(ctx, { boundary: 4 });
  query(gate, 3.2, 3.35);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.lead, []);
  query(gate, 3.35, 3.45);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.lead, [record]);
});

test('plan: a scheduler without a usable tempo is a loud error', () => {
  const ctx = makeTakeover();
  ctx.scheduler.cps = 0;
  assert.throws(() => ctx.takeover.plan(), /^Error: Moontide: /);
});

test('arm: records the change, tells onArmed and returns a gate over the playing pattern', () => {
  const ctx = makeTakeover();
  const { record, gate } = arm(ctx);
  assert.equal(ctx.takeover.pending(), record);
  assert.deepEqual(ctx.log.armed, [record]);
  assert.equal(record.boundary, 3);
  assert.equal(record.playingCode, 'old code');
  assert.equal(record.playingPattern, ctx.initial);
  query(gate, 1, 2);
  assert.deepEqual(ctx.calls.map((c) => c.side), ['playing']);
});

test('arm: a newer change replaces the waiting one and its gate is built over the pattern that plays', () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first', playingCode: 'old code' });
  const second = arm(ctx, { boundary: 4, side: 'second', playingCode: 'first code (committed, not playing)' });
  assert.deepEqual(ctx.log.cancel.map(([record, reason]) => [record, reason]), [[first.record, 'replaced']]);
  assert.equal(ctx.takeover.pending(), second.record);
  assert.equal(second.record.playingPattern, ctx.initial);
  assert.equal(second.record.playingCode, 'old code');
  query(second.gate, 1, 2);
  assert.deepEqual(ctx.calls.map((c) => c.side), ['playing']);
});

test('arm: after a takeover finished the next gate is built over the new pattern, never over the finished gate', () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first' });
  query(first.gate, 3, 3.1);
  assert.equal(ctx.timers.length, 1);
  ctx.timers[0].fn();
  assert.equal(ctx.takeover.pending(), null);
  ctx.calls.length = 0;
  const second = arm(ctx, { boundary: 6, side: 'second', playingCode: 'first code' });
  assert.equal(second.record.playingPattern, first.pattern);
  assert.equal(second.record.playingCode, 'first code');
  query(second.gate, 4, 5);
  assert.deepEqual(ctx.calls.map((c) => c.side), ['first']);
});

test('arm: after an immediate change took over, the next gate is built over the scheduler pattern', () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first' });
  query(first.gate, 3, 3.1);
  ctx.timers[0].fn();
  const immediate = leaf('immediate', ctx.calls);
  ctx.takeover.replaceForImmediate();
  ctx.scheduler.pattern = immediate;
  const second = arm(ctx, { boundary: 6, side: 'second' });
  assert.equal(second.record.playingPattern, immediate);
});

test('arm: the cheap reached callback runs inside the query, the factory hooks after a microtask, lead before reached', async () => {
  const ctx = makeTakeover();
  let cheap = 0;
  const { gate, record } = arm(ctx, { onReached: () => (cheap += 1) });
  query(gate, 2.75, 2.9);
  assert.deepEqual(ctx.log.lead, []);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.lead, [record]);
  assert.equal(cheap, 0);
  query(gate, 3, 3.1);
  assert.equal(cheap, 1);
  assert.deepEqual(ctx.log.reached, []);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.reached, [record]);
  query(gate, 3.1, 3.2);
  assert.equal(cheap, 1);
  assert.equal(ctx.timers.length, 1);
  assert.equal(ctx.timers[0].ms, 1000);
});

test('arm: a Drawer query past the line leaves the record waiting, a later change cancels it as replaced', async () => {
  const ctx = makeTakeover();
  const { gate, record } = arm(ctx, { side: 'first' });
  query(gate, 2.3, 4.4, { painters: [] });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(record.reached, false);
  assert.deepEqual(ctx.log.lead, []);
  assert.deepEqual(ctx.log.reached, []);
  assert.equal(ctx.timers.length, 0, 'no finish timer');
  const second = arm(ctx, { boundary: 6, side: 'second' });
  assert.deepEqual(ctx.log.cancel, [[record, 'replaced']], 'the first change is replaced, not finished early');
  assert.equal(record.finished, false);
  assert.equal(second.record.playingPattern, ctx.initial, 'the second gate is built over the music that plays');
});

test('arm: a cheap reached callback that throws is reported and the hook and the finish timer still follow', async () => {
  const ctx = makeTakeover();
  const { gate, record } = arm(ctx, {
    onReached: () => {
      throw new Error('cheap broke');
    },
  });
  query(gate, 3, 3.1);
  assert.deepEqual(ctx.log.errors, [['Moontide: a takeover callback failed:', 'cheap broke']]);
  assert.equal(ctx.timers.length, 1, 'the finish timer is set');
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.reached, [record], 'the tempo hook runs');
});

test('cancel: runs onCancel once with the reason, and the finishers never run, also when the timer fires later', () => {
  const ctx = makeTakeover();
  const { gate, record } = arm(ctx);
  const ran = [];
  ctx.takeover.whenFinished(record, () => ran.push('finisher'));
  query(gate, 3, 3.1);
  ctx.takeover.cancel('stop');
  ctx.takeover.cancel('stop');
  assert.deepEqual(ctx.log.cancel, [[record, 'stop']]);
  assert.equal(ctx.takeover.pending(), null);
  assert.equal(ctx.timers[0].cleared, true);
  ctx.timers[0].fn();
  ctx.takeover.finishIfDue(10);
  assert.deepEqual(ran, []);
});

test('cancel: the record keeps the reason, so a reply that comes after the cancel can tell why', () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first' });
  assert.equal(first.record.cancelReason, null);
  const second = arm(ctx, { boundary: 4, side: 'second' });
  assert.equal(first.record.canceled, true);
  assert.equal(first.record.cancelReason, 'replaced');
  ctx.takeover.cancel('stop');
  assert.equal(second.record.cancelReason, 'stop');
});

test('cancel: a hook of a canceled record never runs after the microtask either', async () => {
  const ctx = makeTakeover();
  const { gate } = arm(ctx);
  query(gate, 2.75, 2.9);
  ctx.takeover.cancel('stop');
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.lead, []);
});

test('a record that did not reach its line is replaced: its finishers never run and nothing of it is applied', async () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first' });
  const ran = [];
  ctx.takeover.whenFinished(first.record, () => ran.push('first'));
  query(first.gate, 2.75, 2.9);
  const second = arm(ctx, { boundary: 4, side: 'second' });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ran, []);
  assert.deepEqual(ctx.log.cancel.map(([record, reason]) => [record, reason]), [[first.record, 'replaced']]);
  assert.deepEqual(ctx.log.reached, []);
  assert.equal(ctx.takeover.pending(), second.record);
});

test('a record whose gate passed its line plays: a newer timed change finishes it first and is built over its code', () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first', playingCode: 'old code' });
  const ran = [];
  ctx.takeover.whenFinished(first.record, () => ran.push('first'));
  query(first.gate, 3, 3.1);
  assert.equal(first.record.reached, true);
  const stale = ctx.timers[0];
  const second = arm(ctx, { boundary: 5, side: 'second', playingCode: 'first code' });
  assert.deepEqual(ran, ['first'], 'the bookkeeping of the change that plays ran');
  assert.deepEqual(ctx.log.cancel, [], 'nothing was canceled');
  assert.deepEqual(ctx.log.reached, [first.record], 'its tempo hook ran once, before the newer change');
  assert.equal(first.record.finished, true);
  assert.equal(stale.cleared, true);
  assert.equal(second.record.playingPattern, first.pattern, 'the newer gate is built over the code that plays');
  assert.equal(second.record.playingCode, 'first code');
  assert.equal(ctx.takeover.pending(), second.record);
  ctx.calls.length = 0;
  query(second.gate, 3.5, 4);
  assert.deepEqual(ctx.calls.map((c) => c.side), ['first']);
});

test('a record whose gate passed its line plays: an immediate change finishes it and nothing is canceled', async () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first' });
  const ran = [];
  ctx.takeover.whenFinished(first.record, () => ran.push('first'));
  query(first.gate, 3, 3.1);
  ctx.takeover.replaceForImmediate();
  assert.deepEqual(ran, ['first']);
  assert.deepEqual(ctx.log.cancel, []);
  assert.equal(ctx.takeover.pending(), null);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.reached, [first.record], 'the tempo hook still ran exactly once');
});

test('settleReached: finishes only a reached record and is a no-op without one', () => {
  const ctx = makeTakeover();
  ctx.takeover.settleReached();
  const { gate, record } = arm(ctx);
  ctx.takeover.settleReached();
  assert.equal(ctx.takeover.pending(), record);
  query(gate, 3, 3.1);
  ctx.takeover.settleReached();
  assert.equal(ctx.takeover.pending(), null);
  assert.equal(record.finished, true);
});

test('a canceled record that was reached never runs its tempo hook, also not from the microtask', async () => {
  const ctx = makeTakeover();
  const first = arm(ctx, { side: 'first' });
  query(first.gate, 3, 3.1);
  ctx.takeover.cancel('stop');
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(ctx.log.reached, []);
});

test('replaceForImmediate: cancels a waiting record with the reason replaced and is a no-op without one', () => {
  const ctx = makeTakeover();
  ctx.takeover.replaceForImmediate();
  assert.deepEqual(ctx.log.cancel, []);
  const { record } = arm(ctx);
  ctx.takeover.replaceForImmediate();
  assert.deepEqual(ctx.log.cancel, [[record, 'replaced']]);
  assert.equal(ctx.takeover.pending(), null);
});

test('finishIfDue: nothing before the line, one finish at the line, none after', () => {
  const ctx = makeTakeover();
  const { record } = arm(ctx);
  const ran = [];
  ctx.takeover.whenFinished(record, () => ran.push('done'));
  ctx.takeover.finishIfDue(2.99);
  assert.deepEqual(ran, []);
  assert.equal(ctx.takeover.pending(), record);
  ctx.takeover.finishIfDue(3);
  assert.deepEqual(ran, ['done']);
  assert.equal(ctx.takeover.pending(), null);
  ctx.takeover.finishIfDue(4);
  assert.deepEqual(ran, ['done']);
});

test('finish: the timer and the poll together finish a record exactly once', () => {
  const ctx = makeTakeover();
  const { gate, record } = arm(ctx);
  const ran = [];
  ctx.takeover.whenFinished(record, () => ran.push('done'));
  query(gate, 3, 3.1);
  ctx.timers[0].fn();
  ctx.timers[0].fn();
  ctx.takeover.finishIfDue(5);
  assert.deepEqual(ran, ['done']);
  assert.equal(record.finished, true);
});

test('whenFinished: continuations run in registration order and a throwing one does not stop the next', () => {
  const ctx = makeTakeover();
  const { record } = arm(ctx);
  const ran = [];
  ctx.takeover.whenFinished(record, () => ran.push('first'));
  ctx.takeover.whenFinished(record, () => {
    throw new Error('second broke');
  });
  ctx.takeover.whenFinished(record, () => ran.push('third'));
  ctx.takeover.finishIfDue(3);
  assert.deepEqual(ran, ['first', 'third']);
  assert.deepEqual(ctx.log.errors, [['Moontide: a takeover callback failed:', 'second broke']]);
});

test('whenFinished: a continuation added after the finish runs at once, one added to a canceled record never runs', () => {
  const ctx = makeTakeover();
  const first = arm(ctx);
  ctx.takeover.finishIfDue(3);
  const ran = [];
  ctx.takeover.whenFinished(first.record, () => ran.push('late'));
  assert.deepEqual(ran, ['late']);
  const second = arm(ctx, { boundary: 5 });
  ctx.takeover.cancel('stop');
  ctx.takeover.whenFinished(second.record, () => ran.push('canceled'));
  assert.deepEqual(ran, ['late']);
});

// The restored pattern after a canceled timed change. The real takeover, query check and scheduler query
// scope run together over a fake scheduler, so a Stop, a lost role or an unload that puts the finished change's own
// pattern back in the scheduler is covered up to the next Play.

// The bundle's own queryArc: the query runs, a failure is swallowed (the real one logs it) and no events come back.
class ArcPattern {
  constructor(query) {
    this.query = query;
  }
  queryArc(begin, end, controls) {
    try {
      return this.query(new FakeState(new FakeTimeSpan(begin, end), controls));
    } catch {
      return [];
    }
  }
}

/** An ArcPattern whose query throws for every span that begins below `cycle`. */
function failingBelow(cycle) {
  return new ArcPattern((state) => {
    if (Number(state.span.begin) < cycle) throw new Error('cannot parse as numeral: "zz"');
    return [];
  });
}

/** The page's chain (query check, scope, once-per-change guard, takeover) over a fake scheduler, as main.js builds it. */
function makeChain() {
  const scheduler = {
    started: true,
    pattern: null,
    cps: 0.5,
    lastEnd: 0,
    now() {
      return this.lastEnd;
    },
    setPattern(pattern) {
      this.pattern = pattern;
    },
  };
  const state = { timing: { at: 'now', lineLength: 0 }, playing: false };
  const timers = [];
  const errors = [];
  const forwarded = [];
  const reports = [];
  const guard = createOncePerChange();
  const types = { State: FakeState, TimeSpan: FakeTimeSpan };
  let takeover;
  const scope = createSchedulerQueryScope({
    getTypes: () => types,
    onError(text) {
      if (guard.first(text)) {
        forwarded.push(text);
        const record = takeover.pending();
        reports.push({ text, pending: record, reached: record?.reached ?? null, finished: record?.finished ?? null });
      }
    },
  });
  takeover = createTakeover({
    getScheduler: () => scheduler,
    getTypes: () => ({ TimeSpan: FakeTimeSpan }),
    getTiming: () => state.timing,
    isPlaying: () => state.playing,
    msUntil: () => 1000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    onArmed() {},
    onLead() {},
    onReached() {},
    onCancel(record, reason) {
      // What page/main.js onCancel does with the scheduler's pattern.
      if (reason !== 'replaced' && scheduler.pattern === record.gate) scheduler.pattern = record.playingPattern;
    },
    onError: (text, err) => errors.push([text, err instanceof Error ? err.message : String(err)]),
  });
  installQueryCheck(scheduler, {
    getTypes: () => types,
    queryErrors: guard,
    schedulerQueries: scope,
    takeover,
    getPlayingCode: () => 'playing code',
  });
  return { scheduler, state, timers, errors, forwarded, reports, scope, takeover };
}

const PLAY = { cyclist: 'cyclist', _cps: 0.5 };

test('timed A finishes, timed B waits, a Stop, a lost role or an unload puts A back: after Play its query error reaches the page once', () => {
  for (const reason of ['stop', 'superseded', 'unload']) {
    const { scheduler, state, timers, takeover, forwarded, scope } = makeChain();
    scheduler.setPattern(new ArcPattern(() => []), true);
    state.playing = true;
    state.timing = { at: 'bar', lineLength: 1 };
    scheduler.lastEnd = 2.3;
    // A fails for spans that begin below cycle 1: its test query from the line (cycle 3) passes, a Play from cycle 0 fails.
    const a = failingBelow(1);
    scheduler.setPattern(a, true);
    const armedArc = a.queryArc;
    scheduler.pattern.queryArc(2.9, 3.1, PLAY);
    timers[timers.length - 1].fn();
    assert.equal(takeover.pending(), null, `${reason}: A finished`);
    scheduler.lastEnd = 3.4;
    const b = new ArcPattern(() => []);
    scheduler.setPattern(b, true);
    assert.equal(takeover.pending().playingPattern, a, `${reason}: B waits over A`);
    takeover.cancel(reason);
    assert.equal(scheduler.pattern, a, `${reason}: A is the scheduler's pattern again`);

    assert.deepEqual(a.queryArc(0, 0.05, PLAY), []);
    assert.deepEqual(forwarded, ['[query] error: cannot parse as numeral: "zz"'], `${reason}: told once`);
    a.queryArc(0.05, 0.1, PLAY);
    assert.equal(forwarded.length, 1, `${reason}: a second failing tick forwards nothing`);
    a.queryArc(0.1, 0.15, { _cps: 0.5 });
    a.queryArc(0.1, 0.15);
    assert.equal(forwarded.length, 1, `${reason}: a query without the cyclist control forwards nothing`);
    assert.equal(a.queryArc, armedArc, `${reason}: the wrapper is the one set when A was armed`);
    assert.equal(Object.hasOwn(a, 'queryArc'), true, `${reason}: A carries its own queryArc`);
    scope.wrap(a);
    assert.equal(a.queryArc, armedArc, `${reason}: never wrapped twice`);
  }
});

// The page moves its evaluate tag to the new change in the takeover finisher (page/main.js), which runs at the finish
// timer when the line is audible. The error below is sent before it, so it carries the old change's tag and Claude
// reads it as coming from an earlier version. Accepted, see docs/decisions.md "The first span past the line keeps the
// old tag (accepted)".
test('a failing first span past the line is reported while the timed change still waits, before its takeover finishes (accepted seam)', () => {
  const { scheduler, state, timers, takeover, forwarded, reports } = makeChain();
  scheduler.setPattern(new ArcPattern(() => []), true);
  state.playing = true;
  state.timing = { at: 'bar', lineLength: 1 };
  scheduler.lastEnd = 2.3;
  // B fails only under the scheduler's own query (the cyclist control), so its test query from the line passes.
  const b = new ArcPattern((query) => {
    if (typeof query.controls?.cyclist === 'string') throw new Error('fails only under the scheduler');
    return [];
  });
  scheduler.setPattern(b, true);
  const record = takeover.pending();
  scheduler.pattern.queryArc(2.9, 3.1, PLAY);
  assert.deepEqual(forwarded, ['[query] error: fails only under the scheduler']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].pending, record, 'the waiting change is still the pending one');
  assert.equal(reports[0].reached, true);
  assert.equal(reports[0].finished, false, 'its takeover has not finished');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].cleared, false);
  timers[0].fn();
  assert.equal(record.finished, true);
  assert.equal(forwarded.length, 1, 'no second report of the same text');
});
