// Pure module for Moontide's browser page: reads the song structure a piece declares in its own code. The structure
// is one top-level constant named song (sections with lengths, a cell for every track in every section, optional
// nested groups) that a few helper lines in the same code turn into one section clock and one lookup per track. The
// page reads only the text of the code: nothing is evaluated, and a shape it cannot read says why, in one sentence.
// `parse` (acorn) and `tracks` (from page/tracks.js extractTracks) are injected, so this module has no DOM access at
// import time and can be imported directly by node:test and by page/main.js without a build step. Its one import is
// the harmony reader, which has no DOM access either.

import { readHarmony, readHarmonyText } from './harmony.js';

export const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true };

/** The longest source quote or name a sentence carries, in code points. */
export const MAX_SOURCE_LENGTH = 40;
/** The longest harmony text the list shows, in code points; the whole text stays in the element's title. */
export const MAX_HARMONY_SHOWN = 60;

/** The three helper statements, by the name each one binds. */
export const HELPER_NAMES = ['total', 'clock', 'play'];

/**
 * The helper a structured piece carries, written as is at the top of the piece. The page compares the three
 * statements of the code with these, whitespace runs counting as one space, and says when they differ.
 * Names are single-quoted strings and the messages are joined with + (a double-quoted string or a template literal
 * is a mini-notation pattern in the page's transpiler).
 */
export const HELPER_TEXT = [
  'const total = song.sections.reduce((a, [, n]) => a + n, 0);',
  'const clock = timeCat(...song.sections.map(([name, n]) => [n, pure(name)])).slow(total).late(song.shift);',
  'const play = (track, variations) => {',
  '  const cells = {};',
  '  for (const [name, , own] of song.sections) {',
  "    const key = (song.plan[name] || {})[track];",
  "    if (key === undefined) throw new Error('song: section ' + name + ' has no cell for track ' + track);",
  "    const v = key === '-' ? silence : variations[key];",
  "    if (v === undefined) throw new Error('song: section ' + name + ', track ' + track + ': no variation ' + key + ' (it has ' + Object.keys(variations).join(', ') + ')');",
  "    cells[name] = typeof v === 'function' ? v(own || harmony) : Array.isArray(v) ? v[1] : v;",
  '  }',
  '  return clock.pickRestart(cells);',
  '};',
].join('\n');

/**
 * Page-visible copy for the song list and its lines. `{name}` placeholders are filled by fillSong(). `reasons` holds
 * one clause for every shape the page cannot read, by reason id; the clauses state a fact about what the page reads and
 * never what to write.
 */
