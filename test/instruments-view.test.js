// The Instruments view's DOM code, tested without a browser against a tiny fake document.
// The live behavior in real Chrome is proved by `npm run probe:midi` and `npm run probe:page`; these tests pin the
// redraw bookkeeping, which a probe cannot reach (a draw that throws), and the switch's pending and refusal state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstrumentsView } from '../page/instruments-view.js';

const IDS = [
  'instruments-view',
  'instruments-notice',
  'instruments-message',
  'instruments-message-text',
  'instruments-folder',
  'instruments-message-sub',
  'instruments-problems',
  'instruments-message-closing',
  'instruments-body',
  'instruments-list',
  'instruments-footer',
  'instruments-status',
];

function fakeNode(doc, tagName = 'div') {
  const node = {
    tagName,
    hidden: false,
    textContent: '',
    className: '',
    dataset: {},
    children: [],
    scrollTop: 0,
    parent: null,
    append(...nodes) {
      for (const child of nodes) if (typeof child === 'object') child.parent = node;
      node.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      for (const child of nodes) if (typeof child === 'object') child.parent = node;
      node.children = nodes;
    },
    // The two DOM methods the refusal line uses: insert after a node, and leave the parent.
    after(...nodes) {
      const siblings = node.parent.children;
      for (const child of nodes) child.parent = node.parent;
      siblings.splice(siblings.indexOf(node) + 1, 0, ...nodes);
    },
    remove() {
      if (node.parent === null) return;
      node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = null;
    },
    attributes: new Map(),
    setAttribute(name, value) {
      node.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
    removeAttribute(name) {
      node.attributes.delete(name);
    },
    // Records every listener, so a test can press a control and can prove the message path attaches none.
    listeners: [],
    addEventListener(type, handler) {
      node.listeners.push({ type, handler });
    },
    get firstElementChild() {
      return node.children.find((child) => typeof child === 'object') ?? null;
    },
    contains(other) {
      return other === node || node.children.some((child) => typeof child === 'object' && child.contains(other));
    },
    focus(options) {
      doc.focusCalls += 1;
      doc.lastFocusOptions = options;
      doc.activeElement = node;
    },
    // Like after(): insert ahead of this node in its parent.
    before(...nodes) {
      const siblings = node.parent.children;
      for (const child of nodes) child.parent = node.parent;
      siblings.splice(siblings.indexOf(node), 0, ...nodes);
    },
    // The editor's extras: replaceWith and scrollIntoView, and the form controls' own properties.
    replaceWith(other) {
      other.parent = node.parent;
      node.parent.children = node.parent.children.map((child) => (child === node ? other : child));
      node.parent = null;
    },
    scrollIntoView() {},
    toggleAttribute(name, force) {
      if (name === 'hidden') node.hidden = force;
    },
    disabled: false,
    value: '',
    checked: false,
  };
  return node;
}

function fakeDocument() {
  // focusCalls counts every focus() so a test can prove a live change called none.
  const doc = { activeElement: null, focusCalls: 0 };
  const nodes = new Map(IDS.map((id) => [id, fakeNode(doc)]));
  return Object.assign(doc, {
    nodes,
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: (tag) => fakeNode(doc, tag),
    createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: () => fakeNode(doc),
  });
}

/** Every node under `node` (and `node` itself) that passes `test`, in document order. */
function findAll(node, test, found = []) {
  if (typeof node !== 'object') return found;
  if (test(node)) found.push(node);
  for (const child of node.children) findAll(child, test, found);
  return found;
}

/** A well-formed message model, as instrumentsModel() returns one. */
function message(lead) {
  return { kind: 'message', state: 'no-file', notice: null, lead, folder: null, sub: null, problems: [], more: null, closing: null };
}

test('a draw that throws is retried with the same model instead of being skipped as already shown', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  // `problems` is not a list: the draw writes the lead, then throws while building the problem rows.
  const broken = { ...message('Lead A'), problems: null };
  assert.throws(() => view.render(broken), TypeError);
  assert.equal(document.nodes.get('instruments-message-text').textContent, 'Lead A', 'the draw got as far as the lead');
  assert.throws(() => view.render(broken), TypeError, 'the second call with the same model must draw again, not return early');
});

test('after a failed draw the next good model is drawn, and an unchanged good model then writes nothing', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  assert.throws(() => view.render({ ...message('Lead A'), problems: null }), TypeError);
  view.render(message('Lead B'));
  const text = document.nodes.get('instruments-message-text');
  assert.equal(text.textContent, 'Lead B');
  assert.equal(document.nodes.get('instruments-message').hidden, false);
  text.textContent = 'touched by the test';
  view.render(message('Lead B'));
  assert.equal(text.textContent, 'touched by the test', 'an unchanged model must not be drawn again');
});

test('a failed draw forgets what was shown, so askTarget answers null until the next good draw', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(message('Lead A'));
  assert.throws(() => view.render({ ...message('Lead B'), problems: null }), TypeError);
  assert.equal(view.askTarget({ closest: () => assert.fail('no card lookup without a drawn model') }), null);
});

// --- The Drum map disclosure: its open state is kept in memory by instrument and map ---

const knownMap = (key, summary) => ({ kind: 'known', key, summary, notes: [{ note: '36', name: 'Kick' }, { note: '38', name: 'Snare' }] });
const unknownMap = { kind: 'unknown', key: 'unknown:Kit C', sub: 'No note map is known for Kit C, so notes show as numbers.' };
const STANDARD = knownMap('gs-standard', 'Drum map: Standard (2)');
const ORCHESTRA = knownMap('gs-orchestra', 'Drum map: Orchestra (2) for Orchestra Set');

