import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { PREVIEW_MIN_GAP_MS, STOP_WINDOW_AFTER_S, STOP_WINDOW_BEFORE_S, controlsText, createPreviewSender, midiStops, midiTag, notesToStop, readMidiSlots, readMidiTracks, sweepKey, writeMidiControl } from '../page/midi-controls.js';
import { readMidiSetup } from '../page/midi-plan.js';
import { rigFromReadFailure, withBuildMismatch } from '../page/midi-rig.js';
import { MixerRewriteError } from '../page/mixer-rewrite.js';

// Reading the MIDI tracks of a piece of code and writing a control into the .midi() options. All data is
// neutral and made up (Port A, Alpha 1): no real session code is ever copied into a test.

// The controls of the shipped MT-32 model, copied so a test never reads a file.
const CONTROLS = [
  { id: 'modulation', name: 'Modulation', cc: 1, min: 0, max: 127, default: 0 },
  { id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 },
  { id: 'pan', name: 'Pan', cc: 10, min: 0, max: 127, default: 64 },
  { id: 'expression', name: 'Expression', cc: 11, min: 0, max: 127, default: 127 },
  { id: 'hold', name: 'Hold', cc: 64, min: 0, max: 127, default: 0 },
];

const INSTRUMENT = {
  id: 'mt32',
  model: 'mt32',
  modelName: 'Model mt32',
  port: 'Port A',
  channels: Array.from({ length: 9 }, (_, index) => ({ channel: index + 2, role: index === 8 ? 'rhythm' : 'melodic' })),
  bankSelect: 'none',
  defaultVolume: 100,
  controls: CONTROLS,
  reset: null,
  sounds: { melodic: [{ name: 'Alpha 1', program: 0 }], rhythm: [] },
  catalogSounds: 0,
};
const RIG = { setup: 'valid', instruments: [INSTRUMENT] };

const PAD = `pad: note("c3 e3 g3 c4").midi('Port A', { midichannel: 3, controls: { volume: 90 } })`;

test('readMidiTracks reads the controls a track writes and the instrument of the rig', () => {
  const read = readMidiTracks(PAD, { parse, rig: RIG });
  assert.equal(read.ok, true);
  const track = read.tracks.get('label:pad');
  assert.equal(track.name, 'pad');
  assert.equal(track.kind, 'label');
  assert.equal(track.muted, false);
  assert.equal(track.reason, null);
  assert.equal(track.instrument, INSTRUMENT);
  assert.deepEqual([track.spine.port, track.spine.channel, track.spine.sound], ['Port A', 3, null]);
  assert.deepEqual([...track.spine.controls], [['volume', 90]]);
});

test('readMidiTracks says why a track has no model: noModel without a rig', () => {
  for (const rig of [undefined, { setup: 'absent' }]) {
    const read = readMidiTracks(PAD, rig === undefined ? { parse } : { parse, rig });
    assert.equal(read.tracks.get('label:pad').reason, 'noModel');
    assert.equal(read.tracks.get('label:pad').instrument, null);
  }
});

test('a track without a .midi call is not a MIDI track, and code that does not parse is not ok', () => {
  const read = readMidiTracks(`drums: s("bd*4")\n${PAD}`, { parse, rig: RIG });
  assert.deepEqual([...read.tracks.keys()], ['label:pad']);
  assert.deepEqual(readMidiTracks('pad: note("c3"', { parse, rig: RIG }), { ok: false });
});

// A one-line options object is the shape of the three first edits; the other shapes are for later.
const edit = (code, change) => writeMidiControl(code, { type: 'midi-control', identity: 'label:pad', port: 'Port A', channel: 3, control: 'volume', cc: 7, value: 80, ...change }, { parse });

/** The setup reading of the first call: port, channel and sound, which a write must never change. */
const setupOf = (code) => {
  const [call] = readMidiSetup(code, { parse }).calls;
  return { port: call.port, channel: call.channel, sound: call.sound, problems: call.problems };
};

test('a bare .midi call gets its whole options object with the control', () => {
  const code = `pad: note("c3").midi('Port A')`;
  const result = edit(code, { channel: 1 });
  assert.equal(result.code, `pad: note("c3").midi('Port A', { controls: { volume: 80 } })`);
  assert.deepEqual(setupOf(result.code), setupOf(code));
  assert.deepEqual([...readMidiTracks(result.code, { parse, rig: RIG }).tracks.get('label:pad').spine.controls], [['volume', 80]]);
});

test('one-line options without controls get one after their last property', () => {
  const code = `pad: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`;
  const result = edit(code, {});
  assert.equal(result.code, `pad: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1', controls: { volume: 80 } })`);
  assert.deepEqual(setupOf(result.code), setupOf(code));
});

test('a one-line controls object gets its number changed in place, or one more control after the last', () => {
  const changed = edit(PAD, {});
  assert.equal(changed.code, PAD.replace('volume: 90', 'volume: 80'));
  const added = edit(PAD, { control: 'pan', cc: 10, value: 30 });
  assert.equal(added.code, PAD.replace('volume: 90 }', 'volume: 90, pan: 30 }'));
  assert.deepEqual(setupOf(added.code), setupOf(PAD));
  const tracks = readMidiTracks(added.code, { parse, rig: RIG }).tracks;
  assert.deepEqual([...tracks.get('label:pad').spine.controls], [['volume', 90], ['pan', 30]]);
});

test('asking for the value the code already holds returns the identical code and no edits', () => {
  const result = edit(PAD, { value: 90 });
  assert.equal(result.code, PAD);
  assert.deepEqual(result.edits, []);
});

test('writing never touches .gain() or velocity of the track', () => {
  const code = `pad: note("c3").gain(0.5).velocity(0.7).midi('Port A', { midichannel: 3 }).gain(0.4)`;
  const result = edit(code, {});
  assert.equal(result.code, `pad: note("c3").gain(0.5).velocity(0.7).midi('Port A', { midichannel: 3, controls: { volume: 80 } }).gain(0.4)`);
});

