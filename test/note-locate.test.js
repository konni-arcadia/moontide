// How a note drawn on the Timeline leads back to one place in the code, tested on code parsed with acorn. The places of a note
// (`event.locations`) are written here by hand the way the pinned Strudel gives them (offsets of the strings the note was read
// from, in no fixed order); the real ones are proved in the live page by `npm run probe:page -- --only timeline`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { HELPER_TEXT, readStructure } from '../page/structure.js';
import {
  NOTE_REASONS,
  PLACES_MAX_CYCLES,
  classifyNote,
  compareReadBack,
  indexCode,
  perCycleCount,
  placesOf,
  readerCounter,
  sameTokenEvents,
  trackScope,
} from '../page/note-locate.js';

/** The place of the `nth` occurrence of `text` in `code`, as Strudel gives it: { start, end }. */
function at(code, text, nth = 0) {
  let from = -1;
  for (let i = 0; i <= nth; i++) {
    from = code.indexOf(text, from + 1);
    if (from === -1) throw new Error(`the test code has no occurrence ${nth} of '${text}'`);
  }
  return { start: from, end: from + text.length };
}

/** Reads `code` the way the page does and gives a function that classifies one note of one track. */
function setup(code) {
  const tracks = extractTracks(code, { parse });
  const reading = readStructure(code, { parse, tracks });
  const index = indexCode(code, { parse });
  const scopes = tracks.map((track) => trackScope({ track, reading }));
  const readers = readerCounter(index, scopes);
  return {
    code,
    tracks,
    reading,
    index,
    scopes,
    readers,
    classify(trackIndex, value, locations, { midi = false } = {}) {
      const event = { begin: 0, end: 1, value, locations };
      return classifyNote({ code, index, event, scope: scopes.find((scope) => scope.index === trackIndex), scopes, readers, midi });
    },
  };
}

test('the reasons a note cannot be edited are these eight, in the order they are tried', () => {
  assert.deepEqual([...NOTE_REASONS], ['no-token', 'no-pitch', 'several', 'degrees', 'escape', 'shifted', 'outside', 'shared']);
  assert.ok(Object.isFrozen(NOTE_REASONS));
});

test('indexCode lists the double-quoted and template strings with the call they are an argument of, and leaves single quotes out', () => {
  const code = 't1: note("c3 e3").s(\'x\').velocity("0.5")\nt2: s("bd").note(`g3`)\nt3: "c3 e3".note()\nt4: note(cat("a3"))';
  const { strings } = indexCode(code, { parse });
  assert.deepEqual(
    strings.map((entry) => [code.slice(entry.start, entry.end), entry.call]),
    [['"c3 e3"', 'note'], ['"0.5"', 'velocity'], ['"bd"', 's'], ['`g3`', 'note'], ['"c3 e3"', null], ['"a3"', 'cat']],
  );
  assert.ok(strings.every((entry, i) => i === 0 || strings[i - 1].start < entry.start), 'sorted by start');
  assert.equal(strings[0].raw, '"c3 e3"');
});

test('indexCode lists the top-level declarations with the range of the initializer, and the identifiers that read a name', () => {
  const code = 'const riff = note("c3");\nlet more = riff.fast(2);\nvar plain;\nt1: riff.gain(0)';
  const { declarations, references } = indexCode(code, { parse });
  assert.deepEqual(declarations.map((entry) => [entry.name, code.slice(entry.start, entry.end)]), [['riff', 'note("c3")'], ['more', 'riff.fast(2)']]);
  assert.equal(references.get('riff').length, 3);
  // A property name is not a read of a name.
  assert.equal(indexCode('t1: a.riff.gain(0)', { parse }).references.has('riff'), false);
});

test('a note of a double-quoted literal leads back to its token', () => {
  const code = 't1: note("c3 e3").gain(0)';
  const t = setup(code);
  assert.deepEqual(t.classify(0, { note: 'c3' }, [at(code, 'c3')]), { editable: true, token: { ...at(code, 'c3'), text: 'c3' }, velocity: { writable: false } });
  assert.deepEqual(t.classify(0, { note: 'e3' }, [at(code, 'e3')]).token.text, 'e3');
});

