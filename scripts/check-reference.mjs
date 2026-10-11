#!/usr/bin/env node
// Developer check of the reference against the pinned Strudel bundle: integrity, sub-package
// versions and every name used in reference/*.md (a guard rail).
// Node built-ins only (node:fs, node:path, node:url, node:crypto) plus Node 22 global fetch.
// Downloads are read as text only: this script never evaluates, runs or imports what it
// downloads — only string search and hashing.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// The pinned VCSL host and its manifest URL live in one place, page/ui-state.js
// so the pinned commit is visible in one place. This script imports them rather than keeping its
// own copy of the commit.
import { VCSL_MANIFEST_COMMIT, VCSL_MANIFEST_URL, VCSL_SAMPLE_BASE } from '../page/ui-state.js';
// The Mixer's hand-written registry: every method, alias and key pack in it is proven
// against the bundle below.
import { METHOD_KEYS } from '../page/mixer-registry.js';

/** Parses the pinned @strudel/repl script tag out of page/index.html's text. */
export function parsePin(html) {
  const scriptTagRe = /<script\b([^>]*)>/g;
  let match;
  let tagAttrs = null;
  while ((match = scriptTagRe.exec(html))) {
    if (match[1].includes('@strudel/repl@')) {
      tagAttrs = match[1];
      break;
    }
  }
  const srcMatch = tagAttrs ? /\bsrc\s*=\s*"([^"]+)"/.exec(tagAttrs) : null;
  const integrityMatch = tagAttrs ? /\bintegrity\s*=\s*"([^"]+)"/.exec(tagAttrs) : null;
  if (!srcMatch || !integrityMatch) {
    throw new Error('check:reference FAILED: could not find the @strudel/repl script tag in page/index.html');
  }
  const url = srcMatch[1];
  const versionMatch = /@strudel\/repl@([^/]+)\//.exec(url);
  return { version: versionMatch ? versionMatch[1] : '', url, integrity: integrityMatch[1] };
}

// Reserved words that can immediately precede "(" but are never a callable name.
const JS_KEYWORDS = new Set([
  'if', 'for', 'function', 'return', 'while', 'else', 'do', 'switch', 'case', 'catch', 'try',
  'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'var', 'let', 'const', 'class',
  'extends', 'super', 'this', 'void', 'delete', 'yield', 'async', 'await', 'import', 'export',
  'default', 'break', 'continue', 'debugger', 'with',
]);

// Built-in objects whose members are JS facts, not Strudel API surface.
const JS_GLOBALS = new Set(['Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Promise', 'console']);

// JS literals that read as an identifier but are never a Strudel API name.
const NON_API_LITERALS = new Set(['true', 'false', 'null', 'undefined']);

// Bare-name mentions that read as a real identifier but are documented as NOT part of the
// Strudel API — each with a one-line reason, so an exemption always states why (never because
// checking it is inconvenient). Mirrors the SYNTH_EXCLUSIONS pattern below, applied to prose
// instead of the sound palette.
const BARE_NAME_EXCLUSIONS = new Map([
  ['get_code', "this project's own MCP tool name (src/mcp.ts), not a Strudel API name"],
  ['phraseCycles', "an option of this project's own MCP tool set_code (src/mcp.ts), not a Strudel API name"],
  ['restore_version', "this project's own MCP tool name (src/mcp.ts), not a Strudel API name"],
  ['set_code', "this project's own MCP tool name (src/mcp.ts), not a Strudel API name"],
  [
    'whenmod',
    'tidal-differences.md documents that this Tidal function has no Strudel equivalent — the point of the sentence is its absence',
  ],
]);

