// The Song grid's DOM code, tested without a browser against a small fake document that supports attributes, children,
// listeners and focus. The live grid in real Chrome is proved by `npm run probe:page`; these tests pin the structure and
// ARIA, that text from the code stays text, the loud failure of a gesture without a handler, the write-on-change tick and
// what a rebuild keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { HELPER_TEXT, readStructure } from '../page/structure.js';
import { buildSongGrid, groupKey, playingSection } from '../page/song-grid-model.js';
import { createSongGridView } from '../page/song-grid-view.js';
import { fitLookup, pairKey } from '../page/song-fit.js';
import { all, fakeDocument, fakeNode } from './fake-document.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../page/song-grid-view.js', import.meta.url)), 'utf8');
const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

const HEAD = ["const harmony = 'C3:major';"];
function code({ sections = "[['x', 3, 'E3:minor'], ['y', 5], ['z', 7]]", groups = "{ g1: ['t1', 't2'], g2: { g3: ['t3'] } }", plan, statements } = {}) {
  return [
    ...HEAD,
    `const song = { shift: 0, sections: ${sections}, ${groups === null ? '' : `groups: ${groups}, `}plan: ${plan ?? "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' }, z: { t1: 'va', t2: '-', t3: 'va' } }"} };`,
    HELPER_TEXT,
    "const t1 = { va: note('c3'), vb: note('d3') };",
    "const t2 = { va: (h) => n('0 2').scale(h) };",
    "const t3 = { va: ['D3:dorian', note('e3')] };",
    statements ?? "t1: play('t1', t1)\nt2: play('t2', t2)\nt3: play('t3', t3)",
  ].join('\n');
}

function setup(options = {}, handlers = {}) {
  const document = fakeDocument();
  const rows = fakeNode('div', document);
  const bar = fakeNode('div', document);
  bar.hidden = true;
  const now = fakeNode('p', document);
  now.hidden = true;
  const line = fakeNode('p', document);
  line.hidden = true;
  const launchGroup = fakeNode('div', document);
  const list = fakeNode('div', document);
  list.hidden = true;
  const view = createSongGridView({ document, rows, bar, now, line, launchGroup, list, handlers });
  const reading = read(code(options));
  const build = (over = {}) => buildSongGrid({ reading, folds: new Set(), launchChoice: 'section', ...over });
  return { document, rows, bar, now, line, launchGroup, list, view, reading, build };
}

test('a grid is a table with a colgroup, a header row of buttons and a body row per group and track, inside one scroller', () => {
  const { rows, view, build } = setup();
  view.render(build());
  assert.equal(rows.getAttribute('data-view'), 'song');
  assert.equal(rows.children.length, 1);
  const [scroller] = rows.children;
  assert.equal(scroller.className, 'song-grid-scroll');
  const [table] = scroller.children;
  assert.equal(table.tagName, 'table');
  assert.equal(table.className, 'song-grid');
  assert.equal(table.getAttribute('role'), 'grid');
  assert.equal(table.getAttribute('aria-label'), 'Song');
  assert.equal(table.style.props.get('--song-columns'), '3');
  const [colgroup, thead, tbody] = table.children;
  assert.deepEqual(colgroup.children.map((col) => col.className), ['song-col-name', '', '', '']);
  const [headRow] = thead.children;
  assert.equal(headRow.children[0].className, 'song-corner');
  assert.equal(headRow.children[0].textContent, '3 sections, 15 cycles');
  const heads = headRow.children.slice(1);
  assert.deepEqual(heads.map((th) => [th.className, th.getAttribute('scope')]), Array(3).fill(['song-colhead', 'col']));
  const buttons = heads.map((th) => th.children[0]);
  assert.ok(buttons.every((button) => button.tagName === 'button' && button.className === 'part-card song-head'));
  assert.deepEqual(buttons.map((button) => button.getAttribute('data-part')), ['x', 'y', 'z']);
  assert.deepEqual(buttons.map((button) => button.getAttribute('data-index')), ['0', '1', '2']);
  assert.deepEqual(buttons.map((button) => button.getAttribute('data-state')), ['idle', 'idle', 'idle']);
  assert.deepEqual(buttons[0].children.map((child) => child.className), ['part-name', 'song-head-line', 'song-harmony', 'part-progress']);
  assert.deepEqual(all(buttons[1], 'song-harmony').map((node) => node.textContent), ['harmony C3:major (from the piece)']);
  assert.equal(tbody.children.length, 6);
  const group = tbody.children[0];
  assert.equal(group.className, 'song-group-row');
  assert.equal(group.getAttribute('aria-level'), '1');
  assert.equal(group.children[0].getAttribute('scope'), 'row');
  assert.equal(group.children[1].getAttribute('colspan'), '3');
  const track = tbody.children[1];
  assert.equal(track.className, 'song-track-row');
  assert.equal(track.getAttribute('aria-level'), '2');
  assert.equal(track.children[0].textContent, 't1');
  assert.equal(track.children.length, 4, 'a name and one cell per section');
  assert.deepEqual(all(track, 'song-cell').map((cell) => [cell.getAttribute('data-track'), cell.getAttribute('data-section'), cell.getAttribute('data-kind'), cell.textContent]), [
    ['t1', '0', 'other', 'va'],
    ['t1', '1', 'other', 'vb'],
    ['t1', '2', 'other', 'va'],
  ]);
});

