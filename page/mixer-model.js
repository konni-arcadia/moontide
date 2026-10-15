// Pure module for the Mixer view: the copy it shows, the history label a gesture records, and
// the model the view draws (one strip per track, in code order). No DOM access at import time,
// so this module can be imported directly by node:test and by page/main.js without a build step.
// `parse` (acorn) is injected, like page/tracks.js.

import { readProgram } from './mixer-rewrite.js';
import { controlsByCc, controlsText, defaultOf, faderControl, midiTag, readMidiTracks, sweepKey } from './midi-controls.js';
import { fill } from './midi-plan.js';
import { groupActions, mixerLayout } from './mixer-groups.js';
import { SONG_COPY, countText, displayName, quoted } from './structure.js';
import { labelKey, parseLabel } from './tracks.js';
import { BUSES, BUS_IDS, DEFAULT_POSTGAIN, EFFECTS, EFFECT_IDS, MOVE_SHAPES, PARAM_STEPS, SENDS, busParamById, effectById, fixedValueOf, formatDisplayNumber, formatNumber, gainToPosition, normalizeStoredCall, valueToPosition } from './mixer-registry.js';

/** Page-visible copy for the Mixer view. `notSaved` is shown
 * through errorLineText, which adds the 'Error: ' prefix. `cannotRead` has no copy of its own: it
 * follows PARTS_COPY.cannotRead for a program the pinned parser cannot read. */
export const MIXER_COPY = {
  empty: 'Nothing is playing yet.',
  faderDefault: 'default',
  faderDefaultTitle: 'This fader multiplies what the code plays; 1.00 plays it as written.',
  notSaved: 'mixer change was not saved to history — try again.',
  moveFailed: 'the last mixer move could not be applied — see the browser console.',
  faderAfterGain: 'after gain',
  faderAfterGainTitle: 'The gain moves in the code, so this fader sets a level after it.',
  faderBothMoving: 'Gain and post-gain both move in the code.',
  faderPostgainMoving: 'The post-gain moves in the code.',
  // A track that plays MIDI without a MIDI strip (its .midi() is in shared code or inside another call, or the MIDI setup could not be read): MIDI ignores a post-gain.
  faderPlaysMidi: 'Plays MIDI the mixer has no control for. Ask Claude to change its level.',
  faderPlaysMidiTitle: 'A fader here would write a post-gain, and MIDI output ignores a post-gain.',
  // A post-gain set inside the track or in the shared code it reads: the fader's own would replace it, as a later gain replaces gains.
  faderInnerPostgain: 'A post-gain is set inside the track. Ask Claude to change its level.',
  faderInnerPostgainTitle: 'A fader here would write a post-gain at the end of the track and flatten the post-gains set inside it.',
  cannotRead: "The mixer couldn't read this code.",
  mute: 'Mute',
  solo: 'Solo',
  soloByName: 'Starts with a capital S — Strudel plays this track alone.',
  soloNeedsLabel: 'Solo and the light need a label — ask Claude to name this track.',
  lightTrackTitle: 'Blinks when {name} plays a note',
  lightGroupTitle: 'Blinks when any track of {group} plays a note',
  addEffect: 'Add effect',
  off: 'off',
  moving: 'moving',
  bypassTitle: 'Bypass (removes it from the code while off)',
  bypassNeedsFixed: 'Bypass needs fixed values; use a fixed value first, or Remove.',
  bypassNeedsRange: "Bypass needs values inside this effect's range; use Remove.",
  close: 'Close',
  moreParams: 'More parameters ({N})',
  fewerParams: 'Fewer parameters',
  writtenAs: 'Written as',
  bypassedLine: 'Bypassed — not in the code.',
  untouched: "Parameters you don't touch keep Strudel's default and are not written.",
  remove: 'Remove',
  gone: 'This effect is no longer in the code.',
  movingFromCode: 'Moving (from code)',
  useFixed: 'Use a fixed value',
  defaultButton: 'Default',
  fixed: 'Fixed',
  moves: 'Moves',
  from: 'From (Hz)',
  to: 'To (Hz)',
  over: 'Over (cycles)',
  shape: 'Shape',
  paramDefault: 'default',
  reverb: 'Reverb',
  delay: 'Delay',
  reverbBus: 'Reverb bus',
  delayBus: 'Delay bus',
  fedBy: 'Fed by {names}',
  fedByNone: 'Fed by no track',
  // A track that sets its own orbit, send or bus values off its own chain (in shared code, inside another call, through .set): the mixer reads only the track's own chain, so it cannot tell which bus the track is on.
  sendsHidden: "This track sets its own orbit or bus values somewhere the mixer can't read. Ask Claude to change its sends.",
  sendMoving: 'The send moves in the code. Ask Claude to change it.',
  // The readout of a send the mixer cannot know: the code it does not read may set it.
  noSendValue: '\u2013',
  // A browser track that plays MIDI (its .midi() is in shared code or off its own chain, so it has no MIDI strip): MIDI output never plays the browser's effects, reverb or delay.
  playsMidi: 'Plays MIDI, which has no effects, reverb or delay here. Ask Claude to change its sound.',
  playsMidiBypass: 'This track plays MIDI, which ignores effects. Ask Claude.',
  mixed: 'mixed',
  disagree: 'Tracks disagree on {names}. Changing any value here sets it on every sending track.',
  reverbCostly: 'Size, fade, lowpass and damping recalculate the reverb, so they apply when you let go.',
  delayNote: 'Feedback near 1 runs away. Keep it below 0.9.',
  disconnected: 'Disconnected — the mixer is off until Moontide reconnects.',
  dirty: 'The editor has changes that are not playing yet. Evaluate them first — the mixer works on the playing code.',
  // A change waits for its bar or phrase line: the mixer reads the playing code and cannot write until the takeover.
  waiting: 'A change is waiting for its bar line. The mixer works again when it takes over.',
  // One line per refusal reason of page/mixer-rewrite.js (REFUSAL_REASONS), shown under a strip's name.
  reasons: {
    condition: "Depends on a condition — the mixer can't edit it.",
    'unsupported-shape': "Written in a shape the mixer doesn't understand.",
  },
  // A strip built from shared code (a declared constant or function) shows this muted line; the mixer reads only the track's own chain.
  sharedRoot: 'Built from shared code',
  // The accessible name of a group's frame; the group name is cut to 40 code points like every name in a sentence.
  groupLabel: 'Group {group}',
  // Mute and solo on a group: the accessible names, the hover texts, the count line and the notes. {tracks} is '1 track' or
  // '{count} tracks'; {k} of {n} counts the reachable tracks that are muted (or soloed), {j} the soloed ones in the both-partial line.
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
  sharedRootTitle: 'The mixer shows and changes only what this track writes after the shared code.',
  // The fader of a MIDI track sets the instrument's own volume (CC7), written in the .midi() options.
  midiFaderLine: 'instrument volume',
  midiFaderLineTitle: "The fader sets the instrument's own volume (CC7). Gain and velocity in the code stay as they are.",
  midiFaderLabel: '{track} instrument volume',
  unavailable: 'unavailable',
  // One line per reason a MIDI track's controls are off (page/midi-controls.js readMidiTracks), shown under its name.
  midiReasons: {
    noModel: 'No instruments.json — describe this instrument there to use its controls.',
    invalidModel: "instruments.json is invalid — fix it to use this instrument's controls.",
    rigUnreadable: "The page couldn't read the MIDI setup — restart Claude (the server) to use this instrument's controls.",
    buildMismatch: "The server and the page come from different builds — restart Claude (the server) to use this instrument's controls.",
    optionsNotPlain: "Options aren't plain values — the mixer can't edit this instrument's controls.",
    portNotPlain: "Port or channel isn't plain — the mixer can't edit this instrument's controls.",
    portNotInFile: "Port isn't in instruments.json — add it there to use its controls.",
    noVolume: "This instrument's model has no volume control.",
  },
  // The chips, the note and the controls inspector of a MIDI strip. Browser effects never reach an
  // external instrument, so a MIDI strip says so instead of drawing them.
  midiChipLabel: '{name} on {track}: {value}. Edit controls.',
  midiChipTitle: '{name}, {min}\u2013{max}',
  midiEffectsNote: "Browser effects don't reach an external instrument.",
  midiInspectorTitle: 'Controls \u00b7 {track}',
  midiRowDefault: 'default {value}',
  midiDefaultTitle: "Back to the instrument's default ({value}). Removes it from the code.",
  midiNothingWritten: 'Nothing written \u2014 the instrument keeps its defaults.',
  midiFooter: "Controls you don't touch are not written to the code; the instrument keeps its default.",
  midiGone: 'This MIDI track is no longer in the code.',
  // Tracks on one instrument and channel share its controls: each strip names the others and a change is written on all of them.
  midiShared: 'Shared with {names}',
  noNotes: 'No notes: {list}',
  noNotesTitle: 'These MIDI tracks play no notes (they send only controls, program changes or a clock), so they have no strip. The mixer cannot mute, solo or edit them: ask Claude to change them.',
  // Added to a listed track that does not sound now (its own mute, a hush, or a solo on another track).
  noNotesSilent: 'silent',
  midiInspectorShared: 'Channel {n} is shared with {names}. A change here is written on every one of these tracks.',
  // A sweep (ccn/ccv) Claude wrote moves a control: the mixer never fights it, so the control is shown as moving and off.
  midiSweepRow: 'A sweep in the code moves this control on channel {n}. Ask Claude to change it.',
  midiSweepFader: 'A sweep in the code moves the volume on channel {n}. Ask Claude to change it.',
  midiSweepUnknown: "A sweep in the code on channel {n} uses a controller the mixer can't read. Ask Claude to change it.",
};