/** A card as instrumentsModel() produces one for an instrument with a rhythm channel. */
function drumCard(id, drumMaps, overrides = {}) {
  return {
    id,
    title: `${id} title`,
    model: { text: 'Model', title: 'model' },
    port: { name: `Port ${id}`, dot: { kind: 'filled', title: 'dot' }, words: 'connected', attention: false, stateKind: 'connected' },
    channels: 'ch 1–9 melodic, ch 10 rhythm',
    clock: null,
    controls: [],
    controlsNone: 'none',
    catalog: null,
    enabled: true,
    settings: { port: `Port ${id}`, channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], clock: false },
    modelChannels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((channel) => ({ channel, role: channel === 10 ? 'rhythm' : 'melodic' })),
    usedChannels: [],
    inUse: { lead: null, lines: ['not used by the code'], muted: true },
    drumKit: { lines: [{ text: 'not used by the code', title: null, muted: true }] },
    drumMaps,
    drumDeclared: 'declared',
    ...overrides,
  };
}

const PORTS = { outputs: [], access: 'enabled', supported: true };
const cardsModel = (...cards) => ({ kind: 'cards', notice: null, cards, ports: PORTS, footer: 'footer' });
const detailsOf = (document, id) => {
  const card = document.nodes.get('instruments-list').children.find((child) => child.dataset.instrument === id);
  return findAll(card, (node) => node.tagName === 'details');
};
const summaryOf = (details) => findAll(details, (node) => node.tagName === 'summary')[0];

test('a live redraw that keeps the map keeps the same details node and its open state', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', [STANDARD])));
  const [details] = detailsOf(document, 'a');
  assert.equal(details.open, false, 'a map starts closed');
  details.open = true;
  view.render(cardsModel(drumCard('a', [STANDARD], { inUse: { lines: ['drums · ch 10'], muted: false }, port: { name: 'Port a', dot: { kind: 'hollow', title: 'dot' }, words: 'unplugged', attention: true, stateKind: 'unplugged' } })));
  const [after] = detailsOf(document, 'a');
  assert.equal(after, details, 'the map did not change, so the node stays');
  assert.equal(after.open, true);
});

test('a rebuild of the list restores open by instrument id and map key; another instrument or map starts closed', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', [STANDARD]), drumCard('b', [STANDARD])));
  detailsOf(document, 'a')[0].open = true;
  // A declared fact changed: the whole list is built again from new nodes.
  view.render(cardsModel(drumCard('a', [STANDARD], { drumDeclared: 'changed' }), drumCard('b', [STANDARD])));
  assert.equal(detailsOf(document, 'a')[0].open, true, 'the same instrument and map are open again');
  assert.equal(detailsOf(document, 'b')[0].open, false, 'another instrument with the same map stays closed');
  view.render(cardsModel(drumCard('a', [ORCHESTRA], { drumDeclared: 'changed again' }), drumCard('b', [STANDARD])));
  assert.equal(detailsOf(document, 'a')[0].open, false, 'another map of the same instrument starts closed');
});

test('a map that turns unknown replaces the details by plain lines, and back it is open again if it was open', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', [STANDARD])));
  detailsOf(document, 'a')[0].open = true;
  view.render(cardsModel(drumCard('a', [unknownMap])));
  assert.equal(detailsOf(document, 'a').length, 0, 'an unknown map has no details element');
  const lines = findAll(document.nodes.get('instruments-list'), (node) => /^instrument-drum-(unknown|sub)/.test(node.className));
  assert.deepEqual(lines.map((line) => line.className), ['instrument-drum-unknown', 'instrument-drum-sub instrument-muted']);
  assert.equal(lines[1].textContent, unknownMap.sub);
  view.render(cardsModel(drumCard('a', [STANDARD])));
  assert.equal(detailsOf(document, 'a')[0].open, true);
  view.render(cardsModel(drumCard('a', [ORCHESTRA])));
  assert.equal(detailsOf(document, 'a')[0].open, false, 'a map never opened starts closed');
});

test('focus on a Drum map summary is put back on the new summary of the same instrument and map, else on the card', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', [STANDARD]), drumCard('b', [STANDARD])));
  const list = document.nodes.get('instruments-list');
  const firstSummary = summaryOf(detailsOf(document, 'a')[0]);
  firstSummary.focus();
  // A live redraw that rewrites the map line (same key, new words).
  view.render(cardsModel(drumCard('a', [knownMap('gs-standard', 'Drum map: Standard (3)')]), drumCard('b', [STANDARD])));
  const second = summaryOf(detailsOf(document, 'a')[0]);
  assert.notEqual(second, firstSummary);
  assert.equal(document.activeElement, second);
  // A rebuild: the new summary of the same instrument and map.
  view.render(cardsModel(drumCard('a', [knownMap('gs-standard', 'Drum map: Standard (3)')], { drumDeclared: 'changed' }), drumCard('b', [STANDARD])));
  assert.equal(document.activeElement, summaryOf(detailsOf(document, 'a')[0]));
  // The map turns unknown: focus goes to the card of the same instrument.
  view.render(cardsModel(drumCard('a', [unknownMap]), drumCard('b', [STANDARD])));
  assert.equal(document.activeElement, list.children[0]);
  assert.equal(document.activeElement.dataset.instrument, 'a');
});

