import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_HOLD_BUDGET_MS,
  CLOCK_HORIZON_MS,
  CLOCK_MAX_TICKS_PER_PASS,
  CLOCK_NOTE_LEAD_MS,
  CLOCK_STAMPED_NOTE_SLACK_MS,
  CLOCK_START_LEAD_MS,
  CLOCK_TICKS_PER_CYCLE,
  CYCLIST_FIELDS,
  createPageClock,
  pageAlignment,
  readCyclist,
  resetPageAlignment,
} from '../page/midi-clock.js';
import { makeFakeAudioContext, makeFakeCyclist, makeFakeTime } from './clock-fakes.js';

// A native MIDIOutput that records what the clock sends: the bytes, the requested timestamp (undefined when none),
// the number of arguments, and the fake time of the send.
class FakeNative {
  constructor(name, time) {
    this.name = name;
    this.time = time;
    this.failing = false;
    this.sent = [];
  }

  send(data, ts) {
    if (this.failing) throw new Error('InvalidStateError: the port is disconnected');
    this.sent.push({ data: Array.from(data), ts, argc: arguments.length, at: this.time.perfNow() });
  }
}

const A = { port: 'Port A', id: 'seq' };
const B = { port: 'Port B', id: 'drums' };
const NEAR_CYCLE_0 = -0.0001;

/** A clock driven by fakes: a fake time, AudioContext and scheduler, one FakeNative per port. */
function makeRig({ cps = 100 / 4 / 60, latency = 0.1, ports = ['Port A'], alignment = { ms: null }, rampSeconds = undefined } = {}) {
  const time = makeFakeTime();
  const ctx = makeFakeAudioContext(time);
  const cyclist = makeFakeCyclist(time, { cps, latency });
  const natives = new Map(ports.map((name) => [name, new FakeNative(name, time)]));
  const env = { playing: true, ctx, gone: new Set(), held: new Set(), errors: [], causes: [], states: [], stallMs: 0 };
  const clock = createPageClock({
    getScheduler: () => cyclist,
    getAudioContext: () => env.ctx,
    perfNow: time.perfNow,
    // `env.stallMs` delays the next pass once: a main thread that was busy.
    setTimer: (fn, ms) => {
      const stall = env.stallMs;
      env.stallMs = 0;
      return time.setTimer(fn, ms + stall);
    },
    clearTimer: time.clearTimer,
    isPlaying: () => env.playing,
    resolveNative: (entry) => (env.gone.has(entry.port) ? null : (natives.get(entry.port) ?? null)),
    isEligible: (entry) => !env.held.has(entry.id),
    onState: (port, state) => env.states.push([port, state]),
    onError: (text, err) => {
      env.errors.push(text);
      env.causes.push(err instanceof Error ? err.message : '');
    },
    alignment,
    ...(rampSeconds === undefined ? {} : { rampSeconds }),
  });
  return { time, ctx, cyclist, natives, env, clock, native: natives.get(ports[0]), alignment };
}

const starts = (native) => native.sent.filter((entry) => entry.data.length === 1 && entry.data[0] === 0xfa);
const stops = (native) => native.sent.filter((entry) => entry.data.length === 1 && entry.data[0] === 0xfc);
const ticks = (native) => native.sent.filter((entry) => entry.data.length === 1 && entry.data[0] === 0xf8);
const gaps = (entries) => {
  const stamps = entries.filter((entry) => entry.ts !== undefined).map((entry) => entry.ts);
  return stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
};
const nominalMs = (cps) => 1000 / (cps * CLOCK_TICKS_PER_CYCLE);
const isIntegral = (value) => Math.abs(value - Math.round(value)) < 1e-6;

/** Advances in 10 ms steps until `done()` holds, at most `maxMs`; returns whether it held. */
function advanceUntil(rig, done, maxMs = 6000) {
  for (let spent = 0; spent < maxMs; spent += 10) {
    if (done()) return true;
    rig.time.advance(10);
  }
  return done();
}

/** What the page does at Stop: the clock first, then the scheduler and the context. */
function pageStop(rig) {
  rig.env.playing = false;
  rig.clock.stop();
  rig.cyclist.stop();
}

test('a fresh run sends one Start, then ticks 25 ms apart at 100 bpm, the Start 0.5 ms before the first tick, on a cycle boundary', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1500);
  const sent = rig.native.sent;
  assert.deepEqual(sent[0].data, [0xfa]);
  assert.deepEqual(sent[1].data, [0xf8]);
  assert.equal(starts(rig.native).length, 1);
  assert.ok(Math.abs(sent[1].ts - sent[0].ts - CLOCK_START_LEAD_MS) < 1e-6, 'the Start is 0.5 ms before the first tick');
  assert.ok(isIntegral(rig.cyclist.cycleAtPerf(sent[1].ts)), 'the first tick is on a cycle boundary');
  assert.ok(ticks(rig.native).length > 30);
  for (const gap of gaps(ticks(rig.native))) assert.ok(Math.abs(gap - 25) < 0.01, `tick spacing ${gap}`);
  assert.equal(rig.clock.stats.startsSent, 1);
  assert.equal(rig.env.errors.length, 0);
});

test('a scheduler now() slightly negative puts the Start on cycle 0', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = -0.0004;
  rig.cyclist.start();
  rig.time.advance(400);
  const start = starts(rig.native)[0];
  assert.ok(start, 'a Start was sent');
  const cycle = rig.cyclist.cycleAtPerf(start.ts + CLOCK_START_LEAD_MS);
  assert.ok(Math.abs(cycle) < 1e-6, `the Start is on cycle ${cycle}`);
  assert.equal(Object.is(cycle, -0), false);
});

test('a scheduler now() that is exactly integral puts the Start on that cycle, never on a fraction', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = 2;
  rig.cyclist.start();
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 1), 'the Start was sent');
  const cycle = rig.cyclist.cycleAtPerf(starts(rig.native)[0].ts + CLOCK_START_LEAD_MS);
  assert.ok(Math.abs(cycle - 2) < 1e-6, `the Start is on cycle ${cycle}`);
});

test('nothing is scheduled before the page alignment is known, and the alignment is learnt from five distinct pairs', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(35);
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.alignment.ms, null);
  rig.time.advance(100);
  assert.ok(starts(rig.native).length === 1, 'the Start went out once the alignment was known');
  assert.ok(Math.abs(rig.alignment.ms - 7) < 1e-6, `the alignment is ${rig.alignment.ms} ms`);
});

