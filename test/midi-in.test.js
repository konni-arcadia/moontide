import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMidiIn, LISTEN_TICK_MS } from '../page/midi-in.js';
import { createPlayedBuffer } from '../page/played-buffer.js';
import { SCRATCH_COPY } from '../page/scratch-model.js';

// Listening to a declared input, tested with a fake MIDIAccess and a fake timer. No real port is ever touched. All names are neutral.

class FakeInput extends EventTarget {
  constructor(name, state = 'connected') {
    super();
    Object.assign(this, { name, state, type: 'input', connection: 'closed', opens: 0, listeners: 0 });
  }
  addEventListener(type, listener, options) {
    if (type === 'midimessage') this.listeners += 1;
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    if (type === 'midimessage') this.listeners -= 1;
    super.removeEventListener(type, listener, options);
  }
  async open() {
    this.opens += 1;
    this.connection = 'open';
    return this;
  }
  play(bytes, timeStamp) {
    const event = new Event('midimessage');
    Object.defineProperty(event, 'data', { value: Uint8Array.from(bytes) });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    this.dispatchEvent(event);
  }
}

// The access object counts the statechange listeners added to it.
class FakeAccess extends EventTarget {
  addEventListener(type, listener, options) {
    if (type === 'statechange') this.statechangeListeners = (this.statechangeListeners ?? 0) + 1;
    super.addEventListener(type, listener, options);
  }
  // A plug or an unplug: the access says so with a statechange event, like Chrome.
  change() {
    this.dispatchEvent(new Event('statechange'));
  }
}

function fakeAccess(...names) {
  const access = new FakeAccess();
  const inputs = names.map((name) => (name instanceof FakeInput ? name : new FakeInput(name)));
  access.inputs = new Map(inputs.map((input, index) => [`in-${index}`, input]));
  access.list = inputs;
  return access;
}

// Cycle lines one second apart: cycle 10 at 5000 ms and cycle 11 at 6000 ms (the music at 1 cycle per second).
const LINES = { a: { c: 10, t: 5000 }, b: { c: 11, t: 6000 } };

function setup({ access = null, now = 5500, lines = LINES, cps = 1, playing = true, accessWord = 'enabled' } = {}) {
  const clock = { now, lines, cps, playing, accessWord, visible: true, holdsMusic: true, failure: null, enables: 0, reads: 0, timers: [], changes: 0, errors: [] };
  const buffer = createPlayedBuffer();
  const midiIn = createMidiIn({
    getAccess: () => clock.access ?? null,
    accessState: () => clock.accessWord,
    accessFailure: () => clock.failure,
    enable: async () => {
      clock.enables += 1;
    },
    isVisible: () => clock.visible,
    holdsMusic: () => clock.holdsMusic,
    readCycleLines: () => {
      clock.reads += 1;
      return clock.lines;
    },
    readCps: () => clock.cps,
    isPlaying: () => clock.playing,
    perfNow: () => clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      clock.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    buffer,
    onChange: () => {
      clock.changes += 1;
    },
    onError: (message) => clock.errors.push(message),
  });
  clock.access = access;
  clock.buffer = buffer;
  clock.midiIn = midiIn;
  clock.pending = () => clock.timers.filter((timer) => !timer.cleared && !timer.ran);
  clock.runTimer = () => {
    const [timer] = clock.pending();
    assert.ok(timer, 'no timer is waiting');
    timer.ran = true;
    timer.fn();
  };
  return clock;
}

test('an exactly named input is listened to, and opened once across several refreshes', async () => {
  const access = fakeAccess('Keys', 'Pads');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.midiIn.refresh();
  t.midiIn.refresh();
  const [keys, pads] = access.list;
  assert.equal(keys.listeners, 1, 'one listener, however many refreshes');
  assert.equal(keys.opens, 1, 'the port is opened once');
  assert.equal(pads.listeners, 0);
  assert.equal(pads.opens, 0);
  const state = t.midiIn.state();
  assert.equal(state.listen, 'listening');
  assert.deepEqual(state.listened, ['Keys']);
  assert.deepEqual(state.available, ['Keys', 'Pads']);
});

