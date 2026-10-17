// The page-owned MIDI clock: for each instrument that follows MIDI clock and that the playing code names, one
// Start on a cycle boundary, then 96 ticks per cycle that follow the Strudel scheduler's tempo, sent ahead of
// time with timestamps so the OS delivers them on time even when the main thread is late. A port of the spike
// clock (approach B) with the fixes the research found. Every
// side effect is injected and there is no DOM, so node:test can drive it with fakes. Imported by
// page/midi-out.js without a build step. It never keeps a native MIDIOutput across passes: the port is
// resolved again at each pass, and its bytes go straight to the native port (never through webmidi's guarded
// path).

// 24 pulses per quarter note, 4 beats per cycle: the usual `setcpm(bpm / 4)` (decision K1).
export const CLOCK_TICKS_PER_CYCLE = 96;

// How far ahead of now ticks are queued. 100 ms is the measured minimum that survives 90 ms main-thread
// stalls (measured in the spike); 150 ms keeps a margin.
export const CLOCK_HORIZON_MS = 150;

// The pass period, measured in the spike with the 150 ms horizon.
export const CLOCK_INTERVAL_MS = 10;

// The Start is timestamped this long before its first tick, so a follower sees Start, then the tick (measured in the spike).
export const CLOCK_START_LEAD_MS = 0.5;

// How long before its Start timestamp the notes of a joining instrument may pass when they carry no timestamp
// (the first notes after a fresh page load, before the page's mapping is warm): such a note arrives when it sounds,
// and arrived 31.5 to 36.1 ms before the matching tick in headless Chrome. A note that carries
// the page clock's timestamp is held by that timestamp instead (CLOCK_STAMPED_NOTE_SLACK_MS). A starting value, to
// be tuned on the bench.
export const CLOCK_NOTE_LEAD_MS = 50;

// A note-on that carries the page clock's timestamp sits exactly on a tick, so a joining instrument's hold lets it
// pass from its Start's timestamp minus this slack: the note of the Start's first tick
// goes out with the Start and the downbeat is not lost.
export const CLOCK_STAMPED_NOTE_SLACK_MS = 1;

// The oldest output-timestamp pair still used to extrapolate. A suspended AudioContext freezes the pair, and
// extrapolating from it made the spike clock defer its Start for several cycles after a Stop; a live pair is under 100 ms old.
export const CLOCK_PAIR_MAX_AGE_MS = 500;

// The most ticks one pass may queue. It bounds the work of one pass: a pass that finds more ticks late (after a long
// main-thread stall) queues the rest in the next passes. A tempo whose horizon alone holds more ticks (a cps above
// about 13.9, 3300 bpm) is not music: unusableReason refuses it, so the clock never floods the port.
export const CLOCK_MAX_TICKS_PER_PASS = 200;

// How long a joining instrument's notes are held while its Start cannot be planned (or 2 cycles, whichever is
// longer) before they pass without a Start.
export const CLOCK_HOLD_BUDGET_MS = 5000;

// Distinct fresh output-timestamp pairs the page-wide alignment is warmed up on (measured in the spike).
export const CLOCK_WARMUP_SAMPLES = 5;

export const CLOCK_STATES = Object.freeze(['none', 'waiting', 'running']);

// The Strudel scheduler (the Cyclist of @strudel/repl 1.3.0) fields the clock reads, plus now(). A probe and
// readCyclist pin them, so an upgrade of Strudel fails loudly instead of drifting.
export const CYCLIST_FIELDS = Object.freeze([
  'started',
  'cps',
  'latency',
  'lastEnd',
  'num_ticks_since_cps_change',
  'num_cycles_at_cps_change',
  'seconds_at_cps_change',
]);

// The 34 ms estimate of how far Strudel's notes lag the AudioContext time that the older @strudel/midi added and the
// pinned 1.3.0 no longer does. It stays in the mapping so ticks and stamped notes keep the place they were measured
// at: MIDI follows the clock, with no offset toward the browser's own sounds.
const STRUDEL_LATENCY_MS = 34;
// An output-timestamp pair is fresh while its performance time is this recent (measured in the spike).
export const FRESH_PAIR_MAX_AGE_MS = 100;
// A pair whose offset differs from the alignment by more than this is an outlier; a run of this many outliers
// resets the alignment (measured in the spike).
const OUTLIER_MS = 20;
const OUTLIER_RESET_RUN = 50;
// Share of a new pair's offset taken into the alignment (measured in the spike).
const ALIGN_SMOOTHING = 0.02;
// Tempo segments kept (measured in the spike).
const MAX_SEGMENTS = 8;

