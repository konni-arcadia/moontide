import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as instruments from '../dist/instruments.js';
import { Session } from '../dist/session.js';
import { bankDrumsModel, gmDrumsModel } from './drum-fixtures.js';
import { STEERING_WORDS, TINT_WORDS, findWords } from './tint-rules.js';

// Every problem of instruments.json is a field and a reason, the models are read, and the
// state of the file is worded once per change. Every test works on a temp data folder: never the
// user's real one, and never a real MIDI port.

const { RigStore, rolandDt1 } = instruments;

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-rig-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const entry = (overrides = {}) => ({ id: 'mt32', model: 'mt32', port: 'Fake Synth A', ...overrides });
const rigFile = (...entries) => ({ instruments: entries });

function store(dir) {
  return new RigStore({ dataDir: dir });
}

function readRig(t, files) {
  return store(makeDir(t, files)).read();
}

function problemsOf(state) {
  assert.equal(state.setup, 'invalid', JSON.stringify(state));
  return state.problems;
}

function assertProblem(problems, field, reason) {
  assert.ok(
    problems.some((problem) => problem.field === field && problem.reason === reason),
    `expected "${field} · ${reason}" in ${JSON.stringify(problems)}`,
  );
}

function assertInvalidWith(t, files, field, reason) {
  assertProblem(problemsOf(readRig(t, files)), field, reason);
}

test('a valid instruments.json gives the instrument with the channels and roles of its model', (t) => {
  const state = readRig(t, { 'instruments.json': rigFile(entry()) });
  assert.equal(state.setup, 'valid');
  assert.equal(state.instruments.length, 1);
  const [mt32] = state.instruments;
  assert.equal(mt32.id, 'mt32');
  assert.equal(mt32.port, 'Fake Synth A');
  assert.deepEqual(
    mt32.channels.map((c) => `${c.channel}:${c.role}`),
    ['2:melodic', '3:melodic', '4:melodic', '5:melodic', '6:melodic', '7:melodic', '8:melodic', '9:melodic', '10:rhythm'],
  );
});

test('no instruments.json is absent, and so is a missing data folder file', (t) => {
  assert.deepEqual(readRig(t, {}), { setup: 'absent' });
});

test('a missing field is reported as required at its own path', (t) => {
  assertInvalidWith(t, { 'instruments.json': { instruments: [{ id: 'mt32', model: 'mt32' }] } }, 'instruments[0].port', 'required');
});

test('an extra key is reported as unknown field at its own path, one problem per key', (t) => {
  const problems = problemsOf(readRig(t, { 'instruments.json': rigFile(entry({ colour: 'red', size: 3 })) }));
  assertProblem(problems, 'instruments[0].colour', 'unknown field');
  assertProblem(problems, 'instruments[0].size', 'unknown field');
  assert.ok(!problems.some((problem) => problem.field === 'instruments[0]'), JSON.stringify(problems));
});

test('a bad channel says what is wrong with it', (t) => {
  assertInvalidWith(t, { 'instruments.json': rigFile(entry({ channels: [17] })) }, 'instruments[0].channels[0]', '17 is not between 1 and 16');
  assertInvalidWith(t, { 'instruments.json': rigFile(entry({ channels: [2.5] })) }, 'instruments[0].channels[0]', '2.5 is not a whole number');
  assertInvalidWith(t, { 'instruments.json': rigFile(entry({ channels: ['3'] })) }, 'instruments[0].channels[0]', 'expected a number, got "3"');
});

test('an empty list, too many instruments and a bad id each have their own reason', (t) => {
  assertInvalidWith(t, { 'instruments.json': { instruments: [] } }, 'instruments', 'at least one instrument is required');
  const many = Array.from({ length: 17 }, (_, index) => entry({ id: `s${index}`, port: `Port ${index}` }));
  assertInvalidWith(t, { 'instruments.json': { instruments: many } }, 'instruments', 'at most 16 instruments');
  assertInvalidWith(
    t,
    { 'instruments.json': rigFile(entry({ id: 'MT32' })) },
    'instruments[0].id',
    'must be 1 to 32 lowercase letters, digits, dashes or underscores, starting with a letter or digit',
  );
});

test('an empty port, a port of 201 characters and a root that is not an object are refused', (t) => {
  assertInvalidWith(t, { 'instruments.json': rigFile(entry({ port: '' })) }, 'instruments[0].port', 'must not be empty');
  assertInvalidWith(t, { 'instruments.json': rigFile(entry({ port: 'x'.repeat(201) })) }, 'instruments[0].port', 'at most 200 characters');
  assertInvalidWith(t, { 'instruments.json': '[]' }, 'instruments.json', 'must be an object with an "instruments" list');
});

test('an unknown model lists the known models, shipped then the user models', (t) => {
  const synth = { id: 'synth', name: 'Test Synth', channels: { melodic: [1], rhythm: [] }, bankSelect: 'none', defaultVolume: 100, controls: [], sounds: { melodic: [], rhythm: [] }, notes: [] };
  const dir = makeDir(t, { 'instruments.json': rigFile(entry({ model: 'mt-32' })), 'models/synth.json': synth });
  const known = [...store(dir).shippedModelIds(), 'synth'].join(', ');
  assertProblem(problemsOf(store(dir).read()), 'instruments[0].model', `unknown model "mt-32", known models: ${known}`);
});

test('a channel the model does not have, a channel listed twice, the same id and the same port are refused', (t) => {
  assertInvalidWith(
    t,
    { 'instruments.json': rigFile(entry({ channels: [1] })) },
    'instruments[0].channels[0]',
    'channel 1 is not a channel of model mt32 (channels: 2-10)',
  );
  assertInvalidWith(t, { 'instruments.json': rigFile(entry({ channels: [3, 3] })) }, 'instruments[0].channels[1]', 'channel 3 is listed twice');
  assertInvalidWith(t, { 'instruments.json': rigFile(entry(), entry({ port: 'Other' })) }, 'instruments[1].id', 'same id as instruments[0]');
  assertInvalidWith(t, { 'instruments.json': rigFile(entry(), entry({ id: 'second' })) }, 'instruments[1].port', 'same port as instruments[0] ("mt32")');
});

test('two ports that are part of each other are refused, in either order, because both match one output', (t) => {
  const reason = 'are part of each other, so both match the same output';
  const shorter = entry({ id: 'first', port: 'Fake USB' });
  const longer = entry({ id: 'second', port: 'Fake USB 2' });
  assertInvalidWith(t, { 'instruments.json': rigFile(shorter, longer) }, 'instruments[1].port', `port and the port of instruments[0] ("first") ${reason}`);
  assertInvalidWith(t, { 'instruments.json': rigFile(longer, shorter) }, 'instruments[1].port', `port and the port of instruments[0] ("second") ${reason}`);
  // Names that only share some letters stay valid.
  const state = readRig(t, { 'instruments.json': rigFile(entry({ id: 'first', port: 'Fake Synth A' }), entry({ id: 'second', port: 'Fake Synth B' })) });
  assert.equal(state.setup, 'valid');
});

test('an empty file, a lone byte order mark and text that is not JSON are refused with a reason', (t) => {
  assertInvalidWith(t, { 'instruments.json': '  \n' }, 'instruments.json', 'the file is empty');
  assertInvalidWith(t, { 'instruments.json': '﻿' }, 'instruments.json', 'the file is empty');
  const problems = problemsOf(readRig(t, { 'instruments.json': '{' }));
  assert.equal(problems[0].field, 'instruments.json');
  assert.ok(problems[0].reason.startsWith('not valid JSON'), problems[0].reason);
});

test('a byte order mark before valid JSON is stripped and the file reads as valid', (t) => {
  const state = readRig(t, { 'instruments.json': `﻿${JSON.stringify(rigFile(entry()))}` });
  assert.equal(state.setup, 'valid');
});

test('a file over 1 MiB and a folder named instruments.json are refused', (t) => {
  assertInvalidWith(
    t,
    { 'instruments.json': `{"instruments":[],"pad":"${'x'.repeat(1048576)}"}` },
    'instruments.json',
    'the file is larger than 1 MiB',
  );
  if (process.platform !== 'win32') {
    const dir = makeDir(t);
    fs.mkdirSync(path.join(dir, 'instruments.json'));
    assertProblem(problemsOf(store(dir).read()), 'instruments.json', 'could not be read: EISDIR');
  }
});

test('a user model is usable once instruments.json names it, and models are not read without the file', (t) => {
  const synth = { id: 'synth', name: 'Test Synth', channels: { melodic: [1, 2], rhythm: [] }, bankSelect: 'none', defaultVolume: 100, controls: [], sounds: { melodic: [], rhythm: [] }, notes: [] };
  const withFile = readRig(t, { 'instruments.json': rigFile(entry({ model: 'synth' })), 'models/synth.json': synth, 'models/readme.txt': 'not a model' });
  assert.equal(withFile.setup, 'valid');
  assert.equal(withFile.instruments[0].model.name, 'Test Synth');
  assert.deepEqual(readRig(t, { 'models/bad.json': '{' }), { setup: 'absent' });
});

test('a user model with the wrong id, a shipped id or broken text is a problem of the rig', (t) => {
  const synth = { id: 'synth', name: 'Test Synth', channels: { melodic: [1], rhythm: [] }, bankSelect: 'none', defaultVolume: 100, controls: [], sounds: { melodic: [], rhythm: [] }, notes: [] };
  const shipped = fs.readFileSync(new URL('../instruments/mt32.json', import.meta.url), 'utf8');
  const problems = problemsOf(
    readRig(t, {
      'instruments.json': rigFile(entry()),
      'models/other.json': synth,
      'models/mt32.json': shipped,
      'models/bad.json': '{',
    }),
  );
  assertProblem(problems, 'models/other.json:id', 'must equal the file name ("other")');
  assertProblem(problems, 'models/mt32.json:id', '"mt32" is a shipped model');
  const bad = problems.find((problem) => problem.field === 'models/bad.json');
  assert.ok(bad && bad.reason.startsWith('not valid JSON'), JSON.stringify(problems));
});

