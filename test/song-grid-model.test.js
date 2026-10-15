// The pure model of the Song grid, tested without a browser: columns, rows, group folding, the playing section, the live
// state of a header and the sentence under the toolbar. Readings come from the real reader, so the shapes cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { HELPER_TEXT, SONG_COPY, SONG_REFUSALS, readStructure } from '../page/structure.js';
import { SONG_GRID_DEEP_FROM, buildSongGrid, cellList, cellRecordLabel, controlsDisabled, gridMove, groupKey, headerLive, launchOptions, listPlacement, nowText, playingSection, sectionDeclared, songLine } from '../page/song-grid-model.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../page/song-grid-model.js', import.meta.url)), 'utf8');
const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

const DEFAULTS = {
  harmony: "const harmony = 'C3:major';",
  shift: '0',
  sections: "[['x', 3, 'E3:minor'], ['y', 5], ['z', 7]]",
  groups: "{ g1: ['t1', 't2'], g2: { g3: ['t3'] } }",
  plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' }, z: { t1: 'va', t2: '-', t3: 'va' } }",
  tracks: [
    "const t1 = { va: note('c3'), vb: note('d3') };",
    "const t2 = { va: (h) => n('0 2').scale(h) };",
    "const t3 = { va: ['D3:dorian', note('e3')] };",
  ].join('\n'),
  statements: "t1: play('t1', t1)\nt2: play('t2', t2)\nt3: play('t3', t3)",
};

function piece(over = {}) {
  const o = { ...DEFAULTS, ...over };
  const entries = [`shift: ${o.shift}`, `sections: ${o.sections}`];
  if (o.groups !== null) entries.push(`groups: ${o.groups}`);
  entries.push(`plan: ${o.plan}`);
  return [o.harmony, `const song = { ${entries.join(', ')} };`, HELPER_TEXT, o.tracks, o.statements].filter((part) => part !== '').join('\n');
}

const grid = (over = {}, { folds = [], launchChoice = 'section' } = {}) => buildSongGrid({ reading: read(piece(over)), folds: new Set(folds), launchChoice });

test('the grid of a read song has one column per section entry, with its length and harmony as the list had them', () => {
  const model = grid();
  assert.equal(model.title, 'Song');
  assert.equal(model.corner, '3 sections, 15 cycles');
  assert.deepEqual(
    model.columns.map((column) => [column.index, column.name, column.text, column.lengthText, column.harmonyText, column.uses]),
    [
      [0, 'x', 'x', '3 cycles', 'harmony E3:minor', 1],
      [1, 'y', 'y', '5 cycles', 'harmony C3:major (from the piece)', 1],
      [2, 'z', 'z', '7 cycles', 'harmony C3:major (from the piece)', 1],
    ],
  );
  assert.ok(model.columns.every((column) => column.title === null && column.usedText === null));
});

test('the corner says the shift, and a harmony that is missing or not readable has its own words', () => {
  assert.equal(grid({ shift: '4' }).corner, '3 sections, 15 cycles, shifted by 4 cycles');
  assert.equal(grid({ shift: '1' }).corner, '3 sections, 15 cycles, shifted by 1 cycle');
  assert.equal(grid({ shift: '-2.5' }).corner, '3 sections, 15 cycles, shifted by -2.5 cycles');
  const none = grid({ harmony: '', tracks: "const t1 = { va: note('c3'), vb: note('d3') };\nconst t2 = { va: note('e3') };\nconst t3 = { va: ['D3:dorian', note('e3')] };" });
  assert.equal(none.columns[1].harmonyText, 'no harmony declared');
  assert.equal(grid({ harmony: "const harmony = 'banana';" }).columns[1].harmonyText, 'harmony not readable');
});

test('a 60 code point harmony is cut with the whole text in the harmony title', () => {
  const long = `<${'Am '.repeat(22)}Am>`;
  const model = grid({ sections: `[['x', 3, '${long}'], ['y', 5], ['z', 7]]` });
  assert.equal(model.columns[0].harmonyText, `harmony ${[...long].slice(0, 59).join('')}…`);
  assert.equal(model.columns[0].harmonyTitle, long);
  assert.equal(model.columns[1].harmonyTitle, model.columns[1].harmonyText, 'a harmony that was not cut needs no other title');
});

test('rows follow the groups as written, then the tracks in no group, and each track has one cell per section', () => {
  const model = grid();
  assert.deepEqual(
    model.rows.map((row) => [row.kind, row.key, row.text, row.depth, row.level]),
    [
      ['group', 'g:["g1"]', 'g1', 0, 1],
      ['track', 't:t1', 't1', 1, 2],
      ['track', 't:t2', 't2', 1, 2],
      ['group', 'g:["g2"]', 'g2', 0, 1],
      ['group', 'g:["g2","g3"]', 'g3', 1, 2],
      ['track', 't:t3', 't3', 2, 3],
    ],
  );
  assert.ok(model.rows.every((row) => row.hidden === false));
  assert.deepEqual(model.rows.filter((row) => row.kind === 'group').map((row) => [row.text, row.count, row.countText, row.open]), [
    ['g1', 2, '2 tracks', true],
    ['g2', 1, '1 track', true],
    ['g3', 1, '1 track', true],
  ]);
  const t3 = model.rows.find((row) => row.name === 't3');
  assert.equal(t3.cells.length, 3);
  assert.equal(t3.trackIndex, 2);
});

