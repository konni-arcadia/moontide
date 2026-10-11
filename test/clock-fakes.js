// Fakes shared by the clock tests: a fake time (performance.now() time, AudioContext time and timers), a fake
// AudioContext and a fake Strudel scheduler (the Cyclist of @strudel/repl 1.3.0). Not a test file: `npm test` runs
// test/*.test.js only.
//
// The time model. Audio time runs 1:1 with performance time while the context runs:
//   perf = base + audio * 1000 + 34
// so Strudel's own mapping of an audio time a is  perf(a) = base + a * 1000 + 68  (34 ms for "now" and the 34 ms
// of its estimate), and the output-timestamp pairs line up on  base + a * 1000 + 61: the two mappings differ by a
// constant 7 ms, the alignment the clock learns (6.7 to 7.1 ms in the lab).

/**
 * Fake time: `perf` is performance.now() time in ms, `audio()` the AudioContext time in seconds. `advance(ms)`
 * steps in 1 ms increments so every re-armed timer runs; `suspend()` freezes audio time and `resume()` lets it run
 * again from where it stopped (so `base` moves by the suspended duration).
 */
export function makeFakeTime({ startAudio = 2 } = {}) {
  let base = 10000;
  let perf = base + startAudio * 1000 + 34;
  let running = true;
  let frozenAudio = startAudio;
  let nextId = 1;
  const timers = new Map();
  const hooks = [];

  const time = {
    perfNow: () => perf,
    audio: () => (running ? (perf - base - 34) / 1000 : frozenAudio),
    base: () => base,
    isRunning: () => running,
    /** Strudel's mapping of an audio time to performance time, the one the clock's timestamps are built on. */
    strudelPerf: (audioT) => base + audioT * 1000 + 68,
    /** The audio time whose Strudel-mapped performance time is `ts`. */
    audioOfStrudelPerf: (ts) => (ts - base - 68) / 1000,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: perf + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pendingTimers: () => timers.size,
    /** Registers a function that runs after each 1 ms step (the fake Cyclist's ticks). */
    onStep(fn) {
      hooks.push(fn);
    },
    advance(ms) {
      for (let step = 0; step < ms; step++) {
        perf += 1;
        for (const hook of hooks) hook();
        for (const [id, timer] of [...timers]) {
          if (timer.due > perf || !timers.has(id)) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
    suspend() {
      if (!running) return;
      frozenAudio = time.audio();
      running = false;
    },
    resume() {
      if (running) return;
      base = perf - frozenAudio * 1000 - 34;
      running = true;
    },
  };
  return time;
}

/**
 * Fake AudioContext. `getOutputTimestamp()` returns a fresh pair (a new one every 10 ms of audio time); while the
 * context is suspended it returns the last pair from before the suspend (frozen), and for 30 ms after `resume()`
 * a pair whose performanceTime is 0. `outlierOnce(ms)` makes the next call return a pair `ms` late.
 */
export function makeFakeAudioContext(time) {
  let frozen = null;
  let zeroUntil = -Infinity;
  let outlier = null;
  const pairNow = () => {
    // Whole milliseconds first, so a floating-point error never repeats a pair.
    const contextTime = Math.floor(Math.round((time.audio() - 0.05) * 1000) / 10) / 100;
    return { contextTime, performanceTime: time.base() + contextTime * 1000 + 61 };
  };
  const ctx = {
    state: 'running',
    get currentTime() {
      return time.audio();
    },
    getOutputTimestamp() {
      if (ctx.state === 'suspended') return { ...frozen };
      if (time.perfNow() < zeroUntil) return { contextTime: frozen.contextTime, performanceTime: 0 };
      const pair = pairNow();
      if (outlier !== null) {
        pair.performanceTime += outlier;
        outlier = null;
      }
      return pair;
    },
    suspend() {
      frozen = pairNow();
      time.suspend();
      ctx.state = 'suspended';
    },
    resume() {
      time.resume();
      ctx.state = 'running';
      zeroUntil = time.perfNow() + 30;
    },
    outlierOnce(ms) {
      outlier = ms;
    },
  };
  return ctx;
}

/**
 * Fake scheduler with the Cyclist's fields and rules (as the Strudel source runs them). Every 50 ms of audio
 * time while started it ticks: the first tick after a start or a tempo change sets the anchor
 * (num_cycles_at_cps_change = lastEnd, seconds_at_cps_change = the tick's time), then it moves lastEnd by
 * 0.05 * cps. `nowOverride` makes now() return a given value (a negative one right after a start, an exactly
 * integral one). A hap at cycle c sounds at audio time `soundTime(c)`.
 */
export function makeFakeCyclist(time, { cps, latency = 0.1 }) {
  let nextTickAt = 0;
  let anchored = false;
  const cyclist = {
    started: false,
    cps,
    latency,
    lastEnd: 0,
    num_ticks_since_cps_change: 0,
    num_cycles_at_cps_change: 0,
    seconds_at_cps_change: undefined,
    nowOverride: null,
    start() {
      cyclist.started = true;
      cyclist.num_ticks_since_cps_change = 0;
      cyclist.num_cycles_at_cps_change = 0;
      anchored = false;
      nextTickAt = time.audio();
    },
    stop() {
      cyclist.lastEnd = 0;
      cyclist.started = false;
    },
    setCps(value) {
      if (cyclist.cps === value) return;
      cyclist.cps = value;
      cyclist.num_ticks_since_cps_change = 0;
    },
    now() {
      if (cyclist.nowOverride !== null) return cyclist.nowOverride;
      if (!cyclist.started) return 0;
      if (!anchored) return -0.0001;
      return cyclist.num_cycles_at_cps_change + (time.audio() - cyclist.seconds_at_cps_change) * cyclist.cps;
    },
    /** The audio time at which the hap of cycle `c` sounds, under the current anchor. */
    soundTime(c) {
      return (c - cyclist.num_cycles_at_cps_change) / cyclist.cps + cyclist.seconds_at_cps_change + cyclist.latency;
    },
    /** The cycle position whose hap sounds at the Strudel-mapped performance time `ts`, under the current anchor. */
    cycleAtPerf(ts) {
      return cyclist.num_cycles_at_cps_change + (time.audioOfStrudelPerf(ts) - cyclist.latency - cyclist.seconds_at_cps_change) * cyclist.cps;
    },
  };
  time.onStep(() => {
    while (cyclist.started && time.isRunning() && time.audio() >= nextTickAt) {
      if (cyclist.num_ticks_since_cps_change === 0) {
        cyclist.num_cycles_at_cps_change = cyclist.lastEnd;
        cyclist.seconds_at_cps_change = nextTickAt;
        anchored = true;
      }
      cyclist.num_ticks_since_cps_change++;
      cyclist.lastEnd += 0.05 * cyclist.cps;
      nextTickAt += 0.05;
    }
  });
  return cyclist;
}
