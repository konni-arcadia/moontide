import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  STRUDEL_REPL_VERSION,
  REFERENCE_APPLIES_TO,
  REFERENCE_TOPICS,
  REFERENCE_TOPIC_IDS,
  REFERENCE_URI_PREFIX,
  REFERENCE_MAX_CHARS,
  referenceDir,
  readReferenceTopic,
  referenceIndexText,
  referenceToolDescription,
} from '../dist/reference.js';
import { startMcpClient, withoutPageLine } from './helpers.js';
import {
  parsePin,
  extractCalledNames,
  nameInBundle,
  paletteSources,
  namesBlockTokens,
  comparePalette,
  registeredArities,
  methodCalls,
  arityFailures,
  CHORD_SYMBOL_RE,
  chordVocabulary,
  chordSymbols,
  chordFailures,
  NOTE_NAME_RE,
  noteTokens,
  noteFailures,
  miniGrammar,
  miniStrings,
  miniFailures,
  PROSE_CLAIMS,
  proseClaimFailures,
  SAMPLE_EXCLUSIONS,
  SOUND_FILE_MANIFESTS,
  browserRefusal,
  soundFileTargets,
  gmSoundfontTargets,
  checkSoundFiles,
  registeredControls,
  registryFailures,
} from '../scripts/check-reference.mjs';
import { VCSL_SAMPLE_BASE } from '../page/ui-state.js';
import { TINT_WORDS, STEERING_WORDS, ALLOWED_DEMO_SOUNDS, findWords, fencedBlocks, stripNamesBlocks, fenceTags, demoSoundTokens } from './tint-rules.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- Module ---

test('reference module: REFERENCE_TOPIC_IDS equals the table ids, in table order', () => {
  assert.deepEqual(REFERENCE_TOPIC_IDS, REFERENCE_TOPICS.map((topic) => topic.id));
});

test('reference module: all eight topics are present, in table order with midi last, and referenceIndexText has ten lines', () => {
  assert.deepEqual(REFERENCE_TOPIC_IDS, [
    'tidal-differences',
    'mini-notation',
    'functions',
    'effects',
    'sounds',
    'theory',
    'transitions',
    'midi',
  ]);
  assert.equal(referenceIndexText().split('\n').length, 10);
});

test('reference module: referenceIndexText has the two fixed lines then one row per topic, in order', () => {
  const lines = referenceIndexText().split('\n');
  assert.equal(
    lines[0],
    `Strudel reference for @strudel/repl ${STRUDEL_REPL_VERSION}, the version the Moontide page loads. Facts only: what exists and how to write it.`,
  );
  assert.equal(lines[1], 'Call get_strudel_reference with one of these topics:');
  const topicLines = lines.slice(2);
  assert.equal(topicLines.length, REFERENCE_TOPICS.length);
  for (const [i, topic] of REFERENCE_TOPICS.entries()) {
    assert.equal(topicLines[i], `- ${topic.id}: ${topic.summary}`);
  }
});

test('reference module: readReferenceTopic reads the exact file content', () => {
  const direct = fs.readFileSync(path.join(repoRoot, 'reference', 'tidal-differences.md'), 'utf8');
  assert.equal(readReferenceTopic('tidal-differences'), direct);
});

test('reference module: readReferenceTopic throws a truthful message when the file is missing', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-reference-test-'));
  assert.throws(
    () => readReferenceTopic('tidal-differences', emptyDir),
    (err) => {
      assert.ok(
        err.message.startsWith('Strudel reference unavailable: could not read reference/tidal-differences.md ('),
      );
      return true;
    },
  );
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test('reference module: the reference/ directory has no orphan .md file and no missing table file', () => {
  const filesOnDisk = fs
    .readdirSync(path.join(repoRoot, 'reference'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const filesInTable = REFERENCE_TOPICS.map((topic) => topic.file).sort();
  assert.deepEqual(filesOnDisk, filesInTable);
});

test('reference module: page/index.html pins the same Strudel version as STRUDEL_REPL_VERSION', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'page', 'index.html'), 'utf8');
  assert.ok(html.includes(`@strudel/repl@${STRUDEL_REPL_VERSION}/dist/index.js`));
});

test('reference module: every topic file starts with "# {title}" and contains REFERENCE_APPLIES_TO, and is under the size cap', () => {
  for (const topic of REFERENCE_TOPICS) {
    const text = readReferenceTopic(topic.id);
    assert.ok(text.startsWith(`# ${topic.title}`), `${topic.file} must start with "# ${topic.title}"`);
    assert.ok(text.includes(REFERENCE_APPLIES_TO), `${topic.file} must contain the applies-to line`);
    assert.ok(text.length <= REFERENCE_MAX_CHARS, `${topic.file} must be at most ${REFERENCE_MAX_CHARS} characters`);
  }
});

test('reference module: package.json files includes reference', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('reference'));
});

test('reference module: referenceToolDescription lists every topic id and mentions tidal-differences', () => {
  const description = referenceToolDescription();
  for (const id of REFERENCE_TOPIC_IDS) {
    assert.ok(description.includes(id), `description must mention topic "${id}"`);
  }
  assert.ok(description.includes('tidal-differences'));
});

test('reference module: referenceDir resolves to the repo reference/ directory', () => {
  assert.equal(fs.realpathSync(referenceDir()), fs.realpathSync(path.join(repoRoot, 'reference')));
});

// --- MCP end to end (no page connected) ---

test('get_strudel_reference: listed with readOnlyHint, returns the index and topic text, resources match, and it never touches the session', async (t) => {
  const { client } = await startMcpClient();
  t.after(async () => {
    await client.close();
  });

  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === 'get_strudel_reference');
  assert.ok(tool, 'expected get_strudel_reference to be listed');
  assert.equal(tool.annotations?.readOnlyHint, true);

  const indexResult = await client.callTool({ name: 'get_strudel_reference', arguments: {} });
  assert.ok(!indexResult.isError);
  assert.equal(indexResult.content[0].text, referenceIndexText());

  const topicResult = await client.callTool({
    name: 'get_strudel_reference',
    arguments: { topic: 'tidal-differences' },
  });
  assert.ok(!topicResult.isError);
  assert.equal(topicResult.content[0].text, readReferenceTopic('tidal-differences'));

  const topicResultAgain = await client.callTool({
    name: 'get_strudel_reference',
    arguments: { topic: 'tidal-differences' },
  });
  assert.equal(topicResultAgain.content[0].text, topicResult.content[0].text);

  // An id outside REFERENCE_TOPIC_IDS is rejected by input validation before any file is read.
  const invalidResult = await client.callTool({
    name: 'get_strudel_reference',
    arguments: { topic: '../package' },
  });
  assert.ok(invalidResult.isError);
  assert.match(invalidResult.content[0].text, /Invalid arguments|Input validation error/i);

  const instructions = client.getInstructions();
  assert.ok(instructions?.includes('get_strudel_reference'));

  const { resources } = await client.listResources();
  const resourceUris = resources.map((resource) => resource.uri);
  assert.ok(resourceUris.includes(`${REFERENCE_URI_PREFIX}/tidal-differences`));
  assert.ok(resourceUris.includes(REFERENCE_URI_PREFIX));

  const readResult = await client.readResource({ uri: `${REFERENCE_URI_PREFIX}/tidal-differences` });
  assert.equal(readResult.contents[0].text, topicResult.content[0].text);

  const readIndexResult = await client.readResource({ uri: REFERENCE_URI_PREFIX });
  assert.equal(readIndexResult.contents[0].text, indexResult.content[0].text);

  // The reference tool never touches session/page state.
  const codeResult = await client.callTool({ name: 'get_code', arguments: {} });
  assert.equal(withoutPageLine(codeResult.content[0].text), 'Nothing is playing yet.');
});

