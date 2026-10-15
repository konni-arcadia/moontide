// The editable Timeline's DOM code, tested without a browser against a small fake document: a click picks a note, the panel under
// the lanes says what the page knows of it, Up and Down hand an edit to the page, and everything that comes from the code stays
// text. The live Timeline in real Chrome is proved by `npm run probe:page -- --only timeline`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTimelineEditView } from '../page/timeline-edit-view.js';
import { TIMELINE_COPY } from '../page/timeline.js';
import { all, fakeDocument, fakeNode } from './fake-document.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../page/timeline-edit-view.js', import.meta.url)), 'utf8');

const REM = 16;

// A lane's event area 3200 pixels wide (100 pixels a cycle) and 100 pixels high.
const RECT = { left: 100, top: 0, right: 3300, bottom: 100, width: 3200, height: 100 };

/** A note of lane 0 drawn at cycle `x`, in the middle of the lane: the box is 14 pixels high around y = 50. */
const note = (x, y = 0.5) => ({ kind: 'note', x, width: 1, y });

/** The same lanes with the first note of lane 0 given another value (a redraw after the code changed). */
const withFirstNote = (drawn, value, changes = {}) => ({
  ...drawn,
  lanes: drawn.lanes.map((lane, index) =>
    index === 0 ? { ...lane, ...changes, events: lane.events.map((entry, at) => (at === 0 ? { ...entry, value } : entry)) } : lane,
  ),
});

/**
 * A Timeline of two lanes as page/main.js leaves it: lane 0 is a normal lane with three notes and a tick, lane 1 a drum lane of
 * two rows, each lane an element holding its svg. Returns what the tests press and read.
 */
function setup({ handlers: overrides = {}, rangeInfo = {}, track = 't1', editable = true, velocityWritable = true, velocity = 0.8, tokenText = 'c3', info: infoExtra = {}, seen: seenExtra = {} } = {}) {
  const document = fakeDocument();
  const lanes = fakeNode('div', document);
  const laneNodes = [0, 1].map((k) => {
    const lane = fakeNode('div', document);
    lane.className = 'lane';
    const svg = fakeNode('svg', document);
    svg.className = 'lane-events';
    // The lanes lie one under the other, 100 pixels each.
    svg.rect = { ...RECT, top: k * 100, bottom: k * 100 + 100 };
    lane.appendChild(svg);
    lanes.appendChild(lane);
    return lane;
  });
  const panel = fakeNode('section', document);
  panel.hidden = true;
  const line = fakeNode('p', document);
  panel.appendChild(line);
  document.markup.push(lanes, panel);
  // `editLanes` is the lane of each edit handed over, in the order of `edit`.
  const calls = { describe: [], edit: [], editLanes: [], prepare: [], ask: [], range: [], describeRange: [], askLane: [] };
  // The ids of the edits handed over and not answered yet, oldest first.
  const unanswered = [];
  const handlers = {
    describe(laneIndex, eventIndex) {
      calls.describe.push([laneIndex, eventIndex]);
      return {
        laneIndex,
        eventIndex,
        track: laneIndex === 0 ? track : 'drums',
        cycle: 1 + eventIndex,
        beat: 2,
        section: null,
        noteText: tokenText,
        midi: 48,
        drum: laneIndex === 1 ? 'Kick' : null,
        velocity,
        velocityWritable,
        editable,
        reason: editable ? null : 'degrees',
        seen: editable ? { token: { start: 3, end: 5, text: tokenText }, ...seenExtra } : null,
        ...(typeof infoExtra === 'function' ? infoExtra(laneIndex, eventIndex) : infoExtra),
      };
    },
    edit(info, change, id) {
      assert.ok(Number.isInteger(id), 'every edit is handed over with its id');
      calls.edit.push([info.eventIndex, change]);
      calls.editLanes.push(info.laneIndex);
      unanswered.push(id);
    },
    prepare(info, change, point) {
      calls.prepare.push([info.eventIndex, change, point]);
    },
    ask(info, point) {
      calls.ask.push([info.eventIndex, point]);
    },
    range(selection, point) {
      calls.range.push([selection, point]);
    },
    askLane(laneIndex, cycle, point) {
      calls.askLane.push([laneIndex, cycle, point]);
    },
    // What the page tells the panel of a range: the lane, the sections of its ends, and how many notes start in it.
    describeRange(selection) {
      calls.describeRange.push(selection);
      return { track: selection.laneIndex === 0 ? track : 'drums', section: null, sectionTo: null, count: selection.to - selection.from + 1, ...rangeInfo };
    },
    ...overrides,
  };
  // The page's timers, on a clock the test moves: the pause that gathers steps is 600 ms.
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const setTimer = (fn, ms) => {
    const id = nextTimer++;
    timers.set(id, { fn, at: clock + ms, ms });
    return id;
  };
  // The timers of the pause that gathers steps (an edit on its way has its own timer, the bounded wait for its answer).
  const pauses = () => [...timers.values()].filter((timer) => timer.ms === 600).length;
  const clearTimer = (id) => timers.delete(id);
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock && timers.has(id)) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  const view = createTimelineEditView({ document, lanes, panel, line, rootFontPx: () => REM, setTimer, clearTimer, handlers });
  const drawn = {
    pageStart: 0,
    lanes: [
      {
        index: 0,
        track,
        identity: 'label:t1',
        events: [{ begin: 0, value: { note: 'c3' } }, { begin: 2, value: { note: 'e3' } }, { begin: 4, value: { s: 'tick' } }, { begin: 6, value: { note: 'g3' } }],
        shapes: [note(0), note(2, 0.1), { kind: 'tick', x: 4, width: 1 }, note(6, 0.9)],
        rowCount: null,
        drumMap: null,
      },
      {
        index: 1,
        track: 'drums',
        identity: 'label:drums',
        events: [{ begin: 0, value: { note: 36 } }, { begin: 1, value: { note: 38 } }],
        shapes: [{ x: 0, width: 1, row: 1 }, { x: 1, width: 1, row: 0 }],
        rowCount: 2,
        drumMap: { name: 'GM', byNote: new Map([[36, 'Kick'], [38, 'Snare']]) },
      },
    ],
  };
  const read = {
    laneName: () => all(panel, 'tl-lane-name')[0],
    position: () => all(panel, 'tl-note-position')[0],
    state: () => all(panel, 'tl-note-state')[0],
    controls: () => all(panel, 'tl-note-controls')[0],
    values: () => all(panel, 'tl-value'),
    hint: () => all(panel, 'tl-note-hint')[0],
    buttons: () => all(panel, 'tl-btn'),
    rings: () => all(lanes, 'tl-ring'),
    fixed: () => all(panel, 'tl-fixed')[0],
  };
  /** A press and a release at the same point (x, y in pixels of the page). */
  const click = (x, y, extra = {}) => {
    lanes.dispatch('pointerdown', { pointerId: 1, clientX: x, clientY: y, ...extra });
    return lanes.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y, ...extra });
  };
  const key = (name, extra = {}) => lanes.dispatch('keydown', { key: name, ...extra });
  // The page answering the oldest edit it was handed and has not answered, by its id (by default an outcome that changes nothing
  // on screen). The page has one edit at a time: the next one is handed over only after this answer.
  const answer = (outcome = { kind: 'unchanged' }) => {
    assert.ok(unanswered.length > 0, 'an edit was handed over to be answered');
    view.showOutcome(unanswered.shift(), outcome);
  };
  // The lanes the page draws after a write: they go away while the new code is computed, and come back from it.
  const redraw = (next) => {
    view.onRedraw(null);
    view.onRedraw(next);
  };
  return { document, lanes, laneNodes, panel, line, view, drawn, calls, read, click, key, advance, timers, pauses, answer, redraw, unanswered };
}

/** Where lane 0's first note is drawn: cycle 0, in the middle of the lane. */
const FIRST_NOTE = { x: 150, y: 50 };

test('a click on a note selects it: the panel names the lane, the place, the state, the pitch and the velocity, and a ring marks the note', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  assert.equal(t.panel.hidden, false);
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.read.controls().hidden, true);
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintNone);
  const up = t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.deepEqual(t.calls.describe, [[0, 0]]);
  assert.equal(t.read.laneName().textContent, 't1');
  assert.equal(t.read.laneName().getAttribute('title'), 't1');
  assert.equal(t.read.position().textContent, ' · cycle 1, beat 2');
  assert.equal(t.read.state().textContent, 'Editable');
  assert.equal(t.read.controls().hidden, false);
  assert.deepEqual(t.read.values().map((node) => node.textContent), ['c3 · 48', '0.80']);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  assert.equal(t.line.getAttribute('data-kind'), 'standing');
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintEditable);
  assert.deepEqual(t.view.selection().laneIndex, 0);
  // The ring sits in the mark layer of lane 0, at the place the note is drawn, in percentages of the lane.
  const [ring] = t.read.rings();
  assert.equal(t.read.rings().length, 1);
  assert.equal(ring.parentNode, all(t.laneNodes[0], 'lane-marks')[0]);
  assert.equal(ring.style.left, '0%');
  assert.equal(ring.style.width, `${(1 / 32) * 100}%`);
  assert.equal(ring.style.top, `${(0.5 - 0.07) * 100}%`);
  assert.equal(ring.style.height, `${0.14 * 100}%`);
  // The pointer is taken by the lanes themselves and given back, and a click puts the focus on the lanes.
  assert.equal(t.lanes.captures, 1);
  assert.equal(t.lanes.capturedPointer, null);
  assert.equal(t.document.activeElement, t.lanes);
  assert.equal(up.defaultPrevented, false);
});

test('a note that cannot be edited says Not editable with its reason and the hint for a refused note', () => {
  const t = setup({ editable: false });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.read.state().textContent, 'Not editable');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteReasons.degrees);
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintRefused);
  assert.equal(t.read.controls().hidden, false);
});

test('a click on empty lane area clears the selection and its ring', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.notEqual(t.view.selection(), null);
  t.click(1500, 50);
  assert.equal(t.view.selection(), null);
  assert.equal(t.read.rings().length, 0);
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.read.controls().hidden, true);
  assert.equal(t.line.textContent, '');
  assert.equal(t.line.getAttribute('data-kind'), null);
  // A click on empty area with nothing selected writes nothing at all.
  const writes = t.document.writes;
  t.click(1500, 50);
  assert.equal(t.document.writes, writes);
});

test('a click on a note of a drum lane selects it and the ring sits on its row', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  // Lane 1's first note is on row 1 of 2: the lower half, the band from 62.5 to 87.5 of the 100 pixels of the lane.
  t.click(150, 100 + 75);
  assert.deepEqual(t.calls.describe, [[1, 0]]);
  assert.equal(t.read.laneName().textContent, 'drums');
  const [ring] = t.read.rings();
  assert.equal(ring.parentNode, all(t.laneNodes[1], 'lane-marks')[0]);
  assert.equal(ring.style.top, `${((1 + 0.25) / 2) * 100}%`);
  assert.equal(ring.style.height, `${(0.5 / 2) * 100}%`);
});

test('a press that moves half a rem is a drag and selects nothing; a quarter of a rem is still a click', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.lanes.dispatch('pointerdown', { pointerId: 1, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  t.lanes.dispatch('pointerup', { pointerId: 1, clientX: FIRST_NOTE.x + 0.3 * REM, clientY: FIRST_NOTE.y });
  assert.equal(t.view.selection(), null);
  assert.deepEqual(t.calls.describe, []);
  assert.equal(t.lanes.capturedPointer, null);
  t.lanes.dispatch('pointerdown', { pointerId: 2, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  t.lanes.dispatch('pointerup', { pointerId: 2, clientX: FIRST_NOTE.x + 0.2 * REM, clientY: FIRST_NOTE.y });
  assert.deepEqual(t.calls.describe, [[0, 0]]);
});

test('a right button, a Ctrl press, a press in the name column and a second pointer select nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y, { button: 2 });
  t.click(FIRST_NOTE.x, FIRST_NOTE.y, { ctrlKey: true });
  t.click(FIRST_NOTE.x, FIRST_NOTE.y, { metaKey: true });
  // The name column is left of the event area.
  t.click(40, 50);
  assert.equal(t.view.selection(), null);
  assert.deepEqual(t.calls.describe, []);
  assert.equal(t.lanes.captures, 0);
  // Another pointer going down while one is on its way is ignored.
  t.lanes.dispatch('pointerdown', { pointerId: 1, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  t.lanes.dispatch('pointerdown', { pointerId: 2, clientX: 1500, clientY: 50 });
  t.lanes.dispatch('pointerup', { pointerId: 2, clientX: 1500, clientY: 50 });
  assert.equal(t.view.selection(), null);
  t.lanes.dispatch('pointerup', { pointerId: 1, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  assert.deepEqual(t.calls.describe, [[0, 0]]);
});

test('a cancelled pointer or a lost capture ends the press without selecting', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.lanes.dispatch('pointerdown', { pointerId: 1, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  assert.equal(t.lanes.capturedPointer, 1);
  t.lanes.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(t.lanes.capturedPointer, null);
  t.lanes.dispatch('pointerup', { pointerId: 1, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  t.lanes.dispatch('pointerdown', { pointerId: 3, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  t.lanes.dispatch('lostpointercapture', { pointerId: 3 });
  t.lanes.dispatch('pointerup', { pointerId: 3, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  assert.equal(t.view.selection(), null);
  assert.deepEqual(t.calls.describe, []);
});

test('Up and Down on a selected note the page can edit are steps the page is asked for after the pause, and stop the key', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const up = t.key('ArrowUp');
  assert.deepEqual(t.calls.edit, [], 'a step waits for the pause');
  t.advance(600);
  t.answer();
  const down = t.key('ArrowDown');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: -1 }]]);
  for (const event of [up, down]) {
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
  }
});

test('Up and Down do nothing with nothing selected, on a refused note, on a held key or with Ctrl, Meta or Alt', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const idle = t.key('ArrowUp');
  assert.equal(idle.defaultPrevented, false, 'with nothing selected the lanes scroll as they always did');
  assert.equal(idle.stopped, false);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const held = t.key('ArrowUp', { repeat: true });
  assert.equal(held.stopped, true, 'a held key is consumed, not a run of steps');
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const event = t.key('ArrowDown', extra);
    assert.equal(event.stopped, false);
  }
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  refused.key('ArrowUp');
  refused.key('ArrowDown');
  refused.advance(5000);
  assert.deepEqual(refused.calls.edit, []);
});

test('Up, Down and the Shift steps on a note the page cannot edit write nothing and prepare the request at the middle of the note', () => {
  const t = setup({ editable: false });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const up = t.key('ArrowUp');
  t.key('ArrowDown');
  t.key('ArrowUp', { shiftKey: true });
  t.key('ArrowDown', { shiftKey: true });
  assert.equal(up.defaultPrevented, true);
  assert.equal(up.stopped, true);
  t.key('ArrowUp', { repeat: true });
  t.advance(5000);
  // Each press prepares at once (a refused note has nothing to gather), a held key is one press, nothing is written.
  assert.deepEqual(
    t.calls.prepare.map(([event, change]) => [event, change]),
    [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: -1 }], [0, { kind: 'pitch', semitones: 12 }], [0, { kind: 'pitch', semitones: -12 }]],
  );
  assert.deepEqual(t.calls.prepare[0][2], FIRST_NOTE, 'the box opens at the middle of the note');
  assert.deepEqual(t.calls.edit, []);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteRequestReady);
  assert.equal(t.line.getAttribute('data-kind'), 'result');
  assert.equal(TIMELINE_COPY.noteRequestReady, 'Request ready in the Ask box. Nothing is sent until you press Enter.');
});

test('the pitch buttons on a note the page cannot edit prepare the request too', () => {
  const t = setup({ editable: false });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const [down, up] = t.read.buttons();
  up.dispatch('click');
  down.dispatch('click');
  assert.deepEqual(t.calls.prepare.map(([, change]) => change), [{ kind: 'pitch', semitones: 1 }, { kind: 'pitch', semitones: -1 }]);
  assert.deepEqual(t.calls.edit, []);
});

test('when the page opens no box the panel does not say a request is ready', () => {
  const t = setup({ editable: false, handlers: { prepare: () => false } });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteReasons.degrees);
});

test('every other key goes on to the page: the view keys, the letters, Tab and the chords', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  for (const name of ['1', '2', '3', '4', '5', '6', 'a', 'b', 'c', 'Tab', 'F5', ' ']) {
    const event = t.key(name);
    assert.equal(event.stopped, false, name);
    assert.equal(event.defaultPrevented, false, name);
  }
  assert.deepEqual(t.calls.edit, []);
});

test('the two pitch buttons do what Down and Up do, with the words, names and titles of the contract', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const [down, up] = t.read.buttons();
  assert.deepEqual([down.textContent, up.textContent], ['Pitch down', 'Pitch up']);
  assert.deepEqual([down.getAttribute('aria-label'), up.getAttribute('aria-label')], ['Lower pitch by a semitone', 'Raise pitch by a semitone']);
  assert.equal(down.getAttribute('title'), 'Lower pitch by a semitone (Down). Shift: an octave.');
  assert.equal(up.getAttribute('title'), 'Raise pitch by a semitone (Up). Shift: an octave.');
  assert.deepEqual([down.getAttribute('type'), up.getAttribute('type')], ['button', 'button']);
  // With nothing selected the buttons are hidden with their group and a click does nothing.
  up.dispatch('click');
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  up.dispatch('click');
  t.advance(600);
  t.answer();
  down.dispatch('click');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: -1 }]]);
  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  refused.read.buttons()[1].dispatch('click');
  refused.advance(5000);
  assert.deepEqual(refused.calls.edit, []);
});

/** The panel button with this visible text. */
const buttonNamed = (t, text) => {
  const found = t.read.buttons().find((node) => node.textContent === text);
  assert.ok(found, `a button reading '${text}'`);
  return found;
};

test('Delete and Backspace on a selected note the page can edit turn it into a rest at once and stop the key', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const del = t.key('Delete');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }]], 'no gathering: the rest is asked for in the same turn');
  // The page refuses it; the next rest goes at once, because nothing is on its way.
  t.answer({ kind: 'refused', reason: 'read-back' });
  const back = t.key('Backspace');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }], [0, { kind: 'rest' }]]);
  for (const event of [del, back]) {
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
  }
});

test('Delete and Backspace go on to the page with nothing selected or with a modifier; on a refused note or a held key they are consumed and write nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  for (const name of ['Delete', 'Backspace']) {
    const idle = t.key(name);
    assert.equal(idle.stopped, false, `${name} with nothing selected`);
    assert.equal(idle.defaultPrevented, false);
  }
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(t.key('Delete', extra).stopped, false);
  }
  const held = t.key('Delete', { repeat: true });
  assert.equal(held.stopped, true);
  assert.deepEqual(t.calls.edit, []);
  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(refused.key('Delete').stopped, true);
  assert.deepEqual(refused.calls.edit, []);
});

test('the Make a rest button has the words of the contract, turns the selected note into a rest and does nothing on a refused note', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const rest = buttonNamed(t, 'Make a rest');
  assert.equal(rest.getAttribute('aria-label'), 'Turn this note into a rest');
  assert.equal(rest.getAttribute('title'), 'Turn this note into a rest (Delete)');
  assert.equal(rest.getAttribute('type'), 'button');
  rest.dispatch('click');
  assert.deepEqual(t.calls.edit, [], 'nothing selected');
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  rest.dispatch('click');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }]]);
  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(refused, 'Make a rest').dispatch('click');
  assert.deepEqual(refused.calls.edit, []);
});