test('the Drum kit lines are replaced in place when the kit changes, with their title and muted class', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', [STANDARD])));
  const kitLines = () => findAll(document.nodes.get('instruments-list'), (node) => node.className.startsWith('instrument-drum-kit'));
  assert.deepEqual(kitLines().map((line) => [line.textContent, line.className]), [['not used by the code', 'instrument-drum-kit instrument-muted']]);
  view.render(cardsModel(drumCard('a', [STANDARD], { drumKit: { lines: [{ text: 'Standard Set · ch 10', title: 'Standard Set: program 0', muted: false }] } })));
  assert.deepEqual(kitLines().map((line) => [line.textContent, line.className]), [['Standard Set · ch 10', 'instrument-drum-kit']]);
});

test('a card with no rhythm channel has no Drum kit row and no Drum map container', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', null, { drumKit: null })));
  const list = document.nodes.get('instruments-list');
  assert.equal(findAll(list, (node) => /instrument-drum/.test(node.className)).length, 0);
  assert.equal(detailsOf(document, 'a').length, 0);
});

test('the list of notes holds one li per note: the number, a space and the name', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('a', [STANDARD])));
  const items = findAll(document.nodes.get('instruments-list'), (node) => node.tagName === 'li' && node.className === '');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].children.map((child) => (typeof child === 'string' ? child : child.textContent)), ['36', ' ', 'Kick']);
});

// --- The switch on each card ---

/** The nodes of one card's switch: the button and its parts. */
function switchOf(document, id) {
  const card = document.nodes.get('instruments-list').children.find((child) => child.dataset.instrument === id);
  const [button] = findAll(card, (node) => node.tagName === 'button');
  const [thumb] = findAll(card, (node) => node.className === 'instrument-switch-thumb');
  const [word] = findAll(card, (node) => node.className === 'instrument-switch-word');
  return { card, button, thumb, word };
}

const press = (node) => {
  for (const { type, handler } of node.listeners) if (type === 'click') handler();
};

test('a view made without onInstrumentSwitch or onInstrumentSettings throws at creation, loudly', () => {
  assert.throws(() => createInstrumentsView({ document: fakeDocument() }), /Moontide: the Instruments view needs onInstrumentSwitch\./);
  assert.throws(() => createInstrumentsView({ document: fakeDocument(), onInstrumentSwitch: 'nope' }), /needs onInstrumentSwitch/);
  assert.throws(() => createInstrumentsView({ document: fakeDocument(), onInstrumentSwitch: () => {} }), /Moontide: the Instruments view needs onInstrumentSettings\./);
});

test('the message path attaches no listener and builds no switch', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(message('Lead A'));
  for (const node of document.nodes.values()) assert.deepEqual(node.listeners, [], 'a message attaches no listener');
  assert.equal(document.nodes.get('instruments-list').children.length, 0);
});

test('each card holds a switch with role switch, aria-checked, a title and the word of the confirmed state', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD]), drumCard('beta', [STANDARD], { enabled: false })));
  const alpha = switchOf(document, 'alpha');
  assert.equal(alpha.button.getAttribute('role'), 'switch');
  assert.equal(alpha.button.getAttribute('type'), 'button');
  assert.equal(alpha.button.getAttribute('aria-checked'), 'true');
  assert.equal(alpha.button.getAttribute('title'), 'Switch alpha off');
  assert.equal(alpha.word.textContent, 'On');
  assert.equal(alpha.thumb.dataset.thumb, 'on');
  assert.equal(alpha.card.dataset.enabled, 'true');
  const beta = switchOf(document, 'beta');
  assert.equal(beta.button.getAttribute('aria-checked'), 'false');
  assert.equal(beta.word.textContent, 'Off');
  assert.equal(beta.card.dataset.enabled, 'false');
});

test('a press shows the pending look and calls back once with the target, never a toggle', () => {
  const document = fakeDocument();
  const calls = [];
  const view = createInstrumentsView({ document, onInstrumentSwitch: (id, enabled) => calls.push([id, enabled]), onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD]), drumCard('beta', [STANDARD], { enabled: false })));
  const alpha = switchOf(document, 'alpha');
  press(alpha.button);
  assert.deepEqual(calls, [['alpha', false]]);
  assert.equal(alpha.button.getAttribute('aria-busy'), 'true');
  assert.equal(alpha.button.getAttribute('aria-disabled'), 'true');
  assert.equal(alpha.button.getAttribute('aria-checked'), 'true', 'no optimistic flip');
  assert.equal(alpha.word.textContent, 'Turning off…');
  assert.equal(alpha.thumb.dataset.thumb, 'pending');
  press(alpha.button);
  assert.equal(calls.length, 1, 'a press on a pending switch does nothing');
  press(switchOf(document, 'beta').button);
  assert.deepEqual(calls[1], ['beta', true], 'another card has its own request');
});

test('settle ends the pending look and the switch shows the confirmed state again', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  const { button, word, thumb } = switchOf(document, 'alpha');
  press(button);
  view.settle('alpha', { ok: true });
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.getAttribute('aria-disabled'), null);
  assert.equal(word.textContent, 'On');
  assert.equal(thumb.dataset.thumb, 'on');
  press(button);
  assert.equal(button.getAttribute('aria-busy'), 'true', 'a new press starts a new request');
});

test('a live update that changes enabled flips the switch in place: the same nodes, no focus call', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  const before = switchOf(document, 'alpha');
  before.button.focus();
  let focusCalls = 0;
  const focus = before.button.focus;
  before.button.focus = () => {
    focusCalls += 1;
    focus();
  };
  view.render(cardsModel(drumCard('alpha', [STANDARD], { enabled: false })));
  const after = switchOf(document, 'alpha');
  assert.equal(after.button, before.button, 'the switch node stays');
  assert.equal(after.card, before.card);
  assert.equal(after.button.getAttribute('aria-checked'), 'false');
  assert.equal(after.word.textContent, 'Off');
  assert.equal(after.card.dataset.enabled, 'false');
  assert.equal(document.activeElement, before.button);
  assert.equal(focusCalls, 0);
});

