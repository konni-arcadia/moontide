// The numbers behind a pointer on the Timeline lanes: which drawn note a press is on, tested with plain numbers and no browser.
// Distances are in rem; the tests read the root as 16 pixels, so a rem is 16 pixels here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAG_THRESHOLD_REM,
  HIT_TOLERANCE_REM,
  NOTE_MARK_HEIGHT,
  SEMITONE_REM,
  STEP_GATHER_MS,
  LANE_KEYS,
  createStepGatherer,
  laneMove,
  lockGesture,
  noteBoxes,
  pickNote,
  rangeCycles,
  semitonesFrom,
} from '../page/timeline-gesture.js';

const REM = 16;
const TOLERANCE = HIT_TOLERANCE_REM * REM;

// A lane's event area 3200 pixels wide (100 pixels a cycle) and 100 pixels high, 100 pixels from the left and 20 from the top.
const RECT = { left: 100, top: 20, width: 3200, height: 100 };

test('the numbers of a press are written in rem: a quarter to tell a click from a drag, half around a note', () => {
  assert.equal(DRAG_THRESHOLD_REM, 0.25);
  assert.equal(HIT_TOLERANCE_REM, 0.5);
  assert.equal(NOTE_MARK_HEIGHT, 0.14);
  assert.equal(SEMITONE_REM, 0.5);
});

test('noteBoxes places each note where it is drawn and gives a tick no box', () => {
  const shapes = [
    { kind: 'note', x: 0, width: 1, y: 0.5 },
    { kind: 'tick', x: 1, width: 1 },
    { kind: 'note', x: 2.5, width: 0.05, y: 0 },
    { kind: 'note', x: 3, width: 1, y: 1 },
  ];
  const [middle, tick, top, bottom] = noteBoxes({ rect: RECT, shapes, rowCount: null, markHeight: NOTE_MARK_HEIGHT });
  assert.equal(tick, null);
  assert.deepEqual(middle, { left: 100, right: 200, top: 20 + 43, bottom: 20 + 57 });
  // The mark stays inside the lane at the highest and the lowest pitch.
  assert.deepEqual({ top: top.top, bottom: top.bottom }, { top: 20, bottom: 34 });
  assert.equal(top.left, 350);
  assert.equal(top.right, 355);
  assert.ok(Math.abs(bottom.top - (20 + 86)) < 1e-9);
  assert.ok(Math.abs(bottom.bottom - 120) < 1e-9);
});

test('noteBoxes gives a drum lane one band for each row from the row and the number of rows', () => {
  const shapes = [{ x: 0, width: 1, row: 0 }, { x: 1, width: 1, row: 1 }];
  const [first, second] = noteBoxes({ rect: RECT, shapes, rowCount: 2, markHeight: NOTE_MARK_HEIGHT });
  // A row is half the lane high; the mark is half of its row, a quarter of the row from the top.
  assert.deepEqual({ top: first.top, bottom: first.bottom }, { top: 20 + 12.5, bottom: 20 + 37.5 });
  assert.deepEqual({ top: second.top, bottom: second.bottom }, { top: 20 + 62.5, bottom: 20 + 87.5 });
  assert.deepEqual({ left: second.left, right: second.right }, { left: 200, right: 300 });
});

/** Pixel boxes of three notes: two stacked at the same time (a chord) and one apart. */
function chord() {
  const boxes = [
    { left: 100, right: 120, top: 40, bottom: 54 },
    { left: 100, right: 120, top: 60, bottom: 74 },
    { left: 400, right: 420, top: 40, bottom: 54 },
  ];
  return { boxes, pitches: [60, 48, 60] };
}

test('pickNote takes the note whose box the press is in', () => {
  const { boxes, pitches } = chord();
  assert.equal(pickNote({ boxes, pitches, x: 110, y: 47, tolerancePx: TOLERANCE }), 0);
  assert.equal(pickNote({ boxes, pitches, x: 110, y: 67, tolerancePx: TOLERANCE }), 1);
  assert.equal(pickNote({ boxes, pitches, x: 410, y: 47, tolerancePx: TOLERANCE }), 2);
});

