// Unit tests for page/mixer-gesture.js: the throttle, the pause, the record and the flush rules
// that make one drag one history version. The environment is fake: `enqueue` pushes jobs into a
// queue the test drains in order (the page's serial chain), timers run on a manual clock, and
// `applyNow` is a stub returning a scripted `{ played, code }`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THROTTLE_MS, PAUSE_MS, createGestureRecorder } from '../page/mixer-gesture.js';

function setup({ played = true } = {}) {
  let clock = 0;
  const hold = { held: false };
  const timers = new Map();
  let nextTimer = 1;
  const queue = [];
  const applied = [];
  const records = [];
  const dropped = [];
  const env = {
    // The scripted result of the next applyNow calls; a function may decide per change.
    play: (change) => (played ? { played: true, code: `code:${change.value}` } : { played: false, code: 'unchanged' }),
  };
  const recorder = createGestureRecorder({
    enqueue: (fn) => {
      const job = { fn };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      queue.push(job);
      return job.promise;
    },
    applyNow: async (change) => {
      applied.push(change.value);
      return env.play(change);
    },
    sendRecord: (code, label) => records.push({ code, label }),
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => clock,
    // The page puts the instrument back to what the playing code holds when this is called.
    onPreviewDropped: () => dropped.push(clock),
    isHeld: () => hold.held,
  });
  /** Runs every queued job in order, including jobs queued while draining. */
  async function drain() {
    while (queue.length > 0) {
      const job = queue.shift();
      try {
        job.resolve(await job.fn());
      } catch (err) {
        job.reject(err);
      }
    }
  }
  /** Moves the clock forward, firing due timers in time order. */
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of timers) {
        if (timer.at <= end && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const { fn } = timers.get(dueId);
      timers.delete(dueId);
      clock = dueAt;
      fn();
    }
    clock = end;
  }
  return { recorder, queue, applied, records, dropped, hold, env, drain, advance, timers, setClock: (t) => (clock = t), get clock() { return clock; } };
}

const change = (value, identity = 'label:drums') => ({ identity, type: 'gain', value });
const label = (value, name = 'drums') => `mixer: ${name} volume ${value}`;

test('the constants are 100 ms and 1.5 s', () => {
  assert.equal(THROTTLE_MS, 100);
  assert.equal(PAUSE_MS, 1500);
});

test('the first move ticks at once', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  assert.equal(t.queue.length, 1);
  await t.drain();
  assert.deepEqual(t.applied, [0.1]);
  assert.deepEqual(t.records, []);
});

test('moves inside 100 ms coalesce into one trailing tick that carries the newest change', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.advance(20);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  t.advance(20);
  t.recorder.move('drums|fader', change(0.3), label(0.3));
  await t.drain();
  assert.deepEqual(t.applied, [0.1]);
  t.advance(70);
  await t.drain();
  assert.deepEqual(t.applied, [0.1, 0.3]);
  // A move at least 100 ms after the last tick ticks at once.
  t.advance(150);
  t.recorder.move('drums|fader', change(0.4), label(0.4));
  await t.drain();
  assert.deepEqual(t.applied, [0.1, 0.3, 0.4]);
});

test('release ticks at once and cancels the trailing tick', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.advance(10);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  t.advance(10);
  t.recorder.release('drums|fader', change(0.3), label(0.3));
  await t.drain();
  assert.deepEqual(t.applied, [0.1, 0.3]);
  t.advance(200);
  await t.drain();
  assert.deepEqual(t.applied, [0.1, 0.3], 'the cancelled trailing change never applies');
});

test('the record is sent once, 1.5 s after the last move, with the latest label and the last played code', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.advance(150);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  t.advance(150);
  t.recorder.release('drums|fader', change(0.3), label(0.3));
  await t.drain();
  t.advance(1499);
  await t.drain();
  assert.deepEqual(t.records, []);
  t.advance(1);
  await t.drain();
  assert.deepEqual(t.records, [{ code: 'code:0.3', label: label(0.3) }]);
  t.advance(5000);
  await t.drain();
  assert.equal(t.records.length, 1, 'never a second record for the same gesture');
});

test('each move restarts the pause', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  await t.drain();
  t.advance(1400);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  await t.drain();
  t.advance(1400);
  await t.drain();
  assert.deepEqual(t.records, [], 'the pause restarted with the second move');
  t.advance(100);
  await t.drain();
  assert.equal(t.records.length, 1);
  assert.equal(t.records[0].code, 'code:0.2');
});

test('a move on another control records the first gesture before the second one\'s first tick', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.advance(30);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  // The second control: the first gesture is flushed (its trailing 0.2 applies, then its record).
  t.recorder.move('hats|fader', change(0.5, 'label:hats'), label(0.5, 'hats'));
  await t.drain();
  assert.deepEqual(t.applied, [0.1, 0.2, 0.5]);
  assert.deepEqual(t.records, [{ code: 'code:0.2', label: label(0.2) }]);
  t.advance(1500);
  await t.drain();
  assert.deepEqual(t.records.map((r) => r.label), [label(0.2), label(0.5, 'hats')]);
});

