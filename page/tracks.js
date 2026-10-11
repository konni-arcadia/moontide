// Pure track-parsing module for Moontide's browser page: finds the labeled tracks of the
// code that actually played, and builds the source text of a "solo" program that reproduces
// one track's own pattern without touching the live scheduler. `parse` (acorn) is injected —
// Node resolves the `acorn` package directly, the browser reads the pinned `window.acorn`
// global — so this module has no DOM access at import time and can be imported directly by
// node:test and by page/main.js without a build step.

import { MIXER_METHOD_NAMES } from './mixer-registry.js';

export const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true };

/**
 * Every top-level LabeledStatement whose body is an ExpressionStatement, in source order, with
 * duplicate non-`$` labels resolved to one entry: Strudel's own `.p(id)` registry only keeps
 * the LAST statement that wrote a given id, so a repeated plain label collapses to a single
 * track, taken from (and positioned at) its last occurrence. A label containing `$` never
 * dedupes — Strudel gives each `$` occurrence its own unique internal id, so two `$:` statements
 * are always two separate, independent tracks.
 */
function finalLabeledStatements(ast) {
  const raw = ast.body.filter((node) => node.type === 'LabeledStatement' && node.body && node.body.type === 'ExpressionStatement');
  const lastByLabel = new Map();
  for (const statement of raw) {
    const label = statement.label.name;
    if (!label.includes('$')) lastByLabel.set(label, statement);
  }
  const kept = [];
  const placedLabels = new Set();
  for (const statement of raw) {
    const label = statement.label.name;
    if (label.includes('$')) {
      kept.push(statement);
      continue;
    }
    if (lastByLabel.get(label) === statement && !placedLabels.has(label)) {
      kept.push(statement);
      placedLabels.add(label);
    }
  }
  return kept;
}

/**
 * Walks `node` and every descendant, calling `visit(node, parent, ancestors)` for each, where
 * `ancestors` is the parent chain from immediate parent (index 0) up to the root. Skips further
 * descent under a node when `visit` returns `false` (used to avoid re-wrapping text already
 * replaced by an edit, or re-collecting a literal's own non-existent children).
 */
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

/**
 * Collects an edit list — {start, end, text} spans, in the original source's own offsets —
 * that rewrites every double-quoted string Literal and every untagged TemplateLiteral into
 * Strudel's own `m(value, start)` call, exactly as the pinned bundle's transpiler does. A
 * single-quoted string is left untouched (the transpiler leaves it plain too). A tagged
 * template's own TemplateLiteral is left untouched (its tag function reads it directly), but
 * its embedded `${...}` expressions are still walked in case they hold their own strings.
 */
function collectStringEdits(root, edits) {
  walk(root, null, [], (node, parent) => {
    if (node.type === 'Literal' && typeof node.value === 'string' && typeof node.raw === 'string' && node.raw.startsWith('"')) {
      edits.push({ start: node.start, end: node.end, text: `m(${JSON.stringify(node.value)}, ${node.start})` });
      return false;
    }
    if (node.type === 'TemplateLiteral' && (!parent || parent.type !== 'TaggedTemplateExpression')) {
      const raw = (node.quasis[0] && node.quasis[0].value && node.quasis[0].value.raw) || '';
      edits.push({ start: node.start, end: node.end, text: `m(${JSON.stringify(raw)}, ${node.start})` });
      return false;
    }
    return true;
  });
}

