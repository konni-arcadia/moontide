import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import * as instruments from '../dist/instruments.js';
import * as midiOutModule from '../page/midi-out.js';
import { parseRigMessage } from '../page/midi-rig.js';
import { bankDrumsModel } from './drum-fixtures.js';

const { createMidiOut } = midiOutModule;
import { panicMessages } from '../page/midi-plan.js';
import { CLOCK_HORIZON_MS, CLOCK_INTERVAL_MS, CLOCK_NOTE_LEAD_MS, CLOCK_STAMPED_NOTE_SLACK_MS, CLOCK_START_LEAD_MS, pageAlignment, resetPageAlignment } from '../page/midi-clock.js';
import { makeFakeAudioContext, makeFakeCyclist, makeFakeTime } from './clock-fakes.js';

class FakeNative {
  constructor(id, name, { failing = false, state = 'connected' } = {}) {
    this.id = id;
    this.name = name;
    this.state = state;
    this.failing = failing;
    this.sent = [];
  }
  send(data, ts) {
    if (this.failing) throw new Error('InvalidStateError: the port is disconnected');
    this.sent.push({ data: Array.from(data), ts, argc: arguments.length });
  }
}

class FakeOutput {
  constructor(native) {
    this.native = native;
    this.id = native.id;
    this.name = native.name;
  }
  // The native port, as webmidi 3 keeps it on its Output.
  get _midiOutput() {
    return this.native;
  }
  // A call with one argument reaches the native with one argument (every older test counts on it). With an options
  // argument it forwards what webmidi forwards: the time option when it is a number at or above 0, else false.
  send(data, options) {
    if (arguments.length < 2) {
      this.native.send(data);
      return this;
    }
    const time = options?.time;
    this.native.send(data, typeof time === 'number' && time >= 0 ? time : false);
    return this;
  }
  // What webmidi 3 does inside one playNote call: the note-on without a time, then the note-off at the moment of the
  // call plus the duration. Both go through this.send, so the guard sees them.
  playNote(note, channel, { velocity = 100, duration = 0 } = {}) {
    this.send([0x90 | (channel - 1), note, velocity], { time: false });
    if (duration > 0) {
      const now = this.native.time === undefined ? 0 : this.native.time.perfNow();
      this.send([0x80 | (channel - 1), note, 64], { time: now + duration });
    }
    return this;
  }
}

/**
 * A Web MIDI object that copies the reconnect algorithm of webmidi 3 in the pinned Strudel bundle
 * (WebMidi._updateOutputs): an Output that lost its native goes to `_disconnectedOutputs` (never pruned),
 * and a returning native gets back the FIRST Output of that list that has it, else a new Output.
 * `unplug` and `plug` update webmidi's lists first, then call every statechange listener, as Chrome does.
 */
class FakeWebMidi {
  constructor(natives) {
    this.enabled = true;
    this._outputs = [];
    this._disconnectedOutputs = [];
    this.natives = natives;
    this.listeners = [];
    this.interface = {
      outputs: new Map(natives.map((native) => [native.id, native])),
      addEventListener: (type, handler) => this.listeners.push({ type, handler }),
    };
    this.update();
  }
  get outputs() {
    return this._outputs;
  }
  update() {
    for (let index = this._outputs.length - 1; index >= 0; index--) {
      const output = this._outputs[index];
      if (!Array.from(this.interface.outputs.values()).find((native) => native === output._midiOutput)) {
        this._disconnectedOutputs.push(output);
        this._outputs.splice(index, 1);
      }
    }
    this.interface.outputs.forEach((native) => {
      if (!this._outputs.find((output) => output._midiOutput === native)) {
        const output = this._disconnectedOutputs.find((candidate) => candidate._midiOutput === native) ?? new FakeOutput(native);
        this._outputs.push(output);
      }
    });
  }
  change() {
    this.update();
    for (const listener of this.listeners) if (listener.type === 'statechange') listener.handler();
  }
  unplug(name) {
    const native = this.natives.find((candidate) => candidate.name === name);
    this.interface.outputs.delete(native.id);
    this.change();
  }
  plug(name) {
    const native = this.natives.find((candidate) => candidate.name === name);
    this.interface.outputs.set(native.id, native);
    this.change();
  }
}

/** A fake clock: timers run only when the test advances it. */
function makeClock() {
  const timers = [];
  let now = 0;
  return {
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.done).length,
    now: () => now,
    advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (!timer.cleared && !timer.done && timer.at <= now) {
          timer.done = true;
          timer.fn();
        }
      }
    },
  };
}

function makeRig(names = ['A', 'B', 'C'], options = {}) {
  const natives = names.map((name, index) => new FakeNative(`id-${index}`, name, options[name]));
  const webMidi = {
    enabled: true,
    outputs: natives.map((native) => new FakeOutput(native)),
    _disconnectedOutputs: [],
    interface: { outputs: new Map(natives.map((native) => [native.id, native])) },
  };
  const errors = [];
  const clock = makeClock();
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => undefined,
    supportsMidi: () => true,
    parse,
    isPlaying: () => false,
    isHidden: () => false,
    publish: () => true,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (text, err) => errors.push({ text, err }),
  });
  return { natives, webMidi, errors, out, clock };
}

/** Like makeRig, but over a FakeWebMidi that reconnects like the pinned webmidi. */
function makeLiveRig(names = ['A', 'B']) {
  const natives = names.map((name, index) => new FakeNative(`id-${index}`, name));
  const webMidi = new FakeWebMidi(natives);
  const errors = [];
  const clock = makeClock();
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => undefined,
    supportsMidi: () => true,
    parse,
    isPlaying: () => false,
    isHidden: () => false,
    publish: () => true,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (text, err) => errors.push({ text, err }),
  });
  return { natives, webMidi, errors, out, clock };
}

/** The Output webmidi holds for a port name right now. */
const outputNamed = (webMidi, name) => webMidi.outputs.find((output) => output.name === name);

const code = (name) => `note("c3").midi('${name}')`;
const bytesOf = (native) => native.sent.map((entry) => entry.data);
const PANIC = panicMessages();

test('panic silences the named ports in first-use order, kept across evaluations', () => {
  const { natives, out } = makeRig();
  const order = [];
  for (const native of natives) {
    const send = native.send.bind(native);
    native.send = (data) => {
      order.push(native.name);
      send(data);
    };
  }
  out.recordSuccess(code('A'));
  out.recordSuccess(code('B'));
  out.recordSuccess(code('A'));
  out.panic();
  assert.deepEqual(bytesOf(natives[0]), PANIC);
  assert.deepEqual(bytesOf(natives[1]), PANIC);
  assert.deepEqual(natives[2].sent, []);
  assert.deepEqual([...new Set(order)], ['A', 'B']);
  assert.equal(order.indexOf('B'), 32, 'all of A goes out before B');
});

test('panic silences a device that appeared after a call without a port or with an index was evaluated', () => {
  for (const source of [`note("c3").midi()`, `note("c3").midi(7)`]) {
    const { natives, webMidi, out } = makeRig([]);
    out.recordSuccess(source);
    // The device is plugged in after the evaluation: Strudel resolves the port at every note.
    const late = new FakeNative('id-late', 'Late Synth');
    webMidi.outputs.push(new FakeOutput(late));
    webMidi.interface.outputs.set(late.id, late);
    out.panic();
    assert.deepEqual(natives, []);
    assert.deepEqual(bytesOf(late), PANIC, source);
  }
});

test('panic with a call without a port silences every connected output, not only the current default', () => {
  const { natives, out } = makeRig(['A', 'B IAC', 'C']);
  out.recordSuccess(`note("c3").midi()`);
  out.panic();
  for (const native of natives) assert.deepEqual(bytesOf(native), PANIC, native.name);
});

test('panic sends nothing when Web MIDI is not enabled', () => {
  const { natives, webMidi, out } = makeRig();
  out.recordSuccess(code('A'));
  webMidi.enabled = false;
  assert.doesNotThrow(() => out.panic());
  assert.deepEqual(natives[0].sent, []);
});

test('panic sends nothing when no port was named, and does not throw without webmidi at all', () => {
  const { natives, out } = makeRig();
  out.recordSuccess('s("bd")');
  out.panic();
  for (const native of natives) assert.deepEqual(native.sent, []);
  const bare = createMidiOut({
    getWebMidi: () => null,
    enableWebMidi: () => undefined,
    supportsMidi: () => false,
    parse,
    isPlaying: () => false,
    isHidden: () => false,
    publish: () => true,
    setTimer: makeClock().setTimer,
    clearTimer: makeClock().clearTimer,
  });
  assert.doesNotThrow(() => bare.panic());
  assert.doesNotThrow(() => bare.retireOutputs());
  assert.doesNotThrow(() => bare.onPageHide());
});

test('panic resolves the natives at call time', () => {
  const { natives, webMidi, out } = makeRig();
  out.recordSuccess(code('A'));
  const replacement = new FakeNative('id-0', 'A');
  webMidi.interface.outputs.set('id-0', replacement);
  out.panic();
  assert.deepEqual(natives[0].sent, []);
  assert.deepEqual(bytesOf(replacement), PANIC);
});

test('one port whose send throws is logged by name and the others still get their bytes', () => {
  const { natives, errors, out } = makeRig(['A', 'B'], { A: { failing: true } });
  out.recordSuccess(code('A'));
  out.recordSuccess(code('B'));
  assert.doesNotThrow(() => out.panic());
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.startsWith('Moontide: could not silence MIDI port "A":'));
  assert.ok(errors[0].err instanceof Error);
  assert.deepEqual(bytesOf(natives[1]), PANIC);
});

test('panic messages go out with no timestamp argument', () => {
  const { natives, out } = makeRig();
  out.recordSuccess(code('A'));
  out.panic();
  assert.equal(natives[0].sent.length, 32);
  for (const entry of natives[0].sent) {
    assert.equal(entry.argc, 1);
    assert.equal(entry.ts, undefined);
  }
});

test('an unreadable port since page load makes Stop reach every connected port, named ones first', () => {
  const { natives, out } = makeRig(['A', 'B', 'C']);
  const order = [];
  for (const native of natives) {
    const send = native.send.bind(native);
    native.send = (data) => {
      order.push(native.name);
      send(data);
    };
  }
  natives[0].state = 'disconnected';
  out.recordSuccess(code('C'));
  out.recordSuccess('note("c3").midi(somePort)');
  out.recordSuccess('s("bd")');
  out.panic();
  assert.deepEqual([...new Set(order)], ['C', 'B']);
  assert.deepEqual(natives[0].sent, [], 'a disconnected port is skipped');
  assert.deepEqual(bytesOf(natives[1]), PANIC);
  assert.deepEqual(bytesOf(natives[2]), PANIC);
});

test('retireOutputs swaps in a fresh Output on the same native and the old one sends nothing', () => {
  const { natives, webMidi, out } = makeRig(['A', 'B']);
  const oldA = webMidi.outputs[0];
  const captured = (data) => oldA.send(data);
  out.retireOutputs();
  assert.notEqual(webMidi.outputs[0], oldA);
  assert.ok(webMidi.outputs[0] instanceof FakeOutput);
  assert.equal(webMidi.outputs[0].native, natives[0]);
  assert.equal(webMidi.outputs[1].native, natives[1]);
  captured([0x90, 60, 100]);
  assert.deepEqual(natives[0].sent, [], 'a closure over the old Output sends nothing');
  assert.equal(oldA.send([0x90, 60, 100]), oldA, 'the retired send returns the Output like the original');
  webMidi.outputs[0].send([0x90, 61, 100]);
  assert.deepEqual(bytesOf(natives[0]), [[0x90, 61, 100]]);
});

test('retireOutputs leaves an Output whose native is gone and reports a failure without throwing', () => {
  const { webMidi, errors, out } = makeRig(['A', 'B']);
  const oldA = webMidi.outputs[0];
  webMidi.interface.outputs.delete('id-0');
  out.retireOutputs();
  assert.equal(webMidi.outputs[0], oldA, 'left in place');
  assert.notEqual(webMidi.outputs[1].native, undefined);
  assert.deepEqual(errors, []);
  webMidi.outputs[1] = { id: 'id-1', name: 'B', send() {}, constructor: null };
  assert.doesNotThrow(() => out.retireOutputs());
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.startsWith('Moontide: could not retire a MIDI output:'));
});

test('onPageHide retires then panics, synchronously', () => {
  const { natives, webMidi, out } = makeRig(['A']);
  out.recordSuccess(code('A'));
  const oldA = webMidi.outputs[0];
  const result = out.onPageHide();
  assert.equal(result, undefined);
  assert.notEqual(webMidi.outputs[0], oldA);
  assert.deepEqual(bytesOf(natives[0]), PANIC);
});

test('after retire a replugged port is found again through the fresh Output', () => {
  const { natives, webMidi, out } = makeRig(['A']);
  out.recordSuccess(code('A'));
  out.retireOutputs();
  const replugged = new FakeNative('id-9', 'A');
  webMidi.outputs.splice(0, 1, new FakeOutput(replugged));
  webMidi.interface.outputs.set('id-9', replugged);
  webMidi.outputs.find((output) => output.name === 'A').send([0x90, 60, 100]);
  assert.deepEqual(natives[0].sent, []);
  assert.deepEqual(bytesOf(replugged), [[0x90, 60, 100]]);
});

test('after an unplug and replug, a Stop, then another unplug and replug, a note reaches the port through a live Output', () => {
  const { natives, webMidi, out } = makeLiveRig(['A', 'B']);
  out.recordSuccess(code('A'));
  webMidi.unplug('A');
  webMidi.plug('A');
  out.retireOutputs();
  webMidi.unplug('A');
  webMidi.plug('A');
  const output = outputNamed(webMidi, 'A');
  output.send([0x90, 60, 100]);
  assert.deepEqual(bytesOf(natives[0]), [[0x90, 60, 100]], 'the note reaches the native port');
  assert.notEqual(output.send.name, 'retiredSend', 'the Output webmidi holds is not the retired one');
});

test('Stop while a port is unplugged, then a replug: WebMidi builds a new Output that reaches the port', () => {
  const { natives, webMidi, out } = makeLiveRig(['A', 'B']);
  out.recordSuccess(code('A'));
  const seenBefore = webMidi.outputs.slice();
  const oldA = outputNamed(webMidi, 'A');
  webMidi.unplug('A');
  out.retireOutputs();
  webMidi.plug('A');
  const liveA = outputNamed(webMidi, 'A');
  assert.ok(!seenBefore.includes(liveA), 'the Output of A is new, not one seen before');
  liveA.send([0x90, 60, 100]);
  assert.deepEqual(bytesOf(natives[0]), [[0x90, 60, 100]], 'a note through the new Output reaches the native');
  oldA.send([0x90, 61, 100]);
  assert.deepEqual(bytesOf(natives[0]), [[0x90, 60, 100]], 'the Output of the stopped code stays inert');
});

test('retireOutputs empties WebMidi._disconnectedOutputs and makes inert only the Outputs that are not live', () => {
  const { natives, webMidi, errors, out } = makeLiveRig(['A', 'B', 'C']);
  webMidi.unplug('A');
  webMidi.plug('A');
  const oldA = outputNamed(webMidi, 'A');
  const oldB = outputNamed(webMidi, 'B');
  webMidi.unplug('B');
  assert.ok(webMidi._disconnectedOutputs.includes(oldA) && webMidi._disconnectedOutputs.includes(oldB), 'both are in the list before the Stop');
  out.retireOutputs();
  assert.deepEqual(webMidi._disconnectedOutputs, [], 'the list is empty');
  for (const output of webMidi.outputs) output.send([0x90, 60, 100]);
  assert.deepEqual(bytesOf(natives[0]), [[0x90, 60, 100]], 'A reaches its native');
  assert.deepEqual(bytesOf(natives[2]), [[0x90, 60, 100]], 'C reaches its native');
  assert.deepEqual(natives[1].sent, [], 'B is unplugged and has no Output');
  oldA.send([0x90, 62, 100]);
  oldB.send([0x90, 62, 100]);
  assert.equal(natives[0].sent.length, 1, 'the Output of A that was in the list sends nothing');
  assert.equal(natives[1].sent.length, 0, 'the Output of B that was only in the list sends nothing');
  // A live Output that also sits in the list (its native is gone but webmidi has not noticed) is never made inert.
  const liveC = outputNamed(webMidi, 'C');
  webMidi.interface.outputs.delete(natives[2].id);
  webMidi._disconnectedOutputs.push(liveC);
  out.retireOutputs();
  assert.deepEqual(webMidi._disconnectedOutputs, [], 'the list is empty again');
  liveC.send([0x90, 63, 100]);
  assert.equal(natives[2].sent.length, 2, 'an Output that is still in WebMidi.outputs keeps sending');
  assert.deepEqual(errors, []);
});

test('a WebMidi without a _disconnectedOutputs list: retireOutputs still swaps, and one error names the missing list once', () => {
  const { webMidi, errors, out } = makeRig(['A', 'B']);
  delete webMidi._disconnectedOutputs;
  const first = webMidi.outputs[0];
  out.retireOutputs();
  const second = webMidi.outputs[0];
  assert.notEqual(second, first, 'the first Stop swapped the Output');
  out.retireOutputs();
  assert.notEqual(webMidi.outputs[0], second, 'the second Stop swapped it again');
  assert.equal(errors.length, 1, 'one error for the whole page session');
  assert.ok(errors[0].text.startsWith('Moontide: WebMidi has no _disconnectedOutputs list'));
});

test('FakeWebMidi puts back the first disconnected Output that has the returning native, as the pinned webmidi does', () => {
  const { natives, webMidi } = makeLiveRig(['A']);
  const first = outputNamed(webMidi, 'A');
  webMidi.unplug('A');
  webMidi.plug('A');
  assert.equal(outputNamed(webMidi, 'A'), first, 'the same Output comes back');
  // What the old Stop did: swap the Output in the live list only.
  const second = new FakeOutput(natives[0]);
  webMidi.outputs.splice(0, 1, second);
  webMidi.unplug('A');
  assert.deepEqual(webMidi._disconnectedOutputs, [first, second]);
  webMidi.plug('A');
  assert.equal(outputNamed(webMidi, 'A'), first, 'the first one wins, not the one that was live (the bench bug)');
});

test('three unplug and replug cycles with a Stop and a Play between each still reach the port', () => {
  const { natives, webMidi, out } = makeLiveRig(['A', 'B']);
  out.recordSuccess(code('A'));
  for (let cycle = 1; cycle <= 3; cycle++) {
    webMidi.unplug('A');
    webMidi.plug('A');
    out.retireOutputs();
    outputNamed(webMidi, 'A').send([0x90, 60 + cycle, 100]);
    assert.equal(natives[0].sent.length, cycle, `cycle ${cycle}: the note reaches the native`);
    assert.deepEqual(natives[0].sent[cycle - 1].data, [0x90, 60 + cycle, 100]);
  }
});

test('onPageHide empties the disconnected list too', () => {
  const { natives, webMidi, out } = makeLiveRig(['A']);
  out.recordSuccess(code('A'));
  webMidi.unplug('A');
  webMidi.plug('A');
  assert.equal(webMidi._disconnectedOutputs.length, 1);
  out.onPageHide();
  assert.deepEqual(webMidi._disconnectedOutputs, []);
  assert.deepEqual(bytesOf(natives[0]), PANIC, 'the panic bytes still go out');
});

// --- Access and port watching ---

/**
 * A rig for the access flow: Web MIDI starts disabled and `enableWebMidi` turns it on over the given
 * output names. `published` holds every facts object that went out, `calls` counts the injected calls.
 */
function makeAccessRig({ names = ['A', 'B'], supports = true, permission = 'granted', enable, publishResult = true } = {}) {
  const natives = names.map((name, index) => new FakeNative(`id-${index}`, name));
  const listeners = [];
  const webMidi = {
    enabled: false,
    outputs: [],
    interface: {
      outputs: new Map(),
      addEventListener(type, handler) {
        listeners.push({ type, handler });
      },
    },
  };
  const turnOn = () => {
    webMidi.enabled = true;
    webMidi.outputs = natives.map((native) => new FakeOutput(native));
    webMidi.interface.outputs = new Map(natives.map((native) => [native.id, native]));
  };
  const calls = { enable: 0, query: 0 };
  const published = [];
  const errors = [];
  const clock = makeClock();
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => {
      calls.enable++;
      if (enable) return enable({ turnOn, webMidi });
      turnOn();
      return Promise.resolve();
    },
    queryPermission: () => {
      calls.query++;
      if (typeof permission === 'function') return permission();
      if (permission instanceof Error) return Promise.reject(permission);
      return Promise.resolve(permission);
    },
    supportsMidi: () => supports,
    parse,
    isPlaying: () => true,
    isHidden: () => false,
    publish: (facts) => {
      published.push(facts);
      return publishResult;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (text, err) => errors.push({ text, err }),
  });
  return { out, natives, webMidi, listeners, calls, published, errors, clock, turnOn };
}

const MIDI_CODE = `note("c3").midi('A')`;

test('the port watcher is installed once when Web MIDI is enabled and reads one macrotask after a change', async () => {
  const { out, natives, webMidi, listeners, published, clock } = makeAccessRig();
  await out.beforeEvaluate(MIDI_CODE);
  out.recordSuccess(MIDI_CODE);
  assert.deepEqual(listeners.map((entry) => entry.type), ['statechange']);
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(listeners.length, 1, 'never installed twice');
  const before = published.length;
  // Chrome fires several events for one plug: nothing is read until the timer runs, and only once.
  webMidi.outputs = webMidi.outputs.filter((output) => output.name !== 'A');
  listeners[0].handler({});
  listeners[0].handler({});
  listeners[0].handler({});
  assert.equal(published.length, before, 'no read inside the event itself');
  assert.equal(clock.pending(), 1, 'one pending read');
  clock.advance(0);
  assert.equal(published.length, before + 1, 'one message for the whole burst');
  assert.equal(published.at(-1).ports[0].state, 'unplugged');
  // The same facts again send nothing.
  listeners[0].handler({});
  clock.advance(0);
  assert.equal(published.length, before + 1);
  // The port comes back.
  webMidi.outputs.unshift(new FakeOutput(natives[0]));
  listeners[0].handler({});
  clock.advance(0);
  assert.equal(published.at(-1).ports[0].state, 'connected');
});

test('the port watcher is skipped when the native interface has no event API', async () => {
  const rig = makeAccessRig();
  rig.webMidi.interface = { outputs: new Map() };
  await rig.out.beforeEvaluate(MIDI_CODE);
  assert.equal(rig.listeners.length, 0);
  assert.deepEqual(rig.errors, []);
});

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const named = (name) => Object.assign(new Error(name), { name });
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

// --- The permission flow ---

test('code without a .midi( call never queries the permission or enables Web MIDI', async () => {
  const { out, calls, webMidi } = makeAccessRig();
  await out.beforeEvaluate('s("bd")');
  assert.equal(calls.query, 0);
  assert.equal(calls.enable, 0);
  assert.equal(out.facts().access, 'idle');
  assert.equal(webMidi.enabled, false);
});

test('no Web MIDI in the browser: access is unsupported, told before the evaluation goes on, never asked twice', async () => {
  const { out, calls, published } = makeAccessRig({ supports: false });
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(published.at(-1).access, 'unsupported');
  assert.equal(published.at(-1).triedMidi, true);
  assert.equal(calls.enable, 0);
  assert.equal(calls.query, 0);
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(calls.enable, 0);
  assert.equal(calls.query, 0);
});

test('a permission that is already granted enables Web MIDI with no pending fact ever published', async () => {
  const { out, calls, published, listeners } = makeAccessRig({ permission: 'granted' });
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(calls.enable, 1);
  assert.equal(published.some((facts) => facts.access === 'pending'), false);
  assert.equal(out.facts().access, 'enabled');
  assert.equal(listeners.length, 1);
});

test('a permission that has to be asked publishes pending before the answer and enabled after it', async () => {
  const answer = deferred();
  const { out, published, turnOn } = makeAccessRig({ permission: 'prompt', enable: () => answer.promise });
  const done = out.beforeEvaluate(MIDI_CODE);
  await nextTick();
  const pending = published.at(-1);
  assert.equal(pending.access, 'pending');
  assert.equal(pending.triedMidi, true);
  turnOn();
  answer.resolve();
  await done;
  assert.equal(out.facts().access, 'enabled');
  assert.equal(published.at(-1).access, 'enabled');
});

test('a browser without the midi permission name is handled like a prompt', async () => {
  const answer = deferred();
  const { out, published, turnOn } = makeAccessRig({ permission: named('TypeError'), enable: () => answer.promise });
  const done = out.beforeEvaluate(MIDI_CODE);
  await nextTick();
  assert.equal(published.at(-1).access, 'pending');
  turnOn();
  answer.resolve();
  await done;
  assert.equal(out.facts().access, 'enabled');
  const sync = makeAccessRig({
    permission: () => {
      throw named('TypeError');
    },
  });
  await sync.out.beforeEvaluate(MIDI_CODE);
  assert.equal(sync.out.facts().access, 'enabled', 'a synchronous throw of the query counts as a prompt too');
});

test('a denied permission is never asked again in the page session', async () => {
  const { out, calls } = makeAccessRig({ permission: 'denied' });
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(out.facts().access, 'denied');
  assert.equal(calls.enable, 0);
  await out.beforeEvaluate(MIDI_CODE);
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(calls.enable, 0);
  assert.equal(calls.query, 1);
});

test('an enable rejected as NotAllowedError or SecurityError means denied and is not retried', async () => {
  for (const name of ['NotAllowedError', 'SecurityError']) {
    const { out, calls } = makeAccessRig({ permission: 'prompt', enable: () => Promise.reject(named(name)) });
    await out.beforeEvaluate(MIDI_CODE);
    assert.equal(out.facts().access, 'denied', name);
    await out.beforeEvaluate(MIDI_CODE);
    assert.equal(calls.enable, 1, `${name} is asked once`);
  }
});

test('any other failure is its own state, logged once, and tried again at the next MIDI evaluation', async () => {
  let attempt = 0;
  const { out, calls, published, errors, turnOn } = makeAccessRig({
    permission: 'prompt',
    enable: () => {
      attempt++;
      if (attempt === 1) return Promise.reject(named('AbortError'));
      turnOn();
      return Promise.resolve();
    },
  });
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(published.at(-1).access, 'failed');
  assert.equal(published.at(-1).failure, 'AbortError');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.startsWith('Moontide: Web MIDI could not start:'));
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(calls.enable, 2);
  assert.equal(out.facts().access, 'enabled');
  assert.equal(errors.length, 1);
});

test('an enable that throws synchronously is mapped by the error name like a rejection', async () => {
  const denied = makeAccessRig({
    permission: 'prompt',
    enable: () => {
      throw named('SecurityError');
    },
  });
  await denied.out.beforeEvaluate(MIDI_CODE);
  assert.equal(denied.out.facts().access, 'denied');
  const failed = makeAccessRig({
    permission: 'prompt',
    enable: () => {
      throw named('InvalidStateError');
    },
  });
  await failed.out.beforeEvaluate(MIDI_CODE);
  assert.equal(failed.published.at(-1).access, 'failed');
  assert.equal(failed.published.at(-1).failure, 'InvalidStateError');
});

test('two evaluations started together share one enable', async () => {
  const answer = deferred();
  const { out, calls, turnOn } = makeAccessRig({ permission: 'prompt', enable: () => answer.promise });
  const first = out.beforeEvaluate(MIDI_CODE);
  const second = out.beforeEvaluate(MIDI_CODE);
  await nextTick();
  turnOn();
  answer.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.enable, 1);
  assert.equal(out.facts().access, 'enabled');
});

test('an unanswered prompt lets the evaluation go on after the ceiling, and MIDI starts when the user answers', async () => {
  assert.equal(midiOutModule.MIDI_PERMISSION_CEILING_MS, 120000);
  const answer = deferred();
  const { out, clock, errors, published, turnOn } = makeAccessRig({ permission: 'prompt', enable: () => answer.promise });
  let released = false;
  const done = out.beforeEvaluate(MIDI_CODE).then(() => {
    released = true;
  });
  await nextTick();
  clock.advance(119999);
  await nextTick();
  assert.equal(released, false, 'still waiting just before the ceiling');
  clock.advance(1);
  await done;
  assert.equal(released, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, 'Moontide: the MIDI permission prompt was not answered in 120 s; the code plays without MIDI until it is answered.');
  assert.equal(out.facts().access, 'pending');
  turnOn();
  answer.resolve();
  await nextTick();
  await nextTick();
  assert.equal(out.facts().access, 'enabled');
  assert.equal(published.at(-1).access, 'enabled');
  assert.equal(errors.length, 1);
});

test('once the ceiling has passed, a later MIDI evaluation does not wait again and does not ask again', async () => {
  const answer = deferred();
  const { out, clock, calls } = makeAccessRig({ permission: 'prompt', enable: () => answer.promise });
  const first = out.beforeEvaluate(MIDI_CODE);
  await nextTick();
  clock.advance(120000);
  await first;
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(calls.enable, 1);
  assert.equal(clock.pending(), 0, 'no second ceiling timer');
});

test('an answer before the ceiling clears the ceiling timer', async () => {
  const { out, clock, errors } = makeAccessRig({ permission: 'prompt' });
  await out.beforeEvaluate(MIDI_CODE);
  assert.equal(clock.pending(), 0);
  clock.advance(120000);
  assert.deepEqual(errors, []);
});

test('enableIfGranted does nothing without Web MIDI, and never asks when the permission is prompt or denied', async () => {
  const none = makeAccessRig({ supports: false });
  await none.out.enableIfGranted();
  assert.equal(none.calls.enable, 0);
  assert.equal(none.out.facts().access, 'idle');
  for (const permission of ['prompt', 'denied']) {
    const rig = makeAccessRig({ permission });
    await rig.out.enableIfGranted();
    assert.equal(rig.calls.enable, 0, permission);
    assert.equal(rig.out.facts().access, 'idle', permission);
  }
  const broken = makeAccessRig({ permission: named('TypeError') });
  await broken.out.enableIfGranted();
  assert.equal(broken.calls.enable, 0);
});

test('enableIfGranted enables a granted permission, installs the watcher and never rejects', async () => {
  const { out, calls, listeners, published } = makeAccessRig({ permission: 'granted' });
  await out.enableIfGranted();
  assert.equal(calls.enable, 1);
  assert.equal(out.facts().access, 'enabled');
  assert.equal(listeners.length, 1);
  assert.equal(published.some((facts) => facts.access === 'pending'), false);
  const failing = makeAccessRig({ permission: 'granted', enable: () => Promise.reject(named('AbortError')) });
  await assert.doesNotReject(() => failing.out.enableIfGranted());
  assert.equal(failing.out.facts().access, 'failed');
});

test('isKnownMidiRejection recognises only a permission rejection', () => {
  const { isKnownMidiRejection } = midiOutModule;
  assert.equal(isKnownMidiRejection(named('NotAllowedError')), true);
  assert.equal(isKnownMidiRejection({ name: 'SecurityError' }), true);
  assert.equal(isKnownMidiRejection(new TypeError('x')), false);
  assert.equal(isKnownMidiRejection(named('AbortError')), false);
  assert.equal(isKnownMidiRejection(null), false);
  assert.equal(isKnownMidiRejection(undefined), false);
  assert.equal(isKnownMidiRejection('NotAllowedError'), false);
});

test('held facts: nothing goes out until the hold is released, and a forced publish still does', async () => {
  const { out, published } = makeAccessRig();
  await out.beforeEvaluate(MIDI_CODE);
  out.recordSuccess(MIDI_CODE);
  const before = published.length;
  out.holdFacts(true);
  await out.beforeEvaluate(`note("c3").midi('B')`);
  out.publishFacts();
  assert.equal(published.length, before, 'a held page publishes nothing on its own');
  out.publishFacts({ force: true });
  assert.equal(published.length, before + 1, 'a forced publish is not held');
  out.holdFacts(false);
  out.recordSuccess(`note("c3").midi('B')`);
  assert.equal(published.length, before + 2, 'released: changed facts go out again');
});

// --- The setup step: bank select per model, no resend, guard, rollback, events ---

const sound = (name, program, bank) => (bank === undefined ? { name, program } : { name, program, bank });
const MELODIC = [sound('Alpha 1', 0), sound('Alpha 2', 1), sound('Bell 1', 2), sound('Bell 2', 3), sound('Alpha 1 Var', 0, { msb: 8 }), sound('Deep', 4, { msb: 5, lsb: 2 })];

// The controls of the shipped MT-32 model, copied so a test never reads a file.
const CONTROLS = [
  { id: 'modulation', name: 'Modulation', cc: 1, min: 0, max: 127, default: 0 },
  { id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 },
  { id: 'pan', name: 'Pan', cc: 10, min: 0, max: 127, default: 64 },
  { id: 'expression', name: 'Expression', cc: 11, min: 0, max: 127, default: 127 },
  { id: 'hold', name: 'Hold', cc: 64, min: 0, max: 127, default: 0 },
];

