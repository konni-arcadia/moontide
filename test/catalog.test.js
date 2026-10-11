import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as instruments from '../dist/instruments.js';
import * as catalog from '../dist/catalog.js';
import { Session } from '../dist/session.js';
import { STEERING_WORDS, TINT_WORDS, findWords } from './tint-rules.js';
import { bankDrumsModel } from './drum-fixtures.js';

// Every problem of a catalog file is a field and a reason, and the search ranks, caps and
// refuses as stated. Every test works on a temp data folder: never the user's real one. Names are
// made up and neutral; no real patch list is used anywhere.

const { RigStore } = instruments;
const { readCatalogFile, parseCatalog, flattenCatalogPart, summarizeCatalog } = catalog;

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-catalog-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function assertProblem(problems, field, reason) {
  assert.ok(
    problems.some((problem) => problem.field === field && problem.reason === reason),
    `expected "${field} · ${reason}" in ${JSON.stringify(problems)}`,
  );
}

const userModel = {
  id: 'synth',
  name: 'Test Synth',
  channels: { melodic: [1, 2], rhythm: [10] },
  bankSelect: 'msb-lsb',
  defaultVolume: 100,
  controls: [],
  sounds: { melodic: [{ name: 'Alpha 1', program: 0 }], rhythm: [{ name: 'Kit 1', program: 0 }] },
  notes: [],
};

/** The model `id` as a RigStore resolves it (a shipped one, or the user model above). */
function modelOf(t, id) {
  const dir = makeDir(t, { 'instruments.json': { instruments: [{ id, model: id, port: 'Port A' }] }, 'models/synth.json': userModel });
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return state.instruments[0].model;
}

const sound = (name, extra = {}) => ({ name, program: 1, ...extra });
const file = (model, sounds, extra = {}) => ({ model: model.id, source: 'test fixture', sounds, ...extra });

/** Reads catalogs/<model id>.json from a temp folder holding `content`. */
function readOf(t, model, content) {
  return readCatalogFile(makeDir(t, { [`catalogs/${model.id}.json`]: content }), model);
}

function problemsOf(result) {
  assert.equal(result.catalog, null, 'a broken catalog is not attached');
  assert.ok(result.problems.length > 0, 'a problem is reported');
  return result.problems;
}

test('a valid catalog is read with its sounds, and a file of a model with no catalog is no catalog and no problem', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const read = readOf(t, sc55, file(sc55, [sound('Alpha 1', { category: 'Group A', bank: { msb: 8 } }), sound('Beta 2')]));
  assert.deepEqual(read.problems, []);
  assert.equal(read.catalog.sounds.length, 2);
  assert.equal(read.catalog.source, 'test fixture');
  assert.deepEqual(readCatalogFile(makeDir(t), sc55), { catalog: null, problems: [] }, 'no catalogs folder');
  assert.deepEqual(readCatalogFile(makeDir(t, { 'catalogs/mt32.json': {} }), sc55), { catalog: null, problems: [] }, 'another model has a file');
});

test('a missing field is required, an extra key is an unknown field, and the file is named in the field', (t) => {
  const sc55 = modelOf(t, 'sc55');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [{ program: 1 }]))), 'catalogs/sc55.json:sounds[0].name', 'required');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1', { colour: 'x' })]))), 'catalogs/sc55.json:sounds[0].colour', 'unknown field');
  assertProblem(problemsOf(readOf(t, sc55, { model: 'sc55', sounds: [sound('Alpha 1')] })), 'catalogs/sc55.json:source', 'required');
  assertProblem(problemsOf(readOf(t, sc55, { ...file(sc55, [sound('Alpha 1')]), extra: 1 })), 'catalogs/sc55.json:extra', 'unknown field');
});

test('an empty list, a root array and a program above 127 are named', (t) => {
  const sc55 = modelOf(t, 'sc55');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, []))), 'catalogs/sc55.json:sounds', 'at least one sound is required');
  assertProblem(problemsOf(readOf(t, sc55, '[]')), 'catalogs/sc55.json', 'must be an object');
  const problems = problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1', { program: 128 })])));
  assert.ok(problems.some((problem) => problem.field === 'catalogs/sc55.json:sounds[0].program'), JSON.stringify(problems));
});

test('at most 5000 sounds: 5000 are valid and 5001 are one problem', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const many = (count) => Array.from({ length: count }, (_, index) => sound(`Tone ${index}`));
  assert.equal(readOf(t, sc55, file(sc55, many(5000))).catalog.sounds.length, 5000);
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, many(5001)))), 'catalogs/sc55.json:sounds', 'at most 5000 sounds');
});

test('name, category and source lengths: 80, 60 and 200 characters are valid, one more is a problem, empty is a problem', (t) => {
  const sc55 = modelOf(t, 'sc55');
  assert.deepEqual(readOf(t, sc55, file(sc55, [sound('n'.repeat(80), { category: 'c'.repeat(60) })], { source: 's'.repeat(200) })).problems, []);
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('n'.repeat(81))]))), 'catalogs/sc55.json:sounds[0].name', 'at most 80 characters');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('')]))), 'catalogs/sc55.json:sounds[0].name', 'must not be empty');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1', { category: 'c'.repeat(61) })]))), 'catalogs/sc55.json:sounds[0].category', 'at most 60 characters');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1')], { source: 's'.repeat(201) }))), 'catalogs/sc55.json:source', 'at most 200 characters');
});

test('the model inside the file must be the file name', (t) => {
  const sc55 = modelOf(t, 'sc55');
  assertProblem(problemsOf(readOf(t, sc55, { ...file(sc55, [sound('Alpha 1')]), model: 'mt32' })), 'catalogs/sc55.json:model', 'must equal the file name ("sc55")');
  const bare = parseCatalog({ ...file(sc55, [sound('Alpha 1')]), model: 'mt32' }, sc55);
  assert.equal(bare.ok, false);
  assertProblem(bare.problems, 'model', 'must be the id of the model it extends ("sc55")');
});

test('two names with one sound key are a problem at the second, whatever the case and spacing', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const problems = problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1'), sound('alpha  1')])));
  assertProblem(problems, 'catalogs/sc55.json:sounds[1].name', 'same name as sounds[0] ("Alpha 1")');
});

test("a name of the model's own melodic sounds is a problem; a name of its rhythm sounds is not", (t) => {
  const synth = modelOf(t, 'synth');
  assertProblem(problemsOf(readOf(t, synth, file(synth, [sound('ALPHA 1')]))), 'catalogs/synth.json:sounds[0].name', 'same name as a sound of model synth ("Alpha 1")');
  assert.deepEqual(readOf(t, synth, file(synth, [sound('Kit 1')])).problems, [], 'the catalog is melodic only');
});

test('a bank is checked against the bank select of the model', (t) => {
  const mt32 = modelOf(t, 'mt32');
  const sc55 = modelOf(t, 'sc55');
  const synth = modelOf(t, 'synth');
  assertProblem(problemsOf(readOf(t, mt32, file(mt32, [sound('Alpha 1', { bank: { msb: 1 } })]))), 'catalogs/mt32.json:sounds[0].bank', 'this model has no bank select');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1', { bank: { msb: 1, lsb: 2 } })]))), 'catalogs/sc55.json:sounds[0].bank.lsb', 'this model takes a bank MSB only');
  assert.deepEqual(readOf(t, sc55, file(sc55, [sound('Alpha 1', { bank: { msb: 1 } })])).problems, []);
  assert.deepEqual(readOf(t, synth, file(synth, [sound('Beta 2', { bank: { msb: 1, lsb: 2 } }), sound('Gamma 3', { bank: { msb: 1 } }), sound('Delta 4')])).problems, []);
});

