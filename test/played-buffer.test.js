import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUFFER_CYCLES, MAX_BUFFER_NOTES, createCycleAxis, createPlayedBuffer, parseNoteMessage } from '../page/played-buffer.js';
import { cycleAtStamp } from '../page/scratch-model.js';

// The bytes of a MIDI message are read once, here, and a note is kept with the cycles it started and ended at. All data is neutral.

test('a note-on and a note-off are read with their pitch, velocity and channel', () => {
  assert.deepEqual(parseNoteMessage([0x90, 60, 100]), { kind: 'on', pitch: 60, velocity: 100, channel: 1 });
  assert.deepEqual(parseNoteMessage([0x80, 60, 64]), { kind: 'off', pitch: 60, velocity: 64, channel: 1 });
  assert.deepEqual(parseNoteMessage(new Uint8Array([0x93, 72, 1])), { kind: 'on', pitch: 72, velocity: 1, channel: 4 });
});

test('channel 16 is read as 16 on both kinds', () => {
  assert.equal(parseNoteMessage([0x9f, 60, 90]).channel, 16);
  assert.equal(parseNoteMessage([0x8f, 60, 0]).channel, 16);
});

test('a note-on of velocity 0 is a note-off', () => {
  assert.deepEqual(parseNoteMessage([0x90, 60, 0]), { kind: 'off', pitch: 60, velocity: 0, channel: 1 });
});

test('everything that is not a three-byte note message gives null', () => {
  const ignored = {
    clock: [0xf8],
    'active sensing': [0xfe],
    'control change (sustain pedal)': [0xb0, 64, 127],
    'pitch bend': [0xe0, 0, 64],
    'channel aftertouch': [0xd0, 50],
    'key aftertouch': [0xa0, 60, 50],
    'program change': [0xc0, 5],
    'system exclusive': [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7],
    'a short note message': [0x90, 60],
    'a long note message': [0x90, 60, 100, 0],
    empty: [],
    'a status byte first missing (running status)': [60, 100, 0],
  };
  for (const [name, bytes] of Object.entries(ignored)) assert.equal(parseNoteMessage(bytes), null, name);
});

test('a data byte of 128, a negative or a fraction is refused', () => {
  assert.equal(parseNoteMessage([0x90, 128, 100]), null);
  assert.equal(parseNoteMessage([0x90, 60, 128]), null);
  assert.equal(parseNoteMessage([0x90, -1, 100]), null);
  assert.equal(parseNoteMessage([0x90, 60.5, 100]), null);
  assert.equal(parseNoteMessage([0x90, '60', 100]), null);
});

test('data that is not a list of bytes gives null', () => {
  for (const value of [null, undefined, 5, 'abc', {}, { length: 3 }]) assert.equal(parseNoteMessage(value), null, String(value));
});

test('a note is kept with its start and end in cycles, and count() counts the notes', () => {
  const buffer = createPlayedBuffer();
  assert.equal(buffer.count(), 0);
  buffer.noteOn(10.25, 60, 100);
  assert.equal(buffer.count(), 1);
  assert.deepEqual(buffer.notes(), [{ pitch: 60, velocity: 100, start: 10.25, end: null, run: null }]);
  buffer.noteOff(10.75, 60);
  assert.deepEqual(buffer.notes(), [{ pitch: 60, velocity: 100, start: 10.25, end: 10.75, run: null }]);
  assert.equal(buffer.count(), 1);
});

test('a note-off for a pitch that is not held does nothing', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOff(3, 60);
  assert.equal(buffer.count(), 0);
  buffer.noteOn(1, 60, 80);
  buffer.noteOff(2, 60);
  buffer.noteOff(3, 60);
  assert.deepEqual(buffer.notes(), [{ pitch: 60, velocity: 80, start: 1, end: 2, run: null }]);
});

test('a second note-on of a held pitch ends the first at that cycle', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(1, 60, 80);
  buffer.noteOn(1.5, 60, 90);
  assert.deepEqual(buffer.notes(), [
    { pitch: 60, velocity: 80, start: 1, end: 1.5, run: null },
    { pitch: 60, velocity: 90, start: 1.5, end: null, run: null },
  ]);
  buffer.noteOff(2, 60);
  assert.equal(buffer.notes()[1].end, 2);
});

test('two pitches are held and ended apart', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(1, 60, 80);
  buffer.noteOn(1.25, 64, 70);
  buffer.noteOff(1.5, 60);
  assert.deepEqual(buffer.notes().map((note) => [note.pitch, note.end]), [[60, 1.5], [64, null]]);
});

