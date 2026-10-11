import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { SOLO_MARKER, extractTracks, parseLabel, soloSource, trackRange } from '../page/tracks.js';

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const HTML_PATH = fileURLToPath(new URL('../page/index.html', import.meta.url));
const ACORN_SRI = 'sha384-WgWa7IMzbWqfzzErkcVQfJDMGL8BWPguzfJMENCZenrpvc27isEGxLTnZb3cbz35';

test('package.json and page/index.html pin the same exact acorn version', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const html = readFileSync(HTML_PATH, 'utf8');
  const pkgVersion = pkg.devDependencies && pkg.devDependencies.acorn;
  assert.equal(pkgVersion, '8.18.0', 'package.json devDependencies.acorn must pin 8.18.0');
  assert.ok(html.includes('https://unpkg.com/acorn@8.18.0/dist/acorn.js'), 'page/index.html must load acorn@8.18.0');
  assert.ok(html.includes(ACORN_SRI), 'page/index.html must pin the verified acorn SRI hash');
});

const FOUR_TRACK_PROGRAM = [
  'setcpm(30)',
  'const low = "<c2 g2>"',
  'one: note("c4 e4 g4 b4").s("triangle").gain(0)',
  'two: note(low).s("sawtooth").gain(0)',
  'three: s("square*8").degradeBy(0.3).gain(0)',
  'four: note("<[c3,e3,g3] [a2,c3,e3]>").s("sine").gain(0)',
].join('\n');

test('four labeled statements plus a const and a setcpm line give four tracks named verbatim, in source order', () => {
  const tracks = extractTracks(FOUR_TRACK_PROGRAM, { parse });
  assert.equal(tracks.length, 4);
  assert.deepEqual(
    tracks.map((t) => t.name),
    ['one', 'two', 'three', 'four'],
  );
  assert.deepEqual(
    tracks.map((t) => t.label),
    ['one', 'two', 'three', 'four'],
  );
  assert.deepEqual(
    tracks.map((t) => t.identity),
    ['label:one', 'label:two', 'label:three', 'label:four'],
  );
  assert.ok(tracks.every((t) => t.muted === false));
  assert.ok(tracks.every((t) => t.kind === 'label'));
});

// The harmony declaration is a top-level const, so the splitter never sees it as a track. The
// real page proves the same in probe:page (`--only harmony`); these cases pin it without a browser.
const HARMONY_INITIALIZERS = [
  ['a single-quoted scale string', "'D4:dorian'"],
  ['a double-quoted chord pattern', '"<Dm7 G7 C^7>"'],
  ['a chord call with one string', 'chord("<Dm7 G7>")'],
  ['a number', '7'],
  ['a backtick template without placeholders', '`C:minor:pentatonic`'],
];

const trackFacts = (tracks) => tracks.map((t) => ({ identity: t.identity, label: t.label, name: t.name, kind: t.kind, muted: t.muted }));

for (const [what, initializer] of HARMONY_INITIALIZERS) {
  test(`a const harmony line holding ${what} adds no track to a labeled program`, () => {
    const withLine = extractTracks(`const harmony = ${initializer}\n${FOUR_TRACK_PROGRAM}`, { parse });
    assert.deepEqual(trackFacts(withLine), trackFacts(extractTracks(FOUR_TRACK_PROGRAM, { parse })));
  });

  test(`a const harmony line holding ${what} adds no branch to an unlabeled stack`, () => {
    const stack = 'stack(note("c3 e3").gain(0), s("hh*4").gain(0))';
    const plain = extractTracks(stack, { parse });
    const withLine = extractTracks(`const harmony = ${initializer}\n${stack}`, { parse });
    assert.equal(plain.length, 2);
    assert.deepEqual(
      withLine.map((t) => [t.identity, t.name]),
      plain.map((t) => [t.identity, t.name]),
    );
  });
}