function baseModel(overrides = {}) {
  return {
    id: 'synth',
    name: 'Test Synth',
    channels: { melodic: [1, 2], rhythm: [10] },
    bankSelect: 'none',
    defaultVolume: 100,
    controls: [],
    sounds: { melodic: [{ name: 'Str Sect 1', program: 48 }], rhythm: [] },
    notes: [],
    ...overrides,
  };
}

function modelProblems(value) {
  const result = instruments.parseModel(value);
  assert.equal(result.ok, false, 'the model should be refused');
  return result.problems;
}

test('the shipped MT-32 model passes the model checks, and an empty melodic list is valid', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../instruments/mt32.json', import.meta.url), 'utf8'));
  assert.equal(instruments.parseModel(shipped).ok, true);
  assert.equal(instruments.parseModel(baseModel({ sounds: { melodic: [], rhythm: [] } })).ok, true);
});

test('the model checks name a channel in both lists, a bank without bank select and a repeated sound name', () => {
  assertProblem(modelProblems(baseModel({ channels: { melodic: [10], rhythm: [10] } })), 'channels.rhythm[0]', 'channel 10 is also a melodic channel');
  assertProblem(
    modelProblems(baseModel({ sounds: { melodic: [{ name: 'A', program: 1, bank: { msb: 1 } }], rhythm: [] } })),
    'sounds.melodic[0].bank',
    'this model has no bank select',
  );
  assertProblem(
    modelProblems(baseModel({ sounds: { melodic: [{ name: 'Str Sect 1', program: 1 }, { name: 'str  sect1', program: 2 }], rhythm: [] } })),
    'sounds.melodic[1].name',
    'same name as sounds.melodic[0] ("Str Sect 1")',
  );
});

test('the model checks name rhythm sounds without a rhythm channel, a bank on a rhythm sound and a control default out of range', () => {
  assertProblem(
    modelProblems(baseModel({ channels: { melodic: [1], rhythm: [] }, sounds: { melodic: [], rhythm: [{ name: 'Kit', program: 0 }] } })),
    'sounds.rhythm',
    'the model has no rhythm channel',
  );
  assertProblem(
    modelProblems(baseModel({ bankSelect: 'msb', sounds: { melodic: [], rhythm: [{ name: 'Kit', program: 0, bank: { msb: 1 } }] } })),
    'sounds.rhythm[0].bank',
    'rhythm sounds take no bank unless the model sets rhythmBank to true',
  );
  assertProblem(
    modelProblems(baseModel({ controls: [{ id: 'volume', name: 'Volume', cc: 7, min: 10, max: 20, default: 99 }] })),
    'controls[0].default',
    'must be between min and max',
  );
});

test('a drafted reset must be framed, short, 7-bit and written in hex, and has at most 4 messages', () => {
  const raw = (bytes) => baseModel({ reset: { sysex: [{ kind: 'raw', bytes }], waitMs: 100 } });
  assertProblem(modelProblems(raw('7E 7F 09 01')), 'reset.sysex[0].bytes', 'must start with F0 and end with F7');
  assertProblem(modelProblems(raw(`F0 ${Array.from({ length: 31 }, () => '01').join(' ')} F7`)), 'reset.sysex[0].bytes', 'at most 32 bytes');
  assertProblem(modelProblems(raw('F0 7E 80 F7')), 'reset.sysex[0].bytes', 'byte 2 (80) is above 7F');
  assertProblem(modelProblems(raw('F0 ZZ F7')), 'reset.sysex[0].bytes', '"ZZ" is not a two-digit hex byte');
  const five = baseModel({ reset: { sysex: Array.from({ length: 5 }, () => ({ kind: 'raw', bytes: 'F0 7E F7' })), waitMs: 100 } });
  assertProblem(modelProblems(five), 'reset.sysex', 'at most 4 messages');
});

test('a control character in a name or a note is refused', () => {
  assertProblem(modelProblems(baseModel({ name: 'Bad\u0007Name' })), 'name', 'contains a control character');
  assertProblem(modelProblems(baseModel({ notes: ['fine', 'line\nbreak'] })), 'notes[1]', 'contains a control character');
});

test('a model problem found in a user model file is written with the file name before the path', (t) => {
  const broken = baseModel({ channels: { melodic: [10], rhythm: [10] } });
  const problems = problemsOf(readRig(t, { 'instruments.json': rigFile(entry()), 'models/synth.json': broken }));
  assertProblem(problems, 'models/synth.json:channels.rhythm[0]', 'channel 10 is also a melodic channel');
});

test('problems are capped at 20 with the rest counted, and each field and reason is cleaned and cut at 200 characters', (t) => {
  // 16 entries, each with a missing port and two unknown keys: 48 problems.
  const many = Array.from({ length: 16 }, (_, index) => ({ id: `s${index}`, model: 'mt32', one: 1, two: 2 }));
  const capped = readRig(t, { 'instruments.json': { instruments: many } });
  assert.equal(capped.setup, 'invalid');
  assert.equal(capped.problems.length, 20);
  assert.equal(capped.more, 28);
  const messy = readRig(t, { 'instruments.json': rigFile(entry({ model: `bad\u0007${'m'.repeat(300)}` })) });
  const problem = problemsOf(messy).find((p) => p.field === 'instruments[0].model');
  assert.ok(problem, JSON.stringify(messy));
  assert.ok(!/[\u0000-\u001f]/.test(problem.reason), JSON.stringify(problem.reason));
  assert.ok(Array.from(problem.reason).length <= 200, String(problem.reason.length));
});

test('the file-state lines read as facts and join up to 3 problems', () => {
  const one = [{ field: 'instruments[0].port', reason: 'required' }];
  assert.equal(
    instruments.rigInvalidLine(one, 0),
    'MIDI: instruments.json is invalid: instruments[0].port: required. No instruments are set up until it is fixed.',
  );
  const four = [...one, { field: 'a', reason: 'b' }, { field: 'c', reason: 'd' }, { field: 'e', reason: 'f' }];
  assert.equal(
    instruments.rigInvalidLine(four, 2),
    'MIDI: instruments.json is invalid: instruments[0].port: required; a: b; c: d, and 3 more. No instruments are set up until it is fixed.',
  );
  assert.equal(instruments.rigValidAgainLine(1), 'MIDI: instruments.json is valid again: 1 instrument.');
  assert.equal(instruments.rigValidAgainLine(2), 'MIDI: instruments.json is valid again: 2 instruments.');
  assert.equal(
    instruments.rigRemovedLine(),
    'MIDI: instruments.json was removed, so ports and sounds in .midi() calls are not checked any more.',
  );
});

test('the Roland checksum matches the MT-32 reset and the GS reset', () => {
  assert.deepEqual(rolandDt1(0x10, 0x16, [0x7f, 0, 0], [0x00]), [0xf0, 0x41, 0x10, 0x16, 0x12, 0x7f, 0x00, 0x00, 0x00, 0x01, 0xf7]);
  assert.deepEqual(rolandDt1(0x10, 0x42, [0x40, 0, 0x7f], [0x00]), [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]);
});

function noteSession(t, files) {
  const dir = makeDir(t, files);
  return { dir, session: new Session({ rig: store(dir) }) };
}

const rigLines = (session) => session.drainNotices().lines.filter((line) => line.includes('instruments.json'));

test('the setup file is worded once per change of its state', (t) => {
  const { dir, session } = noteSession(t, { 'instruments.json': { instruments: [{ id: 'mt32', model: 'mt32' }] } });
  const file = path.join(dir, 'instruments.json');
  session.syncRig();
  assert.deepEqual(rigLines(session), [
    'MIDI: instruments.json is invalid: instruments[0].port: required. No instruments are set up until it is fixed.',
  ]);
  session.syncRig();
  assert.deepEqual(rigLines(session), [], 'the same problems again are not said again');
  fs.writeFileSync(file, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: '' }] }));
  session.syncRig();
  assert.deepEqual(rigLines(session), [
    'MIDI: instruments.json is invalid: instruments[0].port: must not be empty. No instruments are set up until it is fixed.',
  ]);
  fs.writeFileSync(file, JSON.stringify(rigFile(entry())));
  session.syncRig();
  assert.deepEqual(rigLines(session), ['MIDI: instruments.json is valid again: 1 instrument.']);
  fs.rmSync(file);
  session.syncRig();
  assert.deepEqual(rigLines(session), [
    'MIDI: instruments.json was removed, so ports and sounds in .midi() calls are not checked any more.',
  ]);
  session.syncRig();
  assert.deepEqual(rigLines(session), []);
});

test('a first valid or first absent read says nothing', (t) => {
  const valid = noteSession(t, { 'instruments.json': rigFile(entry()) });
  valid.session.syncRig();
  assert.deepEqual(rigLines(valid.session), []);
  const absent = noteSession(t, {});
  absent.session.syncRig();
  assert.deepEqual(rigLines(absent.session), []);
});

test('the setup file lines drain before the MIDI lines', (t) => {
  const { session } = noteSession(t, { 'instruments.json': { instruments: [] } });
  session.syncRig();
  session.midi.update({
    type: 'midi-state',
    access: 'enabled',
    failure: null,
    usesMidi: true,
    triedMidi: true,
    outputs: ['Fake Synth A'],
    ports: [{ name: 'Nope', state: 'not-found', matches: [] }],
    noPort: null,
    unreadable: false,
    hidden: false,
    playing: true,
    events: [],
  });
  const lines = session.drainNotices().lines.filter((line) => line.startsWith('MIDI:'));
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[0].startsWith('MIDI: instruments.json is invalid'), lines[0]);
  assert.ok(lines[1].includes('"Nope"'), lines[1]);
});

// The shipped models hold every sound of their instrument. The names are API facts typed from
// Roland's owner's manuals and the General MIDI program table; they live in the JSON files, never in
// an exported constant, so the data below is test data only.

const shippedModel = (id) => JSON.parse(fs.readFileSync(new URL(`../instruments/${id}.json`, import.meta.url), 'utf8'));
const { soundKey } = instruments;

