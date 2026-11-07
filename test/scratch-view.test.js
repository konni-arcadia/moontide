// The Scratchpad view's DOM code, tested without a browser against the fake document. The markup comes from page/index.html itself, so
// the view is built over the very ids the page has. The live view in real Chrome is proved by `npm run probe:page -- --only scratch`;
// these tests pin what the view writes, how the keyboard moves the cursor and edits the motif, and that it writes only what changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createScratchView } from '../page/scratch-view.js';
import { SCRATCH_COPY, listenOptions } from '../page/scratch-model.js';
import { fakeDocument, fakeNode } from './fake-document.js';

/** The Scratchpad's markup of page/index.html as fake nodes: tag, id, class and attributes, no text. */
function scratchMarkup() {
  const html = readFileSync(fileURLToPath(new URL('../page/index.html', import.meta.url)), 'utf8');
  const document = fakeDocument();
  const start = html.indexOf('<div id="scratch-view"');
  assert.notEqual(start, -1, 'page/index.html has no #scratch-view');
  const stack = [];
  let root = null;
  for (const match of html.slice(start).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>/g)) {
    const [, closing, tag, attributeText] = match;
    if (closing === '/') {
      stack.pop();
      if (stack.length === 0) break;
      continue;
    }
    const node = fakeNode(tag, document);
    for (const attribute of attributeText.matchAll(/([a-zA-Z][\w-]*)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = attribute;
      if (name === 'id') node.id = value;
      else if (name === 'class') node.className = value;
      else node.attributes.set(name, value);
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      node.parentNode = parent;
      parent.children.push(node);
    } else {
      root = node;
    }
    // An input has no closing tag.
    if (tag !== 'input') stack.push(node);
  }
  document.markup = [root];
  return document;
}

// A rem is 16 pixels in these tests, and the grid is 960 pixels wide for the 96 units of a two-cycle motif (10 pixels a unit) and 240 high for
// its 24 rows (10 pixels a row), with its corner at 100, 50. The window starts at C3, so the top row is B4 (71).
const REM = 16;
const GRID_RECT = { left: 100, top: 50, right: 1060, bottom: 290, width: 960, height: 240 };

function setup(options = {}) {
  const document = scratchMarkup();
  const view = createScratchView({ document, rootFontPx: () => REM, ...options });
  const get = (id) => {
    const node = document.getElementById(id);
    assert.notEqual(node, null, `no #${id} in the markup`);
    return node;
  };
  const roll = get('scratch-roll');
  const press = (key, extra = {}) => roll.dispatch('keydown', { key, ...extra });
  const focus = () => {
    document.activeElement = roll;
    roll.dispatch('focus');
  };
  const blur = () => {
    document.activeElement = null;
    roll.dispatch('blur');
  };
  const attr = (id, name) => get(id).getAttribute(name);
  const notes = () => get('scratch-notes').children.map((element) => ({ ...Object.fromEntries(['id', 'pitch', 'start', 'length', 'velocity'].map((name) => [name, Number(element.dataset[name])])), label: element.getAttribute('aria-label'), selected: element.className.split(' ').includes('sp-selected') }));
  const line = () => ({
    kind: get('scratch-note-line').getAttribute('data-kind'),
    name: get('scratch-note-name').textContent,
    rest: get('scratch-note-rest').textContent,
    spoken: get('scratch-note-spoken').textContent,
  });
  const cursor = () => ({ unit: Number(attr('scratch-roll', 'data-cursor-unit')), pitch: Number(attr('scratch-roll', 'data-cursor-pitch')) });
  const grid = get('scratch-grid');
  grid.rect = { ...GRID_RECT };
  // A point inside the unit (a tenth of a unit past its start) and inside the row of the pitch (half way down it).
  const x = (unit) => GRID_RECT.left + unit * 10 + 1;
  const y = (pitch) => GRID_RECT.top + (71 - pitch) * 10 + 5;
  const pointer = (type, px, py, extra = {}) => grid.dispatch(type, { pointerId: 1, clientX: px, clientY: py, ...extra });
  const down = (px, py, extra) => pointer('pointerdown', px, py, extra);
  const move = (px, py, extra) => pointer('pointermove', px, py, extra);
  const up = (px, py, extra) => pointer('pointerup', px, py, extra);
  // Draw mode on, the way a person turns it on: the button. A drag on an empty cell then writes a note.
  const drawOn = () => get('scratch-draw').dispatch('click');
  // A double-click on a cell: the one gesture that writes a note in Select mode.
  const dbl = (px, py, extra = {}) => grid.dispatch('dblclick', { clientX: px, clientY: py, ...extra });
  const hidden = (id) => get(id).hidden;
  const prop = (id, name) => get(id).style.props.get(name);
  return { document, view, get, roll, press, focus, blur, attr, notes, line, cursor, grid, x, y, pointer, down, move, up, hidden, prop, drawOn, dbl };
}

test('the view builds the 24 piano cells, the ruler and the read-outs for an empty two-cycle motif', () => {
  const { get, attr, line } = setup();
  const cells = get('scratch-gutter').children;
  assert.equal(cells.length, 24);
  assert.deepEqual(cells.map((cell) => cell.textContent), Array.from({ length: 24 }, (_, row) => (row === 11 ? 'C4' : row === 23 ? 'C3' : '')));
  assert.deepEqual(cells.map((cell) => cell.getAttribute('data-black')).slice(0, 12), ['false', 'true', 'false', 'true', 'false', 'true', 'false', 'false', 'true', 'false', 'true', 'false']);
  const labels = get('scratch-ruler').children;
  assert.deepEqual(labels.map((label) => label.textContent), ['1.1', '1.2', '1.3', '1.4', '2.1', '2.2', '2.3', '2.4']);
  assert.deepEqual(labels.filter((label) => label.className.includes('sp-beat-first')).map((label) => label.textContent), ['1.1', '2.1']);
  assert.equal(attr('scratch-view', 'data-cycles'), '2');
  assert.equal(attr('scratch-view', 'data-grid'), 'sixteenth');
  assert.equal(attr('scratch-view', 'data-window-start'), '48');
  assert.equal(attr('scratch-view', 'data-notes'), '0');
  assert.equal(attr('scratch-roll', 'data-cursor-unit'), '0');
  assert.equal(attr('scratch-roll', 'data-cursor-pitch'), '60');
  assert.equal(get('scratch-roll').style.props.get('--sp-cycles'), '2');
  assert.equal(get('scratch-roll').style.props.get('--sp-steps'), '16');
  assert.equal(get('scratch-roll').style.props.get('--sp-units'), '96');
  assert.equal(SCRATCH_COPY.early, 'Early experimental');
  assert.equal(get('scratch-early').textContent, SCRATCH_COPY.early);
  assert.equal(attr('scratch-early', 'title'), SCRATCH_COPY.earlyTitle);
  assert.equal(get('scratch-hint').textContent, SCRATCH_COPY.hintSelect);
  assert.equal(attr('scratch-view', 'data-draw'), 'off');
  assert.equal(attr('scratch-view', 'data-selected'), '');
  assert.equal(attr('scratch-view', 'data-selected-count'), '0');
  assert.equal(line().kind, 'empty');
  assert.equal(line().name, 'No notes yet');
  assert.ok(get('scratch-cursor').hidden, 'the cursor shows only while the roll has focus');
});

test('the view throws a loud error naming a missing id', () => {
  const document = scratchMarkup();
  document.getElementById('scratch-ruler').remove();
  assert.throws(() => createScratchView({ document, rootFontPx: () => REM }), /^Error: Moontide: the Scratchpad view needs #scratch-ruler in the page\./);
});

test('the view throws a loud error when it is not given the function that reads the root font size', () => {
  assert.throws(() => createScratchView({ document: scratchMarkup() }), /^TypeError: Moontide: the Scratchpad view needs rootFontPx, a function that gives the root font size in pixels\./);
});

test('focus shows the cursor and the line reads the cursor cell; blur hides the cursor and goes back to the empty state', () => {
  const { get, focus, blur, line } = setup();
  focus();
  assert.equal(get('scratch-cursor').hidden, false);
  assert.deepEqual(line(), { kind: 'cell', name: 'C4', rest: ' · cycle 1, beat 1 · empty', spoken: 'Row C4, cycle 1, beat 1, empty' });
  assert.equal(get('scratch-cursor').style.props.get('--sp-start'), '0');
  assert.equal(get('scratch-cursor').style.props.get('--sp-len'), '3');
  assert.equal(get('scratch-cursor').style.props.get('--sp-row'), '11');
  blur();
  assert.equal(get('scratch-cursor').hidden, true);
  assert.equal(line().kind, 'empty');
});

test('the arrows move the cursor one grid step or one semitone and stop at the ends of the motif', () => {
  const { press, focus, cursor, line, get } = setup();
  focus();
  press('ArrowLeft');
  assert.deepEqual(cursor(), { unit: 0, pitch: 60 });
  press('ArrowRight');
  press('ArrowRight');
  assert.deepEqual(cursor(), { unit: 6, pitch: 60 });
  assert.equal(line().spoken, 'Row C4, cycle 1, beat 1.5, empty');
  press('ArrowUp');
  assert.deepEqual(cursor(), { unit: 6, pitch: 61 });
  assert.equal(line().name, 'C#4');
  press('ArrowDown');
  press('ArrowDown');
  assert.deepEqual(cursor(), { unit: 6, pitch: 59 });
  assert.equal(get('scratch-cursor').style.props.get('--sp-start'), '6');
  for (let i = 0; i < 40; i += 1) press('ArrowRight');
  assert.equal(cursor().unit, 93, 'the last step of a 96-unit motif starts at 93');
});

test('Enter places a one-step note at the cursor and removes it again; the line reads each', () => {
  const { press, focus, notes, line, attr } = setup();
  focus();
  press('Enter');
  assert.deepEqual(notes(), [{ id: 1, pitch: 60, start: 0, length: 3, velocity: 80, label: 'C4, starts at cycle 1, beat 1, lasts 1 sixteenth (0.25 beat), velocity 0.80.', selected: false }]);
  assert.deepEqual(line(), { kind: 'notice', name: '', rest: 'Placed C4 at cycle 1, beat 1.', spoken: 'Placed C4 at cycle 1, beat 1.' });
  assert.equal(attr('scratch-view', 'data-notes'), '1');
  press('Enter');
  assert.deepEqual(notes(), []);
  assert.equal(line().spoken, 'Erased C4 at cycle 1, beat 1. Undo brings it back.');
  assert.equal(attr('scratch-view', 'data-notes'), '0');
});

test('moving the cursor clears the notice of the last edit, and the cell under the cursor is read again', () => {
  const { press, focus, line } = setup();
  focus();
  press('Enter');
  assert.equal(line().kind, 'notice');
  press('ArrowRight');
  assert.deepEqual(line(), { kind: 'cell', name: 'C4', rest: ' · cycle 1, beat 1.25 · empty', spoken: 'Row C4, cycle 1, beat 1.25, empty' });
  press('ArrowLeft');
  assert.deepEqual(line(), {
    kind: 'note',
    name: 'C4',
    rest: ' · cycle 1, beat 1 · length 1 sixteenth (0.25 beat) · velocity 0.80',
    spoken: 'C4, starts at cycle 1, beat 1, lasts 1 sixteenth (0.25 beat), velocity 0.80.',
  });
});

test('every handled key prevents the default, and a key the view does not take is left alone', () => {
  const { press, focus } = setup();
  focus();
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Backspace', 's', 'd', '[', ']']) {
    assert.equal(press(key).defaultPrevented, true, key);
  }
  for (const altKey of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.equal(press(altKey, { altKey: true }).defaultPrevented, true, `Alt+${altKey}`);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) assert.equal(press('a', extra).defaultPrevented, true, `select all ${JSON.stringify(extra)}`);
  for (const [key, extra] of [['a', {}], ['b', {}], ['c', {}], ['1', {}], ['7', {}], ['Escape', {}], ['Tab', {}], ['z', { ctrlKey: true }], ['z', { metaKey: true }], ['ArrowLeft', { ctrlKey: true }], ['Enter', { altKey: true }], ['Home', { altKey: true }], ['s', { altKey: true }], ['a', { altKey: true }]]) {
    assert.equal(press(key, extra).defaultPrevented, false, `${key} ${JSON.stringify(extra)}`);
  }
});

test('Shift+ArrowRight lengthens the note under the cursor by one step and Shift+ArrowLeft shortens it, never below one step', () => {
  const { press, focus, notes, line } = setup();
  focus();
  press('Enter');
  press('ArrowRight', { shiftKey: true });
  assert.equal(notes()[0].length, 6);
  assert.deepEqual(line(), { kind: 'notice', name: '', rest: 'C4 now lasts 2 sixteenths (0.5 beat).', spoken: 'C4 now lasts 2 sixteenths (0.5 beat).' });
  press('ArrowRight', { shiftKey: true });
  assert.equal(notes()[0].length, 9);
  press('ArrowLeft', { shiftKey: true });
  press('ArrowLeft', { shiftKey: true });
  assert.equal(notes()[0].length, 3);
  press('ArrowLeft', { shiftKey: true });
  assert.equal(notes()[0].length, 3, 'one step is the shortest');
  assert.equal(notes()[0].label, 'C4, starts at cycle 1, beat 1, lasts 1 sixteenth (0.25 beat), velocity 0.80.');
});

test('a note cannot be lengthened past the end of the motif', () => {
  const { press, focus, notes } = setup();
  focus();
  press('End');
  press('Enter');
  press('ArrowRight', { shiftKey: true });
  assert.deepEqual([notes()[0].start, notes()[0].length], [93, 3]);
});

test('with no note under the cursor Shift+arrow, Delete and Backspace change nothing and say so', () => {
  const { press, focus, notes, line, attr } = setup();
  focus();
  for (const [key, extra] of [['ArrowRight', { shiftKey: true }], ['ArrowLeft', { shiftKey: true }], ['Delete', {}], ['Backspace', {}]]) {
    press(key, extra);
    assert.deepEqual(line(), { kind: 'notice', name: '', rest: SCRATCH_COPY.noNote, spoken: SCRATCH_COPY.noNote }, `${key} ${JSON.stringify(extra)}`);
    press('ArrowRight');
    press('ArrowLeft');
  }
  assert.deepEqual(notes(), []);
  assert.equal(attr('scratch-view', 'data-notes'), '0');
});

test('with a note selected the arrows move it one step or one semitone and the cursor follows; Alt moves it one beat or one octave', () => {
  const { press, focus, notes, cursor, line, attr } = setup();
  focus();
  press('Enter');
  press('s');
  assert.equal(attr('scratch-view', 'data-selected'), '1');
  press('ArrowRight');
  assert.deepEqual([notes()[0].start, notes()[0].pitch], [3, 60]);
  assert.deepEqual(cursor(), { unit: 3, pitch: 60 });
  assert.equal(line().spoken, 'Moved C4 to cycle 1, beat 1.25.');
  press('ArrowUp');
  assert.deepEqual([notes()[0].start, notes()[0].pitch], [3, 61]);
  assert.deepEqual(cursor(), { unit: 3, pitch: 61 });
  assert.equal(line().spoken, 'Moved C4 to C#4 at cycle 1, beat 1.25.');
  press('ArrowLeft');
  press('ArrowDown');
  assert.deepEqual([notes()[0].start, notes()[0].pitch], [0, 60]);
  press('ArrowRight', { altKey: true });
  assert.deepEqual([notes()[0].start, notes()[0].pitch], [12, 60], 'one beat is 12 units');
  press('ArrowUp', { altKey: true });
  assert.deepEqual([notes()[0].start, notes()[0].pitch], [12, 72], 'one octave');
  assert.equal(attr('scratch-view', 'data-window-start'), '48', 'the base window stays; the rows grow to the note instead');
  assert.equal(attr('scratch-view', 'data-row-high'), '83');
  assert.deepEqual(cursor(), { unit: 12, pitch: 72 });
  press('ArrowDown', { altKey: true });
  press('ArrowLeft', { altKey: true });
  assert.deepEqual([notes()[0].start, notes()[0].pitch], [0, 60]);
  assert.equal(attr('scratch-view', 'data-selected'), '1', 'the selection stays with the note');
});

test('with nothing selected the arrows move the cursor, and Alt moves it one beat or one octave', () => {
  const { press, focus, notes, cursor, attr } = setup();
  focus();
  press('Enter');
  press('ArrowRight', { altKey: true });
  assert.deepEqual(cursor(), { unit: 12, pitch: 60 });
  press('ArrowUp', { altKey: true });
  assert.deepEqual(cursor(), { unit: 12, pitch: 72 });
  press('ArrowLeft', { altKey: true });
  press('ArrowDown', { altKey: true });
  assert.deepEqual(cursor(), { unit: 0, pitch: 60 });
  press('ArrowLeft', { altKey: true });
  assert.deepEqual(cursor(), { unit: 0, pitch: 60 }, 'the cursor stops at the start of the motif');
  assert.deepEqual(notes().map((note) => [note.start, note.pitch]), [[0, 60]], 'no note moved');
  assert.equal(attr('scratch-view', 'data-selected'), '');
});

test('Delete and Backspace erase the note under the cursor with the erase notice', () => {
  const { press, focus, notes, line } = setup();
  focus();
  press('Enter');
  press('Delete');
  assert.deepEqual(notes(), []);
  assert.equal(line().spoken, 'Erased C4 at cycle 1, beat 1. Undo brings it back.');
  press('Enter');
  press('Backspace');
  assert.deepEqual(notes(), []);
  assert.equal(line().kind, 'notice');
});

test('Home and End put the cursor on the first and the last step of the motif', () => {
  const { press, focus, cursor } = setup();
  focus();
  press('ArrowRight');
  press('ArrowUp');
  press('End');
  assert.deepEqual(cursor(), { unit: 93, pitch: 61 });
  press('Home');
  assert.deepEqual(cursor(), { unit: 0, pitch: 61 });
});

test('the rows follow the cursor: Up past the base brings in the next octave and Down takes it away again, the base never moves', () => {
  const { press, focus, cursor, attr, get } = setup();
  focus();
  for (let i = 0; i < 9; i += 1) press('ArrowUp');
  assert.deepEqual(cursor(), { unit: 0, pitch: 69 });
  assert.equal(attr('scratch-view', 'data-rows'), '24', 'A4 with its margin is still inside B4');
  press('ArrowUp');
  assert.deepEqual(cursor(), { unit: 0, pitch: 70 });
  assert.equal(attr('scratch-view', 'data-rows'), '36', 'A#4 with its margin reaches C5, so the next octave comes in');
  assert.equal(attr('scratch-view', 'data-row-low'), '48');
  assert.equal(attr('scratch-view', 'data-row-high'), '83');
  assert.equal(attr('scratch-view', 'data-window-start'), '48');
  assert.equal(get('scratch-roll').style.props.get('--sp-rows'), '36');
  assert.equal(get('scratch-gutter').children.length, 36);
  assert.equal(get('scratch-gutter').children[0].textContent, '', 'the top cell is B5, not named');
  assert.equal(get('scratch-gutter').children[11].textContent, 'C5');
  assert.equal(get('scratch-gutter').children[23].textContent, 'C4');
  assert.equal(get('scratch-gutter').children[35].textContent, 'C3');
  assert.equal(get('scratch-window').textContent, 'C3–B5');
  press('ArrowDown');
  assert.equal(attr('scratch-view', 'data-rows'), '24', 'derived again, not stored: the extra octave goes with the cursor');
  assert.equal(get('scratch-gutter').children.length, 24);
  for (let i = 0; i < 21; i += 1) press('ArrowDown');
  assert.deepEqual(cursor(), { unit: 0, pitch: 48 });
  assert.equal(attr('scratch-view', 'data-rows'), '36', 'C3 minus its margin reaches B2');
  assert.equal(attr('scratch-view', 'data-row-low'), '36');
  assert.equal(attr('scratch-view', 'data-window-start'), '48');
});

// A motif of notes a long way apart, written with the keyboard: Alt and the arrows move the cursor an octave, Enter writes a note.
function wideMotif() {
  const t = setup();
  t.focus();
  t.press('ArrowDown', { altKey: true });
  t.press('Enter');
  for (let i = 0; i < 3; i += 1) t.press('ArrowUp', { altKey: true });
  t.press('Enter');
  return t;
}

test('a motif over three octaves is shown whole: every note is drawn on its own row, and the piano names cover every row', () => {
  const { notes, attr, get } = wideMotif();
  assert.deepEqual(notes().map((note) => note.pitch), [84, 48], 'in time order, the higher of two together first');
  assert.equal(attr('scratch-view', 'data-rows'), '60');
  assert.equal(attr('scratch-view', 'data-row-low'), '36');
  assert.equal(attr('scratch-view', 'data-row-high'), '95');
  assert.equal(get('scratch-roll').style.props.get('--sp-rows'), '60');
  assert.equal(get('scratch-gutter').children.length, 60);
  assert.deepEqual(get('scratch-notes').children.map((element) => element.style.props.get('--sp-row')), ['11', '47'], 'the row of a note is the top pitch minus its pitch');
  assert.equal(get('scratch-window').textContent, 'C2–B6');
  assert.equal(attr('scratch-window', 'aria-label'), 'C2 to B6');
  assert.deepEqual(get('scratch-gutter').children.map((cell) => cell.textContent).filter((text) => text !== ''), ['C6', 'C5', 'C4', 'C3', 'C2']);
});

test('after Clear the rows are the base and the cursor again, and Undo shows every note again with no extra step', () => {
  const { notes, attr, get } = wideMotif();
  get('scratch-clear').dispatch('click');
  assert.deepEqual(notes(), []);
  assert.equal(attr('scratch-view', 'data-rows'), '48', 'the base and the cursor, which stayed on C6');
  assert.equal(attr('scratch-view', 'data-row-low'), '48');
  assert.equal(attr('scratch-view', 'data-row-high'), '95');
});

test('Undo of Clear and Redo show the notes again: the rows are worked out from the notes each time', () => {
  const { notes, attr, get } = wideMotif();
  get('scratch-clear').dispatch('click');
  get('scratch-undo').dispatch('click');
  assert.equal(notes().length, 2);
  assert.equal(attr('scratch-view', 'data-rows'), '60');
  assert.equal(attr('scratch-view', 'data-row-low'), '36');
  assert.equal(attr('scratch-view', 'data-row-high'), '95');
  get('scratch-redo').dispatch('click');
  assert.equal(notes().length, 0);
  assert.equal(attr('scratch-view', 'data-rows'), '48');
  get('scratch-undo').dispatch('click');
  assert.equal(notes().length, 2);
  assert.equal(get('scratch-gutter').children.length, 60);
});

test('Record that and Align show the notes with no extra step', () => {
  const t = recordSetup();
  t.view.record({ start: 0, cycles: 8, notes: [{ pitch: 40, velocity: 100, start: 0, end: 0.25, run: null }, { pitch: 100, velocity: 100, start: 0.5, end: 0.75, run: null }] });
  assert.equal(t.notes().length, 2, 'both notes are drawn, though they are five octaves apart');
  assert.equal(t.attr('scratch-view', 'data-row-low'), '36');
  assert.equal(t.attr('scratch-view', 'data-row-high'), '107');
  t.get('scratch-align').dispatch('click');
  assert.equal(t.notes().length, 2);
  assert.equal(t.attr('scratch-view', 'data-rows'), '72');
});

test('the piano cells are built once and reused: the first 24 stay the same elements when the rows grow and shrink', () => {
  const { press, focus, get, document } = setup();
  const first = [...get('scratch-gutter').children];
  assert.equal(first.length, 24);
  focus();
  for (let i = 0; i < 10; i += 1) press('ArrowUp');
  const grown = get('scratch-gutter').children;
  assert.equal(grown.length, 36);
  assert.ok(first.every((cell, index) => cell === grown[index]), 'the cells already built are kept');
  const made = document.created;
  press('ArrowDown');
  assert.equal(get('scratch-gutter').children.length, 24);
  for (let i = 0; i < 5; i += 1) {
    press('ArrowUp');
    press('ArrowDown');
  }
  assert.equal(document.created, made, 'no cell is built again once it has been built');
});

test('a motif from C0 to B8 builds 108 rows and no more', () => {
  const { press, focus, get, attr, notes } = setup();
  focus();
  for (let i = 0; i < 4; i += 1) press('ArrowDown', { altKey: true });
  press('Enter');
  for (let i = 0; i < 12; i += 1) press('ArrowUp', { altKey: true });
  press('Enter');
  assert.deepEqual(notes().map((note) => note.pitch), [119, 12]);
  assert.equal(attr('scratch-view', 'data-rows'), '108');
  assert.equal(get('scratch-gutter').children.length, 108);
  assert.equal(get('scratch-window').textContent, 'C0–B8');
  assert.equal(get('scratch-gutter').children[0].textContent, 'B8', 'the top cell is B8, named because the cursor is on it');
  assert.equal(get('scratch-gutter').children[107].textContent, 'C0');
});

test('a pointer lands on the right pitch and unit whatever the number of rows shown', () => {
  const { press, focus, grid, notes, x, dbl, attr, drawOn, down, move, up } = setup();
  focus();
  for (let i = 0; i < 10; i += 1) press('ArrowUp');
  assert.equal(attr('scratch-view', 'data-rows'), '36');
  // 36 rows in the same 10 pixels a row: the grid is 360 high and its top row is B5 (83).
  grid.rect = { ...grid.rect, height: 360 };
  const at = (pitch) => 50 + (83 - pitch) * 10 + 5;
  dbl(x(6), at(80));
  dbl(x(30), at(55));
  assert.deepEqual(notes().map((note) => [note.pitch, note.start]), [[80, 6], [55, 30]]);
  drawOn();
  down(x(60), at(75));
  move(x(66), at(75));
  up(x(66), at(75));
  assert.equal(notes().find((note) => note.start === 60).pitch, 75);
});

test('a selection box over a tall range selects the notes it touches', () => {
  const { press, focus, grid, notes, x, dbl, attr, down, move, up } = setup();
  focus();
  for (let i = 0; i < 10; i += 1) press('ArrowUp');
  grid.rect = { ...grid.rect, height: 360 };
  const at = (pitch) => 50 + (83 - pitch) * 10 + 5;
  dbl(x(6), at(80));
  dbl(x(30), at(55));
  down(x(0), at(82));
  move(x(20), at(78));
  up(x(20), at(78));
  assert.equal(attr('scratch-view', 'data-selected-count'), '1');
  assert.equal(notes().filter((note) => note.selected).map((note) => note.pitch).join(), '80');
});

test('PageUp and PageDown move the window one octave and the cursor keeps its row; the window stays from 12 to 96', () => {
  const { press, focus, cursor, attr } = setup();
  focus();
  press('PageUp');
  assert.equal(attr('scratch-view', 'data-window-start'), '60');
  assert.deepEqual(cursor(), { unit: 0, pitch: 72 });
  press('PageUp');
  press('PageUp');
  press('PageUp');
  assert.equal(attr('scratch-view', 'data-window-start'), '96');
  assert.equal(cursor().pitch, 108);
  press('PageUp');
  assert.equal(attr('scratch-view', 'data-window-start'), '96', 'no window above C7');
  assert.equal(cursor().pitch, 108);
  for (let i = 0; i < 20; i += 1) press('PageDown');
  assert.equal(attr('scratch-view', 'data-window-start'), '12', 'no window below C0');
  assert.equal(cursor().pitch, 24);
});

test('the cursor reaches every pitch from C0 to B8 and stops at the ends, and the rows follow it', () => {
  const { press, focus, cursor, attr, get } = setup();
  focus();
  for (let i = 0; i < 200; i += 1) press('ArrowUp');
  assert.equal(cursor().pitch, 119);
  assert.equal(attr('scratch-view', 'data-row-low'), '48');
  assert.equal(attr('scratch-view', 'data-row-high'), '119');
  assert.equal(attr('scratch-view', 'data-window-start'), '48');
  assert.equal(get('scratch-gutter').children.length, 72);
  for (let i = 0; i < 200; i += 1) press('ArrowDown');
  assert.equal(cursor().pitch, 12);
  assert.equal(attr('scratch-view', 'data-row-low'), '12');
  assert.equal(attr('scratch-view', 'data-row-high'), '71');
  assert.equal(attr('scratch-view', 'data-window-start'), '48');
});

test('a note beyond the base window is drawn, and the rows are the same whichever way the base was moved', () => {
  const { press, focus, notes, attr } = setup();
  focus();
  press('Enter');
  press('PageUp');
  press('PageUp');
  assert.equal(attr('scratch-view', 'data-window-start'), '72');
  assert.equal(notes().length, 1, 'drawn: the rows grow down to the C3 octave the note is in');
  assert.equal(attr('scratch-view', 'data-notes'), '1');
  assert.equal(attr('scratch-view', 'data-row-low'), '48');
  assert.equal(attr('scratch-view', 'data-row-high'), '95');
  press('PageDown');
  press('PageDown');
  assert.equal(notes().length, 1);
  assert.equal(attr('scratch-view', 'data-rows'), '24');
});

test('each note is an element with its spoken form as its name, placed through custom properties only', () => {
  const { press, focus, get } = setup();
  focus();
  press('ArrowRight');
  press('ArrowUp');
  press('Enter');
  press('ArrowRight', { shiftKey: true });
  const [element] = get('scratch-notes').children;
  assert.equal(element.getAttribute('role'), 'img');
  assert.equal(element.getAttribute('aria-label'), 'C#4, starts at cycle 1, beat 1.25, lasts 2 sixteenths (0.5 beat), velocity 0.80.');
  assert.equal(element.style.props.get('--sp-start'), '3');
  assert.equal(element.style.props.get('--sp-len'), '6');
  assert.equal(element.style.props.get('--sp-row'), '10');
  assert.equal(element.style.props.get('--v'), '0.8');
  assert.equal(element.style.width, '', 'the view writes no width');
  assert.equal(element.style.left, undefined, 'the view writes no left');
});

