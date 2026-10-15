// DOM factory for the Mixer view (key 3): one vertical strip per track, side by side.
// Built with DOM methods only: track names are arbitrary text from the code, so they only ever
// reach the page through textContent and title, never through an HTML-parsing property.
// `document` and `gesture` are injected (like page/history-view.js), so this module has no DOM
// access at import time and page/main.js imports it without a build step. The parameter is named
// `document` so every lookup reads `const x = document.getElementById('...')`, the shape
// test/page-hidden.test.js scans.

import { MIXER_COPY, inspectorModel, mixerHistoryLabel, mixerNotice as noticeFor } from './mixer-model.js';
import { BUS_IDS, GAIN_STEPS, MOVE_OVER_MAX, MOVE_OVER_MIN, PARAM_STEPS, SENDS, effectById, fixedFromMove, formatNumber, moveFromFixed, positionToGain, positionToValue, roundToParam, valueToPosition } from './mixer-registry.js';

/**
 * `midiPreview` is `{ move(target), flush() }` (page/midi-controls.js createPreviewSender): it sends the CC of a
 * MIDI fader while it is dragged and the last value at its release, with no evaluation.
 * `onStripSelect()` (optional) is called after the user selects or clears a track strip (a click on its name, or a
 * primary-button pointer-down inside it); a render never calls it. The caller reads `selectedStrip()` then.
 * `onGroupFold(key)` is called when a group's fold button is pressed; the caller changes the fold state both views share
 * and draws the Mixer again (the view itself never folds anything).
 */