test('midi topic: the drum kit paragraph follows the pinned drum-notes example, through get_strudel_reference', async (t) => {
  const { client } = await startMcpClient();
  t.after(async () => {
    await client.close();
  });

  const result = await client.callTool({ name: 'get_strudel_reference', arguments: { topic: 'midi' } });
  assert.ok(!result.isError);
  const text = result.content[0].text;

  const sentences = [
    "A drum kit is chosen like a sound, with the sound option of `.midi()` on the instrument's rhythm channel.",
    "On an instrument whose rhythm channels take a bank, the page sends the kit's bank select and then its program change before the new code plays; on every other instrument a kit is a program change alone.",
    "get_midi_instruments gives each instrument's drum map, which note plays which drum, and says when a kit has no known map; the code keeps writing note numbers.",
  ];
  for (const sentence of sentences) {
    assert.ok(text.includes(sentence), `missing: ${sentence}`);
  }

  const drumNotesSentence =
    "A drum track for a MIDI instrument therefore writes note numbers, such as the General MIDI drum notes 36, 38 and 42, on the instrument's drum channel (10 on a General MIDI instrument):";
  const drumNotesAt = text.indexOf(drumNotesSentence);
  assert.ok(drumNotesAt >= 0, 'the pinned drum-notes sentence is missing');
  const fenceClose = text.indexOf('\n```\n', text.indexOf('```js', drumNotesAt) + 5);
  assert.ok(fenceClose > drumNotesAt, 'the drum-notes code block has no closing fence');
  const paragraphAt = text.indexOf(sentences[0]);
  const noteLastsAt = text.indexOf("A note lasts its event's length");
  assert.ok(paragraphAt > fenceClose, 'the paragraph must come after the drum-notes code block');
  assert.ok(noteLastsAt > paragraphAt, "the paragraph must come before 'A note lasts its event's length'");

  const paragraph = text.slice(paragraphAt, noteLastsAt).trim();
  assert.deepEqual(paragraph.match(/`[^`]*`/g), ['`.midi()`']);
  assert.deepEqual(findWords(paragraph, TINT_WORDS), []);
  assert.deepEqual(findWords(paragraph, STEERING_WORDS), []);
});

// --- check-reference.mjs unit cases ---

test('check-reference: parsePin reads the pinned version, url and sha384 integrity from page/index.html', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'page', 'index.html'), 'utf8');
  const pin = parsePin(html);
  assert.equal(pin.version, STRUDEL_REPL_VERSION);
  assert.equal(pin.url, `https://unpkg.com/@strudel/repl@${STRUDEL_REPL_VERSION}/dist/index.js`);
  assert.ok(pin.integrity.startsWith('sha384-'), `expected integrity to start with sha384-, got ${pin.integrity}`);
});

test('check-reference: parsePin throws a check:reference-prefixed error when no script tag is found', () => {
  assert.throws(
    () => parsePin('<html></html>'),
    (err) => {
      assert.ok(err.message.startsWith('check:reference FAILED:'));
      return true;
    },
  );
});

test('check-reference: extractCalledNames returns method calls and bare calls from js blocks and inline code, sorted, ignoring tidal blocks', () => {
  const fixture = [
    '```js',
    'note("c").lpf(400).slow(2)',
    '```',
    '',
    '```tidal',
    'whenmod 4 2 (# crush 4)',
    '```',
    '',
    'Inline: `.room()`',
  ].join('\n');
  assert.deepEqual(extractCalledNames(fixture), ['lpf', 'note', 'room', 'slow']);
});

test('check-reference: extractCalledNames skips JS globals and their members, and language keywords', () => {
  const fixture = [
    '```js',
    'if (Math.min(0, 1) > 0) {',
    '  console.log(JSON.parse("{}"));',
    '}',
    'for (let i = 0; i < 2; i++) {}',
    's("bd").lpf(400)',
    '```',
  ].join('\n');
  assert.deepEqual(extractCalledNames(fixture), ['lpf', 's']);
});

test('check-reference: extractCalledNames verifies bare (non-called) identifier mentions in prose, excluding signature-call param names, BARE_NAME_EXCLUSIONS entries, sub-3-character spans, and digit-suffixed streams', () => {
  const fixture = [
    '`struct(boolPattern)` builds structure.',
    '`tri` and `sqr` are short aliases for `triangle` and `square`.',
    "Tidal's `whenmod` has no Strudel equivalent.",
    'The `restore_version` tool name is not part of the Strudel API.',
    'The `get_code` tool and the `phraseCycles` option of `set_code` are not part of the Strudel API either.',
    'Filter prefixes like `hp` are too short to verify.',
    'A hypothetical numbered stream like `zz9` reads as Tidal-shaped, not a Strudel name.',
  ].join('\n');
  const names = extractCalledNames(fixture);
  assert.ok(names.includes('tri') && names.includes('sqr'));
  assert.ok(!names.includes('boolPattern')); // signature-call param, not an API name
  assert.ok(!names.includes('whenmod')); // BARE_NAME_EXCLUSIONS entry
  assert.ok(!names.includes('restore_version')); // BARE_NAME_EXCLUSIONS entry
  assert.ok(!names.includes('get_code') && !names.includes('phraseCycles')); // BARE_NAME_EXCLUSIONS entries
  assert.ok(!names.includes('hp')); // under the 3-character floor
  assert.ok(!names.includes('zz9')); // letters-then-digits reads as a Tidal numbered stream
});

test('check-reference: nameInBundle recognizes quoted strings, object keys, prototype assignment and function declarations, never a bare substring', () => {
  assert.equal(nameInBundle('lpf', 'const x = "lpf";'), true);
  assert.equal(nameInBundle('lpf', "const x = 'lpf';"), true);
  assert.equal(nameInBundle('lpf', '{lpf: 1}'), true);
  assert.equal(nameInBundle('lpf', 'a, lpf: 2'), true);
  assert.equal(nameInBundle('lpf', 'Pattern.prototype.lpf=function(){}'), true);
  assert.equal(nameInBundle('lpf', 'function lpf(x) { return x; }'), true);
  assert.equal(nameInBundle('lpf', 'const lpfx = 1;'), false);
  assert.equal(nameInBundle('lpf', 'no match here'), false);
});

test('check-reference: namesBlockTokens parses plain space-separated lines and labeled "Machine: type type" lines', () => {
  const markdown = ['```names', 'sine square', 'DrumBox: bd sd hh', '```'].join('\n');
  assert.deepEqual(namesBlockTokens(markdown), [
    { label: null, tokens: ['sine', 'square'] },
    { label: 'DrumBox', tokens: ['bd', 'sd', 'hh'] },
  ]);
});

test('check-reference: paletteSources reads waveforms/noises/extra synths (excluding non-sounds), zzfx, gm_, drum machines, kit, sample sets and aliases from bundle text and manifests', () => {
  const bundleFixture = [
    'const waveforms=["triangle","sine"],noises=["white"];',
    'registerSound("supersaw",fn);',
    'registerSound("bus",fn);', // excluded: an audio bus, not a playable sound
    'function registerZZFXSounds(){["zzfx","z_sine"].forEach(x=>{})}',
    'const x="gm_piano";const y="gm_flute";',
  ].join('\n');
  const manifests = {
    'tidal-drum-machines.json': { _base: 'x', RolandTR808_bd: 1, RolandTR808_sd: 1, TestMachine_: 1 },
    'strudel.json': { _base: 'x', bd: [], sd: [] },
    'piano.json': { _base: 'x', piano: {} },
    'Dirt-Samples.json': { _base: 'x', casio: {} },
    'vcsl.json': { _base: 'x', harp: {} },
    'mridangam.json': { _base: 'x', ta: {} },
    'tidal-drum-machines-alias.json': { RolandTR808: 'TR808' },
  };
  const sources = paletteSources(bundleFixture, manifests);
  assert.deepEqual([...sources.synths].sort(), ['sine', 'supersaw', 'triangle', 'white']);
  assert.deepEqual([...sources.zzfx].sort(), ['z_sine', 'zzfx']);
  assert.deepEqual([...sources.gm].sort(), ['gm_flute', 'gm_piano']);
  assert.deepEqual([...sources.drumMachines.keys()], ['RolandTR808']);
  assert.deepEqual([...sources.drumMachines.get('RolandTR808')].sort(), ['bd', 'sd']);
  assert.deepEqual([...sources.drumKit].sort(), ['bd', 'sd']);
  assert.deepEqual([...sources.sampleSets.get('piano')], ['piano']);
  assert.deepEqual([...sources.aliases], ['TR808']);
});

test('check-reference: paletteSources filters SAMPLE_EXCLUSIONS names out of a sample set, and SAMPLE_EXCLUSIONS states a non-empty reason mentioning 404', () => {
  const manifests = {
    'tidal-drum-machines.json': { _base: 'x' },
    'strudel.json': { _base: 'x' },
    'piano.json': { _base: 'x' },
    'Dirt-Samples.json': { _base: 'x' },
    'vcsl.json': { _base: 'x', harp: {}, tom_mallet: [] },
    'mridangam.json': { _base: 'x' },
    'tidal-drum-machines-alias.json': {},
  };
  const sources = paletteSources('', manifests);
  assert.ok(sources.sampleSets.get('vcsl').has('harp'));
  assert.ok(!sources.sampleSets.get('vcsl').has('tom_mallet'));

  const reason = SAMPLE_EXCLUSIONS.get('vcsl')?.get('tom_mallet');
  assert.ok(typeof reason === 'string' && reason.length > 0);
  assert.ok(reason.includes('404'));
});

test('comparePalette: reports a missing name, an unknown name, a wrong-type machine line, and a clean match', () => {
  const sources = {
    synths: new Set(['sine', 'square']),
    zzfx: new Set(),
    gm: new Set(),
    drumMachines: new Map([['DrumBox', new Set(['bd', 'sd'])]]),
    drumKit: new Set(),
    sampleSets: new Map(),
    aliases: new Set(),
  };

  const missingMarkdown = ['```names', 'sine', 'DrumBox: bd sd', '```'].join('\n');
  assert.deepEqual(comparePalette(sources, missingMarkdown).missing, ['square']);

  const unknownMarkdown = ['```names', 'sine square triangle', 'DrumBox: bd sd', '```'].join('\n');
  assert.deepEqual(comparePalette(sources, unknownMarkdown).unknown, ['triangle']);

  const wrongTypeMarkdown = ['```names', 'sine square', 'DrumBox: bd cp', '```'].join('\n');
  const wrongTypeResult = comparePalette(sources, wrongTypeMarkdown);
  assert.ok(wrongTypeResult.wrongTypes.some((m) => m.includes('lists "cp"')));
  assert.ok(wrongTypeResult.wrongTypes.some((m) => m.includes('missing "sd"')));

  const cleanMarkdown = ['```names', 'sine square', 'DrumBox: bd sd', '```'].join('\n');
  assert.deepEqual(comparePalette(sources, cleanMarkdown), { missing: [], unknown: [], wrongTypes: [] });
});

// --- check-reference: registeredArities / methodCalls / arityFailures ---

test('check-reference: registeredArities reads Function.length from register() calls in every shape: function(), array names, arrow, default-stopped, bare arrow, and identifier resolution', () => {
  const fixture = [
    'register("voicing",function(o){return o})',
    'register(["mode","anchor"],function(o,e){return o})',
    'register("fast",(o,e)=>o)',
    'register("x",function(o,e=1){return o})',
    'register("y",o=>o)',
    'register("z",someFn)',
    'register("w",someFn2);function someFn2(a,b,c){return a}',
  ].join('\n');
  const { arities, unresolved } = registeredArities(fixture);
  assert.equal(arities.voicing, 1);
  assert.equal(arities.mode, 2);
  assert.equal(arities.anchor, 2);
  assert.equal(arities.fast, 2);
  assert.equal(arities.x, 1);
  assert.equal(arities.y, 1);
  assert.equal(arities.w, 3);
  assert.deepEqual(unresolved, ['z']);
});

test('check-reference: registeredArities never matches the declaration of register() itself or a recursive call with an identifier first argument', () => {
  const fixture = 'function register(o,e,l=!0,d=!1,p=b=>b.innerJoin()){return register(se,e,l,d,p)}';
  const { arities, unresolved } = registeredArities(fixture);
  assert.deepEqual(arities, {});
  assert.deepEqual(unresolved, []);
});

test('check-reference: registeredArities resolves an identifier containing $ — the definition RegExp is escaped, so $ does not act as an end-of-string anchor', () => {
  const fixture = 'register("mySound",f$1);f$1=(a,b)=>a;';
  const { arities, unresolved } = registeredArities(fixture);
  assert.equal(arities.mySound, 2);
  assert.deepEqual(unresolved, []);
});

test('check-reference: methodCalls counts top-level arguments across nested parens, string commas, arrow arguments, trailing commas, inline spans; ignores comments and tidal blocks', () => {
  const fixture = [
    '```js',
    '.range(0, Math.min(1, 2))',
    '.gain("1, 2")',
    '.off(0.25, x=>x.fast(2))',
    '.fast(2,)',
    '// .lpf(400) inside a comment',
    '```',
    '',
    '```tidal',
    '.crush(4)',
    '```',
    '',
    'Inline: `.voicing()`',
  ].join('\n');
  const calls = methodCalls(fixture);
  const byName = Object.fromEntries(calls.map((c) => [c.name, c.args]));
  assert.equal(byName.range, 2);
  assert.equal(byName.gain, 1);
  assert.equal(byName.off, 2);
  assert.equal(byName.fast, 1);
  assert.equal(byName.voicing, 0);
  assert.ok(!('lpf' in byName), 'a call inside a // comment must not be counted');
  assert.ok(!('crush' in byName), 'a call inside a ```tidal block must not be counted');
});

test('check-reference: arityFailures flags an options object passed to an arity-1 name, passes a bare call, tolerates any count at arity 2, flags a wrong count at arity 3, and always flags an unresolved name', () => {
  const registered = { arities: { voicing: 1, fast: 2, off: 3 }, unresolved: ['mystery'] };
  const calls = [
    { name: 'voicing', args: 1, snippet: '.voicing({ mode: "below" })' },
    { name: 'voicing', args: 0, snippet: '.voicing()' },
    { name: 'fast', args: 3, snippet: '.fast(2,3,4)' },
    { name: 'off', args: 1, snippet: '.off(0.25)' },
    { name: 'mystery', args: 0, snippet: '.mystery()' },
  ];
  const failures = arityFailures(calls, registered, 'test.md');
  assert.equal(failures.length, 3);
  assert.ok(failures.some((f) => f.includes('takes 0 argument(s)') && f.includes('.voicing({ mode: "below" })')));
  assert.ok(failures.some((f) => f.includes('.off() takes 2 argument(s)')));
  assert.ok(failures.some((f) => f.includes('.mystery(): cannot read its arity from the bundle')));
});

test('check-reference: offline guard — no methodCalls entry named voicing in the committed reference has any argument (check:reference does the general arity check against the live bundle)', () => {
  for (const topic of REFERENCE_TOPICS) {
    const text = readReferenceTopic(topic.id);
    for (const call of methodCalls(text)) {
      if (call.name === 'voicing') {
        assert.equal(call.args, 0, `${topic.file}: .voicing() must take no argument: ${call.snippet}`);
      }
    }
  }
});

// --- check-reference: chordVocabulary / chordSymbols / chordFailures ---

const VOICING_ALIAS_FIXTURE = [
  'simple={"-":["1P"],"-7":["1P"],"^7":["1P"],"+":["1P"],"-^7":["1P"],"7":["1P"]};',
  'voicingAlias("^","",[simple,complex]),',
  'Object.keys(simple).forEach(o=>{',
  'if(o.includes("-")){let e=o.replace("-","m");voicingAlias(o,e,[complex,simple])}',
  'if(o.includes("^")){let e=o.replace("^","M");voicingAlias(o,e,[complex,simple])}',
  'if(o.includes("+")){let e=o.replace("+","aug");voicingAlias(o,e,[complex,simple])}',
  '}),registerVoicings("ireal",simple)',
].join('');

test('check-reference: chordVocabulary reads dictionary keys and computes aliases (first-occurrence replace, once per rule per key) from a trimmed fixture', () => {
  const vocab = chordVocabulary(VOICING_ALIAS_FIXTURE);
  assert.deepEqual([...vocab.keys].sort(), ['+', '-', '-7', '-^7', '7', '^7']);
  assert.deepEqual([...vocab.aliases].sort(), ['-M7', 'M7', 'aug', 'm', 'm7', 'm^7']);
  assert.ok(vocab.accepted.has(''));
  assert.ok(vocab.accepted.has('-7') && vocab.accepted.has('m7'));
});

test('check-reference: chordVocabulary returns null when an alias-rule text is missing (a pin change)', () => {
  const withoutAugRule = VOICING_ALIAS_FIXTURE.replace(
    'if(o.includes("+")){let e=o.replace("+","aug");voicingAlias(o,e,[complex,simple])}',
    '',
  );
  assert.equal(chordVocabulary(withoutAugRule), null);
});

test('check-reference: chordSymbols extracts step tokens from chord( strings and strings chained with .voicing(, never from an unrelated string', () => {
  const fixture = [
    '```js',
    'chord("<C Am>").voicing()',
    '"<C-7 Eb^7>".voicing()',
    'mode("below")',
    '```',
  ].join('\n');
  const symbols = chordSymbols(fixture);
  assert.ok(symbols.includes('C'));
  assert.ok(symbols.includes('Am'));
  assert.ok(symbols.includes('C-7'));
  assert.ok(symbols.includes('Eb^7'));
  assert.ok(!symbols.includes('below'), 'a string not passed to chord( or chained with .voicing( must not be scanned');
});

test('check-reference: chordFailures flags a lowercase root, a chord root spelled with f, unaccepted common names, and the unwritable + suffix; accepts real dictionary keys and aliases plus a slash-bass chord', () => {
  const vocab = chordVocabulary(VOICING_ALIAS_FIXTURE);
  const failing = ['c', 'Bf', 'Cmaj7', 'Csus2', 'C+'];
  const passing = ['C', 'Am', 'C^7', 'Cm7', 'Caug', 'Bb-7', 'C/E'];
  const failures = chordFailures([...failing, ...passing], vocab, 'test.md');
  for (const token of failing) {
    assert.ok(failures.some((f) => f.endsWith(`: ${token}`)), `expected ${token} to be flagged`);
  }
  for (const token of passing) {
    assert.ok(!failures.some((f) => f.endsWith(`: ${token}`)), `expected ${token} to be accepted`);
  }
});

test('check-reference: offline guard — every chordSymbols token of every REFERENCE_TOPICS file is accepted by the vocabulary read from theory.md\'s own two chord names blocks', () => {
  const theoryText = readReferenceTopic('theory');
  const namesBlocks = [...theoryText.matchAll(/```names\n([\s\S]*?)```/g)].map((m) =>
    m[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  // The Chords section's two names blocks are the ones directly after "## Chords" and before
  // "## Voicings and inversions" — theory.md has three ```names blocks total (scales, chord keys,
  // chord aliases); the chord ones are the last two.
  const [keysBlockLines, aliasesBlockLines] = namesBlocks.slice(-2);
  const vocab = { accepted: new Set([...keysBlockLines, ...aliasesBlockLines, '']) };
  for (const topic of REFERENCE_TOPICS) {
    const text = readReferenceTopic(topic.id);
    for (const token of chordSymbols(text)) {
      const match = CHORD_SYMBOL_RE.exec(token);
      const suffix = match ? match[2] ?? '' : null;
      assert.ok(
        match && !token.includes('+') && vocab.accepted.has(suffix),
        `${topic.file}: chord symbol not accepted by theory.md's own chord lists: ${token}`,
      );
    }
  }
});

// --- check-reference: noteTokens / noteFailures ---

test('check-reference: noteFailures flags a chord symbol and leftover Tidal chord syntax inside note(); accepts note names, a MIDI number, a negative number, and a rest', () => {
  const failing = ['Cm7', 'Csus2', 'Dm7', "c4'min7"];
  const passing = ['c', 'cs4', 'df5', 'eb3', 'ef3', 'C4', '60', '-1', '~'];
  const failures = noteFailures([...failing, ...passing], 'test.md');
  for (const token of failing) {
    assert.ok(failures.some((f) => f.endsWith(`: ${token}`)), `expected ${token} to be flagged`);
  }
  for (const token of passing) {
    assert.ok(!failures.some((f) => f.endsWith(`: ${token}`)), `expected ${token} to be accepted`);
  }
});

test('check-reference: noteTokens reads only note() strings, never s()/sound() or a control like lpf()', () => {
  const fixture = ['```js', 'note("c e g").s("bd").lpf("400 800")', '```'].join('\n');
  const tokens = noteTokens(fixture);
  assert.deepEqual(tokens, ['c', 'e', 'g']);
});

test('check-reference: offline guard — no noteFailures entry over the committed reference (check:reference does the general note-token check against the live bundle)', () => {
  for (const topic of REFERENCE_TOPICS) {
    const text = readReferenceTopic(topic.id);
    const failures = noteFailures(noteTokens(text), topic.file);
    assert.deepEqual(failures, [], `${topic.file} has a note() token check:reference would flag`);
  }
});

test('check-reference: NOTE_NAME_RE matches the page\'s own note tokenizer pattern', () => {
  assert.equal(NOTE_NAME_RE.source, '^([a-gA-G])([#bsf]*)(-?[0-9]*)$');
});

// --- check-reference: miniGrammar / miniStrings / miniFailures ---

// A short excerpt of the pinned @strudel/mini@1.2.6 grammar (both project and grammar are AGPL),
// copied 2026-09-27 from https://unpkg.com/@strudel/mini@1.2.6/krill.pegjs: the ws, step_char and
// delimiter/operator rules miniGrammar reads, with the surrounding JS action code trimmed to the
// rule heads (the action bodies contribute no additional single-character literals to the scan).
const MINI_GRAMMAR_FIXTURE = String.raw`// ------------------ delimiters ---------------------------

ws "whitespace" = [ \n\r\t ]*
comma = ws "," ws
pipe = ws "|" ws
dot = ws "." ws
quote = '"' / "'"

step_char "a letter, a number, \"-\", \"#\", \".\", \"^\", \"_\"" =
  unicode_letter / [0-9~] / "-" / "#" / "." / "^" / "_"

sub_cycle = ws  "[" ws s ws "]" ws
polymeter = ws  "{" ws s ws "}" ws
polymeter_steps = "%"a
slow_sequence = ws "<" ws s ws ">" ws
op_weight = ws ("@" / "_") a
op_replicate = ws "!" a
op_bjorklund = "(" ws p ws comma ws s ws r ws ")"
op_slow = "/"a
op_fast = "*"a
op_degrade = "?"a
op_tail = ":" s
op_range = ".." s
sequence = _steps:'^'? s

// Mini-notation innards ends`;

test('check-reference: miniGrammar reads step characters, whitespace and structural characters from a short grammar excerpt', () => {
  const grammar = miniGrammar(MINI_GRAMMAR_FIXTURE);
  assert.ok(grammar);
  assert.ok(grammar.isStepChar('a') && grammar.isStepChar('Z') && grammar.isStepChar('5') && grammar.isStepChar('~'));
  assert.ok(
    grammar.isStepChar('-') &&
      grammar.isStepChar('#') &&
      grammar.isStepChar('.') &&
      grammar.isStepChar('^') &&
      grammar.isStepChar('_'),
  );
  assert.ok(!grammar.isStepChar('+') && !grammar.isStepChar("'"));
  assert.ok(grammar.whitespace.has(' ') && grammar.whitespace.has('\n') && grammar.whitespace.has('\t'));
  for (const ch of ['[', ']', '{', '}', '%', '<', '>', '@', '!', '(', ')', '/', '*', '?', ':']) {
    assert.ok(grammar.structural.has(ch), `expected structural to include ${ch}`);
  }
  assert.ok(!grammar.structural.has('"') && !grammar.structural.has("'"));
});

test('check-reference: miniGrammar returns null when the delimiters marker is removed (a pin change)', () => {
  const withoutMarker = MINI_GRAMMAR_FIXTURE.replace(
    '// ------------------ delimiters ---------------------------\n\n',
    '',
  );
  assert.equal(miniGrammar(withoutMarker), null);
});

test('check-reference: miniFailures flags an apostrophe, a plus outside a number exponent, and unbalanced brackets; accepts a wide range of valid mini-notation strings', () => {
  const grammar = miniGrammar(MINI_GRAMMAR_FIXTURE);
  const failing = ["c4'min7", 'C+', '[c e', '<c e]'];
  const passing = [
    '<C Am>',
    'bd(3,8,2)',
    '{c e g, a b}%4',
    'c _ e',
    'bd? sd',
    'bd:3',
    '<0 .25 .5 .75 1>',
    '[c,e,g]',
    'bd|sd|hh',
    'c!3 e',
    '1e+3',
    'C^7 C-7',
  ];
  const strings = [...failing, ...passing].map((text) => ({ text, block: '' }));
  const failures = miniFailures(strings, grammar, 'test.md');
  for (const token of failing) {
    assert.ok(failures.some((f) => f.includes(token)), `expected ${token} to be flagged`);
  }
  for (const token of passing) {
    assert.ok(!failures.some((f) => f.includes(token)), `expected ${token} to be accepted`);
  }
});

test("check-reference: miniFailures reports the offending character and its 1-based position in the message", () => {
  const grammar = miniGrammar(MINI_GRAMMAR_FIXTURE);
  const failures = miniFailures([{ text: "c4'min7", block: '' }], grammar, 'test.md');
  assert.equal(failures.length, 1);
  assert.match(failures[0], /holds ' \(character 3\)/);
});

test('check-reference: miniStrings finds double-quoted and backtick strings in a js block, skips a single-quoted string, a comment, an inline span and a ```tidal block', () => {
  const fixture = [
    '```js',
    'note("c e g")   // "not scanned, this is a comment"',
    '`bd sd hh`.s()',
    "sound === 'bd'",
    '```',
    '',
    '```tidal',
    'n "c\'maj"',
    '```',
    '',
    'Inline: `note("c")`',
  ].join('\n');
  const strings = miniStrings(fixture);
  const texts = strings.map((s) => s.text);
  assert.ok(texts.includes('c e g'));
  assert.ok(texts.includes('bd sd hh'));
  assert.ok(!texts.includes('bd'), 'a single-quoted string must be skipped');
  assert.ok(!texts.some((t) => t.includes('not scanned')), 'a comment must be stripped, not scanned');
  assert.ok(!texts.includes("c'maj"), 'a ```tidal block must not be scanned');
  assert.ok(!texts.includes('c'), 'an inline code span must not be scanned');
});

// --- check-reference: PROSE_CLAIMS / proseClaimFailures ---

// Fixture bundle facts, one segment per claim
// (a trimmed stand-in for the real minified text, in the same spirit as VOICING_ALIAS_FIXTURE
// above) — every value here is the TRUE fact the pinned bundle currently states.
const CLAIMS_BUNDLE_PARTS = {
  noteToMidi: 'noteToMidi=(o,e=3);noteToMidi$1=(o,e=3)',
  accs: 'accs$1={"#":1,b:-1,s:1,f:-1};accs$2={"#":1,b:-1,s:1,f:-1}',
  chordSymbolRe: CHORD_SYMBOL_RE.source,
  bareChord:
    'voicingAlias("^","",[simple,complex]);registerVoicings("ireal",simple);simple={"^":["1P 3M 5P","1P 3M 5P 8P"],"-":["1P 3m 5P"]}',
  voicingDefaults:
    'function renderVoicing({chord:o,dictionary:e,offset:l=0,n:d,mode:p="below",anchor:b="c5",octaves:R=1}){}defaultDict="ireal"',
  arrange:
    'function arrange(...o){const e=o.reduce((l,[d])=>l+d,0);return o=o.map(([l,d])=>[l,d.fast(l)]),stepcat(...o).slow(e)}',
  cyclist: 'class Cyclist{constructor({onSchedule}){this.started=!1,this.beforeStart=se,this.cps=.5,this.other=1}}',
  soloLabel:
    'Pattern.prototype.p=function(os){return typeof os=="string"&&(os.startsWith("_")||os.endsWith("_"))?silence:this};const cr=us.length>1&&us.startsWith("S")',
  delaytime:
    'delayfeedback:_n=getDefaultValue("delayfeedback"),delaysync:kn=getDefaultValue("delaysync"),delaytime:Dn,orbit:Ln=getDefaultValue("orbit")}=o;Dn=Dn??cycleToSeconds(kn,d)',
  // The transpiler's two string rules, reify's string parser that is never set, mini$1 and its export
  // (the true shapes of @strudel/repl@1.3.0; miniAllStrings is declared but never called).
  stringForms: [
    'function isStringWithDoubleQuotes(o,e,l){return o.type!=="Literal"?!1:o.raw[0]===\'"\'}',
    'function isBackTickString(o,e){return o.type==="TemplateLiteral"&&e.type!=="TaggedTemplateExpression"}',
    'if(isBackTickString(ln,dn)){if(isMiniDisabled(ln.start,z))return;const{quasis:pn}=ln,{raw:bn}=pn[0].value;return this.skip(),p&&le(bn,ln),this.replace(miniWithLocation(bn,ln))}',
    'if(isStringWithDoubleQuotes(ln)){if(isMiniDisabled(ln.start,z))return;const{value:pn}=ln;return this.skip(),p&&le(pn,ln),this.replace(miniWithLocation(pn,ln))}',
    'function reify(o){return isPattern(o)?o:stringParser&&typeof o=="string"?stringParser(o):pure(o)}',
    'setStringParser=o=>stringParser=o',
    'mini$1=(...o)=>{const e=o.map(l=>{const d=`"${l}"`,p=mini2ast(d);return patternifyAST(p,d)});return sequence(...e)}',
    'function miniAllStrings(){setStringParser(mini$1)}',
    'const index$a={StartRules:peg$allowedStartRules,mini:mini$1,mini2ast,miniAllStrings,minify}',
  ].join(';'),
  // .midi() refuses a Pattern port: the true shape of @strudel/repl@1.3.0.
  midiQuotes:
    'Pattern$1.prototype.midi=function(o,e={}){if(isPattern(o))throw new Error(`.midi does not accept Pattern input for midiport. Make sure to pass device name with single quotes. Example: .midi(\'${WebMidi.outputs?.[0]?.name||"IAC Driver Bus 1"}\')`);if(typeof o=="object"){}}',
  // The other MIDI facts: true excerpts of @strudel/repl@1.3.0, one part per piece of evidence.
  midiPortMatch: "function getDevice(o,e){if(!e.length)throw new Error(\"🔌 No MIDI devices found. Connect a device or enable IAC Driver.\");if(typeof o==\"number\")return e[o];const l=b=>e.find(R=>R.name.includes(b));if(typeof o==\"string\")return l(o);const d=l(\"IAC\"),p=d??e[0];if(!p)throw new Error(`🔌 MIDI device '${p||\"\"}' not found. Use one of ${getMidiDeviceNamesString(e)}`);return d??e[0]}",
  midiDefaults: "let l={isController:!1,noteOffsetMs:10,midichannel:1,velocity:.9,gain:1,midimap:\"default\",midiport:o,...e};",
  midiCcv: "function sendCC(o,e,l,d,p){if(typeof e!=\"number\"||e<0||e>1)throw new Error(\"expected ccv to be a number between 0 and 1\");if(![\"string\",\"number\"].includes(typeof o))throw new Error(\"expected ccn to be a number or a string\");const b=Math.round(e*127);scheduleAtTime(()=>{l.sendControlChange(o,b,d)},p)}",
  midiProgNum: "function sendProgramChange(o,e,l,d){if(typeof o!=\"number\"||o<0||o>127)throw new Error(\"expected progNum (program change) to be a number between 0 and 127\");scheduleAtTime(()=>{e.sendProgramChange(o,l)},d)}",
  midiSendNote: "function sendNote(o,e,l,d,p,b){if(o==null||o===\"\")throw new Error(\"note cannot be null or empty\");if(e!=null&&(typeof e!=\"number\"||e<0||e>1))throw new Error(\"velocity must be a number between 0 and 1\");if(l!=null&&(typeof l!=\"number\"||l<0))throw new Error(\"duration must be a positive number\");const R=typeof o==\"number\"?o:noteToMidi$1(o),I=new Note(R,{attack:e,duration:l});scheduleAtTime(()=>{d.playNote(I,p)},b)}",
  midiTriggerStart: "this.onTrigger((d,p,b,R)=>{if(!WebMidi.enabled){logger$2(\"Midi not enabled\");return}",
  // The per-hap destructure of .midi()'s trigger: no `sound` key among the keys it reads.
  midiHapValue:
    'logger$2("Midi not enabled");return}d.ensureObjectValue();let{note:I,nrpnn:z,nrpv:se,ccn:le,ccv:tn,midichan:sn=l.midichannel,midicmd:rn,midibend:ln,miditouch:dn,polyTouch:pn,gain:bn=l.gain,velocity:vn=l.velocity,progNum:Mn,sysexid:wn,sysexdata:_n,midimap:kn=l.midimap,midiport:Dn=l.midiport}=d.value;',
  midiVelocityGain: "gain:bn=l.gain,velocity:vn=l.velocity,progNum:Mn,sysexid:wn,sysexdata:_n,midimap:kn=l.midimap,midiport:Dn=l.midiport}=d.value;const Ln=getDevice(Dn,WebMidi.outputs);if(!Ln){logger$2(`[midi] midiport \"${Dn}\" not found! available: ${WebMidi.outputs.map(Xn=>`'${Xn.name}'`).join(\", \")}`);return}if(vn=bn*vn,",
  // The check that sends a note only for a defined note value that is not a controller (13.1).
  midiNoteGate: "I!==void 0&&!l.isController){",
  midiNoteLength: "const Xn=d.duration.valueOf()/b*1e3-l.noteOffsetMs;sendNote(I,vn,Xn,Ln,sn,R)}",
  midiCalls: "sendNote(I,vn,Xn,Ln,sn,R)}if(Mn!==void 0&&sendProgramChange(Mn,Ln,sn,R),",
  midiTriggerEnd: "sendSysex(Nn,Qn,Ln,R)}}})};async function _initialize(",
  midiOnTrigger: "onTrigger(e,l=!0){return this.withHap(d=>d.setContext({...d.context,onTrigger:(...p)=>{d.context.onTrigger?.(...p),e(...p)},dominantTrigger:d.context.dominantTrigger||l}))}",
  midiGetTrigger: "const getTrigger=({getTime:o,defaultOutput:e})=>async(l,d,p,b,R)=>{try{(!l.context.onTrigger||!l.context.dominantTrigger)&&await e(l,d,p,b,R),l.context.onTrigger&&await l.context.onTrigger(l,o(),b,R)}catch(I){errorLogger$1(I,\"getTrigger\")}}",
  midiClip: "{clip:clip$1,legato}=registerControl(\"clip\",\"legato\")",
  midiHapDuration: "get duration(){let e;return typeof this.value?.duration==\"number\"?e=fraction$1(this.value.duration):e=this.whole.end.sub(this.whole.begin),typeof this.value?.clip==\"number\"?e.mul(this.value.clip):e}",
  midiPlayNote: "playNote(e,l={}){this.sendNoteOn(e,l);const d=Array.isArray(e)?e:[e];for(let p of d)if(parseInt(p.duration)>0){const b={time:(Utilities.toTimestamp(l.time)||wm.time)+parseInt(p.duration),release:p.release,rawRelease:p.rawRelease};this.sendNoteOff(p,b)}",
  // The Cyclist shapes page/midi-clock.js reads: true excerpts of @strudel/repl@1.3.0, one part per piece of evidence.
  cyclistCtor:
    'this.started=!1,this.beforeStart=se,this.cps=.5,this.num_ticks_since_cps_change=0,this.lastTick=0,this.lastBegin=0,this.lastEnd=0,this.getTime=b,this.num_cycles_at_cps_change=0,this.seconds_at_cps_change,this.onToggle=d,this.latency=R',
  cyclistAnchor:
    'this.num_ticks_since_cps_change===0&&(this.num_cycles_at_cps_change=this.lastEnd,this.seconds_at_cps_change=le),this.num_ticks_since_cps_change++',
  cyclistHapTime: '(Mn.whole.begin-this.num_cycles_at_cps_change)/this.cps+this.seconds_at_cps_change+R',
  cyclistSetCps: 'setCps(e=.5){this.cps!==e&&(this.cps=e,this.num_ticks_since_cps_change=0)}',
  cyclistNow:
    'now(){if(!this.started)return 0;const e=this.getTime()-this.lastTick-this.clock.duration;return this.lastBegin+e*this.cps}',
  cyclistStop: 'stop(){logger$2("[cyclist] stop"),this.clock.stop(),this.lastEnd=0,this.setStarted(!1)}',
  editorCyclist: 'static get observedAttributes(){}sync=!1;solo=!0;getTime:()=>getAudioContext().currentTime',
  // The transport sends of .midi()'s trigger.
  midiTransport:
    'd.whole.begin+0===0&&scheduleAtTime(()=>{Ln.sendStart()},R),["clock","midiClock"].includes(rn))scheduleAtTime(()=>{Ln.sendClock()},R);else if(["start"].includes(rn))scheduleAtTime(()=>{Ln.sendStart()},R);else if(["stop"].includes(rn))scheduleAtTime(()=>{Ln.sendStop()},R);else if(["continue"].includes(rn))scheduleAtTime(()=>{Ln.sendContinue()},R)',
  // The seam of page/midi-out.js installNoteStamps (16): true excerpts of @strudel/repl@1.3.0.
  midiSeamCalls:
    'sendSysex(wn,_n,Ln,R),tn!==void 0&&le!==void 0&&sendCC(le,tn,Ln,sn,R),z!==void 0&&se!==void 0&&sendNRPN(z,se,Ln,sn,R),ln!==void 0&&sendPitchBend(ln,Ln,sn,R),dn!==void 0&&sendAftertouch(dn,Ln,sn,R)',
  midiSeamHelpers: "function sendSysex(o,e,l,d){if(Array.isArray(o)){if(!o.every(p=>Number.isInteger(p)&&p>=0&&p<=255))throw new Error(\"all sysexid bytes must be integers between 0 and 255\")}else if(!Number.isInteger(o)||o<0||o>255)throw new Error(\"A:sysexid must be an number between 0 and 255 or an array of such integers\");if(!Array.isArray(e))throw new Error(\"expected sysex to be an array of numbers (0-255)\");if(!e.every(p=>Number.isInteger(p)&&p>=0&&p<=255))throw new Error(\"all sysex bytes must be integers between 0 and 255\");scheduleAtTime(()=>{l.sendSysex(o,e)},d)}function sendNRPN(o,e,l,d,p){if(Array.isArray(o)){if(!o.every(b=>Number.isInteger(b)&&b>=0&&b<=255))throw new Error(\"all nrpnn bytes must be integers between 0 and 255\")}else if(!Number.isInteger(e)||e<0||e>255)throw new Error(\"A:sysexid must be an number between 0 and 255 or an array of such integers\");scheduleAtTime(()=>{l.sendNRPN(o,e,d)},p)}function sendPitchBend(o,e,l,d){if(typeof o!=\"number\"||o<-1||o>1)throw new Error(\"expected midibend to be a number between -1 and 1\");scheduleAtTime(()=>{e.sendPitchBend(o,l)},d)}function sendAftertouch(o,e,l,d){if(typeof o!=\"number\"||o<0||o>1)throw new Error(\"expected miditouch to be a number between 0 and 1\");scheduleAtTime(()=>{e.sendChannelAftertouch(o,l)},d)}",
  midiSeamCc: 'scheduleAtTime(()=>{l.sendControlChange(o,b,d)},p)',
  midiScheduleAtTime: 'function scheduleAtTime(o,e,l=getAudioContext()){const d=l.currentTime;webAudioTimeout(l,o,d,e)}',
  webmidiOutputSend: 'return this._midiOutput.send(e,Utilities.toTimestamp(l.time)),this}',
  // What the timed takeover gate of page/takeover.js relies on: true excerpts of @strudel/repl@1.3.0.
  gateSetPattern: 'setPattern(e,l=!1){this.pattern=e,l&&!this.started&&await this.start()}',
  gateQuery:
    'const pn=this.lastEnd;this.lastBegin=pn;const bn=this.num_cycles_at_cps_change+dn;if(this.lastEnd=bn,this.lastTick=le,le<rn){console.log("skip query: too late");return}this.pattern.queryArc(pn,bn,{_cps:this.cps,cyclist:"cyclist"}).forEach(Mn=>{',
  gateFraction:
    'Fraction.prototype.gt=function(o){return this.compare(o)>0},Fraction.prototype.lte=function(o){return this.compare(o)<=0},Fraction.prototype.gte=function(o){return this.compare(o)>=0}',
  gateState: 'class State{constructor(e,l={}){this.span=e,this.controls=l}setSpan(e){return new State(e,this.controls)}',
  // The mini-notation atom rule (no boolean conversion) and the truthy tests of keepif, struct, mask and when.
  miniAtom:
    'case"atom":{if(o.source_==="~"||o.source_==="-")return silence;if(!o.location_)return console.warn("no location for",o),o.source_;const b=isNaN(Number(o.source_))?o.source_:Number(o.source_);',
  truthyFlags:
    'keepif:[(l,d)=>d?l:void 0];Pattern$1.prototype.struct=function(...l){return this.keepif.out(...l)};Pattern$1.prototype.mask=function(...l){return this.keepif.in(...l)};when=register("when",function(o,e,l){return o?e(l):l})',
  // The control setter (set keeps its right-hand value), gain and postgain as separate controls, and the postgain's
  // default, per-event read and own gain node after the effects. Verbatim excerpts of the pinned bundle.
  gainReplaces:
    '{set:[(l,d)=>d],keep:[l=>l],keepif:[];p=function(b,R){return R?typeof b>"u"?R.fmap(d):R.set(reify(b).withValue(d)):reify(b).withValue(d)};{gain}=registerControl("gain"),{postgain}=registerControl("postgain"),{amp}=registerControl("amp");{s:"triangle",gain:.8,postgain:1,density:".03"};{postgain:sn=getDefaultValue("postgain")};const cr=new GainNode(R,{gain:sn});if(b.main.post=[cr],us.connect(cr),wn>0&&Dn>0&&_n>0){',
};
const CLAIMS_BUNDLE_FIXTURE = Object.values(CLAIMS_BUNDLE_PARTS).join(';');

// The checked Strings sentences (clauses a, b and c), in the exact wording reference/tidal-differences.md states.
const STRING_FORMS_SENTENCES = [
  'This applies to every such string in the code, including one inside a helper function that only builds or joins text and one in a function that never runs, so its text must be valid mini-notation on its own, or the whole evaluation fails with a `[mini] parse error`.',
  'A backtick string keeps only the text before its first `${`, and the rest is dropped without an error.',
  "A single-quoted string passed to a pattern function stays one value, not a sequence of events, even when built with `+` or `.join(' ')`, and `mini()` parses such a built string as mini-notation.",
];

// The checked midi.md sentences, in the exact wording reference/midi.md states them.
const MIDI_PORT_QUOTES_SENTENCES = [
  "Write the port name in single quotes: `.midi('port name')`.",
  'A double-quoted port name is a mini-notation pattern, and `.midi()` refuses it with the error `.midi does not accept Pattern input for midiport`.',
];

const MIDI_SENTENCES = {
  'midi-port-quotes': MIDI_PORT_QUOTES_SENTENCES,
  'midi-port-match': [
    "The port name is matched as part of an output name, case-sensitive, and the first output in the browser's list whose name contains it is used.",
    'With no port, the first output whose name contains `IAC` is used, else the first output.',
  ],
  'midi-channel': ["The channel is the `midichannel` option, 1 to 16, and it is 1 when none is given: `.midi('port name', { midichannel: 2 })`."],
  'midi-ccv-range': [
    '`ccn(n)` sets the controller number and `ccv(x)` its value, a number from 0 to 1, sent as `x * 127` rounded; a value outside 0 to 1 is an error.',
  ],
  'midi-prognum-range': ['`progNum(n)` sends a program change, 0 to 127.'],
  'midi-same-instant': [
    'A program change and a note at the same instant go out in no fixed order, so a program change inside a pattern can cut or change the note it shares an instant with; a sound chosen at an instant where the track plays no note cannot cut one, which is why sounds are chosen before notes.',
  ],
  'midi-gain-velocity': [
    '`velocity` is 0 to 1 and is 0.9 when none is given; on a MIDI track `.gain()` multiplies the velocity, so it changes how hard a note is played, not the volume of the instrument.',
    'A velocity that goes above 1 after the multiplication by `.gain()` is an error.',
  ],
  'midi-note-required': [
    "A note goes out only for an event that has a `note` value: `s(\"bd hh sd hh\").midi('port name')` and a bare `n(\"36 42\").midi('port name')` send no notes; `n()` works only once `.scale()` has turned it into notes (reference/theory.md).",
    "A drum track for a MIDI instrument therefore writes note numbers, such as the General MIDI drum notes 36, 38 and 42, on the instrument's drum channel (10 on a General MIDI instrument):",
  ],
  'midi-clock-cyclist': [
    'Moontide sends MIDI clock, Start and Stop itself to each instrument that follows the clock (get_midi_instruments says which ones), while the playing code names that instrument in a `.midi()` call.',
    'The clock counts 4 beats per cycle, 24 ticks per beat, so 96 ticks per cycle: a tempo of N beats per minute is `setcpm(N/4)`, and a tempo change in the code moves the clock with it.',
  ],
  'midi-transport': [
    'The code never writes clock or transport: a `midicmd` of `clock`, `midiClock`, `start`, `stop` or `continue` is dropped before it reaches a port, and so is the Start Strudel sends on every MIDI track at cycle 0.',
  ],
  'midi-note-length': ["A note lasts its event's length, times `legato` (or `clip`) when set, minus 10 ms."],
  'midi-note-off': [
    "Each note-on goes out with its note-off already timed for the note's end, so Strudel itself cannot end a note early.",
    "For the same reason `legato` above 1 on a repeated pitch is cut: the earlier note's note-off ends the next note of the same pitch.",
    "The Moontide page ends the notes of a track that is muted, silenced by a solo or removed: it sends a sustain release and All Notes Off on that track's channel when no other track plays there, and a note-off for each of the track's sounding notes when one does.",
  ],
  'midi-dominant': [
    'A track with `.midi()` plays nothing in the browser, so browser sounds and effects on it (`s`, `lpf`, `room`, `delay`) do nothing.',
  ],
  'midi-unknown-option-keys': [
    '`.midi()` ignores option keys it does not know: its options object is spread into its settings and each note reads only the keys Strudel defines, so a `sound` or `controls` key changes nothing in Strudel.',
    "The Moontide page reads `sound` when the user has described instruments in instruments.json: `.midi('port name', { midichannel: 3, sound: 'sound name' })` makes the page send that instrument's program change before the new code plays, and get_midi_instruments lists each instrument's sounds. With a change that waits for a bar or phrase line, the page sends the program change just before the line, timestamped at the line.",
    "The Moontide page also reads `controls` when the user has described instruments in instruments.json: `.midi('port name', { midichannel: 3, controls: { volume: 100 } })` sets one static level per control of that instrument, in the control's own range, and the page sends it before the new code plays. Control ids and ranges come from get_midi_instruments; a control that leaves the code goes back to the instrument's default; a sweep stays `ccn` and `ccv`. With a change that waits for a bar or phrase line, the page sends the controls just before the line, timestamped at the line.",
  ],
};

// Fixture reference texts stating the same true facts, in the exact checked wording.
// The checked gain sentence, in the exact wording reference/effects.md states.
const GAIN_REPLACES_SENTENCE =
  '- A later `.gain(n)` replaces every gain set earlier in the track (in its pattern strings, its `stack` branches and its echoes), so loud and quiet notes end up at one level. On a browser track with no post-gain of its own, `.postgain(n)` scales what the track plays after its effects and keeps that difference; a later `.postgain(n)` replaces an earlier one the same way, and a MIDI track ignores `postgain` (use `.gain(n)` or `.velocity(n)` there).';

const CLAIMS_TEXTS_TRUE = {
  'theory.md': [
    'the octave is 3 when none is written',
    'a sharp is `#` or `s`, a flat is `b` or `f`',
    'A chord root is an uppercase letter `A` to `G` with an optional `b` or `#`',
    'a bare letter with no suffix is a major triad',
    'The defaults are dictionary `ireal`, mode `below`, anchor `c5`',
  ].join('. '),
  'mini-notation.md': [
    'the octave is 3 when none is written',
    'a sharp is `#` or `s`, a flat is `b` or `f`',
  ].join('. '),
  'functions.md':
    'arrange repeats every total cycles. No function of this Strudel reads `t` or `f` as a boolean: in mini-notation `t`, `f`, `true` and `false` are plain strings (`f` is also a note name), so `struct`, `mask` and `when` treat each of them as true. The false values are `0` and `~` (a rest) for `struct` and `mask`. `when` needs `1`/`0`. A label longer than one character that starts with a capital `S` plays alone: while one exists, every other label is silent; a label that also starts or ends with `_` is silenced instead.',
  'transitions.md': [
    'one cycle lasts 2 seconds at the default 0.5 cycles per second',
    'arrange repeats every total cycles',
  ].join('. '),
  'src/mcp.ts':
    "  'A label longer than one character that starts with a capital S plays alone, unless it also ends with an underscore, which silences it instead: while a label that plays alone exists, every other label is silent.',",
  'tidal-differences.md': [
    'starts at 0.5 cycles per second. A label longer than one character that starts with a capital `S` plays alone: while one exists, every other label is silent, and a label that also starts or ends with `_` is silenced instead.',
    'Double-quoted strings and untagged backtick strings are mini-notation, parsed as patterns; single-quoted strings stay plain JavaScript strings and are never parsed as mini-notation.',
    STRING_FORMS_SENTENCES.join(' '),
  ].join(' '),
  'effects.md': [
    '- `delaytime(n)` — the delay time in seconds, up to 1; when absent, a time derived from the tempo is used.',
    GAIN_REPLACES_SENTENCE,
  ].join('\n'),
  'midi.md': Object.values(MIDI_SENTENCES).flat().join(' '),
};

test('check-reference: PROSE_CLAIMS has exactly twenty-nine entries with the expected ids', () => {
  assert.deepEqual(
    PROSE_CLAIMS.map((c) => c.id),
    [
      'default-octave',
      'accidentals',
      'chord-root',
      'bare-chord',
      'voicing-defaults',
      'arrange-repeats',
      'default-tempo',
      'solo-label',
      'delaytime-seconds',
      'string-forms',
      'midi-port-quotes',
      'midi-port-match',
      'midi-channel',
      'midi-ccv-range',
      'midi-prognum-range',
      'midi-same-instant',
      'midi-gain-velocity',
      'midi-note-length',
      'midi-note-off',
      'midi-dominant',
      'midi-unknown-option-keys',
      'midi-note-required',
      'midi-clock-cyclist',
      'midi-transport',
      'midi-trigger-seam',
      'takeover-gate',
      'mini-atoms-not-boolean',
      'truthy-flags',
      'gain-replaces',
    ],
  );
});

test('check-reference: proseClaimFailures flags tidal-differences.md when any checked string-forms sentence is missing', () => {
  const opening = 'Double-quoted strings and untagged backtick strings are mini-notation, parsed as patterns; single-quoted strings stay plain JavaScript strings and are never parsed as mini-notation.';
  const base = CLAIMS_TEXTS_TRUE['tidal-differences.md'];
  const missing = [opening, ...STRING_FORMS_SENTENCES];
  assert.equal(missing.length, 4);
  for (const sentence of missing) {
    assert.ok(base.includes(sentence), `fixture lacks: ${sentence}`);
    const texts = { ...CLAIMS_TEXTS_TRUE, 'tidal-differences.md': base.replace(sentence, '') };
    const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
    assert.ok(
      failures.includes('tidal-differences.md: no longer states string-forms in the checked form'),
      `${sentence} -> ${failures.join(' | ')}`,
    );
  }
});

test('check-reference: proseClaimFailures flags a bundle whose string rules drifted with "cannot find"', () => {
  const withStringForms = (replacement) =>
    Object.entries(CLAIMS_BUNDLE_PARTS)
      .map(([key, value]) => (key === 'stringForms' ? replacement(value) : value))
      .join(';');
  const cannotFind = (bundle) => {
    const failures = proseClaimFailures(bundle, CLAIMS_TEXTS_TRUE);
    return failures.some((f) => f.startsWith('string-forms: cannot find') && f.endsWith('in the bundle (the pin changed?)'));
  };
  // The backtick branch reads the whole template instead of its first quasi.
  assert.ok(cannotFind(withStringForms((v) => v.replace('const{quasis:pn}=ln,{raw:bn}=pn[0].value;', 'const bn=ln;'))));
  // A runtime string parser is switched on.
  assert.ok(cannotFind(withStringForms((v) => `${v};miniAllStrings()`)));
  // The double-quote rule is gone.
  assert.ok(cannotFind(withStringForms((v) => v.replace('o.raw[0]===\'"\'', 'o.raw[0]==="\'"'))));
  // The bundle with every string rule in place passes.
  assert.ok(!cannotFind(withStringForms((v) => v)));
});

test('check-reference: proseClaimFailures flags effects.md when it no longer says delaytime is in seconds', () => {
  const texts = { ...CLAIMS_TEXTS_TRUE, 'effects.md': '- `delaytime(n)` — how long the echo takes.' };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.includes('effects.md: no longer states delaytime-seconds in the checked form'), failures.join(' | '));
});

test('check-reference: proseClaimFailures flags the old "delay time in cycles" wording in any file', () => {
  const texts = { ...CLAIMS_TEXTS_TRUE, 'effects.md': `${CLAIMS_TEXTS_TRUE['effects.md']}\n- \`delaytime(n)\` — delay time in cycles, in seconds.` };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.some((f) => f.startsWith('effects.md: says delay time in cycles')), failures.join(' | '));
});

test('check-reference: proseClaimFailures flags a bundle without the delaytime default in seconds with "cannot find"', () => {
  const without = Object.entries(CLAIMS_BUNDLE_PARTS)
    .filter(([key]) => key !== 'delaytime')
    .map(([, value]) => value)
    .join(';');
  const failures = proseClaimFailures(without, CLAIMS_TEXTS_TRUE);
  assert.ok(failures.some((f) => f.startsWith('delaytime-seconds: cannot find') && f.endsWith('in the bundle (the pin changed?)')), failures.join(' | '));
  // A default that belongs to another parameter is not the delay time's.
  const other = without + ';delaysync:kn=1;Xn=Xn??cycleToSeconds(kn,d)';
  assert.ok(proseClaimFailures(other, CLAIMS_TEXTS_TRUE).some((f) => f.startsWith('delaytime-seconds: cannot find')));
});

test('check-reference: proseClaimFailures flags effects.md when it no longer states gain-replaces', () => {
  const base = CLAIMS_TEXTS_TRUE['effects.md'];
  assert.ok(base.includes(GAIN_REPLACES_SENTENCE));
  const texts = { ...CLAIMS_TEXTS_TRUE, 'effects.md': base.replace(GAIN_REPLACES_SENTENCE, '') };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.includes('effects.md: no longer states gain-replaces in the checked form'), failures.join(' | '));
  // Each half of the sentence is checked on its own.
  for (const half of [
    'A later `.gain(n)` replaces every gain set earlier in the track',
    'On a browser track with no post-gain of its own, `.postgain(n)` scales what the track plays after its effects and keeps that difference',
    'a later `.postgain(n)` replaces an earlier one the same way',
    'a MIDI track ignores `postgain`',
  ]) {
    const reworded = { ...CLAIMS_TEXTS_TRUE, 'effects.md': base.replace(half, 'something else') };
    assert.ok(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, reworded).includes('effects.md: no longer states gain-replaces in the checked form'), half);
  }
});

