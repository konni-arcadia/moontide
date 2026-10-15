// DOM view of Moontide's editable Timeline: the note panel under the lanes and the marks on the lanes. A click on a note
// selects it (a ring around the note and the panel under the lanes, which names the note, its pitch, its velocity and whether
// the page can edit it). The keys Up and Down (Shift: an octave), the panel's pitch buttons and its velocity buttons are steps:
// they gather, and a pause after the last one asks the page once, so a run of presses is one change. Delete, Backspace and the
// Make a rest button ask for a rest at once. Dragging the note up or down changes its pitch too: a dashed ghost and a sentence
// show the new pitch while the button is held, and the release asks the page once. A drag that is cancelled (Escape, a pointer
// cancel, a lost capture, a window blur, a redraw or a page turn) writes nothing. Steps that wait for the pause are written for
// their note before the selection moves to another note, a cursor or a range, and before the lanes are drawn again; only Escape
// drops them on purpose, and a drag that takes their place says so in the sentence. Every edit (a burst of steps, a rest, a drag
// release) is one record aimed at its note and waits its turn in one queue: the page has at most one edit at a time, and the
// next goes only after the answer of the one before and the lanes that answer brings, aimed at its note as those lanes draw it.
// An answer is matched to its edit and speaks for that note only; an answer late by a bounded wait is said to be late, and the
// queue goes on after a second bounded wait. A closed Timeline or a page turn empties the queue, but the edit already on its way
// is still written and holds the next one until its answer. A drag across an empty part of a lane, or sideways from a
// note, selects whole cycles of that lane: a wash over them, held inside the page, and on release the page opens the Ask box for
// the range. The wash stays until Escape, a click on empty area, another selection, a redraw or a page turn takes it away, or
// until the request is sent; the panel names the range and offers only Ask Claude. Shift with Left or Right starts a range at the
// selected note's cycle and widens it a cycle a press. Selecting a range writes nothing and sends nothing. The keyboard alone
// does all of it: the lanes are one Tab stop that selects nothing, Left and Right walk the notes of a lane, Home and End go to
// its ends, Page Up and Page Down change lane (a lane with no note on the page gets a cursor, and the panel offers only Ask
// Claude), and the note or cursor that is active is told to screen readers by one element the lanes point at with
// aria-activedescendant. Escape steps back one thing at a time: steps not written (waiting for their pause or behind another
// edit), then a range, then the selection, and only
// with nothing left does it go on to the page, which closes the
// view. When the token plays in several places the standing sentence says so as soon as the page has counted them, the other notes of the token get a dotted ring, and the previews repeat the count. While the page cannot write
// safely the edit controls are off and a notice says why. Everything that comes from the code (a lane name, a section name, a token) reaches
// the page through textContent, title and setAttribute only, and every node is built with createElement. The text is written
// only when it changes, so a panel drawn again for the same state writes nothing. `document` is injected, so the module has no
// DOM access at import time and node:test drives it with a fake document. A gesture whose handler is missing throws, so
// nothing is ignored silently. Reading a note, drawing the panel, the ring and the ghost never write to the editor, evaluate
// or send anything: only a handler does.

import { PAGE_CYCLES, TIMELINE_COPY, cycleAt, noteNameToMidi, pitchOf } from './timeline.js';
import {
  DRAG_THRESHOLD_REM,
  HIT_TOLERANCE_REM,
  LANE_KEYS,
  NOTE_MARK_HEIGHT,
  SEMITONE_REM,
  STEP_GATHER_MS,
  createStepGatherer,
  lockGesture,
  noteBoxes,
  pickNote,
  rangeCycles,
  laneMove,
  semitonesFrom,
} from './timeline-gesture.js';
import { MAX_GESTURE_SEMITONES as MAX_REQUEST_SEMITONES } from './ask.js';
import { stepPitch, velocityTarget } from './note-edit.js';
import { sameTokenEvents } from './note-locate.js';
import {
  activeCursorName,
  activeNoteName,
  changeDroppedText,
  changeNotWrittenText,
  cursorPositionText,
  editTimeoutText,
  hintText,
  limitText,
  namedText,
  noneText,
  noticeText,
  pitchValueText,
  positionText,
  previewText,
  rangePositionText,
  rangeWhereText,
  refusedPreviewText,
  requestReadyText,
  resultText,
  standingText,
  stateWord,
  stepsDroppedText,
  stepsNotWrittenText,
  velocityFixedText,
  velocityLimitText,
  velocityPreviewText,
  velocityRefusalText,
  velocityValueText,
} from './note-panel.js';

/** The reasons an edit is refused after the page read the edited code back, or could not write it: the person can ask Claude for it (an error only when it came before the write). */
const ASK_AGAIN_REASONS = new Set(['read-back', 'write-mismatch', 'not-played', 'no-parser', 'error']);

/**
 * True for an outcome whose change can be handed to Claude as it is: the page wrote nothing. An error that came at or after the
 * write is not one, because the code may already hold the change.
 */
function askable(outcome) {
  if (outcome.kind === 'failed') return true;
  return outcome.kind === 'refused' && ASK_AGAIN_REASONS.has(outcome.reason) && outcome.afterWrite !== true;
}

/** True for the two keyboard gestures that mean a right-click: the Menu key, and F10 with Shift (and no other modifier). */
function isAskKey(event) {
  if (event.altKey || event.metaKey || event.ctrlKey) return false;
  if (event.key === 'ContextMenu') return !event.shiftKey;
  return event.key === 'F10' && event.shiftKey === true;
}

/** The id of the one element the lanes point at with aria-activedescendant. */
const ACTIVE_ID = 'timeline-active-note';

/** How long the page has to answer an edit, and then to draw the lanes again from the code it wrote, before the queue goes on. */
const EDIT_WAIT_MS = 10000;

/** The notices the page can give the view, with the words of the notice each one shows (the Mixer's order). */
const NOTICE_KINDS = Object.freeze({ closed: 'disconnected', waiting: 'waiting', dirty: 'unevaluated' });

/**
 * `createTimelineEditView({ document, lanes, panel, line, rootFontPx, setTimer, clearTimer, handlers })` returns `{ onRedraw(drawn),
 * showOutcome(id, outcome), setNotice(kind), finishWait({ tookOver }), close(), cancelGesture(), selection() }`. `lanes`
 * is the element that holds the lanes, `panel` the section under them and `line` the sentence slot inside it. `rootFontPx()`
 * gives the root font size in pixels, read when a press starts, because every distance of a gesture is written in rem.
 * `setTimer(fn, ms)` and `clearTimer(handle)` are the page's timers, which time the pause that gathers steps and the wait for
 * an answer. `handlers` is `{ describe(laneIndex, eventIndex), edit(info, change, id) }`: `describe` gives what the page knows of a note (`{ laneIndex,
 * eventIndex, track, cycle, beat, section, noteText, midi, drum, velocity, velocityWritable, editable, reason, seen, places,
 * perCycle, velocityPlaces }`, where `places` is a promise or a value of `{ count, sections, onPage }` for a token of a structured piece, null
 * otherwise (`velocityPlaces` is the same for the velocity number of a note whose velocity the page can write), and `perCycle` the number of notes the token draws in each cycle in a piece without a structure) and
 * `edit` is called with that note, a change (`{ kind: 'pitch', semitones }`, `{ kind: 'rest' }` or `{ kind: 'velocity',
 * steps }`) and the id of the edit, for a note that can be edited, one edit at a time. `showOutcome(id, outcome)` gives the answer
 * of the edit with that id; an id the view never handed over, or one already answered, throws. `setNotice(kind)` says the page cannot write safely (`'closed'`, `'waiting'`,
 * `'dirty'`, or null for none): the edit controls are off and one sentence says why, only while the kind changes.
 * An outcome that waits for its line (`showOutcome`) keeps the edit controls off, with the edit's own sentence, until
 * `finishWait({ tookOver })` ends the wait; the sentence then says the change was made when it took over. `onRedraw(drawn)` tells the view what the lanes were drawn from (`{ pageStart, lanes: [{ index, identity, events,
 * shapes, rowCount, drumMap }] }`, each event with the `locations` it comes from in the code) or null when no lanes are drawn.
 * It ends a gesture in progress, and it selects the same note again when the lanes come back for the same page with a note at
 * the same time on the same lane (by its identity, or its track index when the identity was built from strings), at the same
 * rank among the notes that begin then (in the order of their places in the code), whose pitch is the one it has or the one an
 * edit on its way asked for; any other page, or no such note, leaves nothing selected. After a rest, a note of the same chord is
 * looked for at the rank the lanes drawn from the code the rest left give it, and not at all when the page cannot tell (those
 * lanes do not show the chord without the rested note, or the rest did not take over, or ended in an error or no answer). `showOutcome` puts the sentence of the outcome of an edit in the
 * sentence slot, where it stays through redraws until the next selection; when the selection has moved on from the edit's note,
 * the sentence names that note. `close()` says the Timeline closed: steps and edits not handed over yet are dropped, and nothing is
 * handed over until lanes are drawn again; the edit already handed over is still the page's to finish. `cancelGesture()` ends a gesture in progress with no
 * write (the page calls it when the window loses focus). The drawn lanes also carry `track` (the name the lane shows), which names
 * the lane in the panel and to screen readers when the keyboard cursor is on it. The handler `askLane(laneIndex, cycle, point)`
 * opens the Ask box for the lane under the keyboard cursor.
 */