test('pickNote takes a press within half a rem of a thin mark in both directions, and nothing farther', () => {
  const { boxes, pitches } = chord();
  // 7 pixels above the first box and 7 to the left of it: inside the 8 pixel tolerance in both directions.
  assert.equal(pickNote({ boxes, pitches, x: 93, y: 33, tolerancePx: TOLERANCE }), 0);
  // 0.6 rem (9.6 pixels) above a mark is empty lane area.
  assert.equal(pickNote({ boxes, pitches, x: 410, y: 40 - 0.6 * REM, tolerancePx: TOLERANCE }), null);
  assert.equal(pickNote({ boxes, pitches, x: 120 + 0.6 * REM, y: 47, tolerancePx: TOLERANCE }), null);
  assert.equal(pickNote({ boxes, pitches, x: 250, y: 47, tolerancePx: TOLERANCE }), null);
});

test('of two notes within reach the nearer wins, and an equal distance goes to the lower pitch', () => {
  const { boxes, pitches } = chord();
  // Between the two stacked notes (a gap of 6 pixels): 3 pixels from each box edge, so a tie, and the lower pitch is box 1.
  assert.equal(pickNote({ boxes, pitches, x: 110, y: 57, tolerancePx: TOLERANCE }), 1);
  // Nearer to the upper one.
  assert.equal(pickNote({ boxes, pitches, x: 110, y: 55, tolerancePx: TOLERANCE }), 0);
  // The tie goes the same way whatever the order the notes come in.
  const swapped = pickNote({ boxes: [boxes[1], boxes[0]], pitches: [pitches[1], pitches[0]], x: 110, y: 57, tolerancePx: TOLERANCE });
  assert.equal(swapped, 0);
});

test('pickNote skips a tick and finds nothing on a lane with no notes', () => {
  assert.equal(pickNote({ boxes: [null, { left: 0, right: 10, top: 0, bottom: 10 }], pitches: [0, 60], x: 5, y: 5, tolerancePx: TOLERANCE }), 1);
  assert.equal(pickNote({ boxes: [null], pitches: [0], x: 5, y: 5, tolerancePx: TOLERANCE }), null);
  assert.equal(pickNote({ boxes: [], pitches: [], x: 5, y: 5, tolerancePx: TOLERANCE }), null);
});

const THRESHOLD = DRAG_THRESHOLD_REM * REM;

test('a press that has not moved a quarter of a rem has no gesture yet, on a note or off it', () => {
  assert.equal(lockGesture({ dx: 0, dy: 0, onNote: true, thresholdPx: THRESHOLD }), null);
  assert.equal(lockGesture({ dx: 3, dy: 0, onNote: true, thresholdPx: THRESHOLD }), null);
  assert.equal(lockGesture({ dx: 0, dy: -3.9, onNote: false, thresholdPx: THRESHOLD }), null);
  // The travel is the straight distance, so a diagonal of 3 and 3 (4.2 pixels) is past the 4 pixels.
  assert.equal(lockGesture({ dx: 3, dy: 3, onNote: true, thresholdPx: THRESHOLD }), 'pitch');
});

test('on a note the larger travel decides: vertical is a pitch drag, horizontal a range, equal travel a pitch drag', () => {
  assert.equal(lockGesture({ dx: 3, dy: 10, onNote: true, thresholdPx: THRESHOLD }), 'pitch');
  assert.equal(lockGesture({ dx: 3, dy: -10, onNote: true, thresholdPx: THRESHOLD }), 'pitch');
  assert.equal(lockGesture({ dx: 10, dy: 3, onNote: true, thresholdPx: THRESHOLD }), 'range');
  assert.equal(lockGesture({ dx: -10, dy: 3, onNote: true, thresholdPx: THRESHOLD }), 'range');
  assert.equal(lockGesture({ dx: 5, dy: 5, onNote: true, thresholdPx: THRESHOLD }), 'pitch');
  assert.equal(lockGesture({ dx: -5, dy: 5, onNote: true, thresholdPx: THRESHOLD }), 'pitch');
});

