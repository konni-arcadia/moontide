import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as instruments from '../dist/instruments.js';
import { BUILT_IN_DRUM_MAPS, GENERAL_MIDI_MAP_ID, drumMapById, kitDrumMap, mapsToSend, unknownMapReason } from '../dist/drum-maps.js';
import { drumMapFor, parseRigMessage } from '../page/midi-rig.js';
import { DRUM_MAP_CASES } from './drum-fixtures.js';

// Which note plays which drum. Every test works on a temp data folder, never the user's real one.

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-drum-maps-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const OPTIONS = { connection: () => 'unknown', shipped: [], dataDirText: 'the data folder' };

test('the MT-32 map reaches Claude and the page', (t) => {
  const dataDir = makeDir(t, { 'instruments.json': { instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }] } });
  const state = new instruments.RigStore({ dataDir }).read();
  assert.equal(state.setup, 'valid');

  const rigText = instruments.describeRig(state, OPTIONS);
  const rigLines = rigText.split('\n');
  assert.ok(
    rigLines.includes('  Drum map: "Roland MT-32 Rhythm" (34 notes). get_midi_instruments with instrument "mt32" lists the notes.'),
    rigText,
  );
  assert.ok(rigText.endsWith("One instrument's full sound list: get_midi_instruments with instrument set to its id."));

  const listText = instruments.describeInstrument(state, 'mt32', OPTIONS);
  assert.ok(listText.includes('Rhythm, channel 10:\nno sounds to choose.'), listText);
  const mapLine = listText.split('\n').find((line) => line.startsWith('Drum map "Roland MT-32 Rhythm" (34 notes): '));
  assert.ok(mapLine !== undefined, listText);
  assert.ok(mapLine.startsWith('Drum map "Roland MT-32 Rhythm" (34 notes): 35 Acoustic Bass Drum, 36 Acoustic Bass Drum, 37 Rim Shot,'), mapLine);
  assert.ok(mapLine.endsWith('73 Quijada, 75 Claves'), mapLine);

  const rig = parseRigMessage(instruments.rigMessage(state));
  const [mt32] = rig.instruments;
  assert.equal(mt32.drumMap, 'mt32-rhythm');
  assert.equal(mt32.drumMaps.length, 1);
  assert.equal(mt32.drumMaps[0].notes.length, 34);
  const known = drumMapFor(mt32, null);
  assert.equal(known.state, 'known');
  assert.equal(known.via, 'model');
  assert.equal(known.map.id, 'mt32-rhythm');
  assert.deepEqual(drumMapFor(mt32, 'Any Kit'), { state: 'unknown', via: 'kit' });
});

// --- the map data, read from the shipped files and the built-in map ---

const readShipped = (id) => JSON.parse(fs.readFileSync(new URL(`../instruments/${id}.json`, import.meta.url), 'utf8'));
const mapOf = (model, id) => model.drumMaps.find((map) => map.id === id);
const noteNumbers = (map) => map.notes.map((entry) => entry.note);
const nameAt = (map, note) => map.notes.find((entry) => entry.note === note)?.name;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

test('the built-in General MIDI map has 47 notes, 35 to 81, each once', () => {
  const [map] = BUILT_IN_DRUM_MAPS;
  assert.equal(BUILT_IN_DRUM_MAPS.length, 1);
  assert.equal(map.id, GENERAL_MIDI_MAP_ID);
  assert.equal(map.name, 'General MIDI');
  assert.deepEqual(noteNumbers(map), range(35, 81));
  assert.equal(nameAt(map, 36), 'Bass Drum 1');
  assert.equal(nameAt(map, 38), 'Acoustic Snare');
  assert.equal(nameAt(map, 42), 'Closed Hi-Hat');
  assert.equal(nameAt(map, 44), 'Pedal Hi-Hat');
  assert.equal(nameAt(map, 46), 'Open Hi-Hat');
  assert.ok(Object.isFrozen(BUILT_IN_DRUM_MAPS) && Object.isFrozen(map) && Object.isFrozen(map.notes));
});

test('the SC-55 gs-standard map has 61 notes from 27 to 87, every key', () => {
  const standard = mapOf(readShipped('sc55'), 'gs-standard');
  assert.equal(standard.name, 'Roland GS Standard');
  assert.deepEqual(noteNumbers(standard), range(27, 87));
  assert.equal(nameAt(standard, 36), 'Kick Drum 1');
  assert.equal(nameAt(standard, 82), 'Shaker');
});