function fencedJsBlocks(markdown) {
  const blocks = [];
  const re = /```js\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(markdown))) {
    blocks.push(match[1]);
  }
  return blocks;
}

function stripFencedBlocks(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

function inlineCodeSpans(markdown) {
  const spans = [];
  const re = /`([^`\n]+)`/g;
  let match;
  while ((match = re.exec(markdown))) {
    spans.push(match[1]);
  }
  return spans;
}

// Matches an optional receiver identifier immediately before a dotted method call — e.g.
// "Math.min(" (receiver "Math") or ".lpf(" after a call/value (receiver undefined, since
// nothing but the dot itself matches at that position).
const MEMBER_CALL_RE = /([A-Za-z_$][A-Za-z0-9_$]*)?\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
// A call not preceded by a dot or another identifier character.
const BARE_CALL_RE = /(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/** Strips block and line comments so prose inside them (e.g. "same as above (untagged...)") never looks like a call. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function collectCalledNames(rawText, names) {
  const text = stripComments(rawText);
  const memberRe = new RegExp(MEMBER_CALL_RE);
  let match;
  while ((match = memberRe.exec(text))) {
    const [, receiver, method] = match;
    if (JS_KEYWORDS.has(method)) continue;
    if (receiver && JS_GLOBALS.has(receiver)) continue;
    names.add(method);
  }
  const bareRe = new RegExp(BARE_CALL_RE);
  while ((match = bareRe.exec(text))) {
    const name = match[1];
    if (JS_KEYWORDS.has(name)) continue;
    names.add(name);
  }
}

// A whole inline-code span that is a single flat call with no nested parens — e.g.
// "struct(boolPattern)" or "slice(n, indexPattern)" from a function-signature doc line.
const SIGNATURE_CALL_RE = /^\.?[A-Za-z_$][A-Za-z0-9_$]*\(([^()]*)\)$/;

/**
 * Collects identifier-shaped argument names out of flat call spans (e.g. "boolPattern" out of
 * "struct(boolPattern)"). These are parameter placeholders a doc coins for its own signature, not
 * real API names, so a bare mention of one elsewhere in the same file's prose must not be checked.
 */
function collectSignatureParamNames(spans, names) {
  for (const span of spans) {
    const match = SIGNATURE_CALL_RE.exec(span);
    if (!match) continue;
    for (const rawArg of match[1].split(',')) {
      const arg = rawArg.trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg)) names.add(arg);
    }
  }
}

// A whole inline-code span that is nothing but a single identifier (optionally dot-prefixed, for
// a bare method mention like ".add"). Names under 3 characters are excluded: in these docs they
// are always a single-letter example variable (`n`, `s`, `fn`) or a filter prefix fragment (`hp`),
// never a full API name to verify.
const BARE_NAME_RE = /^\.?([a-z_$][A-Za-z0-9_$]{2,})$/;
// A lowercase letter run followed only by digits (e.g. "d1", "d2") — the shape of Tidal's numbered
// streams in tidal-differences.md, never a Strudel identifier.
const DIGIT_SUFFIX_RE = /^[a-z]+\d+$/;

/**
 * Collects bare (non-called) identifier mentions from inline code spans of prose — e.g. `tri` in
 * "`tri`, `sqr`, `saw` and `sin` are short aliases for ...". Skips JS literals, this file's own
 * signature-parameter placeholders, the explicit BARE_NAME_EXCLUSIONS, and short/uppercase/
 * digit-suffixed tokens (example variables, chord symbols like `Am`, Tidal streams like `d1`).
 */
function collectBareNames(spans, paramNames, names) {
  for (const span of spans) {
    const match = BARE_NAME_RE.exec(span);
    if (!match) continue;
    const name = match[1];
    if (NON_API_LITERALS.has(name)) continue;
    if (BARE_NAME_EXCLUSIONS.has(name)) continue;
    if (paramNames.has(name)) continue;
    if (DIGIT_SUFFIX_RE.test(name)) continue;
    names.add(name);
  }
}

/**
 * Scans ```js blocks and inline code spans of `markdown` (never ```tidal or ```names blocks) for
 * method calls, bare calls, and bare (non-called) identifier mentions in prose; drops JS keywords,
 * JS globals, any member called on a JS global, JS literals, this file's own signature-parameter
 * placeholders and the explicit BARE_NAME_EXCLUSIONS. Returns the unique names, sorted.
 */
export function extractCalledNames(markdown) {
  const names = new Set();
  for (const block of fencedJsBlocks(markdown)) {
    collectCalledNames(block, names);
  }
  const spans = inlineCodeSpans(stripFencedBlocks(markdown));
  for (const span of spans) {
    collectCalledNames(span, names);
  }
  const paramNames = new Set();
  collectSignatureParamNames(spans, paramNames);
  collectBareNames(spans, paramNames, names);
  return [...names].sort();
}

/**
 * True when `name` appears in `bundleText` as "name" or 'name', as an object key, as
 * .prototype.name=, or as function name( — never a bare substring match.
 */
export function nameInBundle(name, bundleText) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`"${escaped}"`),
    new RegExp(`'${escaped}'`),
    new RegExp(`[{,]\\s*${escaped}\\s*:`),
    new RegExp(`\\.prototype\\.${escaped}\\s*=`),
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`),
  ];
  return patterns.some((re) => re.test(bundleText));
}

/** 'sha384-' + base64 of the sha384 digest of `text`, matching an SRI integrity attribute. */
export function sriDigest(text) {
  return `sha384-${createHash('sha384').update(text, 'utf8').digest('base64')}`;
}

// --- Argument-count (arity) checking against register()ed methods ---
//
// register(name, fn) in @strudel/core sets Pattern.prototype[name] to a wrapper whose accepted
// argument count is governed by fn.length (JavaScript's own arity: the number of parameters
// before the first one with a default value or a rest parameter). The wrapper throws
// ".<name>() expects <fn.length - 1> inputs but got <n>." for any other count, except when
// fn.length === 2, which tolerates any count (extra arguments are wrapped in a sequence).
// These helpers read that arity straight from the bundle's own register() calls as text —
// never by executing the bundle.

/** Splits `text` on `sep` at bracket depth 0, respecting quoted strings. */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let current = '';
  let inString = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      current += c;
      if (c === '\\') {
        current += text[++i] ?? '';
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      current += c;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      current += c;
      continue;
    }
    if (c === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/** Index of the bracket in `text` (starting at `openIdx`, which holds `openChar`) that closes it, respecting quoted strings; -1 if unmatched. */
function matchBracket(text, openIdx, openChar, closeChar) {
  let depth = 0;
  let inString = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when `paramText` (one parameter, brackets already balanced within it) carries a default value at its own top level (not inside a nested destructure), excluding `=>`, `==`, `===`, `!=`, `<=`, `>=`. */
function hasTopLevelDefault(paramText) {
  let depth = 0;
  for (let i = 0; i < paramText.length; i++) {
    const c = paramText[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && depth === 0) {
      const prev = paramText[i - 1];
      const next = paramText[i + 1];
      if (next === '>' || next === '=') continue;
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
      return true;
    }
  }
  return false;
}

/** JavaScript's Function.length over a parameter-list source string: params before the first default/rest, in order. */
function computeArity(paramsText) {
  const trimmed = paramsText.trim();
  if (trimmed === '') return 0;
  let arity = 0;
  for (const rawPart of splitTopLevel(trimmed, ',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    if (part.startsWith('...')) break;
    if (hasTopLevelDefault(part)) break;
    arity++;
  }
  return arity;
}

/** Parses a register() first-argument literal — `"name"`, `'name'` or `["a","b"]` — into its names. */
function parseNamesLiteral(literal) {
  if (literal.startsWith('[')) {
    return [...literal.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  }
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(literal);
  return m ? [m[1] ?? m[2]] : [];
}

/**
 * Resolves the arity of the register() second argument starting at `pos` in `bundleText`: a
 * `function(params)` literal (named or anonymous), a `(params)=>` arrow, a bare `identifier=>`
 * single-param arrow, or a plain identifier reference resolved through `function name(params)`,
 * `name=function(params)` or `name=(params)=>` elsewhere in the same text. Returns null when no
 * shape matches or a referenced identifier has no resolvable definition.
 */
function resolveArity(bundleText, pos, seen = new Set()) {
  const rest = bundleText.slice(pos, pos + 400);

  let m = /^function\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(|^function\s*\(/.exec(rest);
  if (m) {
    const openIdx = pos + m[0].length - 1;
    const closeIdx = matchBracket(bundleText, openIdx, '(', ')');
    if (closeIdx === -1) return null;
    return computeArity(bundleText.slice(openIdx + 1, closeIdx));
  }

  if (rest[0] === '(') {
    const closeIdx = matchBracket(bundleText, pos, '(', ')');
    if (closeIdx !== -1 && bundleText.slice(closeIdx + 1).trimStart().startsWith('=>')) {
      return computeArity(bundleText.slice(pos + 1, closeIdx));
    }
  }

  m = /^[A-Za-z_$][A-Za-z0-9_$]*\s*=>/.exec(rest);
  if (m) return 1;

  m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/.exec(rest);
  if (m) {
    const identifier = m[1];
    if (seen.has(identifier)) return null; // cycle guard
    // `$` is a RegExp anchor and the capture above allows it in an identifier (e.g.
    // `f$1`), so the identifier must be escaped before it is built into a RegExp — the same
    // character class nameInBundle uses. `identifier` itself stays raw for the seen-guard and the
    // recursive calls below; only the RegExp source is escaped.
    const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const defRe = new RegExp(
      `function\\s+${escapedIdentifier}\\s*\\(|\\b${escapedIdentifier}\\s*=\\s*function\\s*\\(|\\b${escapedIdentifier}\\s*=\\s*\\(`,
    );
    const defMatch = defRe.exec(bundleText);
    if (!defMatch) return null;
    const nextSeen = new Set(seen).add(identifier);
    if (defMatch[0].trimStart().startsWith('function')) {
      return resolveArity(bundleText, defMatch.index, nextSeen);
    }
    const parenIdx = defMatch.index + defMatch[0].lastIndexOf('(');
    return resolveArity(bundleText, parenIdx, nextSeen);
  }

  return null;
}

// A register( call whose first argument is a name literal — never `function register(`, the
// declaration of register() itself, and never a recursive call like `register(se,e,l,d,p)`
// (identifier first argument, not a literal) inside register()'s own body.
const REGISTER_CALL_RE = /(?<!function )register\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')\s*,\s*/g;

/**
 * Reads every register(name, fn) call's arity straight from the bundle text (never by executing
 * it). Returns `{ arities, unresolved }`: `arities` maps each registered name to its
 * JavaScript Function.length; `unresolved` lists names whose second argument this text-only scan
 * could not resolve to a parameter list.
 */
export function registeredArities(bundleText) {
  const arities = {};
  const unresolved = [];
  const re = new RegExp(REGISTER_CALL_RE);
  let match;
  while ((match = re.exec(bundleText))) {
    const names = parseNamesLiteral(match[1]);
    const arity = resolveArity(bundleText, match.index + match[0].length);
    for (const name of names) {
      if (arity === null) unresolved.push(name);
      else arities[name] = arity;
    }
  }
  return { arities, unresolved };
}

// --- The Mixer's effect registry ---

// One `registerControl(keys, ...aliases)` call: the first argument is a key or an array of keys
// (a pack), the rest are alias names. Hard-coded: never built from downloaded text.
const REGISTER_CONTROL_RE = /registerControl\(\s*(\[[^\]]*\]|"[^"]*")((?:\s*,\s*"[^"]*")*)\s*\)/g;

/**
 * Every control method the bundle registers, read from its `registerControl` calls: a Map from each
 * method name (the first key, then every alias) to the keys the method can write. A plain number
 * writes only the first key; a string may write them all.
 */
export function registeredControls(bundleText) {
  const controls = new Map();
  const re = new RegExp(REGISTER_CONTROL_RE);
  let match;
  while ((match = re.exec(bundleText))) {
    const keys = [...match[1].matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1]);
    const aliases = [...match[2].matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1]);
    for (const name of [keys[0], ...aliases]) controls.set(name, keys);
  }
  return controls;
}

/**
 * The failures of the Mixer's registry against the bundle: a method or alias that is not a control
 * there, a key pack that differs, and a name that is not a control (`hush`, the signals) that the
 * bundle does not contain. `methodKeys` is page/mixer-registry.js's METHOD_KEYS.
 */
export function registryFailures(bundleText, { methodKeys, nonControlNames }) {
  const controls = registeredControls(bundleText);
  const failures = [];
  for (const [name, { keys }] of Object.entries(methodKeys)) {
    const bundleKeys = controls.get(name);
    if (!bundleKeys) {
      failures.push(`mixer registry: ${name} is not a control in the bundle`);
    } else if (bundleKeys.join(',') !== keys.join(',')) {
      failures.push(`mixer registry: ${name} writes ${keys.join(',')}, the bundle says ${bundleKeys.join(',')}`);
    }
  }
  for (const name of nonControlNames) {
    if (!nameInBundle(name, bundleText)) failures.push(`mixer registry: ${name} is not in the bundle`);
  }
  return failures;
}

// A dotted method call: an optional receiver character before the dot is irrelevant here (unlike
// extractCalledNames), since every call this function should see is a real method invocation.
const DOTTED_CALL_RE = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

function collectMethodCalls(text, calls) {
  const re = new RegExp(DOTTED_CALL_RE);
  let match;
  while ((match = re.exec(text))) {
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchBracket(text, openIdx, '(', ')');
    if (closeIdx === -1) continue;
    const argsText = text.slice(openIdx + 1, closeIdx).trim();
    let args = 0;
    if (argsText !== '') {
      const parts = splitTopLevel(argsText, ',');
      if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      args = parts.length;
    }
    calls.push({ name: match[1], args, snippet: text.slice(match.index, closeIdx + 1).slice(0, 80) });
  }
}

/**
 * Every `.name(...)` method call inside ```js fenced blocks and inline code spans of `markdown`
 * (never ```tidal blocks), as `{ name, args, snippet }`. `args` counts top-level arguments —
 * commas at bracket depth 0, outside quoted strings; an empty argument list is 0 and a trailing
 * comma adds nothing. `snippet` is the call text, cut at 80 characters.
 */
export function methodCalls(markdown) {
  const calls = [];
  for (const block of fencedJsBlocks(markdown)) {
    collectMethodCalls(stripComments(block), calls);
  }
  for (const span of inlineCodeSpans(stripFencedBlocks(markdown))) {
    collectMethodCalls(stripComments(span), calls);
  }
  return calls;
}

/**
 * Flags a method call whose argument count the page would refuse. A name registered with arity 2
 * tolerates any argument count (the bundle wraps extras in a sequence); any other registered
 * arity must receive exactly `arity - 1` arguments. A name in `registered.unresolved` always
 * fails (its arity could not be read from the bundle, so it must never pass silently). A name not
 * registered with register() at all (a control, a plain function) is not checked here.
 */
export function arityFailures(calls, registered, file) {
  const failures = [];
  for (const { name, args, snippet } of calls) {
    if (registered.unresolved.includes(name)) {
      failures.push(`${file}: .${name}(): cannot read its arity from the bundle`);
      continue;
    }
    const arity = registered.arities[name];
    if (arity === undefined || arity === 2) continue;
    const expected = arity - 1;
    if (args !== expected) {
      failures.push(`${file}: .${name}() takes ${expected} argument(s) in the page but the example passes ${args}: ${snippet}`);
    }
  }
  return failures;
}

// --- Chord symbols against the voicing dictionary, both directions ---

/** The chord tokenizer @strudel/tonal's renderVoicing() uses, written as a constant — never built from downloaded text. */
export const CHORD_SYMBOL_RE = /^([A-G][b#]*)([^/]*)[/]?([A-G][b#]*)?$/;

// The four alias-rule texts from @strudel/tonal's voicingAlias() call site, verbatim. Their
// presence is asserted before trusting the alias set computed below — if any changes, the pin
// has moved and chordVocabulary must return null rather than compute a stale alias set.
const VOICING_ALIAS_RULE_TEXTS = [
  'voicingAlias("^","",[simple,complex])',
  'if(o.includes("-")){let e=o.replace("-","m");',
  'if(o.includes("^")){let e=o.replace("^","M");',
  'if(o.includes("+")){let e=o.replace("+","aug");',
];

/** Top-level (bracket-depth-0) keys of an already bracket-matched `{...}` object literal, read as text — never JSON.parse'd (bare keys like `2:` are not valid JSON) and never eval'd. */
function objectTopLevelKeys(literal) {
  const inner = literal.slice(1, -1);
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '[' || c === '(' || c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === ']' || c === ')' || c === '}') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === '"') {
        const m = /^"((?:[^"\\]|\\.)*)"/.exec(inner.slice(i));
        if (!m) return null;
        keys.push(m[1]);
        i += m[0].length;
        while (i < inner.length && inner[i] !== ':') i++;
        i++; // skip ':'
        continue;
      }
      const m = /^([^,:[\](){}]+):/.exec(inner.slice(i));
      if (m) {
        keys.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return keys;
}

/**
 * Bracket-matched text of the default ("ireal") voicing dictionary object literal, found via
 * `registerVoicings("ireal", <identifier>)` and the identifier's own `={...}` assignment — read
 * as text, never JSON.parse'd as a whole (bare keys like `2:` are not valid JSON) and never
 * eval'd. Returns null when either marker is missing (the pin has moved). Shared by
 * `chordVocabulary` and the bare-chord prose claim, which both need the same dictionary
 * text — one for its keys, the other for one entry's own voicing value.
 */
function iRealDictionaryLiteral(bundleText) {
  const registerMatch = /registerVoicings\(\s*"ireal"\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/.exec(bundleText);
  if (!registerMatch) return null;
  const marker = `${registerMatch[1]}={`;
  const idx = bundleText.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length - 1;
  const end = matchBracket(bundleText, start, '{', '}');
  if (end === -1) return null;
  return bundleText.slice(start, end + 1);
}

/**
 * Reads the default ("ireal") voicing dictionary straight from the bundle text (see
 * `iRealDictionaryLiteral`). Confirms the four alias-rule texts are present verbatim, then
 * computes `aliases` by applying each rule once to each original key exactly as the bundle does
 * (String.replace's first-occurrence-only semantics, matching the bundle's own
 * `.replace(char, char)` calls). Returns `{ keys, aliases, accepted }` (`accepted` = keys ∪
 * aliases ∪ the empty suffix), or null when the literal or any alias-rule text is missing (the
 * pin has moved).
 */
export function chordVocabulary(bundleText) {
  const literal = iRealDictionaryLiteral(bundleText);
  if (!literal) return null;

  const keys = objectTopLevelKeys(literal);
  if (!keys) return null;

  for (const ruleText of VOICING_ALIAS_RULE_TEXTS) {
    if (!bundleText.includes(ruleText)) return null;
  }

  const aliases = new Set();
  for (const key of keys) {
    if (key.includes('-')) aliases.add(key.replace('-', 'm'));
    if (key.includes('^')) aliases.add(key.replace('^', 'M'));
    if (key.includes('+')) aliases.add(key.replace('+', 'aug'));
  }

  return { keys: new Set(keys), aliases, accepted: new Set([...keys, ...aliases, '']) };
}

// Mini-notation structure characters that separate chord-symbol tokens (never '/', handled
// separately below so a slash-bass chord like C/E stays one token).
const CHORD_STRUCTURE_CHAR_RE = /[<>[\]{}(),|@!?*%:]|\s/;

function chordStringTokens(content, tokens) {
  let normalized = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '/') {
      normalized += /[0-9]/.test(content[i + 1] ?? '') ? ' ' : '/';
      continue;
    }
    normalized += CHORD_STRUCTURE_CHAR_RE.test(c) ? ' ' : c;
  }
  for (const token of normalized.split(/\s+/)) {
    if (token === '' || token === '~' || token === '-' || token === '_') continue;
    if (/^\d+$/.test(token)) continue;
    tokens.push(token);
  }
}

// A double-quoted or backtick string passed directly to chord(.
const CHORD_ARG_RE = /\bchord\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g;
// A double-quoted or backtick string literal immediately followed by .voicing(.
const VOICING_STRING_RE = /(["`])((?:(?!\1)[^\\]|\\.)*)\1\s*\.voicing\(/g;

/**
 * The step tokens of every double-quoted or backtick string passed to `chord(` and of every such
 * string literal immediately followed by `.voicing(`, inside ```js blocks (comments stripped).
 * Splits on whitespace and the mini-notation structure characters `< > [ ] { } ( ) , | @ ! ? * %
 * :`, drops rests (`~`, `-`, `_`) and plain numbers. A slash-bass token such as `C/E` stays whole
 * — `/` only splits when followed by a digit (a slow factor).
 */
export function chordSymbols(markdown) {
  const tokens = [];
  for (const block of fencedJsBlocks(markdown)) {
    const text = stripComments(block);
    for (const re of [CHORD_ARG_RE, VOICING_STRING_RE]) {
      const scoped = new RegExp(re);
      let match;
      while ((match = scoped.exec(text))) {
        chordStringTokens(match[2], tokens);
      }
    }
  }
  return tokens;
}

/**
 * Flags a chord symbol the page's chord tokenizer would refuse or whose suffix the voicing
 * dictionary does not accept. `+` always fails even when it is a literal dictionary key, because
 * `+` is not a mini-notation step character and so can never actually appear in a chord() string
 * the page would parse — the dictionary key exists only for the `aug` alias to be built from.
 */
export function chordFailures(symbols, vocabulary, file) {
  const failures = [];
  for (const token of symbols) {
    const match = CHORD_SYMBOL_RE.exec(token);
    const suffix = match ? match[2] ?? '' : null;
    if (!match || token.includes('+') || !vocabulary.accepted.has(suffix)) {
      failures.push(`${file}: chord symbol not accepted by the page: ${token}`);
    }
  }
  return failures;
}

// --- Note-name tokens inside note() ---

/** The note tokenizer @strudel/core's noteToMidi() uses, written as a constant — never built from downloaded text. */
export const NOTE_NAME_RE = /^([a-gA-G])([#bsf]*)(-?[0-9]*)$/;

// A double-quoted or backtick string passed directly to note(.
const NOTE_ARG_RE = /\bnote\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g;

/**
 * The step tokens of every double-quoted or backtick string passed to `note(` in ```js blocks
 * (comments stripped) — split the same way chordSymbols splits its strings (whitespace and
 * mini-notation structure characters, slash-bass kept whole, rests and plain numbers dropped).
 */
export function noteTokens(markdown) {
  const tokens = [];
  for (const block of fencedJsBlocks(markdown)) {
    const text = stripComments(block);
    const re = new RegExp(NOTE_ARG_RE);
    let match;
    while ((match = re.exec(text))) {
      chordStringTokens(match[2], tokens);
    }
  }
  return tokens;
}

/**
 * Flags a `note()` token that is not a plain (optionally negative) number, not a rest (`~`, `-`,
 * `_`), and does not match NOTE_NAME_RE — a chord symbol such as `Cm7` or leftover Tidal chord
 * syntax such as `c4'min7` both fail this way, matching the page's own "not a note" error.
 */
export function noteFailures(tokens, file) {
  const failures = [];
  for (const token of tokens) {
    if (token === '~' || token === '-' || token === '_') continue;
    if (/^-?\d+$/.test(token)) continue;
    if (!NOTE_NAME_RE.test(token)) {
      failures.push(`${file}: not a note name inside note(): ${token}`);
    }
  }
  return failures;
}

// --- Mini-notation grammar check ---
//
// Parses no grammar and runs no parser generator: this reads the pinned @strudel/mini grammar's
// own text for the characters a step accepts, the characters that structure a sequence, and
// whitespace, then checks every example string in reference/*.md against that character set and
// checks its brackets balance and nest. Not a full parse of the mini-notation language — it
// catches the class of error the listening test hit (a character the grammar never accepts, or
// brackets that could never close), not every structural mistake a real parse would catch.

// The exact rule-description text of the step_char rule, confirmed present in the downloaded
// grammar before trusting the alternatives text that follows it on the next line (a pin change
// here needs a new look at this check, so it fails loudly instead of silently parsing nothing).
const STEP_CHAR_RULE_CANARY =
  'step_char "a letter, a number, \\"-\\", \\"#\\", \\".\\", \\"^\\", \\"_\\"" =';
// The ws rule's own bracket-class body, e.g. `[ \n\r\t\u00A0]`.
const WS_RULE_RE = /ws\s+"whitespace"\s*=\s*\[([^\]]*)\]\*/;
// The two section markers between which every single-character literal is a structural
// mini-notation character (delimiters, brackets, operators) — never the "mini-notation innards"
// that follow (the experimental Haskell-ish operator parser, not part of a `note()`/`s()`/
// `chord()` string).
const MINI_DELIMITERS_MARKER = '// ------------------ delimiters ---------------------------';
const MINI_INNARDS_END_MARKER = '// Mini-notation innards ends';

/**
 * Unescapes one character at `text[i]` of a peg.js bracket-class body: `\n` `\r` `\t` `\uXXXX` or
 * a literal character. Returns `{ char, length }` (the number of source characters consumed).
 */
function unescapeBracketChar(text, i) {
  if (text[i] !== '\\') return { char: text[i], length: 1 };
  const next = text[i + 1];
  if (next === 'n') return { char: '\n', length: 2 };
  if (next === 'r') return { char: '\r', length: 2 };
  if (next === 't') return { char: '\t', length: 2 };
  if (next === 'u') return { char: String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)), length: 6 };
  return { char: next, length: 2 };
}

/** Parses a peg.js bracket-class body (already stripped of its surrounding `[` `]`) into individual characters and `a-z`-style ranges. */
function parseBracketClassBody(body) {
  const chars = new Set();
  const ranges = [];
  let i = 0;
  while (i < body.length) {
    const first = unescapeBracketChar(body, i);
    i += first.length;
    if (body[i] === '-' && i + 1 < body.length && body[i + 1] !== ']') {
      i += 1;
      const second = unescapeBracketChar(body, i);
      i += second.length;
      ranges.push([first.char, second.char]);
    } else {
      chars.add(first.char);
    }
  }
  return { chars, ranges };
}

function bracketClassTest({ chars, ranges }) {
  return (ch) => chars.has(ch) || ranges.some(([lo, hi]) => ch >= lo && ch <= hi);
}

/**
 * Reads the pinned mini-notation grammar's own accepted characters straight from its text — step
 * characters (`unicode_letter`, a bracket class such as `[0-9~]`, and quoted single characters)
 * from the `step_char` rule; whitespace from the `ws` rule's bracket class; structural characters
 * from every single-character literal between the delimiters marker and the "Mini-notation
 * innards ends" marker, excluding the `quote` rule's own two literals. Never executes or compiles
 * the grammar — string search and character-class parsing only. Returns `{ isStepChar(ch),
 * structural, whitespace }`, or null when a marker or rule this needs is missing, or when `+` or
 * an apostrophe would end up in the step or structural sets (the check below treats those two
 * specially, so a grammar where they became ordinary characters needs a new look at it first).
 */
export function miniGrammar(grammarText) {
  const stepCharIdx = grammarText.indexOf(STEP_CHAR_RULE_CANARY);
  if (stepCharIdx === -1) return null;
  const afterCanary = grammarText.slice(stepCharIdx + STEP_CHAR_RULE_CANARY.length);
  const blankIdx = afterCanary.indexOf('\n\n');
  if (blankIdx === -1) return null;
  const altsText = afterCanary.slice(0, blankIdx);

  let hasUnicodeLetter = false;
  let bracketTest = null;
  const quotedStepChars = new Set();
  for (const rawAlt of splitTopLevel(altsText, '/')) {
    const alt = rawAlt.trim();
    if (alt === '') continue;
    if (alt === 'unicode_letter') {
      hasUnicodeLetter = true;
      continue;
    }
    const bracketMatch = /^\[(.*)\]$/.exec(alt);
    if (bracketMatch) {
      bracketTest = bracketClassTest(parseBracketClassBody(bracketMatch[1]));
      continue;
    }
    const quotedMatch = /^"(.)"$|^'(.)'$/.exec(alt);
    if (quotedMatch) {
      quotedStepChars.add(quotedMatch[1] ?? quotedMatch[2]);
      continue;
    }
    return null; // an alternative shape this check does not recognize — the pin has moved
  }
  if (!hasUnicodeLetter || !bracketTest) return null;

  const wsMatch = WS_RULE_RE.exec(grammarText);
  if (!wsMatch) return null;
  const whitespace = parseBracketClassBody(wsMatch[1]).chars;

  const delimitersIdx = grammarText.indexOf(MINI_DELIMITERS_MARKER);
  const innardsEndIdx = grammarText.indexOf(MINI_INNARDS_END_MARKER);
  if (delimitersIdx === -1 || innardsEndIdx === -1 || innardsEndIdx <= delimitersIdx) return null;
  const section = grammarText.slice(delimitersIdx, innardsEndIdx);
  const structural = new Set();
  const literalRe = /"([^"\\])"|'([^'\\])'/g;
  let literalMatch;
  while ((literalMatch = literalRe.exec(section))) {
    structural.add(literalMatch[1] ?? literalMatch[2]);
  }
  // The quote rule's own two literals ('"' and "'", used to delimit a whole mini-notation string,
  // never appear inside one) are not structural characters within a string.
  structural.delete('"');
  structural.delete("'");

  if (quotedStepChars.has('+') || structural.has('+')) return null;
  if (quotedStepChars.has("'") || structural.has("'")) return null;

  const isStepChar = (ch) => /\p{L}/u.test(ch) || bracketTest(ch) || quotedStepChars.has(ch);

  return { isStepChar, structural, whitespace };
}

// A double-quoted or backtick string literal — never single-quoted, since single-quoted strings
// stay plain JavaScript strings in Strudel (reference/tidal-differences.md "Strings") and are
// never mini-notation.
const MINI_STRING_RE = /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

/**
 * Every double-quoted string and untagged backtick string inside ```js fenced blocks of
 * `markdown` (comments stripped first, escaped quotes handled by the regex's own alternation), as
 * `{ text, block }`. Inline code spans and ```tidal blocks are never scanned — prose may show a
 * Tidal form on purpose.
 */
export function miniStrings(markdown) {
  const strings = [];
  for (const block of fencedJsBlocks(markdown)) {
    const text = stripComments(block);
    const re = new RegExp(MINI_STRING_RE);
    let match;
    while ((match = re.exec(text))) {
      const raw = match[1] ?? match[2];
      strings.push({ text: raw.replace(/\\(.)/g, '$1'), block: text });
    }
  }
  return strings;
}

const MINI_BRACKET_PAIRS = { '[': ']', '{': '}', '<': '>', '(': ')' };
const MINI_BRACKET_CLOSERS = new Set(Object.values(MINI_BRACKET_PAIRS));

/**
 * True when `text[index]` is a `+` sitting in the grammar's only accepted use of it — a number
 * exponent (a digit, then `e` or `E`, then `+`, then a digit), as in `1e+3`.
 */
function isNumberExponentPlus(text, index) {
  const prev1 = text[index - 1];
  const prev2 = text[index - 2];
  const next = text[index + 1];
  return (prev1 === 'e' || prev1 === 'E') && prev2 !== undefined && /[0-9]/.test(prev2) && /[0-9]/.test(next ?? '');
}

/**
 * Flags a mini-notation example string on two independent grounds — a character and bracket
 * check derived from the grammar, not a full parse:
 * - the first character that is not whitespace, not a step character (per `grammar.isStepChar`)
 *   and not structural (per `grammar.structural`) — except `+`, accepted only as a number
 *   exponent (see `isNumberExponentPlus`);
 * - `[ ]`, `{ }`, `< >` and `( )` that do not balance and nest.
 */
export function miniFailures(strings, grammar, file) {
  const failures = [];
  for (const { text } of strings) {
    let offendingIndex = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (grammar.whitespace.has(ch) || grammar.isStepChar(ch) || grammar.structural.has(ch)) continue;
      if (ch === '+' && isNumberExponentPlus(text, i)) continue;
      offendingIndex = i;
      break;
    }
    if (offendingIndex !== -1) {
      failures.push(
        `${file}: mini-notation string holds ${text[offendingIndex]} (character ${offendingIndex + 1}), which the pinned grammar never accepts: ${text}`,
      );
      continue;
    }
    const stack = [];
    let unbalanced = false;
    for (const ch of text) {
      const closer = MINI_BRACKET_PAIRS[ch];
      if (closer) {
        stack.push(closer);
      } else if (MINI_BRACKET_CLOSERS.has(ch)) {
        if (stack.pop() !== ch) {
          unbalanced = true;
          break;
        }
      }
    }
    if (stack.length > 0) unbalanced = true;
    if (unbalanced) {
      failures.push(`${file}: mini-notation string has unbalanced brackets: ${text}`);
    }
  }
  return failures;
}

// --- Prose claims against the bundle's own defaults and patterns ---
//
// Ten facts the listening test proved can drift: each compares a value or pattern read from the
// bundle's own text against the exact sentence(s) reference/*.md state about it. Every bundle
// pattern and reference pattern is hard-coded in this file — never built from downloaded text.

function claimFailure(id, what) {
  return `${id}: cannot find ${what} in the bundle (the pin changed?)`;
}

function fileMissingClaim(file, id) {
  return `${file}: no longer states ${id} in the checked form`;
}

function fileMismatch(file, stated, actual) {
  return `${file}: says ${stated}, the page uses ${actual}`;
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// --- default-octave ---

const NOTE_TO_MIDI_RE = /noteToMidi(?:\$\d+)?=\([^,]*,\s*[A-Za-z_$][A-Za-z0-9_$]*=(\d+)\)/g;
const DEFAULT_OCTAVE_REF_RE = /the octave is (\d+) when none is written/;

function defaultOctaveClaim(bundleText, texts, claim) {
  const octaves = new Set([...bundleText.matchAll(NOTE_TO_MIDI_RE)].map((m) => m[1]));
  if (octaves.size !== 1) return [claimFailure(claim.id, "noteToMidi's default octave")];
  const [bundleOctave] = octaves;
  const failures = [];
  for (const file of claim.files) {
    const match = DEFAULT_OCTAVE_REF_RE.exec(texts[file] ?? '');
    if (!match) {
      failures.push(fileMissingClaim(file, claim.id));
    } else if (match[1] !== bundleOctave) {
      failures.push(fileMismatch(file, `the octave is ${match[1]} when none is written`, `octave ${bundleOctave}`));
    }
  }
  return failures;
}

// --- accidentals ---

// Only the $-suffixed forms (accs$1, accs$2 — one per duplicated copy of @strudel/tonal's note
// parser in the bundle): a third, unrelated bare `accs={b:-1,"#":1}` backs chord-root pitch-class
// spelling (pc2chroma) elsewhere in the bundle and has only two keys, never a note accidental.
const ACCS_OBJECT_RE = /accs\$\d+=\{([^}]*)\}/g;
const ACCS_ENTRY_RE = /(?:"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*:\s*(-?\d+)/g;
const ACCIDENTALS_REF_RE = /a sharp is `([^`]+)` or `([^`]+)`, a flat is `([^`]+)` or `([^`]+)`/;

function accidentalsFromObjectText(objectText) {
  const sharps = new Set();
  const flats = new Set();
  for (const [, quoted, bare, value] of objectText.matchAll(ACCS_ENTRY_RE)) {
    const key = quoted ?? bare;
    if (value === '1') sharps.add(key);
    else if (value === '-1') flats.add(key);
  }
  return { sharps, flats };
}

function accidentalsClaim(bundleText, texts, claim) {
  const objects = [...bundleText.matchAll(ACCS_OBJECT_RE)].map((m) => accidentalsFromObjectText(m[1]));
  if (objects.length === 0) return [claimFailure(claim.id, 'an accidental-value (accs) object')];
  const [first, ...rest] = objects;
  const consistent = rest.every((o) => sameSet(o.sharps, first.sharps) && sameSet(o.flats, first.flats));
  if (!consistent) return [claimFailure(claim.id, 'a single consistent accidental-value (accs) object')];

  const failures = [];
  for (const file of claim.files) {
    const match = ACCIDENTALS_REF_RE.exec(texts[file] ?? '');
    if (!match) {
      failures.push(fileMissingClaim(file, claim.id));
      continue;
    }
    const statedSharps = new Set([match[1], match[2]]);
    const statedFlats = new Set([match[3], match[4]]);
    if (!sameSet(statedSharps, first.sharps) || !sameSet(statedFlats, first.flats)) {
      failures.push(
        fileMismatch(
          file,
          `a sharp is ${match[1]}/${match[2]}, a flat is ${match[3]}/${match[4]}`,
          `a sharp is ${[...first.sharps].join('/')}, a flat is ${[...first.flats].join('/')}`,
        ),
      );
    }
  }
  return failures;
}

// --- chord-root ---

const CHORD_ROOT_REF_RE =
  /A chord root is an uppercase letter `A` to `G` with an optional `([^`]+)` or `([^`]+)`/;

function chordRootClaim(bundleText, texts, claim) {
  if (!bundleText.includes(CHORD_SYMBOL_RE.source)) {
    return [claimFailure(claim.id, "the page's chord tokenizer (CHORD_SYMBOL_RE)")];
  }
  const rootClassMatch = /\[A-G\]\[([^\]]+)\]/.exec(CHORD_SYMBOL_RE.source);
  if (!rootClassMatch) return [claimFailure(claim.id, "CHORD_SYMBOL_RE's root accidental class")];
  const accidentals = new Set(rootClassMatch[1].split(''));

  const failures = [];
  for (const file of claim.files) {
    const match = CHORD_ROOT_REF_RE.exec(texts[file] ?? '');
    if (!match) {
      failures.push(fileMissingClaim(file, claim.id));
      continue;
    }
    if (!sameSet(new Set([match[1], match[2]]), accidentals)) {
      failures.push(
        fileMismatch(file, `an optional ${match[1]} or ${match[2]}`, `an optional ${[...accidentals].join(' or ')}`),
      );
    }
  }
  return failures;
}

// --- bare-chord ---

const BARE_CHORD_THIRDS = new Set(['3M', '10M']);
const BARE_CHORD_SEVENTHS = new Set(['7m', '7M', '14m', '14M']);
const BARE_CHORD_REF_PHRASE = 'a bare letter with no suffix is a major triad';
// The false claim this guards against ("not a major seventh") — a specific
// forbidden phrase, the same pattern as ARRANGE_FORBIDDEN_PHRASE below, not a generic word
// co-occurrence: theory.md's true sentence itself names "the older seventh-chord convention" in
// the same breath as "bare letter", so flagging any sentence holding both words would misfire on
// the correct text.
const BARE_CHORD_FORBIDDEN_PHRASE = 'a bare letter with no suffix is a major seventh';

function firstDictionaryEntryVoicing(dictionaryLiteral, key) {
  const marker = `"${key}":[`;
  const idx = dictionaryLiteral.indexOf(marker);
  if (idx === -1) return null;
  const stringMatch = /^"((?:[^"\\]|\\.)*)"/.exec(dictionaryLiteral.slice(idx + marker.length));
  return stringMatch ? stringMatch[1] : null;
}

