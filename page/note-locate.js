// Pure module for Moontide's browser page: how a note drawn on the Timeline leads back to one place in the code, and
// whether that place may be rewritten. The pinned Strudel keeps, for each note it plays, the offsets of the strings it was
// read from (`event.locations`, a list of { start, end }). Which of those offsets is the note's own pitch is found by
// parsing the playing code: the string that holds an offset, and the call the string is an argument of (`note`, `n`,
// `velocity`, ...), never the position of the offset in the list, which moves with the chain. A note may be edited only when
// it leads back to exactly one double-quoted `note("...")` token, the code at it is the bare token, the pitch heard is the
// token's own pitch and the token lies in the code of the track alone. Every other note is refused with one reason. The
// offsets are good only against the exact code they were measured on, so nothing here caches across versions.
// `parse` (acorn) is injected, as in page/tracks.js, and nothing here touches the DOM, so node:test and page/main.js import
// the module without a build step.

import { PARSE_OPTIONS } from './tracks.js';
import { NOTE_NAME_TOKEN, eventKey, gainOf, noteNameToMidi, pitchOf, sameEvents, velocityOf } from './timeline.js';
import { playingSection } from './song-grid-model.js';

/** The reasons a note cannot be edited, in the order they are tried: the first that applies is the one given. */
export const NOTE_REASONS = Object.freeze(['no-token', 'no-pitch', 'several', 'degrees', 'escape', 'shifted', 'outside', 'shared']);

/** The characters a bare note token is made of; a token is the whole run of them around its place. */
const TOKEN_CHAR = /[A-Za-z0-9#._-]/;

/** A note written as a number: a whole number or a decimal. */
const NUMBER_TOKEN = /^-?\d+(\.\d+)?$/;

/**
 * The name of the call a string is a direct argument of: the name of an identifier callee (`note("...")`) or the property
 * of a non-computed member callee (`s("x").note("...")`). A string that is the object of a member (`"c3 e3".note()`) or sits
 * anywhere else has no call: null.
 */
function callOf(node, parent) {
  if (parent === null || parent.type !== 'CallExpression' || !parent.arguments.includes(node)) return null;
  const { callee } = parent;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return null;
}

/**
 * Reads the playing code once: `strings` are the string literals the pinned Strudel gives locations to (double-quoted
 * strings and untagged template literals; a single-quoted string carries no location and is left out), sorted by start,
 * each `{ start, end, raw, call }`; `declarations` are the top-level const, let and var declarators with an initializer, each
 * `{ name, start, end }` over the initializer; `references` maps a name to the offsets of the identifiers that read it.
 */
export function indexCode(code, { parse }) {
  const ast = parse(code, PARSE_OPTIONS);
  const strings = [];
  const declarations = [];
  const references = new Map();
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && typeof node.raw === 'string' && node.raw.startsWith('"')) {
      strings.push({ start: node.start, end: node.end, raw: node.raw, call: callOf(node, parent) });
      return;
    }
    if (node.type === 'TemplateLiteral' && (parent === null || parent.type !== 'TaggedTemplateExpression')) {
      strings.push({ start: node.start, end: node.end, raw: code.slice(node.start, node.end), call: callOf(node, parent) });
      return;
    }
    if (node.type === 'Identifier') {
      const isPropertyName = parent !== null && parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const isKey = parent !== null && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      if (!isPropertyName && !isKey) {
        if (!references.has(node.name)) references.set(node.name, []);
        references.get(node.name).push(node.start);
      }
      return;
    }
    for (const key in node) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node);
      } else if (value && typeof value.type === 'string') {
        visit(value, node);
      }
    }
  };
  visit(ast, null);
  strings.sort((a, b) => a.start - b.start);
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init) {
        declarations.push({ name: declarator.id.name, start: declarator.init.start, end: declarator.init.end });
      }
    }
  }
  return { strings, declarations, references };
}

