// Pure module for the Jam view: the copy it shows and the model the view draws (a message, or a
// scale with its degrees). No DOM access at import time, so this module can be imported directly
// by node:test and by page/main.js without a build step. The reading itself comes from
// page/jam-analysis.js; this module only turns it into words.

import { cutText } from './ask.js';
import { MAX_PART_NAME_LENGTH } from './parts.js';
import { EPS, LOOK_AHEAD, DEFAULT_SPELL, MODES, scalePcs, scaleName } from './jam-analysis.js';

/**
 * Page-visible copy for the Jam view. The flat sign stays out
 * of this table: the degree labels carry it (page/jam-analysis.js), as escapes.
 */
export const JAM_COPY = {
  nothingPlaying: 'Nothing is playing yet.',
  reading: 'Reading the notes…',
  failed: "Jam couldn't read the notes in time — showing the code instead.",
  noPitched: 'No notes to read: the playing code has no pitched notes.',
  noPitchedSub: 'Only notes with a pitch count; drums are ignored.',
  readFromCode: 'Read from the playing code',
  warningsOff: 'Warnings are off until the scale is clear.',
  noFit: 'No clear scale: the notes fit none of the nine scales.',
  allSafe: 'All safe',
  leavesScale: 'The harmony leaves the scale:',
  noWarningAhead: 'No warning ahead',
  noLookAhead: 'Look-ahead not read yet',
  notBack: 'not back in key within 32 cycles',
  noAvoid: 'no scale note to avoid',
  comingUp: 'Coming up',
  paused: 'Not playing \u2014 countdowns are paused.',
  warningWord: 'Warning',
  partWord: 'Part',
  sameScale: 'same scale',
  scaleUnclear: 'scale unclear',
  piano: 'Piano',
  guitar: 'Guitar',
  instrumentGroup: 'Instrument',
  chordTones: 'Chord tones',
  noChord: 'No chord now',
  chordNow: 'Chord now:',
  // The declared harmony: the two labels, the sentences that replace 'No clear scale' when the
  // code declares an intention, and why a declaration cannot be read. {source} is code text cut by the reader.
  declaredLabel: 'Declared:',
  heardLabel: 'Heard:',
  noFitDeclared: 'The notes fit none of the nine scales.',
  heardUnclearLabel: 'The heard scale is not clear.',
  // The muted words after the Declared value of a piece with sections: the section whose harmony the line shows.
  declaredSection: 'section {section}',
  declaredReasons: {
    'not-const': 'Not readable: harmony is declared with let or var; the page reads only const.',
    computed: 'Not readable: harmony is computed ({source}); the page reads only written text.',
    'not-text': 'Not readable: harmony holds {source}, not scale or chord text.',
    'not-a-harmony': 'Not readable: {source} is neither a scale nor chord symbols.',
    empty: 'Not readable: harmony is empty.',
    'too-long': 'Not readable: harmony is longer than 200 characters.',
    'not-a-plain-const': 'Not readable: harmony is part of a destructuring pattern; the page reads only a plain const.',
  },
  // The legend: the word drawn next to each mark and the title that explains it.
  legend: {
    scale: { word: 'Scale', title: 'Note in the scale' },
    root: { word: 'Root', title: 'Root of the scale' },
    avoid: { word: 'Avoid', title: 'Note to avoid' },
    outside: { word: 'Outside', title: 'Chord note outside the scale, fine to play' },
    chord: { word: 'Chord tone', title: 'Note of the chord sounding now' },
  },
};

// --- the piano ---

// The 14 white keys of two octaves and the pitch classes that have a black key to their right.
const WHITE_KEYS = 14;
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const FIRST_MIDI = 48;
const KEY_COUNT = 24;
const BLACK_WIDTH = 0.6;

/**
 * The 24 keys of the fixed two-octave piano, C3 (MIDI 48, the numbering pitchOf uses) up to B4
 * (MIDI 71): `{ midi, pc, octave, black, left, width }`, left and width as percentages of the
 * piano's width. A white key is 100/14 % wide; a black key is 60% of that, centered on the
 * boundary after its white neighbour. The piano never moves when the scale changes.
 */