test('an end can never come before its start', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(5, 60, 80);
  buffer.noteOff(4.9, 60);
  assert.equal(buffer.notes()[0].end, 5);
});

test('the notes() copy is not the buffer itself', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(1, 60, 80);
  buffer.notes()[0].end = 99;
  assert.equal(buffer.notes()[0].end, null);
});

test('a cycle, a pitch or a velocity that cannot be used throws instead of being kept', () => {
  const buffer = createPlayedBuffer();
  assert.throws(() => buffer.noteOn(Number.NaN, 60, 80), /finite cycle/);
  assert.throws(() => buffer.noteOn(Infinity, 60, 80), /finite cycle/);
  assert.throws(() => buffer.noteOn(1, 128, 80), /pitch/);
  assert.throws(() => buffer.noteOn(1, 60, 0), /velocity/);
  assert.throws(() => buffer.noteOff('1', 60), /finite cycle/);
  assert.equal(buffer.count(), 0);
});

// The window: the 8 whole cycles that end with the current one.

function play(buffer, cycle, pitch, off = null, velocity = 100) {
  buffer.noteOn(cycle, pitch, velocity);
  if (off !== null) buffer.noteOff(off, pitch);
}

test('the buffer keeps 8 cycles, the roll maximum', () => {
  assert.equal(BUFFER_CYCLES, 8);
});

test('the window is the 8 whole cycles that end with the current one: older notes are gone', () => {
  const buffer = createPlayedBuffer();
  play(buffer, 1.2, 60, 1.4);
  play(buffer, 9.1, 62, 9.3);
  assert.equal(buffer.count(9.5), 1);
  assert.deepEqual(buffer.notes().map((note) => note.pitch), [62]);
});

test('a note from before the window is kept while it still reaches into it, and snapshot cuts it at the edge', () => {
  const buffer = createPlayedBuffer();
  play(buffer, 1.5, 60, 2.5);
  assert.equal(buffer.count(9.2), 1);
  const snapshot = buffer.snapshot(9.2);
  assert.equal(snapshot.start, 2);
  assert.equal(snapshot.cycles, 8);
  assert.deepEqual(snapshot.notes, [{ pitch: 60, velocity: 100, start: 0, end: 0.5, run: null, held: false }]);
});

test('a note that ended exactly at the window start is gone', () => {
  const buffer = createPlayedBuffer();
  play(buffer, 1.5, 60, 2);
  assert.equal(buffer.count(9.2), 0);
});

test('a held note is closed at the moment of the snapshot, and the buffer still holds it open', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(9.3, 60, 90);
  const snapshot = buffer.snapshot(9.6);
  assert.deepEqual(snapshot.notes, [{ pitch: 60, velocity: 90, start: 9.3 - 2, end: 9.6 - 2, run: null, held: true }]);
  assert.equal(buffer.notes()[0].end, null);
});

test('a snapshot note still held says so with held true, and a note whose key was let go says held false', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(9.1, 60, 90);
  buffer.noteOn(9.2, 62, 90);
  buffer.noteOff(9.4, 62);
  buffer.noteOn(9.5, 62, 90);
  assert.deepEqual(buffer.snapshot(9.8).notes.map((note) => [note.pitch, note.held]), [[60, true], [62, false], [62, true]]);
  buffer.closeAll(9.9);
  assert.deepEqual(buffer.snapshot(9.95).notes.map((note) => note.held), [false, false, false]);
});

test('a held note is never dropped by the window', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(1.2, 60, 90);
  assert.equal(buffer.count(20.5), 1);
  assert.deepEqual(buffer.snapshot(20.5).notes, [{ pitch: 60, velocity: 90, start: 0, end: 20.5 - 13, run: null, held: true }]);
});

test('snapshot comes in the order played and leaves the buffer as it was', () => {
  const buffer = createPlayedBuffer();
  play(buffer, 8.5, 64, 8.6);
  play(buffer, 8.1, 60, 8.2);
  const before = buffer.notes();
  const snapshot = buffer.snapshot(8.9);
  assert.deepEqual(snapshot.notes.map((note) => note.pitch), [64, 60]);
  assert.deepEqual(buffer.notes(), before);
  snapshot.notes[0].pitch = 1;
  assert.equal(buffer.notes()[0].pitch, 64);
});

test('a second on of a held pitch ends the first at that cycle in the snapshot too', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(8.1, 60, 80);
  buffer.noteOn(8.4, 60, 90);
  const ends = buffer.snapshot(8.6).notes.map((note) => note.end);
  assert.deepEqual(ends, [8.4 - 1, 8.6 - 1]);
});

