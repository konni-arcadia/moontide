// DOM view of Moontide's Song grid in the Parts view: a table with one column per section entry and one row per group or
// track, drawn from the model of page/song-grid-model.js. Everything that comes from the code (names, harmony text,
// counts) reaches the page through textContent, title and setAttribute only, and nodes are built with createElement.
// Gestures are routed by one delegated listener per kind of event on the table to the handlers the page passes in; a
// gesture whose handler is missing throws, so nothing is ignored silently. The live tick writes only what changed.
// `document` is injected, so the module has no DOM access at import time and node:test drives it with a fake document.

import { cellFitPrefill } from './ask.js';
import { SONG_COPY } from './structure.js';
import { SONG_GRID_DEEP_FROM, controlsDisabled, gridMove, headerLive, launchOptions, listPlacement, nowText } from './song-grid-model.js';

/** The deepest indent the name column shows, in levels; deeper rows keep this indent. */
const MAX_INDENT_LEVELS = 4;

/** The id of the muted line in the list that says a change applies to every use of a section. */
const LIST_NOTE_ID = 'song-cell-list-note';

/** True for the two keyboard gestures that mean a right-click: the Menu key, and F10 with Shift (and no other modifier). */
function isAskKey(event) {
  if (event.altKey || event.metaKey || event.ctrlKey) return false;
  if (event.key === 'ContextMenu') return !event.shiftKey;
  return event.key === 'F10' && event.shiftKey === true;
}

/** The keys the grid moves focus with. */
const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * `createSongGridView({ document, rows, bar, now, line, launchGroup, list, handlers })` returns `{ render(model), tick(live),
 * hide(), scrollPlayingIntoView(), openList(cellButton), closeList(), isListOpen(), askTarget(element) }`. `rows` is the element the grid is
 * drawn in, `bar` the toolbar above it, `now` the line that says which section plays, `line` the sentence that says why the
 * grid is off, what waits or why a gesture changed nothing, `launchGroup` the group that holds the three launch buttons and
 * `list` the popup that opens on a cell. `handlers` is an object of functions keyed by gesture (`fold(groupKey)`,
 * `launchChoice(value)`, `launch(sectionIndex)`, `choose(seen, choice)`); a gesture whose handler is absent throws. A click
 * on a cell opens the list; choosing an option calls `choose` with what the person saw (`{ track, index, name, length, key }`
 * of the cell, `key` null for a rest) and the choice (`{ key }` or `{ rest: true }`). A grid that is drawn again while the
 * list is open waits until it closes. `askTarget(element)` says what a right-click on `element` asks about (see below), and
 * the Menu key or Shift+F10 on a focused control calls `handlers.ask(descriptor, point)` with the same descriptor and the
 * centre of the control.
 */
