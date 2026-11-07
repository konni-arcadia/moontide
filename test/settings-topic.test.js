import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { checkSetup, parseRigMessage, RIG_COPY } from '../page/midi-rig.js';
import { fill, readMidiSetup } from '../page/midi-plan.js';
import { RigStore, describeRig, rigMessage } from '../dist/instruments.js';
import { toneSynthCatalog, toneSynthModel } from './settings-fixtures.js';

// The table that pins every paragraph of reference/settings.md to what proves it. A paragraph about what the page accepts, refuses or
// sends names a check of the settings group of `npm run probe:midi` (real Chrome over a fake MIDI device) and a unit test; a paragraph
// about where Claude reads names names a unit test; a paragraph about what the instrument itself does names its source, the bench
// records carried in the notes of its model, since the page cannot show it. A paragraph without a row, or a row whose paragraph changed, fails.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const topicText = fs.readFileSync(path.join(root, 'reference', 'settings.md'), 'utf8');
const probeSource = fs.readFileSync(path.join(root, 'scripts', 'probe-midi.mjs'), 'utf8');

const MEASURED = "the bench records of each instrument, carried in its model's notes";

// The titles of the unit tests, as the files of test/ write them.
const TEST_TITLES = (() => {
  const titles = new Set();
  const dir = path.join(root, 'test');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.test.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/^test\((?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"),/gm)) {
      titles.add((match[1] ?? match[2]).replace(/\\(['"])/g, '$1'));
    }
  }
  return titles;
})();

// The names of the checks of the settings group: the string literals handed to report( inside settingsMidiBlocks.
const PROBE_CHECKS = (() => {
  const start = probeSource.indexOf('export async function settingsMidiBlocks');
  const end = probeSource.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'settingsMidiBlocks is in the probe');
  const body = probeSource.slice(start, end);
  const names = new Set();
  for (const match of body.matchAll(/(?:report\(|refusal\()\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g)) {
    names.add(match[1] ?? match[2]);
  }
  return names;
})();

// --- The probe checks and unit tests the rows name ---

const CHECK = {
  levels: 'settings: tone, part and scene settings on two channels reach the port as the documented data sets in the documented order, after the program change of their channel',
  sceneReply: 'settings: the reply says a scene setting reaches every part, and the code keeps playing its notes',
  unknownName: 'settings: an unknown tone setting name fails the evaluation with the names that exist, the music keeps playing and nothing is sent',
  range: 'settings: a value out of range fails the evaluation with the range, the music keeps playing and nothing is sent',
  otherEngine: 'settings: a tone setting of another engine fails the evaluation naming both engines, the music keeps playing and nothing is sent',
  noSound: 'settings: tone settings with no sound in the call fail the evaluation with the reason, the music keeps playing and nothing is sent',
  noEngine: 'settings: tone settings on a sound the catalog does not place fail the evaluation with the reason, the music keeps playing and nothing is sent',
  underPart: 'settings: a scene setting written under part fails the evaluation naming the level it belongs to, the music keeps playing and nothing is sent',
  memory: "settings: a setting that points into the instrument's memory fails the evaluation with its address, the music keeps playing and no system exclusive message is sent",
  takenOut: 'settings: a setting taken out of the code sends nothing for it, the other data sets go out again, and the reply says the value stays on the instrument',
  ownSysex: "settings: the code's own system exclusive message into the instrument's memory never reaches the port, one into a temporary tone does, and the reply says nothing that could write memory is sent",
  barLine: 'settings: a change that waits for its bar line stamps its data sets, bank selects and program change with one timestamp, sent ahead of it and before the first note of the new code',
  replug: 'settings: a replug sends the settings of the playing code again after the program change of their channel, in both setups of the reconnect',
  card: 'settings: the Instruments card shows the Synth settings row with the tone and part settings of the playing code, the scene line that says it reaches every part, and the rule that a setting taken out of the code stays',
  listing: 'settings: every name and range get_midi_instruments lists for the instrument is taken at its lowest and highest value and sent, and one past the highest is refused with the range',
  engineRows: 'settings: a tone setting on a sound of a second or third engine reaches the port as that engine\'s documented data set, at the part of its channel',
  sharedName: "settings: one name described for two engines goes to the address of the sound's engine, and on a sound whose engine lacks it the evaluation fails naming the engines",
  offsetNrpn: 'settings: an offset setting reaches the port as the documented NRPN on the channel of its call, after the program change of that channel and before the next channel',
  nrpnRefused: 'settings: an NRPN the family does not list, an instrument with no NRPN family and an offset on a rhythm channel each fail the evaluation with their reason, the music keeps playing and nothing is sent',
  threeByte: 'settings: a tone, a part and a scene setting of an instrument with three-byte addresses reach the port as the documented data sets, at the part spacing of their area',
  timbreMemory: "settings: the code's own data set into a timbre memory of an instrument with three-byte addresses never reaches the port, one into its timbre temporary area does, and the reply says nothing that could write memory is sent",
  listingThree: 'settings: every name and range get_midi_instruments lists for an instrument with three-byte addresses is taken at its lowest and highest value and sent as its data set, and one past the highest is refused with the range',
  twoValues: 'settings: two values of one setting for one channel fail the evaluation naming both values, the music keeps playing and nothing is sent',
  notPlain: 'settings: a level that is not a plain object of number literals fails the evaluation, the music keeps playing and nothing is sent',
  newSound: 'settings: a new sound on a channel sends its program change before its part settings, and no line says a tone setting taken out with it stays',
};

const UNIT = {
  notPlain: 'a tone, part or scene option that is not a plain object of numbers is refused with the shape to write; the last key of a level wins',
  unknownName: 'an unknown name lists the names of its level, the closest first; a name of another level says where it belongs',
  rangeRule: 'a value that is not a whole number inside the range of its setting is refused with the range',
  twoValues: 'two different values of one setting are refused naming both; equal values and other channels pass',
  checked: 'the checked settings and scenes come back for a valid code and are empty on a refusal',
  engineOk: 'engine: a tone setting of the engine of the sound passes and records the sound and its engine; part and scene need no sound',
  engineNoSound: 'engine: tone settings with no sound in the call are refused once, whatever the number of names',
  engineUnknown: 'engine: a sound the catalog does not place, and a drum kit, refuse the tone settings with the reason',
  engineOther: 'engine: a setting of another engine is refused naming both engines and what the sound has; a row of two engines shows both joined',
  engineNone: 'engine: an instrument whose settings declare no engines has no engine rule',
  levelName: 'a name outside its level or the vocabulary is refused, with the level it belongs to or the closest name',
  fromFile: 'end to end: a setting goes from a model file in a data folder to a valid value or a refusal that lists what exists',
  vocabulary: 'the vocabulary names 309 tone settings, 13 part settings and 14 scene settings',
  dataSets: 'a size 1, size 2 and size 4 setting becomes the documented data set, with the part added where the level says',
  memoryAddress: 'buildSettings refuses an address outside the temporary scene and tones, with the address after the part is added',
  nonRoland: 'buildSettings refuses a control change or an NRPN row, naming its kind, and builds nothing',
  refusedSends: 'a refused setting fails the evaluation with its first line and the closing line, and nothing is sent',
  sentAgain: 'end to end: the same code evaluated again sends the data set again and no sound',
  order: 'end to end: two channels with tone, part, scene and a control leave in one exact order, and again the same way',
  sceneEvent: 'end to end: a scene setting that changed becomes one settings-scene event, worded for Claude, once',
  leftTold: 'a setting no longer in the code at the commit is told per level, and nothing is sent for it',
  toneLoaded: 'a tone setting of a channel whose sound was just sent gets no line: the tone was loaded again',
  keyedOnMessage: 'sysexProblem is keyed on the message: every data set for a model with known temporary areas, anywhere in the buffer, must stay inside them',
  memoryRefuses: 'the memory check refuses the areas that keep data for good, every read request and every broken message',
  readBytes: 'readSentBytes reads what a send hands on as Web MIDI does, within a bound, and refuses what it cannot read',
  otherMakers: 'a GS message from the code reaches the shipped SC-55 untouched, as it did before the guard',
  mt32Shipped: "to the shipped MT-32 its reset goes out when it connects and a timbre temporary data set from the code passes, and the code's own reset and a timbre memory data set are dropped with one line and one event",
  memoryCheck: 'the memory check lets the temporary scene and tones through, and every message that is not system exclusive',
  timed: 'a timed setup stamps its settings like its sound: the line minus SETUP_BEFORE_LINE_MS, after the sound of their channel, the scene after the channels',
  replug: 'a replug sends the settings of the code that plays after the sound, in the setup and in the second setup; the evaluation being prepared wins',
  card: 'the Synth settings copy holds the exact words',
  listingLines: 'get_midi_instruments lists the settings of an instrument per level and per engine, right after its Controls line',
  noSettingsLine: 'the reply for instruments whose model describes no settings holds no Settings line',
  oneToneLine: 'a model that declares no engines gets one Tone line, and a level with no rows says none',
  matchEngine: 'a search match gives the engine of the sound, or says it is in no engine',
  matchAfterCategory: 'a match puts the engine after the category',
  soundLines: 'the sound lines of an instrument give the engine inside the parentheses, and a drum kit never carries one',
  noTableEngine: 'a model that declares engines says its sounds are in no engine when the catalog has no engine table or there is no catalog',
  noBankEngine: 'a sound with no bank gets its engine in parentheses alone, and a bank in no engine says so',
  sharedRows: 'a name described for two engines goes to the address of the engine of the sound, at the part of its channel',
  sharedOne: 'one name may have one row per engine; a second row of a name whose engines overlap, or that names none, is refused at the second row',
  sharedRefused: 'a setting of another engine is refused naming the engines of every row of its name, then the names the sound has',
  sharedRange: "a value is checked against the range of the row of the sound's engine",
  sharedNeverFirst: 'a slot that has several rows for a name and no engine to choose by is refused with a line, never the first row',
  offsetBytes: 'every offset of the family, at its lowest, neutral and highest value, is the five documented messages on any melodic channel',
  offsetOrder: 'end to end: the offset leaves right after the bank select and program change of its channel, as one send of fifteen bytes, and again at each evaluation',
  offsetRefused: 'each refusal of an NRPN offset gives its own line, the memory check line where Moontide cannot check the pair, and builds nothing',
  offsetNotSentBack: 'an offset taken out of the code sends nothing for it: no value 64 goes out by itself, and the part level is told it stays',
  offsetSendTime: 'the NRPN set is checked again when it is sent, against the rig as it is then: no family, a rhythm channel',
  offsetNames: 'every name ending in Offset is a part name, and every offset row of the offset synth uses one',
  timbreBytes: 'every row of the timbre synth, at every part its level allows and three values, equals the map rule: the step of its area times the part minus one, in base 128',
  timbreGuard: 'the memory check of the MT-32 reads three-byte addresses and refuses patch memory, timbre memory, the write request and every read request',
  timbreReset: 'the all-parameters reset passes the check of the reset byte for byte, and as nothing else: not from the code, not with other data, not with a bad checksum, not as a setting',
  listingTakenByPage: 'the names and ranges get_midi_instruments lists for an instrument are what the page takes: each at its lowest and highest value, and one past the highest refused with the range',
};

// --- One row per paragraph of the topic ---

const page = (text, probe, tests) => ({ kind: 'page', text, probe, tests });
const where = (text, tests) => ({ kind: 'where', text, tests });
const instrument = (text) => ({ kind: 'instrument', text, source: MEASURED });
const frame = (text) => ({ kind: 'frame', text });

export const FACTS = [
  frame('What `.midi()` can do to set the settings of an instrument: the tone, part and scene options, as the Moontide page reads, checks and sends them. Every fact here is a plain possibility, not a suggestion of when to use it.'),

  where(
    'Only an instrument whose model describes settings takes them: get_midi_instruments lists, under the Settings line of that instrument, the names and ranges each level takes, with the tone names given per engine. An instrument with no Settings line takes no setting.',
    [UNIT.listingLines, UNIT.noSettingsLine, UNIT.oneToneLine, UNIT.listingTakenByPage],
  ),
  where(
    'The tone settings a sound takes are those of its engine. On an instrument whose model declares engines, search_midi_sounds and get_midi_instruments with instrument set give the engine of each sound or say it is in no engine, and a sound in no engine takes no tone setting. A catalog without an engine table places no sound in an engine.',
    [UNIT.matchEngine, UNIT.matchAfterCategory, UNIT.soundLines, UNIT.noBankEngine, UNIT.noTableEngine],
  ),
  page(
    'A tone name may be a setting of several engines, each with its own range, and the engine of the sound in the call decides which one is sent; the code is written the same way whichever engine the sound has.',
    [CHECK.engineRows, CHECK.sharedName],
    [UNIT.sharedRows, UNIT.sharedOne, UNIT.sharedRefused, UNIT.sharedRange, UNIT.sharedNeverFirst],
  ),
  where(
    'The names come from one vocabulary, listed below, and an instrument takes only the names its Settings line lists.',
    [UNIT.vocabulary, UNIT.levelName, UNIT.listingTakenByPage],
  ),
  frame('The tone names:'),
  frame('The part names:'),
  frame('The scene names:'),

  frame('The form is the tone, part and scene options of `.midi()`, each a plain object of names and values; every value below is a placeholder:'),
  page(
    'The level is the key of the option: a setting is tone, part or scene by where it is written, and each level is optional.',
    [CHECK.levels, CHECK.underPart],
    [UNIT.checked, UNIT.engineOk],
  ),
  page(
    'Each level is a plain object of names and whole numbers written as number literals in the call; a variable, a pattern or a value worked out while the code runs is refused.',
    [CHECK.notPlain],
    [UNIT.notPlain],
  ),
  page(
    "Values are in the instrument's own units, inside the range get_midi_instruments lists for the name.",
    [CHECK.listing, CHECK.listingThree, CHECK.range],
    [UNIT.rangeRule, UNIT.listingTakenByPage],
  ),
  page(
    'A setting is one value for the whole evaluation, never one per note.',
    [CHECK.notPlain, CHECK.twoValues],
    [UNIT.notPlain, UNIT.twoValues],
  ),

  page(
    'Tone reaches the tone of the part that the channel of the call plays.',
    [CHECK.levels, CHECK.threeByte],
    [UNIT.dataSets, UNIT.timbreBytes],
  ),
  page(
    'On an instrument whose model declares engines, tone needs a sound named in the same call, and the engine of that sound must have the setting.',
    [CHECK.noSound, CHECK.otherEngine],
    [UNIT.engineNoSound, UNIT.engineOther, UNIT.engineNone],
  ),
  page('Part reaches that part only.', [CHECK.levels, CHECK.threeByte], [UNIT.dataSets, UNIT.timbreBytes]),
  page(
    'Scene reaches every part of the instrument, not only the channel of the call that carries it, and the reply says so.',
    [CHECK.sceneReply, CHECK.card],
    [UNIT.sceneEvent],
  ),
  page(
    'A name belongs to one level, except `level`, which both part and scene have and which is a different setting at each: under part it is the level of that part, under scene the level of the whole scene.',
    [CHECK.underPart],
    [UNIT.levelName, UNIT.unknownName],
  ),
  where(
    'A name ending in Offset moves the value of the instrument itself up or down, so its lowest value is the largest move down and never off or closed; the value that changes nothing is given with the instrument.',
    [UNIT.offsetNames],
  ),

  page(
    'A name the level does not have is refused, and the refusal lists the names that exist.',
    [CHECK.unknownName],
    [UNIT.unknownName, UNIT.fromFile],
  ),
  page(
    'A name written at the wrong level is refused, and the refusal says the level it belongs to.',
    [CHECK.underPart],
    [UNIT.levelName, UNIT.unknownName],
  ),
  page(
    'A value outside the range is refused, and the refusal gives the range.',
    [CHECK.range, CHECK.listing, CHECK.listingThree],
    [UNIT.rangeRule, UNIT.listingTakenByPage],
  ),
  page(
    'Two values of one setting for one channel, or of one scene setting for one instrument, are refused, and the refusal names both.',
    [CHECK.twoValues],
    [UNIT.twoValues],
  ),
  page(
    'Tone settings with no sound in the call, on a sound in no engine, or on a sound of another engine are refused, and each refusal gives its own reason; only the refusal for a sound of another engine names the engines, the one of the sound and those of the setting.',
    [CHECK.noSound, CHECK.noEngine, CHECK.otherEngine],
    [UNIT.engineNoSound, UNIT.engineUnknown, UNIT.engineOther],
  ),
  page(
    'A setting Moontide cannot send safely to that instrument is refused, and the refusal says why.',
    [CHECK.memory, CHECK.nrpnRefused],
    [UNIT.memoryAddress, UNIT.nonRoland, UNIT.offsetRefused],
  ),
  page(
    'A refused evaluation keeps the music that was playing and sends nothing.',
    [CHECK.unknownName, CHECK.range, CHECK.otherEngine, CHECK.noSound, CHECK.noEngine, CHECK.underPart, CHECK.memory, CHECK.twoValues, CHECK.notPlain],
    [UNIT.refusedSends],
  ),

  page(
    'Every evaluation sends every setting the code writes, not only what changed.',
    [CHECK.takenOut, CHECK.levels],
    [UNIT.sentAgain],
  ),
  page(
    "Each channel's bank select and program change go first, then its tone and part settings, and the scene settings follow after all the channels.",
    [CHECK.levels, CHECK.newSound],
    [UNIT.order],
  ),
  page(
    'On an instrument whose model maps a setting to an NRPN, the setting goes out on the channel of its call as that NRPN, and Moontide never sends a value back by itself.',
    [CHECK.offsetNrpn, CHECK.nrpnRefused],
    [UNIT.offsetBytes, UNIT.offsetOrder, UNIT.offsetNotSentBack, UNIT.offsetSendTime],
  ),
  page(
    'A change that waits for a bar or phrase line sends its settings at the line, with its sound.',
    [CHECK.barLine],
    [UNIT.timed],
  ),
  page(
    'They are sent again, with the sound, when the instrument is plugged in again.',
    [CHECK.replug],
    [UNIT.replug],
  ),

  page(
    'Moontide stores no setting: the code is the only record.',
    [CHECK.card, CHECK.takenOut],
    [UNIT.card, UNIT.leftTold],
  ),
  page(
    'A setting taken out of the code is not sent again and nothing undoes it; the instrument keeps the last value, and the reply says so.',
    [CHECK.takenOut],
    [UNIT.leftTold],
  ),
  page(
    "A new sound on a channel loads that tone again, which undoes the channel's tone settings, and the tone settings still in the code are sent right after its program change.",
    [CHECK.newSound, CHECK.barLine, CHECK.replug],
    [UNIT.toneLoaded, UNIT.order],
  ),

  instrument('On the instrument, what undoes a setting differs from one instrument to another: the Notes line of the instrument in get_midi_instruments says what undoes each of its settings and what was heard on it.'),

  page(
    'The MIDI messages the code sends itself are checked just before they leave, on every port, whatever instruments are described. A Roland system exclusive message of a model whose temporary areas Moontide knows is sent only as a complete data set whose whole address range lies inside those areas; otherwise the whole send is dropped and the reply gives the reason. A send whose data cannot be read as byte-like values is dropped too. System exclusive messages of other makers and of other Roland models pass.',
    [CHECK.ownSysex, CHECK.timbreMemory],
    [UNIT.memoryCheck, UNIT.keyedOnMessage, UNIT.memoryRefuses, UNIT.readBytes, UNIT.otherMakers, UNIT.mt32Shipped, UNIT.timbreGuard, UNIT.timbreReset],
  ),
];

// --- The paragraphs of the topic ---

/** The paragraphs of the topic outside fenced blocks, the title, the headings and the applies-to line, each on one line. */
function topicParagraphs(text) {
  const withoutFences = text.replace(/^```[^\n]*\n[\s\S]*?\n```[ \t]*$/gm, '');
  return withoutFences
    .split(/\n{2,}/)
    .map((block) => block.trim().replace(/\s*\n\s*/g, ' '))
    .filter((block) => block !== '' && !block.startsWith('#') && !block.startsWith('Applies to '));
}

test('every paragraph of the settings topic has exactly one row of the table, and every row has its paragraph', () => {
  const paragraphs = topicParagraphs(topicText);
  assert.ok(paragraphs.length > 20, 'the topic is read');
  for (const paragraph of paragraphs) {
    const rows = FACTS.filter((row) => row.text === paragraph);
    assert.equal(rows.length, 1, `the paragraph needs exactly one row in FACTS (found ${rows.length}): ${paragraph}`);
  }
  for (const row of FACTS) {
    assert.ok(paragraphs.includes(row.text), `a row has no paragraph in the topic: ${row.text}`);
  }
  assert.equal(new Set(FACTS.map((row) => row.text)).size, FACTS.length, 'no paragraph twice');
});

test('a page row names at least one check of the settings group and one unit test that exist; a where row names a unit test', () => {
  for (const row of FACTS) {
    if (row.kind === 'page') {
      assert.ok(row.probe.length > 0, `no real-Chrome check: ${row.text}`);
      for (const name of row.probe) assert.ok(PROBE_CHECKS.has(name), `scripts/probe-midi.mjs has no check named "${name}" (row: ${row.text})`);
      assert.ok(row.tests.length > 0, `no unit test: ${row.text}`);
    }
    if (row.kind === 'page' || row.kind === 'where') {
      assert.ok(row.tests.length > 0, `no unit test: ${row.text}`);
      for (const title of row.tests) assert.ok(TEST_TITLES.has(title), `no unit test titled "${title}" in test/ (row: ${row.text})`);
    }
  }
});

test('every check of the settings group that starts with "settings:" is read from the probe, and the group has at least eighteen', () => {
  const names = [...PROBE_CHECKS].filter((name) => name.startsWith('settings:'));
  assert.ok(names.length >= 18, `only ${names.length} settings checks found`);
});

test('an instrument row is worded as what the instrument does and names the measured settings map as its source', () => {
  const rows = FACTS.filter((row) => row.kind === 'instrument');
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.text.includes('on the instrument') || row.text.includes('On the instrument'), `not worded as what the instrument does: ${row.text}`);
    assert.equal(row.source, MEASURED);
    assert.equal('probe' in row, false, 'the page cannot show what the instrument does, so no check is named');
  }
});

test('the table has at most five frame rows', () => {
  assert.ok(FACTS.filter((row) => row.kind === 'frame').length <= 5);
});

// --- The listing equals what the page takes ---

test('the names and ranges get_midi_instruments lists for an instrument are what the page takes: each at its lowest and highest value, and one past the highest refused with the range', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-settings-topic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'models'));
  fs.mkdirSync(path.join(dir, 'catalogs'));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify({ instruments: [{ id: 'tonesynth', model: 'tonesynth', port: 'Port T' }] }));
  fs.writeFileSync(path.join(dir, 'models', 'tonesynth.json'), JSON.stringify(toneSynthModel()));
  fs.writeFileSync(path.join(dir, 'catalogs', 'tonesynth.json'), JSON.stringify(toneSynthCatalog()));
  const state = new RigStore({ dataDir: dir }).read();
  assert.equal(state.setup, 'valid', JSON.stringify(state));

  // What Claude reads: the Settings lines of the instrument.
  const reply = describeRig(state, { connection: () => 'unknown', shipped: [], dataDirText: 'the data folder' }).split('\n');
  const rowsOf = (prefix) => {
    const line = reply.find((candidate) => candidate.startsWith(prefix));
    assert.ok(line !== undefined, `no line starting with ${prefix}`);
    const text = line.slice(line.indexOf(': ', prefix.length - 2) + 2);
    return text === 'none.' ? [] : text.replace(/\.$/, '').split(', ').map((entry) => {
      const found = /^(\w+) (\d+)-(\d+)$/.exec(entry);
      assert.ok(found !== null, `not a name with its range: ${entry}`);
      return { name: found[1], min: Number(found[2]), max: Number(found[3]) };
    });
  };
  const listed = {
    tone: rowsOf('    Tone, for a sound of engine "Model Engine": '),
    part: rowsOf('    Part, reaches the part its channel plays: '),
    scene: rowsOf('    Scene, reaches every part of the instrument: '),
  };
  assert.deepEqual(rowsOf('    Tone, for a sound of engine "Core Engine": '), []);
  const names = Object.values(listed).flat();
  assert.ok(names.length >= 9, 'the listing is read');

  // What the page takes: the message goes over the wire and the code is checked by the page's own rules.
  const rig = parseRigMessage(JSON.parse(JSON.stringify(rigMessage(state))));
  const call = (level, name, value) => `note("c3").midi('Port T', { midichannel: 1, sound: 'Model Tone', ${level}: { ${name}: ${value} } })`;
  const check = (code) => checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });
  for (const level of ['tone', 'part', 'scene']) {
    for (const row of listed[level]) {
      for (const value of [row.min, row.max]) {
        assert.equal(check(call(level, row.name, value)).refusal, null, `${level} ${row.name} ${value} is refused`);
      }
      const past = check(call(level, row.name, row.max + 1)).refusal;
      assert.ok(past !== null, `${level} ${row.name} one past the highest is accepted`);
      assert.equal(past.split('\n')[0], fill(RIG_COPY.settingRange, { setting: row.name, level, id: 'tonesynth', min: row.min, max: row.max }));
    }
  }
});