test('after a rest the note leaves the lane: nothing is selected again, even where a note of the same pitch and time is drawn, and the sentence stays', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('Delete');
  t.answer({ kind: 'written', what: 'rest', label: 'x', from: 'c3', to: '~' });
  assert.equal(t.line.textContent, 'Changed c3 to a rest.');
  assert.equal(t.line.getAttribute('data-kind'), 'result');
  assert.notEqual(t.view.selection(), null, 'the ring stays until the lanes are drawn again');
  t.redraw(t.drawn);
  assert.equal(t.view.selection(), null);
  assert.equal(t.read.rings().length, 0);
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.line.textContent, 'Changed c3 to a rest.');
  // A rest that waits for its line says so and drops the key the same way.
  const w = setup();
  w.view.onRedraw(w.drawn);
  w.click(FIRST_NOTE.x, FIRST_NOTE.y);
  w.key('Backspace');
  w.answer({ kind: 'waiting', what: 'rest', label: 'x', from: 'c3', to: '~', at: 'bar' });
  assert.equal(w.line.textContent, 'Waiting for the next bar — c3 becomes a rest.');
  w.view.onRedraw(w.drawn);
  assert.equal(w.view.selection(), null);
});

test('quick presses of Up gather: the sentence follows the total, and the page is asked once, 600 ms after the last', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'c3 → c#3 (+1 semitone). Writing in a moment.');
  assert.equal(t.line.getAttribute('data-kind'), 'preview');
  t.advance(300);
  t.key('ArrowUp');
  t.advance(300);
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'c3 → d#3 (+3 semitones). Writing in a moment.');
  t.advance(599);
  assert.deepEqual(t.calls.edit, []);
  t.advance(1);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 3 }]], 'one change for the burst');
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  t.advance(10000);
  assert.equal(t.calls.edit.length, 1);
});

test('Shift with Up or Down is an octave, the pitch buttons a semitone, and a held key adds nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const up = t.key('ArrowUp', { shiftKey: true });
  assert.equal(up.stopped, true);
  assert.equal(t.line.textContent, 'c3 → c4 (+1 octave). Writing in a moment.');
  t.key('ArrowDown', { shiftKey: true });
  t.key('ArrowDown', { shiftKey: true });
  assert.equal(t.line.textContent, 'c3 → c2 (-1 octave). Writing in a moment.');
  t.key('ArrowDown', { repeat: true });
  t.key('ArrowDown', { repeat: true, shiftKey: true });
  assert.equal(t.line.textContent, 'c3 → c2 (-1 octave). Writing in a moment.', 'a held key is not a step');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: -12 }]]);
  t.answer();
  const [down, upButton] = t.read.buttons();
  upButton.dispatch('click');
  upButton.dispatch('click');
  down.dispatch('click');
  t.advance(600);
  assert.deepEqual(t.calls.edit[1], [0, { kind: 'pitch', semitones: 1 }]);
});

test('steps that cancel out write nothing and take the sentence away', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowDown');
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
});

test('Escape drops steps that were not written; with none left it goes on to the page', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  const first = t.key('Escape');
  assert.equal(first.stopped, true);
  assert.equal(first.defaultPrevented, true);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
  assert.equal(t.timers.size, 0, 'no timer is left');
  const second = t.key('Escape');
  // The next Escape clears the selection (and is the last thing it does); only after that does it go on to the page.
  assert.equal(second.stopped, true);
  assert.equal(t.view.selection(), null, 'the selection goes');
  assert.equal(t.key('Escape').stopped, false);
});

test('Escape takes back a burst whose pause is over but that waits behind another edit: it is not written, and the panel stops saying it will be', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.line.textContent, 'c#3 → d3 (+1 semitone). Writing in a moment.');
  const escape = t.key('Escape');
  assert.equal(escape.stopped, true);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.', 'the panel no longer says the burst will be written');
  assert.notEqual(t.view.selection(), null, 'the selection stays: Escape stepped back one thing');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  t.advance(20000);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]], 'only the first edit was written');
  // The next Escape clears the selection.
  t.key('Escape');
  assert.equal(t.view.selection(), null);
});

test('Delete, Backspace and Make a rest drop the steps that wait and write the rest at once', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowUp');
  t.key('Delete');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }]]);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  t.advance(5000);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }]], 'the steps are gone');
});

test('a step of the other kind writes the pending one first, so each kind is its own change', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowUp');
  buttonNamed(t, '+').dispatch('click');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 2 }]], 'the pitch steps are written at once');
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.90. Writing in a moment.');
  // The pitch write has no answer yet: the velocity burst becomes an edit of its own that waits its turn.
  t.advance(600);
  assert.equal(t.calls.edit.length, 1);
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.90. Writing in a moment.', 'its sentence stays while it waits');
  t.answer();
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 2 }], [0, { kind: 'velocity', steps: 1 }]]);
});

test('a selection change writes the steps that wait for the note they were aimed at, before the selection moves', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.click(350, 10);
  assert.equal(t.view.selection().eventIndex, 1);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]], 'the steps went out for the first note, at once');
  assert.equal(t.pauses(), 0, 'the pause is over');
  assert.notEqual(t.line.textContent, 'c3 → c#3 (+1 semitone). Writing in a moment.');
  t.advance(5000);
  assert.equal(t.calls.edit.length, 1, 'and only once');
});

test('Up, Right, Up, Right writes the first note and then the second', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 1);
  // The lanes come back from the first write before the second note is left.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.equal(t.view.selection().eventIndex, 1);
  t.key('ArrowUp');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 3, 'the walk skips the tick');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [1, { kind: 'pitch', semitones: 1 }]]);
  assert.equal(t.pauses(), 0);
});

test('every way off a note writes its waiting steps first: a click on empty area, a click on the same note, a range, a cursor and a drag that picks another note', () => {
  const clickEmpty = (t) => t.click(1500, 50);
  const clickSame = (t) => t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const widen = (t) => t.key('ArrowRight', { shiftKey: true });
  const lane = (t) => t.key('PageDown');
  const rangeDrag = (t) => dragRangeOn(t, 10, 12);
  const dragOther = (t) => {
    const p = press(t, { x: 350, y: 10 });
    p.move(10 - 1 * REM);
    p.up(10 - 1 * REM);
  };
  for (const [name, leave, drawnOf] of [
    ['a click on empty area', clickEmpty, (t) => t.drawn],
    ['a click on the same note', clickSame, (t) => t.drawn],
    ['Shift+Right', widen, (t) => t.drawn],
    ['Page Down onto a lane without notes', lane, (t) => withEmptyLane(t.drawn)],
    ['a range drag', rangeDrag, (t) => t.drawn],
    ['a drag that picks another note', dragOther, (t) => t.drawn],
  ]) {
    const t = setup();
    t.view.onRedraw(drawnOf(t));
    t.click(FIRST_NOTE.x, FIRST_NOTE.y);
    t.key('ArrowUp');
    t.key('ArrowUp');
    leave(t);
    assert.deepEqual(t.calls.edit.slice(0, 1), [[0, { kind: 'pitch', semitones: 2 }]], `${name}: the two steps went out for the first note`);
    assert.equal(t.pauses(), 0, `${name}: nothing is left waiting`);
  }
});

test('a pitch drag on the note that has steps waiting takes their place, and the panel says the steps were not written', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  const p = press(t);
  p.move(FIRST_NOTE.y - 5);
  assert.equal(t.timers.size, 0, 'the steps are not written behind the drag');
  p.up(FIRST_NOTE.y - 5);
  assert.deepEqual(t.calls.edit, [], 'a drag of no whole step writes nothing');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsNotWritten);
  assert.equal(t.line.getAttribute('data-kind'), 'refused');
});

test('a redraw that does not bring the note back drops the steps that wait, and the sentence names the note', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'c3 → c#3 (+1 semitone). Writing in a moment.');
  // The lanes come back for another page: the note is not there, and edits aimed at the page that went are dropped.
  t.view.onRedraw({ ...t.drawn, pageStart: 32 });
  assert.equal(t.view.selection(), null);
  assert.equal(t.line.textContent, `c3 on t1: ${TIMELINE_COPY.noteStepsNotWritten}`);
  assert.equal(t.line.getAttribute('data-kind'), 'refused');
  t.advance(20000);
  assert.deepEqual(t.calls.edit, [], 'steps for a note that is gone are never written');
  assert.equal(t.timers.size, 0);
  // Lanes that hold the note but not as it was (another pitch) do not bring it back either.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.view.onRedraw(withFirstNote(u.drawn, { note: 'f3' }));
  assert.equal(u.line.textContent, `c3 on t1: ${TIMELINE_COPY.noteStepsDropped}`);
  u.advance(20000);
  assert.deepEqual(u.calls.edit, []);
  // With no steps waiting a redraw says nothing about steps.
  const v = setup();
  v.view.onRedraw(v.drawn);
  v.click(FIRST_NOTE.x, FIRST_NOTE.y);
  v.view.onRedraw({ ...v.drawn, pageStart: 32 });
  assert.equal(v.line.textContent, '');
});

test('a redraw cuts the pause short: the steps that wait are handed over once the lanes are here, aimed at the note as they draw it', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(200);
  t.view.onRedraw(t.drawn);
  assert.equal(t.view.selection().eventIndex, 0);
  assert.deepEqual(t.calls.describe, [[0, 0], [0, 0]], 'the note was read again from the new lanes');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
  assert.equal(t.pauses(), 0);
  // Lanes that go away first: nothing is handed over until they are back.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.view.onRedraw(null);
  u.advance(5000);
  assert.deepEqual(u.calls.edit, []);
  u.view.onRedraw(u.drawn);
  assert.deepEqual(u.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
});

test('steps taken while an edit is on its way wait in the queue until its answer and its lanes have come, then go aimed at the new code', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.calls.edit.length, 1);
  t.key('ArrowUp');
  t.key('ArrowUp');
  // The pause ends while the first edit has no answer: the burst is one edit in the queue, and its sentence stays.
  t.advance(600);
  t.advance(600);
  assert.equal(t.calls.edit.length, 1, 'one edit at a time');
  assert.equal(t.line.textContent, 'c#3 → d#3 (+2 semitones). Writing in a moment.', 'the burst is shown from the c#3 the edit on its way will write');
  // The answer says it was written, but the new lanes are not here yet: the next edit still waits.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  t.advance(600);
  assert.equal(t.calls.edit.length, 1, 'it waits for the lanes drawn from the new code');
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.equal(t.view.selection().eventIndex, 0);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: 2 }]]);
  assert.deepEqual(t.calls.describe.at(-1), [0, 0], 'the note was read again from the new lanes');
  assert.equal(t.line.textContent, 'Changed c3 to c#3.', 'the sentence of the first edit, now that the second is handed over');
});

test('an edit that was refused, or whose lanes came before its answer, holds nothing back for long', () => {
  // Refused: no lanes are coming.
  const refused = setup();
  refused.view.onRedraw(refused.drawn);
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  refused.key('ArrowUp');
  refused.advance(600);
  refused.key('ArrowDown');
  refused.answer({ kind: 'refused', reason: 'read-back' });
  refused.advance(600);
  assert.equal(refused.calls.edit.length, 2, 'the held steps go out once the refusal is told');
  // The lanes were drawn before the answer: the answer does not wait for lanes that already came.
  const early = setup();
  early.view.onRedraw(early.drawn);
  early.click(FIRST_NOTE.x, FIRST_NOTE.y);
  early.key('ArrowUp');
  early.advance(600);
  early.view.onRedraw(null);
  early.view.onRedraw(withFirstNote(early.drawn, { note: 'c#3' }));
  early.key('ArrowUp');
  early.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  early.advance(600);
  assert.equal(early.calls.edit.length, 2);
});

test('while a pointer drag is in progress the keys do not act on the note; Escape still ends the drag', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(t.lanes.getAttribute('data-dragging'), 'pitch');
  for (const name of ['ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'ArrowRight', 'Home', 'PageDown', 'Enter']) t.key(name);
  assert.equal(t.timers.size, 0, 'no step was gathered');
  assert.equal(t.view.selection().eventIndex, 0, 'the selection did not move');
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.ask, []);
  const escape = t.key('Escape');
  assert.equal(escape.stopped, true);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  p.up(FIRST_NOTE.y - 1.1 * REM);
  assert.deepEqual(t.calls.edit, [], 'a cancelled drag writes nothing');
  // With the drag over the keys work again.
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.calls.edit.length, 1);
});

/** Runs `fn` with console.error caught, and gives back what it was given. */
function quietErrors(fn) {
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = error;
  }
  return errors.join('\n');
}

test('an answer late by ten seconds is said to be late; the next edit waits for it ten seconds more, because the page may still write it, and the late answer is told', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.calls.edit.length, 1);
  const errors = quietErrors(() => {
    t.advance(9399);
    assert.equal(t.calls.edit.length, 1, 'the first edit has ten seconds to be answered');
    t.advance(1);
  });
  assert.equal(t.line.textContent, TIMELINE_COPY.noteEditTimeout);
  assert.equal(TIMELINE_COPY.noteEditTimeout, 'The page did not answer this edit in time, so check the code.');
  assert.match(errors, /did not answer a Timeline edit within 10000 ms; the next edit waits for that answer a while longer/);
  assert.equal(t.calls.edit.length, 1, 'the next edit is not aimed at code the late edit may still change');
  // The late answer of the first edit is told, and the next edit goes at once.
  t.answer({ kind: 'refused', reason: 'read-back' });
  assert.equal(t.line.textContent, TIMELINE_COPY.noteReadBack);
  assert.equal(t.calls.edit.length, 2);
  t.key('ArrowDown');
  t.advance(600);
  assert.equal(t.calls.edit.length, 2, 'the second edit has not been answered: the next waits');
  t.answer();
  assert.equal(t.calls.edit.length, 3);
  // An answer that never comes at all holds the queue for ten seconds more, then the queue goes on.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.advance(600);
  u.key('ArrowUp');
  u.advance(600);
  const never = quietErrors(() => {
    u.advance(10000);
    u.advance(9999);
    assert.equal(u.calls.edit.length, 1);
    u.advance(1);
  });
  assert.match(never, /never answered a Timeline edit; the next edit goes on/);
  assert.equal(u.calls.edit.length, 2);
  // An answer after that is still told, and the edit now on its way keeps its place.
  u.answer({ kind: 'refused', reason: 'read-back' });
  assert.equal(u.line.textContent, TIMELINE_COPY.noteReadBack);
  u.answer();
  assert.equal(u.timers.size, 0);
});

test('a late answer that waits for its line keeps the edits made after it, and they go once the change took over', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  quietErrors(() => t.advance(10000));
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.line.textContent, 'c#3 → d3 (+1 semitone). Writing in a moment.');
  t.answer({ kind: 'waiting', what: 'pitch', label: 'x', from: 'c3', to: 'c#3', at: 'bar' });
  assert.doesNotMatch(t.line.textContent, /not written/, 'the burst made after the late notice is not dropped');
  t.view.finishWait({ tookOver: true });
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: 1 }]], 'the burst goes, aimed at c#3');
  assert.equal(t.view.selection().eventIndex, 0);
});

test('an edit on its way when the page turns still holds the queue: the next edit goes only after its answer and the lanes it brings', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.view.onRedraw(null);
  t.view.onRedraw({ ...t.drawn, pageStart: 32 });
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('Delete');
  assert.equal(t.calls.edit.length, 1, 'the rest on the new page waits for the edit on its way');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.calls.edit.length, 1, 'the lanes of the new page were drawn before the write: the rest waits for the lanes after it');
  t.redraw({ ...t.drawn, pageStart: 32 });
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'rest' }]]);
});

test('Up, Right, Up, Right, Up on a slow page, with no answer between the moves: every note gets its steps, one edit at a time, each aimed at its own note', () => {
  const tokens = ['c3', 'e3', null, 'g3'];
  const t = setup({ info: (laneIndex, eventIndex) => (laneIndex === 0 && tokens[eventIndex] !== null ? { noteText: tokens[eventIndex], seen: { token: { start: 3, end: 5, text: tokens[eventIndex] } } } : {}) });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.view.selection().eventIndex, 3);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]], 'the page has one edit at a time; the others wait');
  assert.equal(t.line.textContent, 'g3 → g#3 (+1 semitone). Writing in a moment.', 'the selected note shows its own steps while they wait');
  // The page answers the first edit and draws the lanes from the new code: the second edit goes, aimed at e3.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  const once = withFirstNote(t.drawn, { note: 'c#3' });
  t.redraw(once);
  assert.deepEqual(t.calls.edit.at(-1), [1, { kind: 'pitch', semitones: 1 }]);
  assert.equal(t.view.selection().eventIndex, 3, 'the selection stays on g3');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'e3', to: 'f3' });
  assert.equal(t.line.textContent, 'g3 → g#3 (+1 semitone). Writing in a moment.', 'the answer of another note does not take over the selected note\'s panel');
  const twice = { ...once, lanes: once.lanes.map((lane, index) => (index === 0 ? { ...lane, events: lane.events.map((entry, at) => (at === 1 ? { ...entry, value: { note: 'f3' } } : entry)) } : lane)) };
  t.redraw(twice);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [1, { kind: 'pitch', semitones: 1 }], [3, { kind: 'pitch', semitones: 1 }]]);
  assert.equal(t.line.textContent, 'e3 on t1: Changed e3 to f3.', 'once g3\'s steps are handed over, the answer of e3 shows, named after e3');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'g3', to: 'g#3' });
  assert.equal(t.line.textContent, 'Changed g3 to g#3.', 'the answer of the selected note is its own sentence');
  assert.equal(t.timers.size, 1, 'only the wait for the last lanes is left');
});

test('a chord: steps on two notes that begin together each land on their own note, and the redraw keeps the selection on the second', () => {
  const tokens = ['c3', 'e3'];
  const t = setup({ info: (laneIndex, eventIndex) => (laneIndex === 0 && eventIndex < 2 ? { noteText: tokens[eventIndex], seen: { token: { start: 3 + 3 * eventIndex, end: 5 + 3 * eventIndex, text: tokens[eventIndex] } } } : {}) });
  const chord = (first) => ({
    ...t.drawn,
    lanes: t.drawn.lanes.map((lane, index) =>
      index === 0 ? { ...lane, events: [{ begin: 0, value: { note: first } }, { begin: 0, value: { note: 'e3' } }, { begin: 2, value: { note: 'g3' } }], shapes: [note(0), note(0, 0.1), note(2)] } : lane,
    ),
  });
  t.view.onRedraw(chord('c3'));
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 1, 'Right goes to e3, which begins with c3');
  t.key('ArrowUp');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
  // The answer for c3 comes while e3 is selected: it is named after c3, and e3 keeps its own panel.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.line.textContent, 'e3 → f3 (+1 semitone). Writing in a moment.');
  t.redraw(chord('c#3'));
  assert.equal(t.view.selection().eventIndex, 1, 'the selection stays on e3, not on c3 at its new pitch');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [1, { kind: 'pitch', semitones: 1 }]], 'e3 gets its own step; c3 is raised once');
  assert.equal(t.line.textContent, 'c3 on t1: Changed c3 to c#3.');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'e3', to: 'f3' });
  assert.equal(t.line.textContent, 'Changed e3 to f3.');
});

/**
 * A chord on lane 0: the notes `notes` begin together at cycle 0, each from its own token (the k-th at offset 3 + 4k of the
 * code), then g3 at cycle 2. `order` lists the chord as the lane gives it (indexes into `notes`), which need not be the order of
 * the code.
 */
function chordLanes(t, notes, order = notes.map((_, k) => k)) {
  const chord = order.map((k) => ({ begin: 0, value: { note: notes[k] }, locations: [{ start: 3 + 4 * k, end: 3 + 4 * k + notes[k].length }] }));
  return {
    ...t.drawn,
    lanes: t.drawn.lanes.map((lane, index) =>
      index === 0
        ? { ...lane, events: [...chord, { begin: 2, value: { note: 'g3' }, locations: [{ start: 40, end: 42 }] }], shapes: [...chord.map((_, k) => note(0, 0.1 + 0.2 * k)), note(2)] }
        : lane,
    ),
  };
}

