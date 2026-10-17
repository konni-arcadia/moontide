// The Jam view's DOM code, tested without a browser against the fake document. The markup comes from page/index.html itself, so
// the view is built over the very ids the page has. The live view in real Chrome is proved by `npm run probe:page -- --only jam`;
// these tests pin what the view writes, and that it writes only what changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildReading, readingAt } from '../page/jam-analysis.js';
import { buildJamModel } from '../page/jam-model.js';
import { resolveReading, createScaleMemory } from '../page/jam-resolve.js';
import { createJamView } from '../page/jam-view.js';
import { fakeDocument, fakeNode } from './fake-document.js';

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr']);

/** The Jam view's markup of page/index.html as fake nodes: tag, id, class and attributes, no text. */
function jamMarkup() {
  const html = readFileSync(fileURLToPath(new URL('../page/index.html', import.meta.url)), 'utf8');
  const document = fakeDocument();
  const start = html.indexOf('<div id="jam-view"');
  assert.notEqual(start, -1, 'page/index.html has no #jam-view');
  const stack = [];
  let root = null;
  for (const match of html.slice(start).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>/g)) {
    const [, closing, tag, attributeText] = match;
    if (closing === '/') {
      stack.pop();
      if (stack.length === 0) break;
      continue;
    }
    const node = fakeNode(tag, document);
    for (const attribute of attributeText.matchAll(/([a-zA-Z][\w-]*)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = attribute;
      if (name === 'id') node.id = value;
      else if (name === 'class') node.className = value;
      else node.attributes.set(name, value);
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      node.parentNode = parent;
      parent.children.push(node);
    } else {
      root = node;
    }
    if (!VOID_TAGS.has(tag.toLowerCase())) stack.push(node);
  }
  document.markup = [root];
  return document;
}

function setup() {
  const document = jamMarkup();
  const calls = { instrument: [], chordTones: [], choices: [] };
  const view = createJamView({
    document,
    onInstrumentChange: (name) => calls.instrument.push(name),
    onChordTonesChange: (checked) => calls.chordTones.push(checked),
    onScaleChoice: (choice) => {
      calls.choices.push(choice);
      if (calls.throwOnChoice) throw new Error('refused');
    },
  });
  view.setPreferences({ instrument: 'piano', chordTones: 'off' });
  const get = (id) => {
    const node = document.getElementById(id);
    assert.notEqual(node, null, `no #${id} in the markup`);
    return node;
  };
  return { document, view, calls, get };
}

const ev = (track, begin, end, note) => ({ begin, end, value: { note }, track });
const run = (track, begin, step, names) => names.map((name, i) => ev(track, begin + i * step, begin + (i + 1) * step, name));
const stack = (track, begin, end, names) => names.map((name) => ev(track, begin, end, name));
const loop = (cycles, fn) => Array.from({ length: cycles }, (_, cycle) => fn(cycle)).flat();

const PAD_CHORDS = [['a3', 'c4', 'e4'], ['f3', 'a3', 'c4'], ['c4', 'e4', 'g4'], ['g3', 'b3', 'd4']];
const FOUR_PADS = loop(8, (c) => stack(0, c, c + 1, PAD_CHORDS[c % 4]));
const DRONE_LINE = [...loop(8, (c) => ev(1, c, c + 1, 'a2')), ...loop(8, (c) => run(0, c, 1 / 6, ['a3', 'b3', 'c4', 'd4', 'e4', 'g4']))];
const DORIAN_LOOP = loop(8, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'])]);

/** The model of the Jam view for these events at one cycle, resolved the way the page resolves a reading. */
function modelOf(events, { declared = { state: 'none' }, section = null, cycle = 1, memory = createScaleMemory() } = {}) {
  const reading = buildReading({ events, windowStart: 0, windowLength: 64, declared });
  const position = readingAt(resolveReading(reading, { declared, memory }), { cycle, cps: 0.5, playing: true });
  return buildJamModel({ position, section });
}

const aMinorDeclared = { state: 'declared', kind: 'scale', text: 'A:minor', scale: { rootPc: 9, modeId: 'aeolian' } };
const roleOf = (get, note, index = 0) => [...get('jam-piano').children].filter((key) => key.dataset.note === note)[index].dataset.role;

test('a proposed scale shows its reason line with the lead and the rest', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  assert.equal(get('jam-reason').hidden, false);
  assert.equal(get('jam-reason-lead').textContent, 'Proposed:');
  assert.equal(get('jam-reason-rest').textContent, ' C major, C is the note heard most.');
  assert.equal(get('jam-scale-name').textContent, 'C major');
  assert.equal(get('jam-scale-name').dataset.kind, 'clear');
  assert.equal(get('jam-scale').dataset.source, 'proposed');
});

