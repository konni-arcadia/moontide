// The lights of the Mixer: the state behind the small dot on every track strip and every group.
//
// Pure: no DOM, and the clocks are handed in, so node:test drives it with fake time. The page tells it which tracks
// the Mixer shows (setLayout), which notes were played (noteSeen) and, once per animation frame, asks which lights
// changed (frame). It never draws: the Mixer view writes what frame returns.
//
// What a light shows. With motion on, a light goes to full in the first frame at or after the moment its note is
// heard and falls in a straight line to nothing over LIGHT_FADE_MS; a note that comes while it fades starts it over.
// With motion off nothing blinks: a light stays lit while a note was heard within the last cycle. A group's light
// shows the brightest of the tracks below it, at any depth, folded or not.
//
// Why a note is kept as a time to convert, not as a converted time. A browser sound is due at a time on the audio
// clock; it is heard later, after the output delay, and the page maps one to the other from the audio context's
// output timestamp. That timestamp is read once per frame (not once per note: at 40 tracks that would be hundreds of
// reads a second), so the note waits here as its audio time and `toPerf` turns it into the page clock when a frame runs.
// A MIDI note already has the time its port got and needs no conversion.
//
// Why frame returns only what changed: the page writes to the document only for those lights, in steps of 1/64 of
// the brightness, so a fading light does not rewrite the same value and 40 tracks stay far under a frame's budget.
//
// The two offsets start at 0 and the fade at 180 ms. They are meant to be tuned by ear on real hardware.

import { FRESH_PAIR_MAX_AGE_MS } from './midi-clock.js';

/** How long a light takes to fall from full to dark, with motion on. */
export const LIGHT_FADE_MS = 180;
/** Added to the moment a browser sound is heard (positive: later). */
export const BROWSER_LIGHT_OFFSET_MS = 0;
/** Added to the timestamp a MIDI note got (positive: later). */
export const MIDI_LIGHT_OFFSET_MS = 0;
/** A light's brightness is rounded to this many steps from dark to full. */
export const LIGHT_STEPS = 64;
/** The most notes a track keeps waiting; the oldest goes first. */
export const MAX_PENDING_NOTES = 256;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Maps the audio time a note is due to the moment it is heard, on the page clock (performance.now()).
 * `pair` is the audio context's output timestamp `{ contextTime, performanceTime }`; while it is fresh the mapping goes
 * through it. Otherwise (right after the context starts, or while it is suspended) the time is shifted by the context's
 * own latencies, a missing latency counting as 0.
 */
export function heardMapper({ pair, currentTime, baseLatency, outputLatency, perfNow }) {
  if (!isFiniteNumber(perfNow)) {
    throw new Error(`Moontide: the lights need the page clock as a number, got ${String(perfNow)}.`);
  }
  const fresh =
    pair !== null &&
    typeof pair === 'object' &&
    isFiniteNumber(pair.contextTime) &&
    isFiniteNumber(pair.performanceTime) &&
    pair.contextTime > 0 &&
    pair.performanceTime > 0 &&
    perfNow - pair.performanceTime < FRESH_PAIR_MAX_AGE_MS;
  if (fresh) {
    return (target) => pair.performanceTime + (target - pair.contextTime) * 1000 + BROWSER_LIGHT_OFFSET_MS;
  }
  if (!isFiniteNumber(currentTime)) {
    throw new Error(`Moontide: the lights need the audio clock as a number, got ${String(currentTime)}.`);
  }
  const latencyMs = ((isFiniteNumber(baseLatency) ? baseLatency : 0) + (isFiniteNumber(outputLatency) ? outputLatency : 0)) * 1000;
  return (target) => perfNow + (target - currentTime) * 1000 + latencyMs + BROWSER_LIGHT_OFFSET_MS;
}

/** Whether `cps` can drive the lights: a number above 0. A piece can set the tempo to 0 and set it back later. */
export function usableTempo(cps) {
  return isFiniteNumber(cps) && cps > 0;
}

/**
 * The audio context's output timestamp for `heardMapper`, or null when this browser has no such method; the mapper then
 * shifts a time by the context's own latencies, as it does while the pair is stale.
 */
