// Contract test for the destructive color reservation.
// Pins that var(--destructive) is used by exactly one rule since the top bar redesign: the failed-change banner (its left edge
// and its 9% tint, never text), that the raw hex lives only in the --destructive token, and the banner markup contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS_PATH = fileURLToPath(new URL('../page/style.css', import.meta.url));
const HTML_PATH = fileURLToPath(new URL('../page/index.html', import.meta.url));

const css = readFileSync(CSS_PATH, 'utf8');
const html = readFileSync(HTML_PATH, 'utf8');

/**
 * Returns the sorted list of CSS selectors whose declaration block contains
 * `var(--destructive)`. Strips comments first. Asserts loudly (rather than silently
 * mis-parsing) if the stylesheet grows an at-rule, since the simple `{...}` block
 * walker below cannot handle nested/conditional rules.
 */
function destructiveSelectors(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !stripped.includes('@'),
    'page/style.css contains an at-rule (@...); the simple rule parser in test/page-destructive.test.js must be upgraded before at-rules are added',
  );

  const selectors = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(stripped)) !== null) {
    const [, selectorList, body] = match;
    if (!body.includes('var(--destructive)')) continue;
    for (const raw of selectorList.split(',')) {
      const selector = raw.trim().replace(/\s+/g, ' ');
      if (selector.length > 0) selectors.push(selector);
    }
  }
  return selectors.sort();
}

test('destructive is applied by exactly the failed-change banner (its left edge and tint), never as text', () => {
  const expected = ['#problem-banner[data-kind="change"]'];

  assert.deepEqual(
    destructiveSelectors(css),
    expected,
    'destructive (var(--destructive)) must be reserved for exactly the failed-change banner; the Play/Stop button is neutral and the error line is never red text',
  );
});

test('the one destructive rule holds the edge and the 9% tint, and no color property uses it', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  let body = null;
  while ((match = ruleRe.exec(stripped)) !== null) {
    if (match[1].trim() === '#problem-banner[data-kind="change"]') body = match[2];
  }
  assert.ok(body, 'page/style.css needs the #problem-banner[data-kind="change"] rule');
  assert.match(body, /border-left:\s*0\.25rem solid var\(--destructive\)/, 'the left edge is 0.25rem destructive');
  assert.match(body, /color-mix\(in srgb, var\(--destructive\) 9%, var\(--secondary\)\)/, 'the tint is 9% destructive over the secondary fill');
  assert.doesNotMatch(body, /(^|[;\s])color:\s*var\(--destructive\)/, 'red is never text');
});

test('the raw destructive hex lives only in the --destructive token', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const occurrences = stripped.match(/#e5484d/gi) || [];
  assert.equal(
    occurrences.length,
    1,
    'the raw hex #e5484d must appear exactly once, in the --destructive token declaration',
  );
  assert.ok(stripped.includes('--destructive: #e5484d'), 'the --destructive token must declare #e5484d');
});

test('the banner contains #eval-error, and the banner and the line start hidden', () => {
  const bannerMatch = /<div\b[^>]*\bid="problem-banner"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(bannerMatch, '#problem-banner must exist in page/index.html');
  const openTag = bannerMatch[0].slice(0, bannerMatch[0].indexOf('>') + 1);
  assert.ok(/\bhidden\b/.test(openTag), '#problem-banner must start with the hidden attribute');
  assert.doesNotMatch(openTag, /\brole=/, '#problem-banner has no role (the alert region announces, so it is not read twice)');
  const line = /<span\b[^>]*\bid="eval-error"[^>]*>/.exec(bannerMatch[1]);
  assert.ok(line, 'the banner must hold the #eval-error span');
  assert.ok(line[0].includes('hidden'), 'the #eval-error span must start with the hidden attribute');
  const header = /<header\b[^>]*\bid="top-bar"[^>]*>([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header && !header[1].includes('eval-error'), '#top-bar must not hold #eval-error any more');
  assert.match(html, /<div id="problem-alert" role="alert"><\/div>/, 'the alert region is always present and empty at load');
});

test('#top-bar contains a plain, un-accented Play/Stop button', () => {
  const topBarMatch = /<header\b[^>]*\bid="top-bar"[^>]*>([\s\S]*?)<\/header>/.exec(html);
  assert.ok(topBarMatch, '#top-bar header must exist in page/index.html');

  const innerHtml = topBarMatch[1];
  const buttonMatch = /<button\b[^>]*\bid="transport-button"[^>]*>/.exec(innerHtml);
  assert.ok(buttonMatch, '#top-bar must contain a button with id="transport-button"');
  assert.ok(buttonMatch[0].includes('type="button"'), '#transport-button must have type="button"');
  assert.ok(!buttonMatch[0].includes('data-accent'), '#transport-button must not carry a data-accent attribute');
});

test('data-accent="true" appears exactly once in page/index.html (the overlay CTA, not the Play/Stop button)', () => {
  const occurrences = html.match(/data-accent="true"/g) || [];
  assert.equal(occurrences.length, 1);
});
