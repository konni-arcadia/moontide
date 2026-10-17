// The Requests chip and panel on a fake page (page/request-status-view.js): structure and ARIA, write-on-change, the detail of a
// row, the Recent group, when the panel opens and folds by itself, what holds a row, Esc and focus, the keyboard, the polite spoken
// line and the one-second time. The tracker is the real one (page/request-status.js) on a fake clock wherever a sequence
// matters; the live page is proved by `npm run probe:page`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequestStatusView } from '../page/request-status-view.js';
import { FINISHED_SHOWN_MS, REQUEST_STATUS_COPY, createRequestTracker, joinLive } from '../page/request-status.js';
import { all, fakeDocument } from './fake-document.js';
import { makeFakeTime } from './clock-fakes.js';

const VIEW_PATH = new URL('../page/request-status-view.js', import.meta.url);

/** The markup the page holds for the view, a real tracker on a fake clock, and the view wired as main.js wires it. */
function setup() {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  doc.markup.push(root);
  const make = (tagName, id, parent = root, className = '') => {
    const node = doc.createElement(tagName);
    node.id = id;
    node.className = className;
    parent.appendChild(node);
    return node;
  };
  const toggle = make('button', 'requests-toggle');
  toggle.hidden = true;
  make('span', '', toggle, 'rq-word');
  const count = make('span', '', toggle, 'rq-count');
  count.hidden = true;
  const panel = make('div', 'requests-panel');
  panel.hidden = true;
  const live = make('span', 'requests-live');
  const elsewhere = make('button', 'elsewhere');

  const time = makeFakeTime();
  // The view's own timers, apart from the tracker's: the tests count them.
  const viewTimers = new Set();
  const delays = [];
  const opened = [];
  const holds = [];
  const tracker = createRequestTracker({
    now: time.perfNow,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onChange: () => view.render(tracker.model()),
  });
  const view = createRequestStatusView({
    document: doc,
    now: time.perfNow,
    setTimer: (fn, ms) => {
      delays.push(ms);
      const id = time.setTimer(() => {
        viewTimers.delete(id);
        fn();
      }, ms);
      viewTimers.add(id);
      return id;
    },
    clearTimer: (id) => {
      viewTimers.delete(id);
      time.clearTimer(id);
    },
    onOpen: () => opened.push({ panelHidden: panel.hidden }),
    onHold: (id, held) => {
      holds.push([id, held]);
      tracker.setHeld(id, held);
    },
    takeLive: () => tracker.takeLive(),
    getModel: () => tracker.model(),
  });
  // What main.js does when the user sends: the view hears of it before the tracker holds the row.
  const send = (id, text = 'make the drums softer', chip = 'Whole session') => {
    view.noteSend();
    tracker.sent(id, { text, chip });
  };
  return { doc, toggle, count, panel, live, elsewhere, time, tracker, view, viewTimers, delays, opened, holds, send };
}

const rows = (rig) => all(rig.panel, 'rq-row');
const items = (rig) => all(rig.panel, 'rq-item');
const stateOf = (rig, index = 0) => all(rows(rig)[index], 'rq-state')[0];
const received = (id) => ({ type: 'ask-result', id, status: 'received' });
const waiting = (id) => ({ type: 'ask-result', id, status: 'waiting', waiting: 1 });
const applied = (id, version = 7) => ({ type: 'ask-status', id, state: 'applied', version });