test('a velocity string, a template literal and a note written as a number add no trouble', () => {
  const velocity = 't1: note("c3 e3").velocity("0.5 1").gain(0)';
  const a = setup(velocity);
  const result = a.classify(0, { note: 'c3', velocity: 0.5 }, [at(velocity, '0.5'), at(velocity, 'c3')]);
  assert.equal(result.editable, true);
  assert.equal(result.token.text, 'c3');
  const template = 't1: note(`c3 e3`).gain(0)';
  assert.equal(setup(template).classify(0, { note: 'c3' }, [at(template, 'c3')]).editable, true);
  const numbers = 't1: note("48 50").gain(0)';
  const result48 = setup(numbers).classify(0, { note: 48 }, [at(numbers, '48')]);
  assert.deepEqual(result48, { editable: true, token: { ...at(numbers, '48'), text: '48' }, velocity: { writable: false } });
});

test('the velocity of a note is writable when it is one bare number of a velocity string in the track, with the gain that makes the shown value', () => {
  const code = 't1: note("c3 e3").velocity("0.5 1").postgain(0)';
  const t = setup(code);
  const c3 = { note: 'c3', velocity: 0.5 };
  // A browser lane at the default gain 0.8 shows 0.40.
  const result = t.classify(0, c3, [at(code, '0.5'), at(code, 'c3')]);
  assert.deepEqual(result.velocity, { writable: true, token: { ...at(code, '0.5'), text: '0.5' }, gain: 0.8, shown: 0.4 });
  // A gain the note carries is the gain; a MIDI lane starts at 1.
  const withGain = t.classify(0, { ...c3, gain: 1 }, [at(code, '0.5'), at(code, 'c3')]);
  assert.deepEqual([withGain.velocity.gain, withGain.velocity.shown], [1, 0.5]);
  const onMidi = t.classify(0, c3, [at(code, '0.5'), at(code, 'c3')], { midi: true });
  assert.deepEqual([onMidi.velocity.gain, onMidi.velocity.shown], [1, 0.5]);
  // The second note reads the second number of the string.
  const e3 = t.classify(0, { note: 'e3', velocity: 1 }, [{ start: code.indexOf('1")'), end: code.indexOf('1")') + 1 }, at(code, 'e3')]);
  assert.deepEqual([e3.velocity.writable, e3.velocity.token.text, e3.velocity.shown], [true, '1', 0.8]);
});

test('the velocity is fixed in the code when no single number gives it: a signal, no string, a shared string, a factor, a gain of 0', () => {
  const classify = (code, value, places, options) => {
    const t = setup(code);
    return t.classify(0, value, places(code), options).velocity;
  };
  // No velocity string, or a signal in its place.
  assert.deepEqual(classify('t1: note("c3").gain(0)', { note: 'c3' }, (c) => [at(c, 'c3')]), { writable: false });
  assert.deepEqual(classify('t1: note("c3").velocity(sine).gain(0)', { note: 'c3', velocity: 0.5 }, (c) => [at(c, 'c3')]), { writable: false });
  // A string made by a const outside the track, or read by several tracks.
  const shared = 'const v = "0.5 1";\nt1: note("c3 e3").velocity(v).postgain(0)';
  assert.deepEqual(classify(shared, { note: 'c3', velocity: 0.5 }, (c) => [at(c, '0.5'), at(c, 'c3')]), { writable: false });
  // A factor adds a place of its own; so does a second velocity string.
  const factor = 't1: note("c3").velocity("0.5*2").postgain(0)';
  assert.deepEqual(classify(factor, { note: 'c3', velocity: 1 }, (c) => [at(c, '0.5'), at(c, '2'), at(c, 'c3')]), { writable: false });
  const twice = 't1: note("c3").velocity("0.5").velocity("0.25").postgain(0)';
  assert.deepEqual(classify(twice, { note: 'c3', velocity: 0.25 }, (c) => [at(c, '0.5'), at(c, '0.25'), at(c, 'c3')]), { writable: false });
  // The number is not the velocity heard (something multiplies it), or the string holds a name, not a number.
  const code = 't1: note("c3").velocity("0.5").postgain(0)';
  assert.deepEqual(classify(code, { note: 'c3', velocity: 0.25 }, (c) => [at(c, '0.5'), at(c, 'c3')]), { writable: false });
  const word = 't1: note("c3").velocity("x").postgain(0)';
  assert.deepEqual(classify(word, { note: 'c3', velocity: 0.5 }, (c) => [{ start: c.indexOf('x'), end: c.indexOf('x') + 1 }, at(c, 'c3')]), { writable: false });
  // A gain of 0, or a gain that is not a number, cannot be divided into a token.
  assert.deepEqual(classify(code, { note: 'c3', velocity: 0.5, gain: 0 }, (c) => [at(c, '0.5'), at(c, 'c3')]), { writable: false });
  assert.deepEqual(classify(code, { note: 'c3', velocity: 0.5, gain: { signal: true } }, (c) => [at(c, '0.5'), at(c, 'c3')]), { writable: false });
  // A velocity string inside a song's variation const is the track's own.
  const song = 'const t1 = { va: note("c3 e3").velocity("0.5 1") };\nt1: note("c3").postgain(0)';
  assert.equal(setup(song).classify(0, { note: 'c3' }, [at(song, 'c3', 1)]).velocity.writable, false);
});