test('a control character in a name, a category or the source is a problem at that field', (t) => {
  const sc55 = modelOf(t, 'sc55');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha\n1')]))), 'catalogs/sc55.json:sounds[0].name', 'contains a control character');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1', { category: 'Group\u0007A' })]))), 'catalogs/sc55.json:sounds[0].category', 'contains a control character');
  assertProblem(problemsOf(readOf(t, sc55, file(sc55, [sound('Alpha 1')], { source: 'a\u2028b' }))), 'catalogs/sc55.json:source', 'contains a control character');
});

test('an empty file, text that is not JSON and a file over 2 MiB are named', (t) => {
  const sc55 = modelOf(t, 'sc55');
  assertProblem(problemsOf(readOf(t, sc55, '  \n')), 'catalogs/sc55.json', 'the file is empty');
  const broken = problemsOf(readOf(t, sc55, '{'));
  assert.equal(broken[0].field, 'catalogs/sc55.json');
  assert.ok(broken[0].reason.startsWith('not valid JSON'), broken[0].reason);
  assertProblem(problemsOf(readOf(t, sc55, `{"pad":"${'x'.repeat(2 * 1048576)}"}`)), 'catalogs/sc55.json', 'the file is larger than 2 MiB');
});

test('a byte order mark before valid JSON reads as valid', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const read = readOf(t, sc55, `﻿${JSON.stringify(file(sc55, [sound('Alpha 1')]))}`);
  assert.deepEqual(read.problems, []);
  assert.equal(read.catalog.sounds.length, 1);
});

test('a folder named like the catalog file is a read problem with the error code only', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const dir = makeDir(t);
  fs.mkdirSync(path.join(dir, 'catalogs', 'sc55.json'), { recursive: true });
  assertProblem(problemsOf(readCatalogFile(dir, sc55)), 'catalogs/sc55.json', 'could not be read: EISDIR');
});

test('a catalog written with the importer layout of one sound per line is read like any other', (t) => {
  const mt32 = modelOf(t, 'mt32');
  const text = `{"model":"mt32","source":"fixture","sounds":[\n${[sound('Alpha 1'), sound('Beta 2')].map((entry) => JSON.stringify(entry)).join(',\n')}\n]}\n`;
  assert.equal(readOf(t, mt32, text).catalog.sounds.length, 2);
});

// --- the search: ranking, cap, refusals ---

const { searchCatalog, searchReply, catalogLine, categoryCounts, categoryList } = catalog;

/** A catalog value from [name, category?, extra?] rows, programs counting up from 0. */
const catalogFrom = (rows, extra = {}) => ({
  model: 'sc55',
  source: 'test fixture',
  sounds: rows.map(([name, category, more], index) => ({ name, program: index % 128, ...(category === undefined ? {} : { category }), ...more })),
  ...extra,
});
const namesOf = (result) => result.matches.map((match) => match.name);

const BELLS = catalogFrom([
  ['Glass Bell'],
  ['Bell'],
  ['Bell Tower'],
  ['Old Bell', 'Group B'],
  ['Chime', 'Bell Set'],
  ['Pad Drone', 'Group B'],
]);

test('the search ranks the exact name, then names that start with the words, then names that contain them, then category matches', () => {
  assert.deepEqual(namesOf(searchCatalog(BELLS, { query: 'bell' })), ['Bell', 'Bell Tower', 'Glass Bell', 'Old Bell', 'Chime']);
  assert.equal(searchCatalog(BELLS, { query: 'bell' }).total, 5);
});

test('words come in any order, and case and spaces do not matter', () => {
  assert.deepEqual(namesOf(searchCatalog(BELLS, { query: 'TOWER   bell' })), ['Bell Tower']);
  assert.deepEqual(namesOf(searchCatalog(BELLS, { query: 'belltower' })), ['Bell Tower']);
  assert.deepEqual(namesOf(searchCatalog(BELLS, { query: 'bell chime' })), ['Chime'], 'one word in the name, one in the category');
  assert.equal(searchCatalog(BELLS, { query: 'violin' }).total, 0);
});

test('ties inside a tier keep the catalog order', () => {
  const same = catalogFrom([['Zed Bell'], ['Alpha Bell'], ['Bell Two'], ['Bell One']]);
  assert.deepEqual(namesOf(searchCatalog(same, { query: 'bell' })), ['Bell Two', 'Bell One', 'Zed Bell', 'Alpha Bell']);
});

test('a category keeps only its sounds, case and spaces ignored, with or without words', () => {
  assert.deepEqual(namesOf(searchCatalog(BELLS, { query: 'bell', category: 'group  b' })), ['Old Bell']);
  assert.deepEqual(namesOf(searchCatalog(BELLS, { category: 'GROUP B' })), ['Old Bell', 'Pad Drone'], 'a category alone lists its sounds in catalog order');
  const unknown = searchCatalog(BELLS, { category: 'Group Z' });
  assert.equal(unknown.unknownCategory, true);
  assert.equal(unknown.total, 0);
  assert.equal(searchCatalog(BELLS, { category: 'Group B' }).unknownCategory, false);
  assert.equal(searchCatalog(BELLS, { query: 'bell' }).unknownCategory, false);
});

const many = (count) => catalogFrom(Array.from({ length: count }, (_, index) => [`Tone ${String(index).padStart(3, '0')}`, 'Group A']));
const replyOf = (value, search) => searchReply({ id: 'sc55', modelName: 'Test Model', catalog: value, result: searchCatalog(value, search) });

test('30 matches answer 25 match lines then "5 more, refine your search."', () => {
  const lines = replyOf(many(30), { query: 'tone' }).split('\n');
  assert.equal(lines[0], 'Catalog of "sc55" (Test Model), from "test fixture": 30 sounds; programs as sent (0-127).');
  assert.equal(lines[1], '30 matches, first 25:');
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 25);
  assert.equal(lines.at(-1), '5 more, refine your search.');
});

test('exactly 25 matches answer 25 lines and no "more" line, and one match says "1 match:"', () => {
  const lines = replyOf(many(25), { query: 'tone' }).split('\n');
  assert.equal(lines[1], '25 matches:');
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 25);
  assert.ok(!lines.some((line) => line.includes('refine your search')));
  const one = replyOf(many(30), { query: 'tone 007' }).split('\n');
  assert.equal(one[1], '1 match:');
  assert.equal(one[2], '- "Tone 007": program 7, category "Group A"');
});

test('a match line holds only the name, the program, the bank and the category, in that order', () => {
  const value = catalogFrom([['Alpha 1', 'Group A', { bank: { msb: 8 } }], ['Beta 2', undefined, { bank: { msb: 8, lsb: 3 } }], ['Gamma 3']]);
  const lines = replyOf(value, { query: 'a' }).split('\n').filter((line) => line.startsWith('- '));
  assert.deepEqual(lines, ['- "Alpha 1": program 0, bank 8, category "Group A"', '- "Beta 2": program 1, bank 8/3', '- "Gamma 3": program 2']);
  const pattern = /^- "(?:[^"\\]|\\.)*": program \d+(?:, bank \d+(?:\/\d+)?)?(?:, category "(?:[^"\\]|\\.)*")?$/;
  for (const line of lines) assert.match(line, pattern);
});

test('a search that matches nothing says so and lists the categories, at most 30, or says there are none', () => {
  const grouped = catalogFrom([['Alpha 1', 'Group A'], ['Beta 2', 'Group A'], ['Gamma 3', 'Group B']]);
  assert.deepEqual(replyOf(grouped, { query: 'zzz' }).split('\n').slice(1), ['No sound matches.', 'Categories: "Group A" (2), "Group B" (1).']);
  const bare = catalogFrom([['Alpha 1']]);
  assert.deepEqual(replyOf(bare, { query: 'zzz' }).split('\n').slice(1), ['No sound matches.', 'The catalog has no categories.']);
  const wide = catalogFrom(Array.from({ length: 31 }, (_, index) => [`Tone ${index}`, `Group ${String(index + 1).padStart(2, '0')}`]));
  const text = replyOf(wide, { query: 'zzz' }).split('\n')[2];
  assert.ok(text.startsWith('Categories: "Group 01" (1), '), text);
  assert.ok(text.endsWith('"Group 30" (1), and 1 more.'), text);
});