test('both shipped models load through RigStore at startup', (t) => {
  assert.deepEqual(store(makeDir(t)).shippedModelIds(), ['mt32', 'sc55']);
});

test('the MT-32 holds 128 melodic sounds at programs 0 to 127 in order and no rhythm sound', () => {
  const { sounds } = shippedModel('mt32');
  assert.deepEqual(
    sounds.melodic.map((sound) => sound.program),
    Array.from({ length: 128 }, (_, program) => program),
  );
  assert.equal(sounds.rhythm.length, 0);
  assert.ok(sounds.melodic.every((sound) => sound.bank === undefined));
});

test('the SC-55 holds the 128 General MIDI names at bank 0 and the ten drum sets of its manual (nine GS sets and the CM-64/32L set)', () => {
  const { sounds } = shippedModel('sc55');
  assert.deepEqual(
    sounds.melodic.map((sound) => sound.program),
    Array.from({ length: 128 }, (_, program) => program),
  );
  assert.equal(soundKey(sounds.melodic[0].name), soundKey('Acoustic Grand Piano'));
  assert.equal(soundKey(sounds.melodic[127].name), soundKey('Gunshot'));
  assert.ok(sounds.melodic.every((sound) => sound.bank === undefined));
  // The manual's drum set table numbers the sets 1, 9, 17, 25, 26, 33, 41, 49, 57 and 128; programs are sent from 0.
  assert.deepEqual(
    sounds.rhythm.map((sound) => [sound.name, sound.program]),
    [
      ['Standard Set', 0],
      ['Room Set', 8],
      ['Power Set', 16],
      ['Electronic Set', 24],
      ['TR-808 Set', 25],
      ['Jazz Set', 32],
      ['Brush Set', 40],
      ['Orchestra Set', 48],
      ['SFX Set', 56],
      ['CM-64/32L Set', 127],
    ],
  );
});

test('the sound keys are unique inside each shipped list', () => {
  for (const id of ['mt32', 'sc55']) {
    const { sounds } = shippedModel(id);
    for (const role of ['melodic', 'rhythm']) {
      const keys = sounds[role].map((sound) => soundKey(sound.name));
      assert.equal(new Set(keys).size, keys.length, `${id} ${role} has a repeated sound key`);
    }
  }
});

test('the eight default part sounds of the MT-32 manual are found at the programs of Roland\'s sound list', () => {
  const { melodic } = shippedModel('mt32').sounds;
  const programOf = (name) => melodic.find((sound) => soundKey(sound.name) === soundKey(name))?.program;
  const expected = {
    'Elec Piano 1': 3,
    'Ice Rain': 41,
    'Str Sect 1': 48,
    'Slap Bass 1': 68,
    'Sax 1': 78,
    'Brs Sect 1': 95,
    'Bottle Blow': 110,
    'Orche Hit': 122,
  };
  for (const [name, program] of Object.entries(expected)) assert.equal(programOf(name), program, name);
});

test('the reset bytes of the shipped models are the verified vectors, with their waits', (t) => {
  const dir = makeDir(t, {
    'instruments.json': rigFile(entry(), entry({ id: 'sc55', model: 'sc55', port: 'Fake Synth B' })),
  });
  const message = instruments.rigMessage(store(dir).read());
  assert.equal(message.setup, 'valid');
  const [mt32, sc55] = message.instruments;
  assert.deepEqual(mt32.reset, { messages: [[0xf0, 0x41, 0x10, 0x16, 0x12, 0x7f, 0x00, 0x00, 0x00, 0x01, 0xf7]], waitMs: 100 });
  assert.deepEqual(sc55.reset, { messages: [[0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]], waitMs: 50 });
});

test('the notes and control names of the shipped models carry no taste (sound names are API facts and are not scanned)', () => {
  for (const id of ['mt32', 'sc55']) {
    const model = shippedModel(id);
    const text = [model.name, ...model.notes, ...model.controls.map((control) => control.name)].join('\n');
    assert.deepEqual(findWords(text, TINT_WORDS), [], `${id} tint`);
    assert.deepEqual(findWords(text, STEERING_WORDS), [], `${id} steering`);
  }
});

// A drafted model is summarized for the user, then saved into the data folder and nowhere else.

function draftModel(overrides = {}) {
  return baseModel({
    id: 'draft',
    name: 'Draft Synth',
    channels: { melodic: [1, 2, 3, 4], rhythm: [10] },
    bankSelect: 'msb-lsb',
    defaultVolume: 100,
    reset: { sysex: [{ kind: 'roland-dt1', model: '16', address: '7F 00 00', data: '00' }], waitMs: 120 },
    controls: [{ id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 }],
    sounds: {
      melodic: [
        { name: 'First Sound', program: 0 },
        { name: 'Last Sound', program: 5 },
      ],
      rhythm: [{ name: 'Kit A', program: 0 }],
    },
    notes: ['Channel 1 is silent until a part is assigned.', 'The second note is kept whole.'],
    ...overrides,
  });
}

function draftOf(overrides) {
  const parsed = instruments.parseModel(draftModel(overrides));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.model;
}

test('summarizeDraft gives one fact per line: channels, sounds with both program numberings, bank select, controls, reset bytes and every note', () => {
  const lines = instruments.summarizeDraft(draftOf()).split('\n');
  assert.deepEqual(lines, [
    'Model "draft": Draft Synth.',
    'Channels: 1-4 melodic; 10 rhythm.',
    'Bank select: CC0 then CC32. Default volume: 100.',
    'Rhythm kits: chosen by program change alone.',
    'Default drum map: none, so kits without their own map have no known map.',
    'Kits with no known map: Kit A.',
    'Melodic sounds: 2, from "First Sound" (program 0 as sent, 1 in a manual numbered from 1) to "Last Sound" (program 5, 6).',
    'Rhythm sounds: 1, from "Kit A" (program 0 as sent, 1 in a manual numbered from 1) to "Kit A" (program 0, 1).',
    'Controls: volume CC7 0-127 (default 100)',
    'Reset when it connects: F0 41 10 16 12 7F 00 00 00 01 F7, then a 120 ms wait.',
    'Clock: none.',
    'Notes:',
    '- Channel 1 is silent until a part is assigned.',
    '- The second note is kept whole.',
  ]);
});

test('summarizeDraft words the empty cases and prints a raw reset as its bytes', () => {
  const text = instruments.summarizeDraft(
    draftOf({
      channels: { melodic: [1, 2], rhythm: [] },
      bankSelect: 'none',
      reset: { sysex: [{ kind: 'raw', bytes: 'f0 7e 7f 09 01 f7' }, { kind: 'raw', bytes: 'F0 7D 01 F7' }], waitMs: 0 },
      controls: [],
      sounds: { melodic: [{ name: 'Only', program: 9 }], rhythm: [] },
      notes: [],
    }),
  );
  const lines = text.split('\n');
  assert.ok(lines.includes('Channels: 1-2 melodic.'), text);
  assert.ok(lines.includes('Bank select: none. Default volume: 100.'), text);
  assert.ok(lines.includes('Rhythm sounds: none.'), text);
  assert.ok(lines.includes('Controls: none.'), text);
  assert.ok(lines.includes('Reset when it connects: F0 7E 7F 09 01 F7 | F0 7D 01 F7, then a 0 ms wait.'), text);
  assert.ok(!lines.includes('Notes:'), text);
  const none = instruments.summarizeDraft(draftOf({ reset: undefined, bankSelect: 'msb' }));
  assert.ok(none.split('\n').includes('Reset when it connects: none.'), none);
  assert.ok(none.split('\n').includes('Bank select: CC0. Default volume: 100.'), none);
});

test('saveUserModel writes models/<id>.json under the data folder and the text read back passes parseModel to the same model', (t) => {
  const dir = makeDir(t);
  const model = draftOf();
  const file = instruments.saveUserModel({ dataDir: dir, model, overwrite: false });
  assert.equal(file, path.join(dir, 'models', 'draft.json'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  const back = instruments.parseModel(JSON.parse(text));
  assert.equal(back.ok, true);
  assert.deepEqual(back.model, model);
});

test('a second save of the same id is refused and leaves the first file as it was; overwrite replaces it and leaves no temporary file', (t) => {
  const dir = makeDir(t);
  const file = instruments.saveUserModel({ dataDir: dir, model: draftOf(), overwrite: false });
  const first = fs.readFileSync(file, 'utf8');
  const changed = draftOf({ name: 'Changed Synth' });
  assert.throws(
    () => instruments.saveUserModel({ dataDir: dir, model: changed, overwrite: false }),
    (error) =>
      error instanceof instruments.ModelSaveError &&
      error.message === 'Model "draft" already exists in the data folder; pass overwrite: true to replace it.',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  instruments.saveUserModel({ dataDir: dir, model: changed, overwrite: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'Changed Synth');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'models')), ['draft.json']);
});

test('a shipped model id is refused with or without overwrite, and nothing is written', (t) => {
  const dir = makeDir(t);
  for (const id of ['mt32', 'sc55']) {
    for (const overwrite of [false, true]) {
      assert.throws(
        () => instruments.saveUserModel({ dataDir: dir, model: draftOf({ id }), overwrite }),
        (error) => error instanceof instruments.ModelSaveError && error.message === `Model id "${id}" belongs to a model Moontide ships; choose another id.`,
      );
    }
  }
  assert.equal(fs.existsSync(path.join(dir, 'models')), false);
});

test('an id that could climb out of the folder never reaches the file system: parseModel refuses it first', () => {
  for (const id of ['../x', 'A', 'a/b', 'a\\b', '..', '']) {
    assertProblem(modelProblems(draftModel({ id })), 'id', 'must be 1 to 32 lowercase letters, digits, dashes or underscores, starting with a letter or digit');
  }
});

test('a model id that is a reserved file name on Windows is refused by parseModel, before any save', () => {
  for (const id of ['con', 'nul', 'aux', 'prn', 'com1', 'com9', 'lpt1', 'lpt9']) {
    assertProblem(modelProblems(draftModel({ id })), 'id', 'is a reserved file name on Windows');
  }
  // Names that only start like a reserved one stay valid.
  for (const id of ['console', 'com10', 'com0', 'lpt', 'nul2']) {
    assert.equal(instruments.parseModel(draftModel({ id })).ok, true, id);
  }
});

test('the saved path is inside the data folder models folder, and the shipped folder is the same before and after a save', (t) => {
  const dir = makeDir(t);
  const shippedDir = instruments.shippedModelsDir();
  const before = fs.readdirSync(shippedDir).sort();
  const file = instruments.saveUserModel({ dataDir: dir, model: draftOf({ id: 'a-b_c9' }), overwrite: false });
  const relative = path.relative(path.join(dir, 'models'), file);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), relative);
  assert.deepEqual(fs.readdirSync(shippedDir).sort(), before);
});

