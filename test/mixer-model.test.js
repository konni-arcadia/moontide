// Unit tests for page/mixer-model.js: the copy, the history label and the strips the Mixer draws.
// The real acorn parser is injected, like test/tracks.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { MIXER_COPY, MAX_MIXER_LABEL_LENGTH, clipMixerLabel, inspectorModel, mixerHistoryLabel, mixerNotice, buildMixerModel } from '../page/mixer-model.js';
import { REFUSAL_REASONS } from '../page/mixer-rewrite.js';
import { fill } from '../page/midi-plan.js';
import { rigFromReadFailure, withBuildMismatch } from '../page/midi-rig.js';
import { gainToPosition } from '../page/mixer-registry.js';
import { HELPER_TEXT, readStructure } from '../page/structure.js';
import { extractTracks, labelKey } from '../page/tracks.js';
import { createLights, lightLayout } from '../page/lights.js';

const colorOf = (identity) => (identity === 'label:hats' ? 2 : 1);
const build = (code) => buildMixerModel({ code, parse, colorOf });

test('MIXER_COPY holds the pinned strings', () => {
  assert.equal(MIXER_COPY.empty, 'Nothing is playing yet.');
  assert.equal(MIXER_COPY.faderDefault, 'default');
  assert.equal(MIXER_COPY.notSaved, 'mixer change was not saved to history — try again.');
  assert.equal(MIXER_COPY.cannotRead, "The mixer couldn't read this code.");
  assert.equal(MIXER_COPY.faderAfterGain, 'after gain');
  assert.equal(MIXER_COPY.faderAfterGainTitle, 'The gain moves in the code, so this fader sets a level after it.');
  assert.equal(MIXER_COPY.faderBothMoving, 'Gain and post-gain both move in the code.');
  assert.equal(MIXER_COPY.faderDefaultTitle, 'This fader multiplies what the code plays; 1.00 plays it as written.');
  assert.equal(MIXER_COPY.faderPostgainMoving, 'The post-gain moves in the code.');
  assert.equal(MIXER_COPY.faderInnerPostgain, 'A post-gain is set inside the track. Ask Claude to change its level.');
  assert.equal(MIXER_COPY.faderInnerPostgainTitle, 'A fader here would write a post-gain at the end of the track and flatten the post-gains set inside it.');
  assert.equal(MIXER_COPY.faderPlaysMidi, 'Plays MIDI the mixer has no control for. Ask Claude to change its level.');
  assert.equal(MIXER_COPY.faderPlaysMidiTitle, 'A fader here would write a post-gain, and MIDI output ignores a post-gain.');
  assert.equal(MIXER_COPY.disconnected, 'Disconnected — the mixer is off until Moontide reconnects.');
  assert.equal(
    MIXER_COPY.dirty,
    'The editor has changes that are not playing yet. Evaluate them first — the mixer works on the playing code.',
  );
  assert.equal(MIXER_COPY.sharedRoot, 'Built from shared code');
  assert.equal(MIXER_COPY.sharedRootTitle, 'The mixer shows and changes only what this track writes after the shared code.');
  assert.deepEqual(MIXER_COPY.reasons, {
    condition: "Depends on a condition — the mixer can't edit it.",
    'unsupported-shape': "Written in a shape the mixer doesn't understand.",
  });
});

test('mixerNotice shows at most one line: disconnected wins over an unevaluated edit', () => {
  assert.deepEqual(mixerNotice({ connection: 'connected', dirty: false }), { kind: null, text: '' });
  assert.deepEqual(mixerNotice({ connection: 'connected', dirty: true }), { kind: 'dirty', text: MIXER_COPY.dirty });
  assert.deepEqual(mixerNotice({ connection: 'disconnected', dirty: true }), {
    kind: 'disconnected',
    text: MIXER_COPY.disconnected,
  });
  assert.deepEqual(mixerNotice({ connection: 'disconnected', dirty: false }), {
    kind: 'disconnected',
    text: MIXER_COPY.disconnected,
  });
  // 'connecting' counts as not connected.
  assert.equal(mixerNotice({ connection: 'connecting', dirty: false }).kind, 'disconnected');
  assert.equal(mixerNotice({ connection: 'connecting', dirty: true }).kind, 'disconnected');
});

test('mixerNotice puts a waiting change between disconnected and an unevaluated edit', () => {
  const waitingText = 'A change is waiting for its bar line. The mixer works again when it takes over.';
  assert.equal(MIXER_COPY.waiting, waitingText);
  assert.deepEqual(mixerNotice({ connection: 'connected', dirty: false, waiting: true }), { kind: 'waiting', text: MIXER_COPY.waiting });
  assert.equal(mixerNotice({ connection: 'connected', dirty: true, waiting: true }).kind, 'waiting');
  assert.equal(mixerNotice({ connection: 'disconnected', dirty: true, waiting: true }).kind, 'disconnected');
  assert.equal(mixerNotice({ connection: 'connecting', dirty: false, waiting: true }).kind, 'disconnected');
  assert.deepEqual(mixerNotice({ connection: 'connected', dirty: false, waiting: false }), { kind: null, text: '' });
  assert.equal(mixerNotice({ connection: 'connected', dirty: true, waiting: false }).kind, 'dirty');
});

test('every refusal reason has a sentence, and a strip carries it as reasonText', () => {
  for (const reason of REFUSAL_REASONS) {
    assert.equal(typeof MIXER_COPY.reasons[reason], 'string', reason);
  }
  const model = build('const x = s("bd")\nbad: x\nfine: s("hh")\nweird: (y => y)\ncond: (1 ? s("cp") : s("bd"))');
  const byName = Object.fromEntries(model.strips.map((strip) => [strip.name, strip]));
  assert.equal(byName.bad.editable, true);
  assert.equal(byName.bad.reasonText, null);
  assert.equal(byName.weird.reasonText, MIXER_COPY.reasons['unsupported-shape']);
  assert.equal(byName.cond.reasonText, MIXER_COPY.reasons.condition);
  assert.equal(byName.fine.reasonText, null);
});

test('strips follow the order of the code and carry the color colorOf gives each track', () => {
  const model = build('drums: s("bd*4").gain(0.5)\nhats: s("hh*8")\nclaps: s("cp")');
  assert.equal(model.status, 'ready');
  assert.deepEqual(model.strips.map((strip) => strip.name), ['drums', 'hats', 'claps']);
  assert.deepEqual(model.strips.map((strip) => strip.identity), ['label:drums', 'label:hats', 'label:claps']);
  assert.deepEqual(model.strips.map((strip) => strip.color), [1, 2, 1]);
  assert.ok(model.strips.every((strip) => strip.editable && strip.reason === null));
});

test('a fixed gain, no gain, a moving gain, a post-gain only and both moving give the fader states', () => {
  const model = build(
    [
      'fixed: s("bd").gain(0.5)',
      'none: s("hh")',
      'moving: s("cp").gain(sine.range(0.2, 0.8))',
      'movingfixed: s("cp").gain(sine).postgain(0.6)',
      'both: s("bd").gain(sine).postgain(perlin)',
      'post: s("hh").postgain(0.5)',
      'postmoving: s("hh").postgain(perlin)',
    ].join('\n'),
  );
  const [fixed, none, moving, movingFixed, both, post, postMoving] = model.strips.map((strip) => strip.fader);
  assert.deepEqual(fixed, {
    target: 'gain',
    value: 0.5,
    position: 577,
    readout: '0.50',
    readoutMuted: false,
    line: null,
    lineText: null,
    lineTitle: null,
    disabled: false,
  });
  assert.deepEqual(none, {
    target: 'postgain',
    value: 1,
    position: gainToPosition(1),
    readout: '1.00',
    readoutMuted: true,
    line: 'default',
    lineText: 'default',
    lineTitle: MIXER_COPY.faderDefaultTitle,
    disabled: false,
  });
  assert.equal(post.target, 'postgain');
  assert.equal(post.value, 0.5);
  assert.equal(post.readout, '0.50');
  assert.equal(post.line, null);
  assert.equal(post.readoutMuted, false);
  assert.equal(post.disabled, false);
  assert.equal(postMoving.target, null);
  assert.equal(postMoving.disabled, true);
  assert.equal(postMoving.line, 'postgain-moving');
  assert.equal(postMoving.lineText, 'The post-gain moves in the code.');
  assert.equal(moving.target, 'postgain');
  assert.equal(moving.value, 1);
  assert.equal(moving.line, 'after-gain');
  assert.equal(moving.lineText, 'after gain');
  assert.equal(moving.lineTitle, 'The gain moves in the code, so this fader sets a level after it.');
  assert.equal(moving.readoutMuted, false);
  assert.equal(moving.disabled, false);
  assert.equal(movingFixed.target, 'postgain');
  assert.equal(movingFixed.value, 0.6);
  assert.equal(both.target, null);
  assert.equal(both.line, 'both-moving');
  assert.equal(both.lineText, 'Gain and post-gain both move in the code.');
  assert.equal(both.disabled, true);
  assert.equal(both.value, 1);
  assert.equal(both.readout, '1.00');
  assert.equal(postMoving.readout, '1.00');
});

test('a gain above the top of the fader pins the thumb and shows the real number', () => {
  const [strip] = build('drums: s("bd").gain(2)').strips;
  assert.equal(strip.fader.position, 1000);
  assert.equal(strip.fader.readout, '2.00');
  assert.equal(strip.fader.readoutMuted, false);
});

test('a post-gain above the top of the fader pins the thumb and shows the real number', () => {
  const [strip] = build('drums: s("bd").postgain(2)').strips;
  assert.equal(strip.fader.target, 'postgain');
  assert.equal(strip.fader.position, 1000);
  assert.equal(strip.fader.readout, '2.00');
  assert.equal(strip.fader.readoutMuted, false);
});

test('a track with no gain shows the default muted, and a program with only setcps has no strips', () => {
  const [strip] = build('drums: s("bd*4")').strips;
  assert.equal(strip.fader.readout, '1.00');
  assert.equal(strip.fader.readoutMuted, true);
  assert.equal(strip.fader.lineText, 'default');
  assert.equal(strip.fader.lineTitle, MIXER_COPY.faderDefaultTitle);
  assert.equal(build('setcps(0.5)').status, 'empty');
});

test('a refused track is not editable, names its reason and has a disabled fader', () => {
  const model = build('const x = s("bd")\nbad: x\nweird: (y => y)\ncond: (1 ? s("cp") : s("bd"))\nfine: s("hh")');
  const [bad, weird, cond, fine] = model.strips;
  assert.equal(bad.editable, true);
  assert.equal(bad.reason, null);
  assert.equal(bad.fader.disabled, false);
  assert.equal(weird.editable, false);
  assert.equal(weird.reason, 'unsupported-shape');
  assert.equal(weird.fader.disabled, true);
  assert.equal(cond.editable, false);
  assert.equal(cond.reason, 'condition');
  assert.equal(cond.fader.disabled, true);
  assert.equal(fine.editable, true);
  assert.equal(fine.fader.disabled, false);
  // A refused fader shows the same neutral as every fader that multiplies: 1.00, never the old 0.80.
  for (const fader of [weird.fader, cond.fader]) {
    assert.equal(fader.value, 1);
    assert.equal(fader.readout, '1.00');
    assert.equal(fader.position, gainToPosition(1));
  }
});

test("the model is 'empty' for no code and for a program with no tracks", () => {
  assert.deepEqual(build(''), { status: 'empty', strips: [], buses: [], busMemory: new Map() });
  assert.deepEqual(build('   \n'), { status: 'empty', strips: [], buses: [], busMemory: new Map() });
  assert.deepEqual(build('setcpm(30)'), { status: 'empty', strips: [], buses: [], busMemory: new Map() });
});

test("the model is 'unreadable' for code the parser cannot read, with the error attached", () => {
  const model = build('drums: s("bd"');
  assert.equal(model.status, 'unreadable');
  assert.deepEqual(model.strips, []);
  assert.ok(model.error instanceof SyntaxError);
});

test('a literal the mixer cannot show (Infinity, 1e21 and above) reads as moving instead of crashing the model', () => {
  const model = build('a: s("x").gain(1e400)\nb: s("y").lpf(1e30)\nc: s("z").room(1e25)');
  assert.equal(model.status, 'ready');
  assert.equal(model.strips.length, 3);
  assert.equal(model.strips[0].fader.disabled, false);
  assert.equal(model.strips[0].fader.line, 'after-gain');
  assert.equal(model.strips[1].chips[0].summary, MIXER_COPY.moving);
});

test("anything the model cannot build is 'unreadable' with the error attached, never thrown", () => {
  const boom = new Error('Moontide: a number to show is too large.');
  const model = buildMixerModel({
    code: 'drums: s("bd")',
    parse,
    colorOf: () => {
      throw boom;
    },
  });
  assert.equal(model.status, 'unreadable');
  assert.deepEqual(model.strips, []);
  assert.deepEqual(model.buses, []);
  assert.ok(model.busMemory instanceof Map);
  assert.equal(model.error, boom);
});

test('the volume history label names the track and the value', () => {
  assert.equal(mixerHistoryLabel({ kind: 'volume', name: 'drums', value: 0.8 }), 'mixer: drums volume 0.8');
  assert.equal(mixerHistoryLabel({ kind: 'volume', name: 'hats', value: 0.35 }), 'mixer: hats volume 0.35');
  assert.equal(mixerHistoryLabel({ kind: 'volume', name: 'hats', value: 0 }), 'mixer: hats volume 0');
  assert.throws(() => mixerHistoryLabel({ kind: 'pan', name: 'x', value: 1 }), /^Error: Moontide:/);
});

test('clipMixerLabel caps a label at 200 characters with a trailing ellipsis', () => {
  assert.equal(MAX_MIXER_LABEL_LENGTH, 200);
  const exact = 'a'.repeat(200);
  assert.equal(clipMixerLabel(exact), exact);
  const clipped = clipMixerLabel('a'.repeat(300));
  assert.equal(clipped.length, 200);
  assert.ok(clipped.endsWith('…'));
});

test('MAX_MIXER_LABEL_LENGTH mirrors the value in src/protocol.ts and the history label limit', () => {
  const protocolSource = readFileSync(fileURLToPath(new URL('../src/protocol.ts', import.meta.url)), 'utf8');
  const historySource = readFileSync(fileURLToPath(new URL('../src/history.ts', import.meta.url)), 'utf8');
  const fromProtocol = /MAX_MIXER_LABEL_LENGTH = (\d+)/.exec(protocolSource);
  const fromHistory = /MAX_LABEL_LENGTH = (\d+)/.exec(historySource);
  assert.ok(fromProtocol, 'src/protocol.ts declares MAX_MIXER_LABEL_LENGTH');
  assert.ok(fromHistory, 'src/history.ts declares MAX_LABEL_LENGTH');
  assert.equal(MAX_MIXER_LABEL_LENGTH, Number(fromProtocol[1]));
  assert.equal(Number(fromProtocol[1]), Number(fromHistory[1]));
});

// --- Mute and solo strips ---

const stripOf = (code, name) => build(code).strips.find((strip) => strip.name === name);

test('MIXER_COPY holds the mute and solo strings', () => {
  assert.equal(MIXER_COPY.mute, 'Mute');
  assert.equal(MIXER_COPY.solo, 'Solo');
  assert.equal(MIXER_COPY.soloByName, 'Starts with a capital S — Strudel plays this track alone.');
  assert.equal(MIXER_COPY.soloNeedsLabel, 'Solo and the light need a label — ask Claude to name this track.');
});