export function pianoKeys() {
  const unit = 100 / WHITE_KEYS;
  const keys = [];
  let white = 0;
  for (let i = 0; i < KEY_COUNT; i++) {
    const midi = FIRST_MIDI + i;
    const pc = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    if (WHITE_PCS.includes(pc)) {
      keys.push({ midi, pc, octave, black: false, left: white * unit, width: unit });
      white++;
    } else {
      keys.push({ midi, pc, octave, black: true, left: white * unit - (BLACK_WIDTH / 2) * unit, width: BLACK_WIDTH * unit });
    }
  }
  return keys;
}

/**
 * The role of each of the 12 pitch classes at a reading position: 'off' for all when the current
 * scale is not clear, else 'scale' for its notes, 'root' for its root, 'outside' for the current
 * warning's chord notes outside the scale and 'avoid' for its notes to avoid, avoid applied last so
 * it wins over the root.
 */
export function rolesByPc(position) {
  const roles = new Array(12).fill('off');
  const scale = position.scale;
  if (scale.status !== 'clear') return roles;
  for (const pc of scalePcs(scale.root, scale.mode)) roles[pc] = 'scale';
  roles[scale.root] = 'root';
  if (position.warning !== null) {
    for (const pc of position.warning.outsidePcs) roles[pc] = 'outside';
    for (const pc of position.warning.avoidPcs) roles[pc] = 'avoid';
  }
  return roles;
}

// --- the guitar ---

/** Open-string MIDI numbers from the top row (high e) down: E4 B3 G3 D3 A2 E2, standard tuning. */
export const STRINGS = [64, 59, 55, 50, 45, 40];
/** The names printed in the gutter, top row down. */
export const STRING_NAMES = ['e', 'B', 'G', 'D', 'A', 'E'];
/** The frets that carry a number under the board. */
export const FRET_NUMBERS = [3, 5, 7, 9, 12];
const FRETS = 12;

/** The relative width of a column: 0.8 for the open column, then the real scale, fret n is 2^(-(n-1)/12). */
export const fretUnits = (n) => (n === 0 ? 0.8 : 2 ** (-(n - 1) / 12));

/** The fretboard rows, top to bottom, each with the open column and 12 frets: `{ string, fret, midi, pc }`. */
export function fretCells() {
  return STRINGS.map((open, string) =>
    Array.from({ length: FRETS + 1 }, (_, fret) => ({ string, fret, midi: open + fret, pc: (open + fret) % 12 })),
  );
}

/** The 12 note names of a position: the clear scale's own spelling table, else the default one. */
export const pcNames = (position) => (position.scale.status === 'clear' ? position.scale.spell : DEFAULT_SPELL);

/**
 * The text on one key: a C key reads its octave as a landmark ('C3', 'C4') unless it is to avoid
 * (the cross and the line-through leave no room for the octave digit: it reads 'C'); any other key
 * reads its spelled name when its role is not 'off' or when it is a chord tone (`chordPcs`, the
 * optional 12 flags of the overlay), else nothing.
 */
export function keyLabel(key, roles, names, chordPcs = null) {
  if (key.pc === 0 && roles[0] !== 'avoid') return `C${key.octave}`;
  return roles[key.pc] === 'off' && !(chordPcs !== null && chordPcs[key.pc]) ? '' : names[key.pc];
}

/**
 * The chord line under the controls: 'Chord now: Dm7 \u00B7 D F A C', 'Chord now: C E F# G' for an
 * unnamed chord (at most six names, then an ellipsis), 'No chord now' when fewer than two pitch
 * classes sound together (`chord` null). `chord` is readingAt's `{ name, notes, pcs }`.
 */
export function chordLineText(chord) {
  if (chord === null) return JAM_COPY.noChord;
  const notes = capNotes(chord.notes);
  return chord.name === null ? `${JAM_COPY.chordNow} ${notes}` : `${JAM_COPY.chordNow} ${chord.name} \u00B7 ${notes}`;
}

/**
 * The legend entries `{ role, word, title }`: Scale, Root, Avoid and Outside, and Chord tone too
 * while the overlay is on. The view draws each role's mark next to its word.
 */
export function legendEntries(chordTones) {
  const roles = ['scale', 'root', 'avoid', 'outside'];
  if (chordTones) roles.push('chord');
  return roles.map((role) => ({ role, ...JAM_COPY.legend[role] }));
}

/**
 * The accessible name of an instrument ('piano' or 'guitar'): 'Piano, two octaves from C3.' or
 * 'Guitar fretboard, standard tuning, 12 frets.' and then, with a clear scale,
 * 'Scale notes: D, E, F. Root D. Avoid: C.' ('Avoid: none.' when nothing is to be avoided), or 'No
 * clear scale.' The marks repeat in every octave, so the label names pitch classes. With `declared` (the
 * code declares a harmony) an unclear scale reads 'The heard scale is not clear.' instead, and a reading with no
 * pitched note reads the nothing-pitched sentence.
 */
