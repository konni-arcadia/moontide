import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as jam from '../page/jam-analysis.js';
import { pitchOf } from '../page/timeline.js';

// Namespace import: an export the module does not have yet fails inside the test that uses it, a
// targeted failure, instead of crashing the whole file at load.
const {
  EPS,
  HARMONIC_MIN,
  BRIEF,
  MAX_PITCHED_EVENTS,
  MODES,
  DEFAULT_SPELL,
  scalePcs,
  spellTable,
  scaleName,
  avoidFor,
  nameChord,
  noteList,
  pitchedEvents,
  flattenLanes,
  markSolid,
  segments,
  detectScale,
  chooseArrangement,
  buildReading,
  readingAt,
  MERGE_GAP,
  LOOK_AHEAD,
  TONIC_BONUS,
  warningsFor,
} = jam;

// --- fixtures: neutral hap-shaped events, written for these tests ---

const ev = (track, begin, end, note) => ({ begin, end, value: { note }, track });
/** A run of equal steps: `names` one after the other from `begin`. */
const run = (track, begin, step, names) => names.map((name, i) => ev(track, begin + i * step, begin + (i + 1) * step, name));
/** Notes sounding together from `begin` to `end`. */
const stack = (track, begin, end, names) => names.map((name) => ev(track, begin, end, name));
/** `fn(cycle)` for cycles 0 to cycles - 1, flattened. */
const loop = (cycles, fn) => Array.from({ length: cycles }, (_, cycle) => fn(cycle)).flat();
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, message ?? `${a} is not close to ${b}`);

/** The scale of a whole window, read the way buildReading reads it. */
function read(raw) {
  const pitched = pitchedEvents(raw);
  const harmonic = segments(markSolid(pitched.map((e) => ({ ...e })), HARMONIC_MIN));
  return detectScale(pitched, harmonic);
}
const candidateNames = (scale) => scale.candidates.map((c) => c.name);

// --- pitched events ---

test('pitchedEvents keeps note names, note numbers and on-semitone freqs, and ignores events without a pitch', () => {
  const out = pitchedEvents([
    { begin: 0, end: 1, value: { note: 'c3' }, track: 2 },
    { begin: 1, end: 2, value: { note: 48 } },
    { begin: 2, end: 3, value: { note: 'eb3' } },
    { begin: 3, end: 4, value: { freq: 220 } },
    { begin: 4, end: 5, value: { freq: 233 } },
    { begin: 5, end: 6, value: { s: 'bd' } },
    { begin: 6, end: 7, value: { n: 0 } },
    { begin: 7, end: 8, value: { chord: 'Dm7' } },
  ]);
  assert.deepEqual(out.map((e) => e.midi), [48, 48, 51, 57, 58]);
  assert.deepEqual(out.map((e) => e.pc), [0, 0, 3, 9, 10]);
  assert.equal(out.dropped, 0);
  assert.equal(out[0].track, 2);
});

test('pitchedEvents drops a freq more than a quarter semitone from a semitone and counts it', () => {
  // 226 Hz is about 57.46 in MIDI numbers: nearly halfway between two semitones, never guessed.
  const out = pitchedEvents([{ begin: 0, end: 1, value: { freq: 226 } }, { begin: 1, end: 2, value: { freq: 220 } }]);
  assert.equal(out.length, 1);
  assert.equal(out.dropped, 1);
  assert.equal(out[0].midi, 57);
});

test('pitchedEvents counts one note once and the same pitch class an octave apart twice', () => {
  const once = pitchedEvents([ev(0, 0, 1, 'c3'), { begin: 0, end: 1, value: { note: 48 }, track: 1 }]);
  assert.equal(once.length, 1);
  const twice = pitchedEvents([ev(0, 0, 1, 'c3'), ev(0, 0, 1, 'c4')]);
  assert.equal(twice.length, 2);
  assert.deepEqual(twice.map((e) => e.pc), [0, 0]);
});

test('flattenLanes gives every lane event with its lane track index', () => {
  const result = {
    state: 'ok',
    lanes: [
      { index: 0, events: [{ begin: 0, end: 1, value: { note: 'c3' } }] },
      { index: 3, events: [{ begin: 1, end: 2, value: { note: 'd3' } }, { begin: 2, end: 3, value: { s: 'bd' } }] },
    ],
  };
  const flat = flattenLanes(result);
  assert.deepEqual(flat.map((e) => e.track), [0, 3, 3]);
  assert.deepEqual(flat.map((e) => e.begin), [0, 1, 2]);
});

// --- the nine scales, spelling, the avoid rule ---

test('MODES lists the nine scales in order with their labels and degrees', () => {
  assert.deepEqual(MODES.map((m) => m.id), ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'harmonic-minor', 'melodic-minor']);
  assert.deepEqual(MODES.map((m) => m.label), ['major', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'minor', 'Locrian', 'harmonic minor', 'melodic minor']);
  const dorian = MODES.find((m) => m.id === 'dorian');
  assert.deepEqual(dorian.degrees, ['1', '2', '♭3', '4', '5', '6', '♭7']);
  assert.deepEqual(dorian.offsets, [0, 2, 3, 5, 7, 9, 10]);
  const lydian = MODES.find((m) => m.id === 'lydian');
  assert.deepEqual(lydian.degrees, ['1', '2', '3', '♯4', '5', '6', '7']);
  assert.ok(MODES.every((m) => m.degrees.length === 7 && m.offsets.length === 7));
});

test('spellTable spells the scale by its key signature and the outside notes by their alteration', () => {
  const mode = (id) => MODES.find((m) => m.id === id);
  assert.equal(spellTable(2, mode('dorian')).join(' '), 'C C# D Eb E F F# G G# A Bb B');
  assert.equal(spellTable(5, mode('ionian')).join(' '), 'C Db D Eb E F Gb G Ab A Bb B');
  assert.equal(scalePcs(2, mode('harmonic-minor')).map((pc) => spellTable(2, mode('harmonic-minor'))[pc]).join(' '), 'D E F G A Bb C#');
  assert.equal(scalePcs(6, mode('ionian')).map((pc) => spellTable(6, mode('ionian'))[pc]).join(' '), 'F# G# A# B C# D# E#');
  assert.equal(scalePcs(4, mode('harmonic-minor')).map((pc) => spellTable(4, mode('harmonic-minor'))[pc]).join(' '), 'E F# G A B C D#');
});

