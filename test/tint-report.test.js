// Unit and CLI tests for scripts/tint-report.mjs. The developer-only tint and
// variety measurement: never a tool, never a resource, never text Claude reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseArgs,
  parseHistoryText,
  soundsUsed,
  scalesUsed,
  tempoUsed,
  hasFlute,
  demoLines,
  reusedDemoLines,
  similarity,
  identicalLines,
  withoutHelperLines,
  structureMetrics,
  structureLine,
  structureSummary,
  structureTopicSignatures,
  readTopicSignatures,
  formatReport,
} from '../scripts/tint-report.mjs';
import { HELPER_TEXT } from '../page/structure.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(repoRoot, 'scripts', 'tint-report.mjs');

// --- parseArgs ---

test('tint-report: parseArgs parses --last (default 10), --ids and --data-dir, and rejects unknown flags/bad numbers', () => {
  assert.deepEqual(parseArgs([]), { last: 10, ids: null, dataDir: null });
  assert.deepEqual(parseArgs(['--last', '5']), { last: 5, ids: null, dataDir: null });
  assert.deepEqual(parseArgs(['--ids', '3,7,9']), { last: null, ids: [3, 7, 9], dataDir: null });
  assert.deepEqual(parseArgs(['--ids', '3,7,9', '--data-dir', '/tmp/x']), {
    last: null,
    ids: [3, 7, 9],
    dataDir: '/tmp/x',
  });
  assert.throws(
    () => parseArgs(['--ids', 'x']),
    (err) => err.message.startsWith('tint:report:'),
  );
  assert.throws(
    () => parseArgs(['--bogus']),
    (err) => err.message.startsWith('tint:report:'),
  );
  assert.throws(
    () => parseArgs(['--last', 'not-a-number']),
    (err) => err.message.startsWith('tint:report:'),
  );
  assert.throws(
    () => parseArgs(['--last', '5', '--ids', '1,2']),
    (err) => err.message === 'tint:report: --last and --ids cannot be combined; pick one',
  );
});

// --- parseHistoryText ---

test('tint-report: parseHistoryText skips session-start, favorite and unreadable lines, keeps version entries in file order', () => {
  const text = [
    JSON.stringify({ type: 'session-start', at: 't' }),
    JSON.stringify({ type: 'version', id: 1, at: 't', origin: 'claude', code: 'a' }),
    JSON.stringify({ type: 'favorite', id: 1, name: 'x', at: 't' }),
    'not json at all {{{',
    JSON.stringify({ type: 'version', id: 2, at: 't', origin: 'hand', code: 'b', label: 'l' }),
  ].join('\n');
  const { versions, unreadable } = parseHistoryText(text);
  assert.deepEqual(versions, [
    { id: 1, origin: 'claude', code: 'a' },
    { id: 2, origin: 'hand', code: 'b', label: 'l' },
  ]);
  assert.equal(unreadable, 1);
});

// --- soundsUsed / scalesUsed / tempoUsed / hasFlute ---

test('tint-report: soundsUsed reads s/sound/.bank string arguments, splitting mini-notation and dropping numbers', () => {
  assert.deepEqual(soundsUsed('note("c e").s("gm_flute").bank("RolandTR909")'), ['RolandTR909', 'gm_flute']);
  assert.deepEqual(soundsUsed('s("bd*2 [sd hh]:3")'), ['bd', 'hh', 'sd']);
  assert.deepEqual(soundsUsed('note("c")'), []);
});

test('tint-report: scalesUsed reads .scale() string arguments; tempoUsed reads setcps/setcpm/.cpm calls verbatim', () => {
  assert.deepEqual(scalesUsed('n("0 2").scale("C:minor")'), ['C:minor']);
  assert.deepEqual(tempoUsed('setcps(0.7)\nnote("c")'), ['setcps(0.7)']);
});

test('tint-report: hasFlute is case-insensitive over the code and the label', () => {
  assert.equal(hasFlute('s("gm_pan_flute")'), true);
  assert.equal(hasFlute('s("bd")', 'Flute session'), true);
  assert.equal(hasFlute('s("bd")'), false);
  assert.equal(hasFlute('s("bd")', 'no match'), false);
});

// --- demoLines / reusedDemoLines ---

test('tint-report: demoLines keeps js-block lines of at least 24 chars that are not comments; reusedDemoLines finds verbatim reuse', () => {
  const markdown = [
    '```js',
    'short',
    '// a comment that is definitely 24+ characters long',
    'note("c e g").s("piano").slow(2)',
    '```',
  ].join('\n');
  const lines = demoLines([markdown]);
  assert.deepEqual(lines, ['note("c e g").s("piano").slow(2)']);
  assert.deepEqual(reusedDemoLines('note("c e g").s("piano").slow(2)', lines), lines);
  assert.deepEqual(reusedDemoLines('something else entirely', lines), []);
});

