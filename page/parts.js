// Pure module for Moontide's browser page: finds the arrange() sections in the code that
// actually played, their live states (playing/queued/idle), the next-cycle launch target and
// offset, and the .late()/.early() rewrite that shifts an arrangement to start a chosen part at
// the next cycle. `parse` (acorn) is injected — Node resolves the `acorn` package directly, the
// browser reads the pinned `window.acorn` global — so this module has no DOM access at import
// time and can be imported directly by node:test and by page/main.js without a build step.

export const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true };

/** Page-visible copy for the Parts view. */
export const PARTS_COPY = {
  none: 'This code has no parts yet — parts come from arrange() in the code.',
  cannotRead: "Parts couldn't read this code.",
  // An arrange() call the view cannot read, and why. `{call}`, `{count}`, `{reason}`,
  // `{section}` and `{source}` are filled by fillParts().
  cannotReadOne: "Parts can't read this arrange(): {reason}.",
  cannotReadOf: "Parts can't read arrange() {call} of {count}: {reason}.",
  skippedOf: 'Skipped arrange() {call} of {count}: {reason}.',
  // A change waits for its bar or phrase line: a part launch is refused until it takes over.
  waiting: 'A change is waiting for its bar line. Parts can be launched again when it takes over.',
  shapeRule: 'Lengths must be plain numbers: whole numbers above zero, written in the call, or computed from number literals and top-level consts with + - * /.',
  reasons: {
    'no-sections': 'it has no [length, pattern] sections',
    'not-a-pair': 'section {section} is not a [length, pattern] pair',
    'no-pattern': 'section {section} has no pattern',
    'length-not-plain-number': 'the length of section {section} is not a plain number ({source})',
    'length-not-whole': 'the length of section {section} is not a whole number ({source})',
    'length-not-above-zero': 'the length of section {section} is not above zero ({source})',
    'length-name-unknown': 'the length of section {section} is {source}, which is not a top-level const',
    'length-name-mutable': 'the length of section {section} is {source}, declared with let or var, so it can change',
    'length-name-rebound': 'the length of section {section} is {source}, which is bound more than once in the code',
    'length-const-not-number': 'the length of section {section} is {source}, a top-level const that is not a number the page can compute',
    'length-const-order': 'the length of section {section} is {source}, a top-level const defined later in the code or referring to itself',
    'length-const-chain': 'the length of section {section} is {source}, a top-level const that depends on a const defined later in the code or on itself',
    'length-calls': 'the length of section {section} calls a function or reads a property ({source})',
    'spread-not-const-list': 'section {section} spreads {source}, which is not a top-level const holding [length, pattern] pairs',
    'pair-name-not-pair': 'section {section} is {source}, which is not a [length, pattern] pair or a top-level const holding one',
    'list-name-changed': 'section {section} uses {source}, a top-level const that the code changes, so what plays can differ from what is written',
    'list-name-order': 'section {section} uses {source}, a top-level const defined later in the code or referring to itself',
  },
};

/** The longest source quote a problem carries, in code points. */
const MAX_PROBLEM_SOURCE_LENGTH = 40;

/** Replaces each `{name}` in `template` with `values[name]`; a missing value throws (loud). */
function fillParts(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (values[name] === undefined || values[name] === null) {
      throw new Error(`Moontide: the Parts copy needs a value for '${name}'.`);
    }
    return String(values[name]);
  });
}

/** Mirrors src/protocol.ts's MAX_PART_NAME_LENGTH by hand (test/parts.test.js checks both are 100). */
export const MAX_PART_NAME_LENGTH = 100;

/** Below this many seconds of lead time before the next cycle boundary, a launch
 * targets the boundary after it instead — the scheduler has already queued roughly the next
 * cycle tick with the old pattern, so a switch this close could miss the chosen part's first
 * beat. */
export const LAUNCH_MIN_LEAD_SECONDS = 0.5;

/** Walks `node` and every descendant, calling `visit(node, parent, ancestors)` for each, where
 * `ancestors` is the parent chain from immediate parent (index 0) up to the root. Mirrors
 * page/tracks.js's own walk() (kept independent per module, same shape). */