/**
 * The one notice line the Mixer shows above its strips, or none: `{ kind, text }`. The order is disconnected,
 * a change waiting for its line, an unevaluated hand edit ('connecting' counts as
 * not connected). Any notice turns every writing control off.
 */
export function mixerNotice({ connection, dirty, waiting = false }) {
  if (connection !== 'connected') return { kind: 'disconnected', text: MIXER_COPY.disconnected };
  if (waiting) return { kind: 'waiting', text: MIXER_COPY.waiting };
  if (dirty) return { kind: 'dirty', text: MIXER_COPY.dirty };
  return { kind: null, text: '' };
}

/** The sentence that says why a strip cannot be edited. An unknown reason throws (loud). */
function reasonTextFor(reason) {
  if (reason === null) return null;
  const text = MIXER_COPY.reasons[reason];
  if (typeof text !== 'string') throw new Error(`Moontide: unknown mixer refusal reason '${String(reason)}'.`);
  return text;
}

/** The sentence that says why a MIDI track's controls are off. An unknown reason throws (loud). */
function midiReasonText(reason) {
  if (reason === null) return null;
  const text = MIXER_COPY.midiReasons[reason];
  if (typeof text !== 'string') throw new Error(`Moontide: unknown MIDI controls reason '${String(reason)}'.`);
  return text;
}

/** Mirrors src/protocol.ts's MAX_MIXER_LABEL_LENGTH by hand (test/mixer-model.test.js checks both). */
export const MAX_MIXER_LABEL_LENGTH = 200;

/** A history label clipped to MAX_MIXER_LABEL_LENGTH (with a trailing '…' when cut) before it is
 * sent to the server as the `mixer-record` message's `label` field (src/protocol.ts's own limit). */
export function clipMixerLabel(text) {
  if (text.length <= MAX_MIXER_LABEL_LENGTH) return text;
  return `${text.slice(0, MAX_MIXER_LABEL_LENGTH - 1)}…`;
}

/**
 * The history label a gesture records. `action` is `{ kind:
 * 'volume', name, value }`, `{ kind: 'mute', name, on }`, `{ kind: 'solo', name, on }` or `{ kind:
 * 'add-effect' | 'remove' | 'remove-effect' | 'bypass' | 'restore', name, effect }` (`effect` an effect id, written by
 * its plain name lower-cased), `{ kind: 'param', name, effect, param, value }` (`param` a parameter
 * id of the effect, written by its plain name lower-cased) or `{ kind: 'param-default', name, effect,
 * param }` or `{ kind: 'group-mute' | 'group-solo', group, on }` (a group's mute or solo, named by the group alone) or `{ kind: 'move', name, effect, from, to, over }` (a filter move) or `{ kind: 'send', name, bus, value }`
 * (`bus` 'reverb' or 'delay') or `{ kind: 'bus-param', bus, param, value }` (a bus is one thing: no track name). An
 * unknown kind throws (a loud error), so a new kind cannot forget its label. A MIDI control is
 * `{ kind: 'midi-control', name, control, value }` or `{ kind: 'midi-control-default', name, control }` (`control` the
 * declared name of the control, written lower-cased).
 */
export function mixerHistoryLabel(action) {
  if (action && action.kind === 'volume') {
    return `mixer: ${action.name} volume ${formatNumber(action.value)}`;
  }
  if (action && action.kind === 'mute') {
    return `mixer: ${action.name} ${action.on ? 'muted' : 'unmuted'}`;
  }
  if (action && action.kind === 'solo') {
    return `mixer: ${action.name} solo ${action.on ? 'on' : 'off'}`;
  }
  if (action && action.kind === 'group-mute') {
    return `mixer: group ${displayName(action.group)} ${action.on ? 'muted' : 'unmuted'}`;
  }
  if (action && action.kind === 'group-solo') {
    return `mixer: group ${displayName(action.group)} solo ${action.on ? 'on' : 'off'}`;
  }
  if (action && action.kind === 'add-effect') {
    return `mixer: ${action.name} added ${effectById(action.effect).name.toLowerCase()}`;
  }
  if (action && (action.kind === 'remove' || action.kind === 'remove-effect')) {
    return `mixer: ${action.name} removed ${effectById(action.effect).name.toLowerCase()}`;
  }
  if (action && (action.kind === 'param' || action.kind === 'param-default')) {
    const effect = effectById(action.effect);
    const param = effect.params.find((candidate) => candidate.id === action.param);
    if (!param) throw new Error(`Moontide: unknown parameter '${String(action.param)}' of ${effect.name}.`);
    const head = `mixer: ${action.name} ${effect.name.toLowerCase()} ${param.name.toLowerCase()}`;
    if (action.kind === 'param-default') return `${head} default`;
    return `${head} ${typeof action.value === 'string' ? action.value : formatNumber(action.value)}`;
  }
  if (action && action.kind === 'move') {
    return `mixer: ${action.name} ${effectById(action.effect).name.toLowerCase()} moves ${formatNumber(action.from)} to ${formatNumber(action.to)} over ${action.over} cycles`;
  }
  if (action && action.kind === 'send') {
    if (!Object.hasOwn(SENDS, action.bus)) throw new Error(`Moontide: unknown send '${String(action.bus)}'.`);
    return `mixer: ${action.name} ${action.bus} send ${formatNumber(action.value)}`;
  }
  if (action && action.kind === 'bus-param') {
    const param = busParamById(action.bus, action.param);
    if (param === null) throw new Error(`Moontide: unknown bus parameter '${String(action.bus)}.${String(action.param)}'.`);
    return `mixer: ${action.bus} ${param.name.toLowerCase()} ${formatNumber(action.value)}`;
  }
  if (action && action.kind === 'bypass') {
    return `mixer: ${action.name} bypassed ${effectById(action.effect).name.toLowerCase()}`;
  }
  if (action && action.kind === 'restore') {
    return `mixer: ${action.name} ${effectById(action.effect).name.toLowerCase()} back on`;
  }
  if (action && action.kind === 'midi-control') {
    return `mixer: ${action.name} ${action.control.toLowerCase()} ${formatNumber(action.value)}`;
  }
  if (action && action.kind === 'midi-control-default') {
    return `mixer: ${action.name} ${action.control.toLowerCase()} default`;
  }
  throw new Error(`Moontide: unknown mixer action '${String(action && action.kind)}'.`);
}

/** The muted line under the readout for each `line` state, and its hover text (null: none). */
function faderLine(line) {
  if (line === null) return { text: null, title: null };
  if (line === 'default') return { text: MIXER_COPY.faderDefault, title: MIXER_COPY.faderDefaultTitle };
  if (line === 'after-gain') return { text: MIXER_COPY.faderAfterGain, title: MIXER_COPY.faderAfterGainTitle };
  if (line === 'both-moving') return { text: MIXER_COPY.faderBothMoving, title: null };
  if (line === 'postgain-moving') return { text: MIXER_COPY.faderPostgainMoving, title: null };
  if (line === 'inner-postgain') return { text: MIXER_COPY.faderInnerPostgain, title: MIXER_COPY.faderInnerPostgainTitle };
  if (line === 'plays-midi') return { text: MIXER_COPY.faderPlaysMidi, title: MIXER_COPY.faderPlaysMidiTitle };
  throw new Error(`Moontide: unknown fader line '${String(line)}'.`);
}

