// Whether the notes of a fixed variation fit the harmony of the section they play in: the query program, the pitch classes
// it reads, the comparison and the words. Readings come from the real reader; patterns are small fakes that only answer
// queryArc, as in the check of the song declaration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { SONG_COPY, HELPER_TEXT, readStructure } from '../page/structure.js';
import { buildSongGrid, cellList } from '../page/song-grid-model.js';
import { FIT_REASONS, collectFit, evaluateFit, fitLookup, fitOf, fitPairs, fitSource, fitText, pairKey, sectionHarmony } from '../page/song-fit.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../page/song-fit.js', import.meta.url)), 'utf8');
const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

const num = (x) => ({ valueOf: () => x });

/** A fake pattern that answers queryArc: an event has its onset in the range that holds its begin. */
function pat(events) {
  return {
    queryArc(from, to) {
      return events
        .filter((event) => event.begin < to && event.end > from)
        .map((event) => ({
          whole: { begin: num(event.begin), end: num(event.end) },
          value: event.value,
          hasOnset: () => event.begin >= from,
        }));
    },
  };
}
const at = (begin, note) => ({ begin, end: begin + 0.25, value: { note } });

/** A piece with two fixed variations, one degree variation and a plain one: sections x (2 cycles, C major) and y (3, F# minor). */
function piece({ sections = "[['x', 2, 'C3:major'], ['y', 3, 'F#3:minor']]", harmony = '', plan, tracks } = {}) {
  return [
    harmony,
    `const song = { shift: 0, sections: ${sections}, plan: ${plan ?? "{ x: { t1: 'fa', t2: 'da' }, y: { t1: 'fb', t2: 'da' } }"} };`,
    HELPER_TEXT,
    tracks ?? "const t1 = { fa: ['C3:major', note('c3 e3')], fb: ['C3:major', note('f#3')], pl: note('d3') };\nconst t2 = { da: (h) => n('0 2').scale(h) };",
    "t1: play('t1', t1)",
    "t2: play('t2', t2)",
  ]
    .filter((part) => part !== '')
    .join('\n');
}

const wrap = (value) => ({ value, hasOnset: () => true });
const C_MAJOR = { rootPc: 0, modeId: 'ionian', text: 'C3:major' };
const bits = (...pcs) => pcs.reduce((mask, pc) => mask | (1 << pc), 0);

test('fitPairs lists every fixed variation of every track, muted ones too, tracks then variations in code order', () => {
  const code = piece({
    tracks: "const t1 = { fa: ['C3:major', note('c3')], pl: note('d3'), fb: ['C3:major', note('e3')] };\nconst t2 = { da: (h) => n('0').scale(h), fc: ['D3:dorian', note('g3')] };",
    plan: "{ x: { t1: 'fa', t2: 'da' }, y: { t1: 'pl', t2: 'fc' } }",
  }).replace("t2: play('t2', t2)", "_t2: play('t2', t2)");
  const reading = read(code);
  assert.equal(reading.state, 'read');
  assert.equal(reading.tracks[1].muted, true);
  assert.deepEqual(fitPairs(reading), [
    { track: 't1', key: 'fa' },
    { track: 't1', key: 'fb' },
    { track: 't2', key: 'fc' },
  ]);
  assert.equal(pairKey('t1', 'fa'), '["t1","fa"]');
});

