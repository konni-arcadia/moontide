// Pure module for the Mixer view: reads a track's chain out of the playing code and writes a
// control change back as a list of `{ from, to, insert }` edits. Only the track's "spine" is
// ever read or written: the outer `.method(args)` calls of the track expression, down to its
// root call. Calls inside function arguments (`.every(2, x => x.gain(0.5))`) are never touched,
// and every byte of the program outside the edits is preserved.
// `parse` (acorn) is injected — Node resolves the `acorn` package directly, the browser reads
// the pinned `window.acorn` global — so this module has no DOM access at import time and can be
// imported directly by node:test and by page/main.js without a build step.
//
// The mixer never guesses where to write: a track that depends on a runtime
// condition or is written in a shape this module does not understand is refused with a reason
// code, and the caller disables that track's controls. A track built from a declared constant or
// function is written at the end of its own chain, so the declaration and the other tracks that
// read it are never touched.

import { PARSE_OPTIONS, SOLO_MARKER, extractTracks, trackNodes, isRuntimeConditional, parseLabel } from './tracks.js';
import { BUSES, BUS_IDS, COMPRESSOR_FIELDS, CHAIN_ORDER, DEFAULT_POSTGAIN, EFFECTS, EFFECT_IDS, MOVE_OVER_MAX, MOVE_OVER_MIN, MOVE_SHAPES, SENDS, busParamById, clampToParam, effectById, effectOfMethod, fixedValueOf, formatNumber, methodOf, moveText, normalizeStoredCall, roundTo, roundToParam, storedCallText } from './mixer-registry.js';

/** Why a track is refused; the view maps each to one short line. */
export const REFUSAL_REASONS = ['condition', 'unsupported-shape'];

const REASON_MESSAGES = {
  condition: 'this track depends on a condition, so the mixer cannot edit it.',
  'unsupported-shape': 'this track is written in a shape the mixer does not understand.',
  'track-gone': 'this track is not in the code any more.',
  'unsupported-change': 'the mixer cannot make this change to this track.',
};

/**
 * A rewrite the mixer refuses. `reason` is one of REFUSAL_REASONS, or 'track-gone' (the identity
 * is not in the code any more) or 'unsupported-change' (a change this track's code cannot take,
 * such as gain and post-gain both moving). The message always starts with 'Moontide: '.
 */
export class MixerRewriteError extends Error {
  constructor(reason, detail) {
    super(`Moontide: ${detail ?? REASON_MESSAGES[reason] ?? reason}`);
    this.name = 'MixerRewriteError';
    this.reason = reason;
  }
}

/**
 * Applies `edits` — `{ from, to, insert }` in ORIGINAL coordinates — and returns the rebuilt
 * text. Edits are sorted by `from`; two edits that overlap throw. Every other byte is kept.
 */
export function applyEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let out = '';
  let pos = 0;
  for (const edit of sorted) {
    if (edit.from < pos) {
      throw new Error(`Moontide: two mixer edits overlap at offset ${edit.from}.`);
    }
    out += code.slice(pos, edit.from) + edit.insert;
    pos = edit.to;
  }
  return out + code.slice(pos);
}

/**
 * The same edits mapped to NEW coordinates, `[{ from, to }]` ascending: the ranges of the
 * rebuilt text that the edits wrote, for the touched-line highlight. Sorted like applyEdits.
 */
export function touchedRanges(edits) {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let delta = 0;
  const ranges = [];
  for (const edit of sorted) {
    const from = edit.from + delta;
    ranges.push({ from, to: from + edit.insert.length });
    delta += edit.insert.length - (edit.to - edit.from);
  }
  return ranges;
}

// --- Reading the spine ---

/** The names of the calls this module reads and writes (the volume). */
const MIXER_CALLS = new Set(['gain', 'postgain']);

/** The numeric value of a number Literal, or of a negated one (`-N`); null for anything else.
 * Same rule as page/parts.js numericLiteralValue, with one more limit: a value the mixer can
 * neither show nor write back (Infinity from `1e400`, or 1e21 and above, which formatNumber
 * refuses) is not read as a number, so the track reads as moving instead of crashing the mixer. */
function numericLiteralValue(node) {
  if (!node) return null;
  let value = null;
  if (node.type === 'Literal' && typeof node.value === 'number') value = node.value;
  else if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
    value = -node.argument.value;
  }
  return value !== null && Number.isFinite(value) && Math.abs(value) < 1e21 ? value : null;
}

/** Adds every identifier a binding pattern declares (destructuring included) to `names`. */
function collectPatternNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    names.add(pattern.name);
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      collectPatternNames(property.type === 'RestElement' ? property.argument : property.value, names);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) collectPatternNames(element, names);
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, names);
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, names);
  }
}

/** Every name declared at the top level of the program: variables (destructured names too),
 * functions and classes. A track rooted in one of them is built by shared code the mixer cannot
 * see into; it still writes at the end of the track's own chain (see `sharedRoot`). Exported because
 * page/midi-controls.js reads it too: a declared name keeps a MIDI track's strip. */
export function topLevelDeclaredNames(ast) {
  const names = new Set();
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) collectPatternNames(declarator.id, names);
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) {
      names.add(statement.id.name);
    }
  }
  return names;
}

/** Calls `visit` for every AST node under (and including) `node`. Exported because page/midi-controls.js walks trees too. */
export function walkNodes(node, visit) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkNodes(child, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key !== 'type') walkNodes(node[key], visit);
  }
}

/** The child nodes of `node`, in source order of their keys. */
function childNodes(node) {
  const children = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item === 'object' && typeof item.type === 'string') children.push(item);
    } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
      children.push(value);
    }
  }
  return children;
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** The names a list of statements declares in its own block: let, const, class and function declarations. */
function lexicalNames(statements) {
  const names = new Set();
  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations) collectPatternNames(declarator.id, names);
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) {
      names.add(statement.id.name);
    }
  }
  return names;
}

/** Adds the `var` names and the function declarations under `node` that hoist to its function, without entering nested functions. */
function hoistedNames(node, names) {
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declarator of node.declarations) collectPatternNames(declarator.id, names);
  }
  for (const child of childNodes(node)) {
    if (child.type === 'FunctionDeclaration' && child.id) names.add(child.id.name);
    if (!FUNCTION_TYPES.has(child.type)) hoistedNames(child, names);
  }
}

/**
 * Calls `visit(name)` for every identifier under `root` that reads a binding from outside `root`: not the
 * property of a plain member access (`.scale`), not an object key (`{ lead: 1 }`), not a label, not the target of a plain
 * assignment, not a name a declaration inside `root` introduces, and not a name a parameter, a local
 * binding, a catch clause or a loop shadows at that point. What it reports is a reference to a name declared outside `root`.
 */
function walkReferences(root, visit) {
  const isBound = (scope, name) => {
    for (let at = scope; at !== null; at = at.parent) if (at.names.has(name)) return true;
    return false;
  };
  const inner = (scope, names) => ({ names, parent: scope });
  const each = (node, scope) => {
    for (const child of childNodes(node)) go(child, scope);
  };
  const pattern = (node, scope) => {
    if (node === null || node === undefined) return;
    if (node.type === 'Identifier') return;
    if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        if (property.type === 'RestElement') {
          pattern(property.argument, scope);
        } else {
          if (property.computed) go(property.key, scope);
          pattern(property.value, scope);
        }
      }
    } else if (node.type === 'ArrayPattern') {
      for (const element of node.elements) pattern(element, scope);
    } else if (node.type === 'AssignmentPattern') {
      pattern(node.left, scope);
      go(node.right, scope);
    } else if (node.type === 'RestElement') {
      pattern(node.argument, scope);
    } else {
      go(node, scope);
    }
  };
  const go = (node, scope) => {
    switch (node.type) {
      case 'Identifier':
        if (!isBound(scope, node.name)) visit(node.name);
        return;
      case 'MemberExpression':
        go(node.object, scope);
        if (node.computed) go(node.property, scope);
        return;
      case 'Property':
        if (node.computed) go(node.key, scope);
        go(node.value, scope);
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) go(node.key, scope);
        if (node.value) go(node.value, scope);
        return;
      case 'LabeledStatement':
        go(node.body, scope);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
        return;
      case 'VariableDeclaration':
        for (const declarator of node.declarations) {
          pattern(declarator.id, scope);
          if (declarator.init) go(declarator.init, scope);
        }
        return;
      case 'AssignmentExpression':
        if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') pattern(node.left, scope);
        else if (!(node.left.type === 'Identifier' && node.operator === '=')) go(node.left, scope);
        go(node.right, scope);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const names = new Set();
        for (const param of node.params) collectPatternNames(param, names);
        if (node.type === 'FunctionExpression' && node.id) names.add(node.id.name);
        if (node.body.type === 'BlockStatement') hoistedNames(node.body, names);
        const local = inner(scope, names);
        for (const param of node.params) pattern(param, local);
        go(node.body, local);
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const local = node.type === 'ClassExpression' && node.id ? inner(scope, new Set([node.id.name])) : scope;
        if (node.superClass) go(node.superClass, local);
        go(node.body, local);
        return;
      }
      case 'Program':
      case 'BlockStatement':
      case 'StaticBlock': {
        const local = inner(scope, lexicalNames(node.body));
        for (const statement of node.body) go(statement, local);
        return;
      }
      case 'SwitchStatement': {
        go(node.discriminant, scope);
        const local = inner(scope, lexicalNames(node.cases.flatMap((entry) => entry.consequent)));
        for (const entry of node.cases) {
          if (entry.test) go(entry.test, local);
          for (const statement of entry.consequent) go(statement, local);
        }
        return;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const head = node.type === 'ForStatement' ? node.init : node.left;
        const names = head && head.type === 'VariableDeclaration' && head.kind !== 'var' ? lexicalNames([head]) : new Set();
        each(node, inner(scope, names));
        return;
      }
      case 'CatchClause': {
        const names = new Set();
        collectPatternNames(node.param, names);
        const local = inner(scope, names);
        pattern(node.param, local);
        go(node.body, local);
        return;
      }
      default:
        each(node, scope);
    }
  };
  go(root, null);
}