test('mixerHistoryLabel names mute and solo presses', () => {
  assert.equal(mixerHistoryLabel({ kind: 'mute', name: 'drums', on: true }), 'mixer: drums muted');
  assert.equal(mixerHistoryLabel({ kind: 'mute', name: 'drums', on: false }), 'mixer: drums unmuted');
  assert.equal(mixerHistoryLabel({ kind: 'solo', name: 'hats', on: true }), 'mixer: hats solo on');
  assert.equal(mixerHistoryLabel({ kind: 'solo', name: 'hats', on: false }), 'mixer: hats solo off');
});

test('strips show the name without the mute underscore and the solo marker', () => {
  assert.deepEqual(build('_drums: s("bd")\nS_hats: s("hh")\nbass_: s("sd")').strips.map((strip) => strip.name), ['drums', 'hats', 'bass']);
});

test('a plain track has M and S enabled and neither pressed; muting presses M', () => {
  const plain = stripOf('drums: s("bd")\nhats: s("hh")', 'drums');
  assert.deepEqual(plain.mute, { pressed: false, disabled: false, reasonText: null });
  assert.deepEqual(plain.solo, { pressed: false, disabled: false, noteText: null });
  assert.equal(plain.sounding, true);
  const muted = stripOf('_drums: s("bd")', 'drums');
  assert.equal(muted.mute.pressed, true);
  assert.equal(muted.sounding, false);
});

test('a soloed track presses S; the others do not sound and keep M readable and enabled', () => {
  const strips = build('S_drums: s("bd")\nhats: s("hh")').strips;
  assert.equal(strips[0].solo.pressed, true);
  assert.equal(strips[0].sounding, true);
  assert.equal(strips[1].sounding, false);
  assert.equal(strips[1].mute.pressed, false);
  assert.equal(strips[1].mute.disabled, false);
});

test('a marker under a mute underscore is not a solo', () => {
  const strip = stripOf('_S_drums: s("bd")', 'drums');
  assert.equal(strip.solo.pressed, false);
  assert.equal(strip.mute.pressed, true);
});

test('a name that starts with a capital S shows S pressed and disabled with the note; M stays enabled', () => {
  const snare = stripOf('Snare: s("sd")\nhats: s("hh")', 'Snare');
  assert.deepEqual(snare.solo, { pressed: true, disabled: true, noteText: MIXER_COPY.soloByName });
  assert.equal(snare.mute.disabled, false);
  const marked = stripOf('S_Snare: s("sd")', 'Snare');
  assert.deepEqual(marked.solo, { pressed: true, disabled: true, noteText: MIXER_COPY.soloByName });
});

test('an unlabeled track has S disabled with its reason and M enabled; a $ track can be soloed', () => {
  const branch = build('stack(s("bd"), s("hh"))').strips[0];
  assert.deepEqual(branch.solo, { pressed: false, disabled: true, noteText: MIXER_COPY.soloNeedsLabel });
  assert.equal(branch.mute.disabled, false);
  const dollar = build('$: s("bd")').strips[0];
  assert.equal(dollar.solo.disabled, false);
  assert.equal(dollar.mute.disabled, false);
});

test('lightKey is the identity of a labeled track, $ and its number for a $ track, and null for a track without a label', () => {
  const keys = (code) => build(code).strips.map((strip) => strip.lightKey);
  assert.deepEqual(keys('t1: s("bd")\nS_t2: s("hh")'), ['label:t1', 'label:t2']);
  // The tag counts $ statements in code order from 0, and a statement an underscore silences is not counted.
  const dollars = build('$: s("bd")\n_$: s("hh")\n$: s("sd")');
  assert.deepEqual(dollars.strips.map((strip) => strip.lightKey).filter((key) => key.startsWith('$')), ['$0', '$1']);
  assert.equal(dollars.strips.length, 3);
  assert.equal(dollars.strips[1].lightKey, dollars.strips[1].identity, 'a silenced $ statement keeps a key no note names');
  assert.deepEqual(keys('stack(s("bd"), s("hh"))'), [null, null]);
  assert.deepEqual(keys('s("bd")'), [null]);
  // A mute or a solo mark never changes the key.
  assert.deepEqual(keys('_t1: s("bd")'), ['label:t1']);
});

test('a muted copy next to a track of the same base name shares its light key, and only the audible track blinks', () => {
  for (const code of ['hats_: s("hh*8")\nhats: s("hh*4")', 'hats: s("hh*4")\nhats_: s("hh*8")', 'S_hats: s("hh*4")\nhats_: s("hh*8")']) {
    const model = build(code);
    // The note tag reports the audible track under labelKey of its label, which is the key of both strips.
    assert.deepEqual(model.strips.map((strip) => strip.lightKey), ['label:hats', 'label:hats'], code);
    assert.equal(labelKey('hats'), 'label:hats');
    assert.equal(new Set(model.strips.map((strip) => strip.identity)).size, 2, 'the identities stay unique');
    const audible = model.strips.find((strip) => strip.sounding);
    const dark = model.strips.find((strip) => !strip.sounding);
    const lights = createLights();
    lights.setLayout(lightLayout(model, { webMidi: true }));
    lights.noteSeen('label:hats', { at: 100 });
    const changes = lights.frame(100, { motion: 'on', cps: 1, toPerf: (target) => target * 1000 });
    assert.deepEqual(changes, [{ kind: 'track', id: audible.identity, value: 1 }], `${code}: only the audible strip lights`);
    assert.notEqual(dark.identity, audible.identity);
  }
});

test('the light titles and the unlabeled-track sentence are pinned', () => {
  assert.equal(MIXER_COPY.lightTrackTitle, 'Blinks when {name} plays a note');
  assert.equal(MIXER_COPY.lightGroupTitle, 'Blinks when any track of {group} plays a note');
  assert.equal(MIXER_COPY.soloNeedsLabel, 'Solo and the light need a label — ask Claude to name this track.');
});

test('a hushed unlabeled track shows M pressed and does not sound', () => {
  const strips = build('stack(s("bd").hush(), s("hh"))').strips;
  assert.equal(strips[0].mute.pressed, true);
  assert.equal(strips[0].sounding, false);
  assert.equal(strips[1].sounding, true);
});

test('a label the mixer cannot read disables M and S with the shape sentence; an Unnamed track is disabled', () => {
  const strip = build('S_: s("bd")').strips[0];
  assert.equal(strip.mute.disabled, true);
  assert.equal(strip.mute.reasonText, MIXER_COPY.reasons['unsupported-shape']);
  assert.equal(strip.solo.disabled, true);
  const unnamed = build('const on = true\non ? s("bd") : s("hh")').strips[0];
  assert.equal(unnamed.name, 'Unnamed 1');
  assert.equal(unnamed.editable, false);
});

// --- Chips and the Add effect list ---

const chipsOf = (code, index = 0) => build(code).strips[index].chips;
const addNames = (code, index = 0) => build(code).strips[index].addList.map((item) => item.name);

test('MIXER_COPY holds the chain copy', () => {
  assert.equal(MIXER_COPY.addEffect, 'Add effect');
  assert.equal(MIXER_COPY.off, 'off');
  assert.equal(MIXER_COPY.moving, 'moving');
  assert.equal(MIXER_COPY.bypassTitle, 'Bypass (removes it from the code while off)');
});

test('chips follow the fixed chain order, whatever the order in the code', () => {
  const chips = chipsOf('drums: s("bd").phaser(2).crush(8).pan(0.3).lpf(1200).vowel("a")');
  assert.deepEqual(chips.map((chip) => chip.name), ['Lowpass', 'Vowel', 'Crush', 'Pan', 'Phaser']);
  assert.deepEqual(chips.map((chip) => chip.effect), ['lpf', 'vowel', 'crush', 'pan', 'phaser']);
});

test('a track with no effects has no chip and offers all eleven effects in chain order', () => {
  const strip = build('drums: s("bd")').strips[0];
  assert.deepEqual(strip.chips, []);
  assert.deepEqual(strip.addList.map((item) => item.name), ['Lowpass', 'Highpass', 'Bandpass', 'Vowel', 'Coarse', 'Crush', 'Distort', 'Tremolo', 'Compressor', 'Pan', 'Phaser']);
  assert.deepEqual(strip.addList.map((item) => item.method), ['lpf', 'hpf', 'bpf', 'vowel', 'coarse', 'crush', 'distort', 'tremolosync', 'compressor', 'pan', 'phaser']);
});

test('the add list holds only the effects the track lacks, in chain order, and is empty when it has all eleven', () => {
  assert.deepEqual(addNames('drums: s("bd").crush(8).lpf(1200)'), ['Highpass', 'Bandpass', 'Vowel', 'Coarse', 'Distort', 'Tremolo', 'Compressor', 'Pan', 'Phaser']);
  const all = 'drums: s("bd").lpf(1).hpf(1).bpf(1).vowel("a").coarse(1).crush(1).distort(1).tremolo(1).compressor(-1).pan(1).phaser(1)';
  assert.equal(build(all).strips[0].chips.length, 11);
  assert.deepEqual(build(all).strips[0].addList, []);
});

test('a refused strip has no chain', () => {
  const strip = build('bad: (1 ? s("bd") : s("hh")).lpf(300)').strips[0];
  assert.equal(strip.editable, false);
  assert.deepEqual(strip.chips, []);
  assert.deepEqual(strip.addList, []);
});

test('a chip summary is the first written parameter with its unit, plus the count of the others', () => {
  const summary = (code) => chipsOf(code)[0].summary;
  assert.equal(summary('d: s("bd").lpf(1200)'), '1200 Hz');
  assert.equal(summary('d: s("bd").lpf(1200).lpq(4)'), '1200 Hz +1');
  assert.equal(summary('d: s("bd").lpq(4)'), '4');
  assert.equal(summary('d: s("bd").compressor("-20:4")'), '−20 dB +1');
  assert.equal(summary('d: s("bd").compressor(-20)'), '−20 dB');
  assert.equal(summary('d: s("bd").vowel("oe")'), 'oe');
  assert.equal(summary('d: s("bd").tremolosync(4)'), '4 per cycle');
  assert.equal(summary('d: s("bd").tremolo(6)'), '6 Hz');
  assert.equal(summary('d: s("bd").pan(0.25)'), '0.25');
  assert.equal(summary('d: s("bd").crush(8)'), '8');
});

test('a parameter that is a pattern reads moving', () => {
  assert.equal(chipsOf('d: s("bd").lpf(sine.range(400, 2000))')[0].summary, 'moving');
  assert.equal(chipsOf('d: s("bd").lpf("<300 500>")')[0].summary, 'moving');
  assert.equal(chipsOf('d: s("bd").lpf("300:4")')[0].summary, 'moving +1');
});

test('a chip carries its full text as a title', () => {
  const chip = chipsOf('d: s("bd").lpf(1200)')[0];
  assert.equal(chip.title, 'Lowpass 1200 Hz');
  assert.equal(chip.bypassed, false);
});

test('mixerHistoryLabel names an added effect by its plain name in lower case', () => {
  assert.equal(mixerHistoryLabel({ kind: 'add-effect', name: 'drums', effect: 'hpf' }), 'mixer: drums added highpass');
  assert.equal(mixerHistoryLabel({ kind: 'add-effect', name: 'bass', effect: 'compressor' }), 'mixer: bass added compressor');
  assert.throws(() => mixerHistoryLabel({ kind: 'add-effect', name: 'bass', effect: 'reverb' }), /unknown mixer effect/);
});

// --- Bypass records and bypassed chips ---

import {
  BYPASS_RECORD_CAP,
  BYPASS_STORAGE_KEY,
  forgetBypass,
  readBypassRecords,
  rememberBypass,
  writeBypassRecords,
} from '../page/mixer-model.js';

/** A storage object like localStorage, over a Map. */
function fakeStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
  };
}
const throwingStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
const lowpassRecord = { identity: 'label:drums', effect: 'lpf', calls: [{ method: 'lpf', value: 800 }, { method: 'lpq', value: 4 }] };

test('the bypass records live under one storage key, capped at 64', () => {
  assert.equal(BYPASS_STORAGE_KEY, 'moontide.mixerBypass');
  assert.equal(BYPASS_RECORD_CAP, 64);
  assert.equal(MIXER_COPY.bypassNeedsFixed, 'Bypass needs fixed values; use a fixed value first, or Remove.');
});

test('readBypassRecords reads valid records and reports a missing or blocked storage', () => {
  const storage = fakeStorage({ [BYPASS_STORAGE_KEY]: JSON.stringify([lowpassRecord]) });
  assert.deepEqual(readBypassRecords(storage), { records: [lowpassRecord], available: true });
  assert.deepEqual(readBypassRecords(fakeStorage()), { records: [], available: true });
  assert.deepEqual(readBypassRecords(throwingStorage), { records: [], available: false });
  assert.deepEqual(readBypassRecords(null), { records: [], available: false });
});

test('readBypassRecords drops anything outside the closed shape and never throws', () => {
  const read = (value) => readBypassRecords(fakeStorage({ [BYPASS_STORAGE_KEY]: typeof value === 'string' ? value : JSON.stringify(value) })).records;
  assert.deepEqual(read('{not json'), []);
  assert.deepEqual(read({ identity: 'label:drums' }), []); // not an array
  assert.deepEqual(read('null'), []);
  const good = lowpassRecord;
  const bad = [
    { ...good, effect: 'reverb' },
    { ...good, effect: 5 },
    { ...good, identity: '' },
    { ...good, identity: 'x'.repeat(501) },
    { ...good, identity: 7 },
    { ...good, calls: [{ method: 'crush', value: 4 }] }, // a method that is not the effect's own
    { ...good, calls: [{ method: 'lpf', value: 1e9 }] }, // a number outside its range
    { ...good, calls: [{ method: 'lpf', value: '800' }] },
    { identity: 'label:drums', effect: 'vowel', calls: [{ method: 'vowel', value: 'zz' }] }, // a string outside its list
    { ...good, calls: [] },
    { ...good, calls: 'lpf(800)' },
    null,
    'text',
    12,
  ];
  assert.deepEqual(read([...bad, good]), [good]);
  // Only the known fields survive.
  assert.deepEqual(read([{ ...good, extra: 1, calls: [{ method: 'lpf', value: 800, note: 'x' }] }]), [{ identity: 'label:drums', effect: 'lpf', calls: [{ method: 'lpf', value: 800 }] }]);
});

test('readBypassRecords keeps at most the newest 64 records', () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ identity: `label:t${i}`, effect: 'lpf', calls: [{ method: 'lpf', value: 800 }] }));
  const { records } = readBypassRecords(fakeStorage({ [BYPASS_STORAGE_KEY]: JSON.stringify(many) }));
  assert.equal(records.length, 64);
  assert.equal(records[0].identity, 'label:t6');
  assert.equal(records[63].identity, 'label:t69');
});

test('writeBypassRecords stores the records and returns false, never throws, on a failing storage', () => {
  const storage = fakeStorage();
  assert.equal(writeBypassRecords(storage, [lowpassRecord]), true);
  assert.deepEqual(JSON.parse(storage.items.get(BYPASS_STORAGE_KEY)), [lowpassRecord]);
  assert.equal(writeBypassRecords(throwingStorage, [lowpassRecord]), false);
  assert.equal(writeBypassRecords(null, [lowpassRecord]), false);
});

test('rememberBypass replaces the record of the same track and effect; forgetBypass removes it', () => {
  const other = { identity: 'label:hats', effect: 'lpf', calls: [{ method: 'lpf', value: 500 }] };
  const updated = { ...lowpassRecord, calls: [{ method: 'lpf', value: 1200 }] };
  let records = rememberBypass([], lowpassRecord);
  records = rememberBypass(records, other);
  records = rememberBypass(records, updated);
  assert.deepEqual(records, [other, updated]);
  assert.deepEqual(forgetBypass(records, 'label:drums', 'lpf'), [other]);
  assert.deepEqual(forgetBypass(records, 'label:drums', 'crush'), records);
  const full = Array.from({ length: 64 }, (_, i) => ({ identity: `label:t${i}`, effect: 'lpf', calls: [{ method: 'lpf', value: 800 }] }));
  const grown = rememberBypass(full, lowpassRecord);
  assert.equal(grown.length, 64);
  assert.equal(grown[0].identity, 'label:t1');
  assert.deepEqual(grown[63], lowpassRecord);
});