test('the rejected labeled form harmony: is a track next to the lead track', () => {
  const tracks = extractTracks('harmony: note("c3 e3").gain(0)\nlead: note("d3 f3 a3").gain(0)', { parse });
  assert.deepEqual(
    tracks.map((t) => t.identity),
    ['label:harmony', 'label:lead'],
  );
});

test('a program whose last statement is the harmony const still gives its labeled track (the engine refuses it, not the page)', () => {
  const tracks = extractTracks("lead: note(\"d3 f3 a3\").gain(0)\nconst harmony = 'D4:dorian'", { parse });
  assert.deepEqual(
    tracks.map((t) => t.identity),
    ['label:lead'],
  );
});

test('soloSource for the second track wraps its shared const string, drops setcpm, and returns the wrapped track expression', () => {
  const source = soloSource(FOUR_TRACK_PROGRAM, 1, { parse });
  assert.ok(source.startsWith('"use strict";'));
  assert.ok(!source.includes('setcpm'), 'setcpm must never appear in a solo program');
  assert.match(source, /const low = m\("<c2 g2>", \d+\)/);
  assert.match(source, /return \(note\(low\)\.s\(m\("sawtooth", \d+\)\)\.gain\(0\)\);$/);
});

test('a single-quoted string stays unwrapped', () => {
  const code = "one: note('c4').s('triangle').gain(0)";
  const source = soloSource(code, 0, { parse });
  assert.ok(source.includes("note('c4').s('triangle')"), 'single-quoted strings must not be wrapped in m(...)');
  assert.ok(!source.includes("m('c4'"), 'a single-quoted literal must never become m(...)');
});

test('a label with a non-ASCII name keeps its exact value', () => {
  const code = 'mélodie: note("c4").s("triangle").gain(0)';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].label, 'mélodie');
  assert.equal(tracks[0].name, 'mélodie');
  assert.equal(tracks[0].identity, 'label:mélodie');
});

test('"$: note(\\"c4\\").s(\\"triangle\\")" twice gives two tracks named by their sound, never "$"', () => {
  const code = '$: note("c4").s("triangle")\n$: note("g3").s("triangle")';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].label, '$');
  assert.equal(tracks[1].label, '$');
  assert.equal(tracks[0].name, 'triangle');
  assert.equal(tracks[1].name, 'triangle 2');
});

test('between two tracks with the same display name, the plain name goes to the one whose identity sorts first — reorder-stable', () => {
  const code = '$: note("c4").s("triangle")\n$: note("g3").s("triangle")';
  const reordered = '$: note("g3").s("triangle")\n$: note("c4").s("triangle")';
  const tracks = extractTracks(code, { parse });
  const reorderedTracks = extractTracks(reordered, { parse });
  const nameFor = (list, note) => list.find((t) => t.identity.includes(`note:${note}`)).name;
  assert.equal(nameFor(tracks, 'c4'), nameFor(reorderedTracks, 'c4'));
  assert.equal(nameFor(tracks, 'g3'), nameFor(reorderedTracks, 'g3'));
});

test('a label starting or ending with "_" gives a track with muted true, named verbatim', () => {
  const code = '_hidden: s("square*2")\ntrailing_: s("square*2")';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks[0].muted, true);
  assert.equal(tracks[0].name, '_hidden');
  assert.equal(tracks[1].muted, true);
  assert.equal(tracks[1].name, 'trailing_');
});

test('when any label longer than one character starts with a capital S, every other label is muted and the S labels are not', () => {
  const code = 'Solo: s("bd")\nother: s("sn")\nS: s("hh")';
  const tracks = extractTracks(code, { parse });
  const byLabel = Object.fromEntries(tracks.map((t) => [t.label, t]));
  assert.equal(byLabel.Solo.muted, false);
  assert.equal(byLabel.other.muted, true);
  // 'S' alone is length 1, so it does not itself trigger or participate as a "solo" label —
  // but with the solo rule active (Solo triggered it), every OTHER label is muted, and 'S' is
  // "every other label" here since it is not itself longer-than-one-character-starting-with-S.
  assert.equal(byLabel.S.muted, true);
});

