import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import { RigStore, rigMessage, rolandChecksum } from '../dist/instruments.js';
import { MidiChannel } from '../dist/midi-state.js';
import { MAX_RIG_SETTINGS, parsePageMessage } from '../dist/protocol.js';
import { MAX_SETTING_NAMES, createMidiOut } from '../page/midi-out.js';
import { RIG_COPY, RIG_LIMITS, checkSetup, parseRigMessage } from '../page/midi-rig.js';
import {
  MAX_GUARDED_BYTES,
  SETTINGS_COPY,
  TEMPORARY_AREAS,
  buildSettings,
  guardOf,
  memoryWriteProblem,
  partOf,
  KNOWN_NRPNS,
  nrpnProblem,
  nrpnSet,
  readSentBytes,
  settingMessage,
  sysexProblem,
} from '../page/midi-settings.js';
import { fill, readMidiSetup } from '../page/midi-plan.js';
import { TINT_WORDS, findWords } from './tint-rules.js';
import { ccSynthModel, engineSynthCatalog, engineSynthModel, memorySynthModel, offsetSynthModel, otherRolandModel, timbreSynthModel, toneSynthCatalog, toneSynthModel } from './settings-fixtures.js';

// Settings sent from the code: the bytes a tone, part or scene setting becomes, the order they leave in, the
// refusals of a setting that cannot be sent safely, and the guard that keeps every system exclusive message
// to an instrument inside its temporary areas. All data is neutral (Tone Synth, Port T).

/** A native port that records what it was sent: the bytes, the timestamp and how many arguments the call had. */
class FakeNative {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.state = 'connected';
    this.sent = [];
  }
  send(data, ts) {
    this.sent.push({ data: Array.from(data), ts, argc: arguments.length });
  }
}

/** The webmidi Output of a native port: a one-argument send reaches the native with one argument. */
class FakeOutput {
  constructor(native) {
    this.native = native;
    this.id = native.id;
    this.name = native.name;
  }
  get _midiOutput() {
    return this.native;
  }
  send(data, options) {
    if (arguments.length < 2) {
      this.native.send(data);
      return this;
    }
    const time = options?.time;
    this.native.send(data, typeof time === 'number' && time >= 0 ? time : false);
    return this;
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

/** A data folder with the given models (by id), the given instruments and the given sound catalogs (by model id). */
function dataFolderOf(t, models, entries, catalogs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: entries }));
  fs.mkdirSync(path.join(dir, 'models'));
  for (const model of models) fs.writeFileSync(path.join(dir, 'models', `${model.id}.json`), JSON.stringify(model));
  if (catalogs.length > 0) fs.mkdirSync(path.join(dir, 'catalogs'));
  for (const catalog of catalogs) fs.writeFileSync(path.join(dir, 'catalogs', `${catalog.model}.json`), JSON.stringify(catalog));
  return dir;
}

/**
 * The tone synth on Port T read from a real data folder, as the page gets it after a trip over the wire. `change` may
 * edit the model first; `extra` adds instruments (a model, its port) after it.
 */
function toneSynthMessage(t, change = () => {}, extra = []) {
  const model = toneSynthModel();
  change(model);
  const models = [model, ...extra.map((entry) => entry.model)];
  const entries = [{ id: 'tonesynth', model: 'tonesynth', port: 'Port T' }, ...extra.map((entry) => ({ id: entry.model.id, model: entry.model.id, port: entry.port }))];
  const state = new RigStore({ dataDir: dataFolderOf(t, models, entries, [toneSynthCatalog()]) }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return JSON.parse(JSON.stringify(rigMessage(state)));
}

/** A page output layer over one fake port named `Port T`, holding the given rig message. */
function makeRig(message, { playing = true, port = 'Port T' } = {}) {
  const native = new FakeNative('id-0', port);
  const webMidi = {
    enabled: true,
    outputs: [new FakeOutput(native)],
    _disconnectedOutputs: [],
    interface: { outputs: new Map([[native.id, native]]) },
  };
  const errors = [];
  const published = [];
  const clock = makeClock();
  const out = createMidiOut({
    getWebMidi: () => webMidi,
    enableWebMidi: () => undefined,
    queryPermission: () => Promise.resolve('granted'),
    supportsMidi: () => true,
    parse,
    isPlaying: () => playing,
    isHidden: () => false,
    publish: (facts) => {
      published.push(facts);
      return true;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (text, err) => errors.push({ text, err }),
  });
  out.setRig(parseRigMessage(message));
  return { out, native, webMidi, errors, published, clock };
}

const bytesOf = (native) => native.sent.map((entry) => entry.data);

/** Prepares `source`, sends its setup and commits it, like a successful evaluation. Returns the plan. */
async function play(out, clock, source, advanceMs = 1000) {
  const plan = out.prepareSetup(source);
  assert.equal(plan.refusal, null, plan.refusal ?? '');
  const sending = plan.send();
  clock.advance(advanceMs);
  await sending;
  plan.commit();
  return plan;
}

const toneCode = `note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone', tone: { filterCutoff: 600 } })`;

// The data set for filterCutoff 600 on part 1, written byte by byte: the value 600 is 0x258, cut into four
// 4-bit pieces (0 2 5 8), after the address 02 10 00 4F; the checksum brings the sum to a multiple of 128.
const CUTOFF_600 = [0xf0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x65, 0x12, 0x02, 0x10, 0x00, 0x4f, 0x00, 0x02, 0x05, 0x08, 0x10, 0xf7];

test('end to end: a tone setting goes from the model file through the rig message to the port right after its program change', async (t) => {
  const message = toneSynthMessage(t);

  // The message of each row and the model ID reach the page and survive the wire.
  const settings = message.instruments[0].settings;
  assert.deepEqual(settings.rolandModel, [0, 0, 0, 101]);
  const cutoff = settings.tone.find((row) => row.name === 'filterCutoff');
  assert.deepEqual(cutoff.message, { kind: 'roland-dt1', address: [2, 16, 0, 79], size: 4 });
  const rig = parseRigMessage(message);
  assert.deepEqual(rig.instruments[0].settings.rolandModel, [0, 0, 0, 101]);
  assert.deepEqual(rig.instruments[0].settings.tone.find((row) => row.name === 'filterCutoff').message, cutoff.message);

  // The literal data set agrees with the server's checksum.
  assert.equal(rolandChecksum(CUTOFF_600.slice(8, 16)), CUTOFF_600[16]);

  // The whole path: the setup step puts the sound on the wire, then the data set, nothing stamped.
  const { out, native, errors, clock } = makeRig(message);
  await play(out, clock, toneCode);
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native), [[0xb0, 0x00, 0x61], [0xb0, 0x20, 0x40], [0xc0, 0x00], CUTOFF_600]);
  for (const entry of native.sent) {
    assert.equal(entry.argc, 1, 'sent without a timestamp');
    assert.equal(entry.ts, undefined);
  }
});

test('end to end: the same code evaluated again sends the data set again and no sound', async (t) => {
  const { out, native, errors, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, toneCode);
  assert.equal(native.sent.length, 4);
  await play(out, clock, toneCode);
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native).slice(4), [CUTOFF_600], 'every setting the code writes goes out at each evaluation, and the sound did not change');
});

// --- the bytes of every setting ---

const CLOSING_PLAYING = 'The previous music keeps playing.';

/** The rig the page keeps for models read from a real data folder (one instrument per model, port `Port <id>`). */
function pageRigOf(t, models, catalogs = []) {
  const entries = models.map((model) => ({ id: model.id, model: model.id, port: `Port ${model.id}` }));
  const state = new RigStore({ dataDir: dataFolderOf(t, models, entries, catalogs) }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return JSON.parse(JSON.stringify(rigMessage(state)));
}

/** buildSettings over a hand-made slot: the tone and part values written on `channel` and the scene values of the instrument. */
function builtFor(rig, { id = 'tonesynth', channel = 1, tone = {}, part = {}, scene = {} }) {
  const settings = new Map();
  if (Object.keys(tone).length + Object.keys(part).length > 0) {
    settings.set(`${id}:${channel}`, {
      instrument: id,
      port: `Port ${id}`,
      channel,
      sound: 'Own Tone',
      engine: null,
      tone: new Map(Object.entries(tone)),
      part: new Map(Object.entries(part)),
    });
  }
  const scenes = new Map();
  if (Object.keys(scene).length > 0) scenes.set(id, { instrument: id, port: `Port ${id}`, values: new Map(Object.entries(scene)) });
  return buildSettings({ rig, settings, scenes });
}

const dt1 = (address, data = [0x10], { model = [0, 0, 0, 0x65], device = 0x10, command = 0x12 } = {}) => [
  0xf0, 0x41, device, ...model, command, ...address, ...data, rolandChecksum([...address, ...data]), 0xf7,
];

const hexBytes = (text) => text.split(' ').map((part) => Number.parseInt(part, 16));

test('a size 1, size 2 and size 4 setting becomes the documented data set, with the part added where the level says', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [toneSynthModel()], [toneSynthCatalog()]));
  const bytes = (built) => built.lines === null ? [...built.slots.values()].flatMap((slot) => [...slot.toneBytes, ...slot.partBytes]).map((item) => item.bytes) : built.lines;
  const expected = (text) => [hexBytes(text)];
  // Part pan 40 on part 1, part 2 and the rhythm part 5.
  assert.deepEqual(bytes(builtFor(rig, { part: { pan: 40 } })), expected('F0 41 10 00 00 00 65 12 01 00 10 06 28 41 F7'));
  assert.deepEqual(bytes(builtFor(rig, { channel: 2, part: { pan: 40 } })), expected('F0 41 10 00 00 00 65 12 01 00 11 06 28 40 F7'));
  assert.deepEqual(bytes(builtFor(rig, { channel: 5, part: { pan: 40 } })), expected('F0 41 10 00 00 00 65 12 01 00 14 06 28 3D F7'));
  // Two bytes, and four bytes on part 4: the part adds to the second address byte of a tone.
  assert.deepEqual(bytes(builtFor(rig, { tone: { lfoOscDepth: 128 } })), expected('F0 41 10 00 00 00 65 12 02 10 00 0B 08 00 5B F7'));
  assert.deepEqual(bytes(builtFor(rig, { channel: 4, tone: { filterCutoff: 1023 } })), expected('F0 41 10 00 00 00 65 12 02 13 00 4F 00 03 0F 0F 7B F7'));
  // A scene setting uses its address as written, whatever the channel of its call, and there is one entry per instrument.
  const scene = builtFor(rig, { channel: 3, scene: { reverbLevel: 80 } });
  assert.equal(scene.lines, null);
  assert.deepEqual([...scene.scenes.keys()], ['tonesynth']);
  assert.deepEqual(scene.scenes.get('tonesynth').sceneBytes, [{ name: 'reverbLevel', bytes: hexBytes('F0 41 10 00 00 00 65 12 01 00 52 02 50 5B F7') }]);
  assert.equal(scene.slots.size, 0);
  // The slot keeps the part of its channel and the settings in written order.
  const both = builtFor(rig, { channel: 2, tone: { osc1Wave: 3, filterCutoff: 5 }, part: { pan: 1, level: 2 } });
  const slot = both.slots.get('tonesynth:2');
  assert.equal(slot.part, 2);
  assert.deepEqual(slot.toneBytes.map((item) => item.name), ['osc1Wave', 'filterCutoff']);
  assert.deepEqual(slot.partBytes.map((item) => item.name), ['pan', 'level']);
});

