import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import { RIG_COPY, RIG_LIMITS, checkFailureText, checkSetup, closestSounds, drumMapFor, parseRigMessage, rigFromReadFailure, soundKey, withBuildMismatch } from '../page/midi-rig.js';
import { BUILT_IN_DRUM_MAPS, MAX_DRUM_MAPS } from '../dist/drum-maps.js';
import { DRUM_MAP_CASES, bankDrumsModel, gmDrumsModel } from './drum-fixtures.js';
import { readMidiSetup } from '../page/midi-plan.js';
import { MixerRewriteError, writeTrack } from '../page/mixer-rewrite.js';
import * as instruments from '../dist/instruments.js';
import {
  MAX_MIDI_NAME_LENGTH,
  MAX_RIG_CATALOG_KITS,
  MAX_RIG_CATALOG_SOUNDS,
  MAX_RIG_CONTROLS,
  MAX_RIG_DRUM_MAPS,
  MAX_RIG_DRUM_NAME,
  MAX_RIG_DRUM_NOTES,
  MAX_RIG_INSTRUMENTS,
  MAX_RIG_PROBLEMS,
  MAX_RIG_SOUNDS,
} from '../dist/protocol.js';

// Every form of a .midi() call is read exactly or refused with its own reason, and a
// refusal is one self-contained first line, the valid values, and a closing line, in code order. All
// data is neutral (Port A, Alpha 1, Bell 2): no real sound list is ever copied into a test.

const CLOSING_PLAYING = 'The previous music keeps playing.';
const CLOSING_STOPPED = 'Nothing changed in the music.';
const BUDGET = 480;

const sound = (name, program, bank) => (bank === undefined ? { name, program } : { name, program, bank });

const MELODIC = [
  sound('Alpha 1', 0),
  sound('Alpha 2', 1),
  sound('Bell 1', 2),
  sound('Bell 2', 3),
  sound('Cello', 4),
  sound('Drone', 5),
  sound('Echo Pad', 6),
];

// The controls of the shipped MT-32 model (instruments/mt32.json), copied so a test never reads a file.
const CONTROLS = [
  { id: 'modulation', name: 'Modulation', cc: 1, min: 0, max: 127, default: 0 },
  { id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 },
  { id: 'pan', name: 'Pan', cc: 10, min: 0, max: 127, default: 64 },
  { id: 'expression', name: 'Expression', cc: 11, min: 0, max: 127, default: 127 },
  { id: 'hold', name: 'Hold', cc: 64, min: 0, max: 127, default: 0 },
];

function makeInstrument(id, port, channels, rest = {}) {
  return {
    id,
    model: id,
    modelName: `Model ${id}`,
    port,
    channels,
    bankSelect: 'none',
    defaultVolume: 100,
    controls: CONTROLS,
    reset: null,
    sounds: { melodic: MELODIC, rhythm: [] },
    ...rest,
  };
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// mt32: channels 2-10, rhythm on 10 with no sounds. sc: channels 1-16, rhythm on 10 with one sound, bank msb.
const MT32 = makeInstrument(
  'mt32',
  'Port A',
  range(2, 10).map((channel) => ({ channel, role: channel === 10 ? 'rhythm' : 'melodic' })),
);
const SC = makeInstrument(
  'sc',
  'Port B',
  range(1, 16).map((channel) => ({ channel, role: channel === 10 ? 'rhythm' : 'melodic' })),
  {
    bankSelect: 'msb',
    sounds: { melodic: [...MELODIC, sound('Alpha 1 Var', 0, { msb: 8 })], rhythm: [sound('Kit 1', 0)] },
  },
);
const RIG = { setup: 'valid', instruments: [MT32, SC] };

const read = (code) => {
  const result = readMidiSetup(code, { parse });
  assert.equal(result.ok, true, `expected ${code} to parse`);
  return result.calls;
};

function check(code, { rig = RIG, outputs = [], playing = true } = {}) {
  return checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs, playing });
}

function refusalOf(code, options) {
  const { refusal } = check(code, options);
  assert.notEqual(refusal, null, `expected ${code} to be refused`);
  return refusal;
}

const linesOf = (text) => text.split('\n');
const length = (text) => Array.from(text).length;

// --- readMidiSetup: what is read ---

test('readMidiSetup reads the plain forms alike and ignores other option keys', () => {
  const [short] = read(`note("c3").midi('Port A')`);
  assert.equal(short.port, 'Port A');
  assert.equal(short.channel, 1);
  assert.equal(short.sound, null);
  assert.deepEqual(short.problems, { port: null, channel: null, sound: null, controls: null });
  const forms = [
    `note("c3").midi('Port A', { midichannel: 3, sound: 'Bell 2' })`,
    `note("c3").midi({ port: 'Port A', midichannel: 3, sound: 'Bell 2' })`,
    `note("c3").midi('Port A', { velocity: 0.5, noteOffsetMs: 20, midichannel: 3, sound: 'Bell 2' })`,
  ];
  for (const code of forms) {
    const [call] = read(code);
    assert.deepEqual([call.port, call.channel, call.sound], ['Port A', 3, 'Bell 2'], code);
    assert.deepEqual(call.problems, { port: null, channel: null, sound: null, controls: null }, code);
  }
});

test('readMidiSetup refuses every port that is not a single-quoted literal, each with portNotPlain', () => {
  const forms = [
    `note("c3").midi("Port A")`,
    'note("c3").midi(`Port A`)',
    `note("c3").midi('Port' + ' A')`,
    `const P = 'Port A'\nnote("c3").midi(P)`,
    `note("c3").midi(0)`,
    `note("c3").midi()`,
    `note("c3").midi({ midichannel: 3 })`,
    `note("c3").midi({ port: "Port A" })`,
  ];
  for (const code of forms) {
    const [call] = read(code);
    assert.equal(call.problems.port?.key, 'portNotPlain', code);
  }
});

test('readMidiSetup refuses an options key that names another port', () => {
  const forms = [
    `note("c3").midi('Port A', { midiport: 'Port B' })`,
    `note("c3").midi('Port A', { port: 'Port B' })`,
    `note("c3").midi({ port: 'Port A', midiport: 'Port B' })`,
  ];
  for (const code of forms) {
    const [call] = read(code);
    assert.equal(call.problems.port?.key, 'portNotPlain', code);
  }
});

test('readMidiSetup refuses options that are not a plain object, with optionsNotPlain', () => {
  const forms = [
    `const opts = { sound: 'Bell 2' }\nnote("c3").midi('Port A', opts)`,
    `note("c3").midi('Port A', { ...opts })`,
    `note("c3").midi('Port A', { [key]: 3 })`,
    `note("c3").midi('Port A', opts())`,
  ];
  for (const code of forms) {
    const [call] = read(code);
    assert.equal(call.problems.channel?.key, 'optionsNotPlain', code);
  }
});

test('readMidiSetup refuses a midichannel that is not a whole number from 1 to 16', () => {
  for (const value of ['0', '17', '2.5', "'3'", 'channel', '-1', '1 + 2', 'null']) {
    const [call] = read(`note("c3").midi('Port A', { midichannel: ${value} })`);
    assert.equal(call.problems.channel?.key, 'channelNotPlain', value);
  }
  const [edge] = read(`note("c3").midi('Port A', { midichannel: 16 })`);
  assert.equal(edge.channel, 16);
  assert.equal(edge.problems.channel, null);
});