test('a port whose open() is refused is not said to be listening, is said once, and is asked again at the next refresh', async () => {
  const access = fakeAccess('Keys', 'Pads');
  const [keys] = access.list;
  let refuse = true;
  keys.open = async function open() {
    this.opens += 1;
    if (refuse) throw new Error('the port is busy');
    this.connection = 'open';
    return this;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  await settle();
  const failed = t.midiIn.state();
  assert.equal(failed.listen, 'not-opened');
  assert.deepEqual(failed.listened, []);
  assert.deepEqual(failed.notOpened, ['Keys']);
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0], /"Keys" could not be opened: the port is busy/);
  // The next refresh asks again; a second refusal is not said a second time.
  t.midiIn.refresh();
  await settle();
  assert.equal(keys.opens, 2);
  assert.equal(t.midiIn.state().listen, 'not-opened');
  assert.equal(t.errors.length, 1);
  // The program that held it lets go: the next refresh opens it and the page listens.
  refuse = false;
  t.midiIn.refresh();
  await settle();
  assert.equal(keys.opens, 3);
  assert.equal(t.midiIn.state().listen, 'listening');
  assert.deepEqual(t.midiIn.state().notOpened, []);
  t.midiIn.refresh();
  await settle();
  assert.equal(keys.opens, 3, 'an open port is not opened again');
});

test('one port heard and one refused to open is listening, and names the refused one', async () => {
  const access = fakeAccess('Keys', 'Pads');
  access.list[1].open = async () => {
    throw new Error('busy');
  };
  const t = setup({ access });
  t.midiIn.setInputs(['Keys', 'Pads'], 'valid');
  t.midiIn.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const state = t.midiIn.state();
  assert.equal(state.listen, 'listening');
  assert.deepEqual(state.listened, ['Keys']);
  assert.deepEqual(state.notOpened, ['Pads']);
});

test('a name is matched in full: Keys does not match Keys 2, and a missing name lists the connected inputs', () => {
  const access = fakeAccess('Keys 2', 'Pads');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const state = t.midiIn.state();
  assert.equal(state.listen, 'missing');
  assert.deepEqual(state.missing, ['Keys']);
  assert.deepEqual(state.available, ['Keys 2', 'Pads']);
  assert.deepEqual(state.listened, []);
  assert.equal(access.list[0].listeners, 0);
  assert.equal(access.list[0].opens, 0);
});

test('an input that is not connected is not listened to and is not listed as available', () => {
  const access = fakeAccess('Keys', new FakeInput('Pads', 'disconnected'));
  const t = setup({ access });
  t.midiIn.setInputs(['Pads'], 'valid');
  t.midiIn.refresh();
  const state = t.midiIn.state();
  assert.equal(state.listen, 'missing');
  assert.deepEqual(state.available, ['Keys']);
});

test('several inputs with the same exact name are refused loudly and none is listened to', () => {
  const access = fakeAccess('Keys', 'Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.midiIn.refresh();
  const state = t.midiIn.state();
  assert.equal(state.listen, 'ambiguous');
  assert.deepEqual(state.several, ['Keys']);
  assert.equal(access.list[0].listeners + access.list[1].listeners, 0);
  assert.equal(t.errors.length, 1, 'said once, not at every refresh');
});

test('no port named is "none" and a named port with no access yet waits for the permission', () => {
  const t = setup({ accessWord: 'idle' });
  t.midiIn.setInputs([], 'valid');
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'none');
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'needs-permission', 'named but MIDI not asked yet');
  assert.deepEqual(t.midiIn.state().ports, ['Keys']);
});

test('the access arriving later is listened to at the next refresh', () => {
  const access = fakeAccess('Keys');
  const t = setup({ accessWord: 'pending' });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'pending');
  t.access = access;
  t.accessWord = 'enabled';
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'listening');
  assert.equal(access.list[0].listeners, 1);
});

test('a port no longer named loses its listener and is not closed', () => {
  const access = fakeAccess('Keys');
  access.list[0].close = () => assert.fail('a port is never closed here');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.midiIn.setInputs([], 'valid');
  t.midiIn.refresh();
  assert.equal(access.list[0].listeners, 0);
  assert.equal(t.midiIn.state().listen, 'none');
});

test('0xF8 and 0xFE never read the cycle lines, and a controller change keeps nothing', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const keys = access.list[0];
  for (let i = 0; i < 100; i += 1) keys.play([0xf8], 5500);
  keys.play([0xfe], 5500);
  keys.play([0xb0, 64, 127], 5500);
  keys.play([0xe0, 0, 64], 5500);
  assert.equal(t.reads, 0);
  assert.equal(t.buffer.count(), 0);
  assert.equal(t.midiIn.state().refused, null);
});

test('a note with usable lines lands at the cycle of its time stamp', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5250);
  assert.equal(t.reads, 1);
  assert.deepEqual(t.buffer.notes(), [{ pitch: 60, velocity: 100, start: 10.25, end: null, run: 0 }]);
  assert.deepEqual(t.midiIn.state().heard, { pitch: 60, velocity: 100, cycle: 10.25, source: 'music' });
  assert.equal(t.midiIn.state().count, 1);
  access.list[0].play([0x80, 60, 0], 5500);
  assert.equal(t.buffer.notes()[0].end, 10.5);
});