/**
 * A view whose page describes each note that has its places in the code from the lanes shown now: its token is the event's own
 * place and text, and its lane is named as the lane is.
 */
function chordSetup() {
  let shown = null;
  const t = setup({
    info: (laneIndex, eventIndex) => {
      if (shown === null) return {};
      const lane = shown.lanes[laneIndex];
      const entry = lane.events[eventIndex];
      if (!Array.isArray(entry.locations)) return {};
      const [place] = entry.locations;
      return { track: lane.track, noteText: entry.value.note, seen: { token: { start: place.start, end: place.end, text: entry.value.note } } };
    },
  });
  const show = (next) => {
    shown = next;
    t.view.onRedraw(next);
  };
  // The page's real order after a write: the lanes go away, then come back from the new code.
  const redrawFrom = (next) => {
    t.view.onRedraw(null);
    show(next);
  };
  return { ...t, show, redrawFrom };
}

test('a chord: an edit that waits behind a refused edit of the same note goes to that note, not to the chord note whose pitch was asked for', () => {
  // [c3,d3]: d3 is lowered twice, which asks for c3; then raised once while that edit is on its way.
  const t = chordSetup();
  t.show(chordLanes(t, ['c3', 'd3']));
  t.key('ArrowRight');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 1, 'd3 is selected');
  t.key('ArrowDown');
  t.key('ArrowDown');
  t.advance(600);
  t.key('ArrowUp');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[1, { kind: 'pitch', semitones: -2 }]]);
  t.answer({ kind: 'refused', reason: 'read-back' });
  assert.deepEqual(t.calls.edit, [[1, { kind: 'pitch', semitones: -2 }], [1, { kind: 'pitch', semitones: 1 }]], 'the raise goes to d3, the note it was pressed on, never to c3');
});

test('a chord: after a refused edit, a redraw selects the same note again and later steps go to it', () => {
  const t = chordSetup();
  const lanes = chordLanes(t, ['c3', 'd3']);
  t.show(lanes);
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowDown');
  t.key('ArrowDown');
  t.advance(600);
  t.answer({ kind: 'refused', reason: 'read-back' });
  t.redrawFrom(lanes);
  assert.equal(t.view.selection().eventIndex, 1, 'd3 is selected again, not c3');
  t.key('ArrowUp');
  t.advance(600);
  assert.deepEqual(t.calls.edit.at(-1), [1, { kind: 'pitch', semitones: 1 }]);
});

test('a chord: picking another chord note while an edit is on its way does not take that edit\'s place, its refusal or its Ask Claude', () => {
  const t = chordSetup();
  t.show(chordLanes(t, ['c3', 'd3']));
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowDown');
  t.key('ArrowDown');
  t.advance(600);
  // c3 has the pitch d3's edit asks for: picking it is still picking c3.
  t.key('ArrowLeft');
  assert.equal(t.view.selection().eventIndex, 0);
  t.answer({ kind: 'refused', reason: 'read-back' });
  assert.equal(t.line.textContent, `d3 on t1: ${TIMELINE_COPY.noteReadBack}`, 'the refusal is named after d3');
  buttonNamed(t, 'Ask Claude').dispatch('click');
  t.key('Enter');
  assert.deepEqual(t.calls.prepare, [], 'no lowering of d3 is prepared for c3');
  assert.deepEqual(t.calls.ask.map(([event]) => event), [0, 0]);
});

test('a chord: a write that gives one chord note the pitch of another leaves each edit on its own note', () => {
  // [c3,d3]: c3 is raised to d3, then d3 is raised once; the redraw draws [d3,d3].
  const t = chordSetup();
  t.show(chordLanes(t, ['c3', 'd3']));
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.key('ArrowUp');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 1);
  t.key('ArrowUp');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 2 }]]);
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'd3' });
  t.redrawFrom(chordLanes(t, ['d3', 'd3']));
  assert.equal(t.view.selection().eventIndex, 1, 'the selection stays on the note that was d3');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 2 }], [1, { kind: 'pitch', semitones: 1 }]], 'd3 is raised, not the note c3 became');
});

test('a chord of three notes, two of the same pitch: each edit is aimed at its rank in the code, even when the lane lists the chord in another order', () => {
  // [c3,e3,e3]: the second e3 is raised, then raised again while the first raise is on its way.
  const t = chordSetup();
  t.show(chordLanes(t, ['c3', 'e3', 'e3']));
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 2, 'the second e3');
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'e3', to: 'f3' });
  // The lane lists the new chord as f3, c3, e3; the code still holds c3, e3, f3.
  t.redrawFrom(chordLanes(t, ['c3', 'e3', 'f3'], [2, 0, 1]));
  assert.equal(t.view.selection().eventIndex, 0, 'the selection is the f3 the second e3 became, wherever the lane lists it');
  assert.deepEqual(t.calls.edit, [[2, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: 1 }]], 'the second raise goes to f3, not to the first e3');
  // A note at that rank with neither the pitch it had nor the one asked for is another note: nothing is aimed at it.
  const u = chordSetup();
  u.show(chordLanes(u, ['c3', 'e3', 'e3']));
  u.key('ArrowRight');
  u.key('ArrowRight');
  u.key('ArrowRight');
  u.key('ArrowDown');
  u.key('ArrowDown');
  u.key('ArrowDown');
  u.key('ArrowDown');
  u.advance(600);
  u.key('ArrowUp');
  u.advance(600);
  u.answer({ kind: 'refused', reason: 'read-back' });
  assert.deepEqual(u.calls.edit.at(-1), [2, { kind: 'pitch', semitones: 1 }], 'after a refusal of e3 to c3, the raise goes to the same e3, not to c3 or the other e3');
  u.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'e3', to: 'f3' });
  u.key('ArrowUp');
  u.advance(600);
  u.redrawFrom(chordLanes(u, ['c3', 'e3', 'a3']));
  assert.equal(u.calls.edit.length, 2, 'a3 is neither the f3 written nor a pitch asked for: nothing is written to it');
  assert.equal(u.view.selection(), null);
  assert.equal(u.line.textContent, `f3 on t1: ${TIMELINE_COPY.noteStepsDropped}`, 'the sentence names the note');
});

test('a chord: after a rest, the notes after it in the code are found again from the lanes drawn after it, so their edits still find them', () => {
  const t = chordSetup();
  t.show(chordLanes(t, ['c3', 'e3', 'g3']));
  t.key('ArrowRight');
  t.key('Delete');
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', what: 'rest', label: 'x', from: 'c3', to: '~' });
  // The rest leaves e3 and g3, from the tokens they had.
  const after = chordLanes(t, ['c3', 'e3', 'g3']);
  after.lanes[0].events.splice(0, 1);
  after.lanes[0].shapes.splice(0, 1);
  t.redrawFrom(after);
  assert.equal(t.view.selection().eventIndex, 0, 'e3 is selected again');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }], [0, { kind: 'pitch', semitones: 1 }]]);
});

/**
 * Lanes drawn from code, every note beginning at cycle 0: each lane is `{ index, identity, track, notes }`, where `notes` lists
 * the lane's notes as the lane gives them, each `[text, start]` (its token and the token's start offset in the code).
 */
function codeLanes(specs) {
  return {
    pageStart: 0,
    lanes: specs.map(({ index, identity, track, notes }) => ({
      index,
      identity,
      track,
      events: notes.map(([text, start]) => ({ begin: 0, value: { note: text }, locations: [{ start, end: start + text.length }] })),
      shapes: notes.map((_, k) => note(0, 0.1 + 0.2 * k)),
      rowCount: null,
      drumMap: null,
    })),
  };
}

test('two tracks without a name: an edit queued for the second goes to it, even when a write gives the first the strings of the second', () => {
  // `$: note("[c3,e3]")` then `$: note("[c#3,e3]")`: each lane's identity is built from its strings, so it changes with every write.
  const t = chordSetup();
  const lanes = (first) =>
    codeLanes([
      { index: 0, identity: `note:[${first},e3]`, track: 'piano', notes: [[first, 10], ['e3', 10 + first.length + 1]] },
      { index: 1, identity: first === 'c#3' ? 'note:[c#3,e3] #2' : 'note:[c#3,e3]', track: 'piano 2', notes: [['c#3', 40], ['e3', 44]] },
    ]);
  t.show(lanes('c3'));
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.advance(600);
  t.key('PageDown');
  t.key('ArrowRight');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [1, 1], 'the e3 of the second track');
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  // The first track now has the strings of the second, so it takes the plain identity and the second gets ' #2'.
  t.redrawFrom(lanes('c#3'));
  assert.deepEqual(t.calls.editLanes, [0, 1], 'the queued raise goes to the second track');
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [1, { kind: 'pitch', semitones: 1 }]], 'and to its e3');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [1, 1], 'the selection stays on the second track');
});

test('a track without a name renamed by every write: queued edits of a chord note still land on that note after a rest beside it', () => {
  // `$: note("[c3,e3,g3,g3]")`: e3 is raised, the first g3 gets a velocity step, e3 is made a rest, the first g3 gets another
  // velocity step, and the selection moves to c3. Each write gives the lane a new identity.
  const t = chordSetup();
  const lanes = (identity, notes) => codeLanes([{ index: 0, identity, track: 'piano', notes }]);
  t.show(lanes('note:[c3,e3,g3,g3]', [['c3', 7], ['e3', 10], ['g3', 13], ['g3', 16]]));
  t.key('ArrowRight');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 1, 'e3');
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 2, 'the first g3');
  buttonNamed(t, '+').dispatch('click');
  t.key('ArrowLeft');
  t.key('Delete');
  t.key('ArrowRight');
  buttonNamed(t, '+').dispatch('click');
  t.key('ArrowLeft');
  t.key('ArrowLeft');
  assert.equal(t.view.selection().eventIndex, 0, 'c3');
  assert.deepEqual(t.calls.edit, [[1, { kind: 'pitch', semitones: 1 }]]);
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'e3', to: 'f3' });
  t.redrawFrom(lanes('note:[c3,f3,g3,g3]', [['c3', 7], ['f3', 10], ['g3', 13], ['g3', 16]]));
  assert.deepEqual(t.calls.edit.at(-1), [2, { kind: 'velocity', steps: 1 }]);
  t.answer({ kind: 'written', what: 'velocity', label: 'x', from: '0.8', to: '0.9' });
  t.redrawFrom(lanes('note:[c3,f3,g3,g3]|velocity:0.9', [['c3', 7], ['f3', 10], ['g3', 13], ['g3', 16]]));
  assert.deepEqual(t.calls.edit.at(-1), [1, { kind: 'rest' }]);
  t.answer({ kind: 'written', what: 'rest', label: 'x', from: 'f3', to: '~' });
  // The rest writes `~` for `f3`: the tokens after it move one place to the left.
  t.redrawFrom(lanes('note:[c3,~,g3,g3]|velocity:0.9', [['c3', 7], ['g3', 12], ['g3', 15]]));
  assert.deepEqual(t.calls.edit, [[1, { kind: 'pitch', semitones: 1 }], [2, { kind: 'velocity', steps: 1 }], [1, { kind: 'rest' }], [1, { kind: 'velocity', steps: 1 }]], 'the second velocity step goes to the first g3, never to the second');
});

/** `note("[c3,e3,e3]")` on lane 0 (named t1), each token at its place in the code; `notes` replaces the chord. */
const threeNotes = (notes = [['c3', 7], ['e3', 10], ['e3', 13]]) => codeLanes([{ index: 0, identity: 'label:t1', track: 't1', notes }]);

/** A view on `note("[c3,e3,e3]")` where the first e3 was made a rest and the second e3 is selected, with `steps` raises queued. */
function restBesideSecondE3({ steps = 0, late = false } = {}) {
  const t = chordSetup();
  t.show(threeNotes());
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('Delete');
  assert.deepEqual(t.calls.edit, [[1, { kind: 'rest' }]], 'the first e3 is made a rest');
  if (late) quietErrors(() => t.advance(10000));
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 2, 'the second e3');
  for (let k = 0; k < steps; k++) t.key('ArrowUp');
  if (steps > 0) t.advance(600);
  return t;
}

test('a rest that comes late, waits for its line and never takes over: the edit queued for the note beside it is not written, and is said so', () => {
  const t = restBesideSecondE3({ steps: 1, late: true });
  t.answer({ kind: 'waiting', what: 'rest', label: 'x', from: 'e3', to: '~', at: 'bar' });
  assert.equal(t.calls.edit.length, 1, 'the raise waits for the end of the wait');
  t.view.finishWait({ tookOver: false });
  assert.deepEqual(t.calls.edit, [[1, { kind: 'rest' }]], 'the raise goes neither to the first e3 nor to the second');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsNotWritten);
  // The lanes drawn again do not bring a guess back: nothing is selected, and a fresh pick of the second e3 works as any.
  t.redrawFrom(threeNotes());
  assert.equal(t.view.selection(), null);
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.advance(600);
  assert.deepEqual(t.calls.edit.at(-1), [2, { kind: 'pitch', semitones: 1 }]);
});

test('a rest that waits for its line and never takes over: a redraw selects nothing rather than another note of the chord', () => {
  const t = restBesideSecondE3();
  t.answer({ kind: 'waiting', what: 'rest', label: 'x', from: 'e3', to: '~', at: 'bar' });
  t.view.finishWait({ tookOver: false });
  t.redrawFrom(threeNotes());
  assert.equal(t.view.selection(), null, 'the first e3, drawn where the second is, is not selected in its place');
  t.key('ArrowUp');
  t.advance(600);
  assert.equal(t.calls.edit.length, 1, 'nothing is written');
});

test('an error at or after the write of a rest: the edit queued for the note beside it is not written, and is said so after the error', () => {
  const t = restBesideSecondE3({ steps: 1 });
  t.answer({ kind: 'refused', reason: 'error', afterWrite: true, error: new Error('lost') });
  assert.equal(t.line.textContent, `e3 on t1: ${TIMELINE_COPY.noteEditErrorWritten} ${TIMELINE_COPY.noteStepsNotWritten}`);
  t.redrawFrom(threeNotes());
  assert.deepEqual(t.calls.edit, [[1, { kind: 'rest' }]], 'the raise goes to no note');
  assert.equal(t.view.selection(), null);
});

test('a rest whose lanes after it do not show the chord without it: the edits queued beside it are not written, and nothing is selected again', () => {
  const t = restBesideSecondE3({ steps: 1 });
  t.answer({ kind: 'written', what: 'rest', label: 'x', from: 'e3', to: '~' });
  // The second e3 is drawn as f3: not the chord the rest leaves, so the page cannot tell which note is which.
  t.redrawFrom(threeNotes([['c3', 7], ['f3', 12]]));
  assert.deepEqual(t.calls.edit, [[1, { kind: 'rest' }]]);
  assert.equal(t.view.selection(), null);
  assert.equal(t.line.textContent, `e3 on t1: Changed e3 to a rest. e3 on t1: ${TIMELINE_COPY.noteStepsNotWritten}`);
  // A rest that the page refused wrote nothing: the note beside it keeps its rank, and its edit goes.
  const u = restBesideSecondE3({ steps: 1 });
  u.answer({ kind: 'refused', reason: 'read-back' });
  assert.deepEqual(u.calls.edit, [[1, { kind: 'rest' }], [2, { kind: 'pitch', semitones: 1 }]]);
});

test('a rest of a note drawn twice by a layered copy takes both away: an edit of a copy beside it lands on that copy', () => {
  // `note("[c3,e3,g3]").superimpose(...)`: each token draws two notes at the same place in the code; the copies come after.
  const t = chordSetup();
  const before = [['c3', 7], ['e3', 10], ['g3', 13]];
  t.show(threeNotes([...before, ...before]));
  t.key('ArrowRight');
  t.key('Delete');
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowRight');
  assert.equal(t.view.selection().eventIndex, 4, 'the copy of e3');
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', what: 'rest', label: 'x', from: 'c3', to: '~' });
  // `~` replaces `c3`: both notes of c3 are gone and the tokens after it move one place to the left.
  const after = [['e3', 9], ['g3', 12]];
  t.redrawFrom(threeNotes([...after, ...after]));
  assert.deepEqual(t.calls.edit, [[0, { kind: 'rest' }], [2, { kind: 'pitch', semitones: 1 }]], 'the raise goes to the copy of e3');
  assert.equal(t.view.selection().eventIndex, 2);
  assert.doesNotMatch(t.line.textContent, /not written/);
});

test('a second burst or a drag while an edit of the same note waits or is on its way is shown, and held at the ends, from the value that edit will write', () => {
  // Pitch: the second burst starts from c#3.
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'c#3 → d3 (+1 semitone). Writing in a moment.');
  t.advance(600);
  // A third burst behind both: from d3.
  t.key('ArrowUp', { shiftKey: true });
  assert.equal(t.line.textContent, 'd3 → d4 (+1 octave). Writing in a moment.');
  t.advance(600);
  // A drag behind all three starts from d4.
  const p = press(t);
  p.move(FIRST_NOTE.y - STEP - 1);
  assert.equal(t.line.textContent, 'd4 → d#4 (+1 semitone). Release to write.');
  p.up(FIRST_NOTE.y - STEP - 1);
  // Once the first edit's lanes are drawn, the token drawn is the start again.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  const u = setup({ tokenText: 'c#3' });
  u.view.onRedraw(withFirstNote(u.drawn, { note: 'c#3' }));
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  assert.equal(u.line.textContent, 'c#3 → d3 (+1 semitone). Writing in a moment.');
  // Velocity: the second burst starts from 0.90, and a step past 1.00 is held there with the limit sentence.
  const v = setup();
  v.view.onRedraw(v.drawn);
  v.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(v, '+').dispatch('click');
  v.advance(600);
  buttonNamed(v, '+').dispatch('click');
  assert.equal(v.line.textContent, 'Velocity 0.90 → 1.00. Writing in a moment.');
  v.advance(600);
  buttonNamed(v, '+').dispatch('click');
  assert.equal(v.line.textContent, TIMELINE_COPY.noteVelocityHighest, 'the queued edits reach 1.00: a third step is at the limit');
  assert.equal(v.pauses(), 0, 'and nothing is gathered');
  // Pitch at the top of the range: the limit is the one the queued edit reaches.
  const w = setup({ tokenText: 'f#9' });
  w.view.onRedraw(w.drawn);
  w.click(FIRST_NOTE.x, FIRST_NOTE.y);
  w.key('ArrowUp');
  w.advance(600);
  w.key('ArrowUp');
  assert.equal(w.line.textContent, TIMELINE_COPY.noteHighest, 'g9 is the highest: a step past what the queued edit writes is held');
  assert.equal(w.pauses(), 0);
});

test('a step of the other kind while an edit is on its way is its own edit: a velocity step never joins a pitch burst, nor an octave a velocity burst', () => {
  // Velocity after pitch bursts.
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  t.key('ArrowUp');
  t.advance(600);
  buttonNamed(t, '+').dispatch('click');
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.90. Writing in a moment.');
  t.advance(600);
  assert.equal(t.calls.edit.length, 1);
  t.answer();
  t.answer();
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: 2 }], [0, { kind: 'velocity', steps: 1 }]]);
  // An octave after velocity bursts.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(u, '+').dispatch('click');
  u.advance(600);
  buttonNamed(u, '+').dispatch('click');
  u.advance(600);
  u.key('ArrowUp', { shiftKey: true });
  assert.equal(u.line.textContent, 'c3 → c4 (+1 octave). Writing in a moment.');
  u.advance(600);
  u.answer();
  u.answer();
  assert.deepEqual(u.calls.edit, [[0, { kind: 'velocity', steps: 1 }], [0, { kind: 'velocity', steps: 1 }], [0, { kind: 'pitch', semitones: 12 }]]);
});