test('readMidiSetup refuses a sound that is not a single-quoted literal, the double-quoted one with its own line', () => {
  const forms = [
    `note("c3").midi('Port A', { sound })`,
    `const s = 'Bell 2'\nnote("c3").midi('Port A', { sound: s })`,
    'note("c3").midi(\'Port A\', { sound: `Bell ${n}` })',
    `note("c3").midi('Port A', { sound: 'Bell' + ' 2' })`,
    `note("c3").midi('Port A', { sound: 12 })`,
  ];
  for (const code of forms) {
    const [call] = read(code);
    assert.equal(call.problems.sound?.key, 'soundNotPlain', code);
    assert.deepEqual(call.problems.sound.hints, [], code);
  }
  const [double] = read(`note("c3").midi('Port A', { sound: "Bell 2" })`);
  assert.equal(double.problems.sound.key, 'soundNotPlain');
  assert.deepEqual(double.problems.sound.hints, ['doubleQuotes']);
});

test('readMidiSetup turns every .midiport() call into an entry at its own position', () => {
  const code = `note("c3").midiport('Port B').midi('Port A')\nnote("e3").midi('Port A', { midichannel: 2 })\nmidiport('Port B')`;
  const calls = read(code);
  const midiports = calls.filter((call) => call.problems.port?.key === 'midiportCall');
  assert.equal(midiports.length, 2);
  for (const call of midiports) assert.equal(call.port, null);
  assert.equal(midiports[0].start, code.indexOf(`'Port B'`));
  assert.equal(midiports[1].start, code.lastIndexOf(`'Port B'`));
  assert.deepEqual(
    calls.map((call) => call.start),
    [...calls.map((call) => call.start)].sort((a, b) => a - b),
    'calls stay in source order',
  );
});

test('a .midichan(n) on either side of one .midi() call sets that call channel', () => {
  for (const code of [`note("c3").midichan(3).midi('Port A')`, `note("c3").midi('Port A').midichan(3)`]) {
    const calls = read(code);
    assert.equal(calls.length, 1, code);
    assert.equal(calls[0].channel, 3, code);
    assert.deepEqual(calls[0].problems, { port: null, channel: null, sound: null, controls: null }, code);
  }
  const [override] = read(`note("c3").midichan(4).midi('Port A', { midichannel: 2 })`);
  assert.equal(override.channel, 4, 'midichan overrides midichannel for that call');
});

test('a .midichan that is not a whole-number literal, is doubled or has no .midi() chain gives midichanNotPlain', () => {
  const forms = [
    `note("c3").midichan('<3 4>').midi('Port A')`,
    `note("c3").midichan(chan).midi('Port A')`,
    `note("c3").midichan(17).midi('Port A')`,
    `note("c3").midichan(2).midichan(3).midi('Port A')`,
    `note("c3").midichan(2).midi('Port A').midichan(3)`,
    `stack(note("c3").midichan(2), note("e3").midichan(3)).midi('Port A')`,
    `note("c3").midichan(2)`,
  ];
  for (const code of forms) {
    const calls = read(code);
    const bad = calls.filter((call) => call.problems.port?.key === 'midichanNotPlain');
    assert.equal(bad.length >= 1, true, code);
    assert.deepEqual(bad[0].problems.port.hints, ['midichanHint'], code);
    assert.equal(bad[0].port, null, code);
  }
  const doubled = read(`note("c3").midichan(2).midichan(3).midi('Port A')`);
  assert.equal(doubled.filter((call) => call.problems.port?.key === 'midichanNotPlain').length, 1, 'the later one is the extra');
});

test('code that does not parse gives ok false, and an unparseable edit is refused by nothing', () => {
  assert.deepEqual(readMidiSetup(`note("c3").midi('Port A'`, { parse }), { ok: false });
});

// --- checkSetup: the refusals ---

test('a port that is not in instruments.json is refused with the valid ports, exactly', () => {
  assert.equal(
    refusalOf(`note("c3").midi('Port C')`),
    ['Port "Port C" is not in instruments.json.', 'Valid ports: "Port A" (mt32), "Port B" (sc).', CLOSING_PLAYING].join('\n'),
  );
});

test('a connected port that is not in the file says so on line 1 and asks to add it', () => {
  const text = refusalOf(`note("c3").midi('Port C')`, { outputs: ['Port C', 'Port A'] });
  assert.equal(linesOf(text)[0], 'Port "Port C" is connected but not in instruments.json. Add it there first.');
  assert.equal(linesOf(text)[1], 'Valid ports: "Port A" (mt32), "Port B" (sc).');
});

test('a code port equals a file port by exact string equality: no case folding and no substring', () => {
  for (const port of ['port a', 'Port', 'Port A ', 'Port AB', 'ort A']) {
    const text = refusalOf(`note("c3").midi('${port}')`, { outputs: ['Port A'] });
    assert.ok(linesOf(text)[0].startsWith(`Port "${port}" is`), port);
  }
  assert.equal(check(`note("c3").midi('Port A', { midichannel: 3 })`).refusal, null);
});

test('a channel the instrument does not declare is refused with its declared channels', () => {
  assert.equal(
    refusalOf(`note("c3").midi('Port A')`),
    ['Channel 1 is not declared for mt32.', 'Declared channels for mt32: 2-10.', CLOSING_PLAYING].join('\n'),
    'the default channel is 1',
  );
  const text = refusalOf(`note("c3").midi('Port A', { midichannel: 12 })`);
  assert.equal(linesOf(text)[0], 'Channel 12 is not declared for mt32.');
});

test('a sound on a rhythm channel with no sounds is refused with the channels that have sounds', () => {
  const text = refusalOf(`note("c3").midi('Port A', { midichannel: 10, sound: 'Alpha 1' })`);
  assert.equal(linesOf(text)[0], 'mt32 channel 10 is a rhythm channel with no sounds to choose.');
  assert.equal(linesOf(text)[1], 'Channels of mt32 with sounds: 2-9.');
  assert.equal(linesOf(text).at(-1), CLOSING_PLAYING);
  assert.equal(check(`note("c3").midi('Port B', { midichannel: 10, sound: 'Kit 1' })`).refusal, null);
});

test('an unknown sound gives the closest names and the pointer to the instruments tool', () => {
  const text = refusalOf(`note("c3").midi('Port A', { midichannel: 3, sound: 'Alfa 1' })`);
  const lines = linesOf(text);
  assert.equal(lines[0], 'Unknown sound "Alfa 1" for mt32.');
  assert.ok(lines[1].startsWith('Closest: Alpha 1, Alpha 2, '), lines[1]);
  assert.equal(lines[2], 'Ask for the full list with the instruments tool, instrument "mt32".');
  assert.equal(lines[3], CLOSING_PLAYING);
});

test('a near-miss or unknown name always gives a refusal and never a desired entry (no automatic repair)', () => {
  for (const name of ['Alpha', 'alpha 11', 'Bel 1', 'Alpha 1 ', 'zzz', '']) {
    const result = check(`note("c3").midi('Port A', { midichannel: 3, sound: '${name}' })`);
    if (soundKey(name) === 'alpha1') {
      assert.equal(result.refusal, null, 'a spacing difference is not a near miss');
      continue;
    }
    assert.notEqual(result.refusal, null, name);
    assert.equal(result.desired.size, 0, name);
  }
});

test('a sound matches with other case and spacing, and keeps the name the model writes', () => {
  for (const written of ['alpha 1', 'ALPHA1', '  Alpha   1', 'a l p h a 1']) {
    const { refusal, desired } = check(`note("c3").midi('Port A', { midichannel: 3, sound: '${written}' })`);
    assert.equal(refusal, null, written);
    assert.deepEqual(
      desired.get('mt32:3'),
      { instrument: 'mt32', port: 'Port A', channel: 3, role: 'melodic', sound: 'Alpha 1', program: 0, bank: null },
      written,
    );
  }
});