test('the same label written twice gives one track, from the last statement', () => {
  const code = 'foo: s("bd")\nfoo: s("sn")';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].label, 'foo');
  const source = soloSource(code, 0, { parse });
  assert.match(source, /sn/);
  assert.ok(!source.includes('bd'));
});

test('structural identity: every string literal in source order as call:value, numbers excluded; gain and .room(0.2) keep it; a duplicate gets a #2 suffix', () => {
  const code = '$: note("c4").s("triangle").gain(0.5)\n$: note("c4").s("triangle").room(0.2)';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks[0].identity, 'note:c4|s:triangle');
  assert.equal(tracks[1].identity, 'note:c4|s:triangle #2');
});

test('structural identity falls back to root:<name> when there is no string', () => {
  const code = '$: sine.range(0, 1)';
  const tracks = extractTracks(code, { parse });
  assert.match(tracks[0].identity, /^root:/);
});

test('display name from the sound: s()/sound() first, else bank(), else the root call\'s own string, else the root identifier', () => {
  const parseOne = (code) => extractTracks(code, { parse })[0].name;
  assert.equal(parseOne('$: note("c4").s("triangle")'), 'triangle');
  assert.equal(parseOne('$: sound("gm_harp").gain(0)'), 'gm_harp');
  assert.equal(parseOne('$: bank("RolandTR808").s("bd")'.replace('.s("bd")', '')), 'RolandTR808');
  assert.equal(parseOne('$: note("c4 e4")'), 'c4 e4');
});

test('a top-level all(fn) and each(fn) are applied in soloSource, each in the order Strudel applies them', () => {
  const code = ['all(x => x.gain(0))', '$: note("c4").s("triangle")', 'each(x => x.room(0.1))'].join('\n');
  const source = soloSource(code, 0, { parse });
  assert.match(source, /return \(\(x => x\.gain\(0\)\)\(\(x => x\.room\(0\.1\)\)\(note\(m\("c4", \d+\)\)\.s\(m\("triangle", \d+\)\)\)\)\);$/);
});

test('code that is empty or only comments, or a labeled statement whose body is not an expression, give zero tracks', () => {
  assert.equal(extractTracks('', { parse }).length, 0);
  assert.equal(extractTracks('// only a comment\n', { parse }).length, 0);
  assert.equal(extractTracks('foo: { const x = 1; }', { parse }).length, 0);
});

// --- Code without labels — stack() branches, single-pattern programs ---

const NO_LABEL_BRANCHES_PROGRAM =
  'stack(note("c4 e4").s("triangle"), s("square*4"), note("<g3 b3>").s("sawtooth")).gain(0)';

test('stack() branches without labels give tracks named by their sound, in source order', () => {
  const tracks = extractTracks(NO_LABEL_BRANCHES_PROGRAM, { parse });
  assert.equal(tracks.length, 3);
  assert.deepEqual(
    tracks.map((t) => t.kind),
    ['branch', 'branch', 'branch'],
  );
  assert.deepEqual(
    tracks.map((t) => t.name),
    ['triangle', 'square*4', 'sawtooth'],
  );
});

test('soloSource of a stack() branch silences every other branch, keeps the outer chain, and wraps only its own strings', () => {
  const source = soloSource(NO_LABEL_BRANCHES_PROGRAM, 1, { parse });
  assert.equal((source.match(/silence/g) || []).length, 2);
  assert.ok(source.includes('.gain(0)'), 'the outer .gain(0) chain must reach the solo program');
  assert.match(source, /s\(m\("square\*4", \d+\)\)/);
  assert.ok(!source.includes('triangle'), 'a silenced branch must not leak its own string into the solo program');
  assert.ok(!source.includes('sawtooth'), 'a silenced branch must not leak its own string into the solo program');
});