test('a file system failure becomes a ModelSaveError that names the error code only', (t) => {
  const dir = makeDir(t, { models: 'a file where the folder should be' });
  assert.throws(
    () => instruments.saveUserModel({ dataDir: dir, model: draftOf(), overwrite: false }),
    (error) => error instanceof instruments.ModelSaveError && /^Model "draft" could not be saved: [A-Z]+\.$/.test(error.message),
  );
});

test('a saved user model makes an instruments.json that names it valid', (t) => {
  const dir = makeDir(t, { 'instruments.json': rigFile({ id: 'one', model: 'draft', port: 'Fake Synth A' }) });
  assertProblem(problemsOf(store(dir).read()), 'instruments[0].model', 'unknown model "draft", known models: mt32, sc55');
  instruments.saveUserModel({ dataDir: dir, model: draftOf(), overwrite: false });
  assert.equal(store(dir).read().setup, 'valid');
});

// --- The catalog of a used model joins the rig ---

const catalogOf = (modelId, sounds, extra = {}) => ({ model: modelId, source: 'test fixture', sounds, ...extra });
const catalogSound = (name, extra = {}) => ({ name, program: 1, ...extra });
const sc55Entry = (overrides = {}) => entry({ id: 'sc55', model: 'sc55', port: 'Port A', ...overrides });

test('a catalog of a used model is attached to the instrument, and two instruments on one model share it', (t) => {
  const sounds = [catalogSound('Alpha 1', { category: 'Group A', bank: { msb: 8 } }), catalogSound('Beta 2')];
  const state = readRig(t, {
    'instruments.json': rigFile(sc55Entry(), sc55Entry({ id: 'sc55b', port: 'Port B' })),
    'catalogs/sc55.json': catalogOf('sc55', sounds),
  });
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  assert.equal(state.instruments.length, 2);
  for (const instrument of state.instruments) assert.equal(instrument.catalog.sounds.length, 2);
  assert.equal(state.instruments[0].catalog, state.instruments[1].catalog, 'the file is read once per read');
});

test('a catalog of a user model is attached too, and an instrument with no catalog file has none', (t) => {
  const synth = { id: 'synth', name: 'Test Synth', channels: { melodic: [1], rhythm: [] }, bankSelect: 'msb-lsb', defaultVolume: 100, controls: [], sounds: { melodic: [], rhythm: [] }, notes: [] };
  const state = readRig(t, {
    'instruments.json': rigFile(entry({ id: 'one', model: 'synth', port: 'Port A' }), entry({ id: 'two', port: 'Port B' })),
    'models/synth.json': synth,
    'catalogs/synth.json': catalogOf('synth', [catalogSound('Alpha 1', { bank: { msb: 1, lsb: 2 } })]),
  });
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  assert.equal(state.instruments[0].catalog.sounds.length, 1);
  assert.equal(state.instruments[1].catalog, null);
});

test('a broken catalog of a used model makes the rig invalid with its field, and a fixed one makes it valid again', (t) => {
  const dir = makeDir(t, { 'instruments.json': rigFile(sc55Entry()), 'catalogs/sc55.json': catalogOf('sc55', [{ program: 1 }]) });
  const state = store(dir).read();
  assertProblem(problemsOf(state), 'catalogs/sc55.json:sounds[0].name', 'required');
  const message = instruments.rigMessage(state);
  assert.equal(message.setup, 'invalid');
  assert.ok(message.problems.some((problem) => problem.field === 'catalogs/sc55.json:sounds[0].name'));
  fs.writeFileSync(path.join(dir, 'catalogs', 'sc55.json'), JSON.stringify(catalogOf('sc55', [catalogSound('Alpha 1')])));
  const fixed = store(dir).read();
  assert.equal(fixed.setup, 'valid');
  assert.equal(fixed.instruments[0].catalog.sounds[0].name, 'Alpha 1');
});

test('a broken catalog of a model no instrument uses is never read', (t) => {
  const state = readRig(t, {
    'instruments.json': rigFile(sc55Entry()),
    'catalogs/mt32.json': '{ this is not json',
    'catalogs/sc55.json': catalogOf('sc55', [catalogSound('Alpha 1')]),
  });
  assert.equal(state.setup, 'valid', JSON.stringify(state));
});

test('the rig message of a catalog instrument appends the catalog to the melodic sounds, keeps the rhythm list and sends no category', (t) => {
  const state = readRig(t, {
    'instruments.json': rigFile(sc55Entry(), entry({ port: 'Port B' })),
    'catalogs/sc55.json': catalogOf('sc55', [catalogSound('Alpha 1', { category: 'Group A', bank: { msb: 8 } }), catalogSound('Beta 2', { category: 'Group B' })]),
  });
  const message = instruments.rigMessage(state);
  const [withCatalog, without] = message.instruments;
  const own = state.instruments[0].model.sounds;
  assert.equal(withCatalog.catalogSounds, 2);
  assert.equal(withCatalog.sounds.melodic.length, own.melodic.length + 2);
  assert.deepEqual(withCatalog.sounds.melodic.slice(0, own.melodic.length), own.melodic);
  assert.deepEqual(withCatalog.sounds.melodic.slice(own.melodic.length), [
    { name: 'Alpha 1', program: 1, bank: { msb: 8 } },
    { name: 'Beta 2', program: 1 },
  ]);
  assert.deepEqual(withCatalog.sounds.rhythm, own.rhythm);
  assert.ok(!JSON.stringify(withCatalog).includes('category'));
  assert.equal(without.catalogSounds, 0);
});

test('a broken catalog is said once to Claude, and the fix is said once as valid again', (t) => {
  const { dir, session } = noteSession(t, { 'instruments.json': rigFile(sc55Entry()), 'catalogs/sc55.json': catalogOf('sc55', [{ program: 1 }]) });
  session.syncRig();
  const first = rigLines(session);
  assert.equal(first.length, 1);
  assert.ok(first[0].startsWith('MIDI: instruments.json is invalid: catalogs/sc55.json:'), first[0]);
  session.syncRig();
  assert.deepEqual(rigLines(session), [], 'the same problem again is not said again');
  fs.writeFileSync(path.join(dir, 'catalogs', 'sc55.json'), JSON.stringify(catalogOf('sc55', [catalogSound('Alpha 1')])));
  session.syncRig();
  assert.deepEqual(rigLines(session), ['MIDI: instruments.json is valid again: 1 instrument.']);
  session.syncRig();
  assert.deepEqual(rigLines(session), []);
});

// An instrument says whether it follows MIDI clock; the rig file wins over the model, and neither set means no.

const clockOf = (t, model, instrumentEntry) => {
  const files = { 'instruments.json': rigFile(entry({ id: 'synth', model: 'synth', channels: [1], ...instrumentEntry })) };
  files['models/synth.json'] = model;
  const state = readRig(t, files);
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return state.instruments[0].clock;
};

test('the clock of an instrument is the rig entry first, then the model, then false', (t) => {
  assert.equal(clockOf(t, baseModel({ clock: true }), {}), true, 'the model says clock, the entry says nothing');
  assert.equal(clockOf(t, baseModel({ clock: true }), { clock: false }), false, 'the entry turns the model clock off');
  assert.equal(clockOf(t, baseModel({ clock: false }), { clock: true }), true, 'the entry turns the clock on');
  assert.equal(clockOf(t, baseModel(), { clock: true }), true, 'the entry turns the clock on for a model with no clock field');
  assert.equal(clockOf(t, baseModel(), {}), false, 'neither says clock');
  assert.equal(clockOf(t, baseModel({ clock: false }), {}), false);
});

test('a clock that is not true or false is refused in instruments.json and in a model, with its field named', (t) => {
  const fileProblems = problemsOf(readRig(t, { 'instruments.json': rigFile(entry({ clock: 'yes' })) }));
  assert.ok(fileProblems.some((problem) => problem.field === 'instruments[0].clock' && /boolean/.test(problem.reason)), JSON.stringify(fileProblems));
  const problems = modelProblems(baseModel({ clock: 1 }));
  assert.ok(problems.some((problem) => problem.field === 'clock' && /boolean/.test(problem.reason)), JSON.stringify(problems));
  const files = { 'instruments.json': rigFile(entry({ id: 'synth', model: 'synth' })), 'models/synth.json': baseModel({ clock: 'on' }) };
  const stored = problemsOf(readRig(t, files));
  assert.ok(stored.some((problem) => problem.field === 'models/synth.json:clock'), JSON.stringify(stored));
});

test('the shipped models say they do not follow MIDI clock, and parse', () => {
  for (const id of ['mt32', 'sc55']) {
    const shipped = JSON.parse(fs.readFileSync(new URL(`../instruments/${id}.json`, import.meta.url), 'utf8'));
    assert.equal(shipped.clock, false, id);
    const parsed = instruments.parseModel(shipped);
    assert.equal(parsed.ok, true, id);
    assert.equal(parsed.model.clock, false, id);
  }
});