test('check-reference: proseClaimFailures flags a bundle without the gain facts with "cannot find"', () => {
  const without = Object.entries(CLAIMS_BUNDLE_PARTS)
    .filter(([key]) => key !== 'gainReplaces')
    .map(([, value]) => value)
    .join(';');
  const failures = proseClaimFailures(without, CLAIMS_TEXTS_TRUE);
  assert.ok(failures.some((f) => f.startsWith('gain-replaces: cannot find') && f.endsWith('in the bundle (the pin changed?)')), failures.join(' | '));
  // A bundle where set no longer keeps the right-hand value fails the claim too.
  const drifted = CLAIMS_BUNDLE_FIXTURE.replace('{set:[(l,d)=>d],', '{set:[(l,d)=>l],');
  assert.ok(proseClaimFailures(drifted, CLAIMS_TEXTS_TRUE).some((f) => f.startsWith('gain-replaces: cannot find')));
  // A bundle whose MIDI trigger starts reading postgain makes the sentence about MIDI false: the claim fails.
  const midiReadsPostgain = CLAIMS_BUNDLE_FIXTURE.replace('let{note:I,nrpnn:z,', 'let{note:I,postgain:Pn=1,nrpnn:z,');
  assert.notEqual(midiReadsPostgain, CLAIMS_BUNDLE_FIXTURE);
  assert.ok(proseClaimFailures(midiReadsPostgain, CLAIMS_TEXTS_TRUE).some((f) => f.startsWith('gain-replaces: cannot find the MIDI trigger reading its level')));
  // The true fixture passes as a whole.
  assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: proseClaimFailures flags a reference file that no longer states solo-label', () => {
  const withoutRule = {
    'functions.md': 'arrange repeats every total cycles.',
    'tidal-differences.md': 'starts at 0.5 cycles per second',
    'src/mcp.ts': 'export const SERVER_INSTRUCTIONS = [];',
  };
  for (const file of ['functions.md', 'tidal-differences.md', 'src/mcp.ts']) {
    const texts = { ...CLAIMS_TEXTS_TRUE, [file]: withoutRule[file] };
    const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
    assert.ok(failures.includes(`${file}: no longer states solo-label in the checked form`), `${file}: ${failures.join(' | ')}`);
  }
});