test('a note in degrees is refused as degrees, with a single or a double-quoted scale', () => {
  const single = "t1: n(\"0 2\").scale('C3:major').gain(0)";
  assert.deepEqual(setup(single).classify(0, { note: 'C3' }, [at(single, '0')]), { editable: false, reason: 'degrees' });
  const double = 't1: n("0 2").scale("C3:major").gain(0)';
  const t = setup(double);
  // The double-quoted scale adds two places, in a scale literal: they never count.
  assert.deepEqual(t.classify(0, { note: 'C3' }, [at(double, 'major'), at(double, 'C3'), at(double, '0')]), { editable: false, reason: 'degrees' });
});

test('a note made by a function or by chance, or written in a single-quoted string, has no token', () => {
  const run = "t1: n(run(4)).scale('C3:major').gain(0)";
  const t = setup(run);
  assert.deepEqual(t.classify(0, { note: 'C3' }, null), { editable: false, reason: 'no-token' });
  assert.deepEqual(t.classify(0, { note: 'C3' }, []), { editable: false, reason: 'no-token' });
  const single = "t1: note('c3 e3').gain(0)";
  assert.deepEqual(setup(single).classify(0, { note: 'c3' }, []), { editable: false, reason: 'no-token' });
  // A place that lies in no string at all (such as a value made by code) is ignored.
  const code = 't1: note("c3").gain(0)';
  assert.deepEqual(setup(code).classify(0, { note: 'c3' }, [{ start: 0, end: 2 }]), { editable: false, reason: 'no-token' });
});

test('a value with no pitch is a sample, not a pitched note', () => {
  const code = 't1: s("bd sd").gain(0)';
  assert.deepEqual(setup(code).classify(0, { s: 'bd' }, [at(code, 'bd')]), { editable: false, reason: 'no-pitch' });
  assert.deepEqual(setup(code).classify(0, { s: 'bd' }, null), { editable: false, reason: 'no-pitch' });
});

test('two places in note literals (an added string, a factor) are refused as several', () => {
  const added = 't1: note("c3 e3").add(note("12")).gain(0)';
  assert.deepEqual(setup(added).classify(0, { note: 'c3' }, [at(added, '12'), at(added, 'c3')]), { editable: false, reason: 'several' });
  const factor = 't1: note("c3*2 e3!2").gain(0)';
  const t = setup(factor);
  assert.deepEqual(t.classify(0, { note: 'c3' }, [at(factor, 'c3'), at(factor, '2')]), { editable: false, reason: 'several' });
  // The repeated e3 has one place of its own and stays editable.
  assert.equal(t.classify(0, { note: 'e3' }, [at(factor, 'e3')]).editable, true);
});