test('the cursor on a note selects nothing by itself: the selection is changed by a click, a box, a double-click or a key', () => {
  const { press, focus, blur, notes, attr, line } = setup();
  focus();
  press('Enter');
  assert.equal(attr('scratch-view', 'data-selected'), '');
  assert.equal(notes()[0].selected, false);
  press('ArrowRight');
  press('ArrowLeft');
  assert.equal(attr('scratch-view', 'data-selected'), '', 'the cursor came back onto the note and still selects nothing');
  assert.equal(attr('scratch-view', 'data-selected-count'), '0');
  blur();
  assert.equal(line().kind, 'summary', 'without focus and without a selection the line reads the summary');
  press('Delete');
  assert.deepEqual(notes(), [], 'Delete still erases the note under the cursor');
});

test('a note that cuts or merges another says so in the line', () => {
  const { press, focus, notes, line } = setup();
  focus();
  press('Enter');
  press('ArrowRight', { shiftKey: true });
  press('ArrowRight', { shiftKey: true });
  press('ArrowRight', { shiftKey: true });
  assert.equal(notes()[0].length, 12);
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowUp');
  press('Enter');
  press('s');
  press('ArrowDown');
  assert.deepEqual(notes().map((note) => [note.pitch, note.start, note.length]), [[60, 0, 6], [60, 6, 3]]);
  assert.equal(line().spoken, 'Moved C#4 to C4 at cycle 1, beat 1.5. 1 note cut where a note of the same pitch starts.');
});

test('a length that stops at the next note of the same pitch says so', () => {
  const { press, focus, notes, line } = setup();
  focus();
  press('ArrowRight');
  press('ArrowRight');
  press('Enter');
  press('Home');
  press('Enter');
  for (let i = 0; i < 3; i += 1) press('ArrowRight', { shiftKey: true });
  assert.deepEqual(notes().map((note) => [note.start, note.length]), [[0, 6], [6, 3]]);
  assert.equal(line().spoken, 'C4 now lasts 2 sixteenths (0.5 beat). 1 note cut where a note of the same pitch starts.');
});

test('a move that would leave the motif says why, changes nothing and adds no undo step', () => {
  const { press, focus, line, notes, get } = setup();
  focus();
  press('Enter');
  press('s');
  press('ArrowLeft');
  assert.equal(line().spoken, 'Not moved: the first note is already at the start of the motif.');
  assert.equal(notes()[0].start, 0);
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  press('ArrowUp', { altKey: true });
  assert.equal(line().spoken, 'Not moved: a note is already at the highest pitch.');
  assert.equal(get('scratch-undo').getAttribute('aria-disabled'), 'false', 'the first move is an undo step');
  assert.equal(notes()[0].pitch, 108, 'the last whole octave that fits: 60 + 4 octaves is 108, 120 is past B8');
});

test('a cursor move that leaves the visible part of the roll scrolls the box, instantly', () => {
  const { press, focus, get } = setup();
  const scroll = get('scratch-scroll');
  scroll.rect = { left: 0, right: 500, width: 500, top: 0, bottom: 0, height: 0 };
  get('scratch-gutter').rect = { left: 0, right: 48, width: 48, top: 0, bottom: 0, height: 0 };
  get('scratch-grid').rect = { left: 48, right: 1008, width: 960, top: 0, bottom: 0, height: 0 };
  focus();
  press('End');
  assert.equal(scroll.scrollLeft, 508, 'the last step ends at 1008, 508 past the right edge');
  get('scratch-grid').rect = { left: -400, right: 560, width: 960, top: 0, bottom: 0, height: 0 };
  press('Home');
  assert.equal(scroll.scrollLeft, 508 - 448, 'the first step starts 448 left of the piano names');
  const before = scroll.scrollLeft;
  get('scratch-grid').rect = { left: 48, right: 1008, width: 960, top: 0, bottom: 0, height: 0 };
  press('ArrowRight');
  assert.equal(scroll.scrollLeft, before, 'a step already in view does not scroll');
});

test('a cursor move that takes the cursor row out of a vertically scrolled box scrolls it so the row shows, instantly', () => {
  const { press, focus, get, grid } = setup();
  const scroll = get('scratch-scroll');
  // The ruler is held at the top of the box (its bottom is at 20) and the lane at its bottom (its top is at 300); the grid is 36 rows once the cursor is high.
  get('scratch-ruler').rect = { left: 0, right: 500, top: 0, bottom: 20, width: 500, height: 20 };
  get('scratch-lane').rect = { left: 0, right: 500, top: 300, bottom: 360, width: 500, height: 60 };
  focus();
  for (let i = 0; i < 10; i += 1) press('ArrowUp');
  assert.equal(get('scratch-roll').style.props.get('--sp-rows'), '36');
  scroll.scrollTop = 500;
  grid.rect = { left: 48, right: 1008, top: -200, bottom: 160, width: 960, height: 360 };
  press('ArrowUp');
  assert.equal(scroll.scrollTop, 400, 'the cursor row (B4) starts 100 above the ruler: the box scrolls up by 100');
  grid.rect = { left: 48, right: 1008, top: 200, bottom: 560, width: 960, height: 360 };
  press('ArrowRight');
  assert.equal(scroll.scrollTop, 430, 'the cursor row (B4) ends 30 below the lane: the box scrolls down by 30');
  grid.rect = { left: 48, right: 1008, top: 20, bottom: 380, width: 960, height: 360 };
  press('ArrowRight');
  assert.equal(scroll.scrollTop, 430, 'a row already in view does not scroll');
});

test('a cursor move scrolls the box vertically only when the ruler and the lane have a measured place', () => {
  const { press, focus, get } = setup();
  const scroll = get('scratch-scroll');
  focus();
  for (let i = 0; i < 12; i += 1) press('ArrowUp');
  press('ArrowDown', { altKey: true });
  assert.equal(scroll.scrollTop, 0, 'the lane has no place in this document, so nothing is scrolled');
});

test('drawing the same state again writes nothing', () => {
  const { document, press, focus, view } = setup();
  focus();
  press('Enter');
  press('ArrowRight', { shiftKey: true });
  press('PageUp');
  press('PageDown');
  const writes = document.writes;
  const created = document.created;
  view.render();
  view.render();
  assert.equal(document.writes, writes);
  assert.equal(document.created, created);
});

test('closed() hides the cursor and clears the notice, and render() brings the line back', () => {
  const { press, focus, view, get, line } = setup();
  focus();
  press('Enter');
  assert.equal(line().kind, 'notice');
  view.closed();
  assert.equal(get('scratch-cursor').hidden, true);
  assert.notEqual(line().kind, 'notice');
  assert.equal(line().kind, 'summary', 'with no selection the line reads the summary');
});

test('the view keeps its motif when it is closed and opened again', () => {
  const { press, focus, view, notes } = setup();
  focus();
  press('Enter');
  view.closed();
  view.render();
  assert.equal(notes().length, 1);
});

// --- the mouse: drawing, selecting and hovering ---

const NOTE_AT_START = { id: 1, pitch: 60, start: 12, length: 9, velocity: 80 };

test('a press, two moves and a release on empty cells draw one note of the dragged length at 0.80 and select it', () => {
  const { down, move, up, x, y, notes, attr, grid, hidden, prop, line, cursor, get, drawOn } = setup();
  drawOn();
  down(x(12), y(60));
  assert.equal(grid.capturedPointer, 1, 'the grid keeps the pointer for the press');
  assert.equal(hidden('scratch-preview'), true, 'the preview waits for the pointer to move');
  move(x(16), y(60));
  assert.equal(hidden('scratch-preview'), false);
  assert.deepEqual([prop('scratch-preview', '--sp-start'), prop('scratch-preview', '--sp-len'), prop('scratch-preview', '--sp-row')], ['12', '6', '11']);
  move(x(20), y(55));
  assert.deepEqual([prop('scratch-preview', '--sp-start'), prop('scratch-preview', '--sp-len'), prop('scratch-preview', '--sp-row')], ['12', '9', '11'], 'the pitch is the row of the press');
  assert.equal(hidden('scratch-note-hover'), false, 'the line follows the preview');
  assert.equal(get('scratch-note-hover').textContent, 'C4 · cycle 1, beat 2 · length 3 sixteenths (0.75 beat) · velocity 0.80');
  assert.deepEqual(notes(), [], 'nothing is committed before the release');
  up(x(20), y(55));
  assert.deepEqual(notes().map(({ label, ...note }) => note), [{ ...NOTE_AT_START, selected: true }]);
  assert.equal(attr('scratch-view', 'data-selected'), '1');
  assert.equal(attr('scratch-view', 'data-notes'), '1');
  assert.equal(hidden('scratch-preview'), true);
  assert.equal(hidden('scratch-note-hover'), true);
  assert.equal(grid.capturedPointer, null, 'the pointer is let go');
  assert.equal(line().spoken, 'Placed C4 at cycle 1, beat 2.');
  assert.deepEqual(cursor(), { unit: 18, pitch: 60 }, 'the cursor stands on the step under the pointer');
});

test('a drag draws on the row of the press at any length up to the end of the motif, and a drag back past the start gives one step', () => {
  const { down, move, up, x, y, notes, drawOn } = setup();
  drawOn();
  down(x(90), y(67));
  move(x(150), y(67));
  up(x(150), y(67));
  assert.deepEqual(notes().map((note) => [note.pitch, note.start, note.length]), [[67, 90, 6]], 'the note ends with the motif');
  down(x(30), y(65));
  move(x(20), y(65));
  up(x(10), y(65));
  assert.deepEqual(notes().map((note) => [note.pitch, note.start, note.length]), [[65, 30, 3], [67, 90, 6]]);
});

test('a press and a release without movement write no note, in Draw mode as in Select mode: the cursor goes to the cell and the selection is cleared', () => {
  for (const mode of ['select', 'draw']) {
    const { down, up, x, y, notes, hidden, drawOn, cursor, attr } = setup();
    if (mode === 'draw') drawOn();
    down(x(31), y(62));
    assert.equal(hidden('scratch-preview'), true, mode);
    assert.equal(hidden('scratch-select-rect'), true, mode);
    up(x(31), y(62));
    assert.deepEqual(notes(), [], `${mode}: a click never writes a note`);
    assert.equal(attr('scratch-view', 'data-notes'), '0', mode);
    assert.deepEqual(cursor(), { unit: 30, pitch: 62 }, `${mode}: the cursor stands on the cell that was clicked`);
  }
});

test('a press with another button, or outside the grid starts nothing', () => {
  const { down, up, x, y, notes, grid, drawOn } = setup();
  drawOn();
  down(x(12), y(60), { button: 2 });
  up(x(12), y(60), { button: 2 });
  down(x(12), y(60), { button: 1 });
  up(x(12), y(60), { button: 1 });
  down(50, 100);
  up(50, 100);
  assert.deepEqual(notes(), []);
  assert.equal(grid.captures, 0);
});

test('a second pointer is ignored while a press is on', () => {
  const { down, move, up, pointer, x, y, notes, drawOn } = setup();
  drawOn();
  down(x(12), y(60));
  pointer('pointerdown', x(40), y(70), { pointerId: 2 });
  pointer('pointermove', x(50), y(70), { pointerId: 2 });
  pointer('pointerup', x(50), y(70), { pointerId: 2 });
  assert.deepEqual(notes(), [], 'the other pointer committed nothing');
  move(x(14), y(60));
  up(x(14), y(60));
  assert.deepEqual(notes().map((note) => [note.pitch, note.start, note.length]), [[60, 12, 3]]);
});

test('a click on a note selects it, puts the cursor on it and leaves the motif as it was', () => {
  const { press, focus, down, up, x, y, notes, attr, cursor, line, drawOn } = setup();
  drawOn();
  focus();
  press('Enter');
  for (let i = 0; i < 4; i += 1) press('ArrowRight');
  press('ArrowUp');
  assert.equal(attr('scratch-view', 'data-selected'), '');
  const before = notes();
  down(x(1), y(60));
  up(x(1), y(60));
  assert.equal(attr('scratch-view', 'data-selected'), '1');
  assert.equal(notes()[0].selected, true);
  assert.deepEqual(cursor(), { unit: 0, pitch: 60 });
  assert.equal(attr('scratch-view', 'data-notes'), '1');
  assert.deepEqual(notes().map(({ selected, ...note }) => note), before.map(({ selected, ...note }) => note));
  assert.equal(line().kind, 'note', 'the line reads the note and no longer the last edit');
});

test('a double-click on an empty cell writes a note and a click on a second note selects that one', () => {
  const { down, up, x, y, notes, attr, dbl } = setup();
  dbl(x(0), y(60));
  dbl(x(30), y(60));
  assert.equal(notes().length, 2);
  assert.equal(attr('scratch-view', 'data-selected'), '2', 'the note just written is the selection');
  down(x(1), y(60));
  up(x(1), y(60));
  assert.equal(notes().length, 2, 'a click on a note writes nothing');
  assert.equal(attr('scratch-view', 'data-selected'), '1');
});

test('a note drawn on the same pitch inside an earlier note cuts it, and the line says so', () => {
  const { down, move, up, x, y, notes, line, drawOn, dbl } = setup();
  drawOn();
  down(x(0), y(60));
  move(x(20), y(60));
  up(x(20), y(60));
  assert.equal(notes()[0].length, 21);
  dbl(x(30), y(60));
  assert.equal(notes().length, 2);
  dbl(x(9), y(61));
  assert.equal(line().spoken, 'Placed C#4 at cycle 1, beat 1.75.');
});

test('hovering a note shows its line over the information line, outlines it and does not touch the live region', () => {
  const { move, x, y, notes, hidden, get, line, press, focus, blur } = setup();
  focus();
  press('Enter');
  blur();
  const spoken = line().spoken;
  move(x(1), y(60));
  assert.equal(hidden('scratch-note-hover'), false);
  assert.equal(get('scratch-note-hover').getAttribute('aria-hidden'), 'true');
  assert.equal(get('scratch-note-hover').textContent, 'C4 · cycle 1, beat 1 · length 1 sixteenth (0.25 beat) · velocity 0.80');
  assert.equal(line().spoken, spoken, 'the live region is not written by a hover');
  assert.ok(get('scratch-notes').children[0].className.split(' ').includes('sp-hover'));
  assert.equal(hidden('scratch-hover-cell'), true);
  assert.equal(notes().length, 1);
});

test('hovering an empty cell outlines the snapped cell a drag would write in, in Draw mode only; leaving the grid hides it', () => {
  const { move, x, y, hidden, prop, grid, drawOn } = setup();
  move(x(31), y(62));
  assert.equal(hidden('scratch-hover-cell'), true, 'in Select mode a drag starts a box, so no cell is outlined');
  drawOn();
  move(x(33), y(62));
  move(x(31), y(62));
  assert.equal(hidden('scratch-hover-cell'), false);
  assert.deepEqual([prop('scratch-hover-cell', '--sp-start'), prop('scratch-hover-cell', '--sp-len'), prop('scratch-hover-cell', '--sp-row')], ['30', '3', '9']);
  assert.equal(hidden('scratch-note-hover'), true);
  move(x(33), y(62));
  assert.equal(prop('scratch-hover-cell', '--sp-start'), '33');
  grid.dispatch('pointerleave', { pointerId: 1 });
  assert.equal(hidden('scratch-hover-cell'), true);
  assert.equal(hidden('scratch-note-hover'), true);
});

test('moving from a note to an empty cell and off the grid takes the outline and the hover line away', () => {
  const { dbl, move, x, y, hidden, get, grid, drawOn } = setup();
  drawOn();
  dbl(x(0), y(60));
  move(x(1), y(60));
  assert.ok(get('scratch-notes').children[0].className.includes('sp-hover'));
  move(x(40), y(60));
  assert.ok(!get('scratch-notes').children[0].className.includes('sp-hover'));
  assert.equal(hidden('scratch-note-hover'), true);
  assert.equal(hidden('scratch-hover-cell'), false);
  move(x(1), y(60));
  grid.dispatch('pointerleave', { pointerId: 1 });
  assert.ok(!get('scratch-notes').children[0].className.includes('sp-hover'));
});

test('a pointer move inside the same cell writes nothing', () => {
  const { document, move, x, y } = setup();
  move(x(31), y(62));
  const writes = document.writes;
  move(x(32), y(62));
  move(x(31) + 0.5, y(62) + 2);
  assert.equal(document.writes, writes);
});

test('there is no hover while a press is on, and the note just drawn is read under the pointer after the release', () => {
  const { down, move, up, x, y, hidden, get, drawOn } = setup();
  drawOn();
  move(x(31), y(62));
  down(x(31), y(62));
  assert.equal(hidden('scratch-hover-cell'), true, 'the draw has its own preview');
  assert.equal(hidden('scratch-note-hover'), true);
  move(x(35), y(62));
  up(x(35), y(62));
  assert.equal(hidden('scratch-hover-cell'), true, 'a note stands under the pointer now');
  assert.equal(hidden('scratch-note-hover'), false);
  assert.ok(get('scratch-notes').children[0].className.includes('sp-hover'));
  move(x(45), y(62));
  assert.equal(hidden('scratch-hover-cell'), false);
});

test('a pointer lost mid-draw commits nothing: pointercancel, lostpointercapture, cancelGesture and closed each end the draw', () => {
  const ways = [
    ['pointercancel', ({ grid }) => grid.dispatch('pointercancel', { pointerId: 1 })],
    ['lostpointercapture', ({ grid }) => grid.dispatch('lostpointercapture', { pointerId: 1 })],
    ['cancelGesture', ({ view }) => view.cancelGesture()],
    ['closed', ({ view }) => view.closed()],
  ];
  for (const [name, end] of ways) {
    const t = setup();
  t.drawOn();
    t.down(t.x(12), t.y(60));
    t.move(t.x(20), t.y(60));
    assert.equal(t.hidden('scratch-preview'), false, name);
    end(t);
    assert.deepEqual(t.notes(), [], name);
    assert.equal(t.hidden('scratch-preview'), true, name);
    assert.equal(t.hidden('scratch-note-hover'), true, name);
    assert.equal(t.attr('scratch-view', 'data-notes'), '0', name);
    t.up(t.x(20), t.y(60));
    assert.deepEqual(t.notes(), [], `${name}: a release after the cancel draws nothing`);
  }
});

test('another pointer id losing its capture does not end the press', () => {
  const { down, move, up, pointer, x, y, notes, drawOn } = setup();
  drawOn();
  down(x(12), y(60));
  move(x(20), y(60));
  pointer('pointercancel', x(20), y(60), { pointerId: 2 });
  up(x(20), y(60));
  assert.equal(notes().length, 1);
});

// --- the mouse: moving, resizing, erasing, scrolling at the edge and the cancels ---

// A note of 9 units at C4 from unit 12 (pixels 220 to 310 along the grid), drawn the way a person draws it.
function withNote() {
  const t = setup();
  t.drawOn();
  t.down(t.x(12), t.y(60));
  t.move(t.x(20), t.y(60));
  t.up(t.x(20), t.y(60));
  assert.equal(t.notes().length, 1);
  return t;
}
const fields = (list) => list.map((note) => [note.pitch, note.start, note.length]);

test('a press on a note that moves past a quarter of a rem becomes a move: the ghost follows, the release commits once', () => {
  const { down, move, up, x, y, notes, hidden, prop, get, line, attr, cursor } = withNote();
  down(x(14), y(60));
  move(x(14) + 2, y(60));
  assert.equal(hidden('scratch-preview'), true, 'two pixels are still a click');
  move(x(20), y(62));
  assert.equal(hidden('scratch-preview'), false);
  assert.deepEqual([prop('scratch-preview', '--sp-start'), prop('scratch-preview', '--sp-len'), prop('scratch-preview', '--sp-row')], ['18', '9', '9']);
  assert.equal(get('scratch-note-hover').textContent, 'D4 · cycle 1, beat 2.5 · length 3 sixteenths (0.75 beat) · velocity 0.80');
  assert.deepEqual(fields(notes()), [[60, 12, 9]], 'the note stays where it was until the release');
  up(x(20), y(62));
  assert.deepEqual(fields(notes()), [[62, 18, 9]]);
  assert.equal(notes()[0].id, 1, 'the same note moved');
  assert.equal(attr('scratch-view', 'data-selected'), '1');
  assert.equal(hidden('scratch-preview'), true);
  assert.equal(line().spoken, 'Moved C4 to D4 at cycle 1, beat 2.5.');
  assert.equal(cursor().pitch, 62);
  assert.ok(cursor().unit >= 18 && cursor().unit <= 24, 'the cursor stands on the moved note');
});

test('the last place shown is the place committed, whatever the pointer did since', () => {
  const { down, move, up, x, y, notes } = withNote();
  down(x(14), y(60));
  move(x(26), y(60));
  move(x(15), y(60));
  up(x(15), y(60));
  assert.deepEqual(fields(notes()), [[60, 12, 9]], 'dragged back to where it began');
});

test('a move keeps the length, snaps the start to the grid with a tie to the earlier line, and stays inside the motif', () => {
  const { down, move, up, x, y, notes } = withNote();
  down(x(14), y(60));
  move(x(14) + 45, y(60));
  up(x(14) + 45, y(60));
  assert.deepEqual(fields(notes()), [[60, 15, 9]], 'a drag of 4.5 units from 12 lands on line 15, the earlier of 15 and 18');
  down(x(17), y(60));
  move(x(17) - 1000, y(60));
  up(x(17) - 1000, y(60));
  assert.deepEqual(fields(notes()), [[60, 0, 9]], 'held at the start of the motif');
  down(x(2), y(60));
  move(x(2) + 2000, y(60));
  up(x(2) + 2000, y(60));
  assert.deepEqual(fields(notes()), [[60, 87, 9]], 'held so the note ends with the motif');
});

test('a vertical drag stops at the top and the bottom row of the shown rows, and the base window does not move', () => {
  const { down, move, up, x, y, notes, attr, grid } = withNote();
  down(x(14), y(60));
  move(x(14), y(60) - 900);
  up(x(14), y(60) - 900);
  assert.equal(notes()[0].pitch, 71, 'the top row of the 24 rows shown while the note was dragged');
  assert.equal(attr('scratch-view', 'data-rows'), '36', 'a note at B4 and the cursor on it bring in the next octave');
  assert.equal(attr('scratch-view', 'data-row-high'), '83');
  // The grid is now 36 rows: the same 10 pixels a row makes it 360 high, and its top row is B5 (83).
  grid.rect = { ...grid.rect, height: 360 };
  const at = (pitch) => 50 + (83 - pitch) * 10 + 5;
  down(x(14), at(71));
  move(x(14), at(71) + 900);
  up(x(14), at(71) + 900);
  assert.equal(notes()[0].pitch, 48, 'the bottom row of the rows shown while the note was dragged (C3)');
  assert.equal(attr('scratch-view', 'data-window-start'), '48', 'the base window did not move');
});

test('a move onto a note of the same pitch at the same start merges them and the line says so', () => {
  const { down, move, up, x, y, notes, line, dbl } = withNote();
  dbl(x(30), y(62));
  assert.equal(notes().length, 2);
  down(x(14), y(60));
  move(x(32), y(62));
  up(x(32), y(62));
  assert.equal(notes().length, 1);
  assert.match(line().spoken, /Merged with the note there/);
});

test('a drag that ends where the note began only selects it, like a click', () => {
  const { down, move, up, x, y, line, attr, notes } = withNote();
  down(x(14), y(60));
  move(x(30), y(65));
  move(x(14), y(60));
  up(x(14), y(60));
  assert.equal(attr('scratch-view', 'data-selected'), '1');
  assert.deepEqual(fields(notes()), [[60, 12, 9]]);
  assert.equal(line().kind, 'note', 'the line reads the note, as after a click');
});

test('a press on the right edge of a note becomes a resize: the ghost follows the nearest grid line, the release commits once', () => {
  const { down, move, up, x, y, notes, hidden, prop, get, line, attr } = withNote();
  down(305, y(60));
  move(396, y(60));
  assert.equal(hidden('scratch-preview'), false);
  assert.deepEqual([prop('scratch-preview', '--sp-start'), prop('scratch-preview', '--sp-len'), prop('scratch-preview', '--sp-row')], ['12', '18', '11']);
  assert.equal(get('scratch-note-hover').textContent, 'C4 · cycle 1, beat 2 · length 6 sixteenths (1.5 beats) · velocity 0.80');
  assert.deepEqual(fields(notes()), [[60, 12, 9]]);
  up(396, y(60));
  assert.deepEqual(fields(notes()), [[60, 12, 18]]);
  assert.equal(line().spoken, 'C4 now lasts 6 sixteenths (1.5 beats).');
  assert.equal(attr('scratch-view', 'data-selected'), '1');
  assert.equal(hidden('scratch-preview'), true);
});

test('a resize is one step at the least and ends with the motif at the most', () => {
  const { down, move, up, x, y, notes } = withNote();
  down(305, y(60));
  move(x(2), y(60));
  up(x(2), y(60));
  assert.deepEqual(fields(notes()), [[60, 12, 3]]);
  down(246, y(60));
  move(246 + 3000, y(60));
  up(246 + 3000, y(60));
  assert.deepEqual(fields(notes()), [[60, 12, 84]]);
});

test('a resize that stops at the next note of the same pitch says so', () => {
  const { down, move, up, x, y, notes, line, dbl } = withNote();
  dbl(x(40), y(60));
  down(305, y(60));
  move(x(50), y(60));
  up(x(50), y(60));
  assert.deepEqual(fields(notes()), [[60, 12, 27], [60, 39, 3]]);
  assert.match(line().spoken, /cut where a note of the same pitch starts/);
});

test('the edge of a short note is at most 40 percent of it: the left part of a one-step note moves it', () => {
  const { down, move, up, x, y, notes, dbl } = setup();
  dbl(x(30), y(60));
  assert.deepEqual(fields(notes()), [[60, 30, 3]]);
  // The note covers pixels 400 to 430. Its edge is the last 8 pixels, 422 and on.
  down(402, y(60));
  move(402 + 30, y(60));
  up(402 + 30, y(60));
  assert.deepEqual(fields(notes()), [[60, 33, 3]], 'a press near its left moves it');
});

test('a drag near the left or right edge of the scroll box scrolls it by a rem on each move, and only on the move', () => {
  const { down, move, up, x, y, get, drawOn } = setup();
  drawOn();
  const scroll = get('scratch-scroll');
  scroll.rect = { left: 0, right: 1000, width: 1000, top: 0, bottom: 0, height: 0 };
  get('scratch-gutter').rect = { left: 0, right: 48, width: 48, top: 0, bottom: 0, height: 0 };
  scroll.scrollLeft = 100;
  down(x(40), y(60));
  move(x(40) + 1, y(60));
  assert.equal(scroll.scrollLeft, 100, 'a press that has not become a drag scrolls nothing');
  move(980, y(60));
  assert.equal(scroll.scrollLeft, 116);
  move(985, y(60));
  assert.equal(scroll.scrollLeft, 132);
  move(500, y(60));
  assert.equal(scroll.scrollLeft, 132, 'a move away from the edge scrolls nothing');
  move(60, y(60));
  assert.equal(scroll.scrollLeft, 116, 'near the piano names scrolls back');
  move(70, y(60));
  assert.equal(scroll.scrollLeft, 100);
  up(70, y(60));
  assert.equal(scroll.scrollLeft, 100, 'the release scrolls nothing');
});

test('the scroll never goes below the left end, and a move and a resize scroll at the edge as a draw does', () => {
  const { view, down, move, x, y, get } = withNote();
  const scroll = get('scratch-scroll');
  scroll.rect = { left: 0, right: 1000, width: 1000, top: 0, bottom: 0, height: 0 };
  get('scratch-gutter').rect = { left: 0, right: 48, width: 48, top: 0, bottom: 0, height: 0 };
  scroll.scrollLeft = 0;
  down(x(14), y(60));
  move(60, y(60));
  assert.equal(scroll.scrollLeft, 0);
  move(990, y(60));
  assert.equal(scroll.scrollLeft, 16, 'a move scrolls');
  view.cancelGesture();
  scroll.scrollLeft = 0;
  down(305, y(60));
  move(990, y(60));
  assert.equal(scroll.scrollLeft, 16, 'a resize scrolls');
  view.cancelGesture();
});

test('a move or a resize ended by a lost pointer, a blur or the view closing commits nothing', () => {
  const ways = [
    ['pointercancel', ({ grid }) => grid.dispatch('pointercancel', { pointerId: 1 })],
    ['lostpointercapture', ({ grid }) => grid.dispatch('lostpointercapture', { pointerId: 1 })],
    ['cancelGesture', ({ view }) => view.cancelGesture()],
    ['closed', ({ view }) => view.closed()],
  ];
  for (const [what, startX] of [['a move', 241], ['a resize', 305]]) {
    for (const [name, end] of ways) {
      const t = withNote();
      t.down(startX, t.y(60));
      t.move(startX + 100, t.y(63));
      assert.equal(t.hidden('scratch-preview'), false, `${what} ${name}`);
      end(t);
      assert.deepEqual(fields(t.notes()), [[60, 12, 9]], `${what} ${name}`);
      assert.equal(t.hidden('scratch-preview'), true, `${what} ${name}`);
      t.up(startX + 100, t.y(63));
      assert.deepEqual(fields(t.notes()), [[60, 12, 9]], `${what} ${name}: a release after the cancel changes nothing`);
    }
  }
});

