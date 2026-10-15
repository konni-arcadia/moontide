import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { differsLine, readStructure } from '../page/structure.js';
import { checkSections, evaluateDeclared, expectedPairs, expectedSource, sectionStarts } from '../page/structure-check.js';

const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

/** A piece of pattern placeholders: sections a (1 cycle), b (3), a again (2); u plays in all three, v only in b. */
function pieceCode({ shift = 0, tracks = "const u = { p: 1 };\nconst v = { p: 1 };", statements = "u: play('u', u)\nv: play('v', v)" } = {}) {
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: ${shift}, sections: [['a', 1], ['b', 3], ['a', 2]], plan: { a: { u: 'p', v: '-' }, b: { u: 'p', v: 'p' } } };`,
    tracks,
    statements,
  ].join('\n');
}

const num = (x) => ({ valueOf: () => x });

/** A fake pattern that only answers queryArc: the events starting in the range have their onset, those running into it do not. */
function pat(events) {
  return {
    queryArc(from, to) {
      return events
        .filter((event) => event.begin < to && event.end > from)
        .map((event) => ({
          whole: { begin: num(event.begin), end: num(event.end) },
          value: event.value,
          hasOnset: () => event.begin >= from,
        }));
    },
  };
}

const note = (begin, end, value = { note: 'c3' }) => ({ begin, end, value });

/** The checkSections arguments for the default piece, played patterns by track name and declared patterns in pair order. */
function run(code, { played, declared, budgetMs = 2000, clock = () => 0, yieldToPage = async () => {}, isCancelled = () => false, onPlayed } = {}) {
  const reading = read(code);
  assert.equal(reading.state, 'read');
  return checkSections({
    reading,
    starts: sectionStarts(reading),
    playedPattern: async (track) => {
      if (onPlayed) onPlayed(track);
      const made = played[track.name];
      if (made instanceof Error) throw made;
      return made;
    },
    declared: async () => {
      if (declared instanceof Error) throw declared;
      return declared;
    },
    budgetMs,
    clock,
    yieldToPage,
    isCancelled,
  });
}

/** What the default piece declares: u a note in the first cycle of each of its three entries, v one in section b. */
const everyDeclared = () => [pat([note(0, 1)]), pat([note(0, 1)]), pat([note(0, 1)]), pat([note(0, 1)])];
/** What the default piece plays when it agrees: u at 0, 1 and 4, v at 1. */
const everyPlayed = () => ({ u: pat([note(0, 1), note(1, 2), note(4, 5)]), v: pat([note(1, 2)]) });

test('sectionStarts: the starts are the shift plus the lengths before the entry, taken modulo the total', () => {
  const starts = (shift) => sectionStarts(read(pieceCode({ shift }))).map(({ name, start, end }) => [name, start, end]);
  assert.deepEqual(starts(0), [['a', 0, 1], ['b', 1, 4], ['a', 4, 6]]);
  assert.deepEqual(starts(4), [['a', 4, 5], ['b', 5, 8], ['a', 2, 4]]);
  assert.deepEqual(starts(-3), [['a', 3, 4], ['b', 4, 7], ['a', 1, 3]]);
  assert.deepEqual(starts(2.5), [['a', 2.5, 3.5], ['b', 3.5, 6.5], ['a', 0.5, 2.5]]);
  assert.deepEqual(sectionStarts(read(pieceCode({ shift: -3 }))).map(({ index }) => index), [0, 1, 2]);
});

test('expectedSource names every pair that is not a rest once, in the order of expectedPairs', () => {
  const code = pieceCode();
  const reading = read(code);
  assert.deepEqual(expectedPairs(reading), [{ track: 0, section: 0 }, { track: 0, section: 1 }, { track: 0, section: 2 }, { track: 1, section: 1 }]);
  const body = expectedSource(code, reading, { parse });
  assert.ok(body.startsWith('"use strict";\n'));
  assert.equal(body.split('this.cell(').length - 1, 4);
  assert.equal(body.split('this.cell(u["p"]').length - 1, 3);
  assert.equal(body.split('this.cell(v["p"]').length - 1, 1);
  assert.ok(!body.includes('play('), 'the declared side never goes through the helper');
});

test('expectedSource skips the muted tracks', () => {
  const code = pieceCode({ statements: "u: play('u', u)\n_v: play('v', v)" });
  const reading = read(code);
  assert.equal(reading.tracks[1].muted, true);
  assert.deepEqual(expectedPairs(reading).map((pair) => pair.track), [0, 0, 0]);
  assert.equal(expectedSource(code, reading, { parse }).includes('v["p"]'), false);
});

test('expectedSource evaluates to the declared cell of each pair: a pattern, the second element of a fixed pair, a function of the section harmony', () => {
  const code = [
    "const harmony = 'C3:major';",
    "const song = { shift: 0, sections: [['a', 1, 'E3:minor'], ['b', 1]], plan: { a: { u: 'f', v: 'g' }, b: { u: 'f', v: 'h' } } };",
    "const u = { f: (h) => ({ queryArc: () => [], harmonyWas: h }) };",
    "const v = { g: ['D3:dorian', { queryArc: () => [], fixed: true }], h: { queryArc: () => [], plain: true } };",
    "u: play('u', u)",
    "v: play('v', v)",
  ].join('\n');
  const reading = read(code);
  assert.equal(reading.state, 'read');
  return evaluateDeclared(expectedSource(code, reading, { parse })).then((declared) => {
    assert.equal(declared.length, 4);
    assert.equal(declared[0].harmonyWas, 'E3:minor', 'the harmony of the section when it has one');
    assert.equal(declared[1].harmonyWas, 'C3:major', 'else the harmony constant of the piece');
    assert.equal(declared[2].fixed, true);
    assert.equal(declared[3].plain, true);
  });
});

test('expectedSource embeds a variation name holding quotes and a backslash only as text', () => {
  const code = [
    "const song = { shift: 0, sections: [['a', 1]], plan: { a: { u: 'it\\'s \"x\" \\\\ ]; throw 1; [' } } };",
    "const u = { 'it\\'s \"x\" \\\\ ]; throw 1; [': { queryArc: () => [], hit: true } };",
    "u: play('u', u)",
  ].join('\n');
  const reading = read(code);
  assert.equal(reading.state, 'read');
  assert.equal(reading.tracks[0].cells[0].key, 'it\'s "x" \\ ]; throw 1; [');
  return evaluateDeclared(expectedSource(code, reading, { parse })).then((declared) => {
    assert.equal(declared.length, 1);
    assert.equal(declared[0].hit, true);
  });
});

test('evaluateDeclared refuses a result that is not a list of patterns with queryArc', async () => {
  await assert.rejects(evaluateDeclared('return 3;'), /Moontide: the declared cells did not come out/);
  await assert.rejects(evaluateDeclared('return [{ queryArc: () => [] }, 5];'), /Moontide: the declared cells did not come out/);
  assert.equal((await evaluateDeclared('return [{ queryArc: () => [] }];')).length, 1);
});

test('checkSections agrees when what plays is what is declared, and reports the time', async () => {
  const answer = await run(pieceCode(), { played: everyPlayed(), declared: everyDeclared(), clock: (() => { let t = 0; return () => (t += 5); })() });
  assert.equal(answer.state, 'agrees');
  assert.equal(typeof answer.ms, 'number');
  assert.ok(answer.ms > 0);
});

test('checkSections names the first place in section order and then track order, and counts the others', async () => {
  const played = { u: pat([note(0, 1), note(1.5, 2.5), note(4, 5)]), v: pat([note(1.5, 2.5)]) };
  const answer = await run(pieceCode(), { played, declared: everyDeclared() });
  assert.equal(answer.state, 'differs');
  assert.deepEqual(answer.first, { section: 'b', track: 'u' });
  assert.equal(answer.more, 1);
  assert.equal(differsLine({ ...answer.first, more: answer.more }), "What plays differs from the declaration at the start of section 'b', track 'u' (and 1 more place).");
});

test('checkSections puts an earlier section before an earlier track', async () => {
  // v declares a rest in the first section but plays a note there; u differs in section b.
  const played = { u: pat([note(0, 1), note(1.5, 2.5), note(4, 5)]), v: pat([note(0, 1), note(1, 2)]) };
  const answer = await run(pieceCode(), { played, declared: everyDeclared() });
  assert.deepEqual(answer.first, { section: 'a', track: 'v' });
  assert.equal(answer.more, 1);
});

test('checkSections is not fooled by extra keys on the played side, and a declared key with another value is a difference', async () => {
  const extra = { note: 'c3', postgain: 0.5, midichan: 2 };
  const agree = await run(pieceCode(), {
    played: { u: pat([note(0, 1, extra), note(1, 2, extra), note(4, 5, extra)]), v: pat([note(1, 2, extra)]) },
    declared: everyDeclared(),
  });
  assert.equal(agree.state, 'agrees');
  const other = await run(pieceCode(), {
    played: { u: pat([note(0, 1), note(1, 2), note(4, 5, { note: 'd3' })]), v: pat([note(1, 2)]) },
    declared: everyDeclared(),
  });
  assert.equal(other.state, 'differs');
  assert.deepEqual(other.first, { section: 'a', track: 'u' });
  assert.equal(other.more, 0);
  const missing = await run(pieceCode(), {
    played: { u: pat([note(0, 1), note(1, 2, { s: 'sine' }), note(4, 5)]), v: pat([note(1, 2)]) },
    declared: everyDeclared(),
  });
  assert.equal(missing.state, 'differs', 'a played value without the declared key differs');
});

test('checkSections counts function values as equal', async () => {
  const declared = everyDeclared();
  declared[0] = pat([note(0, 1, { note: 'c3', onTrigger: () => 1 })]);
  const answer = await run(pieceCode(), {
    played: { u: pat([note(0, 1, { note: 'c3', onTrigger: () => 2 }), note(1, 2), note(4, 5)]), v: pat([note(1, 2)]) },
    declared,
  });
  assert.equal(answer.state, 'agrees');
});

test('checkSections cuts a declared whole at the end of its section', async () => {
  // Section a is one cycle: a declared whole of [0, 2] is cut to [0, 1] where the clock cuts a held note.
  const declared = everyDeclared();
  declared[0] = pat([note(0, 2)]);
  const cut = await run(pieceCode(), { played: everyPlayed(), declared });
  assert.equal(cut.state, 'agrees');
  // Section b is three cycles: a declared whole of [0, 2] must be matched as it is.
  const longer = everyDeclared();
  longer[1] = pat([note(0, 2)]);
  const uncut = await run(pieceCode(), { played: { u: pat([note(0, 1), note(1, 4), note(4, 5)]), v: pat([note(1, 2)]) }, declared: longer });
  assert.equal(uncut.state, 'differs');
  assert.deepEqual(uncut.first, { section: 'b', track: 'u' });
  const exact = await run(pieceCode(), { played: { u: pat([note(0, 1), note(1, 3), note(4, 5)]), v: pat([note(1, 2)]) }, declared: longer });
  assert.equal(exact.state, 'agrees');
});

test('checkSections: a rest agrees with no onset and differs with one', async () => {
  const none = await run(pieceCode(), { played: everyPlayed(), declared: everyDeclared() });
  assert.equal(none.state, 'agrees');
  const one = await run(pieceCode(), {
    played: { u: pat([note(0, 1), note(1, 2), note(4, 5)]), v: pat([note(1, 2), note(4, 5)]) },
    declared: everyDeclared(),
  });
  assert.equal(one.state, 'differs');
  assert.deepEqual(one.first, { section: 'a', track: 'v' });
});

test('checkSections checks a repeated section name at each of its entries', async () => {
  // Only the second entry of a differs: u plays its note half a cycle late there.
  const played = { u: pat([note(0, 1), note(1, 2), note(4.5, 5.5)]), v: pat([note(1, 2)]) };
  const answer = await run(pieceCode(), { played, declared: everyDeclared() });
  assert.equal(answer.state, 'differs');
  assert.deepEqual(answer.first, { section: 'a', track: 'u' });
  assert.equal(answer.more, 0);
});

test('checkSections: two played onsets for one declared onset is a difference, and so is a missing one', async () => {
  const doubled = await run(pieceCode(), {
    played: { u: pat([note(0, 1), note(0, 1), note(1, 2), note(4, 5)]), v: pat([note(1, 2)]) },
    declared: everyDeclared(),
  });
  assert.equal(doubled.state, 'differs');
  const absent = await run(pieceCode(), { played: { u: pat([note(1, 2), note(4, 5)]), v: pat([note(1, 2)]) }, declared: everyDeclared() });
  assert.equal(absent.state, 'differs');
  assert.deepEqual(absent.first, { section: 'a', track: 'u' });
});

test('checkSections pairs two declared onsets of one moment with two played ones, whatever their order', async () => {
  const declared = everyDeclared();
  declared[1] = pat([note(0, 1, { note: 'c3' }), note(0, 1, { note: 'c3', s: 'sine' })]);
  const answer = await run(pieceCode(), {
    played: {
      u: pat([note(0, 1), note(1, 2, { note: 'c3', s: 'sine' }), note(1, 2, { note: 'c3' }), note(4, 5)]),
      v: pat([note(1, 2)]),
    },
    declared,
  });
  assert.equal(answer.state, 'agrees');
});

test('checkSections checks the places the clock plays when the shift is negative or fractional', async () => {
  // With a shift of 2.5 the entries start at 2.5, 3.5 and 0.5 on the repeating clock.
  const code = pieceCode({ shift: 2.5 });
  const played = { u: pat([note(2.5, 3.5), note(3.5, 4.5), note(0.5, 1.5)]), v: pat([note(3.5, 4.5)]) };
  assert.equal((await run(code, { played, declared: everyDeclared() })).state, 'agrees');
  const wrong = { u: pat([note(2.5, 3.5), note(3.5, 4.5), note(0, 1)]), v: pat([note(3.5, 4.5)]) };
  const answer = await run(code, { played: wrong, declared: everyDeclared() });
  assert.equal(answer.state, 'differs');
  assert.deepEqual(answer.first, { section: 'a', track: 'u' });
});

test('checkSections asks only the unmuted tracks for their pattern, and checks only them', async () => {
  const code = pieceCode({ statements: "u: play('u', u)\n_v: play('v', v)" });
  const asked = [];
  const answer = await run(code, {
    played: { u: pat([note(0, 1), note(1, 2), note(4, 5)]), v: new Error('a muted track is never asked') },
    declared: [pat([note(0, 1)]), pat([note(0, 1)]), pat([note(0, 1)])],
    onPlayed: (track) => asked.push(track.name),
  });
  assert.equal(answer.state, 'agrees');
  assert.deepEqual(asked, ['u']);
});

test('checkSections gives too-slow with the time when the budget passes, after the patterns or during the tracks', async () => {
  let now = 0;
  const afterPatterns = await run(pieceCode(), {
    played: everyPlayed(),
    declared: everyDeclared(),
    budgetMs: 2000,
    clock: () => now,
    onPlayed: () => {
      now += 3000;
    },
  });
  assert.equal(afterPatterns.state, 'too-slow');
  assert.ok(afterPatterns.ms > 2000);

  now = 0;
  let yields = 0;
  const duringTracks = await run(pieceCode(), {
    played: everyPlayed(),
    declared: everyDeclared(),
    budgetMs: 2000,
    clock: () => now,
    yieldToPage: async () => {
      yields += 1;
      now += 2500;
    },
  });
  assert.equal(duringTracks.state, 'too-slow');
  assert.equal(yields, 1, 'it stops at the first track that passes the budget');
  assert.ok(duringTracks.ms > 2000);
});

test('checkSections gives failed with the message when a pattern throws, and never throws itself', async () => {
  const played = await run(pieceCode(), { played: { u: new Error('a track broke'), v: pat([]) }, declared: everyDeclared() });
  assert.equal(played.state, 'failed');
  assert.equal(played.message, 'a track broke');
  const declared = await run(pieceCode(), { played: everyPlayed(), declared: new Error('the declared side broke') });
  assert.equal(declared.state, 'failed');
  assert.equal(declared.message, 'the declared side broke');
  const short = await run(pieceCode(), { played: everyPlayed(), declared: [pat([])] });
  assert.equal(short.state, 'failed');
  assert.match(short.message, /do not match the cells of the reading/);
});

test('checkSections gives cancelled and nothing else when the version is overtaken', async () => {
  let yields = 0;
  const midRun = await run(pieceCode(), {
    played: everyPlayed(),
    declared: everyDeclared(),
    yieldToPage: async () => {
      yields += 1;
    },
    isCancelled: () => yields >= 1,
  });
  assert.deepEqual(midRun, { state: 'cancelled' });

  let asked = 0;
  const early = await run(pieceCode(), {
    played: everyPlayed(),
    declared: everyDeclared(),
    onPlayed: () => {
      asked += 1;
    },
    isCancelled: () => true,
  });
  assert.deepEqual(early, { state: 'cancelled' });
  assert.equal(asked, 0, 'a version overtaken before its patterns exist asks for none');
});

test('checkSections reports ms for every answer but a cancelled one', async () => {
  const clock = (() => {
    let t = 0;
    return () => (t += 7);
  })();
  const answers = [
    await run(pieceCode(), { played: everyPlayed(), declared: everyDeclared(), clock }),
    await run(pieceCode(), { played: { u: pat([]), v: pat([]) }, declared: everyDeclared(), clock }),
    await run(pieceCode(), { played: everyPlayed(), declared: new Error('x'), clock }),
    await run(pieceCode(), { played: everyPlayed(), declared: everyDeclared(), clock, budgetMs: 1 }),
  ];
  assert.deepEqual(answers.map((answer) => answer.state), ['agrees', 'differs', 'failed', 'too-slow']);
  for (const answer of answers) assert.equal(typeof answer.ms, 'number');
  assert.equal('ms' in (await run(pieceCode(), { played: everyPlayed(), declared: everyDeclared(), isCancelled: () => true })), false);
});
