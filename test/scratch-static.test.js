// Static contracts of the Scratchpad: the markup holds each id once and starts hidden, the stylesheet draws it in rem and neutral
// colors only with no motion, and the two modules that hold the motif and draw it write no markup, open no socket, touch no browser
// storage and make no sound. These tests read the sources; the live view is proved by `npm run probe:page -- --only scratch`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GUTTER_REM } from '../page/scratch-gesture.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const html = read('../page/index.html');
const css = read('../page/style.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** A module's code without its comments, so a comment that names a forbidden call does not fail a test about code. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}
const MODULES = [
  ['page/scratch-model.js', codeOf(read('../page/scratch-model.js'))],
  ['page/scratch-view.js', codeOf(read('../page/scratch-view.js'))],
  ['page/scratch-gesture.js', codeOf(read('../page/scratch-gesture.js'))],
];

const IDS = [
  'scratch-view',
  'scratch-controls',
  'scratch-grids',
  'scratch-grid-quarter',
  'scratch-grid-eighth',
  'scratch-grid-sixteenth',
  'scratch-grid-eighth-triplet',
  'scratch-grid-sixteenth-triplet',
  'scratch-length',
  'scratch-fewer',
  'scratch-cycles',
  'scratch-more',
  'scratch-pitch',
  'scratch-lower',
  'scratch-window',
  'scratch-higher',
  'scratch-mode',
  'scratch-draw',
  'scratch-tap',
  'scratch-edit',
  'scratch-earlier',
  'scratch-later',
  'scratch-align',
  'scratch-clear',
  'scratch-now',
  'scratch-live',
  'scratch-playhead',
  'scratch-history',
  'scratch-undo',
  'scratch-redo',
  'scratch-record-group',
  'scratch-record',
  'scratch-lane',
  'scratch-lane-label',
  'scratch-bars',
  'scratch-scroll',
  'scratch-ruler',
  'scratch-roll',
  'scratch-gutter',
  'scratch-grid',
  'scratch-notes',
  'scratch-cursor',
  'scratch-preview',
  'scratch-hover-cell',
  'scratch-select-rect',
  'scratch-note',
  'scratch-note-line',
  'scratch-note-shown',
  'scratch-note-name',
  'scratch-note-rest',
  'scratch-note-spoken',
  'scratch-note-hover',
  'scratch-hint',
  'scratch-listen',
  'scratch-listen-state',
  'scratch-allow',
  'scratch-heard',
  'scratch-play',
  'scratch-play-output',
  'scratch-play-start',
  'scratch-play-music',
  'scratch-play-now',
  'scratch-play-loop',
  'scratch-play-listen',
  'scratch-play-stop',
  'scratch-play-note',
  'scratch-send',
  'scratch-phrase',
  'scratch-words',
  'scratch-send-button',
  'scratch-send-status',
];

// The opening tag of the element with this id.
function tagOf(id) {
  const match = html.match(new RegExp(`<(\\w+)([^>]*\\bid="${id}"[^>]*)>`));
  assert.ok(match, `page/index.html has no #${id}`);
  return { name: match[1], attributes: match[2] };
}

test('the markup holds each Scratchpad id exactly once', () => {
  for (const id of IDS) {
    assert.equal(html.match(new RegExp(`\\bid="${id}"`, 'g'))?.length, 1, `#${id} must appear exactly once`);
  }
});

test('the Scratchpad is a region that starts hidden inside the view panel, and the cursor starts hidden', () => {
  const view = tagOf('scratch-view');
  assert.match(view.attributes, /\bhidden\b/);
  assert.match(view.attributes, /role="region"/);
  assert.match(view.attributes, /aria-label="Scratchpad"/);
  assert.match(tagOf('scratch-cursor').attributes, /\bhidden\b/);
  const panel = html.indexOf('<section id="view-panel"');
  const at = html.indexOf('<div id="scratch-view"');
  assert.ok(panel !== -1 && at > panel, '#scratch-view must come after the start of #view-panel');
  const rest = html.slice(at);
  const close = rest.indexOf('</section>');
  assert.ok(close !== -1 && !rest.slice(0, close).includes('<section'), '#scratch-view must be a child of #view-panel');
  assert.match(rest.slice(0, close), /<\/div>\s*$/, '#scratch-view must be the last child of #view-panel');
});

test('the roll is one tab stop, named and described, and the line is a polite live region', () => {
  const roll = tagOf('scratch-roll');
  assert.match(roll.attributes, /tabindex="0"/);
  assert.match(roll.attributes, /role="group"/);
  assert.match(roll.attributes, /aria-label="Scratchpad piano roll"/);
  assert.match(roll.attributes, /aria-describedby="scratch-hint"/);
  const line = tagOf('scratch-note-line');
  assert.match(line.attributes, /role="status"/);
  assert.match(line.attributes, /aria-live="polite"/);
  assert.match(tagOf('scratch-note-shown').attributes, /aria-hidden="true"/);
  assert.match(tagOf('scratch-ruler').attributes, /aria-hidden="true"/);
  assert.match(tagOf('scratch-gutter').attributes, /aria-hidden="true"/);
});

