// Contract test for the accent color reservation.
// Pins that var(--accent) is used by exactly three CSS rules, that the raw hex lives only
// in the --accent token, and that the overlay CTA span is the sole static data-accent
// carrier in the markup.
// The accent reservation also covers the Timeline playhead and its cycle
// label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS_PATH = fileURLToPath(new URL('../page/style.css', import.meta.url));
const HTML_PATH = fileURLToPath(new URL('../page/index.html', import.meta.url));

const css = readFileSync(CSS_PATH, 'utf8');
const html = readFileSync(HTML_PATH, 'utf8');

/**
 * Returns the sorted list of CSS selectors whose declaration block contains `var(varName)`
 * (default `--accent`). Strips comments first. Asserts loudly (rather than silently
 * mis-parsing) if the stylesheet grows an at-rule, since the simple `{...}` block
 * walker below cannot handle nested/conditional rules.
 */
function accentSelectors(source, varName = '--accent') {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !stripped.includes('@'),
    'page/style.css contains an at-rule (@...); the simple rule parser in test/page-accent.test.js must be upgraded before at-rules are added',
  );

  const needle = `var(${varName})`;
  const selectors = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(stripped)) !== null) {
    const [, selectorList, body] = match;
    // --accent-2's own selector search must not also match a rule using --accent (a plain
    // substring check on "var(--accent-2)" would also match a body reading "var(--accent-20)",
    // which never happens here, but "var(--accent)" is itself a substring-free prefix of
    // "var(--accent-2)" so the reverse direction needs the explicit closing paren above).
    if (!body.includes(needle)) continue;
    for (const raw of selectorList.split(',')) {
      const selector = raw.trim().replace(/\s+/g, ' ');
      if (selector.length > 0) selectors.push(selector);
    }
  }
  return selectors.sort();
}

// The accent ("live now") also covers a Parts header that is the one
// currently playing: its border and its progress-bar fill, and the
// current History row: its node dot and the word "Current", only while sound is playing.
test('accent is applied by exactly the reserved rules, extended to the Timeline playhead, the playing Parts card and the current History row', () => {
  const expected = [
    '#audio-unlock-overlay [data-accent="true"]',
    '#sound-state[data-accent="true"] .state-dot',
    '#top-bar [data-accent="true"]',
    '#timeline-playhead',
    '#timeline-playhead .playhead-cycle',
    '.part-card[data-state="playing"]',
    '.part-card[data-state="playing"] .part-progress-fill',
    '.hist-row[data-live="true"] .hist-current',
    '.hist-row[data-live="true"] .hist-node',
  ].sort();

  assert.deepEqual(
    accentSelectors(css),
    expected,
    'accent (var(--accent)) must be reserved for exactly Playing (Connected is plain text since the top bar redesign), the overlay CTA, the Timeline playhead, the playing Parts card and the current History row',
  );
});

test('the raw accent hex lives only in the --accent token', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const occurrences = stripped.match(/#5ec8c0/gi) || [];
  assert.equal(occurrences.length, 1, 'the raw hex #5ec8c0 must appear exactly once, in the --accent token declaration');
  assert.ok(stripped.includes('--accent: #5ec8c0'), 'the --accent token must declare #5ec8c0');
});

// --accent-2 ("structural / informational") is reserved
// for the Timeline's loop marks and the filter curve,
// a queued Parts card's border and countdown text, and the top bar's
// pending-change countdown.
test('accent-2 is applied by exactly .lane-curve, .loop-mark, the queued Parts card and the top-bar countdown', () => {
  assert.deepEqual(
    accentSelectors(css, '--accent-2').sort(),
    [
      '#top-bar #pending-change',
      '.lane-curve',
      '.loop-mark',
      '.part-card[data-state="queued"]',
      '.part-card[data-state="queued"] .part-state',
    ].sort(),
    'accent-2 (var(--accent-2)) must be reserved for exactly the Timeline filter curve, loop marks, the queued Parts card and the top-bar pending-change countdown',
  );
});

test('the raw accent-2 hex lives only in the --accent-2 token', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const occurrences = stripped.match(/#7fb2e5/gi) || [];
  assert.equal(occurrences.length, 1, 'the raw hex #7fb2e5 must appear exactly once, in the --accent-2 token declaration');
  assert.ok(stripped.includes('--accent-2: #7fb2e5'), 'the --accent-2 token must declare #7fb2e5');
});