export function instrumentLabel(kind, position, { declared = false } = {}) {
  let lead;
  if (kind === 'piano') lead = 'Piano, two octaves from C3.';
  else if (kind === 'guitar') lead = 'Guitar fretboard, standard tuning, 12 frets.';
  else throw new Error(`Moontide: no accessible name for an instrument called '${String(kind)}'`);
  const scale = position.scale;
  // With a declaration the label never says 'No clear scale'; a reading with no pitched note has nothing heard to call unclear.
  if (declared && scale.status === 'none') return `${lead} ${JAM_COPY.noPitched}`;
  if (scale.status !== 'clear') return `${lead} ${declared ? JAM_COPY.heardUnclearLabel : 'No clear scale.'}`;
  const avoid = position.warning === null || position.warning.avoid.length === 0 ? 'none' : position.warning.avoid.join(', ');
  return `${lead} Scale notes: ${scale.notes.map((note) => note.name).join(', ')}. Root ${scale.spell[scale.root]}. Avoid: ${avoid}.`;
}

// The 12 chord-tone flags: the pitch classes of the chord sounding now while the overlay is on.
function chordFlags(position, chordTones) {
  const flags = new Array(12).fill(false);
  if (chordTones && position.chord !== null) for (const pc of position.chord.pcs) flags[pc] = true;
  return flags;
}

// The instrument part of a ready model: roles and names by pitch class, the root, the chord
// tones and the labels.
function instrumentOf(position, chordPcs, declared) {
  const clear = position.scale.status === 'clear';
  return {
    roles: rolesByPc(position),
    names: pcNames(position),
    rootPc: clear ? position.scale.root : null,
    chordPcs,
    pianoLabel: instrumentLabel('piano', position, { declared }),
    guitarLabel: instrumentLabel('guitar', position, { declared }),
  };
}

// A non-breaking space keeps a unit with its number; \u2026 is the ellipsis.
const NBSP = '\u00A0';
const EN_DASH = '\u2013';
const MAX_NOTES_SHOWN = 6;
const MAX_ROWS = 3;

/**
 * Whole seconds from `cycle` to the cycle `target` at `cps` cycles per second, rounded up and
 * never below 1 (a countdown never reads 0 while the event is still ahead or happening).
 */
export function secondsUntil(target, cycle, cps) {
  return Math.max(1, Math.ceil((target - cycle) / cps - EPS));
}

/** A countdown as it is shown: the number, a non-breaking space, then 's'. */
export const secondsText = (n) => `${n}${NBSP}s`;

/** A length in cycles as it is said: at most two decimals, trailing zeros dropped, 'cycle' only for exactly 1. */
export function cyclesText(n) {
  const rounded = Number(n.toFixed(2));
  return `${rounded} ${rounded === 1 ? 'cycle' : 'cycles'}`;
}

/** A list of note names as one text: at most six names joined by spaces, a longer list cut with an ellipsis. */
export function capNotes(names) {
  return names.length <= MAX_NOTES_SHOWN ? names.join(' ') : `${names.slice(0, MAX_NOTES_SHOWN).join(' ')} \u2026`;
}

/** A message model: the text, and an optional muted second line. */
export function messageModel(text, sub = null) {
  return { state: 'message', text, sub };
}

/**
 * The plain sentence for a scale that cannot be named: 'No clear scale: the notes fit C major and
 * A minor equally.' (two names joined by 'and', three as 'A, B and C', more as the first three then
 * 'and {N} more'; 'almost equally' for a near tie), or the no-fit sentence. With `declared` (the code
 * declares a harmony) the 'No clear scale: ' prefix is dropped and the sentence starts 'The notes fit'.
 */
