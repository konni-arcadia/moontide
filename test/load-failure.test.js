// The load failure notice: the exact copy, the pure decisions, the settle-once report, and the served markup and
// CSS. The part that needs a real browser (a script blocked by address) is the page probe's job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LOAD_FAILURE_COPY,
  LOAD_FAILURE_REPORT_MS,
  createReportSettler,
  failedScripts,
  loadFailureMode,
  noticeTexts,
} from '../page/load-failure.js';

const STRUDEL_SRC = 'https://unpkg.com/@strudel/repl@9.9.9/dist/index.js';
const ACORN_SRC = 'https://unpkg.com/acorn@9.9.9/dist/acorn.js';
const SRCS = { strudelSrc: STRUDEL_SRC, acornSrc: ACORN_SRC };

function allFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(allFrozen);
}

test('the copy is pinned word for word and deeply frozen', () => {
  assert.equal(LOAD_FAILURE_COPY.blocked.tabTitle, 'Moontide: Strudel did not load');
  assert.equal(LOAD_FAILURE_COPY.blocked.heading, 'Moontide could not load Strudel.');
  assert.equal(
    LOAD_FAILURE_COPY.blocked.whatStrudel,
    'The Strudel script from unpkg.com did not load, so the editor and the sound cannot start.',
  );
  assert.equal(
    LOAD_FAILURE_COPY.blocked.whatBoth,
    'The Strudel and acorn scripts from unpkg.com did not load, so the editor and the sound cannot start.',
  );
  assert.equal(
    LOAD_FAILURE_COPY.blocked.todo,
    'Check your internet connection and that nothing blocks unpkg.com (an ad blocker, a firewall or a proxy), then reload this page.',
  );
  assert.equal(LOAD_FAILURE_COPY.degraded.lead, 'The acorn script did not load.');
  assert.equal(
    LOAD_FAILURE_COPY.degraded.what,
    'Sound still plays, but the views that read the code (Timeline, Mixer, Parts, Jam and Instruments) cannot work.',
  );
  assert.equal(
    LOAD_FAILURE_COPY.degraded.todo,
    'Check your internet connection and that nothing blocks unpkg.com, then reload this page.',
  );
  assert.equal(LOAD_FAILURE_COPY.addressPrefix, 'Failed: ');
  assert.deepEqual({ ...LOAD_FAILURE_COPY.reload }, { label: 'Reload page', title: 'Reload this page' });
  assert.deepEqual({ ...LOAD_FAILURE_COPY.dismiss }, { label: 'Dismiss notice', title: 'Dismiss notice' });
  assert.equal(LOAD_FAILURE_COPY.claude.sending, 'Telling Claude…');
  assert.equal(LOAD_FAILURE_COPY.claude.told, 'Claude will see this on its next action.');
  assert.equal(
    LOAD_FAILURE_COPY.claude.unreachable,
    'The Moontide server could not be reached, so Claude was not told. Check that Moontide is running, then reload this page.',
  );
  assert.equal(
    LOAD_FAILURE_COPY.claude.refused,
    'Moontide answered but did not accept this report, so Claude was not told. This page is from an earlier start of Moontide: reload this page.',
  );
  assert.ok(allFrozen(LOAD_FAILURE_COPY), 'LOAD_FAILURE_COPY and every nested object are frozen');
  assert.equal(LOAD_FAILURE_REPORT_MS, 5000);
});

test('loadFailureMode maps the four states, and a Strudel script that defined nothing is a blocked mode', () => {
  assert.equal(loadFailureMode({ strudelDefined: true, acornDefined: true }), 'none');
  assert.equal(loadFailureMode({ strudelDefined: false, acornDefined: true }), 'blocked-strudel');
  assert.equal(loadFailureMode({ strudelDefined: false, acornDefined: false }), 'blocked-both');
  assert.equal(loadFailureMode({ strudelDefined: true, acornDefined: false }), 'degraded-acorn');
});

test('failedScripts names the scripts of each mode, Strudel first', () => {
  assert.deepEqual(failedScripts('none'), []);
  assert.deepEqual(failedScripts('blocked-strudel'), ['strudel']);
  assert.deepEqual(failedScripts('blocked-both'), ['strudel', 'acorn']);
  assert.deepEqual(failedScripts('degraded-acorn'), ['acorn']);
});

