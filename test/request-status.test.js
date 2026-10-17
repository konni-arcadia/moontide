// The request status board on its own: forward-only states, the bound, and who is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ASK_CONTEXT_LENGTH } from '../dist/protocol.js';
import {
  FINAL_REQUEST_STATES,
  MAX_BOARD_REQUESTS,
  REQUEST_STATES,
  RequestStatusBoard,
  cleanAnswerText,
  requestRank,
} from '../dist/request-status.js';

function makeBoard(options = {}) {
  const sent = [];
  const board = new RequestStatusBoard({ send: (conn, message) => sent.push({ conn, message }), ...options });
  return { board, sent };
}

const page = (name) => ({ name });

test('the states rank in order and every final state ranks the same', () => {
  const order = ['sent', 'waiting', 'received', 'started', 'line'];
  for (let i = 0; i < order.length; i++) {
    assert.equal(requestRank(order[i]), i);
  }
  for (const state of FINAL_REQUEST_STATES) {
    assert.equal(requestRank(state), 5, state);
  }
  for (const state of REQUEST_STATES) {
    assert.notEqual(requestRank(state), undefined, state);
    assert.ok(requestRank(state) >= 0, state);
  }
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      assert.ok(requestRank(order[a]) < requestRank(order[b]), `${order[a]} < ${order[b]}`);
    }
  }
  assert.deepEqual([...FINAL_REQUEST_STATES].sort(), ['answered', 'applied', 'canceled', 'declined', 'failed', 'replaced']);
});

test('a state never goes back, never repeats and never leaves a final state', () => {
  const { board, sent } = makeBoard();
  const origin = page('a');
  board.opened('r1', origin, { queued: false, text: 'a request', chip: 'Whole session' });
  board.delivered(['r1']);
  board.noteToolCall();
  assert.equal(sent.length, 1);
  board.noteToolCall();
  assert.equal(sent.length, 1, 'started is sent once');

  board.line('r1', 'bar');
  board.line('r1', 'bar');
  assert.equal(sent.length, 2, 'line is sent once');
  board.noteToolCall();
  board.delivered(['r1']);
  board.waiting('r1');
  assert.equal(sent.length, 2, 'nothing lower than line is sent');

  board.applied('r1', 7);
  assert.deepEqual(sent.at(-1).message, { type: 'ask-status', id: 'r1', state: 'applied', version: 7 });
  const count = sent.length;
  board.failed('r1', 'late');
  board.replaced('r1');
  board.canceled('r1');
  board.applied('r1', 8);
  board.line('r1', 'phrase');
  assert.equal(sent.length, count, 'a final state is never replaced');
});

