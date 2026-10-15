#!/usr/bin/env node
// Measures tint and variety over the user's own session history, for the user to
// read. This is NOT a rule for Claude: it is never a tool, never a resource, never text Claude
// reads, and it must never become a rule. It runs only when the user starts it, reads only the
// per-user history file and the bundled reference/*.md (for demo-line reuse), writes no file,
// and never touches the network. JRPG color cannot be measured from text; this report does not
// pretend to — that is a judgment the human makes by ear.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { resolveDataDir, HISTORY_FILE_NAME } from '../dist/history.js';
import { readStructure, HELPER_TEXT } from '../page/structure.js';
import { extractTracks } from '../page/tracks.js';

function fail(message) {
  const err = new Error(message.startsWith('tint:report:') ? message : `tint:report: ${message}`);
  return err;
}

/** --last N (default 10 when neither --last nor --ids is given), --ids a,b,c, --data-dir DIR. */
export function parseArgs(argv) {
  const result = { last: null, ids: null, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--last') {
      const value = argv[++i];
      const n = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw fail(`--last needs a positive integer, got "${value}"`);
      }
      result.last = n;
    } else if (arg === '--ids') {
      const value = argv[++i];
      if (value === undefined || value.trim() === '') {
        throw fail('--ids needs a comma-separated list of version numbers');
      }
      const ids = [];
      for (const raw of value.split(',')) {
        const trimmed = raw.trim();
        const n = Number(trimmed);
        if (!Number.isInteger(n) || n <= 0) {
          throw fail(`--ids needs positive integers, got "${trimmed}"`);
        }
        ids.push(n);
      }
      result.ids = ids;
    } else if (arg === '--data-dir') {
      const value = argv[++i];
      if (value === undefined || value.trim() === '') {
        throw fail('--data-dir needs a path');
      }
      result.dataDir = value;
    } else {
      throw fail(`unknown flag "${arg}"`);
    }
  }
  if (result.last !== null && result.ids !== null) {
    throw fail('--last and --ids cannot be combined; pick one');
  }
  if (result.last === null && result.ids === null) {
    result.last = 10;
  }
  return result;
}

/** Reads a history.jsonl file's text into { versions, unreadable }: version entries (in file
 * order, session-start and favorite lines skipped) and a count of lines that were neither. */
export function parseHistoryText(text) {
  const versions = [];
  let unreadable = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      unreadable++;
      continue;
    }
    if (entry === null || typeof entry !== 'object') {
      unreadable++;
      continue;
    }
    if (entry.type === 'session-start' || entry.type === 'favorite') continue;
    if (entry.type !== 'version' || typeof entry.id !== 'number' || typeof entry.code !== 'string') {
      unreadable++;
      continue;
    }
    const version = { id: entry.id, origin: entry.origin, code: entry.code };
    if (entry.label !== undefined) version.label = entry.label;
    versions.push(version);
  }
  return { versions, unreadable };
}