test('a program with no stack() gives one track of kind "program"', () => {
  const tracks = extractTracks('note("c4").s("sine")', { parse });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].kind, 'program');
  assert.equal(tracks[0].name, 'sine');
});

test('a program whose last statement is a silently-returning call gives zero tracks', () => {
  assert.equal(extractTracks('setcpm(30)', { parse }).length, 0);
  assert.equal(extractTracks('s("bd")\nhush()', { parse }).length, 0);
});

test('a label program still gives one track per label even when a stack() sits inside one', () => {
  const code = 'one: stack(s("bd"), s("hh")).gain(0)\ntwo: s("sn")';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks.length, 2);
  assert.deepEqual(
    tracks.map((t) => t.kind),
    ['label', 'label'],
  );
  assert.deepEqual(
    tracks.map((t) => t.label),
    ['one', 'two'],
  );
});

// --- Nested stacks, conditional branches, stability ---

test('a branch whose own root is a stack() call opens into its arguments, recursively', () => {
  const code = 'stack(note("c4").s("sine"), stack(note("e4").s("sawtooth"), note("g4").s("triangle")).fast(2)).gain(0)';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks.length, 3);
  assert.deepEqual(
    tracks.map((t) => t.name),
    ['sine', 'sawtooth', 'triangle'],
  );
  assert.deepEqual(
    tracks.map((t) => t.kind),
    ['branch', 'branch', 'branch'],
  );
});

test('the nested stack() itself never becomes a track, and its own .fast(2) reaches every inner branch\'s solo program', () => {
  const code = 'stack(note("c4").s("sine"), stack(note("e4").s("sawtooth"), note("g4").s("triangle")).fast(2)).gain(0)';
  const source = soloSource(code, 1, { parse });
  assert.match(source, /\.fast\(2\)/, 'the nested stack()\'s own chain must stay in an inner branch\'s solo program');
  assert.match(source, /s\(m\("sawtooth", \d+\)\)/);
  assert.ok(!source.includes('triangle'), 'the sibling inner branch must be silenced');
  assert.ok(!source.includes('"sine"'), 'the outer sibling branch must be silenced');
});

test('a branch chosen by a runtime condition is "Unnamed N", numbered among unnamed branches only, never a fake name', () => {
  const code = 'stack(cond ? s("bd") : s("hh"), note("c4").s("sine"), other ? s("cp") : s("rim"))';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks[0].name, 'Unnamed 1');
  assert.equal(tracks[0].unnamed, true);
  assert.equal(tracks[0].identity, 'unnamed:1');
  assert.equal(tracks[1].name, 'sine');
  assert.equal(tracks[1].unnamed, false);
  assert.equal(tracks[2].name, 'Unnamed 2');
  assert.equal(tracks[2].unnamed, true);
  assert.equal(tracks[2].identity, 'unnamed:2');
});

test('a whole program built by a runtime condition is one track named "Unnamed 1"', () => {
  const tracks = extractTracks('cond ? s("bd") : s("hh")', { parse });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].kind, 'program');
  assert.equal(tracks[0].name, 'Unnamed 1');
  assert.equal(tracks[0].unnamed, true);
  assert.equal(tracks[0].identity, 'unnamed:1');
});

const STABILITY_BASE = [
  'stack(',
  '  note("c4 e4").s("sine").gain(0.6),',
  '  n("0 2 4").scale("D:minor").s("triangle").gain(0.6),',
  '  s("bd*4").gain(0.6),',
  '  s("hh*8").degradeBy(0.3).gain(0.6)',
  ').lpf(sine.range(400, 2000))',
].join('\n');

function identityMap(code) {
  const tracks = extractTracks(code, { parse });
  const map = new Map();
  for (const track of tracks) map.set(track.identity, track.name);
  return map;
}