test('spellTable spells every scale with seven distinct letters, in letter order from the root', () => {
  for (const mode of MODES) {
    for (let root = 0; root < 12; root++) {
      const table = spellTable(root, mode);
      const names = scalePcs(root, mode).map((pc) => table[pc]);
      const letters = names.map((name) => name[0]);
      assert.equal(new Set(letters).size, 7, `${mode.id} ${root}: ${names.join(' ')}`);
      const first = 'CDEFGAB'.indexOf(letters[0]);
      letters.forEach((letter, degree) => assert.equal(letter, 'CDEFGAB'[(first + degree) % 7], `${mode.id} ${root}: ${names.join(' ')}`));
      assert.ok(names.every((name) => /^[A-G](bb|b|#|##)?$/.test(name)), `${mode.id} ${root}: ${names.join(' ')}`);
    }
  }
});

test('spellTable names the E#, B# and double sharps of sharp-key scales', () => {
  const mode = (id) => MODES.find((m) => m.id === id);
  const notes = (root, id) => scalePcs(root, mode(id)).map((pc) => spellTable(root, mode(id))[pc]).join(' ');
  assert.equal(notes(1, 'harmonic-minor'), 'C# D# E F# G# A B#');
  assert.equal(notes(3, 'harmonic-minor'), 'D# E# F# G# A# B C##');
  assert.equal(notes(3, 'aeolian'), 'D# E# F# G# A# B C#');
  assert.equal(notes(5, 'locrian'), 'F Gb Ab Bb Cb Db Eb');
});

test('scaleName spells the root by the reading\'s own table', () => {
  const mode = (id) => MODES.find((m) => m.id === id);
  assert.equal(scaleName(2, mode('dorian')), 'D Dorian');
  assert.equal(scaleName(5, mode('ionian')), 'F major');
  assert.equal(scaleName(9, mode('aeolian')), 'A minor');
  assert.equal(scaleName(4, mode('harmonic-minor')), 'E harmonic minor');
  assert.equal(scaleName(10, mode('ionian')), 'Bb major');
});

test('avoidFor gives every outside pitch class exactly one avoid note, in the scale, for all 108 scales', () => {
  let failures = 0;
  for (const mode of MODES) {
    for (let root = 0; root < 12; root++) {
      const inside = new Set(scalePcs(root, mode));
      for (let pc = 0; pc < 12; pc++) {
        if (inside.has(pc)) continue;
        const avoid = avoidFor(pc, root, mode);
        if (avoid === null || !inside.has(avoid)) failures++;
      }
    }
  }
  assert.equal(failures, 0);
});

test('avoidFor follows the worked examples: the scale note an outside note replaces', () => {
  const mode = (id) => MODES.find((m) => m.id === id);
  const dorian = mode('dorian');
  assert.deepEqual([1, 3, 6, 8, 10].map((pc) => avoidFor(pc, 2, dorian)), [0, 4, 5, 7, 11]);
  assert.equal(avoidFor(11, 5, mode('ionian')), 10); // F major: B avoids Bb
  assert.equal(avoidFor(2, 4, mode('harmonic-minor')), 3); // E harmonic minor: D avoids D#
});

// --- chords ---

function chordNameOf(text, spell = DEFAULT_SPELL) {
  const midis = text.split(' ').map((name) => pitchOf({ note: name }));
  let mask = 0;
  for (const midi of midis) mask |= 1 << (((midi % 12) + 12) % 12);
  const low = Math.min(...midis);
  return nameChord(mask, ((low % 12) + 12) % 12, spell);
}

test('nameChord names the 22 real voicings of the pinned bundle', () => {
  const voicings = [
    ['E3 C4 E4 G4 C5', 'C'],
    ['G3 C4 Eb4 G4 C5', 'Cm'],
    ['E3 Bb3 E4 G4 C5', 'C7'],
    ['Bb3 Eb4 G4 Bb4 C5', 'Cm7'],
    ['Bb3 Eb4 Gb4 Bb4 C5', 'Cm7b5'],
    ['C3 G3 C4 E4 A4', 'C6'],
    ['C4 Eb4 G4 A4 C5', 'Cm6'],
    ['Bb3 D4 E4 Bb4 C5', 'C9'],
    ['Eb3 Bb3 D4 G4 C5', 'Cm9'],
    ['E3 C4 D4 G4 C5', 'Cadd9'],
    ['F3 C4 D4 F4 C5', 'Dm7'],
    ['G3 D4 F4 G4 B4', 'G7'],
    ['Gb3 A3 Db4 E4 A4', 'F#m7'],
    ['A3 C4 E4 A4 C5', 'Am'],
    ['E3 D4 E4 Ab4 B4', 'E7'],
    ['C3 E4 G4 B4', 'Cmaj7'],
    ['C3 B3 D4 E4 G4', 'Cmaj9'],
    ['G3 B3 C4 Eb4 B4', 'CmMaj7'],
    ['Eb3 C4 Eb4 Gb4 C5', 'Cdim'],
    ['C4 F4 G4 C5', 'Csus4'],
    ['E3 C4 E4 Ab4 C5', 'Eaug'],
    ['Eb3 C4 Gb4 A4 C5', 'Ebdim7'],
  ];
  assert.equal(voicings.length, 22);
  for (const [notes, expected] of voicings) {
    assert.equal(chordNameOf(notes), expected, notes);
  }
});

test('nameChord returns null for shapes outside the dictionary and names a pedal bass with a slash', () => {
  assert.equal(chordNameOf('C3 E3 G3 Bb3 Db4'), null); // C7b9
  assert.equal(chordNameOf('C3 E3 G3 Bb3 D#4'), null); // C7#9
  assert.equal(chordNameOf('C3 E3 G3 Bb3 D4 F4'), null); // C11
  assert.equal(chordNameOf('C3 E3 G3 Bb3 D4 A4'), null); // C13
  assert.equal(chordNameOf('D2 A2 C#3 E3 G3'), 'A7/D');
});

test('noteList lists the pitch classes of a set from the bass upward, spelled by the given table', () => {
  const mask = [2, 5, 9, 0].reduce((m, pc) => m | (1 << pc), 0); // D F A C
  assert.deepEqual(noteList(mask, DEFAULT_SPELL, 2), ['D', 'F', 'A', 'C']);
  assert.deepEqual(noteList(mask, DEFAULT_SPELL, 9), ['A', 'C', 'D', 'F']);
  const flats = spellTable(5, MODES[0]);
  assert.deepEqual(noteList([10, 2, 5].reduce((m, pc) => m | (1 << pc), 0), flats, 10), ['Bb', 'D', 'F']);
});

// --- solid events and segments ---

test('markSolid: a lone brief outside note is not solid, a note of 0.3 cycle is', () => {
  const brief = markSolid(pitchedEvents([ev(0, 0, 0.1, 'f#4')]).map((e) => ({ ...e })));
  assert.equal(brief[0].solid, false);
  const lasting = markSolid(pitchedEvents([ev(0, 0, 0.3, 'f#4')]).map((e) => ({ ...e })));
  assert.equal(lasting[0].solid, true);
});

test('markSolid: a named stab of 1/8 cycle is solid, the same stab at 1/16 cycle is not', () => {
  const stab = (end) => markSolid(pitchedEvents(stack(0, 0, end, ['bb3', 'd4', 'f4'])).map((e) => ({ ...e })), BRIEF);
  assert.ok(stab(0.125).every((e) => e.solid));
  assert.ok(stab(0.0625).every((e) => !e.solid));
});

test('markSolid: layered brief lines that name no chord are not solid', () => {
  const layered16 = [...run(0, 0, 0.0625, ['c4', 'd4']), ...run(1, 0, 0.0625, ['e4', 'g4'])];
  assert.ok(markSolid(pitchedEvents(layered16).map((e) => ({ ...e }))).every((e) => !e.solid));
  const cluster = stack(0, 0, 0.125, ['c4', 'c#4', 'd4']); // three classes on one eighth, no chord shape
  assert.ok(markSolid(pitchedEvents(cluster).map((e) => ({ ...e }))).every((e) => !e.solid));
});

test('segments: a 2-cycle pad under a 1/8-cycle melody is one segment, not one per melody note', () => {
  const pad = stack(0, 0, 2, ['d3', 'f3', 'a3', 'c4']);
  const melody = run(1, 0, 0.125, ['c5', 'd5', 'e5', 'f5', 'g5', 'a5', 'g5', 'f5', 'e5', 'd5', 'c5', 'd5', 'e5', 'f5', 'g5', 'a5']);
  const solid = markSolid(pitchedEvents([...pad, ...melody]).map((e) => ({ ...e })), HARMONIC_MIN);
  const out = segments(solid);
  assert.equal(out.length, 1);
  assert.equal(out[0].mask, [2, 5, 9, 0].reduce((m, pc) => m | (1 << pc), 0));
  assert.equal(out[0].bassPc, 2);
  assert.equal(out[0].poly, 4);
  close(out[0].begin, 0);
  close(out[0].end, 2);
});

test('segments: sets with the same pitch classes merge across a cycle boundary', () => {
  const raw = [...stack(0, 0, 1, ['d3', 'f3', 'a3', 'c4']), ...stack(0, 1, 2, ['d3', 'f3', 'a3', 'c4'])];
  const out = segments(markSolid(pitchedEvents(raw).map((e) => ({ ...e })), BRIEF));
  assert.equal(out.length, 1);
  close(out[0].begin, 0);
  close(out[0].end, 2);
});

test('segments cuts a change of notes into separate segments and honors the from/to window', () => {
  const raw = [...stack(0, 0, 1, ['c3', 'e3', 'g3']), ...stack(0, 1, 2, ['f3', 'a3', 'c4'])];
  const solid = markSolid(pitchedEvents(raw).map((e) => ({ ...e })), BRIEF);
  assert.equal(segments(solid).length, 2);
  const window = segments(solid, 1, 2);
  assert.equal(window.length, 1);
  assert.equal(window[0].bassPc, 5);
});

// --- scale detection ---

const PADS = [
  ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
  ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
  ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
  ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
];

test('detectScale: four pads with no bass are an honest tie of four scales in a fixed order', () => {
  const scale = read(PADS);
  assert.equal(scale.status, 'ambiguous');
  assert.equal(scale.kind, 'tie');
  assert.deepEqual(candidateNames(scale), ['C major', 'G Mixolydian', 'A minor', 'F Lydian']);
});

test('detectScale: the same pads over an A pedal are clear A minor', () => {
  const pedal = loop(4, (c) => ev(1, c, c + 1, 'a2'));
  const scale = read([...PADS, ...pedal]);
  assert.equal(scale.status, 'clear');
  assert.equal(scale.name, 'A minor');
  assert.deepEqual(scale.notes.map((n) => n.name), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(scale.notes[0].degree, '1');
  assert.equal(scale.notes[2].degree, '♭3');
});

test('detectScale: a D pedal under a D-to-D eighth-note run is clear D Dorian, not C major', () => {
  const pedal = loop(4, (c) => ev(1, c, c + 1, 'd2'));
  const melody = loop(4, (c) => run(0, c, 0.125, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4']));
  const scale = read([...pedal, ...melody]);
  assert.equal(scale.status, 'clear');
  assert.equal(scale.name, 'D Dorian');
});

// One cycle of A minor pentatonic: A C D weigh a quarter cycle each, E and G an eighth each.
const pentatonic = (c) => [
  ev(0, c, c + 0.25, 'a3'),
  ev(0, c + 0.25, c + 0.5, 'c4'),
  ev(0, c + 0.5, c + 0.75, 'd4'),
  ev(0, c + 0.75, c + 0.875, 'e4'),
  ev(0, c + 0.875, c + 1, 'g4'),
];

test('detectScale: a minor pentatonic melody over an A bass ties A Dorian, A Phrygian and A minor', () => {
  const bass = loop(4, (c) => ev(1, c, c + 1, 'a2'));
  const scale = read([...loop(4, pentatonic), ...bass]);
  assert.equal(scale.status, 'ambiguous');
  assert.equal(scale.kind, 'tie');
  assert.deepEqual(candidateNames(scale).sort(), ['A Dorian', 'A Phrygian', 'A minor']);
});

test('detectScale: the same melody without the bass is a tie of nine', () => {
  const scale = read(loop(4, pentatonic));
  assert.equal(scale.status, 'ambiguous');
  assert.equal(scale.kind, 'tie');
  assert.equal(scale.candidates.length, 9);
});

test('detectScale: all twelve pitch classes fit none of the nine scales', () => {
  const names = ['c4', 'c#4', 'd4', 'd#4', 'e4', 'f4', 'f#4', 'g4', 'g#4', 'a4', 'a#4', 'b4'];
  assert.deepEqual(read(loop(2, (c) => run(0, c, 1 / 12, names))), { status: 'no-fit' });
});

test('detectScale: no pitched event gives none', () => {
  assert.deepEqual(detectScale([], []), { status: 'none' });
  assert.deepEqual(read([{ begin: 0, end: 1, value: { s: 'bd' } }]), { status: 'none' });
});

test('detectScale: freq events read as pitched notes and tie on four scales', () => {
  const raw = [220, 261.63, 329.63, 233].map((freq, i) => ({ begin: i / 4, end: (i + 1) / 4, value: { freq }, track: 0 }));
  const pitched = pitchedEvents(raw);
  assert.deepEqual(pitched.map((e) => e.pc), [9, 0, 4, 10]);
  const scale = read(raw);
  assert.equal(scale.status, 'ambiguous');
  assert.equal(scale.kind, 'tie');
  assert.equal(scale.candidates.length, 4);
});

test('detectScale: candidates that do not share the top coverage are a near tie', () => {
  // A line that is C major except for F (0.052 of the weight) against F# (0.048): C major and G major nearly tie.
  const weights = [['c4', 0.15], ['d4', 0.15], ['e4', 0.15], ['g4', 0.15], ['a4', 0.15], ['b4', 0.15], ['f4', 0.052], ['f#4', 0.048]];
  let at = 0;
  const raw = weights.map(([note, width]) => {
    const event = ev(0, at, at + width, note);
    at += width;
    return event;
  });
  const scale = read(raw);
  assert.equal(scale.status, 'ambiguous');
  assert.equal(scale.kind, 'near');
  assert.ok(new Set(scale.candidates.map((c) => c.coverage.toFixed(6))).size > 1);
});

test('detectScale follows the notes: a rare outside chord keeps C major, a long one no longer reads C major', () => {
  const melody = loop(8, (c) => run(0, c, 0.125, ['c4', 'd4', 'e4', 'f4', 'g4', 'a4', 'b4', 'b4']));
  const pedal = loop(8, (c) => ev(1, c, c + 1, 'c2'));
  const withChord = (cycles) => [...melody, ...pedal, ...loop(cycles, (c) => stack(2, c, c + 1, ['bb3', 'd4', 'f4']))];
  const rare = read(withChord(1));
  assert.equal(rare.status, 'clear');
  assert.equal(rare.name, 'C major');
  // Four cycles of Bb major: B no longer outweighs Bb, so the reading leaves C major. C Mixolydian and
  // Bb Lydian hold the same notes and the chord's root ties the tonic, so it says so instead of betting.
  const heavy = read(withChord(4));
  assert.equal(heavy.status, 'ambiguous');
  assert.ok(!candidateNames(heavy).includes('C major'));
  assert.ok(candidateNames(heavy).includes('C Mixolydian'));
});

// --- parts ---

test('chooseArrangement: null with no arrangement', () => {
  assert.equal(chooseArrangement([], pitchedEvents([ev(0, 0, 1, 'c3')])), null);
});

test('chooseArrangement skips an arrangement owned by a drums-only track', () => {
  const drums = { index: 0, owner: 0, sections: [], total: 8, offset: 0 };
  const lead = { index: 1, owner: 1, sections: [], total: 8, offset: 0 };
  const pitched = pitchedEvents([ev(1, 0, 1, 'c3')]);
  assert.equal(chooseArrangement([drums, lead], pitched), lead);
  assert.equal(chooseArrangement([drums], pitched), null);
});

test('pitchedEvents keeps every track that plays a doubled note and chooseArrangement still finds the owner', () => {
  const pitched = pitchedEvents([ev(0, 0, 1, 'c3'), ev(1, 0, 1, 'c3')]);
  assert.equal(pitched.length, 1);
  assert.equal(pitched[0].track, 0);
  assert.deepEqual([...pitched[0].tracks], [0, 1]);
  const second = { index: 0, owner: 1, sections: [], total: 8, offset: 0 };
  assert.equal(chooseArrangement([second], pitched), second);
});

test('chooseArrangement returns an arrangement with no owner when any pitched note plays', () => {
  const free = { index: 0, owner: null, sections: [], total: 8, offset: 0 };
  assert.equal(chooseArrangement([free], pitchedEvents([ev(4, 0, 1, 'c3')])), free);
  assert.equal(chooseArrangement([free], pitchedEvents([{ begin: 0, end: 1, value: { s: 'bd' }, track: 4 }])), null);
});

const calmNotes = ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'];
const brightNotes = ['e3', 'f#3', 'g3', 'a3', 'b3', 'c4', 'd#4', 'e4'];
const TWO_PARTS = {
  index: 0,
  owner: 0,
  total: 8,
  offset: 0,
  sections: [{ name: 'calm', length: 4, start: 0 }, { name: 'bright', length: 4, start: 4 }],
};
const partsEvents = loop(64, (c) => run(0, c, 0.125, c % 8 < 4 ? calmNotes : brightNotes));

test('buildReading with an arrangement gives one span per section instance with absolute bounds', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  assert.equal(reading.status, 'ready');
  assert.equal(reading.spans.length, 16);
  assert.deepEqual(reading.spans.map((s) => s.name), Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 'calm' : 'bright')));
  reading.spans.forEach((span, i) => {
    close(span.begin, i * 4);
    close(span.end, i * 4 + 4);
    assert.equal(span.length, 4);
  });
  assert.equal(reading.arrangement, TWO_PARTS);
});

test('buildReading pools every instance of a part into one scale per part', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const calm = reading.spans.filter((s) => s.name === 'calm');
  assert.ok(calm.every((s) => s.scale === calm[0].scale));
  assert.equal(calm[0].scale.status, 'clear'); // the run starts and ends on D: its tonic beats C major
  assert.equal(calm[0].scale.name, 'D Dorian');
  const bright = reading.spans.find((s) => s.name === 'bright');
  assert.equal(bright.scale.status, 'clear');
  assert.equal(bright.scale.name, 'E harmonic minor');
  assert.notEqual(calm[0].scale, bright.scale);
});

test('buildReading gives a section with no pitched event the scale status none', () => {
  const quiet = { ...TWO_PARTS, sections: [{ name: 'calm', length: 4, start: 0 }, { name: 'quiet', length: 4, start: 4 }] };
  const events = loop(64, (c) => (c % 8 < 4 ? run(0, c, 0.125, calmNotes) : []));
  const reading = buildReading({ events, windowStart: 0, windowLength: 64, arrangements: [quiet] });
  assert.deepEqual(reading.spans.find((s) => s.name === 'quiet').scale, { status: 'none' });
  assert.notEqual(reading.spans.find((s) => s.name === 'calm').scale.status, 'none');
});

test('buildReading: a one-section arrangement gives spans of that name, no arrangement gives one span named null', () => {
  const single = { ...TWO_PARTS, total: 4, sections: [{ name: 'loop', length: 4, start: 0 }] };
  const arranged = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [single] });
  assert.ok(arranged.spans.every((s) => s.name === 'loop'));
  const plain = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64 });
  assert.equal(plain.spans.length, 1);
  assert.equal(plain.spans[0].name, null);
  assert.equal(plain.arrangement, null);
});