test('a write for a port and channel no track plays is refused as track-gone, with a Moontide message', () => {
  for (const change of [{ port: 'Port B' }, { channel: 4 }]) {
    assert.throws(
      () => edit(PAD, change),
      (error) => error instanceof MixerRewriteError && error.reason === 'track-gone' && error.message.startsWith('Moontide: '),
    );
  }
});

test('a value that is not a whole number from 0 to 127 is refused before any edit', () => {
  for (const value of [128, -1, 1.5, '90']) {
    assert.throws(
      () => edit(PAD, { value }),
      (error) => error instanceof MixerRewriteError && error.reason === 'unsupported-change' && error.message.startsWith('Moontide: '),
      String(value),
    );
  }
});

// --- The nine code shapes of the spike, in neutral made-up code, and three moves on each ---

const P = "'Port A'";

const ARRANGE = `setcps(0.5)
const LEN = 8

pad: arrange(
  [LEN, note("c3 e3 g3 c4").velocity(.5)],
  [LEN, note("a2 c3 e3 a3").velocity(.4)]
).midi(${P}, { midichannel: 2, sound: 'Alpha 1' })

bass: arrange(
  [LEN, note("c2 ~ c2 ~").velocity(.7)],
  [LEN, note("a1 ~ a1 ~").velocity(.7)]
).midi(${P}, { midichannel: 3, sound: 'Bell 2' })

drums: arrange(
  [LEN, stack(note("36 ~ ~ ~").velocity(.7), note("42*4").velocity(.4))]
).midi(${P}, { midichannel: 10 })
`;
const MULTILINE_COMMA = `pad: note("<c3 e3>")\n  .midi(${P}, {\n    midichannel: 2,\n    sound: 'Str Sect 1', // strings\n  })\n`;
const MULTILINE_NO_COMMA = `pad: note("<c3 e3>")\n  .midi(${P}, {\n    midichannel: 2,\n    sound: 'Str Sect 1' // strings\n  })\n`;
const KICK_HAT = `kick: note("36*4").midi(${P}, { midichannel: 10 })\nhat: note("42*8").midi(${P}, { midichannel: 10, controls: { volume: 60 } })\n`;

const SHAPES = [
  { id: 'arrange pad', code: ARRANGE, identity: 'label:pad', channel: 2 },
  { id: 'arrange drums', code: ARRANGE, identity: 'label:drums', channel: 10 },
  { id: 'bare', code: `lead: note("c3 e3 g3").midi(${P})\n`, identity: 'label:lead', channel: 1 },
  { id: 'midichan', code: `lead: note("c3 e3").midichan(3).midi(${P})\n`, identity: 'label:lead', channel: 3 },
  { id: 'multiline with comma', code: MULTILINE_COMMA, identity: 'label:pad', channel: 2 },
  { id: 'claude sweep', code: `lead: note("c4*4").ccv(sine.segment(4)).ccn(74).midi(${P}, { midichannel: 4 })\n`, identity: 'label:lead', channel: 4 },
  { id: 'shared channel', code: KICK_HAT, identity: 'label:kick', channel: 10 },
  { id: 'cc7 track', code: `swell: ccv(sine.slow(4).segment(32)).ccn(7).midi(${P}, { midichannel: 2 })\npad: note("c3").midi(${P}, { midichannel: 2 })\n`, identity: 'label:pad', channel: 2, swept: [7] },
];
const OPTIONS_VAR = `const opts = { midichannel: 2 }\npad: note("c3").midi(${P}, opts)\n`;

const MOVES = [
  { control: 'volume', cc: 7, value: 80 },
  { control: 'pan', cc: 10, value: 30 },
  { control: 'volume', cc: 7, value: 90 },
];

const move = (code, shape, step) => writeMidiControl(code, { type: 'midi-control', identity: shape.identity, port: 'Port A', channel: shape.channel, ...step }, { parse });

/** Every call's port, channel, sound and problems: what a write must never change. */
const readingOf = (code) => readMidiSetup(code, { parse }).calls.map((call) => ({ port: call.port, channel: call.channel, sound: call.sound, problems: call.problems }));

/** The tracks on the port and channel, with the controls each one writes. */
const controlsOnChannel = (code, channel) => {
  const read = readMidiTracks(code, { parse, rig: RIG });
  return Object.fromEntries([...read.tracks.values()].filter((track) => track.spine.port === 'Port A' && track.spine.channel === channel).map((track) => [track.identity, Object.fromEntries(track.spine.controls)]));
};

test('three moves on each of the shapes: every one is written, the reading never changes and the controls read back', () => {
  for (const shape of SHAPES) {
    let code = shape.code;
    const expected = controlsOnChannel(code, shape.channel);
    assert.ok(Object.keys(expected).length > 0, shape.id);
    for (const step of MOVES) {
      const before = code;
      // A control a sweep moves on the channel is not written: the mixer never fights Claude's ccn.
      if ((shape.swept ?? []).includes(step.cc)) {
        assert.throws(() => move(code, shape, step), (error) => error instanceof MixerRewriteError && error.reason === 'unsupported-change' && /sweep/.test(error.message), `${shape.id}: ${step.control}`);
        continue;
      }
      code = move(code, shape, step).code;
      assert.notEqual(code, before, `${shape.id}: ${step.control} ${step.value}`);
      assert.deepEqual(readingOf(code), readingOf(before), `${shape.id}: port, channel, sound and problems stay what they were`);
      for (const identity of Object.keys(expected)) expected[identity][step.control] = step.value;
      assert.deepEqual(controlsOnChannel(code, shape.channel), expected, `${shape.id}: ${step.control} ${step.value}`);
    }
  }
});

test('options in a variable are refused on every move', () => {
  for (const step of MOVES) {
    assert.throws(
      () => move(OPTIONS_VAR, { identity: 'label:pad', channel: 2 }, step),
      (error) => error instanceof MixerRewriteError && error.message.startsWith('Moontide: '),
    );
  }
});