test('a rest and a drag release while an edit is on its way wait their turn and go aimed at the note as redrawn', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('Delete');
  assert.equal(t.calls.edit.length, 1, 'the rest waits for the edit before it');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.calls.edit.length, 1, 'and for the lanes that edit brings');
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'rest' }]]);
  // A drag release on its way behind a refused edit goes once the refusal is told.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.advance(600);
  const p = press(u);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  p.up(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(u.calls.edit.length, 1);
  u.answer({ kind: 'refused', reason: 'read-back' });
  assert.deepEqual(u.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: 2 }]]);
  // A rest whose note is not in the new lanes is not written, and the sentence names the note.
  const v = setup();
  v.view.onRedraw(v.drawn);
  v.click(FIRST_NOTE.x, FIRST_NOTE.y);
  v.key('ArrowUp');
  v.advance(600);
  v.key('Delete');
  v.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  v.redraw(withFirstNote(v.drawn, { note: 'a3' }));
  assert.equal(v.calls.edit.length, 1);
  assert.equal(v.line.textContent, `c#3 on t1: ${TIMELINE_COPY.noteChangeDropped}`);
  assert.equal(TIMELINE_COPY.noteChangeDropped, 'The change was not written: the note changed in the code. Select it again.');
});

test('a refusal for a note the selection has left is named after that note and does not arm Ask Claude for the selected one', () => {
  const tokens = ['c3', 'e3'];
  const t = setup({ info: (laneIndex, eventIndex) => (laneIndex === 0 && eventIndex < 2 ? { noteText: tokens[eventIndex], seen: { token: { start: 3, end: 5, text: tokens[eventIndex] } } } : {}) });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowRight');
  t.answer({ kind: 'refused', reason: 'read-back' });
  assert.equal(t.line.textContent, `c3 on t1: ${TIMELINE_COPY.noteReadBack}`);
  buttonNamed(t, 'Ask Claude').dispatch('click');
  assert.deepEqual(t.calls.prepare, [], 'no request about c3 is put in the box of e3');
  assert.deepEqual(t.calls.ask.map(([event]) => event), [1]);
  // The answer that comes while the lanes are away, for the note that comes back, is that note's own.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.advance(600);
  u.view.onRedraw(null);
  u.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  u.view.onRedraw(withFirstNote(u.drawn, { note: 'c#3' }));
  assert.equal(u.line.textContent, 'Changed c3 to c#3.');
  assert.equal(u.view.selection().eventIndex, 0);
});

test('closing the Timeline drops the steps and the edits that wait, names the note, and hands nothing over until lanes are drawn again; the edit on its way is still the page\'s', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  t.advance(600);
  buttonNamed(t, '+').dispatch('click');
  t.view.close();
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsNotWritten, 'the note is the one shown, so it is not named');
  assert.equal(t.pauses(), 0, 'no pause is left');
  assert.equal(t.timers.size, 1, 'only the wait for the answer of the edit the page is still running');
  // The answer of the edit that was on its way still comes, and is told; nothing goes after it.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
  t.key('Delete');
  assert.equal(quietErrors(() => t.advance(20000)), '', 'the written edit waits for no lanes while the Timeline is closed, so no error is logged');
  assert.equal(t.timers.size, 0, 'and it is settled');
  assert.equal(t.calls.edit.length, 1, 'nothing is handed over while the Timeline is closed');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteChangeNotWritten);
  // Opened again, the lanes are drawn and edits go as before.
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('Delete');
  assert.equal(t.calls.edit.length, 2);
});

test('a written edit whose lanes never come while the Timeline is open is reported, and the queue goes on with what the lanes show', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.calls.edit.length, 1);
  const errors = quietErrors(() => t.advance(10000));
  assert.match(errors, /not drawn again within 10000 ms of a written edit; the next edit goes on/);
  // The lanes still draw c3, not the c#3 that was written: the next burst is not aimed at it.
  assert.equal(t.calls.edit.length, 1);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsDropped);
  assert.equal(t.timers.size, 0);
});

test('a page turn drops the edits that wait and names their note; the answer of the edit on its way is still told', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('Delete');
  t.view.onRedraw(null);
  t.view.onRedraw({ ...t.drawn, pageStart: 32 });
  assert.equal(t.line.textContent, `c3 on t1: ${TIMELINE_COPY.noteChangeNotWritten}`);
  assert.equal(t.timers.size, 1, 'the page still runs the edit on its way: its wait is kept');
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.line.textContent, 'c3 on t1: Changed c3 to c#3.');
  quietErrors(() => t.advance(20000));
  assert.equal(t.calls.edit.length, 1);
});

test('steps said not to be written after an earlier move do not come back beside a later notice', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  // A drag takes the place of the steps: the panel says they were not written.
  const p = press(t);
  p.move(FIRST_NOTE.y - 5);
  p.up(FIRST_NOTE.y - 5);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsNotWritten);
  t.view.setNotice('dirty');
  assert.equal(t.line.textContent, UNEVALUATED, 'the notice took no steps away');
});

test('a pitch burst that is written, then velocity steps, then the redraw the pitch write causes: the velocity steps are written for the note as redrawn', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]], 'the pitch burst goes out at its pause');
  // Before the redraw of that write arrives, the person raises the velocity twice.
  buttonNamed(t, '+').dispatch('click');
  buttonNamed(t, '+').dispatch('click');
  assert.equal(t.line.textContent, 'Velocity 0.80 → 1.00. Writing in a moment.');
  // The page answers that the pitch was written, and the redraw comes: the note is found again at its new pitch, and the
  // velocity steps, cut short by the redraw, go for it.
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'c#3' });
  t.redraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.equal(t.view.selection().eventIndex, 0);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'velocity', steps: 2 }]]);
});

test('steps that wait while the lanes go away (the Timeline computes again) are handed over when the same note comes back, and dropped with a named sentence when the page turned', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(t, '+').dispatch('click');
  t.advance(100);
  t.view.onRedraw(null);
  t.advance(5000);
  assert.deepEqual(t.calls.edit, [], 'nothing is written while the lanes are away');
  assert.equal(t.timers.size, 0);
  t.view.onRedraw(t.drawn);
  assert.equal(t.view.selection().eventIndex, 0);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'velocity', steps: 1 }]]);
  // Lanes that come back for another page drop the steps and say so; lanes that never come back write nothing.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.view.onRedraw(null);
  u.view.onRedraw({ ...u.drawn, pageStart: 32 });
  assert.equal(u.line.textContent, `c3 on t1: ${TIMELINE_COPY.noteStepsNotWritten}`);
  u.advance(20000);
  assert.deepEqual(u.calls.edit, []);
});

test('kept steps that meet a note the page cannot edit any more are dropped with the sentence', () => {
  let refuse = false;
  const t = setup({
    handlers: {
      describe(laneIndex, eventIndex) {
        return {
          laneIndex, eventIndex, track: 't1', cycle: 1, beat: 1, section: null, noteText: 'c3', midi: 48, drum: null, velocity: 0.8, velocityWritable: true,
          editable: !refuse, reason: refuse ? 'degrees' : null, seen: refuse ? null : { token: { start: 3, end: 5, text: 'c3' } },
        };
      },
    },
  });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  refuse = true;
  t.view.onRedraw(t.drawn);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsDropped);
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
});

test('at the end of the note range the sentence says so and nothing is added to the steps', () => {
  const high = setup({ tokenText: '127' });
  high.view.onRedraw(high.drawn);
  high.click(FIRST_NOTE.x, FIRST_NOTE.y);
  high.key('ArrowUp');
  assert.equal(high.line.textContent, 'Already the highest note.');
  assert.equal(high.line.getAttribute('data-kind'), 'result');
  assert.equal(high.timers.size, 0);
  high.advance(5000);
  assert.deepEqual(high.calls.edit, []);
  const low = setup({ tokenText: '0' });
  low.view.onRedraw(low.drawn);
  low.click(FIRST_NOTE.x, FIRST_NOTE.y);
  low.key('ArrowDown', { shiftKey: true });
  assert.equal(low.line.textContent, 'Already the lowest note.');
  // One step from the end the step is taken; the next one is not, and the sentence says so while the first still waits.
  const near = setup({ tokenText: '126' });
  near.view.onRedraw(near.drawn);
  near.click(FIRST_NOTE.x, FIRST_NOTE.y);
  near.key('ArrowUp');
  near.key('ArrowUp');
  assert.equal(near.line.textContent, 'Already the highest note.');
  assert.equal(near.line.getAttribute('data-kind'), 'preview');
  near.advance(600);
  assert.deepEqual(near.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
});

test('the velocity buttons step the velocity by a tenth: the sentence follows, the page is asked once, and the ends are held', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const minus = buttonNamed(t, '−');
  const plus = buttonNamed(t, '+');
  assert.deepEqual([minus.getAttribute('aria-label'), plus.getAttribute('aria-label')], ['Lower velocity', 'Raise velocity']);
  assert.deepEqual([minus.getAttribute('title'), plus.getAttribute('title')], ['Lower velocity by 0.10', 'Raise velocity by 0.10']);
  assert.equal(minus.getAttribute('aria-disabled'), null);
  assert.equal(t.read.fixed().textContent, '');
  minus.dispatch('click');
  minus.dispatch('click');
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.60. Writing in a moment.');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'velocity', steps: -2 }]]);
  const top = setup({ velocity: 1 });
  top.view.onRedraw(top.drawn);
  top.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(top, '+').dispatch('click');
  assert.equal(top.line.textContent, 'Velocity is already at the highest (1.00).');
  assert.equal(top.timers.size, 0);
  const bottom = setup({ velocity: 0.1 });
  bottom.view.onRedraw(bottom.drawn);
  bottom.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(bottom, '−').dispatch('click');
  assert.equal(bottom.line.textContent, 'Velocity is already at the lowest (0.10).');
  // Two tenths from the top of the range the second step is held, with the first still waiting.
  const near = setup({ velocity: 0.9 });
  near.view.onRedraw(near.drawn);
  near.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(near, '+').dispatch('click');
  buttonNamed(near, '+').dispatch('click');
  assert.equal(near.line.textContent, 'Velocity is already at the highest (1.00).');
  near.advance(600);
  assert.deepEqual(near.calls.edit, [[0, { kind: 'velocity', steps: 1 }]]);
});

test('a velocity the page cannot write turns − and + off with the words fixed in the code, and pressing one says why', () => {
  const t = setup({ velocityWritable: false });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const minus = buttonNamed(t, '−');
  const plus = buttonNamed(t, '+');
  assert.equal(minus.getAttribute('aria-disabled'), 'true');
  assert.equal(plus.getAttribute('aria-disabled'), 'true');
  assert.equal(t.read.fixed().textContent, 'fixed in the code');
  const [down, up] = t.read.buttons();
  assert.equal(down.getAttribute('aria-disabled'), null, 'the pitch buttons are unaffected');
  assert.equal(buttonNamed(t, 'Make a rest').getAttribute('aria-disabled'), null);
  plus.dispatch('click');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteVelocityRefusal);
  assert.equal(t.line.getAttribute('data-kind'), 'refused');
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
  up.dispatch('click');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
  // A note the page cannot edit keeps its buttons on and shows no such words.
  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(buttonNamed(refused, '+').getAttribute('aria-disabled'), null);
  assert.equal(refused.read.fixed().textContent, '');
});

/** The five controls the notices switch off. */
const editControls = (t) => ['Pitch down', 'Pitch up', '−', '+', 'Make a rest'].map((text) => buttonNamed(t, text));

const DISCONNECTED = 'Disconnected — editing is off until Moontide reconnects.';
const WAITING_NOTICE = 'A change is waiting for its bar line. Editing works again when it takes over.';
const UNEVALUATED = 'The editor has changes that are not playing yet. Evaluate them first — editing works on the playing code.';

test('a notice switches the five edit controls off with aria-disabled and says why in the sentence slot; keys and buttons then write nothing', () => {
  for (const [kind, words] of [['closed', DISCONNECTED], ['waiting', WAITING_NOTICE], ['dirty', UNEVALUATED]]) {
    const t = setup();
    t.view.onRedraw(t.drawn);
    t.click(FIRST_NOTE.x, FIRST_NOTE.y);
    for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), null, kind);
    t.view.setNotice(kind);
    for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), 'true', `${kind}: ${control.textContent}`);
    assert.equal(t.line.textContent, words);
    assert.equal(t.line.getAttribute('data-kind'), 'notice');
    // The words of the controls stay, and the velocity buttons say nothing of "fixed in the code" for a notice.
    assert.equal(buttonNamed(t, 'Make a rest').textContent, 'Make a rest');
    assert.equal(t.read.fixed().textContent, '');
    t.key('ArrowUp');
    t.key('ArrowDown', { shiftKey: true });
    t.key('Delete');
    t.key('Backspace');
    for (const control of editControls(t)) control.dispatch('click');
    assert.equal(t.timers.size, 0, `${kind}: nothing waits for a pause`);
    t.advance(5000);
    assert.deepEqual(t.calls.edit, [], kind);
    assert.equal(t.line.textContent, words, `${kind}: the sentence is still the notice`);
    // The keys are still consumed, so the page does not scroll under a selected note.
    assert.equal(t.key('ArrowUp').stopped, true);
    t.view.setNotice(null);
    for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), null);
    assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
    assert.equal(t.line.getAttribute('data-kind'), 'standing');
  }
});

test('with a notice, selecting, the rings and the panel still work, and a notice given before the selection shows with it', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.view.setNotice('closed');
  assert.equal(t.line.textContent, '', 'no note, no sentence of the notice');
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.read.rings().length, 1);
  assert.equal(t.line.textContent, DISCONNECTED);
  t.click(350, 10);
  assert.equal(t.view.selection().eventIndex, 1);
  assert.equal(t.read.rings().length, 1);
  assert.equal(t.line.textContent, DISCONNECTED, 'the notice stays on the next note');
  t.click(2000, 90);
  assert.equal(t.view.selection(), null);
});

test('the sentence of an editable note is the notice first, then the preview, the result and the standing sentence; a refused note shows no notice', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'd3' });
  assert.equal(t.line.textContent, 'Changed c3 to d3.');
  t.view.setNotice('waiting');
  assert.equal(t.line.textContent, WAITING_NOTICE, 'the notice before the result');
  t.view.setNotice(null);
  assert.equal(t.line.textContent, 'Changed c3 to d3.');
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'd3 → d#3 (+1 semitone). Writing in a moment.', 'steps waiting before the result, from the d3 the page wrote');
  t.view.setNotice('dirty');
  assert.equal(t.line.textContent, `${UNEVALUATED} ${TIMELINE_COPY.noteStepsNotWritten}`, 'the notice before the steps; the steps are dropped with it, and the sentence says so');
  t.advance(5000);
  assert.equal(t.calls.edit.length, 1, 'only the first edit');
  t.view.setNotice(null);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsNotWritten, 'when the notice lifts the steps are still said not to be written');
  assert.equal(t.line.getAttribute('data-kind'), 'refused');

  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.view.setNotice('closed');
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(refused.line.textContent, TIMELINE_COPY.noteReasons.degrees);
  assert.equal(refused.line.getAttribute('data-kind'), 'standing');
  for (const control of editControls(refused)) assert.equal(control.getAttribute('aria-disabled'), null, 'a refused note keeps its buttons on');
});

test('steps that wait when a notice comes on are said not to be written; a notice with no steps adds nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.view.setNotice('waiting');
  assert.equal(t.line.textContent, WAITING_NOTICE, 'no steps, no extra words');
  t.view.setNotice(null);
  t.key('ArrowUp');
  t.view.setNotice('waiting');
  assert.equal(t.line.textContent, `${WAITING_NOTICE} ${TIMELINE_COPY.noteStepsNotWritten}`);
  t.view.setNotice(null);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteStepsNotWritten);
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
  // Another note chosen afterwards starts with its own sentence.
  t.click(350, 10);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
});

test('steps that wait when the person\'s own edit starts waiting for its line are said not to be written, and the words stay through the takeover', () => {
  for (const tookOver of [true, false]) {
    const t = setup();
    t.view.onRedraw(t.drawn);
    t.click(FIRST_NOTE.x, FIRST_NOTE.y);
    t.key('ArrowUp');
    t.advance(600);
    // A second burst is gathering when the outcome of the first arrives and says it waits for its line.
    t.key('ArrowUp');
    t.answer({ kind: 'waiting', what: 'pitch', label: 'x', from: 'c3', to: 'c#3', at: 'bar', record: {} });
    assert.equal(t.line.textContent, `Waiting for the next bar — c3 becomes c#3. ${TIMELINE_COPY.noteStepsNotWritten}`);
    t.advance(5000);
    assert.equal(t.calls.edit.length, 1, 'the second burst is never written');
    t.view.finishWait({ tookOver });
    assert.equal(t.line.textContent, tookOver ? `Changed c3 to c#3. ${TIMELINE_COPY.noteStepsNotWritten}` : TIMELINE_COPY.noteStepsNotWritten);
  }
});

test('the sentence of what a notice or a waiting change dropped says what it was (steps, or a rest or a drag) and names a note the panel does not show', () => {
  const tokens = ['c3', 'e3'];
  const info = (laneIndex, eventIndex) => (laneIndex === 0 && eventIndex < 2 ? { noteText: tokens[eventIndex], seen: { token: { start: 3 + 3 * eventIndex, end: 5 + 3 * eventIndex, text: tokens[eventIndex] } } } : {});
  // A notice: a rest of c3 waits behind c3's steps, and e3 is selected with steps of its own.
  const t = setup({ info });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('Delete');
  t.key('ArrowRight');
  t.key('ArrowUp');
  t.view.setNotice('dirty');
  assert.equal(t.line.textContent, `${UNEVALUATED} ${TIMELINE_COPY.noteStepsNotWritten} c3 on t1: ${TIMELINE_COPY.noteChangeNotWritten}`);
  t.view.setNotice(null);
  assert.equal(t.line.textContent, `${TIMELINE_COPY.noteStepsNotWritten} c3 on t1: ${TIMELINE_COPY.noteChangeNotWritten}`);
  // A change that waits for its line: a drag of the same note waited behind it, and is said to be a change, not steps.
  const u = setup({ info });
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.advance(600);
  const p = press(u);
  p.move(FIRST_NOTE.y - STEP - 1);
  p.up(FIRST_NOTE.y - STEP - 1);
  u.answer({ kind: 'waiting', what: 'pitch', label: 'x', from: 'c3', to: 'c#3', at: 'bar', record: {} });
  assert.equal(u.line.textContent, `Waiting for the next bar — c3 becomes c#3. ${TIMELINE_COPY.noteChangeNotWritten}`);
  u.view.finishWait({ tookOver: true });
  assert.equal(u.line.textContent, `Changed c3 to c#3. ${TIMELINE_COPY.noteChangeNotWritten}`);
  // The same with e3 selected: the drag of c3 is named.
  const v = setup({ info });
  v.view.onRedraw(v.drawn);
  v.click(FIRST_NOTE.x, FIRST_NOTE.y);
  v.key('ArrowUp');
  v.advance(600);
  const q = press(v);
  q.move(FIRST_NOTE.y - STEP - 1);
  q.up(FIRST_NOTE.y - STEP - 1);
  v.key('ArrowRight');
  v.answer({ kind: 'waiting', what: 'pitch', label: 'x', from: 'c3', to: 'c#3', at: 'bar', record: {} });
  assert.equal(v.line.textContent, `c3 on t1: Waiting for the next bar — c3 becomes c#3. c#3 on t1: ${TIMELINE_COPY.noteChangeNotWritten}`, 'the drag is named after the note as the person will find it');
});