test('a pitch that is not the pitch of the token is refused as shifted (an added number, a copy)', () => {
  const added = 't1: note("c3 e3").add(note(12)).gain(0)';
  assert.deepEqual(setup(added).classify(0, { note: 60 }, [at(added, 'c3')]), { editable: false, reason: 'shifted' });
  const copy = 't1: note("c3 e3").off(0.25, x => x.add(note(7))).gain(0)';
  const t = setup(copy);
  assert.equal(t.classify(0, { note: 'c3' }, [at(copy, 'c3')]).editable, true);
  assert.deepEqual(t.classify(0, { note: 55 }, [at(copy, 'c3')]), { editable: false, reason: 'shifted' });
  // A token that is neither a note name nor a number cannot be the pitch heard.
  const word = 't1: note("c3 foo").gain(0)';
  assert.deepEqual(setup(word).classify(0, { note: 48 }, [at(word, 'foo')]), { editable: false, reason: 'shifted' });
  // A name the page can read but Strudel does not play (a capital accidental) is refused, so the page never meets it in a step.
  for (const [name, midi] of [['EB3', 63], ['CS3', 49], ['bB2', 46]]) {
    const capital = `t1: note("${name} g3").gain(0)`;
    assert.deepEqual(setup(capital).classify(0, { note: name }, [at(capital, name)]), { editable: false, reason: 'shifted' }, `${name} (${midi})`);
  }
  // Capital letters and lower-case accidentals are spelled the way Strudel plays them and stay editable.
  const spelled = 't1: note("Eb3 g3").gain(0)';
  assert.equal(setup(spelled).classify(0, { note: 'Eb3' }, [at(spelled, 'Eb3')]).editable, true);
});

test('an escape sequence in the string, or a place that is not a whole token, is refused as escape', () => {
  const code = String.raw`t1: note("c3\x20e3 g3").gain(0)`;
  const t = setup(code);
  // The offsets after an escape point early: the code there is not the token.
  assert.deepEqual(t.classify(0, { note: 'e3' }, [{ start: at(code, 'e3').start - 3, end: at(code, 'e3').end - 3 }]), { editable: false, reason: 'escape' });
  // Even a token before the escape is refused: the string holds a backslash.
  assert.deepEqual(t.classify(0, { note: 'c3' }, [at(code, 'c3')]), { editable: false, reason: 'escape' });
  const plain = 't1: note("c3 e3").gain(0)';
  const half = setup(plain).classify(0, { note: 'c' }, [{ start: at(plain, 'c3').start, end: at(plain, 'c3').start + 1 }]);
  assert.deepEqual(half, { editable: false, reason: 'escape' });
});

test('the same place twice is one place', () => {
  const code = 't1: note("c3").gain(0)';
  const place = at(code, 'c3');
  assert.equal(setup(code).classify(0, { note: 'c3' }, [place, { ...place }]).editable, true);
});

test('a token outside the track is outside when one track reads its code and shared when several do', () => {
  const alone = 'const only = note("d3");\nt1: only.gain(0)\nt2: note("e3").gain(0)';
  const a = setup(alone);
  assert.deepEqual(a.classify(0, { note: 'd3' }, [at(alone, 'd3')]), { editable: false, reason: 'outside' });
  const shared = 'const riff = note("c3 e3");\nt1: riff.gain(0)\nt2: riff.gain(0)';
  const b = setup(shared);
  for (const track of [0, 1]) {
    assert.deepEqual(b.classify(track, { note: 'c3' }, [at(shared, 'c3')]), { editable: false, reason: 'shared' }, `track ${track}`);
  }
  // Code that no track reads is outside too.
  const unread = 'const lost = note("c3");\nt1: note("e3").gain(0)';
  assert.deepEqual(setup(unread).classify(0, { note: 'c3' }, [at(unread, 'c3')]), { editable: false, reason: 'outside' });
});

test('code read through another declaration still counts its readers', () => {
  const code = 'const a = note("c3");\nconst b = a.fast(2);\nt1: b.gain(0)\nt2: b.gain(0)\nt3: note("g3").gain(0)';
  const t = setup(code);
  assert.deepEqual(t.classify(0, { note: 'c3' }, [at(code, 'c3')]), { editable: false, reason: 'shared' });
  assert.equal(t.readers('a'), 2);
  assert.equal(t.readers('b'), 2);
  assert.equal(t.readers('missing'), 0);
  // One track reading through the chain only: outside.
  const one = 'const a = note("c3");\nconst b = a.fast(2);\nt1: b.gain(0)\nt2: note("g3").gain(0)';
  assert.deepEqual(setup(one).classify(0, { note: 'c3' }, [at(one, 'c3')]), { editable: false, reason: 'outside' });
});