function instrumentOf(id, port, bankSelect, rest = {}) {
  return {
    id,
    model: id,
    modelName: `Model ${id}`,
    port,
    channels: [
      { channel: 3, role: 'melodic' },
      { channel: 4, role: 'melodic' },
      { channel: 10, role: 'rhythm' },
    ],
    bankSelect,
    defaultVolume: 100,
    controls: CONTROLS,
    reset: null,
    sounds: { melodic: MELODIC, rhythm: [sound('Kit 1', 0)] },
    ...rest,
  };
}

const SETUP_RIG = {
  setup: 'valid',
  instruments: [instrumentOf('plain', 'Port A', 'none'), instrumentOf('bank', 'Port B', 'msb'), instrumentOf('wide', 'Port C', 'msb-lsb')],
};

/** A rig of fake ports with a valid setup file. `published` holds every facts object that went out. */
function makeSetupRig({ names = ['Port A', 'Port B', 'Port C'], rig = SETUP_RIG, playing = true, failing = {}, options = {} } = {}) {
  const natives = names.map((name, index) => new FakeNative(`id-${index}`, name, { failing: failing[name] === true }));
  const webMidi = {
    enabled: true,
    outputs: natives.map((native) => new FakeOutput(native)),
    _disconnectedOutputs: [],
    interface: { outputs: new Map(natives.map((native) => [native.id, native])) },
  };
  const state = { playing };
  const errors = [];
  const published = [];
  const clock = makeClock();
  const counted = { parses: 0 };
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => undefined,
    supportsMidi: () => true,
    parse: (...args) => {
      counted.parses++;
      return parse(...args);
    },
    isPlaying: () => state.playing,
    isHidden: () => false,
    publish: (facts) => {
      published.push(facts);
      return true;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (text, err) => errors.push({ text, err }),
    ...options,
  });
  out.setRig(rig);
  return { out, natives, webMidi, errors, published, clock, state, counted };
}

const soundCode = (port, channel, name) => `note("c3").midi('${port}', { midichannel: ${channel}, sound: '${name}' })`;

/** Prepares `source`, sends its setup and commits it, like a successful evaluation. Returns the plan. */
async function play(out, clock, source) {
  const plan = out.prepareSetup(source);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  plan.commit();
  return plan;
}

test('a melodic sound on a bank model sends CC0 then the program change, with CC0 0 for a sound with no bank', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port B', 3, 'Alpha 1 Var'));
  assert.deepEqual(bytesOf(natives[1]), [[0xb2, 0, 8], [0xc2, 0]]);
  await play(out, clock, soundCode('Port B', 3, 'Bell 2'));
  assert.deepEqual(bytesOf(natives[1]).slice(2), [[0xb2, 0, 0], [0xc2, 3]], 'a sound without a bank resets the bank to 0');
});

test('going back from a bank sound to the capital sound of the same program sends CC0 0 again', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port B', 3, 'Alpha 1 Var'));
  await play(out, clock, soundCode('Port B', 3, 'Alpha 1'));
  assert.deepEqual(bytesOf(natives[1]).slice(2), [[0xb2, 0, 0], [0xc2, 0]]);
});

test('a bank msb-lsb model sends CC0, CC32 then the program change, the lsb defaulting to 0', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port C', 3, 'Deep'));
  assert.deepEqual(bytesOf(natives[2]), [[0xb2, 0, 5], [0xb2, 32, 2], [0xc2, 4]]);
  await play(out, clock, soundCode('Port C', 3, 'Bell 1'));
  assert.deepEqual(bytesOf(natives[2]).slice(3), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 2]]);
});

test('a model with no bank select, and a rhythm channel on every model, send the program change alone', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port A', 3, 'Deep'));
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 4]]);
  await play(out, clock, soundCode('Port B', 10, 'Kit 1'));
  assert.deepEqual(bytesOf(natives[1]), [[0xc9, 0]], 'a rhythm channel never gets a bank select');
  await play(out, clock, soundCode('Port C', 10, 'Kit 1'));
  assert.deepEqual(bytesOf(natives[2]), [[0xc9, 0]]);
});

test('setupMessages builds the bank and program bytes of one channel', () => {
  const { setupMessages } = midiOutModule;
  const melodic = { role: 'melodic', program: 7, bank: { msb: 4, lsb: 9 } };
  assert.deepEqual(setupMessages({ bankSelect: 'none' }, 3, melodic), [[0xc2, 7]]);
  assert.deepEqual(setupMessages({ bankSelect: 'msb' }, 3, melodic), [[0xb2, 0, 4], [0xc2, 7]]);
  assert.deepEqual(setupMessages({ bankSelect: 'msb-lsb' }, 3, melodic), [[0xb2, 0, 4], [0xb2, 32, 9], [0xc2, 7]]);
  assert.deepEqual(setupMessages({ bankSelect: 'msb-lsb' }, 16, { role: 'rhythm', program: 1, bank: null }), [[0xcf, 1]]);
});

test('an unchanged plan sends nothing, adds no wait and runs the check once however often it is evaluated', async () => {
  const { out, natives, clock, counted } = makeSetupRig();
  const source = soundCode('Port A', 3, 'Alpha 1');
  await play(out, clock, source);
  const parsesAfterFirst = counted.parses;
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
  for (let index = 0; index < 10; index++) {
    const plan = out.prepareSetup(source);
    assert.equal(plan.refusal, null);
    let done = false;
    const sending = plan.send().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(done, true, 'resolves at once: no guard when nothing went out');
    assert.equal(clock.pending(), 0, 'no timer is left pending');
    await sending;
    plan.commit();
  }
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]], 'five more evaluations send no sound change');
  assert.equal(counted.parses, parsesAfterFirst, 'the code is read and checked once');
});

test('after bytes went out the send resolves only when the guard has passed, 50 ms plus 0.32 ms a byte', async () => {
  const { out, clock } = makeSetupRig();
  const cases = [
    ['Port A', 'Alpha 1', 51],
    ['Port B', 'Alpha 1 Var', 52],
    ['Port C', 'Deep', 53],
  ];
  for (const [port, name, ms] of cases) {
    const plan = out.prepareSetup(soundCode(port, 3, name));
    let done = false;
    const sending = plan.send().then(() => {
      done = true;
    });
    await Promise.resolve();
    clock.advance(ms - 1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(done, false, `${port}: not yet at ${ms - 1} ms`);
    clock.advance(1);
    await sending;
    assert.equal(done, true, `${port}: done at ${ms} ms`);
  }
});

const controlsCode = (port, channel, controls, sound = null) =>
  `note("c3").midi('${port}', { midichannel: ${channel}${sound === null ? '' : `, sound: '${sound}'`}, controls: { ${controls} } })`;

test('controls in the code go out after the sound of their channel, before the guard, and not again', async () => {
  const { out, natives, clock } = makeSetupRig();
  const source = controlsCode('Port A', 3, 'volume: 90', 'Alpha 1');
  const plan = out.prepareSetup(source);
  assert.equal(plan.refusal, null);
  let done = false;
  const sending = plan.send().then(() => {
    done = true;
  });
  await Promise.resolve();
  // The program change (2 bytes) and the control (3 bytes) count toward the guard: 50 + 5 * 0.32 = 51.6 ms.
  clock.advance(51);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false, 'the guard counts the control bytes too');
  clock.advance(1);
  await sending;
  plan.commit();
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0], [0xb2, 7, 90]], 'the control follows the program change of its channel');
  await play(out, clock, source);
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0], [0xb2, 7, 90]], 'the same code again sends nothing');
});

test('controls of one channel go out in the model order, whatever order the code writes them in', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, controlsCode('Port A', 3, 'pan: 30, modulation: 5'));
  assert.deepEqual(bytesOf(natives[0]), [[0xb2, 1, 5], [0xb2, 10, 30]]);
});

test('a preview sends its CC at once and the release evaluation sends nothing more', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, `note("c3").midi('Port A', { midichannel: 3 })`);
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 40 }), true);
  assert.deepEqual(bytesOf(natives[0]), [[0xb2, 7, 40]]);
  await play(out, clock, controlsCode('Port A', 3, 'volume: 40'));
  assert.deepEqual(bytesOf(natives[0]), [[0xb2, 7, 40]], 'the setup step knows the instrument already holds the value');
});

test('a control that leaves the code returns to the model default, once, and a control the page never sent is left alone', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, controlsCode('Port A', 3, 'volume: 90, pan: 30'));
  const afterFirst = bytesOf(natives[0]).length;
  await play(out, clock, controlsCode('Port A', 3, 'volume: 90'));
  assert.deepEqual(bytesOf(natives[0]).slice(afterFirst), [[0xb2, 10, 64]], 'pan left the code: the model default goes out');
  const afterSecond = bytesOf(natives[0]).length;
  await play(out, clock, `note("c3").midi('Port A', { midichannel: 4 })`);
  assert.deepEqual(bytesOf(natives[0]).slice(afterSecond), [[0xb2, 7, 100]], 'a channel the code no longer uses: the default volume, and nothing for the pan already at its default');
  const afterThird = bytesOf(natives[0]).length;
  await play(out, clock, `note("c3").midi('Port A', { midichannel: 4 })`);
  assert.equal(bytesOf(natives[0]).length, afterThird, 'the same code again sends nothing');
  assert.ok(bytesOf(natives[0]).every((bytes) => bytes[0] === 0xb2), 'a channel the page never sent a control to gets no control byte');
});

test('an evaluation that changes only a control still waits the guard for its three bytes', async () => {
  const { out, clock } = makeSetupRig();
  await play(out, clock, controlsCode('Port A', 3, 'volume: 90'));
  const plan = out.prepareSetup(controlsCode('Port A', 3, 'volume: 91'));
  let done = false;
  const sending = plan.send().then(() => {
    done = true;
  });
  await Promise.resolve();
  clock.advance(Math.ceil(midiOutModule.SETUP_GUARD_MS + 3 * midiOutModule.SETUP_WIRE_MS_PER_BYTE) - 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false, 'not yet');
  clock.advance(1);
  await sending;
  assert.equal(done, true);
});

test('a failed evaluation puts the playing code back: the rollback sends the earlier value of a changed control', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, controlsCode('Port A', 3, 'volume: 90'));
  const plan = out.prepareSetup(controlsCode('Port A', 3, 'volume: 40'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(bytesOf(natives[0]).at(-1), [0xb2, 7, 40]);
  await plan.rollback();
  assert.deepEqual(bytesOf(natives[0]).at(-1), [0xb2, 7, 90], 'the instrument is back at what the playing code writes');
});

test('a preview then a failed evaluation of the same value: the rollback still sends the playing value back', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, controlsCode('Port A', 3, 'volume: 90'));
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 40 }), true);
  const plan = out.prepareSetup(controlsCode('Port A', 3, 'volume: 40'));
  await plan.send();
  assert.deepEqual(bytesOf(natives[0]).filter((bytes) => bytes[1] === 7), [[0xb2, 7, 90], [0xb2, 7, 40]], 'the setup step sends no CC7 for a value the preview sent');
  await plan.rollback();
  assert.deepEqual(bytesOf(natives[0]).at(-1), [0xb2, 7, 90]);
});

test('resync repairs an abandoned preview: the playing code value, else the model default, and only once', async () => {
  const written = makeSetupRig();
  await play(written.out, written.clock, controlsCode('Port A', 3, 'volume: 90'));
  written.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 40 });
  await written.out.resync();
  assert.deepEqual(bytesOf(written.natives[0]).at(-1), [0xb2, 7, 90]);
  const count = bytesOf(written.natives[0]).length;
  await written.out.resync();
  assert.equal(bytesOf(written.natives[0]).length, count, 'a second resync sends nothing');

  const none = makeSetupRig();
  await play(none.out, none.clock, `note("c3").midi('Port A', { midichannel: 3 })`);
  none.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 40 });
  await none.out.resync();
  assert.deepEqual(bytesOf(none.natives[0]).at(-1), [0xb2, 7, 100], 'no volume in the playing code: the model default');
});

test('a superseded tab sends no control and no preview', async () => {
  const { out, natives, clock } = makeSetupRig();
  out.setActive(false);
  const plan = out.prepareSetup(controlsCode('Port A', 3, 'volume: 90'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(natives[0].sent, []);
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 40 }), false);
  assert.deepEqual(natives[0].sent, []);
});

test('without a setup file, code with controls sends no control byte', () => {
  const { out, natives } = makeSetupRig({ rig: { setup: 'absent' } });
  assert.equal(out.prepareSetup(controlsCode('Port A', 3, 'volume: 90')), null);
  assert.deepEqual(natives[0].sent, []);
});

test('Stop forgets the sustain pedal the page sent: the same code sends hold again', async () => {
  const { out, natives, clock } = makeSetupRig();
  const source = controlsCode('Port A', 3, 'hold: 127');
  await play(out, clock, source);
  out.recordSuccess(source);
  assert.deepEqual(bytesOf(natives[0]), [[0xb2, 64, 127]]);
  await play(out, clock, source);
  assert.equal(bytesOf(natives[0]).length, 1, 'unchanged: nothing sent');
  out.panic();
  const afterPanic = bytesOf(natives[0]).length;
  await play(out, clock, source);
  assert.deepEqual(bytesOf(natives[0]).slice(afterPanic), [[0xb2, 64, 127]], 'the pedal is down in the code and up on the device: sent again');
});

test('a reset sends the volume and the controls the code writes, and the next evaluation of the same code sends nothing', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  const source = controlsCode('Port A', 3, 'volume: 90, pan: 30', 'Alpha 1');
  await play(r.out, r.clock, source);
  const before = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(500);
  await r.wait(100);
  assert.deepEqual(
    bytesOf(r.native('Port A')).slice(before),
    [...RESET_A, [0xc2, 0], [0xb2, 7, 90], [0xb2, 10, 30], [0xb3, 7, 100], [0xb9, 7, 100]],
    'channel 3 gets its sound, the written volume and the written pan; the other channels the default volume',
  );
  // The same setup goes out a second time RECONNECT_REPEAT_MS later, written controls included.
  await r.wait(midiOutModule.RECONNECT_REPEAT_MS);
  assert.deepEqual(
    bytesOf(r.native('Port A')).slice(before + 6),
    [[0xc2, 0], [0xb2, 7, 90], [0xb2, 10, 30], [0xb3, 7, 100], [0xb9, 7, 100]],
    'the second setup: the same sound and controls, no reset message',
  );
  const afterReset = r.native('Port A').sent.length;
  await play(r.out, r.clock, source);
  assert.equal(r.native('Port A').sent.length, afterReset, 'the reset seeded what the device holds');
});

test('a reset of an instrument whose port changed in the file sends the default volume, not the old code\'s', async () => {
  const r = makeResetRig({ present: ['Port A', 'Port Z'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, controlsCode('Port A', 3, 'volume: 90'));
  r.out.setRig({
    setup: 'valid',
    instruments: [instrumentOf('plain', 'Port Z', 'none', { reset: { messages: RESET_A, waitMs: 100 } }), RESET_RIG.instruments[1]],
  });
  await r.wait(100);
  assert.deepEqual(bytesOf(r.native('Port Z')), [...RESET_A, ...VOLUMES], 'the playing code named the old port: its volume is not sent to the new one');
});

test('a preview goes only to the one connected output of the instrument, and says once why it cannot', () => {
  const { out, natives, errors } = makeSetupRig({ names: ['Port A', 'Port A 2'] });
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 40 }), false, 'two outputs contain the port: nothing is sent');
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 41 }), false);
  assert.deepEqual(natives.map((native) => native.sent.length), [0, 0]);
  assert.equal(errors.length, 1, 'one error per cause');
  assert.equal(out.previewControl({ instrumentId: 'nobody', channel: 3, cc: 7, value: 40 }), false);
  assert.equal(errors.length, 2, 'another cause is reported again');
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 17, cc: 7, value: 40 }), false, 'a channel outside 1 to 16 is refused');
  assert.equal(out.previewControl({ instrumentId: 'plain', channel: 3, cc: 7, value: 128 }), false, 'a value outside 0 to 127 is refused');
});

test('a call without a sound sends no program change for its channel', async () => {
  const { out, natives, clock } = makeSetupRig();
  const plan = out.prepareSetup(`note("c3").midi('Port A', { midichannel: 3 })`);
  assert.equal(plan.refusal, null);
  await plan.send();
  assert.equal(clock.pending(), 0);
  assert.deepEqual(natives[0].sent, []);
});

test('setRig with a new rig drops the memo and the shadows of instruments that left', async () => {
  const { out, natives, clock } = makeSetupRig();
  const source = soundCode('Port A', 3, 'Alpha 1');
  await play(out, clock, source);
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
  // The same rig content again: the instrument stays, so nothing is sent again.
  out.setRig({ ...SETUP_RIG, instruments: [...SETUP_RIG.instruments] });
  await play(out, clock, source);
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
  // The instrument leaves and comes back: its shadow is gone, so the sound goes out again.
  out.setRig({ setup: 'valid', instruments: [SETUP_RIG.instruments[1]] });
  assert.ok(out.prepareSetup(source).refusal.startsWith('Port "Port A" is connected but not in instruments.json.'), 'the new rig is checked, not the memo');
  out.setRig(SETUP_RIG);
  await play(out, clock, source);
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0], [0xc2, 0]]);
});

test('a refusal says when the port is connected but not in the file, and the closing line follows the music', () => {
  const { out, state } = makeSetupRig({ names: ['Port A', 'Port Z'] });
  const source = soundCode('Port Z', 3, 'Alpha 1');
  const playing = out.prepareSetup(source).refusal.split('\n');
  assert.equal(playing[0], 'Port "Port Z" is connected but not in instruments.json. Add it there first.');
  assert.equal(playing.at(-1), 'The previous music keeps playing.');
  state.playing = false;
  assert.equal(out.prepareSetup(source).refusal.split('\n').at(-1), 'Nothing changed in the music.', 'the memo does not hide a change of the playing flag');
});

test('rollback sends the previous bank and program for a changed channel and puts the shadow back', async () => {
  const { out, natives, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port B', 3, 'Alpha 1 Var'));
  const plan = out.prepareSetup(soundCode('Port B', 3, 'Bell 2'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(bytesOf(natives[1]).slice(2), [[0xb2, 0, 0], [0xc2, 3]]);
  await plan.rollback();
  assert.deepEqual(bytesOf(natives[1]).slice(4), [[0xb2, 0, 8], [0xc2, 0]], 'the previous bank, then the previous program');
  // The shadow follows what was sent: the old sound again is not sent again.
  await play(out, clock, soundCode('Port B', 3, 'Alpha 1 Var'));
  assert.equal(natives[1].sent.length, 6);
});

test('rollback of a channel with no earlier sound sends nothing, keeps the sound and tells Claude with an event', async () => {
  const { out, natives, clock, published } = makeSetupRig();
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Bell 2'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 3]]);
  await plan.rollback();
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 3]], 'nothing is sent back: there is no earlier sound');
  const last = published.at(-1);
  assert.deepEqual(last.events, [{ kind: 'sound-kept', instrument: 'plain', channel: 3, sound: 'Bell 2' }], 'published inside the rollback');
  assert.deepEqual(out.facts().events, [], 'sent once');
  await play(out, clock, soundCode('Port A', 3, 'Bell 2'));
  assert.equal(natives[0].sent.length, 1, 'the kept sound is the shadow: it is not sent again');
});

test('a change of sound on a channel the playing code used, while playing, adds one sound-cut event', async () => {
  const { out, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  assert.deepEqual(out.facts().events, [], 'the first sound on a channel adds no event');
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  assert.deepEqual(out.facts().events, [], 'the same sound adds none');
  await play(out, clock, soundCode('Port A', 3, 'Bell 1'));
  assert.deepEqual(out.facts().events, [{ kind: 'sound-cut', instrument: 'plain', channel: 3 }]);
});

// --- A sound change drops the old code's leftover notes on that channel ---

test("a sound change on a playing channel drops the old code's notes on that channel from the program change on", async () => {
  const { out, natives, webMidi, clock } = makeSetupRig();
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  out.recordSuccess(soundCode('Port A', 3, 'Alpha 1'));
  const mark = natives[0].sent.length;
  // The Output the old code's closures hold.
  const stale = webMidi.outputs[0];
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  const sending = plan.send();
  stale.send([0x92, 48, 100]);
  stale.send([0x93, 50, 100]);
  clock.advance(1000);
  await sending;
  plan.commit();
  assert.notEqual(webMidi.outputs[0], stale, 'the commit puts a fresh Output on the port');
  webMidi.outputs[0].send([0x92, 60, 100]);
  stale.send([0x92, 48, 100]);
  assert.deepEqual(
    bytesOf(natives[0]).slice(mark),
    [[0xc2, 1], [0x93, 50, 100], [0x92, 60, 100]],
    'program change, then no old note on channel 3 (channel 4 still plays), then the new note',
  );
});

/** Like makeSetupRig, but over a FakeWebMidi that reconnects like the pinned webmidi. */
function makeLiveSetupRig(names = ['Port A', 'Port B']) {
  const natives = names.map((name, index) => new FakeNative(`id-${index}`, name));
  const webMidi = new FakeWebMidi(natives);
  const errors = [];
  const clock = makeClock();
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => undefined,
    supportsMidi: () => true,
    parse,
    isPlaying: () => true,
    isHidden: () => false,
    publish: () => true,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (text, err) => errors.push({ text, err }),
  });
  out.setRig(SETUP_RIG);
  return { out, natives, webMidi, errors, clock };
}

/** Plays `source` like a successful evaluation, and records it as the code that plays now. */
async function playAndRecord(out, clock, source) {
  await play(out, clock, source);
  out.recordSuccess(source);
}

test("a channel whose sound does not change and another port keep the old code's notes", async () => {
  const { out, natives, webMidi, clock } = makeSetupRig();
  const three = (soundA) => [soundCode('Port A', 3, soundA), soundCode('Port A', 4, 'Alpha 1'), soundCode('Port B', 3, 'Alpha 1')].join('\n');
  await playAndRecord(out, clock, three('Alpha 1'));
  const [oldA, oldB] = webMidi.outputs;
  const mark = [natives[0].sent.length, natives[1].sent.length];
  const plan = out.prepareSetup(three('Alpha 2'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  oldA.send([0x93, 50, 100]);
  oldA.send([0x92, 48, 100]);
  oldB.send([0x92, 48, 100]);
  oldB.send([0x93, 50, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark[0]), [[0xc2, 1], [0x93, 50, 100]], 'Port A: channel 3 dropped, channel 4 passes');
  assert.deepEqual(bytesOf(natives[1]).slice(mark[1]), [[0x92, 48, 100], [0x93, 50, 100]], 'Port B passes everything');
  plan.commit();
  assert.equal(webMidi.outputs[1], oldB, 'the Output of the port that did not change is not swapped');
  assert.notEqual(webMidi.outputs[0], oldA, 'the Output of the changed port is swapped');
  oldA.send([0x93, 52, 100]);
  assert.equal(bytesOf(natives[0]).at(-1)[1], 52, 'after the commit the old Output still passes the unchanged channel');
});

test('the first evaluation of the page and an evaluation while stopped filter nothing', async () => {
  const first = makeSetupRig();
  const live = first.webMidi.outputs[0];
  const firstPlan = first.out.prepareSetup(soundCode('Port A', 3, 'Alpha 1'));
  const firstSending = firstPlan.send();
  live.send([0x92, 48, 100]);
  first.clock.advance(1000);
  await firstSending;
  assert.deepEqual(bytesOf(first.natives[0]), [[0xc2, 0], [0x92, 48, 100]], 'no code played yet: the note passes before the commit');
  firstPlan.commit();
  assert.equal(first.webMidi.outputs[0], live, 'nothing was filtered, so nothing is swapped');

  const stopped = makeSetupRig();
  await playAndRecord(stopped.out, stopped.clock, soundCode('Port A', 3, 'Alpha 1'));
  stopped.state.playing = false;
  const stoppedOutput = stopped.webMidi.outputs[0];
  const plan = stopped.out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  const sending = plan.send();
  stoppedOutput.send([0x92, 48, 100]);
  stopped.clock.advance(1000);
  await sending;
  assert.deepEqual(bytesOf(stopped.natives[0]).slice(1), [[0xc2, 1], [0x92, 48, 100]], 'stopped: the note passes');
  plan.commit();
  assert.equal(stopped.webMidi.outputs[0], stoppedOutput, 'stopped: no swap');
});

test("a failed evaluation lifts the filter: the old code's notes pass again and no Output is swapped", async () => {
  const { out, natives, webMidi, clock } = makeSetupRig();
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  const stale = webMidi.outputs[0];
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  stale.send([0x92, 48, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(1), [[0xc2, 1]], 'filtered while the evaluation runs');
  const rolling = plan.rollback();
  // Before the first await of the rollback: the old code keeps playing, so its notes must pass at once.
  stale.send([0x92, 50, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(2), [[0xc2, 0], [0x92, 50, 100]], 'lifted synchronously (the old sound goes back first, in the same tick)');
  await rolling;
  assert.equal(webMidi.outputs[0], stale, 'no Output is swapped');
  stale.send([0x92, 52, 100]);
  assert.deepEqual(bytesOf(natives[0]).at(-1), [0x92, 52, 100], 'still passes after the rollback');
});

test('a program change that cannot be sent lifts the filter of its channel', async () => {
  const { out, natives, webMidi, clock, errors } = makeSetupRig();
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  const stale = webMidi.outputs[0];
  natives[0].failing = true;
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  await plan.send();
  natives[0].failing = false;
  assert.equal(errors.length, 1, 'the failed send is one logged error');
  const mark = natives[0].sent.length;
  stale.send([0x92, 48, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark), [[0x92, 48, 100]], 'the old code keeps its notes on that channel');
});

test('the old filtered Output never comes back after an unplug and replug', async () => {
  const { out, natives, webMidi, clock } = makeLiveSetupRig();
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  webMidi.unplug('Port A');
  webMidi.plug('Port A');
  const filtered = outputNamed(webMidi, 'Port A');
  assert.ok(webMidi._disconnectedOutputs.includes(filtered), 'after one replug it sits in both webmidi lists');
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 2'));
  assert.notEqual(outputNamed(webMidi, 'Port A'), filtered, 'the commit swapped it');
  assert.ok(!webMidi._disconnectedOutputs.includes(filtered), 'and removed it from the disconnected list');
  webMidi.unplug('Port A');
  webMidi.plug('Port A');
  const back = outputNamed(webMidi, 'Port A');
  assert.notEqual(back, filtered, 'the filtered Output did not come back');
  const mark = natives[0].sent.length;
  back.send([0x92, 48, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark), [[0x92, 48, 100]], 'a channel 3 note reaches the native');
});

/** Sends the setup of a sound change on Port A, unplugs the port, then ends the evaluation with `finish`, and plugs the port back. Returns the Output the replug put back. */
async function unplugBetweenSendAndEnd(finish) {
  const r = makeLiveSetupRig();
  await playAndRecord(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const filtered = outputNamed(r.webMidi, 'Port A');
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  const sending = plan.send();
  r.clock.advance(1000);
  await sending;
  filtered.send([0x92, 48, 100]);
  assert.deepEqual(bytesOf(r.natives[0]).slice(1), [[0xc2, 1]], 'filtered while the evaluation runs');
  r.webMidi.unplug('Port A');
  await finish(plan);
  r.webMidi.plug('Port A');
  r.clock.advance(5000);
  await Promise.resolve();
  return { ...r, back: outputNamed(r.webMidi, 'Port A') };
}

test('a port unplugged between the program change and the commit does not come back filtered', async () => {
  const { back, natives, webMidi, errors } = await unplugBetweenSendAndEnd(async (plan) => plan.commit());
  const mark = natives[0].sent.length;
  back.send([0x92, 48, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark), [[0x92, 48, 100]], 'a channel 3 note reaches the native after the replug');
  assert.ok(!webMidi._disconnectedOutputs.includes(back), 'and the Output that left is gone from the disconnected list');
  assert.deepEqual(errors, []);
});

test('a port unplugged between the program change and a rollback does not come back filtered', async () => {
  const { back, natives } = await unplugBetweenSendAndEnd((plan) => plan.rollback());
  const mark = natives[0].sent.length;
  back.send([0x92, 48, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark), [[0x92, 48, 100]], 'a channel 3 note reaches the native after the replug');
});

test('a WebMidi without a disconnected list: the swap still happens and one error names it once', async () => {
  const { out, webMidi, clock, errors } = makeSetupRig();
  delete webMidi._disconnectedOutputs;
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  const stale = webMidi.outputs[0];
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 2'));
  assert.notEqual(webMidi.outputs[0], stale, 'swapped anyway');
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Bell 1'));
  assert.equal(errors.filter((entry) => entry.text.includes('_disconnectedOutputs')).length, 1, 'one error per page session');
});

test('two sound changes in a row each swap the then-live Output', async () => {
  const { out, natives, webMidi, clock } = makeSetupRig();
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  const first = webMidi.outputs[0];
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 2'));
  const second = webMidi.outputs[0];
  assert.notEqual(second, first);
  second.send([0x92, 48, 100]);
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Bell 1'));
  const third = webMidi.outputs[0];
  assert.notEqual(third, second);
  const mark = natives[0].sent.length;
  third.send([0x92, 60, 100]);
  first.send([0x92, 61, 100]);
  second.send([0x92, 62, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark), [[0x92, 60, 100]], 'only the live Output passes channel 3; each previous code drops it');
  assert.deepEqual(bytesOf(natives[0]).filter((bytes) => bytes[0] === 0x92 && bytes[1] === 48), [[0x92, 48, 100]], 'the note sent before the second change passed');
});

test('a sound change on a playing channel still tells Claude it may cut a note', async () => {
  const { out, clock } = makeSetupRig();
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  await play(out, clock, soundCode('Port A', 3, 'Bell 1'));
  assert.deepEqual(out.facts().events, [{ kind: 'sound-cut', instrument: 'plain', channel: 3 }], 'the filter does not replace the event');
});

test('the stale filter drops only channel messages of the changed channels', async () => {
  const { out, natives, webMidi, clock } = makeSetupRig();
  await playAndRecord(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  const stale = webMidi.outputs[0];
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  const mark = natives[0].sent.length;
  for (const passing of [[0xf0, 0x41, 0xf7], [0xfe], [0x93, 50, 100], [0x7f, 1], [0xff]]) stale.send(passing);
  const passed = bytesOf(natives[0]).slice(mark);
  assert.equal(passed.length, 5, 'SysEx, active sensing, a channel 4 note and out-of-range status bytes pass');
  for (const dropped of [[0x82, 48, 0], [0xb2, 1, 64], [0xe2, 0, 64], [0x92, 48, 100], new Uint8Array([0x92, 48, 100]), [0xc2, 5], [0xd2, 5], [0xa2, 48, 5]]) stale.send(dropped);
  assert.equal(natives[0].sent.length, mark + 5, 'note-off, control, pitch bend, note-on, aftertouch and program messages of channel 3 are dropped');
  assert.doesNotThrow(() => stale.send([]), 'an empty message does not throw in the guard');
  plan.commit();
});

test('no sound-cut event while stopped, or for a channel the playing code did not use', async () => {
  const { out, clock, state } = makeSetupRig();
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  state.playing = false;
  await play(out, clock, soundCode('Port A', 3, 'Bell 1'));
  assert.deepEqual(out.facts().events, [], 'a change while stopped');
  state.playing = true;
  await play(out, clock, soundCode('Port A', 4, 'Bell 2'));
  await play(out, clock, soundCode('Port A', 3, 'Bell 2'));
  assert.deepEqual(out.facts().events, [], 'channel 3 was not used by the code that played last');
});

test('a native that throws on send adds a send-failed event, logs once and keeps the last sound that went out', async () => {
  const { out, natives, clock, errors } = makeSetupRig({ failing: { 'Port A': true } });
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Alpha 1'));
  await plan.send();
  assert.equal(clock.pending(), 0, 'nothing went out, so no guard');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.startsWith('Moontide: could not send a sound to MIDI port'));
  assert.deepEqual(out.facts().events, [{ kind: 'send-failed', instrument: 'plain', what: 'setup', failure: 'Error' }]);
  // The port works again: the sound was never in the shadow, so it goes out now.
  natives[0].failing = false;
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
});

test('events go out with the next facts once, and an empty event list sends nothing new', async () => {
  const { out, clock, published } = makeSetupRig();
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  await play(out, clock, soundCode('Port A', 3, 'Bell 1'));
  const before = published.length;
  out.publishFacts();
  assert.equal(published.length, before + 1);
  assert.deepEqual(published.at(-1).events, [{ kind: 'sound-cut', instrument: 'plain', channel: 3 }]);
  out.publishFacts();
  assert.equal(published.length, before + 1, 'the same facts with no new event send nothing');
  assert.deepEqual(out.facts().events, []);
});

test('an event held back by a failed publish is kept for the next one', async () => {
  const natives = [new FakeNative('id-0', 'Port A')];
  const webMidi = { enabled: true, outputs: natives.map((native) => new FakeOutput(native)), interface: { outputs: new Map([['id-0', natives[0]]]) } };
  const clock = makeClock();
  let accept = false;
  const sentFacts = [];
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => undefined,
    supportsMidi: () => true,
    parse,
    isPlaying: () => true,
    isHidden: () => false,
    publish: (facts) => {
      sentFacts.push(facts);
      return accept;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: () => {},
  });
  out.setRig(SETUP_RIG);
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  await play(out, clock, soundCode('Port A', 3, 'Bell 1'));
  out.publishFacts();
  assert.equal(out.facts().events.length, 1, 'kept while the socket is closed');
  accept = true;
  out.publishFacts();
  assert.equal(sentFacts.at(-1).events.length, 1);
  assert.equal(out.facts().events.length, 0);
});

test('more than MAX_PAGE_EVENTS events keep the newest 20 and log one line', async () => {
  const { MAX_PAGE_EVENTS } = midiOutModule;
  assert.equal(MAX_PAGE_EVENTS, 20);
  const { out, clock, errors } = makeSetupRig({ failing: { 'Port A': true } });
  for (let index = 0; index < 25; index++) {
    const plan = out.prepareSetup(soundCode('Port A', 3, index % 2 === 0 ? 'Alpha 1' : 'Bell 1'));
    await plan.send();
  }
  const events = out.facts().events;
  assert.equal(events.length, MAX_PAGE_EVENTS);
  assert.equal(clock.pending(), 0);
  const overflowLines = errors.filter((entry) => /events/.test(entry.text));
  assert.equal(overflowLines.length, 1, 'one line, not one per dropped event');
});

test('an instrument whose port matches no native or several gets no bytes and keeps its shadow', async () => {
  const { out, natives, webMidi, clock } = makeSetupRig({ names: ['Port A 1', 'Port B', 'Port C'] });
  // 'Port A' is a substring of one output only: that one is the device.
  await play(out, clock, soundCode('Port A', 3, 'Alpha 1'));
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
  // A second output that contains the port name makes the match ambiguous: nothing goes out.
  const other = new FakeNative('id-9', 'Port A 2');
  webMidi.outputs.push(new FakeOutput(other));
  webMidi.interface.outputs.set(other.id, other);
  const plan = out.prepareSetup(soundCode('Port A', 3, 'Bell 1'));
  await plan.send();
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
  assert.deepEqual(other.sent, []);
  // No output at all: nothing goes out either.
  webMidi.interface.outputs.delete('id-9');
  webMidi.interface.outputs.delete('id-0');
  await out.prepareSetup(soundCode('Port A', 3, 'Bell 1')).send();
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0]]);
  // The device is back: the shadow still says Alpha 1, so the changed sound is sent now.
  webMidi.interface.outputs.set('id-0', natives[0]);
  webMidi.interface.outputs.delete('id-9');
  webMidi.outputs.pop();
  await play(out, clock, soundCode('Port A', 3, 'Bell 1'));
  assert.deepEqual(bytesOf(natives[0]), [[0xc2, 0], [0xc2, 2]]);
});

// --- Reset on connect: presence, settle, once per connection, never from a superseded tab ---

const RESET_A = [[0xf0, 0x41, 0xf7]];
const RESET_B = [[0xf0, 0x42, 0xf7]];
const RESET_RIG = {
  setup: 'valid',
  instruments: [
    instrumentOf('plain', 'Port A', 'none', { reset: { messages: RESET_A, waitMs: 100 } }),
    instrumentOf('bank', 'Port B', 'msb', { reset: { messages: RESET_B, waitMs: 50 } }),
  ],
};
// The default volume of the declared channels 3, 4 and 10, in channel order.
const VOLUMES = [[0xb2, 7, 100], [0xb3, 7, 100], [0xb9, 7, 100]];

/**
 * A rig for the reset flow: Web MIDI starts disabled over the `present` outputs; `plug` and `unplug`
 * change the output list and fire the statechange event, then run the pending read.
 */
function makeResetRig({ present = ['Port A', 'Port B'], rig = RESET_RIG, settle = 500, failing = [] } = {}) {
  const natives = new Map();
  const native = (name) => {
    if (!natives.has(name)) natives.set(name, new FakeNative(`id-${natives.size}`, name, { failing: failing.includes(name) }));
    return natives.get(name);
  };
  const listeners = [];
  const webMidi = {
    enabled: false,
    outputs: [],
    _disconnectedOutputs: [],
    interface: {
      outputs: new Map(),
      addEventListener(type, handler) {
        listeners.push({ type, handler });
      },
    },
  };
  const list = (name) => {
    const entry = native(name);
    webMidi.outputs.push(new FakeOutput(entry));
    webMidi.interface.outputs.set(entry.id, entry);
  };
  const unlist = (name) => {
    const entry = native(name);
    webMidi.outputs = webMidi.outputs.filter((output) => output.id !== entry.id);
    webMidi.interface.outputs.delete(entry.id);
  };
  for (const name of present) list(name);
  const published = [];
  const errors = [];
  const infos = [];
  const clock = makeClock();
  const state = { playing: true };
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => {
      webMidi.enabled = true;
      return Promise.resolve();
    },
    queryPermission: () => Promise.resolve('granted'),
    supportsMidi: () => true,
    parse,
    isPlaying: () => state.playing,
    isHidden: () => false,
    publish: (facts) => {
      published.push(facts);
      return true;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    resetSettleMs: settle,
    now: () => clock.now(),
    onError: (text, err) => errors.push({ text, err }),
    onInfo: (text) => infos.push(text),
  });
  out.setRig(rig);
  const noise = () => {
    for (const listener of listeners) listener.handler({});
    clock.advance(0);
  };
  return {
    out,
    clock,
    state,
    webMidi,
    published,
    errors,
    infos,
    native,
    listeners,
    noise,
    plug(name) {
      list(name);
      noise();
    },
    unplug(name) {
      unlist(name);
      noise();
    },
    resets: () => published.flatMap((facts) => facts.events).filter((event) => event.kind === 'reset'),
    // Advances the fake clock and lets every promise that waited for it run.
    async wait(ms) {
      clock.advance(ms);
      await nextTick();
    },
  };
}