test('noticeTexts for Strudel alone: the blocked heading, the Strudel text, one address line and the tab title', () => {
  const texts = noticeTexts('blocked-strudel', SRCS);
  assert.equal(texts.title, LOAD_FAILURE_COPY.blocked.tabTitle);
  assert.equal(texts.heading, LOAD_FAILURE_COPY.blocked.heading);
  assert.equal(texts.what, LOAD_FAILURE_COPY.blocked.whatStrudel);
  assert.equal(texts.todo, LOAD_FAILURE_COPY.blocked.todo);
  assert.deepEqual(texts.addresses, [`Failed: ${STRUDEL_SRC}`]);
  assert.equal(texts.alert, `${texts.heading} ${texts.what} ${texts.todo}`);
});

test('noticeTexts for both scripts: the two-script text and two address lines, Strudel first', () => {
  const texts = noticeTexts('blocked-both', SRCS);
  assert.equal(texts.title, LOAD_FAILURE_COPY.blocked.tabTitle);
  assert.equal(texts.heading, LOAD_FAILURE_COPY.blocked.heading);
  assert.equal(texts.what, LOAD_FAILURE_COPY.blocked.whatBoth);
  assert.deepEqual(texts.addresses, [`Failed: ${STRUDEL_SRC}`, `Failed: ${ACORN_SRC}`]);
});

test('noticeTexts for acorn alone: the lead, the degraded text, one acorn address and no tab title', () => {
  const texts = noticeTexts('degraded-acorn', SRCS);
  assert.equal(texts.title, null);
  assert.equal(texts.heading, LOAD_FAILURE_COPY.degraded.lead);
  assert.equal(texts.what, LOAD_FAILURE_COPY.degraded.what);
  assert.equal(texts.todo, LOAD_FAILURE_COPY.degraded.todo);
  assert.deepEqual(texts.addresses, [`Failed: ${ACORN_SRC}`]);
  assert.equal(texts.alert, `${texts.heading} ${texts.what} ${texts.todo}`);
});

test('createReportSettler settles exactly once: told for ok true, refused for ok false, unreachable for anything else', () => {
  const run = (act) => {
    const outcomes = [];
    const settler = createReportSettler((outcome) => outcomes.push(outcome));
    act(settler);
    return outcomes;
  };
  assert.deepEqual(run((s) => s.answer(true)), ['told']);
  assert.deepEqual(run((s) => s.answer(false)), ['refused']);
  assert.deepEqual(run((s) => s.answer(undefined)), ['unreachable']);
  assert.deepEqual(run((s) => s.answer('yes')), ['unreachable']);
  assert.deepEqual(run((s) => s.fail('timeout')), ['unreachable']);
  assert.deepEqual(run((s) => { s.answer(true); s.answer(false); s.fail('close'); }), ['told']);
  assert.deepEqual(run((s) => { s.answer(false); s.answer(true); s.fail('close'); }), ['refused']);
  assert.deepEqual(run((s) => { s.fail('error'); s.answer(true); s.fail('timeout'); }), ['unreachable']);
});