test('rollContains is true for the roll and what is in it, and for nothing else', () => {
  const { view, get } = setup();
  for (const id of ['scratch-roll', 'scratch-gutter', 'scratch-grid', 'scratch-notes', 'scratch-cursor']) assert.equal(view.rollContains(get(id)), true, id);
  for (const id of ['scratch-view', 'scratch-scroll', 'scratch-ruler', 'scratch-note', 'scratch-note-line', 'scratch-hint']) assert.equal(view.rollContains(get(id)), false, id);
  assert.equal(view.rollContains(null), false);
  assert.equal(view.rollContains(undefined), false);
});

test('a right-click on a note erases it with the erase notice', () => {
  const { view, x, y, get, notes, line, attr } = withNote();
  const event = { target: get('scratch-notes').children[0], clientX: x(15), clientY: y(60), preventDefault() {} };
  assert.equal(view.handleContextMenu(event), true);
  assert.deepEqual(notes(), []);
  assert.equal(attr('scratch-view', 'data-notes'), '0');
  assert.equal(line().spoken, 'Erased C4 at cycle 1, beat 2. Undo brings it back.');
});

test('a right-click on empty roll space changes nothing, and so does one in the piano names', () => {
  const { view, x, y, get, notes, line, document } = withNote();
  const said = line().spoken;
  const writes = document.writes;
  assert.equal(view.handleContextMenu({ target: get('scratch-grid'), clientX: x(60), clientY: y(66) }), true);
  assert.equal(view.handleContextMenu({ target: get('scratch-gutter'), clientX: 120, clientY: y(60) }), true);
  assert.equal(notes().length, 1);
  assert.equal(line().spoken, said);
  assert.equal(document.writes, writes);
});

test('a right-click outside the roll is not taken', () => {
  const { view, x, y, get, notes } = withNote();
  assert.equal(view.handleContextMenu({ target: get('scratch-ruler'), clientX: x(15), clientY: y(60) }), false);
  assert.equal(view.handleContextMenu({ target: get('scratch-note-line'), clientX: x(15), clientY: y(60) }), false);
  assert.equal(notes().length, 1);
});

test('a right-click while a drag is on does not erase the note being dragged', () => {
  const { view, down, move, x, y, get, notes } = withNote();
  down(x(14), y(60));
  move(x(30), y(60));
  assert.equal(view.handleContextMenu({ target: get('scratch-notes').children[0], clientX: x(30), clientY: y(60) }), true);
  assert.equal(notes().length, 1);
});

test('a roll key that edits the motif ends a drag in progress, so the release cannot act on a note the key changed', () => {
  for (const [key, extra] of [['Delete', {}], ['Backspace', {}], ['ArrowRight', { altKey: true }], ['ArrowRight', { shiftKey: true }], ['Enter', {}]]) {
    const { down, move, up, press, focus, x, y, notes, hidden } = withNote();
    focus();
    down(x(14), y(60));
    move(x(30), y(60));
    assert.equal(hidden('scratch-preview'), false, 'the drag is on');
    press(key, extra);
    assert.equal(hidden('scratch-preview'), true, `${key} ends the drag`);
    const after = fields(notes());
    assert.doesNotThrow(() => up(x(30), y(60)), `${key} ${JSON.stringify(extra)}`);
    assert.deepEqual(fields(notes()), after, 'the release changes nothing');
  }
});

test('the view still adds no contextmenu listener of its own', () => {
  const { get } = setup();
  for (const id of ['scratch-view', 'scratch-roll', 'scratch-grid', 'scratch-notes']) assert.deepEqual(get(id).listenersFor('contextmenu'), [], id);
});

test('the keyboard cursor is hidden while a drag is on, so its dashed ring is not taken for the preview, and comes back after', () => {
  const { focus, down, move, up, x, y, hidden } = withNote();
  focus();
  assert.equal(hidden('scratch-cursor'), false);
  down(x(14), y(60));
  move(x(30), y(60));
  assert.equal(hidden('scratch-cursor'), true);
  assert.equal(hidden('scratch-preview'), false);
  up(x(30), y(60));
  assert.equal(hidden('scratch-cursor'), false);
});

// --- the fit: the beat and the row follow the room ---

// A scroll box of the given size in pixels with a ruler 20 pixels high in it, and a root font of 16 pixels.
function sized(width, height) {
  const t = setup();
  t.drawOn();
  const scroll = t.get('scratch-scroll');
  scroll.clientWidth = width;
  scroll.clientHeight = height;
  t.get('scratch-ruler').rect = { left: 0, top: 0, right: width, bottom: 20, width, height: 20 };
  const calls = [];
  const set = scroll.style.setProperty;
  scroll.style.setProperty = (name, value) => {
    calls.push([name, value]);
    set(name, value);
  };
  return { ...t, scroll, calls };
}

test('resize writes the beat and the row in rem on the scroll box: the width left after the piano names, the height left after the ruler', () => {
  const { view, scroll } = sized(1000, 600);
  view.resize();
  assert.equal(scroll.style.props.get('--sp-beat-w'), '7.25rem', '(1000 / 16 - 4.5 rem) / 8 beats');
  assert.equal(scroll.style.props.get('--sp-row-h'), '1.25rem', '(600 - 20) / 16 rem is more than 24 rows of 1.25 rem');
});

test('resize holds the beat at 4 rem and the row at 0.625 rem when the room is short, and the row follows a taller room', () => {
  const { view, scroll } = sized(400, 300);
  view.resize();
  assert.equal(scroll.style.props.get('--sp-beat-w'), '4rem');
  assert.equal(scroll.style.props.get('--sp-row-h'), '0.7292rem', '(300 - 20) / 16 / 24');
  scroll.clientHeight = 200;
  view.resize();
  assert.equal(scroll.style.props.get('--sp-row-h'), '0.625rem');
});

test('a second resize at the same size writes nothing, and a new size writes only what changed', () => {
  const { view, scroll, calls } = sized(1000, 600);
  view.resize();
  assert.equal(calls.length, 2);
  view.resize();
  assert.equal(calls.length, 2, 'the same size writes nothing');
  scroll.clientHeight = 400;
  view.resize();
  assert.deepEqual(calls.slice(2), [['--sp-row-h', '0.9896rem']], 'only the row changed: (400 - 20) / 16 / 24');
});

test('resize gives the beat all the room: there is no upper limit on its width', () => {
  const { view, scroll } = sized(2000, 600);
  view.resize();
  assert.equal(scroll.style.props.get('--sp-beat-w'), '15.0625rem', '(2000 / 16 - 4.5 rem) / 8 beats, far past the old 8 rem');
});

test('resize shares the height among the rows shown: 24 rows fill it, 108 rows are held at the least height and the box scrolls', () => {
  const { view, scroll, press, focus, get } = sized(1000, 600);
  view.resize();
  assert.equal(scroll.style.props.get('--sp-row-h'), '1.25rem');
  focus();
  // Notes at C0 and B8 make 108 rows: (600 - 20) / 16 = 36.25 rem is under the 67.5 rem they need at the least height of 0.625 rem a row.
  for (let i = 0; i < 4; i += 1) press('ArrowDown', { altKey: true });
  press('Enter');
  for (let i = 0; i < 12; i += 1) press('ArrowUp', { altKey: true });
  press('Enter');
  assert.equal(get('scratch-roll').style.props.get('--sp-rows'), '108');
  assert.equal(scroll.style.props.get('--sp-row-h'), '0.625rem', 'held at the least height, so the box scrolls');
});

test('the rows changing fits the box again: the row height is written when the row count changes and not before', () => {
  const { view, scroll, calls, press, focus, get } = sized(1000, 600);
  view.resize();
  focus();
  assert.equal(get('scratch-roll').style.props.get('--sp-rows'), '24');
  assert.equal(scroll.style.props.get('--sp-row-h'), '1.25rem', '(600 - 20) / 16 / 24 is more than the most');
  const before = calls.length;
  press('ArrowRight');
  assert.equal(calls.length, before, 'a cursor move that keeps the rows writes no size');
  for (let i = 0; i < 10; i += 1) press('ArrowUp');
  assert.equal(get('scratch-roll').style.props.get('--sp-rows'), '36');
  assert.equal(scroll.style.props.get('--sp-row-h'), '1.0069rem', '(600 - 20) / 16 / 36');
});

test('resize writes nothing while the view has no size (it is hidden), and sizes it when it has one', () => {
  const { view, scroll, calls } = sized(0, 0);
  view.resize();
  assert.equal(calls.length, 0);
  scroll.clientWidth = 1000;
  scroll.clientHeight = 600;
  view.resize();
  assert.equal(calls.length, 2);
});

test('resize counts the height of every other element in the scroll box besides the roll', () => {
  const { view, scroll, get, document } = sized(1000, 600);
  const lane = document.createElement('div');
  lane.rect = { left: 0, top: 0, right: 1000, bottom: 120, width: 1000, height: 120 };
  get('scratch-scroll').appendChild(lane);
  view.resize();
  assert.equal(scroll.style.props.get('--sp-row-h'), '1.1979rem', '(600 - 20 - 120) / 16 / 24: the lane takes room from the rows');
});

test('the view writes no width and no height of its own: only custom properties reach the page as numbers', () => {
  const { view, get, down, up, x, y, drawOn } = setup();
  drawOn();
  get('scratch-scroll').clientWidth = 1000;
  get('scratch-scroll').clientHeight = 600;
  view.resize();
  down(x(12), y(60));
  up(x(12), y(60));
  for (const id of ['scratch-scroll', 'scratch-roll', 'scratch-grid', 'scratch-notes', 'scratch-preview', 'scratch-hover-cell']) {
    const node = get(id);
    for (const name of node.style.props.keys()) assert.match(name, /^--sp-/, `${id} gets ${name}`);
    assert.equal(node.style.width, '', id);
  }
});

// --- The toolbar: the grid, the length of the motif and the pitch window ---

const GRID_IDS = ['quarter', 'eighth', 'sixteenth', 'eighth-triplet', 'sixteenth-triplet'];

test('the toolbar names its five grids, its length buttons and its pitch buttons from the copy, and presses the sixteenths', () => {
  const { get, attr } = setup();
  const segments = GRID_IDS.map((id) => get(`scratch-grid-${id}`));
  assert.deepEqual(segments.map((segment) => segment.textContent), ['Quarters', 'Eighths', 'Sixteenths', 'Eighth triplets', 'Sixteenth triplets']);
  assert.deepEqual(segments.map((segment) => segment.getAttribute('aria-label')), ['Quarter notes, 4 per cycle', 'Eighth notes, 8 per cycle', 'Sixteenth notes, 16 per cycle', 'Eighth-note triplets, 12 per cycle', 'Sixteenth-note triplets, 24 per cycle']);
  assert.deepEqual(segments.map((segment) => segment.getAttribute('title')), segments.map((segment) => segment.getAttribute('aria-label')));
  assert.deepEqual(segments.map((segment) => segment.getAttribute('aria-pressed')), ['false', 'false', 'true', 'false', 'false']);
  assert.equal(get('scratch-fewer').textContent, '−');
  assert.equal(attr('scratch-fewer', 'aria-label'), 'Fewer cycles');
  assert.equal(get('scratch-more').textContent, '+');
  assert.equal(attr('scratch-more', 'aria-label'), 'More cycles');
  assert.equal(get('scratch-cycles').textContent, '2 cycles');
  assert.equal(get('scratch-lower').textContent, 'Lower');
  assert.equal(attr('scratch-lower', 'aria-label'), 'Move the starting pitch window down one octave. The roll still grows to show every note.');
  assert.equal(get('scratch-higher').textContent, 'Higher');
  assert.equal(attr('scratch-higher', 'aria-label'), 'Move the starting pitch window up one octave. The roll still grows to show every note.');
  assert.equal(get('scratch-window').textContent, 'C3–B4');
  assert.equal(attr('scratch-window', 'aria-label'), 'C3 to B4');
  for (const id of ['scratch-fewer', 'scratch-more', 'scratch-lower', 'scratch-higher']) assert.notEqual(get(id).getAttribute('aria-disabled'), 'true', id);
});

test('pressing Quarters presses it alone, sets the grid and its step lines, and moves the notes onto it at once', () => {
  const { get, attr, focus, press, notes, line, prop } = setup();
  focus();
  press('ArrowRight');
  press('Enter');
  press('ArrowRight');
  press('ArrowRight');
  press('Enter');
  assert.deepEqual(notes().map((note) => [note.start, note.length]), [[3, 3], [9, 3]]);
  get('scratch-grid-quarter').dispatch('click');
  assert.deepEqual(GRID_IDS.map((id) => get(`scratch-grid-${id}`).getAttribute('aria-pressed')), ['true', 'false', 'false', 'false', 'false']);
  assert.equal(attr('scratch-view', 'data-grid'), 'quarter');
  assert.equal(prop('scratch-roll', '--sp-steps'), '4');
  assert.deepEqual(notes().map((note) => [note.start, note.length]), [[0, 12], [12, 12]]);
  assert.deepEqual(line(), { kind: 'notice', name: '', rest: 'Grid: quarters. 2 notes moved onto it.', spoken: 'Grid: quarters. 2 notes moved onto it.' });
  assert.equal(notes()[0].label, 'C4, starts at cycle 1, beat 1, lasts 1 quarter, velocity 0.80.');
});

test('a grid change that merges says so in the line', () => {
  const { get, focus, press, notes, line } = setup();
  focus();
  press('ArrowRight');
  press('Enter');
  press('ArrowRight');
  press('Enter');
  assert.equal(notes().length, 2);
  get('scratch-grid-quarter').dispatch('click');
  assert.equal(notes().length, 1);
  assert.equal(line().spoken, 'Grid: quarters. 2 notes moved onto it, 1 merged (same pitch in the same cell).');
});

test('choosing the grid in use changes nothing and leaves the line as it was', () => {
  const { get, focus, press, line, notes } = setup();
  focus();
  press('Enter');
  const before = { line: line(), notes: notes() };
  get('scratch-grid-sixteenth').dispatch('click');
  assert.deepEqual({ line: line(), notes: notes() }, before);
  assert.equal(get('scratch-grid-sixteenth').getAttribute('aria-pressed'), 'true');
});

test('the cursor stays on a step of the new grid after a grid change', () => {
  const { get, focus, press, cursor } = setup();
  focus();
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowRight');
  assert.deepEqual(cursor(), { unit: 15, pitch: 60 });
  get('scratch-grid-quarter').dispatch('click');
  assert.deepEqual(cursor(), { unit: 12, pitch: 60 });
  assert.equal(get('scratch-cursor').style.props.get('--sp-len'), '12');
});

test('More cycles and Fewer cycles change the length, and carry aria-disabled at 8 and at 1 without changing anything', () => {
  const { get, attr } = setup();
  get('scratch-more').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '3');
  assert.equal(get('scratch-cycles').textContent, '3 cycles');
  assert.equal(get('scratch-ruler').children.length, 12);
  assert.equal(get('scratch-roll').style.props.get('--sp-cycles'), '3');
  for (let i = 0; i < 5; i += 1) get('scratch-more').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '8');
  assert.equal(attr('scratch-more', 'aria-disabled'), 'true');
  assert.equal(attr('scratch-more', 'title'), 'The motif is already 8 cycles long, the most.');
  get('scratch-more').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '8');
  for (let i = 0; i < 7; i += 1) get('scratch-fewer').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '1');
  assert.equal(get('scratch-cycles').textContent, '1 cycle');
  assert.equal(attr('scratch-fewer', 'aria-disabled'), 'true');
  assert.equal(attr('scratch-fewer', 'title'), 'The motif is already 1 cycle long, the least.');
  assert.notEqual(attr('scratch-more', 'aria-disabled'), 'true');
  assert.equal(attr('scratch-more', 'title'), 'More cycles');
  get('scratch-fewer').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '1');
});

test('a refused Fewer cycles shows the refusal in the line and keeps the length', () => {
  const { get, attr, focus, press, line, notes } = setup();
  get('scratch-more').dispatch('click');
  focus();
  press('End');
  press('Enter');
  assert.equal(notes().length, 1);
  get('scratch-fewer').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '3');
  assert.equal(line().spoken, 'Cycle 3 has 1 note. Erase or move them first.');
  assert.equal(notes().length, 1);
});

test('Fewer cycles cuts a note that runs into the cycle that goes, and says so', () => {
  const { get, attr, focus, press, line, notes } = setup();
  get('scratch-more').dispatch('click');
  focus();
  for (let i = 0; i < 14; i += 1) press('ArrowRight');
  press('Enter');
  for (let i = 0; i < 9; i += 1) press('ArrowRight', { shiftKey: true });
  assert.deepEqual(notes().map((note) => [note.start, note.length]), [[42, 30]]);
  get('scratch-fewer').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '2');
  assert.deepEqual(notes().map((note) => [note.start, note.length]), [[42, 30]], 'the note still ends inside two cycles');
  get('scratch-fewer').dispatch('click');
  assert.equal(attr('scratch-view', 'data-cycles'), '1');
  assert.deepEqual(notes().map((note) => [note.start, note.length]), [[42, 6]]);
  assert.equal(line().spoken, 'Motif is now 1 cycle. 1 note was cut at the end.');
});

test('the cursor stays inside the motif after Fewer cycles', () => {
  const { get, focus, press, cursor } = setup();
  focus();
  press('End');
  assert.equal(cursor().unit, 93);
  get('scratch-fewer').dispatch('click');
  assert.equal(cursor().unit, 45);
});

test('Lower and Higher move the pitch window by one octave and the readout and its name follow', () => {
  const { get, attr } = setup();
  get('scratch-higher').dispatch('click');
  assert.equal(attr('scratch-view', 'data-window-start'), '60');
  assert.equal(get('scratch-window').textContent, 'C4–B5');
  assert.equal(attr('scratch-window', 'aria-label'), 'C4 to B5');
  get('scratch-lower').dispatch('click');
  get('scratch-lower').dispatch('click');
  assert.equal(attr('scratch-view', 'data-window-start'), '36');
  assert.equal(get('scratch-window').textContent, 'C2–B3');
  assert.deepEqual(get('scratch-gutter').children.map((cell) => cell.textContent).filter((text) => text !== ''), ['C3', 'C2']);
});

test('Lower and Higher carry aria-disabled at the lowest and the highest octave and change nothing there', () => {
  const { get, attr } = setup();
  for (let i = 0; i < 5; i += 1) get('scratch-lower').dispatch('click');
  assert.equal(attr('scratch-view', 'data-window-start'), '12');
  assert.equal(attr('scratch-lower', 'aria-disabled'), 'true');
  assert.equal(attr('scratch-lower', 'title'), 'The starting pitch window is already at the lowest octave.');
  assert.notEqual(attr('scratch-higher', 'aria-disabled'), 'true');
  get('scratch-lower').dispatch('click');
  assert.equal(attr('scratch-view', 'data-window-start'), '12');
  for (let i = 0; i < 7; i += 1) get('scratch-higher').dispatch('click');
  assert.equal(attr('scratch-view', 'data-window-start'), '96');
  assert.equal(attr('scratch-higher', 'aria-disabled'), 'true');
  assert.equal(attr('scratch-higher', 'title'), 'The starting pitch window is already at the highest octave.');
  assert.notEqual(attr('scratch-lower', 'aria-disabled'), 'true');
  assert.equal(attr('scratch-lower', 'title'), 'Move the starting pitch window down one octave. The roll still grows to show every note.');
});

test('the Pitch readout names the shown range and counts no notes above or below, because nothing is hidden', () => {
  const { get, attr, focus, press } = setup();
  focus();
  press('Enter');
  get('scratch-higher').dispatch('click');
  assert.equal(get('scratch-window').textContent, 'C3–B5', 'the note at C4 holds the rows down while the base moves up');
  get('scratch-higher').dispatch('click');
  assert.equal(get('scratch-window').textContent, 'C3–B6');
  assert.equal(attr('scratch-window', 'aria-label'), 'C3 to B6');
});

test('moving the pitch window is not an edit: the line goes back to reading the cursor', () => {
  const { get, focus, press, line } = setup();
  focus();
  press('Enter');
  assert.equal(line().kind, 'notice');
  get('scratch-higher').dispatch('click');
  assert.notEqual(line().kind, 'notice');
});

// --- The velocity lane under the roll ---

// The bars area of the lane has its corner at 100, 400, is 960 pixels wide for the 96 units of two cycles and 56 pixels high.
const LANE_RECT = { left: 100, top: 400, right: 1060, bottom: 456, width: 960, height: 56 };

function laneSetup() {
  const t = setup();
  const barsEl = t.get('scratch-bars');
  barsEl.rect = { ...LANE_RECT };
  const lane = t.get('scratch-lane');
  const bars = () => barsEl.children.map((element) => ({ id: Number(element.dataset.id), velocity: Number(element.dataset.velocity), start: Number(element.dataset.start), selected: element.className.split(' ').includes('sp-selected'), element }));
  // A point in the column of a unit (a pixel in) and at a velocity (the height of the bar's top, 56 pixels for 100 hundredths).
  const lx = (unit, extra = 0) => LANE_RECT.left + unit * 10 + 1 + extra;
  const ly = (velocity) => LANE_RECT.bottom - (velocity / 100) * LANE_RECT.height;
  const lpointer = (type, px, py, extra = {}) => barsEl.dispatch(type, { pointerId: 2, clientX: px, clientY: py, ...extra });
  const ldown = (px, py, extra) => lpointer('pointerdown', px, py, extra);
  const lmove = (px, py, extra) => lpointer('pointermove', px, py, extra);
  const lup = (px, py, extra) => lpointer('pointerup', px, py, extra);
  const lkey = (key, extra = {}) => lane.dispatch('keydown', { key, ...extra });
  const lfocus = () => {
    t.document.activeElement = lane;
    lane.dispatch('focus');
  };
  return { ...t, barsEl, lane, bars, lx, ly, lpointer, ldown, lmove, lup, lkey, lfocus };
}

// Three notes made with the roll's keys: C4 at unit 0, then C4 and E4 together at unit 6. The cursor ends on E4 at unit 6.
function withChord(t) {
  t.focus();
  t.press('Enter');
  t.press('ArrowRight');
  t.press('ArrowRight');
  t.press('Enter');
  for (let i = 0; i < 4; i += 1) t.press('ArrowUp');
  t.press('Enter');
}

test('the lane is one bar per note under its start column, in time order, with the velocity in its name and its height', () => {
  const t = laneSetup();
  withChord(t);
  const bars = t.bars();
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((bar) => [bar.start, bar.velocity]), [[0, 80], [6, 80], [6, 80]]);
  assert.deepEqual(bars.map((bar) => bar.element.getAttribute('aria-label')), ['C4 velocity 0.80', 'C4 velocity 0.80', 'E4 velocity 0.80']);
  assert.equal(bars[0].element.style.props.get('--v'), '0.8');
  assert.equal(bars[0].element.style.props.get('--sp-start'), '0');
  assert.equal(t.get('scratch-bars').style.props.get('--sp-units'), '96');
  assert.equal(t.get('scratch-bars').style.props.get('--sp-cycles'), '2');
  assert.equal(t.get('scratch-bars').style.props.get('--sp-step'), '3');
});

test('notes that start together share their column side by side, lower pitch first', () => {
  const t = laneSetup();
  withChord(t);
  const [alone, low, high] = t.bars();
  assert.deepEqual([alone.element.style.props.get('--sp-slot'), alone.element.style.props.get('--sp-slots')], ['0', '1']);
  assert.deepEqual([low.element.style.props.get('--sp-slot'), low.element.style.props.get('--sp-slots')], ['0', '2']);
  assert.deepEqual([high.element.style.props.get('--sp-slot'), high.element.style.props.get('--sp-slots')], ['1', '2']);
});

test('the lane shows a bar for every note, and the roll draws every note, whatever the base window is', () => {
  const t = laneSetup();
  t.focus();
  t.press('Enter');
  t.get('scratch-higher').dispatch('click');
  t.get('scratch-higher').dispatch('click');
  assert.equal(t.notes().length, 1, 'the roll draws it: the rows follow the notes');
  assert.equal(t.bars().length, 1, 'and the lane holds its bar');
});

test('the lane keeps a bar when the grid changes and its column follows the note', () => {
  const t = laneSetup();
  t.focus();
  t.press('ArrowRight');
  t.press('Enter');
  t.get('scratch-grid-quarter').dispatch('click');
  assert.deepEqual(t.bars().map((bar) => bar.start), [0]);
  assert.equal(t.get('scratch-bars').style.props.get('--sp-step'), '12');
});

test('a press on the column of a bar selects its note and puts the cursor on it', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(6), t.ly(80));
  assert.equal(t.barsEl.capturedPointer, 2);
  assert.equal(t.attr('scratch-view', 'data-selected'), String(t.bars()[1].id));
  assert.deepEqual(t.cursor(), { unit: 6, pitch: 60 });
  assert.deepEqual(t.bars().map((bar) => bar.selected), [false, true, false]);
  assert.equal(t.line().name, 'C4');
  t.lup(t.lx(6), t.ly(80));
  assert.equal(t.barsEl.capturedPointer, null);
  assert.equal(t.notes().find((note) => note.selected).pitch, 60);
});

test('a press on the second bar of a chord selects the higher note', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(6, 16), t.ly(80));
  assert.deepEqual(t.cursor(), { unit: 6, pitch: 64 });
  assert.equal(t.line().name, 'E4');
  t.lup(t.lx(6, 16), t.ly(80));
});

test('a drag on a bar sets the velocity live in the bar and the line, and the release commits one edit', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(0), t.ly(80));
  t.lmove(t.lx(0), t.ly(80) - 2);
  t.lmove(t.lx(0), t.ly(100));
  assert.equal(t.bars()[0].velocity, 100, 'the bar follows');
  assert.equal(t.bars()[0].element.style.props.get('--v'), '1');
  assert.equal(t.get('scratch-note-hover').hidden, false);
  assert.equal(t.get('scratch-note-hover').textContent, 'C4 · cycle 1, beat 1 · length 1 sixteenth (0.25 beat) · velocity 1.00', 'the line follows');
  assert.equal(t.notes()[0].velocity, 80, 'the motif is not written before the release');
  t.lmove(t.lx(0), t.ly(35));
  assert.equal(t.bars()[0].velocity, 35);
  t.lup(t.lx(0), t.ly(35));
  assert.equal(t.notes()[0].velocity, 35);
  assert.equal(t.bars()[0].velocity, 35);
  assert.equal(t.line().spoken, 'C4 velocity 0.35.');
  assert.equal(t.get('scratch-note-hover').hidden, true);
  assert.equal(t.barsEl.capturedPointer, null);
});

test('a bar dragged to the top gives 1.00 and one dragged to the bottom gives 0.01, even past the lane', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(0), t.ly(80));
  t.lmove(t.lx(0), 100);
  t.lup(t.lx(0), 100);
  assert.equal(t.notes()[0].velocity, 100);
  t.ldown(t.lx(0), t.ly(100));
  t.lmove(t.lx(0), 900);
  t.lup(t.lx(0), 900);
  assert.equal(t.notes()[0].velocity, 1);
});

test('a press that never moves selects and writes no edit; a drag back to the same velocity is no edit', () => {
  const t = laneSetup();
  withChord(t);
  const before = t.line().spoken;
  t.ldown(t.lx(0), t.ly(80));
  t.lup(t.lx(0), t.ly(80));
  assert.equal(t.notes()[0].velocity, 80);
  assert.notEqual(t.line().kind, 'notice', 'a press reads the note; it says no edit');
  assert.notEqual(t.line().spoken, before);
  t.ldown(t.lx(0), t.ly(80));
  t.lmove(t.lx(0), t.ly(100));
  t.lmove(t.lx(0), t.ly(80));
  t.lup(t.lx(0), t.ly(80));
  assert.equal(t.notes()[0].velocity, 80);
  assert.notEqual(t.line().kind, 'notice', 'no edit was made');
});

test('a press with another button, with ctrl held, or in a column with no bar starts nothing', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(0), t.ly(80), { button: 2 });
  assert.equal(t.barsEl.capturedPointer, null);
  t.ldown(t.lx(0), t.ly(80), { ctrlKey: true });
  assert.equal(t.barsEl.capturedPointer, null);
  t.ldown(t.lx(30), t.ly(80));
  assert.equal(t.barsEl.capturedPointer, null);
  t.lmove(t.lx(30), t.ly(10));
  t.lup(t.lx(30), t.ly(10));
  assert.deepEqual(t.bars().map((bar) => bar.velocity), [80, 80, 80]);
});

test('a lane drag ended by a lost pointer, a blur or the view closing commits nothing', () => {
  const ways = [
    ['pointercancel', (t) => t.lpointer('pointercancel', 0, 0)],
    ['lostpointercapture', (t) => t.lpointer('lostpointercapture', 0, 0)],
    ['cancelGesture', (t) => t.view.cancelGesture()],
    ['closed', (t) => t.view.closed()],
  ];
  for (const [name, end] of ways) {
    const t = laneSetup();
    withChord(t);
    t.ldown(t.lx(0), t.ly(80));
    t.lmove(t.lx(0), t.ly(100));
    assert.equal(t.bars()[0].velocity, 100, name);
    end(t);
    assert.equal(t.bars()[0].velocity, 80, `${name}: the bar goes back`);
    assert.equal(t.notes()[0].velocity, 80, name);
    assert.equal(t.get('scratch-note-hover').hidden, true, name);
    t.lup(t.lx(0), t.ly(100));
    assert.equal(t.notes()[0].velocity, 80, `${name}: a release after the cancel commits nothing`);
  }
});

