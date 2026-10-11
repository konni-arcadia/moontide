import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as instruments from '../dist/instruments.js';
import * as importer from '../dist/import-midnam.js';
import { DIST_ENTRY, waitForExit } from './helpers.js';
import { bankDrumsModel } from './drum-fixtures.js';

// The import-midnam command. Every test works on a temp data folder (MOONTIDE_DATA_DIR for a
// spawned command, dataDir for a RigStore): never the user's real one. The only MIDNAM file used is
// the one written for the project. Nothing here sends MIDI or opens the network.

const { RigStore } = instruments;
const { runImportMidnam, runImportMidnamCommand } = importer;

const FIXTURE = fileURLToPath(new URL('./fixtures/moontide-test.midnam', import.meta.url));
const USAGE = 'Usage: moontide-mcp import-midnam <file> --model <id> [--replace]';

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-import-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** Runs the built entry with `args` and a temp data folder; resolves with the exit code and both streams. */
async function cli(t, args, dataDir) {
  const child = spawn(process.execPath, [DIST_ENTRY, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOONTIDE_NO_BROWSER: '1', MOONTIDE_DATA_DIR: dataDir },
  });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) => child.once('close', resolve));
  const { code } = await waitForExit(child, 10000);
  await closed;
  return { code, stdout, stderr };
}

