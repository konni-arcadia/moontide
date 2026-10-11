// Unit tests for page/mixer-rewrite.js: the spine reader and the edit-list writer. The real
// acorn parser is injected, like test/tracks.test.js. Fixtures use neutral sounds (bd, hh, cp)
// and labels (drums, hats).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { extractTracks, trackNodes, PARSE_OPTIONS } from '../page/tracks.js';
import { MixerRewriteError, REFUSAL_REASONS, applyEdits, touchedRanges, readProgram, writeBus, writeTrack } from '../page/mixer-rewrite.js';

/** Writes a volume on track `identity` and returns the new code. */
const write = (code, identity, value) => writeTrack(code, identity, { identity, type: 'gain', value }, { parse }).code;
const writeRaw = (code, identity, value) => writeTrack(code, identity, { identity, type: 'gain', value }, { parse });

/** The error a write throws, or fails the test when it does not throw. */
function refusal(code, identity, value = 0.5) {
  try {
    writeRaw(code, identity, value);
  } catch (err) {
    assert.ok(err instanceof MixerRewriteError, `expected a MixerRewriteError, got ${String(err)}`);
    assert.match(err.message, /^Moontide: /);
    return err;
  }
  assert.fail('expected the write to be refused');
}

// --- in place, add, idempotency, adjacency ---

test('a fixed gain is edited in place', () => {
  assert.equal(write('drums: s("bd").gain(0.5)', 'label:drums', 0.8), 'drums: s("bd").gain(0.8)');
});

test('a track with no gain gets .postgain(n) at the end of its chain', () => {
  assert.equal(write('drums: s("bd")', 'label:drums', 0.8), 'drums: s("bd").postgain(0.8)');
  assert.equal(write('drums: s("bd").lpf(300)', 'label:drums', 0.4), 'drums: s("bd").lpf(300).postgain(0.4)');
});

test('every other byte of the program is kept when a leading-dot number is replaced', () => {
  const code = 'setcpm(30)\ndrums: s("bd").gain(.8)   // kept\nhats: s("hh")';
  assert.equal(write(code, 'label:drums', 0.35), 'setcpm(30)\ndrums: s("bd").gain(0.35)   // kept\nhats: s("hh")');
});

test('writing the same volume twice leaves the code byte-for-byte unchanged and returns no edits', () => {
  const code = 'drums: s("bd").gain(0.8)';
  const once = writeRaw(code, 'label:drums', 0.8);
  assert.equal(once.code, code);
  assert.deepEqual(once.edits, []);
  const first = writeRaw('drums: s("bd")', 'label:drums', 0.3);
  const second = writeRaw(first.code, 'label:drums', 0.3);
  assert.equal(second.code, first.code);
  assert.deepEqual(second.edits, []);
  // A cosmetic spelling of the same number is left as written.
  assert.equal(write('drums: s("bd").gain(.80)', 'label:drums', 0.8), 'drums: s("bd").gain(.80)');
});

test('with two .gain() calls on one chain only the last one is read and edited', () => {
  assert.equal(write('drums: s("bd").gain(0.3).gain(0.5)', 'label:drums', 0.7), 'drums: s("bd").gain(0.3).gain(0.7)');
  const { reads } = readProgram('drums: s("bd").gain(0.3).gain(0.5)', { parse });
  assert.deepEqual(reads.get('label:drums').gain, { kind: 'fixed', value: 0.5 });
});

test('the value is written to two decimals and a negative or non-finite value throws', () => {
  assert.equal(write('drums: s("bd")', 'label:drums', 0.3333), 'drums: s("bd").postgain(0.33)');
  assert.equal(write('drums: s("bd")', 'label:drums', 0), 'drums: s("bd").postgain(0)');
  for (const bad of [-0.1, NaN, Infinity, '0.5']) {
    assert.throws(() => writeRaw('drums: s("bd")', 'label:drums', bad), (err) => err instanceof MixerRewriteError && err.reason === 'unsupported-change');
  }
  assert.throws(() => writeTrack('drums: s("bd")', 'label:drums', { identity: 'label:drums', type: 'pan', value: 0 }, { parse }), MixerRewriteError);
});

// --- the fader multiplies: .postgain keeps the per-note gains ---

test('a stack with gains inside it gets .postgain at the end and its text is byte-identical', () => {
  const inner = 'stack(s("bd").gain(1), s("hh*4").gain(.3))';
  const code = `drums: ${inner}`;
  const out = write(code, 'label:drums', 0.58);
  assert.equal(out, `drums: ${inner}.postgain(0.58)`);
  assert.ok(out.includes(inner), 'every per-note gain is written exactly as before');
});

test('a three-step gesture leaves exactly one .postgain( holding the last value', () => {
  let code = 'drums: stack(s("bd").gain(1), s("hh*4").gain(.3))';
  for (const value of [0.5, 0.6, 0.7]) code = write(code, 'label:drums', value);
  assert.equal(code, 'drums: stack(s("bd").gain(1), s("hh*4").gain(.3)).postgain(0.7)');
  assert.equal(code.split('.postgain(').length - 1, 1);
});

test('a fixed .postgain with no gain is edited in place', () => {
  assert.equal(write('drums: s("bd").postgain(0.5)', 'label:drums', 0.9), 'drums: s("bd").postgain(0.9)');
});

test('a fixed .gain after gains inside the track is edited in place and nothing inside changes', () => {
  const code = 'drums: stack(s("bd").gain(1), s("hh*4").gain(.3)).gain(0.8)';
  assert.equal(write(code, 'label:drums', 0.4), 'drums: stack(s("bd").gain(1), s("hh*4").gain(.3)).gain(0.4)');
});

test('a track with no gain and a moving post-gain is refused with the post-gain words', () => {
  const err = refusal('drums: s("bd").postgain(perlin)', 'label:drums');
  assert.equal(err.reason, 'unsupported-change');
  assert.match(err.message, /The post-gain moves in the code\./);
});

test('the fader range writes its bottom, its top and two decimals of a value in between', () => {
  assert.equal(write('drums: s("bd")', 'label:drums', 0), 'drums: s("bd").postgain(0)');
  assert.equal(write('drums: s("bd")', 'label:drums', 1.5), 'drums: s("bd").postgain(1.5)');
  assert.equal(write('drums: s("bd")', 'label:drums', 0.333), 'drums: s("bd").postgain(0.33)');
  for (const bad of [-0.1, NaN]) {
    assert.throws(() => writeRaw('drums: s("bd")', 'label:drums', bad), (err) => err instanceof MixerRewriteError && err.reason === 'unsupported-change');
  }
});

// --- layout of an added call ---

test('a multi-line chain gets the new call on its own indented line', () => {
  const code = 'drums: s("bd*4")\n  .lpf(1200) // low\n  .room(0.3)\n';
  assert.equal(write(code, 'label:drums', 0.5), 'drums: s("bd*4")\n  .lpf(1200) // low\n  .room(0.3)\n  .postgain(0.5)\n');
});

test('a trailing comment after the last call stays attached to its own call', () => {
  const code = 'drums: s("bd*4")\n  .lpf(1200)\n  .room(0.3) // wet\nhats: s("hh")';
  assert.equal(write(code, 'label:drums', 0.5), 'drums: s("bd*4")\n  .lpf(1200)\n  .room(0.3) // wet\n  .postgain(0.5)\nhats: s("hh")');
});

test('a trailing semicolon stays last: the call goes before it', () => {
  assert.equal(write('drums: s("bd");', 'label:drums', 0.5), 'drums: s("bd").postgain(0.5);');
  assert.equal(write('drums: s("bd")\n  .lpf(300);', 'label:drums', 0.5), 'drums: s("bd")\n  .lpf(300)\n  .postgain(0.5);');
});

test('a single-line chain keeps a first added call inline even with a trailing comment', () => {
  assert.equal(write('drums: s("bd") // kick', 'label:drums', 0.5), 'drums: s("bd").postgain(0.5) // kick');
});

// --- other track shapes ---

test('a stack() branch changes without touching the other branch', () => {
  const code = 'stack(s("bd"), s("hh"))';
  const tracks = extractTracks(code, { parse });
  assert.equal(write(code, tracks[1].identity, 0.4), 'stack(s("bd"), s("hh").postgain(0.4))');
  assert.equal(write(code, tracks[0].identity, 0.4), 'stack(s("bd").postgain(0.4), s("hh"))');
});

test('a $: track and a single-pattern program work', () => {
  const dollar = '$: s("bd")\n$: s("hh")';
  const tracks = extractTracks(dollar, { parse });
  assert.equal(write(dollar, tracks[0].identity, 0.3), '$: s("bd").postgain(0.3)\n$: s("hh")');
  const single = 's("bd*4").lpf(500)';
  const only = extractTracks(single, { parse })[0].identity;
  assert.equal(write(single, only, 0.6), 's("bd*4").lpf(500).postgain(0.6)');
});

test('a labeled track inside stack keeps the labels and the rest of the code', () => {
  const code = 'setcpm(30)\ndrums: s("bd")\nhats: s("hh").gain(0.2)\n';
  assert.equal(write(code, 'label:hats', 0.6), 'setcpm(30)\ndrums: s("bd")\nhats: s("hh").gain(0.6)\n');
});

// --- only the spine ---

test('a gain inside a function argument is neither read nor written: a spine call is added', () => {
  const code = 'drums: s("bd").every(2, x => x.gain(0.5))';
  const { reads } = readProgram(code, { parse });
  assert.deepEqual(reads.get('label:drums').gain, { kind: 'none', value: null });
  assert.equal(write(code, 'label:drums', 0.7), 'drums: s("bd").every(2, x => x.gain(0.5)).postgain(0.7)');
});

// --- moving gain: post-gain ---

test('a moving gain leaves Claude\'s gain alone and writes .postgain', () => {
  const code = 'drums: s("bd").gain(sine.range(0.2, 0.8))';
  assert.equal(write(code, 'label:drums', 0.5), 'drums: s("bd").gain(sine.range(0.2, 0.8)).postgain(0.5)');
  assert.equal(write('drums: s("bd").gain("0.3 0.6")', 'label:drums', 0.5), 'drums: s("bd").gain("0.3 0.6").postgain(0.5)');
});

test('an existing fixed .postgain is edited in place', () => {
  const code = 'drums: s("bd").gain(sine.range(0.2, 0.8)).postgain(0.9)';
  assert.equal(write(code, 'label:drums', 0.5), 'drums: s("bd").gain(sine.range(0.2, 0.8)).postgain(0.5)');
  const { reads } = readProgram(code, { parse });
  assert.deepEqual(reads.get('label:drums').postgain, { kind: 'fixed', value: 0.9 });
});

test('gain and post-gain both moving is an unsupported change', () => {
  const code = 'drums: s("bd").gain(sine.range(0.2, 0.8)).postgain(perlin)';
  const err = refusal(code, 'label:drums');
  assert.equal(err.reason, 'unsupported-change');
  assert.match(err.message, /Gain and post-gain both move in the code\./);
});

// --- refusals ---

test('a root that is a top-level variable, destructured name, function or class is written at the end of the track\'s own chain', () => {
  const programs = [
    ['const bass = s("bd")\n', 'drums: bass', 'drums: bass.postgain(0.5)'],
    ['let bass = s("bd")\n', 'drums: bass.lpf(300)', 'drums: bass.lpf(300).postgain(0.5)'],
    ['var bass = s("bd")\n', 'drums: bass', 'drums: bass.postgain(0.5)'],
    ['const { bass } = { bass: s("bd") }\n', 'drums: bass', 'drums: bass.postgain(0.5)'],
    ['const [bass] = [s("bd")]\n', 'drums: bass', 'drums: bass.postgain(0.5)'],
    ['function bass() { return s("bd") }\n', 'drums: bass()', 'drums: bass().postgain(0.5)'],
    ['const bass = () => s("bd")\n', 'drums: bass().gain(0.2)', 'drums: bass().gain(0.5)'],
    ['class Bass {}\n', 'drums: Bass', 'drums: Bass.postgain(0.5)'],
  ];
  for (const [declaration, track, written] of programs) {
    const code = declaration + track;
    assert.equal(write(code, 'label:drums', 0.5), declaration + written, code);
    assert.equal(readProgram(code, { parse }).reads.get('label:drums').sharedRoot, true, code);
  }
});

test('a track built from a constant keeps a trailing semicolon and comment after the new call', () => {
  const code = 'const bass = s("bd")\ndrums: bass.lpf(300);  // kept\nhats: s("hh")';
  assert.equal(write(code, 'label:drums', 0.5), 'const bass = s("bd")\ndrums: bass.lpf(300).postgain(0.5);  // kept\nhats: s("hh")');
});

test('a multi-line chain on a constant gets the new call on its own line with the chain\'s indentation', () => {
  const code = 'const bass = s("bd")\ndrums: bass\n  .lpf(300)\n  .fast(2)\nhats: s("hh")';
  assert.equal(write(code, 'label:drums', 0.5), 'const bass = s("bd")\ndrums: bass\n  .lpf(300)\n  .fast(2)\n  .postgain(0.5)\nhats: s("hh")');
});

test('two tracks on one constant: a write on one changes only its own line', () => {
  const code = 'const trig = s("bd")\nkick: trig\nhats: trig.fast(2)';
  assert.equal(write(code, 'label:hats', 0.5), 'const trig = s("bd")\nkick: trig\nhats: trig.fast(2).postgain(0.5)');
  assert.equal(write(code, 'label:kick', 0.5), 'const trig = s("bd")\nkick: trig.postgain(0.5)\nhats: trig.fast(2)');
});

