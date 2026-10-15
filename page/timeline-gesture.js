// Pure module for Moontide's browser page: the numbers behind a pointer on the Timeline lanes. Distances are written in rem,
// the unit the whole page is sized in; the caller multiplies them by the root font size it reads when the press starts, so a
// larger window or a larger root makes the targets larger too. Where a note is drawn is worked out from the same shapes the
// lanes are drawn from, so the note a press picks is the note the person sees. No DOM access and no timers here, so node:test
// and page/main.js import the module without a build step.

import { PAGE_CYCLES, cycleAt } from './timeline.js';

/** A press that moves less than this is a click; a press that moves more is a drag. */
export const DRAG_THRESHOLD_REM = 0.25;

/** How far from a drawn note a press still counts as on it, in both directions. */
export const HIT_TOLERANCE_REM = 0.5;

/** The share of a lane's height a pitched note mark takes (a tick spans the whole height). */
export const NOTE_MARK_HEIGHT = 0.14;

/** How far a dragged note travels up or down for one semitone. A fixed step: it does not follow the lane's own pitch scale. */
export const SEMITONE_REM = 0.5;

/**
 * Which gesture a press that has moved turns into, decided once and kept for the rest of the press: null while the pointer is
 * still within `thresholdPx` of where it went down (it may yet be a click), then `'pitch'` or `'range'`. On a note the larger
 * of the two travels wins (up or down is a pitch drag, sideways a range) and equal travel is a pitch drag; on empty lane area
 * any travel is a range. `dx` and `dy` are the pointer's distance from the press, in pixels.
 */
export function lockGesture({ dx, dy, onNote, thresholdPx }) {
  if (Math.hypot(dx, dy) < thresholdPx) return null;
  if (!onNote) return 'range';
  return Math.abs(dy) >= Math.abs(dx) ? 'pitch' : 'range';
}

/**
 * The whole cycles a range drag covers: the cycle under the press and the cycle under the pointer, in either order, both
 * included. `pageStart` is the first cycle of the page drawn, `pressFraction` and `pointerFraction` how far along the lane's event
 * area the press and the pointer are (0 at its left edge, 1 at its right). Gives `{ from, to, cut }`. A pointer that left the
 * event area (a fraction below 0 or above 1) is held at the page's first or last cycle, and `cut` is then `{ from, to }`, the
 * cycles the range ended up with; otherwise `cut` is null. A range never leaves the page, so it never covers more than
 * PAGE_CYCLES cycles.
 */
export function rangeCycles({ pageStart, pressFraction, pointerFraction }) {
  for (const [name, value] of Object.entries({ pressFraction, pointerFraction })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`rangeCycles: ${name} must be a finite number, got ${String(value)}`);
  }
  const pressed = cycleAt({ pageStart, fraction: pressFraction });
  const pointed = cycleAt({ pageStart, fraction: pointerFraction });
  const from = Math.min(pressed, pointed);
  const to = Math.max(pressed, pointed);
  const left = pointerFraction < 0 || pointerFraction > 1;
  return { from, to, cut: left ? { from, to } : null };
}

/**
 * The whole semitones a pointer that moved `dy` pixels down (negative: up) stands for, `stepPx` pixels to a semitone. Up is
 * higher, a part of a step counts for nothing, and no travel is 0, never negative zero.
 */
export function semitonesFrom({ dy, stepPx }) {
  const semitones = Math.trunc(-dy / stepPx);
  return semitones === 0 ? 0 : semitones;
}

/**
 * One pixel box `{ left, top, right, bottom }` for each drawn note of a lane, in the order of `shapes`, and null for a tick
 * (it has no pitch and is not picked). `rect` is the lane's event area in the page (`left`, `top`, `width`, `height`),
 * `shapes` what the lane was drawn from (`{ kind, x, width, y }` for a normal lane, `{ x, width, row }` for a drum lane),
 * `rowCount` the number of drum rows of a drum lane or null, `markHeight` the share of the lane height a mark takes.
 */
export function noteBoxes({ rect, shapes, rowCount, markHeight }) {
  const perCycle = rect.width / PAGE_CYCLES;
  return shapes.map((shape) => {
    if (rowCount === null && shape.kind !== 'note') return null;
    const left = rect.left + shape.x * perCycle;
    let top;
    let height;
    if (rowCount === null) {
      const y = Math.max(0, Math.min(1 - markHeight, shape.y - markHeight / 2));
      top = rect.top + y * rect.height;
      height = markHeight * rect.height;
    } else {
      top = rect.top + ((shape.row + 0.25) / rowCount) * rect.height;
      height = (0.5 / rowCount) * rect.height;
    }
    return { left, top, right: left + shape.width * perCycle, bottom: top + height };
  });
}