/**
 * What the program declares at its top level: `{ declared, bodies }`. `declared` is the Set of
 * topLevelDeclaredNames; `bodies` maps each declared name to the code that defines it (the initializer of its
 * variable or an assignment to it, or its function or class), so a track's reach into shared code can be read (see reachableCode).
 */
function readScope(ast) {
  const bodies = new Map();
  const add = (names, body) => {
    for (const name of names) {
      if (!bodies.has(name)) bodies.set(name, []);
      bodies.get(name).push(body);
    }
  };
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        const names = new Set();
        collectPatternNames(declarator.id, names);
        if (declarator.init) add(names, declarator.init);
      }
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) {
      add([statement.id.name], statement);
    }
  }
  // A name assigned later (`let synth; synth = note("c").midi('JX')`, anywhere in the program) is defined by that code too.
  walkNodes(ast, (node) => {
    if (node.type !== 'AssignmentExpression') return;
    const names = new Set();
    collectPatternNames(node.left, names);
    add(names, node.right);
  });
  return { declared: topLevelDeclaredNames(ast), bodies };
}

/**
 * The code a track's sound can come from, beyond its own chain: `{ expression, declarations }`, the track's
 * `expression` (the arguments of its calls included) and the bodies of the shared code it reaches, that is
 * every declared name that code refers to, transitively. Only a real reference counts (see walkReferences): a method
 * name (`.scale(`), an object key (`{ lead: 1 }`) or a name a parameter or a local binding shadows is not one. `declarations` is empty for a track that names none.
 */
function reachableCode(expression, scope) {
  const declarations = [];
  const seen = new Set();
  const queue = [expression];
  while (queue.length > 0) {
    walkReferences(queue.pop(), (name) => {
      if (seen.has(name) || !scope.bodies.has(name)) return;
      seen.add(name);
      for (const body of scope.bodies.get(name)) {
        declarations.push(body);
        queue.push(body);
      }
    });
  }
  return { expression, declarations };
}

/** The text of a property key or computed member that is a plain string (or a template without a placeholder), else null. */
function plainKeyText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? null;
  return null;
}

/** The name a call writes: `.name(`, `['name'](` or a bare `name(`; null for any other callee. */
function calledName(call) {
  const { callee } = call;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type !== 'MemberExpression') return null;
  if (!callee.computed) return callee.property.type === 'Identifier' ? callee.property.name : null;
  return plainKeyText(callee.property);
}

/** The names an object literal holds as keys (`{ orbit: 2 }`, `{ 'orbit': 2 }`, `{ orbit }`, `{ ['orbit']: 2 }`). */
function objectKeyNames(node) {
  const names = [];
  for (const property of node.properties) {
    if (property.type !== 'Property') continue;
    if (!property.computed && property.key.type === 'Identifier') names.push(property.key.name);
    else {
      const text = plainKeyText(property.key);
      if (text !== null) names.push(text);
    }
  }
  return names;
}

/**
 * True when some node under `roots` writes a name that satisfies `test`: a call (`.name(`, `['name'](` or a bare
 * `name(`) that is not one of the `skip` calls, or, unless `keys` is false, an object literal with such a key
 * (`.set({ name: ... })`).
 */
function writesName(roots, test, { skip = new Set(), keys = true } = {}) {
  let found = false;
  for (const root of roots) {
    walkNodes(root, (node) => {
      if (found) return;
      if (node.type === 'CallExpression' && !skip.has(node)) {
        const name = calledName(node);
        if (name !== null && test(name)) found = true;
      } else if (keys && node.type === 'ObjectExpression' && objectKeyNames(node).some(test)) {
        found = true;
      }
    });
  }
  return found;
}

/** The registry keys that decide which bus a sound goes to or is shaped by: the orbit, the two sends and the bus values. */
const BUS_KEYS = new Set(['orbit', ...Object.values(SENDS).map((send) => send.key), ...BUS_IDS.flatMap((bus) => BUSES[bus].params.map((param) => param.key))]);

/** True for a method name (or alias) that writes one of the BUS_KEYS. */
function writesBusKey(name) {
  const meta = methodOf(name);
  return meta !== null && meta.keys.some((key) => BUS_KEYS.has(key));
}

/**
 * What a track reaches beyond its own chain: `{ playsMidi, innerPostgain, busHidden }`. `playsMidi` is true when a `.midi(`
 * call (or `['midi'](`, or a bare `midi(`) sits anywhere the track's code reaches (its own chain, the arguments of its calls or shared code it
 * names): MIDI output ignores `postgain`, so a post-gain fader would do nothing on such a track.
 * `innerPostgain` is true when a `.postgain(` call (or a bare `postgain(`, or a `{ postgain }` key as in `.set({ postgain: .5 })`) sits anywhere that code reaches other than on the spine:
 * `postgain` is replaced by a later write like `gain` is, so a fader's `.postgain(n)` at the end of the chain
 * would flatten it. `busHidden` is true when anything the track reaches, other than the calls of its own chain,
 * writes an orbit, a send or a bus value (a call inside another call, a bare call, `.set({ orbit })`, a constant
 * or a function it names): the spine read cannot see which bus the track is really on, so it must not edit one. The
 * mixer prefers refusing to guessing: any such write, even one it could read, turns the sends off.
 */
function readReach(spine, expression, scope) {
  const { declarations } = reachableCode(expression, scope);
  const all = [expression, ...declarations];
  const spineNodes = new Set(spine.calls.map((call) => call.node));
  return {
    playsMidi: writesName(all, (name) => name === 'midi', { keys: false }),
    innerPostgain: writesName(all, (name) => name === 'postgain', { skip: spineNodes }),
    busHidden: writesName(all, writesBusKey, { skip: spineNodes }),
  };
}

/**
 * The spine of `expression`: `{ calls, root }`, `calls` in source order, each `{ node, name,
 * dotStart }` (`dotStart` the offset of its `.` token), `root` the first node that is not such a
 * call. Throws 'unsupported-shape' when a call's `.` is not a plain dot directly before the
 * method name (a comment between them, or `?.`). Exported because page/midi-controls.js reads the
 * spine of a MIDI track too (it imports this module, never the reverse).
 */
export function readSpine(code, expression) {
  const calls = [];
  let cur = expression;
  while (
    cur.type === 'CallExpression' &&
    !cur.optional &&
    cur.callee.type === 'MemberExpression' &&
    !cur.callee.computed &&
    !cur.callee.optional &&
    cur.callee.property.type === 'Identifier'
  ) {
    let dot = cur.callee.property.start - 1;
    while (dot > cur.callee.object.end && /\s/.test(code[dot])) dot -= 1;
    if (code[dot] !== '.' || code[dot - 1] === '?') {
      throw new MixerRewriteError('unsupported-shape');
    }
    calls.push({ node: cur, name: cur.callee.property.name, dotStart: dot });
    cur = cur.callee.object;
  }
  calls.reverse();
  return { calls, root: cur };
}

/** Throws the refusal for a root the mixer does not understand. */
function checkRoot(root) {
  if (isRuntimeConditional(root)) throw new MixerRewriteError('condition');
  if (root.type === 'CallExpression' && root.callee.type === 'Identifier') return;
  if (root.type === 'Identifier') return;
  if (root.type === 'Literal' && typeof root.value === 'string') return;
  if (root.type === 'TemplateLiteral' || root.type === 'TaggedTemplateExpression') return;
  throw new MixerRewriteError('unsupported-shape');
}

/** What the LAST spine call named `name` says: `{ kind: 'none'|'fixed'|'pattern', value, call }`.
 * The last writer wins (verified live). */
function readControl(calls, name) {
  let last = null;
  for (const call of calls) if (call.name === name) last = call;
  if (!last) return { kind: 'none', value: null, call: null };
  const value = numericLiteralValue(last.node.arguments[0]);
  return value === null ? { kind: 'pattern', value: null, call: last } : { kind: 'fixed', value, call: last };
}

