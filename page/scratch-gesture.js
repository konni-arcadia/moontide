// Pure module for the Scratchpad roll: the numbers behind a pointer. Distances are written in rem, the unit the whole page is sized
// in; the caller multiplies them by the root font size it reads when a press starts, so a larger root makes the targets larger too.
// A point on the roll becomes a cell, a drawn length, a move or a new length through the same whole units the model keeps, so what is
// previewed is what is committed. The rows of the roll are worked out from the notes, so every row function takes the number of rows
// shown and the pitch of the top row. No DOM access and no timers here, so node:test and the view import the module without a build step.

/** A press that moves less than this is a click; a press that moves more is a drag. */
export const DRAG_THRESHOLD_REM = 0.25;

/** The width of the handle at a note's right side that resizes it, and the most of a short note it may take. */
export const EDGE_HANDLE_REM = 0.5;
export const EDGE_HANDLE_SHARE = 0.4;

/** A drag within this distance of the edge of the visible roll scrolls it, by `EDGE_SCROLL_REM` on each pointer move. */
export const EDGE_ZONE_REM = 1.5;
export const EDGE_SCROLL_REM = 1;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** The nearest grid line to `position` for lines `size` apart, with a tie going to the earlier line; `position` may be fractional. */
function nearestLine(position, size) {
  return Math.ceil(position / size - 0.5);
}

/** Turns a negative zero into 0, so a start of 0 is the same value however it was worked out. */
const whole = (value) => value + 0;

/**
 * Where the pointer is along the motif, in units, even outside the grid (a negative number left of it, more than `units` right of it).
 * `rect` is the grid's box in the page (`left`, `width`), `units` the motif's length in units.
 */
export function pointerUnit({ rect, x, units }) {
  return ((x - rect.left) / rect.width) * units;
}

/** The row the pointer is in, counted from the top row at 0, even outside the grid. `rect` has `top` and `height` for the `rows` rows shown. */
export function pointerRow({ rect, y, rows }) {
  return Math.floor((y - rect.top) / (rect.height / rows));
}

/**
 * The cell under a point: `{ unit, pitch }`, where `unit` is the start of the grid step that holds the point and `pitch` the pitch
 * of its row (the top of the `rows` rows shown is `high`). A point outside the grid's box gives null.
 */
export function cellAt({ rect, x, y, units, gridUnit, rows, high }) {
  if (x < rect.left || x >= rect.left + rect.width || y < rect.top || y >= rect.top + rect.height) return null;
  const unit = Math.floor(pointerUnit({ rect, x, units }) / gridUnit) * gridUnit;
  return { unit, pitch: high - pointerRow({ rect, y, rows }) };
}

/**
 * The box a selection drag spans, in units and rows counted from the top row at 0: `{ fromUnit, toUnit, topRow, bottomRow }`, the same
 * whichever way the pointer went from the press (`x0`, `y0`) to where it is (`x1`, `y1`), and held inside the grid. The numbers are
 * fractions, so a box over part of a cell still says which part. `rect` is the grid's box (`left`, `top`, `width`, `height`), `units` the
 * motif's length and `rows` the rows the grid shows.
 */
export function selectionBox({ rect, x0, y0, x1, y1, units, rows }) {
  const unitOf = (x) => clamp(pointerUnit({ rect, x, units }), 0, units);
  const rowOf = (y) => clamp(((y - rect.top) / rect.height) * rows, 0, rows);
  const [a, b] = [unitOf(x0), unitOf(x1)];
  const [c, d] = [rowOf(y0), rowOf(y1)];
  return { fromUnit: whole(Math.min(a, b)), toUnit: whole(Math.max(a, b)), topRow: whole(Math.min(c, d)), bottomRow: whole(Math.max(c, d)) };
}

/**
 * The ids of the notes a selection box touches: a note whose span overlaps the box's span and whose row lies between the rows the box's
 * top and bottom fall in. A note that only ends where the box starts, or starts where it ends, is not touched; a box with no width
 * touches the note whose span holds it. `high` is the pitch of the top row, so a note's row is `high` minus its pitch.
 */
export function notesInBox({ notes, box, high }) {
  const first = Math.floor(box.topRow);
  const last = Math.floor(box.bottomRow);
  const flat = box.toUnit <= box.fromUnit;
  return notes
    .filter((note) => {
      const row = high - note.pitch;
      if (row < first || row > last) return false;
      const end = note.start + note.length;
      return flat ? note.start <= box.fromUnit && end > box.fromUnit : note.start < box.toUnit && end > box.fromUnit;
    })
    .map((note) => note.id);
}

