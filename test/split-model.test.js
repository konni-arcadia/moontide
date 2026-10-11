// The separator between the editor and the view: the pure model. Limits, defaults, the keys per
// layout, the pointer geometry, the stored-value parse and the copy. The live half (drag, focus, reload, the editor
// measuring itself) is `npm run probe:page -- --only bar`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPLIT_COPY,
  SPLIT_DEFAULTS,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_PAGE,
  SPLIT_STEP,
  clampSplit,
  parseStoredSplit,
  splitFromPointer,
  splitKeyValue,
} from '../page/split-model.js';

test('the limits, the steps and the defaults are the ones the design fixed', () => {
  assert.equal(SPLIT_MIN, 15);
  assert.equal(SPLIT_MAX, 85);
  assert.equal(SPLIT_STEP, 2);
  assert.equal(SPLIT_PAGE, 10);
  assert.deepEqual({ ...SPLIT_DEFAULTS }, { a: 42, b: 45 });
  assert.ok(Object.isFrozen(SPLIT_DEFAULTS));
});

test('clampSplit keeps a number inside 15..85', () => {
  assert.equal(clampSplit(14.9), 15);
  assert.equal(clampSplit(85.1), 85);
  assert.equal(clampSplit(42), 42);
  assert.equal(clampSplit(15), 15);
  assert.equal(clampSplit(85), 85);
  assert.equal(clampSplit(-1000), 15);
  assert.equal(clampSplit(1e9), 85);
});

test('clampSplit throws a Moontide error for anything that is not a finite number', () => {
  for (const bad of [Number.NaN, '42', null, undefined, Infinity, -Infinity, {}, [], true]) {
    assert.throws(() => clampSplit(bad), /^Error: Moontide: a split size must be a finite number/, String(bad));
  }
});

test('splitKeyValue in layout a: ArrowUp grows the view by 2, ArrowDown shrinks it by 2', () => {
  assert.equal(splitKeyValue('a', 42, 'ArrowUp'), 44);
  assert.equal(splitKeyValue('a', 42, 'ArrowDown'), 40);
  assert.equal(splitKeyValue('a', 84, 'ArrowUp'), 85);
  assert.equal(splitKeyValue('a', 16, 'ArrowDown'), 15);
});

test('splitKeyValue in layout b: ArrowLeft grows the view by 2, ArrowRight shrinks it by 2', () => {
  assert.equal(splitKeyValue('b', 45, 'ArrowLeft'), 47);
  assert.equal(splitKeyValue('b', 45, 'ArrowRight'), 43);
  assert.equal(splitKeyValue('b', 85, 'ArrowLeft'), 85);
  assert.equal(splitKeyValue('b', 15, 'ArrowRight'), 15);
});

test('splitKeyValue: Page keys move by 10, Home goes to 15 and End to 85, in both layouts', () => {
  for (const layout of ['a', 'b']) {
    assert.equal(splitKeyValue(layout, 42, 'PageUp'), 52, layout);
    assert.equal(splitKeyValue(layout, 42, 'PageDown'), 32, layout);
    assert.equal(splitKeyValue(layout, 80, 'PageUp'), 85, layout);
    assert.equal(splitKeyValue(layout, 20, 'PageDown'), 15, layout);
    assert.equal(splitKeyValue(layout, 42, 'Home'), 15, layout);
    assert.equal(splitKeyValue(layout, 42, 'End'), 85, layout);
  }
});

test('splitKeyValue: the arrows of the other axis and every other key return null', () => {
  assert.equal(splitKeyValue('a', 42, 'ArrowLeft'), null);
  assert.equal(splitKeyValue('a', 42, 'ArrowRight'), null);
  assert.equal(splitKeyValue('b', 45, 'ArrowUp'), null);
  assert.equal(splitKeyValue('b', 45, 'ArrowDown'), null);
  for (const key of ['Enter', ' ', 'Escape', 'a', 'b', 'c', '1', '6', 'Tab', 'Delete']) {
    assert.equal(splitKeyValue('a', 42, key), null, key);
    assert.equal(splitKeyValue('b', 45, key), null, key);
  }
});

test('splitKeyValue throws for layout c, for an unknown layout and for a non-number current value', () => {
  assert.throws(() => splitKeyValue('c', 42, 'ArrowUp'), /Moontide: /);
  assert.throws(() => splitKeyValue('d', 42, 'ArrowUp'), /Moontide: /);
  assert.throws(() => splitKeyValue('a', '42', 'ArrowUp'), /Moontide: /);
});

test('parseStoredSplit accepts a number from 15 to 85 with one decimal and nothing else', () => {
  assert.equal(parseStoredSplit('42'), 42);
  assert.equal(parseStoredSplit('42.34'), 42.3);
  assert.equal(parseStoredSplit('15'), 15);
  assert.equal(parseStoredSplit('85'), 85);
  assert.equal(parseStoredSplit('14.9'), undefined);
  assert.equal(parseStoredSplit('85.1'), undefined);
  assert.equal(parseStoredSplit('90'), undefined);
  assert.equal(parseStoredSplit('-1'), undefined);
  assert.equal(parseStoredSplit('abc'), undefined);
  assert.equal(parseStoredSplit(''), undefined);
  assert.equal(parseStoredSplit(null), undefined);
  assert.equal(parseStoredSplit(undefined), undefined);
});