export function createMixerView({ document, gesture, midiPreview, onStripSelect = null, onGroupFold }) {
  if (!midiPreview || typeof midiPreview.move !== 'function' || typeof midiPreview.flush !== 'function') {
    throw new Error('Moontide: the Mixer view needs a midiPreview with move and flush.');
  }
  if (onStripSelect !== null && typeof onStripSelect !== 'function') {
    throw new Error('Moontide: the Mixer view needs onStripSelect to be a function.');
  }
  if (typeof onGroupFold !== 'function') {
    throw new Error('Moontide: the Mixer view needs onGroupFold to be a function.');
  }
  const mixerView = document.getElementById('mixer-view');
  const mixerNotice = document.getElementById('mixer-notice');
  const mixerMessage = document.getElementById('mixer-message');
  const mixerBody = document.getElementById('mixer-body');
  const mixerStrips = document.getElementById('mixer-strips');
  const mixerInspector = document.getElementById('mixer-inspector');
  const mixerNoNotes = document.getElementById('mixer-nonotes');
  if (!mixerView || !mixerNotice || !mixerMessage || !mixerBody || !mixerStrips || !mixerInspector || !mixerNoNotes) {
    throw new Error('Moontide: the Mixer markup is missing from the page.');
  }

  // One entry per identity: { el, nameEl, rootNoteEl, reasonEl, faderEl, readoutEl, chainEl, sendRows, chips, current, pointerDown }.
  const refs = new Map();
  // One entry per bus strip, keyed `${orbit}:${bus}`: { el, titleEl, chipsEl, fedByEl, warningEl, chips, current }.
  const busRefs = new Map();
  // One entry per group frame, keyed by the group's key: { el, foldEl, chevronEl, nameEl, countEl, muteEl, soloEl, noteEl, bodyEl, current, stale }.
  const groupRefs = new Map();
  // Counts the bodies built, so each group body has an id of its own for the fold button's aria-controls.
  let groupBodies = 0;

  // The inspector's own state: the selected chip's key, the shape of the rows drawn, the rows by
  // parameter id, the model it shows, whether More parameters is open, and whether a control kept its
  // own value while it was held (the value is applied at the first render after it is let go).
  const insp = { key: null, signature: null, rows: new Map(), data: null, moreOpen: false, stale: false, revealed: null };

  // View state (kept while the view is closed and reopened in the same page, forgotten on reload):
  // the chip the user selected, `{ identity, effect }`, or a control of a MIDI track, `{ identity, midi: true,
  // control }`, or a bus, `{ bus, orbit }`, or null. A selected chip (or bus) has its inspector open.
  let selection = null;
  // The track strip the user selected (its identity) or null: its block of code is lit in the editor. A separate state from
  // `selection` (the inspector's): selecting a chip, a MIDI control or a bus never changes it.
  let selectedStrip = null;
  // The strip whose control the user just used to select something: when that opens a new inspector,
  // the strips area scrolls once, by the smallest amount, so this strip stays whole beside the pane.
  let pendingReveal = null;
  // The model of the last render, which the inspector is drawn from.
  let lastModel = null;

  // The inputs of the one notice line above the strips (MIXER_COPY.disconnected / .waiting / .dirty).
  let connection = 'connecting';
  let dirty = false;
  let waiting = false;
  let writable = false;

  /** The single rule for disabling: every control that writes carries data-writes="true" and is
   * disabled while a notice is up, while its strip cannot be edited, or when its own control is off
   * (`controlDisabled`, from the model). Every control that writes carries the same attribute.
   * Reading, scrolling and selecting controls never carry it. */
  function refreshDisabled() {
    for (const ref of refs.values()) {
      for (const control of ref.el.querySelectorAll('[data-writes="true"]')) {
        control.disabled = !writable || !ref.current.editable || control.dataset.controlDisabled === 'true';
      }
    }
    // A group head's own buttons (never the frame's querySelectorAll: a frame holds its strips' controls too). They are off
    // while a notice is up and when the group has no track they can reach; the fold button is never one of them.
    // A frame the model no longer has (kept only because a held strip is inside) is off too: its tracks are out of date.
    for (const groupRef of groupRefs.values()) {
      for (const control of [groupRef.muteEl, groupRef.soloEl]) {
        control.disabled = !writable || groupRef.stale === true || control.dataset.controlDisabled === 'true';
      }
    }
    // The inspector's writing controls follow the same rule; a bypassed effect is read-only.
    const inspectorEditable = insp.data !== null && insp.data.editable;
    for (const control of mixerInspector.querySelectorAll('[data-writes="true"]')) {
      control.disabled = !writable || !inspectorEditable || control.dataset.controlDisabled === 'true';
    }
  }

  function refreshNotice() {
    const notice = noticeFor({ connection, dirty, waiting });
    writable = notice.kind === null;
    mixerNotice.textContent = notice.text;
    mixerNotice.hidden = notice.kind === null;
    refreshDisabled();
  }

  /** The filled share of a fader at `position`, from the fader's own range (0..GAIN_STEPS for a browser track). */
  function fillPercent(position, faderEl) {
    const min = Number(faderEl.min);
    const max = Number(faderEl.max);
    return `${max > min ? ((position - min) / (max - min)) * 100 : 0}%`;
  }

  function showFader(ref, position, readout, ariaText = readout) {
    ref.faderEl.value = String(position);
    ref.faderEl.style.setProperty('--fill', fillPercent(position, ref.faderEl));
    ref.faderEl.setAttribute('aria-valuetext', ariaText);
    ref.readoutEl.textContent = readout;
  }

  /** The fader's own `input` and `change` events feed the gesture recorder: `input` for every move
   * of a drag or key press, `change` for its release. */
  function faderEvent(ref, method) {
    if (ref.current.midi !== null) {
      midiFaderEvent(ref, method);
      return;
    }
    const position = Number(ref.faderEl.value);
    const value = positionToGain(position);
    const { identity, name } = ref.current;
    ref.faderEl.style.setProperty('--fill', fillPercent(position, ref.faderEl));
    ref.faderEl.setAttribute('aria-valuetext', value.toFixed(2));
    ref.readoutEl.textContent = value.toFixed(2);
    ref.readoutEl.removeAttribute('data-muted');
    gesture[method](`${identity}|fader`, { identity, type: 'gain', value }, mixerHistoryLabel({ kind: 'volume', name, value }));
  }

  /**
   * The fader of a MIDI strip (the instrument's own volume, whole numbers). While it is dragged each move sends
   * the CC to the instrument (rate limited) and keeps the gesture open without any evaluation; at its release the
   * last value is sent and the code is rewritten once with it (one evaluation, one version).
   */
  function midiFaderEvent(ref, method) {
    const { identity, name, midi, fader } = ref.current;
    const value = Math.round(Number(ref.faderEl.value));
    ref.faderEl.style.setProperty('--fill', fillPercent(value, ref.faderEl));
    ref.faderEl.setAttribute('aria-valuetext', String(value));
    ref.readoutEl.textContent = String(value);
    ref.readoutEl.removeAttribute('data-muted');
    const key = `${identity}|fader`;
    const label = mixerHistoryLabel({ kind: 'volume', name, value });
    if (method === 'move') {
      midiPreview.move({ instrumentId: midi.instrumentId, channel: midi.channel, cc: fader.cc, value });
      gesture.preview(key, label);
      return;
    }
    midiPreview.flush();
    gesture.release(key, { type: 'midi-control', identity, port: midi.port, channel: midi.channel, control: fader.control, cc: fader.cc, value }, label);
  }

  /** One M or S button: a letter, an accessible name added by updateStrip, and the writing rule. */
  function createToggle(className, letter, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = letter;
    button.title = title;
    button.dataset.writes = 'true';
    return button;
  }

  /** A press of M or S is one discrete change: applied and recorded at once, one history version. */
  function press(ref, kind) {
    const { identity, name } = ref.current;
    const on = !ref.current[kind].pressed;
    gesture.discrete({ identity, type: kind, on }, mixerHistoryLabel({ kind, name, on }));
  }

  /**
   * A press of a group's M or S: one discrete change for every track the button reaches, applied and recorded at once, one
   * history version. The direction is the one the model drew: a group with none or some of its tracks pressed presses them
   * all, a group with every track pressed lets them all go.
   */
  function pressGroup(ref, kind) {
    // The buttons of a frame the model no longer has are disabled; this keeps a press that still arrives from writing old names.
    if (ref.stale === true) return;
    const { name } = ref.current;
    const { on, identities } = ref.current[kind];
    gesture.discrete({ type: 'group', kind, on, identities, group: name }, mixerHistoryLabel({ kind: kind === 'mute' ? 'group-mute' : 'group-solo', group: name, on }));
  }

  /** Scrolls the strips area sideways, instantly, by the smallest amount that puts `stripEl` wholly in
   * view (keeping the area's own left padding as a margin). Only the strips area moves. */
  function revealStrip(stripEl) {
    const padding = parseFloat(document.defaultView.getComputedStyle(mixerStrips).paddingLeft) || 0;
    const box = mixerStrips.getBoundingClientRect();
    const strip = stripEl.getBoundingClientRect();
    const left = box.left + mixerStrips.clientLeft + padding;
    const right = box.left + mixerStrips.clientLeft + mixerStrips.clientWidth;
    if (strip.left >= left && strip.right <= right) return;
    // Too wide for the area (or cut on the left): align its left edge. Otherwise bring its right edge in.
    const delta = strip.right > right && strip.width <= right - left ? strip.right - right : strip.left - left;
    mixerStrips.scrollLeft += delta;
  }

  /** One chip: `[dot][body]`. The dot is the bypass switch, the body selects the chip. */
  function createChip(ref, effect) {
    const el = document.createElement('div');
    el.className = 'mx-chip';
    el.dataset.effect = effect;
    const dotEl = document.createElement('button');
    dotEl.type = 'button';
    dotEl.className = 'mx-chip-dot';
    dotEl.title = MIXER_COPY.bypassTitle;
    dotEl.dataset.writes = 'true';
    const dot = document.createElement('span');
    dot.className = 'mx-dot';
    dotEl.append(dot);
    const bodyEl = document.createElement('button');
    bodyEl.type = 'button';
    bodyEl.className = 'mx-chip-body';
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-chip-name';
    const valueEl = document.createElement('span');
    valueEl.className = 'mx-chip-value';
    bodyEl.append(nameEl, valueEl);
    el.append(dotEl, bodyEl);
    // `data` is the model's chip, set by updateChip; the dot reads it at click time.
    const chip = { el, dotEl, bodyEl, nameEl, valueEl, data: null };
    bodyEl.addEventListener('click', () => {
      const { identity } = ref.current;
      pendingReveal = ref.el;
      selection = selection && selection.identity === identity && selection.effect === effect ? null : { identity, effect };
      refreshSelection();
      renderInspector();
    });
    dotEl.addEventListener('click', () => bypassPress(ref, chip));
    return chip;
  }

  /** A press of a chip's dot: bypass takes the effect out of the code, a press on a bypassed chip writes
   * its stored calls back. Each is one discrete change, one history version. */
  function bypassPress(ref, chip) {
    const { identity, name } = ref.current;
    const { effect, bypassed, calls } = chip.data;
    if (bypassed) {
      gesture.discrete({ identity, type: 'restore-effect', effect, calls }, mixerHistoryLabel({ kind: 'restore', name, effect }));
    } else {
      gesture.discrete({ identity, type: 'bypass-effect', effect }, mixerHistoryLabel({ kind: 'bypass', name, effect }));
    }
  }

  function updateChip(ref, chip, data) {
    const { identity, name } = ref.current;
    const { effect } = data;
    chip.el.dataset.track = identity;
    // Deep-link attributes: every mixer control says which track and effect it is.
    for (const control of [chip.dotEl, chip.bodyEl]) {
      control.dataset.track = identity;
      control.dataset.effect = effect;
    }
    chip.nameEl.textContent = data.name;
    chip.valueEl.textContent = data.summary;
    chip.valueEl.title = data.summary;
    chip.bodyEl.setAttribute('aria-label', `${data.name} on ${name}: ${data.summary}. Edit parameters.`);
    chip.dotEl.setAttribute('aria-label', `Bypass ${data.name} on ${name}`);
    chip.dotEl.setAttribute('aria-pressed', String(!data.bypassed));
    chip.dotEl.dataset.controlDisabled = String(data.bypassDisabled);
    // A bypass that is off says why in its title; otherwise the title says what a bypass does.
    chip.dotEl.title = data.bypassDisabled ? data.bypassReason : MIXER_COPY.bypassTitle;
    if (data.bypassed) {
      chip.el.dataset.bypassed = 'true';
    } else {
      chip.el.removeAttribute('data-bypassed');
    }
    chip.data = data;
  }

  function refreshSelection() {
    for (const ref of refs.values()) {
      for (const [effect, chip] of ref.chips) {
        const selected = selection !== null && selection.identity === ref.current.identity && selection.effect === effect;
        chip.el.dataset.selected = String(selected);
      }
      for (const [control, chip] of ref.midiChips) {
        const selected = selection !== null && selection.midi === true && selection.identity === ref.current.identity && selection.control === control;
        chip.el.dataset.selected = String(selected);
      }
    }
    for (const ref of busRefs.values()) {
      ref.el.dataset.selected = String(selection !== null && selection.bus === ref.current.bus && selection.orbit === ref.current.orbit);
    }
  }

  /** Marks the selected track strip (data-selected) and its name button (aria-pressed). */
  function refreshStripSelection() {
    for (const [identity, ref] of refs) {
      const selected = selectedStrip === identity;
      ref.el.dataset.selected = String(selected);
      ref.nameEl.setAttribute('aria-pressed', String(selected));
    }
  }

  /** The user selects a strip (`toggle`: a second press on the selected strip clears it). */
  function selectStrip(identity, toggle) {
    if (selectedStrip === identity && !toggle) return;
    selectedStrip = selectedStrip === identity ? null : identity;
    refreshStripSelection();
    if (onStripSelect !== null) onStripSelect();
  }

  /** The Add effect button and its list: one item per effect the track does not have yet. */
  function updateAddList(ref, addList) {
    if (addList.length === 0) {
      ref.addOpen = false;
      ref.addEl.remove();
      ref.addListEl.remove();
      return;
    }
    if (ref.addEl.parentNode !== ref.chainEl) ref.chainEl.append(ref.addEl, ref.addListEl);
    const key = addList.map((item) => item.effect).join(',');
    if (ref.addKey !== key) {
      ref.addKey = key;
      const items = addList.map((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mx-add-item';
        button.dataset.effect = item.effect;
        button.dataset.writes = 'true';
        const plain = document.createElement('span');
        plain.textContent = item.name;
        const method = document.createElement('span');
        method.className = 'mx-add-method';
        method.textContent = item.method;
        button.append(plain, method);
        button.addEventListener('click', () => pickEffect(ref, item.effect));
        return button;
      });
      ref.addListEl.replaceChildren(...items);
    }
    setAddOpen(ref, ref.addOpen);
  }

  function setAddOpen(ref, open) {
    ref.addOpen = open;
    ref.addEl.setAttribute('aria-expanded', String(open));
    ref.addListEl.toggleAttribute('hidden', !open);
  }

  /** Picking an effect adds it with its starting value, closes the list and selects the new chip. */
  function pickEffect(ref, effect) {
    const { identity, name } = ref.current;
    setAddOpen(ref, false);
    pendingReveal = ref.el;
    selection = { identity, effect };
    ref.addEl.focus();
    gesture.discrete({ identity, type: 'add-effect', effect }, mixerHistoryLabel({ kind: 'add-effect', name, effect }));
  }

  /** Keeps the chips of a strip in step with the model: keyed by effect, in the model's (chain) order. */
  function updateChain(ref, strip) {
    const seen = new Set();
    strip.chips.forEach((data, index) => {
      seen.add(data.effect);
      let chip = ref.chips.get(data.effect);
      if (!chip) {
        chip = createChip(ref, data.effect);
        ref.chips.set(data.effect, chip);
      }
      updateChip(ref, chip, data);
      if (ref.chainEl.children[index] !== chip.el) ref.chainEl.insertBefore(chip.el, ref.chainEl.children[index] || null);
    });
    for (const [effect, chip] of [...ref.chips]) {
      if (seen.has(effect)) continue;
      chip.el.remove();
      ref.chips.delete(effect);
    }
    updateAddList(ref, strip.addList);
  }

  // --- Control chips: the instrument's own controls on a MIDI strip (no bypass dot: a control is not an effect) ---

  /** One control chip of a MIDI strip: `[name][value]`, one button that opens the controls inspector of the track. */
  function createMidiChip(ref, control) {
    const el = document.createElement('div');
    el.className = 'mx-chip mx-midi-chip';
    el.dataset.effect = 'midi';
    el.dataset.param = control;
    const bodyEl = document.createElement('button');
    bodyEl.type = 'button';
    bodyEl.className = 'mx-chip-body';
    bodyEl.dataset.effect = 'midi';
    bodyEl.dataset.param = control;
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-chip-name';
    const valueEl = document.createElement('span');
    valueEl.className = 'mx-chip-value';
    bodyEl.append(nameEl, valueEl);
    el.append(bodyEl);
    const chip = { el, bodyEl, nameEl, valueEl, data: null };
    bodyEl.addEventListener('click', () => {
      const { identity } = ref.current;
      pendingReveal = ref.el;
      selection = selection && selection.midi === true && selection.identity === identity && selection.control === control ? null : { identity, midi: true, control };
      refreshSelection();
      renderInspector();
    });
    return chip;
  }

  function updateMidiChip(ref, chip, data) {
    const { identity } = ref.current;
    chip.el.dataset.track = identity;
    chip.bodyEl.dataset.track = identity;
    chip.nameEl.textContent = data.name;
    chip.valueEl.textContent = data.text;
    chip.valueEl.title = data.text;
    chip.bodyEl.title = data.title;
    chip.bodyEl.setAttribute('aria-label', data.label);
    chip.data = data;
  }

  /** Keeps the control chips of a MIDI strip in step with the model: keyed by control id, in the model's order. */
  function updateMidiChips(ref, chips) {
    const seen = new Set();
    chips.forEach((data, index) => {
      seen.add(data.control);
      let chip = ref.midiChips.get(data.control);
      if (!chip) {
        chip = createMidiChip(ref, data.control);
        ref.midiChips.set(data.control, chip);
      }
      updateMidiChip(ref, chip, data);
      if (ref.midiChipsEl.children[index] !== chip.el) ref.midiChipsEl.insertBefore(chip.el, ref.midiChipsEl.children[index] || null);
    });
    for (const [control, chip] of [...ref.midiChips]) {
      if (seen.has(control)) continue;
      chip.el.remove();
      ref.midiChips.delete(control);
    }
  }

  // --- Sends: one Reverb and one Delay row on every strip ---

  /** One send row: `[label][slider][value]`, or the word `moving` in place of the slider and value. */
  function createSendRow(ref, bus) {
    const el = document.createElement('div');
    el.className = 'mx-send';
    el.dataset.bus = bus;
    const labelEl = document.createElement('button');
    labelEl.type = 'button';
    labelEl.className = 'mx-send-label';
    labelEl.textContent = bus === 'reverb' ? MIXER_COPY.reverb : MIXER_COPY.delay;
    labelEl.setAttribute('aria-label', bus === 'reverb' ? MIXER_COPY.reverbBus : MIXER_COPY.delayBus);
    labelEl.dataset.bus = bus;
    const sliderEl = document.createElement('input');
    sliderEl.type = 'range';
    sliderEl.className = 'mx-send-slider';
    sliderEl.min = '0';
    sliderEl.max = '1';
    sliderEl.step = '0.01';
    sliderEl.dataset.writes = 'true';
    sliderEl.dataset.bus = bus;
    sliderEl.dataset.param = 'send';
    const valueEl = document.createElement('div');
    valueEl.className = 'mx-send-value';
    const movingEl = document.createElement('span');
    movingEl.className = 'mx-send-moving';
    movingEl.textContent = MIXER_COPY.moving;
    movingEl.toggleAttribute('hidden', true);
    el.append(labelEl, sliderEl, valueEl, movingEl);
    const row = { bus, el, labelEl, sliderEl, valueEl, movingEl };
    // The label selects the bus this track sends to (it never writes).
    labelEl.addEventListener('click', () => {
      const { orbit } = ref.current;
      if (orbit === null) return;
      pendingReveal = ref.el;
      selection = selection && selection.bus === bus && selection.orbit === orbit ? null : { bus, orbit };
      refreshSelection();
      renderInspector();
    });
    sliderEl.addEventListener('pointerdown', () => {
      ref.pointerDown = true;
    });
    const releasePointer = () => {
      ref.pointerDown = false;
      if (ref.vanished) dropStrip(ref);
    };
    sliderEl.addEventListener('pointerup', releasePointer);
    sliderEl.addEventListener('pointercancel', releasePointer);
    sliderEl.addEventListener('input', () => sendEvent(ref, row, 'move'));
    sliderEl.addEventListener('change', () => {
      ref.pointerDown = false;
      sendEvent(ref, row, 'release');
    });
    return row;
  }

  function showSend(row, position, readout) {
    row.sliderEl.value = String(position);
    row.sliderEl.style.setProperty('--fill', `${position * 100}%`);
    row.sliderEl.setAttribute('aria-valuetext', readout);
    row.valueEl.textContent = readout;
    if (Number(readout) <= 0) row.valueEl.dataset.muted = 'true';
    else row.valueEl.removeAttribute('data-muted');
  }

  /** A send slider's own `input` and `change` events feed the gesture recorder like the fader's: every
   * move is heard, one version is recorded, and a send back at exactly 0 takes its calls out of the code. */
  function sendEvent(ref, row, method) {
    const value = roundToParam(SENDS[row.bus], Number(row.sliderEl.value));
    const { identity, name, sends } = ref.current;
    showSend(row, value, value.toFixed(2));
    const send = sends.find((candidate) => candidate.bus === row.bus);
    gesture[method](`${identity}|send:${row.bus}`, { identity, type: 'send', bus: row.bus, value, busParams: send.joinParams }, mixerHistoryLabel({ kind: 'send', name, bus: row.bus, value }));
  }

  function updateSends(ref, strip, held) {
    strip.sends.forEach((send, index) => {
      const row = ref.sendRows[index];
      const label = send.bus === 'reverb' ? MIXER_COPY.reverb.toLowerCase() : MIXER_COPY.delay.toLowerCase();
      row.sliderEl.setAttribute('aria-label', `${strip.name} ${label} send`);
      for (const control of [row.sliderEl, row.labelEl]) control.dataset.track = strip.identity;
      row.sliderEl.dataset.controlDisabled = String(send.disabled || send.moving);
      row.labelEl.disabled = strip.orbit === null;
      row.sliderEl.toggleAttribute('hidden', send.moving);
      row.valueEl.toggleAttribute('hidden', send.moving);
      row.movingEl.toggleAttribute('hidden', !send.moving);
      if (send.title === null) row.el.removeAttribute('title');
      else row.el.title = send.title;
      if (!held) showSend(row, send.position, send.readout);
    });
  }

  /** Sets an element's text only when it changed, so drawing the same model again writes nothing. */
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  /** Sets an attribute only when its value changed. */
  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  /**
   * A light: a ring with a fill inside it. The fill is the part that changes (page/lights.js says how bright it is); the
   * whole light is decoration for the eye and is never announced, since a note would otherwise speak every time it plays.
   */
  function createLight() {
    const el = document.createElement('span');
    el.className = 'mx-light';
    el.setAttribute('aria-hidden', 'true');
    const fillEl = document.createElement('span');
    fillEl.className = 'mx-light-fill';
    el.append(fillEl);
    return { el, fillEl };
  }

  /**
   * The frame of one group: a head (the fold button with its chevron and name, then the count line) and a body that holds
   * the group's strips and sub-groups. Names reach the page only through textContent, title and setAttribute.
   */
  function createGroupFrame(item) {
    const el = document.createElement('div');
    el.className = 'mx-group';
    el.setAttribute('role', 'group');
    const head = document.createElement('div');
    head.className = 'mx-group-head';
    const titleRow = document.createElement('div');
    titleRow.className = 'mx-group-title';
    const foldEl = document.createElement('button');
    foldEl.type = 'button';
    foldEl.className = 'mx-fold';
    const chevronEl = document.createElement('span');
    chevronEl.className = 'mx-fold-chevron';
    chevronEl.setAttribute('aria-hidden', 'true');
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-fold-name';
    foldEl.append(chevronEl, nameEl);
    const light = createLight();
    titleRow.append(light.el, foldEl);
    const line = document.createElement('div');
    line.className = 'mx-group-line';
    const countEl = document.createElement('span');
    countEl.className = 'mx-group-count';
    const muteEl = createToggle('mx-mute', 'M', MIXER_COPY.mute);
    const soloEl = createToggle('mx-solo', 'S', MIXER_COPY.solo);
    line.append(countEl, muteEl, soloEl);
    // The one muted line that says why a button reaches fewer tracks, or that the group has none.
    const noteEl = document.createElement('p');
    noteEl.className = 'mx-group-note';
    noteEl.toggleAttribute('hidden', true);
    head.append(titleRow, line, noteEl);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'mx-group-body';
    groupBodies += 1;
    bodyEl.id = `mx-group-body-${groupBodies}`;
    foldEl.setAttribute('aria-controls', bodyEl.id);
    el.append(head, bodyEl);
    const ref = { el, foldEl, chevronEl, nameEl, lightEl: light.el, lightFillEl: light.fillEl, countEl, muteEl, soloEl, noteEl, bodyEl, current: item };
    // Only the caller changes the fold state: this view just says which group was pressed.
    // A frame the model no longer has (ref.stale) folds nothing: its group is not in the code any more.
    foldEl.addEventListener('click', () => {
      if (ref.stale !== true) onGroupFold(ref.current.key);
    });
    muteEl.addEventListener('click', () => pressGroup(ref, 'mute'));
    soloEl.addEventListener('click', () => pressGroup(ref, 'solo'));
    return ref;
  }

  function updateGroupFrame(ref, item) {
    ref.current = item;
    ref.stale = false;
    const { el } = ref;
    setAttr(el, 'aria-label', item.label);
    setAttr(el, 'data-group', item.key);
    setAttr(el, 'data-folded', String(!item.open));
    if (item.deep) setAttr(el, 'data-deep', 'true');
    else if (el.hasAttribute('data-deep')) el.removeAttribute('data-deep');
    setText(ref.chevronEl, item.open ? '\u25be' : '\u25b8');
    setText(ref.nameEl, item.text);
    setAttr(ref.nameEl, 'title', item.title);
    setAttr(ref.foldEl, 'aria-expanded', String(item.open));
    setAttr(ref.foldEl, 'title', item.foldTitle);
    // A function as the replacement keeps a `$` in a name from being read as a pattern.
    setAttr(ref.lightEl, 'title', MIXER_COPY.lightGroupTitle.replace('{group}', () => item.text));
    setText(ref.countEl, item.countText);
    setAttr(ref.countEl, 'title', item.countTitle);
    for (const [button, kind] of [[ref.muteEl, 'mute'], [ref.soloEl, 'solo']]) {
      const control = item[kind];
      setAttr(button, 'aria-label', control.name);
      setAttr(button, 'aria-pressed', String(control.pressed));
      setAttr(button, 'title', control.title);
      setAttr(button, 'data-control-disabled', String(control.disabled));
    }
    const noteText = item.noteText;
    setText(ref.noteEl, noteText ?? '');
    if (noteText === null) {
      if (ref.noteEl.hasAttribute('title')) ref.noteEl.removeAttribute('title');
    } else {
      setAttr(ref.noteEl, 'title', noteText);
    }
    if (ref.noteEl.hasAttribute('hidden') !== (noteText === null)) ref.noteEl.toggleAttribute('hidden', noteText === null);
    if (ref.bodyEl.hasAttribute('hidden') === item.open) ref.bodyEl.toggleAttribute('hidden', !item.open);
  }

  /**
   * Puts `desired` (elements) as the children of `parent`, in that order, moving only what is not already in place.
   * `held` holds the elements that must not be moved or removed (a strip whose fader the hand holds): they stay where
   * they are, and `misplaced` collects those that are not where the model wants them, so a later draw puts them right.
   */
  function place(parent, desired, held, misplaced) {
    const wanted = new Set(desired);
    for (const child of [...parent.children]) {
      if (wanted.has(child) || held.has(child)) continue;
      // A frame that still holds a held strip stays until the strip is let go.
      if (held.size > 0 && [...held].some((heldEl) => child.contains(heldEl))) continue;
      child.remove();
    }
    let next = null;
    for (let i = desired.length - 1; i >= 0; i--) {
      const el = desired[i];
      if (el.parentNode === parent && el.nextSibling === next) {
        next = el;
        continue;
      }
      if (held.has(el) && el.parentNode !== null) {
        misplaced.add(el);
        if (el.parentNode === parent) next = el;
        continue;
      }
      parent.insertBefore(el, next);
      next = el;
    }
  }

  function createStrip(strip) {
    const el = document.createElement('div');
    el.className = 'mx-strip';
    // The name is a button: a click selects the strip (lights its code in the editor), a second click clears it.
    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'mx-name';
    nameEl.setAttribute('aria-pressed', 'false');
    // The light sits before the name; the row keeps both on one line. A strip with no label has no light (updateStrip hides it).
    const nameRowEl = document.createElement('div');
    nameRowEl.className = 'mx-name-row';
    const light = createLight();
    nameRowEl.append(light.el, nameEl);
    // Present only for a strip the mixer cannot edit: the one muted line that says why.
    const reasonEl = document.createElement('div');
    reasonEl.className = 'mx-reason';
    // Present only for a strip built from shared code: the muted line that says the mixer reads just the track's own chain.
    const rootNoteEl = document.createElement('div');
    rootNoteEl.className = 'mx-root-note';
    rootNoteEl.toggleAttribute('hidden', true);
    // A MIDI strip names its instrument and channel right under its name: the name part ellipsizes, the channel part never shrinks.
    const tagEl = document.createElement('div');
    tagEl.className = 'mx-tag';
    tagEl.toggleAttribute('hidden', true);
    const tagNameEl = document.createElement('span');
    tagNameEl.className = 'mx-tag-name';
    const tagChannelEl = document.createElement('span');
    tagChannelEl.className = 'mx-tag-channel';
    tagEl.append(tagNameEl, tagChannelEl);
    const section = document.createElement('div');
    section.className = 'mx-fader-section';
    const faderEl = document.createElement('input');
    faderEl.className = 'mx-fader';
    faderEl.type = 'range';
    faderEl.min = '0';
    faderEl.max = String(GAIN_STEPS);
    faderEl.step = '1';
    faderEl.dataset.writes = 'true';
    const readoutEl = document.createElement('div');
    readoutEl.className = 'mx-readout';
    // Present only when the strip has a line to say: default, after gain, or both moving.
    const lineEl = document.createElement('div');
    lineEl.className = 'mx-fader-line';
    section.append(faderEl, readoutEl);
    // Mute and solo sit below the fader section and stay at full strength on a strip that is not sounding.
    const msEl = document.createElement('div');
    msEl.className = 'mx-ms';
    const muteEl = createToggle('mx-mute', 'M', MIXER_COPY.mute);
    const soloEl = createToggle('mx-solo', 'S', MIXER_COPY.solo);
    msEl.append(muteEl, soloEl);
    // The one muted line that says why S (or M) is off; shown with toggleAttribute('hidden').
    const noteEl = document.createElement('div');
    noteEl.className = 'mx-note';
    noteEl.toggleAttribute('hidden', true);
    // The chain: chips in Strudel's fixed order, then the Add effect button and its list.
    const chainEl = document.createElement('div');
    chainEl.className = 'mx-chain';
    const addEl = document.createElement('button');
    addEl.type = 'button';
    addEl.className = 'mx-add';
    addEl.textContent = MIXER_COPY.addEffect;
    addEl.dataset.writes = 'true';
    addEl.setAttribute('aria-expanded', 'false');
    const addListEl = document.createElement('div');
    addListEl.className = 'mx-add-list';
    addListEl.toggleAttribute('hidden', true);
    // The sends sit between the chain and the fader.
    const sendsEl = document.createElement('div');
    sendsEl.className = 'mx-sends';
    // A MIDI strip has no effect chain, no Add effect and no sends (browser effects do not reach an external
    // instrument): they are built, so every update works the same, but never put on the page.
    const midi = strip.midi !== null;
    // A MIDI strip says it in its own words: the control chips of its instrument, then why browser effects are gone.
    const midiChipsEl = document.createElement('div');
    midiChipsEl.className = 'mx-midi-chips';
    const midiNoteEl = document.createElement('div');
    midiNoteEl.className = 'mx-midi-note';
    midiNoteEl.textContent = MIXER_COPY.midiEffectsNote;
    // Who else plays this instrument and channel (a split drum kit): one muted line under the fader line, only when shared.
    const sharedEl = document.createElement('div');
    sharedEl.className = 'mx-shared';
    sharedEl.toggleAttribute('hidden', true);
    if (midi) {
      el.dataset.midi = 'true';
      el.append(nameRowEl, tagEl, rootNoteEl, midiChipsEl, midiNoteEl, section, sharedEl, msEl, noteEl);
    } else {
      el.append(nameRowEl, rootNoteEl, chainEl, sendsEl, section, msEl, noteEl);
    }
    const ref = { midi, el, nameEl, lightEl: light.el, lightFillEl: light.fillEl, rootNoteEl, sharedEl, tagEl, tagNameEl, tagChannelEl, reasonEl, faderEl, readoutEl, lineEl, section, muteEl, soloEl, noteEl, chainEl, addEl, addListEl, sendsEl, sendRows: [], chips: new Map(), midiChipsEl, midiNoteEl, midiChips: new Map(), addOpen: false, addKey: null, current: strip, pointerDown: false };
    for (const bus of BUS_IDS) {
      const row = createSendRow(ref, bus);
      ref.sendRows.push(row);
      sendsEl.append(row.el);
    }
    nameEl.addEventListener('click', () => selectStrip(ref.current.identity, true));
    // Touching any other control of the strip selects it too (no toggle); it never prevents the default, so every control keeps working.
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || nameEl.contains(event.target)) return;
      selectStrip(ref.current.identity, false);
    });
    addEl.addEventListener('click', () => setAddOpen(ref, !ref.addOpen));
    addListEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      // Esc with focus in the list closes the list only (not the view) and returns to the button.
      event.preventDefault();
      event.stopPropagation();
      setAddOpen(ref, false);
      addEl.focus();
    });
    muteEl.addEventListener('click', () => press(ref, 'mute'));
    soloEl.addEventListener('click', () => press(ref, 'solo'));
    faderEl.addEventListener('pointerdown', () => {
      ref.pointerDown = true;
    });
    const releasePointer = () => {
      ref.pointerDown = false;
      // A track that vanished while its fader was held is dropped now, at release.
      if (ref.vanished) dropStrip(ref);
    };
    faderEl.addEventListener('pointerup', releasePointer);
    faderEl.addEventListener('pointercancel', releasePointer);
    faderEl.addEventListener('input', () => faderEvent(ref, 'move'));
    faderEl.addEventListener('change', () => {
      ref.pointerDown = false;
      faderEvent(ref, 'release');
    });
    // The MIDI fader steps by 10 on PageUp and PageDown (set explicitly); a browser fader keeps its own keys.
    faderEl.addEventListener('keydown', (event) => {
      if (ref.current.midi !== null) pageStep(event, faderEl, (method) => faderEvent(ref, method));
    });
    return ref;
  }

  function dropStrip(ref) {
    ref.el.remove();
    refs.delete(ref.current.identity);
  }

  /** A fader is "held" while the pointer is down or a gesture is still pending: render never
   * writes its value then, so the model cannot pull the thumb away from the user's hand. */
  function isHeld(ref) {
    return ref.pointerDown || gesture.hasPending();
  }

  function updateStrip(ref, strip) {
    ref.current = strip;
    ref.el.dataset.track = strip.identity;
    ref.el.dataset.color = String(strip.color);
    ref.nameEl.textContent = strip.name;
    ref.nameEl.title = strip.name;
    const hasLight = strip.lightKey !== null && strip.lightKey !== undefined;
    if (ref.lightEl.hasAttribute('hidden') === hasLight) ref.lightEl.toggleAttribute('hidden', !hasLight);
    setAttr(ref.lightEl, 'title', MIXER_COPY.lightTrackTitle.replace('{name}', () => strip.name));
    const tag = strip.midi === null ? null : strip.midi.tag;
    ref.tagEl.toggleAttribute('hidden', tag === null);
    ref.tagNameEl.textContent = tag === null ? '' : tag.name;
    ref.tagChannelEl.textContent = tag === null ? '' : tag.channel;
    if (tag === null) ref.tagEl.removeAttribute('title');
    else ref.tagEl.title = tag.title;
    const sharedText = strip.midi === null ? '' : strip.midi.sharedText;
    ref.sharedEl.textContent = sharedText;
    ref.sharedEl.toggleAttribute('hidden', sharedText === '');
    if (sharedText === '') ref.sharedEl.removeAttribute('title');
    else ref.sharedEl.title = strip.midi.sharedTitle;
    ref.rootNoteEl.textContent = strip.sharedRootText ?? '';
    ref.rootNoteEl.toggleAttribute('hidden', strip.sharedRootText === null);
    if (strip.sharedRootTitle === null) ref.rootNoteEl.removeAttribute('title');
    else ref.rootNoteEl.title = strip.sharedRootTitle;
    // Deep-link attributes: every strip control says which track it belongs to.
    for (const control of [ref.faderEl, ref.muteEl, ref.soloEl, ref.addEl]) control.dataset.track = strip.identity;
    if (strip.midi === null) {
      ref.faderEl.setAttribute('aria-label', `${strip.name} volume`);
      ref.faderEl.dataset.param = 'gain';
    } else {
      ref.faderEl.min = String(strip.fader.min);
      ref.faderEl.max = String(strip.fader.max);
      ref.faderEl.setAttribute('aria-label', MIXER_COPY.midiFaderLabel.replace('{track}', strip.name));
      ref.faderEl.dataset.effect = 'midi';
      ref.faderEl.dataset.param = strip.fader.control ?? 'volume';
    }
    ref.el.dataset.editable = String(strip.editable);
    ref.el.dataset.sounding = String(strip.sounding);
    for (const [button, kind, label] of [
      [ref.muteEl, 'mute', MIXER_COPY.mute],
      [ref.soloEl, 'solo', MIXER_COPY.solo],
    ]) {
      button.setAttribute('aria-label', `${label} ${strip.name}`);
      button.setAttribute('aria-pressed', String(strip[kind].pressed));
      button.dataset.controlDisabled = String(strip[kind].disabled);
    }
    const noteText = strip.solo.noteText ?? strip.mute.reasonText;
    ref.noteEl.textContent = noteText ?? '';
    ref.noteEl.toggleAttribute('hidden', noteText === null);
    // The browser strip's reason first; a MIDI strip that can be read but whose controls are off says why instead.
    const reasonText = strip.reasonText ?? (strip.midi === null ? null : strip.midi.reasonText);
    if (reasonText === null) {
      ref.reasonEl.remove();
    } else {
      ref.reasonEl.textContent = reasonText;
      ref.reasonEl.title = reasonText;
      if (ref.reasonEl.parentNode !== ref.el) ref.el.insertBefore(ref.reasonEl, (ref.midi ? ref.tagEl : ref.nameEl).nextSibling);
    }
    ref.faderEl.dataset.controlDisabled = String(strip.fader.disabled);
    if (strip.fader.lineText === null) {
      ref.lineEl.remove();
    } else {
      ref.lineEl.textContent = strip.fader.lineText;
      if (strip.fader.lineTitle === null) {
        ref.lineEl.removeAttribute('title');
      } else {
        ref.lineEl.title = strip.fader.lineTitle;
      }
      if (ref.lineEl.parentNode !== ref.section) ref.section.append(ref.lineEl);
    }
    ref.vanished = false;
    ref.midiNoteEl.toggleAttribute('hidden', strip.midi === null);
    updateMidiChips(ref, strip.midi === null ? [] : strip.midi.chips);
    updateChain(ref, strip);
    updateSends(ref, strip, isHeld(ref));
    if (!isHeld(ref)) {
      ref.stale = false;
      showFader(ref, strip.fader.position, strip.fader.readout, strip.midi === null ? strip.fader.readout : strip.fader.ariaValueText);
      if (strip.fader.readoutMuted) {
        ref.readoutEl.dataset.muted = 'true';
      } else {
        ref.readoutEl.removeAttribute('data-muted');
      }
    } else {
      // Held: the element and its value stay; every other field above was updated. The model's
      // value is applied at the first render after the release (hasStale lets the page ask for it).
      ref.stale = true;
    }
  }

  // --- Bus strips: one Reverb bus and one Delay bus per orbit that has a sending track ---

  /** Selects a bus (its inspector opens) or, when it already is the selection, closes it again. */
  function toggleBus(ref) {
    const entry = ref.current;
    pendingReveal = ref.el;
    selection = selection && selection.bus === entry.bus && selection.orbit === entry.orbit ? null : { bus: entry.bus, orbit: entry.orbit };
    refreshSelection();
    renderInspector();
  }

  /** One bus parameter chip: the chip shape without the bypass dot; its body opens the bus inspector. */
  function createBusChip(ref, param) {
    const el = document.createElement('div');
    el.className = 'mx-chip';
    el.dataset.param = param;
    const bodyEl = document.createElement('button');
    bodyEl.type = 'button';
    bodyEl.className = 'mx-chip-body';
    bodyEl.dataset.param = param;
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-chip-name';
    const valueEl = document.createElement('span');
    valueEl.className = 'mx-chip-value';
    bodyEl.append(nameEl, valueEl);
    el.append(bodyEl);
    bodyEl.addEventListener('click', () => toggleBus(ref));
    return { el, bodyEl, nameEl, valueEl };
  }

  function createBusStrip(entry) {
    const el = document.createElement('div');
    el.className = 'mx-strip mx-bus';
    const titleEl = document.createElement('div');
    titleEl.className = 'mx-name';
    const chipsEl = document.createElement('div');
    chipsEl.className = 'mx-chain';
    const fedByEl = document.createElement('div');
    fedByEl.className = 'mx-fedby';
    const warningEl = document.createElement('div');
    warningEl.className = 'mx-warning';
    warningEl.toggleAttribute('hidden', true);
    el.append(titleEl, chipsEl, fedByEl, warningEl);
    return { el, titleEl, chipsEl, fedByEl, warningEl, chips: new Map(), current: entry };
  }

  function updateBusStrip(ref, entry) {
    ref.current = entry;
    ref.el.dataset.bus = entry.bus;
    ref.el.dataset.orbit = String(entry.orbit);
    ref.titleEl.textContent = entry.title;
    ref.titleEl.title = entry.title;
    entry.chips.forEach((data, index) => {
      let chip = ref.chips.get(data.param);
      if (!chip) {
        chip = createBusChip(ref, data.param);
        ref.chips.set(data.param, chip);
      }
      chip.bodyEl.dataset.bus = entry.bus;
      chip.bodyEl.dataset.orbit = String(entry.orbit);
      chip.nameEl.textContent = data.name;
      chip.valueEl.textContent = data.valueText;
      chip.valueEl.title = data.valueText;
      chip.bodyEl.setAttribute('aria-label', `${data.name} of ${entry.title}: ${data.valueText}. Edit parameters.`);
      if (ref.chipsEl.children[index] !== chip.el) ref.chipsEl.insertBefore(chip.el, ref.chipsEl.children[index] || null);
    });
    ref.fedByEl.textContent = entry.fedByText;
    ref.fedByEl.title = entry.fedByText;
    ref.warningEl.textContent = entry.warningText ?? '';
    ref.warningEl.toggleAttribute('hidden', entry.warningText === null);
  }

  // --- The inspector: the selected effect's parameters or a bus's parameters ---

  const inspHeadEl = document.createElement('div');
  inspHeadEl.className = 'mx-insp-head';
  const inspTitleEl = document.createElement('div');
  inspTitleEl.className = 'mx-insp-title';
  const inspCloseEl = document.createElement('button');
  inspCloseEl.type = 'button';
  inspCloseEl.className = 'mx-insp-close';
  inspCloseEl.textContent = MIXER_COPY.close;
  inspHeadEl.append(inspTitleEl, inspCloseEl);
  // Present while the selected effect left the code: the sentence and the Close button say so.
  const inspGoneEl = document.createElement('div');
  inspGoneEl.className = 'mx-insp-gone';
  inspGoneEl.textContent = MIXER_COPY.gone;
  inspGoneEl.toggleAttribute('hidden', true);
  // The instrument line of a MIDI track's inspector: its tag and, when the code writes one, its sound.
  const inspLineEl = document.createElement('div');
  inspLineEl.className = 'mx-insp-line';
  inspLineEl.toggleAttribute('hidden', true);
  // The sentence that says the channel is shared and a change is written on every track of it (a MIDI controls inspector only).
  const inspSharedEl = document.createElement('div');
  inspSharedEl.className = 'mx-insp-shared';
  inspSharedEl.toggleAttribute('hidden', true);
  const inspRowsEl = document.createElement('div');
  inspRowsEl.className = 'mx-insp-rows';
  const writtenEl = document.createElement('div');
  writtenEl.className = 'mx-written';
  const writtenLabelEl = document.createElement('span');
  writtenLabelEl.className = 'mx-written-label';
  writtenLabelEl.textContent = MIXER_COPY.writtenAs;
  const writtenCodeEl = document.createElement('span');
  writtenCodeEl.className = 'mx-written-code';
  writtenEl.append(writtenLabelEl, writtenCodeEl);
  const inspFooterEl = document.createElement('div');
  inspFooterEl.className = 'mx-insp-footer';
  const untouchedEl = document.createElement('span');
  untouchedEl.className = 'mx-untouched';
  untouchedEl.textContent = MIXER_COPY.untouched;
  const removeEl = document.createElement('button');
  removeEl.type = 'button';
  removeEl.className = 'mx-remove';
  removeEl.textContent = MIXER_COPY.remove;
  removeEl.dataset.writes = 'true';
  inspFooterEl.append(untouchedEl, removeEl);
  // The always-shown line of a bus inspector (the reverb's costly parameters, the delay's feedback).
  const inspNoteEl = document.createElement('div');
  inspNoteEl.className = 'mx-insp-note';
  inspNoteEl.toggleAttribute('hidden', true);
  mixerInspector.append(inspHeadEl, inspLineEl, inspSharedEl, inspGoneEl, inspRowsEl, inspNoteEl, writtenEl, inspFooterEl);

  // The More parameters button and its rows, present while the effect has non-basic parameters.
  const moreToggleEl = document.createElement('button');
  moreToggleEl.type = 'button';
  moreToggleEl.className = 'mx-more-toggle';
  const moreEl = document.createElement('div');
  moreEl.className = 'mx-more';

  /** The text of a number as the field shows it: plain ASCII, so a number field can hold it. */
  function fieldText(row) {
    return row.value === null || row.value === '' ? '' : formatNumber(row.value);
  }

  function sliderFill(slider) {
    const min = Number(slider.min);
    const max = Number(slider.max);
    slider.style.setProperty('--fill', `${((Number(slider.value) - min) / (max - min)) * 100}%`);
  }

  /** Puts the deep-link attributes and the writing rule on one control of a row. */
  function tagControl(control, data, row, field) {
    if (field !== undefined) control.dataset.field = field;
    control.dataset.writes = 'true';
    control.dataset.track = data.identity;
    control.dataset.effect = data.effect;
    control.dataset.param = row.param;
  }

  function closeInspector(returnFocus) {
    const closing = selection;
    selection = null;
    refreshSelection();
    renderInspector();
    if (returnFocus && closing && closing.bus !== undefined) {
      const busRef = busRefs.get(`${closing.orbit}:${closing.bus}`);
      const first = busRef ? busRef.chips.values().next().value : undefined;
      if (first) first.bodyEl.focus();
      return;
    }
    if (returnFocus && closing) {
      const ref = refs.get(closing.identity);
      const chip = ref ? (closing.midi === true ? ref.midiChips.get(closing.control) : ref.chips.get(closing.effect)) : undefined;
      if (chip) chip.bodyEl.focus();
    }
  }

  /** A slider is a gesture: every move is heard, one version is recorded after the pause. A number, a
   * select, Default and Use a fixed value are one version each. */
  function paramChange(row, value) {
    return { identity: insp.data.identity, type: 'param', effect: row.effect, param: row.param, value };
  }

  function paramLabel(row, value) {
    return mixerHistoryLabel({ kind: 'param', name: insp.data.trackName, effect: row.effect, param: row.param, value });
  }

  function sliderEvent(r, method) {
    const { row } = r;
    const raw = Number(r.sliderEl.value);
    const value = row.scale === 'log' ? positionToValue(row, raw) : roundToParam(row, raw);
    sliderFill(r.sliderEl);
    r.numberEl.value = formatNumber(value);
    r.sliderEl.setAttribute('aria-valuetext', row.unit === '' ? formatNumber(value) : `${formatNumber(value)} ${row.unit}`);
    gesture[method](`${insp.data.identity}|param:${row.effect}.${row.param}`, paramChange(row, value), paramLabel(row, value));
  }

  /** A number typed into a field: a finite number is clamped and rounded by the registry and recorded at
   * once; anything else puts the field back (nothing is written). */
  function commitNumber(r) {
    const text = r.numberEl.value.trim();
    const typed = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(typed)) {
      r.numberEl.value = fieldText(r.row);
      return;
    }
    const value = roundToParam(r.row, typed);
    r.numberEl.value = formatNumber(value);
    r.sliderEl.value = String(r.row.scale === 'log' ? valueToPosition(r.row, value) : value);
    sliderFill(r.sliderEl);
    gesture.discrete(paramChange(r.row, value), paramLabel(r.row, value));
  }

  function createRow(row, data) {
    const el = document.createElement('div');
    el.className = 'mx-row';
    el.dataset.param = row.param;
    el.dataset.effect = data.effect;
    el.dataset.track = data.identity;
    const labelEl = document.createElement('div');
    labelEl.className = 'mx-row-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-row-name';
    nameEl.textContent = row.name;
    const subEl = document.createElement('span');
    subEl.className = 'mx-row-sub';
    labelEl.append(nameEl, subEl);
    const defaultEl = document.createElement('button');
    defaultEl.type = 'button';
    defaultEl.className = 'mx-default';
    defaultEl.textContent = MIXER_COPY.defaultButton;
    tagControl(defaultEl, data, row);
    defaultEl.setAttribute('aria-label', `${MIXER_COPY.defaultButton} ${row.name}`);
    el.append(labelEl);
    const r = { el, row, subEl, defaultEl, sliderEl: null, numberEl: null, selectEl: null, placeholderEl: null, pointerDown: false, group: false, fields: [] };
    const label = `${data.trackName} ${effectById(data.effect).name} ${row.name}`;
    defaultEl.addEventListener('click', () => {
      gesture.discrete(
        { identity: insp.data.identity, type: 'param-default', effect: r.row.effect, param: r.row.param },
        mixerHistoryLabel({ kind: 'param-default', name: insp.data.trackName, effect: r.row.effect, param: r.row.param }),
      );
    });
    if (row.kind === 'moving') {
      const movingEl = document.createElement('div');
      movingEl.className = 'mx-moving';
      const textEl = document.createElement('span');
      textEl.className = 'mx-moving-text';
      textEl.textContent = MIXER_COPY.movingFromCode;
      const fixedEl = document.createElement('button');
      fixedEl.type = 'button';
      fixedEl.className = 'mx-use-fixed';
      fixedEl.textContent = MIXER_COPY.useFixed;
      tagControl(fixedEl, data, row);
      fixedEl.addEventListener('click', () => {
        gesture.discrete(
          { identity: insp.data.identity, type: 'param-fixed', effect: r.row.effect, param: r.row.param },
          paramLabel(r.row, r.row.fixedValue),
        );
      });
      movingEl.append(textEl, fixedEl);
      el.append(movingEl);
    } else if (row.kind === 'select') {
      const selectEl = document.createElement('select');
      selectEl.className = 'mx-param-select';
      selectEl.setAttribute('aria-label', label);
      tagControl(selectEl, data, row);
      const placeholderEl = document.createElement('option');
      placeholderEl.value = '';
      placeholderEl.textContent = MIXER_COPY.paramDefault;
      placeholderEl.disabled = true;
      selectEl.append(placeholderEl);
      for (const option of row.options) {
        const optionEl = document.createElement('option');
        optionEl.value = option;
        optionEl.textContent = option;
        selectEl.append(optionEl);
      }
      selectEl.addEventListener('change', () => {
        if (selectEl.value === '') return;
        gesture.discrete(paramChange(r.row, selectEl.value), paramLabel(r.row, selectEl.value));
      });
      r.selectEl = selectEl;
      r.placeholderEl = placeholderEl;
      el.append(selectEl);
    } else {
      const sliderEl = document.createElement('input');
      sliderEl.type = 'range';
      sliderEl.className = 'mx-param-slider';
      sliderEl.setAttribute('aria-label', label);
      tagControl(sliderEl, data, row);
      const numberEl = document.createElement('input');
      numberEl.type = 'number';
      numberEl.className = 'mx-param-number';
      numberEl.setAttribute('aria-label', `${label} value`);
      tagControl(numberEl, data, row);
      sliderEl.addEventListener('pointerdown', () => {
        r.pointerDown = true;
      });
      const release = () => {
        r.pointerDown = false;
      };
      sliderEl.addEventListener('pointerup', release);
      sliderEl.addEventListener('pointercancel', release);
      sliderEl.addEventListener('input', () => sliderEvent(r, 'move'));
      sliderEl.addEventListener('change', () => {
        r.pointerDown = false;
        sliderEvent(r, 'release');
      });
      numberEl.addEventListener('change', () => commitNumber(r));
      numberEl.addEventListener('blur', () => {
        // A non-number typed into the field never reaches the code: the field goes back to the model's value.
        const text = numberEl.value.trim();
        if (text === '' || !Number.isFinite(Number(text))) numberEl.value = fieldText(r.row);
      });
      r.sliderEl = sliderEl;
      r.numberEl = numberEl;
      r.fields = [{ numberEl, restore: () => fieldText(r.row) }];
      el.append(sliderEl, numberEl);
    }
    return r;
  }

  // --- Bus rows: the parameters of a Reverb bus or Delay bus ---

  /** The change a bus row writes: the parameter on every sending track and, while the tracks disagree,
   * every other disagreeing parameter aligned to the first sender's value (`align`). */
  function busChange(row, value) {
    const align = {};
    for (const [id, aligned] of Object.entries(insp.data.alignValues)) if (id !== row.param) align[id] = aligned;
    return { type: 'bus-param', orbit: row.orbit, bus: row.bus, param: row.param, value, ...(Object.keys(align).length > 0 ? { align } : {}) };
  }

  function busLabel(row, value) {
    return mixerHistoryLabel({ kind: 'bus-param', bus: row.bus, param: row.param, value });
  }

  /** A costly parameter (reverb size, fade, lowpass, damping) never evaluates while it is dragged: `input`
   * only moves the number, and the code and the sound change once, on release (each key press is one).
   * A live parameter (the delay's) is heard at every move like any other slider. */
  function busSliderEvent(r, phase) {
    const { row } = r;
    const raw = Number(r.sliderEl.value);
    const value = row.scale === 'log' ? positionToValue(row, raw) : roundToParam(row, raw);
    sliderFill(r.sliderEl);
    r.numberEl.value = formatNumber(value);
    r.sliderEl.setAttribute('aria-valuetext', row.unit === '' ? formatNumber(value) : `${formatNumber(value)} ${row.unit}`);
    if (row.costly && phase === 'input') return;
    const method = row.costly || phase === 'change' ? 'release' : 'move';
    gesture[method](`${row.orbit}|bus:${row.bus}.${row.param}`, busChange(row, value), busLabel(row, value));
  }

  function createBusRow(row) {
    const el = document.createElement('div');
    el.className = 'mx-row';
    el.dataset.param = row.param;
    el.dataset.bus = row.bus;
    el.dataset.orbit = String(row.orbit);
    const labelEl = document.createElement('div');
    labelEl.className = 'mx-row-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-row-name';
    nameEl.textContent = row.name;
    const subEl = document.createElement('span');
    subEl.className = 'mx-row-sub';
    labelEl.append(nameEl, subEl);
    el.append(labelEl);
    // updateRow reads defaultEl; a bus parameter has no Default button, so it is never attached.
    const r = { el, row, subEl, defaultEl: document.createElement('button'), sliderEl: null, numberEl: null, selectEl: null, placeholderEl: null, pointerDown: false, group: false, fields: [] };
    if (row.kind === 'moving') {
      const movingEl = document.createElement('div');
      movingEl.className = 'mx-moving';
      const textEl = document.createElement('span');
      textEl.className = 'mx-moving-text';
      textEl.textContent = MIXER_COPY.movingFromCode;
      movingEl.append(textEl);
      el.append(movingEl);
      return r;
    }
    const label = `${row.bus === 'reverb' ? MIXER_COPY.reverbBus : MIXER_COPY.delayBus} ${row.name.toLowerCase()}`;
    const tag = (control) => {
      control.dataset.writes = 'true';
      control.dataset.bus = row.bus;
      control.dataset.orbit = String(row.orbit);
      control.dataset.param = row.param;
    };
    const sliderEl = document.createElement('input');
    sliderEl.type = 'range';
    sliderEl.className = 'mx-param-slider';
    sliderEl.setAttribute('aria-label', label);
    tag(sliderEl);
    const numberEl = document.createElement('input');
    numberEl.type = 'number';
    numberEl.className = 'mx-param-number';
    numberEl.setAttribute('aria-label', `${label} value`);
    tag(numberEl);
    sliderEl.addEventListener('pointerdown', () => {
      r.pointerDown = true;
    });
    const release = () => {
      r.pointerDown = false;
    };
    sliderEl.addEventListener('pointerup', release);
    sliderEl.addEventListener('pointercancel', release);
    sliderEl.addEventListener('input', () => busSliderEvent(r, 'input'));
    sliderEl.addEventListener('change', () => {
      r.pointerDown = false;
      busSliderEvent(r, 'change');
    });
    numberEl.addEventListener('change', () => {
      const text = numberEl.value.trim();
      const typed = text === '' ? Number.NaN : Number(text);
      if (!Number.isFinite(typed)) {
        numberEl.value = fieldText(r.row);
        return;
      }
      const value = roundToParam(r.row, typed);
      numberEl.value = formatNumber(value);
      sliderEl.value = String(r.row.scale === 'log' ? valueToPosition(r.row, value) : value);
      sliderFill(sliderEl);
      gesture.discrete(busChange(r.row, value), busLabel(r.row, value));
    });
    numberEl.addEventListener('blur', () => {
      const text = numberEl.value.trim();
      if (text === '' || !Number.isFinite(Number(text))) numberEl.value = fieldText(r.row);
    });
    r.sliderEl = sliderEl;
    r.numberEl = numberEl;
    r.fields = [{ numberEl, restore: () => fieldText(r.row) }];
    el.append(sliderEl, numberEl);
    return r;
  }

  // --- Control rows: the controls of a MIDI track's instrument ---

  /** The gesture control key of one control of the open MIDI inspector. */
  function midiKey(row) {
    return `${insp.data.identity}|midi|${row.control}`;
  }

  /** The change a MIDI control row writes: its cc on the port and channel of the track, `value` null to take it out of the code. */
  function midiChange(row, value) {
    const { identity, port, channel } = insp.data;
    return { type: 'midi-control', identity, port, channel, control: row.control, cc: row.cc, value };
  }

  function midiLabel(row, value) {
    return mixerHistoryLabel({ kind: 'midi-control', name: insp.data.trackName, control: row.name, value });
  }

  /** A control slider is a gesture like the MIDI fader: while it is dragged each move sends the CC (rate limited) and
   * keeps the gesture open with no evaluation; at its release the last value is sent and the code is written once. */
  function midiSliderEvent(r, method) {
    const { row } = r;
    const value = Math.round(Number(r.sliderEl.value));
    sliderFill(r.sliderEl);
    r.numberEl.value = String(value);
    r.sliderEl.setAttribute('aria-valuetext', String(value));
    if (method === 'move') {
      midiPreview.move({ instrumentId: insp.data.instrumentId, channel: insp.data.channel, cc: row.cc, value });
      gesture.preview(midiKey(row), midiLabel(row, value));
      return;
    }
    midiPreview.flush();
    gesture.release(midiKey(row), midiChange(row, value), midiLabel(row, value));
  }

  /** PageUp and PageDown move a MIDI slider by 10, set explicitly (a native range steps by its own amount), and run the
   * same handlers as a drag: `apply('move')` then `apply('release')`. Arrows and Home and End are the browser's own. */
  function pageStep(event, sliderEl, apply) {
    if ((event.key !== 'PageUp' && event.key !== 'PageDown') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    const next = Math.round(Number(sliderEl.value)) + (event.key === 'PageUp' ? 10 : -10);
    sliderEl.value = String(Math.min(Number(sliderEl.max), Math.max(Number(sliderEl.min), next)));
    apply('move');
    apply('release');
  }

  /** A number typed into a control's field: a finite number is rounded to a whole number, clamped to the control's
   * range and written at once, one version (no preview: the setup step sends it); anything else puts the field back. */
  function commitMidiNumber(r) {
    const text = r.numberEl.value.trim();
    const typed = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(typed)) {
      r.numberEl.value = String(r.row.value);
      return;
    }
    const value = Math.min(r.row.max, Math.max(r.row.min, Math.round(typed)));
    r.numberEl.value = String(value);
    r.sliderEl.value = String(value);
    sliderFill(r.sliderEl);
    gesture.discrete(midiChange(r.row, value), midiLabel(r.row, value));
  }

  function createMidiRow(row, data) {
    const el = document.createElement('div');
    el.className = 'mx-row';
    el.dataset.param = row.control;
    el.dataset.effect = 'midi';
    el.dataset.track = data.identity;
    const labelEl = document.createElement('div');
    labelEl.className = 'mx-row-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-row-name';
    nameEl.textContent = row.name;
    const subEl = document.createElement('span');
    subEl.className = 'mx-row-sub';
    labelEl.append(nameEl, subEl);
    el.append(labelEl);
    const tag = (control) => {
      control.dataset.writes = 'true';
      control.dataset.track = data.identity;
      control.dataset.effect = 'midi';
      control.dataset.param = row.control;
    };
    const defaultEl = document.createElement('button');
    defaultEl.type = 'button';
    defaultEl.className = 'mx-default';
    defaultEl.textContent = MIXER_COPY.defaultButton;
    defaultEl.setAttribute('aria-label', `${MIXER_COPY.defaultButton} ${row.name}`);
    tag(defaultEl);
    const r = { el, row, midi: true, subEl, defaultEl, sliderEl: null, numberEl: null, selectEl: null, placeholderEl: null, sweepEl: null, pointerDown: false, group: false, fields: [] };
    defaultEl.addEventListener('click', () => {
      gesture.discrete(midiChange(r.row, null), mixerHistoryLabel({ kind: 'midi-control-default', name: insp.data.trackName, control: r.row.name }));
    });
    if (row.moving) {
      // A sweep in the code moves this control: no slider, no number field, no Default, and the sentence says why.
      const movingEl = document.createElement('div');
      movingEl.className = 'mx-moving';
      const textEl = document.createElement('span');
      textEl.className = 'mx-moving-text';
      textEl.textContent = MIXER_COPY.movingFromCode;
      movingEl.append(textEl);
      const sweepEl = document.createElement('div');
      sweepEl.className = 'mx-sweep';
      el.append(movingEl, sweepEl);
      r.sweepEl = sweepEl;
      return r;
    }
    const label = `${data.trackName} ${row.name}`;
    const sliderEl = document.createElement('input');
    sliderEl.type = 'range';
    sliderEl.className = 'mx-param-slider';
    sliderEl.setAttribute('aria-label', label);
    tag(sliderEl);
    const numberEl = document.createElement('input');
    numberEl.type = 'number';
    numberEl.className = 'mx-param-number';
    numberEl.setAttribute('aria-label', `${label} value`);
    tag(numberEl);
    sliderEl.addEventListener('pointerdown', () => {
      r.pointerDown = true;
    });
    const release = () => {
      r.pointerDown = false;
    };
    sliderEl.addEventListener('pointerup', release);
    sliderEl.addEventListener('pointercancel', release);
    sliderEl.addEventListener('input', () => midiSliderEvent(r, 'move'));
    sliderEl.addEventListener('change', () => {
      r.pointerDown = false;
      midiSliderEvent(r, 'release');
    });
    sliderEl.addEventListener('keydown', (event) => pageStep(event, sliderEl, (method) => midiSliderEvent(r, method)));
    numberEl.addEventListener('change', () => commitMidiNumber(r));
    numberEl.addEventListener('blur', () => {
      // A non-number typed into the field never reaches the code: the field goes back to the model's value.
      const text = numberEl.value.trim();
      if (text === '' || !Number.isFinite(Number(text))) numberEl.value = String(r.row.value);
    });
    r.sliderEl = sliderEl;
    r.numberEl = numberEl;
    r.fields = [{ numberEl, restore: () => String(r.row.value) }];
    el.append(sliderEl, numberEl);
    return r;
  }

  /** Keeps one control row in step with the model. A slider or number field the user holds keeps its value. */
  function updateMidiRow(r, row) {
    r.row = row;
    r.el.dataset.default = String(!row.written);
    if (row.showDefaultButton) {
      if (r.defaultEl.parentNode !== r.subEl) r.subEl.replaceChildren(r.defaultEl);
      r.defaultEl.title = row.defaultTitle;
    } else {
      if (r.defaultEl.parentNode === r.subEl) r.defaultEl.remove();
      r.subEl.textContent = row.subText ?? '';
    }
    if (r.sweepEl !== null) {
      r.sweepEl.textContent = row.sweepText ?? '';
      r.sweepEl.toggleAttribute('hidden', row.sweepText === null);
      return;
    }
    const held = r.pointerDown || gesture.hasPending();
    r.sliderEl.min = String(row.slider.min);
    r.sliderEl.max = String(row.slider.max);
    r.sliderEl.step = String(row.slider.step);
    r.numberEl.min = String(row.min);
    r.numberEl.max = String(row.max);
    r.numberEl.step = '1';
    if (held || document.activeElement === r.numberEl) {
      insp.stale = true;
    } else {
      r.sliderEl.value = String(row.slider.value);
      r.numberEl.value = String(row.value);
    }
    sliderFill(r.sliderEl);
    r.sliderEl.setAttribute('aria-valuetext', String(row.value));
  }

  // --- The filter-move editor: Fixed or Moves for the cutoff of a filter ---

  /** The registry parameter a movable row stands for. */
  function registryParam(row) {
    return effectById(row.effect).params.find((candidate) => candidate.id === row.param);
  }

  /** The gesture control key, the change and the history label for `move` on a movable row. */
  function moveStep(r, move) {
    const { row } = r;
    return {
      change: { identity: insp.data.identity, type: 'filter-move', effect: row.effect, param: row.param, move },
      label: mixerHistoryLabel({ kind: 'move', name: insp.data.trackName, effect: row.effect, from: move.from, to: move.to, over: move.over }),
    };
  }

  /** Fixed to Moves starts from half and twice the cutoff; Moves to Fixed is the midpoint of From and To. */
  function switchMode(r, mode) {
    if (r.row.mode === mode) return;
    const param = registryParam(r.row);
    if (mode === 'moves') {
      const { change, label } = moveStep(r, moveFromFixed(param, r.row.value));
      gesture.discrete(change, label);
      return;
    }
    const value = fixedFromMove(param, r.live ?? r.row.move);
    gesture.discrete(paramChange(r.row, value), paramLabel(r.row, value));
  }

  /** One From, To or Over row of the Moves side: a slider and a number field. From and To slide on the
   * cutoff's log scale; Over is a whole number of cycles. */
  function createMoveField(r, data, field, name) {
    const whole = field === 'over';
    const el = document.createElement('div');
    el.className = 'mx-row';
    el.dataset.param = r.row.param;
    el.dataset.effect = data.effect;
    el.dataset.track = data.identity;
    el.dataset.field = field;
    const labelEl = document.createElement('div');
    labelEl.className = 'mx-row-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-row-name';
    nameEl.textContent = name;
    labelEl.append(nameEl);
    const label = `${data.trackName} ${effectById(data.effect).name} ${name}`;
    const sliderEl = document.createElement('input');
    sliderEl.type = 'range';
    sliderEl.className = 'mx-param-slider';
    sliderEl.setAttribute('aria-label', label);
    tagControl(sliderEl, data, r.row, field);
    const numberEl = document.createElement('input');
    numberEl.type = 'number';
    numberEl.className = 'mx-param-number';
    numberEl.setAttribute('aria-label', `${label} value`);
    tagControl(numberEl, data, r.row, field);
    const range = whole ? { min: MOVE_OVER_MIN, max: MOVE_OVER_MAX, step: 1 } : { min: 0, max: PARAM_STEPS, step: 1 };
    sliderEl.min = String(range.min);
    sliderEl.max = String(range.max);
    sliderEl.step = String(range.step);
    numberEl.min = String(whole ? MOVE_OVER_MIN : r.row.min);
    numberEl.max = String(whole ? MOVE_OVER_MAX : r.row.max);
    numberEl.step = whole ? '1' : 'any';
    const f = { field, el, sliderEl, numberEl, whole };
    f.restore = () => formatNumber(r.live[field]);
    const valueOfSlider = () => (whole ? Number(sliderEl.value) : positionToValue(r.row, Number(sliderEl.value)));
    const show = (value) => {
      numberEl.value = formatNumber(value);
      sliderEl.value = String(whole ? value : valueToPosition(r.row, value));
      sliderFill(sliderEl);
    };
    f.show = show;
    const sliderEvent = (method) => {
      const value = valueOfSlider();
      sliderFill(sliderEl);
      numberEl.value = formatNumber(value);
      sliderEl.setAttribute('aria-valuetext', formatNumber(value));
      const { change, label: text } = moveStep(r, { ...r.live, [field]: value });
      r.live = change.move;
      gesture[method](`${insp.data.identity}|move:${r.row.effect}.${r.row.param}.${field}`, change, text);
    };
    sliderEl.addEventListener('pointerdown', () => {
      r.pointerDown = true;
    });
    const release = () => {
      r.pointerDown = false;
    };
    sliderEl.addEventListener('pointerup', release);
    sliderEl.addEventListener('pointercancel', release);
    sliderEl.addEventListener('input', () => sliderEvent('move'));
    sliderEl.addEventListener('change', () => {
      r.pointerDown = false;
      sliderEvent('release');
    });
    numberEl.addEventListener('change', () => {
      const text = numberEl.value.trim();
      const typed = text === '' ? Number.NaN : Number(text);
      if (!Number.isFinite(typed)) {
        numberEl.value = f.restore();
        return;
      }
      const value = whole ? Math.min(MOVE_OVER_MAX, Math.max(MOVE_OVER_MIN, Math.round(typed))) : roundToParam(r.row, typed);
      show(value);
      const { change, label: labelText } = moveStep(r, { ...r.live, [field]: value });
      r.live = change.move;
      gesture.discrete(change, labelText);
    });
    numberEl.addEventListener('blur', () => {
      const text = numberEl.value.trim();
      if (text === '' || !Number.isFinite(Number(text))) numberEl.value = f.restore();
    });
    el.append(labelEl, sliderEl, numberEl);
    return f;
  }

  /** The Shape row of the Moves side: a select over the closed shape list. */
  function createShapeRow(r, data) {
    const el = document.createElement('div');
    el.className = 'mx-row';
    el.dataset.param = r.row.param;
    el.dataset.effect = data.effect;
    el.dataset.track = data.identity;
    el.dataset.field = 'shape';
    const labelEl = document.createElement('div');
    labelEl.className = 'mx-row-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'mx-row-name';
    nameEl.textContent = MIXER_COPY.shape;
    labelEl.append(nameEl);
    const selectEl = document.createElement('select');
    selectEl.className = 'mx-param-select';
    selectEl.setAttribute('aria-label', `${data.trackName} ${effectById(data.effect).name} ${MIXER_COPY.shape}`);
    tagControl(selectEl, data, r.row, 'shape');
    for (const shape of r.row.shapes) {
      const optionEl = document.createElement('option');
      optionEl.value = shape;
      optionEl.textContent = shape;
      selectEl.append(optionEl);
    }
    selectEl.addEventListener('change', () => {
      const { change, label } = moveStep(r, { ...r.live, shape: selectEl.value });
      r.live = change.move;
      gesture.discrete(change, label);
    });
    el.append(labelEl, selectEl);
    return { el, selectEl };
  }

  /** A movable cutoff: the Fixed / Moves switch, then the ordinary cutoff row (Fixed) or the From, To,
   * Over and Shape rows (Moves). Rebuilt when the side changes (the row signature holds the kind). */
  function createMoveRow(row, data) {
    const moves = row.mode === 'moves';
    const el = document.createElement('div');
    el.className = 'mx-move-group';
    el.dataset.param = row.param;
    el.dataset.effect = data.effect;
    el.dataset.track = data.identity;
    const headEl = document.createElement('div');
    headEl.className = 'mx-move-head';
    const switchEl = document.createElement('div');
    switchEl.className = 'mx-move-switch';
    switchEl.setAttribute('role', 'group');
    switchEl.setAttribute('aria-label', `${effectById(data.effect).name} cutoff`);
    const r = { el, row, group: true, inner: null, buttons: {}, fields: [], moveFields: [], shapeEl: null, pointerDown: false, live: moves ? { ...row.move } : null };
    for (const [mode, text] of [['fixed', MIXER_COPY.fixed], ['moves', MIXER_COPY.moves]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mx-move-mode';
      button.textContent = text;
      button.dataset.mode = mode;
      tagControl(button, data, row);
      button.addEventListener('click', () => switchMode(r, mode));
      r.buttons[mode] = button;
      switchEl.append(button);
    }
    if (moves) {
      const nameEl = document.createElement('span');
      nameEl.className = 'mx-row-name';
      nameEl.textContent = row.name;
      headEl.append(nameEl);
    }
    headEl.append(switchEl);
    el.append(headEl);
    if (moves) {
      for (const [field, name] of [['from', MIXER_COPY.from], ['to', MIXER_COPY.to], ['over', MIXER_COPY.over]]) {
        const f = createMoveField(r, data, field, name);
        r.moveFields.push(f);
        r.fields.push({ numberEl: f.numberEl, restore: f.restore });
        el.append(f.el);
      }
      const shape = createShapeRow(r, data);
      r.shapeEl = shape.selectEl;
      el.append(shape.el);
    } else {
      r.inner = createRow(row, data);
      r.fields = r.inner.fields;
      el.append(r.inner.el);
    }
    return r;
  }

  /** Keeps a movable cutoff in step with the model. A control the user holds keeps its own value. */
  function updateMoveRow(r, row, data) {
    r.row = row;
    for (const [mode, button] of Object.entries(r.buttons)) button.setAttribute('aria-pressed', String(row.mode === mode));
    if (r.inner) {
      updateRow(r.inner, row, data);
      r.pointerDown = r.inner.pointerDown;
      return;
    }
    const held = r.pointerDown || gesture.hasPending();
    const typing = r.moveFields.some((f) => document.activeElement === f.numberEl);
    if (held || typing) {
      insp.stale = true;
    } else {
      r.live = { ...row.move };
      for (const f of r.moveFields) f.show(row.move[f.field]);
    }
    for (const f of r.moveFields) {
      f.sliderEl.setAttribute('aria-valuetext', formatNumber(r.live[f.field]));
      sliderFill(f.sliderEl);
    }
    if (document.activeElement !== r.shapeEl && !held) r.shapeEl.value = row.move.shape;
  }

  /** Keeps one row in step with the model. A slider or number field the user holds keeps its value. */
  function updateRow(r, row, data) {
    r.row = row;
    r.el.dataset.default = String(row.defaultShown);
    if (row.showDefaultButton) {
      if (r.defaultEl.parentNode !== r.subEl) r.subEl.replaceChildren(r.defaultEl);
    } else {
      if (r.defaultEl.parentNode === r.subEl) r.defaultEl.remove();
      r.subEl.textContent = row.subText;
    }
    if (r.selectEl) {
      r.placeholderEl.toggleAttribute('hidden', !row.defaultShown);
      if (document.activeElement !== r.selectEl) r.selectEl.value = row.value === '' ? '' : row.value;
      return;
    }
    if (!r.sliderEl) return;
    const held = r.pointerDown || gesture.hasPending();
    r.sliderEl.min = String(row.slider.min);
    r.sliderEl.max = String(row.slider.max);
    r.sliderEl.step = String(row.slider.step);
    r.numberEl.min = String(row.min);
    r.numberEl.max = String(row.max);
    r.numberEl.step = row.step === null ? 'any' : String(row.step);
    if (held || document.activeElement === r.numberEl) {
      insp.stale = true;
    } else {
      r.sliderEl.value = String(row.slider.value);
      r.numberEl.value = fieldText(row);
    }
    sliderFill(r.sliderEl);
    r.sliderEl.setAttribute('aria-valuetext', row.unit === '' ? fieldText(row) : `${fieldText(row)} ${row.unit}`);
  }

  function setMoreOpen(open) {
    insp.moreOpen = open;
    moreEl.toggleAttribute('hidden', !open);
    moreToggleEl.setAttribute('aria-expanded', String(open));
    moreToggleEl.textContent = open ? MIXER_COPY.fewerParams : MIXER_COPY.moreParams.replace('{N}', String(moreEl.children.length));
  }

  /** Builds the rows of `data` from scratch: the basic ones, then More parameters and the rest. */
  function buildRows(data) {
    insp.rows = new Map();
    const basic = [];
    const more = [];
    for (const row of data.rows) {
      let r;
      if (data.kind === 'midi') {
        r = createMidiRow(row, data);
        insp.rows.set(row.control, r);
        basic.push(r.el);
        continue;
      }
      if (row.bus !== undefined) r = createBusRow(row);
      else r = row.mode === undefined ? createRow(row, data) : createMoveRow(row, data);
      insp.rows.set(row.param, r);
      (row.basic ? basic : more).push(r.el);
    }
    moreEl.replaceChildren(...more);
    inspRowsEl.replaceChildren(...basic);
    if (more.length > 0) {
      inspRowsEl.append(moreToggleEl, moreEl);
      setMoreOpen(insp.moreOpen);
    }
  }

  function refocusSwitch(mode) {
    if (mode === null) return;
    const group = [...insp.rows.values()].find((r) => r.group);
    if (group && document.activeElement !== group.buttons[mode]) group.buttons[mode].focus();
  }

  /** Draws the inspector for the selected chip, or hides it: there is no placeholder pane. Rows are kept
   * in step in place, keyed by parameter, so a control the user holds is never replaced. */
  function renderInspector() {
    const data = inspectorModel({ model: lastModel, selection });
    if (data === null) {
      pendingReveal = null;
      mixerInspector.hidden = true;
      insp.key = null;
      insp.signature = null;
      insp.data = null;
      insp.rows = new Map();
      insp.moreOpen = false;
      insp.stale = false;
      insp.revealed = null;
      refreshDisabled();
      return;
    }
    mixerInspector.hidden = false;
    const isBus = data.kind === 'bus';
    const isMidi = data.kind === 'midi';
    let key = `${data.identity}|${data.effect}`;
    if (isBus) key = `bus:${data.orbit}:${data.bus}`;
    else if (isMidi) key = `${data.identity}|midi`;
    if (key !== insp.key) {
      // A different chip: a fresh inspector with More parameters closed.
      insp.key = key;
      insp.signature = null;
      insp.moreOpen = false;
      insp.stale = false;
      insp.revealed = null;
      // The pane now has its full width: keep the strip the user pointed at whole beside it.
      if (pendingReveal && pendingReveal.isConnected) revealStrip(pendingReveal);
    }
    pendingReveal = null;
    insp.data = data;
    inspTitleEl.textContent = data.title;
    // A MIDI inspector whose controls are off says why in place of its rows (the strip's sentence); a track that left the code says so.
    let sentence = null;
    if (isMidi) sentence = data.gone ? data.goneText : data.reasonText;
    else if (data.gone) sentence = MIXER_COPY.gone;
    const empty = sentence !== null;
    inspGoneEl.textContent = sentence ?? MIXER_COPY.gone;
    inspGoneEl.toggleAttribute('hidden', !empty);
    inspLineEl.textContent = isMidi ? data.instrumentLine : '';
    inspLineEl.toggleAttribute('hidden', !isMidi || empty || data.instrumentLine === '');
    inspSharedEl.textContent = isMidi ? data.sharedText : '';
    inspSharedEl.toggleAttribute('hidden', !isMidi || empty || data.sharedText === '');
    writtenEl.toggleAttribute('hidden', empty || isBus);
    inspFooterEl.toggleAttribute('hidden', empty);
    untouchedEl.textContent = isMidi ? data.footer : MIXER_COPY.untouched;
    // A bus and a MIDI track have no Remove; a bus has its always-shown note under the rows.
    if (isBus || isMidi) removeEl.remove();
    else if (removeEl.parentNode !== inspFooterEl) inspFooterEl.append(removeEl);
    inspNoteEl.textContent = isBus ? data.note : '';
    inspNoteEl.toggleAttribute('hidden', !isBus || data.gone);
    if (empty) {
      insp.signature = 'gone';
      insp.rows = new Map();
      inspRowsEl.replaceChildren();
      refreshDisabled();
      return;
    }
    if (isMidi) {
      writtenLabelEl.toggleAttribute('hidden', data.nothingWritten);
      writtenCodeEl.textContent = data.nothingWritten ? MIXER_COPY.midiNothingWritten : data.writtenText;
    } else {
      writtenLabelEl.toggleAttribute('hidden', data.bypassed);
      writtenCodeEl.textContent = data.bypassed ? MIXER_COPY.bypassedLine : data.writtenText;
    }
    if (!isBus && !isMidi) {
      removeEl.dataset.track = data.identity;
      removeEl.dataset.effect = data.effect;
    }
    const rowId = (row) => (isMidi ? row.control : row.param);
    const rowKind = (row) => (isMidi ? (row.moving ? 'moving' : 'number') : row.kind);
    const signature = `${key}|${data.rows.map((row) => `${rowId(row)}:${rowKind(row)}`).join(',')}`;
    // The Fixed / Moves button that was pressed is replaced with its row: focus goes to its twin.
    const active = document.activeElement;
    const focusedMode = active && active.classList && active.classList.contains('mx-move-mode') ? active.dataset.mode : null;
    if (signature !== insp.signature) {
      insp.signature = signature;
      buildRows(data);
    }
    insp.stale = false;
    for (const row of data.rows) {
      const r = insp.rows.get(rowId(row));
      if (isMidi) updateMidiRow(r, row);
      else if (r.group) updateMoveRow(r, row, data);
      else updateRow(r, row, data);
    }
    // The clicked control's row comes into view once, by the smallest scroll, without taking focus from anything.
    if (isMidi && selection !== null && selection.control !== insp.revealed) {
      insp.revealed = selection.control;
      const r = insp.rows.get(selection.control);
      if (r !== undefined && typeof r.el.scrollIntoView === 'function') r.el.scrollIntoView({ block: 'nearest' });
    }
    refocusSwitch(focusedMode);
    refreshDisabled();
  }

  inspCloseEl.addEventListener('click', () => closeInspector(true));
  moreToggleEl.addEventListener('click', () => setMoreOpen(!insp.moreOpen));
  removeEl.addEventListener('click', () => {
    const { identity, effect, trackName } = insp.data;
    const ref = refs.get(identity);
    selection = null;
    refreshSelection();
    renderInspector();
    gesture.discrete({ identity, type: 'remove-effect', effect }, mixerHistoryLabel({ kind: 'remove', name: trackName, effect }));
    if (ref && ref.addEl.parentNode) ref.addEl.focus();
  });
  mixerInspector.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Esc inside the inspector closes only the inspector (the view stays open) and hands focus back to the chip.
    event.preventDefault();
    event.stopPropagation();
    for (const r of insp.rows.values()) {
      // Esc also cancels a number that was typed and not committed.
      for (const field of r.fields) if (event.target === field.numberEl) field.numberEl.value = field.restore();
    }
    closeInspector(true);
  });

  // --- Ask Claude: what a right-click on a control points at ---

  /** True while the bus strips on screen use more than one orbit (the same condition that makes their titles show it). */
  function multipleOrbits() {
    return new Set([...busRefs.values()].map((busRef) => busRef.current.orbit)).size > 1;
  }

  /** The shown name of a parameter row, without the unit the moves rows put in brackets ("From (Hz)" reads From). */
  function shownParamName(rowEl) {
    const nameEl = rowEl.querySelector('.mx-row-name');
    return nameEl === null ? '' : nameEl.textContent.replace(/\s*\([^)]*\)\s*$/, '');
  }

  /** The text a number shows with its unit: `1200 Hz`, or the bare number for a unitless parameter. */
  function withUnit(text, unit) {
    return unit === undefined || unit === '' ? text : `${text} ${unit}`;
  }

  /** The value an inspector row shows, as one word or number with its unit. `r` is the row's view record. */
  function shownRowValue(r, rowEl) {
    const { row } = r;
    if (r.group) {
      // The Fixed / Moves switch or the name line of a movable cutoff, or one of its Moves rows.
      const field = rowEl === null ? undefined : rowEl.dataset.field;
      if (field === 'shape') return r.shapeEl.value;
      if (field !== undefined) {
        const f = r.moveFields.find((candidate) => candidate.field === field);
        return withUnit(f.numberEl.value, field === 'over' ? 'cycles' : row.unit);
      }
      return row.mode === 'moves' ? MIXER_COPY.moving : shownRowValue(r.inner, null);
    }
    if (row.kind === 'moving') return MIXER_COPY.moving;
    if (row.mixed === true) return MIXER_COPY.mixed;
    if (row.defaultShown) return MIXER_COPY.paramDefault;
    if (row.kind === 'select') return row.value;
    return withUnit(fieldText(row), row.unit);
  }

  /** The value a MIDI control shows, as one word or number: `moving` for a sweep, its number once written, else `default`. */
  function midiShownValue(row) {
    if (row.moving) return MIXER_COPY.moving;
    return row.written ? String(row.value) : MIXER_COPY.paramDefault;
  }

  /** A right-click inside the inspector: a parameter row, else the effect or bus the inspector shows. */
  function inspectorTarget(element) {
    const data = insp.data;
    if (data === null || data.gone) return null;
    const rowEl = element.closest('.mx-row[data-param]');
    const groupEl = rowEl === null ? element.closest('.mx-move-group[data-param]') : null;
    const paramEl = rowEl ?? groupEl;
    const r = paramEl === null ? undefined : insp.rows.get(paramEl.dataset.param);
    if (data.kind === 'bus') {
      if (r === undefined) return { kind: 'bus', bus: data.bus, orbit: data.orbit, multipleOrbits: multipleOrbits() };
      return { kind: 'bus-param', bus: data.bus, orbit: data.orbit, parameter: r.row.name, value: shownRowValue(r, rowEl), multipleOrbits: multipleOrbits() };
    }
    if (data.kind === 'midi') {
      // A MIDI control row, else the instrument the inspector shows: asked about by its tag, like a chip.
      const effect = data.tagText === '' ? 'MIDI' : data.tagText;
      if (r === undefined) return { kind: 'effect', track: data.trackName, effect, bypassed: false };
      return { kind: 'effect-param', track: data.trackName, effect, parameter: r.row.name, value: midiShownValue(r.row) };
    }
    const effect = effectById(data.effect).name;
    if (r === undefined) return { kind: 'effect', track: data.trackName, effect, bypassed: data.bypassed };
    const parameter = rowEl !== null && rowEl.dataset.field !== undefined ? shownParamName(rowEl) : r.row.name;
    return { kind: 'effect-param', track: data.trackName, effect, parameter, value: shownRowValue(r, rowEl) };
  }

  /** A right-click on a track strip: the fader, a send, a chain chip, else the track. */
  function stripTarget(element, ref) {
    const { name } = ref.current;
    if (element.closest('.mx-fader-section') !== null) {
      const { fader } = ref.current;
      let value = fader.readout;
      if (fader.line === 'default') value = MIXER_COPY.paramDefault;
      else if (fader.line === 'both-moving' || fader.line === 'postgain-moving' || fader.line === 'sweep') value = MIXER_COPY.moving;
      else if (fader.line === 'plays-midi' || fader.line === 'inner-postgain') value = MIXER_COPY.unavailable;
      return { kind: 'fader', track: name, value };
    }
    const midiChipEl = element.closest('.mx-midi-chip[data-param]');
    const midiChip = midiChipEl === null ? undefined : ref.midiChips.get(midiChipEl.dataset.param);
    if (midiChip !== undefined) {
      const effect = ref.current.midi.tagText === '' ? 'MIDI' : ref.current.midi.tagText;
      return { kind: 'effect-param', track: name, effect, parameter: midiChip.data.name, value: midiChip.data.text };
    }
    const sendEl = element.closest('.mx-send[data-bus]');
    if (sendEl !== null) {
      const send = ref.current.sends.find((candidate) => candidate.bus === sendEl.dataset.bus);
      return { kind: 'send', track: name, bus: send.bus, value: send.moving ? MIXER_COPY.moving : send.readout };
    }
    const chipEl = element.closest('.mx-chip[data-effect]');
    const chip = chipEl === null ? undefined : ref.chips.get(chipEl.dataset.effect);
    if (chip !== undefined) return { kind: 'effect', track: name, effect: chip.data.name, bypassed: chip.data.bypassed === true };
    return { kind: 'track', track: name };
  }

  /** A right-click on a bus strip: a parameter chip, else the bus. */
  function busStripTarget(element, busRef) {
    const { bus, orbit } = busRef.current;
    const chipEl = element.closest('.mx-chip[data-param]');
    const chip = chipEl === null ? undefined : busRef.chips.get(chipEl.dataset.param);
    if (chip === undefined) return { kind: 'bus', bus, orbit, multipleOrbits: multipleOrbits() };
    return { kind: 'bus-param', bus, orbit, parameter: chip.nameEl.textContent, value: chip.valueEl.textContent, multipleOrbits: multipleOrbits() };
  }

  function render(model) {
    lastModel = model;
    if (model.status !== 'ready') {
      mixerMessage.textContent = model.status === 'empty' ? MIXER_COPY.empty : MIXER_COPY.cannotRead;
      mixerMessage.hidden = false;
      mixerBody.hidden = true;
      mixerNoNotes.hidden = true;
      mixerNoNotes.textContent = '';
      refs.clear();
      busRefs.clear();
      groupRefs.clear();
      selectedStrip = null;
      mixerStrips.replaceChildren();
      renderInspector();
      refreshNotice();
      return;
    }
    mixerMessage.hidden = true;
    mixerBody.hidden = false;
    // The MIDI tracks that play no notes have no strip: one line names them (textContent and title only). It follows the model, not the notice.
    const noNotesText = model.noNotesText ?? null;
    mixerNoNotes.textContent = noNotesText ?? '';
    if (noNotesText === null) mixerNoNotes.removeAttribute('title');
    else mixerNoNotes.title = MIXER_COPY.noNotesTitle;
    mixerNoNotes.hidden = noNotesText === null;
    const seen = new Set();
    // The strips placed in the DOM whose fader the hand holds: they are not moved or removed until it lets go.
    const held = new Set();
    for (const ref of refs.values()) {
      if (ref.el.parentNode !== null && isHeld(ref)) held.add(ref.el);
    }
    model.strips.forEach((strip) => {
      seen.add(strip.identity);
      let ref = refs.get(strip.identity);
      if (ref && ref.midi !== (strip.midi !== null)) {
        // The track started or stopped playing a MIDI instrument (or its file changed): another kind of strip.
        // Rebuilt now, or at the release when the user holds its fader (like a strip that vanished).
        if (ref.pointerDown) {
          ref.vanished = true;
          return;
        }
        ref.el.remove();
        refs.delete(strip.identity);
        ref = undefined;
      }
      if (!ref) {
        ref = createStrip(strip);
        refs.set(strip.identity, ref);
      }
      updateStrip(ref, strip);
    });
    // The bus strips come after the tracks, in the model's order (orbit, then reverb before delay).
    const seenBuses = new Set();
    const busEls = [];
    model.buses.forEach((entry) => {
      seenBuses.add(entry.key);
      let busRef = busRefs.get(entry.key);
      if (!busRef) {
        busRef = createBusStrip(entry);
        busRefs.set(entry.key, busRef);
      }
      updateBusStrip(busRef, entry);
      busEls.push(busRef.el);
    });
    // Where every element goes: a flat Mixer is its strips then its buses; a structured piece nests the strips in group
    // frames (the frames are walked with a stack, never by recursion). Each parent gets the order it should have.
    const topEls = [];
    const plans = [{ parent: mixerStrips, desired: topEls }];
    const seenGroups = new Set();
    if (model.layout === null || model.layout === undefined) {
      for (const strip of model.strips) {
        const ref = refs.get(strip.identity);
        if (ref !== undefined) topEls.push(ref.el);
      }
    } else {
      const work = [{ items: model.layout.items, desired: topEls }];
      while (work.length > 0) {
        const { items, desired } = work.pop();
        for (const item of items) {
          if (item.kind === 'strip') {
            const ref = refs.get(item.identity);
            if (ref !== undefined) desired.push(ref.el);
            continue;
          }
          // Two frames with one key would share one element and hide strips, so a repeated key stops the render.
          if (seenGroups.has(item.key)) throw new Error(`Moontide: the Mixer got the group ${item.key} twice.`);
          seenGroups.add(item.key);
          let groupRef = groupRefs.get(item.key);
          if (groupRef === undefined) {
            groupRef = createGroupFrame(item);
            groupRefs.set(item.key, groupRef);
          }
          updateGroupFrame(groupRef, item);
          desired.push(groupRef.el);
          const inner = [];
          plans.push({ parent: groupRef.bodyEl, desired: inner });
          work.push({ items: item.items, desired: inner });
        }
      }
    }
    for (const el of busEls) topEls.push(el);
    const misplaced = new Set();
    for (const { parent, desired } of plans) place(parent, desired, held, misplaced);
    // A frame the model no longer has goes, with the frames nested in it. One that still holds a held strip stays until the
    // strip is let go, marked stale: its buttons are off and hasStale asks for a draw after the release.
    for (const [key, groupRef] of [...groupRefs]) {
      if (seenGroups.has(key)) continue;
      if (groupRef.el.parentNode !== null && [...held].some((heldEl) => groupRef.el.contains(heldEl))) {
        groupRef.stale = true;
        continue;
      }
      groupRef.el.remove();
      groupRefs.delete(key);
    }
    for (const ref of refs.values()) ref.misplaced = misplaced.has(ref.el);
    for (const [key, busRef] of [...busRefs]) {
      if (seenBuses.has(key)) continue;
      busRef.el.remove();
      busRefs.delete(key);
    }
    refreshSelection();
    // A strip that left the model (or folded away) cannot stay selected.
    if (selectedStrip !== null && !seen.has(selectedStrip)) selectedStrip = null;
    refreshStripSelection();
    renderInspector();
    for (const [identity, ref] of [...refs]) {
      if (seen.has(identity)) continue;
      if (ref.pointerDown) {
        // Removing the element under the user's hand would lose the release: drop it at release.
        ref.vanished = true;
        continue;
      }
      ref.el.remove();
      refs.delete(identity);
    }
    refreshDisabled();
  }

  return {
    render,
    /**
     * Describes what a right-click on `element` points at, for the Ask Claude box: the most
     * specific control first (a parameter, an effect, a fader, a send, a chip, then the strip or bus
     * itself), from the text the control shows. Returns null outside the Mixer and on the notice, the
     * message and empty panel space. It only reads; the one right-click listener lives in main.js.
     */
    askTarget(element) {
      if (element.closest('#mixer-view') === null) return null;
      if (element.closest('#mixer-inspector') !== null) return inspectorTarget(element);
      const stripEl = element.closest('.mx-strip[data-track]');
      if (stripEl !== null) {
        const ref = refs.get(stripEl.dataset.track);
        return ref === undefined ? null : stripTarget(element, ref);
      }
      const busEl = element.closest('.mx-bus[data-bus][data-orbit]');
      if (busEl !== null) {
        const busRef = busRefs.get(`${busEl.dataset.orbit}:${busEl.dataset.bus}`);
        return busRef === undefined ? null : busStripTarget(element, busRef);
      }
      // A group's head or frame (a strip inside it was answered above): the group, with its parent group when it is nested.
      // The names come from the model's entry for the frame, never from the shown (cut) text.
      const groupEl = element.closest('.mx-group[data-group]');
      if (groupEl !== null) {
        const groupRef = groupRefs.get(groupEl.dataset.group);
        if (groupRef === undefined) return null;
        const { name, path } = groupRef.current;
        return path.length > 1 ? { kind: 'group', name, parent: path[path.length - 2] } : { kind: 'group', name };
      }
      return null;
    },
    /** The identity of the selected track strip, or null: the editor lights that track's block. */
    selectedStrip() {
      return selectedStrip;
    },
    /** The bus whose inspector is open, `{ orbit, bus }`, or null: the model keeps that bus on screen. */
    selectedBus() {
      return selection !== null && selection.bus !== undefined ? { orbit: selection.orbit, bus: selection.bus } : null;
    },
    /** True while the pointer holds the fader or a control slider of a MIDI instrument (the gesture recorder keeps a previewed gesture open then). */
    midiHeld() {
      for (const ref of refs.values()) {
        if (ref.pointerDown && ref.current.midi !== null) return true;
      }
      return [...insp.rows.values()].some((r) => r.midi === true && r.pointerDown);
    },
    /** True when a fader kept its own value while held and is free to take the model's now. */
    hasStale() {
      for (const ref of refs.values()) {
        if ((ref.stale || ref.misplaced === true) && !isHeld(ref)) return true;
      }
      // A frame kept for a strip that has been let go since: the next draw removes it.
      for (const groupRef of groupRefs.values()) {
        if (groupRef.stale === true && !gesture.hasPending() && ![...refs.values()].some((ref) => ref.pointerDown && groupRef.el.contains(ref.el))) return true;
      }
      // An inspector control kept its own value while it was held: free to take the model's now.
      return insp.stale && !gesture.hasPending() && ![...insp.rows.values()].some((r) => r.pointerDown);
    },
    /**
     * Draws the lights that changed (page/lights.js frame): `[{ kind: 'track' | 'group', id, value }]`, `value` from 0 to 1.
     * With motion 'on' the fill's own opacity is the brightness; with motion 'off' a light is only lit or unlit, which the
     * stylesheet shows through `data-lit`, and no opacity is ever written. A light this view does not hold is skipped.
     */
    setLights(changes, motion) {
      if (motion !== 'on' && motion !== 'off') {
        throw new Error(`Moontide: the lights need motion 'on' or 'off', got ${String(motion)}.`);
      }
      for (const change of changes) {
        const ref = change.kind === 'group' ? groupRefs.get(change.id) : refs.get(change.id);
        if (ref === undefined) continue;
        if (motion === 'on') ref.lightFillEl.style.opacity = String(change.value);
        else ref.lightEl.dataset.lit = String(change.value > 0);
      }
    },
    /** Takes every light back to unlit: no inline opacity and no lit mark, in both forms. */
    clearLights() {
      for (const ref of [...refs.values(), ...groupRefs.values()]) {
        if (ref.lightFillEl.style.opacity !== '') ref.lightFillEl.style.opacity = '';
        if (ref.lightEl.dataset.lit !== undefined) delete ref.lightEl.dataset.lit;
      }
    },
    /** 'connected' | 'connecting' | 'disconnected' (the same states the History view gets). */
    setConnected(state) {
      connection = state;
      refreshNotice();
    },
    /** True while the editor holds text that was not evaluated. */
    setDirty(value) {
      dirty = value === true;
      refreshNotice();
    },
    /** True while a change waits for its bar or phrase line: the mixer shows a neutral notice and cannot write. */
    setWaiting(value) {
      waiting = value === true;
      refreshNotice();
    },
  };
}