test('two calls asking the same sound of one channel play, as one desired entry', () => {
  const code = [
    `lead: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`,
    `pad: note("e3").midi('Port A', { midichannel: 3, sound: 'alpha1' })`,
  ].join('\n');
  const { refusal, desired } = check(code);
  assert.equal(refusal, null);
  assert.equal(desired.size, 1);
});

test('two different sounds on one channel are refused naming both, at the second call', () => {
  const code = [
    `lead: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`,
    `pad: note("e3").midi('Port A', { midichannel: 3, sound: 'bell 2' })`,
  ].join('\n');
  const lines = linesOf(refusalOf(code));
  assert.equal(lines[0], 'mt32 channel 3 is asked for two different sounds: "Alpha 1" and "bell 2".');
  assert.equal(lines[1], 'Give each channel one sound.');
  // The same sound on two channels, and two sounds on two channels of one instrument, are fine.
  const apart = code.replace('midichannel: 3, sound: \'bell 2\'', 'midichannel: 4, sound: \'bell 2\'');
  assert.equal(check(apart).refusal, null);
});

test('a call without a sound sends no program change for its channel and never conflicts', () => {
  const code = [
    `lead: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`,
    `pad: note("e3").midi('Port A', { midichannel: 3 })`,
    `bass: note("g2").midi('Port A', { midichannel: 4 })`,
  ].join('\n');
  const { refusal, desired } = check(code);
  assert.equal(refusal, null);
  assert.deepEqual([...desired.keys()], ['mt32:3']);
});

test('a sound with a bank keeps the bank, and the entries are keyed by instrument and channel', () => {
  const { refusal, desired } = check(`note("c3").midi('Port B', { midichannel: 2, sound: 'alpha 1 var' })`);
  assert.equal(refusal, null);
  assert.deepEqual(desired.get('sc:2').bank, { msb: 8 });
  assert.equal(desired.get('sc:2').program, 0);
});

test('a known port that is only unplugged is never a refusal', () => {
  // The code port is in the file; nothing connected is not the page rig check business.
  const { refusal } = check(`note("c3").midi('Port A', { midichannel: 3 })`, { outputs: [] });
  assert.equal(refusal, null);
});

test('a refusal has a one-sentence first line, the valid values, and a closing line that matches the music', () => {
  const codes = [
    `note("c3").midi('Port C')`,
    `note("c3").midi('Port A')`,
    `note("c3").midi('Port A', { midichannel: 3, sound: 'zzz' })`,
    `note("c3").midi('Port A', { midichannel: 10, sound: 'Alpha 1' })`,
    `note("c3").midi("Port A")`,
    `note("c3").midi('Port A', { midichannel: 3, sound: "Alpha 1" })`,
    `note("c3").midi('Port A', { midichannel: 0 })`,
    `note("c3").midiport('Port A').midi('Port A')`,
    `note("c3").midichan(chan).midi('Port A')`,
  ];
  for (const code of codes) {
    for (const [playing, closing] of [
      [true, CLOSING_PLAYING],
      [false, CLOSING_STOPPED],
    ]) {
      const text = refusalOf(code, { playing });
      const lines = linesOf(text);
      assert.ok(lines[0].length > 0 && lines[0].endsWith('.'), `${code}: ${lines[0]}`);
      assert.equal(lines.at(-1), closing, code);
      assert.ok(lines.length >= 2, code);
      assert.ok(length(text) <= BUDGET, code);
    }
  }
});

test('every reading problem has its own line 1 and the double-quote reason follows its sound line', () => {
  assert.equal(linesOf(refusalOf(`note("c3").midi("Port A")`))[0], RIG_COPY.portNotPlain);
  assert.equal(linesOf(refusalOf(`note("c3").midi('Port A', { midichannel: 99 })`))[0], RIG_COPY.channelNotPlain);
  assert.equal(linesOf(refusalOf(`note("c3").midi('Port A', opts)`))[0], RIG_COPY.optionsNotPlain);
  assert.equal(linesOf(refusalOf(`note("c3").midiport('Port A').midi('Port A')`))[0], RIG_COPY.midiportCall);
  const double = linesOf(refusalOf(`note("c3").midi('Port A', { midichannel: 3, sound: "Alpha 1" })`));
  assert.equal(double[0], RIG_COPY.soundNotPlain);
  assert.ok(double.includes(RIG_COPY.doubleQuotes));
  const chan = linesOf(refusalOf(`note("c3").midichan('<3 4>').midi('Port A')`));
  assert.equal(chan[0], RIG_COPY.midichanNotPlain);
  assert.equal(chan[1], RIG_COPY.midichanHint);
});

test('problems are reported in code order and, within one call, port then channel then sound', () => {
  const code = [
    `a: note("c3").midi('Port A', { midichannel: 3, sound: 'zzz' })`,
    `b: note("e3").midi('Port C')`,
    `c: note("g3").midi('Port A', { midichannel: 12 })`,
  ].join('\n');
  const lines = linesOf(refusalOf(code));
  assert.equal(lines[0], 'Unknown sound "zzz" for mt32.', 'the first in the code comes first, not the first kind');
  const alsoLines = lines.filter((line) => line.startsWith('Also: '));
  assert.deepEqual(alsoLines, ['Also: Port "Port C" is not in instruments.json.', 'Also: Channel 12 is not declared for mt32.']);
  assert.equal(lines.at(-1), CLOSING_PLAYING);
  // Within one call the port problem is reported before the channel and sound problems.
  const one = linesOf(refusalOf(`note("c3").midi('Port C', { midichannel: 99, sound: 12 })`));
  assert.equal(one[0], 'Port "Port C" is not in instruments.json.');
});

test('further problems follow as Also lines while they fit, then one line counts the rest', () => {
  const many = Array.from({ length: 12 }, (_, index) => `t${index}: note("c3").midi('Port ${String.fromCharCode(67 + index)}')`).join('\n');
  const text = refusalOf(many);
  const lines = linesOf(text);
  assert.equal(lines[0], 'Port "Port C" is not in instruments.json.');
  assert.ok(length(text) <= BUDGET);
  assert.equal(lines.at(-1), CLOSING_PLAYING);
  const alsos = lines.filter((line) => line.startsWith('Also: '));
  assert.ok(alsos.length >= 2, 'several further problems are named');
  const more = alsos.at(-1);
  const match = /^Also: (\d+) more problems\.$/.exec(more);
  if (match !== null) assert.equal(alsos.length - 1 + Number(match[1]), 11, 'every problem is shown or counted');
  else assert.equal(alsos.length, 11);
});

test('the refusal stays within 480 code points and still ends with the closing line, lists shrink first', () => {
  const bigRig = {
    setup: 'valid',
    instruments: Array.from({ length: 16 }, (_, index) =>
      makeInstrument(`inst-${index}`, `${'P'.repeat(190)}${String(index).padStart(2, '0')}`, [{ channel: 1, role: 'melodic' }]),
    ),
  };
  const longSound = 'S'.repeat(200);
  const codes = [
    `note("c3").midi('${'Q'.repeat(200)}')`,
    `note("c3").midi('${'P'.repeat(190)}00', { midichannel: 3 })`,
    `note("c3").midi('${'P'.repeat(190)}00', { sound: '${longSound}' })`,
    Array.from({ length: 20 }, (_, index) => `t${index}: note("c3").midi('${'Q'.repeat(150)}${index}')`).join('\n'),
  ];
  for (const code of codes) {
    for (const playing of [true, false]) {
      const text = refusalOf(code, { rig: bigRig, playing, outputs: ['Q'.repeat(200)] });
      assert.ok(length(text) <= BUDGET, `${length(text)} for ${code.slice(0, 50)}`);
      assert.equal(linesOf(text).at(-1), playing ? CLOSING_PLAYING : CLOSING_STOPPED);
      assert.ok(!linesOf(text)[0].includes('\n'));
    }
  }
  const text = refusalOf(codes[0], { rig: bigRig });
  assert.match(text, /and \d+ more\./, 'the rest of the list is counted');
});