test('every row of the fixture, at every part its level allows and three values, equals the message the map rules give', (t) => {
  const model = toneSynthModel();
  const rig = parseRigMessage(pageRigOf(t, [toneSynthModel()], [toneSynthCatalog()]));
  const guard = guardOf(rig.instruments[0].settings);
  // The reference is written here from the map's rules: the value in 4-bit pieces for sizes 2 and 4, the part added to
  // the second address byte of a tone and to the third of a part setting, the Roland checksum of the server.
  const reference = (level, row, part, value) => {
    const address = hexBytes(row.message.address);
    if (level === 'tone') address[1] += part - 1;
    if (level === 'part') address[2] += part - 1;
    const size = row.message.size;
    const data = size === 1 ? [value] : Array.from({ length: size }, (_, index) => (value >> (4 * (size - 1 - index))) & 15);
    return [0xf0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x65, 0x12, ...address, ...data, rolandChecksum([...address, ...data]), 0xf7];
  };
  const parts = { tone: [1, 2, 3, 4], part: [1, 2, 3, 4, 5], scene: [1] };
  let checked = 0;
  for (const level of ['tone', 'part', 'scene']) {
    for (const row of model.settings[level]) {
      for (const part of parts[level]) {
        for (const value of [row.min, Math.floor((row.min + row.max) / 2), row.max]) {
          const built = builtFor(rig, level === 'scene' ? { scene: { [row.name]: value } } : { channel: part, [level]: { [row.name]: value } });
          assert.equal(built.lines, null, `${level} ${row.name}: ${built.lines}`);
          const actual = level === 'scene' ? built.scenes.get('tonesynth').sceneBytes[0].bytes : built.slots.get(`tonesynth:${part}`)[level === 'tone' ? 'toneBytes' : 'partBytes'][0].bytes;
          assert.deepEqual(actual, reference(level, row, part, value), `${level} ${row.name} part ${part} value ${value}`);
          assert.equal(memoryWriteProblem(guard, actual), null);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 5 * 4 * 3 + 2 * 5 * 3 + 2 * 3);
});

/** The settings the code writes on the engine synth, checked like the page does and built into data sets: { refusal, built }. */
function engineBuilt(t, code, change = () => {}) {
  const model = engineSynthModel();
  change(model);
  const rig = parseRigMessage(pageRigOf(t, [model], [engineSynthCatalog()]));
  const checked = checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });
  if (checked.refusal !== null) return { refusal: checked.refusal, built: null };
  return { refusal: null, built: buildSettings({ rig, settings: checked.settings, scenes: checked.scenes }) };
}

const engineCall = (channel, sound, tone) => `note("c3").midi('Port enginesynth', { midichannel: ${channel}, sound: '${sound}', tone: { ${tone} } })`;

/** The data sets of every tone setting built for the code, per slot key, as { name, bytes }. */
const toneSetsOf = (built) => Object.fromEntries([...built.slots].map(([key, slot]) => [key, slot.toneBytes]));

/** The data set of the map rules: model ID 00 00 00 65, the address, the data bytes, the server's checksum. */
const mapSet = (address, data) => [0xf0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x65, 0x12, ...address, ...data, rolandChecksum([...address, ...data]), 0xf7];

test('end to end: partial1Cutoff on a sound of the second engine becomes the documented data set at the part of its channel', (t) => {
  const { refusal, built } = engineBuilt(t, engineCall(2, 'Core Tone', 'partial1Cutoff: 300'));
  assert.equal(refusal, null);
  assert.equal(built.lines, null);
  // 300 is 0x12C, cut into four 4-bit pieces (0 1 2 C); the address 02 00 20 32 gets part 2 in its second byte.
  assert.deepEqual(toneSetsOf(built), { 'enginesynth:2': [{ name: 'partial1Cutoff', bytes: mapSet([0x02, 0x01, 0x20, 0x32], [0, 1, 2, 12]) }] });
});

test('a name described for two engines goes to the address of the engine of the sound, at the part of its channel', (t) => {
  const cutoffOn = (channel, sound, value) => engineBuilt(t, engineCall(channel, sound, `filterCutoff: ${value}`));
  const nibbles = [0, 2, 5, 8];
  // The model engine row sits at 02 10 00 4F, the vintage row at 02 50 01 42; both take the same code.
  assert.deepEqual(toneSetsOf(cutoffOn(1, 'Model Tone', 600).built), { 'enginesynth:1': [{ name: 'filterCutoff', bytes: mapSet([0x02, 0x10, 0x00, 0x4f], nibbles) }] });
  assert.deepEqual(toneSetsOf(cutoffOn(1, 'Vintage Tone', 600).built), { 'enginesynth:1': [{ name: 'filterCutoff', bytes: mapSet([0x02, 0x50, 0x01, 0x42], nibbles) }] });
  assert.deepEqual(toneSetsOf(cutoffOn(3, 'Vintage Tone', 600).built), { 'enginesynth:3': [{ name: 'filterCutoff', bytes: mapSet([0x02, 0x52, 0x01, 0x42], nibbles) }] });
});

test('filterResonance and toneCoarseTune follow the same rule: the row of the engine of the sound, the part of the channel in the address', (t) => {
  const resonanceOn = (channel, sound) => engineBuilt(t, engineCall(channel, sound, 'filterResonance: 100')).built;
  assert.deepEqual(toneSetsOf(resonanceOn(1, 'Model Tone')), { 'enginesynth:1': [{ name: 'filterResonance', bytes: mapSet([0x02, 0x10, 0x00, 0x53], [0, 0, 6, 4]) }] });
  assert.deepEqual(toneSetsOf(resonanceOn(2, 'Vintage Tone')), { 'enginesynth:2': [{ name: 'filterResonance', bytes: mapSet([0x02, 0x51, 0x01, 0x46], [0, 0, 6, 4]) }] });
  // One byte, 40 is 0x28: part 3 gives the second address byte 02.
  const tune = engineBuilt(t, engineCall(3, 'Core Tone', 'toneCoarseTune: 40')).built;
  assert.deepEqual(toneSetsOf(tune), { 'enginesynth:3': [{ name: 'toneCoarseTune', bytes: mapSet([0x02, 0x02, 0x00, 0x18], [40]) }] });
  // Two settings of one sound keep the order written.
  const both = engineBuilt(t, engineCall(4, 'Core Tone', 'toneCoarseTune: 64, partial1Cutoff: 1023')).built;
  assert.deepEqual(both.slots.get('enginesynth:4').toneBytes.map((item) => item.name), ['toneCoarseTune', 'partial1Cutoff']);
});

test('a setting of another engine is refused naming the engines of every row of its name, then the names the sound has', (t) => {
  const refused = (sound, name) => engineBuilt(t, engineCall(1, sound, `${name}: 100`)).refusal.split('\n');
  const cutoffOnCore = refused('Core Tone', 'filterCutoff');
  assert.equal(cutoffOnCore[0], '"filterCutoff" is a setting of Model Engine or Vintage Engine tones on enginesynth, and "Core Tone" is a Core Engine tone.');
  assert.equal(cutoffOnCore[1], 'Settings in tone for enginesynth on Core Engine tones: partial1Cutoff, toneCoarseTune.');
  assert.equal(cutoffOnCore.at(-1), CLOSING_PLAYING);
  const partialOnVintage = refused('Vintage Tone', 'partial1Cutoff');
  assert.equal(partialOnVintage[0], '"partial1Cutoff" is a setting of Core Engine tones on enginesynth, and "Vintage Tone" is a Vintage Engine tone.');
  assert.equal(partialOnVintage[1], 'Settings in tone for enginesynth on Vintage Engine tones: filterCutoff, filterResonance.');
  const tuneOnModel = refused('Model Tone', 'toneCoarseTune');
  assert.equal(tuneOnModel[0], '"toneCoarseTune" is a setting of Core Engine tones on enginesynth, and "Model Tone" is a Model Engine tone.');
  // Nothing is built for a refused call.
  assert.equal(engineBuilt(t, engineCall(1, 'Core Tone', 'filterCutoff: 100')).built, null);
});

test('a value is checked against the range of the row of the sound\'s engine', (t) => {
  const lowerVintage = (model) => void (model.settings.tone[5].max = 500);
  const resonance = (sound, value) => engineBuilt(t, engineCall(1, sound, `filterResonance: ${value}`), lowerVintage);
  assert.equal(resonance('Model Tone', 700).refusal, null, 'the model engine row goes to 1023');
  const refused = resonance('Vintage Tone', 700).refusal.split('\n');
  assert.equal(refused[0], 'Setting "filterResonance" in tone for enginesynth must be a whole number from 0 to 500.');
  assert.equal(resonance('Vintage Tone', 500).refusal, null);
  // The same value checked on the core engine's own range for its tune: 16 to 112.
  assert.equal(engineBuilt(t, engineCall(1, 'Core Tone', 'toneCoarseTune: 15')).refusal.split('\n')[0], 'Setting "toneCoarseTune" in tone for enginesynth must be a whole number from 16 to 112.');
  assert.equal(engineBuilt(t, engineCall(1, 'Core Tone', 'toneCoarseTune: 113')).refusal.split('\n')[0], 'Setting "toneCoarseTune" in tone for enginesynth must be a whole number from 16 to 112.');
});

test('every tone row of the engine synth, at parts 1 to 4 and three values, equals the message the map rules give and passes the memory check', (t) => {
  const model = engineSynthModel();
  const rig = parseRigMessage(pageRigOf(t, [engineSynthModel()], [engineSynthCatalog()]));
  const guard = guardOf(rig.instruments[0].settings);
  const engineOf = { model: 'Model Tone', core: 'Core Tone', vintage: 'Vintage Tone' };
  const reference = (row, part, value) => {
    const address = hexBytes(row.message.address);
    address[1] += part - 1;
    const size = row.message.size;
    const data = size === 1 ? [value] : Array.from({ length: size }, (_, index) => (value >> (4 * (size - 1 - index))) & 15);
    return mapSet(address, data);
  };
  let checked = 0;
  for (const row of model.settings.tone) {
    for (let part = 1; part <= 4; part++) {
      for (const value of [row.min, Math.floor((row.min + row.max) / 2), row.max]) {
        const { refusal, built } = engineBuilt(t, engineCall(part, engineOf[row.engines[0]], `${row.name}: ${value}`));
        assert.equal(refusal, null, `${row.name}: ${refusal}`);
        assert.equal(built.lines, null);
        const actual = built.slots.get(`enginesynth:${part}`).toneBytes[0].bytes;
        assert.deepEqual(actual, reference(row, part, value), `${row.engines[0]} ${row.name} part ${part} value ${value}`);
        assert.equal(memoryWriteProblem(guard, actual), null);
        checked++;
      }
    }
  }
  assert.equal(checked, 6 * 4 * 3);
});

test('a tone row of the engine synth on part 5 is refused before a byte is built, for every engine', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [engineSynthModel()], [engineSynthCatalog()]));
  const bytesOfFifth = (engine, tone) => {
    const settings = new Map([['enginesynth:5', { instrument: 'enginesynth', port: 'Port enginesynth', channel: 5, sound: 'Own Kit', engine, tone: new Map(Object.entries(tone)), part: new Map() }]]);
    return buildSettings({ rig, settings, scenes: new Map() });
  };
  for (const [engine, tone] of [['model', { filterCutoff: 5 }], ['core', { partial1Cutoff: 5 }], ['core', { toneCoarseTune: 40 }], ['vintage', { filterResonance: 5 }]]) {
    const built = bytesOfFifth(engine, tone);
    assert.deepEqual(built.lines, [fill(SETTINGS_COPY.partAddress, { setting: Object.keys(tone)[0], level: 'tone', id: 'enginesynth', part: 5, channel: 5 })], `${engine} ${JSON.stringify(tone)}`);
    assert.equal(built.slots.size, 0);
  }
});

test('a slot that has several rows for a name and no engine to choose by is refused with a line, never the first row', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [engineSynthModel()], [engineSynthCatalog()]));
  const slot = (engine) => new Map([['enginesynth:1', { instrument: 'enginesynth', port: 'Port enginesynth', channel: 1, sound: 'Model Tone', engine, tone: new Map([['filterCutoff', 5]]), part: new Map() }]]);
  const line = fill(SETTINGS_COPY.engineRow, { setting: 'filterCutoff', id: 'enginesynth', channel: 1 });
  for (const engine of [null, 'core']) {
    const built = buildSettings({ rig, settings: slot(engine), scenes: new Map() });
    assert.deepEqual(built.lines, [line], String(engine));
    assert.equal(built.slots.size, 0);
  }
});

test('two tracks on one channel, the first with part settings only, build the tone settings of the second for the engine of its sound, in either order', (t) => {
  const partOnly = `a: note("c3").midi('Port enginesynth', { midichannel: 1, part: { level: 100 } })`;
  const toneCall = `b: note("e3").midi('Port enginesynth', { midichannel: 1, sound: 'Vintage Tone', tone: { filterCutoff: 600 } })`;
  for (const code of [`${partOnly}\n${toneCall}`, `${toneCall}\n${partOnly}`]) {
    const { refusal, built } = engineBuilt(t, code);
    assert.equal(refusal, null);
    assert.equal(built.lines, null);
    assert.deepEqual(toneSetsOf(built), { 'enginesynth:1': [{ name: 'filterCutoff', bytes: mapSet([0x02, 0x50, 0x01, 0x42], [0, 2, 5, 8]) }] });
    assert.deepEqual(built.slots.get('enginesynth:1').partBytes.map((item) => item.name), ['level']);
  }
});

test('two tracks on one channel whose sounds are in different engines are refused with a line, and the music keeps playing', (t) => {
  // Two sounds of one program and bank that the rig places in different engines: the sound check lets them share the channel.
  const message = pageRigOf(t, [engineSynthModel()], [engineSynthCatalog()]);
  const melodic = message.instruments[0].sounds.melodic;
  const model = melodic.find((sound) => sound.name === 'Model Tone');
  melodic.push({ ...model, name: 'Twin Tone', engine: 'vintage' });
  const rig = parseRigMessage(message);
  const code = [
    `a: note("c3").midi('Port enginesynth', { midichannel: 1, sound: 'Model Tone', tone: { filterResonance: 100 } })`,
    `b: note("e3").midi('Port enginesynth', { midichannel: 1, sound: 'Twin Tone', tone: { filterCutoff: 600 } })`,
  ].join('\n');
  const checked = checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });
  assert.deepEqual(checked.refusal.split('\n'), [
    fill(RIG_COPY.engineConflict, { id: 'enginesynth', channel: 1, a: 'Model Engine', b: 'Vintage Engine' }),
    RIG_COPY.oneSoundPerChannel,
    CLOSING_PLAYING,
  ]);
  assert.equal(checked.settings.size, 0);
});

test('the part of a channel counts the model channels in order, and a channel the model lacks throws', () => {
  const instrument = {
    id: 'drumsynth',
    modelChannels: [
      { channel: 10, role: 'rhythm' },
      { channel: 2, role: 'melodic' },
      { channel: 1, role: 'melodic' },
      { channel: 4, role: 'melodic' },
      { channel: 3, role: 'melodic' },
    ],
  };
  assert.equal(partOf(instrument, 1), 1);
  assert.equal(partOf(instrument, 4), 4);
  assert.equal(partOf(instrument, 10), 5);
  assert.throws(() => partOf(instrument, 5), /Moontide: channel 5 is not a channel of the model of "drumsynth"\./);
});

test('guardOf knows the model ID byte for byte and nothing else', () => {
  assert.equal(guardOf({ rolandModel: [0, 0, 0, 101] }), TEMPORARY_AREAS[0]);
  assert.equal(guardOf({ rolandModel: [0, 0, 0, 100] }), null);
  assert.equal(guardOf({ rolandModel: [0, 0, 101] }), null);
  assert.equal(guardOf({ rolandModel: null }), null);
  assert.equal(guardOf(null), null);
  assert.ok(Object.isFrozen(TEMPORARY_AREAS) && Object.isFrozen(TEMPORARY_AREAS[0]));
});

// --- the offsets of a GS-style family, sent as NRPN ---

/** The offset synth on Port O read from a real data folder, as the page gets it after a trip over the wire. `change` may edit the model first. */
/**
 * The offset synth as the page gets it. `change` edits the model file; `after` edits the settings of the rig message, for a
 * description the server refuses when it loads, which the page still refuses on its own.
 */
function offsetSynthMessage(t, change = () => {}, after = () => {}) {
  const model = offsetSynthModel();
  change(model);
  const message = pageRigOf(t, [model]);
  after(message.instruments[0].settings);
  return message;
}

const offsetCall = (channel, part, sound = 'Own Tone') => `note("c3").midi('Port offsetsynth', { midichannel: ${channel}, sound: '${sound}', part: { ${part} } })`;

// The five messages of the offset cutoffOffset 90 on channel 3, written byte by byte from the manual's NRPN list: control 99 the
// MSB 01, control 98 the LSB 20 (hex), control 6 the value 90 (5A), then control 101 and control 100 at 127. No control 38.
const CUTOFF_OFFSET_90_CH3 = [0xb2, 0x63, 0x01, 0xb2, 0x62, 0x20, 0xb2, 0x06, 0x5a, 0xb2, 0x65, 0x7f, 0xb2, 0x64, 0x7f];

test('end to end: an offset goes from the model file through the rig message to the five documented channel messages', (t) => {
  const message = offsetSynthMessage(t);
  const settings = message.instruments[0].settings;
  assert.equal(settings.nrpnFamily, 'gs');
  assert.equal(settings.rolandModel, null);
  const rig = parseRigMessage(message);
  const checked = checkSetup({ read: readMidiSetup(offsetCall(3, 'cutoffOffset: 90'), { parse }), rig, outputs: [], playing: true });
  assert.equal(checked.refusal, null);
  const built = buildSettings({ rig, settings: checked.settings, scenes: checked.scenes });
  assert.equal(built.lines, null);
  assert.deepEqual(built.slots.get('offsetsynth:3').partBytes, [{ name: 'cutoffOffset', bytes: CUTOFF_OFFSET_90_CH3 }]);
  assert.deepEqual(built.slots.get('offsetsynth:3').toneBytes, []);
  // The builder agrees with the literal bytes, and every other offset of the table is the same five messages with its own LSB.
  assert.deepEqual(nrpnSet(3, 0x01, 0x20, 90), CUTOFF_OFFSET_90_CH3);
});

test('end to end: the offset leaves right after the bank select and program change of its channel, as one send of fifteen bytes, and again at each evaluation', async (t) => {
  const { out, native, errors, clock } = makeRig(offsetSynthMessage(t), { port: 'Port offsetsynth' });
  const code = [offsetCall(3, 'cutoffOffset: 90'), offsetCall(4, 'releaseOffset: 100')].join('\n');
  await play(out, clock, code);
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native), [
    [0xb2, 0x00, 0x08], [0xc2, 0x05], CUTOFF_OFFSET_90_CH3,
    [0xb3, 0x00, 0x08], [0xc3, 0x05], [0xb3, 0x63, 0x01, 0xb3, 0x62, 0x66, 0xb3, 0x06, 0x64, 0xb3, 0x65, 0x7f, 0xb3, 0x64, 0x7f],
  ]);
  for (const entry of native.sent) assert.equal(entry.argc, 1, 'sent without a timestamp');

  // Evaluated again: the offsets go out again and no sound.
  const mark = native.sent.length;
  await play(out, clock, code);
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native).slice(mark), [CUTOFF_OFFSET_90_CH3, [0xb3, 0x63, 0x01, 0xb3, 0x62, 0x66, 0xb3, 0x06, 0x64, 0xb3, 0x65, 0x7f, 0xb3, 0x64, 0x7f]]);
});