/** Rebuilds `code.slice(start, end)` with every edit inside that span applied, in offset order. */
function applyEdits(code, edits, start, end) {
  const relevant = edits.filter((edit) => edit.start >= start && edit.end <= end).sort((a, b) => a.start - b.start);
  let result = '';
  let pos = start;
  for (const edit of relevant) {
    result += code.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  result += code.slice(pos, end);
  return result;
}

/**
 * Walks a chain of `.method(args)` calls (a CallExpression whose callee is a MemberExpression)
 * back to its root, in source order (outermost call is walked first, then reversed at the end),
 * collecting each segment's method name and — when its first argument is a plain string
 * Literal — that string value. If the chain's root is itself a call with an Identifier callee
 * (e.g. `note(...)`, `s(...)`), its own name and (if a plain string) first-argument value are
 * captured too; otherwise `root` describes the chain's ultimate base (an identifier's name, a
 * `name(...)` call description, or the node's own type) for the `root:<name>` fallback.
 */
function walkChain(node) {
  const calls = [];
  let cur = node;
  while (cur && cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
    const name = cur.callee.property.name;
    const arg0 = cur.arguments[0];
    const literal = arg0 && arg0.type === 'Literal' && typeof arg0.value === 'string' ? arg0.value : undefined;
    calls.push({ name, literal });
    cur = cur.callee.object;
  }
  calls.reverse();
  let rootCallName;
  let rootLiteral;
  if (cur.type === 'CallExpression' && cur.callee.type === 'Identifier') {
    rootCallName = cur.callee.name;
    const arg0 = cur.arguments[0];
    rootLiteral = arg0 && arg0.type === 'Literal' && typeof arg0.value === 'string' ? arg0.value : undefined;
  }
  const root =
    cur.type === 'Identifier' ? cur.name : cur.type === 'CallExpression' && cur.callee.type === 'Identifier' ? `${cur.callee.name}(...)` : cur.type;
  return { root, rootCallName, rootLiteral, calls };
}

/** True when the track's own spine (its outer `.method()` chain) calls `.hush()`: Strudel's
 * Pattern#hush returns silence, so that one pattern plays nothing. A
 * `.hush()` inside a function argument is not on the spine and is ignored. */
function isHushed(expression) {
  return walkChain(expression).calls.some((call) => call.name === 'hush');
}

// --- Signal-driven filter curves ---

/** Strudel's own continuous waveform/randomness signal identifiers plus their bipolar "2"
 * variants (sine, cosine, saw, isaw, tri, square, perlin, rand,
 * irand, signal and their 2 variants). `signal` itself is always a CALL (signal(fn)), handled
 * separately below — it has no bare-identifier form. */
const SIGNAL_BASE_NAMES = ['sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'perlin', 'rand', 'irand'];
const SIGNAL_NAMES = new Set([...SIGNAL_BASE_NAMES, ...SIGNAL_BASE_NAMES.map((name) => `${name}2`)]);

/** Method names writing each filter's control (confirmed against the
 * pinned 1.3.0 bundle): lpf/cutoff/ctf/lp all write `cutoff`; hpf/hp write `hcutoff`; bpf/bp
 * write `bandf`. */
const FILTER_METHOD_KIND = {
  lpf: 'lpf',
  cutoff: 'lpf',
  ctf: 'lpf',
  lp: 'lpf',
  hpf: 'hpf',
  hp: 'hpf',
  bpf: 'bpf',
  bp: 'bpf',
};
const FILTER_CONTROL = { lpf: 'cutoff', hpf: 'hcutoff', bpf: 'bandf' };

/**
 * True when `node` (a filter method's first argument) is driven by a signal: its own chain root
 * is one of SIGNAL_NAMES or a `signal(...)` call, OR — one level only — it is a bare identifier
 * naming a top-level `const`/`let` whose OWN initializer resolves the same way (one level of const resolution; a const holding a string gives null). A string literal
 * anywhere in the chain (e.g. `.s("square")`) never counts — only a free identifier does.
 */
function isSignalDriven(node, topLevelDecls) {
  if (!node) return false;
  const root = chainRoot(node);
  if (root.type === 'CallExpression' && root.callee.type === 'Identifier' && root.callee.name === 'signal') {
    return true;
  }
  if (root.type !== 'Identifier') return false;
  if (SIGNAL_NAMES.has(root.name)) return true;
  const decl = topLevelDecls.get(root.name);
  if (!decl) return false;
  const declRoot = chainRoot(decl);
  if (declRoot.type === 'CallExpression' && declRoot.callee.type === 'Identifier' && declRoot.callee.name === 'signal') {
    return true;
  }
  return declRoot.type === 'Identifier' && SIGNAL_NAMES.has(declRoot.name);
}

/** Every lpf/hpf/bpf-family method call in `node`'s own `.method()` chain, outermost (last
 * applied) first — `{ filterKind, argNode }[]`, `argNode` the call's own first argument (kept
 * as a real AST node, not just its literal value, so isSignalDriven can walk it). */
function filterCallsInChain(node) {
  const calls = [];
  let cur = node;
  while (cur && cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
    const filterKind = FILTER_METHOD_KIND[cur.callee.property.name];
    if (filterKind) calls.push({ filterKind, argNode: cur.arguments[0] });
    cur = cur.callee.object;
  }
  return calls;
}

/**
 * The curve for one track's own pattern expression: `{ filter, control }` for the first filter
 * kind — checked in priority order lpf, then hpf, then bpf (one curve
 * per lane) — that has at least one signal-driven call anywhere
 * in the chain, or `null` when none does.
 */
function trackCurve(expr, topLevelDecls) {
  const calls = filterCallsInChain(expr);
  for (const filterKind of ['lpf', 'hpf', 'bpf']) {
    const hasSignal = calls.some((call) => call.filterKind === filterKind && isSignalDriven(call.argNode, topLevelDecls));
    if (hasSignal) return { filter: filterKind, control: FILTER_CONTROL[filterKind] };
  }
  return null;
}

/** Every top-level `const`/`let` declarator's initializer, by name — the "one level of const
 * resolution" trackCurve/isSignalDriven read from. */
function collectTopLevelDecls(ast) {
  const decls = new Map();
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init) {
        decls.set(declarator.id.name, declarator.init);
      }
    }
  }
  return decls;
}