test('two notes stamped one cycle apart land one cycle apart', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 6100 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5100);
  access.list[0].play([0x90, 62, 100], 6100);
  const [first, second] = t.buffer.notes();
  assert.ok(Math.abs(second.start - first.start - 1) < 1e-9);
});

test('a zero stamp and a stale one are refused with their reason and not kept', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 0);
  assert.equal(t.midiIn.state().refused, 'zero');
  access.list[0].play([0x90, 60, 100], 5600 - 1500);
  assert.equal(t.midiIn.state().refused, 'stale');
  access.list[0].play([0x90, 60, 100], 5600 + 50);
  assert.equal(t.midiIn.state().refused, 'ahead');
  assert.equal(t.buffer.count(), 0);
  assert.equal(t.reads, 0, 'a refused stamp never reads the cycle lines');
  assert.equal(t.midiIn.state().heard, null);
  assert.equal(t.errors.length, 3, 'one report per reason');
  access.list[0].play([0x90, 60, 100], 0);
  assert.equal(t.errors.length, 3, 'the same reason is not reported twice');
});

test('a note-off with a refused stamp still ends its held note, at the present cycle, and is not a refusal', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const [keys] = access.list;
  keys.play([0x90, 60, 100], 5500);
  // 400 ms later the off arrives with a stamp more than a second old (a stalled main thread): the music is at cycle 10.9.
  t.now = 5900;
  keys.play([0x80, 60, 0], 5900 - 1500);
  const [note] = t.buffer.notes();
  assert.ok(Math.abs(note.end - 10.9) < 1e-9, `ended at the present cycle, got ${note.end}`);
  // A note-on in its note-off form (velocity 0) with a zero stamp ends its held note too.
  keys.play([0x90, 62, 100], 5900);
  keys.play([0x90, 62, 0], 0);
  assert.ok(Math.abs(t.buffer.notes()[1].end - 10.9) < 1e-9);
  assert.equal(t.midiIn.state().refused, null);
  assert.deepEqual(t.errors, []);
  // An off for a pitch that is not held places nothing.
  keys.play([0x80, 64, 0], 0);
  assert.equal(t.buffer.count(), 2);
});

test('a note-off the axis cannot place ends its held note at the last cycle the axis gave', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  t.lines = null;
  t.cps = 0;
  t.playing = false;
  t.now = 5700;
  access.list[0].play([0x80, 60, 0], 5700);
  assert.equal(t.buffer.notes()[0].end, 10.5);
  assert.equal(t.midiIn.state().refused, null);
  assert.deepEqual(t.errors, []);
});

test('a note when the cycle lines are unreadable is refused as a clock refusal and not kept', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600, lines: null, cps: 0, playing: false });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  assert.equal(t.midiIn.state().refused, 'clock');
  assert.equal(t.buffer.count(), 0);
});

test('two lines with the same stamp are no lines: with no tempo the note is refused, not thrown out of the handler', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600, lines: { a: { c: 10, t: 5000 }, b: { c: 11, t: 5000 } }, cps: 0, playing: false });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  assert.equal(t.midiIn.state().refused, 'clock');
  assert.equal(t.buffer.count(), 0);
});

test('a kept note clears an earlier refusal', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 0);
  assert.equal(t.midiIn.state().refused, 'zero');
  access.list[0].play([0x90, 60, 100], 5500);
  assert.equal(t.midiIn.state().refused, null);
});

test('every note, kept or refused, tells the page the state changed', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const before = t.changes;
  access.list[0].play([0x90, 60, 100], 5500);
  access.list[0].play([0x90, 61, 100], 0);
  assert.equal(t.changes, before + 2);
});

test('the listen tick runs only while a port is listened to, and reads the cycle lines each time', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.refresh();
  assert.equal(t.pending().length, 0, 'nothing named, no tick');
  t.midiIn.setInputs(['Nope'], 'valid');
  t.midiIn.refresh();
  assert.equal(t.pending().length, 0, 'a missing port is not listened to, so no tick');
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.midiIn.refresh();
  assert.equal(t.pending().length, 1, 'one tick however many refreshes');
  assert.equal(t.pending()[0].ms, LISTEN_TICK_MS);
  const reads = t.reads;
  t.runTimer();
  assert.equal(t.reads, reads + 1);
  assert.equal(t.pending().length, 1, 'the tick schedules the next one');
  t.midiIn.setInputs([], 'valid');
  t.midiIn.refresh();
  assert.equal(t.pending().length, 0, 'the tick is cleared when nothing is listened to');
});

