// The Instruments view's DOM: the sentence that replaces the cards and one card per
// instrument, built with DOM methods only. Every text reaches the page through textContent, title or
// setAttribute, never as markup: an id, a model name, a port or a track name comes from a file or from code
// and is not trusted. The view attaches listeners to its own controls (the switch, the settings
// editor) and calls back (onInstrumentSwitch, onInstrumentSettings); it never sends, never stores and never
// validates a setting: page/main.js owns every socket, the only right-click listener and the requests, and the
// server owns the reasons. No DOM access at import time: main.js calls createInstrumentsView() with its
// document. The words and the decisions come from page/instruments-model.js.

import { INSTRUMENTS_COPY, announcements, cardsToReplace, editorFailure, editorModel, redrawPlan, switchLook, switchRefusalText } from './instruments-model.js';
import { MIDI_COPY, fill } from './midi-plan.js';

/**
 * Builds the view and returns `{ render, closed, askTarget, settle }`. `document` is the page's document (named so on
 * purpose: every element lookup below reads `document.getElementById`, the shape test/page-hidden.test.js scans).
 * `onInstrumentSwitch(id, enabled)` is called with the target state of a press on a card's switch (a set, never a
 * toggle); it is required, so a page that forgot to wire it fails at creation instead of showing dead switches.
 * `render(model)` draws the model of `instrumentsModel()`: a message hides the cards, cards hide the message;
 * an unchanged model writes nothing. `closed()` forgets what was drawn, so the next drawing is a first one.
 * `onInstrumentSettings(id, { port, channels, clock })` is called with the full set the user chose in a card's settings
 * editor (required too); nothing is validated here.
 * `settle(instrumentId, outcome, kind = 'switch')` ends the pending look of one switch, or with kind 'settings' the
 * saving of one editor (the server answered, or it did not).
 */