/** How far `at` is outside the span from `low` to `high` (0 inside it). */
function outside(at, low, high) {
  return Math.max(low - at, 0, at - high);
}

/**
 * The index of the drawn note a press at (`x`, `y`) is on, or null on empty lane area. A note counts when the press is within
 * `tolerancePx` of its box in both directions; of several the nearest wins, and equal distances go to the lower pitch
 * (`pitches[i]` is the pitch of box i, null boxes are skipped).
 */
export function pickNote({ boxes, pitches, x, y, tolerancePx }) {
  let best = null;
  let bestDistance = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (box === null) continue;
    const dx = outside(x, box.left, box.right);
    const dy = outside(y, box.top, box.bottom);
    if (dx > tolerancePx || dy > tolerancePx) continue;
    const distance = Math.hypot(dx, dy);
    const nearer = distance < bestDistance - 1e-9;
    const tied = Math.abs(distance - bestDistance) <= 1e-9 && best !== null && pitches[i] < pitches[best];
    if (nearer || tied) {
      best = i;
      bestDistance = Math.min(distance, bestDistance);
    }
  }
  return best;
}

/** How long the steps of a key or a button gather before the page writes them once, in milliseconds. */
export const STEP_GATHER_MS = 600;

function defaultStepError(error) {
  console.error('Moontide: the steps of a Timeline note could not be written:', error);
}

/**
 * Gathers the steps of one kind (pitch, velocity) into one write. `step(kind, amount)` adds `amount` (a whole number, negative
 * for down) to the pending total of `kind` and starts the wait again; `delayMs` after the last step `onFlush(kind, total)`
 * runs once. A step of another kind writes the pending one first and starts a burst of its own, so a burst only ever holds
 * one kind and each kind is its own write. A total of 0 writes nothing. `drop()` forgets the pending steps without writing,
 * `flush()` writes them now, `pending()` gives `{ kind, total }` or null. Once handed to `onFlush` a burst belongs to the
 * caller: the gatherer never takes it back, and `onFlush` must not call `step`, `flush` or `drop` (that throws, and the
 * error is reported through `onError`). Like the Mixer's recorder it has no timers of its own: `setTimer(fn, ms)` gives a
 * handle for `clearTimer(handle)`, so node:test drives it with a fake clock. `onError(error)` hears an `onFlush` that threw,
 * and the gatherer keeps working.
 */
export function createStepGatherer({ setTimer, clearTimer, delayMs = STEP_GATHER_MS, onFlush, onError = defaultStepError }) {
  for (const [name, fn] of Object.entries({ setTimer, clearTimer, onFlush })) {
    if (typeof fn !== 'function') throw new Error(`Moontide: the step gatherer needs ${name}, a function.`);
  }
  let open = null;
  let timer = null;
  // True while a burst is being handed to onFlush: the gatherer is not entered again from there.
  let flushing = false;

  function stopTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function notInFlush(name) {
    if (flushing) throw new Error(`Moontide: the step gatherer's ${name} was called from inside its own flush.`);
  }

  function run(kind, total) {
    if (total === 0) return;
    flushing = true;
    try {
      onFlush(kind, total);
    } catch (error) {
      onError(error);
    } finally {
      flushing = false;
    }
  }

  function flush() {
    notInFlush('flush');
    stopTimer();
    const gathered = open;
    open = null;
    if (gathered !== null) run(gathered.kind, gathered.total);
  }

  return {
    step(kind, amount) {
      notInFlush('step');
      if (typeof kind !== 'string' || kind === '') throw new Error('Moontide: a step has the kind it belongs to.');
      if (!Number.isInteger(amount) || amount === 0) throw new Error(`Moontide: a step is a whole number other than 0, got ${String(amount)}.`);
      if (open !== null && open.kind !== kind) flush();
      if (open === null) open = { kind, total: 0 };
      open.total += amount;
      stopTimer();
      timer = setTimer(() => {
        timer = null;
        flush();
      }, delayMs);
    },
    drop() {
      notInFlush('drop');
      stopTimer();
      open = null;
    },
    flush,
    pending() {
      return open === null ? null : { kind: open.kind, total: open.total };
    },
  };
}