test('the tick tells the page when the count of notes changed without a message', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const before = t.changes;
  t.runTimer();
  assert.equal(t.changes, before, 'nothing changed');
  t.buffer.noteOn(1, 60, 80);
  t.runTimer();
  assert.equal(t.changes, before + 1);
});

test('the listener refuses a missing dependency and a bad list of names with a clear error', () => {
  assert.throws(() => createMidiIn({}), /needs getAccess/);
  const t = setup();
  assert.throws(() => t.midiIn.setInputs('Keys'), /list of port names/);
  assert.throws(() => t.midiIn.setInputs([5], 'valid'), /list of port names/);
});

test('the tick counts the notes at the present cycle, so a note that left the window is gone', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.buffer.noteOn(10, 60, 80);
  t.buffer.noteOff(10.1, 60);
  const before = t.changes;
  t.runTimer();
  assert.equal(t.changes, before + 1);
  assert.equal(t.midiIn.state().count, 1);
  // Ten seconds later at one cycle per second the music is at cycle 20.5: the window starts at cycle 13.
  t.now = 15500;
  t.lines = { a: { c: 20, t: 15000 }, b: { c: 21, t: 16000 } };
  t.runTimer();
  assert.equal(t.changes, before + 2);
  assert.equal(t.midiIn.state().count, 0);
});

test('snapshot gives the buffer window at the present cycle, and null when there are no lines and no tempo', () => {
  const t = setup({ now: 5500 });
  t.buffer.noteOn(10.1, 60, 90);
  t.buffer.noteOff(10.3, 60);
  const snapshot = t.midiIn.snapshot();
  assert.deepEqual(snapshot, t.buffer.snapshot(10.5));
  assert.equal(snapshot.start, 3);
  assert.equal(snapshot.notes.length, 1);
  t.lines = null;
  t.cps = 0;
  t.playing = false;
  assert.equal(t.midiIn.snapshot(), null);
  assert.deepEqual(t.errors, []);
});

test('a full buffer is said once, in the state, and the newest notes are not kept', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const [keys] = access.list;
  for (let index = 0; index < 2000; index += 1) keys.play([0x90, 20 + (index % 100), 80], 5500);
  assert.equal(t.midiIn.state().refused, null);
  keys.play([0x90, 60, 80], 5500);
  keys.play([0x90, 61, 80], 5500);
  const state = t.midiIn.state();
  assert.equal(state.refused, 'full');
  assert.equal(state.count, 2000);
  assert.equal(t.errors.filter((message) => message.includes('full')).length, 1);
  keys.play([0x80, 20, 0], 5500);
  assert.equal(t.midiIn.state().refused, 'full', 'a note-off does not wipe the sentence');
});

// --- the source: no send, no access request, no assignment to a port's handler property ---

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('midi-in and the buffer assign no port handler property, send nothing and never ask for MIDI access', () => {
  for (const file of ['../page/midi-in.js', '../page/played-buffer.js']) {
    const code = codeOf(read(file));
    assert.doesNotMatch(code, /\.onmidimessage\s*=(?!=)/, `${file} must not assign onmidimessage`);
    assert.doesNotMatch(code, /\.onstatechange\s*=(?!=)/, `${file} must not assign onstatechange`);
    assert.doesNotMatch(code, /\.send\s*\(/, `${file} must not send`);
    assert.doesNotMatch(code, /requestMIDIAccess/, `${file} must not ask for MIDI access`);
    assert.doesNotMatch(code, /\.close\s*\(/, `${file} must not close a port`);
  }
});

test('with the music stopped, a note is kept by the tempo, from source free, and snapshot works', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5000, lines: null, cps: 0.5, playing: false });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.runTimer();
  t.now = 5600;
  access.list[0].play([0x90, 60, 100], 5400);
  assert.equal(t.midiIn.state().refused, null);
  assert.equal(t.midiIn.state().heard.source, 'free');
  assert.equal(t.buffer.count(), 1);
  // Two notes one cycle of the tempo (2000 ms at 0.5 cycle per second) apart land one cycle apart.
  t.now = 7400;
  access.list[0].play([0x90, 62, 100], 7400);
  t.now = 5900;
  const [first, second] = t.buffer.notes();
  assert.ok(Math.abs(second.start - first.start - 1.0) < 1e-9);
  const snapshot = t.midiIn.snapshot();
  assert.notEqual(snapshot, null);
  assert.equal(snapshot.notes.length, 2);
});