test('a late stamp never moves the window back', () => {
  const buffer = createPlayedBuffer();
  play(buffer, 12, 60, 12.1);
  play(buffer, 11.8, 62, 11.9);
  assert.equal(buffer.count(), 2);
  assert.equal(buffer.snapshot(11.9).start, 5);
});

test('closeAll ends every held note at that cycle', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(3, 60, 80);
  buffer.noteOn(3.5, 64, 80);
  buffer.noteOff(3.6, 64);
  buffer.closeAll(4);
  assert.deepEqual(buffer.notes().map((note) => note.end), [4, 3.6]);
});

test('clear empties the buffer', () => {
  const buffer = createPlayedBuffer();
  play(buffer, 3, 60, 3.5);
  buffer.clear();
  assert.equal(buffer.count(), 0);
  assert.deepEqual(buffer.snapshot(3).notes, []);
});

test('the 2001st note-on is not kept and noteOn says the buffer is full', () => {
  const buffer = createPlayedBuffer();
  assert.equal(MAX_BUFFER_NOTES, 2000);
  for (let index = 0; index < MAX_BUFFER_NOTES; index += 1) {
    assert.deepEqual(buffer.noteOn(5 + index / 1000, 60 + (index % 12), 80), { kept: true });
  }
  assert.deepEqual(buffer.noteOn(7.5, 60, 80), { kept: false, full: true });
  assert.equal(buffer.count(), MAX_BUFFER_NOTES);
});

test('notes that leave the window make room under the cap', () => {
  const buffer = createPlayedBuffer();
  for (let index = 0; index < MAX_BUFFER_NOTES; index += 1) buffer.noteOn(1 + index / 4000, 60, 80);
  buffer.closeAll(1.9);
  assert.equal(buffer.noteOn(20, 60, 80).kept, true);
  assert.equal(buffer.count(), 1);
});

// The cycle axis: the music's own cycle lines while it plays, the scheduler's tempo while it is stopped. Every read is handed its moment.

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);

// Cycle lines of a scheduler that stands at cycle `c` at `h` and runs at `cps`.
const linesAt = (c, h, cps = 0.5) => ({ a: { c: 0, t: h - (c * 1000) / cps }, b: { c: 1, t: h - (c * 1000) / cps + 1000 / cps } });

test('the first read with cycle lines is on the music, offset 0', () => {
  const axis = createCycleAxis();
  const got = axis.at(1500, { music: { a: { c: 3, t: 1000 }, b: { c: 4, t: 3000 } }, cps: 0.5, playing: true });
  assert.equal(got.source, 'music');
  near(got.now, 3.25);
  assert.deepEqual(got.anchors, { a: { c: 3, t: 1000 }, b: { c: 4, t: 3000 } });
});

test('the first read without lines runs on the tempo from cycle 0', () => {
  const axis = createCycleAxis();
  const got = axis.at(1000, { music: null, cps: 0.5, playing: false });
  assert.equal(got.source, 'free');
  assert.equal(got.now, 0);
  assert.deepEqual(got.anchors, { a: { c: 0, t: 1000 }, b: { c: 1, t: 3000 } });
});

test('Play after the tempo axis moves forward by whole cycles to the next whole cycle', () => {
  const axis = createCycleAxis();
  axis.at(1000, { music: null, cps: 0.5, playing: false });
  const got = axis.at(4000, { music: { a: { c: 0, t: 3800 }, b: { c: 1, t: 5800 } }, cps: 0.5, playing: true });
  assert.equal(got.source, 'music');
  near(got.now, 2.1);
  assert.deepEqual(got.anchors, { a: { c: 2, t: 3800 }, b: { c: 3, t: 5800 } });
});

test('Stop carries the music line on without a jump, Play again goes forward', () => {
  const axis = createCycleAxis();
  axis.at(1000, { music: null, cps: 0.5, playing: false });
  axis.at(4000, { music: { a: { c: 0, t: 3800 }, b: { c: 1, t: 5800 } }, cps: 0.5, playing: true });
  const stopped = axis.at(6100, { music: null, cps: 0.5, playing: false });
  assert.equal(stopped.source, 'free');
  near(stopped.now, 3.15);
  near(axis.at(10100, { music: null, cps: 0.5, playing: false }).now, 5.15);
  const again = axis.at(10100, { music: linesAt(0.05, 10100), cps: 0.5, playing: true });
  assert.equal(again.source, 'music');
  near(again.now, 6.05);
});

