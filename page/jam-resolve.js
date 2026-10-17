// Pure module for Moontide's browser page: decides which scale the Jam view uses when the heard notes fit several of
// the nine. Several scales can hold the very same notes (C major, A minor and G Mixolydian are one set of seven notes),
// and the view should help instead of switching its warnings off: it uses one of them, says why, and every path that
// needs a clear scale (the piano and the guitar, the degree chips, the status, the coming-up rows, the notes and warnings
// a right-click asks about) reads that one scale, resolved here. The warnings of every candidate were computed with the
// reading (page/jam-analysis.js buildReading, `proposals`), so choosing among them is a lookup and never a new reading.
//
// The scale in use follows one fixed order, the first rule that applies:
//   1. the user's pick, held for this exact set of candidates (source 'chosen');
//   2. the declared scale of the playing section, or of the piece without sections, when it is among the candidates;
//   3. the kept proposal, the one last chosen from the evidence for this same set, so near-equal readings do not make the
//      proposal flicker (it applies to scales that share their notes only, and never over a declaration);
//   4. the strongest evidence of the notes.
// The kept proposal steadies only choices made from the evidence: a section that declares another scale among the same
// candidates moves the proposal, because the declaration is what the code states. Picks and the kept proposal are held
// per set of candidates in a small page memory (createScaleMemory) that holds no reading and no DOM; both are capped, and
// gone when the page reloads. No DOM access at import time, so this module can be imported directly by node:test and by
// page/main.js without a build step.

import { MODES, scalePcs, clearScale } from './jam-analysis.js';

/** Two evidence values closer than this are the same evidence. */
const EVIDENCE_TOLERANCE = 1e-9;

/** The reasons a proposal can give, in the words of the reason codes: what decided between the candidates. */
export const REASONS = Object.freeze(['declared', 'bass-chords', 'most-heard', 'nothing']);

/** Why a scale cannot be chosen: no declaration to break the tie, or a declared scale that is none of the candidates. */
export const UNRESOLVED_REASONS = Object.freeze(['nothing-declared', 'declared-not-among']);

function candidateKeyOf(candidate) {
  if (candidate === null || typeof candidate !== 'object' || typeof candidate.key !== 'string') {
    throw new Error(`Moontide: a candidate scale needs its key, got ${JSON.stringify(candidate)}`);
  }
  return candidate.key;
}

/**
 * The key of a set of candidates: their keys (page/jam-analysis.js candidateKey) sorted as strings and joined by
 * commas, so the same candidates in another order share one key.
 */
export function candidateSetKey(candidates) {
  return candidates.map(candidateKeyOf).sort().join(',');
}

/** How many sets of candidates the page remembers a pick for, and a kept proposal for; the oldest is dropped first. */
export const MAX_REMEMBERED_SETS = 32;

const pcsKey = (candidate) => [...scalePcs(candidate.root, candidate.mode)].sort((a, b) => a - b).join(',');

/** True when every candidate holds the same seven pitch classes as the first one. */
export function sameNotes(candidates) {
  if (candidates.length === 0) throw new Error('Moontide: no candidate scales to compare');
  const first = pcsKey(candidates[0]);
  return candidates.every((candidate) => pcsKey(candidate) === first);
}

/**
 * Which evidence put `chosen` ahead of the other `candidates`: 'bass-chords' when the bass and the chord roots lean on
 * its root more than on every other candidate's, else 'most-heard' when the weight of its root among the notes exceeds
 * every other's, else 'nothing' (the evidence does not tell them apart). The evidence is the one the detection scored
 * (`lean` and `heard` of each candidate); nothing new is added.
 */
export function evidenceReason(chosen, candidates) {
  const others = candidates.filter((candidate) => candidateKeyOf(candidate) !== candidateKeyOf(chosen));
  if (others.length === 0) return 'nothing';
  if (others.every((other) => chosen.lean - other.lean > EVIDENCE_TOLERANCE)) return 'bass-chords';
  if (others.every((other) => chosen.heard - other.heard > EVIDENCE_TOLERANCE)) return 'most-heard';
  return 'nothing';
}