test('check-reference: proseClaimFailures flags a reference file that states the solo rule without the underscore exception on its line', () => {
  const noException = {
    'functions.md': 'arrange repeats every total cycles. A label longer than one character that starts with a capital `S` plays alone: while one exists, every other label is silent.',
    'tidal-differences.md': 'starts at 0.5 cycles per second. A label that starts with a capital `S` plays alone.',
  };
  const splitLine = {
    'functions.md': 'arrange repeats every total cycles. A label longer than one character that starts with a capital `S` plays alone.\nA label that also starts or ends with `_` is silenced instead.',
    'tidal-differences.md': 'starts at 0.5 cycles per second. A label that starts with a capital `S` plays alone.\na label that also starts or ends with `_` is silenced instead.',
  };
  for (const variant of [noException, splitLine]) {
    for (const file of Object.keys(variant)) {
      const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, { ...CLAIMS_TEXTS_TRUE, [file]: variant[file] });
      assert.ok(failures.includes(`${file}: no longer states solo-label in the checked form`), `${file}: ${failures.join(' | ')}`);
    }
  }
});

test('check-reference: proseClaimFailures flags src/mcp.ts holding the sentence without the underscore exception, even when a comment repeats it', () => {
  const oldSentence = "  'A label longer than one character that starts with a capital S plays alone: while such a label exists, every other label is silent.',";
  const commentOnly = `${oldSentence}\n  // A label longer than one character that starts with a capital S plays alone, unless it also ends with an underscore, which silences it instead`;
  for (const text of [oldSentence, commentOnly]) {
    const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, { ...CLAIMS_TEXTS_TRUE, 'src/mcp.ts': text });
    assert.ok(failures.includes('src/mcp.ts: no longer states solo-label in the checked form'), failures.join(' | '));
  }
});