test('every offset of the family, at its lowest, neutral and highest value, is the five documented messages on any melodic channel', (t) => {
  const model = offsetSynthModel();
  const rig = parseRigMessage(pageRigOf(t, [offsetSynthModel()]));
  // The manual's table: MSB 01 with the LSB of each name; data 14 to 114, 64 means no change.
  const lsbOf = { vibratoRateOffset: 0x08, vibratoDepthOffset: 0x09, vibratoDelayOffset: 0x0a, cutoffOffset: 0x20, resonanceOffset: 0x21, attackOffset: 0x63, decayOffset: 0x64, releaseOffset: 0x66 };
  let checked = 0;
  for (const row of model.settings.part) {
    for (const channel of [1, 9, 11, 16]) {
      for (const value of [14, 64, 114]) {
        const built = builtFor(rig, { id: 'offsetsynth', channel, part: { [row.name]: value } });
        assert.equal(built.lines, null, `${row.name}: ${built.lines}`);
        const status = 0xb0 | (channel - 1);
        const expected = [status, 99, 1, status, 98, lsbOf[row.name], status, 6, value, status, 101, 127, status, 100, 127];
        assert.deepEqual(built.slots.get(`offsetsynth:${channel}`).partBytes[0].bytes, expected, `${row.name} channel ${channel} value ${value}`);
        assert.equal(nrpnProblem('gs', channel, expected), null);
        checked++;
      }
    }
  }
  assert.equal(checked, 8 * 4 * 3);
});

test('nrpnProblem accepts exactly the documented buffer and refuses every other', () => {
  const good = CUTOFF_OFFSET_90_CH3;
  assert.equal(nrpnProblem('gs', 3, good), null);
  const reason = (family, channel, bytes) => nrpnProblem(family, channel, bytes)?.reason;
  // Another channel on the buffer or in the question, a missing null, a value of 13 or 115, the pair 01 24.
  assert.equal(reason('gs', 4, good), 'nrpn');
  assert.equal(reason('gs', 3, good.slice(0, 12)), 'nrpn');
  assert.equal(reason('gs', 3, [...good.slice(0, 9), ...good.slice(12)]), 'nrpn', 'the first null is missing');
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 8 ? 13 : byte))), 'nrpn');
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 8 ? 115 : byte))), 'nrpn');
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 5 ? 0x24 : byte))), 'nrpn');
  assert.equal(nrpnProblem('gs', 3, good.map((byte, index) => (index === 8 ? 14 : byte))), null, 'the lowest value of the range');
  assert.equal(nrpnProblem('gs', 3, good.map((byte, index) => (index === 8 ? 114 : byte))), null, 'the highest value of the range');
  // A null that is not 127, a control that is out of order, one channel on one message and another on the next, and a byte of 128.
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 11 ? 126 : byte))), 'nrpn');
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 14 ? 0 : byte))), 'nrpn');
  assert.equal(reason('gs', 3, [...good.slice(3, 6), ...good.slice(0, 3), ...good.slice(6)]), 'nrpn', 'the LSB before the MSB');
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 9 ? 0xb3 : byte))), 'nrpn');
  assert.equal(reason('gs', 3, good.map((byte, index) => (index === 8 ? 128 : byte))), 'nrpn');
  assert.equal(reason('gs', 3, [...good.slice(0, 6), 0xb2, 0x26, 90, ...good.slice(9)]), 'nrpn', 'control 38 in place of control 6');
  assert.equal(reason('gs', 3, [...good, 0xb2, 0x06, 64]), 'nrpn', 'a sixth message');
  assert.equal(reason('gs', 3, [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]), 'nrpn');
  assert.equal(reason('gs', 3, []), 'nrpn');
  assert.equal(reason('gs', 3, 'not a list'), 'nrpn');
  // A family Moontide does not know, a missing one, and a name that is a property of every object.
  assert.equal(reason('xg', 3, good), 'nrpn');
  assert.equal(reason(null, 3, good), 'nrpn');
  assert.equal(reason(undefined, 3, good), 'nrpn');
  assert.equal(reason('toString', 3, good), 'nrpn');
  // Every pair the family lists passes, and the neighbours of each do not.
  for (const [msb, lsb] of KNOWN_NRPNS.gs.pairs) {
    assert.equal(nrpnProblem('gs', 3, nrpnSet(3, msb, lsb, 64)), null, `${msb} ${lsb}`);
    assert.equal(nrpnProblem('gs', 3, nrpnSet(3, msb, lsb + 1, 64))?.reason === 'nrpn', !KNOWN_NRPNS.gs.pairs.some(([m, l]) => m === msb && l === lsb + 1), `${msb} ${lsb + 1}`);
  }
  assert.equal(KNOWN_NRPNS.gs.pairs.length, 8);
  assert.ok(Object.isFrozen(KNOWN_NRPNS) && Object.isFrozen(KNOWN_NRPNS.gs) && Object.isFrozen(KNOWN_NRPNS.gs.pairs));
  assert.throws(() => nrpnSet(0, 1, 32, 64), /not a MIDI channel/);
  assert.throws(() => nrpnSet(17, 1, 32, 64), /not a MIDI channel/);
});

/** The refusal lines of the code `code` on the offset synth after `change` edited its model. */
function offsetRefusal(t, code, change = () => {}, after = () => {}) {
  const rig = parseRigMessage(offsetSynthMessage(t, change, after));
  const checked = checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });
  if (checked.refusal !== null) return { refusal: checked.refusal.split('\n'), built: null };
  const built = buildSettings({ rig, settings: checked.settings, scenes: checked.scenes });
  return { refusal: built.lines, built };
}

test('each refusal of an NRPN offset gives its own line, the memory check line where Moontide cannot check the pair, and builds nothing', (t) => {
  const cutoff = offsetCall(3, 'cutoffOffset: 90');
  // A pair the family does not list (01 24), an instrument that names no family, and a family Moontide does not know.
  const notListed = offsetRefusal(t, cutoff, (model) => void (model.settings.part[3].message.lsb = 0x24));
  assert.deepEqual(notListed.refusal, ['"cutoffOffset" of offsetsynth maps to NRPN 01 24, which is not a part offset of the gs family.', SETTINGS_COPY.temporaryOnly]);
  assert.equal(notListed.built.slots.size + notListed.built.scenes.size, 0);
  // The server refuses NRPN rows with no family, a range outside the family and an NRPN scene row when the model loads; the page
  // refuses them on its own too, for a rig message that holds them.
  const noFamily = (settings) => void (settings.nrpnFamily = null);
  const unknown = offsetRefusal(t, cutoff, undefined, noFamily);
  assert.deepEqual(unknown.refusal, ['"cutoffOffset" of offsetsynth is an NRPN in its model, and the model names no NRPN family Moontide knows.', SETTINGS_COPY.temporaryOnly]);
  // A value outside the family's range, which the row allows (0 to 127, or up to 16383): refused, not clamped, and never a throw.
  const wide = (settings) => void settings.part.forEach((row) => Object.assign(row, { min: 0, max: 127 }));
  for (const value of [0, 13, 115, 127]) {
    const range = offsetRefusal(t, offsetCall(3, `cutoffOffset: ${value}`), undefined, wide);
    assert.deepEqual(range.refusal, [`"cutoffOffset" of offsetsynth is an offset of the gs family and takes whole numbers from 14 to 114, not ${value}.`], String(value));
  }
  assert.equal(offsetRefusal(t, offsetCall(3, 'cutoffOffset: 14'), undefined, wide).refusal, null);
  assert.equal(offsetRefusal(t, offsetCall(3, 'cutoffOffset: 114'), undefined, wide).refusal, null);
  const wider = (settings) => void settings.part.forEach((row) => Object.assign(row, { min: 0, max: 16383 }));
  assert.deepEqual(offsetRefusal(t, offsetCall(3, 'cutoffOffset: 200'), undefined, wider).refusal, ['"cutoffOffset" of offsetsynth is an offset of the gs family and takes whole numbers from 14 to 114, not 200.']);
  // An offset on the rhythm channel of the model, and an NRPN row at scene level.
  const rhythm = offsetRefusal(t, offsetCall(10, 'cutoffOffset: 90', 'Own Kit'));
  assert.deepEqual(rhythm.refusal, ['"cutoffOffset" of offsetsynth is an offset of a melodic part, and channel 10 is a rhythm channel of its model.']);
  assert.equal(rhythm.built.slots.size, 0);
  const scene = offsetRefusal(t, `note("c3").midi('Port offsetsynth', { midichannel: 3, sound: 'Own Tone', scene: { reverbLevel: 64 } })`, undefined, (settings) => {
    settings.scene = [{ name: 'reverbLevel', min: 14, max: 114, message: { kind: 'nrpn', msb: 1, lsb: 0x20 } }];
  });
  assert.deepEqual(scene.refusal, ['"reverbLevel" of offsetsynth is an NRPN, which reaches one channel, so it is not a scene setting.']);
  // The order of refusals: the family before the pair, the pair before the range, the range before the rhythm channel.
  const all = offsetRefusal(t, offsetCall(10, 'cutoffOffset: 127', 'Own Kit'), (model) => void (model.settings.part[3].message.lsb = 0x24), wide);
  assert.match(all.refusal[0], /maps to NRPN 01 24/);
  const rangeAndRhythm = offsetRefusal(t, offsetCall(10, 'cutoffOffset: 127', 'Own Kit'), undefined, wide);
  assert.match(rangeAndRhythm.refusal[0], /takes whole numbers from 14 to 114, not 127/);
});

test('a tone row mapped to an NRPN of the family is built like a part row, and a control change row is still refused', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [offsetSynthModel()]));
  const message = { kind: 'nrpn', msb: 1, lsb: 0x21 };
  const guard = null;
  assert.deepEqual(settingMessage({ guard, level: 'tone', message, part: 1, value: 64, nrpnFamily: 'gs', channel: 2, rhythm: false }), { bytes: nrpnSet(2, 1, 0x21, 64) });
  assert.deepEqual(settingMessage({ guard, level: 'part', message, part: 1, value: 64, nrpnFamily: 'gs', channel: 10, rhythm: true }), { problem: { key: 'nrpnRhythm' } });
  assert.deepEqual(settingMessage({ guard, level: 'scene', message, part: 1, value: 64, nrpnFamily: 'gs', channel: 1, rhythm: false }), { problem: { key: 'nrpnScene' } });
  assert.deepEqual(settingMessage({ guard, level: 'part', message, part: 1, value: 64, nrpnFamily: 'xg', channel: 1, rhythm: false }), { problem: { key: 'nrpnUnknown' } });
  assert.deepEqual(settingMessage({ guard, level: 'part', message, part: 1, value: 64, nrpnFamily: 'toString', channel: 1, rhythm: false }), { problem: { key: 'nrpnUnknown' } });
  assert.deepEqual(settingMessage({ guard, level: 'part', message, part: 1, value: 64 }), { problem: { key: 'nrpnUnknown' } });
  // A value past what an NRPN carries is refused like any value outside the family's range; a value that is not a whole number is a fault.
  assert.deepEqual(settingMessage({ guard, level: 'part', message, part: 1, value: 128, nrpnFamily: 'gs' }), { problem: { key: 'nrpnRange', family: 'gs', min: 14, max: 114, value: 128 } });
  assert.deepEqual(settingMessage({ guard, level: 'part', message, part: 1, value: 16383, nrpnFamily: 'gs' }), { problem: { key: 'nrpnRange', family: 'gs', min: 14, max: 114, value: 16383 } });
  assert.throws(() => settingMessage({ guard, level: 'part', message, part: 1, value: 1.5, nrpnFamily: 'gs' }), /does not fit an NRPN/);
  // A data set is still not built for a family and a control change is still refused.
  assert.deepEqual(settingMessage({ guard, level: 'part', message: { kind: 'cc', cc: 7 }, part: 1, value: 1, nrpnFamily: 'gs' }), { problem: { key: 'kindNotSent', kind: 'a control change' } });
  assert.equal(rig.instruments[0].settings.nrpnFamily, 'gs');
});

test('a refused offset fails the evaluation with its lines and the closing line, nothing is sent, and the playing code stays', async (t) => {
  const refused = async (change, code, lines, after = () => {}) => {
    const { out, native, errors, clock } = makeRig(offsetSynthMessage(t, change, after), { port: 'Port offsetsynth' });
    await play(out, clock, `note("c3").midi('Port offsetsynth', { midichannel: 3, sound: 'Own Tone' })`);
    const mark = native.sent.length;
    const plan = out.prepareSetup(code);
    assert.deepEqual(plan.refusal.split('\n'), [...lines, CLOSING_PLAYING]);
    const sending = plan.send();
    clock.advance(1000);
    await sending;
    assert.deepEqual(native.sent.slice(mark), []);
    assert.deepEqual(errors, []);
  };
  await refused(
    () => {},
    offsetCall(3, 'cutoffOffset: 90'),
    ['"cutoffOffset" of offsetsynth is an NRPN in its model, and the model names no NRPN family Moontide knows.', SETTINGS_COPY.temporaryOnly],
    (settings) => void (settings.nrpnFamily = null),
  );
  await refused(() => {}, offsetCall(10, 'cutoffOffset: 90', 'Own Kit'), ['"cutoffOffset" of offsetsynth is an offset of a melodic part, and channel 10 is a rhythm channel of its model.']);
  await refused((model) => void (model.settings.part[3].message.lsb = 0x24), offsetCall(3, 'cutoffOffset: 90'), [
    '"cutoffOffset" of offsetsynth maps to NRPN 01 24, which is not a part offset of the gs family.',
    SETTINGS_COPY.temporaryOnly,
  ]);
});

test('the check over every message, on the offset synth: every message the page sends is a channel message and every NRPN set passes nrpnProblem', async (t) => {
  const model = offsetSynthModel();
  const rig = makeLiveRig(offsetSynthMessage(t, (m) => void (m.reset = { sysex: [{ kind: 'raw', bytes: hexOf(GS_RESET) }], waitMs: 20 })), { names: ['Port offsetsynth'] });
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const list = (pick) => model.settings.part.map((row) => `${row.name}: ${pick(row)}`).join(', ');
  const codeAt = (pick) =>
    [1, 2, 9, 11, 16].map((channel) => `m${channel}: note("c3").midi('Port offsetsynth', { midichannel: ${channel}, sound: 'Own Tone', part: { ${list(pick)} } })`).join('\n');
  await play(rig.out, rig.clock, codeAt((row) => row.min));
  await play(rig.out, rig.clock, codeAt((row) => row.max));
  await play(rig.out, rig.clock, `m1: note("c3").midi('Port offsetsynth', { midichannel: 1, sound: 'Own Tone' })`);
  // A reconnect brings the sound and the offsets of the code that plays back after the reset.
  rig.unplug('Port offsetsynth');
  rig.plug('Port offsetsynth');
  await rig.wait(500);
  await rig.wait(100);
  await rig.wait(1000);
  rig.out.panic();
  await rig.wait(1000);
  assert.deepEqual(rig.errors, []);

  const sent = rig.native('Port offsetsynth').sent.map((entry) => entry.data);
  const sets = sent.filter((data) => data.length === 15);
  assert.ok(sets.length >= 2 * 8 * 5, `the run sent many NRPN sets (${sets.length})`);
  for (const data of sent) {
    if (data.length === 15) assert.equal(nrpnProblem('gs', (data[0] & 0x0f) + 1, data), null, hexOf(data));
    else if (data[0] === 0xf0) assert.deepEqual(data, GS_RESET);
    else assert.ok(data[0] >= 0x80 && data[0] <= 0xef && data.length <= 3, hexOf(data));
  }
  // The code never wrote the value 64: no NRPN set of the run carries it.
  assert.equal(sets.some((data) => data[8] === 64), false);
  // The only code that sends an NRPN set is settingMessage: the offsets listed are the only data entries.
  assert.deepEqual(new Set(sets.map((data) => data[5])), new Set([0x08, 0x09, 0x0a, 0x20, 0x21, 0x63, 0x64, 0x66]));
});