test('a second pointer is ignored while a lane drag is on, and a roll press cannot start during one', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(0), t.ly(80));
  t.lpointer('pointermove', t.lx(0), t.ly(100), { pointerId: 7 });
  assert.equal(t.bars()[0].velocity, 80);
  t.down(t.x(30), t.y(65));
  assert.equal(t.grid.capturedPointer, null);
  t.lup(t.lx(0), t.ly(100));
});

test('on the focused lane Left and Right go from note to note in time order and stop at the ends', () => {
  const t = laneSetup();
  withChord(t);
  t.press('ArrowRight');
  t.lfocus();
  const selectedPitch = () => (t.attr('scratch-view', 'data-selected') === '' ? null : t.notes().find((note) => note.selected)?.pitch);
  t.lkey('ArrowRight');
  assert.deepEqual([t.cursor().unit, selectedPitch()], [0, 60], 'with nothing selected Right takes the first note');
  t.lkey('ArrowRight');
  assert.deepEqual([t.cursor().unit, selectedPitch()], [6, 60]);
  t.lkey('ArrowRight');
  assert.deepEqual([t.cursor().unit, selectedPitch()], [6, 64], 'then the higher note of the chord');
  t.lkey('ArrowRight');
  assert.deepEqual([t.cursor().unit, selectedPitch()], [6, 64], 'it stops at the last note');
  t.lkey('ArrowLeft');
  t.lkey('ArrowLeft');
  assert.deepEqual([t.cursor().unit, selectedPitch()], [0, 60]);
  t.lkey('ArrowLeft');
  assert.deepEqual([t.cursor().unit, selectedPitch()], [0, 60], 'it stops at the first note');
  assert.equal(t.line().spoken, 'C4, starts at cycle 1, beat 1, lasts 1 sixteenth (0.25 beat), velocity 0.80.');
});

test('Left on the focused lane with nothing selected takes the last note', () => {
  const t = laneSetup();
  withChord(t);
  t.blur();
  t.press('ArrowRight');
  t.press('ArrowRight');
  t.lfocus();
  t.lkey('ArrowLeft');
  assert.deepEqual(t.cursor(), { unit: 6, pitch: 64 });
});

test('Up and Down on the focused lane change the velocity by 0.05 and Shift by 0.01, held from 0.01 to 1.00', () => {
  const t = laneSetup();
  withChord(t);
  t.press('ArrowRight');
  t.lfocus();
  t.lkey('ArrowRight');
  t.lkey('ArrowUp');
  assert.equal(t.notes()[0].velocity, 85);
  assert.equal(t.line().spoken, 'C4 velocity 0.85.');
  t.lkey('ArrowDown');
  t.lkey('ArrowDown');
  assert.equal(t.notes()[0].velocity, 75);
  t.lkey('ArrowDown', { shiftKey: true });
  assert.equal(t.notes()[0].velocity, 74);
  t.lkey('ArrowUp', { shiftKey: true });
  t.lkey('ArrowUp', { shiftKey: true });
  assert.equal(t.notes()[0].velocity, 76);
  for (let i = 0; i < 8; i += 1) t.lkey('ArrowUp');
  assert.equal(t.notes()[0].velocity, 100, 'held at 1.00');
  for (let i = 0; i < 30; i += 1) t.lkey('ArrowDown');
  assert.equal(t.notes()[0].velocity, 1, 'held at 0.01');
  assert.equal(t.bars()[0].velocity, 1);
  assert.equal(t.attr('scratch-view', 'data-selected'), String(t.bars()[0].id), 'the selection stays on the note');
});

test('Up and Down on the focused lane with no note selected say there is no note and change nothing', () => {
  const t = laneSetup();
  withChord(t);
  t.blur();
  t.press('ArrowRight');
  t.lfocus();
  t.lkey('ArrowUp');
  assert.equal(t.line().spoken, SCRATCH_COPY.noNote);
  assert.deepEqual(t.bars().map((bar) => bar.velocity), [80, 80, 80]);
});

test('every handled lane key prevents the default and a key it does not take is left alone', () => {
  const t = laneSetup();
  withChord(t);
  t.lfocus();
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.equal(t.lkey(key).defaultPrevented, true, key);
  for (const [key, extra] of [['a', {}], ['7', {}], ['Escape', {}], ['Tab', {}], ['ArrowUp', { ctrlKey: true }], ['ArrowUp', { metaKey: true }], ['ArrowUp', { altKey: true }], ['v', {}]]) {
    assert.equal(t.lkey(key, extra).defaultPrevented, false, `${key} ${JSON.stringify(extra)}`);
  }
});

test('v in the roll moves focus to the lane on the cursor\'s note', () => {
  const t = laneSetup();
  withChord(t);
  t.press('ArrowLeft');
  t.press('ArrowLeft');
  assert.deepEqual(t.cursor(), { unit: 0, pitch: 64 }, 'the cursor moved off the note');
  for (let i = 0; i < 4; i += 1) t.press('ArrowDown');
  assert.deepEqual(t.cursor(), { unit: 0, pitch: 60 });
  const event = t.press('v');
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.document.activeElement, t.lane);
  assert.equal(t.attr('scratch-view', 'data-selected'), String(t.bars()[0].id), 'the lane works on the note it was opened on');
  assert.equal(t.bars()[0].selected, true);
});

test('v in the roll with no note under the cursor says so and focus stays', () => {
  const t = laneSetup();
  withChord(t);
  t.press('ArrowRight');
  t.press('ArrowRight');
  t.press('ArrowRight');
  const event = t.press('v');
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.document.activeElement, t.roll);
  assert.equal(t.line().spoken, SCRATCH_COPY.noNote);
});

test('the lane takes no right-click: it is outside the roll', () => {
  const t = laneSetup();
  withChord(t);
  assert.equal(t.view.rollContains(t.lane), false);
  assert.equal(t.view.rollContains(t.barsEl), false);
  assert.equal(t.view.rollContains(t.bars()[0].element), false);
  const event = { target: t.barsEl, clientX: t.lx(0), clientY: t.ly(50) };
  assert.equal(t.view.handleContextMenu(event), false);
  assert.equal(t.notes().length, 3);
});

test('drawing the same lane again writes nothing', () => {
  const t = laneSetup();
  withChord(t);
  const before = t.document.writes;
  t.view.render();
  t.view.render();
  assert.equal(t.document.writes, before);
});

test('the lane writes only custom properties as numbers', () => {
  const t = laneSetup();
  withChord(t);
  t.ldown(t.lx(0), t.ly(80));
  t.lmove(t.lx(0), t.ly(40));
  t.lup(t.lx(0), t.ly(40));
  for (const node of [t.get('scratch-lane'), t.barsEl, ...t.bars().map((bar) => bar.element)]) {
    for (const name of node.style.props.keys()) assert.match(name, /^--sp-|^--v$/, name);
    assert.equal(node.style.width, '');
  }
});

// --- Undo and redo ---

function historySetup() {
  const t = setup();
  const viewEl = t.get('scratch-view');
  const key = (name, extra = {}) => viewEl.dispatch('keydown', { key: name, ...extra });
  const undoKey = (extra = {}) => key('z', { ctrlKey: true, ...extra });
  const redoKey = (extra = {}) => key('z', { ctrlKey: true, shiftKey: true, ...extra });
  const enabled = (id) => t.get(id).getAttribute('aria-disabled') !== 'true';
  return { ...t, viewEl, key, undoKey, redoKey, enabled };
}

test('Undo and Redo are buttons in their own group that start with aria-disabled and say why', () => {
  const t = historySetup();
  assert.equal(t.get('scratch-undo').textContent, 'Undo');
  assert.equal(t.get('scratch-redo').textContent, 'Redo');
  assert.equal(t.attr('scratch-undo', 'aria-disabled'), 'true');
  assert.equal(t.attr('scratch-redo', 'aria-disabled'), 'true');
  assert.equal(t.attr('scratch-undo', 'title'), 'Nothing to undo.');
  assert.equal(t.attr('scratch-redo', 'title'), 'Nothing to redo.');
  t.get('scratch-undo').dispatch('click');
  t.get('scratch-redo').dispatch('click');
  assert.equal(t.line().kind, 'empty', 'a disabled button does nothing');
});

test('every edit is one undo step and enables Undo; Redo is enabled only after an undo', () => {
  const t = historySetup();
  t.focus();
  t.press('Enter');
  assert.equal(t.enabled('scratch-undo'), true);
  assert.equal(t.attr('scratch-undo', 'title'), 'Undo');
  assert.equal(t.enabled('scratch-redo'), false);
  t.get('scratch-undo').dispatch('click');
  assert.equal(t.notes().length, 0);
  assert.equal(t.line().spoken, 'Undid: placed C4.');
  assert.equal(t.enabled('scratch-undo'), false);
  assert.equal(t.enabled('scratch-redo'), true);
  t.get('scratch-redo').dispatch('click');
  assert.equal(t.notes().length, 1);
  assert.equal(t.line().spoken, 'Redid: placed C4.');
  assert.equal(t.enabled('scratch-redo'), false);
});

test('Ctrl+Z and Cmd+Z undo, and Shift+Ctrl+Z, Shift+Cmd+Z and Ctrl+Y redo; each handled key is prevented', () => {
  const t = historySetup();
  t.focus();
  t.press('Enter');
  t.press('Delete');
  assert.equal(t.notes().length, 0);
  const undone = t.undoKey();
  assert.equal(undone.defaultPrevented, true);
  assert.equal(t.notes().length, 1);
  assert.equal(t.line().spoken, 'Undid: erased C4.');
  const redone = t.redoKey();
  assert.equal(redone.defaultPrevented, true);
  assert.equal(t.notes().length, 0);
  assert.equal(t.line().spoken, 'Redid: erased C4.');
  assert.equal(t.key('z', { metaKey: true }).defaultPrevented, true);
  assert.equal(t.notes().length, 1);
  assert.equal(t.key('Z', { metaKey: true, shiftKey: true }).defaultPrevented, true, 'Shift makes the key a capital Z');
  assert.equal(t.notes().length, 0);
  t.key('z', { ctrlKey: true });
  assert.equal(t.key('y', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(t.line().spoken, 'Redid: erased C4.');
});

test('keys that are not undo or redo are left alone: plain z, Alt combinations, Cmd+Y and other letters', () => {
  const t = historySetup();
  t.focus();
  t.press('Enter');
  for (const [name, extra] of [['z', {}], ['z', { ctrlKey: true, altKey: true }], ['y', { metaKey: true }], ['y', {}], ['x', { ctrlKey: true }], ['Enter', { ctrlKey: true }]]) {
    assert.equal(t.key(name, extra).defaultPrevented, false, `${name} ${JSON.stringify(extra)}`);
  }
  assert.equal(t.notes().length, 1);
});

test('the undo keys are heard on the view alone: the view adds no listener to the document', () => {
  const t = historySetup();
  assert.equal(t.document.listeners.size, 0);
  t.focus();
  t.press('Enter');
  t.document.dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(t.notes().length, 1, 'a key heard by the document alone is not the Scratchpad\'s');
});

test('with nothing to undo or redo the keys say so and change nothing', () => {
  const t = historySetup();
  t.undoKey();
  assert.equal(t.line().spoken, 'Nothing to undo.');
  t.redoKey();
  assert.equal(t.line().spoken, 'Nothing to redo.');
  assert.equal(t.notes().length, 0);
});

test('undo brings back the grid and its pressed segment, and the notes as they were', () => {
  const t = historySetup();
  t.focus();
  t.press('ArrowRight');
  t.press('Enter');
  t.get('scratch-grid-quarter').dispatch('click');
  assert.deepEqual(t.notes().map((note) => note.start), [0]);
  t.undoKey();
  assert.deepEqual(t.notes().map((note) => note.start), [3]);
  assert.equal(t.get('scratch-grid-sixteenth').getAttribute('aria-pressed'), 'true');
  assert.equal(t.get('scratch-grid-quarter').getAttribute('aria-pressed'), 'false');
  assert.equal(t.attr('scratch-view', 'data-grid'), 'sixteenth');
  assert.equal(t.prop('scratch-roll', '--sp-steps'), '16');
  assert.equal(t.line().spoken, 'Undid: changed the grid to quarters.');
  assert.deepEqual(t.cursor(), { unit: 0, pitch: 60 }, 'the cursor is not part of the history; it stays on a step of the grid');
});

test('undo brings back the cycles, and the cursor stays inside the motif', () => {
  const t = historySetup();
  t.get('scratch-more').dispatch('click');
  t.focus();
  t.press('End');
  assert.equal(t.cursor().unit, 141);
  t.undoKey();
  assert.equal(t.attr('scratch-view', 'data-cycles'), '2');
  assert.equal(t.cursor().unit, 93);
  assert.equal(t.get('scratch-cycles').textContent, '2 cycles');
  assert.equal(t.line().spoken, 'Undid: changed the motif to 3 cycles.');
});

test('a refused Fewer cycles and a grid already in use add no undo step', () => {
  const t = historySetup();
  t.get('scratch-grid-sixteenth').dispatch('click');
  assert.equal(t.enabled('scratch-undo'), false);
  t.get('scratch-more').dispatch('click');
  t.focus();
  t.press('End');
  t.press('Enter');
  t.get('scratch-fewer').dispatch('click');
  t.undoKey();
  assert.equal(t.line().spoken, 'Undid: placed C4.', 'the refusal left no step of its own');
  t.undoKey();
  assert.equal(t.line().spoken, 'Undid: changed the motif to 3 cycles.');
});

test('after an undo the selection of a note that is gone is cleared; Redo does not bring the selection back', () => {
  const t = historySetup();
  t.dbl(t.x(12), t.y(60));
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  t.undoKey();
  assert.equal(t.attr('scratch-view', 'data-selected'), '');
  assert.deepEqual(t.notes(), []);
  t.redoKey();
  assert.equal(t.attr('scratch-view', 'data-selected'), '', 'a selection is not part of the history');
  assert.equal(t.notes().length, 1);
});

test('a new edit after an undo clears Redo', () => {
  const t = historySetup();
  t.focus();
  t.press('Enter');
  t.undoKey();
  assert.equal(t.enabled('scratch-redo'), true);
  t.press('ArrowRight');
  t.press('Enter');
  assert.equal(t.enabled('scratch-redo'), false);
  t.redoKey();
  assert.equal(t.line().spoken, 'Nothing to redo.');
});

test('mouse edits and lane edits are undone too, one step each', () => {
  const t = laneHistorySetup();
  t.drawOn();
  t.down(t.x(12), t.y(60));
  t.move(t.x(20), t.y(60));
  t.up(t.x(20), t.y(60));
  assert.equal(t.notes().length, 1);
  t.ldown(t.lx(12), t.ly(80));
  t.lmove(t.lx(12), t.ly(30));
  t.lup(t.lx(12), t.ly(30));
  assert.equal(t.notes()[0].velocity, 30);
  t.undoKey();
  assert.equal(t.notes()[0].velocity, 80);
  assert.equal(t.line().spoken, 'Undid: changed the velocity of C4.');
  t.undoKey();
  assert.equal(t.notes().length, 0);
  assert.equal(t.line().spoken, 'Undid: placed C4.');
});

function laneHistorySetup() {
  const lane = laneSetup();
  const viewEl = lane.get('scratch-view');
  const undoKey = (extra = {}) => viewEl.dispatch('keydown', { key: 'z', ctrlKey: true, ...extra });
  return { ...lane, undoKey };
}

test('moving the pitch window is not an edit and undo leaves the window where it is', () => {
  const t = historySetup();
  t.focus();
  t.press('Enter');
  t.get('scratch-higher').dispatch('click');
  assert.equal(t.attr('scratch-view', 'data-window-start'), '60');
  t.undoKey();
  assert.equal(t.attr('scratch-view', 'data-window-start'), '60');
  assert.equal(t.notes().length, 0);
  assert.equal(t.enabled('scratch-undo'), false);
});

test('undo during a drag ends the drag with nothing committed first', () => {
  const t = historySetup();
  t.drawOn();
  t.focus();
  t.press('Enter');
  t.down(t.x(30), t.y(65));
  t.move(t.x(40), t.y(65));
  assert.equal(t.hidden('scratch-preview'), false);
  t.undoKey();
  assert.equal(t.hidden('scratch-preview'), true);
  t.up(t.x(40), t.y(65));
  assert.equal(t.notes().length, 0, 'the undo took the placed note; the release drew nothing');
});

test('the history stays when the view is closed and opened again', () => {
  const t = historySetup();
  t.focus();
  t.press('Enter');
  t.view.closed();
  t.view.render();
  assert.equal(t.enabled('scratch-undo'), true);
  t.undoKey();
  assert.equal(t.notes().length, 0);
});

test('a hundred and thirty edits leave a hundred undo steps', () => {
  const t = historySetup();
  t.focus();
  for (let i = 0; i < 130; i += 1) t.press('Enter');
  let steps = 0;
  while (t.enabled('scratch-undo')) {
    t.undoKey();
    steps += 1;
  }
  assert.equal(steps, 100);
});

// --- Tap ---

const TAP_ANCHORS = { a: { c: 4, t: 1000 }, b: { c: 5, t: 3000 } };

function tapSetup() {
  const changes = [];
  const t = setup({ onTapChange: (on) => changes.push(on) });
  const enabled = () => t.get('scratch-tap').getAttribute('aria-disabled') !== 'true';
  const tapButton = () => t.get('scratch-tap').dispatch('click');
  return { ...t, changes, enabled, tapButton };
}

test('Tap rhythm is a button in the Mode group, after Draw, between Pitch and Undo, off at first', () => {
  const t = tapSetup();
  assert.equal(t.get('scratch-tap').textContent, 'Tap rhythm');
  assert.equal(t.get('scratch-tap').className, 'tl-btn');
  assert.equal(t.get('scratch-tap').parentNode.id, 'scratch-mode');
  assert.deepEqual(t.get('scratch-mode').children.map((button) => button.id), ['scratch-draw', 'scratch-tap']);
  const groups = t.get('scratch-controls').children.map((group) => group.id);
  assert.deepEqual(groups, ['scratch-grids', 'scratch-length', 'scratch-pitch', 'scratch-mode', 'scratch-edit', 'scratch-history', 'scratch-record-group', 'scratch-early']);
  assert.equal(t.attr('scratch-tap', 'aria-pressed'), 'false');
  assert.equal(t.attr('scratch-view', 'data-tap'), 'off');
  assert.equal(t.view.tapOn(), false);
});

test('with no music the Tap button has aria-disabled, and pressing it says so and leaves Tap off', () => {
  const t = tapSetup();
  assert.equal(t.enabled(), false);
  assert.equal(t.attr('scratch-tap', 'title'), SCRATCH_COPY.tapNeedsMusic);
  t.tapButton();
  assert.equal(t.view.tapOn(), false);
  assert.equal(t.attr('scratch-view', 'data-tap'), 'off');
  assert.deepEqual(t.line(), { kind: 'notice', name: '', rest: SCRATCH_COPY.tapNeedsMusic, spoken: SCRATCH_COPY.tapNeedsMusic });
  assert.deepEqual(t.changes, []);
});

test('t on the roll toggles Tap while the music plays, and says the needs-music line when it does not', () => {
  const t = tapSetup();
  t.focus();
  assert.equal(t.press('t').defaultPrevented, true);
  assert.equal(t.line().spoken, SCRATCH_COPY.tapNeedsMusic);
  assert.equal(t.view.tapOn(), false);
  t.view.setMusicPlaying(true);
  assert.equal(t.enabled(), true);
  assert.equal(t.attr('scratch-tap', 'title'), SCRATCH_COPY.tapTitle);
  t.press('t');
  assert.equal(t.view.tapOn(), true);
  assert.equal(t.attr('scratch-tap', 'aria-pressed'), 'true');
  assert.equal(t.attr('scratch-view', 'data-tap'), 'on');
  assert.equal(t.line().spoken, SCRATCH_COPY.tapStarted);
  t.press('t');
  assert.equal(t.view.tapOn(), false);
  assert.equal(t.attr('scratch-tap', 'aria-pressed'), 'false');
  assert.equal(t.line().spoken, SCRATCH_COPY.tapStopped);
  assert.deepEqual(t.changes, [true, false]);
});

test('pressing the Tap button while the music plays turns Tap on and off, and each change is told to the page', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.tapButton();
  assert.equal(t.view.tapOn(), true);
  t.tapButton();
  assert.equal(t.view.tapOn(), false);
  assert.deepEqual(t.changes, [true, false]);
});

test('a t with a modifier is not the Tap key', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.focus();
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.equal(t.press('t', extra).defaultPrevented, false);
  assert.equal(t.view.tapOn(), false);
});

test('Tap turns itself off when the music stops, and says why', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.tapButton();
  t.view.setNowUnit(12);
  t.view.setMusicPlaying(false);
  assert.equal(t.view.tapOn(), false);
  assert.equal(t.attr('scratch-view', 'data-tap'), 'off');
  assert.equal(t.enabled(), false);
  assert.equal(t.line().spoken, SCRATCH_COPY.tapMusicStopped);
  assert.equal(t.hidden('scratch-now'), true);
  assert.deepEqual(t.changes, [true, false]);
  t.view.setMusicPlaying(false);
  assert.deepEqual(t.changes, [true, false], 'a second stop changes nothing');
});

test('closing the view turns Tap off and tells the page once; a closed view with Tap off tells nothing', () => {
  const t = tapSetup();
  t.view.closed();
  assert.deepEqual(t.changes, []);
  t.view.setMusicPlaying(true);
  t.tapButton();
  t.view.closed();
  assert.equal(t.view.tapOn(), false);
  assert.equal(t.attr('scratch-tap', 'aria-pressed'), 'false');
  assert.deepEqual(t.changes, [true, false]);
  t.view.closed();
  assert.deepEqual(t.changes, [true, false]);
});

test('the now-marker shows only while Tap is on and a position is known, placed through one custom property', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.view.setNowUnit(30);
  assert.equal(t.hidden('scratch-now'), true, 'Tap is off');
  t.tapButton();
  assert.equal(t.hidden('scratch-now'), false);
  assert.equal(t.prop('scratch-now', '--sp-now'), '30');
  assert.equal(t.attr('scratch-view', 'data-now-unit'), '30');
  t.view.setNowUnit(31.5);
  assert.equal(t.prop('scratch-now', '--sp-now'), '31.5');
  t.view.setNowUnit(null);
  assert.equal(t.hidden('scratch-now'), true);
  assert.equal(t.attr('scratch-view', 'data-now-unit'), '');
  t.view.setNowUnit(5);
  t.tapButton();
  assert.equal(t.hidden('scratch-now'), true, 'turning Tap off hides it');
  assert.equal(t.attr('scratch-view', 'data-now-unit'), '');
});

test('setNowUnit refuses a position that is not a finite number or null', () => {
  const t = tapSetup();
  assert.throws(() => t.view.setNowUnit(NaN), /Moontide: /);
  assert.throws(() => t.view.setNowUnit('3'), /Moontide: /);
  assert.throws(() => t.view.setNowUnit(undefined), /Moontide: /);
});

test('a tap places a one-step note at the cursor row at 0.80 through the apply function, and is one undo step', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.tapButton();
  t.view.tap({ ts: 1500, h: 1500, anchors: TAP_ANCHORS });
  assert.deepEqual(t.notes().map((note) => [note.pitch, note.start, note.length, note.velocity]), [[60, 12, 3, 80]]);
  assert.equal(t.line().spoken, 'Tapped C4 at cycle 1, beat 2.');
  assert.equal(t.attr('scratch-view', 'data-notes'), '1');
  t.view.tap({ ts: 2500, h: 2500, anchors: TAP_ANCHORS });
  assert.equal(t.notes().length, 2);
  t.get('scratch-undo').dispatch('click');
  assert.equal(t.notes().length, 1, 'one undo step per tap');
  assert.equal(t.line().spoken, 'Undid: tapped C4.');
});

test('motifCycles tells the page how long the motif is now', () => {
  const t = tapSetup();
  assert.equal(t.view.motifCycles(), 2);
  t.get('scratch-more').dispatch('click');
  assert.equal(t.view.motifCycles(), 3);
});

test('a tap uses the cursor row, which the arrows move between taps', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.tapButton();
  t.focus();
  t.press('ArrowUp');
  t.press('ArrowUp');
  t.view.tap({ ts: 1500, h: 1500, anchors: TAP_ANCHORS });
  assert.equal(t.notes()[0].pitch, 62);
});

test('a tap while Tap is off places nothing', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.view.tap({ ts: 1500, h: 1500, anchors: TAP_ANCHORS });
  assert.deepEqual(t.notes(), []);
});

test('a refused tap puts its reason in the line and places and records nothing', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.tapButton();
  t.view.tap({ ts: 0, h: 1500, anchors: TAP_ANCHORS });
  assert.deepEqual(t.notes(), []);
  assert.equal(t.line().spoken, 'The time stamp of the key press was refused (it was zero), so nothing was placed.');
  t.view.tap({ ts: 1500, h: 1500, anchors: null });
  assert.equal(t.line().spoken, SCRATCH_COPY.tapClockUnreadable);
  assert.equal(t.get('scratch-undo').getAttribute('aria-disabled'), 'true', 'a refusal is no edit');
  assert.equal(t.view.tapOn(), true, 'Tap stays on after a refused tap');
});

test('the Tap button and the now-marker write only text, attributes and custom properties', () => {
  const t = tapSetup();
  t.view.setMusicPlaying(true);
  t.tapButton();
  t.view.setNowUnit(10);
  for (const name of t.get('scratch-now').style.props.keys()) assert.match(name, /^--sp-/, name);
  assert.equal(t.get('scratch-now').style.width, '');
});

// --- the listening strip (a MIDI keyboard) ---

const LISTEN_BASE = { listen: 'listening', ports: ['Keys'], listened: ['Keys'], notOpened: [], missing: [], unplugged: [], several: [], available: ['Keys'], failure: null, heard: null, refused: null, count: 0 };

test('setListening writes the state sentence, the heard line and the read-outs, and only what changed', () => {
  const { view, document, get, attr } = setup();
  view.setListening(LISTEN_BASE);
  assert.equal(get('scratch-listen-state').textContent, 'Listening to Keys. Play, and the notes show here.');
  assert.equal(get('scratch-listen-state').getAttribute('title'), 'Listening to Keys. Play, and the notes show here.');
  assert.equal(get('scratch-heard').textContent, '');
  assert.equal(attr('scratch-view', 'data-listen'), 'listening');
  assert.equal(attr('scratch-view', 'data-heard-count'), '0');
  assert.equal(attr('scratch-view', 'data-heard-pitch'), '');
  assert.equal(attr('scratch-view', 'data-heard-refused'), '');
  const writes = document.writes;
  view.setListening({ ...LISTEN_BASE });
  assert.equal(document.writes, writes, 'the same state writes nothing');
});

test('a new note rewrites the heard line and the read-outs and never the live sentence', () => {
  const { view, get, attr } = setup();
  view.setListening(LISTEN_BASE);
  const live = get('scratch-listen-state');
  const liveWrites = live.writes;
  view.setListening({ ...LISTEN_BASE, count: 1, heard: { pitch: 60, velocity: 100, cycle: 10.25, source: 'music' } });
  view.setListening({ ...LISTEN_BASE, count: 2, heard: { pitch: 64, velocity: 90, cycle: 10.5, source: 'music' } });
  assert.equal(live.writes, liveWrites, 'the live element is not touched by a note');
  assert.equal(get('scratch-heard').textContent, 'Heard E4 · 2 notes in the buffer.');
  assert.equal(attr('scratch-view', 'data-heard-count'), '2');
  assert.equal(attr('scratch-view', 'data-heard-pitch'), '64');
  assert.equal(attr('scratch-view', 'data-heard-cycle'), '10.5');
  assert.equal(attr('scratch-view', 'data-heard-source'), 'music');
});

test('a refused note says why in the heard line and in data-heard-refused', () => {
  const { view, get, attr } = setup();
  view.setListening({ ...LISTEN_BASE, refused: 'stale' });
  assert.equal(get('scratch-heard').textContent, 'A note from the keyboard was not kept: its time stamp was refused (it was more than a second old).');
  assert.equal(attr('scratch-view', 'data-heard-refused'), 'stale');
  view.setListening({ ...LISTEN_BASE, refused: 'clock' });
  assert.equal(get('scratch-heard').textContent, SCRATCH_COPY.heardRefusedClock);
});

test('the strip says what is missing and which inputs exist, and a port name stays plain text', () => {
  const { view, get, attr } = setup();
  view.setListening({ ...LISTEN_BASE, listen: 'missing', listened: [], missing: ['Keys'], available: ['Pads', '<b>x</b>'] });
  assert.equal(get('scratch-listen-state').textContent, 'Not listening: no MIDI input is named exactly Keys. Inputs here: Pads, <b>x</b>.');
  assert.equal(get('scratch-listen-state').children.length, 0, 'text only, no element');
  assert.equal(attr('scratch-view', 'data-listen'), 'missing');
  view.setListening({ ...LISTEN_BASE, listen: 'missing', listened: [], missing: ['Keys'], available: [] });
  assert.match(get('scratch-listen-state').textContent, /Inputs here: none\.$/);
  view.setListening({ ...LISTEN_BASE, listen: 'none', ports: [], listened: [] });
  assert.match(get('scratch-listen-state').textContent, /^Not listening: instruments\.json names no MIDI input\./);
  view.setListening({ ...LISTEN_BASE, listen: 'needs-permission', listened: [] });
  assert.equal(get('scratch-listen-state').textContent, 'The page can listen to Keys once MIDI is allowed.');
});