test('a shown name with a single quote or a backslash adds the line about the backslash, and no other name does', () => {
  const quoted = catalogFrom([["Dan's Bell"], ['Plain Bell']]);
  const lines = replyOf(quoted, { query: 'bell' }).split('\n');
  assert.equal(lines.at(-1), "A name with ' or \\ takes a backslash before that character inside the single quotes of the code.");
  assert.ok(!replyOf(catalogFrom([['Plain Bell']]), { query: 'bell' }).includes('backslash'));
  assert.ok(replyOf(catalogFrom([['Back\\slash']]), { query: 'back' }).includes('backslash'));
});

test('the categories are counted in first-seen order, one per sound key', () => {
  const value = catalogFrom([['A 1', 'Group B'], ['A 2', 'Group A'], ['A 3', 'group  b'], ['A 4']]);
  assert.deepEqual(categoryCounts(value), [
    { name: 'Group B', count: 2 },
    { name: 'Group A', count: 1 },
  ]);
  assert.equal(categoryList(categoryCounts(value), 1), '"Group B" (2), and 1 more');
  assert.equal(categoryList(categoryCounts(value), 5), '"Group B" (2), "Group A" (1)');
});

test('the catalog line gives the count and the first 12 categories, in the singular and plural forms', () => {
  const two = catalogFrom([['A 1', 'Group A'], ['A 2', 'Group B'], ['A 3', 'Group B']]);
  assert.equal(catalogLine('sc55', two), 'Catalog: 3 sounds in 2 categories ("Group A", "Group B"). Search them with search_midi_sounds, instrument "sc55".');
  const thirteen = catalogFrom(Array.from({ length: 13 }, (_, index) => [`A ${index}`, `Group ${String(index + 1).padStart(2, '0')}`]));
  const line = catalogLine('sc55', thirteen);
  assert.ok(line.startsWith('Catalog: 13 sounds in 13 categories ("Group 01", '), line);
  assert.ok(line.endsWith('"Group 12", and 1 more). Search them with search_midi_sounds, instrument "sc55".'), line);
  assert.equal(catalogLine('sc55', catalogFrom([['A 1']])), 'Catalog: 1 sound, with no categories. Search them with search_midi_sounds, instrument "sc55".');
  assert.equal(catalogLine('sc55', catalogFrom([['A 1', 'Group A']])), 'Catalog: 1 sound in 1 category ("Group A"). Search them with search_midi_sounds, instrument "sc55".');
});

// --- describeSearch and the catalog line of the instruments tool ---

const { describeSearch, describeRig, describeInstrument } = instruments;

function stateWith(t, catalogValue) {
  const dir = makeDir(t, {
    'instruments.json': { instruments: [{ id: 'sc55', model: 'sc55', port: 'Port A' }, { id: 'mt32', model: 'mt32', port: 'Port B' }] },
    ...(catalogValue === null ? {} : { 'catalogs/sc55.json': catalogValue }),
  });
  const store = new RigStore({ dataDir: dir });
  const state = store.read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return { state, dir, options: { connection: () => 'unknown', shipped: store.shippedModelList(), dataDirText: 'the data folder' } };
}

const search = (instrument, query, category) => ({ instrument, ...(query === undefined ? {} : { query }), ...(category === undefined ? {} : { category }) });
const GROUPED = catalogFrom([['Alpha 1', 'Group A'], ['Beta 2', 'Group A'], ['Gamma 3', 'Group B']]);

test('describeSearch answers a search with the reply of the catalog', (t) => {
  const { state, options } = stateWith(t, GROUPED);
  assert.equal(
    describeSearch(state, search('sc55', 'gamma'), options),
    ['Catalog of "sc55" (Roland SC-55), from "test fixture": 3 sounds; programs as sent (0-127).', '1 match:', '- "Gamma 3": program 2, category "Group B"'].join('\n'),
  );
});

test('describeSearch refuses a query that is empty or only spaces when there is no category, saying how to search', (t) => {
  const { state, options } = stateWith(t, GROUPED);
  const reason = 'Nothing to search for: give query (words of the sound name or its category), category, or both, with instrument "sc55".';
  for (const query of [undefined, '', '   ']) assert.throws(() => describeSearch(state, search('sc55', query), options), { message: reason });
  assert.ok(describeSearch(state, search('sc55', '  ', 'Group A'), options).includes('2 matches:'), 'a category alone is a search');
});

test('describeSearch names an unknown instrument, an instrument with no catalog and an unknown category', (t) => {
  const { state, options } = stateWith(t, GROUPED);
  assert.throws(() => describeSearch(state, search('nope', 'a'), options), { message: 'Unknown instrument "nope". Instruments in instruments.json: sc55, mt32.' });
  assert.throws(() => describeSearch(state, search('mt32', 'a'), options), {
    message: 'Instrument "mt32" has no sound catalog. Its sounds are listed by get_midi_instruments with instrument "mt32".',
  });
  assert.throws(() => describeSearch(state, search('sc55', 'a', 'Group Z'), options), {
    message: 'Unknown category "Group Z" in the catalog of "sc55". Categories: "Group A" (2), "Group B" (1).',
  });
  const bare = stateWith(t, catalogFrom([['Alpha 1']]));
  assert.throws(() => describeSearch(bare.state, search('sc55', 'a', 'Group Z'), bare.options), {
    message: 'Unknown category "Group Z" in the catalog of "sc55". The catalog has no categories.',
  });
});

test('describeSearch gives, for a setup with no instruments, the text the instruments tool gives', (t) => {
  const options = { connection: () => 'unknown', shipped: [{ id: 'mt32', name: 'Roland MT-32' }], dataDirText: 'the data folder' };
  const absent = { setup: 'absent' };
  assert.throws(() => describeSearch(absent, search('sc55', 'a'), options), { message: describeRig(absent, options) });
  const invalid = { setup: 'invalid', problems: [{ field: 'instruments[0].port', reason: 'required' }], more: 0 };
  assert.throws(() => describeSearch(invalid, search('sc55', 'a'), options), { message: describeRig(invalid, options) });
});

test('the instruments tool counts the catalog after the sounds line and lists no catalog sound', (t) => {
  const { state, options } = stateWith(t, GROUPED);
  const all = describeRig(state, options);
  const lines = all.split('\n');
  const soundsAt = lines.findIndex((line) => line.startsWith('  Sounds: 128 melodic, '));
  assert.equal(lines[soundsAt + 1], '  Catalog: 3 sounds in 2 categories ("Group A", "Group B"). Search them with search_midi_sounds, instrument "sc55".');
  assert.equal(lines.filter((line) => line.includes('Catalog:')).length, 1, 'the instrument without a catalog has no catalog line');
  const one = describeInstrument(state, 'sc55', options).split('\n');
  assert.equal(one.at(-2), '');
  assert.equal(one.at(-1), 'Catalog: 3 sounds in 2 categories ("Group A", "Group B"). Search them with search_midi_sounds, instrument "sc55".');
  for (const name of ['Alpha 1', 'Beta 2', 'Gamma 3']) assert.ok(!all.includes(name) && !one.join('\n').includes(name), name);
  assert.ok(!describeInstrument(state, 'mt32', options).includes('Catalog:'));
});

test('the instruments tool reply carries no taste: its fixed sentences are facts only', (t) => {
  const { state, options } = stateWith(t, GROUPED);
  for (const text of [describeRig(state, options), describeRig({ setup: 'absent' }, options)]) {
    assert.deepEqual(findWords(text, TINT_WORDS), [], text);
    assert.deepEqual(findWords(text, STEERING_WORDS), [], text);
  }
});

// The write shared by the import command and the save tool.

const { saveCatalog, catalogFileText, CatalogSaveError } = catalog;