test('a second clock sharing the alignment schedules at once, without a warm-up', () => {
  const first = makeRig();
  first.clock.want([A]);
  first.cyclist.nowOverride = NEAR_CYCLE_0;
  first.cyclist.start();
  first.time.advance(400);
  const shared = first.alignment;
  assert.notEqual(shared.ms, null);
  const second = makeRig({ alignment: shared });
  second.clock.want([A]);
  second.cyclist.nowOverride = NEAR_CYCLE_0;
  second.cyclist.start();
  second.time.advance(15);
  assert.equal(starts(second.native).length, 1, 'the Start is sent at the first pass');
  const fresh = makeRig();
  fresh.clock.want([A]);
  fresh.cyclist.nowOverride = NEAR_CYCLE_0;
  fresh.cyclist.start();
  fresh.time.advance(15);
  assert.equal(fresh.native.sent.length, 0, 'a clock with a new alignment is still warming up');
});

test('the page-wide alignment is shared by default and resetPageAlignment brings the warm-up back', () => {
  resetPageAlignment();
  assert.equal(pageAlignment.ms, null);
  const time = makeFakeTime();
  const ctx = makeFakeAudioContext(time);
  const cyclist = makeFakeCyclist(time, { cps: 2 });
  const native = new FakeNative('Port A', time);
  const clock = createPageClock({
    getScheduler: () => cyclist,
    getAudioContext: () => ctx,
    perfNow: time.perfNow,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    isPlaying: () => true,
    resolveNative: () => native,
    onError: (text) => assert.fail(text),
  });
  clock.want([A]);
  cyclist.start();
  time.advance(300);
  assert.notEqual(pageAlignment.ms, null);
  resetPageAlignment();
  assert.equal(pageAlignment.ms, null);
});

test('an outlier output-timestamp pair is ignored and changes no tick timestamp', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(300);
  rig.ctx.outlierOnce(30);
  rig.time.advance(600);
  assert.equal(rig.clock.stats.outliers, 1);
  const stamps = ticks(rig.native);
  assert.ok(stamps.length > 20);
  for (const gap of gaps(stamps)) assert.ok(Math.abs(gap - 25) < 0.01, `tick spacing ${gap}`);
  assert.ok(Math.abs(rig.alignment.ms - 7) < 1e-6, 'the alignment did not move');
});

test('one odd output-timestamp pair read by every tick of a catch-up pass counts once and does not reset the alignment', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  rig.cyclist.nowOverride = null;
  assert.ok(Math.abs(rig.alignment.ms - 7) < 1e-6);
  // The first pass after a 4 s stall plans the full cap (200 ticks, above the 50 odd pairs that reset the alignment)
  // and reads one pair, 30 ms late, for all of them.
  const read = rig.ctx.getOutputTimestamp;
  const stallFrom = rig.time.perfNow();
  let oddAt = null;
  rig.ctx.getOutputTimestamp = () => {
    const pair = read();
    if (oddAt === null && rig.time.perfNow() - stallFrom >= 4000) oddAt = rig.time.perfNow();
    if (rig.time.perfNow() === oddAt) pair.performanceTime += 30;
    return pair;
  };
  rig.env.stallMs = 4000;
  rig.time.advance(4025);
  assert.ok(rig.clock.stats.late >= CLOCK_MAX_TICKS_PER_PASS, 'the catch-up pass planned the full cap');
  assert.equal(rig.clock.stats.outliers, 1);
  assert.ok(Math.abs(rig.alignment.ms - 7) < 1e-6, `the alignment is ${rig.alignment.ms} ms`);
  rig.time.advance(300);
  assert.equal(rig.env.errors.length, 0);
  assert.equal(rig.clock.stats.outliers, 1);
  assert.ok(Math.abs(rig.alignment.ms - 7) < 1e-6);
});

test('a Start that would be late moves to the next boundary, with no tick before it', () => {
  const rig = makeRig({ latency: 0 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(400);
  // The alignment was known only after cycle 0's time: the Start waits for cycle 1, and nothing is sent meanwhile.
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.clock.stats.startsDeferred, 1);
  assert.ok(advanceUntil(rig, () => rig.native.sent.length > 0));
  assert.deepEqual(rig.native.sent[0].data, [0xfa]);
  const cycle = rig.cyclist.cycleAtPerf(rig.native.sent[0].ts + CLOCK_START_LEAD_MS);
  assert.ok(Math.abs(cycle - 1) < 1e-6, `the Start is on cycle ${cycle}`);
  assert.equal(rig.clock.stats.startsDeferred, 1);
});

test('a tempo change from 100 to 140 bpm leaves no hole: the old segment keeps its positions, then ticks 17.86 ms apart', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  rig.cyclist.setCps(140 / 4 / 60);
  rig.time.advance(1500);
  const all = gaps(ticks(rig.native));
  assert.ok(all.length > 100);
  for (const gap of all) assert.ok(gap <= 25.01, `no interval above one 100 bpm tick, got ${gap}`);
  for (const gap of all.slice(-20)) assert.ok(Math.abs(gap - nominalMs(140 / 4 / 60)) < 0.01, `new tempo spacing ${gap}`);
  assert.ok(all.some((gap) => Math.abs(gap - 25) < 0.01), 'the old tempo ran first');
  assert.equal(starts(rig.native).length, 1);
});

test('after a suspend whose output-timestamp pair froze, a new run starts on the first reachable boundary, never a deferral loop', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.equal(starts(rig.native).length, 1);
  pageStop(rig);
  rig.ctx.suspend();
  rig.time.advance(3000);
  rig.ctx.resume();
  const resumedAt = rig.time.perfNow();
  rig.env.playing = true;
  rig.cyclist.start();
  rig.time.advance(600);
  const allStarts = starts(rig.native);
  assert.equal(allStarts.length, 2, 'the new run has its own Start');
  assert.ok(allStarts[1].at - resumedAt < 400, `the Start was sent ${allStarts[1].at - resumedAt} ms after the resume`);
  const cycle = rig.cyclist.cycleAtPerf(allStarts[1].ts + CLOCK_START_LEAD_MS);
  assert.ok(isIntegral(cycle) && cycle <= 1, `the Start is on cycle ${cycle}`);
  assert.ok(rig.clock.stats.startsDeferred <= 1, `deferred ${rig.clock.stats.startsDeferred} times`);
  assert.ok(rig.clock.stats.staleTimestamps > 0, 'the frozen and zero pairs were seen');
});