function walk(node, parent, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent, ancestors) === false) return;
  const nextAncestors = [node, ...ancestors];
  for (const key in node) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, node, nextAncestors, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, node, nextAncestors, visit);
    }
  }
}

/** The numeric value of a Literal, or of a negated Literal (UnaryExpression `-N`) — the shape
 * `.late()`/`.early()`'s own argument can take when this module writes it back (applyArrangeOffset
 * never emits a negative literal directly, but a hand-written `.early(-2)` should still parse).
 * `null` for anything else. */
function numericLiteralValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
    return -node.argument.value;
  }
  return null;
}

/** The positive modulo of `a` by `b` (JS `%` can return a negative result). */
function positiveModulo(a, b) {
  return ((a % b) + b) % b;
}

/** The index of the track whose own source range contains `callNode`; else, when `callNode`
 * initializes a top-level `const`/`let`, the index of the first track (in the given array's own
 * order) whose own source text references that identifier as a whole word; else `null`. */
function findOwner(callNode, ancestors, code, tracks) {
  for (const track of tracks) {
    if (callNode.start >= track.start && callNode.end <= track.end) return track.index;
  }
  const declarator = ancestors[0];
  const declaration = ancestors[1];
  const program = ancestors[2];
  if (
    declarator &&
    declarator.type === 'VariableDeclarator' &&
    declarator.init === callNode &&
    declaration &&
    declaration.type === 'VariableDeclaration' &&
    program &&
    program.type === 'Program' &&
    declarator.id.type === 'Identifier'
  ) {
    const name = declarator.id.name;
    const reference = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (const track of tracks) {
      if (reference.test(code.slice(track.start, track.end))) return track.index;
    }
  }
  return null;
}

/** Mirrored in page/harmony.js (a copy on purpose: the modules stay independent); keep the two in step. Pushes every name `pattern` binds (an Identifier, or an object/array/rest/default pattern of
 * them) onto `names`. */
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

/** How many times each name is bound anywhere in the program: declarators, function and class
 * names, parameters and catch parameters. No scope analysis, so a name that is bound more than
 * once (a same-named parameter or inner declaration) can never count as a constant. */
function countBindings(ast) {
  const names = [];
  walk(ast, null, [], (node) => {
    if (node.type === 'VariableDeclarator') collectPatternNames(node.id, names);
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      if (node.id) collectPatternNames(node.id, names);
      for (const param of node.params) collectPatternNames(param, names);
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.id) collectPatternNames(node.id, names);
    } else if (node.type === 'CatchClause') collectPatternNames(node.param, names);
    return true;
  });
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return counts;
}

/** The deepest a length expression may nest before the page gives up on it (a guard against a
 * pathological left-nested chain; real lengths are a few levels deep). */
const MAX_LENGTH_DEPTH = 64;

/** The array methods that change the array they are called on. */
const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

/** The name at the root of a member chain (`list` in `list[0][1]`, in `list`, in `list.push`), else null. */
function memberRootName(node) {
  let current = node;
  while (current && current.type === 'MemberExpression') current = current.object;
  return current && current.type === 'Identifier' ? current.name : null;
}

/** The names the program changes through a member: `list.push(x)`, `list[0] = x`, `list.length = 0`,
 * `list[0]++`, `delete list[0]`. A const array holding sections can be one of them, and then what is
 * written is not what plays. No scope analysis, so the same name anywhere counts. */
function collectChangedNames(ast) {
  const changed = new Set();
  const note = (node) => {
    const name = memberRootName(node);
    if (name !== null) changed.add(name);
  };
  walk(ast, null, [], (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const { property, computed, object } = node.callee;
      if (!computed && ARRAY_MUTATORS.has(property.name)) note(object);
    } else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') note(node.left);
    else if (node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression') note(node.argument);
    else if (node.type === 'UnaryExpression' && node.operator === 'delete' && node.argument.type === 'MemberExpression') note(node.argument);
    return true;
  });
  return changed;
}