const saved = (model, sounds = [sound('Alpha 1', { category: 'Group A', bank: { msb: 8 } }), sound('Beta 2')]) => {
  const parsed = parseCatalog(file(model, sounds), model);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.catalog;
};

test('saveCatalog writes under catalogs/, returns that path, and the text parses back to the same catalog', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const dir = makeDir(t);
  const value = saved(sc55);
  const written = saveCatalog({ dataDir: dir, catalog: value, replace: false });
  assert.equal(written, path.join(dir, 'catalogs', 'sc55.json'));
  const text = fs.readFileSync(written, 'utf8');
  assert.equal(text, catalogFileText(value));
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').filter((line) => line.includes('"program"')).length, 2, 'one sound per line');
  const again = parseCatalog(JSON.parse(text), sc55);
  assert.deepEqual(again, { ok: true, catalog: value });
  assert.deepEqual(readCatalogFile(dir, sc55), { catalog: value, problems: [] });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'catalogs')), ['sc55.json']);
});

test('saveCatalog refuses an existing file without replace and leaves it byte for byte; with replace it swaps it and leaves no temp file', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const dir = makeDir(t, { 'catalogs/sc55.json': '{"keep":"me"}\n' });
  const target = path.join(dir, 'catalogs', 'sc55.json');
  const before = fs.readFileSync(target);
  assert.throws(
    () => saveCatalog({ dataDir: dir, catalog: saved(sc55), replace: false }),
    (err) => err instanceof CatalogSaveError && err.code === 'exists' && err.message === 'catalogs/sc55.json already exists.',
  );
  assert.deepEqual(fs.readFileSync(target), before);
  saveCatalog({ dataDir: dir, catalog: saved(sc55), replace: true });
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).model, 'sc55');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'catalogs')), ['sc55.json']);
});

test('saveCatalog names only the error code when the folder or the file cannot be written, and never says "exists" for it', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const blocked = makeDir(t, { catalogs: 'a file where the folder should be' });
  assert.throws(
    () => saveCatalog({ dataDir: blocked, catalog: saved(sc55), replace: false }),
    (err) => err instanceof CatalogSaveError && err.code !== 'exists' && /^Catalog "sc55" could not be saved: [A-Z]+\.$/.test(err.message) && !err.message.includes(blocked),
  );
  const inTheWay = makeDir(t);
  fs.mkdirSync(path.join(inTheWay, 'catalogs', 'sc55.json.tmp'), { recursive: true });
  assert.throws(
    () => saveCatalog({ dataDir: inTheWay, catalog: saved(sc55), replace: false }),
    (err) => err instanceof CatalogSaveError && err.code === 'EISDIR',
  );
  assert.ok(fs.statSync(path.join(inTheWay, 'catalogs', 'sc55.json.tmp')).isDirectory(), 'the folder in the way is left alone');
});

test('saveCatalog never builds a path from a model id that could climb out of the folder', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const dir = makeDir(t);
  const climbing = { ...saved(sc55), model: '../x' };
  assert.throws(() => saveCatalog({ dataDir: dir, catalog: climbing, replace: true }), CatalogSaveError);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing reached the file system');
});

// A sound list that exists only as a PDF becomes a catalog draft, summarized first and saved only
// after the user's yes. The draft lives in the session's memory; nothing is written before the confirm.

/** One group as a list prints it: programs numbered from 1. */
const groupA = { category: 'Group A', bank: { msb: 8 }, sounds: [{ program: 1, name: 'Tone 0001' }, { program: 2, name: 'Tone 0002' }] };
const groupB = { category: 'Group B', sounds: [{ program: 128, name: 'Tone 0003' }] };

test('flattenCatalogPart: from-1 stores each program minus one, keeps the groups and banks as sent, and paths follow the call', () => {
  const flat = flattenCatalogPart([groupA, groupB], 'from-1');
  assert.deepEqual(flat.problems, []);
  assert.deepEqual(flat.sounds, [
    { name: 'Tone 0001', category: 'Group A', program: 0, bank: { msb: 8 } },
    { name: 'Tone 0002', category: 'Group A', program: 1, bank: { msb: 8 } },
    { name: 'Tone 0003', category: 'Group B', program: 127 },
  ]);
  assert.deepEqual(flat.paths, ['banks[0].sounds[0]', 'banks[0].sounds[1]', 'banks[1].sounds[0]']);
});

test('flattenCatalogPart: from-0 keeps programs as written and refuses 128; from-1 refuses a printed 0; banks are never converted', () => {
  const zero = flattenCatalogPart([{ bank: { msb: 0, lsb: 1 }, sounds: [{ program: 0, name: 'Tone 0001' }] }], 'from-0');
  assert.deepEqual(zero.problems, []);
  assert.deepEqual(zero.sounds, [{ name: 'Tone 0001', program: 0, bank: { msb: 0, lsb: 1 } }]);
  const high = flattenCatalogPart([groupA, groupB], 'from-0');
  assertProblem(high.problems, 'banks[1].sounds[0].program', '128 is above 127 in a list numbered from 0');
  const low = flattenCatalogPart([{ sounds: [{ program: 0, name: 'Tone 0001' }] }], 'from-1');
  assertProblem(low.problems, 'banks[0].sounds[0].program', '0 is not a program number in a list numbered from 1');
});

function fiveSounds(extra = {}) {
  return {
    model: 'sc55',
    source: 'Test List v1',
    sounds: [0, 1, 2, 3, 4].map((index) => ({ name: `Tone 000${index + 1}`, category: 'Group A', program: index, bank: { msb: 8 } })),
    ...extra,
  };
}

test('summarizeCatalog: one fact per line, in order, with the first, middle and last sound in both numberings', (t) => {
  const model = modelOf(t, 'sc55');
  const text = summarizeCatalog({ catalog: fiveSounds(), model, numbering: 'from-1', replaces: false });
  assert.deepEqual(text.split('\n'), [
    'Catalog for model "sc55" (Roland SC-55), from "Test List v1": 5 sounds.',
    'Numbering: the list numbers programs from 1; they are stored as sent, from 0.',
    'Categories: "Group A" (5).',
    'Bank select: CC0; 1 bank.',
    'First: "Tone 0001" (category "Group A", bank 8, program 0 as sent, 1 in a manual numbered from 1).',
    'Middle: "Tone 0003" (category "Group A", bank 8, program 2 as sent, 3 in a manual numbered from 1).',
    'Last: "Tone 0005" (category "Group A", bank 8, program 4 as sent, 5 in a manual numbered from 1).',
  ]);
});

test('summarizeCatalog: one sound shows First only, two show First and Last, from-0 says so, and replaces adds the replace line', (t) => {
  const model = modelOf(t, 'sc55');
  const one = summarizeCatalog({ catalog: fiveSounds({ sounds: [{ name: 'Tone 0001', program: 0 }] }), model, numbering: 'from-0', replaces: false });
  const lines = one.split('\n');
  assert.equal(lines[1], 'Numbering: the list numbers programs from 0, as sent; they are stored as written.');
  assert.equal(lines[2], 'Categories: none.');
  assert.equal(lines[3], 'Bank select: CC0; 1 bank.');
  assert.deepEqual(lines.slice(4), ['First: "Tone 0001" (program 0 as sent, 1 in a manual numbered from 1).']);
  const two = summarizeCatalog({ catalog: fiveSounds({ sounds: fiveSounds().sounds.slice(0, 2) }), model, numbering: 'from-1', replaces: true });
  const twoLines = two.split('\n');
  assert.ok(twoLines[4].startsWith('First: ') && twoLines[5].startsWith('Last: '), two);
  assert.ok(!twoLines.some((line) => line.startsWith('Middle:')), two);
  assert.equal(twoLines[twoLines.length - 1], 'It replaces the existing catalogs/sc55.json.');
});