test('Stop then Play moves the heard cycles forward, never back', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  const before = t.midiIn.state().heard.cycle;
  assert.equal(t.midiIn.state().heard.source, 'music');
  // Stop: the lines go, the tick sees it, the axis runs on by the tempo (one cycle per second).
  t.lines = null;
  t.playing = false;
  t.now = 6500;
  t.runTimer();
  access.list[0].play([0x90, 62, 100], 6500);
  assert.equal(t.midiIn.state().heard.source, 'free');
  const stopped = t.midiIn.state().heard.cycle;
  assert.ok(stopped > before);
  // Play again: the scheduler restarts at cycle 0.2; the axis moves forward to a whole cycle beyond where it was.
  t.playing = true;
  t.now = 9000;
  t.lines = { a: { c: 0, t: 8800 }, b: { c: 1, t: 9800 } };
  t.runTimer();
  access.list[0].play([0x90, 64, 100], 9000);
  assert.equal(t.midiIn.state().heard.source, 'music');
  assert.ok(t.midiIn.state().heard.cycle > stopped);
});

test('a note placed on the music\'s lines keeps the axis offset as its run, and a note placed by the tempo keeps none', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  // Stop: the tempo places the next note, with no run.
  t.lines = null;
  t.playing = false;
  t.now = 6500;
  t.runTimer();
  access.list[0].play([0x90, 62, 100], 6500);
  // Play again with the scheduler back near cycle 0: the axis offset is whole cycles ahead of the music's count.
  t.playing = true;
  t.now = 9000;
  t.lines = { a: { c: 0, t: 8800 }, b: { c: 1, t: 9800 } };
  t.runTimer();
  access.list[0].play([0x90, 64, 100], 9000);
  t.now = 9500;
  access.list[0].play([0x90, 65, 100], 9500);
  const runs = [60, 62, 64, 65].map((pitch) => t.buffer.notes().find((note) => note.pitch === pitch)?.run);
  assert.equal(runs[0], 0, 'the first read on the music\'s lines has offset 0');
  assert.equal(runs[1], null, 'a note placed by the tempo has no run');
  assert.ok(Number.isInteger(runs[2]) && runs[2] > 0, 'after a Play the offset is a whole number above 0');
  assert.equal(runs[3], runs[2], 'notes of one run of the music keep one run');
  const heard = t.midiIn.state().heard;
  assert.ok(Math.abs(heard.cycle - runs[3] - 0.7) < 1e-6, 'the axis cycle is the music\'s cycle plus the run');
});

test('no lines and a cps of 0 refuse the note with the new words', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5600, lines: null, cps: 0, playing: false });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  assert.equal(t.midiIn.state().refused, 'clock');
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0], /the music gives no cycle and the tempo is not above 0/);
  assert.equal(SCRATCH_COPY.heardRefusedClock, "A note from the keyboard was not kept: the music's clock gives no cycle and the tempo is not above 0.");
});

test('the listener needs readCps and isPlaying', () => {
  const base = {
    getAccess: () => null,
    accessState: () => 'idle',
    enable: async () => {},
    isVisible: () => true,
    holdsMusic: () => true,
    readCycleLines: () => null,
    perfNow: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    buffer: createPlayedBuffer(),
  };
  assert.throws(() => createMidiIn({ ...base, isPlaying: () => true }), /needs readCps/);
  assert.throws(() => createMidiIn({ ...base, readCps: () => 1 }), /needs isPlaying/);
});

// --- the states, the plug and the unplug, and the one shared enable ---

test('every listen word comes from its own condition', () => {
  const keys = () => fakeAccess('Keys', 'Pads');
  const at = (options, names, setupWord = 'valid', access = keys()) => {
    const t = setup({ access, ...options });
    t.midiIn.setInputs(names, setupWord);
    t.midiIn.refresh();
    return t.midiIn.state();
  };
  assert.equal(at({}, [], 'absent').listen, 'absent');
  assert.equal(at({}, ['Keys'], 'invalid').listen, 'invalid', 'a file with a problem names no port');
  assert.deepEqual(at({}, ['Keys'], 'invalid').ports, []);
  assert.equal(at({}, [], 'valid').listen, 'none');
  assert.equal(at({ accessWord: 'idle', access: null }, ['Keys'], 'valid', null).listen, 'needs-permission');
  assert.equal(at({ accessWord: 'pending', access: null }, ['Keys'], 'valid', null).listen, 'pending');
  assert.equal(at({ accessWord: 'denied', access: null }, ['Keys'], 'valid', null).listen, 'denied');
  assert.equal(at({ accessWord: 'unsupported', access: null }, ['Keys'], 'valid', null).listen, 'unsupported');
  const failed = setup({ accessWord: 'failed' });
  failed.failure = 'AbortError';
  failed.midiIn.setInputs(['Keys'], 'valid');
  failed.midiIn.refresh();
  assert.equal(failed.midiIn.state().listen, 'failed');
  assert.equal(failed.midiIn.state().failure, 'AbortError');
  const noAccess = setup({ accessWord: 'enabled' });
  noAccess.midiIn.setInputs(['Keys'], 'valid');
  noAccess.midiIn.refresh();
  assert.equal(noAccess.midiIn.state().listen, 'failed', 'on, but the access cannot be read');
  assert.equal(noAccess.midiIn.state().failure, 'NoAccess');
  const missing = at({}, ['Keyz']);
  assert.equal(missing.listen, 'missing');
  assert.deepEqual(missing.missing, ['Keyz']);
  assert.deepEqual(missing.unplugged, []);
  assert.deepEqual(missing.available, ['Keys', 'Pads']);
  assert.equal(at({}, ['Keys', 'Keyz']).listen, 'listening', 'one heard is listening');
  assert.deepEqual(at({}, ['Keys', 'Keyz']).missing, ['Keyz'], 'and the other is named as not found');
  const both = at({}, ['Keys', 'Pads']);
  assert.equal(both.listen, 'listening');
  assert.deepEqual(both.listened, ['Keys', 'Pads']);
  const doubled = at({}, ['Keys'], 'valid', fakeAccess('Keys', 'Keys'));
  assert.equal(doubled.listen, 'ambiguous');
});