test('a reason earlier in the order wins: a note in degrees that is also outside reports degrees', () => {
  const code = "const d = n(\"0 2\").scale('C3:major');\nt1: d.gain(0)";
  assert.deepEqual(setup(code).classify(0, { note: 'C3' }, [at(code, '0')]), { editable: false, reason: 'degrees' });
});

// A structured piece: the variations of a track live in its own const, read by play().
function structured({ statements = "t1: play('t1', t1).gain(0)\nt2: play('t2', t2).gain(0)", consts } = {}) {
  return [
    "const harmony = 'C3:major';",
    "const song = { shift: 0, sections: [['x', 2], ['y', 3]], plan: { x: { t1: 'va', t2: 'va' }, y: { t1: 'vb', t2: 'va' } } };",
    HELPER_TEXT,
    consts ?? 'const t1 = { va: note("c3 e3"), vb: note("<g3 a3>") };\nconst t2 = { va: note("d3") };',
    statements,
  ].join('\n');
}

test('a note inside a variation of the track is editable, and the scope of a play() track is its own const', () => {
  const code = structured();
  const t = setup(code);
  assert.equal(t.reading.state, 'read');
  const [one, two] = t.scopes;
  assert.equal(one.kind, 'variations');
  assert.equal(code.slice(one.start, one.end), '{ va: note("c3 e3"), vb: note("<g3 a3>") }');
  assert.equal(two.kind, 'variations');
  assert.equal(t.classify(0, { note: 'c3' }, [at(code, 'c3')]).editable, true);
  assert.equal(t.classify(0, { note: 'g3' }, [at(code, 'g3')]).editable, true);
  assert.equal(t.classify(1, { note: 'd3' }, [at(code, 'd3')]).editable, true);
  // The token of another track's const is outside this track.
  assert.deepEqual(t.classify(0, { note: 'd3' }, [at(code, 'd3')]), { editable: false, reason: 'outside' });
});

test('two tracks that play the same const share it, and a track without a song keeps its statement as its scope', () => {
  const code = structured({
    consts: 'const both = { va: note("c3 e3"), vb: note("g3") };',
    statements: "t1: play('t1', both).gain(0)\nt2: play('t2', both).gain(0)",
  });
  const t = setup(code);
  assert.equal(t.reading.state, 'read');
  assert.deepEqual(t.classify(0, { note: 'c3' }, [at(code, 'c3')]), { editable: false, reason: 'shared' });
  assert.deepEqual(t.classify(1, { note: 'c3' }, [at(code, 'c3')]), { editable: false, reason: 'shared' });
  const plain = setup('t1: note("c3").gain(0)');
  assert.equal(plain.scopes[0].kind, 'statement');
  assert.equal(plain.code.slice(plain.scopes[0].start, plain.scopes[0].end), 'note("c3").gain(0)');
  // A song the page cannot read leaves every track on its statement.
  assert.equal(trackScope({ track: { index: 0, start: 3, end: 9 }, reading: { state: 'unreadable' } }).kind, 'statement');
  assert.equal(trackScope({ track: { index: 0, start: 3, end: 9 }, reading: null }).kind, 'statement');
});

test('the weighted mini clock adds a place in a literal that is no argument and leaves the notes editable', () => {
  const code = [
    'const clock = "<x@3 y@5 z@7>".late(0);',
    'const t1 = { va: note("c3 e3") };',
    "t1: note(\"c3\").gain(0)",
  ].join('\n');
  const t = setup(code);
  const clockToken = at(code, 'x');
  const noteToken = at(code, 'c3', 1);
  assert.equal(t.index.strings.find((entry) => entry.start === code.indexOf('"<x@3')).call, null);
  const result = t.classify(0, { note: 'c3' }, [clockToken, noteToken]);
  assert.deepEqual(result, { editable: true, token: { ...noteToken, text: 'c3' }, velocity: { writable: false } });
});