const CALL_LIKE_TYPES = new Set(['CallExpression', 'NewExpression', 'MemberExpression', 'ChainExpression', 'TaggedTemplateExpression']);

function lengthFailure(reason, node) {
  return { ok: false, reason, node };
}

/**
 * Reads the top-level bindings of the program, in source order, for the length evaluator:
 * `numbers` (const name -> computed number), `failures` (const name -> 'order' | 'not-number'),
 * `mutable` (let/var names), `declared` (every top-level const name, also those not resolved
 * yet), `ends` (const name -> end of its declaration), `changed` (names the code changes through
 * a member, see collectChangedNames), `arrays` (const name -> array literal) and `pairs` (the
 * arrays holding exactly two present elements). A name the whole program binds more than once is never a constant (`counts`).
 */
function buildScope(ast) {
  const scope = {
    counts: countBindings(ast),
    numbers: new Map(),
    failures: new Map(),
    mutable: new Set(),
    declared: new Set(),
    arrays: new Map(),
    pairs: new Map(),
    // const name -> where its declaration ends; a use before that point reads it too early
    ends: new Map(),
    changed: collectChangedNames(ast),
  };
  const constDeclarators = [];
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      const names = [];
      collectPatternNames(declarator.id, names);
      if (statement.kind === 'const') {
        for (const name of names) {
          scope.declared.add(name);
          scope.ends.set(name, declarator.end);
        }
        constDeclarators.push(declarator);
      } else {
        for (const name of names) scope.mutable.add(name);
      }
    }
  }
  for (const declarator of constDeclarators) {
    if (declarator.id.type !== 'Identifier') {
      const names = [];
      collectPatternNames(declarator.id, names);
      for (const name of names) scope.failures.set(name, 'not-number');
      continue;
    }
    const name = declarator.id.name;
    if (declarator.init && declarator.init.type === 'ArrayExpression' && scope.counts.get(name) === 1) {
      scope.arrays.set(name, declarator.init);
      const elements = declarator.init.elements;
      if (elements.length === 2 && elements[0] && elements[1]) scope.pairs.set(name, declarator.init);
    }
    const result = declarator.init ? evaluateLength(declarator.init, scope, declarator.init, 0) : lengthFailure('length-const-not-number', declarator);
    if (result.ok) scope.numbers.set(name, result.value);
    else scope.failures.set(name, result.reason === 'length-const-order' || result.reason === 'length-const-chain' ? 'order' : 'not-number');
  }
  return scope;
}

/**
 * Computes a section length written as constant arithmetic: number literals, top-level const
 * names, unary minus and plus, `+ - * /` and parentheses. Returns `{ ok: true, value }`, or
 * `{ ok: false, reason, node }` where `reason` is a Parts reason id and `node` is the code to
 * quote (the failing name for the name reasons, `root` — the whole length — for the others).
 * Nothing is evaluated as code and no regular expression is built from it.
 */
function evaluateLength(node, scope, root, depth) {
  if (depth > MAX_LENGTH_DEPTH) return lengthFailure('length-not-plain-number', root);
  if (node.type === 'Literal') {
    return typeof node.value === 'number' ? { ok: true, value: node.value } : lengthFailure('length-not-plain-number', root);
  }
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const inner = evaluateLength(node.argument, scope, root, depth + 1);
    if (!inner.ok) return inner;
    return { ok: true, value: node.operator === '-' ? -inner.value : inner.value };
  }
  if (node.type === 'BinaryExpression' && (node.operator === '+' || node.operator === '-' || node.operator === '*' || node.operator === '/')) {
    const left = evaluateLength(node.left, scope, root, depth + 1);
    if (!left.ok) return left;
    const right = evaluateLength(node.right, scope, root, depth + 1);
    if (!right.ok) return right;
    const value =
      node.operator === '+' ? left.value + right.value : node.operator === '-' ? left.value - right.value : node.operator === '*' ? left.value * right.value : left.value / right.value;
    return { ok: true, value };
  }
  if (node.type === 'Identifier') {
    const name = node.name;
    if (scope.counts.get(name) > 1) return lengthFailure('length-name-rebound', node);
    if (scope.mutable.has(name)) return lengthFailure('length-name-mutable', node);
    if (scope.numbers.has(name)) {
      // Read before its declaration is over (a pair const or a call written above the const): a ReferenceError at run time.
      if (scope.ends.get(name) > node.start) return lengthFailure('length-const-order', node);
      return { ok: true, value: scope.numbers.get(name) };
    }
    if (scope.failures.has(name)) {
      // 'order' means this const failed because of another const read too early: say it depends on one.
      return lengthFailure(scope.failures.get(name) === 'order' ? 'length-const-chain' : 'length-const-not-number', node);
    }
    // A top-level const that is not stored yet is declared later in the code, or is the const being read.
    if (scope.declared.has(name)) return lengthFailure('length-const-order', node);
    return lengthFailure('length-name-unknown', node);
  }
  if (CALL_LIKE_TYPES.has(node.type)) return lengthFailure('length-calls', root);
  return lengthFailure('length-not-plain-number', root);
}