test('buildReading gives each instance of a repeated part name its own section length', () => {
  const uneven = {
    index: 0,
    owner: 0,
    total: 6,
    offset: 0,
    sections: [{ name: 'verse', length: 2, start: 0 }, { name: 'verse', length: 4, start: 2 }],
  };
  const events = loop(12, (c) => run(0, c, 0.125, calmNotes));
  const reading = buildReading({ events, windowStart: 0, windowLength: 12, arrangements: [uneven] });
  assert.deepEqual(reading.spans.map((s) => s.length), [2, 4, 2, 4]);
  assert.deepEqual(reading.spans.map((s) => s.end - s.begin), [2, 4, 2, 4]);
});

test('buildReading carries in a note that began before the window and still sounds, clipped to the window start', () => {
  const pad = stack(0, -32, 16, ['c3', 'e3', 'g3']);
  const gone = stack(1, -32, -0.5, ['f#3', 'a#3', 'c#4']);
  const reading = buildReading({ events: [...pad, ...gone], windowStart: 0, windowLength: 64 });
  assert.equal(reading.status, 'ready');
  assert.equal(reading.spans[0].harmonic.length, 1);
  close(reading.spans[0].harmonic[0].begin, 0);
  close(reading.spans[0].harmonic[0].end, 16);
  assert.equal(readingAt(reading, { cycle: 4, cps: 0.5, playing: true }).chord.name, 'C');
  assert.equal(readingAt(reading, { cycle: 20, cps: 0.5, playing: true }).chord, null);
});