test('fitSource builds a program that evaluateFit runs: the fixed variations only, in the order of fitPairs, never calling play()', async () => {
  const code = [
    "const song = { shift: 0, sections: [['x', 2, 'C3:major']], plan: { x: { t1: 'fa' } } };",
    "const t1 = { fa: ['C3:major', { queryArc: () => 'first' }], fb: ['C3:major', { queryArc: () => 'second' }], dg: (h) => ({ queryArc: () => 'degree' }) };",
    "t1: play('t1', t1)",
  ].join('\n');
  const reading = read(code);
  assert.equal(reading.state, 'read');
  const body = fitSource(code, reading, { parse });
  assert.equal((body.match(/this\.pick\(/g) ?? []).length, 2, 'only the two fixed variations are listed');
  const patterns = await evaluateFit(body);
  assert.equal(patterns.length, 2);
  assert.equal(patterns[0].queryArc(), 'first');
  assert.equal(patterns[1].queryArc(), 'second');
});

test('fitSource keeps a key with a quote a string, and a value that is not a pair or cannot be queried comes out null', async () => {
  const code = [
    "const song = { shift: 0, sections: [['x', 2, 'C3:major']], plan: { x: { t1: 'it\\'s' } } };",
    "const t1 = { 'it\\'s': ['C3:major', { queryArc: () => 'quoted' }], odd: ['C3:major', 5] };",
    "t1: play('t1', t1)",
  ].join('\n');
  const reading = read(code);
  assert.equal(reading.state, 'read');
  assert.deepEqual(fitPairs(reading).map((pair) => pair.key), ["it's", 'odd']);
  const patterns = await evaluateFit(fitSource(code, reading, { parse }));
  assert.equal(patterns[0].queryArc(), 'quoted');
  assert.equal(patterns[1], null);
});

test('evaluateFit refuses a program that does not give a list', async () => {
  await assert.rejects(() => evaluateFit('return 5;'), /Moontide: the fit query did not come out as a list/);
});

const collect = (patterns, over = {}) =>
  collectFit({
    patterns,
    pairs: patterns.map((_, i) => ({ track: 't', key: `v${i}` })),
    cycles: 3,
    budgetMs: 2000,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
    ...over,
  });

test('collectFit keeps, per cycle, the pitch classes of the onsets that begin there, enharmonic names as one note', async () => {
  const answer = await collect([pat([at(0, 'c4'), at(0.5, 'e4'), at(1.25, 'f#4'), at(2, 'gb4'), at(2.5, 'b2')])]);
  assert.equal(answer.state, 'ready');
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v0')), { masks: [bits(0, 4), bits(6), bits(6, 11)] });
});

test('collectFit counts a note within 0.25 semitone as its pitch class and leaves a note farther off out', async () => {
  const answer = await collect([pat([at(0, 60.2), at(0.5, 64.3), at(1, 67.25)])]);
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v0')).masks, [bits(0), bits(7), 0]);
});

test('collectFit reads a note given as a frequency, and ignores drum names and events that only run into a cycle', async () => {
  const fromFreq = { begin: 0, end: 0.25, value: { freq: 440 } };
  const drum = { begin: 0.5, end: 0.75, value: { s: 'bd' } };
  const long = { begin: 0.5, end: 1.5, value: { note: 'd4' } };
  const answer = await collect([pat([fromFreq, drum, long])]);
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v0')).masks, [bits(9, 2), 0, 0]);
});

test('collectFit gives not-read for a null pattern and for one whose query throws, and says why in failures', async () => {
  const broken = { queryArc() { throw new Error('boom'); } };
  const answer = await collect([null, broken, pat([at(0, 'c4')])]);
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v0')), { reason: 'not-read' });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v1')), { reason: 'not-read' });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v2')), { masks: [bits(0), 0, 0] });
  assert.deepEqual(answer.failures, [{ track: 't', key: 'v1', message: 'boom' }]);
});

test('collectFit: a clock past the budget makes this variation and the rest too-slow', async () => {
  let now = 0;
  const answer = await collect([pat([at(0, 'c4')]), pat([at(0, 'd4')]), pat([at(0, 'e4')])], {
    budgetMs: 100,
    clock: () => now,
    yieldToPage: async () => {
      now += 150;
    },
  });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v0')), { masks: [bits(0), 0, 0] });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v1')), { reason: 'too-slow' });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v2')), { reason: 'too-slow' });
});