// --- similarity / identicalLines ---

test('tint-report: similarity is a rounded Jaccard index of code tokens; identicalLines counts shared trimmed lines', () => {
  assert.equal(similarity('s("bd sd")', 's("bd sd")'), 1);
  assert.equal(similarity('s("bd")', 'note("c")'), 0);
  assert.equal(similarity('a b', 'a c'), 0.33);
  assert.equal(identicalLines('s("bd sd")\nnote("c")', 's("bd sd")\nnote("d")'), 1);
  assert.equal(identicalLines('short\nline', 'short\nline'), 0);
});


// --- structure metrics ---

const STRUCTURED_PIECE = [
  "const harmony = 'D3:dorian';",
  'const song = {',
  '  shift: 2,',
  "  sections: [['partOne', 10], ['partTwo', 6, 'A2:minor']],",
  '  plan: {',
  "    partOne: { trackB: 'plain', trackC: 'follow', trackD: '-' },",
  "    partTwo: { trackB: 'plain', trackC: 'follow', trackD: 'fixed' },",
  '  },',
  "  groups: { lower: ['trackB'], upper: { inner: ['trackC', 'trackD'] } },",
  '};',
  HELPER_TEXT,
  'const trackB = { plain: note("c3 e3 g3") };',
  'const trackC = { follow: (h) => n("0 2 4 6").scale(h) };',
  "const trackD = { fixed: ['D3:dorian', note(\"d4 f4 a4\")] };",
  "trackB: play('trackB', trackB);",
  "trackC: play('trackC', trackC);",
  "trackD: play('trackD', trackD);",
].join('\n');

test('tint-report: structureMetrics describes a piece the page reads', () => {
  assert.deepEqual(structureMetrics(STRUCTURED_PIECE), {
    state: 'read',
    lengths: [10, 6],
    tracks: 3,
    kinds: { other: 1, degrees: 1, fixed: 1 },
    rests: 1,
    groupDepth: 2,
    sectionHarmonies: 1,
    sectionNames: ['partOne', 'partTwo'],
    helper: 'canonical',
    signature: '10,6|3',
  });
  assert.equal(
    structureLine(structureMetrics(STRUCTURED_PIECE)),
    '  structure: 2 sections (10, 6), 3 tracks, 3 variations (other 1, degrees 1, fixed 1), 1 rests, groups depth 2, 1 section harmonies, helper canonical',
  );
});

test('tint-report: structureMetrics says none for a piece without a structure and why for one the page cannot read', () => {
  assert.deepEqual(structureMetrics('drums: s("bd sd")'), { state: 'none' });
  assert.equal(structureLine({ state: 'none' }), '  structure: none');
  const unreadable = structureMetrics("const song = { sections: [], shift: 0, plan: {} };\nconst play = 1;");
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(unreadable.reason, 'no-sections');
  assert.equal(structureLine(unreadable), '  structure: unreadable (no-sections)');
  assert.deepEqual(structureMetrics('const song = {'), { state: 'unreadable', reason: 'parse' });
});

test('tint-report: only code that does not parse counts as parse; any other error from the reader is not hidden', () => {
  assert.deepEqual(structureMetrics('const song = {'), { state: 'unreadable', reason: 'parse' });
  const broken = { toString() { throw new TypeError('the reader broke'); } };
  assert.throws(() => structureMetrics(broken), /the reader broke/);
});