test('buildReading refuses more than MAX_PITCHED_EVENTS pitched events', () => {
  const count = MAX_PITCHED_EVENTS + 1;
  const events = Array.from({ length: count }, (_, i) => ev(0, i * 0.001, i * 0.001 + 0.0005, 'c3'));
  const reading = buildReading({ events, windowStart: 0, windowLength: 64 });
  assert.equal(reading.status, 'too-dense');
  assert.equal(reading.count, count);
});

test('buildReading with no pitched event has status none', () => {
  const reading = buildReading({ events: [{ begin: 0, end: 1, value: { s: 'bd' } }], windowStart: 32, windowLength: 64 });
  assert.equal(reading.status, 'none');
  assert.equal(reading.windowStart, 32);
  assert.equal(reading.windowEnd, 96);
});

// --- readingAt ---

test('readingAt returns the span that holds the cycle, else a whole-window span carrying the whole scale', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const inside = readingAt(reading, { cycle: 5.5, cps: 0.5, playing: true });
  assert.equal(inside.span.name, 'bright');
  assert.equal(inside.scale, inside.span.scale);
  assert.equal(inside.playing, true);
  const edge = readingAt(reading, { cycle: 4, cps: 0.5, playing: true });
  assert.equal(edge.span.name, 'bright');
  const outside = readingAt(reading, { cycle: 100, cps: 0.5, playing: false });
  assert.equal(outside.span.name, null);
  assert.equal(outside.scale, reading.whole);
});

test('readingAt throws a Moontide error for a cycle or a tempo that is not a finite positive number', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64 });
  assert.throws(() => readingAt(reading, { cycle: Number.NaN, cps: 0.5, playing: true }), /^Error: Moontide:/);
  for (const cps of [0, -1, Number.NaN]) {
    assert.throws(() => readingAt(reading, { cycle: 1, cps, playing: true }), /^Error: Moontide:/, `cps ${cps}`);
  }
});

test('EPS is the float tolerance for cycle comparisons', () => {
  assert.equal(EPS, 1e-6);
});

// --- cost ---