test('identity and name survive a gain edit', () => {
  const base = identityMap(STABILITY_BASE);
  const gainEdited = STABILITY_BASE.replace(/gain\(0\.6\)/g, 'gain(0.3)');
  assert.deepEqual(identityMap(gainEdited), base);
});

test('identity and name survive an added .room(0.2) effect', () => {
  const base = identityMap(STABILITY_BASE);
  const withRoom = STABILITY_BASE.replace('s("bd*4").gain(0.6)', 's("bd*4").gain(0.6).room(0.2)');
  assert.deepEqual(identityMap(withRoom), base);
});

test('identity and name survive a branch reorder', () => {
  const base = identityMap(STABILITY_BASE);
  const reordered = [
    'stack(',
    '  s("bd*4").gain(0.6),',
    '  note("c4 e4").s("sine").gain(0.6),',
    '  n("0 2 4").scale("D:minor").s("triangle").gain(0.6),',
    '  s("hh*8").degradeBy(0.3).gain(0.6)',
    ').lpf(sine.range(400, 2000))',
  ].join('\n');
  assert.deepEqual(identityMap(reordered), base);
});

test('two branches with the same sound: identity order decides the plain name, unchanged after swapping them', () => {
  const code = 'stack(note("c4").s("sine"), note("g4").s("sine"))';
  const swapped = 'stack(note("g4").s("sine"), note("c4").s("sine"))';
  const nameFor = (list, note) => list.find((t) => t.identity.includes(`note:${note}`)).name;
  const tracks = extractTracks(code, { parse });
  const swappedTracks = extractTracks(swapped, { parse });
  assert.equal(nameFor(tracks, 'c4'), 'sine');
  assert.equal(nameFor(tracks, 'g4'), 'sine 2');
  assert.equal(nameFor(swappedTracks, 'c4'), nameFor(tracks, 'c4'));
  assert.equal(nameFor(swappedTracks, 'g4'), nameFor(tracks, 'g4'));
});

test('a string received by a mixer method never changes a $ or branch identity, so adding an effect keeps the track', () => {
  const identity = (code, index = 0) => extractTracks(code, { parse })[index].identity;
  const base = identity('$: s("hh")');
  for (const call of ['.vowel("a")', '.compressor("-20:4")', '.tremoloshape("sine")', '.lpf("300:4")', '.hush()', '.room("0.3:4")']) {
    assert.equal(identity(`$: s("hh")${call}`), base, call);
  }
  const branch = identity('stack(s("bd"), s("hh"))', 1);
  assert.equal(identity('stack(s("bd"), s("hh").vowel("a").compressor("-20:4"))', 1), branch);
  // A string received by any other call still names the track.
  assert.notEqual(identity('$: s("hh").bank("x")'), base);
  assert.notEqual(identity('$: s("hh").s("sine")'), base);
});

// --- Signal-driven filter curves ---

test('lpf/hpf/bpf each get their own curve control when driven by a signal', () => {
  const tracks = extractTracks(
    [
      'one: note("c4").s("sine").lpf(sine.range(400, 2000).slow(8))',
      'two: note("d4").s("sine").hpf(perlin.range(200, 900))',
      'three: note("e4").s("sine").bpf(saw.range(300, 800))',
    ].join('\n'),
    { parse },
  );
  assert.deepEqual(tracks[0].curve, { filter: 'lpf', control: 'cutoff' });
  assert.deepEqual(tracks[1].curve, { filter: 'hpf', control: 'hcutoff' });
  assert.deepEqual(tracks[2].curve, { filter: 'bpf', control: 'bandf' });
});

test('curve is null for a static, stepped, or transformed-string filter argument (no signal)', () => {
  const tracks = extractTracks(
    ['one: note("c4").s("sine").lpf(800)', 'two: note("d4").s("sine").lpf("<400 800>")', 'three: note("e4").s("sine").lpf("400 800".add(100))'].join(
      '\n',
    ),
    { parse },
  );
  assert.equal(tracks[0].curve, null);
  assert.equal(tracks[1].curve, null);
  assert.equal(tracks[2].curve, null);
});

