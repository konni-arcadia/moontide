import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HARMONY_REASONS, MAX_HARMONY_TEXT, MAX_SOURCE_LENGTH, SCALE_NAME_IDS, readHarmony } from '../page/harmony.js';
import { MODES } from '../page/jam-analysis.js';
import { TINT_WORDS, findWords, stripNamesBlocks } from './tint-rules.js';

const HARMONY_PATH = fileURLToPath(new URL('../page/harmony.js', import.meta.url));
const THEORY_PATH = fileURLToPath(new URL('../reference/theory.md', import.meta.url));

const read = (code) => readHarmony(code, { parse });
const scale = (text, rootPc, modeId) => ({ state: 'declared', kind: 'scale', text, scale: { rootPc, modeId } });
const scaleText = (text) => ({ state: 'declared', kind: 'scale', text, scale: null });
const chords = (text) => ({ state: 'declared', kind: 'chords', text, scale: null });
const unreadable = (reason, source = null) => ({ state: 'unreadable', reason, source });

test('the limits and the reason ids are the documented ones', () => {
  assert.equal(MAX_HARMONY_TEXT, 200);
  assert.equal(MAX_SOURCE_LENGTH, 40);
  assert.deepEqual([...HARMONY_REASONS], ['not-const', 'computed', 'not-text', 'not-a-harmony', 'empty', 'too-long', 'not-a-plain-const']);
  assert.ok(Object.isFrozen(HARMONY_REASONS));
  assert.ok(Object.isFrozen(SCALE_NAME_IDS));
});

test('every scale name maps to the id of a mode of the Jam analysis, and all nine modes have a name', () => {
  const ids = new Set(MODES.map((mode) => mode.id));
  for (const [name, modeId] of SCALE_NAME_IDS) assert.ok(ids.has(modeId), `${name} -> ${modeId}`);
  assert.deepEqual(new Set(SCALE_NAME_IDS.map(([, modeId]) => modeId)), ids);
});

test('none: no top-level binding named harmony', () => {
  const cases = [
    '',
    'lead: note("c3")',
    'const other = "C:major"\nlead: note("c3")',
    'const f = (harmony) => harmony\nlead: note("c3")',
    '{ const harmony = "C:major" }\nlead: note("c3")',
    'function f() { const harmony = "C:major" }\nlead: note("c3")',
    'const o = { harmony: "C:major" }\nlead: note("c3")',
    'const s = "harmony"\nlead: note("c3")',
    'harmony: "D4:dorian"',
    'harmony: note("c3")\nlead: note("e3")',
  ];
  for (const code of cases) assert.deepEqual(read(code), { state: 'none' }, code);
});

test('declared scale: a quoted string with a root, a colon and a scale name', () => {
  const cases = [
    ["const harmony = 'D4:dorian'", scale('D4:dorian', 2, 'dorian')],
    ['const harmony = "C:major"', scale('C:major', 0, 'ionian')],
    ["const harmony = 'a:minor'", scale('a:minor', 9, 'aeolian')],
    ["const harmony = 'Eb:major'", scale('Eb:major', 3, 'ionian')],
    ["const harmony = 'F#:major'", scale('F#:major', 6, 'ionian')],
    ["const harmony = 'C:harmonic:minor'", scale('C:harmonic:minor', 0, 'harmonic-minor')],
    ["const harmony = 'G:melodic minor'", scale('G:melodic minor', 7, 'melodic-minor')],
    ["const harmony = 'bb:mixolydian'", scale('bb:mixolydian', 10, 'mixolydian')],
    ["const harmony = 'C-1:lydian'", scale('C-1:lydian', 0, 'lydian')],
    ["const harmony = 'E:Phrygian'", scale('E:Phrygian', 4, 'phrygian')],
    ["const harmony = 'B:locrian'", scale('B:locrian', 11, 'locrian')],
    ["const harmony = 'C:minor pentatonic'", scaleText('C:minor pentatonic')],
    ['const harmony = `C:minor:pentatonic`', scaleText('C:minor:pentatonic')],
    ['const harmony = `D:dorian`', scale('D:dorian', 2, 'dorian')],
    ['const harmony = "<C:major D:dorian>/2"', scaleText('<C:major D:dorian>/2')],
    ['const harmony = "C:major D:dorian"', scaleText('C:major D:dorian')],
  ];
  for (const [code, expected] of cases) assert.deepEqual(read(code), expected, code);
});