test('a context stopped and resumed under a running scheduler sends no burst of late ticks from the frozen output-timestamp pair', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  rig.ctx.suspend();
  rig.time.advance(3000);
  const lengthAtSuspend = rig.native.sent.length;
  rig.ctx.resume();
  // Inside the 30 ms after the resume the pair says performanceTime 0, and the kept pair is 3 s old.
  rig.time.advance(25);
  assert.equal(rig.clock.stats.late, 0, 'no late tick was sent');
  assert.equal(rig.native.sent.slice(lengthAtSuspend).filter((entry) => entry.ts === undefined).length, 0);
  assert.ok(rig.clock.stats.staleTimestamps > 0);
  rig.time.advance(500);
  const after = ticks(rig.native).slice(-10);
  assert.ok(after.every((entry) => entry.ts !== undefined));
  for (const gap of gaps(after)) assert.ok(Math.abs(gap - 25) < 0.01, `tick spacing ${gap}`);
  assert.equal(starts(rig.native).length, 1, 'the run goes on: no second Start');
});

test('stop() after the Start was reached gives one Stop at once, with no timestamp, and no tick after it', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.ok(rig.time.perfNow() >= starts(rig.native)[0].ts, 'the Start was reached');
  pageStop(rig);
  assert.equal(stops(rig.native).length, 1);
  const last = rig.native.sent.at(-1);
  assert.deepEqual(last.data, [0xfc]);
  assert.equal(last.argc, 1);
  const length = rig.native.sent.length;
  rig.time.advance(500);
  assert.equal(rig.native.sent.length, length, 'nothing is sent after the Stop');
  assert.equal(rig.clock.stats.stopsSent, 1);
});

test('stop() while the Start is queued but not reached gives one Stop timestamped after everything queued', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(60);
  const start = starts(rig.native)[0];
  assert.ok(start, 'the Start is queued');
  assert.ok(rig.time.perfNow() < start.ts, 'the Start is not reached');
  const queued = Math.max(...rig.native.sent.map((entry) => entry.ts));
  pageStop(rig);
  assert.equal(stops(rig.native).length, 1);
  const stop = stops(rig.native)[0];
  assert.equal(stop.argc, 2);
  assert.ok(Math.abs(stop.ts - (queued + CLOCK_START_LEAD_MS)) < 1e-9, `the Stop is at ${stop.ts}, the queue ends at ${queued}`);
});

test('stop() for a wanted port with no Start queued sends nothing', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.start();
  rig.time.advance(5);
  pageStop(rig);
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.clock.stats.stopsSent, 0);
});

test('a waiting port that leaves before its Start was queued gets no byte', () => {
  const rig = makeRig({ cps: 2 });
  rig.cyclist.start();
  rig.time.advance(100);
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  rig.time.advance(20);
  rig.clock.want([]);
  rig.time.advance(1500);
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.time.pendingTimers(), 0, 'the timer stops with the last port');
});

test('a quick Play after Stop begins with a fresh Start on a boundary, after the last queued message plus 0.5 ms', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(500);
  const queuedBeforeStop = Math.max(...rig.native.sent.map((entry) => entry.ts));
  pageStop(rig);
  const lengthAtStop = rig.native.sent.length;
  rig.time.advance(5);
  rig.env.playing = true;
  rig.cyclist.start();
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 2), 'a second Start was sent');
  const second = starts(rig.native)[1];
  assert.ok(second.ts >= queuedBeforeStop + CLOCK_START_LEAD_MS, `the Start is at ${second.ts}, the old queue ended at ${queuedBeforeStop}`);
  assert.ok(isIntegral(rig.cyclist.cycleAtPerf(second.ts + CLOCK_START_LEAD_MS)), 'the Start is on a boundary');
  const newMessages = rig.native.sent.slice(lengthAtStop);
  assert.deepEqual(newMessages[0].data, [0xfa], 'no tick of the new run comes before its Start');
});

for (const [name, close] of [
  ['the page is not playing', (rig) => { rig.env.playing = false; }],
  ['the scheduler is not started', (rig) => { rig.cyclist.stop(); }],
  ['the AudioContext is not there', (rig) => { rig.env.ctx = null; }],
  ['the AudioContext is stopped', (rig) => { rig.ctx.suspend(); }],
]) {
  test(`no byte goes out while ${name}`, () => {
    const rig = makeRig();
    rig.clock.want([A]);
    rig.cyclist.nowOverride = NEAR_CYCLE_0;
    rig.cyclist.start();
    close(rig);
    rig.time.advance(600);
    assert.equal(rig.native.sent.length, 0);
    assert.equal(rig.clock.stateOf('Port A'), 'none');
    assert.equal(rig.env.errors.length, 0);
  });
}

test('a scheduler found stopped while a port runs gives that port exactly one Stop, a net for a stop path the page did not take', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  rig.cyclist.stop();
  rig.time.advance(100);
  assert.equal(stops(rig.native).length, 1);
  assert.equal(stops(rig.native)[0].argc, 1);
  rig.time.advance(500);
  assert.equal(stops(rig.native).length, 1);
});

test('readCyclist names the field and the pinned version when the scheduler lacks one', () => {
  const time = makeFakeTime();
  const good = () => {
    const cyclist = makeFakeCyclist(time, { cps: 0.5 });
    cyclist.start();
    time.advance(10);
    return cyclist;
  };
  assert.equal(readCyclist(good()).cps, 0.5);
  const noCps = good();
  delete noCps.cps;
  assert.throws(() => readCyclist(noCps), /no numeric cps.*@strudel\/repl 1\.3\.0/);
  const noNow = good();
  noNow.now = 3;
  assert.throws(() => readCyclist(noNow), /no now\(\) function.*@strudel\/repl 1\.3\.0/);
  const noStarted = good();
  noStarted.started = 'yes';
  assert.throws(() => readCyclist(noStarted), /no boolean started.*@strudel\/repl 1\.3\.0/);
  for (const field of CYCLIST_FIELDS.filter((name) => name !== 'started' && name !== 'seconds_at_cps_change')) {
    const broken = good();
    broken[field] = 'x';
    assert.throws(() => readCyclist(broken), new RegExp(`numeric ${field}`));
  }
  assert.throws(() => readCyclist(null), /not available/);
});