export function ambiguitySentence(scale, { declared = false } = {}) {
  if (scale.status === 'no-fit') return declared ? JAM_COPY.noFitDeclared : JAM_COPY.noFit;
  if (scale.status !== 'ambiguous') {
    throw new Error(`Moontide: no ambiguity sentence for a scale reading with status '${String(scale.status)}'`);
  }
  const names = scale.candidates.map((candidate) => candidate.name);
  let list;
  if (names.length <= 1) list = names.join('');
  else if (names.length === 2) list = `${names[0]} and ${names[1]}`;
  else if (names.length === 3) list = `${names[0]}, ${names[1]} and ${names[2]}`;
  else list = `${names[0]}, ${names[1]}, ${names[2]} and ${names.length - 3} more`;
  return `${declared ? 'The' : 'No clear scale: the'} notes fit ${list} ${scale.kind === 'near' ? 'almost equally' : 'equally'}.`;
}

/** The longest declared text shown on the Declared line, in UTF-16 units; the title keeps the whole text. */
export const MAX_DECLARED_SHOWN = 60;

/**
 * The Declared line of the Jam view from a reading's `declared` (page/harmony.js readHarmony): null for
 * `{ state: 'none' }`, else `{ kind, text, title }`. A declared single scale of the nine shows under the page's
 * own name ('D Dorian'), any other declared text as written and cut at MAX_DECLARED_SHOWN; the title is
 * 'harmony = ' plus the text as written. An unreadable declaration is kind 'unreadable' and says why in one
 * sentence ('Not readable: ...', never cut, text equal to title). The text comes from the code, so the view
 * writes it as text only. Anything the model cannot say throws.
 */
export function declaredLine(declared) {
  if (declared.state === 'none') return null;
  if (declared.state === 'declared') {
    if (declared.kind !== 'scale' && declared.kind !== 'chords') {
      throw new Error(`Moontide: no Declared line for a declaration of kind '${String(declared.kind)}'`);
    }
    const title = `harmony = ${declared.text}`;
    if (declared.scale !== null && declared.scale !== undefined) {
      const mode = MODES.find((entry) => entry.id === declared.scale.modeId);
      if (mode === undefined) throw new Error(`Moontide: no scale called '${String(declared.scale.modeId)}' to show on the Declared line`);
      return { kind: 'scale', text: scaleName(declared.scale.rootPc, mode), title };
    }
    return { kind: declared.kind, text: cutText(declared.text, MAX_DECLARED_SHOWN), title };
  }
  if (declared.state === 'unreadable') {
    const sentence = Object.hasOwn(JAM_COPY.declaredReasons, declared.reason) ? JAM_COPY.declaredReasons[declared.reason] : undefined;
    if (sentence === undefined) throw new Error(`Moontide: no sentence for the unreadable-declaration reason '${String(declared.reason)}'`);
    if (sentence.includes('{source}') && typeof declared.source !== 'string') {
      throw new Error(`Moontide: the reason '${declared.reason}' needs the quoted source`);
    }
    const text = sentence.replace('{source}', () => declared.source);
    return { kind: 'unreadable', text, title: text };
  }
  throw new Error(`Moontide: no Declared line for a declaration in state '${String(declared.state)}'`);
}

/**
 * The sub-line of a scale read from one arrange() part: `Part "verse" · read from this part`.
 * The name comes from the code, so it is cut at MAX_PART_NAME_LENGTH UTF-16 units (an ellipsis
 * ends a cut name, a surrogate pair is never split); the view keeps the full text in its title.
 */
export function partSubLine(name) {
  return `Part "${cutText(name, MAX_PART_NAME_LENGTH)}" \u00B7 read from this part`;
}

// A part name's full sub-line text for the title (never cut), or null without a part.
const partSubTitle = (name) => (typeof name === 'string' ? `Part "${name}" \u00B7 read from this part` : null);


/**
 * The ask descriptor of a warning (page/ask.js describes it): the chord's name, or at most six of its
 * note names for an unnamed chord, the outside and avoid notes joined by ', ' (no avoid field when
 * nothing is to be avoided), the whole seconds until it starts (0 for now) and the name of the scale
 * it happens in. Facts only.
 */
export function warningDescriptor({ warning, seconds, scaleName }) {
  const descriptor = {
    kind: 'warning',
    chord: warning.chord === null ? capNotes(warning.notes) : warning.chord,
    outside: warning.outside.join(', '),
  };
  if (warning.avoid.length > 0) descriptor.avoid = warning.avoid.join(', ');
  descriptor.seconds = seconds;
  descriptor.scale = scaleName;
  return descriptor;
}

/**
 * The ask descriptor of a note: its pitch-class name, with its role and the scale's name while the scale
 * is clear (`scaleName` not null), else the bare note.
 */
export function noteDescriptor({ note, role, scaleName }) {
  return scaleName === null ? { kind: 'note', note } : { kind: 'note', note, role, scale: scaleName };
}