/** Mirrored in page/harmony.js (see collectPatternNames). `code.slice(node.start, node.end)` cut to MAX_PROBLEM_SOURCE_LENGTH code points, with '…' as
 * the last one when cut. */
function sourceOf(code, node) {
  const points = [...code.slice(node.start, node.end)];
  if (points.length <= MAX_PROBLEM_SOURCE_LENGTH) return points.join('');
  return `${points.slice(0, MAX_PROBLEM_SOURCE_LENGTH - 1).join('')}…`;
}

/**
 * The ordered entries one argument of arrange() stands for: `{ pair }` for each array literal
 * (the plain argument, the name of a top-level const holding a pair, or the elements of a
 * spread of a top-level const list) and one `{ reason, source }` for an argument that cannot be
 * read. A spread is read whole: if any element is not an array literal or a pair const, the
 * spread is one problem, quoted as written. A list holds pairs or pair names, never lists, so
 * nothing is expanded twice.
 */
function argumentEntries(arg, scope, code) {
  if (arg.type === 'ArrayExpression') return [{ pair: arg }];
  // Why the const `use` names cannot be trusted as written, or null: the code changes it, or reads it before it exists.
  const unsafeReason = (use) => {
    if (scope.changed.has(use.name)) return 'list-name-changed';
    if (scope.ends.get(use.name) > use.start) return 'list-name-order';
    return null;
  };
  if (arg.type === 'Identifier') {
    const pair = scope.pairs.get(arg.name);
    if (!pair) return [{ reason: 'pair-name-not-pair', source: sourceOf(code, arg) }];
    const unsafe = unsafeReason(arg);
    return unsafe ? [{ reason: unsafe, source: sourceOf(code, arg) }] : [{ pair }];
  }
  if (arg.type === 'SpreadElement') {
    const notAList = [{ reason: 'spread-not-const-list', source: sourceOf(code, arg) }];
    if (arg.argument.type !== 'Identifier') return notAList;
    const list = scope.arrays.get(arg.argument.name);
    if (!list) return notAList;
    const unsafeList = unsafeReason(arg.argument);
    if (unsafeList) return [{ reason: unsafeList, source: sourceOf(code, arg) }];
    const entries = [];
    for (const element of list.elements) {
      if (element && element.type === 'ArrayExpression') entries.push({ pair: element });
      else if (element && element.type === 'Identifier' && scope.pairs.has(element.name)) {
        const unsafe = unsafeReason(element);
        if (unsafe) return [{ reason: unsafe, source: sourceOf(code, element) }];
        entries.push({ pair: scope.pairs.get(element.name) });
      } else return notAList;
    }
    return entries;
  }
  return [{ reason: 'not-a-pair', source: sourceOf(code, arg) }];
}