test('the settle delay is 500 ms by default', () => {
  assert.equal(midiOutModule.RESET_SETTLE_MS, 500);
});

test('page start with the instruments present: the reset goes out at once, the volumes only after the wait, and Claude is told once', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  assert.deepEqual(bytesOf(r.native('Port A')), RESET_A, 'the reset message, nothing else yet');
  assert.deepEqual(bytesOf(r.native('Port B')), RESET_B);
  await r.wait(49);
  assert.equal(r.native('Port B').sent.length, 1, 'the model of Port B waits 50 ms');
  await r.wait(1);
  assert.deepEqual(bytesOf(r.native('Port B')), [...RESET_B, ...VOLUMES]);
  assert.equal(r.native('Port A').sent.length, 1, 'the model of Port A waits 100 ms');
  await r.wait(50);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, ...VOLUMES]);
  assert.deepEqual(r.resets(), [
    { kind: 'reset', instrument: 'bank', reason: 'start' },
    { kind: 'reset', instrument: 'plain', reason: 'start' },
  ]);
  assert.deepEqual(r.errors, []);
});

test('an instrument the code does not use is reset and gets its volume, but no program change', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(100);
  const bytes = bytesOf(r.native('Port A'));
  assert.equal(bytes.some((message) => message[0] >= 0xc0 && message[0] <= 0xcf), false, 'no program change');
  assert.deepEqual(bytes, [...RESET_A, ...VOLUMES]);
});

test('a preview during an instrument reset is refused and not remembered, so the release still sends the value', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  assert.deepEqual(bytesOf(r.native('Port A')), RESET_A, 'the reset waits 100 ms');
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 30 }), false);
  assert.deepEqual(bytesOf(r.native('Port A')), RESET_A, 'the device would drop it: nothing is sent');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].text, /being reset/);
  await r.wait(100);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, ...VOLUMES]);
  const plan = r.out.prepareSetup(controlsCode('Port A', 3, 'pan: 30'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  r.clock.advance(1000);
  await sending;
  plan.commit();
  assert.deepEqual(bytesOf(r.native('Port A')).slice(-1), [[0xb2, 10, 30]], 'the release sends the pan the preview could not');
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 31 }), true, 'previews work again once the reset is over');
});

test('a port that appears after the enable is reset once, after the settle delay, with the reason reconnect', async () => {
  const r = makeResetRig({ present: ['Port B'] });
  await r.out.enableIfGranted();
  await r.wait(50);
  r.plug('Port A');
  await r.wait(499);
  assert.deepEqual(r.native('Port A').sent, [], 'nothing before the settle delay is over');
  await r.wait(1);
  assert.deepEqual(bytesOf(r.native('Port A')), RESET_A, 'the reset message right after the settle');
  await r.wait(100);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, ...VOLUMES]);
  assert.deepEqual(r.resets().at(-1), { kind: 'reset', instrument: 'plain', reason: 'reconnect' });
  assert.equal(r.resets().length, 2, 'one for the page start of Port B, one for the reconnect');
});

test('several statechange events for one plug, quiet or spread over time, give one reset', async () => {
  const r = makeResetRig({ present: ['Port B'] });
  await r.out.enableIfGranted();
  await r.wait(100);
  r.plug('Port A');
  r.noise();
  r.noise();
  await r.wait(100);
  r.noise();
  await r.wait(100);
  r.noise();
  await r.wait(1000);
  await r.wait(200);
  const resetMessages = bytesOf(r.native('Port A')).filter((message) => message[0] === 0xf0);
  assert.deepEqual(resetMessages, RESET_A, 'one reset for the connection');
  assert.equal(r.resets().filter((event) => event.instrument === 'plain').length, 1);
});

test('a port that leaves before the settle ends gets no reset, and its shadow is cleared', async () => {
  const r = makeResetRig({ present: ['Port B'] });
  await r.out.enableIfGranted();
  await r.wait(100);
  r.plug('Port A');
  await r.wait(200);
  r.unplug('Port A');
  assert.equal(r.clock.pending(), 0, 'the settle timer is cancelled');
  await r.wait(2000);
  assert.deepEqual(r.native('Port A').sent, []);
  // The shadow of a port that went away is gone: with the device back, the sound goes out again.
  r.plug('Port A');
  await r.wait(500);
  await r.wait(100);
  await r.wait(midiOutModule.RECONNECT_REPEAT_MS); // the second setup goes out first
  const sent = bytesOf(r.native('Port A')).length;
  const source = soundCode('Port A', 3, 'Alpha 1');
  await play(r.out, r.clock, source);
  assert.equal(bytesOf(r.native('Port A')).length, sent + 1, 'the first sound goes out');
  r.unplug('Port A');
  r.webMidi.outputs.push(new FakeOutput(r.native('Port A')));
  r.webMidi.interface.outputs.set(r.native('Port A').id, r.native('Port A'));
  await play(r.out, r.clock, source);
  assert.deepEqual(bytesOf(r.native('Port A')).at(-1), [0xc2, 0], 'sent again: the shadow was cleared when the port left');
});

test('an unplug then a plug gives exactly one more reset after the settle, with the sounds and the volume back', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const before = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  r.noise();
  await r.wait(499);
  assert.equal(r.native('Port A').sent.length, before, 'nothing during the settle');
  await r.wait(1);
  await r.wait(100);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, [0xc2, 0], ...VOLUMES]);
  assert.deepEqual(r.resets().filter((event) => event.instrument === 'plain' && event.reason === 'reconnect').length, 1);
  await r.wait(5000);
  // One reset message, and the setup (sound and volumes) twice.
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, [0xc2, 0], ...VOLUMES, [0xc2, 0], ...VOLUMES], 'no second reset, the setup twice');
});

// --- The hold after a reconnect and the second setup ---

/** The webmidi Output of a port in the fake list now; a test sends the bytes of a Strudel note through it. */
const outputOf = (r, name) => r.webMidi.outputs.find((output) => output.name === name);
const NOTE = [0x92, 60, 100];

test('a replugged instrument gets no note from the page\'s note path until its reset, its setup and its second setup have gone out, then notes reach it', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const mark = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  const sentSince = () => bytesOf(r.native('Port A')).slice(mark);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), [], 'dropped in the same tick as the replug');
  await r.wait(499);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), [], 'dropped during the settle delay');
  await r.wait(1);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), RESET_A, 'only the reset has gone out, the note is dropped');
  await r.wait(100);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), [...RESET_A, [0xc2, 0], ...VOLUMES], 'the setup has gone out, the note is still dropped');
  await r.wait(midiOutModule.RECONNECT_REPEAT_MS - 1);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), [...RESET_A, [0xc2, 0], ...VOLUMES], 'nothing new before the repeat delay is over');
  await r.wait(1);
  assert.deepEqual(sentSince(), [...RESET_A, [0xc2, 0], ...VOLUMES, [0xc2, 0], ...VOLUMES], 'the same setup again, and no second reset');
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince().at(-1), NOTE, 'the note reaches the port after the second setup');
  assert.deepEqual(r.resets().filter((event) => event.reason === 'reconnect').length, 1, 'Claude hears one reset');
  assert.deepEqual(r.errors, []);
});

const REPEAT = midiOutModule.RECONNECT_REPEAT_MS;

test('a reconnect hold logs one info line, not one per dropped note, and a new hold logs again', async () => {
  const r = await replugA();
  assert.deepEqual(r.infos, [], 'nothing is logged until a note is dropped');
  for (let note = 0; note < 3; note++) outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.infos.length, 1, 'three dropped notes, one line');
  assert.match(r.infos[0], /^Moontide: .*"Port A"/);
  assert.match(r.infos[0], /wait/);
  await settled(r);
  await r.wait(REPEAT);
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.infos.length, 1, 'a note after the hold is not dropped and logs nothing');
  r.unplug('Port A');
  r.plug('Port A');
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.infos.length, 2, 'the next hold logs its own line');
  assert.deepEqual(r.errors, []);
});

/** Evaluates `source` like a successful evaluation, but advances the fake clock by `ms` only (play advances 1000). */
async function playBriefly(r, source, ms = 100) {
  const plan = r.out.prepareSetup(source);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  await r.wait(ms);
  await sending;
  plan.commit();
  r.out.recordSuccess(source);
  return plan;
}

/** A rig with Port A playing `Alpha 1`, unplugged and plugged back: the clock stands at the plug. */
async function replugA(options = {}) {
  const r = makeResetRig(options);
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  r.unplug('Port A');
  r.plug('Port A');
  return r;
}

const SETUP_A = [[0xc2, 0], ...VOLUMES];

/** The settle delay and Port A's model wait of the fake clock, in the two steps a timer chain needs (a timer armed by a continuation starts at the end of the advance). */
async function settled(r) {
  await r.wait(500);
  await r.wait(100);
}

/** Advances the fake clock by `ms` in steps of 50 ms, so every timer armed on the way starts at its own time. */
async function runFor(r, ms) {
  for (let spent = 0; spent < ms; spent += 50) await r.wait(50);
}

test('RECONNECT_REPEAT_MS is 1000 ms', () => {
  assert.equal(midiOutModule.RECONNECT_REPEAT_MS, 1000);
});

test('the second setup is sent RECONNECT_REPEAT_MS after the first, with the same sound, volume and control bytes and no reset message', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, controlsCode('Port A', 3, 'pan: 30', 'Alpha 1'));
  const mark = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  await settled(r);
  const setup = [[0xc2, 0], [0xb2, 7, 100], [0xb2, 10, 30], [0xb3, 7, 100], [0xb9, 7, 100]];
  assert.deepEqual(bytesOf(r.native('Port A')).slice(mark), [...RESET_A, ...setup], 'the reset, then the setup with the written pan');
  await r.wait(REPEAT - 1);
  assert.equal(r.native('Port A').sent.length, mark + 1 + setup.length, 'nothing before the delay is over');
  await r.wait(1);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(mark), [...RESET_A, ...setup, ...setup], 'the same bytes in the same order, and one reset message only');
  assert.deepEqual(r.errors, []);
});

test('a port that leaves during the hold gets no second setup, and a new replug starts a new hold', async () => {
  // Before the reset: the settle timer is cancelled and the hold with it.
  const early = await replugA();
  const earlyMark = early.native('Port A').sent.length;
  await early.wait(200);
  early.unplug('Port A');
  outputOf(early, 'Port B').send(NOTE);
  await early.wait(5000);
  assert.equal(early.native('Port A').sent.length, earlyMark, 'nothing at all on Port A');
  early.plug('Port A');
  outputOf(early, 'Port A').send(NOTE);
  assert.equal(early.native('Port A').sent.length, earlyMark, 'a new hold: the note is dropped');
  await settled(early);
  assert.deepEqual(bytesOf(early.native('Port A')).slice(earlyMark), [...RESET_A, ...SETUP_A], 'one reset and one setup');
  outputOf(early, 'Port A').send(NOTE);
  assert.equal(early.native('Port A').sent.length, earlyMark + 1 + SETUP_A.length, 'still held until the second setup');
  await early.wait(REPEAT);
  assert.deepEqual(bytesOf(early.native('Port A')).slice(earlyMark), [...RESET_A, ...SETUP_A, ...SETUP_A], 'then the second setup');
  outputOf(early, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(early.native('Port A')).at(-1), NOTE, 'and the notes flow');

  // Between the setup and the second setup: the second setup timer is cancelled.
  const late = await replugA();
  const lateMark = late.native('Port A').sent.length;
  await settled(late);
  assert.deepEqual(bytesOf(late.native('Port A')).slice(lateMark), [...RESET_A, ...SETUP_A]);
  late.unplug('Port A');
  await late.wait(5000);
  assert.equal(late.native('Port A').sent.length, lateMark + 1 + SETUP_A.length, 'no second setup for a port that left');
  late.plug('Port A');
  outputOf(late, 'Port A').send(NOTE);
  assert.equal(late.native('Port A').sent.length, lateMark + 1 + SETUP_A.length, 'the new connection is held');
  await settled(late);
  await late.wait(REPEAT);
  assert.deepEqual(bytesOf(late.native('Port A')).slice(lateMark), [...RESET_A, ...SETUP_A, ...RESET_A, ...SETUP_A, ...SETUP_A]);
  outputOf(late, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(late.native('Port A')).at(-1), NOTE);
  assert.deepEqual(early.errors.concat(late.errors), []);
});

test('losing the playing role during the hold ends it, and taking the role back holds nothing', async () => {
  const r = await replugA();
  const mark = r.native('Port A').sent.length;
  await settled(r);
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.native('Port A').sent.length, mark + 1 + SETUP_A.length, 'held after the setup');
  r.out.setActive(false);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')).at(-1), NOTE, 'a superseded tab holds nothing');
  r.out.setActive(true);
  const before = r.native('Port A').sent.length;
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.native('Port A').sent.length, before + 1, 'taking the role back is not a connection: no hold');
  await r.wait(5000);
  assert.equal(r.native('Port A').sent.length, before + 1, 'and no second setup');
  assert.deepEqual(r.errors, []);

  // The role goes during the settle delay: no reset, no hold left behind.
  const early = await replugA();
  const earlyMark = early.native('Port A').sent.length;
  early.out.setActive(false);
  outputOf(early, 'Port A').send(NOTE);
  assert.equal(early.native('Port A').sent.length, earlyMark + 1);
  await early.wait(5000);
  assert.equal(early.native('Port A').sent.length, earlyMark + 1, 'nothing else on the port');
});

test('an instrument removed from instruments.json during the hold is not held any more', async () => {
  const onlyB = { setup: 'valid', instruments: [RESET_RIG.instruments[1]] };
  const early = await replugA();
  const earlyMark = early.native('Port A').sent.length;
  outputOf(early, 'Port A').send(NOTE);
  assert.equal(early.native('Port A').sent.length, earlyMark, 'held');
  early.out.setRig(onlyB);
  outputOf(early, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(early.native('Port A')).slice(earlyMark), [NOTE], 'passes at once, and no reset follows');
  await early.wait(5000);
  assert.deepEqual(bytesOf(early.native('Port A')).slice(earlyMark), [NOTE]);

  const late = await replugA();
  const lateMark = late.native('Port A').sent.length;
  await settled(late);
  late.out.setRig(onlyB);
  outputOf(late, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(late.native('Port A')).at(-1), NOTE);
  await late.wait(5000);
  assert.equal(late.native('Port A').sent.length, lateMark + 1 + SETUP_A.length + 1, 'no second setup either');
});

test('Stop during the hold: the fresh Output is held too until the second setup', async () => {
  const r = await replugA();
  const mark = r.native('Port A').sent.length;
  await settled(r);
  const before = outputOf(r, 'Port A');
  r.out.retireOutputs();
  const fresh = outputOf(r, 'Port A');
  assert.notEqual(fresh, before, 'Stop swapped the Output');
  before.send(NOTE);
  fresh.send(NOTE);
  assert.equal(r.native('Port A').sent.length, mark + 1 + SETUP_A.length, 'the retired Output sends nothing and the fresh one is held');
  await r.wait(REPEAT);
  assert.equal(r.native('Port A').sent.length, mark + 1 + SETUP_A.length * 2, 'the second setup still goes out');
  fresh.send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')).at(-1), NOTE, 'and the fresh Output passes after it');
  assert.deepEqual(r.errors, []);
});

test('page start and taking the role back schedule no second setup', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, NOTE], 'the page-start reset holds nothing');
  await r.wait(5000);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, NOTE, ...VOLUMES], 'one setup, no second one');
  const before = r.native('Port A').sent.length;
  r.out.setActive(false);
  r.unplug('Port A');
  r.plug('Port A');
  r.out.setActive(true);
  outputOf(r, 'Port A').send(NOTE);
  await r.wait(5000);
  assert.equal(r.native('Port A').sent.length, before + 1, 'only the note: no setup, no hold');
});

test('an evaluation between the two setups: the second setup sends the new sound', async () => {
  const r = await replugA();
  const mark = r.native('Port A').sent.length;
  await settled(r);
  await playBriefly(r, soundCode('Port A', 3, 'Alpha 2'));
  assert.deepEqual(bytesOf(r.native('Port A')).slice(mark + 1 + SETUP_A.length), [[0xc2, 1]], 'the evaluation sends the new sound');
  await r.wait(REPEAT);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(mark + 1 + SETUP_A.length + 1), [[0xc2, 1], ...VOLUMES], 'the second setup carries the new sound, not the old one');
  assert.deepEqual(r.errors, []);
});

test('an evaluation in flight during the second setup and then rolled back reports no kept sound', async () => {
  const r = await replugA();
  await settled(r);
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Alpha 1'));
  assert.equal(plan.refusal, null);
  await plan.send();
  const before = r.native('Port A').sent.length;
  await r.wait(REPEAT);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), SETUP_A, 'the second setup went out while the evaluation was in flight');
  await plan.rollback();
  assert.deepEqual(r.published.flatMap((facts) => facts.events).filter((event) => event.kind === 'sound-kept'), [], 'the second setup adds nothing to the change list');
  assert.deepEqual(r.resets().filter((event) => event.reason === 'repeat'), [], 'and no reset event');
});

test('a control preview during the hold is refused as resetting', async () => {
  const r = await replugA();
  await settled(r);
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 30 }), false, 'held, though the reset is over');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].text, /is being reset/);
  const before = r.native('Port A').sent.length;
  await r.wait(REPEAT);
  assert.equal(r.native('Port A').sent.length, before + SETUP_A.length, 'only the second setup was sent');
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 31 }), true, 'after the second setup the preview goes out');
  assert.deepEqual(bytesOf(r.native('Port A')).at(-1), [0xb2, 10, 31]);
});

test('two instruments that come back at different times are held, reset and set up twice each, on their own', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  await r.wait(200);
  const markA = r.native('Port A').sent.length;
  const markB = r.native('Port B').sent.length;
  r.unplug('Port A');
  r.unplug('Port B');
  r.plug('Port A');
  await runFor(r, 300);
  r.plug('Port B');
  await runFor(r, 400);
  assert.equal(r.native('Port B').sent.length, markB, 'B settles until 800 ms');
  // A came back at 0 ms: its second setup goes out at 1600 ms. B came back at 300 ms: its reset at 800, its second setup at 1850.
  await runFor(r, 1000);
  outputOf(r, 'Port A').send(NOTE);
  outputOf(r, 'Port B').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(markA).at(-1), NOTE, 'A passes');
  assert.equal(bytesOf(r.native('Port B')).slice(markB).some((message) => message[0] === NOTE[0]), false, 'B is still held');
  await runFor(r, 200);
  outputOf(r, 'Port B').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port B')).at(-1), NOTE, 'B passes after its own second setup');
  assert.deepEqual(bytesOf(r.native('Port A')).slice(markA), [...RESET_A, ...VOLUMES, ...VOLUMES, NOTE]);
  const onB = bytesOf(r.native('Port B')).slice(markB, -1);
  assert.deepEqual(onB.slice(0, 1), RESET_B);
  const half = (onB.length - 1) / 2;
  assert.ok(half > 0 && Number.isInteger(half), 'B got a setup twice');
  assert.deepEqual(onB.slice(1, 1 + half), onB.slice(1 + half), 'the same setup twice, one reset message');
  assert.equal(r.resets().filter((event) => event.reason === 'reconnect').length, 2);
  assert.deepEqual(r.errors, []);
});

test('a port that is not in instruments.json is never held', async () => {
  const r = await replugA();
  r.plug('Port Z');
  outputOf(r, 'Port Z').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port Z')), [NOTE], 'passes in the same tick, while Port A is held');
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(bytesOf(r.native('Port A')).some((message) => message[0] === NOTE[0]), false, 'Port A is held at the same moment');
  await r.wait(5000);
  assert.deepEqual(bytesOf(r.native('Port Z')), [NOTE], 'and gets nothing else');
});

test('the page\'s own bytes are never held', async () => {
  const r = await replugA();
  await settled(r);
  const before = r.native('Port A').sent.length;
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.native('Port A').sent.length, before, 'the note path is held');
  const source = soundCode('Port A', 3, 'Alpha 2');
  await playBriefly(r, source);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before, before + 1), [[0xc2, 1]], 'the evaluation\'s program change goes out during the hold');
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 30 }), false, 'a preview is refused, not dropped silently');
  const beforeStop = r.native('Port A').sent.length;
  r.out.panic();
  assert.deepEqual(bytesOf(r.native('Port A')).slice(beforeStop), PANIC, 'Stop\'s panic goes out during the hold');
  assert.deepEqual(r.errors.filter((error) => !/is being reset/.test(error.text)), []);
});

test('a second setup that fails is one log line and a send-failed event, and the hold still ends', async () => {
  const r = await replugA();
  await settled(r);
  r.native('Port A').failing = true;
  await r.wait(REPEAT);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].text.startsWith('Moontide: could not send the second setup to MIDI port "Port A"'));
  assert.deepEqual(r.published.flatMap((facts) => facts.events).filter((event) => event.kind === 'send-failed'), [{ kind: 'send-failed', instrument: 'plain', what: 'reset', failure: 'Error' }]);
  r.native('Port A').failing = false;
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')).at(-1), NOTE, 'the hold is over');
});

test('an ambiguous port, a missing port and a native that is not in the rig never get a reset', async () => {
  const r = makeResetRig({ present: ['Port A', 'Port A 2', 'Port Z'] });
  await r.out.enableIfGranted();
  await r.wait(1000);
  assert.deepEqual(r.native('Port A').sent, [], 'two outputs contain the name');
  assert.deepEqual(r.native('Port A 2').sent, []);
  assert.deepEqual(r.native('Port Z').sent, [], 'not an instrument of the rig');
  // Port B is not there at all: nothing is sent anywhere, and the ambiguity going away is a connection.
  r.unplug('Port A 2');
  await r.wait(500);
  await r.wait(100);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, ...VOLUMES], 'the one match is reset after the settle');
  assert.deepEqual(r.native('Port Z').sent, []);
  assert.deepEqual(r.native('Port A 2').sent, []);
});

test('no rig, an invalid rig and an instrument removed from the rig never get a reset', async () => {
  for (const rig of [{ setup: 'absent' }, { setup: 'invalid', problems: [{ field: 'instruments', reason: 'bad' }], more: 0 }]) {
    const r = makeResetRig({ rig });
    await r.out.enableIfGranted();
    r.unplug('Port A');
    r.plug('Port A');
    await r.wait(2000);
    assert.deepEqual(r.native('Port A').sent, [], rig.setup);
    assert.deepEqual(r.native('Port B').sent, [], rig.setup);
  }
  const r = makeResetRig({ present: ['Port B'] });
  await r.out.enableIfGranted();
  await r.wait(100);
  r.out.setRig({ setup: 'valid', instruments: [RESET_RIG.instruments[0]] });
  r.unplug('Port B');
  r.plug('Port B');
  await r.wait(2000);
  assert.deepEqual(bytesOf(r.native('Port B')), [...RESET_B, ...VOLUMES], 'only the reset of the page start, none after it left the rig');
});

test('setActive(false): a plug sends nothing and the pending settle timer is cancelled', async () => {
  const r = makeResetRig({ present: ['Port B'] });
  await r.out.enableIfGranted();
  await r.wait(100);
  r.plug('Port A');
  assert.equal(r.clock.pending(), 1, 'a settle timer is waiting');
  r.out.setActive(false);
  assert.equal(r.clock.pending(), 0, 'cancelled');
  await r.wait(2000);
  assert.deepEqual(r.native('Port A').sent, []);
  r.unplug('Port B');
  r.plug('Port B');
  await r.wait(2000);
  assert.equal(bytesOf(r.native('Port B')).filter((message) => message[0] === 0xf0).length, 1, 'a superseded tab sends no reset');
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Alpha 1'));
  await plan.send();
  assert.deepEqual(r.native('Port A').sent, [], 'and no setup');
});

test('setActive(true): the shadows are cleared with no reset, and the next send sends every declared sound again', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  await r.wait(200);
  const source = soundCode('Port A', 3, 'Alpha 1');
  await play(r.out, r.clock, source);
  const before = r.native('Port A').sent.length;
  await play(r.out, r.clock, source);
  assert.equal(r.native('Port A').sent.length, before, 'unchanged: nothing sent');
  r.out.setActive(false);
  r.unplug('Port A');
  r.plug('Port A');
  r.out.setActive(true);
  await r.wait(5000);
  assert.equal(r.native('Port A').sent.length, before, 'taking the role back is not a connection: no reset');
  await play(r.out, r.clock, source);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [[0xc2, 0]], 'the sound goes out again');
});

test('an evaluation that arrives during the wait of a reset waits for it, and the reset sends its sounds in channel order', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  assert.deepEqual(bytesOf(r.native('Port A')), RESET_A);
  const plan = r.out.prepareSetup(`note("c3").midi('Port A', { midichannel: 3, sound: 'Bell 1' })`);
  assert.equal(plan.refusal, null);
  let done = false;
  const sending = plan.send().then(() => {
    done = true;
  });
  await r.wait(99);
  assert.equal(done, false);
  assert.deepEqual(bytesOf(r.native('Port A')), RESET_A, 'the reset is still waiting');
  await r.wait(1);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, [0xc2, 2], ...VOLUMES], 'the sound of the evaluation, then the volume, per channel');
  assert.equal(done, false, 'the guard still applies: the reset sent setup bytes');
  assert.equal(r.clock.pending(), 1);
  await r.wait(1000);
  await sending;
  assert.equal(done, true);
  assert.equal(r.native('Port A').sent.length, 1 + 1 + VOLUMES.length, 'the send sent nothing more');
  plan.commit();
});

test('code without .midi() forgets the earlier sounds, so a later reconnect reset does not send them again', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  assert.deepEqual(bytesOf(r.native('Port A')).filter((message) => message[0] === 0xc2), [[0xc2, 0]]);
  await play(r.out, r.clock, `note("c3")`);
  const before = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(2000);
  await r.wait(200);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, ...VOLUMES], 'the reset sets volumes only: no program change of code that no longer plays');
});

test('a setup file that goes away forgets the earlier sounds, so a reconnect reset after it comes back does not send them', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  r.out.setRig({ setup: 'absent' });
  r.out.setRig(RESET_RIG);
  const before = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(2000);
  await r.wait(200);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, ...VOLUMES], 'volumes only: no program change of code the file no longer backs');
});

test('an instrument whose model changed under the same id forgets the earlier sounds', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const before = r.native('Port A').sent.length;
  r.out.setRig({ setup: 'valid', instruments: [{ ...RESET_RIG.instruments[0], model: 'other' }, RESET_RIG.instruments[1]] });
  await r.wait(200);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, ...VOLUMES], 'the reset of the new model sends no old program number');
});

test('a model change that goes through an invalid file state forgets the earlier sounds too', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const before = r.native('Port A').sent.length;
  r.out.setRig({ setup: 'invalid', problems: [{ field: 'instruments[0].model', reason: 'half-written' }] });
  r.out.setRig({ setup: 'valid', instruments: [{ ...RESET_RIG.instruments[0], model: 'other' }, RESET_RIG.instruments[1]] });
  await r.wait(200);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, ...VOLUMES], 'the reset of the new model sends no old program number');
});

