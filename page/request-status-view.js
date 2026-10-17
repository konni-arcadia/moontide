// The Requests chip in the top bar and the panel under it: one row per request the user sent, with the start of
// its text, the elapsed time and the words of its state; a row opens to a detail under it, and finished requests
// move to a folded Recent group. Every text reaches the page through textContent, title and setAttribute, never as
// markup: a request and Claude's words are untrusted. The view never decides anything: page/request-status.js holds
// the rows and their rules, page/main.js gives the view the model after every change. No DOM access at import
// time: main.js calls createRequestStatusView() with its document.
//
// The panel is non-modal and pushes nothing: it overlays the page under the bar's right end. It opens by itself
// when the user sends a request and never moves focus when it does; it folds by itself only when it opened by
// itself, nothing is in flight and the last finished row has moved to Recent, unless the pointer is over it. Any
// action of the user (opening it with the chip, opening a detail, putting focus inside) makes it the user's, and
// then it stays until the user folds it. Esc on the chip or inside the panel folds it and gives focus back to the
// chip; a click elsewhere does nothing. A text is written only when it changed, so a repeated draw writes nothing
// and a focused row keeps its focus. Nothing animates.

import { FINISHED_SHOWN_MS, REQUEST_STATUS_COPY, joinLive } from './request-status.js';

/** The elapsed time and a counting phrase step once a second. */
export const TICK_MS = 1000;

/** The spoken line is written at most once in this long; what arrives in between is joined. */
export const LIVE_EVERY_MS = 1000;

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
}

/**
 * Creates the view. `document` is the page's document (named so on purpose: every element lookup below reads
 * `document.getElementById`, the shape test/page-hidden.test.js scans). `now`, `setTimer` and `clearTimer` are the
 * page's clock. `onOpen` runs right before the panel opens (main.js closes the Session drawer there, because the
 * two never show together). `onHold(id, held)` says a row is under the pointer, has focus or has its detail open,
 * so the tracker keeps a finished row where it is. `takeLive()` gives the sentences to speak since the last call;
 * `getModel()` gives the tracker's model again each second, for the elapsed time.
 */