function declaredScaleOf(declared) {
  if (declared === null || typeof declared !== 'object') {
    throw new Error(`Moontide: resolving a scale needs the declared harmony, got ${String(declared)}`);
  }
  if (declared.state !== 'declared' || declared.scale === null || declared.scale === undefined) return null;
  const { rootPc, modeId } = declared.scale;
  if (!Number.isInteger(rootPc) || rootPc < 0 || rootPc > 11) {
    throw new Error(`Moontide: a declared scale needs a root pitch class from 0 to 11, got ${String(rootPc)}`);
  }
  if (!MODES.some((mode) => mode.id === modeId)) {
    throw new Error(`Moontide: no scale called '${String(modeId)}' among the nine the Jam view knows`);
  }
  return declared.scale;
}

function inputsOf(inputs) {
  if (inputs === null || typeof inputs !== 'object' || !('declared' in inputs)) {
    throw new Error('Moontide: resolving a scale needs its inputs, { declared } (the declared harmony of the playing section).');
  }
  return inputs;
}

const nonEmptyString = (value) => typeof value === 'string' && value !== '';

function needString(value, what) {
  if (!nonEmptyString(value)) throw new Error(`Moontide: the scale memory needs ${what} as a non-empty string, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * The page's memory of the user's choices, `{ pick, pickFor, keep, keptFor, size }`; it holds keys only, never a reading and
 * never a DOM node, and it lives in a variable of the page, so a reload forgets it.
 * - `pick(setKey, key)` remembers that the user chose the candidate `key` while the set of candidates was `setKey`;
 *   `pickFor(setKey)` gives it back, or null. Picks are kept in recency order and at most `cap` sets are remembered (the
 *   oldest dropped first; picking an old set again makes it the newest), so a long session cannot grow the memory.
 * - `keep(setKey, key)` records a proposal in view that came from the evidence for the set of candidates `setKey`;
 *   `keptFor(setKey)` gives its key, or null. Kept proposals are held per set like picks, in recency order and at most
 *   `cap` sets (the oldest dropped first), so going back to an earlier ambiguous span finds the proposal it had. A kept
 *   proposal is not a pick and does not count in `size()`.
 * A missing or empty argument throws a Moontide error.
 */
export function createScaleMemory({ cap = MAX_REMEMBERED_SETS } = {}) {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`Moontide: the scale memory needs a cap of at least 1, got ${String(cap)}`);
  const picks = new Map();
  const kept = new Map();
  return {
    pick(setKey, key) {
      needString(setKey, 'a set key');
      needString(key, 'a scale key');
      picks.delete(setKey);
      picks.set(setKey, key);
      while (picks.size > cap) picks.delete(picks.keys().next().value);
    },
    pickFor(setKey) {
      needString(setKey, 'a set key');
      return picks.get(setKey) ?? null;
    },
    keep(setKey, key) {
      needString(setKey, 'a set key');
      needString(key, 'a scale key');
      kept.delete(setKey);
      kept.set(setKey, key);
      while (kept.size > cap) kept.delete(kept.keys().next().value);
    },
    keptFor(setKey) {
      needString(setKey, 'a set key');
      return kept.get(setKey) ?? null;
    },
    size: () => picks.size,
  };
}

const HEARD = Object.freeze({ source: 'heard', key: null, reason: null, setKey: null, sameNotes: null, why: null });

// A key held in memory must be one of the candidates it was looked up for (by the set key); anything else is a caller bug.
function candidateOf(candidates, key, what) {
  const hit = candidates.find((candidate) => candidate.key === key);
  if (hit === undefined) throw new Error(`Moontide: the ${what} '${key}' is not one of the scales that fit now`);
  return hit;
}

/**
 * Which scale a detected `scale` stands for, as `{ source, key, reason, setKey, sameNotes, why }`. A clear, no-fit or
 * none scale is the heard one (source 'heard', nothing else set). For an ambiguous scale `inputs` is `{ declared, pick,
 * kept }`: `declared` is the harmony the code declares for what plays now (page/harmony.js: a declared scale is
 * `{ rootPc, modeId }` or null), `pick` the key the user chose for this set of candidates (or null) and `kept` the key of
 * the proposal in view that came from the evidence for this set (or null). The first rule that applies wins:
 * - source 'chosen' (reason null): the user's `pick`, also when the candidates have different notes;
 * - source 'proposed', reason 'declared': the declared scale is one of the candidates, matched on its root and mode (never
 *   on its name text), also when the candidates have different notes;
 * - source 'proposed': the candidates share their notes and `kept` is one of them, with the reason evidenceReason gives
 *   for it; a kept key is never used for candidates with different notes;
 * - source 'proposed': the candidates share their notes, so the first one (the detection puts the best evidence first) is
 *   used, with the reason evidenceReason gives;
 * - source 'unresolved': the candidates have different notes and nothing above names one of them; `why` is
 *   'declared-not-among' when a declared scale exists and is none of the candidates, else 'nothing-declared' (no
 *   declaration, a chords declaration, an unreadable one).
 * `key` is the scale in use, `setKey` the key of the set of candidates (a memory of a choice hangs on it). A `pick` or
 * `kept` that is not one of the candidates throws, as anything else a Moontide error can name.
 */
export function resolveScale(scale, inputs) {
  if (scale === null || typeof scale !== 'object') throw new Error(`Moontide: cannot resolve ${String(scale)} as a scale`);
  if (scale.status === 'clear' || scale.status === 'no-fit' || scale.status === 'none') return HEARD;
  if (scale.status !== 'ambiguous') throw new Error(`Moontide: cannot resolve a scale reading with status '${String(scale.status)}'`);
  const { declared, pick = null, kept = null } = inputsOf(inputs);
  const declaredScale = declaredScaleOf(declared);
  const { candidates } = scale;
  const setKey = candidateSetKey(candidates);
  const same = sameNotes(candidates);
  if (pick !== null) candidateOf(candidates, pick, 'picked scale');
  const keptCandidate = kept === null ? null : candidateOf(candidates, kept, 'kept scale');
  if (pick !== null) return { source: 'chosen', key: pick, reason: null, setKey, sameNotes: same, why: null };
  if (declaredScale !== null) {
    const hit = candidates.find((candidate) => candidate.root === declaredScale.rootPc && candidate.mode.id === declaredScale.modeId);
    if (hit !== undefined) return { source: 'proposed', key: hit.key, reason: 'declared', setKey, sameNotes: same, why: null };
  }
  if (same) {
    const used = keptCandidate ?? candidates[0];
    return { source: 'proposed', key: used.key, reason: evidenceReason(used, candidates), setKey, sameNotes: true, why: null };
  }
  return { source: 'unresolved', key: null, reason: null, setKey, sameNotes: false, why: declaredScale === null ? 'nothing-declared' : 'declared-not-among' };
}

// The names of a list of candidates, in the order the detection gave them (the best evidence first).
const namesOf = (candidates) => candidates.map((candidate) => ({ key: candidate.key, name: candidate.name }));

// A scale of the reading as the resolution says: the scale in use (proposed or chosen) as a clear scale with the fields the
// model reads, the ambiguous scale with why it cannot be chosen, or the heard scale itself.
function resolvedScale(scale, resolution) {
  if (resolution.source === 'heard') return scale;
  const { setKey, sameNotes: same } = resolution;
  const candidates = namesOf(scale.candidates);
  if (resolution.source === 'unresolved') {
    return { ...scale, source: 'unresolved', why: resolution.why, setKey, sameNotes: same, candidates };
  }
  const hit = scale.candidates.find((candidate) => candidate.key === resolution.key);
  return { ...clearScale(hit.root, hit.mode, hit.coverage), source: resolution.source, reason: resolution.reason, key: resolution.key, setKey, sameNotes: same, candidates };
}

function memoryOf(inputs) {
  const { memory } = inputs;
  if (memory === null || typeof memory !== 'object' || typeof memory.pickFor !== 'function' || typeof memory.keptFor !== 'function') {
    throw new Error('Moontide: resolving a reading needs the scale memory, { declared, memory } (page/jam-resolve.js createScaleMemory).');
  }
  return memory;
}

// What a span's scale resolves to, with the pick and the kept proposal the memory holds for its set of candidates.
function resolveWithMemory(scale, { declared }, memory) {
  if (scale.status !== 'ambiguous') return resolveScale(scale, { declared });
  const setKey = candidateSetKey(scale.candidates);
  return resolveScale(scale, { declared, pick: memory.pickFor(setKey), kept: memory.keptFor(setKey) });
}

/**
 * The reading with every scale resolved, as a new object (the reading given is never changed): what every path that needs
 * a clear scale reads, `readingAt` first. `inputs` is `{ declared, memory }`, the declared harmony in effect at the playing
 * position and the page memory (createScaleMemory) that holds the user's picks and the kept proposal. Each span whose scale
 * is ambiguous resolves on its own scale with the pick and the kept proposal the memory holds for its set of candidates,
 * so the whole window follows what plays now.
 * - a proposed or chosen span gets its scale as the clear scale of the chosen candidate, plus `source`, `reason`, `key`,
 *   `setKey`, `sameNotes` and `candidates` (`[{ key, name }]` in evidence order), and the warnings that candidate's proposal
 *   computed;
 * - an unresolved span keeps its ambiguous scale, plus `source: 'unresolved'`, `why`, `setKey`, `sameNotes` and
 *   `candidates`, and has no warning;
 * - a heard span is returned unchanged, and `whole` is resolved the same way (it carries no warnings);
 * - `warnings` is rebuilt in begin order from the warnings of every span, each a copy with a fresh `index`, its
 *   `spanIndex` and its `scaleName`. A resolved span's own `warnings` are the same copies; a heard span keeps its own list
 *   as it was, and `warnings` of the reading is the list that holds the current indexes.
 * A reading of a status other than 'ready' or 'none', or inputs without a memory, throws.
 */
export function resolveReading(reading, inputs) {
  if (reading === null || typeof reading !== 'object' || (reading.status !== 'ready' && reading.status !== 'none')) {
    throw new Error(`Moontide: cannot resolve a reading with status '${String(reading?.status)}'`);
  }
  inputsOf(inputs);
  const memory = memoryOf(inputs);
  const whole = resolvedScale(reading.whole, resolveWithMemory(reading.whole, inputs, memory));
  const warnings = [];
  const spans = reading.spans.map((span, spanIndex) => {
    const resolution = resolveWithMemory(span.scale, inputs, memory);
    const inUse = resolution.source === 'proposed' || resolution.source === 'chosen';
    let resolved = span;
    if (resolution.source !== 'heard') {
      const scale = resolvedScale(span.scale, resolution);
      const proposal = inUse ? span.proposals.find((entry) => entry.key === resolution.key) : undefined;
      if (inUse && proposal === undefined) {
        throw new Error(`Moontide: the reading has no proposal for the scale '${resolution.key}'`);
      }
      resolved = { ...span, scale, warnings: proposal === undefined ? [] : proposal.warnings };
    }
    const own = resolved.warnings.map((warning) => ({ ...warning, spanIndex, scaleName: resolved.scale.name }));
    for (const warning of own) {
      warning.index = warnings.length;
      warnings.push(warning);
    }
    return inUse ? { ...resolved, warnings: own } : resolved;
  });
  return { ...reading, whole, spans, warnings };
}