test('the chip, the panel and a row are built with the roles, names and links of the contract', () => {
  const rig = setup();
  rig.send('a');
  assert.equal(rig.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(rig.toggle.getAttribute('aria-controls'), 'requests-panel');
  assert.equal(rig.toggle.getAttribute('title'), REQUEST_STATUS_COPY.chipTitle);
  assert.equal(rig.toggle.getAttribute('aria-label'), 'Requests, 1 in flight');
  assert.equal(rig.toggle.hidden, false);
  assert.equal(rig.count.textContent, '1');
  assert.equal(rig.count.getAttribute('aria-hidden'), 'true');
  assert.equal(rig.panel.getAttribute('aria-label'), 'Requests');
  const list = all(rig.panel, 'rq-list')[0];
  assert.equal(list.getAttribute('role'), 'list');
  const [row] = rows(rig);
  assert.equal(row.tagName, 'button');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  const detail = all(rig.panel, 'rq-detail')[0];
  assert.ok(detail.id !== '', 'the detail has an id');
  assert.equal(row.getAttribute('aria-controls'), detail.id);
  assert.equal(detail.hidden, true);
  assert.equal(all(row, 'rq-mark')[0].getAttribute('aria-hidden'), 'true');
  assert.equal(all(row, 'rq-time')[0].getAttribute('aria-hidden'), 'true', 'the time of a row in flight is out of its name');
  assert.equal(all(rig.panel, 'rq-recent')[0].hidden, true, 'no Recent group while nothing is in it');
});

test('the Recent header is a button named Recent requests, {n}, showing Recent · {n} and a folded chevron that turns when it opens', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(applied('a'));
  rig.time.advance(FINISHED_SHOWN_MS);
  const [head] = all(rig.panel, 'rq-recent-head');
  assert.equal(head.tagName, 'button');
  assert.equal(head.getAttribute('aria-label'), 'Recent requests, 1');
  assert.equal(head.textContent.startsWith('Recent · 1'), true);
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  const body = all(rig.panel, 'rq-recent-body')[0];
  assert.equal(head.getAttribute('aria-controls'), body.id);
  assert.equal(body.hidden, true);
  const chevron = all(head, 'rq-chevron')[0];
  assert.equal(chevron.getAttribute('aria-hidden'), 'true');
  assert.equal(chevron.textContent, REQUEST_STATUS_COPY.recentFolded);
  head.dispatch('click', { detail: 1 });
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hidden, false);
  assert.equal(chevron.textContent, REQUEST_STATUS_COPY.recentOpen);
  assert.equal(all(body, 'rq-row').length, 1, 'the finished request is a row of the group');
  head.dispatch('click', { detail: 1 });
  assert.equal(body.hidden, true);
});

test('Recent is folded by default and is never opened by itself, even when a row moves into it while the panel is open', () => {
  const rig = setup();
  rig.send('a');
  rig.send('b');
  rig.tracker.serverMessage(applied('a'));
  rig.time.advance(FINISHED_SHOWN_MS);
  assert.equal(rig.view.isOpen(), true, 'b is still in flight');
  const head = all(rig.panel, 'rq-recent-head')[0];
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(all(rig.panel, 'rq-recent-body')[0].hidden, true);
});

test('drawing the same model a second time writes nothing', () => {
  const rig = setup();
  rig.send('a', 'a long request that will be cut somewhere after its fortieth character, for sure');
  rig.send('b');
  rig.tracker.serverMessage(applied('b'));
  rows(rig)[1].dispatch('click', { detail: 1 });
  const model = rig.tracker.model();
  rig.view.render(model);
  const before = { writes: rig.doc.writes, created: rig.doc.created };
  rig.view.render(model);
  rig.view.render(model);
  assert.equal(rig.doc.writes, before.writes, 'no text, attribute or hidden flag was written again');
  assert.equal(rig.doc.created, before.created, 'no node was built again');
});

test('a text is written only when it changed: a tick that changes no text writes nothing to the phrase, the text or the mark', () => {
  const rig = setup();
  rig.send('a');
  const state = stateOf(rig);
  const text = all(rows(rig)[0], 'rq-text')[0];
  const mark = all(rows(rig)[0], 'rq-mark')[0];
  const before = [state.writes, text.writes, mark.writes];
  rig.time.advance(3000);
  assert.deepEqual([state.writes, text.writes, mark.writes], before);
  assert.equal(all(rows(rig)[0], 'rq-time')[0].textContent, '3 s');
});