/**
 * Display name for a track with no stable text name of its own (every `$`
 * label): the first string argument of an `s()`/`sound()` call anywhere in the chain (called
 * as a bare function or as a `.method()`), else of a `bank()` call, else the chain root call's
 * own string argument, else the root identifier's/call's own description.
 */
function displayNameFromSound(expr) {
  const { root, rootCallName, rootLiteral, calls } = walkChain(expr);
  const findCall = (name) => {
    if (rootCallName === name && typeof rootLiteral === 'string') return rootLiteral;
    const found = calls.find((call) => call.name === name && typeof call.literal === 'string');
    return found ? found.literal : undefined;
  };
  const sOrSound = findCall('s') ?? findCall('sound');
  if (sOrSound !== undefined) return sOrSound;
  const bank = findCall('bank');
  if (bank !== undefined) return bank;
  if (typeof rootLiteral === 'string') return rootLiteral;
  return root;
}

/**
 * The name of the nearest enclosing call that "receives" `literalNode` as one of its own
 * `arguments` — walking up through every ancestor (a chain of `.method()`/nested-call wrapping,
 * e.g. `"c4 e4".fast(2)` passed into `note(...)`) until an ancestor's own `arguments` array
 * contains the child we just came from (starting from `literalNode` itself). Returns null if
 * no enclosing call ever receives it (the literal sits only inside a callee position, never as
 * an argument).
 */
function receivingCallName(literalNode, ancestors) {
  let child = literalNode;
  for (const ancestor of ancestors) {
    if (ancestor.type === 'CallExpression' && Array.isArray(ancestor.arguments) && ancestor.arguments.includes(child)) {
      if (ancestor.callee.type === 'Identifier') return ancestor.callee.name;
      if (ancestor.callee.type === 'MemberExpression' && !ancestor.callee.computed) return ancestor.callee.property.name;
      return null;
    }
    child = ancestor;
  }
  return null;
}