test('summarizeCatalog: a model with no bank select says so, and banks are counted as sent with a missing value as 0', (t) => {
  const none = modelOf(t, 'mt32');
  const text = summarizeCatalog({ catalog: fiveSounds({ model: 'mt32', sounds: [{ name: 'Tone 0001', program: 0 }] }), model: none, numbering: 'from-0', replaces: false });
  assert.ok(text.split('\n').includes('Bank select: none.'), text);
  const model = modelOf(t, 'synth');
  const sounds = [
    { name: 'Tone 0001', program: 0, bank: { msb: 1 } },
    { name: 'Tone 0002', program: 1, bank: { msb: 1, lsb: 0 } },
    { name: 'Tone 0003', program: 2, bank: { msb: 2, lsb: 5 } },
    { name: 'Tone 0004', program: 3 },
    { name: 'Tone 0005', program: 4, bank: { msb: 0, lsb: 0 } },
  ];
  const lines = summarizeCatalog({ catalog: fiveSounds({ model: 'synth', sounds }), model, numbering: 'from-0', replaces: false }).split('\n');
  assert.ok(lines.includes('Bank select: CC0 then CC32; 3 banks.'), lines.join('\n'));
});

/** A Session on a temp data folder, the way the server holds one. */
function draftSession(t, files = {}) {
  const dir = makeDir(t, files);
  return { dir, session: new Session({ rig: new RigStore({ dataDir: dir }) }) };
}

const NOT_SAVED = 'Not saved. Show this summary to the user; call save_midi_catalog again with model "sc55" and confirmed: true after they say yes.';
const LOST = 'No catalog draft for model "sc55" in this session (a draft is lost when the Moontide server restarts). Start again with the first part.';
const startPart = (extra = {}) => ({ model: 'sc55', source: 'Test List v1', programNumbering: 'from-1', banks: [groupA, groupB], ...extra });
const catalogFile = (dir) => path.join(dir, 'catalogs', 'sc55.json');

test('save_midi_catalog: one starting part answers the summary and the not-saved line, and writes nothing', (t) => {
  const { dir, session } = draftSession(t);
  const text = session.saveMidiCatalog(startPart());
  assert.ok(text.startsWith('Catalog for model "sc55" (Roland SC-55), from "Test List v1": 3 sounds.\n'), text);
  assert.ok(text.includes('Last: "Tone 0003" (category "Group B", program 127 as sent, 128 in a manual numbered from 1).'), text);
  assert.ok(text.endsWith(`\n${NOT_SAVED}`), text);
  assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
});

test('save_midi_catalog: the confirm saves the converted draft, says so, and a second confirm finds the draft freed', (t) => {
  const { dir, session } = draftSession(t);
  session.saveMidiCatalog(startPart());
  const text = session.saveMidiCatalog({ model: 'sc55', confirmed: true });
  assert.ok(
    text.startsWith(
      'Saved the catalog of model "sc55" in the Moontide data folder (catalogs/sc55.json): 3 sounds. An instrument of instruments.json with "model": "sc55" can now choose them, and search_midi_sounds finds them.',
    ),
    text,
  );
  const saved = JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8'));
  assert.deepEqual(saved, {
    model: 'sc55',
    source: 'Test List v1',
    sounds: flattenCatalogPart([groupA, groupB], 'from-1').sounds,
  });
  assert.deepEqual(saved.sounds.map((entry) => entry.program), [0, 1, 127]);
  assert.throws(() => session.saveMidiCatalog({ model: 'sc55', confirmed: true }), (err) => err.message === LOST);
});

test('save_midi_catalog: a confirm with no draft says the draft is lost, and a confirm that carries sounds is refused; nothing is written', (t) => {
  const { dir, session } = draftSession(t);
  assert.throws(() => session.saveMidiCatalog({ model: 'sc55', confirmed: true }), (err) => err.message === LOST);
  session.saveMidiCatalog(startPart());
  assert.throws(
    () => session.saveMidiCatalog({ model: 'sc55', confirmed: true, banks: [groupA] }),
    (err) => err.message === 'A confirmation takes only model and confirmed: true; the sounds are already in the draft.',
  );
  assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
});

// Long lists go in parts of at most 500 sounds up to 5,000, each part is checked when it
// arrives against the draft so far, and a lost, changed or unsummarized draft is never saved.

const pad = (number) => String(number).padStart(4, '0');
/** `count` sounds named Tone 0001, Tone 0002, ... from number `from + 1`, as one group of a list numbered from 1. */
const run = (from, count, group = {}) => ({
  category: 'Group A',
  bank: { msb: 8 },
  ...group,
  sounds: Array.from({ length: count }, (_, index) => ({ program: ((from + index) % 128) + 1, name: `Tone ${pad(from + index + 1)}` })),
});
const MORE = 'Send the next part with append: true, and more: true while parts remain.';
const appendPart = (extra = {}) => ({ model: 'sc55', append: true, ...extra });
const lines = (text) => text.split('\n');
const refusal = (session, options) => {
  try {
    session.saveMidiCatalog(options);
  } catch (err) {
    return err.message;
  }
  assert.fail(`expected a refusal for ${JSON.stringify(options).slice(0, 200)}`);
};

test('parts: a part with more answers the count so far, parts keep call order, and the last part gives the summary of the whole draft', (t) => {
  const { session } = draftSession(t);
  assert.equal(
    session.saveMidiCatalog(startPart({ banks: [run(0, 500)], more: true })),
    `Draft catalog for model "sc55": 500 sounds so far, not saved. ${MORE}`,
  );
  assert.equal(session.saveMidiCatalog(appendPart({ banks: [run(500, 2)], more: true })), `Draft catalog for model "sc55": 502 sounds so far, not saved. ${MORE}`);
  const text = session.saveMidiCatalog(appendPart({ banks: [run(502, 3)] }));
  const all = lines(text);
  assert.equal(all[0], 'Catalog for model "sc55" (Roland SC-55), from "Test List v1": 505 sounds.');
  assert.ok(all.some((line) => line.startsWith('First: "Tone 0001"')), text);
  assert.ok(all.some((line) => line.startsWith('Last: "Tone 0505"')), text);
  assert.equal(all[all.length - 1], NOT_SAVED);
});

test('parts: ten parts of 500 are saved by one confirm as one catalog of 5,000 sounds in call order', (t) => {
  const { dir, session } = draftSession(t);
  for (let part = 0; part < 10; part++) {
    const reply = session.saveMidiCatalog(
      part === 0 ? startPart({ banks: [run(0, 500)], more: true }) : appendPart({ banks: [run(part * 500, 500)], more: part < 9 }),
    );
    if (part === 9) assert.ok(lines(reply).some((line) => line.startsWith('Last: "Tone 5000"')), reply);
    else assert.ok(reply.startsWith(`Draft catalog for model "sc55": ${(part + 1) * 500} sounds so far, not saved.`), reply);
    assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
  }
  const saved = session.saveMidiCatalog({ model: 'sc55', confirmed: true });
  assert.ok(saved.includes('(catalogs/sc55.json): 5000 sounds.'), saved);
  const file = JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8'));
  assert.equal(file.sounds.length, 5000);
  assert.deepEqual(file.sounds.map((entry) => entry.name), Array.from({ length: 5000 }, (_, index) => `Tone ${pad(index + 1)}`));
  assert.equal(file.sounds[4999].program, 4999 % 128);
});