test('building a reading from a 64-cycle, seven-layer pattern of about 5,000 notes takes under a second', () => {
  const pool = ['c3', 'd3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4', 'e4', 'f4', 'g4'];
  const events = [];
  for (let layer = 0; layer < 7; layer++) {
    for (let c = 0; c < 64; c++) {
      for (let slot = 0; slot < 12; slot++) {
        events.push(ev(layer, c + slot / 12, c + (slot + 1) / 12, pool[(slot + layer) % 12]));
      }
    }
  }
  const start = performance.now();
  const reading = buildReading({ events, windowStart: 0, windowLength: 64 });
  const elapsed = performance.now() - start;
  assert.equal(reading.status, 'ready');
  assert.ok(pitchedEvents(events).length > 4000);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

// --- warnings ---

/** A clear scale object for `warningsFor`, built the way detectScale builds one. */
function clearScale(root, modeId) {
  const mode = MODES.find((m) => m.id === modeId);
  return { status: 'clear', root, mode, name: scaleName(root, mode), spell: spellTable(root, mode) };
}
const D_DORIAN = clearScale(2, 'dorian');
const C_MAJOR = clearScale(0, 'ionian');
/** The solid segments of raw events, as buildReading cuts them for warnings. */
const solidSegments = (raw, from, to) => segments(markSolid(pitchedEvents(raw), BRIEF), from, to);
const warn = (raw, scale, from, to) => warningsFor(solidSegments(raw, from, to), scale);

test('MERGE_GAP is half a cycle and LOOK_AHEAD is the Timeline page length', () => {
  assert.equal(MERGE_GAP, 0.5);
  assert.equal(LOOK_AHEAD, 32);
});

test('warningsFor: an A7 over a D pedal in D Dorian warns with chord A7/D, outside C#, avoid C', () => {
  const raw = [ev(1, 0, 1, 'd2'), ...stack(2, 0, 1, ['a2', 'c#3', 'e3', 'g3'])];
  const [w, ...rest] = warn(raw, D_DORIAN);
  assert.equal(rest.length, 0);
  assert.equal(w.chord, 'A7/D');
  assert.deepEqual(w.outside, ['C#']);
  assert.deepEqual(w.avoid, ['C']);
  assert.deepEqual(w.outsidePcs, [1]);
  assert.deepEqual(w.avoidPcs, [0]);
  assert.deepEqual(w.notes, ['D', 'E', 'G', 'A', 'C#']);
  assert.equal(w.begin, 0);
  assert.equal(w.end, 1);
  assert.equal(w.backInKey, 1);
});

test('warningsFor: a chord inside the scale gives no warning', () => {
  const raw = [ev(1, 0, 1, 'd2'), ...stack(2, 0, 1, ['d3', 'f3', 'a3', 'c4'])];
  assert.deepEqual(warn(raw, D_DORIAN), []);
});

const cLoop = [ev(1, 0, 1, 'c2'), ...stack(2, 0, 1, ['c3', 'e3', 'g3'])];

test('warningsFor: a brief lone outside note raises no warning, the same note lasting 0.3 cycle does', () => {
  assert.deepEqual(warn([...cLoop, ev(0, 0.2, 0.3, 'f#3')], C_MAJOR), []);
  const [w] = warn([...cLoop, ev(0, 0.2, 0.5, 'f#3')], C_MAJOR);
  assert.equal(w.chord, null);
  assert.deepEqual(w.notes, ['C', 'E', 'F#', 'G']);
  assert.deepEqual(w.outside, ['F#']);
  assert.deepEqual(w.avoid, ['F']);
  close(w.begin, 0.2);
  close(w.end, 0.5);
});

test('warningsFor: a named 1/8-cycle stab counts, the same stab at 1/16 cycle does not', () => {
  const [w] = warn([...cLoop, ...stack(3, 0.5, 0.625, ['bb3', 'd4', 'f4'])], C_MAJOR);
  assert.deepEqual(w.outside, ['Bb']);
  assert.deepEqual(w.avoid, ['B']);
  assert.deepEqual(warn([...cLoop, ...stack(3, 0.5, 0.5625, ['bb3', 'd4', 'f4'])], C_MAJOR), []);
});

test('warningsFor: several outside notes and their avoid notes are listed upward from the root', () => {
  const raw = [ev(1, 0, 1, 'd2'), ...stack(2, 0, 1, ['bb3', 'eb3', 'g3'])];
  const [w] = warn(raw, D_DORIAN);
  assert.deepEqual(w.outside, ['Eb', 'Bb']);
  assert.deepEqual(w.avoid, ['E', 'B']);
  assert.deepEqual(w.outsidePcs, [3, 10]);
});

test('warningsFor merges the same chord and outside notes within half a cycle, not beyond it', () => {
  const a7 = (from, to) => [ev(1, from, to, 'd2'), ...stack(2, from, to, ['a2', 'c#3', 'e3', 'g3'])];
  assert.equal(warn([...a7(0, 1), ...a7(1.5, 2.5)], D_DORIAN).length, 1);
  assert.equal(warn([...a7(0, 1), ...a7(1.5, 2.5)], D_DORIAN)[0].end, 2.5);
  assert.equal(warn([...a7(0, 1), ...a7(1.75, 2.75)], D_DORIAN).length, 2);
});

test('warningsFor: consecutive warnings 0.25 cycle apart share the end of the run as backInKey', () => {
  const raw = [
    ev(1, 0, 2, 'd2'),
    ...stack(2, 0, 1, ['a2', 'c#3', 'e3', 'g3']),
    ...stack(2, 1.25, 2, ['f#3', 'a3', 'd4']),
  ];
  const out = warn(raw, D_DORIAN);
  assert.equal(out.length, 2);
  assert.equal(out[0].backInKey, 2);
  assert.equal(out[1].backInKey, 2);
  assert.ok(out[0].end <= out[1].begin);
});

test('warningsFor: a C major loop with a Bb chord for 1 of 8 cycles stays C major and warns, for 4 of 8 it stops reading C major', () => {
  const melody = loop(8, (c) => run(0, c, 0.125, ['c4', 'd4', 'e4', 'f4', 'g4', 'a4', 'b4', 'b4']));
  const pedal = loop(8, (c) => ev(1, c, c + 1, 'c2'));
  const withChord = (cycles) => [...melody, ...pedal, ...loop(cycles, (c) => stack(2, 3 + c, 4 + c, ['bb3', 'd4', 'f4']))];
  const rare = buildReading({ events: withChord(1), windowStart: 0, windowLength: 8 });
  assert.equal(rare.whole.name, 'C major');
  assert.equal(rare.warnings.length, 1);
  close(rare.warnings[0].begin, 3);
  assert.deepEqual(rare.warnings[0].outside, ['Bb']);
  const heavy = buildReading({ events: withChord(4), windowStart: 0, windowLength: 8 });
  assert.notEqual(heavy.whole.name, 'C major');
  assert.equal(heavy.whole.status, 'ambiguous');
  assert.deepEqual(heavy.warnings, []);
});

// An eight-cycle D Dorian loop: a D pedal, a pad (Dm7, with A7 on cycles 2 and 3) and an eighth-note melody.
const DORIAN_RUN = ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'];
const dorianLoop = (cycles, a7Cycles = [2, 3]) =>
  loop(cycles, (c) => [
    ev(1, c, c + 1, 'd2'),
    ...stack(2, c, c + 1, a7Cycles.includes(c % 8) ? ['a2', 'c#3', 'e3', 'g3'] : ['d3', 'f3', 'a3', 'c4']),
    ...run(0, c, 0.125, DORIAN_RUN),
  ]);

test('buildReading: a D Dorian loop with an A7 on two cycles of eight gives eight warnings in 64 cycles', () => {
  const reading = buildReading({ events: dorianLoop(64), windowStart: 0, windowLength: 64 });
  assert.equal(reading.whole.status, 'clear');
  assert.equal(reading.whole.name, 'D Dorian');
  assert.equal(reading.warnings.length, 8);
  reading.warnings.forEach((w, i) => {
    close(w.begin, i * 8 + 2);
    close(w.end, i * 8 + 4);
    close(w.backInKey, i * 8 + 4);
    assert.equal(w.chord, 'A7/D');
    assert.equal(w.spanIndex, 0);
    assert.equal(w.scaleName, 'D Dorian');
    assert.equal(w.index, i);
  });
  assert.deepEqual(reading.spans[0].warnings, reading.warnings);
});

test('readingAt carries the warning sounding now, when the music is back in key, and the next warning', () => {
  const reading = buildReading({ events: dorianLoop(64), windowStart: 0, windowLength: 64 });
  const mid = readingAt(reading, { cycle: 2.5, cps: 1, playing: true });
  assert.equal(mid.warning.chord, 'A7/D');
  close(mid.backInKey, 4);
  close(mid.nextWarning.begin, 10);
  const start = readingAt(reading, { cycle: 2, cps: 1, playing: true });
  assert.equal(start.warning.chord, 'A7/D');
  const end = readingAt(reading, { cycle: 4, cps: 1, playing: true });
  assert.equal(end.warning, null);
  assert.equal(end.backInKey, null);
  close(end.nextWarning.begin, 10);
  const before = readingAt(reading, { cycle: 0, cps: 1, playing: true });
  assert.equal(before.warning, null);
  close(before.nextWarning.begin, 2);
});

test('readingAt: backInKey is null when the run of warnings reaches the window end', () => {
  const reading = buildReading({ events: dorianLoop(8, [6, 7]), windowStart: 0, windowLength: 8 });
  const position = readingAt(reading, { cycle: 6.5, cps: 1, playing: true });
  assert.equal(position.warning.chord, 'A7/D');
  assert.equal(position.backInKey, null);
});

test('readingAt: a warning 40 cycles from backInKey is not back in key within the look-ahead', () => {
  const events = [...dorianLoop(64, []), ...loop(40, (c) => stack(3, c + 2, c + 3, ['c#4']))];
  const reading = buildReading({ events, windowStart: 0, windowLength: 64 });
  const position = readingAt(reading, { cycle: 3, cps: 1, playing: true });
  assert.ok(position.warning);
  assert.equal(position.backInKey, null);
});

test('readingAt: an ambiguous current scale has no warning and no next warning', () => {
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const reading = buildReading({ events: pads, windowStart: 0, windowLength: 64 });
  const position = readingAt(reading, { cycle: 1, cps: 1, playing: true });
  assert.equal(position.scale.status, 'ambiguous');
  assert.equal(position.warning, null);
  assert.equal(position.backInKey, null);
  assert.equal(position.nextWarning, null);
  assert.deepEqual(reading.warnings, []);
});

// --- upcoming and partOwner ---

const at1 = (reading, cycle) => readingAt(reading, { cycle, cps: 1, playing: true });
const upcomingAt = (reading, cycle) => {
  const list = at1(reading, cycle).upcoming;
  assert.ok(Array.isArray(list), 'readingAt gives no upcoming list');
  return list;
};
const beginsOf = (entries) => entries.map((e) => Math.round(e.begin));

test('readingAt.upcoming lists the warnings to come within 32 cycles, soonest first', () => {
  const reading = buildReading({ events: dorianLoop(64), windowStart: 0, windowLength: 64 });
  const early = upcomingAt(reading, 0.5);
  assert.deepEqual(beginsOf(early), [2, 10, 18, 26]);
  assert.ok(early.every((e) => e.kind === 'warning'));
  assert.deepEqual(Object.keys(early[0]).sort(), ['begin', 'end', 'kind', 'warningIndex']);
  assert.equal(early[1].warningIndex, 1);
  close(early[0].end, 4);
  // The warning sounding now is the status's, not a row.
  assert.deepEqual(beginsOf(upcomingAt(reading, 2.5)), [10, 18, 26, 34]);
});

test('readingAt.upcoming: an event exactly at the cycle is not coming up, one exactly 32 cycles ahead is', () => {
  const reading = buildReading({ events: dorianLoop(64), windowStart: 0, windowLength: 64 });
  assert.deepEqual(beginsOf(upcomingAt(reading, 2)), [10, 18, 26, 34]);
  assert.deepEqual(beginsOf(upcomingAt(reading, 10)), [18, 26, 34, 42]);
});

const PART_DEFS = [{ name: 'a', length: 4, start: 0 }, { name: 'b', length: 4, start: 4 }];
const partsOf = (sections, extra = {}) => ({ index: 0, owner: 0, total: 8, offset: 0, sections, ...extra });
const partEnv = (cycleFn) => loop(64, cycleFn);

test('readingAt.upcoming lists part changes with the span, its length and whether the scale changes', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const up = upcomingAt(reading, 0.5);
  assert.deepEqual(beginsOf(up), [4, 8, 12, 16, 20, 24, 28, 32]);
  assert.equal(up[0].kind, 'part');
  assert.equal(up[0].name, 'bright');
  assert.equal(up[0].length, 4);
  assert.equal(up[0].change, 'changes');
  assert.equal(up[0].scaleName, 'E harmonic minor');
  assert.equal(up[0].spanIndex, 1);
  assert.equal(up[1].scaleName, 'D Dorian');
});

test('readingAt.upcoming: a part whose scale equals the previous one is same, a part without a clear scale is unclear', () => {
  const dorianPart = (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN_RUN)];
  const same = buildReading({ events: partEnv(dorianPart), windowStart: 0, windowLength: 64, arrangements: [partsOf(PART_DEFS)] });
  assert.equal(upcomingAt(same, 0.5)[0].change, 'same');
  const quiet = partEnv((c) => (c % 8 < 4 ? dorianPart(c) : []));
  const withQuiet = buildReading({ events: quiet, windowStart: 0, windowLength: 64, arrangements: [partsOf(PART_DEFS)] });
  assert.equal(upcomingAt(withQuiet, 0.5)[0].change, 'unclear');
  const pads = [['a3', 'c4', 'e4'], ['f3', 'a3', 'c4'], ['c4', 'e4', 'g4'], ['g3', 'b3', 'd4']];
  const tie = partEnv((c) => (c % 8 < 4 ? stack(0, c, c + 1, pads[c % 4]) : dorianPart(c)));
  const ambiguousFirst = buildReading({ events: tie, windowStart: 0, windowLength: 64, arrangements: [partsOf(PART_DEFS)] });
  assert.equal(ambiguousFirst.spans[0].scale.status, 'ambiguous');
  // With the current scale ambiguous only part changes are listed, never warnings.
  const up = upcomingAt(ambiguousFirst, 0.5);
  assert.ok(up.length > 0);
  assert.ok(up.every((e) => e.kind === 'part'));
  assert.equal(up[0].change, 'changes');
  assert.equal(up[1].change, 'unclear');
});