test('on empty lane area any travel is a range', () => {
  assert.equal(lockGesture({ dx: 1, dy: 10, onNote: false, thresholdPx: THRESHOLD }), 'range');
  assert.equal(lockGesture({ dx: 10, dy: 1, onNote: false, thresholdPx: THRESHOLD }), 'range');
  assert.equal(lockGesture({ dx: 0, dy: -10, onNote: false, thresholdPx: THRESHOLD }), 'range');
});

test('semitonesFrom counts whole steps, up is higher and no travel is zero, never negative zero', () => {
  assert.equal(semitonesFrom({ dy: -17, stepPx: 8 }), 2);
  assert.equal(semitonesFrom({ dy: -7, stepPx: 8 }), 0);
  assert.equal(semitonesFrom({ dy: 8, stepPx: 8 }), -1);
  assert.equal(semitonesFrom({ dy: 15, stepPx: 8 }), -1);
  assert.equal(semitonesFrom({ dy: -16, stepPx: 8 }), 2);
  assert.ok(Object.is(semitonesFrom({ dy: 0, stepPx: 8 }), 0));
  assert.ok(Object.is(semitonesFrom({ dy: 5, stepPx: 8 }), 0), 'a part of a step down is 0, not -0');
  assert.ok(Object.is(semitonesFrom({ dy: -5, stepPx: 8 }), 0));
  // The step of the page is half a rem.
  assert.equal(semitonesFrom({ dy: -1.1 * REM, stepPx: SEMITONE_REM * REM }), 2);
});

// --- the step gatherer, on a manual clock ---