test('a bypassed effect is a chip reading off in its chain slot, and is not offered by the add list', () => {
  const model = buildMixerModel({ code: 'drums: s("bd").crush(8).pan(0.3)', parse, colorOf, bypassRecords: [lowpassRecord] });
  const strip = model.strips[0];
  assert.deepEqual(strip.chips.map((chip) => [chip.name, chip.summary, chip.bypassed]), [
    ['Lowpass', 'off', true],
    ['Crush', '8', false],
    ['Pan', '0.3', false],
  ]);
  assert.deepEqual(strip.chips[0].calls, lowpassRecord.calls);
  assert.ok(!strip.addList.some((item) => item.effect === 'lpf'));
  assert.deepEqual(model.staleRecords, []);
});

test('a record of another track does not show, and a record whose effect is back in the code is stale', () => {
  const hats = buildMixerModel({ code: 'drums: s("bd")\nhats: s("hh")', parse, colorOf, bypassRecords: [{ ...lowpassRecord, identity: 'label:hats' }] });
  assert.deepEqual(hats.strips[0].chips, []);
  assert.deepEqual(hats.strips[1].chips.map((chip) => chip.name), ['Lowpass']);
  const back = buildMixerModel({ code: 'drums: s("bd").lpf(300)', parse, colorOf, bypassRecords: [lowpassRecord] });
  assert.deepEqual(back.strips[0].chips.map((chip) => [chip.name, chip.summary, chip.bypassed]), [['Lowpass', '300 Hz', false]]);
  assert.deepEqual(back.staleRecords, [{ identity: 'label:drums', effect: 'lpf' }]);
});

test('a chip whose value moves has its bypass disabled with the fixed-values reason', () => {
  const [chip] = chipsOf('drums: s("bd").lpf(sine.range(400, 2000))');
  assert.equal(chip.summary, 'moving');
  assert.equal(chip.bypassDisabled, true);
  assert.equal(chip.bypassReason, 'Bypass needs fixed values; use a fixed value first, or Remove.');
  const [fixed] = chipsOf('drums: s("bd").lpf(300)');
  assert.equal(fixed.bypassDisabled, false);
  assert.equal(fixed.bypassReason, null);
});

test('mixerHistoryLabel names a bypass, a return and a removal', () => {
  assert.equal(mixerHistoryLabel({ kind: 'bypass', name: 'drums', effect: 'lpf' }), 'mixer: drums bypassed lowpass');
  assert.equal(mixerHistoryLabel({ kind: 'restore', name: 'drums', effect: 'lpf' }), 'mixer: drums lowpass back on');
  assert.equal(mixerHistoryLabel({ kind: 'remove', name: 'drums', effect: 'lpf' }), 'mixer: drums removed lowpass');
});

// --- The inspector ---

const inspect = (code, effect, bypassRecords = []) => {
  const model = buildMixerModel({ code, parse, colorOf, bypassRecords });
  return inspectorModel({ model, selection: { identity: 'label:drums', effect } });
};
const rowOf = (data, param) => data.rows.find((row) => row.param === param);

test('MIXER_COPY holds the inspector strings', () => {
  assert.equal(MIXER_COPY.close, 'Close');
  assert.equal(MIXER_COPY.moreParams, 'More parameters ({N})');
  assert.equal(MIXER_COPY.fewerParams, 'Fewer parameters');
  assert.equal(MIXER_COPY.writtenAs, 'Written as');
  assert.equal(MIXER_COPY.bypassedLine, 'Bypassed — not in the code.');
  assert.equal(MIXER_COPY.untouched, "Parameters you don't touch keep Strudel's default and are not written.");
  assert.equal(MIXER_COPY.remove, 'Remove');
  assert.equal(MIXER_COPY.gone, 'This effect is no longer in the code.');
  assert.equal(MIXER_COPY.movingFromCode, 'Moving (from code)');
  assert.equal(MIXER_COPY.useFixed, 'Use a fixed value');
  assert.equal(MIXER_COPY.defaultButton, 'Default');
});

test('the inspector lists the basic parameters first and counts the rest', () => {
  const data = inspect('drums: s("bd").lpf(1200)', 'lpf');
  assert.equal(data.title, 'Lowpass · drums');
  assert.deepEqual(data.rows.map((row) => row.param), ['cutoff', 'resonance']);
  assert.equal(data.moreCount, 1);
  assert.equal(data.writtenText, '.lpf(1200)');
  assert.equal(data.gone, false);
  assert.equal(data.bypassed, false);
  const cutoff = rowOf(data, 'cutoff');
  assert.deepEqual([cutoff.kind, cutoff.value, cutoff.unit, cutoff.defaultShown, cutoff.showDefaultButton, cutoff.scale], ['number', 1200, 'Hz', false, false, 'log']);
  assert.deepEqual(cutoff.slider, { min: 0, max: 1000, step: 1, value: cutoff.slider.value });
  assert.ok(cutoff.slider.value > 500 && cutoff.slider.value < 700);
  assert.equal(inspect('drums: s("bd").compressor("-20:4")', 'compressor').moreCount, 3);
  assert.deepEqual(inspect('drums: s("bd").compressor("-20:4")', 'compressor').rows.map((row) => row.param), ['threshold', 'ratio', 'knee', 'attack', 'release']);
  assert.deepEqual(inspect('drums: s("bd").tremolosync(4)', 'tremolo').rows.map((row) => row.param), ['speed', 'depth', 'shape']);
});

test('an unwritten parameter shows its default, the resonance default is 1 and an unwritten shape shows default', () => {
  const lowpass = inspect('drums: s("bd").lpf(1200)', 'lpf');
  const resonance = rowOf(lowpass, 'resonance');
  assert.deepEqual([resonance.defaultShown, resonance.value, resonance.subText, resonance.showDefaultButton], [true, 1, 'default', false]);
  const shape = rowOf(inspect('drums: s("bd").tremolosync(4)', 'tremolo'), 'shape');
  assert.deepEqual([shape.kind, shape.value, shape.defaultShown, shape.subText], ['select', '', true, 'default']);
  assert.deepEqual(shape.options, ['sine', 'tri', 'square', 'saw', 'ramp']);
});

test('a written parameter that is not the first offers Default; the first never does', () => {
  const data = inspect('drums: s("bd").lpf(1200).lpq(4)', 'lpf');
  assert.equal(rowOf(data, 'resonance').showDefaultButton, true);
  assert.equal(rowOf(data, 'resonance').subText, '');
  assert.equal(rowOf(data, 'cutoff').showDefaultButton, false);
  assert.equal(rowOf(data, 'cutoff').subText, 'Hz');
  assert.equal(rowOf(data, 'resonance').defaultShown, false);
});

test('a parameter that moves is a moving row with no value and a fixed value to offer', () => {
  const data = inspect('drums: s("bd").lpf(sine.range(400, 2000)).vowel("a e")', 'lpf');
  const cutoff = rowOf(data, 'cutoff');
  assert.deepEqual([cutoff.kind, cutoff.value, cutoff.slider, cutoff.fixedValue], ['moving', null, null, 2000]);
  assert.equal(data.writtenText, '.lpf(sine.range(400, 2000))');
  const vowel = rowOf(inspect('drums: s("bd").vowel("a e")', 'vowel'), 'vowel');
  assert.deepEqual([vowel.kind, vowel.fixedValue], ['moving', 'a']);
  const compressor = inspect('drums: s("bd").compressor(sine.range(-30, -10))', 'compressor');
  assert.ok(compressor.rows.every((row) => row.kind === 'moving'));
});

test('the tremolo speed row follows the form the code wrote last, with that form range and unit', () => {
  const hz = rowOf(inspect('drums: s("bd").tremolo(4)', 'tremolo'), 'speed');
  assert.deepEqual([hz.unit, hz.min, hz.max, hz.step, hz.value], ['Hz', 0.1, 32, 0.1, 4]);
  const cycles = rowOf(inspect('drums: s("bd").tremolosync(2)', 'tremolo'), 'speed');
  assert.deepEqual([cycles.unit, cycles.min, cycles.max, cycles.step, cycles.value], ['per cycle', 0.25, 16, 0.25, 2]);
  const both = rowOf(inspect('drums: s("bd").tremolo(4).tremolosync(2)', 'tremolo'), 'speed');
  assert.deepEqual([both.unit, both.value], ['per cycle', 2]);
  const unwritten = rowOf(inspect('drums: s("bd").tremolodepth(0.5)', 'tremolo'), 'speed');
  assert.deepEqual([unwritten.defaultShown, unwritten.unit, unwritten.value], [true, 'per cycle', 4]);
});

test('an effect that left the code is gone, and so is a track that left', () => {
  const model = buildMixerModel({ code: 'drums: s("bd")', parse, colorOf });
  const gone = inspectorModel({ model, selection: { identity: 'label:drums', effect: 'lpf' } });
  assert.deepEqual([gone.gone, gone.rows, gone.title], [true, [], 'Lowpass']);
  assert.equal(inspectorModel({ model, selection: { identity: 'label:hats', effect: 'lpf' } }).gone, true);
  assert.equal(inspectorModel({ model, selection: null }), null);
  assert.equal(inspectorModel({ model: { status: 'empty', strips: [] }, selection: { identity: 'label:drums', effect: 'lpf' } }), null);
});

test('a bypassed effect shows its stored values read-only and is not editable', () => {
  const record = { identity: 'label:drums', effect: 'lpf', calls: [{ method: 'lpf', value: 800 }, { method: 'lpq', value: 4 }] };
  const data = inspect('drums: s("bd")', 'lpf', [record]);
  assert.equal(data.bypassed, true);
  assert.equal(data.editable, false);
  assert.equal(data.writtenText, '');
  assert.deepEqual([rowOf(data, 'cutoff').value, rowOf(data, 'resonance').value], [800, 4]);
  assert.equal(rowOf(data, 'cutoff').readOnly, true);
  assert.equal(inspect('drums: s("bd").lpf(800)', 'lpf').editable, true);
  assert.equal(buildMixerModel({ code: 'drums: s("bd").lpf(800)', parse, colorOf }).strips[0].editable, true);
});

test('the inspector of a strip the mixer cannot edit is not editable', () => {
  const model = buildMixerModel({ code: 'drums: (1 ? s("bd") : s("hh")).lpf(300)', parse, colorOf });
  const data = inspectorModel({ model, selection: { identity: 'label:drums', effect: 'lpf' } });
  assert.equal(data.editable, false);
});

test('history labels name a parameter, its default and a fixed value in lower case', () => {
  assert.equal(mixerHistoryLabel({ kind: 'param', name: 'drums', effect: 'lpf', param: 'cutoff', value: 1230 }), 'mixer: drums lowpass cutoff 1230');
  assert.equal(mixerHistoryLabel({ kind: 'param', name: 'drums', effect: 'vowel', param: 'vowel', value: 'o' }), 'mixer: drums vowel vowel o');
  assert.equal(mixerHistoryLabel({ kind: 'param', name: 'drums', effect: 'compressor', param: 'knee', value: 6 }), 'mixer: drums compressor knee 6');
  assert.equal(mixerHistoryLabel({ kind: 'param-default', name: 'drums', effect: 'lpf', param: 'resonance' }), 'mixer: drums lowpass resonance default');
  assert.equal(mixerHistoryLabel({ kind: 'remove-effect', name: 'drums', effect: 'lpf' }), 'mixer: drums removed lowpass');
  assert.throws(() => mixerHistoryLabel({ kind: 'param', name: 'drums', effect: 'lpf', param: 'nope', value: 1 }), /Moontide: /);
});

// --- Filter moves ---

test('a filter move opens in Moves, a fixed cutoff in Fixed, and any other pattern stays Moving (from code)', () => {
  const inspect = (code) => inspectorModel({ model: build(code), selection: { identity: 'label:drums', effect: 'lpf' } });
  const moved = inspect('drums: s("bd").lpf(sine.range(400, 2000).slow(8))').rows[0];
  assert.equal(moved.mode, 'moves');
  assert.equal(moved.kind, 'move');
  assert.deepEqual(moved.move, { shape: 'sine', from: 400, to: 2000, over: 8 });
  const fixed = inspect('drums: s("bd").lpf(1200)').rows[0];
  assert.equal(fixed.mode, 'fixed');
  assert.equal(fixed.kind, 'number');
  const other = inspect('drums: s("bd").lpf(perlin.range(400, 2000))').rows[0];
  assert.equal(other.kind, 'moving');
  assert.equal(other.mode, undefined);
  assert.equal(inspect('drums: s("bd").lpf(1200).lpq(4)').rows[1].mode, undefined);
});

test('a moving filter chip reads its range with an en dash, and the history label names From, To and Over', () => {
  const model = build('drums: s("bd").lpf(sine.range(400, 2000).slow(8))');
  assert.equal(model.strips[0].chips[0].summary, '400\u20132000 Hz');
  assert.equal(mixerHistoryLabel({ kind: 'move', name: 'drums', effect: 'lpf', from: 400, to: 2000, over: 16 }), 'mixer: drums lowpass moves 400 to 2000 over 16 cycles');
  assert.equal(mixerHistoryLabel({ kind: 'move', name: 'hats', effect: 'bpf', from: 2000, to: 500, over: 1 }), 'mixer: hats bandpass moves 2000 to 500 over 1 cycles');
  assert.equal(MIXER_COPY.moves, 'Moves');
  assert.equal(MIXER_COPY.fixed, 'Fixed');
  assert.equal(MIXER_COPY.from, 'From (Hz)');
  assert.equal(MIXER_COPY.to, 'To (Hz)');
  assert.equal(MIXER_COPY.over, 'Over (cycles)');
  assert.equal(MIXER_COPY.shape, 'Shape');
});

test('readBypassRecords keeps a valid stored move and drops one outside the shapes, the whole cycles or the range', () => {
  const record = (move) => ({ identity: 'label:drums', effect: 'lpf', calls: [{ method: 'lpf', move }] });
  const read = (value) => readBypassRecords(fakeStorage({ [BYPASS_STORAGE_KEY]: JSON.stringify(value) })).records;
  const good = record({ shape: 'saw', from: 400, to: 2000, over: 8 });
  assert.deepEqual(read([good]), [good]);
  assert.deepEqual(read([record({ shape: 'saw', from: 400, to: 2000, over: 8, note: 'x' })]), [good]);
  const bad = [
    record({ shape: 'square', from: 400, to: 2000, over: 8 }),
    record({ shape: 'sine', from: 400, to: 2000, over: 0 }),
    record({ shape: 'sine', from: 400, to: 2000, over: 65 }),
    record({ shape: 'sine', from: 400, to: 2000, over: 1.5 }),
    record({ shape: 'sine', from: 5, to: 2000, over: 8 }),
    record({ shape: 'sine', from: 400, to: 25000, over: 8 }),
    record({ shape: 'sine', from: '400', to: 2000, over: 8 }),
  ];
  assert.deepEqual(read([...bad, good]), [good]);
});

test('a bypassed filter move shows its stored range read-only, and the chip stays bypassable while it moves', () => {
  const model = build('drums: s("bd").lpf(sine.range(400, 2000).slow(8))');
  assert.equal(model.strips[0].chips[0].bypassDisabled, false);
  const record = { identity: 'label:drums', effect: 'lpf', calls: [{ method: 'lpf', move: { shape: 'tri', from: 300, to: 3000, over: 4 } }] };
  const off = buildMixerModel({ code: 'drums: s("bd").gain(0)', parse, colorOf, bypassRecords: [record] });
  const data = inspectorModel({ model: off, selection: { identity: 'label:drums', effect: 'lpf' } });
  assert.equal(data.bypassed, true);
  assert.equal(data.editable, false);
  assert.equal(data.rows[0].mode, 'moves');
  assert.deepEqual(data.rows[0].move, { shape: 'tri', from: 300, to: 3000, over: 4 });
});