test('check-reference: proseClaimFailures flags a bundle without the solo rule or the mute rule with "cannot find"', () => {
  const without = (text) => Object.entries(CLAIMS_BUNDLE_PARTS).map(([key, value]) => (key === 'soloLabel' ? text : value)).join(';');
  const noSolo = proseClaimFailures(without('(os.startsWith("_")||os.endsWith("_"))'), CLAIMS_TEXTS_TRUE);
  assert.ok(noSolo.some((f) => f.startsWith('solo-label: cannot find') && f.endsWith('in the bundle (the pin changed?)')), noSolo.join(' | '));
  const noMute = proseClaimFailures(without('const cr=us.length>1&&us.startsWith("S")'), CLAIMS_TEXTS_TRUE);
  assert.ok(noMute.some((f) => f.startsWith('solo-label: cannot find') && f.endsWith('in the bundle (the pin changed?)')), noMute.join(' | '));
});

test('check-reference: proseClaimFailures returns no failures when every bundle fact and reference sentence agree', () => {
  assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: proseClaimFailures flags theory.md saying octave 5 with "says 5 ... the page uses ... 3"', () => {
  const texts = { ...CLAIMS_TEXTS_TRUE, 'theory.md': CLAIMS_TEXTS_TRUE['theory.md'].replace('octave is 3', 'octave is 5') };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.some((f) => f.startsWith('theory.md: says') && f.includes('5') && f.includes('3')));
});

test('check-reference: proseClaimFailures flags a missing sentence with "no longer states"', () => {
  const texts = { ...CLAIMS_TEXTS_TRUE, 'mini-notation.md': 'nothing about octaves or accidentals here' };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.some((f) => f.startsWith('mini-notation.md: no longer states default-octave')));
  assert.ok(failures.some((f) => f.startsWith('mini-notation.md: no longer states accidentals')));
});