test('a pending switch survives a rebuild of the list and a closed view', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  press(switchOf(document, 'alpha').button);
  view.closed();
  view.render(cardsModel(drumCard('alpha', [STANDARD], { drumDeclared: 'changed' })));
  const { button, word } = switchOf(document, 'alpha');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(word.textContent, 'Turning off…');
});

test('a message takes the cards, and their switches, out of the page', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  // The switch and Edit settings.
  assert.equal(findAll(document.nodes.get('instruments-list'), (node) => node.tagName === 'button').length, 2);
  view.render(message('Disconnected'));
  assert.equal(findAll(document.nodes.get('instruments-list'), (node) => node.tagName === 'button').length, 0);
});

// --- The pending, refused and unanswered switch ---

const errorOf = (document, id) => findAll(switchOf(document, id).card, (node) => node.className === 'instrument-error')[0];
const refused = (reason) => ({ ok: false, kind: 'refused', reason, missing: reason === null ? 'reason' : null });

test('a refusal ends the pending look, keeps the confirmed state and shows the reason as a line with role alert', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  const { button, card } = switchOf(document, 'alpha');
  press(button);
  view.settle('alpha', refused('the choice could not be saved (EACCES)'));
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.getAttribute('aria-disabled'), null);
  assert.equal(button.getAttribute('aria-checked'), 'true', 'the confirmed state is shown again');
  const line = errorOf(document, 'alpha');
  assert.equal(line.tagName, 'p');
  assert.equal(line.getAttribute('role'), 'alert');
  assert.equal(line.textContent, 'Could not switch alpha off: the choice could not be saved (EACCES)');
  assert.equal(card.children[1], line, 'the line sits right after the header');
  assert.equal(card.children[0].className, 'instrument-head');
});

test('a reason that holds markup stays text: the line has no element child', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  press(switchOf(document, 'alpha').button);
  view.settle('alpha', refused('<b>x</b>'));
  const line = errorOf(document, 'alpha');
  assert.equal(line.textContent, 'Could not switch alpha off: <b>x</b>');
  assert.deepEqual(line.children, []);
});

test('a refusal with no reason says Moontide gave no reason, and a timeout says it did not confirm', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD]), drumCard('beta', [STANDARD], { enabled: false })));
  press(switchOf(document, 'alpha').button);
  view.settle('alpha', refused(null));
  assert.equal(errorOf(document, 'alpha').textContent, 'Could not switch alpha off: Moontide gave no reason.');
  press(switchOf(document, 'beta').button);
  view.settle('beta', { ok: false, kind: 'unconfirmed' });
  assert.equal(errorOf(document, 'beta').textContent, 'Moontide did not confirm — try again.');
  assert.equal(switchOf(document, 'beta').button.getAttribute('aria-checked'), 'false');
});

test('the next press clears the line, and a second refusal replaces it instead of adding one', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  const { button, card } = switchOf(document, 'alpha');
  press(button);
  view.settle('alpha', refused('first'));
  press(button);
  assert.equal(errorOf(document, 'alpha'), undefined, 'a press clears the line');
  view.settle('alpha', refused('second'));
  press(button);
  view.settle('alpha', refused('third'));
  assert.equal(findAll(card, (node) => node.className === 'instrument-error').length, 1);
  assert.equal(errorOf(document, 'alpha').textContent, 'Could not switch alpha off: third');
});

test('a live update that changes enabled removes the line', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  press(switchOf(document, 'alpha').button);
  view.settle('alpha', refused('no'));
  assert.ok(errorOf(document, 'alpha'));
  view.render(cardsModel(drumCard('alpha', [STANDARD], { enabled: false })));
  assert.equal(errorOf(document, 'alpha'), undefined);
});

test('settling an instrument that has no card and no request does nothing', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  view.settle('ghost', refused('no'));
  view.settle('ghost', { ok: true });
  assert.equal(findAll(document.nodes.get('instruments-list'), (node) => node.className === 'instrument-error').length, 0);
});

test('the pending look and the refusal line survive a closed view and a rebuilt card', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD]), drumCard('beta', [STANDARD])));
  press(switchOf(document, 'alpha').button);
  press(switchOf(document, 'beta').button);
  view.settle('beta', refused('no'));
  view.closed();
  view.render(cardsModel(drumCard('alpha', [STANDARD], { drumDeclared: 'changed' }), drumCard('beta', [STANDARD], { drumDeclared: 'changed' })));
  assert.equal(switchOf(document, 'alpha').button.getAttribute('aria-busy'), 'true');
  assert.equal(errorOf(document, 'beta').textContent, 'Could not switch beta off: no');
});

test('a request settled while the cards are replaced by a message shows its line when the cards return', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  press(switchOf(document, 'alpha').button);
  view.render(message('Disconnected'));
  view.settle('alpha', { ok: false, kind: 'unconfirmed' });
  view.render(cardsModel(drumCard('alpha', [STANDARD])));
  const { button } = switchOf(document, 'alpha');
  assert.equal(button.getAttribute('aria-busy'), null, 'no pending look is left');
  assert.equal(errorOf(document, 'alpha').textContent, 'Moontide did not confirm — try again.');
});