test('a top-level const holding a signal resolves one level; a const holding a string gives null', () => {
  const withConstSignal = extractTracks(
    ['const sweep = sine.range(400, 2000)', 'one: note("c4").s("sine").lpf(sweep)'].join('\n'),
    { parse },
  );
  assert.deepEqual(withConstSignal[0].curve, { filter: 'lpf', control: 'cutoff' });

  const withConstString = extractTracks(['const sweep = "400 800"', 'one: note("c4").s("sine").lpf(sweep)'].join('\n'), { parse });
  assert.equal(withConstString[0].curve, null);
});

test('cutoff()/ctf()/lp() count as lpf; hp() as hpf; bp() as bpf', () => {
  const tracks = extractTracks(
    [
      'one: note("c4").s("sine").cutoff(sine.range(400, 2000))',
      'two: note("d4").s("sine").ctf(sine.range(400, 2000))',
      'three: note("e4").s("sine").lp(sine.range(400, 2000))',
      'four: note("f4").s("sine").hp(perlin.range(200, 900))',
      'five: note("g4").s("sine").bp(saw.range(300, 800))',
    ].join('\n'),
    { parse },
  );
  assert.equal(tracks[0].curve.filter, 'lpf');
  assert.equal(tracks[1].curve.filter, 'lpf');
  assert.equal(tracks[2].curve.filter, 'lpf');
  assert.equal(tracks[3].curve.filter, 'hpf');
  assert.equal(tracks[4].curve.filter, 'bpf');
});

test('a track with both a signal-driven hpf and lpf gets the lpf curve — one curve per lane', () => {
  const tracks = extractTracks('one: note("c4").s("sine").hpf(sine.range(200, 800)).lpf(perlin.range(400, 2000))', { parse });
  assert.equal(tracks[0].curve.filter, 'lpf');
});

test('a sound named "square" in a string never counts as the square signal; only a free identifier does', () => {
  const stringSquare = extractTracks('one: s("square*4").lpf("square")', { parse });
  assert.equal(stringSquare[0].curve, null);

  const identifierSquare = extractTracks('one: s("square*4").lpf(square.range(400, 2000))', { parse });
  assert.deepEqual(identifierSquare[0].curve, { filter: 'lpf', control: 'cutoff' });
});

// --- The solo and mute truth table (each row measured in the real bundle) ---

/** The labels (or names, for tracks without one) of the tracks that do not sound. */
const silentNames = (code) =>
  extractTracks(code, { parse })
    .filter((track) => track.muted)
    .map((track) => track.label ?? track.name);

test('S_a plays alone: a is not muted, b is muted, a is a marker solo shown as a', () => {
  const tracks = extractTracks('S_a: s("bd")\nb: s("hh")', { parse });
  assert.equal(SOLO_MARKER, 'S_');
  assert.equal(tracks[0].muted, false);
  assert.equal(tracks[0].solo, 'marker');
  assert.equal(tracks[0].displayName, 'a');
  assert.equal(tracks[0].name, 'S_a');
  assert.equal(tracks[1].muted, true);
});

test('Snare plays alone by Strudel\'s own rule: solo "name", full name shown, the others muted', () => {
  const tracks = extractTracks('Snare: s("sd")\nb: s("hh")', { parse });
  assert.equal(tracks[0].solo, 'name');
  assert.equal(tracks[0].displayName, 'Snare');
  assert.equal(tracks[0].muted, false);
  assert.equal(tracks[1].muted, true);
});

test('a label of one capital S does not solo, so nothing is muted', () => {
  assert.deepEqual(silentNames('S: s("bd")\nb: s("hh")'), []);
});