test('seconds_at_cps_change may be undefined until the scheduler ticked, and is required once it did', () => {
  const time = makeFakeTime();
  const cyclist = makeFakeCyclist(time, { cps: 0.5 });
  cyclist.started = true;
  assert.equal(cyclist.num_ticks_since_cps_change, 0);
  assert.equal(cyclist.seconds_at_cps_change, undefined);
  assert.equal(readCyclist(cyclist), cyclist);
  cyclist.num_ticks_since_cps_change = 1;
  assert.throws(() => readCyclist(cyclist), /numeric seconds_at_cps_change/);
});

test('a scheduler without a field reaches onError exactly once, and the clock sends nothing and stops its timer', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(20);
  delete rig.cyclist.cps;
  rig.time.advance(500);
  assert.equal(rig.env.errors.length, 1);
  assert.match(rig.env.errors[0], /numeric cps.*@strudel\/repl 1\.3\.0/);
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.time.pendingTimers(), 0);
  assert.equal(rig.clock.stateOf('Port A'), 'none');
});

test('a port that joins mid-play reads waiting, gets its Start on the next boundary, then reads running; leaving sends one Stop at once', () => {
  const rig = makeRig({ cps: 2 });
  rig.cyclist.start();
  rig.time.advance(100);
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  assert.equal(rig.clock.stateOf('Port A'), 'waiting');
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 1));
  const start = starts(rig.native)[0];
  assert.ok(Math.abs(rig.cyclist.cycleAtPerf(start.ts + CLOCK_START_LEAD_MS) - 2) < 1e-6, 'the Start is on cycle 2');
  assert.equal(rig.clock.stateOf('Port A'), 'waiting', 'the Start is queued, not reached');
  assert.ok(advanceUntil(rig, () => rig.clock.stateOf('Port A') === 'running', 400));
  assert.deepEqual(rig.env.states, [['Port A', 'waiting'], ['Port A', 'running']]);
  rig.clock.want([]);
  assert.equal(stops(rig.native).length, 1);
  assert.equal(stops(rig.native)[0].argc, 1);
  assert.equal(rig.native.sent.at(-1).data[0], 0xfc);
  assert.equal(rig.clock.stateOf('Port A'), 'none');
  assert.deepEqual(rig.env.states.at(-1), ['Port A', 'none']);
});

test('want() with the same list sends nothing, and a second entry with the same port is ignored', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A, { port: 'Port A', id: 'other' }]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  const before = rig.native.sent.length;
  assert.equal(starts(rig.native).length, 1);
  rig.clock.want([A]);
  rig.clock.want([{ port: 'Port A', id: 'seq' }]);
  assert.equal(rig.native.sent.length, before, 'no byte at the call');
  rig.time.advance(100);
  assert.equal(starts(rig.native).length, 1);
  assert.equal(stops(rig.native).length, 0);
});

test('the native port vanishing while running makes no throw and no byte, and a new Start follows when it is back', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.equal(rig.clock.stateOf('Port A'), 'running');
  rig.env.gone.add('Port A');
  const length = rig.native.sent.length;
  rig.time.advance(200);
  assert.equal(rig.native.sent.length, length);
  assert.equal(rig.clock.stateOf('Port A'), 'none');
  rig.env.gone.delete('Port A');
  rig.cyclist.nowOverride = null;
  assert.equal(rig.clock.stateOf('Port A'), 'waiting');
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 2, 2000));
  assert.ok(isIntegral(rig.cyclist.cycleAtPerf(starts(rig.native)[1].ts + CLOCK_START_LEAD_MS)));
  assert.equal(rig.env.errors.length, 0);
});

test('an instrument that is not eligible reads waiting with no Start, and starts on the next boundary once it is', () => {
  const rig = makeRig({ cps: 2 });
  rig.env.held.add('seq');
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(600);
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.clock.stateOf('Port A'), 'waiting');
  assert.equal(rig.clock.holdsNotes('Port A'), false);
  rig.env.held.delete('seq');
  rig.cyclist.nowOverride = null;
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 1, 2000));
  assert.ok(isIntegral(rig.cyclist.cycleAtPerf(starts(rig.native)[0].ts + CLOCK_START_LEAD_MS)));
});

test('holdsNotes is true for a joining port until 50 ms before its Start, and never for a fresh run, a port not wanted or one not eligible', () => {
  const fresh = makeRig({ cps: 2 });
  fresh.clock.want([A]);
  fresh.cyclist.nowOverride = NEAR_CYCLE_0;
  fresh.cyclist.start();
  assert.equal(fresh.clock.holdsNotes('Port A'), false, 'a fresh run holds nothing');
  fresh.time.advance(300);
  assert.equal(fresh.clock.holdsNotes('Port A'), false);
  assert.equal(fresh.clock.holdsNotes('Port B'), false, 'a port that is not wanted holds nothing');

  const rig = makeRig({ cps: 2 });
  rig.cyclist.start();
  rig.time.advance(100);
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  assert.equal(rig.clock.holdsNotes('Port A'), true, 'a joining port holds while no Start is queued');
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 1));
  const startAt = starts(rig.native)[0].ts;
  rig.time.advance(Math.floor(startAt - CLOCK_NOTE_LEAD_MS - 10 - rig.time.perfNow()));
  assert.equal(rig.clock.holdsNotes('Port A'), true);
  rig.time.advance(20);
  assert.equal(rig.clock.holdsNotes('Port A'), false, 'the hold ends 50 ms before the Start');
  rig.env.held.add('seq');
  assert.equal(rig.clock.holdsNotes('Port A'), false, 'a port that is not eligible holds nothing');
});

test('onState is called once per change, never once per tick', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(2000);
  assert.ok(ticks(rig.native).length > 100);
  assert.deepEqual(rig.env.states, [['Port A', 'running']]);
});

test('a native send that throws reaches onError once, reads none, and never throws out of the loop', () => {
  const rig = makeRig({ cps: 2 });
  rig.native.failing = true;
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(400);
  assert.equal(rig.env.errors.length, 1);
  assert.match(rig.env.errors[0], /Port A/);
  assert.equal(rig.clock.stateOf('Port A'), 'none');
  assert.equal(rig.native.sent.length, 0);
  rig.native.failing = false;
  rig.cyclist.nowOverride = null;
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 1, 2000), 'the port gets its Start once sends work again');
  assert.equal(rig.env.errors.length, 1);
});

test('ticks are queued at most 150 ms ahead of the moment they are sent', () => {
  const rig = makeRig();
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1500);
  const timestamped = rig.native.sent.filter((entry) => entry.ts !== undefined);
  assert.ok(timestamped.length > 30);
  for (const entry of timestamped) assert.ok(entry.ts - entry.at <= CLOCK_HORIZON_MS + 1e-6, `queued ${entry.ts - entry.at} ms ahead`);
});