test('every text of a request, of Claude and of a failure is set as text, and the view has no markup-writing call', () => {
  const rig = setup();
  const hostile = '<img src=x onerror=alert(1)> & "quotes"';
  rig.send('a', hostile, '<b>chip</b>');
  rig.tracker.serverMessage({ type: 'ask-status', id: 'a', state: 'failed', reason: `<script>bad()</script>\nsecond line` });
  rows(rig)[0].dispatch('click', { detail: 1 });
  const detail = all(rig.panel, 'rq-detail')[0];
  const lines = detail.children.map((p) => p.textContent);
  assert.ok(lines.includes(hostile), 'the request is shown as written');
  assert.ok(lines.includes('About: <b>chip</b>'));
  assert.ok(lines.some((line) => line.includes('<script>bad()</script>') && line.includes('second line')));
  assert.equal(detail.children.every((p) => p.children.length === 0), true, 'a line holds text and no element');
  const source = readFileSync(VIEW_PATH, 'utf8');
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'setInterval']) {
    assert.equal(source.includes(forbidden), false, `the view never uses ${forbidden}`);
  }
});

test('a click on a row opens its detail under it, a second click closes it, and any number may be open', () => {
  const rig = setup();
  rig.send('a', 'first request', 'Lane bass · cycle 12, beat 3');
  rig.send('b', 'second request');
  const [rowB, rowA] = rows(rig);
  const [detailB, detailA] = all(rig.panel, 'rq-detail');
  assert.deepEqual(
    [rowB.getAttribute('aria-controls'), rowA.getAttribute('aria-controls')],
    [detailB.id, detailA.id],
  );
  rowA.dispatch('click', { detail: 1 });
  assert.equal(rowA.getAttribute('aria-expanded'), 'true');
  assert.equal(detailA.hidden, false);
  assert.equal(detailB.hidden, true);
  rowB.dispatch('click', { detail: 1 });
  assert.equal(detailA.hidden, false, 'two details are open');
  assert.equal(detailB.hidden, false);
  rowA.dispatch('click', { detail: 1 });
  assert.equal(rowA.getAttribute('aria-expanded'), 'false');
  assert.equal(detailA.hidden, true);
  assert.equal(detailB.hidden, false);
});

test('the detail has one line per fact: the request, About, and what the state means; the basis and the reason read in their own elements', () => {
  const rig = setup();
  rig.send('a', 'make the drums softer', 'Lane drums · cycle 3');
  rows(rig)[0].dispatch('click', { detail: 1 });
  const detail = all(rig.panel, 'rq-detail')[0];
  const read = () => detail.children.map((p) => [p.tagName, p.className, p.textContent]);
  assert.deepEqual(read(), [
    ['p', 'rq-request', 'make the drums softer'],
    ['p', 'rq-about', 'About: Lane drums · cycle 3'],
    ['p', 'rq-meaning', REQUEST_STATUS_COPY.meanings.sent],
  ]);
  rig.tracker.serverMessage(received('a'));
  rig.tracker.serverMessage({ type: 'ask-status', id: 'a', state: 'started' });
  const basis = detail.children.at(-1);
  assert.equal(basis.className, 'rq-basis');
  assert.equal(basis.textContent, `${REQUEST_STATUS_COPY.basisLead}${REQUEST_STATUS_COPY.startedBasis}`);
  const reason = `first line of the reason\n${'long '.repeat(80)}`;
  rig.tracker.serverMessage({ type: 'ask-status', id: 'a', state: 'failed', reason });
  const last = detail.children.at(-1);
  assert.equal(last.className, 'rq-reason');
  assert.equal(last.textContent, reason, 'the whole reason, not the cut one of the row');
  assert.ok(stateOf(rig).textContent.startsWith('Failed: first line of the reason'));
});

test('the panel opens by itself when the user sends and never moves focus', () => {
  const rig = setup();
  rig.elsewhere.focus();
  const focused = rig.elsewhere.focused;
  assert.equal(rig.view.isOpen(), false);
  rig.send('a');
  assert.equal(rig.view.isOpen(), true);
  assert.equal(rig.panel.hidden, false);
  assert.equal(rig.doc.activeElement, rig.elsewhere, 'focus stayed where it was');
  assert.equal(rig.elsewhere.focused, focused);
  assert.equal(rig.panel.focused + rig.toggle.focused + rows(rig)[0].focused, 0, 'nothing of the view took focus');
});

