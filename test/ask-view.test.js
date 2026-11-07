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
  const motifResults = [];
  const view = createAskView({
    document: doc,
    onMotifResult: (result) => motifResults.push(result),
    send: (frame) => sent.push(frame),
    reportError: (text) => errors.push(text),
    clearError: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 1000,
    requests,
  });
  view.setConnected('connected');
  return { doc, field, box, sent, view, requests, errors, motifResults, partsAsk: byId.get('parts-ask'), partsLine: byId.get('parts-ask-status') };
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

const MOTIF = { source: 'drawn', cycles: 1, grid: 'quarter', notes: 1, phrase: 'note("c4 ~ ~ ~").velocity("0.8 ~ ~ ~")' };

test('sendMotif sends one ask frame with the motif last, hands the request to the tracker and returns its id', () => {
  const { view, sent, requests, errors } = askBoxOnFakePage();
  view.setCurrentVersion(7);
  const result = view.sendMotif({ words: '  Add this motif to the music.  ', motif: MOTIF });
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]), ['type', 'id', 'text', 'context', 'chip', 'current', 'motif']);
  assert.equal(sent[0].type, 'ask');
  assert.equal(sent[0].text, 'Add this motif to the music.');
  assert.deepEqual(sent[0].context, { kind: 'motif' });
  assert.equal(sent[0].chip, 'Motif \u00B7 drawn \u00B7 1 cycle \u00B7 1 note');
  assert.equal(sent[0].current, 7);
  assert.deepEqual(sent[0].motif, MOTIF);
  assert.deepEqual(result, { id: sent[0].id });
  assert.deepEqual(requests.handed, [{ id: sent[0].id, text: 'Add this motif to the music.', chip: sent[0].chip }]);
  assert.deepEqual(errors, []);
  assert.equal(view.motifPending(), true);
});

test('a motif send never touches the Ask box: its field, its draft and its message stay as they were', () => {
  const { view, field, box } = askBoxOnFakePage();
  field.value = 'a draft in the Ask box';
  view.sendMotif({ words: 'Add this motif to the music.', motif: MOTIF });
  assert.equal(field.value, 'a draft in the Ask box');
  assert.equal(box.hidden, true);
  view.onServerMessage({ type: 'ask-result', id: 'someone-else', status: 'received' });
  assert.equal(field.value, 'a draft in the Ask box');
});

test('the server saying a motif request arrived frees the send and tells the page', () => {
  const { view, sent, motifResults } = askBoxOnFakePage();
  view.sendMotif({ words: 'Add this motif to the music.', motif: MOTIF });
  const id = sent[0].id;
  view.onServerMessage({ type: 'ask-received', ids: ['another', id] });
  assert.equal(view.motifPending(), false);
  assert.deepEqual(motifResults, [{ status: 'received' }]);
  view.sendMotif({ words: 'Again.', motif: MOTIF });
  view.onServerMessage({ type: 'ask-result', id: sent[1].id, status: 'received' });
  assert.equal(view.motifPending(), false);
  assert.deepEqual(motifResults, [{ status: 'received' }, { status: 'received' }]);
});

test('a motif request the server holds for Claude frees the send and tells the page it waits; its later hand-over says nothing new', () => {
  const { view, sent, motifResults } = askBoxOnFakePage();
  view.sendMotif({ words: 'Add this motif to the music.', motif: MOTIF });
  const first = sent[0].id;
  view.onServerMessage({ type: 'ask-result', id: first, status: 'waiting', waiting: 1 });
  assert.equal(view.motifPending(), false, 'the server has it: it is no longer on its way');
  assert.deepEqual(motifResults, [{ status: 'waiting' }]);
  // Another motif may go while the first waits, and it is the one on its way until the server answers it.
  assert.equal(view.sendMotif({ words: 'Again.', motif: MOTIF }).id !== undefined, true);
  assert.equal(view.motifPending(), true);
  assert.deepEqual(view.sendMotif({ words: 'Once more.', motif: MOTIF }), { refused: 'pending' });
  // The first one handed over to Claude does not free the second, which has not reached the server yet.
  view.onServerMessage({ type: 'ask-received', ids: [first] });
  assert.equal(view.motifPending(), true);
  assert.deepEqual(motifResults, [{ status: 'waiting' }]);
  view.onServerMessage({ type: 'ask-result', id: sent[1].id, status: 'waiting', waiting: 2 });
  assert.equal(view.motifPending(), false);
  assert.deepEqual(motifResults, [{ status: 'waiting' }, { status: 'waiting' }]);
});