export function readOutputPair(audio) {
  return typeof audio.getOutputTimestamp === 'function' ? audio.getOutputTimestamp() : null;
}

/**
 * What the lights need to know about a Mixer model: `{ tracks, ancestors }`. `tracks` has one entry
 * `{ key, id, sounding }` for every strip that has a light key (`key` is what a note names, `id` the strip's identity,
 * which the view finds the light by). A strip that plays MIDI cannot sound in a browser without Web MIDI, so it counts as
 * not sounding there. `ancestors` maps a strip's id to the keys of the groups above it, outermost first. A model that
 * is not ready gives an empty layout.
 */
export function lightLayout(model, { webMidi }) {
  const tracks = [];
  const ancestors = new Map();
  if (model === null || typeof model !== 'object' || model.status !== 'ready') return { tracks, ancestors };
  for (const strip of model.strips) {
    if (strip.lightKey === null || strip.lightKey === undefined) continue;
    const playsMidi = (strip.midi !== null && strip.midi !== undefined) || strip.playsMidi === true;
    tracks.push({ key: strip.lightKey, id: strip.identity, sounding: strip.sounding === true && (webMidi === true || !playsMidi) });
  }
  if (model.layout !== null && model.layout !== undefined) {
    for (const group of model.layout.groups) {
      for (const id of group.members) {
        const above = ancestors.get(id);
        if (above === undefined) ancestors.set(id, [group.key]);
        else above.push(group.key);
      }
    }
  }
  return { tracks, ancestors };
}

/**
 * The light state. `setLayout(layout)` says which tracks and groups exist (see lightLayout); `noteSeen(key, heard)` queues
 * a note, `heard` being `{ at }` (a time on the page clock, in ms) or `{ target }` (an audio time, in seconds);
 * `frame(ts, { motion, cps, toPerf })` lights what is due at `ts` and returns `[{ kind, id, value }]` for the lights whose
 * value changed since the last frame; `reset()` forgets every note and every lit light.
 */