test('drawing the same proposed model twice writes the reason line once', () => {
  const { view, document, get } = setup();
  view.render(modelOf(FOUR_PADS));
  const lead = get('jam-reason-lead').writes;
  const rest = get('jam-reason-rest').writes;
  const line = get('jam-reason').writes;
  const scale = get('jam-scale').writes;
  const everyNode = (node) => [node, ...node.children.flatMap(everyNode)];
  const before = new Map(everyNode(document.markup[0]).map((node) => [node, node.writes]));
  view.render(modelOf(FOUR_PADS));
  assert.equal(get('jam-reason-lead').writes, lead);
  assert.equal(get('jam-reason-rest').writes, rest);
  assert.equal(get('jam-reason').writes, line);
  assert.equal(get('jam-scale').writes, scale);
  // Only the view's own state attribute is written every time; every other node keeps what it shows.
  const rewritten = [...before].filter(([node, count]) => node.writes !== count).map(([node]) => node.id);
  assert.deepEqual(rewritten, ['jam-view'], 'a second draw of the same model writes nothing but the view state');
});

test('a heard scale hides the reason line and says its source is heard', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  view.render(modelOf(DORIAN_LOOP));
  assert.equal(get('jam-reason').hidden, true);
  assert.equal(get('jam-reason-lead').textContent, '');
  assert.equal(get('jam-reason-rest').textContent, '');
  assert.equal(get('jam-scale').dataset.source, 'heard');
  assert.equal(get('jam-scale-name').textContent, 'D Dorian');
});

test('a proposal that comes back after a heard scale is written again, so the live region speaks it again', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  const written = get('jam-reason-lead').writes;
  view.render(modelOf(DORIAN_LOOP));
  view.render(modelOf(FOUR_PADS));
  assert.ok(get('jam-reason-lead').writes > written);
  assert.equal(get('jam-reason-lead').textContent, 'Proposed:');
});

test('a changed reason is written, the lead only when it changed', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  const lead = get('jam-reason-lead').writes;
  const rest = get('jam-reason-rest').writes;
  view.render(modelOf(FOUR_PADS, { declared: aMinorDeclared }));
  assert.equal(get('jam-reason-lead').writes, lead);
  assert.equal(get('jam-reason-rest').writes, rest + 1);
  assert.equal(get('jam-reason-rest').textContent, ' A minor, declared by the code.');
  view.render(modelOf(FOUR_PADS, { declared: aMinorDeclared, section: "'verse'" }));
  assert.equal(get('jam-reason-rest').textContent, ' A minor, declared by the section.');
});

test('the Heard label is hidden for a proposed scale even with a declaration, and shown for a heard one', () => {
  const { view, get } = setup();
  assert.equal(get('jam-scale-label').textContent, 'Heard:');
  view.render(modelOf(FOUR_PADS));
  assert.equal(get('jam-scale-label').hidden, true, 'no declaration: no label');
  view.render(modelOf(FOUR_PADS, { declared: aMinorDeclared }));
  assert.equal(get('jam-declared').hidden, false);
  assert.equal(get('jam-scale-label').hidden, true, 'a proposal is not what was heard');
  view.render(modelOf(DORIAN_LOOP, { declared: aMinorDeclared }));
  assert.equal(get('jam-scale-label').hidden, false);
  view.render(modelOf(DORIAN_LOOP));
  assert.equal(get('jam-scale-label').hidden, true);
});