export const SONG_COPY = {
  sectionOne: '{count} section',
  sectionMany: '{count} sections',
  cycleOne: '{count} cycle',
  cycleMany: '{count} cycles',
  summary: '{sections}, {cycles}',
  summaryShifted: '{sections}, {cycles}, shifted by {shift}',
  cellRest: 'rest',
  cellFollows: 'follows the harmony',
  cellFixed: 'fixed to {harmony}',
  harmonyOwn: 'harmony {text}',
  harmonyPiece: 'harmony {text} (from the piece)',
  harmonyNone: 'no harmony declared',
  harmonyUnreadable: 'harmony not readable',
  cannotRead: "Parts can't read this song: {reason}.",
  helperChanged: 'The play() helper was changed, so the page cannot vouch for what plays.',
  helperMissing: 'The play() helper is missing, so the page cannot vouch for what plays.',
  // The Song grid that replaces the list for a readable song.
  viewTitle: 'Song',
  launchLabel: 'Launch at',
  launchGroupTitle: 'When a launched section starts: at the end of the section that plays, on the next phrase or on the next bar.',
  launchSection: 'end of section',
  launchSectionName: 'Sections start at the end of the section that plays',
  launchPhrase: 'next phrase',
  launchPhraseName: 'Sections start on the next phrase',
  launchBar: 'next bar',
  launchBarName: 'Sections start on the next bar',
  launchWord: 'Launch',
  playingState: 'Playing {n}/{length}',
  playingTitle: 'Playing, cycle {n} of {length}',
  idleTitleSection: 'Starts at the end of the section that plays. Click to queue it.',
  idleTitlePhrase: 'Starts on the next phrase. Click to queue it.',
  idleTitleBar: 'Starts on the next bar. Click to queue it.',
  stoppedTitle: 'Starts the piece at this section.',
  queuedState: 'Queued — {countdown}',
  cancelWord: 'Cancel',
  queuedTitle: 'Queued. Click to cancel.',
  // The sentence under the toolbar: why the grid is off, what waits, or why a gesture changed nothing.
  lineDisconnected: 'Disconnected — the grid is off until Moontide reconnects.',
  lineQueued: "Section {section} is queued — cells can't change until it starts. Click it again to cancel.",
  lineAlready: 'Section {section} already starts on that line, so the code stays as it is. Click it again to hide the countdown.',
  lineWaiting: 'A change is waiting for its bar line. The grid works again when it takes over.',
  lineDirty: 'The editor has changes that are not playing yet. Evaluate them first — the grid works on the playing code.',
  // One sentence for each reason a gesture on the grid is refused, by id; an id that is not here throws.
  refusals: {
    'section-gone': 'That section changed in the code since you clicked. Nothing was changed.',
    'cell-gone': 'That cell changed in the code since you clicked. Nothing was changed.',
    'variation-gone': 'That variation is no longer in the code. Nothing was changed.',
    'name-unwritable': "That variation's name cannot be written into the plan as it is. Nothing was changed.",
    'not-evaluated': 'The change did not evaluate, so the code is as it was.',
    'line-moved': 'The launch could not be placed on its line, so nothing changed.',
    'not-written': 'The page could not write that change into the editor, so the code is as it was.',
  },
  now: 'Playing section {section}, cycle {n} of {length}.',
  // The list that opens on a cell, the cell while its change waits for a line, and the history label of a cell change.
  listLabel: 'Variation for {track} in section {section}',
  listCurrent: 'current',
  listShared: 'Section {section} is used {n} times; the change applies to each use.',
  waitBar: 'waiting for the next bar',
  waitPhrase: 'waiting for the next phrase',
  cellRecord: 'changed {track} in {section}: {choice}',
  foldTitle: 'Fold {group}',
  openTitle: 'Open {group}',
  trackOne: '1 track',
  trackMany: '{count} tracks',
  usedTimes: 'used {n} times',
  usedTitle: 'This section is used {n} times (columns {columns}); its cells are shared.',
  cellTitle: '{track}, section {section}: {variation}. Click to change.',
  cellTitleRest: '{track}, section {section}: rest. Click to change.',
  cellTitleDegrees: '{track}, section {section}: {variation}, follows the harmony',
  cellTitleFixed: '{track}, section {section}: {variation}, fixed to {harmony}',
  outside: 'outside the song plan: plays in every section',
  differs: 'What plays differs from the declaration at the start of section {section}, track {track}.',
  differsMore: 'What plays differs from the declaration at the start of section {section}, track {track} (and {count} more places).',
  differsMoreOne: 'What plays differs from the declaration at the start of section {section}, track {track} (and 1 more place).',
  checkFailed: 'The page could not check what plays against the declaration.',
  // Under a fixed variation: whether its notes are in the scale of the section's harmony (words only, nothing is changed).
  fitFits: 'fits',
  fitNot: 'does not fit ({notes})',
  fitMore: '{notes} and {count} more',
  fitCannot: 'cannot check',
  fitChip: ' \u00b7 {fit}',
  fitTitleFits: '{track}, section {section}: {variation}, fixed to {harmony}. Its notes are all in {sectionHarmony}.',
  fitTitleNot: '{track}, section {section}: {variation}, fixed to {harmony}. These notes are outside {sectionHarmony}: {notes}. Nothing is changed.',
  fitTitleCannot: '{track}, section {section}: {variation}, fixed to {harmony}. {reason}',
  // One sentence for each reason the fit of a variation cannot be checked, by id; an id that is not here throws.
  fitReasons: {
    'no-harmony': 'This section declares no harmony.',
    'harmony-unreadable': 'The harmony of this section is not readable.',
    'harmony-unknown': 'The harmony is not one of the nine scales the page knows.',
    'no-notes': 'The page found no pitched notes to compare.',
    'not-read': 'The page could not read the notes of this variation.',
    'too-slow': 'Reading the notes of this variation took too long.',
  },
  reasons: {
    'song-not-const': 'song is declared with let or var; the page reads only const',
    'song-not-object': 'song is {source}, not an object written out in the code',
    'no-sections': 'song has no sections',
    'section-not-entry': 'section {section} is not a name and a length written out in the code ({source})',
    'section-name-not-text': 'section {section} has a name that is not a single-quoted string ({source})',
    'section-name-empty': 'section {section} has an empty name; a section needs a name of at least one character',
    'length-not-plain-number': 'the length of section {section} is not a plain number ({source})',
    'length-not-whole': 'the length of section {section} is not a whole number ({source})',
    'length-not-above-zero': 'the length of section {section} is not above zero ({source})',
    'total-too-long': 'the lengths of the sections add up to more than the page can count, at section {section}',
    'section-harmony-unreadable': 'the harmony of section {section} is not scale or chord text in single quotes ({source})',
    'section-repeated-harmony': 'section {section} is listed more than once with different harmonies; every use plays the variations made for its last entry',
    'shift-missing': 'song has no shift',
    'shift-not-number': 'song.shift is {source}, not a number written in the code',
    'plan-missing': 'song.plan is missing or not written out as names',
    'plan-unknown-section': 'song.plan has a section {source} that song does not list',
    'plan-unknown-track': 'song.plan names track {track}, which has no labeled statement',
    'cell-missing': 'section {section} has no cell for track {track}',
    'cell-not-text': 'the cell of section {section}, track {track} is not a single-quoted name ({source})',
    'cell-unknown-variation': 'section {section}, track {track} names variation {source}, which {track} does not define',
    'variations-unreadable': 'the variations of {track} are not written out as a top-level const object ({source})',
    'label-mismatch': 'the statement labeled {track} passes {source} to play(); the label and that name must be the same',
    'play-call-unreadable': 'the statement labeled {track} does not give play() a single-quoted name and a const ({source})',
    'track-repeated': 'more than one statement is labeled {track}',
    'groups-not-data': 'song.groups is not written out as nested lists of track names ({source})',
    'group-unknown-track': 'group {group} lists {track}, which has no labeled statement',
    'groups-duplicate-track': 'song.groups lists {track} more than once',
    'groups-duplicate-group': 'song.groups has two groups named {group} side by side; the page cannot tell them apart',
    'key-not-plain': '{source} is a computed or double-quoted name; the page reads only plain and single-quoted names in song and in a track\'s variations',
    'duplicate-key': 'the name {source} is written twice in one object; JavaScript keeps only the last one',
    'name-inherited': '{source} is a name every JavaScript object already has, so the page cannot tell it from a missing one',
    'fixed-not-pair': 'variation {variation} of {track} is a list but not a harmony and a pattern ({source})',
    'fixed-harmony-unreadable': 'variation {variation} of {track} declares the harmony {source}, which is not scale or chord text in single quotes',
    'variation-kind-unknown': 'variation {variation} of {track} is a name or an expression, so the page cannot tell a pattern from a function or a pair ({source})',
    'degrees-without-harmony': 'variation {variation} of {track} follows the harmony, but section {section} declares none and the code has no harmony constant',
  },
};