// --- the settings that cannot be sent safely ---

/** The cc synth as the page gets it, from a server that let its NRPN row through with no NRPN family. */
function ccSynthNoFamily(t) {
  const message = pageRigOf(t, [ccSynthModel()]);
  message.instruments[0].settings.nrpnFamily = null;
  return parseRigMessage(message);
}

test('buildSettings refuses a control change or an NRPN row, naming its kind, and builds nothing', (t) => {
  const rig = ccSynthNoFamily(t);
  const cc = builtFor(rig, { id: 'ccsynth', tone: { filterCutoff: 60 } });
  assert.deepEqual(cc.lines, ['"filterCutoff" of ccsynth is a control change in its model, and Moontide sends only Roland data sets and the NRPN offsets it knows.']);
  assert.equal(cc.slots.size + cc.scenes.size, 0);
  // The NRPN row of this rig names no NRPN family, so it is refused for that, with the line about the memory check.
  const nrpn = builtFor(rig, { id: 'ccsynth', tone: { env1Attack: 60 } });
  assert.deepEqual(nrpn.lines, ['"env1Attack" of ccsynth is an NRPN in its model, and the model names no NRPN family Moontide knows.', SETTINGS_COPY.temporaryOnly]);
  assert.equal(nrpn.slots.size + nrpn.scenes.size, 0);
});

test('buildSettings refuses in code order: the first problem only, slots before scenes, tone before part', (t) => {
  const rig = ccSynthNoFamily(t);
  const lines = builtFor(rig, { id: 'ccsynth', tone: { env1Attack: 5, filterCutoff: 6 }, part: { level: 7 } }).lines;
  assert.equal(lines.length, 2, 'the first problem and the memory check line, not the problems after it');
  assert.match(lines[0], /^"env1Attack" of ccsynth is an NRPN/);
  const partFirst = builtFor(rig, { id: 'ccsynth', part: { level: 7 } }).lines;
  assert.match(partFirst[0], /^"level" of ccsynth is a control change/);
});

test('buildSettings refuses the data sets of a model ID it knows no temporary areas for, and says why twice', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [otherRolandModel()]));
  assert.deepEqual(builtFor(rig, { id: 'othersynth', part: { level: 90 } }).lines, [
    'Moontide does not know which addresses of othersynth are temporary, so it sends none of its settings.',
    "Moontide sends a setting only where it can check that nothing is written to the instrument's memory.",
  ]);
  const scene = builtFor(rig, { id: 'othersynth', scene: { reverbLevel: 90 } });
  assert.equal(scene.lines.length, 2);
  assert.equal(scene.slots.size + scene.scenes.size, 0);
});

test('buildSettings refuses an address outside the temporary scene and tones, with the address after the part is added', (t) => {
  const user = parseRigMessage(pageRigOf(t, [memorySynthModel()]));
  assert.deepEqual(builtFor(user, { id: 'memorysynth', part: { level: 90 } }).lines, [
    '"level" in part for memorysynth would write outside the temporary scene and tones of the instrument (address 50 00 10 05), so it is not sent.',
    "Moontide sends a setting only where it can check that nothing is written to the instrument's memory.",
  ]);
  // 01 01 xx xx is not the temporary scene (01 00 xx xx), the system block is not either, and a tone must start with 02.
  const rowAt = (level, name, address, size = 1) => {
    const model = memorySynthModel();
    model.settings = { rolandModel: '00 00 00 65', [level]: [{ name, min: 0, max: 127, message: { kind: 'roland-dt1', address, size } }] };
    return parseRigMessage(pageRigOf(t, [model]));
  };
  assert.match(builtFor(rowAt('part', 'level', '01 01 00 00'), { id: 'memorysynth', part: { level: 1 } }).lines[0], /\(address 01 01 00 00\)/);
  assert.match(builtFor(rowAt('scene', 'level', '00 00 00 15'), { id: 'memorysynth', scene: { level: 1 } }).lines[0], /\(address 00 00 00 15\)/);
  assert.match(builtFor(rowAt('tone', 'filterCutoff', '50 10 00 4F', 4), { id: 'memorysynth', tone: { filterCutoff: 1 } }).lines[0], /\(address 50 10 00 4F\)/);
  assert.match(builtFor(rowAt('tone', 'filterCutoff', '03 10 00 4F', 4), { id: 'memorysynth', tone: { filterCutoff: 1 } }).lines[0], /\(address 03 10 00 4F\)/);
});

test('buildSettings refuses a part whose address does not fit', (t) => {
  const model = toneSynthModel();
  model.settings.part[0].message.address = '01 00 7F 05';
  model.settings.tone[0].message.address = '02 7F 00 4F';
  const rig = parseRigMessage(pageRigOf(t, [model], [toneSynthCatalog()]));
  assert.equal(builtFor(rig, { channel: 1, part: { level: 5 } }).lines, null, 'part 1 adds nothing');
  assert.deepEqual(builtFor(rig, { channel: 2, part: { level: 5 } }).lines, ['"level" in part for tonesynth has no address for part 2 (channel 2).']);
  assert.deepEqual(builtFor(rig, { channel: 2, tone: { filterCutoff: 5 } }).lines, ['"filterCutoff" in tone for tonesynth has no address for part 2 (channel 2).']);
});

test('a tone setting on a part past the 4 parts with a temporary tone, or a part setting past part 5, is refused before a byte is built', () => {
  const guard = TEMPORARY_AREAS[0];
  const tone = { kind: 'roland-dt1', address: [0x02, 0x10, 0x00, 0x4f], size: 1 };
  const part = { kind: 'roland-dt1', address: [0x01, 0x00, 0x10, 0x05], size: 1 };
  assert.ok(settingMessage({ guard, level: 'tone', message: tone, part: 4, value: 1 }).bytes);
  assert.deepEqual(settingMessage({ guard, level: 'tone', message: tone, part: 5, value: 1 }), { problem: { key: 'partAddress' } });
  assert.ok(settingMessage({ guard, level: 'part', message: part, part: 5, value: 1 }).bytes);
  assert.deepEqual(settingMessage({ guard, level: 'part', message: part, part: 6, value: 1 }), { problem: { key: 'partAddress' } });
  // An address of neither 3 nor 4 bytes is a fault the reading of the rig already refuses; one of the other of the two lengths
  // is an address this instrument's data sets do not take.
  assert.throws(() => settingMessage({ guard, level: 'scene', message: { ...part, address: [0x01, 0x00] }, part: 1, value: 1 }), /must be 3 or 4 bytes/);
  assert.deepEqual(settingMessage({ guard, level: 'scene', message: { ...part, address: [0x01, 0x00, 0x52] }, part: 1, value: 1 }), { problem: { key: 'addressLength', length: 3, size: 4 } });
});

test('settingMessage throws for a value its size cannot carry, and for a missing guard answers with a problem', () => {
  const guard = TEMPORARY_AREAS[0];
  const message = { kind: 'roland-dt1', address: [1, 0, 16, 6], size: 1 };
  assert.throws(() => settingMessage({ guard, level: 'part', message, part: 1, value: 128 }), /does not fit a data set of 1 bytes/);
  assert.throws(() => settingMessage({ guard, level: 'part', message, part: 1, value: -1 }), /does not fit/);
  assert.throws(() => settingMessage({ guard, level: 'part', message, part: 1, value: 1.5 }), /does not fit/);
  assert.deepEqual(settingMessage({ guard: null, level: 'part', message, part: 1, value: 1 }), { problem: { key: 'unguarded' } });
  assert.deepEqual(settingMessage({ guard, level: 'part', message: { kind: 'cc', cc: 7 }, part: 1, value: 1 }), { problem: { key: 'kindNotSent', kind: 'a control change' } });
});

test('a refused setting fails the evaluation with its first line and the closing line, and nothing is sent', async (t) => {
  const { out, native, errors, clock } = makeRig(pageRigOf(t, [ccSynthModel()]), { port: 'Port ccsynth' });
  const plan = out.prepareSetup(`note("c3").midi('Port ccsynth', { midichannel: 1, tone: { filterCutoff: 60 } })`);
  const lines = plan.refusal.split('\n');
  assert.equal(lines[0], '"filterCutoff" of ccsynth is a control change in its model, and Moontide sends only Roland data sets and the NRPN offsets it knows.');
  assert.equal(lines.at(-1), CLOSING_PLAYING);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(native.sent, []);
  assert.deepEqual(errors, []);

  const memory = makeRig(pageRigOf(t, [memorySynthModel()]), { port: 'Port memorysynth' });
  const refused = memory.out.prepareSetup(`note("c3").midi('Port memorysynth', { midichannel: 1, part: { level: 90 } })`);
  assert.match(refused.refusal.split('\n')[0], /would write outside the temporary scene and tones of the instrument \(address 50 00 10 05\)/);
  assert.equal(refused.refusal.split('\n').at(-1), CLOSING_PLAYING);
  assert.deepEqual(memory.native.sent, []);
});

test('the words of the refusals are the exact wording and hold no word of the no-tint list', () => {
  assert.deepEqual(Object.keys(SETTINGS_COPY), ['kindNotSent', 'unguarded', 'temporaryOnly', 'partAddress', 'addressLength', 'memoryWrite', 'sendRefused', 'resetRefused', 'sysexDropped', 'messageDropped', 'nrpnUnknown', 'nrpnNotListed', 'nrpnRange', 'nrpnRhythm', 'nrpnScene', 'engineRow']);
  assert.equal(SETTINGS_COPY.sendRefused, 'Moontide: a {level} setting for "{id}" was not sent: {reason}.');
  assert.equal(SETTINGS_COPY.resetRefused, 'Moontide: the reset of "{id}" was not sent: {reason}.');
  assert.equal(SETTINGS_COPY.sysexDropped, 'Moontide: a system exclusive message from the code to "{id}" was not sent: {reason}.');
  assert.ok(Object.isFrozen(SETTINGS_COPY));
  for (const [key, text] of Object.entries(SETTINGS_COPY)) assert.deepEqual(findWords(text, [...TINT_WORDS]), [], key);
});

// --- the memory check ---

test('the memory check refuses the areas that keep data for good, every read request and every broken message', () => {
  const guard = TEMPORARY_AREAS[0];
  const refused = [
    [0x00, 0x00, 0x00, 0x15], [0x00, 0x10, 0x00, 0x00], [0x40, 0x00, 0x00, 0x00], [0x49, 0x7b, 0x00, 0x00],
    [0x50, 0x00, 0x00, 0x00], [0x57, 0x7e, 0x00, 0x00], [0x60, 0x00, 0x00, 0x00], [0x7f, 0x00, 0x00, 0x00], [0x01, 0x01, 0x00, 0x00],
  ];
  for (const address of refused) {
    assert.match(memoryWriteProblem(guard, dt1(address)), /^address ([0-9A-F]{2} ){3}[0-9A-F]{2} is outside the temporary scene and tones$/, address.join(' '));
  }
  assert.equal(memoryWriteProblem(guard, dt1([0x50, 0, 0, 0])), 'address 50 00 00 00 is outside the temporary scene and tones');
  const notData = 'it is not a Roland data set (command 12) for this instrument';
  assert.equal(memoryWriteProblem(guard, dt1([0x01, 0x00, 0x10, 0x06], [0x10], { command: 0x11 })), notData, 'a read request');
  assert.equal(memoryWriteProblem(guard, dt1([0x01, 0x00, 0x10, 0x06], [0x10], { model: [0, 0, 0, 0x64] })), notData, 'another model');
  assert.equal(memoryWriteProblem(guard, dt1([0x01, 0x00, 0x10, 0x06], [0x10], { device: 0x11 })), notData, 'another device');
  const wrong = dt1([0x01, 0x00, 0x10, 0x06]);
  wrong[wrong.length - 2] = (wrong[wrong.length - 2] + 1) % 128;
  assert.equal(memoryWriteProblem(guard, wrong), 'the checksum does not match');
  const complete = 'it is not a complete message';
  assert.equal(memoryWriteProblem(guard, dt1([0x01, 0x00, 0x10, 0x06]).slice(0, -1)), complete, 'no end byte');
  const high = dt1([0x01, 0x00, 0x10, 0x06]);
  high[9] = 0x80;
  assert.equal(memoryWriteProblem(guard, high), complete, 'a byte above 7F inside');
  assert.equal(memoryWriteProblem(guard, [0xf0, 0x41, 0x10, 0xf7]), complete, 'too short');
  assert.equal(memoryWriteProblem(guard, [0xf0, 0xf7]), complete);
  assert.equal(memoryWriteProblem(guard, dt1([0x01, 0x00, 0x10, 0x06], [])), complete, 'no data byte');
});

test('the memory check lets the temporary scene and tones through, and every message that is not system exclusive', () => {
  const guard = TEMPORARY_AREAS[0];
  for (const address of [[0x01, 0x00, 0x10, 0x06], [0x01, 0x00, 0x52, 0x02], [0x02, 0x10, 0x00, 0x4f], [0x02, 0x13, 0x01, 0x07]]) {
    assert.equal(memoryWriteProblem(guard, dt1(address)), null, address.join(' '));
  }
  for (const message of [[0xc0, 5], [0xb0, 7, 100], [0x90, 60, 100], [0xf8], [0xfa], [0xe0, 0, 64]]) {
    assert.equal(memoryWriteProblem(guard, message), null, message.join(' '));
  }
  assert.throws(() => memoryWriteProblem(null, dt1([0x01, 0x00, 0x10, 0x06])), /needs the temporary areas/);
});

test('the memory check reads the whole address range of a data set, with the base-128 carry of Roland addresses', () => {
  const guard = TEMPORARY_AREAS[0];
  // The last data byte lands on the last address of an area: it passes.
  assert.equal(memoryWriteProblem(guard, dt1([0x01, 0x00, 0x7f, 0x7e], [0x01, 0x02])), null);
  assert.equal(memoryWriteProblem(guard, dt1([0x02, 0x13, 0x7f, 0x7f], [0x01])), null);
  // One byte further runs out of the area, into the setup block or past the tones of part 4.
  assert.equal(
    memoryWriteProblem(guard, dt1([0x01, 0x00, 0x7f, 0x7f], [0x01, 0x02])),
    'the data from address 01 00 7F 7F runs past the temporary scene and tones (to 01 01 00 00)',
  );
  assert.equal(
    memoryWriteProblem(guard, dt1([0x02, 0x13, 0x7f, 0x7f], [0x01, 0x02])),
    'the data from address 02 13 7F 7F runs past the temporary scene and tones (to 02 14 00 00)',
  );
  // The temporary tones are those of the engines in the settings map, parts 1 to 4 (the piano engine part 1 only).
  for (const address of [[0x02, 0x00, 0x00, 0x00], [0x02, 0x03, 0x01, 0x00], [0x02, 0x20, 0x00, 0x00], [0x02, 0x50, 0x00, 0x00], [0x02, 0x53, 0x7f, 0x7f]]) {
    assert.equal(memoryWriteProblem(guard, dt1(address)), null, address.join(' '));
  }
  for (const address of [[0x02, 0x04, 0x00, 0x00], [0x02, 0x14, 0x00, 0x00], [0x02, 0x21, 0x00, 0x00], [0x02, 0x54, 0x00, 0x00], [0x02, 0x7f, 0x7f, 0x7f]]) {
    assert.match(memoryWriteProblem(guard, dt1(address)), /is outside the temporary scene and tones$/, address.join(' '));
  }
});