// --- Sends and buses ---

const sendsOf = (model, index = 0) => Object.fromEntries(model.strips[index].sends.map((send) => [send.bus, send]));

test('every strip has a Reverb and a Delay send: a send at 0 reads 0.00 muted, one that moves is moving and disabled', () => {
  const model = build('drums: s("bd").room(0.3)\nhats: s("hh").delay("<0.1 0.4>")\nbad: (y => y)');
  const drums = sendsOf(model, 0);
  assert.deepEqual(model.strips[0].sends.map((send) => send.bus), ['reverb', 'delay']);
  assert.equal(drums.reverb.readout, '0.30');
  assert.equal(drums.reverb.position, 0.3);
  assert.equal(drums.reverb.muted, false);
  assert.equal(drums.delay.readout, '0.00');
  assert.equal(drums.delay.muted, true);
  assert.equal(drums.delay.moving, false);
  const hats = sendsOf(model, 1);
  assert.equal(hats.delay.moving, true);
  assert.equal(hats.delay.title, MIXER_COPY.sendMoving);
  assert.equal(MIXER_COPY.sendMoving, 'The send moves in the code. Ask Claude to change it.');
  // A strip the mixer cannot read has both send rows, off.
  assert.equal(sendsOf(model, 2).reverb.disabled, true);
});

test('a strip built from shared code that sets its own orbit has its sends off with the reason, and feeds no bus strip', () => {
  const model = build('const beat = s("bd").orbit(2).room(0.4)\nkick: beat\nhats: s("hh").room(0.2)\nlead: s("cp")');
  const [kick, hats, lead] = model.strips;
  assert.equal(kick.busHidden, true);
  assert.equal(kick.orbit, null);
  assert.equal(kick.busReads, null);
  for (const send of kick.sends) {
    assert.equal(send.disabled, true, send.bus);
    assert.equal(send.title, MIXER_COPY.sendsHidden, send.bus);
  }
  assert.equal(MIXER_COPY.sendsHidden, "This track sets its own orbit or bus values somewhere the mixer can't read. Ask Claude to change its sends.");
  // Only the track that reads its orbit from its own chain feeds the reverb bus.
  assert.deepEqual(model.buses.map((bus) => [bus.bus, bus.fedBy]), [['reverb', ['hats']]]);
  for (const strip of [hats, lead]) {
    assert.equal(strip.busHidden, false);
    assert.equal(strip.sends.every((send) => !send.disabled), true);
  }
  // Its fader and effects still work: only the bus is hidden.
  assert.equal(kick.fader.disabled, false);
});

test('a strip with hidden bus facts shows the send its own chain writes, and none for a send it cannot know', () => {
  const [kick, hats] = build('const beat = s("bd").orbit(2)\nkick: beat.room(0.4)\nhats: s("hh").room(0.2)').strips;
  const [reverb, delay] = kick.sends;
  assert.equal(kick.busHidden, true);
  assert.equal(reverb.readout, '0.40');
  assert.equal(reverb.position, 0.4);
  assert.equal(reverb.muted, false);
  assert.equal(reverb.disabled, true);
  assert.equal(reverb.title, MIXER_COPY.sendsHidden);
  // The code the mixer does not read may set the delay send: it shows none, not 0.00.
  assert.equal(delay.readout, MIXER_COPY.noSendValue);
  assert.equal(delay.disabled, true);
  assert.equal(MIXER_COPY.noSendValue, '\u2013');
  // A strip with readable bus facts still shows 0.00 for a send it does not write.
  assert.deepEqual(hats.sends.map((send) => send.readout), ['0.20', '0.00']);
});

test('a strip whose orbit is set through a helper or an object has its sends off with the reason and feeds no bus strip', () => {
  const code = 'const fx = p => p.orbit(2)\nkick: s("bd").apply(fx).room(0.4)\nsnare: s("cp").set({ orbit: 2 }).room(0.4)\nhats: s("hh").room(0.2)';
  const model = build(code);
  const [kick, snare, hats] = model.strips;
  for (const strip of [kick, snare]) {
    assert.equal(strip.busHidden, true);
    assert.equal(strip.busReads, null);
    assert.equal(strip.sends.every((send) => send.disabled && send.title === MIXER_COPY.sendsHidden), true);
  }
  assert.equal(hats.busHidden, false);
  assert.deepEqual(model.buses.map((bus) => [bus.bus, bus.fedBy]), [['reverb', ['hats']]]);
});

test('the history label of a send names the track, the bus and the value', () => {
  assert.equal(mixerHistoryLabel({ kind: 'send', name: 'drums', bus: 'reverb', value: 0.3 }), 'mixer: drums reverb send 0.3');
  assert.equal(mixerHistoryLabel({ kind: 'send', name: 'hats', bus: 'delay', value: 0.25 }), 'mixer: hats delay send 0.25');
  assert.throws(() => mixerHistoryLabel({ kind: 'send', name: 'drums', bus: 'chorus', value: 0.3 }), /unknown send/);
});

test('one Reverb bus strip per orbit that has a sending track, fed by the tracks that send; no sender, no strip', () => {
  assert.deepEqual(build('drums: s("bd")\nhats: s("hh")').buses, []);
  assert.deepEqual(build('drums: s("bd").room(0)\nhats: s("hh")').buses, []);
  const model = build('drums: s("bd").room(0.3)\nhats: s("hh").room(0.2).delay(0.1)\nbass: s("sd")');
  assert.deepEqual(model.buses.map((bus) => [bus.bus, bus.title, bus.fedBy, bus.fedByText]), [
    ['reverb', 'Reverb bus', ['drums', 'hats'], 'Fed by drums, hats'],
    ['delay', 'Delay bus', ['hats'], 'Fed by hats'],
  ]);
  assert.equal(MIXER_COPY.fedBy, 'Fed by {names}');
  assert.equal(MIXER_COPY.fedByNone, 'Fed by no track');
  // A send that moves in the code still feeds the bus.
  assert.deepEqual(build('drums: s("bd").room("<0.2 0.5>")').buses.map((bus) => bus.fedBy), [['drums']]);
});

test('a bus strip has one chip per parameter: the value, default when written nowhere', () => {
  const bus = build('drums: s("bd").room(0.3).roomsize(4)').buses[0];
  assert.deepEqual(bus.chips, [
    { param: 'size', name: 'Size', valueText: '4' },
    { param: 'fade', name: 'Fade', valueText: 'default' },
    { param: 'lowpass', name: 'Lowpass', valueText: 'default' },
    { param: 'damping', name: 'Damping', valueText: 'default' },
  ]);
});

test('a track that starts sending is given the values the bus has now: the senders first, then the bus memory', () => {
  const model = build('drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh")');
  assert.deepEqual(sendsOf(model, 1).reverb.joinParams, { size: 4 });
  assert.deepEqual(sendsOf(model, 1).delay.joinParams, {});
  // The last sender goes to 0: the bus strip is gone, its values are remembered for the next sender.
  const dropped = buildMixerModel({ code: 'drums: s("bd")\nhats: s("hh")', parse, colorOf, busMemory: model.busMemory });
  assert.deepEqual(dropped.buses, []);
  assert.deepEqual(sendsOf(dropped, 0).reverb.joinParams, { size: 4 });
  assert.equal(model.busMemory.get('1:reverb').size, 4);
});

test('the bus history label names the bus and the parameter, never a track', () => {
  assert.equal(mixerHistoryLabel({ kind: 'bus-param', bus: 'reverb', param: 'size', value: 4 }), 'mixer: reverb size 4');
  assert.equal(mixerHistoryLabel({ kind: 'bus-param', bus: 'delay', param: 'feedback', value: 0.4 }), 'mixer: delay feedback 0.4');
  assert.equal(mixerHistoryLabel({ kind: 'bus-param', bus: 'reverb', param: 'damping', value: 800 }), 'mixer: reverb damping 800');
  assert.throws(() => mixerHistoryLabel({ kind: 'bus-param', bus: 'reverb', param: 'time', value: 1 }), /unknown bus parameter/);
});

test('the reverb bus inspector: Size and Fade first, Lowpass and Damping under More, and the on-release note', () => {
  const model = build('drums: s("bd").room(0.3).roomsize(4)\nhats: s("hh").room(0.2)');
  const data = inspectorModel({ model, selection: { bus: 'reverb', orbit: 1 } });
  assert.equal(data.kind, 'bus');
  assert.equal(data.title, 'Reverb bus');
  assert.deepEqual(data.rows.map((row) => [row.param, row.basic, row.costly]), [['size', true, true], ['fade', true, true], ['lowpass', false, true], ['damping', false, true]]);
  assert.equal(data.moreCount, 2);
  assert.equal(data.note, 'Size, fade, lowpass and damping recalculate the reverb, so they apply when you let go.');
  assert.equal(data.editable, true);
  const [size, fade, lowpass] = data.rows;
  assert.equal(size.value, 4);
  assert.equal(size.defaultShown, false);
  assert.equal(size.slider.value, 4);
  assert.equal(size.showDefaultButton, false);
  // Written nowhere: Strudel's own default is shown, marked default.
  assert.deepEqual([fade.value, fade.defaultShown, fade.subText], [0.1, true, 'default']);
  assert.deepEqual([lowpass.value, lowpass.unit, lowpass.scale, lowpass.slider.max], [15000, 'Hz', 'log', 1000]);
});

test('the delay bus inspector: an unwritten time shows default, and its note warns about feedback near 1', () => {
  const model = build('drums: s("bd").delay(0.3).delayfeedback(0.4)');
  const data = inspectorModel({ model, selection: { bus: 'delay', orbit: 1 } });
  assert.equal(data.title, 'Delay bus');
  assert.deepEqual(data.rows.map((row) => [row.param, row.basic, row.costly]), [['time', true, false], ['feedback', true, false]]);
  assert.equal(data.moreCount, 0);
  assert.equal(data.note, 'Feedback near 1 runs away. Keep it below 0.9.');
  const [time, feedback] = data.rows;
  assert.deepEqual([time.value, time.defaultShown, time.subText, time.max], [null, true, 'default', 1]);
  assert.deepEqual([feedback.value, feedback.max], [0.4, 0.95]);
});

test('a bus parameter a sender moves in the code is a read-only moving row', () => {
  const model = build('drums: s("bd").room(0.3).roomsize("<2 4>")');
  const data = inspectorModel({ model, selection: { bus: 'reverb', orbit: 1 } });
  assert.equal(data.rows[0].kind, 'moving');
  assert.equal(data.rows[0].slider, null);
  assert.equal(model.buses[0].chips[0].valueText, 'moving');
});

test('a bus with no sender is gone, unless its inspector is open: then it stays with Fed by no track and its remembered values', () => {
  const model = build('drums: s("bd").room(0.3).roomsize(4)');
  assert.equal(inspectorModel({ model: build('drums: s("bd")'), selection: { bus: 'reverb', orbit: 1 } }).gone, true);
  const kept = buildMixerModel({ code: 'drums: s("bd")', parse, colorOf, busMemory: model.busMemory, keepBus: { orbit: 1, bus: 'reverb' } });
  assert.deepEqual(kept.buses.map((entry) => [entry.title, entry.fedByText, entry.editable, entry.chips[0].valueText]), [['Reverb bus', 'Fed by no track', false, '4']]);
  const data = inspectorModel({ model: kept, selection: { bus: 'reverb', orbit: 1 } });
  assert.equal(data.gone, false);
  assert.equal(data.editable, false);
  assert.equal(data.rows[0].readOnly, true);
});

// --- Disagreement, alignment and orbits ---

const busEntry = (code, id) => build(code).buses.find((entry) => entry.bus === id);

test('reverb: two different written sizes disagree, a written and an unwritten one do not', () => {
  const disagree = busEntry('drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").room(0.2).roomsize(6)', 'reverb');
  assert.deepEqual(disagree.disagree, ['size']);
  assert.equal(disagree.chips[0].valueText, 'mixed');
  assert.equal(disagree.chips[1].valueText, 'default');
  const same = busEntry('drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").room(0.2).size(2)', 'reverb');
  assert.deepEqual(same.disagree, []);
  assert.equal(same.chips[0].valueText, '2');
  assert.equal(same.warningText, null);
  const unwritten = busEntry('drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").room(0.2)', 'reverb');
  assert.deepEqual(unwritten.disagree, []);
  assert.equal(unwritten.chips[0].valueText, '2');
});

test('delay: a written feedback of 0.5 and an unwritten one agree, 0.4 and an unwritten one disagree, so does a time', () => {
  assert.deepEqual(busEntry('drums: s("bd").delay(0.3).delayfeedback(0.5)\nhats: s("hh").delay(0.2)', 'delay').disagree, []);
  const feedback = busEntry('drums: s("bd").delay(0.3).delayfeedback(0.4)\nhats: s("hh").delay(0.2)', 'delay');
  assert.deepEqual(feedback.disagree, ['feedback']);
  assert.equal(feedback.chips[1].valueText, 'mixed');
  const time = busEntry('drums: s("bd").delay(0.3).delaytime(0.2)\nhats: s("hh").delay(0.2)', 'delay');
  assert.deepEqual(time.disagree, ['time']);
  assert.equal(time.chips[0].valueText, 'mixed');
  const agree = busEntry('drums: s("bd").delay(0.3).delayfeedback(0.5)\nhats: s("hh").delay(0.2)', 'delay');
  assert.equal(agree.chips[1].valueText, '0.5');
  assert.equal(agree.chips[0].valueText, 'default');
  // A time written on both agrees when the numbers do.
  assert.deepEqual(busEntry('drums: s("bd").delay(0.3).delaytime(0.2)\nhats: s("hh").delay(0.2).delaytime(0.2)', 'delay').disagree, []);
});

test('the warning names the parameters that differ, in registry order, with the pinned sentence', () => {
  const entry = busEntry('drums: s("bd").room(0.3).roomsize(2).roomfade(1)\nhats: s("hh").room(0.2).roomsize(6).roomfade(3)', 'reverb');
  assert.equal(entry.warningText, 'Tracks disagree on size, fade. Changing any value here sets it on every sending track.');
  assert.equal(MIXER_COPY.mixed, 'mixed');
  assert.equal(MIXER_COPY.disagree, 'Tracks disagree on {names}. Changing any value here sets it on every sending track.');
  // Each bus is judged on its own: a delay disagreement is not a reverb one.
  const both = build('drums: s("bd").room(0.3).roomsize(2).delay(0.3).delayfeedback(0.4)\nhats: s("hh").room(0.2).roomsize(2).delay(0.2)');
  assert.deepEqual(both.buses.map((entry) => [entry.bus, entry.disagree]), [['reverb', []], ['delay', ['feedback']]]);
});