test('a proposed scale colours the piano like a heard one, and a scale that cannot be chosen leaves every key off', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  assert.equal(roleOf(get, 'C', 0), 'root');
  assert.equal(roleOf(get, 'D', 0), 'scale');
  assert.equal(roleOf(get, 'C', 1), 'root');
  assert.match(get('jam-piano').getAttribute('aria-label'), /Scale notes: C, D, E, F, G, A, B\. Root C\./);
  view.render(modelOf(DRONE_LINE));
  const roles = [...get('jam-piano').children].map((key) => key.dataset.role);
  assert.equal(roles.length, 24);
  assert.ok(roles.every((role) => role === 'off'));
});

test('a scale that cannot be chosen says why, with no reason line, no degrees and no status box', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  view.render(modelOf(DRONE_LINE));
  assert.equal(get('jam-scale-name').dataset.kind, 'ambiguous');
  assert.equal(get('jam-scale-name').textContent, 'Several scales fit, with different notes, and nothing is declared.');
  assert.equal(get('jam-scale-sub').textContent, 'Warnings are off until a scale is declared or the notes settle on one.');
  assert.equal(get('jam-scale').dataset.source, 'heard');
  assert.equal(get('jam-reason').hidden, true);
  assert.equal(get('jam-degrees').hidden, true);
  assert.equal(get('jam-status').hidden, true);
  assert.equal(get('jam-rows').children.length, 1);
  assert.equal(get('jam-rows').children[0].textContent, '–Warnings are off until the scale is clear.');
});

test('a ready model without its reason or its scale source is refused', () => {
  const { view } = setup();
  const model = modelOf(FOUR_PADS);
  const { reason, ...withoutReason } = model;
  const { scaleSource, ...withoutSource } = model;
  assert.throws(() => view.render(withoutReason), /Moontide:/);
  assert.throws(() => view.render(withoutSource), /Moontide:/);
  assert.throws(() => view.render({ ...model, scaleSource: 'guessed' }), /Moontide:/);
});

test('a message hides the body and a later proposal shows again', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  view.showMessage('Nothing is playing yet.');
  assert.equal(get('jam-body').hidden, true);
  view.render(modelOf(FOUR_PADS));
  assert.equal(get('jam-body').hidden, false);
  assert.equal(get('jam-reason').hidden, false);
});

// --- the scales that fit ---

const candidateButtons = (get) => get('jam-candidate-list').children;
const everyNode = (node) => [node, ...node.children.flatMap(everyNode)];
const pressedOf = (get) => [...candidateButtons(get)].filter((el) => el.getAttribute('aria-pressed') === 'true').map((el) => el.textContent);

test('createJamView refuses to be built without onScaleChoice', () => {
  assert.throws(() => createJamView({ document: jamMarkup(), onInstrumentChange() {}, onChordTonesChange() {} }), /Moontide:.*onScaleChoice/);
});

test('a proposed scale draws one button per candidate, the scale in use pressed, under the caption', () => {
  const { view, get } = setup();
  const model = modelOf(FOUR_PADS);
  view.render(model);
  assert.equal(get('jam-candidates').hidden, false);
  assert.equal(get('jam-candidates').dataset.mode, 'pick');
  assert.equal(get('jam-candidates-label').textContent, 'Scales that fit, click to switch:');
  assert.equal(get('jam-candidates-more').hidden, true);
  const buttons = [...candidateButtons(get)];
  assert.deepEqual(buttons.map((el) => el.textContent), model.candidates.items.map((item) => item.name));
  assert.ok(buttons.every((el) => el.tagName === 'button' && el.className === 'jam-candidate' && el.type === 'button'));
  assert.deepEqual(pressedOf(get), ['C major']);
  assert.equal(get('jam-candidate-list').getAttribute('role'), null);
});