/** A direct call of the command with its two streams captured. */
function direct(args, dataDir) {
  const out = [];
  const err = [];
  const code = runImportMidnam(args, { out: (line) => out.push(line), err: (line) => err.push(line), rig: new RigStore({ dataDir }) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const catalogFile = (dir, id = 'sc55') => path.join(dir, 'catalogs', `${id}.json`);
const leftovers = (dir) => (fs.existsSync(path.join(dir, 'catalogs')) ? fs.readdirSync(path.join(dir, 'catalogs')).filter((name) => name.endsWith('.tmp')) : []);

test('the command imports the fixture into catalogs/sc55.json, prints the summary and never starts the server', async (t) => {
  const dir = makeDir(t);
  const run = await cli(t, ['import-midnam', FIXTURE, '--model', 'sc55'], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.startsWith('Imported '), run.stdout);
  assert.match(run.stdout, /^First: "/m);
  assert.match(run.stdout, /^Last: "/m);
  assert.ok(!run.stderr.includes('Moontide page:'), 'the server did not start');
  const text = fs.readFileSync(catalogFile(dir), 'utf8');
  assert.ok(text.endsWith('\n'), 'the file ends with a newline');
  const parsed = JSON.parse(text);
  assert.equal(parsed.model, 'sc55');
  assert.equal(text.split('\n').filter((line) => line.includes('"program"')).length, parsed.sounds.length, 'one sound per line');
  assert.deepEqual(leftovers(dir), []);
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Port A' }] }));
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));
  assert.equal(state.instruments[0].catalog.sounds.length, parsed.sounds.length);
});

test('the summary gives the counts, then the first and last sound with the program as sent and as numbered from 1', (t) => {
  const dir = makeDir(t);
  const run = direct([FIXTURE, '--model', 'sc55'], dir);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^Imported 14 sounds in 5 banks from moontide-test\.midnam into .*sc55\.json \(model sc55\)\.$/m);
  assert.match(run.out, /^First: "Line -> Arrow" \(category "Group One", bank 0, program 1 as sent, 2 in a manual numbered from 1\)\.$/m);
  assert.match(run.out, /^Last: "Shared Two" \(category "Group Five", bank 24, program 1 as sent, 2 in a manual numbered from 1\)\.$/m);
  assert.match(
    run.out,
    /^Adjusted: 2 skipped for rhythm channels, 1 without a name, 0 already in the model; 1 merged at the same address; 2 renamed by address; 0 banks with only an LSB written with MSB 0\.$/m,
  );
  assert.match(run.out, /^The server reads it at its next change; no restart is needed\.$/m);
});

test('the fixture gives its sounds in file order, in every form the reader takes, with the bank as the file gives it', (t) => {
  const dir = makeDir(t);
  assert.equal(direct([FIXTURE, '--model', 'sc55'], dir).code, 0);
  const { sounds } = JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8'));
  assert.deepEqual(
    sounds.map((sound) => [sound.category, sound.name, sound.program, sound.bank?.msb]),
    [
      ['Group One', 'Line -> Arrow', 1, 0],
      ['Group One', 'Alpha & Beta', 2, 0],
      ['Group One', 'Caf\u00e9 Tone', 3, 0],
      ['Group One', '=Edge= Tone', 4, 0],
      ['Group One', 'Tone One (bank 0, program 5)', 5, 0],
      ['Group Two', 'Beta Two', 0, 8],
      ['Group Two', 'Beta Three', 1, 8],
      ['Group Three', 'Plain One', 20, undefined],
      ['Group Three', 'Plain Two', 21, undefined],
      ['Group Three', 'Tone One (bank 0, program 22)', 22, undefined],
      ['Group Four', 'Form A One', 5, 16],
      ['Group Four', 'Form A Two', 6, 12],
      ['Group Five', 'Shared One', 0, 24],
      ['Group Five', 'Shared Two', 1, 24],
    ],
  );
});

test('usage errors exit 2 with the usage line: no file, two files, no --model, --model without a value, an unknown option', async (t) => {
  const dir = makeDir(t);
  for (const args of [
    ['import-midnam', '--model', 'sc55'],
    ['import-midnam', FIXTURE, FIXTURE, '--model', 'sc55'],
    ['import-midnam', FIXTURE],
    ['import-midnam', FIXTURE, '--model'],
    ['import-midnam', FIXTURE, '--model', 'sc55', '--force'],
  ]) {
    const run = await cli(t, args, dir);
    assert.equal(run.code, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.ok(run.stderr.includes(USAGE), run.stderr);
    assert.ok(!run.stderr.includes('Moontide page:'), 'the server did not start');
  }
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
});

test('an unknown command exits 2 and says so', async (t) => {
  const run = await cli(t, ['foo'], makeDir(t));
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /unknown command "foo"/);
  assert.ok(!run.stderr.includes('Moontide page:'), 'the server did not start');
});

test('an unknown model exits 1, names the known models and writes nothing', (t) => {
  const dir = makeDir(t);
  const run = direct([FIXTURE, '--model', 'nosuch'], dir);
  assert.equal(run.code, 1);
  assert.match(run.err, /^Moontide: moontide-test\.midnam was not imported\.$/m);
  assert.match(run.err, /unknown model "nosuch", known models: mt32, sc55/);
  assert.match(run.err, /^Nothing was written\.$/m);
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
});

test('a model id that could climb out of the folder is refused with the id rule and writes nothing', (t) => {
  const dir = makeDir(t);
  const run = direct([FIXTURE, '--model', '../x'], dir);
  assert.equal(run.code, 1);
  assert.match(run.err, /--model: must be 1 to 32 lowercase letters, digits, dashes or underscores/);
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'x.json')));
});

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

test('a valid user model of the models folder is accepted', (t) => {
  const dir = makeDir(t, { 'models/synth.json': userModel });
  const run = direct([FIXTURE, '--model', 'synth'], dir);
  assert.equal(run.code, 0, run.err);
  assert.equal(JSON.parse(fs.readFileSync(catalogFile(dir, 'synth'), 'utf8')).model, 'synth');
});

test('an existing catalog is kept byte for byte without --replace, replaced with it, and no temp file is left', (t) => {
  const dir = makeDir(t, { 'catalogs/sc55.json': '{"keep":"me"}\n' });
  const before = fs.readFileSync(catalogFile(dir));
  const refused = direct([FIXTURE, '--model', 'sc55'], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /catalogs\/sc55\.json already exists in the Moontide data folder; pass --replace to replace it\./);
  assert.match(refused.err, /^Nothing was written\.$/m);
  assert.deepEqual(fs.readFileSync(catalogFile(dir)), before);
  assert.deepEqual(leftovers(dir), []);
  const replaced = direct([FIXTURE, '--model', 'sc55', '--replace'], dir);
  assert.equal(replaced.code, 0, replaced.err);
  assert.equal(JSON.parse(fs.readFileSync(catalogFile(dir), 'utf8')).model, 'sc55');
  assert.deepEqual(leftovers(dir), []);
});