test('caps: a call of 501 sounds over two groups is refused; a part that brings the draft to 5,001 is refused; both leave the draft as it was', (t) => {
  const { session } = draftSession(t);
  session.saveMidiCatalog(startPart({ banks: [run(0, 500)], more: true }));
  assert.equal(refusal(session, appendPart({ banks: [run(500, 300), run(800, 201)] })), 'This part holds 501 sounds; send at most 500 per call.');
  const text = session.saveMidiCatalog(appendPart({ banks: [run(500, 1)] }));
  assert.equal(lines(text)[0], 'Catalog for model "sc55" (Roland SC-55), from "Test List v1": 501 sounds.');

  const full = draftSession(t);
  for (let part = 0; part < 10; part++) {
    full.session.saveMidiCatalog(part === 0 ? startPart({ banks: [run(0, 500)], more: part < 9 }) : appendPart({ banks: [run(part * 500, 500)], more: part < 9 }));
  }
  assert.equal(refusal(full.session, appendPart({ banks: [run(5000, 1)] })), 'The draft would hold 5001 sounds; a catalog holds at most 5000.');
  // The refused part changed nothing, not even the summarized mark: the confirm saves the 5,000 sounds.
  assert.ok(full.session.saveMidiCatalog({ model: 'sc55', confirmed: true }).includes('): 5000 sounds.'));
});

test('part check: a repeated name, a name of the model, a bank LSB and a printed 0 are refused with the part\'s own path, and the corrected part is accepted', (t) => {
  const { session } = draftSession(t);
  session.saveMidiCatalog(startPart({ banks: [run(0, 4)], more: true }));
  const repeated = refusal(session, appendPart({ banks: [run(4, 1), run(3, 1)], more: true }));
  assert.equal(
    repeated,
    'The part was not added:\n- banks[1].sounds[0].name: same name as sounds[3] ("Tone 0004")',
  );
  const own = refusal(session, appendPart({ banks: [{ sounds: [{ program: 5, name: 'Acoustic Grand Piano' }] }] }));
  assert.ok(own.includes('- banks[0].sounds[0].name: same name as a sound of model sc55 ("Acoustic Grand Piano")'), own);
  const lsb = refusal(session, appendPart({ banks: [{ bank: { msb: 8, lsb: 1 }, sounds: [{ program: 5, name: 'Tone 0005' }] }] }));
  assert.ok(lsb.includes('- banks[0].sounds[0].bank.lsb: this model takes a bank MSB only'), lsb);
  const zero = refusal(session, appendPart({ banks: [run(4, 1), { sounds: [{ program: 0, name: 'Tone 0006' }] }] }));
  assert.equal(zero, 'The part was not added:\n- banks[1].sounds[0].program: 0 is not a program number in a list numbered from 1');
  const fixed = session.saveMidiCatalog(appendPart({ banks: [run(4, 2)] }));
  assert.equal(lines(fixed)[0], 'Catalog for model "sc55" (Roland SC-55), from "Test List v1": 6 sounds.');
});

test('part check: a refused part names at most 20 problems, then counts the rest', (t) => {
  const { session } = draftSession(t);
  const message = refusal(session, startPart({ banks: [{ sounds: Array.from({ length: 25 }, (_, index) => ({ program: 0, name: `Tone ${pad(index)}` })) }] }));
  const rows = lines(message);
  assert.equal(rows.length, 22, message);
  assert.equal(rows[21], '- and 5 more problems');
});