test('a notice is written only when its kind changes, and a kind the view does not know throws', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.view.setNotice('closed');
  const writes = t.document.writes;
  t.view.setNotice('closed');
  t.view.setNotice('closed');
  assert.equal(t.document.writes, writes);
  t.view.setNotice('dirty');
  assert.notEqual(t.document.writes, writes);
  assert.throws(() => t.view.setNotice('nope'), /unknown notice 'nope'/);
  assert.throws(() => t.view.setNotice(undefined), /unknown notice/);
  t.view.setNotice(null);
  const after = t.document.writes;
  t.view.setNotice(null);
  assert.equal(t.document.writes, after);
});

test('an edit that waits for its line keeps its ring, turns the edit controls off with its own sentence, and says it was made when it takes over', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'waiting', what: 'pitch', label: 'x', from: 'c3', to: 'c#3', at: 'bar', record: {} });
  assert.equal(t.line.textContent, 'Waiting for the next bar — c3 becomes c#3.');
  assert.equal(t.line.getAttribute('data-kind'), 'result');
  for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), 'true');
  assert.equal(t.read.rings().length, 1, 'the note keeps its ring');
  t.key('ArrowUp');
  t.key('Delete');
  t.advance(5000);
  assert.equal(t.calls.edit.length, 1, 'nothing more is asked while the change waits');
  // A notice for another change would take the sentence; the page does not give one for this edit.
  t.view.finishWait({ tookOver: true });
  for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), null);
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
  // The lanes come back from the new code, and the note is selected again at its new pitch.
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.notEqual(t.view.selection(), null);
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
});

test('an edit that waits and is then dropped does not say it was made; a velocity and a rest say it in their own words', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'waiting', what: 'pitch', label: 'x', from: 'c3', to: 'c#3', at: 'phrase', record: {} });
  assert.equal(t.line.textContent, 'Waiting for the next phrase — c3 becomes c#3.');
  t.view.finishWait({ tookOver: false });
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), null);
  // A change that never took over brings no lanes: the next edit goes at once.
  buttonNamed(t, '+').dispatch('click');
  t.advance(600);
  assert.equal(t.calls.edit.length, 2);
  t.answer({ kind: 'waiting', what: 'velocity', label: 'x', from: 'c3', to: '0.90', at: 'bar', record: {} });
  assert.equal(t.line.textContent, 'Waiting for the next bar — c3 velocity becomes 0.90.');
  t.view.finishWait({ tookOver: true });
  assert.equal(t.line.textContent, 'Velocity of c3 is now 0.90.');
  // A change that took over brings its lanes: the next edit waits for them.
  t.key('Delete');
  assert.equal(t.calls.edit.length, 2);
  t.redraw(t.drawn);
  assert.deepEqual(t.calls.edit.at(-1), [0, { kind: 'rest' }]);
  t.answer({ kind: 'waiting', what: 'rest', label: 'x', from: 'c3', to: '~', at: 'bar', record: {} });
  assert.equal(t.line.textContent, 'Waiting for the next bar — c3 becomes a rest.');
  t.view.finishWait({ tookOver: true });
  assert.equal(t.line.textContent, 'Changed c3 to a rest.');
  assert.throws(() => t.view.finishWait({}), /took over or because it did not/);
  // Ending a wait that is not there changes nothing, and a sentence that was not a waiting one stays.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.key('ArrowUp');
  u.advance(600);
  u.answer({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'd3' });
  u.view.finishWait({ tookOver: false });
  assert.equal(u.line.textContent, 'Changed c3 to d3.');
});

test('a failed evaluation and a refusal of the page are sentences of the slot, and the controls stay on', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'failed' });
  assert.equal(t.line.textContent, 'The change did not evaluate, so the code is as it was. Ask Claude to make it.');
  assert.equal(t.line.getAttribute('data-kind'), 'refused');
  for (const control of editControls(t)) assert.equal(control.getAttribute('aria-disabled'), null);
  buttonNamed(t, '+').dispatch('click');
  t.advance(600);
  t.answer({ kind: 'refused', reason: 'velocity-fixed' });
  assert.equal(t.line.textContent, TIMELINE_COPY.noteVelocityRefusal);
});

test('the panel is hidden when no lanes are drawn and shown when they are; a redraw that finds no such note drops the selection and builds one mark layer a lane', () => {
  const t = setup();
  assert.equal(t.panel.hidden, true);
  t.view.onRedraw(t.drawn);
  assert.equal(t.panel.hidden, false);
  assert.equal(all(t.lanes, 'lane-marks').length, 2);
  assert.ok(all(t.lanes, 'lane-marks').every((layer) => layer.getAttribute('aria-hidden') === 'true'));
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'a3' }));
  assert.equal(t.view.selection(), null);
  assert.equal(t.read.rings().length, 0);
  assert.equal(all(t.lanes, 'lane-marks').length, 2, 'a layer is replaced, never added to');
  assert.equal(t.read.position().textContent, 'No note selected');
  t.view.onRedraw(null);
  assert.equal(t.panel.hidden, true);
  assert.equal(t.view.selection(), null);
  // Lanes that are not there are a loud error.
  assert.throws(() => t.view.onRedraw({ pageStart: 0, lanes: [...t.drawn.lanes, t.drawn.lanes[0]] }), /draws no lane 2/);
});

test('the sentence of an edit stays through the next redraw and goes with the next selection', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', label: 'x', from: 'c3', to: 'c#3' });
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
  assert.equal(t.line.getAttribute('data-kind'), 'result');
  // The lanes come back without the note (the code moved on): nothing is selected and the sentence of the edit is still there.
  t.redraw(withFirstNote(t.drawn, { note: 'a3' }));
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
  assert.equal(t.read.position().textContent, 'No note selected');
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'refused', reason: 'read-back' });
  assert.equal(t.line.textContent, TIMELINE_COPY.noteReadBack);
  assert.equal(t.line.getAttribute('data-kind'), 'refused');
  // An outcome with nothing to say takes the old sentence away; an outcome the panel does not know throws.
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'unchanged' });
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  t.key('ArrowUp');
  t.advance(600);
  const id = t.unanswered[0];
  assert.throws(() => t.view.showOutcome(id, { kind: 'nope' }), /unknown outcome/);
  // An id the view never handed over, or one already answered, throws.
  t.view.showOutcome(id, { kind: 'unchanged' });
  assert.throws(() => t.view.showOutcome(id, { kind: 'unchanged' }), /never handed over or was already answered/);
  assert.throws(() => t.view.showOutcome(999, { kind: 'unchanged' }), /edit 999, which was never handed over/);
});

test('picking the same note again writes no text', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const writes = t.document.writes;
  const nodeWrites = [t.line, t.read.position(), t.read.state()].map((node) => node.writes);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.document.writes, writes);
  assert.deepEqual([t.line, t.read.position(), t.read.state()].map((node) => node.writes), nodeWrites);
  // The same outcome twice writes once.
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'refused', reason: 'read-back' });
  t.key('ArrowUp');
  t.advance(600);
  const after = t.document.writes;
  t.answer({ kind: 'refused', reason: 'read-back' });
  assert.equal(t.document.writes, after);
});

test('a name that holds markup stays text', () => {
  const name = '<img src=x onerror=alert(1)>';
  const t = setup({ track: name });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.read.laneName().textContent, name);
  assert.equal(t.read.laneName().children.length, 0);
  assert.equal(t.read.laneName().getAttribute('title'), name);
  assert.equal(t.document.markup.length, 2);
});

test('the module reads and writes text only through textContent, title and setAttribute', () => {
  assert.doesNotMatch(SOURCE, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
});

test('a view without what it needs throws: an element, the root size, a handler, a sentence slot inside the panel', () => {
  const build = (changes = {}) => {
    const document = fakeDocument();
    const lanes = fakeNode('div', document);
    const panel = fakeNode('section', document);
    const line = fakeNode('p', document);
    panel.appendChild(line);
    return createTimelineEditView({
      document,
      lanes,
      panel,
      line,
      rootFontPx: () => REM,
      setTimer: () => 1,
      clearTimer: () => {},
      handlers: { describe: () => ({}), edit: () => {}, prepare: () => {}, ask: () => {}, range: () => {}, describeRange: () => ({}), askLane: () => {} },
      ...changes,
    });
  };
  assert.doesNotThrow(() => build());
  assert.throws(() => build({ handlers: { describe: () => ({}), prepare: () => {}, ask: () => {} } }), /no handler for 'edit'/);
  assert.throws(() => build({ handlers: { edit: () => {}, prepare: () => {}, ask: () => {} } }), /no handler for 'describe'/);
  assert.throws(() => build({ handlers: { describe: () => ({}), edit: () => {}, ask: () => {} } }), /no handler for 'prepare'/);
  assert.throws(() => build({ handlers: { describe: () => ({}), edit: () => {}, prepare: () => {} } }), /no handler for 'ask'/);
  assert.throws(() => build({ handlers: { describe: () => ({}), edit: () => {}, prepare: () => {}, ask: () => {} } }), /no handler for 'range'/);
  assert.throws(() => build({ handlers: { describe: () => ({}), edit: () => {}, prepare: () => {}, ask: () => {}, range: () => {} } }), /no handler for 'describeRange'/);
  assert.throws(() => build({ handlers: { describe: () => ({}), edit: () => {}, prepare: () => {}, ask: () => {}, range: () => {}, describeRange: () => ({}) } }), /no handler for 'askLane'/);
  assert.throws(() => build({ handlers: null }), /no handler for 'describe'/);
  assert.throws(() => build({ rootFontPx: 16 }), /needs rootFontPx/);
  assert.throws(() => build({ setTimer: undefined }), /needs setTimer/);
  assert.throws(() => build({ clearTimer: null }), /needs clearTimer/);
  assert.throws(() => build({ lanes: null }), /needs its 'lanes' element/);
  assert.throws(() => build({ line: fakeNode('p', fakeDocument()) }), /must sit inside its panel/);
});

// --- the pitch drag ---

const STEP = 0.5 * REM;

/** A press on lane 0's first note, then the moves (to y of each) and nothing else; the pointer stays at the note's x. */
function press(t, { x = FIRST_NOTE.x, y = FIRST_NOTE.y, id = 1 } = {}) {
  t.lanes.dispatch('pointerdown', { pointerId: id, clientX: x, clientY: y });
  return {
    move: (to, side = x) => t.lanes.dispatch('pointermove', { pointerId: id, clientX: side, clientY: to }),
    up: (to, side = x) => t.lanes.dispatch('pointerup', { pointerId: id, clientX: side, clientY: to }),
  };
}

const ghosts = (t) => all(t.lanes, 'tl-ghost');

test('a drag up on a note shows a dashed ghost and the sentence, changes both only by whole steps, and writes once on release', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  // Still inside the quarter rem: no gesture yet.
  p.move(FIRST_NOTE.y - 3);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  assert.equal(ghosts(t).length, 0);
  // Past it, but not a whole step: the gesture has begun (the note is selected) and nothing is previewed.
  p.move(FIRST_NOTE.y - 5);
  assert.equal(t.lanes.getAttribute('data-dragging'), 'pitch');
  assert.equal(t.view.selection().eventIndex, 0);
  assert.equal(ghosts(t).length, 0);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  // One whole step.
  p.move(FIRST_NOTE.y - STEP - 1);
  assert.equal(t.line.textContent, 'c3 → c#3 (+1 semitone). Release to write.');
  assert.equal(t.line.getAttribute('data-kind'), 'preview');
  assert.equal(ghosts(t).length, 1);
  // The ghost is a layer mark of the same lane, as wide as the note, one step above it: the note is 43 to 57 of 100 pixels.
  const [ghost] = ghosts(t);
  assert.equal(ghost.parentNode, all(t.laneNodes[0], 'lane-marks')[0]);
  assert.equal(ghost.style.left, '0%');
  assert.equal(ghost.style.width, `${(1 / 32) * 100}%`);
  assert.equal(Number.parseFloat(ghost.style.top).toFixed(6), ((0.43 - STEP / 100) * 100).toFixed(6));
  assert.equal(ghost.style.height, `${0.14 * 100}%`);
  // More pixels inside the same step write nothing at all.
  const writes = t.document.writes;
  p.move(FIRST_NOTE.y - STEP - 4);
  p.move(FIRST_NOTE.y - 2 * STEP + 0.5);
  assert.equal(t.document.writes, writes, 'the sentence is written when the whole-step value changes, not with every pixel');
  // The second step.
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(t.line.textContent, 'c3 → d3 (+2 semitones). Release to write.');
  assert.equal(ghosts(t).length, 1);
  assert.deepEqual(t.calls.edit, [], 'nothing is written during the drag');
  p.up(FIRST_NOTE.y - 1.1 * REM);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 2 }]]);
  assert.equal(ghosts(t).length, 0);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  assert.equal(t.lanes.capturedPointer, null);
});

test('the value written is the last one shown, whatever the pointer did after it', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  p.up(FIRST_NOTE.y - 5 * REM);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 2 }]]);
});

test('a drag down lowers the note, and the ghost stays inside the lane at both ends', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y + 2.1 * STEP);
  assert.equal(t.line.textContent, 'c3 → a#2 (-2 semitones). Release to write.');
  assert.equal(Number.parseFloat(ghosts(t)[0].style.top).toFixed(6), ((0.43 + 2 * STEP / 100) * 100).toFixed(6));
  // Far below and far above: the ghost is held inside the lane (the box is 14 percent high).
  p.move(FIRST_NOTE.y + 80);
  assert.equal(Number.parseFloat(ghosts(t)[0].style.top).toFixed(6), '86.000000');
  p.move(FIRST_NOTE.y - 80);
  assert.equal(Number.parseFloat(ghosts(t)[0].style.top).toFixed(6), '0.000000');
  p.up(FIRST_NOTE.y - 80);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 10 }]]);
});

test('moving back to zero takes the preview away and a release then writes nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(ghosts(t).length, 1);
  p.move(FIRST_NOTE.y - 0.1 * REM);
  assert.equal(ghosts(t).length, 0);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  p.up(FIRST_NOTE.y - 0.1 * REM);
  assert.deepEqual(t.calls.edit, []);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
});

const washes = (t) => all(t.lanes, 'tl-range');

test('a sideways drag from a note is a range, not a pitch drag: it draws a wash over whole cycles, writes nothing and selects nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y + 3, FIRST_NOTE.x + 1.1 * REM);
  assert.equal(t.lanes.getAttribute('data-dragging'), 'range');
  assert.equal(ghosts(t).length, 0);
  assert.equal(washes(t).length, 1);
  // The gesture is decided for the rest of the press: going up now changes nothing.
  p.move(FIRST_NOTE.y - 2 * REM, FIRST_NOTE.x + 1.1 * REM);
  assert.equal(ghosts(t).length, 0);
  p.up(FIRST_NOTE.y - 2 * REM, FIRST_NOTE.x + 1.1 * REM);
  assert.deepEqual(t.calls.edit, []);
  assert.equal(t.view.selection(), null);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  assert.equal(t.calls.range.length, 1);
  assert.deepEqual(t.calls.range[0][0], { laneIndex: 0, from: 0, to: 0, cut: null });
});

test('a drag on empty lane area draws the wash over the cycle under the press and the cycle under the pointer, both included, and release hands the range to the page once', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  // 100 pixels a cycle from x = 100: x = 1500 is in cycle 14, x = 1950 in cycle 18.
  const p = press(t, { x: 1500, y: 50 });
  p.move(50, 1500 + 5);
  assert.equal(t.lanes.getAttribute('data-dragging'), 'range');
  assert.equal(t.calls.range.length, 0, 'nothing is handed over while the button is held');
  p.move(50, 1950);
  const [wash] = washes(t);
  assert.equal(washes(t).length, 1);
  assert.equal(wash.parentNode, all(t.laneNodes[0], 'lane-marks')[0]);
  assert.equal(wash.style.left, `${(14 / 32) * 100}%`);
  assert.equal(wash.style.width, `${(5 / 32) * 100}%`);
  assert.equal(t.calls.range.length, 0);
  const up = p.up(60, 1960);
  assert.equal(up.defaultPrevented, false);
  assert.deepEqual(t.calls.range, [[{ laneIndex: 0, from: 14, to: 18, cut: null }, { x: 1960, y: 60 }]]);
  // The wash stays after the release, the press is over, and the lanes hold the focus for the box to give back.
  assert.equal(washes(t).length, 1);
  assert.equal(washes(t)[0], wash);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  assert.equal(t.lanes.capturedPointer, null);
  assert.equal(t.document.activeElement, t.lanes);
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 14, to: 18, cut: null });
  // Nothing was written, described or edited.
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.describe, []);
  assert.deepEqual(t.calls.prepare, []);
});

test('a range on the second lane draws its wash in that lane, and a drag to the left gives the same cycles as a drag to the right', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const right = press(t, { x: 600, y: 150 });
  right.move(150, 603);
  right.up(150, 1200);
  const first = t.view.rangeSelection();
  assert.deepEqual(first, { laneIndex: 1, from: 5, to: 11, cut: null });
  assert.equal(washes(t)[0].parentNode, all(t.laneNodes[1], 'lane-marks')[0]);
  const left = press(t, { x: 1200, y: 150 });
  left.move(150, 1197);
  left.up(150, 600);
  assert.deepEqual(t.view.rangeSelection(), first);
});

test('a new range replaces the one before it, and a press that does not move is a click, not a range', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  let p = press(t, { x: 600, y: 50 });
  p.move(50, 700);
  p.up(50, 700);
  const before = washes(t)[0];
  p = press(t, { x: 1500, y: 50 });
  p.move(50, 1700);
  assert.equal(washes(t).length, 2, 'the old wash stays until the new range is released');
  p.up(50, 1700);
  assert.equal(washes(t).length, 1);
  assert.notEqual(washes(t)[0], before);
  assert.equal(t.calls.range.length, 2);
  // A click on empty area clears the range and calls nothing.
  t.click(2500, 50);
  assert.equal(washes(t).length, 0);
  assert.equal(t.view.rangeSelection(), null);
  assert.equal(t.calls.range.length, 2);
  // A click that moved less than a quarter of a rem is not a range.
  t.click(1500, 50);
  assert.equal(t.calls.range.length, 2);
});

test('a drag that leaves the event area is held at the page edge and the range says it was cut', () => {
  const t = setup();
  t.view.onRedraw({ ...t.drawn, pageStart: 32 });
  const p = press(t, { x: 600, y: 50 });
  p.move(50, 700);
  // To the right of the area (it ends at x = 3300) and above the lane.
  p.move(-300, 3900);
  assert.equal(washes(t)[0].style.left, `${(5 / 32) * 100}%`);
  assert.equal(washes(t)[0].style.width, `${(27 / 32) * 100}%`);
  p.up(-300, 3900);
  assert.deepEqual(t.calls.range[0][0], { laneIndex: 0, from: 37, to: 63, cut: { from: 37, to: 63 } });
  // To the left of the area (the name column) the range runs to the first cycle of the page.
  const q = press(t, { x: 600, y: 50 });
  q.move(50, 500);
  q.up(50, 20);
  assert.deepEqual(t.calls.range[1][0], { laneIndex: 0, from: 32, to: 37, cut: { from: 32, to: 37 } });
  // Pointer at the very edge of the area is inside it: no cut.
  const r = press(t, { x: 600, y: 50 });
  r.move(50, 500);
  r.up(50, 3300);
  assert.equal(t.calls.range[2][0].cut, null);
});