test('a write failure exits 1 naming only the error code, and an existing catalog is unchanged', (t) => {
  const dir = makeDir(t, { 'catalogs/sc55.json': '{"keep":"me"}\n' });
  fs.mkdirSync(path.join(dir, 'catalogs', 'sc55.json.tmp'));
  const before = fs.readFileSync(catalogFile(dir));
  const run = direct([FIXTURE, '--model', 'sc55', '--replace'], dir);
  assert.equal(run.code, 1);
  assert.match(run.err, /could not be saved: [A-Z]+/);
  assert.ok(!run.err.includes(dir), 'no path in the reason');
  assert.deepEqual(fs.readFileSync(catalogFile(dir)), before);
  assert.ok(fs.statSync(path.join(dir, 'catalogs', 'sc55.json.tmp')).isDirectory(), 'the folder in the way is left alone');
});

test('a file whose shared list would expand past the cap is refused as a MidnamError, with nothing written', (t) => {
  const patches = '<Patch Number="1" Name="p" ProgramChange="1"/>'.repeat(150000);
  const text =
    '<MIDINameDocument><MasterDeviceNames><ChannelNameSet Name="Set"><PatchBank Name="B"><UsesPatchNameList Name="L"/></PatchBank></ChannelNameSet>' +
    `<PatchNameList Name="L">${patches}</PatchNameList></MasterDeviceNames></MIDINameDocument>`;
  const dir = makeDir(t, { 'big.midnam': text });
  const run = direct([path.join(dir, 'big.midnam'), '--model', 'sc55'], dir);
  assert.equal(run.code, 1);
  assert.match(run.err, /^Moontide: big\.midnam was not imported\.$/m);
  assert.match(run.err, /more than 100000 patches/);
  assert.match(run.err, /^Nothing was written\.$/m);
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
});

test('an error nobody planned for is one line and exit 1 through the entry point wrapper, not a stack trace', (t) => {
  const dir = makeDir(t);
  const err = [];
  const rig = new RigStore({ dataDir: dir });
  rig.modelFor = () => {
    throw new Error('boom\nsecond line');
  };
  const io = { out: () => {}, err: (line) => err.push(line), rig };
  assert.throws(() => runImportMidnam([FIXTURE, '--model', 'sc55'], io), /boom/);
  assert.equal(runImportMidnamCommand([FIXTURE, '--model', 'sc55'], io), 1);
  assert.equal(err.length, 1);
  assert.match(err[0], /^Moontide: import-midnam failed: boom/);
  assert.ok(!err[0].includes('\n') && !err[0].includes(' at '), 'one line, no stack');
  assert.equal(runImportMidnamCommand([], io), 2, 'a usage error keeps its own exit code');
});

test('a file that is not there is refused with its error code', (t) => {
  const dir = makeDir(t);
  const run = direct([path.join(dir, 'nothing.midnam'), '--model', 'sc55'], dir);
  assert.equal(run.code, 1);
  assert.match(run.err, /could not be read: ENOENT/);
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
});

test('modelFor: a shipped model and a user model are found, an unknown id names the known models', (t) => {
  const dir = makeDir(t, { 'models/synth.json': userModel });
  const rig = new RigStore({ dataDir: dir });
  assert.equal(rig.modelFor('sc55').ok, true);
  assert.equal(rig.modelFor('synth').ok, true);
  const unknown = rig.modelFor('nosuch');
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.problems, [{ field: 'model', reason: 'unknown model "nosuch", known models: mt32, sc55, synth' }]);
});

test('modelFor: a broken user model gives that file\'s problems only and leaves another model usable', (t) => {
  const dir = makeDir(t, { 'models/x.json': { ...userModel, id: 'x', name: undefined }, 'models/y.json': { ...userModel, id: 'y' } });
  const rig = new RigStore({ dataDir: dir });
  const broken = rig.modelFor('x');
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.length > 0);
  assert.ok(broken.problems.every((problem) => problem.field.startsWith('models/x.json')), JSON.stringify(broken.problems));
  assert.equal(rig.modelFor('y').ok, true);
});