export function createSongGridView({ document, rows, bar, now, line, launchGroup, list, handlers }) {
  for (const [name, element] of Object.entries({ rows, bar, now, line, launchGroup, list })) {
    if (!element) throw new Error(`Moontide: the song grid view needs its '${name}' element.`);
  }
  let model = null;
  let scroller = null;
  // The controls of the grid drawn now, by node and by position.
  let controls = new Map();
  let byPosition = new Map();
  let heads = [];
  let cols = [];
  // The rows that are not controls themselves (a group row, a track row), by node, with what a right-click on them asks about.
  let askRows = new Map();
  let roving = null;
  let shownPlaying = -1;
  let rovingPosition = null;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className !== '') node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The launch choice: three buttons that say when a launched section starts; the pressed one is the choice in the model.
  const launchButtons = launchOptions().map((option) => {
    const button = make('button', '', option.label);
    button.setAttribute('type', 'button');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', option.name);
    button.setAttribute('data-value', option.value);
    return { option, button, pressed: 'false' };
  });
  launchGroup.setAttribute('title', SONG_COPY.launchGroupTitle);
  launchGroup.replaceChildren(...launchButtons.map((entry) => entry.button));
  launchGroup.addEventListener('click', (event) => {
    const entry = launchButtons.find((candidate) => candidate.button === event.target);
    if (entry === undefined) return;
    if (typeof handlers.launchChoice !== 'function') throw new Error("Moontide: the song grid has no handler for 'launchChoice'.");
    handlers.launchChoice(entry.option.value);
  });
  let shownNow = null;
  // The open list: the cell it belongs to, what it shows, its option nodes and the active one; null while closed. A model
  // that arrives while it is open waits in `waitingModel`.
  let open = null;
  let waitingModel = null;
  // The sentence and the switched-off controls the line gave last, so a tick writes only a change.
  let shownLine = { kind: '', text: '' };
  let shownOff = { headers: false, cells: false };

  function positionKey(rowKey, column) {
    return `${rowKey}\u0000${column}`;
  }

  function register(node, info) {
    node.setAttribute('tabindex', '-1');
    controls.set(node, info);
    byPosition.set(positionKey(info.rowKey, info.column), node);
  }

  /** The tab stop moves to `node`; every other control leaves the tab order. */
  function setRoving(node) {
    if (roving === node) return;
    if (roving !== null) roving.setAttribute('tabindex', '-1');
    roving = node;
    node.setAttribute('tabindex', '0');
    rovingPosition = controls.get(node);
  }

  function buildHead(column) {
    const th = make('th', 'song-colhead');
    th.setAttribute('scope', 'col');
    const button = make('button', 'part-card song-head');
    button.setAttribute('type', 'button');
    button.setAttribute('data-part', column.name);
    button.setAttribute('data-index', String(column.index));
    button.setAttribute('data-state', 'idle');
    const name = make('span', 'part-name', column.text);
    if (column.title !== null) name.setAttribute('title', column.title);
    const line = make('span', 'song-head-line');
    const state = make('span', 'part-state', column.lengthText);
    const action = make('span', 'song-head-action', '');
    action.setAttribute('hidden', '');
    line.appendChild(state);
    line.appendChild(action);
    const harmony = make('span', 'song-harmony', column.harmonyText);
    if (column.harmonyTitle !== column.harmonyText) harmony.setAttribute('title', column.harmonyTitle);
    const progress = make('span', 'part-progress');
    const fill = make('span', 'part-progress-fill');
    progress.appendChild(fill);
    button.appendChild(name);
    button.appendChild(line);
    button.appendChild(harmony);
    if (column.usedText !== null) {
      const used = make('span', 'song-used', column.usedText);
      used.setAttribute('title', column.usedTitle);
      button.appendChild(used);
    }
    button.appendChild(progress);
    th.appendChild(button);
    register(button, { kind: 'head', rowKey: 'h', column: column.index + 1, index: column.index });
    heads.push({ th, button, state, action, fill, shown: { state: 'idle', stateText: column.lengthText, action: '', title: '', width: '0%', line: '' } });
    return th;
  }

  function indent(head, row) {
    head.style.setProperty('--depth', String(Math.min(row.depth, MAX_INDENT_LEVELS)));
    if (row.level >= SONG_GRID_DEEP_FROM) head.setAttribute('data-deep', 'true');
  }

  function nameHead(row) {
    const head = make('th', 'song-rowhead');
    head.setAttribute('scope', 'row');
    if (row.title !== null) head.setAttribute('title', row.title);
    indent(head, row);
    return head;
  }

  function buildGroupRow(row, sections) {
    const tr = make('tr', 'song-group-row');
    const head = nameHead(row);
    const fold = make('button', 'song-fold');
    fold.setAttribute('type', 'button');
    fold.setAttribute('aria-expanded', String(row.open));
    fold.setAttribute('title', row.foldTitle);
    const chevron = make('span', 'song-chevron', row.open ? '▾' : '▸');
    chevron.setAttribute('aria-hidden', 'true');
    fold.appendChild(chevron);
    fold.appendChild(make('span', 'song-fold-name', row.text));
    fold.appendChild(make('span', 'song-count', row.countText));
    head.appendChild(fold);
    // The names come from the model, never from the shown text, which may be cut; the parent is the group this one sits in.
    const ask = row.path.length > 1 ? { kind: 'group', name: row.name, parent: row.path[row.path.length - 2] } : { kind: 'group', name: row.name };
    register(fold, { kind: 'fold', rowKey: row.key, column: 0, groupKey: row.groupKey, ask });
    askRows.set(tr, ask);
    tr.appendChild(head);
    const fill = make('td', 'song-group-fill');
    fill.setAttribute('colspan', String(sections));
    tr.appendChild(fill);
    return tr;
  }

  function buildTrackRow(row, columnsByIndex) {
    const tr = make('tr', 'song-track-row');
    const head = nameHead(row);
    head.textContent = row.text;
    askRows.set(tr, { kind: 'track', track: row.name });
    tr.appendChild(head);
    row.cells.forEach((cell) => {
      const td = make('td', 'song-cell-box');
      const button = make('button', 'song-cell');
      button.setAttribute('type', 'button');
      button.setAttribute('data-track', row.name);
      button.setAttribute('data-section', String(cell.section));
      button.setAttribute('data-kind', cell.kind);
      button.setAttribute('title', cell.title);
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-expanded', 'false');
      if (cell.shared) button.setAttribute('data-shared', 'true');
      button.appendChild(make('span', 'song-variation', cell.text));
      // The fit words of a fixed variation, once the page has them: words only, the whole text is in the cell's title.
      if (cell.fit !== null) {
        button.setAttribute('data-fit', cell.fit.state);
        if (cell.fit.outside !== null) button.setAttribute('data-outside', cell.fit.outside);
        button.appendChild(make('span', 'song-fit', cell.fit.line));
      }
      if (cell.wait !== null) button.appendChild(make('span', 'song-wait', cell.wait));
      td.appendChild(button);
      tr.appendChild(td);
      const column = columnsByIndex[cell.section];
      register(button, {
        kind: 'cell',
        rowKey: row.key,
        column: cell.section + 1,
        track: row.name,
        section: cell.section,
        seen: { track: row.name, index: cell.section, name: column.name, length: column.length, key: cell.key },
      });
    });
    return tr;
  }

  function buildOutsideRow(row, sections) {
    const tr = make('tr', 'song-outside-row');
    const head = nameHead(row);
    head.textContent = row.text;
    askRows.set(tr, { kind: 'track', track: row.name });
    tr.appendChild(head);
    const note = make('td', 'song-outside-note', row.note);
    note.setAttribute('colspan', String(sections));
    tr.appendChild(note);
    return tr;
  }

  function buildRow(row, sections) {
    const tr = row.kind === 'group' ? buildGroupRow(row, sections) : row.kind === 'track' ? buildTrackRow(row, model.columns) : buildOutsideRow(row, sections);
    tr.setAttribute('data-key', row.key);
    tr.setAttribute('aria-level', String(row.level));
    if (row.hidden) tr.setAttribute('hidden', '');
    return tr;
  }

  /** The visible rows of the grid as columns that hold a control, header row first (what gridMove reads). */
  function layoutOf() {
    const keys = ['h'];
    const layout = [model.columns.map((column) => column.index + 1)];
    for (const row of model.rows) {
      if (row.hidden) continue;
      keys.push(row.key);
      layout.push(row.kind === 'group' ? [0] : row.kind === 'track' ? model.columns.map((column) => column.index + 1) : []);
    }
    return { keys, layout };
  }

  function route(info) {
    const need = (name) => {
      if (typeof handlers[name] !== 'function') throw new Error(`Moontide: the song grid has no handler for '${name}'.`);
      return handlers[name];
    };
    if (info.kind === 'fold') need('fold')(info.groupKey);
    else if (info.kind === 'head') need('launch')(info.index);
    else {
      // A cell opens its list (a click on the cell that is open closes it); the gesture is chosen from the list.
      need('choose');
      if (open !== null && open.cell === info.node) closeList({ focusCell: true });
      else openList(info.node);
    }
  }

  function controlOf(target) {
    for (let node = target; node; node = node.parentNode) {
      if (controls.has(node)) return node;
    }
    return null;
  }

  function onClick(event) {
    const node = controlOf(event.target);
    if (node === null) return;
    // A control that is switched off stays where it is and keeps its text, and a click on it does nothing: the line says why.
    if (node.getAttribute('aria-disabled') === 'true') return;
    route({ ...controls.get(node), node });
  }

  function onFocusIn(event) {
    const node = controlOf(event.target);
    if (node !== null) setRoving(node);
  }

  function onKeyDown(event) {
    const node = controlOf(event.target);
    if (node !== null && isAskKey(event)) {
      // The keyboard's right-click: the page's own contextmenu listener ignores a Shift press, so the grid asks directly.
      if (typeof handlers.ask !== 'function') throw new Error("Moontide: the song grid has no handler for 'ask'.");
      const descriptor = askTarget(node);
      if (descriptor === null) return;
      event.preventDefault();
      event.stopPropagation();
      const at = node.getBoundingClientRect();
      handlers.ask(descriptor, { x: at.left + at.width / 2, y: at.top + at.height / 2 });
      return;
    }
    if (node === null || !MOVE_KEYS.has(event.key)) return;
    if (event.altKey || event.metaKey || event.shiftKey) return;
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (event.ctrlKey && vertical) return;
    const info = controls.get(node);
    const { keys, layout } = layoutOf();
    const row = keys.indexOf(info.rowKey);
    event.preventDefault();
    event.stopPropagation();
    if (row < 0) return;
    const target = gridMove(layout, { row, column: info.column }, event.key, { ctrl: event.ctrlKey });
    if (target === null) return;
    const next = byPosition.get(positionKey(keys[target.row], target.column));
    if (next === undefined) return;
    setRoving(next);
    next.focus();
  }

  // ---- what a right-click asks about ----

  /** The Ask descriptor of one control of the grid (a section header, a fold button or a cell). */
  function askOfControl(node, info) {
    if (info.kind === 'head') return { kind: 'part', name: model.columns[info.index].name };
    if (info.kind === 'fold') return { ...info.ask };
    const { track, name: section, key } = info.seen;
    if (key === null) return { kind: 'cell', section, track, rest: true };
    const descriptor = { kind: 'cell', section, track, variation: key };
    // The fit is what the cell shows now: a cell without fit words has none to carry.
    const fit = node.getAttribute('data-fit');
    if (fit === null) return descriptor;
    descriptor.fit = fit;
    const outside = node.getAttribute('data-outside');
    if (outside !== null) descriptor.outside = outside;
    // Only a variation whose notes do not fit offers a request, written from the cell's own facts and never sent by the grid.
    if (fit === 'does-not-fit') {
      const harmony = model.sections[info.section].harmony;
      descriptor.prefill = cellFitPrefill({ variation: key, track, section, harmony: harmony.text, notes: outside });
    }
    return descriptor;
  }

  /**
   * What a right-click on `element` asks about, or null when it is not on something the grid knows: a section header gives
   * `{ kind: 'part', name }`, a cell `{ kind: 'cell', section, track, variation | rest: true, fit?, outside?, prefill? }`, a
   * fold button or a group row `{ kind: 'group', name, parent? }` and a track name `{ kind: 'track', track }`. The most
   * specific one wins (a cell before its row, a fold button before its group row). Names come from the model, not from the
   * shown text, which may be cut.
   */
  function askTarget(element) {
    if (model === null) return null;
    for (let node = element; node; node = node.parentNode) {
      const info = controls.get(node);
      if (info !== undefined) return askOfControl(node, info);
      const row = askRows.get(node);
      if (row !== undefined) return { ...row };
    }
    return null;
  }

  // ---- the list that opens on a cell ----

  function optionNode(option, listModel) {
    const node = make('div', option.rest ? 'song-option song-option-rest' : 'song-option');
    node.setAttribute('role', 'option');
    node.setAttribute('id', option.id);
    node.setAttribute('aria-selected', String(option.current));
    const name = make('span', 'song-option-name', option.text);
    if (option.title !== null) name.setAttribute('title', option.title);
    node.appendChild(name);
    if (option.current) node.appendChild(make('span', 'song-option-note', listModel.currentText));
    if (option.note !== null) node.appendChild(make('span', 'song-option-note', option.note));
    return node;
  }

  function setActive(index) {
    if (open === null) return;
    const clamped = Math.max(0, Math.min(open.nodes.length - 1, index));
    if (clamped !== open.active) {
      open.nodes[open.active].removeAttribute('data-active');
      open.nodes[clamped].setAttribute('data-active', 'true');
      open.active = clamped;
      list.setAttribute('aria-activedescendant', open.nodes[clamped].getAttribute('id'));
    }
    if (typeof open.nodes[clamped].scrollIntoView === 'function') open.nodes[clamped].scrollIntoView({ block: 'nearest' });
  }

  /** Puts the list below the cell, above it when the room below is short, and inside the viewport. */
  function place(cell) {
    const root = document.documentElement;
    list.style.left = '0px';
    list.style.top = '0px';
    list.style.maxHeight = '';
    const at = cell.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const spot = listPlacement({
      cell: { left: at.left, top: at.top, bottom: at.bottom },
      size: { width: box.width, height: box.height },
      viewport: { width: root.clientWidth, height: root.clientHeight },
    });
    list.style.left = `${spot.left}px`;
    list.style.top = `${spot.top}px`;
    list.style.maxHeight = spot.maxHeight === null ? '' : `${spot.maxHeight}px`;
    list.setAttribute('data-placement', spot.above ? 'above' : 'below');
  }

  /**
   * Opens the list of the variations of `cellButton`'s track for its section, current one marked, rest last. `listModel` is
   * the content (the grid model gives it by default). Focus moves into the list; the cell says it is expanded.
   */
  function openList(cellButton, listModel) {
    const info = controls.get(cellButton);
    if (info === undefined || info.kind !== 'cell') throw new Error('Moontide: the song grid can open a list only on one of its cells.');
    if (typeof handlers.choose !== 'function') throw new Error("Moontide: the song grid has no handler for 'choose'.");
    if (open !== null) closeList({ focusCell: false });
    const content = listModel ?? model.listFor(info.track, info.section);
    const nodes = content.options.map((option) => optionNode(option, content));
    const children = [];
    list.setAttribute('aria-label', content.label);
    if (content.note === null) list.removeAttribute('aria-describedby');
    else {
      const note = make('div', 'song-option-note song-list-note', content.note);
      note.setAttribute('id', LIST_NOTE_ID);
      note.setAttribute('role', 'presentation');
      children.push(note);
      list.setAttribute('aria-describedby', LIST_NOTE_ID);
    }
    children.push(...nodes);
    list.replaceChildren(...children);
    const current = Math.max(0, content.options.findIndex((option) => option.current));
    open = { cell: cellButton, content, nodes, active: current, seen: info.seen };
    nodes[current].setAttribute('data-active', 'true');
    list.setAttribute('aria-activedescendant', nodes[current].getAttribute('id'));
    cellButton.setAttribute('aria-expanded', 'true');
    list.hidden = false;
    place(cellButton);
    list.focus();
  }

  /** Closes the list; with `focusCell` focus goes back to the cell it belonged to. A grid that waited for it is drawn now. */
  function closeList({ focusCell = false } = {}) {
    if (open === null) return;
    const { cell } = open;
    open = null;
    list.hidden = true;
    list.replaceChildren();
    list.removeAttribute('aria-activedescendant');
    list.removeAttribute('aria-describedby');
    if (cell.parentNode !== null) cell.setAttribute('aria-expanded', 'false');
    if (focusCell && cell.parentNode !== null) cell.focus({ preventScroll: true });
    if (waitingModel !== null) {
      const next = waitingModel;
      waitingModel = null;
      render(next);
    }
  }

  function isListOpen() {
    return open !== null;
  }

  function choose(index) {
    if (open === null) return;
    const option = open.content.options[index];
    const { seen } = open;
    closeList({ focusCell: true });
    // What the cell holds already is no change: nothing is written, evaluated or recorded, so the page is not even asked.
    if (option.current) return;
    handlers.choose(seen, option.rest ? { rest: true } : { key: option.key });
  }

  list.addEventListener('click', (event) => {
    if (open === null) return;
    for (let node = event.target; node && node !== list; node = node.parentNode) {
      const index = open.nodes.indexOf(node);
      if (index >= 0) {
        choose(index);
        return;
      }
    }
  });
  list.addEventListener('keydown', (event) => {
    if (open === null) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const key = event.key;
    if (key === 'Escape' || key === 'Tab') {
      // Esc closes the list and nothing else: the page's own Esc, which closes the view, must not see this press.
      event.preventDefault();
      event.stopPropagation();
      closeList({ focusCell: true });
    } else if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      if (key === 'ArrowDown') setActive(open.active + 1);
      else if (key === 'ArrowUp') setActive(open.active - 1);
      else setActive(key === 'Home' ? 0 : open.nodes.length - 1);
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      choose(open.active);
    }
  });
  // A press anywhere else closes the list (the cell it belongs to toggles it with its own click).
  document.addEventListener('pointerdown', (event) => {
    if (open === null) return;
    for (let node = event.target; node; node = node.parentNode) {
      if (node === list || node === open.cell) return;
    }
    closeList({ focusCell: false });
  });

  function render(next) {
    // A grid drawn again while the list is open waits: the list belongs to the cell it was opened on.
    if (open !== null) {
      waitingModel = next;
      return;
    }
    // What a rebuild keeps: the scroll offsets on both axes and the focused control by its row and column.
    const left = scroller === null ? 0 : scroller.scrollLeft;
    const top = scroller === null ? 0 : scroller.scrollTop;
    const focused = document.activeElement ? controls.get(document.activeElement) : undefined;
    const restoreFocus = focused === undefined ? null : { rowKey: focused.rowKey, column: focused.column };
    const wantedRoving = rovingPosition;

    model = next;
    controls = new Map();
    byPosition = new Map();
    askRows = new Map();
    heads = [];
    roving = null;
    shownPlaying = -1;
    // The controls are new and switched on; the next tick switches off what the line says.
    shownOff = { headers: false, cells: false };
    const sections = model.columns.length;

    scroller = make('div', 'song-grid-scroll');
    const table = make('table', 'song-grid');
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', model.title);
    table.style.setProperty('--song-columns', String(sections));
    const colgroup = make('colgroup', '');
    colgroup.appendChild(make('col', 'song-col-name'));
    cols = model.columns.map(() => {
      const col = make('col', '');
      colgroup.appendChild(col);
      return col;
    });
    table.appendChild(colgroup);
    const thead = make('thead', '');
    const headRow = make('tr', '');
    headRow.appendChild(make('th', 'song-corner', model.corner));
    for (const column of model.columns) headRow.appendChild(buildHead(column));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = make('tbody', '');
    for (const row of model.rows) tbody.appendChild(buildRow(row, sections));
    table.appendChild(tbody);
    table.addEventListener('click', onClick);
    table.addEventListener('focusin', onFocusIn);
    table.addEventListener('keydown', onKeyDown);
    scroller.appendChild(table);

    rows.replaceChildren(scroller);
    rows.setAttribute('data-view', 'song');
    bar.hidden = false;
    for (const entry of launchButtons) {
      const pressed = String(entry.option.value === model.launchChoice);
      if (pressed !== entry.pressed) {
        entry.button.setAttribute('aria-pressed', pressed);
        entry.pressed = pressed;
      }
    }
    scroller.scrollLeft = left;
    scroller.scrollTop = top;

    const stop = (wantedRoving !== null && byPosition.get(positionKey(wantedRoving.rowKey, wantedRoving.column))) || byPosition.values().next().value;
    if (stop !== undefined) setRoving(stop);
    if (restoreFocus !== null) {
      const again = byPosition.get(positionKey(restoreFocus.rowKey, restoreFocus.column));
      if (again !== undefined) {
        setRoving(again);
        again.focus({ preventScroll: true });
      }
    }
  }

  /**
   * Writes what the live state changed, and nothing else: a second call with the same state touches no node. `live` is
   * `{ playing, stopped, motion, queued, line }`, where `queued` is `{ index, countdownText, line }` for the section a
   * launch waits for (or null) and `line` the `{ kind, text }` sentence of songLine (or null).
   */
  function tick(live) {
    if (model === null) return;
    let playing = live.stopped ? null : live.playing;
    // A newer grid waits for the list to close and may have more sections than the one drawn: its playing section has no
    // header here yet.
    if (playing !== null && playing !== undefined && playing.index >= model.columns.length) playing = null;
    model.columns.forEach((column, i) => {
      const head = heads[i];
      const now = headerLive({ column, playing, stopped: live.stopped, launchChoice: model.launchChoice, motion: live.motion, queued: live.queued ?? null });
      const shown = head.shown;
      if (now.state !== shown.state) {
        head.button.setAttribute('data-state', now.state);
        shown.state = now.state;
      }
      if (now.stateText !== shown.stateText) {
        head.state.textContent = now.stateText;
        shown.stateText = now.stateText;
      }
      if (now.action !== shown.action) {
        head.action.textContent = now.action;
        if (now.action === '') head.action.setAttribute('hidden', '');
        else head.action.removeAttribute('hidden');
        shown.action = now.action;
      }
      if (now.title !== shown.title) {
        head.button.setAttribute('title', now.title);
        shown.title = now.title;
      }
      const width = `${now.progress * 100}%`;
      if (width !== shown.width) {
        head.fill.style.width = width;
        shown.width = width;
      }
      // The line a queued launch takes over on, for whoever wants to compare it with where the music lands.
      const takeoverLine = now.line === undefined ? '' : String(now.line);
      if (takeoverLine !== shown.line) {
        if (takeoverLine === '') head.button.removeAttribute('data-line');
        else head.button.setAttribute('data-line', takeoverLine);
        shown.line = takeoverLine;
      }
    });
    const sentence = nowText(model, playing);
    if (sentence !== shownNow) {
      now.textContent = sentence ?? '';
      now.hidden = sentence === null;
      shownNow = sentence;
    }
    const index = playing === null ? -1 : playing.index;
    if (index !== shownPlaying) {
      if (shownPlaying >= 0) cols[shownPlaying].removeAttribute('data-playing');
      if (index >= 0) cols[index].setAttribute('data-playing', 'true');
      shownPlaying = index;
    }
    writeLine(live.line ?? null);
  }

  /** The sentence under the toolbar and the controls it switches off, each written only when it changed. */
  function writeLine(sentence) {
    const kind = sentence === null ? '' : sentence.kind;
    const text = sentence === null ? '' : sentence.text;
    if (kind !== shownLine.kind || text !== shownLine.text) {
      if (text !== shownLine.text) line.textContent = text;
      if (kind !== shownLine.kind) {
        if (kind === '') line.removeAttribute('data-kind');
        else line.setAttribute('data-kind', kind);
      }
      line.hidden = kind === '';
      shownLine = { kind, text };
    }
    const off = controlsDisabled(kind === '' ? null : kind);
    for (const part of ['headers', 'cells']) {
      if (off[part] === shownOff[part]) continue;
      for (const [node, info] of controls) {
        if ((part === 'headers' && info.kind === 'head') || (part === 'cells' && info.kind === 'cell')) {
          if (off[part]) node.setAttribute('aria-disabled', 'true');
          else node.removeAttribute('aria-disabled');
        }
      }
      shownOff[part] = off[part];
    }
  }

  /** Takes the grid away; does nothing when no grid is drawn, so the rows of another view are never touched. */
  function hide() {
    waitingModel = null;
    if (open !== null) closeList({ focusCell: false });
    if (model === null) return;
    rows.replaceChildren();
    rows.removeAttribute('data-view');
    bar.hidden = true;
    now.hidden = true;
    now.textContent = '';
    shownNow = null;
    line.hidden = true;
    line.textContent = '';
    line.removeAttribute('data-kind');
    shownLine = { kind: '', text: '' };
    shownOff = { headers: false, cells: false };
    model = null;
    scroller = null;
    controls = new Map();
    byPosition = new Map();
    askRows = new Map();
    heads = [];
    cols = [];
    roving = null;
    rovingPosition = null;
    shownPlaying = -1;
  }

  /** Brings the playing section's header into view once, by the shortest scroll and without animation. */
  function scrollPlayingIntoView() {
    if (shownPlaying < 0) return;
    heads[shownPlaying].th.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  return { render, tick, hide, scrollPlayingIntoView, openList, closeList, isListOpen, askTarget };
}