test('declared chords: chord symbols as text, or the inner string of a chord call', () => {
  const cases = [
    ['const harmony = "<Dm7 G7 C^7>"', chords('<Dm7 G7 C^7>')],
    ['const harmony = "C"', chords('C')],
    ['const harmony = "<C C^7 C-7>/2"', chords('<C C^7 C-7>/2')],
    ['const harmony = "[Bb7 ~] Ab*2"', chords('[Bb7 ~] Ab*2')],
    ['const harmony = chord("<Dm7 G7>")', chords('<Dm7 G7>')],
    ["const harmony = chord('C')", chords('C')],
    ['const harmony = chord(`Am7`)', chords('Am7')],
    ['const harmony = "C7(#9) Dm7(b5)"', chords('C7(#9) Dm7(b5)')],
    ['const harmony = "C*<2 3> G7"', chords('C*<2 3> G7')],
    ['const harmony = "C(3,8) G7"', chords('C(3,8) G7')],
    ['const harmony = "<Cmaj7#11 Csus4 Cadd9 Cm7b5 Cdim7 Caug C7alt C\u00f87 C/E>"', chords('<Cmaj7#11 Csus4 Cadd9 Cm7b5 Cdim7 Caug C7alt C\u00f87 C/E>')],
  ];
  for (const [code, expected] of cases) assert.deepEqual(read(code), expected, code);
});

test('a chord call whose string is a scale or holds lowercase words is not a harmony', () => {
  assert.deepEqual(read('const harmony = chord("C:major")'), unreadable('not-a-harmony', 'chord("C:major")'));
  assert.deepEqual(read('const harmony = chord("c3 e3")'), unreadable('not-a-harmony', 'chord("c3 e3")'));
});

test('not-const: let and var are unreadable', () => {
  for (const code of ['let harmony = "C:major"', 'var harmony = "C:major"']) assert.deepEqual(read(code), unreadable('not-const'), code);
});

test('computed: anything the page would have to run, with the source quoted', () => {
  const cases = [
    ['const harmony = other', 'other'],
    ['const harmony = scales.main', 'scales.main'],
    ['const harmony = pick("C:major")', 'pick("C:major")'],
    ['const harmony = chord(x)', 'chord(x)'],
    ['const harmony = chord("C", "D")', 'chord("C", "D")'],
    ['const harmony = chord()', 'chord()'],
    ['const harmony = `${root}:major`', '`${root}:major`'],
    ['const harmony = "C" + ":major"', '"C" + ":major"'],
    ['const harmony = flag ? "C:major" : "D:dorian"', 'flag ? "C:major" : "D:dorian"'],
    ['const harmony = () => "C:major"', '() => "C:major"'],
    ['const harmony = !x', '!x'],
  ];
  for (const [code, source] of cases) assert.deepEqual(read(code), unreadable('computed', source), code);
});

test('not-text: a number, a boolean, null, an array or an object is not a scale or chord text', () => {
  const cases = [
    ['const harmony = 7', '7'],
    ['const harmony = -7', '-7'],
    ['const harmony = true', 'true'],
    ['const harmony = null', 'null'],
    ['const harmony = ["C", "G"]', '["C", "G"]'],
    ['const harmony = { root: "C" }', '{ root: "C" }'],
  ];
  for (const [code, source] of cases) assert.deepEqual(read(code), unreadable('not-text', source), code);
});

test('not-a-harmony: a string that is neither scale tokens nor chord symbols', () => {
  for (const text of ["'bd sd'", '"c3 e3"', "'hello'", '"Dm7 C:major"', '"Dorian"', '"Cat"', '"Bass"', '"Drums"', '"Effects"', '"Dorian Cat"', '"C:major D"', '"C:major Dm7"']) {
    assert.deepEqual(read(`const harmony = ${text}`), unreadable('not-a-harmony', text), text);
  }
});

test('empty: no text, only spaces or only rests', () => {
  for (const text of ["''", "'   '", '"~ ~"', '"<~ ~>"', '"[]"', 'chord("")']) {
    assert.deepEqual(read(`const harmony = ${text}`), unreadable('empty'), text);
  }
});

test('too-long: a text over 200 characters is refused before any pattern runs, even when it looks valid', () => {
  const valid = `"${'C '.repeat(101)}"`;
  assert.ok(valid.length - 2 > MAX_HARMONY_TEXT);
  assert.deepEqual(read(`const harmony = ${valid}`), unreadable('too-long'));
  assert.deepEqual(read(`const harmony = chord(${valid})`), unreadable('too-long'));
  const atLimit = `"${'C '.repeat(MAX_HARMONY_TEXT / 2)}"`;
  assert.equal(read(`const harmony = ${atLimit}`).state, 'declared');
  assert.deepEqual(read(`const harmony = '${'a'.repeat(MAX_HARMONY_TEXT + 1)}'`), unreadable('too-long'));
});