test('alignment takes the first sender in code order that writes the value; the delay aligns to its first sender, unwritten meaning the default', () => {
  const reverb = busEntry('drums: s("bd").room(0.3)\nhats: s("hh").room(0.2).roomsize(6)\nkeys: s("cp").room(0.1).roomsize(2)', 'reverb');
  assert.deepEqual(reverb.disagree, ['size']);
  assert.deepEqual(reverb.alignValues, { size: 6 });
  const delayFirstWrites = busEntry('drums: s("bd").delay(0.3).delayfeedback(0.4)\nhats: s("hh").delay(0.2)', 'delay');
  assert.deepEqual(delayFirstWrites.alignValues, { feedback: 0.4 });
  const delayFirstUnwritten = busEntry('drums: s("bd").delay(0.3)\nhats: s("hh").delay(0.2).delayfeedback(0.4)', 'delay');
  assert.deepEqual(delayFirstUnwritten.alignValues, { feedback: null });
  // The inspector carries the same values, and only for what disagrees.
  const data = inspectorModel({ model: build('drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").room(0.2).roomsize(6)'), selection: { bus: 'reverb', orbit: 1 } });
  assert.deepEqual(data.alignValues, { size: 2 });
  assert.deepEqual(data.disagree, ['size']);
  assert.equal(data.rows[0].mixed, true);
  assert.equal(data.rows[0].value, null);
  assert.equal(data.rows[0].subText, 'mixed');
  assert.deepEqual(inspectorModel({ model: build('drums: s("bd").room(0.3)'), selection: { bus: 'reverb', orbit: 1 } }).alignValues, {});
});

test('each orbit in use has its own bus strips; the title carries the orbit only when more than one is in use', () => {
  const code = 'drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").orbit(2).room(0.2).roomsize(6)';
  const model = build(code);
  assert.deepEqual(model.buses.map((entry) => [entry.title, entry.orbit, entry.fedBy, entry.disagree]), [
    ['Reverb bus \u00b7 orbit 1', 1, ['drums'], []],
    ['Reverb bus \u00b7 orbit 2', 2, ['hats'], []],
  ]);
  assert.equal(build('drums: s("bd").room(0.3)\nhats: s("hh").o(1).room(0.2)').buses[0].title, 'Reverb bus');
  assert.equal(build('drums: s("bd").room(0.3)\nhats: s("hh").orbit(2).room(0.2).delay(0.1)').buses.map((entry) => entry.title).join(', '), 'Reverb bus \u00b7 orbit 1, Reverb bus \u00b7 orbit 2, Delay bus \u00b7 orbit 2');
  // The same bus on two orbits never disagrees with itself.
  assert.deepEqual(inspectorModel({ model, selection: { bus: 'reverb', orbit: 2 } }).rows[0].value, 6);
  // A send row joins the bus of its own orbit.
  assert.deepEqual(sendsOf(build('drums: s("bd").room(0.3).roomsize(2)\nhats: s("hh").orbit(2).room(0.2).roomsize(6)\nkeys: s("cp").orbit(2)'), 2).reverb.joinParams, { size: 6 });
});

test('a track whose orbit moves in the code joins no bus and its send rows are disabled with the reason as title', () => {
  const model = build('drums: s("bd").room(0.3)\nhats: s("hh").orbit("<1 2>").room(0.2)');
  assert.deepEqual(model.buses.map((entry) => entry.fedBy), [['drums']]);
  const hats = sendsOf(model, 1);
  assert.equal(model.strips[1].orbit, null);
  for (const bus of ['reverb', 'delay']) {
    assert.equal(hats[bus].disabled, true);
    assert.equal(hats[bus].title, MIXER_COPY.reasons['unsupported-shape']);
  }
  assert.equal(hats.reverb.value, 0.2);
});

// --- A track that plays a MIDI instrument: the instrument's own volume, and why the controls are off ---

// The controls of the shipped MT-32 model, copied so a test never reads a file.
const MT32_CONTROLS = [
  { id: 'modulation', name: 'Modulation', cc: 1, min: 0, max: 127, default: 0 },
  { id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 },
  { id: 'pan', name: 'Pan', cc: 10, min: 0, max: 127, default: 64 },
  { id: 'expression', name: 'Expression', cc: 11, min: 0, max: 127, default: 127 },
  { id: 'hold', name: 'Hold', cc: 64, min: 0, max: 127, default: 0 },
];
const instrumentWith = (controls) => ({
  id: 'mt32',
  model: 'mt32',
  modelName: 'Model mt32',
  port: 'Port A',
  channels: [{ channel: 3, role: 'melodic' }],
  bankSelect: 'none',
  defaultVolume: 100,
  controls,
  reset: null,
  sounds: { melodic: [], rhythm: [] },
  catalogSounds: 0,
});
const RIG = { setup: 'valid', instruments: [instrumentWith(MT32_CONTROLS)] };
const buildWithRig = (code, rig = RIG) => buildMixerModel({ code, parse, colorOf, rig });
const PAD = `pad: note("c3").midi('Port A', { midichannel: 3, controls: { volume: 90 } })`;

test('a MIDI strip has no effect chain, no sends and no bus facts, even when the track carries a reverb call', () => {
  const model = buildWithRig(`${PAD}.room(0.5)\nhats: s("hh")`);
  const pad = model.strips.find((strip) => strip.identity === 'label:pad');
  assert.notEqual(pad.midi, null);
  assert.deepEqual(pad.chips, []);
  assert.deepEqual(pad.addList, []);
  assert.equal(pad.effectReads.size, 0);
  assert.equal(pad.busReads, null);
  assert.equal(pad.orbit, null);
  assert.deepEqual(model.buses, [], 'no bus strip appears for a MIDI track');
  const hats = model.strips.find((strip) => strip.identity === 'label:hats');
  assert.equal(hats.midi, null, 'a browser track is a browser strip');
  assert.equal(hats.fader.kind, undefined);
});

test('the fader of a MIDI strip reads the written volume, or the model default with the default line', () => {
  const written = buildWithRig(PAD).strips[0];
  assert.deepEqual(
    { kind: written.fader.kind, control: written.fader.control, cc: written.fader.cc, min: written.fader.min, max: written.fader.max, value: written.fader.value, position: written.fader.position, readout: written.fader.readout, readoutMuted: written.fader.readoutMuted, line: written.fader.line, lineText: written.fader.lineText, disabled: written.fader.disabled, ariaValueText: written.fader.ariaValueText },
    { kind: 'midi', control: 'volume', cc: 7, min: 0, max: 127, value: 90, position: 90, readout: '90', readoutMuted: false, line: 'written', lineText: 'instrument volume', disabled: false, ariaValueText: '90' },
  );
  assert.equal(written.fader.lineTitle, "The fader sets the instrument's own volume (CC7). Gain and velocity in the code stay as they are.");
  const { instrumentId, port, channel, sound, reason, reasonText } = written.midi;
  assert.deepEqual({ instrumentId, port, channel, sound, reason, reasonText }, { instrumentId: 'mt32', port: 'Port A', channel: 3, sound: null, reason: null, reasonText: null });
  const unwritten = buildWithRig(`pad: note("c3").midi('Port A', { midichannel: 3 })`).strips[0];
  assert.deepEqual(
    { value: unwritten.fader.value, readout: unwritten.fader.readout, readoutMuted: unwritten.fader.readoutMuted, line: unwritten.fader.line, lineText: unwritten.fader.lineText, lineTitle: unwritten.fader.lineTitle },
    { value: 100, readout: '100', readoutMuted: true, line: 'default', lineText: 'default', lineTitle: null },
  );
  assert.equal(MIXER_COPY.midiFaderLabel.replace('{track}', 'pad'), 'pad instrument volume');
});

test('every reason a MIDI fader is off gives a disabled fader reading an en dash, its exact sentence, and keeps mute and solo', () => {
  const noVolume = { setup: 'valid', instruments: [instrumentWith(MT32_CONTROLS.filter((control) => control.id !== 'volume'))] };
  const cases = [
    ['noModel', PAD, { setup: 'absent' }, 'No instruments.json — describe this instrument there to use its controls.'],
    ['invalidModel', PAD, { setup: 'invalid', problems: [], more: 0 }, "instruments.json is invalid — fix it to use this instrument's controls."],
    ['rigUnreadable', PAD, rigFromReadFailure(new Error('x')), "The page couldn't read the MIDI setup — restart Claude (the server) to use this instrument's controls."],
    ['buildMismatch', PAD, withBuildMismatch({ setup: 'absent' }, true), "The server and the page come from different builds — restart Claude (the server) to use this instrument's controls."],
    ['optionsNotPlain', `const opts = { midichannel: 3 }\npad: note("c3").midi('Port A', opts)`, RIG, "Options aren't plain values — the mixer can't edit this instrument's controls."],
    ['portNotPlain', `pad: note("c3").midi('Port A', { midichannel: 3 }).midi('Port B')`, RIG, "Port or channel isn't plain — the mixer can't edit this instrument's controls."],
    ['portNotInFile', `pad: note("c3").midi('Port Z', { midichannel: 3 })`, RIG, "Port isn't in instruments.json — add it there to use its controls."],
    ['noVolume', PAD, noVolume, "This instrument's model has no volume control."],
  ];
  for (const [reason, code, rig, text] of cases) {
    const strip = buildWithRig(code, rig).strips[0];
    assert.equal(strip.midi.reason, reason, reason);
    assert.equal(strip.midi.reasonText, text, reason);
    assert.equal(MIXER_COPY.midiReasons[reason], text, reason);
    if (reason === 'rigUnreadable' || reason === 'buildMismatch') assert.ok(!text.includes('instruments.json'), reason);
    assert.deepEqual(
      { kind: strip.fader.kind, disabled: strip.fader.disabled, readout: strip.fader.readout, ariaValueText: strip.fader.ariaValueText, value: strip.fader.value, lineText: strip.fader.lineText, control: strip.fader.control },
      { kind: 'midi', disabled: true, readout: '–', ariaValueText: 'unavailable', value: null, lineText: null, control: null },
      reason,
    );
    assert.equal(strip.mute.disabled, false, `${reason}: mute stays on`);
    assert.equal(strip.solo.disabled, false, `${reason}: solo stays on`);
    assert.equal(strip.editable, true, `${reason}: the plain mixer reading is untouched`);
  }
});

test('the reading of a MIDI track keeps the plain mixer reason when the track cannot be read, and the fader is off', () => {
  const strip = buildWithRig(`pad: parts.pad.midi('Port A', { midichannel: 3, controls: { volume: 90 } })`).strips[0];
  assert.equal(strip.editable, false);
  assert.equal(strip.reason, 'unsupported-shape');
  assert.equal(strip.reasonText, MIXER_COPY.reasons['unsupported-shape']);
  assert.equal(strip.fader.disabled, true);
});

test('a strip built from shared code says so; a plain, global-rooted or refused strip does not', () => {
  const model = build('const x = s("bd")\nbad: x\nfine: s("hh")\nglobal: silence\nweird: (y => y)');
  const byName = Object.fromEntries(model.strips.map((strip) => [strip.name, strip]));
  assert.equal(byName.bad.sharedRoot, true);
  assert.equal(byName.bad.sharedRootText, 'Built from shared code');
  assert.equal(byName.bad.sharedRootTitle, 'The mixer shows and changes only what this track writes after the shared code.');
  assert.equal(byName.bad.editable, true);
  assert.equal(byName.bad.reasonText, null);
  for (const name of ['fine', 'global', 'weird']) {
    assert.equal(byName[name].sharedRoot, false, name);
    assert.equal(byName[name].sharedRootText, null, name);
    assert.equal(byName[name].sharedRootTitle, null, name);
  }
});

test('a MIDI strip rooted in a constant says it is built from shared code', () => {
  const strip = buildWithRig(`const base = note("c3")\npad: base.midi('Port A', { midichannel: 3, controls: { volume: 90 } })`).strips[0];
  assert.equal(strip.sharedRoot, true);
  assert.equal(strip.sharedRootText, MIXER_COPY.sharedRoot);
  assert.equal(strip.sharedRootTitle, MIXER_COPY.sharedRootTitle);
  const plain = buildWithRig(PAD).strips[0];
  assert.equal(plain.sharedRoot, false);
  assert.equal(plain.sharedRootText, null);
});

/** A song piece whose play() is the page's canonical helper (or `helper` instead), t1 played with play() and kick built from a constant. */
function playPiece({ helper = HELPER_TEXT, midi = '' } = {}) {
  return [
    "const harmony = 'C3:major';",
    "const song = { shift: 0, sections: [['x', 2]], plan: { x: { t1: 'va' } } };",
    helper,
    "const t1 = { va: note('c3') };",
    "const base = note('d3');",
    `t1: play('t1', t1)${midi}`,
    'kick: base.fast(2)',
  ].join('\n');
}
const readingOf = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });
const buildWithSong = (code, rig) => buildMixerModel({ code, parse, colorOf, song: readingOf(code), ...(rig === undefined ? {} : { rig }) });

test('a track written with play() shows no shared-code line when play is the song helper, a track built from another constant still does', () => {
  const code = playPiece();
  assert.equal(readingOf(code).helper, 'canonical');
  const byName = Object.fromEntries(buildWithSong(code).strips.map((strip) => [strip.name, strip]));
  assert.equal(byName.t1.sharedRoot, false);
  assert.equal(byName.t1.sharedRootText, null);
  assert.equal(byName.t1.sharedRootTitle, null);
  assert.equal(byName.t1.editable, true);
  assert.equal(byName.kick.sharedRoot, true);
  assert.equal(byName.kick.sharedRootText, MIXER_COPY.sharedRoot);
});

test('a track written with play() keeps the shared-code line when the helper was changed, is missing, or the song is not read', () => {
  const changed = playPiece({ helper: HELPER_TEXT.replace('throw new Error(', 'throw new TypeError(') });
  assert.equal(readingOf(changed).helper, 'changed');
  assert.equal(buildWithSong(changed).strips.find((strip) => strip.name === 't1').sharedRootText, MIXER_COPY.sharedRoot);
  // The user's own play() with no song at all is some other function: the line stays.
  const own = "const play = (name, track) => track.va;\nconst t1 = { va: note('c3') };\nt1: play('t1', t1).gain(0)";
  assert.equal(build(own).strips[0].sharedRoot, true);
  assert.equal(build(own).strips[0].sharedRootText, MIXER_COPY.sharedRoot);
  assert.equal(buildMixerModel({ code: own, parse, colorOf, song: { state: 'none' } }).strips[0].sharedRoot, true);
  // A song the page cannot read still has the canonical helper, so the line stays off there.
  const unreadable = playPiece().replace("sections: [['x', 2]]", "sections: [['x', 1 + 1]]");
  assert.equal(readingOf(unreadable).state, 'unreadable');
  assert.equal(buildWithSong(unreadable).strips.find((strip) => strip.name === 't1').sharedRoot, false);
  const missing = playPiece({ helper: '' }).replace("plan: { x: { t1: 'va' } } };", "plan: { x: { t1: 'va' } } };\nconst play = (name, track) => track.va;");
  assert.notEqual(readingOf(missing).helper, 'canonical');
  assert.equal(buildWithSong(missing).strips.find((strip) => strip.name === 't1').sharedRoot, true);
});

test('a MIDI strip written with play() shows no shared-code line when play is the song helper, and keeps it when the helper was changed', () => {
  const midi = ".midi('Port A', { midichannel: 3, controls: { volume: 90 } })";
  const canonical = buildWithSong(playPiece({ midi }), RIG).strips.find((strip) => strip.name === 't1');
  assert.notEqual(canonical.midi, null);
  assert.equal(canonical.sharedRoot, false);
  assert.equal(canonical.sharedRootText, null);
  assert.equal(canonical.sharedRootTitle, null);
  const changed = buildWithSong(playPiece({ helper: HELPER_TEXT.replace('throw new Error(', 'throw new TypeError('), midi }), RIG).strips.find((strip) => strip.name === 't1');
  assert.notEqual(changed.midi, null);
  assert.equal(changed.sharedRoot, true);
  assert.equal(changed.sharedRootText, MIXER_COPY.sharedRoot);
});