test('two ports each get their own Start, and one leaving leaves the other untouched', () => {
  const rig = makeRig({ cps: 2, ports: ['Port A', 'Port B'] });
  const other = rig.natives.get('Port B');
  rig.clock.want([A, B]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.equal(starts(rig.native).length, 1);
  assert.equal(starts(other).length, 1);
  const startsAtLeave = starts(rig.native).length;
  rig.clock.want([A]);
  assert.equal(stops(other).length, 1);
  assert.equal(stops(rig.native).length, 0);
  rig.time.advance(300);
  assert.equal(starts(rig.native).length, startsAtLeave);
  assert.equal(other.sent.at(-1).data[0], 0xfc, 'nothing follows the Stop on the port that left');
});

test('a tempo below zero from the start sends nothing, never loops, and reports once', () => {
  const rig = makeRig({ cps: -0.5 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(500);
  assert.equal(rig.native.sent.length, 0);
  assert.equal(rig.env.errors.length, 1);
  assert.match(rig.env.causes[0], /usable tempo/);
  assert.doesNotMatch(rig.env.causes[0], /pins @strudel/);
  assert.equal(rig.time.pendingTimers(), 1, 'the clock keeps its timer, so a good tempo brings it back');
});

test('a tempo that turns negative or zero mid-run stops the followers with one Stop, and a good tempo starts a new run', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.equal(starts(rig.native).length, 1);
  rig.cyclist.nowOverride = null;
  for (const bad of [-2, 0]) {
    rig.cyclist.setCps(bad);
    rig.time.advance(300);
  }
  assert.equal(stops(rig.native).length, 1);
  const sentWhileBad = rig.native.sent.length;
  rig.time.advance(300);
  assert.equal(rig.native.sent.length, sentWhileBad, 'nothing goes out while the tempo is not usable');
  rig.cyclist.setCps(2);
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 2, 3000), 'a new Start follows');
  assert.equal(rig.native.sent.map((entry) => entry.data[0]).filter((byte) => byte === 0xfc).length, 1);
});

test('a tempo too fast to follow sends nothing, reports once, and stays quiet however long it lasts', () => {
  const rig = makeRig({ cps: 1000 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(100);
  assert.equal(rig.env.errors.length, 1);
  assert.match(rig.env.causes[0], /usable tempo/);
  assert.match(rig.env.causes[0], /cps\) is 1000, too fast/);
  const sentAt100 = rig.native.sent.length;
  rig.time.advance(1000);
  assert.equal(rig.native.sent.length, sentAt100, 'the sends stop growing');
  assert.equal(sentAt100, 0);
  assert.equal(rig.env.errors.length, 1);
  assert.equal(rig.time.pendingTimers(), 1, 'the clock keeps its timer, so a playable tempo brings it back');
});

test('a tempo that turns too fast mid-run stops the followers with one Stop, and a playable tempo starts a new run', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.equal(starts(rig.native).length, 1);
  rig.cyclist.nowOverride = null;
  rig.cyclist.setCps(1000);
  rig.time.advance(300);
  assert.equal(stops(rig.native).length, 1);
  const sentWhileFast = rig.native.sent.length;
  rig.time.advance(1000);
  assert.equal(rig.native.sent.length, sentWhileFast, 'the sends stop growing');
  assert.equal(rig.env.errors.length, 1);
  rig.cyclist.setCps(2);
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 2, 3000), 'a new Start follows');
});

test('the fastest playable tempo is followed within the tick cap, with no report', () => {
  const rig = makeRig({ cps: 13 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  assert.equal(starts(rig.native).length, 1);
  assert.ok(ticks(rig.native).length > 500);
  assert.equal(rig.env.errors.length, 0);
});

test('a long main-thread stall is caught up in chunks under the tick cap, with no tempo report and no lost tick', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  rig.cyclist.nowOverride = null;
  const before = ticks(rig.native).length;
  // 4 s with no pass: at 2 cps that is about 770 ticks late, several times the cap.
  rig.env.stallMs = 4000;
  rig.time.advance(4010);
  rig.time.advance(300);
  assert.equal(rig.env.errors.length, 0);
  assert.ok(rig.clock.stats.late > CLOCK_MAX_TICKS_PER_PASS, `${rig.clock.stats.late} late ticks`);
  assert.equal(starts(rig.native).length, 1);
  assert.equal(stops(rig.native).length, 0);
  // Every tick of the stall went out: the follower's count stays right.
  const elapsedCycles = (4010 + 300) / 1000 * 2;
  assert.ok(ticks(rig.native).length - before >= (elapsedCycles - 0.2) * CLOCK_TICKS_PER_CYCLE, `${ticks(rig.native).length - before} ticks`);
  const stamped = gaps(ticks(rig.native));
  for (const gap of stamped.slice(-20)) assert.ok(Math.abs(gap - nominalMs(2)) < 0.01, `tick spacing ${gap}`);
});

test('a tempo of NaN is not a Strudel mismatch: it is reported by its value, the clock is not disabled, and the next Play brings it back', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  rig.cyclist.nowOverride = null;
  rig.cyclist.setCps(Number.NaN);
  rig.time.advance(300);
  assert.equal(rig.env.errors.length, 1);
  assert.match(rig.env.causes[0], /cps is NaN/);
  assert.doesNotMatch(rig.env.causes[0], /pins @strudel/);
  assert.equal(rig.time.pendingTimers(), 1, 'the timer keeps running');
  // A NaN tempo also poisons the scheduler's own position until it restarts; the next Play brings the clock back.
  pageStop(rig);
  rig.cyclist.setCps(2);
  rig.env.playing = true;
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 2, 3000), 'the clock sends a new Start');
  assert.equal(rig.env.errors.length, 1);
});

test('readCyclist accepts a NaN or negative number and rejects a field of the wrong type', () => {
  const time = makeFakeTime();
  const cyclist = makeFakeCyclist(time, { cps: 0.5 });
  cyclist.cps = Number.NaN;
  assert.equal(readCyclist(cyclist), cyclist);
  cyclist.cps = -1;
  assert.equal(readCyclist(cyclist), cyclist);
  cyclist.cps = undefined;
  assert.throws(() => readCyclist(cyclist), /no numeric cps/);
});