/** A gatherer whose timers run on a clock the test moves; `flushed` lists what it wrote and `errors` what it reported. */
function gatherer({ throwOn = null } = {}) {
  let clock = 0;
  let next = 1;
  const timers = new Map();
  const flushed = [];
  const errors = [];
  const g = createStepGatherer({
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    delayMs: STEP_GATHER_MS,
    onFlush: (kind, total) => {
      flushed.push([kind, total]);
      if (throwOn !== null && flushed.length === throwOn) throw new Error('the write failed');
    },
    onError: (error) => errors.push(error.message),
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock && timers.has(id)) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { g, flushed, errors, advance, timers };
}

test('the steps of a key or a button gather for 600 milliseconds, the pause of the contract', () => {
  assert.equal(STEP_GATHER_MS, 600);
});

test('three steps within the pause write once, with their total, after the pause that follows the last', () => {
  const t = gatherer();
  t.g.step('pitch', 1);
  t.advance(400);
  t.g.step('pitch', 1);
  t.advance(400);
  t.g.step('pitch', 1);
  assert.deepEqual(t.g.pending(), { kind: 'pitch', total: 3 });
  t.advance(599);
  assert.deepEqual(t.flushed, []);
  t.advance(1);
  assert.deepEqual(t.flushed, [['pitch', 3]]);
  assert.equal(t.g.pending(), null);
  t.advance(5000);
  assert.deepEqual(t.flushed, [['pitch', 3]], 'one write for the burst');
});

test('a step of the other kind writes the pending one at once and starts a burst of its own', () => {
  const t = gatherer();
  t.g.step('pitch', 1);
  t.g.step('pitch', 12);
  t.g.step('velocity', -1);
  assert.deepEqual(t.flushed, [['pitch', 13]]);
  assert.deepEqual(t.g.pending(), { kind: 'velocity', total: -1 });
  t.advance(600);
  assert.deepEqual(t.flushed, [['pitch', 13], ['velocity', -1]]);
});

test('drop forgets the pending steps and no write follows; flush writes them now', () => {
  const t = gatherer();
  t.g.step('pitch', 2);
  t.g.drop();
  assert.equal(t.g.pending(), null);
  assert.equal(t.timers.size, 0);
  t.advance(2000);
  assert.deepEqual(t.flushed, []);
  t.g.step('velocity', 1);
  t.g.flush();
  assert.deepEqual(t.flushed, [['velocity', 1]]);
  assert.equal(t.timers.size, 0);
  t.g.flush();
  assert.deepEqual(t.flushed, [['velocity', 1]], 'nothing pending: nothing written');
});

test('a total of zero never writes', () => {
  const t = gatherer();
  t.g.step('pitch', 1);
  t.g.step('pitch', -1);
  assert.deepEqual(t.g.pending(), { kind: 'pitch', total: 0 });
  t.advance(600);
  assert.deepEqual(t.flushed, []);
  t.g.step('pitch', 5);
  t.g.step('pitch', -5);
  t.g.flush();
  assert.deepEqual(t.flushed, []);
});

test('a write that throws is reported and the gatherer keeps working', () => {
  const t = gatherer({ throwOn: 1 });
  t.g.step('pitch', 1);
  t.advance(600);
  assert.deepEqual(t.errors, ['the write failed']);
  t.g.step('pitch', 2);
  t.advance(600);
  assert.deepEqual(t.flushed, [['pitch', 1], ['pitch', 2]]);
});

test('the gatherer is never entered again from its own flush: a burst handed over is the caller\'s, and a step of another kind never joins it', () => {
  const flushed = [];
  const errors = [];
  let again = null;
  const g = createStepGatherer({
    setTimer: () => 1,
    clearTimer: () => {},
    onFlush: (kind, total) => {
      flushed.push([kind, total]);
      if (again !== null) again(g);
    },
    onError: (error) => errors.push(error.message),
  });
  // A flush that tries to keep its steps by stepping them again is refused loudly, and the burst is not taken back.
  again = (gatherer) => gatherer.step('pitch', 3);
  g.step('pitch', 3);
  g.flush();
  assert.deepEqual(errors, ["Moontide: the step gatherer's step was called from inside its own flush."]);
  assert.equal(g.pending(), null);
  // A step of the other kind that makes the pitch burst flush starts its own burst: nothing of one kind is added to the other.
  again = null;
  g.step('pitch', 3);
  g.step('velocity', 1);
  assert.deepEqual(flushed, [['pitch', 3], ['pitch', 3]]);
  assert.deepEqual(g.pending(), { kind: 'velocity', total: 1 });
  g.drop();
  for (const name of ['flush', 'drop']) {
    errors.length = 0;
    again = (gatherer) => gatherer[name]();
    g.step('pitch', 2);
    g.flush();
    assert.deepEqual(errors, [`Moontide: the step gatherer's ${name} was called from inside its own flush.`]);
  }
});

test('a gatherer without what it needs, and a step that is not a whole number other than 0, throw', () => {
  assert.throws(() => createStepGatherer({ clearTimer() {}, onFlush() {} }), /needs setTimer/);
  assert.throws(() => createStepGatherer({ setTimer() {}, onFlush() {} }), /needs clearTimer/);
  assert.throws(() => createStepGatherer({ setTimer() {}, clearTimer() {} }), /needs onFlush/);
  const t = gatherer();
  assert.throws(() => t.g.step('pitch', 0), /whole number other than 0/);
  assert.throws(() => t.g.step('pitch', 0.5), /whole number other than 0/);
  assert.throws(() => t.g.step('', 1), /kind/);
});

test('rangeCycles: the cycle under the press and the cycle under the pointer, both included, whichever way the drag goes', () => {
  assert.deepEqual(rangeCycles({ pageStart: 32, pressFraction: 0.1, pointerFraction: 0.02 }), { from: 32, to: 35, cut: null });
  assert.deepEqual(rangeCycles({ pageStart: 32, pressFraction: 0.02, pointerFraction: 0.1 }), { from: 32, to: 35, cut: null });
  // A press that has not left its cycle is one cycle.
  assert.deepEqual(rangeCycles({ pageStart: 0, pressFraction: 0.51, pointerFraction: 0.52 }), { from: 16, to: 16, cut: null });
  // The cycle lines: 1/32 is the start of cycle 1.
  assert.deepEqual(rangeCycles({ pageStart: 0, pressFraction: 1 / 32 - 1e-9, pointerFraction: 1 / 32 }), { from: 0, to: 1, cut: null });
});

test('rangeCycles: a pointer that left the event area is held at the first or last cycle of the page and the range says it was cut', () => {
  assert.deepEqual(rangeCycles({ pageStart: 32, pressFraction: 0.1, pointerFraction: -0.2 }), { from: 32, to: 35, cut: { from: 32, to: 35 } });
  assert.deepEqual(rangeCycles({ pageStart: 32, pressFraction: 0.1, pointerFraction: 1.5 }), { from: 35, to: 63, cut: { from: 35, to: 63 } });
  // The edges themselves are inside the area: no cut.
  assert.equal(rangeCycles({ pageStart: 0, pressFraction: 0.5, pointerFraction: 0 }).cut, null);
  assert.deepEqual(rangeCycles({ pageStart: 0, pressFraction: 0.5, pointerFraction: 1 }), { from: 16, to: 31, cut: null });
  // A range never covers more than a page.
  const widest = rangeCycles({ pageStart: 64, pressFraction: 0, pointerFraction: 9 });
  assert.equal(widest.to - widest.from + 1, 32);
});

test('rangeCycles: a fraction that is not a finite number is a loud TypeError', () => {
  assert.throws(() => rangeCycles({ pageStart: 0, pressFraction: NaN, pointerFraction: 0.5 }), TypeError);
  assert.throws(() => rangeCycles({ pageStart: 0, pressFraction: 0.5, pointerFraction: undefined }), TypeError);
});

// --- the keyboard moves ---

// Three lanes: lane 0 has a chord at cycle 2 (written high note first), a tick and notes at 5 and 9; lane 1 has no notes; lane 2
// has notes at 1, 4 and 4.5.
const KEY_LANES = [
  [{ begin: 2, pitch: 55 }, { begin: 2, pitch: 48 }, null, { begin: 5, pitch: 50 }, { begin: 9, pitch: 52 }],
  [],
  [{ begin: 1, pitch: 40 }, { begin: 4, pitch: 41 }, { begin: 4.5, pitch: 42 }],
];
const go = (at, key, lanes = KEY_LANES) => laneMove({ lanes, at, key });

test('laneMove: the keys are the six of the keyboard model, and any other key throws', () => {
  assert.deepEqual([...LANE_KEYS], ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  assert.throws(() => go(null, 'ArrowUp'), /unknown key 'ArrowUp'/);
  assert.throws(() => laneMove({ lanes: 'x', at: null, key: 'Home' }), /array of lanes/);
});

test('laneMove: with nothing selected Right takes the first note of the first lane that has one and Left the last note of that lane', () => {
  assert.deepEqual(go(null, 'ArrowRight'), { laneIndex: 0, eventIndex: 1, cycle: 2 });
  assert.deepEqual(go(null, 'ArrowLeft'), { laneIndex: 0, eventIndex: 4, cycle: 9 });
  // The first lane without notes is passed over.
  assert.deepEqual(go(null, 'ArrowRight', [[], [], [{ begin: 3, pitch: 40 }]]), { laneIndex: 2, eventIndex: 0, cycle: 3 });
  assert.deepEqual(go(null, 'ArrowRight', [[], [null]]), null);
  assert.deepEqual(go(null, 'ArrowRight', []), null);
});

test('laneMove: Home, End, Page Up and Page Down need a place; with none they are not for the Timeline', () => {
  for (const key of ['Home', 'End', 'PageUp', 'PageDown']) assert.equal(go(null, key), null, key);
});

test('laneMove: Left and Right walk by start, then pitch lower first, and stop at the first and the last note', () => {
  // The chord at cycle 2: the lower note (index 1) comes before the higher (index 0), then the next start.
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 1 }, 'ArrowRight'), { laneIndex: 0, eventIndex: 0, cycle: 2 });
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 0 }, 'ArrowRight'), { laneIndex: 0, eventIndex: 3, cycle: 5 });
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 3 }, 'ArrowLeft'), { laneIndex: 0, eventIndex: 0, cycle: 2 });
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 0 }, 'ArrowLeft'), { laneIndex: 0, eventIndex: 1, cycle: 2 });
  // The tick (index 2) is never visited, and the ends stay where they are.
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 4 }, 'ArrowRight'), { laneIndex: 0, eventIndex: 4, cycle: 9 });
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 1 }, 'ArrowLeft'), { laneIndex: 0, eventIndex: 1, cycle: 2 });
});