test('modelFor: a data folder that cannot be found is said, and a shipped model needs none', () => {
  const rig = new RigStore({
    dataDir: () => {
      throw new Error('no home');
    },
  });
  assert.equal(rig.modelFor('sc55').ok, true);
  assert.deepEqual(rig.modelFor('nosuch'), { ok: false, problems: [{ field: 'data folder', reason: 'the data folder could not be found: no home' }] });
});

// Files written in the test, each refused or accepted by the same command.

const wrap = (banks) => `<MIDINameDocument><MasterDeviceNames><ChannelNameSet Name="Set">${banks}</ChannelNameSet></MasterDeviceNames></MIDINameDocument>`;
const bankOf = (name, commands, patches) => `<PatchBank Name="${name}">${commands}<PatchNameList>${patches}</PatchNameList></PatchBank>`;
const tone = (name, program) => `<Patch Name="${name}" ProgramChange="${program}"/>`;
const bankSelect = (...controls) => `<MIDICommands>${controls.map(([control, value]) => `<ControlChange Control="${control}" Value="${value}"/>`).join('')}</MIDICommands>`;
const midnamAt = (dir, content, name = 'in.midnam') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};

function manyBanks(count) {
  let banks = '';
  let made = 0;
  for (let index = 0; made < count; index++) {
    let patches = '';
    for (let program = 0; program < 128 && made < count; program++, made++) patches += tone(`Tone ${made}`, program);
    banks += bankOf(`Bank ${index}`, bankSelect([0, index]), patches);
  }
  return wrap(banks);
}

test('every file error is refused with its reason, nothing is written, and an existing catalog stays as it was', (t) => {
  const keep = '{"keep":"me"}\n';
  const dir = makeDir(t, { 'catalogs/sc55.json': keep });
  const one = wrap(bankOf('A', '', tone('x', 1)));
  const cases = [
    ['a syntax error names its line', '<MIDINameDocument>\n<MasterDeviceNames>\n<Patch Name="x"', /unterminated tag at line 3/],
    ['a root that is not MIDINameDocument', '<Foo/>', /the root element is <Foo>, not <MIDINameDocument>/],
    ['a program above 127 names the bank and the patch', wrap(bankOf('Group', '', tone('Tone', 128))), /program 128 of patch "Tone" in bank "Group" \(line 1\) is not between 0 and 127/],
    ['a bank value above 127', wrap(bankOf('Group', bankSelect([0, 200]), tone('Tone', 1))), /value 200 of ControlChange 0 in bank "Group"/],
    ['a control that is not a bank select', wrap(bankOf('Group', bankSelect([120, 0]), tone('Tone', 1))), /ControlChange 120 in bank "Group" \(line 1\) is not a bank select/],
    ['a patch with no program', wrap(bankOf('Group', '', '<Patch Name="Tone"/>')), /patch "Tone" \(line 1\) has no program/],
    ['no patch under a bank', wrap('<PatchBank Name="Empty"><PatchNameList/></PatchBank>'), /no patch found under a PatchBank/],
    ['a list that is not defined', wrap('<PatchBank Name="Shared"><UsesPatchNameList Name="Nowhere"/></PatchBank>'), /bank "Shared" \(line 1\) uses the patch list "Nowhere"/],
    ['patches under two devices', `<MIDINameDocument>\n${one.slice(18, -19)}\n${one.slice(18, -19)}\n</MIDINameDocument>`, /more than one MasterDeviceNames/],
    ['a file that only extends another device', '<MIDINameDocument><ExtendingDeviceNames><PatchNameList><Patch Name="a" ProgramChange="1"/></PatchNameList></ExtendingDeviceNames></MIDINameDocument>', /ExtendingDeviceNames/],
    ['a declared encoding other than UTF-8', `<?xml version="1.0" encoding="ISO-8859-1"?>${one}`, /declares the encoding "ISO-8859-1"; only UTF-8 is read/],
  ];
  for (const [label, content, reason] of cases) {
    const run = direct([midnamAt(dir, content), '--model', 'sc55', '--replace'], dir);
    assert.equal(run.code, 1, `${label}: ${run.out}`);
    assert.match(run.err, /^Moontide: in\.midnam was not imported\.$/m, label);
    assert.match(run.err, reason, label);
    assert.match(run.err, /^Nothing was written\.$/m, label);
    assert.equal(fs.readFileSync(catalogFile(dir), 'utf8'), keep, `${label}: the catalog is as it was`);
    assert.deepEqual(leftovers(dir), [], label);
  }
});