test('not-a-plain-const: a destructuring pattern that binds the name', () => {
  for (const code of ['const { harmony } = x', 'const [harmony] = x', 'const { a: harmony } = x', 'const { a, ...harmony } = x', 'const [a = 1, [harmony]] = x']) {
    assert.deepEqual(read(code), unreadable('not-a-plain-const'), code);
  }
});

test('the first top-level declarator that binds the name decides', () => {
  assert.deepEqual(read("const a = 1, harmony = 'C:major'"), scale('C:major', 0, 'ionian'));
  assert.deepEqual(read("const harmony = 'C:major'\nconst harmony2 = 'D:dorian'"), scale('C:major', 0, 'ionian'));
  assert.deepEqual(read("let harmony = 'C:major'\nvar other = 1"), unreadable('not-const'));
  assert.deepEqual(read('const harmony = 7\nlead: note("c3")'), unreadable('not-text', '7'));
});

test('source quotes are cut at 40 code points with an ellipsis, and a surrogate pair is never split', () => {
  const long = `pick("${'x'.repeat(60)}")`;
  const result = read(`const harmony = ${long}`);
  assert.equal(result.reason, 'computed');
  assert.equal([...result.source].length, MAX_SOURCE_LENGTH);
  assert.ok(result.source.endsWith('…'));
  assert.equal(result.source, `${long.slice(0, MAX_SOURCE_LENGTH - 1)}…`);
  const emoji = `pick("${'\u{1F3B5}'.repeat(60)}")`;
  const cut = read(`const harmony = ${emoji}`).source;
  assert.equal([...cut].length, MAX_SOURCE_LENGTH);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'no lone surrogate');
  assert.equal(read('const harmony = pick("short")').source, 'pick("short")');
});

test('hostile input is read without throwing and in a short time', () => {
  const started = Date.now();
  const texts = ['['.repeat(200), ']'.repeat(200), ':'.repeat(200), '<C:'.repeat(66), 'C:'.repeat(100), '#'.repeat(200), 'C'.padEnd(199, '#') + ':major', ' '.repeat(200)];
  for (const text of texts) {
    const result = read(`const harmony = '${text}'`);
    assert.ok(['declared', 'unreadable'].includes(result.state), text);
  }
  const proto = read("const harmony = 'C:__proto__'");
  assert.deepEqual(proto, scaleText('C:__proto__'));
  assert.deepEqual(read("const harmony = 'C:constructor'"), scaleText('C:constructor'));
  assert.ok(Date.now() - started < 200, 'the hostile texts are read in well under 200 ms');
});

test('a result is plain data that survives a JSON round trip', () => {
  const codes = ["const harmony = 'D4:dorian'", 'const harmony = "<Dm7 G7>"', 'let harmony = 1', 'const harmony = x', 'lead: note("c3")'];
  for (const code of codes) assert.deepEqual(JSON.parse(JSON.stringify(read(code))), read(code), code);
});

test('the module takes parse as an argument and has no DOM access, evaluation or dynamic pattern', () => {
  const source = readFileSync(HARMONY_PATH, 'utf8');
  assert.doesNotMatch(source, /new RegExp|eval\(|new Function|^import |document\.|window\./m);
  assert.throws(() => readHarmony('const harmony = 1', {}), TypeError);
  assert.throws(() => read('const harmony = ('), SyntaxError);
});

test('reference/theory.md states the declaration as a fact, between Voicings and inversions and Rhythm and meter', () => {
  const theory = readFileSync(THEORY_PATH, 'utf8');
  const heading = '## Declaring the harmony';
  assert.equal(theory.split('\n').filter((line) => line === heading).length, 1, 'the heading exists exactly once');
  const headings = theory.split('\n').filter((line) => line.startsWith('## '));
  const at = headings.indexOf(heading);
  assert.equal(headings[at - 1], '## Voicings and inversions');
  assert.equal(headings[at + 1], '## Rhythm and meter');
  const start = theory.indexOf(heading);
  const section = theory.slice(start, theory.indexOf('\n## ', start + heading.length));
  for (const sentence of ['const harmony', 'plays nothing', 'unexpected ast format without body expression', 'so the line goes above the patterns, never last']) {
    assert.ok(section.includes(sentence), `the section says: ${sentence}`);
  }
  assert.deepEqual(findWords(stripNamesBlocks(section), TINT_WORDS), [], 'no tint word');
  assert.doesNotMatch(section, /arrange/i, 'the section never points toward arrange');
  assert.doesNotMatch(section, /\b(should|must|try|recommend|prefer)\b/i, 'the section states facts and gives no advice');
});