export function createLights() {
  // key -> { id, sounding }
  let tracks = new Map();
  // strip id -> keys of the groups above it
  let ancestors = new Map();
  // key -> the notes waiting to be heard, each { at } or { target }
  const pending = new Map();
  const pendingKeys = new Set();
  // key -> { litAt, lastHeard }: when a track last lit in a frame, and the latest heard time among its notes
  const states = new Map();
  // The keys whose light may be lit now: the only ones a frame looks at.
  const active = new Set();
  // What the last frame returned that is not dark: key -> { id, value } for tracks, group key -> value for groups.
  const shownTracks = new Map();
  const shownGroups = new Map();
  // Scratch maps of one frame, kept to write nothing new on the common path.
  const trackValues = new Map();
  const groupValues = new Map();

  function forget(key) {
    pending.delete(key);
    pendingKeys.delete(key);
    states.delete(key);
    active.delete(key);
  }

  return {
    setLayout(layout) {
      if (layout === null || typeof layout !== 'object' || !Array.isArray(layout.tracks) || !(layout.ancestors instanceof Map)) {
        throw new Error('Moontide: the lights need a layout of tracks and ancestors.');
      }
      const next = new Map();
      // Strips can share a key (a muted copy `hats_` kept next to `hats`): the one that sounds owns the key, so the
      // copy stays dark and the audible track blinks.
      for (const track of layout.tracks) {
        const known = next.get(track.key);
        if (known !== undefined && known.sounding) continue;
        next.set(track.key, { id: track.id, sounding: track.sounding === true });
      }
      tracks = next;
      ancestors = layout.ancestors;
      // A track that is gone or silent drops its notes and reads dark from the next frame on.
      for (const key of [...pending.keys(), ...states.keys()]) {
        const track = tracks.get(key);
        if (track === undefined || !track.sounding) forget(key);
      }
    },

    noteSeen(key, heard) {
      const hasAt = heard !== null && typeof heard === 'object' && isFiniteNumber(heard.at);
      const hasTarget = heard !== null && typeof heard === 'object' && isFiniteNumber(heard.target);
      if (!hasAt && !hasTarget) {
        throw new Error('Moontide: a note for the lights needs a heard time (at) or an audio time (target) that is a number.');
      }
      const track = tracks.get(key);
      if (track === undefined || !track.sounding) return;
      let queue = pending.get(key);
      if (queue === undefined) {
        queue = [];
        pending.set(key, queue);
      }
      queue.push(hasAt ? { at: heard.at } : { target: heard.target });
      if (queue.length > MAX_PENDING_NOTES) queue.shift();
      pendingKeys.add(key);
    },

    frame(ts, { motion, cps, toPerf } = {}) {
      if (!isFiniteNumber(ts)) throw new Error(`Moontide: a light frame needs a time that is a number, got ${String(ts)}.`);
      if (motion !== 'on' && motion !== 'off') throw new Error(`Moontide: a light frame needs motion 'on' or 'off', got ${String(motion)}.`);
      if (!isFiniteNumber(cps) || cps <= 0) throw new Error(`Moontide: a light frame needs a tempo above 0, got ${String(cps)}.`);
      if (typeof toPerf !== 'function') throw new Error('Moontide: a light frame needs toPerf, the function that turns an audio time into the page clock.');

      // Notes heard by now light their track in this frame. The whole queue is read: a note that arrives out of order must
      // not wait behind one that is heard later.
      for (const key of pendingKeys) {
        const queue = pending.get(key);
        let latest = -Infinity;
        let kept = 0;
        for (let i = 0; i < queue.length; i++) {
          const note = queue[i];
          const heard = note.at !== undefined ? note.at : toPerf(note.target);
          if (!isFiniteNumber(heard)) throw new Error(`Moontide: toPerf gave ${String(heard)} for an audio time, not a number.`);
          if (heard <= ts) {
            if (heard > latest) latest = heard;
          } else {
            queue[kept++] = note;
          }
        }
        queue.length = kept;
        if (kept === 0) pendingKeys.delete(key);
        if (latest === -Infinity) continue;
        let state = states.get(key);
        if (state === undefined) {
          state = { litAt: ts, lastHeard: latest };
          states.set(key, state);
        } else {
          state.litAt = ts;
          if (latest > state.lastHeard) state.lastHeard = latest;
        }
        active.add(key);
      }

      // The value of every light that may be lit; a track whose value reached 0 leaves the active set.
      trackValues.clear();
      groupValues.clear();
      const cycleMs = 1000 / cps;
      for (const key of active) {
        const state = states.get(key);
        const track = tracks.get(key);
        let value = 0;
        if (state !== undefined && track !== undefined && track.sounding) {
          if (motion === 'on') {
            value = Math.round(Math.min(1, Math.max(0, 1 - (ts - state.litAt) / LIGHT_FADE_MS)) * LIGHT_STEPS) / LIGHT_STEPS;
          } else {
            value = ts - state.lastHeard <= cycleMs ? 1 : 0;
          }
        }
        if (value <= 0) {
          active.delete(key);
          continue;
        }
        trackValues.set(key, value);
        const above = ancestors.get(track.id);
        if (above === undefined) continue;
        for (const group of above) {
          if (value > (groupValues.get(group) ?? 0)) groupValues.set(group, value);
        }
      }

      const changes = [];
      for (const [key, value] of trackValues) {
        const shown = shownTracks.get(key);
        if (shown !== undefined && shown.value === value) continue;
        const id = tracks.get(key).id;
        if (shown === undefined) shownTracks.set(key, { id, value });
        else shown.value = value;
        changes.push({ kind: 'track', id, value });
      }
      for (const [key, shown] of shownTracks) {
        if (trackValues.has(key)) continue;
        shownTracks.delete(key);
        changes.push({ kind: 'track', id: shown.id, value: 0 });
      }
      for (const [group, value] of groupValues) {
        if (shownGroups.get(group) === value) continue;
        shownGroups.set(group, value);
        changes.push({ kind: 'group', id: group, value });
      }
      for (const group of shownGroups.keys()) {
        if (groupValues.has(group)) continue;
        shownGroups.delete(group);
        changes.push({ kind: 'group', id: group, value: 0 });
      }
      return changes;
    },

    reset() {
      pending.clear();
      pendingKeys.clear();
      states.clear();
      active.clear();
      shownTracks.clear();
      shownGroups.clear();
    },
  };
}
