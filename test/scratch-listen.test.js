import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LISTEN_PASS_MS,
  LISTEN_AHEAD_MS,
  LISTEN_LEAD_MS,
  LISTEN_LINE_MARGIN_MS,
  LISTEN_OFF_EARLY_MS,
  LISTEN_QUEUED_OFF_AFTER_MS,
  createScratchListen,
} from '../page/scratch-listen.js';
import { QUEUED_NOTE_OFF_AFTER_MS, NOTE_AHEAD_MS, NOTE_STAMP_MAX_AHEAD_MS } from '../page/midi-out.js';

// The Listen player, driven only by fakes: a clock that moves when a test says so, a timer that runs when the clock reaches it, and an emit that
// records what it is handed. No real timer, no MIDI. Names are neutral.

const MS_PER_UNIT_AT_HALF = 1000 / (0.5 * 48);

/** A motif of whole units: `[pitch, start, length, velocity]` for each note, two cycles on the sixteenths unless `cycles` says otherwise. */
function motifOf(notes, cycles = 2) {
  return Object.freeze({
    cycles,
    grid: 'sixteenth',
    notes: Object.freeze(notes.map(([pitch, start, length, velocity = 80], index) => Object.freeze({ id: index + 1, pitch, start, length, velocity }))),
    nextId: notes.length + 1,
  });
}

