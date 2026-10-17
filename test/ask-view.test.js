import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskView } from '../page/ask-view.js';
import { ASK_COPY } from '../page/ask.js';
import { fakeDocument } from './fake-document.js';

// The Ask box on a fake page: the ids the view looks up, a field that holds a value, and a list of what was sent.
function askBoxOnFakePage() {
  const doc = fakeDocument();
  // The help popover builds its paragraphs from text nodes.
  doc.createTextNode = (text) => {
    const node = doc.createElement('#text');
    node.textContent = text;
    return node;
  };
  doc.defaultView.addEventListener = () => {};
  const root = doc.createElement('div');
  doc.markup.push(root);
  const byId = new Map();
  const make = (id, parent = root, tagName = 'div') => {
    const node = doc.createElement(tagName);
    node.id = id;
    parent.appendChild(node);
    byId.set(id, node);
    return node;
  };
  const box = make('ask-box');
  box.hidden = true;
  make('ask-context-chip', box);
  make('ask-current-chip', box);
  const field = make('ask-field', box, 'textarea');
  field.value = '';
  field.scrollHeight = 20;
  field.setSelectionRange = () => {};
  field.select = () => {};
  make('ask-message', box);
  make('ask-hint', box);
  for (const id of ['parts-ask', 'parts-ask-status', 'page-requests', 'page-requests-state', 'page-requests-info', 'page-requests-help']) make(id);
  const sent = [];
  const errors = [];
  // The tracker as far as the box uses it: what it was handed, and the rows the Parts line may read.
  const requests = {
    handed: [],
    rows: [],
    sent(id, info) {
      this.handed.push({ id, ...info });
    },
    serverMessage() {},
    model() {
      return { rows: this.rows, recent: [] };
    },
  };
  const view = createAskView({
    document: doc,
    send: (frame) => sent.push(frame),
    reportError: (text) => errors.push(text),
    clearError: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 1000,
    requests,
  });
  view.setConnected('connected');
  return { doc, field, box, sent, view, requests, errors, partsAsk: byId.get('parts-ask'), partsLine: byId.get('parts-ask-status') };
}

test('Enter in the Ask field sends the text once; a repeated Enter sends nothing', () => {
  const { field, box, sent, view } = askBoxOnFakePage();
  view.open({ kind: 'session' }, { x: 10, y: 10 }, { prefill: 'Raise this note by 2 semitones.' });
  assert.equal(view.isOpen(), true);
  assert.equal(sent.length, 0);
  // The auto-repeat of the press that opened the box lands in the field: it is swallowed, and the box stays.
  const held = field.dispatch('keydown', { key: 'Enter', repeat: true });
  assert.equal(held.defaultPrevented, true);
  assert.equal(held.stopped, true);
  assert.equal(sent.length, 0, 'a held Enter sends nothing');
  assert.equal(box.hidden, false, 'a held Enter leaves the box open');
  assert.equal(field.value, 'Raise this note by 2 semitones.');
  // A fresh press sends it.
  field.dispatch('keydown', { key: 'Enter' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ask');
  assert.equal(sent[0].text, 'Raise this note by 2 semitones.');
  assert.equal(box.hidden, true);
});

test('a held Enter does not send an older draft either', () => {
  const { field, sent, view } = askBoxOnFakePage();
  field.value = 'an old draft';
  view.open({ kind: 'session' }, { x: 10, y: 10 });
  field.dispatch('keydown', { key: 'Enter', repeat: true });
  field.dispatch('keydown', { key: 'Enter', repeat: true });
  assert.equal(sent.length, 0);
  assert.equal(field.value, 'an old draft');
});

test('a request nobody confirmed brings the draft back and says so on the error line', () => {
  const { field, view, errors } = askBoxOnFakePage();
  view.open({ kind: 'session' }, { x: 10, y: 10 }, { prefill: 'Make it softer.' });
  field.dispatch('keydown', { key: 'Enter' });
  view.notConfirmed('ask-gone');
  assert.deepEqual(errors, [ASK_COPY.didNotConfirm]);
});

test('the Parts button waits with the state phrase of its request row, and comes back when the request was not confirmed', () => {
  const { view, requests, partsAsk, partsLine } = askBoxOnFakePage();
  view.setPartsAvailable(true);
  assert.equal(partsAsk.disabled, false);
  partsAsk.dispatch('click', {});
  const id = requests.handed[0].id;
  assert.equal(requests.handed.length, 1);
  assert.equal(partsAsk.disabled, true, 'the button waits for its request');
  assert.equal(partsLine.hidden, true, 'no row yet, no line');
  requests.rows = [{ id: 'another', phrase: 'Received' }, { id, phrase: "Waiting for Claude's next action" }];
  view.refreshPartsLine();
  assert.equal(partsLine.hidden, false);
  assert.equal(partsLine.textContent, "Waiting for Claude's next action");
  requests.rows = [{ id, phrase: 'Claude has started on it' }];
  view.refreshPartsLine();
  assert.equal(partsLine.textContent, 'Claude has started on it');
  view.notConfirmed(id);
  assert.equal(partsAsk.disabled, false, 'an unconfirmed canned request releases the button');
  assert.equal(partsLine.hidden, true);
});
