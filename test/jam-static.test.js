// Static contracts of the Jam view's declared harmony: four
// new ids in the markup (the Declared line and the Heard label, both hidden at the start, none a control), the CSS
// that draws them (rem sizes, the two palette greys only, a [hidden] rule for each, no motion, no at-rule) and the
// view's text-only rule (the declared text comes from the code and is not trusted). These tests read the sources;
// the live behavior is proved by `npm run probe:page -- --only harmony` in real Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const html = read('../page/index.html');
const css = read('../page/style.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** A module's code without its comments, so a comment that names a forbidden call does not fail a test about code. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}
const viewCode = codeOf(read('../page/jam-view.js'));

const IDS = ['jam-declared', 'jam-declared-label', 'jam-declared-value', 'jam-scale-label'];

// The opening tag of the element with this id.
function tagOf(id) {
  const match = html.match(new RegExp(`<(\\w+)([^>]*\\bid="${id}"[^>]*)>`));
  assert.ok(match, `page/index.html has no #${id}`);
  return { name: match[1], attributes: match[2], at: match.index, length: match[0].length };
}

test('the markup holds each of the four ids exactly once', () => {
  for (const id of IDS) {
    assert.equal(html.match(new RegExp(`\\bid="${id}"`, 'g'))?.length, 1, `#${id} must appear exactly once`);
  }
});

test('#jam-declared is the first child of #jam-info and #jam-scale-label the first child of #jam-scale, both hidden at the start', () => {
  const info = tagOf('jam-info');
  assert.equal(html.slice(info.at + info.length).startsWith(`<p id="jam-declared" hidden>`), true, '#jam-declared must open #jam-info');
  const scale = tagOf('jam-scale');
  assert.equal(html.slice(scale.at + scale.length).startsWith(`<span id="jam-scale-label" hidden>`), true, '#jam-scale-label must open #jam-scale');
  assert.match(tagOf('jam-declared').attributes, /\bhidden\b/);
  assert.match(tagOf('jam-scale-label').attributes, /\bhidden\b/);
  const declared = tagOf('jam-declared');
  const rest = html.slice(declared.at + declared.length);
  assert.ok(rest.startsWith('<span id="jam-declared-label"></span><span id="jam-declared-value"></span></p>'), 'the line holds its label then its value');
});

test('none of the four elements is a control, a live region or named apart from its text', () => {
  for (const id of IDS) {
    const { attributes } = tagOf(id);
    for (const forbidden of ['tabindex', 'aria-live', 'aria-label', 'role', 'contenteditable']) {
      assert.doesNotMatch(attributes, new RegExp(`\\b${forbidden}\\b`), `#${id} must not carry ${forbidden}`);
    }
  }
  assert.equal(tagOf('jam-declared').name, 'p');
  assert.equal(tagOf('jam-declared-label').name, 'span');
  assert.equal(tagOf('jam-declared-value').name, 'span');
  assert.equal(tagOf('jam-scale-label').name, 'span');
});

test('the module script tags are the load failure notice and the single main entry', () => {
  assert.deepEqual(
    html.match(/<script\s+type="module"[^>]*>/g),
    ['<script type="module" src="/load-failure-view.js">', '<script type="module" src="/main.js">'],
  );
});

// The rules of the stylesheet whose selector names one of the new ids.
function rulesFor() {
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (/#jam-declared|#jam-scale-label/.test(selector)) rules.push({ selector, body: match[2] });
  }
  return rules;
}

test('the stylesheet hides both ids with their own [hidden] rule', () => {
  assert.match(css, /#jam-declared\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#jam-scale-label\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('the new rules use only the two text colors, two rem sizes, weight 400, no px, no motion', () => {
  const rules = rulesFor();
  assert.ok(rules.length >= 5, 'the new rules are missing');
  for (const { selector, body } of rules) {
    const where = `rule '${selector}'`;
    assert.doesNotMatch(body, /\dpx\b/, `${where} must not use px`);
    assert.doesNotMatch(body, /\b(transition|animation|transform)\b/, `${where} must not move`);
    assert.doesNotMatch(body, /--accent|--destructive|--jam-avoid|--jam-outside/, `${where} must not use a reserved color`);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${where} must use palette variables only`);
    for (const color of body.matchAll(/(?<![-\w])color:\s*([^;]+);/g)) {
      assert.match(color[1].trim(), /^var\(--text(-muted)?\)$/, `${where}: color ${color[1]}`);
    }
    for (const size of body.matchAll(/font-size:\s*([^;]+);/g)) {
      assert.match(size[1].trim(), /^(0\.8125rem|1rem)$/, `${where}: font-size ${size[1]}`);
    }
    for (const weight of body.matchAll(/font-weight:\s*([^;]+);/g)) {
      assert.equal(weight[1].trim(), '400', `${where}: font-weight ${weight[1]}`);
    }
  }
  const text = rules.map((rule) => rule.body).join('\n');
  assert.match(text, /font-size:\s*0\.8125rem/);
  assert.match(text, /font-size:\s*1rem/);
});

test('no new custom property and no data-motion rule for the new ids', () => {
  for (const { selector, body } of rulesFor()) {
    assert.doesNotMatch(body, /^\s*--[\w-]+\s*:/m, `rule '${selector}' declares a custom property`);
    assert.doesNotMatch(selector, /data-motion/, `rule '${selector}' depends on the motion mode`);
  }
});

// --- the view: text only ---

const MARKUP_WRITERS = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write\b/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['DOMParser', /\bDOMParser\b/],
  ['a socket or event send', /\.send\s*\(/],
  ['a network call', /\bfetch\s*\(/],
  ['local storage', /\blocalStorage\b/],
  ['session storage', /\bsessionStorage\b/],
];

test('page/jam-view.js writes no markup, sends nothing and stores nothing', () => {
  for (const [what, pattern] of MARKUP_WRITERS) {
    assert.doesNotMatch(viewCode, pattern, `page/jam-view.js must not contain ${what}`);
  }
});

test('page/jam-view.js looks the four ids up and writes them only through textContent, title, dataset and hidden', () => {
  const variables = {
    'jam-declared': 'jamDeclared',
    'jam-declared-label': 'jamDeclaredLabel',
    'jam-declared-value': 'jamDeclaredValue',
    'jam-scale-label': 'jamScaleLabel',
  };
  for (const [id, variable] of Object.entries(variables)) {
    assert.ok(viewCode.includes(`const ${variable} = document.getElementById('${id}');`), `the view must look up #${id}`);
    for (const use of viewCode.matchAll(new RegExp(`\\b${variable}\\.(\\w+)`, 'g'))) {
      assert.ok(['textContent', 'title', 'dataset', 'hidden'].includes(use[1]), `${variable}.${use[1]} is not a text-only write`);
    }
  }
  assert.match(viewCode, /jamDeclaredLabel\.textContent = JAM_COPY\.declaredLabel/);
  assert.match(viewCode, /jamScaleLabel\.textContent = JAM_COPY\.heardLabel/);
  assert.match(viewCode, /function renderDeclared\(/);
  assert.match(viewCode, /renderDeclared\(model\.declared\)/);
});