test('$: tracks on one constant keep their identities after a write on the first', () => {
  const code = 'const trig = s("bd")\n$: trig\n$: trig.fast(2)';
  const before = extractTracks(code, { parse }).map((track) => track.identity);
  assert.deepEqual(before, ['root:trig', 'root:trig #2']);
  const out = write(code, 'root:trig', 0.5);
  assert.equal(out, 'const trig = s("bd")\n$: trig.postgain(0.5)\n$: trig.fast(2)');
  assert.deepEqual(extractTracks(out, { parse }).map((track) => track.identity), before);
});

test('an unlabeled stack branch rooted in a constant is written inside its branch', () => {
  const code = 'const b = s("hh")\nstack(s("bd"), b.fast(2))';
  assert.equal(write(code, 'root:b', 0.5), 'const b = s("hh")\nstack(s("bd"), b.fast(2).postgain(0.5))');
});

test('a root that is a string or a global is not shared code', () => {
  const { reads } = readProgram('drums: s("bd")\nbass: silence\nhats: sine.range(0, 1)', { parse });
  assert.equal(reads.get('label:drums').sharedRoot, false);
  assert.equal(reads.get('label:bass').sharedRoot, false);
  assert.equal(reads.get('label:hats').sharedRoot, false);
});

test('a ternary or && root and an unnamed branch are refused: condition', () => {
  assert.equal(refusal('drums: 1 ? s("bd") : s("hh")', 'label:drums').reason, 'condition');
  assert.equal(refusal('drums: ok && s("bd")', 'label:drums').reason, 'condition');
  const unnamed = 'stack(s("bd"), cond ? s("hh") : s("cp"))';
  const tracks = extractTracks(unnamed, { parse });
  const conditional = tracks.find((track) => track.unnamed);
  assert.ok(conditional, 'the conditional branch is an unnamed track');
  assert.equal(refusal(unnamed, conditional.identity).reason, 'condition');
  assert.equal(readProgram(unnamed, { parse }).reads.get(conditional.identity).reason, 'condition');
});

test('an arrow function root, a computed member call, an optional call, a comment after the dot and a bad gain call are refused: unsupported-shape', () => {
  const programs = [
    'drums: (x => x)',
    'drums: s("bd")["gain"](0.5).lpf(300)',
    'drums: s("bd")?.gain(0.5)',
    'drums: s("bd").\n  /* c */ gain(0.5)',
    'drums: s("bd").gain()',
    'drums: s("bd").gain(0.2, 0.3)',
    'drums: s("bd").gain(...xs)',
    'drums: s("bd").postgain(...xs)',
    'drums: (1, s("bd"))',
    'drums: k.a',
  ];
  for (const code of programs) {
    assert.equal(refusal(code, 'label:drums').reason, 'unsupported-shape', code);
    assert.equal(readProgram(code, { parse }).reads.get('label:drums').reason, 'unsupported-shape', code);
  }
});

test('the refusal reasons are the two documented codes', () => {
  assert.deepEqual(REFUSAL_REASONS, ['condition', 'unsupported-shape']);
});

test('an identity that is not in the code throws track-gone', () => {
  assert.equal(refusal('drums: s("bd")', 'label:hats').reason, 'track-gone');
});

test('readProgram reports refusals per track and never throws for one bad track', () => {
  const code = 'const x = s("bd")\nbad: x\ndrums: s("bd").gain(0.4)\nweird: (y => y)\nhats: s("hh")';
  const { tracks, reads } = readProgram(code, { parse });
  assert.deepEqual(tracks.map((t) => t.identity), ['label:bad', 'label:drums', 'label:weird', 'label:hats']);
  assert.equal(reads.get('label:bad').ok, true);
  assert.equal(reads.get('label:bad').sharedRoot, true);
  assert.deepEqual(reads.get('label:drums'), {
    ok: true,
    gain: { kind: 'fixed', value: 0.4 },
    postgain: { kind: 'none', value: null },
    effects: new Map(),
    // Nothing written: orbit 1 (Strudel's default), no send, no bus value.
    bus: {
      orbit: { kind: 'unwritten', value: 1 },
      sends: { reverb: { kind: 'unwritten', value: null }, delay: { kind: 'unwritten', value: null } },
      busParams: {
        reverb: Object.fromEntries(['size', 'fade', 'lowpass', 'damping'].map((id) => [id, { kind: 'unwritten', value: null }])),
        delay: Object.fromEntries(['time', 'feedback'].map((id) => [id, { kind: 'unwritten', value: null }])),
      },
    },
    label: { raw: 'drums', mutedByLabel: false, core: 'drums', solo: null, soloInert: false, base: 'drums', safe: true },
    sharedRoot: false,
    playsMidi: false,
    innerPostgain: false,
    busHidden: false,
  });
  assert.equal(reads.get('label:weird').reason, 'unsupported-shape');
  assert.equal(reads.get('label:hats').ok, true);
});

test('readProgram throws the parser\'s error for an unparsable program', () => {
  assert.throws(() => readProgram('drums: s("bd"', { parse }), SyntaxError);
});

// --- edit lists ---

test('applyEdits rebuilds the text from original-coordinate edits, in any order', () => {
  const code = 'abcdef';
  assert.equal(applyEdits(code, [{ from: 4, to: 5, insert: 'X' }, { from: 1, to: 2, insert: 'YY' }]), 'aYYcdXf');
  assert.equal(applyEdits(code, []), code);
});

test('applyEdits throws on overlapping edits and allows two inserts at one point', () => {
  assert.throws(() => applyEdits('abcdef', [{ from: 1, to: 4, insert: 'X' }, { from: 3, to: 5, insert: 'Y' }]), /overlap/);
  assert.equal(applyEdits('abc', [{ from: 1, to: 1, insert: 'X' }, { from: 1, to: 1, insert: 'Y' }]), 'aXYbc');
});

test('touchedRanges maps original-coordinate edits to new coordinates, ascending', () => {
  const edits = [{ from: 4, to: 5, insert: 'XYZ' }, { from: 1, to: 3, insert: 'Q' }];
  assert.deepEqual(touchedRanges(edits), [{ from: 1, to: 2 }, { from: 3, to: 6 }]);
  const code = 'abcdef';
  const out = applyEdits(code, edits);
  assert.equal(out.slice(1, 2), 'Q');
  assert.equal(out.slice(3, 6), 'XYZ');
  assert.deepEqual(touchedRanges([]), []);
});

test('a write returns the same edit list that rebuilds the code and maps to the written text', () => {
  const code = 'drums: s("bd")\n  .lpf(300)\nhats: s("hh")';
  const { code: out, edits } = writeRaw(code, 'label:drums', 0.6);
  assert.equal(applyEdits(code, edits), out);
  const [range] = touchedRanges(edits);
  assert.equal(out.slice(range.from, range.to), '\n  .postgain(0.6)');
});

// --- trackNodes pairs with extractTracks ---

test('trackNodes(ast)[i].expression starts where extractTracks(...)[i] starts, for every program shape', () => {
  const programs = [
    'drums: s("bd")\nhats: s("hh").gain(0.2)',
    'stack(s("bd"), s("hh"), s("cp"))',
    'stack(s("bd"), stack(s("hh"), s("cp")).fast(2))',
    's("bd*4").lpf(300)',
    '$: s("bd")\n$: s("hh")',
    'drums: s("bd")\ndrums: s("hh")',
    'setcpm(30)',
  ];
  for (const code of programs) {
    const tracks = extractTracks(code, { parse });
    const nodes = trackNodes(parse(code, PARSE_OPTIONS));
    assert.equal(nodes.length, tracks.length, code);
    nodes.forEach((node, i) => {
      assert.equal(node.expression.start, tracks[i].start, code);
      assert.equal(node.expression.end, tracks[i].end, code);
    });
  }
});

// --- Mute and solo ---