test('an invalid rig refuses any code with a .midi( call, with up to 3 problems and the more line', () => {
  const rig = {
    setup: 'invalid',
    problems: [
      { field: 'instruments[0].port', reason: 'required' },
      { field: 'instruments[1].model', reason: 'unknown model "x"' },
      { field: 'instruments[2].id', reason: 'required' },
      { field: 'instruments[3].id', reason: 'required' },
    ],
    more: 2,
  };
  const lines = linesOf(refusalOf(`note("c3").midi('Port A')`, { rig }));
  assert.equal(lines[0], RIG_COPY.invalidFile);
  assert.equal(lines[1], 'instruments[0].port: required');
  assert.equal(lines[3], 'instruments[2].id: required');
  assert.equal(lines[4], 'and 3 more problems.');
  assert.equal(lines.at(-1), CLOSING_PLAYING);
  assert.ok(length(lines.join('\n')) <= BUDGET);
  // A line of a very long problem cannot push the closing line out of the budget.
  const long = { setup: 'invalid', problems: Array.from({ length: 3 }, () => ({ field: 'f'.repeat(200), reason: 'r'.repeat(200) })), more: 0 };
  const text = refusalOf(`note("c3").midi('Port A')`, { rig: long });
  assert.ok(length(text) <= BUDGET);
  assert.equal(linesOf(text).at(-1), CLOSING_PLAYING);
});

test('without a setup file nothing is refused and nothing is desired', () => {
  const result = check(`note("c3").midi('Anything', { midichannel: 3, sound: 'nothing' })`, { rig: { setup: 'absent' } });
  assert.deepEqual(result, { refusal: null, desired: new Map(), controls: new Map() });
});

test('an unknown rig state is a loud error', () => {
  assert.throws(() => check(`note("c3").midi('Port A')`, { rig: { setup: 'maybe' } }), /absent, invalid or valid/);
});

// --- closestSounds and soundKey ---

test('closestSounds puts containing names first in list order, then the smallest edit distance, at most 5', () => {
  assert.deepEqual(closestSounds('alpha', MELODIC), ['Alpha 1', 'Alpha 2', 'Bell 1', 'Bell 2', 'Cello']);
  assert.deepEqual(closestSounds('Alpha 1 big', MELODIC).slice(0, 1), ['Alpha 1'], 'a name contained in the query counts');
  assert.deepEqual(closestSounds('Alfa 1', MELODIC).slice(0, 2), ['Alpha 1', 'Alpha 2']);
  assert.equal(closestSounds('zzz', MELODIC).length, 5);
  assert.deepEqual(closestSounds('anything', []), []);
  assert.equal(closestSounds('', MELODIC).length, 5, 'an empty query matches nothing by containment and still gives names');
  // A typo of one letter finds the intended name first.
  assert.equal(closestSounds('Cellp', MELODIC)[0], 'Cello');
  assert.equal(closestSounds('Dronee', MELODIC)[0], 'Drone');
});

test('closestSounds breaks a tie by list order', () => {
  const list = [sound('Tie B', 0), sound('Tie A', 1), sound('Tie C', 2)];
  assert.deepEqual(closestSounds('Tie X', list), ['Tie B', 'Tie A', 'Tie C']);
});

test('soundKey in the page and in the server give the same key for every string of one corpus', () => {
  const corpus = [
    'Alpha 1',
    'ALPHA   1',
    'alpha\t1',
    'alpha 1',
    'alpha　1',
    'ＡＬＰＨＡ １',
    'Café',
    'Café',
    'CAFÉ',
    'İstanbul',
    'a\nb',
    '',
    '   ',
    'Maße',
  ];
  for (const text of corpus) assert.equal(soundKey(text), instruments.soundKey(text), JSON.stringify(text));
  assert.equal(soundKey('Alpha 1'), soundKey('  alpha\t 1 '));
  assert.equal(soundKey('Café'), soundKey('Café'));
});

// --- the limits mirror and the message reader ---

test('RIG_LIMITS equals the limits of the midi-rig message in src/protocol.ts', () => {
  assert.deepEqual(
    { ...RIG_LIMITS },
    {
      instruments: MAX_RIG_INSTRUMENTS,
      sounds: MAX_RIG_SOUNDS,
      controls: MAX_RIG_CONTROLS,
      problems: MAX_RIG_PROBLEMS,
      name: MAX_MIDI_NAME_LENGTH,
      catalogSounds: MAX_RIG_CATALOG_SOUNDS,
      catalogKits: MAX_RIG_CATALOG_KITS,
      drumMaps: MAX_RIG_DRUM_MAPS,
      drumNotes: MAX_RIG_DRUM_NOTES,
      drumName: MAX_RIG_DRUM_NAME,
    },
  );
});

function realMessage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-rig-page-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }] }));
  return instruments.rigMessage(new instruments.RigStore({ dataDir: dir }).read());
}