test('onOpen runs once, right before the panel opens', () => {
  const rig = setup();
  rig.send('a');
  assert.deepEqual(rig.opened, [{ panelHidden: true }]);
  rig.view.close();
  rig.toggle.dispatch('click', { detail: 1 });
  assert.deepEqual(rig.opened, [{ panelHidden: true }, { panelHidden: true }], 'the chip opens it too, and the panel was still folded');
  rig.send('b');
  assert.equal(rig.opened.length, 2, 'a send while the panel is open opens nothing');
});

test('a panel opened by itself folds when nothing is in flight and the last finished row has moved to Recent', () => {
  const rig = setup();
  rig.send('a');
  rig.send('b');
  rig.tracker.serverMessage(applied('a'));
  assert.equal(rig.view.isOpen(), true);
  rig.tracker.serverMessage(applied('b'));
  assert.equal(rig.view.isOpen(), true, 'nothing is in flight, but the finished rows are still listed');
  rig.time.advance(FINISHED_SHOWN_MS - 1);
  assert.equal(rig.view.isOpen(), true);
  rig.time.advance(1);
  assert.equal(rig.view.isOpen(), false, 'the last row moved to Recent');
  assert.equal(rig.panel.hidden, true);
  assert.equal(rig.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(rig.toggle.hidden, false, 'the chip stays, so Recent stays reachable');
});

test('a request in flight keeps a panel opened by itself open for as long as it lasts', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(received('a'));
  rig.time.advance(10 * 60 * 1000);
  assert.equal(rig.view.isOpen(), true);
  assert.equal(stateOf(rig).textContent.startsWith('No change yet'), true, 'quiet is not an end');
});

test('the pointer over the panel keeps it open until the pointer leaves', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(applied('a'));
  rig.panel.dispatch('pointerenter');
  rig.time.advance(FINISHED_SHOWN_MS);
  assert.equal(rig.view.isOpen(), true, 'the row waits under the pointer');
  assert.equal(rows(rig).length, 1);
  rig.panel.dispatch('pointerleave');
  assert.equal(rig.view.isOpen(), false);
});

test('opening the panel with the chip makes it the user\'s: it does not fold by itself', () => {
  const rig = setup();
  rig.send('a');
  rig.view.close();
  rig.toggle.dispatch('click', { detail: 1 });
  assert.equal(rig.view.isOpen(), true);
  rig.tracker.serverMessage(applied('a'));
  rig.time.advance(FINISHED_SHOWN_MS);
  assert.equal(rig.view.isOpen(), true, 'it stays until the user folds it');
  assert.equal(all(rig.panel, 'rq-recent-head')[0].textContent.startsWith('Recent · 1'), true);
});

test('opening a detail or putting focus inside makes it the user\'s', () => {
  const byDetail = setup();
  byDetail.send('a');
  rows(byDetail)[0].dispatch('click', { detail: 1 });
  rows(byDetail)[0].dispatch('click', { detail: 1 });
  byDetail.tracker.serverMessage(applied('a'));
  byDetail.time.advance(FINISHED_SHOWN_MS);
  assert.equal(byDetail.view.isOpen(), true, 'a detail opened and closed again still made it the user\'s');

  const byFocus = setup();
  byFocus.send('a');
  rows(byFocus)[0].focus();
  items(byFocus)[0].dispatch('focusout', { relatedTarget: null });
  byFocus.tracker.serverMessage(applied('a'));
  byFocus.time.advance(FINISHED_SHOWN_MS);
  assert.equal(byFocus.view.isOpen(), true, 'focus was inside once: the panel is the user\'s');
});

test('folded by the user, the panel stays folded through every change until the next send', () => {
  const rig = setup();
  rig.send('a');
  rig.toggle.dispatch('click', { detail: 1 });
  assert.equal(rig.view.isOpen(), false, 'the chip folded it');
  rig.tracker.serverMessage(received('a'));
  rig.tracker.serverMessage(applied('a'));
  assert.equal(rig.view.isOpen(), false);
  rig.send('b');
  assert.equal(rig.view.isOpen(), true, 'a send opens it again');
});

