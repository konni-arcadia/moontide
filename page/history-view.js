// The History view's DOM: one row per version, newest first, built with DOM methods
// only. Every text reaches the page through textContent or title, never as markup: versions'
// code, labels and names are written by a person or by Claude and are not trusted. No DOM
// access at import time: main.js calls createHistoryView() with its document and a send
// function, so this module can be loaded anywhere. Pure helpers live in page/history.js.

import {
  HISTORY_COPY,
  RESTORE_TIMEOUT_MS,
  SHOW_MORE_TIMEOUT_MS,
  showMoreText,
  sessionDividerAfter,
  formatDividerText,
  scrollTopAfterInsert,
  ORIGIN_NAMES,
  versionText,
  rowLabelText,
  restoreAriaLabel,
  toggleAriaLabel,
  versionCountText,
  restoreStatusText,
  historyMessageText,
  formatRowTime,
  emptyHistoryModel,
  applyHistoryMessage,
  computeLanes,
  laneGeometry,
  branchColor,
  historyKeyAction,
  moveSelection,
  previousVersionOf,
  summarizeChange,
  diffLines,
  countChanges,
  foldDiff,
  diffHeaderText,
  unchangedLinesText,
  noChangesText,
} from './history.js';

// Tree drawing proportions: a row's node is centered on the middle of
// its first text line, 0.859375rem below the row top; lane lines and elbows are 0.125rem wide. Only
// numbers (columns, rem offsets, color indexes) are written into the DOM here, never markup.
const NODE_CENTER_REM = 0.859375;
const LINE_HALF_REM = 0.0625;

/**
 * Creates the History view controller. `document` is the page's document (the parameter is
 * named so on purpose: every element lookup below reads `document.getElementById`, the shape
 * test/page-hidden.test.js scans); `send` sends one JSON-able message to the server;
 * `reportError` shows a short error in the top bar (main.js passes its own error line);
 * `getParse` returns the page's JavaScript parser function (window.acorn.parse) or null, used to
 * name the tracks a version changed.
 */