test('parseStoredSplit refuses everything that is not a plain number', () => {
  for (const bad of ['1e9', '1e1', 'calc(1px)', '42%', '42px', ' 42 ', '0x2a', 'Infinity', 'NaN', '42; color: red', '<b>', '42,5', '--view-size']) {
    assert.equal(parseStoredSplit(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(parseStoredSplit(42), undefined, 'a number that is not a string was never stored');
});

test('splitFromPointer in layout a: the pointer at the grab position gives the current value', () => {
  // A workspace 1000 px tall starting at 100; the view is 42 percent, so it starts at 680 and the 8 px handle at 672.
  const rect = { left: 0, top: 100, width: 800, height: 1000 };
  const value = splitFromPointer({ layout: 'a', pointer: 676, rect, handle: 8, grab: 4 });
  assert.equal(value, 42);
});

test('splitFromPointer in layout a: moving the pointer up by 100 px raises the view by 10 points', () => {
  const rect = { left: 0, top: 100, width: 800, height: 1000 };
  assert.equal(splitFromPointer({ layout: 'a', pointer: 576, rect, handle: 8, grab: 4 }), 52);
  assert.equal(splitFromPointer({ layout: 'a', pointer: 776, rect, handle: 8, grab: 4 }), 32);
});

test('splitFromPointer uses the offset at grab time: a grab at the edge of the handle does not jump the border', () => {
  const rect = { left: 0, top: 100, width: 800, height: 1000 };
  // Grabbed 1 px from the top of the same handle (it starts at 672): the pointer is at 673 and the value stays 42.
  assert.equal(splitFromPointer({ layout: 'a', pointer: 673, rect, handle: 8, grab: 1 }), 42);
  // Grabbed 7 px in: the pointer is at 679.
  assert.equal(splitFromPointer({ layout: 'a', pointer: 679, rect, handle: 8, grab: 7 }), 42);
});

test('splitFromPointer clamps to 15..85', () => {
  const rect = { left: 0, top: 100, width: 800, height: 1000 };
  assert.equal(splitFromPointer({ layout: 'a', pointer: -5000, rect, handle: 8, grab: 4 }), 85);
  assert.equal(splitFromPointer({ layout: 'a', pointer: 5000, rect, handle: 8, grab: 4 }), 15);
});

test('splitFromPointer in layout b reads the horizontal axis', () => {
  // A workspace 1000 px wide starting at 50; the view is 45 percent, so the 8 px handle starts at 592.
  const rect = { left: 50, top: 0, width: 1000, height: 300 };
  assert.equal(splitFromPointer({ layout: 'b', pointer: 596, rect, handle: 8, grab: 4 }), 45);
  assert.equal(splitFromPointer({ layout: 'b', pointer: 496, rect, handle: 8, grab: 4 }), 55);
  assert.equal(splitFromPointer({ layout: 'b', pointer: 696, rect, handle: 8, grab: 4 }), 35);
  assert.equal(splitFromPointer({ layout: 'b', pointer: -100, rect, handle: 8, grab: 4 }), 85);
});

test('splitFromPointer rounds to one decimal and refuses a layout without a handle or a bad number', () => {
  const rect = { left: 0, top: 0, width: 800, height: 1000 };
  // 1000 - (693 + 8) = 299 px of 1000 is 29.9 percent.
  assert.equal(splitFromPointer({ layout: 'a', pointer: 697, rect, handle: 8, grab: 4 }), 29.9);
  assert.throws(() => splitFromPointer({ layout: 'c', pointer: 1, rect, handle: 8, grab: 4 }), /Moontide: /);
  assert.throws(() => splitFromPointer({ layout: 'a', pointer: Number.NaN, rect, handle: 8, grab: 4 }), /Moontide: /);
  assert.throws(() => splitFromPointer({ layout: 'a', pointer: 5, rect: { left: 0, top: 0, width: 800, height: 0 }, handle: 8, grab: 4 }), /Moontide: /);
});

test('SPLIT_COPY holds the words of the separator', () => {
  assert.equal(SPLIT_COPY.name, 'Resize the view');
  assert.equal(SPLIT_COPY.title, 'Drag, or use the arrow keys. Double-click resets.');
  assert.equal(SPLIT_COPY.valueText(42), 'View 42 percent');
  assert.equal(SPLIT_COPY.readoutLive(42), 'view 42%');
  assert.equal(SPLIT_COPY.readoutKept(44, 'a'), 'view 44% · kept for layout a');
  assert.equal(SPLIT_COPY.readoutReset(45), 'view reset to 45%');
  assert.equal(SPLIT_COPY.announce(42, 'b'), 'View size 42 percent, kept for layout b.');
  assert.equal(SPLIT_COPY.keptMs, 1500);
});

test('SPLIT_COPY writes whole percent for a stored decimal and names the key of a bad stored size', () => {
  assert.equal(SPLIT_COPY.valueText(42.6), 'View 43 percent');
  assert.equal(SPLIT_COPY.readoutLive(29.9), 'view 30%');
  assert.match(SPLIT_COPY.badStored('moontide.split.a', 42), /moontide\.split\.a/);
  assert.match(SPLIT_COPY.badStored('moontide.split.b', 45), /^Moontide: /);
});