/** The ids of every shape the page cannot read. */
export const SONG_REASONS = Object.freeze(Object.keys(SONG_COPY.reasons));

/** The ids of every reason a gesture on the Song grid is refused. */
export const SONG_REFUSALS = Object.freeze(Object.keys(SONG_COPY.refusals));

/** Replaces each `{name}` in `template` with `values[name]`; a missing value throws (loud). */
export function fillSong(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (values[name] === undefined || values[name] === null) {
      throw new Error(`Moontide: the song copy needs a value for '${name}'.`);
    }
    return String(values[name]);
  });
}

function reasonClause(reason) {
  const clause = SONG_COPY.reasons[reason];
  if (typeof clause !== 'string') throw new Error(`Moontide: unknown song reason '${String(reason)}'.`);
  return clause;
}

// ---- text that comes from the code ----

/** Control, format, line separator and paragraph separator characters: none of them may reach a line of text. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `text` with every hidden character replaced by a space. */
export function cleanText(text) {
  return text.replace(HIDDEN_CHARACTERS, ' ');
}

/** `text` cut at `max` code points, an ellipsis as the last one. */
export function cutText(text, max) {
  const points = [...text];
  if (points.length <= max) return text;
  return `${points.slice(0, max - 1).join('')}…`;
}

/** A name from the code as the page shows it: hidden characters replaced by a space, cut at 40 code points. */
export function displayName(text) {
  return cutText(cleanText(String(text)), MAX_SOURCE_LENGTH);
}

/** A harmony text as the list shows it: hidden characters replaced by a space, cut at 60 code points. */
export function displayHarmony(text) {
  return cutText(cleanText(String(text)), MAX_HARMONY_SHOWN);
}

/** A name inside a sentence: in single quotes, or the 1-based position number of an entry whose name cannot be read. */
export function quoted(value) {
  return typeof value === 'number' ? String(value) : `'${displayName(value)}'`;
}

/** `n` and its noun in the singular or the plural form. */
export function countText(n, one, many) {
  return fillSong(n === 1 ? one : many, { count: n });
}

/** The corner line of the grid: how many sections, how many cycles, and the shift when there is one. */
export function summaryText(reading) {
  const sections = countText(reading.sections.length, SONG_COPY.sectionOne, SONG_COPY.sectionMany);
  const cycles = countText(reading.total, SONG_COPY.cycleOne, SONG_COPY.cycleMany);
  if (reading.shift === 0) return fillSong(SONG_COPY.summary, { sections, cycles });
  const shift = countText(reading.shift, SONG_COPY.cycleOne, SONG_COPY.cycleMany);
  return fillSong(SONG_COPY.summaryShifted, { sections, cycles, shift });
}