export function createHistoryView({ document, send, reportError, getParse, onModeChange }) {
  const historyView = document.getElementById('history-view');
  const modeButtons = {
    list: document.getElementById('history-mode-list'),
    tree: document.getElementById('history-mode-tree'),
  };
  const historyList = document.getElementById('history-list');
  const historyScroll = document.getElementById('history-scroll');
  const historyBody = document.getElementById('history-body');
  const historyCount = document.getElementById('history-count');
  const historyNotice = document.getElementById('history-notice');
  const historyMessage = document.getElementById('history-message');
  const historyDetail = document.getElementById('history-detail');
  const historyMore = document.getElementById('history-more');
  const historyMoreStatus = document.getElementById('history-more-status');

  let model = emptyHistoryModel();
  let currentId = null;
  let viewOpen = false;
  // 'a' | 'b' | 'c': in layout a an expanded diff opens in #history-detail beside the list, in
  // layouts b and c inside its own row.
  let layout = 'a';
  // The version whose diff is open, or null. View state: kept across layout changes, forgotten on reload.
  let expandedId = null;
  let live = false;
  // 'list' | 'tree': tree draws the branch lines in every row's graph cell.
  let mode = 'list';
  // 'connecting' until the socket opens; restoring works only while 'connected'.
  let connection = 'connecting';
  // The restore waiting for the server, or null: { id, newestAtClick, timer }.
  let pending = null;
  // The Show older versions request waiting for the server, or null: { timer }.
  let loadingOlder = null;
  // True after a Show older versions request got no answer in time, until the next click.
  let loadOlderFailed = false;
  // version id -> its row element, so a live addition reuses the rows already drawn.
  const rows = new Map();
  // One parse per distinct code: code text -> its tracks (or a parse failure).
  const parseCache = new Map();
  // version id -> { previousId, summary, ops }: computed once when the row is built, so the
  // counts on the row and the expanded diff come from the same ops and always agree.
  const analyses = new Map();
  let warnedNoParse = false;
  // ids of the rows the pointer or the keyboard focus is on right now (they show "Restore").
  const hotIds = new Set();
  // The keyboard selection: a version id, 'more' (the Show older versions control) or null. Kept by
  // id, so live rows and older rows loading never move it. DOM focus is not moved by the keys.
  let selectedId = null;
  // True between a Space keydown the History path handled and its keyup, so the key release
  // cannot click a focused button (some browsers click on Space keyup).
  let spaceHandled = false;

  function makeSpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  /** Brings one row's marks in line with the current state: current, live, pending, status, disabled. */
  function refreshRow(row) {
    const id = Number(row.dataset.id);
    const isCurrent = id === currentId;
    const isPending = pending !== null && pending.id === id;
    const isHot = (hotIds.has(id) || selectedId === id) && connection === 'connected';
    row.dataset.current = String(isCurrent);
    if (selectedId === id) {
      row.dataset.selected = 'true';
    } else {
      delete row.dataset.selected;
    }
    row.dataset.live = String(isCurrent && live);
    if (isPending) {
      row.dataset.pending = 'true';
    } else {
      delete row.dataset.pending;
    }

    // In list mode the graph gutter holds one node, on the current row only. In tree mode
    // renderGraphs draws every node, and the current one is marked by the row's data-current.
    if (mode === 'list') {
      const graph = row.querySelector('.hist-graph');
      const node = graph.querySelector('.hist-node');
      if (isCurrent && !node) {
        const dot = document.createElement('span');
        dot.className = 'hist-node';
        graph.appendChild(dot);
      } else if (!isCurrent && node) {
        node.remove();
      }
    }

    const text = restoreStatusText({ isCurrent, isPending, isHot });
    const status = row.querySelector('.hist-status');
    status.textContent = text;
    status.className = text === HISTORY_COPY.current ? 'hist-status hist-current' : 'hist-status';

    // Nothing to restore on the current row, and nothing works while disconnected. The text
    // keeps its full color: the notice explains it, dimming would read as a broken list. The
    // accessible name follows the same state, so it never offers a restore that will not happen.
    const connected = connection === 'connected';
    const main = row.querySelector('.hist-main');
    main.setAttribute('aria-disabled', String(isCurrent || !connected));
    main.setAttribute('aria-label', restoreAriaLabel(id, { isCurrent, connected }));
  }

  function refreshAllRows() {
    for (const row of rows.values()) refreshRow(row);
  }

  /** Compares a version against the one before it and keeps the result by id. */
  function analyze(version, index) {
    const previous = previousVersionOf(model, index);
    const parse = getParse();
    if (parse === null && !warnedNoParse) {
      warnedNoParse = true;
      console.error('Moontide: window.acorn is not available — History summaries show "Code changed".');
    }
    const analysis = {
      previousId: previous ? previous.id : null,
      summary: summarizeChange(previous ? previous.code : null, version.code, { parse, cache: parseCache }),
      ops: diffLines(previous ? previous.code : null, version.code),
    };
    analyses.set(version.id, analysis);
    return analysis;
  }

  /**
   * Shows or clears the favorite mark on line 1 of a row: a star and the name, after the label. The
   * page only shows favorites; making or renaming one stays a request to Claude.
   */
  function setFavorite(row, name) {
    const line1 = row.querySelector('.hist-line1');
    const existing = line1.querySelector('.hist-favorite');
    if (existing) existing.remove();
    if (name === undefined) return;
    const favorite = document.createElement('span');
    favorite.className = 'hist-favorite';
    const star = makeSpan('hist-star', '\u2605');
    star.setAttribute('aria-hidden', 'true');
    star.title = HISTORY_COPY.favoriteTitle;
    favorite.appendChild(star);
    const nameSpan = makeSpan('hist-favorite-name', name);
    nameSpan.title = name;
    favorite.appendChild(nameSpan);
    line1.insertBefore(favorite, line1.querySelector('.hist-status'));
  }

  /**
   * Keeps one divider directly below each row that starts a session between two versions: adds the
   * missing ones, fixes a changed text and removes the ones that no longer apply, so a divider is
   * never drawn twice and rows already on screen are left where they are.
   */
  function syncDividers() {
    model.versions.forEach((version, index) => {
      const row = rows.get(version.id);
      if (!row) return;
      const at = sessionDividerAfter(model, index);
      const next = row.nextElementSibling;
      const divider = next && next.classList.contains('hist-divider') ? next : null;
      if (at === null) {
        if (divider) divider.remove();
        return;
      }
      const text = formatDividerText(at);
      if (divider) {
        const textEl = divider.querySelector('.hist-divider-text');
        if (textEl.textContent !== text) textEl.textContent = text;
        return;
      }
      const created = document.createElement('li');
      created.className = 'hist-divider';
      const graph = document.createElement('div');
      graph.className = 'hist-graph';
      created.appendChild(graph);
      created.appendChild(makeSpan('hist-divider-text', text));
      row.after(created);
    });
  }

  function buildLine2(analysis) {
    const line2 = document.createElement('span');
    line2.className = 'hist-line2';
    const summary = makeSpan('hist-summary', analysis.summary);
    summary.title = analysis.summary;
    line2.appendChild(summary);
    const counts = makeSpan('hist-counts', '');
    const changes = countChanges(analysis.ops);
    if (changes !== null) {
      if (changes.added > 0) counts.appendChild(makeSpan('hist-count-add', `+${changes.added}`));
      if (changes.removed > 0) counts.appendChild(makeSpan('hist-count-remove', `\u2212${changes.removed}`));
    }
    line2.appendChild(counts);
    return line2;
  }

  function buildRow(version, index) {
    const row = document.createElement('li');
    row.className = 'hist-row';
    row.dataset.id = String(version.id);
    row.dataset.origin = version.origin;
    if (version.restoredFrom !== undefined) {
      row.dataset.restoredFrom = String(version.restoredFrom);
    }

    const graph = document.createElement('div');
    graph.className = 'hist-graph';
    row.appendChild(graph);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'hist-main';

    const line1 = document.createElement('span');
    line1.className = 'hist-line1';
    line1.appendChild(makeSpan('hist-version', versionText(version.id)));
    line1.appendChild(makeSpan('hist-time', formatRowTime(version.at)));
    line1.appendChild(makeSpan('hist-origin', ORIGIN_NAMES[version.origin] ?? version.origin));
    const labelText = rowLabelText(version);
    if (labelText !== '') {
      const label = makeSpan('hist-label', labelText);
      label.title = labelText;
      line1.appendChild(label);
    }
    line1.appendChild(makeSpan('hist-status', ''));
    main.appendChild(line1);
    main.appendChild(buildLine2(analyze(version, index)));
    row.appendChild(main);
    setFavorite(row, version.favorite);

    const setHot = (isHot) => {
      if (isHot) {
        hotIds.add(version.id);
      } else {
        hotIds.delete(version.id);
      }
      refreshRow(row);
    };
    main.addEventListener('pointerenter', () => setHot(true));
    main.addEventListener('pointerleave', () => setHot(false));
    main.addEventListener('focus', () => setHot(true));
    main.addEventListener('blur', () => setHot(false));
    // A click or the keyboard focus on a row selects it, so the keys continue from where the user is.
    main.addEventListener('focus', () => setSelected(version.id));
    main.addEventListener('click', () => {
      setSelected(version.id);
      restoreVersion(version.id);
    });

    // The toggle is a sibling of the restore button, never inside it: a click here opens or
    // closes the diff and sends nothing.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'hist-toggle';
    toggle.textContent = HISTORY_COPY.toggleShow;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', toggleAriaLabel(version.id, false));
    toggle.addEventListener('focus', () => setSelected(version.id));
    toggle.addEventListener('click', () => {
      setSelected(version.id);
      toggleDiff(version.id);
    });
    row.appendChild(toggle);

    refreshRow(row);
    return row;
  }

  function buildDiffLine(kind, sign, text) {
    const line = document.createElement('div');
    line.className = 'hist-diff-line';
    line.dataset.kind = kind;
    line.appendChild(makeSpan('hist-diff-sign', sign));
    line.appendChild(makeSpan('hist-diff-text', text));
    return line;
  }

  /** The expanded diff of one version, built from the same ops its row's counts came from. */
  function buildDiff(id) {
    const analysis = analyses.get(id);
    const diff = document.createElement('div');
    diff.className = 'hist-diff';
    diff.dataset.id = String(id);
    diff.appendChild(makeSpan('hist-diff-header', diffHeaderText(id, analysis.previousId)));
    if (analysis.ops === null) {
      diff.appendChild(makeSpan('hist-diff-message', HISTORY_COPY.tooLarge));
      return diff;
    }
    const folded = foldDiff(analysis.ops);
    if (folded.length === 0) {
      diff.appendChild(makeSpan('hist-diff-message', noChangesText(analysis.previousId)));
      return diff;
    }
    for (const op of folded) {
      if (op.type === 'gap') {
        diff.appendChild(buildDiffLine('gap', '', unchangedLinesText(op.count)));
      } else if (op.type === 'add') {
        diff.appendChild(buildDiffLine('add', '+', op.text));
      } else if (op.type === 'del') {
        diff.appendChild(buildDiffLine('del', '\u2212', op.text));
      } else {
        diff.appendChild(buildDiffLine('ctx', '', op.text));
      }
    }
    return diff;
  }

  /** Puts the toggles and the one open diff in line with the state: beside the list in layout a, under the row otherwise. */
  function renderDetail() {
    if (expandedId !== null && !rows.has(expandedId)) expandedId = null;
    for (const [id, row] of rows) {
      const open = id === expandedId;
      const toggle = row.querySelector('.hist-toggle');
      toggle.textContent = open ? HISTORY_COPY.toggleHide : HISTORY_COPY.toggleShow;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', toggleAriaLabel(id, open));
      const inline = row.querySelector('.hist-diff');
      if (inline) inline.remove();
    }
    historyDetail.replaceChildren();
    if (expandedId === null) {
      if (layout === 'a') {
        const placeholder = document.createElement('p');
        placeholder.className = 'hist-detail-placeholder';
        placeholder.textContent = HISTORY_COPY.detailPlaceholder;
        historyDetail.appendChild(placeholder);
      }
      return;
    }
    const diff = buildDiff(expandedId);
    if (layout === 'a') {
      historyDetail.appendChild(diff);
    } else {
      rows.get(expandedId).appendChild(diff);
    }
  }

  /** Opens the diff of one version, or closes it when it is the one open. */
  function toggleDiff(id) {
    expandedId = expandedId === id ? null : id;
    renderDetail();
  }

  /** Brings a version back: the one path a click and the Enter key share. Nothing to do for the current version, a restore already waiting, or while disconnected. */
  function restoreVersion(id) {
    if (connection !== 'connected' || pending !== null || id === currentId) return;
    startRestore(id);
  }

  /** Moves the selection to a version id, 'more' or null, and optionally scrolls it into view. */
  function setSelected(next, { scroll = false } = {}) {
    selectedId = next;
    refreshAllRows();
    if (next === 'more') {
      historyMore.dataset.selected = 'true';
    } else {
      delete historyMore.dataset.selected;
    }
    if (!scroll || next === null) return;
    const target = next === 'more' ? historyMore : rows.get(next);
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
  }

  /** The row selected when the view opens: the current one, else the newest, else nothing yet. */
  function defaultSelection() {
    if (currentId !== null && rows.has(currentId)) return currentId;
    return model.versions.length > 0 ? model.versions[0].id : null;
  }

  /** Keeps the selection on something that exists: picks the default when none, moves off a vanished row or a hidden More control. */
  function ensureSelection() {
    if (!viewOpen) return;
    if (selectedId === 'more' && historyMore.hidden) {
      setSelected(model.versions.length > 0 ? model.versions[model.versions.length - 1].id : null);
    } else if (selectedId === null || (selectedId !== 'more' && !rows.has(selectedId))) {
      setSelected(defaultSelection(), { scroll: selectedId === null });
    }
  }

  function startRestore(id) {
    pending = {
      id,
      newestAtClick: model.versions.length > 0 ? model.versions[0].id : 0,
      timer: setTimeout(() => {
        endPending();
        reportError(HISTORY_COPY.restoreDidNotComplete);
      }, RESTORE_TIMEOUT_MS),
    };
    refreshAllRows();
    send({ type: 'history-restore', id });
  }

  /** Ends a pending restore (whatever the reason) and clears its timer. Safe to call when none is pending. */
  function endPending() {
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending = null;
    refreshAllRows();
  }

  /** True for the version a restore of this page is waiting for: that arrival scrolls to the top on purpose. */
  function isOwnRestore(version) {
    return pending !== null && version.origin === 'page' && version.restoredFrom === pending.id;
  }

  /** A restore is answered by a newer version that is a page restore of the clicked one. */
  function pendingIsAnswered() {
    return (
      pending !== null &&
      model.versions.some(
        (v) => v.id > pending.newestAtClick && v.origin === 'page' && v.restoredFrom === pending.id,
      )
    );
  }

  /** The Show older versions control: shown while older versions remain, disabled while loading or offline. */
  function renderMore() {
    const visible = model.status === 'ready' && model.remaining > 0;
    historyMore.hidden = !visible;
    historyMore.textContent = loadingOlder !== null ? HISTORY_COPY.loadingOlder : showMoreText(model.remaining);
    historyMore.disabled = loadingOlder !== null || connection !== 'connected';
    historyMoreStatus.textContent = loadOlderFailed ? HISTORY_COPY.loadOlderFailed : '';
    historyMoreStatus.hidden = !(visible && loadOlderFailed);
  }

  /** Ends a Show older versions request (whatever the reason) and clears its timer. */
  function endLoadingOlder() {
    if (loadingOlder === null) return;
    clearTimeout(loadingOlder.timer);
    loadingOlder = null;
  }

  /** Asks the server for the next older versions: the one path a click and the Enter key share. */
  function loadOlder() {
    if (connection !== 'connected' || loadingOlder !== null || model.versions.length === 0) return;
    loadOlderFailed = false;
    loadingOlder = {
      timer: setTimeout(() => {
        loadingOlder = null;
        loadOlderFailed = true;
        renderMore();
      }, SHOW_MORE_TIMEOUT_MS),
    };
    renderMore();
    send({ type: 'history-more', before: model.versions[model.versions.length - 1].id });
  }

  historyMore.addEventListener('focus', () => setSelected('more'));
  historyMore.addEventListener('click', () => {
    setSelected('more');
    loadOlder();
  });

  /** Adds one drawn piece (a line, an elbow or a node) to a graph cell, colored by its lane. */
  function addPiece(graph, className, column) {
    const piece = document.createElement('span');
    piece.className = className;
    piece.dataset.color = String(branchColor(column));
    graph.appendChild(piece);
    return piece;
  }

  /** One 0.125rem vertical piece of a lane, from `top` to `bottom` (CSS lengths), centered on its column. */
  function addLaneLine(graph, pitchRem, column, top, bottom) {
    const line = addPiece(graph, 'hist-lane-line', column);
    line.style.left = `${(column + 0.5) * pitchRem - LINE_HALF_REM}rem`;
    line.style.top = top;
    line.style.bottom = bottom;
  }

  /**
   * An elbow: the ended column's line comes down from the top of the row to the node's height, then a
   * 0.125rem horizontal piece runs over to the node. One box with two borders, so the corner is exact.
   */
  function addElbow(graph, pitchRem, column, endedColumn) {
    const elbow = addPiece(graph, 'hist-elbow', endedColumn);
    elbow.style.left = `${(column + 0.5) * pitchRem}rem`;
    elbow.style.width = `${(endedColumn - column) * pitchRem + LINE_HALF_REM}rem`;
    elbow.style.top = '-1px';
    elbow.style.bottom = `calc(100% - ${NODE_CENTER_REM + LINE_HALF_REM}rem)`;
  }

  /** Draws one row's graph cell in tree mode from its lane info: through lines, elbows, its own lines, then its node. */
  function drawRowGraph(graph, info, pitchRem) {
    for (const column of info.through) addLaneLine(graph, pitchRem, column, '-1px', '-1px');
    for (const ended of info.ends) addElbow(graph, pitchRem, info.column, ended);
    if (info.lineAbove) addLaneLine(graph, pitchRem, info.column, '-1px', `calc(100% - ${NODE_CENTER_REM}rem)`);
    if (info.lineBelow) addLaneLine(graph, pitchRem, info.column, `${NODE_CENTER_REM}rem`, '-1px');
    const node = addPiece(graph, 'hist-node', info.column);
    node.style.left = `${(info.column + 0.5) * pitchRem - 0.25}rem`;
  }

  /** A session divider's cell: one full-height line for every column still waiting for a parent below. */
  function drawDividerGraph(graph, lanesAfter, pitchRem) {
    lanesAfter.forEach((waits, column) => {
      if (waits) addLaneLine(graph, pitchRem, column, '-1px', '-1px');
    });
  }

  /**
   * Puts every graph cell in line with the display mode. List: the plain 1rem gutter with the
   * current row's node. Tree: lanes are computed over every loaded row from the parent the server
   * sent (never guessed) and each row's cell is rebuilt; rows themselves are not touched.
   */
  function renderGraphs() {
    const previousMode = historyView.dataset.mode;
    historyView.dataset.mode = mode;
    for (const [name, button] of Object.entries(modeButtons)) {
      button.setAttribute('aria-pressed', String(name === mode));
    }
    if (mode !== 'tree') {
      // Rows built while the list shows get their node from refreshRow; only a switch back needs a reset.
      if (previousMode === 'list') return;
      historyView.style.removeProperty('--graph-width');
      for (const row of rows.values()) {
        row.querySelector('.hist-graph').replaceChildren();
        delete row.dataset.lane;
        delete row.dataset.parent;
      }
      for (const divider of historyList.querySelectorAll('.hist-divider .hist-graph')) divider.replaceChildren();
      refreshAllRows();
      return;
    }
    const { rows: lanes, maxLanes } = computeLanes(model.versions.map((v) => ({ id: v.id, parent: v.parent })));
    const { pitchRem, widthRem } = laneGeometry(maxLanes);
    historyView.style.setProperty('--graph-width', `${widthRem}rem`);
    lanes.forEach((info, index) => {
      const row = rows.get(info.id);
      if (!row) return;
      row.dataset.lane = String(info.column + 1);
      if (info.lineBelow) {
        row.dataset.parent = String(model.versions[index].parent);
      } else {
        delete row.dataset.parent;
      }
      const graph = row.querySelector('.hist-graph');
      graph.replaceChildren();
      drawRowGraph(graph, info, pitchRem);
      // A divider right below this row carries the lanes that keep waiting, so no line breaks there.
      const below = row.nextElementSibling;
      if (below && below.classList.contains('hist-divider')) {
        const dividerGraph = below.querySelector('.hist-graph');
        dividerGraph.replaceChildren();
        drawDividerGraph(dividerGraph, info.lanesAfter, pitchRem);
      }
    });
  }

  function renderShell() {
    const message = historyMessageText(model);
    historyMessage.textContent = message ?? '';
    historyMessage.hidden = message === null;
    historyBody.hidden = message !== null;
    historyCount.textContent = model.status === 'ready' ? versionCountText(model.total) : '';
    historyNotice.textContent = connection === 'disconnected' ? HISTORY_COPY.disconnected : '';
    historyNotice.hidden = connection !== 'disconnected';
    renderMore();
  }

  function renderAll() {
    endLoadingOlder();
    loadOlderFailed = false;
    rows.clear();
    analyses.clear();
    // The old row elements are gone and a removed element does not reliably fire pointerleave or
    // blur, so no id can still count as hovered or focused.
    hotIds.clear();
    const built = model.versions.map((version, index) => {
      const row = buildRow(version, index);
      rows.set(version.id, row);
      return row;
    });
    historyList.replaceChildren(...built);
    syncDividers();
  }

  /**
   * Puts a live version in the list. A new version goes at the top; when the user has scrolled
   * down, the height it adds (the row and a divider under it) is added to the scroll position so
   * the rows on screen do not move. At the top the list grows downward. With motion on, the new
   * row fades in over 150 ms (data-shown false, then true on the next frame); with motion off it
   * is simply there. `overflow-anchor: none` on #history-scroll keeps the browser from correcting
   * the scroll a second time.
   */
  function addOne(version) {
    // A replaced row's element will not report its pointerleave or blur (same reason as renderAll),
    // so its id stops counting as hovered or focused before the new row is built.
    if (rows.has(version.id)) hotIds.delete(version.id);
    const row = buildRow(
      version,
      model.versions.findIndex((v) => v.id === version.id),
    );
    const previous = rows.get(version.id);
    rows.set(version.id, row);
    if (previous) {
      previous.replaceWith(row);
      syncDividers();
      return;
    }
    const scrollTop = historyScroll.scrollTop;
    const heightBefore = historyScroll.scrollHeight;
    const fades = document.documentElement.dataset.motion !== 'off';
    if (fades) row.dataset.shown = 'false';
    historyList.prepend(row);
    syncDividers();
    const heightAfter = historyScroll.scrollHeight;
    if (!isOwnRestore(version)) {
      historyScroll.scrollTop = scrollTopAfterInsert({ scrollTop, heightBefore, heightAfter });
    }
    if (fades) {
      requestAnimationFrame(() => {
        row.dataset.shown = 'true';
      });
    }
  }

  /** Appends the rows of a batch of older versions below the loaded ones; rows above never move. */
  function appendOlder(previousCount) {
    const built = model.versions.slice(previousCount).map((version, offset) => {
      const row = buildRow(version, previousCount + offset);
      rows.set(version.id, row);
      return row;
    });
    historyList.append(...built);
    syncDividers();
  }

  for (const [name, button] of Object.entries(modeButtons)) {
    button.textContent = name === 'tree' ? HISTORY_COPY.modeTree : HISTORY_COPY.modeList;
    button.addEventListener('click', () => {
      if (name !== mode && typeof onModeChange === 'function') onModeChange(name);
    });
  }
  document.getElementById('history-mode').setAttribute('aria-label', HISTORY_COPY.modeGroupLabel);

  renderShell();
  renderGraphs();

  return {
    /** Handles the server's history, history-add, history-older, history-older-error, history-favorite and history-error messages. */
    onServerMessage(msg) {
      const previousModel = model;
      model = applyHistoryMessage(model, msg);
      if (msg.type === 'history') {
        renderAll();
      } else if (msg.type === 'history-add') {
        addOne(msg.version);
      } else if (msg.type === 'history-older' && model !== previousModel) {
        endLoadingOlder();
        loadOlderFailed = false;
        appendOlder(previousModel.versions.length);
      } else if (msg.type === 'history-older-error') {
        // The loaded rows stay; the Show older versions control offers "try again" right away.
        endLoadingOlder();
        loadOlderFailed = true;
      } else if (msg.type === 'history-favorite') {
        const row = rows.get(msg.id);
        if (row) setFavorite(row, msg.name);
      }
      if (msg.type === 'history' || msg.type === 'history-add') renderDetail();
      if (msg.type === 'history' || msg.type === 'history-add' || model !== previousModel) renderGraphs();
      renderShell();
      if (pendingIsAnswered()) {
        // The user's own restore arrived: its new row becomes the selected one.
        const answer = model.versions.find(
          (v) => v.id > pending.newestAtClick && v.origin === 'page' && v.restoredFrom === pending.id,
        );
        endPending();
        if (answer) setSelected(answer.id);
        // The one case where the list moves by itself: the user caused it.
        historyScroll.scrollTop = 0;
      }
      ensureSelection();
    },

    /**
     * Describes what a right-click on `element` points at, for the Ask Claude box: the version
     * of the row it is on, or of the diff it is in (inline, or the layout a pane), with the label the
     * row shows. Returns null for the rest of the view (the header, a session divider, Show older
     * versions, the message) and for a version no longer in the model. It only reads; the one
     * right-click listener lives in main.js.
     */
    askTarget(element) {
      const owner = element.closest('.hist-row[data-id]') ?? element.closest('#history-detail .hist-diff[data-id]');
      if (owner === null) return null;
      const id = Number(owner.dataset.id);
      const version = model.versions.find((v) => v.id === id);
      if (version === undefined) return null;
      const label = rowLabelText(version);
      return label === '' ? { kind: 'version', id } : { kind: 'version', id, label };
    },

    /** Moves the "current" mark to the row of the version playing now (when it is loaded). */
    setCurrent(versionId) {
      currentId = versionId;
      refreshAllRows();
    },

    /** Told by main.js whether the view is open and which layout is showing. */
    setViewContext({ open, layout: nextLayout, mode: nextMode }) {
      if (nextLayout && nextLayout !== layout) {
        layout = nextLayout;
        renderDetail();
      }
      if (nextMode && nextMode !== mode) {
        mode = nextMode;
        renderGraphs();
      }
      const opened = open && !viewOpen;
      viewOpen = open;
      // On open the selection starts on the current row (else the newest) and scrolls into view.
      if (opened) setSelected(defaultSelection(), { scroll: true });
    },

    /**
     * The History keys: arrows move the selection, Enter brings the selected version
     * back, Space opens or closes its diff. Called by main.js only for a key the view keys did not
     * take. Returns true when the key was handled here.
     */
    handleKeydown(event, { focusInEditor }) {
      if (event.key === ' ') spaceHandled = false;
      const active = document.activeElement;
      let focusKind = 'other-control';
      if (focusInEditor) {
        focusKind = 'editor';
      } else if (!active || active === document.body || active === document.documentElement) {
        focusKind = 'body';
      } else if (active === historyMore) {
        focusKind = 'history-more';
      } else if (historyList.contains(active) && active.classList.contains('hist-main')) {
        focusKind = 'history-main';
      } else if (historyList.contains(active) && active.classList.contains('hist-toggle')) {
        focusKind = 'history-toggle';
      }
      const selectionKind =
        selectedId === 'more' ? 'more' : selectedId !== null && rows.has(selectedId) ? 'row' : 'none';
      const { action, preventDefault } = historyKeyAction({
        key: event.key,
        viewOpen,
        focusKind,
        repeat: event.repeat === true,
        selectionKind,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      });
      if (preventDefault) {
        event.preventDefault();
        if (event.key === ' ') spaceHandled = true;
      }
      if (action === 'up' || action === 'down') {
        const next = moveSelection({
          ids: model.versions.map((v) => v.id),
          hasMore: !historyMore.hidden,
          selected: selectedId,
          direction: action,
        });
        if (next !== selectedId) setSelected(next, { scroll: true });
      } else if (action === 'restore') {
        restoreVersion(selectedId);
      } else if (action === 'toggle') {
        toggleDiff(selectedId);
      } else if (action === 'loadMore') {
        loadOlder();
      }
      return action !== 'none' || preventDefault;
    },

    /** A Space keyup never clicks a button when the History path handled the Space keydown. */
    handleKeyup(event) {
      if (event.key !== ' ' || !spaceHandled) return;
      spaceHandled = false;
      event.preventDefault();
    },

    /** The current row's dot and word take the accent only while sound is playing. */
    setLive(isPlaying) {
      live = isPlaying;
      refreshAllRows();
    },

    /** 'connecting' | 'connected' | 'disconnected'. Restore works only while connected. */
    setConnected(state) {
      connection = state;
      if (state !== 'connected') endPending();
      renderShell();
      refreshAllRows();
    },

    /** The page showed an evaluation error: a restore that was waiting will not answer any more. */
    onEvalError() {
      endPending();
    },
  };
}