/** The fader facts of one strip: which control it writes, its value, and the muted line under it. */
function faderModel(read) {
  const fader = (target, value, line, disabled) => ({
    target,
    value,
    position: gainToPosition(value),
    readout: value.toFixed(2),
    // The readout is muted while it shows the default (the code holds no gain).
    readoutMuted: line === 'default',
    line,
    lineText: faderLine(line).text,
    lineTitle: faderLine(line).title,
    disabled,
  });
  if (!read.ok) return fader(null, DEFAULT_POSTGAIN, null, true);
  const { gain, postgain } = read;
  if (gain.kind === 'fixed') return fader('gain', gain.value, null, false);
  // From here the fader writes a post-gain, which MIDI output ignores: such a track gets no fader.
  if (read.playsMidi) return fader(null, DEFAULT_POSTGAIN, 'plays-midi', true);
  // A post-gain set inside the track (or its shared code) would be replaced, not scaled, by the fader's own.
  if (read.innerPostgain) return fader(null, DEFAULT_POSTGAIN, 'inner-postgain', true);
  if (gain.kind === 'none') {
    // No gain of its own: the fader multiplies what the code plays with a post-gain (1 = as written).
    if (postgain.kind === 'pattern') return fader(null, DEFAULT_POSTGAIN, 'postgain-moving', true);
    if (postgain.kind === 'fixed') return fader('postgain', postgain.value, null, false);
    return fader('postgain', DEFAULT_POSTGAIN, 'default', false);
  }
  // The gain moves (a pattern or a signal): the fader writes the post-gain and leaves it alone.
  if (postgain.kind === 'pattern') return fader(null, DEFAULT_POSTGAIN, 'both-moving', true);
  return fader('postgain', postgain.kind === 'fixed' ? postgain.value : 1, 'after-gain', false);
}

/**
 * The fader of a MIDI strip: the instrument's own volume (CC7), 0 to 127 in the model's units. `value` is the
 * number the code writes for the volume control, else the model's default (muted, line 'default'). Off (readout
 * an en dash, `ariaValueText` 'unavailable') while the strip read failed, a reason is set or the model has no
 * volume control. `control` is the id of the control the fader writes, null while it is off. `sweep` is the sentence
 * that says a sweep in the code moves the volume (or a controller the page cannot read), or null: the fader is then
 * disabled with that line (`line` 'sweep') and keeps the value the code writes, else the default, muted.
 */
function midiFaderModel(read, midi, instrument, control, sweep) {
  if (!read.ok || midi.reason !== null || instrument === null || control === null) {
    return {
      kind: 'midi',
      control: null,
      cc: 7,
      min: 0,
      max: 127,
      value: null,
      position: 0,
      readout: '–',
      readoutMuted: true,
      line: null,
      lineText: null,
      lineTitle: null,
      ariaValueText: MIXER_COPY.unavailable,
      disabled: true,
    };
  }
  const written = midi.controls.get(control.id);
  const value = written ?? defaultOf(instrument, control);
  if (sweep !== null) {
    return {
      kind: 'midi',
      control: control.id,
      cc: control.cc,
      min: control.min,
      max: control.max,
      value,
      position: value,
      readout: String(value),
      readoutMuted: true,
      line: 'sweep',
      lineText: sweep,
      lineTitle: null,
      ariaValueText: String(value),
      disabled: true,
    };
  }
  return {
    kind: 'midi',
    control: control.id,
    cc: control.cc,
    min: control.min,
    max: control.max,
    value,
    position: value,
    readout: String(value),
    readoutMuted: written === undefined,
    line: written === undefined ? 'default' : 'written',
    lineText: written === undefined ? MIXER_COPY.faderDefault : MIXER_COPY.midiFaderLine,
    lineTitle: written === undefined ? null : MIXER_COPY.midiFaderLineTitle,
    ariaValueText: String(value),
    disabled: false,
  };
}

/**
 * The mute and solo buttons of one strip: `{ mute: { pressed, disabled, reasonText }, solo: {
 * pressed, disabled, noteText } }`. Mute is pressed while the track silences itself (a `_` in its
 * label); solo is pressed while its label plays alone (the mixer's marker, or a name that starts
 * with a capital S, which the mixer never renames: that S is disabled and carries the note). A
 * marker a mute silences is not pressed. `reasonText` and `noteText` are the one muted sentence
 * that says why a button is off, or null.
 */
function muteSoloModel(track) {
  if (track.kind !== 'label') {
    return {
      // Without a label, mute adds .hush() and solo is not possible.
      mute: { pressed: track.ownMuted, disabled: false, reasonText: null },
      solo: { pressed: false, disabled: true, noteText: MIXER_COPY.soloNeedsLabel },
    };
  }
  const label = parseLabel(track.label);
  if (!label.safe) {
    // A label the mixer cannot rewrite without guessing: both buttons are off and one line says why.
    return {
      mute: { pressed: track.ownMuted, disabled: true, reasonText: MIXER_COPY.reasons['unsupported-shape'] },
      solo: { pressed: false, disabled: true, noteText: null },
    };
  }
  const nativeSolo = label.solo === 'name' || (label.solo === 'marker' && label.base.length > 1 && label.base.startsWith('S'));
  return {
    mute: { pressed: track.ownMuted, disabled: false, reasonText: null },
    solo: {
      pressed: label.solo === 'name' || (label.solo === 'marker' && !label.soloInert),
      disabled: nativeSolo,
      noteText: nativeSolo ? MIXER_COPY.soloByName : null,
    },
  };
}

/** The text a written parameter reads in a chip: its value with its unit, or `moving` for a pattern. */
function paramText(param, read) {
  if (read.kind === 'pattern') return MIXER_COPY.moving;
  // A filter move reads its range: `400–2000 Hz` (an en dash).
  if (read.kind === 'move') {
    const range = `${formatDisplayNumber(read.move.from)}\u2013${formatDisplayNumber(read.move.to)}`;
    return param.unit === '' ? range : `${range} ${param.unit}`;
  }
  const unit = param.alt && read.method === param.alt.method ? param.alt.unit : param.unit;
  const value = param.kind === 'select' ? read.value : formatDisplayNumber(read.value);
  return unit === '' ? value : `${value} ${unit}`;
}

/** The value a chip shows: the first written parameter with its unit, plus ` +N` for N more
 * written parameters (`1200 Hz +1`); the compressor leads with its threshold (`−20 dB`). */
function chipSummary(effect, read) {
  const written = effect.params.filter((param) => read.params[param.id].kind !== 'unwritten');
  if (written.length === 0) return '';
  const first = paramText(written[0], read.params[written[0].id]);
  return written.length > 1 ? `${first} +${written.length - 1}` : first;
}

/** The reason a chip's bypass is off, or null: a value that moves in the code, or one the registry cannot store. */
function bypassReasonFor(effect) {
  if (effect.bypassable) return null;
  return effect.bypassWhy === 'range' ? MIXER_COPY.bypassNeedsRange : MIXER_COPY.bypassNeedsFixed;
}

/**
 * The chips of a readable strip, in Strudel's fixed chain order: one per effect in the code, and one
 * reading `off` for an effect the page keeps a bypass record for (`records`, this track's own).
 * A bypassed chip carries the stored `calls` a turn-on writes back.
 */
function chipsFor(read, records, playsMidi) {
  const chips = [];
  for (const effect of EFFECTS) {
    const code = read.effects.get(effect.id);
    if (code) {
      const summary = chipSummary(effect, code);
      const reason = playsMidi ? MIXER_COPY.playsMidiBypass : bypassReasonFor(code);
      chips.push({ effect: effect.id, name: effect.name, summary, title: `${effect.name} ${summary}`, bypassed: false, bypassDisabled: reason !== null, bypassReason: reason });
      continue;
    }
    const record = records.find((candidate) => candidate.effect === effect.id);
    if (record) {
      chips.push({ effect: effect.id, name: effect.name, summary: MIXER_COPY.off, title: `${effect.name} ${MIXER_COPY.off}`, bypassed: true, bypassDisabled: playsMidi, bypassReason: playsMidi ? MIXER_COPY.playsMidiBypass : null, calls: record.calls });
    }
  }
  return chips;
}

/** The effects the Add effect list offers: the ones the track neither has nor keeps bypassed, in chain order. */
function addListFor(read, records) {
  return EFFECTS.filter((effect) => !read.effects.has(effect.id) && !records.some((record) => record.effect === effect.id)).map((effect) => ({
    effect: effect.id,
    name: effect.name,
    method: effect.params[0].method,
  }));
}

// --- Bypass records: what the page keeps in browser storage for an effect that is off ---

/** The one storage key of the bypass records (a JSON array, oldest first). */
export const BYPASS_STORAGE_KEY = 'moontide.mixerBypass';

/** At most this many records are kept; the oldest is dropped first. */
export const BYPASS_RECORD_CAP = 64;

const MAX_BYPASS_IDENTITY_LENGTH = 500;
const MAX_BYPASS_CALLS = 16;

/** A raw record rebuilt as `{ identity, effect, calls }` from the closed shape, or null. Every call
 * goes through the registry, so nothing but numbers in range, listed strings and a filter move (a
 * shape of MOVE_SHAPES, two numbers in range, a whole number of cycles) survives. */