// String arguments of a bare or dotted s(/sound( call — same shape as test/tint-rules.js's
// SOUND_ARG_RE, kept independent since this script imports no test helper.
const SOUND_CALL_RE = /(\.)?\b(?:s|sound)\(\s*(["'`])((?:(?!\2)[^\\])*?)\2/g;
const BANK_CALL_RE = /\.bank\(\s*(["'`])((?:(?!\1)[^\\])*?)\1/g;

/** Sorted unique tokens of every s(/sound(/.bank( string argument, mini-notation symbols and
 * whitespace split out, plain numbers and rests dropped. Underscores are kept (gm_flute, z_sine). */
export function soundsUsed(code) {
  const tokens = new Set();
  let match;
  const soundRe = new RegExp(SOUND_CALL_RE);
  while ((match = soundRe.exec(code))) {
    for (const token of match[3].split(/[^a-zA-Z0-9_]+/)) {
      if (token === '' || /^\d+$/.test(token)) continue;
      tokens.add(token);
    }
  }
  const bankRe = new RegExp(BANK_CALL_RE);
  while ((match = bankRe.exec(code))) {
    const name = match[2].trim();
    if (name !== '') tokens.add(name);
  }
  return [...tokens].sort();
}

const SCALE_CALL_RE = /\.scale\(\s*(["'`])((?:(?!\1)[^\\])*?)\1/g;

/** String arguments of every .scale( call, in order of appearance. */
export function scalesUsed(code) {
  const results = [];
  const re = new RegExp(SCALE_CALL_RE);
  let match;
  while ((match = re.exec(code))) {
    results.push(match[2]);
  }
  return results;
}

const TEMPO_CALL_RE = /(?:\.cpm|setcps|setcpm)\([^)]*\)/g;

/** Every setcps(...), setcpm(...) and .cpm(...) call, verbatim as written. */
export function tempoUsed(code) {
  return code.match(TEMPO_CALL_RE) ?? [];
}

/** Case-insensitive "flute" in the code or the label — covers a sound token (gm_flute,
 * gm_pan_flute) since those tokens are themselves substrings of the code. */
export function hasFlute(code, label) {
  if (/flute/i.test(code)) return true;
  return typeof label === 'string' && /flute/i.test(label);
}

const JS_FENCE_RE = /```js\n([\s\S]*?)```/g;

/** Trimmed lines of every ```js block across `markdownTexts`, kept only when at least 24
 * characters and not a `//` comment. Deduplicated, in first-seen order across all texts. */
export function demoLines(markdownTexts) {
  const seen = new Set();
  const lines = [];
  for (const markdown of markdownTexts) {
    const re = new RegExp(JS_FENCE_RE);
    let match;
    while ((match = re.exec(markdown))) {
      for (const rawLine of match[1].split('\n')) {
        const line = rawLine.trim();
        if (line.length < 24 || line.startsWith('//') || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines;
}

const HELPER_LINES = new Set(HELPER_TEXT.split('\n').map((line) => line.trim()));

/** `lines` without the lines of the song-structure helper, which a structured piece carries as written by design
 * and which therefore say nothing about tint. Every other line stays. */
export function withoutHelperLines(lines) {
  return lines.filter((line) => !HELPER_LINES.has(line));
}

/** The subset of `lines` that appear verbatim (as a substring) in `code`. */
export function reusedDemoLines(code, lines) {
  return lines.filter((line) => code.includes(line));
}

// Identifiers, numbers and quoted strings — code "tokens" for a rough similarity measure.
const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function tokenSet(code) {
  return new Set(code.match(TOKEN_RE) ?? []);
}

/** Jaccard index (intersection / union) of the token sets of `a` and `b`, rounded to 2 decimals. */
export function similarity(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  const value = union === 0 ? 0 : intersection / union;
  return Math.round(value * 100) / 100;
}

/** Count of trimmed lines (at least 8 characters) shared between `a` and `b`, matching one
 * occurrence in `a` to one occurrence in `b`. */
export function identicalLines(a, b) {
  const remaining = new Map();
  for (const raw of a.split('\n')) {
    const line = raw.trim();
    if (line.length < 8) continue;
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let count = 0;
  for (const raw of b.split('\n')) {
    const line = raw.trim();
    if (line.length < 8) continue;
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      count++;
      remaining.set(line, left - 1);
    }
  }
  return count;
}

/** The deepest nesting of the groups the page read: 0 without groups, 1 for groups that hold no group, and so on.
 * Walked without recursion. */
function groupDepth(groups) {
  let deepest = 0;
  const stack = groups.map((group) => ({ group, depth: 1 }));
  while (stack.length > 0) {
    const { group, depth } = stack.pop();
    if (depth > deepest) deepest = depth;
    for (const item of group.items) {
      if (item.group) stack.push({ group: item.group, depth: depth + 1 });
    }
  }
  return deepest;
}

/**
 * What the page's own reader makes of the song structure in `code`, as plain numbers:
 * - `{ state: 'none' }` for a piece without a structure;
 * - `{ state: 'unreadable', reason }` for a structure the page cannot read (`reason` is the reader's reason id, or
 *   'parse' when the code does not parse);
 * - `{ state: 'read', lengths, tracks, kinds: { other, degrees, fixed }, rests, groupDepth, sectionHarmonies,
 *   sectionNames, helper, signature }`. `kinds` counts the distinct variations the plan uses, by kind; `rests` counts
 *   the rest cells; `sectionHarmonies` counts the sections with a harmony of their own; `signature` is the lengths
 *   joined by commas, a bar and the track count, the shape of the piece.
 */
export function structureMetrics(code) {
  let reading;
  try {
    reading = readStructure(code, { parse, tracks: extractTracks(code, { parse }) });
  } catch (err) {
    // Only code that does not parse counts as 'parse'; any other error is a bug in the reader and must show.
    if (err instanceof SyntaxError) return { state: 'unreadable', reason: 'parse' };
    throw err;
  }
  if (reading.state === 'none') return { state: 'none' };
  if (reading.state === 'unreadable') return { state: 'unreadable', reason: reading.reason };
  const lengths = reading.sections.map((section) => section.length);
  const kinds = { other: 0, degrees: 0, fixed: 0 };
  let rests = 0;
  for (const track of reading.tracks) {
    const used = new Map();
    for (const cell of track.cells) {
      if (cell.kind === 'rest') rests += 1;
      else used.set(cell.key, cell.kind);
    }
    for (const kind of used.values()) kinds[kind] += 1;
  }
  return {
    state: 'read',
    lengths,
    tracks: reading.tracks.length,
    kinds,
    rests,
    groupDepth: groupDepth(reading.groups),
    sectionHarmonies: reading.sections.filter((section) => section.harmony.from === 'own').length,
    sectionNames: [...new Set(reading.sections.map((section) => section.name))],
    helper: reading.helper,
    signature: `${lengths.join(',')}|${reading.tracks.length}`,
  };
}

/** The `  structure:` line of one version in the report. */
export function structureLine(metrics) {
  if (metrics.state === 'none') return '  structure: none';
  if (metrics.state === 'unreadable') return `  structure: unreadable (${metrics.reason})`;
  const { other, degrees, fixed } = metrics.kinds;
  const variations = other + degrees + fixed;
  return (
    `  structure: ${metrics.lengths.length} sections (${metrics.lengths.join(', ')}), ${metrics.tracks} tracks, ` +
    `${variations} variations (other ${other}, degrees ${degrees}, fixed ${fixed}), ${metrics.rests} rests, ` +
    `groups depth ${metrics.groupDepth}, ${metrics.sectionHarmonies} section harmonies, helper ${metrics.helper}`
  );
}

/** The shapes of the examples in the structure topic: the signature of each js block that reads as a structure once the
 * helper lines are in place (a block may carry a comment line where they go). */
export function structureTopicSignatures(markdown) {
  const signatures = [];
  const re = new RegExp(JS_FENCE_RE);
  let match;
  while ((match = re.exec(markdown))) {
    const code = match[1].replace(/^\/\/ \(the helper lines of the first block go here\)$/m, HELPER_TEXT);
    const metrics = structureMetrics(code);
    if (metrics.state === 'read') signatures.push(metrics.signature);
  }
  return signatures;
}

/**
 * The lines that close the structure block across the selected versions: how many are structured, each distinct shape
 * with its count, the highest share of one shape, how many equal a shape of the structure topic, and the section names
 * that appear in more than one version. `metricsList` is one structureMetrics result per version.
 */
export function structureSummary(metricsList, topicSignatures) {
  const read = metricsList.filter((metrics) => metrics.state === 'read');
  const unreadable = metricsList.filter((metrics) => metrics.state === 'unreadable').length;
  const counts = new Map();
  for (const metrics of read) counts.set(metrics.signature, (counts.get(metrics.signature) ?? 0) + 1);
  const shapes = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const highest = shapes.length === 0 ? 0 : Math.round((shapes[0][1] / read.length) * 100);
  const topic = new Set(topicSignatures);
  const sameAsTopic = read.filter((metrics) => topic.has(metrics.signature)).length;
  const versionsWithName = new Map();
  for (const metrics of read) {
    for (const name of metrics.sectionNames) versionsWithName.set(name, (versionsWithName.get(name) ?? 0) + 1);
  }
  const repeated = [...versionsWithName.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort();
  const lines = [`structured: ${read.length} of ${metricsList.length}${unreadable > 0 ? ` (${unreadable} more unreadable)` : ''}`];
  for (const [signature, count] of shapes) lines.push(`  shape ${signature}: ${count}`);
  lines.push(`highest share of one shape: ${highest}%`);
  lines.push(`same shape as a structure-topic example: ${sameAsTopic}`);
  lines.push(`section names used in more than one version: ${repeated.length > 0 ? repeated.join(', ') : 'none'}`);
  return lines;
}

/** Renders the report text (no trailing process concerns): the exact line shapes the CLI prints. */
export function formatReport({ file, unreadable, versions, ids, topicSignatures = [] }) {
  const lines = [];
  const suffix = unreadable > 0 ? ` (${unreadable} unreadable lines skipped)` : '';
  lines.push(`Tint report for ${versions.length} versions from ${file}${suffix}`);
  for (const v of versions) {
    const labelPart = v.label ? ` "${v.label}"` : '';
    lines.push(`#${v.id} ${v.origin}${labelPart}`);
    lines.push(`  sounds: ${v.sounds.length > 0 ? v.sounds.join(', ') : '(none named)'}`);
    lines.push(`  scales: ${v.scales.length > 0 ? v.scales.join(', ') : '(none)'}`);
    lines.push(`  tempo: ${v.tempo.length > 0 ? v.tempo.join(', ') : 'default (0.5 cycles per second)'}`);
    lines.push(`  flute: ${v.flute ? 'yes' : 'no'}`);
    lines.push(`  reference demo lines reused: ${v.reused.length > 0 ? v.reused.length : 'none'}`);
    for (const reusedLine of v.reused) {
      lines.push(`    ${reusedLine}`);
    }
    lines.push(structureLine(v.structure ?? structureMetrics(v.code)));
  }
  if (ids && ids.length >= 2) {
    lines.push('Similarity (same request):');
    const byId = new Map(versions.map((v) => [v.id, v]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i]);
        const b = byId.get(ids[j]);
        const overlap = similarity(a.code, b.code);
        const shared = identicalLines(a.code, b.code);
        lines.push(`  #${ids[i]} vs #${ids[j]}: ${overlap} token overlap, ${shared} identical lines`);
      }
    }
  }
  lines.push('Structure across versions:');
  for (const line of structureSummary(versions.map((v) => v.structure ?? structureMetrics(v.code)), topicSignatures)) {
    lines.push(line);
  }
  lines.push('Measurement only: nothing in this report is sent to Claude.');
  return lines.join('\n') + '\n';
}

function readDemoLines(scriptDir) {
  const referenceDir = path.join(scriptDir, '..', 'reference');
  let files;
  try {
    files = readdirSync(referenceDir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  const markdownTexts = files.map((name) => readFileSync(path.join(referenceDir, name), 'utf8'));
  return withoutHelperLines(demoLines(markdownTexts));
}

/** The shapes of the structure topic's examples; a topic file that cannot be read is an error, not zero shapes. */
export function readTopicSignatures(scriptDir) {
  const topicPath = path.join(scriptDir, '..', 'reference', 'structure.md');
  let text;
  try {
    text = readFileSync(topicPath, 'utf8');
  } catch (err) {
    throw fail(`cannot read the structure topic at ${topicPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return structureTopicSignatures(text);
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const dataDir = args.dataDir ?? resolveDataDir();
  const historyPath = path.join(dataDir, HISTORY_FILE_NAME);

  let text;
  try {
    text = readFileSync(historyPath, 'utf8');
  } catch {
    console.error(`tint:report: no history file at ${historyPath}`);
    process.exitCode = 1;
    return;
  }

  const { versions: allVersions, unreadable } = parseHistoryText(text);

  let selected;
  if (args.ids) {
    selected = [];
    for (const id of args.ids) {
      const found = allVersions.find((v) => v.id === id);
      if (!found) {
        console.error(`tint:report: no version #${id}`);
        process.exitCode = 1;
        return;
      }
      selected.push(found);
    }
  } else {
    selected = allVersions.slice(-args.last);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const demo = readDemoLines(scriptDir);

  const analyzed = selected.map((v) => ({
    ...v,
    sounds: soundsUsed(v.code),
    scales: scalesUsed(v.code),
    tempo: tempoUsed(v.code),
    flute: hasFlute(v.code, v.label),
    reused: reusedDemoLines(v.code, demo),
    structure: structureMetrics(v.code),
  }));

  const report = formatReport({
    file: historyPath,
    unreadable,
    versions: analyzed,
    ids: args.ids,
    topicSignatures: readTopicSignatures(scriptDir),
  });
  process.stdout.write(report);
  process.exitCode = 0;
}

// Runs only when executed directly (same guard as scripts/check-reference.mjs), so tests can
// import the pure functions above without spawning a process.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