test('tint-report: readTopicSignatures reads the structure topic, and a missing topic file is an error, not zero shapes', () => {
  const found = readTopicSignatures(path.join(repoRoot, 'scripts'));
  assert.ok(Array.isArray(found) && found.length > 0);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-tint-'));
  try {
    assert.throws(() => readTopicSignatures(path.join(empty, 'scripts')), /^Error: tint:report: cannot read the structure topic/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('tint-report: a changed helper shows as the helper state of the shape', () => {
  const changed = STRUCTURED_PIECE.replace('clock.pickRestart(cells)', 'clock.pickRestart(cells).fast(2)');
  assert.equal(structureMetrics(changed).helper, 'changed');
});

test('tint-report: structureSummary counts structured versions, shapes, the highest share and the topic shapes', () => {
  const a = { state: 'read', signature: '10,6|3', sectionNames: ['intro', 'main'] };
  const b = { state: 'read', signature: '10,6|3', sectionNames: ['main'] };
  const c = { state: 'read', signature: '4|1', sectionNames: ['solo'] };
  assert.deepEqual(structureSummary([a, b, c, { state: 'none' }, { state: 'unreadable', reason: 'x' }], ['4|1', '9|9']), [
    'structured: 3 of 5 (1 more unreadable)',
    '  shape 10,6|3: 2',
    '  shape 4|1: 1',
    'highest share of one shape: 67%',
    'same shape as a structure-topic example: 1',
    'section names used in more than one version: main',
  ]);
  assert.deepEqual(structureSummary([{ state: 'none' }], []), [
    'structured: 0 of 1',
    'highest share of one shape: 0%',
    'same shape as a structure-topic example: 0',
    'section names used in more than one version: none',
  ]);
});

test('tint-report: the shapes of the structure topic are read from its blocks, the helper put back where a block leaves it out', () => {
  const topic = fs.readFileSync(path.join(repoRoot, 'reference', 'structure.md'), 'utf8');
  const signatures = structureTopicSignatures(topic);
  assert.equal(signatures.length, 3, signatures.join(' '));
  assert.equal(new Set(signatures).size, 3);
});

test('tint-report: the helper lines of a structured piece are not reused reference lines, every other topic line still is', () => {
  const topic = fs.readFileSync(path.join(repoRoot, 'reference', 'structure.md'), 'utf8');
  const lines = withoutHelperLines(demoLines([topic]));
  assert.ok(lines.length > 0);
  assert.deepEqual(reusedDemoLines(STRUCTURED_PIECE, lines).filter((line) => HELPER_TEXT.includes(line)), []);
  assert.ok(demoLines([topic]).some((line) => HELPER_TEXT.includes(line)), 'the topic does carry helper lines');
  assert.ok(reusedDemoLines(STRUCTURED_PIECE, demoLines([topic])).length > reusedDemoLines(STRUCTURED_PIECE, lines).length);
});

test('tint-report: formatReport ends with the structure block and the measurement-only line', () => {
  const versions = [
    { id: 1, origin: 'claude', code: STRUCTURED_PIECE, sounds: [], scales: [], tempo: [], flute: false, reused: [] },
    { id: 2, origin: 'claude', code: 'drums: s("bd")', sounds: ['bd'], scales: [], tempo: [], flute: false, reused: [] },
  ];
  const lines = formatReport({ file: 'history.jsonl', unreadable: 0, versions, ids: null, topicSignatures: ['10,6|3'] }).split('\n');
  const at = lines.indexOf('Structure across versions:');
  assert.ok(at > 0, lines.join('\n'));
  assert.equal(lines[at + 1], 'structured: 1 of 2');
  assert.ok(lines.includes('  shape 10,6|3: 1'));
  assert.ok(lines.includes('same shape as a structure-topic example: 1'));
  assert.equal(lines.at(-2), 'Measurement only: nothing in this report is sent to Claude.');
  assert.ok(lines.some((line) => line === '  structure: none'));
});

// --- CLI ---

test('tint-report CLI: --ids reports flute, demo-line reuse and pairwise similarity; a missing id exits 1 with a truthful error', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-tint-report-test-'));
  try {
    const referenceDir = path.join(repoRoot, 'reference');
    const markdownTexts = fs
      .readdirSync(referenceDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => fs.readFileSync(path.join(referenceDir, name), 'utf8'));
    const [reusedLine] = demoLines(markdownTexts);
    assert.ok(reusedLine, 'expected at least one demo line at least 24 characters long in reference/*.md');

    const historyLines = [
      JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'version',
        id: 1,
        at: '2026-01-01T00:00:01Z',
        origin: 'claude',
        code: 's("gm_pan_flute")',
        label: 'flute test',
      }),
      JSON.stringify({ type: 'version', id: 2, at: '2026-01-01T00:00:02Z', origin: 'claude', code: reusedLine }),
      JSON.stringify({ type: 'version', id: 3, at: '2026-01-01T00:00:03Z', origin: 'claude', code: 's("bd sd")' }),
      'not json at all {{{',
    ];
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), historyLines.join('\n') + '\n');

    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--ids', '1,2,3', '--data-dir', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('flute: yes'), result.stdout);
    assert.ok(result.stdout.includes('reference demo lines reused: 1'), result.stdout);
    assert.ok(result.stdout.includes('Similarity (same request):'), result.stdout);
    assert.ok(result.stdout.includes('  structure: none'), result.stdout);
    assert.ok(result.stdout.includes('Structure across versions:'), result.stdout);
    assert.ok(result.stdout.includes('structured: 0 of 3'), result.stdout);
    const pairLines = result.stdout.split('\n').filter((line) => line.includes(' vs '));
    assert.equal(pairLines.length, 3, result.stdout);
    assert.ok(
      result.stdout.trim().endsWith('Measurement only: nothing in this report is sent to Claude.'),
      result.stdout,
    );

    const missing = spawnSync(process.execPath, [SCRIPT_PATH, '--ids', '99', '--data-dir', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes('tint:report: no version #99'), missing.stderr);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('tint-report CLI: a missing history file prints a truthful error and exits 1', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-tint-report-test-'));
  try {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--data-dir', dataDir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('tint:report: no history file at'), result.stderr);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
