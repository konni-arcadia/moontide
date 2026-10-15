// The layout of the Mixer's groups, tested without a browser: which frames a read song gives, in which order the strips
// sit in them, how deep they nest and how many strips each group counts. Readings come from the real reader, so the
// shapes cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { HELPER_TEXT, readStructure } from '../page/structure.js';
import { groupActions, mixerLayout } from '../page/mixer-groups.js';

const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

/** A small structured piece: tracks t1 to t3 are in the song, t4 is an ordinary track outside every group. */
function piece({ groups = "{ g1: ['t1', 't2'], g2: { g3: ['t3'] } }", extra = "t4: note('c3').gain(0)" } = {}) {
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: 0, sections: [['x', 3]], ${groups === null ? '' : `groups: ${groups}, `}plan: { x: { t1: 'va', t2: 'va', t3: 'va' } } };`,
    HELPER_TEXT,
    "const t1 = { va: note('c3') };",
    "const t2 = { va: note('d3') };",
    "const t3 = { va: note('e3') };",
    "t1: play('t1', t1)\nt2: play('t2', t2)\nt3: play('t3', t3)",
    extra,
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** The strips as the Mixer model has them: only the identity and the track's index matter to the layout. */
function stripsOf(code) {
  return extractTracks(code, { parse }).map((track) => ({ identity: track.identity, index: track.index }));
}

function layoutOf(code, folds = []) {
  return mixerLayout({ reading: read(code), strips: stripsOf(code), folds: new Set(folds) });
}

test('the top level is the groups in the song order, then the strips no group names', () => {
  const layout = layoutOf(piece());
  assert.deepEqual(
    layout.items.map((item) => (item.kind === 'group' ? `group ${item.name}` : `strip ${item.identity}`)),
    ['group g1', 'group g2', 'strip label:t4'],
  );
  assert.deepEqual(
    layout.groups.map((group) => [group.name, group.level, group.key]),
    [['g1', 1, '["g1"]'], ['g2', 1, '["g2"]'], ['g3', 2, '["g2","g3"]']],
  );
});

test('a group holds its items in the order written, sub-groups and strips', () => {
  const layout = layoutOf(piece());
  const [g1, g2] = layout.items;
  assert.deepEqual(g1.items.map((item) => item.identity), ['label:t1', 'label:t2']);
  assert.deepEqual(g2.items.map((item) => [item.kind, item.name]), [['group', 'g3']]);
  assert.deepEqual(g2.items[0].items.map((item) => item.identity), ['label:t3']);
  const mixed = layoutOf(piece({ groups: "{ g1: ['t3', { inner: ['t1'] }, 't2'] }", extra: '' }));
  assert.deepEqual(
    mixed.items[0].items.map((item) => (item.kind === 'group' ? `group ${item.name}` : item.identity)),
    ['label:t3', 'group inner', 'label:t2'],
  );
  // The same objects sit in the tree and in the flat list, so callers never walk the tree again.
  assert.equal(layout.groups[0], g1);
  assert.equal(layout.groups[2], g2.items[0]);
});

test('a group counts the strips below it at any depth', () => {
  const layout = layoutOf(piece());
  assert.deepEqual(layout.groups.map((group) => group.members), [['label:t1', 'label:t2'], ['label:t3'], ['label:t3']]);
});

test('the layout is null for no song, an unreadable one and a song that names no group', () => {
  const strips = [];
  assert.equal(mixerLayout({ reading: { state: 'none' }, strips, folds: new Set() }), null);
  assert.equal(mixerLayout({ reading: { state: 'unreadable', reason: 'x' }, strips, folds: new Set() }), null);
  // A read song with no groups key, and one whose groups are written as an empty object.
  assert.equal(read(piece({ groups: null })).state, 'read');
  assert.equal(layoutOf(piece({ groups: null })), null);
  assert.equal(read(piece({ groups: '{}' })).state, 'read');
  assert.equal(layoutOf(piece({ groups: '{}' })), null);
});

test('each group has its own fold state, and a group inside a folded group stays open itself', () => {
  const layout = layoutOf(piece(), ['["g2"]']);
  assert.deepEqual(layout.groups.map((group) => [group.name, group.open]), [['g1', true], ['g2', false], ['g3', true]]);
});

test('ungrouped strips keep the code order, whatever order the groups name their tracks in', () => {
  const code = piece({ groups: "{ g1: ['t2'] }", extra: "t4: note('c3').gain(0)\nt5: note('d3').gain(0)" });
  const layout = layoutOf(code);
  assert.deepEqual(
    layout.items.map((item) => (item.kind === 'group' ? `group ${item.name}` : item.identity)),
    ['group g1', 'label:t1', 'label:t3', 'label:t4', 'label:t5'],
  );
});

test('groups with no strip, one strip and two strips are all drawn, and a track with no strip adds nothing', () => {
  const code = piece({ groups: "{ g0: [], g1: ['t1'], g2: ['t2', 't3'] }" });
  const layout = layoutOf(code);
  assert.deepEqual(layout.groups.map((group) => [group.name, group.members.length]), [['g0', 0], ['g1', 1], ['g2', 2]]);
  // A track the song names that has no strip (a MIDI track that plays no notes): not in the frame, not counted.
  const strips = stripsOf(code).filter((strip) => strip.identity !== 'label:t3');
  const without = mixerLayout({ reading: read(code), strips, folds: new Set() });
  assert.deepEqual(without.groups.map((group) => [group.name, group.members]), [['g0', []], ['g1', ['label:t1']], ['g2', ['label:t2']]]);
  assert.deepEqual(without.groups[2].items.map((item) => item.identity), ['label:t2']);
  // The track with no strip is named by a group, so it is not an ungrouped strip either.
  assert.deepEqual(without.items.filter((item) => item.kind === 'strip').map((item) => item.identity), ['label:t4']);
});

test('the same name at two places gives two keys, and a name that is a key of every object is an ordinary name', () => {
  const same = layoutOf(piece({ groups: "{ a: { x: ['t1'] }, b: { x: ['t2'] } }" }));
  assert.deepEqual(same.groups.map((group) => group.key), ['["a"]', '["a","x"]', '["b"]', '["b","x"]']);
  // The reader refuses these names in code; given to the layout as data they must still be plain Map keys.
  const reading = {
    state: 'read',
    tracks: [{ name: 'constructor', index: 0 }, { name: '__proto__', index: 1 }, { name: 'toString', index: 2 }],
    groups: [
      { name: '__proto__', items: [{ track: 'constructor' }, { group: { name: 'constructor', items: [{ track: '__proto__' }] } }] },
      { name: 'constructor', items: [{ track: 'toString' }] },
    ],
  };
  const strips = [0, 1, 2].map((index) => ({ identity: `s${index}`, index }));
  const layout = mixerLayout({ reading, strips, folds: new Set(['["__proto__"]']) });
  assert.deepEqual(layout.groups.map((group) => [group.name, group.key, group.open, group.members]), [
    ['__proto__', '["__proto__"]', false, ['s0', 's1']],
    ['constructor', '["__proto__","constructor"]', true, ['s1']],
    ['constructor', '["constructor"]', true, ['s2']],
  ]);
  assert.equal(Object.getPrototypeOf(layout.groups[0]), Object.prototype);
});

test('a group is deep from level five on', () => {
  const layout = layoutOf(piece({ groups: "{ a: { b: { c: { d: { e: { f: ['t1'] } } } } } }" }));
  assert.deepEqual(layout.groups.map((group) => [group.name, group.level, group.deep]), [
    ['a', 1, false], ['b', 2, false], ['c', 3, false], ['d', 4, false], ['e', 5, true], ['f', 6, true],
  ]);
});

test('a structure a thousand levels deep is walked without a stack overflow', () => {
  let inner = { name: 'n1000', items: [{ track: 't1' }] };
  for (let level = 999; level >= 1; level--) inner = { name: `n${level}`, items: [{ group: inner }] };
  const reading = { state: 'read', tracks: [{ name: 't1', index: 0 }], groups: [inner] };
  const layout = mixerLayout({ reading, strips: [{ identity: 'label:t1', index: 0 }], folds: new Set() });
  assert.equal(layout.groups.length, 1000);
  assert.equal(layout.groups[999].level, 1000);
  assert.deepEqual(layout.groups.map((group) => group.members.length), Array(1000).fill(1));
  assert.deepEqual(layout.items.length, 1);
});

// --- What a click on a group's mute and solo does ---

/** A strip as the Mixer model has it, for the parts groupActions reads. */
function strip(identity, { editable = true, muted = false, soloed = false, muteOff = false, soloOff = false } = {}) {
  return { identity, editable, mute: { pressed: muted, disabled: muteOff }, solo: { pressed: soloed, disabled: soloOff } };
}
const actionsOf = (members, strips) => groupActions({ members }, new Map(strips.map((one) => [one.identity, one])));

test('a group with none of its tracks muted mutes them all on a click, and shows no mark', () => {
  const { mute, solo, skipped } = actionsOf(['a', 'b', 'c'], [strip('a'), strip('b'), strip('c')]);
  assert.deepEqual([mute.pressed, mute.on, mute.n, mute.k, mute.identities], [false, true, 3, 0, ['a', 'b', 'c']]);
  assert.deepEqual([solo.pressed, solo.on, solo.n, solo.k], [false, true, 3, 0]);
  assert.equal(skipped, 0);
});

test('a group with some tracks muted is mixed, and a click still mutes them all', () => {
  const { mute } = actionsOf(['a', 'b', 'c'], [strip('a', { muted: true }), strip('b'), strip('c')]);
  assert.deepEqual([mute.pressed, mute.on, mute.n, mute.k], ['mixed', true, 3, 1]);
});

test('a group with every track muted is pressed, and a click unmutes them all', () => {
  const { mute } = actionsOf(['a', 'b'], [strip('a', { muted: true }), strip('b', { muted: true })]);
  assert.deepEqual([mute.pressed, mute.on, mute.n, mute.k], [true, false, 2, 2]);
});

test('solo counts the soloed tracks the same way, apart from mute', () => {
  const strips = [strip('a', { soloed: true }), strip('b', { muted: true }), strip('c')];
  const { mute, solo } = actionsOf(['a', 'b', 'c'], strips);
  assert.deepEqual([mute.pressed, mute.k, solo.pressed, solo.k, solo.on], ['mixed', 1, 'mixed', 1, true]);
  const all = actionsOf(['a', 'b'], [strip('a', { soloed: true }), strip('b', { soloed: true })]);
  assert.deepEqual([all.solo.pressed, all.solo.on], [true, false]);
});

test('a strip the mixer cannot edit, an unsafe label, an unlabeled track and a native solo name are left out and counted once', () => {
  const strips = [
    strip('edit', { editable: false, muteOff: true, soloOff: true }),
    strip('unsafe', { muteOff: true, soloOff: true }),
    strip('unlabeled', { soloOff: true }),
    strip('native', { soloOff: true, soloed: true }),
    strip('plain', { muted: true }),
  ];
  const { mute, solo, skipped } = actionsOf(['edit', 'unsafe', 'unlabeled', 'native', 'plain'], strips);
  assert.deepEqual(mute.identities, ['unlabeled', 'native', 'plain']);
  assert.deepEqual(solo.identities, ['plain']);
  assert.deepEqual([mute.n, mute.k, mute.pressed], [3, 1, 'mixed']);
  assert.deepEqual([solo.n, solo.k, solo.pressed], [1, 0, false]);
  assert.equal(skipped, 4);
});

test('a group with no member, and a group whose members none can reach, have nothing to write', () => {
  const none = actionsOf([], []);
  assert.deepEqual([none.mute.n, none.mute.identities, none.mute.pressed, none.mute.on, none.solo.n, none.skipped], [0, [], false, true, 0, 0]);
  const blocked = actionsOf(['a'], [strip('a', { editable: false, muteOff: true, soloOff: true })]);
  assert.deepEqual([blocked.mute.n, blocked.mute.pressed, blocked.solo.n, blocked.skipped], [0, false, 0, 1]);
});

test('a member without a strip adds nothing, and a group of one track is pressed when that track is', () => {
  const { mute, skipped } = actionsOf(['a', 'gone'], [strip('a', { muted: true })]);
  assert.deepEqual([mute.pressed, mute.on, mute.n, skipped], [true, false, 1, 0]);
});