function rig({ now = 1000, cps = 0.5, motif = motifOf([[60, 0, 12]]), music = null, stamps = null } = {}) {
  const clock = { now };
  const timers = new Map();
  let handle = 0;
  const calls = [];
  const states = [];
  const state = { cps, motif, refuse: null, music };
  const player = createScratchListen({
    perfNow: () => clock.now,
    setTimer: (fn, ms) => {
      handle += 1;
      timers.set(handle, { fn, at: clock.now + ms });
      return handle;
    },
    clearTimer: (id) => timers.delete(id),
    emit: (note) => {
      calls.push({ ...note, sentAt: clock.now });
      if (state.refuse !== null && state.refuse.after <= calls.length - 1) return { refused: state.refuse.word, ...(state.refuse.details ?? {}) };
      return { ok: true };
    },
    stampOfCycle: (cycle) => (stamps === null ? null : stamps(cycle)),
    musicCycle: () => (state.music === null ? null : typeof state.music === 'function' ? state.music() : state.music),
    readCps: () => state.cps,
    onState: (next) => states.push(next),
  });
  // Moves the fake clock to `to` and runs every timer that falls due on the way, in order.
  const advance = (to) => {
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      clock.now = Math.max(clock.now, due[1].at);
      due[1].fn();
    }
    clock.now = to;
  };
  const start = (extra = {}) => player.play({ readMotif: () => state.motif, instrumentId: 'sc55', channel: 3, start: 'now', loop: false, ...extra });
  return { player, clock, timers, calls, states, state, advance, start };
}

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} is not ${expected}`);
const kinds = (calls) => calls.map((call) => `${call.kind}${call.pitch}`);

test('the look-ahead numbers are the plan\'s, above the page\'s measured margin and far below its fault limit', () => {
  assert.deepEqual([LISTEN_PASS_MS, LISTEN_AHEAD_MS, LISTEN_LEAD_MS, LISTEN_LINE_MARGIN_MS, LISTEN_OFF_EARLY_MS, LISTEN_QUEUED_OFF_AFTER_MS], [25, 150, 100, 60, 10, 1]);
  assert.ok(LISTEN_AHEAD_MS > NOTE_AHEAD_MS, 'a note is handed over earlier than the page\'s own margin for a stamped note');
  assert.ok(LISTEN_AHEAD_MS + LISTEN_PASS_MS < NOTE_STAMP_MAX_AHEAD_MS, 'and far below the limit past which the page treats a stamp as a fault');
});

test('the 1 ms after a stamp that Stop uses equals the music path\'s own constant', () => {
  assert.equal(LISTEN_QUEUED_OFF_AFTER_MS, QUEUED_NOTE_OFF_AFTER_MS);
});

test('the player needs each of its functions and says which is missing', () => {
  const good = { perfNow: () => 0, setTimer: () => 1, clearTimer: () => {}, emit: () => ({ ok: true }), stampOfCycle: () => 0, musicCycle: () => 0, readCps: () => 1, onState: () => {} };
  assert.doesNotThrow(() => createScratchListen(good));
  for (const name of Object.keys(good)) {
    // Only onState has a default (it tells nobody); every other function must be given.
    if (name !== 'onState') assert.throws(() => createScratchListen({ ...good, [name]: undefined }), (err) => err instanceof TypeError && err.message.includes(name), name);
    assert.throws(() => createScratchListen({ ...good, [name]: 'x' }), TypeError, name);
  }
});

test('started at once at 1000 with 0.5 cycles a second, the first note-on is handed over at 1100 and nothing else yet', () => {
  const r = rig();
  assert.equal(r.start(), true);
  assert.equal(r.calls.length, 1);
  assert.deepEqual({ ...r.calls[0], sentAt: undefined }, { instrumentId: 'sc55', channel: 3, kind: 'on', pitch: 60, velocity: 102, at: r.calls[0].at, sentAt: undefined });
  near(r.calls[0].at, 1000 + LISTEN_LEAD_MS);
  assert.deepEqual(r.states.at(-1), { kind: 'playing', instrumentId: 'sc55', channel: 3, loop: false });
  assert.equal(r.timers.size, 1, 'the pass reschedules itself');
});

test('a pass every 25 ms hands over only the notes due within 150 ms, and ends a note 10 ms before its written end', () => {
  const r = rig({ motif: motifOf([[60, 0, 3], [64, 4, 3], [67, 12, 3]]) });
  r.start();
  const on = (unit) => 1100 + unit * MS_PER_UNIT_AT_HALF;
  assert.deepEqual(kinds(r.calls), ['on60']);
  r.advance(1050);
  assert.deepEqual(kinds(r.calls), ['on60'], 'the off of the first note is at 1215: not yet within 150 ms of 1050');
  r.advance(1075);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60'], 'at 1075 the horizon is 1225');
  near(r.calls[1].at, on(3) - LISTEN_OFF_EARLY_MS);
  r.advance(1100);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60'], 'the next on is at 1266.7: beyond the horizon of 1250');
  r.advance(1125);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60', 'on64']);
  near(r.calls[2].at, on(4));
  for (const call of r.calls) assert.ok(call.at - call.sentAt <= LISTEN_AHEAD_MS + 1e-6, `${call.kind}${call.pitch} was handed over ${call.at - call.sentAt} ms ahead`);
  r.advance(1800);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60', 'on64', 'off64', 'on67', 'off67']);
  for (const call of r.calls) assert.ok(call.at - call.sentAt <= LISTEN_AHEAD_MS + 1e-6, `${call.kind}${call.pitch}`);
});

test('a note whose written length is shorter than the early end still lasts 1 ms', () => {
  const r = rig({ cps: 4, motif: motifOf([[60, 0, 1]]) });
  r.start();
  r.advance(1300);
  const [on, off] = r.calls;
  assert.equal(on.kind, 'on');
  assert.equal(off.kind, 'off');
  near(off.at - on.at, 1, 'a unit at 4 cycles a second is 5.2 ms: its early end would come before it began');
});

test('the velocity bytes and the pitches handed over are the motif\'s', () => {
  const r = rig({ motif: motifOf([[60, 0, 3, 80], [64, 3, 3, 100], [67, 6, 3, 1]]) });
  r.start();
  r.advance(2000);
  assert.deepEqual(r.calls.filter((call) => call.kind === 'on').map((call) => [call.pitch, call.velocity]), [[60, 102], [64, 127], [67, 1]]);
  assert.deepEqual(r.calls.filter((call) => call.kind === 'off').map((call) => call.velocity), [0, 0, 0]);
  assert.ok(r.calls.every((call) => call.instrumentId === 'sc55' && call.channel === 3));
});

test('two notes of one pitch back to back both sound: the first ends before the second begins', () => {
  const r = rig({ motif: motifOf([[60, 0, 3], [60, 3, 3]]) });
  r.start();
  r.advance(1500);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60', 'on60', 'off60']);
  assert.ok(r.calls[1].at < r.calls[2].at);
});

test('Stop sends an off now for a note that sounds and an off 1 ms after the stamp of a note handed over for later, and cancels the timer', () => {
  const r = rig({ motif: motifOf([[60, 0, 12], [64, 6, 3]]) });
  r.start();
  r.advance(1250);
  assert.deepEqual(kinds(r.calls), ['on60', 'on64'], 'the first sounds since 1100 and the second is stamped for 1350');
  const markCalls = r.calls.length;
  r.player.stop();
  const silence = r.calls.slice(markCalls);
  assert.deepEqual(kinds(silence), ['off60', 'off64']);
  assert.equal(silence[0].at, undefined, 'a note that sounds is ended now');
  near(silence[1].at, r.calls[1].at + LISTEN_QUEUED_OFF_AFTER_MS);
  assert.ok(silence.every((call) => call.velocity === 0 && call.instrumentId === 'sc55' && call.channel === 3));
  assert.equal(r.timers.size, 0, 'no pass is left to run');
  assert.deepEqual(r.states.at(-1), { kind: 'stopped', reason: 'stop', instrumentId: 'sc55', channel: 3 });
  assert.equal(r.player.position(), null);
});

test('Stop sends nothing for a note whose off has gone, and a Stop with nothing playing does nothing', () => {
  const r = rig({ motif: motifOf([[60, 0, 3], [64, 24, 3]]) });
  r.player.stop();
  assert.deepEqual([r.calls.length, r.states.length], [0, 0]);
  r.start();
  r.advance(1300);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60']);
  r.player.stop();
  assert.deepEqual(kinds(r.calls), ['on60', 'off60'], 'the off at 1215 has gone and the next note was never handed over: nothing is left to end');
  assert.equal(r.states.at(-1).kind, 'stopped');
});

test('Stop uses targeted note-offs only, never anything else', () => {
  const r = rig({ motif: motifOf([[60, 0, 12], [64, 0, 12], [67, 0, 12]]) });
  r.start();
  r.advance(1200);
  r.player.stop();
  assert.ok(r.calls.every((call) => (call.kind === 'on' || call.kind === 'off') && Number.isInteger(call.pitch)));
  assert.deepEqual(r.calls.filter((call) => call.kind === 'off').map((call) => call.pitch).sort(), [60, 64, 67]);
});

test('without Loop the play ends after its last note-off and says so, with no pass left', () => {
  const r = rig({ motif: motifOf([[60, 0, 3]]) });
  r.start();
  r.advance(1150);
  assert.deepEqual(r.states.at(-1).kind, 'playing');
  r.advance(1500);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60']);
  assert.deepEqual(r.states.at(-1), { kind: 'ended', instrumentId: 'sc55', channel: 3 });
  assert.equal(r.timers.size, 0);
  assert.equal(r.player.position(), null);
});

test('position is null during the lead, then the unit in the motif, and null again once the play has ended', () => {
  const r = rig({ motif: motifOf([[60, 0, 60]]) });
  assert.equal(r.player.position(), null);
  r.start();
  r.advance(1050);
  assert.equal(r.player.position(), null, 'the motif has not begun yet');
  r.advance(1100 + 10 * MS_PER_UNIT_AT_HALF);
  near(r.player.position(), 10);
  r.player.stop();
  assert.equal(r.player.position(), null);
});

test('an empty motif starts nothing and says so', () => {
  const r = rig({ motif: motifOf([]) });
  assert.equal(r.start(), false);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'empty', instrumentId: 'sc55', channel: 3, mid: false });
  assert.deepEqual([r.calls.length, r.timers.size], [0, 0]);
});

test('a tempo that is not above 0 starts nothing and says so', () => {
  for (const cps of [0, -1, Number.NaN, null]) {
    const r = rig({ cps });
    assert.equal(r.start(), false);
    assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'tempo', instrumentId: 'sc55', channel: 3, mid: false });
    assert.equal(r.calls.length, 0);
  }
});

test('a refusal of the output at the first note ends the play with that refusal and its details', () => {
  const r = rig();
  r.state.refuse = { after: 0, word: 'no-output', details: { port: 'Port A', names: ['Port B'] } };
  assert.equal(r.start(), false);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'no-output', port: 'Port A', names: ['Port B'], instrumentId: 'sc55', channel: 3, mid: false });
  assert.equal(r.timers.size, 0);
});

test('an output that goes away during a play silences what it can, stops the play and says it had begun', () => {
  const r = rig({ motif: motifOf([[60, 0, 12], [64, 12, 3]]) });
  r.start();
  r.state.refuse = { after: 1, word: 'no-output', details: { port: 'Port A', names: [] } };
  r.advance(1500);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'no-output', port: 'Port A', names: [], instrumentId: 'sc55', channel: 3, mid: true });
  assert.equal(r.timers.size, 0);
  assert.deepEqual([r.calls.at(-1).kind, r.calls.at(-1).pitch, r.calls.at(-1).at], ['off', 60, undefined], 'an end was tried at once for the note that sounded');
});

test('a second play while one is playing ends the first silently and starts the second', () => {
  const r = rig({ motif: motifOf([[60, 0, 12]]) });
  r.start();
  r.advance(1200);
  const statesBefore = r.states.length;
  r.start({ instrumentId: 'jx', channel: 5 });
  assert.deepEqual(kinds(r.calls).slice(0, 3), ['on60', 'off60', 'on60']);
  assert.equal(r.calls[1].instrumentId, 'sc55');
  assert.equal(r.calls[2].instrumentId, 'jx');
  assert.ok(r.states.slice(statesBefore).every((state) => state.kind !== 'stopped'), 'the first play is not reported as stopped');
  assert.equal(r.timers.size, 1, 'one pass only');
});

test('with Loop on, the next pass starts where the last ended and the motif is read again at each lap start', () => {
  const r = rig({ motif: motifOf([[60, 0, 12]], 1) });
  let reads = 0;
  r.start({ loop: true, readMotif: () => {
    reads += 1;
    return reads === 1 ? motifOf([[60, 0, 12]], 1) : motifOf([[72, 0, 12]], 1);
  } });
  r.advance(6000);
  const ons = r.calls.filter((call) => call.kind === 'on');
  assert.deepEqual(ons.slice(0, 3).map((call) => call.pitch), [60, 72, 72], 'an edit is heard from the next pass');
  near(ons[1].at - ons[0].at, 48 * MS_PER_UNIT_AT_HALF, 'a lap is the motif\'s cycles');
  near(ons[2].at - ons[1].at, 48 * MS_PER_UNIT_AT_HALF);
  assert.equal(r.states.at(-1).kind, 'playing');
  assert.equal(r.states.at(-1).loop, true);
});

test('Loop turned off during a play ends it after the current pass, and turned on again before the end keeps it going', () => {
  const r = rig({ motif: motifOf([[60, 0, 12]], 1) });
  r.start({ loop: true });
  r.advance(1200);
  r.player.setLoop(false);
  assert.equal(r.states.at(-1).loop, false);
  r.advance(6000);
  assert.equal(r.calls.filter((call) => call.kind === 'on').length, 1, 'the pass that was playing plays out and no other follows');
  assert.equal(r.states.at(-1).kind, 'ended');
  const again = rig({ motif: motifOf([[60, 0, 12]], 1) });
  again.start({ loop: false });
  again.advance(1500);
  again.player.setLoop(true);
  again.advance(5000);
  assert.ok(again.calls.filter((call) => call.kind === 'on').length >= 2, 'turned on while the last notes of the pass are still sounding, it goes on');
  again.player.stop();
});

test('a motif emptied during a loop ends the play with the nothing-to-listen sentence', () => {
  const r = rig({ motif: motifOf([[60, 0, 12]], 1) });
  r.start({ loop: true });
  r.state.motif = motifOf([], 1);
  r.advance(3000);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'empty', instrumentId: 'sc55', channel: 3, mid: true });
  assert.equal(r.timers.size, 0);
});

test('a tempo that goes to 0 during a loop ends the play with that refusal', () => {
  const r = rig({ motif: motifOf([[60, 0, 12]], 1) });
  r.start({ loop: true });
  r.state.cps = 0;
  r.advance(3000);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'tempo', instrumentId: 'sc55', channel: 3, mid: true });
});

test('setLoop with nothing playing does nothing', () => {
  const r = rig();
  r.player.setLoop(true);
  assert.deepEqual([r.states.length, r.timers.size], [0, 0]);
});

test('the start must be at once or in the music, and a play without a readMotif function throws', () => {
  const r = rig();
  assert.throws(() => r.player.play({ readMotif: () => r.state.motif, instrumentId: 'sc55', channel: 3, start: 'later', loop: false }), /start/);
  assert.throws(() => r.player.play({ instrumentId: 'sc55', channel: 3, start: 'now', loop: false }), TypeError);
});

// --- In the music: the motif starts on a cycle line of the music ---

// The music at one cycle a second with cycle 13 stamped at 6000 ms; the clock is at 5400, so the music is at cycle 12.4.
function musicRig({ at = 5400, cycleAt = 12.4, motif = motifOf([[60, 0, 12], [64, 12, 12]], 1), stamps = (cycle) => 6000 + (cycle - 13) * 1000 } = {}) {
  const r = rig({ now: at, motif, stamps: (cycle) => (r.state.stamps === null ? null : r.state.stamps(cycle)) });
  r.state.stamps = stamps;
  r.state.music = () => (r.state.musicOff === true ? null : cycleAt + (r.clock.now - at) / 1000);
  r.state.stampCalls = 0;
  const base = r.state.stamps;
  r.state.stamps = (cycle) => {
    r.state.stampCalls += 1;
    return base(cycle);
  };
  r.startMusic = (extra = {}) => r.start({ start: 'music', ...extra });
  return r;
}

test('In the music at cycle 12.4 waits for cycle 13, says so, and plays the motif from the stamp of that line', () => {
  const r = musicRig();
  assert.equal(r.startMusic(), true);
  assert.deepEqual(r.states.at(-1), { kind: 'waiting', cycle: 13, instrumentId: 'sc55', channel: 3 });
  assert.equal(r.calls.length, 0, 'the line is 600 ms away');
  r.advance(5800);
  assert.equal(r.calls.length, 0, 'the first note is stamped for 6000: 200 ms away at 5800');
  r.advance(5850);
  assert.deepEqual(kinds(r.calls), ['on60'], 'it goes out 150 ms ahead');
  assert.equal(r.calls[0].at, 6000, 'at the stamp of the line');
  assert.equal(r.states.at(-1).kind, 'waiting', 'it has not begun yet');
  r.advance(6010);
  assert.deepEqual(r.states.at(-1), { kind: 'playing', instrumentId: 'sc55', channel: 3, loop: false });
  r.advance(7000);
  assert.deepEqual(kinds(r.calls), ['on60', 'off60', 'on64', 'off64']);
  assert.equal(r.calls[2].at, 6000 + 250, 'a note 12 units in is a quarter of a cycle after the line');
  assert.equal(r.calls[1].at, 6000 + 250 - LISTEN_OFF_EARLY_MS);
});

test('a cycle line less than 60 ms away is too near to catch: the next one is taken, and exactly 60 ms is enough', () => {
  const near59 = musicRig({ at: 5941, cycleAt: 12.941 });
  near59.startMusic();
  assert.equal(near59.states.at(-1).cycle, 14);
  const exactly60 = musicRig({ at: 5940, cycleAt: 12.94 });
  exactly60.startMusic();
  assert.equal(exactly60.states.at(-1).cycle, 13);
  const onTheLine = musicRig({ at: 6000, cycleAt: 13 });
  onTheLine.startMusic();
  assert.equal(onTheLine.states.at(-1).cycle, 14, 'at cycle 13 exactly the next line is 14');
});

test('In the music with the music stopped starts nothing and says there is no cycle line to wait for', () => {
  const r = musicRig();
  r.state.musicOff = true;
  assert.equal(r.startMusic(), false);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'music-not-playing', instrumentId: 'sc55', channel: 3, mid: false });
  assert.deepEqual([r.calls.length, r.timers.size], [0, 0]);
});

test('a clock that gives no time for the next line starts nothing, and says so, at the first or at the line after', () => {
  const none = musicRig({ stamps: () => null });
  assert.equal(none.startMusic(), false);
  assert.deepEqual(none.states.at(-1), { kind: 'refused', refused: 'no-clock', instrumentId: 'sc55', channel: 3, mid: false });
  const second = musicRig({ at: 5970, cycleAt: 12.97, stamps: (cycle) => (cycle === 13 ? 6000 : null) });
  assert.equal(second.startMusic(), false);
  assert.equal(second.states.at(-1).refused, 'no-clock');
});

test('the music stopping ends an In the music play, while it waits and while it plays, and silences what sounds', () => {
  const waiting = musicRig();
  waiting.startMusic();
  waiting.state.musicOff = true;
  waiting.advance(5450);
  assert.deepEqual(waiting.states.at(-1), { kind: 'stopped', reason: 'music-stopped', instrumentId: 'sc55', channel: 3 });
  assert.equal(waiting.timers.size, 0);
  const playing = musicRig();
  playing.startMusic();
  playing.advance(6100);
  playing.state.musicOff = true;
  playing.advance(6150);
  assert.equal(playing.states.at(-1).reason, 'music-stopped');
  assert.deepEqual(kinds(playing.calls), ['on60', 'off60', 'on64', 'off60', 'off64'], 'the note that sounds is ended at once and the one stamped for later just after its stamp');
  assert.deepEqual(playing.calls.slice(-2).map((call) => call.at), [undefined, 6251]);
});

test('the music stopping does not end an At once play', () => {
  const r = rig({ motif: motifOf([[60, 0, 60]]) });
  r.state.music = null;
  r.start();
  r.advance(1500);
  assert.equal(r.states.at(-1).kind, 'playing');
});

test('a stamp that goes missing while the music plays ends the play with the clock sentence, and says it had begun', () => {
  const r = musicRig();
  r.startMusic({ loop: true });
  r.advance(6100);
  r.state.noStamps = true;
  const base = r.state.stamps;
  r.state.stamps = (cycle) => (r.state.noStamps ? null : base(cycle));
  r.advance(6900);
  assert.deepEqual(r.states.at(-1), { kind: 'refused', refused: 'no-clock', instrumentId: 'sc55', channel: 3, mid: true });
});

test('with Loop on the laps start on the lines of the music, a motif read again at each lap sets the next line, and an edit is heard at the next pass', () => {
  const r = musicRig();
  const motifs = [motifOf([[60, 0, 12]], 1), motifOf([[72, 0, 12]], 2), motifOf([[74, 0, 12]], 1)];
  let reads = 0;
  r.startMusic({ loop: true, readMotif: () => motifs[Math.min(reads++, motifs.length - 1)] });
  r.advance(9500);
  const ons = r.calls.filter((call) => call.kind === 'on');
  assert.deepEqual(ons.slice(0, 3).map((call) => [call.pitch, call.at]), [[60, 6000], [72, 7000], [74, 9000]], 'lap 2 is two cycles long, so lap 3 starts two lines after it');
  r.player.stop();
});

test('without Loop an In the music play ends after its last note-off and says so', () => {
  const r = musicRig();
  r.startMusic();
  r.advance(7500);
  assert.deepEqual(r.states.at(-1), { kind: 'ended', instrumentId: 'sc55', channel: 3 });
  assert.equal(r.timers.size, 0);
});

test('the position of an In the music play is the music\'s cycle minus the line, in units, null before the line, and follows the laps', () => {
  const r = musicRig();
  r.startMusic({ loop: true });
  assert.equal(r.player.position(), null, 'waiting');
  r.advance(5990);
  assert.equal(r.player.position(), null, 'the line is not reached');
  r.advance(6250);
  near(r.player.position(), 12);
  r.advance(7125);
  near(r.player.position(), 6, 'the second lap starts on line 14');
  r.state.musicOff = true;
  assert.equal(r.player.position(), null);
  r.player.stop();
});

test('Loop switched while the play waits changes what happens later and reports nothing', () => {
  const r = musicRig();
  r.startMusic();
  const told = r.states.length;
  r.player.setLoop(true);
  assert.equal(r.states.length, told);
  r.advance(8300);
  assert.ok(r.calls.filter((call) => call.kind === 'on').length >= 4, 'it loops');
  r.player.stop();
});

test('each stop reason silences what sounds and is reported with its word', () => {
  for (const reason of ['hidden', 'closed', 'page']) {
    const r = musicRig();
    r.startMusic();
    r.advance(6100);
    r.player.stop(reason);
    assert.deepEqual(r.states.at(-1), { kind: 'stopped', reason, instrumentId: 'sc55', channel: 3 });
    assert.deepEqual(kinds(r.calls).slice(-2), ['off60', 'off64']);
    assert.equal(r.timers.size, 0);
  }
});

test('the page clock is asked for the next note only, not for a long motif all at once', () => {
  const notes = Array.from({ length: 200 }, (_, index) => [60 + (index % 12), index * 2, 1]);
  const r = musicRig({ motif: motifOf(notes, 8) });
  r.startMusic();
  assert.ok(r.state.stampCalls <= 4, `${r.state.stampCalls} stamp reads for the start of a 200 note motif`);
  r.advance(5800);
  assert.ok(r.state.stampCalls <= 4 + 16, `${r.state.stampCalls} stamp reads after eight passes`);
  r.player.stop();
});