/** The text of a section's harmony in the grid, and the whole harmony text when the shown one was cut (else null). */
export function harmonyParts(harmony) {
  if (harmony.from === 'none') return { text: SONG_COPY.harmonyNone, whole: null };
  if (harmony.from === 'piece-unreadable') return { text: SONG_COPY.harmonyUnreadable, whole: null };
  const shown = displayHarmony(harmony.text);
  const whole = shown === cleanText(harmony.text) ? null : cleanText(harmony.text);
  const template = harmony.from === 'own' ? SONG_COPY.harmonyOwn : SONG_COPY.harmonyPiece;
  return { text: fillSong(template, { text: shown }), whole };
}

// ---- sentences ----

/** The sentence for a song the page cannot read. Throws for any other reading. */
export function songMessageText(reading) {
  if (reading === null || typeof reading !== 'object' || reading.state !== 'unreadable') {
    throw new Error('Moontide: songMessageText needs an unreadable song reading.');
  }
  const pick = (value) => (value === null || value === undefined ? null : quoted(value));
  const clause = fillSong(reasonClause(reading.reason), {
    section: pick(reading.section),
    track: pick(reading.track),
    group: pick(reading.group),
    variation: pick(reading.variation),
    source: reading.source,
  });
  return fillSong(SONG_COPY.cannotRead, { reason: clause });
}

/** The sentence for a helper that is not the canonical text, or null when it is. */
export function helperLine(helper) {
  if (helper === 'canonical') return null;
  if (helper === 'changed') return SONG_COPY.helperChanged;
  if (helper === 'missing') return SONG_COPY.helperMissing;
  throw new Error(`Moontide: unknown helper state '${String(helper)}'.`);
}

/** The sentence for what plays differing from the declaration: the first place, and how many more there are. */
export function differsLine({ section, track, more }) {
  const values = { section: quoted(section), track: quoted(track), count: more };
  if (more === 0) return fillSong(SONG_COPY.differs, values);
  return fillSong(more === 1 ? SONG_COPY.differsMoreOne : SONG_COPY.differsMore, values);
}

/** The lines the page knows right after reading the code, the same sentences it shows and sends to Claude. */
export function songNoteLines(reading) {
  if (reading.state === 'unreadable') return [songMessageText(reading)];
  if (reading.state === 'read') {
    const line = helperLine(reading.helper);
    return line === null ? [] : [line];
  }
  return [];
}

// ---- reading the code ----

/** The names of Object.prototype: a section, track or variation with one of them cannot be told from a missing one. */
const INHERITED_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

/** Mirrors collectPatternNames in page/harmony.js; keep the two in step. The names a binding pattern binds, pushed to `names`. */
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

/** The source of `node`, hidden characters replaced and cut at MAX_SOURCE_LENGTH code points. */
function sourceOf(code, node) {
  return cutText(cleanText(code.slice(node.start, node.end)), MAX_SOURCE_LENGTH);
}

/** True for a string literal written with single quotes (a double-quoted string is a pattern in the page's transpiler). */
function singleQuoted(node) {
  return node !== null && node !== undefined && node.type === 'Literal' && typeof node.value === 'string' && node.raw.startsWith("'");
}

/** The value of a number literal, with a minus sign allowed in front; null for anything else. */
function numberLiteral(node) {
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
    return -node.argument.value;
  }
  return null;
}

/** Every top-level binding of `name`: `{ statement, kind, declarator, init }`, in code order. */
function bindingsOf(ast, name) {
  const found = [];
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        const names = [];
        collectPatternNames(declarator.id, names);
        if (names.includes(name)) found.push({ statement, kind: statement.kind, declarator, init: declarator.init ?? null });
      }
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id && statement.id.name === name) {
      found.push({ statement, kind: statement.type === 'FunctionDeclaration' ? 'function' : 'class', declarator: null, init: null });
    }
  }
  return found;
}

/**
 * The entries of an object literal, `[{ key, keyNode, value }]`, or `{ problem }` for the first entry that is not a
 * plain name: a spread, a method kind that is not a value, a computed or double-quoted name, a name written twice, a name
 * every object already has.
 */
function readObject(code, node) {
  const entries = [];
  const seen = new Set();
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init') {
      return { problem: { reason: 'key-not-plain', source: sourceOf(code, property) } };
    }
    const key = property.key.type === 'Identifier' ? property.key.name : singleQuoted(property.key) ? property.key.value : null;
    if (key === null) return { problem: { reason: 'key-not-plain', source: sourceOf(code, property.key) } };
    if (INHERITED_NAMES.has(key)) return { problem: { reason: 'name-inherited', source: sourceOf(code, property.key) } };
    if (seen.has(key)) return { problem: { reason: 'duplicate-key', source: sourceOf(code, property.key) } };
    seen.add(key);
    entries.push({ key, keyNode: property.key, value: property.value, method: property.method === true });
  }
  return { entries };
}