test('a new property goes after the comma and the trailing comment of the last one, keeping the indentation', () => {
  const withComma = move(MULTILINE_COMMA, SHAPES[4], MOVES[0]).code;
  assert.equal(withComma, `pad: note("<c3 e3>")\n  .midi(${P}, {\n    midichannel: 2,\n    sound: 'Str Sect 1', // strings\n    controls: { volume: 80 },\n  })\n`);
  const noComma = move(MULTILINE_NO_COMMA, SHAPES[4], MOVES[0]).code;
  assert.equal(noComma, `pad: note("<c3 e3>")\n  .midi(${P}, {\n    midichannel: 2,\n    sound: 'Str Sect 1', // strings\n    controls: { volume: 80 }\n  })\n`, 'a comma comes right after the sound, and its comment stays on its line');
  for (const code of [withComma, noComma]) {
    assert.deepEqual(readingOf(code), readingOf(MULTILINE_COMMA));
    assert.deepEqual(controlsOnChannel(code, 2), { 'label:pad': { volume: 80 } });
  }
});

test('an empty controls object is a normal target, and a key that is not an identifier is quoted', () => {
  const empty = `pad: note("c3").midi(${P}, { midichannel: 3, controls: {} })`;
  assert.equal(edit(empty, {}).code, `pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 80 } })`);
  const options = `pad: note("c3").midi(${P}, {})`;
  assert.equal(edit(options, { channel: 1 }).code, `pad: note("c3").midi(${P}, { controls: { volume: 80 } })`, 'an empty options object takes the property between its braces');
  const dashed = edit(`pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 60 } })`, { control: 'reverb-send', cc: 91, value: 40 });
  assert.equal(dashed.code, `pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 60, 'reverb-send': 40 } })`);
  assert.deepEqual(Object.fromEntries(readMidiTracks(dashed.code, { parse, rig: RIG }).tracks.get('label:pad').spine.controls), { volume: 60, 'reverb-send': 40 });
});

test('adding then removing every control gives the original text back byte for byte', () => {
  for (const shape of [SHAPES[0], SHAPES[2], SHAPES[3], SHAPES[4], SHAPES[5]]) {
    let code = shape.code;
    code = move(code, shape, MOVES[0]).code;
    code = move(code, shape, MOVES[1]).code;
    code = move(code, shape, { control: 'pan', cc: 10, value: null }).code;
    code = move(code, shape, { control: 'volume', cc: 7, value: null }).code;
    assert.equal(code, shape.code, shape.id);
  }
});

test('without the comma before a comment, only the comma that was added stays after the controls are removed', () => {
  const shape = SHAPES[4];
  let code = MULTILINE_NO_COMMA;
  for (const step of [MOVES[0], MOVES[1], { control: 'pan', cc: 10, value: null }, { control: 'volume', cc: 7, value: null }]) code = move(code, shape, step).code;
  assert.equal(code, MULTILINE_NO_COMMA.replace("'Str Sect 1' // strings", "'Str Sect 1', // strings"));
});

test('taking out the last control takes out controls, and the last option takes out the options', () => {
  const both = `pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 90 } })`;
  assert.equal(edit(both, { value: null }).code, `pad: note("c3").midi(${P}, { midichannel: 3 })`);
  const only = `pad: note("c3").midi(${P}, { controls: { volume: 90 } })`;
  assert.equal(edit(only, { value: null, channel: 1 }).code, `pad: note("c3").midi(${P})`);
  const two = `pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 90, pan: 30 } })`;
  assert.equal(edit(two, { value: null }).code, `pad: note("c3").midi(${P}, { midichannel: 3, controls: { pan: 30 } })`);
  assert.equal(edit(two, { value: null, control: 'pan', cc: 10 }).code, `pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 90 } })`);
  assert.equal(edit(`pad: note("c3").midi(${P}, { midichannel: 3 })`, { value: null }).code, `pad: note("c3").midi(${P}, { midichannel: 3 })`, 'nothing to take out');
});

test('a gesture on a shared channel writes every track of it, muted ones included, in one edit list', () => {
  const written = move(KICK_HAT, SHAPES[6], { control: 'volume', cc: 7, value: 70 });
  assert.ok(written.edits.length >= 2);
  assert.deepEqual(controlsOnChannel(written.code, 10), { 'label:kick': { volume: 70 }, 'label:hat': { volume: 70 } });
  const muted = `kick: note("36*4").midi(${P}, { midichannel: 10 })\n_hat: note("42*8").midi(${P}, { midichannel: 10, controls: { volume: 60 } })\n`;
  const mutedWrite = move(muted, SHAPES[6], { control: 'volume', cc: 7, value: 70 });
  assert.deepEqual(controlsOnChannel(mutedWrite.code, 10), { 'label:kick': { volume: 70 }, 'label:hat': { volume: 70 } });
  assert.equal(readMidiTracks(mutedWrite.code, { parse, rig: RIG }).tracks.get('label:hat').muted, true);
});

test('gain and velocity stay byte for byte through a write and its removal', () => {
  const code = `pad: note("c3").gain(0.5).velocity(0.7).midi(${P}, { midichannel: 3 }).gain(0.4).velocity(0.9)`;
  const written = edit(code, {}).code;
  assert.ok(written.startsWith(`pad: note("c3").gain(0.5).velocity(0.7).midi(${P}, { midichannel: 3, controls: { volume: 80 } })`));
  assert.ok(written.endsWith('.gain(0.4).velocity(0.9)'));
  assert.equal(edit(written, { value: null }).code, code);
});

test('every shape the mixer cannot write is refused with a sentence', () => {
  const refuse = (code, change, reason = 'unsupported-change') =>
    assert.throws(
      () => edit(code, change),
      (error) => error instanceof MixerRewriteError && error.reason === reason && error.message.startsWith('Moontide: '),
      code,
    );
  refuse(`const c = { volume: 1 }\npad: note("c3").midi(${P}, { midichannel: 3, controls: c })`, {});
  refuse(`pad: note("c3").midi({ port: 'Port A', midichannel: 3 })`, {});
  refuse(`pad: note("c3").midi(${P}, { midichannel: 3, controls: { volume: 1, volume: 2 } })`, {});
  refuse(`pad: note("c3").midi(${P}, { ...base, midichannel: 3 })`, {}, 'track-gone');
  refuse(PAD, { port: 'Port B' }, 'track-gone');
  refuse(PAD, { value: 128 });
  refuse(PAD, { value: -1 });
  refuse(PAD, { value: 1.5 });
  refuse(PAD, { type: 'gain' });
  refuse(PAD, { control: 'Not An Id' });
});

