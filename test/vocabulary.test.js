import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import { checkSetup, parseRigMessage } from '../page/midi-rig.js';
import { readMidiSetup } from '../page/midi-plan.js';
import { RigStore, parseModel, rigMessage } from '../dist/instruments.js';
import { NRPN_FAMILY_RANGES, ROLAND_ADDRESS_SIZES, SETTING_LEVELS, SETTING_VOCABULARY } from '../dist/vocabulary.js';
import { KNOWN_NRPNS, TEMPORARY_AREAS } from '../page/midi-settings.js';
import { MAX_RIG_SETTINGS } from '../dist/protocol.js';
import { BUILT_IN_DRUM_MAPS } from '../dist/drum-maps.js';
import { bankDrumsModel, gmDrumsModel } from './drum-fixtures.js';
import { ccSynthModel, engineSynthCatalog, engineSynthModel, offsetSynthModel, timbreSynthModel, toneSynthCatalog, toneSynthModel } from './settings-fixtures.js';

// The settings vocabulary: one set of names for tone, part and scene settings, the model description
// that maps them, and the check of the options of .midi(). All data is neutral (Tone Synth, Port T).

const CLOSING_PLAYING = 'The previous music keeps playing.';

/** The tone synth fixture cut down to one tone setting: the smallest description that reaches the page. */
function minimalModel(change = (model) => model) {
  const model = toneSynthModel();
  model.settings = {
    rolandModel: '00 00 00 65',
    tone: [{ name: 'filterCutoff', min: 0, max: 1023, message: { kind: 'roland-dt1', address: '02 10 00 4F', size: 4 } }],
  };
  return change(model) ?? model;
}

/** A data folder with the given models (by id), one instrument per entry of `entries` and the given sound catalogs (by model id). */
function dataFolderOf(t, models, entries, catalogs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-vocabulary-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: entries }));
  fs.mkdirSync(path.join(dir, 'models'));
  for (const model of models) fs.writeFileSync(path.join(dir, 'models', `${model.id}.json`), JSON.stringify(model));
  if (catalogs.length > 0) fs.mkdirSync(path.join(dir, 'catalogs'));
  for (const catalog of catalogs) fs.writeFileSync(path.join(dir, 'catalogs', `${catalog.model}.json`), JSON.stringify(catalog));
  return dir;
}

function dataFolder(t, model) {
  return dataFolderOf(t, [model], [{ id: 'synth', model: 'tonesynth', port: 'Port T' }]);
}

const checkCode = (code, rig) => checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });

test('the vocabulary names 309 tone settings, 13 part settings and 14 scene settings', () => {
  assert.deepEqual([...SETTING_LEVELS], ['tone', 'part', 'scene']);
  // The earlier 71 tone names, plus the 241 of a timbre with four partials that the map of the MT-32 holds minus the 3 that were
  // already names (partial 1 cutoff and level, the partial mute): 71 + 238. Two scene names are new: the master tune and the reverb time.
  assert.equal(SETTING_VOCABULARY.tone.length, 309);
  assert.equal(SETTING_VOCABULARY.part.length, 13);
  assert.equal(SETTING_VOCABULARY.scene.length, 14);
  for (const name of ['filterCutoff', 'osc1Wave', 'env1Attack', 'lfoRate', 'algorithm', 'op6Release', 'partial1Cutoff', 'toneCoarseTune', 'partialMute', 'partial1Level']) {
    assert.ok(SETTING_VOCABULARY.tone.includes(name), name);
  }
  assert.ok(Object.isFrozen(SETTING_VOCABULARY) && Object.isFrozen(SETTING_VOCABULARY.tone));
});

test('the timbre names are in the tone level, the system names in the scene level, and no name is twice, odd or longer than 40 characters', () => {
  for (const name of ['structure12', 'structure34', 'envMode', 'partial1CoarseTune', 'partial2Wave', 'partial3FilterEnvTime5', 'partial4AmpEnvSustain', 'keyShift', 'toneFineTune', 'bendRange', 'assignMode', 'toneReverbSwitch']) {
    assert.ok(SETTING_VOCABULARY.tone.includes(name), name);
  }
  for (const name of ['masterTune', 'reverbTime']) assert.ok(SETTING_VOCABULARY.scene.includes(name), name);
  // The four partials hold the same 58 settings; partial 1 cutoff and level were names before and stay in their old places.
  const partials = [1, 2, 3, 4].map((n) => SETTING_VOCABULARY.tone.filter((name) => name.startsWith(`partial${n}`)).map((name) => name.slice(`partial${n}`.length)));
  assert.equal(partials[0].length, 58);
  assert.equal(partials[0].includes('Cutoff') && partials[0].includes('Level'), true);
  for (const other of partials.slice(1)) assert.deepEqual([...other].sort(), [...partials[0]].sort());
  assert.ok(SETTING_VOCABULARY.tone.indexOf('partial1Cutoff') < SETTING_VOCABULARY.tone.indexOf('op1Level'), 'earlier names keep their place');
  for (const level of SETTING_LEVELS) {
    const names = SETTING_VOCABULARY[level];
    assert.equal(new Set(names).size, names.length, `${level}: a name twice`);
    for (const name of names) {
      assert.match(name, /^[a-z][A-Za-z0-9]*$/, name);
      assert.ok(name.length <= 40, name);
    }
  }
});