/**
 * Stable structural identity for a track with no text name of its own: every string
 * literal reachable anywhere within the expression (including through a chained transform like
 * `"c4 e4".fast(2)` passed as an argument), in SOURCE order, each written as
 * `<receiving call name>:<value>` and joined with `|`. Numeric arguments never contribute (a
 * `.gain(0.5)` edit or an added `.room(0.2)` leaves the identity unchanged), and neither does a
 * string received by a method the mixer writes (MIXER_METHOD_NAMES: `.vowel("a")`,
 * `.compressor("-20:4")`), so adding, removing or bypassing an effect keeps the track. Falls back to
 * `root:<name>` when the expression carries no string at all. Duplicate raw identities within
 * one program (e.g. two byte-identical `$:` statements) get a ` #2`, ` #3`, ... suffix, applied
 * by the caller across the whole track list — this function only computes the raw form.
 */
function structuralIdentity(expr) {
  const parts = [];
  walk(expr, null, [], (node, parent, ancestors) => {
    const isString = node.type === 'Literal' && typeof node.value === 'string';
    const isTemplate = node.type === 'TemplateLiteral' && (!parent || parent.type !== 'TaggedTemplateExpression');
    if (!isString && !isTemplate) return true;
    const value = isString ? node.value : (node.quasis[0] && node.quasis[0].value && node.quasis[0].value.raw) || '';
    const name = receivingCallName(node, ancestors);
    if (name !== null && !MIXER_METHOD_NAMES.has(name)) parts.push({ start: node.start, text: `${name}:${value}` });
    return false;
  });
  parts.sort((a, b) => a.start - b.start);
  if (parts.length === 0) {
    return `root:${walkChain(expr).root}`;
  }
  return parts.map((part) => part.text).join('|');
}

/** After names are computed: groups tracks sharing one display name and gives the plain name
 * to the one whose (already-deduped) identity sorts first, ` 2`, ` 3`, ... to the rest, in
 * identity order — stable under a source reorder, unlike a first-seen-position rule. */
function applyNameNumbering(tracks) {
  const groups = new Map();
  for (const track of tracks) {
    if (!groups.has(track.name)) groups.set(track.name, []);
    groups.get(track.name).push(track);
  }
  for (const [name, group] of groups) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
    sorted.forEach((track, i) => {
      if (i > 0) track.name = `${name} ${i + 1}`;
    });
  }
}

/** Appends ` #2`, ` #3`, ... to every identity that repeats a prior track's raw identity
 * (source order), so identity stays a unique key even for two byte-identical statements. */
function dedupeIdentities(tracks) {
  const counts = new Map();
  for (const track of tracks) {
    const count = (counts.get(track.identity) || 0) + 1;
    counts.set(track.identity, count);
    if (count > 1) track.identity = `${track.identity} #${count}`;
  }
}

/** The mixer's own solo marker, written in front of a track's label (`S_hats:`). Strudel plays
 * a label longer than one character that starts with a capital `S` alone; the underscore after
 * the S gives a name that merely starts with S no way to be mistaken for the mixer's marker
 * (proven in the pinned bundle: `S_a` plays alone and is not muted). */
export const SOLO_MARKER = 'S_';

/**
 * Reads one label the way Strudel does and the way the mixer writes it (the one state machine
 * behind what the page shows and what a mute or solo press writes):
 * - `mutedByLabel`: the label starts or ends with `_`, which Strudel silences.
 * - `core`: the label with ONE leading and ONE trailing `_` removed.
 * - `solo`: 'marker' when `core` starts with SOLO_MARKER and holds more than it; 'name' when
 *   `core` is longer than one character, starts with a capital `S` and the label is not muted
 *   (Strudel plays it alone, but the mixer did not write it); otherwise null.
 * - `soloInert`: a marker that a mute underscore silences.
 * - `base`: `core` without the marker.
 * - `safe`: the mixer can rewrite this label: `base` is not empty, does not start or end with
 *   `_`, does not start with a digit, and the label is not the bare marker.
 */