/** The text of a string Literal, or null for anything else. */
function stringLiteralValue(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

/** The numbers of a compressor string `"t:r:k:a:l"` (one to five plain numbers), or null. */
function compressorStringFields(text) {
  const parts = text.split(':');
  if (parts.length > COMPRESSOR_FIELDS.length || !parts.every((part) => PLAIN_NUMBER.test(part))) return null;
  return parts.map(Number);
}

/** True for an argument that can write every key of a method's pack: a string with a `:` in it
 * (`"300:4"`). A number, a signal or any other pattern of plain values writes only the first key. */
function packedArgument(node) {
  const text = stringLiteralValue(node);
  if (text !== null) return text.includes(':');
  return node.type === 'TemplateLiteral' && node.quasis.some((quasi) => quasi.value.raw.includes(':'));
}

/** True for a call `.name(...)` written with a plain dot on an expression: not `?.`, not `obj[name]`. */
function plainMethodCall(node, name) {
  return (
    node.type === 'CallExpression' &&
    !node.optional &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    !node.callee.optional &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === name
  );
}

/**
 * The filter move `arg` writes, `{ shape, from, to, over }`, or null. Exactly `X.range(a, b).slow(N)`
 * is read: `X` a bare sine, tri or saw that the program does not declare itself, `a` and `b` number
 * literals inside the parameter's range, `N` a whole number literal from MOVE_OVER_MIN to
 * MOVE_OVER_MAX. Every other pattern is null and stays "Moving (from code)": the mixer never guesses.
 */
function readMove(arg, param, declared) {
  if (!param.movable || !plainMethodCall(arg, 'slow') || arg.arguments.length !== 1) return null;
  const over = numericLiteralValue(arg.arguments[0]);
  if (over === null || !Number.isInteger(over) || over < MOVE_OVER_MIN || over > MOVE_OVER_MAX) return null;
  const range = arg.callee.object;
  if (!plainMethodCall(range, 'range') || range.arguments.length !== 2) return null;
  const [from, to] = range.arguments.map(numericLiteralValue);
  if (from === null || to === null) return null;
  if (from < param.min || from > param.max || to < param.min || to > param.max) return null;
  const shape = range.callee.object;
  if (shape.type !== 'Identifier' || !MOVE_SHAPES.includes(shape.name) || declared.has(shape.name)) return null;
  return { shape: shape.name, from, to, over };
}

/**
 * What the calls of the track say about one parameter: `{ kind: 'unwritten'|'fixed'|'move'|'pattern',
 * value, method }` (`move` only for the cutoff of a filter, with `move: { shape, from, to, over }`, see readMove). The last call that writes the parameter's control key wins (verified live):
 * a plain value (a number, a signal, a pattern of numbers) writes only its method's first key, a
 * string with a `:` in it may write every key of the pack. A parameter is 'fixed' only for a
 * numeric literal (for a select, a string literal from its own list written by its own method).
 */
function readParam(calls, param, declared) {
  const keys = param.alt ? [param.key, param.alt.key] : [param.key];
  let last = null;
  let lastIsPrimary = false;
  for (const call of calls) {
    const meta = methodOf(call.name);
    const arg = call.node.arguments[0];
    if (!meta || !arg) continue;
    const writes = packedArgument(arg) ? meta.keys.some((key) => keys.includes(key)) : keys.includes(meta.keys[0]);
    if (!writes) continue;
    // The per-cycle form wins over the Hz form of a parameter with `alt` (`tremolosync` over
    // `tremolo`, whatever the order): the Hz call is read only while no per-cycle call writes it.
    if (param.alt && lastIsPrimary && meta.canonical !== param.method) continue;
    if (param.alt && meta.canonical === param.method) lastIsPrimary = true;
    last = call;
  }
  if (!last) return { kind: 'unwritten', value: null, method: null, call: null };
  const meta = methodOf(last.name);
  const arg = last.node.arguments[0];
  if (param.kind === 'number') {
    const value = numericLiteralValue(arg);
    if (value !== null) return { kind: 'fixed', value, method: meta.canonical, call: last };
    const move = readMove(arg, param, declared);
    return move === null ? { kind: 'pattern', value: null, method: meta.canonical, call: last } : { kind: 'move', value: null, method: meta.canonical, move, call: last };
  }
  const text = stringLiteralValue(arg);
  if (text !== null && param.options.includes(text) && meta.canonical === param.method) {
    return { kind: 'fixed', value: text, method: meta.canonical, call: last };
  }
  return { kind: 'pattern', value: null, method: meta.canonical, call: last };
}

/** The five compressor fields, folded over every `.compressor(...)` call in source order: a number
 * sets the threshold, a string of plain numbers sets its fields, anything else is a pattern. */
function readCompressorFields(calls) {
  let fields = COMPRESSOR_FIELDS.map(() => ({ kind: 'unwritten', value: null, method: null }));
  for (const call of calls) {
    const arg = call.node.arguments[0];
    const number = numericLiteralValue(arg);
    if (number !== null) {
      fields[0] = { kind: 'fixed', value: number, method: 'compressor' };
      continue;
    }
    const text = stringLiteralValue(arg);
    const parts = text === null ? null : compressorStringFields(text);
    if (parts === null) {
      fields = COMPRESSOR_FIELDS.map(() => ({ kind: 'pattern', value: null, method: 'compressor' }));
    } else {
      parts.forEach((value, i) => {
        fields[i] = { kind: 'fixed', value, method: 'compressor' };
      });
    }
  }
  return fields;
}

/** Why a bypass is refused: the sentence page/mixer-model.js shows (MIXER_COPY.bypassNeedsFixed). */
const BYPASS_NEEDS_FIXED = 'Bypass needs fixed values; use a fixed value first, or Remove.';

/**
 * The calls of an effect as a bypass record stores them, or why they cannot be stored: `{ calls,
 * why: null }` (canonical calls in source order: `{ method, value }`, or one `{ method:
 * 'compressor', fields }`), `{ calls: null, why: 'moving' }` for a value that is not fixed in the
 * code, or `{ calls: null, why: 'range' }` for a value outside the registry range.
 */
function storableCalls(effect, calls, declared) {
  if (effect.id === 'compressor') {
    const fields = readCompressorFields(calls);
    if (fields.some((field) => field.kind === 'pattern')) return { calls: null, why: 'moving' };
    const values = [];
    for (const field of fields) {
      if (field.kind !== 'fixed') break;
      values.push(field.value);
    }
    const stored = normalizeStoredCall('compressor', { method: 'compressor', fields: values });
    return stored ? { calls: [stored], why: null } : { calls: null, why: 'range' };
  }
  const stored = [];
  for (const call of calls) {
    const method = methodOf(call.name).canonical;
    const param = effect.params.find((candidate) => candidate.method === method || (candidate.alt && candidate.alt.method === method));
    const arg = call.node.arguments[0];
    const value = param.kind === 'select' ? stringLiteralValue(arg) : numericLiteralValue(arg);
    // A filter move the mixer understands is stored as its shape and three numbers.
    const move = value === null && param.kind === 'number' ? readMove(arg, param, declared) : null;
    if (value === null && move === null) return { calls: null, why: 'moving' };
    const normalized = normalizeStoredCall(effect.id, move === null ? { method, value } : { method, move });
    if (normalized === null) return { calls: null, why: 'range' };
    stored.push(normalized);
  }
  return { calls: stored, why: null };
}

/**
 * The chain effects of a spine: a Map from effect id to `{ calls, params, written, stored, bypassWhy }` for every
 * effect with at least one spine call. `calls` are the spine calls (source order, aliases and
 * duplicates included), `params` one read per parameter id, `written` the source text of the
 * calls from their dots, joined in source order, `stored` the calls a bypass would store (null
 * when it cannot) and `bypassWhy` null, 'moving' or 'range' (see storableCalls).
 */
function readEffects(code, spineCalls, declared) {
  const effects = new Map();
  for (const effect of EFFECTS) {
    const calls = spineCalls.filter((call) => effectOfMethod(call.name) === effect.id);
    if (calls.length === 0) continue;
    const params = {};
    if (effect.id === 'compressor') {
      const fields = readCompressorFields(calls);
      for (const param of effect.params) params[param.id] = fields[param.field];
    } else {
      for (const param of effect.params) params[param.id] = readParam(spineCalls, param, declared);
    }
    const { calls: stored, why } = storableCalls(effect, calls, declared);
    effects.set(effect.id, { calls, params, written: calls.map((call) => code.slice(call.dotStart, call.node.end)).join(''), stored, bypassWhy: why });
  }
  return effects;
}

// --- Sends, buses and orbits ---

/** The orbit is read like a number parameter: the last writer wins, a plain number is fixed. */
const ORBIT_PARAM = Object.freeze({ key: 'orbit', kind: 'number' });

/**
 * What a track's spine says about the shared buses: `{ orbit, sends, busParams }`, each read carrying
 * its last call. `orbit` is `{ kind: 'unwritten' | 'fixed' | 'pattern', value }` (1 when unwritten,
 * Strudel's default); `sends.reverb` and `sends.delay` are parameter reads of the `.room` and `.delay`
 * calls (an unwritten send is not sent); `busParams.reverb.size` and the rest are parameter reads of
 * the bus values written on this track. The mixer never writes an orbit.
 */
function readBusFacts(calls, declared) {
  const orbit = readParam(calls, ORBIT_PARAM, declared);
  const sends = {};
  const busParams = {};
  for (const bus of BUS_IDS) {
    sends[bus] = readParam(calls, SENDS[BUSES[bus].send], declared);
    busParams[bus] = Object.fromEntries(BUSES[bus].params.map((param) => [param.id, readParam(calls, param, declared)]));
  }
  return { orbit: { ...orbit, value: orbit.kind === 'unwritten' ? 1 : orbit.value }, sends, busParams };
}

/** True when a track with these facts feeds `bus` on `orbit`: a send above 0 (or one that moves in the code). */
function feedsBus(facts, bus, orbit) {
  const send = facts.sends[bus];
  const sending = send.kind === 'pattern' || (send.kind === 'fixed' && send.value > 0);
  return sending && facts.orbit.kind !== 'pattern' && facts.orbit.value === orbit;
}

/** Reads one track: its spine and its volume controls. Throws the refusal (MixerRewriteError). */
function inspectTrack(code, entry, scope) {
  const { declared } = scope;
  if (entry.unnamed) throw new MixerRewriteError('condition');
  const spine = readSpine(code, entry.expression);
  checkRoot(spine.root);
  const root = spine.root;
  const sharedRoot =
    (root.type === 'Identifier' && declared.has(root.name)) ||
    (root.type === 'CallExpression' && root.callee.type === 'Identifier' && declared.has(root.callee.name));
  // A track that starts with play(...) may be built by the song's own helper, whose lines are not shared code the user needs
  // to hear about. The model drops the "built from shared code" line only when the song reading says that helper is the
  // canonical one; this read just says the track starts with a call named play.
  const playRoot = root.type === 'CallExpression' && root.callee.type === 'Identifier' && root.callee.name === 'play';
  for (const call of spine.calls) {
    if (!MIXER_CALLS.has(call.name) && effectOfMethod(call.name) === null) continue;
    const args = call.node.arguments;
    if (args.length !== 1 || args[0].type === 'SpreadElement') {
      throw new MixerRewriteError('unsupported-shape');
    }
  }
  return {
    spine,
    sharedRoot,
    playRoot,
    ...readReach(spine, entry.expression, scope),
    gain: readControl(spine.calls, 'gain'),
    postgain: readControl(spine.calls, 'postgain'),
    effects: readEffects(code, spine.calls, declared),
    bus: readBusFacts(spine.calls, declared),
  };
}

/** The read of the effects without source positions, for the model: the call names, the parameter
 * reads and the written text. */
function publicEffects(effects) {
  return new Map(
    [...effects].map(([id, effect]) => [
      id,
      {
        calls: effect.calls.map((call) => ({ method: call.name, canonical: methodOf(call.name).canonical })),
        params: Object.fromEntries(Object.entries(effect.params).map(([id, { kind, value, method, move }]) => [id, move === undefined ? { kind, value, method } : { kind, value, method, move }])),
        written: effect.written,
        bypassable: effect.stored !== null,
        bypassWhy: effect.bypassWhy,
      },
    ]),
  );
}

function publicControl({ kind, value }) {
  return { kind, value };
}

/** The bus facts of a track without source positions, for the model. */
function publicBus({ orbit, sends, busParams }) {
  return {
    orbit: publicControl(orbit),
    sends: Object.fromEntries(Object.entries(sends).map(([bus, read]) => [bus, publicControl(read)])),
    busParams: Object.fromEntries(
      Object.entries(busParams).map(([bus, reads]) => [bus, Object.fromEntries(Object.entries(reads).map(([id, read]) => [id, publicControl(read)]))]),
    ),
  };
}

/**
 * Parses `code` once and reads every track: `{ tracks, reads }`, `tracks` from extractTracks and
 * `reads` a Map from track identity to `{ ok: true, gain: { kind, value }, postgain: { kind,
 * value }, effects, bus, label, sharedRoot, playRoot, playsMidi, innerPostgain }` (`sharedRoot` is true when the track's root is a declared name or a call of one; `playRoot` is true when the track's own statement starts with a `play(...)` call; `playsMidi` is true when a `.midi(` call sits anywhere the track's code reaches, `innerPostgain` is true when a `.postgain(` call sits in that code off the spine; `busHidden` is true when the track writes an orbit, a send or a bus value anywhere but on its own chain (inside another call, in shared code it names, through `.set({ ... })` or a bare call), so its bus facts are not trusted; see readReach; kind 'none', 'fixed' or 'pattern'; `bus` is `{ orbit, sends, busParams }`
 * of readBusFacts without call positions (kind 'unwritten', 'fixed' or 'pattern'); `effects` is a Map from effect id
 * to `{ calls, params, written, bypassable, bypassWhy }`, see readEffects; `label` is null for a track without one,
 * else `{ raw, ...parseLabel(raw) }`) or `{ ok: false, reason }`. One bad track never throws; an
 * unparsable program throws the parser's own error.
 */
export function readProgram(code, { parse }) {
  const ast = parse(code, PARSE_OPTIONS);
  const tracks = extractTracks(code, { parse });
  const nodes = trackNodes(ast);
  const scope = readScope(ast);
  const reads = new Map();
  tracks.forEach((track, i) => {
    try {
      const read = inspectTrack(code, nodes[i], scope);
      const raw = nodes[i].labelNode ? nodes[i].labelNode.name : null;
      reads.set(track.identity, {
        ok: true,
        gain: publicControl(read.gain),
        postgain: publicControl(read.postgain),
        effects: publicEffects(read.effects),
        bus: publicBus(read.bus),
        label: raw === null ? null : { raw, ...parseLabel(raw) },
        sharedRoot: read.sharedRoot,
        playRoot: read.playRoot,
        playsMidi: read.playsMidi,
        innerPostgain: read.innerPostgain,
        busHidden: read.busHidden,
      });
    } catch (err) {
      if (!(err instanceof MixerRewriteError)) throw err;
      reads.set(track.identity, { ok: false, reason: err.reason });
    }
  });
  return { tracks, reads };
}

// --- Writing ---

/**
 * The edit that adds `text` (a `.name(args)` call) at the end of the spine. The insertion point is the expression's end: before a trailing `;` and before
 * the comma of a stack() branch. A chain on one line gets the call inline. A chain written over
 * several lines gets a newline, the indentation of its last continuation line and the call; when
 * a `//` comment follows the last call on its line (and no `;` does), the call goes at the end
 * of that line so the comment stays attached to its own call.
 */
function insertCallEdit(code, expression, spine, text) {
  const texts = Array.isArray(text) ? text : [text];
  const indentation = chainIndentation(code, spine);
  if (indentation === null) {
    return { from: expression.end, to: expression.end, insert: texts.join('') };
  }
  const comment = /^[ \t]*\/\/[^\r\n]*/.exec(code.slice(expression.end));
  const at = comment ? expression.end + comment[0].length : expression.end;
  return { from: at, to: at, insert: `\n${indentation}${texts.join(`\n${indentation}`)}` };
}

/** The indentation of the last continuation line of a chain written over several lines, or null
 * for a chain on one line. */
function chainIndentation(code, spine) {
  let indentation = null;
  let previousEnd = spine.root.end;
  for (const call of spine.calls) {
    if (code.slice(previousEnd, call.dotStart).includes('\n')) {
      const lineStart = code.lastIndexOf('\n', call.dotStart) + 1;
      indentation = /^[ \t]*/.exec(code.slice(lineStart, call.dotStart))[0];
    }
    previousEnd = call.node.end;
  }
  return indentation;
}

/**
 * The edit that adds calls right after `call`, a call in the middle of the chain. Inline on a chain
 * written on one line, and when another call follows on the same line. On a chain written over
 * several lines, when `call` ends its line, the new calls get their own lines (after a trailing
 * `//` comment, so the comment stays with its own call), indented like the other calls.
 */
function insertAfterCallEdit(code, spine, call, texts) {
  const indentation = chainIndentation(code, spine);
  const newline = code.indexOf('\n', call.node.end);
  const lineEnd = newline === -1 ? code.length : newline;
  const rest = code.slice(call.node.end, lineEnd).replace(/\r$/, '');
  if (indentation !== null && /^[ \t]*(?:\/\/.*)?$/.test(rest)) {
    const at = call.node.end + rest.length;
    return { from: at, to: at, insert: `\n${indentation}${texts.join(`\n${indentation}`)}` };
  }
  return { from: call.node.end, to: call.node.end, insert: texts.join('') };
}

/** The edit that adds calls right before `call`: on its own lines when `call` starts its line
 * (so a neighbour's trailing comment stays with its call), else inline. */
function insertBeforeCallEdit(code, call, texts) {
  const lineStart = code.lastIndexOf('\n', call.dotStart - 1) + 1;
  const before = code.slice(lineStart, call.dotStart);
  if (/^[ \t]*$/.test(before)) {
    return { from: lineStart, to: lineStart, insert: texts.map((text) => `${before}${text}\n`).join('') };
  }
  return { from: call.dotStart, to: call.dotStart, insert: texts.join('') };
}

/**
 * The edit that adds the calls `texts` of effect `effectId` in Strudel's chain order: after the source-last call of a present effect that comes earlier in the
 * chain, else before the source-first call of a present effect that comes later, else at the end
 * of the spine. Later edits find the calls again by method name, never by position.
 */
function insertEffectEdit(code, entry, read, effectId, texts) {
  const order = CHAIN_ORDER.indexOf(effectId);
  let after = null;
  let before = null;
  for (const call of read.spine.calls) {
    const id = effectOfMethod(call.name);
    if (id === null) continue;
    const index = CHAIN_ORDER.indexOf(id);
    if (index < order && (after === null || call.node.end > after.node.end)) after = call;
    if (index > order && (before === null || call.dotStart < before.dotStart)) before = call;
  }
  const last = read.spine.calls[read.spine.calls.length - 1];
  if (after !== null && after !== last) return insertAfterCallEdit(code, read.spine, after, texts);
  if (after === null && before !== null) return insertBeforeCallEdit(code, before, texts);
  return insertCallEdit(code, entry.expression, read.spine, texts);
}

/** The call text an added effect writes: its primary call with its starting value (the compressor
 * writes its first two fields). Numbers go through formatNumber, strings through JSON.stringify of
 * a registry value, so nothing else is ever written. */
function startCallText(effect) {
  if (effect.id === 'compressor') {
    const [threshold, ratio] = effect.params;
    return `.compressor(${JSON.stringify(`${formatNumber(threshold.start)}:${formatNumber(ratio.start)}`)})`;
  }
  const first = effect.params[0];
  return first.kind === 'select' ? `.${first.method}(${JSON.stringify(first.start)})` : `.${first.method}(${formatNumber(first.start)})`;
}

/** The edits of taking an effect out of the code: every spine call of it, aliases and duplicates included. */
function removeEffectEdits(code, read, effectId) {
  const effect = read.effects.get(effectId);
  if (!effect) {
    throw new MixerRewriteError('unsupported-change', `the track does not have ${effectById(effectId).name.toLowerCase()}.`);
  }
  return effect.calls.map((call) => removeCallEdit(code, call));
}

/** The edits of a bypass: the calls go and the caller gets them back, canonical, to store. */
function bypassEffectEdits(code, read, effectId) {
  const edits = removeEffectEdits(code, read, effectId);
  const { stored } = read.effects.get(effectId);
  if (stored === null) throw new MixerRewriteError('unsupported-change', BYPASS_NEEDS_FIXED);
  return { edits, removed: stored };
}

/** The edits of turning a bypassed effect back on: the stored calls, each checked against the
 * registry again, written in canonical form in chain order. */
function restoreEffectEdits(code, entry, read, effectId, calls) {
  if (read.effects.has(effectId)) {
    throw new MixerRewriteError('unsupported-change', `the track already has ${effectById(effectId).name.toLowerCase()}.`);
  }
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 16) {
    throw new MixerRewriteError('unsupported-change', 'a restore needs the stored calls of the effect.');
  }
  const texts = calls.map((call) => {
    const normalized = normalizeStoredCall(effectId, call);
    if (normalized === null) throw new MixerRewriteError('unsupported-change', 'a stored call is not one the mixer can write.');
    return storedCallText(normalized);
  });
  return [insertEffectEdit(code, entry, read, effectId, texts)];
}