test('a model description is read and a wrong one is refused with the field and the reason', () => {
  assert.equal(parseModel(minimalModel()).ok, true);
  const typo = parseModel(minimalModel((model) => void (model.settings.tone[0].name = 'filterCutof')));
  assert.equal(typo.ok, false);
  assert.equal(typo.problems[0].field, 'settings.tone[0].name');
  assert.match(typo.problems[0].reason, /"filterCutof" is not a tone setting name/);
  const small = parseModel(minimalModel((model) => void (model.settings.tone[0].message.size = 1)));
  assert.equal(small.ok, false);
  assert.equal(small.problems[0].field, 'settings.tone[0].max');
  assert.match(small.problems[0].reason, /1023 is more than this message carries \(127\)/);
});

test('end to end: a setting goes from a model file in a data folder to a valid value or a refusal that lists what exists', (t) => {
  const dir = dataFolder(t, minimalModel());
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid');
  const message = rigMessage(state);
  assert.deepEqual(message.instruments[0].settings, {
    engines: [],
    rolandModel: [0, 0, 0, 101],
    nrpnFamily: null,
    tone: [{ name: 'filterCutoff', min: 0, max: 1023, message: { kind: 'roland-dt1', address: [2, 16, 0, 79], size: 4 } }],
    part: [],
    scene: [],
  });

  // A shipped model carries no settings.
  const shippedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-vocabulary-shipped-'));
  t.after(() => fs.rmSync(shippedDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shippedDir, 'instruments.json'), JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }] }));
  assert.equal(rigMessage(new RigStore({ dataDir: shippedDir }).read()).instruments[0].settings, null);

  // The message survives the wire, and a message without the field reads unreadable.
  const wire = JSON.parse(JSON.stringify(message));
  const rig = parseRigMessage(wire);
  assert.deepEqual(rig.instruments[0].settings.tone, [
    { name: 'filterCutoff', min: 0, max: 1023, message: { kind: 'roland-dt1', address: [2, 16, 0, 79], size: 4 } },
  ]);
  assert.deepEqual(rig.instruments[0].settings.rolandModel, [0, 0, 0, 101]);
  const old = structuredClone(wire);
  delete old.instruments[0].settings;
  assert.throws(() => parseRigMessage(old), /instruments\[0\]\.settings/);

  // The page reads the tone option of the call.
  const code = (value) => `note("c3").midi('Port T', { midichannel: 1, tone: { ${value} } })`;
  const read = readMidiSetup(code('filterCutoff: 600'), { parse });
  assert.equal(read.calls[0].settings.tone.get('filterCutoff'), 600);
  assert.equal(read.calls[0].problems.settings, null);

  const ok = checkCode(code('filterCutoff: 600'), rig);
  assert.equal(ok.refusal, null);
  assert.deepEqual([...ok.settings.keys()], ['synth:1']);
  assert.equal(ok.settings.get('synth:1').tone.get('filterCutoff'), 600);

  const typo = checkCode(code('filterCutof: 600'), rig).refusal.split('\n');
  assert.equal(typo[0], 'Unknown tone setting "filterCutof" for synth.');
  assert.ok(typo.includes('Settings in tone for synth: filterCutoff.'), typo.join('\n'));
  assert.equal(typo.at(-1), CLOSING_PLAYING);

  const high = checkCode(code('filterCutoff: 5000'), rig).refusal.split('\n');
  assert.equal(high[0], 'Setting "filterCutoff" in tone for synth must be a whole number from 0 to 1023.');
  assert.equal(high.at(-1), CLOSING_PLAYING);
});

