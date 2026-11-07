// The numbers behind a pointer on the Scratchpad roll: which cell a point is in, how long a drawn note is, where a dragged note
// lands and where a resize ends. Tested with plain numbers and no browser; a rem is 16 pixels here, as in the Timeline's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gesture from '../page/scratch-gesture.js';

const REM = 16;

// A grid 960 pixels wide for a motif of 96 units (10 pixels a unit) and 240 pixels high for 24 rows (10 pixels a row), with its
// corner at 100, 50. The shown rows run from C3 (48) to B4 (71), so the top row is B4 (71). A step of 3 units is a sixteenth.
const RECT = { left: 100, top: 50, width: 960, height: 240 };
const AT = { rect: RECT, units: 96, gridUnit: 3, rows: 24, high: 71 };

test('the numbers of a pointer are written in rem: a quarter to tell a click from a drag, a handle of half, a zone of one and a half', () => {
  assert.equal(gesture.DRAG_THRESHOLD_REM, 0.25);
  assert.equal(gesture.EDGE_HANDLE_REM, 0.5);
  assert.equal(gesture.EDGE_HANDLE_SHARE, 0.4);
  assert.equal(gesture.EDGE_ZONE_REM, 1.5);
  assert.equal(gesture.EDGE_SCROLL_REM, 1);
});

test('cellAt gives the start of the grid step that holds the point and the pitch of its row', () => {
  assert.deepEqual(gesture.cellAt({ ...AT, x: 100, y: 50 }), { unit: 0, pitch: 71 });
  assert.deepEqual(gesture.cellAt({ ...AT, x: 129, y: 50 }), { unit: 0, pitch: 71 }, 'unit 2.9 is still in the first step');
  assert.deepEqual(gesture.cellAt({ ...AT, x: 130, y: 50 }), { unit: 3, pitch: 71 });
  assert.deepEqual(gesture.cellAt({ ...AT, x: 400, y: 165 }), { unit: 30, pitch: 60 });
  assert.deepEqual(gesture.cellAt({ ...AT, x: 1059, y: 289 }), { unit: 93, pitch: 48 }, 'the last step of the last row');
});

test('cellAt follows the grid unit: eighths are 6 units wide, quarters 12', () => {
  assert.deepEqual(gesture.cellAt({ ...AT, gridUnit: 6, x: 100 + 59, y: 50 }).unit, 0);
  assert.deepEqual(gesture.cellAt({ ...AT, gridUnit: 6, x: 100 + 60, y: 50 }).unit, 6);
  assert.deepEqual(gesture.cellAt({ ...AT, gridUnit: 12, x: 100 + 239, y: 50 }).unit, 12 * 1);
  assert.deepEqual(gesture.cellAt({ ...AT, gridUnit: 12, x: 100 + 240, y: 50 }).unit, 24);
});

test('cellAt follows the shown rows: the same row is another pitch when the top pitch moves', () => {
  assert.equal(gesture.cellAt({ ...AT, high: 83, x: 400, y: 165 }).pitch, 72);
  assert.equal(gesture.cellAt({ ...AT, high: 35, x: 400, y: 289 }).pitch, 12);
});

test('cellAt, pointerRow and moveTarget land on the right pitch whatever the number of rows: 24, 36 and 108', () => {
  for (const [rows, high] of [[24, 71], [36, 83], [108, 119]]) {
    const rowHeight = 240 / rows;
    const rect = { ...RECT, height: 240 };
    for (const row of [0, 1, Math.floor(rows / 2), rows - 1]) {
      const y = 50 + (row + 0.5) * rowHeight;
      assert.equal(gesture.pointerRow({ rect, y, rows }), row, `${rows} rows, row ${row}`);
      assert.deepEqual(gesture.cellAt({ rect, x: 101, y, units: 96, gridUnit: 3, rows, high }), { unit: 0, pitch: high - row }, `${rows} rows, row ${row}`);
    }
    const note = { start: 12, length: 6, pitch: high - 5 };
    assert.equal(gesture.moveTarget({ note, dUnits: 0, dRows: -50, gridUnit: 3, units: 96, low: high - rows + 1, high }).pitch, high, `${rows} rows: the top row`);
    assert.equal(gesture.moveTarget({ note, dUnits: 0, dRows: 500, gridUnit: 3, units: 96, low: high - rows + 1, high }).pitch, high - rows + 1, `${rows} rows: the bottom row`);
  }
});