// One row of the coming-up list from an upcoming entry of the reading position.
function rowOf(entry, position, paused) {
  const { cycle, cps, reading } = position;
  const seconds = secondsUntil(entry.begin, cycle, cps);
  const time = paused ? EN_DASH : secondsText(seconds);
  const key = (kind, text) => `${kind}|${Math.round(entry.begin / EPS)}|${text}`;
  if (entry.kind === 'warning') {
    const warning = reading.warnings[entry.warningIndex];
    const who = warning.chord === null ? `The notes ${capNotes(warning.notes)} bring` : `${warning.chord} brings`;
    const avoid = warning.avoid.length === 0 ? `, ${JAM_COPY.noAvoid}` : `, avoid ${warning.avoid.join(', ')}`;
    const text = `${who} ${warning.outside.join(', ')}${avoid}, lasts ${cyclesText(entry.end - entry.begin)}`;
    const descriptor = warningDescriptor({ warning, seconds, scaleName: warning.scaleName });
    return { key: key('warning', text), kind: 'warning', kindWord: JAM_COPY.warningWord, time, text, title: text, seconds, warningIndex: entry.warningIndex, part: null, descriptor };
  }
  const ending =
    entry.change === 'same'
      ? JAM_COPY.sameScale
      : entry.change === 'unclear'
        ? JAM_COPY.scaleUnclear
        : `scale changes to ${entry.scaleName}`;
  const tail = `starts (${cyclesText(entry.length)}) \u2014 ${ending}`;
  const text = `"${cutText(entry.name, MAX_PART_NAME_LENGTH)}" ${tail}`;
  return {
    key: key('part', text),
    kind: 'part',
    kindWord: JAM_COPY.partWord,
    time,
    text,
    title: `"${entry.name}" ${tail}`,
    seconds,
    warningIndex: null,
    part: { name: entry.name, owner: position.reading.partOwner ?? null },
  };
}

// The static rows (no event behind them): the calm row and the warnings-off row.
const staticRow = (kind, kindWord, text) => ({ key: `${kind}||${text}`, kind, kindWord, time: EN_DASH, text, title: text, seconds: null, warningIndex: null, part: null });

/**
 * The coming-up rows: the first three upcoming events, except that with a clear scale and no
 * warning among them at all, at most two and the calm row ('No warning ahead') after them; with an
 * unclear scale, part rows only, or the single warnings-off row when there is no part change.
 */
function rowsFor(position, paused) {
  const clear = position.scale.status === 'clear';
  const upcoming = position.upcoming;
  const calm = clear && !upcoming.some((entry) => entry.kind === 'warning');
  const rows = upcoming.slice(0, calm ? MAX_ROWS - 1 : MAX_ROWS).map((entry) => rowOf(entry, position, paused));
  if (calm && position.reading.partial === true) {
    // Only the playing page was read: nothing is known about what comes, so nothing is promised.
    rows.push(staticRow('calm', '', `${JAM_COPY.noLookAhead} \u2014 only the page that plays now was read.`));
  } else if (calm) {
    const seconds = Math.round(LOOK_AHEAD / position.cps);
    rows.push(staticRow('calm', '', `${JAM_COPY.noWarningAhead} \u2014 nothing leaves ${position.scale.name} in the next ${secondsText(seconds)}.`));
  } else if (!clear && rows.length === 0) {
    rows.push(staticRow('off', '', JAM_COPY.warningsOff));
  }
  return rows;
}

/**
 * The key the spoken copy of the status time follows: the kind, the warning index and the time's
 * wording with every run of digits replaced by one placeholder. A warning that starts, ends or
 * changes wording changes the key and is announced; a countdown tick keeps it and is not.
 */
export function statusAnnounceKey(status) {
  const time = status.time === null ? '' : status.time.replace(/\d+/g, '#');
  return `${status.kind}|${status.warningIndex ?? ''}|${time}`;
}

const OFF_STATUS = { kind: 'off', lead: '', rest: '', time: null, warningIndex: null };