test('an input seen and then gone is "unplugged" with the inputs that exist, and listening resumes when it is back', () => {
  const access = fakeAccess('Keys', 'Pads');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const [keys] = access.list;
  assert.equal(t.midiIn.state().listen, 'listening');
  keys.state = 'disconnected';
  access.change();
  const gone = t.midiIn.state();
  assert.equal(gone.listen, 'unplugged');
  assert.deepEqual(gone.unplugged, ['Keys']);
  assert.deepEqual(gone.available, ['Pads']);
  assert.equal(keys.listeners, 0, 'the listener is taken off the gone port');
  assert.equal(t.pending().length, 0, 'and the tick stops');
  keys.state = 'connected';
  access.change();
  assert.equal(t.midiIn.state().listen, 'listening');
  assert.equal(keys.listeners, 1);
  keys.play([0x90, 60, 100], 5500);
  assert.equal(t.buffer.count(), 1, 'notes after the replug are heard');
});

test('a replug that brings a new port object is listened to again, matched by its exact name', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const [first] = access.list;
  access.inputs.clear();
  access.change();
  assert.equal(t.midiIn.state().listen, 'unplugged');
  assert.equal(first.listeners, 0);
  const second = new FakeInput('Keys');
  access.inputs.set('in-9', second);
  access.change();
  assert.equal(t.midiIn.state().listen, 'listening');
  assert.equal(second.listeners, 1);
  assert.equal(second.opens, 1);
  second.play([0x90, 62, 90], 5500);
  assert.equal(t.buffer.count(), 1);
});

test('the several events of one plug do no harm, and the access carries one statechange listener', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.midiIn.refresh();
  assert.equal(access.statechangeListeners, 1, 'one listener however many refreshes');
  for (let i = 0; i < 5; i += 1) access.change();
  assert.equal(access.list[0].listeners, 1);
  assert.equal(access.list[0].opens, 1);
  assert.equal(t.pending().length, 1);
});

test('an unplug ends a held note at the cycle of that moment and keeps the buffer', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  assert.equal(t.buffer.notes()[0].end, null, 'held');
  // 400 ms later at one cycle per second the music is at cycle 10.9.
  t.now = 5900;
  access.list[0].state = 'disconnected';
  access.change();
  const [note] = t.buffer.notes();
  assert.ok(Math.abs(note.end - 10.9) < 1e-9, `closed at the moment of the unplug, got ${note.end}`);
  assert.equal(t.buffer.count(), 1, 'the buffer is kept');
});

test('a rig change that drops the listened port ends a held note too, and the same rig again does not', () => {
  const access = fakeAccess('Keys', 'Pads');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  t.now = 5700;
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  assert.equal(t.buffer.notes()[0].end, null, 'the same rig changes nothing');
  t.now = 5800;
  t.midiIn.setInputs(['Pads'], 'valid');
  t.midiIn.refresh();
  assert.ok(Math.abs(t.buffer.notes()[0].end - 10.8) < 1e-9);
});

test('an unplug with no way to read the axis ends the held note at the last cycle it knew', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  access.list[0].play([0x90, 60, 100], 5500);
  t.lines = null;
  t.cps = 0;
  t.playing = false;
  access.list[0].state = 'disconnected';
  access.change();
  assert.equal(t.buffer.notes()[0].end, 10.5);
});