/**
 * The length of a note drawn from `start` to the pointer: up to the end of the grid step under the pointer, that step included, at
 * least one step and at most to the motif's end. A pointer before the start gives one step. `pointerUnit` is where the pointer is, in units.
 */
export function drawLength({ start, pointerUnit: at, gridUnit, units }) {
  const end = (Math.floor(at / gridUnit) + 1) * gridUnit;
  return clamp(end - start, gridUnit, units - start);
}

/**
 * Where a dragged note lands: `{ start, pitch }`. The start is the nearest grid line to where the note's start was dragged to (`dUnits`
 * units from where it began; a tie goes to the earlier line), held from 0 to the last start that keeps the note inside the motif.
 * The pitch is `dRows` rows lower (negative: higher), held between `low` and `high`, the lowest and highest shown pitch.
 */
export function moveTarget({ note, dUnits, dRows, gridUnit, units, low, high }) {
  const last = Math.floor((units - note.length) / gridUnit) * gridUnit;
  return {
    start: whole(clamp(nearestLine(note.start + dUnits, gridUnit) * gridUnit, 0, last)),
    pitch: clamp(note.pitch - dRows, low, high),
  };
}

/**
 * Where a dragged group of notes lands, as one move for the whole group: `{ dStart, dPitch }` in units and semitones. The start move is
 * `dUnits` snapped to the nearest grid line (a tie goes to the earlier line) and held so the earliest note stays at or after 0 and the
 * latest end at or before `units`; the group keeps its shape, so one note decides how far it can go. The pitch move is `dRows` rows lower
 * (negative: higher) held so every pitch stays between `low` and `high`, the lowest and highest shown pitch. A note already outside those
 * rows is not pulled in: the group just cannot go further out.
 */
export function groupMoveTarget({ notes, dUnits, dRows, gridUnit, units, low, high }) {
  const first = Math.min(...notes.map((note) => note.start));
  const last = Math.max(...notes.map((note) => note.start + note.length));
  const lowest = Math.min(...notes.map((note) => note.pitch));
  const highest = Math.max(...notes.map((note) => note.pitch));
  return {
    dStart: whole(clamp(nearestLine(dUnits, gridUnit) * gridUnit, -first, units - last)),
    dPitch: whole(clamp(-dRows, Math.min(0, low - lowest), Math.max(0, high - highest))),
  };
}

/**
 * The length a dragged edge gives a note that starts at `start`: it ends on the nearest grid line to the pointer (a tie goes to the
 * earlier line), at least one step long and at most to the motif's end.
 */
export function resizeLength({ start, pointerUnit: at, gridUnit, units }) {
  return clamp(nearestLine(at, gridUnit) * gridUnit - start, gridUnit, units - start);
}

/**
 * Which part of a note a press is on: `'edge'` when it is within `EDGE_HANDLE_REM` of the note's right side, or within the share of a
 * short note that `EDGE_HANDLE_SHARE` allows, else `'body'`. `left` and `width` are the note's box in pixels, `remPx` the root font size.
 */
export function pickPart({ left, width, x, remPx }) {
  const handle = Math.min(EDGE_HANDLE_REM * remPx, EDGE_HANDLE_SHARE * width);
  return x >= left + width - handle ? 'edge' : 'body';
}

/** True once a pointer that went down has moved `thresholdPx` pixels or more (`dx` and `dy` are its distance from the press). */
export function lockDrag({ dx, dy, thresholdPx }) {
  return Math.hypot(dx, dy) >= thresholdPx;
}

/**
 * How far to scroll the roll, in pixels, for a drag whose pointer is at `x`: minus one `EDGE_SCROLL_REM` toward the left edge when the
 * pointer is within `EDGE_ZONE_REM` of `left`, plus one toward the right edge when it is within that distance of `right` (a pointer
 * past an edge counts), else 0. `left` and `right` are the edges of the part of the roll that shows. A box with no width gives 0.
 */
export function edgeScrollPx({ x, left, right, remPx }) {
  if (right <= left) return 0;
  const zone = EDGE_ZONE_REM * remPx;
  const fromLeft = x - left;
  const fromRight = right - x;
  if (fromLeft <= zone && fromLeft <= fromRight) return -EDGE_SCROLL_REM * remPx;
  if (fromRight <= zone) return EDGE_SCROLL_REM * remPx;
  return 0;
}

/**
 * How far to scroll the box vertically after an Undo or a Redo, so the rows it touched show between the ruler and the velocity lane.
 * `tops` are the screen tops of the rows to show (one per note, may repeat), `cursorTop` the top of the cursor row, `rowHeight` one row,
 * and `visibleTop` and `visibleBottom` the band between the ruler and the lane. Returns `{ by, nearest }`: `by` is the pixels to add to
 * the box's scroll (negative scrolls up), and `nearest` the index in `tops` of the row closest to the cursor row (null with no rows).
 * When the cursor row and the nearest row cannot both fit in the band, `by` is null: the caller has to move the cursor.
 * Everything that fits together is brought in with the smallest move; otherwise the cursor row goes to the band's edge that leaves the
 * most room on the side of the nearest row.
 */