test('a range drag is cancelled by Escape, a lost capture, a pointer cancel, the window and a redraw: no wash, nothing handed to the page', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const cancels = [
    () => t.key('Escape'),
    () => t.lanes.dispatch('lostpointercapture', { pointerId: 1 }),
    () => t.lanes.dispatch('pointercancel', { pointerId: 1 }),
    () => t.view.cancelGesture(),
    () => t.view.onRedraw(t.drawn),
  ];
  for (const cancel of cancels) {
    const p = press(t, { x: 1500, y: 50 });
    p.move(50, 1800);
    assert.equal(washes(t).length, 1);
    cancel();
    assert.equal(washes(t).length, 0);
    assert.equal(t.lanes.getAttribute('data-dragging'), null);
    p.up(50, 1800);
    assert.equal(washes(t).length, 0);
  }
  assert.deepEqual(t.calls.range, []);
  assert.equal(t.view.rangeSelection(), null);
});

test('a range replaces the note that was selected, and a drag that is cancelled leaves the selection as it was', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.notEqual(t.view.selection(), null);
  const cancelled = press(t, { x: 1500, y: 50 });
  cancelled.move(50, 1800);
  t.key('Escape');
  assert.notEqual(t.view.selection(), null);
  const p = press(t, { x: 1500, y: 50 });
  p.move(50, 1800);
  p.up(50, 1800);
  assert.equal(t.view.selection(), null);
  assert.equal(t.read.rings().length, 0);
  assert.equal(t.calls.range.length, 1);
});

test('clearRange takes the wash away and a redraw clears the range', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t, { x: 1500, y: 50 });
  p.move(50, 1800);
  p.up(50, 1800);
  assert.equal(washes(t).length, 1);
  t.view.clearRange();
  assert.equal(washes(t).length, 0);
  assert.equal(t.view.rangeSelection(), null);
  // Clearing nothing is harmless.
  t.view.clearRange();
  const q = press(t, { x: 1500, y: 50 });
  q.move(50, 1800);
  q.up(50, 1800);
  t.view.onRedraw(t.drawn);
  assert.equal(washes(t).length, 0);
  assert.equal(t.view.rangeSelection(), null);
});

/** Makes a range of cycles `from` to `to` on lane 0 with a real drag (100 pixels a cycle from x = 100). */
function dragRangeOn(t, from, to, y = 50) {
  const p = press(t, { x: 100 + from * 100 + 50, y });
  p.move(y, 100 + from * 100 + 50 + 6);
  p.up(y, 100 + to * 100 + 50);
  return t.calls.range.at(-1);
}

const groups = (t) => all(t.panel, 'tl-group');

test('the panel names a range, shows only Ask Claude and the range hint, and keeps the sentence slot empty', () => {
  const t = setup({ rangeInfo: { count: 5 } });
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 14, 18);
  assert.deepEqual(t.calls.describeRange, [{ laneIndex: 0, from: 14, to: 18, cut: null }]);
  assert.equal(t.read.laneName().textContent, 'Range · t1');
  assert.equal(t.read.laneName().getAttribute('title'), 'Range · t1');
  assert.equal(t.read.position().textContent, ' · cycles 14 to 18 · 5 notes');
  assert.equal(t.read.state().textContent, '');
  assert.equal(t.read.controls().hidden, false);
  assert.deepEqual(groups(t).map((group) => group.hidden), [true, true]);
  const [pitchDown, pitchUp, velocityDown, velocityUp, restButton, askButton] = t.read.buttons();
  assert.equal(restButton.hidden, true);
  assert.equal(askButton.hidden, false);
  assert.equal(askButton.getAttribute('aria-label'), TIMELINE_COPY.noteRangeAskName);
  assert.equal(askButton.getAttribute('title'), TIMELINE_COPY.noteRangeAskTitle);
  assert.equal(t.read.hint().textContent, 'Press Enter or Ask Claude to ask about these cycles. Esc clears the range.');
  assert.equal(t.line.textContent, '');
  assert.equal(t.line.getAttribute('data-kind'), null);
  // The buttons that change a note do nothing without a note.
  for (const gone of [pitchDown, pitchUp, velocityDown, velocityUp, restButton]) gone.dispatch('click');
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.prepare, []);
});

test('the panel of a range reads one cycle, no notes, one note and the section or the two sections', () => {
  const read = (rangeInfo, from, to) => {
    const t = setup({ rangeInfo });
    t.view.onRedraw(t.drawn);
    dragRangeOn(t, from, to);
    return t.read.laneName().textContent + t.read.position().textContent;
  };
  assert.equal(read({ count: 0 }, 12, 12), 'Range · t1 · cycle 12 · no notes');
  assert.equal(read({ count: 1 }, 12, 12), 'Range · t1 · cycle 12 · 1 note');
  assert.equal(read({ count: 14, section: 'y' }, 12, 15), "Range · t1 · cycles 12 to 15 · section 'y' · 14 notes");
  assert.equal(read({ count: 14, section: 'x', sectionTo: 'z' }, 12, 15), "Range · t1 · cycles 12 to 15 · sections 'x' to 'z' · 14 notes");
  // A name from the code stays text.
  assert.equal(read({ count: 2, section: '<b>x</b>' }, 12, 15), "Range · t1 · cycles 12 to 15 · section '<b>x</b>' · 2 notes");
  // The second lane's range names the second lane.
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t, { x: 700, y: 150 });
  p.move(150, 710);
  p.up(150, 900);
  assert.equal(t.read.laneName().textContent, 'Range · drums');
});

test('Ask Claude and Enter open the box again for the same range, at the middle of the wash, and write nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 14, 18);
  const [, , , , , askButton] = t.read.buttons();
  askButton.dispatch('click');
  // Cycles 14 to 18 cover x = 1500 to 2000 of the page; the middle is 1750, the middle of the lane 50.
  assert.deepEqual(t.calls.range.at(-1), [{ laneIndex: 0, from: 14, to: 18, cut: null }, { x: 1750, y: 50 }]);
  const enter = t.key('Enter');
  assert.equal(t.calls.range.length, 3);
  assert.deepEqual(t.calls.range.at(-1), [{ laneIndex: 0, from: 14, to: 18, cut: null }, { x: 1750, y: 50 }]);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(enter.stopped, true);
  // Shift+F10 and the Menu key ask about the range too.
  t.key('F10', { shiftKey: true });
  t.key('ContextMenu');
  assert.equal(t.calls.range.length, 5);
  assert.deepEqual(t.calls.ask, []);
  assert.deepEqual(t.calls.edit, []);
  assert.equal(washes(t).length, 1, 'the range is still there');
});

test('Escape clears a range and its panel, a click on empty area too, and a new selection replaces it', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 14, 18);
  const escape = t.key('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(washes(t).length, 0);
  assert.equal(t.view.rangeSelection(), null);
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.read.controls().hidden, true);
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintNone);
  assert.deepEqual(groups(t).map((group) => group.hidden), [false, false], 'a note brings its controls back');
  // With no range Escape goes on to the page.
  const again = t.key('Escape');
  assert.equal(again.defaultPrevented, false);
  // A click on empty area clears the range.
  dragRangeOn(t, 14, 18);
  t.click(2500, 50);
  assert.equal(washes(t).length, 0);
  assert.equal(t.read.position().textContent, 'No note selected');
  // A click on a note selects it and takes the range away.
  dragRangeOn(t, 14, 18);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(washes(t).length, 0);
  assert.equal(t.view.rangeSelection(), null);
  assert.notEqual(t.view.selection(), null);
  assert.equal(t.read.laneName().textContent, 't1');
  assert.equal(t.read.controls().hidden, false);
  assert.deepEqual(groups(t).map((group) => group.hidden), [false, false]);
  assert.equal(t.read.buttons()[4].hidden, false);
  assert.equal(t.read.buttons()[5].getAttribute('aria-label'), TIMELINE_COPY.noteAskName);
});

test('a page turn or a redraw clears a range and its panel, and the sent request clears the wash through clearRange', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 14, 18);
  t.view.onRedraw({ ...t.drawn, pageStart: 32 });
  assert.equal(washes(t).length, 0);
  assert.equal(t.view.rangeSelection(), null);
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintNone);
  dragRangeOn(t, 14, 18);
  t.view.onRedraw(null);
  assert.equal(t.view.rangeSelection(), null);
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 14, 18);
  t.view.clearRange();
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.read.controls().hidden, true);
});

test('the keys that change a note do nothing while a range is selected, and go on to the page', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 14, 18);
  for (const name of ['ArrowUp', 'ArrowDown', 'Delete', 'Backspace']) {
    const result = t.key(name);
    assert.equal(result.defaultPrevented, false, name);
  }
  t.advance(2000);
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.prepare, []);
  assert.equal(washes(t).length, 1);
});

/** Lanes whose lane 0 has a note at cycle 7 (the third one), so a click at x = 850 selects it. */
function drawnWithNoteAt7(t) {
  return {
    ...t.drawn,
    lanes: [
      { ...t.drawn.lanes[0], events: [...t.drawn.lanes[0].events, { begin: 7, value: { note: 'a3' } }], shapes: [...t.drawn.lanes[0].shapes, note(7, 0.3)] },
      t.drawn.lanes[1],
    ],
  };
}

test('Shift+Right on a selected note starts a range at its cycle and widens it a cycle a press, and the note is no longer selected', () => {
  const t = setup();
  t.view.onRedraw(drawnWithNoteAt7(t));
  t.click(850, 30);
  assert.equal(t.view.selection().eventIndex, 4);
  const first = t.key('ArrowRight', { shiftKey: true });
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.stopped, true);
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 7, to: 8, cut: null });
  assert.equal(t.view.selection(), null);
  assert.equal(t.read.rings().length, 0);
  t.key('ArrowRight', { shiftKey: true });
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 7, to: 9, cut: null });
  assert.equal(washes(t).length, 1);
  assert.equal(washes(t)[0].style.left, `${(7 / 32) * 100}%`);
  assert.equal(washes(t)[0].style.width, `${(3 / 32) * 100}%`);
  assert.equal(t.read.laneName().textContent + t.read.position().textContent, 'Range · t1 · cycles 7 to 9 · 3 notes');
  // Nothing was asked yet: Enter opens the box for the range, at the middle of the wash.
  assert.deepEqual(t.calls.range, []);
  t.key('Enter');
  assert.deepEqual(t.calls.range, [[{ laneIndex: 0, from: 7, to: 9, cut: null }, { x: 100 + 8.5 * 100, y: 50 }]]);
  // Shift+Left takes the head back, past the anchor if it goes on, and a range of one cycle is a range too.
  t.key('ArrowLeft', { shiftKey: true });
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 7, to: 8, cut: null });
  t.key('ArrowLeft', { shiftKey: true });
  t.key('ArrowLeft', { shiftKey: true });
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 6, to: 7, cut: null });
  assert.deepEqual(t.calls.edit, []);
});

test('Shift+Left and Shift+Right stop at the first and last cycle of the page', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowLeft', { shiftKey: true });
  t.key('ArrowLeft', { shiftKey: true });
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 0, to: 0, cut: null });
  for (let i = 0; i < 40; i++) t.key('ArrowRight', { shiftKey: true });
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 0, to: 31, cut: null });
  // The second page: the cycles are the page's own.
  t.view.onRedraw({ ...t.drawn, pageStart: 32, lanes: t.drawn.lanes.map((lane) => ({ ...lane, events: lane.events.map((event) => ({ ...event, begin: event.begin + 32 })) })) });
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowLeft', { shiftKey: true });
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 0, from: 32, to: 32, cut: null });
});

test('Shift+Arrow with neither a note nor a range goes on to the page, and so do the chords', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  for (const extra of [{ shiftKey: true }, { shiftKey: true, ctrlKey: true }, { ctrlKey: true }]) {
    for (const name of ['ArrowLeft', 'ArrowRight']) {
      const result = t.key(name, extra);
      assert.equal(result.defaultPrevented, false);
    }
  }
  assert.equal(t.view.rangeSelection(), null);
  assert.equal(t.view.selection(), null);
  // With a note selected the Ctrl, Meta and Alt chords are not the range keys.
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  for (const extra of [{ shiftKey: true, ctrlKey: true }, { shiftKey: true, metaKey: true }, { shiftKey: true, altKey: true }, { ctrlKey: true }, { altKey: true }]) {
    assert.equal(t.key('ArrowRight', extra).defaultPrevented, false);
  }
  assert.equal(t.view.rangeSelection(), null);
  assert.notEqual(t.view.selection(), null);
});

test('a range can be made on a lane with no notes in it, and its panel says no notes', () => {
  const t = setup({ rangeInfo: { count: 0 } });
  t.view.onRedraw(t.drawn);
  dragRangeOn(t, 20, 24);
  assert.equal(t.read.laneName().textContent + t.read.position().textContent, 'Range · t1 · cycles 20 to 24 · no notes');
  assert.equal(t.calls.range.length, 1);
});

test('a pitch drag that is cancelled by the pointer or the capture ends without a write', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const p = press(t);
    p.move(FIRST_NOTE.y - 1.1 * REM);
    assert.equal(ghosts(t).length, 1);
    t.lanes.dispatch(type, { pointerId: 1 });
    assert.equal(ghosts(t).length, 0);
    assert.equal(t.lanes.getAttribute('data-dragging'), null);
    p.up(FIRST_NOTE.y - 1.1 * REM);
  }
  assert.deepEqual(t.calls.edit, []);
});

test('the moves of another pointer do not drag the note', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  t.lanes.dispatch('pointermove', { pointerId: 2, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y - 2 * REM });
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  p.up(FIRST_NOTE.y);
  assert.deepEqual(t.calls.edit, []);
});

// --- every way a drag ends without a write ---

/** Starts a pitch drag on lane 0's first note, two steps up, and returns the pointer. */
function dragging(t) {
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(ghosts(t).length, 1, 'the drag has begun');
  return p;
}

const STANDING = 'An edit rewrites one token in the code: c3.';

for (const [name, cancel] of [
  ['Escape on the lanes', (t) => {
    const event = t.key('Escape');
    assert.equal(event.stopped, true, 'Escape ends the drag and goes no further');
    assert.equal(event.defaultPrevented, true);
  }],
  ['a pointer cancel', (t) => t.lanes.dispatch('pointercancel', { pointerId: 1 })],
  ['a lost pointer capture', (t) => t.lanes.dispatch('lostpointercapture', { pointerId: 1 })],
  ['cancelGesture (a window blur)', (t) => t.view.cancelGesture()],
  ['a redraw', (t) => t.view.onRedraw(t.drawn)],
  ['a redraw with no lanes (a new version computing)', (t) => t.view.onRedraw(null)],
]) {
  test(`${name} during a pitch drag takes the ghost away, brings the sentence back and writes nothing`, () => {
    const t = setup();
    const p = dragging(t);
    assert.equal(t.line.textContent, 'c3 → d3 (+2 semitones). Release to write.');
    cancel(t);
    assert.equal(ghosts(t).length, 0);
    assert.equal(t.lanes.getAttribute('data-dragging'), null);
    assert.equal(t.lanes.capturedPointer, null);
    if (name !== 'a redraw with no lanes (a new version computing)') assert.equal(t.line.textContent, STANDING);
    // What the pointer does after that is nothing: no more steps, no write on release.
    p.move(FIRST_NOTE.y - 2 * REM);
    p.up(FIRST_NOTE.y - 2 * REM);
    assert.deepEqual(t.calls.edit, []);
    assert.equal(ghosts(t).length, 0);
  });
}

test('Escape with nothing left to clear is not stopped; Escape during a press that has not become a gesture clears the selection like any other', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  assert.equal(t.key('Escape').stopped, false);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.lanes.dispatch('pointerdown', { pointerId: 4, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
  assert.equal(t.key('Escape').stopped, true, 'the selection is cleared');
  assert.equal(t.view.selection(), null);
  assert.equal(t.key('Escape').stopped, false, 'nothing is left');
  t.lanes.dispatch('pointerup', { pointerId: 4, clientX: FIRST_NOTE.x, clientY: FIRST_NOTE.y });
});

test('Escape during a drag that already had a sentence from an earlier edit brings that sentence back', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', label: 'x', from: 'c3', to: 'c#3' });
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(t.line.textContent, 'c#3 → d#3 (+2 semitones). Release to write.', 'the drag starts from the c#3 the page wrote');
  t.key('Escape');
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
  assert.equal(t.calls.edit.length, 1, 'the drag wrote nothing');
});

test('a drag on a note the page cannot edit moves nothing: no ghost, the sentence offers the request, and the release prepares it', () => {
  const t = setup({ editable: false });
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(t.lanes.getAttribute('data-dragging'), 'refused');
  assert.equal(ghosts(t).length, 0);
  // 1.1 rem is two whole steps of half a rem: the sentence names them as a request.
  assert.equal(t.line.textContent, 'Release to ask Claude: raise this note by 2 semitones.');
  assert.equal(t.line.getAttribute('data-kind'), 'preview');
  // Inside the same whole step the sentence does not change.
  const seen = t.line.textContent;
  p.move(FIRST_NOTE.y - 1.2 * REM);
  assert.equal(t.line.textContent, seen);
  p.move(FIRST_NOTE.y - 3 * REM);
  assert.equal(ghosts(t).length, 0);
  assert.equal(t.line.textContent, 'Release to ask Claude: raise this note by 6 semitones.');
  assert.deepEqual(t.calls.prepare, [], 'nothing is prepared while the button is held');
  p.up(FIRST_NOTE.y - 3 * REM);
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.prepare, [[0, { kind: 'pitch', semitones: 6 }, { x: FIRST_NOTE.x, y: FIRST_NOTE.y - 3 * REM }]]);
  assert.equal(t.lanes.getAttribute('data-dragging'), null);
  assert.equal(t.read.state().textContent, 'Not editable');
  assert.equal(t.line.textContent, TIMELINE_COPY.noteRequestReady);
});

test('a drag down on a note the page cannot edit offers a lower request, an octave reads in octaves, and a release at no change prepares nothing', () => {
  const t = setup({ editable: false });
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y + 6 * REM);
  assert.equal(t.line.textContent, 'Release to ask Claude: lower this note by 1 octave.');
  p.move(FIRST_NOTE.y + 0.5 * REM);
  assert.equal(t.line.textContent, 'Release to ask Claude: lower this note by 1 semitone.');
  // Back to where it began: the sentence is the standing reason again and a release prepares nothing.
  p.move(FIRST_NOTE.y);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteReasons.degrees);
  p.up(FIRST_NOTE.y);
  assert.deepEqual(t.calls.prepare, []);
  assert.deepEqual(t.calls.edit, []);
  // A long way down is held at the end of the note range.
  const far = press(t, { id: 2 });
  far.move(FIRST_NOTE.y + 100 * REM);
  assert.equal(t.line.textContent, 'Release to ask Claude: lower this note by 127 semitones.');
  far.up(FIRST_NOTE.y + 100 * REM);
  assert.deepEqual(t.calls.prepare.map(([, change]) => change), [{ kind: 'pitch', semitones: -127 }]);
});

test('a drag of a refused note that is cancelled prepares nothing and takes its sentence away', () => {
  for (const cancel of [(t) => t.key('Escape'), (t) => t.lanes.dispatch('pointercancel', { pointerId: 1 }), (t) => t.view.cancelGesture(), (t) => t.view.onRedraw(t.drawn)]) {
    const t = setup({ editable: false });
    t.view.onRedraw(t.drawn);
    const p = press(t);
    p.move(FIRST_NOTE.y - 1.1 * REM);
    cancel(t);
    p.up(FIRST_NOTE.y - 2 * REM);
    assert.deepEqual(t.calls.prepare, []);
    assert.notEqual(t.line.textContent, 'Release to ask Claude: raise this note by 2 semitones.');
  }
});