export function createTimelineEditView({ document, lanes, panel, line, rootFontPx, setTimer, clearTimer, handlers }) {
  for (const [name, element] of Object.entries({ lanes, panel, line })) {
    if (!element) throw new Error(`Moontide: the Timeline edit view needs its '${name}' element.`);
  }
  if (typeof rootFontPx !== 'function') throw new Error('Moontide: the Timeline edit view needs rootFontPx, a function that gives the root font size.');
  for (const [name, timer] of Object.entries({ setTimer, clearTimer })) {
    if (typeof timer !== 'function') throw new Error(`Moontide: the Timeline edit view needs ${name}, a function.`);
  }
  for (const gesture of ['describe', 'edit', 'prepare', 'ask', 'range', 'describeRange', 'askLane']) {
    if (handlers === null || typeof handlers !== 'object' || typeof handlers[gesture] !== 'function') {
      throw new Error(`Moontide: the Timeline edit view has no handler for '${gesture}'.`);
    }
  }
  if (line.parentNode !== panel) throw new Error('Moontide: the sentence slot of the Timeline edit view must sit inside its panel.');

  let drawn = null;
  // The mark layer of each drawn lane, by position.
  let marks = [];
  // The note that is selected (`{ laneIndex, eventIndex, info, target, places }`): `target` is the note as edits aim at it and as a
  // redraw finds it again (see targetOf); `places` is where its token plays once the page has counted that (`{ count, sections,
  // onPage }`), null until then.
  let selected = null;
  let ring = null;
  // The dotted rings of the other notes that carry the selected note's token, in the mark layers of the lane.
  let sames = [];
  // The target of the selection when the lanes went away, kept until the lanes come back: a redraw that finds that note selects
  // it again.
  let restore = null;
  // The sentence of the last edit (`{ text, kind }`), kept until the next selection. A sentence of an edit that waits for its
  // line also holds that outcome (`wait`), so it can say the change was made when the line takes over.
  let result = null;
  // The notice that switches the edit controls off (null, 'closed', 'waiting' or 'dirty') and whether the person's own edit
  // waits for its line; both are told by the page.
  let notice = null;
  let ownWait = false;
  // Steps of a key or a button that wait for the pause: the sentence that shows them, and the selection they were taken on.
  let stepSaid = null;
  let stepOwner = null;
  // The press that is on its way to a click or a gesture: where it began, the geometry it is judged against, the note it began
  // on (an event index, or null), the gesture it locked into (null, 'pitch' or 'range') and, for a pitch drag, the drag itself.
  let press = null;
  // The edits that wait their turn, oldest first: each `{ id, target, change, steps }`, where `steps` says it gathers steps of a
  // key or a button (a rest and a drag release are not steps). An edit is aimed at its target, not at the lanes it was made on.
  let queue = [];
  // The one edit handed to the page and not settled yet: `{ edit, phase, timer, lanesAway, freshLanes }`. `phase` is 'answer'
  // (no outcome yet), 'late' (no outcome in time: the panel said so, and the page may still write it), 'waiting' (the change
  // waits for its line) or 'lanes' (written, its lanes not drawn yet); `timer` bounds each phase; `lanesAway` and `freshLanes`
  // say the lanes went away and came back since it was handed over. It stays through a close and a page turn: the page still
  // runs it, and the next edit is aimed at the code it leaves.
  let inFlight = null;
  // Every edit handed over whose outcome has not come, by id: an outcome that comes after its wait ended is still told.
  const handed = new Map();
  // The sentence of a burst of steps that waits in the queue behind another edit (`{ edit, said }`): it stays on screen for its
  // note until the edit is handed over.
  let queuedSaid = null;
  let nextEditId = 1;
  // The edit whose change waits for its line (its outcome said 'waiting'), until the wait ends: its note has the new pitch only
  // once the change takes over.
  let waited = null;
  // The rest on its way, until the page knows where the other notes of its chord are (`{ edit, target, place, before, members }`):
  // `before` is the chord as it was drawn when the rest was handed over (see chordOf), `place` the code place of the rested token,
  // and `members` the targets of the other notes of the chord whose ranks were counted on that chord. Their ranks change only
  // once the lanes drawn after the rest show what it removed (see resolveRest).
  let pendingRest = null;
  // While above 0, an edit added to the queue is not handed over yet (a redraw is under way and its lanes come first).
  let pumpHeld = 0;
  // True from the Timeline's close until lanes are drawn again: nothing is handed over meanwhile.
  let closed = false;
  // The page the lanes were last drawn for: a redraw for another page is a page turn, which empties the queue.
  let shownPage = null;
  // The sentence of a drag in progress (`{ text, kind }`); it takes the place of the others while the drag lasts.
  let preview = null;
  // The change of the selected note that the page refused or could not evaluate (`{ target, change }`): Ask Claude prepares that
  // change as a request until the next gesture or selection.
  let askAgain = null;
  // The range of cycles that is selected (`{ laneIndex, from, to, cut, wash, anchor, head, info }`): whole cycles of one lane, drawn
  // as `wash`, a span in that lane's mark layer. `cut` is null or `{ from, to }` when the pointer left the event area and the range
  // was held at the page's edge. `anchor` is the cycle the range began at and `head` the cycle its other end follows (the keys move
  // the head); `info` is what the page says of it (`{ track, section, sectionTo, count }`), shown in the panel. A range drag in
  // progress holds its own range in `press.range` until it is released. A range and a selected note never exist together.
  let range = null;
  // The keyboard cursor on a lane that has no note on the page (`{ laneIndex, cycle }`), or null. It is a place to stand, not a
  // selection: the panel names the lane and offers only Ask Claude, and Shift+Left or Shift+Right starts a range from its cycle.
  // A cursor, a selected note and a range never exist together.
  let cursor = null;
  // The one element the lanes point at with aria-activedescendant: it names the selected note or the cursor for screen readers.
  let active = null;

  function make(tag, className) {
    const node = document.createElement(tag);
    if (className !== '') node.className = className;
    return node;
  }
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }
  function setAttr(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  function setHidden(node, hidden) {
    if (node.hidden !== hidden) node.hidden = hidden;
  }
  function setOff(node, off) {
    if (off) setAttr(node, 'aria-disabled', 'true');
    else if (node.getAttribute('aria-disabled') !== null) node.removeAttribute('aria-disabled');
  }
  /** True while a notice or the person's own waiting edit keeps the edit controls off. */
  function controlsOff() {
    return notice !== null || ownWait;
  }
  function button(className, text, name, title, onClick) {
    const node = make('button', className);
    node.setAttribute('type', 'button');
    node.textContent = text;
    node.setAttribute('aria-label', name);
    node.setAttribute('title', title);
    node.addEventListener('click', onClick);
    return node;
  }

  // The panel: where the note is and whether it can be edited, the pitch and velocity with their buttons, the sentence
  // slot (given) and the hint. Built once; render() only changes text.
  const where = make('span', 'tl-note-where');
  const laneName = make('span', 'tl-lane-name');
  const position = make('span', 'tl-note-position');
  where.appendChild(laneName);
  where.appendChild(position);
  const state = make('span', 'tl-note-state');
  const controls = make('div', 'tl-note-controls');
  const pitchGroup = make('div', 'tl-group');
  pitchGroup.setAttribute('role', 'group');
  pitchGroup.setAttribute('aria-label', TIMELINE_COPY.notePitchLabel);
  const pitchLabel = make('span', 'tl-label');
  pitchLabel.textContent = TIMELINE_COPY.notePitchLabel;
  const pitchValue = make('span', 'tl-value');
  pitchGroup.appendChild(pitchLabel);
  pitchGroup.appendChild(pitchValue);
  const pitchDown = button('tl-btn', TIMELINE_COPY.notePitchDown, TIMELINE_COPY.notePitchDownName, TIMELINE_COPY.notePitchDownTitle, () => pitchStep(-1));
  const pitchUp = button('tl-btn', TIMELINE_COPY.notePitchUp, TIMELINE_COPY.notePitchUpName, TIMELINE_COPY.notePitchUpTitle, () => pitchStep(1));
  pitchGroup.appendChild(pitchDown);
  pitchGroup.appendChild(pitchUp);
  const velocityGroup = make('div', 'tl-group');
  velocityGroup.setAttribute('role', 'group');
  velocityGroup.setAttribute('aria-label', TIMELINE_COPY.noteVelocityLabel);
  const velocityLabel = make('span', 'tl-label');
  velocityLabel.textContent = TIMELINE_COPY.noteVelocityLabel;
  const velocityValue = make('span', 'tl-value');
  // The words after the velocity when the page cannot write it: it comes from something other than one number in the code.
  const velocityFixed = make('span', 'tl-fixed');
  const velocityDown = button('tl-btn', TIMELINE_COPY.noteVelocityDown, TIMELINE_COPY.noteVelocityDownName, TIMELINE_COPY.noteVelocityDownTitle, () => velocityStepBy(-1));
  const velocityUp = button('tl-btn', TIMELINE_COPY.noteVelocityUp, TIMELINE_COPY.noteVelocityUpName, TIMELINE_COPY.noteVelocityUpTitle, () => velocityStepBy(1));
  velocityGroup.appendChild(velocityLabel);
  velocityGroup.appendChild(velocityValue);
  velocityGroup.appendChild(velocityFixed);
  velocityGroup.appendChild(velocityDown);
  velocityGroup.appendChild(velocityUp);
  const restButton = button('tl-btn', TIMELINE_COPY.noteMakeRest, TIMELINE_COPY.noteMakeRestName, TIMELINE_COPY.noteMakeRestTitle, () => rest());
  // Ask Claude is always on: it writes nothing, so no notice switches it off.
  const askButton = button('tl-btn', TIMELINE_COPY.noteAsk, TIMELINE_COPY.noteAskName, TIMELINE_COPY.noteAskTitle, () => askAbout());
  controls.appendChild(pitchGroup);
  controls.appendChild(velocityGroup);
  controls.appendChild(restButton);
  controls.appendChild(askButton);
  const hint = make('p', 'tl-note-hint');
  panel.insertBefore(where, line);
  panel.insertBefore(state, line);
  panel.insertBefore(controls, line);
  panel.appendChild(hint);

  function render() {
    setHidden(panel, drawn === null);
    const info = selected === null ? null : selected.info;
    // A range names itself where a note would: the lane, then the cycles, the section and the notes.
    const rangeName = range === null ? null : rangeWhereText(range.info.track);
    // The cursor on a lane without notes names the lane as the lane shows it.
    const name = rangeName !== null ? rangeName : cursor !== null ? drawn.lanes[cursor.laneIndex].track : info === null ? '' : info.track;
    setText(laneName, name);
    setAttr(laneName, 'title', name);
    setText(position, range !== null ? rangePositionText({ from: range.from, to: range.to, ...range.info }) : cursor !== null ? cursorPositionText() : info === null ? noneText() : positionText(info));
    setText(state, info === null ? '' : stateWord(info));
    setHidden(controls, info === null && range === null && cursor === null);
    // A range and a lane without notes offer only Ask Claude; every control that changes a note is away.
    for (const group of [pitchGroup, velocityGroup, restButton]) setHidden(group, range !== null || cursor !== null);
    setAttr(askButton, 'aria-label', range !== null ? TIMELINE_COPY.noteRangeAskName : cursor !== null ? TIMELINE_COPY.noteLaneAskName : TIMELINE_COPY.noteAskName);
    setAttr(askButton, 'title', range !== null ? TIMELINE_COPY.noteRangeAskTitle : cursor !== null ? TIMELINE_COPY.noteLaneAskTitle : TIMELINE_COPY.noteAskTitle);
    setText(pitchValue, info === null ? '' : pitchValueText(info));
    setText(velocityValue, info === null ? '' : velocityValueText(info.velocity));
    const editable = info !== null && info.editable;
    // The edit controls keep their words and their place and carry aria-disabled while the page could not write safely, and the
    // velocity ones while the velocity is not one number in the code. A note the page cannot edit keeps them on.
    const off = editable && controlsOff();
    const velocityOff = off || (editable && info.velocityWritable !== true);
    setOff(pitchDown, off);
    setOff(pitchUp, off);
    setOff(restButton, off);
    setOff(velocityDown, velocityOff);
    setOff(velocityUp, velocityOff);
    setText(velocityFixed, editable && info.velocityWritable !== true ? velocityFixedText() : '');
    let said = null;
    if (range !== null) said = null;
    else if (editable && notice !== null) {
      // Steps this notice took away are named beside it, so they are not just gone; steps lost to an earlier move are not.
      const lost = result !== null && result.lostTo === notice ? ` ${result.text}` : '';
      said = { kind: 'notice', text: `${noticeText(NOTICE_KINDS[notice])}${lost}` };
    }
    else if (preview !== null) said = preview;
    else if (stepSaid !== null) said = stepSaid;
    else if (queuedSaid !== null && queue.includes(queuedSaid.edit) && aboutShown(queuedSaid.edit)) said = queuedSaid.said;
    else if (result !== null) said = result;
    else if (info !== null) said = { kind: 'standing', text: standingText(info, selected.places) };
    setText(line, said === null ? '' : said.text);
    if (said === null) {
      if (line.getAttribute('data-kind') !== null) line.removeAttribute('data-kind');
    } else {
      setAttr(line, 'data-kind', said.kind);
    }
    setText(hint, hintText(range !== null ? 'range' : cursor !== null ? 'cursor' : info === null ? 'none' : info.editable ? 'editable' : 'refused'));
  }

  /** Where the note is drawn in its lane's mark layer, as shares of the lane: `{ left, width, top, height }`. */
  function markBox(laneIndex, eventIndex) {
    const lane = drawn.lanes[laneIndex];
    const shape = lane.shapes[eventIndex];
    let top;
    let height;
    if (lane.rowCount === null) {
      top = Math.max(0, Math.min(1 - NOTE_MARK_HEIGHT, shape.y - NOTE_MARK_HEIGHT / 2));
      height = NOTE_MARK_HEIGHT;
    } else {
      top = (shape.row + 0.25) / lane.rowCount;
      height = 0.5 / lane.rowCount;
    }
    return { left: shape.x / PAGE_CYCLES, width: shape.width / PAGE_CYCLES, top, height };
  }

  function placeMark(node, box) {
    node.style.left = `${box.left * 100}%`;
    node.style.width = `${box.width * 100}%`;
    node.style.top = `${box.top * 100}%`;
    node.style.height = `${box.height * 100}%`;
  }

  /**
   * Makes the one element the lanes point at: a new one in the lane of the selected note or of the cursor (not in the mark layer,
   * which screen readers skip), named for a screen reader, and puts its id in aria-activedescendant. With neither a note nor a
   * cursor there is no element and no attribute. The element is drawn again on every selection and every redraw.
   */
  function drawActive() {
    let laneIndex;
    let name;
    if (selected !== null) {
      laneIndex = selected.laneIndex;
      name = activeNoteName(selected.info);
    } else if (cursor !== null) {
      laneIndex = cursor.laneIndex;
      name = activeCursorName({ lane: drawn.lanes[laneIndex].track, cycle: cursor.cycle });
    } else {
      if (active !== null) {
        active.remove();
        active = null;
      }
      removeAttr(lanes, 'aria-activedescendant');
      return;
    }
    // The same note again keeps its element, so picking it twice writes nothing.
    if (active !== null && active.parentNode === lanes.children[laneIndex] && active.getAttribute('aria-label') === name) return;
    if (active !== null) active.remove();
    active = make('div', 'tl-active');
    active.id = ACTIVE_ID;
    active.setAttribute('role', 'img');
    active.setAttribute('aria-label', name);
    lanes.children[laneIndex].appendChild(active);
    setAttr(lanes, 'aria-activedescendant', ACTIVE_ID);
  }

  /** Draws the ring around the selected note, in the mark layer of its lane, at the place the note is drawn. */
  function drawRing() {
    if (ring !== null) {
      ring.remove();
      ring = null;
    }
    for (const mark of sames) mark.remove();
    sames = [];
    drawActive();
    if (selected === null) return;
    ring = make('span', 'tl-ring');
    placeMark(ring, markBox(selected.laneIndex, selected.eventIndex));
    marks[selected.laneIndex].appendChild(ring);
    // The other notes of the page that carry the same token get a dotted ring: an edit changes them too. A note the page
    // cannot edit has no token to share.
    if (!selected.info.editable) return;
    for (const index of sameTokenEvents({ events: drawn.lanes[selected.laneIndex].events, token: selected.info.seen.token })) {
      if (index === selected.eventIndex) continue;
      const mark = make('span', 'tl-same');
      placeMark(mark, markBox(selected.laneIndex, index));
      marks[selected.laneIndex].appendChild(mark);
      sames.push(mark);
    }
  }

  /** The places in the code an event's value comes from, as their start offsets, the first first. */
  function codePlaces(entry) {
    if (!Array.isArray(entry.locations)) return [];
    return entry.locations.map((place) => place.start).filter((start) => Number.isFinite(start)).sort((a, b) => a - b);
  }

  /**
   * The events of `lane` that begin at `begin`, as event indexes in the order of their places in the code (then in the order the
   * lane lists them). An edit rewrites one token and moves every later offset by the same amount, so it never changes this order:
   * a note keeps its rank among the notes that begin with it through any edit of a token.
   */
  function notesAt(lane, begin) {
    const indexes = [];
    lane.events.forEach((entry, index) => {
      if (Math.abs(entry.begin - begin) < 1e-9) indexes.push(index);
    });
    const places = new Map(indexes.map((index) => [index, codePlaces(lane.events[index])]));
    return indexes.sort((i, j) => {
      const a = places.get(i);
      const b = places.get(j);
      for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return a[k] - b[k];
      return a.length - b.length || i - j;
    });
  }

  /** True when two pitches (numbers, or null for an event that has none) are the same. */
  function samePitch(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    return Math.abs(a - b) < 1e-6;
  }

  /**
   * The note at (`laneIndex`, `eventIndex`) as an edit aims at it and a redraw finds it again: its lane (`laneIdentity` for a lane
   * written with a name, `trackIndex` for any other, see sameLane), the time it begins at, the page, its
   * `rank` among the notes that begin with it on its lane (see notesAt), and its token and lane as the panel names them. The
   * pitch is only a check: `pitch` is the pitch the note has as far as the page knows (the one it had, or the one an edit of it
   * wrote), `asked` the pitch an edit on its way may give it (null when none is on its way), and `gone` says the page aims at it no
   * more: a rest took it away, or a rest beside it in its chord left the page unsure which note it is. A note taken beside a rest
   * on its way, on lanes that still draw the chord as the rest found it, has its rank counted on that chord like the others.
   */
  function targetOf(laneIndex, eventIndex, info) {
    const lane = drawn.lanes[laneIndex];
    const entry = lane.events[eventIndex];
    const note = info.editable && info.seen !== null && info.seen !== undefined ? info.seen.token.text : String(info.noteText);
    const rank = notesAt(lane, entry.begin).indexOf(eventIndex);
    const target = { laneIdentity: lane.identity, trackIndex: lane.index, begin: entry.begin, pageStart: drawn.pageStart, rank, pitch: pitchOf(entry.value), asked: null, gone: false, note, lane: info.track };
    if (pendingRest !== null && beside(target, pendingRest.target) && sameChord(chordOf(lane, entry.begin), pendingRest.before)) pendingRest.members.add(target);
    return target;
  }

  /** True for the identity of a lane written with a name (`name: ...`), which no edit of a token changes. */
  function labeled(identity) {
    return typeof identity === 'string' && identity.startsWith('label:');
  }

  /**
   * True when two targets are on the same lane: by the name for a lane written with one, by the track index for any other (an
   * identity built from the strings of the code changes with every edit, while an edit of a token never adds, removes or moves a
   * statement).
   */
  function sameLane(a, b) {
    if (labeled(a.laneIdentity) || labeled(b.laneIdentity)) return a.laneIdentity === b.laneIdentity;
    return a.trackIndex !== undefined && a.trackIndex === b.trackIndex;
  }

  /** The index of the drawn lane of `target`, found the way sameLane compares lanes, or -1. */
  function laneOf(target) {
    if (labeled(target.laneIdentity)) return drawn.lanes.findIndex((lane) => lane.identity === target.laneIdentity);
    if (target.trackIndex === undefined) return -1;
    return drawn.lanes.findIndex((lane) => lane.index === target.trackIndex && !labeled(lane.identity));
  }

  /**
   * Where `target` is in the lanes drawn now, `{ laneIndex, eventIndex }`, or null: another page, no note at its rank, or a note
   * there whose pitch is neither the one it has nor the one an edit on its way asked for (that note is another one, so nothing is
   * aimed at it).
   */
  function findNote(target) {
    if (drawn === null || drawn.pageStart !== target.pageStart || target.gone) return null;
    const laneIndex = laneOf(target);
    if (laneIndex === -1) return null;
    const lane = drawn.lanes[laneIndex];
    // A note beside a rest on its way has its rank counted on its chord as it was before the rest: it is found only on lanes that
    // still draw that chord, until the lanes after the rest tell where it went.
    if (pendingRest !== null && pendingRest.members.has(target) && !sameChord(chordOf(lane, target.begin), pendingRest.before)) return null;
    const eventIndex = notesAt(lane, target.begin)[target.rank];
    if (eventIndex === undefined) return null;
    const pitch = pitchOf(lane.events[eventIndex].value);
    if (!samePitch(pitch, target.pitch) && (target.asked === null || !samePitch(pitch, target.asked))) return null;
    return { laneIndex, eventIndex };
  }

  /**
   * Every note target the view holds: the selection, the one a redraw brings back, the edits that wait or are on their way and
   * the steps that wait for the pause.
   */
  function liveTargets() {
    const targets = new Set(queue.map((edit) => edit.target));
    for (const edit of handed.values()) targets.add(edit.target);
    if (inFlight !== null) targets.add(inFlight.edit.target);
    for (const choice of [selected, stepOwner]) if (choice !== null) targets.add(choice.target);
    if (restore !== null) targets.add(restore);
    if (waited !== null) targets.add(waited.target);
    return targets;
  }

  /** The notes of `lane` that begin at `begin`, in the order of notesAt, as `{ pitch, places }`: a chord as a rest compares it. */
  function chordOf(lane, begin) {
    return notesAt(lane, begin).map((index) => ({ pitch: pitchOf(lane.events[index].value), places: codePlaces(lane.events[index]) }));
  }

  /** True when two chords (see chordOf) have the same notes, with the same pitches, at the same places in the code. */
  function sameChord(a, b) {
    if (a.length !== b.length) return false;
    return a.every((note, k) => samePitch(note.pitch, b[k].pitch) && note.places.length === b[k].places.length && note.places.every((place, i) => place === b[k].places[i]));
  }

  /** True when `target` is another note that begins with the note of `rested`, on the same lane of the same page. */
  function beside(target, rested) {
    return target !== rested && !target.gone && target.pageStart === rested.pageStart && Math.abs(target.begin - rested.begin) < 1e-9 && sameLane(target, rested);
  }

  /**
   * The new ranks of the notes beside the rest `rest`, read from the lanes drawn now, as a map from each old rank to the new one,
   * or null when those lanes do not show exactly the chord without the rested note: every note that held the rested token's place
   * (the note and any copy of it) is gone, every other note is there with its pitch and in the same order, the places before the
   * token have not moved and the places after it have all moved by the same amount.
   */
  function ranksAfterRest(rest) {
    if (drawn === null || drawn.pageStart !== rest.target.pageStart || rest.place === undefined) return null;
    const laneIndex = laneOf(rest.target);
    if (laneIndex === -1) return null;
    const after = chordOf(drawn.lanes[laneIndex], rest.target.begin);
    const kept = [];
    rest.before.forEach((note, rank) => {
      if (!note.places.includes(rest.place)) kept.push(rank);
    });
    if (kept.length === rest.before.length || after.length !== kept.length) return null;
    let shift = null;
    const ranks = new Map();
    for (let j = 0; j < kept.length; j++) {
      const was = rest.before[kept[j]];
      const now = after[j];
      if (!samePitch(was.pitch, now.pitch) || was.places.length !== now.places.length) return null;
      for (let k = 0; k < was.places.length; k++) {
        const moved = now.places[k] - was.places[k];
        if (was.places[k] < rest.place) {
          if (moved !== 0) return null;
        } else if (shift === null) {
          shift = moved;
        } else if (moved !== shift) {
          return null;
        }
      }
      ranks.set(kept[j], j);
    }
    return ranks;
  }

  /**
   * The rest on its way is settled, `how`: 'unwritten' (the page wrote nothing: the notes beside it keep their ranks), 'lanes' (it
   * was written, and the lanes drawn now come from the code it left: each note beside it takes the rank they give it) or 'unsure'
   * (the change did not take over, an error came at or after the write, or no answer came). When the page cannot tell where a note
   * beside the rest went, it aims at it no more: its edits that wait are dropped, and the panel says they were not written (see
   * sayAlso), each named after its note.
   */
  function resolveRest(how) {
    const rest = pendingRest;
    pendingRest = null;
    if (rest === null || how === 'unwritten') return;
    const ranks = how === 'lanes' ? ranksAfterRest(rest) : null;
    for (const member of rest.members) {
      if (member.gone) continue;
      const rank = ranks === null ? undefined : ranks.get(member.rank);
      if (rank === undefined) {
        member.gone = true;
        member.asked = null;
      } else {
        member.rank = rank;
      }
    }
    const lost = queue.filter((edit) => edit.target.gone);
    if (lost.length === 0) return;
    queue = queue.filter((edit) => !edit.target.gone);
    sayAlso(notWrittenText(lost));
  }

  /**
   * Puts `text`, a sentence of edits that were not written, after the sentence of the last edit (or alone when there is none). A
   * sentence of a change that waits for its line keeps it when the wait ends.
   */
  function sayAlso(text) {
    if (text === '') return;
    if (result === null) {
      result = { kind: 'refused', text };
      return;
    }
    const kept = result.wait === undefined ? {} : { lostText: result.lostText === undefined ? text : `${result.lostText} ${text}` };
    result = { ...result, kind: 'refused', text: `${result.text} ${text}`, ...kept };
  }

  /**
   * The lanes drawn after an edit whose outcome left its pitch open (an error at or after the write): the note at the target's rank
   * says which pitch it has, the asked one or the old one.
   */
  function resolveAsked(target) {
    if (target.asked === null) return;
    const asked = target.asked;
    target.asked = null;
    const found = findNote({ ...target, pitch: asked });
    if (found !== null) target.pitch = asked;
  }

  /** The pitch an outcome says was written, as a number, or null when it names none. */
  function writtenPitch(outcome) {
    const to = String(outcome.to);
    return /^-?\d+(\.\d+)?$/.test(to) ? Number(to) : noteNameToMidi(to);
  }

  /** The target of an edit in the queue or on its way that is the note at (`laneIndex`, `eventIndex`), so its answer speaks for the selection again. */
  function queuedTarget(laneIndex, eventIndex) {
    const targets = queue.map((edit) => edit.target);
    if (inFlight !== null) targets.push(inFlight.edit.target);
    return (
      targets.find((target) => {
        const found = findNote(target);
        return found !== null && found.laneIndex === laneIndex && found.eventIndex === eventIndex;
      }) ?? null
    );
  }

  /**
   * What the page knows of the note at (`laneIndex`, `eventIndex`) as a selection. Where its token plays is counted by the page,
   * perhaps after a moment: the sentence and the previews learn it when it arrives, if the note is still the one selected.
   */
  function choose(laneIndex, eventIndex, target = null) {
    const info = handlers.describe(laneIndex, eventIndex);
    const aim = target ?? queuedTarget(laneIndex, eventIndex) ?? targetOf(laneIndex, eventIndex, info);
    const choice = { laneIndex, eventIndex, info, target: aim, places: null, velocityPlaces: null };
    // Where the pitch token plays, and where the velocity token plays: each is a promise or a value, and each arrives on its own.
    for (const [field, counting] of [['places', info.places], ['velocityPlaces', info.velocityPlaces]]) {
      if (counting !== undefined && counting !== null && typeof counting.then === 'function') {
        counting.then(
          (told) => {
            choice[field] = told;
            if (selected !== choice) return;
            // Words already on screen that leave out the count are written again with it.
            if (gatherer.pending() !== null && stepOwner === choice) stepSaid = stepsSentence(gatherer.pending().kind, gatherer.pending().total);
            if (press !== null && press.drag !== null && press.drag !== undefined && press.drag.info === info) showDrag(press.drag);
            else render();
          },
          (error) => {
            console.error('Moontide: the places of the selected token could not be counted:', error);
          },
        );
      } else if (counting !== undefined && counting !== null) {
        choice[field] = counting;
      }
    }
    return choice;
  }

  /** The count a preview or a result repeats for the selection: `{ count, onPage }`, a count of 0 or 1 says nothing. */
  function placesOfSelection() {
    if (selected === null) return { count: 0, onPage: false };
    if (selected.places !== null) return { count: selected.places.count, onPage: selected.places.onPage === true };
    const perCycle = selected.info.perCycle;
    return { count: typeof perCycle === 'number' ? perCycle : 0, onPage: false };
  }

  /** Where the velocity number of the selected note plays once the page has counted it: `{ count, onPage }`, a count of 0 or 1 says nothing. */
  function velocityPlacesOfSelection() {
    if (selected === null || selected.velocityPlaces === null) return { count: 0, onPage: false };
    return { count: selected.velocityPlaces.count, onPage: selected.velocityPlaces.onPage === true };
  }

  /** How many notes of the page share the written number that holds the velocity of the selected note (1 when it is its own). */
  function velocityNotes() {
    const velocity = selected.info.seen === null || selected.info.seen === undefined ? undefined : selected.info.seen.velocity;
    if (velocity === undefined || velocity === null || velocity.writable !== true) return 0;
    return sameTokenEvents({ events: drawn.lanes[selected.laneIndex].events, token: velocity.token }).length;
  }

  /**
   * Steps the person pressed on the selected note are written for that note before the selection moves away from it or the lanes
   * are drawn again: the pause is cut short and they join the queue, never forgotten. Steps that cannot be written (the controls
   * are off, or the note cannot be edited) are dropped. Gives true when steps were dropped, so the caller says so where the
   * selection's sentence would go.
   */
  function leaveNote() {
    if (gatherer.pending() === null) return false;
    if (stepOwner !== null && stepOwner.info.editable && !controlsOff()) {
      gatherer.flush();
      return false;
    }
    gatherer.drop();
    stepOwner = null;
    stepSaid = null;
    return true;
  }

  /** The sentence of steps that were not written because the page could not write them when the person moved on. */
  function lostStepsResult() {
    return { kind: 'refused', text: stepsNotWrittenText(), lost: true };
  }

  function select(laneIndex, eventIndex) {
    // Picking the note that is selected again keeps what an edit of it will look for, unless the page aims at that no more.
    const again = selected !== null && selected.laneIndex === laneIndex && selected.eventIndex === eventIndex && !selected.target.gone ? selected : null;
    // Steps that waited were aimed at the note that was shown: they are written for it now.
    const lost = leaveNote();
    stepOwner = null;
    stepSaid = null;
    askAgain = null;
    // A new selection replaces a range and the cursor.
    dropRange();
    cursor = null;
    selected = choose(laneIndex, eventIndex, again === null ? null : again.target);
    result = lost ? lostStepsResult() : null;
    render();
    drawRing();
  }

  function clearSelection() {
    if (selected === null && cursor === null) return;
    const lost = leaveNote();
    stepOwner = null;
    stepSaid = null;
    askAgain = null;
    selected = null;
    cursor = null;
    result = lost ? lostStepsResult() : null;
    render();
    drawRing();
  }

  /** Puts the keyboard cursor on a lane that has no note on the page, at `cycle`; the selected note and any range go. */
  function placeCursor(laneIndex, cycle) {
    const lost = leaveNote();
    stepOwner = null;
    stepSaid = null;
    askAgain = null;
    dropRange();
    selected = null;
    cursor = { laneIndex, cycle };
    result = lost ? lostStepsResult() : null;
    render();
    drawRing();
  }

  /** The middle of the selected note's mark on the page, in pixels: where a request prepared by a key or a button opens the box. */
  function notePoint() {
    const svg = lanes.children[selected.laneIndex].querySelector('svg.lane-events');
    const rect = svg.getBoundingClientRect();
    const box = markBox(selected.laneIndex, selected.eventIndex);
    return { x: rect.left + (box.left + box.width / 2) * rect.width, y: rect.top + (box.top + box.height / 2) * rect.height };
  }

  /**
   * Asks the page to put the ready-made request for `change` of the selected note in the Ask box, opened at `at` (the note's
   * middle when none is given). Nothing is written and nothing is sent: only the person's Enter in the box sends. The sentence says
   * so once the box is open.
   */
  function prepareRequest(info, change, at) {
    dropSteps();
    askAgain = null;
    const opened = handlers.prepare(info, change, at === undefined ? notePoint() : at);
    // The page opened nothing (the overlay shows, or the note could not be described): it has said why where it says such things.
    if (opened === false) return;
    result = { kind: 'result', text: requestReadyText() };
    render();
  }

  /**
   * Ask Claude about the selected note: the box opens at the note with the note's lane and moment and an empty field. After an
   * edit that was refused at the read-back or did not evaluate, the same change is prepared as a ready-made request instead,
   * until the next gesture or selection.
   */
  function askAbout() {
    if (range !== null) {
      askRange();
      return;
    }
    if (cursor !== null) {
      askLane();
      return;
    }
    if (selected === null) return;
    const at = notePoint();
    if (askAgain !== null && askAgain.target === selected.target) {
      // A request is not a gesture on the note: it stays on offer until the person acts on the note or picks another.
      const again = askAgain;
      prepareRequest(selected.info, again.change, at);
      askAgain = again;
      return;
    }
    handlers.ask(selected.info, at);
  }

  /** The middle of the lane under the keyboard cursor, at its cycle, in pixels: where the box opens for the lane. */
  function cursorPoint() {
    const svg = lanes.children[cursor.laneIndex].querySelector('svg.lane-events');
    const rect = svg.getBoundingClientRect();
    return { x: rect.left + ((cursor.cycle + 0.5 - drawn.pageStart) / PAGE_CYCLES) * rect.width, y: rect.top + rect.height / 2 };
  }

  /** Ask Claude about the lane under the keyboard cursor, at its cycle: the right-click's lane context, with an empty field. */
  function askLane() {
    handlers.askLane(cursor.laneIndex, cursor.cycle, cursorPoint());
  }

  // --- the queue of edits ---

  /**
   * Adds one edit of the note `target` to the queue and hands it over when its turn has come. `steps` says it gathers steps;
   * `said` is their sentence, which stays on screen while the edit waits behind another.
   */
  function enqueue(target, change, steps, said = null) {
    const edit = { id: nextEditId++, target, change, steps };
    if (closed) {
      // The Timeline is closed: nothing is handed over, and the panel says the change was not written.
      tellNotWritten([edit]);
      render();
      return;
    }
    queue.push(edit);
    pump();
    if (said !== null && queue.includes(edit)) queuedSaid = { edit, said };
    render();
  }

  /**
   * Hands the next edits over, one at a time: only while no edit is on its way, the lanes are drawn and the Timeline is open. Each
   * is aimed at its note as the lanes draw it now; an edit whose note is not there any more, or cannot be edited any more, is
   * dropped and the panel says which note's change was not written.
   */
  function pump() {
    while (inFlight === null && pumpHeld === 0 && !closed && drawn !== null && queue.length > 0) {
      const edit = queue.shift();
      const found = findNote(edit.target);
      let info = null;
      if (found !== null) {
        const shown = selected !== null && selected.target === edit.target && selected.laneIndex === found.laneIndex && selected.eventIndex === found.eventIndex;
        info = shown ? selected.info : handlers.describe(found.laneIndex, found.eventIndex);
      }
      if (info === null || !info.editable) {
        tellDropped(edit);
        render();
        continue;
      }
      handOver(edit, info, found);
    }
  }

  /**
   * Hands `edit` to the page for the note `info`, drawn at `found`, with a bounded wait for its answer. A rest remembers its chord
   * as it is drawn now and the notes beside it, which are found again from the lanes drawn after it (see resolveRest).
   */
  function handOver(edit, info, found) {
    edit.note = info.seen.token.text;
    edit.lane = info.track;
    edit.target.note = edit.note;
    edit.target.lane = edit.lane;
    // The lanes this edit brings may draw the note at the pitch it asks for before its answer comes: until the answer, the note
    // may have that pitch as well as its own.
    edit.target.asked = null;
    if (edit.change.kind === 'pitch') {
      const next = stepPitch(info.seen.token.text, edit.change.semitones);
      if (next.limit === undefined) edit.target.asked = next.midi;
    }
    if (queuedSaid !== null && queuedSaid.edit === edit) queuedSaid = null;
    if (edit.change.kind === 'rest') {
      const before = chordOf(drawn.lanes[found.laneIndex], edit.target.begin);
      const rested = before[edit.target.rank];
      const members = new Set([...liveTargets()].filter((target) => beside(target, edit.target)));
      pendingRest = { edit, target: edit.target, place: rested === undefined ? undefined : rested.places[0], before, members };
    }
    inFlight = { edit, phase: 'answer', timer: setTimer(expire, EDIT_WAIT_MS), lanesAway: false, freshLanes: false };
    handed.set(edit.id, edit);
    try {
      handlers.edit(info, edit.change, edit.id);
    } catch (error) {
      // The page could not even take the edit: nothing waits for an answer, and the error is not hidden.
      clearTimer(inFlight.timer);
      inFlight = null;
      pendingRest = null;
      handed.delete(edit.id);
      throw error;
    }
  }

  /**
   * The edit on its way is settled: the next one may go. A pitch its outcome left open (an error at or after the write) is read
   * from the lanes drawn now, which are drawn from the code it left, and so are the notes beside a rest that was written.
   */
  function settle() {
    if (inFlight.timer !== null) clearTimer(inFlight.timer);
    resolveAsked(inFlight.edit.target);
    inFlight = null;
    resolveRest('lanes');
  }

  /**
   * A wait of the edit on its way is over. With no answer, the panel says so at once, but the page may still be running the edit,
   * so the next one waits for that answer a while longer (an edit handed over meanwhile would be aimed at code about to change);
   * after that, or when the lanes of a written edit never came, the queue goes on. The notes beside a rest that ends this way are
   * aimed at no more: the page cannot tell where they went.
   */
  function expire() {
    const late = inFlight;
    if (late === null) return;
    if (late.phase === 'answer') {
      console.error(`Moontide: the page did not answer a Timeline edit within ${EDIT_WAIT_MS} ms; the next edit waits for that answer a while longer.`);
      result = sentenceFor(late.edit, { kind: 'refused', text: editTimeoutText() });
      // The sentence of a burst waiting behind it would hide this one: the burst still goes, after the late answer.
      queuedSaid = null;
      late.edit.late = true;
      late.phase = 'late';
      late.timer = setTimer(expire, EDIT_WAIT_MS);
      render();
      return;
    }
    inFlight = null;
    resolveRest('unsure');
    if (late.phase === 'late') {
      console.error(`Moontide: the page never answered a Timeline edit; the next edit goes on.`);
    } else if (!closed) {
      // A closed Timeline draws no lanes, so a written edit waits for none there: it is settled with no error.
      console.error(`Moontide: the Timeline was not drawn again within ${EDIT_WAIT_MS} ms of a written edit; the next edit goes on.`);
    }
    pump();
    render();
  }

  /**
   * Forgets the edits that wait their turn and gives them back. The edit on its way is kept: the page still runs it, its answer is
   * told, and nothing goes after it before that answer (and the lanes of a write) came.
   */
  function dropEdits() {
    const dropped = queue;
    queue = [];
    return dropped;
  }

  /**
   * The sentence that says the edits in `dropped` were not written: steps in the words of steps, a rest or a drag in the words of a
   * change, each named after its note when the panel shows another note. '' when nothing was dropped.
   */
  function notWrittenText(dropped) {
    const texts = dropped.map((edit) => sentenceFor(edit, { kind: 'refused', text: edit.steps ? stepsNotWrittenText() : changeNotWrittenText() }).text);
    return [...new Set(texts)].join(' ');
  }

  /** The steps that wait for their pause, as an edit of the note they were taken on, or none: what a drop of everything waiting loses first. */
  function pendingSteps() {
    return gatherer.pending() !== null && stepOwner !== null ? [{ target: stepOwner.target, steps: true }] : [];
  }

  /** Says that the edits in `dropped` were not written (the page turned, or the Timeline closed), each named after its note when the panel shows another. */
  function tellNotWritten(dropped) {
    if (dropped.length === 0) return;
    result = { kind: 'refused', text: notWrittenText(dropped) };
  }

  /** True when `edit` is about the note the panel shows, or the note that comes back when the lanes are drawn again. */
  function aboutShown(edit) {
    if (selected !== null) return selected.target === edit.target;
    return drawn === null && restore === edit.target;
  }

  /** The sentence `said` for `edit`: as it is for the note the panel shows, named after its note for any other. */
  function sentenceFor(edit, said) {
    if (aboutShown(edit)) return said;
    const note = edit.note ?? edit.target.note;
    const lane = edit.lane ?? edit.target.lane;
    return { ...said, text: namedText({ note, lane, text: said.text }) };
  }

  /** Says that `edit` was not written: its note is not where it was, or cannot be edited any more, or the Timeline closed. */
  function tellDropped(edit) {
    result = sentenceFor(edit, { kind: 'refused', text: edit.steps ? stepsDroppedText() : changeDroppedText() });
  }

  /**
   * Tells the outcome of `edit`, whose sentence is `said` (null for one with nothing to say): a written pitch becomes the pitch its
   * note is checked against (a refusal keeps the old one, a rest takes the note away), the sentence goes to the slot, named after the note when the panel shows another one, and
   * Ask Claude carries the change when the page wrote nothing and the note is the one shown. A change that waits for its line
   * keeps the edit controls off, and the steps and edits that wait are dropped with it.
   */
  function tellOutcome(edit, outcome, said) {
    const target = edit.target;
    const made = outcome.kind === 'written' || outcome.kind === 'waiting';
    const pitchKind = outcome.what === undefined || outcome.what === 'pitch';
    // How the rest on its way is settled by this answer, when it is its answer (see resolveRest); null leaves it on its way.
    let restHow = null;
    if (made && outcome.what === 'rest') {
      // The note leaves the lane: nothing is there to select again or to aim at. The notes beside it wait for the lanes drawn
      // after the rest (written) or for the end of the wait (waiting).
      target.gone = true;
      target.asked = null;
    } else if (outcome.kind === 'written' && pitchKind) {
      // The page wrote the pitch: it is the one the note is checked against from now on.
      const midi = writtenPitch(outcome);
      target.pitch = midi ?? target.asked;
      target.asked = null;
      target.note = String(outcome.to);
    } else if (outcome.kind === 'waiting' && pitchKind) {
      // The pitch changes when the line takes over: until the wait ends the note may have either pitch.
      const midi = writtenPitch(outcome);
      if (midi !== null) target.asked = midi;
      target.note = String(outcome.to);
    } else if (outcome.afterWrite === true) {
      // The code may or may not hold the change: a rest is taken as made, and the page cannot tell where the notes beside it are,
      // so none of them is aimed at again. The pitch asked for stays possible until the lanes drawn from the code tell.
      if (edit.change.kind === 'rest') {
        target.gone = true;
        target.asked = null;
        restHow = 'unsure';
      }
    } else {
      // Refused, failed or unchanged: the page wrote nothing, so the note keeps the pitch it had and the notes beside a rest keep
      // their ranks.
      target.asked = null;
      restHow = 'unwritten';
    }
    const shown = aboutShown(edit);
    if (shown) askAgain = askable(outcome) ? { target: edit.target, change: edit.change } : null;
    if (shown) result = said;
    else if (said !== null) result = sentenceFor(edit, said);
    if (restHow !== null && pendingRest !== null && pendingRest.edit === edit) resolveRest(restHow);
    if (outcome.kind === 'waiting' && edit.late === true) {
      // An answer that came after the panel said it was late: the edits made since then were made on purpose after it, so they
      // stay in the queue and go when the wait ends, took over or not. When this answer came after the second wait, the queue
      // already goes on meanwhile, and the page refuses those edits because a change waits for its line.
      result = { ...result, wait: outcome, edit, shown };
      ownWait = true;
      waited = edit;
    } else if (outcome.kind === 'waiting') {
      // One change waits at a time: the edit controls stay off until it takes over (finishWait), and what waited is not written.
      const lostText = notWrittenText([...pendingSteps(), ...queue]);
      result = { ...result, wait: outcome, edit, shown, ...(lostText !== '' ? { lostText, text: `${result.text} ${lostText}` } : {}) };
      ownWait = true;
      waited = edit;
      gatherer.drop();
      queue = [];
      stepOwner = null;
      stepSaid = null;
    }
  }

  // --- steps ---

  /** Takes the pending steps and their sentence away without writing them. */
  function dropSteps() {
    gatherer.drop();
    stepOwner = null;
    if (stepSaid !== null) {
      stepSaid = null;
      render();
    }
  }

  /**
   * The pause after the last step is over, or was cut short: the total of the burst becomes one edit of the note it was taken on,
   * which waits its turn in the queue. The gatherer is not entered again from here.
   */
  function flushSteps(kind, total) {
    const said = stepSaid;
    stepSaid = null;
    const owner = stepOwner;
    stepOwner = null;
    if (owner === null || !owner.info.editable) {
      // Steps with no note to be written for are told, not hidden.
      result = { kind: 'refused', text: stepsDroppedText() };
      render();
      return;
    }
    enqueue(owner.target, kind === 'pitch' ? { kind: 'pitch', semitones: total } : { kind: 'velocity', steps: total }, true, said);
    render();
  }

  const gatherer = createStepGatherer({
    setTimer,
    clearTimer,
    delayMs: STEP_GATHER_MS,
    onFlush: flushSteps,
    // A write the page could not even start is not hidden: it is reported where the page reports a failed handler.
    onError: (error) => {
      console.error('Moontide: the steps of a Timeline note could not be handed to the page:', error);
    },
  });

  /**
   * The edits of `target` that the lanes drawn now do not show yet, in the order the page takes them: the one on its way, until
   * the lanes its write brings are here, then those that wait their turn.
   */
  function unshownEdits(target) {
    const edits = [];
    if (inFlight !== null && inFlight.edit.target === target && !inFlight.freshLanes) edits.push(inFlight.edit);
    for (const edit of queue) if (edit.target === target) edits.push(edit);
    return edits;
  }

  /**
   * The token of the selected note (`choice`) as it will be once the pitch edits of it that wait or are on their way are written:
   * `{ text, midi }`. A new step is shown, and held at the ends of the range, from there, because that is the token it is written on.
   */
  function expectedPitch(choice) {
    let text = choice.info.seen.token.text;
    let midi = choice.info.midi;
    for (const edit of unshownEdits(choice.target)) {
      if (edit.change.kind !== 'pitch') continue;
      const next = stepPitch(text, edit.change.semitones);
      if (next.limit !== undefined) continue;
      text = next.text;
      midi = next.midi;
    }
    return { text, midi };
  }

  /** The velocity of the selected note (`choice`) once the velocity edits of it that wait or are on their way are written. */
  function expectedVelocity(choice) {
    let shown = choice.info.velocity;
    for (const edit of unshownEdits(choice.target)) {
      if (edit.change.kind === 'velocity') shown = velocityTarget({ shown, steps: edit.change.steps });
    }
    return shown;
  }

  /**
   * The sentence of `total` steps of `kind` that wait for the pause, taken on the selected note as it will be once the edits of it
   * before them are written, or null when they add up to nothing. It repeats how many places the token plays, or how many notes
   * share the velocity number.
   */
  function stepsSentence(kind, total) {
    if (kind === 'pitch') {
      if (total === 0) return null;
      const from = expectedPitch(selected);
      const next = stepPitch(from.text, total);
      if (next.limit !== undefined) return { kind: 'preview', text: limitText(next.limit) };
      const { count, onPage } = placesOfSelection();
      return {
        kind: 'preview',
        text: previewText({
          from: from.text,
          to: next.text,
          semitones: total,
          drumFrom: drumLabel(selected.laneIndex, from.midi),
          drumTo: drumLabel(selected.laneIndex, next.midi),
          waiting: true,
          places: count,
          onPage,
        }),
      };
    }
    const shown = expectedVelocity(selected);
    const target = velocityTarget({ shown, steps: total });
    if (target === Math.round(shown * 100) / 100) return null;
    const { count, onPage } = velocityPlacesOfSelection();
    return { kind: 'preview', text: velocityPreviewText({ from: shown, to: target, notes: velocityNotes(), places: count, onPage }) };
  }

  /** The total of the steps of `kind` that wait for the pause, 0 when there are none of that kind. */
  function pendingTotal(kind) {
    const pending = gatherer.pending();
    return pending !== null && pending.kind === kind ? pending.total : 0;
  }

  /**
   * Says the note is at the end of its range: with steps waiting the sentence is theirs, otherwise it is the result, in the place
   * of a burst that waits behind another edit (that burst is what took the note to the end).
   */
  function sayLimit(text) {
    if (gatherer.pending() !== null) {
      stepSaid = { kind: 'preview', text };
    } else {
      result = { kind: 'result', text };
      queuedSaid = null;
    }
    render();
  }

  /**
   * One step of the pitch of the selected note, a semitone or an octave up or down (`amount`): the step joins the steps that wait
   * for the pause and the sentence shows where they would take the note. A note the page cannot edit does nothing, and so does
   * a note while the controls are off.
   */
  function pitchStep(amount) {
    if (selected === null) return;
    // A note the page cannot edit moves nothing: the step becomes a request in the Ask box.
    if (!selected.info.editable) {
      prepareRequest(selected.info, { kind: 'pitch', semitones: amount });
      return;
    }
    if (controlsOff()) return;
    askAgain = null;
    const total = pendingTotal('pitch') + amount;
    const next = stepPitch(expectedPitch(selected).text, total);
    if (next.limit !== undefined) {
      sayLimit(limitText(next.limit));
      return;
    }
    gatherer.step('pitch', amount);
    stepOwner = selected;
    // Back where it started (a total of 0): nothing will be written, and nothing is said.
    stepSaid = stepsSentence('pitch', total);
    render();
  }

  /** One step of the velocity of the selected note, a tenth up or down (`amount`); the steps gather like the pitch ones. */
  function velocityStepBy(amount) {
    if (selected === null) return;
    // A note the page cannot edit moves nothing: the step becomes a request in the Ask box.
    if (!selected.info.editable) {
      prepareRequest(selected.info, { kind: 'velocity', steps: amount });
      return;
    }
    if (controlsOff()) return;
    askAgain = null;
    const info = selected.info;
    if (info.velocityWritable !== true) {
      dropSteps();
      result = { kind: 'refused', text: velocityRefusalText() };
      // The sentence says to ask Claude, and Ask Claude then carries the step that was refused.
      askAgain = { target: selected.target, change: { kind: 'velocity', steps: amount } };
      render();
      return;
    }
    const shown = expectedVelocity(selected);
    const before = pendingTotal('velocity');
    const total = before + amount;
    if (velocityTarget({ shown, steps: total }) === velocityTarget({ shown, steps: before })) {
      sayLimit(velocityLimitText(amount > 0 ? 'highest' : 'lowest'));
      return;
    }
    gatherer.step('velocity', amount);
    stepOwner = selected;
    stepSaid = stepsSentence('velocity', total);
    render();
  }

  /**
   * Turns the selected note into a rest, whatever steps were waiting: it is handed over at once, or after the edits before it. A note the page cannot edit is not changed: the
   * request for it is prepared in the Ask box.
   */
  function rest() {
    if (selected === null) return;
    if (!selected.info.editable) {
      prepareRequest(selected.info, { kind: 'rest' });
      return;
    }
    dropSteps();
    if (controlsOff()) return;
    askAgain = null;
    enqueue(selected.target, { kind: 'rest' }, false);
  }

  /**
   * Selects again the note the person had selected before the lanes were drawn again: the same lane (by its identity, or by its
   * track index when the identity was built from strings an edit may have changed), the same time and rank, and a pitch the note may
   * have. A page that is not the same page, or no such note, leaves nothing selected. The sentence of the last edit stays.
   */
  function restoreSelection() {
    const target = restore;
    restore = null;
    if (target === null) return;
    const found = findNote(target);
    if (found === null) return;
    selected = choose(found.laneIndex, found.eventIndex, target);
  }

  // --- the pointer ---

  /** The lane whose event area holds the point, as `{ index, rect }`, or null. */
  function laneAt(x, y) {
    if (drawn === null) return null;
    for (let index = 0; index < drawn.lanes.length; index++) {
      const laneElement = lanes.children[index];
      if (!laneElement) continue;
      const svg = laneElement.querySelector('svg.lane-events');
      if (!svg) continue;
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height) return { index, rect };
    }
    return null;
  }

  function endPress() {
    if (press === null) return;
    const { pointerId } = press;
    press = null;
    if (typeof lanes.hasPointerCapture === 'function' && lanes.hasPointerCapture(pointerId)) lanes.releasePointerCapture(pointerId);
  }

  function removeAttr(node, name) {
    if (node.getAttribute(name) !== null) node.removeAttribute(name);
  }

  /** The drum the lane's map names `midi`, `{ map }` for a note the map does not name, null when the lane is not drums. */
  function drumLabel(laneIndex, midi) {
    const map = drawn.lanes[laneIndex].drumMap;
    if (map === null || map === undefined) return null;
    const name = map.byNote.get(midi);
    return name === undefined ? { map: map.name } : name;
  }

  /**
   * The change of a pitch drag that stands for `semitones` of travel: the same step the page writes, from the token the drag
   * starts from, held where the note range ends. Gives `{ semitones, limit }`; `limit` is `'lowest'`, `'highest'` or null when
   * the travel was not held.
   */
  function heldChange(drag, semitones) {
    let held = Math.max(-127, Math.min(127, semitones));
    while (held !== 0 && stepPitch(drag.from.text, held).limit !== undefined) held += held > 0 ? -1 : 1;
    return { semitones: held, limit: held === semitones ? null : semitones > 0 ? 'highest' : 'lowest' };
  }

  /** Puts the ghost and the sentence of the drag where its whole-step value says, and writes nothing else. */
  function showDrag(drag) {
    if (drag.semitones === 0) {
      if (drag.ghost !== null) {
        drag.ghost.remove();
        drag.ghost = null;
      }
      preview = drag.limit === null ? null : { kind: 'preview', text: limitText(drag.limit) };
      render();
      return;
    }
    const info = drag.info;
    const step = stepPitch(drag.from.text, drag.semitones);
    const box = markBox(drag.laneIndex, drag.eventIndex);
    // The note stays where it is; the ghost is a fixed step higher or lower for each semitone, inside the lane.
    const top = Math.max(0, Math.min(1 - box.height, box.top - (drag.semitones * drag.stepPx) / drag.laneHeight));
    if (drag.ghost === null) {
      drag.ghost = make('span', 'tl-ghost');
      marks[drag.laneIndex].appendChild(drag.ghost);
    }
    placeMark(drag.ghost, { ...box, top });
    const { count, onPage } = selected !== null && selected.info === info ? placesOfSelection() : { count: 0, onPage: false };
    preview = {
      kind: 'preview',
      text: previewText({
        from: drag.from.text,
        to: step.text,
        semitones: drag.semitones,
        drumFrom: drumLabel(drag.laneIndex, drag.from.midi),
        drumTo: drumLabel(drag.laneIndex, step.midi),
        places: count,
        onPage,
      }),
    };
    render();
  }

  /** Puts the wash of a range over its whole cycles, in percentages of the lane. */
  function placeWash(node, from, to) {
    node.style.left = `${((from - drawn.pageStart) / PAGE_CYCLES) * 100}%`;
    node.style.width = `${((to - from + 1) / PAGE_CYCLES) * 100}%`;
  }

  /**
   * The range a press covers with the pointer at `x`: the cycle under the press and the cycle under the pointer, held inside the
   * page. The press keeps one range object for the whole drag; its wash is drawn the first time and moved afterwards.
   */
  function dragRange(held, x) {
    const width = held.rect.width;
    const cycles = rangeCycles({ pageStart: drawn.pageStart, pressFraction: (held.x - held.rect.left) / width, pointerFraction: (x - held.rect.left) / width });
    // The cycle the press began in is where the range is anchored; the other end is the cycle the pointer is in.
    const anchor = cycleAt({ pageStart: drawn.pageStart, fraction: (held.x - held.rect.left) / width });
    const head = anchor === cycles.from ? cycles.to : cycles.from;
    if (held.range === undefined || held.range === null) {
      held.range = { laneIndex: held.laneIndex, from: cycles.from, to: cycles.to, cut: cycles.cut, anchor, head, wash: make('span', 'tl-range') };
      placeWash(held.range.wash, cycles.from, cycles.to);
      marks[held.laneIndex].appendChild(held.range.wash);
      return held.range;
    }
    const current = held.range;
    if (current.from !== cycles.from || current.to !== cycles.to) placeWash(current.wash, cycles.from, cycles.to);
    current.from = cycles.from;
    current.to = cycles.to;
    current.cut = cycles.cut;
    current.head = head;
    return current;
  }

  /** Takes the wash of the selected range away and forgets the range. */
  function dropRange() {
    if (range === null) return false;
    range.wash.remove();
    range = null;
    return true;
  }

  /** The selected range as the page takes it: `{ laneIndex, from, to, cut }`. */
  function rangeSelection() {
    return { laneIndex: range.laneIndex, from: range.from, to: range.to, cut: range.cut };
  }

  /** Makes `held` (a range with its wash drawn) the selected range, with what the page says of it for the panel. */
  function adoptRange(held) {
    held.info = handlers.describeRange({ laneIndex: held.laneIndex, from: held.from, to: held.to, cut: held.cut });
    range = held;
  }

  /** The middle of the selected range's wash on the page, in pixels: where the box opens when no pointer made the range. */
  function rangePoint() {
    const svg = lanes.children[range.laneIndex].querySelector('svg.lane-events');
    const rect = svg.getBoundingClientRect();
    return { x: rect.left + (((range.from + range.to + 1) / 2 - drawn.pageStart) / PAGE_CYCLES) * rect.width, y: rect.top + rect.height / 2 };
  }

  /** Ask Claude about the selected range: the box opens at the middle of the wash with an empty field. */
  function askRange() {
    handlers.range(rangeSelection(), rangePoint());
  }

  /**
   * Moves the head of the range one cycle left or right (`direction` is -1 or 1), held inside the page, and draws it again. With no
   * range the key starts one at the cycle of the selected note or of the cursor, which it replaces. Without a range, a note or a
   * cursor it does nothing and gives false.
   */
  function widenRange(direction) {
    let laneIndex;
    let anchor;
    let head;
    if (range !== null) {
      ({ laneIndex, anchor, head } = range);
    } else if (selected !== null) {
      laneIndex = selected.laneIndex;
      const begin = drawn.lanes[laneIndex].events[selected.eventIndex].begin;
      anchor = cycleAt({ pageStart: drawn.pageStart, fraction: (begin - drawn.pageStart) / PAGE_CYCLES });
      head = anchor;
    } else if (cursor !== null) {
      laneIndex = cursor.laneIndex;
      anchor = cursor.cycle;
      head = anchor;
    } else {
      return false;
    }
    head = Math.max(drawn.pageStart, Math.min(drawn.pageStart + PAGE_CYCLES - 1, head + direction));
    clearSelection();
    dropRange();
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    const wash = make('span', 'tl-range');
    placeWash(wash, from, to);
    marks[laneIndex].appendChild(wash);
    adoptRange({ laneIndex, from, to, cut: null, anchor, head, wash });
    render();
    return true;
  }

  /** The press moved far enough to be a gesture: set it up. */
  function beginGesture() {
    if (press.lock === 'range') {
      setAttr(lanes, 'data-dragging', 'range');
      press.range = null;
      return;
    }
    if (selected === null || selected.laneIndex !== press.laneIndex || selected.eventIndex !== press.picked) select(press.laneIndex, press.picked);
    // A drag takes the place of steps that were waiting on this note, and the sentence says so once the drag is over.
    const replaced = gatherer.pending() !== null;
    dropSteps();
    if (replaced) {
      result = lostStepsResult();
      render();
    }
    const info = selected.info;
    setAttr(lanes, 'data-dragging', info.editable ? 'pitch' : 'refused');
    askAgain = null;
    if (!info.editable) {
      // A note the page cannot edit does not move and shows no ghost: the travel only decides the request prepared on release.
      press.refused = { info, semitones: 0, stepPx: SEMITONE_REM * press.rem };
      return;
    }
    // The drag starts from the note as it will be once the edits of it before the drag are written: that is what it changes.
    press.drag = { info, target: selected.target, from: expectedPitch(selected), laneIndex: press.laneIndex, eventIndex: press.picked, semitones: 0, limit: null, ghost: null, stepPx: SEMITONE_REM * press.rem, laneHeight: press.rect.height };
  }

  /** Takes the drag's marks and its sentence away; the selection and the panel stay as they were. */
  function clearGesture() {
    if (press !== null && press.drag !== undefined && press.drag !== null && press.drag.ghost !== null) press.drag.ghost.remove();
    removeAttr(lanes, 'data-dragging');
    if (preview !== null) {
      preview = null;
      render();
    }
  }

  /** Ends a gesture in progress without writing anything. */
  function cancelGesture() {
    if (press === null) return;
    // A range that was being drawn goes with the gesture; the range that was selected before it stays.
    if (press.range !== undefined && press.range !== null) press.range.wash.remove();
    clearGesture();
    endPress();
  }

  function pickAt(laneIndex, rect, x, y, rem) {
    const lane = drawn.lanes[laneIndex];
    return pickNote({
      boxes: noteBoxes({ rect, shapes: lane.shapes, rowCount: lane.rowCount, markHeight: NOTE_MARK_HEIGHT }),
      pitches: lane.events.map((entry) => pitchOf(entry.value) ?? 0),
      x,
      y,
      tolerancePx: HIT_TOLERANCE_REM * rem,
    });
  }

  lanes.addEventListener('pointerdown', (event) => {
    if (drawn === null || press !== null) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
    const at = laneAt(event.clientX, event.clientY);
    if (at === null) return;
    const rem = rootFontPx();
    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, laneIndex: at.index, rect: at.rect, rem, picked: pickAt(at.index, at.rect, event.clientX, event.clientY, rem), lock: null, drag: null };
    // The lanes' children are replaced when the Timeline redraws, so the container itself keeps the pointer.
    if (typeof lanes.setPointerCapture === 'function') lanes.setPointerCapture(event.pointerId);
  });

  /** The word on `data-hover` says what is under the pointer (`note` or `empty`); it is written only when it changes. */
  function hover(event) {
    const at = drawn === null ? null : laneAt(event.clientX, event.clientY);
    if (at === null) {
      removeAttr(lanes, 'data-hover');
      return;
    }
    setAttr(lanes, 'data-hover', pickAt(at.index, at.rect, event.clientX, event.clientY, rootFontPx()) === null ? 'empty' : 'note');
  }

  lanes.addEventListener('pointerleave', () => {
    if (press === null) removeAttr(lanes, 'data-hover');
  });

  lanes.addEventListener('pointermove', (event) => {
    if (press === null) {
      hover(event);
      return;
    }
    if (event.pointerId !== press.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (press.lock === null) {
      press.lock = lockGesture({ dx, dy, onNote: press.picked !== null, thresholdPx: DRAG_THRESHOLD_REM * press.rem });
      if (press.lock === null) return;
      beginGesture();
    }
    if (press.lock === 'range') {
      dragRange(press, event.clientX);
      return;
    }
    if (press.lock === 'pitch' && press.refused !== undefined) {
      const travel = press.refused;
      const semitones = Math.max(-MAX_REQUEST_SEMITONES, Math.min(MAX_REQUEST_SEMITONES, semitonesFrom({ dy, stepPx: travel.stepPx })));
      // The sentence changes only when the whole-step value does.
      if (semitones === travel.semitones) return;
      travel.semitones = semitones;
      preview = semitones === 0 ? null : { kind: 'preview', text: refusedPreviewText(semitones) };
      render();
      return;
    }
    const drag = press.drag;
    if (press.lock !== 'pitch' || drag === null) return;
    const next = heldChange(drag, semitonesFrom({ dy, stepPx: drag.stepPx }));
    // The ghost and the sentence change only when the whole-step value does, not with every pixel of the pointer.
    if (next.semitones === drag.semitones && next.limit === drag.limit) return;
    drag.semitones = next.semitones;
    drag.limit = next.limit;
    showDrag(drag);
  });

  lanes.addEventListener('pointerup', (event) => {
    if (press === null || event.pointerId !== press.pointerId) return;
    const began = press;
    clearGesture();
    endPress();
    // A release that arrives with no move before it (a pen, a script) is judged by where it is.
    if (began.lock === null) {
      began.lock = lockGesture({ dx: event.clientX - began.x, dy: event.clientY - began.y, onNote: began.picked !== null, thresholdPx: DRAG_THRESHOLD_REM * began.rem });
    }
    if (began.lock === 'pitch' && began.refused !== undefined) {
      // Nothing is written: the release prepares the request for what was previewed, opened where the pointer was released.
      if (began.refused.semitones !== 0) prepareRequest(began.refused.info, { kind: 'pitch', semitones: began.refused.semitones }, { x: event.clientX, y: event.clientY });
      return;
    }
    if (began.lock === 'pitch') {
      // What was previewed is what is written: the value of the last step shown, whatever the pointer did since.
      if (began.drag !== null && began.drag.semitones !== 0) enqueue(began.drag.target, { kind: 'pitch', semitones: began.drag.semitones }, false);
      return;
    }
    if (began.lock === 'range') {
      // The range is judged where the pointer is released; a release with no move before it is drawn here for the first time.
      const held = dragRange(began, event.clientX);
      clearSelection();
      dropRange();
      adoptRange(held);
      lanes.focus();
      render();
      handlers.range(rangeSelection(), { x: event.clientX, y: event.clientY });
      return;
    }
    if (began.lock !== null || drawn === null) return;
    if (began.picked === null) {
      clearSelection();
      if (dropRange()) render();
      return;
    }
    select(began.laneIndex, began.picked);
    lanes.focus();
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    lanes.addEventListener(type, (event) => {
      if (press !== null && event.pointerId === press.pointerId) cancelGesture();
    });
  }

  // --- the keyboard ---

  /** The events of each drawn lane as the keys walk them: `{ begin, pitch }`, or null for one that has no mark to pick (a tick). */
  function walkable() {
    return drawn.lanes.map((lane) =>
      lane.events.map((entry, index) => (lane.rowCount === null && lane.shapes[index].kind !== 'note' ? null : { begin: entry.begin, pitch: pitchOf(entry.value) })),
    );
  }

  /** Takes the selection or the cursor to the place `laneMove` gave, when it is another place than the one the person is at. */
  function moveTo(to) {
    if (to.eventIndex === null) {
      if (cursor === null || cursor.laneIndex !== to.laneIndex || cursor.cycle !== to.cycle) placeCursor(to.laneIndex, to.cycle);
    } else if (selected === null || selected.laneIndex !== to.laneIndex || selected.eventIndex !== to.eventIndex) {
      select(to.laneIndex, to.eventIndex);
    }
    // A long Timeline scrolls: the lane the keys arrived on is brought into view.
    lanes.children[to.laneIndex].scrollIntoView({ block: 'nearest' });
  }

  lanes.addEventListener('keydown', (event) => {
    // Escape during a gesture ends it and nothing else; then it drops steps that were not written yet, then it clears the range,
    // then the selection or the cursor; with none of those left it goes on to the page's own rules (which close the view).
    if (event.key === 'Escape') {
      if (press !== null && press.lock !== null) {
        cancelGesture();
        event.preventDefault();
        event.stopPropagation();
      } else if (gatherer.pending() !== null) {
        dropSteps();
        event.preventDefault();
        event.stopPropagation();
      } else if (queue.some((edit) => edit.steps && aboutShown(edit))) {
        // Steps whose pause is over but that wait behind another edit are not written yet either: Escape takes them back too.
        queue = queue.filter((edit) => !(edit.steps && aboutShown(edit)));
        queuedSaid = null;
        render();
        event.preventDefault();
        event.stopPropagation();
      } else if (range !== null) {
        // Escape steps back: the Ask box first (its own rule), then steps not written, then the range.
        dropRange();
        render();
        event.preventDefault();
        event.stopPropagation();
      } else if (selected !== null || cursor !== null) {
        clearSelection();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    // While a pointer gesture is in progress the keys do not act on the note under it: two edits from one note would race.
    if (press !== null && press.lock !== null) return;
    // Left, Right, Home, End, Page Up and Page Down move along a lane or across lanes; they change nothing in the code. A key
    // that has no place to start from (nothing selected, and not Left or Right) goes on to the page, which scrolls the lanes.
    if (LANE_KEYS.includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (drawn === null || range !== null) return;
      const at = selected !== null ? { laneIndex: selected.laneIndex, eventIndex: selected.eventIndex } : cursor !== null ? { laneIndex: cursor.laneIndex, eventIndex: null, cycle: cursor.cycle } : null;
      const to = laneMove({ lanes: walkable(), at, key: event.key });
      if (to === null) return;
      event.preventDefault();
      event.stopPropagation();
      moveTo(to);
      return;
    }
    if (isAskKey(event)) {
      // The keyboard's right-click: the page's own contextmenu listener ignores a Shift press, so the view asks directly.
      if (range !== null) {
        event.preventDefault();
        event.stopPropagation();
        askRange();
        return;
      }
      if (cursor !== null) {
        event.preventDefault();
        event.stopPropagation();
        askLane();
        return;
      }
      if (selected === null) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.ask(selected.info, notePoint());
      return;
    }
    // Shift with Left or Right starts a range at the selected note's cycle and widens it by a cycle a press. Nothing is written, so a
    // held key may repeat. With neither a note nor a range the key goes on to the page.
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (drawn === null || (selected === null && range === null && cursor === null)) return;
      event.preventDefault();
      event.stopPropagation();
      widenRange(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      if ((selected === null && range === null && cursor === null) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      askAbout();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Backspace does what Delete does: the Mac keyboard has no forward Delete. With nothing selected the keys go on to the page.
      if (selected === null || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      rest();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // With nothing selected the arrows scroll the lanes as they always did.
    if (selected === null) return;
    event.preventDefault();
    event.stopPropagation();
    // Holding a key is one step, not a run of them.
    if (event.repeat) return;
    // Shift makes the step an octave.
    pitchStep((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1));
  });

  render();

  return {
    onRedraw(next) {
      // Steps that wait for their pause were aimed at the note as it is drawn now: the pause is cut short and they join the queue,
      // which aims them at that note in the lanes that come. Nothing is handed over before those lanes are here.
      pumpHeld += 1;
      let lost;
      try {
        lost = leaveNote();
      } finally {
        pumpHeld -= 1;
      }
      stepOwner = null;
      stepSaid = null;
      if (lost) result = lostStepsResult();
      // The lanes of the edit on its way: they go away while the new code is computed, and the lanes after that are its own.
      if (inFlight !== null) {
        if (next === null) inFlight.lanesAway = true;
        else if (inFlight.lanesAway) inFlight.freshLanes = true;
      }
      // What was selected is kept for the lanes that come next; a gesture on lanes that are gone ends without a write.
      if (selected !== null) restore = selected.target;
      cancelGesture();
      // The wash lives in a mark layer that is replaced below: a range does not survive a redraw.
      range = null;
      cursor = null;
      active = null;
      removeAttr(lanes, 'data-hover');
      drawn = next;
      selected = null;
      ring = null;
      sames = [];
      marks = [];
      if (drawn !== null) {
        drawn.lanes.forEach((lane, index) => {
          const laneElement = lanes.children[index];
          if (!laneElement) throw new Error(`Moontide: the Timeline draws no lane ${index} for the edit view.`);
          const old = laneElement.querySelector('.lane-marks');
          if (old) old.remove();
          const layer = make('div', 'lane-marks');
          layer.setAttribute('aria-hidden', 'true');
          laneElement.appendChild(layer);
          marks.push(layer);
        });
        closed = false;
        // A page turn: the edits that wait were aimed at notes of the page that went, so they are dropped and the panel says so.
        const turned = shownPage !== null && drawn.pageStart !== shownPage;
        shownPage = drawn.pageStart;
        if (turned) {
          tellNotWritten(dropEdits());
          // Lanes of another page drawn before the answer of the edit on its way are not drawn from the code it writes: the
          // next edit waits for the lanes that come after that answer.
          if (inFlight !== null && (inFlight.phase === 'answer' || inFlight.phase === 'late')) {
            inFlight.lanesAway = false;
            inFlight.freshLanes = false;
          }
        }
        if (inFlight !== null && inFlight.phase === 'lanes' && inFlight.freshLanes) settle();
        // After the edit on its way is settled, so that a note beside a rest is looked for at the rank these lanes give it.
        restoreSelection();
      }
      pump();
      render();
      drawRing();
    },
    showOutcome(id, outcome) {
      const edit = handed.get(id);
      if (edit === undefined) throw new Error(`Moontide: an outcome came for Timeline edit ${String(id)}, which was never handed over or was already answered.`);
      // The words first: an outcome the panel does not know throws before anything changes.
      const said = resultText(outcome);
      handed.delete(id);
      const current = inFlight !== null && inFlight.edit === edit;
      if (current && inFlight.timer !== null) {
        clearTimer(inFlight.timer);
        inFlight.timer = null;
      }
      tellOutcome(edit, outcome, said);
      if (current) {
        if (outcome.kind === 'waiting') {
          // The code changes when the change takes over: the lanes that come before that are not this edit's.
          inFlight.phase = 'waiting';
          inFlight.lanesAway = false;
          inFlight.freshLanes = false;
        } else if ((outcome.kind === 'written' || outcome.afterWrite === true) && !inFlight.freshLanes) {
          // The next edit is aimed at the note as the new code draws it: it waits for those lanes, for a bounded time.
          inFlight.phase = 'lanes';
          inFlight.timer = setTimer(expire, EDIT_WAIT_MS);
        } else {
          settle();
        }
      }
      pump();
      render();
    },
    setNotice(kind) {
      if (kind !== null && !Object.hasOwn(NOTICE_KINDS, kind)) throw new Error(`Moontide: unknown notice '${String(kind)}' of the Timeline note panel.`);
      if (kind === notice) return;
      notice = kind;
      // Nothing is written while the page cannot write safely, so steps and edits that waited are dropped with the controls, and
      // the sentence says so beside this notice and after it.
      if (kind !== null) {
        const lost = [...pendingSteps(), ...queue];
        if (lost.length > 0) result = { kind: 'refused', text: notWrittenText(lost), lost: true, lostTo: kind };
        gatherer.drop();
        queue = [];
        stepOwner = null;
        stepSaid = null;
      }
      render();
    },
    finishWait({ tookOver }) {
      if (typeof tookOver !== 'boolean') throw new Error('Moontide: a wait ends because the change took over or because it did not.');
      ownWait = false;
      // The note of the change that waited has its new pitch once the change took over, and keeps its old one otherwise.
      if (waited !== null) {
        const target = waited.target;
        if (tookOver && target.asked !== null) target.pitch = target.asked;
        target.asked = null;
        waited = null;
      }
      // The sentence that said the change waits now says it was made, or goes if the change never took over.
      if (result !== null && result.wait !== undefined) {
        const lost = result.lostText ?? null;
        const told = tookOver ? resultText({ ...result.wait, kind: 'written' }) : null;
        const made = told === null || result.shown ? told : { ...told, text: namedText({ note: result.edit.note, lane: result.edit.lane, text: told.text }) };
        if (made === null) result = lost === null ? null : { kind: 'refused', text: lost, lost: true };
        else result = lost === null ? made : { ...made, text: `${made.text} ${lost}`, lost: true };
      }
      if (inFlight !== null && inFlight.phase === 'waiting') {
        if (tookOver && !inFlight.freshLanes) {
          inFlight.phase = 'lanes';
          inFlight.timer = setTimer(expire, EDIT_WAIT_MS);
        } else {
          // A rest that never took over leaves the page unsure of the notes beside it: the code that plays may have changed meanwhile.
          if (!tookOver) resolveRest('unsure');
          settle();
        }
      }
      pump();
      render();
    },
    close() {
      // Nothing is handed over while the Timeline is closed: steps and edits that wait are dropped and the panel says so. The edit
      // already on its way is still written by the page; its answer is told, and it holds the queue until then.
      cancelGesture();
      // Steps that wait join the queue first, so the sentence names their note like every edit that is dropped.
      pumpHeld += 1;
      let lost;
      try {
        lost = leaveNote();
      } finally {
        pumpHeld -= 1;
      }
      stepOwner = null;
      stepSaid = null;
      closed = true;
      if (lost) result = lostStepsResult();
      tellNotWritten(dropEdits());
      render();
    },
    cancelGesture,
    /** Clears the selected range and its wash (the page calls it when the request about the range is sent). */
    clearRange() {
      if (dropRange()) render();
    },
    /** The selected range as `{ laneIndex, from, to, cut }`, or null. */
    rangeSelection() {
      return range === null ? null : rangeSelection();
    },
    selection() {
      return selected === null ? null : { laneIndex: selected.laneIndex, eventIndex: selected.eventIndex, info: selected.info };
    },
  };
}