test('readSentBytes reads what a send hands on as Web MIDI does, within a bound, and refuses what it cannot read', () => {
  // Every number becomes the byte Web MIDI sends for it: truncated, modulo 256; a string, a boolean, null and undefined
  // convert as Web MIDI converts them.
  assert.deepEqual(readSentBytes([0x1f0, -16, 240.5, 0x41, -0, NaN]), { bytes: [0xf0, 0xf0, 0xf0, 0x41, 0, 0] });
  assert.deepEqual(readSentBytes(['240', ' 65 ', 'x', true, null, undefined]), { bytes: [0xf0, 0x41, 0, 1, 0, 0] });
  assert.deepEqual(readSentBytes(0x1f0), { bytes: [0xf0] });
  assert.deepEqual(readSentBytes(Uint8Array.from([0x90, 60, 100])), { bytes: [0x90, 60, 100] });
  assert.deepEqual(readSentBytes({ 0: 0x90, 1: 60, 2: 100, length: 3 }), { bytes: [0x90, 60, 100] });
  // An object is never converted (that could run the code's own functions), nor a symbol or a big integer.
  const notBytes = { reason: 'not-bytes', text: 'it is not a list of bytes' };
  assert.deepEqual(readSentBytes([{ valueOf: () => 240 }]), { problem: notBytes });
  assert.deepEqual(readSentBytes([0xf0, [0x41]]), { problem: notBytes });
  assert.deepEqual(readSentBytes([Symbol('x')]), { problem: notBytes });
  assert.deepEqual(readSentBytes([240n]), { problem: notBytes });
  assert.deepEqual(readSentBytes(null), { problem: notBytes });
  assert.deepEqual(readSentBytes('F0'), { problem: notBytes });
  assert.deepEqual(readSentBytes({ 0: 0xf0, get length() { throw new Error('hostile'); } }), { problem: notBytes });
  assert.deepEqual(readSentBytes({ length: 1, get 0() { throw new Error('hostile'); } }), { problem: notBytes });
  assert.deepEqual(readSentBytes({ 0: 0xf0, length: 2.5 }), { problem: notBytes });
  // A huge length is refused before a single element is read.
  let reads = 0;
  const huge = new Proxy({ length: 1e9 }, { get: (target, key) => (key === 'length' ? 1e9 : (reads++, 0xf0)) });
  assert.deepEqual(readSentBytes(huge), { problem: { reason: 'too-long', text: `it is longer than ${MAX_GUARDED_BYTES} bytes` } });
  assert.equal(reads, 0);
  assert.deepEqual(readSentBytes(new Array(MAX_GUARDED_BYTES).fill(0x90)).bytes.length, MAX_GUARDED_BYTES);
});

// The GS reset of the shipped SC-55 model and the MT-32 reset (the all-parameters reset, which the MT-32 guard lets through).
const GS_RESET = [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7];
const MT32_RESET = [0xf0, 0x41, 0x10, 0x16, 0x12, 0x7f, 0x00, 0x00, 0x00, 0x01, 0xf7];

test('sysexProblem is keyed on the message: every data set for a model with known temporary areas, anywhere in the buffer, must stay inside them', () => {
  const MEMORY_DATA_SET = dt1([0x50, 0x00, 0x00, 0x00]);
  const TEMPORARY_TONE_SET = dt1([0x02, 0x10, 0x00, 0x4f], [0x10]);
  const outside = { reason: 'outside', text: 'address 50 00 00 00 is outside the temporary scene and tones' };
  // A note in front does not hide the data set behind it, and the second message counts too.
  assert.deepEqual(sysexProblem([0x90, 60, 100, ...MEMORY_DATA_SET]), outside);
  assert.deepEqual(sysexProblem([...TEMPORARY_TONE_SET, ...MEMORY_DATA_SET]), outside);
  assert.deepEqual(sysexProblem([...GS_RESET, ...MEMORY_DATA_SET]), outside);
  assert.equal(sysexProblem([0x90, 60, 100, ...TEMPORARY_TONE_SET, 0x80, 60, 0]), null);
  assert.equal(sysexProblem([0x90, 60, 100, 0xb0, 7, 90]), null);
  // Any device ID: the model ID is what says the message is for this family.
  assert.deepEqual(sysexProblem(dt1([0x50, 0, 0, 0], [0x10], { device: 0x11 })), outside);
  assert.equal(sysexProblem(dt1([0x02, 0x10, 0x00, 0x4f], [0x10], { device: 0x7f })), null);
  // A message of this model that does not end with F7 (cut short, or ended by another status byte) is refused.
  const incomplete = { reason: 'incomplete', text: 'it is not a complete message' };
  assert.deepEqual(sysexProblem(TEMPORARY_TONE_SET.slice(0, -1)), incomplete);
  assert.deepEqual(sysexProblem([...TEMPORARY_TONE_SET.slice(0, -1), 0x90, 60, 100]), incomplete);
  assert.deepEqual(sysexProblem([0xf0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x65]), incomplete);
  // A read request or any other command of this model is refused.
  assert.deepEqual(sysexProblem(dt1([0x01, 0x00, 0x10, 0x06], [0x10], { command: 0x11 })), {
    reason: 'not-data-set',
    text: 'it is not a Roland data set (command 12) for this instrument',
  });
  // Every other system exclusive message passes as it is: GS messages, another Roland model, another maker, a universal
  // message, and a message too short to name a model. The MT-32's messages are checked too (see the MT-32 tests below).
  for (const message of [GS_RESET, dt1([0x50, 0, 0, 0], [0x10], { model: [0, 0, 0, 0x64] }), [0xf0, 0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7], [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7], [0xf0, 0x41, 0xf7], [0x90, 60, 100, 0xf0]]) {
    assert.equal(sysexProblem(message), null, message.join(' '));
  }
  assert.equal(sysexProblem([0xf8]), null);
});

// --- the guard at send time, on every system exclusive path ---

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const hexOf = (bytes) => bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const outputOf = (rig, name) => rig.webMidi.outputs.find((output) => output.name === name);

/**
 * A page output layer over ports that can come and go, with Web MIDI switched on like at page start: the Outputs are
 * guarded, an instrument is reset when it shows up, and a port that returns is reset again after the settle delay.
 */
function makeLiveRig(message, { names = ['Port T'] } = {}) {
  const natives = new Map();
  const nativeOf = (name) => {
    if (!natives.has(name)) natives.set(name, new FakeNative(`id-${natives.size}`, name));
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
  const clock = makeClock();
  const list = (name) => {
    const native = nativeOf(name);
    webMidi.outputs.push(new FakeOutput(native));
    webMidi.interface.outputs.set(native.id, native);
  };
  const unlist = (name) => {
    const native = nativeOf(name);
    webMidi.outputs = webMidi.outputs.filter((output) => output.id !== native.id);
    webMidi.interface.outputs.delete(native.id);
  };
  for (const name of names) list(name);
  const errors = [];
  const published = [];
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
    resetSettleMs: 500,
    onError: (text, err) => errors.push({ text, err }),
    onInfo: () => {},
  });
  out.setRig(parseRigMessage(message));
  const noise = () => {
    for (const listener of listeners) listener.handler({});
    clock.advance(0);
  };
  return {
    out,
    clock,
    webMidi,
    errors,
    published,
    state,
    native: nativeOf,
    plug(name) {
      list(name);
      noise();
    },
    unplug(name) {
      unlist(name);
      noise();
    },
    events: () => published.flatMap((facts) => facts.events),
    async wait(ms) {
      clock.advance(ms);
      await nextTick();
    },
  };
}

const MEMORY_DATA_SET = dt1([0x50, 0x00, 0x00, 0x00]);
const TEMPORARY_TONE_SET = dt1([0x02, 0x10, 0x00, 0x4f], [0x10]);

test('the code\'s data sets into memory never reach the port, whatever the instrument behind it, with one line per instrument', async (t) => {
  const message = toneSynthMessage(t, () => {}, [{ model: ccSynthModel(), port: 'Port C' }]);
  const rig = makeLiveRig(message, { names: ['Port T', 'Port C'] });
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const guarded = rig.native('Port T');
  const plain = rig.native('Port C');
  const mark = guarded.sent.length;

  outputOf(rig, 'Port T').send(MEMORY_DATA_SET);
  assert.equal(guarded.sent.length, mark, 'a data set into a user area is dropped');
  const lines = rig.errors.filter((entry) => entry.text.includes('system exclusive message from the code'));
  assert.deepEqual(lines.map((entry) => entry.text), ['Moontide: a system exclusive message from the code to "tonesynth" was not sent: address 50 00 00 00 is outside the temporary scene and tones.']);

  outputOf(rig, 'Port T').send(Uint8Array.from(dt1([0x00, 0x10, 0x00, 0x00])));
  assert.equal(guarded.sent.length, mark, 'a typed array into the setup block is dropped too');
  assert.equal(rig.errors.filter((entry) => entry.text.includes('system exclusive message from the code')).length, 1, 'one line per instrument, not one per message');

  // The data is untrusted: a length that throws is dropped, not thrown.
  assert.doesNotThrow(() => outputOf(rig, 'Port T').send({ 0: 0xf0, get length() { throw new Error('hostile'); } }));
  assert.equal(guarded.sent.length, mark);

  // A data set into the temporary tone passes, and so do a general reset, the notes and controls of the code.
  outputOf(rig, 'Port T').send(TEMPORARY_TONE_SET);
  outputOf(rig, 'Port T').send([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
  outputOf(rig, 'Port T').send([0x90, 60, 100]);
  outputOf(rig, 'Port T').send([0xb0, 1, 64]);
  assert.deepEqual(guarded.sent.slice(mark).map((entry) => entry.data), [TEMPORARY_TONE_SET, [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7], [0x90, 60, 100], [0xb0, 1, 64]]);

  // The guard reads the message, not the instrument: the same data set into memory is dropped on an instrument whose
  // model describes no Roland settings, and a data set into the temporary tone passes there.
  const plainMark = plain.sent.length;
  outputOf(rig, 'Port C').send(MEMORY_DATA_SET);
  outputOf(rig, 'Port C').send(TEMPORARY_TONE_SET);
  outputOf(rig, 'Port C').send([0x90, 60, 100]);
  assert.deepEqual(plain.sent.slice(plainMark).map((entry) => entry.data), [TEMPORARY_TONE_SET, [0x90, 60, 100]]);
  assert.deepEqual(
    rig.errors.filter((entry) => entry.text.includes('"ccsynth"')).map((entry) => entry.text),
    ['Moontide: a system exclusive message from the code to "ccsynth" was not sent: address 50 00 00 00 is outside the temporary scene and tones.'],
  );
});

/** The shipped SC-55 and MT-32 models on Port S and Port M, connected and reset, as a page with Web MIDI on sees them. */
async function shippedRig(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-settings-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, 'instruments.json'),
    JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Port S' }, { id: 'mt32', model: 'mt32', port: 'Port M' }] }),
  );
  const message = JSON.parse(JSON.stringify(rigMessage(new RigStore({ dataDir }).read())));
  const rig = makeLiveRig(message, { names: ['Port S', 'Port M'] });
  await rig.out.enableIfGranted();
  await rig.wait(1000);
  return rig;
}

test('a GS message from the code reaches the shipped SC-55 untouched, as it did before the guard', async (t) => {
  const rig = await shippedRig(t);
  const sc55 = rig.native('Port S');
  const mark = sc55.sent.length;
  // A GS reverb level for part 1 and the GS reset, as the code writes them.
  const gsReverb = [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x01, 0x33, 0x40, 0x0c, 0xf7];
  outputOf(rig, 'Port S').send(gsReverb);
  outputOf(rig, 'Port S').send(GS_RESET);
  assert.deepEqual(sc55.sent.slice(mark).map((entry) => entry.data), [gsReverb, GS_RESET]);
  assert.deepEqual(rig.errors, []);
  assert.deepEqual(rig.events().filter((event) => event.kind === 'sysex-refused'), []);
});

// The MT-32 data sets of the code: a timbre temporary area of part 1 (04 00 0C, the partial mute) and the timbre memory of
// the first stored timbre (08 00 00), which keeps a sound until the instrument is switched off.
const mt32Set = (address, data = [0x0f], options = {}) => dt1(address, data, { model: [0x16], ...options });
const MT32_TIMBRE_SET = mt32Set([0x04, 0x00, 0x0c]);
const MT32_MEMORY_SET = mt32Set([0x08, 0x00, 0x00]);

test('to the shipped MT-32 its reset goes out when it connects and a timbre temporary data set from the code passes, and the code\'s own reset and a timbre memory data set are dropped with one line and one event', async (t) => {
  const rig = await shippedRig(t);
  const mt32 = rig.native('Port M');
  // The reset the shipped model sends when the instrument connects went out through the check of the reset.
  assert.deepEqual(mt32.sent.map((entry) => entry.data).filter((data) => data[0] === 0xf0), [MT32_RESET]);
  assert.deepEqual(rig.events().filter((event) => event.kind === 'reset').map((event) => event.instrument), ['sc55', 'mt32']);
  const mark = mt32.sent.length;
  outputOf(rig, 'Port M').send(MT32_TIMBRE_SET);
  assert.deepEqual(mt32.sent.slice(mark).map((entry) => entry.data), [MT32_TIMBRE_SET]);
  assert.deepEqual(rig.errors, []);
  // The reset puts the factory contents back: it is the model's to send when the instrument connects, never the code's.
  outputOf(rig, 'Port M').send(MT32_RESET);
  outputOf(rig, 'Port M').send(MT32_MEMORY_SET);
  outputOf(rig, 'Port M').send(MT32_MEMORY_SET);
  assert.equal(mt32.sent.length, mark + 1, 'neither the reset nor the timbre memory data set from the code reaches the port');
  assert.deepEqual(rig.errors.map((entry) => entry.text), ['Moontide: a system exclusive message from the code to "mt32" was not sent: address 7F 00 00 is outside the temporary scene and tones.']);
  assert.deepEqual(rig.events().filter((event) => event.kind === 'sysex-refused'), [{ kind: 'sysex-refused', instrument: 'mt32', source: 'code', reason: 'outside' }]);
});

test('the code cannot get a data set past the guard by the shape of what it hands to send', async (t) => {
  const rig = makeLiveRig(toneSynthMessage(t));
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const port = rig.native('Port T');
  const output = outputOf(rig, 'Port T');
  const mark = port.sent.length;
  const rest = MEMORY_DATA_SET.slice(1);
  // Web MIDI turns each number into a byte modulo 256, so 496, -16 and 240.5 all reach the port as F0.
  for (const start of [0x1f0, -16, 240.5]) output.send([start, ...rest]);
  // A string converts as Web MIDI converts it.
  output.send(['240', ...rest]);
  // A note in front of the data set, in one buffer.
  output.send([0x90, 60, 100, ...MEMORY_DATA_SET]);
  // The old two-argument form: the start byte, then the rest as a list.
  output.send(0xf0, rest);
  output.send(0x90, [60, 100, ...MEMORY_DATA_SET]);
  // A huge length is refused at once, without a single element read.
  let reads = 0;
  const huge = new Proxy({}, { get: (target, key) => (key === 'length' ? 1e9 : (reads++, 0xf0)) });
  output.send(huge);
  assert.equal(reads, 0);
  assert.deepEqual(port.sent.slice(mark), [], 'nothing reached the port');

  // What was checked is what is sent: a list that changes after it was read still sends the bytes that were checked.
  let calls = 0;
  const shifty = new Proxy([0x90, 60, 100], {
    get: (target, key) => (key === '0' && calls++ > 0 ? 0xf0 : Reflect.get(target, key)),
  });
  output.send(shifty);
  output.send(Uint8Array.from([0xb0, 7, 90]));
  output.send([0x90 + 0x100, 62, 90]);
  assert.deepEqual(port.sent.slice(mark).map((entry) => entry.data), [[0x90, 60, 100], [0xb0, 7, 90], [0x90, 62, 90]]);
});