// The status box of a position whose scale is clear: all safe, or which chord leaves the scale.
function statusOf(position, paused) {
  const { warning, cycle, cps, scale } = position;
  if (warning === null) {
    const next = position.nextWarning;
    return {
      kind: 'safe',
      lead: JAM_COPY.allSafe,
      rest: ` \u2014 every note of ${scale.name} works with the harmony right now.`,
      time: paused
        ? null
        : next !== null
          ? `Next warning in ${secondsText(secondsUntil(next.begin, cycle, cps))}`
          : position.reading.partial === true
            ? JAM_COPY.noLookAhead
            : JAM_COPY.noWarningAhead,
      warningIndex: null,
    };
  }
  const who = warning.chord === null ? `the notes ${capNotes(warning.notes)} include` : `${warning.chord} contains`;
  const avoid = warning.avoid.length === 0 ? `, ${JAM_COPY.noAvoid}` : `, avoid ${warning.avoid.join(', ')}`;
  const unknownEnd = position.backInKey === null && position.reading.partial === true && warning.backInKey >= position.reading.windowEnd - EPS;
  const back = position.backInKey !== null
    ? `back in key in ${secondsText(secondsUntil(position.backInKey, cycle, cps))}`
    : unknownEnd
      ? JAM_COPY.noLookAhead
      : JAM_COPY.notBack;
  return {
    kind: 'warning',
    lead: JAM_COPY.leavesScale,
    rest: ` ${who} ${warning.outside.join(', ')}${avoid}`,
    time: paused ? null : back,
    warningIndex: warning.index,
    descriptor: warningDescriptor({ warning, seconds: 0, scaleName: scale.name }),
  };
}

/**
 * The model the view draws for one reading position (`readingAt` result in `position`): a message
 * model when no pitched note plays, else `{ state: 'ready', scale: { kind, text, title, sub },
 * degrees }`. A clear scale gives kind 'clear' and seven degrees (role 'root' on the root only);
 * an ambiguous or no-fit scale gives kind 'ambiguous', its plain sentence, the warnings-off line
 * and no degrees. Every ready model carries `paused` (sound is not playing: countdowns read an en
 * dash and the status drops its time part), `rows` (the coming-up list, see rowsFor; each row
 * `{ key, kind, kindWord, time, text, title, seconds, warningIndex, part }`) and `status`: `{ kind: 'safe' | 'warning' | 'off', lead,
 * rest, time, warningIndex }`, kind 'off' whenever the scale is not clear; a warning status and each
 * warning row also carry `descriptor`, what a right-click on them asks Claude about (seconds 0 for the
 * status, the row's own seconds for a row). The degree chips of
 * the current warning's notes to avoid get the role 'avoid' (winning over 'root'). It also carries
 * `instrument: { roles, names, rootPc, chordPcs, pianoLabel, guitarLabel }`: the role and the name of each of the 12 pitch
 * classes (all 'off' and the default spelling without a clear scale), the root's pitch class or null,
 * `chordPcs` (12 flags, the pitch classes of the chord sounding now while `chordTones` is on, else all
 * false) and the two instruments' accessible names. With `chordTones` on the model also carries
 * `chordLine` (the 'Chord now: ...' text, null while the overlay is off) and each degree chip a
 * `chord` flag. `noteScaleName` is the clear scale's name, or null while the scale is not clear: the scale a
 * right-click on a note asks about. Every ready model also carries `declared`: null when the code declares no
 * harmony, else `{ kind, text, title }` (see declaredLine). A declaration changes only words: in declared mode
 * (even an unreadable declaration) no sentence says 'No clear scale', and a reading with no pitched note is a ready
 * model of kind 'none' instead of the message model, so the Declared line stays on screen. The heard scale, the
 * degrees, the status, the rows and the instrument roles are the ones of the same notes without a declaration.
 * A piece with sections shows the harmony of the section that plays: `declaredOverride` (the same shapes as a reading's
 * `declared`) replaces the one in the reading, and `section` is that section's name as the page shows it, quoted; every
 * ready model carries `section`, the words 'section {name}' for a piece with sections and null otherwise.
 */