test('a gap in the lines while playing keeps the last line and never costs a cycle', () => {
  const axis = createCycleAxis();
  axis.at(1000, { music: null, cps: 0.5, playing: false });
  axis.at(4000, { music: { a: { c: 0, t: 3800 }, b: { c: 1, t: 5800 } }, cps: 0.5, playing: true });
  const gap = axis.at(4500, { music: null, cps: 0.5, playing: true });
  assert.equal(gap.source, 'music');
  near(gap.now, 2.35);
  near(axis.at(5000, { music: { a: { c: 0, t: 3800 }, b: { c: 1, t: 5800 } }, cps: 0.5, playing: true }).now, 2.6);
});

test('a Play whose clock is still warming up stays on the tempo, never on the line from before the Stop', () => {
  const axis = createCycleAxis();
  axis.at(1000, { music: linesAt(2.5, 1000), cps: 0.5, playing: true });
  const stopped = axis.at(2000, { music: null, cps: 0.5, playing: false });
  assert.equal(stopped.source, 'free');
  const warming = axis.at(2500, { music: null, cps: 0.5, playing: true });
  assert.equal(warming.source, 'free');
  assert.ok(warming.now > stopped.now);
  near(warming.now, stopped.now + 0.25);
});

test('clock jitter below half a cycle keeps the offset', () => {
  const axis = createCycleAxis();
  const first = axis.at(1000, { music: linesAt(5.2, 1000), cps: 0.5, playing: true });
  const jittered = axis.at(1000, { music: linesAt(5.199, 1000), cps: 0.5, playing: true });
  assert.equal(jittered.source, 'music');
  near(jittered.now, first.now - 0.001);
  assert.equal(jittered.anchors.a.c, first.anchors.a.c);
});

test('an unseen restart of the scheduler moves the axis forward by whole cycles', () => {
  const axis = createCycleAxis();
  near(axis.at(1000, { music: linesAt(10.2, 1000), cps: 0.5, playing: true }).now, 10.2);
  const restarted = axis.at(1000, { music: linesAt(0.3, 1000), cps: 0.5, playing: true });
  near(restarted.now, 10.3);
  assert.equal(Number.isInteger(restarted.anchors.a.c), true);
});

test('a tempo change while stopped starts a new line from where the axis was', () => {
  const axis = createCycleAxis();
  axis.at(1000, { music: null, cps: 0.5, playing: false });
  const changed = axis.at(3000, { music: null, cps: 1, playing: false });
  near(changed.now, 1);
  assert.deepEqual(changed.anchors, { a: { c: 1, t: 3000 }, b: { c: 2, t: 4000 } });
  near(axis.at(3500, { music: null, cps: 1, playing: false }).now, 1.5);
});

test('no lines and no usable tempo give null and leave the axis as it was', () => {
  for (const cps of [0, -1, NaN, Infinity, undefined]) {
    const empty = createCycleAxis();
    assert.equal(empty.at(1000, { music: null, cps, playing: false }), null, `cps ${String(cps)}`);
    const axis = createCycleAxis();
    axis.at(1000, { music: null, cps: 0.5, playing: false });
    assert.equal(axis.at(2000, { music: null, cps, playing: false }), null, `cps ${String(cps)} after a read`);
    near(axis.at(3000, { music: null, cps: 0.5, playing: false }).now, 1);
  }
});

test('lines that are not a line are not used', () => {
  const axis = createCycleAxis();
  const bad = [
    { a: { c: 1, t: 1000 }, b: { c: 2, t: 1000 } },
    { a: { c: NaN, t: 1000 }, b: { c: 2, t: 2000 } },
    { a: { c: 1, t: 1000 }, b: { c: 2, t: Infinity } },
    { a: { c: 1, t: 1000 } },
    'lines',
  ];
  for (const music of bad) assert.equal(axis.at(1000, { music, cps: 0, playing: false }), null);
});

test('a read without a finite moment throws', () => {
  assert.throws(() => createCycleAxis().at(NaN, { music: null, cps: 1, playing: false }), /Moontide/);
});