/**
 * Reads every arrange() call in `code`. A call is read when every argument is a two-element array
 * with a whole-number length above zero, written as a number, as the name of a top-level `const`
 * holding one, or as constant arithmetic over those (`+ - * /`, unary signs, parentheses), and a
 * pattern (see evaluateLength). An argument may also be the name of a
 * top-level const holding one such pair, or a spread of a top-level const holding a list of pairs
 * and pair names (argumentEntries); sections are numbered in the expanded order. Any other call is skipped and gives exactly one problem
 * `{ call, section, reason, source }` for its first unreadable argument (`call` and `section`
 * count from 1 in source order; `section` and `source` are null for a call with no arguments).
 * Nested arrange() calls inside a kept or skipped one are still found in their own right (the
 * walk keeps descending). Returns `{ arrangements, problems, callCount }`, the arrangements in
 * source order as `{ index, start, end, sections: [{ name, length, start }], total, owner,
 * offset, offsetCall }`.
 */
export function readArrangements(code, { parse, tracks }) {
  const ast = parse(code, PARSE_OPTIONS);
  const scope = buildScope(ast);
  const results = [];
  const problems = [];
  let callCount = 0;
  walk(ast, null, [], (node, parent, ancestors) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'arrange') {
      return true;
    }
    callCount += 1;
    const call = callCount;
    const sectionsRaw = [];
    let problem = null;
    for (const arg of node.arguments) {
      if (problem !== null) break;
      for (const entry of argumentEntries(arg, scope, code)) {
        const section = sectionsRaw.length + 1;
        if (entry.reason) {
          problem = { call, section, reason: entry.reason, source: entry.source };
          break;
        }
        const [lengthNode, exprNode] = entry.pair.elements;
        if (entry.pair.elements.length !== 2 || !lengthNode) {
          problem = { call, section, reason: 'not-a-pair', source: sourceOf(code, entry.pair) };
          break;
        }
        if (!exprNode) {
          problem = { call, section, reason: 'no-pattern', source: sourceOf(code, entry.pair) };
          break;
        }
        const evaluated = evaluateLength(lengthNode, scope, lengthNode, 0);
        if (!evaluated.ok) {
          problem = { call, section, reason: evaluated.reason, source: sourceOf(code, evaluated.node) };
          break;
        }
        const length = evaluated.value;
        let reason = null;
        if (!Number.isInteger(length)) reason = 'length-not-whole';
        else if (length <= 0) reason = 'length-not-above-zero';
        if (reason !== null) {
          problem = { call, section, reason, source: sourceOf(code, lengthNode) };
          break;
        }
        sectionsRaw.push({ length, exprNode });
      }
    }
    if (problem === null && sectionsRaw.length === 0) {
      problem = { call, section: null, reason: 'no-sections', source: null };
    }
    if (problem !== null) {
      problems.push(problem);
      return true;
    }

    let running = 0;
    const sections = sectionsRaw.map(({ length, exprNode }, k) => {
      const name = exprNode.type === 'Identifier' ? exprNode.name : `Part ${k + 1}`;
      const section = { name, length, start: running };
      running += length;
      return section;
    });
    const total = running;

    let offset = 0;
    let offsetCall = null;
    const memberParent = ancestors[0];
    const callParent = ancestors[1];
    if (
      memberParent &&
      memberParent.type === 'MemberExpression' &&
      !memberParent.computed &&
      memberParent.object === node &&
      (memberParent.property.name === 'late' || memberParent.property.name === 'early') &&
      callParent &&
      callParent.type === 'CallExpression' &&
      callParent.callee === memberParent &&
      callParent.arguments.length === 1
    ) {
      const value = numericLiteralValue(callParent.arguments[0]);
      if (value !== null) {
        offset = memberParent.property.name === 'late' ? value : -value;
        offsetCall = { start: node.end, end: callParent.end };
      }
    }

    results.push({
      index: results.length,
      start: node.start,
      end: node.end,
      sections,
      total,
      owner: findOwner(node, ancestors, code, tracks),
      offset,
      offsetCall,
    });
    return true;
  });
  return { arrangements: results, problems, callCount };
}

/** The arrange() calls of `code` the Parts view can read, in source order (see readArrangements,
 * which also says why each other call was skipped). */