function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { identity, effect, calls } = raw;
  if (typeof identity !== 'string' || identity === '' || identity.length > MAX_BYPASS_IDENTITY_LENGTH) return null;
  if (typeof effect !== 'string' || !EFFECT_IDS.has(effect)) return null;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_BYPASS_CALLS) return null;
  const normalized = calls.map((call) => normalizeStoredCall(effect, call));
  return normalized.every((call) => call !== null) ? { identity, effect, calls: normalized } : null;
}

/** `records` with `record` added as the newest, replacing the one of the same track and effect; the
 * oldest is dropped past the cap. Returns a new array. */
export function rememberBypass(records, record) {
  const kept = records.filter((candidate) => candidate.identity !== record.identity || candidate.effect !== record.effect);
  return [...kept, record].slice(-BYPASS_RECORD_CAP);
}

/** `records` without the one of this track and effect. Returns a new array. */
export function forgetBypass(records, identity, effect) {
  return records.filter((record) => record.identity !== identity || record.effect !== effect);
}

/**
 * Reads the bypass records from `storage` (a localStorage-like object, or null): `{ records,
 * available }`. Never throws: a blocked storage is `available: false`, and unreadable JSON, a
 * non-array and every record outside the closed shape read as nothing. At most the newest 64 stay.
 */
export function readBypassRecords(storage) {
  let raw;
  try {
    raw = storage ? storage.getItem(BYPASS_STORAGE_KEY) : undefined;
  } catch {
    return { records: [], available: false };
  }
  if (raw === undefined) return { records: [], available: false };
  if (raw === null) return { records: [], available: true };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { records: [], available: true };
  }
  if (!Array.isArray(parsed)) return { records: [], available: true };
  let records = [];
  for (const item of parsed) {
    const record = normalizeRecord(item);
    if (record !== null) records = rememberBypass(records, record);
  }
  return { records, available: true };
}

/** Writes the records to `storage`. Returns false, and never throws, when the storage is missing or refuses. */
export function writeBypassRecords(storage, records) {
  if (!storage) return false;
  try {
    storage.setItem(BYPASS_STORAGE_KEY, JSON.stringify(records.slice(-BYPASS_RECORD_CAP)));
    return true;
  } catch {
    return false;
  }
}

// --- Sends and buses ---

/** True for a send above 0, or one that moves in the code: the track feeds the bus. */
function isSending(send) {
  return send.kind === 'pattern' || (send.kind === 'fixed' && send.value > 0);
}

/** The text a bus parameter reads in a chip: `mixed`, `default`, `moving`, or its value with its unit. */
function busStateText(param, state) {
  if (state.state === 'moving') return MIXER_COPY.moving;
  if (state.state === 'mixed') return MIXER_COPY.mixed;
  if (state.state === 'default') return MIXER_COPY.paramDefault;
  const value = formatDisplayNumber(state.value);
  return param.unit === '' ? value : `${value} ${param.unit}`;
}

/**
 * What one bus parameter is across the tracks that send to the bus: `{ id, param, state: 'default' |
 * 'value' | 'mixed' | 'moving', value, disagree, joinValue, alignValue }`. Disagreement follows
 * Strudel's own rule for the bus (BUSES `unwrittenIsDefault`): the reverb only changes for a value that
 * is written, so an unwritten one never disagrees; the delay fills in its defaults, so an unwritten
 * value counts as the default (the delay time's default has no plain number, so it differs from every
 * written one). A parameter that moves in the code on any sender is `moving` and never disagrees.
 * `joinValue` is what a track that starts sending takes: the first sender's written value. `alignValue`
 * is what a hand change aligns to: the reverb's first written value; the delay's first sender, where an
 * unwritten value is null (removed everywhere, so every sender uses the default). With no sender the
 * value comes from `remembered` (the bus memory).
 */
function busParamStates(bus, senders, remembered) {
  return BUSES[bus].params.map((param) => {
    if (senders.length === 0) {
      const value = Object.hasOwn(remembered, param.id) ? remembered[param.id] : undefined;
      return { id: param.id, param, state: value === undefined ? 'default' : 'value', value: value ?? null, disagree: false, joinValue: value, alignValue: undefined };
    }
    const reads = senders.map((sender) => sender.busReads.busParams[bus][param.id]);
    const written = reads.filter((read) => read.kind === 'fixed').map((read) => read.value);
    const joinValue = written.length > 0 ? written[0] : undefined;
    if (reads.some((read) => read.kind === 'pattern')) {
      return { id: param.id, param, state: 'moving', value: null, disagree: false, joinValue, alignValue: undefined };
    }
    const compared = BUSES[bus].unwrittenIsDefault ? reads.map((read) => (read.kind === 'fixed' ? read.value : (param.strudelDefault ?? 'default'))) : written;
    const disagree = new Set(compared).size > 1;
    if (disagree) {
      const alignValue = BUSES[bus].unwrittenIsDefault ? (reads[0].kind === 'fixed' ? reads[0].value : null) : written[0];
      return { id: param.id, param, state: 'mixed', value: null, disagree, joinValue, alignValue };
    }
    if (written.length === 0) return { id: param.id, param, state: 'default', value: null, disagree, joinValue, alignValue: undefined };
    return { id: param.id, param, state: 'value', value: compared[0], disagree, joinValue, alignValue: undefined };
  });
}

/**
 * The bus strips, one per orbit and bus that has at least one sending track (in orbit order, the
 * reverb before the delay), plus the bus `keepBus` (`{ orbit, bus }`, the one whose inspector is
 * open) even with no sender. Returns `{ buses, busMemory }`; `busMemory` (a Map from `${orbit}:${bus}`
 * to the last written values the bus was seen with) is copied and refreshed, so a bus survives its
 * last sender being dragged through 0. The orbit is read from the code and never written.
 */
function busEntries(strips, busMemory, keepBus) {
  const groups = new Map();
  const ensure = (orbit, bus) => {
    const key = `${orbit}:${bus}`;
    if (!groups.has(key)) groups.set(key, { key, orbit, bus, senders: [] });
    return groups.get(key);
  };
  for (const strip of strips) {
    if (strip.busReads === null || strip.orbit === null) continue;
    for (const bus of BUS_IDS) if (isSending(strip.busReads.sends[bus])) ensure(strip.orbit, bus).senders.push(strip);
  }
  if (keepBus) ensure(keepBus.orbit, keepBus.bus);
  const ordered = [...groups.values()].sort((a, b) => a.orbit - b.orbit || BUS_IDS.indexOf(a.bus) - BUS_IDS.indexOf(b.bus));
  const orbitsInUse = new Set(ordered.filter((group) => group.senders.length > 0).map((group) => group.orbit));
  const memory = new Map(busMemory);
  const buses = ordered.map((group) => {
    const states = busParamStates(group.bus, group.senders, memory.get(group.key) ?? {});
    const joinValues = Object.fromEntries(states.filter((state) => state.joinValue !== undefined).map((state) => [state.id, state.joinValue]));
    if (group.senders.length > 0) memory.set(group.key, joinValues);
    const disagreeing = states.filter((state) => state.disagree);
    const names = group.senders.map((sender) => sender.name);
    const base = group.bus === 'reverb' ? MIXER_COPY.reverbBus : MIXER_COPY.delayBus;
    return {
      key: group.key,
      orbit: group.orbit,
      bus: group.bus,
      title: orbitsInUse.size > 1 ? `${base} \u00b7 orbit ${formatNumber(group.orbit)}` : base,
      chips: states.map((state) => ({ param: state.id, name: state.param.name, valueText: busStateText(state.param, state) })),
      fedBy: names,
      fedByText: names.length > 0 ? MIXER_COPY.fedBy.replace('{names}', names.join(', ')) : MIXER_COPY.fedByNone,
      senders: group.senders.map((sender) => sender.identity),
      disagree: disagreeing.map((state) => state.param.name.toLowerCase()),
      disagreeIds: disagreeing.map((state) => state.id),
      warningText: disagreeing.length > 0 ? MIXER_COPY.disagree.replace('{names}', disagreeing.map((state) => state.param.name.toLowerCase()).join(', ')) : null,
      alignValues: Object.fromEntries(disagreeing.map((state) => [state.id, state.alignValue])),
      joinValues,
      states,
      editable: group.senders.length > 0,
    };
  });
  return { buses, busMemory: memory };
}

/** The two send rows of one strip, reverb then delay: `{ bus, label, value, position, readout, muted,
 * moving, disabled, title, joinParams }`. `joinParams` are the bus values a track that starts sending takes. */