test('compareReadBack confirms the notes of the token at the same times with the new pitch and every other note unchanged', () => {
  const token = { start: 10, end: 12, text: 'c3' };
  const before = [
    { begin: 0, end: 0.5, value: { note: 'c3', gain: 0 }, locations: [{ start: 10, end: 12 }] },
    { begin: 0.5, end: 1, value: { note: 'e3', gain: 0 }, locations: [{ start: 13, end: 15 }] },
    { begin: 1, end: 1.5, value: { note: 'c3', gain: 0 }, locations: [{ start: 10, end: 12 }] },
  ];
  // The edit makes the token one character longer: the places after it move, the notes do not.
  const after = [
    { begin: 0, end: 0.5, value: { note: 'c#3', gain: 0 }, locations: [{ start: 10, end: 13 }] },
    { begin: 0.5, end: 1, value: { note: 'e3', gain: 0 }, locations: [{ start: 14, end: 16 }] },
    { begin: 1, end: 1.5, value: { note: 'c#3', gain: 0 }, locations: [{ start: 10, end: 13 }] },
  ];
  const change = { kind: 'pitch', midi: 49 };
  assert.deepEqual(compareReadBack({ before, after, token, change }), { ok: true });
  // The order the notes arrive in does not matter.
  assert.deepEqual(compareReadBack({ before, after: [...after].reverse(), token, change }), { ok: true });
  // The note keeps its pitch, or gets another.
  assert.deepEqual(compareReadBack({ before, after: before, token, change }), { ok: false, why: 'edited-pitch' });
  assert.deepEqual(compareReadBack({ before, after, token, change: { kind: 'pitch', midi: 50 } }), { ok: false, why: 'edited-pitch' });
});

test('compareReadBack refuses what else changed: a count, a time, another field, another note', () => {
  const token = { start: 10, end: 12, text: 'c3' };
  const change = { kind: 'pitch', midi: 49 };
  const before = [
    { begin: 0, end: 0.5, value: { note: 'c3', gain: 0 }, locations: [{ start: 10, end: 12 }] },
    { begin: 0.5, end: 1, value: { note: 'e3', gain: 0 }, locations: [{ start: 13, end: 15 }] },
  ];
  const good = [
    { begin: 0, end: 0.5, value: { note: 'c#3', gain: 0 }, locations: [{ start: 10, end: 13 }] },
    { begin: 0.5, end: 1, value: { note: 'e3', gain: 0 }, locations: [{ start: 14, end: 16 }] },
  ];
  const result = (after) => compareReadBack({ before, after, token, change });
  assert.deepEqual(result(good), { ok: true });
  assert.deepEqual(result(good.slice(1)), { ok: false, why: 'edited-count' });
  assert.deepEqual(result([...good, good[0]]), { ok: false, why: 'edited-count' });
  assert.deepEqual(result([{ ...good[0], begin: 0.1 }, good[1]]), { ok: false, why: 'edited-differs' });
  assert.deepEqual(result([{ ...good[0], value: { note: 'c#3', gain: 0.5 } }, good[1]]), { ok: false, why: 'edited-differs' });
  assert.deepEqual(result([good[0], { ...good[1], value: { note: 'f3', gain: 0 } }]), { ok: false, why: 'others-differ' });
  assert.deepEqual(result([good[0]]), { ok: false, why: 'others-differ' });
  assert.deepEqual(result([good[0], good[1], { begin: 2, end: 3, value: { note: 'g3' }, locations: null }]), { ok: false, why: 'others-differ' });
  // A token that carries no note on the page proves nothing.
  assert.deepEqual(compareReadBack({ before: [before[1]], after: [good[1]], token, change }), { ok: false, why: 'no-edited-note' });
});