// The offset between Strudel's mapping and the output-timestamp mapping is a property of the page's audio
// output, not of one run (6.7 to 7.1 ms in every run of the spike): it is kept across runs so a new run starts on
// the smooth mapping at once (in the spike, switching mappings moved ticks 2 to 4 of a run by up to 8 ms).
export const pageAlignment = { ms: null };

/** Forgets the page-wide alignment (tests; a new warm-up follows). */
export function resetPageAlignment() {
  pageAlignment.ms = null;
}

function cyclistError(field) {
  return new Error(`Moontide: the Strudel scheduler has no numeric ${field}, so the MIDI clock cannot follow the tempo (the page pins @strudel/repl 1.3.0).`);
}

/**
 * Checks the scheduler has the fields the clock reads, with the right types, and returns it. Throws an Error naming
 * the missing field and the pinned version. Only the structure is checked: a value that is not usable right now
 * (a tempo of NaN the code set) is not a Strudel version mismatch, and work() waits it out. `seconds_at_cps_change`
 * is undefined until the scheduler's first tick after it starts, so it is only required once
 * `num_ticks_since_cps_change` is not 0.
 */
export function readCyclist(scheduler) {
  if (scheduler === null || typeof scheduler !== 'object') {
    throw new Error('Moontide: the Strudel scheduler is not available, so the MIDI clock cannot follow the tempo (the page pins @strudel/repl 1.3.0).');
  }
  if (typeof scheduler.now !== 'function') {
    throw new Error('Moontide: the Strudel scheduler has no now() function, so the MIDI clock cannot follow the tempo (the page pins @strudel/repl 1.3.0).');
  }
  if (typeof scheduler.started !== 'boolean') {
    throw new Error('Moontide: the Strudel scheduler has no boolean started, so the MIDI clock cannot follow the tempo (the page pins @strudel/repl 1.3.0).');
  }
  for (const field of ['cps', 'latency', 'lastEnd', 'num_ticks_since_cps_change', 'num_cycles_at_cps_change']) {
    if (typeof scheduler[field] !== 'number') throw cyclistError(field);
  }
  if (scheduler.num_ticks_since_cps_change !== 0 && typeof scheduler.seconds_at_cps_change !== 'number') {
    throw cyclistError('seconds_at_cps_change');
  }
  return scheduler;
}

/** Why the scheduler's numbers cannot be used right now, or null: all finite, the tempo above zero and playable. */
function unusableReason(scheduler) {
  for (const field of ['cps', 'latency', 'lastEnd', 'num_ticks_since_cps_change', 'num_cycles_at_cps_change']) {
    if (!Number.isFinite(scheduler[field])) return `its ${field} is ${scheduler[field]}`;
  }
  if (scheduler.cps <= 0) return `its tempo (cps) is ${scheduler.cps}, not above zero`;
  if (scheduler.cps * CLOCK_TICKS_PER_CYCLE * CLOCK_HORIZON_MS / 1000 > CLOCK_MAX_TICKS_PER_PASS) {
    return `its tempo (cps) is ${scheduler.cps}, too fast to follow`;
  }
  if (scheduler.num_ticks_since_cps_change !== 0 && !Number.isFinite(scheduler.seconds_at_cps_change)) {
    return `its seconds_at_cps_change is ${scheduler.seconds_at_cps_change}`;
  }
  return null;
}

function defaultOnError(text, err) {
  console.error(text, err);
}

/**
 * The page clock. Options (all injected):
 * - getScheduler(): the Strudel scheduler, read at every pass, never kept.
 * - getAudioContext(): the shared AudioContext, or null.
 * - perfNow(): performance.now() time in ms, the time base of MIDIOutput timestamps.
 * - setTimer(fn, ms), clearTimer(timer): one timeout, re-armed after each pass while a port is wanted.
 * - isPlaying(): the page plays.
 * - resolveNative(entry): the one connected native MIDIOutput of entry.port, or null; called at each pass.
 * - isEligible(entry): false while the instrument is held after a reconnect or is being reset.
 * - onState(port, state): called when a port's state changes.
 * - onError(text, err).
 * - alignment: { ms }, default the page-wide one.
 * - rampSeconds(fromCycle, toCycle): while a tempo ramp runs, `{ seconds, lagSeconds }`: the seconds of music between two cycles
 *   through the ramp's steps and how far that can be off when the tempo trails the plan by a step; null when no ramp runs
 *   (default: always null). Only stampOfCycle uses it: a line far enough ahead to lie behind several tempo steps.
 * Returns { want, stop, stateOf, holdsNotes, stamp, stampOfCycle, stats }.
 */