function bareChordClaim(bundleText, texts, claim) {
  if (!bundleText.includes('voicingAlias("^","",')) {
    return [claimFailure(claim.id, 'the ^-to-empty-suffix voicingAlias call')];
  }
  const dictionaryLiteral = iRealDictionaryLiteral(bundleText);
  const voicing = dictionaryLiteral ? firstDictionaryEntryVoicing(dictionaryLiteral, '^') : null;
  if (!voicing) return [claimFailure(claim.id, "the ireal dictionary's ^ entry")];
  const tokens = voicing.trim().split(/\s+/);
  const hasThird = tokens.some((t) => BARE_CHORD_THIRDS.has(t));
  const hasSeventh = tokens.some((t) => BARE_CHORD_SEVENTHS.has(t));
  if (!hasThird || hasSeventh) {
    return [claimFailure(claim.id, 'a major-triad, no-seventh ^ voicing')];
  }

  const failures = [];
  const theoryText = texts['theory.md'] ?? '';
  if (!theoryText.includes(BARE_CHORD_REF_PHRASE)) {
    failures.push(fileMissingClaim('theory.md', claim.id));
  }
  if (theoryText.includes(BARE_CHORD_FORBIDDEN_PHRASE)) {
    failures.push(fileMismatch('theory.md', BARE_CHORD_FORBIDDEN_PHRASE, 'a major triad with no seventh'));
  }
  return failures;
}

// --- voicing-defaults ---