test('get_midi_instruments prints one Clock line per instrument, and the model summary one Clock line after the reset line', (t) => {
  const files = {
    'instruments.json': rigFile(entry({ id: 'seq', model: 'synth', port: 'Port A', channels: [1], clock: true }), entry({ id: 'plain', model: 'mt32', port: 'Port B' })),
    'models/synth.json': baseModel(),
  };
  const state = readRig(t, files);
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const options = { connection: () => 'unknown', shipped: [], dataDirText: 'the data folder' };
  const text = instruments.describeRig(state, options);
  const lines = text.split('\n');
  const follows = '  Clock: follows MIDI clock; Moontide sends the clock, Start and Stop while the playing code names this instrument.';
  assert.equal(lines.filter((line) => line === follows).length, 1, text);
  assert.equal(lines.filter((line) => line === '  Clock: none.').length, 1, text);
  const resetAt = lines.findIndex((line) => line.startsWith('  Reset when it connects:'));
  assert.equal(lines[resetAt + 1], follows, 'the Clock line follows the reset line');
  assert.deepEqual(findWords(text, TINT_WORDS), [], text);
  assert.deepEqual(findWords(text, STEERING_WORDS), [], text);

  const withClock = instruments.summarizeDraft(draftOf({ clock: true })).split('\n');
  const reset = withClock.findIndex((line) => line.startsWith('Reset when it connects:'));
  assert.equal(withClock[reset + 1], 'Clock: follows MIDI clock.');
  assert.ok(instruments.summarizeDraft(draftOf({ clock: false })).split('\n').includes('Clock: none.'));
  assert.ok(instruments.summarizeDraft(draftOf()).split('\n').includes('Clock: none.'));
});

test('the midi-rig message carries the resolved clock of each instrument', (t) => {
  const files = {
    'instruments.json': rigFile(entry({ id: 'seq', model: 'synth', port: 'Port A', channels: [1], clock: true }), entry({ id: 'plain', model: 'mt32', port: 'Port B' })),
    'models/synth.json': baseModel(),
  };
  const message = instruments.rigMessage(readRig(t, files));
  assert.deepEqual(
    message.instruments.map((instrument) => [instrument.id, instrument.clock]),
    [['seq', true], ['plain', false]],
  );
});

// Drum maps are model data; every rule refuses with its field and its reason.

const mapOf = (id, notes = [{ note: 36, name: 'First' }, { note: 38, name: 'Second' }]) => ({ id, name: `Map ${id}`, notes });
const hasProblemAt = (problems, field) => assert.ok(problems.some((problem) => problem.field === field), `expected a problem at ${field} in ${JSON.stringify(problems)}`);

test('drum maps: every rule refuses with its field and its reason', () => {
  assertProblem(modelProblems(baseModel({ drumMaps: [mapOf('a'), mapOf('a')] })), 'drumMaps[1].id', 'same id as drumMaps[0]');
  assertProblem(modelProblems(baseModel({ drumMaps: [mapOf('general-midi')] })), 'drumMaps[0].id', 'is a built-in map');
  assertProblem(
    modelProblems(baseModel({ drumMaps: [mapOf('a', [{ note: 36, name: 'Name' }, { note: 38, name: 'Other' }, { note: 36, name: 'Again' }])] })),
    'drumMaps[0].notes[2].note',
    'same note as notes[0] ("Name")',
  );
  assertProblem(modelProblems(baseModel({ drumMaps: [{ ...mapOf('a'), name: 'Bad\u0007Name' }] })), 'drumMaps[0].name', 'contains a control character');
  assertProblem(modelProblems(baseModel({ drumMaps: [mapOf('a', [{ note: 36, name: 'Bad\nDrum' }])] })), 'drumMaps[0].notes[0].name', 'contains a control character');
  assertProblem(
    modelProblems(baseModel({ drumMaps: [mapOf('a')], drumMap: 'nope' })),
    'drumMap',
    'unknown drum map "nope", this model has: a; built in: general-midi',
  );
  assertProblem(
    modelProblems(baseModel({ drumMaps: [mapOf('a')], sounds: { melodic: [], rhythm: [{ name: 'Kit', program: 0, noteMap: 'nope' }] } })),
    'sounds.rhythm[0].noteMap',
    'unknown drum map "nope", this model has: a; built in: general-midi',
  );
  assertProblem(
    modelProblems(baseModel({ sounds: { melodic: [], rhythm: [{ name: 'Kit', program: 0, noteMap: 'nope' }] } })),
    'sounds.rhythm[0].noteMap',
    'unknown drum map "nope", this model has: none; built in: general-midi',
  );
  const noRhythm = { channels: { melodic: [1], rhythm: [] } };
  assertProblem(modelProblems(baseModel({ ...noRhythm, drumMaps: [mapOf('a')] })), 'drumMaps', 'the model has no rhythm channel');
  assertProblem(modelProblems(baseModel({ ...noRhythm, drumMap: 'general-midi' })), 'drumMap', 'the model has no rhythm channel');
  assertProblem(
    modelProblems(baseModel({ sounds: { melodic: [{ name: 'Tone', program: 0, noteMap: 'general-midi' }], rhythm: [] } })),
    'sounds.melodic[0].noteMap',
    'unknown field',
  );
});

test('drum maps: the limits are 8 maps, 128 notes and 40 characters', () => {
  hasProblemAt(modelProblems(baseModel({ drumMaps: Array.from({ length: 9 }, (_, index) => mapOf(`m${index}`)) })), 'drumMaps');
  const long = Array.from({ length: 129 }, (_, index) => ({ note: index % 128, name: `Drum ${index}` }));
  hasProblemAt(modelProblems(baseModel({ drumMaps: [mapOf('a', long)] })), 'drumMaps[0].notes');
  hasProblemAt(modelProblems(baseModel({ drumMaps: [mapOf('a', [{ note: 36, name: 'x'.repeat(41) }])] })), 'drumMaps[0].notes[0].name');
  hasProblemAt(modelProblems(baseModel({ drumMaps: [{ ...mapOf('a'), name: 'x'.repeat(41) }] })), 'drumMaps[0].name');
  assert.equal(instruments.parseModel(baseModel({ drumMaps: Array.from({ length: 8 }, (_, index) => mapOf(`m${index}`)), drumMap: 'm0' })).ok, true);
  const full = Array.from({ length: 128 }, (_, index) => ({ note: index, name: 'x'.repeat(40) }));
  assert.equal(instruments.parseModel(baseModel({ drumMaps: [mapOf('a', full)] })).ok, true);
});

test('drum maps: the fixtures and the shipped models parse', () => {
  assert.equal(instruments.parseModel(bankDrumsModel()).ok, true);
  assert.equal(instruments.parseModel(gmDrumsModel()).ok, true);
  for (const id of ['mt32', 'sc55']) assert.equal(instruments.parseModel(shippedModel(id)).ok, true, id);
});

test('the midi-rig message carries the resolved maps, and a rhythm sound copies only its own keys', (t) => {
  const files = {
    'instruments.json': rigFile(
      entry({ id: 'drums', model: 'bankdrums', port: 'Port D' }),
      entry({ id: 'gm', model: 'gmdrums', port: 'Port G' }),
      entry({ id: 'sc55', model: 'sc55', port: 'Port B' }),
      entry({ id: 'mt32', model: 'mt32', port: 'Port A' }),
    ),
    'models/bankdrums.json': bankDrumsModel(),
    'models/gmdrums.json': gmDrumsModel(),
  };
  const message = instruments.rigMessage(readRig(t, files));
  const byId = Object.fromEntries(message.instruments.map((instrument) => [instrument.id, instrument]));
  assert.deepEqual(byId.drums.drumMaps.map((map) => map.id), ['general-midi']);
  assert.equal(byId.drums.drumMap, 'general-midi');
  assert.deepEqual(byId.gm.drumMaps.map((map) => map.id), ['general-midi']);
  assert.deepEqual(byId.sc55.drumMaps.map((map) => map.id), ['gs-standard', 'gs-orchestra', 'gs-sfx', 'cm-64-32l']);
  assert.equal(byId.sc55.drumMap, 'gs-standard');
  assert.deepEqual(byId.mt32.drumMaps.map((map) => map.id), ['mt32-rhythm']);
  assert.deepEqual(byId.drums.sounds.rhythm[2], { name: 'Kit C', program: 3, bank: { msb: 86, lsb: 65 }, noteMap: null });
  assert.deepEqual(byId.sc55.sounds.rhythm[0], { name: 'Standard Set', program: 0 });
  assert.deepEqual(byId.sc55.sounds.rhythm[7], { name: 'Orchestra Set', program: 48, noteMap: 'gs-orchestra' });
});

// What Claude reads about drum maps: which map applies to which kit, the notes, and what is unknown.

const DRUM_OPTIONS = { connection: () => 'unknown', shipped: [], dataDirText: 'the data folder' };
const ownMap = mapOf('own-a', [{ note: 36, name: 'First' }, { note: 40, name: 'Mid' }, { note: 42, name: 'Last' }]);

