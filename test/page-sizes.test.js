// Contract test for the responsive base font size.
// Reuses test/page-accent.test.js's comment-stripping/simple-rule-walker approach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS_PATH = fileURLToPath(new URL('../page/style.css', import.meta.url));

const css = readFileSync(CSS_PATH, 'utf8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Returns [selectorList, body] pairs for every `{...}` rule in `source`. Asserts loudly if the
 * stylesheet grows an at-rule, since this simple walker cannot handle nested/conditional rules
 * (same guard as test/page-accent.test.js and test/page-destructive.test.js). */
function rules(source) {
  assert.ok(
    !source.includes('@'),
    'page/style.css contains an at-rule (@...); the simple rule parser in test/page-sizes.test.js must be upgraded before at-rules are added',
  );
  const found = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(source)) !== null) {
    found.push([match[1].trim(), match[2]]);
  }
  return found;
}

test('page/style.css has no at-rule', () => {
  assert.ok(!stripped.includes('@'));
});

test('the :root rule sets the responsive base font size', () => {
  const rootRule = rules(stripped).find(([selector]) => selector === ':root');
  assert.ok(rootRule, ':root rule must exist in page/style.css');
  assert.match(rootRule[1], /font-size:\s*clamp\(15px,\s*0\.78vw,\s*22px\)/);
});

test('every px size is a 1px hairline or one of the clamp bounds (15px/22px)', () => {
  const pxValues = stripped.match(/\d+(\.\d+)?px/g) || [];
  const offenders = pxValues.filter((value) => !['1px', '15px', '22px'].includes(value));
  assert.deepEqual(offenders, [], `unexpected px values outside 1px/15px/22px: ${JSON.stringify(offenders)}`);
});

test('every font-size declaration outside :root uses rem or em', () => {
  const offenders = [];
  for (const [selector, body] of rules(stripped)) {
    if (selector === ':root') continue;
    const fontSizeMatch = body.match(/font-size:\s*([^;]+);/);
    if (!fontSizeMatch) continue;
    const value = fontSizeMatch[1].trim();
    if (!/^-?[\d.]+(rem|em)$/.test(value)) {
      offenders.push(`${selector}: ${value}`);
    }
  }
  assert.deepEqual(offenders, []);
});