/** Writes a mute or solo change and returns the new code. */
const change = (code, identity, type, on) => writeTrack(code, identity, { identity, type, on }, { parse }).code;
const changeError = (code, identity, type, on) => {
  try {
    change(code, identity, type, on);
  } catch (err) {
    assert.ok(err instanceof MixerRewriteError, `expected a MixerRewriteError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the change to be refused');
};

test('mute writes an underscore in front of the label and unmute removes it', () => {
  assert.equal(change('drums: s("bd")', 'label:drums', 'mute', true), '_drums: s("bd")');
  assert.equal(change('_drums: s("bd")', 'label:drums', 'mute', false), 'drums: s("bd")');
  assert.equal(change('drums_: s("bd")', 'label:drums', 'mute', false), 'drums: s("bd")');
});

test('solo writes the marker in front of the label and solo off removes it', () => {
  assert.equal(change('drums: s("bd")', 'label:drums', 'solo', true), 'S_drums: s("bd")');
  assert.equal(change('S_drums: s("bd")', 'label:drums', 'solo', false), 'drums: s("bd")');
});

test('mute and solo exclude each other on one label: the marker goes when muting, the underscore when soloing', () => {
  assert.equal(change('S_drums: s("bd")', 'label:drums', 'mute', true), '_drums: s("bd")');
  assert.equal(change('_drums: s("bd")', 'label:drums', 'solo', true), 'S_drums: s("bd")');
  assert.equal(change('drums_: s("bd")', 'label:drums', 'solo', true), 'S_drums: s("bd")');
});

test('asking for the state the label already has returns the code unchanged', () => {
  assert.equal(change('_drums: s("bd")', 'label:drums', 'mute', true), '_drums: s("bd")');
  assert.equal(change('drums: s("bd")', 'label:drums', 'mute', false), 'drums: s("bd")');
  assert.equal(change('S_drums: s("bd")', 'label:drums', 'solo', true), 'S_drums: s("bd")');
  assert.equal(change('drums: s("bd")', 'label:drums', 'solo', false), 'drums: s("bd")');
});

test('a $ track can be muted and soloed', () => {
  assert.equal(change('$: s("bd")', 's:bd', 'mute', true), '_$: s("bd")');
  assert.equal(change('$: s("bd")', 's:bd', 'solo', true), 'S_$: s("bd")');
  assert.equal(change('S_$: s("bd")', 's:bd', 'solo', false), '$: s("bd")');
});

test('the mixer never renames a name that starts with S: solo is an unsupported-change, mute is allowed', () => {
  assert.equal(changeError('Snare: s("sd")', 'label:Snare', 'solo', true).reason, 'unsupported-change');
  assert.equal(changeError('Snare: s("sd")', 'label:Snare', 'solo', false).reason, 'unsupported-change');
  assert.equal(change('Snare: s("sd")', 'label:Snare', 'mute', true), '_Snare: s("sd")');
  // Unmuting gives back a name Strudel plays alone; the mixer writes it and shows the warning.
  assert.equal(change('_Snare: s("sd")', 'label:Snare', 'mute', false), 'Snare: s("sd")');
  // S_Snare cannot be turned off without leaving Snare, which still plays alone.
  assert.equal(changeError('S_Snare: s("sd")', 'label:Snare', 'solo', false).reason, 'unsupported-change');
});

test('a label the mixer cannot read is unsupported-shape for mute and solo', () => {
  assert.equal(changeError('S_: s("bd")', 'label:S_', 'mute', true).reason, 'unsupported-shape');
  assert.equal(changeError('_: s("bd")', 'label:_', 'solo', true).reason, 'unsupported-shape');
  assert.equal(changeError('_9x: s("bd")', 'label:_9x', 'mute', false).reason, 'unsupported-shape');
});

test('a mute or solo is refused when its label is shared with a shadowed statement or already in use', () => {
  // The shadowed kick was silent; muting the last statement would bring it back.
  const repeated = 'a: s("kick")\na: s("snare")';
  assert.match(changeError(repeated, 'label:a', 'mute', true).message, /same label/);
  assert.match(changeError(repeated, 'label:a', 'solo', true).message, /same label/);
  // Soloing `a` would write a second S_a: Strudel would keep only the last one.
  const taken = 'S_a: s("k")\na: s("s")';
  assert.equal(changeError('S_a: s("k")\nb: s("s")\nb: s("t")', 'label:b', 'solo', true).reason, 'unsupported-change');
  assert.match(changeError('a: s("k")\n_a: s("s")', 'label:a #2', 'mute', false).message, /already uses/);
  assert.match(changeError(taken, 'label:a #2', 'solo', true).message, /already uses/);
  // Different labels still work, and `$` labels never repeat.
  assert.equal(change('a: s("k")\nb: s("s")', 'label:b', 'mute', true), 'a: s("k")\n_b: s("s")');
  assert.equal(change('$: s("k")\n$: s("s")', 's:s', 'mute', true), '$: s("k")\n_$: s("s")');
});

test('a mute or solo change without on, or with an unknown type, is refused', () => {
  assert.equal(changeError('drums: s("bd")', 'label:drums', 'mute', undefined).reason, 'unsupported-change');
  assert.equal(changeError('drums: s("bd")', 'label:drums', 'pan', true).reason, 'unsupported-change');
});

test('an unlabeled branch mutes with .hush() inside that branch only, and unmutes by removing it', () => {
  const code = 'stack(s("bd"), s("hh"))';
  const muted = change(code, 's:bd', 'mute', true);
  assert.equal(muted, 'stack(s("bd").hush(), s("hh"))');
  assert.equal(change(muted, 's:bd', 'mute', false), code);
  assert.equal(change('s("bd").gain(0.5)', 's:bd', 'mute', true), 's("bd").gain(0.5).hush()');
});

test('unmute removes every .hush() of the chain: alone on its line with its comment, or inline from its dot', () => {
  const multi = 'drums: s("bd")\n  .hush() // off\n  .gain(0.5) // level';
  assert.equal(change(multi, 'label:drums', 'mute', false), 'drums: s("bd")\n  .gain(0.5) // level');
  assert.equal(change('drums: s("bd").hush().gain(0.5).hush()', 'label:drums', 'mute', false), 'drums: s("bd").gain(0.5)');
});

test('a labeled track with .hush() and a mute underscore loses both when unmuted; solo drops the hush too', () => {
  assert.equal(change('_drums: s("bd").hush()', 'label:drums', 'mute', false), 'drums: s("bd")');
  assert.equal(change('drums: s("bd").hush()', 'label:drums', 'mute', false), 'drums: s("bd")');
  assert.equal(change('drums: s("bd").hush()', 'label:drums', 'solo', true), 'S_drums: s("bd")');
  assert.equal(change('_drums: s("bd").hush()', 'label:drums', 'solo', true), 'S_drums: s("bd")');
});

test('a labeled track that is hushed is already muted: mute on changes nothing', () => {
  assert.equal(change('drums: s("bd").hush()', 'label:drums', 'mute', true), 'drums: s("bd").hush()');
});

test('an unlabeled track cannot be soloed: unsupported-change', () => {
  assert.equal(changeError('stack(s("bd"), s("hh"))', 's:bd', 'solo', true).reason, 'unsupported-change');
  assert.equal(changeError('s("bd")', 's:bd', 'solo', false).reason, 'unsupported-change');
});

test('a mute writes the label edit and a hush removal as edits that never overlap', () => {
  const { code, edits } = writeTrack('_drums: s("bd").hush()', 'label:drums', { identity: 'label:drums', type: 'mute', on: false }, { parse });
  assert.equal(code, 'drums: s("bd")');
  assert.equal(edits.length, 2);
});

// --- Effects: reading and adding ---

/** Adds an effect to track `identity` and returns the new code. */
const addEffect = (code, identity, effect) => writeTrack(code, identity, { identity, type: 'add-effect', effect }, { parse }).code;
const effectsOf = (code, identity) => readProgram(code, { parse }).reads.get(identity).effects;

test('adding an effect writes only its primary call with its starting value', () => {
  const start = {
    lpf: '.lpf(2000)',
    hpf: '.hpf(300)',
    bpf: '.bpf(1000)',
    vowel: '.vowel("a")',
    coarse: '.coarse(4)',
    crush: '.crush(8)',
    distort: '.distort(1)',
    tremolo: '.tremolosync(4)',
    compressor: '.compressor("-20:4")',
    pan: '.pan(0.5)',
    phaser: '.phaser(2)',
  };
  for (const [effect, call] of Object.entries(start)) {
    assert.equal(addEffect('drums: s("bd")', 'label:drums', effect), `drums: s("bd")${call}`, effect);
  }
});

test('an added effect lands after the last call of an earlier chain effect', () => {
  const code = 'drums: s("bd*4").crush(8).lpf(1200).gain(0)';
  assert.equal(addEffect(code, 'label:drums', 'hpf'), 'drums: s("bd*4").crush(8).lpf(1200).hpf(300).gain(0)');
});

test('an added effect lands before the first call of a later chain effect when no earlier one is there', () => {
  assert.equal(addEffect('drums: s("bd").crush(8).pan(0.2)', 'label:drums', 'lpf'), 'drums: s("bd").lpf(2000).crush(8).pan(0.2)');
  // With calls of both sides, "after the earlier one" wins.
  assert.equal(addEffect('drums: s("bd").lpf(300).pan(0.2)', 'label:drums', 'crush'), 'drums: s("bd").lpf(300).crush(8).pan(0.2)');
});

test('with no effect in the chain the new call goes to the end of the spine, before a semicolon or a stack comma', () => {
  assert.equal(addEffect('drums: s("bd").gain(0.5);', 'label:drums', 'crush'), 'drums: s("bd").gain(0.5).crush(8);');
  assert.equal(addEffect('stack(s("bd").gain(0.5), s("hh"))', 's:bd', 'crush'), 'stack(s("bd").gain(0.5).crush(8), s("hh"))');
});

test('an added effect on a multi-line chain gets its own indented line and keeps trailing comments with their calls', () => {
  const code = 'drums: s("bd*4")\n  .lpf(1200) // darker\n  .room(0.3)\n';
  assert.equal(addEffect(code, 'label:drums', 'hpf'), 'drums: s("bd*4")\n  .lpf(1200) // darker\n  .hpf(300)\n  .room(0.3)\n');
  assert.equal(
    addEffect('drums: s("bd*4")\n  .crush(8) // rough\n  .gain(0.5)', 'label:drums', 'lpf'),
    'drums: s("bd*4")\n  .lpf(2000)\n  .crush(8) // rough\n  .gain(0.5)',
  );
  assert.equal(addEffect('drums: s("bd*4")\n  .gain(0.5) // level', 'label:drums', 'crush'), 'drums: s("bd*4")\n  .gain(0.5) // level\n  .crush(8)');
});

test('an effect the track already has, by any alias, is refused as unsupported-change', () => {
  for (const code of ['drums: s("bd").lpf(300)', 'drums: s("bd").cutoff(300)', 'drums: s("bd").lpq(2)', 'drums: s("bd").lpf(sine)']) {
    assert.throws(
      () => addEffect(code, 'label:drums', 'lpf'),
      (err) => err instanceof MixerRewriteError && err.reason === 'unsupported-change',
      code,
    );
  }
});

test('an unknown effect id is refused as unsupported-change', () => {
  assert.throws(
    () => addEffect('drums: s("bd")', 'label:drums', 'reverb'),
    (err) => err instanceof MixerRewriteError && err.reason === 'unsupported-change',
  );
});

test('adding an effect to one branch of a stack leaves the other branch alone, and a $ track works', () => {
  assert.equal(addEffect('stack(s("bd"), s("hh"))', 's:hh', 'crush'), 'stack(s("bd"), s("hh").crush(8))');
  assert.equal(addEffect('$: s("bd")\n$: s("hh")', 's:hh', 'pan'), '$: s("bd")\n$: s("hh").pan(0.5)');
});

test('the read lists every effect with a spine call, its parameters and its written text', () => {
  const effects = effectsOf('drums: s("bd").cutoff(500).lpq(4).crush(8)', 'label:drums');
  assert.deepEqual([...effects.keys()], ['lpf', 'crush']);
  assert.equal(effects.get('lpf').written, '.cutoff(500).lpq(4)');
  assert.deepEqual(effects.get('lpf').calls.map((call) => [call.method, call.canonical]), [['cutoff', 'lpf'], ['lpq', 'lpq']]);
  assert.deepEqual(effects.get('lpf').params.cutoff, { kind: 'fixed', value: 500, method: 'lpf' });
  assert.deepEqual(effects.get('lpf').params.resonance, { kind: 'fixed', value: 4, method: 'lpq' });
  assert.deepEqual(effects.get('crush').params.bits, { kind: 'fixed', value: 8, method: 'crush' });
});

test('the last writer of a key wins, aliases included', () => {
  assert.equal(effectsOf('d: s("bd").cutoff(500).lpf(300)', 'label:d').get('lpf').params.cutoff.value, 300);
  assert.equal(effectsOf('d: s("bd").lpf(300).cutoff(500)', 'label:d').get('lpf').params.cutoff.value, 500);
});

test('a plain number writes only the first key of its pack: lpf(300) leaves the resonance unwritten', () => {
  const lpf = effectsOf('d: s("bd").lpf(300)', 'label:d').get('lpf');
  assert.equal(lpf.params.resonance.kind, 'unwritten');
  // A string with a colon may write every key of the pack, so both parameters read as moving.
  const text = effectsOf('d: s("bd").lpf("300:4")', 'label:d').get('lpf');
  assert.equal(text.params.cutoff.kind, 'pattern');
  assert.equal(text.params.resonance.kind, 'pattern');
  // A signal or a pattern of plain values writes only the first key.
  const signal = effectsOf('d: s("bd").lpf(sine.range(400, 2000))', 'label:d').get('lpf');
  assert.equal(signal.params.cutoff.kind, 'pattern');
  assert.equal(signal.params.resonance.kind, 'unwritten');
});

test('a pattern or signal argument reads as moving, and a duplicate shows the last call', () => {
  assert.equal(effectsOf('d: s("bd").lpf(sine.range(400, 2000))', 'label:d').get('lpf').params.cutoff.kind, 'pattern');
  assert.equal(effectsOf('d: s("bd").lpf("<300 500>")', 'label:d').get('lpf').params.cutoff.kind, 'pattern');
  const twice = effectsOf('d: s("bd").lpf(300).lpf(900)', 'label:d');
  assert.equal(twice.size, 1);
  assert.equal(twice.get('lpf').params.cutoff.value, 900);
});

test('a negative number literal is fixed', () => {
  assert.equal(effectsOf('d: s("bd").compressor(-12)', 'label:d').get('compressor').params.threshold.value, -12);
});

test('the compressor string is read field by field; anything else is moving for every field', () => {
  const two = effectsOf('d: s("bd").compressor("-20:4")', 'label:d').get('compressor').params;
  assert.deepEqual(
    [two.threshold, two.ratio, two.knee],
    [{ kind: 'fixed', value: -20, method: 'compressor' }, { kind: 'fixed', value: 4, method: 'compressor' }, { kind: 'unwritten', value: null, method: null }],
  );
  const five = effectsOf('d: s("bd").compressor("-20:4:10:0.005:0.05")', 'label:d').get('compressor').params;
  assert.equal(five.release.value, 0.05);
  for (const code of ['d: s("bd").compressor("<-20 -10>")', 'd: s("bd").compressor("-20:x")', 'd: s("bd").compressor(sine)', 'd: s("bd").compressor("1:2:3:4:5:6")']) {
    const params = effectsOf(code, 'label:d').get('compressor').params;
    assert.ok(Object.values(params).every((param) => param.kind === 'pattern'), code);
  }
});

test('the vowel is fixed for a string from its list and moving otherwise', () => {
  assert.deepEqual(effectsOf('d: s("bd").vowel("oe")', 'label:d').get('vowel').params.vowel, { kind: 'fixed', value: 'oe', method: 'vowel' });
  assert.equal(effectsOf('d: s("bd").vowel("<a e>")', 'label:d').get('vowel').params.vowel.kind, 'pattern');
  assert.equal(effectsOf('d: s("bd").vowel("zz")', 'label:d').get('vowel').params.vowel.kind, 'pattern');
});

test('tremolo and tremolosync are one effect; the speed keeps the unit of its own method', () => {
  const hz = effectsOf('d: s("bd").tremolo(4)', 'label:d').get('tremolo');
  assert.deepEqual(hz.params.speed, { kind: 'fixed', value: 4, method: 'tremolo' });
  const both = effectsOf('d: s("bd").tremolo(4).tremolosync(2).tremolodepth(0.5).tremoloshape("saw")', 'label:d').get('tremolo');
  assert.deepEqual(both.params.speed, { kind: 'fixed', value: 2, method: 'tremolosync' });
  assert.equal(both.params.depth.value, 0.5);
  assert.equal(both.params.shape.value, 'saw');
  // A plain number of the Hz form does not write the depth.
  assert.equal(effectsOf('d: s("bd").tremolodepth(0.5).tremolo(4)', 'label:d').get('tremolo').params.depth.value, 0.5);
});

test('a registry call with the wrong number of arguments refuses the track as unsupported-shape', () => {
  for (const code of ['d: s("bd").lpf()', 'd: s("bd").lpf(300, 2)', 'd: s("bd").crush(...[8])']) {
    assert.equal(readProgram(code, { parse }).reads.get('label:d').reason, 'unsupported-shape', code);
  }
});

test('calls inside function arguments are never read as the track chain', () => {
  const effects = effectsOf('d: s("bd").every(2, x => x.lpf(300)).crush(8)', 'label:d');
  assert.deepEqual([...effects.keys()], ['crush']);
});

test('adding an effect keeps a $ or branch track identity, including the effects that write a string', () => {
  for (const effect of ['lpf', 'hpf', 'bpf', 'vowel', 'coarse', 'crush', 'distort', 'tremolo', 'compressor', 'pan', 'phaser']) {
    const before = extractTracks('$: s("hh")\n$: s("bd")', { parse })[0].identity;
    const code = addEffect('$: s("hh")\n$: s("bd")', before, effect);
    assert.equal(extractTracks(code, { parse })[0].identity, before, effect);
    const branchBefore = extractTracks('stack(s("bd"), s("hh"))', { parse })[1].identity;
    const branchCode = addEffect('stack(s("bd"), s("hh"))', branchBefore, effect);
    assert.equal(extractTracks(branchCode, { parse })[1].identity, branchBefore, effect);
  }
});

// --- Effects: bypass, restore, remove ---

const BYPASS_NEEDS_FIXED = 'Bypass needs fixed values; use a fixed value first, or Remove.';
const applyChange = (code, identity, spec) => writeTrack(code, identity, { identity, ...spec }, { parse });
const refused = (code, identity, spec) => {
  try {
    applyChange(code, identity, spec);
  } catch (err) {
    assert.ok(err instanceof MixerRewriteError, `expected a MixerRewriteError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the change to be refused');
};

test('bypass removes every call of the effect, duplicates and aliases included, and returns them as canonical calls', () => {
  const result = applyChange('d: s("bd").cutoff(500).crush(8).lpq(4).lpf(900)', 'label:d', { type: 'bypass-effect', effect: 'lpf' });
  assert.equal(result.code, 'd: s("bd").crush(8)');
  assert.deepEqual(result.removed, [
    { method: 'lpf', value: 500 },
    { method: 'lpq', value: 4 },
    { method: 'lpf', value: 900 },
  ]);
});

test('bypass returns the compressor as one call with its fields, and a vowel as its listed string', () => {
  const compressor = applyChange('d: s("bd").compressor("-20:4").gain(0.5)', 'label:d', { type: 'bypass-effect', effect: 'compressor' });
  assert.equal(compressor.code, 'd: s("bd").gain(0.5)');
  assert.deepEqual(compressor.removed, [{ method: 'compressor', fields: [-20, 4] }]);
  const vowel = applyChange('d: s("bd").vowel("ae")', 'label:d', { type: 'bypass-effect', effect: 'vowel' });
  assert.deepEqual(vowel.removed, [{ method: 'vowel', value: 'ae' }]);
  const tremolo = applyChange('d: s("bd").tremolo(6).tremolodepth(0.5).tremoloshape("saw")', 'label:d', { type: 'bypass-effect', effect: 'tremolo' });
  assert.equal(tremolo.code, 'd: s("bd")');
  assert.deepEqual(tremolo.removed, [
    { method: 'tremolo', value: 6 },
    { method: 'tremolodepth', value: 0.5 },
    { method: 'tremoloshape', value: 'saw' },
  ]);
});

test('bypass is refused for a call whose value moves, with the fixed-values sentence', () => {
  for (const code of [
    'd: s("bd").lpf(sine.range(400, 2000))',
    'd: s("bd").lpf("<300 500>")',
    'd: s("bd").lpf("300:4")',
    'd: s("bd").lpf(300).lpq(perlin)',
    'd: s("bd").vowel("<a e>")',
    'd: s("bd").compressor("<-20 -10>")',
  ]) {
    const effect = code.includes('vowel') ? 'vowel' : code.includes('compressor') ? 'compressor' : 'lpf';
    const err = refused(code, 'label:d', { type: 'bypass-effect', effect });
    assert.equal(err.reason, 'unsupported-change', code);
    assert.ok(err.message.endsWith(BYPASS_NEEDS_FIXED), err.message);
  }
});

test('the read says whether an effect can be bypassed', () => {
  const effects = effectsOf('d: s("bd").lpf(300).crush(sine)', 'label:d');
  assert.equal(effects.get('lpf').bypassable, true);
  assert.equal(effects.get('crush').bypassable, false);
  assert.equal(effectsOf('d: s("bd").lpf(50000)', 'label:d').get('lpf').bypassable, false);
});

test('bypass is refused for an effect the track does not have, and for a value outside the registry range', () => {
  assert.equal(refused('d: s("bd")', 'label:d', { type: 'bypass-effect', effect: 'lpf' }).reason, 'unsupported-change');
  assert.equal(refused('d: s("bd").lpf(50000)', 'label:d', { type: 'bypass-effect', effect: 'lpf' }).reason, 'unsupported-change');
});

test('restore writes the stored calls in canonical form, in chain order', () => {
  const calls = [{ method: 'lpf', value: 800 }, { method: 'lpq', value: 4 }];
  assert.equal(applyChange('d: s("bd").gain(0)', 'label:d', { type: 'restore-effect', effect: 'lpf', calls }).code, 'd: s("bd").gain(0).lpf(800).lpq(4)');
  assert.equal(applyChange('d: s("bd").crush(8)', 'label:d', { type: 'restore-effect', effect: 'lpf', calls }).code, 'd: s("bd").lpf(800).lpq(4).crush(8)');
  const compressor = [{ method: 'compressor', fields: [-20, 4] }];
  assert.equal(applyChange('d: s("bd").pan(0.2)', 'label:d', { type: 'restore-effect', effect: 'compressor', calls: compressor }).code, 'd: s("bd").compressor("-20:4").pan(0.2)');
  assert.equal(applyChange('d: s("bd")', 'label:d', { type: 'restore-effect', effect: 'vowel', calls: [{ method: 'vowel', value: 'oe' }] }).code, 'd: s("bd").vowel("oe")');
});

test('bypass then restore gives back the same sound: the same text for a one-line chain', () => {
  const code = 'drums: s("bd*4").gain(0).lpf(800).lpq(4)';
  const off = applyChange(code, 'label:drums', { type: 'bypass-effect', effect: 'lpf' });
  assert.equal(off.code, 'drums: s("bd*4").gain(0)');
  const on = applyChange(off.code, 'label:drums', { type: 'restore-effect', effect: 'lpf', calls: off.removed });
  assert.equal(on.code, code);
});

test('bypass then restore on a chain over several lines keeps every other line', () => {
  const code = 'drums: s("bd*4")\n  .lpf(800) // darker\n  .crush(8)\n  .gain(0.5)\n';
  const off = applyChange(code, 'label:drums', { type: 'bypass-effect', effect: 'lpf' });
  assert.equal(off.code, 'drums: s("bd*4")\n  .crush(8)\n  .gain(0.5)\n');
  const on = applyChange(off.code, 'label:drums', { type: 'restore-effect', effect: 'lpf', calls: off.removed });
  assert.equal(on.code, 'drums: s("bd*4")\n  .lpf(800)\n  .crush(8)\n  .gain(0.5)\n');
});

test('restore validates every stored call again and never writes anything else', () => {
  const evil = [
    { method: 'lpf', value: '800); evil(' },
    { method: 'lpf', value: 999999 },
    { method: 'crush', value: 4 },
    { method: 'lpf', value: Number.NaN },
    { method: 'constructor', value: 1 },
  ];
  for (const call of evil) {
    assert.equal(refused('d: s("bd")', 'label:d', { type: 'restore-effect', effect: 'lpf', calls: [call] }).reason, 'unsupported-change', JSON.stringify(call));
  }
  for (const calls of [undefined, [], 'x', [{ method: 'lpf', value: 800 }, null]]) {
    assert.equal(refused('d: s("bd")', 'label:d', { type: 'restore-effect', effect: 'lpf', calls }).reason, 'unsupported-change');
  }
  assert.equal(refused('d: s("bd")', 'label:d', { type: 'restore-effect', effect: 'vowel', calls: [{ method: 'vowel', value: 'zz' }] }).reason, 'unsupported-change');
});

test('restore is refused when the code already has the effect (the code wins)', () => {
  const err = refused('d: s("bd").lpf(300)', 'label:d', { type: 'restore-effect', effect: 'lpf', calls: [{ method: 'lpf', value: 800 }] });
  assert.equal(err.reason, 'unsupported-change');
});

test('remove deletes every call and stores nothing', () => {
  const result = applyChange('d: s("bd").lpf(sine).cutoff(300).crush(8)', 'label:d', { type: 'remove-effect', effect: 'lpf' });
  assert.equal(result.code, 'd: s("bd").crush(8)');
  assert.equal(result.removed, undefined);
  assert.equal(refused('d: s("bd")', 'label:d', { type: 'remove-effect', effect: 'lpf' }).reason, 'unsupported-change');
});

test('bypass, restore and remove keep a $ and branch track identity', () => {
  for (const effect of ['vowel', 'compressor', 'tremolo']) {
    const code = '$: s("hh")\n$: s("bd")';
    const identity = extractTracks(code, { parse })[0].identity;
    const added = addEffect(code, identity, effect);
    const off = applyChange(added, identity, { type: 'bypass-effect', effect });
    assert.equal(off.code, code, effect);
    const on = applyChange(off.code, identity, { type: 'restore-effect', effect, calls: off.removed });
    assert.equal(extractTracks(on.code, { parse })[0].identity, identity, effect);
  }
});

// --- Parameters ---

const drumsChange = (code, spec, identity = 'label:drums') => writeTrack(code, identity, { identity, ...spec }, { parse }).code;
const param = (code, effect, name, value) => drumsChange(code, { type: 'param', effect, param: name, value });
const toDefault = (code, effect, name) => drumsChange(code, { type: 'param-default', effect, param: name });
const toFixed = (code, effect, name) => drumsChange(code, { type: 'param-fixed', effect, param: name });
const refusedFn = (fn) => assert.throws(fn, (err) => err instanceof MixerRewriteError && /^Moontide: /.test(err.message));

test('an unwritten parameter gets its own call right after the effect, and nothing else changes', () => {
  assert.equal(param('drums: s("bd*4").gain(0).lpf(1200)', 'lpf', 'resonance', 4), 'drums: s("bd*4").gain(0).lpf(1200).lpq(4)');
  assert.equal(param('drums: s("bd").lpf(1200).gain(0.5).pan(0.3)', 'lpf', 'resonance', 4), 'drums: s("bd").lpf(1200).lpq(4).gain(0.5).pan(0.3)');
});

test('a written parameter is edited in place, clamped and rounded by the registry', () => {
  assert.equal(param('drums: s("bd").lpf(1200).lpq(4)', 'lpf', 'cutoff', 800), 'drums: s("bd").lpf(800).lpq(4)');
  assert.equal(param('drums: s("bd").lpf(1200)', 'lpf', 'cutoff', 1234), 'drums: s("bd").lpf(1230)');
  assert.equal(param('drums: s("bd").lpf(1200)', 'lpf', 'cutoff', 5), 'drums: s("bd").lpf(20)');
  assert.equal(param('drums: s("bd").lpf(1200)', 'lpf', 'cutoff', 99999), 'drums: s("bd").lpf(20000)');
  assert.equal(param('drums: s("bd").cutoff(1200).resonance(2)', 'lpf', 'resonance', 3.2), 'drums: s("bd").cutoff(1200).resonance(3)');
});

test('writing the value the code holds returns identical code, and a trailing comment stays', () => {
  const code = 'drums: s("bd").lpf(1200) // warm';
  const result = writeTrack(code, 'label:drums', { identity: 'label:drums', type: 'param', effect: 'lpf', param: 'cutoff', value: 1200 }, { parse });
  assert.equal(result.code, code);
  assert.deepEqual(result.edits, []);
  assert.equal(param(code, 'lpf', 'resonance', 2), 'drums: s("bd").lpf(1200).lpq(2) // warm');
});

test('a chain over several lines gets the new call on its own indented line', () => {
  const code = 'drums: s("bd")\n  .lpf(1200) // warm\n  .gain(0.5)';
  assert.equal(param(code, 'lpf', 'resonance', 4), 'drums: s("bd")\n  .lpf(1200) // warm\n  .lpq(4)\n  .gain(0.5)');
});

test('the parameter of a stack branch and of a track without a label is written in its own track', () => {
  const stacked = 'stack(s("bd").lpf(300), s("hh"))';
  const [branch] = extractTracks(stacked, { parse });
  assert.equal(writeTrack(stacked, branch.identity, { identity: branch.identity, type: 'param', effect: 'lpf', param: 'resonance', value: 5 }, { parse }).code, 'stack(s("bd").lpf(300).lpq(5), s("hh"))');
  const bare = 's("bd").lpf(300)';
  const [only] = extractTracks(bare, { parse });
  assert.equal(writeTrack(bare, only.identity, { identity: only.identity, type: 'param', effect: 'lpf', param: 'cutoff', value: 500 }, { parse }).code, 's("bd").lpf(500)');
});

test('a parameter that moves in the code is refused for a value and offered a fixed value', () => {
  refusedFn(() => param('drums: s("bd").lpf(sine.range(400, 2000))', 'lpf', 'cutoff', 800));
  assert.equal(toFixed('drums: s("bd").lpf(sine.range(400, 2000))', 'lpf', 'cutoff'), 'drums: s("bd").lpf(2000)');
  assert.equal(toFixed('drums: s("bd").lpf(1200).lpq(sine.range(1, 8))', 'lpf', 'resonance'), 'drums: s("bd").lpf(1200).lpq(1)');
  assert.equal(toFixed('drums: s("bd").crush(sine.range(4, 12))', 'crush', 'bits'), 'drums: s("bd").crush(8)');
  refusedFn(() => toFixed('drums: s("bd").lpf(1200)', 'lpf', 'cutoff'));
});

test('a packed string is never replaced whole: the fixed value is a call of its own that keeps the other keys', () => {
  assert.equal(toFixed('drums: s("bd").lpf("1000:10")', 'lpf', 'cutoff'), 'drums: s("bd").lpf("1000:10").lpf(2000)');
  assert.equal(toFixed('drums: s("bd").distort("2:0.5")', 'distort', 'amount'), 'drums: s("bd").distort("2:0.5").distort(1)');
  assert.equal(toFixed('drums: s("bd").lpf("1000:10")', 'lpf', 'resonance'), 'drums: s("bd").lpf("1000:10").lpq(1)');
});

test('a vowel is written only from its fifteen options, as a JSON string', () => {
  assert.equal(param('drums: s("bd").vowel("a")', 'vowel', 'vowel', 'o'), 'drums: s("bd").vowel("o")');
  assert.equal(param("drums: s('bd').vowel('a')", 'vowel', 'vowel', 'uh'), 'drums: s(\'bd\').vowel("uh")');
  for (const bad of ['x', '"); hush(); ("', '', 7, null, undefined, ['a']]) refusedFn(() => param('drums: s("bd").vowel("a")', 'vowel', 'vowel', bad));
  assert.equal(toFixed('drums: s("bd").vowel("a e")', 'vowel', 'vowel'), 'drums: s("bd").vowel("a")');
});

test('the tremolo shape is written from its five options after the speed, and Default removes it again', () => {
  const written = param('drums: s("bd").tremolosync(4)', 'tremolo', 'shape', 'saw');
  assert.equal(written, 'drums: s("bd").tremolosync(4).tremoloshape("saw")');
  assert.equal(param(written, 'tremolo', 'shape', 'square'), 'drums: s("bd").tremolosync(4).tremoloshape("square")');
  refusedFn(() => param(written, 'tremolo', 'shape', 'triangle'));
  assert.equal(toDefault(written, 'tremolo', 'shape'), 'drums: s("bd").tremolosync(4)');
});

test('the per-cycle tremolo speed wins over the Hz form, as it does in Strudel, whatever the order', () => {
  const both = 'drums: s("bd").tremolosync(2).tremolo(4)';
  const read = readProgram(both, { parse }).reads.get('label:drums').effects.get('tremolo').params.speed;
  assert.deepEqual([read.kind, read.value, read.method], ['fixed', 2, 'tremolosync']);
  assert.equal(param(both, 'tremolo', 'speed', 3), 'drums: s("bd").tremolosync(3).tremolo(4)');
  // Last call wins only inside one form.
  assert.equal(param('drums: s("bd").tremolo(4).tremolosync(2)', 'tremolo', 'speed', 3), 'drums: s("bd").tremolo(4).tremolosync(3)');
  assert.equal(param('drums: s("bd").tremolo(2).tremolo(4)', 'tremolo', 'speed', 8), 'drums: s("bd").tremolo(2).tremolo(8)');
});

test('the tremolo speed edits the form the code wrote last, and a new speed writes tremolosync', () => {
  assert.equal(param('drums: s("bd").tremolo(4)', 'tremolo', 'speed', 8), 'drums: s("bd").tremolo(8)');
  assert.equal(param('drums: s("bd").tremolo(4)', 'tremolo', 'speed', 100), 'drums: s("bd").tremolo(32)');
  assert.equal(param('drums: s("bd").tremolosync(2)', 'tremolo', 'speed', 3), 'drums: s("bd").tremolosync(3)');
  assert.equal(param('drums: s("bd").tremolosync(2)', 'tremolo', 'speed', 100), 'drums: s("bd").tremolosync(16)');
  assert.equal(param('drums: s("bd").tremolo(4).tremolosync(2)', 'tremolo', 'speed', 3), 'drums: s("bd").tremolo(4).tremolosync(3)');
  assert.equal(param('drums: s("bd").tremolosync(2).tremolo(4)', 'tremolo', 'speed', 6), 'drums: s("bd").tremolosync(6).tremolo(4)');
  assert.equal(param('drums: s("bd").tremolodepth(0.5)', 'tremolo', 'speed', 3), 'drums: s("bd").tremolodepth(0.5).tremolosync(3)');
});

test('the compressor is one string holding the fields up to the last one written', () => {
  assert.equal(param('drums: s("bd").compressor("-20:4")', 'compressor', 'knee', 6), 'drums: s("bd").compressor("-20:4:6")');
  assert.equal(param('drums: s("bd").compressor("-20:4")', 'compressor', 'threshold', -30), 'drums: s("bd").compressor("-30:4")');
  assert.equal(param('drums: s("bd").compressor("-30")', 'compressor', 'threshold', -20), 'drums: s("bd").compressor("-20")');
  assert.equal(param('drums: s("bd").compressor(-20)', 'compressor', 'threshold', -10), 'drums: s("bd").compressor(-10)');
  assert.equal(param('drums: s("bd").compressor(-20)', 'compressor', 'ratio', 4), 'drums: s("bd").compressor("-20:4")');
  // A field further out fills the earlier unwritten fields with Strudel's defaults.
  assert.equal(param('drums: s("bd").compressor(-20)', 'compressor', 'attack', 0.001), 'drums: s("bd").compressor("-20:10:10:0.001")');
  assert.equal(param('drums: s("bd").compressor("-20:4")', 'compressor', 'release', 0.5), 'drums: s("bd").compressor("-20:4:10:0.005:0.5")');
  assert.equal(param('drums: s("bd").compressor("-20:4")', 'compressor', 'ratio', 4), 'drums: s("bd").compressor("-20:4")');
  refusedFn(() => param('drums: s("bd").compressor(sine.range(-30, -10))', 'compressor', 'ratio', 4));
});

test('Default on a compressor field written by an earlier call folds every call into the last one', () => {
  assert.equal(toDefault('drums: s("bd").compressor("-20:4").compressor(-30)', 'compressor', 'ratio'), 'drums: s("bd").compressor(-30)');
  assert.equal(toDefault('drums: s("bd").compressor("-20:4:6").compressor(-30)', 'compressor', 'ratio'), 'drums: s("bd").compressor("-30:10:6")');
  assert.equal(toDefault('drums: s("bd")\n  .compressor("-20:4")\n  .pan(0.3)\n  .compressor(-30)', 'compressor', 'ratio'), 'drums: s("bd")\n  .pan(0.3)\n  .compressor(-30)');
});

test('Default gives a written extra parameter back to Strudel, and the compressor string shortens or fills', () => {
  assert.equal(toDefault('drums: s("bd").lpf(1200).lpq(4)', 'lpf', 'resonance'), 'drums: s("bd").lpf(1200)');
  assert.equal(toDefault('drums: s("bd").lpf(1200).lpq(4).resonance(2).gain(0.5)', 'lpf', 'resonance'), 'drums: s("bd").lpf(1200).gain(0.5)');
  assert.equal(toDefault('drums: s("bd").lpf(1200)', 'lpf', 'resonance'), 'drums: s("bd").lpf(1200)');
  assert.equal(toDefault('drums: s("bd").compressor("-20:4:6")', 'compressor', 'knee'), 'drums: s("bd").compressor("-20:4")');
  assert.equal(toDefault('drums: s("bd").compressor("-20:4")', 'compressor', 'ratio'), 'drums: s("bd").compressor("-20")');
  assert.equal(toDefault('drums: s("bd").compressor("-20:4:6")', 'compressor', 'ratio'), 'drums: s("bd").compressor("-20:10:6")');
  refusedFn(() => toDefault('drums: s("bd").lpf(1200)', 'lpf', 'cutoff'));
  refusedFn(() => toDefault('drums: s("bd").compressor("-20:4")', 'compressor', 'threshold'));
  refusedFn(() => toDefault('drums: s("bd").lpf(1200).lpq(sine.range(1, 8))', 'lpf', 'resonance'));
});

test('a moving compressor becomes "-20:4"', () => {
  assert.equal(toFixed('drums: s("bd").compressor(sine.range(-30, -10))', 'compressor', 'threshold'), 'drums: s("bd").compressor("-20:4")');
  refusedFn(() => toFixed('drums: s("bd").compressor("-20:4")', 'compressor', 'ratio'));
});

test('only a finite number, clamped to the registry range, is ever written for a number parameter', () => {
  const code = 'drums: s("bd").lpf(1200)';
  for (const bad of [Number.NaN, Infinity, -Infinity, '800', '800); hush(', null, undefined, {}, [800]]) {
    refusedFn(() => param(code, 'lpf', 'cutoff', bad));
  }
  refusedFn(() => param(code, 'lpf', 'unknown', 1));
  refusedFn(() => param(code, 'nope', 'cutoff', 1));
  refusedFn(() => param(code, 'hpf', 'cutoff', 300));
});

test('adding or editing one parameter leaves every other call of the chain byte for byte', () => {
  const code = 'drums: s("bd*4").fast( 2 ).gain(.8).lpf(1200).pan(sine)\n  .crush( 8 ) // keep';
  assert.equal(param(code, 'lpf', 'cutoff', 900), code.replace('lpf(1200)', 'lpf(900)'));
  assert.equal(param(code, 'crush', 'bits', 6), code.replace('( 8 )', '( 6 )'));
  assert.equal(toDefault(param(code, 'lpf', 'resonance', 2), 'lpf', 'resonance'), code);
});

test('Remove takes every call of an effect out, and asks for a track that has it', () => {
  assert.equal(drumsChange('drums: s("bd").lpf(1200).lpq(4).gain(0.5)', { type: 'remove-effect', effect: 'lpf' }), 'drums: s("bd").gain(0.5)');
  assert.equal(drumsChange('drums: s("bd")\n  .lpf(1200)\n  .cutoff(300)\n  .resonance(2)\n  .gain(0.5)', { type: 'remove-effect', effect: 'lpf' }), 'drums: s("bd")\n  .gain(0.5)');
  refusedFn(() => drumsChange('drums: s("bd")', { type: 'remove-effect', effect: 'lpf' }));
});

// --- Filter moves ---

const move = (code, effect, spec, name = 'cutoff') => drumsChange(code, { type: 'filter-move', effect, param: name, move: spec });
const cutoffRead = (code, effect = 'lpf', param = 'cutoff') => readProgram(code, { parse }).reads.get('label:drums').effects.get(effect).params[param];

test('a fixed cutoff becomes shape.range(from, to).slow(N) on the three filters', () => {
  assert.equal(move('drums: s("bd*4").gain(0).lpf(1000)', 'lpf', { shape: 'sine', from: 500, to: 2000, over: 8 }), 'drums: s("bd*4").gain(0).lpf(sine.range(500, 2000).slow(8))');
  assert.equal(move('drums: s("bd").hpf(300)', 'hpf', { shape: 'saw', from: 100, to: 3000, over: 16 }), 'drums: s("bd").hpf(saw.range(100, 3000).slow(16))');
  assert.equal(move('drums: s("bd").bpf(1000)', 'bpf', { shape: 'tri', from: 500, to: 2000, over: 4 }, 'center'), 'drums: s("bd").bpf(tri.range(500, 2000).slow(4))');
});

test('a move Claude wrote is read as a move, and a change of one field replaces the whole expression', () => {
  const code = 'drums: s("bd").lpf(sine.range(400, 2000).slow(8)).gain(0.5)';
  assert.deepEqual(cutoffRead(code), { kind: 'move', value: null, method: 'lpf', move: { shape: 'sine', from: 400, to: 2000, over: 8 } });
  assert.equal(move(code, 'lpf', { shape: 'sine', from: 400, to: 2000, over: 16 }), 'drums: s("bd").lpf(sine.range(400, 2000).slow(16)).gain(0.5)');
  assert.equal(move(code, 'lpf', { shape: 'sine', from: 400, to: 2000, over: 8 }), code);
  assert.equal(param(code, 'lpf', 'cutoff', 1200), 'drums: s("bd").lpf(1200).gain(0.5)');
});

test('a cutoff that is not written yet gets its move after the effect', () => {
  assert.equal(move('drums: s("bd").lpq(4).gain(0.5)', 'lpf', { shape: 'sine', from: 500, to: 2000, over: 8 }), 'drums: s("bd").lpq(4).lpf(sine.range(500, 2000).slow(8)).gain(0.5)');
});

test('a move outside the shapes, the range or the whole cycles is refused; a pattern the mixer does not read is never overwritten', () => {
  const code = 'drums: s("bd").lpf(1000)';
  refusedFn(() => move(code, 'lpf', { shape: 'square', from: 500, to: 2000, over: 8 }));
  refusedFn(() => move(code, 'lpf', { shape: 'sine', from: Number.NaN, to: 2000, over: 8 }));
  refusedFn(() => move(code, 'lpf', { shape: 'sine', from: 500, to: 2000, over: 0 }));
  refusedFn(() => move(code, 'lpf', { shape: 'sine', from: 500, to: 2000, over: 65 }));
  refusedFn(() => move(code, 'lpf', { shape: 'sine', from: 500, to: 2000, over: 2.5 }));
  refusedFn(() => move(code, 'lpf', null));
  refusedFn(() => move(code, 'lpf', { shape: 'sine', from: 500, to: 2000, over: 8 }, 'resonance'));
  refusedFn(() => move('drums: s("bd").lpf(perlin.range(300, 3000))', 'lpf', { shape: 'sine', from: 500, to: 2000, over: 8 }));
  assert.equal(move(code, 'lpf', { shape: 'sine', from: 5, to: 90000, over: 8 }), 'drums: s("bd").lpf(sine.range(20, 20000).slow(8))');
  assert.equal(move(code, 'lpf', { shape: 'sine', from: 2000, to: 400, over: 8 }), 'drums: s("bd").lpf(sine.range(2000, 400).slow(8))');
});

test('only sine, tri and saw .range(a, b).slow(N) with plain numbers in range and N a whole number 1 to 64 read as a move', () => {
  const moves = [
    ['sine.range(400, 2000).slow(8)', { shape: 'sine', from: 400, to: 2000, over: 8 }],
    ['tri.range(2000, 400).slow(1)', { shape: 'tri', from: 2000, to: 400, over: 1 }],
    ['saw.range(20, 20000).slow(64)', { shape: 'saw', from: 20, to: 20000, over: 64 }],
    ['sine.range(400,2000).slow(8)', { shape: 'sine', from: 400, to: 2000, over: 8 }],
  ];
  for (const [text, expected] of moves) {
    const read = cutoffRead(`drums: s("bd").lpf(${text})`);
    assert.equal(read.kind, 'move', text);
    assert.deepEqual(read.move, expected, text);
  }
  const others = [
    'perlin.range(400, 2000).slow(8)',
    'cosine.range(400, 2000).slow(8)',
    'isaw.range(400, 2000).slow(8)',
    'sine.range(400, 2000)',
    'sine.slow(8)',
    'sine.range(400, 2000).slow(0.5)',
    'sine.range(400, 2000).slow(0)',
    'sine.range(400, 2000).slow(65)',
    'sine.range(400, 2000).slow(-8)',
    'sine.range(400, 2000).slow("8")',
    'sine.range(400, 2000).slow(n)',
    'sine.range(a, 2000).slow(8)',
    'sine.range(400, 30000).slow(8)',
    'sine.range(10, 2000).slow(8)',
    'sine.range(400, 2000, 1).slow(8)',
    'sine.range(400).slow(8)',
    'sine.segment(4).range(400, 2000).slow(8)',
    'sine.range(400, 2000).slow(8).fast(2)',
    'sine.range(400, 2000).slow(8, 2)',
    'sine.range(400, 2000).slow(8).add(10)',
    'sine.range(400, 2000).slow(8)?.x',
    'sine2.range(400, 2000).slow(8)',
    'x.range(400, 2000).slow(8)',
    '"<300 500>"',
  ];
  for (const text of others) {
    assert.equal(cutoffRead(`drums: s("bd").lpf(${text})`).kind, 'pattern', text);
  }
  // A program that declares its own sine is not the signal: it is left alone.
  assert.equal(cutoffRead('const sine = tri\ndrums: s("bd").lpf(sine.range(400, 2000).slow(8))').kind, 'pattern');
  // Only a filter's cutoff can be a move: any other parameter stays a pattern.
  assert.equal(cutoffRead('drums: s("bd").lpf(1000).lpq(sine.range(1, 8).slow(8))', 'lpf', 'resonance').kind, 'pattern');
  assert.equal(cutoffRead('drums: s("bd").crush(sine.range(4, 8).slow(8))', 'crush', 'bits').kind, 'pattern');
  // hpf and bpf read too, and the last writer wins.
  assert.equal(cutoffRead('drums: s("bd").hpf(saw.range(100, 3000).slow(4))', 'hpf').kind, 'move');
  assert.equal(cutoffRead('drums: s("bd").bpf(tri.range(500, 2000).slow(4))', 'bpf', 'center').kind, 'move');
  assert.equal(cutoffRead('drums: s("bd").lpf(sine.range(400, 2000).slow(8)).lpf(1000)').kind, 'fixed');
});

test('a move is bypassed as its shape and three numbers and restored to the same text; any other pattern still disables bypass', () => {
  const code = 'drums: s("bd*4").gain(0).lpf(sine.range(400, 2000).slow(8))';
  const off = applyChange(code, 'label:drums', { type: 'bypass-effect', effect: 'lpf' });
  assert.equal(off.code, 'drums: s("bd*4").gain(0)');
  assert.deepEqual(off.removed, [{ method: 'lpf', move: { shape: 'sine', from: 400, to: 2000, over: 8 } }]);
  assert.equal(applyChange(off.code, 'label:drums', { type: 'restore-effect', effect: 'lpf', calls: off.removed }).code, code);
  assert.equal(effectsOf(code, 'label:drums').get('lpf').bypassable, true);
  // A move next to a fixed resonance is stored and restored together, in order.
  const both = 'drums: s("bd*4").gain(0).lpf(tri.range(2000, 400).slow(16)).lpq(4)';
  const bothOff = applyChange(both, 'label:drums', { type: 'bypass-effect', effect: 'lpf' });
  assert.deepEqual(bothOff.removed, [{ method: 'lpf', move: { shape: 'tri', from: 2000, to: 400, over: 16 } }, { method: 'lpq', value: 4 }]);
  assert.equal(applyChange(bothOff.code, 'label:drums', { type: 'restore-effect', effect: 'lpf', calls: bothOff.removed }).code, both);
  for (const other of ['perlin.range(400, 2000).slow(8)', 'sine.range(400, 2000)', 'sine.range(400, 2000).slow(0.5)']) {
    const err = refused(`drums: s("bd").lpf(${other})`, 'label:drums', { type: 'bypass-effect', effect: 'lpf' });
    assert.equal(err.reason, 'unsupported-change', other);
    assert.ok(err.message.endsWith(BYPASS_NEEDS_FIXED), err.message);
  }
});

test('restore refuses a stored move outside the shapes, the range or the whole cycles', () => {
  for (const move of [
    { shape: 'square', from: 400, to: 2000, over: 8 },
    { shape: 'sine', from: 400, to: 2000, over: 65 },
    { shape: 'sine', from: 400, to: 2000, over: 2.5 },
    { shape: 'sine', from: 5, to: 2000, over: 8 },
    { shape: 'sine', from: 400, to: 'x', over: 8 },
  ]) {
    const err = refused('drums: s("bd")', 'label:drums', { type: 'restore-effect', effect: 'lpf', calls: [{ method: 'lpf', move }] });
    assert.equal(err.reason, 'unsupported-change', JSON.stringify(move));
  }
});

// --- Sends and buses ---

const sendChange = (code, identity, bus, value, busParams) => applyChange(code, identity, { type: 'send', bus, value, ...(busParams ? { busParams } : {}) }).code;
const busOf = (code, identity = 'label:drums') => readProgram(code, { parse }).reads.get(identity).bus;

test('a track reads its orbit, its sends and the bus values it writes', () => {
  const plain = busOf('drums: s("bd")');
  assert.deepEqual(plain.orbit, { kind: 'unwritten', value: 1 });
  assert.deepEqual(plain.sends.reverb, { kind: 'unwritten', value: null });
  assert.deepEqual(plain.sends.delay, { kind: 'unwritten', value: null });
  const read = busOf('drums: s("bd").orbit(2).room(0.3).roomsize(4).delay(0.2).delayfeedback(0.4)');
  assert.deepEqual(read.orbit, { kind: 'fixed', value: 2 });
  assert.deepEqual(read.sends.reverb, { kind: 'fixed', value: 0.3 });
  assert.deepEqual(read.sends.delay, { kind: 'fixed', value: 0.2 });
  assert.deepEqual(read.busParams.reverb.size, { kind: 'fixed', value: 4 });
  assert.deepEqual(read.busParams.delay.feedback, { kind: 'fixed', value: 0.4 });
  assert.deepEqual(read.busParams.delay.time, { kind: 'unwritten', value: null });
});

test('an alias writes the same send or value, the last writer wins, and a pattern or a packed string moves', () => {
  assert.deepEqual(busOf('drums: s("bd").room(0.3).o(3).size(4).room(0.5)').sends.reverb, { kind: 'fixed', value: 0.5 });
  assert.deepEqual(busOf('drums: s("bd").o(3)').orbit, { kind: 'fixed', value: 3 });
  assert.deepEqual(busOf('drums: s("bd").size(4)').busParams.reverb.size, { kind: 'fixed', value: 4 });
  assert.equal(busOf('drums: s("bd").room("<0.2 0.5>")').sends.reverb.kind, 'pattern');
  assert.equal(busOf('drums: s("bd").room(sine.range(0, 0.4))').sends.reverb.kind, 'pattern');
  assert.equal(busOf('drums: s("bd").delay("0.5:0.25")').sends.delay.kind, 'pattern');
  assert.equal(busOf('drums: s("bd").orbit("<1 2>")').orbit.kind, 'pattern');
});

test('a send above 0 is added at the end of the chain, or edited in place', () => {
  assert.equal(sendChange('drums: s("bd*4").gain(0)', 'label:drums', 'reverb', 0.3), 'drums: s("bd*4").gain(0).room(0.3)');
  assert.equal(sendChange('drums: s("bd*4").gain(0)', 'label:drums', 'delay', 0.25), 'drums: s("bd*4").gain(0).delay(0.25)');
  assert.equal(sendChange('drums: s("bd").room(0.3).gain(0.5)', 'label:drums', 'reverb', 0.6), 'drums: s("bd").room(0.6).gain(0.5)');
  assert.equal(sendChange('drums: s("bd").room(.3)', 'label:drums', 'reverb', 0.3), 'drums: s("bd").room(.3)');
});

test('a track that starts sending takes the bus values directly after the send', () => {
  assert.equal(sendChange('drums: s("bd").gain(0)', 'label:drums', 'reverb', 0.3, { size: 4 }), 'drums: s("bd").gain(0).room(0.3).roomsize(4)');
  assert.equal(sendChange('drums: s("bd").gain(0)', 'label:drums', 'reverb', 0.3, { size: 4, damping: 500 }), 'drums: s("bd").gain(0).room(0.3).roomsize(4).roomdim(500)');
  assert.equal(sendChange('drums: s("bd")', 'label:drums', 'delay', 0.2, { time: 0.3, feedback: 0.4 }), 'drums: s("bd").delay(0.2).delaytime(0.3).delayfeedback(0.4)');
  // A value the track already writes is not written twice, and a send written as 0 that starts sending joins too.
  assert.equal(sendChange('drums: s("bd").roomsize(2)', 'label:drums', 'reverb', 0.3, { size: 4, fade: 1 }), 'drums: s("bd").roomsize(2).room(0.3).roomfade(1)');
  assert.equal(sendChange('drums: s("bd").room(0).gain(0.5)', 'label:drums', 'reverb', 0.3, { size: 4 }), 'drums: s("bd").room(0.3).roomsize(4).gain(0.5)');
  // A track already sending keeps its own values: a change of the send never adds any.
  assert.equal(sendChange('drums: s("bd").room(0.3)', 'label:drums', 'reverb', 0.5, { size: 4 }), 'drums: s("bd").room(0.5)');
});

test('a send set back to exactly 0 leaves the code together with that bus values on this track', () => {
  assert.equal(sendChange('drums: s("bd").room(0.3).roomsize(4).gain(0.5)', 'label:drums', 'reverb', 0), 'drums: s("bd").gain(0.5)');
  assert.equal(sendChange('drums: s("bd").room(0.3).size(4).roomfade(1).delay(0.2).delayfeedback(0.4)', 'label:drums', 'reverb', 0), 'drums: s("bd").delay(0.2).delayfeedback(0.4)');
  assert.equal(sendChange('drums: s("bd").delay(0.2).delaytime(0.3).room(0.3)', 'label:drums', 'delay', 0), 'drums: s("bd").room(0.3)');
  // Rounded to the slider step, 0.004 is 0.
  assert.equal(sendChange('drums: s("bd").room(0.3)', 'label:drums', 'reverb', 0.004), 'drums: s("bd")');
  // Other tracks are never touched.
  const two = 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2).roomsize(4)';
  assert.equal(sendChange(two, 'label:hats', 'reverb', 0), 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh")');
});

test('a send the code already holds, or a send at 0 that is not there, returns the identical code', () => {
  for (const [code, bus, value] of [
    ['drums: s("bd").room(0.3)', 'reverb', 0.3],
    ['drums: s("bd")', 'reverb', 0],
    ['drums: s("bd").roomsize(4)', 'reverb', 0],
    ['drums: s("bd").delay(0.25)', 'delay', 0.25],
  ]) {
    const result = applyChange(code, 'label:drums', { type: 'send', bus, value });
    assert.equal(result.code, code);
    assert.deepEqual(result.edits, []);
  }
});

test('a send on a chain over several lines lands on its own lines and every other byte stays', () => {
  const code = 'drums: s("bd*4")\n  .gain(0.5) // kept\n  .lpf(800)';
  assert.equal(sendChange(code, 'label:drums', 'reverb', 0.3, { size: 4 }), 'drums: s("bd*4")\n  .gain(0.5) // kept\n  .lpf(800)\n  .room(0.3)\n  .roomsize(4)');
  const stack = 'stack(\n  s("bd").room(0.3).roomsize(4),\n  s("hh").gain(0.5),\n)';
  const id = extractTracks(stack, { parse })[1].identity;
  assert.equal(sendChange(stack, id, 'reverb', 0.2, { size: 4 }), 'stack(\n  s("bd").room(0.3).roomsize(4),\n  s("hh").gain(0.5).room(0.2).roomsize(4),\n)');
});

test('a send that moves in the code is refused, and so is a change outside the closed shapes', () => {
  for (const code of ['drums: s("bd").room("<0.2 0.5>")', 'drums: s("bd").room(sine.range(0, 0.4))']) {
    const err = refused(code, 'label:drums', { type: 'send', bus: 'reverb', value: 0.3 });
    assert.equal(err.reason, 'unsupported-change');
    assert.match(err.message, /moves in the code/);
  }
  const bad = [
    { type: 'send', bus: 'chorus', value: 0.3 },
    { type: 'send', bus: 'toString', value: 0.3 },
    { type: 'send', bus: 'reverb', value: 1.5 },
    { type: 'send', bus: 'reverb', value: -0.1 },
    { type: 'send', bus: 'reverb', value: Number.NaN },
    { type: 'send', bus: 'reverb', value: '0.3' },
    { type: 'send', bus: 'reverb', value: 0.3, busParams: { size: 'x' } },
    { type: 'send', bus: 'reverb', value: 0.3, busParams: { time: 0.3 } },
    { type: 'send', bus: 'reverb', value: 0.3, busParams: [4] },
  ];
  for (const change of bad) assert.equal(refused('drums: s("bd")', 'label:drums', change).reason, 'unsupported-change', JSON.stringify(change));
});

test('only clamped, rounded numbers reach the code for a send and its bus values', () => {
  assert.equal(sendChange('drums: s("bd")', 'label:drums', 'reverb', 0.3333, { size: 99, fade: -3 }), 'drums: s("bd").room(0.33).roomsize(10).roomfade(0)');
  assert.equal(sendChange('drums: s("bd")', 'label:drums', 'delay', 1, { time: 5, feedback: 2 }), 'drums: s("bd").delay(1).delaytime(1).delayfeedback(0.95)');
});

// --- Bus parameters on every sender ---

const bus = (code, spec) => writeBus(code, { type: 'bus-param', orbit: 1, ...spec }, { parse });
const busCode = (code, spec) => bus(code, spec).code;
const TWO_SENDERS = 'drums: s("bd").room(0.3)\nhats: s("hh").room(0.2)';

test('a bus parameter is written right after the send on every track that sends, in one edit list', () => {
  const result = bus(TWO_SENDERS, { bus: 'reverb', param: 'size', value: 4 });
  assert.equal(result.code, 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2).roomsize(4)');
  assert.equal(result.edits.length, 2);
  assert.equal(busCode('drums: s("bd").delay(0.3)\nhats: s("hh").delay(0.1)', { bus: 'delay', param: 'feedback', value: 0.4 }), 'drums: s("bd").delay(0.3).delayfeedback(0.4)\nhats: s("hh").delay(0.1).delayfeedback(0.4)');
});

test('a written bus value is edited in place, an alias too, and a new one follows the last bus value of the track', () => {
  assert.equal(busCode('drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").room(0.2)', { bus: 'reverb', param: 'size', value: 4 }), 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2).roomsize(4)');
  assert.equal(busCode('drums: s("bd").room(0.3).size(2)', { bus: 'reverb', param: 'size', value: 4 }), 'drums: s("bd").room(0.3).size(4)');
  assert.equal(busCode('drums: s("bd").room(0.3).roomsize(2).gain(0.5)', { bus: 'reverb', param: 'fade', value: 1 }), 'drums: s("bd").room(0.3).roomsize(2).roomfade(1).gain(0.5)');
  assert.equal(busCode('drums: s("bd").room(0.3).gain(0.5)', { bus: 'reverb', param: 'lowpass', value: 5000 }), 'drums: s("bd").room(0.3).roomlp(5000).gain(0.5)');
});

test('a track that does not send, or sends on another orbit, is never touched', () => {
  const code = 'drums: s("bd").room(0.3)\nbass: s("sd").roomsize(9)\nhats: s("hh").orbit(2).room(0.2)\nkeys: s("cp").room(0)';
  assert.equal(busCode(code, { bus: 'reverb', param: 'size', value: 4 }), 'drums: s("bd").room(0.3).roomsize(4)\nbass: s("sd").roomsize(9)\nhats: s("hh").orbit(2).room(0.2)\nkeys: s("cp").room(0)');
  assert.equal(writeBus(code, { type: 'bus-param', orbit: 2, bus: 'reverb', param: 'size', value: 4 }, { parse }).code, 'drums: s("bd").room(0.3)\nbass: s("sd").roomsize(9)\nhats: s("hh").orbit(2).room(0.2).roomsize(4)\nkeys: s("cp").room(0)');
  // The reverb and delay sends are different buses.
  assert.equal(busCode('drums: s("bd").room(0.3)\nhats: s("hh").delay(0.2)', { bus: 'delay', param: 'time', value: 0.3 }), 'drums: s("bd").room(0.3)\nhats: s("hh").delay(0.2).delaytime(0.3)');
});

test('a send that moves in the code still feeds the bus; a track the mixer cannot read never counts', () => {
  assert.equal(busCode('drums: s("bd").room("<0.2 0.5>")\nhats: s("hh").room(0.2)', { bus: 'reverb', param: 'size', value: 4 }), 'drums: s("bd").room("<0.2 0.5>").roomsize(4)\nhats: s("hh").room(0.2).roomsize(4)');
  assert.equal(busCode('const x = s("bd").room(0.3)\nbad: x\nhats: s("hh").room(0.2)', { bus: 'reverb', param: 'size', value: 4 }), 'const x = s("bd").room(0.3)\nbad: x\nhats: s("hh").room(0.2).roomsize(4)');
});

test('a bus value a sender writes as a pattern is refused for the whole change, and nothing is written', () => {
  const code = 'drums: s("bd").room(0.3).roomsize("<2 4>")\nhats: s("hh").room(0.2)';
  assert.throws(() => bus(code, { bus: 'reverb', param: 'size', value: 4 }), (err) => err instanceof MixerRewriteError && err.reason === 'unsupported-change' && /pattern/.test(err.message));
  // A different parameter of the same bus is still written everywhere.
  assert.equal(busCode(code, { bus: 'reverb', param: 'fade', value: 1 }), 'drums: s("bd").room(0.3).roomsize("<2 4>").roomfade(1)\nhats: s("hh").room(0.2).roomfade(1)');
});

test('writing the value every sender already holds leaves the code byte for byte and returns no edits', () => {
  const code = 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2).size(4.0)';
  const result = bus(code, { bus: 'reverb', param: 'size', value: 4 });
  assert.equal(result.code, code);
  assert.deepEqual(result.edits, []);
  const once = busCode(TWO_SENDERS, { bus: 'reverb', param: 'fade', value: 1 });
  assert.equal(busCode(once, { bus: 'reverb', param: 'fade', value: 1 }), once);
});

test('only clamped, rounded numbers of a listed bus parameter reach the code', () => {
  assert.equal(busCode('drums: s("bd").room(0.3)', { bus: 'reverb', param: 'size', value: 99 }), 'drums: s("bd").room(0.3).roomsize(10)');
  assert.equal(busCode('drums: s("bd").room(0.3)', { bus: 'reverb', param: 'lowpass', value: 12345.6 }), 'drums: s("bd").room(0.3).roomlp(12300)');
  assert.equal(busCode('drums: s("bd").delay(0.3)', { bus: 'delay', param: 'time', value: 5 }), 'drums: s("bd").delay(0.3).delaytime(1)');
  const bad = [
    { bus: 'reverb', param: 'time', value: 1 },
    { bus: 'chorus', param: 'size', value: 1 },
    { bus: 'reverb', param: 'size', value: Number.NaN },
    { bus: 'reverb', param: 'size', value: '4' },
    { bus: 'reverb', param: 'size', value: 4, orbit: undefined },
    { bus: 'reverb', param: 'size', value: 4, align: [1] },
    { bus: 'reverb', param: 'size', value: 4, align: { time: 1 } },
    { bus: 'reverb', param: 'size', value: 4, align: { fade: 'x' } },
  ];
  for (const spec of bad) {
    assert.throws(() => bus(TWO_SENDERS, spec), (err) => err instanceof MixerRewriteError && err.reason === 'unsupported-change', JSON.stringify(spec));
  }
  // No sender on that bus: nothing to write on, said loudly.
  assert.throws(() => bus('drums: s("bd")', { bus: 'reverb', param: 'size', value: 4 }), (err) => err instanceof MixerRewriteError && /no track sends/.test(err.message));
  assert.throws(() => writeBus(TWO_SENDERS, { type: 'send', bus: 'reverb', param: 'size', value: 4, orbit: 1 }, { parse }), MixerRewriteError);
});

test('a bus change with align sets the other parameters on every sender in the same edit list; null removes them', () => {
  const code = 'drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").room(0.2).roomsize(6)';
  assert.equal(busCode(code, { bus: 'reverb', param: 'fade', value: 1, align: { size: 2 } }), 'drums: s("bd").room(0.3).roomsize(2).roomfade(1)\nhats: s("hh").room(0.2).roomsize(2).roomfade(1)');
  // The changed parameter itself always takes the new value, whatever align says.
  assert.equal(busCode(code, { bus: 'reverb', param: 'size', value: 4, align: { size: 2 } }), 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2).roomsize(4)');
  const delay = 'drums: s("bd").delay(0.3).delaytime(0.2)\nhats: s("hh").delay(0.2)';
  assert.equal(busCode(delay, { bus: 'delay', param: 'feedback', value: 0.4, align: { time: null } }), 'drums: s("bd").delay(0.3).delayfeedback(0.4)\nhats: s("hh").delay(0.2).delayfeedback(0.4)');
});

test('a bus change on a chain over several lines puts new calls on their own lines after the send', () => {
  const code = 'drums: s("bd")\n  .room(0.3)\n  .gain(0.5)\nhats: s("hh").room(0.2)';
  assert.equal(busCode(code, { bus: 'reverb', param: 'size', value: 4 }), 'drums: s("bd")\n  .room(0.3)\n  .roomsize(4)\n  .gain(0.5)\nhats: s("hh").room(0.2).roomsize(4)');
});

test('a track that starts sending takes the bus values written by the last bus change', () => {
  const dropped = sendChange('drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2).roomsize(4)', 'label:hats', 'reverb', 0);
  assert.equal(dropped, 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh")');
  assert.equal(sendChange(dropped, 'label:hats', 'reverb', 0.25, { size: 4 }), 'drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.25).roomsize(4)');
});

// --- a track that plays MIDI never gets a post-gain: MIDI output ignores it ---

test('a track whose .midi() is on its own chain, nested, or in shared code reads as playing MIDI and is refused a post-gain', () => {
  const programs = [
    "lead: note(\"c e\").midi('Port A')",
    "lead: stack(note(\"c\").midi('Port A'), s(\"hh\"))",
    "const synth = note(\"c e\").midi('Port A')\nlead: synth",
    "const jx = (p) => p.midi('Port A')\nlead: jx(note(\"c e\"))",
    "const synth = note(\"c e\").midi('Port A')\nconst part = synth.fast(2)\nlead: part.lpf(300)",
  ];
  for (const code of programs) {
    assert.equal(readProgram(code, { parse }).reads.get('label:lead').playsMidi, true, code);
    const err = refusal(code, 'label:lead');
    assert.equal(err.reason, 'unsupported-change', code);
    assert.match(err.message, /plays MIDI, which ignores a post-gain/, code);
  }
});

test('a track that plays no MIDI, in its own code or the shared code it reads, is not marked as playing MIDI', () => {
  const code = "const synth = note(\"c e\").midi('Port A')\nconst beat = s(\"bd\")\ndrums: beat\nlead: synth";
  const { reads } = readProgram(code, { parse });
  assert.equal(reads.get('label:drums').playsMidi, false);
  assert.equal(reads.get('label:lead').playsMidi, true);
  assert.equal(write(code, 'label:drums', 0.5), code.replace('drums: beat', 'drums: beat.postgain(0.5)'));
});

test('a name that is only a method name, an object key or shadowed locally is not a reference to the shared code of that name', () => {
  const midi = "note(\"c\").midi('JX')";
  const collisions = [
    `const scale = ${midi}\nlead: n("0 2").scale("C:minor").s("piano")`,
    `const x = ${midi}\nlead: s("bd").sometimes(x => x.speed(2))`,
    `const lead = ${midi}\nlead: s("bd").set({ lead: 1 })`,
    `const x = ${midi}\nlead: s("bd").every(2, (x) => { const y = x.fast(2); return y })`,
    `const x = ${midi}\nlead: s("bd").every(2, ({ x }) => x.fast(2))`,
    `const x = ${midi}\nlead: s("bd").every(2, function (a, x = 1) { return a.fast(x) })`,
    `const x = ${midi}\nlead: s("bd").every(2, (a) => { let x = 2; return a.fast(x) })`,
    `const x = ${midi}\nlead: s("bd").every(2, (a) => { for (const x of [1, 2]) a.fast(x); return a })`,
    `const x = ${midi}\nlead: s("bd").every(2, (a) => { try { return a } catch (x) { return x } })`,
  ];
  for (const code of collisions) {
    const read = readProgram(code, { parse }).reads.get('label:lead');
    assert.equal(read.playsMidi, false, code);
    assert.equal(read.busHidden, false, code);
    // The track stays an editable browser track: the fader writes its post-gain.
    assert.equal(write(code, 'label:lead', 0.5), `${code}.postgain(0.5)`, code);
  }
});

test('a real reference still reaches the shared code: through a callback, a default, a shorthand, a computed key or a nested function', () => {
  const midi = "note(\"c\").midi('JX')";
  const reaching = [
    `const x = ${midi}\nlead: s("bd").every(2, (a) => a.stack(x))`,
    `const x = ${midi}\nlead: s("bd").every(2, (a, b = x) => a.stack(b))`,
    `const x = ${midi}\nlead: s("bd").set({ x })`,
    `const x = ${midi}\nlead: s("bd").set({ [x]: 1 })`,
    `const x = ${midi}\nlead: s("bd").every(2, (a) => { const f = () => a.stack(x); return f() })`,
    `const x = ${midi}\nlead: s("bd").every(2, (a) => { { const x = 1 } return a.stack(x) })`,
    `const x = ${midi}\nconst f = function g() { return x }\nlead: s("bd").stack(f())`,
  ];
  for (const code of reaching) assert.equal(readProgram(code, { parse }).reads.get('label:lead').playsMidi, true, code);
});

test('a MIDI call written as an assignment made later, a computed member or a bare call still reads as playing MIDI', () => {
  const programs = [
    "let syn\nsyn = note(\"c\").midi('Port A')\nlead: syn",
    "let syn\nif (true) { syn = note(\"c\").midi('Port A') }\nlead: syn.fast(2)",
    "const synth = note(\"c\")['midi']('Port A')\nlead: synth",
    "lead: stack(note(\"c\"), s(\"hh\")).apply(midi('Port A'))",
  ];
  for (const code of programs) {
    assert.equal(readProgram(code, { parse }).reads.get('label:lead').playsMidi, true, code);
  }
  // A computed spine is refused as a shape, so such a track is never written to.
  assert.equal(readProgram("lead: note(\"c\")['midi']('Port A')", { parse }).reads.get('label:lead').ok, false);
  assert.equal(refusal("let syn\nsyn = note(\"c\").midi('Port A')\nlead: syn", 'label:lead').reason, 'unsupported-change');
  // An assignment to a name the track never refers to changes nothing.
  const clear = "let syn\nsyn = note(\"c\").midi('Port A')\nlead: s(\"bd\")";
  assert.equal(readProgram(clear, { parse }).reads.get('label:lead').playsMidi, false);
});

test('a post-gain written as a bare call or as a .set key inside the track refuses the fader', () => {
  const programs = [
    'drums: stack(postgain(0.5).s("bd"), s("hh"))',
    'drums: postgain(0.5).s("bd")',
    'drums: s("bd").set({ postgain: 0.5 })',
    'drums: s("bd").set({ "postgain": 0.5 })',
    'const loud = { postgain: 2 }\ndrums: s("bd").set(loud)',
    'let beat\nbeat = s("bd").postgain(0.5)\ndrums: beat',
    'drums: stack(s("bd")["postgain"](0.5), s("hh"))',
  ];
  for (const code of programs) {
    assert.equal(readProgram(code, { parse }).reads.get('label:drums').innerPostgain, true, code);
    assert.equal(refusal(code, 'label:drums').reason, 'unsupported-change', code);
  }
  // A key that is not a post-gain is no reason to refuse.
  assert.equal(write('drums: s("bd").set({ pan: 0.5 })', 'label:drums', 0.5), 'drums: s("bd").set({ pan: 0.5 }).postgain(0.5)');
});

test('a bare call, a .set key or a later assignment that sets the orbit hides the bus', () => {
  const programs = ['kick: orbit(2).s("bd")', 'kick: s("bd").set({ o: 2 })', 'let beat\nbeat = s("bd").orbit(2)\nkick: beat', 'kick: s("bd").set({ roomsize: 4 })'];
  for (const code of programs) assert.equal(readProgram(code, { parse }).reads.get('label:kick').busHidden, true, code);
});

test('a MIDI track with a plain .gain keeps its gain edited in place: gain reaches the MIDI velocity', () => {
  const code = "const synth = note(\"c e\").midi('Port A')\nlead: synth.gain(0.5)";
  assert.equal(write(code, 'label:lead', 0.7), "const synth = note(\"c e\").midi('Port A')\nlead: synth.gain(0.7)");
});

test('a track that plays MIDI refuses every effect, send and bus write, and a bus change leaves it alone', () => {
  const code = "const jx = (p) => p.midi('Port A')\nlead: jx(note(\"c e\")).lpf(300).room(0.4)\nhats: s(\"hh\").room(0.2)";
  const specs = [
    { type: 'add-effect', effect: 'hpf' },
    { type: 'bypass-effect', effect: 'lpf' },
    { type: 'restore-effect', effect: 'crush', calls: [{ method: 'crush', value: 4 }] },
    { type: 'remove-effect', effect: 'lpf' },
    { type: 'param', effect: 'lpf', param: 'cutoff', value: 500 },
    { type: 'param-default', effect: 'lpf', param: 'cutoff' },
    { type: 'param-fixed', effect: 'lpf', param: 'cutoff' },
    { type: 'filter-move', effect: 'lpf', param: 'cutoff', move: { shape: 'sine', from: 200, to: 800, over: 4 } },
    { type: 'send', bus: 'reverb', value: 0.3, busParams: {} },
  ];
  for (const spec of specs) {
    const err = refused(code, 'label:lead', spec);
    assert.equal(err.reason, 'unsupported-change', spec.type);
    assert.match(err.message, /plays MIDI, which has no effects, reverb or delay here/, spec.type);
  }
  // Mute, solo and a plain gain still work: they change what is heard.
  assert.equal(applyChange(code, 'label:lead', { type: 'mute', on: true }).code.startsWith("const jx = (p) => p.midi('Port A')\n_lead:"), true);
  // The same effects on a track that plays no MIDI are written as before.
  assert.equal(applyChange(code, 'label:hats', { type: 'add-effect', effect: 'hpf' }).code.includes('hats: s("hh").room(0.2).hpf('), true);
  // The reverb bus reaches the hats only: the MIDI track is not a sender, so nothing is written on it.
  assert.equal(busCode(code, { bus: 'reverb', param: 'size', value: 4 }), code.replace('hats: s("hh").room(0.2)', 'hats: s("hh").room(0.2).roomsize(4)'));
});

// --- a post-gain set inside the track is replaced by the fader's own, so the fader refuses ---

test('a post-gain inside the track, in a call argument or in the shared code it reads, refuses the fader and writes nothing', () => {
  const programs = [
    "drums: stack(s(\"bd\").postgain(1), s(\"hh*4\").postgain(.3))",
    "drums: s(\"bd\").every(2, x => x.postgain(0.5))",
    "const beat = s(\"bd\").postgain(.5)\ndrums: beat",
    "const beat = s(\"bd\").postgain(.5)\nconst part = beat.fast(2)\ndrums: part.lpf(300)",
    "const quiet = (p) => p.postgain(.2)\ndrums: quiet(s(\"bd\"))",
    "drums: stack(s(\"bd\").postgain(1), s(\"hh\")).postgain(0.7)",
  ];
  for (const code of programs) {
    assert.equal(readProgram(code, { parse }).reads.get('label:drums').innerPostgain, true, code);
    const err = refusal(code, 'label:drums');
    assert.equal(err.reason, 'unsupported-change', code);
    assert.match(err.message, /The post-gain is set inside the track/, code);
  }
});

test('a post-gain on the chain itself, or only in shared code the track does not read, does not count as set inside the track', () => {
  const code = "const beat = s(\"bd\").postgain(.5)\nconst other = s(\"hh\")\ndrums: other.postgain(0.4)\nkick: beat";
  const { reads } = readProgram(code, { parse });
  assert.equal(reads.get('label:drums').innerPostgain, false);
  assert.equal(reads.get('label:kick').innerPostgain, true);
  assert.equal(write(code, 'label:drums', 0.9), code.replace('.postgain(0.4)', '.postgain(0.9)'));
});

// --- the neutral post-gain on a track that writes none changes nothing, so it writes nothing ---

test('a volume of 1.00 on a track with no post-gain returns the identical code and no edits; any other value still writes', () => {
  for (const code of ['drums: s("bd")', 'drums: stack(s("bd").gain(1), s("hh").gain(.3))', 'drums: s("bd").gain(sine)']) {
    const result = writeRaw(code, 'label:drums', 1);
    assert.equal(result.code, code);
    assert.deepEqual(result.edits, []);
  }
  assert.equal(write('drums: s("bd")', 'label:drums', 0.99), 'drums: s("bd").postgain(0.99)');
  // A post-gain the code already holds is still edited, 1 included.
  assert.equal(write('drums: s("bd").postgain(0.5)', 'label:drums', 1), 'drums: s("bd").postgain(1)');
  // A fixed gain is never touched by the rule: 1 is a real value there.
  assert.equal(write('drums: s("bd").gain(0.5)', 'label:drums', 1), 'drums: s("bd").gain(1)');
});

test('a post-gain inside the track does not stop a plain .gain on the chain from being edited in place', () => {
  const code = "drums: stack(s(\"bd\").postgain(1), s(\"hh\").postgain(.3)).gain(0.8)";
  assert.equal(write(code, 'label:drums', 0.4), "drums: stack(s(\"bd\").postgain(1), s(\"hh\").postgain(.3)).gain(0.4)");
});

// --- a track built from shared code that sets its own orbit or bus values has a bus the chain does not show ---

const ORBIT_CODE = "const beat = s(\"bd\").orbit(2)\nkick: beat\nhats: s(\"hh\").room(0.2)";

test('a track whose shared code sets an orbit, a send or a bus value reads as bus hidden; any other track does not', () => {
  const programs = [
    "const beat = s(\"bd\").orbit(2)\nkick: beat",
    "const beat = s(\"bd\").o(2)\nkick: beat",
    "const beat = s(\"bd\").room(0.5)\nkick: beat.lpf(300)",
    "const wet = (p) => p.delay(0.3).delaytime(0.2)\nkick: wet(s(\"bd\"))",
    "const beat = s(\"bd\").roomsize(4)\nconst part = beat.fast(2)\nkick: part",
  ];
  for (const code of programs) assert.equal(readProgram(code, { parse }).reads.get('label:kick').busHidden, true, code);
  const clear = "const beat = s(\"bd\").lpf(200)\nkick: beat\nhats: s(\"hh\").orbit(2)\nlead: s(\"cp\").room(0.3)";
  const { reads } = readProgram(clear, { parse });
  for (const name of ['kick', 'hats', 'lead']) assert.equal(reads.get(`label:${name}`).busHidden, false, name);
});

test("an orbit, a send or a bus value written anywhere but on the track's own chain hides its bus, whatever the root is", () => {
  const programs = [
    'const fx = p => p.orbit(2)\nkick: s("bd").apply(fx)',
    'const beat = s("bd").set({ orbit: 2 })\nkick: beat',
    'kick: s("bd").set({ orbit: 2 })',
    'kick: s("bd").set({ "orbit": 2 })',
    'kick: s("bd").superimpose(x => x.orbit(2))',
    'kick: stack(s("bd").orbit(2), s("hh"))',
    'kick: stack(s("bd").room(0.3), s("hh")).gain(0.5)',
    'kick: s("bd").every(2, x => x.roomsize(4))',
    'kick: orbit(2).s("bd")',
    'kick: stack(s("bd")["orbit"](2), s("hh"))',
    'const fx = [p => p.orbit(2)]\nkick: s("bd").apply(fx[0])',
  ];
  for (const code of programs) {
    assert.equal(readProgram(code, { parse }).reads.get('label:kick').busHidden, true, code);
    const err = refused(code, 'label:kick', { type: 'send', bus: 'reverb', value: 0.3, busParams: { size: 4 } });
    assert.equal(err.reason, 'unsupported-change', code);
    assert.match(err.message, /sets its own orbit or bus values/, code);
  }
  // A call on the chain itself, or in code the track never refers to, hides nothing.
  const clear = 'const fx = p => p.orbit(2)\nkick: s("bd").orbit(3).room(0.2)\nhats: s("hh").every(2, x => x.fast(2))\nlead: s("cp").lpf(300)';
  const { reads } = readProgram(clear, { parse });
  for (const name of ['kick', 'hats', 'lead']) assert.equal(reads.get(`label:${name}`).busHidden, false, name);
});

test('a bus change leaves a track alone whose orbit is set through a helper in the chain', () => {
  const code = 'const fx = p => p.orbit(2)\nkick: s("bd").apply(fx).room(0.4)\nhats: s("hh").room(0.2)';
  assert.equal(busCode(code, { bus: 'reverb', param: 'size', value: 4 }), code.replace('hats: s("hh").room(0.2)', 'hats: s("hh").room(0.2).roomsize(4)'));
});

test('a send on a track whose shared code sets its orbit is refused, and nothing is written', () => {
  const err = refused(ORBIT_CODE, 'label:kick', { type: 'send', bus: 'reverb', value: 0.3, busParams: { size: 4 } });
  assert.equal(err.reason, 'unsupported-change');
  assert.match(err.message, /sets its own orbit or bus values/);
  // A track on the same code with no hidden bus still takes its send.
  assert.equal(sendChange(ORBIT_CODE, 'label:hats', 'reverb', 0.3), ORBIT_CODE.replace('.room(0.2)', '.room(0.3)'));
});

test('a bus change never counts or touches a track whose shared code sets its orbit', () => {
  const code = "const beat = s(\"bd\").orbit(2).room(0.4)\nkick: beat\nhats: s(\"hh\").room(0.2)";
  // The kick would be read as a sender of orbit 1, and written there; it is left out.
  assert.equal(busCode(code, { bus: 'reverb', param: 'size', value: 4 }), "const beat = s(\"bd\").orbit(2).room(0.4)\nkick: beat\nhats: s(\"hh\").room(0.2).roomsize(4)");
  assert.throws(() => bus("const beat = s(\"bd\").room(0.4)\nkick: beat", { bus: 'reverb', param: 'size', value: 4 }), /no track sends to the reverb bus on orbit 1/);
});