test('the guard holds while the setup file is invalid or gone, and on a port of no instrument, where other messages pass', async (t) => {
  const rig = makeLiveRig(toneSynthMessage(t), { names: ['Port T', 'Port X'] });
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const port = rig.native('Port T');
  const other = rig.native('Port X');
  const mark = port.sent.length;
  rig.out.setRig({ setup: 'invalid', problems: [{ field: 'instruments[0].model', reason: 'half-written' }], more: 0 });
  outputOf(rig, 'Port T').send(MEMORY_DATA_SET);
  rig.out.setRig({ setup: 'absent' });
  outputOf(rig, 'Port T').send(MEMORY_DATA_SET);
  outputOf(rig, 'Port T').send([0x90, 60, 100]);
  assert.deepEqual(port.sent.slice(mark).map((entry) => entry.data), [[0x90, 60, 100]], 'the data sets were dropped, the note passed');
  // A port that is no instrument of the rig: the data set into memory is dropped there too, a GS message passes, and the
  // notice names the port.
  outputOf(rig, 'Port X').send(MEMORY_DATA_SET);
  outputOf(rig, 'Port X').send(GS_RESET);
  assert.deepEqual(other.sent.map((entry) => entry.data), [GS_RESET]);
  assert.deepEqual(
    rig.events().filter((event) => event.kind === 'sysex-refused').map((event) => event.instrument),
    ['tonesynth', 'Port X'],
  );
});

const memoryReset = (model) => {
  model.reset = { sysex: [{ kind: 'raw', bytes: hexOf(MEMORY_DATA_SET) }], waitMs: 0 };
};

test('a reset of a guarded instrument that would write memory sends no byte and takes the failure path', async (t) => {
  const rig = makeLiveRig(toneSynthMessage(t, memoryReset));
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const port = rig.native('Port T');
  assert.deepEqual(port.sent, [], 'no reset byte, and no setup after it');
  const refusal = rig.errors.find((entry) => entry.text.includes('could not reset MIDI port "Port T"'));
  assert.equal(refusal.err.message, 'Moontide: the reset of "tonesynth" was not sent: address 50 00 00 00 is outside the temporary scene and tones.');
  assert.deepEqual(rig.events(), [{ kind: 'sysex-refused', instrument: 'tonesynth', source: 'reset', reason: 'outside' }], 'Claude hears that the memory guard refused it, and why');
  // The shadows were forgotten: the next evaluation sends the whole sound.
  await play(rig.out, rig.clock, soundOnlyCode);
  assert.deepEqual(port.sent.map((entry) => entry.data), [[0xb0, 0x00, 0x61], [0xb0, 0x20, 0x40], [0xc0, 0x00]]);
});

test('a reset of a guarded instrument into the temporary tone goes out as before', async (t) => {
  const rig = makeLiveRig(toneSynthMessage(t, (model) => void (model.reset = { sysex: [{ kind: 'raw', bytes: hexOf(TEMPORARY_TONE_SET) }], waitMs: 0 })));
  await rig.out.enableIfGranted();
  await rig.wait(100);
  assert.deepEqual(rig.native('Port T').sent[0].data, TEMPORARY_TONE_SET);
  assert.deepEqual(rig.errors, []);
  assert.deepEqual(rig.events(), [{ kind: 'reset', instrument: 'tonesynth', reason: 'start' }]);
});

const soundOnlyCode = `note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone' })`;

test('the data sets are checked again when they are sent: a rig that lost its guard in between sends none and stops the setup', async (t) => {
  const message = toneSynthMessage(t);
  const { out, native, errors, clock, published } = makeRig(message);
  const code = `note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone', tone: { filterCutoff: 600 }, part: { pan: 40 }, scene: { reverbLevel: 80 } })`;
  const plan = out.prepareSetup(code);
  assert.equal(plan.refusal, null);
  // The rig changes after the plan was built: the instrument now has a model ID Moontide knows no temporary areas for.
  const changed = structuredClone(message);
  changed.instruments[0].settings.rolandModel = [0, 0, 0, 100];
  out.setRig(parseRigMessage(changed));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.deepEqual(bytesOf(native), [[0xb0, 0x00, 0x61], [0xb0, 0x20, 0x40], [0xc0, 0x00]], 'the sound went out, no data set did');
  assert.deepEqual(errors.map((entry) => entry.text), ['Moontide: a tone setting for "tonesynth" was not sent: the temporary areas of this instrument are not known.']);
  out.publishFacts({ force: true });
  assert.deepEqual(published.at(-1).events, [{ kind: 'sysex-refused', instrument: 'tonesynth', source: 'settings', reason: 'unknown-areas' }]);
});

test('a settings message the port throws on is a send-failed event about the settings, not about the sound setup', async (t) => {
  const { out, native, errors, clock, published } = makeRig(toneSynthMessage(t));
  const send = native.send.bind(native);
  native.send = (data, ...rest) => {
    if (data[0] === 0xf0) throw Object.assign(new Error('port gone'), { name: 'InvalidStateError' });
    return send(data, ...rest);
  };
  const plan = out.prepareSetup(toneCode);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  assert.match(errors[0].text, /could not send a setting to MIDI port "Port T"/);
  out.publishFacts({ force: true });
  assert.deepEqual(published.at(-1).events, [{ kind: 'send-failed', instrument: 'tonesynth', what: 'settings', failure: 'InvalidStateError' }]);
});

test('the check over every message: nothing the page can send to a guarded instrument writes its memory', async (t) => {
  const model = (m) => {
    m.controls = [{ id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 }];
    m.reset = { sysex: [{ kind: 'raw', bytes: hexOf(TEMPORARY_TONE_SET) }], waitMs: 20 };
  };
  const rig = makeLiveRig(toneSynthMessage(t, model));
  const source = toneSynthModel();
  await rig.out.enableIfGranted();
  await rig.wait(100);

  // Settings at their smallest and largest value on every channel their level allows, a sound change and a control.
  const list = (level, pick) => source.settings[level].map((row) => `${row.name}: ${pick(row)}`).join(', ');
  const codeAt = (pick) =>
    [1, 2, 3, 4]
      .map((channel) => `m${channel}: note("c3").midi('Port T', { midichannel: ${channel}, sound: 'Model Tone', tone: { ${list('tone', pick)} }, part: { ${list('part', pick)} }, scene: { ${list('scene', pick)} }, controls: { volume: ${pick({ min: 5, max: 90 })} } })`)
      .concat(`m5: note("c3").midi('Port T', { midichannel: 5, sound: 'Own Kit', part: { ${list('part', pick)} } })`)
      .join('\n');
  await play(rig.out, rig.clock, codeAt((row) => row.min));
  await play(rig.out, rig.clock, codeAt((row) => row.max));
  await play(rig.out, rig.clock, `m1: note("c3").midi('Port T', { midichannel: 1, sound: 'Core Tone', part: { pan: 3 } })`);
  assert.deepEqual(rig.errors, []);

  // A reconnect: the port goes and comes back, is reset after the settle delay, and gets its second setup.
  rig.unplug('Port T');
  rig.plug('Port T');
  await rig.wait(500);
  await rig.wait(100);
  await rig.wait(1000);

  // The code's own messages through the Output, a panic and the clock bytes.
  const output = outputOf(rig, 'Port T');
  for (const message of [[0x90, 60, 100], [0x80, 60, 0], [0xb0, 74, 64], MEMORY_DATA_SET, dt1([0x00, 0x10, 0x00, 0x00]), TEMPORARY_TONE_SET, [0xf8], [0xfa], [0xfb], [0xfc]]) output.send(message);
  rig.out.panic();
  await rig.wait(1000);

  const sent = rig.native('Port T').sent.map((entry) => entry.data);
  assert.ok(sent.length >= 100, `the run covered many messages (${sent.length})`);
  const guard = guardOf(parseRigMessage(toneSynthMessage(t)).instruments[0].settings);
  const clockStatuses = [0xf8, 0xfa, 0xfb, 0xfc];
  const systemExclusive = sent.filter((data) => data[0] === 0xf0);
  // Two evaluations of 5 tone settings on 4 channels, 2 part settings on 5 channels and 2 scene settings.
  assert.ok(systemExclusive.length >= 2 * (5 * 4 + 2 * 5 + 2), `the run sent the data sets (${systemExclusive.length})`);
  for (const data of sent) {
    if (data[0] === 0xf0) assert.equal(memoryWriteProblem(guard, data), null, hexOf(data));
    else assert.ok((data[0] >= 0x80 && data[0] <= 0xef) || clockStatuses.includes(data[0]), hexOf(data));
  }
  assert.equal(sent.some((data) => data.length === MEMORY_DATA_SET.length && hexOf(data) === hexOf(MEMORY_DATA_SET)), false);
});

// --- the order of everything one evaluation sends, on two channels ---

const withVolume = (model) => void (model.controls = [{ id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 }]);

const ORDER_CODE = [
  `a: note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone', tone: { filterCutoff: 600 }, part: { pan: 40 }, controls: { volume: 90 } })`,
  `b: note("e3").midi('Port T', { midichannel: 2, sound: 'Model Tone', tone: { lfoOscDepth: 128 }, part: { level: 100 }, scene: { reverbLevel: 80 } })`,
].join('\n');

// The five data sets of ORDER_CODE, written byte by byte. Part 1 pan 40: address 01 00 10 06. Part 2 lfoOscDepth 128 (two
// pieces, 8 and 0) at 02 11 00 0B, level 100 at 01 00 11 05. The scene reverbLevel 80 at 01 00 52 02 is the same for every part.
const PAN_40 = hexBytes('F0 41 10 00 00 00 65 12 01 00 10 06 28 41 F7');
const LFO_128 = hexBytes('F0 41 10 00 00 00 65 12 02 11 00 0B 08 00 5A F7');
const LEVEL_100 = hexBytes('F0 41 10 00 00 00 65 12 01 00 11 05 64 05 F7');
const REVERB_80 = hexBytes('F0 41 10 00 00 00 65 12 01 00 52 02 50 5B F7');
const FIVE_DATA_SETS = [CUTOFF_600, PAN_40, LFO_128, LEVEL_100, REVERB_80];

test('end to end: two channels with tone, part, scene and a control leave in one exact order, and again the same way', async (t) => {
  // The literal checksums agree with the server's.
  for (const set of FIVE_DATA_SETS) assert.equal(rolandChecksum(set.slice(8, -2)), set.at(-2), hexOf(set));

  const { out, native, errors, clock } = makeRig(toneSynthMessage(t, withVolume));
  await play(out, clock, ORDER_CODE);
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native), [
    [0xb0, 0x00, 0x61], [0xb0, 0x20, 0x40], [0xc0, 0x00], CUTOFF_600, PAN_40, [0xb0, 0x07, 0x5a],
    [0xb1, 0x00, 0x61], [0xb1, 0x20, 0x40], [0xc1, 0x00], LFO_128, LEVEL_100,
    REVERB_80,
  ]);
  for (const entry of native.sent) assert.equal(entry.argc, 1, 'nothing is stamped in an evaluation that takes over at once');

  // Evaluated again: every setting again, in the same order, and nothing of the sound or the controls.
  const mark = native.sent.length;
  await play(out, clock, ORDER_CODE);
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native).slice(mark), FIVE_DATA_SETS);
});

test('end to end: the new code waits for its settings bytes like for a sound, and an instrument that is off or gone gets none', async (t) => {
  const lengthOf = (list) => list.reduce((sum, bytes) => sum + bytes.length, 0);
  const guardFor = (bytes) => Math.ceil(50 + bytes * 0.32);

  const { out, native, clock } = makeRig(toneSynthMessage(t, withVolume));
  /** Sends a plan and answers how long it took on the fake clock: the least wait after which it resolved. */
  const waitOf = async (plan, bytes) => {
    let done = false;
    const sending = plan.send().then(() => {
      done = true;
    });
    clock.advance(guardFor(bytes) - 1);
    await nextTick();
    assert.equal(done, false, `not yet after ${guardFor(bytes) - 1} ms`);
    clock.advance(1);
    await sending;
    assert.equal(done, true, `after ${guardFor(bytes)} ms`);
    plan.commit();
  };
  const first = out.prepareSetup(ORDER_CODE);
  assert.equal(first.refusal, null);
  // 16 bytes of sound, 3 of the control and 79 of settings: the settings are counted with the rest.
  assert.equal(lengthOf(FIVE_DATA_SETS), 79);
  await waitOf(first, 16 + 3 + 79);
  assert.equal(guardFor(98), 82);
  assert.equal(lengthOf(bytesOf(native)), 98);

  // The second evaluation sent only the five data sets, and waited for only those.
  const mark = native.sent.length;
  const second = out.prepareSetup(ORDER_CODE);
  await waitOf(second, 79);
  assert.equal(guardFor(79), 76);
  assert.equal(lengthOf(bytesOf(native).slice(mark)), 79);

  // An instrument switched off after the plan was made gets nothing and the plan does not wait.
  const off = makeRig(toneSynthMessage(t, withVolume));
  const offPlan = off.out.prepareSetup(ORDER_CODE);
  assert.equal(offPlan.refusal, null);
  const switchedOff = toneSynthMessage(t, withVolume);
  switchedOff.instruments[0].enabled = false;
  off.out.setRig(parseRigMessage(switchedOff));
  const offMark = off.native.sent.length;
  let offDone = false;
  const offSending = offPlan.send().then(() => {
    offDone = true;
  });
  await nextTick();
  assert.equal(offDone, true, 'no guard to wait for');
  await offSending;
  assert.deepEqual(off.native.sent.slice(offMark), []);

  // A port that is not exactly one connected output gets nothing either.
  const gone = makeRig(toneSynthMessage(t, withVolume));
  const gonePlan = gone.out.prepareSetup(ORDER_CODE);
  assert.equal(gonePlan.refusal, null);
  gone.webMidi.outputs = [];
  gone.webMidi.interface.outputs.clear();
  let goneDone = false;
  const goneSending = gonePlan.send().then(() => {
    goneDone = true;
  });
  await nextTick();
  assert.equal(goneDone, true, 'no guard to wait for');
  await goneSending;
  assert.deepEqual(gone.native.sent, []);
  assert.deepEqual(gone.errors, []);
});

// --- what Claude is told: a scene setting reaches every part ---

const sceneCode = (value) => `note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone', scene: { reverbLevel: ${value} } })`;
const eventsOf = (published, kind) => published.flatMap((facts) => facts.events).filter((event) => event.kind === kind);

