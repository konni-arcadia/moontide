// Static half of the top bar's invariants: I1 (every id of the
// inventory exists exactly once), the lookups of the page modules, I9 (the bar's view modules build no markup) and
// the list of the ten invariant names. These tests read the sources and pass on today's markup
// before any restyle; the live half (visible, whole, one line, the state word, the accent rule, the fit step) is
// `npm run probe:page -- --only bar`. test/bar-inventory.js holds the data the probes share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProbeCouldNotRun, shotsFolder } from '../scripts/probe-page.mjs';
import { SPLIT_DEFAULTS } from '../page/split-model.js';
import { ACCENT_EXEMPT_TODAY, BAR_INVENTORY, BAR_WIDTHS, INVARIANTS, SHOT_LAYOUTS, SHOT_SIZES, SHOT_SKIPPED, SHOT_STATES, SIZED_CONTROLS, SIZED_FAMILIES, WORST_CASE, shotFileNames } from './bar-inventory.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const html = read('../page/index.html');
const css = read('../page/style.css');

/** A module's code without its comments, so a comment that names a forbidden call does not fail a test about code. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The view modules of the bar. A new view module of the bar is added here. */
const MODULES = [
  { path: 'page/top-bar-view.js', code: codeOf(read('../page/top-bar-view.js')) },
  { path: 'page/midi-view.js', code: codeOf(read('../page/midi-view.js')) },
  { path: 'page/ask-view.js', code: codeOf(read('../page/ask-view.js')) },
  { path: 'page/session-view.js', code: codeOf(read('../page/session-view.js')) },
  { path: 'page/bar-model.js', code: codeOf(read('../page/bar-model.js')) },
  { path: 'page/problem-view.js', code: codeOf(read('../page/problem-view.js')) },
  { path: 'page/split-view.js', code: codeOf(read('../page/split-view.js')) },
  { path: 'page/split-model.js', code: codeOf(read('../page/split-model.js')) },
];

/** The modules whose `document.getElementById('...')` lookups must each find an element in the HTML. */
const LOOKUP_SOURCES = [{ path: 'page/main.js', code: codeOf(read('../page/main.js')) }, ...MODULES];

const idCount = (id) => [...html.matchAll(new RegExp(`(?:^|[\\s<])id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))].length;

test('I1 (static): every id of BAR_INVENTORY appears exactly once as an id attribute of page/index.html', () => {
  assert.ok(BAR_INVENTORY.length > 0, 'the inventory is empty');
  const ids = BAR_INVENTORY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'an id is listed twice in BAR_INVENTORY');
  for (const entry of BAR_INVENTORY) {
    assert.ok(typeof entry.home === 'string' && entry.home !== '', `${entry.id} has no home`);
    assert.equal(idCount(entry.id), 1, `page/index.html must hold id="${entry.id}" exactly once`);
  }
});

test('every id that the page modules look up with getElementById exists in page/index.html', () => {
  let looked = 0;
  for (const source of LOOKUP_SOURCES) {
    const ids = [...source.code.matchAll(/document\.getElementById\(\s*'([\w-]+)'\s*\)/g)].map((match) => match[1]);
    for (const id of ids) {
      looked += 1;
      assert.ok(idCount(id) >= 1, `${source.path} looks up #${id}, which page/index.html does not hold`);
    }
  }
  assert.ok(looked >= 40, `expected the modules to look up many ids, found ${looked} (did the lookup shape change?)`);
});

// I9: the bar's views write text and attributes only, never markup.
const FORBIDDEN_MARKUP = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write\s*\(/],
];

for (const { path, code } of MODULES) {
  for (const [name, pattern] of FORBIDDEN_MARKUP) {
    test(`I9: ${path} holds no ${name}`, () => {
      assert.doesNotMatch(code, pattern, `${path} must not use ${name}: the bar's views write text, never markup`);
    });
  }
}