export function historyScroll({ tops, cursorTop, rowHeight, visibleTop, visibleBottom }) {
  if (!(rowHeight > 0)) throw new Error(`Moontide: a history scroll needs a row height above 0, got ${String(rowHeight)}`);
  if (!(visibleBottom > visibleTop)) throw new Error(`Moontide: a history scroll needs a visible band with a height, got ${String(visibleTop)} to ${String(visibleBottom)}`);
  let nearest = null;
  tops.forEach((top, index) => {
    if (nearest === null || Math.abs(top - cursorTop) < Math.abs(tops[nearest] - cursorTop)) nearest = index;
  });
  const band = visibleBottom - visibleTop;
  const spanTop = Math.min(cursorTop, ...tops);
  const spanBottom = Math.max(cursorTop, ...tops) + rowHeight;
  if (spanBottom - spanTop <= band) {
    if (spanTop < visibleTop) return { by: spanTop - visibleTop, nearest };
    if (spanBottom > visibleBottom) return { by: spanBottom - visibleBottom, nearest };
    return { by: 0, nearest };
  }
  if (nearest === null) return { by: cursorTop - visibleTop, nearest };
  const target = tops[nearest];
  const pairTop = Math.min(cursorTop, target);
  const pairBottom = Math.max(cursorTop, target) + rowHeight;
  if (pairBottom - pairTop > band) return { by: null, nearest };
  const cursorAtBottom = target < cursorTop || (target === cursorTop && tops.filter((top) => top < cursorTop).length > tops.filter((top) => top > cursorTop).length);
  return { by: cursorAtBottom ? cursorTop + rowHeight - visibleBottom : cursorTop - visibleTop, nearest };
}

/** The width of the column of piano names at the left of the roll, in rem; the stylesheet draws the same width. */
export const GUTTER_REM = 4.5;

/** The smallest a beat gets while the motif's cycles are shown, in rem (a sixteenth is 1 rem); less room than that scrolls sideways. */
export const BEAT_MIN_REM = 4;
/** The smallest a beat gets while the live view shows 8 cycles, in rem: eight cycles need to fit more often than the motif's. */
export const LIVE_BEAT_MIN_REM = 2.5;
/** A row is held from 0.625 rem to 1.25 rem high. */
const ROW_REM_RANGE = [0.625, 1.25];

/** The width of a beat in rem: the room divided by the beats shown, never less than `minRem` and never capped, so the roll takes all its width. */
export function beatWidthRem({ availableRem, beats, minRem = BEAT_MIN_REM }) {
  return Math.max(minRem, availableRem / beats);
}

/** The height of a row in rem: the room divided by the `rows` rows shown, held from 0.625 to 1.25 rem. More rows than fit at the least scroll. */
export function rowHeightRem({ availableRem, rows }) {
  return clamp(availableRem / rows, ...ROW_REM_RANGE);
}

/** A bar of the velocity lane is at least this wide, with a little air on each side: the room one bar of a chord takes. */
export const BAR_SLOT_REM = 0.375;

/**
 * The velocity a pointer at height `y` gives in a lane whose bars area is `rect` (`top` and `height`): the height above the lane's
 * bottom as a share of its height, in whole hundredths, held from 1 (the bottom edge) to 100 (the top edge). A pointer past either edge is held there.
 */
export function velocityAt({ rect, y }) {
  return clamp(Math.round(((rect.top + rect.height - y) / rect.height) * 100), 1, 100);
}

/**
 * The note whose bar is under a pointer at `x`. A bar belongs to the column of its note's start, one grid step wide; notes that start
 * together share the column side by side, and a bar's share is never narrower than `BAR_SLOT_REM`, so a crowded chord on a narrow step
 * spreads to the right. `bars` lists `{ id, start, slot, slots }`, `rect` is the bars area (`left` and `width`) for `units` units, and
 * `remPx` the root font size. Returns the id, or null where no bar is.
 */
export function barAt({ rect, x, bars, units, gridUnit, remPx }) {
  const column = (gridUnit / units) * rect.width;
  for (const bar of bars) {
    const share = Math.max(BAR_SLOT_REM * remPx, column / bar.slots);
    const left = rect.left + (bar.start / units) * rect.width + bar.slot * share;
    if (x >= left && x < left + share) return bar.id;
  }
  return null;
}
