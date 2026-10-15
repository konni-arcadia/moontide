// Pure module for Moontide's browser page: reads the harmony a piece declares. The declaration is one top-level
// constant named harmony, written as text in the code (a scale like 'D4:dorian' or a chord pattern like
// "<Dm7 G7 C^7>"). The page reads only that written text: nothing is evaluated, no value is computed, and a value
// that cannot be read says why. `parse` (acorn) is injected — Node resolves the `acorn` package directly, the
// browser reads the pinned acorn global — so this module has no DOM access at import time and can be
// imported directly by node:test and by page/main.js without a build step. It imports nothing.

export const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true };

/** The name the page looks for. */
const HARMONY_NAME = 'harmony';

/** The longest declaration text read, in characters. A longer text is not read at all (the code is not trusted). */
export const MAX_HARMONY_TEXT = 200;

/** The longest source quote an unreadable result carries, in code points. */
export const MAX_SOURCE_LENGTH = 40;

/** The ids of why a declaration cannot be read. The sentences for them live with the Jam copy. */
export const HARMONY_REASONS = Object.freeze([
  'not-const',
  'computed',
  'not-text',
  'not-a-harmony',
  'empty',
  'too-long',
  'not-a-plain-const',
]);

/**
 * The scale names the page knows, as [name, mode id] pairs, lowercase with one space between words. The mode ids are
 * the ids of MODES in page/jam-analysis.js (test/harmony.test.js checks every one). A name written with colons in
 * place of spaces ('harmonic:minor') is looked up with the colons turned into spaces.
 */
export const SCALE_NAME_IDS = Object.freeze([
  ['major', 'ionian'],
  ['ionian', 'ionian'],
  ['dorian', 'dorian'],
  ['phrygian', 'phrygian'],
  ['lydian', 'lydian'],
  ['mixolydian', 'mixolydian'],
  ['minor', 'aeolian'],
  ['aeolian', 'aeolian'],
  ['locrian', 'locrian'],
  ['harmonic minor', 'harmonic-minor'],
  ['melodic minor', 'melodic-minor'],
].map((pair) => Object.freeze(pair)));

const MODE_BY_NAME = new Map(SCALE_NAME_IDS);