test('reading says why a track has no controls: several calls, options in a variable, no model, an invalid file, a port not in the file', () => {
  const reasonOf = (code, rig) => readMidiTracks(code, { parse, rig }).tracks.get('label:pad').reason;
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 }).midi('Port B')`, RIG), 'portNotPlain');
  assert.equal(reasonOf(OPTIONS_VAR, RIG), 'optionsNotPlain');
  assert.equal(reasonOf(`pad: note("c3").midi({ port: 'Port A' })`, RIG), 'portNotPlain');
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 })`, { setup: 'absent' }), 'noModel');
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 })`, { setup: 'invalid', problems: [], more: 0 }), 'invalidModel');
  // An unreadable setup or a known build mismatch has its own reason, never the invalid-file one.
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 })`, rigFromReadFailure()), 'rigUnreadable');
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 })`, withBuildMismatch(RIG, true)), 'buildMismatch');
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 }).midi('Port B')`, withBuildMismatch(RIG, true)), 'portNotPlain');
  assert.equal(reasonOf(OPTIONS_VAR, rigFromReadFailure()), 'optionsNotPlain');
  assert.equal(reasonOf(`pad: note("c3").midi('Port Z', { midichannel: 3 })`, RIG), 'portNotInFile');
  assert.equal(reasonOf(`pad: note("c3").midi(${P}, { midichannel: 3 })`, RIG), null);
  assert.equal(reasonOf(`pad: note("c3").midichan(3).midi(${P})`, RIG), null);
  assert.equal(reasonOf(`pad: note("c3").midichan(x).midi(${P})`, RIG), 'portNotPlain');
});

test('a .midi call only inside a function argument gives no MIDI track', () => {
  const read = readMidiTracks(`pad: note("c3").every(2, (x) => x.midi(${P}))`, { parse, rig: RIG });
  assert.deepEqual([...read.tracks.keys()], []);
});

// --- The preview sender, on a fake clock ---

function senderRig(minGapMs) {
  let clock = 0;
  const timers = new Map();
  let next = 1;
  const sent = [];
  const sender = createPreviewSender({
    send: (target) => {
      sent.push(target.value);
    },
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => clock,
    ...(minGapMs === undefined ? {} : { minGapMs }),
  });
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      let dueId = null;
      for (const [id, timer] of timers) if (timer.at <= end && (dueId === null || timer.at < timers.get(dueId).at)) dueId = id;
      if (dueId === null) break;
      const { fn, at } = timers.get(dueId);
      timers.delete(dueId);
      clock = at;
      fn();
    }
    clock = end;
  };
  return { sender, sent, advance, timers };
}
const target = (value) => ({ instrumentId: 'mt32', channel: 3, cc: 7, value });

test('the preview sender sends at once, then at most once per gap, and the newest value when the gap ends', () => {
  assert.equal(PREVIEW_MIN_GAP_MS, 20);
  const r = senderRig();
  r.sender.move(target(10));
  assert.deepEqual(r.sent, [10], 'the first move goes at once');
  r.advance(5);
  r.sender.move(target(11));
  r.advance(5);
  r.sender.move(target(12));
  assert.deepEqual(r.sent, [10]);
  r.advance(10);
  assert.deepEqual(r.sent, [10, 12], 'the newest value goes when the gap ends; 11 never does');
});

test('the preview sender never sends an equal target twice in a row, and sends a move that comes after a late timer at once', () => {
  const r = senderRig();
  r.sender.move(target(10));
  r.advance(30);
  r.sender.move(target(10));
  assert.deepEqual(r.sent, [10], 'an equal target is not sent again');
  r.sender.move(target(11));
  assert.deepEqual(r.sent, [10, 11], 'the gap has passed: sent at once');
  r.advance(1);
  r.sender.move(target(12));
  r.advance(25);
  assert.deepEqual(r.sent, [10, 11, 12]);
  assert.equal(r.timers.size, 0);
});

test('the preview sender flushes the pending target at once, and reset drops it', () => {
  const r = senderRig();
  r.sender.move(target(1));
  r.advance(1);
  r.sender.move(target(2));
  r.sender.flush();
  assert.deepEqual(r.sent, [1, 2], 'flush sends the pending target now');
  assert.equal(r.timers.size, 0);
  r.sender.flush();
  assert.deepEqual(r.sent, [1, 2], 'nothing pending: nothing sent');
  r.advance(30);
  r.sender.move(target(3));
  r.advance(1);
  r.sender.move(target(4));
  r.sender.reset();
  r.advance(100);
  assert.deepEqual(r.sent, [1, 2, 3], 'reset drops the pending target');
  r.sender.move(target(3));
  assert.deepEqual(r.sent, [1, 2, 3, 3], 'and forgets the last one sent');
});

// --- The shared formatter of the instrument tag and the written controls ---

test('midiTag names the instrument, the channel and, in the title, the port and the sound', () => {
  const tag = (code, rig = RIG) => midiTag([...readMidiTracks(code, { parse, rig }).tracks.values()][0]);
  assert.deepEqual(tag(PAD), { name: 'mt32', channel: ' \u00b7 ch 3', text: 'mt32 \u00b7 ch 3', title: 'mt32 (Port A) \u00b7 channel 3' });
  const withSound = tag(`pad: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`);
  assert.equal(withSound.title, 'mt32 (Port A) \u00b7 channel 3 \u00b7 Alpha 1');
  assert.equal(withSound.text, 'mt32 \u00b7 ch 3');
  // No instrument for the port: the port stands in for its id.
  const noModel = tag(PAD, { setup: 'absent' });
  assert.deepEqual(noModel, { name: 'Port A', channel: ' \u00b7 ch 3', text: 'Port A \u00b7 ch 3', title: 'Port A \u00b7 channel 3' });
  // No readable channel: no channel part, the port alone in the title.
  const noChannel = tag(`pad: note("c3").midi('Port A', { midichannel: 99 })`);
  assert.deepEqual({ channel: noChannel.channel, text: noChannel.text, title: noChannel.title }, { channel: '', text: 'mt32', title: 'Port A' });
  // No readable port: no tag at all.
  assert.equal(tag(`pad: note("c3").midi('Port A', { midichannel: 3 }).midi('Port B')`), null);
});