test("gs-orchestra differs from gs-standard exactly at the manual's replaced keys, plus 88", () => {
  const sc55 = readShipped('sc55');
  const standard = mapOf(sc55, 'gs-standard');
  const orchestra = mapOf(sc55, 'gs-orchestra');
  assert.equal(orchestra.name, 'Roland GS Orchestra');
  assert.deepEqual(noteNumbers(orchestra), range(27, 88));
  const replaced = [27, 28, 29, 30, 35, 36, 38, 39, 40, ...range(41, 53), 57, 59, 88];
  const differing = orchestra.notes.filter((entry) => nameAt(standard, entry.note) !== entry.name).map((entry) => entry.note);
  assert.deepEqual(differing, replaced);
  const expected = new Map([
    [27, 'Closed Hi-Hat'], [28, 'Pedal Hi-Hat'], [29, 'Open Hi-Hat'], [30, 'Ride Cymbal'], [35, 'Concert BD 2'], [36, 'Concert BD 1'],
    [38, 'Concert SD'], [39, 'Castanets'], [40, 'Concert SD'], [41, 'Timpani F'], [42, 'Timpani F#'], [43, 'Timpani G'], [44, 'Timpani G#'],
    [45, 'Timpani A'], [46, 'Timpani A#'], [47, 'Timpani B'], [48, 'Timpani c'], [49, 'Timpani c#'], [50, 'Timpani d'], [51, 'Timpani d#'],
    [52, 'Timpani e'], [53, 'Timpani f'], [57, 'Concert Cymbal 2'], [59, 'Concert Cymbal 1'], [88, 'Applause'],
  ]);
  for (const [note, name] of expected) assert.equal(nameAt(orchestra, note), name, String(note));
});

test('gs-sfx has 46 notes, every key from 39 to 84', () => {
  const sfx = mapOf(readShipped('sc55'), 'gs-sfx');
  assert.equal(sfx.name, 'Roland GS SFX');
  assert.deepEqual(noteNumbers(sfx), range(39, 84));
  assert.equal(nameAt(sfx, 39), 'High Q');
  assert.equal(nameAt(sfx, 84), 'Bubble');
});

test('cm-64-32l has 67 notes from 35 to 108 and its keys 35 to 75 equal mt32-rhythm key for key', () => {
  const cm = mapOf(readShipped('sc55'), 'cm-64-32l');
  const mt32 = mapOf(readShipped('mt32'), 'mt32-rhythm');
  assert.equal(cm.name, 'Roland CM-64/32L');
  assert.equal(cm.notes.length, 67);
  assert.equal(Math.min(...noteNumbers(cm)), 35);
  assert.equal(Math.max(...noteNumbers(cm)), 108);
  for (const absent of [34, 52, 53, 55, 57, 58, 59, 74]) assert.equal(nameAt(cm, absent), undefined, String(absent));
  assert.deepEqual(cm.notes.filter((entry) => entry.note <= 75), mt32.notes);
  assert.equal(mt32.name, 'Roland MT-32 Rhythm');
  assert.equal(mt32.notes.length, 34);
});

test('the SC-55 names gs-standard as its map and gives three kits their own', () => {
  const sc55 = readShipped('sc55');
  assert.equal(sc55.drumMap, 'gs-standard');
  assert.equal(sc55.drumMaps.length, 4);
  assert.equal(sc55.bankSelect, 'msb');
  assert.equal(sc55.rhythmBank, undefined);
  const own = sc55.sounds.rhythm.filter((sound) => sound.noteMap !== undefined).map((sound) => `${sound.name}>${sound.noteMap}`);
  assert.deepEqual(own, ['Orchestra Set>gs-orchestra', 'SFX Set>gs-sfx', 'CM-64/32L Set>cm-64-32l']);
  assert.equal(sc55.sounds.rhythm.length, 10);
});

// --- one table of cases for the server rule and the page rule ---

function resolveOnServer(testCase) {
  const kit = testCase.kit === null ? null : (testCase.kits.find((entry) => entry.name === testCase.kit) ?? null);
  return kitDrumMap(testCase.model, kit);
}

test('DRUM_MAP_CASES: the server rule says known or unknown, never a General MIDI guess', () => {
  for (const testCase of DRUM_MAP_CASES.filter((entry) => entry.pageOnly !== true)) {
    const use = resolveOnServer(testCase);
    assert.equal(use.state, testCase.state, testCase.name);
    assert.equal(use.via, testCase.via, testCase.name);
    assert.equal(use.state === 'known' ? use.map.id : null, testCase.id, testCase.name);
  }
});

test('kitDrumMap throws for a kit naming a map the model lacks, and mapsToSend sends only the maps in play', () => {
  assert.throws(() => kitDrumMap({ drumMaps: [] }, { noteMap: 'nope' }), /"nope"/);
  assert.equal(drumMapById([], 'nope'), null);
  assert.deepEqual(mapsToSend({}, [{ noteMap: null }]), []);
  assert.deepEqual(mapsToSend({ drumMap: 'general-midi' }, []).map((map) => map.id), ['general-midi']);
  const own = { id: 'own-a', name: 'Own A', notes: [{ note: 36, name: 'First' }] };
  assert.deepEqual(mapsToSend({ drumMaps: [own], drumMap: 'general-midi' }, [{ noteMap: 'general-midi' }]).map((map) => map.id), ['own-a', 'general-midi']);
  assert.equal(unknownMapReason([own], 'x'), 'unknown drum map "x", this model has: own-a; built in: general-midi');
  assert.equal(unknownMapReason([], 'x'), 'unknown drum map "x", this model has: none; built in: general-midi');
});