const ROOT_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// Every pattern below is a literal written here; none is built from the code's text.
/** One scale token: root letter, a run of sharps or a run of flats, an optional signed octave, a colon, a name. */
const SCALE_TOKEN = /^([A-Ga-g])(#*|b*)(-?\d+)?:([A-Za-z0-9_: ]+)$/;
/** The same without spaces in the name: one step of a pattern. */
const SCALE_STEP = /^[A-Ga-g](#*|b*)(-?\d+)?:[A-Za-z0-9_:]+$/;
/** A chord symbol: an uppercase root, an optional flat or sharp, then only the pieces a chord name is made of
 * (a quality such as m, maj, min, dim, aug, sus, add, alt, ^, -, +, o or a half-diminished sign; a number, flat or sharp
 * with a number; a slash bass note). A plain word that starts with A to G ("Dorian", "Cat") is not a chord. */
const CHORD_STEP = /^[A-G][b#]?(?:maj|min|dim|aug|sus|add|alt|m|M|\^|-|\+|o|°|ø|\d|[b#]\d|\/[A-G][b#]?)*$/;
/** A group in parentheses that only holds numbers (an euclid rhythm) or altered numbers (the "(#9)" of a chord). */
const NUMBER_GROUP = /\((?:[b#]?\d+)(?:,[b#]?\d+)*\)/g;
/** The argument of a * or / step modifier: a number, a <...> group or a [...] group. */
const MODIFIER_ARGUMENT = /[*/](?:<[^<>]*>|\[[^[\]]*\]|[\d.]+)/g;
/** The extra words of a scale name that has spaces ("minor pentatonic") are lowercase; "C:major D" is not one scale. */
const SPACED_NAME_WORDS = /^[^ ]+( [a-z][a-z0-9_]*)*$/;
/** The characters that structure a mini-notation pattern, with whitespace. */
const STRUCTURE = /[\s<>[\]{}(),|]+/;
/** The characters that start a step modifier. */
const MODIFIER = /[*/@!%?]/;
/** A piece that is only a rest mark. */
const REST_ONLY = /^[~_.-]*$/;

/** Mirrors sourceOf in page/parts.js (kept as a copy: the modules stay independent); keep the two in step. The cut length is
 * MAX_SOURCE_LENGTH here and MAX_PROBLEM_SOURCE_LENGTH there. The source of `node`, cut at MAX_SOURCE_LENGTH code points with an ellipsis as the last one. */
function sourceOf(code, node) {
  const points = [...code.slice(node.start, node.end)];
  if (points.length <= MAX_SOURCE_LENGTH) return points.join('');
  return `${points.slice(0, MAX_SOURCE_LENGTH - 1).join('')}…`;
}

/** Mirrors collectPatternNames in page/parts.js; keep the two in step. The names a binding pattern binds, pushed to `names`. */
function collectPatternNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      collectPatternNames(property.type === 'RestElement' ? property.argument : property.value, names);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) collectPatternNames(element, names);
  } else if (pattern.type === 'AssignmentPattern') collectPatternNames(pattern.left, names);
  else if (pattern.type === 'RestElement') collectPatternNames(pattern.argument, names);
}

/** The text of a string literal or of a template literal with no placeholder, else null. */
function plainText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** The scale of a text that is one scale token, `{ rootPc, modeId }`, or null when the name is not one of the nine. */
function scaleOf(text) {
  const match = SCALE_TOKEN.exec(text);
  if (match === null) return null;
  const letter = match[1].toLowerCase();
  const accidentals = match[2];
  const shift = accidentals.startsWith('#') ? accidentals.length : -accidentals.length;
  const rootPc = (((ROOT_PC[letter] + shift) % 12) + 12) % 12;
  const name = match[4].replaceAll(':', ' ').toLowerCase().split(' ').filter((word) => word !== '').join(' ');
  const modeId = MODE_BY_NAME.get(name);
  return modeId === undefined ? null : { rootPc, modeId };
}

/** 'scale', 'chords' or null for a text that is neither, 'empty' when nothing is left to read. */
function classify(text) {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if (SCALE_TOKEN.test(trimmed) && SPACED_NAME_WORDS.test(trimmed.slice(trimmed.indexOf(':') + 1))) return 'scale';
  const steps = trimmed
    .replace(NUMBER_GROUP, '')
    .replace(MODIFIER_ARGUMENT, '')
    .split(STRUCTURE)
    .map((piece) => {
      const cut = MODIFIER.exec(piece);
      return cut === null ? piece : piece.slice(0, cut.index);
    })
    .filter((piece) => piece !== '' && !REST_ONLY.test(piece));
  if (steps.length === 0) return 'empty';
  if (steps.every((step) => SCALE_STEP.test(step))) return 'scale';
  if (steps.every((step) => CHORD_STEP.test(step))) return 'chords';
  return null;
}

/**
 * Reads the top-level constant named harmony from `code`. Returns plain data:
 * `{ state: 'none' }` when no top-level binding has that name (a nested one, an object key, a string and a labeled
 * statement `harmony: ...` are not a declaration); `{ state: 'declared', kind: 'scale' | 'chords', text, scale }`
 * with `text` as written and `scale` `{ rootPc, modeId }` only when the whole text is one scale token whose name is
 * one of the nine scales (else null); `{ state: 'unreadable', reason, source }` with a reason of HARMONY_REASONS and
 * `source` the initializer's code cut for the reasons that quote it (computed, not-text, not-a-harmony), else null.
 * The first top-level declarator that binds the name decides. Nothing is evaluated.
 */
export function readHarmony(code, { parse }) {
  const ast = parse(code, PARSE_OPTIONS);
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      const names = [];
      collectPatternNames(declarator.id, names);
      if (!names.includes(HARMONY_NAME)) continue;
      return readDeclarator(code, statement.kind, declarator);
    }
  }
  return { state: 'none' };
}

/**
 * Reads one harmony text, as written in a section of a song or in a fixed variation: `{ kind: 'scale' | 'chords', scale }`
 * with `scale` `{ rootPc, modeId }` only when the whole text is one scale token whose name is one of the nine scales (else
 * null), or null when the text is neither a scale nor chords (nothing left to read, too long, a plain word). The same
 * reading as a top-level declaration: readHarmony calls the same checks.
 */
export function readHarmonyText(text) {
  if (text.length > MAX_HARMONY_TEXT) return null;
  const found = classify(text);
  if (found === null || found === 'empty') return null;
  return { kind: found, scale: found === 'scale' ? scaleOf(text.trim()) : null };
}

function unreadable(reason, source = null) {
  return { state: 'unreadable', reason, source };
}

function readDeclarator(code, kind, declarator) {
  if (kind !== 'const') return unreadable('not-const');
  if (declarator.id.type !== 'Identifier') return unreadable('not-a-plain-const');
  const init = declarator.init;
  let text = plainText(init);
  let chordCall = false;
  if (text === null && init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'chord' && init.arguments.length === 1) {
    text = plainText(init.arguments[0]);
    chordCall = text !== null;
  }
  if (text === null) {
    const isNumber = (node) => node.type === 'Literal' && typeof node.value === 'number';
    if (
      (init.type === 'Literal' && typeof init.value !== 'string') ||
      init.type === 'ArrayExpression' ||
      init.type === 'ObjectExpression' ||
      (init.type === 'UnaryExpression' && (init.operator === '-' || init.operator === '+') && isNumber(init.argument))
    ) {
      return unreadable('not-text', sourceOf(code, init));
    }
    return unreadable('computed', sourceOf(code, init));
  }
  if (text.length > MAX_HARMONY_TEXT) return unreadable('too-long');
  const found = classify(text);
  if (found === 'empty') return unreadable('empty');
  if (found === null || (chordCall && found !== 'chords')) return unreadable('not-a-harmony', sourceOf(code, init));
  return { state: 'declared', kind: found, text, scale: found === 'scale' ? scaleOf(text.trim()) : null };
}