test('group rows have a fold button with the chevron, the name and the count; a group nested ten levels keeps its real aria-level and a capped indent', () => {
  const names = Array.from({ length: 10 }, (_, i) => `g${i + 1}`);
  const nested = names.reduceRight((inner, name) => `{ ${name}: ${inner} }`, "['t1']");
  const { rows, view, build } = setup({ groups: nested });
  view.render(build());
  const folds = all(rows, 'song-fold');
  assert.equal(folds.length, 10);
  assert.deepEqual(folds[0].children.map((child) => [child.className, child.textContent]), [['song-chevron', '▾'], ['song-fold-name', 'g1'], ['song-count', '1 track']]);
  assert.equal(folds[0].children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(folds[0].getAttribute('aria-expanded'), 'true');
  assert.equal(folds[0].getAttribute('title'), "Fold 'g1'");
  const groupRows = all(rows, 'song-group-row');
  assert.deepEqual(groupRows.map((row) => row.getAttribute('aria-level')), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  const heads = groupRows.map((row) => row.children[0]);
  assert.deepEqual(heads.map((head) => head.style.props.get('--depth')), ['0', '1', '2', '3', '4', '4', '4', '4', '4', '4']);
  assert.deepEqual(heads.map((head) => head.getAttribute('data-deep')), [null, null, null, null, 'true', 'true', 'true', 'true', 'true', 'true']);
  const track = all(rows, 'song-track-row')[0];
  assert.equal(track.getAttribute('aria-level'), '11');
});

test('a folded group is drawn open-or-closed from the model: hidden rows, the closed chevron and aria-expanded', () => {
  const { rows, view, build } = setup();
  view.render(build({ folds: new Set([groupKey(['g1'])]) }));
  const tbodyRows = all(rows, 'song-group-row').concat(all(rows, 'song-track-row'));
  const hidden = tbodyRows.filter((row) => row.getAttribute('hidden') !== null).map((row) => row.getAttribute('data-key'));
  assert.deepEqual(hidden.sort(), ['t:t1', 't:t2']);
  const fold = all(rows, 'song-fold')[0];
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(fold.children[0].textContent, '▸');
  assert.equal(fold.getAttribute('title'), "Open 'g1'");
});

test('a statement outside the song plan is a row with its name and the plain words', () => {
  const { rows, view, build } = setup({ groups: null, statements: "t1: play('t1', t1)\nextra: note('c4')\nt2: play('t2', t2)\nt3: play('t3', t3)" });
  view.render(build());
  const [outside] = all(rows, 'song-outside-row');
  assert.equal(outside.children[0].textContent, 'extra');
  assert.equal(outside.children[1].textContent, 'outside the song plan: plays in every section');
  assert.equal(outside.children[1].getAttribute('colspan'), '3');
});

test('names, harmonies and counts stay text: markup from the code never becomes an element', () => {
  const markup = '<img src=x onerror=alert(1)>';
  const { rows, view, build } = setup({
    sections: `[['${markup}', 3, 'E3:minor'], ['y', 5], ['z', 7]]`,
    plan: `{ '${markup}': { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' }, z: { t1: 'va', t2: '-', t3: 'va' } }`,
    groups: `{ '${markup}': ['t1'] }`,
  });
  view.render(build());
  const [name] = all(rows, 'part-name');
  assert.equal(name.textContent, markup);
  assert.equal(name.children.length, 0);
  assert.equal(all(rows, 'song-head')[0].getAttribute('data-part'), markup);
  assert.equal(all(rows, 'song-fold-name')[0].textContent, markup);
  const tags = new Set();
  const walk = (node) => {
    tags.add(node.tagName);
    node.children.forEach(walk);
  };
  walk(rows);
  assert.deepEqual([...tags].sort(), ['button', 'col', 'colgroup', 'div', 'span', 'table', 'tbody', 'td', 'th', 'thead', 'tr']);
});

test('a long section name and a long group name keep their whole text in a title; a name that fits has none', () => {
  const long = 'n'.repeat(60);
  const { rows, view, build } = setup({
    sections: `[['${long}', 3], ['y', 5], ['z', 7]]`,
    plan: `{ '${long}': { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' }, z: { t1: 'va', t2: '-', t3: 'va' } }`,
  });
  view.render(build());
  const names = all(rows, 'part-name');
  assert.equal(names[0].textContent, `${'n'.repeat(39)}…`);
  assert.equal(names[0].getAttribute('title'), long);
  assert.equal(names[1].getAttribute('title'), null);
});

test('two entries with one section name each carry the used words and a title naming every column', () => {
  const { rows, view, build } = setup({
    sections: "[['x', 3, 'E3:minor'], ['y', 5], ['x', 3, 'E3:minor']]",
    plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' } }",
  });
  view.render(build());
  const used = all(rows, 'song-used');
  assert.deepEqual(used.map((node) => node.textContent), ['used 2 times', 'used 2 times']);
  assert.equal(used[0].getAttribute('title'), 'This section is used 2 times (columns 1, 3); its cells are shared.');
});

test('a gesture whose handler is missing throws loudly, and a gesture with one calls it', () => {
  const calls = [];
  const { rows, view, build } = setup({}, { fold: (key) => calls.push(['fold', key]) });
  view.render(build());
  const [table] = rows.children[0].children;
  const head = all(rows, 'song-head')[1];
  assert.throws(() => table.dispatch('click', { target: head.children[0] }), /Moontide: the song grid has no handler for 'launch'\./);
  const cell = all(rows, 'song-cell')[0];
  assert.throws(() => table.dispatch('click', { target: cell.children[0] }), /no handler for 'choose'/);
  table.dispatch('click', { target: all(rows, 'song-fold')[0].children[1] });
  assert.deepEqual(calls, [['fold', '["g1"]']]);
  table.dispatch('click', { target: rows });
  assert.equal(calls.length, 1, 'a click outside every control does nothing');
});

test('hide() takes the grid away and leaves no data-view; with nothing drawn it touches nothing', () => {
  const { rows, view, build } = setup();
  const before = rows.replaced;
  view.hide();
  assert.equal(rows.replaced, before, 'nothing drawn, nothing touched');
  view.render(build());
  assert.equal(rows.getAttribute('data-view'), 'song');
  view.hide();
  assert.equal(rows.getAttribute('data-view'), null);
  assert.equal(rows.children.length, 0);
});

test('showing a grid again replaces the previous one with one replaceChildren', () => {
  const { rows, view, build } = setup();
  view.render(build());
  const first = rows.replaced;
  view.render(build({ launchChoice: 'bar' }));
  assert.equal(rows.replaced, first + 1);
  assert.equal(rows.children.length, 1);
});

test('the view source builds text only: no HTML string parsing, no document.write', () => {
  const code = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
});

// Kept in step with the live checks of the model: a tick of one state, twice.
test('the playing state is read from the live state: tick sets the header state, the progress and the one washed column', () => {
  const { rows, view, build, reading } = setup();
  view.render(build());
  const [heads, cols] = [all(rows, 'song-head'), rows.children[0].children[0].children[0].children.slice(1)];
  const playing = playingSection(reading, 4);
  view.tick({ playing, stopped: false, motion: 'on' });
  assert.deepEqual(heads.map((head) => head.getAttribute('data-state')), ['idle', 'playing', 'idle']);
  assert.equal(all(heads[1], 'part-state')[0].textContent, 'Playing 2/5');
  assert.equal(all(heads[1], 'part-progress-fill')[0].style.width, '20%');
  assert.deepEqual(cols.map((col) => col.getAttribute('data-playing')), [null, 'true', null]);
  assert.equal(all(heads[0], 'part-state')[0].textContent, '3 cycles');
  assert.equal(all(heads[0], 'song-head-action')[0].textContent, 'Launch');
  assert.equal(all(heads[1], 'song-head-action')[0].getAttribute('hidden'), '');
  assert.equal(heads[0].getAttribute('title'), 'Starts at the end of the section that plays. Click to queue it.');
  view.tick({ playing: playingSection(reading, 9), stopped: false, motion: 'on' });
  assert.deepEqual(cols.map((col) => col.getAttribute('data-playing')), [null, null, 'true'], 'the wash moves from one column to the other');
  view.tick({ playing: null, stopped: true, motion: 'on' });
  assert.deepEqual(cols.map((col) => col.getAttribute('data-playing')), [null, null, null]);
  assert.equal(heads[2].getAttribute('title'), 'Starts the piece at this section.');
  assert.equal(all(heads[2], 'song-head-action')[0].getAttribute('hidden'), null);
});

test('a second tick with the same state writes no node, and a change of one section touches only what changed', () => {
  const { document, view, build, reading } = setup();
  view.render(build());
  const live = { playing: playingSection(reading, 4), stopped: false, motion: 'on' };
  view.tick(live);
  const writes = document.writes;
  view.tick({ ...live, playing: playingSection(reading, 4) });
  assert.equal(document.writes, writes, 'the same state changes no node');
  view.tick({ ...live, playing: playingSection(reading, 4.1) });
  assert.equal(document.writes, writes, 'a fraction of a cycle changes no text or attribute (the width is a style)');
  view.tick({ ...live, playing: playingSection(reading, 5) });
  assert.ok(document.writes > writes, 'the next cycle changes the position text');
});

test('a queued header shows the countdown, the word Cancel and its line, and the tick writes only what changed', () => {
  const { document, rows, view, build, reading } = setup();
  view.render(build());
  const heads = all(rows, 'song-head');
  const live = { playing: playingSection(reading, 4), stopped: false, motion: 'on', queued: { index: 2, countdownText: 'in 3 bars', line: 18 } };
  view.tick(live);
  assert.deepEqual(heads.map((head) => head.getAttribute('data-state')), ['idle', 'playing', 'queued']);
  assert.equal(all(heads[2], 'part-state')[0].textContent, 'Queued — in 3 bars');
  assert.equal(all(heads[2], 'song-head-action')[0].textContent, 'Cancel');
  assert.equal(all(heads[2], 'song-head-action')[0].getAttribute('hidden'), null);
  assert.equal(heads[2].getAttribute('title'), 'Queued. Click to cancel.');
  assert.equal(heads[2].getAttribute('data-line'), '18');
  assert.equal(heads[1].getAttribute('data-line'), null);
  const writes = document.writes;
  view.tick({ ...live, queued: { ...live.queued } });
  assert.equal(document.writes, writes, 'the same queued state changes no node');
  view.tick({ ...live, queued: { index: 2, countdownText: 'in 2 bars', line: 18 } });
  assert.equal(all(heads[2], 'part-state')[0].textContent, 'Queued — in 2 bars');
  assert.equal(heads[2].getAttribute('data-line'), '18');
  view.tick({ ...live, queued: null });
  assert.equal(heads[2].getAttribute('data-state'), 'idle');
  assert.equal(heads[2].getAttribute('data-line'), null, 'the line goes with the queued state');
  assert.equal(all(heads[2], 'part-state')[0].textContent, '7 cycles');
  assert.equal(heads[2].getAttribute('title'), 'Starts at the end of the section that plays. Click to queue it.');
});

test('the line under the toolbar is written only when it changes, and it switches the controls it names off and on', () => {
  const { document, rows, line, view, build, reading } = setup();
  view.render(build());
  const heads = all(rows, 'song-head');
  const cells = all(rows, 'song-cell');
  const folds = all(rows, 'song-fold');
  const live = { playing: playingSection(reading, 4), stopped: false, motion: 'on' };
  view.tick(live);
  assert.equal(line.hidden, true, 'no sentence, no line');
  assert.equal(line.getAttribute('data-kind'), null);
  assert.ok([...heads, ...cells].every((node) => node.getAttribute('aria-disabled') === null));
  const waiting = { kind: 'waiting', text: 'A change is waiting for its bar line. The grid works again when it takes over.' };
  view.tick({ ...live, line: waiting });
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, waiting.text);
  assert.equal(line.getAttribute('data-kind'), 'waiting');
  assert.ok([...heads, ...cells].every((node) => node.getAttribute('aria-disabled') === 'true'), 'waiting switches off headers and cells');
  assert.ok(folds.every((node) => node.getAttribute('aria-disabled') === null), 'folding is not writing');
  const writes = document.writes;
  view.tick({ ...live, line: { ...waiting } });
  assert.equal(document.writes, writes, 'the same sentence changes no node');
  const queued = { kind: 'queued', text: "Section 'y' is queued — cells can't change until it starts. Click it again to cancel." };
  view.tick({ ...live, line: queued });
  assert.equal(line.getAttribute('data-kind'), 'queued');
  assert.ok(heads.every((node) => node.getAttribute('aria-disabled') === null), 'a queued launch leaves the headers usable');
  assert.ok(cells.every((node) => node.getAttribute('aria-disabled') === 'true'), 'and switches the cells off');
  view.tick({ ...live, line: { kind: 'refused', text: 'The change did not evaluate, so the code is as it was.' } });
  assert.ok([...heads, ...cells].every((node) => node.getAttribute('aria-disabled') === null), 'a refusal switches nothing off');
  view.tick({ ...live, line: null });
  assert.equal(line.hidden, true);
  assert.equal(line.getAttribute('data-kind'), null);
  assert.equal(line.textContent, '');
});

test('a click on a switched-off header or cell calls no handler, and one on a control that is on still does', () => {
  const calls = [];
  const { rows, view, build } = setup({}, { launch: (index) => calls.push(['launch', index]), choose: (seen, choice) => calls.push(['choose', seen.track, seen.index, choice]), fold: (key) => calls.push(['fold', key]) });
  view.render(build());
  const [table] = rows.children[0].children;
  const heads = all(rows, 'song-head');
  const cells = all(rows, 'song-cell');
  view.tick({ playing: null, stopped: true, motion: 'on', line: { kind: 'dirty', text: 'The editor has changes that are not playing yet. Evaluate them first — the grid works on the playing code.' } });
  table.dispatch('click', { target: heads[1] });
  table.dispatch('click', { target: cells[0].children[0] });
  assert.deepEqual(calls, [], 'switched off: nothing is called');
  assert.equal(view.isListOpen(), false, 'a switched-off cell opens no list');
  table.dispatch('click', { target: all(rows, 'song-fold')[0] });
  assert.deepEqual(calls, [['fold', '["g1"]']], 'a fold button is never switched off');
  view.tick({ playing: null, stopped: true, motion: 'on', line: null });
  table.dispatch('click', { target: heads[1] });
  table.dispatch('click', { target: cells[0].children[0] });
  assert.deepEqual(calls.slice(1), [['launch', 1]], 'a cell that is on opens its list; nothing is chosen yet');
  assert.equal(view.isListOpen(), true);
});

test('a rebuild switches the controls on again, and the next tick switches them off by the line', () => {
  const { rows, view, build, reading } = setup();
  view.render(build());
  const live = { playing: playingSection(reading, 4), stopped: false, motion: 'on', line: { kind: 'waiting', text: 'A change is waiting for its bar line. The grid works again when it takes over.' } };
  view.tick(live);
  view.render(build());
  assert.ok(all(rows, 'song-cell').every((node) => node.getAttribute('aria-disabled') === null), 'new controls start on');
  view.tick(live);
  assert.ok(all(rows, 'song-cell').every((node) => node.getAttribute('aria-disabled') === 'true'));
  assert.ok(all(rows, 'song-head').every((node) => node.getAttribute('aria-disabled') === 'true'));
});

test('hide() hides the line too', () => {
  const { line, view, build, reading } = setup();
  view.render(build());
  view.tick({ playing: playingSection(reading, 4), stopped: false, motion: 'on', line: { kind: 'dirty', text: 'x' } });
  assert.equal(line.hidden, false);
  view.hide();
  assert.equal(line.hidden, true);
  assert.equal(line.textContent, '');
  assert.equal(line.getAttribute('data-kind'), null);
});

test('a tick before any grid is drawn does nothing', () => {
  const { document, view } = setup();
  const writes = document.writes;
  view.tick({ playing: null, stopped: true, motion: 'on' });
  assert.equal(document.writes, writes);
});

test('the view needs all its elements and says which one is missing', () => {
  const document = fakeDocument();
  const node = () => fakeNode('div', document);
  assert.throws(() => createSongGridView({ document, rows: node(), bar: node(), now: node(), line: node(), list: node(), handlers: {} }), /needs its 'launchGroup' element/);
  assert.throws(() => createSongGridView({ document, rows: node(), bar: node(), now: node(), launchGroup: node(), list: node(), handlers: {} }), /needs its 'line' element/);
  assert.throws(() => createSongGridView({ document, bar: node(), now: node(), line: node(), launchGroup: node(), list: node(), handlers: {} }), /needs its 'rows' element/);
  assert.throws(() => createSongGridView({ document, rows: node(), bar: node(), now: node(), line: node(), launchGroup: node(), handlers: {} }), /needs its 'list' element/);
});

test('the toolbar has the three launch buttons with their words and names, shows with the grid and goes with it', () => {
  const choices = [];
  const { bar, launchGroup, rows, view, build } = setup({}, { launchChoice: (value) => choices.push(value) });
  assert.equal(launchGroup.getAttribute('title'), 'When a launched section starts: at the end of the section that plays, on the next phrase or on the next bar.');
  assert.deepEqual(launchGroup.children.map((button) => [button.tagName, button.textContent, button.getAttribute('aria-label'), button.getAttribute('data-value')]), [
    ['button', 'end of section', 'Sections start at the end of the section that plays', 'section'],
    ['button', 'next phrase', 'Sections start on the next phrase', 'phrase'],
    ['button', 'next bar', 'Sections start on the next bar', 'bar'],
  ]);
  assert.equal(bar.hidden, true);
  view.render(build({ launchChoice: 'phrase' }));
  assert.equal(bar.hidden, false);
  assert.deepEqual(launchGroup.children.map((button) => button.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  view.render(build());
  assert.deepEqual(launchGroup.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  launchGroup.dispatch('click', { target: launchGroup.children[2] });
  assert.deepEqual(choices, ['bar']);
  launchGroup.dispatch('click', { target: launchGroup });
  assert.deepEqual(choices, ['bar'], 'a click between the buttons does nothing');
  view.hide();
  assert.equal(bar.hidden, true);
  assert.equal(rows.children.length, 0);
});

test('a launch choice without a handler throws, and a rebuild with the same choice rewrites no pressed state', () => {
  const { document, launchGroup, view, build } = setup();
  view.render(build());
  assert.throws(() => launchGroup.dispatch('click', { target: launchGroup.children[1] }), /no handler for 'launchChoice'/);
  const before = launchGroup.children.map((button) => button.getAttribute('aria-pressed'));
  let pressedWrites = 0;
  for (const button of launchGroup.children) {
    const set = button.setAttribute;
    button.setAttribute = (name, value) => {
      if (name === 'aria-pressed') pressedWrites += 1;
      set(name, value);
    };
  }
  view.render(build());
  assert.equal(pressedWrites, 0);
  assert.deepEqual(launchGroup.children.map((button) => button.getAttribute('aria-pressed')), before);
  view.render(build({ launchChoice: 'bar' }));
  assert.equal(pressedWrites, 2, 'only the two buttons whose state changed are written');
  assert.ok(document.writes > 0);
});

test('the sentence under the toolbar follows the playing section, is written only when it changes and hides while stopped', () => {
  const { now, view, build, reading } = setup();
  view.render(build());
  assert.equal(now.hidden, true);
  view.tick({ playing: playingSection(reading, 4), stopped: false, motion: 'on' });
  assert.equal(now.hidden, false);
  assert.equal(now.textContent, "Playing section 'y', cycle 2 of 5.");
  const writes = now.textContent;
  view.tick({ playing: playingSection(reading, 4.3), stopped: false, motion: 'on' });
  assert.equal(now.textContent, writes);
  view.tick({ playing: playingSection(reading, 5), stopped: false, motion: 'on' });
  assert.equal(now.textContent, "Playing section 'y', cycle 3 of 5.");
  view.tick({ playing: playingSection(reading, 5), stopped: true, motion: 'on' });
  assert.equal(now.hidden, true);
  assert.equal(now.textContent, '');
  view.tick({ playing: null, stopped: true, motion: 'on' });
  assert.equal(now.hidden, true);
});

test('scrolling the playing section into view goes to its header, once asked, and only while one plays', () => {
  const { rows, view, build, reading } = setup();
  view.render(build());
  const heads = all(rows, 'song-colhead');
  view.scrollPlayingIntoView();
  assert.deepEqual(heads.map((th) => th.scrolledIntoView), [0, 0, 0], 'nothing plays, nothing scrolls');
  view.tick({ playing: playingSection(reading, 9), stopped: false, motion: 'on' });
  view.scrollPlayingIntoView();
  assert.deepEqual(heads.map((th) => th.scrolledIntoView), [0, 0, 1]);
});

/** The control of the grid with this row key and column, found through its attributes. */
function control(rows, kind, ...parts) {
  if (kind === 'head') return all(rows, 'song-head')[parts[0]];
  if (kind === 'fold') return all(rows, 'song-fold')[parts[0]];
  return all(rows, 'song-cell').find((cell) => cell.getAttribute('data-track') === parts[0] && cell.getAttribute('data-section') === String(parts[1]));
}

function tabStops(rows) {
  return [...all(rows, 'song-head'), ...all(rows, 'song-fold'), ...all(rows, 'song-cell')].filter((node) => node.getAttribute('tabindex') === '0');
}

function press(table, target, key, extra = {}) {
  return table.dispatch('keydown', { target, key, ...extra });
}

test('the grid has one tab stop, the first header, and focus moves it', () => {
  const { rows, view, build } = setup();
  view.render(build());
  const [table] = rows.children[0].children;
  assert.deepEqual(tabStops(rows), [control(rows, 'head', 0)]);
  const cell = control(rows, 'cell', 't2', 1);
  cell.focus();
  assert.deepEqual(tabStops(rows), [cell]);
  const everything = [...all(rows, 'song-head'), ...all(rows, 'song-fold'), ...all(rows, 'song-cell')];
  assert.ok(everything.every((node) => node.getAttribute('tabindex') !== null), 'every control has a tabindex, 0 or -1');
  assert.equal(table.tagName, 'table');
});

test('the arrow keys, Home, End and Ctrl+Home and Ctrl+End move focus between headers, fold buttons and cells', () => {
  const { rows, view, build } = setup();
  view.render(build());
  const [table] = rows.children[0].children;
  /** Presses `key` on the control the tab stop is on now and returns where the tab stop is after. */
  const from = (node, key, extra) => {
    node.focus();
    const event = press(table, node, key, extra);
    assert.ok(event.defaultPrevented, `${key} is the grid's own key`);
    return tabStops(rows)[0];
  };
  assert.equal(from(control(rows, 'head', 0), 'ArrowRight'), control(rows, 'head', 1));
  assert.equal(from(control(rows, 'head', 1), 'ArrowDown'), control(rows, 'fold', 0), 'down from a header reaches the first group');
  assert.equal(from(control(rows, 'fold', 0), 'ArrowDown'), control(rows, 'cell', 't1', 0), 'a track row is entered at its first cell');
  assert.equal(from(control(rows, 'cell', 't1', 0), 'End'), control(rows, 'cell', 't1', 2));
  assert.equal(from(control(rows, 'cell', 't1', 2), 'Home'), control(rows, 'cell', 't1', 0));
  assert.equal(from(control(rows, 'cell', 't1', 0), 'End', { ctrlKey: true }), control(rows, 'cell', 't3', 2), 'the last control of the grid');
  assert.equal(from(control(rows, 'cell', 't3', 2), 'Home', { ctrlKey: true }), control(rows, 'head', 0), 'the first control of the grid');
  assert.equal(from(control(rows, 'cell', 't3', 2), 'ArrowUp'), control(rows, 'fold', 2), 'up from the last row reaches the nested group above it');
  assert.equal(control(rows, 'cell', 't3', 2).focused > 0, true);
});

test('Left and Right on a group row do not fold it, and the keys the grid does not use pass through untouched', () => {
  const calls = [];
  const { rows, view, build } = setup({}, { fold: (key) => calls.push(key) });
  view.render(build());
  const [table] = rows.children[0].children;
  const fold = control(rows, 'fold', 0);
  fold.focus();
  const right = press(table, fold, 'ArrowRight');
  const left = press(table, fold, 'ArrowLeft');
  assert.deepEqual(calls, []);
  assert.ok(right.defaultPrevented && left.defaultPrevented, 'the arrows are the grid\'s own, even at an edge');
  for (const key of ['a', 'b', 'c', '4', 'Enter', ' ', 'Escape', 'Tab']) {
    const event = press(table, fold, key);
    assert.equal(event.defaultPrevented, false, key);
    assert.equal(event.stopped, false, key);
  }
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    const event = press(table, fold, 'ArrowDown', extra);
    assert.equal(event.defaultPrevented, false, JSON.stringify(extra));
  }
  const moved = press(table, fold, 'ArrowDown');
  assert.ok(moved.stopped, 'a handled key does not reach the page\'s own key handler');
});

test('a folded group\'s rows are skipped by the arrow keys', () => {
  const { rows, view, build } = setup();
  view.render(build({ folds: new Set([groupKey(['g1'])]) }));
  const [table] = rows.children[0].children;
  const fold = control(rows, 'fold', 0);
  fold.focus();
  press(table, fold, 'ArrowDown');
  assert.equal(tabStops(rows)[0], control(rows, 'fold', 1), 'g1\'s tracks are hidden, so Down reaches the next group');
});

test('a rebuild keeps the scroll offsets of both axes and the focus on the same row and column', () => {
  const { document, rows, view, build } = setup();
  view.render(build());
  const [scroller] = rows.children;
  scroller.scrollLeft = 120;
  scroller.scrollTop = 40;
  const cell = control(rows, 'cell', 't2', 1);
  cell.focus();
  view.render(build({ launchChoice: 'bar' }));
  const [fresh] = rows.children;
  assert.notEqual(fresh, scroller, 'the grid was drawn again');
  assert.deepEqual([fresh.scrollLeft, fresh.scrollTop], [120, 40]);
  const again = control(rows, 'cell', 't2', 1);
  assert.notEqual(again, cell);
  assert.equal(document.activeElement, again);
  assert.deepEqual(tabStops(rows), [again]);
});

test('a rebuild with no focus in the grid leaves focus alone, and the tab stop stays where it was', () => {
  const { document, rows, view, build } = setup();
  view.render(build());
  control(rows, 'cell', 't3', 0).focus();
  document.activeElement = null;
  view.render(build());
  assert.equal(document.activeElement, null);
  assert.deepEqual(tabStops(rows), [control(rows, 'cell', 't3', 0)]);
});

// ---- the list that opens on a cell ----

const cellOf = (rows, track, section) => all(rows, 'song-cell').find((cell) => cell.getAttribute('data-track') === track && cell.getAttribute('data-section') === String(section));
const optionsOf = (list) => list.children.filter((child) => child.getAttribute('role') === 'option');

test('a click on a cell opens the list: options in code order with the current one selected, rest last, focus inside, the cell expanded', () => {
  const { rows, list, document, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 1);
  assert.equal(cell.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(cell.getAttribute('aria-expanded'), 'false');
  assert.equal(list.hidden, true);
  table.dispatch('click', { target: cell.children[0] });
  assert.equal(view.isListOpen(), true);
  assert.equal(list.hidden, false);
  assert.equal(list.getAttribute('aria-label'), "Variation for 't1' in section 'y'");
  assert.equal(list.getAttribute('aria-describedby'), null, 'a section used once has no shared note');
  const options = optionsOf(list);
  assert.deepEqual(options.map((option) => option.children[0].textContent), ['va', 'vb', 'rest']);
  assert.deepEqual(options.map((option) => option.getAttribute('aria-selected')), ['false', 'true', 'false']);
  assert.equal(options[1].textContent, 'vbcurrent');
  assert.equal(new Set(options.map((option) => option.getAttribute('id'))).size, 3);
  assert.equal(options[2].className.includes('song-option-rest'), true);
  assert.equal(list.getAttribute('aria-activedescendant'), options[1].getAttribute('id'));
  assert.equal(options[1].getAttribute('data-active'), 'true');
  assert.equal(document.activeElement, list, 'focus moves into the list');
  assert.equal(cell.getAttribute('aria-expanded'), 'true');
});

test('a degree variation is noted "follows the harmony" in the list, and a plain one has no note', () => {
  const { rows, list, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't2', 0).children[0] });
  const [only, rest] = optionsOf(list);
  assert.equal(only.textContent, 'vacurrentfollows the harmony');
  assert.equal(rest.textContent, 'rest');
  table.dispatch('click', { target: cellOf(rows, 't1', 0).children[0] });
  assert.equal(optionsOf(list)[0].textContent, 'vacurrent');
});

test('a section used twice puts the shared note first in the list and refers to it', () => {
  const { rows, list, view, build } = setup(
    { sections: "[['x', 3], ['y', 5], ['x', 3]]", plan: "{ x: { t1: 'va', t2: 'va', t3: 'va' }, y: { t1: 'vb', t2: 'va', t3: '-' } }" },
    { choose() {} },
  );
  view.render(build());
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't1', 2).children[0] });
  assert.equal(list.children[0].textContent, "Section 'x' is used 2 times; the change applies to each use.");
  assert.equal(list.getAttribute('aria-describedby'), list.children[0].getAttribute('id'));
  assert.equal(optionsOf(list).length, 3, 'the note is not an option');
});