function sendRowsFor(strip, memory) {
  return BUS_IDS.map((bus) => {
    // A strip with no bus facts (bus hidden, or a MIDI track) still shows what its own chain writes for the send, never an invented value.
    const reads = strip.busReads !== null ? strip.busReads.sends : strip.ownSends ?? null;
    const send = reads ? reads[bus] : { kind: 'unwritten', value: null };
    const orbitMoves = strip.busReads !== null && strip.orbit === null;
    const moving = send.kind === 'pattern';
    const value = send.kind === 'fixed' ? send.value : 0;
    // The code the mixer does not read may set the send itself: with nothing on the chain, the true value is unknown and the row shows none.
    const unknown = strip.busHidden === true && send.kind === 'unwritten';
    let title = null;
    if (strip.playsMidi === true) title = MIXER_COPY.playsMidi;
    else if (strip.busHidden === true) title = MIXER_COPY.sendsHidden;
    else if (moving) title = MIXER_COPY.sendMoving;
    else if (orbitMoves) title = MIXER_COPY.reasons['unsupported-shape'];
    return {
      bus,
      label: bus === 'reverb' ? MIXER_COPY.reverb : MIXER_COPY.delay,
      value,
      position: Math.min(1, Math.max(0, value)),
      readout: unknown ? MIXER_COPY.noSendValue : value.toFixed(2),
      muted: value <= 0,
      moving,
      disabled: strip.busReads === null || orbitMoves,
      title,
      joinParams: strip.orbit === null ? {} : { ...(memory.get(`${strip.orbit}:${bus}`) ?? {}) },
    };
  });
}

/**
 * The model the Mixer draws for `code`: `{ status, strips }`. `status` is 'empty' (no code, or no
 * tracks), 'unreadable' (the parser threw; the error rides along as `error` for the caller to
 * log) or 'ready'. Each strip, in extractTracks order (the Timeline lane order): `{ identity,
 * name, sounding, mute, solo, color, editable, reason, reasonText, fader }`, `name` the track's
 * display name (without Strudel's mute underscore and the mixer's solo marker), with `color` from `colorOf(identity)`, `editable` and
 * `reason` from readProgram, `fader = { target, value, position, readout, readoutMuted, line, lineText, lineTitle, disabled }`,
 * `chips` (`{ effect, name, summary, title, bypassed, bypassDisabled, bypassReason }`, in chain order;
 * a bypassed chip also carries `calls`) and `addList` (`{ effect, name, method }`, the effects the
 * track neither has nor keeps bypassed, in chain order) and `effectReads` (a Map from effect id to the
 * parameter reads of `readProgram`, for inspectorModel). `bypassRecords` are the page's stored
 * records; a ready model's `staleRecords` (`{ identity, effect }`) are those whose effect is back in the code.
 * Every strip also has `orbit` (a number, or null when its orbit moves in the code) and `sends` (see
 * sendRowsFor), and the model has `buses` (see busEntries) and `busMemory`: pass the returned `busMemory`
 * back in on the next call, and `keepBus` (`{ orbit, bus }`) for the bus whose inspector is open. `rig` (the
 * object page/midi-rig.js parseRigMessage returns; default `{ setup: 'absent' }`) tells which MIDI tracks have a model:
 * a strip of a track that plays a MIDI instrument has `midi` (`{ instrumentId, port, channel, sound, reason,
 * reasonText }`), a MIDI fader (`fader.kind === 'midi'`: 0 to 127, the instrument's own volume, see midiFaderModel),
 * no chips, no add list and no bus facts; every other strip has `midi: null`. A strip whose track is built from
 * shared code also has `sharedRoot` (true), `sharedRootText` and `sharedRootTitle` (the muted line and its hover;
 * all three are false or null for any other strip). A browser strip whose track plays MIDI without a MIDI strip (its
 * `.midi()` is in shared code or off its own chain) has `playsMidi` (true, else false) and its own reason line: no add list,
 * no sends, no place on a bus and no editing of its effects, because MIDI output never plays them; its gain, mute and solo still work.
 * Every strip also has `lightKey`, the key the notes of its track are reported under (see lightKeysOf), or null for a track without
 * a label, which has no light. Every strip also has `index`, its track's index in the code (the index the song reading gives the same track). `song` (the
 * result of readStructure for this code; default `{ state: 'none' }`) and `folds` (a Set of the keys of folded groups; default
 * empty) give a ready model its `layout`: null when the song is not read or names no group, else mixerLayout's tree with the
 * words of each group (see groupLayout).
 */
export function buildMixerModel(input) {
  try {
    return buildModel(input);
  } catch (error) {
    // Anything the model cannot build (a value it cannot show) is reported like a parse failure:
    // the view says it cannot read the code and the caller logs the error. It never escapes a render.
    return { status: 'unreadable', strips: [], buses: [], busMemory: input.busMemory ?? new Map(), error };
  }
}

/**
 * The states of the controls of one MIDI track the chips and the inspector rows show: every control the model
 * declares except the fader's volume, in model order (one per cc), `{ control, id, name, cc, min, max, default,
 * value, written, moving }`. `value` is the number the code writes, else the model default.
 */
function midiControlStates(instrument, written, sweeps) {
  return controlsByCc(instrument)
    .filter((control) => control.cc !== 7)
    .map((control) => {
      const base = defaultOf(instrument, control);
      const own = written.get(control.id);
      const moving = sweeps.unknown || sweeps.ccs.has(control.cc);
      return {
        control,
        id: control.id,
        name: control.name,
        cc: control.cc,
        min: control.min,
        max: control.max,
        default: base,
        value: own ?? base,
        written: own !== undefined,
        moving,
        sweepText: moving ? sweeps.rowText : null,
      };
    });
}

/**
 * The sweeps that move controls of one MIDI track's port and channel: `{ unknown, ccs, rowText, faderText }`. `ccs`
 * are the controller numbers a `ccn` of the code moves there; `unknown` is true when a `ccn` the page cannot read
 * sits on that channel (every control is then moving). `rowText` and `faderText` are the sentences that say so.
 */
function midiSweepsFor(midiTrack, sweepsRead) {
  const { port, channel } = midiTrack.spine;
  const none = { unknown: false, ccs: new Set(), rowText: null, faderText: null };
  if (port === null || channel === null) return none;
  const key = sweepKey(port, channel);
  if (sweepsRead.sweepsUnknown.has(key)) {
    const text = fill(MIXER_COPY.midiSweepUnknown, { n: channel });
    return { unknown: true, ccs: new Set(), rowText: text, faderText: text };
  }
  return {
    unknown: false,
    ccs: sweepsRead.sweeps.get(key) ?? new Set(),
    rowText: fill(MIXER_COPY.midiSweepRow, { n: channel }),
    faderText: fill(MIXER_COPY.midiSweepFader, { n: channel }),
  };
}

/** The chip a control state draws on a MIDI strip: `{ control, name, cc, min, max, value, written, moving, text, label, title }`. */
function midiChipFor(state, trackName) {
  const text = state.moving ? MIXER_COPY.moving : state.written ? String(state.value) : MIXER_COPY.paramDefault;
  return {
    control: state.id,
    name: state.name,
    cc: state.cc,
    min: state.min,
    max: state.max,
    value: state.value,
    written: state.written,
    moving: state.moving,
    text,
    label: fill(MIXER_COPY.midiChipLabel, { name: state.name, track: trackName, value: text }),
    title: fill(MIXER_COPY.midiChipTitle, { name: state.name, min: state.min, max: state.max }),
  };
}

/**
 * The channel mates of every MIDI track whose port and channel the page can read, `Map<identity, mate[]>`: the tracks
 * of the same read that play the same port on the same channel (the port stands in for the instrument, so a file's
 * instrument and its port are the same key), in code order, the track itself and muted ones included. A track whose
 * channel or port cannot be read has no channel mates (its channel is unknown), so it is alone.
 */
function channelMates(midiTracks) {
  const byKey = new Map();
  for (const track of midiTracks.values()) {
    const { port, channel } = track.spine;
    if (port === null || channel === null) continue;
    const key = sweepKey(port, channel);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(track);
  }
  const mates = new Map();
  for (const members of byKey.values()) for (const member of members) mates.set(member.identity, members);
  return mates;
}

/**
 * The controls written on any of the tracks on one port and channel, `Map<id, number>`: the first one in code order that writes a
 * control gives its value (the evaluation refuses two different values of one control on one channel, so they agree).
 */
function channelControls(members) {
  const written = new Map();
  for (const member of members) {
    for (const [id, value] of member.spine.controls) if (!written.has(id)) written.set(id, value);
  }
  return written;
}

/**
 * The shared-code facts of a strip: `sharedRoot` from the read, and the muted line with its hover (null when the track is not
 * built from shared code). `canonicalPlay` is true when the piece's play() is the song helper the page knows (the song
 * reading says its helper is the canonical text).
 */