test('bytes that are not UTF-8 and a file over 8 MiB are refused before any reading of the content', (t) => {
  const dir = makeDir(t);
  const bad = Buffer.concat([Buffer.from('<MIDINameDocument><MasterDeviceNames><ChannelNameSet><PatchBank Name="A"><PatchNameList><Patch Name="Caf'), Buffer.from([0xe9]), Buffer.from('" ProgramChange="1"/></PatchNameList></PatchBank></ChannelNameSet></MasterDeviceNames></MIDINameDocument>')]);
  const notUtf8 = direct([midnamAt(dir, bad), '--model', 'sc55'], dir);
  assert.equal(notUtf8.code, 1);
  assert.match(notUtf8.err, /the file is not valid UTF-8/);
  const big = midnamAt(dir, '', 'big.midnam');
  fs.truncateSync(big, 8 * 1048576 + 1);
  const tooBig = direct([big, '--model', 'sc55'], dir);
  assert.equal(tooBig.code, 1);
  assert.match(tooBig.err, /the file is larger than 8 MiB/);
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
});

test('5000 sounds are imported and 5001 are refused', (t) => {
  const dir = makeDir(t);
  const ok = direct([midnamAt(dir, manyBanks(5000)), '--model', 'sc55'], dir);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^Imported 5000 sounds in 40 banks /);
  const before = fs.readFileSync(catalogFile(dir));
  const over = direct([midnamAt(dir, manyBanks(5001)), '--model', 'sc55', '--replace'], dir);
  assert.equal(over.code, 1);
  assert.match(over.err, /the file gives 5001 sounds; a catalog holds at most 5000/);
  assert.deepEqual(fs.readFileSync(catalogFile(dir)), before);
});

test('a file with a BOM and CRLF line ends is imported', (t) => {
  const dir = makeDir(t);
  const text = `\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n${wrap(bankOf('A', '', tone('One', 1))).replaceAll('><', '>\r\n<')}\r\n`;
  const run = direct([midnamAt(dir, text), '--model', 'sc55'], dir);
  assert.equal(run.code, 0, run.err);
});

test('a bank the model cannot send is refused with the catalog field and the sound name, three problems at most', (t) => {
  const dir = makeDir(t);
  const both = wrap(bankOf('A', bankSelect([0, 1], [32, 2]), ['One', 'Two', 'Three', 'Four', 'Five'].map((name, index) => tone(name, index)).join('')));
  const run = direct([midnamAt(dir, both), '--model', 'sc55'], dir);
  assert.equal(run.code, 1);
  assert.match(run.err, /^- catalogs\/sc55\.json:sounds\[0\]\.bank\.lsb \("One"\): this model takes a bank MSB only$/m);
  assert.match(run.err, /^- catalogs\/sc55\.json:sounds\[2\]\.bank\.lsb \("Three"\): this model takes a bank MSB only$/m);
  assert.doesNotMatch(run.err, /"Four"/);
  assert.match(run.err, /^- and 2 more problems$/m);
  const none = direct([midnamAt(dir, wrap(bankOf('A', bankSelect([0, 1]), tone('One', 1)))), '--model', 'mt32'], dir);
  assert.equal(none.code, 1);
  assert.match(none.err, /catalogs\/mt32\.json:sounds\[0\]\.bank \("One"\): this model has no bank select/);
  assert.ok(!fs.existsSync(path.join(dir, 'catalogs')), 'nothing was written');
});