test('Sa_ is silenced by its trailing underscore and never triggers solo: b keeps sounding', () => {
  const tracks = extractTracks('Sa_: s("bd")\nb: s("hh")', { parse });
  assert.equal(tracks[0].muted, true);
  assert.equal(tracks[0].ownMuted, true);
  assert.equal(tracks[0].solo, null);
  assert.equal(tracks[1].muted, false);
});

test('_Sa is muted and does not trigger solo: only it is silent', () => {
  assert.deepEqual(silentNames('_Sa: s("bd")\nb: s("hh")\nc: s("cp")'), ['_Sa']);
});

test('several S_ tracks sound together and mute the plain ones', () => {
  assert.deepEqual(silentNames('S_a: s("bd")\nS_b: s("hh")\nc: s("cp")'), ['c']);
});

test('S_a with a muted b and a plain c: b and c are silent, a is not', () => {
  assert.deepEqual(silentNames('S_a: s("bd")\n_b: s("hh")\nc: s("cp")'), ['_b', 'c']);
});

test('S_$ solos a $ track, and a plain $ track is then silent', () => {
  const tracks = extractTracks('S_$: s("bd")\n$: s("hh")', { parse });
  assert.equal(tracks[0].muted, false);
  assert.equal(tracks[0].solo, 'marker');
  assert.equal(tracks[0].displayName, 'bd');
  assert.equal(tracks[1].muted, true);
});

test('_$ mutes a $ track and its display name is the sound', () => {
  const tracks = extractTracks('_$: s("bd")\n$: s("hh")', { parse });
  assert.equal(tracks[0].muted, true);
  assert.equal(tracks[0].ownMuted, true);
  assert.equal(tracks[0].displayName, 'bd');
  assert.equal(tracks[1].muted, false);
});

test('.hush() silences a labeled track, a stack branch and a single program', () => {
  const labeled = extractTracks('a: s("bd").hush()\nb: s("hh")', { parse });
  assert.equal(labeled[0].muted, true);
  assert.equal(labeled[0].ownMuted, true);
  assert.equal(labeled[0].hushed, true);
  assert.equal(labeled[1].muted, false);
  const branches = extractTracks('stack(s("bd").hush(), s("hh"))', { parse });
  assert.deepEqual(branches.map((track) => track.muted), [true, false]);
  assert.equal(branches[0].hushed, true);
  const single = extractTracks('s("bd").hush()', { parse });
  assert.equal(single.length, 1);
  assert.equal(single[0].muted, true);
});

test('a hush inside a function argument is not on the spine and is ignored', () => {
  assert.deepEqual(silentNames('a: s("bd").every(2, (x) => x.hush())'), []);
});

test('the identity is the same across mute, unmute, solo on and solo off', () => {
  for (const label of ['drums', '_drums', 'S_drums', 'drums_', '_S_drums']) {
    assert.equal(extractTracks(`${label}: s("bd")`, { parse })[0].identity, 'label:drums', label);
  }
  const dollar = ['$', '_$', 'S_$'].map((label) => extractTracks(`${label}: s("bd")`, { parse })[0].identity);
  assert.equal(new Set(dollar).size, 1);
});

test('parseLabel: the marker, the underscore, the S name and the labels the mixer cannot read', () => {
  assert.deepEqual(parseLabel('S_hats'), { mutedByLabel: false, core: 'S_hats', solo: 'marker', soloInert: false, base: 'hats', safe: true });
  assert.equal(parseLabel('_S_hats').soloInert, true);
  assert.equal(parseLabel('Snare').solo, 'name');
  assert.equal(parseLabel('_Snare').solo, null);
  assert.equal(parseLabel('Sa_').solo, null);
  assert.equal(parseLabel('S').solo, null);
  assert.equal(parseLabel('S_').safe, false);
  assert.equal(parseLabel('_').safe, false);
  assert.equal(parseLabel('_9x').safe, false);
  assert.equal(parseLabel('a__').safe, false);
  assert.equal(parseLabel('drums').safe, true);
});