test('a file that goes through an invalid state and comes back unchanged keeps the earlier sounds', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  r.out.setRig({ setup: 'invalid', problems: [{ field: 'instruments[0].model', reason: 'half-written' }] });
  r.out.setRig(RESET_RIG);
  const before = r.native('Port A').sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(2000);
  await r.wait(200);
  assert.ok(bytesOf(r.native('Port A')).slice(before).some((message) => message[0] === 0xc2), 'the reset still sends the sound of the playing code');
});

test('a reset that sent the sounds of a failing evaluation is rolled back with a sound-kept event', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  const plan = r.out.prepareSetup(`note("c3").midi('Port A', { midichannel: 3, sound: 'Bell 1' })`);
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  await r.wait(100);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, [0xc2, 2], ...VOLUMES], 'the reset sent the sound of the evaluation');
  await r.wait(1000);
  await sending;
  await plan.rollback();
  const last = r.published.at(-1);
  assert.deepEqual(last.events, [{ kind: 'sound-kept', instrument: 'plain', channel: 3, sound: 'Bell 1' }], 'Claude is told the channel kept the new sound');
});

test('a reset during a failing evaluation that had changed the sound still sends the old sound back, with no sound-kept event', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Bell 1'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  // The evaluation is in flight when the port is unplugged and plugged: the reset runs and sends the pending sound.
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(500);
  await r.wait(100);
  await sending;
  const before = r.native('Port A').sent.length;
  await plan.rollback();
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [[0xc2, 0]], 'the old sound goes back on the channel');
  assert.deepEqual(r.published.at(-1).events.filter((event) => event.kind === 'sound-kept'), [], 'nothing is kept: the channel got its old sound back');
});

test('a rollback that arrives during the wait of a reset waits for it, then sends the old sound to a ready device', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  await play(r.out, r.clock, `note("c3")`);
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Bell 1'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(500);
  const before = r.native('Port A').sent.length - 1;
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), RESET_A, 'the reset is in its wait');
  let done = false;
  const rolling = plan.rollback().then(() => {
    done = true;
  });
  await r.wait(99);
  assert.equal(done, false);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), RESET_A, 'nothing is sent into the wait of the device');
  await r.wait(1);
  await rolling;
  await sending;
  assert.deepEqual(bytesOf(r.native('Port A')).slice(before), [...RESET_A, ...VOLUMES, [0xc2, 0]], 'the old sound goes out after the reset is over');
  await r.wait(midiOutModule.RECONNECT_REPEAT_MS); // the second setup goes out first
  // The shadow now matches the device: the same sound is not sent again.
  const sent = r.native('Port A').sent.length;
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  assert.equal(r.native('Port A').sent.length, sent);
});

test('a rollback of a tab that lost the active role sends nothing, before or during the wait of a reset', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Bell 1'));
  assert.equal(plan.refusal, null);
  const first = plan.send();
  await r.wait(1000);
  await first;
  r.out.setActive(false);
  const before = r.native('Port A').sent.length;
  await plan.rollback();
  assert.equal(r.native('Port A').sent.length, before, 'the old sound is not sent to a device another tab controls');

  // The role is lost while the rollback waits for a reset.
  r.out.setActive(true);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const second = r.out.prepareSetup(soundCode('Port A', 3, 'Bell 1'));
  assert.equal(second.refusal, null);
  const sending = second.send();
  await r.wait(1000);
  await sending;
  r.unplug('Port A');
  r.plug('Port A');
  await r.wait(500);
  const during = r.native('Port A').sent.length;
  const rolling = second.rollback();
  r.out.setActive(false);
  await r.wait(100);
  await rolling;
  assert.equal(
    bytesOf(r.native('Port A')).slice(during - 1).some((message) => message[0] === 0xc2),
    false,
    'no program change is sent after the role was lost',
  );
});

test('a native that throws during the reset publishes a send-failed event, logs once and is not counted as reset', async () => {
  const r = makeResetRig({ present: ['Port A'], failing: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(1000);
  assert.deepEqual(r.published.flatMap((facts) => facts.events), [{ kind: 'send-failed', instrument: 'plain', what: 'reset', failure: 'Error' }]);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].text.startsWith('Moontide: could not reset MIDI port'));
  assert.equal(r.resets().length, 0);
});

test('Stop and an evaluation of the same code send no reset', async () => {
  const r = makeResetRig({ present: ['Port A'] });
  await r.out.enableIfGranted();
  await r.wait(200);
  const source = soundCode('Port A', 3, 'Alpha 1');
  await play(r.out, r.clock, source);
  const before = bytesOf(r.native('Port A')).length;
  r.out.recordSuccess(source);
  r.out.panic();
  await play(r.out, r.clock, source);
  await r.wait(5000);
  const after = bytesOf(r.native('Port A')).slice(before);
  assert.equal(after.some((message) => message[0] === 0xf0), false, 'no reset message');
  assert.equal(after.length, 32, 'only the 32 messages of Stop');
});

test('a new rig that adds a present instrument resets it at once, and an instrument whose port changed counts as new', async () => {
  const r = makeResetRig({ present: ['Port A', 'Port B', 'Port C'], rig: { setup: 'valid', instruments: [RESET_RIG.instruments[0]] } });
  await r.out.enableIfGranted();
  await r.wait(200);
  assert.deepEqual(r.native('Port B').sent, [], 'not in the rig yet');
  r.out.setRig(RESET_RIG);
  assert.deepEqual(bytesOf(r.native('Port B')), RESET_B, 'the new instrument is reset at once');
  await r.wait(100);
  r.out.setRig({ setup: 'valid', instruments: [RESET_RIG.instruments[0], { ...RESET_RIG.instruments[1], port: 'Port C' }] });
  assert.deepEqual(bytesOf(r.native('Port C')), RESET_B, 'a new port is a new instrument');
  await r.wait(100);
  assert.equal(bytesOf(r.native('Port A')).filter((message) => message[0] === 0xf0).length, 1, 'the unchanged instrument is not reset again');
});

// --- rigView: what the page shows of the setup file ---

test('rigView: absent and invalid files give their own small views', () => {
  const r = makeResetRig({ rig: { setup: 'absent' } });
  assert.deepEqual(r.out.rigView(), { setup: 'absent' });
  const problems = [{ field: 'instruments[0].port', reason: 'required' }];
  r.out.setRig({ setup: 'invalid', problems, more: 2 });
  assert.deepEqual(r.out.rigView(), { setup: 'invalid', problems, more: 2 });
});

test('rigView: an unreadable or build-mismatch rig carries its flag, a plain invalid rig has no flag key', () => {
  const r = makeResetRig({ rig: { setup: 'absent' } });
  r.out.setRig({ setup: 'invalid', unreadable: true, problems: [], more: 0 });
  assert.deepEqual(r.out.rigView(), { setup: 'invalid', problems: [], more: 0, unreadable: true });
  r.out.setRig({ setup: 'invalid', buildMismatch: true, problems: [], more: 0 });
  assert.deepEqual(r.out.rigView(), { setup: 'invalid', problems: [], more: 0, buildMismatch: true });
  r.out.setRig({ setup: 'invalid', problems: [], more: 1 });
  assert.deepEqual(Object.keys(r.out.rigView()).sort(), ['more', 'problems', 'setup']);
});

test('rigView: before Web MIDI is enabled every instrument has no state, no reset and is not used', () => {
  const r = makeResetRig();
  const view = r.out.rigView();
  assert.equal(view.setup, 'valid');
  assert.deepEqual(
    view.instruments.map(({ id, port, state, matches, resetAt, used }) => ({ id, port, state, matches, resetAt, used })),
    [
      { id: 'plain', port: 'Port A', state: null, matches: [], resetAt: null, used: false },
      { id: 'bank', port: 'Port B', state: null, matches: [], resetAt: null, used: false },
    ],
  );
});

test('rigView: state, matches, the time of the last reset and the use follow the outputs, the resets and the playing code', async () => {
  const r = makeResetRig({ present: ['Port A', 'Port B'] });
  await r.out.enableIfGranted();
  await r.wait(100);
  const source = soundCode('Port A', 3, 'Alpha 1');
  await play(r.out, r.clock, source);
  r.out.recordSuccess(source);
  const first = r.out.rigView().instruments;
  assert.deepEqual(first.map((instrument) => [instrument.id, instrument.state, instrument.used]), [
    ['plain', 'connected', true],
    ['bank', 'connected', false],
  ]);
  assert.deepEqual(first[0].matches, ['Port A']);
  const firstReset = first[0].resetAt;
  assert.equal(typeof firstReset, 'number');
  // The unplugged instrument is told apart from a never-seen one by the page-session memory, and keeps its reset time.
  r.unplug('Port A');
  const unplugged = r.out.rigView().instruments;
  assert.equal(unplugged[0].state, 'unplugged');
  assert.deepEqual(unplugged[0].matches, []);
  assert.equal(unplugged[0].resetAt, firstReset);
  // A reconnect resets again: the time moves to the new reset.
  await r.wait(1000);
  r.plug('Port A');
  await r.wait(500);
  await r.wait(100);
  const back = r.out.rigView().instruments[0];
  assert.equal(back.state, 'connected');
  assert.ok(back.resetAt > firstReset, `${back.resetAt} should be later than ${firstReset}`);
});

test('rigView: a port that was never seen is not found, and a port that several outputs contain is ambiguous', async () => {
  const rig = {
    setup: 'valid',
    instruments: [instrumentOf('gone', 'Nowhere', 'none'), instrumentOf('many', 'Port', 'none')],
  };
  const r = makeResetRig({ present: ['Port A', 'Port B'], rig });
  await r.out.enableIfGranted();
  const [gone, many] = r.out.rigView().instruments;
  assert.equal(gone.state, 'not-found');
  assert.equal(many.state, 'ambiguous');
  assert.deepEqual(many.matches, ['Port A', 'Port B']);
});

// --- Muting or removing a MIDI track ends its notes ---

const SILENCE_CH3 = [[0xb2, 64, 0], [0xb2, 123, 0]];
const midiTrack = (label, port, channel, extra = '') => `${label}: note("c3")${extra}.midi('${port}', { midichannel: ${channel} })\n`;

test('muting the only track on a channel sends sustain off then All Notes Off on that channel, now and again after SILENCE_REPEAT_MS', () => {
  const { out, natives, clock } = makeSetupRig();
  out.recordSuccess(midiTrack('pad', 'Port A', 3));
  assert.deepEqual(bytesOf(natives[0]), [], 'a first evaluation stops nothing');
  out.recordSuccess(midiTrack('_pad', 'Port A', 3));
  assert.deepEqual(bytesOf(natives[0]), SILENCE_CH3);
  assert.ok(natives[0].sent.every((entry) => entry.argc === 1), 'no timestamp: it goes out at once');
  assert.deepEqual(natives[1].sent, [], 'no other port is touched');
  clock.advance(midiOutModule.SILENCE_REPEAT_MS - 1);
  assert.equal(natives[0].sent.length, 2, 'the second pass waits the whole repeat delay');
  clock.advance(1);
  assert.deepEqual(bytesOf(natives[0]), [...SILENCE_CH3, ...SILENCE_CH3]);
});

test('Stop still sends the 32 messages of its panic, built from the channel silence', () => {
  const { out, natives } = makeSetupRig();
  out.recordSuccess(midiTrack('pad', 'Port A', 3));
  out.panic();
  assert.deepEqual(bytesOf(natives[0]), PANIC);
  assert.equal(PANIC.length, 32);
  assert.deepEqual(PANIC.slice(4, 6), SILENCE_CH3);
});

/** Lets the awaited query of a targeted stop run to its end. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const bytesOn = (native) => bytesOf(native);
const has123 = (native, channel) => bytesOf(native).some((bytes) => bytes[0] === (0xb0 | (channel - 1)) && bytes[1] === 123);

test('removing a track silences its channel only, and a solo on another track does the same', () => {
  const both = midiTrack('pad', 'Port A', 3) + midiTrack('lead', 'Port A', 4);
  const removal = makeSetupRig();
  removal.out.recordSuccess(both);
  removal.out.recordSuccess(midiTrack('lead', 'Port A', 4));
  assert.deepEqual(bytesOn(removal.natives[0]), SILENCE_CH3);
  const solo = makeSetupRig();
  solo.out.recordSuccess(both);
  solo.out.recordSuccess(midiTrack('pad', 'Port A', 3) + midiTrack('S_lead', 'Port A', 4));
  assert.deepEqual(bytesOn(solo.natives[0]), SILENCE_CH3, 'channel 3 is silenced, channel 4 plays alone');
  assert.equal(has123(solo.natives[0], 4), false);
});

test('a track moved to another channel has its old channel silenced and the new one untouched', () => {
  const { out, natives } = makeSetupRig();
  out.recordSuccess(midiTrack('pad', 'Port A', 3));
  out.recordSuccess(midiTrack('pad', 'Port A', 5));
  assert.deepEqual(bytesOn(natives[0]), SILENCE_CH3);
  assert.equal(has123(natives[0], 5), false);
});

test('unmuting sends nothing and replays nothing', () => {
  const { out, natives, clock } = makeSetupRig();
  out.recordSuccess(midiTrack('_pad', 'Port A', 3));
  out.recordSuccess(midiTrack('pad', 'Port A', 3));
  clock.advance(1000);
  assert.deepEqual(natives[0].sent, []);
});

test('a $: track that edits its text is not a removal; with nothing left on its channel it is silenced', () => {
  const { out, natives } = makeSetupRig();
  out.recordSuccess(`$: note("c3 e3").midi('Port A', { midichannel: 3 })\n`);
  out.recordSuccess(`$: note("c3 g3").midi('Port A', { midichannel: 3 })\n`);
  assert.deepEqual(natives[0].sent, [], 'its identity changed with its text, but the channel is still played');
  out.recordSuccess(`beat: s("bd*4")\n`);
  assert.deepEqual(bytesOn(natives[0]), SILENCE_CH3);
});

test('a stopped page and a superseded tab send no stop, and a second pass scheduled before the role was lost sends nothing', () => {
  const stopped = makeSetupRig({ playing: false });
  stopped.out.recordSuccess(midiTrack('pad', 'Port A', 3));
  stopped.out.recordSuccess(midiTrack('_pad', 'Port A', 3));
  stopped.clock.advance(1000);
  assert.deepEqual(stopped.natives[0].sent, []);
  const superseded = makeSetupRig();
  superseded.out.recordSuccess(midiTrack('pad', 'Port A', 3));
  superseded.out.setActive(false);
  superseded.out.recordSuccess(midiTrack('_pad', 'Port A', 3));
  assert.deepEqual(superseded.natives[0].sent, []);
  const late = makeSetupRig();
  late.out.recordSuccess(midiTrack('pad', 'Port A', 3));
  late.out.recordSuccess(midiTrack('_pad', 'Port A', 3));
  late.out.setActive(false);
  late.clock.advance(midiOutModule.SILENCE_REPEAT_MS);
  assert.deepEqual(bytesOn(late.natives[0]), SILENCE_CH3, 'only the first pass went out');
});

test('a second pass leaves a channel alone when the page plays it again meanwhile', () => {
  const { out, natives, clock } = makeSetupRig();
  out.recordSuccess(midiTrack('pad', 'Port A', 3));
  out.recordSuccess(midiTrack('_pad', 'Port A', 3));
  out.recordSuccess(midiTrack('pad', 'Port A', 3));
  clock.advance(midiOutModule.SILENCE_REPEAT_MS);
  assert.deepEqual(bytesOn(natives[0]), SILENCE_CH3);
});

test('the stop goes only to the ports the stopped code named, never to every output', () => {
  const { out, natives } = makeSetupRig({ names: ['Port A', 'Port B', 'Other'] });
  out.recordSuccess(midiTrack('pad', 'Port B', 3));
  out.recordSuccess('');
  assert.deepEqual(natives[0].sent, []);
  assert.deepEqual(bytesOn(natives[1]), SILENCE_CH3);
  assert.deepEqual(natives[2].sent, []);
});

test('a removed track whose port the page cannot read is one logged line and sends nothing for it', () => {
  const { out, natives, errors } = makeSetupRig();
  out.recordSuccess(`const port = 'Port A'\nx: note("c3").midi(port)\n`);
  out.recordSuccess(`beat: s("bd*4")\n`);
  assert.deepEqual(natives[0].sent, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /"x"/);
});

test('a stop forgets the sustain the page sent on that channel, so a hold in the code is sent again', async () => {
  const { out, natives, clock } = makeSetupRig();
  const holder = (label) => `${label}: note("c3").midi('Port A', { midichannel: 3, controls: { hold: 127 } })\n`;
  const other = midiTrack('other', 'Port A', 3);
  const first = holder('hold') + other;
  await play(out, clock, first);
  out.recordSuccess(first);
  const holds = () => bytesOf(natives[0]).filter((bytes) => bytes[0] === 0xb2 && bytes[1] === 64 && bytes[2] === 127).length;
  assert.equal(holds(), 1);
  const second = holder('_hold');
  await play(out, clock, second);
  out.recordSuccess(second);
  assert.deepEqual(bytesOf(natives[0]).slice(-2), SILENCE_CH3, 'nothing plays channel 3 now');
  const third = holder('hold');
  await play(out, clock, third);
  out.recordSuccess(third);
  assert.equal(holds(), 2, 'the next evaluation of the hold track sends the pedal down again');
});

test('muting one of two tracks on a channel sends no channel silence, only its own note-offs, now and again', async () => {
  const kick = midiTrack('kick', 'Port A', 10);
  const hat = midiTrack('hat', 'Port A', 10);
  const asked = [];
  const haps = [
    { whole: { begin: 7.9, end: 8.4 }, value: { note: 'c2' }, duration: 0.5 },
    { whole: { begin: 8.1, end: 8.2 }, value: { note: 'd2' }, duration: 0.1 },
  ];
  const { out, natives, clock, errors } = makeSetupRig({
    options: {
      queryTrackPattern: async (code, index) => {
        asked.push({ code, index });
        return { queryArc: () => haps };
      },
      clock: () => ({ now: 8, cps: 0.5 }),
    },
  });
  out.recordSuccess(kick + hat);
  out.recordSuccess(`_kick: note("c3").midi('Port A', { midichannel: 10 })\n${hat}`);
  await settle();
  assert.deepEqual(asked, [{ code: kick + hat, index: 0 }], "the old code's own track is queried");
  assert.deepEqual(bytesOn(natives[0]), [[0x89, 36, 0], [0x89, 38, 0]]);
  assert.equal(has123(natives[0], 10), false);
  assert.equal(bytesOn(natives[0]).some((bytes) => bytes[1] === 64), false, 'no sustain release on a shared channel');
  clock.advance(midiOutModule.SILENCE_REPEAT_MS);
  assert.deepEqual(bytesOn(natives[0]), [[0x89, 36, 0], [0x89, 38, 0], [0x89, 36, 0], [0x89, 38, 0]]);
  assert.deepEqual(errors, []);
});

test('a targeted stop never reaches a second output that contains the port, and logs the cause once', async () => {
  const kick = midiTrack('kick', 'Port A', 10);
  const hat = midiTrack('hat', 'Port A', 10);
  const haps = [{ whole: { begin: 7.9, end: 8.4 }, value: { note: 'c2' }, duration: 0.5 }];
  const { out, natives, clock, errors } = makeSetupRig({
    names: ['Port A', 'Port A 2'],
    options: {
      queryTrackPattern: async () => ({ queryArc: () => haps }),
      clock: () => ({ now: 8, cps: 0.5 }),
    },
  });
  out.recordSuccess(kick + hat);
  out.recordSuccess(`_kick: note("c3").midi('Port A', { midichannel: 10 })\n${hat}`);
  await settle();
  clock.advance(midiOutModule.SILENCE_REPEAT_MS);
  assert.deepEqual(natives[0].sent, [], 'no note-off on either output');
  assert.deepEqual(natives[1].sent, []);
  assert.equal(errors.length, 1, 'one logged cause for both passes');
  assert.match(errors[0].text, /Port A/);
});

test('removing a track never sends channel silence to a second output that contains the port; Stop still silences both', () => {
  const { out, natives, clock, errors } = makeSetupRig({ names: ['Port A', 'Port A 2'] });
  out.recordSuccess(midiTrack('pad', 'Port A', 3) + midiTrack('lead', 'Port A', 4));
  out.recordSuccess(midiTrack('lead', 'Port A', 4));
  clock.advance(midiOutModule.SILENCE_REPEAT_MS);
  assert.deepEqual(natives[0].sent, [], 'no silence on either output, now or in the second pass');
  assert.deepEqual(natives[1].sent, []);
  assert.equal(errors.length, 1, 'one logged cause for both passes');
  assert.match(errors[0].text, /Port A/);
  out.panic();
  assert.deepEqual(bytesOf(natives[0]), PANIC, "Stop's panic keeps the broad rule");
  assert.deepEqual(bytesOf(natives[1]), PANIC);
});

test('a targeted stop with no query or no clock, a query that throws or a result that is no pattern is one logged line each', async () => {
  const kick = midiTrack('kick', 'Port A', 10);
  const hat = midiTrack('hat', 'Port A', 10);
  const muted = `_kick: note("c3").midi('Port A', { midichannel: 10 })\n${hat}`;
  const clockOption = { clock: () => ({ now: 8, cps: 0.5 }) };
  for (const [name, options] of [
    ['no query', clockOption],
    ['no clock', { queryTrackPattern: async () => ({ queryArc: () => [] }) }],
    ['a query that throws', { ...clockOption, queryTrackPattern: async () => { throw new Error('boom'); } }],
    ['no pattern', { ...clockOption, queryTrackPattern: async () => ({}) }],
  ]) {
    const { out, natives, errors } = makeSetupRig({ options });
    out.recordSuccess(kick + hat);
    out.recordSuccess(muted);
    await settle();
    assert.deepEqual(natives[0].sent, [], name);
    assert.equal(errors.length, 1, name);
  }
});

test('a targeted stop from a stopped page or a superseded tab, or after the role was lost, sends nothing', async () => {
  const kick = midiTrack('kick', 'Port A', 10);
  const hat = midiTrack('hat', 'Port A', 10);
  const muted = `_kick: note("c3").midi('Port A', { midichannel: 10 })\n${hat}`;
  const options = {
    queryTrackPattern: async () => ({ queryArc: () => [{ whole: { begin: 8, end: 8.1 }, value: { note: 'c2' }, duration: 0.1 }] }),
    clock: () => ({ now: 8, cps: 0.5 }),
  };
  const stopped = makeSetupRig({ playing: false, options });
  stopped.out.recordSuccess(kick + hat);
  stopped.out.recordSuccess(muted);
  await settle();
  assert.deepEqual(stopped.natives[0].sent, []);
  const lost = makeSetupRig({ options });
  lost.out.recordSuccess(kick + hat);
  lost.out.recordSuccess(muted);
  lost.out.setActive(false);
  await settle();
  assert.deepEqual(lost.natives[0].sent, [], 'the role went while the query ran');
});

test('installNoMidiShim makes .midi() a silent dominant trigger', () => {
  const marker = { marker: true };
  const calls = [];
  class FakePattern {
    onTrigger(...args) {
      calls.push(args);
      return marker;
    }
  }
  midiOutModule.installNoMidiShim(FakePattern);
  const result = new FakePattern().midi('Fake Synth A', { midichannel: 2 });
  assert.equal(result, marker);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, 'one argument only: the trigger stays dominant');
  assert.equal(typeof calls[0][0], 'function');
  assert.doesNotThrow(() => assert.equal(calls[0][0](1, 2, 3, 4), undefined));
});

test('installNoMidiShim refuses loudly without a Pattern class or its onTrigger', () => {
  for (const bad of [undefined, {}, class NoTrigger {}]) {
    assert.throws(() => midiOutModule.installNoMidiShim(bad), (err) => err instanceof Error && err.message.startsWith('Moontide:'));
  }
});

// --- The MIDI clock through createMidiOut: Start, Stop, joins and leaves ---

// A native that also records the fake time of each send.
class TimedNative extends FakeNative {
  constructor(id, name, time) {
    super(id, name);
    this.time = time;
  }
  send(data, ts) {
    super.send(...arguments);
    this.sent.at(-1).at = this.time.perfNow();
  }
}

const CLOCK_RIG = {
  setup: 'valid',
  instruments: [
    instrumentOf('seq', 'Port A', 'none', { clock: true }),
    instrumentOf('arp', 'Port B', 'none', { clock: true }),
    instrumentOf('pad', 'Port C', 'none'),
  ],
};
const NAMES_A = `seq: silence.midi('Port A', { midichannel: 3 })\n`;
const NAMES_B = `arp: silence.midi('Port B', { midichannel: 3 })\n`;
const NAMES_C = `pad: silence.midi('Port C', { midichannel: 3 })\n`;
const CLOCK_CPS = 100 / 4 / 60;

/**
 * A rig over the fake time of test/clock-fakes.js: every timer, the page clock and the reset flow run on it. Web MIDI
 * is enabled through enableIfGranted. `play(source)` is what the page does at a Play: the scheduler starts, then the
 * evaluation succeeds.
 */
async function makeClockRig({ rig = CLOCK_RIG, present = ['Port A', 'Port B', 'Port C'], twins = [], settle = 500, options = {} } = {}) {
  resetPageAlignment();
  const time = makeFakeTime();
  const ctx = makeFakeAudioContext(time);
  const cyclist = makeFakeCyclist(time, { cps: CLOCK_CPS });
  const natives = new Map();
  const native = (name) => {
    if (!natives.has(name)) natives.set(name, new TimedNative(`id-${natives.size}`, name, time));
    return natives.get(name);
  };
  const listeners = [];
  const webMidi = {
    enabled: false,
    outputs: [],
    _disconnectedOutputs: [],
    interface: { outputs: new Map(), addEventListener: (type, handler) => listeners.push({ type, handler }) },
  };
  const list = (name) => {
    const entry = native(name);
    webMidi.outputs.push(new FakeOutput(entry));
    webMidi.interface.outputs.set(entry.id, entry);
  };
  const unlist = (name) => {
    const entry = native(name);
    webMidi.outputs = webMidi.outputs.filter((output) => output.id !== entry.id);
    webMidi.interface.outputs.delete(entry.id);
  };
  for (const name of present) list(name);
  // A second port with the same name as a listed one (two identical interfaces): its own id, listed after the others.
  const twinNatives = twins.map((name, index) => {
    const entry = new TimedNative(`id-twin-${index}`, name, time);
    webMidi.outputs.push(new FakeOutput(entry));
    webMidi.interface.outputs.set(entry.id, entry);
    return entry;
  });
  const env = { playing: false };
  const errors = [];
  const infos = [];
  const states = [];
  const published = [];
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => {
      webMidi.enabled = true;
      return Promise.resolve();
    },
    queryPermission: () => Promise.resolve('granted'),
    supportsMidi: () => true,
    parse,
    isPlaying: () => env.playing,
    isHidden: () => false,
    publish: (facts) => {
      published.push(facts);
      return true;
    },
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    resetSettleMs: settle,
    now: time.perfNow,
    perfNow: time.perfNow,
    getScheduler: () => cyclist,
    getAudioContext: () => ctx,
    onClockState: () => states.push(time.perfNow()),
    onError: (text, err) => errors.push({ text, err }),
    onInfo: (text) => infos.push(text),
    ...options,
  });
  out.setRig(rig);
  await out.enableIfGranted();
  const r = {
    published,
    out,
    time,
    ctx,
    cyclist,
    env,
    errors,
    infos,
    native,
    twinNatives,
    webMidi,
    states,
    /** Advances the fake time and lets the promises that waited for it run. */
    async wait(ms) {
      time.advance(ms);
      await nextTick();
    },
    /** Advances in steps of `step` ms until `done()` holds (at most `maxMs`); returns whether it held. */
    async waitUntil(done, { step = 10, maxMs = 8000 } = {}) {
      for (let spent = 0; spent < maxMs; spent += step) {
        if (done()) return true;
        time.advance(step);
        await nextTick();
      }
      return done();
    },
    plug(name) {
      list(name);
      for (const listener of listeners) listener.handler({});
      time.advance(0);
    },
    unplug(name) {
      unlist(name);
      for (const listener of listeners) listener.handler({});
      time.advance(0);
    },
    /** A Play: the scheduler starts and the code is evaluated and recorded. */
    play(source) {
      env.playing = true;
      if (!cyclist.started) cyclist.start();
      out.recordSuccess(source);
    },
    /** What the page's stopSoundLocally does: the clock Stop, then the scheduler and the playing flag. */
    stop() {
      out.stopClock();
      env.playing = false;
      cyclist.stop();
    },
  };
  return r;
}

const isByte = (byte) => (entry) => entry.data.length === 1 && entry.data[0] === byte;
const startsOf = (native) => native.sent.filter(isByte(0xfa));
const stopsOf = (native) => native.sent.filter(isByte(0xfc));
const ticksOf = (native) => native.sent.filter(isByte(0xf8));
const isIntegralCycle = (value) => Math.abs(value - Math.round(value)) < 1e-6;
/** The clock bytes (0xf8, 0xfa, 0xfc) of a native after index `from`. */
const clockBytesAfter = (native, from) => native.sent.slice(from).filter((entry) => entry.data.length === 1 && [0xf8, 0xfa, 0xfc].includes(entry.data[0]));

test('Stop after the Start was reached sends exactly one Stop at once to the port and no tick after it; Play again gives one new Start on a cycle boundary, 0.5 ms before its first tick', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  r.play(NAMES_A);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 1, 'one Start');
  assert.ok(perfReached(r, startsOf(a)[0]), 'the Start was reached');
  r.stop();
  assert.equal(stopsOf(a).length, 1, 'exactly one Stop');
  const stop = stopsOf(a)[0];
  assert.equal(stop.argc, 1, 'the Stop has no timestamp');
  const stopIndex = a.sent.indexOf(stop);
  await r.wait(1000);
  assert.deepEqual(clockBytesAfter(a, stopIndex + 1), [], 'no tick, Start or second Stop after the Stop');
  assert.deepEqual(r.errors, []);
  // Play again: the scheduler starts again and the same code is evaluated again.
  const mark = a.sent.length;
  r.play(NAMES_A);
  await r.wait(3500);
  const fresh = startsOf(a).filter((entry) => a.sent.indexOf(entry) >= mark);
  assert.equal(fresh.length, 1, 'exactly one new Start');
  const firstTick = ticksOf(a).find((entry) => a.sent.indexOf(entry) > a.sent.indexOf(fresh[0]));
  assert.ok(Math.abs(firstTick.ts - fresh[0].ts - CLOCK_START_LEAD_MS) < 1e-6, 'the Start is 0.5 ms before its first tick');
  assert.ok(isIntegralCycle(r.cyclist.cycleAtPerf(firstTick.ts)), 'the first tick is on a cycle boundary');
  assert.equal(stopsOf(a).length, 1, 'no further Stop');
});

/** True when the clock's fake time has reached the timestamp of a queued message. */
function perfReached(r, entry) {
  return entry.ts !== undefined && r.time.perfNow() >= entry.ts;
}

test('onPageHide sends the Stop before the control changes of the panic on that native', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  r.play(NAMES_A);
  await r.wait(3000);
  r.out.onPageHide();
  const stopIndex = a.sent.findIndex(isByte(0xfc));
  const panicIndex = a.sent.findIndex((entry) => entry.data[0] >= 0xb0 && entry.data[0] <= 0xbf && entry.data[1] === 123);
  assert.ok(stopIndex >= 0, 'the Stop went out');
  assert.ok(panicIndex > stopIndex, 'the panic follows the Stop');
  assert.equal(stopsOf(a).length, 1);
  assert.deepEqual(r.errors, []);
});

test('setActive(false) sends one Stop per running port and no tick after it, a recordSuccess in that tab sends nothing, and setActive(true) while playing gets a new Start on the next boundary', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  const b = r.native('Port B');
  r.play(NAMES_A + NAMES_B);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 1);
  assert.equal(startsOf(b).length, 1);
  const marks = { a: a.sent.length, b: b.sent.length };
  r.out.setActive(false);
  assert.equal(stopsOf(a).length, 1, 'one Stop on Port A');
  assert.equal(stopsOf(b).length, 1, 'one Stop on Port B');
  await r.wait(800);
  const afterA = clockBytesAfter(a, marks.a);
  const afterB = clockBytesAfter(b, marks.b);
  assert.deepEqual(afterA.map((entry) => entry.data[0]), [0xfc], 'nothing but the Stop on Port A');
  assert.deepEqual(afterB.map((entry) => entry.data[0]), [0xfc], 'nothing but the Stop on Port B');
  r.out.recordSuccess(NAMES_A + NAMES_B);
  await r.wait(500);
  assert.equal(clockBytesAfter(a, marks.a).length, 1, 'a superseded tab sends nothing');
  r.out.setActive(true);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 2, 'a new Start after taking the role back');
  const tick = ticksOf(a).find((entry) => a.sent.indexOf(entry) > a.sent.indexOf(startsOf(a)[1]));
  assert.ok(isIntegralCycle(r.cyclist.cycleAtPerf(tick.ts)), 'on a cycle boundary');
  assert.deepEqual(r.errors, []);
});