test('a page loaded with a board does not open the panel by itself', () => {
  const rig = setup();
  rig.tracker.serverMessage({
    type: 'ask-board',
    requests: [{ id: 'old', text: 'an earlier request', chip: 'Whole session', state: 'received', openedAgoMs: 5000, newsAgoMs: 1000 }],
  });
  assert.equal(rig.toggle.hidden, false, 'the chip shows what the server holds');
  assert.equal(rig.view.isOpen(), false);
  assert.equal(rig.panel.hidden, true);
  assert.equal(rows(rig).length, 1);
});

test('the chip is hidden while the board is empty and counts the requests in flight, in its name too', () => {
  const rig = setup();
  assert.equal(rig.toggle.hidden, true);
  rig.view.render(rig.tracker.model());
  assert.equal(rig.toggle.hidden, true);
  rig.send('a');
  rig.send('b');
  assert.equal(rig.count.textContent, '2');
  assert.equal(rig.toggle.getAttribute('aria-label'), 'Requests, 2 in flight');
  assert.equal(rig.toggle.getAttribute('data-inflight'), 'true');
  rig.tracker.serverMessage(applied('a'));
  rig.tracker.serverMessage(applied('b'));
  assert.equal(rig.count.hidden, true);
  assert.equal(rig.toggle.getAttribute('aria-label'), 'Requests, none in flight');
  assert.equal(rig.toggle.getAttribute('data-inflight'), 'false');
});

test('a row hold is reported once per change: the pointer, focus and an open detail each keep it', () => {
  const rig = setup();
  rig.send('a');
  const [item] = items(rig);
  const [row] = rows(rig);
  item.dispatch('pointerenter');
  assert.deepEqual(rig.holds, [['a', true]]);
  item.dispatch('pointerenter');
  assert.equal(rig.holds.length, 1, 'a repeat reports nothing');
  row.dispatch('click', { detail: 1 });
  assert.equal(rig.holds.length, 1, 'the open detail joins the pointer');
  item.dispatch('pointerleave');
  assert.equal(rig.holds.length, 1, 'the open detail still holds it');
  row.dispatch('click', { detail: 1 });
  assert.deepEqual(rig.holds, [['a', true], ['a', false]]);
  row.focus();
  assert.deepEqual(rig.holds.at(-1), ['a', true]);
  item.dispatch('focusout', { relatedTarget: null });
  assert.deepEqual(rig.holds.at(-1), ['a', false]);
  assert.equal(rig.holds.length, 4);
});

test('a finished row held by the pointer stays listed past 30 s and moves to Recent when released', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(applied('a'));
  const [item] = items(rig);
  item.dispatch('pointerenter');
  rig.time.advance(FINISHED_SHOWN_MS * 2);
  assert.equal(all(all(rig.panel, 'rq-list')[0], 'rq-row').length, 1);
  assert.equal(all(rig.panel, 'rq-recent')[0].hidden, true);
  item.dispatch('pointerleave');
  assert.equal(all(all(rig.panel, 'rq-list')[0], 'rq-row').length, 0);
  assert.equal(all(rig.panel, 'rq-recent')[0].hidden, false);
});

test('Esc on the chip or inside the panel folds it, returns focus to the chip and goes no further', () => {
  const rig = setup();
  rig.send('a');
  rig.toggle.dispatch('click', { detail: 1 });
  rig.toggle.dispatch('click', { detail: 1 });
  assert.equal(rig.view.isOpen(), true);
  rows(rig)[0].focus();
  const inPanel = rig.panel.dispatch('keydown', { key: 'Escape' });
  assert.equal(inPanel.defaultPrevented, true);
  assert.equal(inPanel.stopped, true, 'the page\'s own Esc rule never hears it');
  assert.equal(rig.view.isOpen(), false);
  assert.equal(rig.doc.activeElement, rig.toggle);

  rig.toggle.dispatch('click', { detail: 1 });
  rig.elsewhere.focus();
  const onChip = rig.toggle.dispatch('keydown', { key: 'Escape' });
  assert.equal(onChip.stopped, true);
  assert.equal(rig.view.isOpen(), false);
  assert.equal(rig.doc.activeElement, rig.toggle);
});

