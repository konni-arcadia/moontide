// The page side of the session label: reading it from the served page, the tab title built from it,
// and the identity row in the Session card. Labels are made up ('my-project'), never a real folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Session } from '../dist/session.js';
import { startWebServer, SESSION_LABEL_PLACEHOLDER as SERVER_PLACEHOLDER } from '../dist/web-server.js';
import { tabTitle } from '../dist/session-label.js';
import {
  SESSION_LABEL_META,
  SESSION_LABEL_PLACEHOLDER,
  readSessionLabel,
  baseTitle,
  identityKey,
  renderSessionIdentity,
} from '../page/session-identity.js';
import { COPY } from '../page/ui-state.js';

/** A small fake document: one meta tag (or none) answering getAttribute, like the page-token read. */
function fakeMetaDocument(content) {
  return {
    querySelector(selector) {
      if (!selector.includes(SESSION_LABEL_META) || content === null) return null;
      return { getAttribute: (name) => (name === 'content' ? content : null) };
    },
  };
}

function readWith(content) {
  const errors = [];
  const label = readSessionLabel(fakeMetaDocument(content), (text) => errors.push(text));
  return { label, errors };
}

test('session identity: the placeholder mirrors the server by hand, and the meta name is the one the server writes', () => {
  assert.equal(SESSION_LABEL_PLACEHOLDER, SERVER_PLACEHOLDER);
  assert.equal(SESSION_LABEL_META, 'moontide-session-label');
});

test('session identity: a filled meta tag gives the label and reports nothing', () => {
  const { label, errors } = readWith('my-project · 5757');
  assert.equal(label, 'my-project · 5757');
  assert.deepEqual(errors, []);
});

test('session identity: a missing tag, an empty content or the placeholder gives null and exactly one error naming the tag', () => {
  for (const content of [null, '', SESSION_LABEL_PLACEHOLDER]) {
    const { label, errors } = readWith(content);
    assert.equal(label, null, String(content));
    assert.equal(errors.length, 1, String(content));
    assert.ok(errors[0].includes('moontide-session-label'), errors[0]);
  }
});

test('session identity: the error never carries the label and no readable value is logged', () => {
  const { errors } = readWith(SESSION_LABEL_PLACEHOLDER);
  assert.ok(!errors[0].includes(SESSION_LABEL_PLACEHOLDER));
});

test('session identity: the base title is the wordmark, a middle dot and the label, the same string the server writes', () => {
  assert.equal(baseTitle('my-project · 5757'), 'Moontide · my-project · 5757');
  assert.equal(baseTitle('my-project · 5757'), tabTitle('my-project · 5757'));
  assert.equal(baseTitle('5757'), 'Moontide · 5757');
  assert.equal(baseTitle('5757'), tabTitle('5757'));
  assert.equal(baseTitle(null), 'Moontide');
});

/** The meta content and the title text of a served page, read the way the page reads them. */
async function servedFacts(folder) {
  const web = await startWebServer({ session: new Session(), port: 0, folder });
  try {
    const res = await fetch(`http://localhost:${web.port}/`);
    const body = await res.text();
    const content = /<meta name="moontide-session-label" content="([^"]*)">/.exec(body)[1];
    const title = /<title>([^<]*)<\/title>/.exec(body)[1];
    return { web, content, title };
  } finally {
    await web.close();
  }
}

test('session identity: round trip, the label the page reads gives the very title the server served', async () => {
  const { web, content, title } = await servedFacts('my-project');
  const { label, errors } = readWith(content);
  assert.deepEqual(errors, []);
  assert.equal(label, `my-project · ${web.port}`);
  assert.equal(baseTitle(label), title);
});

test('session identity: round trip with an unusable folder gives the port alone in the title', async () => {
  const { web, content, title } = await servedFacts('');
  const { label } = readWith(content);
  assert.equal(label, String(web.port));
  assert.equal(baseTitle(label), `Moontide · ${web.port}`);
  assert.equal(baseTitle(label), title);
});

// --- the identity row ---

test('session identity: the key is Port for a bare port and Folder and port for everything else', () => {
  assert.equal(COPY.identityFolderKey, 'Folder and port');
  assert.equal(COPY.identityPortKey, 'Port');
  assert.equal(identityKey('my-project · 5757'), COPY.identityFolderKey);
  assert.equal(identityKey('123 · 5757'), 'Folder and port');
  assert.equal(identityKey('5757'), COPY.identityPortKey);
  assert.equal(identityKey('5757'), 'Port');
});

/** A fake element that refuses markup: any write to innerHTML, outerHTML or insertAdjacentHTML fails the test. */
function fakeElement() {
  const element = {
    textContent: '',
    attributes: [],
    removed: false,
    setAttribute(name) {
      element.attributes.push(name);
    },
    remove() {
      element.removed = true;
    },
    insertAdjacentHTML() {
      throw new Error('insertAdjacentHTML must not be used');
    },
  };
  for (const name of ['innerHTML', 'outerHTML']) {
    Object.defineProperty(element, name, {
      set() {
        throw new Error(`${name} must not be written`);
      },
      get: () => '',
    });
  }
  return element;
}