test('the listening strip sits under the information line, its state is the only live region and a note line is not announced', () => {
  const note = html.indexOf('id="scratch-note"');
  const hint = html.indexOf('id="scratch-hint"');
  const strip = html.indexOf('id="scratch-listen"');
  assert.ok(note < hint && hint < strip, 'the strip comes after the information line');
  const state = tagOf('scratch-listen-state');
  assert.match(state.attributes, /role="status"/);
  assert.match(state.attributes, /aria-live="polite"/);
  assert.doesNotMatch(tagOf('scratch-heard').attributes, /aria-live|role=/, 'a jam must not flood a screen reader note by note');
});

test('the Allow MIDI to listen button sits in the strip between the state sentence and the heard line, starts hidden and is a plain page button', () => {
  const strip = html.indexOf('id="scratch-listen"');
  assert.ok(strip < html.indexOf('id="scratch-listen-state"') && html.indexOf('id="scratch-listen-state"') < html.indexOf('id="scratch-allow"'), 'after the state sentence');
  assert.ok(html.indexOf('id="scratch-allow"') < html.indexOf('id="scratch-heard"'), 'before the heard line');
  const allow = tagOf('scratch-allow');
  assert.equal(allow.name, 'button');
  assert.match(allow.attributes, /type="button"/);
  assert.match(allow.attributes, /class="tl-btn"/);
  assert.match(allow.attributes, /\bhidden\b/);
});

test('the hear strip sits between the keyboard strip and the send strip, its parts in tab order, and its note line is the strip\'s one live region', () => {
  const strip = tagOf('scratch-play');
  assert.match(strip.attributes, /role="group"/);
  assert.match(strip.attributes, /aria-label="Hear the motif"/);
  const order = ['scratch-listen', 'scratch-heard', 'scratch-play', 'scratch-play-output', 'scratch-play-start', 'scratch-play-music', 'scratch-play-now', 'scratch-play-loop', 'scratch-play-listen', 'scratch-play-stop', 'scratch-play-note', 'scratch-send'].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(order.every((at) => at !== -1));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'keyboard strip, then the menu, the Start choice, Loop, Listen, Stop and the note line, then the send strip');
  const select = tagOf('scratch-play-output');
  assert.equal(select.name, 'select');
  assert.match(select.attributes, /aria-label="Instrument and channel"/);
  const start = tagOf('scratch-play-start');
  assert.match(start.attributes, /role="group"/);
  assert.match(start.attributes, /aria-label="Start"/);
  for (const id of ['scratch-play-music', 'scratch-play-now', 'scratch-play-loop', 'scratch-play-listen', 'scratch-play-stop']) {
    const button = tagOf(id);
    assert.equal(button.name, 'button', id);
    assert.match(button.attributes, /type="button"/, id);
    assert.match(button.attributes, /class="tl-btn"/, id);
    assert.doesNotMatch(button.attributes, /\bdisabled\b/, `${id} carries aria-disabled and never the disabled attribute`);
  }
  for (const id of ['scratch-play-music', 'scratch-play-now', 'scratch-play-loop']) assert.match(tagOf(id).attributes, /aria-pressed="(true|false)"/, id);
  assert.match(tagOf('scratch-play-music').attributes, /aria-pressed="true"/, 'In the music is the default');
  assert.match(tagOf('scratch-play-loop').attributes, /aria-pressed="false"/, 'Loop is off by default');
  const note = tagOf('scratch-play-note');
  assert.match(note.attributes, /role="status"/);
  assert.match(note.attributes, /aria-live="polite"/);
  const within = html.slice(html.indexOf('id="scratch-play"'), html.indexOf('id="scratch-send"'));
  assert.equal(within.match(/aria-live=/g).length, 1, 'one live region in the strip');
});