test('readingAt.upcoming: the first span of the window is never a part change', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 2, windowLength: 64, arrangements: [TWO_PARTS] });
  assert.equal(reading.spans[0].begin, 2);
  const up = readingAt(reading, { cycle: 0, cps: 1, playing: true }).upcoming;
  assert.ok(Array.isArray(up), 'readingAt gives no upcoming list');
  assert.ok(up.every((e) => e.begin > 2 + 1e-9));
  assert.equal(Math.round(up[0].begin), 4);
});

test('readingAt.upcoming lists a part change before a warning that starts at the same cycle', () => {
  const env = partEnv((c) => [
    ev(1, c, c + 1, 'd2'),
    ...stack(2, c, c + 1, c % 8 === 4 ? ['a2', 'c#3', 'e3', 'g3'] : ['d3', 'f3', 'a3', 'c4']),
    ...run(0, c, 0.125, DORIAN_RUN),
  ]);
  const reading = buildReading({ events: env, windowStart: 0, windowLength: 64, arrangements: [partsOf(PART_DEFS)] });
  const up = upcomingAt(reading, 0.5);
  assert.deepEqual(up.slice(0, 2).map((e) => e.kind), ['part', 'warning']);
  assert.equal(Math.round(up[0].begin), 4);
  assert.equal(Math.round(up[1].begin), 4);
});