// Each state word of page/midi-in.js has its own sentence, written once.
const STATE_SENTENCES = [
  [{ listen: 'absent', ports: [] }, 'Not listening: there is no instruments.json, so no MIDI input is named. To listen to a keyboard, add "inputs": [{ "port": "its exact name" }] to one.'],
  [{ listen: 'invalid', ports: [] }, 'Not listening: instruments.json has a problem. The MIDI popover shows it.'],
  [{ listen: 'none', ports: [] }, /^Not listening: instruments\.json names no MIDI input\./],
  [{ listen: 'needs-permission' }, 'The page can listen to Keys once MIDI is allowed.'],
  [{ listen: 'pending' }, 'Waiting for the answer to the MIDI permission.'],
  [{ listen: 'denied' }, "Not listening: MIDI was refused for this page. Allow it in the browser's site settings, then reload."],
  [{ listen: 'unsupported' }, 'Not listening: this browser has no Web MIDI.'],
  [{ listen: 'failed', failure: 'AbortError' }, 'Not listening: MIDI could not start (AbortError).'],
  [{ listen: 'hidden' }, 'Listening is paused: this tab is hidden, behind another tab or covered by another window. It listens again when the tab is shown.'],
  [{ listen: 'other-tab' }, 'Not listening: another Moontide tab has the music. Take it back to listen here.'],
  [{ listen: 'missing', missing: ['Keyz'], available: ['Keys', 'Pads'] }, 'Not listening: no MIDI input is named exactly Keyz. Inputs here: Keys, Pads.'],
  [{ listen: 'unplugged', missing: ['Keys'], unplugged: ['Keys'], available: ['Pads'] }, 'Not listening: Keys was unplugged. Plug it in again; the page notices by itself. Inputs here: Pads.'],
  [{ listen: 'ambiguous', missing: ['Keys'], several: ['Keys'], available: ['Keys', 'Keys'] }, 'Not listening: 2 inputs are named exactly Keys, so the page cannot tell them apart.'],
  [{ listen: 'listening', ports: ['Keys', 'Pads', 'Dup'], listened: ['Keys'], missing: ['Pads', 'Dup'], several: ['Dup'] }, 'Listening to Keys. Play, and the notes show here. Not found: Pads. Not told apart: Dup.'],
  [{ listen: 'listening', ports: ['Keys', 'Pads'], listened: ['Keys'], notOpened: ['Pads'] }, 'Listening to Keys. Play, and the notes show here. Could not be opened: Pads.'],
  [{ listen: 'not-opened', listened: [], notOpened: ['Keys'] }, 'Not listening: Keys is connected but could not be opened; another program may be using it. Close that program, then plug the keyboard in again or reload the page.'],
];

test('every listening state says its own sentence, and the live element changes only when the state does', () => {
  const { view, get } = setup();
  for (const [partial, expected] of STATE_SENTENCES) {
    const state = { ...LISTEN_BASE, ...partial };
    view.setListening(state);
    const text = get('scratch-listen-state').textContent;
    if (typeof expected === 'string') assert.equal(text, expected, state.listen);
    else assert.match(text, expected, state.listen);
    const writes = get('scratch-listen-state').writes;
    view.setListening({ ...state, count: 3, heard: { pitch: 60, velocity: 90, cycle: 1, source: 'music' } });
    assert.equal(get('scratch-listen-state').writes, writes, `${state.listen}: a note leaves the live sentence alone`);
  }
});

test('an unknown listening state is a loud error', () => {
  const { view } = setup();
  assert.throws(() => view.setListening({ ...LISTEN_BASE, listen: 'dreaming' }), /listening state is not known/);
});

test('the Allow MIDI to listen button shows only in the two states where asking can help, and a press calls onAllow', () => {
  const document = scratchMarkup();
  const presses = [];
  const view = createScratchView({ document, rootFontPx: () => REM, onAllow: () => presses.push('allow') });
  const button = document.getElementById('scratch-allow');
  assert.equal(button.textContent, 'Allow MIDI to listen');
  const shown = (listen) => {
    view.setListening({ ...LISTEN_BASE, listen });
    return !button.hasAttribute('hidden');
  };
  for (const listen of ['needs-permission', 'failed']) assert.equal(shown(listen), true, listen);
  for (const listen of ['absent', 'invalid', 'none', 'pending', 'denied', 'unsupported', 'hidden', 'other-tab', 'missing', 'unplugged', 'ambiguous', 'listening']) {
    assert.equal(shown(listen), false, listen);
  }
  view.setListening({ ...LISTEN_BASE, listen: 'needs-permission' });
  button.dispatch('click');
  assert.deepEqual(presses, ['allow']);
});

test('a port name longer than the name limit is cut in the strip', () => {
  const { view, get } = setup();
  const long = 'k'.repeat(300);
  view.setListening({ ...LISTEN_BASE, ports: [long], listened: [long] });
  assert.equal(get('scratch-listen-state').textContent, `Listening to ${'k'.repeat(199)}…. Play, and the notes show here.`);
});

test('the view throws a loud error naming a missing listening id', () => {
  const document = scratchMarkup();
  document.getElementById('scratch-heard').remove();
  assert.throws(() => createScratchView({ document, rootFontPx: () => REM }), /needs #scratch-heard in the page\./);
});

// --- Record that ---

const RECORD_SNAPSHOT = { start: 3, cycles: 8, notes: [{ pitch: 60, velocity: 127, start: 2.25, end: 2.5, run: null }, { pitch: 64, velocity: 64, start: 3.5, end: 3.75, run: null }] };

function recordSetup() {
  const presses = [];
  const t = setup({ onRecord: () => presses.push('record') });
  const enabled = () => t.get('scratch-record').getAttribute('aria-disabled') !== 'true';
  const press = () => t.get('scratch-record').dispatch('click');
  const hear = (count) => t.view.setListening({ ...LISTEN_BASE, count });
  return { ...t, presses, enabled, record: press, hear };
}

test('Record that is a button in a Keyboard group at the end of the toolbar', () => {
  const t = recordSetup();
  assert.equal(t.get('scratch-record').textContent, 'Record that');
  assert.equal(t.get('scratch-record').className, 'tl-btn');
  assert.equal(t.get('scratch-record').parentNode.id, 'scratch-record-group');
  assert.equal(t.get('scratch-record-group').getAttribute('aria-label'), 'Keyboard');
  // The Early experimental label follows the Keyboard group as the last item of the toolbar.
  assert.equal(t.get('scratch-controls').children.at(-2).id, 'scratch-record-group');
  assert.equal(t.get('scratch-controls').children.at(-1).id, 'scratch-early');
});

test('the Record that button follows the count of heard notes: aria-disabled at 0 with the reason as title', () => {
  const t = recordSetup();
  assert.equal(t.enabled(), false);
  assert.equal(t.attr('scratch-record', 'title'), SCRATCH_COPY.recordNothing);
  t.hear(2);
  assert.equal(t.enabled(), true);
  assert.equal(t.attr('scratch-record', 'title'), SCRATCH_COPY.recordTitle);
  t.hear(0);
  assert.equal(t.enabled(), false);
});

test('a press with nothing heard says so in the line and calls nothing', () => {
  const t = recordSetup();
  t.record();
  assert.deepEqual(t.presses, []);
  assert.equal(t.line().spoken, SCRATCH_COPY.recordNothing);
  assert.equal(t.get('scratch-undo').getAttribute('aria-disabled'), 'true', 'no undo step');
});

test('a press with notes heard asks the page for the snapshot', () => {
  const t = recordSetup();
  t.hear(3);
  t.record();
  assert.deepEqual(t.presses, ['record']);
});

test('record(snapshot) replaces the motif in one step, shows the notice, and Undo brings the old motif back', () => {
  const t = recordSetup();
  t.focus();
  t.press('Enter');
  assert.equal(t.notes().length, 1);
  t.view.record(RECORD_SNAPSHOT);
  assert.deepEqual(t.notes().map((note) => [note.pitch, note.start, note.length, note.velocity]), [[60, 12, 12, 100], [64, 72, 12, 50]]);
  assert.equal(t.attr('scratch-view', 'data-cycles'), '2');
  assert.ok(t.line().spoken.startsWith('Recorded 2 notes over 2 cycles on sixteenths.'), t.line().spoken);
  assert.equal(t.attr('scratch-view', 'data-window-start'), '60');
  t.get('scratch-view').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(t.notes().length, 1);
  assert.equal(t.notes()[0].pitch, 60);
  assert.equal(t.line().spoken, 'Undid: recorded the keyboard.');
});

test('record(snapshot) moves the pitch window to the notes', () => {
  const t = recordSetup();
  t.view.record({ start: 0, cycles: 8, notes: [{ pitch: 85, velocity: 100, start: 0, end: 0.25, run: null }, { pitch: 90, velocity: 100, start: 0.5, end: 0.75, run: null }] });
  assert.equal(t.attr('scratch-view', 'data-window-start'), '84');
  assert.equal(t.notes().length, 2);
});

test('an empty snapshot says the sentence and adds no undo step; a null one says the clock words', () => {
  const t = recordSetup();
  t.view.record({ start: 0, cycles: 8, notes: [] });
  assert.equal(t.line().spoken, SCRATCH_COPY.recordNothing);
  t.view.record(null);
  assert.equal(t.line().spoken, SCRATCH_COPY.recordClockUnreadable);
  assert.equal(t.get('scratch-undo').getAttribute('aria-disabled'), 'true');
  assert.deepEqual(t.notes(), []);
});

test('a view made without onRecord still takes a press', () => {
  const t = setup();
  t.view.setListening({ ...LISTEN_BASE, count: 1 });
  t.get('scratch-record').dispatch('click');
  assert.deepEqual(t.notes(), []);
});

test('a full buffer is said in the heard line', () => {
  const { view, get } = setup();
  view.setListening({ ...LISTEN_BASE, refused: 'full' });
  assert.equal(get('scratch-heard').textContent, SCRATCH_COPY.heardRefusedFull);
});

// --- Send to Claude ---

/** A view whose page answers every send with an id and keeps what it was sent. */
function sendSetup(options = {}) {
  const sends = [];
  const setupResult = setup({
    onSend: (request) => {
      sends.push(request);
      return { id: `ask-${sends.length}` };
    },
    ...options,
  });
  return { ...setupResult, sends };
}

test('the strip starts with the default sentence in the words field, the empty phrase text and an empty status line', () => {
  const { get } = sendSetup();
  assert.equal(get('scratch-words').value, SCRATCH_COPY.defaultWords);
  assert.equal(get('scratch-words').value, 'Add this motif to the music.');
  assert.equal(get('scratch-phrase').textContent, SCRATCH_COPY.phraseEmpty);
  assert.equal(get('scratch-phrase').getAttribute('aria-label'), SCRATCH_COPY.phraseLabel);
  assert.equal(get('scratch-words').getAttribute('aria-label'), SCRATCH_COPY.wordsLabel);
  assert.equal(get('scratch-send-button').textContent, SCRATCH_COPY.send);
  assert.equal(get('scratch-send-button').getAttribute('title'), SCRATCH_COPY.sendNoNotes, 'with no notes the title says why it cannot send');
  assert.equal(get('scratch-send-status').textContent, '');
});

test('the phrase element shows exactly the phrase of the motif after every edit, and the empty text again when the notes go', () => {
  const { get, focus, press } = sendSetup();
  focus();
  press('Enter');
  const first = get('scratch-phrase').textContent;
  assert.match(first, /^note\("\[c4 ~ /);
  press('ArrowRight');
  press('ArrowUp');
  press('Enter');
  const second = get('scratch-phrase').textContent;
  assert.notEqual(second, first);
  assert.match(second, /c4/);
  assert.match(second, /c#4/);
  press('Delete');
  press('ArrowLeft');
  press('ArrowDown');
  press('Delete');
  assert.equal(get('scratch-phrase').textContent, SCRATCH_COPY.phraseEmpty);
});

test('a press on Send to Claude hands the words and the motif request to onSend, and the phrase sent is the phrase shown', () => {
  const { get, focus, press, sends } = sendSetup({ musicCycle: () => 13.6 });
  focus();
  press('Enter');
  get('scratch-words').value = 'Put this on top of the pad.';
  const shown = get('scratch-phrase').textContent;
  get('scratch-send-button').dispatch('click');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].words, 'Put this on top of the pad.');
  assert.deepEqual(sends[0].motif, { source: 'drawn', cycle: 12, cycles: 2, grid: 'sixteenth', notes: 1, phrase: shown });
  assert.equal(get('scratch-send-status').textContent, 'Sent to Claude at cycle 12. The Requests panel shows what becomes of it.');
});

test('a send while the music is stopped carries no cycle and the status line says so', () => {
  const { get, focus, press, sends } = sendSetup();
  focus();
  press('Enter');
  get('scratch-send-button').dispatch('click');
  assert.equal(Object.hasOwn(sends[0].motif, 'cycle'), false);
  assert.equal(get('scratch-send-status').textContent, 'Sent to Claude with no moment. The Requests panel shows what becomes of it.');
});

test('Enter in the words field sends like the button; a composing or held Enter sends nothing; the key goes no further', () => {
  const { get, focus, press, sends } = sendSetup();
  focus();
  press('Enter');
  const words = get('scratch-words');
  const composing = words.dispatch('keydown', { key: 'Enter', isComposing: true });
  assert.equal(composing.defaultPrevented, false, 'a composing Enter belongs to the input method');
  const held = words.dispatch('keydown', { key: 'Enter', repeat: true });
  assert.equal(held.defaultPrevented, true);
  assert.equal(held.stopped, true);
  words.dispatch('keydown', { key: 'a' });
  assert.equal(sends.length, 0);
  const sent = words.dispatch('keydown', { key: 'Enter' });
  assert.equal(sent.defaultPrevented, true);
  assert.equal(sent.stopped, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].words, 'Add this motif to the music.');
});

test('nothing but a press sends: edits, the cursor and the keys of the roll never call onSend', () => {
  const { get, focus, press, sends } = sendSetup();
  focus();
  for (const key of ['Enter', 'ArrowRight', 'Enter', 'Delete', 'Home', 'End', 'v', ' ']) press(key);
  get('scratch-words').dispatch('input');
  assert.equal(sends.length, 0);
});

test('a press on an empty motif is refused by the view itself with the no-notes sentence', () => {
  const { get, sends } = sendSetup();
  get('scratch-send-button').dispatch('click');
  assert.equal(sends.length, 0);
  assert.equal(get('scratch-send-status').textContent, 'Nothing to send: the motif has no notes.');
});

test('a view made without a page fails loudly when Send is pressed', () => {
  const { get, focus, press } = setup();
  focus();
  press('Enter');
  assert.throws(() => get('scratch-send-button').dispatch('click'), /^Error: Moontide: the Scratchpad view was made without onSend/);
});

test('Ctrl+Z typed in the words field is the field\'s own undo and never undoes the motif', () => {
  const { get, focus, press, notes } = sendSetup();
  focus();
  press('Enter');
  assert.equal(notes().length, 1);
  // The key bubbles from the field to the view, whose undo keys must leave it alone; the fake document does not bubble, so the event is
  // dispatched on the view with the field as its target.
  const undone = get('scratch-view').dispatch('keydown', { key: 'z', ctrlKey: true, target: get('scratch-words') });
  assert.equal(undone.defaultPrevented, false);
  assert.equal(notes().length, 1);
  get('scratch-view').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(notes().length, 0, 'the same key from the roll undoes the motif');
});

// --- the refusals of Send to Claude ---

test('the Send button carries aria-disabled with the reason as its title while the motif has no notes, the page is not connected or a send is on its way', () => {
  const { get, focus, press, view } = sendSetup();
  const button = get('scratch-send-button');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('title'), SCRATCH_COPY.sendNoNotes);
  assert.equal(button.hasAttribute('disabled'), false, 'never the disabled attribute');
  focus();
  press('Enter');
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  assert.equal(button.getAttribute('title'), SCRATCH_COPY.sendTitle);
  view.setSendState({ connected: false, pending: false });
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('title'), 'Not sent: the page is not connected to Moontide.');
  view.setSendState({ connected: true, pending: true });
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('title'), 'Not sent: the last motif request is still on its way.');
  view.setSendState({ connected: true, pending: false });
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  press('Delete');
  assert.equal(button.getAttribute('aria-disabled'), 'true', 'erasing the last note disables it again');
});

test('a press on a disabled Send button says the reason in the status line and calls onSend never', () => {
  const { get, focus, press, view, sends } = sendSetup();
  focus();
  press('Enter');
  view.setSendState({ connected: false, pending: false });
  get('scratch-send-button').dispatch('click');
  assert.equal(get('scratch-send-status').textContent, 'Not sent: the page is not connected to Moontide.');
  view.setSendState({ connected: true, pending: true });
  get('scratch-send-button').dispatch('click');
  assert.equal(get('scratch-send-status').textContent, 'Not sent: the last motif request is still on its way.');
  assert.equal(sends.length, 0);
});

test('Enter in the words field is refused the same way while the send is disabled', () => {
  const { get, focus, press, view, sends } = sendSetup();
  focus();
  press('Enter');
  view.setSendState({ connected: true, pending: true });
  get('scratch-words').dispatch('keydown', { key: 'Enter' });
  assert.equal(sends.length, 0);
  assert.equal(get('scratch-send-status').textContent, 'Not sent: the last motif request is still on its way.');
});

test('a refusal from the page lands in the status line and leaves the words as typed', () => {
  const refusals = [
    [{ refused: 'empty-words' }, 'Nothing to send: write a few words for Claude first.'],
    [{ refused: 'words-too-long', length: 2100, max: 2000 }, 'Not sent: the words are 2100 characters, 2000 at most.'],
    [{ refused: 'too-big', bytes: 9000, max: 8192 }, 'Not sent: the request would be 9000 bytes, 8192 at most. Fewer cycles, a coarser grid, fewer notes sounding together or shorter words make it smaller.'],
  ];
  for (const [refusal, sentence] of refusals) {
    const sends = [];
    const { get, focus, press } = setup({ onSend: (request) => (sends.push(request), refusal) });
    focus();
    press('Enter');
    get('scratch-words').value = '  my own words  ';
    get('scratch-send-button').dispatch('click');
    assert.equal(sends.length, 1);
    assert.equal(get('scratch-send-status').textContent, sentence);
    assert.equal(get('scratch-words').value, '  my own words  ');
  }
});

test('what became of the request is written in the status line, an arrived one keeps the sent line', () => {
  const { get, focus, press, view } = sendSetup();
  focus();
  press('Enter');
  get('scratch-send-button').dispatch('click');
  const sent = get('scratch-send-status').textContent;
  view.motifResult({ status: 'received' });
  assert.equal(get('scratch-send-status').textContent, sent);
  view.motifResult({ status: 'refused', text: 'too many requests — wait a moment, then send again.' });
  assert.equal(get('scratch-send-status').textContent, 'Not sent: too many requests — wait a moment, then send again.');
  view.motifResult({ status: 'not-confirmed' });
  assert.equal(get('scratch-send-status').textContent, 'Moontide did not confirm the motif request. Try again.');
  assert.throws(() => view.motifResult({ status: 'later' }), /^Error: Moontide: /);
});

test('setSendState refuses a state that is not two booleans', () => {
  const { view } = sendSetup();
  assert.throws(() => view.setSendState({ connected: 'yes', pending: false }), /^TypeError: Moontide: /);
  assert.throws(() => view.setSendState({ connected: true }), /^TypeError: Moontide: /);
});

// --- Select mode, Draw mode and the double-click ---

// Three notes made by double-click: C4 at 0 and E4 at 30 (both one step) and G4 at 60.
function withThreeNotes() {
  const t = setup();
  t.dbl(t.x(0), t.y(60));
  t.dbl(t.x(30), t.y(64));
  t.dbl(t.x(60), t.y(67));
  assert.equal(t.notes().length, 3);
  return t;
}
const undoEnabled = (t) => t.get('scratch-undo').getAttribute('aria-disabled') !== 'true';

test('in Select mode a drag on an empty cell shows a dashed box, selects the notes it touches and writes nothing', () => {
  const t = withThreeNotes();
  const { down, move, up, x, y, grid, hidden, prop, attr } = t;
  const motifBefore = t.notes().map(({ selected, ...note }) => note);
  const writesBefore = t.document.writes;
  down(x(5), y(70));
  assert.equal(hidden('scratch-select-rect'), true, 'the box waits for the pointer to move');
  move(x(35), y(63));
  assert.equal(hidden('scratch-select-rect'), false);
  assert.equal(hidden('scratch-preview'), true, 'no note is previewed');
  assert.deepEqual([prop('scratch-select-rect', '--sp-start'), prop('scratch-select-rect', '--sp-len')], ['5.1', '30']);
  assert.equal(attr('scratch-view', 'data-selected-count'), '1', 'the box touches E4 only so far');
  move(x(65), y(59));
  assert.equal(attr('scratch-view', 'data-selected'), '2,3', 'the box now touches E4 and G4');
  assert.equal(attr('scratch-view', 'data-selected-count'), '2');
  up(x(65), y(59));
  assert.equal(hidden('scratch-select-rect'), true, 'the box goes at the release');
  assert.equal(grid.capturedPointer, null);
  assert.equal(attr('scratch-view', 'data-selected'), '2,3', 'the selection stays');
  assert.deepEqual(t.notes().map(({ selected, ...note }) => note), motifBefore, 'no note was written or changed');
  assert.equal(attr('scratch-view', 'data-notes'), '3');
  assert.ok(t.document.writes > writesBefore);
  t.get('scratch-undo').dispatch('click');
  assert.equal(t.notes().length, 2, 'the history holds the three double-clicks and no step for the box');
});

test('a box replaces the earlier selection, and a box over empty cells selects nothing', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  t.down(t.x(50), t.y(70));
  t.move(t.x(70), t.y(66));
  t.up(t.x(70), t.y(66));
  assert.equal(t.attr('scratch-view', 'data-selected'), '3');
  t.down(t.x(10), t.y(55));
  t.move(t.x(20), t.y(50));
  t.up(t.x(20), t.y(50));
  assert.equal(t.attr('scratch-view', 'data-selected'), '');
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0');
});

test('the box can be dragged back across the press and out of the grid; it stays inside the grid', () => {
  const t = withThreeNotes();
  t.down(t.x(40), t.y(70));
  t.move(t.x(36), t.y(66));
  assert.equal(t.attr('scratch-view', 'data-selected'), '', 'the box spans empty cells');
  t.move(t.x(-20), t.y(50));
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,2', 'out of the grid the box stops at its edge and touches C4 and E4');
  assert.equal(t.prop('scratch-select-rect', '--sp-start'), '0');
  t.up(t.x(-20), t.y(50));
});

test('a click on empty space clears the selection and puts the cursor there; a click on a note selects only that note', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  t.down(t.x(30), t.y(64));
  t.up(t.x(30), t.y(64));
  assert.equal(t.attr('scratch-view', 'data-selected'), '2', 'the second click replaced the selection');
  assert.deepEqual(t.cursor(), { unit: 30, pitch: 64 });
  t.down(t.x(45), t.y(62));
  t.up(t.x(45), t.y(62));
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0');
  assert.deepEqual(t.cursor(), { unit: 45, pitch: 62 });
  assert.equal(t.notes().length, 3, 'no click wrote a note');
});

test('a double-click on an empty cell writes a one-step note at 0.80 in one undo step and selects it', () => {
  const t = setup();
  assert.equal(undoEnabled(t), false);
  t.dbl(t.x(31), t.y(62));
  assert.deepEqual(t.notes().map(({ label, ...note }) => note), [{ id: 1, pitch: 62, start: 30, length: 3, velocity: 80, selected: true }]);
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  assert.equal(t.line().spoken, 'Placed D4 at cycle 1, beat 3.5.');
  assert.deepEqual(t.cursor(), { unit: 30, pitch: 62 });
  t.get('scratch-undo').dispatch('click');
  assert.deepEqual(t.notes(), []);
  assert.equal(undoEnabled(t), false, 'one step was enough to undo it');
});

test('a double-click on a note only selects it: no edit, no second note', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  t.down(t.x(30), t.y(64));
  t.up(t.x(30), t.y(64));
  const before = t.notes().map(({ selected, ...note }) => note);
  t.get('scratch-undo').dispatch('click');
  t.get('scratch-redo').dispatch('click');
  t.dbl(t.x(1), t.y(60));
  assert.equal(t.attr('scratch-view', 'data-selected'), '1', 'only the note that was double-clicked is selected');
  assert.deepEqual(t.notes().map(({ selected, ...note }) => note), before);
  assert.equal(t.get('scratch-redo').getAttribute('aria-disabled'), 'true', 'the double-click was no edit: Redo is still as it was');
});

test('a double-click outside the grid or with another button writes nothing', () => {
  const t = setup();
  t.dbl(50, 100);
  t.dbl(t.x(12), t.y(60), { button: 2 });
  assert.deepEqual(t.notes(), []);
});

test('Draw is a visible toggle: the button and the key d turn it on and off, and the line and the hint say which', () => {
  const t = setup();
  t.focus();
  assert.equal(t.get('scratch-draw').textContent, 'Draw');
  assert.equal(t.get('scratch-draw').getAttribute('aria-label'), 'Draw notes with a drag');
  assert.match(t.get('scratch-draw').getAttribute('title'), /key d/);
  assert.equal(t.attr('scratch-draw', 'aria-pressed'), 'false');
  assert.equal(t.get('scratch-hint').textContent, SCRATCH_COPY.hintSelect);
  t.get('scratch-draw').dispatch('click');
  assert.equal(t.attr('scratch-draw', 'aria-pressed'), 'true');
  assert.equal(t.attr('scratch-view', 'data-draw'), 'on');
  assert.equal(t.get('scratch-hint').textContent, SCRATCH_COPY.hintDraw);
  assert.equal(t.line().spoken, 'Draw is on.');
  const event = t.press('d');
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.attr('scratch-draw', 'aria-pressed'), 'false');
  assert.equal(t.attr('scratch-view', 'data-draw'), 'off');
  assert.equal(t.get('scratch-hint').textContent, SCRATCH_COPY.hintSelect);
  assert.equal(t.line().spoken, 'Draw is off.');
  t.press('d');
  assert.equal(t.attr('scratch-view', 'data-draw'), 'on');
  assert.equal(undoEnabled(t), false, 'a mode is no edit');
});

test('with Draw on a drag on an empty cell writes the note as before and a click writes nothing', () => {
  const t = setup();
  t.drawOn();
  t.down(t.x(12), t.y(60));
  t.move(t.x(20), t.y(60));
  assert.equal(t.hidden('scratch-select-rect'), true, 'no box in Draw mode');
  assert.equal(t.hidden('scratch-preview'), false);
  t.up(t.x(20), t.y(60));
  assert.deepEqual(t.notes().map(({ label, ...note }) => note), [{ ...NOTE_AT_START, selected: true }]);
  t.down(t.x(50), t.y(62));
  t.up(t.x(50), t.y(62));
  assert.equal(t.notes().length, 1, 'a plain click writes nothing in Draw mode either');
  t.dbl(t.x(50), t.y(62));
  assert.equal(t.notes().length, 2, 'a double-click writes one note in Draw mode, and the second click of it drew no second note');
});

test('a note written by a double-click while Draw is on is one note, whatever the clicks drew', () => {
  const t = setup();
  t.drawOn();
  t.down(t.x(50), t.y(62));
  t.up(t.x(50), t.y(62));
  t.down(t.x(50), t.y(62));
  t.up(t.x(50), t.y(62));
  t.dbl(t.x(50), t.y(62));
  assert.equal(t.notes().length, 1);
});

test('a cancelled box restores the selection it began with, and closed() ends a box with nothing changed', () => {
  for (const [name, end] of [['pointercancel', ({ grid }) => grid.dispatch('pointercancel', { pointerId: 1 })], ['closed', ({ view }) => view.closed()]]) {
    const t = withThreeNotes();
    t.down(t.x(0), t.y(60));
    t.up(t.x(0), t.y(60));
    t.down(t.x(20), t.y(70));
    t.move(t.x(70), t.y(50));
    assert.equal(t.attr('scratch-view', 'data-selected-count'), '2', name);
    end(t);
    assert.equal(t.hidden('scratch-select-rect'), true, name);
    assert.equal(t.attr('scratch-view', 'data-selected'), '1', `${name}: the selection is the one before the box`);
    assert.equal(t.notes().length, 3, name);
  }
});

test('the selection stays while the view is closed and opened again, and moving the cursor does not change it', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  t.view.closed();
  t.view.render();
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  t.focus();
  t.press('ArrowRight');
  t.press('ArrowUp');
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
});

test('the line reads the selected note without focus, and the box and the double-click write no extra live-region text', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  assert.equal(t.line().kind, 'note');
  assert.equal(t.line().name, 'C4');
});

test('the rectangle is placed through custom properties only, and drawing the same state again writes nothing', () => {
  const t = withThreeNotes();
  t.down(t.x(5), t.y(70));
  t.move(t.x(35), t.y(63));
  const writes = t.document.writes;
  t.view.render();
  t.view.render();
  assert.equal(t.document.writes, writes);
  assert.equal(t.get('scratch-select-rect').style.width, '', 'the view writes no width');
  t.up(t.x(35), t.y(63));
});

test('Draw mode does not outlast the page, and a view made fresh starts with Draw off', () => {
  const t = setup();
  assert.equal(t.attr('scratch-view', 'data-draw'), 'off');
  assert.equal(t.attr('scratch-draw', 'aria-pressed'), 'false');
});