export function createInstrumentsView({ document, onInstrumentSwitch, onInstrumentSettings }) {
  if (typeof onInstrumentSwitch !== 'function') {
    throw new Error('Moontide: the Instruments view needs onInstrumentSwitch.');
  }
  if (typeof onInstrumentSettings !== 'function') {
    throw new Error('Moontide: the Instruments view needs onInstrumentSettings.');
  }
  const instrumentsView = document.getElementById('instruments-view');
  const instrumentsNotice = document.getElementById('instruments-notice');
  const instrumentsMessage = document.getElementById('instruments-message');
  const instrumentsMessageText = document.getElementById('instruments-message-text');
  const instrumentsFolder = document.getElementById('instruments-folder');
  const instrumentsMessageSub = document.getElementById('instruments-message-sub');
  const instrumentsProblems = document.getElementById('instruments-problems');
  const instrumentsMessageClosing = document.getElementById('instruments-message-closing');
  const instrumentsBody = document.getElementById('instruments-body');
  const instrumentsList = document.getElementById('instruments-list');
  const instrumentsFooter = document.getElementById('instruments-footer');
  const instrumentsStatus = document.getElementById('instruments-status');
  if (
    !instrumentsView ||
    !instrumentsNotice ||
    !instrumentsMessage ||
    !instrumentsMessageText ||
    !instrumentsFolder ||
    !instrumentsMessageSub ||
    !instrumentsProblems ||
    !instrumentsMessageClosing ||
    !instrumentsBody ||
    !instrumentsList ||
    !instrumentsFooter ||
    !instrumentsStatus
  ) {
    throw new Error('Moontide: the Instruments markup is missing from the page.');
  }

  /** An element with its text set as text, never as markup. */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Sets the text of a node only when it changed, so an unchanged part of a redraw writes nothing. */
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /** The text of an optional part: the model's string, or '' when the part is null (the node is then hidden). */
  function partText(text) {
    return typeof text === 'string' ? text : '';
  }

  /** One row of a card: a label (with an optional second muted line) and its value node. */
  function row(label, valueNode, hint) {
    const wrapper = element('div', 'instrument-row');
    const term = element('dt', 'instrument-label', label);
    if (hint !== undefined) term.append(element('span', 'instrument-label-hint', hint));
    const value = element('dd', 'instrument-value');
    value.append(valueNode);
    wrapper.append(term, value);
    return wrapper;
  }

  /** A text value in the mono face. */
  function monoNode(text) {
    return element('span', 'instrument-mono', text);
  }

  // The requests that wait for the server, by instrument id (the target state), in memory only like the open Drum
  // maps: a redraw, a closed view or a rebuilt card keeps the pending look; a reload forgets it.
  const pendingSwitches = new Map();

  /** The pending target of one instrument, or null. */
  const pendingOf = (instrumentId) => (pendingSwitches.has(instrumentId) ? pendingSwitches.get(instrumentId) : null);

  /** Writes the switch of one drawn card from the confirmed state and the pending target, touching only what differs. */
  function drawSwitch(refs) {
    const look = switchLook({ id: refs.id, enabled: refs.enabled, pending: pendingOf(refs.id) });
    const { button, thumb, word } = refs.switchNodes;
    if (button.getAttribute('aria-checked') !== look.checked) button.setAttribute('aria-checked', look.checked);
    if (button.getAttribute('title') !== look.title) button.setAttribute('title', look.title);
    if (look.busy) {
      if (button.getAttribute('aria-busy') !== 'true') button.setAttribute('aria-busy', 'true');
      if (button.getAttribute('aria-disabled') !== 'true') button.setAttribute('aria-disabled', 'true');
    } else {
      if (button.getAttribute('aria-busy') !== null) button.removeAttribute('aria-busy');
      if (button.getAttribute('aria-disabled') !== null) button.removeAttribute('aria-disabled');
    }
    if (thumb.dataset.thumb !== look.thumb) thumb.dataset.thumb = look.thumb;
    setText(word, look.word);
  }

  // The line under a card's header after a switch that did not take, by instrument id (the text), in memory only. At
  // most one per card: the next press, a switch changed elsewhere or a new refusal replaces it.
  const switchErrors = new Map();

  /** Draws the refusal line of one drawn card from switchErrors: inserted after the header, replaced or removed. */
  function drawError(refs) {
    const text = switchErrors.get(refs.id);
    if (text === undefined) {
      if (refs.errorNode !== null) {
        refs.errorNode.remove();
        refs.errorNode = null;
      }
      return;
    }
    if (refs.errorNode === null) {
      // A message the screen reader announces once, when it appears; the text is the server's and stays text.
      const line = element('p', 'instrument-error', text);
      line.setAttribute('role', 'alert');
      refs.head.after(line);
      refs.errorNode = line;
    } else {
      setText(refs.errorNode, text);
    }
  }

  /** The switch of a card: a native button with role switch, a track with a thumb, and the word. Its press asks, never decides. */
  function switchNode(card, index, refs) {
    const button = element('button', 'instrument-switch');
    button.setAttribute('type', 'button');
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-labelledby', `instrument-name-${index}`);
    const thumb = element('span', 'instrument-switch-thumb');
    const track = element('span', 'instrument-switch-track');
    track.append(thumb);
    const word = element('span', 'instrument-switch-word');
    button.append(track, word);
    refs.switchNodes = { button, thumb, word };
    refs.enabled = card.enabled;
    drawSwitch(refs);
    button.addEventListener('click', () => {
      // One request in flight per card: a press on a pending switch does nothing.
      if (pendingSwitches.has(refs.id)) return;
      // The target is the opposite of the state the server confirmed, as a set: never a toggle on the server's side.
      const target = !refs.enabled;
      pendingSwitches.set(refs.id, target);
      switchErrors.delete(refs.id);
      drawError(refs);
      drawSwitch(refs);
      onInstrumentSwitch(refs.id, target);
    });
    return button;
  }

  /** The port part: the dot, the port name and, under it, the state words. */
  function portNode(card, index, refs) {
    const wrapper = document.createDocumentFragment();
    const line = element('span', 'instrument-port');
    const dot = element('span', 'state-dot midi-dot');
    dot.dataset.kind = card.port.dot.kind;
    dot.setAttribute('aria-hidden', 'true');
    dot.setAttribute('title', card.port.dot.title);
    line.append(dot, element('span', 'instrument-port-name', card.port.name));
    const words = element('span', 'instrument-state', card.port.words);
    words.id = `instrument-state-${index}`;
    words.dataset.attention = String(card.port.attention);
    refs.dot = dot;
    refs.words = words;
    wrapper.append(line, words);
    return wrapper;
  }

  /** The control chips of a card: plain text, never a control. */
  function controlsNode(card) {
    if (card.controlsNone !== null) return element('span', 'instrument-muted', card.controlsNone);
    const chips = element('div', 'instrument-chips');
    for (const control of card.controls) {
      const chip = element('span', 'instrument-chip');
      chip.setAttribute('title', control.title);
      chip.setAttribute('aria-label', control.label);
      chip.append(element('span', undefined, control.name), element('span', 'instrument-chip-value', control.value));
      chips.append(chip);
    }
    return chips;
  }

  /** The children of the In use value: the muted lead of an off instrument when there is one, then one line element per model line. */
  function inUseLines(inUse) {
    const lines = inUse.lines.map((text) => element('span', inUse.muted ? 'instrument-inuse-line instrument-muted' : 'instrument-inuse-line', text));
    if (typeof inUse.lead === 'string') lines.unshift(element('span', 'instrument-inuse-line instrument-muted', inUse.lead));
    return lines;
  }

  /** The lines of the Drum kit row: one span per line, muted when the model says so, with its hover title when it has one. */
  function drumKitLines(drumKit) {
    return drumKit.lines.map((line) => {
      const node = element('span', line.muted ? 'instrument-drum-kit instrument-muted' : 'instrument-drum-kit', line.text);
      if (line.title !== null) node.setAttribute('title', line.title);
      return node;
    });
  }

  // The open state of every Drum map line, in memory only (never stored, never sent), keyed by instrument id and map
  // key. No listener may write it (the static test forbids one), so it is read from the drawn details before each
  // redraw and set back on the new node; the page forgets it on reload.
  const openDrumMaps = new Map();
  const drumMapKey = (instrumentId, mapKey) => `${instrumentId}\n${mapKey}`;

  /**
   * The nodes of a card's Drum map lines: a closed-or-open `details` per known map (the one native disclosure of the
   * view: it sends nothing, stores nothing, changes no setting), a plain line and its sub line per unknown map.
   * `opens` lists each details with its summary, so a redraw can read `open` and put focus back.
   */
  function drumMapNodes(instrumentId, drumMaps) {
    const nodes = [];
    const opens = [];
    for (const map of drumMaps) {
      if (map.kind === 'unknown') {
        const line = element('p', 'instrument-drum-unknown');
        line.append(element('span', undefined, INSTRUMENTS_COPY.drumMapUnknownLabel), ' ', element('span', 'instrument-muted', INSTRUMENTS_COPY.drumMapUnknownWord));
        nodes.push(line, element('p', 'instrument-drum-sub instrument-muted', map.sub));
        continue;
      }
      const details = element('details', 'instrument-drum-map');
      details.dataset.map = map.key;
      const summary = element('summary', 'instrument-drum-summary');
      summary.append(
        element('span', 'instrument-drum-name', map.summary),
        element('span', 'instrument-drum-show', INSTRUMENTS_COPY.drumMapShow),
        element('span', 'instrument-drum-hide', INSTRUMENTS_COPY.drumMapHide),
      );
      const list = element('ul', 'instrument-drum-notes');
      for (const drum of map.notes) {
        const entry = element('li');
        entry.append(element('span', 'instrument-drum-number', drum.note), ' ', element('span', 'instrument-drum-note-name', drum.name));
        list.append(entry);
      }
      details.append(summary, list);
      details.open = openDrumMaps.get(drumMapKey(instrumentId, map.key)) === true;
      nodes.push(details);
      opens.push({ key: map.key, details, summary });
    }
    return { nodes, opens };
  }

  /** One card and the nodes a live redraw updates. The generated ids come from the index, never from user text. */
  function cardNode(card, index) {
    const refs = { id: card.id, index, item: null, dot: null, words: null, inUse: null, drumKit: null, maps: null, opens: [], enabled: card.enabled, switchNodes: null, head: null, errorNode: null, editButton: null, editor: null };
    const item = element('li', 'instrument-card');
    refs.item = item;
    item.tabIndex = 0;
    item.dataset.instrument = card.id;
    item.dataset.enabled = String(card.enabled);
    item.setAttribute('title', card.title);
    item.setAttribute('aria-labelledby', `instrument-name-${index}`);
    item.setAttribute('aria-describedby', `instrument-state-${index}`);
    const name = element('p', 'instrument-name', card.id);
    name.id = `instrument-name-${index}`;
    const head = element('div', 'instrument-head');
    head.append(name, switchNode(card, index, refs));
    refs.head = head;
    const rows = element('dl', 'instrument-rows');
    const model = element('span', undefined, card.model.text);
    model.setAttribute('title', card.model.title);
    rows.append(row(INSTRUMENTS_COPY.labelModel, model), row(INSTRUMENTS_COPY.labelPort, portNode(card, index, refs)));
    // Each word on one line, so a line breaks at a space and never after the dash of a run (`ch 11–16`).
    const channels = monoNode('');
    card.channels.split(' ').forEach((word, index) => {
      if (index > 0) channels.append(' ');
      channels.append(element('span', 'instrument-word', word));
    });
    rows.append(row(INSTRUMENTS_COPY.labelChannels, channels));
    if (card.clock !== null) rows.append(row(INSTRUMENTS_COPY.labelClock, element('span', undefined, card.clock)));
    rows.append(row(INSTRUMENTS_COPY.labelControls, controlsNode(card), INSTRUMENTS_COPY.labelControlsHint));
    if (card.catalog !== null) rows.append(row(INSTRUMENTS_COPY.labelCatalog, monoNode(card.catalog)));
    if (card.drumKit !== null) {
      const kit = element('div', 'instrument-lines');
      kit.append(...drumKitLines(card.drumKit));
      refs.drumKit = kit;
      rows.append(row(INSTRUMENTS_COPY.labelDrumKit, kit));
    }
    const inUse = element('div', 'instrument-lines');
    inUse.append(...inUseLines(card.inUse));
    refs.inUse = inUse;
    rows.append(row(INSTRUMENTS_COPY.labelInUse, inUse));
    item.append(head, rows, editButtonNode(card, refs));
    drawError(refs);
    // An editor that was open (a draft kept in memory) comes back with the card.
    if (editors.has(card.id)) buildEditor(refs);
    if (card.drumMaps !== null) {
      const maps = element('div', 'instrument-drum-maps');
      const built = drumMapNodes(card.id, card.drumMaps);
      maps.append(...built.nodes);
      refs.maps = maps;
      refs.opens = built.opens;
      item.append(maps);
    }
    return { item, refs };
  }

  // --- The settings editor ---
  // The editors that are open, by instrument id, in memory only like the pending switches and the open Drum maps:
  // { draft: { port, channels, clock }, saving, rows, openedWith, changedElsewhere }; rows is what the last failed answer
  // listed (or null); openedWith is the card's settings (JSON) the draft started from or the last change seen, so a
  // change made elsewhere can be told. A card that is drawn again builds its editor from this.
  const editors = new Map();
  // The cards and the ports of the model being drawn, read by the editor (its options and its Save depend on them).
  let latestCards = new Map();
  let latestPorts = { outputs: [], access: 'idle', supported: false };

  /** A native checkbox; `checked` is the draft's value. */
  function checkbox(checked) {
    const input = element('input');
    input.setAttribute('type', 'checkbox');
    input.checked = checked;
    return input;
  }

  /** The editor model of one drawn card from the draft. */
  function editorModelOf(refs) {
    return editorModel({ card: latestCards.get(refs.id), ports: latestPorts, draft: editors.get(refs.id).draft });
  }

  /** Writes what depends on the draft and on the card: the options, the title, Save, and the lock of a request that waits. Touches only what differs. */
  function syncEditor(refs) {
    const state = editors.get(refs.id);
    const editor = refs.editor;
    const em = editorModelOf(refs);
    const key = JSON.stringify(em.ports);
    if (editor.portsKey !== key) {
      editor.portsKey = key;
      editor.select.replaceChildren(
        ...em.ports.map((port) => {
          const option = element('option', undefined, port.text);
          option.value = port.value;
          option.selected = port.selected;
          return option;
        }),
      );
    }
    if (editor.select.value !== state.draft.port) editor.select.value = state.draft.port;
    setAttr(editor.select, 'title', em.portTitle);
    // The hint under the select and the warning under the chips: present only while the model has one.
    drawNote(editor, 'hint', em.portHint, editor.portValue, `instrument-port-hint-${refs.index}`);
    drawNote(editor, 'warning', em.warning, editor.channelsValue, `instrument-warning-${refs.index}`);
    drawErrors(refs, state);
    drawNote(editor, 'elsewhere', state.changedElsewhere ? INSTRUMENTS_COPY.changedElsewhere : null, editor.actions, `instrument-elsewhere-${refs.index}`, 'before');
    const invalid = state.rows === null ? [] : state.rows.invalid;
    const errorsId = editor.errors === null ? null : editor.errors.id;
    const describe = (noteNode, name) => [noteNode === null ? null : noteNode.id, invalid.includes(name) ? errorsId : null].filter((id) => id !== null).join(' ');
    for (const [node, name, note] of [[editor.select, 'port', editor.hint], [editor.group, 'channels', editor.warning], [editor.clock, 'clock', null]]) {
      setAttr(node, 'aria-invalid', invalid.includes(name) ? 'true' : null);
      const described = describe(note, name);
      setAttr(node, 'aria-describedby', described === '' ? null : described);
    }
    if (editor.fields.disabled !== state.saving) editor.fields.disabled = state.saving;
    setText(editor.save, state.saving ? INSTRUMENTS_COPY.saving : INSTRUMENTS_COPY.save);
    setAttr(editor.save, 'aria-disabled', state.saving || !em.canSave ? 'true' : null);
    setAttr(editor.cancel, 'aria-disabled', state.saving ? 'true' : null);
  }

  /** A muted note (the port hint, the warning) inside `holder`: created when the model has text, changed in place, removed when it has none. */
  function drawNote(editor, name, text, holder, id, where = 'append') {
    if (text === null) {
      if (editor[name] !== null) {
        editor[name].remove();
        editor[name] = null;
      }
      return;
    }
    if (editor[name] === null) {
      const note = element('p', 'instrument-hint', text);
      note.id = id;
      // 'before' puts the note ahead of `holder` (the changed-elsewhere line sits above the buttons).
      if (where === 'before') holder.before(note);
      else holder.append(note);
      editor[name] = note;
    } else {
      setText(editor[name], text);
    }
  }

  /** The refusal list of the last answer: built again when the answer is another one (replaced, never appended), removed when there is none. */
  function drawErrors(refs, state) {
    const editor = refs.editor;
    if (editor.rowsDrawn === state.rows) return;
    editor.rowsDrawn = state.rows;
    if (editor.errors !== null) {
      editor.errors.remove();
      editor.errors = null;
    }
    if (state.rows === null) return;
    const list = element('ul', 'instrument-errors');
    list.id = `instrument-errors-${refs.index}`;
    // Announced once, when it appears; every text is the server's and stays text.
    list.setAttribute('role', 'alert');
    for (const row of state.rows.rows) {
      const item = element('li');
      if (row.label !== null) item.append(`${row.label}${MIDI_COPY.rowSeparator}${row.reason}`);
      else if (row.field !== null) item.append(element('code', undefined, row.field), `${MIDI_COPY.rowSeparator}${row.reason}`);
      else item.append(row.reason);
      list.append(item);
    }
    if (state.rows.more !== null) list.append(element('li', undefined, state.rows.more));
    editor.fields.after(list);
    editor.errors = list;
  }

  /** Sets an attribute only when it differs; null removes it. */
  function setAttr(node, name, value) {
    if (value === null) {
      if (node.getAttribute(name) !== null) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== value) {
      node.setAttribute(name, value);
    }
  }

  /** The form of one card's editor, built from the draft in memory, placed after the Edit settings button (which hides). */
  function buildEditor(refs) {
    const state = editors.get(refs.id);
    const em = editorModelOf(refs);
    const selectId = `instrument-port-${refs.index}`;
    const form = element('form', 'instrument-editor');
    form.setAttribute('aria-label', em.name);
    const fields = element('fieldset', 'instrument-editor-fields');

    const portLabel = element('label', 'instrument-label', INSTRUMENTS_COPY.labelPort);
    portLabel.setAttribute('for', selectId);
    const select = element('select', 'instrument-select');
    select.id = selectId;
    const portValue = element('div', 'instrument-value');
    portValue.append(select);
    const portRow = element('div', 'instrument-row');
    portRow.append(portLabel, portValue);

    const group = element('fieldset', 'instrument-channels-group');
    const legend = element('legend', 'instrument-label', INSTRUMENTS_COPY.labelChannels);
    const chipSet = element('div', 'instrument-channel-set');
    const chips = new Map();
    for (const chip of em.chips) {
      const input = checkbox(chip.checked);
      input.addEventListener('change', () => {
        const channels = new Set(state.draft.channels);
        if (input.checked) channels.add(chip.channel);
        else channels.delete(chip.channel);
        state.draft.channels = [...channels].sort((a, b) => a - b);
        syncEditor(refs);
      });
      const label = element('label', 'instrument-channel');
      label.append(input, element('span', undefined, chip.text));
      chips.set(chip.channel, input);
      chipSet.append(label);
    }
    const channelsValue = element('div', 'instrument-value');
    channelsValue.append(chipSet);
    group.append(legend, channelsValue);

    const clockInput = checkbox(em.clock);
    clockInput.addEventListener('change', () => {
      state.draft.clock = clockInput.checked;
      syncEditor(refs);
    });
    const clockLabel = element('label', 'instrument-clock');
    clockLabel.append(clockInput, element('span', undefined, INSTRUMENTS_COPY.clockLabel));
    const clockValue = element('div', 'instrument-value');
    clockValue.append(clockLabel);
    const clockRow = element('div', 'instrument-row');
    clockRow.append(element('span', 'instrument-label', INSTRUMENTS_COPY.labelClock), clockValue);

    fields.append(portRow, group, clockRow);

    const save = element('button', 'instrument-action', INSTRUMENTS_COPY.save);
    save.setAttribute('type', 'submit');
    const cancel = element('button', 'instrument-action', INSTRUMENTS_COPY.cancel);
    cancel.setAttribute('type', 'button');
    const actions = element('div', 'instrument-actions');
    actions.append(save, cancel);
    form.append(fields, actions);

    select.addEventListener('change', () => {
      state.draft.port = select.value;
      syncEditor(refs);
    });
    save.addEventListener('click', (event) => {
      event.preventDefault();
      trySave(refs);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      trySave(refs);
    });
    cancel.addEventListener('click', () => cancelEditor(refs));
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // Esc closes the editor only; the page's own Esc (closing the view) must not also run.
        event.preventDefault();
        event.stopPropagation();
        cancelEditor(refs);
      } else if (event.key === 'Enter' && event.target === select) {
        event.preventDefault();
        trySave(refs);
      }
    });

    refs.editor = { form, fields, select, group, chips, clock: clockInput, save, cancel, actions, portValue, channelsValue, portsKey: null, hint: null, warning: null, elsewhere: null, errors: null, rowsDrawn: null };
    refs.editButton.toggleAttribute('hidden', true);
    refs.editButton.after(form);
    syncEditor(refs);
  }

  /** The Edit settings button of a card: opens the editor from the card's current values. */
  function editButtonNode(card, refs) {
    const button = element('button', 'instrument-edit', INSTRUMENTS_COPY.editSettings);
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', fill(INSTRUMENTS_COPY.editSettingsLabel, { id: card.id }));
    button.addEventListener('click', () => {
      if (editors.has(refs.id)) return;
      const settings = latestCards.get(refs.id).settings;
      editors.set(refs.id, { draft: { port: settings.port, channels: [...settings.channels], clock: settings.clock }, saving: false, rows: null, openedWith: JSON.stringify(settings), changedElsewhere: false });
      buildEditor(refs);
      refs.item.scrollIntoView({ block: 'nearest' });
      refs.editor.select.focus({ preventScroll: true });
    });
    refs.editButton = button;
    return button;
  }

  /** Save: only when the draft differs from the card and no request waits. The whole draft is sent; the server validates it. */
  function trySave(refs) {
    const state = editors.get(refs.id);
    if (state === undefined || state.saving) return;
    if (!editorModelOf(refs).canSave) return;
    state.saving = true;
    // The old answer's rows go until the next answer.
    state.rows = null;
    syncEditor(refs);
    // Focus stays on Save while the fields lock (a disabled field would drop it to the page).
    refs.editor.save.focus({ preventScroll: true });
    onInstrumentSettings(refs.id, { port: state.draft.port, channels: [...state.draft.channels], clock: state.draft.clock });
  }

  /** Removes the form of a card's editor and forgets its draft; the Edit settings button shows again. */
  function closeEditor(refs) {
    editors.delete(refs.id);
    refs.editor.form.remove();
    refs.editor = null;
    refs.editButton.toggleAttribute('hidden', false);
  }

  /** Cancel and Esc: discard the draft without asking and give focus back to Edit settings. Nothing happens while a request waits. */
  function cancelEditor(refs) {
    const state = editors.get(refs.id);
    if (state === undefined || state.saving) return;
    closeEditor(refs);
    refs.editButton.focus();
  }

  /** The server answered a settings request, or did not. */
  function settleSettings(instrumentId, outcome) {
    const state = editors.get(instrumentId);
    if (state === undefined) return;
    const refs = cardRefs.find((entry) => entry.id === instrumentId);
    if (outcome.ok === true) {
      if (refs === undefined || refs.editor === null) {
        editors.delete(instrumentId);
        return;
      }
      const active = document.activeElement;
      // Focus that is still in this card (the form, or the card itself after a redraw) moves to Edit settings; a user who went elsewhere keeps their place.
      const keepsFocus = active === null || active === undefined || refs.item.contains(active);
      closeEditor(refs);
      if (keepsFocus) refs.editButton.focus();
      return;
    }
    state.saving = false;
    state.rows = editorFailure(outcome);
    if (refs === undefined || refs.editor === null) return;
    syncEditor(refs);
    // Focus stays on Save (it was there while the fields were locked); put it back if a redraw took it to the card.
    const active = document.activeElement;
    if (active !== refs.editor.save && refs.item.contains(active)) refs.editor.save.focus({ preventScroll: true });
  }

  // What is on screen now: the last model drawn and its JSON (a key-compare, as the MIDI popover does), the state
  // kinds the last cards drawing spoke, and the nodes of each card for in-place updates.
  let shownModel = null;
  let shownJson = null;
  let shownKinds = null;
  let cardRefs = [];

  /** Reads the open flag of every drawn Drum map into the in-memory state (all cards, or only `only`'s). */
  function rememberOpenMaps(only) {
    for (const refs of only === undefined ? cardRefs : [only]) {
      for (const { key, details } of refs.opens) openDrumMaps.set(drumMapKey(refs.id, key), details.open === true);
    }
  }

  /** The drawn Drum map summary that holds focus, as `{ id, key }`, or null. Walks the drawn refs: no selector is built from an id. */
  function focusedSummary() {
    const active = document.activeElement;
    if (active === null || active === undefined) return null;
    for (const refs of cardRefs) {
      for (const { key, summary } of refs.opens) {
        if (summary === active) return { id: refs.id, key };
      }
    }
    return null;
  }

  /** Puts focus back on the summary of map `key` of card `refs`, or on the card itself when that map is gone. */
  function refocusSummary(refs, key) {
    const found = refs.opens.find((entry) => entry.key === key);
    (found === undefined ? refs.item : found.summary).focus({ preventScroll: true });
  }

  /** Shows the sentence that replaces the cards, with every part the model carries. */
  function showMessage(model) {
    rememberOpenMaps();
    setText(instrumentsMessageText, model.lead);
    const folder = partText(model.folder);
    setText(instrumentsFolder, folder);
    if (instrumentsFolder.hidden !== (folder === '')) instrumentsFolder.hidden = folder === '';
    const sub = partText(model.sub);
    setText(instrumentsMessageSub, sub);
    if (instrumentsMessageSub.hidden !== (sub === '')) instrumentsMessageSub.hidden = sub === '';
    const rows = model.problems.map((problem) => {
      const item = element('li');
      item.append(element('code', undefined, problem.field), document.createTextNode(MIDI_COPY.rowSeparator + problem.reason));
      return item;
    });
    if (model.more !== null) rows.push(element('li', undefined, model.more));
    instrumentsProblems.replaceChildren(...rows);
    if (instrumentsProblems.hidden !== (rows.length === 0)) instrumentsProblems.hidden = rows.length === 0;
    const closing = partText(model.closing);
    setText(instrumentsMessageClosing, closing);
    if (instrumentsMessageClosing.hidden !== (closing === '')) instrumentsMessageClosing.hidden = closing === '';
    if (instrumentsMessage.hidden) instrumentsMessage.hidden = false;
    if (!instrumentsBody.hidden) instrumentsBody.hidden = true;
    // The controls exist only while the cards show: a message takes the cards, and with them every switch, out of the page.
    instrumentsList.replaceChildren();
    cardRefs = [];
    // A message about the file itself (invalid, absent, unreadable, another build) is the explanation: the drafts go.
    if (['invalid', 'absent', 'unreadable', 'build-mismatch'].includes(model.state)) editors.clear();
  }

  /** The card of the list that holds focus, as its data-instrument value, or null. Walks the children: no selector is built from an id. */
  function focusedInstrument() {
    const active = document.activeElement;
    if (active === null || !instrumentsList.contains(active)) return null;
    for (const child of instrumentsList.children) {
      if (child.contains(active)) return child.dataset.instrument;
    }
    return null;
  }

  /** Notes that a card's settings changed under an open editor: the muted line shows once, unless this editor's own save is the cause. */
  function noteChangedElsewhere(card) {
    const state = editors.get(card.id);
    if (state === undefined) return;
    const now = JSON.stringify(card.settings);
    if (now === state.openedWith) return;
    if (!state.saving) state.changedElsewhere = true;
    state.openedWith = now;
  }

  /**
   * Where focus is inside one drawn card, by role (the card, its switch, Edit settings, a field of its editor, a Drum map
   * summary), or null when focus is not inside it. Walks the drawn refs: no selector is built from an id.
   */
  function focusSpot(refs) {
    const active = document.activeElement;
    if (active === null || active === undefined || !refs.item.contains(active)) return null;
    if (active === refs.switchNodes.button) return { role: 'switch' };
    if (active === refs.editButton) return { role: 'edit' };
    const editor = refs.editor;
    if (editor !== null) {
      if (active === editor.select) return { role: 'port' };
      if (active === editor.clock) return { role: 'clock' };
      if (active === editor.save) return { role: 'save' };
      if (active === editor.cancel) return { role: 'cancel' };
      for (const [channel, input] of editor.chips) if (input === active) return { role: 'chip', channel };
    }
    for (const { key, summary } of refs.opens) if (summary === active) return { role: 'map', key };
    return { role: 'card' };
  }

  /** Puts focus back on the same role in a new card, else on Edit settings when the editor is gone, else on the card. Never scrolls. */
  function restoreSpot(refs, spot) {
    const editor = refs.editor;
    let node = refs.item;
    if (spot.role === 'switch') node = refs.switchNodes.button;
    else if (spot.role === 'edit') node = editor === null ? refs.editButton : refs.item;
    else if (spot.role === 'map') node = (refs.opens.find((entry) => entry.key === spot.key) ?? { summary: refs.item }).summary;
    else if (spot.role !== 'card') {
      if (editor === null) node = refs.editButton;
      else if (spot.role === 'port') node = editor.select;
      else if (spot.role === 'clock') node = editor.clock;
      else if (spot.role === 'save') node = editor.save;
      else if (spot.role === 'cancel') node = editor.cancel;
      else node = editor.chips.get(spot.channel) ?? editor.select;
    }
    node.focus({ preventScroll: true });
  }

  /** Rebuilds every card. The scroll and, when focus was in the list, the focus stay with the user's place. */
  function rebuildCards(model) {
    const focusedId = focusedInstrument();
    const before = focusedId === null ? undefined : cardRefs.find((entry) => entry.id === focusedId);
    const spot = before === undefined ? null : focusSpot(before);
    const scrollTop = instrumentsBody.scrollTop;
    rememberOpenMaps();
    for (const card of model.cards) noteChangedElsewhere(card);
    const built = model.cards.map((card, index) => cardNode(card, index));
    cardRefs = built.map((entry) => entry.refs);
    instrumentsList.replaceChildren(...built.map((entry) => entry.item));
    if (!instrumentsMessage.hidden) instrumentsMessage.hidden = true;
    if (instrumentsBody.hidden) instrumentsBody.hidden = false;
    instrumentsBody.scrollTop = scrollTop;
    if (focusedId === null) return;
    const refs = cardRefs.find((entry) => entry.id === focusedId);
    if (refs !== undefined) {
      restoreSpot(refs, spot === null ? { role: 'card' } : spot);
    } else {
      // The card that held focus is gone: the first card, else the view.
      (instrumentsList.firstElementChild ?? instrumentsView).focus({ preventScroll: true });
    }
    instrumentsBody.scrollTop = scrollTop;
  }

  /**
   * Replaces only the cards whose declared facts changed (a Clock row appears, the channels change the Drum kit row,
   * another port): every other card keeps its node and is updated in place. Focus that was inside a replaced card goes back
   * to the same role in its new node; nothing else is focused, and the scroll stays.
   */
  function replaceCards(previous, model) {
    const indices = cardsToReplace(previous, model);
    const scrollTop = instrumentsBody.scrollTop;
    updateCards(previous, model, indices);
    for (const index of indices) {
      const old = cardRefs[index];
      const spot = focusSpot(old);
      rememberOpenMaps(old);
      noteChangedElsewhere(model.cards[index]);
      const { item, refs } = cardNode(model.cards[index], index);
      old.item.replaceWith(item);
      cardRefs[index] = refs;
      if (spot !== null) restoreSpot(refs, spot);
    }
    instrumentsBody.scrollTop = scrollTop;
  }

  /** Updates the changed parts of each card in place: the dot, the state words, the Drum kit lines, the In use lines and the Drum map lines. */
  function updateCards(previous, model, skip = []) {
    model.cards.forEach((card, index) => {
      if (skip.includes(index)) return;
      const before = previous.cards[index];
      const refs = cardRefs[index];
      if (card.enabled !== before.enabled) {
        // A switch changed elsewhere (another page, Claude's session, a settle): the same nodes, in place, no focus call.
        refs.enabled = card.enabled;
        refs.item.dataset.enabled = String(card.enabled);
        // The line was about a state that no longer is.
        switchErrors.delete(refs.id);
        drawError(refs);
        drawSwitch(refs);
      }
      if (card.port.dot.kind !== before.port.dot.kind) refs.dot.dataset.kind = card.port.dot.kind;
      if (card.port.dot.title !== before.port.dot.title) refs.dot.setAttribute('title', card.port.dot.title);
      setText(refs.words, card.port.words);
      if (card.port.attention !== before.port.attention) refs.words.dataset.attention = String(card.port.attention);
      if (JSON.stringify(card.inUse) !== JSON.stringify(before.inUse)) refs.inUse.replaceChildren(...inUseLines(card.inUse));
      if (card.drumKit !== null && JSON.stringify(card.drumKit) !== JSON.stringify(before.drumKit)) refs.drumKit.replaceChildren(...drumKitLines(card.drumKit));
      if (card.drumMaps !== null && JSON.stringify(card.drumMaps) !== JSON.stringify(before.drumMaps)) {
        // The drawn flags are read first and the focus noted, because the nodes are replaced: a map that stays keeps its state.
        const focusedDrum = focusedSummary();
        rememberOpenMaps(refs);
        const built = drumMapNodes(card.id, card.drumMaps);
        refs.maps.replaceChildren(...built.nodes);
        refs.opens = built.opens;
        if (focusedDrum !== null && focusedDrum.id === card.id) refocusSummary(refs, focusedDrum.key);
      }
    });
  }

  /** Draws the cards (a rebuild or an in-place update) and says what changed to a screen reader. */
  function showCards(previous, model, plan) {
    latestCards = new Map(model.cards.map((card) => [card.id, card]));
    latestPorts = model.ports;
    // An instrument that is no longer in the file takes its draft with it.
    for (const id of [...editors.keys()]) if (!latestCards.has(id)) editors.delete(id);
    if (plan === 'live') updateCards(previous, model);
    else if (plan === 'replace') replaceCards(previous, model);
    else rebuildCards(model);
    for (const refs of cardRefs) if (refs.editor !== null) syncEditor(refs);
    setText(instrumentsFooter, model.footer);
    const spoken = announcements(shownKinds, model);
    shownKinds = spoken.kinds;
    if (spoken.text !== '') setText(instrumentsStatus, spoken.text);
  }

  function render(model) {
    const json = JSON.stringify(model);
    if (json === shownJson) return;
    const previous = shownModel;
    const plan = redrawPlan(previous, model);
    try {
      const notice = partText(model.notice);
      setText(instrumentsNotice, notice);
      if (instrumentsNotice.hidden !== (notice === '')) instrumentsNotice.hidden = notice === '';
      if (model.kind === 'message') {
        shownKinds = null;
        showMessage(model);
      } else {
        showCards(previous, model, plan);
      }
    } catch (err) {
      // The DOM may be half drawn: forget it, so the same model is drawn again from scratch instead of being skipped.
      shownModel = null;
      shownJson = null;
      shownKinds = null;
      cardRefs = [];
      throw err;
    }
    shownModel = model;
    shownJson = json;
  }

  /** The view closed: forget what was drawn, so the next drawing is a first one and announces nothing. */
  function closed() {
    // The open Drum maps are kept in memory while the page lives: a closed view keeps its cards drawn, so read them now.
    rememberOpenMaps();
    shownModel = null;
    shownJson = null;
    shownKinds = null;
    setText(instrumentsStatus, '');
  }

  /**
   * What a right-click on `target` landed on, as the descriptor page/ask.js describes, or null when it landed on
   * nothing this view answers for (the caller then uses the whole session): a card gives its instrument, while a
   * message, the notice, the footer and the gap between cards give null. It attaches no listener: page/main.js owns
   * the only right-click listener and decides which view answers first.
   */
  function askTarget(target) {
    if (shownModel === null || shownModel.kind === 'message') return null;
    const card = target.closest('.instrument-card');
    if (card === null || card.parentElement !== instrumentsList) return null;
    const id = card.dataset.instrument;
    return id === undefined || id === '' ? null : { kind: 'instrument', id };
  }

  /**
   * Ends the pending look of one switch: the server answered (`outcome.ok`) or did not (`{ kind: 'unconfirmed' }`, a
   * refusal, a write failure). The switch is drawn again from the card on screen, so it shows the state the server
   * confirmed, and a failure leaves one line under the header that says why. A request settled while the cards are
   * replaced by a message keeps its line in memory for the cards that return. An instrument with no card and no
   * request is ignored.
   */
  function settle(instrumentId, outcome, kind = 'switch') {
    if (kind === 'settings') {
      settleSettings(instrumentId, outcome);
      return;
    }
    const refs = cardRefs.find((entry) => entry.id === instrumentId);
    if (refs === undefined && !pendingSwitches.has(instrumentId)) return;
    const target = pendingSwitches.has(instrumentId) ? pendingSwitches.get(instrumentId) : refs !== undefined && !refs.enabled;
    pendingSwitches.delete(instrumentId);
    if (outcome.ok === true) switchErrors.delete(instrumentId);
    else switchErrors.set(instrumentId, switchRefusalText({ id: instrumentId, target, outcome }));
    if (refs !== undefined) {
      drawError(refs);
      drawSwitch(refs);
    }
  }

  return { render, closed, askTarget, settle };
}