test('collectFit stops looking at a variation whose cycles run past the budget', async () => {
  let now = 0;
  const slow = { queryArc() { now += 60; return []; } };
  const answer = await collect([slow, pat([at(0, 'c4')])], { cycles: 8, budgetMs: 100, clock: () => now });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v0')), { reason: 'too-slow' });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'v1')), { reason: 'too-slow' });
});

test('collectFit says cancelled as soon as the version is overtaken, and yields to the page between variations', async () => {
  let yields = 0;
  const done = await collect([pat([]), pat([]), pat([])], { yieldToPage: async () => void (yields += 1) });
  assert.equal(done.state, 'ready');
  assert.equal(yields, 3);
  let cancelled = false;
  const answer = await collect([pat([]), pat([])], { yieldToPage: async () => void (cancelled = true), isCancelled: () => cancelled });
  assert.deepEqual(answer, { state: 'cancelled' });
});

test('collectFit with patterns that do not match the pairs gives not-read for every variation and says so', async () => {
  const answer = await collectFit({ patterns: [], pairs: [{ track: 't', key: 'a' }], cycles: 2, budgetMs: 10, clock: () => 0, yieldToPage: async () => {}, isCancelled: () => false });
  assert.deepEqual(answer.byPair.get(pairKey('t', 'a')), { reason: 'not-read' });
  assert.equal(answer.failures.length, 1);
});

test('sectionHarmony: a scale of the nine, none, an unreadable piece harmony, text the reader rejects, chords and a scale outside the nine', () => {
  const sections = read(piece({ harmony: "const harmony = 'D3:dorian';", sections: "[['a', 1, 'E:minor'], ['b', 1], ['c', 1, 'Am7 D7'], ['d', 1, 'C:major pentatonic']]", plan: "{ a: { t1: 'fa', t2: 'da' }, b: { t1: 'fa', t2: 'da' }, c: { t1: 'fa', t2: 'da' }, d: { t1: 'fa', t2: 'da' } }" })).sections;
  assert.deepEqual(sectionHarmony(sections[0]), { rootPc: 4, modeId: 'aeolian', text: 'E:minor' });
  assert.deepEqual(sectionHarmony(sections[1]), { rootPc: 2, modeId: 'dorian', text: 'D3:dorian' });
  assert.deepEqual(sectionHarmony(sections[2]), { reason: 'harmony-unknown' });
  assert.deepEqual(sectionHarmony(sections[3]), { reason: 'harmony-unknown' });
  assert.deepEqual(sectionHarmony({ harmony: { from: 'none', text: null } }), { reason: 'no-harmony' });
  assert.deepEqual(sectionHarmony({ harmony: { from: 'piece-unreadable', text: null } }), { reason: 'harmony-unreadable' });
  assert.deepEqual(sectionHarmony({ harmony: { from: 'own', text: 'banana' } }), { reason: 'harmony-unreadable' });
});

test('fitOf on C major: notes in the scale fit, notes outside it are spelled as the scale is and listed upward from the root', () => {
  assert.deepEqual(fitOf({ masks: [bits(0, 4, 7)], length: 1, harmony: C_MAJOR }), { state: 'fits' });
  assert.deepEqual(fitOf({ masks: [bits(0, 6, 10)], length: 1, harmony: C_MAJOR }), { state: 'does-not-fit', outside: ['F#', 'Bb'] });
  // The same pitch classes in another cycle count once.
  assert.deepEqual(fitOf({ masks: [bits(6), bits(6)], length: 2, harmony: C_MAJOR }), { state: 'does-not-fit', outside: ['F#'] });
});

test('fitOf lists the outside notes upward from the root of the section, not from C', () => {
  const eFlat = { rootPc: 3, modeId: 'ionian', text: 'Eb3:major' };
  assert.deepEqual(fitOf({ masks: [bits(0, 4, 7, 9)], length: 1, harmony: eFlat }), { state: 'does-not-fit', outside: ['E', 'A'] });
  const fSharpMinor = { rootPc: 6, modeId: 'aeolian', text: 'F#3:minor' };
  assert.deepEqual(fitOf({ masks: [bits(5, 0, 2)], length: 1, harmony: fSharpMinor }), { state: 'does-not-fit', outside: ['C', 'F'] });
});