test('the summarized mark: a part after a summary makes the confirm refuse until a new last part gives a new summary', (t) => {
  const { dir, session } = draftSession(t);
  session.saveMidiCatalog(startPart({ banks: [run(0, 3)], more: true }));
  session.saveMidiCatalog(appendPart({ banks: [run(3, 1)] }));
  session.saveMidiCatalog(appendPart({ banks: [run(4, 1)], more: true }));
  const last = 'Call save_midi_catalog with the last part first, show the summary to the user, and save only after they say yes.';
  assert.equal(refusal(session, { model: 'sc55', confirmed: true }), last);
  assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
  const summary = session.saveMidiCatalog(appendPart({ banks: [run(5, 1)] }));
  assert.equal(lines(summary)[0], 'Catalog for model "sc55" (Roland SC-55), from "Test List v1": 6 sounds.');
  assert.ok(session.saveMidiCatalog({ model: 'sc55', confirmed: true }).includes('): 6 sounds.'));
  assert.equal(JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8')).sounds.length, 6);
});

test('restart: a new Session on the same folder has no draft, so a confirm and an appended part both say it is lost and write nothing', (t) => {
  const { dir, session } = draftSession(t);
  session.saveMidiCatalog(startPart());
  const restarted = new Session({ rig: new RigStore({ dataDir: dir }) });
  assert.equal(
    refusal(restarted, { model: 'sc55', confirmed: true }),
    'No catalog draft for model "sc55" in this session (a draft is lost when the Moontide server restarts). Start again with the first part.',
  );
  assert.equal(refusal(restarted, appendPart({ banks: [run(10, 1)] })), LOST);
  assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
});

test('starting rules: source and numbering are required, no part and an empty part are refused, and a part that says another numbering is refused', (t) => {
  const { session } = draftSession(t);
  const need = 'A new draft needs source and programNumbering ("from-0" or "from-1").';
  assert.equal(refusal(session, startPart({ source: undefined })), need);
  assert.equal(refusal(session, startPart({ programNumbering: undefined })), need);
  const send = 'Send the sounds in banks: [{ category, bank, sounds: [{ program, name }] }], at most 500 sounds per call.';
  assert.equal(refusal(session, { model: 'sc55', source: 'Test List v1', programNumbering: 'from-1' }), send);
  assert.equal(refusal(session, startPart({ banks: [] })), send);
  assert.equal(refusal(session, startPart({ banks: [{ category: 'Group A', sounds: [] }] })), send);
  session.saveMidiCatalog(startPart({ banks: [run(0, 2)], more: true }));
  assert.equal(
    refusal(session, appendPart({ programNumbering: 'from-0', banks: [run(2, 1)] })),
    'This part says programNumbering "from-0" but the draft has "from-1".',
  );
  assert.equal(refusal(session, appendPart({ source: 'Other', banks: [run(2, 1)] })), 'This part says source "Other" but the draft has "Test List v1".');
  assert.equal(refusal(session, appendPart({ overwrite: true, banks: [run(2, 1)] })), 'This part says overwrite true but the draft has false.');
});

test('starting rules: an existing catalog is refused without overwrite and left as it was; with overwrite the summary says it replaces it and the confirm does', (t) => {
  const existing = JSON.stringify({ model: 'sc55', source: 'earlier', sounds: [{ name: 'Old Tone', program: 3 }] });
  const { dir, session } = draftSession(t, { 'catalogs/sc55.json': existing });
  assert.equal(
    refusal(session, startPart()),
    'catalogs/sc55.json already exists in the Moontide data folder; start the draft with overwrite: true to replace it.',
  );
  assert.equal(fs.readFileSync(catalogFile(dir), 'utf8'), existing);
  const summary = lines(session.saveMidiCatalog(startPart({ overwrite: true })));
  assert.equal(summary[summary.length - 2], 'It replaces the existing catalogs/sc55.json.');
  assert.equal(summary[summary.length - 1], NOT_SAVED);
  assert.equal(fs.readFileSync(catalogFile(dir), 'utf8'), existing, 'nothing is written before the yes');
  session.saveMidiCatalog({ model: 'sc55', confirmed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8')).sounds.map((entry) => entry.name), ['Tone 0001', 'Tone 0002', 'Tone 0003']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'catalogs')), ['sc55.json']);
});

test('starting rules: a second starting part for the same model replaces that model\'s draft, and only the second is saved', (t) => {
  const { dir, session } = draftSession(t);
  session.saveMidiCatalog(startPart({ banks: [run(0, 3)], more: true }));
  session.saveMidiCatalog(startPart({ banks: [run(10, 2)] }));
  session.saveMidiCatalog({ model: 'sc55', confirmed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8')).sounds.map((entry) => entry.name), ['Tone 0011', 'Tone 0012']);
});

test('starting rules: a refused starting part does not replace the draft the model already has', (t) => {
  const { dir, session } = draftSession(t);
  session.saveMidiCatalog(startPart());
  assert.ok(refusal(session, startPart({ banks: [{ sounds: [{ program: 0, name: 'Tone 0009' }] }] })).startsWith('The part was not added:'));
  session.saveMidiCatalog({ model: 'sc55', confirmed: true });
  assert.equal(JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8')).sounds.length, 3);
});

test('drafts: a session holds three drafts; a fourth start drops the oldest, says so, and its confirm finds nothing', (t) => {
  const model = (id) => ({ ...userModel, id });
  const { dir, session } = draftSession(t, { 'models/usera.json': model('usera'), 'models/userb.json': model('userb') });
  const plain = (id, extra = {}) => ({ model: id, source: 'Test List v1', programNumbering: 'from-1', banks: [{ sounds: [{ program: 1, name: `Tone ${id}` }] }], more: true, ...extra });
  session.saveMidiCatalog(plain('sc55'));
  session.saveMidiCatalog(plain('mt32'));
  session.saveMidiCatalog(plain('usera'));
  const fourth = session.saveMidiCatalog(plain('userb'));
  assert.ok(fourth.endsWith('\nThe draft for model "sc55" was dropped: a session holds at most 3 catalog drafts.'), fourth);
  assert.equal(refusal(session, { model: 'sc55', confirmed: true }), LOST);
  assert.equal(refusal(session, appendPart({ banks: [run(1, 1)] })), LOST);
  const kept = session.saveMidiCatalog({ ...plain('mt32', { append: true, banks: [{ sounds: [{ program: 2, name: 'Tone more' }] }], more: false, source: undefined, programNumbering: undefined }) });
  assert.ok(kept.startsWith('Catalog for model "mt32"'), kept);
  assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
});

test('models: an unknown model names the known ones, an id with a slash gets the id rule, and neither writes anything', (t) => {
  const { dir, session } = draftSession(t);
  const unknown = refusal(session, startPart({ model: 'nope' }));
  assert.ok(unknown.includes('- model: unknown model "nope", known models: mt32, sc55'), unknown);
  assert.equal(refusal(session, startPart({ model: '../escape' })), 'model: must be 1 to 32 lowercase letters, digits, dashes or underscores, starting with a letter or digit');
  assert.equal(refusal(session, { model: 'nope', confirmed: true }).includes('unknown model "nope"'), true);
  assert.equal(fs.existsSync(path.join(dir, 'catalogs')), false);
});

test('never touched: instruments.json and every model file keep their bytes through drafts, a refusal, a save and an overwrite', (t) => {
  const rigText = JSON.stringify({ instruments: [{ id: 'one', model: 'synth', port: 'Port A' }, { id: 'two', model: 'sc55', port: 'Port B' }] });
  const modelText = JSON.stringify(userModel);
  const { dir, session } = draftSession(t, { 'instruments.json': rigText, 'models/synth.json': modelText });
  const unchanged = () => {
    assert.equal(fs.readFileSync(path.join(dir, 'instruments.json'), 'utf8'), rigText);
    assert.equal(fs.readFileSync(path.join(dir, 'models', 'synth.json'), 'utf8'), modelText);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'models')), ['synth.json']);
  };
  const synthPart = { model: 'synth', source: 'Test List v1', programNumbering: 'from-0', banks: [{ bank: { msb: 1, lsb: 2 }, sounds: [{ program: 0, name: 'Tone 0001' }] }] };
  session.saveMidiCatalog(synthPart);
  refusal(session, startPart({ banks: [{ sounds: [{ program: 0, name: 'Tone 0001' }] }] }));
  session.saveMidiCatalog({ model: 'synth', confirmed: true });
  unchanged();
  session.saveMidiCatalog({ ...synthPart, overwrite: true });
  session.saveMidiCatalog({ model: 'synth', confirmed: true });
  session.saveMidiCatalog(startPart());
  session.saveMidiCatalog({ model: 'sc55', confirmed: true });
  unchanged();
});

// The drum kits of a catalog.


/** The neutral model whose rhythm channels take a bank, as a RigStore resolves it. */
function bankModel(t) {
  const dir = makeDir(t, {
    'instruments.json': { instruments: [{ id: 'bankdrums', model: 'bankdrums', port: 'Port A' }] },
    'models/bankdrums.json': bankDrumsModel(),
  });
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  return state.instruments[0].model;
}

const kit = (name, extra = {}) => ({ name, program: 1, bank: { msb: 86, lsb: 65 }, ...extra });
const kitFile = (model, kits, extra = {}) => ({ model: model.id, source: 'test fixture', sounds: [], kits, ...extra });
const KITS = 'catalogs/bankdrums.json:kits';

test('kits of a model whose rhythm channels take no bank are refused, loudly, at kits', (t) => {
  const sc55 = modelOf(t, 'sc55');
  const read = readOf(t, sc55, { ...file(sc55, [sound('Alpha 1')]), kits: [kit('Kit Z')] });
  assertProblem(problemsOf(read), 'catalogs/sc55.json:kits', "this model's rhythm channels take no bank, so its kits are listed in the model");
});

test('a kit needs a bank, a bank LSB only where the model takes one, and unique names', (t) => {
  const bank = bankModel(t);
  assertProblem(problemsOf(readOf(t, bank, kitFile(bank, [{ name: 'Kit Z', program: 1 }]))), `${KITS}[0].bank`, 'required: the rhythm channels of this model take a bank');
  assertProblem(
    problemsOf(readOf(t, bank, kitFile(bank, [kit('Kit Z'), kit('kit  z')]))),
    `${KITS}[1].name`,
    'same name as kits[0] ("Kit Z")',
  );
  assertProblem(
    problemsOf(readOf(t, bank, kitFile(bank, [kit('Kit A')]))),
    `${KITS}[0].name`,
    'same name as a sound of model bankdrums ("Kit A")',
  );
  assert.deepEqual(readOf(t, bank, kitFile(bank, [kit('Tone One')])).problems, [], 'a kit name may equal a melodic name of the model');
});

test('a kit noteMap must name a map of the model or a built-in map, or be null', (t) => {
  const bank = bankModel(t);
  assertProblem(
    problemsOf(readOf(t, bank, kitFile(bank, [kit('Kit Z', { noteMap: 'nope' })]))),
    `${KITS}[0].noteMap`,
    'unknown drum map "nope", this model has: none; built in: general-midi',
  );
  assert.deepEqual(readOf(t, bank, kitFile(bank, [kit('Kit Y', { noteMap: 'general-midi' }), kit('Kit X', { noteMap: null })])).problems, []);
});

test('a control character in a kit name or category is a problem, and 513 kits are one problem at kits', (t) => {
  const bank = bankModel(t);
  assertProblem(problemsOf(readOf(t, bank, kitFile(bank, [kit('Kit\u0007Z')]))), `${KITS}[0].name`, 'contains a control character');
  assertProblem(problemsOf(readOf(t, bank, kitFile(bank, [kit('Kit Z', { category: 'Gr\u0001oup' })]))), `${KITS}[0].category`, 'contains a control character');
  const many = (count) => Array.from({ length: count }, (_, index) => kit(`Kit ${index}`, { program: index % 128 }));
  assert.equal(readOf(t, bank, kitFile(bank, many(512))).catalog.kits.length, 512);
  assertProblem(problemsOf(readOf(t, bank, kitFile(bank, many(513)))), KITS, 'at most 512 kits');
});

test('a catalog needs a sound or a kit: neither is refused with the old words, one kit alone is fine', (t) => {
  const bank = bankModel(t);
  assertProblem(problemsOf(readOf(t, bank, kitFile(bank, []))), 'catalogs/bankdrums.json:sounds', 'at least one sound is required');
  assert.deepEqual(readOf(t, bank, kitFile(bank, [kit('Kit Z')])).problems, []);
  assert.deepEqual(readOf(t, bank, { ...file(bank, [sound('Tone Two')]) }).problems, [], 'sounds only parses as before');
});

test('the file text writes the kits list after the sounds and reads back unchanged; without kits it is as before', (t) => {
  const bank = bankModel(t);
  const value = { model: 'bankdrums', source: 'test fixture', sounds: [sound('Tone Two')], kits: [kit('Kit Y', { category: 'Group K', noteMap: 'general-midi' }), kit('Kit X', { noteMap: null })] };
  const text = catalogFileText(value);
  assert.ok(text.includes('  ],\n  "kits": [\n'), text);
  assert.ok(text.endsWith('\n  ]\n}\n'));
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('  {"name"')).length, 3, 'one object per line');
  const back = parseCatalog(JSON.parse(text), bank);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.deepEqual(back.catalog, value);
  const plain = { model: 'bankdrums', source: 'test fixture', sounds: [sound('Tone Two')] };
  assert.equal(catalogFileText(plain), '{\n  "model": "bankdrums",\n  "source": "test fixture",\n  "sounds": [\n  {"name":"Tone Two","program":1}\n  ]\n}\n');
  const onlyKits = catalogFileText({ model: 'bankdrums', source: 'x', sounds: [], kits: [kit('Kit Z')] });
  assert.ok(onlyKits.includes('"sounds": [],\n  "kits": ['), onlyKits);
  assert.equal(parseCatalog(JSON.parse(onlyKits), bank).ok, true);
});

test('a search returns sounds and kits in tier order with kits[] aligned, and a category only kits have works', (t) => {
  const bank = bankModel(t);
  const value = {
    model: 'bankdrums',
    source: 'test fixture',
    sounds: [sound('Bell Pad'), sound('Bell', { category: 'Group B' })],
    kits: [kit('Bell Kit', { category: 'Drum Group' }), kit('Kit Bell', { category: 'Drum Group' })],
  };
  const result = searchCatalog(value, { query: 'bell' });
  assert.deepEqual(namesOf(result), ['Bell', 'Bell Pad', 'Bell Kit', 'Kit Bell']);
  assert.deepEqual(result.kits, [false, false, true, true]);
  const only = searchCatalog(value, { category: 'drum group' });
  assert.deepEqual(namesOf(only), ['Bell Kit', 'Kit Bell']);
  assert.deepEqual(only.kits, [true, true]);
  assert.equal(searchCatalog(value, { category: 'Nothing' }).unknownCategory, true);
  assert.equal(catalog.categoriesSentence(value, 'Categories: '), 'Categories: "Group B" (1), "Drum Group" (2).');
  assert.equal(
    catalog.catalogLine('drumbank', value),
    'Catalog: 2 sounds and 2 drum kits in 2 categories ("Group B", "Drum Group"). Search them with search_midi_sounds, instrument "drumbank".',
  );
  assert.equal(
    catalog.catalogLine('drumbank', { ...value, sounds: [sound('Bell')], kits: [kit('Kit Z')] }),
    'Catalog: 1 sound and 1 drum kit, with no categories. Search them with search_midi_sounds, instrument "drumbank".',
  );
  const reply = searchReply({ id: 'drumbank', modelName: 'Bank Drum Synth', model: bank, catalog: value, result: searchCatalog(value, { query: 'kit' }) });
  const lines = reply.split('\n');
  assert.equal(lines[0], 'Catalog of "drumbank" (Bank Drum Synth), from "test fixture": 2 sounds and 2 drum kits; programs as sent (0-127).');
  assert.ok(lines.includes('- "Bell Kit" (drum kit): program 1, bank 86/65, category "Drum Group", drum map "General MIDI" (47 notes)'), reply);
  const none = searchReply({ id: 'drumbank', modelName: 'Bank Drum Synth', model: bank, catalog: value, result: searchCatalog(value, { query: 'zzz' }) });
  assert.ok(none.includes('No sound or drum kit matches.'), none);
});

// The PDF path: a group with role rhythm gives kits.

test('flattenCatalogPart: a group with role rhythm gives kits with their own paths, converted programs and the map', () => {
  const drums = { category: 'Drum Group', bank: { msb: 86, lsb: 64 }, role: 'rhythm', sounds: [{ program: 1, name: 'Pdf Kit One' }, { program: 2, name: 'Pdf Kit Two' }] };
  const flat = flattenCatalogPart([groupA, { ...drums, noteMap: 'general-midi' }, { ...drums, noteMap: null, sounds: [{ program: 3, name: 'Pdf Kit Three' }] }], 'from-1');
  assert.deepEqual(flat.problems, []);
  assert.deepEqual(flat.sounds.map((one) => one.name), ['Tone 0001', 'Tone 0002']);
  assert.deepEqual(flat.kits, [
    { name: 'Pdf Kit One', category: 'Drum Group', program: 0, bank: { msb: 86, lsb: 64 }, noteMap: 'general-midi' },
    { name: 'Pdf Kit Two', category: 'Drum Group', program: 1, bank: { msb: 86, lsb: 64 }, noteMap: 'general-midi' },
    { name: 'Pdf Kit Three', category: 'Drum Group', program: 2, bank: { msb: 86, lsb: 64 }, noteMap: null },
  ]);
  assert.deepEqual(flat.kitPaths, ['banks[1].sounds[0]', 'banks[1].sounds[1]', 'banks[2].sounds[0]']);
  assert.deepEqual(flat.paths, ['banks[0].sounds[0]', 'banks[0].sounds[1]']);
  const noMap = flattenCatalogPart([drums], 'from-1');
  assert.ok(!('noteMap' in noMap.kits[0]), 'a group without noteMap leaves the kits without one');
});

test('flattenCatalogPart: noteMap on a group that is not rhythm is a problem, and a group with no role stays melodic', () => {
  const melodic = flattenCatalogPart([{ ...groupA, noteMap: 'general-midi' }], 'from-1');
  assertProblem(melodic.problems, 'banks[0].noteMap', 'is only for a group with role rhythm');
  const named = flattenCatalogPart([{ ...groupA, role: 'melodic', noteMap: null }], 'from-1');
  assertProblem(named.problems, 'banks[0].noteMap', 'is only for a group with role rhythm');
  const plain = flattenCatalogPart([groupA, groupB], 'from-1');
  assert.deepEqual(plain.kits, []);
  assert.deepEqual(plain.kitPaths, []);
});

test('summarizeCatalog: kits are counted in the header and the banks, shown on a Kits line, and a kits-only catalog has no sound lines', (t) => {
  const bank = bankModel(t);
  const kits = [kit('Pdf Kit One', { program: 0, bank: { msb: 86, lsb: 64 } }), kit('Pdf Kit Two', { program: 1, bank: { msb: 86, lsb: 64 } })];
  const mixed = summarizeCatalog({
    catalog: { model: 'bankdrums', source: 'List', sounds: [{ name: 'Tone Two', program: 0, bank: { msb: 3, lsb: 4 } }], kits },
    model: bank,
    numbering: 'from-1',
    replaces: false,
  }).split('\n');
  assert.equal(mixed[0], 'Catalog for model "bankdrums" (Bank Drum Synth), from "List": 1 sound and 2 drum kits.');
  assert.ok(mixed.includes('Bank select: CC0 then CC32; 2 banks.'), mixed.join('\n'));
  assert.ok(mixed.some((line) => line.startsWith('First: "Tone Two"')), mixed.join('\n'));
  assert.ok(mixed.includes('Kits: 2, from "Pdf Kit One" (program 0 as sent, 1 in a manual numbered from 1) to "Pdf Kit Two" (program 1, 2).'), mixed.join('\n'));
  const only = summarizeCatalog({ catalog: { model: 'bankdrums', source: 'List', sounds: [], kits }, model: bank, numbering: 'from-0', replaces: false }).split('\n');
  assert.equal(only[0], 'Catalog for model "bankdrums" (Bank Drum Synth), from "List": 2 drum kits.');
  assert.ok(!only.some((line) => /^(First|Middle|Last): /.test(line)), only.join('\n'));
  assert.ok(only.some((line) => line.startsWith('Kits: 2, from "Pdf Kit One"')));
});