test('check-reference: proseClaimFailures flags the old single-pass "once through" wording in any file', () => {
  const texts = { ...CLAIMS_TEXTS_TRUE, 'functions.md': 'arrange plays each pattern once through.' };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.some((f) => f.startsWith('functions.md: says once through')));
});

test('check-reference: proseClaimFailures flags transitions.md saying one cycle lasts 1 second', () => {
  const texts = {
    ...CLAIMS_TEXTS_TRUE,
    'transitions.md': CLAIMS_TEXTS_TRUE['transitions.md'].replace('lasts 2 seconds', 'lasts 1 seconds'),
  };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
  assert.ok(failures.some((f) => f.startsWith('transitions.md: says')));
});

test('check-reference: proseClaimFailures flags a bundle without the .midi() Pattern-port refusal with "cannot find" (midi-port-quotes)', () => {
  const without = Object.entries(CLAIMS_BUNDLE_PARTS)
    .filter(([key]) => key !== 'midiQuotes')
    .map(([, value]) => value)
    .join(';');
  const failures = proseClaimFailures(without, CLAIMS_TEXTS_TRUE);
  assert.equal(failures.length, 1, failures.join(' | '));
  assert.ok(failures[0].startsWith('midi-port-quotes: cannot find'));
  assert.ok(failures[0].endsWith('in the bundle (the pin changed?)'));
});

test('check-reference: proseClaimFailures flags midi.md when any checked MIDI sentence is missing, naming only that claim', () => {
  const base = CLAIMS_TEXTS_TRUE['midi.md'];
  assert.equal(Object.keys(MIDI_SENTENCES).length, 14);
  for (const [id, sentences] of Object.entries(MIDI_SENTENCES)) {
    for (const sentence of sentences) {
      assert.ok(base.includes(sentence), `fixture lacks: ${sentence}`);
      const texts = { ...CLAIMS_TEXTS_TRUE, 'midi.md': base.replace(sentence, '') };
      const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
      assert.deepEqual(failures, [`midi.md: no longer states ${id} in the checked form`], sentence);
    }
  }
});

// What to take out of the true bundle so that exactly one MIDI claim loses its evidence: a whole
// part when the claim owns it, one key or call when the evidence is shared (the defaults object,
// sendNote).
const MIDI_DRIFT = {
  'midi-port-match': (p) => {
    const { midiPortMatch, ...rest } = p;
    return rest;
  },
  'midi-channel': (p) => ({ ...p, midiDefaults: p.midiDefaults.replace('midichannel:1', 'midichan:1') }),
  'midi-ccv-range': (p) => {
    const { midiCcv, ...rest } = p;
    return rest;
  },
  'midi-prognum-range': (p) => ({ ...p, midiProgNum: p.midiProgNum.replace('o>127', 'o>128') }),
  'midi-same-instant': (p) => ({ ...p, midiSendNote: p.midiSendNote.replace('scheduleAtTime(()=>{d.playNote(I,p)},b)', 'd.playNote(I,p)') }),
  'midi-gain-velocity': (p) => ({ ...p, midiVelocityGain: p.midiVelocityGain.replace('if(vn=bn*vn,', 'if(vn=vn,') }),
  'midi-note-length': (p) => {
    const { midiNoteLength, ...rest } = p;
    return rest;
  },
  'midi-note-off': (p) => ({ ...p, midiSendNote: p.midiSendNote.replace('duration:l', 'dur:l') }),
  'midi-dominant': (p) => {
    const { midiGetTrigger, ...rest } = p;
    return rest;
  },
  // midi-unknown-option-keys has no evidence of its own any more: its destructure is shared with
  // midi-note-required, see the test of the shared destructure below.
  'midi-note-required': (p) => {
    const { midiNoteGate, ...rest } = p;
    return rest;
  },
  'midi-clock-cyclist': (p) => {
    const { cyclistAnchor, ...rest } = p;
    return rest;
  },
  'midi-transport': (p) => {
    const { midiTransport, ...rest } = p;
    return rest;
  },
  'midi-trigger-seam': (p) => {
    const { midiSeamCalls, ...rest } = p;
    return rest;
  },
};

test('check-reference: each MIDI claim names itself with "cannot find" when its bundle evidence is gone, and no other claim does', () => {
  assert.equal(Object.keys(MIDI_DRIFT).length, 13);
  for (const [id, mutate] of Object.entries(MIDI_DRIFT)) {
    const bundle = Object.values(mutate({ ...CLAIMS_BUNDLE_PARTS })).join(';');
    const failures = proseClaimFailures(bundle, CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${id}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith(`${id}: cannot find`), failures[0]);
    assert.ok(failures[0].endsWith('in the bundle (the pin changed?)'), failures[0]);
  }
});

test('check-reference: proseClaimFailures flags each other piece of MIDI evidence the claims read, one claim at a time', () => {
  const cannotFind = (id, mutate) => {
    const failures = proseClaimFailures(Object.values(mutate({ ...CLAIMS_BUNDLE_PARTS })).join(';'), CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${id}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith(`${id}: cannot find`), failures[0]);
  };
  // The IAC default, the ccv scaling, the legato control, the clip multiplication, the note-off time,
  // the velocity error, the dominant trigger flag and the two callers.
  cannotFind('midi-port-match', (p) => ({ ...p, midiPortMatch: p.midiPortMatch.replace('l("IAC")', 'l("XYZ")') }));
  cannotFind('midi-ccv-range', (p) => ({ ...p, midiCcv: p.midiCcv.replace('Math.round(e*127)', 'Math.round(e*100)') }));
  cannotFind('midi-note-length', (p) => ({ ...p, midiClip: '{clip:clip$1}=registerControl("clip")' }));
  cannotFind('midi-note-length', (p) => ({ ...p, midiHapDuration: p.midiHapDuration.replace('e.mul(this.value.clip)', 'e') }));
  cannotFind('midi-note-off', (p) => ({ ...p, midiPlayNote: p.midiPlayNote.replace('+parseInt(p.duration)', '') }));
  cannotFind('midi-gain-velocity', (p) => ({ ...p, midiSendNote: p.midiSendNote.replace('velocity must be a number between 0 and 1', 'velocity is bad') }));
  cannotFind('midi-dominant', (p) => ({ ...p, midiOnTrigger: p.midiOnTrigger.replace('dominantTrigger:d.context.dominantTrigger||l', 'dominantTrigger:l') }));
  cannotFind('midi-dominant', (p) => ({ ...p, midiTriggerEnd: p.midiTriggerEnd.replace('}}})};', '}}},!1)};') }));
  cannotFind('midi-same-instant', (p) => ({ ...p, midiCalls: p.midiCalls.replace('sendProgramChange(Mn,Ln,sn,R)', 'sendProgramChange(Mn,Ln,sn,0)') }));
  cannotFind('midi-same-instant', (p) => ({ ...p, midiProgNum: p.midiProgNum.replace('scheduleAtTime(()=>{e.sendProgramChange(o,l)},d)', 'e.sendProgramChange(o,l)') }));
});

test('check-reference: a bundle without the destructure of the hap value in .midi()\'s trigger fails the three claims that read it, and only those', () => {
  const { midiHapValue, ...rest } = CLAIMS_BUNDLE_PARTS;
  const failures = proseClaimFailures(Object.values(rest).join(';'), CLAIMS_TEXTS_TRUE);
  assert.equal(failures.length, 3, failures.join(' | '));
  assert.ok(failures.some((f) => f.startsWith('midi-unknown-option-keys: cannot find')), failures.join(' | '));
  assert.ok(failures.some((f) => f.startsWith('midi-note-required: cannot find')), failures.join(' | '));
  assert.ok(failures.some((f) => f.startsWith('gain-replaces: cannot find')), failures.join(' | '));
});