test('fitOf counts the cycles of the section only: a longer variation is cut at the section line', () => {
  const masks = [bits(0), bits(4), bits(6)];
  assert.deepEqual(fitOf({ masks, length: 2, harmony: C_MAJOR }), { state: 'fits' });
  assert.deepEqual(fitOf({ masks, length: 3, harmony: C_MAJOR }), { state: 'does-not-fit', outside: ['F#'] });
  assert.throws(() => fitOf({ masks, length: 4, harmony: C_MAJOR }), /Moontide:/);
});

test('fitOf: no pitched note is cannot-check no-notes, and the harmony reason comes before the reason the notes were not read', () => {
  assert.deepEqual(fitOf({ masks: [0, 0], length: 2, harmony: C_MAJOR }), { state: 'cannot-check', reason: 'no-notes' });
  assert.deepEqual(fitOf({ masks: [0], length: 1, harmony: { reason: 'harmony-unknown' } }), { state: 'cannot-check', reason: 'harmony-unknown' });
  assert.deepEqual(fitOf({ masks: undefined, length: 1, harmony: C_MAJOR, readReason: 'not-read' }), { state: 'cannot-check', reason: 'not-read' });
  assert.deepEqual(fitOf({ masks: undefined, length: 1, harmony: C_MAJOR, readReason: 'too-slow' }), { state: 'cannot-check', reason: 'too-slow' });
  assert.deepEqual(fitOf({ masks: undefined, length: 1, harmony: { reason: 'no-harmony' }, readReason: 'not-read' }), { state: 'cannot-check', reason: 'no-harmony' });
  assert.throws(() => fitOf({ masks: [1], length: 1, harmony: C_MAJOR, readReason: 'mystery' }), /Moontide: unknown fit reason 'mystery'/);
});

const names = { track: 't1', section: 'x', variation: 'fa', fixedHarmony: 'C3:major', sectionHarmonyText: 'C3:major' };

test('fitText: fits names the section harmony in the title', () => {
  assert.deepEqual(fitText({ state: 'fits' }, names), {
    line: 'fits',
    title: "'t1', section 'x': 'fa', fixed to C3:major. Its notes are all in C3:major.",
    chip: ' · fits',
  });
});

test('fitText: does not fit names at most three notes and then how many more, and the title lists them all', () => {
  const two = fitText({ state: 'does-not-fit', outside: ['F#', 'A'] }, names);
  assert.equal(two.line, 'does not fit (F#, A)');
  assert.equal(two.title, "'t1', section 'x': 'fa', fixed to C3:major. These notes are outside C3:major: F#, A. Nothing is changed.");
  assert.equal(two.chip, ' · does not fit (F#, A)');
  const five = fitText({ state: 'does-not-fit', outside: ['F#', 'A', 'C', 'Eb', 'G'] }, names);
  assert.equal(five.line, 'does not fit (F#, A, C and 2 more)');
  assert.ok(five.title.includes('F#, A, C, Eb, G. Nothing is changed.'));
  assert.equal(fitText({ state: 'does-not-fit', outside: ['F#', 'A', 'C'] }, names).line, 'does not fit (F#, A, C)');
  assert.equal(fitText({ state: 'does-not-fit', outside: ['F#', 'A', 'C', 'Eb'] }, names).line, 'does not fit (F#, A, C and 1 more)');
});