function sharedRootFacts(read, canonicalPlay) {
  // A track written with play(...) starts from the song's own helper, so it shows no shared-code line. When the helper was
  // changed, or play is some other function, that line is the warning the user needs and stays.
  const sharedRoot = read.ok && read.sharedRoot === true && !(read.playRoot === true && canonicalPlay);
  return {
    sharedRoot,
    sharedRootText: sharedRoot ? MIXER_COPY.sharedRoot : null,
    sharedRootTitle: sharedRoot ? MIXER_COPY.sharedRootTitle : null,
  };
}

/**
 * The strip of a MIDI track: the facts of a browser strip with no effect chain, no Add effect and no sends
 * (the bus facts are null, so a .room() left on a MIDI track makes no bus strip appear), plus `midi` and the
 * MIDI fader. The browser strip's reason, when the track cannot be read, stays as it is. `midi.chips` are the control
 * chips (every declared control except the volume, in model order; none while the controls are off) and
 * `midi.controls` the states they and the inspector rows are drawn from.
 */
function midiStrip(track, read, midiTrack, colorOf, sweepsRead, members, canonicalPlay) {
  const instrument = midiTrack.instrument;
  const control = instrument === null ? null : faderControl(instrument);
  // A channel mate whose controls cannot be written (a rewrite writes every track on the channel or none) turns all of them off with its reason.
  const channelReason = members.map((member) => member.reason).find((candidate) => candidate !== null) ?? null;
  const ownReason = midiTrack.reason ?? channelReason;
  // A valid file whose model has no volume control: the strip says so, and the fader is off.
  const reason = ownReason === null && instrument !== null && control === null ? 'noVolume' : ownReason;
  // The other controls work for every reason but the ones that hide the instrument; a model with no volume still has them.
  const controlsOk = instrument !== null && (reason === null || reason === 'noVolume');
  const name = track.displayName ?? track.name;
  const sweeps = midiSweepsFor(midiTrack, sweepsRead);
  // A channel has one value per control: what all its tracks write, not only what this track writes.
  const written = channelControls(members);
  const others = members.filter((member) => member !== midiTrack).map((member) => member.name);
  const sharedText = others.length === 0 ? '' : fill(MIXER_COPY.midiShared, { names: others.join(', ') });
  const states = controlsOk ? midiControlStates(instrument, written, sweeps) : [];
  const tag = midiTag(midiTrack);
  const midi = {
    instrumentId: instrument === null ? null : instrument.id,
    port: midiTrack.spine.port,
    channel: midiTrack.spine.channel,
    sound: midiTrack.spine.sound,
    reason,
    reasonText: midiReasonText(reason),
    tag,
    tagText: tag?.text ?? '',
    sharedWith: others,
    sharedText,
    sharedTitle: sharedText,
    controls: states,
    chips: states.map((state) => midiChipFor(state, name)),
    writtenText: controlsText(written),
  };
  return {
    identity: track.identity,
    name,
    sounding: !track.muted,
    ...muteSoloModel(track),
    color: colorOf(track.identity),
    index: track.index,
    editable: read.ok,
    reason: read.ok ? null : read.reason,
    reasonText: read.ok ? null : reasonTextFor(read.reason),
    ...sharedRootFacts(read, canonicalPlay),
    midi,
    busHidden: false,
    playsMidi: false,
    fader: midiFaderModel(read, { reason, controls: written }, instrument, control, sweeps.unknown || sweeps.ccs.has(7) ? sweeps.faderText : null),
    chips: [],
    addList: [],
    effectReads: new Map(),
    orbit: null,
    busReads: null,
    ownSends: null,
  };
}

/**
 * The key each track's light listens for, `Map<identity, key | null>`: for a plain label, the key the note tag reports (the
 * label without its mute underscore and solo marker, the same for `hats` and a muted copy `hats_`, where the identity of the
 * second one gets a number to stay unique), `$` and the number of the statement for a `$` label (the n-th one in code order that a
 * leading or trailing underscore does not silence, counted from 0, as the tag counts them), null for a track without a label,
 * which Strudel never reports. A `$` statement an underscore silences never plays, so it keeps its identity, a key no note names.
 */
function lightKeysOf(tracks) {
  const keys = new Map();
  let dollars = 0;
  for (const track of tracks) {
    if (track.kind !== 'label') keys.set(track.identity, null);
    else if (!track.label.includes('$')) keys.set(track.identity, labelKey(track.label));
    else if (track.label.startsWith('_') || track.label.endsWith('_')) keys.set(track.identity, track.identity);
    else keys.set(track.identity, `$${dollars++}`);
  }
  return keys;
}

function buildModel({ code, parse, colorOf, bypassRecords = [], busMemory = new Map(), keepBus = null, rig = { setup: 'absent' }, song = { state: 'none' }, folds = new Set() }) {
  if (typeof code !== 'string' || code.trim() === '') return { status: 'empty', strips: [], buses: [], busMemory };
  let program;
  try {
    program = readProgram(code, { parse });
  } catch (error) {
    return { status: 'unreadable', strips: [], buses: [], busMemory, error };
  }
  if (program.tracks.length === 0) return { status: 'empty', strips: [], buses: [], busMemory };
  const staleRecords = [];
  // The song reading knows whether play() is the canonical helper (an unreadable song still says so); with no structure it is not.
  const canonicalPlay = (song.state === 'read' || song.state === 'unreadable') && song.helper === 'canonical';
  // One read of the MIDI tracks per render; code that does not parse reads as no MIDI strips (it is unreadable above anyway).
  const midiRead = readMidiTracks(code, { parse, rig });
  const midiTracks = midiRead.ok ? midiRead.tracks : new Map();
  const sweepsRead = midiRead.ok ? { sweeps: midiRead.sweeps, sweepsUnknown: midiRead.sweepsUnknown } : { sweeps: new Map(), sweepsUnknown: new Set() };
  // The channel mates come first: a folded track still belongs to its port and channel, so a kept strip names it.
  const mates = channelMates(midiTracks);
  const buildStrip = (track, read, midiTrack) => {
    // A track that sets its own orbit or bus values off its own chain hides its real bus: it gets no bus facts, so no bus strip counts it and its sends are off.
    const busHidden = read.ok && read.busHidden === true;
    // A browser track that plays MIDI has no MIDI strip: MIDI output never plays its effects or its sends, so none of them is offered and it feeds no bus.
    const playsMidi = read.ok && read.playsMidi === true;
    if (midiTrack !== undefined) return midiStrip(track, read, midiTrack, colorOf, sweepsRead, mates.get(track.identity) ?? [midiTrack], canonicalPlay);
    const own = read.ok ? bypassRecords.filter((record) => record.identity === track.identity) : [];
    // The code wins: a record whose effect is back in the code is stale and the caller drops it.
    const kept = [];
    for (const record of own) {
      if (read.effects.has(record.effect)) staleRecords.push({ identity: record.identity, effect: record.effect });
      else kept.push(record);
    }
    return {
      identity: track.identity,
      name: track.displayName ?? track.name,
      sounding: !track.muted,
      ...muteSoloModel(track),
      color: colorOf(track.identity),
      index: track.index,
      editable: read.ok,
      reason: read.ok ? null : read.reason,
      reasonText: read.ok ? (playsMidi ? MIXER_COPY.playsMidi : null) : reasonTextFor(read.reason),
      ...sharedRootFacts(read, canonicalPlay),
      midi: null,
      playsMidi,
      fader: faderModel(read),
      chips: read.ok ? chipsFor(read, kept, playsMidi) : [],
      addList: read.ok && !playsMidi ? addListFor(read, kept) : [],
      // The inspector reads these (inspectorModel): what the code says about each effect's parameters.
      effectReads: read.ok ? read.effects : new Map(),
      // The buses read these (busEntries): the orbit the track is on (null when it moves in the code) and its sends.
      orbit: read.ok && !busHidden && !playsMidi && read.bus.orbit.kind !== 'pattern' ? read.bus.orbit.value : null,
      busReads: read.ok && !busHidden && !playsMidi ? read.bus : null,
      // What the track's own chain writes for each send, kept when the bus facts are not (see sendRowsFor).
      ownSends: read.ok ? read.bus.sends : null,
      busHidden,
    };
  };
  const lightKeys = lightKeysOf(program.tracks);
  const noNotes = [];
  const strips = [];
  for (const track of program.tracks) {
    const read = program.reads.get(track.identity);
    const midiTrack = midiTracks.get(track.identity);
    if (midiTrack !== undefined && midiTrack.playsNotes === false) {
      noNotes.push({ identity: track.identity, name: track.displayName ?? track.name, tagText: midiTag(midiTrack)?.text ?? null, silent: track.muted });
      continue;
    }
    const strip = buildStrip(track, read, midiTrack);
    strip.lightKey = lightKeys.get(track.identity) ?? null;
    strips.push(strip);
  }
  const { buses, busMemory: nextMemory } = busEntries(strips, busMemory, keepBus);
  for (const strip of strips) strip.sends = sendRowsFor(strip, nextMemory);
  const list = noNotes
    .map((entry) => {
      const details = [entry.tagText, entry.silent ? MIXER_COPY.noNotesSilent : null].filter((part) => part !== null);
      return details.length === 0 ? entry.name : `${entry.name} (${details.join(', ')})`;
    })
    .join(', ');
  const noNotesText = noNotes.length === 0 ? null : fill(MIXER_COPY.noNotes, { list });
  const layout = groupLayout(mixerLayout({ reading: song, strips, folds }), strips);
  return { status: 'ready', strips, staleRecords, buses, busMemory: nextMemory, noNotes, noNotesText, layout };
}

