// The Scratchpad view's DOM: the piano roll on the cycle grid (the ruler, the piano names, the notes and the keyboard cursor)
// and the information line under it, built with DOM methods only. Text reaches the page only through textContent, title,
// setAttribute and dataset, never as markup. The view attaches no right-click listener: page/main.js owns the only one. The motif
// lives in this closure and nowhere else: nothing is stored or played from here, and the one thing that leaves it is the motif request
// the user sends with the Send to Claude press, which the view hands to the page's onSend and never sends itself. No DOM access at import time: main.js calls
// createScratchView() with its document, so this module can be loaded anywhere. The motif model and the words come from
// page/scratch-model.js, the numbers of a pointer from page/scratch-gesture.js; the stylesheet does the geometry from the custom
// properties this module sets. The mouse and the keys both end in the one apply function, so they obey the same rules.

import {
  UNITS_PER_CYCLE,
  RING_CYCLES,
  WINDOW_ROWS,
  GRIDS,
  MIN_CYCLES,
  MAX_CYCLES,
  MIN_PITCH,
  MAX_PITCH,
  MIN_WINDOW_START,
  MAX_WINDOW_START,
  SCRATCH_COPY,
  fillScratch,
  DEFAULT_VELOCITY,
  emptyMotif,
  createHistory,
  commit,
  undo,
  redo,
  motifUnits,
  gridOf,
  noteAt,
  toggleAt,
  placeNote,
  moveNote,
  resizeNote,
  eraseNote,
  setGrid,
  setCycles,
  setVelocity,
  tapNote,
  moveNotes,
  alignMotif,
  clearMotif,
  resizeNotes,
  eraseNotes,
  setVelocities,
  selectionText,
  selectionParts,
  neighborNote,
  recordBuffer,
  ringLayout,
  motifPhrase,
  motifRequest,
  motifResultText,
  sendRefusalText,
  sentText,
  listeningText,
  heardText,
  hearText,
  hearWarnings,
  hasChord,
  laneOrder,
  velocityText,
  cyclesText,
  shownRows,
  rangeText,
  rangeSpoken,
  windowStartFor,
  noteName,
  isBlackKey,
  noteParts,
  spokenNote,
  emptyCellParts,
  spokenEmptyCell,
  summaryLine,
  touchedNotes,
} from './scratch-model.js';
import { BEAT_MIN_REM, DRAG_THRESHOLD_REM, GUTTER_REM, LIVE_BEAT_MIN_REM, barAt, beatWidthRem, cellAt, drawLength, edgeScrollPx, groupMoveTarget, historyScroll, lockDrag, moveTarget, notesInBox, pickPart, pointerRow, pointerUnit, resizeLength, rowHeightRem, selectionBox, velocityAt } from './scratch-gesture.js';

const BEATS_PER_CYCLE = UNITS_PER_CYCLE / 12;
const OCTAVE = 12;
const UNITS_PER_BEAT = 12;
const ARROWS = {
  ArrowLeft: { right: -1, up: 0 },
  ArrowRight: { right: 1, up: 0 },
  ArrowUp: { right: 0, up: 1 },
  ArrowDown: { right: 0, up: -1 },
};
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
// The live view turns the page when the playhead passes this share of the visible width, and stops following for this long after a hand scroll.
const FOLLOW_EDGE = 0.9;
const FOLLOW_PAUSE_MS = 5000;
const mod = (value, size) => ((value % size) + size) % size;
const roundUnit = (value) => Number(value.toFixed(2));
const NO_LAYOUT = Object.freeze({ settled: [], heldNotes: [], pitches: [], heldPitches: new Set() });
// The listening states in which the Allow MIDI to listen button shows.
const ALLOW_STATES = ['needs-permission', 'failed'];

/**
 * Builds the Scratchpad view's DOM once and returns `{ render, closed, cancelGesture, handleContextMenu, rollContains, resize }`. `render()` redraws from the state and writes
 * only what changed. `closed()` is called whenever the view is not the open one: it ends a drag with nothing committed, hides the
 * cursor and clears the notice of the last edit. `cancelGesture()` ends a drag in progress with nothing committed. `rootFontPx()`
 * gives the root font size in pixels, read when a press starts, so the pointer's targets scale with the page. `handleContextMenu(event)`
 * erases the note under a right-click inside the roll, and `rollContains(node)` tells page/main.js, which owns the page's only
 * contextmenu listener, whether a right-click is the roll's. `resize()` sizes the beat and the row from the room the view has; the
 * page calls it when the view opens and when its size changes. Every edit goes through
 * the one apply function inside, which takes the `{ motif, notice }` a model command returns.
 *
 * Select and Draw: the roll's default gesture is to select. A drag on an empty cell draws a dashed box and selects the notes it touches, a click on
 * empty space clears the selection and puts the cursor there, a click on a note selects only it, and none of them writes a note. A note is written
 * by a double-click on an empty cell, by Enter at the cursor, or by a drag while Draw (the `#scratch-draw` toggle, key d) is on. The selection is a
 * set of note ids held by the view alone: it is never part of the motif or of the history, and the cursor on a note does not select it.
 *
 * Tap mode (a computer key places a note where it falls): `tapOn()` tells whether it is on; `setMusicPlaying(playing)` tells the view
 * whether the music plays, because Tap needs it (and a Tap that is on turns itself off when the music stops); `tap({ ts, h, anchors })`
 * places a tap at the cursor's row, or puts the reason it was refused in the line; `setNowUnit(unit)` gives the marker's place in
 * the motif (or null), and `motifCycles()` how many cycles the motif has now. `onTapChange(on)` is called whenever Tap turns on or off, so the page can start or stop what feeds it. The view
 * reads no clock itself: the page reads the key's stamp and the cycle lines and hands them in.
 *
 * Listening (a MIDI keyboard): `setListening(state)` takes the state of page/midi-in.js and writes the strip under the information line, the
 * state sentence and the line about the last note, and the read-outs on the view (data-listen, data-heard-count, -pitch, -cycle, -source and
 * -refused). It writes only what changed. The Allow MIDI to listen button (`#scratch-allow`) shows only while asking can help (the permission has
 * not been asked for, or MIDI failed to start), and a press calls `onAllow()`: the page answers by asking through the one shared enable.
 *
 * Record that (`#scratch-record`): a press with notes in the buffer calls `onRecord()`, and the page answers with `record(snapshot)`, the snapshot
 * of page/midi-in.js (null when the music's clock could not be read). The motif is replaced in one step that Undo takes back; with nothing
 * to record the press says so in the line and changes nothing.
 *
 * Listen (`#scratch-play`, the hear strip): a menu of the setup file's instruments and channels (`setOutputs(options, setup)` takes the options of
 * listenOptions in page/scratch-model.js and the setup file's word), the Start choice (In the music, the default, or At once), the Loop switch, and the
 * Listen and Stop buttons. A Listen press with a choice and notes calls `onListen({ instrumentId, channel, start, loop })`; the view plays nothing and
 * sends nothing itself. Stop calls `onStop()` and the Loop switch `onLoop(on)`. The choice, the start and Loop are kept for the session only. The page tells
 * the view what became of a play with `setHear(state)` (see hearText in page/scratch-model.js); the one live region of the strip, `#scratch-play-note`,
 * says it, the instrument id apart from the rest. Stop carries aria-disabled unless a play is waiting or playing. After that sentence the strip adds
 * its Heads up sentences for the instrument and channel of the play, or the one chosen: the unmuted tracks the page says are playing on it
 * (`playingTracks(instrumentId, channel)`, a list of display names) and a chord on an instrument that plays one note at a time (the option's
 * `monophonic`). They never disable anything; `refreshHear()` asks again when the playing code or the playing state changed.
 *
 * Send to Claude (`#scratch-send`): the strip shows the phrase of the motif (the very text sent, written by motifPhrase on every render), a field
 * for the user's words (the default sentence to start with) and the Send to Claude button. Only a press of the button, or Enter in the field, sends:
 * the view calls `onSend({ words, motif })`, with `motif` the request of motifRequest (the cycle from `musicCycle()`, the music's cycle now or null
 * while it is stopped), and writes what the page answered in the status line. The words are read at the press, never before. The button carries
 * aria-disabled, with the reason as its title, while the motif has no notes, the page is not connected or the last send is still on its way
 * (`setSendState({ connected, pending })`, told by the page); a press then says the reason in the status line. `motifResult(result)` takes what became
 * of a request the page sent (refused, not confirmed, waiting for Claude) and says it in the status line.
 */