// The served markup, the stylesheet and the view source, read as text (no browser needed).
const HTML = readFileSync(fileURLToPath(new URL('../page/index.html', import.meta.url)), 'utf8');
const CSS = readFileSync(fileURLToPath(new URL('../page/style.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const VIEW = readFileSync(fileURLToPath(new URL('../page/load-failure-view.js', import.meta.url)), 'utf8');

const NOTICE_IDS = [
  'load-failure',
  'load-failure-box',
  'load-failure-title',
  'load-failure-what',
  'load-failure-todo',
  'load-failure-addresses',
  'load-failure-claude',
  'load-failure-actions',
  'load-failure-reload',
  'load-failure-dismiss',
  'load-failure-alert',
];

/** The opening tag of the element with this id, or null. */
function openingTag(id) {
  const match = new RegExp(`<[a-z0-9]+\\s[^>]*\\bid="${id}"[^>]*>`).exec(HTML);
  return match ? match[0] : null;
}

/** [selectorList, body] for every rule of the stylesheet. */
function cssRules() {
  const found = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(CSS)) !== null) found.push([match[1].trim().replace(/\s+/g, ' '), match[2]]);
  return found;
}

function ruleBody(selector) {
  for (const [list, body] of cssRules()) {
    if (list.split(',').map((s) => s.trim()).includes(selector)) return body;
  }
  return null;
}

test('markup: every notice id exists exactly once', () => {
  for (const id of NOTICE_IDS) {
    assert.equal(HTML.split(`id="${id}"`).length - 1, 1, `id ${id} must appear exactly once`);
  }
});

test('markup: the notice starts hidden as the first child of body, followed by an empty alert that is never hidden', () => {
  assert.ok(/<body>\s*<section id="load-failure"[^>]*\bhidden\b[^>]*>/.test(HTML), 'section#load-failure[hidden] is the first element of a bare body');
  assert.match(openingTag('load-failure'), /aria-labelledby="load-failure-title"/);
  const alert = openingTag('load-failure-alert');
  assert.match(alert, /role="alert"/);
  assert.doesNotMatch(alert, /\bhidden\b/);
  assert.ok(HTML.includes(`${alert}</div>`), 'the alert is empty in the served markup');
  assert.doesNotMatch(HTML, /<body[^>]*data-load/, 'body carries no data-load in the served file');
  assert.ok(HTML.indexOf('id="load-failure-alert"') < HTML.indexOf('id="chrome"'), 'the alert comes before the rest of the page');
});

test('markup: the Claude line is a polite status, Dismiss notice starts hidden, Reload page does not', () => {
  const claude = openingTag('load-failure-claude');
  assert.match(claude, /role="status"/);
  assert.match(claude, /aria-live="polite"/);
  assert.match(openingTag('load-failure-dismiss'), /\bhidden\b/);
  assert.doesNotMatch(openingTag('load-failure-reload'), /\bhidden\b/);
});

test('markup: the view module tag sits immediately before the main module tag', () => {
  const lines = HTML.split('\n');
  const view = lines.findIndex((line) => line.includes('src="/load-failure-view.js"'));
  const main = lines.findIndex((line) => line.includes('src="/main.js"'));
  assert.ok(view >= 0 && main >= 0);
  assert.equal(main, view + 1);
  assert.match(lines[view], /<script type="module"/);
});

test('css: the failed address wraps anywhere and is never cut', () => {
  assert.match(ruleBody('#load-failure-addresses'), /overflow-wrap:\s*anywhere/);
  assert.match(ruleBody('#load-failure-addresses'), /user-select:\s*text/);
  for (const [selector, body] of cssRules()) {
    if (!selector.includes('load-failure-addresses')) continue;
    assert.doesNotMatch(body, /text-overflow/, `${selector} must not cut with an ellipsis`);
    assert.doesNotMatch(body, /white-space:\s*nowrap/, `${selector} must not stop wrapping`);
  }
});

test('css: nothing of the notice moves, fades or uses the reserved colors', () => {
  const noticeRules = cssRules().filter(([selector]) => selector.includes('load-failure'));
  assert.ok(noticeRules.length > 0);
  for (const [selector, body] of noticeRules) {
    assert.doesNotMatch(body, /\b(transition|animation)\b/, `${selector} must not animate`);
    assert.doesNotMatch(body, /var\(--(accent|accent-2|destructive)\)/, `${selector} must not use a reserved color`);
  }
  assert.ok(!CSS.includes('@'), 'no at-rule in the stylesheet');
});

test('css: every notice id with a display rule has its own [hidden] rule', () => {
  for (const id of NOTICE_IDS) {
    const body = ruleBody(`#${id}`);
    if (body === null || !/\bdisplay\s*:/.test(body)) continue;
    const hidden = ruleBody(`#${id}[hidden]`);
    assert.ok(hidden, `#${id} sets display, so it needs #${id}[hidden] { display: none; }`);
    assert.match(hidden, /display\s*:\s*none/);
  }
  assert.equal(ruleBody('#load-failure-alert') !== null && /\bdisplay\s*:/.test(ruleBody('#load-failure-alert')), false, 'the alert is never display-switched');
});

test('css: the blocked mode hides every other child of body with one chained :not() rule, and the strip sits above the overlay', () => {
  const body = ruleBody('body[data-load="failed"] > :not(#load-failure):not(#load-failure-alert)');
  assert.ok(body, 'the chained :not() rule exists');
  assert.match(body, /display:\s*none/);
  assert.match(ruleBody('#load-failure'), /z-index:\s*2001/);
  assert.match(ruleBody('#load-failure'), /min-height:\s*2\.25rem/);
  assert.ok(CSS.includes('body[data-load="degraded"]'), 'the degraded mode has its own rules');
  assert.ok(CSS.includes('body[data-load="failed"]'));
  assert.match(ruleBody('#load-failure-actions button'), /min-height:\s*1\.75rem/);
  assert.match(ruleBody('#load-failure-actions button'), /min-width:\s*1\.75rem/);
  assert.match(ruleBody('#load-failure-claude[data-state="unreachable"]'), /font-weight:\s*600/);
  assert.match(ruleBody('#load-failure-claude[data-state="refused"]'), /font-weight:\s*600/);
});

test('view: texts reach the page as text, every looked-up id exists, and nothing retries or reloads on its own', () => {
  assert.doesNotMatch(VIEW, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const ids = [...VIEW.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.ok(openingTag(id), `page/index.html has no element with id ${id}`);
  assert.equal(VIEW.split('location.reload').length - 1, 1, 'the only reload is the button');
  assert.ok(VIEW.indexOf('location.reload') > VIEW.indexOf("addEventListener('click'"));
  assert.doesNotMatch(VIEW, /setInterval/);
  assert.equal(VIEW.split('new WebSocket(').length - 1, 1, 'one socket, one attempt');
  assert.equal(VIEW.split('createReportSettler(').length - 1, 1);
});

// The view run against a small fake page: each scenario imports a fresh copy of the module, which acts at import.
const VIEW_URL = new URL('../page/load-failure-view.js', import.meta.url).href;
let viewRuns = 0;

function fakeElement() {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    textContent: '',
    hidden: false,
    children: [],
    focused: false,
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    appendChild(child) {
      element.children.push(child);
    },
    focus() {
      element.focused = true;
    },
    click() {
      listeners.get('click')();
    },
  };
  return element;
}

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }
  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  emit(type, event = {}) {
    this.listeners.get(type)?.(event);
  }
}

