// Contract test for elements the page shows and hides with the `hidden` attribute.
// An author `display:` rule on `#id` beats the browser's `[hidden] { display: none }`,
// so setting `.hidden = true` would silently do nothing. Every such element needs its own
// `#id[hidden] { display: none; }` rule. This is what kept the audio-unlock overlay on
// screen after a successful click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS_PATH = fileURLToPath(new URL('../page/style.css', import.meta.url));
const MAIN_PATH = fileURLToPath(new URL('../page/main.js', import.meta.url));
const HISTORY_VIEW_PATH = fileURLToPath(new URL('../page/history-view.js', import.meta.url));
const MIXER_VIEW_PATH = fileURLToPath(new URL('../page/mixer-view.js', import.meta.url));
const ASK_VIEW_PATH = fileURLToPath(new URL('../page/ask-view.js', import.meta.url));
const JAM_VIEW_PATH = fileURLToPath(new URL('../page/jam-view.js', import.meta.url));
const MIDI_VIEW_PATH = fileURLToPath(new URL('../page/midi-view.js', import.meta.url));
const TOP_BAR_VIEW_PATH = fileURLToPath(new URL('../page/top-bar-view.js', import.meta.url));
const PROBLEM_VIEW_PATH = fileURLToPath(new URL('../page/problem-view.js', import.meta.url));
const SESSION_VIEW_PATH = fileURLToPath(new URL('../page/session-view.js', import.meta.url));
const REQUEST_STATUS_VIEW_PATH = fileURLToPath(new URL('../page/request-status-view.js', import.meta.url));
const LOAD_FAILURE_VIEW_PATH = fileURLToPath(new URL('../page/load-failure-view.js', import.meta.url));
const STRUCTURE_VIEW_PATH = fileURLToPath(new URL('../page/structure-view.js', import.meta.url));
const SONG_GRID_VIEW_PATH = fileURLToPath(new URL('../page/song-grid-view.js', import.meta.url));
const SPLIT_VIEW_PATH = fileURLToPath(new URL('../page/split-view.js', import.meta.url));
const INSTRUMENTS_VIEW_PATH = fileURLToPath(new URL('../page/instruments-view.js', import.meta.url));
const HTML_PATH = fileURLToPath(new URL('../page/index.html', import.meta.url));

const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Every page source that looks elements up itself and toggles them with .hidden.
const sources = [
  { path: 'page/main.js', text: readFileSync(MAIN_PATH, 'utf8') },
  { path: 'page/history-view.js', text: readFileSync(HISTORY_VIEW_PATH, 'utf8') },
  { path: 'page/mixer-view.js', text: readFileSync(MIXER_VIEW_PATH, 'utf8') },
  { path: 'page/ask-view.js', text: readFileSync(ASK_VIEW_PATH, 'utf8') },
  { path: 'page/jam-view.js', text: readFileSync(JAM_VIEW_PATH, 'utf8') },
  { path: 'page/midi-view.js', text: readFileSync(MIDI_VIEW_PATH, 'utf8') },
  { path: 'page/top-bar-view.js', text: readFileSync(TOP_BAR_VIEW_PATH, 'utf8') },
  { path: 'page/session-view.js', text: readFileSync(SESSION_VIEW_PATH, 'utf8') },
  { path: 'page/request-status-view.js', text: readFileSync(REQUEST_STATUS_VIEW_PATH, 'utf8') },
  { path: 'page/problem-view.js', text: readFileSync(PROBLEM_VIEW_PATH, 'utf8') },
  { path: 'page/instruments-view.js', text: readFileSync(INSTRUMENTS_VIEW_PATH, 'utf8') },
  { path: 'page/split-view.js', text: readFileSync(SPLIT_VIEW_PATH, 'utf8') },
  { path: 'page/load-failure-view.js', text: readFileSync(LOAD_FAILURE_VIEW_PATH, 'utf8') },
  { path: 'page/structure-view.js', text: readFileSync(STRUCTURE_VIEW_PATH, 'utf8') },
  { path: 'page/song-grid-view.js', text: readFileSync(SONG_GRID_VIEW_PATH, 'utf8') },
];