test('a bank with only an LSB on a model that sends both is written with MSB 0 and counted', (t) => {
  const dir = makeDir(t, { 'models/synth.json': userModel });
  const run = direct([midnamAt(dir, wrap(bankOf('A', bankSelect([32, 3]), tone('One', 1) + tone('Two', 2)))), '--model', 'synth'], dir);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /1 banks with only an LSB written with MSB 0\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogFile(dir, 'synth'), 'utf8')).sounds[0].bank, { msb: 0, lsb: 3 });
});

test('a name the model already has is skipped at its address, and the summary counts it', (t) => {
  const dir = makeDir(t);
  const own = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../instruments/sc55.json', import.meta.url)), 'utf8')).sounds.melodic[0];
  const run = direct([midnamAt(dir, wrap(bankOf('A', '', tone(own.name, own.program) + tone('Other', 9)))), '--model', 'sc55'], dir);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^Imported 1 sound in 1 bank /);
  assert.match(run.out, /1 already in the model/);
});

test('a path with a space in it is imported', async (t) => {
  const dir = makeDir(t);
  const copy = path.join(dir, 'patch files', 'moontide test.midnam');
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(FIXTURE, copy);
  const run = await cli(t, ['import-midnam', copy, '--model', 'sc55'], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /from moontide test\.midnam into /);
});

// Prohibitions: no third-party patch list in the repo, and no way to the network.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every file and folder of the repository, skipping node_modules, dist and the folders that start with a dot. */
function walk(folder, found = { files: [], folders: [] }) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      found.folders.push(full);
      walk(full, found);
    } else {
      found.files.push(full);
    }
  }
  return found;
}

test('the repo holds no third-party patch list: only the fixture written for the project, and no catalogs folder', () => {
  const { files, folders } = walk(REPO_ROOT);
  const fixtures = path.join(REPO_ROOT, 'test', 'fixtures') + path.sep;
  const lists = files.filter((file) => file.toLowerCase().endsWith('.midnam'));
  assert.ok(lists.length >= 1, 'the fixture is there');
  for (const file of lists) {
    assert.ok(file.startsWith(fixtures), `${path.relative(REPO_ROOT, file)} is a patch list outside test/fixtures/`);
    assert.ok(fs.statSync(file).size <= 16384, `${path.relative(REPO_ROOT, file)} is larger than 16 KiB`);
    assert.ok(fs.readFileSync(file, 'utf8').includes('<Author>Moontide test fixture</Author>'), `${path.relative(REPO_ROOT, file)} does not say it is written for the project`);
  }
  assert.deepEqual(
    folders.filter((folder) => path.basename(folder) === 'catalogs').map((folder) => path.relative(REPO_ROOT, folder)),
    [],
    'a catalogs folder belongs in the data folder, never in the repo',
  );
});