test('compareReadBack confirms a rest when exactly the notes that carried the token are gone', () => {
  const token = { start: 10, end: 12, text: 'c3' };
  const change = { kind: 'rest' };
  const before = [
    { begin: 0, end: 0.5, value: { note: 'c3', gain: 0 }, locations: [{ start: 10, end: 12 }] },
    { begin: 0.5, end: 1, value: { note: 'e3', gain: 0 }, locations: [{ start: 13, end: 15 }] },
    { begin: 1, end: 1.5, value: { note: 'c3', gain: 0 }, locations: [{ start: 10, end: 12 }] },
  ];
  // The tilde is one character: the places after it move by one, the notes do not.
  const after = [{ begin: 0.5, end: 1, value: { note: 'e3', gain: 0 }, locations: [{ start: 12, end: 14 }] }];
  const result = (events) => compareReadBack({ before, after: events, token, change });
  assert.deepEqual(result(after), { ok: true });
  assert.deepEqual(result(before), { ok: false, why: 'edited-count' }, 'a note that is still there');
  assert.deepEqual(result([...after, { begin: 1, end: 1.5, value: { note: 'c3', gain: 0 }, locations: [{ start: 10, end: 12 }] }]), { ok: false, why: 'edited-count' });
  assert.deepEqual(result([]), { ok: false, why: 'others-differ' }, 'another note lost');
  assert.deepEqual(result([{ ...after[0], begin: 0.6 }]), { ok: false, why: 'others-differ' }, 'another note moved');
  assert.deepEqual(result([...after, { begin: 2, end: 3, value: { note: 'g3' }, locations: null }]), { ok: false, why: 'others-differ' }, 'a note that was not there');
  assert.deepEqual(compareReadBack({ before: [before[1]], after, token, change }), { ok: false, why: 'no-edited-note' });
});

test('compareReadBack confirms a velocity when the notes of the number play the target and nothing else changed', () => {
  const token = { start: 20, end: 23, text: '0.5' };
  const note = (begin, name, velocity, start, extra = {}) => ({
    begin,
    end: begin + 0.5,
    value: { note: name, velocity, ...extra },
    locations: [{ start: 10, end: 12 }, { start, end: start + (start === 20 ? 3 : 1) }],
  });
  // The number 0.5 is the velocity of both c3 notes; 1 is the velocity of e3. Gain 0.8: 0.5 shows 0.40, and 0.625 shows 0.50.
  const before = [note(0, 'c3', 0.5, 20), note(0.5, 'e3', 1, 24), note(1, 'c3', 0.5, 20)];
  const change = { kind: 'velocity', target: 0.5, gain: 0.8 };
  const after = [note(0, 'c3', 0.625, 20), note(0.5, 'e3', 1, 25), note(1, 'c3', 0.625, 20)];
  assert.deepEqual(compareReadBack({ before, after, token, change }), { ok: true });
  assert.deepEqual(compareReadBack({ before, after: before, token, change }), { ok: false, why: 'edited-velocity' });
  assert.deepEqual(compareReadBack({ before, after, token, change: { ...change, target: 0.6 } }), { ok: false, why: 'edited-velocity' });
  assert.deepEqual(compareReadBack({ before, after: [after[0], after[1]], token, change }), { ok: false, why: 'edited-count' });
  // Another field of an edited note changed, or another note did.
  assert.deepEqual(compareReadBack({ before, after: [note(0, 'c3', 0.625, 20, { gain: 1 }), after[1], after[2]], token, change }), { ok: false, why: 'edited-differs' });
  assert.deepEqual(compareReadBack({ before, after: [after[0], note(0.5, 'f3', 1, 25), after[2]], token, change }), { ok: false, why: 'others-differ' });
  assert.deepEqual(compareReadBack({ before, after: [after[0], after[1], note(1.2, 'c3', 0.625, 20)], token, change }), { ok: false, why: 'edited-differs' });
  assert.throws(() => compareReadBack({ before, after, token, change: { kind: 'velocity', target: 0.5 } }), /does not know the change/);
});

test('compareReadBack does not know a change other than a pitch, a rest or a velocity, and says so loudly', () => {
  assert.throws(() => compareReadBack({ before: [], after: [], token: { start: 0, end: 1, text: 'c' }, change: { kind: 'octave' } }), /does not know the change/);
  assert.throws(() => compareReadBack({ before: [], after: [], token: { start: 0, end: 1, text: 'c' }, change: null }), /does not know the change/);
  assert.throws(() => compareReadBack({ before: [], after: [], token: { start: 0, end: 1, text: 'c' }, change: { kind: 'pitch', midi: NaN } }), /does not know the change/);
});