test('discrete records the pending gesture first, then applies and records at once', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.recorder.discrete(change(0.9, 'label:hats'), 'mixer: hats muted');
  await t.drain();
  assert.deepEqual(t.applied, [0.1, 0.9]);
  assert.deepEqual(t.records, [
    { code: 'code:0.1', label: label(0.1) },
    { code: 'code:0.9', label: 'mixer: hats muted' },
  ]);
  t.advance(5000);
  await t.drain();
  assert.equal(t.records.length, 2);
});

test('a discrete change that did not play records nothing', async () => {
  const t = setup({ played: false });
  t.recorder.discrete(change(0.9), 'mixer: drums muted');
  await t.drain();
  assert.deepEqual(t.records, []);
});

test('a tick that did not play leaves the earlier played code and its label as the ones to record', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  await t.drain();
  t.env.play = () => ({ played: false, code: 'unchanged' });
  t.advance(150);
  t.recorder.release('drums|fader', change(0.2), label(0.2));
  await t.drain();
  t.env.play = () => null;
  t.advance(1500);
  await t.drain();
  assert.deepEqual(t.records, [{ code: 'code:0.1', label: label(0.1) }], 'the label matches the code that played');
});

test('a gesture that never played records nothing', async () => {
  const t = setup({ played: false });
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.recorder.release('drums|fader', change(0.2), label(0.2));
  await t.drain();
  t.advance(3000);
  await t.drain();
  assert.deepEqual(t.records, []);
  assert.equal(t.recorder.hasPending(), false);
});

test('flushing twice sends one record', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  const first = t.recorder.flush();
  const second = t.recorder.flush();
  await t.drain();
  await Promise.all([first, second]);
  assert.equal(t.records.length, 1);
  t.advance(3000);
  await t.drain();
  assert.equal(t.records.length, 1);
});

test('hasPending is true while a gesture is open or waiting for its record job', async () => {
  const t = setup();
  assert.equal(t.recorder.hasPending(), false);
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  assert.equal(t.recorder.hasPending(), true);
  void t.recorder.flush();
  assert.equal(t.recorder.hasPending(), true, 'the record job has not run yet');
  await t.drain();
  assert.equal(t.recorder.hasPending(), false);
});

test('flushDirect applies the trailing change directly, records, and drops ticks queued behind', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  t.advance(30);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  // Claude's evaluate is a queued job running ahead of the gesture's own tick job: run the queued
  // tick for 0.1 first, then flushDirect from "inside" the current job, before the rest.
  t.recorder.release('drums|fader', change(0.25), label(0.25));
  const first = t.queue.shift();
  await first.fn();
  assert.deepEqual(t.applied, [0.1]);
  // Now flushDirect runs inside another job while a release tick (0.25) is still queued.
  await t.recorder.flushDirect();
  assert.deepEqual(t.records, [{ code: 'code:0.1', label: label(0.1) }], 'recorded with the code that played');
  await t.drain();
  assert.deepEqual(t.applied, [0.1], 'the queued release tick did nothing after the drop');
  t.advance(5000);
  await t.drain();
  assert.equal(t.records.length, 1);
});

test('flushDirect applies an open gesture\'s trailing change before recording', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  await t.drain();
  t.advance(30);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  await t.recorder.flushDirect();
  assert.deepEqual(t.applied, [0.1, 0.2]);
  assert.deepEqual(t.records, [{ code: 'code:0.2', label: label(0.2) }]);
  t.advance(5000);
  await t.drain();
  assert.equal(t.records.length, 1);
});

test('flushDirect also records a gesture whose record job is queued but not run, and that job then sends nothing', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  await t.drain();
  void t.recorder.flush();
  assert.equal(t.queue.length, 1, 'the record job is queued');
  await t.recorder.flushDirect();
  assert.deepEqual(t.records, [{ code: 'code:0.1', label: label(0.1) }]);
  await t.drain();
  assert.equal(t.records.length, 1, 'the queued record job sent nothing more');
});

test('flushDirect contains a change that throws: it reports it, still records, and lets the caller go on', async () => {
  const errors = [];
  let clock = 0;
  const records = [];
  let fail = false;
  const recorder = createGestureRecorder({
    enqueue: async (fn) => fn(),
    applyNow: async (change) => {
      if (fail) throw new Error('boom');
      return { played: true, code: `code:${change.value}` };
    },
    sendRecord: (code, label) => records.push({ code, label }),
    setTimer: () => 1,
    clearTimer: () => {},
    now: () => clock,
    onError: (error) => errors.push(error.message),
  });
  recorder.move('drums|fader', change(0.1), label(0.1));
  await Promise.resolve();
  clock = 30;
  recorder.move('drums|fader', change(0.2), label(0.2));
  fail = true;
  await recorder.flushDirect();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(records, [{ code: 'code:0.1', label: label(0.1) }], 'the gesture is still recorded with the code that played');
  assert.equal(recorder.hasPending(), false);
});