export function extractArrangements(code, { parse, tracks }) {
  return readArrangements(code, { parse, tracks }).arrangements;
}

/** The clause template for `problem.reason`. An unknown reason throws (loud). */
function reasonClause(problem) {
  const clause = PARTS_COPY.reasons[problem.reason];
  if (typeof clause !== 'string') throw new Error(`Moontide: unknown Parts reason '${String(problem.reason)}'.`);
  return clause;
}

/** The sentence for one unreadable arrange() call. An unknown reason throws (loud). */
export function arrangeProblemText(problem, callCount) {
  const reason = fillParts(reasonClause(problem), { section: problem.section, source: problem.source });
  const template = callCount === 1 ? PARTS_COPY.cannotReadOne : PARTS_COPY.cannotReadOf;
  return fillParts(template, { call: problem.call, count: callCount, reason });
}

/** The line under the drawn rows when some arrange() calls were skipped: one sentence per skipped
 * call, saying which call and why. */
export function partsSkippedText(problems, callCount) {
  return problems
    .map((problem) =>
      fillParts(PARTS_COPY.skippedOf, {
        call: problem.call,
        count: callCount,
        reason: fillParts(reasonClause(problem), { section: problem.section, source: problem.source }),
      }),
    )
    .join(' ');
}

/** The Parts view's empty-state text when the code has arrange() calls but none could be read:
 * each problem's sentence, then the shape rule. */
export function partsEmptyText(problems, callCount) {
  return [...problems.map((problem) => arrangeProblemText(problem, callCount)), PARTS_COPY.shapeRule].join(' ');
}

/** The positive modulo position (0..total) of `cycle` within an arrangement offset by `offset`,
 * out of `total` cycles. */
export function arrangementPosition(cycle, offset, total) {
  return positiveModulo(cycle - offset, total);
}

/**
 * The absolute cycle a part launch should target: cycle 0 when the page is stopped (Stop
 * restarts the count at 0); otherwise the next whole cycle above `now`, or the one after it when
 * fewer than LAUNCH_MIN_LEAD_SECONDS remain before that boundary.
 * Throws a 'Moontide:' error when not stopped and `cps` is not a finite positive number, or when
 * `now` is not a finite number (a non-finite `now` must never reach `.late()`/`.early()` — see
 * page/main.js's own clamp on `scheduler.now()`).
 */
export function launchTargetCycle({ now, cps, stopped }) {
  if (stopped) return 0;
  if (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0) {
    throw new Error('Moontide: launchTargetCycle needs a finite positive cps to compute a launch target.');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('Moontide: launchTargetCycle needs a finite now to compute a launch target.');
  }
  const candidate = Math.floor(now) + 1;
  const secondsLeft = (candidate - now) / cps;
  return secondsLeft < LAUNCH_MIN_LEAD_SECONDS ? candidate + 1 : candidate;
}

/** The `.late()`/`.early()` offset (a whole number, positive or negative-equivalent via modulo)
 * that makes the section starting at `sectionStart` land on `targetCycle`, within an arrangement
 * of `total` cycles. */
export function launchOffset(targetCycle, sectionStart, total) {
  return positiveModulo(targetCycle - sectionStart, total);
}

/**
 * Rewrites `code` so `arrangement`'s arrange() call carries a single `.late(offset)` — replacing
 * any existing `.late()`/`.early()` call this module previously wrote (`arrangement.offsetCall`),
 * or inserting one right after the call when there is none. `offset` 0 removes the call/inserts
 * nothing, so a launch back to the arrangement's own written position leaves plain Strudel behind
 * (the code keeps telling the truth).
 */
export function applyArrangeOffset(code, arrangement, offset) {
  const { offsetCall, end } = arrangement;
  const spliceStart = offsetCall ? offsetCall.start : end;
  const spliceEnd = offsetCall ? offsetCall.end : end;
  const text = offset === 0 ? '' : `.late(${offset})`;
  return code.slice(0, spliceStart) + text + code.slice(spliceEnd);
}