/**
 * The layout of mixerLayout (null stays null) with the words each group frame shows: `text` and `title` (the name cut
 * to 40 code points, and the whole name), `label` (the frame's accessible name), `foldTitle` (the grid's words, the
 * name in single quotes), `count` and `countText` (the strips below the group at any depth), then what the head's mute
 * and solo buttons need (see groupControls): `mute` and `solo`, `countText` and `countTitle` (the plain count, or the
 * partial forms) and `noteText`.
 */
function groupLayout(layout, strips) {
  if (layout === null) return null;
  const stripsByIdentity = new Map(strips.map((strip) => [strip.identity, strip]));
  for (const group of layout.groups) {
    group.text = displayName(group.name);
    group.title = group.name;
    group.label = fill(MIXER_COPY.groupLabel, { group: displayName(group.name) });
    group.foldTitle = fill(group.open ? SONG_COPY.foldTitle : SONG_COPY.openTitle, { group: quoted(group.name) });
    group.count = group.members.length;
    group.countText = countText(group.count, SONG_COPY.trackOne, SONG_COPY.trackMany);
    Object.assign(group, groupControls(group, groupActions(group, stripsByIdentity)));
  }
  return layout;
}

/** `n` tracks as a sentence part: '1 track' or '3 tracks'. */
function tracksText(n) {
  return countText(n, SONG_COPY.trackOne, SONG_COPY.trackMany);
}

/**
 * The mute and solo of one group head, from groupActions: for each, `{ pressed, on, identities, disabled, name, title }`
 * (`pressed` true, false or 'mixed'; `on` what a click writes; `identities` the tracks it writes; `disabled` when no
 * track can be reached; `name` the accessible name and `title` the hover text), the group's `countText` and `countTitle`
 * (the plain count, or what is partly muted or soloed) and `noteText` (the group has no strip, else how many tracks
 * the buttons skip, else null).
 */
function groupControls(group, actions) {
  const who = displayName(group.name);
  const button = (kind, action) => {
    const mute = kind === 'mute';
    const mixed = action.pressed === 'mixed';
    const copy = mute
      ? { name: MIXER_COPY.groupMuteName, partial: MIXER_COPY.groupMuteNamePartial, off: MIXER_COPY.groupMuteTitle, all: MIXER_COPY.groupUnmuteTitle, some: MIXER_COPY.groupMutePartialTitle, none: MIXER_COPY.mute }
      : { name: MIXER_COPY.groupSoloName, partial: MIXER_COPY.groupSoloNamePartial, off: MIXER_COPY.groupSoloTitle, all: MIXER_COPY.groupEndSoloTitle, some: MIXER_COPY.groupSoloPartialTitle, none: MIXER_COPY.solo };
    const values = { group: who, k: action.k, n: action.n, tracks: tracksText(action.n) };
    let title = copy.none;
    if (mixed) title = fill(copy.some, values);
    else if (action.n > 0) title = fill(action.pressed === true ? copy.all : copy.off, values);
    return {
      pressed: action.pressed,
      on: action.on,
      identities: action.identities,
      disabled: action.n === 0,
      name: fill(mixed ? copy.partial : copy.name, values),
      title,
    };
  };
  const mute = button('mute', actions.mute);
  const solo = button('solo', actions.solo);
  const partMuted = mute.pressed === 'mixed';
  const partSolo = solo.pressed === 'mixed';
  let countLine = group.countText;
  if (partMuted && partSolo && actions.mute.n === actions.solo.n) {
    countLine = fill(MIXER_COPY.groupCountBoth, { k: actions.mute.k, n: actions.mute.n, j: actions.solo.k });
  } else if (partMuted || partSolo) {
    // The two buttons can reach different numbers of tracks (an unlabeled track mutes but cannot solo), so each part names its own.
    const parts = [];
    if (partMuted) parts.push(fill(MIXER_COPY.groupCountMuted, { k: actions.mute.k, n: actions.mute.n }));
    if (partSolo) parts.push(fill(MIXER_COPY.groupCountSolo, { k: actions.solo.k, n: actions.solo.n }));
    countLine = parts.join(', ');
  }
  let noteText = null;
  if (group.members.length === 0) noteText = MIXER_COPY.groupEmpty;
  else if (actions.skipped > 0) noteText = fill(actions.skipped === 1 ? MIXER_COPY.groupSkipOne : MIXER_COPY.groupSkipMany, { n: actions.skipped });
  return { mute, solo, countText: countLine, countTitle: countLine, noteText };
}

// --- The inspector: one effect's parameters ---

/** The range a written parameter is shown and edited in: the Hz range for a `.tremolo()` speed. */
function rangeFor(param, paramRead) {
  const source = param.alt && paramRead.method === param.alt.method ? param.alt : param;
  return { min: source.min, max: source.max, step: source.step, scale: source.step === null ? 'log' : 'linear', unit: source.unit };
}

/** The slider facts of a number row: a log slider spans 0..PARAM_STEPS, a linear one its own range. */
function sliderFor(range, value) {
  if (range.scale === 'log') return { min: 0, max: PARAM_STEPS, step: 1, value: valueToPosition(range, value) };
  return { min: range.min, max: range.max, step: range.step, value };
}

/**
 * One inspector row for `param`, from its read `{ kind, value, method }`: `{ effect, param, name,
 * basic, primary, kind: 'number' | 'select' | 'moving', value, defaultShown, subText,
 * showDefaultButton, unit, min, max, step, scale, slider, options, fixedValue, readOnly }`; the cutoff of a
 * filter also has `mode` ('fixed', or 'moves' with kind 'move', `move` and the `shapes` of MOVE_SHAPES). An
 * unwritten parameter shows its Strudel default (its starting value when Strudel has none) and
 * `default` on its second line; a written one that is not the effect's first offers Default.
 */
function rowFor(effect, index, paramRead, readOnly) {
  const param = effect.params[index];
  const range = rangeFor(param, paramRead.kind === 'fixed' ? paramRead : { method: param.method });
  const base = {
    effect: effect.id,
    param: param.id,
    name: param.name,
    basic: param.basic,
    primary: index === 0,
    readOnly,
    unit: range.unit,
    min: range.min,
    max: range.max,
    step: range.step,
    scale: range.scale,
    options: param.kind === 'select' ? param.options : null,
    fixedValue: fixedValueOf(param, param.alt !== undefined && paramRead.method === param.alt.method),
  };
  if (paramRead.kind === 'move') {
    // A filter move Claude wrote (or the mixer did): the Moves side of the Fixed / Moves switch.
    return { ...base, kind: 'move', mode: 'moves', move: paramRead.move, shapes: MOVE_SHAPES, value: null, defaultShown: false, subText: range.unit, showDefaultButton: false, slider: null };
  }
  if (paramRead.kind === 'pattern') {
    return { ...base, kind: 'moving', value: null, defaultShown: false, subText: range.unit, showDefaultButton: false, slider: null };
  }
  // A movable cutoff that holds a fixed value (or none) is the Fixed side of the switch.
  const mode = param.movable === true ? { mode: 'fixed' } : {};
  if (paramRead.kind === 'unwritten') {
    const value = param.kind === 'select' ? '' : (param.strudelDefault ?? param.start);
    return {
      ...base,
      ...mode,
      kind: param.kind,
      value,
      defaultShown: true,
      subText: MIXER_COPY.paramDefault,
      showDefaultButton: false,
      slider: param.kind === 'select' ? null : sliderFor(range, value),
    };
  }
  return {
    ...base,
    ...mode,
    kind: param.kind,
    value: paramRead.value,
    defaultShown: false,
    subText: range.unit,
    showDefaultButton: index !== 0,
    slider: param.kind === 'select' ? null : sliderFor(range, paramRead.value),
  };
}