/** The edits of adding an effect: its primary call with its starting value, in chain order. */
function addEffectEdits(code, entry, read, effectId) {
  if (read.effects.has(effectId)) {
    throw new MixerRewriteError('unsupported-change', `the track already has ${effectById(effectId).name.toLowerCase()}.`);
  }
  return [insertEffectEdit(code, entry, read, effectId, [startCallText(effectById(effectId))])];
}

// --- Parameters ---

/** The parameter `id` of `effect`, or a refusal. */
function paramOf(effect, id) {
  const param = effect.params.find((candidate) => candidate.id === id);
  if (!param) throw new MixerRewriteError('unsupported-change', `${effect.name.toLowerCase()} has no parameter '${String(id)}'.`);
  return param;
}

/** The read of `effect` on this track, or a refusal when the track does not have it. */
function presentEffect(read, effect) {
  const found = read.effects.get(effect.id);
  if (!found) throw new MixerRewriteError('unsupported-change', `the track does not have ${effect.name.toLowerCase()}.`);
  return found;
}

/** The refusal for a parameter whose value the code moves (a pattern or a signal). */
function movingRefusal(param) {
  return new MixerRewriteError('unsupported-change', `the ${param.name.toLowerCase()} moves in the code; use a fixed value first.`);
}

/** The range a read is edited in: the Hz range for a `.tremolo()` speed, else the parameter's own. */
function rangeOf(param, paramRead) {
  return param.alt && paramRead.method === param.alt.method ? param.alt : param;
}