/** The string literal that holds the place `location`, or null (a place in no string, such as a value made by code). */
function stringHolding(index, location) {
  const { strings } = index;
  let low = 0;
  let high = strings.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (strings[middle].start <= location.start) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found === -1) return null;
  const candidate = strings[found];
  return location.end <= candidate.end ? candidate : null;
}

/**
 * Where a track's own code lies: `{ index, kind, start, end }`. `kind` is 'variations' with the range of the track's own
 * variation const (page/structure.js constRange) when the piece declares a song the page can read and the track is built by
 * play(); for every other track it is 'statement' with the range of the track's own expression.
 */
export function trackScope({ track, reading }) {
  if (reading !== null && reading !== undefined && reading.state === 'read') {
    const play = reading.tracks.find((candidate) => candidate.index === track.index);
    if (play !== undefined && play.constRange !== undefined && play.constRange !== null) {
      return { index: track.index, kind: 'variations', start: play.constRange.start, end: play.constRange.end };
    }
  }
  return { index: track.index, kind: 'statement', start: track.start, end: track.end };
}

/**
 * Tells how many tracks read the top-level name `name`: a track reads it when an identifier with that name lies in its own
 * code, or in the initializer of a top-level declaration that is read in turn. `scopes` is the scope of every track.
 */
export function readerCounter(index, scopes) {
  const cache = new Map();
  const tracksReading = (name, visiting) => {
    const found = new Set();
    if (visiting.has(name)) return found;
    visiting.add(name);
    const offsets = index.references.get(name) ?? [];
    for (const scope of scopes) {
      if (offsets.some((offset) => offset >= scope.start && offset < scope.end)) found.add(scope.index);
    }
    for (const declaration of index.declarations) {
      if (declaration.name === name) continue;
      if (offsets.some((offset) => offset >= declaration.start && offset < declaration.end)) {
        for (const track of tracksReading(declaration.name, visiting)) found.add(track);
      }
    }
    return found;
  };
  return (name) => {
    if (!cache.has(name)) cache.set(name, tracksReading(name, new Set()).size);
    return cache.get(name);
  };
}

/** True when the code at `location` is a whole token: the run of token characters around it begins and ends there. */
function isBareToken(code, location) {
  if (!(location.end > location.start) || location.end > code.length) return false;
  let from = location.start;
  while (from > 0 && TOKEN_CHAR.test(code[from - 1])) from -= 1;
  let to = location.end;
  while (to < code.length && TOKEN_CHAR.test(code[to])) to += 1;
  return from === location.start && to === location.end;
}

/**
 * The note number a token stands for (a number or a note name spelled the way Strudel plays it and the page steps it), or null for
 * anything else. A name the page reads but Strudel does not play (a capital accidental, `EB3`) is null, so it is never offered for an edit.
 */
function tokenPitch(text) {
  if (NUMBER_TOKEN.test(text)) return Number(text);
  return NOTE_NAME_TOKEN.test(text) ? noteNameToMidi(text) : null;
}