function fakeCardDocument({ withRow = true } = {}) {
  const row = fakeElement();
  const key = fakeElement();
  const value = fakeElement();
  row.querySelector = (selector) => (selector === '.session-key' ? key : null);
  const document = {
    getElementById: (id) => {
      if (!withRow) return null;
      if (id === 'session-identity') return row;
      if (id === 'session-label') return value;
      return null;
    },
  };
  return { document, row, key, value };
}

test('session identity: the row shows the key and the label as text, with no attribute and no markup', () => {
  const { document, row, key, value } = fakeCardDocument();
  const errors = [];
  renderSessionIdentity(document, 'my-project · 5757', (text) => errors.push(text));
  assert.equal(key.textContent, 'Folder and port');
  assert.equal(value.textContent, 'my-project · 5757');
  assert.deepEqual([row, key, value].map((el) => el.attributes), [[], [], []]);
  assert.equal(row.removed, false);
  assert.deepEqual(errors, []);
});

test('session identity: the unusable-folder label shows the key Port', () => {
  const { document, key, value } = fakeCardDocument();
  renderSessionIdentity(document, '5757', () => assert.fail('no error expected'));
  assert.equal(key.textContent, 'Port');
  assert.equal(value.textContent, '5757');
});

test('session identity: a label that looks like markup lands as literal characters', () => {
  const { document, value } = fakeCardDocument();
  const hostile = 'a"><b>x</b><img src=x onerror=alert(1)> · 5757';
  renderSessionIdentity(document, hostile, () => assert.fail('no error expected'));
  assert.equal(value.textContent, hostile);
});

test('session identity: without a label the row is removed and nothing more is reported', () => {
  const { document, row, key, value } = fakeCardDocument();
  const errors = [];
  renderSessionIdentity(document, null, (text) => errors.push(text));
  assert.equal(row.removed, true);
  assert.equal(key.textContent, '');
  assert.equal(value.textContent, '');
  assert.deepEqual(errors, []);
});

test('session identity: a page without the row reports it once, naming #session-identity', () => {
  const { document } = fakeCardDocument({ withRow: false });
  const errors = [];
  renderSessionIdentity(document, 'my-project · 5757', (text) => errors.push(text));
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('#session-identity'));
});

test('session identity: the page code never writes markup (comments stripped first, only code counts)', () => {
  for (const file of ['../page/session-identity.js']) {
    const code = fs
      .readFileSync(new URL(file, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML/.test(code), file);
  }
});

// --- markup and CSS ---

const html = fs.readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../page/style.css', import.meta.url), 'utf8');

/** The declaration block of the rule whose selector list holds exactly `selector`, or null. */
function ruleBody(selector) {
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css)) !== null) {
    const selectors = match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((part) => part.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

test('markup: the identity row is the first element after the heading of the Session card, read-only', () => {
  const card = /<section id="session-card-session" class="session-card">([\s\S]*?)<\/section>/.exec(html)[1];
  const lines = card.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(lines[0].includes('data-copy="cardSession"'), lines[0]);
  assert.equal(
    lines[1],
    '<div id="session-identity" class="session-identity"><span class="session-key"></span><span id="session-label"></span></div>',
  );
  for (const forbidden of ['hidden', 'tabindex', 'data-copy', 'data-needs']) {
    assert.ok(!lines[1].includes(forbidden), `${forbidden} in the identity row`);
  }
  assert.ok(!lines[1].includes('class="session-label"'), 'the value does not take the top bar button class');
  assert.ok(!/class="session-label"[^>]*id="session-label"|id="session-label"[^>]*class="session-label"/.test(html));
});

test('css: the identity row is a stacked column with an xs gap', () => {
  const body = ruleBody('.session-identity');
  assert.match(body, /display:\s*flex/);
  assert.match(body, /flex-direction:\s*column/);
  assert.match(body, /gap:\s*0\.25rem/);
});

test('css: the key is muted body text and the value is mono text that wraps', () => {
  const key = ruleBody('.session-identity .session-key');
  for (const declaration of [/margin:\s*0/, /color:\s*var\(--text-muted\)/, /font-size:\s*0\.8125rem/, /font-weight:\s*400/, /line-height:\s*1\.5/]) {
    assert.match(key, declaration);
  }
  const value = ruleBody('#session-label');
  for (const declaration of [
    /margin:\s*0/,
    /min-width:\s*0/,
    /color:\s*var\(--text\)/,
    /font-family:\s*var\(--font-mono\)/,
    /font-size:\s*0\.8125rem/,
    /font-weight:\s*400/,
    /line-height:\s*1\.5/,
    /white-space:\s*normal/,
    /overflow-wrap:\s*anywhere/,
  ]) {
    assert.match(value, declaration);
  }
});

test('css: nothing in the identity rules clips, animates, hides or blocks selection', () => {
  const bodies = ['.session-identity', '.session-identity .session-key', '#session-label'].map(ruleBody);
  for (const body of bodies) {
    assert.ok(body !== null);
    assert.doesNotMatch(body, /text-overflow|overflow\s*:|nowrap|transition|animation|user-select|display:\s*none|color:\s*#|\d+px/);
  }
  // The row is never hidden by a rule: a page without a label has it removed.
  assert.equal(ruleBody('#session-identity'), null);
  assert.equal(ruleBody('#session-identity[hidden]'), null);
  assert.equal(ruleBody('#session-label[hidden]'), null);
  assert.equal(ruleBody('.session-identity[hidden]'), null);
});