test('choosing an option calls choose with what the person saw and the choice, closes the list and returns focus to the cell', () => {
  const calls = [];
  const { rows, list, document, view, build } = setup({}, { choose: (seen, choice) => calls.push([seen, choice]) });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 1);
  table.dispatch('click', { target: cell.children[0] });
  list.dispatch('click', { target: optionsOf(list)[0].children[0] });
  assert.deepEqual(calls, [[{ track: 't1', index: 1, name: 'y', length: 5, key: 'vb' }, { key: 'va' }]]);
  assert.equal(view.isListOpen(), false);
  assert.equal(list.hidden, true);
  assert.equal(document.activeElement, cell);
  assert.equal(cell.getAttribute('aria-expanded'), 'false');
  table.dispatch('click', { target: cell.children[0] });
  list.dispatch('click', { target: optionsOf(list)[2] });
  assert.deepEqual(calls[1][1], { rest: true });
  table.dispatch('click', { target: cellOf(rows, 't3', 1).children[0] });
  assert.equal(optionsOf(list)[1].getAttribute('aria-selected'), 'true', 'a rest cell has the rest option current');
  list.dispatch('click', { target: optionsOf(list)[0] });
  assert.deepEqual(calls[2], [{ track: 't3', index: 1, name: 'y', length: 5, key: null }, { key: 'va' }]);
});