export function buildJamModel({ position, chordTones = false, declaredOverride, section = null }) {
  const declaredState = declaredOverride ?? position.reading.declared ?? { state: 'none' };
  const sectionText = section === null || section === undefined ? null : JAM_COPY.declaredSection.replace('{section}', () => section);
  const declaredMode = declaredState.state !== 'none';
  const declared = declaredLine(declaredState);
  if (position.reading.status === 'none' && !declaredMode) {
    return messageModel(JAM_COPY.noPitched, JAM_COPY.noPitchedSub);
  }
  const scale = position.scale;
  const paused = position.playing === false;
  const rows = rowsFor(position, paused);
  const chordPcs = chordFlags(position, chordTones);
  const instrument = instrumentOf(position, chordPcs, declaredMode);
  const chordLine = chordTones ? chordLineText(position.chord) : null;
  // The scale a note context names: only a clear scale, never a guess.
  const noteScaleName = position.scale.status === 'clear' ? position.scale.name : null;
  const partName = position.span.name;
  const sub = typeof partName === 'string' ? partSubLine(partName) : null;
  const subTitle = partSubTitle(partName);
  const withTitle = (scaleModel) => (subTitle === null ? scaleModel : { ...scaleModel, subTitle });
  if (scale.status === 'none') {
    // The part that plays has no pitched note while other parts have some: the nothing-pitched
    // sentence stands in the name slot, with the part sub-line.
    return {
      state: 'ready',
      scale: withTitle({ kind: 'none', text: JAM_COPY.noPitched, title: JAM_COPY.noPitched, sub: sub ?? JAM_COPY.noPitchedSub }),
      degrees: [],
      status: OFF_STATUS,
      paused,
      rows,
      instrument,
      chordLine,
      noteScaleName,
      declared,
      section: sectionText,
    };
  }
  if (scale.status === 'clear') {
    const avoided = new Set(position.warning === null ? [] : position.warning.avoidPcs);
    const degrees = scale.notes.map((note, i) => {
      const isRoot = i === 0;
      const isAvoid = avoided.has(note.pc);
      const chip = {
        pc: note.pc,
        note: note.name,
        degree: note.degree,
        role: isAvoid ? 'avoid' : isRoot ? 'root' : 'scale',
        chord: chordPcs[note.pc],
        label: `${note.name}, degree ${note.degree}${isRoot ? ', root' : ''}${isAvoid ? ', to avoid' : ''}`,
      };
      if (isAvoid && isRoot) chip.rootAvoided = true;
      return chip;
    });
    return {
      state: 'ready',
      scale: withTitle({ kind: 'clear', text: scale.name, title: scale.name, sub: sub ?? JAM_COPY.readFromCode }),
      degrees,
      status: statusOf(position, paused),
      paused,
      rows,
      instrument,
      chordLine,
      noteScaleName,
      declared,
      section: sectionText,
    };
  }
  if (scale.status === 'ambiguous' || scale.status === 'no-fit') {
    const sentence = ambiguitySentence(scale, { declared: declaredMode });
    return {
      state: 'ready',
      scale: { kind: 'ambiguous', text: sentence, title: sentence, sub: JAM_COPY.warningsOff },
      degrees: [],
      status: OFF_STATUS,
      paused,
      rows,
      instrument,
      chordLine,
      noteScaleName,
      declared,
      section: sectionText,
    };
  }
  throw new Error(`Moontide: the Jam model cannot draw a scale reading with status '${String(scale.status)}'`);
}

// --- when a failed reading may be tried again ---

/** A too-slow reading is retried once after this many milliseconds; any other failure is not retried. */
export const JAM_RETRY_DELAY_MS = 2000;
export const JAM_MAX_RETRIES = 1;

/**
 * The record of a failed reading, `{ version, pageStart, retries, retryAt }` (`pageStart` null for a
 * whole version). `previous` is the record of the same failure so far (other version or page: a new
 * count). A `slow` failure (the query ran out of time, which a busy machine or a throttled tab
 * causes) gets JAM_MAX_RETRIES retries, each JAM_RETRY_DELAY_MS after `now`; after them, and for any
 * other failure, `retryAt` is null: nothing retries until the version or the page changes.
 */
export function jamStuckFor({ previous, version, pageStart, slow, now }) {
  const same = previous !== null && previous.version === version && previous.pageStart === pageStart;
  const retries = same ? previous.retries : 0;
  if (slow && retries < JAM_MAX_RETRIES) return { version, pageStart, retries: retries + 1, retryAt: now + JAM_RETRY_DELAY_MS };
  return { version, pageStart, retries, retryAt: null };
}

/** True while the 250 ms tick must not start a rebuild: a failure record of this version and page
 * (of any page when its `pageStart` is null) whose retry time has not come. */
export function jamIsStuck(stuck, { version, pageStart, now }) {
  if (stuck === null || stuck.version !== version) return false;
  if (stuck.pageStart !== null && stuck.pageStart !== pageStart) return false;
  return stuck.retryAt === null || now < stuck.retryAt;
}