test('end to end: a scene setting that changed becomes one settings-scene event, worded for Claude, once', async (t) => {
  const { out, errors, published, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, sceneCode(80));
  assert.deepEqual(errors, []);
  assert.deepEqual(eventsOf(published, 'settings-scene'), [{ kind: 'settings-scene', instrument: 'tonesynth', names: ['reverbLevel'] }]);

  // The same code again says nothing new; another value says it again; code with no scene setting says nothing.
  await play(out, clock, sceneCode(80));
  assert.equal(eventsOf(published, 'settings-scene').length, 1, 'the same scene values add no event');
  await play(out, clock, sceneCode(60));
  assert.equal(eventsOf(published, 'settings-scene').length, 2, 'another value is a change');
  await play(out, clock, toneCode);
  assert.equal(eventsOf(published, 'settings-scene').length, 2, 'code with no scene setting adds none');

  // The facts that went out are what the server's schema accepts, and the server words them once.
  const sent = published.find((facts) => facts.events.some((event) => event.kind === 'settings-scene'));
  const parsed = parsePageMessage(JSON.stringify({ type: 'midi-state', ...sent }));
  const channel = new MidiChannel();
  channel.update(parsed);
  const lines = channel.drainLines().filter((line) => line.includes('scene settings'));
  assert.deepEqual(lines, ['MIDI: the scene settings reverbLevel of "tonesynth" reach every part of the instrument, not only the channel of their .midi() call.']);
});

test('a scene setting is told by the names and the values together: a new setting of the scene is a change too', async (t) => {
  const { out, published, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, sceneCode(80));
  await play(out, clock, `note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone', scene: { reverbLevel: 80, chorusSwitch: 1 } })`);
  assert.deepEqual(eventsOf(published, 'settings-scene').at(-1), { kind: 'settings-scene', instrument: 'tonesynth', names: ['reverbLevel', 'chorusSwitch'] });
  assert.equal(eventsOf(published, 'settings-scene').length, 2);
});

test('a failed evaluation adds no settings-scene event', async (t) => {
  const { out, published, clock } = makeRig(toneSynthMessage(t));
  const plan = out.prepareSetup(sceneCode(80));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  await plan.rollback();
  assert.deepEqual(eventsOf(published, 'settings-scene'), []);
});

// --- what Claude is told: a setting that is no longer in the code stays on the instrument ---

const codeWith = (settings, sound = 'Model Tone') => `note("c3").midi('Port T', { midichannel: 1, sound: '${sound}'${settings} })`;
const BOTH_TONES = codeWith(', tone: { filterCutoff: 600, filterResonance: 300 }, part: { pan: 40 }, scene: { reverbLevel: 80 }');
const RESONANCE_300 = dt1([0x02, 0x10, 0x00, 0x53], [0, 1, 2, 12]);
const leftOf = (published) => published.flatMap((facts) => facts.events).filter((event) => event.kind === 'settings-left');
const left = (level, channel, names) => ({ kind: 'settings-left', instrument: 'tonesynth', level, channel, names });
/** A tone synth message whose own sound is program 1, so that switching to it is a real sound change. */
const withOwnProgram = (model) => void (model.sounds.melodic[0].program = 1);

test('a setting no longer in the code at the commit is told per level, and nothing is sent for it', async (t) => {
  const { out, native, errors, published, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, BOTH_TONES);
  assert.deepEqual(leftOf(published), [], 'nothing left yet');
  const mark = native.sent.length;
  await play(out, clock, codeWith(', tone: { filterResonance: 300 }'));
  assert.deepEqual(errors, []);
  assert.deepEqual(bytesOf(native).slice(mark), [RESONANCE_300], 'only the setting the code still writes is sent');
  assert.deepEqual(leftOf(published), [left('tone', 1, ['filterCutoff']), left('part', 1, ['pan']), left('scene', null, ['reverbLevel'])]);

  // Said once: the same code again says nothing more, and a setting that never was in the code says nothing.
  await play(out, clock, codeWith(', tone: { filterResonance: 300 }'));
  assert.equal(leftOf(published).length, 3);
});

test('a code that names no MIDI at all leaves every setting of the code that played', async (t) => {
  const { out, published, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, BOTH_TONES);
  await play(out, clock, 's("bd")');
  assert.deepEqual(leftOf(published), [left('tone', 1, ['filterCutoff', 'filterResonance']), left('part', 1, ['pan']), left('scene', null, ['reverbLevel'])]);
});

test('a tone setting of a channel whose sound was just sent gets no line: the tone was loaded again', async (t) => {
  const { out, errors, published, clock } = makeRig(toneSynthMessage(t, withOwnProgram));
  await play(out, clock, BOTH_TONES);
  await play(out, clock, codeWith(', tone: { filterResonance: 300 }', 'Own Tone'));
  assert.deepEqual(errors, []);
  assert.deepEqual(leftOf(published), [left('part', 1, ['pan']), left('scene', null, ['reverbLevel'])]);
});

test('a refused evaluation tells what it sent that the code returned to does not write, per level', async (t) => {
  const { out, native, errors, published, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, codeWith(', tone: { filterCutoff: 600 }'));
  const mark = native.sent.length;
  const plan = out.prepareSetup(codeWith(', tone: { env1Attack: 10 }, part: { pan: 40 }, scene: { reverbLevel: 80 }'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  await plan.rollback();
  assert.deepEqual(errors, []);
  assert.deepEqual(leftOf(published), [left('tone', 1, ['env1Attack']), left('part', 1, ['pan']), left('scene', null, ['reverbLevel'])]);
  assert.deepEqual(bytesOf(native).at(-1), CUTOFF_600, 'the setting of the code that plays went back');
  assert.ok(bytesOf(native).length > mark);
});

test('a refused evaluation whose old sound went back tells no tone setting of that channel', async (t) => {
  const { out, errors, published, clock } = makeRig(toneSynthMessage(t, withOwnProgram));
  await play(out, clock, codeWith(', tone: { filterCutoff: 600 }'));
  const plan = out.prepareSetup(codeWith(', tone: { env1Attack: 10 }, part: { pan: 40 }', 'Own Tone'));
  assert.equal(plan.refusal, null);
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  await plan.rollback();
  assert.deepEqual(errors, []);
  assert.deepEqual(leftOf(published), [left('part', 1, ['pan'])], 'the program change of the old sound erased the tone');
});

test('a refused evaluation that wrote what the playing code writes tells nothing', async (t) => {
  const { out, published, clock } = makeRig(toneSynthMessage(t));
  await play(out, clock, BOTH_TONES);
  const plan = out.prepareSetup(codeWith(', tone: { filterCutoff: 100 }, part: { pan: 10 }, scene: { reverbLevel: 10 }'));
  const sending = plan.send();
  clock.advance(1000);
  await sending;
  await plan.rollback();
  assert.deepEqual(leftOf(published), [], 'the values go back, so nothing stays');
});

test('the first system exclusive message the code sends to a guarded instrument adds one sysex-refused event, once', async (t) => {
  const rig = makeLiveRig(toneSynthMessage(t, () => {}, [{ model: ccSynthModel(), port: 'Port C' }]), { names: ['Port T', 'Port C'] });
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const refused = () => rig.events().filter((event) => event.kind === 'sysex-refused');
  assert.deepEqual(refused(), []);
  outputOf(rig, 'Port T').send(MEMORY_DATA_SET);
  assert.deepEqual(refused(), [{ kind: 'sysex-refused', instrument: 'tonesynth', source: 'code', reason: 'outside' }], 'told in the facts that went out at once');
  outputOf(rig, 'Port T').send(MEMORY_DATA_SET);
  outputOf(rig, 'Port T').send([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
  assert.equal(refused().length, 1, 'once per instrument, not once per message');
  // A message the instrument takes (a data set into the temporary tone) adds nothing; an instrument whose temporary areas
  // are not known gets no system exclusive message, and is told about once too.
  outputOf(rig, 'Port T').send(TEMPORARY_TONE_SET);
  assert.equal(refused().length, 1);
  outputOf(rig, 'Port C').send(TEMPORARY_TONE_SET);
  outputOf(rig, 'Port C').send(MEMORY_DATA_SET);
  assert.deepEqual(refused().map((event) => event.instrument), ['tonesynth', 'ccsynth']);
});

// --- three-byte data sets: the MT-32's model ID, address length and part spacing ---

test('a model with a one-byte model ID and three-byte addresses reads valid, and a tone, a part and a scene setting become the documented data sets', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [timbreSynthModel()]));
  assert.deepEqual(rig.instruments[0].settings.rolandModel, [0x16]);
  assert.deepEqual(rig.instruments[0].settings.tone.find((row) => row.name === 'partial1Level').message.address, [0x04, 0x00, 0x37]);
  const bytesOf = (built) => (built.lines === null ? [...built.slots.values()].flatMap((slot) => [...slot.toneBytes, ...slot.partBytes].map((item) => item.bytes)) : built.lines);
  // Channel 4 is part 3: the tone is 2 x 246 further (04 00 37 + 01 EC = 04 04 23), the patch 2 x 16 further (03 00 08 + 20 = 03 00 28).
  assert.deepEqual(bytesOf(builtFor(rig, { id: 'timbresynth', channel: 4, tone: { partial1Level: 80 } })), [hexBytes('F0 41 10 16 12 04 04 23 50 05 F7')]);
  assert.deepEqual(bytesOf(builtFor(rig, { id: 'timbresynth', channel: 4, part: { level: 100 } })), [hexBytes('F0 41 10 16 12 03 00 28 64 71 F7')]);
  const scene = builtFor(rig, { id: 'timbresynth', channel: 4, scene: { reverbLevel: 5 } });
  assert.deepEqual(scene.scenes.get('timbresynth').sceneBytes, [{ name: 'reverbLevel', bytes: mt32Set([0x10, 0x00, 0x03], [5]) }]);
  // Part 1 is channel 2, and the order inside a slot is the written one.
  assert.deepEqual(bytesOf(builtFor(rig, { id: 'timbresynth', channel: 2, tone: { partialMute: 12, partial1Level: 1 } })), [mt32Set([0x04, 0x00, 0x0c], [12]), mt32Set([0x04, 0x00, 0x37], [1])]);
});

test('the row limit of a level and the name limit of an event are 512 on the server and on the page, because the MT-32 describes about 250 settings', () => {
  assert.equal(MAX_RIG_SETTINGS, 512);
  assert.equal(RIG_LIMITS.settings, 512);
  assert.equal(MAX_SETTING_NAMES, 512);
});

test('end to end: partial4Cutoff of the timbre synth on channel 9 becomes the data set at the address of partial 4 plus seven timbre areas, in base 128', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [timbreSynthModel()]));
  const code = `note("c3").midi('Port timbresynth', { midichannel: 9, sound: 'Own Timbre', tone: { partial4Cutoff: 77 } })`;
  const checked = checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });
  assert.equal(checked.refusal, null);
  const built = buildSettings({ rig, settings: checked.settings, scenes: checked.scenes });
  assert.equal(built.lines, null);
  // The map: partial 4 starts at 04 01 3C and the cutoff is 17 hex further (04 01 53); channel 9 is part 8, 7 x 246 = 1722 bytes
  // further, which is 0D 3A in base 128: 04 01 53 + 0D 3A = 04 0F 0D.
  assert.deepEqual([...built.slots.get('timbresynth:9').toneBytes], [{ name: 'partial4Cutoff', bytes: mt32Set([0x04, 0x0f, 0x0d], [77]) }]);
  assert.equal(memoryWriteProblem(guardOf(rig.instruments[0].settings), mt32Set([0x04, 0x0f, 0x0d], [77])), null);
});