test('check-reference: a sound key in the .midi() trigger destructure fails midi-unknown-option-keys, and only that claim', () => {
  const withSound = (replacement) =>
    Object.values({ ...CLAIMS_BUNDLE_PARTS, midiHapValue: CLAIMS_BUNDLE_PARTS.midiHapValue.replace('progNum:Mn,', replacement) }).join(';');
  const failures = proseClaimFailures(withSound('progNum:Mn,sound:Sn,'), CLAIMS_TEXTS_TRUE);
  assert.equal(failures.length, 1, failures.join(' | '));
  assert.ok(failures[0].startsWith('midi-unknown-option-keys: '), failures[0]);
  assert.ok(failures[0].includes('"sound"'), failures[0]);
  // A key with a default is still a key, and a key that only contains the word is not one.
  assert.equal(proseClaimFailures(withSound('progNum:Mn,sound:Sn=1,'), CLAIMS_TEXTS_TRUE).length, 1);
  assert.deepEqual(proseClaimFailures(withSound('progNum:Mn,soundfont:Sn,'), CLAIMS_TEXTS_TRUE), []);
  // The true fixture passes as a whole.
  assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: a controls key in the .midi() trigger destructure fails midi-unknown-option-keys, and only that claim', () => {
  const withKey = (replacement) =>
    Object.values({ ...CLAIMS_BUNDLE_PARTS, midiHapValue: CLAIMS_BUNDLE_PARTS.midiHapValue.replace('progNum:Mn,', replacement) }).join(';');
  const failures = proseClaimFailures(withKey('progNum:Mn,controls:Cn,'), CLAIMS_TEXTS_TRUE);
  assert.equal(failures.length, 1, failures.join(' | '));
  assert.ok(failures[0].startsWith('midi-unknown-option-keys: '), failures[0]);
  assert.ok(failures[0].includes('"controls"'), failures[0]);
  // A key that only contains the word is not one.
  assert.deepEqual(proseClaimFailures(withKey('progNum:Mn,controlsx:Cn,'), CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: an n or s key in the .midi() trigger destructure, or a note sent without the note check, fails midi-note-required, and only that claim', () => {
  const withKey = (replacement) =>
    Object.values({ ...CLAIMS_BUNDLE_PARTS, midiHapValue: CLAIMS_BUNDLE_PARTS.midiHapValue.replace('progNum:Mn,', replacement) }).join(';');
  for (const [key, text] of [['n', 'progNum:Mn,n:Nn,'], ['s', 'progNum:Mn,s:Sn,'], ['s', 'progNum:Mn,s:Sn=1,']]) {
    const failures = proseClaimFailures(withKey(text), CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, failures.join(' | '));
    assert.ok(failures[0].startsWith('midi-note-required: '), failures[0]);
    assert.ok(failures[0].includes(`"${key}"`), failures[0]);
  }
  // A key that only starts with the letter is not one.
  assert.deepEqual(proseClaimFailures(withKey('progNum:Mn,nrpn:Nn,'), CLAIMS_TEXTS_TRUE), []);
  // A note sent without the check on a defined note value, or on a controller, is a drift too.
  for (const gate of ['I!==void 0){', 'I!==void 0&&!l.isController', 'J!==void 0&&!l.isController){']) {
    const bundle = Object.values({ ...CLAIMS_BUNDLE_PARTS, midiNoteGate: gate }).join(';');
    const failures = proseClaimFailures(bundle, CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${gate}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('midi-note-required: cannot find'), failures[0]);
  }
  // The true fixture passes as a whole.
  assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: a Cyclist without the tempo anchor the page clock reads fails midi-clock-cyclist, and only that claim', () => {
  const mutations = {
    'the anchor rule': (p) => ({ ...p, cyclistAnchor: p.cyclistAnchor.replace('this.seconds_at_cps_change=le', 'this.seconds_at_cps_change=le+1') }),
    'the constructor fields': (p) => ({ ...p, cyclistCtor: p.cyclistCtor.replace('this.lastBegin=0,', '') }),
    'the hap time': (p) => ({ ...p, cyclistHapTime: p.cyclistHapTime.replace('/this.cps', '*this.cps') }),
    'setCps': (p) => ({ ...p, cyclistSetCps: p.cyclistSetCps.replace('this.num_ticks_since_cps_change=0', 'this.other=0') }),
    'now': (p) => ({ ...p, cyclistNow: p.cyclistNow.replace('this.lastBegin+', '') }),
    'stop': (p) => ({ ...p, cyclistStop: p.cyclistStop.replace('this.lastEnd=0,', '') }),
    'the plain Cyclist default of the editor': (p) => ({ ...p, editorCyclist: p.editorCyclist.replace('sync=!1', 'sync=!0') }),
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const failures = proseClaimFailures(Object.values(mutate({ ...CLAIMS_BUNDLE_PARTS })).join(';'), CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${what}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('midi-clock-cyclist: cannot find'), failures[0]);
  }
  // The true fixture passes as a whole.
  assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: a .midi() trigger whose transport sends changed fails midi-transport, and only that claim', () => {
  const changes = [
    ['sendStop', 'sendHalt'],
    ['["continue"]', '["resume"]'],
    ['["clock","midiClock"]', '["clock"]'],
    ['d.whole.begin+0===0&&', ''],
  ];
  for (const [from, to] of changes) {
    const bundle = Object.values({ ...CLAIMS_BUNDLE_PARTS, midiTransport: CLAIMS_BUNDLE_PARTS.midiTransport.replace(from, to) }).join(';');
    const failures = proseClaimFailures(bundle, CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${from}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('midi-transport: cannot find'), failures[0]);
  }
});

test('check-reference: a .midi() trigger whose seam changed fails midi-trigger-seam, and only that claim', () => {
  // [the part holding the change, what to change, its replacement]. midiCcv carries the same CC scheduling text as
  // midiSeamCc, so a changed CC send is applied to both parts (no other claim reads that call).
  const changes = [
    ['midiSeamCalls', 'sendPitchBend(ln,Ln,sn,R)', 'sendPitchBend(ln,Ln,sn,0)'],
    ['midiSeamHelpers', 'scheduleAtTime(()=>{l.sendSysex(o,e)},d)', 'l.sendSysex(o,e)'],
    ['midiSeamCc', 'sendControlChange', 'sendCC'],
    ['midiScheduleAtTime', 'webAudioTimeout(l,o,d,e)', 'webAudioTimeout(l,o,d,d)'],
    ['webmidiOutputSend', 'Utilities.toTimestamp(l.time)', '0'],
  ];
  for (const [part, from, to] of changes) {
    assert.ok(CLAIMS_BUNDLE_PARTS[part].includes(from), `${part}: the true excerpt has no "${from}"`);
    const parts = { ...CLAIMS_BUNDLE_PARTS, [part]: CLAIMS_BUNDLE_PARTS[part].replace(from, to) };
    if (part === 'midiSeamCc') parts.midiCcv = parts.midiCcv.replace(from, to);
    const failures = proseClaimFailures(Object.values(parts).join(';'), CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${part}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('midi-trigger-seam: cannot find'), failures[0]);
  }
});

test('check-reference: a Cyclist whose gate facts changed fails takeover-gate, and only that claim', () => {
  // [the part holding the change, what to change, its replacement].
  const changes = [
    ['gateSetPattern', 'this.pattern=e', 'this.patterns=e'],
    ['gateQuery', 'this.lastEnd=bn,this.lastTick=le,le<rn', 'this.lastTick=le,le<rn'],
    ['gateQuery', 'cyclist:"cyclist"', 'cyclist:"other"'],
    ['gateFraction', 'prototype.lte=function(o){return this.compare(o)<=0}', 'prototype.lte=function(o){return this.compare(o)<0}'],
    ['gateFraction', 'prototype.gte=function(o){return this.compare(o)>=0}', 'prototype.gtee=function(o){return this.compare(o)>=0}'],
    ['gateFraction', 'prototype.gt=function(o){return this.compare(o)>0}', 'prototype.gt=function(o){return this.compare(o)>1}'],
    ['gateState', 'setSpan(e){return new State(e,this.controls)}', 'setSpan(e){return new State(e)}'],
  ];
  for (const [part, from, to] of changes) {
    assert.ok(CLAIMS_BUNDLE_PARTS[part].includes(from), `${part}: the true excerpt has no "${from}"`);
    const parts = { ...CLAIMS_BUNDLE_PARTS, [part]: CLAIMS_BUNDLE_PARTS[part].replace(from, to) };
    const failures = proseClaimFailures(Object.values(parts).join(';'), CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${part} ${from}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('takeover-gate: cannot find'), failures[0]);
    assert.ok(failures[0].endsWith('in the bundle (the pin changed?)'), failures[0]);
  }
  // A bundle without any of the parts fails the same claim, and the true fixture passes as a whole.
  for (const part of ['gateSetPattern', 'gateQuery', 'gateFraction', 'gateState']) {
    const { [part]: _removed, ...rest } = CLAIMS_BUNDLE_PARTS;
    const failures = proseClaimFailures(Object.values(rest).join(';'), CLAIMS_TEXTS_TRUE);
    assert.equal(failures.length, 1, `${part}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('takeover-gate: cannot find'), failures[0]);
  }
  assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, CLAIMS_TEXTS_TRUE), []);
});

test('check-reference: proseClaimFailures flags a bundle without the mini-notation atom rule with "cannot find" (mini-atoms-not-boolean)', () => {
  const without = Object.entries(CLAIMS_BUNDLE_PARTS)
    .filter(([key]) => key !== 'miniAtom')
    .map(([, value]) => value)
    .join(';');
  const failures = proseClaimFailures(without, CLAIMS_TEXTS_TRUE);
  assert.equal(failures.length, 1, failures.join(' | '));
  assert.ok(failures[0].startsWith('mini-atoms-not-boolean: cannot find'), failures[0]);
  assert.ok(failures[0].endsWith('in the bundle (the pin changed?)'), failures[0]);
  // An atom rule that converts t and f to booleans is a changed rule.
  const converting = Object.values({ ...CLAIMS_BUNDLE_PARTS, miniAtom: CLAIMS_BUNDLE_PARTS.miniAtom.replace('const b=isNaN', 'const b=o.source_==="t"||isNaN') }).join(';');
  assert.ok(proseClaimFailures(converting, CLAIMS_TEXTS_TRUE).some((f) => f.startsWith('mini-atoms-not-boolean: cannot find')));
});

test('check-reference: proseClaimFailures flags a bundle whose truthy tests changed with "cannot find" (truthy-flags)', () => {
  const changes = [
    ['keepif:[(l,d)=>d?l:void 0]', 'keepif:[(l,d)=>d===!0?l:void 0]'],
    ['this.keepif.out(', 'this.keepif.in('],
    ['this.keepif.in(', 'this.keepif.out('],
    ['return o?e(l):l', 'return o===!0?e(l):l'],
  ];
  for (const [from, to] of changes) {
    const bundle = Object.values({ ...CLAIMS_BUNDLE_PARTS, truthyFlags: CLAIMS_BUNDLE_PARTS.truthyFlags.replace(from, to) }).join(';');
    const failures = proseClaimFailures(bundle, CLAIMS_TEXTS_TRUE);
    assert.ok(failures.length >= 1, from);
    assert.ok(failures.every((f) => f.startsWith('truthy-flags: cannot find') && f.endsWith('in the bundle (the pin changed?)')), `${from}: ${failures.join(' | ')}`);
  }
});

test('check-reference: functions.md without a t/f fact sentence fails its claim in the checked-form wording', () => {
  const base = CLAIMS_TEXTS_TRUE['functions.md'];
  const cases = [
    ['in mini-notation `t`, `f`, `true` and `false` are plain strings', 'in mini-notation `t` and `f` are booleans', 'mini-atoms-not-boolean'],
    ['so `struct`, `mask` and `when` treat each of them as true', 'so `struct` plays the t steps', 'mini-atoms-not-boolean'],
    ['The false values are `0` and `~`', 'The false value is `f`', 'truthy-flags'],
    ['`when` needs `1`/`0`', '`when` takes booleans', 'truthy-flags'],
  ];
  for (const [from, to, id] of cases) {
    assert.ok(base.includes(from), `fixture lacks: ${from}`);
    const texts = { ...CLAIMS_TEXTS_TRUE, 'functions.md': base.replace(from, to) };
    const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
    assert.deepEqual(failures, [`functions.md: no longer states ${id} in the checked form`], from);
  }
});

test('check-reference: a reference example giving struct, mask or when a t/f string fails truthy-flags', () => {
  const bad = ['s("bd").struct("t f t t")', "s('bd*4').mask('t f t t')", 'x.when("<f f t>", g)', 'x.when(`t f`, g)', 'x.struct ( "~ t" )', 'x.mask("<t f>?")'];
  for (const example of bad) {
    const texts = { ...CLAIMS_TEXTS_TRUE, 'functions.md': `${CLAIMS_TEXTS_TRUE['functions.md']}\n${example}` };
    const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts);
    assert.equal(failures.length, 1, `${example}: ${failures.join(' | ')}`);
    assert.ok(failures[0].startsWith('functions.md: says '), failures[0]);
    assert.ok(failures[0].endsWith('t and f are truthy strings, write 1 and 0'), failures[0]);
  }
  // Another reference file counts too.
  const other = { ...CLAIMS_TEXTS_TRUE, 'transitions.md': `${CLAIMS_TEXTS_TRUE['transitions.md']}\ns("bd").struct("t f")` };
  assert.ok(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, other).some((f) => f.startsWith('transitions.md: says ')));
  // Strings with a digit, a rest-only string, a JS signal and a name argument are fine.
  for (const ok of ['s("bd").struct("1 0 1 1")', 's("bd").struct("t1 f")', 's("bd").mask("x ~ x")', 's("bd").when("~ ~", g)', 's("bd").mask(signal((t) => t >= 4))', 'x.when(cond, f)']) {
    const texts = { ...CLAIMS_TEXTS_TRUE, 'functions.md': `${CLAIMS_TEXTS_TRUE['functions.md']}\n${ok}` };
    assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, texts), [], ok);
  }
});

test('check-reference: the reference no longer saying that Strudel itself cannot end a note early, or what the page ends, fails midi-note-off', () => {
  const stale = { ...CLAIMS_TEXTS_TRUE, 'midi.md': CLAIMS_TEXTS_TRUE['midi.md'].replace('so Strudel itself cannot end a note early', 'so removing a track lets its long notes finish') };
  const failures = proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, stale);
  assert.equal(failures.length, 1, failures.join(' | '));
  assert.ok(failures[0].startsWith('midi.md: no longer states midi-note-off'), failures[0]);
  const noPageSentence = { ...CLAIMS_TEXTS_TRUE, 'midi.md': CLAIMS_TEXTS_TRUE['midi.md'].replace('The Moontide page ends the notes of a track', 'The page ends the notes of a track') };
  assert.equal(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, noPageSentence).length, 1);
});

test('check-reference: a MIDI default that changed in the bundle names the file, what it says and what the page uses', () => {
  const withDefaults = (from, to) => Object.values({ ...CLAIMS_BUNDLE_PARTS, midiDefaults: CLAIMS_BUNDLE_PARTS.midiDefaults.replace(from, to) }).join(';');
  assert.deepEqual(proseClaimFailures(withDefaults('midichannel:1', 'midichannel:2'), CLAIMS_TEXTS_TRUE), ['midi.md: says 1, the page uses 2']);
  assert.deepEqual(proseClaimFailures(withDefaults('velocity:.9', 'velocity:.8'), CLAIMS_TEXTS_TRUE), ['midi.md: says 0.9, the page uses 0.8']);
  assert.deepEqual(proseClaimFailures(withDefaults('noteOffsetMs:10', 'noteOffsetMs:20'), CLAIMS_TEXTS_TRUE), ['midi.md: says 10 ms, the page uses 20 ms']);
});

test('check-reference: proseClaimFailures flags a bundle without the Cyclist cps pattern with "cannot find"', () => {
  const withoutCyclist = Object.entries(CLAIMS_BUNDLE_PARTS)
    .filter(([key]) => key !== 'cyclist')
    .map(([, value]) => value)
    .join(';');
  const failures = proseClaimFailures(withoutCyclist, CLAIMS_TEXTS_TRUE);
  assert.ok(failures.some((f) => f.startsWith('default-tempo: cannot find')));
});

test(
  "check-reference: offline guard — every PROSE_CLAIMS reference-side pattern matches the committed reference files' and the server instruction source's true sentences (a rewording is caught by npm test too)",
  () => {
    const referenceTextsByFile = {};
    for (const topic of REFERENCE_TOPICS) {
      referenceTextsByFile[topic.file] = readReferenceTopic(topic.id);
    }
    referenceTextsByFile['src/mcp.ts'] = fs.readFileSync(path.join(repoRoot, 'src', 'mcp.ts'), 'utf8');
    assert.deepEqual(proseClaimFailures(CLAIMS_BUNDLE_FIXTURE, referenceTextsByFile), []);
  },
);

// --- check-reference: sound-file header check ---

test('check-reference: SOUND_FILE_MANIFESTS lists the six sample manifests prebake loads', () => {
  assert.deepEqual(SOUND_FILE_MANIFESTS, [
    'strudel.json',
    'tidal-drum-machines.json',
    'piano.json',
    'Dirt-Samples.json',
    'vcsl.json',
    'mridangam.json',
  ]);
});

test('check-reference: browserRefusal accepts 200/301 and quoted-comma filenames, flags 404/429 and an unquoted comma in Content-Disposition', () => {
  assert.equal(browserRefusal(200, null), null);
  assert.equal(browserRefusal(200, 'attachment; filename="a, b.wav"'), null);
  assert.equal(browserRefusal(301, null), null);
  assert.match(browserRefusal(200, 'attachment; filename=Idiophones/Kalimba, Kenya/x.wav'), /unquoted comma/);
  assert.match(browserRefusal(404, null), /404/);
  const rateLimited = browserRefusal(429, null);
  assert.match(rateLimited, /rate limited/);
  assert.match(rateLimited, /re-run/);
});

test('check-reference: browserRefusal never matches a percent-encoded filename* parameter', () => {
  assert.equal(browserRefusal(200, "attachment; filename*=UTF-8''Kalimba%2C%20Kenya.wav"), null);
});

test('check-reference: soundFileTargets resolves an array entry, a note-keyed object entry, an entry-level _base override, the vcslBase option for vcsl.json, a no-file entry, and marks an excluded name without dropping it', () => {
  const manifests = {
    'strudel.json': { _base: 'https://kit.example/', bd: ['bd1.wav', 'bd2.wav'] },
    'tidal-drum-machines.json': { _base: 'https://machines.example/' },
    'piano.json': { _base: 'https://piano.example/', piano: { A4: ['a4.wav'], A5: 'a5.wav' } },
    'Dirt-Samples.json': { _base: 'https://dirt.example/', casio: { _base: 'https://own.example/', A: 'x.wav' } },
    'vcsl.json': { _base: 'https://vcsl-manifest.example/', harp: ['harp1.wav'], tom_mallet: [], empty_entry: {} },
    'mridangam.json': { _base: 'https://mrid.example/' },
  };
  const exclusions = new Map([['vcsl', new Map([['tom_mallet', 'test reason']])]]);
  const targets = soundFileTargets(manifests, { vcslBase: 'https://cdn.example/vcsl/', exclusions });
  const byKey = new Map(targets.map((t) => [`${t.set}/${t.name}`, t]));

  // Array entry: base + first element.
  assert.equal(byKey.get('strudel/bd').url, 'https://kit.example/bd1.wav');

  // Note-keyed object entry: first key not starting with '_' (insertion order), string or array value.
  assert.equal(byKey.get('piano/piano').url, 'https://piano.example/a4.wav');

  // Entry-level _base wins over the manifest's own _base.
  assert.equal(byKey.get('Dirt-Samples/casio').url, 'https://own.example/x.wav');

  // vcsl.json uses vcslBase, never the manifest's own _base.
  assert.equal(byKey.get('vcsl/harp').url, 'https://cdn.example/vcsl/harp1.wav');

  // An empty array or an object with no file gives url: null, problem: 'no file listed'.
  assert.deepEqual(byKey.get('vcsl/tom_mallet').url, null);
  assert.equal(byKey.get('vcsl/tom_mallet').problem, 'no file listed');
  assert.deepEqual(byKey.get('vcsl/empty_entry').url, null);
  assert.equal(byKey.get('vcsl/empty_entry').problem, 'no file listed');

  // Excluded names are returned, marked, never dropped.
  assert.equal(byKey.get('vcsl/tom_mallet').excluded, true);
  assert.ok(!byKey.get('vcsl/harp').excluded);
});

test('check-reference: gmSoundfontTargets reads the gm table in order, and throws naming what is missing when the host or the table is absent', () => {
  const bundleText = 'defaultSoundfontUrl="https://h.example/sound";gm={gm_piano:["0000_A","0000_B"],gm_pad:["0880_X"]};';
  assert.deepEqual(gmSoundfontTargets(bundleText), [
    { set: 'gm', name: 'gm_piano', url: 'https://h.example/sound/0000_A.js' },
    { set: 'gm', name: 'gm_pad', url: 'https://h.example/sound/0880_X.js' },
  ]);

  assert.throws(() => gmSoundfontTargets('gm={gm_piano:["0000_A"]};'), /defaultSoundfontUrl/);
  assert.throws(() => gmSoundfontTargets('defaultSoundfontUrl="https://h.example/sound";'), /gm table|gm=/);
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const response = responses[url];
    if (response instanceof Error) throw response;
    return { status: response.status, headers: { get: () => response.contentDisposition ?? null } };
  };
  impl.calls = calls;
  return impl;
}

test('check-reference: checkSoundFiles makes one request per distinct URL, reports how many names were checked, and flags a shared-URL 404 once per name', async () => {
  const targets = [
    { set: 'vcsl', name: 'kalimba', url: 'https://cdn.example/shared.wav' },
    { set: 'vcsl', name: 'kalimba2', url: 'https://cdn.example/shared.wav' },
  ];
  const fetchImpl = fakeFetch({ 'https://cdn.example/shared.wav': { status: 404 } });
  const result = await checkSoundFiles(targets, { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.checked, 2);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.some((f) => f.includes('vcsl/kalimba:') && f.includes('404')));
  assert.ok(result.failures.some((f) => f.includes('vcsl/kalimba2:') && f.includes('404')));
});

test('check-reference: checkSoundFiles reports a rejected request as "could not reach"', async () => {
  const targets = [{ set: 'vcsl', name: 'harp', url: 'https://cdn.example/harp.wav' }];
  const fetchImpl = fakeFetch({ 'https://cdn.example/harp.wav': new Error('network down') });
  const result = await checkSoundFiles(targets, { fetchImpl });
  assert.ok(result.failures.some((f) => f.includes('could not reach') && f.includes('network down')));
});

test('check-reference: checkSoundFiles sorts failure lines by set then name, whatever order the fake fetch answers in', async () => {
  const targets = [
    { set: 'vcsl', name: 'zebra', url: 'https://cdn.example/zebra.wav' },
    { set: 'piano', name: 'piano', url: 'https://cdn.example/piano.wav' },
    { set: 'vcsl', name: 'anvil', url: 'https://cdn.example/anvil.wav' },
  ];
  const fetchImpl = fakeFetch({
    'https://cdn.example/zebra.wav': { status: 404 },
    'https://cdn.example/piano.wav': { status: 500 },
    'https://cdn.example/anvil.wav': { status: 404 },
  });
  const result = await checkSoundFiles(targets, { fetchImpl });
  const order = result.failures.map((f) => f.match(/sounds: ([^:]+):/)[1]);
  assert.deepEqual(order, ['piano/piano', 'vcsl/anvil', 'vcsl/zebra']);
});

test('check-reference: checkSoundFiles gives a note (not a failure) for an excluded target that now loads without refusal, and includes every "no file listed" target among the failures', async () => {
  const targets = [
    { set: 'vcsl', name: 'tom_mallet', url: 'https://cdn.example/tom.wav', excluded: true },
    { set: 'vcsl', name: 'ghost', url: null, problem: 'no file listed' },
  ];
  const fetchImpl = fakeFetch({ 'https://cdn.example/tom.wav': { status: 200 } });
  const result = await checkSoundFiles(targets, { fetchImpl });
  assert.deepEqual(result.notes, ['excluded sound vcsl/tom_mallet now loads; consider listing it again']);
  assert.ok(!result.failures.some((f) => f.includes('tom_mallet')));
  assert.ok(result.failures.some((f) => f.includes('vcsl/ghost: no file listed')));
  assert.equal(result.checked, 2);
});

// Extracted 2026-09-27 from the pinned @strudel/repl@1.3.0 bundle and its default sample
// manifests (see reference/sounds.md "Where these names come from"); check:reference re-verifies
// these against the live sources on every run, so a future drift fails there, not silently here.
const EXTRACTED_GM_COUNT = 125;
const EXTRACTED_MACHINE_COUNT = 71;
const EXTRACTED_DRUM_TYPES = ['bd', 'cb', 'cp', 'cr', 'fx', 'hh', 'ht', 'lt', 'misc', 'mt', 'oh', 'perc', 'rd', 'rim', 'sd', 'sh', 'tb'];
const EXTRACTED_ZZFX_NAMES = ['zzfx', 'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'z_noise'];

test('reference/sounds.md pins: gm_ token count, machine-line count and drum types, zzfx names, basic waveforms/noises, piano and the flute soundfonts', () => {
  const text = readReferenceTopic('sounds');
  const rows = namesBlockTokens(text);

  const plainTokens = new Set();
  for (const row of rows) {
    if (row.label === null) for (const token of row.tokens) plainTokens.add(token);
  }

  const gmTokens = [...plainTokens].filter((token) => token.startsWith('gm_'));
  assert.equal(gmTokens.length, EXTRACTED_GM_COUNT);

  const machineRows = rows.filter((row) => row.label !== null);
  assert.equal(machineRows.length, EXTRACTED_MACHINE_COUNT);
  const machineTypes = new Set();
  for (const row of machineRows) for (const token of row.tokens) machineTypes.add(token);
  assert.deepEqual([...machineTypes].sort(), [...EXTRACTED_DRUM_TYPES].sort());

  for (const name of [...EXTRACTED_ZZFX_NAMES, 'sine', 'square', 'triangle', 'sawtooth', 'white', 'pink', 'brown', 'piano', 'gm_flute', 'gm_pan_flute']) {
    assert.ok(plainTokens.has(name), `expected "${name}" to appear in a names block of sounds.md`);
  }
});

// --- tint-rules.js helper cases ---

test('tint-rules: findWords matches whole words case-insensitively, and multi-word entries across whitespace', () => {
  assert.deepEqual(findWords('A dreamy pad', TINT_WORDS), ['dreamy']);
  assert.deepEqual(findWords('dreamyness', TINT_WORDS), []);
  assert.deepEqual(findWords('a VIDEO   game vibe', TINT_WORDS), ['video game']);
});

test('tint-rules: stripNamesBlocks removes only ```names blocks; fencedBlocks returns bodies for one tag', () => {
  const markdown = [
    '```names',
    'sad chord voicing',
    '```',
    '',
    '```js',
    's("bd")',
    '```',
    '',
    '```tidal',
    'whenmod',
    '```',
  ].join('\n');
  assert.ok(!stripNamesBlocks(markdown).includes('sad chord voicing'));
  assert.ok(stripNamesBlocks(markdown).includes('s("bd")'));
  assert.deepEqual(fencedBlocks(markdown, 'js'), ['s("bd")']);
});

test('tint-rules: fenceTags lists every fence tag in document order, "" for an untagged fence', () => {
  const markdown = ['```js', 'a', '```', '', '```', 'b', '```', '', '```tidal', 'c', '```'].join('\n');
  assert.deepEqual(fenceTags(markdown), ['js', '', 'tidal']);
});

test('tint-rules: demoSoundTokens tokenizes string arguments of s/sound/.s/.sound, splitting on mini-notation symbols and dropping numbers', () => {
  const jsBlock = 's("bd*2 sd").sound("hh:3").note("c e g")';
  assert.deepEqual(demoSoundTokens(jsBlock), ['bd', 'sd', 'hh']);
});

test('content rule (fixture): a demo naming a GM instrument or a drum bank is flagged; basic waveforms and drum abbreviations are accepted', () => {
  function violatesInstrumentRule(jsBlock) {
    if (jsBlock.includes('gm_') || jsBlock.includes('.bank(')) return true;
    return demoSoundTokens(jsBlock).some((token) => !ALLOWED_DEMO_SOUNDS.includes(token));
  }
  assert.equal(violatesInstrumentRule('s("gm_piano")'), true);
  assert.equal(violatesInstrumentRule('s("bd").bank("RolandTR909")'), true);
  assert.equal(violatesInstrumentRule('s("sine sawtooth")'), false);
  assert.equal(violatesInstrumentRule('s("bd*2 sd")'), false);
});

// --- Content rules over every REFERENCE_TOPICS file ---

test('content rules: every reference topic file uses only js/tidal/names fences, compiles its js demos, and carries no taste, instrument or examples folder reference', () => {
  for (const topic of REFERENCE_TOPICS) {
    const text = readReferenceTopic(topic.id);

    for (const tag of fenceTags(text)) {
      assert.ok(['js', 'tidal', 'names'].includes(tag), `${topic.file}: fence tag "${tag}" must be js, tidal or names`);
    }

    for (const jsBlock of fencedBlocks(text, 'js')) {
      assert.doesNotThrow(
        () => new vm.Script(`(async () => {\n${jsBlock}\n})`),
        `${topic.file}: js block failed to compile:\n${jsBlock}`,
      );
      assert.ok(!jsBlock.includes('gm_'), `${topic.file}: js block names a GM instrument (gm_):\n${jsBlock}`);
      assert.ok(!jsBlock.includes('.bank('), `${topic.file}: js block picks a drum bank (.bank():\n${jsBlock}`);
      for (const token of demoSoundTokens(jsBlock)) {
        assert.ok(
          ALLOWED_DEMO_SOUNDS.includes(token),
          `${topic.file}: demo sound "${token}" is outside ALLOWED_DEMO_SOUNDS:\n${jsBlock}`,
        );
      }
    }

    const stripped = stripNamesBlocks(text);
    assert.deepEqual(findWords(stripped, TINT_WORDS), [], `${topic.file} carries a tint word outside a names block`);
    assert.ok(!stripped.toLowerCase().includes('flute'), `${topic.file} names "flute" outside a names block`);
    assert.ok(!text.toLowerCase().includes('jrpg'), `${topic.file} mentions JRPG`);
    assert.ok(!/examples[/\\]/i.test(text), `${topic.file} mentions the examples directory`);
    assert.ok(!/\.strudel\b/.test(text), `${topic.file} mentions a .strudel file`);

    for (const namesBlock of fencedBlocks(text, 'names')) {
      for (const line of namesBlock.split('\n')) {
        if (line.trim() === '') continue;
        assert.ok(line.length <= 160, `${topic.file}: names block line over 160 chars: ${line}`);
        assert.ok(!line.includes('. '), `${topic.file}: names block line contains ". ": ${line}`);
        assert.ok(!line.trim().endsWith('.'), `${topic.file}: names block line ends with ".": ${line}`);
      }
    }
  }
});

// --- The mixer's effect registry ---

const CONTROLS_FIXTURE = [
  'registerControl(["s","n","gain"],"sound");',
  'registerControl(["cutoff","resonance","lpenv"],"ctf","lpf","lp");',
  'registerControl("resonance","lpq");',
  'registerControl("gain");',
  'registerControl( ["room", "size"] );',
  'Pattern.prototype.hush=function(){return silence};',
].join('\n');

test('check-reference: registeredControls maps the first key and every alias to the key pack', () => {
  const controls = registeredControls(CONTROLS_FIXTURE);
  for (const name of ['lpf', 'ctf', 'lp', 'cutoff']) {
    assert.deepEqual(controls.get(name), ['cutoff', 'resonance', 'lpenv'], name);
  }
  assert.deepEqual(controls.get('gain'), ['gain']);
  assert.deepEqual(controls.get('lpq'), ['resonance']);
  assert.deepEqual(controls.get('resonance'), ['resonance']);
  assert.deepEqual(controls.get('room'), ['room', 'size']);
  assert.equal(controls.has('hush'), false);
});

const methodKeysFixture = {
  lpf: { canonical: 'lpf', keys: ['cutoff', 'resonance', 'lpenv'] },
  ctf: { canonical: 'lpf', keys: ['cutoff', 'resonance', 'lpenv'] },
  gain: { canonical: 'gain', keys: ['gain'] },
};

test('check-reference: registryFailures reports nothing when every method, alias and pack matches the bundle', () => {
  assert.deepEqual(registryFailures(CONTROLS_FIXTURE, { methodKeys: methodKeysFixture, nonControlNames: ['hush'] }), []);
});

test('check-reference: registryFailures reports an alias missing from the bundle, a pack that differs and a non-control name it cannot find', () => {
  const failures = registryFailures(CONTROLS_FIXTURE, {
    methodKeys: {
      ...methodKeysFixture,
      lpx: { canonical: 'lpf', keys: ['cutoff', 'resonance', 'lpenv'] },
      gain: { canonical: 'gain', keys: ['gain', 'postgain'] },
    },
    nonControlNames: ['hush', 'sine', 'tri', 'saw', 'range', 'slow'],
  });
  assert.ok(failures.includes('mixer registry: lpx is not a control in the bundle'), failures.join('\n'));
  assert.ok(failures.includes('mixer registry: gain writes gain,postgain, the bundle says gain'), failures.join('\n'));
  for (const name of ['sine', 'tri', 'saw', 'range', 'slow']) {
    assert.ok(failures.includes(`mixer registry: ${name} is not in the bundle`), name);
  }
  assert.ok(!failures.some((failure) => failure.includes('hush')));
  assert.equal(failures.length, 7);
});