test('code that no longer names Port A sends it one Stop at once and nothing to Port B, whose ticks continue', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  const b = r.native('Port B');
  r.play(NAMES_A + NAMES_B);
  await r.wait(3000);
  const marks = { a: a.sent.length, b: b.sent.length };
  r.out.recordSuccess(NAMES_B);
  assert.equal(stopsOf(a).length, 1, 'the Stop is sent at once, in the same call');
  assert.equal(stopsOf(a)[0].argc, 1);
  await r.wait(1000);
  assert.deepEqual(clockBytesAfter(a, marks.a).map((entry) => entry.data[0]), [0xfc]);
  const bAfter = clockBytesAfter(b, marks.b);
  assert.ok(bAfter.length > 20, 'the ticks of Port B continue');
  assert.equal(bAfter.filter((entry) => entry.data[0] !== 0xf8).length, 0, 'no Start or Stop on Port B');
  assert.deepEqual(r.errors, []);
});

test('Stop while the Start is queued but not reached sends one Stop timestamped after the last queued message, and a port with no Start queued gets none', async () => {
  const r = await makeClockRig();
  const b = r.native('Port B');
  const c = r.native('Port C');
  r.play(NAMES_A);
  await r.wait(3000);
  // Port B joins mid-play: stop at once after its Start is queued but before it is reached.
  r.out.recordSuccess(NAMES_A + NAMES_B);
  let queued = null;
  for (let spent = 0; spent < 3000 && queued === null; spent += 10) {
    await r.wait(10);
    queued = startsOf(b)[0] ?? null;
  }
  assert.ok(queued, 'the Start of Port B was queued');
  assert.ok(queued.ts > r.time.perfNow(), 'not reached yet');
  r.out.stopClock();
  assert.equal(stopsOf(b).length, 1, 'one Stop');
  const stop = stopsOf(b)[0];
  assert.notEqual(stop.ts, undefined, 'timestamped, so it cannot overtake the Start');
  for (const entry of b.sent) if (entry !== stop && entry.ts !== undefined) assert.ok(stop.ts > entry.ts, 'after everything queued');
  // Port C follows no clock and Port A's run: a joining port whose Start is not planned yet gets no byte.
  const late = await makeClockRig();
  late.play(NAMES_A);
  await late.wait(3000);
  const lateB = late.native('Port B');
  late.out.recordSuccess(NAMES_A + NAMES_B);
  late.out.stopClock();
  assert.deepEqual(clockBytesAfter(lateB, 0), [], 'no Start queued, no Stop');
  assert.deepEqual(clockBytesAfter(c, 0), [], 'a port that follows no clock gets no clock byte');
});

// --- Joins, leaves and the note hold ---

const outputNamedIn = (r, name) => r.webMidi.outputs.find((output) => output.name === name);
const NOTE_ON = [0x92, 60, 100];
const NOTE_OFF = [0x82, 60, 0];
const CC_VOLUME = [0xb2, 7, 90];
const noteOnsOf = (native) => native.sent.filter((entry) => entry.data.length === 3 && entry.data[0] >= 0x90 && entry.data[0] <= 0x9f && entry.data[2] > 0);
const holdLines = (r) => r.infos.filter((line) => line.includes('wait for its MIDI clock Start'));

test('code that starts naming Port A mid-play reads waiting; its note-ons wait until 50 ms before its Start, note-offs and control changes pass, and one line is logged for the hold', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  const out = outputNamedIn(r, 'Port A');
  r.play(NAMES_B);
  await r.wait(3000);
  const mark = a.sent.length;
  r.out.recordSuccess(NAMES_B + NAMES_A);
  out.send(NOTE_ON);
  out.send(NOTE_ON);
  assert.deepEqual(noteOnsOf(a), [], 'the note-ons are dropped');
  assert.equal(holdLines(r).length, 1, 'one line for the whole hold, not one per note');
  assert.match(holdLines(r)[0], /^Moontide: .*"seq".*"Port A".*wait for its MIDI clock Start on the next cycle\.$/);
  out.send(NOTE_OFF);
  out.send(CC_VOLUME);
  assert.deepEqual(a.sent.slice(mark).map((entry) => entry.data), [NOTE_OFF, CC_VOLUME], 'a note-off and a control change are never held');
  assert.ok(await r.waitUntil(() => startsOf(a).length === 1), 'the Start was queued');
  const start = startsOf(a)[0];
  assert.ok(start.ts - r.time.perfNow() > CLOCK_NOTE_LEAD_MS, 'the Start is still more than the lead away');
  out.send(NOTE_ON);
  assert.deepEqual(noteOnsOf(a), [], 'still held once the Start is queued');
  r.time.advance(Math.ceil(start.ts - CLOCK_NOTE_LEAD_MS - r.time.perfNow()));
  out.send(NOTE_ON);
  assert.equal(noteOnsOf(a).length, 1, 'the note passes from 50 ms before the Start');
  assert.ok(noteOnsOf(a)[0].at >= start.ts - CLOCK_NOTE_LEAD_MS);
  assert.equal(holdLines(r).length, 1);
  assert.ok(isIntegralCycle(r.cyclist.cycleAtPerf(start.ts + CLOCK_START_LEAD_MS)), 'the Start is on a cycle boundary');
  assert.deepEqual(r.errors, []);
});

test('a second hold on the same port logs its own single line again', async () => {
  const r = await makeClockRig();
  const out = outputNamedIn(r, 'Port A');
  r.play(NAMES_B);
  await r.wait(3000);
  r.out.recordSuccess(NAMES_B + NAMES_A);
  out.send(NOTE_ON);
  out.send(NOTE_ON);
  assert.equal(holdLines(r).length, 1);
  assert.ok(await r.waitUntil(() => r.states.length > 0 && startsOf(r.native('Port A')).length === 1));
  r.out.recordSuccess(NAMES_B);
  r.out.recordSuccess(NAMES_B + NAMES_A);
  out.send(NOTE_ON);
  out.send(NOTE_ON);
  assert.equal(holdLines(r).length, 2, 'the next hold logs its own line');
});

test('a fresh Play whose Start goes with cycle 0 holds no note', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  r.play(NAMES_A);
  outputNamedIn(r, 'Port A').send(NOTE_ON);
  assert.equal(noteOnsOf(a).length, 1, 'the first beat is never lost');
  assert.deepEqual(holdLines(r), []);
});

test('the hold drops note-ons only: velocity 0, other messages, malformed data and a port that follows no clock pass', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  const c = r.native('Port C');
  r.play(NAMES_B + NAMES_C);
  await r.wait(3000);
  r.out.recordSuccess(NAMES_B + NAMES_C + NAMES_A);
  const out = outputNamedIn(r, 'Port A');
  out.send([0x92, 60, 0]);
  out.send([0xfe]);
  out.send([0xe2, 0, 64]);
  out.send(new Uint8Array([0x93, 61, 100]));
  out.send({ 0: 0x94, 1: 62, 2: 100, length: 3 });
  out.send([0x92, 60, '100']);
  out.send([0x92, 60]);
  const passed = a.sent.map((entry) => entry.data[0]);
  assert.ok(passed.includes(0xfe) && passed.includes(0xe2), 'active sensing and pitch bend messages pass');
  assert.equal(a.sent.filter((entry) => entry.data[0] === 0x92 && entry.data[2] === 0).length, 1, 'a note-on with velocity 0 is a note-off and passes');
  assert.equal(a.sent.filter((entry) => entry.data[0] === 0x93 || entry.data[0] === 0x94).length, 0, 'typed and array-like note-ons are dropped');
  assert.equal(a.sent.filter((entry) => entry.data[0] === 0x92 && entry.data[2] === '100').length, 1, 'a velocity that is not a number is not read as a note-on');
  outputNamedIn(r, 'Port C').send(NOTE_ON);
  assert.equal(noteOnsOf(c).length, 1, 'a port that follows no clock is never held');
  assert.deepEqual(r.errors, []);
});

test('a muted track still names its instrument: _seq:, seq_: and a track silenced by another track\'s solo keep Port A clocked', async () => {
  const sources = [
    `_seq: silence.midi('Port A', { midichannel: 3 })\n`,
    `seq_: silence.midi('Port A', { midichannel: 3 })\n`,
    `Solo: note("c3").midi('Port B', { midichannel: 1 })\nseq: silence.midi('Port A', { midichannel: 3 })\n`,
  ];
  for (const source of sources) {
    const r = await makeClockRig();
    r.play(source);
    await r.wait(3500);
    assert.equal(startsOf(r.native('Port A')).length, 1, source);
    assert.ok(ticksOf(r.native('Port A')).length > 10, source);
  }
});

test('a port held after a replug gets no Start until its second setup is out, then a Start on a cycle boundary, with its note-ons held until then', async () => {
  const rig = {
    setup: 'valid',
    instruments: [instrumentOf('seq', 'Port A', 'none', { clock: true, reset: { messages: RESET_A, waitMs: 100 } }), instrumentOf('arp', 'Port B', 'none', { clock: true })],
  };
  const r = await makeClockRig({ rig, present: ['Port A', 'Port B'] });
  const a = r.native('Port A');
  await r.wait(200);
  r.play(NAMES_A + NAMES_B);
  await r.wait(3500);
  assert.equal(startsOf(a).length, 1);
  const mark = a.sent.length;
  r.unplug('Port A');
  r.plug('Port A');
  const volumeBursts = () => a.sent.slice(mark).filter((entry) => entry.data[0] === 0xb2 && entry.data[1] === 7).length;
  const freshStarts = () => startsOf(a).filter((entry) => a.sent.indexOf(entry) >= mark);
  let sawEarlyStart = false;
  assert.ok(
    await r.waitUntil(
      () => {
        if (freshStarts().length > 0 && volumeBursts() < 2) sawEarlyStart = true;
        return volumeBursts() === 2;
      },
      { step: 10, maxMs: 4000 },
    ),
    'the second setup went out',
  );
  assert.equal(sawEarlyStart, false, 'no Start during the hold or the reset');
  assert.equal(freshStarts().length, 0, 'no Start has been queued yet');
  outputNamedIn(r, 'Port A').send(NOTE_ON);
  assert.deepEqual(noteOnsOf(a).filter((entry) => a.sent.indexOf(entry) >= mark), [], 'the note-ons wait for the Start');
  assert.ok(holdLines(r).length >= 1);
  assert.ok(await r.waitUntil(() => freshStarts().length === 1, { maxMs: 6000 }), 'a Start on the next boundary');
  assert.ok(a.sent.indexOf(freshStarts()[0]) > a.sent.findLastIndex((entry) => entry.data[0] === 0xb2 && entry.data[1] === 7), 'after the second setup');
  assert.ok(isIntegralCycle(r.cyclist.cycleAtPerf(freshStarts()[0].ts + CLOCK_START_LEAD_MS)));
  assert.deepEqual(r.errors, []);
});

test('a rig edit that turns a clock on mid-play starts it on the next boundary; turning it off, removing it, moving its port, or an invalid or absent rig sends one Stop at once', async () => {
  const withSeq = (rest) => ({ setup: 'valid', instruments: [instrumentOf('seq', 'Port A', 'none', rest), instrumentOf('arp', 'Port B', 'none', { clock: true })] });
  const edits = [
    ['clock turned off', withSeq({})],
    ['instrument removed', { setup: 'valid', instruments: [instrumentOf('arp', 'Port B', 'none', { clock: true })] }],
    ['port changed', { setup: 'valid', instruments: [instrumentOf('seq', 'Port C', 'none', { clock: true }), instrumentOf('arp', 'Port B', 'none', { clock: true })] }],
    ['rig invalid', { setup: 'invalid', problems: [], more: 0 }],
    ['rig absent', { setup: 'absent' }],
  ];
  for (const [label, edited] of edits) {
    const r = await makeClockRig({ rig: withSeq({ clock: true }) });
    const a = r.native('Port A');
    r.play(NAMES_A + NAMES_B);
    await r.wait(3500);
    assert.equal(startsOf(a).length, 1, label);
    r.out.setRig(edited);
    assert.equal(stopsOf(a).length, 1, `${label}: one Stop at once`);
    assert.equal(stopsOf(a)[0].argc, 1, label);
    await r.wait(500);
    assert.equal(stopsOf(a).length, 1, label);
  }
  // Turned on mid-play: waiting, then one Start on the next boundary.
  const r = await makeClockRig({ rig: withSeq({}) });
  const a = r.native('Port A');
  r.play(NAMES_A + NAMES_B);
  await r.wait(3000);
  assert.deepEqual(clockBytesAfter(a, 0), []);
  r.out.setRig(withSeq({ clock: true }));
  assert.ok(await r.waitUntil(() => startsOf(a).length === 1), 'a Start went out');
  assert.ok(isIntegralCycle(r.cyclist.cycleAtPerf(startsOf(a)[0].ts + CLOCK_START_LEAD_MS)), 'on a cycle boundary');
});

// --- Strudel's clock and transport never reach a port ---

const TRANSPORT_MESSAGES = [[0xf8], [0xfa], [0xfb], [0xfc], 0xf8, new Uint8Array([0xfc])];
const clockDroppedEvents = (r) => r.published.flatMap((facts) => facts.events).filter((event) => event.kind === 'clock-dropped');

test('each transport byte Strudel sends is dropped on a clock port, a port that follows no clock, and a page without a valid setup file', async () => {
  const rigs = [
    ['a valid setup file', CLOCK_RIG],
    ['no setup file', { setup: 'absent' }],
    ['an invalid setup file', { setup: 'invalid', problems: [{ field: 'instruments', reason: 'bad' }], more: 0 }],
  ];
  for (const [label, rig] of rigs) {
    const r = await makeClockRig({ rig });
    r.play(NAMES_C);
    for (const name of ['Port A', 'Port C']) {
      const before = r.native(name).sent.length;
      for (const message of TRANSPORT_MESSAGES) outputNamedIn(r, name).send(message);
      assert.deepEqual(r.native(name).sent.slice(before), [], `${label}, ${name}: nothing reaches the native`);
    }
    assert.deepEqual(r.errors, [], label);
  }
});

test('a note-on, a control change and a SysEx pass the transport rule, also a SysEx that holds a clock byte after its first', async () => {
  const r = await makeClockRig({ rig: { setup: 'absent' } });
  r.play(NAMES_C);
  const out = outputNamedIn(r, 'Port C');
  const before = r.native('Port C').sent.length;
  for (const message of [NOTE_ON, CC_VOLUME, [0xf0, 0x41, 0xf7], [0xf0, 0x7e, 0xf8, 0xfa, 0xfc, 0xf7]]) out.send(message);
  assert.equal(r.native('Port C').sent.length - before, 4);
  assert.equal(clockDroppedEvents(r).length, 0);
});

test("Moontide's own clock reaches the native of a clock port while the guard drops Strudel's", async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  r.play(NAMES_A);
  await r.wait(3000);
  const ticks = ticksOf(a).length;
  assert.equal(startsOf(a).length, 1, "Moontide's Start");
  assert.ok(ticks > 10, "Moontide's ticks");
  const out = outputNamedIn(r, 'Port A');
  out.send([0xfa]);
  out.send([0xf8]);
  out.send([0xfc]);
  assert.equal(startsOf(a).length, 1, "Strudel's Start never arrives");
  assert.equal(ticksOf(a).length, ticks, "Strudel's tick never arrives");
  assert.equal(stopsOf(a).length, 0, "Strudel's Stop never arrives");
});

test('0xF8 dropped 96 times for one code gives one clock-dropped event, published by a deferred timer and not inside the send call', async () => {
  const r = await makeClockRig();
  r.play(NAMES_A);
  const out = outputNamedIn(r, 'Port C');
  for (let index = 0; index < 96; index++) out.send([0xf8]);
  assert.equal(clockDroppedEvents(r).length, 0, 'nothing is published inside the send calls');
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 1, 'one event after the timer');
  for (let index = 0; index < 96; index++) out.send([0xf8]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 1, 'the next 96 drops add none');
  assert.deepEqual(r.errors, []);
});

test("a dropped Start counts only once the scheduler is at cycle 1 or later: Strudel's own Start at cycle 0 gives no clock-dropped event", async () => {
  const position = { now: 0.2 };
  const read = { clock: () => ({ now: position.now, cps: CLOCK_CPS }) };
  const r = await makeClockRig({ options: read });
  r.play(NAMES_A);
  const out = outputNamedIn(r, 'Port C');
  out.send([0xfa]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 0, 'now 0.2');
  position.now = 1.0;
  out.send([0xfa]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 1, 'now 1.0');
  // Without a readable position the Start is dropped quietly.
  const bare = await makeClockRig();
  bare.play(NAMES_A);
  outputNamedIn(bare, 'Port C').send([0xfa]);
  bare.time.advance(1);
  assert.equal(clockDroppedEvents(bare).length, 0, 'no clock option');
  const broken = await makeClockRig({ options: { clock: () => ({ now: Number.NaN, cps: CLOCK_CPS }) } });
  broken.play(NAMES_A);
  outputNamedIn(broken, 'Port C').send([0xfa]);
  broken.time.advance(1);
  assert.equal(clockDroppedEvents(broken).length, 0, 'a position that is not finite');
});

test("the documented limit: a Start Strudel itself sends once the scheduler is at cycle 1 or later gives the notice", async () => {
  // The guard cannot tell it from a written Start (reference/midi.md says so).
  const position = { now: 1.02 };
  const r = await makeClockRig({ options: { clock: () => ({ now: position.now, cps: CLOCK_CPS }) } });
  r.play(NAMES_A);
  outputNamedIn(r, 'Port C').send([0xfa]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 1);
  assert.equal(r.native('Port C').sent.filter((entry) => entry.data[0] === 0xfa).length, 0, 'the Start is dropped all the same');
});

test('the same code recorded again gives no new clock-dropped event; a different code that drops 0xFC gives one more', async () => {
  const r = await makeClockRig();
  const out = outputNamedIn(r, 'Port C');
  r.play(NAMES_A);
  out.send([0xfc]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 1);
  r.out.recordSuccess(NAMES_A);
  out.send([0xfc]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 1, 'the same code again');
  r.out.recordSuccess(NAMES_A + NAMES_C);
  out.send([0xfc]);
  r.time.advance(1);
  assert.equal(clockDroppedEvents(r).length, 2, 'a different code');
});

// --- rigView and onClockState: the clock state of each instrument for the popover ---

const clockViewOf = (r) => Object.fromEntries(r.out.rigView().instruments.map((instrument) => [instrument.id, instrument.clock]));

test('rigView gives each instrument its clock state: none before any play, running after the Start, none again after Stop; onClockState fires per change, never per tick', async () => {
  const r = await makeClockRig();
  assert.deepEqual(clockViewOf(r), { seq: 'none', arp: 'none', pad: 'none' }, 'nothing plays yet');
  r.play(NAMES_A + NAMES_C);
  await r.wait(3500);
  assert.equal(startsOf(r.native('Port A')).length, 1);
  // The clock instrument that is named runs; the one the code does not name and the one without the flag read none.
  assert.deepEqual(clockViewOf(r), { seq: 'running', arp: 'none', pad: 'none' });
  const changes = r.states.length;
  assert.ok(changes >= 1, 'the Start being reached was announced');
  await r.wait(5000);
  assert.ok(ticksOf(r.native('Port A')).length > 100, 'the ticks kept going');
  assert.equal(r.states.length, changes, 'no call per tick');
  r.stop();
  assert.deepEqual(clockViewOf(r), { seq: 'none', arp: 'none', pad: 'none' }, 'Stop takes the state away');
  assert.ok(r.states.length > changes, 'the Stop was announced');
  assert.deepEqual(r.errors, []);
});

test('rigView: an instrument that joins mid-play is waiting until its Start, then running, and each change is announced once', async () => {
  const r = await makeClockRig();
  r.play(NAMES_B);
  await r.wait(3500);
  assert.deepEqual(clockViewOf(r), { seq: 'none', arp: 'running', pad: 'none' });
  const before = r.states.length;
  r.out.recordSuccess(NAMES_B + NAMES_A);
  assert.deepEqual(clockViewOf(r), { seq: 'waiting', arp: 'running', pad: 'none' }, 'the Start waits for the next cycle');
  assert.ok(r.states.length > before, 'the wait was announced');
  const afterJoin = r.states.length;
  assert.ok(await r.waitUntil(() => clockViewOf(r).seq === 'running', { maxMs: 6000 }), 'then running');
  assert.ok(r.states.length > afterJoin, 'the Start being reached was announced');
  assert.equal(clockViewOf(r).arp, 'running', 'the other instrument read on its own');
  assert.deepEqual(r.errors, []);
});

test('rigView: a clock instrument that is unplugged reads none, and a code that stops naming it reads none at once', async () => {
  const r = await makeClockRig();
  r.play(NAMES_A + NAMES_B);
  await r.wait(3500);
  assert.deepEqual(clockViewOf(r), { seq: 'running', arp: 'running', pad: 'none' });
  r.unplug('Port A');
  assert.equal(clockViewOf(r).seq, 'none', 'unplugged: nothing to receive a clock');
  assert.equal(clockViewOf(r).arp, 'running');
  r.plug('Port A');
  assert.ok(await r.waitUntil(() => clockViewOf(r).seq === 'running', { maxMs: 8000 }), 'it comes back running');
  r.out.recordSuccess(NAMES_B);
  assert.equal(clockViewOf(r).seq, 'none', 'the code no longer names it');
  assert.equal(clockViewOf(r).arp, 'running');
});

test('rigView: without a page clock, and with no valid rig, every clock state is none', async () => {
  const bare = await makeClockRig({ options: { getScheduler: undefined } });
  bare.play(NAMES_A);
  await bare.wait(3500);
  assert.deepEqual(clockViewOf(bare), { seq: 'none', arp: 'none', pad: 'none' });
  const absent = await makeClockRig({ rig: { setup: 'absent' } });
  assert.deepEqual(absent.out.rigView(), { setup: 'absent' });
});

// --- Notes leave ahead with a timestamp from the page clock ---

const NOTE_ON_C = [0x92, 60, 100];
const NOTE_OFF_C = [0x82, 60, 64];

/**
 * A fake of the part of Strudel the stamps touch, shaped like the pinned @strudel/midi 1.3.0: `.midi(port, options)`
 * registers one trigger with `this.onTrigger(fn)`; the trigger finds its device in WebMidi.outputs when it runs and
 * schedules a call of a method of that device at its target time (scheduleAtTime). `calls` holds the arguments of
 * every onTrigger call, `scheduled` the scheduled sends: { target, run }.
 */
function makeFakeStrudel(webMidi, sends = (device, hap, options) => device.playNote(hap.note, options.midichannel ?? 1, { duration: hap.duration })) {
  const calls = [];
  const scheduled = [];
  class Pattern {
    onTrigger(...args) {
      calls.push(args);
      return { trigger: args[0] };
    }
    midi(port, options = {}) {
      return this.onTrigger((hap, currentTime, cps, targetTime) => {
        const device = webMidi.outputs.find((output) => output.name.includes(port));
        scheduled.push({ target: targetTime, run: () => sends(device, hap, options) });
      });
    }
  }
  return { Pattern, calls, scheduled };
}

/** A clock rig whose page-wide alignment is warm (Port B's clock ran for 3 s) and whose fake Pattern has the stamps. */
async function makeStampRig({ sends, ...options } = {}) {
  const r = await makeClockRig(options);
  const strudel = makeFakeStrudel(r.webMidi, sends);
  r.out.installNoteStamps(strudel.Pattern);
  r.play(NAMES_B);
  await r.wait(3000);
  return { r, ...strudel };
}

/** Builds a pattern with `.midi(port, options)` on the fake Pattern and fires its trigger for a hap at audio time T. */
function fire(s, port, options, hap, T) {
  const pattern = new s.Pattern().midi(port, options);
  return pattern.trigger(hap, 0, CLOCK_CPS, T);
}

test('a Strudel note-on leaves NOTE_AHEAD_MS before the clock timestamp of its target time, its note-off a note length later', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  const outputsBefore = r.webMidi.outputs;
  const T = r.ctx.currentTime + 0.25;
  const ts = r.time.strudelPerf(T);
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, T);
  assert.equal(s.scheduled.length, 1);
  const expectedTarget = r.ctx.currentTime + (ts - r.time.perfNow() - midiOutModule.NOTE_AHEAD_MS) / 1000;
  assert.ok(Math.abs(s.scheduled[0].target - expectedTarget) < 1e-6, 'Strudel runs its sends NOTE_AHEAD_MS before the timestamp');
  // The trigger fires at its (moved) target time.
  r.time.advance(Math.round((s.scheduled[0].target - r.ctx.currentTime) * 1000));
  s.scheduled[0].run();
  const on = noteOnsOf(c);
  assert.equal(on.length, 1);
  assert.deepEqual(on[0].data, NOTE_ON_C);
  assert.equal(on[0].argc, 2);
  assert.ok(Math.abs(on[0].ts - ts) < 0.5, 'the note-on carries the clock timestamp of its target time');
  assert.ok(Math.abs(on[0].ts - on[0].at - midiOutModule.NOTE_AHEAD_MS) < 1, 'and leaves NOTE_AHEAD_MS before it');
  const off = c.sent.filter((entry) => entry.data[0] === 0x82);
  assert.equal(off.length, 1);
  assert.deepEqual(off[0].data, NOTE_OFF_C);
  assert.ok(Math.abs(off[0].ts - (on[0].ts + 200)) < 0.5, 'the note-off is a note length after the note-on');
  assert.equal(r.webMidi.outputs, outputsBefore, 'WebMidi.outputs is the same list again');
  assert.ok('value' in Object.getOwnPropertyDescriptor(r.webMidi, 'outputs'), 'and still an own data property');
  // A plain send with no stamped call in progress stays as it was.
  outputNamedIn(r, 'Port C').send(NOTE_ON_C);
  assert.equal(c.sent.at(-1).argc, 1);
  assert.deepEqual(r.errors, []);
});

const AHEAD = () => midiOutModule.NOTE_AHEAD_MS;
const moontideLines = (r) => r.errors.filter((entry) => typeof entry.text === 'string' && entry.text.startsWith('Moontide:'));
/** Advances the fake time to the moved target of a scheduled send and runs it, like Strudel's timer. */
function runScheduled(r, scheduled) {
  const wait = Math.round((scheduled.target - r.ctx.currentTime) * 1000);
  if (wait > 0) r.time.advance(wait);
  scheduled.run();
}

test('NOTE_AHEAD_MS is below the clock horizon minus the clock pass period', () => {
  assert.ok(AHEAD() < CLOCK_HORIZON_MS - CLOCK_INTERVAL_MS, `${AHEAD()} ms`);
});

test('a note whose target time has passed goes out at once with the moment it is sent as its timestamp, and keeps its length', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime - 0.1);
  assert.ok(Math.abs(s.scheduled[0].target - r.ctx.currentTime) < 1e-9, 'the moved target is now');
  runScheduled(r, s.scheduled[0]);
  const on = noteOnsOf(c)[0];
  assert.equal(on.ts, on.at, 'the note-on is stamped with the moment it was sent');
  const off = c.sent.find((entry) => entry.data[0] === 0x82);
  assert.equal(off.ts, on.ts + 200, 'the note-off comes a full note length later');
  // A callback that runs after its timestamp is late too.
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  r.time.advance(400);
  s.scheduled[1].run();
  const late = noteOnsOf(c)[1];
  assert.equal(late.ts, late.at, 'a send after its time is stamped with its send moment');
  assert.equal(c.sent.filter((entry) => entry.data[0] === 0x82)[1].ts, late.ts + 200);
  assert.deepEqual(r.errors, []);
});

test('without a timestamp (no warm-up yet, a suspended context, Web MIDI not enabled) the trigger runs unchanged and its messages go out without one', async () => {
  const cold = await makeClockRig();
  const coldStrudel = makeFakeStrudel(cold.webMidi);
  cold.out.installNoteStamps(coldStrudel.Pattern);
  const T = cold.ctx.currentTime + 0.25;
  fire(coldStrudel, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, T);
  assert.equal(coldStrudel.scheduled[0].target, T, 'its own target');
  coldStrudel.scheduled[0].run();
  assert.equal(noteOnsOf(cold.native('Port C'))[0].ts, false, 'no timestamp, as before');
  assert.deepEqual(cold.errors, []);

  const s = await makeStampRig();
  const { r } = s;
  r.webMidi.enabled = false;
  fire(s, 'Port C', { midichannel: 3 }, { note: 60 }, r.ctx.currentTime + 0.25);
  assert.equal(s.scheduled[0].target, r.ctx.currentTime + 0.25, 'Web MIDI is not enabled: unchanged');
  r.webMidi.enabled = true;
  r.ctx.suspend();
  const T2 = r.ctx.currentTime + 0.25;
  fire(s, 'Port C', { midichannel: 3 }, { note: 60 }, T2);
  assert.equal(s.scheduled[1].target, T2, 'a suspended context: unchanged');
  s.scheduled[1].run();
  assert.equal(noteOnsOf(r.native('Port C')).at(-1).ts, false);
  assert.deepEqual(r.errors, []);
});

test('every message kind of a stamped trigger carries the stamped time', async () => {
  const kinds = [[0xb2, 7, 90], [0xc2, 5], [0xf0, 0x41, 0x10, 0xf7], [0xe2, 0, 64], [0xd2, 40]];
  const s = await makeStampRig({ sends: (device) => kinds.forEach((data) => device.send(data, { time: false })) });
  const { r } = s;
  const T = r.ctx.currentTime + 0.25;
  const mark = r.native('Port C').sent.length;
  fire(s, 'Port C', {}, { note: 60 }, T);
  runScheduled(r, s.scheduled[0]);
  const sent = r.native('Port C').sent.slice(mark);
  assert.deepEqual(sent.map((entry) => entry.data), kinds);
  for (const entry of sent) assert.ok(Math.abs(entry.ts - r.time.strudelPerf(T)) < 0.5, `ts ${entry.ts}`);
  assert.deepEqual(r.errors, []);
});

test('a send whose time option is not recognized, and one that throws while it is rewritten, go out unstamped and say once that they arrive early', async () => {
  const time = { 'a string time': 'soon', 'a negative time': -5, 'an options array': [1, 2] };
  for (const [name, option] of Object.entries(time)) {
    const s = await makeStampRig({ sends: (device) => { device.send([0xb2, 7, 90], Array.isArray(option) ? option : { time: option }); device.send([0xb2, 7, 91], Array.isArray(option) ? option : { time: option }); } });
    const { r } = s;
    fire(s, 'Port C', {}, { note: 60 }, r.ctx.currentTime + 0.25);
    runScheduled(r, s.scheduled[0]);
    const sent = r.native('Port C').sent.filter((entry) => entry.data[0] === 0xb2 && entry.data[1] === 7 && [90, 91].includes(entry.data[2]));
    assert.equal(sent.length, 2, name);
    assert.ok(sent.every((entry) => entry.ts === false), `${name}: no timestamp`);
    assert.equal(moontideLines(r).length, 1, `${name}: one line for both sends`);
    assert.match(moontideLines(r)[0].text, /does not recognize.*early/, name);
  }
  const boom = await makeStampRig({ sends: (device) => device.send([0xb2, 7, 90], { get time() { throw new Error('boom'); } }) });
  fire(boom, 'Port C', {}, { note: 60 }, boom.r.ctx.currentTime + 0.25);
  assert.throws(() => runScheduled(boom.r, boom.scheduled[0]), /boom/);
  assert.match(moontideLines(boom.r)[0].text, /without one and arrives about 120 ms early/);
});

test('a timestamp more than NOTE_STAMP_MAX_AHEAD_MS ahead leaves the trigger unchanged and says so once', async () => {
  const s = await makeStampRig();
  const { r } = s;
  for (let count = 0; count < 2; count++) {
    const T = r.ctx.currentTime + 1.5;
    fire(s, 'Port C', { midichannel: 3 }, { note: 60 }, T);
    assert.equal(s.scheduled[count].target, T);
    s.scheduled[count].run();
    assert.equal(noteOnsOf(r.native('Port C'))[count].ts, false);
  }
  assert.equal(moontideLines(r).length, 1, 'one line, also after a second such trigger');
  assert.match(moontideLines(r)[0].text, /without a timestamp/);
});