test('a cell shows its variation, rest in muted words, and its title says what kind it is', () => {
  const rows = grid().rows.filter((row) => row.kind === 'track');
  const [t1, t2, t3] = rows;
  assert.deepEqual(t1.cells.map((cell) => [cell.text, cell.kind]), [['va', 'other'], ['vb', 'other'], ['va', 'other']]);
  assert.equal(t1.cells[0].title, "'t1', section 'x': 'va'. Click to change.");
  assert.deepEqual(t2.cells.map((cell) => [cell.text, cell.kind]), [['va', 'degrees'], ['va', 'degrees'], ['rest', 'rest']]);
  assert.equal(t2.cells[0].title, "'t2', section 'x': 'va', follows the harmony");
  assert.equal(t2.cells[2].title, "'t2', section 'z': rest. Click to change.");
  assert.deepEqual(t3.cells.map((cell) => [cell.text, cell.kind]), [['va', 'fixed'], ['rest', 'rest'], ['va', 'fixed']]);
  assert.equal(t3.cells[0].title, "'t3', section 'x': 'va', fixed to D3:dorian");
});

test('a column whose cells are all rest is drawn as a column of rest', () => {
  const model = grid({ plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: '-', t2: '-', t3: '-' }, z: { t1: 'va', t2: '-', t3: 'va' } }" });
  const tracks = model.rows.filter((row) => row.kind === 'track');
  assert.deepEqual(tracks.map((row) => row.cells[1].text), ['rest', 'rest', 'rest']);
});

test('a song with no groups draws a flat list, and a group of only groups or of one track draws as written', () => {
  const flat = grid({ groups: null });
  assert.deepEqual(flat.rows.map((row) => [row.kind, row.level]), [['track', 1], ['track', 1], ['track', 1]]);
  const nested = grid({ groups: "{ outer: { inner: ['t1'] }, solo: ['t2'] }" });
  assert.deepEqual(nested.rows.map((row) => [row.kind, row.text, row.level]), [
    ['group', 'outer', 1],
    ['group', 'inner', 2],
    ['track', 't1', 3],
    ['group', 'solo', 1],
    ['track', 't2', 2],
    ['track', 't3', 1],
  ]);
  assert.equal(nested.rows[0].count, 1, 'a group of only groups counts the track below its inner group');
});

test('a statement that plays no part of the song plan is a row of its own with the plain words', () => {
  const model = grid({ groups: null, statements: "t1: play('t1', t1)\nextra: note('c4')\nt2: play('t2', t2)\nt3: play('t3', t3)" });
  assert.deepEqual(model.rows.map((row) => [row.kind, row.key, row.text]), [
    ['track', 't:t1', 't1'],
    ['outside', 'o:1', 'extra'],
    ['track', 't:t2', 't2'],
    ['track', 't:t3', 't3'],
  ]);
  const outside = model.rows[1];
  assert.equal(outside.note, 'outside the song plan: plays in every section');
  assert.equal(outside.level, 1);
});

test('one section draws a one-column grid', () => {
  const model = grid({ sections: "[['only', 4]]", plan: "{ only: { t1: 'va', t2: 'va', t3: 'va' } }" });
  assert.equal(model.corner, '1 section, 4 cycles');
  assert.equal(model.columns.length, 1);
  assert.ok(model.rows.filter((row) => row.kind === 'track').every((row) => row.cells.length === 1));
});

test('a folded group hides every row below it at any depth and keeps their own fold states; an unknown key is ignored', () => {
  const deep = { groups: "{ outer: { inner: ['t1'], other: ['t2'] }, side: ['t3'] }" };
  const folded = grid(deep, { folds: [groupKey(['outer'])] });
  assert.deepEqual(folded.rows.map((row) => [row.text, row.hidden]), [
    ['outer', false],
    ['inner', true],
    ['t1', true],
    ['other', true],
    ['t2', true],
    ['side', false],
    ['t3', false],
  ]);
  assert.equal(folded.rows[0].open, false);
  assert.equal(folded.rows[0].foldTitle, "Open 'outer'");
  assert.equal(folded.rows[0].countText, '2 tracks', 'the count includes every track below at any depth');
  const both = grid(deep, { folds: [groupKey(['outer']), groupKey(['outer', 'inner']), groupKey(['nowhere'])] });
  assert.equal(both.rows[1].open, false, 'the inner fold state is kept while the outer one hides it');
  assert.equal(both.rows[1].hidden, true);
  const inner = grid(deep, { folds: [groupKey(['outer', 'inner'])] });
  assert.deepEqual(inner.rows.map((row) => row.hidden), [false, false, true, false, false, false, false]);
  assert.equal(inner.rows[1].foldTitle, "Open 'inner'");
  assert.equal(grid(deep).rows[0].foldTitle, "Fold 'outer'");
});