test('60 reads that mix Play, Stop, gaps, restarts and tempo changes never go back', () => {
  const axis = createCycleAxis();
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let h = 1000;
  let scheduler = 0;
  let playing = false;
  let cps = 0.5;
  let previous = -Infinity;
  for (let index = 0; index < 60; index += 1) {
    const elapsed = 50 + Math.floor(random() * 700);
    h += elapsed;
    const roll = random();
    if (roll < 0.15) {
      playing = !playing;
      if (playing) scheduler = 0;
    } else if (roll < 0.25 && playing) {
      scheduler = random() * 0.3;
    } else if (roll < 0.35) {
      cps = [0.5, 1, 2][Math.floor(random() * 3)];
    }
    if (playing) scheduler += (elapsed * cps) / 1000;
    const gap = playing && random() < 0.2;
    const music = playing && !gap ? linesAt(scheduler, h, cps) : null;
    const got = axis.at(h, { music, cps, playing });
    assert.notEqual(got, null);
    assert.ok(got.now >= previous - 1e-9, `read ${index} went back from ${previous} to ${got.now}`);
    previous = got.now;
  }
});

test('the anchors always make a line for cycleAtStamp, with whole cycles while the music plays', () => {
  const axis = createCycleAxis();
  const reads = [
    [1000, { music: null, cps: 0.5, playing: false }],
    [4000, { music: linesAt(0.1, 4000), cps: 0.5, playing: true }],
    [4400, { music: null, cps: 0.5, playing: true }],
    [6100, { music: null, cps: 0.5, playing: false }],
    [6300, { music: null, cps: 2, playing: false }],
  ];
  for (const [h, args] of reads) {
    const got = axis.at(h, args);
    assert.ok(Number.isFinite(got.anchors.a.t) && Number.isFinite(got.anchors.b.t) && got.anchors.a.t !== got.anchors.b.t);
    near(cycleAtStamp(h, got.anchors.a, got.anchors.b), got.now);
    if (got.source === 'music') assert.equal(Number.isInteger(got.anchors.a.c), true);
  }
});

test('two notes one cycle of the tempo apart land one cycle apart when the music is stopped', () => {
  const axis = createCycleAxis();
  const got = axis.at(5000, { music: null, cps: 1, playing: false });
  const first = cycleAtStamp(4200, got.anchors.a, got.anchors.b);
  const second = cycleAtStamp(5200, got.anchors.a, got.anchors.b);
  near(second - first, 1);
});

test('a note keeps the run it was placed in, null or a whole number, and snapshot hands it on', () => {
  const buffer = createPlayedBuffer();
  buffer.noteOn(10.25, 60, 100, 4);
  buffer.noteOn(10.5, 62, 90, null);
  buffer.noteOn(10.75, 64, 80);
  assert.deepEqual(buffer.notes().map((note) => note.run), [4, null, null]);
  assert.deepEqual(buffer.snapshot(11).notes.map((note) => note.run), [4, null, null]);
  assert.deepEqual(Object.keys(buffer.snapshot(11).notes[0]), ['pitch', 'velocity', 'start', 'end', 'run', 'held']);
});

test('a run that is neither null nor a whole number throws and keeps nothing', () => {
  const buffer = createPlayedBuffer();
  for (const run of [1.5, -0.5, NaN, Infinity, '3', {}, true]) {
    assert.throws(() => buffer.noteOn(5, 60, 100, run), /Moontide/, String(run));
  }
  assert.equal(buffer.count(), 0);
  buffer.noteOn(5, 60, 100, 0);
  assert.equal(buffer.notes()[0].run, 0);
});

test('the axis answer gives the offset in music mode and null in free mode', () => {
  const axis = createCycleAxis();
  const free = axis.at(1000, { music: null, cps: 0.5, playing: false });
  assert.equal(free.offset, null);
  const first = createCycleAxis().at(1500, { music: { a: { c: 3, t: 1000 }, b: { c: 4, t: 3000 } }, cps: 0.5, playing: true });
  assert.equal(first.offset, 0);
  // A Play after the tempo axis: the same offset the anchors already use.
  const played = axis.at(4000, { music: { a: { c: 0, t: 3800 }, b: { c: 1, t: 5800 } }, cps: 0.5, playing: true });
  assert.equal(played.offset, 2);
  assert.equal(played.anchors.a.c, 2);
  // While the music plays and the lines are briefly missing, the offset stays.
  assert.equal(axis.at(4500, { music: null, cps: 0.5, playing: true }).offset, 2);
});

test('the offset grows by whole cycles when the scheduler restarted unseen', () => {
  const axis = createCycleAxis();
  assert.equal(axis.at(1500, { music: { a: { c: 10, t: 1000 }, b: { c: 11, t: 3000 } }, cps: 0.5, playing: true }).offset, 0);
  const restarted = axis.at(5000, { music: { a: { c: 0, t: 4000 }, b: { c: 1, t: 6000 } }, cps: 0.5, playing: true });
  assert.ok(Number.isInteger(restarted.offset) && restarted.offset >= 10);
});