test('allow() calls the shared enable once, then reads the access again, and nothing else calls it', async () => {
  const access = fakeAccess('Keys');
  const t = setup({ accessWord: 'idle' });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.midiIn.refresh();
  t.midiIn.state();
  assert.equal(t.enables, 0, 'nothing asks for MIDI by itself');
  assert.equal(t.midiIn.state().listen, 'needs-permission');
  t.access = access;
  t.accessWord = 'enabled';
  await t.midiIn.allow();
  assert.equal(t.enables, 1);
  assert.equal(t.midiIn.state().listen, 'listening', 'the access is read after the answer');
  t.midiIn.refresh();
  assert.equal(t.enables, 1);
});

test('an enable that throws is said and the listener goes on', async () => {
  const errors = [];
  const failing = createMidiIn({
    getAccess: () => null,
    accessState: () => 'idle',
    enable: () => Promise.reject(new Error('boom')),
    isVisible: () => true,
    holdsMusic: () => true,
    readCycleLines: () => null,
    readCps: () => 1,
    isPlaying: () => false,
    perfNow: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    buffer: createPlayedBuffer(),
    onError: (message) => errors.push(message),
  });
  await failing.allow();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /boom/);
});

test('setInputs refuses a setup word it does not know', () => {
  const t = setup();
  assert.throws(() => t.midiIn.setInputs(['Keys']), /setup file's state/);
  assert.throws(() => t.midiIn.setInputs(['Keys'], 'maybe'), /setup file's state/);
});

// --- only a visible tab that holds the music listens ---

test('a hidden tab listens to nothing: listeners removed, held note closed, tick stopped, buffer kept; shown again it listens again', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const [keys] = access.list;
  keys.play([0x90, 60, 100], 5500);
  assert.equal(t.pending().length, 1);
  t.now = 5800;
  t.visible = false;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'hidden');
  assert.equal(keys.listeners, 0, 'no listener, so no note can be kept');
  assert.equal(t.pending().length, 0, 'the tick is stopped');
  assert.ok(Math.abs(t.buffer.notes()[0].end - 10.8) < 1e-9, 'the held note is closed at the moment of the hide');
  keys.play([0x90, 62, 100], 5800);
  assert.equal(t.buffer.count(), 1, 'a note played while hidden is not kept');
  assert.equal(t.midiIn.snapshot().notes.length, 1, 'the buffer is kept, so Record that still has its notes');
  t.visible = true;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'listening');
  assert.equal(keys.listeners, 1);
  assert.equal(keys.opens, 1, 'the port is not opened a second time');
  assert.equal(t.pending().length, 1);
  keys.play([0x90, 64, 100], 5800);
  assert.equal(t.buffer.count(), 2);
});

test('a tab that lost the music says other-tab, keeps nothing, and listens again when the music is taken back', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access, now: 5500 });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  const [keys] = access.list;
  t.holdsMusic = false;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'other-tab');
  assert.equal(keys.listeners, 0);
  keys.play([0x90, 60, 100], 5500);
  assert.equal(t.buffer.count(), 0);
  t.holdsMusic = true;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'listening');
  keys.play([0x90, 60, 100], 5500);
  assert.equal(t.buffer.count(), 1);
});

test('a hidden tab that has also lost the music says other-tab, because showing it would not help', () => {
  const access = fakeAccess('Keys');
  const t = setup({ access });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.visible = false;
  t.holdsMusic = false;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'other-tab');
  t.holdsMusic = true;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'hidden');
});

test('the permission words come before the tab words, and a hidden tab still follows a plug', () => {
  const access = fakeAccess('Keys', 'Pads');
  const t = setup({ access, accessWord: 'idle' });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.visible = false;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'needs-permission');
  t.accessWord = 'enabled';
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'hidden');
  access.list[0].state = 'disconnected';
  access.change();
  t.visible = true;
  t.midiIn.refresh();
  assert.equal(t.midiIn.state().listen, 'unplugged', 'the name was seen while the tab was hidden');
});

test('the listener needs isVisible and holdsMusic', () => {
  const base = {
    getAccess: () => null,
    accessState: () => 'idle',
    enable: async () => {},
    readCycleLines: () => null,
    readCps: () => 1,
    isPlaying: () => true,
    perfNow: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    buffer: createPlayedBuffer(),
  };
  assert.throws(() => createMidiIn({ ...base, holdsMusic: () => true }), /needs isVisible/);
  assert.throws(() => createMidiIn({ ...base, isVisible: () => true }), /needs holdsMusic/);
});

// live(): the axis now and a revision, read by the page every animation frame.