export function parseLabel(label) {
  const mutedByLabel = label.startsWith('_') || label.endsWith('_');
  let core = label;
  if (core.startsWith('_')) core = core.slice(1);
  if (core.endsWith('_')) core = core.slice(0, -1);
  let solo = null;
  let base = core;
  if (core.startsWith(SOLO_MARKER) && core.length > SOLO_MARKER.length) {
    solo = 'marker';
    base = core.slice(SOLO_MARKER.length);
  } else if (core.length > 1 && core.startsWith('S') && !mutedByLabel) {
    solo = 'name';
  }
  const safe = base !== '' && !base.startsWith('_') && !base.endsWith('_') && !/^[0-9]/.test(base) && label !== SOLO_MARKER;
  return { mutedByLabel, core, solo, soloInert: solo === 'marker' && mutedByLabel, base, safe };
}

/**
 * Every labeled statement in the code, in source order (after the last-statement-wins dedup
 * above). A track is `{ index, kind: 'label', label, name, identity, muted, start, end, ... }`:
 * - `label` is the label text verbatim; `name` is the label text too (a `$` label's `name` comes
 *   from the sound it plays, see displayNameFromSound).
 * - `baseLabel` is the label without Strudel's mute underscore and the mixer's solo marker; a plain
 *   (non-`$`) label's `identity` is `label:<baseLabel>`, so a mute or a solo never changes a
 *   track's identity (its color and its stored records survive). A `$` label's identity comes from
 *   its structure (see structuralIdentity).
 * - `ownMuted` is true when the track silences itself: a leading or trailing `_` on its label, or a
 *   `.hush()` on its own chain (`hushed`); `solo` is 'marker', 'name' or null and `soloInert` marks a marker a mute silences (see
 *   parseLabel); `displayName` is the name the page shows: the sound name for a `$` label, else
 *   the base label (raw label when the mixer cannot read it).
 * - `muted` means "not sounding" (its original meaning): `ownMuted`, or another label solos and this
 *   one is not itself a solo label. A label starting or ending with `_` never solos, because
 *   Strudel registers no such label.
 * - `start`/`end` are the source offsets of the track's own pattern expression (not the label
 *   or the statement).
 *
 * Factored out (as `buildLabelTracks`, below) so `extractTracks` can also build tracks straight
 * from a program with no labels at all (the other half of track reading).
 */
function buildLabelTracks(statements, topLevelDecls) {
  const soloLabels = new Set(
    statements
      .map((s) => s.label.name)
      .filter((label) => label.length > 1 && label.startsWith('S') && !label.startsWith('_') && !label.endsWith('_')),
  );
  const soloActive = soloLabels.size > 0;

  const tracks = statements.map((statement, index) => {
    const label = statement.label.name;
    const expression = statement.body.expression;
    const isDollar = label.includes('$');
    const parsed = parseLabel(label);
    const baseLabel = parsed.safe ? parsed.base : label;
    const hushed = isHushed(expression);
    const ownMuted = parsed.mutedByLabel || hushed;
    return {
      index,
      kind: 'label',
      label,
      name: isDollar ? displayNameFromSound(expression) : label,
      identity: isDollar ? structuralIdentity(expression) : `label:${baseLabel}`,
      baseLabel,
      hushed,
      ownMuted,
      solo: parsed.solo,
      soloInert: parsed.soloInert,
      muted: ownMuted || (soloActive && !soloLabels.has(label)),
      curve: trackCurve(expression, topLevelDecls),
      start: expression.start,
      end: expression.end,
    };
  });

  dedupeIdentities(tracks);
  applyNameNumbering(tracks);
  for (const track of tracks) {
    track.displayName = track.label.includes('$') ? track.name : track.baseLabel;
  }
  return tracks;
}

/** Calls Strudel returns silence from when they are the program's own last top-level expression
 * statement: the program plays nothing, so there are no tracks to
 * show — never a fallback guess at what might have played. */
const SILENT_LAST_CALLS = new Set(['all', 'each', 'hush', 'setcps', 'setcpm', 'setCps', 'setCpm', 'samples']);

/** The last top-level ExpressionStatement in `ast.body`, in source order — the statement whose
 * value Strudel actually plays when the program has no labels. `null` when the program has none
 * at all (every statement is a declaration, or the program is empty/comments-only). */
