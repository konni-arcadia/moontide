// Pure model of the separator between the editor and the view. No DOM access, no storage: the
// limits, the defaults, the keys per layout, the pointer geometry, the parse of a stored size and the words. The value
// is always the view panel's share of the workspace's main axis in percent (layout a: its height over the workspace's
// height; layout b: its width over the workspace's width). page/split-view.js draws and listens; page/main.js stores.

/** The smallest and the largest share of the workspace the view may take, in percent. */
export const SPLIT_MIN = 15;
export const SPLIT_MAX = 85;
/** The size of the view when nothing is stored, per layout: layout a (view below) and layout b (view at the side). */
export const SPLIT_DEFAULTS = Object.freeze({ a: 42, b: 45 });
/** One arrow key moves the border by 2 points, one Page key by 10. */
export const SPLIT_STEP = 2;
export const SPLIT_PAGE = 10;

/** The words of the separator. `n` is rounded to a whole percent for display. */
export const SPLIT_COPY = Object.freeze({
  name: 'Resize the view',
  title: 'Drag, or use the arrow keys. Double-click resets.',
  /** How long the readout keeps its "kept for layout" line after a release or a key step. */
  keptMs: 1500,
  valueText: (n) => `View ${Math.round(n)} percent`,
  readoutLive: (n) => `view ${Math.round(n)}%`,
  readoutKept: (n, layout) => `view ${Math.round(n)}% · kept for layout ${layout}`,
  readoutReset: (n) => `view reset to ${Math.round(n)}%`,
  announce: (n, layout) => `View size ${Math.round(n)} percent, kept for layout ${layout}.`,
  badStored: (key, fallback) =>
    `Moontide: the stored size under '${key}' is not a number from ${SPLIT_MIN} to ${SPLIT_MAX}; using the default of ${fallback} percent.`,
});

/** The view's share in percent, kept inside the limits. A value that is not a finite number throws (loud). */
export function clampSplit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Moontide: a split size must be a finite number, got ${String(value)}.`);
  }
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

/** Throws unless `layout` is one of the two layouts that have a border. */
function requireBorderLayout(layout) {
  if (layout !== 'a' && layout !== 'b') {
    throw new Error(`Moontide: layout '${String(layout)}' has no border to move (expected 'a' or 'b').`);
  }
}

/**
 * The new size for a key pressed on the focused handle, or null for a key it does not take. `layout` is 'a' or 'b'
 * (anything else throws). The border moves the way the arrow points: in layout a ArrowUp grows the view and ArrowDown
 * shrinks it; in layout b ArrowLeft grows it and ArrowRight shrinks it. Page keys move by 10, Home goes to the smallest
 * size and End to the largest. The arrows of the other axis, Enter and every other key return null.
 */
export function splitKeyValue(layout, current, key) {
  requireBorderLayout(layout);
  const from = clampSplit(current);
  const grow = layout === 'a' ? 'ArrowUp' : 'ArrowLeft';
  const shrink = layout === 'a' ? 'ArrowDown' : 'ArrowRight';
  if (key === grow) return clampSplit(from + SPLIT_STEP);
  if (key === shrink) return clampSplit(from - SPLIT_STEP);
  if (key === 'PageUp') return clampSplit(from + SPLIT_PAGE);
  if (key === 'PageDown') return clampSplit(from - SPLIT_PAGE);
  if (key === 'Home') return SPLIT_MIN;
  if (key === 'End') return SPLIT_MAX;
  return null;
}

/**
 * The size that puts the handle where the pointer is, in percent with one decimal, clamped to the limits. `pointer` is
 * the pointer coordinate along the main axis (clientY in layout a, clientX in layout b), `rect` the workspace's
 * rectangle ({ left, top, width, height }), `handle` the handle's thickness and `grab` the offset of the pointer from the
 * handle's start at the moment it was grabbed. Subtracting the grab offset means a click without movement gives the size
 * the border already has. The view is the part of the workspace after the handle.
 */
export function splitFromPointer({ layout, pointer, rect, handle, grab }) {
  requireBorderLayout(layout);
  for (const [name, value] of Object.entries({ pointer, handle, grab })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Moontide: the ${name} of a split drag must be a finite number, got ${String(value)}.`);
    }
  }
  const start = layout === 'a' ? rect.top : rect.left;
  const size = layout === 'a' ? rect.height : rect.width;
  if (typeof start !== 'number' || !Number.isFinite(start) || typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new Error('Moontide: the workspace rectangle of a split drag needs a position and a size above zero.');
  }
  const viewSize = start + size - (pointer - grab + handle);
  return Math.round(clampSplit((viewSize / size) * 100) * 10) / 10;
}

/**
 * A size read back from storage, or undefined when it is missing or not a plain number from 15 to 85 (one decimal is
 * kept). Only digits and one decimal point are accepted, so a stored string such as an exponent, a unit, a CSS function
 * or markup never becomes a size; the number returned is what reaches the page, never the stored text.
 */
export function parseStoredSplit(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}(\.\d{1,12})?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= SPLIT_MIN && value <= SPLIT_MAX ? Math.round(value * 10) / 10 : undefined;
}