test('the In use row of an off instrument starts with the muted silent line, then the usual lines, in place', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render(cardsModel(drumCard('alpha', [STANDARD], { inUse: { lead: null, lines: ['lead · ch 3'], muted: false } })));
  const lines = () => findAll(document.nodes.get('instruments-list'), (node) => node.className.startsWith('instrument-inuse-line')).map((node) => [node.textContent, node.className]);
  assert.deepEqual(lines(), [['lead · ch 3', 'instrument-inuse-line']]);
  view.render(cardsModel(drumCard('alpha', [STANDARD], { enabled: false, inUse: { lead: 'silent while switched off', lines: ['lead · ch 3'], muted: false } })));
  assert.deepEqual(lines(), [
    ['silent while switched off', 'instrument-inuse-line instrument-muted'],
    ['lead · ch 3', 'instrument-inuse-line'],
  ]);
});

// --- The settings editor ---

const run = (node, type, event = { preventDefault() {}, stopPropagation() {} }) => {
  for (const { type: kind, handler } of node.listeners) if (kind === type) handler(event);
};
const cardOfId = (document, id) => document.nodes.get('instruments-list').children.find((child) => child.dataset.instrument === id);
const byClass = (root, className) => findAll(root, (node) => node.className === className);
const editButtonOf = (document, id) => byClass(cardOfId(document, id), 'instrument-edit')[0];
const formOf = (document, id) => findAll(cardOfId(document, id), (node) => node.tagName === 'form')[0];
const selectOf = (form) => findAll(form, (node) => node.tagName === 'select')[0];
const chipInputs = (form) => findAll(form, (node) => node.tagName === 'input' && node.getAttribute('type') === 'checkbox' && node.parent.className === 'instrument-channel');
const clockOf = (form) => findAll(form, (node) => node.tagName === 'input' && node.parent.className === 'instrument-clock')[0];
const buttonsOf = (form) => ({ save: byClass(form, 'instrument-action')[0], cancel: byClass(form, 'instrument-action')[1] });
/** Unchecks (or checks) one chip the way a click does: the property changes, then the change event runs. */
const setChip = (form, channel, checked) => {
  const input = chipInputs(form)[channel - 1];
  input.checked = checked;
  run(input, 'change');
};

/** A view with two cards and the callbacks recorded. */
function editorView(ports = { outputs: ['Port a', 'Port b'], access: 'enabled', supported: true }) {
  const document = fakeDocument();
  const sent = [];
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: (id, settings) => sent.push([id, settings]) });
  const render = (...cards) => view.render({ ...cardsModel(...cards), ports });
  render(drumCard('a', [STANDARD]), drumCard('b', [STANDARD]));
  return { document, view, sent, render };
}

test('each card has an Edit settings button after the rows and before the Drum map, named with the instrument', () => {
  const { document } = editorView();
  const card = cardOfId(document, 'a');
  const classes = card.children.map((child) => child.className);
  assert.deepEqual(classes, ['instrument-head', 'instrument-rows', 'instrument-edit', 'instrument-drum-maps'].map((name) => name), 'head, rows, button, maps');
  const button = editButtonOf(document, 'a');
  assert.equal(button.textContent, 'Edit settings');
  assert.equal(button.getAttribute('aria-label'), 'Edit settings, a');
  assert.equal(button.getAttribute('type'), 'button');
});

test('Edit settings opens a form named for the instrument, hides the button and focuses the port select', () => {
  const { document } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  assert.equal(form.getAttribute('aria-label'), 'Settings of a');
  assert.equal(editButtonOf(document, 'a').hidden, true);
  assert.equal(document.activeElement, selectOf(form));
  assert.equal(formOf(document, 'b'), undefined, 'only that card opened');
  assert.deepEqual(selectOf(form).children.map((option) => option.textContent), ['Port a', 'Port b']);
  assert.equal(selectOf(form).value, 'Port a');
  assert.equal(chipInputs(form).length, 10);
  assert.ok(chipInputs(form).every((input) => input.checked));
  assert.equal(clockOf(form).checked, false);
  // Form order: fields, then the actions.
  assert.deepEqual(form.children.map((child) => child.className), ['instrument-editor-fields', 'instrument-actions']);
});

test('Save sends nothing while the draft equals the card; one change sends the full chosen set once and locks the form', () => {
  const { document, sent } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  const { save } = buttonsOf(form);
  assert.equal(save.getAttribute('aria-disabled'), 'true', 'nothing differs yet');
  run(save, 'click');
  run(form, 'submit');
  assert.deepEqual(sent, [], 'a press while disabled sends nothing');
  for (const channel of [4, 5, 6, 7, 8, 9]) setChip(form, channel, false);
  selectOf(form).value = 'Port b';
  run(selectOf(form), 'change');
  assert.equal(save.getAttribute('aria-disabled'), null, 'a difference enables Save');
  run(save, 'click');
  assert.deepEqual(sent, [['a', { port: 'Port b', channels: [1, 2, 3, 10], clock: false }]]);
  assert.equal(save.textContent, 'Saving…');
  assert.equal(findAll(form, (node) => node.tagName === 'fieldset' && node.className === 'instrument-editor-fields')[0].disabled, true);
  assert.equal(document.activeElement, save, 'focus stays on Save');
  run(save, 'click');
  assert.equal(sent.length, 1, 'one request in flight per card');
});

test('Enter on the port select saves, and Enter elsewhere does not', () => {
  const { document, sent } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  setChip(form, 2, false);
  const enter = { key: 'Enter', target: null, preventDefault() {}, stopPropagation() {} };
  run(form, 'keydown', { ...enter, target: clockOf(form) });
  assert.equal(sent.length, 0);
  run(form, 'keydown', { ...enter, target: selectOf(form) });
  assert.equal(sent.length, 1);
});

test('a confirmed save removes the form, shows Edit settings and puts focus on it', () => {
  const { document, view, sent } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  setChip(form, 2, false);
  run(buttonsOf(form).save, 'click');
  assert.equal(sent.length, 1);
  view.settle('a', { id: 'x', ok: true }, 'settings');
  assert.equal(formOf(document, 'a'), undefined);
  assert.equal(editButtonOf(document, 'a').hidden, false);
  assert.equal(document.activeElement, editButtonOf(document, 'a'));
});