function lastTopLevelExpressionStatement(ast) {
  let found = null;
  for (const statement of ast.body) {
    if (statement.type === 'ExpressionStatement') found = statement;
  }
  return found;
}

/** Walks a chain of `.method(args)` calls back to its root NODE (the same walk walkChain does,
 * but returning the node itself rather than a description) — used to tell a `stack(...)` call, a
 * silently-returning call, or a runtime-conditional branch apart from an ordinary sound chain. */
function chainRoot(node) {
  let cur = node;
  while (cur && cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
    cur = cur.callee.object;
  }
  return cur;
}

/** True when `rootNode` (the result of chainRoot) was built by a runtime condition — a ternary
 * or a `&&`/`||` short-circuit choosing between two different patterns. Static parsing cannot
 * know which side will actually run, so a branch/program rooted here gets no stable identity of
 * its own (shown as 'unnamed' ... never with a fake one). */
export function isRuntimeConditional(rootNode) {
  return rootNode.type === 'ConditionalExpression' || rootNode.type === 'LogicalExpression';
}

/** Flattens a `stack(...)`'s own argument list into leaf branch entries — `{ node, unnamed }` —
 * opening any argument whose own chain root is itself a `stack(...)` call, recursively, so a
 * stack() nested several levels deep still yields one leaf per innermost branch. A chain wrapped around the nested stack() itself (e.g. its
 * own `.fast(2)`) is never captured as a leaf's own range — it stays part of the shared, unsplit
 * text every leaf's solo program silences down to (soloSource works entirely from leaf ranges,
 * so that outer chain reaches every inner branch exactly as it does in the real pattern). */
function flattenBranches(nodes, entries) {
  for (const node of nodes) {
    const root = chainRoot(node);
    if (root.type === 'CallExpression' && root.callee.type === 'Identifier' && root.callee.name === 'stack') {
      flattenBranches(root.arguments, entries);
    } else {
      entries.push({ node, unnamed: isRuntimeConditional(root) });
    }
  }
}

/**
 * For code without labels: finds the branches that make up the program's tracks, from the last
 * top-level expression statement (every branch of a top-level stack()). Returns
 * `{ programExpr: null, kind: null, entries: [] }` when the program plays nothing (no expression
 * statement, or its root is one of SILENT_LAST_CALLS); `{ programExpr, kind: 'branch', entries }`
 * for a top-level `stack(...)`, flattened recursively through any nested stack() branch; `{
 * programExpr, kind: 'program', entries: [{ node: programExpr, unnamed }] }` for a single pattern
 * — the whole expression is the one track, `unnamed` true only when the whole program itself is a
 * runtime-conditional expression. Every entry is `{ node, unnamed }`.
 */
function unlabeledBranches(ast) {
  const statement = lastTopLevelExpressionStatement(ast);
  if (!statement) return { programExpr: null, kind: null, entries: [] };
  const programExpr = statement.expression;
  const root = chainRoot(programExpr);
  const rootIsCall = root.type === 'CallExpression' && root.callee.type === 'Identifier';
  if (rootIsCall && SILENT_LAST_CALLS.has(root.callee.name)) {
    return { programExpr: null, kind: null, entries: [] };
  }
  if (rootIsCall && root.callee.name === 'stack') {
    const entries = [];
    flattenBranches(root.arguments, entries);
    return { programExpr, kind: 'branch', entries };
  }
  return { programExpr, kind: 'program', entries: [{ node: programExpr, unnamed: isRuntimeConditional(root) }] };
}

/** Track objects for the unlabeled-program branches found above: named/identified exactly like
 * a `$:` label (displayNameFromSound/structuralIdentity), since neither has a real name of its
 * own — UNLESS the entry is `unnamed` (its root is a runtime condition), which instead gets
 * `'Unnamed N'` / `'unnamed:N'`, N counted in SOURCE order among the unnamed entries only
 * (never with a fake one). There is no label to silence, so `muted` is true only
 * for a branch whose own chain calls `.hush()` (`ownMuted` and `hushed` say the same); `solo` is
 * always null. */