test('Esc with the panel folded is left to the page, and another key is left alone', () => {
  const rig = setup();
  rig.send('a');
  rig.view.close();
  const folded = rig.toggle.dispatch('keydown', { key: 'Escape' });
  assert.equal(folded.stopped, false);
  assert.equal(folded.defaultPrevented, false);
  rig.toggle.dispatch('click', { detail: 1 });
  for (const key of ['a', '1', 'ArrowDown', 'Tab']) {
    const event = rig.panel.dispatch('keydown', { key });
    assert.equal(event.stopped, false, `${key} goes on to the page`);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(rig.view.isOpen(), true);
});

test('a click or a press elsewhere does not fold the panel: the view listens to nothing on the document', () => {
  const rig = setup();
  rig.send('a');
  rig.doc.dispatch('pointerdown', { target: rig.elsewhere });
  rig.doc.dispatch('click', { target: rig.elsewhere });
  rig.elsewhere.dispatch('click', { detail: 1 });
  assert.equal(rig.view.isOpen(), true);
  assert.equal(rig.doc.listeners.size, 0, 'no document listener, so no outside press can fold it');
});

test('a keyboard activation of the chip that opens the panel moves focus to the first row, a pointer click does not', () => {
  const rig = setup();
  rig.send('a');
  rig.send('b');
  rig.view.close();
  rig.elsewhere.focus();
  rig.toggle.dispatch('click', { detail: 1 });
  assert.equal(rig.view.isOpen(), true);
  assert.equal(rig.doc.activeElement, rig.elsewhere, 'a pointer click leaves focus alone');
  rig.view.close();
  rig.toggle.dispatch('click', { detail: 0 });
  assert.equal(rig.doc.activeElement, rows(rig)[0], 'the first row is the newest');
});

test('a keyboard open of a panel with no listed row moves focus to the panel itself', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(applied('a'));
  rig.time.advance(FINISHED_SHOWN_MS);
  assert.equal(rig.view.isOpen(), false);
  rig.toggle.dispatch('click', { detail: 0 });
  assert.equal(rig.view.isOpen(), true);
  assert.equal(rig.doc.activeElement, rig.panel);
});

test('close() folds the panel without moving focus, and the focus return is only for Esc', () => {
  const rig = setup();
  rig.send('a');
  rig.elsewhere.focus();
  rig.view.close();
  assert.equal(rig.view.isOpen(), false);
  assert.equal(rig.doc.activeElement, rig.elsewhere);
  rig.view.open({});
  rig.view.close({ focusChip: true });
  assert.equal(rig.doc.activeElement, rig.toggle);
});

test('the spoken line is always present, never hidden, and the view checks it at the start', () => {
  const rig = setup();
  assert.equal(rig.live.hasAttribute('hidden'), false);
  rig.send('a');
  rig.tracker.serverMessage(received('a'));
  rig.time.advance(5000);
  rig.view.close();
  rig.view.render(rig.tracker.model());
  assert.equal(rig.live.hasAttribute('hidden'), false, 'the live region is never hidden');
  const doc = fakeDocument();
  const root = doc.createElement('div');
  doc.markup.push(root);
  for (const [tag, id] of [['button', 'requests-toggle'], ['div', 'requests-panel'], ['span', 'requests-live']]) {
    const node = doc.createElement(tag);
    node.id = id;
    root.appendChild(node);
    if (id === 'requests-toggle') {
      for (const name of ['rq-word', 'rq-count']) {
        const part = doc.createElement('span');
        part.className = name;
        node.appendChild(part);
      }
    }
    if (id === 'requests-live') node.hidden = true;
  }
  assert.throws(() => createRequestStatusView({ document: doc }), /requests-live|live region/i);
});