test('the hear strip wraps, is not pinned, and its menu, Start choice and note line take the looks of the words box, the grid group and a 1.25 rem line', () => {
  const rules = scratchRules();
  const body = (selector) => rules.find((rule) => rule.selector === selector)?.body ?? assert.fail(`no rule '${selector}'`);
  assert.match(body('#scratch-play'), /display:\s*flex;/);
  assert.match(body('#scratch-play'), /flex-wrap:\s*wrap;/);
  assert.ok(!rules.some((rule) => rule.selector.includes('#scratch-play') && /position:\s*sticky/.test(rule.body)), 'the hear strip scrolls with the view');
  const menu = body('#scratch-play-output');
  assert.match(menu, /height:\s*2rem;/);
  assert.match(menu, /background:\s*var\(--dominant\);/);
  assert.match(menu, /border:\s*1px solid var\(--border\);/);
  assert.match(menu, /text-overflow:\s*ellipsis;/);
  assert.match(menu, /overflow:\s*hidden;/);
  assert.match(body('#scratch-play-start'), /border:\s*1px solid var\(--border\);/);
  assert.match(body('#scratch-play-start .tl-btn[aria-pressed="true"]'), /background:\s*var\(--surface-2\);/);
  assert.match(body('#scratch-play-note'), /min-height:\s*1\.25rem;/);
  assert.match(body('#scratch-play-note'), /overflow-wrap:\s*anywhere;/);
  assert.match(body('.sp-hear-id'), /font-weight:\s*600;/);
  assert.match(body('#scratch-play-loop[aria-pressed="true"]'), /border-color:\s*var\(--text\);/);
});

test('the toolbar comes before the roll, in named groups, with plain buttons that use the page button look', () => {
  assert.ok(html.indexOf('id="scratch-controls"') < html.indexOf('id="scratch-scroll"'), 'the toolbar must come before the scroll box');
  const bar = tagOf('scratch-controls');
  assert.match(bar.attributes, /role="toolbar"/);
  assert.match(bar.attributes, /aria-label="Scratchpad controls"/);
  for (const [id, label] of [['scratch-grids', 'Grid'], ['scratch-length', 'Length of the motif'], ['scratch-pitch', 'Pitch']]) {
    assert.match(tagOf(id).attributes, new RegExp(`role="group"[^>]*aria-label="${label}"`), id);
  }
  for (const id of ['scratch-grid-quarter', 'scratch-grid-eighth', 'scratch-grid-sixteenth', 'scratch-grid-eighth-triplet', 'scratch-grid-sixteenth-triplet', 'scratch-fewer', 'scratch-more', 'scratch-lower', 'scratch-higher']) {
    const tag = tagOf(id);
    assert.equal(tag.name, 'button', id);
    assert.match(tag.attributes, /type="button"/, id);
    assert.match(tag.attributes, /class="tl-btn"/, id);
    assert.doesNotMatch(tag.attributes, /\bdisabled\b/, `${id} is never disabled with the attribute`);
  }
  assert.match(tagOf('scratch-window').attributes, /role="img"/);
});

test('the velocity lane is the second tab stop, named and described, and sits in the scroll box after the roll', () => {
  const lane = tagOf('scratch-lane');
  assert.match(lane.attributes, /tabindex="0"/);
  assert.match(lane.attributes, /role="group"/);
  assert.match(lane.attributes, /aria-label="Velocity of the notes"/);
  assert.match(lane.attributes, /aria-describedby="scratch-hint"/);
  assert.match(tagOf('scratch-lane-label').attributes, /aria-hidden="true"/);
  const scroll = html.indexOf('id="scratch-scroll"');
  const roll = html.indexOf('id="scratch-roll"');
  const at = html.indexOf('id="scratch-lane"');
  const note = html.indexOf('id="scratch-note"');
  assert.ok(scroll < roll && roll < at && at < note, 'the lane comes after the roll and before the information line');
  const inside = html.slice(scroll, html.lastIndexOf('<div', note));
  assert.equal((inside.match(/<div/g) ?? []).length + 1, (inside.match(/<\/div>/g) ?? []).length, 'the lane is inside the scroll box, which closes before the information line');
});

// The rules of the stylesheet whose selector names a Scratchpad id or class.
function scratchRules() {
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (/#scratch-|\.sp-/.test(selector)) rules.push({ selector, body: match[2] });
  }
  return rules;
}

test('the Scratchpad hides its view, its cursor, its preview, its selection box, its hovered cell and its hover line with their own [hidden] rules', () => {
  for (const id of ['scratch-view', 'scratch-cursor', 'scratch-preview', 'scratch-select-rect', 'scratch-hover-cell', 'scratch-note-hover', 'scratch-now', 'scratch-playhead', 'scratch-allow']) {
    assert.match(css, new RegExp(`#${id}\\[hidden\\]\\s*\\{\\s*display:\\s*none;\\s*\\}`), `#${id} needs its own [hidden] rule`);
  }
});

test('the preview, the hovered cell and the hover line start hidden, and the hover line is out of the accessibility tree', () => {
  for (const id of ['scratch-preview', 'scratch-hover-cell', 'scratch-note-hover']) assert.match(tagOf(id).attributes, /\bhidden\b/, `#${id}`);
  assert.match(tagOf('scratch-note-hover').attributes, /aria-hidden="true"/);
  const gridAt = html.indexOf('id="scratch-grid"');
  const noteAt = html.indexOf('id="scratch-note"');
  for (const id of ['scratch-preview', 'scratch-hover-cell']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > gridAt && at < noteAt, `#${id} must sit inside #scratch-grid`);
  }
  assert.ok(html.indexOf('id="scratch-note-hover"') > noteAt, '#scratch-note-hover must sit inside #scratch-note');
});