/** A stable-enough signature for one arrangement row: its index plus every section's name and
 * length, used to detect whether a clicked row still exists (and matches) after a re-parse. */
export function rowSignature(arrangement) {
  return `${arrangement.index}:${arrangement.sections.map((section) => `${section.name}:${section.length}`).join(',')}`;
}

/** A part name clipped to MAX_PART_NAME_LENGTH (with a trailing '…' when cut) before it is sent
 * to the server as the `part-launch` message's `part` field (src/protocol.ts's own limit). */
export function partLaunchPart(name) {
  if (name.length <= MAX_PART_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_PART_NAME_LENGTH - 1)}…`;
}

/**
 * One `{ state, text, progress }` per section of `arrangement`, from a live `cycle`/`cps`
 * reading. `playing` false (the
 * page isn't actually making sound) forces every card to 'idle', whatever `pending` says — a
 * launch while stopped targets cycle 0 and brings sound back, but until it does every card reads
 * Idle. `progress` is the continuous 0..1 fraction of the
 * playing card's own length elapsed since its section start; the caller steps it to whole
 * cycles when motion is off (`Math.floor(progress * length) / length`).
 */
export function partStates({ arrangement, cycle, cps, playing, pending }) {
  const { sections, total, offset } = arrangement;
  const position = arrangementPosition(cycle, offset, total);
  const currentIndex = sections.findIndex((section) => position >= section.start && position < section.start + section.length);

  return sections.map((section, i) => {
    if (playing && i === currentIndex) {
      const elapsedRaw = position - section.start;
      const elapsedDisplay = Math.floor(elapsedRaw) + 1;
      return {
        state: 'playing',
        text: `Playing — ${elapsedDisplay}/${section.length} cycles`,
        progress: elapsedRaw / section.length,
      };
    }
    if (playing && pending !== null && pending.partIndex === i && cycle < pending.targetCycle) {
      const secondsLeft = (pending.targetCycle - cycle) / cps;
      return {
        state: 'queued',
        text: `Queued — starts in ${secondsLeft.toFixed(1)}s`,
        progress: 0,
      };
    }
    return {
      state: 'idle',
      text: `Idle — ${section.length} cycles`,
      progress: 0,
    };
  });
}

/**
 * The section spans of `arrangement` visible across the page `[pageStart, pageStart +
 * pageCycles)` (the arrange()/loop-repeat rows above
 * the lanes) — `{ name, x, width, length }[]`, `x`/`width` in cycles relative to `pageStart`, in source
 * order left to right; `length` is the span's own section length, however the page clips the span. The arrangement repeats every `total` cycles on the absolute count
 * (reference/transitions.md "Sections over many cycles"), so a page can start mid-section: the
 * first span is clipped to `pageStart` (it is the tail of
 * 'three'). Every span is clipped to the page's own end too.
 */
export function sectionSpans(arrangement, pageStart, pageCycles = 32) {
  const { sections, total, offset } = arrangement;
  const pageEnd = pageStart + pageCycles;
  const startPosition = positiveModulo(pageStart - offset, total);
  const startIndex = sections.findIndex((section) => startPosition >= section.start && startPosition < section.start + section.length);
  const firstIndex = startIndex === -1 ? sections.length - 1 : startIndex;

  const spans = [];
  let sectionIndex = firstIndex;
  // The absolute cycle this section's own span started at — possibly before pageStart, when the
  // page opens mid-section (clipped below).
  let spanStart = pageStart - (startPosition - sections[firstIndex].start);
  while (spanStart < pageEnd) {
    const section = sections[sectionIndex];
    const spanEnd = spanStart + section.length;
    const clippedStart = Math.max(spanStart, pageStart);
    const clippedEnd = Math.min(spanEnd, pageEnd);
    if (clippedEnd > clippedStart) {
      spans.push({ name: section.name, x: clippedStart - pageStart, width: clippedEnd - clippedStart, length: section.length });
    }
    spanStart = spanEnd;
    sectionIndex = (sectionIndex + 1) % sections.length;
  }
  return spans;
}