test('a settings answer for a card that has no editor is ignored', () => {
  const { view } = editorView();
  view.settle('a', { id: 'x', ok: true }, 'settings');
  view.settle('nobody', { id: 'x', ok: false, kind: 'refused', reason: 'no' }, 'settings');
});

// --- The answers, Cancel and Esc, the draft that stays ---

const errorsOf = (document, id) => byClass(cardOfId(document, id), 'instrument-errors')[0];
const rowTexts = (list) => list.children.map((row) => (row.children.length === 0 ? row.textContent : row.children.map((part) => (typeof part === 'string' ? part : part.textContent)).join('')));
const hintOf = (form) => byClass(form, 'instrument-hint');

/** Opens the editor of card a, changes a channel and presses Save, so a request waits. */
function savingEditor(ports) {
  const harness = editorView(ports);
  run(editButtonOf(harness.document, 'a'), 'click');
  const form = formOf(harness.document, 'a');
  setChip(form, 2, false);
  run(buttonsOf(form).save, 'click');
  return { ...harness, form };
}

test('an invalid answer unlocks the form, keeps the draft, lists the rows and marks the named fields', () => {
  const { document, view, form } = savingEditor();
  const { save } = buttonsOf(form);
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems: [
    { field: 'instruments[0].channels[0]', reason: 'channel 17 is not a channel of model sc55' },
    { field: 'instruments[0].port', reason: 'same port as instruments[1] ("b")' },
    { field: 'instruments-state.json:off[0]', reason: 'not an id' },
  ], more: 0 }, 'settings');
  const fields = findAll(form, (node) => node.className === 'instrument-editor-fields')[0];
  assert.equal(fields.disabled, false, 'the fields unlock');
  assert.equal(save.textContent, 'Save');
  assert.equal(save.getAttribute('aria-disabled'), null, 'the draft still differs, so Save is ready again');
  assert.equal(chipInputs(form)[1].checked, false, 'the draft is kept');
  const list = errorsOf(document, 'a');
  assert.equal(list.tagName, 'ul');
  assert.equal(list.getAttribute('role'), 'alert');
  assert.deepEqual(rowTexts(list), ['Channels · channel 17 is not a channel of model sc55', 'Port · same port as instruments[1] ("b")', 'instruments-state.json:off[0] · not an id']);
  assert.equal(list.children[2].children[0].tagName, 'code', 'a field the page does not map is shown raw, in a code element');
  assert.equal(findAll(form, (node) => node.className === 'instrument-channels-group')[0].getAttribute('aria-invalid'), 'true');
  assert.equal(selectOf(form).getAttribute('aria-invalid'), 'true');
  assert.equal(clockOf(form).getAttribute('aria-invalid'), null);
  assert.equal(document.activeElement, save, 'focus stays on Save');
});

test('the next answer replaces the list instead of adding to it, and clears the marks it no longer names', () => {
  const { document, view, form } = savingEditor();
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems: [{ field: 'instruments[0].port', reason: 'first' }], more: 0 }, 'settings');
  const first = errorsOf(document, 'a');
  run(buttonsOf(form).save, 'click');
  assert.equal(errorsOf(document, 'a'), undefined, 'a new press clears the old rows until the answer');
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems: [{ field: 'instruments[0].channels[0]', reason: 'second' }], more: 0 }, 'settings');
  const second = errorsOf(document, 'a');
  assert.notEqual(second, first);
  assert.equal(byClass(cardOfId(document, 'a'), 'instrument-errors').length, 1);
  assert.deepEqual(rowTexts(second), ['Channels · second']);
  assert.equal(selectOf(form).getAttribute('aria-invalid'), null);
});

test('a reason holding markup stays text, in the list and in the title', () => {
  const { document, view } = savingEditor();
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems: [{ field: 'instruments[0].port', reason: '<b>bold</b> & <img src=x>' }], more: 0 }, 'settings');
  const list = errorsOf(document, 'a');
  assert.deepEqual(rowTexts(list), ['Port · <b>bold</b> & <img src=x>']);
  assert.ok(findAll(list, (node) => node.tagName === 'b' || node.tagName === 'img').length === 0);
});

test('more than five rows show five and "and N more"', () => {
  const { document, view } = savingEditor();
  const problems = Array.from({ length: 7 }, (_, index) => ({ field: 'instruments[0].channels[0]', reason: `reason ${index}` }));
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems, more: 2 }, 'settings');
  const texts = rowTexts(errorsOf(document, 'a'));
  assert.equal(texts.length, 6);
  assert.equal(texts[5], 'and 4 more');
});

test('a write failure draws the one line, keeps the draft and unlocks', () => {
  const { document, view, form } = savingEditor();
  view.settle('a', { id: 'x', ok: false, kind: 'write-failed', reason: 'the file system answered EISDIR' }, 'settings');
  assert.deepEqual(rowTexts(errorsOf(document, 'a')), ['Nothing was saved. instruments.json could not be written: the file system answered EISDIR']);
  assert.equal(chipInputs(form)[1].checked, false);
  assert.equal(findAll(form, (node) => node.className === 'instrument-editor-fields')[0].disabled, false);
  assert.equal(selectOf(form).getAttribute('aria-invalid'), null, 'no field is named');
});