test('noteStampOf gives the timestamp the port got for a stamped note, and null for a note sent without one', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const stamped = { note: 60, duration: 200 };
  const T = r.ctx.currentTime + 0.25;
  fire(s, 'Port C', { midichannel: 3 }, stamped, T);
  runScheduled(r, s.scheduled[0]);
  const on = noteOnsOf(r.native('Port C'))[0];
  assert.ok(Math.abs(r.out.noteStampOf(stamped) - on.ts) < 0.5, 'the stamp is the timestamp the port got');
  assert.ok(Math.abs(r.out.noteStampOf(stamped) - r.time.strudelPerf(T)) < 0.5);
  // A note that never went through a stamped trigger, and values that are not notes.
  assert.equal(r.out.noteStampOf({ note: 61 }), null);
  for (const bad of [null, undefined, 5, 'a']) assert.equal(r.out.noteStampOf(bad), null);
  // A stamp too far ahead goes out unstamped: no stamp is kept.
  const far = { note: 62 };
  fire(s, 'Port C', {}, far, r.ctx.currentTime + 1.5);
  assert.equal(r.out.noteStampOf(far), null);
  // Web MIDI not enabled, and a suspended context: no stamp either.
  r.webMidi.enabled = false;
  const disabled = { note: 63 };
  fire(s, 'Port C', {}, disabled, r.ctx.currentTime + 0.25);
  assert.equal(r.out.noteStampOf(disabled), null);
  r.webMidi.enabled = true;
  r.ctx.suspend();
  const suspended = { note: 64 };
  fire(s, 'Port C', {}, suspended, r.ctx.currentTime + 0.25);
  assert.equal(r.out.noteStampOf(suspended), null);
  // No page clock at all.
  const cold = await makeClockRig();
  const coldStrudel = makeFakeStrudel(cold.webMidi);
  cold.out.installNoteStamps(coldStrudel.Pattern);
  const coldHap = { note: 60 };
  fire(coldStrudel, 'Port C', {}, coldHap, cold.ctx.currentTime + 0.25);
  assert.equal(cold.out.noteStampOf(coldHap), null);
});

test('WebMidi.outputs that is not a list, and a stamp that throws, leave the trigger unchanged and say so once each', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const list = r.webMidi.outputs;
  r.webMidi.outputs = { find: (match) => list.find(match) };
  for (let count = 0; count < 2; count++) {
    const T = r.ctx.currentTime + 0.25;
    fire(s, 'Port C', {}, { note: 60 }, T);
    assert.equal(s.scheduled[count].target, T, 'unchanged');
  }
  r.webMidi.outputs = list;
  assert.equal(moontideLines(r).length, 1, 'once for the list');
  assert.match(moontideLines(r)[0].text, /^Moontide: WebMidi\.outputs is not a list/);
  const original = r.ctx.getOutputTimestamp;
  r.ctx.getOutputTimestamp = () => {
    throw new Error('no output timestamp');
  };
  for (let count = 2; count < 4; count++) {
    const T = r.ctx.currentTime + 0.25;
    fire(s, 'Port C', {}, { note: 60 }, T);
    assert.equal(s.scheduled[count].target, T, 'unchanged');
  }
  r.ctx.getOutputTimestamp = original;
  assert.equal(moontideLines(r).length, 2, 'once for the stamp');
});

test('WebMidi.outputs is shadowed only during the trigger: an own property is restored after a throw too, and a prototype getter leaves no own property', async () => {
  // The own data property, with a trigger that throws.
  const r = await makeClockRig();
  class Pattern {
    onTrigger(fn) {
      return { trigger: fn };
    }
    midi() {
      return this.onTrigger(() => {
        throw new Error('strudel broke');
      });
    }
  }
  r.out.installNoteStamps(Pattern);
  r.play(NAMES_B);
  await r.wait(3000);
  const list = r.webMidi.outputs;
  const before = Object.getOwnPropertyDescriptor(r.webMidi, 'outputs');
  assert.throws(() => new Pattern().midi().trigger({}, 0, CLOCK_CPS, r.ctx.currentTime + 0.25), /strudel broke/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(r.webMidi, 'outputs'), before, 'same value and attributes');
  assert.equal(r.webMidi.outputs, list);
  // A prototype getter, as the real webmidi has it.
  const s = await makeStampRig();
  const real = s.r.webMidi.outputs;
  delete s.r.webMidi.outputs;
  Object.setPrototypeOf(s.r.webMidi, Object.create(Object.prototype, { outputs: { get: () => real, configurable: true } }));
  const T = s.r.ctx.currentTime + 0.25;
  fire(s, 'Port C', { midichannel: 3 }, { note: 60 }, T);
  assert.equal(Object.getOwnPropertyDescriptor(s.r.webMidi, 'outputs'), undefined, 'no own property is left');
  assert.equal(s.r.webMidi.outputs, real);
  runScheduled(s.r, s.scheduled[0]);
  assert.ok(Math.abs(noteOnsOf(s.r.native('Port C'))[0].ts - s.r.time.strudelPerf(T)) < 0.5, 'the shadow gave the proxies');
  assert.deepEqual(s.r.errors, []);
});

test('installNoteStamps refuses loudly without a Pattern class, its onTrigger or its midi, and a second time; the view hands onTrigger one argument', async () => {
  const r = await makeClockRig();
  class NoOnTrigger {
    midi() {}
  }
  class NoMidi {
    onTrigger() {}
  }
  for (const bad of [undefined, {}, NoOnTrigger, NoMidi]) {
    assert.throws(() => r.out.installNoteStamps(bad), (err) => err instanceof Error && err.message.startsWith('Moontide:'));
  }
  const strudel = makeFakeStrudel(r.webMidi);
  r.out.installNoteStamps(strudel.Pattern);
  assert.throws(() => r.out.installNoteStamps(strudel.Pattern), (err) => err instanceof Error && err.message.startsWith('Moontide:'));
  new strudel.Pattern().midi('Port C');
  assert.equal(strudel.calls.length, 1);
  assert.equal(strudel.calls[0].length, 1, 'one argument: the trigger stays dominant');
  new strudel.Pattern().onTrigger(() => {}, false);
  assert.equal(strudel.calls[1].length, 2, 'a trigger that is not from .midi() is not touched');
});

test('a stamped message is still dropped by the transport rule, the stale-channel rule and the reconnect hold', async () => {
  // The transport rule.
  const transport = await makeStampRig({ sends: (device) => device.send([0xfa], { time: false }) });
  const transportMark = transport.r.native('Port C').sent.length;
  fire(transport, 'Port C', {}, { note: 60 }, transport.r.ctx.currentTime + 0.25);
  runScheduled(transport.r, transport.scheduled[0]);
  assert.deepEqual(transport.r.native('Port C').sent.slice(transportMark), [], 'a stamped Start is dropped');
  // The stale-channel rule: a sound change while the old code's note is queued.
  const s = await makeStampRig();
  const { r } = s;
  const first = NAMES_B + soundCode('Port C', 3, 'Alpha 1');
  const playSetup = async (source) => {
    const plan = r.out.prepareSetup(source);
    assert.equal(plan.refusal, null, plan.refusal ?? '');
    const sending = plan.send();
    await r.wait(1000);
    await sending;
    plan.commit();
    return plan;
  };
  await playSetup(first);
  r.out.recordSuccess(first);
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 100 }, r.ctx.currentTime + 0.25);
  const mark = r.native('Port C').sent.length;
  await playSetup(NAMES_B + soundCode('Port C', 3, 'Alpha 2'));
  s.scheduled[0].run();
  assert.deepEqual(noteOnsOf(r.native('Port C')).filter((entry) => r.native('Port C').sent.indexOf(entry) >= mark), [], "the old code's stamped note is dropped");
  // The reconnect hold.
  r.unplug('Port C');
  r.plug('Port C');
  const heldMark = r.native('Port C').sent.length;
  fire(s, 'Port C', { midichannel: 3 }, { note: 62, duration: 100 }, r.ctx.currentTime + 0.25);
  s.scheduled[1].run();
  assert.deepEqual(noteOnsOf(r.native('Port C')).filter((entry) => r.native('Port C').sent.indexOf(entry) >= heldMark), [], 'held after the reconnect');
  assert.deepEqual(r.errors, []);
});

test('a joining clock instrument lets a stamped note-on pass from its Start, holds an earlier one, and keeps the 50 ms rule for one without a timestamp', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const a = r.native('Port A');
  r.out.recordSuccess(NAMES_B + NAMES_A);
  assert.ok(await r.waitUntil(() => startsOf(a).length === 1), 'the Start was queued');
  const start = startsOf(a)[0];
  assert.ok(start.ts - r.time.perfNow() > CLOCK_NOTE_LEAD_MS, 'the Start is further than the lead away');
  const tick = start.ts + CLOCK_START_LEAD_MS;
  // A note on the Start's tick, and one a tick (25 ms at this tempo) earlier.
  fire(s, 'Port A', { midichannel: 3 }, { note: 60, duration: 100 }, r.time.audioOfStrudelPerf(tick - 25));
  fire(s, 'Port A', { midichannel: 3 }, { note: 62, duration: 100 }, r.time.audioOfStrudelPerf(tick));
  s.scheduled[0].run();
  assert.deepEqual(noteOnsOf(a), [], 'the earlier note is held');
  s.scheduled[1].run();
  assert.equal(noteOnsOf(a).length, 1, 'the note of the Start tick passes while the Start is still ahead');
  assert.ok(noteOnsOf(a)[0].ts >= start.ts - CLOCK_STAMPED_NOTE_SLACK_MS);
  assert.ok(Math.abs(noteOnsOf(a)[0].ts - tick) < 0.5);
  // Without a timestamp (a plain send on the Output) the rule of 50 ms stays.
  outputNamedIn(r, 'Port A').send(NOTE_ON);
  assert.equal(noteOnsOf(a).length, 1, 'held: the Start is more than 50 ms away');
  assert.deepEqual(r.errors, []);
});

// --- The pre-warm: the first notes after a page load are stamped too ---

const withoutStamp = (r) => r.infos.filter((line) => /without a timestamp/.test(line));

// The timers a fresh rig holds before any evaluation: the watcher's, the clock's, nothing of the pre-warm.
const baselines = new WeakMap();
const baselineTimers = (r) => baselines.get(r);
async function makePrewarmRig(options) {
  const r = await makeClockRig(options);
  baselines.set(r, r.time.pendingTimers());
  return r;
}

test('preparing code with a .midi( call warms the page clock mapping within about 50 ms, so the first note after a page load is stamped', async () => {
  const r = await makePrewarmRig();
  const strudel = makeFakeStrudel(r.webMidi);
  r.out.installNoteStamps(strudel.Pattern);
  assert.equal(pageAlignment.ms, null, 'a fresh page: the alignment is not known');
  await r.out.beforeEvaluate(NAMES_C);
  assert.equal(pageAlignment.ms, null, 'one read so far');
  await r.wait(100);
  assert.notEqual(pageAlignment.ms, null, 'the alignment is known after 100 ms');
  assert.equal(r.time.pendingTimers(), baselineTimers(r), 'and the poll has ended');
  const T = r.ctx.currentTime + 0.25;
  fire(strudel, 'Port C', { midichannel: 3 }, { note: 60, duration: 100 }, T);
  runScheduled(r, strudel.scheduled[0]);
  const on = noteOnsOf(r.native('Port C'))[0];
  assert.ok(Math.abs(on.ts - r.time.strudelPerf(T)) < 0.5, 'the first note carries a timestamp');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(withoutStamp(r), []);
});

test('a context that cannot give a timestamp ends the pre-warm after 300 ms with exactly one info line per page session', async () => {
  const r = await makePrewarmRig();
  r.ctx.suspend();
  await r.out.beforeEvaluate(NAMES_C);
  assert.equal(r.time.pendingTimers(), baselineTimers(r) + 1, 'one poll timer');
  await r.wait(400);
  assert.equal(withoutStamp(r).length, 1);
  assert.match(withoutStamp(r)[0], /^Moontide: /);
  assert.equal(r.time.pendingTimers(), baselineTimers(r), 'the poll has ended');
  await r.out.beforeEvaluate(NAMES_C);
  await r.wait(400);
  assert.equal(withoutStamp(r).length, 1, 'a second evaluation does not say it again');
  assert.deepEqual(r.errors, []);
});

test('retireOutputs, setActive(false) and onPageHide cancel the pre-warm: no timer is left and no line follows', async () => {
  for (const cancel of [(r) => r.out.retireOutputs(), (r) => r.out.setActive(false), (r) => r.out.onPageHide()]) {
    const r = await makePrewarmRig();
    r.ctx.suspend();
    await r.out.beforeEvaluate(NAMES_C);
    assert.equal(r.time.pendingTimers(), baselineTimers(r) + 1);
    cancel(r);
    assert.equal(r.time.pendingTimers(), baselineTimers(r), 'the pending timer count is back to what it was');
    await r.wait(400);
    assert.deepEqual(withoutStamp(r), []);
    assert.deepEqual(r.errors, []);
  }
});

test('code without a .midi( call, and Web MIDI that is not enabled, start no pre-warm', async () => {
  const plain = await makePrewarmRig();
  plain.ctx.suspend();
  await plain.out.beforeEvaluate('s("bd*2")');
  assert.equal(plain.time.pendingTimers(), baselineTimers(plain));
  const unsupported = await makePrewarmRig({ options: { supportsMidi: () => false } });
  unsupported.ctx.suspend();
  await unsupported.out.beforeEvaluate(NAMES_C);
  assert.equal(unsupported.time.pendingTimers(), baselineTimers(unsupported), 'no pre-warm without Web MIDI');
  await unsupported.wait(400);
  assert.deepEqual(withoutStamp(unsupported), []);
  assert.deepEqual(unsupported.errors, []);
});

test('a stamp that throws during the pre-warm is one logged line and beforeEvaluate still resolves', async () => {
  const r = await makePrewarmRig();
  r.ctx.getOutputTimestamp = () => {
    throw new Error('no output timestamp');
  };
  await r.out.beforeEvaluate(NAMES_C);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].text, /^Moontide: MIDI preparation failed:/);
  assert.equal(r.time.pendingTimers(), baselineTimers(r), 'the pre-warm stopped');
  await r.wait(400);
  assert.equal(r.errors.length, 1);
});

// --- Stop ends the note-ons already queued ahead, before the panic ---

const QUEUED_OFF = () => midiOutModule.QUEUED_NOTE_OFF_AFTER_MS;
/** A Strudel note on `port` and `channel`, triggered 250 ms ahead and sent at its moved target: its note-on sits in the OS queue. */
function queueNote(s, port, channel, note, { duration = 200, ahead = 0.25 } = {}) {
  const T = s.r.ctx.currentTime + ahead;
  fire(s, port, { midichannel: channel }, { note, duration }, T);
  runScheduled(s.r, s.scheduled[s.scheduled.length - 1]);
  return noteOnsOf(s.r.native(port)).at(-1);
}
/** The note-offs of velocity 0 on a native: what the compensation sends (webmidi's own note-off carries velocity 64). */
const queuedOffsOf = (native) => native.sent.filter((entry) => entry.data.length === 3 && entry.data[0] >= 0x80 && entry.data[0] <= 0x8f && entry.data[2] === 0);
const entriesAfter = (native, entry) => native.sent.slice(native.sent.indexOf(entry) + 1);

test('Stop ends a note-on that is still queued: its note-off goes 1 ms after its timestamp, before the panic bytes, which stay as they were', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const on = queueNote(s, 'Port C', 3, 60);
  assert.ok(on.ts - r.time.perfNow() > 100, 'the note-on is queued well ahead');
  assert.equal(QUEUED_OFF(), 1);
  r.out.retireOutputs();
  r.out.panic();
  // After the note-on come webmidi's own note-off (velocity 64), then ours, then exactly the panic.
  const after = entriesAfter(c, on);
  assert.deepEqual(after[0].data, NOTE_OFF_C, "webmidi's own note-off");
  assert.deepEqual(after[1].data, [0x82, 60, 0]);
  assert.equal(after[1].argc, 2);
  assert.ok(Math.abs(after[1].ts - (on.ts + QUEUED_OFF())) < 1e-6, 'a millisecond after the note-on');
  assert.deepEqual(after.slice(2).map((entry) => entry.data), PANIC, 'the panic is exactly what it was');
  assert.ok(after.slice(2).every((entry) => entry.argc === 1), 'and carries no timestamp');
  assert.deepEqual(r.errors, []);
});

test('Stop does not end a queued note-on whose timestamp has passed, and ends nothing when nothing is queued', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  r.out.retireOutputs();
  assert.deepEqual(queuedOffsOf(c), [], 'nothing queued: nothing sent');
  const on = queueNote(s, 'Port C', 3, 60);
  await r.wait(on.ts - r.time.perfNow() + 5);
  const before = c.sent.length;
  r.out.retireOutputs();
  assert.equal(c.sent.length, before, 'the note already sounds: the panic ends it');
  assert.deepEqual(queuedOffsOf(c), []);
  assert.deepEqual(r.errors, []);
});

test('onPageHide ends the queued note-on before the panic too', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const on = queueNote(s, 'Port C', 3, 60);
  r.out.onPageHide();
  const after = entriesAfter(c, on);
  assert.deepEqual(after[1].data, [0x82, 60, 0]);
  assert.ok(Math.abs(after[1].ts - (on.ts + QUEUED_OFF())) < 1e-6);
  assert.deepEqual(after.slice(2).map((entry) => entry.data), PANIC);
  assert.deepEqual(r.errors, []);
});

test('two queued note-ons on two ports both get their note-off; a port that throws is logged once by name and the other port and the panic still go out', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const b = r.native('Port B');
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const onB = queueNote(s, 'Port B', 3, 62);
  const onC = queueNote(s, 'Port C', 3, 60, { ahead: 0.13 });
  b.failing = true;
  r.out.retireOutputs();
  r.out.panic();
  assert.deepEqual(queuedOffsOf(c).map((entry) => entry.data), [[0x82, 60, 0]], 'Port C got its note-off');
  assert.ok(Math.abs(queuedOffsOf(c)[0].ts - (onC.ts + QUEUED_OFF())) < 1e-6);
  assert.deepEqual(entriesAfter(c, onC).slice(2).map((entry) => entry.data), PANIC, 'and its panic');
  const lines = moontideLines(r).filter((entry) => /could not end a queued note on MIDI port "Port B"/.test(entry.text));
  assert.equal(lines.length, 1, 'one line naming the port');
  assert.ok(onB.ts > 0);
  b.failing = false;
  assert.deepEqual(queuedOffsOf(b), [], 'nothing reached the port that throws');
});

test('a port that throws logs one line however many note-ons are queued on it, and the record of it is still emptied', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const T = r.ctx.currentTime + 0.25;
  for (const note of [60, 62, 64]) fire(s, 'Port C', { midichannel: 3 }, { note, duration: 200 }, T);
  for (const item of s.scheduled) runScheduled(r, item);
  assert.equal(noteOnsOf(c).length, 3, 'three note-ons are queued');
  c.failing = true;
  r.out.retireOutputs();
  c.failing = false;
  assert.equal(moontideLines(r).filter((entry) => /could not end a queued note on MIDI port "Port C"/.test(entry.text)).length, 1, 'one line for three notes');
  const before = c.sent.length;
  r.out.retireOutputs();
  assert.equal(c.sent.length, before, 'nothing is left to end');
});

test('after Stop the record is empty: a second retireOutputs sends nothing', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  queueNote(s, 'Port C', 3, 60);
  r.out.retireOutputs();
  assert.equal(queuedOffsOf(c).length, 1);
  const before = c.sent.length;
  r.out.retireOutputs();
  assert.equal(c.sent.length, before);
  assert.deepEqual(r.errors, []);
});

test('a dropped stamped note-on and a send that throws are not recorded: Stop sends no note-off for them', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  // A send that throws.
  c.failing = true;
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 100 }, r.ctx.currentTime + 0.25);
  assert.throws(() => runScheduled(r, s.scheduled[0]), /InvalidStateError/);
  c.failing = false;
  // A dropped note-on: the reconnect hold of Port C.
  r.unplug('Port C');
  r.plug('Port C');
  fire(s, 'Port C', { midichannel: 3 }, { note: 62, duration: 100 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[1]);
  assert.deepEqual(noteOnsOf(c), [], 'neither note-on reached the port');
  r.out.retireOutputs();
  assert.deepEqual(queuedOffsOf(c), [], 'and so neither has a note-off');
});

test('two ports with the same name keep their queued note-ons apart: Stop ends each note on its own port', async () => {
  const s = await makeStampRig({ twins: ['Port C'] });
  const { r } = s;
  const first = r.native('Port C');
  const [second] = r.twinNatives;
  // A Pattern whose .midi(index) reaches a port by its index in WebMidi.outputs, as Strudel allows.
  const scheduled = [];
  class IndexPattern {
    onTrigger(...args) {
      return { trigger: args[0] };
    }
    midi(index, options = {}) {
      return this.onTrigger((hap, currentTime, cps, targetTime) => {
        const device = r.webMidi.outputs[index];
        scheduled.push({ target: targetTime, run: () => device.playNote(hap.note, options.midichannel ?? 1, { duration: hap.duration }) });
      });
    }
  }
  r.out.installNoteStamps(IndexPattern);
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const indexOf = (native) => r.webMidi.outputs.findIndex((output) => output.id === native.id);
  const T = r.ctx.currentTime + 0.25;
  for (const [native, note] of [[first, 60], [second, 62]]) new IndexPattern().midi(indexOf(native), { midichannel: 3 }).trigger({ note, duration: 200 }, 0, CLOCK_CPS, T);
  for (const item of scheduled) runScheduled(r, item);
  assert.equal(noteOnsOf(first).length, 1);
  assert.equal(noteOnsOf(second).length, 1);
  r.out.retireOutputs();
  assert.deepEqual(queuedOffsOf(first).map((entry) => entry.data), [[0x82, 60, 0]], 'the first port ends its own note only');
  assert.deepEqual(queuedOffsOf(second).map((entry) => entry.data), [[0x82, 62, 0]], 'the second port ends its own note too');
  assert.ok(Math.abs(queuedOffsOf(second)[0].ts - (noteOnsOf(second)[0].ts + QUEUED_OFF())) < 1e-6);
  assert.deepEqual(r.errors, []);
});

// --- A mute or a solo ends the note-ons already queued ahead ---

const padC = (label = 'pad', channel = 3) => `${label}: note("c3").midi('Port C', { midichannel: ${channel} })\n`;
const CH3_SILENCE = [[0xb2, 64, 0], [0xb2, 123, 0]];

test('muting a track ends the note-on queued on its channel first (a millisecond after its timestamp), then the channel silence untimed', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + padC());
  const on = queueNote(s, 'Port C', 3, 60);
  r.out.recordSuccess(NAMES_B + padC('_pad'));
  const after = entriesAfter(c, on);
  assert.deepEqual(after[0].data, NOTE_OFF_C, "webmidi's own note-off");
  assert.deepEqual(after[1].data, [0x82, 60, 0]);
  assert.equal(after[1].argc, 2);
  assert.ok(Math.abs(after[1].ts - (on.ts + QUEUED_OFF())) < 1e-6);
  assert.deepEqual(after.slice(2).map((entry) => entry.data), CH3_SILENCE);
  assert.ok(after.slice(2).every((entry) => entry.argc === 1), 'the silence itself carries no timestamp');
  assert.deepEqual(r.errors, []);
});

test('a note-on queued between the first and the second silence pass gets its note-off before the second silence', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + padC());
  r.out.recordSuccess(NAMES_B + padC('_pad'));
  const mutedAt = r.time.perfNow();
  await r.wait(80);
  const on = queueNote(s, 'Port C', 3, 62);
  const secondPassAt = mutedAt + midiOutModule.SILENCE_REPEAT_MS;
  assert.ok(r.time.perfNow() < secondPassAt && on.ts > secondPassAt, 'the note is queued before the second pass and sounds after it');
  const mark = c.sent.length;
  await r.wait(secondPassAt - r.time.perfNow());
  const second = c.sent.slice(mark);
  assert.ok(second.length >= 3, 'the second pass went out');
  assert.deepEqual(second[0].data, [0x82, 62, 0]);
  assert.ok(Math.abs(second[0].ts - (on.ts + QUEUED_OFF())) < 1e-6);
  assert.deepEqual(second.slice(1).map((entry) => entry.data), CH3_SILENCE);
  assert.deepEqual(r.errors, []);
});

test('a mute leaves the queued note-ons of another channel and of another port alone', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const b = r.native('Port B');
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + padC() + padC('lead', 4));
  queueNote(s, 'Port C', 3, 60);
  queueNote(s, 'Port C', 4, 62, { ahead: 0.13 });
  queueNote(s, 'Port B', 3, 64, { ahead: 0.13 });
  r.out.recordSuccess(NAMES_B + padC('_pad') + padC('lead', 4));
  assert.deepEqual(queuedOffsOf(c).map((entry) => entry.data), [[0x82, 60, 0]], 'only channel 3 of Port C');
  assert.deepEqual(queuedOffsOf(b), [], 'Port B is not touched');
  assert.deepEqual(r.errors, []);
});

test('a track muted on a channel another track keeps playing ends only the queued note-ons with its own pitches, before its own note-offs', async () => {
  const haps = [{ whole: { begin: 7.9, end: 8.4 }, value: { note: 'c2' }, duration: 0.5 }];
  const s = await makeStampRig({ options: { queryTrackPattern: async () => ({ queryArc: () => haps }), clock: () => ({ now: 8, cps: 0.5 }) } });
  const { r } = s;
  const c = r.native('Port C');
  const both = NAMES_B + padC('kick') + padC('hat');
  r.out.recordSuccess(both);
  const kick = queueNote(s, 'Port C', 3, 36);
  queueNote(s, 'Port C', 3, 60, { ahead: 0.13 });
  r.out.recordSuccess(NAMES_B + padC('_kick') + padC('hat'));
  await settle();
  const offs = queuedOffsOf(c);
  assert.deepEqual(offs.map((entry) => entry.data), [[0x82, 36, 0], [0x82, 36, 0]], "the kick's queued note, then its own note-off");
  assert.equal(offs[0].argc, 2);
  assert.ok(Math.abs(offs[0].ts - (kick.ts + QUEUED_OFF())) < 1e-6);
  assert.equal(offs[1].argc, 1, "the track's own note-off carries no timestamp");
  assert.equal(c.sent.some((entry) => entry.data[1] === 64 || entry.data[1] === 123), false, 'no channel silence on a shared channel');
  assert.deepEqual(r.errors, []);
});

test('the second pass of a mute on a shared channel ends only the note-ons the old code triggered, never a later note of the track that keeps playing the same pitch', async () => {
  const haps = [{ whole: { begin: 7.9, end: 8.4 }, value: { note: 'c2' }, duration: 0.5 }];
  const s = await makeStampRig({ options: { queryTrackPattern: async () => ({ queryArc: () => haps }), clock: () => ({ now: 8, cps: 0.5 }) } });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + padC('kick') + padC('hat'));
  // Queued before the mute: the first pass ends it.
  const early = queueNote(s, 'Port C', 3, 36);
  // Triggered by the old code before the mute, but its send only runs after the first pass: the second pass ends it.
  fire(s, 'Port C', { midichannel: 3 }, { note: 36, duration: 100 }, r.ctx.currentTime + 0.35);
  const lateOld = s.scheduled[s.scheduled.length - 1];
  const takeoverAt = r.time.perfNow();
  r.out.recordSuccess(NAMES_B + padC('_kick') + padC('hat'));
  await settle();
  // The kept track triggers the same pitch after the takeover.
  await r.wait(1);
  fire(s, 'Port C', { midichannel: 3 }, { note: 36, duration: 100 }, r.ctx.currentTime + 0.32);
  const keeperNew = s.scheduled[s.scheduled.length - 1];
  assert.ok(keeperNew.target < lateOld.target, 'the keeper note is sent first, still before the second pass');
  runScheduled(r, keeperNew);
  runScheduled(r, lateOld);
  const newOn = noteOnsOf(c).at(-2);
  const oldOn = noteOnsOf(c).at(-1);
  const secondPassAt = takeoverAt + midiOutModule.SILENCE_REPEAT_MS;
  assert.ok(r.time.perfNow() < secondPassAt, 'both notes are sent before the second pass');
  assert.ok(newOn.ts > secondPassAt && oldOn.ts > secondPassAt, 'and both sound after it');
  await r.wait(secondPassAt - r.time.perfNow() + 1);
  const timed = queuedOffsOf(c).filter((entry) => entry.argc === 2);
  assert.equal(timed.length, 2, 'two compensating note-offs: the early note and the late old one');
  assert.ok(Math.abs(timed[0].ts - (early.ts + QUEUED_OFF())) < 1e-6, 'the first pass ended the early note');
  assert.ok(Math.abs(timed[1].ts - (oldOn.ts + QUEUED_OFF())) < 1e-6, 'the second pass ended the old code\'s late note');
  assert.ok(timed.every((entry) => Math.abs(entry.ts - (newOn.ts + QUEUED_OFF())) > 1e-6), "the kept track's later note got no note-off");
  assert.deepEqual(r.errors, []);
});

test('with two outputs that match the port a mute sends nothing, queued note-ons included, and says so once', async () => {
  const s = await makeStampRig({ present: ['Port A', 'Port B', 'Port C', 'Port C 2'] });
  const { r } = s;
  const c = r.native('Port C');
  const two = r.native('Port C 2');
  r.out.recordSuccess(NAMES_B + padC());
  const on = queueNote(s, 'Port C', 3, 60);
  r.out.recordSuccess(NAMES_B + padC('_pad'));
  assert.deepEqual(entriesAfter(c, on).map((entry) => entry.data), [NOTE_OFF_C], "only webmidi's own note-off");
  assert.deepEqual(two.sent, []);
  assert.equal(moontideLines(r).filter((entry) => /more than one MIDI output/.test(entry.text)).length, 1);
});

// --- A sound change lets the queued old notes finish with the old sound; a rollback never leaves the refused sound ---

const SOUND_CLOCK_RIG = {
  setup: 'valid',
  instruments: [instrumentOf('seq', 'Port A', 'none', { clock: true }), instrumentOf('arp', 'Port B', 'none', { clock: true }), instrumentOf('wide', 'Port C', 'msb-lsb')],
};
const soundOn = (channel, name, controls = '') => `note("c3").midi('Port C', { midichannel: ${channel}, sound: '${name}'${controls} })`;
const AFTER = () => midiOutModule.SETUP_AFTER_QUEUED_MS;

/** A stamp rig over SOUND_CLOCK_RIG whose Port C plays `first` (Alpha 1 on channel 3, plus `extra` lines) with its setup sent. */
async function makeSoundStampRig(extra = '', sends, options) {
  const s = await makeStampRig({ rig: SOUND_CLOCK_RIG, sends, options });
  const first = `${NAMES_B}${soundOn(3, 'Alpha 1')}\n${extra}`;
  const plan = s.r.out.prepareSetup(first);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  await s.r.wait(100);
  await sending;
  plan.commit();
  s.r.out.recordSuccess(first);
  return { ...s, first };
}

/** Prepares `source`, lets its send run up to its guard, and returns the plan, the bytes that went to Port C and the send promise. */
async function sendSetup(r, source) {
  const c = r.native('Port C');
  const mark = c.sent.length;
  const plan = r.out.prepareSetup(source);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  return { plan, sending, sent: () => c.sent.slice(mark) };
}

test('a sound change while old code plays times the bank select, the program change and the controls after the last note-on queued on that channel', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const on = queueNote(s, 'Port C', 3, 60);
  const change = await sendSetup(r, `${NAMES_B}${soundOn(3, 'Alpha 2', ', controls: { volume: 90 }')}`);
  const sent = change.sent();
  assert.deepEqual(sent.map((entry) => entry.data), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 1], [0xb2, 7, 90]], 'the same bytes in the same order as before');
  for (const entry of sent) {
    assert.equal(entry.argc, 2);
    assert.ok(Math.abs(entry.ts - (on.ts + AFTER())) < 1e-6, `ts ${entry.ts}`);
  }
  assert.equal(AFTER(), 0.5);
  await r.wait(100);
  await change.sending;
  assert.deepEqual(r.errors, []);
});

test('with no queued note-on on the changed channel (none, one that has passed, one on another channel) the same change goes out untimed', async () => {
  // None queued.
  const none = await makeSoundStampRig();
  const first = await sendSetup(none.r, `${NAMES_B}${soundOn(3, 'Alpha 2')}`);
  assert.deepEqual(first.sent().map((entry) => entry.data), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 1]]);
  assert.ok(first.sent().every((entry) => entry.argc === 1));
  // One whose timestamp has passed.
  const passed = await makeSoundStampRig();
  const on = queueNote(passed, 'Port C', 3, 60);
  await passed.r.wait(on.ts - passed.r.time.perfNow() + 5);
  const second = await sendSetup(passed.r, `${NAMES_B}${soundOn(3, 'Alpha 2')}`);
  assert.ok(second.sent().length >= 3 && second.sent().every((entry) => entry.argc === 1));
  // One on another channel.
  const other = await makeSoundStampRig();
  queueNote(other, 'Port C', 4, 60);
  const third = await sendSetup(other.r, `${NAMES_B}${soundOn(3, 'Alpha 2')}`);
  assert.ok(third.sent().length >= 3 && third.sent().every((entry) => entry.argc === 1));
  for (const rig of [none, passed, other]) assert.deepEqual(rig.r.errors, []);
});