test('end to end: a tone setting on a sound of another engine is refused naming both engines, from the catalog to the page', (t) => {
  const dir = dataFolderOf(t, [toneSynthModel()], [{ id: 'tonesynth', model: 'tonesynth', port: 'Port T' }], [toneSynthCatalog()]);
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const message = JSON.parse(JSON.stringify(rigMessage(state)));
  const sounds = message.instruments[0].sounds;
  const engineOfSound = (name) => sounds.melodic.find((sound) => sound.name === name).engine;
  assert.equal(engineOfSound('Own Tone'), 'model');
  assert.equal(engineOfSound('Model Tone'), 'model');
  assert.equal(engineOfSound('Core Tone'), 'core');
  assert.equal('engine' in sounds.melodic.find((sound) => sound.name === 'Loose Tone'), false, 'a sound in no engine has no engine key');
  assert.ok(sounds.rhythm.every((sound) => !('engine' in sound)), 'a drum kit never gets an engine');
  const rig = parseRigMessage(message);
  assert.equal(rig.instruments[0].sounds.melodic.find((sound) => sound.name === 'Core Tone').engine, 'core');

  const code = (sound, level) => `note("c3").midi('Port T', { midichannel: 1, sound: '${sound}', ${level} })`;
  const ok = checkCode(code('Model Tone', 'tone: { filterCutoff: 600 }'), rig);
  assert.equal(ok.refusal, null);
  const entry = ok.settings.get('tonesynth:1');
  assert.equal(entry.sound, 'Model Tone');
  assert.equal(entry.engine, 'model');
  assert.equal(entry.tone.get('filterCutoff'), 600);

  const lines = checkCode(code('Core Tone', 'tone: { filterCutoff: 600 }'), rig).refusal.split('\n');
  assert.equal(lines[0], '"filterCutoff" is a setting of Model Engine tones on tonesynth, and "Core Tone" is a Core Engine tone.');
  assert.equal(lines[1], 'tonesynth has no tone settings for Core Engine tones.');
  assert.equal(lines.at(-1), CLOSING_PLAYING);

  // Part settings are not checked against the engine.
  assert.equal(checkCode(code('Core Tone', 'part: { pan: 40 }'), rig).refusal, null);
});

// --- the description: every wrong form is refused when the model is read ---

/** The problems of the fixture after `change`, as "field: reason" lines. */
function problemsAfter(change, model = toneSynthModel()) {
  change(model);
  const result = parseModel(model);
  assert.equal(result.ok, false, 'expected the description to be refused');
  return result.problems.map((problem) => `${problem.field}: ${problem.reason}`);
}

function assertRefused(lines, field, start) {
  assert.ok(
    lines.some((line) => line.startsWith(`${field}: `) && line.slice(field.length + 2).startsWith(start)),
    `expected "${field}: ${start}..." in ${JSON.stringify(lines)}`,
  );
}

/** The engine synth on Port E read from a real data folder, as the page gets it after a trip over the wire. */
function engineMessageOf(t, change = () => {}) {
  const model = engineSynthModel();
  change(model);
  const dir = dataFolderOf(t, [model], [{ id: 'enginesynth', model: 'enginesynth', port: 'Port E' }], [engineSynthCatalog()]);
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return JSON.parse(JSON.stringify(rigMessage(state)));
}

test('the fixtures, the shipped models and the drum fixtures are valid descriptions', () => {
  assert.equal(parseModel(toneSynthModel()).ok, true);
  assert.equal(parseModel(ccSynthModel()).ok, true);
  assert.equal(parseModel(engineSynthModel()).ok, true, 'two rows of one name are allowed when their engines do not overlap');
  assert.equal(parseModel(bankDrumsModel()).ok, true);
  assert.equal(parseModel(gmDrumsModel()).ok, true);
  assert.ok(BUILT_IN_DRUM_MAPS.length > 0);
  assert.notEqual(toneSynthModel(), toneSynthModel(), 'each call returns a new object');
  assert.equal(toneSynthModel().settings.tone.length, 5);
});

test('a settings object that describes no setting is refused at settings', () => {
  assertRefused(problemsAfter((model) => void (model.settings = {})), 'settings', 'describes no setting');
  assertRefused(problemsAfter((model) => void (model.settings = { tone: [], part: [], scene: [] })), 'settings', 'describes no setting');
});

test('a name outside its level or the vocabulary is refused, with the level it belongs to or the closest name', () => {
  const part = problemsAfter((model) => void (model.settings.tone[0].name = 'pan'));
  assertRefused(part, 'settings.tone[0].name', '"pan" is a part setting name, not a tone one');
  const typo = problemsAfter((model) => void (model.settings.tone[0].name = 'filterCutof'));
  assertRefused(typo, 'settings.tone[0].name', '"filterCutof" is not a tone setting name');
  assert.ok(typo.some((line) => line.includes('filterCutoff')), 'names the closest');
  const far = problemsAfter((model) => void (model.settings.tone[0].name = 'zzzzzzzzzz'));
  assertRefused(far, 'settings.tone[0].name', '"zzzzzzzzzz" is not a tone setting name');
  assert.ok(!far.some((line) => line.includes('closest')), 'a name far from every name suggests none');
});