export function createRequestStatusView({
  document,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  onOpen = () => {},
  onHold = () => {},
  takeLive = () => [],
  getModel = null,
}) {
  const toggle = document.getElementById('requests-toggle');
  const panel = document.getElementById('requests-panel');
  const live = document.getElementById('requests-live');
  if (!toggle || !panel || !live) {
    throw new Error('Moontide: the Requests markup is missing from the page.');
  }
  const word = toggle.querySelector('.rq-word');
  const count = toggle.querySelector('.rq-count');
  if (!word || !count) {
    throw new Error('Moontide: the Requests markup is missing from the page.');
  }
  // The spoken line is the one live region of the feature: it must be there and speak, so a hidden one is a mistake.
  if (live.hasAttribute('hidden')) {
    throw new Error('Moontide: the Requests live region must never be hidden.');
  }

  word.textContent = REQUEST_STATUS_COPY.chipWord;
  toggle.setAttribute('title', REQUEST_STATUS_COPY.chipTitle);
  toggle.setAttribute('aria-controls', 'requests-panel');
  toggle.setAttribute('aria-expanded', 'false');
  count.setAttribute('aria-hidden', 'true');
  panel.setAttribute('aria-label', REQUEST_STATUS_COPY.panelName);

  const list = document.createElement('ul');
  list.className = 'rq-list';
  list.setAttribute('role', 'list');
  panel.appendChild(list);

  const recent = document.createElement('div');
  recent.className = 'rq-recent';
  recent.toggleAttribute('hidden', true);
  const recentHead = document.createElement('button');
  recentHead.type = 'button';
  recentHead.className = 'rq-recent-head';
  recentHead.setAttribute('aria-expanded', 'false');
  recentHead.setAttribute('aria-controls', 'requests-recent-body');
  const recentLabel = document.createElement('span');
  recentLabel.className = 'rq-recent-label';
  const recentChevron = document.createElement('span');
  recentChevron.className = 'rq-chevron';
  recentChevron.setAttribute('aria-hidden', 'true');
  recentChevron.textContent = REQUEST_STATUS_COPY.recentFolded;
  recentHead.appendChild(recentLabel);
  recentHead.appendChild(recentChevron);
  const recentBody = document.createElement('ul');
  recentBody.id = 'requests-recent-body';
  recentBody.className = 'rq-recent-body';
  recentBody.setAttribute('role', 'list');
  recentBody.toggleAttribute('hidden', true);
  recent.appendChild(recentHead);
  recent.appendChild(recentBody);
  panel.appendChild(recent);

  // id -> the nodes and the state of that request's row, kept between draws so a focused row keeps its focus.
  const entries = new Map();
  let detailCount = 0;
  // Whether the user (or a send) wants the panel open. It shows only while there is a row to show.
  let wantOpen = false;
  // True while the panel is open only because the user sent a request; any action of the user ends it.
  let autoOpened = false;
  let pointerInPanel = false;
  let recentOpen = false;
  let board = { empty: true, rows: [], recent: [] };
  let tickTimer = null;
  let liveTimer = null;
  let liveQueue = [];
  let lastLiveAt = null;

  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function setAttr(node, name, value) {
    if (value === '' || value === null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== value) {
      node.setAttribute(name, value);
    }
  }

  // toggleAttribute with a value that is already there writes nothing.
  function setHidden(node, hidden) {
    node.toggleAttribute('hidden', hidden);
  }

  function buildEntry(id) {
    detailCount += 1;
    const item = document.createElement('li');
    item.className = 'rq-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rq-row';
    const text = document.createElement('span');
    text.className = 'rq-text';
    const time = document.createElement('span');
    time.className = 'rq-time';
    const mark = document.createElement('span');
    mark.className = 'rq-mark';
    mark.setAttribute('aria-hidden', 'true');
    const state = document.createElement('span');
    state.className = 'rq-state';
    button.appendChild(text);
    button.appendChild(time);
    button.appendChild(mark);
    button.appendChild(state);
    const detail = document.createElement('div');
    detail.className = 'rq-detail';
    detail.id = `requests-detail-${detailCount}`;
    detail.toggleAttribute('hidden', true);
    button.setAttribute('aria-controls', detail.id);
    button.setAttribute('aria-expanded', 'false');
    item.appendChild(button);
    item.appendChild(detail);
    const entry = { id, item, button, text, time, mark, state, detail, open: false, pointer: false, focus: false, held: false, lines: '', row: null };
    item.addEventListener('pointerenter', () => {
      entry.pointer = true;
      reportHold(entry);
    });
    item.addEventListener('pointerleave', () => {
      entry.pointer = false;
      reportHold(entry);
    });
    item.addEventListener('focusin', (event) => {
      entry.focus = item.contains(event.target);
      reportHold(entry);
    });
    item.addEventListener('focusout', (event) => {
      entry.focus = event.relatedTarget !== null && event.relatedTarget !== undefined && item.contains(event.relatedTarget);
      reportHold(entry);
    });
    button.addEventListener('click', () => {
      entry.open = !entry.open;
      // Opening a detail is the user's own act.
      autoOpened = false;
      drawDetail(entry);
      reportHold(entry);
    });
    return entry;
  }

  /** Tells the tracker when the combined hold of a row (pointer, focus or an open detail) changed. */
  function reportHold(entry) {
    const held = entry.pointer || entry.focus || entry.open;
    if (held !== entry.held) {
      entry.held = held;
      onHold(entry.id, held);
    }
  }

  function drawDetail(entry) {
    setAttr(entry.button, 'aria-expanded', String(entry.open));
    setHidden(entry.detail, !entry.open);
    if (!entry.open || entry.row === null) return;
    const key = JSON.stringify(entry.row.detail);
    if (key === entry.lines) return;
    entry.lines = key;
    entry.detail.replaceChildren();
    for (const line of entry.row.detail) {
      const paragraph = document.createElement('p');
      paragraph.className = `rq-${line.kind}`;
      paragraph.textContent = line.text;
      entry.detail.appendChild(paragraph);
    }
  }

  function drawRow(entry, row) {
    entry.row = row;
    setText(entry.text, row.text);
    setAttr(entry.text, 'title', row.fullText);
    setText(entry.time, row.time);
    setAttr(entry.time, 'title', row.timeTitle);
    // The number of a row in flight changes every second: it is out of the accessible name until the row is finished.
    setAttr(entry.time, 'aria-hidden', row.finished ? '' : 'true');
    setAttr(entry.mark, 'data-shape', row.shape);
    setText(entry.state, row.phrase);
    setAttr(entry.state, 'title', row.phraseTitle);
    setAttr(entry.item, 'data-finished', String(row.finished));
    drawDetail(entry);
  }

  /** Puts the nodes of `rows` into `container` in order, one stable node per request. */
  function drawRows(container, rows) {
    let cursor = container.firstChild;
    for (const row of rows) {
      let entry = entries.get(row.id);
      if (entry === undefined) {
        entry = buildEntry(row.id);
        entries.set(row.id, entry);
      }
      drawRow(entry, row);
      if (entry.item === cursor) {
        cursor = cursor.nextSibling;
      } else {
        container.insertBefore(entry.item, cursor);
      }
    }
  }

  function dropGone(wanted) {
    for (const [id, entry] of entries) {
      if (wanted.has(id)) continue;
      entry.item.remove();
      entries.delete(id);
    }
  }

  function showPanel() {
    return wantOpen && !board.empty;
  }

  function drawChrome() {
    toggle.hidden = board.empty;
    const shown = showPanel();
    panel.hidden = !shown;
    setAttr(toggle, 'aria-expanded', String(shown));
  }

  function drawRecent() {
    const rows = board.recent ?? [];
    setHidden(recent, rows.length === 0);
    setText(recentLabel, fill(REQUEST_STATUS_COPY.recentHead, { n: rows.length }));
    setAttr(recentHead, 'aria-label', fill(REQUEST_STATUS_COPY.recentName, { n: rows.length }));
    setAttr(recentHead, 'aria-expanded', String(recentOpen));
    setText(recentChevron, recentOpen ? REQUEST_STATUS_COPY.recentOpen : REQUEST_STATUS_COPY.recentFolded);
    setHidden(recentBody, !recentOpen);
  }

  /** Folds the panel by itself when it opened by itself and nothing keeps it: nothing in flight, no listed row, no pointer over it. */
  function maybeAutoFold() {
    if (!autoOpened || !wantOpen || board.empty) return;
    if ((board.inFlight ?? 0) > 0 || (board.rows ?? []).length > 0) return;
    if (pointerInPanel) return;
    wantOpen = false;
    autoOpened = false;
    drawChrome();
  }

  /** Whether a row still needs the clock: in flight, quiet, or finished less than 30 s ago. */
  function needsClock(model) {
    return (model.rows ?? []).some((row) => !row.finished || (row.finishedAgo ?? 0) < FINISHED_SHOWN_MS);
  }

  function onTick() {
    tickTimer = null;
    render(getModel === null ? board : getModel());
  }

  function scheduleTick() {
    const needed = needsClock(board);
    if (needed && tickTimer === null) {
      tickTimer = setTimer(onTick, TICK_MS);
    } else if (!needed && tickTimer !== null) {
      clearTimer(tickTimer);
      tickTimer = null;
    }
  }

  function flushLive() {
    liveTimer = null;
    if (liveQueue.length === 0) return;
    live.textContent = joinLive(liveQueue);
    liveQueue = [];
    lastLiveAt = now();
  }

  function scheduleLive() {
    if (liveTimer !== null || liveQueue.length === 0) return;
    const wait = lastLiveAt === null ? 0 : Math.max(0, lastLiveAt + LIVE_EVERY_MS - now());
    if (wait === 0) flushLive();
    else liveTimer = setTimer(flushLive, wait);
  }

  /** Draws the model of page/request-status.js: the chip, its count, the rows and the Recent group. */
  function render(model) {
    board = model;
    const flight = model.inFlight ?? 0;
    setText(count, String(flight));
    setHidden(count, flight === 0);
    setAttr(
      toggle,
      'aria-label',
      flight === 0 ? REQUEST_STATUS_COPY.chipNameNone : fill(REQUEST_STATUS_COPY.chipNameFlight, { n: flight }),
    );
    setAttr(toggle, 'data-inflight', String(flight > 0));
    const listed = model.rows ?? [];
    const kept = model.recent ?? [];
    dropGone(new Set([...listed, ...kept].map((row) => row.id)));
    drawRows(list, listed);
    drawRows(recentBody, kept);
    drawRecent();
    drawChrome();
    maybeAutoFold();
    const sentences = takeLive();
    if (sentences.length > 0) {
      liveQueue.push(...sentences);
      scheduleLive();
    }
    scheduleTick();
  }

  function open({ byKeyboard = false } = {}) {
    if (!wantOpen) {
      onOpen();
      wantOpen = true;
    }
    // Opening by hand is the user's own act, whatever opened it before.
    autoOpened = false;
    drawChrome();
    if (byKeyboard && showPanel()) focusFirst();
  }

  /** Folds the panel; with `focusChip` focus goes back to the chip (Esc does that), otherwise focus stays where it is. */
  function close({ focusChip = false } = {}) {
    if (wantOpen) {
      wantOpen = false;
      autoOpened = false;
      drawChrome();
    }
    if (focusChip) toggle.focus();
  }

  /** The user sent a request: the panel opens by itself and focus stays where it is. */
  function noteSend() {
    if (wantOpen) return;
    onOpen();
    wantOpen = true;
    autoOpened = true;
    drawChrome();
  }

  function focusFirst() {
    const first = list.querySelector('.rq-row');
    if (first) first.focus();
    else panel.focus();
  }

  // Keeps focus where it is on a press, so a click does not move it; a keyboard activation (a click event with no
  // detail) that opens the panel moves focus to its first row.
  toggle.addEventListener('mousedown', (event) => event.preventDefault());
  toggle.addEventListener('click', (event) => {
    if (wantOpen) close();
    else open({ byKeyboard: event.detail === 0 });
  });

  recentHead.addEventListener('click', () => {
    recentOpen = !recentOpen;
    drawRecent();
  });

  // Esc folds the panel and gives focus back to the chip; it never reaches a view or the Ask box. With the panel
  // folded it is left to the page.
  const onKeydown = (event) => {
    if (event.key !== 'Escape' || !wantOpen) return;
    event.preventDefault();
    event.stopPropagation();
    close({ focusChip: true });
  };
  toggle.addEventListener('keydown', onKeydown);
  panel.addEventListener('keydown', onKeydown);

  panel.addEventListener('pointerenter', () => {
    pointerInPanel = true;
  });
  panel.addEventListener('pointerleave', () => {
    pointerInPanel = false;
    maybeAutoFold();
  });
  // Focus inside makes the panel the user's; it never folds by itself under a focused row.
  panel.addEventListener('focusin', (event) => {
    if (panel.contains(event.target)) autoOpened = false;
  });

  return { render, noteSend, open, close, isOpen: () => showPanel() };
}