// The accent means "live now". The Scratchpad uses it for exactly these three selectors, as the Timeline uses it for its playhead.
const ACCENT_SELECTORS = ['#scratch-playhead', '.sp-live', '.sp-key[data-held="true"]'];

test('the Scratchpad rules size in rem with 1px hairlines only, use no motion, no at-rule and no reserved color', () => {
  const rules = scratchRules();
  assert.ok(rules.length >= 20, 'the Scratchpad rules are missing');
  for (const { selector, body } of rules) {
    const where = `rule '${selector}'`;
    for (const px of body.matchAll(/(-?[\d.]+)px\b/g)) assert.ok(['1', '-1'].includes(px[1]), `${where} uses ${px[0]}`);
    assert.doesNotMatch(body, /\b(transition|animation|transform)\b/, `${where} must not move`);
    assert.doesNotMatch(body, /--accent-2|--destructive|--jam-avoid|--jam-outside|--diff-/, `${where} must not use a reserved color`);
    if (!ACCENT_SELECTORS.includes(selector)) assert.doesNotMatch(body, /--accent/, `${where} must not use the accent`);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${where} must use palette variables only`);
    assert.doesNotMatch(selector, /data-motion/, `${where} depends on the motion mode`);
    for (const size of body.matchAll(/font-size:\s*([^;]+);/g)) assert.match(size[1].trim(), /^-?[\d.]+rem$/, `${where}: font-size ${size[1]}`);
  }
  assert.ok(!css.includes('@'), 'the stylesheet has no at-rule');
});

test('the Scratchpad colors are the page palette variables, mixed where a ramp is needed', () => {
  for (const { selector, body } of scratchRules()) {
    for (const use of body.matchAll(/var\((--[\w-]+)/g)) {
      const allowed = ACCENT_SELECTORS.includes(selector) ? /^--(accent|text|text-muted|dominant|secondary|surface-2|border|font-mono|sp-[\w-]+|v)$/ : /^--(text|text-muted|dominant|secondary|surface-2|border|font-mono|sp-[\w-]+|v)$/;
      assert.match(use[1], allowed, `rule '${selector}' uses ${use[1]}`);
    }
  }
});

test('the accent is used by exactly the live playhead, the live notes and the held key, each by a rule of its own', () => {
  const using = scratchRules().filter(({ body }) => body.includes('var(--accent)')).map(({ selector }) => selector).sort();
  assert.deepEqual(using, [...ACCENT_SELECTORS].sort());
});

test('the live layer and the playhead are aria-hidden elements inside the grid, the playhead starts hidden, and the layer is above the notes and takes no pointer', () => {
  assert.match(tagOf('scratch-live').attributes, /aria-hidden="true"/);
  assert.match(tagOf('scratch-playhead').attributes, /aria-hidden="true"/);
  assert.match(tagOf('scratch-playhead').attributes, /\bhidden\b/);
  const gridAt = html.indexOf('id="scratch-grid"');
  const laneAt = html.indexOf('id="scratch-lane"');
  for (const id of ['scratch-live', 'scratch-playhead']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > gridAt && at < laneAt, `#${id} must sit inside #scratch-grid`);
  }
  assert.ok(html.indexOf('id="scratch-live"') > html.indexOf('id="scratch-notes"'), 'the live layer comes after the notes, so it is drawn above them');
  const layer = scratchRules().find((rule) => rule.selector === '#scratch-live');
  assert.match(layer.body, /pointer-events:\s*none;/);
  const note = scratchRules().find((rule) => rule.selector === '.sp-live');
  assert.match(note.body, /pointer-events:\s*none;/);
  assert.match(note.body, /color-mix\(in srgb, var\(--accent\) calc\(15% \+ 25% \* var\(--v\)\), transparent\)/);
  assert.match(note.body, /border:\s*1px solid var\(--accent\);/);
  const held = scratchRules().find((rule) => rule.selector === '.sp-live[data-held="true"]');
  assert.match(held.body, /border-right-width:\s*0;/, 'a held note has an open right edge');
  const playhead = scratchRules().find((rule) => rule.selector === '#scratch-playhead');
  assert.match(playhead.body, /width:\s*0\.125rem;/);
  assert.match(playhead.body, /left:\s*calc\(var\(--sp-playhead\) \/ var\(--sp-units\) \* 100%\);/);
  assert.match(playhead.body, /pointer-events:\s*none;/);
  const key = scratchRules().find((rule) => rule.selector === '.sp-key[data-held="true"]');
  assert.match(key.body, /border-left:\s*0\.25rem solid var\(--accent\);/);
  assert.match(key.body, /font-weight:\s*600;/);
});