test('laneMove: Home and End take the first and the last note of the lane', () => {
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 3 }, 'Home'), { laneIndex: 0, eventIndex: 1, cycle: 2 });
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 3 }, 'End'), { laneIndex: 0, eventIndex: 4, cycle: 9 });
  assert.deepEqual(go({ laneIndex: 2, eventIndex: 1 }, 'End'), { laneIndex: 2, eventIndex: 2, cycle: 4 });
});

test('laneMove: Page Down and Page Up keep the cycle and take the note nearest in time', () => {
  // From cycle 5 the nearest start on lane 2 is 4.5, which lies in cycle 4.
  assert.deepEqual(go({ laneIndex: 1, eventIndex: null, cycle: 5 }, 'PageDown'), { laneIndex: 2, eventIndex: 2, cycle: 4 });
  assert.deepEqual(go({ laneIndex: 1, eventIndex: null, cycle: 1 }, 'PageDown'), { laneIndex: 2, eventIndex: 0, cycle: 1 });
  assert.deepEqual(go({ laneIndex: 2, eventIndex: 2 }, 'PageUp'), { laneIndex: 1, eventIndex: null, cycle: 4 });
  assert.deepEqual(go({ laneIndex: 1, eventIndex: null, cycle: 9 }, 'PageUp'), { laneIndex: 0, eventIndex: 4, cycle: 9 });
  // Two notes as near as each other: the earlier start wins.
  assert.deepEqual(go({ laneIndex: 1, eventIndex: null, cycle: 3 }, 'PageUp'), { laneIndex: 0, eventIndex: 1, cycle: 2 });
  assert.deepEqual(go({ laneIndex: 1, eventIndex: null, cycle: 7 }, 'PageUp'), { laneIndex: 0, eventIndex: 3, cycle: 5 });
});