// trackRange: the block of one track in the text, from its label to the end of its statement.
const rangeOf = (code, identity) => trackRange(code, identity, { parse });
const slice = (code, range) => code.slice(range.from, range.to);

test('trackRange: a labeled track runs from its label to the end of its statement, a `;` included', () => {
  const plain = 'drums: s("bd")\nhats: s("hh")';
  assert.deepEqual(rangeOf(plain, 'label:drums'), { from: plain.indexOf('drums:'), to: plain.indexOf('\nhats') });
  assert.equal(slice(plain, rangeOf(plain, 'label:drums')), 'drums: s("bd")');
  const semicolon = 'drums: s("bd");\nhats: s("hh");';
  assert.equal(slice(semicolon, rangeOf(semicolon, 'label:drums')), 'drums: s("bd");');
  assert.equal(slice(semicolon, rangeOf(semicolon, 'label:hats')), 'hats: s("hh");');
});

test('trackRange: a chain over three lines ends at the end of its last line', () => {
  const code = 'drums: s("bd")\nhats: s("hh*8")\n  .fast(2)\n  .gain(0)\npad: note("c3")';
  const range = rangeOf(code, 'label:hats');
  assert.equal(slice(code, range), 'hats: s("hh*8")\n  .fast(2)\n  .gain(0)');
  assert.equal(range.from, code.indexOf('hats:'));
});

test('trackRange: a label written twice resolves to the second statement', () => {
  const code = 'drums: s("bd")\nhats: s("hh")\ndrums: s("sd")';
  const range = rangeOf(code, 'label:drums');
  assert.equal(range.from, code.lastIndexOf('drums:'));
  assert.equal(slice(code, range), 'drums: s("sd")');
});

test('trackRange: each `$:` statement maps to its own block', () => {
  const code = '$: s("bd")\n$: s("hh")';
  const tracks = extractTracks(code, { parse });
  assert.equal(tracks.length, 2);
  assert.equal(slice(code, rangeOf(code, tracks[0].identity)), '$: s("bd")');
  assert.equal(slice(code, rangeOf(code, tracks[1].identity)), '$: s("hh")');
});

test('trackRange: an unlabeled stack branch is its branch, a whole unlabeled pattern is that expression', () => {
  const stacked = 'stack(s("bd"), s("hh").fast(2))';
  const branches = extractTracks(stacked, { parse });
  assert.equal(branches.length, 2);
  assert.equal(slice(stacked, rangeOf(stacked, branches[0].identity)), 's("bd")');
  assert.equal(slice(stacked, rangeOf(stacked, branches[1].identity)), 's("hh").fast(2)');
  const whole = 's("bd")';
  const only = extractTracks(whole, { parse });
  assert.equal(slice(whole, rangeOf(whole, only[0].identity)), whole);
});

test('trackRange: a constant the track reads is not part of its block', () => {
  const code = 'const trig = s("bd")\nkick: trig';
  const range = rangeOf(code, 'label:kick');
  assert.equal(range.from, code.indexOf('kick:'));
  assert.equal(slice(code, range), 'kick: trig');
});

test('trackRange: offsets are UTF-16 offsets of the text, so an accent and an emoji before the track do not shift it', () => {
  const code = '// café 🎹 by the sea\npad: note("c3")';
  const range = rangeOf(code, 'label:pad');
  assert.equal(range.from, code.indexOf('pad:'));
  assert.equal(slice(code, range), 'pad: note("c3")');
});

test('trackRange: null for an identity that is not a track of the code and for code with no track', () => {
  assert.equal(rangeOf('drums: s("bd")', 'label:missing'), null);
  assert.equal(rangeOf('setcps(1)', 'label:drums'), null);
  assert.equal(rangeOf('', 'label:drums'), null);
});