test('Make a rest, Delete, Backspace, − and + on a note the page cannot edit prepare their request, even with a notice, and write nothing', () => {
  const t = setup({ editable: false });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  for (const kind of ['waiting', 'dirty', 'closed']) {
    t.view.setNotice(kind);
    buttonNamed(t, 'Make a rest').dispatch('click');
  }
  t.view.setNotice('waiting');
  const del = t.key('Delete');
  const back = t.key('Backspace');
  buttonNamed(t, '−').dispatch('click');
  buttonNamed(t, '+').dispatch('click');
  t.advance(5000);
  assert.deepEqual(
    t.calls.prepare.map(([event, change]) => [event, change]),
    [
      [0, { kind: 'rest' }],
      [0, { kind: 'rest' }],
      [0, { kind: 'rest' }],
      [0, { kind: 'rest' }],
      [0, { kind: 'rest' }],
      [0, { kind: 'velocity', steps: -1 }],
      [0, { kind: 'velocity', steps: 1 }],
    ],
  );
  for (const [, , point] of t.calls.prepare) assert.deepEqual(point, FIRST_NOTE);
  for (const event of [del, back]) assert.equal(event.stopped, true);
  assert.deepEqual(t.calls.edit, []);
  assert.equal(t.line.textContent, TIMELINE_COPY.noteRequestReady);
});

test('Ask Claude is there for every selected note, opens the box at the note, and is not switched off by a notice', () => {
  for (const editable of [true, false]) {
    const t = setup({ editable });
    t.view.onRedraw(t.drawn);
    const ask = buttonNamed(t, 'Ask Claude');
    assert.equal(ask.getAttribute('aria-label'), 'Ask Claude about this note');
    assert.equal(ask.getAttribute('title'), 'Opens the Ask box for this note.');
    assert.equal(ask.getAttribute('type'), 'button');
    assert.equal(t.read.buttons().at(-1), ask, 'it comes after Make a rest');
    ask.dispatch('click');
    assert.deepEqual(t.calls.ask, [], 'nothing selected');
    t.click(FIRST_NOTE.x, FIRST_NOTE.y);
    t.view.setNotice('closed');
    ask.dispatch('click');
    assert.equal(ask.getAttribute('aria-disabled'), null);
    assert.deepEqual(t.calls.ask, [[0, FIRST_NOTE]]);
    assert.deepEqual(t.calls.prepare, []);
    assert.deepEqual(t.calls.edit, []);
  }
});

test('Enter on the lanes asks about the selected note, Shift+F10 and the Menu key too, and they are stopped; other presses go on', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  for (const [name, extra] of [['Enter', {}], ['F10', { shiftKey: true }], ['ContextMenu', {}]]) {
    const idle = t.key(name, extra);
    assert.equal(idle.stopped, false, `${name} with nothing selected`);
  }
  assert.deepEqual(t.calls.ask, []);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  for (const [name, extra] of [['Enter', {}], ['F10', { shiftKey: true }], ['ContextMenu', {}]]) {
    const event = t.key(name, extra);
    assert.equal(event.stopped, true, name);
    assert.equal(event.defaultPrevented, true, name);
  }
  assert.deepEqual(t.calls.ask, [[0, FIRST_NOTE], [0, FIRST_NOTE], [0, FIRST_NOTE]]);
  // Held Enter is one press; F10 alone, the Menu key with Shift and every modifier go on to the page.
  const before = t.calls.ask.length;
  assert.equal(t.key('Enter', { repeat: true }).stopped, true);
  for (const [name, extra] of [['F10', {}], ['ContextMenu', { shiftKey: true }], ['Enter', { shiftKey: true }], ['Enter', { ctrlKey: true }], ['F10', { shiftKey: true, altKey: true }]]) {
    assert.equal(t.key(name, extra).stopped, false, `${name} ${JSON.stringify(extra)}`);
  }
  assert.equal(t.calls.ask.length, before);
  assert.deepEqual(t.calls.edit, []);
});

test('after an edit refused at the read-back or one that did not evaluate, Ask Claude prepares that change until the next gesture or selection', () => {
  for (const outcome of [{ kind: 'refused', reason: 'read-back' }, { kind: 'refused', reason: 'write-mismatch' }, { kind: 'refused', reason: 'error' }, { kind: 'failed' }]) {
    const t = setup();
    t.view.onRedraw(t.drawn);
    t.click(FIRST_NOTE.x, FIRST_NOTE.y);
    t.key('ArrowUp', { shiftKey: true });
    t.advance(600);
    assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 12 }]]);
    t.answer(outcome);
    buttonNamed(t, 'Ask Claude').dispatch('click');
    assert.deepEqual(t.calls.prepare, [[0, { kind: 'pitch', semitones: 12 }, FIRST_NOTE]], JSON.stringify(outcome));
    assert.deepEqual(t.calls.ask, []);
    assert.equal(t.line.textContent, TIMELINE_COPY.noteRequestReady);
    // Enter does the same as the button.
    t.key('Enter');
    assert.equal(t.calls.prepare.length, 2);
    assert.deepEqual(t.calls.ask, []);
    // The next gesture ends it.
    t.key('ArrowDown');
    buttonNamed(t, 'Ask Claude').dispatch('click');
    assert.equal(t.calls.prepare.length, 2);
    assert.deepEqual(t.calls.ask, [[0, FIRST_NOTE]]);
  }
});

test('an error that came after the write says to check the code and does not offer the change to Claude, which would make it twice', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp', { shiftKey: true });
  t.advance(600);
  t.answer({ kind: 'refused', reason: 'error', afterWrite: true });
  assert.equal(t.line.textContent, TIMELINE_COPY.noteEditErrorWritten);
  buttonNamed(t, 'Ask Claude').dispatch('click');
  assert.deepEqual(t.calls.prepare, [], 'no ready-made request: the code may already hold the change');
  assert.deepEqual(t.calls.ask, [[0, FIRST_NOTE]], 'Ask Claude opens the box with an empty field');
});

test('an error before the write (an evaluation that threw and was taken back) says the code is as it was, offers the change to Claude, and holds no edit back', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.key('ArrowDown');
  t.key('ArrowDown');
  t.advance(600);
  t.answer({ kind: 'refused', reason: 'error' });
  assert.equal(t.line.textContent, TIMELINE_COPY.noteEditError);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }], [0, { kind: 'pitch', semitones: -2 }]], 'no lanes are coming: the next edit goes at once');
  assert.equal(t.timers.size, 1, 'only the wait for the second edit\'s answer');
  t.answer();
  buttonNamed(t, 'Ask Claude').dispatch('click');
  assert.deepEqual(t.calls.prepare, [], 'the second edit was answered after the error: Ask Claude follows the latest answer');
  // On its own, the error arms Ask Claude with the change.
  const u = setup();
  u.view.onRedraw(u.drawn);
  u.click(FIRST_NOTE.x, FIRST_NOTE.y);
  u.key('ArrowUp');
  u.advance(600);
  u.answer({ kind: 'refused', reason: 'error' });
  buttonNamed(u, 'Ask Claude').dispatch('click');
  assert.deepEqual(u.calls.prepare.map(([event, change]) => [event, change]), [[0, { kind: 'pitch', semitones: 1 }]]);
});

test('an edit refused for another reason, a rest or a velocity step that was refused, and a new selection each have their own Ask Claude', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(t, 'Make a rest').dispatch('click');
  t.answer({ kind: 'refused', reason: 'read-back' });
  buttonNamed(t, 'Ask Claude').dispatch('click');
  assert.deepEqual(t.calls.prepare.map(([, change]) => change), [{ kind: 'rest' }]);
  // A stale edit is not offered as a request: the note it named may be another one now.
  buttonNamed(t, 'Make a rest').dispatch('click');
  t.answer({ kind: 'refused', reason: 'stale' });
  buttonNamed(t, 'Ask Claude').dispatch('click');
  assert.equal(t.calls.prepare.length, 1);
  assert.equal(t.calls.ask.length, 1);
  // A selection ends the remembered request.
  buttonNamed(t, 'Make a rest').dispatch('click');
  t.answer({ kind: 'refused', reason: 'read-back' });
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(t, 'Ask Claude').dispatch('click');
  assert.equal(t.calls.prepare.length, 1);
  assert.equal(t.calls.ask.length, 2);
  // A velocity that cannot be written says to ask Claude, and Ask Claude carries the step that was refused.
  const fixed = setup({ velocityWritable: false });
  fixed.view.onRedraw(fixed.drawn);
  fixed.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(fixed, '+').dispatch('click');
  assert.equal(fixed.line.textContent, TIMELINE_COPY.noteVelocityRefusal);
  buttonNamed(fixed, 'Ask Claude').dispatch('click');
  assert.deepEqual(fixed.calls.prepare.map(([, change]) => change), [{ kind: 'velocity', steps: 1 }]);
});

/** A describe handler that gives lane 0's first note the token `text` at note number `midi`. */
const tokenAt = (text, midi) => ({
  describe: (laneIndex, eventIndex) => ({
    laneIndex, eventIndex, track: 't1', cycle: 1, beat: 1, section: null, noteText: text, midi, drum: null, velocity: 0.8, editable: true, reason: null,
    seen: { token: { start: 3, end: 3 + text.length, text } },
  }),
});

test('a drag past the highest or the lowest note stops there and says so; a release at no change writes nothing', () => {
  const high = setup({ handlers: tokenAt('g9', 127) });
  high.view.onRedraw(high.drawn);
  let p = press(high);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(high.line.textContent, 'Already the highest note.');
  assert.equal(ghosts(high).length, 0);
  p.up(FIRST_NOTE.y - 1.1 * REM);
  assert.deepEqual(high.calls.edit, []);
  const low = setup({ handlers: tokenAt('c-1', 0) });
  low.view.onRedraw(low.drawn);
  p = press(low);
  p.move(FIRST_NOTE.y + 1.1 * REM);
  assert.equal(low.line.textContent, 'Already the lowest note.');
  p.up(FIRST_NOTE.y + 1.1 * REM);
  assert.deepEqual(low.calls.edit, []);
  // One step from the end the drag is held at the end, and that one step is what a release writes.
  const near = setup({ handlers: tokenAt('f#9', 126) });
  near.view.onRedraw(near.drawn);
  p = press(near);
  p.move(FIRST_NOTE.y - 1.6 * REM);
  assert.equal(near.line.textContent, 'f#9 → g9 (+1 semitone). Release to write.');
  p.move(FIRST_NOTE.y - 2.6 * REM);
  assert.equal(near.line.textContent, 'f#9 → g9 (+1 semitone). Release to write.');
  p.up(FIRST_NOTE.y - 2.6 * REM);
  assert.deepEqual(near.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
});

test('a drum note is dragged like any note: the sentence names the drum it comes from and the one it lands on', () => {
  const drum = {
    describe: (laneIndex, eventIndex) => ({
      laneIndex, eventIndex, track: 'drums', cycle: 1, beat: 1, section: null, noteText: '36', midi: 36, drum: 'Kick', velocity: 0.8, editable: true, reason: null,
      seen: { token: { start: 3, end: 5, text: '36' } },
    }),
  };
  const t = setup({ handlers: drum });
  t.view.onRedraw(t.drawn);
  // Lane 1's first note is on its lower row.
  const p = press(t, { x: 150, y: 100 + 75 });
  p.move(100 + 75 - 1.1 * REM);
  assert.equal(t.read.values()[0].textContent, '36 · Kick');
  assert.equal(t.line.textContent, '36 Kick → 38 Snare (+2 semitones). Release to write.');
  assert.equal(all(t.laneNodes[1], 'lane-marks')[0].children.some((node) => node.className === 'tl-ghost'), true);
  p.move(100 + 75 - 0.6 * REM);
  assert.equal(t.line.textContent, '36 Kick → 37 · not in GM (+1 semitone). Release to write.');
  p.up(100 + 75 - 0.6 * REM);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
});

test('a long drag writes the sentence once for each whole step and nothing for the pixels between', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const p = press(t);
  p.move(FIRST_NOTE.y - 5);
  const before = t.line.writes;
  let steps = 0;
  let last = t.line.textContent;
  for (let dy = 5; dy <= 6 * STEP + 2; dy += 0.5) {
    p.move(FIRST_NOTE.y - dy);
    if (t.line.textContent !== last) {
      steps += 1;
      last = t.line.textContent;
    }
  }
  // Six whole steps were crossed; each wrote the text (and kind) once: no write came from the pixels in between.
  assert.equal(steps, 6);
  assert.ok(t.line.writes - before <= 12, `${t.line.writes - before} writes for 6 steps`);
  p.up(FIRST_NOTE.y - 6 * STEP - 2);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 6 }]]);
});

// --- the selection across a redraw ---

test('the lanes drawn again for the same page select the same note again, keep the sentence of the edit and show the new code', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', label: 'x', from: 'c3', to: 'd3' });
  // The code is computing: nothing is drawn, the panel goes away, and the key is kept.
  t.view.onRedraw(null);
  assert.equal(t.panel.hidden, true);
  t.view.onRedraw(null);
  const describes = t.calls.describe.length;
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'd3' }));
  assert.equal(t.calls.describe.length, describes + 1, 'the page is asked about the note again, as for a click');
  assert.deepEqual(t.view.selection() === null ? null : [t.view.selection().laneIndex, t.view.selection().eventIndex], [0, 0]);
  assert.equal(t.read.rings().length, 1);
  assert.equal(t.read.state().textContent, 'Editable');
  assert.equal(t.line.textContent, 'Changed c3 to d3.');
  // The restored selection is the selection of the new code: drawn once more, it is kept again.
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'd3' }));
  assert.notEqual(t.view.selection(), null);
});

test('a redraw that only follows a new rig message keeps the selection with no edit in between', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(350, 10);
  t.view.onRedraw(t.drawn);
  assert.notEqual(t.view.selection(), null);
  assert.equal(t.view.selection().eventIndex, 1);
});

test('a note whose pitch is neither the old one nor the one the edit asked for is not selected again', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer();
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'a3' }));
  assert.equal(t.view.selection(), null);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'c#3' }));
  assert.notEqual(t.view.selection(), null, 'the pitch the step asked for');
});

test('a lane whose identity was built from its strings is found again by its track index; a labeled lane is not', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.view.onRedraw(null);
  // The lane had the identity of a label: another identity at the same index is another lane.
  t.view.onRedraw(withFirstNote(t.drawn, { note: 'c#3' }, { identity: 'label:t9' }));
  assert.equal(t.view.selection(), null);

  const strings = setup();
  const unlabeled = { ...strings.drawn, lanes: strings.drawn.lanes.map((lane, index) => (index === 0 ? { ...lane, identity: 'note:c3 e3 g3' } : lane)) };
  strings.view.onRedraw(unlabeled);
  strings.click(FIRST_NOTE.x, FIRST_NOTE.y);
  strings.key('ArrowUp');
  strings.advance(600);
  strings.view.onRedraw(null);
  const edited = withFirstNote(unlabeled, { note: 'c#3' }, { identity: 'note:c#3 e3 g3' });
  strings.view.onRedraw(edited);
  assert.notEqual(strings.view.selection(), null, 'found again by its track index');
  assert.equal(strings.view.selection().laneIndex, 0);
});

test('a page turn drops the selection and any gesture and keeps the sentence of the edit', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  t.advance(600);
  t.answer({ kind: 'written', label: 'x', from: 'c3', to: 'c#3' });
  t.view.onRedraw(null);
  t.view.onRedraw({ ...t.drawn, pageStart: 32 });
  assert.equal(t.view.selection(), null);
  assert.equal(t.read.rings().length, 0);
  assert.equal(t.line.textContent, 'Changed c3 to c#3.');
  assert.equal(t.read.position().textContent, 'No note selected');
  // The key is gone: coming back to the first page does not select anything.
  t.view.onRedraw(t.drawn);
  assert.equal(t.view.selection(), null);
  // A drag in progress at the turn ends with it.
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  t.view.onRedraw({ ...t.drawn, pageStart: 64 });
  assert.equal(ghosts(t).length, 0);
  p.up(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(t.calls.edit.length, 1, 'only the edit before the turn');
  assert.equal(t.view.selection(), null);
});

// --- the pointer over the lanes ---

test('what is under the pointer is written on the lanes when it changes: a note, empty area, or nothing', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const over = (x, y) => t.lanes.dispatch('pointermove', { pointerId: 9, clientX: x, clientY: y });
  assert.equal(t.lanes.getAttribute('data-hover'), null);
  over(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.lanes.getAttribute('data-hover'), 'note');
  const writes = t.lanes.writes;
  over(FIRST_NOTE.x + 3, FIRST_NOTE.y + 1);
  over(FIRST_NOTE.x + 6, FIRST_NOTE.y);
  assert.equal(t.lanes.writes, writes, 'the same word is not written again');
  over(1500, 50);
  assert.equal(t.lanes.getAttribute('data-hover'), 'empty');
  over(40, 50);
  assert.equal(t.lanes.getAttribute('data-hover'), null, 'the name column is not a lane area');
  over(FIRST_NOTE.x, FIRST_NOTE.y);
  t.lanes.dispatch('pointerleave', {});
  assert.equal(t.lanes.getAttribute('data-hover'), null);
  // While a button is down the hover word is not touched.
  over(FIRST_NOTE.x, FIRST_NOTE.y);
  const p = press(t);
  p.move(FIRST_NOTE.y - 1.1 * REM);
  assert.equal(t.lanes.getAttribute('data-hover'), 'note');
  p.up(FIRST_NOTE.y - 1.1 * REM);
});

// --- where a token plays ---

/** The same lanes with places in the code on lane 0: notes 0 and 3 carry the token the fake describes (starting at 3). */
const withToken = (drawn) => ({
  ...drawn,
  lanes: drawn.lanes.map((lane, index) =>
    index !== 0
      ? lane
      : {
          ...lane,
          events: lane.events.map((entry, at) => ({
            ...entry,
            locations: at === 0 || at === 3 ? [{ start: 3, end: 5 }] : at === 1 ? [{ start: 6, end: 8 }] : null,
          })),
        },
  ),
});

const sames = (t) => all(t.lanes, 'tl-same');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the other notes that carry the selected token get a dotted ring, the selected one and a refused note do not', () => {
  const t = setup();
  t.view.onRedraw(withToken(t.drawn));
  assert.equal(sames(t).length, 0, 'nothing selected, nothing marked');
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  const [dotted] = sames(t);
  assert.equal(sames(t).length, 1, 'only note 3 shares the token with note 0');
  assert.equal(dotted.parentNode, all(t.laneNodes[0], 'lane-marks')[0]);
  assert.equal(dotted.style.left, `${(6 / 32) * 100}%`);
  assert.equal(dotted.style.width, `${(1 / 32) * 100}%`);
  assert.equal(t.read.rings().length, 1);
  // Another selection moves the marks (the fake describes every note with the same token, so notes 0 and 3 are the others);
  // clearing the selection takes them away.
  t.click(350, 10);
  assert.equal(sames(t).length, 2);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(sames(t).length, 1);
  t.click(1500, 50);
  assert.equal(sames(t).length, 0);
  // A note the page cannot edit has no token to share.
  const refused = setup({ editable: false });
  refused.view.onRedraw(withToken(refused.drawn));
  refused.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(sames(refused).length, 0);
  // A redraw gives the marks to the note that comes back.
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.view.onRedraw(withToken(t.drawn));
  assert.equal(sames(t).length, 1);
});