/** A run of Port A at 120 bpm whose send starts to throw after its Start; returns once the failure was reported. */
function runWithFailingTicks() {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(400);
  rig.cyclist.nowOverride = null;
  assert.equal(starts(rig.native).length, 1);
  rig.native.failing = true;
  assert.ok(advanceUntil(rig, () => rig.env.errors.length === 1, 1000), 'the failure was reported');
  rig.native.failing = false;
  return rig;
}

test('a tick send that throws after the Start leaves one Stop owed: a page Stop before the next pass still sends it', () => {
  const rig = runWithFailingTicks();
  const before = stops(rig.native).length;
  pageStop(rig);
  assert.equal(stops(rig.native).length, before + 1, 'one Stop for the follower that was started');
  assert.equal(rig.native.sent.at(-1).data[0], 0xfc);
  rig.clock.stop();
  assert.equal(stops(rig.native).length, before + 1, 'and only one');
});

test('a tick send that throws after the Start puts a Stop between the old Start and the next one', () => {
  const rig = runWithFailingTicks();
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 2, 4000), 'a new Start follows');
  const bytes = rig.native.sent.map((entry) => entry.data[0]).filter((byte) => byte === 0xfa || byte === 0xfc);
  assert.deepEqual(bytes, [0xfa, 0xfc, 0xfa]);
  const stopAt = stops(rig.native)[0];
  const newStart = starts(rig.native)[1];
  assert.ok(stopAt.argc === 1 || stopAt.ts < newStart.ts, 'the Stop is not after the new Start');
});

test('the hold on a joining instrument\'s notes ends after its budget when the Start cannot be planned, with one report', () => {
  const rig = makeRig({ cps: 2 });
  rig.cyclist.start();
  rig.time.advance(100);
  // The output timestamp never gets valid: no alignment, so no Start can be timed.
  rig.ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  assert.equal(rig.clock.stateOf('Port A'), 'waiting');
  rig.time.advance(CLOCK_HOLD_BUDGET_MS - 500);
  assert.equal(rig.clock.holdsNotes('Port A'), true, 'still within the budget');
  assert.equal(rig.env.errors.length, 0);
  rig.time.advance(1000);
  assert.equal(rig.clock.holdsNotes('Port A'), false, 'the notes pass');
  assert.equal(rig.env.errors.length, 1);
  assert.match(rig.env.causes[0], /not planned/);
  rig.time.advance(2000);
  assert.equal(rig.env.errors.length, 1, 'reported once');
  assert.equal(rig.native.sent.length, 0);
});

test('a hold that ends because the Start is queued in time never raises the budget error', () => {
  const rig = makeRig({ cps: 2 });
  rig.cyclist.start();
  rig.time.advance(100);
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  rig.time.advance(CLOCK_HOLD_BUDGET_MS + 1000);
  assert.equal(starts(rig.native).length >= 1, true);
  assert.equal(rig.env.errors.length, 0);
});

// --- stamp(audioTime): the clock's own mapping, for the timestamps of Strudel's notes ---

test('stamp gives the timestamp of the tick sent for a cycle position (one mapping), within 0.01 ms', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1500);
  const sent = ticks(rig.native);
  assert.ok(sent.length > 30);
  // The cyclist is anchored by now: soundTime(c) is the audio time the Cyclist gives a hap at cycle position c.
  for (const tick of sent.slice(-8)) {
    const c = Math.round(rig.cyclist.cycleAtPerf(tick.ts) * CLOCK_TICKS_PER_CYCLE) / CLOCK_TICKS_PER_CYCLE;
    const stamped = rig.clock.stamp(rig.cyclist.soundTime(c));
    assert.ok(Math.abs(stamped - tick.ts) < 0.01, `stamp ${stamped} against tick ${tick.ts} for cycle ${c}`);
  }
  assert.equal(rig.env.errors.length, 0);
});