test('groups nest ten levels deep without recursion; the level is the real depth and the deep mark starts at level five', () => {
  assert.equal(SONG_GRID_DEEP_FROM, 5);
  const names = Array.from({ length: 10 }, (_, i) => `g${i + 1}`);
  const nested = names.reduceRight((inner, name) => `{ ${name}: ${inner} }`, "['t1']");
  const model = grid({ groups: nested });
  const groups = model.rows.filter((row) => row.kind === 'group');
  assert.deepEqual(groups.map((row) => row.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(model.rows.find((row) => row.kind === 'track' && row.name === 't1').level, 11);
  assert.deepEqual(groups[9].path, names);
  assert.equal(groups[9].key, `g:${groupKey(names)}`);
  assert.equal(groupKey(['a', 'b"c']), '["a","b\\"c"]');
});

test('two entries with one section name are both columns, marked as sharing one plan cell', () => {
  const model = grid({
    sections: "[['x', 3, 'E3:minor'], ['y', 5], ['x', 3, 'E3:minor']]",
    plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' } }",
  });
  assert.equal(model.columns.length, 3);
  assert.deepEqual(model.columns.map((column) => column.uses), [2, 1, 2]);
  assert.deepEqual(model.columns[0].useColumns, [0, 2]);
  assert.equal(model.columns[0].usedText, 'used 2 times');
  assert.equal(model.columns[0].usedTitle, 'This section is used 2 times (columns 1, 3); its cells are shared.');
  assert.equal(model.columns[1].usedText, null);
  const t1 = model.rows.find((row) => row.name === 't1');
  assert.deepEqual(t1.cells.map((cell) => cell.shared), [true, false, true]);
});

test('names are exact strings: hidden characters become spaces, a long name is cut at 40 code points without splitting a pair, the whole name goes to the title', () => {
  const pair = '😀'.repeat(45);
  const model = grid({
    sections: `[['${pair}', 3], ['a b', 5]]`,
    plan: `{ '${pair}': { t1: 'va', t2: 'va', t3: 'va' }, 'a b': { t1: 'vb', t2: 'va', t3: '-' } }`,
  });
  const [long, plain] = model.columns;
  assert.equal([...long.text].length, 40);
  assert.equal(long.text, `${'😀'.repeat(39)}…`);
  assert.equal(long.title, pair);
  assert.equal(plain.title, null);
  const markup = '<img src=x onerror=alert(1)>';
  const hostile = grid({ groups: `{ '${markup}': ['t1'] }` });
  assert.equal(hostile.rows[0].text, markup, 'markup stays text; the view writes it through textContent');
  assert.equal(hostile.rows[0].title, null);
  const tabbed = grid({ sections: "[['a\\tb', 3], ['y', 5], ['z', 7]]", plan: "{ 'a\\tb': { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' }, z: { t1: 'va', t2: '-', t3: 'va' } }" });
  assert.equal(tabbed.columns[0].text, 'a b');
  assert.equal(tabbed.columns[0].name, 'a\tb', 'the name itself stays exact');
  assert.equal(tabbed.columns[0].title, null, 'the cleaned name is the whole text, so there is nothing more to say');
  assert.ok(grid({ groups: `{ '${'n'.repeat(60)}': ['t1'] }` }).rows[0].title.length === 60);
});

test('the playing section at a line is the one that starts there', () => {
  const reading = read(piece());
  assert.deepEqual(playingSection(reading, 0), { index: 0, cycleIn: 1, progress: 0 });
  assert.deepEqual(playingSection(reading, 2.5), { index: 0, cycleIn: 3, progress: 2.5 / 3 });
  assert.deepEqual(playingSection(reading, 3), { index: 1, cycleIn: 1, progress: 0 });
  assert.deepEqual(playingSection(reading, 8), { index: 2, cycleIn: 1, progress: 0 });
  assert.deepEqual(playingSection(reading, 14.5).index, 2);
  assert.deepEqual(playingSection(reading, 15), { index: 0, cycleIn: 1, progress: 0 }, 'the structure repeats');
  assert.deepEqual(playingSection(reading, 18), { index: 1, cycleIn: 1, progress: 0 });
});

test('a shift moves the sections: negative and fractional shifts keep the section lines where the clock puts them', () => {
  const shifted = read(piece({ shift: '4' }));
  assert.equal(playingSection(shifted, 4).index, 0);
  assert.equal(playingSection(shifted, 7).index, 1, 'section y starts at 4 + 3');
  assert.equal(playingSection(shifted, 3).index, 2, 'before the shift the structure wraps: the last cycle belongs to z');
  const negative = read(piece({ shift: '-2' }));
  assert.equal(playingSection(negative, 0).index, 0, 'cycle 0 is cycle 2 of x');
  assert.equal(playingSection(negative, 0).cycleIn, 3);
  assert.equal(playingSection(negative, 1).index, 1);
  const fractional = read(piece({ shift: '2.5' }));
  assert.deepEqual(playingSection(fractional, 2.5), { index: 0, cycleIn: 1, progress: 0 });
  assert.equal(playingSection(fractional, 5.5).index, 1);
  assert.equal(playingSection(fractional, 5.4999).index, 0);
});

test('a header is idle with its length and the word Launch, and the playing one says its position', () => {
  const column = grid().columns[1];
  const idle = headerLive({ column, playing: null, stopped: false, launchChoice: 'section', motion: 'on' });
  assert.deepEqual(idle, {
    state: 'idle',
    stateText: '5 cycles',
    action: 'Launch',
    title: 'Starts at the end of the section that plays. Click to queue it.',
    progress: 0,
  });
  assert.equal(headerLive({ column, playing: null, stopped: false, launchChoice: 'phrase', motion: 'on' }).title, 'Starts on the next phrase. Click to queue it.');
  assert.equal(headerLive({ column, playing: null, stopped: false, launchChoice: 'bar', motion: 'on' }).title, 'Starts on the next bar. Click to queue it.');
  const playing = headerLive({ column, playing: { index: 1, cycleIn: 3, progress: 0.5 }, stopped: false, launchChoice: 'section', motion: 'on' });
  assert.deepEqual(playing, { state: 'playing', stateText: 'Playing 3/5', action: '', title: 'Playing, cycle 3 of 5', progress: 0.5 });
  const other = headerLive({ column: grid().columns[0], playing: { index: 1, cycleIn: 3, progress: 0.5 }, stopped: false, launchChoice: 'section', motion: 'on' });
  assert.equal(other.state, 'idle');
});

test('a queued header says Queued with the countdown and the word Cancel, and names the line it takes over on', () => {
  const [x, y] = grid().columns;
  const queued = { index: 1, countdownText: 'in 3 bars', line: 18 };
  const header = headerLive({ column: y, playing: { index: 0, cycleIn: 2, progress: 0.4 }, stopped: false, launchChoice: 'section', motion: 'on', queued });
  assert.deepEqual(header, { state: 'queued', stateText: 'Queued — in 3 bars', action: 'Cancel', title: 'Queued. Click to cancel.', progress: 0, line: 18 });
  const playingHeader = headerLive({ column: x, playing: { index: 0, cycleIn: 2, progress: 0.4 }, stopped: false, launchChoice: 'section', motion: 'on', queued });
  assert.equal(playingHeader.state, 'playing', 'the section that plays stays playing while another one is queued');
  assert.equal(playingHeader.line, undefined);
  const relaunch = headerLive({ column: x, playing: { index: 0, cycleIn: 2, progress: 0.4 }, stopped: false, launchChoice: 'section', motion: 'on', queued: { ...queued, index: 0 } });
  assert.equal(relaunch.state, 'queued', 'a launch of the section that plays is queued too, and can be canceled');
  assert.equal(headerLive({ column: y, playing: null, stopped: false, launchChoice: 'bar', motion: 'on', queued: null }).state, 'idle');
  assert.equal(headerLive({ column: y, playing: null, stopped: false, launchChoice: 'bar', motion: 'on' }).state, 'idle', 'queued is optional');
  assert.equal(headerLive({ column: y, playing: null, stopped: false, launchChoice: 'bar', motion: 'on', queued: { index: 1, countdownText: 'in 1 beat', line: 4 } }).stateText, 'Queued — in 1 beat');
});

test('while stopped every header is idle with the stopped title, and motion off steps the progress to whole cycles', () => {
  const [x, y] = grid().columns;
  const stopped = headerLive({ column: y, playing: { index: 1, cycleIn: 3, progress: 0.5 }, stopped: true, launchChoice: 'bar', motion: 'on' });
  assert.equal(stopped.state, 'idle');
  assert.equal(stopped.title, 'Starts the piece at this section.');
  assert.equal(stopped.progress, 0);
  const stepped = headerLive({ column: y, playing: { index: 1, cycleIn: 3, progress: 0.55 }, stopped: false, launchChoice: 'section', motion: 'off' });
  assert.equal(stepped.progress, 0.4, 'floor(0.55 * 5) / 5');
  assert.equal(headerLive({ column: x, playing: { index: 0, cycleIn: 1, progress: 0.2 }, stopped: false, launchChoice: 'section', motion: 'on' }).progress, 0.2);
  assert.throws(() => headerLive({ column: y, playing: null, stopped: false, launchChoice: 'later', motion: 'on' }), /unknown launch choice/);
  assert.throws(() => buildSongGrid({ reading: read(piece()), folds: new Set(), launchChoice: 'later' }), /unknown launch choice/);
});

test('the sentence under the toolbar names the section and the cycle, and there is none while nothing plays', () => {
  const reading = read(piece());
  assert.equal(nowText(reading, { index: 1, cycleIn: 3, progress: 0.4 }), "Playing section 'y', cycle 3 of 5.");
  assert.equal(nowText(reading, null), null);
});

test('the line under the toolbar is the first sentence that applies, in a fixed order', () => {
  const queued = { kind: 'queued', section: 'y' };
  const all = { connected: false, launch: queued, waiting: true, dirty: true, refused: 'not-evaluated' };
  assert.deepEqual(songLine(all), { kind: 'disconnected', text: 'Disconnected — the grid is off until Moontide reconnects.' });
  assert.deepEqual(songLine({ ...all, connected: true }), { kind: 'queued', text: "Section 'y' is queued — cells can't change until it starts. Click it again to cancel." });
  assert.deepEqual(songLine({ ...all, connected: true, launch: { kind: 'already', section: 'y' } }), {
    kind: 'already',
    text: "Section 'y' already starts on that line, so the code stays as it is. Click it again to hide the countdown.",
  });
  assert.deepEqual(songLine({ ...all, connected: true, launch: null }), { kind: 'waiting', text: 'A change is waiting for its bar line. The grid works again when it takes over.' });
  assert.deepEqual(songLine({ ...all, connected: true, launch: null, waiting: false }), {
    kind: 'dirty',
    text: 'The editor has changes that are not playing yet. Evaluate them first — the grid works on the playing code.',
  });
  assert.deepEqual(songLine({ ...all, connected: true, launch: null, waiting: false, dirty: false }), { kind: 'refused', text: 'The change did not evaluate, so the code is as it was.' });
  assert.equal(songLine({ connected: true }), null);
  assert.equal(songLine({ connected: true, launch: null, waiting: false, dirty: false, refused: null }), null);
});

test('every refusal has one plain sentence, a section name is quoted and cut, and an unknown id throws', () => {
  const connected = { connected: true };
  assert.equal(songLine({ ...connected, refused: 'section-gone' }).text, 'That section changed in the code since you clicked. Nothing was changed.');
  assert.equal(songLine({ ...connected, refused: 'not-evaluated' }).text, 'The change did not evaluate, so the code is as it was.');
  assert.equal(songLine({ ...connected, refused: 'line-moved' }).text, 'The launch could not be placed on its line, so nothing changed.');
  assert.equal(songLine({ ...connected, refused: 'not-written' }).text, 'The page could not write that change into the editor, so the code is as it was.');
  for (const id of SONG_REFUSALS) assert.equal(songLine({ ...connected, refused: id }).kind, 'refused', id);
  const long = 'n'.repeat(50);
  assert.equal(songLine({ ...connected, launch: { kind: 'queued', section: long } }).text, `Section '${'n'.repeat(39)}…' is queued — cells can't change until it starts. Click it again to cancel.`);
  assert.throws(() => songLine({ ...connected, refused: 'bad-luck' }), /^Error: Moontide: unknown song refusal 'bad-luck'/);
  assert.throws(() => songLine({ connected: false, refused: 'bad-luck' }), /^Error: Moontide: unknown song refusal/, 'even when a higher sentence applies');
  assert.throws(() => songLine({ ...connected, launch: { kind: 'soon', section: 'y' } }), /^Error: Moontide: unknown launch line 'soon'/);
});

test('the line switches off what it names: headers and cells, cells only while our launch is queued, or nothing', () => {
  assert.deepEqual(controlsDisabled('disconnected'), { headers: true, cells: true });
  assert.deepEqual(controlsDisabled('waiting'), { headers: true, cells: true });
  assert.deepEqual(controlsDisabled('dirty'), { headers: true, cells: true });
  assert.deepEqual(controlsDisabled('queued'), { headers: false, cells: true });
  assert.deepEqual(controlsDisabled('already'), { headers: false, cells: false });
  assert.deepEqual(controlsDisabled('refused'), { headers: false, cells: false });
  assert.deepEqual(controlsDisabled(null), { headers: false, cells: false });
  assert.deepEqual(controlsDisabled(undefined), { headers: false, cells: false });
  assert.throws(() => controlsDisabled('later'), /^Error: Moontide: unknown song line kind 'later'/);
});

test('only a read song builds a grid', () => {
  assert.throws(() => buildSongGrid({ reading: { state: 'none' }, folds: new Set(), launchChoice: 'section' }), /needs a read song/);
  assert.equal(SONG_COPY.viewTitle, 'Song');
});

test('the model source has no DOM access and no recursion into groups', () => {
  const code = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\bdocument\b|\bwindow\b|innerHTML|outerHTML|insertAdjacentHTML/);
});

test('the launch options are the three choices in order, with the words and the accessible names of the toolbar', () => {
  assert.deepEqual(launchOptions(), [
    { value: 'section', label: 'end of section', name: 'Sections start at the end of the section that plays' },
    { value: 'phrase', label: 'next phrase', name: 'Sections start on the next phrase' },
    { value: 'bar', label: 'next bar', name: 'Sections start on the next bar' },
  ]);
});

// The layout lists, for every visible row, the columns that hold a control: the header row first (columns 1 to 3), a group
// row holds only its fold button (column 0), a track row one cell per section, and a row with no control is empty.
const LAYOUT = [[1, 2, 3], [0], [1, 2, 3], [1, 2, 3], [0], [], [1, 2, 3]];
const move = (row, column, key, ctrl = false) => gridMove(LAYOUT, { row, column }, key, { ctrl });

test('Left and Right stay in the row and never go past its first or last control', () => {
  assert.deepEqual(move(2, 2, 'ArrowRight'), { row: 2, column: 3 });
  assert.deepEqual(move(2, 2, 'ArrowLeft'), { row: 2, column: 1 });
  assert.equal(move(2, 3, 'ArrowRight'), null);
  assert.equal(move(2, 1, 'ArrowLeft'), null);
  assert.equal(move(1, 0, 'ArrowRight'), null, 'a group row holds only its fold button, so Right goes nowhere');
  assert.equal(move(1, 0, 'ArrowLeft'), null);
});

test('Up and Down go to the neighbour control: the same column, else the nearest, and a track row is entered at its first cell', () => {
  assert.deepEqual(move(0, 2, 'ArrowDown'), { row: 1, column: 0 }, 'from a header to a group row: its only control');
  assert.deepEqual(move(1, 0, 'ArrowDown'), { row: 2, column: 1 }, 'from a group row into a track row: its first cell');
  assert.deepEqual(move(2, 3, 'ArrowDown'), { row: 3, column: 3 });
  assert.deepEqual(move(3, 2, 'ArrowUp'), { row: 2, column: 2 });
  assert.deepEqual(move(2, 1, 'ArrowUp'), { row: 1, column: 0 });
  assert.deepEqual(move(4, 0, 'ArrowDown'), { row: 6, column: 1 }, 'a row with no control is skipped');
  assert.deepEqual(move(6, 3, 'ArrowUp'), { row: 4, column: 0 });
  assert.equal(move(0, 1, 'ArrowUp'), null);
  assert.equal(move(6, 2, 'ArrowDown'), null);
});

test('Home and End go to the first and last control of the row, Ctrl+Home and Ctrl+End to those of the grid', () => {
  assert.deepEqual(move(2, 2, 'Home'), { row: 2, column: 1 });
  assert.deepEqual(move(2, 2, 'End'), { row: 2, column: 3 });
  assert.deepEqual(move(1, 0, 'End'), { row: 1, column: 0 });
  assert.deepEqual(move(3, 2, 'Home', true), { row: 0, column: 1 });
  assert.deepEqual(move(3, 2, 'End', true), { row: 6, column: 3 });
  assert.deepEqual(gridMove([[], [2, 4]], { row: 1, column: 4 }, 'Home', { ctrl: true }), { row: 1, column: 2 }, 'a leading row without a control is skipped');
});

test('a key the grid does not move with gives nothing, and so does a position that holds no control', () => {
  for (const key of ['a', 'Enter', ' ', 'PageDown', 'Tab', 'Escape']) assert.equal(move(2, 2, key), null, key);
  assert.equal(move(2, 0, 'ArrowRight'), null, 'column 0 holds no control in a track row');
  assert.equal(move(5, 1, 'ArrowDown'), null, 'a row without a control holds no focus');
  assert.equal(gridMove([[], []], { row: 0, column: 1 }, 'Home', { ctrl: true }), null);
});

// ---- the list on a cell, the waiting cell and the history label ----

test('cellList: every variation in code order (unused ones too), the current one marked, rest last', () => {
  const reading = read(piece({ tracks: DEFAULTS.tracks.replace("vb: note('d3') }", "vb: note('d3'), vc: note('e3') }") }));
  const list = cellList({ reading, trackName: 't1', sectionIndex: 1 });
  assert.equal(list.label, "Variation for 't1' in section 'y'");
  assert.equal(list.note, null);
  assert.equal(list.currentText, 'current');
  assert.deepEqual(list.options.map((o) => [o.key, o.rest, o.text, o.current]), [
    ['va', false, 'va', false],
    ['vb', false, 'vb', true],
    ['vc', false, 'vc', false],
    [null, true, 'rest', false],
  ]);
  assert.equal(new Set(list.options.map((o) => o.id)).size, 4);
  const rest = cellList({ reading, trackName: 't3', sectionIndex: 1 });
  assert.deepEqual(rest.options.map((o) => o.current), [false, true], 'a rest cell has the rest option current');
});

test('cellList: a degree variation is noted "follows the harmony", a plain one has no note, a fixed one none while its fit is pending', () => {
  const reading = read(piece());
  assert.deepEqual(cellList({ reading, trackName: 't2', sectionIndex: 0 }).options.map((o) => o.note), ['follows the harmony', null]);
  assert.deepEqual(cellList({ reading, trackName: 't1', sectionIndex: 0 }).options.map((o) => o.note), [null, null, null]);
  assert.deepEqual(cellList({ reading, trackName: 't3', sectionIndex: 0 }).options.map((o) => o.note), [null, null]);
});

test('cellList: the shared note shows only for a section name used more than once', () => {
  const twice = read(piece({ sections: "[['x', 3], ['y', 5], ['x', 3]]", plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' } }" }));
  assert.equal(cellList({ reading: twice, trackName: 't1', sectionIndex: 2 }).note, "Section 'x' is used 2 times; the change applies to each use.");
  assert.equal(cellList({ reading: twice, trackName: 't1', sectionIndex: 0 }).note, "Section 'x' is used 2 times; the change applies to each use.");
  assert.equal(cellList({ reading: twice, trackName: 't1', sectionIndex: 1 }).note, null);
});

test('cellList: a cut name keeps its whole text in a title, and a cell the song does not have is a loud error', () => {
  const long = 'v'.repeat(60);
  const reading = read(piece({ tracks: DEFAULTS.tracks.replace("vb: note('d3')", `vb: note('d3'), '${long}': note('e3')`) }));
  const options = cellList({ reading, trackName: 't1', sectionIndex: 0 }).options;
  assert.equal(options[2].text.length, 40);
  assert.equal(options[2].title, long);
  assert.equal(options[0].title, null);
  assert.throws(() => cellList({ reading, trackName: 'nope', sectionIndex: 0 }), /^Error: Moontide: /);
  assert.throws(() => cellList({ reading, trackName: 't1', sectionIndex: 9 }), /^Error: Moontide: /);
});

test('the grid model hands out the list of a cell from the reading it was built from', () => {
  const model = grid();
  assert.equal(model.listFor('t1', 1).label, "Variation for 't1' in section 'y'");
});

test('cellRecordLabel: changed {track} in {section}: {variation}, or rest', () => {
  assert.equal(cellRecordLabel({ track: 'bass', section: 'verse', choice: { key: 'vb' } }), 'changed bass in verse: vb');
  assert.equal(cellRecordLabel({ track: 'bass', section: 'verse', choice: { rest: true } }), 'changed bass in verse: rest');
  assert.equal(cellRecordLabel({ track: 'ba\nss', section: 'v', choice: { key: 'a' } }), 'changed ba ss in v: a', 'a hidden character is a space');
});

test('listPlacement: below the cell, above it when the room below is short, the larger side when neither holds it, and always in the window', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 100 };
  assert.deepEqual(listPlacement({ cell: { left: 300, top: 100, bottom: 150 }, size, viewport }), { left: 300, top: 150, maxHeight: null, above: false });
  assert.deepEqual(listPlacement({ cell: { left: 300, top: 700, bottom: 750 }, size, viewport }), { left: 300, top: 600, maxHeight: null, above: true });
  assert.equal(listPlacement({ cell: { left: 900, top: 100, bottom: 150 }, size, viewport }).left, 800, 'kept inside on the right');
  assert.equal(listPlacement({ cell: { left: -40, top: 100, bottom: 150 }, size, viewport }).left, 0, 'and on the left');
  const tall = { width: 200, height: 500 };
  assert.deepEqual(listPlacement({ cell: { left: 0, top: 300, bottom: 350 }, size: tall, viewport }), { left: 0, top: 350, maxHeight: 450, above: false });
  assert.deepEqual(listPlacement({ cell: { left: 0, top: 480, bottom: 530 }, size: tall, viewport }), { left: 0, top: 0, maxHeight: 480, above: true });
  const scrolledOff = listPlacement({ cell: { left: 0, top: -200, bottom: -150 }, size, viewport });
  assert.ok(scrolledOff.top >= 0 && scrolledOff.top + 100 <= 800, 'a cell scrolled out of the window still gets a list inside it');
});

test('a cell whose change waits shows the new name and the waiting words in every column of its section, and nowhere else', () => {
  const reading = read(piece({ sections: "[['x', 3], ['y', 5], ['x', 3]]", plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' } }" }));
  const folds = new Set();
  const cells = (model, track) => model.rows.find((row) => row.name === track).cells.map((cell) => [cell.text, cell.wait, cell.kind]);
  const plain = buildSongGrid({ reading, folds, launchChoice: 'section' });
  assert.deepEqual(cells(plain, 't1'), [['va', null, 'other'], ['vb', null, 'other'], ['va', null, 'other']]);
  const waiting = buildSongGrid({ reading, folds, launchChoice: 'section', cellWaiting: { track: 't1', section: 'x', choice: { key: 'vb' }, at: 'bar' } });
  assert.deepEqual(cells(waiting, 't1'), [['vb', 'waiting for the next bar', 'other'], ['vb', null, 'other'], ['vb', 'waiting for the next bar', 'other']]);
  assert.deepEqual(cells(waiting, 't2'), cells(plain, 't2'), 'another track is untouched');
  const phrase = buildSongGrid({ reading, folds, launchChoice: 'section', cellWaiting: { track: 't1', section: 'y', choice: { rest: true }, at: 'phrase' } });
  assert.deepEqual(cells(phrase, 't1'), [['va', null, 'other'], ['rest', 'waiting for the next phrase', 'rest'], ['va', null, 'other']]);
  const degrees = buildSongGrid({ reading, folds, launchChoice: 'section', cellWaiting: { track: 't2', section: 'y', choice: { key: 'va' }, at: 'bar' } });
  assert.equal(degrees.rows.find((row) => row.name === 't2').cells[1].kind, 'degrees', 'the kind and title follow the chosen variation');
  assert.throws(() => buildSongGrid({ reading, folds, launchChoice: 'section', cellWaiting: { track: 't1', section: 'x', choice: { key: 'vb' }, at: 'now' } }), /^Error: Moontide: /);
  assert.throws(() => buildSongGrid({ reading, folds, launchChoice: 'section', cellWaiting: { track: 't1', section: 'x', choice: { key: 'gone' }, at: 'bar' } }), /^Error: Moontide: /);
});

test('the new refusal sentences are in the copy, one line each, and a cell change that waits makes the line "waiting"', () => {
  for (const id of ['cell-gone', 'variation-gone', 'name-unwritable']) assert.ok(SONG_REFUSALS.includes(id), id);
  assert.equal(SONG_COPY.refusals['cell-gone'], 'That cell changed in the code since you clicked. Nothing was changed.');
  assert.equal(SONG_COPY.refusals['variation-gone'], 'That variation is no longer in the code. Nothing was changed.');
  assert.equal(SONG_COPY.refusals['name-unwritable'], "That variation's name cannot be written into the plan as it is. Nothing was changed.");
  const line = songLine({ connected: true, launch: null, waiting: true, dirty: false, refused: null });
  assert.equal(line.kind, 'waiting');
  assert.deepEqual(controlsDisabled(line.kind), { headers: true, cells: true });
});

test('sectionDeclared: a section\'s own harmony, the piece\'s, none, and the unreadable piece harmony as the Jam reading has it', () => {
  const song = read(piece());
  assert.deepEqual(sectionDeclared(song.sections[0], { state: 'none' }), {
    state: 'declared',
    kind: 'scale',
    scale: { rootPc: 4, modeId: 'aeolian' },
    text: 'E3:minor',
  });
  assert.deepEqual(sectionDeclared(song.sections[1], { state: 'none' }), {
    state: 'declared',
    kind: 'scale',
    scale: { rootPc: 0, modeId: 'ionian' },
    text: 'C3:major',
  });
  const bare = read(piece({ harmony: '', tracks: "const t1 = { va: note('c3'), vb: note('d3') };\nconst t2 = { va: note('e3') };\nconst t3 = { va: ['D3:dorian', note('e3')] };" }));
  assert.deepEqual(sectionDeclared(bare.sections[1], { state: 'none' }), { state: 'none' });
  const unreadable = read(piece({ harmony: "const harmony = 'banana';" }));
  const jamSays = { state: 'unreadable', reason: 'not-a-harmony', source: "'banana'" };
  assert.equal(sectionDeclared(unreadable.sections[1], jamSays), jamSays);
  assert.equal(sectionDeclared(unreadable.sections[0], jamSays).text, 'E3:minor', 'a section with its own readable harmony does not take the unreadable one');
});

test('cellList: a fixed option carries the fit words of the section being edited, a degree option keeps its words, a plain one none', () => {
  const reading = read(
    piece({
      tracks: DEFAULTS.tracks.replace("const t3 = { va: ['D3:dorian', note('e3')] };", "const t3 = { va: ['D3:dorian', note('e3')], vf: ['E3:minor', note('g3')], vp: note('a3') };"),
    }),
  );
  const asked = [];
  const fit = (track, section, key) => {
    asked.push([track, section, key]);
    return { line: `words for ${key} in ${section}` };
  };
  const list = cellList({ reading, trackName: 't3', sectionIndex: 0, fit });
  assert.deepEqual(list.options.map((o) => o.note), ['words for va in 0', 'words for vf in 0', null, null]);
  assert.deepEqual(asked, [['t3', 0, 'va'], ['t3', 0, 'vf']], 'only the fixed variations are asked about, for the section being edited');
  assert.deepEqual(cellList({ reading, trackName: 't2', sectionIndex: 1, fit }).options.map((o) => o.note), ['follows the harmony', null]);
  // A lookup that has nothing for a fixed variation gives it no note.
  assert.deepEqual(cellList({ reading, trackName: 't3', sectionIndex: 0, fit: () => null }).options.map((o) => o.note), [null, null, null, null]);
});

test('the grid model asks the fit of each fixed cell in its own section, for the cell title and the second line, and not while a change waits', () => {
  const reading = read(piece());
  const asked = [];
  const fit = (track, section, key) => {
    asked.push([track, section, key]);
    return { state: 'fits', line: 'fits', title: `title of ${key} in ${section}`, outsideText: null };
  };
  const model = buildSongGrid({ reading, folds: new Set(), launchChoice: 'section', fit });
  assert.deepEqual(asked, [['t3', 0, 'va'], ['t3', 2, 'va']], 'only the fixed cells, one question per cell');
  const cells = model.rows.find((row) => row.name === 't3').cells;
  assert.deepEqual(cells.map((cell) => [cell.fit, cell.title]), [
    [{ state: 'fits', line: 'fits', outside: null }, 'title of va in 0'],
    [null, "'t3', section 'y': rest. Click to change."],
    [{ state: 'fits', line: 'fits', outside: null }, 'title of va in 2'],
  ]);
  asked.length = 0;
  const waiting = buildSongGrid({ reading, folds: new Set(), launchChoice: 'section', fit, cellWaiting: { track: 't3', section: 'x', choice: { key: 'va' }, at: 'bar' } });
  const waited = waiting.rows.find((row) => row.name === 't3').cells[0];
  assert.equal(waited.fit, null, 'a cell whose change waits shows the waiting words, not a fit line');
  assert.equal(waited.wait, 'waiting for the next bar');
});