test('cellAt gives null for a point outside the rectangle', () => {
  for (const [x, y] of [[99, 100], [1060, 100], [400, 49], [400, 290], [-5, -5]]) {
    assert.equal(gesture.cellAt({ ...AT, x, y }), null, `${x},${y}`);
  }
});

test('pointerUnit and pointerRow read the point even outside the rectangle', () => {
  assert.equal(gesture.pointerUnit({ rect: RECT, x: 100, units: 96 }), 0);
  assert.equal(gesture.pointerUnit({ rect: RECT, x: 580, units: 96 }), 48);
  assert.equal(gesture.pointerUnit({ rect: RECT, x: 40, units: 96 }), -6);
  assert.equal(gesture.pointerUnit({ rect: RECT, x: 1160, units: 96 }), 106);
  assert.equal(gesture.pointerRow({ rect: RECT, y: 50, rows: 24 }), 0);
  assert.equal(gesture.pointerRow({ rect: RECT, y: 289.9, rows: 24 }), 23);
  assert.equal(gesture.pointerRow({ rect: RECT, y: 20, rows: 24 }), -3);
  assert.equal(gesture.pointerRow({ rect: RECT, y: 300, rows: 24 }), 25);
});

test('drawLength runs from the start to the end of the step under the pointer, one step at least', () => {
  const base = { start: 12, gridUnit: 3, units: 96 };
  assert.equal(gesture.drawLength({ ...base, pointerUnit: 12 }), 3, 'the pointer in the start step makes one step');
  assert.equal(gesture.drawLength({ ...base, pointerUnit: 14.9 }), 3);
  assert.equal(gesture.drawLength({ ...base, pointerUnit: 15 }), 6, 'the next step is included');
  assert.equal(gesture.drawLength({ ...base, pointerUnit: 20 }), 9, 'unit 20 lies in the step 18 to 21');
  assert.equal(gesture.drawLength({ ...base, pointerUnit: 5 }), 3, 'a pointer before the start gives one step');
  assert.equal(gesture.drawLength({ ...base, pointerUnit: -40 }), 3);
});

test('drawLength stops at the end of the motif', () => {
  assert.equal(gesture.drawLength({ start: 12, gridUnit: 3, units: 96, pointerUnit: 95.9 }), 84);
  assert.equal(gesture.drawLength({ start: 12, gridUnit: 3, units: 96, pointerUnit: 400 }), 84);
  assert.equal(gesture.drawLength({ start: 93, gridUnit: 3, units: 96, pointerUnit: 400 }), 3);
});

test('moveTarget moves the start to the nearest grid line, a tie to the earlier one, and the pitch by whole rows', () => {
  const note = { start: 12, length: 6, pitch: 60 };
  const base = { note, gridUnit: 3, units: 96, low: 48, high: 71, dRows: 0 };
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: 0 }), { start: 12, pitch: 60 });
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: 4.4 }), { start: 15, pitch: 60 });
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: 4.5 }), { start: 15, pitch: 60 }, 'unit 16.5 is half way between 15 and 18');
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: 4.6 }), { start: 18, pitch: 60 });
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: -3.2 }), { start: 9, pitch: 60 });
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: 0, dRows: 2 }), { start: 12, pitch: 58 }, 'two rows down is two semitones lower');
  assert.deepEqual(gesture.moveTarget({ ...base, dUnits: 0, dRows: -3 }), { start: 12, pitch: 63 });
});