test('no answer in time unlocks with the did-not-confirm line and the draft intact; a refusal draws its reason as one row', () => {
  const { document, view, form } = savingEditor();
  view.settle('a', { ok: false, kind: 'unconfirmed' }, 'settings');
  assert.deepEqual(rowTexts(errorsOf(document, 'a')), ['Moontide did not confirm — try again.']);
  assert.equal(buttonsOf(form).save.getAttribute('aria-disabled'), null);
  run(buttonsOf(form).save, 'click');
  view.settle('a', { id: 'x', ok: false, kind: 'refused', reason: 'this tab is not playing' }, 'settings');
  assert.deepEqual(rowTexts(errorsOf(document, 'a')), ['this tab is not playing']);
});

test('the port hint and the warning are tied to their fields and follow the draft', () => {
  const idle = { outputs: [], access: 'idle', supported: true };
  const { document } = editorView(idle);
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  assert.deepEqual(hintOf(form).map((node) => node.textContent), ['Detected ports show once MIDI is on in this page.']);
  assert.equal(selectOf(form).getAttribute('aria-describedby'), hintOf(form)[0].id);
});

test('a warning for a channel the code uses shows when it is unchecked and goes when it is checked again', () => {
  const document = fakeDocument();
  const view = createInstrumentsView({ document, onInstrumentSwitch: () => {}, onInstrumentSettings: () => {} });
  view.render({ ...cardsModel(drumCard('a', [STANDARD], { usedChannels: [3] })), ports: { outputs: ['Port a'], access: 'enabled', supported: true } });
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  assert.deepEqual(hintOf(form), []);
  setChip(form, 3, false);
  const warning = hintOf(form);
  assert.deepEqual(warning.map((node) => node.textContent), ['ch 3 is used by the code and goes silent after you save.']);
  const group = findAll(form, (node) => node.className === 'instrument-channels-group')[0];
  assert.equal(group.getAttribute('aria-describedby'), warning[0].id);
  setChip(form, 3, true);
  assert.deepEqual(hintOf(form), []);
  assert.equal(group.getAttribute('aria-describedby'), null);
});

test('Cancel removes the form, shows Edit settings, focuses it and drops the draft', () => {
  const { document } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  setChip(form, 2, false);
  run(buttonsOf(form).cancel, 'click');
  assert.equal(formOf(document, 'a'), undefined);
  assert.equal(editButtonOf(document, 'a').hidden, false);
  assert.equal(document.activeElement, editButtonOf(document, 'a'));
  run(editButtonOf(document, 'a'), 'click');
  assert.ok(chipInputs(formOf(document, 'a')).every((input) => input.checked), 'a reopened editor starts from the card again');
});

test('Esc in the form cancels it and keeps the page from also closing the view', () => {
  const { document } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  const calls = [];
  run(form, 'keydown', { key: 'Escape', target: selectOf(form), preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, ['prevent', 'stop']);
  assert.equal(formOf(document, 'a'), undefined);
  assert.equal(document.activeElement, editButtonOf(document, 'a'));
});

test('Cancel does nothing while a request waits', () => {
  const { document, form } = savingEditor();
  run(buttonsOf(form).cancel, 'click');
  assert.ok(formOf(document, 'a'), 'the form stays while saving');
  assert.equal(buttonsOf(form).cancel.getAttribute('aria-disabled'), 'true');
});

test('the draft survives a closed view and a new render; the rows too', () => {
  const { document, view, render } = savingEditor();
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems: [{ field: 'instruments[0].channels[0]', reason: 'kept' }], more: 0 }, 'settings');
  view.closed();
  render(drumCard('a', [STANDARD]), drumCard('b', [STANDARD]));
  const again = formOf(document, 'a');
  assert.equal(chipInputs(again)[1].checked, false, 'the same draft');
  assert.deepEqual(rowTexts(errorsOf(document, 'a')), ['Channels · kept']);
  // A rebuild of the list (a declared fact changed) brings the editor back from memory too.
  render(drumCard('a', [STANDARD], { drumDeclared: 'changed' }), drumCard('b', [STANDARD]));
  assert.equal(chipInputs(formOf(document, 'a'))[1].checked, false);
  assert.equal(editButtonOf(document, 'a').hidden, true);
  assert.equal(formOf(document, 'b'), undefined);
});

test('a message about the file drops the drafts; a message about the connection keeps them', () => {
  const { document, view, render } = savingEditor();
  view.render({ ...message('Disconnected'), state: 'disconnected' });
  render(drumCard('a', [STANDARD]), drumCard('b', [STANDARD]));
  assert.ok(formOf(document, 'a'), 'a lost connection keeps the draft');
  view.render({ ...message('Fix the file'), state: 'invalid' });
  render(drumCard('a', [STANDARD]), drumCard('b', [STANDARD]));
  assert.equal(formOf(document, 'a'), undefined, 'an invalid file takes the draft with it');
});

test('an instrument that is no longer in the file takes its draft with it', () => {
  const { document, render } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  render(drumCard('b', [STANDARD]));
  render(drumCard('a', [STANDARD]), drumCard('b', [STANDARD]));
  assert.equal(formOf(document, 'a'), undefined);
});

// --- A live change replaces one card and keeps the user's place ---

/** Two cards, a layout and a change: `changed` replaces card a's settings and declared facts (a Clock row appears). */
const withClock = (id, extra = {}) => drumCard(id, [STANDARD], { clock: 'follows the clock', settings: { port: `Port ${id}`, channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], clock: true }, ...extra });
const nodesOf = (document) => document.nodes.get('instruments-list').children.slice();

test('a settings change replaces that card only; the other cards keep their node', () => {
  const { document, render } = editorView();
  const [a, b] = nodesOf(document);
  render(withClock('a'), drumCard('b', [STANDARD]));
  const [a2, b2] = nodesOf(document);
  assert.notEqual(a2, a, 'the changed card is a new node');
  assert.equal(b2, b, 'the other card keeps its node');
  assert.equal(a2.dataset.instrument, 'a');
});