const RENDER_VOICING_SIGNATURE_RE = /function\s+renderVoicing\(\{/;
const DEFAULT_DICT_RE = /defaultDict\s*=\s*"([^"]+)"/;
const VOICING_DEFAULTS_REF_RE = /The defaults are dictionary `([^`]+)`, mode `([^`]+)`, anchor `([^`]+)`/;

function voicingDefaultsClaim(bundleText, texts, claim) {
  const sigMatch = RENDER_VOICING_SIGNATURE_RE.exec(bundleText);
  if (!sigMatch) return [claimFailure(claim.id, 'the renderVoicing function signature')];
  const openIdx = sigMatch.index + sigMatch[0].length - 1;
  const closeIdx = bundleText.indexOf('}', openIdx); // the destructured-param brace; no nested { } within it
  const params = closeIdx === -1 ? '' : bundleText.slice(openIdx, closeIdx);
  const modeMatch = /mode:[A-Za-z_$][A-Za-z0-9_$]*="([^"]+)"/.exec(params);
  const anchorMatch = /anchor:[A-Za-z_$][A-Za-z0-9_$]*="([^"]+)"/.exec(params);
  const dictMatch = DEFAULT_DICT_RE.exec(bundleText);
  if (!modeMatch || !anchorMatch || !dictMatch) {
    return [claimFailure(claim.id, "renderVoicing's default mode/anchor or defaultDict")];
  }

  const failures = [];
  const theoryText = texts['theory.md'] ?? '';
  const match = VOICING_DEFAULTS_REF_RE.exec(theoryText);
  if (!match) {
    failures.push(fileMissingClaim('theory.md', claim.id));
  } else if (match[1] !== dictMatch[1] || match[2] !== modeMatch[1] || match[3] !== anchorMatch[1]) {
    failures.push(
      fileMismatch(
        'theory.md',
        `dictionary ${match[1]}, mode ${match[2]}, anchor ${match[3]}`,
        `dictionary ${dictMatch[1]}, mode ${modeMatch[1]}, anchor ${anchorMatch[1]}`,
      ),
    );
  }
  return failures;
}

// --- arrange-repeats ---

const ARRANGE_FN_TEXT =
  'function arrange(...o){const e=o.reduce((l,[d])=>l+d,0);return o=o.map(([l,d])=>[l,d.fast(l)]),stepcat(...o).slow(e)}';
const ARRANGE_REPEATS_LINE_RE = /arrange.*repeats/;
const ARRANGE_FORBIDDEN_PHRASE = 'once through';

function arrangeRepeatsClaim(bundleText, texts, claim) {
  if (!bundleText.includes(ARRANGE_FN_TEXT)) {
    return [claimFailure(claim.id, "arrange()'s function text")];
  }
  const failures = [];
  for (const file of claim.files) {
    const text = texts[file] ?? '';
    const hasLine = text.split('\n').some((line) => ARRANGE_REPEATS_LINE_RE.test(line));
    if (!hasLine) failures.push(fileMissingClaim(file, claim.id));
  }
  for (const [file, text] of Object.entries(texts)) {
    if (text.includes(ARRANGE_FORBIDDEN_PHRASE)) {
      failures.push(fileMismatch(file, ARRANGE_FORBIDDEN_PHRASE, 'repeats every total number of cycles'));
    }
  }
  return failures;
}

// --- default-tempo ---

const CYCLIST_CANARY = 'class Cyclist{constructor(';
const CYCLIST_CPS_RE = /this\.cps=([\d.]+)/;
const TEMPO_TIDAL_REF_RE = /starts at ([\d.]+) cycles per second/;
const TEMPO_TRANSITIONS_REF_RE = /one cycle lasts ([\d.]+) seconds at the default ([\d.]+) cycles per second/;

function defaultTempoClaim(bundleText, texts, claim) {
  const cyclistIdx = bundleText.indexOf(CYCLIST_CANARY);
  if (cyclistIdx === -1) return [claimFailure(claim.id, 'the Cyclist class')];
  const cpsMatch = CYCLIST_CPS_RE.exec(bundleText.slice(cyclistIdx, cyclistIdx + 2000));
  if (!cpsMatch) return [claimFailure(claim.id, "the Cyclist constructor's default this.cps")];
  const bundleCps = parseFloat(cpsMatch[1]);

  const failures = [];
  const tidalText = texts['tidal-differences.md'] ?? '';
  const tidalMatch = TEMPO_TIDAL_REF_RE.exec(tidalText);
  if (!tidalMatch) {
    failures.push(fileMissingClaim('tidal-differences.md', claim.id));
  } else if (parseFloat(tidalMatch[1]) !== bundleCps) {
    failures.push(
      fileMismatch('tidal-differences.md', `starts at ${tidalMatch[1]} cycles per second`, `starts at ${bundleCps} cycles per second`),
    );
  }

  const transitionsText = texts['transitions.md'] ?? '';
  const transitionsMatch = TEMPO_TRANSITIONS_REF_RE.exec(transitionsText);
  if (!transitionsMatch) {
    failures.push(fileMissingClaim('transitions.md', claim.id));
  } else {
    const [, statedSeconds, statedCps] = transitionsMatch;
    const expectedSeconds = 1 / bundleCps;
    if (parseFloat(statedCps) !== bundleCps || parseFloat(statedSeconds) !== expectedSeconds) {
      failures.push(
        fileMismatch(
          'transitions.md',
          `one cycle lasts ${statedSeconds} seconds at the default ${statedCps} cycles per second`,
          `one cycle lasts ${expectedSeconds} seconds at the default ${bundleCps} cycles per second`,
        ),
      );
    }
  }
  return failures;
}

// --- solo-label ---

// The bundle's own two label rules, read from its text: a registered label longer than one character
// that starts with a capital S puts the program in solo mode, and Pattern#p returns silence for a
// label that starts or ends with an underscore (never registering it). The line reference/*.md
// state about them is checked by its own wording (the rule and the underscore exception on one
// line, since the dot never crosses a newline), and so is the server instruction in src/mcp.ts
// (read as text, never imported): its single-quoted string must state the underscore exception,
// so a comment repeating the words does not satisfy it. All regexes are hard-coded, never built
// from downloaded or read text.
const SOLO_LABEL_RULE_RE = /\w+\.length>1&&\w+\.startsWith\("S"\)/;
const MUTE_LABEL_RULE_RE = /startsWith\("_"\)\|\|\w+\.endsWith\("_"\)/;
const SOLO_LABEL_LINE_RE = /starts with a capital `S` plays alone.*also starts or ends with `_` is silenced instead/;
const SOLO_LABEL_INSTRUCTION_FILE = 'src/mcp.ts';
const SOLO_LABEL_INSTRUCTION_RE =
  /'A label longer than one character that starts with a capital S plays alone, unless it also ends with an underscore, which silences it instead/;

function soloLabelClaim(bundleText, texts, claim) {
  if (!SOLO_LABEL_RULE_RE.test(bundleText)) {
    return [claimFailure(claim.id, "the rule that a label longer than one character starting with S plays alone")];
  }
  if (!MUTE_LABEL_RULE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the rule that a label starting or ending with an underscore is silenced')];
  }
  const failures = [];
  for (const file of claim.files) {
    const text = texts[file] ?? '';
    const stated = file === SOLO_LABEL_INSTRUCTION_FILE ? SOLO_LABEL_INSTRUCTION_RE : SOLO_LABEL_LINE_RE;
    if (!stated.test(text)) failures.push(fileMissingClaim(file, claim.id));
  }
  return failures;
}

// --- delaytime-seconds ---

// The bundle reads `delaytime` as seconds: its value is destructured from the hap as `delaytime:X` and,
// when absent, becomes `X=X??cycleToSeconds(delaysync, cps)`, a time in seconds derived from the tempo.
// Both regexes are hard-coded to the pinned bundle's real shape (verified against @strudel/repl@1.3.0),
// never built from downloaded text.
const DELAYTIME_DEFAULT_RE = /delaytime:(\w+)[\s\S]{0,1500}?\1=\1\?\?cycleToSeconds\(/;
const DELAYTIME_SECONDS_LINE_RE = /delaytime.*seconds/;
const DELAYTIME_FORBIDDEN_PHRASE = 'delay time in cycles';

function delaytimeSecondsClaim(bundleText, texts, claim) {
  if (!DELAYTIME_DEFAULT_RE.test(bundleText)) {
    return [claimFailure(claim.id, "delaytime's default, a time in seconds derived from the tempo (cycleToSeconds)")];
  }
  const failures = [];
  for (const file of claim.files) {
    const text = texts[file] ?? '';
    if (!text.split('\n').some((line) => DELAYTIME_SECONDS_LINE_RE.test(line))) failures.push(fileMissingClaim(file, claim.id));
  }
  for (const [file, text] of Object.entries(texts)) {
    if (text.toLowerCase().includes(DELAYTIME_FORBIDDEN_PHRASE)) {
      failures.push(fileMismatch(file, DELAYTIME_FORBIDDEN_PHRASE, 'a delay time in seconds'));
    }
  }
  return failures;
}

// --- string-forms ---

// Which JavaScript string forms the transpiler turns into mini-notation, read from the bundle's own
// text: a Literal whose raw text starts with a double quote, and any TemplateLiteral that is not the
// quasi of a tagged template, are replaced by a mini call; the backtick branch reads only the first
// quasi (the text before the first `${`); and reify() parses a plain string only through a string
// parser that the bundle never sets (miniAllStrings, the only setter, is declared and never called),
// so a single-quoted string reaches a pattern function as one value while mini() (exported by the mini
// module) parses a built string. The regexes are hard-coded to the pinned bundle's real shape (verified
// against @strudel/repl@1.3.0), never built from downloaded text. The runtime behavior itself is proven
// in the real page by the probe's "string forms: " checks.
const DOUBLE_QUOTE_RULE_RE = /function isStringWithDoubleQuotes\(\w+(?:,\w+)*\)\{return \w+\.type!=="Literal"\?!1:\w+\.raw\[0\]==='"'\}/;
const DOUBLE_QUOTE_USE_RE = /if\(isStringWithDoubleQuotes\(\w+\)\)\{[^}]{0,120}\}=\w+;return this\.skip\(\),[^}]{0,80}this\.replace\(miniWithLocation\(/;
const BACKTICK_RULE_RE = /function isBackTickString\(\w+,\w+\)\{return \w+\.type==="TemplateLiteral"&&\w+\.type!=="TaggedTemplateExpression"\}/;
const BACKTICK_FIRST_QUASI_RE = /if\(isBackTickString\(\w+,\w+\)\)\{[^}]{0,120}const\{quasis:(\w+)\}=\w+,\{raw:(\w+)\}=\1\[0\]\.value;[^}]{0,80}miniWithLocation\(\2,/;
const REIFY_STRING_PARSER_RE = /function reify\((\w+)\)\{return isPattern\(\1\)\?\1:(\w+)&&typeof \1=="string"\?\2\(\1\):pure\(\1\)\}/;
const MINI_FUNCTION_RE = /\bmini\$1=\(\.\.\.(\w+)\)=>\{const \w+=\1\.map\(\w+=>\{const \w+=`"\$\{\w+\}"`,\w+=mini2ast\(/;
const MINI_EXPORT_RE = /\bmini:mini\$1\b/;
// Any call of miniAllStrings (a declaration is `function miniAllStrings(`) would switch the runtime string parser on.
const MINI_ALL_STRINGS_CALL_RE = /(?<!function )\bminiAllStrings\(/;
const STRING_FORMS_LINE_RES = [
  /Double-quoted strings and untagged backtick strings are mini-notation, parsed as patterns; single-quoted strings stay plain JavaScript strings/,
  /including one inside a helper function that only builds or joins text and one in a function that never runs, so its text must be valid mini-notation on its own, or the whole evaluation fails with a `\[mini\] parse error`/,
  /A backtick string keeps only the text before its first `\$\{`, and the rest is dropped without an error/,
  /stays one value, not a sequence of events, even when built with `\+` or `\.join\(' '\)`, and `mini\(\)` parses such a built string as mini-notation/,
];

function stringFormsClaim(bundleText, texts, claim) {
  if (!DOUBLE_QUOTE_RULE_RE.test(bundleText) || !DOUBLE_QUOTE_USE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the rule that a double-quoted string is turned into mini-notation')];
  }
  if (!BACKTICK_RULE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the rule that an untagged backtick string is turned into mini-notation')];
  }
  if (!BACKTICK_FIRST_QUASI_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the backtick branch reading only the text before the first ${')];
  }
  if (!REIFY_STRING_PARSER_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'reify parsing a string only through a string parser that may be unset')];
  }
  if (MINI_ALL_STRINGS_CALL_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'a bundle that never calls miniAllStrings (a runtime string parser is switched on)')];
  }
  if (!MINI_FUNCTION_RE.test(bundleText) || !MINI_EXPORT_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'mini(), which parses its string arguments as mini-notation, exported as mini')];
  }
  const failures = [];
  for (const file of claim.files) {
    const text = texts[file] ?? '';
    if (!STRING_FORMS_LINE_RES.every((re) => re.test(text))) failures.push(fileMissingClaim(file, claim.id));
  }
  return failures;
}

// --- MIDI claims ---

// The MIDI facts reference/midi.md states about .midi() in the pinned bundle. Every bundle pattern and
// every reference sentence below is a hard-coded constant, never built from downloaded text; each was
// confirmed against @strudel/repl@1.3.0. A claim whose bundle evidence is missing names itself with
// claimFailure; a claim whose sentence is missing or reworded names its file with fileMissingClaim.

/** Returns the claim's failure when any of `sentenceRes` is missing from reference/midi.md. */
function midiSentenceFailures(claim, texts, sentenceRes) {
  const failures = [];
  for (const file of claim.files) {
    const text = texts[file] ?? '';
    if (!sentenceRes.every((re) => re.test(text))) failures.push(fileMissingClaim(file, claim.id));
  }
  return failures;
}

// --- midi-port-quotes ---

// .midi() throws when its port is a Pattern (a double-quoted string is turned into a mini-notation
// pattern by the transpiler, see string-forms), and its message names the single-quote form.
const MIDI_PORT_PATTERN_REFUSAL_RE =
  /if\(isPattern\(\w+\)\)throw new Error\(`\.midi does not accept Pattern input for midiport\. Make sure to pass device name with single quotes\./;
const MIDI_PORT_QUOTES_SENTENCE_RES = [
  /Write the port name in single quotes: `\.midi\('port name'\)`\./,
  /A double-quoted port name is a mini-notation pattern, and `\.midi\(\)` refuses it with the error `\.midi does not accept Pattern input for midiport`\./,
];

function midiPortQuotesClaim(bundleText, texts, claim) {
  if (!MIDI_PORT_PATTERN_REFUSAL_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the .midi() refusal of a Pattern port')];
  }
  if (!DOUBLE_QUOTE_RULE_RE.test(bundleText) || !DOUBLE_QUOTE_USE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the rule that a double-quoted string is turned into mini-notation')];
  }
  return midiSentenceFailures(claim, texts, MIDI_PORT_QUOTES_SENTENCE_RES);
}

// --- midi-port-match ---

// getDevice: a string port is found with Array#find and String#includes (part of an output name,
// case-sensitive, first match in the list); with no port the first output whose name includes "IAC"
// is used, else the first output.
const MIDI_PORT_MATCH_RE =
  /const (\w+)=(\w+)=>(\w+)\.find\((\w+)=>\4\.name\.includes\(\2\)\);if\(typeof (\w+)=="string"\)return \1\(\5\);const (\w+)=\1\("IAC"\),(\w+)=\6\?\?\3\[0\]/;
const MIDI_PORT_MATCH_SENTENCE_RES = [
  /The port name is matched as part of an output name, case-sensitive, and the first output in the browser's list whose name contains it is used\./,
  /With no port, the first output whose name contains `IAC` is used, else the first output\./,
];

function midiPortMatchClaim(bundleText, texts, claim) {
  if (!MIDI_PORT_MATCH_RE.test(bundleText)) {
    return [claimFailure(claim.id, "getDevice's substring match on the output name and its IAC default")];
  }
  return midiSentenceFailures(claim, texts, MIDI_PORT_MATCH_SENTENCE_RES);
}

// --- the defaults object of .midi() (midi-channel, midi-gain-velocity, midi-note-length) ---

// `.midi(port, options)` merges `options` over one defaults object; each claim reads only its own key
// from it, so a change to one default names one claim.
const MIDI_DEFAULTS_OBJECT_RE = /\{isController:!1,([^{}]*),midiport:\w+,\.\.\.\w+\}/;

function midiDefault(bundleText, keyRe) {
  const object = MIDI_DEFAULTS_OBJECT_RE.exec(bundleText);
  if (!object) return null;
  const match = keyRe.exec(object[1]);
  return match ? match[1] : null;
}

// --- midi-channel ---

const MIDI_CHANNEL_DEFAULT_RE = /(?:^|,)midichannel:(\d+)(?:,|$)/;
const MIDI_CHANNEL_SENTENCE_RE =
  /The channel is the `midichannel` option, 1 to 16, and it is (\d+) when none is given: `\.midi\('port name', \{ midichannel: 2 \}\)`\./;

function midiChannelClaim(bundleText, texts, claim) {
  const channel = midiDefault(bundleText, MIDI_CHANNEL_DEFAULT_RE);
  if (channel === null) return [claimFailure(claim.id, "the default midichannel in .midi()'s options")];
  const failures = [];
  for (const file of claim.files) {
    const match = MIDI_CHANNEL_SENTENCE_RE.exec(texts[file] ?? '');
    if (!match) failures.push(fileMissingClaim(file, claim.id));
    else if (match[1] !== channel) failures.push(fileMismatch(file, match[1], channel));
  }
  return failures;
}

// --- midi-ccv-range ---

const MIDI_CCV_RANGE_RE =
  /if\(typeof (\w+)!="number"\|\|\1<0\|\|\1>1\)throw new Error\("expected ccv to be a number between 0 and 1"\);[\s\S]{0,200}?const \w+=Math\.round\(\1\*127\)/;
const MIDI_CCV_SENTENCE_RES = [
  /`ccn\(n\)` sets the controller number and `ccv\(x\)` its value, a number from 0 to 1, sent as `x \* 127` rounded; a value outside 0 to 1 is an error\./,
];

function midiCcvRangeClaim(bundleText, texts, claim) {
  if (!MIDI_CCV_RANGE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the ccv range check (0 to 1) and its scaling by 127')];
  }
  return midiSentenceFailures(claim, texts, MIDI_CCV_SENTENCE_RES);
}

// --- midi-prognum-range ---

const MIDI_PROGNUM_RANGE_RE =
  /if\(typeof (\w+)!="number"\|\|\1<0\|\|\1>127\)throw new Error\("expected progNum \(program change\) to be a number between 0 and 127"\)/;
const MIDI_PROGNUM_SENTENCE_RES = [/`progNum\(n\)` sends a program change, 0 to 127\./];

function midiPrognumRangeClaim(bundleText, texts, claim) {
  if (!MIDI_PROGNUM_RANGE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the progNum range check (0 to 127)')];
  }
  return midiSentenceFailures(claim, texts, MIDI_PROGNUM_SENTENCE_RES);
}

// --- midi-same-instant ---

// sendNote and sendProgramChange each schedule their own callback at the time they are given, and
// .midi()'s trigger gives both the same time value: two callbacks at one instant, in no fixed order.
const MIDI_SEND_NOTE_SCHEDULE_RE =
  /function sendNote\((\w+),(\w+),(\w+),(\w+),(\w+),(\w+)\)\{[\s\S]{0,600}?scheduleAtTime\(\(\)=>\{\4\.playNote\(\w+,\5\)\},\6\)\}/;
const MIDI_SEND_PROGRAM_SCHEDULE_RE =
  /function sendProgramChange\((\w+),(\w+),(\w+),(\w+)\)\{[\s\S]{0,300}?scheduleAtTime\(\(\)=>\{\2\.sendProgramChange\(\1,\3\)\},\4\)\}/;
const MIDI_SAME_TIME_CALLS_RE = /sendNote\(\w+,\w+,\w+,(\w+),(\w+),(\w+)\)\}if\(\w+!==void 0&&sendProgramChange\(\w+,\1,\2,\3\)/;
const MIDI_SAME_INSTANT_SENTENCE_RES = [
  /A program change and a note at the same instant go out in no fixed order, so a program change inside a pattern can cut or change the note it shares an instant with; a sound chosen at an instant where the track plays no note cannot cut one, which is why sounds are chosen before notes\./,
];

function midiSameInstantClaim(bundleText, texts, claim) {
  if (!MIDI_SEND_NOTE_SCHEDULE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'sendNote scheduling the note-on at the time it is given')];
  }
  if (!MIDI_SEND_PROGRAM_SCHEDULE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'sendProgramChange scheduling the program change at the time it is given')];
  }
  if (!MIDI_SAME_TIME_CALLS_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the note and the program change sent with the same time value')];
  }
  return midiSentenceFailures(claim, texts, MIDI_SAME_INSTANT_SENTENCE_RES);
}

// --- midi-gain-velocity ---