test('moveTarget keeps the note inside the motif and inside the shown rows, and never returns a negative zero', () => {
  const note = { start: 12, length: 6, pitch: 60 };
  const base = { note, gridUnit: 3, units: 96, low: 48, high: 71, dUnits: 0, dRows: 0 };
  assert.equal(gesture.moveTarget({ ...base, dUnits: -100 }).start, 0);
  assert.ok(Object.is(gesture.moveTarget({ ...base, dUnits: -12.1 }).start, 0), 'start 0, not -0');
  assert.equal(gesture.moveTarget({ ...base, dUnits: 1000 }).start, 90, 'a note of 6 units ends at the motif end');
  assert.equal(gesture.moveTarget({ ...base, dRows: -50 }).pitch, 71, 'the top row of the window');
  assert.equal(gesture.moveTarget({ ...base, dRows: 50 }).pitch, 48, 'the bottom row of the window');
});

test('resizeLength ends the note on the nearest grid line, a tie to the earlier one, one step at least', () => {
  const base = { start: 12, gridUnit: 3, units: 96 };
  assert.equal(gesture.resizeLength({ ...base, pointerUnit: 24 }), 12);
  assert.equal(gesture.resizeLength({ ...base, pointerUnit: 25.4 }), 12);
  assert.equal(gesture.resizeLength({ ...base, pointerUnit: 25.5 }), 12, 'unit 25.5 is half way between lines 24 and 27');
  assert.equal(gesture.resizeLength({ ...base, pointerUnit: 25.6 }), 15);
  assert.equal(gesture.resizeLength({ ...base, pointerUnit: 12 }), 3, 'one step at least');
  assert.equal(gesture.resizeLength({ ...base, pointerUnit: -30 }), 3);
});

test('resizeLength stops at the end of the motif', () => {
  assert.equal(gesture.resizeLength({ start: 12, gridUnit: 3, units: 96, pointerUnit: 96 }), 84);
  assert.equal(gesture.resizeLength({ start: 12, gridUnit: 3, units: 96, pointerUnit: 300 }), 84);
});

test('pickPart is the edge within half a rem of the right side of a note, or within 40 percent of a short note', () => {
  const remPx = REM;
  assert.equal(gesture.pickPart({ left: 100, width: 100, x: 100, remPx }), 'body');
  assert.equal(gesture.pickPart({ left: 100, width: 100, x: 191.9, remPx }), 'body');
  assert.equal(gesture.pickPart({ left: 100, width: 100, x: 192, remPx }), 'edge');
  assert.equal(gesture.pickPart({ left: 100, width: 100, x: 199.9, remPx }), 'edge');
  assert.equal(gesture.pickPart({ left: 100, width: 10, x: 105.9, remPx }), 'body', 'a note of 10 pixels has an edge of 4');
  assert.equal(gesture.pickPart({ left: 100, width: 10, x: 106, remPx }), 'edge');
  assert.equal(gesture.pickPart({ left: 100, width: 10, x: 100, remPx }), 'body', 'the left of a short note is still its body');
});

test('lockDrag is true once the pointer has moved a quarter of a rem, in any direction', () => {
  const thresholdPx = gesture.DRAG_THRESHOLD_REM * REM;
  assert.equal(thresholdPx, 4);
  assert.equal(gesture.lockDrag({ dx: 0, dy: 0, thresholdPx }), false);
  assert.equal(gesture.lockDrag({ dx: 3.9, dy: 0, thresholdPx }), false);
  assert.equal(gesture.lockDrag({ dx: 4, dy: 0, thresholdPx }), true);
  assert.equal(gesture.lockDrag({ dx: 0, dy: -4, thresholdPx }), true);
  assert.equal(gesture.lockDrag({ dx: 3, dy: 3, thresholdPx }), true);
  assert.equal(gesture.lockDrag({ dx: -2, dy: 2, thresholdPx }), false);
});