// The Session view never sends and never stores: it gets callbacks from page/main.js, which is
// the only place that writes to the socket and to localStorage. The pure model touches no document at all.
test('page/session-view.js neither sends nor stores, and page/bar-model.js has no document access', () => {
  const view = MODULES.find((module) => module.path === 'page/session-view.js').code;
  for (const pattern of [/\.send\(/, /\bfetch\(/, /\blocalStorage\b/, /\bsessionStorage\b/, /\.setItem\(/]) {
    assert.doesNotMatch(view, pattern, `page/session-view.js must not match ${pattern}`);
  }
  const model = MODULES.find((module) => module.path === 'page/bar-model.js').code;
  assert.doesNotMatch(model, /\bdocument\b|\bwindow\b|\blocalStorage\b/, 'page/bar-model.js is pure: no document, window or storage');
});

// The failed-change banner view: text only, no send, no storage; the clipboard is a callback.
test('page/problem-view.js neither sends nor stores and builds no markup', () => {
  const view = MODULES.find((module) => module.path === 'page/problem-view.js').code;
  for (const pattern of [/\.send\(/, /\bfetch\(/, /\blocalStorage\b/, /\bsessionStorage\b/, /\.setItem\(/, /\bexecCommand\b/, /\breadText\b/]) {
    assert.doesNotMatch(view, pattern, `page/problem-view.js must not match ${pattern}`);
  }
});

// The error line has one writer: page/main.js reaches #eval-error only through the banner view.
test('page/main.js never writes #eval-error itself', () => {
  const main = codeOf(read('../page/main.js'));
  assert.doesNotMatch(main, /getElementById\('eval-error'\)/, 'main.js must not look #eval-error up: the banner view owns it');
  assert.doesNotMatch(main, /\bevalErrorEl\b/, 'main.js must not hold a direct reference to the error line');
  assert.equal([...main.matchAll(/problemUi\.show\(/g)].length, 1, 'problemUi.show is called from exactly one place: showProblem');
  const writers = [...main.matchAll(/\bshowProblem\(/g)].length;
  assert.ok(writers >= 4, `showProblem is the one internal path of showEvalError, showHistoryProblem, showMixerProblem and showAskProblem (found ${writers} mentions)`);
});

// The banner popover branch sits in the page's single contextmenu listener, after the Shift, overlay and Ask box
// returns and before the Ask target is resolved; the popover is plain buttons (a group, not an ARIA menu).
test('the contextmenu listener opens the banner popover early, and the popover is a group of plain buttons', () => {
  const main = codeOf(read('../page/main.js'));
  const listener = main.indexOf("document.addEventListener('contextmenu'");
  assert.ok(listener > 0, 'main.js has the contextmenu listener');
  assert.equal([...main.matchAll(/document\.addEventListener\('contextmenu'/g)].length, 1, 'the page has one contextmenu listener');
  const guard = main.indexOf('event.shiftKey', listener);
  const branch = main.indexOf('problemUi.openMenu(', listener);
  const resolve = main.indexOf('resolveAskTarget(event)', listener);
  assert.ok(guard > listener && guard < branch && branch < resolve, 'Shift returns first, then the banner branch, then resolveAskTarget');
  assert.match(html, /<div id="problem-menu" role="group" hidden>/, 'the popover is a group, hidden at start');
  assert.doesNotMatch(html, /role="menu(item)?"/, 'no ARIA menu: it would oblige arrow-key navigation');
  const menuButtons = html.slice(html.indexOf('id="problem-menu"'), html.indexOf('id="session-strip"'));
  assert.equal([...menuButtons.matchAll(/<button type="button"/g)].length, 3, 'the popover holds three plain buttons');
});

test('the Session markup: one button, one drawer, one strip, the cards, and the moved ids live in the drawer', () => {
  const body = (id, tag) => {
    const open = html.indexOf(`id="${id}"`);
    assert.ok(open > 0, `page/index.html has no #${id}`);
    return { open, close: html.indexOf(`</${tag}>`, open) };
  };
  const drawer = html.indexOf('id="session-drawer"');
  const drawerEnd = html.indexOf('id="workspace"');
  assert.ok(drawer > 0 && drawer < drawerEnd, '#session-drawer sits before the workspace');
  const header = { start: html.indexOf('<header id="top-bar">'), end: html.indexOf('</header>') };
  for (const entry of BAR_INVENTORY) {
    const at = html.indexOf(`id="${entry.id}"`);
    if (entry.home === 'drawer' && entry.id !== 'session-drawer') {
      assert.ok(at > drawer && at < drawerEnd, `#${entry.id} lives in the drawer`);
    }
    if (entry.home === 'bar') assert.ok(at > header.start && at < header.end, `#${entry.id} lives in the bar`);
    if (entry.home === 'banner') {
      const banner = html.indexOf('id="problem-banner"');
      const strip = html.indexOf('id="session-strip"');
      assert.ok(at >= banner && at < strip, `#${entry.id} lives in the banner`);
    }
    if (entry.home === 'strip') {
      const strip = html.indexOf('id="session-strip"');
      assert.ok(at >= strip && at < drawer, `#${entry.id} lives in the strip`);
    }
  }
  body('session-button', 'button');
  for (const card of ['session-card-session', 'session-card-midi', 'session-card-requests', 'session-card-settings', 'session-card-change']) {
    const at = html.indexOf(`id="${card}"`);
    assert.ok(at > drawer && at < drawerEnd, `#${card} is a card of the drawer`);
  }
  assert.ok(html.indexOf('id="chrome"') < html.indexOf('<header id="top-bar">'), '#chrome wraps the header');
});

test('the invariant list is exactly I1 to I10, once each', () => {
  assert.deepEqual([...INVARIANTS], Array.from({ length: 10 }, (_, index) => `I${index + 1}`));
});

// I5 (static half): every sized control belongs to a family whose one shared rule gives it min-height and min-width of
// at least 1.75rem (the hit target of 24 CSS px at the smallest root font). The probe measures the real boxes.
const rootRules = (source) => {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(source.replace(/\/\*[\s\S]*?\*\//g, ''))) !== null) {
    rules.push({ selectors: match[1].split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')), body: match[2] });
  }
  return rules;
};
const remOf = (body, property) => {
  const found = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([\\d.]+)rem\\b`).exec(body);
  return found === null ? null : Number(found[1]);
};

test('I5 (static): every SIZED_CONTROLS selector belongs to a family whose rule sets min-height and min-width of at least 1.75rem', () => {
  assert.ok(SIZED_FAMILIES.length >= 13, 'the families of the bar, banner, strip, drawer and return banner are all listed');
  const rules = rootRules(css);
  const seen = new Set();
  for (const family of SIZED_FAMILIES) {
    assert.ok(family.controls.length > 0, `the family ${family.rule} lists no control`);
    for (const control of family.controls) {
      assert.ok(!seen.has(control), `${control} is listed in two families`);
      seen.add(control);
    }
    const holders = rules.filter((rule) => rule.selectors.includes(family.rule) && remOf(rule.body, 'min-height') !== null);
    assert.ok(holders.length > 0, `page/style.css has no rule with the selector "${family.rule}" and a min-height in rem`);
    for (const rule of holders) {
      assert.ok(remOf(rule.body, 'min-height') >= 1.75, `${family.rule}: min-height is ${remOf(rule.body, 'min-height')}rem, below 1.75rem`);
      assert.ok((remOf(rule.body, 'min-width') ?? 0) >= 1.75, `${family.rule}: min-width is ${remOf(rule.body, 'min-width')}rem, below 1.75rem`);
    }
  }
  assert.deepEqual([...seen].sort(), [...SIZED_CONTROLS].sort(), 'SIZED_CONTROLS is exactly the controls of the families');
  // Nothing in the stylesheet sizes one of these controls below the hit target with a 1.5rem minimum: that was the old size.
  for (const family of SIZED_FAMILIES) {
    for (const rule of rules.filter((candidate) => candidate.selectors.includes(family.rule))) {
      assert.doesNotMatch(rule.body, /min-(height|width)\s*:\s*1\.5rem/, `${family.rule} must not shrink to 1.5rem`);
    }
  }
});

test('I5 (static): every button of the chrome in page/index.html is covered by a SIZED_CONTROLS family', () => {
  const chrome = html.slice(html.indexOf('id="chrome"'), html.indexOf('id="workspace"'));
  const ids = [...chrome.matchAll(/<button\b[^>]*\bid="([\w-]+)"/g)].map((match) => match[1]);
  const banner = html.slice(html.indexOf('id="midi-banner"'), html.indexOf('id="audio-unlock-overlay"'));
  ids.push(...[...banner.matchAll(/<button\b[^>]*\bid="([\w-]+)"/g)].map((match) => match[1]));
  assert.ok(ids.length >= 14, `expected the chrome to hold many buttons, found ${ids.length}`);
  const buttonsWithoutId = [...chrome.matchAll(/<button\b(?![^>]*\bid=)[^>]*>/g)].length;
  assert.equal(buttonsWithoutId, 0, 'every button written in page/index.html has an id; the groups made by script are sized by their family rule');
  for (const id of ids) {
    assert.ok(SIZED_CONTROLS.includes(`#${id}`), `#${id} is a button of the chrome and is not in SIZED_CONTROLS`);
  }
});

// No view module sets a pixel size of a control. The sizes live in page/style.css (rem), so the root font scales
// them. The two writes that exist are not controls: the Ask box's text field grows to its text, and the failed-change popover
// is placed at the pointer.
test('no view module sets a pixel width or height on an element (the sizes are rem rules in the stylesheet)', () => {
  const allowed = new Map([
    ['page/ask-view.js', ['askField.style.height']],
    ['page/problem-view.js', []],
  ]);
  for (const { path, code } of MODULES) {
    const writes = [...code.matchAll(/(\w+)\.style\.(width|height|minWidth|minHeight|maxWidth|maxHeight)\s*=/g)].map((match) => `${match[1]}.style.${match[2]}`);
    const permitted = allowed.get(path) ?? [];
    for (const write of writes) assert.ok(permitted.includes(write), `${path} sets ${write}: sizes belong in page/style.css`);
    assert.doesNotMatch(code, /\.style\.cssText\b|\.setProperty\(\s*['"](width|height|min-width|min-height)/, `${path} must not write a size through cssText or setProperty`);
    assert.doesNotMatch(code, /setAttribute\(\s*['"](width|height|style)['"]/, `${path} must not write a width, height or style attribute`);
  }
});

test('the sweep widths and the sized controls are well formed', () => {
  assert.deepEqual([...BAR_WIDTHS], [1024, 1280, 1366, 1440, 1920, 2560, 3840]);
  assert.ok(SIZED_CONTROLS.length > 0, 'SIZED_CONTROLS is empty');
  for (const selector of SIZED_CONTROLS) {
    assert.ok(typeof selector === 'string' && selector !== '', 'a sized control selector must be a non-empty string');
  }
});

test('every WORST_CASE entry is a non-empty string (a renamed copy constant fails here)', () => {
  const entries = Object.entries(WORST_CASE);
  assert.ok(entries.length >= 10, 'WORST_CASE lost entries');
  for (const [name, text] of entries) {
    assert.ok(typeof text === 'string' && text !== '', `WORST_CASE.${name} must be a non-empty string, got ${JSON.stringify(text)}`);
  }
});

test('the accent exemptions of I4 are inventory ids (the list is empty since Connected became plain text and must never grow silently)', () => {
  const ids = BAR_INVENTORY.map((entry) => entry.id);
  for (const id of ACCENT_EXEMPT_TODAY) assert.ok(ids.includes(id), `${id} is exempt from I4 but not in BAR_INVENTORY`);
  assert.deepEqual([...ACCENT_EXEMPT_TODAY], [], 'nothing is accent-colored besides the live state since Connected became plain text');
});

// I10, the separator. The markup carries the ARIA contract, sits between the editor and the view, and the
// split code neither sends, stores nor measures CodeMirror by hand.
test('the separator is a focusable div with role separator between the editor and the view, with the ARIA contract', () => {
  assert.equal(idCount('split-handle'), 1);
  const tag = html.match(/<div id="split-handle"[^>]*>/)?.[0];
  assert.ok(tag, 'page/index.html holds div#split-handle');
  for (const attribute of ['role="separator"', 'tabindex="0"', 'aria-controls="view-panel"', 'aria-valuemin="15"', 'aria-valuemax="85"', 'aria-orientation="horizontal"']) {
    assert.ok(tag.includes(attribute), `#split-handle needs ${attribute}`);
  }
  assert.ok(tag.includes(`aria-valuenow="${SPLIT_DEFAULTS.a}"`), 'the markup starts at the layout a default');
  assert.ok(!/aria-valuetext="(?!View \d+ percent")/.test(tag), 'the starting value text names the size');
  const editor = html.indexOf('id="editor-area"');
  const handle = html.indexOf('id="split-handle"');
  const panel = html.indexOf('id="view-panel"');
  assert.ok(editor > 0 && editor < handle && handle < panel, 'the handle sits between #editor-area and #view-panel');
  assert.ok(html.indexOf('id="workspace"') < handle, 'the handle is inside #workspace');
  assert.equal(idCount('split-readout'), 1);
  assert.equal(idCount('split-status'), 1);
  assert.match(html, /<div id="split-status" role="status" aria-live="polite">/);
});

test('the split view neither sends nor stores, and the split model is pure', () => {
  const view = MODULES.find((module) => module.path === 'page/split-view.js').code;
  for (const pattern of [/\.send\(/, /\bfetch\(/, /\blocalStorage\b/, /\bsessionStorage\b/, /\.setItem\(/]) {
    assert.doesNotMatch(view, pattern, `page/split-view.js must not match ${pattern}`);
  }
  const model = MODULES.find((module) => module.path === 'page/split-model.js').code;
  assert.doesNotMatch(model, /\bdocument\b|\bwindow\b|\blocalStorage\b/, 'page/split-model.js is pure: no document, window or storage');
});

// CodeMirror reflows by itself (its own ResizeObserver). Nothing that applies a size calls a manual measure. The Mixer's
// lit strip uses view.requestMeasure for its own overlay since the mixer fixes; that is not the editor reflow and is not touched here.
test('no manual CodeMirror measure call in the separator code', () => {
  const main = codeOf(read('../page/main.js'));
  for (const name of ['applySplit', 'refreshAfterSize', 'markNarrowSpans', 'renderSplit']) {
    const start = main.indexOf(`function ${name}(`);
    assert.ok(start > 0, `page/main.js has ${name}`);
    const rest = main.slice(start + 1);
    const end = rest.search(/^function |^async function |^const \w+ = /m);
    const body = rest.slice(0, end > 0 ? end : rest.length);
    assert.doesNotMatch(body, /requestMeasure|\.measure\(/, `${name} must not call a manual measure`);
  }
  for (const path of ['page/split-view.js', 'page/split-model.js']) {
    assert.doesNotMatch(MODULES.find((module) => module.path === path).code, /requestMeasure/, `${path} must not call a manual measure`);
  }
});

test('the size reaches the page only as the model\'s number: the CSS variable is written from a clamped, rounded number', () => {
  const main = codeOf(read('../page/main.js'));
  const writes = [...main.matchAll(/setProperty\(\s*'--view-size'\s*,\s*([^)]*)\)/g)].map((match) => match[1].replace(/\s+/g, ' ').trim());
  assert.deepEqual(writes.sort(), ['`${size}%`', '`${splitSizes[layout]}%`'].sort(), 'the variable is written in two places, both from a number');
  const apply = main.slice(main.indexOf('function applySplit('));
  assert.match(apply.slice(0, apply.indexOf('\n}\n')), /const size = Math\.round\(clampSplit\(value\) \* 10\) \/ 10;/);
  assert.match(css, /#view-panel\s*\{[^}]*height:\s*var\(--view-size,\s*42%\)/, 'layout a default 42%');
  assert.match(css, /#workspace\[data-layout="b"\] #view-panel\s*\{[^}]*width:\s*var\(--view-size,\s*45%\)/, 'layout b default 45%');
});

// The screenshots lane writes only outside the repository. Pictures of the page can show local state.
test('shotsFolder: unset gives null, a folder inside the repository is refused, a temporary folder outside is returned', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(shotsFolder({}), null);
  assert.equal(shotsFolder({ MOONTIDE_PROBE_SHOTS: '' }), null);
  assert.equal(shotsFolder({ MOONTIDE_PROBE_SHOTS: '   ' }), null);
  const inside = nodePath.join(repo, 'shots-must-not-exist');
  for (const bad of [inside, repo, nodePath.join(repo, 'a', '..', 'b'), nodePath.join(repo, 'scripts')]) {
    assert.throws(() => shotsFolder({ MOONTIDE_PROBE_SHOTS: bad }), (err) => err instanceof ProbeCouldNotRun && /outside the repository/.test(err.message), bad);
  }
  assert.equal(existsSync(inside), false, 'a refused folder is not created');
  const base = mkdtempSync(nodePath.join(tmpdir(), 'moontide-shots-test-'));
  try {
    const wanted = nodePath.join(base, 'nested', 'shots');
    assert.equal(shotsFolder({ MOONTIDE_PROBE_SHOTS: wanted }), nodePath.resolve(wanted));
    assert.equal(existsSync(wanted), true, 'the folder is created');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('probe:page with MOONTIDE_PROBE_SHOTS inside the repository stops with exit code 2 before any browser work and writes nothing', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const inside = nodePath.join(repo, 'shots-must-not-exist');
  const run = spawnSync(process.execPath, [nodePath.join(repo, 'scripts', 'probe-page.mjs'), '--only', 'bar'], {
    env: { ...process.env, MOONTIDE_PROBE_SHOTS: inside },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /COULD NOT RUN: MOONTIDE_PROBE_SHOTS must name a folder outside the repository/);
  assert.equal(existsSync(inside), false);
});

test('the screenshot matrix names every file once, from its constants only, and skips the split state in layout c', () => {
  const names = shotFileNames();
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, SHOT_STATES.length * SHOT_SIZES.length * SHOT_LAYOUTS.length - SHOT_SKIPPED.length * SHOT_SIZES.length);
  for (const name of names) assert.match(name, /^bar-[a-z-]+-\d+x\d+-layout-[abc]\.png$/);
  assert.ok(names.includes('bar-playing-1366x768-layout-a.png'));
  assert.ok(!names.some((name) => name.startsWith('bar-split-') && name.endsWith('layout-c.png')));
});