test('stamp is null before the page alignment is warm, for an audio time that is not a number, and while the context is stopped', () => {
  const rig = makeRig({ cps: 2 });
  assert.equal(rig.clock.stamp(rig.ctx.currentTime + 0.2), null, 'the first call is part of the warm-up');
  for (const bad of [undefined, null, '1', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(rig.clock.stamp(bad), null);
  // Five distinct pairs, 10 ms apart, warm the alignment even with no instrument wanted.
  let stamped = null;
  for (let step = 0; step < 8 && stamped === null; step++) {
    rig.time.advance(10);
    stamped = rig.clock.stamp(rig.ctx.currentTime + 0.2);
  }
  assert.equal(typeof stamped, 'number');
  assert.ok(Math.abs(rig.alignment.ms - 7) < 1e-6);
  rig.ctx.suspend();
  assert.equal(rig.clock.stamp(rig.ctx.currentTime + 0.2), null, 'a context that does not run gives none');
  assert.equal(rig.env.errors.length, 0);
});

test('holdsNotes(port, at) compares a stamped note with the Start: it holds while no Start is queued, and passes from 1 ms before the Start', () => {
  const rig = makeRig({ cps: 2 });
  rig.cyclist.start();
  rig.time.advance(100);
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  const now = rig.time.perfNow();
  assert.equal(rig.clock.holdsNotes('Port A', now + 5000), true, 'no Start queued: a stamped note waits too');
  assert.ok(advanceUntil(rig, () => starts(rig.native).length === 1));
  const startAt = starts(rig.native)[0].ts;
  assert.ok(startAt - rig.time.perfNow() > CLOCK_NOTE_LEAD_MS, 'the Start is further than the lead away');
  assert.equal(rig.clock.holdsNotes('Port A', startAt + CLOCK_START_LEAD_MS), false, 'the note of the Start tick passes');
  assert.equal(rig.clock.holdsNotes('Port A', startAt - CLOCK_STAMPED_NOTE_SLACK_MS), false, 'it passes from the slack before the Start');
  assert.equal(rig.clock.holdsNotes('Port A', startAt - CLOCK_STAMPED_NOTE_SLACK_MS - 0.1), true, 'a note before that waits');
  assert.equal(rig.clock.holdsNotes('Port A', startAt - 25), true, 'a note one tick before waits');
  assert.equal(rig.clock.holdsNotes('Port A'), true, 'without a timestamp the 50 ms rule applies, as before');
  assert.equal(rig.clock.holdsNotes('Port A', Number.NaN), true, 'a time that is not a number is no timestamp');
  rig.time.advance(Math.ceil(startAt - CLOCK_NOTE_LEAD_MS - rig.time.perfNow()) + 1);
  assert.equal(rig.clock.holdsNotes('Port A'), false);
  assert.equal(rig.clock.holdsNotes('Port B', startAt - 25), false, 'a port that is not wanted holds nothing');
});

test('a stamped note that runs before the clock pass of its own downbeat plans the Start itself and passes, so the joining instrument keeps its first note', () => {
  const rig = makeRig({ cps: 2, alignment: { ms: 7 } });
  rig.cyclist.start();
  rig.time.advance(100);
  rig.cyclist.nowOverride = 1.52;
  rig.clock.want([A]);
  // The main thread is blocked: the pass after the first one does not come in this test.
  rig.env.stallMs = 100000;
  rig.time.advance(10);
  const downbeat = rig.clock.stamp(rig.cyclist.soundTime(2));
  assert.equal(typeof downbeat, 'number');
  // The note of the downbeat leaves 120 ms before its timestamp; the pass that plans the Start has not run.
  rig.time.advance(Math.floor(downbeat - 120 - rig.time.perfNow()));
  assert.equal(starts(rig.native).length, 0, 'no Start is planned: the pass is late');
  assert.equal(rig.clock.holdsNotes('Port A', downbeat - 25), true, 'a note one tick before the downbeat waits');
  assert.equal(rig.clock.holdsNotes('Port A', downbeat), false, 'the note of the downbeat passes');
  assert.equal(starts(rig.native).length, 1, 'its Start was planned by the note itself');
  assert.ok(Math.abs(starts(rig.native)[0].ts - (downbeat - CLOCK_START_LEAD_MS)) < 1e-6, 'a Start 0.5 ms before the downbeat');
  assert.equal(rig.clock.holdsNotes('Port A', downbeat - 25), true, 'the earlier note still waits for the Start');
  assert.equal(rig.clock.holdsNotes('Port A', downbeat + 50), false, 'and a later note passes');
  assert.equal(starts(rig.native).length, 1, 'one Start only');
  assert.equal(rig.env.errors.length, 0);
});

test('a stamped note beyond the clock horizon, or with the scheduler stopped, plans nothing', () => {
  const far = makeRig({ cps: 2, alignment: { ms: 7 } });
  far.cyclist.start();
  far.time.advance(100);
  far.cyclist.nowOverride = 1.52;
  far.clock.want([A]);
  far.env.stallMs = 100000;
  far.time.advance(10);
  assert.equal(far.clock.holdsNotes('Port A', far.time.perfNow() + CLOCK_HORIZON_MS + 50), true, 'a note beyond the horizon waits');
  assert.equal(starts(far.native).length, 0);
  const stopped = makeRig({ cps: 2, alignment: { ms: 7 } });
  stopped.cyclist.start();
  stopped.time.advance(100);
  stopped.cyclist.nowOverride = 1.52;
  stopped.clock.want([A]);
  stopped.env.stallMs = 100000;
  stopped.time.advance(10);
  const at = stopped.time.perfNow() + 100;
  stopped.cyclist.stop();
  assert.equal(stopped.clock.holdsNotes('Port A', at), false, 'a stopped scheduler: the run is not waiting, nothing holds');
  assert.equal(starts(stopped.native).length, 0);
  assert.equal(stopped.env.errors.length, 0);
});

// --- stampOfCycle(cycle): the timestamp of a cycle line, for the setup of a change that waits for it ---

test('stampOfCycle equals stamp of the audio time of that cycle by the clock\'s own segments, with no instrument wanted', () => {
  const rig = makeRig({ cps: 2 });
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  // Warm the page-wide alignment (five distinct pairs) without any clock pass: nothing is wanted.
  for (let step = 0; step < 8; step++) {
    rig.time.advance(10);
    rig.clock.stamp(rig.ctx.currentTime + 0.2);
  }
  rig.time.advance(400);
  for (const cycle of [3, 4, 7.25]) {
    const expected = rig.clock.stamp(rig.cyclist.soundTime(cycle));
    const given = rig.clock.stampOfCycle(cycle);
    assert.equal(typeof given, 'number');
    assert.ok(Math.abs(given - expected) < 0.01, `cycle ${cycle}: ${given} against ${expected}`);
  }
  assert.equal(rig.env.errors.length, 0);
});

test('stampOfCycle gives the same timestamp as the tick sent for that cycle position, within 0.01 ms', () => {
  const rig = makeRig({ cps: 2 });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1500);
  for (const tick of ticks(rig.native).slice(-6)) {
    const c = Math.round(rig.cyclist.cycleAtPerf(tick.ts) * CLOCK_TICKS_PER_CYCLE) / CLOCK_TICKS_PER_CYCLE;
    assert.ok(Math.abs(rig.clock.stampOfCycle(c) - tick.ts) < 0.01, `cycle ${c}`);
  }
  assert.equal(rig.env.errors.length, 0);
});

test('stampOfCycle works a line behind a tempo ramp out through the ramp, and with early takes the ramp lag off', () => {
  const asked = [];
  const rig = makeRig({
    cps: 2,
    rampSeconds: (from, to) => {
      asked.push([from, to]);
      return { seconds: (to - from) / 2.5, lagSeconds: 0.004 };
    },
  });
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  for (let step = 0; step < 8; step++) {
    rig.time.advance(10);
    rig.clock.stamp(rig.ctx.currentTime + 0.2);
  }
  rig.time.advance(400);
  const cycle = 7;
  // The one-segment line is at 2 cycles per second; the ramp says 2.5 cycles per second for the same span.
  const oneSegment = rig.clock.stamp(rig.cyclist.soundTime(cycle));
  const through = rig.clock.stampOfCycle(cycle);
  const early = rig.clock.stampOfCycle(cycle, { early: true });
  assert.ok(asked.length >= 1 && asked.every(([from, to]) => from < to && to === cycle), JSON.stringify(asked));
  const segmentStart = asked[0][0];
  assert.ok(Math.abs(oneSegment - through - (((cycle - segmentStart) / 2 - (cycle - segmentStart) / 2.5) * 1000)) < 0.05, `${oneSegment} against ${through}`);
  assert.ok(Math.abs(through - early - 4) < 0.01, `early is the lag (4 ms) before the line: ${through} against ${early}`);
  assert.equal(rig.env.errors.length, 0);
});

test('stampOfCycle ignores a ramp that says it does not run, and does not ask it about a line at or before the latest segment', () => {
  let asked = 0;
  const rig = makeRig({ cps: 2, rampSeconds: () => (asked++, null) });
  const plain = makeRig({ cps: 2 });
  for (const r of [rig, plain]) {
    r.cyclist.nowOverride = NEAR_CYCLE_0;
    r.cyclist.start();
    for (let step = 0; step < 8; step++) {
      r.time.advance(10);
      r.clock.stamp(r.ctx.currentTime + 0.2);
    }
    r.time.advance(400);
  }
  for (const cycle of [3, 7.25]) {
    assert.equal(rig.clock.stampOfCycle(cycle, { early: true }), plain.clock.stampOfCycle(cycle));
  }
  assert.ok(asked >= 1);
  const before = asked;
  rig.clock.stampOfCycle(-5);
  assert.equal(asked, before, 'a line before the first segment starts is worked out by the segment alone');
});

test('stampOfCycle is null before the clock is warm, for a cycle that is not a finite number, when the scheduler does not run and when the context does not run; it never throws', () => {
  const rig = makeRig({ cps: 2 });
  assert.equal(rig.clock.stampOfCycle(4), null, 'the scheduler has not started');
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(100);
  // The scheduler runs and has a tempo segment, but the alignment is still warming up on this first call.
  assert.equal(rig.clock.stampOfCycle(4), null, 'the first call is part of the warm-up');
  for (const bad of [undefined, null, '4', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(rig.clock.stampOfCycle(bad), null);
  for (let step = 0; step < 8; step++) {
    rig.time.advance(10);
    rig.clock.stampOfCycle(4);
  }
  assert.equal(typeof rig.clock.stampOfCycle(4), 'number');
  rig.ctx.suspend();
  assert.equal(rig.clock.stampOfCycle(4), null, 'a context that does not run gives none');
  const broken = createPageClock({
    getScheduler: () => null,
    getAudioContext: () => rig.ctx,
    perfNow: rig.time.perfNow,
    setTimer: rig.time.setTimer,
    clearTimer: rig.time.clearTimer,
    isPlaying: () => true,
    resolveNative: () => null,
    onError: () => {},
    alignment: { ms: 7 },
  });
  assert.equal(broken.stampOfCycle(4), null, 'a scheduler that cannot be read gives none');
});

// --- The clock under about 20 small tempo steps ---

/**
 * Plays 20 one-BPM steps from 100 to 120 BPM, `spacingMs` apart, on a fake scheduler, and returns what the clock sent. The
 * scheduler's real anchors are recorded as they are taken, so the expected time of any cycle position is worked out from the
 * whole history (the clock itself only keeps its latest tempo segments).
 */
function tempoStepRun(spacingMs) {
  const rig = makeRig({ cps: 100 / 4 / 60 });
  const anchors = [];
  rig.time.onStep(() => {
    const scheduler = rig.cyclist;
    if (scheduler.num_ticks_since_cps_change === 0) return;
    const last = anchors.at(-1);
    if (last === undefined || last.c !== scheduler.num_cycles_at_cps_change || last.cps !== scheduler.cps) {
      anchors.push({ c: scheduler.num_cycles_at_cps_change, s: scheduler.seconds_at_cps_change, cps: scheduler.cps });
    }
  });
  rig.clock.want([A]);
  rig.cyclist.nowOverride = NEAR_CYCLE_0;
  rig.cyclist.start();
  rig.time.advance(1000);
  for (let step = 1; step <= 20; step++) {
    rig.cyclist.setCps((100 + step) / 4 / 60);
    rig.time.advance(spacingMs);
  }
  rig.time.advance(6000);
  const audioOfCycle = (cycle) => {
    let anchor = anchors[0];
    for (const candidate of anchors) if (candidate.c <= cycle) anchor = candidate;
    return (cycle - anchor.c) / anchor.cps + anchor.s + rig.cyclist.latency;
  };
  return { rig, anchors, audioOfCycle };
}

test('about 20 tempo steps at 50, 75 and 100 ms leave no hole and no doubled tick, and every cycle holds 96 ticks', () => {
  for (const spacingMs of [50, 75, 100]) {
    const { rig, anchors, audioOfCycle } = tempoStepRun(spacingMs);
    const sent = ticks(rig.native);
    const stamps = sent.map((entry) => entry.ts);
    assert.ok(anchors.length >= 10, `${spacingMs} ms: the scheduler took over most of the steps (${anchors.length} anchors)`);
    assert.equal(starts(rig.native).length, 1, `${spacingMs} ms: one Start`);
    assert.deepEqual(rig.env.errors, [], `${spacingMs} ms: the clock reported nothing`);
    // The first tick is on a cycle boundary; every later tick sits where its cycle position is heard.
    const first = anchors[0];
    const firstCycle = first.c + (rig.time.audioOfStrudelPerf(stamps[0]) - rig.cyclist.latency - first.s) * first.cps;
    assert.ok(isIntegral(firstCycle), `${spacingMs} ms: the first tick is on cycle ${firstCycle}`);
    const heardAt = (tick) => rig.time.strudelPerf(audioOfCycle(Math.round(firstCycle) + tick / CLOCK_TICKS_PER_CYCLE));
    stamps.forEach((stamp, tick) => assert.ok(Math.abs(stamp - heardAt(tick)) < 0.05, `${spacingMs} ms: tick ${tick} is ${stamp - heardAt(tick)} ms from where it is heard`));
    // No hole and no doubled tick: no interval above one tick at 100 BPM, none below half a tick at 120 BPM.
    const intervals = gaps(sent);
    assert.ok(intervals.length > 300, `${spacingMs} ms: ${intervals.length} intervals`);
    for (const gap of intervals) {
      assert.ok(gap <= nominalMs(100 / 4 / 60) + 0.01, `${spacingMs} ms: a hole of ${gap} ms`);
      assert.ok(gap >= nominalMs(120 / 4 / 60) / 2, `${spacingMs} ms: a doubled tick, ${gap} ms`);
    }
    // 96 ticks from one cycle line to the next, for every whole cycle that was sent.
    const wholeCycles = Math.floor(stamps.length / CLOCK_TICKS_PER_CYCLE) - 1;
    assert.ok(wholeCycles >= 2, `${spacingMs} ms: ${wholeCycles} whole cycles`);
    for (let cycle = 0; cycle < wholeCycles; cycle++) {
      const from = rig.time.strudelPerf(audioOfCycle(Math.round(firstCycle) + cycle)) - 0.05;
      const to = rig.time.strudelPerf(audioOfCycle(Math.round(firstCycle) + cycle + 1)) - 0.05;
      assert.equal(stamps.filter((stamp) => stamp >= from && stamp < to).length, CLOCK_TICKS_PER_CYCLE, `${spacingMs} ms: ticks in cycle ${cycle}`);
    }
  }
});