test('edgeScrollPx scrolls by one rem toward an edge once the pointer is within a rem and a half of it, and by nothing elsewhere', () => {
  const box = { left: 100, right: 900, remPx: REM };
  assert.equal(gesture.edgeScrollPx({ ...box, x: 500 }), 0);
  assert.equal(gesture.edgeScrollPx({ ...box, x: 125 }), 0, 'just outside the zone of 24 pixels');
  assert.equal(gesture.edgeScrollPx({ ...box, x: 124 }), -16);
  assert.equal(gesture.edgeScrollPx({ ...box, x: 100 }), -16);
  assert.equal(gesture.edgeScrollPx({ ...box, x: 40 }), -16, 'past the edge still scrolls toward it');
  assert.equal(gesture.edgeScrollPx({ ...box, x: 875 }), 0);
  assert.equal(gesture.edgeScrollPx({ ...box, x: 876 }), 16);
  assert.equal(gesture.edgeScrollPx({ ...box, x: 950 }), 16);
});

test('edgeScrollPx follows the root font size and gives nothing for a box with no width', () => {
  assert.equal(gesture.edgeScrollPx({ left: 0, right: 800, x: 30, remPx: 20 }), -20);
  assert.equal(gesture.edgeScrollPx({ left: 0, right: 800, x: 31, remPx: 20 }), 0);
  assert.equal(gesture.edgeScrollPx({ left: 0, right: 0, x: 0, remPx: REM }), 0);
  assert.equal(gesture.edgeScrollPx({ left: 50, right: 20, x: 30, remPx: REM }), 0);
});

test('edgeScrollPx in a box so narrow that both zones hold the pointer goes to the nearer edge', () => {
  assert.equal(gesture.edgeScrollPx({ left: 0, right: 40, x: 10, remPx: REM }), -16);
  assert.equal(gesture.edgeScrollPx({ left: 0, right: 40, x: 30, remPx: REM }), 16);
});

test('beatWidthRem is the room divided by the beats, at least 4 rem, with no upper cap', () => {
  assert.equal(gesture.beatWidthRem({ availableRem: 48, beats: 8 }), 6);
  assert.equal(gesture.beatWidthRem({ availableRem: 100, beats: 8 }), 12.5, 'a short motif takes all the width');
  assert.equal(gesture.beatWidthRem({ availableRem: 32, beats: 8 }), 4);
  assert.equal(gesture.beatWidthRem({ availableRem: 20, beats: 8 }), 4, 'less room than that scrolls instead of squeezing');
  assert.equal(gesture.beatWidthRem({ availableRem: 100, beats: 32 }), 4);
});

test('beatWidthRem takes its minimum as a parameter: 4 rem for the motif, 2.5 rem while the live view shows 8 cycles', () => {
  assert.equal(gesture.BEAT_MIN_REM, 4);
  assert.equal(gesture.LIVE_BEAT_MIN_REM, 2.5);
  assert.equal(gesture.beatWidthRem({ availableRem: 20, beats: 8, minRem: gesture.LIVE_BEAT_MIN_REM }), 2.5);
  assert.equal(gesture.beatWidthRem({ availableRem: 160, beats: 32, minRem: gesture.LIVE_BEAT_MIN_REM }), 5);
  assert.equal(gesture.beatWidthRem({ availableRem: 20, beats: 8, minRem: gesture.BEAT_MIN_REM }), 4);
});

test('rowHeightRem is the room divided by the rows, held from 0.625 rem to 1.25 rem', () => {
  assert.equal(gesture.rowHeightRem({ availableRem: 30, rows: 24 }), 1.25);
  assert.equal(gesture.rowHeightRem({ availableRem: 24, rows: 24 }), 1);
  assert.equal(gesture.rowHeightRem({ availableRem: 30, rows: 48 }), 0.625);
  assert.equal(gesture.rowHeightRem({ availableRem: 30, rows: 108 }), 0.625, 'the box then scrolls');
  assert.equal(gesture.rowHeightRem({ availableRem: 12, rows: 24 }), 0.625);
  assert.equal(gesture.rowHeightRem({ availableRem: 100, rows: 24 }), 1.25);
  assert.equal(gesture.rowHeightRem({ availableRem: 0, rows: 24 }), 0.625);
});