test('midiTag never guesses: a default channel is ch 1, midichan counts, an unreadable channel or port leaves less, an unknown port is never an instrument', () => {
  const read = (code, rig = RIG) => readMidiTracks(code, { parse, rig }).tracks;
  const tag = (code, rig = RIG) => midiTag([...read(code, rig).values()][0]);
  // No channel written: Strudel's own default, which is a fact.
  assert.deepEqual(tag(`pad: note("c3").midi('Port A')`), { name: 'mt32', channel: ' \u00b7 ch 1', text: 'mt32 \u00b7 ch 1', title: 'mt32 (Port A) \u00b7 channel 1' });
  assert.equal(tag(`pad: note("c3").midi('Port A', { sound: 'Alpha 1' })`, { setup: 'absent' }).title, 'Port A \u00b7 channel 1');
  // .midichan() on the track's own expression is a channel the page reads.
  assert.equal(tag(`pad: note("c3").midichan(5).midi('Port A')`).text, 'mt32 \u00b7 ch 5');
  // A channel that is not a literal: the name stays, the channel part is empty, the title is the port alone.
  const variable = tag(`const ch = 3\npad: note("c3").midi('Port A', { midichannel: ch })`, { setup: 'absent' });
  assert.deepEqual(variable, { name: 'Port A', channel: '', text: 'Port A', title: 'Port A' });
  // A port in a let variable gives no tag.
  assert.equal(tag(`let port = 'Port A'\npad: note("c3").midi(port, { midichannel: 3 })`), null);
  // A valid rig that lacks the port: the port stands for the instrument, never an id.
  const other = { setup: 'valid', instruments: [{ ...INSTRUMENT, id: 'other', port: 'Port B' }] };
  assert.deepEqual(tag(PAD, other), { name: 'Port A', channel: ' \u00b7 ch 3', text: 'Port A \u00b7 ch 3', title: 'Port A \u00b7 channel 3' });
  // A .midi( only inside a function argument is not on the track's own spine: no entry, so no tag.
  assert.equal(read(`pad: note("c3").layer((x) => x.midi('Port A'))`).size, 0);
  // A track the page could not read a port for has no tag, whatever else it knows.
  assert.equal(midiTag({ spine: { port: null, channel: 3, sound: 'Alpha 1' }, instrument: null }), null);
});

test('controlsText writes the controls in written order, quoting an id that is not a name', () => {
  assert.equal(controlsText(new Map()), '');
  assert.equal(controlsText(new Map([['volume', 90], ['pan', 30]])), 'controls: { volume: 90, pan: 30 }');
  assert.equal(controlsText(new Map([['reverb-send', 40]])), "controls: { 'reverb-send': 40 }");
});

// --- The sweeps Claude wrote (ccn) and the controls a controls option the page cannot read ---

const sweepsOf = (code) => {
  const read = readMidiTracks(code, { parse, rig: RIG });
  assert.equal(read.ok, true);
  return read;
};

test('sweepKey joins the port and the channel with a nul character', () => {
  assert.equal(sweepKey('Port A', 3), 'Port A\u00003');
});

test('a ccn number on a track gives the sweep of its port and channel, a string gives every number in it', () => {
  const one = sweepsOf(`pad: note("c3").ccv(sine.segment(8)).ccn(10).midi('Port A', { midichannel: 3 })`);
  assert.deepEqual([...one.sweeps.get(sweepKey('Port A', 3))], [10]);
  assert.equal(one.sweepsUnknown.size, 0);
  const mini = sweepsOf(`pad: note("c3").ccv(sine.segment(8)).ccn("<7 10>").midi('Port A', { midichannel: 3 })`);
  assert.deepEqual([...mini.sweeps.get(sweepKey('Port A', 3))].sort((a, b) => a - b), [7, 10]);
  const bare = sweepsOf(`pad: ccn(74).ccv(sine.segment(8)).midi('Port A', { midichannel: 3 })`);
  assert.deepEqual([...bare.sweeps.get(sweepKey('Port A', 3))], [74]);
  const none = sweepsOf(PAD);
  assert.equal(none.sweeps.size, 0);
  assert.equal(none.sweepsUnknown.size, 0);
});

test('a ccn in a track with no readable port and channel adds nothing', () => {
  const read = sweepsOf(`pad: note("c3").ccn(10)\nlead: note("c3").ccn(10).midi('Port A', { midichannel: 99 })\nbass: note("c3").ccn(10).midi('Port A', { midichannel: 3 }).midi('Port B')`);
  assert.equal(read.sweeps.size, 0);
  assert.equal(read.sweepsUnknown.size, 0);
});

test('a ccn the page cannot read puts its port and channel in sweepsUnknown', () => {
  for (const argument of ['n', 'n + 1', '`${n}`', '']) {
    const read = sweepsOf(`pad: note("c3").ccn(${argument}).midi('Port A', { midichannel: 3 })`);
    assert.deepEqual([...read.sweepsUnknown], [sweepKey('Port A', 3)], argument);
  }
});

test('a sweep is matched by port and channel, so a swell on channel 2 marks channel 2 for the pad on channel 2 too', () => {
  const read = sweepsOf(`swell: note("c3").ccn(7).ccv(sine.segment(8)).midi('Port A', { midichannel: 2 })\npad: note("e3").midi('Port A', { midichannel: 2 })\nlead: note("g3").midi('Port A', { midichannel: 3 })`);
  assert.deepEqual([...read.sweeps.keys()], [sweepKey('Port A', 2)]);
});

test('the setup call inside a track whose spine cannot be read still places its ccn', () => {
  const read = sweepsOf(`const base = note("c3")\npad: base.ccn(10).midi('Port A', { midichannel: 3 })`);
  assert.deepEqual([...read.sweeps.get(sweepKey('Port A', 3))], [10]);
});