test('the importer never opens a network path: its modules import no network module and never call fetch', () => {
  for (const name of ['midnam.ts', 'import-midnam.ts']) {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /from\s+['"](?:node:)?(?:http|https|http2|net|dgram|tls|dns)['"]/, `${name} imports a network module`);
    assert.doesNotMatch(source, /from\s+['"]undici['"]|require\(|import\(/, `${name} imports undici or loads a module late`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${name} calls fetch`);
    assert.doesNotMatch(source, /\bWebSocket\b|\bXMLHttpRequest\b/, `${name} names a network client`);
  }
});

// import-midnam keeps the drum kits of a model whose rhythm channels take a bank.

const kitDoc = (rhythmPatches) => `<?xml version="1.0" encoding="UTF-8"?>
<MIDINameDocument>
  <MasterDeviceNames>
    <ChannelNameSet Name="Melodic">
      <AvailableForChannels>
        <AvailableChannel Channel="1" Available="true" />
        <AvailableChannel Channel="2" Available="true" />
      </AvailableForChannels>
      <PatchBank Name="Group One">
        <MIDICommands><ControlChange Control="0" Value="1" /><ControlChange Control="32" Value="3" /></MIDICommands>
        <PatchNameList>
          <Patch Number="1" Name="Tone Two" ProgramChange="1" />
          <Patch Number="2" Name="Tone Three" ProgramChange="2" />
        </PatchNameList>
      </PatchBank>
    </ChannelNameSet>
    <ChannelNameSet Name="Drums">
      <AvailableForChannels>
        <AvailableChannel Channel="5" Available="true" />
      </AvailableForChannels>
      <PatchBank Name="Drum Group">
        ${rhythmPatches.bankCommands ?? '<MIDICommands><ControlChange Control="0" Value="86" /><ControlChange Control="32" Value="64" /></MIDICommands>'}
        <PatchNameList>
          ${rhythmPatches.patches}
        </PatchNameList>
      </PatchBank>
    </ChannelNameSet>
  </MasterDeviceNames>
</MIDINameDocument>
`;
const KIT_PATCHES = [
  '<Patch Number="1" Name="Pdf Kit One" ProgramChange="0" />',
  '<Patch Number="2" Name="Pdf Kit Two" ProgramChange="1" />',
  '<Patch Number="3" Name="Pdf Kit Three" ProgramChange="2" />',
].join('\n');

test('a model whose rhythm channels take a bank imports the rhythm name set as kits, and prints them', (t) => {
  const dir = makeDir(t, { 'models/bankdrums.json': bankDrumsModel(), 'kits.midnam': kitDoc({ patches: KIT_PATCHES }) });
  const run = direct([path.join(dir, 'kits.midnam'), '--model', 'bankdrums'], dir);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^Imported 2 sounds and 3 drum kits in 2 banks from kits\.midnam into .*bankdrums\.json \(model bankdrums\)\.$/m);
  assert.match(run.out, /^First: "Tone Two" /m);
  assert.match(run.out, /^First kit: "Pdf Kit One" \(category "Drum Group", bank 86\/64, program 0 as sent, 1 in a manual numbered from 1\)\.$/m);
  assert.match(run.out, /^Last kit: "Pdf Kit Three" \(category "Drum Group", bank 86\/64, program 2 as sent, 3 in a manual numbered from 1\)\.$/m);
  assert.match(run.out, /^Adjusted: 0 skipped for rhythm channels, /m);
  const written = JSON.parse(fs.readFileSync(catalogFile(dir, 'bankdrums'), 'utf8'));
  assert.equal(written.sounds.length, 2);
  assert.equal(written.kits.length, 3);
  assert.deepEqual(written.kits[1], { name: 'Pdf Kit Two', category: 'Drum Group', program: 1, bank: { msb: 86, lsb: 64 } });
});

test('a file with only kits imports "3 drum kits" without sound lines, and a kit with no bank is refused with nothing written', (t) => {
  const onlyKits = kitDoc({ patches: KIT_PATCHES }).replace(/<PatchBank Name="Group One">[\s\S]*?<\/PatchBank>/, '<PatchBank Name="Empty"><PatchNameList/></PatchBank>');
  const dir = makeDir(t, { 'models/bankdrums.json': bankDrumsModel(), 'kits.midnam': onlyKits, 'bare.midnam': kitDoc({ bankCommands: '', patches: KIT_PATCHES }) });
  const run = direct([path.join(dir, 'kits.midnam'), '--model', 'bankdrums'], dir);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^Imported 3 drum kits in 1 bank from kits\.midnam /m);
  assert.ok(!/^First: /m.test(run.out), run.out);
  assert.match(run.out, /^First kit: /m);
  const written = JSON.parse(fs.readFileSync(catalogFile(dir, 'bankdrums'), 'utf8'));
  assert.deepEqual(written.sounds, []);
  fs.rmSync(path.join(dir, 'catalogs'), { recursive: true });
  const bare = direct([path.join(dir, 'bare.midnam'), '--model', 'bankdrums'], dir);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /serves rhythm channels only and model bankdrums chooses its kits by bank select, but the file gives it no bank/);
  assert.match(bare.err, /Nothing was written\./);
  assert.equal(fs.existsSync(catalogFile(dir, 'bankdrums')), false);
});