test('scales that cannot be chosen are drawn as plain items in a list, with no control', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  view.render(modelOf(DRONE_LINE));
  assert.equal(get('jam-candidates').hidden, false);
  assert.equal(get('jam-candidates').dataset.mode, 'list');
  assert.equal(get('jam-candidates-label').textContent, 'Scales that fit:');
  assert.equal(get('jam-candidate-list').getAttribute('role'), 'list');
  const items = [...candidateButtons(get)];
  assert.deepEqual(items.map((el) => el.textContent), ['A Dorian', 'A minor']);
  for (const el of items) {
    assert.equal(el.tagName, 'span');
    assert.equal(el.getAttribute('role'), 'listitem');
    assert.equal(el.getAttribute('tabindex'), null);
    assert.equal(el.getAttribute('aria-pressed'), null);
    assert.equal(el.listenersFor('click').length, 0);
  }
  assert.ok(everyNode(get('jam-candidates')).every((el) => el.tagName !== 'button' && el.getAttribute('tabindex') === null));
  // back to a scale that can be chosen: the role is gone and buttons return
  view.render(modelOf(FOUR_PADS));
  assert.equal(get('jam-candidate-list').getAttribute('role'), null);
  assert.equal(candidateButtons(get)[0].tagName, 'button');
});

test('a heard scale hides the candidates', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  view.render(modelOf(DORIAN_LOOP));
  assert.equal(get('jam-candidates').hidden, true);
});

test('past eight candidates the view shows "and n more" as plain text', () => {
  const { view, get } = setup();
  const model = modelOf(FOUR_PADS);
  const candidates = { ...model.candidates, items: Array.from({ length: 8 }, (_, i) => ({ key: `${i}:x`, name: `Scale ${i}`, pressed: i === 0 })), more: 'and 4 more' };
  view.render({ ...model, candidates });
  assert.equal(candidateButtons(get).length, 8);
  assert.equal(get('jam-candidates-more').hidden, false);
  assert.equal(get('jam-candidates-more').textContent, 'and 4 more');
  assert.equal(get('jam-candidates-more').tagName, 'span');
  view.render(model);
  assert.equal(get('jam-candidates-more').hidden, true);
  assert.equal(get('jam-candidates-more').textContent, '');
});

test('drawing a model with the same names and mode rebuilds nothing, and a new pressed scale rewrites aria-pressed only', () => {
  const { view, get } = setup();
  const memory = createScaleMemory();
  const first = modelOf(FOUR_PADS, { memory });
  view.render(first);
  const list = get('jam-candidate-list');
  const buttons = [...candidateButtons(get)];
  const replaced = list.replaced;
  const created = [...buttons].map((el) => el.writes);
  view.render(modelOf(FOUR_PADS, { memory }));
  assert.equal(list.replaced, replaced);
  assert.deepEqual([...candidateButtons(get)], buttons);
  // a pick presses another scale: the same button objects, only aria-pressed written
  memory.pick(first.candidates.setKey, '9:aeolian');
  buttons.find((el) => el.textContent === 'C major').focus();
  view.render(modelOf(FOUR_PADS, { memory }));
  assert.equal(list.replaced, replaced, 'a pick does not rebuild the buttons');
  assert.deepEqual([...candidateButtons(get)], buttons);
  assert.deepEqual(pressedOf(get), ['A minor']);
  assert.equal(buttons.find((el) => el.textContent === 'A minor').getAttribute('aria-pressed'), 'true');
  assert.equal(buttons.find((el) => el.textContent === 'C major').getAttribute('aria-pressed'), 'false');
  assert.equal(buttons.find((el) => el.textContent === 'C major').textContent, 'C major');
  assert.notDeepEqual(created, buttons.map((el) => el.writes));
  assert.equal(buttons.find((el) => el.textContent === 'D Dorian')?.writes ?? 0, created[buttons.findIndex((el) => el.textContent === 'D Dorian')] ?? 0);
});