test('a name from the code stays text in the list: markup in a variation name becomes no element', () => {
  const { rows, list, view } = setup({}, { choose() {} });
  const hostileName = '<img src=x onerror=alert(1)>';
  const source = code({}).replace("vb: note('d3')", `'${hostileName}': note('d3')`).replace("t1: 'vb'", `t1: '${hostileName}'`);
  const hostile = buildSongGrid({ reading: read(source), folds: new Set(), launchChoice: 'section' });
  view.render(hostile);
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't1', 1).children[0] });
  assert.equal(optionsOf(list)[1].children[0].textContent, hostileName);
  assert.equal(optionsOf(list)[1].children[0].children.length, 0, 'the name is one text node, no parsed element');
});

test('opening a list with no choose handler throws loudly, and a click on the open cell closes it', () => {
  const absent = setup();
  absent.view.render(absent.build());
  assert.throws(() => absent.rows.children[0].children[0].dispatch('click', { target: cellOf(absent.rows, 't1', 0).children[0] }), /no handler for 'choose'/);
  const { rows, document, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 0);
  table.dispatch('click', { target: cell.children[0] });
  assert.equal(view.isListOpen(), true);
  table.dispatch('click', { target: cell.children[0] });
  assert.equal(view.isListOpen(), false);
  assert.equal(document.activeElement, cell);
});