/** The same places once each, in the order they came. */
function distinctLocations(locations) {
  const seen = new Set();
  const out = [];
  for (const location of locations) {
    const key = `${location.start}:${location.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(location);
  }
  return out;
}

/**
 * Says whether the note `event` (`{ begin, end, value, locations }`) can be edited. Gives `{ editable: true, token: { start,
 * end, text }, velocity }`, the one place in `code` that holds the note and what the page can do about its velocity, or
 * `{ editable: false, reason }` with the first of NOTE_REASONS that applies. `index` is indexCode(code), `scope` the scope of
 * the track the note belongs to, `scopes` the scope of every track, `readers(name)` how many tracks read the top-level name
 * and `midi` whether the note is on a MIDI lane (its default gain differs). `velocity` is `{ writable: true, token, gain,
 * shown }` when the velocity of the note comes from exactly one bare number in a double-quoted `velocity("...")` string in the
 * track's own code whose value is the note's velocity and the gain is a finite number other than 0 (`shown` is the velocity
 * the Timeline shows, gain times velocity); otherwise `{ writable: false }`.
 */
export function classifyNote({ code, index, event, scope, scopes, readers, midi = false }) {
  const refuse = (reason) => ({ editable: false, reason });
  const heard = pitchOf(event.value);
  if (heard === null) return refuse('no-pitch');
  const placed = distinctLocations(Array.isArray(event.locations) ? event.locations : [])
    .map((location) => ({ location, string: stringHolding(index, location) }))
    .filter((entry) => entry.string !== null);
  // A velocity string, a double-quoted scale and the weighted mini clock add places in other calls: only note and n count.
  const pitchPlaces = placed.filter((entry) => entry.string.call === 'note' || entry.string.call === 'n');
  if (pitchPlaces.length === 0) return refuse('no-token');
  if (pitchPlaces.length > 1) return refuse('several');
  const { location, string } = pitchPlaces[0];
  if (string.call === 'n') return refuse('degrees');
  if (string.raw.includes('\\') || !isBareToken(code, location)) return refuse('escape');
  const text = code.slice(location.start, location.end);
  const own = tokenPitch(text);
  if (own === null || own !== heard) return refuse('shifted');
  const token = { start: location.start, end: location.end, text };
  const holds = (candidate) => token.start >= candidate.start && token.end <= candidate.end;
  if (holds(scope)) {
    if (scopes.some((other) => other.index !== scope.index && holds(other))) return refuse('shared');
    return { editable: true, token, velocity: velocityOfNote({ code, event, placed, scope, scopes, midi }) };
  }
  const declaration = index.declarations.find(holds);
  return declaration !== undefined && readers(declaration.name) >= 2 ? refuse('shared') : refuse('outside');
}

/** The velocity part of an editable note's classification: see classifyNote. */
function velocityOfNote({ code, event, placed, scope, scopes, midi }) {
  const fixed = { writable: false };
  const places = placed.filter((entry) => entry.string.call === 'velocity');
  if (places.length !== 1) return fixed;
  const { location } = places[0];
  if (places[0].string.raw.includes('\\') || !isBareToken(code, location)) return fixed;
  const text = code.slice(location.start, location.end);
  if (!NUMBER_TOKEN.test(text)) return fixed;
  const token = { start: location.start, end: location.end, text };
  const holds = (candidate) => token.start >= candidate.start && token.end <= candidate.end;
  if (!holds(scope) || scopes.some((other) => other.index !== scope.index && holds(other))) return fixed;
  const value = event.value && typeof event.value === 'object' ? event.value : {};
  if (typeof value.velocity !== 'number' || Number(text) !== value.velocity) return fixed;
  const gain = gainOf(event.value, midi);
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain === 0) return fixed;
  const shown = velocityOf(event.value, midi);
  if (shown === undefined) return fixed;
  return { writable: true, token, gain, shown };
}

/** An event's key with one field of its value left out: the time and every other field. */
function keyWithout(event, field) {
  const value = event.value && typeof event.value === 'object' ? { ...event.value } : event.value;
  if (value && typeof value === 'object') delete value[field];
  return eventKey({ begin: event.begin, end: event.end, value });
}

/**
 * Compares the lane's events before an edit with the same lane read back from the edited code. `token` is the token that
 * was rewritten (the edit keeps its start) and `change` what was done to it: `{ kind: 'pitch', midi }`, `{ kind: 'rest' }`
 * or `{ kind: 'velocity', target, gain }`. The edit is confirmed when the notes that carried the token are, at the same
 * times, what the change says (a new pitch, gone, or a velocity that plays as `target`) with every other field unchanged, and
 * every other note is the same in time, value and count. Gives `{ ok: true }` or `{ ok: false, why }`.
 */
export function compareReadBack({ before, after, token, change }) {
  const known =
    change !== null &&
    typeof change === 'object' &&
    ((change.kind === 'pitch' && Number.isFinite(change.midi)) ||
      change.kind === 'rest' ||
      (change.kind === 'velocity' && Number.isFinite(change.target) && Number.isFinite(change.gain)));
  if (!known) throw new Error(`Moontide: the read-back does not know the change ${JSON.stringify(change)}.`);
  const carries = (event) => Array.isArray(event.locations) && event.locations.some((place) => place.start === token.start);
  const editedBefore = before.filter(carries);
  const editedAfter = after.filter(carries);
  if (editedBefore.length === 0) return { ok: false, why: 'no-edited-note' };
  if (change.kind === 'rest') {
    // A rest draws no note and keeps no place: every note that carried the token is gone.
    if (editedAfter.length !== 0) return { ok: false, why: 'edited-count' };
  } else {
    if (editedBefore.length !== editedAfter.length) return { ok: false, why: 'edited-count' };
    const field = change.kind === 'pitch' ? 'note' : 'velocity';
    const expected = new Map();
    for (const event of editedBefore) {
      const key = keyWithout(event, field);
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    for (const event of editedAfter) {
      if (change.kind === 'pitch') {
        if (pitchOf(event.value) !== change.midi) return { ok: false, why: 'edited-pitch' };
      } else {
        const velocity = event.value && typeof event.value === 'object' ? event.value.velocity : undefined;
        if (typeof velocity !== 'number' || Math.round(change.gain * velocity * 100) / 100 !== change.target) return { ok: false, why: 'edited-velocity' };
      }
      const key = keyWithout(event, field);
      const count = expected.get(key);
      if (!count) return { ok: false, why: 'edited-differs' };
      if (count === 1) expected.delete(key);
      else expected.set(key, count - 1);
    }
  }
  if (!sameEvents(before.filter((event) => !carries(event)), after.filter((event) => !carries(event)))) {
    return { ok: false, why: 'others-differ' };
  }
  return { ok: true };
}

/** The most cycles one pass of a structure may have for the page to count the places of a token over all of it. */
export const PLACES_MAX_CYCLES = 1024;

/** True when the note `event` carries a place that starts where `token` starts: it was read from that token. */
function carriesToken(event, token) {
  return Array.isArray(event.locations) && event.locations.some((place) => place.start === token.start);
}

/**
 * Where a token plays in a song the page has read. `haps` are the notes of one track over a stretch of the structure, each
 * `{ begin, locations }`, `token` the token `{ start }` and `reading` the read song. A place is a section entry (a column of the
 * Song grid) holding a note that carries the token, found with the Song grid's own rule for the section that plays at a
 * cycle, so a repeat of a variation inside one entry is not another place. Gives `{ count, sections }`: the number of
 * distinct entries and the names of the sections they belong to, once each, in the order of the entries.
 */
export function placesOf({ haps, token, reading }) {
  const entries = new Set();
  for (const hap of haps) {
    if (carriesToken(hap, token)) entries.add(playingSection(reading, hap.begin).index);
  }
  const ordered = [...entries].sort((a, b) => a - b);
  const sections = [];
  for (const index of ordered) {
    const { name } = reading.sections[index];
    if (!sections.includes(name)) sections.push(name);
  }
  return { count: ordered.length, sections };
}

/** How many of the `events` that begin in the whole cycle `cycle` carry the token: a token that draws several notes in a cycle. */
export function perCycleCount({ events, token, cycle }) {
  let count = 0;
  for (const event of events) {
    if (event.begin >= cycle - 1e-9 && event.begin < cycle + 1 - 1e-9 && carriesToken(event, token)) count += 1;
  }
  return count;
}

/** The indexes of the `events` of the drawn lane that carry the token, the selected note among them. */
export function sameTokenEvents({ events, token }) {
  const found = [];
  events.forEach((event, index) => {
    if (carriesToken(event, token)) found.push(index);
  });
  return found;
}