test('a name twice in one level is refused at the second row', () => {
  const lines = problemsAfter((model) => void model.settings.tone.push({ ...model.settings.tone[0] }));
  assertRefused(lines, 'settings.tone[5].name', 'same name as tone[0]');
});

test('one name may have one row per engine; a second row of a name whose engines overlap, or that names none, is refused at the second row', (t) => {
  const two = (change) => problemsAfter(change, engineSynthModel());
  // Core's cutoff row also claims the vintage engine, which already has its own filterCutoff row (tone[4]).
  const overlap = two((model) => void (model.settings.tone.push({ ...model.settings.tone[0], engines: ['model', 'vintage'] })));
  assertRefused(overlap, 'settings.tone[6].name', 'same name as tone[0], and both reach engine "model"');
  const withinOne = two((model) => void (model.settings.tone[4].engines = ['model']));
  assertRefused(withinOne, 'settings.tone[4].name', 'same name as tone[0], and both reach engine "model"');
  // The model declares no engines: the old rule stands, whatever the addresses are.
  const noEngines = two((model) => {
    delete model.settings.engines;
    for (const row of model.settings.tone) delete row.engines;
  });
  assertRefused(noEngines, 'settings.tone[4].name', 'same name as tone[0]');
  // A row with no engines in a model that declares engines is refused for it, and a part level never repeats a name.
  assertRefused(two((model) => void delete model.settings.tone[4].engines), 'settings.tone[4].engines', 'required: the model declares engines');
  assertRefused(two((model) => void model.settings.part.push({ ...model.settings.part[0] })), 'settings.part[1].name', 'same name as part[0]');
  // The page's strict reading says the same for a message that was changed after the server read it, with its own field path.
  const message = engineMessageOf(t);
  const tampered = structuredClone(message);
  tampered.instruments[0].settings.tone[4].engines = ['model'];
  assert.throws(() => parseRigMessage(tampered), /instruments\[0\]\.settings\.tone\[4\]\.name.*same name as tone\[0\], and both reach engine "model"/);
  const bare = structuredClone(message);
  delete bare.instruments[0].settings.tone[4].engines;
  assert.throws(() => parseRigMessage(bare), /instruments\[0\]\.settings\.tone\[4\]\.name.*same name as tone\[0\]/);
  assert.doesNotThrow(() => parseRigMessage(message));
});

test('a Roland data set needs an address of 3 or 4 bytes of at most 7F and the model ID', () => {
  const missing = problemsAfter((model) => void delete model.settings.tone[0].message.address);
  assertRefused(missing, 'settings.tone[0].message.address', 'required');
  const high = problemsAfter((model) => void (model.settings.tone[0].message.address = '02 10 00 80'));
  assertRefused(high, 'settings.tone[0].message.address', 'byte 3 (80) is above 7F');
  const long = problemsAfter((model) => void (model.settings.tone[0].message.address = '02 10 00 4F 00'));
  assertRefused(long, 'settings.tone[0].message.address', 'must be 3 or 4 bytes');
  // A shorter address would let the instrument read data bytes as address bytes. Three bytes are read: the instrument's
  // data sets take three or four, and a model ID Moontide knows takes one of them (checked below).
  for (const short of ['02 10', '02']) {
    assertRefused(problemsAfter((model) => void (model.settings.tone[0].message.address = short)), 'settings.tone[0].message.address', 'must be 3 or 4 bytes');
  }
  const three = timbreSynthModel();
  assert.equal(parseModel(three).ok, true, 'three bytes, for a model ID whose data sets take three');
  const bad = problemsAfter((model) => void (model.settings.tone[0].message.address = '02 1 00'));
  assertRefused(bad, 'settings.tone[0].message.address', '"1" is not a two-digit hex byte');
  const noModel = problemsAfter((model) => void delete model.settings.rolandModel);
  assertRefused(noModel, 'settings.rolandModel', 'required: a roland-dt1 setting needs the model ID');
  const badModel = problemsAfter((model) => void (model.settings.rolandModel = '00 00 00 65 00 00'));
  assertRefused(badModel, 'settings.rolandModel', 'must be 1 to 4 bytes');
  assertRefused(problemsAfter((model) => void (model.settings.rolandModel = '00 FF')), 'settings.rolandModel', 'byte 1 (FF) is above 7F');
});