test('the piano names column is 3 rem wide', () => {
  assert.equal(gesture.GUTTER_REM, 4.5);
});

// --- The velocity lane ---

// A lane 56 pixels high whose bars area starts at 100, 400 and is 960 pixels wide for 96 units (10 pixels a unit).
const LANE = { left: 100, top: 400, width: 960, height: 56 };

test('velocityAt is the height above the lane\'s bottom as a share of its height, in whole hundredths held from 1 to 100', () => {
  assert.equal(gesture.velocityAt({ rect: LANE, y: 456 }), 1, 'the bottom edge');
  assert.equal(gesture.velocityAt({ rect: LANE, y: 400 }), 100, 'the top edge');
  assert.equal(gesture.velocityAt({ rect: LANE, y: 428 }), 50);
  assert.equal(gesture.velocityAt({ rect: LANE, y: 300 }), 100, 'above the lane');
  assert.equal(gesture.velocityAt({ rect: LANE, y: 900 }), 1, 'below the lane');
  assert.equal(gesture.velocityAt({ rect: { ...LANE, height: 100 }, y: 480 }), 20);
  assert.ok(Number.isInteger(gesture.velocityAt({ rect: LANE, y: 437.3 })));
});

test('a bar takes at least 0.375 rem of its column, so a chord on narrow steps still has a bar each', () => {
  assert.equal(gesture.BAR_SLOT_REM, 0.375);
});

test('barAt finds the bar of the column under the pointer and, in a chord, the bar of the sub-column', () => {
  const bars = [
    { id: 1, start: 0, slot: 0, slots: 1 },
    { id: 2, start: 6, slot: 0, slots: 2 },
    { id: 3, start: 6, slot: 1, slots: 2 },
  ];
  const at = (x) => gesture.barAt({ rect: LANE, x, bars, units: 96, gridUnit: 3, remPx: REM });
  assert.equal(at(100), 1);
  assert.equal(at(129), 1, 'the whole column of a step answers');
  assert.equal(at(130), null, 'the next step holds no bar');
  assert.equal(at(160), 2);
  assert.equal(at(174), 2);
  assert.equal(at(175), 3);
  assert.equal(at(189), 3);
  assert.equal(at(190), null);
  assert.equal(at(50), null, 'left of the lane');
});

test('barAt keeps a narrow chord apart: a sub-column is never narrower than 0.375 rem', () => {
  const bars = [0, 1, 2, 3].map((slot) => ({ id: slot + 1, start: 0, slot, slots: 4 }));
  const narrow = { rect: { left: 0, top: 0, width: 96, height: 56 }, bars, units: 96, gridUnit: 3, remPx: REM };
  // A step is 3 pixels wide here, but each bar keeps 6 pixels: the chord spreads to the right.
  assert.deepEqual([0, 5, 6, 11, 12, 17, 18, 23, 24].map((x) => gesture.barAt({ ...narrow, x })), [1, 1, 2, 2, 3, 3, 4, 4, null]);
});

test('selectionBox gives the units and the rows a drag spans, whichever way it goes', () => {
  const box = (x0, y0, x1, y1) => gesture.selectionBox({ rect: RECT, x0, y0, x1, y1, units: 96, rows: 24 });
  assert.deepEqual(box(200, 100, 400, 200), { fromUnit: 10, toUnit: 30, topRow: 5, bottomRow: 15 });
  assert.deepEqual(box(400, 200, 200, 100), { fromUnit: 10, toUnit: 30, topRow: 5, bottomRow: 15 }, 'the same box dragged back');
  assert.deepEqual(box(400, 100, 200, 200), { fromUnit: 10, toUnit: 30, topRow: 5, bottomRow: 15 }, 'and across the other diagonal');
  assert.deepEqual(box(215, 107.5, 230, 112.5), { fromUnit: 11.5, toUnit: 13, topRow: 5.75, bottomRow: 6.25 }, 'fractions are kept');
});