test('a token that plays in several places says so as soon as the count arrives, and the previews and steps repeat the count', async () => {
  const counting = Promise.resolve({ count: 3, sections: ['x', 'z'], onPage: false });
  const t = setup({ info: { places: counting } });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.', 'the count is still being worked out');
  await settle();
  assert.equal(t.line.textContent, "Plays in 3 places: sections 'x' and 'z'. An edit changes all of them.");
  assert.equal(t.line.getAttribute('data-kind'), 'standing');
  // Steps repeat the count.
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'c3 → c#3 (+1 semitone), in 3 places. Writing in a moment.');
  t.advance(600);
  assert.deepEqual(t.calls.edit, [[0, { kind: 'pitch', semitones: 1 }]]);
  // A drag repeats it too.
  const p = press(t);
  p.move(FIRST_NOTE.y - STEP - 1);
  assert.equal(t.line.textContent, 'c#3 → d3 (+1 semitone), in 3 places. Release to write.', 'from the c#3 the edit on its way will write');
  p.up(FIRST_NOTE.y - STEP - 1);
});

test('a count that arrives for a note that is no longer selected is not shown', async () => {
  let resolve;
  const slow = new Promise((done) => {
    resolve = done;
  });
  // Only the first note's count is the slow one; the second note's count has not arrived.
  const t = setup({ info: (laneIndex, eventIndex) => ({ places: eventIndex === 0 ? slow : new Promise(() => {}) }) });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.click(350, 10);
  resolve({ count: 2, sections: ['x'], onPage: false });
  await settle();
  assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.', 'the second note has a count of its own pending');
});

test('a count that arrives while steps wait is written into their sentence', async () => {
  let resolve;
  const slow = new Promise((done) => {
    resolve = done;
  });
  const t = setup({ info: { places: slow } });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  t.key('ArrowUp');
  assert.equal(t.line.textContent, 'c3 → c#3 (+1 semitone). Writing in a moment.');
  resolve({ count: 2, sections: ['x', 'z'], onPage: false });
  await settle();
  assert.equal(t.line.textContent, 'c3 → c#3 (+1 semitone), in 2 places. Writing in a moment.');
});

test('a count that cannot be worked out is reported, and the standing sentence stays what it was', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const t = setup({ info: { places: Promise.reject(new Error('no pattern')) } });
    t.view.onRedraw(t.drawn);
    t.click(FIRST_NOTE.x, FIRST_NOTE.y);
    await settle();
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /places of the selected token could not be counted/);
    assert.equal(t.line.textContent, 'An edit rewrites one token in the code: c3.');
  } finally {
    console.error = original;
  }
});

test('a count on this page alone is told as such, in a piece without a structure only a token drawn several times in a cycle is told', async () => {
  const page = setup({ info: { places: { count: 3, sections: ['a', 'b', 'c'], onPage: true } } });
  page.view.onRedraw(page.drawn);
  page.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(page.line.textContent, "Plays in 3 places on this page: sections 'a', 'b' and 'c'. An edit changes every place it plays, on this page and after it.");
  page.key('ArrowUp');
  assert.equal(page.line.textContent, 'c3 → c#3 (+1 semitone), in 3 places on this page. Writing in a moment.');
  const twice = setup({ info: { perCycle: 2 } });
  twice.view.onRedraw(twice.drawn);
  twice.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(twice.line.textContent, 'This token draws 2 notes in each cycle. An edit changes all of them.');
  twice.key('ArrowDown');
  assert.equal(twice.line.textContent, 'c3 → b2 (-1 semitone), in 2 places. Writing in a moment.');
  const once = setup({ info: { perCycle: 1 } });
  once.view.onRedraw(once.drawn);
  once.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(once.line.textContent, 'An edit rewrites one token in the code: c3.');
});

test('a velocity number shared by several notes of the page is told in the velocity sentence', () => {
  const velocity = { writable: true, token: { start: 10, end: 13, text: '0.5' }, gain: 1, shown: 0.8 };
  const t = setup({ seen: { velocity } });
  const drawn = t.drawn;
  const shared = {
    ...drawn,
    lanes: drawn.lanes.map((lane, index) =>
      index !== 0 ? lane : { ...lane, events: lane.events.map((entry, at) => ({ ...entry, locations: at === 2 ? null : [{ start: 10, end: 13 }] })) },
    ),
  };
  t.view.onRedraw(shared);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(t, '+').dispatch('click');
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.90, for 3 notes on this page. Writing in a moment.');
  // A velocity that only this note reads says nothing of the kind.
  const alone = setup({ seen: { velocity } });
  alone.view.onRedraw(alone.drawn);
  alone.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(alone, '+').dispatch('click');
  assert.equal(alone.line.textContent, 'Velocity 0.80 → 0.90. Writing in a moment.');
});

test('a velocity number that plays in several places says so once the page has counted them, and a count that is still coming changes the words when it arrives', async () => {
  const velocity = { writable: true, token: { start: 10, end: 13, text: '0.5' }, gain: 1, shown: 0.8 };
  let arrive;
  const counting = new Promise((resolve) => {
    arrive = resolve;
  });
  const t = setup({ seen: { velocity }, info: { velocityPlaces: counting } });
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(t, '+').dispatch('click');
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.90. Writing in a moment.');
  arrive({ count: 3, sections: ['x', 'y', 'z'], onPage: false });
  await settle();
  assert.equal(t.line.textContent, 'Velocity 0.80 → 0.90 in 3 places. Writing in a moment.', 'the words on screen are written again with the count');
  // The count of the pitch token is a different thing: it does not leak into the velocity sentence.
  const pitchOnly = setup({ seen: { velocity }, info: { places: { count: 4, sections: ['a', 'b'], onPage: false } } });
  pitchOnly.view.onRedraw(pitchOnly.drawn);
  pitchOnly.click(FIRST_NOTE.x, FIRST_NOTE.y);
  buttonNamed(pitchOnly, '+').dispatch('click');
  assert.equal(pitchOnly.line.textContent, 'Velocity 0.80 → 0.90. Writing in a moment.');
});

// --- the keyboard model ---

/** The same lanes with lane 1 emptied: a lane with no notes on the page, where the keyboard cursor can stand. */
const withEmptyLane = (drawn) => ({ ...drawn, lanes: drawn.lanes.map((lane, index) => (index === 1 ? { ...lane, events: [], shapes: [] } : lane)) });

/** The panel's buttons that can be seen: not hidden themselves and not inside a hidden group. */
const shownButtons = (t) => t.read.buttons().filter((node) => !node.hidden && !(node.parentNode !== null && node.parentNode.hidden));

/** The element the lanes point at, or null when they point at nothing. */
const activeElement = (t) => {
  const id = t.lanes.getAttribute('aria-activedescendant');
  return id === null ? null : t.document.getElementById(id);
};

test('Tab into the lanes selects nothing and points at nothing: the keyboard does not change anything by arriving', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.lanes.focus();
  assert.equal(t.view.selection(), null);
  assert.deepEqual(t.calls.describe, []);
  assert.equal(t.lanes.getAttribute('aria-activedescendant'), null);
  assert.equal(all(t.lanes, 'tl-active').length, 0);
  assert.equal(t.read.position().textContent, 'No note selected');
});

test('Right with nothing selected takes the first note of the first lane that has one, Left its last; Home, End and the Page keys go on to the page', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  for (const name of ['Home', 'End', 'PageUp', 'PageDown']) {
    const event = t.key(name);
    assert.equal(event.stopped, false, name);
    assert.equal(event.defaultPrevented, false, name);
  }
  assert.equal(t.view.selection(), null);
  const right = t.key('ArrowRight');
  assert.equal(right.defaultPrevented, true);
  assert.equal(right.stopped, true);
  assert.deepEqual(t.view.selection() && [t.view.selection().laneIndex, t.view.selection().eventIndex], [0, 0]);
  t.key('Escape');
  t.key('ArrowLeft');
  // The tick (event 2) is not a note to pick: the last note of lane 0 is event 3.
  assert.deepEqual(t.view.selection() && [t.view.selection().laneIndex, t.view.selection().eventIndex], [0, 3]);
});

test('Left and Right walk the notes of the lane, skip the tick and stop at the first and the last note; Home and End go to the ends', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  const at = () => [t.view.selection().laneIndex, t.view.selection().eventIndex];
  t.key('ArrowRight');
  t.key('ArrowRight');
  assert.deepEqual(at(), [0, 1]);
  t.key('ArrowRight');
  assert.deepEqual(at(), [0, 3]);
  const last = t.key('ArrowRight');
  assert.deepEqual(at(), [0, 3]);
  assert.equal(last.defaultPrevented, true, 'a key at the end is still the Timeline\'s');
  t.key('ArrowLeft');
  assert.deepEqual(at(), [0, 1]);
  t.key('Home');
  assert.deepEqual(at(), [0, 0]);
  const first = t.key('ArrowLeft');
  assert.deepEqual(at(), [0, 0]);
  assert.equal(first.stopped, true);
  t.key('End');
  assert.deepEqual(at(), [0, 3]);
  // The panel follows the selection and the sentence is the standing one of the note.
  assert.equal(t.read.position().textContent, ' · cycle 4, beat 2');
  assert.equal(t.read.rings().length, 1);
  // Moving along reads the notes and writes none of them.
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.prepare, []);
  assert.deepEqual(t.calls.ask, []);
});

test('Page Down and Page Up change lane and keep the cycle: the note nearest in time is selected', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.key('End');
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowRight');
  // Lane 0's last note starts at cycle 6; the drum lane has notes at cycles 0 and 1, the nearer is the one at 1.
  t.key('PageDown');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [1, 1]);
  assert.equal(t.read.laneName().textContent, 'drums');
  t.key('PageDown');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [1, 1], 'the last lane stays');
  t.key('PageUp');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [0, 0]);
  const top = t.key('PageUp');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [0, 0], 'the first lane stays');
  assert.equal(top.stopped, true);
  // The lane the keys arrived on is brought into view.
  assert.ok(t.laneNodes[1].scrolledIntoView >= 1);
});

test('the active note is one element in the lane, not hidden from screen readers, with the name of the contract, pointed at by the lanes', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.key('ArrowRight');
  const active = activeElement(t);
  assert.notEqual(active, null);
  assert.equal(all(t.lanes, 'tl-active').length, 1);
  assert.equal(active.parentNode, t.laneNodes[0], 'in the lane itself, not in its mark layer, which screen readers skip');
  assert.equal(active.getAttribute('aria-hidden'), null);
  assert.equal(all(t.laneNodes[0], 'lane-marks')[0].getAttribute('aria-hidden'), 'true');
  assert.equal(active.getAttribute('role'), 'img');
  assert.equal(active.getAttribute('aria-label'), 't1, cycle 1, beat 2: note c3, velocity 0.80. Editable.');
  // The next note takes the element's place: still one, with the next name.
  t.key('ArrowRight');
  assert.equal(all(t.lanes, 'tl-active').length, 1);
  assert.equal(activeElement(t).getAttribute('aria-label'), 't1, cycle 2, beat 2: note c3, velocity 0.80. Editable.');
  // A note that cannot be edited says so and gives the reason.
  const refused = setup({ editable: false });
  refused.view.onRedraw(refused.drawn);
  refused.key('ArrowRight');
  assert.equal(activeElement(refused).getAttribute('aria-label'), `t1, cycle 1, beat 2: note c3, velocity 0.80. Not editable. ${TIMELINE_COPY.noteReasons.degrees}`);
  // Clearing the selection takes the element and the attribute away.
  t.key('Escape');
  assert.equal(all(t.lanes, 'tl-active').length, 0);
  assert.equal(t.lanes.getAttribute('aria-activedescendant'), null);
});

test('the active element is made again on a redraw and follows the note that comes back; a click selects it too', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.click(FIRST_NOTE.x, FIRST_NOTE.y);
  assert.equal(activeElement(t).getAttribute('aria-label'), 't1, cycle 1, beat 2: note c3, velocity 0.80. Editable.');
  const before = activeElement(t);
  // The Timeline draws new lane elements; the view puts a new active element in the new lane.
  t.laneNodes[0].remove();
  t.laneNodes[1].remove();
  const again = [0, 1].map((k) => {
    const lane = fakeNode('div', t.document);
    const svg = fakeNode('svg', t.document);
    svg.className = 'lane-events';
    svg.rect = { ...RECT, top: k * 100, bottom: k * 100 + 100 };
    lane.appendChild(svg);
    t.lanes.appendChild(lane);
    return lane;
  });
  t.view.onRedraw({ ...t.drawn });
  assert.equal(all(t.lanes, 'tl-active').length, 1);
  assert.notEqual(activeElement(t), before);
  assert.equal(activeElement(t).parentNode, again[0]);
  assert.equal(activeElement(t).getAttribute('aria-label'), 't1, cycle 1, beat 2: note c3, velocity 0.80. Editable.');
  // A redraw that finds no such note leaves nothing selected and points at nothing.
  t.view.onRedraw(null);
  assert.equal(t.lanes.getAttribute('aria-activedescendant'), null);
});

test('Page Down onto a lane with no notes puts the cursor there: the lane, no notes on this page, only Ask Claude, and its own hint', () => {
  const t = setup();
  t.view.onRedraw(withEmptyLane(t.drawn));
  t.key('ArrowRight');
  t.key('PageDown');
  assert.equal(t.view.selection(), null, 'a cursor is not a selection');
  assert.equal(t.read.laneName().textContent, 'drums');
  assert.equal(t.read.position().textContent, ' · no notes on this page');
  assert.equal(t.read.state().textContent, '');
  assert.equal(t.read.controls().hidden, false);
  assert.deepEqual(shownButtons(t).map((node) => node.textContent), ['Ask Claude']);
  assert.equal(shownButtons(t)[0].getAttribute('aria-label'), 'Ask Claude about this lane');
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintCursor);
  assert.equal(t.line.textContent, '');
  assert.equal(t.read.rings().length, 0);
  // The cursor is told to screen readers like a note.
  assert.equal(activeElement(t).getAttribute('aria-label'), 'drums, cycle 0: no notes on this page.');
  assert.equal(activeElement(t).parentNode, t.laneNodes[1]);
  // The keys that move along a lane have nothing to move along; the keys that change a note change nothing.
  for (const name of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.equal(t.key(name).stopped, true, name);
  assert.equal(t.read.position().textContent, ' · no notes on this page');
  for (const name of ['ArrowUp', 'ArrowDown', 'Delete', 'Backspace']) {
    const event = t.key(name);
    assert.equal(event.stopped, false, name);
    assert.equal(event.defaultPrevented, false, name);
  }
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.prepare, []);
  // Page Up goes back to the nearest note of the lane before, and Escape clears the cursor.
  t.key('PageUp');
  assert.deepEqual([t.view.selection().laneIndex, t.view.selection().eventIndex], [0, 0]);
  t.key('PageDown');
  t.key('Escape');
  assert.equal(t.read.position().textContent, 'No note selected');
  assert.equal(t.lanes.getAttribute('aria-activedescendant'), null);
  assert.equal(t.key('Escape').stopped, false);
});

test('Enter, the panel button, Shift+F10 and the Menu key ask about the lane under the cursor, at its cycle, and write nothing', () => {
  const t = setup();
  t.view.onRedraw(withEmptyLane(t.drawn));
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('ArrowRight');
  t.key('PageDown');
  // The cursor is on lane 1 at cycle 6 (the last note of lane 0 starts there).
  assert.equal(t.read.position().textContent, ' · no notes on this page');
  const enter = t.key('Enter');
  assert.equal(enter.stopped, true);
  shownButtons(t)[0].dispatch('click');
  t.key('F10', { shiftKey: true });
  t.key('ContextMenu');
  assert.equal(t.calls.askLane.length, 4);
  for (const [laneIndex, cycle, point] of t.calls.askLane) {
    assert.equal(laneIndex, 1);
    assert.equal(cycle, 6);
    // Half a cycle into the cycle, in the middle of the lane: 100 pixels a cycle from the left edge of the event area.
    assert.deepEqual(point, { x: 100 + 6.5 * 100, y: 150 });
  }
  assert.deepEqual(t.calls.ask, []);
  assert.deepEqual(t.calls.edit, []);
});

test('Shift+Left and Shift+Right start a range from the cursor\'s cycle, which replaces the cursor', () => {
  const t = setup();
  t.view.onRedraw(withEmptyLane(t.drawn));
  t.key('ArrowRight');
  t.key('PageDown');
  const event = t.key('ArrowRight', { shiftKey: true });
  assert.equal(event.stopped, true);
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 1, from: 0, to: 1, cut: null });
  assert.equal(t.lanes.getAttribute('aria-activedescendant'), null, 'a range is not an active note');
  assert.equal(t.read.hint().textContent, TIMELINE_COPY.noteHintRange);
  // The plain keys of the lanes leave a range alone: they go on to the page.
  for (const name of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) assert.equal(t.key(name).stopped, false, name);
  assert.deepEqual(t.view.rangeSelection(), { laneIndex: 1, from: 0, to: 1, cut: null });
});

test('Escape steps back one thing at a time: steps not written, a range, the selection, and only then the page', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.key('ArrowRight');
  t.key('ArrowUp');
  assert.equal(t.timers.size, 1);
  assert.equal(t.key('Escape').stopped, true, 'the steps go');
  assert.equal(t.timers.size, 0);
  assert.notEqual(t.view.selection(), null);
  assert.equal(t.key('Escape').stopped, true, 'the selection goes');
  assert.equal(t.view.selection(), null);
  assert.equal(t.key('Escape').stopped, false, 'with nothing left the page closes the view');
  // A range goes before anything else is looked at, and a second Escape then goes on.
  t.key('ArrowRight');
  t.key('ArrowRight', { shiftKey: true });
  assert.notEqual(t.view.rangeSelection(), null);
  assert.equal(t.key('Escape').stopped, true, 'the range goes');
  assert.equal(t.view.rangeSelection(), null);
  assert.equal(t.key('Escape').stopped, false);
  t.advance(5000);
  assert.deepEqual(t.calls.edit, []);
});

test('the keys 1 to 6 and a, b, c keep their meaning with a note, a cursor or nothing selected: they are never stopped', () => {
  const t = setup();
  t.view.onRedraw(withEmptyLane(t.drawn));
  const keys = ['1', '2', '3', '4', '5', '6', 'a', 'b', 'c'];
  for (const place of [() => {}, () => t.key('ArrowRight'), () => t.key('PageDown')]) {
    place();
    for (const name of keys) {
      const event = t.key(name);
      assert.equal(event.stopped, false, name);
      assert.equal(event.defaultPrevented, false, name);
    }
  }
});

test('no key the Timeline consumes changes the music unless a note is selected', () => {
  const t = setup();
  t.view.onRedraw(withEmptyLane(t.drawn));
  const everything = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Backspace', 'Enter', 'Escape', 'F10', 'ContextMenu'];
  // Nothing selected, then a cursor on a lane without notes: no key writes, prepares or asks about a note.
  for (const place of [() => {}, () => { t.key('ArrowRight'); t.key('PageDown'); }]) {
    place();
    for (const name of everything) t.key(name, name === 'F10' ? { shiftKey: true } : {});
    t.advance(5000);
  }
  assert.deepEqual(t.calls.edit, []);
  assert.deepEqual(t.calls.prepare, []);
  assert.deepEqual(t.calls.ask, []);
});

test('a key that goes nowhere (the first note, the last lane) writes nothing: the page is not touched', () => {
  const t = setup();
  t.view.onRedraw(t.drawn);
  t.key('ArrowRight');
  t.key('Home');
  const writes = t.document.writes;
  for (const name of ['Home', 'ArrowLeft', 'PageUp']) t.key(name);
  assert.equal(t.document.writes, writes);
  t.key('PageDown');
  t.key('PageDown');
  const last = t.document.writes;
  t.key('PageDown');
  assert.equal(t.document.writes, last);
});