test('the list keys: Up and Down move the active option, Home and End jump, Enter and Space choose', () => {
  const calls = [];
  const { rows, list, view, build } = setup({}, { choose: (seen, choice) => calls.push(choice) });
  view.render(build());
  const [table] = rows.children[0].children;
  const open = () => table.dispatch('click', { target: cellOf(rows, 't1', 1).children[0] });
  const active = () => optionsOf(list).findIndex((option) => option.getAttribute('data-active') === 'true');
  open();
  assert.equal(active(), 1, 'the current option is active when the list opens');
  const press = (key) => list.dispatch('keydown', { key });
  assert.equal(press('ArrowDown').defaultPrevented, true);
  assert.equal(active(), 2);
  press('ArrowDown');
  assert.equal(active(), 2, 'the last option stays');
  assert.equal(list.getAttribute('aria-activedescendant'), optionsOf(list)[2].getAttribute('id'));
  press('ArrowUp');
  press('ArrowUp');
  press('ArrowUp');
  assert.equal(active(), 0);
  press('End');
  assert.equal(active(), 2);
  press('Home');
  assert.equal(active(), 0);
  press('ArrowDown');
  press('ArrowDown');
  press('Enter');
  assert.deepEqual(calls, [{ rest: true }], 'Enter chooses the active option');
  assert.equal(view.isListOpen(), false);
  open();
  press('Home');
  press(' ');
  assert.deepEqual(calls, [{ rest: true }, { key: 'va' }], 'Space chooses too');
});