export function createScratchView({
  document,
  rootFontPx,
  onTapChange = () => {},
  onRecord = () => {},
  onAllow = () => {},
  onSend = () => {
    throw new Error('Moontide: the Scratchpad view was made without onSend, so Send to Claude has nowhere to go.');
  },
  musicCycle = () => null,
  onListen = () => {
    throw new Error('Moontide: the Scratchpad view was made without onListen, so Listen has nowhere to go.');
  },
  onStop = () => {
    throw new Error('Moontide: the Scratchpad view was made without onStop, so Stop has nowhere to go.');
  },
  onLoop = () => {
    throw new Error('Moontide: the Scratchpad view was made without onLoop, so Loop has nowhere to go.');
  },
  playingTracks = () => [],
}) {
  if (typeof rootFontPx !== 'function') throw new TypeError('Moontide: the Scratchpad view needs rootFontPx, a function that gives the root font size in pixels.');
  const need = (id) => {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`Moontide: the Scratchpad view needs #${id} in the page.`);
    return element;
  };
  const viewEl = need('scratch-view');
  const scrollEl = need('scratch-scroll');
  const rulerEl = need('scratch-ruler');
  const rollEl = need('scratch-roll');
  const gutterEl = need('scratch-gutter');
  const gridEl = need('scratch-grid');
  const notesEl = need('scratch-notes');
  const liveEl = need('scratch-live');
  const cursorEl = need('scratch-cursor');
  const previewEl = need('scratch-preview');
  const hoverCellEl = need('scratch-hover-cell');
  const selectRectEl = need('scratch-select-rect');
  const infoEl = need('scratch-note');
  const hoverEl = need('scratch-note-hover');
  const lineEl = need('scratch-note-line');
  const nameEl = need('scratch-note-name');
  const restEl = need('scratch-note-rest');
  const spokenEl = need('scratch-note-spoken');
  const hintEl = need('scratch-hint');
  const gridButtons = GRIDS.map((grid) => ({ grid, element: need(`scratch-grid-${grid.id}`) }));
  const fewerEl = need('scratch-fewer');
  const moreEl = need('scratch-more');
  const cyclesEl = need('scratch-cycles');
  const lowerEl = need('scratch-lower');
  const higherEl = need('scratch-higher');
  const windowEl = need('scratch-window');
  const undoEl = need('scratch-undo');
  const redoEl = need('scratch-redo');
  const drawEl = need('scratch-draw');
  const earlierEl = need('scratch-earlier');
  const laterEl = need('scratch-later');
  const alignEl = need('scratch-align');
  const clearEl = need('scratch-clear');
  const tapEl = need('scratch-tap');
  const recordEl = need('scratch-record');
  const earlyEl = need('scratch-early');
  const nowEl = need('scratch-now');
  const playheadEl = need('scratch-playhead');
  const laneEl = need('scratch-lane');
  const laneLabelEl = need('scratch-lane-label');
  const barsEl = need('scratch-bars');
  const listenStateEl = need('scratch-listen-state');
  const heardEl = need('scratch-heard');
  const allowEl = need('scratch-allow');
  const phraseEl = need('scratch-phrase');
  const wordsEl = need('scratch-words');
  const sendEl = need('scratch-send-button');
  const sendStatusEl = need('scratch-send-status');
  const playOutputEl = need('scratch-play-output');
  const playMusicEl = need('scratch-play-music');
  const playNowEl = need('scratch-play-now');
  const playLoopEl = need('scratch-play-loop');
  const playListenEl = need('scratch-play-listen');
  const playStopEl = need('scratch-play-stop');
  const playNoteEl = need('scratch-play-note');

  let motif = emptyMotif();
  // The Scratchpad's own edits, apart from the music's History: the motif is always the history's present.
  let history = createHistory(motif);
  // The base window of two octaves starts where the motif's notes are, worked out when the view is made (the motif is empty then, so it
  // starts on C3) and again when Record that replaces the motif; after that only Lower and Higher move it. It is where the rows start from:
  // the rows the roll shows are worked out from the notes each time it is drawn (see `shown`), so the base can never hide a note.
  let base = windowStartFor(motif);
  let cursor = { unit: 0, pitch: base + WINDOW_ROWS / 2 };
  // The selection is view state, a set of note ids; it is never part of the motif or of the history. A click, a box, a double-click and the
  // selection keys change it, and the cursor does not: the cursor on a note selects nothing by itself.
  let selection = new Set();
  // Draw mode (a drag on an empty cell writes a note) is off whenever the view is made; it is kept for the session only.
  let draw = false;
  // The box a selection drag shows while it runs, in fractions of units and rows, or null.
  let rectBox = null;
  // A drag of several selected notes shows them all at the place it would give: `{ kind: 'move' | 'edge', dStart, dPitch, dSteps }`, or null.
  let groupDraft = null;
  // The key press in progress: a held key repeats, and the repeats are folded into the step its first press made (see runEdit).
  let run = null;
  let hasFocus = false;
  // The sentence of the last edit; it stays on the line until the cursor moves.
  let notice = null;
  // The pointer: a press in progress (null when there is none), the note or the empty cell it hovers over, and the note a draw is
  // previewing. None of them is part of the motif, and none of them reaches the live region.
  let press = null;
  let hoverId = null;
  let hoverCell = null;
  let preview = null;
  // The velocity lane's own press (null when there is none) and the velocity a drag shows before the release writes it.
  let lanePress = null;
  let laneDraft = null;
  // Tap mode: whether it is on, whether the music plays (Tap needs it) and where in the motif the music is now, in units (null when unknown).
  let tapping = false;
  let musicPlaying = false;
  let nowUnit = null;
  // How many played notes the keyboard buffer holds, as the last listening state said; Record that has nothing to take at 0.
  let heardCount = 0;

  // The live view (see setLive). `liveMode` is 'off' (nothing listened to), 'armed' (an input is listened to and the buffer holds no note) or
  // 'live' (it holds a note: the roll shows the buffer's 8 cycles as a ring). `liveGiven` is the last `{ now, snapshot, frameMs }` the page
  // handed over. A switch into or out of 'live' changes the geometry under the pointer, so while a press is on it waits (`liveHold`,
  // `liveNext`) and is applied at the release. `liveRange` is the widest rows seen while live, so the range only grows until live ends.
  let liveMode = 'off';
  let liveGiven = null;
  let liveHold = false;
  let liveNext = null;
  let liveRange = null;
  // Following the playhead: the page's frame time before which the box is not turned (a hand scroll or a press pauses it), the scroll position
  // the view itself last wrote (any other position is a hand), and where the playhead was last, to see it wrap.
  let lastFrameMs = 0;
  let followPausedUntil = -Infinity;
  let lastScroll = 0;
  let lastPlayhead = null;
  // The snapshot laid out on the ring, for the grid it was laid out for: the pieces of the notes that are let go (they change when the
  // snapshot does), the held notes (their pieces grow with the frame), the pitches in play and the pitches held now.
  let layoutSnapshot = null;
  let layoutGrid = '';
  let layout = NO_LAYOUT;
  // The last thing the page handed to setLive (even one put off for a press), so the live view can come back when a Listen play ends, and the
  // place of the Listen playhead in the motif's units (null while a play waits or nothing plays). While Listen waits or plays the live overlay is
  // paused: the roll shows the motif's own cycles and the one accent playhead crosses the motif.
  let liveRaw = null;
  let hearUnit = null;

  const setAttr = (element, name, value) => {
    const text = String(value);
    if (element.getAttribute(name) !== text) element.setAttribute(name, text);
  };
  const setText = (element, text) => {
    if (element.textContent !== text) element.textContent = text;
  };
  const stepUnits = () => gridOf(motif.grid).unit;
  // The rows the roll shows: the base, every note and the cursor, each with its margin, rounded out to whole octaves. They are worked out at
  // the start of every render and never stored apart from this, so the pointer, the keys and the drawing all read the rows that are on screen.
  const measureRows = () => {
    let { low, high } = shownRows(motif, { base, extras: layout.pitches, cursor: cursor.pitch });
    // While live the range only grows: a pitch played and let go keeps its rows until the buffer is empty again.
    if (liveMode === 'live') {
      if (liveRange !== null) {
        low = Math.min(low, liveRange.low);
        high = Math.max(high, liveRange.high);
      }
      liveRange = { low, high };
    } else {
      liveRange = null;
    }
    return { low, high, rows: high - low + 1 };
  };
  // The cycles the roll shows: the motif's own, or the buffer's 8 while live. Every read of the roll's geometry goes through these, while an
  // edit still stops at the motif's own end.
  const displayCycles = () => (liveMode === 'live' ? RING_CYCLES : motif.cycles);
  const displayUnits = () => displayCycles() * UNITS_PER_CYCLE;
  const displayBeats = () => displayCycles() * BEATS_PER_CYCLE;
  let shown = measureRows();
  const rowOf = (pitch) => shown.high - pitch;

  // The words of the toolbar come from the copy: a button's visible text, its accessible name and its tooltip.
  for (const { grid, element } of gridButtons) {
    element.textContent = grid.text;
    element.setAttribute('aria-label', grid.name);
    element.setAttribute('title', grid.name);
  }
  laneLabelEl.textContent = SCRATCH_COPY.laneLabel;
  fewerEl.textContent = SCRATCH_COPY.fewerSign;
  moreEl.textContent = SCRATCH_COPY.moreSign;
  lowerEl.textContent = SCRATCH_COPY.lower;
  higherEl.textContent = SCRATCH_COPY.higher;
  undoEl.textContent = SCRATCH_COPY.undo;
  redoEl.textContent = SCRATCH_COPY.redo;
  drawEl.textContent = SCRATCH_COPY.draw;
  drawEl.setAttribute('aria-label', SCRATCH_COPY.drawName);
  drawEl.setAttribute('title', SCRATCH_COPY.drawTitle);
  for (const [element, text, name] of [[earlierEl, SCRATCH_COPY.earlier, SCRATCH_COPY.earlierName], [laterEl, SCRATCH_COPY.later, SCRATCH_COPY.laterName], [alignEl, SCRATCH_COPY.align, SCRATCH_COPY.alignName], [clearEl, SCRATCH_COPY.clear, SCRATCH_COPY.clearName]]) {
    element.textContent = text;
    element.setAttribute('aria-label', name);
  }
  tapEl.textContent = SCRATCH_COPY.tap;
  recordEl.textContent = SCRATCH_COPY.record;
  earlyEl.textContent = SCRATCH_COPY.early;
  earlyEl.setAttribute('title', SCRATCH_COPY.earlyTitle);
  allowEl.textContent = SCRATCH_COPY.allow;
  allowEl.setAttribute('title', SCRATCH_COPY.allowTitle);
  phraseEl.setAttribute('aria-label', SCRATCH_COPY.phraseLabel);
  wordsEl.setAttribute('aria-label', SCRATCH_COPY.wordsLabel);
  wordsEl.value = SCRATCH_COPY.defaultWords;
  playOutputEl.setAttribute('aria-label', SCRATCH_COPY.hearOutputName);
  for (const [element, text, title] of [[playMusicEl, SCRATCH_COPY.hearStartMusic, SCRATCH_COPY.hearStartMusicTitle], [playNowEl, SCRATCH_COPY.hearStartNow, SCRATCH_COPY.hearStartNowTitle], [playLoopEl, SCRATCH_COPY.loop, SCRATCH_COPY.loopTitle], [playListenEl, SCRATCH_COPY.listen, SCRATCH_COPY.listenTitle], [playStopEl, SCRATCH_COPY.stop, SCRATCH_COPY.stopTitle]]) {
    element.textContent = text;
    element.setAttribute('title', title);
  }
  sendEl.textContent = SCRATCH_COPY.send;
  sendEl.setAttribute('title', SCRATCH_COPY.sendTitle);
  for (const [element, name] of [[fewerEl, SCRATCH_COPY.fewer], [moreEl, SCRATCH_COPY.more], [lowerEl, SCRATCH_COPY.lowerName], [higherEl, SCRATCH_COPY.higherName]]) {
    element.setAttribute('aria-label', name);
  }

  // A button that cannot act now keeps focus and says why in its tooltip; it never takes the disabled attribute.
  function setDisabled(element, disabled, name, why) {
    setAttr(element, 'aria-disabled', disabled);
    setAttr(element, 'title', disabled ? why : name);
  }

  // The notes Earlier and Later move: the selection, else every note of the motif.
  const movedIds = () => (selection.size > 0 ? [...selection].sort((a, b) => a - b) : motif.notes.map((note) => note.id));

  // The Edit group: each button that cannot act keeps focus, carries aria-disabled and says why in its title. Earlier and Later work the
  // move out ahead, so a move that would leave the motif is shown as unavailable with the very sentence a press would give.
  function renderEdit() {
    const empty = motif.notes.length === 0;
    for (const [element, name, direction] of [[earlierEl, SCRATCH_COPY.earlierName, -1], [laterEl, SCRATCH_COPY.laterName, 1]]) {
      const refusal = empty ? SCRATCH_COPY.moveNothing : (moveNotes(motif, movedIds(), { dStart: direction * stepUnits() }).refused ?? null);
      setDisabled(element, refusal !== null, name, refusal ?? '');
    }
    setDisabled(alignEl, empty, SCRATCH_COPY.alignTitle, SCRATCH_COPY.alignNothing);
    setDisabled(clearEl, empty, SCRATCH_COPY.clearName, SCRATCH_COPY.clearNothing);
  }

  // The toolbar's state: the pressed grid, the length and the window readouts, and the buttons that have reached an end.
  function renderToolbar() {
    for (const { grid, element } of gridButtons) setAttr(element, 'aria-pressed', grid.id === motif.grid);
    setText(cyclesEl, cyclesText(motif.cycles));
    setText(windowEl, rangeText(shown.low, shown.high));
    setAttr(windowEl, 'aria-label', rangeSpoken(shown.low, shown.high));
    setDisabled(fewerEl, motif.cycles <= MIN_CYCLES, SCRATCH_COPY.fewer, SCRATCH_COPY.fewerLeast);
    setDisabled(moreEl, motif.cycles >= MAX_CYCLES, SCRATCH_COPY.more, SCRATCH_COPY.moreMost);
    setDisabled(lowerEl, base <= MIN_WINDOW_START, SCRATCH_COPY.lowerName, SCRATCH_COPY.lowerLowest);
    setDisabled(higherEl, base >= MAX_WINDOW_START, SCRATCH_COPY.higherName, SCRATCH_COPY.higherHighest);
    setDisabled(undoEl, history.past.length === 0, SCRATCH_COPY.undo, SCRATCH_COPY.nothingToUndo);
    setDisabled(redoEl, history.future.length === 0, SCRATCH_COPY.redo, SCRATCH_COPY.nothingToRedo);
    setAttr(drawEl, 'aria-pressed', draw);
    renderEdit();
    setAttr(tapEl, 'aria-pressed', tapping);
    setDisabled(tapEl, !musicPlaying, SCRATCH_COPY.tapTitle, SCRATCH_COPY.tapNeedsMusic);
    setDisabled(recordEl, heardCount === 0, SCRATCH_COPY.recordTitle, SCRATCH_COPY.recordNothing);
  }

  // The listening strip: the state sentence (the one live element) and the line about the last note. Each is written only when its text
  // changed, so a new note rewrites the heard line and never the live sentence. The read-outs on the view are for the probes and benches.
  function setListening(state) {
    const sentence = listeningText(state);
    const heardLine = heardText(state);
    setText(listenStateEl, sentence);
    setAttr(listenStateEl, 'title', sentence);
    // The one way to ask for MIDI: offered only when asking can help, never pressed by the page itself.
    allowEl.toggleAttribute('hidden', !ALLOW_STATES.includes(state.listen));
    setText(heardEl, heardLine);
    setAttr(heardEl, 'title', heardLine);
    heardCount = state.count;
    setDisabled(recordEl, heardCount === 0, SCRATCH_COPY.recordTitle, SCRATCH_COPY.recordNothing);
    setAttr(viewEl, 'data-listen', state.listen);
    setAttr(viewEl, 'data-heard-count', state.count);
    setAttr(viewEl, 'data-heard-pitch', state.heard === null ? '' : state.heard.pitch);
    setAttr(viewEl, 'data-heard-cycle', state.heard === null ? '' : String(state.heard.cycle));
    setAttr(viewEl, 'data-heard-source', state.heard === null ? '' : state.heard.source);
    setAttr(viewEl, 'data-heard-refused', state.refused === null ? '' : state.refused);
  }

  // The marker shows where the music is in the motif: where a tap would land while Tap is on (the page gives the place), else, while an
  // input is listened to and nothing is played, where the cycle axis is in the motif's cycles, so the beat can be felt before the first
  // note. In Live the playhead replaces it.
  let nowKey = '';
  function renderNow() {
    let unit = null;
    if (liveMode !== 'live') {
      if (tapping) unit = nowUnit;
      else if (liveMode === 'armed' && liveGiven !== null) unit = roundUnit(mod(liveGiven.now, motif.cycles) * UNITS_PER_CYCLE);
    }
    const visible = unit !== null;
    nowEl.toggleAttribute('hidden', !visible);
    setAttr(viewEl, 'data-tap', tapping ? 'on' : 'off');
    setAttr(viewEl, 'data-now-unit', visible ? unit : '');
    if (visible && String(unit) !== nowKey) {
      nowKey = String(unit);
      nowEl.style.setProperty('--sp-now', nowKey);
    }
  }

  // The hover line is its own text, two spans like the shown line, so the name can be heavier than the rest.
  const hoverName = document.createElement('span');
  hoverName.className = 'sp-hover-name';
  const hoverRest = document.createElement('span');
  const hoverText = document.createElement('span');
  hoverText.append(hoverName, hoverRest);
  hoverEl.appendChild(hoverText);

  // The piano cells are built when a row first needs one (at most 108, C0 to B8) and reused after that; the gutter holds exactly as many
  // as the roll shows rows, and render() names them and marks the black keys for the rows' place.
  const keyCells = [];
  let keyRows = 0;

  // One ruler label per beat, in the top bar's cycle.beat form; rebuilt only when the count of beats changes.
  let rulerBeats = 0;
  function renderRuler() {
    const beats = displayBeats();
    if (beats === rulerBeats) return;
    rulerBeats = beats;
    const labels = [];
    for (let beat = 0; beat < beats; beat += 1) {
      const label = document.createElement('div');
      label.className = beat % BEATS_PER_CYCLE === 0 ? 'sp-beat sp-beat-first' : 'sp-beat';
      label.textContent = `${Math.floor(beat / BEATS_PER_CYCLE) + 1}.${(beat % BEATS_PER_CYCLE) + 1}`;
      labels.push(label);
    }
    rulerEl.replaceChildren(...labels);
  }

  function renderKeys() {
    while (keyCells.length < shown.rows) {
      const cell = document.createElement('div');
      cell.className = 'sp-key';
      keyCells.push(cell);
    }
    if (keyRows !== shown.rows) {
      keyRows = shown.rows;
      gutterEl.replaceChildren(...keyCells.slice(0, shown.rows));
    }
    for (let row = 0; row < shown.rows; row += 1) {
      const cell = keyCells[row];
      const pitch = shown.high - row;
      const atCursor = hasFocus && pitch === cursor.pitch;
      setAttr(cell, 'data-black', isBlackKey(pitch));
      setAttr(cell, 'data-cursor', atCursor);
      // A key held now carries its name and a bar of the accent.
      const held = layout.heldPitches.has(pitch);
      setAttr(cell, 'data-held', held);
      setText(cell, pitch % 12 === 0 || atCursor || held ? noteName(pitch) : '');
    }
  }

  // Each note is an element placed through custom properties only; an element is rebuilt only when its numbers change.
  const noteRefs = new Map();
  function renderNotes(hoveredId) {
    // A drag of several notes draws each of them where the drop would put it, with the dashed ring; the notes themselves change at the release.
    const atDraft = (note) => {
      if (groupDraft === null || !selection.has(note.id)) return { note, drafted: false };
      if (groupDraft.kind === 'edge') {
        const length = clamp(note.length + groupDraft.dSteps * stepUnits(), stepUnits(), motifUnits(motif) - note.start);
        return { note: { ...note, length }, drafted: true };
      }
      return { note: { ...note, start: note.start + groupDraft.dStart, pitch: note.pitch + groupDraft.dPitch }, drafted: true };
    };
    const visible = motif.notes
      .map((note) => ({ real: note, ...atDraft(note) }))
      .sort((a, b) => a.note.start - b.note.start || b.note.pitch - a.note.pitch || a.note.id - b.note.id);
    const elements = [];
    const seen = new Set();
    for (const { real, note, drafted: isDraft } of visible) {
      seen.add(note.id);
      let ref = noteRefs.get(note.id);
      if (ref === undefined) {
        const element = document.createElement('div');
        element.className = 'sp-note';
        element.setAttribute('role', 'img');
        // The handle at the right side: it only shows the resize cursor; the press is told apart from the numbers of the pointer.
        const edge = document.createElement('div');
        edge.className = 'sp-edge';
        element.appendChild(edge);
        ref = { element, signature: '' };
        noteRefs.set(note.id, ref);
      }
      const selected = selection.has(note.id);
      const hovered = note.id === hoveredId;
      const signature = `${note.pitch}|${note.start}|${note.length}|${note.velocity}|${motif.grid}|${shown.high}|${selected}|${hovered}|${isDraft}`;
      if (ref.signature !== signature) {
        ref.signature = signature;
        const { element } = ref;
        element.className = ['sp-note', selected ? 'sp-selected' : '', isDraft ? 'sp-draft' : '', hovered ? 'sp-hover' : ''].filter(Boolean).join(' ');
        setAttr(element, 'aria-label', spokenNote(real, motif.grid));
        setAttr(element, 'data-id', real.id);
        setAttr(element, 'data-pitch', real.pitch);
        setAttr(element, 'data-start', real.start);
        setAttr(element, 'data-length', real.length);
        setAttr(element, 'data-velocity', real.velocity);
        element.style.setProperty('--sp-start', String(note.start));
        element.style.setProperty('--sp-len', String(note.length));
        element.style.setProperty('--sp-row', String(rowOf(note.pitch)));
        element.style.setProperty('--v', String(note.velocity / 100));
      }
      elements.push(ref.element);
    }
    for (const id of [...noteRefs.keys()]) if (!seen.has(id)) noteRefs.delete(id);
    const current = notesEl.children;
    const same = current.length === elements.length && elements.every((element, index) => current[index] === element);
    if (!same) notesEl.replaceChildren(...elements);
  }

  // Where each bar of the lane stands: its note's start column and its place among the notes that start there, in the lane's order.
  function barLayout() {
    const byId = new Map(motif.notes.map((note) => [note.id, note]));
    const order = laneOrder(motif).map((id) => byId.get(id));
    const counts = new Map();
    for (const note of order) counts.set(note.start, (counts.get(note.start) ?? 0) + 1);
    const seen = new Map();
    return order.map((note) => {
      const slot = seen.get(note.start) ?? 0;
      seen.set(note.start, slot + 1);
      return { note, id: note.id, start: note.start, slot, slots: counts.get(note.start) };
    });
  }

  // One bar per note, in the lane's order; a bar is rebuilt only when its numbers change. A drag in progress shows its velocity here.
  const barRefs = new Map();
  let barsKey = '';
  function renderBars() {
    const key = `${displayCycles()}|${stepUnits()}`;
    if (key !== barsKey) {
      barsKey = key;
      barsEl.style.setProperty('--sp-cycles', String(displayCycles()));
      barsEl.style.setProperty('--sp-units', String(displayUnits()));
      barsEl.style.setProperty('--sp-step', String(stepUnits()));
    }
    const elements = [];
    const seen = new Set();
    for (const { note, slot, slots } of barLayout()) {
      seen.add(note.id);
      let ref = barRefs.get(note.id);
      if (ref === undefined) {
        const element = document.createElement('div');
        element.className = 'sp-bar';
        element.setAttribute('role', 'img');
        ref = { element, signature: '' };
        barRefs.set(note.id, ref);
      }
      const velocity = laneDraft !== null && laneDraft.id === note.id ? laneDraft.velocity : note.velocity;
      const selected = selection.has(note.id);
      const signature = `${note.pitch}|${note.start}|${slot}|${slots}|${velocity}|${selected}`;
      if (ref.signature !== signature) {
        ref.signature = signature;
        const { element } = ref;
        element.className = selected ? 'sp-bar sp-selected' : 'sp-bar';
        setAttr(element, 'aria-label', fillScratch(SCRATCH_COPY.barName, { name: noteName(note.pitch), velocity: velocityText(velocity) }));
        setAttr(element, 'data-id', note.id);
        setAttr(element, 'data-start', note.start);
        setAttr(element, 'data-velocity', velocity);
        element.style.setProperty('--sp-start', String(note.start));
        element.style.setProperty('--sp-slot', String(slot));
        element.style.setProperty('--sp-slots', String(slots));
        element.style.setProperty('--v', String(velocity / 100));
      }
      elements.push(ref.element);
    }
    for (const id of [...barRefs.keys()]) if (!seen.has(id)) barRefs.delete(id);
    const current = barsEl.children;
    const same = current.length === elements.length && elements.every((element, index) => current[index] === element);
    if (!same) barsEl.replaceChildren(...elements);
  }

  let rollKey = '';
  let cursorKey = '';
  function renderCursor() {
    // While a drag is on the dashed preview is the only dashed ring, so the two are never confused.
    cursorEl.toggleAttribute('hidden', !hasFocus || (press !== null && press.locked));
    const key = `${cursor.unit}|${stepUnits()}|${rowOf(cursor.pitch)}`;
    if (key !== cursorKey) {
      cursorKey = key;
      cursorEl.style.setProperty('--sp-start', String(cursor.unit));
      cursorEl.style.setProperty('--sp-len', String(stepUnits()));
      cursorEl.style.setProperty('--sp-row', String(rowOf(cursor.pitch)));
    }
    setAttr(rollEl, 'data-cursor-unit', cursor.unit);
    setAttr(rollEl, 'data-cursor-pitch', cursor.pitch);
  }

  // What the line says: the last edit's notice; else, while the roll has focus, the cursor's cell; else the summary or the empty state.
  function lineContent() {
    if (notice !== null) return { kind: 'notice', name: '', rest: notice, spoken: notice };
    // Several selected notes are read as a group, before the cursor's cell: a box or Select all must show what it selected.
    if (selection.size > 1) {
      const parts = selectionParts(motif, [...selection]);
      return { kind: 'selection', ...parts, spoken: parts.name + parts.rest };
    }
    if (hasFocus) {
      const note = noteAt(motif, cursor.pitch, cursor.unit);
      if (note !== null) return { kind: 'note', ...noteParts(note, motif.grid), spoken: spokenNote(note, motif.grid) };
      return { kind: 'cell', ...emptyCellParts(cursor.pitch, cursor.unit), spoken: spokenEmptyCell(cursor.pitch, cursor.unit) };
    }
    const selected = selection.size === 1 ? motif.notes.find((note) => selection.has(note.id)) : undefined;
    if (selected !== undefined) return { kind: 'note', ...noteParts(selected, motif.grid), spoken: spokenNote(selected, motif.grid) };
    if (motif.notes.length > 0) {
      const summary = summaryLine(motif);
      return { kind: 'summary', name: '', rest: summary, spoken: summary };
    }
    return {
      kind: 'empty',
      name: SCRATCH_COPY.emptyHeading,
      rest: ` · ${SCRATCH_COPY.emptyBody}`,
      spoken: `${SCRATCH_COPY.emptyHeading}. ${SCRATCH_COPY.emptyBody}`,
    };
  }

  function renderLine() {
    const content = lineContent();
    setAttr(lineEl, 'data-kind', content.kind);
    setText(nameEl, content.name);
    setText(restEl, content.rest);
    setText(spokenEl, content.spoken);
  }

  // The beat and the row take the room the scroll box has: the width left after the piano names for the beats of the motif (no upper
  // limit, so the roll uses all its width), the height left after the ruler and every other element in the box for the rows shown. The
  // sizes are custom properties on the box, which the ruler and the roll both inherit; they are written only when they change, and not at
  // all while the view has no size. When the rows at their smallest height do not fit, the box scrolls vertically.
  let fitKey = '';
  function resize() {
    const remPx = rootFontPx();
    const width = scrollEl.clientWidth;
    const height = scrollEl.clientHeight;
    if (!(remPx > 0) || !(width > 0) || !(height > 0)) return;
    const box = document.defaultView.getComputedStyle(scrollEl);
    const padX = parseFloat(box.paddingLeft) + parseFloat(box.paddingRight);
    const padY = parseFloat(box.paddingTop) + parseFloat(box.paddingBottom);
    let others = 0;
    for (const child of scrollEl.children) if (child !== rollEl) others += child.getBoundingClientRect().height;
    const rounded = (rem) => `${Number(rem.toFixed(4))}rem`;
    const beat = rounded(beatWidthRem({ availableRem: (width - padX) / remPx - GUTTER_REM, beats: displayBeats(), minRem: liveMode === 'live' ? LIVE_BEAT_MIN_REM : BEAT_MIN_REM }));
    const row = rounded(rowHeightRem({ availableRem: (height - padY - others) / remPx, rows: shown.rows }));
    const [lastBeat, lastRow] = fitKey === '' ? ['', ''] : fitKey.split('|');
    if (beat !== lastBeat) scrollEl.style.setProperty('--sp-beat-w', beat);
    if (row !== lastRow) scrollEl.style.setProperty('--sp-row-h', row);
    fitKey = `${beat}|${row}`;
  }

  // Puts a ring on a one-row box through the same custom properties a note is placed with.
  function placeBox(element, unit, length, pitch) {
    element.style.setProperty('--sp-start', String(unit));
    element.style.setProperty('--sp-len', String(length));
    element.style.setProperty('--sp-row', String(rowOf(pitch)));
  }

  // The preview of a draw, the outline of the empty cell under the pointer and the hover line. The hover line shows what a draw in
  // progress would give, else the note under the pointer; it replaces the shown line for the eye and is never read aloud.
  let previewKey = '';
  let hoverCellKey = '';
  let rectKey = '';
  function renderPointer(hovered) {
    previewEl.toggleAttribute('hidden', preview === null);
    if (preview !== null) {
      const key = `${preview.start}|${preview.length}|${rowOf(preview.pitch)}`;
      if (key !== previewKey) {
        previewKey = key;
        placeBox(previewEl, preview.start, preview.length, preview.pitch);
      }
    }
    selectRectEl.toggleAttribute('hidden', rectBox === null);
    if (rectBox !== null) {
      const round = (value) => String(Number(value.toFixed(3)));
      const key = [rectBox.fromUnit, rectBox.toUnit, rectBox.topRow, rectBox.bottomRow].map(round).join('|');
      if (key !== rectKey) {
        rectKey = key;
        selectRectEl.style.setProperty('--sp-start', round(rectBox.fromUnit));
        selectRectEl.style.setProperty('--sp-len', round(rectBox.toUnit - rectBox.fromUnit));
        selectRectEl.style.setProperty('--sp-row', round(rectBox.topRow));
        selectRectEl.style.setProperty('--sp-rows-span', round(rectBox.bottomRow - rectBox.topRow));
      }
    }
    // The outline of the empty cell a drag would start in shows in Draw mode only: in Select mode a drag starts a box, not a note.
    const showCell = draw && press === null && hovered === null && hoverCell !== null;
    hoverCellEl.toggleAttribute('hidden', !showCell);
    if (showCell) {
      const key = `${hoverCell.unit}|${stepUnits()}|${rowOf(hoverCell.pitch)}`;
      if (key !== hoverCellKey) {
        hoverCellKey = key;
        placeBox(hoverCellEl, hoverCell.unit, stepUnits(), hoverCell.pitch);
      }
    }
    const draftOf = laneDraft === null ? undefined : motif.notes.find((note) => note.id === laneDraft.id);
    const draftNote = draftOf === undefined ? null : { ...draftOf, velocity: laneDraft.velocity };
    const shown = preview ?? draftNote ?? (press === null && lanePress === null ? hovered : null);
    hoverEl.toggleAttribute('hidden', shown === null);
    setAttr(infoEl, 'data-hover', shown !== null);
    if (shown !== null) {
      const parts = noteParts(shown, motif.grid);
      setText(hoverName, parts.name);
      setText(hoverRest, parts.rest);
    }
  }

  // --- the live view ---

  // Lays the snapshot out on the ring (see ringLayout) when it is another one, or the grid has changed under it. Notes still held are kept
  // apart: their pieces grow with every frame, while the rest change only with the snapshot.
  function syncLayout() {
    const snapshot = liveMode === 'live' ? liveGiven.snapshot : null;
    if (snapshot === layoutSnapshot && motif.grid === layoutGrid) return;
    layoutSnapshot = snapshot;
    layoutGrid = motif.grid;
    if (snapshot === null) {
      layout = NO_LAYOUT;
      return;
    }
    const settled = ringLayout({ ...snapshot, notes: snapshot.notes.filter((note) => note.held !== true) }, motif.grid).pieces;
    const heldNotes = snapshot.notes.filter((note) => note.held === true);
    const held = ringLayout({ ...snapshot, notes: heldNotes }, motif.grid).pieces;
    layout = { settled, heldNotes, pitches: [...new Set([...settled, ...held].map((piece) => piece.pitch))], heldPitches: new Set(held.filter((piece) => piece.held).map((piece) => piece.pitch)) };
  }

  // The pieces of the held notes at this frame: each grows to the playhead, snapped to the grid like everything the layout places.
  function heldPieces() {
    if (layout.heldNotes.length === 0) return [];
    const { snapshot, now } = liveGiven;
    const notes = layout.heldNotes.map((note) => ({ ...note, end: Math.max(note.end, now - snapshot.start) }));
    return ringLayout({ ...snapshot, notes }, motif.grid).pieces;
  }

  // One element per piece of the live layer, placed through custom properties only and written only when its numbers change. The layer takes
  // no pointer and is aria-hidden: the strip's sentence is the text form of what was heard.
  const settledRefs = [];
  const heldRefs = [];
  let layerKey = '';
  function drawPiece(refs, index, piece) {
    if (refs[index] === undefined) {
      const element = document.createElement('div');
      element.className = 'sp-live';
      refs[index] = { element, signature: '', values: {} };
    }
    const ref = refs[index];
    const signature = `${piece.pitch}|${piece.start}|${piece.end}|${piece.velocity}|${piece.held}|${shown.high}`;
    if (ref.signature === signature) return;
    ref.signature = signature;
    const { element } = ref;
    setAttr(element, 'data-pitch', piece.pitch);
    setAttr(element, 'data-start', piece.start);
    setAttr(element, 'data-length', piece.end - piece.start);
    setAttr(element, 'data-velocity', piece.velocity);
    setAttr(element, 'data-held', piece.held);
    // A held piece grows every few frames: only the properties that changed are written.
    const values = { '--sp-start': String(piece.start), '--sp-len': String(piece.end - piece.start), '--sp-row': String(rowOf(piece.pitch)), '--v': String(piece.velocity / 100) };
    for (const [name, value] of Object.entries(values)) {
      if (ref.values[name] === value) continue;
      ref.values[name] = value;
      element.style.setProperty(name, value);
    }
  }

  // `all` draws every piece (the snapshot or the rows changed); otherwise only the held ones are looked at.
  function renderLiveLayer(all) {
    const held = liveMode === 'live' ? heldPieces() : [];
    const settled = layout.settled;
    if (all) {
      settled.forEach((piece, index) => drawPiece(settledRefs, index, piece));
      settledRefs.length = settled.length;
    }
    held.forEach((piece, index) => drawPiece(heldRefs, index, piece));
    heldRefs.length = held.length;
    setAttr(viewEl, 'data-live-notes', settledRefs.length + heldRefs.length);
    const key = `${settledRefs.length}|${heldRefs.length}`;
    if (!all && key === layerKey) return;
    layerKey = key;
    const elements = [...settledRefs, ...heldRefs].map((ref) => ref.element);
    const current = liveEl.children;
    const same = current.length === elements.length && elements.every((element, index) => current[index] === element);
    if (!same) liveEl.replaceChildren(...elements);
  }

  // The playhead is where the axis cycle is on the ring: its cycle modulo 8 in units. It is a position readout, so it has no transition and
  // moves in both motion modes. The ring cycle read-out changes once per cycle.
  let playheadKey = '';
  function renderPlayhead() {
    const live = liveMode === 'live';
    const heard = hearTracking();
    playheadEl.toggleAttribute('hidden', !live && !heard);
    setAttr(viewEl, 'data-ring-cycle', liveMode === 'off' ? '' : Math.floor(mod(liveGiven.now, RING_CYCLES)));
    if (!live && !heard) {
      lastPlayhead = null;
      return;
    }
    const unit = heard ? roundUnit(hearUnit) : roundUnit(mod(liveGiven.now, RING_CYCLES) * UNITS_PER_CYCLE);
    if (String(unit) !== playheadKey) {
      playheadKey = String(unit);
      playheadEl.style.setProperty('--sp-playhead', playheadKey);
    }
  }

  // Writes the box's sideways scroll and remembers what it became, so a scroll event that lands elsewhere is known for a hand.
  function writeScroll(left) {
    scrollEl.scrollLeft = left;
    lastScroll = scrollEl.scrollLeft;
  }

  // Whether the box turns itself to follow the playhead now: live, and not within the pause after a hand scroll or a press.
  const following = () => (liveMode === 'live' || hearTracking()) && lastFrameMs >= followPausedUntil;
  const pauseFollowing = () => {
    if (liveMode === 'live' || hearTracking()) followPausedUntil = lastFrameMs + FOLLOW_PAUSE_MS;
  };
  scrollEl.addEventListener('wheel', pauseFollowing);
  scrollEl.addEventListener('pointerdown', pauseFollowing);
  scrollEl.addEventListener('scroll', () => {
    if (Math.abs(scrollEl.scrollLeft - lastScroll) > 1) pauseFollowing();
    lastScroll = scrollEl.scrollLeft;
  });

  // The page turn: when the playhead passes 90 percent of the visible width the box scrolls so it stands one beat right of the piano names,
  // instantly, and when it wraps the box goes back to the start.
  function follow(unit) {
    const wrapped = lastPlayhead !== null && unit < lastPlayhead;
    lastPlayhead = unit;
    if (!following()) return;
    if (wrapped) {
      writeScroll(0);
      return;
    }
    const gridRect = gridEl.getBoundingClientRect();
    if (!(gridRect.width > 0)) return;
    const x = gridRect.left + (unit / displayUnits()) * gridRect.width;
    const visibleLeft = gutterEl.getBoundingClientRect().right;
    const visibleRight = scrollEl.getBoundingClientRect().right;
    if (!(visibleRight > visibleLeft)) return;
    if (x < visibleLeft || x > visibleLeft + FOLLOW_EDGE * (visibleRight - visibleLeft)) {
      writeScroll(Math.max(0, scrollEl.scrollLeft + x - visibleLeft - gridRect.width / displayBeats()));
    }
  }

  // What the page hands over on every animation frame while the Scratchpad is open: `null` (no input is listened to: Off) or
  // `{ now, snapshot, frameMs }`, `now` the cycle axis now, `snapshot` the keyboard buffer's (page/played-buffer.js; the same object until the
  // buffer changes, or null when the clock gives none) and `frameMs` the frame's time, the only clock the view has. A snapshot with notes is
  // Live and shows the buffer's 8 cycles; any other is Armed. The switch into or out of Live waits for a press in progress to end.
  function setLive(next) {
    if (next !== null) {
      const valid =
        typeof next === 'object' &&
        Number.isFinite(next.now) &&
        Number.isFinite(next.frameMs) &&
        (next.snapshot === null || (typeof next.snapshot === 'object' && Array.isArray(next.snapshot.notes)));
      if (!valid) throw new TypeError('Moontide: the Scratchpad live view needs null or { now, snapshot, frameMs }: finite now and frameMs, and a snapshot that is null or holds a list of notes.');
    }
    liveRaw = next;
    const want = hearing() || next === null ? 'off' : next.snapshot !== null && next.snapshot.notes.length > 0 ? 'live' : 'armed';
    const switching = (want === 'live') !== (liveMode === 'live');
    if (switching && (press !== null || lanePress !== null)) {
      liveHold = true;
      liveNext = next;
      return;
    }
    liveHold = false;
    liveNext = null;
    const snapshotChanged = (next === null ? null : next.snapshot) !== (liveGiven === null ? null : liveGiven.snapshot);
    const modeChanged = want !== liveMode;
    liveGiven = next;
    liveMode = want;
    if (next !== null) lastFrameMs = next.frameMs;
    if (switching) {
      writeScroll(0);
      lastPlayhead = null;
    }
    if (modeChanged || snapshotChanged) {
      render();
    } else if (liveMode !== 'off') {
      renderNow();
      if (liveMode === 'live') {
        renderLiveLayer(false);
        renderPlayhead();
        follow(mod(liveGiven.now, RING_CYCLES) * UNITS_PER_CYCLE);
      } else {
        renderPlayhead();
      }
    }
  }

  // A press has ended: a switch that waited for it is applied now.
  function flushLive() {
    if (!liveHold) return;
    const next = liveNext;
    liveHold = false;
    liveNext = null;
    setLive(next);
  }

  let rowsKey = 0;
  function render() {
    syncLayout();
    shown = measureRows();
    let sized = false;
    const grid = gridOf(motif.grid);
    const hovered = hoverId === null ? null : (motif.notes.find((note) => note.id === hoverId) ?? null);
    setAttr(viewEl, 'data-cycles', motif.cycles);
    setAttr(viewEl, 'data-shown-cycles', displayCycles());
    setAttr(viewEl, 'data-live', liveMode);
    setAttr(viewEl, 'data-grid', motif.grid);
    setAttr(viewEl, 'data-window-start', base);
    setAttr(viewEl, 'data-rows', shown.rows);
    setAttr(viewEl, 'data-row-low', shown.low);
    setAttr(viewEl, 'data-row-high', shown.high);
    setAttr(viewEl, 'data-notes', motif.notes.length);
    setAttr(viewEl, 'data-selected', [...selection].sort((a, b) => a - b).join(','));
    setAttr(viewEl, 'data-selected-count', selection.size);
    setAttr(viewEl, 'data-draw', draw ? 'on' : 'off');
    setText(hintEl, draw ? SCRATCH_COPY.hintDraw : SCRATCH_COPY.hintSelect);
    const key = `${displayCycles()}|${grid.steps}`;
    if (key !== rollKey) {
      rollKey = key;
      rollEl.style.setProperty('--sp-cycles', String(displayCycles()));
      rollEl.style.setProperty('--sp-steps', String(grid.steps));
      rollEl.style.setProperty('--sp-units', String(displayUnits()));
      sized = true;
    }
    // More or fewer beats share the width differently, and more or fewer rows share the height.
    if (shown.rows !== rowsKey) {
      rowsKey = shown.rows;
      rollEl.style.setProperty('--sp-rows', String(shown.rows));
      sized = true;
    }
    if (sized) resize();
    renderToolbar();
    renderRuler();
    renderKeys();
    renderNotes(press === null && hovered !== null ? hovered.id : null);
    renderLiveLayer(true);
    renderBars();
    renderCursor();
    renderNow();
    renderPlayhead();
    renderLine();
    renderPointer(hovered);
    renderSend();
    renderHear();
  }

  // The strip: the phrase of the motif, written again only when the motif is another one (it is the text onSend receives in the motif
  // request), and the Send button, which says why it cannot act while it cannot.
  let phraseMotif = null;
  function renderSend() {
    if (motif !== phraseMotif) {
      phraseMotif = motif;
      setText(phraseEl, motifPhrase(motif) ?? SCRATCH_COPY.phraseEmpty);
      setAttr(phraseEl, 'data-empty', motif.notes.length === 0);
    }
    const blocked = sendBlock();
    setDisabled(sendEl, blocked !== null, SCRATCH_COPY.sendTitle, blocked === null ? '' : sendRefusalText({ refused: blocked }));
  }

  // The selection keeps only notes that still exist: an edit or an Undo may have taken some away.
  function syncSelection() {
    const alive = new Set(motif.notes.map((note) => note.id));
    for (const id of selection) if (!alive.has(id)) selection.delete(id);
  }

  // Scrolls the box, instantly, when the cursor's cell leaves the part of the roll that shows: sideways past the piano names and the right edge,
  // and up or down past the ruler (held at the top of the box) and the velocity lane (held at its bottom). Called after the render, so the
  // rows it counts are the ones on screen.
  function revealCursor() {
    // The playhead is followed instead: while it is, nothing the cursor does scrolls the box.
    if (following()) return;
    revealCursorSideways();
    const rows = measureRowGeometry();
    if (rows === null) return;
    const rowTop = rows.topOf(cursor.pitch);
    if (rowTop < rows.visibleTop) scrollEl.scrollTop -= rows.visibleTop - rowTop;
    else if (rowTop + rows.rowHeight > rows.visibleBottom) scrollEl.scrollTop += rowTop + rows.rowHeight - rows.visibleBottom;
  }

  // The sideways half of revealCursor: scrolls past the piano names on the left and the right edge of the box.
  function revealCursorSideways() {
    const gridRect = gridEl.getBoundingClientRect();
    if (gridRect.width <= 0) return;
    const units = displayUnits();
    const left = gridRect.left + (cursor.unit / units) * gridRect.width;
    const right = gridRect.left + ((cursor.unit + stepUnits()) / units) * gridRect.width;
    const visibleLeft = gutterEl.getBoundingClientRect().right;
    const visibleRight = scrollEl.getBoundingClientRect().right;
    if (left < visibleLeft) writeScroll(scrollEl.scrollLeft - (visibleLeft - left));
    else if (right > visibleRight) writeScroll(scrollEl.scrollLeft + (right - visibleRight));
  }

  // The rows as they sit on screen right now: one row's height, the screen top of any pitch's row, and the band between the ruler (held at
  // the top of the box) and the velocity lane (held at its bottom). Null while the grid has no height or the band is not measured.
  function measureRowGeometry() {
    const gridRect = gridEl.getBoundingClientRect();
    if (gridRect.height <= 0) return null;
    const rowHeight = gridRect.height / shown.rows;
    const visibleTop = rulerEl.getBoundingClientRect().bottom;
    const visibleBottom = laneEl.getBoundingClientRect().top;
    if (!(visibleBottom > visibleTop)) return null;
    return { rowHeight, visibleTop, visibleBottom, topOf: (pitch) => gridRect.top + rowOf(pitch) * rowHeight };
  }

  // The grid or the length may have changed under the cursor (an edit, or an undo): it stays on a step of the grid, inside the motif.
  function fitCursor() {
    const step = stepUnits();
    cursor = { unit: clamp(Math.floor(cursor.unit / step) * step, 0, motifUnits(motif) - step), pitch: cursor.pitch };
  }

  // The one place an edit lands: a model command's result is committed to the history and becomes the motif, and its sentence the line.
  // Nothing else writes the motif except stepping through the history. `cursorTo` puts the cursor where the edit carried it (a note
  // that moved takes the cursor along).
  function apply(result, cursorTo = null, { amend = false } = {}) {
    history = commit(history, result, { amend });
    motif = result.motif;
    notice = result.notice;
    if (cursorTo !== null) cursor = cursorTo;
    fitCursor();
    syncSelection();
    render();
    if (cursorTo !== null) revealCursor();
  }

  // Undo and redo step through the Scratchpad's own edits. A drag in progress ends first, so it cannot land on a motif that changed under
  // it. A selection whose note is gone is cleared by syncSelection, and the cursor is held inside the motif. The box then scrolls to the
  // notes the step brought back or changed (or to the notes that remain, when it only took notes away) and keeps the cursor row in view
  // with them; when the cursor is too far from them to share the view, it moves onto the nearest one. The cursor is never stored.
  function stepHistory(step) {
    cancelGesture();
    run = null;
    const before = motif;
    const done = step(history);
    history = done.history;
    motif = done.motif;
    notice = done.notice;
    fitCursor();
    syncSelection();
    render();
    if (motif !== before) placeAfterStep(before);
  }

  // Scrolls the box vertically to the notes a history step touched. At most one cursor move and two measures: no loop.
  function placeAfterStep(before) {
    const touched = touchedNotes(before, motif);
    const targets = (touched.length > 0 ? touched : motif.notes).slice().sort((a, b) => Math.abs(a.start - cursor.unit) - Math.abs(b.start - cursor.unit) || a.start - b.start);
    const scrollTo = () => {
      const rows = measureRowGeometry();
      if (rows === null) return undefined;
      const { by, nearest } = historyScroll({ tops: targets.map((note) => rows.topOf(note.pitch)), cursorTop: rows.topOf(cursor.pitch), rowHeight: rows.rowHeight, visibleTop: rows.visibleTop, visibleBottom: rows.visibleBottom });
      return { by, nearest };
    };
    let result = scrollTo();
    if (result === undefined) return;
    let moved = false;
    if (result.by === null) {
      const target = targets[result.nearest];
      cursor = { unit: target.start, pitch: target.pitch };
      fitCursor();
      render();
      moved = true;
      result = scrollTo();
      if (result === undefined || result.by === null) return;
    }
    scrollEl.scrollTop += result.by;
    if (moved && !following()) revealCursorSideways();
  }

  // A cursor move: the edit's notice goes, and the cell or note under the new place is read.
  function placeCursor(unit, pitch) {
    cursor = { unit: clamp(unit, 0, motifUnits(motif) - stepUnits()), pitch: clamp(pitch, MIN_PITCH, MAX_PITCH) };
    notice = null;
    syncSelection();
    render();
    revealCursor();
  }

  // Lower and Higher move the base window by an octave and the cursor with it. The rows still follow the notes, so when they pin the range
  // a press may change nothing visible.
  function moveWindow(octaves) {
    const next = clamp(base + octaves * OCTAVE, MIN_WINDOW_START, MAX_WINDOW_START);
    if (next === base) return;
    cursor = { unit: cursor.unit, pitch: clamp(cursor.pitch + next - base, MIN_PITCH, MAX_PITCH) };
    base = next;
    notice = null;
    syncSelection();
    render();
  }

  // The commands that act on the note under the cursor say so when there is none.
  function withNoteUnderCursor(act) {
    const note = noteAt(motif, cursor.pitch, cursor.unit);
    if (note === null) {
      notice = SCRATCH_COPY.noNote;
      render();
      return;
    }
    act(note);
  }

  // The ids of the selected notes, ascending.
  const selectedIds = () => [...selection].sort((a, b) => a - b);

  // One undo step is one physical key press. A held key repeats, and each repeat computes the whole edit again from the motif the first
  // press started from, with the summed distance, and replaces the step the first press made instead of adding one: Undo then goes back to
  // before the key went down, and the notice says the sum. `make(base, count)` gives the command's result for `count` presses from `base`;
  // `cursorMoves(count)` gives how far the cursor follows, or null. A refusal says why and changes nothing, the earlier repeats stay.
  function runEdit(signature, repeat, make, cursorMoves) {
    const continuing = repeat && run !== null && run.signature === signature && run.present === motif;
    if (!repeat) run = null;
    const count = continuing ? run.count + 1 : 1;
    const base = continuing ? run.base : motif;
    const from = continuing ? run.cursor : cursor;
    const result = make(base, count);
    if (result.refused !== undefined) {
      notice = result.refused;
      render();
      return;
    }
    if (result.motif === motif && result.notice === '') return;
    const moves = cursorMoves(count);
    const cursorTo = moves === null ? null : { unit: from.unit + moves.dUnit, pitch: clamp(from.pitch + moves.dPitch, MIN_PITCH, MAX_PITCH) };
    apply(result, cursorTo, { amend: continuing });
    run = { signature, base, count, cursor: from, present: motif };
  }

  // An arrow with a selection moves the selection, one grid step or one semitone (Alt: one beat or one octave), and the cursor follows; with
  // none it moves the cursor the same distance. Shift with Left or Right changes the length of the selection, else of the note under the cursor.
  function arrowKey(event, arrow) {
    const signature = `${event.key}|${event.altKey}|${event.shiftKey}`;
    if (!event.altKey && event.shiftKey && arrow.right !== 0) {
      lengthenBy(arrow.right, signature, event.repeat);
      return;
    }
    const dUnit = arrow.right * (event.altKey ? UNITS_PER_BEAT : stepUnits());
    const dPitch = arrow.up * (event.altKey ? OCTAVE : 1);
    if (selection.size === 0) {
      placeCursor(cursor.unit + dUnit, cursor.pitch + dPitch);
      return;
    }
    const ids = selectedIds();
    cancelGesture();
    runEdit(signature, event.repeat, (base, count) => moveNotes(base, ids, { dStart: dUnit * count, dPitch: dPitch * count }), (count) => ({ dUnit: dUnit * count, dPitch: dPitch * count }));
  }

  function lengthenBy(steps, signature, repeat) {
    const ids = selectedIds();
    if (ids.length === 0) {
      const note = noteAt(motif, cursor.pitch, cursor.unit);
      if (note === null) {
        notice = SCRATCH_COPY.noNote;
        render();
        return;
      }
      ids.push(note.id);
    }
    cancelGesture();
    runEdit(signature, repeat, (base, count) => resizeNotes(base, ids, steps * count), () => null);
  }

  // The selection keys. None of them is an edit: the history is not touched.
  function selectAll() {
    selection = new Set(motif.notes.map((note) => note.id));
    notice = selectionText({ kind: 'all', count: selection.size });
    render();
  }

  function selectNone() {
    selection = new Set();
    notice = selectionText({ kind: 'none' });
    render();
  }

  // s adds the note under the cursor to the selection or takes it out.
  function toggleUnderCursor() {
    const note = noteAt(motif, cursor.pitch, cursor.unit);
    if (note === null) {
      notice = selectionText({ kind: 'nothing-here' });
      render();
      return;
    }
    const had = selection.has(note.id);
    selection = new Set(had ? [...selection].filter((id) => id !== note.id) : [...selection, note.id]);
    notice = selectionText({ kind: had ? 'removed' : 'added', name: noteName(note.pitch), count: selection.size });
    render();
  }

  // [ and ] walk the cursor to the previous or next note in time order and leave the selection as it is. With a group selected the line
  // reads the note the cursor came to, because the group's own line would hide it.
  function walkNotes(direction) {
    const note = neighborNote(motif, cursor, direction);
    if (note === null) {
      notice = direction > 0 ? SCRATCH_COPY.noLaterNote : SCRATCH_COPY.noEarlierNote;
      render();
      return;
    }
    placeCursor(note.start, note.pitch);
    if (selection.size > 1) {
      notice = spokenNote(note, motif.grid);
      render();
    }
  }

  rollEl.addEventListener('focus', () => {
    hasFocus = true;
    render();
  });
  rollEl.addEventListener('blur', () => {
    hasFocus = false;
    render();
  });

  rollEl.addEventListener('keydown', (event) => {
    // A key that edits the motif ends a mouse press first, so the release cannot act on a note the key moved or erased.
    // The bracket keys are matched by the character the key gives, whatever modifier made it: on some layouts the bracket needs Alt (AltGr
    // on others, which reads as Ctrl and Alt together). Ctrl or Cmd alone with a bracket stays the browser's.
    if ((event.key === '[' || event.key === ']') && ((!event.ctrlKey && !event.metaKey) || event.altKey)) {
      walkNotes(event.key === ']' ? 1 : -1);
      event.preventDefault();
      return;
    }
    // Select all and select none are taken before the Ctrl and Cmd return below, and the default is prevented so the page text is not selected.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && typeof event.key === 'string' && event.key.toLowerCase() === 'a') {
      cancelGesture();
      if (event.shiftKey) selectNone();
      else selectAll();
      event.preventDefault();
      return;
    }
    // Other Ctrl and Cmd combinations are the browser's; Alt combinations are taken only for the arrows.
    if (event.ctrlKey || event.metaKey) return;
    const arrow = ARROWS[event.key];
    if (arrow !== undefined) {
      arrowKey(event, arrow);
    } else if (event.altKey) {
      return;
    } else {
      switch (event.key) {
        case 'Home':
          placeCursor(0, cursor.pitch);
          break;
        case 'End':
          placeCursor(motifUnits(motif) - stepUnits(), cursor.pitch);
          break;
        case 'PageUp':
          moveWindow(1);
          break;
        case 'PageDown':
          moveWindow(-1);
          break;
        case 'v':
          // The velocity lane, on the note under the cursor.
          withNoteUnderCursor((note) => {
            selection = new Set([note.id]);
            render();
            laneEl.focus();
          });
          break;
        case 't':
          toggleTap();
          break;
        case 'd':
          cancelGesture();
          toggleDraw();
          break;
        case 's':
          toggleUnderCursor();
          break;
        case 'l':
          cancelGesture();
          alignAll();
          break;
        case 'Enter':
          cancelGesture();
          if (!event.repeat) apply(toggleAt(motif, { pitch: cursor.pitch, unit: cursor.unit }));
          break;
        case 'Delete':
        case 'Backspace':
          cancelGesture();
          // The selection goes in one step, else the note under the cursor; a held key erases once.
          if (event.repeat) break;
          if (selection.size > 0) apply(eraseNotes(motif, selectedIds()));
          else withNoteUnderCursor((note) => apply(eraseNote(motif, note.id)));
          break;
        case ' ':
          break;
        default:
          return;
      }
    }
    // A handled key never scrolls the box on its own.
    event.preventDefault();
  });

  // Draw mode on or off. It changes how a drag on an empty cell reads, and nothing else; it is kept for the session only.
  function toggleDraw() {
    draw = !draw;
    notice = draw ? SCRATCH_COPY.drawOn : SCRATCH_COPY.drawOff;
    render();
  }

  // --- Tap ---

  // Tap on or off. Turning it on needs the music playing: with none the line says so and Tap stays off. Every change is told to the page.
  function setTapping(on, words) {
    if (tapping === on) return;
    tapping = on;
    if (!on) nowUnit = null;
    notice = words;
    render();
    onTapChange(on);
  }

  function toggleTap() {
    if (tapping) {
      setTapping(false, SCRATCH_COPY.tapStopped);
    } else if (!musicPlaying) {
      notice = SCRATCH_COPY.tapNeedsMusic;
      render();
    } else {
      setTapping(true, SCRATCH_COPY.tapStarted);
    }
  }

  // The button is never disabled, so a press with no music can say why; it is the only button that answers while it carries aria-disabled.
  tapEl.addEventListener('click', toggleTap);

  function setMusicPlaying(playing) {
    musicPlaying = playing === true;
    if (!musicPlaying && tapping) setTapping(false, SCRATCH_COPY.tapMusicStopped);
    else render();
  }

  function setNowUnit(unit) {
    if (unit !== null && (typeof unit !== 'number' || !Number.isFinite(unit))) {
      throw new TypeError(`Moontide: the Scratchpad marker needs a finite number of units or null, got ${String(unit)}`);
    }
    if (unit === nowUnit) return;
    nowUnit = unit;
    renderNow();
  }

  // A key press the page measured: the stamp of the press, the page's clock read just before, and the stamps of two cycle lines. The
  // note lands at the cursor's row; a refused stamp or a clock that gave no lines says so in the line and places nothing.
  function tap({ ts, h, anchors }) {
    if (!tapping) return;
    applyCommand(tapNote(motif, { ts, h, anchors, pitch: cursor.pitch }));
  }

  // --- Listen: the hear strip ---

  // The menu's options as the page last gave them, the setup file's word, the option the user chose ('' for none), the way to start and Loop (kept
  // for the session only) and the last state the page told: { kind: 'idle' } until a play has been asked for.
  let outputs = [];
  let outputsKey = '';
  let outputsSetup = 'valid';
  let chosen = '';
  let startWay = 'music';
  let loopOn = false;
  let hear = { kind: 'idle' };
  // A play that waits or plays: the live overlay is paused and the playhead crosses the motif. Following the playhead needs a place to follow.
  function hearing() {
    return hear.kind === 'waiting' || hear.kind === 'playing';
  }
  const hearTracking = () => hearing() && hearUnit !== null;
  const hearActive = () => hear.kind === 'asking' || hearing();

  // The state the strip's sentence is for: the page's, or while no play is going on what the strip itself can say (nothing to choose, nothing chosen).
  function shownHear() {
    if (hear.kind !== 'idle') return hear;
    if (outputs.length === 0) return { kind: 'no-instrument', setup: outputsSetup };
    if (chosen === '') return { kind: 'choose' };
    return null;
  }

  // The option the Heads up sentences are for: the instrument and channel of a play that asks, waits or plays, else the one chosen in the menu.
  function warnedOption() {
    if (hearActive()) {
      const playing = outputs.find((candidate) => candidate.instrumentId === hear.instrumentId && candidate.channel === hear.channel);
      if (playing !== undefined) return playing;
    }
    return outputs.find((candidate) => candidate.value === chosen) ?? null;
  }

  // The warnings never reach the buttons: they are words in the strip's one live region, after the sentence of the state, one sentence each.
  function hearSentences() {
    const shown = shownHear();
    const sentences = shown === null ? [] : [hearText(shown)];
    const option = warnedOption();
    if (option !== null) {
      const tracks = playingTracks(option.instrumentId, option.channel);
      if (!Array.isArray(tracks)) throw new TypeError('Moontide: playingTracks must give a list of track names.');
      sentences.push(
        ...hearWarnings({ instrumentId: option.instrumentId, channel: option.channel, tracks, monophonic: option.monophonic === true, chord: hasChord(motif) }),
      );
    }
    return sentences;
  }

  let hearKey = '';
  function renderHear() {
    const sentences = hearSentences();
    const key = JSON.stringify(sentences.map((parts) => [parts.before, parts.id, parts.after]));
    if (key !== hearKey) {
      hearKey = key;
      const pieces = [];
      sentences.forEach((parts, index) => {
        // Sentences follow each other in one line; the space between them belongs to the first piece of the next one.
        let gap = index === 0 ? '' : ' ';
        for (const [text, className] of [[parts.before, ''], [parts.id, 'sp-hear-id'], [parts.after, '']]) {
          if (text === '') continue;
          const element = document.createElement('span');
          element.className = className;
          element.textContent = gap + text;
          gap = '';
          pieces.push(element);
        }
      });
      playNoteEl.replaceChildren(...pieces);
    }
    setAttr(viewEl, 'data-hear', hear.kind);
    const why = outputs.length === 0 ? hearText({ kind: 'no-instrument', setup: outputsSetup }).before : chosen === '' ? SCRATCH_COPY.hearChoose : null;
    setDisabled(playListenEl, why !== null, SCRATCH_COPY.listenTitle, why ?? '');
    setDisabled(playStopEl, !hearActive(), SCRATCH_COPY.stopTitle, SCRATCH_COPY.stopNothing);
    setAttr(playMusicEl, 'aria-pressed', startWay === 'music');
    setAttr(playNowEl, 'aria-pressed', startWay === 'now');
    setAttr(playLoopEl, 'aria-pressed', loopOn);
  }

  // The menu of instruments and channels: the placeholder, then one option for each of `options` (page/scratch-model.js listenOptions). It is rebuilt
  // only when the list changed, and the choice stays when the new list still holds it. The change is seen on every field the view reads, so a
  // model saved as monophonic, a switch-off or a new port shows at once. `setup` is the setup file's word, for the sentence when the list is empty.
  function setOutputs(options, setup = 'valid') {
    if (!Array.isArray(options)) throw new TypeError('Moontide: the Scratchpad menu needs a list of options.');
    const key = JSON.stringify(options.map((option) => [option.value, option.text, option.title, option.port, option.enabled, option.monophonic]));
    outputsSetup = setup;
    if (key !== outputsKey) {
      outputsKey = key;
      outputs = options;
      const made = [];
      for (const [value, text, title] of [['', SCRATCH_COPY.hearOutputPlaceholder, null], ...options.map((option) => [option.value, option.text, option.title])]) {
        const element = document.createElement('option');
        element.value = value;
        element.textContent = text;
        if (title !== null) element.setAttribute('title', title);
        made.push(element);
      }
      playOutputEl.replaceChildren(...made);
    }
    if (chosen !== '' && !options.some((option) => option.value === chosen)) chosen = '';
    playOutputEl.value = chosen;
    renderHear();
  }

  // What the page tells the view about a play: { kind, instrumentId, channel, ... } (see hearText), or { kind: 'idle' } for none.
  function setHear(next) {
    if (next === null || typeof next !== 'object' || typeof next.kind !== 'string') throw new TypeError('Moontide: the Scratchpad hear state needs an object with a kind.');
    if (next.kind !== 'idle') hearText(next);
    const was = hearing();
    hear = next;
    renderHear();
    if (hearing() === was) return;
    // The play began or ended: the live overlay is put away or comes back, and the playhead starts again from nothing.
    hearUnit = null;
    lastPlayhead = null;
    setLive(liveRaw);
    renderPlayhead();
  }

  // Where the Listen play is in the motif, in units, or null while it waits or nothing plays; `frameMs` is the page's frame time, the clock that
  // lets following pause after a hand scroll. The playhead is drawn only while a play waits or plays, and the box turns to follow it as it does the
  // live playhead.
  function setHearPosition(unit, frameMs) {
    if (unit !== null && (typeof unit !== 'number' || !Number.isFinite(unit))) {
      throw new TypeError(`Moontide: the Scratchpad Listen playhead needs a finite number of units or null, got ${String(unit)}`);
    }
    if (Number.isFinite(frameMs)) lastFrameMs = frameMs;
    if (unit === hearUnit) return;
    hearUnit = unit;
    if (!hearing()) return;
    renderPlayhead();
    if (unit !== null) follow(unit);
  }

  // The page tells the view that the playing code or the playing state changed, so the tracks on the chosen channel are asked again.
  function refreshHear() {
    renderHear();
  }

  // A press of Listen: with notes and a choice it asks the page to play; the view never plays or sends. A press with no notes still replaces
  // the play before it: that play is stopped first, then the refusal is said, so Stop is never greyed out over a play that goes on.
  function listenPress() {
    if (motif.notes.length === 0) {
      if (hearActive()) onStop();
      setHear({ kind: 'refused', refused: 'empty', instrumentId: '', channel: '', mid: false });
      return;
    }
    const option = outputs.find((candidate) => candidate.value === chosen);
    if (option === undefined) return;
    onListen({ instrumentId: option.instrumentId, channel: option.channel, start: startWay, loop: loopOn });
  }

  playOutputEl.addEventListener('change', () => {
    chosen = playOutputEl.value;
    // A sentence about a play that is over belongs to the instrument it was for.
    if (!hearActive()) hear = { kind: 'idle' };
    renderHear();
  });
  onPress(playMusicEl, () => {
    startWay = 'music';
    renderHear();
  });
  onPress(playNowEl, () => {
    startWay = 'now';
    renderHear();
  });
  onPress(playLoopEl, () => {
    loopOn = !loopOn;
    renderHear();
    onLoop(loopOn);
  });
  onPress(playListenEl, listenPress);
  onPress(playStopEl, () => onStop());

  // --- the toolbar ---

  // A command of the toolbar: a refusal goes to the line and changes nothing; a command that changes nothing is no edit.
  function applyCommand(result) {
    if (result.refused !== undefined) {
      notice = result.refused;
      render();
      return;
    }
    if (result.motif === motif && result.notice === '') return;
    apply(result);
  }

  // Record that takes the keyboard's snapshot (the page reads it) and puts it on the roll through the one apply function, so Undo takes it
  // back. The pitch window moves to show the notes, with the cursor on the lowest one. A snapshot of null means the music's clock could
  // not be read; an empty snapshot is said by the model. Either goes to the line and changes nothing. Returns whether the motif was
  // replaced, so the page can empty the keyboard buffer: the live layer showed exactly the notes that were just written.
  function record(snapshot) {
    if (snapshot === null || snapshot === undefined) {
      notice = SCRATCH_COPY.recordClockUnreadable;
      render();
      return false;
    }
    const result = recordBuffer(motif, snapshot);
    if (result.refused !== undefined) {
      applyCommand(result);
      return false;
    }
    cancelGesture();
    base = windowStartFor(result.motif);
    const lowest = result.motif.notes.reduce((best, note) => (note.pitch < best.pitch || (note.pitch === best.pitch && note.start < best.start) ? note : best));
    apply(result, { unit: lowest.start, pitch: lowest.pitch });
    return true;
  }

  // The page asks for MIDI only from this press, through the one shared enable.
  allowEl.addEventListener('click', () => onAllow());

  // Send to Claude: the only way the motif leaves the view, and only by the user's press. The words are read here and nowhere else.
  // Whether the page is connected and whether the last send is still on its way is told by the page (setSendState).
  let sendConnected = true;
  let sendPending = false;
  // The line written for the last request that went, so the sentence of a request that waits for Claude can follow it.
  let sentLine = '';

  // The word for why a send cannot go now, or null.
  function sendBlock() {
    if (motif.notes.length === 0) return 'no-notes';
    if (!sendConnected) return 'disconnected';
    if (sendPending) return 'pending';
    return null;
  }

  function send() {
    const blocked = sendBlock();
    if (blocked !== null) {
      setText(sendStatusEl, sendRefusalText({ refused: blocked }));
      return;
    }
    const request = motifRequest(motif, musicCycle());
    const result = onSend({ words: wordsEl.value, motif: request });
    if (result !== undefined && result !== null && result.refused !== undefined) setText(sendStatusEl, sendRefusalText(result));
    else if (result !== undefined && result !== null && result.id !== undefined) {
      sentLine = sentText(request);
      setText(sendStatusEl, sentLine);
    } else throw new Error('Moontide: onSend must answer { id } for a request that went or { refused } for one that did not.');
  }

  // The page tells the view whether it is connected to Moontide and whether the last motif request is still on its way.
  function setSendState(state) {
    if (state === null || typeof state !== 'object' || typeof state.connected !== 'boolean' || typeof state.pending !== 'boolean') {
      throw new TypeError('Moontide: the Scratchpad send state needs connected and pending, both true or false.');
    }
    sendConnected = state.connected;
    sendPending = state.pending;
    renderSend();
  }

  // What became of the request the page sent: a refusal or a request nobody confirmed is said in the status line; one that arrived keeps the sent
  // line, and one that waits for Claude says so after it.
  function motifResult(result) {
    const words = motifResultText(result);
    if (words === null) return;
    setText(sendStatusEl, result.status === 'waiting' ? `${sentLine} ${words}`.trim() : words);
  }

  sendEl.addEventListener('click', send);

  wordsEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    // No other key handler of the page sees this Enter, and a held key does not send twice.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    send();
  });

  // The button keeps focus when it has nothing to take: a press then says why in the line, like the Tap button.
  recordEl.addEventListener('click', () => {
    if (heardCount === 0) {
      notice = SCRATCH_COPY.recordNothing;
      render();
      return;
    }
    onRecord();
  });

  // A button that carries aria-disabled does nothing when it is pressed.
  function onPress(element, act) {
    element.addEventListener('click', () => {
      if (element.getAttribute('aria-disabled') === 'true') return;
      act();
    });
  }

  for (const { grid, element } of gridButtons) onPress(element, () => applyCommand(setGrid(motif, grid.id)));
  onPress(fewerEl, () => applyCommand(setCycles(motif, motif.cycles - 1)));
  onPress(moreEl, () => applyCommand(setCycles(motif, motif.cycles + 1)));
  onPress(lowerEl, () => moveWindow(-1));
  onPress(higherEl, () => moveWindow(1));
  onPress(drawEl, () => {
    cancelGesture();
    toggleDraw();
  });
  // Earlier and Later move the selection, else the whole motif, one grid step; a press that cannot move says why, as the title does. Align moves the
  // whole motif whatever is selected. Clear empties the roll with no question: the notice names Undo as the way back. A press on a button that
  // carries aria-disabled gets the same sentence from the model, so none of them needs a check of its own.
  const nudge = (direction) => {
    cancelGesture();
    if (motif.notes.length === 0) {
      notice = SCRATCH_COPY.moveNothing;
      render();
      return;
    }
    applyCommand(moveNotes(motif, movedIds(), { dStart: direction * stepUnits() }));
  };
  function alignAll() {
    applyCommand(alignMotif(motif));
  }
  earlierEl.addEventListener('click', () => nudge(-1));
  laterEl.addEventListener('click', () => nudge(1));
  alignEl.addEventListener('click', () => {
    cancelGesture();
    alignAll();
  });
  clearEl.addEventListener('click', () => {
    cancelGesture();
    applyCommand(clearMotif(motif));
  });
  onPress(undoEl, () => stepHistory(undo));
  onPress(redoEl, () => stepHistory(redo));

  // Ctrl or Cmd with Z undoes, with Shift redoes (Ctrl+Y redoes too). The keys are heard on the view alone, so they reach the motif only
  // while focus is inside the Scratchpad; the code editor's own undo is never taken. The roll and the lane leave these keys alone.
  viewEl.addEventListener('keydown', (event) => {
    // The words field has its own undo for what is typed in it.
    if (event.target === wordsEl) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const letter = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (letter === 'z') stepHistory(event.shiftKey ? redo : undo);
    else if (letter === 'y' && event.ctrlKey && !event.shiftKey) stepHistory(redo);
    else return;
    event.preventDefault();
  });

  // --- the mouse ---

  // The point of an event on the grid, as the numbers the gesture helpers read. The grid's box is read again on every call, because
  // the box scrolls under a drag.
  function readPoint(event) {
    const rect = gridEl.getBoundingClientRect();
    // The pointer is read against the units on screen (the motif's, or the buffer's 8 cycles while live); `limit` is the motif's own end, where
    // every edit stops, and a cell past it takes no press.
    const units = displayUnits();
    const limit = motifUnits(motif);
    const geometry = { rect, x: event.clientX, y: event.clientY, units, gridUnit: stepUnits(), rows: shown.rows, high: shown.high };
    const cell = cellAt(geometry);
    return { rect, units, limit, at: pointerUnit(geometry), row: pointerRow(geometry), cell: cell !== null && cell.unit >= limit ? null : cell };
  }

  function setHover(id, cell) {
    const same = id === hoverId && (cell === null ? hoverCell === null : hoverCell !== null && hoverCell.unit === cell.unit && hoverCell.pitch === cell.pitch);
    if (same) return;
    hoverId = id;
    hoverCell = cell;
    render();
  }

  // With no press on: the note under the pointer is read and outlined, or the empty cell a drag would start in.
  function hover(event) {
    const { at, cell } = readPoint(event);
    if (cell === null) {
      setHover(null, null);
      return;
    }
    const note = noteAt(motif, cell.pitch, Math.floor(at));
    if (note !== null) setHover(note.id, null);
    else setHover(null, cell);
  }

  function setPreview(next) {
    const same = preview !== null && next !== null && preview.pitch === next.pitch && preview.start === next.start && preview.length === next.length;
    if (same || (preview === null && next === null)) return;
    preview = next;
    render();
  }

  // Ends a press with nothing committed: the preview goes and the pointer is let go.
  function cancelGesture() {
    if (press === null && lanePress === null) return;
    if (press !== null) {
      const { pointerId, startSelection } = press;
      // A press that is cancelled changes nothing, the selection it was building included.
      selection = startSelection;
      syncSelection();
      press = null;
      preview = null;
      rectBox = null;
      groupDraft = null;
      if (gridEl.hasPointerCapture(pointerId)) gridEl.releasePointerCapture(pointerId);
    }
    if (lanePress !== null) {
      const { pointerId } = lanePress;
      lanePress = null;
      laneDraft = null;
      if (barsEl.hasPointerCapture(pointerId)) barsEl.releasePointerCapture(pointerId);
    }
    render();
    flushLive();
  }

  // A drag near the edge of the part of the roll that shows scrolls the box by a fixed step on each pointer move. There is no timer:
  // the pointer has to keep moving, which keeps the scroll as steady as the hand.
  function scrollAtEdge(event) {
    const step = edgeScrollPx({ x: event.clientX, left: gutterEl.getBoundingClientRect().right, right: scrollEl.getBoundingClientRect().right, remPx: press.remPx });
    if (step !== 0) writeScroll(Math.max(0, scrollEl.scrollLeft + step));
  }

  gridEl.addEventListener('pointerdown', (event) => {
    if (press !== null || lanePress !== null || event.button !== 0) return;
    const { rect, units, at, row, cell } = readPoint(event);
    if (cell === null) return;
    const remPx = rootFontPx();
    const note = noteAt(motif, cell.pitch, Math.floor(at));
    // On a note, the right edge resizes it and the rest of it moves it.
    let part = null;
    if (note !== null) {
      const left = rect.left + (note.start / units) * rect.width;
      part = pickPart({ left, width: (note.length / units) * rect.width, x: event.clientX, remPx });
    }
    // What the press does once it is a drag: a box in Select mode or a note in Draw mode on an empty cell, else a move or a resize.
    const kind = note === null ? (draw ? 'draw' : 'rect') : part === 'edge' ? 'edge' : 'move';
    // Shift, Ctrl or Cmd adds to the selection instead of replacing it (Ctrl on every system: no platform is read here).
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      remPx,
      thresholdPx: DRAG_THRESHOLD_REM * remPx,
      cell,
      at0: at,
      // The press is kept by pitch, not by row: while live the range can grow under a drag, and a row counted from the old top would
      // then point an octave away. `pitchY0` is the press's height in pitches, the top edge of a row being its pitch plus one.
      pitch0: shown.high - row,
      pitchY0: shown.high + 1 - (event.clientY - rect.top) / (rect.height / shown.rows),
      note,
      part,
      kind,
      additive,
      startSelection: new Set(selection),
      toggleOff: false,
      group: false,
      locked: false,
    };
    if (note !== null) {
      if (additive) {
        // A modifier press adds the note now, or marks it to be taken out if the press turns out to be a click.
        press.toggleOff = selection.has(note.id);
        if (!press.toggleOff) selection = new Set([...selection, note.id]);
      } else if (!selection.has(note.id)) {
        // A press on a note that is not selected selects it, so a drag moves it alone.
        selection = new Set([note.id]);
      }
      // A drag of a selected note carries the whole selection, as one rigid group.
      press.group = selection.size > 1;
    }
    hoverId = null;
    hoverCell = null;
    // The grid keeps the pointer: the notes under it are redrawn, and a drag may leave the box.
    gridEl.setPointerCapture(event.pointerId);
    render();
  });

  gridEl.addEventListener('pointermove', (event) => {
    if (press === null) {
      hover(event);
      return;
    }
    if (event.pointerId !== press.pointerId) return;
    if (!press.locked) {
      if (!lockDrag({ dx: event.clientX - press.x, dy: event.clientY - press.y, thresholdPx: press.thresholdPx })) return;
      press.locked = true;
    }
    scrollAtEdge(event);
    const { rect, at, row, units, limit } = readPoint(event);
    const { note, cell } = press;
    if (press.kind === 'rect') {
      showBox(event, rect, units, limit);
    } else if (press.kind === 'draw') {
      setPreview({ pitch: cell.pitch, start: cell.unit, length: drawLength({ start: cell.unit, pointerUnit: at, gridUnit: stepUnits(), units: limit }), velocity: DEFAULT_VELOCITY });
    } else if (press.group) {
      showGroup(at, row, limit);
    } else if (press.part === 'edge') {
      setPreview({ ...note, length: resizeLength({ start: note.start, pointerUnit: at, gridUnit: stepUnits(), units: limit }) });
    } else {
      const target = moveTarget({ note, dUnits: at - press.at0, dRows: row - rowOf(press.pitch0), gridUnit: stepUnits(), units: limit, low: shown.low, high: shown.high });
      setPreview({ ...note, start: target.start, pitch: target.pitch });
    }
  });

  // A drag of a note that belongs to a selection of several: the whole group moves by the same distance, or changes length by the same
  // number of steps, and is drawn there until the release commits it.
  function showGroup(at, row, units) {
    const { note } = press;
    let next;
    if (press.part === 'edge') {
      const length = resizeLength({ start: note.start, pointerUnit: at, gridUnit: stepUnits(), units });
      next = { kind: 'edge', dStart: 0, dPitch: 0, dSteps: (length - note.length) / stepUnits() };
    } else {
      const target = groupMoveTarget({
        notes: motif.notes.filter((candidate) => selection.has(candidate.id)),
        dUnits: at - press.at0,
        dRows: row - rowOf(press.pitch0),
        gridUnit: stepUnits(),
        units,
        low: shown.low,
        high: shown.high,
      });
      next = { kind: 'move', dStart: target.dStart, dPitch: target.dPitch, dSteps: 0 };
    }
    if (groupDraft !== null && Object.keys(next).every((name) => next[name] === groupDraft[name])) return;
    groupDraft = next;
    render();
  }

  // The box of a selection drag, from the press to the pointer: the notes it touches become the selection while the pointer moves, and
  // nothing enters the history. The press is kept in units and pitches, so a box still starts where it did after the roll scrolled or the
  // live range grew.
  function showBox(event, rect, units, limit) {
    const spanned = selectionBox({
      rect,
      x0: rect.left + (press.at0 / units) * rect.width,
      y0: rect.top + ((shown.high + 1 - press.pitchY0) / shown.rows) * rect.height,
      x1: event.clientX,
      y1: event.clientY,
      units,
      rows: shown.rows,
    });
    // The box stops at the motif's own end: the cells past it (live shows 8 cycles) take no selection.
    const box = { ...spanned, fromUnit: Math.min(spanned.fromUnit, limit), toUnit: Math.min(spanned.toUnit, limit) };
    const hits = notesInBox({ notes: motif.notes, box, high: shown.high });
    const same = rectBox !== null && Object.keys(box).every((name) => box[name] === rectBox[name]) && hits.every((id) => selection.has(id)) && (press.additive || hits.length === selection.size);
    if (same) return;
    rectBox = box;
    selection = new Set(press.additive ? [...press.startSelection, ...hits] : hits);
    render();
  }

  // The cursor goes to the step under the pointer, held inside the note, so the note is the one under the cursor.
  function cursorOn(note, at) {
    const step = stepUnits();
    return { unit: clamp(Math.floor(at / step) * step, note.start, note.start + note.length - step), pitch: note.pitch };
  }

  gridEl.addEventListener('pointerup', (event) => {
    if (press === null || event.pointerId !== press.pointerId) return;
    const done = press;
    const draft = preview;
    const groupMove = groupDraft;
    press = null;
    preview = null;
    rectBox = null;
    groupDraft = null;
    if (gridEl.hasPointerCapture(done.pointerId)) gridEl.releasePointerCapture(done.pointerId);
    const { at } = readPoint(event);
    const { note } = done;
    if (note === null) {
      if (done.kind === 'rect' && done.locked) {
        // The box already made the selection while it ran; the release commits nothing.
        render();
      } else if (done.kind === 'draw' && done.locked && draft !== null) {
        const result = placeNote(motif, { pitch: done.cell.pitch, start: done.cell.unit, length: draft.length });
        selection = new Set([result.note.id]);
        apply(result, cursorOn(result.note, at));
      } else {
        // A click on empty space never writes a note: it clears the selection, unless a modifier is held, and puts the cursor on the cell.
        if (!done.additive) selection = new Set();
        placeCursor(done.cell.unit, done.cell.pitch);
      }
    } else if (done.group && groupMove !== null) {
      // What the group showed is what is committed.
      const ids = selectedIds();
      const result = groupMove.kind === 'edge' ? resizeNotes(motif, ids, groupMove.dSteps) : moveNotes(motif, ids, { dStart: groupMove.dStart, dPitch: groupMove.dPitch });
      const where = { ...note, start: note.start + groupMove.dStart, pitch: note.pitch + groupMove.dPitch };
      if (result.refused !== undefined) {
        applyCommand(result);
      } else if (result.motif === motif && result.notice === '') {
        const place = cursorOn(note, done.cell.unit);
        placeCursor(place.unit, place.pitch);
      } else {
        apply(result, cursorOn(where, at));
      }
    } else if (draft === null) {
      // A press on a note that did not become a drag only selects it (a modifier adds it or takes it out), and nothing else.
      if (!done.additive) selection = new Set([note.id]);
      else if (done.toggleOff) selection = new Set([...selection].filter((id) => id !== note.id));
      const place = cursorOn(note, done.cell.unit);
      placeCursor(place.unit, place.pitch);
    } else {
      // What was previewed is what is committed, whatever the pointer did since.
      const result = done.part === 'edge' ? resizeNote(motif, note.id, draft.length) : moveNote(motif, note.id, { start: draft.start, pitch: draft.pitch });
      if (result.motif === motif && result.notice === '') {
        const place = cursorOn(note, done.cell.unit);
        placeCursor(place.unit, place.pitch);
      } else {
        apply(result, cursorOn(result.note, at));
      }
    }
    hover(event);
    flushLive();
  });

  // A double-click on an empty cell writes a one-step note there and selects it; on a note it only selects it. It goes through placeNote,
  // never toggleAt, so a cell that already holds the note is not erased by the second click. A plain click writes nothing.
  gridEl.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || press !== null || lanePress !== null) return;
    const { at, cell } = readPoint(event);
    if (cell === null) return;
    const note = noteAt(motif, cell.pitch, Math.floor(at));
    if (note !== null) {
      selection = new Set([note.id]);
      const place = cursorOn(note, cell.unit);
      placeCursor(place.unit, place.pitch);
      return;
    }
    const result = placeNote(motif, { pitch: cell.pitch, start: cell.unit, length: stepUnits() });
    selection = new Set([result.note.id]);
    apply(result, cursorOn(result.note, at));
  });

  // --- the velocity lane ---

  // A press on the column of a bar selects its note and puts the cursor on it; a drag then sets the velocity from the pointer's height,
  // shown live, and the release writes it as one edit. Nothing is written before the release.
  barsEl.addEventListener('pointerdown', (event) => {
    if (press !== null || lanePress !== null || event.button !== 0 || event.ctrlKey || event.metaKey) return;
    const remPx = rootFontPx();
    const id = barAt({ rect: barsEl.getBoundingClientRect(), x: event.clientX, bars: barLayout(), units: displayUnits(), gridUnit: stepUnits(), remPx });
    if (id === null) return;
    const note = motif.notes.find((candidate) => candidate.id === id);
    lanePress = { pointerId: event.pointerId, id, x: event.clientX, y: event.clientY, thresholdPx: DRAG_THRESHOLD_REM * remPx, locked: false };
    hoverId = null;
    hoverCell = null;
    barsEl.setPointerCapture(event.pointerId);
    selection = new Set([id]);
    placeCursor(note.start, note.pitch);
  });

  barsEl.addEventListener('pointermove', (event) => {
    if (lanePress === null || event.pointerId !== lanePress.pointerId) return;
    if (!lanePress.locked) {
      if (!lockDrag({ dx: event.clientX - lanePress.x, dy: event.clientY - lanePress.y, thresholdPx: lanePress.thresholdPx })) return;
      lanePress.locked = true;
    }
    const velocity = velocityAt({ rect: barsEl.getBoundingClientRect(), y: event.clientY });
    if (laneDraft !== null && laneDraft.velocity === velocity) return;
    laneDraft = { id: lanePress.id, velocity };
    render();
  });

  barsEl.addEventListener('pointerup', (event) => {
    if (lanePress === null || event.pointerId !== lanePress.pointerId) return;
    const done = lanePress;
    const draft = laneDraft;
    lanePress = null;
    laneDraft = null;
    if (barsEl.hasPointerCapture(done.pointerId)) barsEl.releasePointerCapture(done.pointerId);
    if (draft === null) {
      render();
    } else {
      // What was shown is what is written, whatever the pointer did since.
      const result = setVelocity(motif, done.id, draft.velocity);
      if (result.motif === motif && result.notice === '') render();
      else apply(result, { unit: result.note.start, pitch: result.note.pitch });
    }
    flushLive();
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    barsEl.addEventListener(type, (event) => {
      if (lanePress !== null && event.pointerId === lanePress.pointerId) cancelGesture();
    });
  }

  // Left and Right go from note to note in the lane's order; with nothing selected, Right takes the first note and Left the last.
  function selectNote(direction) {
    const order = laneOrder(motif);
    if (order.length === 0) {
      notice = SCRATCH_COPY.noNote;
      render();
      return;
    }
    const here = laneNote();
    const at = here === undefined ? -1 : order.indexOf(here.id);
    const index = at === -1 ? (direction > 0 ? 0 : order.length - 1) : clamp(at + direction, 0, order.length - 1);
    const note = motif.notes.find((candidate) => candidate.id === order[index]);
    selection = new Set([note.id]);
    placeCursor(note.start, note.pitch);
  }

  // The note the lane works on: the only selected note, else the note under the cursor.
  function laneNote() {
    if (selection.size === 1) return motif.notes.find((candidate) => selection.has(candidate.id));
    return noteAt(motif, cursor.pitch, cursor.unit) ?? undefined;
  }

  // Up and Down change the velocity of every selected note by the same step, else of the lane's note; at an end of the range there is
  // nothing to change.
  function changeVelocity(delta) {
    const note = laneNote();
    if (selection.size === 0 && note === undefined) {
      notice = SCRATCH_COPY.noNote;
      render();
      return;
    }
    const ids = selection.size > 0 ? selectedIds() : [note.id];
    const result = setVelocities(motif, ids, delta);
    if (result.motif === motif && result.notice === '') return;
    apply(result, note === undefined ? null : { unit: note.start, pitch: note.pitch });
  }

  laneEl.addEventListener('keydown', (event) => {
    // Select all and select none work from the lane too; the other Ctrl, Cmd and Alt combinations are left alone.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && typeof event.key === 'string' && event.key.toLowerCase() === 'a') {
      if (event.shiftKey) selectNone();
      else selectAll();
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'ArrowLeft':
        selectNote(-1);
        break;
      case 'ArrowRight':
        selectNote(1);
        break;
      case 'ArrowUp':
        changeVelocity(event.shiftKey ? 1 : 5);
        break;
      case 'ArrowDown':
        changeVelocity(event.shiftKey ? -1 : -5);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  // Whether a node is the roll or lies inside it: the piano names, the grid and the notes. The ruler and the information line do not.
  function rollContains(node) {
    return node !== null && node !== undefined && rollEl.contains(node);
  }

  // A right-click inside the roll erases the note under it and opens nothing; on empty space it does nothing. The page's one contextmenu
  // listener calls this for a right-click inside the roll, so the Ask box does not open there. Returns whether the roll took the click.
  function handleContextMenu(event) {
    if (!rollContains(event.target)) return false;
    // A Ctrl+click is a right-click on macOS, and here it adds to the selection: the roll takes the click and erases nothing.
    if (event.ctrlKey || press !== null) return true;
    const { at, cell } = readPoint(event);
    if (cell === null) return true;
    const note = noteAt(motif, cell.pitch, Math.floor(at));
    if (note !== null) apply(eraseNote(motif, note.id));
    return true;
  }

  gridEl.addEventListener('pointerleave', () => {
    if (press === null) setHover(null, null);
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    gridEl.addEventListener(type, (event) => {
      if (press !== null && event.pointerId === press.pointerId) cancelGesture();
    });
  }

  function closed() {
    cancelGesture();
    hasFocus = false;
    hoverId = null;
    hoverCell = null;
    // Tap does not outlast the view; the page is told, and the line is cleared as it always was.
    setTapping(false, null);
    notice = null;
    render();
  }

  render();
  return { render, closed, cancelGesture, handleContextMenu, rollContains, resize, tapOn: () => tapping, motifCycles: () => motif.cycles, setMusicPlaying, setNowUnit, tap, setListening, record, setLive, setSendState, motifResult, setOutputs, setHear, setHearPosition, refreshHear, motif: () => motif };
}