// --- A selection built and edited by mouse and keyboard ---

const starts = (t) => t.notes().map((note) => [note.id, note.pitch, note.start, note.length]);
// The three notes, the roll focused and the cursor on C4 at the start, nothing selected: where the keyboard checks begin.
function withKeys() {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(61));
  t.up(t.x(0), t.y(61));
  t.focus();
  t.press('ArrowDown');
  assert.deepEqual(t.cursor(), { unit: 0, pitch: 60 });
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0');
  return t;
}
const clickUndo = (t) => t.get('scratch-undo').dispatch('click');

test('Ctrl+A and Cmd+A select every note and Ctrl+Shift+A and Cmd+Shift+A select none, with the default prevented and the history untouched', () => {
  const t = withThreeNotes();
  t.focus();
  for (const extra of [{ ctrlKey: true }, { metaKey: true }]) {
    const all = t.press('a', extra);
    assert.equal(all.defaultPrevented, true, JSON.stringify(extra));
    assert.equal(t.attr('scratch-view', 'data-selected'), '1,2,3');
    assert.equal(t.line().spoken, 'Selected all 3 notes.');
    const none = t.press('A', { ...extra, shiftKey: true });
    assert.equal(none.defaultPrevented, true);
    assert.equal(t.attr('scratch-view', 'data-selected-count'), '0');
    assert.equal(t.line().spoken, 'Selected none.');
  }
  clickUndo(t);
  assert.equal(t.notes().length, 2, 'the three double-clicks are the only steps the history holds');
});

test('Select all on an empty roll says so, and a plain a is left to the page', () => {
  const t = setup();
  t.focus();
  t.press('a', { ctrlKey: true });
  assert.equal(t.line().spoken, 'No notes to select.');
  assert.equal(t.press('a').defaultPrevented, false);
  assert.equal(t.press('b').defaultPrevented, false);
  assert.equal(t.press('3').defaultPrevented, false);
});

test('Select all works from the focused lane too', () => {
  const t = laneSetup();
  withChord(t);
  t.lfocus();
  const event = t.lkey('a', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '3');
  t.lkey('a', { metaKey: true, shiftKey: true });
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0');
});

test('s adds the note under the cursor to the selection or takes it out, and says so on an empty cell', () => {
  const t = withKeys();
  t.press('s');
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  assert.equal(t.line().spoken, 'Selected C4. 1 note selected.');
  t.press('End');
  t.press('s');
  assert.equal(t.line().spoken, 'No note here to select.');
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  t.press('Home');
  t.press(']');
  t.press('s');
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,2');
  assert.equal(t.line().spoken, 'Selected E4. 2 notes selected.');
  t.press('s');
  assert.equal(t.attr('scratch-view', 'data-selected'), '1');
  assert.equal(t.line().spoken, 'Removed E4 from the selection. 1 note selected.');
  t.press('[');
  t.press('s');
  assert.equal(t.line().spoken, 'Removed C4 from the selection. Nothing selected.');
  assert.equal(t.press('s').defaultPrevented, true);
});

test('[ and ] walk the cursor to the previous and the next note in time order and leave the selection alone', () => {
  const t = withKeys();
  t.press('a', { ctrlKey: true });
  t.press('s');
  t.press(']');
  assert.deepEqual(t.cursor(), { unit: 30, pitch: 64 });
  t.press(']');
  assert.deepEqual(t.cursor(), { unit: 60, pitch: 67 });
  t.press(']');
  assert.deepEqual(t.cursor(), { unit: 60, pitch: 67 }, 'there is no later note');
  assert.equal(t.line().spoken, 'No later note.');
  t.press('[');
  t.press('[');
  assert.deepEqual(t.cursor(), { unit: 0, pitch: 60 });
  t.press('[');
  assert.equal(t.line().spoken, 'No earlier note.');
  assert.equal(t.attr('scratch-view', 'data-selected'), '2,3', 'the selection is as it was: s took C4 out');
  assert.equal(t.press(']').defaultPrevented, true);
});

test('the brackets are matched by the character the key gives, whatever modifier made it', () => {
  const t = withKeys();
  t.press(']', { altKey: true });
  assert.deepEqual(t.cursor(), { unit: 30, pitch: 64 }, 'Alt');
  t.press(']', { ctrlKey: true, altKey: true });
  assert.deepEqual(t.cursor(), { unit: 60, pitch: 67 }, 'AltGr reads as Ctrl and Alt together');
  t.press('[', { shiftKey: true });
  assert.deepEqual(t.cursor(), { unit: 30, pitch: 64 }, 'Shift');
  assert.equal(t.press('[', { metaKey: true }).defaultPrevented, false, 'Cmd with a bracket stays the browser\'s');
  assert.equal(t.press(']', { ctrlKey: true }).defaultPrevented, false);
});

test('with several notes selected the line reads them as a group, and the notice of [ and ] reads the note the cursor came to', () => {
  const t = withKeys();
  t.press('a', { ctrlKey: true });
  t.press('Home');
  t.get('scratch-roll').dispatch('blur');
  t.document.activeElement = null;
  assert.deepEqual(t.line(), { kind: 'selection', name: '3 notes selected', rest: ' · C4 to G4 · from cycle 1, beat 1', spoken: '3 notes selected · C4 to G4 · from cycle 1, beat 1' });
  t.focus();
  t.press(']');
  assert.equal(t.line().spoken, 'E4, starts at cycle 1, beat 3.5, lasts 1 sixteenth (0.25 beat), velocity 0.80.');
});

test('the arrows move the whole selection; a refusal at the end of the motif says why and leaves everything as it was', () => {
  const t = withKeys();
  t.press('s');
  t.press(']');
  t.press('s');
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,2');
  t.press('ArrowRight');
  assert.deepEqual(starts(t), [[1, 60, 3, 3], [2, 64, 33, 3], [3, 67, 60, 3]].sort((a, b) => a[2] - b[2]));
  assert.equal(t.line().spoken, 'Moved 2 notes one sixteenth later.');
  assert.deepEqual(t.cursor(), { unit: 33, pitch: 64 }, 'the cursor follows');
  t.press('ArrowUp', { altKey: true });
  assert.equal(t.line().spoken, 'Moved 2 notes up one octave.');
  t.press('ArrowLeft', { altKey: true });
  assert.equal(t.line().spoken, 'Not moved: the first note is already at the start of the motif.');
  assert.deepEqual(starts(t).map((note) => note[2]), [3, 33, 60]);
  t.press('ArrowRight', { altKey: true });
  assert.equal(t.line().spoken, 'Moved 2 notes 4 sixteenths later.');
});

test('a held arrow is one undo step: the repeats replace the step and the notice sums the move', () => {
  const t = withKeys();
  t.press('s');
  t.press(']');
  t.press('s');
  const before = starts(t);
  t.press('ArrowRight');
  for (let i = 0; i < 3; i += 1) t.press('ArrowRight', { repeat: true });
  assert.equal(t.line().spoken, 'Moved 2 notes 4 sixteenths later.');
  assert.deepEqual(starts(t).map((note) => note[2]), [12, 42, 60]);
  assert.deepEqual(t.cursor(), { unit: 42, pitch: 64 });
  clickUndo(t);
  assert.deepEqual(starts(t), before, 'one Undo goes back to before the key went down');
  assert.equal(t.line().spoken, 'Undid: moved 2 notes.');
  clickUndo(t);
  assert.equal(t.notes().length, 2, 'the step before it is the third double-click');
});

test('a second press after a held run is a new step', () => {
  const t = withKeys();
  t.press('s');
  t.press('ArrowRight');
  t.press('ArrowRight', { repeat: true });
  t.press('ArrowRight');
  assert.equal(starts(t)[0][2], 9, 'two presses make two steps');
  clickUndo(t);
  assert.equal(starts(t)[0][2], 6);
  clickUndo(t);
  assert.equal(starts(t)[0][2], 0);
});

test('a held arrow that reaches the end of the motif stops there: the later repeats are refused and the move stays', () => {
  const t = setup();
  t.dbl(t.x(78), t.y(60));
  t.focus();
  assert.equal(t.attr('scratch-view', 'data-selected'), '1', 'the double-click selected the note it wrote');
  t.press('ArrowRight', { altKey: true });
  assert.equal(t.notes()[0].start, 90);
  t.press('ArrowRight', { altKey: true, repeat: true });
  assert.equal(t.line().spoken, 'Not moved: the last note already ends at the end of the motif.');
  assert.equal(t.notes()[0].start, 90, 'what the run had moved stays');
  clickUndo(t);
  assert.equal(t.notes()[0].start, 78, 'one Undo undoes the run');
});

test('Shift+Right and Shift+Left change the length of every selected note by one step, as one command', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  t.press('ArrowRight', { shiftKey: true });
  assert.deepEqual(starts(t).map((note) => note[3]), [6, 6, 6]);
  assert.equal(t.line().spoken, 'Made 3 notes one sixteenth longer.');
  t.press('ArrowLeft', { shiftKey: true });
  t.press('ArrowLeft', { shiftKey: true });
  assert.deepEqual(starts(t).map((note) => note[3]), [3, 3, 3], 'one step is the shortest');
  clickUndo(t);
  clickUndo(t);
  assert.deepEqual(starts(t).map((note) => note[3]), [3, 3, 3]);
});

test('Delete and Backspace erase the whole selection in one step; a held Delete erases once', () => {
  const t = withKeys();
  t.press('s');
  t.press(']');
  t.press('s');
  t.press('Delete');
  assert.deepEqual(starts(t).map((note) => note[0]), [3]);
  assert.equal(t.line().spoken, 'Erased 2 notes. Undo brings them back.');
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0', 'the erased notes leave the selection');
  clickUndo(t);
  assert.equal(t.notes().length, 3);
  const u = withThreeNotes();
  u.focus();
  u.press('a', { ctrlKey: true });
  u.press('Backspace');
  u.press('Delete', { repeat: true });
  assert.deepEqual(u.notes(), []);
  clickUndo(u);
  assert.equal(u.notes().length, 3, 'one step brings all three back');
});

test('Delete with no selection still erases the note under the cursor', () => {
  const t = withKeys();
  t.press('Delete');
  assert.equal(t.notes().length, 2);
  assert.equal(t.line().spoken, 'Erased C4 at cycle 1, beat 1. Undo brings it back.');
});

test('Shift, Ctrl or Cmd with a click on a note adds it to the selection or takes it out', () => {
  for (const modifier of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    const t = withThreeNotes();
    t.down(t.x(0), t.y(60));
    t.up(t.x(0), t.y(60));
    assert.equal(t.attr('scratch-view', 'data-selected'), '1');
    t.down(t.x(30), t.y(64), modifier);
    t.up(t.x(30), t.y(64), modifier);
    assert.equal(t.attr('scratch-view', 'data-selected'), '1,2', JSON.stringify(modifier));
    t.down(t.x(60), t.y(67), modifier);
    t.up(t.x(60), t.y(67), modifier);
    assert.equal(t.attr('scratch-view', 'data-selected'), '1,2,3');
    t.down(t.x(30), t.y(64), modifier);
    t.up(t.x(30), t.y(64), modifier);
    assert.equal(t.attr('scratch-view', 'data-selected'), '1,3', `${JSON.stringify(modifier)}: a selected note is taken out`);
    assert.equal(t.notes().length, 3);
  }
});

test('a modifier click on an empty cell keeps the selection, and a box with a modifier adds to it', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  t.down(t.x(45), t.y(62), { shiftKey: true });
  t.up(t.x(45), t.y(62), { shiftKey: true });
  assert.equal(t.attr('scratch-view', 'data-selected'), '1', 'the click only moved the cursor');
  assert.deepEqual(t.cursor(), { unit: 45, pitch: 62 });
  t.down(t.x(50), t.y(70), { ctrlKey: true });
  t.move(t.x(70), t.y(66), { ctrlKey: true });
  t.up(t.x(70), t.y(66), { ctrlKey: true });
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,3', 'the box added G4 to C4');
  t.down(t.x(20), t.y(70));
  t.move(t.x(35), t.y(61));
  t.up(t.x(35), t.y(61));
  assert.equal(t.attr('scratch-view', 'data-selected'), '2', 'a box with no modifier replaces the selection');
});

test('dragging a selected note moves the whole selection rigidly: every selected note is drawn at its target and the release commits one step', () => {
  const t = withThreeNotes();
  t.down(t.x(0), t.y(60));
  t.up(t.x(0), t.y(60));
  t.down(t.x(30), t.y(64), { shiftKey: true });
  t.up(t.x(30), t.y(64), { shiftKey: true });
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,2');
  const before = starts(t);
  t.down(t.x(30), t.y(64));
  t.move(t.x(36), t.y(66));
  const [first, second, third] = t.get('scratch-notes').children;
  assert.ok(first.className.split(' ').includes('sp-draft') && second.className.split(' ').includes('sp-draft'), 'the selected notes are drawn as a draft');
  assert.ok(!third.className.split(' ').includes('sp-draft'), 'the others stay');
  assert.deepEqual([first.style.props.get('--sp-start'), first.style.props.get('--sp-row')], ['6', '9'], 'C4 at its target: 6 units later, two rows higher');
  assert.deepEqual([second.style.props.get('--sp-start'), second.style.props.get('--sp-row')], ['36', '5']);
  assert.deepEqual(starts(t), before, 'the motif is as it was until the release');
  assert.equal(t.hidden('scratch-preview'), true, 'the draft is drawn by the notes themselves');
  t.up(t.x(36), t.y(66));
  assert.deepEqual(starts(t).map((note) => [note[0], note[1], note[2]]), [[1, 62, 6], [2, 66, 36], [3, 67, 60]]);
  assert.equal(t.line().spoken, 'Moved 2 notes 2 sixteenths later and up 2 semitones.');
  assert.ok(!t.get('scratch-notes').children.some((element) => element.className.includes('sp-draft')));
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,2');
  clickUndo(t);
  assert.deepEqual(starts(t), before, 'one Undo undoes the whole drag');
});

test('a group drag stops at the ends of the motif and at the shown rows, as one rigid group', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  t.down(t.x(0), t.y(60));
  t.move(t.x(-40), t.y(60));
  t.up(t.x(-40), t.y(60));
  assert.deepEqual(starts(t).map((note) => note[2]), [0, 30, 60], 'the first note is at 0 already');
  t.down(t.x(0), t.y(60));
  t.move(t.x(50), t.y(60));
  t.up(t.x(50), t.y(60));
  assert.deepEqual(starts(t).map((note) => note[2]), [33, 63, 93], 'the last note stops at the motif end (96 - 3)');
  t.down(t.x(33), t.y(60));
  t.move(t.x(33), t.y(80));
  t.up(t.x(33), t.y(80));
  assert.deepEqual(starts(t).map((note) => note[1]), [64, 68, 71], 'G4 reaches B4, the top row, and the whole group stops with it');
});

test('dragging the right edge of a selected note changes the length of every selected note by the same number of steps', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  // The notes are 3 units (30 pixels) wide; the right 12 pixels are the edge handle.
  t.down(t.x(0) + 27, t.y(60));
  t.move(t.x(0) + 27 + 30, t.y(60));
  const notes = t.get('scratch-notes').children;
  assert.deepEqual(notes.map((element) => element.style.props.get('--sp-len')), ['6', '6', '6'], 'the draft shows every note one step longer');
  t.up(t.x(0) + 27 + 30, t.y(60));
  assert.deepEqual(starts(t).map((note) => note[3]), [6, 6, 6]);
  assert.equal(t.line().spoken, 'Made 3 notes one sixteenth longer.');
  clickUndo(t);
  assert.deepEqual(starts(t).map((note) => note[3]), [3, 3, 3]);
});

test('a click on a selected note, with no drag, selects only that note', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  t.down(t.x(30), t.y(64));
  t.up(t.x(30), t.y(64));
  assert.equal(t.attr('scratch-view', 'data-selected'), '2');
});

test('a group drag that ends where it began commits nothing', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  const before = starts(t);
  t.down(t.x(30), t.y(64));
  t.move(t.x(34), t.y(64));
  t.move(t.x(30), t.y(64));
  t.up(t.x(30), t.y(64));
  assert.deepEqual(starts(t), before);
  clickUndo(t);
  assert.equal(t.notes().length, 2, 'no step was added by the drag');
});

test('a group drag cancelled by a lost pointer commits nothing and restores the selection', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  const before = starts(t);
  t.down(t.x(30), t.y(64));
  t.move(t.x(40), t.y(64));
  t.grid.dispatch('pointercancel', { pointerId: 1 });
  assert.deepEqual(starts(t), before);
  assert.ok(!t.get('scratch-notes').children.some((element) => element.className.includes('sp-draft')));
  assert.equal(t.attr('scratch-view', 'data-selected'), '1,2,3');
});

test('a contextmenu event inside the roll with Ctrl held erases nothing and is still the roll\'s; without Ctrl it erases the note', () => {
  const t = withThreeNotes();
  const inRoll = (extra) => t.view.handleContextMenu({ target: t.get('scratch-grid'), clientX: t.x(30), clientY: t.y(64), ...extra });
  assert.equal(inRoll({ ctrlKey: true }), true, 'the roll takes it, so the Ask box does not open');
  assert.equal(t.notes().length, 3);
  assert.equal(inRoll({ ctrlKey: false }), true);
  assert.equal(t.notes().length, 2);
});

test('on the focused lane Up and Down change the velocity of every selected note, and Left and Right select one note', () => {
  const t = laneSetup();
  withChord(t);
  t.press('a', { ctrlKey: true });
  t.lfocus();
  const velocities = () => t.notes().map((note) => note.velocity);
  const before = velocities();
  t.lkey('ArrowUp');
  assert.deepEqual(velocities(), before.map((velocity) => velocity + 5));
  assert.equal(t.line().spoken, 'Raised the velocity of 3 notes by 0.05.');
  t.lkey('ArrowDown', { shiftKey: true });
  assert.deepEqual(velocities(), before.map((velocity) => velocity + 4));
  t.get('scratch-undo').dispatch('click');
  t.get('scratch-undo').dispatch('click');
  assert.deepEqual(velocities(), before, 'each key is one step');
  t.lkey('ArrowRight');
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '1', 'Right selects the next note alone');
});

// --- Earlier, Later, Align and Clear ---

const enabled = (t, id) => t.get(id).getAttribute('aria-disabled') !== 'true';
const title = (t, id) => t.get(id).getAttribute('title');

test('the Edit group holds Earlier, Later, Align and Clear between Mode and Undo, with their words, names and no disabled attribute', () => {
  const t = setup();
  assert.deepEqual(t.get('scratch-edit').children.map((button) => button.id), ['scratch-earlier', 'scratch-later', 'scratch-align', 'scratch-clear']);
  assert.deepEqual(t.get('scratch-edit').children.map((button) => button.textContent), ['Earlier', 'Later', 'Align', 'Clear']);
  assert.deepEqual(
    t.get('scratch-edit').children.map((button) => button.getAttribute('aria-label')),
    [SCRATCH_COPY.earlierName, SCRATCH_COPY.laterName, SCRATCH_COPY.alignName, SCRATCH_COPY.clearName],
  );
  const groups = t.get('scratch-controls').children.map((group) => group.id);
  assert.deepEqual(groups.slice(3, 6), ['scratch-mode', 'scratch-edit', 'scratch-history']);
  for (const button of t.get('scratch-edit').children) assert.equal(button.hasAttribute('disabled'), false);
});

test('on an empty roll Earlier, Later, Align and Clear carry aria-disabled with their reason, and a press says the reason and changes nothing', () => {
  const t = setup();
  assert.deepEqual(['scratch-earlier', 'scratch-later', 'scratch-align', 'scratch-clear'].map((id) => enabled(t, id)), [false, false, false, false]);
  assert.equal(title(t, 'scratch-earlier'), 'Nothing to move: the roll has no notes.');
  assert.equal(title(t, 'scratch-align'), 'Nothing to align: the roll has no notes.');
  assert.equal(title(t, 'scratch-clear'), 'Nothing to clear: the roll has no notes.');
  for (const [id, sentence] of [['scratch-earlier', 'Nothing to move: the roll has no notes.'], ['scratch-later', 'Nothing to move: the roll has no notes.'], ['scratch-align', 'Nothing to align: the roll has no notes.'], ['scratch-clear', 'Nothing to clear: the roll has no notes.']]) {
    t.get(id).dispatch('click');
    assert.equal(t.line().spoken, sentence, id);
  }
  assert.equal(undoEnabled(t), false);
});

test('Earlier and Later move the whole motif one grid step when nothing is selected, each press one undo step', () => {
  const t = withThreeNotes();
  t.down(t.x(45), t.y(62));
  t.up(t.x(45), t.y(62));
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0');
  const before = starts(t);
  assert.equal(enabled(t, 'scratch-earlier'), false, 'the first note is at 0');
  assert.equal(title(t, 'scratch-earlier'), 'Not moved: the first note is already at the start of the motif.');
  assert.equal(enabled(t, 'scratch-later'), true);
  assert.equal(title(t, 'scratch-later'), SCRATCH_COPY.laterName);
  t.get('scratch-later').dispatch('click');
  assert.deepEqual(starts(t).map((note) => note[2]), [3, 33, 63]);
  assert.equal(t.line().spoken, 'Moved the motif one sixteenth later.');
  assert.equal(enabled(t, 'scratch-earlier'), true, 'now Earlier can move');
  t.get('scratch-later').dispatch('click');
  t.get('scratch-earlier').dispatch('click');
  assert.deepEqual(starts(t).map((note) => note[2]), [3, 33, 63]);
  assert.equal(t.line().spoken, 'Moved the motif one sixteenth earlier.');
  clickUndo(t);
  clickUndo(t);
  clickUndo(t);
  assert.deepEqual(starts(t), before, 'three presses, three steps');
});

test('Earlier and Later move only the selection when there is one, and refuse with the reason when it would leave the motif', () => {
  const t = withThreeNotes();
  t.down(t.x(60), t.y(67));
  t.up(t.x(60), t.y(67));
  assert.equal(t.attr('scratch-view', 'data-selected'), '3');
  t.get('scratch-later').dispatch('click');
  assert.deepEqual(starts(t).map((note) => note[2]), [0, 30, 63]);
  assert.equal(t.line().spoken, 'Moved G4 to cycle 2, beat 2.25.');
  const end = setup();
  end.dbl(end.x(93), end.y(60));
  assert.equal(enabled(end, 'scratch-later'), false);
  assert.equal(title(end, 'scratch-later'), 'Not moved: the last note already ends at the end of the motif.');
  end.get('scratch-later').dispatch('click');
  assert.equal(end.line().spoken, 'Not moved: the last note already ends at the end of the motif.');
  assert.equal(end.notes()[0].start, 93);
});

test('Align moves the whole motif whatever is selected, in one undo step, and the line says how far', () => {
  const t = setup();
  t.dbl(t.x(18), t.y(60));
  t.dbl(t.x(27), t.y(64));
  t.down(t.x(27), t.y(64));
  t.up(t.x(27), t.y(64));
  assert.equal(t.attr('scratch-view', 'data-selected'), '2');
  const before = starts(t);
  assert.equal(enabled(t, 'scratch-align'), true);
  assert.equal(title(t, 'scratch-align'), SCRATCH_COPY.alignTitle);
  t.get('scratch-align').dispatch('click');
  assert.deepEqual(starts(t).map((note) => note[2]), [12, 21], 'both notes moved, not only the selected one');
  assert.equal(t.line().spoken, 'Aligned: the motif moved 2 sixteenths earlier, so its first note is on cycle 1, beat 2.');
  assert.equal(t.attr('scratch-view', 'data-selected'), '2', 'the selection stays with its note');
  clickUndo(t);
  assert.deepEqual(starts(t), before);
  assert.equal(t.line().spoken, 'Undid: aligned the motif.');
});

test('the key l aligns, a motif already on a beat says so and adds no step, and an align that would pass the end is refused', () => {
  const t = setup();
  t.focus();
  t.dbl(t.x(18), t.y(60));
  const event = t.press('l');
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.notes()[0].start, 12);
  t.press('l');
  assert.equal(t.line().spoken, 'Already aligned: the first note is on a beat.');
  clickUndo(t);
  assert.equal(t.notes()[0].start, 18, 'the second l added no step: one Undo undid the align');
  const crowded = setup();
  crowded.get('scratch-grid-eighth-triplet').dispatch('click');
  crowded.dbl(crowded.x(8), crowded.y(60));
  crowded.dbl(crowded.x(92), crowded.y(62));
  crowded.get('scratch-align').dispatch('click');
  assert.equal(crowded.line().spoken, 'Not aligned: the last note would pass the end of the motif. Make the motif longer, or move the last note earlier first.');
  assert.deepEqual(crowded.notes().map((note) => note.start), [8, 92]);
});

test('Align on an empty roll is refused by the key too, with the sentence', () => {
  const t = setup();
  t.focus();
  t.press('l');
  assert.equal(t.line().spoken, 'Nothing to align: the roll has no notes.');
});

test('Clear empties the roll in one undo step with no question asked, and the line says how Undo brings the notes back', () => {
  const t = withThreeNotes();
  t.focus();
  t.press('a', { ctrlKey: true });
  t.press('Home');
  const cursorBefore = t.cursor();
  assert.equal(enabled(t, 'scratch-clear'), true);
  t.get('scratch-clear').dispatch('click');
  assert.deepEqual(t.notes(), []);
  assert.equal(t.line().spoken, 'Cleared 3 notes. Undo brings them back.');
  assert.equal(t.attr('scratch-view', 'data-selected-count'), '0', 'the selection is empty after Clear');
  assert.deepEqual(t.cursor(), cursorBefore, 'the cursor stays where it was');
  assert.equal(enabled(t, 'scratch-clear'), false, 'an empty roll disables Clear');
  assert.equal(enabled(t, 'scratch-align'), false);
  clickUndo(t);
  assert.equal(t.notes().length, 3, 'one Undo brings every note back');
  assert.equal(t.line().spoken, 'Undid: cleared the roll.');
});

test('Clear of one note says it in the singular, and Clear has no key', () => {
  const t = setup();
  t.dbl(t.x(12), t.y(60));
  t.focus();
  for (const key of ['c', 'x', 'Escape']) t.press(key);
  assert.equal(t.notes().length, 1, 'no key clears the roll');
  t.get('scratch-clear').dispatch('click');
  assert.equal(t.line().spoken, 'Cleared 1 note. Undo brings it back.');
});

test('Clear, Align and the moves change neither the playing code nor anything the view sends', () => {
  const sends = [];
  const t = setup({ onSend: (request) => { sends.push(request); return { id: 'x' }; } });
  t.dbl(t.x(18), t.y(60));
  t.get('scratch-align').dispatch('click');
  t.get('scratch-later').dispatch('click');
  t.get('scratch-earlier').dispatch('click');
  t.get('scratch-clear').dispatch('click');
  assert.deepEqual(sends, []);
});

test('Align of a motif made by Record that keeps the cycle its request carries and changes only the phrase', () => {
  const sends = [];
  const t = setup({ musicCycle: () => 40, onSend: (request) => { sends.push(request); return { id: `r${sends.length}` }; } });
  t.view.record({ start: 8, cycles: 8, notes: [{ pitch: 60, velocity: 100, start: 2.3, end: 2.4, run: 0 }, { pitch: 64, velocity: 100, start: 2.55, end: 2.65, run: 0 }] });
  t.get('scratch-send-button').dispatch('click');
  t.get('scratch-align').dispatch('click');
  assert.ok(t.line().spoken.startsWith('Aligned: the motif moved'), t.line().spoken);
  t.view.setSendState({ connected: true, pending: false });
  t.get('scratch-send-button').dispatch('click');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].motif.cycle, sends[0].motif.cycle, 'the moment sent stays right');
  assert.equal(sends[1].motif.source, 'played');
  assert.notEqual(sends[1].motif.phrase, sends[0].motif.phrase);
});

test('the Edit buttons write only what changed when drawn again', () => {
  const t = withThreeNotes();
  t.view.render();
  const writes = t.document.writes;
  t.view.render();
  t.view.render();
  assert.equal(t.document.writes, writes);
});

// The live view: the keyboard buffer drawn in the roll as a ring of 8 cycles, under a playhead. The page's frame loop hands the view
// `{ now, snapshot, frameMs }`; the view reads no clock. Real Chrome proves the look in `npm run probe:midi -- --only input`.

const liveNote = (pitch, velocity, start, end, held = false, run = 0) => ({ pitch, velocity, start, end, run, held });
const liveSnapshot = (notes, start = 3) => ({ start, cycles: 8, notes });
// Window start 3, so a note at 7.25 is at axis cycle 10.25, column 2. C4 is released, E4 is still held.
const TWO_NOTES = () => liveSnapshot([liveNote(60, 127, 7.25, 7.5), liveNote(64, 100, 7.4, 7.5, true)]);

/** Counts the custom-property writes of every node below `root` from now on, by node. */
function watchStyleWrites(root) {
  const counts = new Map();
  const walk = (node) => {
    const original = node.style.setProperty;
    node.style.setProperty = (name, value) => {
      counts.set(node, [...(counts.get(node) ?? []), name]);
      original(name, value);
    };
    node.children.forEach(walk);
  };
  walk(root);
  return counts;
}

const liveEls = (t) => t.get('scratch-live').children;

