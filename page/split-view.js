// The separator between the editor and the view: the pointer drag, the keys, the double-click, the
// ARIA values, the readout and the polite announcement. It draws and listens only: it never stores a size, never sends
// and never builds markup (text and attributes only). The size model is page/split-model.js; page/main.js applies a size
// to the page (the CSS variable on the workspace), stores it per layout and refreshes what listens to the window only.
// No DOM access at import time: main.js calls createSplitView() with its document and callbacks.

import { SPLIT_COPY, clampSplit, splitFromPointer, splitKeyValue } from './split-model.js';

/**
 * Creates the view. `document` is the page's document (named so on purpose: every element lookup below reads
 * `document.getElementById`); `onSize(value, { final, source })` runs for every new size, `final` false while a drag is
 * moving and true on release and for a key step (`source` is 'pointer' or 'key'); `onReset()` runs on a double-click;
 * `setTimer` and `clearTimer` are the page's timers (the readout's "kept" line lasts SPLIT_COPY.keptMs).
 *
 * Returns { setLayout, setValue, setHidden, say, focusIsInside, blur }:
 * - setLayout('a' | 'b' | 'c') writes the orientation (layout c has no border and keeps the last one);
 * - setValue(n) writes aria-valuenow (a whole number), aria-valuetext and the live readout, and ends a "kept" line;
 * - setHidden(flag) shows or hides the handle;
 * - say('kept' | 'reset', n, layout) shows the "kept for layout" or the reset line for 1.5 s and says it politely;
 * - focusIsInside() tells whether the handle has focus, blur() gives it up.
 */
export function createSplitView({ document, onSize, onReset, setTimer, clearTimer }) {
  const workspace = document.getElementById('workspace');
  const handle = document.getElementById('split-handle');
  const readout = document.getElementById('split-readout');
  const status = document.getElementById('split-status');
  if (!workspace || !handle || !readout || !status) {
    throw new Error('Moontide: the separator markup is missing from the page.');
  }

  handle.setAttribute('aria-label', SPLIT_COPY.name);
  handle.setAttribute('title', SPLIT_COPY.title);

  let layout = 'a';
  let value = Number(handle.getAttribute('aria-valuenow'));
  let keptTimer = null;
  /** The drag in progress: { pointerId, grab, rect, thickness, moved, pointerType }, or null. */
  let drag = null;

  function endKept() {
    if (keptTimer !== null) {
      clearTimer(keptTimer);
      keptTimer = null;
    }
    delete handle.dataset.kept;
    readout.textContent = SPLIT_COPY.readoutLive(value);
  }

  function setLayout(next) {
    if (next !== 'a' && next !== 'b' && next !== 'c') {
      throw new Error(`Moontide: unknown layout '${String(next)}' for the separator.`);
    }
    layout = next;
    if (next !== 'c') handle.setAttribute('aria-orientation', next === 'a' ? 'horizontal' : 'vertical');
  }

  function setValue(next) {
    value = clampSplit(next);
    handle.setAttribute('aria-valuenow', String(Math.round(value)));
    handle.setAttribute('aria-valuetext', SPLIT_COPY.valueText(value));
    endKept();
  }

  function setHidden(flag) {
    handle.hidden = flag;
  }

  function say(kind, next, forLayout) {
    if (kind !== 'kept' && kind !== 'reset') throw new Error(`Moontide: unknown separator message '${String(kind)}'.`);
    if (keptTimer !== null) clearTimer(keptTimer);
    readout.textContent = kind === 'reset' ? SPLIT_COPY.readoutReset(next) : SPLIT_COPY.readoutKept(next, forLayout);
    status.textContent = SPLIT_COPY.announce(next, forLayout);
    handle.dataset.kept = 'true';
    keptTimer = setTimer(() => {
      keptTimer = null;
      endKept();
    }, SPLIT_COPY.keptMs);
  }

  function endDrag() {
    if (drag === null) return;
    const finished = drag;
    drag = null;
    delete workspace.dataset.dragging;
    if (typeof handle.hasPointerCapture === 'function' && handle.hasPointerCapture(finished.pointerId)) {
      handle.releasePointerCapture(finished.pointerId);
    }
    // A drag that never moved is a click: the border stays where it is and nothing is stored.
    if (finished.moved) onSize(value, { final: true, source: 'pointer' });
    // After a mouse drag the handle gives up focus, so the view keys work at once (a keyboard-focused handle keeps it).
    handle.blur();
  }

  handle.addEventListener('pointerdown', (event) => {
    if (drag !== null || event.button !== 0 || layout === 'c') return;
    const rect = workspace.getBoundingClientRect();
    const box = handle.getBoundingClientRect();
    const horizontal = layout === 'a';
    drag = {
      pointerId: event.pointerId,
      grab: horizontal ? event.clientY - box.top : event.clientX - box.left,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      thickness: horizontal ? box.height : box.width,
      moved: false,
    };
    handle.setPointerCapture(event.pointerId);
    workspace.dataset.dragging = 'true';
    endKept();
  });

  handle.addEventListener('pointermove', (event) => {
    // Layout c has no border: a move that arrives after the layout changed mid-drag is ignored (the release ends the drag).
    if (drag === null || layout === 'c' || event.pointerId !== drag.pointerId) return;
    const next = splitFromPointer({
      layout,
      pointer: layout === 'a' ? event.clientY : event.clientX,
      rect: drag.rect,
      handle: drag.thickness,
      grab: drag.grab,
    });
    if (next === value) return;
    drag.moved = true;
    onSize(next, { final: false, source: 'pointer' });
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    handle.addEventListener(type, (event) => {
      if (drag !== null && event.pointerId === drag.pointerId) endDrag();
    });
  }

  handle.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || layout === 'c') return;
    const next = splitKeyValue(layout, value, event.key);
    if (next === null) return;
    // The handle takes these keys for itself: the page handler and the History arrows never see them.
    event.preventDefault();
    event.stopPropagation();
    onSize(next, { final: true, source: 'key' });
  });

  handle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    onReset();
  });

  setValue(value);

  return {
    setLayout,
    setValue,
    setHidden,
    say,
    focusIsInside: () => document.activeElement === handle,
    blur: () => handle.blur(),
  };
}