test('readingAt.upcoming is empty without a window reading of warnings or parts', () => {
  const reading = buildReading({ events: dorianLoop(64, []), windowStart: 0, windowLength: 64 });
  assert.deepEqual(upcomingAt(reading, 1), []);
});

test('buildReading.partOwner names the chosen arrangement the way the Parts view does', () => {
  const tracks = [{ index: 0, name: 'drums' }, { index: 1, name: 'lead' }];
  const sections = [{ name: 'a', length: 4, start: 0 }];
  const drums = { index: 0, owner: 0, total: 4, offset: 0, sections };
  const lead = { index: 1, owner: 1, total: 4, offset: 0, sections };
  const free = { index: 1, owner: null, total: 4, offset: 0, sections };
  const events = run(1, 0, 0.5, ['c3', 'd3', 'e3', 'f3']);
  const build = (arrangements) => buildReading({ events, windowStart: 0, windowLength: 64, arrangements, tracks });
  assert.equal(build([drums, lead]).partOwner, 'lead');
  assert.equal(build([drums, free]).partOwner, 'arrange() 2');
  assert.equal(build([lead]).partOwner, null);
  assert.equal(build([]).partOwner, null);
});

// --- the chord sounding now ---

const chordAt = (reading, cycle) => readingAt(reading, { cycle, cps: 1, playing: true }).chord;

test('readingAt.chord: the pad chord sounding at the position, named and spelled by the scale', () => {
  const reading = buildReading({ events: dorianLoop(64), windowStart: 0, windowLength: 64 });
  const first = chordAt(reading, 0.5);
  assert.equal(first.name, 'Dm7');
  assert.deepEqual(first.notes, ['D', 'F', 'A', 'C']);
  assert.deepEqual([...first.pcs].sort((a, b) => a - b), [0, 2, 5, 9]);
  const over = chordAt(reading, 2.5);
  assert.equal(over.name, 'A7/D');
  assert.deepEqual(over.notes, ['D', 'E', 'G', 'A', 'C#']);
});

test('readingAt.chord: a melody of eighth notes over the pad never changes the chord', () => {
  const reading = buildReading({ events: dorianLoop(64), windowStart: 0, windowLength: 64 });
  for (const cycle of [0.05, 0.13, 0.3, 0.55, 0.8, 0.99]) {
    assert.equal(chordAt(reading, cycle).name, 'Dm7', `cycle ${cycle}`);
  }
});

test('readingAt.chord: fewer than two pitch classes together, or nothing sounding, gives null', () => {
  const lone = buildReading({ events: loop(8, (c) => run(0, c, 0.5, ['d3', 'e3'])), windowStart: 0, windowLength: 8 });
  assert.equal(chordAt(lone, 0.25), null);
  const gap = buildReading({ events: loop(1, (c) => stack(0, c, c + 1, ['d3', 'f3', 'a3'])), windowStart: 0, windowLength: 8 });
  assert.equal(chordAt(gap, 0.5).name, 'Dm');
  assert.equal(chordAt(gap, 5), null);
});

test('readingAt.chord: an unnamed set has no name and lists its notes; with no clear scale the default spelling is used', () => {
  const events = loop(8, (c) => stack(0, c, c + 1, ['c3', 'e3', 'f#3', 'g3']));
  const reading = buildReading({ events, windowStart: 0, windowLength: 8 });
  const chord = chordAt(reading, 0.5);
  assert.equal(chord.name, null);
  assert.deepEqual(chord.notes, ['C', 'E', 'F#', 'G']);
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const ambiguous = buildReading({ events: pads, windowStart: 0, windowLength: 8 });
  assert.notEqual(readingAt(ambiguous, { cycle: 0.5, cps: 1, playing: true }).scale.status, 'clear');
  assert.equal(chordAt(ambiguous, 0.5).name, 'Am');
});

test('buildReading: each span keeps the harmonic segmentation of its own events', () => {
  const reading = buildReading({ events: dorianLoop(8, []), windowStart: 0, windowLength: 8 });
  assert.ok(Array.isArray(reading.spans[0].harmonic), 'the span has no harmonic segmentation');
  assert.ok(reading.spans[0].harmonic.length > 0);
});

test('buildReading carries the declaration to the reading and never lets it change what is heard', () => {
  const events = dorianLoop(8, []);
  const plain = buildReading({ events, windowStart: 0, windowLength: 8 });
  assert.deepEqual(plain.declared, { state: 'none' });
  const declared = { state: 'declared', kind: 'scale', text: 'C:major', scale: { rootPc: 0, modeId: 'ionian' } };
  const withDeclared = buildReading({ events, windowStart: 0, windowLength: 8, declared });
  assert.equal(withDeclared.declared, declared);
  const { declared: ignoredPlain, ...heardPlain } = plain;
  const { declared: ignoredDeclared, ...heardDeclared } = withDeclared;
  assert.deepEqual(heardDeclared, heardPlain);
  assert.equal(readingAt(withDeclared, { cycle: 1, cps: 1, playing: true }).reading.declared, declared);
});

test('buildReading carries the declaration when no note is pitched, and leaves the too-dense result bare', () => {
  const declared = { state: 'unreadable', reason: 'empty', source: null };
  const drums = [{ begin: 0, end: 1, value: { s: 'bd' }, track: 0 }];
  const none = buildReading({ events: drums, windowStart: 0, windowLength: 8, declared });
  assert.equal(none.status, 'none');
  assert.equal(none.declared, declared);
  const dense = Array.from({ length: MAX_PITCHED_EVENTS + 1 }, (_, i) => ev(0, i * 0.001, i * 0.001 + 0.0005, 'c3'));
  const tooDense = buildReading({ events: dense, windowStart: 0, windowLength: 8, declared });
  assert.deepEqual(tooDense, { status: 'too-dense', count: MAX_PITCHED_EVENTS + 1 });
});

// --- drum tracks left out of the reading (excludeTracks) ---

const PAD_NOTES = ['c3', 'd3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4'];
/** The pad on track 0 (eight notes a cycle) and, optionally, numeric drum notes 36 38 42 38 on track 1 (four a cycle). */
function padAndDrums(cycles, withDrums) {
  const pad = loop(cycles, (c) => run(0, c, 1 / 8, PAD_NOTES));
  const drums = withDrums ? loop(cycles, (c) => run(1, c, 1 / 4, [36, 38, 42, 38])) : [];
  return [...pad, ...drums];
}