test('Esc and Tab close the list and return focus to the cell; Esc does not reach the page', () => {
  const { rows, list, document, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 0);
  table.dispatch('click', { target: cell.children[0] });
  const esc = list.dispatch('keydown', { key: 'Escape' });
  assert.equal(esc.stopped, true, 'the press stops here');
  assert.equal(esc.defaultPrevented, true);
  assert.equal(view.isListOpen(), false);
  assert.equal(document.activeElement, cell);
  table.dispatch('click', { target: cell.children[0] });
  const tab = list.dispatch('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(view.isListOpen(), false);
  assert.equal(document.activeElement, cell);
  assert.equal(list.dispatch('keydown', { key: 'Escape' }).stopped, false, 'with the list closed the press passes');
});

test('a press outside the list closes it, a press inside it or on its cell does not', () => {
  const { rows, list, document, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 0);
  table.dispatch('click', { target: cell.children[0] });
  document.dispatch('pointerdown', { target: optionsOf(list)[0].children[0] });
  document.dispatch('pointerdown', { target: cell.children[0] });
  assert.equal(view.isListOpen(), true);
  document.dispatch('pointerdown', { target: rows });
  assert.equal(view.isListOpen(), false);
  assert.equal(list.hidden, true);
});

test('a grid drawn while the list is open waits until it closes, and keeps scroll and focus', () => {
  const { rows, list, document, view, build, reading } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  const scroller = rows.children[0];
  scroller.scrollLeft = 120;
  scroller.scrollTop = 40;
  const cell = cellOf(rows, 't1', 1);
  cell.focus();
  table.dispatch('click', { target: cell.children[0] });
  const replaced = rows.replaced;
  view.render(buildSongGrid({ reading, folds: new Set(['["g1"]']), launchChoice: 'phrase' }));
  assert.equal(rows.replaced, replaced, 'nothing is drawn while the list is open');
  assert.equal(rows.children[0], scroller);
  list.dispatch('keydown', { key: 'Escape' });
  assert.equal(rows.replaced, replaced + 1, 'drawn when the list closes');
  const fresh = rows.children[0];
  assert.notEqual(fresh, scroller);
  assert.equal(fresh.scrollLeft, 120);
  assert.equal(fresh.scrollTop, 40);
  assert.equal(document.activeElement.getAttribute('data-track'), 't1', 'focus is on the same cell');
  assert.equal(document.activeElement.getAttribute('data-section'), '1');
  assert.equal(all(rows, 'song-fold')[0].getAttribute('aria-expanded'), 'false', 'the waiting model was the one drawn');
});

test('hide() closes an open list and forgets a grid that waited', () => {
  const { rows, list, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't1', 0).children[0] });
  view.render(build());
  view.hide();
  assert.equal(view.isListOpen(), false);
  assert.equal(list.hidden, true);
  assert.equal(rows.children.length, 0);
});

test('the list opens below its cell, flips above it when the room below is short, and never leaves the window', () => {
  const { rows, list, view, build } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 0);
  list.rect = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 };
  cell.rect = { left: 300, top: 100, right: 400, bottom: 150, width: 100, height: 50 };
  table.dispatch('click', { target: cell.children[0] });
  assert.equal(list.style.top, '150px');
  assert.equal(list.style.left, '300px');
  assert.equal(list.getAttribute('data-placement'), 'below');
  view.closeList();
  cell.rect = { left: 900, top: 700, right: 1000, bottom: 750, width: 100, height: 50 };
  table.dispatch('click', { target: cell.children[0] });
  assert.equal(list.style.top, '600px', 'above the cell');
  assert.equal(list.style.left, '800px', 'kept inside the window on the right');
  assert.equal(list.getAttribute('data-placement'), 'above');
  view.closeList();
  list.rect = { left: 0, top: 0, right: 200, bottom: 500, width: 200, height: 500 };
  cell.rect = { left: 10, top: 300, right: 110, bottom: 350, width: 100, height: 50 };
  table.dispatch('click', { target: cell.children[0] });
  assert.equal(list.style.top, '350px');
  assert.equal(list.style.maxHeight, '450px', 'neither side holds it, so it takes the larger side and scrolls inside itself');
});

test('choosing the option the cell holds already closes the list and does not call choose', () => {
  const calls = [];
  const { rows, list, document, view, build } = setup({}, { choose: (seen, choice) => calls.push(choice) });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 1);
  table.dispatch('click', { target: cell.children[0] });
  list.dispatch('click', { target: optionsOf(list)[1].children[0] });
  assert.deepEqual(calls, []);
  assert.equal(view.isListOpen(), false);
  assert.equal(document.activeElement, cell);
  table.dispatch('click', { target: cellOf(rows, 't3', 1).children[0] });
  list.dispatch('keydown', { key: 'End' });
  list.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(calls, [], 'a rest cell chosen as rest is no change either');
});

test('a tick whose playing section is beyond the grid drawn (a newer one waits for the list) shows no section as playing', () => {
  const { rows, list, now, view, build, reading } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't1', 0).children[0] });
  assert.doesNotThrow(() => view.tick({ playing: { index: 7, cycleIn: 1, progress: 0 }, stopped: false, motion: 'on', queued: null, line: null }));
  assert.equal(all(rows, 'song-head').filter((head) => head.getAttribute('data-state') === 'playing').length, 0);
  assert.equal(now.hidden, true);
  list.dispatch('keydown', { key: 'Escape' });
  view.tick({ playing: playingSection(reading, 4), stopped: false, motion: 'on', queued: null, line: null });
  assert.equal(all(rows, 'song-head').filter((head) => head.getAttribute('data-state') === 'playing').length, 1);
});