const normalizeSpace = (text) => text.replace(/\s+/g, ' ').trim();

let helperReference = null;

/** The normalized text of each canonical helper statement, by the name it binds. Parsed once. */
function canonicalHelper(parse) {
  if (helperReference === null) {
    const reference = new Map();
    for (const statement of parse(HELPER_TEXT, PARSE_OPTIONS).body) {
      reference.set(statement.declarations[0].id.name, normalizeSpace(HELPER_TEXT.slice(statement.start, statement.end)));
    }
    helperReference = reference;
  }
  return helperReference;
}

/** 'canonical' when the three helper statements are the canonical text, 'missing' when none is bound, else 'changed'. */
function helperState(code, ast, parse) {
  const reference = canonicalHelper(parse);
  let bound = 0;
  let equal = 0;
  for (const name of HELPER_NAMES) {
    const [binding] = bindingsOf(ast, name);
    if (binding === undefined) continue;
    bound += 1;
    if (normalizeSpace(code.slice(binding.statement.start, binding.statement.end)) === reference.get(name)) equal += 1;
  }
  if (bound === 0) return 'missing';
  return equal === HELPER_NAMES.length ? 'canonical' : 'changed';
}

/** The innermost call of a chain of `.method(args)` calls: `a.b(1).c(2)` gives the node of `a.b(1)`'s root. */
function chainRoot(node) {
  let current = node;
  while (current && current.type === 'CallExpression' && current.callee.type === 'MemberExpression' && !current.callee.computed) {
    current = current.callee.object;
  }
  return current;
}

/**
 * The song groups as written, walked without recursion: `{ groups, pairs, grouped }` with `groups` the top-level groups
 * (`{ name, items: [{ track } | { group }] }`), `pairs` every `{ group, track }` in written order and `grouped` the set of
 * track names; or `{ problem }`. A group is an array of track names (and, in an array, one-key group objects) or an
 * object of groups.
 */
function readGroups(code, node) {
  const root = { name: null, items: [] };
  const pairs = [];
  const grouped = new Set();
  const top = readObject(code, node);
  if (top.problem) return { problem: top.problem };
  const stack = [{ kind: 'entries', list: top.entries, index: 0, parent: root }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.list.length) {
      stack.pop();
      continue;
    }
    const element = frame.list[frame.index];
    frame.index += 1;
    if (frame.kind === 'entries') {
      // Two groups with one name side by side would share one fold state and one Mixer frame, so refuse them.
      if (frame.parent.items.some((item) => item.group !== undefined && item.group.name === element.key)) {
        return { problem: { reason: 'groups-duplicate-group', group: element.key } };
      }
      const group = { name: element.key, items: [] };
      frame.parent.items.push({ group });
      const body = element.value;
      if (body.type === 'ArrayExpression') {
        stack.push({ kind: 'items', list: body.elements, index: 0, parent: group });
      } else if (body.type === 'ObjectExpression') {
        const inner = readObject(code, body);
        if (inner.problem) return { problem: inner.problem };
        stack.push({ kind: 'entries', list: inner.entries, index: 0, parent: group });
      } else {
        return { problem: { reason: 'groups-not-data', source: sourceOf(code, body) } };
      }
    } else if (singleQuoted(element)) {
      if (grouped.has(element.value)) return { problem: { reason: 'groups-duplicate-track', track: element.value } };
      grouped.add(element.value);
      frame.parent.items.push({ track: element.value });
      pairs.push({ group: frame.parent.name, track: element.value });
    } else if (element !== null && element.type === 'ObjectExpression') {
      const inner = readObject(code, element);
      if (inner.problem) return { problem: inner.problem };
      stack.push({ kind: 'entries', list: inner.entries, index: 0, parent: frame.parent });
    } else {
      return { problem: { reason: 'groups-not-data', source: element === null ? sourceOf(code, node) : sourceOf(code, element) } };
    }
  }
  return { groups: root.items.map((item) => item.group), pairs, grouped };
}

/**
 * The kinds of expression that are a pattern as far as the text says: a call (note(...), s(...).slow(2)), a quoted text, a
 * template or an object, none of which is a function or a pair. A name, a member or a condition could be either at run
 * time, and the page cannot tell which from the text.
 */
const PATTERN_NODES = new Set(['CallExpression', 'Literal', 'TemplateLiteral', 'TaggedTemplateExpression', 'ObjectExpression']);

/** The keys a song declaration is made of; an object holding none of them is just a constant named song. */
const SONG_KEYS = ['sections', 'plan', 'shift'];