test('flushNow records at once without applying the trailing change', async () => {
  const t = setup();
  t.recorder.move('drums|fader', change(0.1), label(0.1));
  await t.drain();
  t.advance(30);
  t.recorder.move('drums|fader', change(0.2), label(0.2));
  t.recorder.flushNow();
  assert.deepEqual(t.records, [{ code: 'code:0.1', label: label(0.1) }]);
  t.advance(5000);
  await t.drain();
  assert.deepEqual(t.applied, [0.1], 'the trailing change is never applied');
  assert.equal(t.records.length, 1);
  assert.equal(t.recorder.hasPending(), false);
});

test('flushNow with nothing pending does nothing', () => {
  const t = setup();
  t.recorder.flushNow();
  assert.deepEqual(t.records, []);
});

// --- Previews: a MIDI control is heard by a CC the page sends itself; nothing is evaluated during a drag ---

test('previews never apply a change, and keep the gesture open', async () => {
  const t = setup();
  t.recorder.preview('pad|fader', label(40, 'pad'));
  t.advance(30);
  t.recorder.preview('pad|fader', label(41, 'pad'));
  await t.drain();
  assert.deepEqual(t.applied, []);
  assert.equal(t.recorder.hasPending(), true);
  assert.deepEqual(t.records, []);
});

test('previews then a release apply once and record once, after the pause', async () => {
  const t = setup();
  t.recorder.preview('pad|fader', label(40, 'pad'));
  t.advance(30);
  t.recorder.preview('pad|fader', label(41, 'pad'));
  t.advance(30);
  t.recorder.release('pad|fader', change(42, 'label:pad'), label(42, 'pad'));
  await t.drain();
  assert.deepEqual(t.applied, [42]);
  assert.deepEqual(t.records, []);
  t.advance(PAUSE_MS - 1);
  await t.drain();
  assert.deepEqual(t.records, []);
  t.advance(1);
  await t.drain();
  assert.deepEqual(t.records, [{ code: 'code:42', label: label(42, 'pad') }]);
  assert.deepEqual(t.dropped, [], 'a preview that was written does not call onPreviewDropped');
});

test('a gesture of previews whose pause ends records nothing and calls onPreviewDropped once', async () => {
  const t = setup();
  t.recorder.preview('pad|fader', label(40, 'pad'));
  t.advance(PAUSE_MS);
  await t.drain();
  assert.deepEqual(t.records, []);
  assert.deepEqual(t.applied, []);
  assert.equal(t.dropped.length, 1);
  t.advance(PAUSE_MS * 3);
  await t.drain();
  assert.equal(t.dropped.length, 1, 'once');
});

test('a previewed gesture whose pause ends while the pointer still holds the control stays open, then drops once it is let go', async () => {
  const t = setup();
  t.hold.held = true;
  t.recorder.preview('pad|fader', label(40, 'pad'));
  t.advance(PAUSE_MS * 4);
  await t.drain();
  assert.deepEqual(t.dropped, [], 'listening at the value is not a dropped preview');
  assert.equal(t.recorder.hasPending(), true);
  t.hold.held = false;
  t.advance(PAUSE_MS);
  await t.drain();
  assert.equal(t.dropped.length, 1);
  assert.equal(t.recorder.hasPending(), false);
});

test('a held previewed gesture still records its release once the pointer is up', async () => {
  const t = setup();
  t.hold.held = true;
  t.recorder.preview('pad|fader', label(40, 'pad'));
  t.advance(PAUSE_MS * 2);
  t.hold.held = false;
  t.recorder.release('pad|fader', change(42, 'label:pad'), label(42, 'pad'));
  await t.drain();
  t.advance(PAUSE_MS);
  await t.drain();
  assert.deepEqual(t.records, [{ code: 'code:42', label: label(42, 'pad') }]);
  assert.deepEqual(t.dropped, []);
});

test('flushNow and flushDirect of a previewed gesture that never played call onPreviewDropped once each', async () => {
  const now = setup();
  now.recorder.preview('pad|fader', label(40, 'pad'));
  now.recorder.flushNow();
  assert.equal(now.dropped.length, 1);
  assert.equal(now.recorder.hasPending(), false);

  const direct = setup();
  direct.recorder.preview('pad|fader', label(40, 'pad'));
  await direct.recorder.flushDirect();
  assert.equal(direct.dropped.length, 1);
  assert.deepEqual(direct.records, []);
});

test('a gesture that was never previewed does not call onPreviewDropped', async () => {
  const t = setup({ played: false });
  t.recorder.release('drums|fader', change(0.5), label(0.5));
  await t.drain();
  t.advance(PAUSE_MS);
  await t.drain();
  assert.deepEqual(t.dropped, []);
});