test('noteToolCall moves only the requests that were handed to Claude', () => {
  const { board, sent } = makeBoard();
  const origin = page('a');
  board.opened('sent-one', origin, { queued: false, text: 'a request', chip: 'Whole session' });
  board.opened('waiting-one', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  board.opened('received-one', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  board.delivered(['received-one']);
  board.noteToolCall();
  assert.deepEqual(
    sent.map((entry) => entry.message),
    [{ type: 'ask-status', id: 'received-one', state: 'started' }],
  );
});

test('the 51st request drops the first one: the board is bound at 50', () => {
  const { board } = makeBoard();
  const origin = page('a');
  for (let i = 1; i <= MAX_BOARD_REQUESTS; i++) {
    board.opened(`r${i}`, origin, { queued: true, text: 'a request', chip: 'Whole session' });
  }
  assert.ok(board.isOpen('r1'));
  board.opened(`r${MAX_BOARD_REQUESTS + 1}`, origin, { queued: true, text: 'a request', chip: 'Whole session' });
  assert.equal(board.isOpen('r1'), false, 'the oldest row is gone');
  assert.ok(board.isOpen('r2'));
  assert.ok(board.isOpen(`r${MAX_BOARD_REQUESTS + 1}`));
  let open = 0;
  for (let i = 1; i <= MAX_BOARD_REQUESTS + 1; i++) {
    if (board.isOpen(`r${i}`)) open += 1;
  }
  assert.equal(open, MAX_BOARD_REQUESTS);
});

test('the bound drops the oldest finished row first, never an open one while a finished one is left', () => {
  const { board } = makeBoard();
  const origin = page('a');
  board.opened('open-old', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  for (let i = 1; i <= MAX_BOARD_REQUESTS; i++) {
    board.opened(`done${i}`, origin, { queued: true, text: 'a request', chip: 'Whole session' });
    board.applied(`done${i}`, i);
  }
  assert.ok(board.isOpen('open-old'), 'the open request is kept');
  const ids = board.snapshotFor(origin).map((row) => row.id);
  assert.equal(ids.length, MAX_BOARD_REQUESTS);
  assert.ok(!ids.includes('done1'), 'the oldest finished row went');
  assert.ok(ids.includes('done2'));
  assert.equal(board.closed('open-old', 'answered', 'Yes.'), true, 'it can still be closed');
});

test('has holds open and finished rows, and a reused id never resets a row', () => {
  const { board } = makeBoard();
  const origin = page('a');
  board.opened('r1', origin, opening('first'));
  board.delivered(['r1']);
  assert.equal(board.has('r1'), true);
  assert.equal(board.has('nobody'), false);
  assert.throws(() => board.opened('r1', page('b'), opening('again')), /already on the request board/);
  assert.deepEqual(board.snapshotFor(origin).map((row) => [row.id, row.text, row.state]), [['r1', 'first', 'received']]);
  board.applied('r1', 1);
  assert.equal(board.has('r1'), true, 'a finished row is still on the board');
});

test('isOpen is false for an unknown id and for every final state', () => {
  const finals = {
    applied: (board, id) => board.applied(id, 1),
    failed: (board, id) => board.failed(id, 'why'),
    replaced: (board, id) => board.replaced(id),
    canceled: (board, id) => board.canceled(id),
  };
  const { board } = makeBoard();
  assert.equal(board.isOpen('nobody'), false);
  for (const [state, finish] of Object.entries(finals)) {
    board.opened(state, page('a'), { queued: true, text: 'a request', chip: 'Whole session' });
    assert.ok(board.isOpen(state), `${state} is open before it ends`);
    finish(board, state);
    assert.equal(board.isOpen(state), false, state);
  }
});

test('each state is sent as its own message to the page that asked', () => {
  const { board, sent } = makeBoard();
  const origin = page('a');
  board.opened('r1', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  board.line('r1', 'phrase');
  board.failed('r1', 'bad code');
  board.opened('r2', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  board.replaced('r2');
  board.opened('r3', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  board.canceled('r3');
  assert.deepEqual(
    sent.map((entry) => entry.message),
    [
      { type: 'ask-status', id: 'r1', state: 'line', at: 'phrase' },
      { type: 'ask-status', id: 'r1', state: 'failed', reason: 'bad code' },
      { type: 'ask-status', id: 'r2', state: 'replaced' },
      { type: 'ask-status', id: 'r3', state: 'canceled' },
    ],
  );
  assert.ok(sent.every((entry) => entry.conn === origin));
});

test('once the page has gone the board keeps the state and sends nothing', () => {
  const { board, sent } = makeBoard();
  const origin = page('a');
  const other = page('b');
  board.opened('r1', origin, { queued: true, text: 'a request', chip: 'Whole session' });
  board.opened('r2', other, { queued: true, text: 'a request', chip: 'Whole session' });
  board.pageGone(origin);
  board.delivered(['r1', 'r2']);
  board.noteToolCall();
  assert.deepEqual(
    sent.map((entry) => [entry.conn, entry.message.id]),
    [[other, 'r2']],
    'only the page that is still there is told',
  );
  board.applied('r1', 3);
  assert.equal(board.isOpen('r1'), false, 'the state moved although nothing was sent');
  assert.equal(sent.length, 1);
});

test('waiting after received changes nothing', () => {
  const { board, sent } = makeBoard();
  board.opened('r1', page('a'), { queued: false, text: 'a request', chip: 'Whole session' });
  board.delivered(['r1']);
  board.waiting('r1');
  board.noteToolCall();
  assert.equal(sent.length, 1, 'the request still moves to started');
  assert.equal(sent[0].message.state, 'started');
});

const opening = (text, chip = 'Whole session') => ({ queued: true, text, chip });

test('closed answers an open request and refuses one that is not open', () => {
  const { board, sent } = makeBoard();
  const origin = page('a');
  board.opened('r1', origin, opening('x'));
  assert.equal(board.closed('r1', 'answered', 'It plays four tracks.'), true);
  assert.deepEqual(sent.at(-1).message, { type: 'ask-status', id: 'r1', state: 'answered', answer: 'It plays four tracks.' });
  assert.equal(board.isOpen('r1'), false);
  const count = sent.length;
  assert.equal(board.closed('r1', 'declined', 'No.'), false, 'a closed request is not open');
  assert.equal(board.closed('nobody', 'answered', 'No.'), false);
  assert.equal(sent.length, count);
  board.opened('r2', origin, opening('y'));
  assert.equal(board.closed('r2', 'declined', 'Not possible.'), true);
  assert.deepEqual(sent.at(-1).message, { type: 'ask-status', id: 'r2', state: 'declined', answer: 'Not possible.' });
});

test('cleanAnswerText turns each run of whitespace and control characters into one space', () => {
  assert.equal(cleanAnswerText('  a\n\n b\t\u0007c\u202Ed\u2066e\u2029f\u0085g  '), 'a b c d e f g');
  assert.equal(cleanAnswerText(' \n\u0007 '), '');
});

test('the board keeps the start of the text, cut by code point with an ellipsis, and the chip', () => {
  const { board } = makeBoard();
  const origin = page('a');
  board.opened('short', origin, opening('make it slower', 'Bass'));
  const long = 'a'.repeat(MAX_ASK_CONTEXT_LENGTH - 1) + '\u{1F3B5}' + 'tail';
  board.opened('long', origin, opening(long));
  const [shortRow, longRow] = board.snapshotFor(origin);
  assert.equal(shortRow.text, 'make it slower');
  assert.equal(shortRow.chip, 'Bass');
  assert.equal(longRow.text, 'a'.repeat(MAX_ASK_CONTEXT_LENGTH - 1) + '\u{1F3B5}' + '\u2026', 'cut after 200 code points, a surrogate pair kept whole');
  assert.equal(Array.from(longRow.text).length, MAX_ASK_CONTEXT_LENGTH + 1);
});

test('snapshotFor lists the requests of gone pages and of the asking page, oldest first, with their ages and details', () => {
  let clock = 1000;
  const { board } = makeBoard({ now: () => clock });
  const p1 = page('p1');
  const p2 = page('p2');
  const p3 = page('p3');
  board.opened('m', p1, opening('first', 'A'));
  clock += 5000;
  board.opened('n', p1, opening('second', 'B'));
  board.delivered(['n']);
  clock += 2000;
  board.applied('n', 7);
  clock += 3000;
  board.opened('o', p3, opening('other tab', 'C'));
  board.opened('l', p1, opening('line one', 'D'));
  board.line('l', 'phrase');
  board.opened('f', p1, opening('bad one', 'E'));
  board.failed('f', 'Unexpected token');
  board.opened('a', p1, opening('question', 'F'));
  board.closed('a', 'declined', 'No can do.');
  board.pageGone(p1);

  clock += 1000;
  assert.deepEqual(board.snapshotFor(p2), [
    { id: 'm', text: 'first', chip: 'A', state: 'waiting', openedAgoMs: 11000, newsAgoMs: 11000 },
    { id: 'n', text: 'second', chip: 'B', state: 'applied', openedAgoMs: 6000, newsAgoMs: 4000, version: 7 },
    { id: 'l', text: 'line one', chip: 'D', state: 'line', openedAgoMs: 1000, newsAgoMs: 1000, at: 'phrase' },
    { id: 'f', text: 'bad one', chip: 'E', state: 'failed', openedAgoMs: 1000, newsAgoMs: 1000, reason: 'Unexpected token' },
    { id: 'a', text: 'question', chip: 'F', state: 'declined', openedAgoMs: 1000, newsAgoMs: 1000, answer: 'No can do.' },
  ]);
  // p3's own request is never listed to p2, and p3 gets nothing of p1's now that p2 adopted them.
  assert.deepEqual(board.snapshotFor(p3).map((row) => row.id), ['o']);
});

test('a request adopted by a reloaded page sends its next state to that page', () => {
  const { board, sent } = makeBoard();
  const p1 = page('p1');
  const p2 = page('p2');
  board.opened('m', p1, opening('first'));
  board.pageGone(p1);
  board.snapshotFor(p2);
  board.closed('m', 'answered', 'Yes.');
  assert.deepEqual(sent.map((entry) => entry.conn), [p2]);
});