test('track colors never use either accent hue', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const trackTokenRe = /--track-[1-8]:\s*(#[0-9a-fA-F]{3,8})/g;
  const trackValues = [...stripped.matchAll(trackTokenRe)].map((m) => m[1].toLowerCase());
  assert.equal(trackValues.length, 8, 'expected exactly 8 --track-N tokens');
  assert.ok(!trackValues.includes('#5ec8c0'), 'no --track-N token may equal the primary accent hex');
  assert.ok(!trackValues.includes('#7fb2e5'), 'no --track-N token may equal the secondary accent hex');
});

test('only the overlay CTA carries a static data-accent in the markup', () => {
  const dataAccentOccurrences = html.match(/data-accent="true"/g) || [];
  assert.equal(dataAccentOccurrences.length, 1, 'data-accent="true" must appear exactly once in page/index.html');

  const buttonMatch = /<button\b[^>]*\bid="audio-unlock-overlay"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(buttonMatch, '#audio-unlock-overlay button must exist in page/index.html');

  const innerHtml = buttonMatch[1];
  const spanOpenTags = innerHtml.match(/<span\b[^>]*>/g) || [];
  const ctaSpan = spanOpenTags.find(
    (tag) => tag.includes('id="audio-unlock-cta"') && tag.includes('data-accent="true"'),
  );
  assert.ok(
    ctaSpan,
    'the #audio-unlock-overlay button must contain a <span> with both id="audio-unlock-cta" and data-accent="true"',
  );
});

// The Mixer's touched-line overlay is the one place --line-flash is used,
// and no
// Mixer rule may use an accent or destructive hue.
test('--line-flash is used by .mx-flash alone and no Mixer selector uses an accent or destructive hue', () => {
  assert.deepEqual(accentSelectors(css, '--line-flash'), ['.mx-flash']);
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter((selector) => selector.includes('mx-') || selector.includes('mixer'));
    assert.deepEqual(offenders, [], `no Mixer selector may use var(${varName})`);
  }
});

// The light of the selected strip's code has its own neutral token, used by .mx-lit alone, and it
// does not move: no transition and no animation (the flash fades, the light never does).
test('--code-lit is used by .mx-lit alone and the light does not move', () => {
  assert.deepEqual(accentSelectors(css, '--code-lit'), ['.mx-lit']);
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => /\.mx-lit\b/.test(selector));
  assert.ok(rules.length >= 1, 'the stylesheet has a .mx-lit rule');
  for (const [, selector, body] of rules) {
    assert.ok(!/transition|animation/.test(body), `${selector.trim()} has no transition and no animation`);
  }
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    assert.deepEqual(accentSelectors(css, varName).filter((selector) => selector.includes('mx-lit')), []);
  }
});

// The Ask Claude box, its status and the Parts button are neutral. No
// #ask-*, .ask-* or #parts-ask* selector may spend an accent or destructive hue.
test('no Ask Claude selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter(
      (selector) => selector.includes('#ask-') || selector.includes('.ask-') || selector.includes('#parts-ask'),
    );
    assert.deepEqual(offenders, [], `no #ask-*, .ask-* or #parts-ask* selector may use var(${varName})`);
  }
});

// The top-bar view and layout buttons only show the current
// layout and view with a quiet neutral mark. No #view-buttons or #layout-buttons selector may spend an accent or
// destructive hue (the accent is for live-now states).
test('no #view-buttons or #layout-buttons selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter(
      (selector) => selector.includes('#view-buttons') || selector.includes('#layout-buttons'),
    );
    assert.deepEqual(offenders, [], `no #view-buttons or #layout-buttons selector may use var(${varName})`);
  }
});

// The page-requests status is quiet muted text, not a "live now" accent state (the
// the words carry the state, and the accent stays for what is live in the
// music). No #page-requests selector may spend an accent or destructive hue.
test('no #page-requests selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter((selector) => selector.includes('#page-requests'));
    assert.deepEqual(offenders, [], `no #page-requests selector may use var(${varName})`);
  }
});