test('parseRigMessage accepts the message a real RigStore builds, and a wrong type names its field', (t) => {
  const message = realMessage(t);
  const rig = parseRigMessage(message);
  assert.equal(rig.setup, 'valid');
  assert.equal(rig.instruments[0].port, 'Port A');
  assert.ok(rig.instruments[0].sounds.melodic.length > 0);

  const wrongPort = structuredClone(message);
  wrongPort.instruments[0].port = 5;
  assert.throws(() => parseRigMessage(wrongPort), /instruments\[0\]\.port/);

  // The clock flag of each instrument is required and must be true or false.
  assert.equal(rig.instruments[0].clock, false);
  const noClock = structuredClone(message);
  delete noClock.instruments[0].clock;
  assert.throws(() => parseRigMessage(noClock), /instruments\[0\]\.clock/);
  const wrongClock = structuredClone(message);
  wrongClock.instruments[0].clock = 'x';
  assert.throws(() => parseRigMessage(wrongClock), /instruments\[0\]\.clock/);

  // The rhythmBank flag of each instrument is required and must be true or false.
  assert.equal(rig.instruments[0].rhythmBank, false, 'the shipped MT-32 does not opt in');
  const noRhythmBank = structuredClone(message);
  delete noRhythmBank.instruments[0].rhythmBank;
  assert.throws(() => parseRigMessage(noRhythmBank), /instruments\[0\]\.rhythmBank/);
  const wrongRhythmBank = structuredClone(message);
  wrongRhythmBank.instruments[0].rhythmBank = 'x';
  assert.throws(() => parseRigMessage(wrongRhythmBank), /instruments\[0\]\.rhythmBank/);

  // The enabled flag is required and must be true or false, so a message from an older server reads unreadable, never silently on.
  assert.equal(rig.instruments[0].enabled, true, 'the real message of the shipped MT-32 reads enabled true');
  const noEnabled = structuredClone(message);
  delete noEnabled.instruments[0].enabled;
  assert.throws(() => parseRigMessage(noEnabled), /instruments\[0\]\.enabled/);
  const wrongEnabled = structuredClone(message);
  wrongEnabled.instruments[0].enabled = 'yes';
  assert.throws(() => parseRigMessage(wrongEnabled), /instruments\[0\]\.enabled/);
  const off = structuredClone(message);
  off.instruments[0].enabled = false;
  assert.equal(parseRigMessage(off).instruments[0].enabled, false);

  // modelChannels lists every channel of the model, so the editor can offer them all; it is required.
  assert.deepEqual(
    rig.instruments[0].modelChannels,
    [2, 3, 4, 5, 6, 7, 8, 9, 10].map((channel) => ({ channel, role: channel === 10 ? 'rhythm' : 'melodic' })),
    'the shipped MT-32 offers channels 2 to 10 with 10 as rhythm',
  );
  const noModelChannels = structuredClone(message);
  delete noModelChannels.instruments[0].modelChannels;
  assert.throws(() => parseRigMessage(noModelChannels), /instruments\[0\]\.modelChannels/);
  const wrongRole = structuredClone(message);
  wrongRole.instruments[0].modelChannels[0].role = 'drums';
  assert.throws(() => parseRigMessage(wrongRole), /instruments\[0\]\.modelChannels\[0\]\.role/);
  const wrongChannel = structuredClone(message);
  wrongChannel.instruments[0].modelChannels[1].channel = 17;
  assert.throws(() => parseRigMessage(wrongChannel), /instruments\[0\]\.modelChannels\[1\]\.channel/);

  const wrongProgram = structuredClone(message);
  wrongProgram.instruments[0].sounds.melodic[0].program = 'x';
  assert.throws(() => parseRigMessage(wrongProgram), /instruments\[0\]\.sounds\.melodic\[0\]\.program/);

  // The catalog count is required and bounded; a missing or wrong one names its field.
  assert.equal(rig.instruments[0].catalogSounds, 0);
  const noCount = structuredClone(message);
  delete noCount.instruments[0].catalogSounds;
  assert.throws(() => parseRigMessage(noCount), /instruments\[0\]\.catalogSounds/);
  const tooMany = structuredClone(message);
  tooMany.instruments[0].catalogSounds = MAX_RIG_CATALOG_SOUNDS + 1;
  assert.throws(() => parseRigMessage(tooMany), /instruments\[0\]\.catalogSounds/);

  // The catalog kit count is required and bounded too.
  assert.equal(rig.instruments[0].catalogKits, 0);
  const noKitCount = structuredClone(message);
  delete noKitCount.instruments[0].catalogKits;
  assert.throws(() => parseRigMessage(noKitCount), /instruments\[0\]\.catalogKits/);
  const tooManyKits = structuredClone(message);
  tooManyKits.instruments[0].catalogKits = MAX_RIG_CATALOG_KITS + 1;
  assert.throws(() => parseRigMessage(tooManyKits), /instruments\[0\]\.catalogKits/);

  const wrongReason = { type: 'midi-rig', setup: 'invalid', problems: [{ field: 'a', reason: 5 }], more: 0 };
  assert.throws(() => parseRigMessage(wrongReason), /problems\[0\]\.reason/);
  assert.deepEqual(parseRigMessage({ type: 'midi-rig', setup: 'absent' }), { setup: 'absent' });
});

// --- The drum maps of the message, their limits and the one resolution rule ---

function messageOf(t, files, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-rig-drums-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'models'));
  for (const [name, model] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'models', `${name}.json`), JSON.stringify(model));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: entries }));
  const state = new instruments.RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return instruments.rigMessage(state);
}

function drumRigMessage(t) {
  return messageOf(
    t,
    { bankdrums: bankDrumsModel(), gmdrums: gmDrumsModel() },
    [
      { id: 'mt32', model: 'mt32', port: 'Port A' },
      { id: 'sc55', model: 'sc55', port: 'Port B' },
      { id: 'drumbank', model: 'bankdrums', port: 'Port D' },
      { id: 'gmdrums', model: 'gmdrums', port: 'Port G' },
    ],
  );
}

test('the drum limits of the page equal those of the server, and the built-in maps fit under the message cap', () => {
  assert.ok(MAX_DRUM_MAPS + BUILT_IN_DRUM_MAPS.length <= MAX_RIG_DRUM_MAPS);
  assert.equal(RIG_LIMITS.drumMaps, MAX_RIG_DRUM_MAPS);
  assert.equal(RIG_LIMITS.drumNotes, MAX_RIG_DRUM_NOTES);
  assert.equal(RIG_LIMITS.drumName, MAX_RIG_DRUM_NAME);
});

test('parseRigMessage reads the drum maps of a real message, and each wrong edit throws with its path', (t) => {
  const message = drumRigMessage(t);
  const rig = parseRigMessage(message);
  assert.deepEqual(rig.instruments[1].drumMaps.map((map) => map.id), ['gs-standard', 'gs-orchestra', 'gs-sfx', 'cm-64-32l']);
  assert.deepEqual(rig.instruments[3].drumMaps.map((map) => map.id), ['general-midi']);
  assert.equal(rig.instruments[2].sounds.rhythm[2].noteMap, null);
  assert.equal(rig.instruments[1].sounds.rhythm[7].noteMap, 'gs-orchestra');
  assert.equal('noteMap' in rig.instruments[1].sounds.rhythm[0], false);

  const edit = (change) => {
    const copy = structuredClone(message);
    change(copy.instruments);
    return copy;
  };
  const cases = [
    ['a drumMap the message lacks', (list) => { list[2].drumMap = 'nope'; }, /instruments\[2\]\.drumMap/],
    ['a kit noteMap the message lacks', (list) => { list[1].sounds.rhythm[7].noteMap = 'nope'; }, /instruments\[1\]\.sounds\.rhythm\[7\]\.noteMap/],
    ['a repeated map id', (list) => { list[1].drumMaps[1].id = 'gs-standard'; }, /instruments\[1\]\.drumMaps\[1\]\.id/],
    ['a repeated note', (list) => { list[1].drumMaps[0].notes[1].note = 27; }, /instruments\[1\]\.drumMaps\[0\]\.notes\[1\]\.note/],
    ['129 notes', (list) => { list[0].drumMaps[0].notes = Array.from({ length: 129 }, (_, index) => ({ note: index % 128, name: 'x' })); }, /instruments\[0\]\.drumMaps\[0\]\.notes/],
    ['a 41-character name', (list) => { list[0].drumMaps[0].notes[0].name = 'x'.repeat(41); }, /instruments\[0\]\.drumMaps\[0\]\.notes\[0\]\.name/],
    ['a noteMap on a melodic sound', (list) => { list[0].sounds.melodic[0].noteMap = 'mt32-rhythm'; }, /instruments\[0\]\.sounds\.melodic\[0\]\.noteMap/],
    ['a drumMap that is a number', (list) => { list[0].drumMap = 5; }, /instruments\[0\]\.drumMap/],
    ['a missing drumMaps', (list) => { delete list[0].drumMaps; }, /instruments\[0\]\.drumMaps/],
    ['17 maps', (list) => { list[0].drumMaps = Array.from({ length: 17 }, (_, index) => ({ ...list[0].drumMaps[0], id: `m${index}` })); }, /instruments\[0\]\.drumMaps/],
    ['a noteMap that is a number', (list) => { list[1].sounds.rhythm[7].noteMap = 3; }, /instruments\[1\]\.sounds\.rhythm\[7\]\.noteMap/],
  ];
  for (const [what, change, pattern] of cases) assert.throws(() => parseRigMessage(edit(change)), pattern, what);
});

