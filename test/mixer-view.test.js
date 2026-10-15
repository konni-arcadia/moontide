// The Mixer view's DOM code, tested without a browser against the fake document the Song grid tests share. The live Mixer
// in real Chrome is proved by `npm run probe:page`; these tests pin the group frames (structure, ARIA, fold buttons), that
// names from the code stay text, that drawing the same model again writes nothing into a frame, and that a strip moved
// between frames keeps its element and a held strip is not moved until it is let go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { HELPER_TEXT, readStructure } from '../page/structure.js';
import { buildMixerModel } from '../page/mixer-model.js';
import { createMixerView } from '../page/mixer-view.js';
import { all, fakeDocument, fakeNode } from './fake-document.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../page/mixer-view.js', import.meta.url)), 'utf8');
const IDS = ['mixer-view', 'mixer-notice', 'mixer-message', 'mixer-body', 'mixer-strips', 'mixer-inspector', 'mixer-nonotes'];

/** A silent structured piece: tracks t1 to t3 in the song (in `groups`), t4 outside every group with a send to the reverb bus. */
function piece({ groups = "{ g1: ['t1', 't2'], g2: { g3: ['t3'] } }", names = ['t1', 't2', 't3'], extra = ["t4: note('c3').room(0.2).gain(0)"] } = {}) {
  const plan = `{ x: { ${names.map((name) => `${name}: 'va'`).join(', ')} } }`;
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: 0, sections: [['x', 4]], ${groups === null ? '' : `groups: ${groups}, `}plan: ${plan} };`,
    HELPER_TEXT,
    ...names.map((name) => `const ${name} = { va: note('c3') };`),
    ...names.map((name) => `${name}: play('${name}', ${name}).gain(0)`),
    ...extra,
  ].join('\n');
}

const colorOf = () => 1;
const songOf = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });
const modelOf = (code, folds = []) => buildMixerModel({ code, parse, colorOf, song: songOf(code), folds: new Set(folds) });

function setup({ pending = false } = {}) {
  const document = fakeDocument();
  const elements = {};
  for (const id of IDS) {
    elements[id] = fakeNode('div', document);
    elements[id].id = id;
    document.markup.push(elements[id]);
  }
  const folded = [];
  const presses = [];
  const state = { pending };
  const gesture = { hasPending: () => state.pending, discrete: (change, label) => presses.push({ change, label }), move() {}, release() {}, preview() {} };
  const midiPreview = { move() {}, flush() {} };
  const view = createMixerView({ document, gesture, midiPreview, onGroupFold: (key) => folded.push(key) });
  return { document, elements, strips: elements['mixer-strips'], view, folded, state, presses };
}

/** What a container holds, as plain data: a frame is { group, items }, a strip its track, a bus strip 'bus'. */
function shape(container) {
  return container.children.map((child) => {
    if (child.className === 'mx-group') return { group: all(child, 'mx-fold-name')[0].textContent, items: shape(all(child, 'mx-group-body')[0]) };
    if (child.className.includes('mx-bus')) return 'bus';
    return child.getAttribute('data-track');
  });
}

// Nodes point at their parents, so a failed assert.equal on two nodes would print a tree that never ends: compare by identity.
const same = (a, b, message) => assert.ok(a === b, message);
const sameList = (a, b, message) => assert.ok(a.length === b.length && a.every((node, i) => node === b[i]), message);

const frameOf = (strips, name) => all(strips, 'mx-group').find((frame) => all(frame, 'mx-fold-name')[0].textContent === name);
const bodyOf = (frame) => frame.children.find((child) => child.className === 'mx-group-body');

test('a structured piece draws a frame per group with its strips, then the strips no group names, then the buses', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  assert.deepEqual(shape(strips), [{ group: 'g1', items: ['label:t1', 'label:t2'] }, { group: 'g2', items: [{ group: 'g3', items: ['label:t3'] }] }, 'label:t4', 'bus']);
});

test('a piece without groups draws its strips in code order, then the buses, and no frame', () => {
  const { view, strips } = setup();
  view.render(buildMixerModel({ code: piece({ groups: null }), parse, colorOf, song: songOf(piece({ groups: null })), folds: new Set() }));
  assert.deepEqual(shape(strips), ['label:t1', 'label:t2', 'label:t3', 'label:t4', 'bus']);
  assert.equal(all(strips, 'mx-group').length, 0);
  // A model built without a song at all is the same flat Mixer.
  const flat = setup();
  flat.view.render(buildMixerModel({ code: piece(), parse, colorOf }));
  assert.deepEqual(shape(flat.strips), ['label:t1', 'label:t2', 'label:t3', 'label:t4', 'bus']);
});

test('a frame is a group with a name, a fold button that says whether it is open, and a body it controls', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const frame = frameOf(strips, 'g1');
  assert.equal(frame.getAttribute('role'), 'group');
  assert.equal(frame.getAttribute('aria-label'), 'Group g1');
  assert.equal(frame.getAttribute('data-group'), '["g1"]');
  assert.equal(frame.getAttribute('data-folded'), 'false');
  assert.equal(frame.getAttribute('data-deep'), null);
  const [fold] = all(frame, 'mx-fold');
  assert.equal(fold.tagName, 'button');
  assert.equal(fold.getAttribute('type') ?? fold.type, 'button');
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  assert.equal(fold.getAttribute('title'), "Fold 'g1'");
  const body = bodyOf(frame);
  assert.ok(body.id.startsWith('mx-group-body-'));
  assert.equal(fold.getAttribute('aria-controls'), body.id);
  assert.equal(all(frame, 'mx-fold-chevron')[0].textContent, '▾');
  assert.equal(all(frame, 'mx-fold-chevron')[0].getAttribute('aria-hidden'), 'true');
  assert.equal(all(frame, 'mx-group-count')[0].textContent, '2 tracks');
  assert.equal(body.hasAttribute('hidden'), false);
  // Every body has an id of its own.
  const ids = all(strips, 'mx-group-body').map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a folded group shows a closed chevron, the open title, a hidden body and data-folded true', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece(), ['["g1"]']));
  const frame = frameOf(strips, 'g1');
  const [fold] = all(frame, 'mx-fold');
  assert.equal(frame.getAttribute('data-folded'), 'true');
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(fold.getAttribute('title'), "Open 'g1'");
  assert.equal(all(frame, 'mx-fold-chevron')[0].textContent, '▸');
  assert.equal(bodyOf(frame).hasAttribute('hidden'), true);
  // The strips stay in the body, hidden with it: nothing is rebuilt by a fold.
  assert.deepEqual(shape(bodyOf(frame)), ['label:t1', 'label:t2']);
  // Another group keeps its own state.
  assert.equal(frameOf(strips, 'g2').getAttribute('data-folded'), 'false');
});

test('a click on the fold button asks the caller to fold that group and changes nothing itself', () => {
  const { view, strips, folded } = setup();
  view.render(modelOf(piece()));
  const [fold] = all(frameOf(strips, 'g2'), 'mx-fold');
  fold.dispatch('click');
  assert.deepEqual(folded, ['["g2"]']);
  assert.equal(frameOf(strips, 'g2').getAttribute('data-folded'), 'false', 'the model decides, not the click');
  // After a redraw with the group folded, the next click names the same key.
  view.render(modelOf(piece(), ['["g2"]']));
  all(frameOf(strips, 'g2'), 'mx-fold')[0].dispatch('click');
  assert.deepEqual(folded, ['["g2"]', '["g2"]']);
});

test('the view refuses to be built without a fold callback', () => {
  const document = fakeDocument();
  for (const id of IDS) {
    const node = fakeNode('div', document);
    node.id = id;
    document.markup.push(node);
  }
  const gesture = { hasPending: () => false };
  const midiPreview = { move() {}, flush() {} };
  assert.throws(() => createMixerView({ document, gesture, midiPreview }), /onGroupFold/);
  assert.throws(() => createMixerView({ document, gesture, midiPreview, onGroupFold: 'yes' }), /onGroupFold/);
});

test('a frame is marked deep from level five on, not before, and a ten-level structure draws', () => {
  const names = ['t1'];
  let groups = "['t1']";
  for (let level = 10; level >= 1; level--) groups = `{ n${level}: ${groups} }`;
  const code = piece({ groups, names, extra: [] });
  const { view, strips } = setup();
  view.render(modelOf(code));
  const frames = all(strips, 'mx-group');
  assert.equal(frames.length, 10);
  assert.deepEqual(frames.map((frame) => frame.getAttribute('data-deep')), [null, null, null, null, 'true', 'true', 'true', 'true', 'true', 'true']);
  assert.deepEqual(frames.map((frame) => frame.getAttribute('aria-label')), Array.from({ length: 10 }, (_, i) => `Group n${i + 1}`));
  // The one strip sits in the innermost body.
  assert.equal(bodyOf(frames[9]).children[0].getAttribute('data-track'), 'label:t1');
});

test('a group name holding markup stays text, a long one is cut in sentences and kept whole in its title', () => {
  const hostile = '<img src=x onerror=boom>';
  const code = piece({ groups: `{ '${hostile}': ['t1', 't2', 't3'] }`, extra: [] });
  const { view, strips } = setup();
  view.render(modelOf(code));
  const frame = all(strips, 'mx-group')[0];
  assert.equal(all(frame, 'mx-fold-name')[0].textContent, hostile);
  assert.equal(frame.getAttribute('aria-label'), `Group ${hostile}`);
  assert.equal(frame.children.length, 2, 'the name made no element');
  const long = 'L'.repeat(200);
  const longCode = piece({ groups: `{ ${long}: ['t1', 't2', 't3'] }`, extra: [] });
  const second = setup();
  second.view.render(modelOf(longCode));
  const longFrame = all(second.strips, 'mx-group')[0];
  assert.equal(longFrame.getAttribute('aria-label'), `Group ${'L'.repeat(39)}…`);
  assert.equal(all(longFrame, 'mx-fold')[0].getAttribute('title'), `Fold '${'L'.repeat(39)}…'`);
  assert.equal(all(longFrame, 'mx-fold-name')[0].getAttribute('title'), long);
});

test('the view source builds text only: no HTML string parsing, no document.write', () => {
  const code = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
});

/** The writes a frame took, counted on its own node, its head and its body node (not on the strips inside the body). */
function frameWrites(frame) {
  let total = frame.writes + bodyOf(frame).writes;
  const work = [frame.children.find((child) => child.className === 'mx-group-head')];
  while (work.length > 0) {
    const node = work.pop();
    total += node.writes;
    work.push(...node.children);
  }
  return total;
}

test('drawing the same model again writes nothing into a frame and creates no element for it', () => {
  const { view, strips } = setup();
  const model = modelOf(piece());
  view.render(model);
  const frames = all(strips, 'mx-group');
  const before = frames.map(frameWrites);
  const bodyChildren = frames.map((frame) => [...bodyOf(frame).children]);
  const stripEls = all(strips, 'mx-strip');
  view.render(modelOf(piece()));
  sameList(all(strips, 'mx-group'), frames, 'the same frame elements');
  assert.deepEqual(frames.map(frameWrites), before, 'no attribute and no text written');
  frames.forEach((frame, i) => sameList([...bodyOf(frame).children], bodyChildren[i], 'no child moved'));
  sameList(all(strips, 'mx-strip'), stripEls, 'the same strip elements');
});

test('a strip that moves between frames keeps its element, and a frame whose group left the code goes', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const elements = new Map(all(strips, 'mx-strip').filter((el) => el.getAttribute('data-track')).map((el) => [el.getAttribute('data-track'), el]));
  const g1Frame = frameOf(strips, 'g1');
  const moved = modelOf(piece({ groups: "{ g1: ['t1'], g2: { g3: ['t3', 't2'] } }" }));
  view.render(moved);
  assert.deepEqual(shape(strips), [{ group: 'g1', items: ['label:t1'] }, { group: 'g2', items: [{ group: 'g3', items: ['label:t3', 'label:t2'] }] }, 'label:t4', 'bus']);
  for (const [track, el] of elements) same(all(strips, 'mx-strip').find((candidate) => candidate.getAttribute('data-track') === track), el, `${track} keeps its element`);
  same(frameOf(strips, 'g1'), g1Frame, 'the frame of a group that stays is the same element');
  // The groups go: the strips come out of the frames, in code order, with the frames removed.
  view.render(buildMixerModel({ code: piece({ groups: null }), parse, colorOf, song: songOf(piece({ groups: null })), folds: new Set() }));
  assert.deepEqual(shape(strips), ['label:t1', 'label:t2', 'label:t3', 'label:t4', 'bus']);
  for (const [track, el] of elements) same(strips.children.find((candidate) => candidate.getAttribute('data-track') === track), el, `${track} keeps its element`);
});

test('a model that holds one group key twice stops the draw loudly instead of hiding a strip', () => {
  const { view, strips } = setup();
  const model = modelOf(piece());
  const first = model.layout.items.find((item) => item.kind === 'group');
  const twice = { ...model, layout: { ...model.layout, items: [first, first] } };
  assert.throws(() => view.render(twice), /the Mixer got the group .* twice/);
  // The same piece with its two frames under different names draws both.
  view.render(modelOf(piece()));
  assert.equal(all(strips, 'mx-group').length, 3);
});

test('a held strip is not moved until it is let go, and the next draw after the release moves it', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const t1 = all(strips, 'mx-strip').find((el) => el.getAttribute('data-track') === 'label:t1');
  const [fader] = all(t1, 'mx-fader');
  fader.dispatch('pointerdown');
  const moved = modelOf(piece({ groups: "{ g1: ['t2'], g2: { g3: ['t3', 't1'] } }" }));
  view.render(moved);
  same(t1.parentNode, bodyOf(frameOf(strips, 'g1')), 'the held strip stays in its frame');
  assert.deepEqual(shape(bodyOf(frameOf(strips, 'g1'))), ['label:t1', 'label:t2']);
  assert.equal(view.hasStale(), false, 'nothing draws again while the hand holds it');
  fader.dispatch('pointerup');
  assert.equal(view.hasStale(), true, 'the next poll moves it');
  view.render(moved);
  same(t1.parentNode, all(frameOf(strips, 'g3'), 'mx-group-body')[0], 'moved after the release');
  assert.deepEqual(shape(strips), [{ group: 'g1', items: ['label:t2'] }, { group: 'g2', items: [{ group: 'g3', items: ['label:t3', 'label:t1'] }] }, 'label:t4', 'bus']);
  assert.equal(view.hasStale(), false);
});

test('a frame that still holds a held strip stays until the strip is let go', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const t1 = all(strips, 'mx-strip').find((el) => el.getAttribute('data-track') === 'label:t1');
  const flat = buildMixerModel({ code: piece({ groups: null }), parse, colorOf, song: songOf(piece({ groups: null })), folds: new Set() });
  all(t1, 'mx-fader')[0].dispatch('pointerdown');
  view.render(flat);
  const frame = frameOf(strips, 'g1');
  assert.ok(frame !== undefined, 'the frame stays while its strip is held');
  assert.deepEqual(shape(bodyOf(frame)), ['label:t1']);
  assert.ok(frameOf(strips, 'g2') === undefined, 'a frame with nothing held goes');
  assert.deepEqual(shape(strips).filter((item) => typeof item === 'string'), ['label:t2', 'label:t3', 'label:t4', 'bus']);
  all(t1, 'mx-fader')[0].dispatch('pointerup');
  assert.equal(view.hasStale(), true);
  view.render(flat);
  assert.deepEqual(shape(strips), ['label:t1', 'label:t2', 'label:t3', 'label:t4', 'bus']);
  assert.equal(all(strips, 'mx-group').length, 0);
});

test('the frames nested in a group that left the code are forgotten with it, and a group that comes back gets a new frame', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const g2Frame = frameOf(strips, 'g2');
  const g3Frame = frameOf(strips, 'g3');
  const flat = buildMixerModel({ code: piece({ groups: null }), parse, colorOf, song: songOf(piece({ groups: null })), folds: new Set() });
  view.render(flat);
  assert.equal(all(strips, 'mx-group').length, 0);
  // A light for a group the view no longer holds is skipped, so the old nested frame is not written to.
  view.setLights([{ kind: 'group', id: '["g2","g3"]', value: 1 }, { kind: 'group', id: '["g2"]', value: 1 }], 'on');
  assert.equal(all(g3Frame, 'mx-light-fill')[0].style.opacity, '', 'the nested frame has no ref left');
  assert.equal(all(g2Frame, 'mx-light-fill')[0].style.opacity, '');
  view.render(modelOf(piece()));
  assert.ok(frameOf(strips, 'g3') !== g3Frame && frameOf(strips, 'g2') !== g2Frame, 'a group that returns gets a new frame');
  assert.deepEqual(shape(strips), [{ group: 'g1', items: ['label:t1', 'label:t2'] }, { group: 'g2', items: [{ group: 'g3', items: ['label:t3'] }] }, 'label:t4', 'bus']);
});

test('a frame kept alive only by a held strip is stale: its buttons and fold do nothing, and the next draw after the release removes it', () => {
  const { view, strips, folded, presses } = setup();
  view.setConnected('connected');
  view.render(modelOf(piece()));
  const t1 = all(strips, 'mx-strip').find((el) => el.getAttribute('data-track') === 'label:t1');
  all(t1, 'mx-fader')[0].dispatch('pointerdown');
  // t1 is gone from the code and so is the group g1 that held it; the hand still holds the fader.
  const names = ['t2', 't3'];
  const without = modelOf(piece({ names, groups: "{ h: ['t2'], g2: { g3: ['t3'] } }" }));
  view.render(without);
  const frame = frameOf(strips, 'g1');
  assert.ok(frame !== undefined, 'the frame stays while its strip is held');
  const head = headOf(strips, 'g1');
  const { mute, solo } = buttonsOf(head);
  assert.deepEqual([mute.disabled, solo.disabled], [true, true], 'its buttons are off');
  mute.dispatch('click');
  solo.dispatch('click');
  all(head, 'mx-fold')[0].dispatch('click');
  assert.deepEqual(presses, [], 'a button of a stale frame writes nothing');
  assert.deepEqual(folded, [], 'and its fold asks for nothing');
  assert.equal(view.hasStale(), false, 'nothing draws again while the hand holds it');
  all(t1, 'mx-fader')[0].dispatch('pointerup');
  assert.equal(view.hasStale(), true, 'after the release the next poll draws again');
  view.render(without);
  assert.ok(frameOf(strips, 'g1') === undefined, 'the stale frame is gone');
  assert.equal(view.hasStale(), false);
  assert.deepEqual(shape(strips).filter((item) => typeof item !== 'string' || item !== 'bus').map((item) => (typeof item === 'string' ? item : item.group)), ['h', 'g2', 'label:t4']);
  // A group that comes back under the same name is a live frame again.
  view.render(modelOf(piece()));
  const back = buttonsOf(headOf(strips, 'g1'));
  assert.deepEqual([back.mute.disabled, back.solo.disabled], [false, false]);
});

test('a pending gesture holds every strip that is on the page where it is until the gesture ends', () => {
  const { view, strips, state } = setup();
  view.render(modelOf(piece()));
  state.pending = true;
  view.render(modelOf(piece({ groups: "{ g1: ['t2', 't1'], g2: { g3: ['t3'] } }" })));
  assert.deepEqual(shape(frameOf(strips, 'g1') && bodyOf(frameOf(strips, 'g1'))), ['label:t1', 'label:t2']);
  state.pending = false;
  assert.equal(view.hasStale(), true);
  view.render(modelOf(piece({ groups: "{ g1: ['t2', 't1'], g2: { g3: ['t3'] } }" })));
  assert.deepEqual(shape(bodyOf(frameOf(strips, 'g1'))), ['label:t2', 'label:t1']);
});

// --- Mute and solo on a group ---

const headOf = (strips, name) => frameOf(strips, name).children.find((child) => child.className === 'mx-group-head');
const buttonsOf = (head) => ({ mute: all(head, 'mx-mute')[0], solo: all(head, 'mx-solo')[0], count: all(head, 'mx-group-count')[0], note: all(head, 'mx-group-note')[0] });
const PLAIN = "t1: play('t1', t1).gain(0)\nt2: play('t2', t2).gain(0)\nt3: play('t3', t3).gain(0)";

/** The piece with its three track statements replaced by `lines` (the labels decide what is muted or soloed). */
function withLines(lines) {
  return piece().replace(PLAIN, lines);
}

test('a group head has a count line, an M and an S that write, then a note that is hidden when there is nothing to say', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const head = headOf(strips, 'g1');
  assert.deepEqual(head.children.map((child) => child.className), ['mx-group-title', 'mx-group-line', 'mx-group-note']);
  const line = head.children[1];
  assert.deepEqual(line.children.map((child) => child.className), ['mx-group-count', 'mx-mute', 'mx-solo']);
  const { mute, solo, note } = buttonsOf(head);
  assert.deepEqual([mute.tagName, mute.textContent, solo.textContent], ['button', 'M', 'S']);
  assert.deepEqual([mute.getAttribute('data-writes'), solo.getAttribute('data-writes')], ['true', 'true']);
  assert.deepEqual([mute.getAttribute('aria-pressed'), solo.getAttribute('aria-pressed')], ['false', 'false']);
  assert.deepEqual([mute.getAttribute('aria-label'), solo.getAttribute('aria-label')], ['Mute g1', 'Solo g1']);
  assert.deepEqual([mute.getAttribute('title'), solo.getAttribute('title')], ['Mute 2 tracks', 'Solo 2 tracks']);
  assert.equal(note.tagName, 'p');
  assert.equal(note.hasAttribute('hidden'), true);
  assert.equal(note.textContent, '');
});

test('a partly muted group is pressed mixed, with its count line, title and accessible name', () => {
  const { view, strips } = setup();
  view.render(modelOf(withLines(PLAIN.replace('t1:', '_t1:'))));
  const { mute, solo, count } = buttonsOf(headOf(strips, 'g1'));
  assert.equal(mute.getAttribute('aria-pressed'), 'mixed');
  assert.equal(mute.getAttribute('aria-label'), 'Mute g1, 1 of 2 tracks muted');
  assert.equal(mute.getAttribute('title'), '1 of 2 tracks muted. A click mutes all 2.');
  assert.equal(count.textContent, '1 of 2 muted');
  assert.equal(count.getAttribute('title'), '1 of 2 muted');
  assert.equal(solo.getAttribute('aria-pressed'), 'false');
});

test('a partly soloed group is mixed, and one partly muted and partly soloed reads both in its count line', () => {
  const soloed = setup();
  soloed.view.render(modelOf(withLines(PLAIN.replace('t1:', 'S_t1:'))));
  const head = buttonsOf(headOf(soloed.strips, 'g1'));
  assert.equal(head.solo.getAttribute('aria-pressed'), 'mixed');
  assert.equal(head.solo.getAttribute('aria-label'), 'Solo g1, 1 of 2 tracks soloed');
  assert.equal(head.count.textContent, '1 of 2 solo');
  const both = setup();
  both.view.render(modelOf(withLines(PLAIN.replace('t1:', '_t1:').replace('t2:', 'S_t2:'))));
  assert.equal(buttonsOf(headOf(both.strips, 'g1')).count.textContent, '1 of 2 muted, 1 of 2 solo');
});

test('a group with every track muted is pressed true', () => {
  const { view, strips } = setup();
  view.render(modelOf(withLines(PLAIN.replace('t1:', '_t1:').replace('t2:', '_t2:'))));
  const { mute, count } = buttonsOf(headOf(strips, 'g1'));
  assert.equal(mute.getAttribute('aria-pressed'), 'true');
  assert.equal(mute.getAttribute('title'), 'Unmute 2 tracks');
  assert.equal(count.textContent, '2 tracks');
});

test('a track the mixer cannot solo shows the skip note, and an empty group shows its own note with both buttons off', () => {
  const skip = setup();
  const code = piece({ groups: "{ g1: ['t1', 'Snare'] }", names: ['t1', 'Snare'], extra: [] });
  skip.view.setConnected('connected');
  skip.view.render(modelOf(code));
  const head = buttonsOf(headOf(skip.strips, 'g1'));
  assert.equal(head.note.hasAttribute('hidden'), false);
  assert.equal(head.note.textContent, "Skips 1 track the mixer can't change.");
  assert.equal(head.note.getAttribute('title'), "Skips 1 track the mixer can't change.");
  assert.deepEqual([head.mute.disabled, head.solo.disabled], [false, false]);
  const empty = setup();
  empty.view.setConnected('connected');
  empty.view.render(modelOf(piece({ groups: "{ g1: ['t1'], g0: [] }", names: ['t1'], extra: [] })));
  const none = buttonsOf(headOf(empty.strips, 'g0'));
  assert.equal(none.note.textContent, 'No track of this group is in the code.');
  assert.deepEqual([none.mute.disabled, none.solo.disabled], [true, true]);
  assert.equal(none.count.textContent, '0 tracks');
});

test('the note appears and goes again as the code changes, and drawing the same model again writes nothing', () => {
  const { view, strips } = setup();
  view.setConnected('connected');
  view.render(modelOf(piece({ groups: "{ g1: ['t1', 'Snare'] }", names: ['t1', 'Snare'], extra: [] })));
  const head = buttonsOf(headOf(strips, 'g1'));
  assert.equal(head.note.hasAttribute('hidden'), false);
  const frame = frameOf(strips, 'g1');
  const before = frameWrites(frame);
  view.render(modelOf(piece({ groups: "{ g1: ['t1', 'Snare'] }", names: ['t1', 'Snare'], extra: [] })));
  assert.equal(frameWrites(frame), before);
  view.render(modelOf(piece({ groups: "{ g1: ['t1'] }", names: ['t1'], extra: [] })));
  assert.equal(head.note.hasAttribute('hidden'), true);
  assert.equal(head.note.textContent, '');
  assert.equal(head.note.getAttribute('title'), null);
});

test('the group buttons are off while a notice is up and when no track can be reached, and the fold button is never off', () => {
  const { view, strips } = setup();
  const code = piece();
  view.render(modelOf(code));
  const head = headOf(strips, 'g1');
  const { mute, solo } = buttonsOf(head);
  const [fold] = all(head, 'mx-fold');
  // Disconnected until told otherwise.
  assert.deepEqual([mute.disabled, solo.disabled, fold.disabled === true], [true, true, false]);
  view.setConnected('connected');
  assert.deepEqual([mute.disabled, solo.disabled], [false, false]);
  view.setDirty(true);
  assert.deepEqual([mute.disabled, solo.disabled, fold.disabled === true], [true, true, false]);
  view.setDirty(false);
  view.setWaiting(true);
  assert.deepEqual([mute.disabled, solo.disabled, fold.disabled === true], [true, true, false]);
  view.setWaiting(false);
  assert.deepEqual([mute.disabled, solo.disabled], [false, false]);
  // A group whose only track cannot be soloed keeps M and turns S off.
  const lone = setup();
  lone.view.setConnected('connected');
  lone.view.render(modelOf(piece({ groups: "{ g1: ['Snare'] }", names: ['Snare'], extra: [] })));
  const loneHead = buttonsOf(headOf(lone.strips, 'g1'));
  assert.deepEqual([loneHead.mute.disabled, loneHead.solo.disabled], [false, true]);
});

test('the group buttons never go through a query of the whole frame', () => {
  assert.doesNotMatch(SOURCE, /groupRef[s]?\.[a-z]+\.querySelectorAll|frame\.querySelectorAll/);
  const { view, strips } = setup();
  view.setConnected('connected');
  view.render(modelOf(piece()));
  const frame = frameOf(strips, 'g1');
  let queries = 0;
  const original = frame.querySelectorAll;
  frame.querySelectorAll = (...args) => {
    queries += 1;
    return original(...args);
  };
  view.setDirty(true);
  view.setDirty(false);
  assert.equal(queries, 0);
});

test('a press of M or S is one discrete change with the identities, the direction and the history label', () => {
  const { view, strips, presses } = setup();
  view.setConnected('connected');
  view.render(modelOf(piece()));
  const { mute, solo } = buttonsOf(headOf(strips, 'g1'));
  mute.dispatch('click');
  solo.dispatch('click');
  assert.deepEqual(presses, [
    { change: { type: 'group', kind: 'mute', on: true, identities: ['label:t1', 'label:t2'], group: 'g1' }, label: 'mixer: group g1 muted' },
    { change: { type: 'group', kind: 'solo', on: true, identities: ['label:t1', 'label:t2'], group: 'g1' }, label: 'mixer: group g1 solo on' },
  ]);
});

test('a press on a fully muted group unmutes, a press on a partly muted one mutes all, and a soloed group ends its solo', () => {
  const muted = setup();
  muted.view.setConnected('connected');
  muted.view.render(modelOf(withLines(PLAIN.replace('t1:', '_t1:').replace('t2:', '_t2:'))));
  buttonsOf(headOf(muted.strips, 'g1')).mute.dispatch('click');
  assert.deepEqual([muted.presses[0].change.on, muted.presses[0].label], [false, 'mixer: group g1 unmuted']);
  const partly = setup();
  partly.view.setConnected('connected');
  partly.view.render(modelOf(withLines(PLAIN.replace('t1:', '_t1:'))));
  buttonsOf(headOf(partly.strips, 'g1')).mute.dispatch('click');
  assert.deepEqual([partly.presses[0].change.on, partly.presses[0].label], [true, 'mixer: group g1 muted']);
  const soloed = setup();
  soloed.view.setConnected('connected');
  soloed.view.render(modelOf(withLines(PLAIN.replace('t1:', 'S_t1:').replace('t2:', 'S_t2:'))));
  buttonsOf(headOf(soloed.strips, 'g1')).solo.dispatch('click');
  assert.deepEqual([soloed.presses[0].change.on, soloed.presses[0].label], [false, 'mixer: group g1 solo off']);
});

test('a group name that is markup stays text in the head, the names and the notes', () => {
  const { view, strips } = setup();
  view.setConnected('connected');
  const name = '<img src=x onerror=alert(1)>';
  view.render(modelOf(piece({ groups: `{ '${name}': ['t1', 't2'] }`, names: ['t1', 't2', 't3'] })));
  const head = headOf(strips, name);
  const { mute } = buttonsOf(head);
  assert.equal(mute.getAttribute('aria-label'), `Mute ${name}`);
  assert.equal(all(head, 'mx-fold-name')[0].textContent, name);
  assert.equal(head.children.every((child) => child.tagName !== 'img'), true);
});

// --- Asking about a group, and the order of a group's controls ---

/** The strips area inside the view root, so a right-click target can be found from its element like the page does. */
function setupInView() {
  const made = setup();
  made.elements['mixer-view'].append(made.strips);
  return made;
}

test('a right-click on a group head, its buttons, its count line or its frame asks about the group', () => {
  const { view, strips } = setupInView();
  view.setConnected('connected');
  view.render(modelOf(piece()));
  const frame = frameOf(strips, 'g1');
  const head = headOf(strips, 'g1');
  const { mute, solo, count } = buttonsOf(head);
  const [fold] = all(frame, 'mx-fold');
  for (const element of [fold, mute, solo, count, head, frame, bodyOf(frame)]) {
    assert.deepEqual(view.askTarget(element), { kind: 'group', name: 'g1' });
  }
});

test('a nested group names its parent, and the parent is the group directly above it', () => {
  const { view, strips } = setupInView();
  view.render(modelOf(piece()));
  assert.deepEqual(view.askTarget(all(frameOf(strips, 'g3'), 'mx-fold')[0]), { kind: 'group', name: 'g3', parent: 'g2' });
  assert.deepEqual(view.askTarget(all(frameOf(strips, 'g2'), 'mx-fold')[0]), { kind: 'group', name: 'g2' });
  const deep = setupInView();
  deep.view.render(modelOf(piece({ groups: "{ a: { b: { c: ['t1'] } } }", names: ['t1'], extra: [] })));
  assert.deepEqual(deep.view.askTarget(all(frameOf(deep.strips, 'c'), 'mx-fold')[0]), { kind: 'group', name: 'c', parent: 'b' });
});

test('a right-click on a strip inside a frame still asks about the track, not the group', () => {
  const { view, strips } = setupInView();
  view.render(modelOf(piece()));
  const strip = all(frameOf(strips, 'g1'), 'mx-strip').find((node) => node.getAttribute('data-track') === 'label:t1');
  assert.deepEqual(view.askTarget(strip), { kind: 'track', track: 't1' });
  assert.deepEqual(view.askTarget(all(strip, 'mx-name')[0]), { kind: 'track', track: 't1' });
});

test('a long group name is asked about whole, and a frame that left the model asks about nothing', () => {
  const name = 'n'.repeat(60);
  const { view, strips } = setupInView();
  view.render(modelOf(piece({ groups: `{ ${name}: ['t1', 't2'] }` })));
  const frame = frameOf(strips, `${'n'.repeat(39)}…`);
  assert.deepEqual(view.askTarget(all(frame, 'mx-fold')[0]), { kind: 'group', name });
  // A frame still on the page whose key the view does not know.
  const stranger = setupInView();
  stranger.view.render(modelOf(piece()));
  const orphan = frameOf(stranger.strips, 'g1');
  orphan.setAttribute('data-group', '["gone"]');
  assert.equal(stranger.view.askTarget(all(orphan, 'mx-fold')[0]), null);
});

test('the buttons of a group head come in the order fold, M, S, and a folded body is hidden with its strips', () => {
  const { view, strips } = setup();
  view.setConnected('connected');
  view.render(modelOf(piece(), ['["g1"]']));
  const buttonsIn = (node) => {
    const found = [];
    const walk = (current) => {
      if (current.tagName === 'button') found.push(current.className);
      for (const child of current.children) walk(child);
    };
    walk(node);
    return found;
  };
  assert.deepEqual(buttonsIn(headOf(strips, 'g1')), ['mx-fold', 'mx-mute', 'mx-solo']);
  const frame = frameOf(strips, 'g1');
  // The head comes before the body in the frame, and the body that holds the strips' buttons is the one that is hidden.
  assert.deepEqual(frame.children.map((child) => child.className), ['mx-group-head', 'mx-group-body']);
  assert.equal(bodyOf(frame).hasAttribute('hidden'), true);
  assert.ok(buttonsIn(bodyOf(frame)).length > 0);
  const open = setup();
  open.view.render(modelOf(piece()));
  assert.equal(bodyOf(frameOf(open.strips, 'g1')).hasAttribute('hidden'), false);
});

// --- Lights ---

const lightOf = (strip) => all(strip, 'mx-light')[0];
const stripOfTrack = (strips, track) => all(strips, 'mx-strip').find((el) => el.getAttribute('data-track') === track);

test('every labeled track strip starts with a name row holding its light and then the name button, and the light is never announced or focusable', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  for (const track of ['label:t1', 'label:t2', 'label:t3', 'label:t4']) {
    const strip = stripOfTrack(strips, track);
    const row = strip.children[0];
    assert.equal(row.className, 'mx-name-row');
    assert.deepEqual(row.children.map((child) => child.className), ['mx-light', 'mx-name']);
    const light = row.children[0];
    assert.equal(light.tagName, 'span');
    assert.equal(light.getAttribute('aria-hidden'), 'true');
    assert.equal(light.getAttribute('title'), `Blinks when ${track.slice(6)} plays a note`);
    assert.equal(light.hasAttribute('hidden'), false);
    assert.equal(light.hasAttribute('tabindex'), false);
    assert.deepEqual(light.children.map((child) => child.className), ['mx-light-fill']);
    assert.equal(light.children[0].style.opacity, '');
    assert.equal(row.children[1].tagName, 'button');
  }
});

test('a strip with no label has a hidden light, and a bus strip has none', () => {
  const { view, strips } = setup();
  view.render(buildMixerModel({ code: 'stack(s("bd"), s("hh")).room(0.2)', parse, colorOf }));
  const unnamed = all(strips, 'mx-strip').filter((el) => !el.className.includes('mx-bus'));
  assert.equal(unnamed.length, 2);
  for (const strip of unnamed) assert.equal(lightOf(strip).hasAttribute('hidden'), true);
  const labeled = setup();
  labeled.view.render(modelOf(piece()));
  const bus = all(labeled.strips, 'mx-bus')[0];
  assert.ok(bus !== undefined);
  assert.equal(all(bus, 'mx-light').length, 0);
});

test("a group head's light sits before the fold button, and its title names the group as plain text", () => {
  const { view, strips } = setup();
  view.render(modelOf(piece({ groups: "{ g1: ['t1', 't2'], '$&x': ['t3'] }" })));
  const head = headOf(strips, 'g1');
  const title = all(head, 'mx-group-title')[0];
  assert.deepEqual(title.children.map((child) => child.className), ['mx-light', 'mx-fold']);
  assert.equal(title.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(title.children[0].getAttribute('title'), 'Blinks when any track of g1 plays a note');
  // A name with `$&` reaches the title unchanged: it is not read as a replacement pattern.
  assert.equal(all(headOf(strips, '$&x'), 'mx-light')[0].getAttribute('title'), 'Blinks when any track of $&x plays a note');
});

test('drawing the same model again writes nothing to a light', () => {
  const { view, strips } = setup();
  const model = modelOf(piece());
  view.render(model);
  const lightWrites = () => [...all(strips, 'mx-light'), ...all(strips, 'mx-light-fill')].reduce((sum, node) => sum + node.writes, 0);
  assert.ok(all(strips, 'mx-light').length >= 7);
  const before = lightWrites();
  view.render(model);
  assert.equal(lightWrites(), before);
});

test('setLights with motion on writes the fill opacity of a track and of a group, and skips a light the view does not hold', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const t1 = lightOf(stripOfTrack(strips, 'label:t1'));
  const g1 = all(headOf(strips, 'g1'), 'mx-light')[0];
  view.setLights([{ kind: 'track', id: 'label:t1', value: 1 }, { kind: 'group', id: '["g1"]', value: 0.5 }, { kind: 'track', id: 'label:gone', value: 1 }, { kind: 'group', id: '["gone"]', value: 1 }], 'on');
  assert.equal(t1.children[0].style.opacity, '1');
  assert.equal(g1.children[0].style.opacity, '0.5');
  assert.equal(t1.hasAttribute('data-lit'), false);
  view.setLights([{ kind: 'track', id: 'label:t1', value: 0 }], 'on');
  assert.equal(t1.children[0].style.opacity, '0');
});

test('setLights with motion off marks the light lit or unlit and never writes an opacity', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const t1 = lightOf(stripOfTrack(strips, 'label:t1'));
  const g1 = all(headOf(strips, 'g1'), 'mx-light')[0];
  view.setLights([{ kind: 'track', id: 'label:t1', value: 1 }, { kind: 'group', id: '["g1"]', value: 1 }], 'off');
  assert.equal(t1.getAttribute('data-lit'), 'true');
  assert.equal(g1.getAttribute('data-lit'), 'true');
  view.setLights([{ kind: 'track', id: 'label:t1', value: 0 }], 'off');
  assert.equal(t1.getAttribute('data-lit'), 'false');
  assert.equal(t1.children[0].style.opacity, '');
  assert.equal(g1.children[0].style.opacity, '');
});

test('setLights refuses a motion that is not on or off', () => {
  const { view } = setup();
  view.render(modelOf(piece()));
  assert.throws(() => view.setLights([], 'fast'), /^Error: Moontide:/);
  assert.throws(() => view.setLights([], undefined), /^Error: Moontide:/);
});

test('clearLights removes the inline opacity and the lit mark of every track and group light, in both forms', () => {
  const { view, strips } = setup();
  view.render(modelOf(piece()));
  const lights = [lightOf(stripOfTrack(strips, 'label:t1')), lightOf(stripOfTrack(strips, 'label:t4')), all(headOf(strips, 'g1'), 'mx-light')[0], all(headOf(strips, 'g2'), 'mx-light')[0]];
  view.setLights([{ kind: 'track', id: 'label:t1', value: 0.75 }, { kind: 'track', id: 'label:t4', value: 1 }, { kind: 'group', id: '["g1"]', value: 1 }, { kind: 'group', id: '["g2"]', value: 1 }], 'on');
  view.setLights([{ kind: 'track', id: 'label:t1', value: 1 }, { kind: 'group', id: '["g1"]', value: 1 }], 'off');
  assert.ok(lights.some((light) => light.children[0].style.opacity !== ''));
  assert.ok(lights.some((light) => light.hasAttribute('data-lit')));
  view.clearLights();
  for (const light of lights) {
    assert.equal(light.children[0].style.opacity, '');
    assert.equal(light.hasAttribute('data-lit'), false);
  }
});

test('the light code writes nothing to the editor or the server, and builds no markup from text', () => {
  const lights = readFileSync(fileURLToPath(new URL('../page/lights.js', import.meta.url)), 'utf8');
  const code = lights.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(document|window|fetch|WebSocket|localStorage|navigator)\b|innerHTML|evaluate/);
  const start = SOURCE.indexOf('function createLight()');
  const section = SOURCE.slice(start, start + 600);
  assert.doesNotMatch(section, /innerHTML|insertAdjacentHTML/);
});

test('the stylesheet rules for groups, folds, lights and the name row never animate and use only the page type sizes and weights', () => {
  const css = readFileSync(fileURLToPath(new URL('../page/style.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] }));
  const ours = rules.filter((rule) => /\.mx-(group|fold|light|name-row)/.test(rule.selector));
  // The light's own rules must be among them, so the test cannot pass by matching nothing.
  assert.ok(ours.some((rule) => rule.selector.includes('.mx-light-fill')));
  assert.ok(ours.some((rule) => rule.selector.includes('.mx-name-row')));
  assert.ok(ours.some((rule) => rule.selector.includes('.mx-fold')));
  for (const rule of ours) {
    assert.doesNotMatch(rule.body, /transition|animation|@keyframes/, `${rule.selector} must not animate`);
    for (const [, size] of rule.body.matchAll(/font-size:\s*([^;]+);/g)) assert.equal(size.trim(), '0.8125rem', `${rule.selector} font-size`);
    for (const [, weight] of rule.body.matchAll(/font-weight:\s*([^;]+);/g)) assert.ok(['400', '600'].includes(weight.trim()), `${rule.selector} font-weight ${weight}`);
  }
  assert.doesNotMatch(css, /@keyframes/);
});