const FORBIDDEN = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write\b/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['DOMParser', /\bDOMParser\b/],
  ['a socket or event send', /\.send\s*\(/],
  ['a WebSocket', /\bWebSocket\b/],
  ['a network call', /\bfetch\s*\(/],
  ['an XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['local storage', /\blocalStorage\b/],
  ['session storage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['a cookie', /\bdocument\.cookie\b/],
  ['an audio context', /\b(AudioContext|webkitAudioContext|OfflineAudioContext)\b/],
  ['an audio element', /\bnew Audio\b|\bHTMLAudioElement\b/],
  ['Web MIDI', /\bnavigator\.requestMIDIAccess\b|\bMIDIOutput\b/],
  ['a right-click listener', /['"]contextmenu['"]/],
  ['a timer', /\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/],
];

test('the Scratchpad modules write no markup, send nothing, store nothing, make no sound and listen for no right-click', () => {
  for (const [path, code] of MODULES) {
    for (const [what, pattern] of FORBIDDEN) {
      assert.doesNotMatch(code, pattern, `${path} must not contain ${what}`);
    }
  }
});

// The Listen player holds no browser global and no timer: the page gives it its clock, its timer and its output, so node:test drives it with fakes.
const LISTEN_CODE = codeOf(read('../page/scratch-listen.js'));

test('the Listen player writes no markup, sends nothing itself, stores nothing, makes no sound and uses no timer or Web MIDI of its own', () => {
  for (const [what, pattern] of FORBIDDEN) {
    assert.doesNotMatch(LISTEN_CODE, pattern, `page/scratch-listen.js must not contain ${what}`);
  }
  assert.doesNotMatch(LISTEN_CODE, /MIDIAccess|requestMIDIAccess|WebMidi|MIDIInput/, 'no Web MIDI');
});

test('the Listen player touches neither the document, the window nor the navigator and imports only the model', () => {
  assert.doesNotMatch(withoutStrings(LISTEN_CODE), /(?<![\w'-])(document|window|globalThis|navigator|location)(?![\w'-])/);
  const imports = LISTEN_CODE.split('\n').filter((text) => /^import\s/.test(text));
  assert.ok(imports.length >= 1, 'it reads the schedule and the cycle length from the model');
  for (const line of imports) assert.match(line, /from '\.\/scratch-model\.js'/, line);
  assert.match(LISTEN_CODE, /export function createScratchListen\(/);
});

// A module's code with the text of its quoted strings taken out, so a sentence that says "the pitch window" is not taken for the global.
const withoutStrings = (code) => code.replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''");

test('the view adds no listener on the document or the window: its undo keys are heard on the view alone', () => {
  const [, view] = MODULES[1];
  assert.doesNotMatch(view, /\bdocument\.addEventListener\b/);
  assert.doesNotMatch(view, /\b(window|defaultView|documentElement|body)\.addEventListener\b/);
  assert.match(view, /viewEl\.addEventListener\('keydown'/);
});

test('the undo and redo buttons are plain page buttons in a group of their own at the end of the toolbar', () => {
  const group = tagOf('scratch-history');
  assert.match(group.attributes, /role="group"/);
  assert.match(group.attributes, /aria-label="Undo and redo"/);
  for (const id of ['scratch-undo', 'scratch-redo']) {
    const tag = tagOf(id);
    assert.equal(tag.name, 'button', id);
    assert.match(tag.attributes, /type="button"/, id);
    assert.match(tag.attributes, /class="tl-btn"/, id);
    assert.doesNotMatch(tag.attributes, /\bdisabled\b/, id);
  }
  assert.ok(html.indexOf('id="scratch-pitch"') < html.indexOf('id="scratch-history"'), 'the group comes after the pitch group');
  assert.ok(html.indexOf('id="scratch-redo"') < html.indexOf('id="scratch-scroll"'), 'and inside the toolbar, before the roll');
});

test('Record that is a plain page button in a Keyboard group at the end of the toolbar', () => {
  assert.match(tagOf('scratch-record-group').attributes, /role="group"[^>]*aria-label="Keyboard"/);
  const record = tagOf('scratch-record');
  assert.equal(record.name, 'button');
  assert.match(record.attributes, /type="button"/);
  assert.match(record.attributes, /class="tl-btn"/);
  assert.doesNotMatch(record.attributes, /\bdisabled\b/);
  assert.ok(html.indexOf('id="scratch-redo"') < html.indexOf('id="scratch-record-group"'), 'after Undo and Redo');
  assert.ok(html.indexOf('id="scratch-record"') < html.indexOf('id="scratch-scroll"'), 'and inside the toolbar, before the roll');
});

test('Draw and Tap rhythm are plain page buttons in the Mode group between Pitch and Undo, the selection box is a hidden element inside the grid, and the now-marker is a hidden line inside the grid', () => {
  assert.match(tagOf('scratch-mode').attributes, /role="group"[^>]*aria-label="Mode"/);
  const draw = tagOf('scratch-draw');
  assert.equal(draw.name, 'button');
  assert.match(draw.attributes, /type="button"/);
  assert.match(draw.attributes, /class="tl-btn"/);
  assert.match(draw.attributes, /aria-pressed="false"/);
  assert.doesNotMatch(draw.attributes, /\bdisabled\b/);
  assert.match(tagOf('scratch-select-rect').attributes, /\bhidden\b/);
  assert.match(tagOf('scratch-select-rect').attributes, /aria-hidden="true"/);
  const rectAt = html.indexOf('id="scratch-select-rect"');
  assert.ok(rectAt > html.indexOf('id="scratch-grid"') && rectAt < html.indexOf('id="scratch-lane"'), '#scratch-select-rect must sit inside #scratch-grid');
  const tap = tagOf('scratch-tap');
  assert.equal(tap.name, 'button');
  assert.match(tap.attributes, /type="button"/);
  assert.match(tap.attributes, /class="tl-btn"/);
  assert.match(tap.attributes, /aria-pressed="false"/);
  assert.doesNotMatch(tap.attributes, /\bdisabled\b/);
  const order = ['scratch-pitch', 'scratch-mode', 'scratch-draw', 'scratch-tap', 'scratch-history'].map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'Pitch, then Mode with Draw and Tap, then Undo and Redo');
  assert.match(tagOf('scratch-now').attributes, /\bhidden\b/);
  const gridAt = html.indexOf('id="scratch-grid"');
  const nowAt = html.indexOf('id="scratch-now"');
  assert.ok(nowAt > gridAt && nowAt < html.indexOf('id="scratch-lane"'), '#scratch-now must sit inside #scratch-grid');
});

test('Earlier, Later, Align and Clear are plain page buttons in an Edit group between Mode and Undo and Redo', () => {
  assert.match(tagOf('scratch-edit').attributes, /role="group"[^>]*aria-label="Edit"/);
  for (const id of ['scratch-earlier', 'scratch-later', 'scratch-align', 'scratch-clear']) {
    const button = tagOf(id);
    assert.equal(button.name, 'button', id);
    assert.match(button.attributes, /type="button"/, id);
    assert.match(button.attributes, /class="tl-btn"/, id);
    assert.doesNotMatch(button.attributes, /\bdisabled\b/, `${id} carries aria-disabled and never the disabled attribute`);
  }
  const order = ['scratch-mode', 'scratch-tap', 'scratch-edit', 'scratch-earlier', 'scratch-later', 'scratch-align', 'scratch-clear', 'scratch-history'].map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'Mode, then Edit with Earlier, Later, Align and Clear, then Undo and Redo');
  const groupRule = scratchRules().find((rule) => rule.selector.split(',').map((part) => part.trim()).includes('#scratch-edit'));
  assert.ok(groupRule, 'the Edit group takes the toolbar group rule');
  assert.match(groupRule.body, /display:\s*flex;/);
});

test('the now-marker is a one pixel line of the text color placed through one custom property, with no motion', () => {
  const rule = scratchRules().find((candidate) => candidate.selector === '#scratch-now');
  assert.ok(rule, 'no #scratch-now rule');
  assert.match(rule.body, /position:\s*absolute;/);
  assert.match(rule.body, /width:\s*1px;/);
  assert.match(rule.body, /background:\s*var\(--text\);/);
  assert.match(rule.body, /left:\s*calc\(var\(--sp-now\) \/ var\(--sp-units\) \* 100%\);/);
  assert.match(rule.body, /pointer-events:\s*none;/);
});

test('the model touches neither the document nor the window', () => {
  const [, model] = MODULES[0];
  assert.doesNotMatch(withoutStrings(model), /(?<![\w'-])(document|window|globalThis|navigator)(?![\w'-])/);
  assert.doesNotMatch(model, /^import\s/m, 'the model imports nothing');
});

test('the gesture numbers touch neither the document, the window nor a timer and import only the model', () => {
  const [, gesture] = MODULES[2];
  assert.doesNotMatch(gesture, /(?<![\w'-])(document|window|globalThis|navigator|location|localStorage)(?![\w'-])/);
  for (const line of gesture.split('\n').filter((text) => /^import\s/.test(text))) assert.match(line, /from '\.\/scratch-model\.js'/, line);
});

test('the view reaches the page only through the document it is given and writes elements only in the text-only ways', () => {
  const [, view] = MODULES[1];
  assert.doesNotMatch(view, /(?<![\w'-])(window|globalThis|location)(?![\w'-])/);
  assert.match(view, /export function createScratchView\(\{\s*document,\s*rootFontPx,\s*onTapChange = \(\) => \{\},\s*onRecord = \(\) => \{\},\s*onAllow = \(\) => \{\},\s*onSend = \(\) => \{/);
  const writes = new Set([...view.matchAll(/\b(?:\w+El|element|cell|label)\.(\w+)\s*=(?!=)/g)].map((match) => match[1]));
  // scrollLeft and scrollTop move the scroll box instantly to keep the cursor in view: the box scrolls both ways, sideways for the beats and up and down for the rows.
  for (const name of writes) assert.ok(['textContent', 'className', 'scrollLeft', 'scrollTop', 'value'].includes(name), `the view assigns .${name}, which is not a text-only write`);
  for (const use of view.matchAll(/\bstyle\.(\w+)/g)) assert.equal(use[1], 'setProperty', `style.${use[1]} writes geometry outside the custom properties`);
});

test('the lane is 3.5 rem high in layout a and 5 rem in layouts b and c, its label is as wide as the piano names, and a bar is at least a quarter rem wide', () => {
  const rules = scratchRules();
  const body = (selector) => rules.find((rule) => rule.selector.split(',').map((part) => part.trim()).includes(selector))?.body ?? assert.fail(`no rule '${selector}'`);
  assert.match(body('#scratch-lane'), /height:\s*3\.5rem;/);
  assert.match(body('#workspace[data-layout="b"] #scratch-lane'), /height:\s*5rem;/);
  assert.match(body('#workspace[data-layout="c"] #scratch-lane'), /height:\s*5rem;/);
  assert.match(body('#scratch-lane-label'), new RegExp(`width:\\s*${GUTTER_REM}rem;`));
  assert.match(body('#scratch-lane-label'), /position:\s*sticky;/);
  assert.match(body('.sp-bar'), /max\(0\.25rem/);
});

test('in layout a the view scrolls "nearest" to a stop above the two pinned lines, by the strip height plus the information line and its gaps', () => {
  const rules = scratchRules();
  const body = (selector) => rules.find((rule) => rule.selector === selector)?.body ?? assert.fail(`no rule '${selector}'`);
  assert.match(body('#workspace[data-layout="a"] #scratch-view'), /scroll-padding-bottom:\s*calc\(var\(--sp-listen-h\) \+ 3rem\);/);
  assert.match(body('#workspace[data-layout="a"] #scratch-listen'), /bottom:\s*0;/);
  assert.match(body('#workspace[data-layout="a"] #scratch-note'), /bottom:\s*calc\(var\(--sp-listen-h\) \+ 0\.5rem\);/);
});

test('the piano names column is drawn as wide as the fit counts it, and the scroll box takes the room of the view without growing from its content', () => {
  const rules = scratchRules();
  const gutter = rules.find((rule) => rule.selector === '#scratch-gutter');
  assert.match(gutter.body, new RegExp(`width:\\s*${GUTTER_REM}rem;`));
  const spacer = rules.find((rule) => rule.selector === '#scratch-ruler::before');
  assert.match(spacer.body, new RegExp(`width:\\s*${GUTTER_REM}rem;`));
  assert.match(spacer.body, /position:\s*sticky;/);
  const scroll = rules.find((rule) => rule.selector === '#scratch-scroll');
  assert.match(scroll.body, /flex:\s*1 1 0%;/);
  assert.match(scroll.body, /min-height:\s*22rem;/);
});

test('the scroll box scrolls both ways with the ruler held at its top, the piano names at its left and the velocity lane at its bottom, and the grid is as tall as its rows', () => {
  const rules = scratchRules();
  const body = (selector) => rules.find((rule) => rule.selector.split(',').map((part) => part.trim()).includes(selector))?.body ?? assert.fail(`no rule '${selector}'`);
  assert.match(body('#scratch-scroll'), /overflow:\s*auto;/);
  assert.match(body('#scratch-ruler'), /position:\s*sticky;/);
  assert.match(body('#scratch-ruler'), /top:\s*0;/);
  assert.match(body('#scratch-ruler'), /background:\s*var\(--dominant\);/);
  assert.match(body('#scratch-gutter'), /position:\s*sticky;/);
  assert.match(body('#scratch-gutter'), /left:\s*0;/);
  assert.match(body('#scratch-lane'), /position:\s*sticky;/);
  assert.match(body('#scratch-lane'), /bottom:\s*0;/);
  assert.match(body('#scratch-lane'), /background:\s*var\(--dominant\);/);
  for (const selector of ['#scratch-ruler', '#scratch-lane']) {
    const z = Number(body(selector).match(/z-index:\s*(\d+);/)?.[1]);
    assert.ok(z > Number(body('#scratch-gutter').match(/z-index:\s*(\d+);/)[1]), `${selector} sits over the piano names when the roll scrolls under it`);
  }
  assert.match(body('#scratch-grid'), /height:\s*calc\(var\(--sp-rows\) \* var\(--sp-row-h\)\);/);
  assert.match(body('#scratch-view'), /--sp-rows:\s*24;/);
});

test('the scroll box is a stacking context of its own, so the ruler and the lane never paint over the pinned information line and strip of layout a', () => {
  const rules = scratchRules();
  const body = (selector) => rules.find((rule) => rule.selector.split(',').map((part) => part.trim()).includes(selector))?.body ?? assert.fail(`no rule '${selector}'`);
  assert.match(body('#scratch-scroll'), /isolation:\s*isolate;/);
  const pinned = Number(body('#workspace[data-layout="a"] #scratch-note').match(/z-index:\s*(\d+);/)?.[1] ?? NaN);
  assert.ok(Number.isFinite(pinned), 'the pinned lines of layout a carry a z-index');
});

test('the roll takes a right-click to erase a note, but not the contextmenu a Menu key press raises', () => {
  const main = codeOf(read('../page/main.js'));
  const listener = main.indexOf("document.addEventListener('contextmenu'");
  assert.ok(listener > 0, 'main.js has the contextmenu listener');
  const branch = main.indexOf('scratchUi.rollContains(event.target)', listener);
  assert.ok(branch > listener, 'the listener has a branch for the roll');
  const erase = main.indexOf('scratchUi.handleContextMenu(event)', branch);
  assert.ok(erase > branch, 'the roll branch erases through handleContextMenu');
  assert.match(main.slice(branch, erase), /if \(keyAsk === null\)\s*$/, 'the erase runs only when no ask key press is behind the event');
});

test('a refused Listen press stops the play before it: every refusal of the page goes through refuseListen, which stops first', () => {
  const main = codeOf(read('../page/main.js'));
  const from = main.indexOf('function startListen(request) {');
  const to = main.indexOf('function stopListen(reason) {');
  assert.ok(from > 0 && to > from, 'main.js has startListen, then stopListen');
  const presses = main.slice(from, to);
  assert.doesNotMatch(presses, /scratchUi\.setHear\(\{ kind: 'refused'/, 'no refusal is told to the view without stopping the play first');
  assert.equal(presses.match(/refuseListen\(\{ kind: 'refused'/g)?.length, 3, 'the access refusal, the late access refusal and the output refusal');
  const helper = presses.slice(presses.indexOf('function refuseListen(state) {'));
  assert.match(helper, /^function refuseListen\(state\) \{\s*scratchListen\.stop\('stop'\);\s*scratchUi\.setHear\(state\);\s*\}/);
});

test('the Tap Space guard is cleared when the window loses focus, so a missed key up cannot swallow a later click', () => {
  const main = codeOf(read('../page/main.js'));
  const flag = main.indexOf('let tapSpaceHandled = false;');
  assert.ok(flag > 0, 'main.js holds the Tap Space guard');
  const blur = main.indexOf("window.addEventListener('blur', () => {", flag);
  assert.ok(blur > flag, 'a blur listener follows the guard');
  const body = main.slice(blur, main.indexOf('});', blur));
  assert.match(body, /tapSpaceHandled = false;/);
  assert.ok(main.indexOf("document.addEventListener('keyup'", flag) < blur, 'it sits after the Space key up listener');
});

test('the send strip is the last block of the Scratchpad: the phrase, the words, the button and the status line', () => {
  const ids = ['scratch-listen', 'scratch-send', 'scratch-phrase', 'scratch-words', 'scratch-send-button', 'scratch-send-status'];
  const order = ids.map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the strip comes after the listening strip, its parts in this order');
  const phrase = tagOf('scratch-phrase');
  assert.equal(phrase.name, 'code');
  assert.match(phrase.attributes, /tabindex="0"/, 'the phrase is a focusable box so its scroll can be reached');
  assert.doesNotMatch(phrase.attributes, /aria-live|role=/, 'the phrase changes on every edit and can be thousands of characters: never a live region');
  const words = tagOf('scratch-words');
  assert.equal(words.name, 'input');
  assert.match(words.attributes, /type="text"/);
  const button = tagOf('scratch-send-button');
  assert.equal(button.name, 'button');
  assert.match(button.attributes, /type="button"/);
  assert.match(button.attributes, /class="tl-btn"/);
  assert.doesNotMatch(button.attributes, /\bdisabled\b/, 'a button that cannot act now keeps focus and says why');
  const status = tagOf('scratch-send-status');
  assert.match(status.attributes, /role="status"/);
  assert.match(status.attributes, /aria-live="polite"/);
  const rest = html.slice(html.indexOf('id="scratch-send"'));
  const strip = rest.slice(0, rest.indexOf('</section>'));
  assert.equal((strip.match(/aria-live=/g) ?? []).length, 1, 'the status line is the strip\'s only live region');
  assert.match(strip, /<\/div><\/div>\s*$/, 'the strip closes the Scratchpad');
});
