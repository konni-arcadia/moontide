// The lines above the Song grid, tested without a browser against a tiny fake document. The live lines in real Chrome are
// proved by `npm run probe:page`; these tests pin their text and the redraw bookkeeping. The grid itself is tested in
// test/song-grid-view.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSongView } from '../page/structure-view.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../page/structure-view.js', import.meta.url)), 'utf8');

function fakeDocument() {
  const doc = { created: 0 };
  doc.createElement = (tagName) => {
    doc.created += 1;
    return fakeNode(tagName);
  };
  return doc;
}

function fakeNode(tagName) {
  let own = '';
  const node = {
    tagName,
    className: '',
    hidden: false,
    children: [],
    attributes: new Map(),
    replaced: 0,
    get textContent() {
      return own + node.children.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      own = String(value);
      node.children = [];
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      node.replaced += 1;
      own = '';
      node.children = nodes;
    },
    setAttribute(name, value) {
      node.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
  };
  return node;
}

function setup() {
  const document = fakeDocument();
  const notes = fakeNode('div');
  notes.hidden = true;
  return { document, notes, view: createSongView({ document, notes }) };
}

test('the notes are written only when their text changes, and hidden when there are no lines', () => {
  const { document, notes, view } = setup();
  assert.equal(notes.hidden, true);
  view.showNotes(['The play() helper was changed, so the page cannot vouch for what plays.']);
  assert.equal(notes.hidden, false);
  assert.deepEqual(notes.children.map((node) => [node.className, node.textContent]), [['song-note', 'The play() helper was changed, so the page cannot vouch for what plays.']]);
  const created = document.created;
  const replaced = notes.replaced;
  const firstNode = notes.children[0];
  view.showNotes(['The play() helper was changed, so the page cannot vouch for what plays.']);
  assert.equal(document.created, created, 'no node is created for the same text');
  assert.equal(notes.replaced, replaced, 'the children are not replaced for the same text');
  assert.equal(notes.children[0], firstNode);
  view.showNotes(['first line.', { text: 'second line.', kind: 'check-failed' }]);
  assert.deepEqual(notes.children.map((node) => [node.textContent, node.getAttribute('data-kind')]), [['first line.', null], ['second line.', 'check-failed']]);
  view.showNotes([]);
  assert.equal(notes.hidden, true);
  assert.equal(notes.children.length, 0);
  const replacedAfterClear = notes.replaced;
  view.clearNotes();
  assert.equal(notes.replaced, replacedAfterClear, 'clearing empty notes changes nothing');
});

test('the notes view offers the notes and nothing else, and its source builds text only with no listener or focus stop', () => {
  const { view } = setup();
  assert.deepEqual(Object.keys(view).sort(), ['clearNotes', 'showNotes']);
  const code = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|addEventListener|tabindex|\.focus\(/);
  assert.doesNotMatch(code, /createElement\('(button|a|input|select|textarea)'\)/);
});