test('the write of a swept control is refused with a sentence, a write of another control goes through, and a Default of the swept one is refused too', () => {
  const code = `pad: note("c3").ccv(sine.segment(8)).ccn(10).midi('Port A', { midichannel: 3 })`;
  const change = (cc, control, value) => ({ type: 'midi-control', identity: 'label:pad', port: 'Port A', channel: 3, control, cc, value });
  assert.throws(() => writeMidiControl(code, change(10, 'pan', 30), { parse }), (error) => error instanceof MixerRewriteError && error.reason === 'unsupported-change' && /sweep/.test(error.message));
  assert.throws(() => writeMidiControl(code, change(10, 'pan', null), { parse }), (error) => error instanceof MixerRewriteError && /sweep/.test(error.message));
  assert.ok(writeMidiControl(code, change(7, 'volume', 90), { parse }).code.includes('controls: { volume: 90 }'));
  const unknown = `pad: note("c3").ccn(n).midi('Port A', { midichannel: 3 })`;
  for (const cc of [7, 10]) {
    assert.throws(() => writeMidiControl(unknown, change(cc, 'volume', 90), { parse }), (error) => error instanceof MixerRewriteError && /controller the mixer cannot read/.test(error.message));
  }
  // A swell on the same channel on another track blocks the write for the pad too.
  const shared = `swell: note("c3").ccn(7).midi('Port A', { midichannel: 3 })\npad: note("e3").midi('Port A', { midichannel: 3 })`;
  assert.throws(() => writeMidiControl(shared, change(7, 'volume', 90), { parse }), (error) => error instanceof MixerRewriteError && /sweep/.test(error.message));
});

test('a call whose controls option is not a plain object of numbers reads as optionsNotPlain', () => {
  const read = readMidiTracks(`pad: note("c3").midi('Port A', { midichannel: 3, controls: someVar })`, { parse, rig: RIG });
  assert.equal(read.tracks.get('label:pad').reason, 'optionsNotPlain');
  assert.equal(read.tracks.get('label:pad').spine.channel, 3);
});

// --- What a MIDI track leaves ringing when it stops ---

const slotsOf = (code) => readMidiSlots(code, { parse });
const stopsOf = (before, after) => midiStops(slotsOf(before), slotsOf(after));
const line = (label, port, channel) => `${label}: note("c3").midi('${port}', { midichannel: ${channel} })\n`;

test('readMidiSlots reads the port and channel of each MIDI track, its stability and whether it is muted', () => {
  const read = slotsOf(`${line('pad', 'Port A', 3)}${line('_lead', 'Port A', 4)}$: note("e3").midi('Port B')\nbeat: s("bd*4")\n`);
  assert.equal(read.ok, true);
  assert.deepEqual([...read.tracks.keys()].filter((key) => key.startsWith('label:')), ['label:pad', 'label:lead']);
  const pad = read.tracks.get('label:pad');
  assert.deepEqual(pad.slots, [{ port: 'Port A', channel: 3 }]);
  assert.equal(pad.stable, true);
  assert.equal(pad.muted, false);
  assert.equal(pad.unreadable, false);
  assert.equal(read.tracks.get('label:lead').muted, true);
  const dollar = [...read.tracks.values()].find((track) => !track.identity.startsWith('label:'));
  assert.deepEqual(dollar.slots, [{ port: 'Port B', channel: 1 }], 'no channel written is channel 1');
  assert.equal(dollar.stable, false);
  assert.equal(read.tracks.has('label:beat'), false, 'a track with no .midi( call is not a MIDI track');
  assert.deepEqual(slotsOf('note("c3").midi('), { ok: false });
});

test('readMidiSlots marks a track unreadable when a port or channel is a variable or an index, a midiport or a misplaced midichan', () => {
  for (const source of [
    `const port = 'Port A'\nx: note("c3").midi(port)\n`,
    `x: note("c3").midi('Port A', { midichannel: chan })\n`,
    `x: note("c3").midi(2)\n`,
    `x: note("c3").midi('Port A').midiport('Port B')\n`,
  ]) {
    const read = slotsOf(source);
    assert.equal(read.tracks.get('label:x').unreadable, true, source);
  }
  assert.equal(slotsOf(`x: note("c3").midi('Port A', { midichannel: 3 }).midichan(4)\n`).tracks.get('label:x').unreadable, false);
});

test('muting, hushing, removing or retargeting the only track of a channel silences that channel, and only that one', () => {
  const base = `${line('pad', 'Port A', 3)}${line('lead', 'Port A', 4)}`;
  assert.deepEqual(stopsOf(base, `${line('_pad', 'Port A', 3)}${line('lead', 'Port A', 4)}`).silence, [{ port: 'Port A', channel: 3 }]);
  assert.deepEqual(stopsOf(base, line('lead', 'Port A', 4)).silence, [{ port: 'Port A', channel: 3 }], 'a removal');
  assert.deepEqual(stopsOf(base, `pad: note("c3").midi('Port A', { midichannel: 3 }).hush()\n${line('lead', 'Port A', 4)}`).silence, [{ port: 'Port A', channel: 3 }], 'a hush');
  assert.deepEqual(stopsOf(base, `${line('pad', 'Port A', 5)}${line('lead', 'Port A', 4)}`).silence, [{ port: 'Port A', channel: 3 }], 'channel 3 is left');
  assert.deepEqual(stopsOf(base, `${line('pad', 'Port B', 3)}${line('lead', 'Port A', 4)}`).silence, [{ port: 'Port A', channel: 3 }], 'port A is left');
  assert.deepEqual(stopsOf(`${line('_pad', 'Port A', 3)}`, '').silence, [], 'a muted track that is removed has nothing left to stop');
  assert.deepEqual(stopsOf(`${line('_pad', 'Port A', 3)}`, line('pad', 'Port A', 3)).silence, [], 'an unmute stops nothing');
  assert.deepEqual(stopsOf(base, base), { silence: [], targeted: [], skipped: [] });
});