/**
 * Whether the piece declares a song structure: a top-level play binding says so, and so does a song object that holds one
 * of the keys of a declaration. A constant named song that is neither (an older piece may name any constant song) is not one.
 */
function declaresStructure(ast, songInit, songIsObject) {
  if (bindingsOf(ast, 'play').length > 0) return true;
  if (!songIsObject) return false;
  return songInit.properties.some((property) => {
    if (property.type !== 'Property' || property.computed) return false;
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
    return SONG_KEYS.includes(key);
  });
}

/**
 * Reads the song structure of `code`. `tracks` is extractTracks(code, { parse }). Returns plain data:
 * - `{ state: 'none' }` for a piece without a structure: no top-level song, or a song that holds none of the keys sections,
 *   plan and shift while the code binds no top-level play (an older piece may name any constant song);
 * - `{ state: 'unreadable', reason, section, track, group, variation, source, helper }`: the first problem in a fixed
 *   order (the song, the sections, the shift, the plan, the groups, the statements, the variations, the cells), a reason
 *   id of SONG_REASONS with the names and the quoted source its sentence needs (unused fields null);
 * - `{ state: 'read', helper, shift, shiftRange, total, pieceHarmony, sections, tracks, groups, ungrouped }`.
 * `helper` is 'canonical' | 'changed' | 'missing'. Nothing is evaluated. Every range is `{ start, end }` offsets into the
 * exact `code` that was parsed: `shiftRange` is the shift value (a leading minus included), a cell's `range` the plan string
 * of its section's name for its track (a rest included; entries that share a name share the range). A section also keeps
 * its `ownHarmony` text (or null), and a track every variation of its constant, `variations: [{ key, kind, fixedHarmony }]`
 * in code order, used or not.
 */