test('with no live data the view is Off: no live element, no playhead, its own cycles', () => {
  const t = setup();
  assert.equal(t.attr('scratch-view', 'data-live'), 'off');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '2');
  assert.equal(t.attr('scratch-view', 'data-live-notes'), '0');
  assert.equal(liveEls(t).length, 0);
  assert.ok(t.hidden('scratch-playhead'));
  assert.equal(t.get('scratch-live').getAttribute('aria-hidden'), 'true');
  assert.equal(t.get('scratch-playhead').getAttribute('aria-hidden'), 'true');
});

test('setLive with a snapshot that holds notes shows 8 cycles, one .sp-live element per piece and the playhead at the axis cycle modulo 8', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'live');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '8');
  assert.equal(t.attr('scratch-view', 'data-live-notes'), '2');
  assert.equal(t.prop('scratch-roll', '--sp-cycles'), '8');
  assert.equal(t.prop('scratch-roll', '--sp-units'), '384');
  assert.equal(t.prop('scratch-bars', '--sp-units'), '384');
  assert.equal(t.get('scratch-ruler').children.length, 32);
  assert.equal(t.get('scratch-ruler').children.at(-1).textContent, '8.4');
  assert.equal(liveEls(t).length, 2);
  const [released, held] = liveEls(t);
  assert.deepEqual(['pitch', 'start', 'length', 'velocity', 'held'].map((name) => released.dataset[name]), ['60', '108', '12', '100', 'false']);
  assert.equal(held.dataset.held, 'true');
  assert.equal(held.dataset.pitch, '64');
  assert.equal(released.style.props.get('--sp-start'), '108');
  assert.equal(released.style.props.get('--sp-len'), '12');
  assert.equal(released.style.props.get('--v'), '1');
  assert.equal(released.style.props.get('--sp-row'), String(71 - 60));
  assert.equal(t.hidden('scratch-playhead'), false);
  // The axis 10.5 is column 2.5 of the ring: 2.5 times 48 units.
  assert.equal(t.prop('scratch-playhead', '--sp-playhead'), '120');
  assert.equal(t.attr('scratch-view', 'data-ring-cycle'), '2');
  t.view.setLive({ now: 15.25, snapshot: TWO_NOTES(), frameMs: 1100 });
  assert.equal(t.prop('scratch-playhead', '--sp-playhead'), String(7.25 * 48), 'it wraps: 15.25 is column 7.25');
  t.view.setLive({ now: 16.5, snapshot: TWO_NOTES(), frameMs: 1200 });
  assert.equal(t.prop('scratch-playhead', '--sp-playhead'), '24', 'and starts again at the left end');
});

test('a held piece grows to the playhead by whole steps while a released one stays', () => {
  const t = setup();
  const snapshot = TWO_NOTES();
  t.view.setLive({ now: 10.5, snapshot, frameMs: 1000 });
  const [released, held] = liveEls(t);
  // The held note starts at axis cycle 10.4 (unit 499.2, snapped to 498, column 114) and ends at the playhead (unit 504, column 120).
  assert.equal(held.dataset.length, '6');
  const before = Number(held.dataset.length);
  t.view.setLive({ now: 10.9, snapshot, frameMs: 1100 });
  assert.ok(Number(held.dataset.length) > before, `${held.dataset.length} > ${before}`);
  assert.equal(Number(held.dataset.length) % 3, 0, 'a whole number of sixteenth steps');
  assert.equal(released.dataset.length, '12');
  assert.equal(liveEls(t)[0], released, 'the elements are the same ones');
});

test('a second setLive with the same snapshot and a later now writes only the playhead and the held piece', () => {
  const t = setup();
  const snapshot = TWO_NOTES();
  t.view.setLive({ now: 10.5, snapshot, frameMs: 1000 });
  const attributeWrites = t.document.writes;
  const styleWrites = watchStyleWrites(t.get('scratch-view'));
  t.view.setLive({ now: 10.8, snapshot, frameMs: 1016 });
  t.view.setLive({ now: 10.9, snapshot, frameMs: 1032 });
  const [released, held] = liveEls(t);
  const written = [...styleWrites.keys()];
  assert.equal(written.length, 2, 'two elements were written');
  assert.ok(written.includes(t.get('scratch-playhead')));
  assert.ok(written.includes(held));
  assert.ok(!written.includes(released));
  assert.deepEqual([...new Set(styleWrites.get(held))], ['--sp-len']);
  assert.equal(t.document.writes, attributeWrites + 2, 'only the held piece\'s length read-out changed, once in each of the two frames');
});

test('a snapshot with no notes is Armed: the motif\'s own cycles, no live element and no playhead', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([]), frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '2');
  assert.equal(t.prop('scratch-roll', '--sp-units'), '96');
  assert.equal(liveEls(t).length, 0);
  assert.ok(t.hidden('scratch-playhead'));
  t.view.setLive({ now: 10.6, snapshot: null, frameMs: 1016 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed', 'a clock that gives no snapshot is still Armed');
});

test('the roll goes back to the motif\'s own cycles when the buffer is empty again, and Off clears the layer', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '8');
  t.view.setLive({ now: 12.5, snapshot: liveSnapshot([]), frameMs: 1100 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '2');
  assert.equal(t.prop('scratch-roll', '--sp-cycles'), '2');
  assert.equal(t.get('scratch-ruler').children.length, 8);
  assert.equal(liveEls(t).length, 0);
  t.view.setLive({ now: 12.6, snapshot: TWO_NOTES(), frameMs: 1200 });
  t.view.setLive(null);
  assert.equal(t.attr('scratch-view', 'data-live'), 'off');
  assert.equal(liveEls(t).length, 0);
  assert.ok(t.hidden('scratch-playhead'));
  assert.equal(t.attr('scratch-view', 'data-ring-cycle'), '');
});

test('a motif that exists stays drawn, and the live notes are drawn over it without taking the pointer', () => {
  const t = setup();
  t.dbl(t.x(18), t.y(67));
  assert.equal(t.notes().length, 1);
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.notes().length, 1, 'the motif note is still there');
  assert.equal(t.get('scratch-notes').children.length, 1);
  assert.equal(liveEls(t).length, 2);
  const order = t.get('scratch-grid').children.map((node) => node.id);
  assert.ok(order.indexOf('scratch-live') > order.indexOf('scratch-notes'), 'the live layer is drawn above the motif');
  assert.equal(t.prop('scratch-notes', '--sp-units'), undefined);
  assert.equal(t.get('scratch-roll').style.props.get('--sp-units'), '384', 'the motif note is placed against the 8 cycles shown');
});

test('the live layer is rebuilt when the snapshot is another object and not when only the time moved', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  const layer = t.get('scratch-live');
  const replaced = layer.replaced;
  t.view.setLive({ now: 10.6, snapshot: TWO_NOTES(), frameMs: 1016 });
  assert.equal(liveEls(t).length, 2);
  const again = layer.replaced;
  t.view.setLive({ now: 10.7, snapshot: liveSnapshot([liveNote(60, 127, 7.25, 7.5), liveNote(64, 100, 7.4, 7.5), liveNote(67, 100, 7.4, 7.5)]), frameMs: 1032 });
  assert.equal(liveEls(t).length, 3);
  assert.ok(again >= replaced);
});

test('a note held across the ring\'s right end is drawn as two pieces, the last one held', () => {
  const t = setup();
  // Played at axis cycle 13.75 (unit 660, column 276) and held to the playhead at 16.25: it runs 120 units, 108 to the right end and 12 more from 0.
  t.view.setLive({ now: 16.25, snapshot: liveSnapshot([liveNote(64, 100, 4.75, 5.25, true)], 9), frameMs: 1000 });
  assert.equal(liveEls(t).length, 2);
  const [first, second] = liveEls(t);
  assert.deepEqual([first.dataset.start, first.dataset.length, first.dataset.held], ['276', '108', 'false']);
  assert.deepEqual([second.dataset.start, second.dataset.length, second.dataset.held], ['0', '12', 'true']);
  assert.equal(t.attr('scratch-view', 'data-live-notes'), '2');
});

test('entering and leaving Live sets the sideways scroll back to the start and sizes the beat from the live minimum', () => {
  const t = setup();
  const scroll = t.get('scratch-scroll');
  scroll.clientWidth = 800;
  scroll.clientHeight = 600;
  t.view.resize();
  assert.equal(t.prop('scratch-scroll', '--sp-beat-w'), '5.6875rem', 'eight beats of the motif share the room');
  scroll.scrollLeft = 90;
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(scroll.scrollLeft, 0);
  assert.equal(t.prop('scratch-scroll', '--sp-beat-w'), '2.5rem', 'at 32 beats the room is less than the live minimum');
  scroll.scrollLeft = 40;
  t.view.setLive({ now: 12.5, snapshot: liveSnapshot([]), frameMs: 1100 });
  assert.equal(scroll.scrollLeft, 0);
  assert.equal(t.prop('scratch-scroll', '--sp-beat-w'), '5.6875rem');
});

test('setLive refuses a value it cannot use with a clear error', () => {
  const t = setup();
  assert.throws(() => t.view.setLive({ now: Number.NaN, snapshot: null, frameMs: 1 }), /^TypeError: Moontide: /);
  assert.throws(() => t.view.setLive({ now: 1, snapshot: null, frameMs: 'x' }), /^TypeError: Moontide: /);
  assert.throws(() => t.view.setLive({ now: 1, snapshot: { notes: 3 }, frameMs: 1 }), /^TypeError: Moontide: /);
  assert.throws(() => t.view.setLive(7), /^TypeError: Moontide: /);
  assert.throws(() => t.view.setLive(undefined), /^TypeError: Moontide: /);
});

test('the live layer takes no pointer and no focus: the view\'s keys and the motif are as they were', () => {
  const t = setup();
  t.focus();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.document.activeElement, t.roll, 'focus never moves when live starts');
  t.view.setLive({ now: 12.5, snapshot: liveSnapshot([]), frameMs: 1100 });
  assert.equal(t.document.activeElement, t.roll, 'nor when it ends');
  assert.equal(t.get('scratch-live').listenersFor('pointerdown').length, 0);
});

test('record(snapshot) answers true only when it replaced the motif, so the page empties the buffer only then', () => {
  const t = setup();
  assert.equal(t.view.record(null), false, 'a clock that gave no snapshot');
  assert.equal(t.view.record(undefined), false);
  assert.equal(t.view.record({ start: 0, cycles: 8, notes: [] }), false, 'an empty buffer');
  assert.equal(t.view.record({ start: 0, cycles: 8, notes: [{ pitch: 5, velocity: 100, start: 0, end: 0.25, run: null }] }), false, 'only pitches the roll cannot show');
  assert.equal(t.notes().length, 0, 'a refusal changes nothing');
  assert.equal(t.view.record(liveSnapshot([liveNote(60, 100, 7.25, 7.5)])), true);
  assert.equal(t.notes().length, 1);
});

test('Record that takes exactly the notes, pitches, velocities and places the live layer showed', () => {
  const t = setup();
  const snapshot = liveSnapshot([liveNote(60, 127, 7.25, 7.5), liveNote(64, 64, 7.5, 7.75), liveNote(67, 100, 6.5, 7.9, true)], 3);
  t.view.setLive({ now: 10.9, snapshot, frameMs: 1000 });
  const shownLive = liveEls(t).map((el) => [Number(el.dataset.pitch), Number(el.dataset.velocity), Number(el.dataset.start), Number(el.dataset.length)]);
  assert.equal(t.view.record({ ...snapshot, notes: snapshot.notes.map((note) => ({ ...note, end: note.held ? 10.9 - 3 : note.end, held: false })) }), true);
  const first = Math.floor(Math.min(...shownLive.map((piece) => piece[2])) / 48) * 48;
  assert.deepEqual(
    t.notes().map((note) => [note.pitch, note.velocity, note.start, note.length]).sort((a, b) => a[0] - b[0]),
    shownLive.map(([pitch, velocity, start, length]) => [pitch, velocity, start - first, length]).sort((a, b) => a[0] - b[0]),
  );
});

test('once the buffer is empty again after Record that, the live view hands over to the new motif\'s own cycles, and one Undo brings back the earlier motif', () => {
  const t = setup();
  t.dbl(t.x(18), t.y(70));
  const earlier = t.notes();
  const snapshot = liveSnapshot([liveNote(60, 100, 6.25, 6.5), liveNote(64, 100, 7.5, 7.75)]);
  t.view.setLive({ now: 10.9, snapshot, frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '8');
  assert.equal(t.view.record(snapshot), true);
  // The page now calls midiIn.clearBuffer(); the next frame hands an empty snapshot.
  t.view.setLive({ now: 11, snapshot: liveSnapshot([]), frameMs: 1016 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), String(t.attr('scratch-view', 'data-cycles')), 'the recorded motif\'s own cycles');
  assert.equal(liveEls(t).length, 0);
  assert.equal(t.notes().length, 2);
  t.get('scratch-view').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.deepEqual(t.notes().map((note) => note.pitch), earlier.map((note) => note.pitch), 'the earlier motif is back; the buffer is not');
});

// The Armed marker, held keys, the range that grows, the page-turn follow and presses that are safe while the roll changes.

const keyCell = (t, pitch) => t.get('scratch-gutter').children.find((cell, row) => Number(t.attr('scratch-view', 'data-row-high')) - row === pitch);

test('Armed with Tap off shows the marker at the axis cycle modulo the motif\'s cycles, Live hides it for the playhead, Off hides both', () => {
  const t = setup();
  assert.ok(t.hidden('scratch-now'));
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([]), frameMs: 1000 });
  assert.equal(t.hidden('scratch-now'), false, 'shown all the time while an input is listened to');
  assert.equal(t.prop('scratch-now', '--sp-now'), '24', '10.5 modulo the motif\'s 2 cycles is 0.5 of a cycle');
  assert.equal(t.attr('scratch-view', 'data-now-unit'), '24');
  t.view.setLive({ now: 11.25, snapshot: null, frameMs: 1016 });
  assert.equal(t.prop('scratch-now', '--sp-now'), '60', 'it moves with the axis');
  t.view.setLive({ now: 11.5, snapshot: TWO_NOTES(), frameMs: 1032 });
  assert.ok(t.hidden('scratch-now'), 'Live hides the marker');
  assert.equal(t.hidden('scratch-playhead'), false);
  assert.equal(t.attr('scratch-view', 'data-now-unit'), '');
  t.view.setLive(null);
  assert.ok(t.hidden('scratch-now'));
  assert.ok(t.hidden('scratch-playhead'));
});

test('the Armed marker wraps at the motif\'s cycle count, which a longer motif changes', () => {
  const t = setup();
  t.get('scratch-more').dispatch('click');
  t.view.setLive({ now: 11.5, snapshot: liveSnapshot([]), frameMs: 1000 });
  assert.equal(t.prop('scratch-now', '--sp-now'), String(2.5 * 48), '11.5 modulo 3 cycles');
});

test('while Tap is on the marker keeps Tap\'s own place, whatever the axis says', () => {
  const t = setup();
  t.view.setMusicPlaying(true);
  t.get('scratch-tap').dispatch('click');
  assert.equal(t.view.tapOn(), true);
  t.view.setNowUnit(10);
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([]), frameMs: 1000 });
  assert.equal(t.hidden('scratch-now'), false);
  assert.equal(t.prop('scratch-now', '--sp-now'), '10');
  t.view.setLive({ now: 10.75, snapshot: null, frameMs: 1016 });
  assert.equal(t.prop('scratch-now', '--sp-now'), '10');
  t.view.setNowUnit(null);
  assert.ok(t.hidden('scratch-now'), 'Tap with no place hides it, as before');
});

test('a held pitch marks its key at once with its name, and a released one does not', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  const held = keyCell(t, 64);
  const released = keyCell(t, 60);
  assert.equal(held.getAttribute('data-held'), 'true');
  assert.equal(held.textContent, 'E4');
  assert.equal(released.getAttribute('data-held'), 'false');
  assert.equal(released.textContent, 'C4', 'C4 is named anyway: it is a C row');
  assert.equal(keyCell(t, 62).getAttribute('data-held'), 'false');
  assert.equal(keyCell(t, 62).textContent, '');
  // The key is let go: the next snapshot says so and the mark goes.
  t.view.setLive({ now: 10.7, snapshot: liveSnapshot([liveNote(60, 127, 7.25, 7.5), liveNote(64, 100, 7.4, 7.7)]), frameMs: 1100 });
  assert.equal(keyCell(t, 64).getAttribute('data-held'), 'false');
  assert.equal(keyCell(t, 64).textContent, '');
});

test('a held pitch outside the shown rows adds rows at once, and a played one too', () => {
  const t = setup();
  assert.equal(t.attr('scratch-view', 'data-rows'), '24');
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([liveNote(100, 100, 7.25, 7.5, true)]), frameMs: 1000 });
  assert.ok(Number(t.attr('scratch-view', 'data-rows')) > 24);
  assert.ok(Number(t.attr('scratch-view', 'data-row-high')) >= 102, 'the margin of two semitones is kept');
  assert.equal(keyCell(t, 100).getAttribute('data-held'), 'true');
  assert.equal(t.get('scratch-gutter').children.length, Number(t.attr('scratch-view', 'data-rows')));
  assert.equal(liveEls(t)[0].style.props.get('--sp-row'), String(Number(t.attr('scratch-view', 'data-row-high')) - 100));
});

test('while live the range only grows, and it settles to the motif\'s when live ends', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([liveNote(100, 100, 7.25, 7.5)]), frameMs: 1000 });
  const wide = Number(t.attr('scratch-view', 'data-rows'));
  assert.ok(wide > 24);
  // The pitch is no longer in the buffer, but another note is: the rows stay.
  t.view.setLive({ now: 10.6, snapshot: liveSnapshot([liveNote(60, 100, 7.3, 7.5)]), frameMs: 1100 });
  assert.equal(Number(t.attr('scratch-view', 'data-rows')), wide, 'a pitch played then released keeps its rows');
  t.view.setLive({ now: 10.7, snapshot: liveSnapshot([liveNote(30, 100, 7.4, 7.6)]), frameMs: 1200 });
  assert.ok(Number(t.attr('scratch-view', 'data-rows')) > wide, 'and it grows for a new low pitch');
  t.view.setLive({ now: 20, snapshot: liveSnapshot([]), frameMs: 1300 });
  assert.equal(t.attr('scratch-view', 'data-rows'), '24', 'it settles to the motif\'s range when live ends');
  assert.equal(t.get('scratch-gutter').children.length, 24);
});

// A box that shows 1000 pixels of a roll 3200 pixels wide: the grid starts 100 pixels from the left, where the piano names end.
function followSetup() {
  const t = setup();
  const scroll = t.get('scratch-scroll');
  scroll.rect = { left: 0, top: 0, right: 1100, bottom: 600, width: 1100, height: 600 };
  t.get('scratch-gutter').rect = { left: 0, top: 0, right: 100, bottom: 600, width: 100, height: 600 };
  const place = (scrolled) => {
    t.grid.rect = { ...GRID_RECT, left: 100 - scrolled, right: 100 - scrolled + 3200, width: 3200 };
  };
  place(0);
  return { t, scroll, place };
}
// The playhead at the axis cycle 8k + c stands at unit 48c; the grid is 3200 pixels for 384 units, so a unit is 8.33 pixels.
const followFrame = (t, cycle, frameMs, snapshot) => t.view.setLive({ now: 8 + cycle, snapshot, frameMs });

test('past 90 percent of the visible width the box turns so the playhead is one beat from the left edge, instantly, and a wrap returns it to the start', () => {
  const { t, scroll, place } = followSetup();
  const snapshot = liveSnapshot([liveNote(60, 100, 7.25, 7.5)], 0);
  followFrame(t, 1, 1000, snapshot);
  assert.equal(scroll.scrollLeft, 0, 'at cycle 1 of 8 the playhead is at x 500, inside the box');
  followFrame(t, 2.2, 1016, snapshot);
  assert.equal(scroll.scrollLeft, 0, 'at x 980 it is still inside 90 percent of the 1000 visible pixels');
  followFrame(t, 2.3, 1032, snapshot);
  // Unit 110.4 of 384 is pixel 100 + 920 = 1020, past 100 + 0.9 * 1000 = 1000: one beat (100 px) right of the names at 100 gives 100 + 100.
  assert.ok(Math.abs(scroll.scrollLeft - 820) < 0.01, String(scroll.scrollLeft));
  scroll.scrollLeft = 900;
  place(900);
  followFrame(t, 3.5, 1048, snapshot);
  assert.equal(scroll.scrollLeft, 900, 'now at x 300 it is inside, so nothing turns');
  followFrame(t, 0.25, 1064, snapshot);
  assert.equal(scroll.scrollLeft, 0, 'the playhead wrapped to the left end: the box goes back to the start');
});

test('following pauses for 5000 ms after a wheel, a press in the box or a scroll the view did not make, then resumes', () => {
  for (const [name, hand] of [
    ['a wheel', (t) => t.get('scratch-scroll').dispatch('wheel', {})],
    ['a press in the box', (t) => t.get('scratch-scroll').dispatch('pointerdown', { pointerId: 9, clientX: 500, clientY: 100 })],
    ['a scroll by hand', (t, scroll) => {
      scroll.scrollLeft = 300;
      t.get('scratch-scroll').dispatch('scroll', {});
    }],
  ]) {
    const { t, scroll, place } = followSetup();
    const snapshot = liveSnapshot([liveNote(60, 100, 7.25, 7.5)], 0);
    followFrame(t, 1, 1000, snapshot);
    hand(t, scroll);
    const held = scroll.scrollLeft;
    place(held);
    followFrame(t, 7, 1100, snapshot);
    assert.equal(scroll.scrollLeft, held, `${name}: the playhead is past the edge but the box stays`);
    followFrame(t, 7, 5999, snapshot);
    assert.equal(scroll.scrollLeft, held, `${name}: still paused at 4999 ms after`);
    followFrame(t, 7, 6000, snapshot);
    assert.notEqual(scroll.scrollLeft, held, `${name}: 5000 ms after the hand it follows again`);
  }
});

test('a scroll the view made itself is not taken for a hand: it does not pause following', () => {
  const { t, scroll, place } = followSetup();
  const snapshot = liveSnapshot([liveNote(60, 100, 7.25, 7.5)], 0);
  followFrame(t, 1, 984, snapshot);
  followFrame(t, 2.5, 1000, snapshot);
  assert.equal(scroll.scrollLeft, 900);
  t.get('scratch-scroll').dispatch('scroll', {});
  place(900);
  followFrame(t, 7, 1016, snapshot);
  assert.notEqual(scroll.scrollLeft, 900, 'it kept following in the next frame');
});

test('while following, the cursor does not scroll the box; once paused it does', () => {
  const { t, scroll, place } = followSetup();
  const snapshot = liveSnapshot([liveNote(60, 100, 7.25, 7.5)], 0);
  followFrame(t, 1, 1000, snapshot);
  // The box is scrolled 500 pixels, so the cursor's cell at the motif's start is 400 pixels left of the piano names.
  scroll.scrollLeft = 500;
  place(500);
  t.focus();
  t.press('Home');
  assert.equal(scroll.scrollLeft, 500, 'following: the cursor does not move the box');
  scroll.dispatch('wheel', {});
  followFrame(t, 1.1, 1100, snapshot);
  t.press('Home');
  assert.equal(scroll.scrollLeft, 0, 'paused: the cursor brings its cell into view as it always did');
});

test('a pointer press in progress puts off the switch into Live until the release, then it switches', () => {
  const t = setup();
  t.down(t.x(18), t.y(60));
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'off', 'the roll keeps its geometry while the pointer is down');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '2');
  t.up(t.x(18), t.y(60));
  assert.equal(t.attr('scratch-view', 'data-live'), 'live');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '8');
  assert.equal(liveEls(t).length, 2);
});

test('a press in progress puts off the switch out of Live too, and a cancelled press applies it', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  // A press on a cell inside the motif (unit 6 of the 8 cycles shown, which are 2.5 pixels a unit here).
  t.down(GRID_RECT.left + 6 * 2.5 + 1, t.y(60));
  t.view.setLive({ now: 12.5, snapshot: liveSnapshot([]), frameMs: 1100 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'live', 'still the 8 cycles under the pointer');
  t.view.cancelGesture();
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '2');
});

test('the latest thing the page handed over is what is applied at the release', () => {
  const t = setup();
  t.down(t.x(18), t.y(60));
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([]), frameMs: 1000 });
  t.view.setLive({ now: 10.6, snapshot: TWO_NOTES(), frameMs: 1016 });
  t.view.setLive({ now: 10.7, snapshot: liveSnapshot([]), frameMs: 1032 });
  t.up(t.x(18), t.y(60));
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed', 'the last frame said Armed');
});

// While live the grid shows 8 cycles: a unit is 2.5 pixels in these tests, and the motif ends at unit 96.
const xLive = (unit) => GRID_RECT.left + unit * 2.5 + 1;

test('while live, a double-click, a press and a hover on a cell past the motif\'s end do nothing', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  t.dbl(xLive(200), t.y(60));
  assert.equal(t.notes().length, 0, 'no note past the motif\'s end');
  t.move(xLive(200), t.y(60));
  assert.ok(t.hidden('scratch-hover-cell'));
  t.down(xLive(200), t.y(60));
  assert.equal(t.grid.capturedPointer, null, 'no press starts there');
  t.up(xLive(200), t.y(60));
  t.dbl(xLive(12), t.y(60));
  assert.deepEqual(t.notes().map((note) => [note.pitch, note.start]), [[60, 12]], 'inside the motif a double-click still writes');
});

test('while live, a selection rectangle dragged into the cells past the motif\'s end stops at the motif\'s end', () => {
  const t = setup();
  t.dbl(xLive(0), t.y(60));
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  t.down(xLive(60), t.y(58));
  t.move(xLive(60) + 40, t.y(58));
  t.move(xLive(300), t.y(62));
  const rect = t.get('scratch-select-rect');
  assert.equal(rect.hidden, false);
  assert.equal(Number(rect.style.props.get('--sp-start')) + Number(rect.style.props.get('--sp-len')), 96, 'it ends where the motif ends');
  t.up(xLive(300), t.y(62));
  assert.equal(t.notes().length, 1);
});

test('a draw in Draw mode stops at the motif\'s end while live', () => {
  const t = setup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  t.drawOn();
  t.down(xLive(90), t.y(58));
  t.move(xLive(90) + 40, t.y(58));
  t.move(xLive(300), t.y(58));
  t.up(xLive(300), t.y(58));
  const [note] = t.notes();
  assert.equal(note.start + note.length, 96);
});

test('the velocity lane lines up with the 8 cycles shown while live', () => {
  const t = setup();
  t.dbl(t.x(18), t.y(60));
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.prop('scratch-bars', '--sp-units'), '384');
  assert.equal(t.prop('scratch-bars', '--sp-cycles'), '8');
  t.view.setLive({ now: 12.5, snapshot: liveSnapshot([]), frameMs: 1100 });
  assert.equal(t.prop('scratch-bars', '--sp-units'), '96');
});

// While live the roll shows 384 units over the same 960 pixels (2.5 a unit). A pitch played above the shown range grows it by an octave at the
// top during a drag; the test lays the grid out again the way the browser does (36 rows of 10 pixels, top row B5, 83).
const liveX = (unit) => GRID_RECT.left + unit * 2.5 + 1;
const grownY = (pitch) => GRID_RECT.top + (83 - pitch) * 10 + 5;
function growDuringDrag(t) {
  t.view.setLive({ now: 10.6, snapshot: liveSnapshot([liveNote(60, 100, 7.25, 7.5), liveNote(80, 100, 7.5, 7.6)]), frameMs: 1100 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'live');
  t.grid.rect = { ...GRID_RECT, height: 360, bottom: GRID_RECT.top + 360 };
}

test('a note dragged in Live while the range grows at the top lands under the pointer, not an octave away', () => {
  const t = setup();
  t.dbl(t.x(0), t.y(60));
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([liveNote(60, 100, 7.25, 7.5)]), frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'live');
  t.down(GRID_RECT.left + 0.5, t.y(60));
  t.move(GRID_RECT.left + 0.5, t.y(62));
  growDuringDrag(t);
  t.move(GRID_RECT.left + 0.5, grownY(62));
  t.up(GRID_RECT.left + 0.5, grownY(62));
  assert.deepEqual(t.notes().map((note) => [note.pitch, note.start]), [[62, 0]]);
});

test('a Select box started in Live keeps its start pitch when the range grows at the top during the drag', () => {
  const t = setup();
  t.dbl(t.x(9), t.y(62));
  t.dbl(t.x(9), t.y(66));
  t.view.setLive({ now: 10.5, snapshot: liveSnapshot([liveNote(60, 100, 7.25, 7.5)]), frameMs: 1000 });
  // From an empty cell at unit 6, pitch 63, to unit 15, pitch 61: the box holds the note at 62 and not the one at 66.
  t.down(liveX(6), t.y(63));
  t.move(liveX(15), t.y(61));
  assert.deepEqual(t.notes().filter((note) => note.selected).map((note) => note.pitch), [62]);
  growDuringDrag(t);
  t.move(liveX(15), grownY(61));
  assert.deepEqual(t.notes().filter((note) => note.selected).map((note) => note.pitch), [62]);
  t.up(liveX(15), grownY(61));
  assert.deepEqual(t.notes().filter((note) => note.selected).map((note) => note.pitch), [62]);
});

// --- The hear strip: the menu, the Start choice, Loop, Listen and Stop ---

const RIG = {
  setup: 'valid',
  instruments: [
    { id: 'mt32', port: 'Port A', enabled: true, channels: [{ channel: 2, role: 'melodic' }, { channel: 10, role: 'rhythm' }] },
    { id: 'jx', port: 'Port B', enabled: true, channels: [{ channel: 1, role: 'melodic' }] },
  ],
};