test('focus on a replaced card\'s switch, Edit settings or the card goes back to the same role in the new node', () => {
  const picks = [
    ['the switch', (document) => switchOf(document, 'a').button, (document) => switchOf(document, 'a').button],
    ['Edit settings', (document) => editButtonOf(document, 'a'), (document) => editButtonOf(document, 'a')],
    ['the card', (document) => cardOfId(document, 'a'), (document) => cardOfId(document, 'a')],
  ];
  for (const [name, before, after] of picks) {
    const { document, render } = editorView();
    const target = before(document);
    target.focus();
    const calls = document.focusCalls;
    render(withClock('a'), drumCard('b', [STANDARD]));
    assert.notEqual(after(document), target, `${name}: the node is a new one`);
    assert.equal(document.activeElement, after(document), `${name}: focus is on the same role in the new node`);
    assert.equal(document.focusCalls, calls + 1, `${name}: one focus call, on the restored node`);
    assert.deepEqual(document.lastFocusOptions, { preventScroll: true }, `${name}: the restore never scrolls`);
  }
});

test('a replacement calls focus() on nothing when focus was not inside the replaced card', () => {
  const { document, render } = editorView();
  const elsewhere = switchOf(document, 'b').button;
  elsewhere.focus();
  const before = document.focusCalls;
  render(withClock('a'), drumCard('b', [STANDARD]));
  assert.equal(document.focusCalls, before, 'no focus call');
  assert.equal(document.activeElement, elsewhere, 'focus did not move');
  // Focus nowhere in the view: still none.
  document.activeElement = null;
  render(drumCard('a', [STANDARD], { drumDeclared: 'again' }), drumCard('b', [STANDARD]));
  assert.equal(document.focusCalls, before);
});

test('the scroll of the body is kept by a replacement', () => {
  const { document, render } = editorView();
  const body = document.nodes.get('instruments-body');
  body.scrollTop = 123;
  render(withClock('a'), drumCard('b', [STANDARD]));
  assert.equal(body.scrollTop, 123);
});

test('an open editor survives its card being replaced, with its draft, its focused field and its refusal rows', () => {
  const { document, view, render } = savingEditor();
  view.settle('a', { id: 'x', ok: false, kind: 'invalid', problems: [{ field: 'instruments[0].channels[0]', reason: 'kept' }], more: 0 }, 'settings');
  const form = formOf(document, 'a');
  setChip(form, 5, false);
  chipInputs(form)[3].focus();
  render(withClock('a'), drumCard('b', [STANDARD]));
  const again = formOf(document, 'a');
  assert.notEqual(again, form, 'the card was replaced');
  assert.deepEqual(chipInputs(again).map((input) => input.checked), [true, false, true, true, false, true, true, true, true, true], 'the draft is back');
  assert.equal(document.activeElement, chipInputs(again)[3], 'the same chip has focus');
  assert.deepEqual(rowTexts(errorsOf(document, 'a')), ['Channels · kept']);
  assert.equal(editButtonOf(document, 'a').hidden, true);
});

test('a change made elsewhere shows the changed-elsewhere line once, touches neither draft nor focus, and updates the rows', () => {
  const { document, render } = editorView();
  run(editButtonOf(document, 'a'), 'click');
  const form = formOf(document, 'a');
  setChip(form, 2, false);
  chipInputs(form)[6].focus();
  assert.deepEqual(hintOf(form).map((node) => node.textContent), []);
  render(withClock('a', { channels: 'ch 1–10 elsewhere' }), drumCard('b', [STANDARD]));
  const again = formOf(document, 'a');
  assert.deepEqual(hintOf(again).map((node) => node.textContent), ['This instrument changed on another page. Saving replaces those values.']);
  assert.equal(document.activeElement, chipInputs(again)[6]);
  assert.equal(chipInputs(again)[1].checked, false, 'the draft is untouched');
  // The line is above the buttons.
  const kinds = again.children.map((child) => child.className);
  assert.deepEqual(kinds.slice(-2), ['instrument-hint', 'instrument-actions']);
  // The read-only rows show the new value.
  const rows = findAll(cardOfId(document, 'a'), (node) => node.className === 'instrument-word').map((node) => node.textContent);
  assert.ok(rows.includes('elsewhere'));
  // A second render with the same new settings keeps one line.
  render(withClock('a', { channels: 'ch 1–10 elsewhere', drumDeclared: 'x' }), drumCard('b', [STANDARD]));
  assert.equal(hintOf(formOf(document, 'a')).length, 1);
});

test('the save this page made is not a change made elsewhere', () => {
  const { document, render } = savingEditor();
  render(withClock('a'), drumCard('b', [STANDARD]));
  assert.deepEqual(hintOf(formOf(document, 'a')).map((node) => node.textContent), []);
});

test('a rebuild of the list brings the pending look, the refusal line and the open editor back by instrument id', () => {
  const { document, view, render } = editorView();
  press(switchOf(document, 'b').button);
  run(editButtonOf(document, 'a'), 'click');
  setChip(formOf(document, 'a'), 2, false);
  render(drumCard('b', [STANDARD]), drumCard('a', [STANDARD]));
  assert.equal(switchOf(document, 'b').button.getAttribute('aria-busy'), 'true');
  assert.equal(chipInputs(formOf(document, 'a'))[1].checked, false);
  view.settle('b', { id: 'x', ok: false, kind: 'refused', reason: 'no' });
  assert.ok(errorOf(document, 'b'));
});