/** Installs the globals the view reads, runs it, and gives back what it did. */
async function runView(t, { strudel, acorn, token = 'a'.repeat(64), transport = true }) {
  const ids = Object.fromEntries(NOTICE_IDS.map((id) => [id, fakeElement()]));
  // The page's transport button lives outside the notice; a page without it is a run with transport: false.
  if (transport) ids['transport-button'] = fakeElement();
  // The served markup starts both of these hidden.
  ids['load-failure'].hidden = true;
  ids['load-failure-dismiss'].hidden = true;
  let touched = 0;
  let reloads = 0;
  const document = {
    title: 'Moontide',
    body: fakeElement(),
    activeElement: null,
    getElementById(id) {
      touched += 1;
      return ids[id];
    },
    querySelector(selector) {
      touched += 1;
      if (selector.includes('@strudel/repl')) return { src: STRUDEL_SRC };
      if (selector.includes('acorn')) return { src: ACORN_SRC };
      if (selector.includes('moontide-page-token')) return token === null ? null : { getAttribute: () => token };
      return null;
    },
    createElement() {
      touched += 1;
      return fakeElement();
    },
  };
  const saved = {};
  const set = (name, value) => {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  // Whatever takes focus becomes the active element, as in a page.
  for (const element of [...Object.values(ids), document.body]) {
    const focus = element.focus;
    element.focus = (options) => {
      focus();
      document.activeElement = element;
      element.focusOptions = options;
    };
  }
  set('document', document);
  set('window', acorn ? { acorn: { parse() {} } } : {});
  set('customElements', { get: () => (strudel ? function Editor() {} : undefined) });
  set('location', { host: '127.0.0.1:1234', reload: () => { reloads += 1; } });
  set('WebSocket', FakeSocket);
  FakeSocket.instances.length = 0;
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await import(`${VIEW_URL}?run=${viewRuns++}`);
  return { ids, document, sockets: FakeSocket.instances, touched: () => touched, reloads: () => reloads };
}

test('view: with both scripts loaded it changes nothing and opens no socket', async (t) => {
  const run = await runView(t, { strudel: true, acorn: true });
  assert.equal(run.touched(), 0);
  assert.equal(run.document.body.attributes.size, 0);
  assert.equal(run.document.title, 'Moontide');
  assert.equal(run.sockets.length, 0);
});

test('view: with Strudel missing it fills the blocked notice in one pass, focuses Reload page and reports once', async (t) => {
  const run = await runView(t, { strudel: false, acorn: true });
  const { ids } = run;
  assert.equal(run.document.body.attributes.get('data-load'), 'failed');
  assert.equal(run.document.title, LOAD_FAILURE_COPY.blocked.tabTitle);
  assert.equal(ids['load-failure'].hidden, false);
  assert.equal(ids['load-failure-title'].textContent, LOAD_FAILURE_COPY.blocked.heading);
  assert.equal(ids['load-failure-what'].textContent, LOAD_FAILURE_COPY.blocked.whatStrudel);
  assert.equal(ids['load-failure-todo'].textContent, LOAD_FAILURE_COPY.blocked.todo);
  assert.deepEqual(ids['load-failure-addresses'].children.map((c) => c.textContent), [`Failed: ${STRUDEL_SRC}`]);
  assert.equal(ids['load-failure-alert'].textContent, noticeTexts('blocked-strudel', SRCS).alert);
  assert.equal(ids['load-failure-reload'].focused, true);
  assert.equal(ids['load-failure-reload'].textContent, 'Reload page');
  assert.equal(ids['load-failure-reload'].attributes.get('title'), 'Reload this page');
  assert.equal(ids['load-failure-dismiss'].hidden, true, 'Dismiss notice stays hidden in the blocked notice');
  assert.equal(ids['load-failure-claude'].textContent, LOAD_FAILURE_COPY.claude.sending);
  assert.equal(run.reloads(), 0, 'no automatic reload');
  ids['load-failure-reload'].click();
  assert.equal(run.reloads(), 1);

  assert.equal(run.sockets.length, 1);
  const [socket] = run.sockets;
  assert.equal(socket.url, 'ws://127.0.0.1:1234/ws');
  socket.emit('open');
  assert.deepEqual(socket.sent, [{ type: 'load-failed', token: 'a'.repeat(64), failed: ['strudel'] }]);
  socket.emit('message', { data: JSON.stringify({ type: 'load-failed-result', ok: true }) });
  assert.equal(ids['load-failure-claude'].textContent, LOAD_FAILURE_COPY.claude.told);
  assert.equal(ids['load-failure-claude'].attributes.has('data-state'), false);
  assert.equal(socket.closed, true);
  socket.emit('close');
  socket.emit('error');
  assert.equal(ids['load-failure-claude'].textContent, LOAD_FAILURE_COPY.claude.told, 'a later close changes nothing');
  assert.equal(run.sockets.length, 1, 'no second attempt');
});

test('view: with both missing it lists both addresses and reports both names', async (t) => {
  const run = await runView(t, { strudel: false, acorn: false });
  assert.deepEqual(run.ids['load-failure-addresses'].children.map((c) => c.textContent), [`Failed: ${STRUDEL_SRC}`, `Failed: ${ACORN_SRC}`]);
  run.sockets[0].emit('open');
  assert.deepEqual(run.sockets[0].sent[0].failed, ['strudel', 'acorn']);
});

test('view: with acorn missing it shows the strip with Dismiss notice, keeps focus and title, and dismiss only hides it', async (t) => {
  const run = await runView(t, { strudel: true, acorn: false });
  const { ids } = run;
  assert.equal(run.document.body.attributes.get('data-load'), 'degraded');
  assert.equal(run.document.title, 'Moontide');
  assert.equal(ids['load-failure-reload'].focused, false);
  assert.equal(ids['load-failure'].hidden, false);
  assert.equal(ids['load-failure-title'].textContent, LOAD_FAILURE_COPY.degraded.lead);
  assert.equal(ids['load-failure-dismiss'].textContent, 'Dismiss notice');
  assert.equal(ids['load-failure-dismiss'].hidden, false);
  ids['load-failure-dismiss'].click();
  assert.equal(ids['load-failure'].hidden, true);
  assert.equal(run.document.body.attributes.get('data-load'), 'degraded', 'dismiss changes nothing else');
  run.sockets[0].emit('open');
  assert.deepEqual(run.sockets[0].sent[0].failed, ['acorn']);
});

test('view: Dismiss notice moves focus to the transport button, without scrolling, before the strip hides', async (t) => {
  const run = await runView(t, { strudel: true, acorn: false });
  const { ids } = run;
  ids['load-failure-dismiss'].focus();
  assert.equal(run.document.activeElement, ids['load-failure-dismiss']);
  let hiddenWhenFocused = null;
  const focus = ids['transport-button'].focus;
  ids['transport-button'].focus = (options) => {
    hiddenWhenFocused = ids['load-failure'].hidden;
    focus(options);
  };
  ids['load-failure-dismiss'].click();
  assert.equal(run.document.activeElement, ids['transport-button']);
  assert.deepEqual(ids['transport-button'].focusOptions, { preventScroll: true });
  assert.equal(hiddenWhenFocused, false, 'focus moves before the strip hides');
  assert.equal(ids['load-failure'].hidden, true);
});

test('view: without a transport button, Dismiss notice puts focus on the page body without scrolling', async (t) => {
  const run = await runView(t, { strudel: true, acorn: false, transport: false });
  run.ids['load-failure-dismiss'].focus();
  run.ids['load-failure-dismiss'].click();
  assert.equal(run.document.activeElement, run.document.body);
  assert.equal(run.document.body.attributes.get('tabindex'), '-1');
  assert.deepEqual(run.document.body.focusOptions, { preventScroll: true });
  assert.equal(run.ids['load-failure'].hidden, true);
});

test('view: an error, a close and the 5 s timer each end in the unreachable line, once', async (t) => {
  const scenarios = {
    error: (run) => run.sockets[0].emit('error'),
    close: (run) => run.sockets[0].emit('close'),
    timer: () => t.mock.timers.tick(LOAD_FAILURE_REPORT_MS),
  };
  for (const [name, act] of Object.entries(scenarios)) {
    const run = await runView(t, { strudel: false, acorn: true });
    act(run);
    const line = run.ids['load-failure-claude'];
    assert.equal(line.textContent, LOAD_FAILURE_COPY.claude.unreachable, name);
    assert.equal(line.attributes.get('data-state'), 'unreachable', name);
    assert.equal(run.sockets[0].closed, true, name);
    run.sockets[0].emit('message', { data: JSON.stringify({ type: 'load-failed-result', ok: true }) });
    assert.equal(line.textContent, LOAD_FAILURE_COPY.claude.unreachable, `${name}: a late answer changes nothing`);
  }
});

test('view: an answer of ok false ends in the refused line, once, and says the server was reached', async (t) => {
  const run = await runView(t, { strudel: false, acorn: true });
  run.sockets[0].emit('message', { data: JSON.stringify({ type: 'load-failed-result', ok: false }) });
  const line = run.ids['load-failure-claude'];
  assert.equal(line.textContent, LOAD_FAILURE_COPY.claude.refused);
  assert.equal(line.attributes.get('data-state'), 'refused');
  assert.notEqual(line.textContent, LOAD_FAILURE_COPY.claude.unreachable);
  assert.doesNotMatch(line.textContent, /could not be reached|is running/);
  assert.match(line.textContent, /reload this page/);
  assert.equal(run.sockets[0].closed, true);
  run.sockets[0].emit('message', { data: JSON.stringify({ type: 'load-failed-result', ok: true }) });
  assert.equal(line.textContent, LOAD_FAILURE_COPY.claude.refused, 'a late answer changes nothing');
});

test('view: a missing token logs one error, opens no socket and ends in the unreachable line', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  for (const token of [null, '__MOONTIDE_PAGE_TOKEN__']) {
    errors.length = 0;
    const run = await runView(t, { strudel: false, acorn: true, token });
    assert.equal(run.sockets.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /page token/);
    assert.equal(run.ids['load-failure-claude'].textContent, LOAD_FAILURE_COPY.claude.unreachable);
  }
});