test('selectionBox holds the box inside the grid, whatever the pointer did', () => {
  const box = gesture.selectionBox({ rect: RECT, x0: 50, y0: 10, x1: 2000, y1: 900, units: 96, rows: 24 });
  assert.deepEqual(box, { fromUnit: 0, toUnit: 96, topRow: 0, bottomRow: 24 });
});

test('selectionBox follows the row count it is given, so a taller roll needs no new signature', () => {
  const tall = { left: 0, top: 0, width: 960, height: 480 };
  assert.deepEqual(gesture.selectionBox({ rect: tall, x0: 0, y0: 0, x1: 100, y1: 100, units: 96, rows: 48 }), { fromUnit: 0, toUnit: 10, topRow: 0, bottomRow: 10 });
});

test('notesInBox gives the ids of the notes whose span and row the box touches, and none for a box over empty cells', () => {
  const notes = [
    { id: 1, pitch: 71, start: 0, length: 3 },
    { id: 2, pitch: 69, start: 30, length: 12 },
    { id: 3, pitch: 60, start: 30, length: 3 },
    { id: 4, pitch: 48, start: 90, length: 6 },
  ];
  const inBox = (box) => gesture.notesInBox({ notes, box, high: 71 });
  assert.deepEqual(inBox({ fromUnit: 0, toUnit: 96, topRow: 0, bottomRow: 24 }), [1, 2, 3, 4], 'the whole grid');
  assert.deepEqual(inBox({ fromUnit: 28, toUnit: 32, topRow: 1.5, bottomRow: 2.5 }), [2], 'one note, in its row and its span');
  assert.deepEqual(inBox({ fromUnit: 28, toUnit: 32, topRow: 0, bottomRow: 24 }), [2, 3], 'a column of the grid');
  assert.deepEqual(inBox({ fromUnit: 50, toUnit: 80, topRow: 0, bottomRow: 24 }), [], 'empty cells');
  assert.deepEqual(inBox({ fromUnit: 31, toUnit: 31, topRow: 11.5, bottomRow: 11.5 }), [3], 'a box with no size still touches the note under it');
  assert.deepEqual(inBox({ fromUnit: 3, toUnit: 30, topRow: 0, bottomRow: 24 }), [], 'a note ending where the box starts is not touched');
  assert.deepEqual(inBox({ fromUnit: 0, toUnit: 96, topRow: 3, bottomRow: 10 }), [], 'rows with no note');
});

test('groupMoveTarget snaps the start like moveTarget and holds the whole group inside the motif', () => {
  const notes = [
    { id: 1, pitch: 60, start: 12, length: 9 },
    { id: 2, pitch: 64, start: 30, length: 6 },
  ];
  const target = (dUnits, dRows) => gesture.groupMoveTarget({ notes, dUnits, dRows, gridUnit: 3, units: 96, low: 48, high: 71 });
  assert.deepEqual(target(0, 0), { dStart: 0, dPitch: 0 });
  assert.deepEqual(target(7.4, 0), { dStart: 6, dPitch: 0 }, 'the nearest line');
  assert.deepEqual(target(7.5, 0), { dStart: 6, dPitch: 0 }, 'a tie goes to the earlier line');
  assert.deepEqual(target(7.6, 0), { dStart: 9, dPitch: 0 });
  assert.deepEqual(target(-100, 0), { dStart: -12, dPitch: 0 }, 'the earliest note stops at 0');
  assert.deepEqual(target(100, 0), { dStart: 60, dPitch: 0 }, 'the latest end stops at the motif end: 96 - 36');
  assert.deepEqual(target(0, 2), { dStart: 0, dPitch: -2 }, 'two rows down is two semitones lower');
  assert.deepEqual(target(0, -3), { dStart: 0, dPitch: 3 });
});