// A phrase of exactly the longest length that still has the phrase shape, so only the rest of the request can push the line over.
const WIDE_PHRASE = (() => {
  const room = 8000 - 'note("").velocity("")'.length;
  return `note("${'~'.repeat(Math.ceil(room / 2))}").velocity("${'~'.repeat(Math.floor(room / 2))}")`;
})();

test('sendMotif refuses without sending when the page is not connected, and a send already on its way', () => {
  const { view, sent, requests } = askBoxOnFakePage();
  view.setConnected('disconnected');
  assert.deepEqual(view.sendMotif({ words: 'Add it.', motif: MOTIF }), { refused: 'disconnected' });
  view.setConnected('connected');
  const first = view.sendMotif({ words: 'Add it.', motif: MOTIF });
  assert.equal(sent.length, 1);
  assert.deepEqual(view.sendMotif({ words: 'Again.', motif: MOTIF }), { refused: 'pending' });
  assert.equal(sent.length, 1);
  assert.equal(requests.handed.length, 1);
  assert.equal(view.motifPending(), true, 'the first send is still the pending one');
  view.onServerMessage({ type: 'ask-received', ids: [first.id] });
  assert.equal(view.sendMotif({ words: 'Again.', motif: MOTIF }).id !== undefined, true, 'once it arrived the next may go');
});

test('sendMotif refuses empty words and words over the limit, leaving the pending state as it was', () => {
  const { view, sent } = askBoxOnFakePage();
  assert.deepEqual(view.sendMotif({ words: '   ', motif: MOTIF }), { refused: 'empty-words' });
  assert.deepEqual(view.sendMotif({ words: 'x'.repeat(2001), motif: MOTIF }), { refused: 'words-too-long', length: 2001, max: 2000 });
  assert.equal(view.sendMotif({ words: `  ${'x'.repeat(2000)}  `, motif: MOTIF }).id !== undefined, true, 'the limit counts the trimmed words');
  assert.equal(sent.length, 1);
});

test('sendMotif refuses a line over 8192 bytes with its byte count and never shortens the phrase', () => {
  const { view, sent, requests } = askBoxOnFakePage();
  const wide = { source: 'played', cycles: 8, grid: 'sixteenth-triplet', notes: 190, phrase: WIDE_PHRASE };
  const refused = view.sendMotif({ words: 'Add this motif to the music.', motif: wide });
  assert.equal(refused.refused, 'too-big');
  assert.equal(refused.max, 8192);
  assert.ok(refused.bytes > 8192);
  assert.deepEqual(Object.keys(refused).sort(), ['bytes', 'max', 'refused']);
  assert.equal(sent.length, 0);
  assert.equal(requests.handed.length, 0);
  assert.equal(view.motifPending(), false);
  // A phrase that fits goes whole.
  const fits = { ...wide, phrase: 'note("c4 ~ ~ ~").velocity("0.8 ~ ~ ~")' };
  assert.equal(view.sendMotif({ words: 'Add this motif to the music.', motif: fits }).id !== undefined, true);
  assert.equal(sent[0].motif.phrase, fits.phrase);
});

test('the byte count of the too-big refusal is the length of the line the server would build', async () => {
  const { requestLine } = await import('../dist/ask.js');
  const { view } = askBoxOnFakePage();
  const wide = { source: 'played', cycles: 8, grid: 'sixteenth-triplet', notes: 190, phrase: WIDE_PHRASE };
  const refused = view.sendMotif({ words: 'Add this motif to the music.', motif: wide });
  const line = requestLine({
    id: `ask-${(1000).toString(36)}-1`,
    text: 'Add this motif to the music.',
    context: { kind: 'motif' },
    chip: 'Motif · played · 8 cycles · 190 notes',
    current: null,
    motif: wide,
  });
  assert.equal(refused.bytes, Buffer.byteLength(line, 'utf8'));
});