test('a range with max below min, or above what the message carries, is refused at max', () => {
  const below = problemsAfter((model) => void ((model.settings.tone[0].min = 500), (model.settings.tone[0].max = 400)));
  assertRefused(below, 'settings.tone[0].max', 'must not be below min');
  const cc = problemsAfter((model) => void (model.settings.tone[0] = { name: 'filterCutoff', min: 0, max: 200, message: { kind: 'cc', cc: 74 } }), toneSynthModel());
  assertRefused(cc, 'settings.tone[0].max', '200 is more than this message carries (127)');
  // An NRPN set sends the data entry MSB only, so it carries 7 bits.
  const nrpn = problemsAfter((model) => void (model.settings.tone[0] = { name: 'filterCutoff', min: 0, max: 128, message: { kind: 'nrpn', msb: 1, lsb: 2 } }));
  assertRefused(nrpn, 'settings.tone[0].max', '128 is more than this message carries (127)');
  assertRefused(problemsAfter((model) => void (model.settings.tone[2].max = 16383), ccSynthModel()), 'settings.tone[2].max', '16383 is more than this message carries (127)');
  const two = problemsAfter((model) => void (model.settings.tone[4].max = 300));
  assertRefused(two, 'settings.tone[4].max', '300 is more than this message carries (255)');
  const one = problemsAfter((model) => void (model.settings.part[0].max = 128));
  assertRefused(one, 'settings.part[0].max', '128 is more than this message carries (127)');
});

test('a description the page could never send right is refused when it loads, not when the code first uses the setting', () => {
  // A row of the gs family takes the data of the family only: 14 to 114.
  assertRefused(problemsAfter((model) => void (model.settings.part[3].min = 13), offsetSynthModel()), 'settings.part[3].min', '13 is below the lowest value of the gs family (14)');
  assertRefused(problemsAfter((model) => void (model.settings.part[3].max = 115), offsetSynthModel()), 'settings.part[3].max', '115 is above the highest value of the gs family (114)');
  // NRPN rows need the family that says which pairs and values the instrument takes, as data sets need the model ID.
  assertRefused(problemsAfter((model) => void delete model.settings.nrpnFamily, offsetSynthModel()), 'settings.nrpnFamily', 'required: an nrpn setting needs the NRPN family');
  // An NRPN reaches one channel, so it is never a scene setting.
  const scene = problemsAfter((model) => void (model.settings.scene = [{ name: 'reverbLevel', min: 14, max: 114, message: { kind: 'nrpn', msb: 1, lsb: 0x20 } }]), offsetSynthModel());
  assertRefused(scene, 'settings.scene[0].message', 'an NRPN reaches one channel, so it is not a scene setting');
  // The data sets of a model ID whose temporary areas Moontide knows take one address length.
  assertRefused(problemsAfter((model) => void (model.settings.tone[0].message.address = '02 10 00')), 'settings.tone[0].message.address', 'must be 4 bytes: the data sets of model ID 00 00 00 65 take 4-byte addresses');
  assertRefused(problemsAfter((model) => void (model.settings.part[0].message.address = '03 00 00 08'), timbreSynthModel()), 'settings.part[0].message.address', 'must be 3 bytes: the data sets of model ID 16 take 3-byte addresses');
  // A model ID Moontide knows no temporary areas for takes either length: its settings are refused when they are built.
  const other = toneSynthModel();
  other.settings.rolandModel = '00 00 00 64';
  other.settings.tone[0].message.address = '02 10 00';
  assert.equal(parseModel(other).ok, true);
  // The fixtures stay valid.
  for (const model of [offsetSynthModel(), ccSynthModel(), toneSynthModel(), timbreSynthModel(), engineSynthModel()]) assert.equal(parseModel(model).ok, true, model.id);
});

test('the families and model IDs the server checks at load are the ones the page knows', () => {
  for (const [family, known] of Object.entries(KNOWN_NRPNS)) {
    assert.deepEqual(NRPN_FAMILY_RANGES[family], { min: known.min, max: known.max }, family);
    // The data entry MSB is the only value byte sent, so every family's range fits 7 bits.
    assert.ok(known.min >= 0 && known.max <= 127, family);
  }
  assert.deepEqual(Object.keys(NRPN_FAMILY_RANGES), Object.keys(KNOWN_NRPNS));
  assert.deepEqual(
    ROLAND_ADDRESS_SIZES.map((entry) => [entry.model, entry.size]),
    TEMPORARY_AREAS.map((area) => [[...area.model], area.addressSize]),
  );
});