// The superseded-tab segment and its button are neutral. A tab that lost the role is
// not in error and Stop's red means silence, so no MIDI selector may spend an accent or destructive hue.
test('no MIDI selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter(
      (selector) => selector.includes('#midi-') || selector.includes('.midi-') || selector.includes('#take-back'),
    );
    assert.deepEqual(offenders, [], `no MIDI selector may use var(${varName})`);
  }
});

// A plugged port is not "playing now" and an unplugged one is not an error of the
// music, so no Instruments selector may spend an accent or destructive hue. A switch that is on is not
// "playing now" either, and the dots (the crossed "switched off" dot included) stay neutral, so every .midi-dot
// selector is held to the same rule.
test('no Instruments or .midi-dot selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter(
      (selector) => selector.includes('#instruments-') || selector.includes('.instrument-') || selector.includes('.midi-dot'),
    );
    assert.deepEqual(offenders, [], `no Instruments selector may use var(${varName})`);
  }
});

// The Jam view's two hues are its own. No #jam-* or .jam-* selector may spend an
// accent or destructive hue (a warning is not an error), and --jam-avoid / --jam-outside are used by
// Jam selectors alone, each raw hex living only in its token.
test('no Jam selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter((selector) => selector.includes('#jam-') || selector.includes('.jam-'));
    assert.deepEqual(offenders, [], `no #jam-* or .jam-* selector may use var(${varName})`);
  }
});

test('the two Jam hues are used only by Jam selectors and each raw hex lives only in its token', () => {
  for (const [varName, hex] of [['--jam-avoid', '#ef5f65'], ['--jam-outside', '#f2a93b']]) {
    const users = accentSelectors(css, varName);
    assert.ok(users.length > 0, `some Jam selector must use var(${varName})`);
    const strangers = users.filter((selector) => !selector.includes('#jam-') && !selector.includes('.jam-'));
    assert.deepEqual(strangers, [], `only #jam-* and .jam-* selectors may use var(${varName})`);
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((stripped.match(new RegExp(hex, 'gi')) || []).length, 1, `the raw hex ${hex} must appear exactly once, in its token`);
    assert.ok(stripped.includes(`${varName}: ${hex}`), `the ${varName} token must declare ${hex}`);
  }
});

// The instrument tag, the MIDI chips, the notes and the shared lines are plain text on
// the surfaces; none of them takes a reserved color (accent: live now, accent-2: structural, destructive: removal).
test('no instrument tag or MIDI chip selector uses a reserved color', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(stripped)) !== null) {
    rules.push({ selectors: match[1].split(',').map((raw) => raw.trim().replace(/\s+/g, ' ')), body: match[2] });
  }
  const selectors = [
    '.lane-tag',
    '.lane-tag-name',
    '.lane-tag-channel',
    '.mx-tag',
    '.mx-tag-name',
    '.mx-tag-channel',
    '.mx-midi-chips',
    '.mx-midi-chip',
    '.mx-midi-note',
    '.mx-shared',
    '.mx-insp-line',
    '.mx-insp-shared',
    '.mx-sweep',
  ];
  const reserved = ['var(--accent)', 'var(--accent-2)', 'var(--destructive)'];
  for (const selector of selectors) {
    const own = new RegExp(`(^|[^\\w-])${selector.replace('.', '\\.')}(?![\\w-])`);
    const matching = rules.filter((rule) => rule.selectors.some((candidate) => own.test(candidate)));
    assert.ok(matching.length > 0, `page/style.css has no rule for ${selector}`);
    for (const rule of matching) {
      for (const color of reserved) {
        assert.ok(!rule.body.includes(color), `${rule.selectors.join(', ')} must not use ${color}`);
      }
    }
  }
});