// Elements a view is handed by the page instead of looking them up itself: the variable name, by source.
const INJECTED_IDS = new Map([
  ['page/structure-view.js', new Map([['notes', 'song-notes']])],
  ['page/song-grid-view.js', new Map([['bar', 'song-bar'], ['now', 'song-now'], ['line', 'song-line'], ['list', 'song-cell-list']])],
]);

/** Maps each `const x = document.getElementById('id')` variable name to its id. */
function elementIdsByVariable(source) {
  const ids = new Map();
  const re = /const (\w+) = document\.getElementById\('([\w-]+)'\)/g;
  let match;
  while ((match = re.exec(source)) !== null) ids.set(match[1], match[2]);
  return ids;
}

/** Returns the declaration block of the rule whose selector is exactly `selector`, or null. */
function ruleBody(selector) {
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css)) !== null) {
    const selectors = match[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

test('every element toggled with .hidden and given a display rule has an #id[hidden] rule', () => {
  for (const { path, text } of sources) {
    const ids = elementIdsByVariable(text);
    const toggledVars = new Set([...text.matchAll(/(\w+)\.hidden = /g)].map((m) => m[1]));
    assert.ok(toggledVars.size > 0, `expected ${path} to toggle at least one element with .hidden`);

    for (const variable of toggledVars) {
      const id = ids.get(variable) ?? INJECTED_IDS.get(path)?.get(variable);
      assert.ok(id, `${path} toggles ${variable}.hidden but ${variable} is not a getElementById constant`);
      const body = ruleBody(`#${id}`);
      if (body === null || !/\bdisplay\s*:/.test(body)) continue;
      const hiddenBody = ruleBody(`#${id}[hidden]`);
      assert.ok(hiddenBody, `#${id} sets display, so page/style.css needs #${id}[hidden] { display: none; }`);
      assert.match(hiddenBody, /display\s*:\s*none/, `#${id}[hidden] must set display: none`);
    }
  }
});

// Elements the views create by class and show with toggleAttribute('hidden', ...): the same trap as
// the ids above, a class display rule beats the browser's [hidden] rule. Later Mixer plans extend
// this list with their own classes.
const HIDDEN_CLASSES = ['.mx-note', '.mx-add-list', '.mx-more', '.mx-insp-gone', '.mx-written', '.mx-insp-footer', '.mx-warning', '.mx-midi-note', '.mx-sweep', '.mx-tag', '.mx-shared', '.mx-insp-shared', '.mx-root-note', '.instrument-edit', '.tl-note-controls', '.rq-count', '.rq-detail', '.rq-recent-body'];

test('every class shown with the hidden attribute and given a display rule has a [hidden] rule', () => {
  for (const selector of HIDDEN_CLASSES) {
    const body = ruleBody(selector);
    assert.ok(body !== null, `page/style.css has no rule for ${selector}`);
    if (!/\bdisplay\s*:/.test(body)) continue;
    const hiddenBody = ruleBody(`${selector}[hidden]`);
    assert.ok(hiddenBody, `${selector} sets display, so page/style.css needs ${selector}[hidden] { display: none; }`);
    assert.match(hiddenBody, /display\s*:\s*none/, `${selector}[hidden] must set display: none`);
  }
});

// The note panel under the Timeline lanes is shown and hidden by the edit view with the hidden attribute, and so is the group of
// its controls. Both have a display rule, so both need their own [hidden] rule, and the markup starts the panel hidden.
test('the Timeline note panel and its controls have their own [hidden] rules, and the view toggles them', () => {
  for (const selector of ['#timeline-note', '.tl-note-controls']) {
    const body = ruleBody(selector);
    assert.ok(body !== null, `page/style.css has no rule for ${selector}`);
    assert.match(body, /\bdisplay\s*:/, `${selector} sets display`);
    const hiddenBody = ruleBody(`${selector}[hidden]`);
    assert.ok(hiddenBody, `${selector} sets display, so page/style.css needs ${selector}[hidden] { display: none; }`);
    assert.match(hiddenBody, /display\s*:\s*none/, `${selector}[hidden] must set display: none`);
  }
  const view = readFileSync(fileURLToPath(new URL('../page/timeline-edit-view.js', import.meta.url)), 'utf8');
  assert.match(view, /setHidden\(panel,/, 'the view hides and shows the panel');
  assert.match(view, /setHidden\(controls,/, 'the view hides and shows the controls');
  assert.match(readFileSync(HTML_PATH, 'utf8'), /<section id="timeline-note"[^>]*\bhidden\b/, 'the panel starts hidden');
});

// The instruments are words only, so the MIDI view looks up exactly the
// ids listed below. A new element would show up here first.
test('page/midi-view.js looks up exactly the listed MIDI ids and no new one', () => {
  const midiView = sources.find((source) => source.path === 'page/midi-view.js');
  const ids = Array.from(elementIdsByVariable(midiView.text).values()).sort();
  const phase10 = [
    'midi-takeover',
    'midi-takeover-text',
    'take-back',
    'midi-state',
    'midi-dots',
    'midi-state-text',
    'midi-info',
    'midi-help',
    'midi-banner',
    'midi-banner-text',
    'midi-banner-dismiss',
  ].sort();
  assert.deepEqual(ids, phase10);
});

// The top bar's tempo readout, countdown, setting and
// status line. The three toggled items carry no display rule, so the browser's [hidden] works unaided; the
// markup order places the new items where the contract says; none of them moves.
const html = readFileSync(HTML_PATH, 'utf8');
const NEW_TOP_BAR_SELECTORS = [
  '#tempo-readout',
  '#top-bar #tempo-readout',
  '#tempo-readout .tempo-num',
  '#pending-change',
  '#top-bar #pending-change',
  '#change-status',
  '#change-timing',
  '#change-timing button',
  '#change-timing button:hover',
  '#change-timing button:focus-visible',
  '#change-timing button[aria-pressed="true"]',
];

test('the tempo readout, the countdown and the status line have no display rule, so [hidden] works unaided', () => {
  for (const selector of ['#tempo-readout', '#top-bar #tempo-readout', '#pending-change', '#top-bar #pending-change', '#change-status']) {
    const body = ruleBody(selector);
    if (body === null) continue;
    assert.doesNotMatch(body, /\bdisplay\s*:/, `${selector} must not set display`);
  }
});

// The tempo readout is always in the bar, so nothing hides it: no hidden attribute in the markup, no
// hidden assignment in the view or the page, and no rule that gives it a display.
test('the tempo readout has no hidden attribute and neither the view nor the page ever hides it', () => {
  const tag = /<span\b[^>]*\bid="tempo-readout"[^>]*>/.exec(html);
  assert.ok(tag, 'page/index.html needs #tempo-readout');
  assert.doesNotMatch(tag[0], /\bhidden\b/, '#tempo-readout must not carry the hidden attribute');
  assert.match(html, /<span class="tempo-arrow"><\/span>/, 'the readout holds the arrow part between the number and the unit');
  const view = readFileSync(new URL('../page/top-bar-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view.replace(/\/\/.*$/gm, ''), /tempoReadout\.hidden\s*=/, 'top-bar-view.js never assigns the readout hidden property');
  const main = readFileSync(new URL('../page/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main.replace(/\/\/.*$/gm, ''), /getElementById\('tempo-readout'\)[^;]*hidden\s*=/, 'main.js never hides the readout');
  assert.doesNotMatch(css, /#tempo-readout\[hidden\]/, 'no rule hides the readout');
});

test('none of the new top-bar selectors has a transition, an animation or a [data-motion] rule', () => {
  for (const selector of NEW_TOP_BAR_SELECTORS) {
    const body = ruleBody(selector);
    if (body === null) continue;
    assert.doesNotMatch(body, /\b(transition|animation)\b/, `${selector} must not animate`);
  }
  assert.doesNotMatch(css, /\[data-motion[^\]]*\][^{}]*#(tempo-readout|pending-change|change-status|change-timing)/);
  assert.doesNotMatch(css, /#(tempo-readout|pending-change|change-status|change-timing)[^{}]*\[data-motion/);
});

// The four steps in order. Each row is a step and what it gives up; a step includes every
// earlier one, so a piece first given up at step k has its display: none rule at every step from k to 4 and at no
// earlier step. Selectors are attribute selectors on #top-bar (the stylesheet has no at-rule).
const FIT_TABLE = [
  { step: 1, pieces: ['.bar-deco'] },
  { step: 2, pieces: ['#view-buttons button[aria-pressed="false"] .view-name'] },
  { step: 3, pieces: ['.pending-lead', '.tempo-unit', '.layout-word', '.state-here'] },
  { step: 4, pieces: ['.bar-sep'] },
];

test('the top-bar fit steps give up pieces in the order of the contract, each step including the earlier ones', () => {
  for (const { step: first, pieces } of FIT_TABLE) {
    for (const piece of pieces) {
      for (let step = 1; step <= 4; step += 1) {
        const body = ruleBody(`#top-bar[data-fit="${step}"] ${piece}`);
        if (step < first) {
          assert.equal(body, null, `${piece} must not be given up before step ${first} (rule found at step ${step})`);
        } else {
          assert.ok(body, `page/style.css needs a rule for #top-bar[data-fit="${step}"] ${piece}`);
          assert.match(body, /display\s*:\s*none/, `${piece} is hidden at step ${step}`);
        }
      }
    }
  }
});

test('fit step 4 tightens the spacing: the bar gap and padding, the button padding', () => {
  const bar = ruleBody('#top-bar[data-fit="4"]');
  assert.ok(bar, 'page/style.css needs a rule for #top-bar[data-fit="4"]');
  assert.match(bar, /gap\s*:\s*0\.25rem/);
  assert.match(bar, /padding\s*:\s*0 0\.5rem/);
  assert.match(ruleBody('#top-bar[data-fit="4"] #view-buttons button'), /padding\s*:\s*0 0\.25rem/);
  assert.match(ruleBody('#top-bar[data-fit="4"] #transport-button'), /padding\s*:\s*0 0\.5rem/);
});

test('the fit steps are attribute selectors only: no at-rule, no key hint selector, no overflow hidden on the bar, no motion', () => {
  assert.doesNotMatch(css, /@/, 'no at-rule in page/style.css');
  assert.doesNotMatch(css, /key-?hint/i, 'no key hint selector remains');
  const bar = ruleBody('#top-bar');
  assert.ok(bar, 'page/style.css needs a #top-bar rule');
  assert.doesNotMatch(bar, /overflow/, 'the bar has no overflow rule: its own overflow is what the fit loop measures');
  const fitRules = css.match(/[^{}]*data-fit[^{}]*\{[^}]*\}/g) ?? [];
  assert.ok(fitRules.length >= 8, 'the fit rules are there');
  for (const rule of fitRules) {
    assert.doesNotMatch(rule, /\b(transition|animation)\b|\[data-motion/, 'a fit rule must not animate or follow the motion switch');
  }
});

// The loop itself: one pure function of the widths. It restarts at the first step, tests the bar's own overflow and
// observes the bar and every direct child.
test('the fit loop restarts at the first step, measures scrollWidth against clientWidth, and watches every child', () => {
  const view = readFileSync(TOP_BAR_VIEW_PATH, 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(view, /topBar\.scrollWidth\s*>\s*topBar\.clientWidth/);
  assert.match(view, /let step = FIT_STEPS\[0\]/);
  assert.match(view, /for \(const child of topBar\.children\) observer\.observe\(child\)/);
  assert.match(view, /observer\.observe\(topBar\)/);
});

// The cycle and beat is quiet decoration beside the tempo: aria-hidden, dropped by step 1, hidden by the
// attribute (so no display rule), drawn in mono and muted.
test('the cycle and beat is aria-hidden decoration that fit step 1 drops and that has no display rule', () => {
  assert.match(html, /<span id="cycle-beat" class="bar-deco" aria-hidden="true" hidden><\/span>/);
  const rule = ruleBody('#top-bar #cycle-beat');
  assert.ok(rule, 'page/style.css needs a #top-bar #cycle-beat rule');
  assert.doesNotMatch(rule, /\bdisplay\s*:/, 'the hidden attribute hides it, so no display rule');
  assert.match(rule, /font-family\s*:\s*var\(--font-mono\)/);
  assert.match(rule, /color\s*:\s*var\(--text-muted\)/);
  assert.match(rule, /white-space\s*:\s*nowrap/);
  const view = readFileSync(TOP_BAR_VIEW_PATH, 'utf8');
  assert.match(view, /function showCycleBeat\(model\)/);
  assert.doesNotMatch(view, /cycleBeatEl\.setAttribute\('aria-live'/, 'no live region');
});

// The DOM order of the header is the Tab order and the visual order; nothing is moved by CSS order.
test('the header holds the bar items in the order of the contract, and the banner sits between the header and the strip', () => {
  const headerStart = html.indexOf('<header id="top-bar">');
  const headerEnd = html.indexOf('</header>');
  const header = html.slice(headerStart, headerEnd);
  const order = [
    'id="product-name"',
    'id="transport-button"',
    'id="sound-state"',
    'id="tempo-readout"',
    'id="cycle-beat"',
    'id="pending-change"',
    'id="change-status"',
    'class="bar-sep"',
    'id="view-buttons"',
    'id="bar-spacer"',
    'class="layout-word"',
    'id="layout-buttons"',
    'class="bar-sep"',
    'id="requests-toggle"',
    'id="session-button"',
  ];
  let from = 0;
  for (const marker of order) {
    const at = header.indexOf(marker, from);
    assert.ok(at >= 0, `the header needs ${marker} after the previous item`);
    from = at + marker.length;
  }
  assert.equal((header.match(/class="bar-sep"/g) ?? []).length, 2, 'two separators');
  assert.doesNotMatch(css, /^\s*order\s*:/m, 'no CSS order rule: the DOM order is the visual order');
  const banner = html.indexOf('id="problem-banner"');
  const evalError = html.indexOf('id="eval-error"');
  const alert = html.indexOf('id="problem-alert"');
  const strip = html.indexOf('id="session-strip"');
  assert.ok(html.indexOf('id="chrome"') < headerEnd && headerEnd < banner && banner < evalError && evalError < strip, 'the banner sits after the header and before the strip in #chrome, and #eval-error is inside it');
  assert.ok(evalError < alert && alert < strip, 'the alert region follows the banner');
});

// The drawer's cards hold the items that left the bar; inside the Settings card the setting sits before the motion switch.
test('the drawer cards hold the moved items in the order of the contract', () => {
  const drawer = html.indexOf('id="session-drawer"');
  const at = (id) => {
    const index = html.indexOf(`id="${id}"`);
    assert.ok(index > drawer, `#${id} sits inside the drawer, after its opening tag`);
    return index;
  };
  const order = ['connection-state', 'build-mismatch', 'midi-takeover', 'midi-state', 'page-requests', 'change-timing', 'motion-switch', 'version-indicator'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the cards read: Session, MIDI, Page requests, Settings, Last change');
});

// The card rules hide a card whose status item is hidden through :has(), so no display toggle of JS is involved.
test('a card whose status item is hidden is not rendered, by a rule with its own selector', () => {
  assert.ok(ruleBody('#session-card-midi:has(#midi-state[hidden])'), 'the MIDI card hides with its indicator');
  assert.ok(ruleBody('#session-card-requests:has(#page-requests[hidden])'), 'the Page requests card hides with its status');
  assert.match(ruleBody('#session-card-midi:has(#midi-state[hidden])'), /display\s*:\s*none/);
  assert.match(ruleBody('#session-card-requests:has(#page-requests[hidden])'), /display\s*:\s*none/);
});

// The Song toolbar sits in the Parts view after the notes and before the rows, and both it and its sentence start hidden;
// each has its own [hidden] rule because each has a display rule.
test('the song toolbar and its sentence are in the Parts view, start hidden and have a [hidden] rule', () => {
  const view = html.slice(html.indexOf('<div id="parts-view"'), html.indexOf('<div id="jam-view"'));
  assert.equal((html.match(/id="song-bar"/g) ?? []).length, 1);
  assert.equal((html.match(/id="song-now"/g) ?? []).length, 1);
  assert.match(view, /<div id="song-bar" hidden>/);
  assert.match(view, /<p id="song-now" hidden><\/p>/);
  assert.match(view, /<div id="song-launch" role="group"/);
  assert.equal((html.match(/id="song-line"/g) ?? []).length, 1);
  assert.match(view, /<p id="song-line" hidden role="status" aria-live="polite"><\/p>/);
  assert.ok(view.indexOf('id="song-notes"') < view.indexOf('id="song-bar"') && view.indexOf('id="song-bar"') < view.indexOf('id="song-line"') && view.indexOf('id="song-line"') < view.indexOf('id="parts-rows"'), 'notes, then the toolbar, then its sentence, then the rows');
  for (const id of ['song-bar', 'song-now', 'song-line']) {
    assert.match(ruleBody(`#${id}[hidden]`) ?? '', /display\s*:\s*none/, `#${id}[hidden] hides it`);
  }
});

// The list that opens on a cell is the last thing in the Parts view, outside the grid's scroller, hidden at the start.
test('the cell list is in the Parts view after the rows, starts hidden as a listbox and has a [hidden] rule', () => {
  const view = html.slice(html.indexOf('<div id="parts-view"'), html.indexOf('<div id="jam-view"'));
  assert.equal((html.match(/id="song-cell-list"/g) ?? []).length, 1);
  assert.match(view, /<div id="song-cell-list" hidden role="listbox" tabindex="-1"><\/div>/);
  assert.ok(view.indexOf('id="parts-rows"') < view.indexOf('id="song-cell-list"'), 'after the rows, so it is outside the scroller');
  assert.match(ruleBody('#song-cell-list[hidden]') ?? '', /display\s*:\s*none/);
  const body = ruleBody('#song-cell-list') ?? '';
  assert.match(body, /position\s*:\s*fixed/);
  assert.match(body, /max-height\s*:\s*16rem/);
  assert.doesNotMatch(body, /\b(transition|animation)\b/);
});

test('the song launch group shares the three segmented-group rules and none of the new song rules animates', () => {
  for (const selector of ['#song-launch', '#song-launch button', '#song-launch button:hover', '#song-launch button[aria-pressed="true"]', '#song-launch button:focus-visible']) {
    assert.ok(ruleBody(selector), `page/style.css needs a rule for ${selector}`);
  }
  for (const selector of ['#song-bar', '#song-launch-label', '#song-now', '#song-line', '.song-grid', '.song-grid-scroll', '.song-head', '.song-cell', '.song-fold', '#parts-rows[data-view="song"]']) {
    const body = ruleBody(selector);
    assert.ok(body, `page/style.css needs a rule for ${selector}`);
    assert.doesNotMatch(body, /\b(transition|animation)\b/, `${selector} must not animate`);
  }
  assert.doesNotMatch(css, /\[data-motion[^\]]*\][^{}]*\.song-/);
});
