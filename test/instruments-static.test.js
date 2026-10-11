// Static contracts of the Instruments view:
// the view sends only through two callbacks, only from its controls (no socket send, no
// fetch, no storage write in either module), is markup-free (text only), never asks for MIDI access, and its CSS
// stays inside the page's contracts (rem sizes, 1px hairlines, no motion, no reserved color, a [hidden] rule for
// every id with a display rule). The HTML itself holds no control: the view builds them inside its cards. These
// tests read the sources; the live behavior is proved by `npm run probe:midi` and `npm run probe:page` in real Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STORAGE_KEYS } from '../page/views.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const html = read('../page/index.html');
const main = read('../page/main.js');
const css = read('../page/style.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** A module's code without its comments, so a comment that names a forbidden call does not fail a test about code. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const MODULES = [
  { path: 'page/instruments-view.js', code: codeOf(read('../page/instruments-view.js')) },
  { path: 'page/instruments-model.js', code: codeOf(read('../page/instruments-model.js')) },
];

test('the markup of #instruments-view holds the ids of the contract in order and no control (the view builds them inside its cards)', () => {
  const start = html.indexOf('<div id="instruments-view"');
  assert.ok(start >= 0, 'page/index.html has no #instruments-view');
  const statusAt = html.indexOf('id="instruments-status"', start);
  assert.ok(statusAt > start, 'page/index.html has no #instruments-status inside the view');
  const closing = '</span></div>';
  const end = html.indexOf(closing, statusAt);
  assert.ok(end > statusAt, '#instruments-status must be the last element of #instruments-view');
  const block = html.slice(start, end + closing.length);
  const ids = [...block.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, [
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
  ]);
  assert.doesNotMatch(block, /<(button|input|select|textarea|a)[\s>]/i, 'the view has no control');
  assert.doesNotMatch(block, /contenteditable/i, 'the view has no editable part');
});

// The forbidden calls, each a regular expression over the code of the two modules.
const FORBIDDEN_CALLS = [
  ['a socket or event send', /\.send\s*\(/],
  ['a WebSocket', /\bWebSocket\b/],
  ['a network call (fetch)', /\bfetch\s*\(/],
  ['a network call (XMLHttpRequest)', /\bXMLHttpRequest\b/],
  ['a network call (sendBeacon)', /\bsendBeacon\b/],
  ['local storage', /\blocalStorage\b/],
  ['session storage', /\bsessionStorage\b/],
  ['a storage write', /\bsetItem\b/],
  ['markup injection (innerHTML)', /\binnerHTML\b/],
  ['markup injection (outerHTML)', /\bouterHTML\b/],
  ['markup injection (insertAdjacentHTML)', /\binsertAdjacentHTML\b/],
  ['markup injection (document.write)', /\bdocument\.write\b/],
  ['the page token', /moontide-page-token/],
  ['a bearer header', /\bBearer\b|\bAuthorization\b/i],
  ['a MIDI access request', /\brequestMIDIAccess\b/],
  ['a MIDI enable function', /\b(enableIfGranted|enableWebMidi|beforeEvaluate|prepareSetup|prepareTakeover)\b/],
];

test('the two Instruments modules send nothing, store nothing, inject no markup and ask for no MIDI access', () => {
  for (const { path, code } of MODULES) {
    for (const [what, pattern] of FORBIDDEN_CALLS) {
      assert.doesNotMatch(code, pattern, `${path} must not contain ${what}`);
    }
  }
});

test('addEventListener appears only in page/instruments-view.js, and only for click, keydown, change or submit', () => {
  const [view, model] = MODULES.map((module) => module.code);
  assert.doesNotMatch(model, /\baddEventListener\b/, 'the model is pure: no listener');
  const events = [...view.matchAll(/\.addEventListener\(\s*'([\w-]+)'/g)].map((match) => match[1]);
  assert.ok(events.length > 0, 'the view attaches its switch listener');
  assert.equal(events.length, [...view.matchAll(/\baddEventListener\b/g)].length, 'every listener names its event as a literal');
  for (const event of events) assert.ok(['click', 'keydown', 'change', 'submit'].includes(event), `the view attaches a ${event} listener`);
});

test('the view reaches the server only through onInstrumentSwitch, and holds no send of its own', () => {
  const view = MODULES[0].code;
  assert.match(view, /\bonInstrumentSwitch\b/);
  assert.match(view, /onInstrumentSwitch\(/, 'a press calls the callback');
  assert.doesNotMatch(view, /\.send\s*\(/);
  assert.doesNotMatch(view, /\bwebsocket\b/i);
  // page/main.js owns the send, with the message type and the callback wiring in one place each.
  assert.equal([...main.matchAll(/type: 'instrument-switch'/g)].length, 1);
  assert.match(main, /onInstrumentSwitch: \(instrument, enabled\) => requestInstrumentSwitch\(instrument, enabled\)/);
});

test('page/instruments-view.js builds exactly the allowed tags, only checkbox inputs, no textarea and no anchor', () => {
  const view = MODULES[0].code;
  assert.doesNotMatch(view, /createElement\(\s*['"`](input|select|textarea|a)['"`]/i, 'every element goes through the element() helper');
  // The only tags the view builds are listed here: a new one must be a deliberate choice. details and summary are the
  // disclosure of a Drum map line (display only); ul holds its notes; button is the switch, Edit settings, Save
  // and Cancel; form, fieldset, legend, label, select, option and input are the settings editor. Every other
  // control (a, textarea, input of any other type, contenteditable) stays forbidden.
  const tags = new Set([...view.matchAll(/element\(\s*'(\w+)'/g)].map((match) => match[1]));
  assert.deepEqual(
    [...tags].sort(),
    ['button', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'form', 'input', 'label', 'legend', 'li', 'option', 'p', 'select', 'span', 'summary', 'ul'],
  );
  // The one place an input is made gives it type checkbox in the same function.
  const inputs = [...view.matchAll(/element\(\s*'input'/g)];
  assert.equal(inputs.length, 1, 'inputs are made in one helper');
  const helper = view.slice(view.lastIndexOf('function checkbox', inputs[0].index), inputs[0].index + 200);
  assert.match(helper, /setAttribute\('type', 'checkbox'\)/);
  assert.doesNotMatch(view, /element\(\s*'(textarea|a)'/);
  assert.doesNotMatch(view, /contenteditable/i);
});

test('the view modules hold no channel rule: the server validates, the page never does', () => {
  // A comparison of a channel with a bound, a minimum on the draft's channels, or a validator. (The rhythm channels the
  // code uses are a different thing: their count only picks a sentence.) ok() keeps the module text out of the report.
  const rules = [
    ['a channel compared with a bound', /\bchannel\w*\s*(<=?|>=?|===?|!==?)\s*(0|1|16|17)\b/],
    ['a bound compared with a channel', /\b(0|1|16|17)\s*(<=?|>=?)\s*\w*channel/i],
    ['a minimum on the draft channels', /\b(draft|settings|state)\.channels\.length\s*(<=?|>=?|===?|!==?)\s*[01]\b/],
    ['a validator', /\bvalidate\w*\s*\(/i],
  ];
  for (const { path, code } of MODULES) {
    for (const [what, pattern] of rules) assert.ok(!pattern.test(code), `${path} holds ${what}`);
  }
});

test('the view reaches the server for settings only through onInstrumentSettings; page/main.js owns the one send', () => {
  const view = MODULES[0].code;
  assert.match(view, /onInstrumentSettings\(/, 'Save calls the callback');
  assert.equal([...main.matchAll(/type: 'instrument-settings'/g)].length, 1);
  assert.match(main, /onInstrumentSettings: \(instrument, settings\) => requestInstrumentSettings\(instrument, settings\)/);
  assert.match(main, /outputs: midiOut\.outputNames\(\)/, 'the editor offers the ports the browser lists now, read without enabling Web MIDI');
});

test('isTextEntryFocused in page/main.js counts any control inside .instrument-editor, so the single-key shortcuts stay inert', () => {
  const start = main.indexOf('function isTextEntryFocused(');
  assert.ok(start >= 0, 'page/main.js has no isTextEntryFocused');
  const rest = main.slice(start + 1);
  const body = codeOf(rest.slice(0, rest.search(/^(async )?function |^document\.addEventListener/m)));
  assert.match(body, /closest\('\.instrument-editor'\)/);
});

test('STORAGE_KEYS is unchanged: the view adds no remembered setting', () => {
  assert.deepEqual(STORAGE_KEYS, {
    layout: 'moontide.layout',
    view: 'moontide.view',
    motion: 'moontide.motion',
    historyMode: 'moontide.historyMode',
    jamInstrument: 'moontide.jamInstrument',
    jamChordTones: 'moontide.jamChordTones',
    changeTiming: 'moontide.changeTiming',
    // The two sizes of the border between the editor and the view; the Instruments view adds none.
    splitA: 'moontide.split.a',
    splitB: 'moontide.split.b',
  });
});

test('renderInstruments in page/main.js names no function that enables Web MIDI', () => {
  const start = main.indexOf('function renderInstruments(');
  assert.ok(start >= 0, 'page/main.js has no renderInstruments');
  const rest = main.slice(start + 1);
  const next = rest.search(/^(async )?function /m);
  assert.ok(next > 0, 'could not find the end of renderInstruments');
  const body = codeOf(rest.slice(0, next));
  assert.match(body, /midiOut\.facts\(|facts\b/, 'renderInstruments reads the facts midi-out already knows');
  assert.doesNotMatch(body, /\b(enableIfGranted|enableWebMidi|beforeEvaluate|prepareSetup|prepareTakeover|requestMIDIAccess)\b/);
});

test('renderInstruments in page/main.js reports a missing parser once, not on every redraw', () => {
  const start = main.indexOf('function renderInstruments(');
  const rest = main.slice(start + 1);
  const body = codeOf(rest.slice(0, rest.search(/^(async )?function /m)));
  assert.match(body, /else if \(!instrumentsParserMissingLogged\)\s*\{\s*instrumentsParserMissingLogged = true;\s*console\.error\(/);
  assert.match(main, /^let instrumentsParserMissingLogged = false;$/m, 'the flag is declared at the top of page/main.js, before any redraw can run');
});

test('renderInstrumentsIfOpen in page/main.js logs a failed draw loudly instead of breaking its caller', () => {
  const start = main.indexOf('function renderInstrumentsIfOpen(');
  assert.ok(start >= 0, 'page/main.js has no renderInstrumentsIfOpen');
  const rest = main.slice(start + 1);
  const next = rest.search(/^(async )?function /m);
  assert.ok(next > 0, 'could not find the end of renderInstrumentsIfOpen');
  const body = codeOf(rest.slice(0, next));
  assert.match(body, /\btry\s*\{[\s\S]*renderInstruments\(facts\)[\s\S]*\}\s*catch\s*\(err\)\s*\{[\s\S]*console\.error\(/, 'the draw must sit in a try/catch that logs with console.error');
  assert.doesNotMatch(body, /\bthrow\b/, 'the guard must not rethrow: its callers are socket handlers');
});

/** The rules of the stylesheet that belong to the Instruments view: `{ selectors, body }` each. */
function instrumentRules() {
  const rules = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css)) !== null) {
    const selectors = match[1].split(',').map((raw) => raw.trim().replace(/\s+/g, ' '));
    const own = selectors.some(
      (selector) => selector.includes('#instruments-') || selector.includes('.instrument-') ||
        selector === '.midi-dot[data-kind="unknown"]' ||
        selector === '.midi-dot[data-kind="off"]',
    );
    if (own) rules.push({ selectors, body: match[2] });
  }
  return rules;
}

test('the Instruments CSS has no at-rule, no px but 1px, rem font sizes only, no transition, no animation, no motion rule', () => {
  // Only the Instruments CSS is held to this: another view may use an at-rule. A rule is the Instruments' when a
  // selector names an #instruments-* id or an .instrument-* class, wherever it sits, including inside an at-rule.
  for (let at = css.indexOf('@'); at >= 0; at = css.indexOf('@', at + 1)) {
    const open = css.indexOf('{', at);
    assert.ok(open > at, 'an at-rule of page/style.css has no block');
    let depth = 1;
    let close = open + 1;
    while (depth > 0 && close < css.length) {
      if (css[close] === '{') depth += 1;
      if (css[close] === '}') depth -= 1;
      close += 1;
    }
    const block = css.slice(at, close);
    assert.ok(
      !block.includes('#instruments-') && !block.includes('.instrument-'),
      `page/style.css wraps Instruments rules in an at-rule (${css.slice(at, open).trim()}); the Instruments CSS has none`,
    );
  }
  const rules = instrumentRules();
  for (const { selectors, body } of rules) {
    assert.ok(!selectors.some((selector) => selector.includes('@')) && !body.includes('@'), `${selectors.join(', ')} holds an at-rule`);
    assert.ok(!body.includes('{'), `${selectors.join(', ')} holds a nested block`);
  }
  assert.ok(rules.length > 20, 'expected the Instruments rules in page/style.css');
  for (const { selectors, body } of rules) {
    const name = selectors.join(', ');
    assert.doesNotMatch(body, /\b(transition|animation)\b/, `${name} must not animate`);
    assert.ok(!selectors.some((selector) => selector.includes('[data-motion')), `${name} must not be a motion rule`);
    for (const px of body.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)) {
      assert.equal(px[1], '1', `${name} uses ${px[0]}; only 1px hairlines are allowed`);
    }
    for (const size of body.matchAll(/font-size\s*:\s*([^;]+);/g)) {
      assert.match(size[1].trim(), /^\d*\.?\d+rem$/, `${name} must size its font in rem`);
    }
  }
});

test('every #instruments-* id with a display rule has an #id[hidden] rule that hides it', () => {
  const rules = instrumentRules();
  const bodyOf = (selector) => {
    const found = rules.find((rule) => rule.selectors.includes(selector));
    return found === undefined ? null : found.body;
  };
  const ids = new Set();
  for (const { selectors } of rules) {
    for (const selector of selectors) if (/^#instruments-[\w-]+$/.test(selector)) ids.add(selector);
  }
  assert.ok(ids.size >= 8, 'expected the #instruments-* rules in page/style.css');
  for (const selector of ids) {
    const body = bodyOf(selector);
    if (!/\bdisplay\s*:/.test(body)) continue;
    const hidden = bodyOf(`${selector}[hidden]`);
    assert.ok(hidden !== null, `${selector} sets display, so page/style.css needs ${selector}[hidden] { display: none; }`);
    assert.match(hidden, /display\s*:\s*none/, `${selector}[hidden] must set display: none`);
  }
});

test('the "not checked" dot is a dash: 1px high, square, muted', () => {
  const rule = instrumentRules().find((candidate) => candidate.selectors.includes('.midi-dot[data-kind="unknown"]'));
  assert.ok(rule, 'page/style.css has no .midi-dot[data-kind="unknown"] rule');
  assert.match(rule.body, /height\s*:\s*1px/);
  assert.match(rule.body, /border-radius\s*:\s*0\b/);
  assert.match(rule.body, /background\s*:\s*var\(--text-muted\)/);
});

test('the "switched off" dot is a muted ring with a 1px slash, the same size as the other dots', () => {
  const rule = instrumentRules().find((candidate) => candidate.selectors.includes('.midi-dot[data-kind="off"]'));
  assert.ok(rule, 'page/style.css has no .midi-dot[data-kind="off"] rule');
  assert.match(rule.body, /border\s*:\s*1px solid var\(--text-muted\)/);
  assert.match(rule.body, /box-sizing\s*:\s*border-box/);
  assert.match(rule.body, /linear-gradient\(to top right,[^;]*calc\(50% - 1px\)[^;]*var\(--text-muted\)/);
  assert.doesNotMatch(rule.body, /\b(width|height)\s*:/, 'the size comes from .state-dot');
});

test('an off card has a dashed outline and muted values; the switch is a 1.75rem target with no accent', () => {
  const rules = instrumentRules();
  const bodyOf = (selector) => rules.find((rule) => rule.selectors.includes(selector))?.body ?? null;
  assert.match(bodyOf('.instrument-card[data-enabled="false"]') ?? '', /border-style\s*:\s*dashed/);
  const muted = rules.find((rule) => rule.selectors.includes('.instrument-card[data-enabled="false"] .instrument-value'));
  assert.ok(muted, 'the values of an off card have a rule');
  assert.match(muted.body, /color\s*:\s*var\(--text-muted\)/);
  assert.match(bodyOf('.instrument-switch') ?? '', /min-height\s*:\s*1\.75rem/);
  assert.match(bodyOf('.instrument-error') ?? '', /font-weight\s*:\s*600/);
  for (const { selectors, body } of rules) {
    assert.doesNotMatch(body, /--accent|--destructive/, `${selectors.join(', ')} must not use an accent or the destructive color`);
  }
});

test('page/instruments-view.js is one of the sources test/page-hidden.test.js reads', () => {
  assert.match(read('./page-hidden.test.js'), /page\/instruments-view\.js/);
});