test('a track with a post-gain set inside it or in its shared code gets a refused fader', () => {
  const code = [
    'const beat = s("bd").postgain(.5)',
    'kick: beat',
    'drums: stack(s("bd").postgain(1), s("hh*4").postgain(.3))',
    'hats: s("hh").postgain(0.5)',
    'loud: stack(s("bd").postgain(1), s("hh")).gain(0.8)',
  ].join('\n');
  const [kick, drums, hats, loud] = build(code).strips.map((strip) => strip.fader);
  for (const fader of [kick, drums]) {
    assert.equal(fader.target, null);
    assert.equal(fader.disabled, true);
    assert.equal(fader.line, 'inner-postgain');
    assert.equal(fader.lineText, MIXER_COPY.faderInnerPostgain);
    assert.equal(fader.lineTitle, MIXER_COPY.faderInnerPostgainTitle);
  }
  // The track's own post-gain keeps its fader, and a plain gain on the chain is still edited in place.
  assert.equal(hats.target, 'postgain');
  assert.equal(hats.disabled, false);
  assert.equal(loud.target, 'gain');
  assert.equal(loud.disabled, false);
});

test('a MIDI track the page has no strip for gets a refused fader, never a post-gain one', () => {
  const shared = "const synth = note(\"c e\").midi('Port A', { midichannel: 3 })\nlead: synth\nhats: s(\"hh\")";
  const nested = "lead: stack(note(\"c\").midi('Port A', { midichannel: 3 }), s(\"hh\"))";
  for (const code of [shared, nested]) {
    const [lead] = buildWithRig(code).strips;
    assert.equal(lead.midi, null, code);
    assert.equal(lead.fader.target, null, code);
    assert.equal(lead.fader.disabled, true, code);
    assert.equal(lead.fader.line, 'plays-midi', code);
    assert.equal(lead.fader.lineText, MIXER_COPY.faderPlaysMidi, code);
    assert.equal(lead.fader.lineTitle, MIXER_COPY.faderPlaysMidiTitle, code);
  }
  // A track that plays no MIDI keeps its fader.
  assert.equal(buildWithRig(shared).strips[1].fader.target, 'postgain');
  // A plain .gain still reaches MIDI velocity, so its fader stays.
  assert.equal(buildWithRig("const synth = note(\"c\").midi('Port A', { midichannel: 3 })\nlead: synth.gain(0.5)").strips[0].fader.target, 'gain');
});

test('a browser strip whose track plays MIDI offers no Add effect, no sends and no bus, with one reason on the strip', () => {
  const code = [
    "const jx = (p) => p.midi('Port A', { midichannel: 3 })",
    'lead: jx(note("c e")).lpf(300).room(0.4).gain(0.5)',
    'hats: s("hh").room(0.2)',
  ].join('\n');
  const model = buildWithRig(code);
  const [lead, hats] = model.strips;
  assert.equal(lead.midi, null);
  assert.equal(lead.playsMidi, true);
  assert.equal(lead.editable, true);
  assert.equal(lead.reasonText, MIXER_COPY.playsMidi);
  assert.deepEqual(lead.addList, []);
  assert.equal(lead.orbit, null);
  assert.equal(lead.busReads, null);
  for (const send of lead.sends) {
    assert.equal(send.disabled, true, send.bus);
    assert.equal(send.title, MIXER_COPY.playsMidi, send.bus);
  }
  // The rows show what the chain itself writes: the reverb it writes, no delay.
  assert.deepEqual(lead.sends.map((send) => send.readout), ['0.40', '0.00']);
  // The effect it holds stays readable, with its bypass off; the inspector does not write.
  assert.deepEqual(lead.chips.map((chip) => [chip.effect, chip.bypassDisabled, chip.bypassReason]), [['lpf', true, MIXER_COPY.playsMidiBypass]]);
  assert.equal(inspectorModel({ model, selection: { identity: 'label:lead', effect: 'lpf' } }).editable, false);
  // It is no sender: the reverb bus is fed by the hats alone.
  assert.deepEqual(model.buses.map((bus) => [bus.bus, bus.fedBy]), [['reverb', ['hats']]]);
  // Its gain still reaches the MIDI velocity, so that fader stays; a track that plays no MIDI is untouched.
  assert.equal(lead.fader.target, 'gain');
  assert.equal(hats.playsMidi, false);
  assert.equal(hats.reasonText, null);
  assert.equal(hats.addList.length > 0, true);
  assert.equal(hats.sends.every((send) => !send.disabled), true);
  assert.equal(inspectorModel({ model: build('hats: s("hh").lpf(300)'), selection: { identity: 'label:hats', effect: 'lpf' } }).editable, true);
});

test('a browser track whose names collide with MIDI shared code stays a fully editable browser strip', () => {
  const midi = "note(\"c\").midi('Port A', { midichannel: 3 })";
  for (const body of ['n("0 2").scale("C:minor").s("piano")', 's("bd").sometimes(x => x.speed(2))', 's("bd").set({ lead: 1 })']) {
    const code = `const scale = ${midi}\nconst x = ${midi}\nconst lead = ${midi}\nlead: ${body}`;
    const [strip] = buildWithRig(code).strips;
    assert.equal(strip.playsMidi, false, body);
    assert.equal(strip.reasonText, null, body);
    assert.equal(strip.fader.disabled, false, body);
    assert.equal(strip.fader.target, 'postgain', body);
    assert.equal(strip.addList.length > 0, true, body);
    assert.equal(strip.sends.every((send) => !send.disabled), true, body);
  }
});

test('a MIDI track rooted in a constant gets an editable strip', () => {
  const strip = buildWithRig(`const base = note("c3")\npad: base.midi('Port A', { midichannel: 3, controls: { volume: 90 } })`).strips[0];
  assert.equal(strip.editable, true);
  assert.equal(strip.reasonText, null);
  assert.equal(strip.fader.kind, 'midi');
  assert.equal(strip.fader.value, 90);
  assert.equal(strip.fader.disabled, false);
});

// --- The control chips and the controls inspector of a MIDI strip ---

const PAD_PAN = `pad: note("c3").midi('Port A', { midichannel: 3, controls: { volume: 90, pan: 30 } })`;

test('a MIDI strip draws one chip per declared control except the volume, in model order, each default until written', () => {
  const { chips } = buildWithRig(`pad: note("c3").midi('Port A', { midichannel: 3 })`).strips[0].midi;
  assert.deepEqual(chips.map((chip) => chip.control), ['modulation', 'pan', 'expression', 'hold']);
  assert.deepEqual(chips.map((chip) => chip.name), ['Modulation', 'Pan', 'Expression', 'Hold']);
  assert.deepEqual(chips.map((chip) => chip.text), ['default', 'default', 'default', 'default']);
  assert.deepEqual(chips.map((chip) => chip.written), [false, false, false, false]);
  assert.deepEqual(chips.map((chip) => chip.moving), [false, false, false, false]);
  assert.equal(chips[1].label, 'Pan on pad: default. Edit controls.');
  assert.equal(chips[1].title, 'Pan, 0\u2013127');
  assert.equal(chips[1].cc, 10);
});

test('a written control reads its number in its chip and the others stay default (written, unwritten and the volume apart)', () => {
  const { chips } = buildWithRig(PAD_PAN).strips[0].midi;
  assert.deepEqual(chips.map((chip) => chip.text), ['default', '30', 'default', 'default']);
  assert.equal(chips[1].label, 'Pan on pad: 30. Edit controls.');
  assert.equal(chips[1].written, true);
  assert.equal(chips.some((chip) => chip.control === 'volume'), false, 'the volume stays on the fader');
});

test('a strip with no readable model or options has no chips, and a model with only a volume has none either', () => {
  const only = { setup: 'valid', instruments: [instrumentWith(MT32_CONTROLS.filter((control) => control.id === 'volume'))] };
  assert.deepEqual(buildWithRig(PAD, only).strips[0].midi.chips, []);
  assert.equal(buildWithRig(PAD, only).strips[0].midi.reason, null);
  for (const [code, rig] of [
    [PAD, { setup: 'absent' }],
    [PAD, { setup: 'invalid', problems: [], more: 0 }],
    [`const opts = { midichannel: 3 }\npad: note("c3").midi('Port A', opts)`, RIG],
    [`pad: note("c3").midi('Port Z', { midichannel: 3 })`, RIG],
  ]) {
    assert.deepEqual(buildWithRig(code, rig).strips[0].midi.chips, []);
  }
  // A model with no volume control still has its other controls.
  const noVolume = { setup: 'valid', instruments: [instrumentWith(MT32_CONTROLS.filter((control) => control.id !== 'volume'))] };
  assert.equal(buildWithRig(PAD, noVolume).strips[0].midi.chips.length, 4);
});

test('the SC-55 chips take their names from the model, with Reverb send and Chorus send', () => {
  const sc55 = [...MT32_CONTROLS, { id: 'reverb-send', name: 'Reverb send', cc: 91, min: 0, max: 127, default: 40 }, { id: 'chorus-send', name: 'Chorus send', cc: 93, min: 0, max: 127, default: 0 }];
  const { chips } = buildWithRig(PAD, { setup: 'valid', instruments: [instrumentWith(sc55)] }).strips[0].midi;
  assert.deepEqual(chips.map((chip) => chip.name), ['Modulation', 'Pan', 'Expression', 'Hold', 'Reverb send', 'Chorus send']);
  assert.equal(chips[4].control, 'reverb-send');
});