test('every row of the timbre synth, at every part its level allows and three values, equals the map rule: the step of its area times the part minus one, in base 128', (t) => {
  const model = timbreSynthModel();
  const rig = parseRigMessage(pageRigOf(t, [timbreSynthModel()]));
  const guard = guardOf(rig.instruments[0].settings);
  // The reference is written here from the map: a timbre row steps 246 (04 00 xx), a patch row 16 (03 00 xx); a scene row stays.
  // The step belongs to the area the row lies in, not to its level: the patch settings that a program change loads are tone rows.
  const stepOfArea = (high) => (high === 0x04 ? 246 : high === 0x03 ? 16 : 0);
  const reference = (level, row, part, value) => {
    const [a, b, c] = hexBytes(row.message.address);
    const number = (a * 128 + b) * 128 + c + stepOfArea(a) * (part - 1);
    return mt32Set([Math.floor(number / 16384), Math.floor(number / 128) % 128, number % 128], [value]);
  };
  const channelOf = (part) => part + 1;
  let checked = 0;
  for (const level of ['tone', 'part', 'scene']) {
    for (const row of model.settings[level]) {
      for (const part of level === 'scene' ? [1] : [1, 2, 3, 4, 5, 6, 7, 8]) {
        for (const value of [row.min, Math.floor((row.min + row.max) / 2), row.max]) {
          const built = builtFor(rig, level === 'scene' ? { id: 'timbresynth', scene: { [row.name]: value } } : { id: 'timbresynth', channel: channelOf(part), [level]: { [row.name]: value } });
          assert.equal(built.lines, null, `${level} ${row.name}: ${built.lines}`);
          const actual = level === 'scene' ? built.scenes.get('timbresynth').sceneBytes[0].bytes : built.slots.get(`timbresynth:${channelOf(part)}`)[level === 'tone' ? 'toneBytes' : 'partBytes'][0].bytes;
          assert.deepEqual(actual, reference(level, row, part, value), `${level} ${row.name} part ${part} value ${value}`);
          assert.equal(memoryWriteProblem(guard, actual), null);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 241 * 8 * 3 + 2 * 8 * 3 + 5 * 3);
  // Part 8 of the timbre area ends inside the area, at 04 0D 3A plus the row's offset.
  assert.deepEqual(builtFor(rig, { id: 'timbresynth', channel: 9, tone: { partial1Level: 1 } }).slots.get('timbresynth:9').toneBytes[0].bytes, mt32Set([0x04, 0x0d, 0x71], [1]));
});

test('a part past the parts an area has is refused with partAddress, for the tone rows and the part rows, on the rhythm channel too', (t) => {
  const rig = parseRigMessage(pageRigOf(t, [timbreSynthModel()]));
  // Channel 10 is the rhythm channel, part 9: the timbre area has 8 parts and the patch area of the rhythm part has no row list.
  assert.deepEqual(builtFor(rig, { id: 'timbresynth', channel: 10, tone: { partial1Level: 5 } }).lines, ['"partial1Level" in tone for timbresynth has no address for part 9 (channel 10).']);
  assert.deepEqual(builtFor(rig, { id: 'timbresynth', channel: 10, part: { pan: 5 } }).lines, ['"pan" in part for timbresynth has no address for part 9 (channel 10).']);
  const guard = TEMPORARY_AREAS.find((area) => sameModel(area, [0x16]));
  const at = (address, part, level = 'tone') => settingMessage({ guard, level, message: { kind: 'roland-dt1', address, size: 1 }, part, value: 1 });
  assert.deepEqual(at([0x04, 0x00, 0x37], 9), { problem: { key: 'partAddress' } });
  assert.ok(at([0x04, 0x00, 0x37], 8).bytes);
  // A row in an area with no part step (the system area, the rhythm patch area) has no address for any part, the first included.
  assert.deepEqual(at([0x10, 0x00, 0x03], 1, 'part'), { problem: { key: 'partAddress' } });
  assert.deepEqual(at([0x03, 0x01, 0x00], 1, 'tone'), { problem: { key: 'partAddress' } });
  // The result of the step must stay in the area its part 1 address lies in.
  assert.deepEqual(at([0x04, 0x0f, 0x20], 2), { problem: { key: 'partAddress' } });
  assert.deepEqual(at([0x03, 0x00, 0x7f], 2, 'part'), { problem: { key: 'partAddress' } });
  // An address in no area is named by the memory check for part 1, and has no address for a later part.
  assert.deepEqual(at([0x05, 0x00, 0x08], 1, 'part'), { problem: { key: 'memoryWrite', address: '05 00 08' } });
  assert.deepEqual(at([0x05, 0x00, 0x08], 2, 'part'), { problem: { key: 'partAddress' } });
});

const sameModel = (area, model) => area.model.length === model.length && area.model.every((byte, index) => byte === model[index]);

test('an address whose length is not the one of the instrument\'s data sets is refused with addressLength before a byte is built', (t) => {
  // The server refuses such a model when it loads; the page refuses the address on its own too, for a rig message that holds it.
  const four = pageRigOf(t, [timbreSynthModel()]);
  four.instruments[0].settings.part[0].message.address = [0x03, 0x00, 0x00, 0x08];
  const timbre = parseRigMessage(four);
  assert.deepEqual(builtFor(timbre, { id: 'timbresynth', channel: 2, part: { level: 5 } }).lines, [
    '"level" in part for timbresynth has an address of 4 bytes, and the data sets of this instrument take addresses of 3 bytes.',
  ]);
  const three = pageRigOf(t, [toneSynthModel()]);
  three.instruments[0].settings.scene[0].message.address = [0x01, 0x00, 0x52];
  const tone = parseRigMessage(three);
  assert.deepEqual(builtFor(tone, { scene: { reverbLevel: 5 } }).lines, [
    '"reverbLevel" in scene for tonesynth has an address of 3 bytes, and the data sets of this instrument take addresses of 4 bytes.',
  ]);
  assert.equal(SETTINGS_COPY.addressLength, '"{setting}" in {level} for {id} has an address of {length} bytes, and the data sets of this instrument take addresses of {size} bytes.');
});

test('the memory check of the MT-32 reads three-byte addresses and refuses patch memory, timbre memory, the write request and every read request', () => {
  const guard = TEMPORARY_AREAS.find((area) => sameModel(area, [0x16]));
  assert.equal(guard.addressSize, 3);
  const outside = (address) => `address ${hexOf(address)} is outside the temporary scene and tones`;
  for (const address of [[0x05, 0x00, 0x00], [0x05, 0x07, 0x78], [0x08, 0x00, 0x00], [0x08, 0x7e, 0x00], [0x40, 0x00, 0x00], [0x40, 0x10, 0x00], [0x02, 0x00, 0x00], [0x7f, 0x00, 0x01], [0x00, 0x00, 0x00]]) {
    assert.equal(memoryWriteProblem(guard, mt32Set(address)), outside(address), hexOf(address));
    assert.deepEqual(sysexProblem(mt32Set(address)), { reason: 'outside', text: outside(address) }, hexOf(address));
  }
  // The areas that hold nothing for good pass: the timbre, patch and rhythm temporary areas, the system area and the display.
  for (const address of [[0x04, 0x00, 0x00], [0x04, 0x0d, 0x3a], [0x03, 0x00, 0x00], [0x03, 0x00, 0x78], [0x03, 0x01, 0x00], [0x03, 0x01, 0x14], [0x10, 0x00, 0x03], [0x10, 0x00, 0x16], [0x20, 0x00, 0x00], [0x20, 0x01, 0x00]]) {
    assert.equal(memoryWriteProblem(guard, mt32Set(address)), null, hexOf(address));
    assert.equal(sysexProblem(mt32Set(address)), null, hexOf(address));
  }
  // The whole range is read, with the carry of base 128: the last byte of the timbre area passes, the next is outside.
  assert.equal(memoryWriteProblem(guard, mt32Set([0x04, 0x0f, 0x2e], [1, 2])), null);
  assert.equal(memoryWriteProblem(guard, mt32Set([0x04, 0x0f, 0x2f], [1, 2])), 'the data from address 04 0F 2F runs past the temporary scene and tones (to 04 0F 30)');
  assert.equal(memoryWriteProblem(guard, mt32Set([0x03, 0x00, 0x7f], [1, 2])), 'the data from address 03 00 7F runs past the temporary scene and tones (to 03 01 00)');
  assert.equal(memoryWriteProblem(guard, mt32Set([0x10, 0x00, 0x16], [1, 2])), 'the data from address 10 00 16 runs past the temporary scene and tones (to 10 00 17)');
  // Of the system area only the master tune, the reverb mode, time and level (10 00 00 to 10 00 03) and the master volume
  // (10 00 16) pass: the partial reserve and the MIDI channel of each part (10 00 04 to 10 00 15) would re-route the parts.
  for (let offset = 0x04; offset <= 0x15; offset++) {
    assert.deepEqual(sysexProblem(mt32Set([0x10, 0x00, offset])), { reason: 'outside', text: outside([0x10, 0x00, offset]) }, hexOf([0x10, 0x00, offset]));
  }
  for (const offset of [0x00, 0x01, 0x02, 0x03, 0x16]) assert.equal(sysexProblem(mt32Set([0x10, 0x00, offset])), null, hexOf([0x10, 0x00, offset]));
  assert.equal(memoryWriteProblem(guard, mt32Set([0x10, 0x00, 0x00], [1, 2, 3, 4])), null);
  assert.equal(memoryWriteProblem(guard, mt32Set([0x10, 0x00, 0x03], [1, 2])), 'the data from address 10 00 03 runs past the temporary scene and tones (to 10 00 04)');
  assert.equal(memoryWriteProblem(guard, mt32Set([0x10, 0x00, 0x0d], Array(9).fill(0))), outside([0x10, 0x00, 0x0d]));
  // A read request, another command, a wrong checksum and a broken message are refused as for the JUPITER-Xm.
  assert.equal(memoryWriteProblem(guard, mt32Set([0x04, 0x00, 0x0c], [0x0f], { command: 0x11 })), 'it is not a Roland data set (command 12) for this instrument');
  const wrong = mt32Set([0x04, 0x00, 0x0c]);
  wrong[wrong.length - 2] = (wrong[wrong.length - 2] + 1) % 128;
  assert.equal(memoryWriteProblem(guard, wrong), 'the checksum does not match');
  assert.equal(memoryWriteProblem(guard, mt32Set([0x04, 0x00, 0x0c]).slice(0, -1)), 'it is not a complete message');
  assert.equal(memoryWriteProblem(guard, mt32Set([0x04, 0x00, 0x0c], [])), 'it is not a complete message');
  // A four-byte reading of a three-byte message is a different message: the JUPITER-Xm model ID does not make it pass.
  assert.deepEqual(sysexProblem(mt32Set([0x08, 0x00, 0x00], [0x0f], { device: 0x11 })), { reason: 'outside', text: outside([0x08, 0x00, 0x00]) }, 'any device ID');
  assert.equal(sysexProblem(mt32Set([0x04, 0x00, 0x0c], [0x0f], { device: 0x7f })), null, 'any device ID');
});

test('the all-parameters reset passes the check of the reset byte for byte, and as nothing else: not from the code, not with other data, not with a bad checksum, not as a setting', (t) => {
  const reset = { allowReset: true };
  const outsideReset = { reason: 'outside', text: 'address 7F 00 00 is outside the temporary scene and tones' };
  assert.equal(sysexProblem(MT32_RESET, reset), null);
  assert.equal(sysexProblem(mt32Set([0x7f, 0x00, 0x00], [0x00], { device: 0x11 }), reset), null, 'any device ID');
  assert.equal(sysexProblem([...MT32_RESET, ...mt32Set([0x04, 0x00, 0x0c])], reset), null);
  assert.deepEqual(sysexProblem([...MT32_RESET, ...mt32Set([0x08, 0x00, 0x00])], reset), { reason: 'outside', text: 'address 08 00 00 is outside the temporary scene and tones' }, 'a message after the reset counts');
  // The code's own messages are checked without the exception: the reset puts the factory contents back.
  assert.deepEqual(sysexProblem(MT32_RESET), outsideReset);
  assert.deepEqual(sysexProblem(MT32_RESET, {}), outsideReset);
  assert.deepEqual(sysexProblem([...mt32Set([0x04, 0x00, 0x0c]), ...MT32_RESET]), outsideReset, 'anywhere in the buffer');
  for (const options of [undefined, reset]) {
    assert.deepEqual(sysexProblem(mt32Set([0x7f, 0x00, 0x00], [0x01]), options), outsideReset);
    assert.deepEqual(sysexProblem(mt32Set([0x7f, 0x00, 0x00], [0x00, 0x00]), options), outsideReset);
    assert.deepEqual(sysexProblem(mt32Set([0x7f, 0x00, 0x01], [0x00]), options), { reason: 'outside', text: 'address 7F 00 01 is outside the temporary scene and tones' });
  }
  const wrong = [...MT32_RESET];
  wrong[wrong.length - 2] = 0x02;
  assert.deepEqual(sysexProblem(wrong, reset), { reason: 'checksum', text: 'the checksum does not match' });
  // Not a setting: a row of a model that points at the reset is refused whatever the value.
  const model = timbreSynthModel();
  model.settings.scene.find((row) => row.name === 'reverbLevel').message.address = '7F 00 00';
  const rig = parseRigMessage(pageRigOf(t, [model]));
  assert.deepEqual(builtFor(rig, { id: 'timbresynth', scene: { reverbLevel: 0 } }).lines, [
    '"reverbLevel" in scene for timbresynth would write outside the temporary scene and tones of the instrument (address 7F 00 00), so it is not sent.',
    "Moontide sends a setting only where it can check that nothing is written to the instrument's memory.",
  ]);
});

test('a timbre synth whose part row points into patch memory is refused with memoryWrite and nothing is sent', async (t) => {
  const model = (m) => void (m.settings.part[0].message.address = '05 00 08');
  const pointing = timbreSynthModel();
  model(pointing);
  const rig = parseRigMessage(pageRigOf(t, [pointing]));
  assert.deepEqual(builtFor(rig, { id: 'timbresynth', channel: 2, part: { level: 5 } }).lines, [
    '"level" in part for timbresynth would write outside the temporary scene and tones of the instrument (address 05 00 08), so it is not sent.',
    "Moontide sends a setting only where it can check that nothing is written to the instrument's memory.",
  ]);
  // Through the page: the evaluation fails with the line and no byte goes out.
  const message = timbreSynthMessage(t, model);
  const live = makeLiveRig(message, { names: ['Port timbresynth'] });
  await live.out.enableIfGranted();
  await live.wait(100);
  const port = live.native('Port timbresynth');
  const mark = port.sent.length;
  const plan = live.out.prepareSetup(`note("c3").midi('Port timbresynth', { midichannel: 2, sound: 'Own Timbre', part: { level: 5 } })`);
  assert.equal(plan.refusal.split('\n')[0], '"level" in part for timbresynth would write outside the temporary scene and tones of the instrument (address 05 00 08), so it is not sent.');
  assert.equal(port.sent.length, mark);
});

/** The timbre synth on Port timbresynth read from a real data folder, as the page gets it after a trip over the wire. */
function timbreSynthMessage(t, change = () => {}) {
  const model = timbreSynthModel();
  change(model);
  const state = new RigStore({ dataDir: dataFolderOf(t, [model], [{ id: 'timbresynth', model: 'timbresynth', port: 'Port timbresynth' }]) }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return JSON.parse(JSON.stringify(rigMessage(state)));
}

test('the check over every message, run on the timbre synth: nothing the page can send to it writes its memory', async (t) => {
  const rig = makeLiveRig(timbreSynthMessage(t, (m) => void (m.reset = { sysex: [{ kind: 'roland-dt1', model: '16', address: '7F 00 00', data: '00' }], waitMs: 20 })), { names: ['Port timbresynth'] });
  const source = timbreSynthModel();
  await rig.out.enableIfGranted();
  await rig.wait(100);
  const list = (level, pick) => source.settings[level].map((row) => `${row.name}: ${pick(row)}`).join(', ');
  const codeAt = (pick) =>
    [2, 3, 4, 5, 6, 7, 8, 9]
      .map((channel) => `m${channel}: note("c3").midi('Port timbresynth', { midichannel: ${channel}, sound: 'Own Timbre', tone: { ${list('tone', pick)} }, part: { ${list('part', pick)} }, scene: { ${list('scene', pick)} } })`)
      .join('\n');
  // About two thousand data sets leave in one evaluation: the page spaces them by their length on the wire, so the clock goes far.
  await play(rig.out, rig.clock, codeAt((row) => row.min), 60000);
  await play(rig.out, rig.clock, codeAt((row) => row.max), 60000);
  assert.deepEqual(rig.errors, []);
  rig.unplug('Port timbresynth');
  rig.plug('Port timbresynth');
  await rig.wait(500);
  await rig.wait(100);
  await rig.wait(1000);
  const output = outputOf(rig, 'Port timbresynth');
  for (const message of [[0x90, 60, 100], MT32_MEMORY_SET, mt32Set([0x05, 0x00, 0x08]), mt32Set([0x40, 0x00, 0x00]), MT32_TIMBRE_SET, MT32_RESET]) output.send(message);
  rig.out.panic();
  await rig.wait(1000);
  const sent = rig.native('Port timbresynth').sent.map((entry) => entry.data);
  const guard = TEMPORARY_AREAS.find((area) => sameModel(area, [0x16]));
  const systemExclusive = sent.filter((data) => data[0] === 0xf0);
  // Two evaluations of 241 tone settings and 2 part settings on 8 channels and 5 scene settings.
  assert.ok(systemExclusive.length >= 2 * (241 * 8 + 2 * 8 + 5), `the run sent the data sets (${systemExclusive.length})`);
  for (const data of systemExclusive) assert.equal(sysexProblem(data, { allowReset: hexOf(data) === hexOf(MT32_RESET) }), null, hexOf(data));
  for (const data of systemExclusive) if (hexOf(data) !== hexOf(MT32_RESET)) assert.equal(memoryWriteProblem(guard, data), null, hexOf(data));
  for (const data of sent) assert.equal(data[0] === 0xf0 && (data[5] === 0x05 || data[5] === 0x08 || data[5] === 0x40), false, hexOf(data));
  // The reset goes out once per connection (the first one and the replug), never for the code's own send of it.
  assert.equal(systemExclusive.filter((data) => hexOf(data) === hexOf(MT32_RESET)).length, 2, 'the reset goes out when the instrument connects, and only then');
});

test('the MT-32 entry of the guard list has three-byte addresses, a part step by area and the reset as its one exact message', () => {
  const guard = guardOf({ rolandModel: [0x16] });
  assert.equal(guard, TEMPORARY_AREAS[1]);
  assert.ok(Object.isFrozen(guard) && Object.isFrozen(guard.ranges) && Object.isFrozen(guard.exact));
  assert.deepEqual(TEMPORARY_AREAS.map((area) => area.addressSize), [4, 3]);
  assert.deepEqual(guard.ranges.map((entry) => entry.partStep), [246, 16, 0, 0, 0, 0, 0]);
  // The system area is two ranges: the master tune and reverb, then the master volume alone.
  assert.deepEqual(guard.ranges.filter((entry) => entry.first[0] === 0x10).map((entry) => [entry.first, entry.last]), [
    [[0x10, 0x00, 0x00], [0x10, 0x00, 0x03]],
    [[0x10, 0x00, 0x16], [0x10, 0x00, 0x16]],
  ]);
  assert.deepEqual(TEMPORARY_AREAS[0].ranges.map((entry) => entry.partStep), [128, 16384, 16384, 16384, 16384]);
  assert.deepEqual(guard.exact.map((entry) => [entry.address, entry.data]), [[[0x7f, 0x00, 0x00], [0x00]]]);
  assert.deepEqual(TEMPORARY_AREAS[0].exact, []);
});