function buildBranchTracks({ kind, entries }, topLevelDecls) {
  if (!kind) return [];
  let unnamedCount = 0;
  const tracks = entries.map(({ node, unnamed }, index) => {
    if (unnamed) {
      unnamedCount += 1;
      const unnamedHushed = isHushed(node);
      return {
        index,
        kind,
        name: `Unnamed ${unnamedCount}`,
        identity: `unnamed:${unnamedCount}`,
        unnamed: true,
        hushed: unnamedHushed,
        ownMuted: unnamedHushed,
        solo: null,
        soloInert: false,
        muted: unnamedHushed,
        curve: trackCurve(node, topLevelDecls),
        start: node.start,
        end: node.end,
      };
    }
    const hushed = isHushed(node);
    return {
      index,
      kind,
      name: displayNameFromSound(node),
      identity: structuralIdentity(node),
      unnamed: false,
      hushed,
      ownMuted: hushed,
      solo: null,
      soloInert: false,
      muted: hushed,
      curve: trackCurve(node, topLevelDecls),
      start: node.start,
      end: node.end,
    };
  });
  dedupeIdentities(tracks);
  applyNameNumbering(tracks);
  for (const track of tracks) track.displayName = track.name;
  return tracks;
}

/**
 * The AST nodes of the tracks `extractTracks` returns for the same program, in the same order
 * (so `trackNodes(ast)[i]` belongs to `extractTracks(code)[i]`). Labeled programs give one entry
 * per final labeled statement, `{ kind: 'label', statement, labelNode, expression, unnamed: false
 * }`; otherwise one entry per unlabeled branch, `{ kind, statement: null, labelNode: null,
 * expression, unnamed }`. The expression node is taken from the statement or from the branch
 * entry, never found again by matching ranges: the ExpressionStatement shares its expression's
 * range, so a range match returns the statement first.
 */
export function trackNodes(ast) {
  const statements = finalLabeledStatements(ast);
  if (statements.length > 0) {
    return statements.map((statement) => ({
      kind: 'label',
      statement,
      labelNode: statement.label,
      expression: statement.body.expression,
      unnamed: false,
    }));
  }
  const { kind, entries } = unlabeledBranches(ast);
  if (!kind) return [];
  return entries.map((entry) => ({
    kind,
    statement: null,
    labelNode: null,
    expression: entry.node,
    unnamed: entry.unnamed,
  }));
}

/**
 * The range of one track's own statement in `code`, `{ from, to }`, or null when `identity` is not a
 * track of `code` (no track at all, or a track that is gone). A labeled track runs from its label to the
 * end of its statement (its `;` included); an unlabeled stack branch is its branch expression. The
 * offsets are UTF-16 offsets of `code`: acorn's own, which CodeMirror positions share. A repeated plain
 * label resolves to its last statement and each `$:` statement to its own (the rules of `trackNodes`);
 * a constant the track reads is not part of the range.
 */
export function trackRange(code, identity, { parse }) {
  const ast = parse(code, PARSE_OPTIONS);
  const tracks = extractTracks(code, { parse });
  const index = tracks.findIndex((track) => track.identity === identity);
  if (index === -1) return null;
  const entry = trackNodes(ast)[index];
  const node = entry.statement ?? entry.expression;
  return { from: node.start, to: node.end };
}

export function extractTracks(code, { parse }) {
  const ast = parse(code, PARSE_OPTIONS);
  const topLevelDecls = collectTopLevelDecls(ast);
  const statements = finalLabeledStatements(ast);
  if (statements.length > 0) {
    // Labels win over any stack() — Strudel's own rule, so a stack() sitting
    // inside a labeled statement is never split into per-branch tracks.
    return buildLabelTracks(statements, topLevelDecls);
  }
  return buildBranchTracks(unlabeledBranches(ast), topLevelDecls);
}