export function readStructure(code, { parse, tracks }) {
  const ast = parse(code, PARSE_OPTIONS);
  const [songBinding] = bindingsOf(ast, 'song');
  if (songBinding === undefined) return { state: 'none' };
  const songInit = songBinding.init;
  const songIsObject = songInit !== null && songInit.type === 'ObjectExpression';
  if (!declaresStructure(ast, songInit, songIsObject)) return { state: 'none' };

  const helper = helperState(code, ast, parse);
  const unreadable = (reason, fields = {}) => {
    reasonClause(reason);
    return { state: 'unreadable', reason, section: null, track: null, group: null, variation: null, source: null, helper, ...fields };
  };
  const problemOf = ({ reason, ...fields }) => unreadable(reason, fields);

  // The song.
  if (songBinding.kind !== 'const') return unreadable('song-not-const');
  if (!songIsObject || songBinding.declarator.id.type !== 'Identifier') {
    return unreadable('song-not-object', { source: sourceOf(code, songInit ?? songBinding.statement) });
  }
  const songObject = readObject(code, songInit);
  if (songObject.problem) return problemOf(songObject.problem);
  const songEntry = (name) => songObject.entries.find((entry) => entry.key === name);

  // The sections.
  const sectionsEntry = songEntry('sections');
  if (sectionsEntry === undefined || sectionsEntry.value.type !== 'ArrayExpression' || sectionsEntry.value.elements.length === 0) {
    return unreadable('no-sections');
  }
  const sections = [];
  const firstHarmony = new Map();
  let total = 0;
  for (let i = 0; i < sectionsEntry.value.elements.length; i++) {
    const position = i + 1;
    const element = sectionsEntry.value.elements[i];
    if (
      element === null ||
      element.type !== 'ArrayExpression' ||
      element.elements.length < 2 ||
      element.elements.length > 3 ||
      element.elements.some((part) => part === null || part.type === 'SpreadElement')
    ) {
      return unreadable('section-not-entry', { section: position, source: sourceOf(code, element ?? sectionsEntry.value) });
    }
    const [nameNode, lengthNode, harmonyNode] = element.elements;
    if (!singleQuoted(nameNode)) return unreadable('section-name-not-text', { section: position, source: sourceOf(code, nameNode) });
    const name = nameNode.value;
    if (name === '') return unreadable('section-name-empty', { section: position });
    if (INHERITED_NAMES.has(name)) return unreadable('name-inherited', { source: sourceOf(code, nameNode) });
    const length = numberLiteral(lengthNode);
    if (length === null) return unreadable('length-not-plain-number', { section: name, source: sourceOf(code, lengthNode) });
    if (!Number.isSafeInteger(length)) return unreadable('length-not-whole', { section: name, source: sourceOf(code, lengthNode) });
    if (length <= 0) return unreadable('length-not-above-zero', { section: name, source: sourceOf(code, lengthNode) });
    const start = total;
    total += length;
    if (!Number.isSafeInteger(total)) return unreadable('total-too-long', { section: name });
    let ownHarmony = null;
    if (harmonyNode !== undefined) {
      if (!singleQuoted(harmonyNode) || readHarmonyText(harmonyNode.value) === null) {
        return unreadable('section-harmony-unreadable', { section: name, source: sourceOf(code, harmonyNode) });
      }
      ownHarmony = harmonyNode.value;
    }
    sections.push({ name, length, start, ownHarmony });
  }
  for (const section of sections) {
    if (!firstHarmony.has(section.name)) firstHarmony.set(section.name, section.ownHarmony);
    else if (firstHarmony.get(section.name) !== section.ownHarmony) return unreadable('section-repeated-harmony', { section: section.name });
  }

  // The shift.
  const shiftEntry = songEntry('shift');
  if (shiftEntry === undefined) return unreadable('shift-missing');
  const shift = numberLiteral(shiftEntry.value);
  if (shift === null || !Number.isFinite(shift)) return unreadable('shift-not-number', { source: sourceOf(code, shiftEntry.value) });
  for (const section of sections) section.start += shift;
  // The source range of the shift value (a leading minus included), so an edit can replace exactly that text.
  const shiftRange = { start: shiftEntry.value.start, end: shiftEntry.value.end };

  // The plan: the cells by section, then by track.
  const planEntry = songEntry('plan');
  if (planEntry === undefined || planEntry.value.type !== 'ObjectExpression') return unreadable('plan-missing');
  const planObject = readObject(code, planEntry.value);
  if (planObject.problem) return problemOf(planObject.problem);
  const sectionNames = new Set(sections.map((section) => section.name));
  const planCells = new Map();
  for (const planned of planObject.entries) {
    if (!sectionNames.has(planned.key)) return unreadable('plan-unknown-section', { source: sourceOf(code, planned.keyNode) });
    if (planned.value.type !== 'ObjectExpression') return unreadable('plan-missing');
    const cellObject = readObject(code, planned.value);
    if (cellObject.problem) return problemOf(cellObject.problem);
    const cells = new Map();
    for (const cell of cellObject.entries) {
      if (!singleQuoted(cell.value)) {
        return unreadable('cell-not-text', { section: planned.key, track: cell.key, source: sourceOf(code, cell.value) });
      }
      cells.set(cell.key, { key: cell.value.value, node: cell.value });
    }
    planCells.set(planned.key, cells);
  }

  // The groups.
  let groups = [];
  let groupPairs = [];
  let grouped = new Set();
  const groupsEntry = songEntry('groups');
  if (groupsEntry !== undefined) {
    if (groupsEntry.value.type !== 'ObjectExpression') return unreadable('groups-not-data', { source: sourceOf(code, groupsEntry.value) });
    const read = readGroups(code, groupsEntry.value);
    if (read.problem) return problemOf(read.problem);
    ({ groups, pairs: groupPairs, grouped } = read);
  }

  // The statements: the tracks whose statement is a play() call, in code order.
  const expressionByStart = new Map();
  for (const statement of ast.body) {
    if (statement.type === 'LabeledStatement' && statement.body.type === 'ExpressionStatement') {
      expressionByStart.set(statement.body.expression.start, statement.body.expression);
    }
  }
  const playTracks = [];
  const statements = [];
  const byName = new Map();
  for (const track of tracks) {
    if (track.kind !== 'label') continue;
    const expression = expressionByStart.get(track.start);
    const root = expression === undefined ? null : chainRoot(expression);
    if (root === null || root.type !== 'CallExpression' || root.callee.type !== 'Identifier' || root.callee.name !== 'play') {
      statements.push({ track, play: null });
      continue;
    }
    const [nameNode, constNode] = root.arguments;
    if (root.arguments.length !== 2 || !singleQuoted(nameNode) || constNode.type !== 'Identifier') {
      return unreadable('play-call-unreadable', { track: track.label, source: sourceOf(code, root) });
    }
    const name = nameNode.value;
    if (!track.label.includes('$') && track.baseLabel !== name) {
      return unreadable('label-mismatch', { track: track.label, source: sourceOf(code, nameNode) });
    }
    if (byName.has(name)) return unreadable('track-repeated', { track: name });
    const playTrack = { name, label: track.label, index: track.index, constName: constNode.name, muted: track.muted, constNode, cells: [] };
    byName.set(name, playTrack);
    playTracks.push(playTrack);
    statements.push({ track, play: playTrack });
  }

  // Every track the plan or a group names has a statement.
  for (const cells of planCells.values()) {
    for (const trackName of cells.keys()) {
      if (!byName.has(trackName)) return unreadable('plan-unknown-track', { track: trackName });
    }
  }
  for (const pair of groupPairs) {
    if (!byName.has(pair.track)) return unreadable('group-unknown-track', { group: pair.group, track: pair.track });
  }

  // The variations of each track: one top-level const object.
  const variationsOf = new Map();
  for (const playTrack of playTracks) {
    const bindings = bindingsOf(ast, playTrack.constName);
    const [binding] = bindings;
    if (bindings.length !== 1 || binding.kind !== 'const' || binding.declarator === null || binding.declarator.id.type !== 'Identifier' || binding.init === null || binding.init.type !== 'ObjectExpression') {
      return unreadable('variations-unreadable', { track: playTrack.name, source: sourceOf(code, binding?.init ?? playTrack.constNode) });
    }
    const object = readObject(code, binding.init);
    if (object.problem) return problemOf(object.problem);
    const variations = new Map();
    for (const entry of object.entries) {
      const value = entry.value;
      let kind = 'other';
      let fixedHarmony = null;
      if (entry.method || value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
        kind = 'degrees';
      } else if (value.type === 'ArrayExpression') {
        const pair = value.elements.length === 2 && value.elements.every((part) => part !== null && part.type !== 'SpreadElement');
        if (!pair) {
          return unreadable('fixed-not-pair', { variation: entry.key, track: playTrack.name, source: sourceOf(code, value) });
        }
        if (!singleQuoted(value.elements[0]) || readHarmonyText(value.elements[0].value) === null) {
          return unreadable('fixed-harmony-unreadable', { variation: entry.key, track: playTrack.name, source: sourceOf(code, value.elements[0]) });
        }
        kind = 'fixed';
        fixedHarmony = value.elements[0].value;
      } else if (!PATTERN_NODES.has(value.type)) {
        return unreadable('variation-kind-unknown', { variation: entry.key, track: playTrack.name, source: sourceOf(code, value) });
      }
      variations.set(entry.key, { kind, fixedHarmony });
    }
    variationsOf.set(playTrack.name, variations);
    // Where the const object of the variations lies in the code: a note inside it belongs to this track's own variations.
    playTrack.constRange = { start: binding.init.start, end: binding.init.end };
    playTrack.variations = [...variations].map(([key, variation]) => ({ key, kind: variation.kind, fixedHarmony: variation.fixedHarmony }));
  }

  // The harmony of each section: its own, else the piece's.
  const piece = readHarmony(code, { parse });
  const pieceHarmony = { state: piece.state, text: piece.state === 'declared' ? piece.text : null };
  const harmonyOf = (ownHarmony) => {
    if (ownHarmony !== null) return { from: 'own', text: ownHarmony };
    if (piece.state === 'declared') return { from: 'piece', text: piece.text };
    return { from: piece.state === 'none' ? 'none' : 'piece-unreadable', text: null };
  };

  // The cells: one for every section and every track.
  const readSections = sections.map((section) => ({
    name: section.name,
    length: section.length,
    start: section.start,
    ownHarmony: section.ownHarmony,
    harmony: harmonyOf(section.ownHarmony),
  }));
  for (let i = 0; i < readSections.length; i++) {
    for (const playTrack of playTracks) {
      const planned = planCells.get(readSections[i].name)?.get(playTrack.name);
      if (planned === undefined) return unreadable('cell-missing', { section: readSections[i].name, track: playTrack.name });
      // The range is the plan string of the section's name for this track; entries of one name share it.
      const range = { start: planned.node.start, end: planned.node.end };
      if (planned.key === '-') {
        playTrack.cells.push({ section: i, key: null, kind: 'rest', fixedHarmony: null, range });
        continue;
      }
      const variation = variationsOf.get(playTrack.name).get(planned.key);
      if (variation === undefined) {
        return unreadable('cell-unknown-variation', { section: readSections[i].name, track: playTrack.name, source: sourceOf(code, planned.node) });
      }
      if (variation.kind === 'degrees' && readSections[i].harmony.from === 'none') {
        return unreadable('degrees-without-harmony', { section: readSections[i].name, track: playTrack.name, variation: planned.key });
      }
      playTrack.cells.push({ section: i, key: planned.key, kind: variation.kind, fixedHarmony: variation.fixedHarmony, range });
    }
  }

  const ungrouped = [];
  for (const { track, play } of statements) {
    if (play === null) ungrouped.push({ name: track.displayName, index: track.index, structured: false });
    else if (!grouped.has(play.name)) ungrouped.push({ name: play.name, index: track.index, structured: true });
  }
  return {
    state: 'read',
    helper,
    shift,
    shiftRange,
    total,
    pieceHarmony,
    sections: readSections,
    tracks: playTracks.map(({ name, label, index, constName, muted, variations, cells, constRange }) => ({ name, label, index, constName, muted, variations, cells, constRange })),
    groups,
    ungrouped,
  };
}