// The server refuses a kit with no bank on a model whose rhythm channels take a bank (it would go out as bank 0/0, a
// melodic tone on the drum part); the page refuses the same message, with the path of the kit, and keeps reading every other model.
test('parseRigMessage refuses a rhythm kit with no bank on an instrument whose rhythm channels take a bank, like the server', (t) => {
  const noBank = bankDrumsModel();
  delete noBank.sounds.rhythm[0].bank;
  const refused = instruments.parseModel(noBank);
  assert.equal(refused.ok, false);
  assert.ok(refused.problems.some((problem) => problem.field === 'sounds.rhythm[0].bank' && problem.reason === 'required: the rhythm channels of this model take a bank'));

  const message = drumRigMessage(t);
  const edit = (change) => {
    const copy = structuredClone(message);
    change(copy.instruments);
    return copy;
  };
  // A kit of the model, then a kit of a catalog (the message lists both in sounds.rhythm).
  assert.throws(
    () => parseRigMessage(edit((list) => { delete list[2].sounds.rhythm[0].bank; })),
    /instruments\[2\]\.sounds\.rhythm\[0\]\.bank is required: the rhythm channels of this instrument take a bank/,
  );
  assert.throws(
    () => parseRigMessage(edit((list) => { list[2].sounds.rhythm.push({ name: 'Catalog Kit', program: 7 }); list[2].catalogKits = 1; })),
    /instruments\[2\]\.sounds\.rhythm\[3\]\.bank/,
  );
  // An instrument that did not opt in keeps kits with no bank, and a message that holds a bank on every kit still reads.
  const rig = parseRigMessage(message);
  assert.equal(rig.instruments[1].rhythmBank, false);
  assert.equal(rig.instruments[1].sounds.rhythm.some((sound) => sound.bank !== undefined), false);
  assert.equal(rig.instruments[2].sounds.rhythm.every((sound) => sound.bank !== undefined), true);
});

test('DRUM_MAP_CASES: the page rule answers like the server rule, and a kit name the rig does not hold is unknown', (t) => {
  for (const testCase of DRUM_MAP_CASES) {
    const model = {
      id: 'casemodel',
      name: 'Case Model',
      channels: { melodic: [1], rhythm: [10] },
      bankSelect: 'none',
      defaultVolume: 100,
      controls: [],
      sounds: { melodic: [], rhythm: testCase.kits },
      notes: [],
      ...testCase.model,
    };
    const message = messageOf(t, { casemodel: model }, [{ id: 'case', model: 'casemodel', port: 'Port A' }]);
    const [instrument] = parseRigMessage(message).instruments;
    const use = drumMapFor(instrument, testCase.kit);
    assert.equal(use.state, testCase.state, testCase.name);
    assert.equal(use.via, testCase.via, testCase.name);
    assert.equal(use.state === 'known' ? use.map.id : null, testCase.id, testCase.name);
  }
  assert.throws(() => drumMapFor({ sounds: { rhythm: [] } }, null), /drumMapFor needs a parsed rig instrument/);
  assert.throws(() => drumMapFor({ drumMaps: [], sounds: { rhythm: [] } }, null), /drumMapFor needs a parsed rig instrument/);
});

test('drumMapFor finds a kit by the same key the code is checked with', (t) => {
  const [mt32, sc55] = parseRigMessage(drumRigMessage(t)).instruments;
  assert.equal(drumMapFor(sc55, '  orchestra   SET ').map.id, 'gs-orchestra');
  assert.equal(drumMapFor(sc55, 'Standard Set').map.id, 'gs-standard');
  assert.equal(drumMapFor(sc55, null).map.id, 'gs-standard');
  assert.equal(drumMapFor(mt32, null).map.id, 'mt32-rhythm');
});

test('parseRigMessage returns the controls of the model in model order, and refuses a message without or with a wrong control', (t) => {
  const message = realMessage(t);
  const rig = parseRigMessage(message);
  assert.deepEqual(
    rig.instruments[0].controls.map((control) => [control.id, control.cc]),
    [['modulation', 1], ['volume', 7], ['pan', 10], ['expression', 11], ['hold', 64]],
  );
  assert.deepEqual(rig.instruments[0].controls[1], { id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 });

  const badCc = structuredClone(message);
  badCc.instruments[0].controls[0].cc = 128;
  assert.throws(() => parseRigMessage(badCc), /instruments\[0\]\.controls\[0\]\.cc must be a whole number from 0 to 127/);

  const missing = structuredClone(message);
  delete missing.instruments[0].controls;
  assert.throws(() => parseRigMessage(missing), /instruments\[0\]\.controls must be a list/);

  const badId = structuredClone(message);
  badId.instruments[0].controls[0].id = 'Not An Id';
  assert.throws(() => parseRigMessage(badId), /instruments\[0\]\.controls\[0\]\.id must be an id/);

  const repeated = structuredClone(message);
  repeated.instruments[0].controls[1].id = 'modulation';
  assert.throws(() => parseRigMessage(repeated), /instruments\[0\]\.controls\[1\]\.id same id as controls\[0\]/);

  const outsideRange = structuredClone(message);
  outsideRange.instruments[0].controls[0].min = 10;
  outsideRange.instruments[0].controls[0].max = 3;
  assert.throws(() => parseRigMessage(outsideRange), /instruments\[0\]\.controls\[0\]\.max must not be below min/);
});

test('checkSetup returns the controls the code writes, keyed by instrument channel and cc, in a Map that is empty on a refusal', () => {
  const { refusal, controls } = check(`note("c3").midi('Port A', { midichannel: 3, controls: { pan: 30, volume: 90 } })`);
  assert.equal(refusal, null);
  assert.deepEqual([...controls.keys()], ['mt32:3']);
  const slot = controls.get('mt32:3');
  assert.deepEqual([slot.instrument, slot.port, slot.channel], ['mt32', 'Port A', 3]);
  assert.deepEqual([...slot.values], [[10, { id: 'pan', value: 30 }], [7, { id: 'volume', value: 90 }]]);
  // A call with controls and no sound is not skipped.
  assert.equal(check(`note("c3").midi('Port A', { midichannel: 3, controls: { volume: 90 } })`).controls.size, 1);
  // A refusal empties it.
  assert.equal(check(`note("c3").midi('Nowhere', { controls: { volume: 90 } })`).controls.size, 0);
  assert.equal(check(`note("c3").midi('Port A')`).controls.size, 0);
});

test('parseRigMessage counts a name in code points, the unit the server cuts in', (t) => {
  // 200 astral characters are 200 code points (the limit) but 400 UTF-16 units; 201 are over it.
  const within = '\u{1F3B5}'.repeat(200);
  const message = (reason) => ({ type: 'midi-rig', setup: 'invalid', problems: [{ field: 'a', reason }], more: 0 });
  assert.equal(parseRigMessage(message(within)).problems[0].reason, within);
  assert.throws(() => parseRigMessage(message(`${within}\u{1F3B5}`)), /problems\[0\]\.reason/);

  // A real file whose unknown key is far over the limit: the server cuts the problem text, and the
  // page reads the cut text instead of dropping the whole message.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-rig-astral-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = { instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A', ['\u{1F3B5}'.repeat(300)]: 1 }] };
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify(file));
  const sent = instruments.rigMessage(new instruments.RigStore({ dataDir: dir }).read());
  assert.equal(sent.setup, 'invalid');
  assert.equal(parseRigMessage(sent).setup, 'invalid');
});