test('buildReading: a C major pad stays C major when the drum track is excluded, and does not when it is counted', () => {
  const window = { windowStart: 0, windowLength: 8 };
  const padOnly = buildReading({ events: padAndDrums(8, false), ...window });
  assert.equal(padOnly.whole.status, 'clear');
  assert.equal(padOnly.whole.name, 'C major');
  const counted = buildReading({ events: padAndDrums(8, true), ...window });
  assert.notEqual(counted.whole.status === 'clear' && counted.whole.name, 'C major');
  const excluded = buildReading({ events: padAndDrums(8, true), ...window, excludeTracks: new Set([1]) });
  assert.equal(excluded.whole.status, 'clear');
  assert.equal(excluded.whole.name, 'C major');
  assert.equal(excluded.status, padOnly.status);
  assert.deepEqual(excluded.whole, padOnly.whole);
  assert.deepEqual(excluded.spans, padOnly.spans);
});

test('buildReading: a reading whose only events are excluded has status none', () => {
  const events = loop(4, (c) => run(1, c, 1 / 4, [36, 38, 42, 38]));
  const reading = buildReading({ events, windowStart: 0, windowLength: 4, excludeTracks: new Set([1]) });
  assert.equal(reading.status, 'none');
});

test('buildReading: excluded events do not count toward the too-dense limit', () => {
  const dense = Array.from({ length: MAX_PITCHED_EVENTS + 1 }, (_, i) => ev(1, i * 0.001, i * 0.001 + 0.0005, 36));
  assert.equal(buildReading({ events: dense, windowStart: 0, windowLength: 8 }).status, 'too-dense');
  assert.equal(buildReading({ events: dense, windowStart: 0, windowLength: 8, excludeTracks: new Set([1]) }).status, 'none');
});

test('buildReading: an arrangement owned by an excluded track is not chosen', () => {
  const drumsOwned = { index: 0, owner: 1, name: null, sections: [{ name: 'a', length: 4, start: 0 }], total: 4, offset: 0 };
  const padOwned = { index: 1, owner: 0, name: null, sections: [{ name: 'b', length: 4, start: 0 }], total: 4, offset: 0 };
  const events = padAndDrums(8, true);
  const window = { windowStart: 0, windowLength: 8, arrangements: [drumsOwned, padOwned] };
  assert.equal(buildReading({ events, ...window }).arrangement, drumsOwned);
  assert.equal(buildReading({ events, ...window, excludeTracks: new Set([1]) }).arrangement, padOwned);
});

// --- the evidence of each candidate and the proposals of an ambiguous span ---

const modeOf = (id) => MODES.find((mode) => mode.id === id);

test('candidateKey is the root pitch class, a colon and the mode id', () => {
  assert.equal(jam.candidateKey(9, modeOf('aeolian')), '9:aeolian');
  assert.equal(jam.candidateKey(0, modeOf('harmonic-minor')), '0:harmonic-minor');
});

test('detectScale: each ambiguous candidate carries its key, score, lean and heard; lean plus heard is the tonic emphasis of its root', () => {
  const scale = read(PADS);
  assert.equal(scale.status, 'ambiguous');
  for (const candidate of scale.candidates) {
    assert.equal(candidate.key, `${candidate.root}:${candidate.mode.id}`);
    assert.equal(typeof candidate.score, 'number');
    assert.ok(candidate.lean >= 0 && candidate.heard >= 0);
    close(candidate.lean + candidate.heard, (candidate.score - candidate.coverage) / TONIC_BONUS, 'lean plus heard is the tonic emphasis');
    assert.equal(candidateNames(scale).includes(candidate.name), true);
  }
  assert.deepEqual(scale.candidates.map((c) => c.key), ['0:ionian', '7:mixolydian', '9:aeolian', '5:lydian']);
});

test('detectScale: the four pads have equal bass and chord evidence for every candidate, so only the note weights tell them apart', () => {
  const scale = read(PADS);
  const [first, ...others] = scale.candidates;
  for (const other of others) close(other.lean, first.lean, 'the bass and chord evidence is the same for the four roots');
  assert.ok(others.every((other) => first.heard > other.heard + 1e-9), 'C is the note heard most');
});

test('detectScale: an A drone under a line that fits A minor and A Dorian leans on A for both', () => {
  const drone = loop(4, (c) => ev(1, c, c + 1, 'a2'));
  const melody = loop(4, (c) => run(0, c, 1 / 6, ['a3', 'b3', 'c4', 'd4', 'e4', 'g4']));
  const scale = read([...drone, ...melody]);
  assert.equal(scale.status, 'ambiguous');
  assert.deepEqual(scale.candidates.map((c) => c.key).sort(), ['9:aeolian', '9:dorian']);
  close(scale.candidates[0].heard, scale.candidates[1].heard);
});

test('clearScale gives the clear shape detectScale returns for the same scale', () => {
  const pedal = loop(4, (c) => ev(1, c, c + 1, 'a2'));
  const detected = read([...PADS, ...pedal]);
  assert.equal(detected.status, 'clear');
  assert.deepEqual(jam.clearScale(detected.root, detected.mode, detected.coverage), detected);
});

// A line whose F and F# alternate: C major and G major cover the same weight with different notes.
const FSHARP_NOTES = ['c4', 'd4', 'e4', 'g4', 'a4', 'b4'];
const fsharpLine = (cycles) =>
  loop(cycles, (i) => [...run(0, i * 2, 0.25, FSHARP_NOTES), ev(0, i * 2 + 1.5, i * 2 + 1.75, i % 2 === 0 ? 'f4' : 'f#4')]);

test('buildReading: an ambiguous span carries one proposal per candidate with its scale and its own warnings', () => {
  const events = fsharpLine(8);
  const reading = buildReading({ events, windowStart: 0, windowLength: 16 });
  const span = reading.spans[0];
  assert.equal(span.scale.status, 'ambiguous');
  assert.equal(span.proposals.length, span.scale.candidates.length);
  const pitched = pitchedEvents(events);
  const brief = segments(markSolid(pitched.map((e) => ({ ...e })), BRIEF), span.begin, span.end);
  let withWarnings = 0;
  span.scale.candidates.forEach((candidate, i) => {
    const proposal = span.proposals[i];
    assert.equal(proposal.key, candidate.key);
    assert.deepEqual(proposal.scale, jam.clearScale(candidate.root, candidate.mode, candidate.coverage));
    const expected = warningsFor(brief, proposal.scale).map((w) => ({ ...w, spanIndex: 0, scaleName: proposal.scale.name }));
    assert.deepEqual(proposal.warnings, expected);
    for (const warning of proposal.warnings) assert.equal('index' in warning, false);
    if (proposal.warnings.length > 0) withWarnings++;
  });
  assert.ok(withWarnings > 0, 'some candidate has outside notes to warn about');
  // The base reading still has no warning: its scale is not clear.
  assert.deepEqual(reading.warnings, []);
  assert.deepEqual(span.warnings, []);
});

test('buildReading: a clear span carries no proposals', () => {
  const reading = buildReading({ events: dorianLoop(8), windowStart: 0, windowLength: 8 });
  assert.equal(reading.spans[0].scale.status, 'clear');
  assert.deepEqual(reading.spans[0].proposals, []);
  const none = buildReading({ events: [{ begin: 0, end: 1, value: { s: 'bd' }, track: 0 }], windowStart: 0, windowLength: 8 });
  assert.deepEqual(none.spans[0].proposals, []);
});