// The fixed variation of the test piece: t3 plays 'va' (D dorian) in sections x and z.
const fitAnswer = (masks) => new Map([[pairKey('t3', 'va'), masks]]);
const bitsOf = (...pcs) => pcs.reduce((mask, pc) => mask | (1 << pc), 0);
// The notes of the first cycle, then silence up to the longest section (7 cycles).
const firstCycle = (...pcs) => [bitsOf(...pcs), 0, 0, 0, 0, 0, 0];

test('a fixed cell shows no second line and no fit data while the fit is pending, and the words and data once it has answered', () => {
  const { rows, view, build, reading } = setup();
  view.render(build());
  const pendingCell = cellOf(rows, 't3', 0);
  assert.equal(pendingCell.getAttribute('data-fit'), null);
  assert.equal(pendingCell.getAttribute('data-outside'), null);
  assert.equal(all(rows, 'song-fit').length, 0);
  assert.equal(pendingCell.getAttribute('title'), "'t3', section 'x': 'va', fixed to D3:dorian");
  // x has E minor: D dorian's notes with an F# and a C# are outside it.
  const lookup = fitLookup({ reading, byPair: fitAnswer({ masks: firstCycle(4, 7, 6, 1) }) });
  view.render(build({ fit: lookup }));
  const first = cellOf(rows, 't3', 0);
  assert.deepEqual(all(first, 'song-fit').map((node) => node.textContent), ['does not fit (C#)']);
  assert.equal(first.getAttribute('data-fit'), 'does-not-fit');
  assert.equal(first.getAttribute('data-outside'), 'C#');
  assert.equal(first.getAttribute('title').endsWith('Nothing is changed.'), true);
  assert.deepEqual(first.children.map((child) => child.className), ['song-variation', 'song-fit'], 'the fit line uses the muted class only');
  // y has no cell for t3 (a rest); z has the piece harmony C major, where C# (spelled Db there) and F# are outside.
  const rest = cellOf(rows, 't3', 1);
  assert.equal(rest.getAttribute('data-fit'), null);
  assert.equal(all(rest, 'song-fit').length, 0);
  const third = cellOf(rows, 't3', 2);
  assert.equal(third.getAttribute('data-fit'), 'does-not-fit');
  assert.deepEqual(all(third, 'song-fit').map((node) => node.textContent), ['does not fit (Db, F#)']);
  assert.equal(third.getAttribute('data-outside'), 'Db, F#');
  // A degree variation and a plain one never get a fit line.
  assert.equal(all(cellOf(rows, 't2', 0), 'song-fit').length, 0);
  assert.equal(all(cellOf(rows, 't1', 0), 'song-fit').length, 0);
});

test('the fit words of a cell are written as text only, and a cannot-check cell carries its reason in the title', () => {
  const { rows, view, build, reading } = setup();
  const lookup = fitLookup({ reading, byPair: fitAnswer({ reason: 'not-read' }) });
  view.render(build({ fit: lookup }));
  const cell = cellOf(rows, 't3', 0);
  assert.equal(cell.getAttribute('data-fit'), 'cannot-check');
  assert.equal(cell.getAttribute('data-outside'), null);
  assert.deepEqual(all(cell, 'song-fit').map((node) => node.textContent), ['cannot check']);
  assert.equal(cell.getAttribute('title'), "'t3', section 'x': 'va', fixed to D3:dorian. The page could not read the notes of this variation.");
  assert.doesNotMatch(SOURCE, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('a grid drawn with a fit answer while the list is open waits until the list closes', () => {
  const { rows, list, view, build, reading } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't3', 0).children[0] });
  const lookup = fitLookup({ reading, byPair: fitAnswer({ masks: firstCycle(4) }) });
  view.render(build({ fit: lookup }));
  assert.equal(all(rows, 'song-fit').length, 0, 'nothing is redrawn under the open list');
  list.dispatch('keydown', { key: 'Escape' });
  assert.equal(all(rows, 'song-fit').length, 2);
});

test('the list on a fixed cell shows the fit words of the section being edited after the name, and none while the fit is pending', () => {
  const { rows, list, view, build, reading } = setup({}, { choose() {} });
  view.render(build());
  const [table] = rows.children[0].children;
  table.dispatch('click', { target: cellOf(rows, 't3', 0).children[0] });
  assert.deepEqual(all(list, 'song-option-note').map((node) => node.textContent), ['current']);
  list.dispatch('keydown', { key: 'Escape' });
  const lookup = fitLookup({ reading, byPair: fitAnswer({ masks: firstCycle(4, 7, 6, 1) }) });
  view.render(build({ fit: lookup }));
  table.dispatch('click', { target: cellOf(rows, 't3', 2).children[0] });
  assert.deepEqual(all(list, 'song-option-note').map((node) => node.textContent), ['current', 'does not fit (Db, F#)']);
  assert.deepEqual(optionsOf(list).map((option) => option.children.map((child) => child.className)), [['song-option-name', 'song-option-note', 'song-option-note'], ['song-option-name']]);
});

// ---- what a right-click asks about, and the keyboard's right-click ----

const rowHeadOf = (rows, className, index) => all(rows, className)[index].children[0];

test('askTarget: a header, a fixed cell, a rest cell, a fold button, a group row head and a track row head each give their descriptor, the corner and the outside give null', () => {
  const { rows, view, build } = setup();
  view.render(build());
  assert.deepEqual(view.askTarget(control(rows, 'head', 1)), { kind: 'part', name: 'y' });
  assert.deepEqual(view.askTarget(all(control(rows, 'head', 1), 'part-name')[0]), { kind: 'part', name: 'y' }, 'a part of the header counts as the header');
  assert.deepEqual(view.askTarget(cellOf(rows, 't1', 1)), { kind: 'cell', section: 'y', track: 't1', variation: 'vb' });
  assert.deepEqual(view.askTarget(cellOf(rows, 't3', 1)), { kind: 'cell', section: 'y', track: 't3', rest: true });
  assert.deepEqual(view.askTarget(all(cellOf(rows, 't1', 1), 'song-variation')[0]), { kind: 'cell', section: 'y', track: 't1', variation: 'vb' });
  // g1 sits at the top, g2 holds g3.
  assert.deepEqual(view.askTarget(control(rows, 'fold', 0)), { kind: 'group', name: 'g1' });
  assert.deepEqual(view.askTarget(control(rows, 'fold', 2)), { kind: 'group', name: 'g3', parent: 'g2' });
  assert.deepEqual(view.askTarget(rowHeadOf(rows, 'song-group-row', 2)), { kind: 'group', name: 'g3', parent: 'g2' }, 'the head of the row, not only the fold button');
  assert.deepEqual(view.askTarget(all(rows, 'song-group-row')[1].children[1]), { kind: 'group', name: 'g2' }, 'the fill of the row');
  assert.deepEqual(view.askTarget(rowHeadOf(rows, 'song-track-row', 1)), { kind: 'track', track: 't2' });
  const [table] = rows.children[0].children;
  const corner = all(table, 'song-corner')[0];
  assert.equal(view.askTarget(corner), null);
  assert.equal(view.askTarget(table), null);
  assert.equal(view.askTarget(fakeNode('div', fakeDocument())), null, 'an element outside the grid');
});