test('the focused button keeps focus when the pressed scale changes', () => {
  const { view, document, get } = setup();
  const memory = createScaleMemory();
  const first = modelOf(FOUR_PADS, { memory });
  view.render(first);
  const button = [...candidateButtons(get)].find((el) => el.textContent === 'A minor');
  button.focus();
  memory.pick(first.candidates.setKey, '9:aeolian');
  view.render(modelOf(FOUR_PADS, { memory }));
  assert.equal(document.activeElement, button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('a rebuild caused by a pick keeps focus on the scale just activated when more than eight fit', () => {
  const { view, document, get } = setup();
  const model = modelOf(FOUR_PADS);
  const items = (inUse, lastKey) => Array.from({ length: 8 }, (_, i) => {
    const key = i === 7 ? lastKey : `${i}:x`;
    return { key, name: `Scale ${key}`, pressed: key === inUse };
  });
  // the scale in use sits past the eighth, so it takes the last place drawn
  view.render({ ...model, candidates: { ...model.candidates, items: items('11:x', '11:x'), more: 'and 4 more' } });
  const before = [...candidateButtons(get)];
  assert.equal(before.length, 8);
  before[2].focus();
  // the pick moves the scale in use to an earlier place, so the last place goes back to the eighth candidate
  view.render({ ...model, candidates: { ...model.candidates, items: items('2:x', '7:x'), more: 'and 4 more' } });
  const after = [...candidateButtons(get)];
  assert.ok(after[7] !== before[7], 'the list was rebuilt');
  assert.equal(document.activeElement, after[2], 'focus is on the button of the scale just activated');
  assert.equal(after[2].getAttribute('aria-pressed'), 'true');
  // a rebuild with focus elsewhere does not take focus
  document.activeElement = null;
  view.render({ ...model, candidates: { ...model.candidates, items: items('2:x', '11:x'), more: 'and 4 more' } });
  assert.equal(document.activeElement, null);
});

test('the buttons are rebuilt when the set of candidates changes', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  const before = [...candidateButtons(get)];
  view.render(modelOf(DRONE_LINE, { declared: aMinorDeclared }));
  const after = [...candidateButtons(get)];
  assert.deepEqual(after.map((el) => el.textContent), ['A Dorian', 'A minor']);
  assert.ok(after.every((el) => !before.includes(el)));
  assert.deepEqual(pressedOf(get), ['A minor']);
});

test('a click on an unpressed button calls onScaleChoice with its set and its key, a click on the pressed one does nothing', () => {
  const { view, calls, get } = setup();
  const model = modelOf(FOUR_PADS);
  view.render(model);
  const buttons = [...candidateButtons(get)];
  buttons.find((el) => el.textContent === 'C major').dispatch('click');
  assert.deepEqual(calls.choices, []);
  buttons.find((el) => el.textContent === 'A minor').dispatch('click');
  assert.deepEqual(calls.choices, [{ setKey: model.candidates.setKey, key: '9:aeolian' }]);
});

test('a throwing onScaleChoice is said once per set of candidates, however many clicks follow', () => {
  const { view, calls, get } = setup();
  calls.throwOnChoice = true;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    view.render(modelOf(FOUR_PADS));
    const button = [...candidateButtons(get)].find((el) => el.textContent === 'A minor');
    button.dispatch('click');
    button.dispatch('click');
    button.dispatch('click');
    assert.equal(calls.choices.length, 3);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /Moontide:/);
    // another set of candidates is said again
    view.render(modelOf(DRONE_LINE, { declared: aMinorDeclared }));
    [...candidateButtons(get)].find((el) => el.textContent === 'A Dorian').dispatch('click');
    assert.equal(logged.length, 2);
  } finally {
    console.error = original;
  }
});

test('a right-click on a candidate button, the candidates block or the reason line asks about the whole session', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  assert.equal(view.askTarget(candidateButtons(get)[0]), null);
  assert.equal(view.askTarget(get('jam-candidates')), null);
  assert.equal(view.askTarget(get('jam-reason-rest')), null);
});