test('the engines of a description: unique ids, a tone row names declared ones, part and scene rows name none', () => {
  const twice = problemsAfter((model) => void (model.settings.engines[1].id = 'model'));
  assertRefused(twice, 'settings.engines[1].id', 'same id as engines[0]');
  const sameName = problemsAfter((model) => void (model.settings.engines[1].name = model.settings.engines[0].name));
  assertRefused(sameName, 'settings.engines[1].name', 'same name as engines[0]');
  const none = problemsAfter((model) => void delete model.settings.tone[0].engines);
  assertRefused(none, 'settings.tone[0].engines', 'required: the model declares engines');
  const unknown = problemsAfter((model) => void (model.settings.tone[0].engines = ['model', 'ghost']));
  assertRefused(unknown, 'settings.tone[0].engines[1]', 'unknown engine "ghost", engines: model, core');
  const undeclared = problemsAfter((model) => void delete model.settings.engines);
  assertRefused(undeclared, 'settings.tone[0].engines', 'the model declares no engines');
  const part = problemsAfter((model) => void (model.settings.part[0].engines = ['model']));
  assertRefused(part, 'settings.part[0].engines', 'part settings reach every engine');
  const scene = problemsAfter((model) => void (model.settings.scene[0].engines = ['model']));
  assertRefused(scene, 'settings.scene[0].engines', 'scene settings reach every engine');
  const control = problemsAfter((model) => void (model.settings.engines[0].name = 'Bad\u0007Name'));
  assertRefused(control, 'settings.engines[0].name', 'contains a control character');
});

test('a model that describes the whole vocabulary fits the row limit of a level', () => {
  for (const level of SETTING_LEVELS) assert.ok(SETTING_VOCABULARY[level].length <= MAX_RIG_SETTINGS, level);
  const all = SETTING_LEVELS.reduce((sum, level) => sum + SETTING_VOCABULARY[level].length, 0);
  assert.ok(all <= MAX_RIG_SETTINGS, `tone, part and scene names together: ${all}`);
  // The limit is 512 because the MT-32 describes about 250 settings in one level.
  assert.equal(MAX_RIG_SETTINGS, 512);
});

test('a description with 300 tone rows reads valid, and 513 rows are refused by the shape', () => {
  // 300 vocabulary names read valid; past the 309 names there are, the extra rows carry made-up names, which the shape refuses too.
  const rows = (count) => Array.from({ length: count }, (_, index) => ({ name: SETTING_VOCABULARY.tone[index] ?? `row${index}`, min: 0, max: 1, message: { kind: 'cc', cc: 1 } }));
  const at = (count) => parseModel(minimalModel((model) => {
    model.settings.tone = rows(count);
    delete model.settings.engines;
  }));
  assert.equal(at(300).ok, true, JSON.stringify(at(300).problems));
  assert.equal(at(SETTING_VOCABULARY.tone.length).ok, true);
  const over = at(MAX_RIG_SETTINGS + 1);
  assert.equal(over.ok, false);
  assert.ok(over.problems.some((problem) => problem.field === 'settings.tone'), JSON.stringify(over.problems));
});

test('an unknown key, a bad message kind and too many rows are refused by the shape', () => {
  assertRefused(problemsAfter((model) => void (model.settings.extra = 1)), 'settings.extra', 'unknown field');
  assertRefused(problemsAfter((model) => void (model.settings.tone[0].message.kind = 'raw')), 'settings.tone[0].message.kind', 'Invalid');
  const rows = problemsAfter((model) => {
    model.settings.tone = Array.from({ length: MAX_RIG_SETTINGS + 1 }, (_, index) => ({ name: `row${index}`, min: 0, max: 1, message: { kind: 'cc', cc: 1 } }));
    delete model.settings.engines;
  });
  assert.ok(rows.some((line) => line.startsWith('settings.tone: ')), JSON.stringify(rows));
});