test('every {name} slot of the MIDI copy is filled, and a missing value throws', () => {
  const model = buildWithRig(PAD_PAN);
  const chip = model.strips[0].midi.chips[1];
  assert.equal(/\{\w+\}/.test(`${chip.label}${chip.title}`), false);
  const inspector = inspectorModel({ model, selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.equal(/\{\w+\}/.test(JSON.stringify(inspector)), false);
  assert.throws(() => fill(MIXER_COPY.midiChipLabel, { name: 'Pan', track: 'pad' }), /needs a value for \{value\}/);
});

test('the controls inspector lists every declared control but the fader, with the instrument line and the written controls', () => {
  const model = buildWithRig(`pad: note("c3").midi('Port A', { midichannel: 3, sound: 'Str', controls: { volume: 90, pan: 30 } })`);
  const data = inspectorModel({ model, selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.equal(data.kind, 'midi');
  assert.equal(data.title, 'Controls \u00b7 pad');
  assert.equal(data.instrumentLine, 'mt32 \u00b7 ch 3 \u00b7 Str');
  assert.deepEqual(data.rows.map((row) => row.control), ['modulation', 'pan', 'expression', 'hold']);
  const pan = data.rows[1];
  assert.deepEqual(
    { value: pan.value, written: pan.written, subText: pan.subText, showDefaultButton: pan.showDefaultButton, slider: pan.slider, default: pan.default, cc: pan.cc },
    { value: 30, written: true, subText: null, showDefaultButton: true, slider: { min: 0, max: 127, step: 1, value: 30 }, default: 64, cc: 10 },
  );
  assert.equal(pan.defaultTitle, "Back to the instrument's default (64). Removes it from the code.");
  const modulation = data.rows[0];
  assert.deepEqual({ value: modulation.value, written: modulation.written, subText: modulation.subText, showDefaultButton: modulation.showDefaultButton }, { value: 0, written: false, subText: 'default 0', showDefaultButton: false });
  assert.equal(data.writtenText, 'controls: { volume: 90, pan: 30 }');
  assert.equal(data.nothingWritten, false);
  assert.equal(data.footer, "Controls you don't touch are not written to the code; the instrument keeps its default.");
  assert.equal(data.editable, true);
  assert.equal(data.gone, false);
  const bare = inspectorModel({ model: buildWithRig(`pad: note("c3").midi('Port A', { midichannel: 3 })`), selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.equal(bare.instrumentLine, 'mt32 \u00b7 ch 3');
  assert.equal(bare.nothingWritten, true);
  assert.equal(MIXER_COPY.midiNothingWritten, 'Nothing written \u2014 the instrument keeps its defaults.');
});

test('the controls inspector says when the track left the code or its controls are off, and never changes anything', () => {
  const model = buildWithRig(PAD_PAN);
  const gone = inspectorModel({ model: buildWithRig(`hats: s("hh")`), selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.deepEqual({ gone: gone.gone, goneText: gone.goneText, rows: gone.rows }, { gone: true, goneText: 'This MIDI track is no longer in the code.', rows: [] });
  const notMidi = inspectorModel({ model: buildWithRig(`pad: s("hh")`), selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.equal(notMidi.gone, true);
  const off = inspectorModel({ model: buildWithRig(PAD_PAN, { setup: 'absent' }), selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.deepEqual({ gone: off.gone, rows: off.rows, reasonText: off.reasonText }, { gone: false, rows: [], reasonText: MIXER_COPY.midiReasons.noModel });
  // Building the model and the inspector model twice gives the same facts: it is pure, nothing is written or recorded.
  const again = inspectorModel({ model: buildWithRig(PAD_PAN), selection: { identity: 'label:pad', midi: true, control: 'pan' } });
  assert.deepEqual(again, inspectorModel({ model, selection: { identity: 'label:pad', midi: true, control: 'pan' } }));
});

test('the history labels of a MIDI control read the declared name lower-cased, and an unknown kind still throws', () => {
  assert.equal(mixerHistoryLabel({ kind: 'midi-control', name: 'pad', control: 'Pan', value: 30 }), 'mixer: pad pan 30');
  assert.equal(mixerHistoryLabel({ kind: 'midi-control', name: 'pad', control: 'Reverb send', value: 40 }), 'mixer: pad reverb send 40');
  assert.equal(mixerHistoryLabel({ kind: 'midi-control-default', name: 'pad', control: 'Pan' }), 'mixer: pad pan default');
  assert.throws(() => mixerHistoryLabel({ kind: 'midi-controls', name: 'pad' }), /unknown mixer action/);
});

// --- A sweep Claude wrote on a control makes it moving and disabled, and the mixer never fights it ---

const SWEEP_ROW = 'A sweep in the code moves this control on channel 3. Ask Claude to change it.';
const SWEEP_FADER = 'A sweep in the code moves the volume on channel 3. Ask Claude to change it.';
const SWEEP_UNKNOWN = "A sweep in the code on channel 3 uses a controller the mixer can't read. Ask Claude to change it.";
const padWithSweep = (ccn, channel = 3) => `pad: note("c3").ccv(sine.segment(8)).ccn(${ccn}).midi('Port A', { midichannel: ${channel}, controls: { volume: 90 } })`;
const padInspector = (code) => inspectorModel({ model: buildWithRig(code), selection: { identity: 'label:pad', midi: true, control: 'pan' } });

test('a sweep on the same channel and the same cc makes that control moving in its chip and its row, and no other', () => {
  const strip = buildWithRig(padWithSweep(10)).strips[0];
  assert.deepEqual(strip.midi.chips.map((chip) => [chip.control, chip.text, chip.moving]), [['modulation', 'default', false], ['pan', 'moving', true], ['expression', 'default', false], ['hold', 'default', false]]);
  assert.equal(strip.midi.chips[1].label, 'Pan on pad: moving. Edit controls.');
  const rows = padInspector(padWithSweep(10)).rows;
  const pan = rows[1];
  assert.deepEqual(
    { moving: pan.moving, slider: pan.slider, showDefaultButton: pan.showDefaultButton, subText: pan.subText, sweepText: pan.sweepText },
    { moving: true, slider: null, showDefaultButton: false, subText: null, sweepText: SWEEP_ROW },
  );
  assert.equal(rows[0].moving, false);
  assert.notEqual(rows[0].slider, null);
  assert.equal(rows[0].sweepText, null);
  assert.equal(strip.fader.disabled, false, 'a sweep on another control leaves the fader alone');
  assert.equal(MIXER_COPY.midiSweepRow, 'A sweep in the code moves this control on channel {n}. Ask Claude to change it.');
});

test('a sweep on a control the model does not have, or on another channel, blocks nothing', () => {
  const elsewhere = `swell: note("c3").ccv(sine.segment(8)).ccn(10).midi('Port A', { midichannel: 4 })\npad: note("e3").midi('Port A', { midichannel: 3, controls: { volume: 90 } })`;
  for (const code of [padWithSweep(74), elsewhere]) {
    const strip = buildWithRig(code).strips.find((candidate) => candidate.identity === 'label:pad');
    assert.equal(strip.midi.chips.some((chip) => chip.moving), false, code);
    assert.equal(strip.fader.disabled, false, code);
    assert.equal(padInspector(code).rows.some((row) => row.moving), false, code);
  }
});

test('a sweep on the volume disables the fader with its sentence and leaves the chips free', () => {
  const strip = buildWithRig(padWithSweep(7)).strips[0];
  assert.deepEqual(
    { disabled: strip.fader.disabled, line: strip.fader.line, lineText: strip.fader.lineText, readout: strip.fader.readout, readoutMuted: strip.fader.readoutMuted, value: strip.fader.value },
    { disabled: true, line: 'sweep', lineText: SWEEP_FADER, readout: '90', readoutMuted: true, value: 90 },
  );
  assert.equal(strip.midi.chips.some((chip) => chip.moving), false);
  assert.equal(MIXER_COPY.midiSweepFader, 'A sweep in the code moves the volume on channel {n}. Ask Claude to change it.');
});

test('a ccn the page cannot read disables every control of its channel, the fader included, with one sentence', () => {
  const code = `pad: note("c3").ccn(n).midi('Port A', { midichannel: 3 })`;
  const strip = buildWithRig(code).strips[0];
  assert.deepEqual(strip.midi.chips.map((chip) => chip.moving), [true, true, true, true]);
  assert.deepEqual(padInspector(code).rows.map((row) => row.sweepText), [SWEEP_UNKNOWN, SWEEP_UNKNOWN, SWEEP_UNKNOWN, SWEEP_UNKNOWN]);
  assert.deepEqual({ disabled: strip.fader.disabled, lineText: strip.fader.lineText }, { disabled: true, lineText: SWEEP_UNKNOWN });
  assert.equal(MIXER_COPY.midiSweepUnknown, "A sweep in the code on channel {n} uses a controller the mixer can't read. Ask Claude to change it.");
});

test('a sweep on another track of the same port and channel moves the control of this strip too', () => {
  const model = buildWithRig(`swell: note("c3").ccv(sine.segment(8)).ccn(10).midi('Port A', { midichannel: 3 })\npad: note("e3").midi('Port A', { midichannel: 3 })`);
  const pad = model.strips.find((strip) => strip.identity === 'label:pad');
  assert.equal(pad.midi.chips.find((chip) => chip.control === 'pan').moving, true);
});

test('every {n} slot of the sweep copy is filled with the channel, and a missing value throws', () => {
  for (const key of ['midiSweepRow', 'midiSweepFader', 'midiSweepUnknown']) {
    assert.throws(() => fill(MIXER_COPY[key], {}), /needs a value for \{n\}/, key);
    assert.equal(/\{\w+\}/.test(fill(MIXER_COPY[key], { n: 3 })), false, key);
  }
});

// --- A shared channel says who shares it, reads one value and is written as one ---

const KICK = `kick: note("c2*4").midi('Port A', { midichannel: 10 })`;
const HAT = `hat: note("f#2*8").midi('Port A', { midichannel: 10 })`;
const sharedStrip = (model, identity) => model.strips.find((strip) => strip.identity === identity);

test('tracks on one instrument and channel list each other, muted ones included, and a lone track lists nobody', () => {
  const model = buildWithRig(`${KICK}\n${HAT}\n_snare: note("d2").midi('Port A', { midichannel: 10 })\npad: note("c3").midi('Port A', { midichannel: 3 })`);
  assert.deepEqual(sharedStrip(model, 'label:kick').midi.sharedWith, ['hat', 'snare']);
  assert.deepEqual(sharedStrip(model, 'label:hat').midi.sharedWith, ['kick', 'snare']);
  assert.deepEqual(sharedStrip(model, 'label:snare').midi.sharedWith, ['kick', 'hat']);
  const pad = sharedStrip(model, 'label:pad').midi;
  assert.deepEqual([pad.sharedWith, pad.sharedText, pad.sharedTitle], [[], '', '']);
});

test('the shared texts are the strip line and the inspector sentence, filled with the other names', () => {
  assert.equal(MIXER_COPY.midiShared, 'Shared with {names}');
  assert.equal(MIXER_COPY.midiInspectorShared, 'Channel {n} is shared with {names}. A change here is written on every one of these tracks.');
  const two = buildWithRig(`${KICK}\n${HAT}`);
  assert.equal(sharedStrip(two, 'label:kick').midi.sharedText, 'Shared with hat');
  assert.equal(sharedStrip(two, 'label:kick').midi.sharedTitle, 'Shared with hat');
  const three = buildWithRig(`${KICK}\n${HAT}\nsnare: note("d2").midi('Port A', { midichannel: 10 })`);
  assert.equal(sharedStrip(three, 'label:kick').midi.sharedText, 'Shared with hat, snare');
  const inspect = (model, identity) => inspectorModel({ model, selection: { identity, midi: true, control: 'pan' } });
  assert.equal(inspect(two, 'label:kick').sharedText, 'Channel 10 is shared with hat. A change here is written on every one of these tracks.');
  assert.equal(inspect(buildWithRig(PAD), 'label:pad').sharedText, '');
});

test('every strip of a shared channel reads the value written on any member, and a control nobody writes reads default', () => {
  const model = buildWithRig(`kick: note("c2*4").midi('Port A', { midichannel: 10 })\nhat: note("f#2*8").midi('Port A', { midichannel: 10, controls: { volume: 60 } })`);
  for (const identity of ['label:kick', 'label:hat']) {
    const strip = sharedStrip(model, identity);
    assert.deepEqual([strip.fader.value, strip.fader.readout, strip.fader.line, strip.fader.disabled], [60, '60', 'written', false], identity);
    assert.equal(strip.midi.chips.find((chip) => chip.control === 'pan').text, 'default', identity);
  }
  const pan = buildWithRig(`kick: note("c2*4").midi('Port A', { midichannel: 10 })\nhat: note("f#2*8").midi('Port A', { midichannel: 10, controls: { pan: 30 } })`);
  assert.deepEqual(sharedStrip(pan, 'label:kick').midi.chips.find((chip) => chip.control === 'pan').text, '30');
  const rows = inspectorModel({ model: pan, selection: { identity: 'label:kick', midi: true, control: 'pan' } });
  assert.equal(rows.rows.find((row) => row.control === 'pan').written, true);
  assert.equal(rows.writtenText, 'controls: { pan: 30 }');
});

test('a member whose controls are not plain gives its reason to every member of its channel', () => {
  const model = buildWithRig(`${KICK}\nhat: note("f#2*8").midi('Port A', { midichannel: 10, controls: x })`);
  for (const identity of ['label:kick', 'label:hat']) {
    const strip = sharedStrip(model, identity);
    assert.equal(strip.midi.reason, 'optionsNotPlain', identity);
    assert.equal(strip.midi.reasonText, MIXER_COPY.midiReasons.optionsNotPlain, identity);
    assert.deepEqual([strip.fader.disabled, strip.fader.readout], [true, '–'], identity);
  }
});

test('channel mates share a port and a channel: another channel or another port means other tracks', () => {
  const otherPort = { setup: 'valid', instruments: [instrumentWith(MT32_CONTROLS), { ...instrumentWith(MT32_CONTROLS), id: 'sc55', port: 'Port B' }] };
  const model = buildWithRig(`${KICK}\nlead: note("c3").midi('Port A', { midichannel: 3 })\nbell: note("c5").midi('Port B', { midichannel: 10 })`, otherPort);
  for (const identity of ['label:kick', 'label:lead', 'label:bell']) assert.deepEqual(sharedStrip(model, identity).midi.sharedWith, [], identity);
  // Without a rig the port is the key, so two tracks on the same port and channel still share.
  const noRig = buildWithRig(`${KICK}\n${HAT}`, { setup: 'absent' });
  assert.deepEqual(sharedStrip(noRig, 'label:kick').midi.sharedWith, ['hat']);
  // A track whose channel the page cannot read has no channel mates.
  const unreadable = buildWithRig(`${KICK}\nhat: note("f#2*8").midi('Port A', { midichannel: ch })`);
  assert.deepEqual(sharedStrip(unreadable, 'label:kick').midi.sharedWith, []);
});

// --- MIDI tracks that play no notes have no strip and are listed in one line ---

const NO_NOTES_RIG = {
  setup: 'valid',
  instruments: [
    { ...instrumentWith(MT32_CONTROLS), id: 'synth', port: 'Port A', channels: [2, 3, 4].map((channel) => ({ channel, role: 'melodic' })) },
    { ...instrumentWith(MT32_CONTROLS), id: 'sc55', port: 'Port B', channels: [{ channel: 15, role: 'melodic' }] },
  ],
};
const REVERB_SEND = `reverb_send: ccn(91).ccv(0.95).midi('Port B', { midichannel: 15 })`;
const CLOCK = `clock: silence.midi('Port A', { midichannel: 2 })`;
const noNotesModel = (code, rig = NO_NOTES_RIG) => buildMixerModel({ code, parse, colorOf, rig });

test('a MIDI track that plays no notes has no strip and is named in one line with its instrument and channel', () => {
  const model = noNotesModel(`${PAD}\n${REVERB_SEND}\n${CLOCK}`);
  assert.equal(model.status, 'ready');
  assert.deepEqual(model.strips.map((strip) => strip.identity), ['label:pad']);
  assert.deepEqual(model.noNotes, [
    { identity: 'label:reverb_send', name: 'reverb_send', tagText: 'sc55 · ch 15', silent: false },
    { identity: 'label:clock', name: 'clock', tagText: 'synth · ch 2', silent: false },
  ]);
  assert.equal(model.noNotesText, 'No notes: reverb_send (sc55 · ch 15), clock (synth · ch 2)');
  assert.equal(MIXER_COPY.noNotes, 'No notes: {list}');
  assert.equal(
    MIXER_COPY.noNotesTitle,
    'These MIDI tracks play no notes (they send only controls, program changes or a clock), so they have no strip. The mixer cannot mute, solo or edit them: ask Claude to change them.',
  );
  assert.equal(MIXER_COPY.noNotesSilent, 'silent');
});

test('a listed track that does not sound says so in the line: its own mute or a solo on another track', () => {
  const muted = noNotesModel(`${PAD}\n_clock: silence.midi('Port A', { midichannel: 2 })`);
  assert.equal(muted.noNotesText, 'No notes: clock (synth · ch 2, silent)');
  assert.equal(muted.noNotes[0].silent, true);
  // A solo on another track silences it too; the soloed track is not silent.
  const soloed = noNotesModel(`S_pad: note("c3").midi('Port A', { midichannel: 3 })\n${CLOCK}`);
  assert.equal(soloed.noNotesText, 'No notes: clock (synth · ch 2, silent)');
  // A track with no readable port is named alone, and is marked on its own.
  assert.equal(noNotesModel(`${PAD}\n_send: ccn(91).ccv(0.5).midi('Port A', { midichannel: 2 }).midi('Port B', { midichannel: 3 })`).noNotesText, 'No notes: send (silent)');
});

test('the line lists one folded track alone, and is absent when nothing folds', () => {
  assert.equal(noNotesModel(`${PAD}\n${CLOCK}`).noNotesText, 'No notes: clock (synth · ch 2)');
  const none = noNotesModel(`${PAD}\nhats: s("hh")`);
  assert.deepEqual(none.noNotes, []);
  assert.equal(none.noNotesText, null);
  assert.deepEqual(none.strips.map((strip) => strip.identity), ['label:pad', 'label:hats']);
});

test('a program whose only tracks fold is ready with no strip and the line', () => {
  const model = noNotesModel(`${REVERB_SEND}\n${CLOCK}`);
  assert.equal(model.status, 'ready');
  assert.deepEqual(model.strips, []);
  assert.equal(model.noNotesText, 'No notes: reverb_send (sc55 · ch 15), clock (synth · ch 2)');
});

test('a folded track whose port cannot be read is listed by its name alone', () => {
  const model = noNotesModel(`${PAD}\nsend: ccn(91).ccv(0.5).midi('Port A', { midichannel: 2 }).midi('Port B', { midichannel: 3 })`);
  assert.deepEqual(model.strips.map((strip) => strip.identity), ['label:pad']);
  assert.deepEqual(model.noNotes, [{ identity: 'label:send', name: 'send', tagText: null, silent: false }]);
  assert.equal(model.noNotesText, 'No notes: send');
});

test('a folded $ track is listed under the name the Mixer would give its strip', () => {
  const model = noNotesModel(`${PAD}\n$: silence.midi('Port A', { midichannel: 2 })`);
  assert.equal(model.noNotes.length, 1);
  assert.equal(model.noNotes[0].name, 'silence');
  assert.equal(model.noNotesText, 'No notes: silence (synth · ch 2)');
});

test('a kept strip on the port and channel of a folded track names it in its Shared with line', () => {
  const model = noNotesModel(`pad: note("c3").midi('Port A', { midichannel: 2 })\n${CLOCK}`);
  assert.deepEqual(model.strips.map((strip) => strip.identity), ['label:pad']);
  assert.deepEqual(model.strips[0].midi.sharedWith, ['clock']);
  assert.equal(model.strips[0].midi.sharedText, 'Shared with clock');
});

test('a track that may play notes keeps its strip, whatever else it sends', () => {
  const model = noNotesModel(`a: ccn(7).ccv(.5).note("c3").midi('Port A', { midichannel: 3 })\nb: stack(silence, note("c3")).midi('Port A', { midichannel: 3 })\nc: progNum(5).note("c3").midi('Port A', { midichannel: 3 })`);
  assert.deepEqual(model.strips.map((strip) => strip.identity), ['label:a', 'label:b', 'label:c']);
  assert.equal(model.noNotesText, null);
});

test('the empty and unreadable models are as before and carry no line', () => {
  assert.equal(noNotesModel('').noNotesText, undefined);
  assert.equal(noNotesModel('pad: note("c3"').noNotesText, undefined);
  assert.equal(noNotesModel('setcps(1)').noNotesText, undefined);
});

// --- The groups of a song and the index of every strip ---

const SONG_PIECE = [
  "const harmony = 'C3:major';",
  "const song = { shift: 0, sections: [['x', 3]], groups: { g1: ['t1', 't2'], g2: { g3: ['t3'] } }, plan: { x: { t1: 'va', t2: 'va', t3: 'va' } } };",
  HELPER_TEXT,
  "const t1 = { va: note('c3') };",
  "const t2 = { va: note('d3') };",
  "const t3 = { va: note('e3') };",
  "t1: play('t1', t1)\nt2: play('t2', t2)\nt3: play('t3', t3)",
  "t4: note('c3').gain(0)",
].join('\n');

const songOf = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

test('a ready model with a song has a layout with the words of each group', () => {
  const model = buildMixerModel({ code: SONG_PIECE, parse, colorOf, song: songOf(SONG_PIECE), folds: new Set() });
  assert.equal(model.status, 'ready');
  const [g1, g2, g3] = model.layout.groups;
  assert.deepEqual(
    [g1.text, g1.title, g1.label, g1.foldTitle, g1.count, g1.countText],
    ['g1', 'g1', 'Group g1', "Fold 'g1'", 2, '2 tracks'],
  );
  assert.equal(g3.countText, '1 track');
  assert.equal(g3.label, 'Group g3');
  assert.equal(g2.members.length, 1);
});

test('a folded group offers to open, in the grid\'s words', () => {
  const model = buildMixerModel({ code: SONG_PIECE, parse, colorOf, song: songOf(SONG_PIECE), folds: new Set(['["g1"]']) });
  assert.equal(model.layout.groups[0].open, false);
  assert.equal(model.layout.groups[0].foldTitle, "Open 'g1'");
});

test('a long group name is cut in its sentences and kept whole in its title', () => {
  const name = 'n'.repeat(60);
  const code = SONG_PIECE.replace('g1:', `${name}:`);
  const model = buildMixerModel({ code, parse, colorOf, song: songOf(code), folds: new Set() });
  const group = model.layout.groups[0];
  assert.equal(group.title, name);
  assert.equal(group.text, `${'n'.repeat(39)}\u2026`);
  assert.equal(group.label, `Group ${'n'.repeat(39)}\u2026`);
  assert.equal(group.foldTitle, `Fold '${'n'.repeat(39)}\u2026'`);
});

test('without a song the layout is null, and the empty and unreadable models keep their shapes', () => {
  assert.equal(build(SONG_PIECE).layout, null);
  assert.equal(buildMixerModel({ code: SONG_PIECE, parse, colorOf, song: { state: 'none' } }).layout, null);
  assert.deepEqual(build(''), { status: 'empty', strips: [], buses: [], busMemory: new Map() });
  assert.equal(build('drums: s("bd"').status, 'unreadable');
  assert.equal(Object.hasOwn(build('drums: s("bd"'), 'layout'), false);
});

test('every strip has the index of its track', () => {
  const model = buildMixerModel({ code: SONG_PIECE, parse, colorOf, song: songOf(SONG_PIECE) });
  const tracks = extractTracks(SONG_PIECE, { parse });
  assert.deepEqual(model.strips.map((strip) => [strip.identity, strip.index]), tracks.map((track) => [track.identity, track.index]));
  assert.deepEqual(model.strips.map((strip) => strip.index), [0, 1, 2, 3]);
});

// --- Mute and solo on a group ---

/** A structured piece whose group g1 holds t1 to t3 (each written as `lines` say) and g2 holds `Snare`. */
function groupPiece(lines, groups = "{ g1: ['t1', 't2', 't3'], g2: ['Snare'] }") {
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: 0, sections: [['x', 3]], groups: ${groups}, plan: { x: { t1: 'va', t2: 'va', t3: 'va', Snare: 'va' } } };`,
    HELPER_TEXT,
    ...['t1', 't2', 't3', 'Snare'].map((name) => `const ${name} = { va: note('c3') };`),
    lines,
  ].join('\n');
}
const PLAIN_LINES = "t1: play('t1', t1)\nt2: play('t2', t2)\nt3: play('t3', t3)\nSnare: play('Snare', Snare)";
const groupsOf = (code) => buildMixerModel({ code, parse, colorOf, song: songOf(code), folds: new Set() }).layout.groups;

test('the group copy is the pinned text and never blames the person', () => {
  const pinned = {
    groupMuteName: 'Mute {group}',
    groupMuteNamePartial: 'Mute {group}, {k} of {n} tracks muted',
    groupSoloName: 'Solo {group}',
    groupSoloNamePartial: 'Solo {group}, {k} of {n} tracks soloed',
    groupMuteTitle: 'Mute {tracks}',
    groupUnmuteTitle: 'Unmute {tracks}',
    groupMutePartialTitle: '{k} of {n} tracks muted. A click mutes all {n}.',
    groupSoloTitle: 'Solo {tracks}',
    groupEndSoloTitle: 'End the solo of {tracks}',
    groupSoloPartialTitle: '{k} of {n} tracks soloed. A click solos all {n}.',
    groupCountMuted: '{k} of {n} muted',
    groupCountSolo: '{k} of {n} solo',
    groupCountBoth: '{k} of {n} muted, {j} of {n} solo',
    groupSkipOne: "Skips 1 track the mixer can't change.",
    groupSkipMany: "Skips {n} tracks the mixer can't change.",
    groupEmpty: 'No track of this group is in the code.',
  };
  for (const [key, text] of Object.entries(pinned)) {
    assert.equal(MIXER_COPY[key], text, key);
    assert.doesNotMatch(text, /\b(wrong|error|should|try)\b/i, key);
  }
});

test('a group mute or solo records a label that names the group, cut to 40 characters, and an unknown kind still throws', () => {
  assert.equal(mixerHistoryLabel({ kind: 'group-mute', group: 'drums', on: true }), 'mixer: group drums muted');
  assert.equal(mixerHistoryLabel({ kind: 'group-mute', group: 'drums', on: false }), 'mixer: group drums unmuted');
  assert.equal(mixerHistoryLabel({ kind: 'group-solo', group: 'drums', on: true }), 'mixer: group drums solo on');
  assert.equal(mixerHistoryLabel({ kind: 'group-solo', group: 'drums', on: false }), 'mixer: group drums solo off');
  assert.equal(mixerHistoryLabel({ kind: 'group-mute', group: 'n'.repeat(60), on: true }), `mixer: group ${'n'.repeat(39)}… muted`);
  assert.ok(clipMixerLabel(mixerHistoryLabel({ kind: 'group-solo', group: 'n'.repeat(60), on: false })).length <= MAX_MIXER_LABEL_LENGTH);
  assert.throws(() => mixerHistoryLabel({ kind: 'group-pan', group: 'drums', on: true }), /^Error: Moontide: unknown mixer action/);
});

test('a group with no track muted or soloed reads as the plain count, with the plain names and titles', () => {
  const [g1, g2] = groupsOf(groupPiece(PLAIN_LINES));
  assert.deepEqual([g1.countText, g1.countTitle, g1.noteText], ['3 tracks', '3 tracks', null]);
  assert.deepEqual(g1.mute, { pressed: false, on: true, identities: ['label:t1', 'label:t2', 'label:t3'], disabled: false, name: 'Mute g1', title: 'Mute 3 tracks' });
  assert.deepEqual(g1.solo, { pressed: false, on: true, identities: ['label:t1', 'label:t2', 'label:t3'], disabled: false, name: 'Solo g1', title: 'Solo 3 tracks' });
  // Snare starts with a capital S, so Strudel plays it alone by itself and the mixer never solos it.
  assert.equal(g2.mute.title, 'Mute 1 track');
  assert.deepEqual([g2.solo.disabled, g2.solo.title], [true, 'Solo']);
  const [one] = groupsOf(groupPiece(PLAIN_LINES, "{ g1: ['t1'] }"));
  assert.deepEqual([one.mute.title, one.solo.title, one.countText], ['Mute 1 track', 'Solo 1 track', '1 track']);
});

test('a group with some tracks muted is mixed: the count line, the title and the accessible name say how many', () => {
  const [g1] = groupsOf(groupPiece(PLAIN_LINES.replace('t1: play', '_t1: play')));
  assert.deepEqual([g1.mute.pressed, g1.mute.on, g1.mute.disabled], ['mixed', true, false]);
  assert.equal(g1.mute.name, 'Mute g1, 1 of 3 tracks muted');
  assert.equal(g1.mute.title, '1 of 3 tracks muted. A click mutes all 3.');
  assert.deepEqual([g1.countText, g1.countTitle], ['1 of 3 muted', '1 of 3 muted']);
  assert.deepEqual([g1.solo.pressed, g1.solo.name, g1.solo.title], [false, 'Solo g1', 'Solo 3 tracks']);
});

test('a group with some tracks soloed is mixed the same way, with the solo words', () => {
  const [g1] = groupsOf(groupPiece(PLAIN_LINES.replace('t2: play', 'S_t2: play').replace('t1: play', 'S_t1: play')));
  assert.equal(g1.solo.pressed, 'mixed');
  assert.equal(g1.solo.name, 'Solo g1, 2 of 3 tracks soloed');
  assert.equal(g1.solo.title, '2 of 3 tracks soloed. A click solos all 3.');
  assert.equal(g1.countText, '2 of 3 solo');
});

test('a group partly muted and partly soloed reads both in one count line', () => {
  const [g1] = groupsOf(groupPiece(PLAIN_LINES.replace('t1: play', '_t1: play').replace('t2: play', 'S_t2: play')));
  assert.deepEqual([g1.mute.pressed, g1.solo.pressed], ['mixed', 'mixed']);
  assert.equal(g1.countText, '1 of 3 muted, 1 of 3 solo');
  assert.equal(g1.countTitle, g1.countText);
});

test('a group with every track muted is pressed and offers to unmute, and the same for solo', () => {
  const [g1] = groupsOf(groupPiece(PLAIN_LINES.replace('t1: play', '_t1: play').replace('t2: play', '_t2: play').replace('t3: play', '_t3: play')));
  assert.deepEqual([g1.mute.pressed, g1.mute.on, g1.mute.title, g1.mute.name], [true, false, 'Unmute 3 tracks', 'Mute g1']);
  assert.equal(g1.countText, '3 tracks');
  const [soloed] = groupsOf(groupPiece(PLAIN_LINES.replace('t1: play', 'S_t1: play').replace('t2: play', 'S_t2: play').replace('t3: play', 'S_t3: play')));
  assert.deepEqual([soloed.solo.pressed, soloed.solo.on, soloed.solo.title], [true, false, 'End the solo of 3 tracks']);
});

test('a track with a native capital S name is skipped by solo, kept by mute, and counted in the note', () => {
  const [g1, g2] = groupsOf(groupPiece(PLAIN_LINES, "{ g1: ['t1', 't2', 'Snare'], g2: ['t3'] }"));
  assert.deepEqual([g1.mute.identities, g1.solo.identities, g1.solo.disabled], [['label:t1', 'label:t2', 'label:Snare'], ['label:t1', 'label:t2'], false]);
  assert.equal(g1.noteText, "Skips 1 track the mixer can't change.");
  assert.equal(g2.noteText, null);
  const [lone] = groupsOf(groupPiece(PLAIN_LINES, "{ g2: ['Snare'] }"));
  assert.deepEqual([lone.solo.disabled, lone.solo.identities, lone.mute.disabled], [true, [], false]);
  assert.equal(lone.noteText, "Skips 1 track the mixer can't change.");
});

test('the note counts the tracks left out and the empty group says it has no track', () => {
  const groups = groupsOf(groupPiece(PLAIN_LINES, "{ g1: ['t1', 't2', 't3'], g2: [], g3: ['Snare'] }"));
  assert.deepEqual(groups.map((group) => group.noteText), [null, 'No track of this group is in the code.', "Skips 1 track the mixer can't change."]);
  const empty = groups[1];
  assert.deepEqual([empty.mute.disabled, empty.solo.disabled, empty.mute.identities, empty.countText], [true, true, [], '0 tracks']);
  assert.deepEqual([empty.mute.title, empty.solo.title, empty.mute.pressed, empty.mute.name], ['Mute', 'Solo', false, 'Mute g2']);
});

test('a group mute that is set while the other tracks are muted by .hush() still counts them as muted', () => {
  const [g1] = groupsOf(groupPiece(PLAIN_LINES.replace("t1: play('t1', t1)", "t1: play('t1', t1).hush()")));
  assert.equal(g1.mute.pressed, 'mixed');
  assert.equal(g1.countText, '1 of 3 muted');
});

test('names in the group words stay the written text: a 60-character name is cut to 40 in the names and titles', () => {
  const long = 'n'.repeat(60);
  const [group] = groupsOf(groupPiece(PLAIN_LINES, `{ ${long}: ['t1', 't2'] }`));
  assert.equal(group.mute.name, `Mute ${'n'.repeat(39)}…`);
  assert.equal(group.solo.name, `Solo ${'n'.repeat(39)}…`);
});

test('the note says how many tracks are left out when there are several', () => {
  const code = [
    "const harmony = 'C3:major';",
    "const song = { shift: 0, sections: [['x', 3]], groups: { g1: ['t1', 'Snare', 'Sub'] }, plan: { x: { t1: 'va', Snare: 'va', Sub: 'va' } } };",
    HELPER_TEXT,
    ...['t1', 'Snare', 'Sub'].map((name) => `const ${name} = { va: note('c3') };`),
    "t1: play('t1', t1)\nSnare: play('Snare', Snare)\nSub: play('Sub', Sub)",
  ].join('\n');
  const [g1] = groupsOf(code);
  assert.equal(g1.noteText, "Skips 2 tracks the mixer can't change.");
  assert.deepEqual(g1.solo.identities, ['label:t1']);
  assert.equal(g1.solo.title, 'Solo 1 track');
  assert.equal(g1.mute.title, 'Mute 3 tracks');
});

// --- The structure never changes a strip ---

/** A structured piece of `count` tracks, the first half in g1 and the rest in g2 > g3, each played with play(). */
function bigPiece(count, trackLine = (name) => `${name}: play('${name}', ${name})`) {
  const names = Array.from({ length: count }, (_, i) => `t${i + 1}`);
  const half = Math.ceil(count / 2);
  const list = (items) => `[${items.map((name) => `'${name}'`).join(', ')}]`;
  const groups = `{ g1: ${list(names.slice(0, half))}, g2: { g3: ${list(names.slice(half))} } }`;
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: 0, sections: [['x', 3]], groups: ${groups}, plan: { x: { ${names.map((name) => `${name}: 'va'`).join(', ')} } } };`,
    HELPER_TEXT,
    ...names.map((name) => `const ${name} = { va: note('c3') };`),
    ...names.map(trackLine),
  ].join('\n');
}

/**
 * The model of `code` with the song reading and a fold, and without its groups (the same reading with no group, which keeps what
 * the reading says about the helper, so a play() strip reads the same either way).
 */
function withAndWithoutSong(code, rig = undefined) {
  const extra = rig === undefined ? {} : { rig };
  const withSong = buildMixerModel({ code, parse, colorOf, ...extra, song: songOf(code), folds: new Set(['["g1"]']) });
  const plain = buildMixerModel({ code, parse, colorOf, ...extra, song: { ...songOf(code), groups: [] } });
  return { withSong, plain };
}

test('the song only places strips: every strip, bus and note of the model is the same with and without it', () => {
  const pieces = [
    groupPiece(`${PLAIN_LINES}\nloose: note('c3').room(0.3).gain(0.4)`),
    bigPiece(12),
    bigPiece(4, (name) => `${name}: play('${name}', ${name}).lpf(800).room(0.2).postgain(0.5)`),
  ];
  for (const code of pieces) {
    const { withSong, plain } = withAndWithoutSong(code);
    assert.equal(withSong.status, 'ready');
    assert.notEqual(withSong.layout, null);
    assert.equal(plain.layout, null);
    assert.deepEqual(withSong.strips, plain.strips);
    assert.deepEqual(withSong.buses, plain.buses);
    assert.deepEqual(withSong.busMemory, plain.busMemory);
    assert.equal(withSong.noNotesText, plain.noNotesText);
  }
});

test('a MIDI strip in a structured piece is the same with and without the song', () => {
  const code = bigPiece(3, (name) => (name === 't2' ? `t2: play('t2', t2).midi('Port A', { midichannel: 3, controls: { volume: 90 } })` : `${name}: play('${name}', ${name})`));
  const { withSong, plain } = withAndWithoutSong(code, RIG);
  const midi = withSong.strips.find((strip) => strip.identity === 'label:t2');
  assert.notEqual(midi.midi, null);
  assert.deepEqual(withSong.strips, plain.strips);
  assert.equal(midi.sharedRoot, false);
});

test('a structured piece whose song names no groups has no layout and the same strips', () => {
  const code = groupPiece(PLAIN_LINES).replace(/groups: \{[^\n]*?\}, plan/, 'plan');
  assert.doesNotMatch(code, /groups:/);
  const { withSong, plain } = withAndWithoutSong(code);
  assert.equal(withSong.status, 'ready');
  assert.equal(withSong.layout, null);
  assert.deepEqual(withSong.strips, plain.strips);
});