test('fitText: every cannot-check reason gives its sentence, and an unknown reason or state throws', () => {
  assert.deepEqual(Object.keys(SONG_COPY.fitReasons), [...FIT_REASONS]);
  assert.equal(Object.isFrozen(FIT_REASONS), true);
  const sentences = {
    'no-harmony': 'This section declares no harmony.',
    'harmony-unreadable': 'The harmony of this section is not readable.',
    'harmony-unknown': 'The harmony is not one of the nine scales the page knows.',
    'no-notes': 'The page found no pitched notes to compare.',
    'not-read': 'The page could not read the notes of this variation.',
    'too-slow': 'Reading the notes of this variation took too long.',
  };
  for (const reason of FIT_REASONS) {
    const words = fitText({ state: 'cannot-check', reason }, { ...names, sectionHarmonyText: undefined });
    assert.equal(words.line, 'cannot check');
    assert.equal(words.title, `'t1', section 'x': 'fa', fixed to C3:major. ${sentences[reason]}`);
  }
  assert.throws(() => fitText({ state: 'cannot-check', reason: 'mystery' }, names), /Moontide: unknown fit reason 'mystery'/);
  assert.throws(() => fitText({ state: 'mystery' }, names), /Moontide: unknown fit state/);
});

test('fit words carry no verdict word and never an instruction', () => {
  const words = [SONG_COPY.fitFits, SONG_COPY.fitNot, SONG_COPY.fitMore, SONG_COPY.fitCannot, SONG_COPY.fitTitleFits, SONG_COPY.fitTitleNot, SONG_COPY.fitTitleCannot, ...Object.values(SONG_COPY.fitReasons)];
  for (const text of words) assert.doesNotMatch(text, /\b(wrong|error|should|try|bad|good|clash)\b/i, text);
});

test('the lookup gives each section entry its own words from its own length and harmony, and nothing for a variation that is not fixed', () => {
  const reading = read(piece());
  assert.equal(reading.state, 'read');
  const byPair = new Map([
    [pairKey('t1', 'fa'), { masks: [bits(0), bits(4, 5), bits(6)] }],
    [pairKey('t1', 'fb'), { reason: 'too-slow' }],
  ]);
  const lookup = fitLookup({ reading, byPair });
  // In x (2 cycles, C major) fa fits; in y (3 cycles, F# minor) the same notes C, E, F, F# have notes outside the scale.
  assert.equal(lookup('t1', 0, 'fa').line, 'fits');
  assert.equal(lookup('t1', 1, 'fa').state, 'does-not-fit');
  assert.equal(lookup('t1', 1, 'fa').line, 'does not fit (C, F)');
  assert.equal(lookup('t1', 1, 'fa').outsideText, 'C, F');
  assert.deepEqual(lookup('t1', 1, 'fb').state, 'cannot-check');
  assert.equal(lookup('t1', 1, 'fb').title.endsWith('Reading the notes of this variation took too long.'), true);
  assert.equal(lookup('t2', 0, 'da'), null);
  assert.equal(lookup('t1', 0, 'pl'), null);
  assert.equal(lookup('t1', 0, 'nope'), null);
  assert.equal(lookup('t9', 0, 'fa'), null);
});

test('the lookup fails loudly when the answer has nothing for a fixed variation', () => {
  const reading = read(piece());
  assert.throws(() => fitLookup({ reading, byPair: new Map() })('t1', 0, 'fa'), /Moontide: the fit answer has nothing/);
});

test('a repeated section name gets the fit of each column from that column\'s own length', () => {
  const code = piece({
    sections: "[['x', 1, 'C3:major'], ['y', 2, 'G3:major'], ['x', 3, 'C3:major']]",
    plan: "{ x: { t1: 'fa', t2: 'da' }, y: { t1: 'fa', t2: 'da' } }",
  });
  const reading = read(code);
  assert.equal(reading.state, 'read');
  // The note F# begins in the third cycle only: the short use of x does not play it, the long one does.
  const lookup = fitLookup({ reading, byPair: new Map([[pairKey('t1', 'fa'), { masks: [bits(0), bits(7), bits(6)] }], [pairKey('t1', 'fb'), { masks: [0, 0, 0] }]]) });
  assert.equal(lookup('t1', 0, 'fa').state, 'fits');
  assert.equal(lookup('t1', 1, 'fa').state, 'fits');
  assert.equal(lookup('t1', 2, 'fa').state, 'does-not-fit');
  assert.equal(lookup('t1', 2, 'fa').outsideText, 'F#');
});