test('a motif whose phrase is over 8000 characters is refused as too big with its line size, never thrown', async () => {
  const { requestLine } = await import('../dist/ask.js');
  const scratch = await import('../page/scratch-model.js');
  const { view, sent, requests } = askBoxOnFakePage();
  // Eight cycles on the sixteenth-triplet grid with 12 notes sounding together, each at its own velocity, so each is its own lane.
  let motif = scratch.setCycles(scratch.setGrid(scratch.emptyMotif(), 'sixteenth-triplet').motif, 8).motif;
  const step = scratch.gridOf('sixteenth-triplet').unit;
  for (let index = 0; index < 12; index += 1) {
    motif = scratch.placeNote(motif, { pitch: 48 + index, start: 0, length: step, velocity: 11 + index * 5 }).motif;
  }
  const request = scratch.motifRequest(motif, null);
  assert.ok(request.phrase.length > 8000, `the phrase is ${request.phrase.length} characters`);
  const refused = view.sendMotif({ words: 'Add this motif to the music.', motif: request });
  assert.deepEqual(Object.keys(refused).sort(), ['bytes', 'max', 'refused']);
  assert.equal(refused.refused, 'too-big');
  assert.equal(refused.max, 8192);
  const line = requestLine({
    id: `ask-${(1000).toString(36)}-1`,
    text: 'Add this motif to the music.',
    context: { kind: 'motif' },
    chip: 'Motif · drawn · 8 cycles · 12 notes',
    current: null,
    motif: request,
  });
  assert.equal(refused.bytes, Buffer.byteLength(line, 'utf8'));
  assert.ok(refused.bytes > 8192);
  assert.equal(scratch.sendRefusalText(refused), `Not sent: the request would be ${refused.bytes} bytes, 8192 at most. Fewer cycles, a coarser grid, fewer notes sounding together or shorter words make it smaller.`);
  assert.equal(sent.length, 0);
  assert.equal(requests.handed.length, 0);
  assert.equal(view.motifPending(), false);
});

test('a server refusal of the motif request tells the page and never arms the Ask box or touches its draft', () => {
  const { view, sent, field, doc, motifResults, errors } = askBoxOnFakePage();
  field.value = 'a draft in the Ask box';
  view.sendMotif({ words: 'Add it.', motif: MOTIF });
  view.onServerMessage({ type: 'ask-result', id: sent[0].id, status: 'refused', reason: 'rate-limit' });
  assert.deepEqual(motifResults, [{ status: 'refused', text: ASK_COPY.rateLimit }]);
  assert.equal(view.motifPending(), false);
  assert.equal(field.value, 'a draft in the Ask box');
  assert.equal(doc.getElementById('ask-message').hidden, true, 'no not-sent message in the Ask box');
  assert.deepEqual(errors, [], 'the strip says it; the top bar keeps quiet');
  // The next Ask box request is as it always was: its own refusal does arm the box.
  view.open({ kind: 'session' }, { x: 1, y: 1 });
  field.dispatch('keydown', { key: 'Enter' });
  view.onServerMessage({ type: 'ask-result', id: sent[1].id, status: 'refused', reason: 'queue-full' });
  assert.equal(doc.getElementById('ask-message').textContent, ASK_COPY.notSent);
});

test('a motif request nobody confirmed tells the page, frees the send and leaves the Ask box alone', () => {
  const { view, sent, field, doc, motifResults, errors } = askBoxOnFakePage();
  field.value = 'a draft in the Ask box';
  view.sendMotif({ words: 'Add it.', motif: MOTIF });
  view.notConfirmed(sent[0].id);
  assert.deepEqual(motifResults, [{ status: 'not-confirmed' }]);
  assert.equal(view.motifPending(), false);
  assert.equal(field.value, 'a draft in the Ask box');
  assert.equal(doc.getElementById('ask-message').hidden, true);
  assert.deepEqual(errors, []);
});

test('losing the connection clears a motif send that was on its way', () => {
  const { view } = askBoxOnFakePage();
  view.sendMotif({ words: 'Add it.', motif: MOTIF });
  assert.equal(view.motifPending(), true);
  view.setConnected('disconnected');
  assert.equal(view.motifPending(), false);
  assert.equal(view.isConnected(), false);
  view.setConnected('connected');
  assert.equal(view.isConnected(), true);
});