// --- where a token plays ---

/** A read song with the given sections (name and length), as far as the Song grid's section rule looks at it. */
const song = (sections, shift = 0) => ({ shift, total: sections.reduce((sum, [, length]) => sum + length, 0), sections: sections.map(([name, length]) => ({ name, length })) });
const TOKEN = { start: 10, end: 12 };
const note = (begin, start = 10) => ({ begin, end: begin + 0.25, value: { note: 'c3' }, locations: [{ start, end: start + 2 }] });

test('the places of a token are the section entries that hold a note of it, named once each in the order of the entries', () => {
  const reading = song([['x', 3], ['y', 5], ['z', 7]]);
  // Notes in x (cycles 0 to 3) and several in z (cycles 8 to 15); another token in y.
  const haps = [note(0), note(1.5), note(8), note(9), note(14.75), note(4, 20)];
  assert.deepEqual(placesOf({ haps, token: TOKEN, reading }), { count: 2, sections: ['x', 'z'] });
  // A second use of a section is a place of its own, and the section is named once.
  const twice = song([['x', 3], ['y', 5], ['x', 3], ['z', 7]]);
  assert.deepEqual(placesOf({ haps: [note(0), note(9), note(12)], token: TOKEN, reading: twice }), { count: 3, sections: ['x', 'z'] });
  // Repeats inside one entry are not places.
  assert.deepEqual(placesOf({ haps: [note(0), note(0.5), note(1), note(2)], token: TOKEN, reading }), { count: 1, sections: ['x'] });
  // A token that plays nowhere in the stretch.
  assert.deepEqual(placesOf({ haps: [note(4, 20)], token: TOKEN, reading }), { count: 0, sections: [] });
  assert.deepEqual(placesOf({ haps: [{ begin: 0, locations: null }], token: TOKEN, reading }), { count: 0, sections: [] });
});

test('the entries follow the shift of the song, as the Song grid does', () => {
  const reading = song([['x', 3], ['y', 5]], 4);
  // With a shift of 4 the section x covers cycles 4 to 7 and y cycles 7 to 12 (a pass of 8 cycles from cycle 4).
  assert.deepEqual(placesOf({ haps: [note(4), note(8)], token: TOKEN, reading }), { count: 2, sections: ['x', 'y'] });
  assert.deepEqual(placesOf({ haps: [note(5), note(6)], token: TOKEN, reading }), { count: 1, sections: ['x'] });
});

test('a note counts as carrying the token when one of its places starts where the token starts', () => {
  const reading = song([['x', 3]]);
  const several = { begin: 1, locations: [{ start: 40, end: 42 }, { start: 10, end: 12 }] };
  assert.equal(placesOf({ haps: [several], token: TOKEN, reading }).count, 1);
});

test('the count limit of one pass is 1024 cycles', () => {
  assert.equal(PLACES_MAX_CYCLES, 1024);
});

test('a token that draws several notes in one cycle is counted in that cycle only', () => {
  const events = [note(0), note(0.25, 20), note(0.5), note(1), note(1.5, 20), note(2.1)];
  assert.equal(perCycleCount({ events, token: TOKEN, cycle: 0 }), 2);
  assert.equal(perCycleCount({ events, token: { start: 20, end: 22 }, cycle: 0 }), 1);
  assert.equal(perCycleCount({ events, token: TOKEN, cycle: 1 }), 1);
  assert.equal(perCycleCount({ events, token: TOKEN, cycle: 2 }), 1);
  assert.equal(perCycleCount({ events, token: TOKEN, cycle: 7 }), 0);
  assert.equal(perCycleCount({ events: [{ begin: 0 }], token: TOKEN, cycle: 0 }), 0, 'a note with no places carries nothing');
});

test('the notes of the drawn lane that carry the token are found by index, the selected one among them', () => {
  const events = [note(0), note(1, 20), note(2), { begin: 3, locations: null }, note(4)];
  assert.deepEqual(sameTokenEvents({ events, token: TOKEN }), [0, 2, 4]);
  assert.deepEqual(sameTokenEvents({ events, token: { start: 99, end: 100 } }), []);
});
