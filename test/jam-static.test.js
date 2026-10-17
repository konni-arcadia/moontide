// Static contracts of the Jam view's declared harmony and of the line that says why a scale is proposed: five
// new ids in the markup (the Declared line with the section it speaks for, and the Heard label, both hidden at the start, none a control), the CSS
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

const IDS = ['jam-declared', 'jam-declared-label', 'jam-declared-value', 'jam-declared-section', 'jam-scale-label'];

// The opening tag of the element with this id.
function tagOf(id) {
  const match = html.match(new RegExp(`<(\\w+)([^>]*\\bid="${id}"[^>]*)>`));
  assert.ok(match, `page/index.html has no #${id}`);
  return { name: match[1], attributes: match[2], at: match.index, length: match[0].length };
}

test('the markup holds each of the five ids exactly once', () => {
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
  assert.ok(
    rest.startsWith('<span id="jam-declared-label"></span><span id="jam-declared-value"></span><span id="jam-declared-section" hidden></span></p>'),
    'the line holds its label, its value, then the section it speaks for, hidden at the start',
  );
});

test('none of the five elements is a control, a live region or named apart from its text', () => {
  for (const id of IDS) {
    const { attributes } = tagOf(id);
    for (const forbidden of ['tabindex', 'aria-live', 'aria-label', 'role', 'contenteditable']) {
      assert.doesNotMatch(attributes, new RegExp(`\\b${forbidden}\\b`), `#${id} must not carry ${forbidden}`);
    }
  }
  assert.equal(tagOf('jam-declared').name, 'p');
  assert.equal(tagOf('jam-declared-label').name, 'span');
  assert.equal(tagOf('jam-declared-value').name, 'span');
  assert.equal(tagOf('jam-declared-section').name, 'span');
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

test('the stylesheet hides all three ids with their own [hidden] rule', () => {
  assert.match(css, /#jam-declared\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#jam-scale-label\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#jam-declared-section\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
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

test('page/jam-view.js looks the five ids up and writes them only through textContent, title, dataset and hidden', () => {
  const variables = {
    'jam-declared': 'jamDeclared',
    'jam-declared-label': 'jamDeclaredLabel',
    'jam-declared-value': 'jamDeclaredValue',
    'jam-declared-section': 'jamDeclaredSection',
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
  assert.match(viewCode, /function renderDeclaredSection\(/);
  assert.match(viewCode, /renderDeclaredSection\(model\.section\)/);
});

// --- the line that says why a scale is proposed ---

const REASON_IDS = ['jam-reason', 'jam-reason-lead', 'jam-reason-rest'];

test('the markup holds the reason line and its two parts exactly once', () => {
  for (const id of REASON_IDS) {
    assert.equal(html.match(new RegExp(`\\bid="${id}"`, 'g'))?.length, 1, `#${id} must appear exactly once`);
  }
});

test('the reason line is a polite live region, hidden at the start, right after the scale block and before the degrees', () => {
  const reason = tagOf('jam-reason');
  assert.equal(reason.name, 'p');
  assert.match(reason.attributes, /\baria-live="polite"/);
  assert.match(reason.attributes, /\bhidden\b/);
  assert.equal(tagOf('jam-reason-lead').name, 'strong');
  assert.equal(tagOf('jam-reason-rest').name, 'span');
  assert.ok(
    html.includes(
      '<p id="jam-scale-sub"></p></div><p id="jam-reason" aria-live="polite" hidden><strong id="jam-reason-lead"></strong><span id="jam-reason-rest"></span></p><div id="jam-candidates"',
    ),
    'the reason line sits between #jam-scale and the list of the scales that fit',
  );
  for (const id of ['jam-reason-lead', 'jam-reason-rest']) {
    for (const forbidden of ['tabindex', 'aria-live', 'role', 'contenteditable']) {
      assert.doesNotMatch(tagOf(id).attributes, new RegExp(`\\b${forbidden}\\b`), `#${id} must not carry ${forbidden}`);
    }
  }
});

function reasonRules() {
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (/#jam-reason/.test(selector)) rules.push({ selector, body: match[2] });
  }
  return rules;
}

test('the stylesheet hides the reason line with its own [hidden] rule', () => {
  assert.match(css, /#jam-reason\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('the reason rules use only the text colour, 1rem, weights 400 and 600, no px and no motion', () => {
  const rules = reasonRules();
  assert.ok(rules.length >= 3, 'the reason rules are missing');
  for (const { selector, body } of rules) {
    const where = `rule '${selector}'`;
    assert.doesNotMatch(body, /\dpx\b/, `${where} must not use px`);
    assert.doesNotMatch(body, /\b(transition|animation|transform)\b/, `${where} must not move`);
    assert.doesNotMatch(body, /--accent|--destructive|--jam-avoid|--jam-outside|--text-muted/, `${where} must not use a reserved or muted color`);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${where} must use palette variables only`);
    assert.doesNotMatch(selector, /data-motion/, `${where} depends on the motion mode`);
    for (const color of body.matchAll(/(?<![-\w])color:\s*([^;]+);/g)) assert.equal(color[1].trim(), 'var(--text)', `${where}: color ${color[1]}`);
    for (const size of body.matchAll(/font-size:\s*([^;]+);/g)) assert.equal(size[1].trim(), '1rem', `${where}: font-size ${size[1]}`);
    for (const weight of body.matchAll(/font-weight:\s*([^;]+);/g)) assert.match(weight[1].trim(), /^(400|600)$/, `${where}: font-weight ${weight[1]}`);
  }
  const lead = rules.find((rule) => rule.selector === '#jam-reason-lead');
  assert.match(lead.body, /font-weight:\s*600/);
  const line = rules.find((rule) => rule.selector === '#jam-reason');
  assert.match(line.body, /font-weight:\s*400/);
  assert.match(line.body, /font-size:\s*1rem/);
});

test('page/jam-view.js looks the reason ids up and writes them only through textContent and hidden', () => {
  const variables = { 'jam-reason': 'jamReason', 'jam-reason-lead': 'jamReasonLead', 'jam-reason-rest': 'jamReasonRest' };
  for (const [id, variable] of Object.entries(variables)) {
    assert.ok(viewCode.includes(`const ${variable} = document.getElementById('${id}');`), `the view must look up #${id}`);
    for (const use of viewCode.matchAll(new RegExp(`\\b${variable}\\.(\\w+)`, 'g'))) {
      assert.ok(['textContent', 'hidden'].includes(use[1]), `${variable}.${use[1]} is not a text-only write`);
    }
  }
  assert.match(viewCode, /function renderReason\(/);
  assert.match(viewCode, /renderReason\(model\.reason\)/);
});

// --- the scales that fit, listed under the scale ---

const CANDIDATE_IDS = ['jam-candidates', 'jam-candidates-label', 'jam-candidate-list', 'jam-candidates-more'];

test('the markup holds the four ids of the scales that fit exactly once, and one new class', () => {
  for (const id of CANDIDATE_IDS) {
    assert.equal(html.match(new RegExp(`\\bid="${id}"`, 'g'))?.length, 1, `#${id} must appear exactly once`);
  }
  assert.equal(html.match(/\bid="jam-cand[a-z-]*"/g).length, 4);
  // the class lives in the view's code, never in the markup, and nothing else of the page uses it
  assert.doesNotMatch(html, /class="jam-candidate"/);
  assert.match(viewCode, /className = 'jam-candidate'/);
});

test('the list of the scales that fit sits right after the reason line and before the degrees, hidden, named by its caption', () => {
  assert.ok(
    html.includes(
      '</p><div id="jam-candidates" role="group" aria-labelledby="jam-candidates-label" hidden><span id="jam-candidates-label"></span><div id="jam-candidate-list"></div><span id="jam-candidates-more" hidden></span></div><div id="jam-degrees"',
    ),
    'the block must sit between #jam-reason and #jam-degrees with its caption, its list and its count of the rest',
  );
  assert.ok(html.indexOf('id="jam-reason"') < html.indexOf('id="jam-candidates"') && html.indexOf('id="jam-candidates"') < html.indexOf('id="jam-degrees"'));
  assert.match(tagOf('jam-candidates').attributes, /\bhidden\b/);
  assert.match(tagOf('jam-candidates-more').attributes, /\bhidden\b/);
  for (const id of ['jam-candidates-label', 'jam-candidates-more', 'jam-candidate-list']) {
    for (const forbidden of ['tabindex', 'aria-live', 'contenteditable']) {
      assert.doesNotMatch(tagOf(id).attributes, new RegExp(`\\b${forbidden}\\b`), `#${id} must not carry ${forbidden}`);
    }
  }
});

function candidateRules() {
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (/#jam-candidate|\.jam-candidate/.test(selector)) rules.push({ selector, body: match[2] });
  }
  return rules;
}

test('the stylesheet hides the list and its count of the rest with their own [hidden] rules', () => {
  assert.match(css, /#jam-candidates\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#jam-candidates-more\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('the rules of the scales that fit use only text colours, the surface fill and hairlines, rem sizes, no motion', () => {
  const rules = candidateRules();
  assert.ok(rules.length >= 8, 'the rules of the scales that fit are missing');
  for (const { selector, body } of rules) {
    const where = `rule '${selector}'`;
    assert.doesNotMatch(body, /--accent|--destructive|--jam-/, `${where} must not use a reserved or Jam colour`);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${where} must use palette variables only`);
    assert.doesNotMatch(body, /\b(transition|animation|transform)\b/, `${where} must not move`);
    assert.doesNotMatch(selector, /data-motion/, `${where} depends on the motion mode`);
    assert.doesNotMatch(body, /^\s*--[\w-]+\s*:/m, `${where} declares a custom property`);
    // the only px is a one pixel hairline
    for (const px of body.matchAll(/(\d+(?:\.\d+)?)px\b/g)) assert.equal(px[1], '1', `${where}: ${px[0]}`);
    for (const variable of body.matchAll(/var\((--[\w-]+)\)/g)) {
      assert.ok(['--text', '--text-muted', '--border', '--surface-2'].includes(variable[1]), `${where}: ${variable[0]}`);
    }
    for (const size of body.matchAll(/font-size:\s*([^;]+);/g)) assert.equal(size[1].trim(), '0.8125rem', `${where}: font-size ${size[1]}`);
    for (const weight of body.matchAll(/font-weight:\s*([^;]+);/g)) assert.equal(weight[1].trim(), '400', `${where}: font-weight ${weight[1]}`);
  }
});

test('a candidate is a pointer target of at least 1.75rem with its name never cut, and the pressed one has a fill and an underline', () => {
  const rules = candidateRules();
  const base = rules.find((rule) => rule.selector === '.jam-candidate');
  assert.match(base.body, /min-height:\s*1\.75rem/);
  assert.match(base.body, /white-space:\s*nowrap/);
  assert.match(base.body, /border:\s*1px solid var\(--border\)/);
  const pressed = rules.find((rule) => rule.selector === 'button.jam-candidate[aria-pressed="true"]');
  assert.match(pressed.body, /background:\s*var\(--surface-2\)/);
  assert.match(pressed.body, /box-shadow:\s*inset 0 -0\.125rem 0 var\(--text\)/);
  const list = rules.find((rule) => rule.selector === '#jam-candidate-list');
  assert.match(list.body, /flex-wrap:\s*wrap/);
  // plain items are no control: no pointer cursor on the span, a pointer only on the button
  assert.doesNotMatch(rules.find((rule) => rule.selector === 'span.jam-candidate').body, /cursor/);
  assert.match(rules.find((rule) => rule.selector === 'button.jam-candidate').body, /cursor:\s*pointer/);
});

test('page/jam-view.js looks the four ids up and writes them only through textContent, dataset, hidden, attributes and children', () => {
  const variables = { 'jam-candidates': 'jamCandidates', 'jam-candidates-label': 'jamCandidatesLabel', 'jam-candidate-list': 'jamCandidateList', 'jam-candidates-more': 'jamCandidatesMore' };
  for (const [id, variable] of Object.entries(variables)) {
    assert.ok(viewCode.includes(`const ${variable} = document.getElementById('${id}');`), `the view must look up #${id}`);
    for (const use of viewCode.matchAll(new RegExp(`\\b${variable}\\.(\\w+)`, 'g'))) {
      assert.ok(['textContent', 'dataset', 'hidden', 'setAttribute', 'removeAttribute', 'replaceChildren'].includes(use[1]), `${variable}.${use[1]} is not a text-only write`);
    }
  }
  assert.match(viewCode, /function renderCandidates\(/);
  assert.match(viewCode, /renderCandidates\(model\.candidates\)/);
  assert.match(viewCode, /el\.textContent = item\.name/);
});

test('page/jam-view.js and the memory touch no browser storage, and main.js hands the choice to chooseJamScale', () => {
  const resolveCode = codeOf(read('../page/jam-resolve.js'));
  for (const [what, pattern] of MARKUP_WRITERS) {
    assert.doesNotMatch(resolveCode, pattern, `page/jam-resolve.js must not contain ${what}`);
  }
  assert.doesNotMatch(resolveCode, /\bdocument\b|\bwindow\b/);
  const mainCode = codeOf(read('../page/main.js'));
  assert.match(mainCode, /onScaleChoice: \(choice\) => chooseJamScale\(choice\)/);
  assert.equal(mainCode.match(/function chooseJamScale\(/g)?.length, 1);
  assert.equal(mainCode.match(/memory: jamScaleMemory/g)?.length, 1);
  assert.equal(mainCode.match(/jamScaleMemory\.keep\(/g)?.length, 1);
  const chooser = mainCode.slice(mainCode.indexOf('function chooseJamScale('), mainCode.indexOf('function chooseJamScale(') + 800);
  assert.doesNotMatch(chooser, /localStorage|sessionStorage|refreshJam|computePage/);
});