// A group frame of the Mixer, its head, its fold button and its count line are neutral outlines and plain text; none of them
// takes a reserved color (accent: live now, accent-2: structural, destructive: removal), so a fold never looks like a state. The
// lights are the same: a ring and a fill in the text colors, so a blink is never read as the live accent or as a warning.
test('no Mixer group selector uses a reserved color', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({ selectors: match[1].split(',').map((raw) => raw.trim().replace(/\s+/g, ' ')), body: match[2] }));
  const selectors = ['.mx-group', '.mx-group-head', '.mx-group-title', '.mx-fold', '.mx-fold-chevron', '.mx-fold-name', '.mx-group-line', '.mx-group-count', '.mx-group-body', '.mx-name-row', '.mx-light', '.mx-light-fill'];
  const reserved = ['var(--accent)', 'var(--accent-2)', 'var(--destructive)'];
  for (const selector of selectors) {
    const own = new RegExp(`(^|[^\\w-])${selector.replace('.', '\\.')}(?![\\w-])`);
    const matching = rules.filter((rule) => rule.selectors.some((candidate) => own.test(candidate)));
    assert.ok(matching.length > 0, `page/style.css has no rule for ${selector}`);
    for (const rule of matching) {
      for (const color of reserved) assert.ok(!rule.body.includes(color), `${rule.selectors.join(', ')} must not use ${color}`);
      assert.ok(!/transition|animation/.test(rule.body), `${rule.selectors.join(', ')} does not animate`);
    }
  }
});

// The note panel under the Timeline lanes, its buttons and the marks on the lanes (the ring, the ghost, the other places of a
// token, the range) are outlines, a wash and plain text in the text colors. None takes a reserved color: a selection is not
// "live now", a refusal is information and an edit can be undone from the history, so nothing here looks like the accent, the
// structural accent, a removal or a Jam hue. Nothing animates.
test('no selector of the note panel or the marks on the Timeline lanes uses a reserved color', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({ selectors: match[1].split(',').map((raw) => raw.trim().replace(/\s+/g, ' ')), body: match[2] }));
  const selectors = ['.tl-ring', '.tl-ghost', '.tl-same', '.tl-range', '#timeline-note', '.tl-btn', '#timeline-note-line'];
  const reserved = ['var(--accent)', 'var(--accent-2)', 'var(--destructive)', 'var(--jam-avoid)', 'var(--jam-outside)'];
  for (const selector of selectors) {
    const own = new RegExp(`(^|[^\\w-])${selector.replace('.', '\\.')}(?![\\w-])`);
    const matching = rules.filter((rule) => rule.selectors.some((candidate) => own.test(candidate)));
    assert.ok(matching.length > 0, `page/style.css has no rule for ${selector}`);
    for (const rule of matching) {
      for (const color of reserved) assert.ok(!rule.body.includes(color), `${rule.selectors.join(', ')} must not use ${color}`);
      assert.ok(!/transition|animation/.test(rule.body), `${rule.selectors.join(', ')} does not animate`);
      assert.ok(!rule.selectors.some((candidate) => candidate.includes('data-motion')), `${rule.selectors.join(', ')} does not depend on the motion mode`);
    }
  }
});

// The drum rows, their labels and tooltip bands are plain text and
// neutral marks; none takes a reserved color, and nothing about a drum lane moves, fades or animates.
test('no Timeline drum selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter(
      (selector) => selector.includes('.lane-drums') || selector.includes('.drum-') || selector.includes('data-drum-rows'),
    );
    assert.deepEqual(offenders, [], `no Timeline drum selector may use var(${varName})`);
  }
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => /\.lane-drums|\.drum-|data-drum-rows/.test(selector));
  assert.ok(rules.length >= 9, `the stylesheet has the drum rules (${rules.length})`);
  for (const [, selector, body] of rules) {
    assert.ok(!/transition|animation/.test(body), `${selector.trim()} has no transition and no animation`);
    assert.ok(!selector.includes('data-motion'), `${selector.trim()} does not depend on the motion mode`);
  }
});

// The Drum kit row and the Drum map line of an Instruments card are neutral
// text; an unknown map is not an error of the music, so none takes a reserved color, and nothing animates.
test('no Instruments drum selector uses --accent, --accent-2 or --destructive', () => {
  for (const varName of ['--accent', '--accent-2', '--destructive']) {
    const offenders = accentSelectors(css, varName).filter((selector) => selector.includes('.instrument-drum-'));
    assert.deepEqual(offenders, [], `no Instruments drum selector may use var(${varName})`);
  }
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => selector.includes('.instrument-drum-'));
  assert.ok(rules.length >= 10, `the stylesheet has the Instruments drum rules (${rules.length})`);
  for (const [, selector, body] of rules) {
    assert.ok(!/transition|animation/.test(body), `${selector.trim()} has no transition and no animation`);
    assert.ok(!selector.includes('data-motion'), `${selector.trim()} does not depend on the motion mode`);
  }
});