test('a midi-rig message the page cannot read becomes an unreadable rig that refuses code with .midi() without blaming the file', () => {
  let failure = null;
  try {
    parseRigMessage({ type: 'midi-rig', setup: 'valid', instruments: 'x' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'the message is not readable');
  const rig = rigFromReadFailure();
  assert.deepEqual(rig, { setup: 'invalid', unreadable: true, problems: [], more: 0 });
  assert.deepEqual(rigFromReadFailure(), { setup: 'invalid', unreadable: true, problems: [], more: 0 });
  const refusal = refusalOf(`lead: note("c3").midi('Port A')`, { rig });
  assert.equal(linesOf(refusal)[0], RIG_COPY.rigUnreadable);
  assert.equal(linesOf(refusal).at(-1), CLOSING_PLAYING);
  assert.ok(!refusal.includes('instruments.json'), refusal);
  assert.ok(!refusal.startsWith(RIG_COPY.invalidFile), refusal);
  assert.match(RIG_COPY.rigUnreadable, /restart Claude \(the server\)/);
  assert.equal(check(`lead: note("c3")`, { rig }).refusal, null);
});

test('a known build mismatch refuses every .midi() code with the mismatch as the reason, whatever rig the server sent', () => {
  const real = { setup: 'invalid', problems: [{ field: 'instruments[0].port', reason: 'required' }], more: 0 };
  const rigs = [{ setup: 'absent' }, RIG, real, rigFromReadFailure()];
  for (const rig of rigs) {
    const marked = withBuildMismatch(rig, true);
    assert.deepEqual(marked, { setup: 'invalid', problems: [], more: 0, buildMismatch: true });
    const refusal = refusalOf(`lead: note("c3").midi('Port A')`, { rig: marked });
    assert.equal(linesOf(refusal)[0], RIG_COPY.buildMismatch);
    assert.equal(linesOf(refusal).at(-1), CLOSING_PLAYING);
    assert.ok(!refusal.includes('instruments.json'), refusal);
    assert.equal(check(`lead: note("c3")`, { rig: marked }).refusal, null);
    assert.equal(withBuildMismatch(rig, false), rig);
  }
  assert.ok(RIG_COPY.buildMismatch.includes('the server and the page come from different builds, restart the server'), RIG_COPY.buildMismatch);
  assert.equal(linesOf(refusalOf(`lead: note("c3").midi('Port A')`, { rig: withBuildMismatch(RIG, true), playing: false })).at(-1), CLOSING_STOPPED);
});

test('a real invalid file reported by the server keeps its own refusal with its problem rows', () => {
  const real = { setup: 'invalid', problems: [{ field: 'instruments[0].port', reason: 'required' }], more: 0 };
  const refusal = refusalOf(`lead: note("c3").midi('Port A')`, { rig: real });
  assert.equal(linesOf(refusal)[0], RIG_COPY.invalidFile);
  assert.ok(refusal.includes('instruments[0].port: required'), refusal);
});

test('a refusal because the check failed closes with what the play state says', () => {
  const failure = new Error('boom');
  assert.equal(checkFailureText(failure, true), `Moontide could not check the MIDI setup: boom.\n${CLOSING_PLAYING}`);
  assert.equal(checkFailureText(failure, false), `Moontide could not check the MIDI setup: boom.\n${CLOSING_STOPPED}`);
  assert.equal(checkFailureText('plain text', false), `Moontide could not check the MIDI setup: plain text.\n${CLOSING_STOPPED}`);
});

// --- the Mixer keeps the options ---

test('the Mixer refuses a post-gain on a MIDI track (MIDI ignores it) and a mute keeps the .midi() options object exactly as written', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 3, sound: 'Alpha 1' })`;
  assert.throws(
    () => writeTrack(code, 'label:lead', { identity: 'label:lead', type: 'gain', value: 0.5 }, { parse }),
    (error) => error instanceof MixerRewriteError && error.reason === 'unsupported-change' && /ignores a post-gain/.test(error.message),
  );
  const muted = writeTrack(code, 'label:lead', { identity: 'label:lead', type: 'mute', on: true }, { parse }).code;
  assert.ok(muted.includes(`{ midichannel: 3, sound: 'Alpha 1' }`), muted);
  assert.ok(!muted.includes('postgain'), muted);
});

// --- A catalog name resolves like a model name, and an unknown one points to the search tool ---

const CATALOG_INSTRUMENT = makeInstrument(
  'sc55',
  'Port C',
  range(1, 16).map((channel) => ({ channel, role: channel === 10 ? 'rhythm' : 'melodic' })),
  {
    bankSelect: 'msb',
    sounds: { melodic: [...MELODIC, sound('Probe Tone A', 5, { msb: 8 }), sound('Probe Tone B', 6, { msb: 16 })], rhythm: [sound('Kit 1', 0)] },
    catalogSounds: 2,
  },
);
const CATALOG_RIG = { setup: 'valid', instruments: [CATALOG_INSTRUMENT, { ...SC, catalogSounds: 0 }] };

test('a catalog sound resolves to its program and bank like a model sound', () => {
  const { refusal, desired } = check(`note("c3").midi('Port C', { midichannel: 1, sound: 'probe tone a' })`, { rig: CATALOG_RIG });
  assert.equal(refusal, null);
  assert.deepEqual(desired.get('sc55:1'), { instrument: 'sc55', port: 'Port C', channel: 1, role: 'melodic', sound: 'Probe Tone A', program: 5, bank: { msb: 8 } });
});

test('an unknown name on a melodic channel of an instrument with a catalog points to the catalog search', () => {
  const lines = check(`note("c3").midi('Port C', { midichannel: 1, sound: 'Probe Tone Z' })`, { rig: CATALOG_RIG }).refusal.split('\n');
  assert.equal(lines[0], 'Unknown sound "Probe Tone Z" for sc55.');
  assert.ok(lines[1].startsWith('Closest: ') && lines[1].includes('Probe Tone A'), lines[1]);
  assert.equal(lines[2], 'Search the catalog with search_midi_sounds, instrument "sc55".');
  assert.equal(lines[3], CLOSING_PLAYING);
});

test('a rhythm channel and an instrument without a catalog keep the pointer to the instruments tool', () => {
  const rhythm = check(`note("c3").midi('Port C', { midichannel: 10, sound: 'Kit 9' })`, { rig: CATALOG_RIG }).refusal.split('\n');
  assert.equal(rhythm[0], 'Unknown sound "Kit 9" for sc55.');
  assert.ok(rhythm.includes('Ask for the full list with the instruments tool, instrument "sc55".'), rhythm.join('\n'));
  const without = check(`note("c3").midi('Port B', { midichannel: 1, sound: 'Probe Tone Z' })`, { rig: CATALOG_RIG }).refusal.split('\n');
  assert.ok(without.includes('Ask for the full list with the instruments tool, instrument "sc".'), without.join('\n'));
  assert.ok(!without.join('\n').includes('search_midi_sounds'));
});

// --- The controls a call writes are checked, and each one the page cannot send is refused with its reason ---

const SEND_CONTROLS = [...CONTROLS, { id: 'reverb-send', name: 'Reverb send', cc: 91, min: 0, max: 127, default: 40 }, { id: 'tight', name: 'Tight', cc: 20, min: 10, max: 20, default: 15 }];
const SEND_RIG = { setup: 'valid', instruments: [makeInstrument('mt32', 'Port A', range(2, 10).map((channel) => ({ channel, role: 'melodic' })), { controls: SEND_CONTROLS }), SC] };
const withControls = (controls, rest = '') => `note("c3").midi('Port A', { midichannel: 3, ${rest}controls: ${controls} })`;

test('a controls option that is not a plain object of numbers is refused with the shape to write', () => {
  const lines = linesOf(refusalOf(withControls('someVar')));
  assert.equal(lines[0], 'The controls option of .midi() must be a plain object of numbers.');
  assert.equal(lines[1], "Write .midi('Port A', { midichannel: 3, controls: { volume: 90 } }).");
  assert.equal(lines[2], CLOSING_PLAYING);
  for (const controls of ['{ volume: x }', '{ [k]: 1 }', '{ volume: 90, volume: 80 }', "'loud'"]) {
    assert.equal(linesOf(refusalOf(withControls(controls)))[0], 'The controls option of .midi() must be a plain object of numbers.', controls);
  }
  // The port in the hint is cut like every other written name.
  const long = 'P'.repeat(100);
  const longRig = { setup: 'valid', instruments: [makeInstrument('mt32', long, [{ channel: 3, role: 'melodic' }])] };
  const cutLine = linesOf(refusalOf(`note("c3").midi('${long}', { midichannel: 3, controls: someVar })`, { rig: longRig }))[1];
  assert.ok(length(cutLine) < 130 && cutLine.includes('…'), cutLine);
});

test('a control the model does not declare is refused with the declared ones and the pointer to the instruments tool', () => {
  const lines = linesOf(refusalOf(withControls('{ volum: 90 }')));
  assert.equal(lines[0], 'Unknown control "volum" for mt32.');
  assert.equal(lines[1], 'Controls for mt32: modulation, volume, pan, expression, hold.');
  assert.equal(lines[2], 'Ask for the full list with the instruments tool, instrument "mt32".');
  assert.equal(lines[3], CLOSING_PLAYING);
  // A written id is cut at 60 code points like any written name.
  const long = 'x'.repeat(90);
  assert.ok(length(linesOf(refusalOf(withControls(`{ ${long}: 1 }`)))[0]) < 100);
});

test('a value that is not a whole number inside the control range names the range and the default as the example', () => {
  for (const value of ['128', '-1', '30.5']) {
    const lines = linesOf(refusalOf(withControls(`{ pan: ${value} }`)));
    assert.equal(lines[0], 'Control "pan" of mt32 must be a whole number from 0 to 127.', value);
    assert.equal(lines[1], 'Write controls: { pan: 64 }.', value);
    assert.equal(lines[2], CLOSING_PLAYING);
  }
  const narrow = linesOf(refusalOf(withControls('{ tight: 30 }'), { rig: SEND_RIG }));
  assert.equal(narrow[0], 'Control "tight" of mt32 must be a whole number from 10 to 20.');
  assert.equal(narrow[1], 'Write controls: { tight: 15 }.');
  const dash = linesOf(refusalOf(withControls('{ \'reverb-send\': 200 }'), { rig: SEND_RIG }));
  assert.equal(dash[1], "Write controls: { 'reverb-send': 40 }.");
  assert.equal(check(withControls("{ 'reverb-send': 40, tight: 10 }"), { rig: SEND_RIG }).refusal, null);
});

test('two different values of one control on one channel are refused naming both, equal values give one slot', () => {
  const code = (a, b) => [`lead: note("c3").midi('Port A', { midichannel: 3, controls: { volume: ${a} } })`, `pad: note("e3").midi('Port A', { midichannel: 3, controls: { volume: ${b} } })`].join('\n');
  const lines = linesOf(refusalOf(code(60, 90)));
  assert.equal(lines[0], 'mt32 channel 3 is given two different volume values: 60 and 90.');
  assert.equal(lines[1], 'Give each channel one value for a control.');
  assert.equal(lines[2], CLOSING_PLAYING);
  const same = check(code(60, 60));
  assert.equal(same.refusal, null);
  assert.deepEqual([...same.controls.keys()], ['mt32:3']);
  assert.deepEqual([...same.controls.get('mt32:3').values], [[7, { id: 'volume', value: 60 }]]);
  // Two channels, or two different controls, never conflict.
  assert.equal(check(code(60, 90).replace("midichannel: 3, controls: { volume: 90 }", "midichannel: 4, controls: { volume: 90 }")).refusal, null);
  assert.equal(check([`a: note("c3").midi('Port A', { midichannel: 3, controls: { volume: 60 } })`, `b: note("e3").midi('Port A', { midichannel: 3, controls: { pan: 20 } })`].join('\n')).refusal, null);
});

test('a refusal of controls sends nothing: no control is returned', () => {
  for (const controls of ['{ volum: 90 }', '{ pan: 300 }', 'someVar']) {
    const result = check(withControls(controls));
    assert.notEqual(result.refusal, null);
    assert.equal(result.controls.size, 0, controls);
    assert.equal(result.desired.size, 0, controls);
  }
});

test('the controls checks come after the port, the channel and the sound of the same call', () => {
  const sound = linesOf(refusalOf(`note("c3").midi('Port A', { midichannel: 3, sound: 'Zzz', controls: { volum: 1 } })`));
  assert.equal(sound[0], 'Unknown sound "Zzz" for mt32.');
  const channel = linesOf(refusalOf(`note("c3").midi('Port A', { midichannel: 11, controls: { volum: 1 } })`));
  assert.equal(channel[0], 'Channel 11 is not declared for mt32.');
  const notPlain = linesOf(refusalOf(`note("c3").midi('Port A', { midichannel: 3, controls: someVar, sound: 'Alpha 1' })`));
  assert.equal(notPlain[0], 'The controls option of .midi() must be a plain object of numbers.');
  const port = linesOf(refusalOf(`note("c3").midi('Port Z', { midichannel: 3, controls: { volum: 1 } })`));
  assert.equal(port[0], 'Port "Port Z" is not in instruments.json.');
});

test('every refusal of controls stays within 480 code points and a stopped page ends with Nothing changed in the music.', () => {
  const many = Array.from({ length: 32 }, (_, index) => ({ id: `control-number-${String(index).padStart(2, '0')}`, name: `Control ${index}`, cc: index + 20, min: 0, max: 127, default: 0 }));
  const bigRig = { setup: 'valid', instruments: [makeInstrument('mt32', 'Port A', [{ channel: 3, role: 'melodic' }], { controls: many })] };
  const long = 'y'.repeat(300);
  const codes = [
    `note("c3").midi('Port A', { midichannel: 3, controls: { ${long}: 1 } })`,
    `note("c3").midi('Port A', { midichannel: 3, controls: { 'control-number-03': 999 } })`,
    `note("c3").midi('Port A', { midichannel: 3, controls: someVar })`,
    [`a: note("c3").midi('Port A', { midichannel: 3, controls: { 'control-number-03': 1 } })`, `b: note("c3").midi('Port A', { midichannel: 3, controls: { 'control-number-03': 2 } })`].join('\n'),
  ];
  for (const code of codes) {
    for (const playing of [true, false]) {
      const text = refusalOf(code, { rig: bigRig, playing });
      assert.ok(length(text) <= BUDGET, `${length(text)} for ${code.slice(0, 60)}`);
      assert.equal(linesOf(text).at(-1), playing ? CLOSING_PLAYING : CLOSING_STOPPED);
    }
  }
});

test('the message of an sc55 entry that declares four channels still offers all sixteen of its model', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-rig-page-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Port A', channels: [1, 2, 3, 10] }] }));
  const [sc55] = parseRigMessage(instruments.rigMessage(new instruments.RigStore({ dataDir: dir }).read())).instruments;
  assert.deepEqual(sc55.channels.map((entry) => entry.channel), [1, 2, 3, 10]);
  assert.equal(sc55.modelChannels.length, 16);
  assert.deepEqual(sc55.modelChannels.map((entry) => entry.channel), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(sc55.modelChannels.filter((entry) => entry.role === 'rhythm').map((entry) => entry.channel), [10]);
});