/** The parameter reads a bypass record's stored calls stand for (the effect is off, so read-only). */
function storedReads(effect, calls) {
  const reads = {};
  for (const param of effect.params) reads[param.id] = { kind: 'unwritten', value: null, method: null };
  for (const call of calls) {
    if (effect.id === 'compressor') {
      call.fields.forEach((value, i) => {
        reads[effect.params[i].id] = { kind: 'fixed', value, method: 'compressor' };
      });
      continue;
    }
    const param = effect.params.find((candidate) => candidate.method === call.method || (candidate.alt && candidate.alt.method === call.method));
    if (param && call.move) reads[param.id] = { kind: 'move', value: null, method: call.method, move: call.move };
    else if (param) reads[param.id] = { kind: 'fixed', value: call.value, method: call.method };
  }
  return reads;
}

/** One inspector row of a bus parameter, shaped like an effect row (page/mixer-view.js updateRow reads
 * it) with `bus`, `orbit`, `costly` and `mixed` besides. A parameter that moves in the code on a sender
 * is a read-only `moving` row; when the senders disagree the number field is empty and the sub line says `mixed`. */
function busRowFor(entry, state) {
  const { param } = state;
  const range = { min: param.min, max: param.max, step: param.step, scale: param.scale, unit: param.unit };
  const base = {
    bus: entry.bus,
    orbit: entry.orbit,
    param: param.id,
    name: param.name,
    basic: param.basic,
    costly: param.costly,
    primary: false,
    readOnly: !entry.editable,
    unit: param.unit,
    min: param.min,
    max: param.max,
    step: param.step,
    scale: range.scale,
    options: null,
    fixedValue: param.start ?? param.strudelDefault,
    showDefaultButton: false,
    mixed: state.state === 'mixed',
  };
  if (state.state === 'moving') {
    return { ...base, kind: 'moving', value: null, defaultShown: false, subText: param.unit, slider: null };
  }
  const value = state.state === 'value' ? state.value : state.state === 'default' ? param.strudelDefault : null;
  let subText = param.unit;
  if (state.state === 'default') subText = MIXER_COPY.paramDefault;
  else if (state.state === 'mixed') subText = MIXER_COPY.mixed;
  return { ...base, kind: 'number', value, defaultShown: state.state === 'default', subText, slider: sliderFor(range, value ?? param.start) };
}

/** The inspector of a bus (`selection` is `{ bus, orbit }`): `{ kind: 'bus', bus, orbit, title, rows,
 * moreCount, note, gone, editable, alignValues, disagree, ... }`. `gone` is true when the bus is not in
 * the model (no track sends to it and it is not the one kept open). `alignValues` are the values a hand
 * change aligns every other disagreeing parameter to (see busParamStates). */
function busInspectorModel(model, selection) {
  if (!Object.hasOwn(BUSES, selection.bus)) throw new Error(`Moontide: unknown bus '${String(selection.bus)}'.`);
  const result = {
    kind: 'bus',
    identity: null,
    effect: null,
    bus: selection.bus,
    orbit: selection.orbit,
    title: '',
    trackName: '',
    rows: [],
    moreCount: 0,
    note: '',
    writtenText: '',
    bypassed: false,
    gone: true,
    editable: false,
    alignValues: {},
    disagree: [],
  };
  const entry = model.buses.find((candidate) => candidate.bus === selection.bus && candidate.orbit === selection.orbit);
  if (!entry) return result;
  const rows = entry.states.map((state) => busRowFor(entry, state));
  const ordered = [...rows.filter((row) => row.basic), ...rows.filter((row) => !row.basic)];
  return {
    ...result,
    title: entry.title,
    rows: ordered,
    moreCount: ordered.filter((row) => !row.basic).length,
    note: selection.bus === 'reverb' ? MIXER_COPY.reverbCostly : MIXER_COPY.delayNote,
    gone: false,
    editable: entry.editable,
    alignValues: entry.alignValues,
    disagree: entry.disagreeIds,
  };
}

/** One inspector row of a control of a MIDI track: `{ control, name, cc, min, max, default, value, written, moving,
 * sweepText, subText, showDefaultButton, defaultTitle, slider }`. An unwritten control shows `default {value}` under
 * its name; a written one offers Default (a way back to the instrument's own value, removed from the code). */
function midiRowFor(state) {
  return {
    control: state.id,
    name: state.name,
    cc: state.cc,
    min: state.min,
    max: state.max,
    default: state.default,
    value: state.value,
    written: state.written,
    moving: state.moving,
    sweepText: state.sweepText,
    // A control a sweep moves has no slider, no Default and no sub line: the sweep sentence stands in their place.
    subText: state.moving || state.written ? null : fill(MIXER_COPY.midiRowDefault, { value: state.default }),
    showDefaultButton: state.written && !state.moving,
    defaultTitle: fill(MIXER_COPY.midiDefaultTitle, { value: state.default }),
    slider: state.moving ? null : { min: state.min, max: state.max, step: 1, value: state.value },
  };
}

/**
 * The inspector of the controls of a MIDI track (`selection` is `{ identity, midi: true, control }`): `{ kind: 'midi',
 * identity, control, title, trackName, instrumentLine, tagText, sharedText, instrumentId, port, channel, rows, writtenText,
 * nothingWritten, footer, gone, goneText, reasonText, editable }`. `gone` is true when the strip is missing or is not a
 * MIDI strip (then there are no rows); `reasonText` is the strip's sentence, with no rows, while its controls are off.
 */
function midiInspectorModel(model, selection) {
  const result = {
    kind: 'midi',
    identity: selection.identity,
    control: selection.control,
    title: '',
    trackName: '',
    instrumentLine: '',
    tagText: '',
    sharedText: '',
    instrumentId: null,
    port: null,
    channel: null,
    rows: [],
    writtenText: '',
    nothingWritten: false,
    footer: MIXER_COPY.midiFooter,
    gone: true,
    goneText: MIXER_COPY.midiGone,
    reasonText: null,
    editable: false,
  };
  const strip = model.strips.find((candidate) => candidate.identity === selection.identity);
  if (!strip || strip.midi === null) return result;
  const { midi } = strip;
  const withSound = midi.sound === null || midi.tagText === '' ? midi.tagText : `${midi.tagText} \u00b7 ${midi.sound}`;
  const shared = {
    ...result,
    title: fill(MIXER_COPY.midiInspectorTitle, { track: strip.name }),
    trackName: strip.name,
    instrumentLine: withSound,
    tagText: midi.tagText,
    sharedText: midi.sharedWith.length === 0 ? '' : fill(MIXER_COPY.midiInspectorShared, { n: midi.channel, names: midi.sharedWith.join(', ') }),
    instrumentId: midi.instrumentId,
    port: midi.port,
    channel: midi.channel,
    gone: false,
    editable: strip.editable,
  };
  if (midi.reason !== null && midi.reason !== 'noVolume') return { ...shared, reasonText: midi.reasonText };
  return {
    ...shared,
    rows: midi.controls.map(midiRowFor),
    writtenText: midi.writtenText,
    nothingWritten: midi.writtenText === '',
  };
}

/**
 * The inspector for `selection` (`{ identity, effect }` for an effect, `{ identity, midi: true, control }` for the controls of a
 * MIDI track, `{ bus, orbit }` for a bus, or null) over a built `model`, or null when
 * nothing is selected or the model is not ready: `{ kind: 'effect', identity, effect, title, trackName, rows,
 * moreCount, writtenText, bypassed, gone, editable }`. `rows` list the basic parameters first, then
 * the rest (`moreCount` of them); `gone` is true when the effect is neither in the code nor kept
 * bypassed, and then there are no rows. A bypassed effect shows its stored values read-only.
 */
export function inspectorModel({ model, selection }) {
  if (!selection || !model || model.status !== 'ready') return null;
  if (selection.bus !== undefined) return busInspectorModel(model, selection);
  if (selection.midi === true) return midiInspectorModel(model, selection);
  const effect = effectById(selection.effect);
  const strip = model.strips.find((candidate) => candidate.identity === selection.identity);
  const chip = strip ? strip.chips.find((candidate) => candidate.effect === effect.id) : undefined;
  const result = { kind: 'effect', identity: selection.identity, effect: effect.id, title: effect.name, trackName: '', rows: [], moreCount: 0, writtenText: '', bypassed: false, gone: true, editable: false };
  if (!strip || !chip) return result;
  const bypassed = chip.bypassed;
  const reads = bypassed ? storedReads(effect, chip.calls) : strip.effectReads.get(effect.id).params;
  const rows = effect.params.map((param, index) => rowFor(effect, index, reads[param.id], bypassed));
  const ordered = [...rows.filter((row) => row.basic), ...rows.filter((row) => !row.basic)];
  return {
    ...result,
    title: `${effect.name} · ${strip.name}`,
    trackName: strip.name,
    rows: ordered,
    moreCount: ordered.filter((row) => !row.basic).length,
    writtenText: bypassed ? '' : strip.effectReads.get(effect.id).written,
    bypassed,
    gone: false,
    editable: strip.editable && !bypassed && strip.playsMidi !== true,
  };
}