function listening(options = {}) {
  const access = fakeAccess('Keys');
  const t = setup({ access, ...options });
  t.midiIn.setInputs(['Keys'], 'valid');
  t.midiIn.refresh();
  t.keys = access.list[0];
  return t;
}

test('live gives null when there are no cycle lines and no tempo, else the axis cycle now and a revision', () => {
  const t = setup({ now: 5500 });
  const first = t.midiIn.live();
  assert.deepEqual(Object.keys(first), ['now', 'revision']);
  assert.ok(Math.abs(first.now - 10.5) < 1e-9, String(first.now));
  assert.equal(Number.isInteger(first.revision), true);
  t.now = 5750;
  assert.ok(Math.abs(t.midiIn.live().now - 10.75) < 1e-9);
  t.lines = null;
  t.cps = 0;
  t.playing = false;
  assert.equal(t.midiIn.live(), null);
  assert.deepEqual(t.errors, []);
});

test('the revision stays the same while nothing in the buffer changes, and grows when a note is kept', () => {
  const t = listening();
  const before = t.midiIn.live().revision;
  t.now = 5520;
  assert.equal(t.midiIn.live().revision, before, 'time passing alone changes nothing');
  assert.equal(t.midiIn.live().revision, before);
  t.keys.play([0x90, 60, 100], 5500);
  const kept = t.midiIn.live().revision;
  assert.ok(kept > before);
  assert.equal(t.midiIn.live().revision, kept, 'reading it again changes nothing');
});

test('the revision grows when a held note ends, and not for an off with nothing held or a note that was refused', () => {
  const t = listening();
  t.keys.play([0x90, 60, 100], 5500);
  const held = t.midiIn.live().revision;
  t.keys.play([0x80, 62, 0], 5500);
  assert.equal(t.midiIn.live().revision, held, 'an off for a key that is not held ends nothing');
  t.keys.play([0x90, 64, 100], 0);
  assert.equal(t.midiIn.live().revision, held, 'a refused stamp keeps nothing');
  t.keys.play([0x80, 60, 0], 5500);
  const ended = t.midiIn.live().revision;
  assert.ok(ended > held);
  t.keys.play([0x80, 60, 0], 5500);
  assert.equal(t.midiIn.live().revision, ended, 'a second off ends nothing more');
});

test('the revision grows when the tick finds notes gone from the window, when held notes are closed, and when the window moves on', () => {
  const t = listening();
  t.runTimer();
  t.keys.play([0x90, 60, 100], 5500);
  t.keys.play([0x80, 60, 0], 5500);
  const settled = t.midiIn.live().revision;
  // Ten seconds on the note has left the window: the tick sees the count change.
  t.now = 15500;
  t.lines = { a: { c: 20, t: 15000 }, b: { c: 21, t: 16000 } };
  t.runTimer();
  const gone = t.midiIn.live().revision;
  assert.ok(gone > settled);
  // A held note closed by an unplug.
  t.keys.play([0x90, 62, 100], 15500);
  const heldNow = t.midiIn.live().revision;
  t.midiIn.setInputs([], 'valid');
  t.midiIn.refresh();
  assert.ok(t.midiIn.live().revision > heldNow);
  // The window starts at a new whole cycle: the cut of a note that reaches into it changes, so the layer is read again.
  const same = t.midiIn.live().revision;
  t.now = 16600;
  t.lines = { a: { c: 21, t: 16000 }, b: { c: 22, t: 17000 } };
  assert.ok(t.midiIn.live().revision > same);
});

test('clearBuffer empties the buffer, the count and the heard line, raises the revision and tells the page once', () => {
  const t = listening();
  t.keys.play([0x90, 60, 100], 5500);
  t.keys.play([0x90, 64, 100], 5500);
  assert.equal(t.midiIn.state().count, 2);
  assert.notEqual(t.midiIn.state().heard, null);
  const before = t.midiIn.live().revision;
  const changes = t.changes;
  t.midiIn.clearBuffer();
  assert.equal(t.changes, changes + 1);
  assert.equal(t.midiIn.state().count, 0);
  assert.equal(t.midiIn.state().heard, null);
  assert.deepEqual(t.buffer.notes(), []);
  assert.deepEqual(t.midiIn.snapshot().notes, []);
  assert.ok(t.midiIn.live().revision > before);
});

test('a key let go after clearBuffer is ignored harmlessly and keeps nothing', () => {
  const t = listening();
  t.keys.play([0x90, 60, 100], 5500);
  t.midiIn.clearBuffer();
  const revision = t.midiIn.live().revision;
  t.keys.play([0x80, 60, 0], 5600);
  assert.equal(t.midiIn.state().count, 0);
  assert.equal(t.midiIn.live().revision, revision);
  assert.deepEqual(t.errors, []);
});