test('only the channel whose sound changes is timed: a channel whose sound stays sends its controls untimed', async () => {
  const keep = soundOn(4, 'Bell 1', ', controls: { volume: 90 }');
  const s = await makeSoundStampRig(keep);
  const { r } = s;
  const on = queueNote(s, 'Port C', 3, 60);
  const change = await sendSetup(r, `${NAMES_B}${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 80 }')}`);
  const sent = change.sent();
  const channel3 = sent.filter((entry) => (entry.data[0] & 0x0f) === 2);
  const channel4 = sent.filter((entry) => (entry.data[0] & 0x0f) === 3);
  assert.ok(channel3.length >= 3 && channel3.every((entry) => entry.argc === 2 && Math.abs(entry.ts - (on.ts + AFTER())) < 1e-6));
  assert.deepEqual(channel4.map((entry) => entry.data), [[0xb3, 7, 80]]);
  assert.equal(channel4[0].argc, 1, 'a channel whose sound does not change is untimed');
  assert.deepEqual(r.errors, []);
});

test('nothing is timed when no old code plays', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  queueNote(s, 'Port C', 3, 60);
  r.env.playing = false;
  const change = await sendSetup(r, `${NAMES_B}${soundOn(3, 'Alpha 2')}`);
  assert.ok(change.sent().length >= 3 && change.sent().every((entry) => entry.argc === 1));
  // After a Stop the record is empty anyway.
  r.env.playing = true;
  r.out.retireOutputs();
  const after = await sendSetup(r, `${NAMES_B}${soundOn(3, 'Alpha 1')}`);
  assert.ok(after.sent().length >= 3 && after.sent().every((entry) => entry.argc === 1));
});

test('a rollback right after a timed change sends the previous sound and the resynced controls after that change; once its time has passed it sends them untimed', async () => {
  for (const waitMs of [70, 250]) {
    const s = await makeSoundStampRig();
    const { r } = s;
    const c = r.native('Port C');
    const on = queueNote(s, 'Port C', 3, 60);
    const change = await sendSetup(r, `${NAMES_B}${soundOn(3, 'Alpha 2', ', controls: { volume: 90 }')}`);
    await r.wait(waitMs);
    await change.sending;
    const changeAt = on.ts + AFTER();
    const mark = c.sent.length;
    await change.plan.rollback();
    const back = c.sent.slice(mark);
    assert.deepEqual(back.map((entry) => entry.data), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 0], [0xb2, 7, 100]], 'the previous sound, then the controls back to what the code writes');
    if (waitMs === 70) {
      assert.ok(changeAt > r.time.perfNow(), 'the change is still ahead');
      for (const entry of back) {
        assert.equal(entry.argc, 2);
        assert.ok(Math.abs(entry.ts - (changeAt + AFTER())) < 1e-6, `ts ${entry.ts}`);
      }
    } else {
      assert.ok(changeAt < r.time.perfNow(), 'the change has passed');
      assert.ok(back.every((entry) => entry.argc === 1), 'untimed once the change has passed');
    }
    assert.deepEqual(r.errors, []);
  }
});

// --- Control changes, pitch bend and SysEx queued ahead are compensated like notes ---

const QUEUED_SILENCE = () => midiOutModule.QUEUED_SILENCE_AFTER_MS;
/** What a hap of code like `note("c3").ccn(64).ccv(1)` sends: the pedal down, then the note. */
const pedalAndNote = (device, hap, options) => {
  device.send([0xb2, 64, 127], { time: false });
  device.playNote(hap.note, options.midichannel ?? 1, { duration: hap.duration });
};
/** The messages of a native after `entry` that carry a timestamp (the timed sustain release), as bytes with their time. */
const timedAfter = (native, entry) => entriesAfter(native, entry).filter((item) => item.argc === 2 && item.data[2] === 0 && item.data[0] >= 0xb0 && item.data[0] <= 0xbf);

const CH3_RELEASE = [[0xb2, 64, 0]];

test('Stop follows its panic with a timed sustain release after a control change that is still queued: a pedal pressed by the stopped code is released after it, and nothing cuts a later player', async () => {
  const s = await makeStampRig({ sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const T = r.ctx.currentTime + 0.25;
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, T);
  runScheduled(r, s.scheduled[0]);
  const pedal = c.sent.find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  assert.ok(pedal.ts - r.time.perfNow() > 100, 'the pedal is queued well ahead');
  r.out.retireOutputs();
  r.out.panic();
  const timed = entriesAfter(c, pedal).filter((entry) => entry.argc === 2 && entry.data.length === 3 && entry.data[0] >= 0xb0 && entry.data[0] <= 0xbf);
  assert.deepEqual(timed.map((entry) => entry.data), CH3_RELEASE, 'the sustain release of the pedal\'s channel only, with a timestamp: no All Notes Off that could cut the next player');
  for (const entry of timed) assert.ok(Math.abs(entry.ts - (pedal.ts + QUEUED_SILENCE())) < 1e-6, 'after the pedal went down');
  assert.deepEqual(queuedOffsOf(c).filter((entry) => entry.argc === 2).map((entry) => entry.data), [[0x82, 60, 0]], 'the note still gets its own note-off');
  const untimed = c.sent.filter((entry) => entry.argc === 1 && entry.data[0] >= 0xb0 && entry.data[0] <= 0xbf && (entry.data[1] === 64 || entry.data[1] === 123));
  assert.deepEqual(untimed.map((entry) => entry.data), PANIC, 'and the untimed panic is as it was');
  assert.deepEqual(r.errors, []);
});

test('a pitch bend queued ahead is covered too (its channel is released), a SysEx has no channel and gives none, and a note-off alone (the end of a long note) gives none', async () => {
  const kinds = {
    bend: { sends: (device) => device.send([0xe2, 0, 100], { time: false }), expected: CH3_RELEASE },
    sysex: { sends: (device) => device.send([0xf0, 0x41, 0x10, 0xf7], { time: false }), expected: [] },
  };
  for (const [name, { sends, expected }] of Object.entries(kinds)) {
    const s = await makeStampRig({ sends });
    const { r } = s;
    const c = r.native('Port C');
    r.out.recordSuccess(NAMES_B + NAMES_C);
    fire(s, 'Port C', {}, { note: 60 }, r.ctx.currentTime + 0.25);
    runScheduled(r, s.scheduled[0]);
    const message = c.sent.at(-1);
    r.out.retireOutputs();
    const timed = entriesAfter(c, message).filter((entry) => entry.argc === 2);
    assert.deepEqual(timed.map((entry) => entry.data), expected, name);
    assert.ok(timed.every((entry) => Math.abs(entry.ts - (message.ts + QUEUED_SILENCE())) < 1e-6), name);
  }
  // A long note: its webmidi note-off is queued far ahead, but a note-off is no reason for a timed release.
  const long = await makeStampRig();
  const c = long.r.native('Port C');
  long.r.out.recordSuccess(NAMES_B + NAMES_C);
  const on = queueNote(long, 'Port C', 3, 60, { duration: 5000 });
  long.r.out.retireOutputs();
  assert.deepEqual(timedAfter(c, on), [], 'no timed release');
});

test('a control change whose timestamp has passed, or that the same Stop already covered, gives no timed release', async () => {
  const s = await makeStampRig({ sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 100 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  const pedal = c.sent.find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64);
  await r.wait(pedal.ts - r.time.perfNow() + 5);
  const before = c.sent.length;
  r.out.retireOutputs();
  assert.equal(c.sent.length, before, 'the pedal already went down: the panic ends it');
  r.out.retireOutputs();
  assert.equal(c.sent.length, before, 'and the record is empty');
});

test('a mute follows the channel silence with a timed sustain release after a control change queued on that channel, and leaves another channel alone', async () => {
  const s = await makeStampRig({ sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + padC() + padC('lead', 4));
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  fire(s, 'Port C', { midichannel: 4 }, { note: 62, duration: 200 }, r.ctx.currentTime + 0.25);
  s.scheduled.forEach((item) => runScheduled(r, item));
  const pedal = c.sent.find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  const mark = c.sent.length;
  r.out.recordSuccess(NAMES_B + padC('_pad') + padC('lead', 4));
  const timed = c.sent.slice(mark).filter((entry) => entry.argc === 2 && entry.data[0] >= 0xb0 && entry.data[0] <= 0xbf);
  assert.deepEqual(timed.map((entry) => entry.data), CH3_RELEASE, 'the sustain release of channel 3 once more, with a timestamp, and no All Notes Off');
  for (const entry of timed) assert.ok(Math.abs(entry.ts - (pedal.ts + QUEUED_SILENCE())) < 1e-6);
  assert.deepEqual(c.sent.slice(mark).filter((entry) => entry.argc === 1).map((entry) => entry.data), CH3_SILENCE, 'the untimed silence is as it was');
  assert.deepEqual(r.errors, []);
});

test('a sound change times its setup after a control change queued on that channel, not only after a note-on', async () => {
  const bendOnly = (device) => device.send([0xb2, 7, 127], { time: false });
  const s = await makeSoundStampRig('', bendOnly);
  const { r } = s;
  const c = r.native('Port C');
  fire(s, 'Port C', { midichannel: 3 }, { note: 60 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  const cc = c.sent.at(-1);
  assert.deepEqual(cc.data, [0xb2, 7, 127]);
  const change = await sendSetup(r, `${NAMES_B}${soundOn(3, 'Alpha 2')}`);
  const sent = change.sent();
  assert.ok(sent.length >= 3);
  for (const entry of sent) {
    assert.equal(entry.argc, 2);
    assert.ok(Math.abs(entry.ts - (cc.ts + AFTER())) < 1e-6, `ts ${entry.ts}`);
  }
  await r.wait(100);
  await change.sending;
  assert.deepEqual(r.errors, []);
});

test('a port that fails its note-off and its timed sustain release logs one line by port name, not two', async () => {
  const s = await makeStampRig({ sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  c.failing = true;
  r.out.retireOutputs();
  c.failing = false;
  assert.equal(moontideLines(r).length, 1, moontideLines(r).map((entry) => entry.text).join(' | '));
  assert.match(moontideLines(r)[0].text, /MIDI port "Port C"/);
});

test('a timed sustain release that fails on its own is logged by port name', async () => {
  const s = await makeStampRig({ sends: (device) => device.send([0xb2, 64, 127], { time: false }) });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  fire(s, 'Port C', { midichannel: 3 }, { note: 60 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  c.failing = true;
  r.out.retireOutputs();
  c.failing = false;
  assert.equal(moontideLines(r).length, 1);
  assert.match(moontideLines(r)[0].text, /could not release the sustain on MIDI port "Port C"/);
});

// --- The timed sustain release never lifts a hold the page writes after it, nor cuts a later player ---

/** The moment a recorded send is delivered: its timestamp, or the moment of an untimed send. */
const deliveredAt = (entry) => (entry.argc === 2 ? entry.ts : entry.at);
/** The sustain messages (CC64) of channel 3 on a native, in the order the device receives them. */
const sustainInOrder = (native) =>
  native.sent
    .filter((entry) => entry.data.length === 3 && entry.data[0] === 0xb2 && entry.data[1] === 64)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => deliveredAt(a.entry) - deliveredAt(b.entry) || a.index - b.index)
    .map((item) => item.entry);

/** Runs a setup to its end the way the page does at a Play: send (the fake time runs), commit, then the evaluation succeeds. */
async function playSetup(r, source) {
  const plan = r.out.prepareSetup(source);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  await r.wait(100);
  await sending;
  plan.commit();
  r.out.recordSuccess(source);
}

const holdOn = (label) => `${NAMES_B}${label}: ${soundOn(3, 'Alpha 1', ', controls: { hold: 127 }')}\n`;

test('a hold the next setup writes right after Stop goes out after the timed release, so the pedal is down at the end', async () => {
  const s = await makeStampRig({ rig: SOUND_CLOCK_RIG, sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  await playSetup(r, holdOn('pad'));
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  const pedal = c.sent.find((entry) => entry.argc === 2 && entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  assert.ok(pedal.ts - r.time.perfNow() > 100, "the old code's pedal is queued well ahead");
  r.out.retireOutputs();
  r.out.panic();
  const release = c.sent.find((entry) => entry.argc === 2 && entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 0);
  assert.ok(Math.abs(release.ts - (pedal.ts + QUEUED_SILENCE())) < 1e-6, 'the timed release follows the pedal');
  // Stop then Play at once: the same code's setup writes the hold again.
  const mark = c.sent.length;
  await playSetup(r, holdOn('pad'));
  const hold = c.sent.slice(mark).find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  assert.ok(hold !== undefined, 'the setup wrote the hold');
  assert.equal(hold.argc, 2, 'it carries a timestamp');
  assert.ok(hold.ts > release.ts, 'after the timed release');
  assert.equal(sustainInOrder(c).at(-1).data[2], 127, 'the pedal is down in the end, as the control shadow says');
  assert.deepEqual(r.errors, []);
});

test('a hold written after the timed release has passed goes out untimed, as always', async () => {
  const s = await makeStampRig({ rig: SOUND_CLOCK_RIG, sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  await playSetup(r, holdOn('pad'));
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  r.out.retireOutputs();
  r.out.panic();
  await r.wait(400);
  const mark = c.sent.length;
  await playSetup(r, holdOn('pad'));
  const hold = c.sent.slice(mark).find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  assert.equal(hold.argc, 1);
  assert.deepEqual(r.errors, []);
});

test("a quick Mixer unmute: the hold the track writes again goes out after the mute's timed release", async () => {
  const s = await makeStampRig({ rig: SOUND_CLOCK_RIG, sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  await playSetup(r, holdOn('pad'));
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  const pedal = c.sent.find((entry) => entry.argc === 2 && entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  r.out.recordSuccess(holdOn('_pad'));
  const release = c.sent.find((entry) => entry.argc === 2 && entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 0);
  assert.ok(Math.abs(release.ts - (pedal.ts + QUEUED_SILENCE())) < 1e-6);
  const mark = c.sent.length;
  await playSetup(r, holdOn('pad'));
  const hold = c.sent.slice(mark).find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  assert.ok(hold !== undefined, 'the unmute wrote the hold');
  assert.ok(hold.argc === 2 && hold.ts > release.ts, 'after the timed release');
  assert.equal(sustainInOrder(c).at(-1).data[2], 127);
  assert.deepEqual(r.errors, []);
});

test('a dragged hold (a control preview) right after a mute goes out after the timed release too', async () => {
  const s = await makeStampRig({ rig: SOUND_CLOCK_RIG, sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  await playSetup(r, holdOn('pad'));
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  r.out.recordSuccess(holdOn('_pad'));
  const release = c.sent.find((entry) => entry.argc === 2 && entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 0);
  assert.ok(release !== undefined, 'the mute of channel 3 queued its release');
  assert.equal(r.out.previewControl({ instrumentId: 'wide', channel: 3, cc: 64, value: 127 }), true);
  assert.equal(sustainInOrder(c).at(-1).data[2], 127);
});

test("a tab that lost the active role sends no timed release: nothing lands after the new tab's setup, and the untimed panic is as it was", async () => {
  const s = await makeStampRig({ sends: pedalAndNote });
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  fire(s, 'Port C', { midichannel: 3 }, { note: 60, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  const pedal = c.sent.find((entry) => entry.data[0] === 0xb2 && entry.data[1] === 64 && entry.data[2] === 127);
  r.out.retireOutputs({ timedRelease: false });
  r.out.panic();
  assert.deepEqual(timedAfter(c, pedal), [], 'no timed sustain release');
  assert.deepEqual(queuedOffsOf(c).filter((entry) => entry.argc === 2).map((entry) => entry.data), [[0x82, 60, 0]], 'the queued note still gets its own note-off');
  const untimed = c.sent.filter((entry) => entry.argc === 1 && entry.data[0] >= 0xb0 && entry.data[0] <= 0xbf && (entry.data[1] === 64 || entry.data[1] === 123));
  assert.deepEqual(untimed.map((entry) => entry.data), PANIC);
  assert.deepEqual(r.errors, []);
});

test('a mute of one channel leaves the SysEx another track queued: a sound change on that track still waits for it', async () => {
  const sysexOnFour = (device, hap, options) => {
    if (options.midichannel === 4) device.send([0xf0, 0x41, 0x10, 0xf7], { time: false });
    else device.playNote(hap.note, options.midichannel ?? 1, { duration: hap.duration });
  };
  const s = await makeStampRig({ rig: SOUND_CLOCK_RIG, sends: sysexOnFour });
  const { r } = s;
  const c = r.native('Port C');
  const both = (pad, sound) => `${NAMES_B}${pad}: ${soundOn(3, 'Alpha 1')}\nlead: ${soundOn(4, sound)}\n`;
  await playSetup(r, both('pad', 'Alpha 1'));
  fire(s, 'Port C', { midichannel: 4 }, { note: 62, duration: 200 }, r.ctx.currentTime + 0.25);
  runScheduled(r, s.scheduled[0]);
  const sysex = c.sent.find((entry) => entry.data[0] === 0xf0);
  assert.ok(sysex.ts - r.time.perfNow() > 100, 'the SysEx is queued well ahead');
  r.out.recordSuccess(both('_pad', 'Alpha 1'));
  const change = await sendSetup(r, both('_pad', 'Alpha 2'));
  const sent = change.sent();
  assert.ok(sent.length >= 2);
  for (const entry of sent) {
    assert.equal(entry.argc, 2);
    assert.ok(Math.abs(entry.ts - (sysex.ts + AFTER())) < 1e-6, `ts ${entry.ts}`);
  }
  await r.wait(100);
  await change.sending;
  assert.deepEqual(r.errors, []);
});

// --- A change that waits for a line: checked at the request, its setup timed on the line at the lead ---

const BEFORE_LINE = () => midiOutModule.SETUP_BEFORE_LINE_MS;
const NOTE_STAMP_MAX = () => midiOutModule.NOTE_STAMP_MAX_AHEAD_MS;
const programOf = (native, from = 0) => native.sent.slice(from).filter((entry) => entry.data.length === 2 && entry.data[0] === 0xc2);
/** A cycle position about `ms` ahead of the fake scheduler's now, and the timestamp the page clock should give it. */
function lineAhead(r, ms) {
  const cycle = r.cyclist.now() + (ms / 1000) * CLOCK_CPS;
  return { cycle, ts: r.time.strudelPerf(r.cyclist.soundTime(cycle)) };
}

test('checkSetup gives the refusal text of a code the rig refuses and null for one it accepts; it sends nothing and keeps no pending sounds', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const c = r.native('Port C');
  const mark = c.sent.length;
  assert.equal(r.out.checkSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`), null);
  const refusal = r.out.checkSetup(`${NAMES_B}${soundOn(3, 'No Such Sound')}`);
  assert.equal(typeof refusal, 'string');
  assert.ok(refusal.length > 0);
  assert.equal(r.out.checkSetup(`${NAMES_B}note("c3")`), null, 'code with no MIDI call has nothing to refuse');
  assert.deepEqual(c.sent.slice(mark), [], 'nothing was sent');
  // A reset of the instrument after the check sends the sounds of the code that plays (Alpha 1 = program 0), never the checked code's.
  r.out.checkSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`);
  r.unplug('Port C');
  r.plug('Port C');
  await r.wait(1600);
  const programs = programOf(c, mark).map((entry) => entry.data[1]);
  assert.ok(programs.length > 0, 'the reset sent the sound');
  assert.ok(programs.every((program) => program === 0), `programs ${programs}`);
  assert.deepEqual(r.errors, []);
});

test('checkSetup throws where prepareSetup\'s check throws, and gives null without a rig', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  r.out.setRig({ setup: 'absent' });
  assert.equal(r.out.checkSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`), null);
  assert.equal(r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`), null);
});

test('a timed setup stamps every bank select, program change and control with the line minus SETUP_BEFORE_LINE_MS, and arms no stale-channel drop', async () => {
  const s = await makeSoundStampRig(soundOn(4, 'Bell 1', ', controls: { volume: 90 }'));
  const { r } = s;
  const c = r.native('Port C');
  const old = queueNote(s, 'Port C', 3, 60);
  const line = lineAhead(r, 400);
  const next = `${NAMES_B}${soundOn(3, 'Alpha 2', ', controls: { volume: 90 }')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 80 }')}`;
  const mark = c.sent.length;
  r.out.prepareTakeover(next);
  const plan = r.out.prepareSetup(next, { atCycle: line.cycle });
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  await plan.send();
  const sent = c.sent.slice(mark);
  assert.deepEqual(
    sent.map((entry) => entry.data),
    [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 1], [0xb2, 7, 90], [0xb3, 7, 80]],
    'the sound and the controls of channel 3, then the control of channel 4 (its sound stays)',
  );
  for (const entry of sent) {
    assert.equal(entry.argc, 2);
    assert.ok(Math.abs(entry.ts - (line.ts - BEFORE_LINE())) < 0.5, `ts ${entry.ts} against the line ${line.ts}`);
    assert.ok(entry.ts >= old.ts, 'after the last old note-on');
  }
  // No stale-channel drop: a note of the old Output on channel 3 after the setup still goes out.
  const before = c.sent.length;
  outputNamedIn(r, 'Port C').send([0x92, 62, 100]);
  assert.equal(c.sent.length, before + 1, 'the old code\'s note passes');
  plan.commit();
  r.out.recordSuccess(next);
  assert.deepEqual(r.errors, []);
});

test('a later setup on the same channel is timed after the line of a timed setup', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const c = r.native('Port C');
  const line = lineAhead(r, 400);
  const plan = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: line.cycle });
  await plan.send();
  const mark = c.sent.length;
  const later = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 1')}`);
  assert.equal(later.refusal, null, later.refusal ?? '');
  const sending = later.send();
  await r.wait(100);
  await sending;
  const sent = c.sent.slice(mark);
  assert.ok(sent.length >= 3);
  for (const entry of sent) {
    assert.equal(entry.argc, 2);
    assert.ok(entry.ts >= line.ts - 0.5 + AFTER() - 1e-6, `ts ${entry.ts} against the line ${line.ts}`);
  }
  assert.deepEqual(r.errors, []);
});

test('a timed setup waits for the line and goes out without a timestamp, with one Moontide: line, when the page clock has no stamp', async () => {
  let cyclist = null;
  const s = await makeSoundStampRig('', undefined, { clock: () => ({ now: cyclist.now(), cps: cyclist.cps }) });
  const { r } = s;
  cyclist = r.cyclist;
  const c = r.native('Port C');
  const line = lineAhead(r, 400);
  r.ctx.suspend();
  const mark = c.sent.length;
  const plan = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: line.cycle });
  const sending = plan.send();
  await r.wait(200);
  assert.deepEqual(c.sent.slice(mark), [], 'nothing goes out before the line');
  assert.equal(moontideLines(r).filter((entry) => /without a timestamp at the line/.test(entry.text)).length, 1);
  await r.wait(400);
  await sending;
  const sent = c.sent.slice(mark);
  assert.deepEqual(sent.map((entry) => entry.data), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 1]]);
  assert.ok(sent.every((entry) => entry.argc === 1), 'untimed');
});

test('a timed setup whose stamp is more than NOTE_STAMP_MAX_AHEAD_MS ahead waits for the line and goes out untimed, with one Moontide: line', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const c = r.native('Port C');
  const line = lineAhead(r, NOTE_STAMP_MAX() + 600);
  const mark = c.sent.length;
  const plan = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: line.cycle });
  const sending = plan.send();
  await r.wait(NOTE_STAMP_MAX() - 100);
  assert.deepEqual(c.sent.slice(mark), [], 'still waiting for the line');
  await r.wait(1500);
  await sending;
  const sent = c.sent.slice(mark);
  assert.deepEqual(sent.map((entry) => entry.data), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 1]]);
  assert.ok(sent.every((entry) => entry.argc === 1));
  assert.equal(moontideLines(r).filter((entry) => /without a timestamp at the line/.test(entry.text)).length, 1);
});

test('drop forgets a timed plan that waits for the line: nothing goes out, and the wait ends', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const c = r.native('Port C');
  const line = lineAhead(r, NOTE_STAMP_MAX() + 600);
  const mark = c.sent.length;
  const plan = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: line.cycle });
  const sending = plan.send();
  await r.wait(100);
  plan.drop();
  await sending;
  await r.wait(3000);
  assert.deepEqual(c.sent.slice(mark), [], 'nothing was sent');
});

test('drop after a timed plan sent its bytes puts the playing code\'s sound and controls back, stamped just after the canceled setup', async () => {
  const s = await makeSoundStampRig(soundOn(4, 'Bell 1', ', controls: { volume: 90 }'));
  const { r } = s;
  const c = r.native('Port C');
  const line = lineAhead(r, 400);
  const next = `${NAMES_B}${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 80 }')}`;
  const plan = r.out.prepareSetup(next, { atCycle: line.cycle });
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const mark = c.sent.length;
  await plan.send();
  const canceled = c.sent.slice(mark);
  assert.deepEqual(canceled.map((entry) => entry.data), [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 1], [0xb3, 7, 80]]);
  const setupStamp = canceled[0].ts;
  const afterSend = c.sent.length;
  plan.drop();
  const back = c.sent.slice(afterSend);
  assert.deepEqual(
    back.map((entry) => entry.data),
    [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 0], [0xb3, 7, 90]],
    'the first code\'s sound on channel 3 (Alpha 1) and its volume on channel 4',
  );
  for (const entry of back) {
    assert.equal(entry.argc, 2, 'timed');
    assert.ok(Math.abs(entry.ts - (setupStamp + AFTER())) < 1e-6, `ts ${entry.ts} against the canceled setup at ${setupStamp}`);
  }
  // The shadows now hold the playing code's sound: a later setup of the same sound sends no program change.
  const again = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 1')}`);
  const afterBack = c.sent.length;
  const sending = again.send();
  await r.wait(300);
  await sending;
  assert.deepEqual(programOf(c, afterBack), []);
  assert.deepEqual(r.errors, []);
});

/**
 * A rig that plays Alpha 1 on channel 3 and `extra`, a timed plan `timed` (sent, stamped on a line ahead) and an immediate
 * plan `immediate` that was prepared and sent after it and is not committed yet: the moment its setPattern replaces the
 * waiting change, which drops the timed plan. Returns what went to Port C after each step.
 */
async function immediateAfterTimed({ extra = '', timed, immediate }) {
  const s = await makeSoundStampRig(extra);
  const { r } = s;
  const c = r.native('Port C');
  const line = lineAhead(r, 400);
  const waiting = r.out.prepareSetup(`${NAMES_B}${timed}`, { atCycle: line.cycle });
  assert.equal(waiting.refusal, null, waiting.refusal ?? '');
  const markTimed = c.sent.length;
  await waiting.send();
  const timedSent = c.sent.slice(markTimed);
  const now = r.out.prepareSetup(`${NAMES_B}${immediate}`);
  assert.equal(now.refusal, null, now.refusal ?? '');
  const markImmediate = c.sent.length;
  const sending = now.send();
  await r.wait(100);
  await sending;
  const immediateSent = c.sent.slice(markImmediate);
  const markDrop = c.sent.length;
  waiting.drop();
  await r.wait(50);
  const dropSent = c.sent.slice(markDrop);
  now.commit();
  return { ...s, c, line, timedSent, immediateSent, dropSent, immediateCode: `${NAMES_B}${immediate}` };
}

/** What a later setup of `source` would send on Port C: the shadows say whether the instrument is known to hold it. */
async function sentBySetup(r, source) {
  const c = r.native('Port C');
  const mark = c.sent.length;
  const plan = r.out.prepareSetup(source);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  await r.wait(300);
  await sending;
  return c.sent.slice(mark);
}

test('a drop caused by an immediate change that wants the same sound on the channel puts nothing back: the instrument and the shadow keep that sound', async () => {
  const t = await immediateAfterTimed({ timed: soundOn(3, 'Alpha 2'), immediate: soundOn(3, 'Alpha 2') });
  assert.deepEqual(t.immediateSent, [], 'the shadow already says Alpha 2, so the immediate change sends nothing');
  assert.deepEqual(t.dropSent, [], 'the old sound is not put back over the sound the immediate change plays');
  assert.deepEqual(await sentBySetup(t.r, t.immediateCode), []);
  assert.deepEqual(t.r.errors, []);
});

test('a drop caused by an immediate change that wants another sound on the channel leaves that sound on the wire and in the shadow', async () => {
  const t = await immediateAfterTimed({ timed: soundOn(3, 'Alpha 2'), immediate: soundOn(3, 'Bell 1') });
  assert.deepEqual(t.dropSent, [], 'no put-back of the old sound');
  const sounds = t.timedSent.concat(t.immediateSent).filter((entry) => entry.data.length === 2 && entry.data[0] === 0xc2);
  const last = sounds.reduce((best, entry) => (best === null || entry.ts > best.ts ? entry : best), null);
  assert.equal(last.data[1], 2, 'the program change that lands last is the immediate change\'s Bell 1');
  assert.ok(last.ts >= t.line.ts + AFTER() - 1e-6, 'and it is stamped after the canceled change\'s');
  assert.deepEqual(await sentBySetup(t.r, t.immediateCode), [], 'the shadow holds Bell 1: nothing is sent for it again');
  assert.deepEqual(t.r.errors, []);
});

test('a drop caused by an immediate change still puts the playing code\'s sound back on a channel the immediate change does not set up', async () => {
  const t = await immediateAfterTimed({ timed: soundOn(3, 'Alpha 2'), immediate: soundOn(4, 'Bell 1') });
  assert.deepEqual(
    t.dropSent.map((entry) => entry.data),
    [[0xb2, 0, 0], [0xb2, 32, 0], [0xc2, 0]],
    'Alpha 1 goes back on channel 3',
  );
  assert.deepEqual(t.r.errors, []);
});

test('a drop caused by an immediate change re-sends that change\'s controls after the canceled change\'s stamped controls, not the old code\'s', async () => {
  const t = await immediateAfterTimed({
    extra: soundOn(4, 'Bell 1', ', controls: { volume: 90 }'),
    timed: `${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 80 }')}`,
    immediate: `${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 60 }')}`,
  });
  const stamp = t.timedSent.find((entry) => entry.data[0] === 0xb3 && entry.data[1] === 7).ts;
  assert.deepEqual(t.immediateSent.map((entry) => entry.data), [[0xb3, 7, 60]], 'the immediate control goes out at once');
  assert.deepEqual(t.dropSent.map((entry) => entry.data), [[0xb3, 7, 60]], 'and again after the canceled change\'s control (80), never the old 90');
  assert.equal(t.dropSent[0].argc, 2);
  assert.ok(Math.abs(t.dropSent[0].ts - (stamp + AFTER())) < 1e-6, `ts ${t.dropSent[0].ts} against the canceled setup at ${stamp}`);
  assert.deepEqual(await sentBySetup(t.r, `${NAMES_B}${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 60 }')}`), [], 'the control shadow holds 60');
  assert.deepEqual(t.r.errors, []);
});

test('a drop caused by an immediate change that leaves a control the canceled change wrote sends the default after it', async () => {
  const t = await immediateAfterTimed({
    extra: soundOn(4, 'Bell 1', ', controls: { volume: 90 }'),
    timed: `${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1', ', controls: { volume: 80 }')}`,
    immediate: `${soundOn(3, 'Alpha 2')}\n${soundOn(4, 'Bell 1')}`,
  });
  assert.deepEqual(t.immediateSent.map((entry) => entry.data), [[0xb3, 7, 100]], 'the volume the code no longer writes goes back to the default');
  assert.deepEqual(t.dropSent.map((entry) => entry.data), [[0xb3, 7, 100]], 'after the canceled change\'s 80');
  assert.deepEqual(t.r.errors, []);
});

test('drop of a timed plan whose setup went out without a stamp or never went out sends nothing back, and neither does a committed one', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const c = r.native('Port C');
  // Never sent.
  const unsent = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: lineAhead(r, 400).cycle });
  const mark = c.sent.length;
  unsent.drop();
  assert.deepEqual(c.sent.slice(mark), []);
  // Committed: the change took over, there is nothing to put back.
  const next = `${NAMES_B}${soundOn(3, 'Alpha 2')}`;
  const plan = r.out.prepareSetup(next, { atCycle: lineAhead(r, 400).cycle });
  await plan.send();
  plan.commit();
  const afterCommit = c.sent.length;
  plan.drop();
  assert.deepEqual(c.sent.slice(afterCommit), []);
  assert.deepEqual(r.errors, []);
});

test('after a drop put the sound back, a newer timed setup goes out after it and compares with the playing code\'s sound', async () => {
  const s = await makeSoundStampRig();
  const { r } = s;
  const c = r.native('Port C');
  const canceled = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: lineAhead(r, 400).cycle });
  await canceled.send();
  canceled.drop();
  const mark = c.sent.length;
  const line = lineAhead(r, 450);
  const newer = r.out.prepareSetup(`${NAMES_B}${soundOn(3, 'Alpha 2')}`, { atCycle: line.cycle });
  await newer.send();
  assert.deepEqual(programOf(c, mark).map((entry) => entry.data[1]), [1], 'the newer change sends its own sound again');
  assert.deepEqual(r.errors, []);
});