function drumReplyFiles() {
  const kit = (name, noteMap) => ({ name, program: 0, noteMap });
  return {
    'instruments.json': rigFile(
      entry({ id: 'sc55', model: 'sc55', port: 'Port B' }),
      entry({ id: 'drumbank', model: 'bankdrums', port: 'Port D' }),
      entry({ id: 'plain', model: 'mt32', port: 'Port A' }),
      entry({ id: 'gm', model: 'gmdrums', port: 'Port G' }),
      entry({ id: 'nomap', model: 'nomap', port: 'Port N' }),
      entry({ id: 'ownonly', model: 'ownonly', port: 'Port O' }),
      entry({ id: 'manykits', model: 'manykits', port: 'Port M' }),
      entry({ id: 'tones', model: 'tones', port: 'Port T', channels: [1] }),
    ),
    'models/bankdrums.json': bankDrumsModel(),
    'models/gmdrums.json': gmDrumsModel(),
    'models/nomap.json': baseModel({ id: 'nomap' }),
    'models/ownonly.json': baseModel({ id: 'ownonly', drumMaps: [ownMap], sounds: { melodic: [], rhythm: [kit('Kit X', 'own-a')] } }),
    'models/manykits.json': baseModel({
      id: 'manykits',
      drumMaps: [ownMap, mapOf('own-b')],
      drumMap: 'own-b',
      sounds: { melodic: [], rhythm: ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'].map((name) => kit(name, 'own-a')) },
    }),
    'models/tones.json': baseModel({ id: 'tones', channels: { melodic: [1], rhythm: [] } }),
  };
}

test('get_midi_instruments gives one Drum map line per instrument with a rhythm channel, saying which kits differ', (t) => {
  const state = readRig(t, drumReplyFiles());
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const text = instruments.describeRig(state, DRUM_OPTIONS);
  const lines = text.split('\n');
  const drumLines = lines.filter((line) => line.startsWith('  Drum map:'));
  assert.deepEqual(drumLines, [
    '  Drum map: "Roland GS Standard" (61 notes) for kits without their own map; 3 kits have their own map (Orchestra Set, SFX Set, CM-64/32L Set). get_midi_instruments with instrument "sc55" lists the notes.',
    '  Drum map: "General MIDI" (47 notes) for kits without their own map; no map is known for 1 kit (Kit C). get_midi_instruments with instrument "drumbank" lists the notes.',
    '  Drum map: "Roland MT-32 Rhythm" (34 notes). get_midi_instruments with instrument "plain" lists the notes.',
    '  Drum map: "General MIDI" (47 notes). get_midi_instruments with instrument "gm" lists the notes.',
    '  Drum map: unknown. Drum notes are numbers only.',
    '  Drum map: unknown for kits without their own map; 1 kit has its own map (Kit X). get_midi_instruments with instrument "ownonly" lists the notes.',
    '  Drum map: "Map own-b" (2 notes) for kits without their own map; 7 kits have their own map (K1, K2, K3, K4, K5, and 2 more). get_midi_instruments with instrument "manykits" lists the notes.',
  ]);
  for (const line of drumLines) assert.equal(lines[lines.indexOf(line) - 1].startsWith('  Rhythm:'), true, 'the Drum map line follows the Rhythm line');
  const tonesAt = lines.findIndex((line) => line.startsWith('- tones:'));
  assert.ok(!lines.slice(tonesAt, tonesAt + 8).some((line) => line.startsWith('  Drum map:')), 'an instrument with no rhythm channel has no Drum map line');
  assert.ok(text.endsWith("One instrument's full sound list: get_midi_instruments with instrument set to its id."));
});

test('get_midi_instruments with an instrument lists each map once with its kits, and says where no map is known', (t) => {
  const state = readRig(t, drumReplyFiles());
  const sc55 = instruments.describeInstrument(state, 'sc55', DRUM_OPTIONS).split('\n');
  const kitEnd = sc55.indexOf('127 CM-64/32L Set');
  assert.equal(sc55[kitEnd + 1], '');
  const mapLines = sc55.slice(kitEnd + 2);
  assert.equal(mapLines.length, 4, mapLines.join('\n'));
  assert.ok(mapLines[0].startsWith('Drum map "Roland GS Standard" (61 notes), for kits without their own map: 27 High Q, 28 Slap, '), mapLines[0]);
  assert.ok(mapLines[0].endsWith(', 87 Open Surdo'), mapLines[0]);
  assert.ok(mapLines[1].startsWith('Drum map "Roland GS Orchestra" (62 notes), for Orchestra Set: 27 Closed Hi-Hat, '), mapLines[1]);
  assert.ok(mapLines[2].startsWith('Drum map "Roland GS SFX" (46 notes), for SFX Set: 39 '), mapLines[2]);
  assert.ok(mapLines[3].startsWith('Drum map "Roland CM-64/32L" (67 notes), for CM-64/32L Set: 35 '), mapLines[3]);

  const drumbank = instruments.describeInstrument(state, 'drumbank', DRUM_OPTIONS).split('\n');
  assert.ok(drumbank.some((line) => line.startsWith('Drum map "General MIDI" (47 notes), for kits without their own map: 35 Acoustic Bass Drum, ')), drumbank.join('\n'));
  assert.equal(drumbank[drumbank.length - 1], 'No note map is known for: Kit C. Notes there are numbers only.');

  const gm = instruments.describeInstrument(state, 'gm', DRUM_OPTIONS).split('\n');
  assert.ok(gm[gm.length - 1].startsWith('Drum map "General MIDI" (47 notes): 35 Acoustic Bass Drum, '), gm[gm.length - 1]);
  assert.ok(gm[gm.length - 1].endsWith(', 81 Open Triangle'));

  const nomap = instruments.describeInstrument(state, 'nomap', DRUM_OPTIONS).split('\n');
  assert.equal(nomap[nomap.length - 1], 'No note map is known for this instrument. Drum notes are numbers only.');

  const ownonly = instruments.describeInstrument(state, 'ownonly', DRUM_OPTIONS).split('\n');
  assert.ok(ownonly.some((line) => line.startsWith('Drum map "Map own-a" (3 notes), for Kit X: 36 First, 40 Mid, 42 Last')), ownonly.join('\n'));
  assert.equal(ownonly[ownonly.length - 1], 'No note map is known when the code names no kit. Notes there are numbers only.');

  const tones = instruments.describeInstrument(state, 'tones', DRUM_OPTIONS);
  assert.ok(!tones.includes('Drum map') && !tones.includes('No note map'), tones);
});

// The kits of a catalog resolve like the kits of the model, in the text Claude reads as on the page.
function catalogKitFiles() {
  const kit = (name, extra = {}) => ({ name, program: 4, bank: { msb: 86, lsb: 66 }, ...extra });
  const base = { ...bankDrumsModel(), drumMaps: [ownMap] };
  return {
    'instruments.json': rigFile(
      entry({ id: 'catkits', model: 'catkits', port: 'Port K' }),
      entry({ id: 'catonly', model: 'catonly', port: 'Port L' }),
    ),
    // A General MIDI default (and the model kit with no known map of the fixture); one catalog kit with no known map, one that names a map no model kit uses.
    'models/catkits.json': { ...base, id: 'catkits' },
    'catalogs/catkits.json': catalogOf('catkits', [], { kits: [kit('Cat None', { noteMap: null }), kit('Cat Own', { noteMap: 'own-a' }), kit('Cat Plain')] }),
    // No default map and no kit in the model: only catalog kits name a map.
    'models/catonly.json': { ...base, id: 'catonly', drumMap: undefined, sounds: { melodic: base.sounds.melodic, rhythm: [] } },
    'catalogs/catonly.json': catalogOf('catonly', [], { kits: [kit('Cat Own', { noteMap: 'own-a' })] }),
  };
}

test('get_midi_instruments counts the drum map facts of catalog kits in the Drum map line', (t) => {
  const state = readRig(t, catalogKitFiles());
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const lines = instruments.describeRig(state, DRUM_OPTIONS).split('\n');
  assert.deepEqual(
    lines.filter((line) => line.startsWith('  Drum map:')),
    [
      '  Drum map: "General MIDI" (47 notes) for kits without their own map; 1 kit has its own map (Cat Own); no map is known for 2 kits (Kit C, Cat None). get_midi_instruments with instrument "catkits" lists the notes.',
      '  Drum map: unknown for kits without their own map; 1 kit has its own map (Cat Own). get_midi_instruments with instrument "catonly" lists the notes.',
    ],
  );
});

test('get_midi_instruments with an instrument lists the maps and the unknown maps of catalog kits', (t) => {
  const state = readRig(t, catalogKitFiles());
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const catkits = instruments.describeInstrument(state, 'catkits', DRUM_OPTIONS).split('\n');
  assert.ok(catkits.some((line) => line.startsWith('Drum map "General MIDI" (47 notes), for kits without their own map: 35 ')), catkits.join('\n'));
  assert.ok(catkits.some((line) => line.startsWith('Drum map "Map own-a" (3 notes), for Cat Own: 36 First, 40 Mid, 42 Last')), catkits.join('\n'));
  assert.equal(catkits[catkits.length - 3], 'No note map is known for: Kit C, Cat None. Notes there are numbers only.', catkits.join('\n'));

  const catonly = instruments.describeInstrument(state, 'catonly', DRUM_OPTIONS).split('\n');
  assert.ok(catonly.some((line) => line.startsWith('Drum map "Map own-a" (3 notes), for Cat Own: 36 First, 40 Mid, 42 Last')), catonly.join('\n'));
  const text = catonly.join('\n');
  assert.ok(!text.includes('No note map is known for this instrument'), text);
  assert.ok(text.includes('No note map is known when the code names no kit. Notes there are numbers only.'), text);
  for (const reply of [instruments.describeRig(state, DRUM_OPTIONS), ...catkits, ...catonly]) {
    assert.deepEqual(findWords(reply, TINT_WORDS), [], reply);
    assert.deepEqual(findWords(reply, STEERING_WORDS), [], reply);
  }
});

// Five SC-55 kits take the Standard names by judgment; Claude is told plainly that a few keys may differ.
test('get_midi_instruments tells that the five voice-variant SC-55 kits follow the Standard names and may differ at a few keys', (t) => {
  const state = readRig(t, { 'instruments.json': rigFile(entry({ id: 'sc55', model: 'sc55', port: 'Port B' })) });
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const text = instruments.describeRig(state, DRUM_OPTIONS);
  const note = text.split('\n').find((line) => line.startsWith('  Notes:')) ?? '';
  for (const kit of ['Room', 'Power', 'Electronic', 'TR-808', 'Brush']) assert.ok(note.includes(kit), kit);
  assert.ok(note.includes("under the standard map's names; at a few keys those sets play a different voice than the name shows"), note);
  const [sc55] = state.instruments;
  for (const name of ['Room Set', 'Power Set', 'Electronic Set', 'TR-808 Set', 'Brush Set']) {
    assert.equal(sc55.model.sounds.rhythm.find((kit) => kit.name === name).noteMap, undefined, `${name} keeps the model map`);
  }
  assert.deepEqual(findWords(note, TINT_WORDS), [], note);
  assert.deepEqual(findWords(note, STEERING_WORDS), [], note);
});

test('the drum replies of the fixtures carry no tint or steering word', (t) => {
  const files = drumReplyFiles();
  files['instruments.json'] = rigFile(
    entry({ id: 'drumbank', model: 'bankdrums', port: 'Port D' }),
    entry({ id: 'gm', model: 'gmdrums', port: 'Port G' }),
    entry({ id: 'nomap', model: 'nomap', port: 'Port N' }),
    entry({ id: 'ownonly', model: 'ownonly', port: 'Port O' }),
  );
  const state = readRig(t, files);
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const texts = [instruments.describeRig(state, DRUM_OPTIONS), ...state.instruments.map((instrument) => instruments.describeInstrument(state, instrument.id, DRUM_OPTIONS))];
  for (const text of texts) {
    assert.deepEqual(findWords(text, TINT_WORDS), [], text);
    assert.deepEqual(findWords(text, STEERING_WORDS), [], text);
  }
});

test('the draft summary lists each map, the default map, the kits with their own map and the kits with no known map', () => {
  const kits = [{ name: 'Kit X', program: 0, noteMap: 'own-a' }, { name: 'Kit Y', program: 1 }, { name: 'Kit C', program: 2, noteMap: null }];
  const lines = instruments.summarizeDraft(draftOf({ drumMaps: [ownMap, mapOf('own-b')], drumMap: 'general-midi', sounds: { melodic: [], rhythm: kits } })).split('\n');
  const at = lines.indexOf('Rhythm kits: chosen by program change alone.');
  assert.deepEqual(lines.slice(at + 1, at + 6), [
    'Drum map "own-a": "Map own-a", 3 notes, from 36 First to 42 Last.',
    'Drum map "own-b": "Map own-b", 2 notes, from 36 First to 38 Second.',
    'Default drum map: general-midi (built in).',
    'Kits with their own map: Kit X (own-a).',
    'Kits with no known map: Kit C.',
  ]);
  const own = instruments.summarizeDraft(draftOf({ drumMaps: [ownMap], drumMap: 'own-a', sounds: { melodic: [], rhythm: kits } })).split('\n');
  assert.ok(own.includes('Default drum map: own-a.'), own.join('\n'));
  assert.ok(!own.some((line) => line.startsWith('Kits with their own map')), 'a kit that names the default map has no map of its own');
  const builtIn = instruments.summarizeDraft(draftOf({ drumMap: 'general-midi' })).split('\n');
  assert.ok(builtIn.includes('Default drum map: general-midi (built in).'), builtIn.join('\n'));
  const none = instruments.summarizeDraft(draftOf()).split('\n');
  assert.ok(none.includes('Default drum map: none, so kits without their own map have no known map.'), none.join('\n'));
  assert.ok(none.includes('Kits with no known map: Kit A.') && !none.some((line) => line.startsWith('Kits with their own map')), none.join('\n'));
  const noRhythm = instruments.summarizeDraft(draftOf({ channels: { melodic: [1, 2], rhythm: [] }, sounds: { melodic: [{ name: 'Only', program: 9 }], rhythm: [] } }));
  assert.ok(!/drum map/i.test(noRhythm), noRhythm);
});

// A model can say its rhythm channels take a bank; absent means off and every earlier model loads.

test('rhythmBank: an opted-in fixture parses, the shipped models parse without the field, and a bad value names its field', () => {
  assert.equal(instruments.parseModel(bankDrumsModel()).ok, true);
  for (const id of ['mt32', 'sc55']) {
    const parsed = instruments.parseModel(shippedModel(id));
    assert.equal(parsed.ok, true, id);
    assert.equal(parsed.model.rhythmBank, undefined, id);
  }
  const problems = modelProblems(baseModel({ rhythmBank: 'yes' }));
  assert.ok(problems.some((problem) => problem.field === 'rhythmBank'), JSON.stringify(problems));
});

test('rhythmBank: every refusal names its field and its exact reason', () => {
  assertProblem(
    modelProblems(baseModel({ rhythmBank: true, bankSelect: 'none', sounds: { melodic: [], rhythm: [] } })),
    'rhythmBank',
    'needs a bank select, and bankSelect is none',
  );
  assertProblem(
    modelProblems(baseModel({ rhythmBank: true, bankSelect: 'msb', channels: { melodic: [1], rhythm: [] }, sounds: { melodic: [], rhythm: [] } })),
    'rhythmBank',
    'the model has no rhythm channel',
  );
  const kit = { name: 'Kit', program: 0, bank: { msb: 1 } };
  for (const rhythmBank of [undefined, false]) {
    assertProblem(
      modelProblems(baseModel({ rhythmBank, bankSelect: 'msb', sounds: { melodic: [], rhythm: [kit] } })),
      'sounds.rhythm[0].bank',
      'rhythm sounds take no bank unless the model sets rhythmBank to true',
    );
  }
  assertProblem(
    modelProblems(baseModel({ rhythmBank: true, bankSelect: 'msb', sounds: { melodic: [], rhythm: [kit, { name: 'Kit 2', program: 1 }] } })),
    'sounds.rhythm[1].bank',
    'required: the rhythm channels of this model take a bank',
  );
  assertProblem(
    modelProblems(baseModel({ rhythmBank: true, bankSelect: 'msb', sounds: { melodic: [], rhythm: [{ name: 'Kit', program: 0, bank: { msb: 1, lsb: 2 } }] } })),
    'sounds.rhythm[0].bank.lsb',
    'this model takes a bank MSB only',
  );
  const ok = instruments.parseModel(baseModel({ rhythmBank: true, bankSelect: 'msb', sounds: { melodic: [], rhythm: [kit] } }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('the midi-rig message carries rhythmBank: true for an opted-in model and false for the shipped ones', (t) => {
  const files = {
    'instruments.json': rigFile(entry({ id: 'drums', model: 'bankdrums', port: 'Port D', channels: [5] }), entry({ id: 'plain', model: 'mt32', port: 'Port B' })),
    'models/bankdrums.json': bankDrumsModel(),
  };
  const message = instruments.rigMessage(readRig(t, files));
  assert.deepEqual(
    message.instruments.map((instrument) => [instrument.id, instrument.rhythmBank]),
    [['drums', true], ['plain', false]],
  );
});

test('get_midi_instruments says how a kit goes out, per instrument with a rhythm channel, and the draft summary says it too', (t) => {
  const files = {
    'instruments.json': rigFile(
      entry({ id: 'drums', model: 'bankdrums', port: 'Port D' }),
      entry({ id: 'plain', model: 'mt32', port: 'Port B' }),
      entry({ id: 'tones', model: 'synth', port: 'Port C', channels: [1] }),
    ),
    'models/bankdrums.json': bankDrumsModel(),
    'models/synth.json': baseModel(),
  };
  const state = readRig(t, files);
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const text = instruments.describeRig(state, { connection: () => 'unknown', shipped: [], dataDirText: 'the data folder' });
  const lines = text.split('\n');
  const start = 'Rhythm: kits are chosen like sounds, by name with the sound option on a rhythm channel; ';
  const bankLine = lines.findIndex((line) => line === '  Bank select: CC0 then CC32.');
  assert.equal(lines[bankLine + 1], `  ${start}a kit goes out as its bank select (CC0 then CC32) and its program change.`);
  const alone = `  ${start}a kit goes out as a program change alone, with no bank select.`;
  assert.equal(lines.filter((line) => line === alone).length, 1, 'the shipped MT-32 only');
  assert.equal(lines.filter((line) => line.startsWith('  Rhythm:')).length, 2, 'the instrument with no rhythm channel has no Rhythm line');
  const resetAt = lines.findIndex((line) => line.startsWith('  Reset when it connects:'));
  assert.ok(lines[resetAt + 1].startsWith('  Clock:'), 'the Clock line still follows the Reset line');
  assert.deepEqual(findWords(text, TINT_WORDS), [], text);
  assert.deepEqual(findWords(text, STEERING_WORDS), [], text);

  const opted = instruments.summarizeDraft(draftOf({ bankSelect: 'msb-lsb', rhythmBank: true, sounds: { melodic: [], rhythm: [{ name: 'Kit A', program: 0, bank: { msb: 1, lsb: 2 } }] } })).split('\n');
  assert.equal(opted[opted.findIndex((line) => line.startsWith('Bank select:')) + 1], 'Rhythm kits: chosen by bank select and program change.');
  assert.ok(instruments.summarizeDraft(draftOf()).split('\n').includes('Rhythm kits: chosen by program change alone.'));
  const noRhythm = instruments.summarizeDraft(draftOf({ channels: { melodic: [1, 2], rhythm: [] }, sounds: { melodic: [{ name: 'Only', program: 9 }], rhythm: [] } }));
  assert.ok(!noRhythm.includes('Rhythm kits:'), noRhythm);
});

// --- The user's on/off choice lives in instruments-state.json, read at every use ---

const twoInstruments = () => rigFile(entry({ id: 'mt32' }), entry({ id: 'sc55', model: 'sc55', port: 'Fake Synth B' }));
const enabledOf = (state) => Object.fromEntries(state.instruments.map((instrument) => [instrument.id, instrument.enabled]));
const HINT = '; delete the file to switch every instrument on';

test('without instruments-state.json every instrument is on, and the message carries enabled', (t) => {
  const state = readRig(t, { 'instruments.json': twoInstruments() });
  assert.deepEqual(enabledOf(state), { mt32: true, sc55: true });
  assert.deepEqual(instruments.rigMessage(state).instruments.map((instrument) => instrument.enabled), [true, true]);
});

test('instruments-state.json lists the instruments that are off; ids the file does not hold are ignored', (t) => {
  assert.deepEqual(enabledOf(readRig(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': { off: ['sc55'] } })), { mt32: true, sc55: false });
  assert.deepEqual(enabledOf(readRig(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': { off: ['gone'] } })), { mt32: true, sc55: true });
  assert.deepEqual(enabledOf(readRig(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': { off: [] } })), { mt32: true, sc55: true });
  const message = instruments.rigMessage(readRig(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': { off: ['mt32'] } }));
  assert.deepEqual(message.instruments.map((instrument) => [instrument.id, instrument.enabled]), [['mt32', false], ['sc55', true]]);
});

test('the state file is read at every read, so a change applies without a restart', (t) => {
  const dir = makeDir(t, { 'instruments.json': twoInstruments() });
  const rig = store(dir);
  assert.deepEqual(enabledOf(rig.read()), { mt32: true, sc55: true });
  instruments.writeRigState({ dataDir: dir, off: ['mt32'] });
  assert.deepEqual(enabledOf(rig.read()), { mt32: false, sc55: true });
  fs.rmSync(path.join(dir, instruments.RIG_STATE_FILE_NAME));
  assert.deepEqual(enabledOf(rig.read()), { mt32: true, sc55: true });
});

test('a state file that is not JSON, empty or off the schema makes the whole rig invalid, never "all on"', (t) => {
  const cases = [
    ['{', 'instruments-state.json', /^not valid JSON/],
    ['', 'instruments-state.json', /^the file is empty/],
    ['   \n', 'instruments-state.json', /^the file is empty/],
    [{ off: 'sc55' }, 'instruments-state.json:off', /./],
    [{ off: [], extra: 1 }, 'instruments-state.json:extra', /^unknown field/],
    [{ off: ['Bad Id'] }, 'instruments-state.json:off[0]', /./],
    [[], 'instruments-state.json', /./],
    ['null', 'instruments-state.json', /./],
    [{}, 'instruments-state.json:off', /./],
  ];
  for (const [content, field, reason] of cases) {
    const problems = problemsOf(readRig(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': content }));
    assert.equal(problems[0].field, field, JSON.stringify(problems));
    assert.match(problems[0].reason, reason, JSON.stringify(problems));
    assert.ok(problems[0].reason.endsWith(HINT), `the first reason ends with the way out: ${problems[0].reason}`);
  }
  assertInvalidWith(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': '' }, 'instruments-state.json', `the file is empty${HINT}`);
});

test('only the first problem of the state file carries the hint, and a state file that is a directory cannot be read', (t) => {
  const problems = problemsOf(readRig(t, { 'instruments.json': twoInstruments(), 'instruments-state.json': { off: ['Bad Id', 'Worse Id'], extra: 1 } }));
  const state = problems.filter((problem) => problem.field.startsWith('instruments-state.json'));
  assert.ok(state.length >= 3, JSON.stringify(state));
  assert.ok(state[0].reason.endsWith(HINT));
  assert.ok(state.slice(1).every((problem) => !problem.reason.includes('delete the file')), JSON.stringify(state));

  const dir = makeDir(t, { 'instruments.json': twoInstruments() });
  fs.mkdirSync(path.join(dir, 'instruments-state.json'));
  const [first] = problemsOf(store(dir).read());
  assert.equal(first.field, 'instruments-state.json');
  assert.ok(first.reason.startsWith('could not be read: ') && first.reason.endsWith(HINT), first.reason);
});

test('a valid instruments.json with an invalid state file is never valid, and the problems come in file order', (t) => {
  const problems = problemsOf(
    readRig(t, {
      'instruments.json': rigFile(entry({ id: 'mt32' }), entry({ id: 'sc55', model: 'nope', port: 'Fake Synth B' })),
      'instruments-state.json': '{',
      'models/broken.json': '{',
    }),
  );
  assert.deepEqual(problems.map((problem) => problem.field), ['instruments[1].model', 'instruments-state.json', 'models/broken.json']);
});

test('writeRigState writes the off list whole, leaves no temporary file, and replaces the old file', (t) => {
  const dir = makeDir(t);
  instruments.writeRigState({ dataDir: dir, off: ['sc55'] });
  assert.equal(fs.readFileSync(path.join(dir, 'instruments-state.json'), 'utf8'), '{\n  "off": [\n    "sc55"\n  ]\n}\n');
  assert.equal(fs.existsSync(path.join(dir, 'instruments-state.json.tmp')), false);
  instruments.writeRigState({ dataDir: dir, off: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'instruments-state.json'), 'utf8')), { off: [] });
  const fresh = path.join(dir, 'not-yet');
  instruments.writeRigState({ dataDir: fresh, off: ['mt32'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'instruments-state.json'), 'utf8')), { off: ['mt32'] });
});

test('a write that fails throws RigStateSaveError with an error code and no path, and the old file stays', (t) => {
  const dir = makeDir(t, { 'instruments-state.json': { off: ['mt32'] } });
  fs.mkdirSync(path.join(dir, 'instruments-state.json.tmp'));
  assert.throws(
    () => instruments.writeRigState({ dataDir: dir, off: ['sc55'] }),
    (err) => {
      assert.ok(err instanceof instruments.RigStateSaveError);
      assert.match(err.message, /^the choice could not be saved \(E[A-Z]+\); nothing changed$/);
      assert.ok(!err.message.includes(dir), 'no path in the message');
      assert.match(err.code, /^E[A-Z]+$/);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'instruments-state.json'), 'utf8')), { off: ['mt32'] });
});

// --- The user's on/off choice is said to Claude once per change ---

const twoRig = () => ({ 'instruments.json': twoInstruments() });
const stateFile = (dir) => path.join(dir, 'instruments-state.json');
const userLines = (session) => session.drainNotices().lines.filter((line) => line.startsWith('MIDI: the user'));
const AIMED = '.midi() code newly aimed at';

test('the first valid read says what is already off, once, and a second read says nothing', (t) => {
  const { session } = noteSession(t, { ...twoRig(), 'instruments-state.json': { off: ['sc55'] } });
  session.syncRig();
  assert.deepEqual(userLines(session), [`MIDI: the user has "sc55" switched off. Its notes are silent; ${AIMED} it is refused until the user switches it on.`]);
  session.syncRig();
  assert.deepEqual(userLines(session), []);
});

test('a change is said once: off, on, two at once, and no line when nothing changed', (t) => {
  const { dir, session } = noteSession(t, { ...twoRig(), 'instruments-state.json': { off: ['sc55'] } });
  session.syncRig();
  userLines(session);
  fs.writeFileSync(stateFile(dir), JSON.stringify({ off: ['mt32', 'sc55'] }));
  session.syncRig();
  assert.deepEqual(userLines(session), [`MIDI: the user switched "mt32" off. Its notes are silent; ${AIMED} it is refused until the user switches it on.`]);
  fs.writeFileSync(stateFile(dir), JSON.stringify({ off: [] }));
  session.syncRig();
  assert.deepEqual(userLines(session), ['MIDI: the user switched "mt32", "sc55" on; they are reset and set up again.']);
  fs.writeFileSync(stateFile(dir), JSON.stringify({ off: ['mt32', 'sc55'] }));
  session.syncRig();
  assert.deepEqual(userLines(session), [`MIDI: the user switched "mt32", "sc55" off. Their notes are silent; ${AIMED} them is refused until the user switches them on.`]);
  fs.writeFileSync(stateFile(dir), JSON.stringify({ off: ['mt32'] }));
  session.syncRig();
  assert.deepEqual(userLines(session), ['MIDI: the user switched "sc55" on; it is reset and set up again.']);
  session.syncRig();
  assert.deepEqual(userLines(session), []);
});

test('nothing off on the first read queues nothing', (t) => {
  const { session } = noteSession(t, twoRig());
  session.syncRig();
  assert.deepEqual(userLines(session), []);
  const empty = noteSession(t, { ...twoRig(), 'instruments-state.json': { off: [] } });
  empty.session.syncRig();
  assert.deepEqual(userLines(empty.session), []);
});

test('an invalid read in between keeps the last valid off set; a removed instrument is not said to be on; an absent file forgets the set', (t) => {
  const { dir, session } = noteSession(t, { ...twoRig(), 'instruments-state.json': { off: ['sc55'] } });
  session.syncRig();
  userLines(session);
  fs.writeFileSync(stateFile(dir), 'not json');
  session.syncRig();
  assert.deepEqual(userLines(session), [], 'an invalid state file says nothing about on and off');
  fs.writeFileSync(stateFile(dir), JSON.stringify({ off: ['sc55'] }));
  session.syncRig();
  assert.deepEqual(userLines(session), [], 'valid again with the same set says nothing about on and off');
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify(rigFile(entry({ id: 'mt32' }))));
  session.syncRig();
  assert.deepEqual(userLines(session), [], 'an instrument removed from the file while off is not said to be switched on');
  fs.rmSync(path.join(dir, 'instruments.json'));
  session.syncRig();
  userLines(session);
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify(twoInstruments()));
  session.syncRig();
  assert.deepEqual(userLines(session), [`MIDI: the user has "sc55" switched off. Its notes are silent; ${AIMED} it is refused until the user switches it on.`], 'after an absent file the next valid read is a first read');
});

test('the on/off lines never name instruments.json, and drain after the build notes and before the MIDI lines', (t) => {
  const { session } = noteSession(t, { ...twoRig(), 'instruments-state.json': { off: ['sc55'] } });
  session.syncRig();
  session.midi.update({
    type: 'midi-state',
    access: 'enabled',
    failure: null,
    usesMidi: true,
    triedMidi: true,
    outputs: ['Fake Synth A'],
    ports: [{ name: 'Nope', state: 'not-found', matches: [] }],
    noPort: null,
    unreadable: false,
    hidden: false,
    playing: true,
    events: [],
  });
  const lines = session.drainNotices().lines.filter((line) => line.startsWith('MIDI:'));
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[0].startsWith('MIDI: the user has "sc55" switched off.'), lines[0]);
  assert.ok(!lines[0].includes('instruments.json'));
  assert.ok(lines[1].includes('"Nope"'), lines[1]);
  for (const line of [instruments.rigOffAtStartLine(['a']), instruments.rigSwitchedOffLine(['a', 'b']), instruments.rigSwitchedOnLine(['a'])]) {
    assert.ok(!line.includes('instruments.json'), line);
    assert.deepEqual(findWords(line, TINT_WORDS), [], line);
  }
});