test('askTarget reads the names from the model, not from the shown text, which may be cut', () => {
  const long = 'q'.repeat(60);
  const { rows, view, build } = setup({
    sections: `[['${long}', 3]]`,
    groups: `{ '${long}': ['${long}t'] }`,
    plan: `{ '${long}': { '${long}t': 'va' } }`,
    statements: `${long}t: play('${long}t', t1)`,
  });
  view.render(build());
  assert.notEqual(control(rows, 'head', 0).children[0].textContent, long, 'the shown section name is cut');
  assert.deepEqual(view.askTarget(control(rows, 'head', 0)), { kind: 'part', name: long });
  assert.deepEqual(view.askTarget(control(rows, 'fold', 0)), { kind: 'group', name: long });
  assert.deepEqual(view.askTarget(cellOf(rows, `${long}t`, 0)), { kind: 'cell', section: long, track: `${long}t`, variation: 'va' });
  assert.deepEqual(view.askTarget(rowHeadOf(rows, 'song-track-row', 0)), { kind: 'track', track: `${long}t` });
});

test('askTarget answers null before a grid is drawn and after it is taken away', () => {
  const { rows, view, build } = setup();
  assert.equal(view.askTarget(fakeNode('div', fakeDocument())), null);
  view.render(build());
  const cell = cellOf(rows, 't1', 0);
  assert.notEqual(view.askTarget(cell), null);
  view.hide();
  assert.equal(view.askTarget(cell), null);
});

test('askTarget on a cell carries the fit shown now: nothing while pending, then the word, and the outside notes only when they do not fit', () => {
  const { rows, view, build, reading } = setup();
  view.render(build());
  assert.deepEqual(view.askTarget(cellOf(rows, 't3', 0)), { kind: 'cell', section: 'x', track: 't3', variation: 'va' }, 'no fit field while pending');
  const lookup = fitLookup({ reading, byPair: fitAnswer({ masks: firstCycle(4, 7, 6, 1) }) });
  view.render(build({ fit: lookup }));
  const not = view.askTarget(cellOf(rows, 't3', 0));
  assert.deepEqual({ ...not, prefill: undefined }, { kind: 'cell', section: 'x', track: 't3', variation: 'va', fit: 'does-not-fit', outside: 'C#', prefill: undefined });
  assert.equal(
    not.prefill,
    "Fit variation 'va' of track 't3' to the harmony of section 'x' (E3:minor). It has notes outside it: C#.",
  );
  // z takes the piece's harmony text.
  assert.match(view.askTarget(cellOf(rows, 't3', 2)).prefill, /of section 'z' \(C3:major\)\. It has notes outside it: Db, F#\.$/);
  // The rest cell and the plain and degree cells have no fit and no prefill.
  assert.deepEqual(view.askTarget(cellOf(rows, 't3', 1)), { kind: 'cell', section: 'y', track: 't3', rest: true });
  assert.equal(Object.hasOwn(view.askTarget(cellOf(rows, 't2', 0)), 'fit'), false);
  const fits = fitLookup({ reading, byPair: fitAnswer({ masks: firstCycle(4) }) });
  view.render(build({ fit: fits }));
  assert.deepEqual(view.askTarget(cellOf(rows, 't3', 0)), { kind: 'cell', section: 'x', track: 't3', variation: 'va', fit: 'fits' }, 'a fits cell has no prefill');
  const cannot = fitLookup({ reading, byPair: fitAnswer({ reason: 'not-read' }) });
  view.render(build({ fit: cannot }));
  assert.deepEqual(view.askTarget(cellOf(rows, 't3', 0)), { kind: 'cell', section: 'x', track: 't3', variation: 'va', fit: 'cannot-check' }, 'a cannot-check cell has no prefill');
});

test('askTarget never changes the grid: no node is written and nothing is redrawn', () => {
  const { rows, view, build, document } = setup();
  view.render(build());
  const [table] = rows.children[0].children;
  const writes = document.writes;
  const created = document.created;
  view.askTarget(cellOf(rows, 't1', 0));
  view.askTarget(control(rows, 'head', 0));
  assert.equal(document.writes, writes);
  assert.equal(document.created, created);
  assert.equal(rows.children[0].children[0], table);
});

test('Shift+F10 and the Menu key on a focused control call the ask handler once with its descriptor and the centre of the control, and stop the event', () => {
  const calls = [];
  const { rows, view, build } = setup({}, { ask: (descriptor, point) => calls.push([descriptor, point]) });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 1);
  cell.rect = { left: 100, top: 40, right: 180, bottom: 80, width: 80, height: 40 };
  const shifted = press(table, cell, 'F10', { shiftKey: true });
  assert.equal(shifted.defaultPrevented, true);
  assert.equal(shifted.stopped, true);
  assert.deepEqual(calls, [[{ kind: 'cell', section: 'y', track: 't1', variation: 'vb' }, { x: 140, y: 60 }]]);
  const menu = press(table, cell, 'ContextMenu');
  assert.equal(menu.defaultPrevented, true);
  assert.equal(menu.stopped, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  // A header, and a fold button, ask about their own targets.
  const head = control(rows, 'head', 2);
  head.rect = { left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 };
  press(table, head, 'ContextMenu');
  assert.deepEqual(calls[2], [{ kind: 'part', name: 'z' }, { x: 30, y: 20 }]);
  const fold = control(rows, 'fold', 2);
  press(table, fold, 'F10', { shiftKey: true });
  assert.deepEqual(calls[3][0], { kind: 'group', name: 'g3', parent: 'g2' });
});

test('other keys, F10 without Shift, and a key with another modifier do not ask and are not stopped', () => {
  const calls = [];
  const { rows, view, build } = setup({}, { ask: (descriptor) => calls.push(descriptor) });
  view.render(build());
  const [table] = rows.children[0].children;
  const cell = cellOf(rows, 't1', 1);
  for (const [key, extra] of [
    ['F10', {}],
    ['F9', { shiftKey: true }],
    ['ContextMenu', { shiftKey: true }],
    ['ContextMenu', { ctrlKey: true }],
    ['F10', { shiftKey: true, altKey: true }],
    ['F10', { shiftKey: true, ctrlKey: true }],
    ['F10', { shiftKey: true, metaKey: true }],
    ['Enter', {}],
    ['a', {}],
  ]) {
    const event = press(table, cell, key, extra);
    assert.equal(event.defaultPrevented, false, `${key} ${JSON.stringify(extra)}`);
    assert.equal(event.stopped, false, `${key} ${JSON.stringify(extra)}`);
  }
  assert.deepEqual(calls, []);
});

test('the Menu key on a focused cell with a missing ask handler throws, so nothing is ignored silently', () => {
  const { rows, view, build } = setup();
  view.render(build());
  const [table] = rows.children[0].children;
  assert.throws(() => press(table, cellOf(rows, 't1', 0), 'ContextMenu'), /no handler for 'ask'/);
});

test('the keyboard route on a cell with a does-not-fit fit hands the prefill on in the descriptor, and writes nothing to the grid', () => {
  const calls = [];
  const { rows, view, build, reading, document } = setup({}, { ask: (descriptor) => calls.push(descriptor) });
  const lookup = fitLookup({ reading, byPair: fitAnswer({ masks: firstCycle(4, 7, 6, 1) }) });
  view.render(build({ fit: lookup }));
  const [table] = rows.children[0].children;
  const writes = document.writes;
  press(table, cellOf(rows, 't3', 0), 'F10', { shiftKey: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fit, 'does-not-fit');
  assert.match(calls[0].prefill, /^Fit variation 'va' of track 't3'/);
  assert.equal(document.writes, writes);
});