test('prepareTakeover makes the clock serve the instruments of the playing code and of the waiting code; recordSuccess keeps only the waiting code\'s', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  const b = r.native('Port B');
  r.play(NAMES_B);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 0);
  assert.equal(startsOf(b).length, 1);
  r.out.prepareTakeover(NAMES_A);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 1, 'the new clock instrument got its Start at the lead');
  assert.equal(stopsOf(b).length, 0, 'the instrument only the old code names keeps its clock until the takeover');
  r.out.recordSuccess(NAMES_A);
  assert.equal(stopsOf(b).length, 1, 'and gets its Stop at the takeover');
  assert.equal(startsOf(a).length, 1);
  assert.deepEqual(r.errors, []);
});

test('abandonTakeover puts the clock back to the playing code\'s instruments', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  r.play(NAMES_B);
  await r.wait(3000);
  r.out.prepareTakeover(NAMES_A);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 1);
  r.out.abandonTakeover();
  assert.equal(stopsOf(a).length, 1, 'the instrument only the canceled change names gets its Stop');
  assert.deepEqual(r.errors, []);
});

// --- Golden tests of today's rhythm channel bytes ---
// Written and run green against the sources before the rhythmBank change; they must stay as they are once the change lands.

test('golden: setupMessages never puts a bank select before a rhythm program change, whatever the model\'s bank select', () => {
  const { setupMessages } = midiOutModule;
  for (const bankSelect of ['none', 'msb', 'msb-lsb']) {
    for (const channel of [10, 16]) {
      assert.deepEqual(
        setupMessages({ bankSelect }, channel, { role: 'rhythm', program: 5, bank: { msb: 86, lsb: 64 } }),
        [[0xc0 | (channel - 1), 5]],
        `${bankSelect} on channel ${channel}`,
      );
    }
  }
});

test('golden: a hand-built kit that carries a bank still sends its program change alone', async () => {
  const rig = {
    setup: 'valid',
    instruments: [
      instrumentOf('banked', 'Port B', 'msb', { sounds: { melodic: MELODIC, rhythm: [sound('Kit 1', 0), sound('Kit Banked', 3, { msb: 86, lsb: 64 })] } }),
      instrumentOf('wided', 'Port C', 'msb-lsb', { sounds: { melodic: MELODIC, rhythm: [sound('Kit 1', 0), sound('Kit Banked', 3, { msb: 86, lsb: 64 })] } }),
    ],
  };
  const { out, natives, clock } = makeSetupRig({ names: ['Port B', 'Port C'], rig });
  await play(out, clock, soundCode('Port B', 10, 'Kit Banked'));
  await play(out, clock, soundCode('Port C', 10, 'Kit Banked'));
  assert.deepEqual(bytesOf(natives[0]), [[0xc9, 3]]);
  assert.deepEqual(bytesOf(natives[1]), [[0xc9, 3]]);
});

test('golden: the shipped SC-55 and MT-32, read through RigStore, rigMessage and parseRigMessage, keep their channel 10 bytes', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-golden-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, 'instruments.json'),
    JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }, { id: 'sc55', model: 'sc55', port: 'Port B' }] }),
  );
  const rig = parseRigMessage(instruments.rigMessage(new instruments.RigStore({ dataDir }).read()));
  const { out, natives, clock } = makeSetupRig({ names: ['Port A', 'Port B'], rig });
  await play(out, clock, soundCode('Port B', 10, 'Standard Set'));
  await play(out, clock, soundCode('Port B', 10, 'Room Set'));
  const melodic = rig.instruments[1].sounds.melodic[0];
  await play(out, clock, soundCode('Port B', 1, melodic.name));
  await play(out, clock, `note("36 38").midi('Port A', { midichannel: 10 })`);
  const rhythmBytes = (native) =>
    bytesOf(native).filter((bytes) => bytes[0] === 0xc9 || (bytes[0] === 0xb9 && (bytes[1] === 0 || bytes[1] === 32)));
  assert.deepEqual(rhythmBytes(natives[1]), [[0xc9, 0], [0xc9, 8]]);
  assert.deepEqual(rhythmBytes(natives[0]), []);
  const melodicBytes = bytesOf(natives[1]).filter((bytes) => bytes[0] === 0xb0 || bytes[0] === 0xc0);
  assert.deepEqual(melodicBytes, [[0xb0, 0, melodic.bank?.msb ?? 0], [0xc0, melodic.program]]);
});

// --- An instrument off in the data folder, from the file to the page's notes ---

test('an instrument off in the data folder drops its notes, and on again it is reset and set up twice', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-inst-tracer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'instruments.json'), JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }] }));
  const readRig = () => parseRigMessage(instruments.rigMessage(new instruments.RigStore({ dataDir }).read()));

  instruments.writeRigState({ dataDir, off: ['mt32'] });
  const off = readRig();
  assert.equal(off.instruments[0].enabled, false);
  const r = makeResetRig({ present: ['Port A'], rig: off });
  await r.out.enableIfGranted();
  await r.wait(500);
  await r.wait(off.instruments[0].reset.waitMs);
  assert.deepEqual(bytesOf(r.native('Port A')), [], 'an instrument that is off at page start is never reset or set up');
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')), [], 'its notes are dropped');
  assert.equal(r.infos.length, 1);
  assert.match(r.infos[0], /"mt32".*switched off/);

  instruments.writeRigState({ dataDir, off: [] });
  const on = readRig();
  assert.equal(on.instruments[0].enabled, true);
  r.out.setRig(on);
  await r.wait(500);
  await r.wait(on.instruments[0].reset.waitMs);
  const volumes = on.instruments[0].channels.map(({ channel }) => [0xb0 | (channel - 1), 7, on.instruments[0].defaultVolume]);
  assert.deepEqual(bytesOf(r.native('Port A')), [...on.instruments[0].reset.messages, ...volumes], 'the reset, then the volume of each declared channel');
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(bytesOf(r.native('Port A')).length, on.instruments[0].reset.messages.length + volumes.length, 'a note is still dropped until the second setup');
  await r.wait(REPEAT);
  assert.deepEqual(bytesOf(r.native('Port A')), [...on.instruments[0].reset.messages, ...volumes, ...volumes], 'the setup again, and no second reset');
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(bytesOf(r.native('Port A')).at(-1), NOTE, 'notes pass again');
  assert.deepEqual(r.resets(), [{ kind: 'reset', instrument: 'mt32', reason: 'reconnect' }]);
  assert.deepEqual(r.errors, []);
});

// --- An opted-in model, from the data folder to the bytes ---

test('an opted-in model from a data folder sends a kit\'s bank and program on its rhythm channel', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-drum-tracer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'models'));
  fs.writeFileSync(path.join(dataDir, 'models', 'bankdrums.json'), JSON.stringify(bankDrumsModel()));
  fs.writeFileSync(
    path.join(dataDir, 'instruments.json'),
    JSON.stringify({ instruments: [{ id: 'drumbank', model: 'bankdrums', port: 'Port D' }, { id: 'sc55', model: 'sc55', port: 'Port B' }] }),
  );
  const rig = parseRigMessage(instruments.rigMessage(new instruments.RigStore({ dataDir }).read()));
  assert.equal(rig.setup, 'valid');
  assert.equal(rig.instruments[0].rhythmBank, true);
  assert.equal(rig.instruments[1].rhythmBank, false, 'the shipped SC-55 does not opt in');
  const { out, natives, clock } = makeSetupRig({ names: ['Port D', 'Port B'], rig });
  await play(out, clock, soundCode('Port D', 5, 'Kit A'));
  assert.deepEqual(bytesOf(natives[0]), [[0xb4, 0, 86], [0xb4, 32, 64], [0xc4, 0]]);
});

// --- The kit of an opted-in model behaves like any sound change on its channel ---

const KIT_A_BYTES = [[0xb4, 0, 86], [0xb4, 32, 64], [0xc4, 0]];
const KIT_B_BYTES = [[0xb4, 0, 86], [0xb4, 32, 65], [0xc4, 0]];

/** An opted-in instrument on Port D: one rhythm channel (5), two kits that share program 0 and differ by bank. */
const drumInstrument = (rest = {}) =>
  instrumentOf('drumbank', 'Port D', 'msb-lsb', {
    rhythmBank: true,
    channels: [{ channel: 5, role: 'rhythm' }],
    sounds: { melodic: [], rhythm: [sound('Kit A', 0, { msb: 86, lsb: 64 }), sound('Kit B', 0, { msb: 86, lsb: 65 })] },
    ...rest,
  });

const DRUM_RIG = { setup: 'valid', instruments: [drumInstrument()] };

test('a kit change that keeps the program and changes only the bank is sent, and the same kit again sends nothing', async () => {
  const { out, natives, clock } = makeSetupRig({ names: ['Port D'], rig: DRUM_RIG });
  await play(out, clock, soundCode('Port D', 5, 'Kit A'));
  assert.deepEqual(bytesOf(natives[0]), KIT_A_BYTES);
  await play(out, clock, soundCode('Port D', 5, 'Kit B'));
  assert.deepEqual(bytesOf(natives[0]).slice(3), KIT_B_BYTES, 'the second kit sends its own bank, with the same program');
  await play(out, clock, soundCode('Port D', 5, 'Kit B'));
  assert.equal(natives[0].sent.length, 6, 'the same kit again sends nothing');
});

test('a bank-only kit change arms the stale-channel filter on the rhythm channel', async () => {
  const { out, natives, webMidi, clock } = makeSetupRig({ names: ['Port D'], rig: DRUM_RIG });
  await play(out, clock, soundCode('Port D', 5, 'Kit A'));
  out.recordSuccess(soundCode('Port D', 5, 'Kit A'));
  const mark = natives[0].sent.length;
  const stale = webMidi.outputs[0];
  const plan = out.prepareSetup(soundCode('Port D', 5, 'Kit B'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  plan.commit();
  assert.notEqual(webMidi.outputs[0], stale, 'the commit puts a fresh Output on the port');
  stale.send([0x94, 36, 100]);
  webMidi.outputs[0].send([0x94, 38, 100]);
  assert.deepEqual(bytesOf(natives[0]).slice(mark), [...KIT_B_BYTES, [0x94, 38, 100]], 'the old code\'s channel 5 note is dropped, the new one passes');
});

test('a refused evaluation puts the previous kit back with its bank', async () => {
  const { out, natives, clock } = makeSetupRig({ names: ['Port D'], rig: DRUM_RIG });
  await play(out, clock, soundCode('Port D', 5, 'Kit A'));
  const plan = out.prepareSetup(soundCode('Port D', 5, 'Kit B'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(bytesOf(natives[0]).slice(3), KIT_B_BYTES);
  await plan.rollback();
  assert.deepEqual(bytesOf(natives[0]).slice(6), KIT_A_BYTES, 'the previous bank, then the previous program');
  await play(out, clock, soundCode('Port D', 5, 'Kit A'));
  assert.equal(natives[0].sent.length, 9, 'the shadow follows what was sent: kit A again is not sent again');
});

test('an opted-in model with a bank MSB only sends CC0 then the program change', async () => {
  const rig = {
    setup: 'valid',
    instruments: [drumInstrument({ bankSelect: 'msb', sounds: { melodic: [], rhythm: [sound('Kit M', 2, { msb: 86 })] } })],
  };
  const { out, natives, clock } = makeSetupRig({ names: ['Port D'], rig });
  await play(out, clock, soundCode('Port D', 5, 'Kit M'));
  assert.deepEqual(bytesOf(natives[0]), [[0xb4, 0, 86], [0xc4, 2]]);
});

test('a reset and the second setup after a replug send the kit with its bank', async () => {
  const rig = { setup: 'valid', instruments: [drumInstrument({ reset: { messages: RESET_A, waitMs: 100 } })] };
  const r = makeResetRig({ present: ['Port D'], rig });
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port D', 5, 'Kit A'));
  const mark = r.native('Port D').sent.length;
  r.unplug('Port D');
  r.plug('Port D');
  await settled(r);
  const setup = [...KIT_A_BYTES, [0xb4, 7, 100]];
  assert.deepEqual(bytesOf(r.native('Port D')).slice(mark), [...RESET_A, ...setup], 'the reset, then the kit with its bank, then the volume');
  await r.wait(REPEAT);
  assert.deepEqual(bytesOf(r.native('Port D')).slice(mark), [...RESET_A, ...setup, ...setup], 'the second setup sends the kit with its bank again');
  assert.deepEqual(r.errors, []);
});

// --- Off is a whole unplug and on a whole replug, on every path of the page ---

const withEnabled = (rig, id, enabled) => ({ ...rig, instruments: rig.instruments.map((instrument) => (instrument.id === id ? { ...instrument, enabled } : instrument)) });
const PLAIN_OFF = withEnabled(RESET_RIG, 'plain', false);
// The sustain release and All Notes Off of the channels 3, 4 and 10 of the test instruments, in channel order.
const SILENCE_345 = [[0xb2, 64, 0], [0xb2, 123, 0], [0xb3, 64, 0], [0xb3, 123, 0], [0xb9, 64, 0], [0xb9, 123, 0]];
const SILENCE_MS = midiOutModule.SILENCE_REPEAT_MS;

test('switching off a playing instrument silences its declared channels at once and again after SILENCE_REPEAT_MS, and nothing else', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  const markA = r.native('Port A').sent.length;
  const markB = r.native('Port B').sent.length;
  r.out.setRig(PLAIN_OFF);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(markA), SILENCE_345, 'sustain release and All Notes Off on each declared channel, no reset, program or volume byte');
  outputOf(r, 'Port A').send(NOTE);
  assert.equal(r.native('Port A').sent.length, markA + SILENCE_345.length, 'a note of the playing code is dropped from the same tick');
  await r.wait(SILENCE_MS - 1);
  assert.equal(r.native('Port A').sent.length, markA + SILENCE_345.length, 'nothing before the repeat delay is over');
  await r.wait(1);
  assert.deepEqual(bytesOf(r.native('Port A')).slice(markA), [...SILENCE_345, ...SILENCE_345], 'the same silence once more');
  await r.wait(5000);
  assert.equal(r.native('Port A').sent.length, markA + 2 * SILENCE_345.length, 'and then nothing');
  assert.equal(r.native('Port B').sent.length, markB, 'the other instrument is not touched');
  r.out.setRig(withEnabled(PLAIN_OFF, 'bank', true));
  assert.equal(r.native('Port A').sent.length, markA + 2 * SILENCE_345.length, 'a rig that keeps it off silences nothing again');
  assert.deepEqual(r.errors, []);
});

test('switching off ends the note-ons already queued ahead on its channels, before the silence', async () => {
  const s = await makeStampRig();
  const { r } = s;
  const c = r.native('Port C');
  r.out.recordSuccess(NAMES_B + NAMES_C);
  const on = queueNote(s, 'Port C', 3, 60);
  assert.ok(on.ts - r.time.perfNow() > 100, 'the note-on is queued well ahead');
  r.out.setRig(withEnabled(CLOCK_RIG, 'pad', false));
  const after = entriesAfter(c, on);
  const off = after.findIndex((entry) => entry.data[0] === 0x82 && entry.data[1] === 60 && entry.data[2] === 0);
  assert.ok(off >= 0, 'the queued note-on gets its note-off');
  assert.ok(Math.abs(after[off].ts - (on.ts + QUEUED_OFF())) < 1e-6, 'a millisecond after the note-on');
  const silence = after.findIndex((entry) => entry.argc === 1 && entry.data[0] === 0xb2 && entry.data[1] === 123);
  assert.ok(silence > off, 'the silence follows the note-off');
  assert.deepEqual(r.errors, []);
});

test('switching off a stopped page, or from a superseded tab, sends no byte, and the guard still drops a note', async () => {
  const stopped = makeResetRig({ present: ['Port A'] });
  await stopped.out.enableIfGranted();
  await stopped.wait(200);
  stopped.state.playing = false;
  const mark = stopped.native('Port A').sent.length;
  stopped.out.setRig(PLAIN_OFF);
  await stopped.wait(SILENCE_MS * 2);
  outputOf(stopped, 'Port A').send(NOTE);
  assert.equal(stopped.native('Port A').sent.length, mark, 'a stopped page sends nothing, and the guard still drops a note');

  const superseded = makeResetRig({ present: ['Port A'] });
  await superseded.out.enableIfGranted();
  await superseded.wait(200);
  superseded.out.setActive(false);
  const supersededMark = superseded.native('Port A').sent.length;
  superseded.out.setRig(PLAIN_OFF);
  await superseded.wait(SILENCE_MS * 2);
  assert.equal(superseded.native('Port A').sent.length, supersededMark, 'a superseded tab sends nothing');
  assert.deepEqual(stopped.errors, []);
  assert.deepEqual(superseded.errors, []);
});

test('a first rig that already has an instrument off sends it nothing at all, and the other instrument is reset as before', async () => {
  const r = makeResetRig({ rig: PLAIN_OFF });
  await r.out.enableIfGranted();
  await r.wait(200);
  assert.deepEqual(bytesOf(r.native('Port A')), [], 'no reset, no volume');
  assert.deepEqual(bytesOf(r.native('Port B')), [...RESET_B, ...VOLUMES]);
  assert.deepEqual(r.resets(), [{ kind: 'reset', instrument: 'bank', reason: 'start' }]);
  assert.deepEqual(r.errors, []);
});

test('switching on after off is a replug: one reset after the settle delay, the setup the code names, the second setup, then notes pass', async () => {
  const r = makeResetRig();
  await r.out.enableIfGranted();
  await r.wait(200);
  await play(r.out, r.clock, soundCode('Port A', 3, 'Alpha 1'));
  r.out.setRig(PLAIN_OFF);
  await r.wait(SILENCE_MS);
  const mark = r.native('Port A').sent.length;
  r.out.setRig(RESET_RIG);
  const sentSince = () => bytesOf(r.native('Port A')).slice(mark);
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), [], 'dropped in the same tick, nothing yet');
  await r.wait(499);
  assert.deepEqual(sentSince(), [], 'nothing during the settle delay');
  await r.wait(1);
  await r.wait(100);
  assert.deepEqual(sentSince(), [...RESET_A, ...SETUP_A], 'one reset, then the sound the code names and the volumes');
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince(), [...RESET_A, ...SETUP_A], 'a note is still dropped before the second setup');
  await r.wait(REPEAT);
  assert.deepEqual(sentSince(), [...RESET_A, ...SETUP_A, ...SETUP_A], 'the same setup again, no second reset');
  outputOf(r, 'Port A').send(NOTE);
  assert.deepEqual(sentSince().at(-1), NOTE, 'notes pass after the second setup');
  assert.deepEqual(r.resets().filter((event) => event.instrument === 'plain' && event.reason === 'reconnect').length, 1);
  assert.deepEqual(r.errors, []);
});

test('a sound the code names while the instrument is off is kept in the plan, not sent, and goes out when it is switched on', async () => {
  const r = makeResetRig({ rig: PLAIN_OFF });
  await r.out.enableIfGranted();
  await r.wait(200);
  // The code that plays already names the port (new code cannot newly aim at an off instrument).
  r.out.recordSuccess(soundCode('Port A', 3, 'Alpha 1'));
  const plan = r.out.prepareSetup(soundCode('Port A', 3, 'Alpha 2'));
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  r.clock.advance(1000);
  await sending;
  plan.commit();
  assert.deepEqual(bytesOf(r.native('Port A')), [], 'nothing is sent to an instrument that is off');
  r.out.setRig(RESET_RIG);
  await settled(r);
  const setup = [[0xc2, 1], ...VOLUMES];
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, ...setup], 'the kept sound is in the setup');
  await r.wait(REPEAT);
  assert.deepEqual(bytesOf(r.native('Port A')), [...RESET_A, ...setup, ...setup], 'and in the second setup');
  assert.deepEqual(r.errors, []);
});

test('an off during the settle delay, or during the model\'s reset wait, sends nothing more to that port', async () => {
  const notSilence = (data) => !(data[0] >= 0xb0 && data[0] <= 0xbf && (data[1] === 64 || data[1] === 123));
  // During the settle delay: nothing at all follows the off (the port is held, not yet reset).
  const early = makeResetRig();
  await early.out.enableIfGranted();
  await early.wait(200);
  await play(early.out, early.clock, soundCode('Port A', 3, 'Alpha 1'));
  early.unplug('Port A');
  early.plug('Port A');
  await early.wait(200);
  const earlyMark = early.native('Port A').sent.length;
  early.out.setRig(PLAIN_OFF);
  await early.wait(5000);
  assert.deepEqual(bytesOf(early.native('Port A')).slice(earlyMark).filter(notSilence), [], 'no reset, no setup after the off');

  // During the model's reset wait: the reset message went out, the setup that would follow it does not.
  const late = makeResetRig();
  await late.out.enableIfGranted();
  await late.wait(200);
  await play(late.out, late.clock, soundCode('Port A', 3, 'Alpha 1'));
  late.unplug('Port A');
  late.plug('Port A');
  await late.wait(500);
  assert.deepEqual(bytesOf(late.native('Port A')).slice(-1), RESET_A, 'the reset message is out');
  const lateMark = late.native('Port A').sent.length;
  late.out.setRig(PLAIN_OFF);
  await late.wait(5000);
  assert.deepEqual(bytesOf(late.native('Port A')).slice(lateMark).filter(notSilence), [], 'no setup after the reset message');
  assert.deepEqual(early.errors, []);
  assert.deepEqual(late.errors, []);
});

test('a Mixer preview on an off instrument returns false and logs one error, once', async () => {
  const r = makeResetRig({ rig: PLAIN_OFF });
  await r.out.enableIfGranted();
  await r.wait(200);
  const mark = r.native('Port A').sent.length;
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 30 }), false);
  assert.equal(r.native('Port A').sent.length, mark);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].text, /is switched off/);
  assert.equal(r.out.previewControl({ instrumentId: 'plain', channel: 3, cc: 10, value: 31 }), false);
  assert.equal(r.errors.length, 1, 'the same cause logs once');
  assert.equal(r.out.previewControl({ instrumentId: 'bank', channel: 3, cc: 10, value: 31 }), true, 'an instrument that is on still takes a preview');
});

test('switching off a clock instrument sends its Stop once and no tick after it, and switching on gives a new Start on a cycle boundary', async () => {
  const r = await makeClockRig();
  const a = r.native('Port A');
  r.play(NAMES_A);
  await r.wait(3000);
  assert.equal(startsOf(a).length, 1);
  r.out.setRig(withEnabled(CLOCK_RIG, 'seq', false));
  assert.equal(stopsOf(a).length, 1, 'exactly one Stop, at once');
  assert.equal(stopsOf(a)[0].argc, 1, 'the Stop has no timestamp');
  const stopIndex = a.sent.indexOf(stopsOf(a)[0]);
  await r.wait(3000);
  assert.deepEqual(clockBytesAfter(a, stopIndex + 1), [], 'no tick, Start or second Stop after the Stop');
  assert.equal(r.out.rigView().instruments[0].clock, 'none');

  r.out.setRig(CLOCK_RIG);
  assert.equal(await r.waitUntil(() => startsOf(a).length === 2), true, 'a new Start follows once the instrument is back and set up');
  const fresh = startsOf(a)[1];
  const firstTick = ticksOf(a).find((entry) => a.sent.indexOf(entry) > a.sent.indexOf(fresh));
  assert.ok(isIntegralCycle(r.cyclist.cycleAtPerf(firstTick.ts)), 'the first tick is on a cycle boundary');
  assert.equal(stopsOf(a).length, 1, 'no further Stop');
  assert.deepEqual(r.errors, []);
});

test('rigView carries enabled, and an off clock instrument reads clock none', async () => {
  const r = await makeClockRig();
  r.play(NAMES_A + NAMES_B);
  await r.wait(3000);
  assert.deepEqual(r.out.rigView().instruments.map((view) => [view.id, view.enabled, view.clock]), [['seq', true, 'running'], ['arp', true, 'running'], ['pad', true, 'none']]);
  r.out.setRig(withEnabled(CLOCK_RIG, 'seq', false));
  assert.deepEqual(r.out.rigView().instruments.map((view) => [view.id, view.enabled, view.clock]), [['seq', false, 'none'], ['arp', true, 'running'], ['pad', true, 'none']]);
});

// --- Code newly aimed at an instrument the user switched off is refused, playing code is not ---

/** SETUP_RIG with the bank instrument (Port B) switched off. */
const bankOffRig = () => ({
  setup: 'valid',
  instruments: [instrumentOf('plain', 'Port A', 'none'), instrumentOf('bank', 'Port B', 'msb', { enabled: false }), instrumentOf('wide', 'Port C', 'msb-lsb')],
});

const twoTracks = (patternB = 'c3') =>
  `lead: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })\nbass: note("${patternB}").midi('Port B', { midichannel: 3, sound: 'Alpha 1' })`;

/** `play`, then the successful evaluation is recorded: the code now plays. */
async function playing(r, source) {
  await play(r.out, r.clock, source);
  r.out.recordSuccess(source);
}

test('code newly aimed at an off instrument is refused, code already playing it is not', async () => {
  const off = makeSetupRig({ rig: bankOffRig() });
  await playing(off, soundCode('Port A', 3, 'Alpha 1'));
  const refusal = off.out.checkSetup(soundCode('Port B', 3, 'Alpha 1'));
  assert.ok(refusal.startsWith('Instrument "bank" (port "Port B") is switched off by the user'), refusal);
  assert.ok(refusal.endsWith('The previous music keeps playing.'), refusal);
  assert.equal(off.out.prepareSetup(soundCode('Port B', 3, 'Alpha 1')).refusal, refusal, 'prepareSetup gives the same refusal');

  // The same two-track code while bank is on, then bank is switched off: the code that plays keeps its place.
  const r = makeSetupRig();
  await playing(r, twoTracks());
  r.out.setRig(bankOffRig());
  assert.equal(r.out.checkSetup(twoTracks('c4 e4')), null, 'another pattern on the off instrument passes: its port is named by the playing code');
  const bytesBefore = bytesOf(r.natives[1]).length;
  const plan = r.out.prepareSetup(twoTracks('c4 e4'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  r.clock.advance(1000);
  await sending;
  plan.commit();
  // The only thing that may follow is the second silence of the switch-off itself (sustain release, All Notes Off).
  const silence = bytesOf(r.natives[1]).slice(bytesBefore);
  assert.ok(silence.every(([status, controller]) => (status & 0xf0) === 0xb0 && (controller === 64 || controller === 123)), JSON.stringify(silence));
  assert.deepEqual(r.errors, []);
});

// Music that already plays keeps working when an instrument is switched off (S3), and a reload never loses the code.

const BANK_LINE = (extra = '', pattern = 'c3') => `bass: note("${pattern}").midi('Port B', { midichannel: 3, sound: 'Alpha 1' })${extra}`;
const LEAD_LINE = `lead: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`;

/** A rig of fake ports playing the two-track code, then the bank instrument (Port B) is switched off. */
async function playingThenBankOff() {
  const r = makeSetupRig();
  await playing(r, `${LEAD_LINE}\n${BANK_LINE()}`);
  r.out.setRig(bankOffRig());
  return r;
}

test('a Mixer move on a track of the off instrument passes (the playing code names its port)', async () => {
  const r = await playingThenBankOff();
  assert.equal(r.out.checkSetup(`${LEAD_LINE}\n${BANK_LINE('.gain(0.5)')}`), null);
  assert.equal(r.out.prepareSetup(`${LEAD_LINE}\n${BANK_LINE('.gain(0.5)')}`).refusal, null);
});

test('a second track on the off instrument passes when the playing code already names it', async () => {
  const r = await playingThenBankOff();
  assert.equal(r.out.checkSetup(`${LEAD_LINE}\n${BANK_LINE()}\nextra: note("e3").midi('Port B', { midichannel: 4, sound: 'Alpha 2' })`), null);
});

test('code that drops every track of the off instrument passes, and bringing it back is then refused', async () => {
  const r = await playingThenBankOff();
  const without = LEAD_LINE;
  assert.equal(r.out.checkSetup(without), null);
  r.out.recordSuccess(without);
  const back = r.out.checkSetup(`${LEAD_LINE}\n${BANK_LINE()}`);
  assert.ok(back.startsWith('Instrument "bank" (port "Port B") is switched off by the user'), back);
});

test('a history restore or a new set_code that newly names the off instrument is refused', async () => {
  const r = makeSetupRig({ rig: bankOffRig() });
  await playing(r, LEAD_LINE);
  const refused = r.out.checkSetup(`${LEAD_LINE}\n${BANK_LINE()}`);
  assert.ok(refused.startsWith('Instrument "bank" (port "Port B") is switched off by the user'), refused);
  assert.ok(refused.endsWith('The previous music keeps playing.'), refused);
});

test('the replay base lets the code that was playing pass, and clearing it refuses the same string again', () => {
  const r = makeSetupRig({ rig: bankOffRig() });
  const code = `${LEAD_LINE}\n${BANK_LINE()}`;
  assert.ok(r.out.checkSetup(code).startsWith('Instrument "bank"'), 'nothing plays: refused');
  r.out.setReplayBase(code);
  assert.equal(r.out.checkSetup(code), null, 'the replay of the stored code passes');
  assert.equal(r.out.prepareSetup(code).refusal, null);
  r.out.setReplayBase(null);
  assert.ok(r.out.checkSetup(code).startsWith('Instrument "bank"'), 'a hand evaluation of the same code is refused again (memo key)');
  r.out.setReplayBase(code);
  r.out.setReplayBase(42);
  assert.ok(r.out.checkSetup(code).startsWith('Instrument "bank"'), 'anything but a string clears the base');
});

test('the same code checked before and after a success gets the right answer each time', async () => {
  const r = makeSetupRig({ rig: bankOffRig() });
  const code = `${LEAD_LINE}\n${BANK_LINE()}`;
  assert.ok(r.out.checkSetup(code).startsWith('Instrument "bank"'));
  r.out.recordSuccess(code);
  assert.equal(r.out.checkSetup(code), null, 'once it plays, it passes');
  r.out.recordSuccess(LEAD_LINE);
  assert.ok(r.out.checkSetup(code).startsWith('Instrument "bank"'), 'and refused again once it no longer plays');
});

test('a timed plan checked while the instrument is on is refused when it is prepared again after the switch-off with nothing of it playing', async () => {
  const r = makeSetupRig();
  await playing(r, LEAD_LINE);
  const code = `${LEAD_LINE}\n${BANK_LINE()}`;
  const first = r.out.prepareSetup(code, { atCycle: 8 });
  assert.equal(first.refusal, null);
  r.out.setRig(bankOffRig());
  const second = r.out.prepareSetup(code, { atCycle: 8 });
  assert.ok(second.refusal.startsWith('Instrument "bank" (port "Port B") is switched off by the user'), second.refusal);
  first.drop();
});

// --- outputNames, the ports the Instruments settings editor offers ---

test('outputNames lists the browser outputs only while Web MIDI is enabled, and never enables it', async () => {
  const { out, calls, turnOn } = makeAccessRig({ names: ['Port A', 'Port B'] });
  assert.deepEqual(out.outputNames(), [], 'nothing before Web MIDI is on');
  assert.equal(calls.enable, 0);
  assert.equal(calls.query, 0, 'it asks the browser nothing');
  await out.beforeEvaluate(`note("c3").midi('Port A')`);
  assert.equal(calls.enable, 1, 'the code enabled Web MIDI, not outputNames');
  assert.deepEqual(out.outputNames(), ['Port A', 'Port B']);
  turnOn();
  assert.equal(calls.enable, 1);
});

test('outputNames stays empty while access is denied, and records no name it did not read', async () => {
  const { out, calls } = makeAccessRig({ permission: 'denied' });
  await out.beforeEvaluate(`note("c3").midi('A')`);
  assert.deepEqual(out.outputNames(), []);
  assert.equal(calls.enable, 0);
});

test('after Stop, code naming a switched-off instrument is refused again, even if the stopped code named it', async () => {
  const r = makeSetupRig();
  const code = `${LEAD_LINE}\n${BANK_LINE()}`;
  await playing(r, code);
  r.out.setRig(bankOffRig());
  assert.equal(r.out.checkSetup(code), null, 'while the tab plays, the code that plays keeps its place');
  r.state.playing = false;
  const refused = r.out.checkSetup(code);
  assert.ok(refused.startsWith('Instrument "bank" (port "Port B") is switched off by the user'), refused);
  assert.equal(r.out.prepareSetup(code).refusal, refused, 'prepareSetup refuses it too');
  // The replay base still excuses the stored code while the tab is stopped (the hello replay).
  r.out.setReplayBase(code);
  assert.equal(r.out.checkSetup(code), null);
  r.out.setReplayBase(null);
  r.state.playing = true;
  assert.equal(r.out.checkSetup(code), null, 'playing again with the same code in place passes');
});