test('a solo on another track silences a MIDI track, and an unparsable code stops nothing', () => {
  const base = `${line('pad', 'Port A', 3)}${line('lead', 'Port A', 4)}`;
  const stops = stopsOf(base, `${line('pad', 'Port A', 3)}${line('S_lead', 'Port A', 4)}`);
  assert.deepEqual(stops.silence, [{ port: 'Port A', channel: 3 }]);
  assert.deepEqual(stops.targeted, []);
  assert.deepEqual(stopsOf(base, 'pad: note("c3").midi(').silence, []);
  assert.deepEqual(stopsOf('pad: note("c3").midi(', base).silence, []);
});

test('a $: track that edits its text keeps its channel; with nothing left on the channel it is silenced', () => {
  const before = `$: note("c3 e3").midi('Port A', { midichannel: 3 })\n`;
  const after = `$: note("c3 g3").midi('Port A', { midichannel: 3 })\n`;
  assert.deepEqual(stopsOf(before, after).silence, [], 'the edited $: track still plays the channel');
  assert.deepEqual(stopsOf(before, `${line('beat', 'Port A', 4)}`).silence, [{ port: 'Port A', channel: 3 }]);
});

test('an unreadable track that is no longer played the same way is skipped, one that plays on is not', () => {
  const before = `x: note("c3").midi(port)\n`;
  assert.deepEqual(stopsOf(before, `_x: note("c3").midi(port)\n`).skipped, ['label:x']);
  assert.deepEqual(stopsOf(before, '').skipped, ['label:x']);
  assert.deepEqual(stopsOf(before, before).skipped, []);
});

test('two stopped tracks on two ports give one silence per port and channel, in the order of the old tracks', () => {
  const stops = stopsOf(`${line('a', 'Port B', 2)}${line('b', 'Port A', 3)}${line('c', 'Port A', 3)}`, '');
  assert.deepEqual(stops.silence, [{ port: 'Port B', channel: 2 }, { port: 'Port A', channel: 3 }]);
});

test('a stopped named track on a channel another track still plays gets a targeted stop, not a silence', () => {
  const stops = stopsOf(`${line('kick', 'Port A', 10)}${line('hat', 'Port A', 10)}`, `${line('_kick', 'Port A', 10)}${line('hat', 'Port A', 10)}`);
  assert.deepEqual(stops.silence, []);
  assert.equal(stops.targeted.length, 1);
  assert.equal(stops.targeted[0].port, 'Port A');
  assert.equal(stops.targeted[0].channel, 10);
  assert.equal(stops.targeted[0].track.identity, 'label:kick');
  assert.equal(stops.targeted[0].track.index, 0);
});

test('a $: track or a stack() branch on a channel another track still plays gets no targeted stop: its identity is not stable', () => {
  const dollar = stopsOf(`$: note("c3").midi('Port A', { midichannel: 10 })\n${line('hat', 'Port A', 10)}`, line('hat', 'Port A', 10));
  assert.deepEqual(dollar, { silence: [], targeted: [], skipped: [] });
  const branch = stopsOf(
    `stack(note("c3").midi('Port A', { midichannel: 10 }), note("e3*2").midi('Port A', { midichannel: 10 }))`,
    `stack(note("e3*2").midi('Port A', { midichannel: 10 }))`,
  );
  assert.deepEqual(branch, { silence: [], targeted: [], skipped: [] });
});

test('a named track moved to another channel is stopped on the old one by the same rules', () => {
  const stops = stopsOf(`${line('pad', 'Port A', 3)}${line('lead', 'Port A', 3)}`, `${line('pad', 'Port A', 5)}${line('lead', 'Port A', 3)}`);
  assert.deepEqual(stops.silence, []);
  assert.deepEqual(stops.targeted.map((stop) => [stop.port, stop.channel, stop.track.identity]), [['Port A', 3, 'label:pad']]);
});

test('a rename alone is not a stop: the same expression under another label keeps playing, a changed one is stopped', () => {
  const hat = line('hat', 'Port A', 10);
  const before = `${line('pad', 'Port A', 10)}${hat}`;
  assert.deepEqual(stopsOf(before, `${line('pad2', 'Port A', 10)}${hat}`), { silence: [], targeted: [], skipped: [] });
  assert.deepEqual(stopsOf(`${line('pad', 'Port A', 10)}`, `${line('pad2', 'Port A', 10)}`), { silence: [], targeted: [], skipped: [] }, 'alone on its channel too');
  assert.deepEqual(stopsOf(`x: note("c3").midi(port)\n`, `y: note("c3").midi(port)\n`).skipped, [], 'an unreadable track that is renamed plays on');
  // The same text but muted under the new label is a mute, not a rename.
  assert.deepEqual(stopsOf(before, `${line('_pad2', 'Port A', 10)}${hat}`).targeted.map((stop) => stop.track.identity), ['label:pad']);
  // Another expression under the new label is a removal of the old one.
  const changed = stopsOf(before, `pad2: note("e3").midi('Port A', { midichannel: 10 })\n${hat}`);
  assert.deepEqual(changed.targeted.map((stop) => stop.track.identity), ['label:pad']);
});

/** A fake pattern whose haps are `{ whole, value, duration }`; it records the arc it was asked for. */
const fakePattern = (haps) => {
  const pattern = { asked: null, queryArc: (begin, end) => { pattern.asked = [begin, end]; return haps; } };
  return pattern;
};

test('notesToStop queries [now - 0.1 s, now + 0.3 s] in cycles, at any tempo, and keeps the haps that sound in that window', () => {
  assert.equal(STOP_WINDOW_BEFORE_S, 0.1);
  assert.equal(STOP_WINDOW_AFTER_S, 0.3);
  for (const cps of [0.5, 2]) {
    const now = 10;
    const at = (seconds) => now + seconds * cps;
    const note = (name, begin, endSeconds) => ({ whole: { begin: at(begin), end: at(endSeconds) }, value: { note: name }, duration: at(endSeconds) - at(begin) });
    const pattern = fakePattern([
      note('c3', -1, -0.05), // ended 0.05 s before now: kept
      note('d3', -1, -0.2), // ended 0.2 s before now: dropped
      note('e3', 0.25, 0.5), // starts 0.25 s after now: kept
      note('f3', 0.4, 0.6), // starts 0.4 s after now: dropped
      note('g3', -1, 2), // sounding across the window: kept
    ]);
    const pitches = notesToStop(pattern, now, cps);
    assert.deepEqual(pitches, [48, 52, 55], `at ${cps} cps`);
    assert.ok(Math.abs(pattern.asked[0] - at(-0.1)) < 1e-9 && Math.abs(pattern.asked[1] - at(0.3)) < 1e-9, `the arc follows the tempo at ${cps} cps`);
  }
});