test('the first sentence is spoken at once, later ones within the same second are joined, and three at most are spoken then a count', () => {
  const rig = setup();
  rig.send('a', 'first');
  assert.equal(rig.live.textContent, 'Request "first": sent.');
  rig.time.advance(100);
  rig.send('b', 'second');
  rig.send('c', 'third');
  rig.send('d', 'fourth');
  rig.send('e', 'fifth');
  assert.equal(rig.live.textContent, 'Request "first": sent.', 'nothing more is spoken inside the second');
  rig.time.advance(899);
  assert.equal(rig.live.textContent, 'Request "first": sent.');
  rig.time.advance(1);
  const spoken = ['second', 'third', 'fourth', 'fifth'].map((text) => `Request "${text}": sent.`);
  assert.equal(rig.live.textContent, joinLive(spoken));
  assert.ok(rig.live.textContent.endsWith('and 1 more update.'));
});

test('a state change is spoken once, and neither the passing seconds, a failure nor a refusal are', () => {
  const rig = setup();
  rig.send('a', 'first');
  rig.time.advance(1000);
  rig.tracker.serverMessage(received('a'));
  assert.equal(rig.live.textContent, 'Request "first": received.');
  const writes = rig.live.writes;
  rig.time.advance(5000);
  assert.equal(rig.live.writes, writes, 'the elapsed time is never spoken');
  rig.tracker.serverMessage({ type: 'ask-status', id: 'a', state: 'failed', reason: 'bad code' });
  rig.time.advance(2000);
  assert.equal(rig.live.textContent, 'Request "first": received.', 'a failure has its own alert');
  assert.equal(rig.live.writes, writes);
});

test('the time of a row steps once a second as text, from one timer that exists only while a row needs it', () => {
  const rig = setup();
  assert.equal(rig.viewTimers.size, 0, 'no row, no timer');
  rig.send('a');
  assert.equal(rig.viewTimers.size, 1);
  const time = all(rows(rig)[0], 'rq-time')[0];
  assert.equal(time.textContent, '0 s');
  rig.time.advance(999);
  assert.equal(time.textContent, '0 s');
  rig.time.advance(1);
  assert.equal(time.textContent, '1 s');
  rig.time.advance(2000);
  assert.equal(time.textContent, '3 s');
  assert.equal(rig.viewTimers.size, 1, 'one timer, re-armed, never several');
  assert.equal(rig.delays.every((ms) => ms === 1000), true, 'it fires every 1000 ms');
});

test('the quiet wait counts on in the phrase each second, and a finished row keeps its frozen time', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(received('a'));
  rig.time.advance(30000);
  assert.equal(stateOf(rig).textContent, 'No change yet · 30 s');
  rig.time.advance(2000);
  assert.equal(stateOf(rig).textContent, 'No change yet · 32 s');
  rig.tracker.serverMessage(applied('a'));
  const time = all(rows(rig)[0], 'rq-time')[0];
  const frozen = time.textContent;
  assert.equal(frozen, '32 s');
  rig.time.advance(10000);
  assert.equal(time.textContent, frozen, 'a finished row shows its frozen duration');
  assert.equal(all(rows(rig)[0], 'rq-time')[0].getAttribute('aria-hidden'), null, 'a finished row has its time in its name');
});

test('the timer is cleared when no row is in flight, quiet or finished less than 30 s ago', () => {
  const rig = setup();
  rig.send('a');
  rig.tracker.serverMessage(applied('a'));
  // The spoken line holds its second sentence until a second has passed; that one-shot timer is not the clock.
  rig.time.advance(1000);
  assert.equal(rig.viewTimers.size, 1, 'a row finished less than 30 s ago');
  rig.time.advance(FINISHED_SHOWN_MS - 1001);
  assert.equal(rig.viewTimers.size, 1);
  rig.time.advance(1);
  assert.equal(rig.viewTimers.size, 0, 'the row moved to Recent: nothing needs the clock');
  rig.time.advance(60000);
  assert.equal(rig.viewTimers.size, 0);
});

test('nothing animates: the view sets no style and builds nothing that moves', () => {
  const rig = setup();
  rig.send('a');
  rig.time.advance(5000);
  for (const node of [rig.panel, rig.toggle, ...items(rig), ...rows(rig)]) {
    assert.equal(node.style.props.size, 0, 'no inline style');
  }
  const source = readFileSync(VIEW_PATH, 'utf8');
  assert.equal(/transition|animation|requestAnimationFrame/.test(source), false);
});