export function createPageClock({
  getScheduler,
  getAudioContext,
  perfNow,
  setTimer,
  clearTimer,
  isPlaying,
  resolveNative,
  isEligible = () => true,
  onState = () => {},
  onError = defaultOnError,
  alignment = pageAlignment,
  rampSeconds = () => null,
}) {
  // port -> { entry: { port, id }, nextTick, startAt, startCycle, stopOwedFrom, holdSince, holdExpired }
  const wanted = new Map();
  // port -> the timestamp of the last message queued for it. Kept across stop() and a leave, so a new Start can
  // never be put before a message of the old run.
  const lastQueued = new Map();
  // port -> the last state given to onState (a port not in it reads 'none').
  const reported = new Map();
  // Ports whose last send threw: they read 'none' and report once until a send succeeds again.
  const failed = new Set();
  const stats = { startsSent: 0, stopsSent: 0, ticksSent: 0, late: 0, startsDeferred: 0, staleTimestamps: 0, outliers: 0 };
  const segments = [];
  const warmup = [];
  let lastGood = null;
  let outlierRun = 0;
  // The performanceTime of the odd pair last counted, so one pair counts once however many ticks read it.
  let lastOutlierPerf = null;
  let timer = null;
  // Set when the scheduler does not have the fields: nothing is sent for the rest of the page session.
  let broken = false;
  let lastPassError = null;

  // The Cyclist's cycle-to-time mapping is piecewise: each tempo change starts a new segment at
  // (num_cycles_at_cps_change, seconds_at_cps_change). Positions before a segment's start were played at the earlier
  // tempo, so they keep the earlier segment (found at the bench in the spike: mapping them with the new tempo left
  // an 89 ms hole in the clock at every tempo change).
  function noteSegment(s) {
    const last = segments.at(-1);
    if (last && last.c === s.num_cycles_at_cps_change && last.s === s.seconds_at_cps_change && last.cps === s.cps) return;
    segments.push({ c: s.num_cycles_at_cps_change, s: s.seconds_at_cps_change, cps: s.cps });
    if (segments.length > MAX_SEGMENTS) segments.shift();
  }

  /** AudioContext time of cycle position c, exactly as the Cyclist computes a hap's targetTime. */
  function audioTimeOf(s, c) {
    let seg = segments[0];
    for (const candidate of segments) if (candidate.c <= c) seg = candidate;
    return (c - seg.c) / seg.cps + seg.s + s.latency;
  }

  /**
   * AudioContext time of the cycle line `c` a change waits for. Like audioTimeOf, except that while a tempo ramp runs the
   * seconds from the start of the latest tempo segment to the line go through the ramp's own steps: one segment at the
   * tempo of the moment puts a line early on a slowing ramp and late on a rising one. With `early` the time is the
   * earliest the line can be heard, the ramp's lag taken off, for a setup that must land before the line.
   */
  function lineAudioTimeOf(s, c, early) {
    let seg = segments[0];
    for (const candidate of segments) if (candidate.c <= c) seg = candidate;
    const through = c > seg.c ? rampSeconds(seg.c, c) : null;
    const seconds = through === null ? (c - seg.c) / seg.cps : through.seconds - (early ? through.lagSeconds : 0);
    return seconds + seg.s + s.latency;
  }

  /**
   * performance.now() time of an AudioContext time, from getOutputTimestamp pairs lined up with Strudel's own
   * mapping by the page-wide alignment. Null when nothing can be scheduled yet (no alignment, no usable pair).
   */
  function perfTimeOf(audioT) {
    const ctx = getAudioContext();
    const now = perfNow();
    const strudel = now + (audioT - ctx.currentTime) * 1000 + STRUDEL_LATENCY_MS;
    const pair = ctx.getOutputTimestamp();
    // Right after resume() the output timestamp is not valid yet (zeros), and a suspended context freezes it: a
    // pair counts only while its performance time is recent.
    const fresh = pair.contextTime > 0 && pair.performanceTime > 0 && now - pair.performanceTime < FRESH_PAIR_MAX_AGE_MS;
    if (!fresh) {
      stats.staleTimestamps++;
      // The last good pair stays right for a short while (both clocks run at the same rate); once it is older than
      // CLOCK_PAIR_MAX_AGE_MS it is not used, so a suspend can never make every cycle look late.
      const usable = alignment.ms !== null && lastGood !== null && now - lastGood.performanceTime <= CLOCK_PAIR_MAX_AGE_MS;
      return usable ? lastGood.performanceTime + (audioT - lastGood.contextTime) * 1000 + alignment.ms : null;
    }
    const newPair = lastGood === null || lastGood.performanceTime !== pair.performanceTime;
    const out = pair.performanceTime + (audioT - pair.contextTime) * 1000;
    const diff = strudel - out;
    if (alignment.ms === null) {
      // First run of the page: warm up on the median of a few distinct fresh pairs, scheduling nothing meanwhile.
      lastGood = { contextTime: pair.contextTime, performanceTime: pair.performanceTime };
      if (newPair) warmup.push(diff);
      if (warmup.length < CLOCK_WARMUP_SAMPLES) return null;
      alignment.ms = [...warmup].sort((a, b) => a - b)[Math.floor(CLOCK_WARMUP_SAMPLES / 2)];
      warmup.length = 0;
      return out + alignment.ms;
    }
    if (Math.abs(diff - alignment.ms) > OUTLIER_MS) {
      // A pair is counted once, not once per tick: a catch-up pass reads the same pair for up to 200 ticks.
      if (pair.performanceTime !== lastOutlierPerf) {
        lastOutlierPerf = pair.performanceTime;
        stats.outliers++;
        if (++outlierRun > OUTLIER_RESET_RUN) {
          // The offset really moved (another output device): start the alignment over on this pair.
          alignment.ms = null;
          outlierRun = 0;
          lastOutlierPerf = null;
          lastGood = { contextTime: pair.contextTime, performanceTime: pair.performanceTime };
          return out + diff;
        }
      }
      // One odd pair is ignored: the last good pair gives the timestamp, and the alignment is not touched.
      if (lastGood !== null) return lastGood.performanceTime + (audioT - lastGood.contextTime) * 1000 + alignment.ms;
      return out + alignment.ms;
    }
    outlierRun = 0;
    lastOutlierPerf = null;
    lastGood = { contextTime: pair.contextTime, performanceTime: pair.performanceTime };
    if (newPair) alignment.ms += (diff - alignment.ms) * ALIGN_SMOOTHING;
    return out + alignment.ms;
  }

  /**
   * The performance.now() timestamp of an AudioContext time by the clock's own mapping (the function its ticks use,
   * so a stamped note and a tick of the same cycle position get one time base), or null when none can be given yet:
   * the page-wide alignment is still warming up, no usable output-timestamp pair exists, the audio time is not a
   * number or the context does not run.
   */
  function stamp(audioTime) {
    if (!contextRunning() || typeof audioTime !== 'number' || !Number.isFinite(audioTime)) return null;
    const t = perfTimeOf(audioTime);
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  }

  /**
   * The performance.now() timestamp of cycle position `cycle` by the clock's own tempo segments and mapping (the one
   * a tick and a stamped note of that position use), or null when none can be given: the cycle is not a finite
   * number, the scheduler cannot be read or does not run, its numbers cannot be used, no tempo segment is known yet,
   * or stamp() has none. Reads the scheduler and notes its segment as a pass does, so it also serves while no
   * instrument wants the clock. While a tempo ramp runs the line is worked out through the ramp, and with `early` it is the
   * earliest time the line can be heard (see lineAudioTimeOf). Never throws.
   */
  function stampOfCycle(cycle, { early = false } = {}) {
    if (typeof cycle !== 'number' || !Number.isFinite(cycle)) return null;
    try {
      const s = readCyclist(getScheduler());
      if (!s.started || unusableReason(s) !== null) return null;
      if (s.num_ticks_since_cps_change !== 0) noteSegment(s);
      if (segments.length === 0) return null;
      return stamp(lineAudioTimeOf(s, cycle, early));
    } catch {
      return null;
    }
  }

  function lastQueuedOf(port) {
    return lastQueued.get(port) ?? 0;
  }

  function resetRun(run) {
    run.nextTick = null;
    run.startAt = null;
    run.startCycle = null;
    run.holdSince = null;
    run.holdExpired = false;
  }

  function reportSendFailure(run, err) {
    // A Start that was already queued may have reached the follower: remember it, so one Stop is still owed.
    if (run.startAt !== null) run.stopOwedFrom = run.startAt;
    resetRun(run);
    if (failed.has(run.entry.port)) return;
    failed.add(run.entry.port);
    onError(`Moontide: a MIDI clock byte could not be sent to port "${run.entry.port}":`, err);
  }

  /** One send; a timestamp of undefined sends at once. False (and one report per port) when it threw. */
  function sendTo(run, native, bytes, timestamp) {
    try {
      if (timestamp === undefined) native.send(bytes);
      else native.send(bytes, timestamp);
    } catch (err) {
      reportSendFailure(run, err);
      return false;
    }
    failed.delete(run.entry.port);
    return true;
  }

  /**
   * The Stop rule: one Stop per started port, never more. Start reached: Stop at once. Start queued but not
   * reached: one Stop timestamped after everything queued, so it cannot overtake the Start. No Start queued, or
   * the port gone: no byte. A run whose send failed after its Start still owes its Stop (`stopOwedFrom`, the
   * Start's timestamp), tried once.
   */
  function stopRun(run) {
    const startAt = run.startAt ?? run.stopOwedFrom;
    const native = startAt === null ? null : resolveNative(run.entry);
    if (startAt !== null && native !== null && native !== undefined) {
      let sent;
      if (perfNow() >= startAt) {
        sent = sendTo(run, native, [0xfc]);
      } else {
        const at = Math.max(startAt, lastQueuedOf(run.entry.port)) + CLOCK_START_LEAD_MS;
        sent = sendTo(run, native, [0xfc], at);
        if (sent) lastQueued.set(run.entry.port, at);
      }
      if (sent) stats.stopsSent++;
    }
    resetRun(run);
    run.stopOwedFrom = null;
  }

  function schedulerStarted() {
    const s = getScheduler();
    return s !== null && typeof s === 'object' && s.started === true;
  }

  function contextRunning() {
    const ctx = getAudioContext();
    return ctx !== null && ctx !== undefined && ctx.state === 'running';
  }

  function stateOf(port) {
    const run = wanted.get(port);
    if (run === undefined || broken || failed.has(port)) return 'none';
    if (isPlaying() !== true || !schedulerStarted() || !contextRunning()) return 'none';
    const native = resolveNative(run.entry);
    if (native === null || native === undefined) return 'none';
    if (run.startAt !== null && perfNow() >= run.startAt) return 'running';
    if (!isEligible(run.entry)) return 'waiting';
    // A fresh Play whose Start goes with cycle 0 shows 'none' until the Start is reached: its first notes are
    // never held.
    let cycle;
    if (run.startAt !== null) cycle = run.startCycle;
    else if (run.nextTick !== null) cycle = run.nextTick / CLOCK_TICKS_PER_CYCLE;
    else cycle = Math.max(0, Math.ceil(getScheduler().now() - 1e-9));
    return cycle > 0 ? 'waiting' : 'none';
  }

  /**
   * True while the note-ons of a joining instrument must wait for its Start: the port is wanted, waiting and
   * eligible, and the Start is not planned yet or the note comes too early. `at` is the note's own timestamp, a
   * finite number when the note carries the page clock's mapping: it passes from CLOCK_STAMPED_NOTE_SLACK_MS before
   * the Start's timestamp, wherever the page is now. A note without a timestamp passes from CLOCK_NOTE_LEAD_MS
   * before the Start, by the time it is sent. A stamped note that is within the horizon while no Start is planned yet
   * first plans the Start itself (planNow): a note leaves NOTE_AHEAD_MS before its timestamp, only a little after the
   * pass that plans the Start of its downbeat, and on a busy page the browser may run the note's callback before that
   * pass. Without it the downbeat's note-on would be dropped for a Start that is about to be planned.
   */
  function holdsNotes(port, at) {
    const run = wanted.get(port);
    if (run === undefined || run.holdExpired) return false;
    if (stateOf(port) !== 'waiting' || !isEligible(run.entry)) return false;
    if (run.startAt === null && typeof at === 'number' && Number.isFinite(at) && at - perfNow() <= CLOCK_HORIZON_MS) planNow(run);
    if (run.startAt === null) return true;
    if (typeof at === 'number' && Number.isFinite(at)) return at < run.startAt - CLOCK_STAMPED_NOTE_SLACK_MS;
    return perfNow() < run.startAt - CLOCK_NOTE_LEAD_MS;
  }

  function setState(port, state) {
    if ((reported.get(port) ?? 'none') === state) return;
    reported.set(port, state);
    onState(port, state);
  }

  function updateStates() {
    for (const port of wanted.keys()) setState(port, stateOf(port));
  }

  /**
   * The hold on a joining instrument's notes has a budget: while its Start is not planned (no usable output
   * timestamp, say) its notes are dropped, so after the budget they pass without a Start and the code hears about it once.
   */
  function watchHold(run, s, now) {
    if (run.startAt !== null || !isEligible(run.entry) || stateOf(run.entry.port) !== 'waiting') {
      run.holdSince = null;
      run.holdExpired = false;
      return;
    }
    run.holdSince ??= now;
    if (run.holdExpired || now - run.holdSince <= Math.max(CLOCK_HOLD_BUDGET_MS, 2000 / s.cps)) return;
    run.holdExpired = true;
    onError(`Moontide: the MIDI clock could not start on port "${run.entry.port}", so its notes pass without a Start.`, new Error('the clock Start was not planned within its budget'));
  }

  /** The look-ahead for one port: its Start, then its ticks, up to the horizon. */
  function planRun(run, s, settled, now) {
    const { port } = run.entry;
    const native = resolveNative(run.entry);
    if (native === null || native === undefined || !isEligible(run.entry)) {
      // The port cannot be reached, or it is being reset: its run is lost (no byte), and it gets a new Start
      // on a boundary once it is back.
      resetRun(run);
      return;
    }
    // A failed send left a Start without its Stop: the Stop goes before any new Start.
    if (run.stopOwedFrom !== null) stopRun(run);
    if (run.nextTick === null) {
      // First tick on the next cycle boundary, so the Start lands on a downbeat. `+ 0` keeps -0 out of it.
      run.nextTick = Math.max(0, Math.ceil(s.now() - 1e-9)) * CLOCK_TICKS_PER_CYCLE + 0;
    }
    for (let planned = 0; ; planned++) {
      // The rest of a long stall's late ticks goes out in the next passes, never dropped (the tempo is playable:
      // unusableReason refused the one that is not, so the backlog shrinks at every pass).
      if (planned >= CLOCK_MAX_TICKS_PER_PASS) return;
      const c = run.nextTick / CLOCK_TICKS_PER_CYCLE;
      // Right after a tempo change the Cyclist has the new cps but the old anchor until its next tick: only
      // positions before its last query end are sure to be on the old segment then.
      if (!settled && c >= s.lastEnd) return;
      const t = perfTimeOf(audioTimeOf(s, c));
      if (t === null) return;
      if (!Number.isFinite(t)) throw new Error('Moontide: the MIDI clock computed a tick time that is not a number.');
      if (t - now > CLOCK_HORIZON_MS) return;
      if (run.startAt === null) {
        if (t - CLOCK_START_LEAD_MS < Math.max(now, lastQueuedOf(port) + CLOCK_START_LEAD_MS)) {
          // Too late for this downbeat (the clock was not ready in time): Start on the next one, never with a
          // burst of late ticks, and never before a message of an earlier run.
          run.nextTick = (Math.floor(c) + 1) * CLOCK_TICKS_PER_CYCLE;
          stats.startsDeferred++;
          continue;
        }
        const startAt = t - CLOCK_START_LEAD_MS;
        if (!sendTo(run, native, [0xfa], startAt)) return;
        run.startAt = startAt;
        run.startCycle = c;
        stats.startsSent++;
        lastQueued.set(port, Math.max(lastQueuedOf(port), startAt));
      }
      // A late tick is sent at once, never dropped: followers count ticks, so a skipped tick would shift their
      // phase for good, while a burst only compresses briefly.
      let sent;
      if (t < now) {
        stats.late++;
        sent = sendTo(run, native, [0xf8]);
      } else {
        sent = sendTo(run, native, [0xf8], t);
      }
      if (!sent) return;
      lastQueued.set(port, Math.max(lastQueuedOf(port), t));
      stats.ticksSent++;
      run.nextTick++;
    }
  }

  /**
   * One planning pass for one port, now, outside the pass timer (a stamped note found its Start not planned yet). The
   * same work as a pass does for that port; a scheduler that cannot be read or used is left to the next pass, which
   * reports it. Never throws; a failure is reported once per distinct cause, like a pass.
   */
  function planNow(run) {
    let s;
    try {
      s = readCyclist(getScheduler());
    } catch {
      return;
    }
    try {
      if (!s.started || isPlaying() !== true || !contextRunning() || unusableReason(s) !== null) return;
      const settled = s.num_ticks_since_cps_change !== 0;
      if (settled) noteSegment(s);
      if (segments.length === 0) return;
      planRun(run, s, settled, perfNow());
    } catch (err) {
      if (lastPassError !== err.message) {
        lastPassError = err.message;
        onError('Moontide: the MIDI clock failed:', err);
      }
    }
  }

  function work(s) {
    if (!s.started) {
      // A stop path the page did not take: the followers get their Stop here.
      for (const run of wanted.values()) stopRun(run);
      segments.length = 0;
      lastGood = null;
      updateStates();
      return;
    }
    if (isPlaying() !== true || !contextRunning()) {
      for (const run of wanted.values()) if (run.startAt === null) resetRun(run);
      updateStates();
      return;
    }
    const unusable = unusableReason(s);
    if (unusable !== null) {
      // Not a broken scheduler (readCyclist saw the fields): the code set a tempo that cannot be played. No tick can be planned, and the ticks
      // missed meanwhile must never come back as a burst, so each started follower gets its Stop and a new Start
      // follows on a boundary once the tempo is usable again.
      for (const run of wanted.values()) stopRun(run);
      segments.length = 0;
      updateStates();
      throw new Error(`Moontide: the MIDI clock waits for a usable tempo, because ${unusable}.`);
    }
    const settled = s.num_ticks_since_cps_change !== 0;
    if (settled) noteSegment(s);
    if (segments.length === 0) {
      updateStates();
      return;
    }
    const now = perfNow();
    for (const run of wanted.values()) {
      planRun(run, s, settled, now);
      watchHold(run, s, now);
    }
    updateStates();
  }

  function pass() {
    timer = null;
    let scheduler;
    try {
      scheduler = readCyclist(getScheduler());
    } catch (err) {
      // Loud, once: the clock sends nothing more in this page session.
      broken = true;
      onError(err.message, err);
      try {
        updateStates();
      } catch (stateErr) {
        onError('Moontide: the MIDI clock state could not be read:', stateErr);
      }
      return;
    }
    try {
      work(scheduler);
    } catch (err) {
      // One report per distinct cause, so a repeating fault does not flood the log at 100 passes per second.
      if (lastPassError !== err.message) {
        lastPassError = err.message;
        onError('Moontide: the MIDI clock failed:', err);
      }
    }
    if (wanted.size > 0 && !broken && timer === null) timer = setTimer(pass, CLOCK_INTERVAL_MS);
  }

  function syncTimer() {
    if (wanted.size > 0 && !broken) {
      if (timer === null) timer = setTimer(pass, CLOCK_INTERVAL_MS);
    } else if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /**
   * Sets the ports that get the clock: `entries` is [{ port, id }]. A new port joins (no byte now: the next pass
   * plans its Start on a cycle boundary), a port that left gets the Stop rule at once, a port in both is
   * untouched. A second entry with the same port is ignored (a valid rig has one instrument per port).
   */
  function want(entries) {
    const next = new Map();
    for (const entry of entries) if (!next.has(entry.port)) next.set(entry.port, { port: entry.port, id: entry.id });
    for (const [port, run] of wanted) {
      if (next.has(port)) continue;
      stopRun(run);
      wanted.delete(port);
      failed.delete(port);
      setState(port, 'none');
      reported.delete(port);
    }
    for (const [port, entry] of next) {
      const run = wanted.get(port);
      if (run === undefined) wanted.set(port, { entry, nextTick: null, startAt: null, startCycle: null, stopOwedFrom: null, holdSince: null, holdExpired: false });
      else run.entry = entry;
    }
    syncTimer();
    updateStates();
  }

  /**
   * The Stop rule for every wanted port. The wanted set stays (the same code plays again after Play); the tempo
   * segments and the kept output-timestamp pair are forgotten, and each port's last queued time is kept.
   */
  function stop() {
    for (const run of wanted.values()) stopRun(run);
    segments.length = 0;
    lastGood = null;
    updateStates();
  }

  return { want, stop, stateOf, holdsNotes, stamp, stampOfCycle, stats };
}