test('groupMoveTarget holds every pitch of the group between the shown rows, and never forces notes that are outside them', () => {
  const notes = [{ id: 1, pitch: 50, start: 0, length: 3 }, { id: 2, pitch: 70, start: 6, length: 3 }];
  const target = (dRows, extra = {}) => gesture.groupMoveTarget({ notes, dUnits: 0, dRows, gridUnit: 3, units: 96, low: 48, high: 71, ...extra });
  assert.deepEqual(target(-10), { dStart: 0, dPitch: 1 }, 'the highest note stops on the top row');
  assert.deepEqual(target(10), { dStart: 0, dPitch: -2 }, 'the lowest note stops on the bottom row');
  const outside = [{ id: 1, pitch: 40, start: 0, length: 3 }, { id: 2, pitch: 80, start: 6, length: 3 }];
  const free = (dRows) => gesture.groupMoveTarget({ notes: outside, dUnits: 0, dRows, gridUnit: 3, units: 96, low: 48, high: 71 });
  assert.deepEqual(free(0), { dStart: 0, dPitch: 0 }, 'notes outside the rows are not pulled in');
  assert.deepEqual(free(-5), { dStart: 0, dPitch: 0 }, 'a group above the top cannot go higher');
  assert.deepEqual(free(5), { dStart: 0, dPitch: 0 }, 'and a group below the bottom cannot go lower');
});

test('groupMoveTarget with one note gives the same place as moveTarget', () => {
  const note = { id: 1, pitch: 60, start: 12, length: 9 };
  for (const [dUnits, dRows] of [[0, 0], [7.4, 1], [-100, -2], [100, 30], [33.3, -40]]) {
    const single = gesture.moveTarget({ note, dUnits, dRows, gridUnit: 3, units: 96, low: 48, high: 71 });
    const group = gesture.groupMoveTarget({ notes: [note], dUnits, dRows, gridUnit: 3, units: 96, low: 48, high: 71 });
    assert.deepEqual({ start: note.start + group.dStart, pitch: note.pitch + group.dPitch }, single, `${dUnits}, ${dRows}`);
  }
});

// The visible band between the ruler and the lane is 20 to 300 (280 pixels) and a row is 10 pixels high.
const BAND = { rowHeight: 10, visibleTop: 20, visibleBottom: 300 };

test('historyScroll brings the cursor row and the touched rows in with the smallest move when they fit the band', () => {
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [330], cursorTop: 210 }), { by: 40, nearest: 0 }, 'the span ends 40 below the band');
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [-40], cursorTop: -40 }), { by: -60, nearest: 0 }, 'the span starts 60 above the band');
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [100, 150], cursorTop: 120 }), { by: 0, nearest: 0 }, 'everything is already inside');
});

test('historyScroll puts the cursor row at the band edge that leaves room for the nearest row when everything does not fit', () => {
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [350, 590], cursorTop: 110 }), { by: 90, nearest: 0 }, 'nearest below: the cursor row goes to the top edge');
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [-300, 0], cursorTop: 250 }), { by: -40, nearest: 1 }, 'nearest above: the cursor row goes to the bottom edge');
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [100, -300, -200, 500], cursorTop: 100 }), { by: -190, nearest: 0 }, 'nearest on the cursor row with more rows above: the bottom edge');
});

test('historyScroll gives no move when the cursor row and the nearest row cannot share the band, so the caller moves the cursor', () => {
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [380], cursorTop: 20 }), { by: null, nearest: 0 });
});

test('historyScroll with no rows to show only brings the cursor row in, and a tie for nearest goes to the lower index', () => {
  assert.deepEqual(gesture.historyScroll({ ...BAND, tops: [], cursorTop: 310 }), { by: 20, nearest: null });
  assert.equal(gesture.historyScroll({ ...BAND, tops: [100, 140], cursorTop: 120 }).nearest, 0);
});

test('historyScroll refuses a row with no height and a band with no height, loudly', () => {
  assert.throws(() => gesture.historyScroll({ ...BAND, rowHeight: 0, tops: [100], cursorTop: 100 }), /^Error: Moontide: /);
  assert.throws(() => gesture.historyScroll({ ...BAND, visibleBottom: 20, tops: [100], cursorTop: 100 }), /^Error: Moontide: /);
});