test('the grid shows no second line and no data for a fixed variation while the fit is pending', () => {
  const reading = read(piece());
  const pending = buildSongGrid({ reading, folds: new Set(), launchChoice: 'section' });
  const cells = pending.rows.find((row) => row.name === 't1').cells;
  assert.ok(cells.every((cell) => cell.fit === null));
  assert.equal(cells[0].title, "'t1', section 'x': 'fa', fixed to C3:major");
  const lookup = fitLookup({ reading, byPair: new Map([[pairKey('t1', 'fa'), { masks: [bits(0, 4), 0, 0] }], [pairKey('t1', 'fb'), { masks: [bits(3), bits(6), 0] }]]) });
  const answered = buildSongGrid({ reading, folds: new Set(), launchChoice: 'section', fit: lookup });
  const fixed = answered.rows.find((row) => row.name === 't1').cells;
  assert.deepEqual(fixed[0].fit, { state: 'fits', line: 'fits', outside: null });
  assert.equal(fixed[1].fit.state, 'does-not-fit');
  assert.equal(fixed[1].fit.outside, 'D#');
  assert.equal(fixed[1].fit.line, 'does not fit (D#)');
  assert.equal(fixed[0].title, "'t1', section 'x': 'fa', fixed to C3:major. Its notes are all in C3:major.");
  const degrees = answered.rows.find((row) => row.name === 't2').cells;
  assert.ok(degrees.every((cell) => cell.fit === null), 'a degree variation has no fit words');
});

test('the cell list notes each fixed variation with its fit for the section being edited, and nothing while the fit is pending', () => {
  const reading = read(piece());
  const noteOf = (list, key) => list.options.find((option) => option.key === key).note;
  const pending = cellList({ reading, trackName: 't1', sectionIndex: 1 });
  assert.equal(noteOf(pending, 'fa'), null);
  assert.equal(noteOf(pending, 'fb'), null);
  const lookup = fitLookup({ reading, byPair: new Map([[pairKey('t1', 'fa'), { masks: [bits(0), bits(4), bits(7)] }], [pairKey('t1', 'fb'), { masks: [bits(5), 0, 0] }]]) });
  const list = cellList({ reading, trackName: 't1', sectionIndex: 1, fit: lookup });
  assert.equal(noteOf(list, 'fa'), 'does not fit (G, C)');
  assert.equal(noteOf(list, 'fb'), 'does not fit (F)');
  assert.equal(noteOf(list, 'pl'), null);
  const other = cellList({ reading, trackName: 't2', sectionIndex: 1, fit: lookup });
  assert.equal(noteOf(other, 'da'), 'follows the harmony');
  const first = cellList({ reading, trackName: 't1', sectionIndex: 0, fit: lookup });
  assert.equal(noteOf(first, 'fa'), 'fits');
  assert.equal(noteOf(first, 'fb'), 'fits');
  assert.equal(first.options.at(-1).note, null, 'the rest has no note');
  const viaGrid = buildSongGrid({ reading, folds: new Set(), launchChoice: 'section', fit: lookup }).listFor('t1', 0);
  assert.equal(noteOf(viaGrid, 'fa'), 'fits');
});

test('the module has no DOM access, never calls the code\'s play() and never rewrites anything', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const pattern of [/\bdocument\b/, /\bwindow\b/, /\.play\(/, /\bevaluate\(/, /\bsetCode\b/, /\bfetch\(/, /innerHTML/]) {
    assert.doesNotMatch(code, pattern, String(pattern));
  }
  assert.match(code, /new AsyncFunctionConstructor\(body\)/);
});