test('a ready model without its candidates field is refused', () => {
  const { view } = setup();
  const { candidates, ...without } = modelOf(FOUR_PADS);
  assert.throws(() => view.render(without), /Moontide:.*candidates/);
  assert.throws(() => view.render({ ...modelOf(FOUR_PADS), candidates: { mode: 'drag', caption: 'x', setKey: 's', items: [], more: null } }), /Moontide:/);
});

// --- the hover title of each piano key ---

const WARNING_LOOP = loop(16, (c) => [
  ev(1, c, c + 1, 'd2'),
  ...stack(2, c, c + 1, [2, 3].includes(c % 8) ? ['a2', 'c#3', 'e3', 'g3'] : ['d3', 'f3', 'a3', 'c4']),
  ...run(0, c, 0.125, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4']),
]);
const pianoKey = (get, note, index = 0) => [...get('jam-piano').children].filter((key) => key.dataset.note === note)[index];

/** The model of the warning loop at one cycle, with the Chord tones overlay on or off. */
function warningModel(cycle, chordTones) {
  const reading = buildReading({ events: WARNING_LOOP, windowStart: 0, windowLength: 64 });
  const position = readingAt(resolveReading(reading, { declared: { state: 'none' }, memory: createScaleMemory() }), { cycle, cps: 0.5, playing: true });
  return buildJamModel({ position, chordTones });
}

test('each piano key carries a hover title of its note and role, and an off key that is no chord tone has none', () => {
  const { view, get } = setup();
  view.render(modelOf(DORIAN_LOOP));
  assert.equal(pianoKey(get, 'D').getAttribute('title'), 'D, root');
  assert.equal(pianoKey(get, 'E').getAttribute('title'), 'E, scale');
  assert.equal(pianoKey(get, 'D', 1).getAttribute('title'), 'D, root');
  assert.equal(pianoKey(get, 'C#').getAttribute('title'), null);
  assert.equal(pianoKey(get, 'F#').hasAttribute('title'), false);
});

test('the key titles follow the warning and the chord tones, and are removed when a key goes off', () => {
  const { view, get } = setup();
  view.render(warningModel(2.5, true));
  assert.equal(pianoKey(get, 'C').getAttribute('title'), 'C, avoid');
  assert.equal(pianoKey(get, 'C#').getAttribute('title'), 'C#, outside, chord tone');
  assert.equal(pianoKey(get, 'A').getAttribute('title'), 'A, scale, chord tone');
  view.render(warningModel(0.5, false));
  assert.equal(pianoKey(get, 'C').getAttribute('title'), 'C, scale');
  assert.equal(pianoKey(get, 'C#').hasAttribute('title'), false);
});

test('a cannot-choose piano has no key titles, and drawing the same model twice writes no title again', () => {
  const { view, get } = setup();
  view.render(modelOf(DRONE_LINE));
  assert.ok([...get('jam-piano').children].every((key) => !key.hasAttribute('title')));
  view.render(warningModel(2.5, true));
  const keys = [...get('jam-piano').children];
  const before = keys.map((key) => key.writes);
  view.render(warningModel(2.5, true));
  assert.deepEqual(keys.map((key) => key.writes), before);
});

test('the piano and guitar names follow the model: the source, the outside notes and the chord tones', () => {
  const { view, get } = setup();
  view.render(modelOf(FOUR_PADS));
  assert.equal(get('jam-piano').getAttribute('aria-label'), 'Piano, two octaves from C3. Proposed scale: C major. Scale notes: C, D, E, F, G, A, B. Root C. Avoid: none.');
  view.render(warningModel(2.5, true));
  assert.match(get('jam-piano').getAttribute('aria-label'), /Avoid: C\. Outside: C#\. Chord tones: .*\.$/);
  assert.match(get('jam-guitar').getAttribute('aria-label'), /Avoid: C\. Outside: C#\. Chord tones: .*\.$/);
});