test('notesToStop drops a hap with no whole or no readable pitch, and returns sorted distinct whole pitches 0 to 127', () => {
  const sounding = (value, extra = {}) => ({ whole: { begin: 9.9, end: 10.5 }, value, duration: 0.6, ...extra });
  const pitches = notesToStop(
    fakePattern([
      sounding({ note: 'e3' }),
      sounding({ note: 'c3' }),
      sounding({ note: 'c3' }),
      sounding({ note: 64.4 }),
      sounding({ s: 'bd' }),
      sounding({ note: 'c3' }, { whole: undefined }),
      sounding({ note: 200 }),
      sounding({ note: -5 }),
      sounding({ note: 'nonsense' }),
    ]),
    10,
    1,
  );
  assert.deepEqual(pitches, [48, 52, 64]);
});

test('notesToStop uses the hap duration, which includes clip, else the length of the whole', () => {
  const now = 10;
  const clipped = { whole: { begin: 9, end: 10.2 }, value: { note: 'c3' }, duration: 0.5 }; // clipped to end at 9.5: before the window
  const open = { whole: { begin: 9, end: 10.2 }, value: { note: 'e3' } }; // no duration: the whole's length
  assert.deepEqual(notesToStop(fakePattern([clipped, open]), now, 1), [52]);
});

// --- Which tracks provably play no notes (they fold into one line of the Mixer) ---

const playsNotesOf = (code) => {
  const read = readMidiTracks(code, { parse, rig: RIG });
  assert.equal(read.ok, true, code);
  const [track, ...rest] = [...read.tracks.values()];
  assert.equal(rest.length, 0, code);
  return track.playsNotes;
};

test('playsNotes is false for tracks that only send controls, change the program or are a silent clock', () => {
  const folded = [
    `reverb_send: ccn(91).ccv(0.95).midi('Port A', { midichannel: 15 })`,
    `sweep: ccv(sine.segment(16)).ccn(74).midi('Port A', { midichannel: 15 })`,
    `clock: silence.midi('Port A', { midichannel: 2 })`,
    `$: silence.midi('Port A', { midichannel: 2 })`,
    `prog: progNum("<0 5>").midi('Port A', { midichannel: 4 })`,
    `lfo: ccv("<.2 .8>").ccn(91).slow(2).midi('Port A', { midichannel: 4 })`,
    `lfo: ccv(saw.range(0, 1).segment(8)).ccn(1).fast(2).early(0.25).rev().midi('Port A', { midichannel: 4 })`,
    `send: ccn(91).ccv(0.4).midi('Port A', { midichannel: 15, controls: { volume: 90 } })`,
    `send: ccn(91).ccv(rand).midi('Port A', { midichannel: 15, controls: { volume: 90 }, sound: 'Alpha 1' })`,
  ];
  for (const code of folded) assert.equal(playsNotesOf(code), false, code);
});

test('playsNotes stays true for every track that plays or may play notes, and when in doubt', () => {
  const kept = [
    `pad: note("c3").midi('Port A', { midichannel: 3 })`,
    `pad: n("0 2").scale("C:major").midi('Port A', { midichannel: 3 })`,
    `pad: n("0 2").midi('Port A', { midichannel: 3 })`,
    `pad: progNum(5).note("c3").midi('Port A', { midichannel: 3 })`,
    `pad: ccn(7).ccv(.5).note("c3").midi('Port A', { midichannel: 3 })`,
    `const base = ccn(1)\npad: base.midi('Port A', { midichannel: 3 })`,
    `pad: stack(silence, note("c3")).midi('Port A', { midichannel: 3 })`,
    `const silence = note("c3")\nclock: silence.midi('Port A', { midichannel: 3 })`,
    `const sine = note("c3")\nsw: ccv(sine).ccn(74).midi('Port A', { midichannel: 3 })`,
    `pad: note("c3").midi('Port A', { midichannel: 5, isController: true })`,
    `lfo: ccn(91).ccv(0.9).every(2, (x) => x.fast(2)).midi('Port A', { midichannel: 3 })`,
    `lfo: ccn(91).ccv(0.9).control({ a: 1 }).midi('Port A', { midichannel: 3 })`,
    `pad: s("bd*4").midi('Port A', { midichannel: 3 })`,
    `pad: silence.note("c3").midi('Port A', { midichannel: 3 })`,
    `pad: ccn(91)["note"]("c3").midi('Port A', { midichannel: 3 })`,
  ];
  for (const code of kept) assert.equal(playsNotesOf(code), true, code);
});

test('an option key of .midi() is a label and never a name, but a value in it still counts', () => {
  assert.equal(playsNotesOf(`send: ccn(91).ccv(0.4).midi('Port A', { midichannel: 15, controls: { volume: 90 }, volume: 3, sound: 'Alpha 1' })`), false);
  assert.equal(playsNotesOf(`const level = 90\nsend: ccn(91).ccv(0.4).midi('Port A', { midichannel: 15, controls: { volume: level } })`), true);
});

test('playsNotes is set on every MIDI track, with and without a rig', () => {
  const code = `pad: note("c3").midi('Port A', { midichannel: 3 })\nsend: ccn(91).ccv(0.95).midi('Port A', { midichannel: 15 })`;
  for (const rig of [RIG, { setup: 'absent' }]) {
    const read = readMidiTracks(code, { parse, rig });
    assert.deepEqual([...read.tracks.values()].map((track) => track.playsNotes), [true, false]);
  }
});