/** The view with the hear callbacks recorded and the menu filled from RIG; `choose` picks an option the way a person does. */
function hearSetup(extra = {}, { rig = RIG, withNote = true } = {}) {
  const calls = [];
  const rest = setup({ onListen: (request) => calls.push(['listen', request]), onStop: () => calls.push(['stop']), onLoop: (on) => calls.push(['loop', on]), ...extra });
  if (withNote) rest.dbl(rest.x(0), rest.y(60));
  rest.view.setOutputs(listenOptions(rig), rig.setup);
  const select = rest.get('scratch-play-output');
  const choose = (value) => {
    select.value = value;
    select.dispatch('change');
  };
  const noteText = () => rest.get('scratch-play-note').textContent;
  const press = (id) => rest.get(id).dispatch('click');
  return { ...rest, calls, select, choose, noteText, press, aria: (id) => rest.get(id).getAttribute('aria-disabled'), pressed: (id) => rest.get(id).getAttribute('aria-pressed') };
}

test('the menu has the placeholder and one option for each instrument and channel, with the port in the title', () => {
  const { select } = hearSetup();
  assert.deepEqual(select.children.map((option) => [option.value, option.textContent]), [
    ['', 'Choose an instrument'],
    ['mt32|2', 'mt32 · channel 2'],
    ['mt32|10', 'mt32 · channel 10'],
    ['jx|1', 'jx · channel 1'],
  ]);
  assert.deepEqual(select.children.map((option) => option.getAttribute('title')), [null, 'mt32 · channel 2 · Port A', 'mt32 · channel 10 · Port A', 'jx · channel 1 · Port B']);
  assert.equal(select.getAttribute('aria-label'), 'Instrument and channel');
});

test('a new list that still holds the chosen option keeps the choice, and one that does not returns to the placeholder', () => {
  const { select, choose, view, get } = hearSetup();
  choose('mt32|10');
  view.setOutputs(listenOptions({ ...RIG, instruments: [{ ...RIG.instruments[0], port: 'Port Z' }] }), 'valid');
  assert.equal(select.value, 'mt32|10');
  assert.equal(select.children[2].getAttribute('title'), 'mt32 · channel 10 · Port Z');
  view.setOutputs(listenOptions({ ...RIG, instruments: [RIG.instruments[1]] }), 'valid');
  assert.equal(select.value, '');
  assert.equal(get('scratch-play-note').textContent, 'Choose an instrument to listen on.');
});

test('the menu is rebuilt only when the list changed', () => {
  const { select, view, document } = hearSetup();
  const before = select.children.slice();
  const writes = document.writes;
  view.setOutputs(listenOptions(RIG), 'valid');
  assert.equal(document.writes, writes, 'the same list writes nothing');
  assert.ok(select.children.every((option, index) => option === before[index]), 'and keeps the same options');
});

test('an option is built from plain text, so an instrument id that looks like markup stays text', () => {
  const { select, view } = hearSetup();
  view.setOutputs(listenOptions({ setup: 'valid', instruments: [{ id: '<b>x</b>', port: '"><i>', enabled: true, channels: [{ channel: 1, role: 'melodic' }] }] }), 'valid');
  assert.equal(select.children[1].textContent, '<b>x</b> · channel 1');
  assert.equal(select.children[1].children.length, 0);
});

test('with nothing chosen Listen carries aria-disabled with the reason, the line says to choose, and a press calls nothing', () => {
  const { aria, noteText, press, calls, get } = hearSetup();
  assert.equal(aria('scratch-play-listen'), 'true');
  assert.equal(get('scratch-play-listen').getAttribute('title'), 'Choose an instrument to listen on.');
  assert.equal(noteText(), 'Choose an instrument to listen on.');
  press('scratch-play-listen');
  assert.deepEqual(calls, []);
});

test('with no instrument the strip says why, in the words of the setup file, and Listen carries aria-disabled', () => {
  for (const [setupWord, words] of [
    ['valid', 'No instrument to listen on: instruments.json names none.'],
    ['absent', 'No instrument to listen on: there is no instruments.json.'],
    ['invalid', 'No instrument to listen on: instruments.json has a problem. The MIDI popover shows it.'],
  ]) {
    const { view, noteText, aria, calls, press } = hearSetup();
    view.setOutputs([], setupWord);
    assert.equal(noteText(), words);
    assert.equal(aria('scratch-play-listen'), 'true');
    press('scratch-play-listen');
    assert.deepEqual(calls, []);
  }
});

test('choosing an option enables Listen, and a press hands the page the instrument, the channel, the start and Loop', () => {
  const { choose, aria, press, calls, pressed, noteText } = hearSetup();
  choose('mt32|10');
  assert.equal(aria('scratch-play-listen'), 'false');
  assert.equal(noteText(), '');
  press('scratch-play-listen');
  assert.deepEqual(calls, [['listen', { instrumentId: 'mt32', channel: 10, start: 'music', loop: false }]]);
  assert.deepEqual([pressed('scratch-play-music'), pressed('scratch-play-now'), pressed('scratch-play-loop')], ['true', 'false', 'false']);
});

test('At once and Loop are remembered by the view, and Loop tells the page when it changes', () => {
  const { choose, press, calls, pressed } = hearSetup();
  choose('jx|1');
  press('scratch-play-now');
  press('scratch-play-loop');
  assert.deepEqual([pressed('scratch-play-music'), pressed('scratch-play-now'), pressed('scratch-play-loop')], ['false', 'true', 'true']);
  press('scratch-play-listen');
  assert.deepEqual(calls, [['loop', true], ['listen', { instrumentId: 'jx', channel: 1, start: 'now', loop: true }]]);
  press('scratch-play-loop');
  press('scratch-play-music');
  assert.deepEqual(calls.at(-1), ['loop', false]);
  assert.deepEqual([pressed('scratch-play-music'), pressed('scratch-play-now'), pressed('scratch-play-loop')], ['true', 'false', 'false']);
});

test('a Listen press with no notes says so itself and calls nothing', () => {
  const { choose, press, calls, noteText, view } = hearSetup({}, { withNote: false });
  choose('mt32|2');
  press('scratch-play-listen');
  assert.deepEqual(calls, []);
  assert.equal(noteText(), 'Nothing to listen to: the motif has no notes.');
  assert.equal(view.motifCycles(), 2);
});

test('a Listen press with no notes while a play goes on stops that play first, then says there is nothing to listen to', () => {
  const order = [];
  const t = hearSetup(
    {
      onStop: () => {
        order.push('stop');
        t.view.setHear({ kind: 'stopped', reason: 'stop', instrumentId: 'mt32', channel: 2 });
      },
    },
    { withNote: false },
  );
  t.choose('mt32|2');
  t.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: true });
  t.press('scratch-play-listen');
  assert.deepEqual(order, ['stop'], 'the play is stopped');
  assert.equal(t.noteText(), 'Nothing to listen to: the motif has no notes.', 'the refusal is the sentence that stays');
  assert.equal(t.attr('scratch-view', 'data-hear'), 'refused');
});

test('Stop carries aria-disabled unless something is playing, and a press calls onStop', () => {
  const { view, aria, press, calls, get } = hearSetup();
  assert.equal(aria('scratch-play-stop'), 'true');
  press('scratch-play-stop');
  assert.deepEqual(calls, []);
  view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  assert.equal(aria('scratch-play-stop'), 'false');
  press('scratch-play-stop');
  assert.deepEqual(calls, [['stop']]);
  view.setHear({ kind: 'stopped', reason: 'stop', instrumentId: 'mt32', channel: 2 });
  assert.equal(aria('scratch-play-stop'), 'true');
  assert.equal(get('scratch-play-note').textContent, 'Stopped. Held notes are silent.');
});

test('the state sentence shows the instrument id apart, in its own element, and the view says which state it is in', () => {
  const { view, get, attr, document } = hearSetup();
  view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: true });
  const note = get('scratch-play-note');
  assert.equal(note.textContent, 'Playing on mt32, channel 2, in a loop.');
  assert.deepEqual(note.children.map((child) => [child.className, child.textContent]), [['', 'Playing on '], ['sp-hear-id', 'mt32'], ['', ', channel 2, in a loop.']]);
  assert.equal(attr('scratch-view', 'data-hear'), 'playing');
  const writes = document.writes;
  view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: true });
  assert.equal(document.writes, writes, 'the same state writes nothing');
  view.setHear({ kind: 'ended', instrumentId: 'mt32', channel: 2 });
  assert.equal(note.textContent, 'Played once on mt32, channel 2.');
  assert.equal(attr('scratch-view', 'data-hear'), 'ended');
});

test('a refusal is said in one sentence, and choosing another instrument clears a sentence that is over', () => {
  const { view, get, choose } = hearSetup();
  choose('mt32|2');
  view.setHear({ kind: 'refused', refused: 'no-output', instrumentId: 'mt32', channel: 2, port: 'Port A', names: ['Port B'], mid: false });
  assert.equal(get('scratch-play-note').textContent, 'Not played: no MIDI output contains the name Port A. Outputs here: Port B.');
  choose('jx|1');
  assert.equal(get('scratch-play-note').textContent, '');
});

test('choosing another instrument while it plays leaves the play and its sentence alone', () => {
  const { view, get, choose } = hearSetup();
  choose('mt32|2');
  view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  choose('jx|1');
  assert.equal(get('scratch-play-note').textContent, 'Playing on mt32, channel 2.');
});

test('a hear state the view does not know throws, and setOutputs needs a list', () => {
  const { view } = hearSetup();
  assert.throws(() => view.setHear(null), TypeError);
  assert.throws(() => view.setHear({ kind: 'nope' }), /is not known/);
  assert.throws(() => view.setOutputs(null), TypeError);
});

test('the hear strip without its callbacks fails loudly at the press, naming the option', () => {
  const rest = setup();
  rest.dbl(rest.x(0), rest.y(60));
  rest.view.setOutputs(listenOptions(RIG), 'valid');
  rest.get('scratch-play-output').value = 'mt32|2';
  rest.get('scratch-play-output').dispatch('change');
  assert.throws(() => rest.get('scratch-play-listen').dispatch('click'), /onListen/);
  assert.throws(() => rest.get('scratch-play-loop').dispatch('click'), /onLoop/);
  rest.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  assert.throws(() => rest.get('scratch-play-stop').dispatch('click'), /onStop/);
});

test('the view hands the page its motif for Listen to read, and the motif it hands is the present one after an edit and an undo', () => {
  const { view, dbl, x, y, get } = setup();
  assert.equal(view.motif().notes.length, 0);
  dbl(x(0), y(60));
  assert.equal(view.motif().notes.length, 1);
  get('scratch-undo').dispatch('click');
  assert.equal(view.motif().notes.length, 0);
});

// --- Listen: the live overlay is paused, the playhead crosses the motif, and every state is said ---

test('while Listen waits or plays the live layer is put away, the roll shows the motif\'s own cycles, and it comes back when the play ends', () => {
  const t = hearSetup();
  t.view.setLive({ now: 10.5, snapshot: TWO_NOTES(), frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'live');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '8');
  t.view.setHear({ kind: 'waiting', instrumentId: 'mt32', channel: 2, cycle: 13 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'off');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '2');
  assert.equal(t.attr('scratch-view', 'data-live-notes'), '0');
  assert.equal(t.get('scratch-live').children.length, 0);
  assert.ok(t.hidden('scratch-playhead'));
  t.view.setLive({ now: 10.6, snapshot: TWO_NOTES(), frameMs: 1016 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'off', 'a frame while it waits keeps the overlay paused');
  t.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  assert.equal(t.attr('scratch-view', 'data-live'), 'off');
  t.view.setHear({ kind: 'ended', instrumentId: 'mt32', channel: 2 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'live');
  assert.equal(t.attr('scratch-view', 'data-shown-cycles'), '8');
  assert.equal(t.attr('scratch-view', 'data-live-notes'), '2');
  assert.equal(t.hidden('scratch-playhead'), false, 'the live playhead is back');
});

test('the Armed marker is put away while a play waits or plays, and comes back after', () => {
  const t = hearSetup();
  t.view.setLive({ now: 10.5, snapshot: null, frameMs: 1000 });
  assert.equal(t.attr('scratch-view', 'data-live'), 'armed');
  assert.equal(t.hidden('scratch-now'), false);
  t.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  assert.equal(t.hidden('scratch-now'), true);
  t.view.setHear({ kind: 'stopped', reason: 'stop', instrumentId: 'mt32', channel: 2 });
  assert.equal(t.hidden('scratch-now'), false);
});

test('the playhead crosses the motif at the unit the page gives, hidden while the play waits and when it is over', () => {
  const t = hearSetup();
  t.view.setHear({ kind: 'waiting', instrumentId: 'mt32', channel: 2, cycle: 13 });
  t.view.setHearPosition(null, 1000);
  assert.ok(t.hidden('scratch-playhead'), 'waiting: no playhead');
  t.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  t.view.setHearPosition(30.5, 1016);
  assert.equal(t.hidden('scratch-playhead'), false);
  assert.equal(t.prop('scratch-playhead', '--sp-playhead'), '30.5');
  t.view.setHearPosition(60, 1032);
  assert.equal(t.prop('scratch-playhead', '--sp-playhead'), '60');
  t.view.setHearPosition(null, 1048);
  assert.ok(t.hidden('scratch-playhead'));
  t.view.setHearPosition(10, 1064);
  t.view.setHear({ kind: 'ended', instrumentId: 'mt32', channel: 2 });
  assert.ok(t.hidden('scratch-playhead'), 'over: gone');
  t.view.setHearPosition(12, 1080);
  assert.ok(t.hidden('scratch-playhead'), 'a late position does not bring it back');
});

test('a Listen playhead writes only when its unit changes, and a bad unit throws', () => {
  const t = hearSetup();
  t.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: false });
  t.view.setHearPosition(5, 1000);
  const writes = t.document.writes;
  const styleWrites = watchStyleWrites(t.get('scratch-playhead'));
  t.view.setHearPosition(5, 1016);
  assert.equal(t.document.writes, writes);
  assert.equal(styleWrites.size, 0);
  assert.throws(() => t.view.setHearPosition(Number.NaN, 1032), TypeError);
  assert.throws(() => t.view.setHearPosition('3', 1032), TypeError);
});

test('the box turns to follow the Listen playhead past 90 percent of the visible width, and back to the start when a loop wraps', () => {
  const { t, scroll, place } = followSetup();
  const play = t;
  play.dbl(play.x(0), play.y(60));
  play.view.setOutputs(listenOptions(RIG), 'valid');
  play.view.setHear({ kind: 'playing', instrumentId: 'mt32', channel: 2, loop: true });
  // The motif is 2 cycles = 96 units; the grid is 3200 pixels for 384 units in these fakes, so place it for 96 units: 800 pixels.
  const placeMotif = (scrolled) => {
    play.grid.rect = { ...GRID_RECT, left: 100 - scrolled, right: 100 - scrolled + 800, width: 800 };
  };
  placeMotif(0);
  play.view.setHearPosition(10, 1000);
  assert.equal(scroll.scrollLeft, 0);
  play.view.setHearPosition(80, 1016);
  assert.equal(scroll.scrollLeft, 0, 'unit 80 of 96 is pixel 767, inside 90 percent of the 1000 visible');
  scroll.rect = { left: 0, top: 0, right: 700, bottom: 600, width: 700, height: 600 };
  play.view.setHearPosition(90, 1032);
  assert.ok(scroll.scrollLeft > 0, 'unit 90 is pixel 850, past 90 percent of 600 visible pixels: the box turns');
  placeMotif(scroll.scrollLeft);
  play.view.setHearPosition(3, 1048);
  assert.equal(scroll.scrollLeft, 0, 'the loop wrapped: back to the start');
});

test('Stop is available while the play asks, waits or plays, and the ask is said in the line', () => {
  const t = hearSetup();
  assert.equal(t.aria('scratch-play-stop'), 'true');
  t.view.setHear({ kind: 'asking' });
  assert.equal(t.aria('scratch-play-stop'), 'false');
  assert.equal(t.noteText(), 'Waiting for the answer to the MIDI permission.');
  assert.ok(t.hidden('scratch-playhead'));
  t.view.setHear({ kind: 'waiting', instrumentId: 'mt32', channel: 2, cycle: 13 });
  assert.equal(t.aria('scratch-play-stop'), 'false');
  assert.equal(t.noteText(), 'Waiting for cycle 13 of the music, then playing on mt32, channel 2. Stop cancels.');
  t.view.setHear({ kind: 'stopped', reason: 'stop', instrumentId: 'mt32', channel: 2 });
  assert.equal(t.aria('scratch-play-stop'), 'true');
});

test('the hint of Select mode ends by saying Listen plays the motif', () => {
  const { get } = setup();
  assert.equal(get('scratch-hint').textContent, 'Click or drag to select. Double-click or Enter writes a note. Delete erases. Listen plays the motif.');
});

test('the empty-state line names Listen, not silence', () => {
  const { line } = setup();
  assert.match(line().rest, /Listen plays the motif on an instrument you choose/);
  assert.doesNotMatch(line().spoken, /no sound/);
});

// --- Heads up: a chord on an instrument that plays one note at a time ---

const LEAD_RIG = {
  setup: 'valid',
  instruments: [
    { id: 'lead', port: 'Port A', enabled: true, monophonic: true, channels: [{ channel: 1, role: 'melodic' }] },
    { id: 'wide', port: 'Port B', enabled: true, monophonic: false, channels: [{ channel: 1, role: 'melodic' }] },
    { id: 'unsaid', port: 'Port C', enabled: true, channels: [{ channel: 1, role: 'melodic' }] },
  ],
};
const CHORD_WORDS = 'Heads up: lead plays one note at a time, so a chord would be heard as one note.';

/** The hear strip with a rig of three instruments and, when asked, a chord (two notes at once) in the motif. */
function chordSetup({ chord = true } = {}) {
  const t = hearSetup({}, { rig: LEAD_RIG, withNote: false });
  t.dbl(t.x(0), t.y(60));
  if (chord) t.dbl(t.x(0), t.y(64));
  return t;
}

test('choosing a monophonic instrument with a chord in the motif shows the chord sentence, in a span of its own with the id apart', () => {
  const t = chordSetup();
  assert.equal(t.noteText(), 'Choose an instrument to listen on.', 'with nothing chosen there is nothing to warn about');
  t.choose('lead|1');
  assert.equal(t.noteText(), CHORD_WORDS);
  const spans = t.get('scratch-play-note').children;
  assert.deepEqual(spans.map((span) => [span.textContent, span.className]), [['Heads up: ', ''], ['lead', 'sp-hear-id'], [' plays one note at a time, so a chord would be heard as one note.', '']]);
});

test('without a chord, or with a model that says nothing or says false, the chord sentence does not show', () => {
  const single = chordSetup({ chord: false });
  single.choose('lead|1');
  assert.equal(single.noteText(), '', 'one note');
  const t = chordSetup();
  t.choose('wide|1');
  assert.equal(t.noteText(), '', 'a model that says false');
  t.choose('unsaid|1');
  assert.equal(t.noteText(), '', 'a model that says nothing');
});

test('a new rig that only changes monophonic, enabled or the port is taken by the menu, so the chord sentence shows at once', () => {
  const t = chordSetup();
  t.choose('wide|1');
  assert.equal(t.noteText(), '');
  const withWide = (extra) => ({ ...LEAD_RIG, instruments: LEAD_RIG.instruments.map((instrument) => (instrument.id === 'wide' ? { ...instrument, ...extra } : instrument)) });
  t.view.setOutputs(listenOptions(withWide({ monophonic: true })), 'valid');
  assert.equal(t.noteText(), 'Heads up: wide plays one note at a time, so a chord would be heard as one note.', 'the model was saved as monophonic');
  assert.equal(t.select.value, 'wide|1', 'the choice stays');
  // A switch-off, and a new port past the length the title shows, leave every option's text and title as they were: the menu still takes the
  // new list, which a fresh option element shows.
  const before = t.select.children[2];
  t.view.setOutputs(listenOptions(withWide({ monophonic: true, enabled: false })), 'valid');
  assert.notEqual(t.select.children[2], before, 'a switch-off is taken');
  const long = 'P'.repeat(250);
  t.view.setOutputs(listenOptions(withWide({ monophonic: true, enabled: false, port: `${long} 1` })), 'valid');
  const after = t.select.children[2];
  t.view.setOutputs(listenOptions(withWide({ monophonic: true, enabled: false, port: `${long} 2` })), 'valid');
  assert.equal(t.select.children[2].getAttribute('title'), after.getAttribute('title'), 'the title is the same');
  assert.notEqual(t.select.children[2], after, 'a new port is taken');
});

test('the chord sentence follows the motif: it appears when a chord is written and goes when the chord is erased', () => {
  const t = chordSetup({ chord: false });
  t.choose('lead|1');
  assert.equal(t.noteText(), '');
  t.dbl(t.x(0), t.y(64));
  assert.equal(t.noteText(), CHORD_WORDS, 'a second note at once');
  t.get('scratch-undo').dispatch('click');
  assert.equal(t.noteText(), '', 'undone');
});

test('the chord sentence comes after the state sentence and stays while the play goes on', () => {
  const t = chordSetup();
  t.choose('lead|1');
  t.view.setHear({ kind: 'playing', instrumentId: 'lead', channel: 1, loop: false });
  assert.equal(t.noteText(), `Playing on lead, channel 1.${' '}${CHORD_WORDS}`);
  t.view.setHear({ kind: 'ended', instrumentId: 'lead', channel: 1 });
  assert.equal(t.noteText(), `Played once on lead, channel 1.${' '}${CHORD_WORDS}`);
});

test('the chord sentence never blocks Listen: it stays pressable and a press plays', () => {
  const t = chordSetup();
  t.choose('lead|1');
  assert.equal(t.aria('scratch-play-listen'), 'false');
  t.press('scratch-play-listen');
  assert.deepEqual(t.calls, [['listen', { instrumentId: 'lead', channel: 1, start: 'music', loop: false }]]);
});

// --- Heads up: a channel that a playing track uses ---

/** Like chordSetup, with the tracks the page would report as playing on an instrument and channel (`playing` is changed by the test). */
function trackSetup({ chord = true } = {}) {
  const playing = { tracks: {} };
  const asked = [];
  const t = hearSetup({ playingTracks: (id, channel) => { asked.push([id, channel]); return playing.tracks[`${id}|${channel}`] ?? []; } }, { rig: LEAD_RIG, withNote: false });
  t.dbl(t.x(0), t.y(60));
  if (chord) t.dbl(t.x(0), t.y(64));
  return { ...t, playing, asked };
}
const CHANNEL_WORDS = 'Heads up: channel 1 on lead is used by the track pad, which is playing. Both would sound on it.';

test('choosing an instrument and channel that a playing track uses shows the channel sentence, and another channel does not', () => {
  const t = trackSetup({ chord: false });
  t.playing.tracks['lead|1'] = ['pad'];
  t.choose('lead|1');
  assert.equal(t.noteText(), CHANNEL_WORDS);
  assert.deepEqual(t.get('scratch-play-note').children.map((span) => span.className), ['', 'sp-hear-id', ''], 'the instrument id is apart');
  t.choose('wide|1');
  assert.equal(t.noteText(), '', 'nothing plays on that one');
  assert.deepEqual(t.asked.at(-1), ['wide', 1]);
});

test('with both conditions the strip shows the state sentence, then the channel sentence, then the chord sentence, and Listen stays pressable and plays', () => {
  const t = trackSetup();
  t.playing.tracks['lead|1'] = ['pad'];
  t.choose('lead|1');
  assert.equal(t.noteText(), `${CHANNEL_WORDS} ${CHORD_WORDS}`);
  t.view.setHear({ kind: 'playing', instrumentId: 'lead', channel: 1, loop: false });
  assert.equal(t.noteText(), `Playing on lead, channel 1. ${CHANNEL_WORDS} ${CHORD_WORDS}`);
  t.view.setHear({ kind: 'idle' });
  assert.equal(t.aria('scratch-play-listen'), 'false', 'neither warning sets aria-disabled');
  t.press('scratch-play-listen');
  assert.deepEqual(t.calls, [['listen', { instrumentId: 'lead', channel: 1, start: 'music', loop: false }]]);
});

test('refreshHear asks again for the playing tracks, so a change of the playing code or of the playing state shows', () => {
  const t = trackSetup({ chord: false });
  t.choose('lead|1');
  assert.equal(t.noteText(), '');
  t.playing.tracks['lead|1'] = ['pad', 'bass'];
  assert.equal(t.noteText(), '', 'nothing changes by itself');
  t.view.refreshHear();
  assert.equal(t.noteText(), 'Heads up: channel 1 on lead is used by the tracks pad, bass, which are playing. Both would sound on it.');
  t.playing.tracks['lead|1'] = [];
  t.view.refreshHear();
  assert.equal(t.noteText(), '');
});

test('refreshHear writes nothing when nothing changed, and does nothing with no choice', () => {
  const t = trackSetup({ chord: false });
  t.view.refreshHear();
  assert.equal(t.noteText(), 'Choose an instrument to listen on.');
  t.playing.tracks['lead|1'] = ['pad'];
  t.choose('lead|1');
  const writes = t.document.writes;
  t.view.refreshHear();
  assert.equal(t.document.writes, writes);
});

test('a track name that looks like markup stays plain text in the strip', () => {
  const t = trackSetup({ chord: false });
  t.playing.tracks['lead|1'] = ['<img src=x>'];
  t.choose('lead|1');
  assert.ok(t.noteText().includes('the track <img src=x>, which'));
  assert.ok(t.get('scratch-play-note').children.every((span) => span.children.length === 0));
});

test('a view made without playingTracks warns about no track', () => {
  const t = chordSetup({ chord: false });
  t.choose('lead|1');
  assert.equal(t.noteText(), '');
});

// --- Undo and Redo scroll the box to the notes they touched ---

// The ruler is held at the top of the box (its bottom is at 20) and the lane at its bottom (its top is at 300): the visible band is 20 to 300.
function historyScrollSetup() {
  const t = historySetup();
  t.get('scratch-ruler').rect = { left: 0, right: 500, top: 0, bottom: 20, width: 500, height: 20 };
  t.get('scratch-lane').rect = { left: 0, right: 500, top: 300, bottom: 360, width: 500, height: 60 };
  return t;
}

test('Undo scrolls the box down to the note that remains and Redo scrolls it up to the note it brought back, the cursor row staying in view', () => {
  const t = historyScrollSetup();
  const scroll = t.get('scratch-scroll');
  t.focus();
  t.press('Enter');
  t.press('ArrowUp', { altKey: true });
  t.press('ArrowRight');
  t.press('Enter');
  assert.equal(t.cursor().pitch, 72);
  assert.equal(t.notes().length, 2);
  t.grid.rect = { left: 48, right: 1008, top: 100, bottom: 460, width: 960, height: 360 };
  scroll.scrollTop = 50;
  t.undoKey();
  assert.equal(t.notes().length, 1);
  assert.equal(scroll.scrollTop, 90, 'the C4 row ends 40 below the lane and the cursor row (C5) fits with it: the box scrolls down by 40');
  assert.equal(t.cursor().pitch, 72, 'the cursor stays where it was');
  t.grid.rect = { left: 48, right: 1008, top: -150, bottom: 210, width: 960, height: 360 };
  t.redoKey();
  assert.equal(t.notes().length, 2);
  assert.equal(scroll.scrollTop, 30, 'the C5 row and the cursor row start 60 above the ruler: the box scrolls up by 60');
  assert.equal(t.cursor().pitch, 72);
});

test('Undo moves the cursor onto the remaining note when the cursor row and that note cannot share the box', () => {
  const t = historyScrollSetup();
  const scroll = t.get('scratch-scroll');
  t.get('scratch-scroll').rect = { left: 0, right: 500, width: 500, top: 0, bottom: 360, height: 360 };
  t.get('scratch-gutter').rect = { left: 0, right: 48, width: 48, top: 0, bottom: 0, height: 0 };
  t.focus();
  t.press('Enter');
  for (let i = 0; i < 3; i += 1) t.press('ArrowUp', { altKey: true });
  t.press('ArrowRight');
  t.press('Enter');
  assert.equal(t.cursor().pitch, 96);
  assert.equal(t.notes().length, 2);
  t.grid.rect = { left: 48, right: 1008, top: -90, bottom: 510, width: 960, height: 600 };
  scroll.scrollTop = 110;
  scroll.scrollLeft = 0;
  t.undoKey();
  assert.equal(t.notes().length, 1);
  assert.deepEqual(t.cursor(), { unit: 0, pitch: 60 }, 'the cursor row (C7) and the C4 row are 370 apart, more than the 280 of the band: the cursor goes to the note');
  assert.equal(t.viewEl.getAttribute('data-rows'), '24', 'the rows no longer hold C7');
  assert.equal(t.line().kind, 'notice');
  assert.equal(t.line().spoken, 'Undid: placed C7.');
  assert.equal(scroll.scrollLeft, 0);
});

test('an Undo or a Redo that changes nothing leaves the scroll alone', () => {
  const t = historyScrollSetup();
  const scroll = t.get('scratch-scroll');
  t.focus();
  t.grid.rect = { left: 48, right: 1008, top: 100, bottom: 460, width: 960, height: 360 };
  scroll.scrollTop = 77;
  t.undoKey();
  assert.equal(scroll.scrollTop, 77);
  assert.equal(t.line().spoken, 'Nothing to undo.');
  t.redoKey();
  assert.equal(scroll.scrollTop, 77);
});