/**
 * The code text of a value written into `param`: a number is clamped and rounded by the registry and
 * written by formatNumber; a select value must be one of the parameter's own options and is written
 * by JSON.stringify. Nothing else is ever put into code.
 */
function valueText(param, range, value) {
  if (param.kind === 'select') {
    if (typeof value !== 'string' || !param.options.includes(value)) {
      throw new MixerRewriteError('unsupported-change', `'${String(value)}' is not one of the ${param.name.toLowerCase()} values.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MixerRewriteError('unsupported-change', `a ${param.name.toLowerCase()} must be a finite number.`);
  }
  return formatNumber(roundToParam(range, value));
}

/** The call of `calls` that ends last in the source. */
function lastCallOf(calls) {
  return calls.reduce((last, call) => (call.node.end > last.node.end ? call : last));
}

/** The edit that replaces the argument of `call`. */
function replaceArgEdit(call, text) {
  const arg = call.node.arguments[0];
  return { from: arg.start, to: arg.end, insert: text };
}

/** The text a compressor call holds for `values` (numbers): a plain number when it is one field and
 * the call was a plain number, else one string `"t:r:k:a:l"` cut after the last field. */
function compressorArgText(call, values) {
  const joined = values.map((value) => formatNumber(value)).join(':');
  const plain = values.length === 1 && numericLiteralValue(call.node.arguments[0]) !== null;
  return plain ? joined : JSON.stringify(joined);
}

/** The reads of the five compressor fields, or a refusal when any of them moves in the code. */
function compressorFieldReads(effect, eff) {
  const reads = effect.params.map((param) => eff.params[param.id]);
  if (reads.some((field) => field.kind === 'pattern')) throw movingRefusal(effect.params[0]);
  return reads;
}

/** The index of the last written compressor field, or -1. */
function lastWrittenField(reads) {
  let last = -1;
  reads.forEach((field, i) => {
    if (field.kind === 'fixed') last = i;
  });
  return last;
}

/** The edits that set compressor field `index` to `value`: the last compressor call is rewritten to
 * hold every field up to the last written or touched one, earlier unwritten fields filled with
 * Strudel's defaults. */
function compressorSetEdits(effect, eff, index, value) {
  const reads = compressorFieldReads(effect, eff);
  const param = effect.params[index];
  const next = roundToParam(param, value);
  if (reads[index].kind === 'fixed' && reads[index].value === next) return [];
  const end = Math.max(lastWrittenField(reads), index);
  const values = [];
  for (let j = 0; j <= end; j += 1) {
    if (j === index) values.push(next);
    else values.push(reads[j].kind === 'fixed' ? reads[j].value : effect.params[j].strudelDefault);
  }
  const call = eff.calls[eff.calls.length - 1];
  return [replaceArgEdit(call, compressorArgText(call, values))];
}

/** The edits that give compressor field `index` back its Strudel default: the string is cut after the
 * last field still written, or holds the default in that field when a later one is written. Several
 * compressor calls become one. */
function compressorDefaultEdits(code, effect, eff, index) {
  const reads = compressorFieldReads(effect, eff);
  if (reads[index].kind !== 'fixed') return [];
  const last = lastWrittenField(reads);
  const values = [];
  if (index === last) {
    for (let j = 0; j < index; j += 1) values.push(reads[j].value);
  } else {
    for (let j = 0; j <= last; j += 1) values.push(j === index ? effect.params[j].strudelDefault : reads[j].value);
  }
  // The fields fold over every compressor call, so a value an earlier call wrote would survive a
  // reset of the last call alone: the last call takes the whole result and the earlier ones go.
  const call = eff.calls[eff.calls.length - 1];
  return [...eff.calls.slice(0, -1).map((earlier) => removeCallEdit(code, earlier)), replaceArgEdit(call, compressorArgText(call, values))];
}

/** The edits that replace a moving compressor with `"-20:4"`: the last call takes the starting value
 * of its first two fields and every earlier compressor call goes. A compressor that is only partly
 * moving is refused rather than guessed at. */
function compressorFixedEdits(code, effect, eff) {
  const reads = effect.params.map((param) => eff.params[param.id]);
  if (!reads.every((field) => field.kind === 'pattern')) {
    throw new MixerRewriteError('unsupported-change', 'the compressor is not moving as a whole, so it cannot be replaced by one fixed value.');
  }
  const [threshold, ratio] = effect.params;
  const text = JSON.stringify(`${formatNumber(fixedValueOf(threshold))}:${formatNumber(fixedValueOf(ratio))}`);
  const call = eff.calls[eff.calls.length - 1];
  return [...eff.calls.slice(0, -1).map((earlier) => removeCallEdit(code, earlier)), replaceArgEdit(call, text)];
}

/**
 * `move` as the mixer writes it: a shape from MOVE_SHAPES, From and To finite numbers clamped to the
 * parameter's range, Over a whole number of cycles from MOVE_OVER_MIN to MOVE_OVER_MAX. Anything
 * else throws, so nothing but these ever reaches the code.
 */
function checkedMove(param, move) {
  const bad = (what) => new MixerRewriteError('unsupported-change', what);
  if (move === null || typeof move !== 'object') throw bad('a filter move needs a shape, From, To and Over.');
  if (typeof move.shape !== 'string' || !MOVE_SHAPES.includes(move.shape)) throw bad(`'${String(move.shape)}' is not a filter-move shape.`);
  for (const field of ['from', 'to']) {
    if (typeof move[field] !== 'number' || !Number.isFinite(move[field])) throw bad(`a filter move needs a finite number for ${field}.`);
  }
  if (!Number.isInteger(move.over) || move.over < MOVE_OVER_MIN || move.over > MOVE_OVER_MAX) {
    throw bad(`a filter move lasts a whole number of cycles from ${MOVE_OVER_MIN} to ${MOVE_OVER_MAX}.`);
  }
  return { shape: move.shape, from: clampToParam(param, move.from), to: clampToParam(param, move.to), over: move.over };
}

/** The edits of one 'filter-move' change: the cutoff's last writer takes the move in its argument
 * (a fixed value or an earlier move is replaced); an unwritten cutoff gets a call after the effect's
 * last call. A pattern the mixer does not understand is refused, never overwritten by a guess. */
function moveEdits(code, read, change) {
  const effect = effectById(change.effect);
  const param = paramOf(effect, change.param);
  const eff = presentEffect(read, effect);
  const paramRead = eff.params[param.id];
  const text = moveText(checkedMove(param, change.move));
  if (paramRead.kind === 'pattern') throw movingRefusal(param);
  if (paramRead.kind === 'unwritten') return [insertAfterCallEdit(code, read.spine, lastCallOf(eff.calls), [`.${param.method}(${text})`])];
  if (paramRead.kind === 'move' && text === code.slice(paramRead.call.node.arguments[0].start, paramRead.call.node.arguments[0].end)) return [];
  return [replaceArgEdit(paramRead.call, text)];
}

/** The edits of one 'param', 'param-default' or 'param-fixed' change on an effect the track has. Only
 * the parameter's own call is added, edited or removed; every other call stays byte for byte. */
function paramEdits(code, read, change) {
  const effect = effectById(change.effect);
  const param = paramOf(effect, change.param);
  const eff = presentEffect(read, effect);
  const index = effect.params.indexOf(param);
  const paramRead = eff.params[param.id];

  if (change.type === 'param-default') {
    if (index === 0) throw new MixerRewriteError('unsupported-change', `the ${param.name.toLowerCase()} is the ${effect.name.toLowerCase()}'s own value and has no Default.`);
    if (effect.id === 'compressor') return compressorDefaultEdits(code, effect, eff, index);
    if (paramRead.kind === 'unwritten') return [];
    if (paramRead.kind === 'pattern') throw movingRefusal(param);
    const own = eff.calls.filter((call) => {
      const { canonical } = methodOf(call.name);
      return canonical === param.method || (param.alt && canonical === param.alt.method);
    });
    return own.map((call) => removeCallEdit(code, call));
  }

  if (change.type === 'param-fixed') {
    if (effect.id === 'compressor') return compressorFixedEdits(code, effect, eff);
    if (paramRead.kind !== 'pattern' && paramRead.kind !== 'move') throw new MixerRewriteError('unsupported-change', `the ${param.name.toLowerCase()} does not move in the code.`);
    const canonical = methodOf(paramRead.call.name).canonical;
    const hz = param.alt !== undefined && canonical === param.alt.method;
    const text = valueText(param, hz ? param.alt : param, fixedValueOf(param, hz));
    // A packed string such as .lpf("1000:10") also writes the other keys of its pack, and a call
    // of another method writes this parameter through its own pack: replacing that argument would
    // drop values without saying so. The parameter's own call goes after the effect's last call
    // and overrides only this key.
    if ((canonical === param.method || hz) && !packedArgument(paramRead.call.node.arguments[0])) return [replaceArgEdit(paramRead.call, text)];
    return [insertAfterCallEdit(code, read.spine, lastCallOf(eff.calls), [`.${hz ? param.alt.method : param.method}(${text})`])];
  }

  // 'param'
  if (effect.id === 'compressor') {
    if (typeof change.value !== 'number' || !Number.isFinite(change.value)) throw new MixerRewriteError('unsupported-change', `a ${param.name.toLowerCase()} must be a finite number.`);
    return compressorSetEdits(effect, eff, index, change.value);
  }
  if (paramRead.kind === 'pattern') throw movingRefusal(param);
  const range = paramRead.kind === 'fixed' ? rangeOf(param, paramRead) : param;
  const text = valueText(param, range, change.value);
  // A filter move turns back into a fixed value: its whole expression is replaced.
  if (paramRead.kind === 'move') return [replaceArgEdit(paramRead.call, text)];
  if (paramRead.kind === 'fixed') {
    if (param.kind === 'number' ? roundToParam(range, change.value) === paramRead.value : change.value === paramRead.value) return [];
    return [replaceArgEdit(paramRead.call, text)];
  }
  return [insertAfterCallEdit(code, read.spine, lastCallOf(eff.calls), [`.${param.method}(${text})`])];
}

// --- Sends and bus parameters ---

/** The spine calls whose canonical method is one of `methods`. */
function callsOfMethods(spine, methods) {
  return spine.calls.filter((call) => {
    const meta = methodOf(call.name);
    return meta !== null && methods.includes(meta.canonical);
  });
}

/** The bus values a joining track is given: `busParams` is `{ paramId: number }`, checked by the caller. */
function busParamsObject(value, bus) {
  const bad = (what) => new MixerRewriteError('unsupported-change', what);
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad('the bus values of a send must be an object.');
  for (const [id, number] of Object.entries(value)) {
    if (busParamById(bus, id) === null) throw bad(`the ${BUSES[bus].name.toLowerCase()} has no parameter '${id}'.`);
    if (typeof number !== 'number' || !Number.isFinite(number)) throw bad(`the ${id} of the ${BUSES[bus].name.toLowerCase()} must be a finite number.`);
  }
  return value;
}

/** The call texts a track that starts sending takes from the bus: every value the bus holds that the
 * track does not write itself, in registry order, each rounded and written by the registry. */
function joinTexts(bus, facts, values) {
  const texts = [];
  for (const param of BUSES[bus].params) {
    if (!Object.hasOwn(values, param.id) || facts.busParams[bus][param.id].kind !== 'unwritten') continue;
    texts.push(`.${param.method}(${formatNumber(roundToParam(param, values[param.id]))})`);
  }
  return texts;
}

/**
 * The edits of one 'send' change. Above 0 the send is written (its argument replaced, or `.room(v)` /
 * `.delay(v)` added at the end of the spine) and a track that starts sending takes the bus's current
 * values right after it. Exactly 0 removes the send and that bus's parameter calls from this track.
 * A send that moves in the code is refused, never overwritten.
 */
function sendEdits(code, entry, read, change) {
  const send = SENDS[change.bus];
  const bus = BUSES[change.bus];
  const sendRead = read.bus.sends[change.bus];
  if (sendRead.kind === 'pattern') {
    throw new MixerRewriteError('unsupported-change', `the ${send.name.toLowerCase()} send moves in the code; ask Claude to change it.`);
  }
  const value = roundToParam(send, change.value);
  const values = busParamsObject(change.busParams, change.bus);
  const sendCalls = callsOfMethods(read.spine, [send.method]);
  if (value === 0) {
    if (sendCalls.length === 0) return [];
    const paramCalls = callsOfMethods(read.spine, bus.params.map((param) => param.method));
    return [...sendCalls, ...paramCalls].map((call) => removeCallEdit(code, call));
  }
  const text = formatNumber(value);
  const joining = joinTexts(change.bus, read.bus, values);
  if (sendRead.kind === 'fixed') {
    const edits = [];
    if (sendRead.value !== value) edits.push(replaceArgEdit(sendRead.call, text));
    // A send written as 0 that starts sending takes the bus values like a new sender.
    if (sendRead.value <= 0 && joining.length > 0) edits.push(insertAfterCallEdit(code, read.spine, sendRead.call, joining));
    return edits;
  }
  return [insertCallEdit(code, entry.expression, read.spine, [`.${send.method}(${text})`, ...joining])];
}

/** The edits that give one sending track `sets` (`[[param, number | null]]`, null removes the parameter):
 * a written value is replaced in place, an unwritten one is added directly after the send or after the
 * last bus parameter the track keeps. A parameter this track writes as a pattern is refused. */
function busTrackEdits(code, sender, bus, sets) {
  const { read } = sender;
  const paramReads = read.bus.busParams[bus.id];
  const edits = [];
  const inserts = [];
  const removed = new Set();
  for (const [param, value] of sets) {
    const paramRead = paramReads[param.id];
    if (paramRead.kind === 'pattern') {
      throw new MixerRewriteError('unsupported-change', `a track writes the ${param.name.toLowerCase()} of the ${bus.name.toLowerCase()} as a pattern; the mixer cannot set it on every track.`);
    }
    if (value === null) {
      for (const call of callsOfMethods(read.spine, [param.method])) {
        edits.push(removeCallEdit(code, call));
        removed.add(call);
      }
      continue;
    }
    const next = roundToParam(param, value);
    if (paramRead.kind === 'fixed') {
      if (paramRead.value !== next) edits.push(replaceArgEdit(paramRead.call, formatNumber(next)));
    } else {
      inserts.push(`.${param.method}(${formatNumber(next)})`);
    }
  }
  if (inserts.length > 0) {
    const keep = [read.bus.sends[bus.id].call, ...callsOfMethods(read.spine, bus.params.map((param) => param.method)).filter((call) => !removed.has(call))];
    edits.push(insertAfterCallEdit(code, read.spine, lastCallOf(keep), inserts));
  }
  return edits;
}

/**
 * Writes one bus parameter on EVERY track that sends to the bus, in one edit list (Strudel gives
 * unpredictable results when two tracks on one orbit set different values). `change` is `{ type:
 * 'bus-param', orbit, bus, param, value, align }`: `orbit` the number the bus is on (read from the
 * code, never written), `align` an optional `{ paramId: number | null }` that sets other parameters
 * of the bus on every sender in the same change (null removes them). A track the mixer cannot read
 * never counts as a sender, nor does one that sets its own orbit or bus values off its own chain (its bus is not
 * visible from its chain). Asking for what the code already holds returns the identical code and no
 * edits. Throws MixerRewriteError.
 */
export function writeBus(code, change, { parse }) {
  const bad = (what) => new MixerRewriteError('unsupported-change', what);
  if (change === null || typeof change !== 'object' || change.type !== 'bus-param') throw bad('a bus change needs type: bus-param.');
  if (!Object.hasOwn(BUSES, change.bus)) throw bad(`unknown bus '${String(change.bus)}'.`);
  const bus = BUSES[change.bus];
  const param = busParamById(change.bus, change.param);
  if (param === null) throw bad(`the ${bus.name.toLowerCase()} has no parameter '${String(change.param)}'.`);
  if (typeof change.value !== 'number' || !Number.isFinite(change.value)) throw bad(`a ${param.name.toLowerCase()} must be a finite number.`);
  if (typeof change.orbit !== 'number' || !Number.isFinite(change.orbit)) throw bad('a bus change needs the orbit it is on.');
  const sets = [[param, change.value]];
  if (change.align !== undefined) {
    if (change.align === null || typeof change.align !== 'object' || Array.isArray(change.align)) throw bad('align must be an object.');
    for (const [id, value] of Object.entries(change.align)) {
      const other = busParamById(change.bus, id);
      if (other === null) throw bad(`the ${bus.name.toLowerCase()} has no parameter '${id}'.`);
      if (id === param.id) continue;
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw bad(`the ${id} of the ${bus.name.toLowerCase()} must be a finite number or null.`);
      sets.push([other, value]);
    }
  }
  const ast = parse(code, PARSE_OPTIONS);
  const tracks = extractTracks(code, { parse });
  const nodes = trackNodes(ast);
  const scope = readScope(ast);
  const senders = [];
  tracks.forEach((track, i) => {
    let read;
    try {
      read = inspectTrack(code, nodes[i], scope);
    } catch (err) {
      if (err instanceof MixerRewriteError) return;
      throw err;
    }
    // A track that sets its own orbit or bus values off its own chain is not read as a sender: its bus is not the one its chain shows. A track that plays MIDI is no sender either: its sound never goes through a bus.
    if (!read.busHidden && !read.playsMidi && feedsBus(read.bus, bus.id, change.orbit)) senders.push({ entry: nodes[i], read });
  });
  if (senders.length === 0) throw bad(`no track sends to the ${bus.name.toLowerCase()} on orbit ${formatNumber(change.orbit)}.`);
  const edits = senders.flatMap((sender) => busTrackEdits(code, sender, bus, sets));
  return { code: applyEdits(code, edits), edits };
}

/** Writes a fixed volume on `name` ('gain' or 'postgain'): edits the last fixed writer in place,
 * or adds a call at the end of the spine. An unchanged value yields no edit at all: that includes the neutral
 * post-gain on a track that writes none (1 plays the code as written, so a `.postgain(1)` would change nothing). */
function writeVolume(code, entry, read, name, control, text, value) {
  if (control.kind === 'fixed') {
    if (control.value === value) return [];
    const arg = control.call.node.arguments[0];
    return [{ from: arg.start, to: arg.end, insert: text }];
  }
  if (name === 'postgain' && value === DEFAULT_POSTGAIN) return [];
  return [insertCallEdit(code, entry.expression, read.spine, `.${name}(${text})`)];
}

/**
 * The edit that removes one spine call (`.hush()`). A call alone on its line (only whitespace before
 * its dot, and only whitespace or a `//` comment after it) goes with its whole line, its trailing
 * comment and its newline; any other call goes from its dot to its end, so a neighbour's trailing
 * comment stays.
 */
function removeCallEdit(code, call) {
  const lineStart = code.lastIndexOf('\n', call.dotStart - 1) + 1;
  const alone = /^[ \t]*$/.test(code.slice(lineStart, call.dotStart));
  const rest = /^[ \t]*(?:\/\/[^\r\n]*)?(\r?\n|$)/.exec(code.slice(call.node.end));
  if (!alone || !rest) return { from: call.dotStart, to: call.node.end, insert: '' };
  if (rest[1] === '' && lineStart > 0) {
    // The last line of the program: take the line break before it instead of leaving a blank line.
    const from = code[lineStart - 2] === '\r' ? lineStart - 2 : lineStart - 1;
    return { from, to: call.node.end + rest[0].length, insert: '' };
  }
  return { from: lineStart, to: call.node.end + rest[0].length, insert: '' };
}

/**
 * The edits of one mute or solo press on a track. A labeled
 * track changes its label (labelEdit); a `.hush()` on its spine is one more way to be muted, so
 * unmuting and soloing remove every one and muting a hushed track changes nothing. A track without
 * a label mutes by adding `.hush()` at the end of its chain and unmutes by removing every one; it
 * cannot be soloed (unsupported-change).
 */
function muteSoloEdits(code, entry, read, change, ast) {
  const hushes = read.spine.calls.filter((call) => call.name === 'hush');
  const removeHushes = () => hushes.map((call) => removeCallEdit(code, call));
  if (!entry.labelNode) {
    if (change.type === 'solo') {
      throw new MixerRewriteError('unsupported-change', 'a track without a label cannot be soloed.');
    }
    if (change.on) return hushes.length > 0 ? [] : [insertCallEdit(code, entry.expression, read.spine, '.hush()')];
    return removeHushes();
  }
  if (change.type === 'mute' && change.on && hushes.length > 0) return [];
  const edits = [];
  const label = labelEdit(entry, change, ast);
  if (label) edits.push(label);
  // Unmuting and soloing drop the hush; muting and un-soloing leave it alone.
  if (change.on !== (change.type === 'solo')) return edits;
  return [...edits, ...removeHushes()];
}

/**
 * The edit that rewrites a labeled track's label for a mute or solo press, or null when the label already has the asked state. One edit replaces the
 * label identifier and nothing else. Mute and solo exclude each other on one label, so Strudel is
 * never given `_S_name`. Throws 'unsupported-shape' for a label the mixer cannot read and
 * 'unsupported-change' for a change the label cannot take (a name that starts with S plays alone
 * by itself; the mixer never renames it).
 */
function labelEdit(entry, change, ast) {
  const raw = entry.labelNode.name;
  const label = parseLabel(raw);
  if (!label.safe) throw new MixerRewriteError('unsupported-shape');
  let next;
  if (change.type === 'mute') {
    if (change.on) {
      next = label.mutedByLabel ? raw : `_${label.solo === 'marker' ? label.base : label.core}`;
    } else {
      next = label.core;
    }
  } else if (label.solo === 'name') {
    throw new MixerRewriteError('unsupported-change', 'a name that starts with a capital S plays alone by itself; the mixer does not rename it.');
  } else if (change.on) {
    next = label.solo === 'marker' && !label.soloInert ? raw : `${SOLO_MARKER}${label.base}`;
  } else if (label.solo === 'marker' && !label.soloInert) {
    if (label.base.length > 1 && label.base.startsWith('S')) {
      throw new MixerRewriteError('unsupported-change', 'the name under the solo marker starts with a capital S, so it would still play alone.');
    }
    next = label.base;
  } else {
    next = raw;
  }
  if (next === raw) return null;
  refuseSharedLabel(entry, raw, next, ast);
  return { from: entry.labelNode.start, to: entry.labelNode.end, insert: next };
}

/** The change types a track that plays MIDI refuses: each writes a browser effect, a send or a bus value. */
const PLAYS_MIDI_REFUSED = new Set(['add-effect', 'bypass-effect', 'restore-effect', 'remove-effect', 'param', 'param-default', 'param-fixed', 'filter-move', 'send']);

/**
 * Strudel keeps only the last statement of a repeated plain label (a label with `$` never repeats).
 * A label edit on a track that shares its label with a shadowed statement would bring that
 * statement back to life or make it the survivor, and a label edit that lands on a label another
 * statement already holds would merge two tracks. Both are refused, so a press never changes
 * which statements play.
 */
function refuseSharedLabel(entry, raw, next, ast) {
  const others = ast.body.filter((node) => node.type === 'LabeledStatement' && node.body && node.body.type === 'ExpressionStatement' && node !== entry.statement);
  if (!raw.includes('$') && others.some((node) => node.label.name === raw)) {
    throw new MixerRewriteError('unsupported-change', 'another statement in the code uses the same label, so a mute or solo would change which one plays.');
  }
  if (!next.includes('$') && others.some((node) => node.label.name === next)) {
    throw new MixerRewriteError('unsupported-change', 'another track already uses the label this change would write.');
  }
}

/**
 * Writes one control change on the track `identity` of `code` and returns `{ code, edits }`,
 * `edits` in the original coordinates (the same list drives the editor change and the highlight).
 * `change` is `{ identity, type: 'gain', value }`, `{ identity, type: 'mute', on }`,
 * `{ identity, type: 'solo', on }`, `{ identity, type: 'add-effect', effect }`, `{ identity, type:
 * 'bypass-effect', effect }` (the result also carries `removed`, the calls to store), `{ identity,
 * type: 'restore-effect', effect, calls }` (the stored calls, checked again) or `{ identity, type:
 * 'remove-effect', effect }`, `{ identity, type: 'param', effect, param, value }` (one parameter, the
 * value clamped and rounded by the registry; a select takes a listed string), `{ identity, type:
 * 'param-default', effect, param }` (removes a written extra parameter again) or `{ identity, type:
 * 'param-fixed', effect, param }` (replaces a moving parameter by its starting value) or `{ identity,
 * type: 'filter-move', effect, param, move: { shape, from, to, over } }` (the cutoff of a filter becomes
 * `<shape>.range(from, to).slow(over)`; shape from MOVE_SHAPES, Over a whole number of cycles) or `{ identity,
 * type: 'send', bus: 'reverb' | 'delay', value, busParams }` (the track's send, 0 to 1: above 0 writes `.room(v)` /
 * `.delay(v)` and, for a track that starts sending, the bus values in `busParams` directly after it; exactly
 * 0 removes the send and that bus's parameter calls; see sendEdits). A volume is written to two decimals into the last `.gain(n)`
 * when that is a plain number; otherwise into `.postgain(n)` (edited in place when a plain one is
 * there, added at the end of the chain when there is none), so the gains inside the track keep their
 * differences; it is refused when the post-gain moves, or when the track plays MIDI (which ignores a post-gain; such a track also refuses every effect, send and bus change), or when a post-gain is set inside the track or its shared code (a fader's would replace it). A mute or solo rewrites the track's label (see labelEdit). Adding an effect writes only
 * its primary call with its starting value, in Strudel's chain order (see insertEffectEdit). Asking for the state the code
 * already holds returns the identical code and no edits. Throws MixerRewriteError.
 */
export function writeTrack(code, identity, change, { parse }) {
  const type = change ? change.type : undefined;
  if (type === 'gain') {
    if (typeof change.value !== 'number' || !Number.isFinite(change.value) || change.value < 0) {
      throw new MixerRewriteError('unsupported-change', 'a volume must be a finite number of at least 0.');
    }
  } else if (type === 'mute' || type === 'solo') {
    if (typeof change.on !== 'boolean') {
      throw new MixerRewriteError('unsupported-change', `a ${type} change needs on: true or false.`);
    }
  } else if (type === 'add-effect' || type === 'bypass-effect' || type === 'restore-effect' || type === 'remove-effect') {
    if (!EFFECT_IDS.has(change.effect)) {
      throw new MixerRewriteError('unsupported-change', `unknown effect '${String(change.effect)}'.`);
    }
  } else if (type === 'param' || type === 'param-default' || type === 'param-fixed') {
    if (!EFFECT_IDS.has(change.effect)) {
      throw new MixerRewriteError('unsupported-change', `unknown effect '${String(change.effect)}'.`);
    }
    paramOf(effectById(change.effect), change.param);
  } else if (type === 'send') {
    if (!Object.hasOwn(SENDS, change.bus)) throw new MixerRewriteError('unsupported-change', `unknown send '${String(change.bus)}'.`);
    if (typeof change.value !== 'number' || !Number.isFinite(change.value) || change.value < 0 || change.value > 1) {
      throw new MixerRewriteError('unsupported-change', 'a send must be a finite number from 0 to 1.');
    }
    busParamsObject(change.busParams, change.bus);
  } else if (type === 'filter-move') {
    if (!EFFECT_IDS.has(change.effect)) {
      throw new MixerRewriteError('unsupported-change', `unknown effect '${String(change.effect)}'.`);
    }
    const param = paramOf(effectById(change.effect), change.param);
    if (!param.movable) throw new MixerRewriteError('unsupported-change', `the ${param.name.toLowerCase()} cannot move.`);
    checkedMove(param, change.move);
  } else {
    throw new MixerRewriteError('unsupported-change', `unknown mixer change '${String(type)}'.`);
  }
  const ast = parse(code, PARSE_OPTIONS);
  const tracks = extractTracks(code, { parse });
  const index = tracks.findIndex((track) => track.identity === identity);
  if (index === -1) throw new MixerRewriteError('track-gone');
  const entry = trackNodes(ast)[index];
  const read = inspectTrack(code, entry, readScope(ast));

  if (read.playsMidi && PLAYS_MIDI_REFUSED.has(type)) {
    // MIDI output never plays the browser's effects, reverb or delay, so the write would move a control while the sound cannot change.
    throw new MixerRewriteError('unsupported-change', 'This track plays MIDI, which has no effects, reverb or delay here; the mixer has nothing to write for it.');
  }
  if (type === 'add-effect') {
    const edits = addEffectEdits(code, entry, read, change.effect);
    return { code: applyEdits(code, edits), edits };
  }
  if (type === 'bypass-effect') {
    const { edits, removed } = bypassEffectEdits(code, read, change.effect);
    return { code: applyEdits(code, edits), edits, removed };
  }
  if (type === 'restore-effect') {
    const edits = restoreEffectEdits(code, entry, read, change.effect, change.calls);
    return { code: applyEdits(code, edits), edits };
  }
  if (type === 'remove-effect') {
    const edits = removeEffectEdits(code, read, change.effect);
    return { code: applyEdits(code, edits), edits };
  }
  if (type === 'param' || type === 'param-default' || type === 'param-fixed') {
    const edits = paramEdits(code, read, change);
    return { code: applyEdits(code, edits), edits };
  }
  if (type === 'filter-move') {
    const edits = moveEdits(code, read, change);
    return { code: applyEdits(code, edits), edits };
  }
  if (type === 'send') {
    if (read.busHidden) {
      throw new MixerRewriteError('unsupported-change', 'This track sets its own orbit or bus values somewhere the mixer does not read (inside another call or in shared code), so it cannot tell which bus a send would feed.');
    }
    const edits = sendEdits(code, entry, read, change);
    return { code: applyEdits(code, edits), edits };
  }
  if (type !== 'gain') {
    const edits = muteSoloEdits(code, entry, read, change, ast);
    return { code: applyEdits(code, edits), edits };
  }

  const value = roundTo(change.value, 2);
  const text = formatNumber(value);
  let edits;
  if (read.gain.kind === 'fixed') {
    // One plain gain already covers every event, so editing it loses nothing and converts nothing.
    edits = writeVolume(code, entry, read, 'gain', read.gain, text, value);
  } else {
    // A later .gain(n) would replace every gain set inside the track, so the fader
    // multiplies with .postgain(n) instead and the loud-to-quiet ratio of the notes stays.
    if (read.playsMidi) {
      // MIDI output reads gain and velocity but never the post-gain, so the write would change nothing audible.
      throw new MixerRewriteError('unsupported-change', 'This track plays MIDI, which ignores a post-gain; the mixer has no level to write for it.');
    }
    if (read.innerPostgain) {
      // A later .postgain(n) replaces every post-gain set inside the track or its shared code, as a later .gain(n) replaces gains.
      throw new MixerRewriteError('unsupported-change', 'The post-gain is set inside the track, so a fader would flatten it.');
    }
    if (read.postgain.kind === 'pattern') {
      throw new MixerRewriteError(
        'unsupported-change',
        read.gain.kind === 'pattern' ? 'Gain and post-gain both move in the code.' : 'The post-gain moves in the code.',
      );
    }
    edits = writeVolume(code, entry, read, 'postgain', read.postgain, text, value);
  }
  return { code: applyEdits(code, edits), edits };
}

/**
 * Writes one mute or solo change on many tracks at once and returns `{ code, edits }`, like writeTrack. `change` is
 * `{ type: 'mute' | 'solo', on }` and `identities` the tracks to write, each read and written against the SAME base
 * text. All their edits are joined into one list and applied once, by position, so the result is the same whatever
 * order the tracks are listed in, no track is written twice (a repeated identity counts once) and two edits that
 * overlap throw. The first track that cannot be written throws its MixerRewriteError and nothing is returned, so a
 * refused track never leaves the others half written. A track already in the asked state adds no edit.
 */
export function writeTracks(code, identities, change, { parse }) {
  if (!Array.isArray(identities) || identities.length === 0 || identities.some((identity) => typeof identity !== 'string')) {
    throw new MixerRewriteError('unsupported-change', 'a group change needs at least one track.');
  }
  const type = change ? change.type : undefined;
  if (type !== 'mute' && type !== 'solo') {
    throw new MixerRewriteError('unsupported-change', `a group can only be muted or soloed, not '${String(type)}'.`);
  }
  const edits = [];
  for (const identity of new Set(identities)) {
    edits.push(...writeTrack(code, identity, { identity, type, on: change.on }, { parse }).edits);
  }
  return { code: applyEdits(code, edits), edits };
}