// The trigger destructures gain (default 1) and velocity (default the option), multiplies them
// (`vn=bn*vn`), and sendNote refuses a velocity above 1. The 0.9 default is read from the defaults object.
const MIDI_VELOCITY_DEFAULT_RE = /(?:^|,)velocity:(\d*\.?\d+)(?:,|$)/;
const MIDI_GAIN_MULTIPLIES_RE = /gain:(\w+)=\w+\.gain,velocity:(\w+)=\w+\.velocity[\s\S]{0,600}?if\(\2=\1\*\2,/;
const MIDI_VELOCITY_ERROR_RE =
  /function sendNote\((\w+),(\w+),[\s\S]{0,300}?if\(\2!=null&&\(typeof \2!="number"\|\|\2<0\|\|\2>1\)\)throw new Error\("velocity must be a number between 0 and 1"\)/;
const MIDI_VELOCITY_SENTENCE_RE =
  /`velocity` is 0 to 1 and is (\d+(?:\.\d+)?) when none is given; on a MIDI track `\.gain\(\)` multiplies the velocity, so it changes how hard a note is played, not the volume of the instrument\./;
const MIDI_VELOCITY_ERROR_SENTENCE_RE = /A velocity that goes above 1 after the multiplication by `\.gain\(\)` is an error\./;

function midiGainVelocityClaim(bundleText, texts, claim) {
  const velocity = midiDefault(bundleText, MIDI_VELOCITY_DEFAULT_RE);
  if (velocity === null) return [claimFailure(claim.id, "the default velocity in .midi()'s options")];
  if (!MIDI_GAIN_MULTIPLIES_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the velocity multiplied by the gain')];
  }
  if (!MIDI_VELOCITY_ERROR_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the error for a velocity outside 0 to 1')];
  }
  const failures = [];
  for (const file of claim.files) {
    const text = texts[file] ?? '';
    const match = MIDI_VELOCITY_SENTENCE_RE.exec(text);
    if (!match || !MIDI_VELOCITY_ERROR_SENTENCE_RE.test(text)) failures.push(fileMissingClaim(file, claim.id));
    else if (String(Number(match[1])) !== String(Number(velocity))) {
      failures.push(fileMismatch(file, String(Number(match[1])), String(Number(velocity))));
    }
  }
  return failures;
}

// --- midi-note-length ---

// `clip` and `legato` are one control; a Hap's duration is multiplied by its clip value; .midi() sends
// the note with a length of that duration in milliseconds minus the noteOffsetMs default.
const MIDI_CLIP_LEGATO_RE = /\{clip:\w+(?:\$\d+)?,legato\}=registerControl\("clip","legato"\)/;
const MIDI_HAP_DURATION_CLIP_RE = /typeof this\.value\?\.clip=="number"\?\w+\.mul\(this\.value\.clip\):\w+/;
const MIDI_NOTE_LENGTH_RE = /const \w+=\w+\.duration\.valueOf\(\)\/\w+\*1e3-\w+\.noteOffsetMs;sendNote\(/;
const MIDI_NOTE_OFFSET_DEFAULT_RE = /(?:^|,)noteOffsetMs:(\d+)(?:,|$)/;
const MIDI_NOTE_LENGTH_SENTENCE_RE = /A note lasts its event's length, times `legato` \(or `clip`\) when set, minus (\d+) ms\./;

function midiNoteLengthClaim(bundleText, texts, claim) {
  if (!MIDI_CLIP_LEGATO_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'legato registered as the clip control')];
  }
  if (!MIDI_HAP_DURATION_CLIP_RE.test(bundleText)) {
    return [claimFailure(claim.id, "a Hap's duration multiplied by its clip value")];
  }
  if (!MIDI_NOTE_LENGTH_RE.test(bundleText)) {
    return [claimFailure(claim.id, "the note length sent by .midi() (the event duration in milliseconds minus noteOffsetMs)")];
  }
  const offset = midiDefault(bundleText, MIDI_NOTE_OFFSET_DEFAULT_RE);
  if (offset === null) return [claimFailure(claim.id, "the default noteOffsetMs in .midi()'s options")];
  const failures = [];
  for (const file of claim.files) {
    const match = MIDI_NOTE_LENGTH_SENTENCE_RE.exec(texts[file] ?? '');
    if (!match) failures.push(fileMissingClaim(file, claim.id));
    else if (match[1] !== offset) failures.push(fileMismatch(file, `${match[1]} ms`, `${offset} ms`));
  }
  return failures;
}

// --- midi-note-off ---

// The note's length goes into the Note, and webmidi's playNote sends the note-on and then a note-off
// timestamped at the note-on time plus that duration, so the note-off is already in the browser's MIDI
// queue when the note-on goes out: Strudel itself cannot end a note early, and on a repeated pitch an
// earlier note-off lands inside a later overlapping note. That part is proven from the bundle. The last
// sentence of the reference, that the Moontide page ends the notes of a muted, solo-silenced or removed
// track, is the page's own behavior (page/midi-out.js, probe:midi): only its wording is pinned here.
const MIDI_NOTE_DURATION_RE = /function sendNote\((\w+),(\w+),(\w+),[\s\S]{0,600}?new Note\(\w+,\{attack:\2,duration:\3\}\)/;
const MIDI_PLAY_NOTE_OFF_RE =
  /playNote\((\w+),(\w+)=\{\}\)\{this\.sendNoteOn\(\1,\2\);const (\w+)=Array\.isArray\(\1\)\?\1:\[\1\];for\(let (\w+) of \3\)if\(parseInt\(\4\.duration\)>0\)\{const (\w+)=\{time:\(Utilities\.toTimestamp\(\2\.time\)\|\|wm\.time\)\+parseInt\(\4\.duration\),release:\4\.release,rawRelease:\4\.rawRelease\};this\.sendNoteOff\(\4,\5\)\}/;
const MIDI_NOTE_OFF_SENTENCE_RES = [
  /Each note-on goes out with its note-off already timed for the note's end, so Strudel itself cannot end a note early\./,
  /For the same reason `legato` above 1 on a repeated pitch is cut: the earlier note's note-off ends the next note of the same pitch\./,
  /The Moontide page ends the notes of a track that is muted, silenced by a solo or removed: it sends a sustain release and All Notes Off on that track's channel when no other track plays there, and a note-off for each of the track's sounding notes when one does\./,
];

function midiNoteOffClaim(bundleText, texts, claim) {
  if (!MIDI_NOTE_DURATION_RE.test(bundleText)) {
    return [claimFailure(claim.id, "the note's length passed into the Note that sendNote plays")];
  }
  if (!MIDI_PLAY_NOTE_OFF_RE.test(bundleText)) {
    return [claimFailure(claim.id, "playNote's note-off timed at the note-on time plus the note's duration")];
  }
  return midiSentenceFailures(claim, texts, MIDI_NOTE_OFF_SENTENCE_RES);
}

// --- midi-dominant ---

// A hap whose context carries a dominant trigger skips the default (browser) output. onTrigger marks
// the hap dominant unless its second argument is false, and .midi() calls it with a single argument.
const MIDI_ON_TRIGGER_DOMINANT_RE =
  /onTrigger\((\w+),(\w+)=!0\)\{return this\.withHap\((\w+)=>\3\.setContext\(\{\.\.\.\3\.context,onTrigger:\(\.\.\.(\w+)\)=>\{\3\.context\.onTrigger\?\.\(\.\.\.\4\),\1\(\.\.\.\4\)\},dominantTrigger:\3\.context\.dominantTrigger\|\|\2\}\)\)\}/;
const MIDI_GET_TRIGGER_RE = /\(!(\w+)\.context\.onTrigger\|\|!\1\.context\.dominantTrigger\)&&await (\w+)\(\1,/;
const MIDI_TRIGGER_START_RE = /this\.onTrigger\(\(\w+,\w+,\w+,\w+\)=>\{if\(!WebMidi\.enabled\)\{/;
const MIDI_TRIGGER_END_RE = /sendSysex\(\w+,\w+,\w+,\w+\)\}\}\}\)\};async function _initialize\(/;
const MIDI_DOMINANT_SENTENCE_RES = [
  /A track with `\.midi\(\)` plays nothing in the browser, so browser sounds and effects on it \(`s`, `lpf`, `room`, `delay`\) do nothing\./,
];

function midiDominantClaim(bundleText, texts, claim) {
  if (!MIDI_ON_TRIGGER_DOMINANT_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'onTrigger marking a hap as dominant unless told otherwise')];
  }
  if (!MIDI_GET_TRIGGER_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the default output skipped for a hap with a dominant trigger')];
  }
  if (!MIDI_TRIGGER_START_RE.test(bundleText) || !MIDI_TRIGGER_END_RE.test(bundleText)) {
    return [claimFailure(claim.id, '.midi() registering its trigger with onTrigger and no second argument')];
  }
  return midiSentenceFailures(claim, texts, MIDI_DOMINANT_SENTENCE_RES);
}

// --- midi-unknown-option-keys ---

// .midi() spreads its options object last into one settings object (MIDI_DEFAULTS_OBJECT_RE) and each
// event is read with one destructure of the hap value inside the trigger; neither names a `sound`
// or a `controls` key, so those options change nothing in Strudel. The Moontide page reads both from
// the code (its own behavior, pinned here by wording only).
const MIDI_HAP_VALUE_RE = /logger[\w$]*\("Midi not enabled"\);return\}\w+\.ensureObjectValue\(\);let\{([^{}]*)\}=\w+\.value;/;
const MIDI_UNKNOWN_OPTION_KEYS_SENTENCE_RES = [
  /`\.midi\(\)` ignores option keys it does not know: its options object is spread into its settings and each note reads only the keys Strudel defines, so a `sound` or `controls` key changes nothing in Strudel\./,
  /The Moontide page reads `sound` when the user has described instruments in instruments\.json: `\.midi\('port name', \{ midichannel: 3, sound: 'sound name' \}\)` makes the page send that instrument's program change before the new code plays, and get_midi_instruments lists each instrument's sounds\./,
  /The Moontide page also reads `controls` when the user has described instruments in instruments\.json: `\.midi\('port name', \{ midichannel: 3, controls: \{ volume: 100 \} \}\)` sets one static level per control of that instrument, in the control's own range, and the page sends it before the new code plays\. Control ids and ranges come from get_midi_instruments; a control that leaves the code goes back to the instrument's default; a sweep stays `ccn` and `ccv`\./,
];

function midiUnknownOptionKeysClaim(bundleText, texts, claim) {
  if (!MIDI_DEFAULTS_OBJECT_RE.test(bundleText)) {
    return [claimFailure(claim.id, "the options object of .midi() spread last into its settings")];
  }
  const destructure = MIDI_HAP_VALUE_RE.exec(bundleText);
  if (!destructure) {
    return [claimFailure(claim.id, "the destructure of the hap value in .midi()'s trigger")];
  }
  const keys = destructure[1].split(',').map((entry) => /^[\w$]+/.exec(entry.trim())?.[0]);
  for (const key of ['sound', 'controls']) {
    if (keys.includes(key)) {
      return [`${claim.id}: the pinned .midi() trigger reads a "${key}" key of the hap value, so a ${key} option no longer changes nothing in Strudel`];
    }
  }
  return midiSentenceFailures(claim, texts, MIDI_UNKNOWN_OPTION_KEYS_SENTENCE_RES);
}

// --- midi-note-required (13.1) ---

// .midi()'s trigger sends a note only when the `note` it destructured from the hap value is defined and
// the call is not a controller (`let{note:X,...}` then `X!==void 0&&!cfg.isController){`, the same
// variable by backreference). An `n` or `s` key in that destructure would mean n() or s() alone may now
// send notes, so the reference sentence would be false. That `n()` works once `.scale()` has turned it
// into notes (reference/theory.md), and that a General MIDI instrument has its drums on channel 10, are
// facts of the theory topic and of the MIDI standard, not of this bundle: only their wording is pinned.
const MIDI_NOTE_GATE_RE = /let\{note:([\w$]+),[\s\S]{0,3000}?[^\w$]\1!==void 0&&!\w+\.isController\)\{/;
const MIDI_NOTE_REQUIRED_SENTENCE_RES = [
  /A note goes out only for an event that has a `note` value: `s\("bd hh sd hh"\)\.midi\('port name'\)` and a bare `n\("36 42"\)\.midi\('port name'\)` send no notes; `n\(\)` works only once `\.scale\(\)` has turned it into notes \(reference\/theory\.md\)\./,
  /A drum track for a MIDI instrument therefore writes note numbers, such as the General MIDI drum notes 36, 38 and 42, on the instrument's drum channel \(10 on a General MIDI instrument\):/,
];

function midiNoteRequiredClaim(bundleText, texts, claim) {
  const destructure = MIDI_HAP_VALUE_RE.exec(bundleText);
  if (!destructure) {
    return [claimFailure(claim.id, "the destructure of the hap value in .midi()'s trigger")];
  }
  const keys = destructure[1].split(',').map((entry) => /^[\w$]+/.exec(entry.trim())?.[0]);
  if (!keys.includes('note')) {
    return [claimFailure(claim.id, "the note key of the hap value in .midi()'s trigger")];
  }
  for (const key of ['n', 's']) {
    if (keys.includes(key)) {
      return [`${claim.id}: the pinned .midi() trigger reads an "${key}" key of the hap value, so ${key}() alone may now send notes`];
    }
  }
  if (!MIDI_NOTE_GATE_RE.test(bundleText)) {
    return [claimFailure(claim.id, 'the check that sends a note only for a defined note value')];
  }
  return midiSentenceFailures(claim, texts, MIDI_NOTE_REQUIRED_SENTENCE_RES);
}

// --- midi clock (14) ---

// Moontide owns the MIDI clock (reference/midi.md "## Clock"): page/midi-clock.js reads the page's plain
// Cyclist (the scheduler the editor builds when `sync` is off): its constructor fields, the tempo anchor
// rule (the first tick after a tempo change fixes the cycle and the time of the new tempo), the hap time
// formula, setCps, now and stop. These are exactly the fields that module reads, so a @strudel/repl pin
// change must re-verify page/midi-clock.js (the e2e pin test says so). Every pattern is a hard-coded
// constant, each confirmed against @strudel/repl@1.3.0.
const CYCLIST_CTOR_RE = /this\.started=!1,this\.beforeStart=\w+,this\.cps=\.5,this\.num_ticks_since_cps_change=0,this\.lastTick=0,this\.lastBegin=0,this\.lastEnd=0,this\.getTime=\w+,this\.num_cycles_at_cps_change=0,this\.seconds_at_cps_change,this\.onToggle=\w+,this\.latency=\w+/;
const CYCLIST_ANCHOR_RE = /this\.num_ticks_since_cps_change===0&&\(this\.num_cycles_at_cps_change=this\.lastEnd,this\.seconds_at_cps_change=\w+\),this\.num_ticks_since_cps_change\+\+/;
const CYCLIST_HAP_TIME_RE = /\(\w+\.whole\.begin-this\.num_cycles_at_cps_change\)\/this\.cps\+this\.seconds_at_cps_change\+\w+/;
const CYCLIST_SET_CPS_RE = /setCps\((\w+)=\.5\)\{this\.cps!==\1&&\(this\.cps=\1,this\.num_ticks_since_cps_change=0\)\}/;
const CYCLIST_NOW_RE = /now\(\)\{if\(!this\.started\)return 0;const (\w+)=this\.getTime\(\)-this\.lastTick-this\.clock\.duration;return this\.lastBegin\+\1\*this\.cps\}/;
const CYCLIST_STOP_RE = /stop\(\)\{[^}]*this\.lastEnd=0,this\.setStarted\(!1\)\}/;
const EDITOR_PLAIN_CYCLIST_RE = /sync=!1;solo=!0/;
const MIDI_CLOCK_SENTENCE_RES = [
  /Moontide sends MIDI clock, Start and Stop itself to each instrument that follows the clock \(get_midi_instruments says which ones\), while the playing code names that instrument in a `\.midi\(\)` call\./,
  /The clock counts 4 beats per cycle, 24 ticks per beat, so 96 ticks per cycle: a tempo of N beats per minute is `setcpm\(N\/4\)`, and a tempo change in the code moves the clock with it\./,
];

function midiClockCyclistClaim(bundleText, texts, claim) {
  const shapes = [
    [CYCLIST_CTOR_RE, "the Cyclist's constructor fields"],
    [CYCLIST_ANCHOR_RE, "the Cyclist's tempo anchor"],
    [CYCLIST_HAP_TIME_RE, "the Cyclist's hap time formula"],
    [CYCLIST_SET_CPS_RE, "the Cyclist's setCps"],
    [CYCLIST_NOW_RE, "the Cyclist's now()"],
    [CYCLIST_STOP_RE, "the Cyclist's stop()"],
    [EDITOR_PLAIN_CYCLIST_RE, "the editor's plain-Cyclist default"],
  ];
  for (const [re, what] of shapes) {
    if (!re.test(bundleText)) return [claimFailure(claim.id, what)];
  }
  return midiSentenceFailures(claim, texts, MIDI_CLOCK_SENTENCE_RES);
}

// --- midi-transport (14) ---

// .midi()'s trigger can produce a transport message only as a Start at cycle 0 (every hap whose
// whole.begin is 0) or from a `midicmd` of clock/midiClock, start, stop or continue. The page's guard
// (page/midi-out.js) drops those four status bytes, so the reference tells Claude never to write them.
const MIDI_TRANSPORT_RE = /\w+\.whole\.begin\+0===0&&scheduleAtTime\(\(\)=>\{\w+\.sendStart\(\)\},\w+\),\["clock","midiClock"\]\.includes\(\w+\)\)scheduleAtTime\(\(\)=>\{\w+\.sendClock\(\)\},\w+\);else if\(\["start"\]\.includes\(\w+\)\)scheduleAtTime\(\(\)=>\{\w+\.sendStart\(\)\},\w+\);else if\(\["stop"\]\.includes\(\w+\)\)scheduleAtTime\(\(\)=>\{\w+\.sendStop\(\)\},\w+\);else if\(\["continue"\]\.includes\(\w+\)\)scheduleAtTime\(\(\)=>\{\w+\.sendContinue\(\)\},\w+\)/;
const MIDI_TRANSPORT_SENTENCE_RES = [
  /The code never writes clock or transport: a `midicmd` of `clock`, `midiClock`, `start`, `stop` or `continue` is dropped before it reaches a port, and so is the Start Strudel sends on every MIDI track at cycle 0\./,
];