/** The keys that move along a lane or across lanes. */
export const LANE_KEYS = Object.freeze(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/** The cycle a start time falls in (a start just under a whole cycle counts as that cycle, like the lanes' own cycle numbers). */
function cycleOfStart(begin) {
  return Math.floor(begin + 1e-9);
}

/**
 * The notes of one lane in the order the keys walk them: by start, then pitch (lower first), then by position. `notes` has one
 * entry for each drawn event, `{ begin, pitch }`, or null for an event the keys skip (a tick has no pitch and no mark to pick).
 * Gives the positions in `notes`.
 */
function walkOrder(notes) {
  const order = [];
  notes.forEach((entry, index) => {
    if (entry !== null) order.push(index);
  });
  order.sort((a, b) => notes[a].begin - notes[b].begin || (notes[a].pitch ?? -1) - (notes[b].pitch ?? -1) || a - b);
  return order;
}

/**
 * Where a key of the keyboard model takes the person on the Timeline's lanes. `lanes` holds the drawn lanes, each the list of its
 * events as `{ begin, pitch }` (null for an event the keys skip); `at` is the current place or null: `{ laneIndex, eventIndex }`
 * on a note, `{ laneIndex, eventIndex: null, cycle }` on the cursor of a lane that has no notes on the page. `key` is one of
 * LANE_KEYS; any other key throws. The answer is `{ laneIndex, eventIndex, cycle }` (`eventIndex` null for the cursor, `cycle`
 * the whole cycle of the note or the cursor), the same place when the key goes nowhere (the first or last note, the first or
 * last lane), or null when the key does not apply: nothing to start from and no note anywhere, or a key that needs a place and
 * has none (Home, End, Page Up and Page Down with nothing selected, so they scroll as they always did).
 *
 * Left and Right walk the lane by start and then pitch, and stop at its first and last note (the page does not turn). With no
 * place Right takes the first note of the first lane that has one and Left the last note of that lane. Home and End take the
 * first and the last note of the lane. Page Up and Page Down take the lane before and after, keeping the cycle: the note whose
 * start is nearest in time (the earlier one when two are as near, then the lower pitch), or the cursor when that lane has no
 * notes on the page.
 */
export function laneMove({ lanes, at, key }) {
  if (!Array.isArray(lanes)) throw new TypeError('laneMove: lanes must be an array of lanes.');
  if (!LANE_KEYS.includes(key)) throw new Error(`laneMove: unknown key '${String(key)}'.`);
  const note = (laneIndex, eventIndex) => ({ laneIndex, eventIndex, cycle: cycleOfStart(lanes[laneIndex][eventIndex].begin) });
  if (at === null || at === undefined) {
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
      const order = walkOrder(lanes[laneIndex]);
      if (order.length > 0) return note(laneIndex, key === 'ArrowRight' ? order[0] : order[order.length - 1]);
    }
    return null;
  }
  const { laneIndex, eventIndex } = at;
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= lanes.length) throw new RangeError(`laneMove: there is no lane ${String(laneIndex)}.`);
  if (eventIndex === null) {
    if (!Number.isInteger(at.cycle)) throw new TypeError('laneMove: the cursor of a lane without notes needs its cycle.');
  } else if (lanes[laneIndex][eventIndex] === undefined || lanes[laneIndex][eventIndex] === null) {
    throw new RangeError(`laneMove: lane ${laneIndex} has no note ${String(eventIndex)} to walk.`);
  }
  const here = eventIndex === null ? { laneIndex, eventIndex: null, cycle: at.cycle } : note(laneIndex, eventIndex);
  if (key === 'PageUp' || key === 'PageDown') {
    const target = Math.max(0, Math.min(lanes.length - 1, laneIndex + (key === 'PageDown' ? 1 : -1)));
    if (target === laneIndex) return here;
    const time = eventIndex === null ? at.cycle : lanes[laneIndex][eventIndex].begin;
    let nearest = null;
    let nearestGap = Infinity;
    for (const index of walkOrder(lanes[target])) {
      const gap = Math.abs(lanes[target][index].begin - time);
      if (gap < nearestGap - 1e-9) {
        nearest = index;
        nearestGap = gap;
      }
    }
    return nearest === null ? { laneIndex: target, eventIndex: null, cycle: eventIndex === null ? at.cycle : cycleOfStart(time) } : note(target, nearest);
  }
  // The cursor of a lane without notes has no note to walk along.
  if (eventIndex === null) return here;
  const order = walkOrder(lanes[laneIndex]);
  const position = order.indexOf(eventIndex);
  if (key === 'Home') return note(laneIndex, order[0]);
  if (key === 'End') return note(laneIndex, order[order.length - 1]);
  const next = Math.max(0, Math.min(order.length - 1, position + (key === 'ArrowRight' ? 1 : -1)));
  return note(laneIndex, order[next]);
}