test('the timbre synth reads valid with a one-byte model ID and three-byte addresses, and its rig message carries them to the page', (t) => {
  const model = timbreSynthModel();
  assert.equal(parseModel(model).ok, true);
  // Every row of the layout: 241 tone rows, 2 part rows and 5 scene rows, each a name of its level.
  assert.deepEqual([model.settings.tone.length, model.settings.part.length, model.settings.scene.length], [241, 2, 5]);
  const toneRow = (name) => model.settings.tone.find((row) => row.name === name);
  for (const level of SETTING_LEVELS) {
    for (const row of model.settings[level]) assert.ok(SETTING_VOCABULARY[level].includes(row.name), `${level} ${row.name}`);
  }
  const state = new RigStore({ dataDir: dataFolderOf(t, [model], [{ id: 'timbresynth', model: 'timbresynth', port: 'Port B' }]) }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const settings = parseRigMessage(JSON.parse(JSON.stringify(rigMessage(state)))).instruments[0].settings;
  assert.deepEqual(settings.rolandModel, [0x16]);
  assert.deepEqual(settings.tone.find((row) => row.name === 'partial1Level').message.address, [0x04, 0x00, 0x37]);
  assert.deepEqual(settings.scene.find((row) => row.name === 'reverbLevel').message.address, [0x10, 0x00, 0x03]);
});

test('the timbre synth holds a row for every tone name of a timbre with four partials, and every other name of that layout, and no row twice', () => {
  const model = timbreSynthModel();
  const named = SETTING_VOCABULARY.tone.filter((name) => /^partial[1-4][A-Z]/.test(name) || ['structure12', 'structure34', 'partialMute', 'envMode', 'keyShift', 'toneFineTune', 'bendRange', 'assignMode', 'toneReverbSwitch'].includes(name));
  assert.equal(named.length, 241);
  assert.deepEqual(model.settings.tone.map((row) => row.name).sort(), [...named].sort());
  assert.deepEqual(model.settings.part.map((row) => row.name).sort(), ['level', 'pan']);
  assert.deepEqual(model.settings.scene.map((row) => row.name).sort(), ['level', 'masterTune', 'reverbLevel', 'reverbTime', 'reverbType']);
  // Addresses are unique inside a level, so no two rows write the same byte.
  for (const level of SETTING_LEVELS) {
    const addresses = model.settings[level].map((row) => row.message.address);
    assert.equal(new Set(addresses).size, addresses.length, level);
  }
  // The four partials hold the same 58 ranges, 58 bytes apart (3A hex).
  const partial = (n, name) => model.settings.tone.find((row) => row.name === `partial${n}${name}`);
  for (const name of ['Wave', 'Cutoff', 'AmpEnvSustain', 'PcmWave']) {
    for (let n = 2; n <= 4; n++) {
      assert.deepEqual([partial(n, name).min, partial(n, name).max], [partial(1, name).min, partial(1, name).max], name);
    }
  }
  assert.equal(partial(2, 'Wave').message.address, '04 00 4C');
  assert.equal(partial(3, 'Wave').message.address, '04 01 06');
  assert.equal(partial(4, 'Wave').message.address, '04 01 40');
  assert.equal(partial(4, 'AmpEnvSustain').message.address, '04 01 75');
});

test('the offset synth reads valid with eight offset part names, and its rig message carries the NRPN family the page reads strictly', (t) => {
  const model = offsetSynthModel();
  assert.equal(parseModel(model).ok, true);
  assert.deepEqual(SETTING_VOCABULARY.part.slice(5), [
    'vibratoRateOffset', 'vibratoDepthOffset', 'vibratoDelayOffset', 'cutoffOffset', 'resonanceOffset', 'attackOffset', 'decayOffset', 'releaseOffset',
  ]);
  assert.deepEqual(model.settings.part.map((row) => row.name), SETTING_VOCABULARY.part.slice(5));
  const state = new RigStore({ dataDir: dataFolderOf(t, [model], [{ id: 'offsetsynth', model: 'offsetsynth', port: 'Port O' }]) }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const message = JSON.parse(JSON.stringify(rigMessage(state)));
  const settings = message.instruments[0].settings;
  assert.equal(settings.nrpnFamily, 'gs');
  assert.equal(settings.rolandModel, null);
  assert.deepEqual(settings.part[3], { name: 'cutoffOffset', min: 14, max: 114, message: { kind: 'nrpn', msb: 1, lsb: 32 } });
  assert.equal(parseRigMessage(message).instruments[0].settings.nrpnFamily, 'gs');
  // A model with no NRPN row and no family carries null; NRPN rows with no family are refused when the model loads; a family the
  // server does not know is refused by the shape.
  const bareState = new RigStore({ dataDir: dataFolderOf(t, [toneSynthModel()], [{ id: 'tonesynth', model: 'tonesynth', port: 'Port O' }]) }).read();
  assert.equal(rigMessage(bareState).instruments[0].settings.nrpnFamily, null);
  const bare = offsetSynthModel();
  delete bare.settings.nrpnFamily;
  assert.equal(parseModel(bare).ok, false);
  const unknown = offsetSynthModel();
  unknown.settings.nrpnFamily = 'xg';
  const refused = parseModel(unknown);
  assert.equal(refused.ok, false);
  assert.equal(refused.problems[0].field, 'settings.nrpnFamily');
  // The offsets are described as part settings: a model that files one under the tone level is told where it belongs.
  const wrongLevel = offsetSynthModel();
  wrongLevel.settings.tone = [wrongLevel.settings.part.shift()];
  const levelProblem = parseModel(wrongLevel);
  assert.equal(levelProblem.ok, false);
  assert.match(levelProblem.problems[0].reason, /"vibratoRateOffset" is a part setting name, not a tone one/);
});

test('every name ending in Offset is a part name, and every offset row of the offset synth uses one', () => {
  const ending = (names) => names.filter((name) => name.endsWith('Offset'));
  assert.deepEqual(ending(SETTING_VOCABULARY.tone), [], 'no tone name ends in Offset');
  assert.deepEqual(ending(SETTING_VOCABULARY.scene), [], 'no scene name ends in Offset');
  assert.equal(ending(SETTING_VOCABULARY.part).length, 8);
  const rows = offsetSynthModel().settings.part;
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.ok(row.name.endsWith('Offset'), `${row.name} is an offset row without the ending`);
    assert.equal(row.message.kind, 'nrpn');
    assert.ok(SETTING_VOCABULARY.part.includes(row.name), `${row.name} is a part name`);
    assert.equal(row.min, 14);
    assert.equal(row.max, 114);
    assert.ok(row.min <= 64 && 64 <= row.max, 'the value that changes nothing lies inside the range');
  }
});

// --- the names do not depend on the message kind ---

test('the same names mapped to control changes and an NRPN read valid, and the same code passes on both instruments', (t) => {
  // Both instruments have a sound of this name in their sound list; the Roland one is placed in an engine, so its tone settings are allowed.
  const portCode = (port) => `note("c3").midi('${port}', { midichannel: 1, sound: 'Model Tone', tone: { filterCutoff: 100 }, part: { level: 90 } })`;
  const dir = dataFolderOf(
    t,
    [toneSynthModel(), ccSynthModel()],
    [
      { id: 'synth', model: 'tonesynth', port: 'Port T' },
      { id: 'ccsynth', model: 'ccsynth', port: 'Port C' },
    ],
    [toneSynthCatalog(), { model: 'ccsynth', source: 'Test sound list', sounds: [{ name: 'Model Tone', program: 0 }] }],
  );
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  const message = JSON.parse(JSON.stringify(rigMessage(state)));
  const rig = parseRigMessage(message);
  // The code differs only by its port; the words after it are the same bytes.
  assert.equal(portCode('Port T').replace('Port T', 'Port C'), portCode('Port C'));
  assert.equal(checkCode(portCode('Port T'), rig).refusal, null);
  assert.equal(checkCode(portCode('Port C'), rig).refusal, null);
  // The page gets the name, the range and the message of each row, copied key by key: no other key of the model file rides along.
  const rowKeys = new Set(['name', 'min', 'max', 'engines', 'message']);
  const messageKeys = { 'roland-dt1': ['address', 'kind', 'size'], nrpn: ['kind', 'lsb', 'msb'], cc: ['cc', 'kind'] };
  for (const instrument of message.instruments) {
    for (const level of ['tone', 'part', 'scene']) {
      for (const row of instrument.settings[level]) {
        assert.ok(Object.keys(row).every((key) => rowKeys.has(key)), JSON.stringify(row));
        assert.deepEqual(Object.keys(row.message).sort(), messageKeys[row.message.kind], JSON.stringify(row.message));
      }
    }
  }
  // A value beyond what the control change carries is refused with its range; the Roland one takes it.
  const wide = (port) => `note("c3").midi('${port}', { midichannel: 1, sound: 'Model Tone', tone: { filterCutoff: 200 } })`;
  assert.equal(checkCode(wide('Port T'), rig).refusal, null);
  const lines = checkCode(wide('Port C'), rig).refusal.split('\n');
  assert.equal(lines[0], 'Setting "filterCutoff" in tone for ccsynth must be a whole number from 0 to 127.');
  // The engines of the Roland instrument reach the page for the later engine check.
  assert.deepEqual(message.instruments[0].settings.engines, [
    { id: 'model', name: 'Model Engine' },
    { id: 'core', name: 'Core Engine' },
  ]);
  assert.deepEqual(message.instruments[0].settings.tone[0], {
    name: 'filterCutoff',
    min: 0,
    max: 1023,
    engines: ['model'],
    message: { kind: 'roland-dt1', address: [2, 16, 0, 79], size: 4 },
  });
  assert.deepEqual(message.instruments[1].settings.tone[0].message, { kind: 'cc', cc: 74 });
  assert.deepEqual(message.instruments[1].settings.tone[2].message, { kind: 'nrpn', msb: 1, lsb: 99 });
  assert.equal(message.instruments[1].settings.rolandModel, null);
  assert.deepEqual(message.instruments[1].settings.engines, []);
  assert.equal('engines' in message.instruments[1].settings.tone[0], false);
});