function midiTransportClaim(bundleText, texts, claim) {
  if (!MIDI_TRANSPORT_RE.test(bundleText)) {
    return [claimFailure(claim.id, "the transport sends of .midi()'s trigger")];
  }
  return midiSentenceFailures(claim, texts, MIDI_TRANSPORT_SENTENCE_RES);
}

// --- midi-trigger-seam (16) ---

// What page/midi-out.js (installNoteStamps) relies on to send notes ahead with a timestamp: .midi() registers a
// four-parameter trigger with onTrigger (the fourth is the hap's target time); the trigger looks its device up in
// WebMidi.outputs at every trigger (so the per-call proxies reach every send); it hands that device and that
// time to every send helper; each helper calls a method of the device from scheduleAtTime at that time (so
// moving the time moves every send); scheduleAtTime runs its callback from a Web Audio timer at the time given;
// and webmidi's Output.send hands its time option to the native port. Note, program change and transport sends are
// pinned by midi-same-instant and midi-transport. Bundle-only: no reference sentence states this, so the claim
// guards the page's code and not a statement made to Claude. Each pattern is hard-coded with generic names.
const MIDI_SEAM_TRIGGER_RE = /this\.onTrigger\(\(\w+,\w+,\w+,\w+\)=>\{if\(!WebMidi\.enabled\)\{/;
const MIDI_SEAM_DEVICE_RE = /const \w+=getDevice\(\w+,WebMidi\.outputs\);/;
const MIDI_SEAM_CALLS_RE =
  /sendSysex\(\w+,\w+,(\w+),(\w+)\),\w+!==void 0&&\w+!==void 0&&sendCC\(\w+,\w+,\1,\w+,\2\),\w+!==void 0&&\w+!==void 0&&sendNRPN\(\w+,\w+,\1,\w+,\2\),\w+!==void 0&&sendPitchBend\(\w+,\1,\w+,\2\),\w+!==void 0&&sendAftertouch\(\w+,\1,\w+,\2\)/;
const MIDI_SEAM_SYSEX_RE = /function sendSysex\((\w+),(\w+),(\w+),(\w+)\)\{[\s\S]{0,500}?scheduleAtTime\(\(\)=>\{\3\.sendSysex\(\1,\2\)\},\4\)\}/;
const MIDI_SEAM_NRPN_RE = /function sendNRPN\((\w+),(\w+),(\w+),(\w+),(\w+)\)\{[\s\S]{0,400}?scheduleAtTime\(\(\)=>\{\3\.sendNRPN\(\1,\2,\4\)\},\5\)\}/;
const MIDI_SEAM_BEND_RE = /function sendPitchBend\((\w+),(\w+),(\w+),(\w+)\)\{[\s\S]{0,200}?scheduleAtTime\(\(\)=>\{\2\.sendPitchBend\(\1,\3\)\},\4\)\}/;
const MIDI_SEAM_TOUCH_RE = /function sendAftertouch\((\w+),(\w+),(\w+),(\w+)\)\{[\s\S]{0,200}?scheduleAtTime\(\(\)=>\{\2\.sendChannelAftertouch\(\1,\3\)\},\4\)\}/;
const MIDI_SEAM_CC_RE = /scheduleAtTime\(\(\)=>\{\w+\.sendControlChange\(\w+,\w+,\w+\)\},\w+\)/;
const MIDI_SEAM_TIMER_RE = /function scheduleAtTime\((\w+),(\w+),(\w+)=getAudioContext\(\)\)\{const (\w+)=\3\.currentTime;webAudioTimeout\(\3,\1,\4,\2\)\}/;
const MIDI_SEAM_SEND_RE = /return this\._midiOutput\.send\((\w+),Utilities\.toTimestamp\((\w+)\.time\)\),this\}/;

function midiTriggerSeamClaim(bundleText, texts, claim) {
  const shapes = [
    [MIDI_SEAM_TRIGGER_RE, 'the .midi() trigger registered with onTrigger and four parameters'],
    [MIDI_SEAM_DEVICE_RE, 'the device looked up in WebMidi.outputs inside the trigger'],
    [MIDI_SEAM_CALLS_RE, 'the device and time handed to the SysEx, CC, NRPN, pitch bend and aftertouch helpers'],
    [MIDI_SEAM_SYSEX_RE, "sendSysex scheduling the device's sendSysex at its time"],
    [MIDI_SEAM_NRPN_RE, "sendNRPN scheduling the device's sendNRPN at its time"],
    [MIDI_SEAM_BEND_RE, "sendPitchBend scheduling the device's sendPitchBend at its time"],
    [MIDI_SEAM_TOUCH_RE, "sendAftertouch scheduling the device's sendChannelAftertouch at its time"],
    [MIDI_SEAM_CC_RE, 'the CC send scheduled on the device'],
    [MIDI_SEAM_TIMER_RE, 'scheduleAtTime running its callback from a Web Audio timer at the time given'],
    [MIDI_SEAM_SEND_RE, "webmidi's Output.send passing its time option to the native port"],
  ];
  for (const [re, what] of shapes) {
    if (!re.test(bundleText)) return [claimFailure(claim.id, what)];
  }
  return [];
}

// --- takeover-gate (17) ---

// What page/takeover.js (gatePattern) and page/query-check.js rely on to land a change on a cycle line: the scheduler
// hands the pattern it holds (set with setPattern) to every slice, the slice queries it with a plain query span
// carrying the `cyclist` control, and records the span end in lastEnd before it queries, so a gate pattern built over
// the old and the new pattern is queried slice by slice; the gate compares fractions with lte, gte and gt and splits a
// slice with State.setSpan. Bundle-only: no reference sentence states this, so the claim guards the page's code and not
// a statement made to Claude. Each pattern is hard-coded with generic names, confirmed against @strudel/repl@1.3.0.
const GATE_SET_PATTERN_RE = /setPattern\((\w+)(?:,\w+=!1)?\)\{this\.pattern=\1,/;
const GATE_QUERY_RE =
  /const (\w+)=this\.lastEnd;this\.lastBegin=\1;const (\w+)=this\.num_cycles_at_cps_change\+\w+;if\(this\.lastEnd=\2,this\.lastTick=\w+,\w+<\w+\)\{[^}]*\}this\.pattern\.queryArc\(\1,\2,\{_cps:this\.cps,cyclist:"cyclist"\}\)/;
const GATE_FRACTION_LTE_RE = /\w+\.prototype\.lte=function\((\w+)\)\{return this\.compare\(\1\)<=0\}/;
const GATE_FRACTION_GTE_RE = /\w+\.prototype\.gte=function\((\w+)\)\{return this\.compare\(\1\)>=0\}/;
const GATE_FRACTION_GT_RE = /\w+\.prototype\.gt=function\((\w+)\)\{return this\.compare\(\1\)>0\}/;
const GATE_STATE_SET_SPAN_RE = /class (\w+)\{constructor\((\w+),(\w+)=\{\}\)\{this\.span=\2,this\.controls=\3\}setSpan\((\w+)\)\{return new \1\(\4,this\.controls\)\}/;

function takeoverGateClaim(bundleText, texts, claim) {
  const shapes = [
    [GATE_SET_PATTERN_RE, 'setPattern assigning the pattern it is given to this.pattern'],
    [GATE_QUERY_RE, 'the scheduler setting lastEnd before it queries this.pattern with the cyclist control'],
    [GATE_FRACTION_LTE_RE, 'the Fraction method lte'],
    [GATE_FRACTION_GTE_RE, 'the Fraction method gte'],
    [GATE_FRACTION_GT_RE, 'the Fraction method gt'],
    [GATE_STATE_SET_SPAN_RE, 'State.setSpan keeping the controls of the state'],
  ];
  for (const [re, what] of shapes) {
    if (!re.test(bundleText)) return [claimFailure(claim.id, what)];
  }
  return [];
}

// --- mini-atoms-not-boolean and truthy-flags ---
//
// No mini-notation atom is a boolean: the atom rule returns a rest for `~` and `-`, else the number
// `Number(...)` accepts, else the string itself, so `t` and `f` stay plain strings. `struct` and `mask` are
// `keepif` (outside and inside) and keepif, like `when`, tests only truthiness, so every `t` and every `f` step
// counts as true. functions.md states both facts; each bundle pattern below is hard-coded with generic
// parameter names (a minifier rename does not fail it).

const MINI_ATOM_RULE_RE =
  /case"atom":\{if\(\w+\.source_==="~"\|\|\w+\.source_==="-"\)return silence;if\(!\w+\.location_\)return console\.warn\("no location for",\w+\),\w+\.source_;const \w+=isNaN\(Number\(\w+\.source_\)\)\?\w+\.source_:Number\(\w+\.source_\);/;
const KEEPIF_TRUTHY_RE = /keepif:\[\((\w+),(\w+)\)=>\2\?\1:void 0\]/;
const STRUCT_KEEPIF_OUT_RE = /[\w$]+\.prototype\.struct=function\(\.\.\.(\w+)\)\{return this\.keepif\.out\(\.\.\.\1\)\}/;
const MASK_KEEPIF_IN_RE = /[\w$]+\.prototype\.mask=function\(\.\.\.(\w+)\)\{return this\.keepif\.in\(\.\.\.\1\)\}/;
const WHEN_REGISTER_RE = /when=register\("when",function\((\w+),(\w+),(\w+)\)\{return \1\?\2\(\3\):\3\}\)/;

const MINI_ATOMS_SENTENCE_RES = [
  /No function of this Strudel reads `t` or `f` as a boolean: in mini-notation `t`, `f`, `true` and `false` are plain strings/,
  /so `struct`, `mask` and `when` treat each of them as true/,
];
const TRUTHY_FLAGS_SENTENCE_RES = [/The false values are `0` and `~`/, /`when` needs `1`\/`0`/];

// A call to .struct(, .mask( or .when( whose first argument is a quoted string made only of t, f, rests,
// whitespace and mini-notation structure characters, with at least one t or f: the old struct("t f t t")
// example. Linear: one run without t or f, one t or f, one run. The character class is the same one as
// FLAG_BODY in src/mcp.ts (the server notice); test/flag-notice.test.js fails when the two disagree on any
// character. Exported for that test.
export const FLAG_STRING_EXAMPLE_RE =
  /\.(?:struct|mask|when)\s*\(\s*(["'`])[~\-\s<>[\]{},.|_!?]*[tf][tf~\-\s<>[\]{},.|_!?]*\1/g;

function miniAtomsNotBooleanClaim(bundleText, texts, claim) {
  if (!MINI_ATOM_RULE_RE.test(bundleText)) {
    return [claimFailure(claim.id, "the mini-notation atom rule (rests, then a number or the plain string)")];
  }
  return midiSentenceFailures(claim, texts, MINI_ATOMS_SENTENCE_RES);
}

function truthyFlagsClaim(bundleText, texts, claim) {
  const checks = [
    [KEEPIF_TRUTHY_RE, "keepif's truthy test"],
    [STRUCT_KEEPIF_OUT_RE, 'struct delegating to keepif.out'],
    [MASK_KEEPIF_IN_RE, 'mask delegating to keepif.in'],
    [WHEN_REGISTER_RE, "the when register's truthy test"],
  ];
  const failures = checks.filter(([re]) => !re.test(bundleText)).map(([, what]) => claimFailure(claim.id, what));
  if (failures.length > 0) return failures;
  failures.push(...midiSentenceFailures(claim, texts, TRUTHY_FLAGS_SENTENCE_RES));
  for (const [file, text] of Object.entries(texts)) {
    if (!file.endsWith('.md')) continue;
    for (const match of text.matchAll(FLAG_STRING_EXAMPLE_RE)) {
      failures.push(fileMismatch(file, match[0], 't and f are truthy strings, write 1 and 0'));
    }
  }
  return failures;
}

// --- gain-replaces ---
//
// A later `.gain(n)` replaces every gain set earlier in a track, while `.postgain(n)` scales what a browser track plays
// after its effects; a later `.postgain(n)` replaces an earlier one like gain does, and the MIDI output ignores postgain.
// In the bundle: every control method (gain and postgain included) is the one setter that applies `set` to the pattern it
// is chained on, and `set` keeps its right-hand value; postgain has its own default (1), its own per-event read and its
// own gain node after the effects; the MIDI trigger reads its level only from the gain and velocity of the event (a
// destructure of the event value that names no postgain). effects.md states these facts. Each pattern is hard-coded
// with generic parameter names (a minifier rename does not fail it); the capture groups and backreferences tie the names
// inside one excerpt together.

const CONTROL_SETTER_RE =
  /=function\((\w+),(\w+)\)\{return \2\?typeof \1>"u"\?\2\.fmap\((\w+)\):\2\.set\(reify\(\1\)\.withValue\(\3\)\):reify\(\1\)\.withValue\(\3\)\}/;
const SET_KEEPS_RIGHT_RE = /\{set:\[\((\w+),(\w+)\)=>\2\],keep:\[\w+=>\w+\],keepif:/;
const GAIN_CONTROL_RE = /\{gain\}=registerControl\("gain"\),\{postgain\}=registerControl\("postgain"\)/;
const POSTGAIN_DEFAULT_RE = /\{s:"triangle",gain:\.8,postgain:1,/;
const POSTGAIN_READ_RE = /postgain:\w+=getDefaultValue\("postgain"\)/;
// The key list the MIDI trigger takes from the event value (it starts at `note`, holds gain and velocity and names no postgain).
const MIDI_TRIGGER_KEYS_NO_POSTGAIN_RE =
  /\{note:\w+,(?:(?!postgain)[^{}])*?gain:\w+=\w+\.gain,velocity:\w+=\w+\.velocity,(?:(?!postgain)[^{}])*\}=\w+\.value;/;
const POSTGAIN_NODE_RE = /new GainNode\(\w+,\{gain:\w+\}\);if\(\w+\.main\.post=\[\w+\],\w+\.connect\(\w+\)/;

const GAIN_REPLACES_SENTENCE_RES = [
  /A later `\.gain\(n\)` replaces every gain set earlier in the track/,
  /On a browser track with no post-gain of its own, `\.postgain\(n\)` scales what the track plays after its effects and keeps that difference/,
  /a later `\.postgain\(n\)` replaces an earlier one the same way/,
  /a MIDI track ignores `postgain`/,
];

function gainReplacesClaim(bundleText, texts, claim) {
  const checks = [
    [CONTROL_SETTER_RE, 'the control setter applying set to a chained pattern'],
    [SET_KEEPS_RIGHT_RE, 'set keeping its right-hand value'],
    [GAIN_CONTROL_RE, 'gain and postgain registered as separate controls'],
    [POSTGAIN_DEFAULT_RE, 'the default postgain of 1'],
    [POSTGAIN_READ_RE, 'the per-event postgain read'],
    [POSTGAIN_NODE_RE, "the postgain's own gain node after the effects"],
    [MIDI_TRIGGER_KEYS_NO_POSTGAIN_RE, 'the MIDI trigger reading its level from gain and velocity only (no postgain)'],
  ];
  const failures = checks.filter(([re]) => !re.test(bundleText)).map(([, what]) => claimFailure(claim.id, what));
  if (failures.length > 0) return failures;
  return midiSentenceFailures(claim, texts, GAIN_REPLACES_SENTENCE_RES);
}

/**
 * The prose facts an earlier diagnosis (and the Mixer's solo marker and delay time, the string forms, the MIDI facts, the t/f flag facts and the gain facts) found can drift — id, the reference
 * files each states them in (plus src/mcp.ts for the server instruction on the solo label), and a pure `check(bundleText, texts, claim)` function returning
 * failure strings (each hard-coding its own bundle pattern and reference pattern; never built
 * from downloaded text).
 */
export const PROSE_CLAIMS = [
  { id: 'default-octave', files: ['theory.md', 'mini-notation.md'], check: defaultOctaveClaim },
  { id: 'accidentals', files: ['theory.md', 'mini-notation.md'], check: accidentalsClaim },
  { id: 'chord-root', files: ['theory.md'], check: chordRootClaim },
  { id: 'bare-chord', files: ['theory.md'], check: bareChordClaim },
  { id: 'voicing-defaults', files: ['theory.md'], check: voicingDefaultsClaim },
  { id: 'arrange-repeats', files: ['functions.md', 'transitions.md'], check: arrangeRepeatsClaim },
  { id: 'default-tempo', files: ['tidal-differences.md', 'transitions.md'], check: defaultTempoClaim },
  { id: 'solo-label', files: ['functions.md', 'tidal-differences.md', SOLO_LABEL_INSTRUCTION_FILE], check: soloLabelClaim },
  { id: 'delaytime-seconds', files: ['effects.md'], check: delaytimeSecondsClaim },
  { id: 'string-forms', files: ['tidal-differences.md'], check: stringFormsClaim },
  { id: 'midi-port-quotes', files: ['midi.md'], check: midiPortQuotesClaim },
  { id: 'midi-port-match', files: ['midi.md'], check: midiPortMatchClaim },
  { id: 'midi-channel', files: ['midi.md'], check: midiChannelClaim },
  { id: 'midi-ccv-range', files: ['midi.md'], check: midiCcvRangeClaim },
  { id: 'midi-prognum-range', files: ['midi.md'], check: midiPrognumRangeClaim },
  { id: 'midi-same-instant', files: ['midi.md'], check: midiSameInstantClaim },
  { id: 'midi-gain-velocity', files: ['midi.md'], check: midiGainVelocityClaim },
  { id: 'midi-note-length', files: ['midi.md'], check: midiNoteLengthClaim },
  { id: 'midi-note-off', files: ['midi.md'], check: midiNoteOffClaim },
  { id: 'midi-dominant', files: ['midi.md'], check: midiDominantClaim },
  { id: 'midi-unknown-option-keys', files: ['midi.md'], check: midiUnknownOptionKeysClaim },
  { id: 'midi-note-required', files: ['midi.md'], check: midiNoteRequiredClaim },
  { id: 'midi-clock-cyclist', files: ['midi.md'], check: midiClockCyclistClaim },
  { id: 'midi-transport', files: ['midi.md'], check: midiTransportClaim },
  { id: 'midi-trigger-seam', files: [], check: midiTriggerSeamClaim },
  { id: 'takeover-gate', files: [], check: takeoverGateClaim },
  { id: 'mini-atoms-not-boolean', files: ['functions.md'], check: miniAtomsNotBooleanClaim },
  { id: 'truthy-flags', files: ['functions.md'], check: truthyFlagsClaim },
  { id: 'gain-replaces', files: ['effects.md'], check: gainReplacesClaim },
];

/**
 * Runs every `PROSE_CLAIMS` entry's `check` against `bundleText` and `texts` (a reference file
 * name -> its text map), returning every claim's failure strings, each in one of three forms:
 * "<id>: cannot find <what> in the bundle (the pin changed?)"; "<file>: no longer states <id> in
 * the checked form"; "<file>: says <stated>, the page uses <actual>".
 */
export function proseClaimFailures(bundleText, texts) {
  const failures = [];
  for (const claim of PROSE_CLAIMS) {
    failures.push(...claim.check(bundleText, texts, claim));
  }
  return failures;
}

function parseStringArray(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function manifestNames(manifest) {
  return Object.keys(manifest ?? {}).filter((key) => key !== '_base');
}

// --- Sound-file header check ---
//
// A plain curl or Node download succeeds on the files Chrome refuses (only Chromium enforces the
// Content-Disposition comma rule), so this step
// downloads one file's HEAD per default sound name and inspects the response the browser would
// actually see. HEAD only, never GET; no file body is ever read.

// The six sample manifests prebake() loads, in the order this step checks them.
export const SOUND_FILE_MANIFESTS = [
  'strudel.json',
  'tidal-drum-machines.json',
  'piano.json',
  'Dirt-Samples.json',
  'vcsl.json',
  'mridangam.json',
];

// A `filename=` Content-Disposition parameter that is unquoted (not immediately followed by a
// double quote) and holds a literal comma before the next `;` or the end of the header —
// `filename*=` (percent-encoded) is not matched, since `\s*=` never spans the `*`.
const UNQUOTED_COMMA_FILENAME_RE = /filename\s*=\s*(?!")([^;"]*,[^;"]*)/i;

/**
 * Flags an HTTP HEAD response the browser would refuse. Returns null (accepted) or a reason
 * string: "rate limited (HTTP 429); re-run later" for a 429; "HTTP <status>" for any other status
 * outside 200-399 (a redirect status, 200-399, is always accepted — `redirect: 'follow'` means the
 * caller never actually sees one, but a stub fetchImpl in a test might); or the Chrome
 * comma-in-Content-Disposition reason (reproduces net::ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION).
 */
export function browserRefusal(status, contentDisposition) {
  if (status === 429) return 'rate limited (HTTP 429); re-run later';
  if (status < 200 || status > 399) return `HTTP ${status}`;
  if (typeof contentDisposition === 'string' && UNQUOTED_COMMA_FILENAME_RE.test(contentDisposition)) {
    return 'unquoted comma in Content-Disposition (Chrome refuses the response: ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION)';
  }
  return null;
}

/**
 * The first file and effective base of one manifest entry: a string entry as is; an array entry's
 * first element; an object entry (note-keyed) takes the value of its first key not starting with
 * `_`, itself a string or an array's first element. An entry's own `_base` (only possible on an
 * object entry) wins over `fallbackBase`.
 */
function firstFileAndBase(entry, fallbackBase) {
  if (typeof entry === 'string') return { file: entry, base: fallbackBase };
  if (Array.isArray(entry)) return { file: entry[0], base: fallbackBase };
  if (entry && typeof entry === 'object') {
    const base = Object.prototype.hasOwnProperty.call(entry, '_base') ? entry._base : fallbackBase;
    const key = Object.keys(entry).find((k) => !k.startsWith('_'));
    if (key === undefined) return { file: undefined, base };
    const value = entry[key];
    return { file: Array.isArray(value) ? value[0] : value, base };
  }
  return { file: undefined, base: fallbackBase };
}

/**
 * One target per name in every `SOUND_FILE_MANIFESTS` manifest: `{ set, name, url, problem?,
 * excluded? }`. `set` is the manifest name without `.json`. The base is the entry's own `_base`,
 * else `vcslBase` for `vcsl.json` (the host the page actually fetches from,
 * never the manifest's own declared `_base`), else the manifest's own `_base`. `url` is
 * `base + firstFile`, verbatim, with no re-encoding; when no file exists, `url` is null and
 * `problem` is 'no file listed'. A name `exclusions` lists for this set is marked `excluded: true`
 * — returned, never dropped, so a later fix (or regression) is still visible via `checkSoundFiles`'
 * notes/failures.
 */
export function soundFileTargets(manifests, { vcslBase, exclusions } = {}) {
  const targets = [];
  for (const manifestName of SOUND_FILE_MANIFESTS) {
    const manifest = manifests[manifestName] ?? {};
    const setKey = manifestName.slice(0, -'.json'.length);
    const manifestFallbackBase = setKey === 'vcsl' && vcslBase !== undefined ? vcslBase : manifest._base;
    const excludedNames = exclusions?.get(setKey);
    for (const name of Object.keys(manifest)) {
      if (name === '_base') continue;
      const { file, base } = firstFileAndBase(manifest[name], manifestFallbackBase);
      const excluded = excludedNames ? excludedNames.has(name) : false;
      if (file === undefined || file === null) {
        targets.push({ set: setKey, name, url: null, problem: 'no file listed', ...(excluded ? { excluded: true } : {}) });
        continue;
      }
      targets.push({ set: setKey, name, url: `${base}${file}`, ...(excluded ? { excluded: true } : {}) });
    }
  }
  return targets;
}

// The soundfont host, e.g. defaultSoundfontUrl="https://felixroos.github.io/webaudiofontdata/sound".
const SOUNDFONT_HOST_RE = /defaultSoundfontUrl\s*=\s*"([^"]+)"/;
// Marks the start of the gm={gm_piano:[...],...} object literal (never JSON.parse'd or eval'd —
// bare keys like `gm_piano:` are not valid JSON).
const GM_TABLE_MARKER = 'gm={gm_piano:';
// One gm_<name>:["<firstFile>" pair — the first array element of each gm_ entry.
const GM_ENTRY_RE = /gm_([a-z0-9_]+):\[\s*"([^"]+)"/g;

/**
 * One target per General MIDI soundfont name in the bundle's own `gm={gm_piano:[...],...}` table,
 * `{ set: 'gm', name, url }`, in table order. `url` is `${host}/${firstFile}.js`, where `host` is
 * `defaultSoundfontUrl`. Reads the table with `matchBracket` and a fixed regex only — never `eval`
 * or `JSON.parse`. Throws an Error naming the missing piece when the host or the table
 * is not found (the pin has moved).
 */
export function gmSoundfontTargets(bundleText) {
  const hostMatch = SOUNDFONT_HOST_RE.exec(bundleText);
  if (!hostMatch) throw new Error('gmSoundfontTargets: could not find defaultSoundfontUrl in the bundle');
  const host = hostMatch[1];

  const markerIdx = bundleText.indexOf(GM_TABLE_MARKER);
  if (markerIdx === -1) throw new Error('gmSoundfontTargets: could not find the gm={gm_piano:...} table in the bundle');
  const openIdx = bundleText.indexOf('{', markerIdx);
  const closeIdx = matchBracket(bundleText, openIdx, '{', '}');
  if (closeIdx === -1) throw new Error('gmSoundfontTargets: the gm table has no matching closing brace');
  const tableText = bundleText.slice(openIdx, closeIdx + 1);

  const targets = [];
  const re = new RegExp(GM_ENTRY_RE);
  let match;
  while ((match = re.exec(tableText))) {
    targets.push({ set: 'gm', name: `gm_${match[1]}`, url: `${host}/${match[2]}.js` });
  }
  return targets;
}

/**
 * Downloads the HEAD of every distinct URL in `targets` (so two names sharing a URL cost one
 * request) with a worker pool of `concurrency` workers, and flags each with `browserRefusal`. A
 * rejected request gives the reason "could not reach (<message>)". Returns `{ checked, failures,
 * notes }`: `checked` is the number of names (`targets.length`); `failures` is one line per
 * failing, non-excluded name (`sounds: <set>/<name>: <reason> (<url>)`) plus every 'no file
 * listed' target (`sounds: <set>/<name>: no file listed`), sorted by set then name; `notes` is one
 * line per excluded name whose URL answers with no refusal (`excluded sound <set>/<name> now
 * loads; consider listing it again`) — a fix candidate, not a failure.
 */
export async function checkSoundFiles(targets, options = {}) {
  const { fetchImpl = fetch, concurrency = 12, timeoutMs = 20000 } = options;
  const checked = targets.length;
  const notes = [];
  const entries = [];

  const fetchable = [];
  for (const target of targets) {
    if (target.url === null) {
      entries.push({
        set: target.set,
        name: target.name,
        line: `sounds: ${target.set}/${target.name}: ${target.problem ?? 'no file listed'}`,
      });
      continue;
    }
    fetchable.push(target);
  }

  const byUrl = new Map();
  for (const target of fetchable) {
    if (!byUrl.has(target.url)) byUrl.set(target.url, []);
    byUrl.get(target.url).push(target);
  }
  const urls = [...byUrl.keys()];
  const reasons = new Map();

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < urls.length) {
      const url = urls[nextIndex++];
      try {
        const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        reasons.set(url, browserRefusal(res.status, res.headers.get('content-disposition')));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reasons.set(url, `could not reach (${message})`);
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, urls.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for (const target of fetchable) {
    const reason = reasons.get(target.url);
    if (reason === null) {
      if (target.excluded) {
        notes.push(`excluded sound ${target.set}/${target.name} now loads; consider listing it again`);
      }
      continue;
    }
    if (target.excluded) continue; // excluded names never fail the check, even while still broken
    entries.push({ set: target.set, name: target.name, line: `sounds: ${target.set}/${target.name}: ${reason} (${target.url})` });
  }

  entries.sort((a, b) => (a.set === b.set ? a.name.localeCompare(b.name) : a.set.localeCompare(b.set)));

  return { checked, failures: entries.map((e) => e.line), notes };
}

// Registered sounds that are not playable instruments — excluded from the palette, each with a
// one-line reason (never hide a real sound; this is the opposite — a real *non-sound*).
const SYNTH_EXCLUSIONS = new Map([
  ['bus', 'registered with {type:"input"} — an audio bus for routing/side-chaining, not a playable sound'],
]);

// Sample-set names that are listed in a manifest but can never actually play — excluded from the
// palette, keyed by sampleSets key, each with a one-line reason (the opposite of
// hiding a real sound; each entry names why the sound can never play). Threaded into
// paletteSources below so a removed name never breaks comparePalette's "missing" check.
export const SAMPLE_EXCLUSIONS = new Map([
  [
    'vcsl',
    new Map([
      [
        'tom_mallet',
        'all 8 files answer 404 at the paths vcsl.json gives, in every browser',
      ],
    ]),
  ],
]);

/** `names` minus whatever SAMPLE_EXCLUSIONS lists for `setKey`, as a Set. */
function namesExcluding(names, setKey) {
  const excluded = SAMPLE_EXCLUSIONS.get(setKey);
  return new Set(excluded ? names.filter((name) => !excluded.has(name)) : names);
}

/**
 * Reads the default sound palette straight from the pinned bundle text and the default sample
 * manifests (never by running either): synth waveforms/noises/extra synths, ZZFX voices, General
 * MIDI soundfonts, drum-machine sound types, the default drum kit, the sample sets and the bank
 * aliases. `manifests` maps a manifest file name (e.g. 'tidal-drum-machines.json') to its parsed
 * JSON. Every `_base` key is dropped — it is never a sound name.
 */
export function paletteSources(bundleText, manifests) {
  const waveformsMatch = /waveforms\s*=\s*\[([^\]]*)\]/.exec(bundleText);
  const noisesMatch = /noises\s*=\s*\[([^\]]*)\]/.exec(bundleText);
  const synths = new Set([
    ...(waveformsMatch ? parseStringArray(waveformsMatch[1]) : []),
    ...(noisesMatch ? parseStringArray(noisesMatch[1]) : []),
  ]);
  for (const m of bundleText.matchAll(/registerSound\(\s*["']([a-zA-Z0-9_]+)["']/g)) {
    if (SYNTH_EXCLUSIONS.has(m[1])) continue;
    synths.add(m[1]);
  }

  const zzfxMatch = /registerZZFXSounds\(\)\{\[([^\]]*)\]/.exec(bundleText);
  const zzfx = new Set(zzfxMatch ? parseStringArray(zzfxMatch[1]) : []);

  const gm = new Set(bundleText.match(/gm_[a-z_0-9]*/g) ?? []);

  const drumMachines = new Map();
  for (const key of Object.keys(manifests['tidal-drum-machines.json'] ?? {})) {
    if (key === '_base') continue;
    const idx = key.lastIndexOf('_');
    const machine = key.slice(0, idx);
    const type = key.slice(idx + 1);
    if (type === '') continue; // e.g. OberheimDMX_: an empty type is not a sound type.
    if (!drumMachines.has(machine)) drumMachines.set(machine, new Set());
    drumMachines.get(machine).add(type);
  }

  const drumKit = new Set(manifestNames(manifests['strudel.json']));

  const sampleSets = new Map([
    ['piano', namesExcluding(manifestNames(manifests['piano.json']), 'piano')],
    ['Dirt-Samples', namesExcluding(manifestNames(manifests['Dirt-Samples.json']), 'Dirt-Samples')],
    ['vcsl', namesExcluding(manifestNames(manifests['vcsl.json']), 'vcsl')],
    ['mridangam', namesExcluding(manifestNames(manifests['mridangam.json']), 'mridangam')],
  ]);

  const aliases = new Set(Object.values(manifests['tidal-drum-machines-alias.json'] ?? {}));

  return { synths, zzfx, gm, drumMachines, drumKit, sampleSets, aliases };
}

/**
 * Parses every ```names fenced block of `markdown` into rows: a label ('Machine' from a
 * 'Machine: type type ...' line) with its tokens, or `label: null` for a plain space-separated
 * line (e.g. a GM or sample-set names block).
 */
export function namesBlockTokens(markdown) {
  const rows = [];
  const re = /```names\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(markdown))) {
    for (const rawLine of match[1].split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        rows.push({
          label: line.slice(0, colonIdx).trim(),
          tokens: line
            .slice(colonIdx + 1)
            .trim()
            .split(/\s+/)
            .filter(Boolean),
        });
      } else {
        rows.push({ label: null, tokens: line.split(/\s+/).filter(Boolean) });
      }
    }
  }
  return rows;
}

/**
 * Compares `sources` (from paletteSources) against the ```names blocks of `markdown` (from a
 * reference topic like sounds.md). Returns:
 * - missing: source names (and drum-machine labels) absent from the markdown's tokens.
 * - unknown: markdown tokens (labels excluded) that are in no source group.
 * - wrongTypes: one message per drum-machine line listing a type that machine does not have, or
 *   omitting one it has.
 */
export function comparePalette(sources, markdown) {
  const rows = namesBlockTokens(markdown);
  const wrongTypes = [];
  const genericTokens = new Set();
  const machineLabelsSeen = new Set();

  for (const row of rows) {
    if (row.label && sources.drumMachines.has(row.label)) {
      machineLabelsSeen.add(row.label);
      const actualTypes = sources.drumMachines.get(row.label);
      const listedTypes = new Set(row.tokens);
      for (const type of listedTypes) {
        if (!actualTypes.has(type)) {
          wrongTypes.push(`${row.label} lists "${type}", which it does not have`);
        }
      }
      for (const type of actualTypes) {
        if (!listedTypes.has(type)) {
          wrongTypes.push(`${row.label} is missing "${type}"`);
        }
      }
    } else {
      for (const token of row.tokens) genericTokens.add(token);
    }
  }

  const sourceNames = new Set([
    ...sources.synths,
    ...sources.zzfx,
    ...sources.gm,
    ...sources.drumKit,
    ...[...sources.sampleSets.values()].flatMap((set) => [...set]),
    ...sources.aliases,
  ]);

  const missing = [];
  for (const name of sourceNames) {
    if (!genericTokens.has(name)) missing.push(name);
  }
  for (const machine of sources.drumMachines.keys()) {
    if (!machineLabelsSeen.has(machine)) missing.push(machine);
  }

  const unknown = [];
  for (const token of genericTokens) {
    if (!sourceNames.has(token)) unknown.push(token);
  }

  return { missing, unknown, wrongTypes };
}

/**
 * Extracts every scale name and alias from @strudel/tonal's SCALES dictionary in the bundle
 * text. The array itself (interval string + names, all double-quoted) is valid JSON once
 * bracket-matched out of the surrounding minified source, so this is JSON.parse on text found
 * by string search — never an eval or import of the bundle. Returns null if the dictionary
 * cannot be located (a pin change moved or renamed it).
 */
export function extractScaleNames(bundleText) {
  const marker = 'SCALES=[';
  const idx = bundleText.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length - 1; // include the opening '['
  let depth = 0;
  let i = start;
  for (; i < bundleText.length; i++) {
    const c = bundleText[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  try {
    const scales = JSON.parse(bundleText.slice(start, i + 1));
    const names = new Set();
    for (const entry of scales) {
      const [, ...aliases] = entry;
      for (const alias of aliases) names.add(alias);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * Every ```names block in `markdown`, as `{ heading, lines }` — `heading` is the text of the
 * nearest preceding `## ` line (null if none), `lines` are the block's non-empty lines, each a
 * whole string (never split on whitespace, unlike namesBlockTokens which is built for
 * space-separated tokens per line as in sounds.md; theory.md's scale and chord names are one
 * full name per line, and several contain spaces of their own, e.g. "major pentatonic").
 */
function namesBlocksByHeading(markdown) {
  const headings = [];
  const headingRe = /^## (.+)$/gm;
  let headingMatch;
  while ((headingMatch = headingRe.exec(markdown))) {
    headings.push({ index: headingMatch.index, title: headingMatch[1].trim() });
  }
  const blocks = [];
  const fenceRe = /```names\n([\s\S]*?)```/g;
  let fenceMatch;
  while ((fenceMatch = fenceRe.exec(markdown))) {
    let heading = null;
    for (const h of headings) {
      if (h.index < fenceMatch.index) heading = h.title;
      else break;
    }
    const lines = fenceMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    blocks.push({ heading, lines });
  }
  return blocks;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

// The default sample manifests the pinned bundle's prebake() loads at startup. Read as
// JSON data only, never executed.
const PALETTE_MANIFEST_URLS = {
  'tidal-drum-machines.json': 'https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json',
  'piano.json': 'https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json',
  'Dirt-Samples.json': 'https://raw.githubusercontent.com/felixroos/dough-samples/main/Dirt-Samples.json',
  'vcsl.json': 'https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json',
  'mridangam.json': 'https://raw.githubusercontent.com/felixroos/dough-samples/main/mridangam.json',
  'strudel.json': 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json',
};
const ALIAS_MANIFEST_URL = 'https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json';

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(path.join(repoRoot, 'page', 'index.html'), 'utf8');
  const pin = parsePin(html);

  let bundleText;
  let bundlePackageJson;
  let grammarText;
  let miniVersion;
  try {
    bundleText = await fetchText(pin.url);
    bundlePackageJson = JSON.parse(
      await fetchText(`https://unpkg.com/@strudel/repl@${pin.version}/package.json`),
    );
    miniVersion = bundlePackageJson.dependencies?.['@strudel/mini'];
    grammarText = await fetchText(`https://unpkg.com/@strudel/mini@${miniVersion}/krill.pegjs`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`check:reference FAILED: needs network access to unpkg.com (${reason})`);
    process.exitCode = 1;
    return;
  }

  const failures = [];

  const digest = sriDigest(bundleText);
  if (digest !== pin.integrity) {
    failures.push(
      `page/index.html: integrity ${pin.integrity} does not match the downloaded bundle's ${digest} — ` +
        'the reference would be checked against a different file than the page runs',
    );
  }

  const referenceDir = path.join(repoRoot, 'reference');
  const files = readdirSync(referenceDir).filter((name) => name.endsWith('.md'));

  const registered = registeredArities(bundleText);

  // Chord step: confirm the page's chord tokenizer and default voicing
  // dictionary are still where this script expects, before trusting either for the per-file
  // chord-symbol check below.
  if (!bundleText.includes(CHORD_SYMBOL_RE.source)) {
    failures.push("theory.md: the page's chord tokenizer changed");
  }
  const vocabulary = chordVocabulary(bundleText);
  if (!vocabulary) {
    failures.push('theory.md: could not locate the ireal voicing dictionary in the bundle to cross-check');
  }

  // Note step: confirm the page's note tokenizer is still where this script expects,
  // before trusting it for the per-file note-token check below.
  if (!bundleText.includes(NOTE_NAME_RE.source)) {
    failures.push("theory.md: the page's note tokenizer changed");
  }

  // Mini-notation step: confirm the pinned grammar's own shape is still readable before
  // trusting it for the per-file mini-notation string check below.
  const grammar = miniGrammar(grammarText);
  if (!grammar) {
    failures.push(`reference: could not read the pinned mini-notation grammar (@strudel/mini@${miniVersion} — the pin may have moved)`);
  }

  let namesChecked = 0;
  let methodCallsChecked = 0;
  let miniStringsChecked = 0;
  const referenceTexts = {};
  for (const file of files) {
    const text = readFileSync(path.join(referenceDir, file), 'utf8');
    referenceTexts[file] = text;

    for (const [, pkgName, version] of text.matchAll(/@strudel\/([a-z]+)\s+([\d.]+)/g)) {
      const depVersion = bundlePackageJson.dependencies?.[`@strudel/${pkgName}`];
      if (depVersion && depVersion !== version) {
        failures.push(`${file}: names @strudel/${pkgName} ${version} but the bundle depends on ${depVersion}`);
      }
    }

    for (const name of extractCalledNames(text)) {
      namesChecked++;
      if (!nameInBundle(name, bundleText)) {
        failures.push(`${file}: ${name} not found in @strudel/repl@${pin.version}`);
      }
    }

    // Arity step: every register()ed method call must pass the argument count the
    // page's own register() wrapper accepts.
    const calls = methodCalls(text);
    methodCallsChecked += calls.length;
    for (const failure of arityFailures(calls, registered, file)) {
      failures.push(failure);
    }

    // Chord step: every chord symbol used in a chord() or .voicing() string must
    // be accepted by the page's chord tokenizer and default voicing dictionary.
    if (vocabulary) {
      for (const failure of chordFailures(chordSymbols(text), vocabulary, file)) {
        failures.push(failure);
      }
    }

    // Note step: every note() token must be a plain number, a rest, or a real note name.
    for (const failure of noteFailures(noteTokens(text), file)) {
      failures.push(failure);
    }

    // Mini-notation step: every example mini-notation string must be made of characters
    // the pinned grammar accepts, with balanced, nested brackets.
    if (grammar) {
      const strings = miniStrings(text);
      miniStringsChecked += strings.length;
      for (const failure of miniFailures(strings, grammar, file)) {
        failures.push(failure);
      }
    }
  }

  // Prose-claims step: the default octave, accidentals, chord root, bare chord, voicing
  // defaults, arrange()-repeats and default-tempo facts, each checked against the bundle's own
  // text and the exact sentence(s) reference/*.md state about it. The solo-label claim also reads
  // src/mcp.ts as text (never imported or evaluated; works without a build, unlike dist/), so the
  // server instruction cannot drop the underscore exception silently.
  const claimTexts = {
    ...referenceTexts,
    [SOLO_LABEL_INSTRUCTION_FILE]: readFileSync(path.join(repoRoot, 'src', 'mcp.ts'), 'utf8'),
  };
  for (const failure of proseClaimFailures(bundleText, claimTexts)) {
    failures.push(failure);
  }

  // Palette step: confirm the bundle still loads the same default manifests, then verify
  // reference/sounds.md is complete and exact against those manifests.
  let paletteChecked = false;
  let manifests = null; // kept in scope for the sound-file step below
  if (files.includes('sounds.md')) {
    for (const manifestName of Object.keys(PALETTE_MANIFEST_URLS)) {
      if (!bundleText.includes(manifestName)) {
        failures.push(`sounds.md: the bundle no longer loads ${manifestName} by default — the palette source has changed`);
      }
    }
    if (!bundleText.includes('tidal-drum-machines-alias.json')) {
      failures.push('sounds.md: the bundle no longer loads tidal-drum-machines-alias.json by default');
    }

    try {
      manifests = {};
      for (const [name, url] of Object.entries(PALETTE_MANIFEST_URLS)) {
        manifests[name] = JSON.parse(await fetchText(url));
      }
      manifests['tidal-drum-machines-alias.json'] = JSON.parse(await fetchText(ALIAS_MANIFEST_URL));

      const sources = paletteSources(bundleText, manifests);
      const soundsText = readFileSync(path.join(referenceDir, 'sounds.md'), 'utf8');

      // VCSL sync step: the doc and the page must still agree on where VCSL
      // audio actually loads from, checking the host the browser really
      // fetches, never the manifest's own declared _base.
      // The page loads the manifest pinned to a commit, the bundle loads it from the main branch: the pinned
      // address must be the bundle's own address with the branch replaced by the commit, and the pinned file
      // must list the same sounds as the branch does today.
      if (PALETTE_MANIFEST_URLS['vcsl.json'].replace('/main/', '/' + VCSL_MANIFEST_COMMIT + '/') !== VCSL_MANIFEST_URL) {
        failures.push('page/ui-state.js: VCSL_MANIFEST_URL is not the vcsl.json address the bundle loads with main replaced by VCSL_MANIFEST_COMMIT');
      }
      const pinnedSoundNames = Object.keys(JSON.parse(await fetchText(VCSL_MANIFEST_URL))).filter((name) => name !== '_base').sort();
      const branchSoundNames = Object.keys(manifests['vcsl.json']).filter((name) => name !== '_base').sort();
      if (JSON.stringify(pinnedSoundNames) !== JSON.stringify(branchSoundNames)) {
        const added = branchSoundNames.filter((name) => !pinnedSoundNames.includes(name));
        const removed = pinnedSoundNames.filter((name) => !branchSoundNames.includes(name));
        failures.push(
          `page/ui-state.js: the vcsl.json on the main branch lists different sounds than the one pinned by VCSL_MANIFEST_COMMIT (new on main: ${added.join(', ') || 'none'}; gone from main: ${removed.join(', ') || 'none'}). Look up the new commit read-only (git ls-remote https://github.com/felixroos/dough-samples refs/heads/main), check that reference/sounds.md still matches, then re-pin VCSL_MANIFEST_COMMIT.`,
        );
      }
      if (!soundsText.includes(VCSL_SAMPLE_BASE)) {
        failures.push('sounds.md: does not name the VCSL host the page uses (VCSL_SAMPLE_BASE from page/ui-state.js)');
      }

      const { missing, unknown, wrongTypes } = comparePalette(sources, soundsText);
      for (const name of missing) failures.push(`sounds.md: missing: ${name}`);
      for (const token of unknown) failures.push(`sounds.md: unknown: ${token}`);
      for (const message of wrongTypes) failures.push(`sounds.md: wrongType: ${message}`);
      paletteChecked = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`sounds.md: needs network access to the default sample manifests (${reason})`);
    }
  }

  // Sound-file step: download the headers of one file per default sound name (samples
  // and General MIDI) from the host the page actually uses. Plain curl or Node downloads succeed
  // on files Chrome refuses, so this checks the Content-Disposition header rule, not only the
  // status. VCSL is checked at VCSL_SAMPLE_BASE, never the manifest's own
  // declared _base.
  let soundFilesChecked = 0;
  if (paletteChecked && manifests) {
    try {
      const targets = [
        ...soundFileTargets(manifests, { vcslBase: VCSL_SAMPLE_BASE, exclusions: SAMPLE_EXCLUSIONS }),
        ...gmSoundfontTargets(bundleText),
      ];
      const { checked, failures: soundFailures, notes } = await checkSoundFiles(targets);
      soundFilesChecked = checked;
      for (const failure of soundFailures) failures.push(failure);
      for (const note of notes) console.log(`check:reference NOTE: ${note}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`sounds: needs network access to the default sound files (${reason})`);
    }
  }

  // Theory step: the scale names block must list only real bundle names, and every scale
  // in the bundle's own dictionary must be listed (both directions). The two chord names blocks
  // are checked separately below, against chordVocabulary rather than nameInBundle — nameInBundle
  // accepts any quoted string anywhere in the 2.2 MB bundle, which let false chord suffixes pass.
  let theoryChecked = false;
  if (files.includes('theory.md')) {
    const theoryText = readFileSync(path.join(referenceDir, 'theory.md'), 'utf8');
    const blocks = namesBlocksByHeading(theoryText);

    const scaleLines = new Set(blocks.filter((b) => b.heading === 'Scales and modes').flatMap((b) => b.lines));
    for (const name of scaleLines) {
      if (!nameInBundle(name, bundleText)) {
        failures.push(`theory.md: name not in bundle: ${name}`);
      }
    }

    const scaleNames = extractScaleNames(bundleText);
    if (!scaleNames) {
      failures.push('theory.md: could not locate the SCALES dictionary in the bundle to cross-check');
    } else {
      for (const name of scaleNames) {
        if (!scaleLines.has(name)) failures.push(`theory.md: scale missing: ${name}`);
      }
      theoryChecked = true;
    }

    if (vocabulary) {
      const [keysBlock, aliasesBlock] = blocks.filter((b) => b.heading === 'Chords');
      const listedKeys = new Set(keysBlock ? keysBlock.lines : []);
      for (const key of vocabulary.keys) {
        if (!listedKeys.has(key)) failures.push(`theory.md: chord suffix missing: ${key}`);
      }
      for (const key of listedKeys) {
        if (!vocabulary.keys.has(key)) failures.push(`theory.md: chord suffix not in the page: ${key}`);
      }
      const listedAliases = new Set(aliasesBlock ? aliasesBlock.lines : []);
      for (const alias of vocabulary.aliases) {
        if (!listedAliases.has(alias)) failures.push(`theory.md: chord suffix missing: ${alias}`);
      }
      for (const alias of listedAliases) {
        if (!vocabulary.aliases.has(alias)) failures.push(`theory.md: chord suffix not in the page: ${alias}`);
      }
    }
  }

  // The Mixer's effect registry: the methods, aliases and key packs it writes.
  const registryNames = Object.keys(METHOD_KEYS).length;
  failures.push(
    ...registryFailures(bundleText, { methodKeys: METHOD_KEYS, nonControlNames: ['hush', 'sine', 'tri', 'saw', 'range', 'slow'] }),
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`check:reference FAILED: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  const paletteNote = paletteChecked ? '; sounds.md palette verified against the default manifests' : '';
  const theoryNote = theoryChecked ? '; theory.md names verified against the bundle' : '';
  const miniNote = grammar
    ? `; ${miniStringsChecked} mini-notation strings checked against @strudel/mini@${miniVersion}`
    : '';
  const claimsNote = `; ${PROSE_CLAIMS.length} prose claims checked`;
  const registryNote = `; ${registryNames} mixer registry names checked`;
  const soundFilesNote = soundFilesChecked > 0 ? `; ${soundFilesChecked} sound files checked (one per default sound name)` : '';
  console.log(
    `check:reference OK: ${namesChecked} names found in @strudel/repl@${pin.version} (integrity verified)${paletteNote}${theoryNote}; ${methodCallsChecked} method calls checked for argument count${miniNote}${claimsNote}${registryNote}${soundFilesNote}`,
  );
}

// Runs only when executed directly, so tests can import the pure functions above without
// triggering a network call.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`check:reference FAILED: ${message}`);
    process.exit(1);
  });
}