/** True for a top-level ExpressionStatement whose expression is `all(...)`/`each(...)`. */
function topLevelCallNamed(statement, name) {
  return (
    statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'CallExpression' &&
    statement.expression.callee.type === 'Identifier' &&
    statement.expression.callee.name === name
  );
}

/**
 * The body text of an async function that reproduces one track's own pattern in isolation —
 * "use strict"; every top-level VariableDeclaration/FunctionDeclaration/ClassDeclaration in
 * source order (so a shared `const` a track's chain reads is still defined); then
 * `return (<the track's own expression, wrapped by each()/all()>);`. Every other top-level
 * statement (setcpm, samples, hush, assignments, ...) is dropped, so none of them ever runs
 * again. A top-level `each(fn)` wraps the track first (only the LAST `each()` in the program —
 * Strudel keeps the last, the same rule a duplicate label follows); every top-level `all(fn)`
 * then wraps the result in turn, in SOURCE order, so the last `all()` ends up outermost —
 * mirroring the order Strudel itself applies them when combining labeled parts. String
 * literals are rewritten to `m(value, start)` throughout, in every kept span (see
 * collectStringEdits above), including inside an `all`/`each` function's own body.
 */
export function soloSource(code, trackIndex, { parse }) {
  const ast = parse(code, PARSE_OPTIONS);
  const statements = finalLabeledStatements(ast);
  const edits = [];
  collectStringEdits(ast, edits);

  const declarationTexts = [];
  const allCalls = [];
  let lastEachCall = null;
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration' || statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      declarationTexts.push(applyEdits(code, edits, statement.start, statement.end));
    } else if (topLevelCallNamed(statement, 'all')) {
      allCalls.push(statement.expression);
    } else if (topLevelCallNamed(statement, 'each')) {
      lastEachCall = statement.expression;
    }
  }

  const fnText = (callExpr) => {
    const fn = callExpr.arguments[0];
    return applyEdits(code, edits, fn.start, fn.end);
  };
  const wrapEachAll = (text) => {
    let wrapped = text;
    if (lastEachCall) wrapped = `(${fnText(lastEachCall)})(${wrapped})`;
    for (const allCall of allCalls) wrapped = `(${fnText(allCall)})(${wrapped})`;
    return wrapped;
  };

  let wrapped;
  if (statements.length > 0) {
    const track = statements[trackIndex];
    if (!track) {
      throw new Error(`Moontide: soloSource: no track at index ${trackIndex}.`);
    }
    const trackExpression = track.body.expression;
    wrapped = wrapEachAll(applyEdits(code, edits, trackExpression.start, trackExpression.end));
  } else {
    // No labels: the whole last expression is emitted once, with every OTHER branch's own
    // range replaced by the identifier `silence` — the chosen branch, and any chain wrapped
    // around the whole expression (e.g. an outer .gain(0), or a nested stack()'s own .fast(2)),
    // stays exactly as written, so the solo program still plays through the same transforms
    // the real pattern does.
    const { programExpr, entries } = unlabeledBranches(ast);
    const entry = entries[trackIndex];
    if (!programExpr || !entry) {
      throw new Error(`Moontide: soloSource: no track at index ${trackIndex}.`);
    }
    const others = entries.filter((_, index) => index !== trackIndex).map((e) => e.node);
    // A string edit fully inside a silenced branch is dropped with it: silence replaces the
    // whole span, so wrapping one of its own literals in m(...) as well would corrupt the splice.
    const keptEdits = edits.filter((edit) => !others.some((other) => edit.start >= other.start && edit.end <= other.end));
    const silenceEdits = others.map((other) => ({ start: other.start, end: other.end, text: 'silence' }));
    wrapped = wrapEachAll(applyEdits(code, [...keptEdits, ...silenceEdits], programExpr.start, programExpr.end));
  }

  let body = '"use strict";\n';
  for (const declarationText of declarationTexts) {
    body += declarationText + '\n';
  }
  body += `return (${wrapped});`;
  return body;
}