test('laneMove: Page Down onto a lane with no notes gives the cursor at the same cycle; the first and last lane stay', () => {
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 3 }, 'PageDown'), { laneIndex: 1, eventIndex: null, cycle: 5 });
  assert.deepEqual(go({ laneIndex: 0, eventIndex: 3 }, 'PageUp'), { laneIndex: 0, eventIndex: 3, cycle: 5 });
  assert.deepEqual(go({ laneIndex: 2, eventIndex: 0 }, 'PageDown'), { laneIndex: 2, eventIndex: 0, cycle: 1 });
});

test('laneMove: the cursor of a lane without notes has no note to walk along, and a start just under a cycle counts as that cycle', () => {
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.deepEqual(go({ laneIndex: 1, eventIndex: null, cycle: 6 }, key), { laneIndex: 1, eventIndex: null, cycle: 6 }, key);
  assert.equal(go({ laneIndex: 0, eventIndex: 0 }, 'Home', [[{ begin: 6.9999999999, pitch: 40 }]]).cycle, 7);
});

test('laneMove: a place that names no lane or no walkable note throws', () => {
  assert.throws(() => go({ laneIndex: 5, eventIndex: 0 }, 'Home'), /no lane 5/);
  assert.throws(() => go({ laneIndex: 0, eventIndex: 2 }, 'Home'), /no note 2 to walk/);
  assert.throws(() => go({ laneIndex: 0, eventIndex: 9 }, 'Home'), /no note 9 to walk/);
  assert.throws(() => go({ laneIndex: 1, eventIndex: null }, 'Home'), /needs its cycle/);
});
