#!/usr/bin/env node
// Reads, during a session with real instruments, what the Moontide page sends to each MIDI port that follows its clock.
//
// A session with two ports on the clock is about ten thousand messages in two minutes: too many to read by eye. This file has
// two halves. The install source wraps MIDIOutput.prototype.send in the page and logs every call to window.__clockSniff; it
// only logs and always forwards the call unchanged, so the bytes and timestamp that reach the port are the page's own. The
// summary turns that log into numbers per port: Start, Stop and Continue counts, tick spacing, holes and doubled ticks
// against a tempo range, and for each run the Start's distance to its first tick, to a beat note and to the first note.
//
// Use it with Claude in Chrome or the DevTools console, in the Moontide tab (again after any reload):
//   node scripts/clock-sniff.mjs install            prints the source to run in the page once
//   node scripts/clock-sniff.mjs summary '<json>'   prints an expression to run in the page; it evaluates to a JSON string
// The summary options are { from, to, minBpm, maxBpm, beat: { port, note }, ports }. A hole is a spacing more than 0.5 ms above
// the slowest tick spacing, and a doubled tick a spacing below half the fastest one; the 0.5 ms is fixed. Clear the log between steps with
// window.__clockSniff.length = 0.

import { pathToFileURL } from 'node:url';

// An expression to run in the page. Idempotent: a second run changes nothing.
export const CLOCK_SNIFF_INSTALL_SOURCE = `(() => {
  if (Array.isArray(window.__clockSniff)) return 'already installed';
  if (typeof MIDIOutput === 'undefined') throw new Error('MIDIOutput is not available in this page');
  const original = MIDIOutput.prototype.send;
  window.__clockSniff = [];
  MIDIOutput.prototype.send = function (data, ts) {
    window.__clockSniff.push({ t: performance.now(), port: this.name, bytes: Array.from(data), ts: typeof ts === 'number' ? ts : null });
    return original.apply(this, arguments);
  };
  return 'installed';
})()`;

// Pure and self-contained: its own source text is sent into the page, so it imports nothing and reads no name outside itself.
// entries: [{ t, port, bytes, ts }] as the install source logs them. Throws an Error naming a bad option.
export function clockSniffSummary(entries, options = {}) {
  const fail = (message) => {
    throw new Error('clockSniffSummary: ' + message);
  };
  const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
  const round = (v) => (v === null ? null : Math.round(v * 100) / 100);

  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('options must be an object');
  for (const key of Object.keys(options)) {
    if (!['from', 'to', 'minBpm', 'maxBpm', 'beat', 'ports'].includes(key)) fail('unknown option "' + key + '"');
  }
  const { from, to, minBpm, maxBpm, beat, ports } = options;
  if (from !== undefined && !isNumber(from)) fail('from must be a number');
  if (to !== undefined && !isNumber(to)) fail('to must be a number');
  if (from !== undefined && to !== undefined && to < from) fail('to is below from: the window is empty');
  if ((minBpm === undefined) !== (maxBpm === undefined)) fail('minBpm and maxBpm go together: give both or neither');
  if (minBpm !== undefined) {
    if (!isNumber(minBpm) || minBpm <= 0) fail('minBpm must be a number above 0');
    if (!isNumber(maxBpm) || maxBpm <= 0) fail('maxBpm must be a number above 0');
    if (minBpm > maxBpm) fail('minBpm is above maxBpm');
    // A missing tick doubles the spacing. At maxBpm that is not above the hole limit (set by minBpm) once the range is about
    // twice wide, so a hole at the fast end would read as a normal tick and the count would say 0.
    if ((2 * 2500) / maxBpm <= 2500 / minBpm + 0.5) fail('maxBpm is about twice minBpm or more: a missing tick could not be told from a normal one, so give a narrower range');
  }
  if (beat !== undefined) {
    if (beat === null || typeof beat !== 'object' || typeof beat.port !== 'string') fail('beat needs a port name');
    if (!Number.isInteger(beat.note) || beat.note < 0 || beat.note > 127) fail('beat.note must be an integer from 0 to 127');
  }
  if (ports !== undefined && (!Array.isArray(ports) || ports.some((p) => typeof p !== 'string'))) fail('ports must be an array of port names');
  if (!Array.isArray(entries)) fail('entries must be an array');

  const timeOf = (e) => (typeof e.ts === 'number' && e.ts > 0 ? e.ts : e.t);
  const list = entries
    .map((e) => ({ e, at: timeOf(e) }))
    .filter((x) => (from === undefined || x.at >= from) && (to === undefined || x.at <= to))
    .sort((a, b) => a.at - b.at);
  const isNoteOn = (bytes) => bytes.length === 3 && bytes[0] >= 144 && bytes[0] <= 159 && bytes[2] > 0;

  // Read from the whole log, not the window: a Start near the window edge must meet the beat just outside it, not one a bar away.
  const beatTimes = beat === undefined
    ? []
    : entries.filter((e) => e.port === beat.port && isNoteOn(e.bytes) && e.bytes[1] === beat.note).map(timeOf);
  const nearestBeat = (at) => beatTimes.reduce((best, b) => (best === null || Math.abs(b - at) < Math.abs(best - at) ? b : best), null);

  const names = [];
  const perPort = new Map();
  for (const x of list) {
    if (!perPort.has(x.e.port)) {
      perPort.set(x.e.port, []);
      names.push(x.e.port);
    }
    perPort.get(x.e.port).push(x);
  }
  const reported = ports === undefined ? names : ports;

  const holeAbove = minBpm === undefined ? null : 2500 / minBpm + 0.5;
  const doubledBelow = maxBpm === undefined ? null : 2500 / maxBpm / 2;

  // A note-on counts as the first note of a Start only when it came at most this long before it; an older one belongs to music
  // that was already playing (for example the tail after a Stop), and reading it would show a misalignment that is not there.
  const maxLeadMs = 1000;

  const readPort = (items) => {
    const out = { starts: 0, stops: 0, continues: 0, songPositions: 0, ticks: 0, noteOns: 0, late: 0, transport: [] };
    const runs = [];
    let run = null;
    let pendingNotes = [];
    const open = (startAt) => {
      run = { startAt, continueAt: null, ticks: [], stopAt: null, after: [], firstNote: undefined };
      runs.push(run);
      return run;
    };
    for (const { e, at } of items) {
      const b = e.bytes;
      if (b.length === 1 && b[0] === 250) {
        out.starts++;
        out.transport.push(250);
        open(at);
        const near = pendingNotes.filter((n) => at - n <= maxLeadMs);
        if (near.length > 0) run.firstNote = near[0];
        pendingNotes = [];
      } else if (b.length === 1 && b[0] === 251) {
        out.continues++;
        out.transport.push(251);
        // After a Stop, a Continue starts a new run with no Start: its ticks are clock, not ticks left over from the Stop.
        if (run !== null && run.stopAt !== null) open(null).continueAt = at;
      } else if (b.length === 1 && b[0] === 252) {
        out.stops++;
        out.transport.push(252);
        if (run === null || run.stopAt !== null) open(null);
        run.stopAt = at;
        pendingNotes = [];
      } else if (b[0] === 242) {
        out.songPositions++;
      } else if (b.length === 1 && b[0] === 248) {
        out.ticks++;
        if (!(typeof e.ts === 'number' && e.ts > 0) || e.t > e.ts) out.late++;
        if (run === null) open(null);
        (run.stopAt === null ? run.ticks : run.after).push(at);
      } else if (isNoteOn(b)) {
        out.noteOns++;
        if (run !== null && run.stopAt === null && run.startAt !== null) {
          if (run.firstNote === undefined) run.firstNote = at;
        } else {
          pendingNotes.push(at);
        }
      }
    }

    const intervals = [];
    for (const r of runs) for (let i = 1; i < r.ticks.length; i++) intervals.push(r.ticks[i] - r.ticks[i - 1]);
    if (intervals.length === 0) {
      out.tickMs = null;
    } else {
      const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const variance = intervals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / intervals.length;
      out.tickMs = {
        n: intervals.length,
        mean: round(mean),
        sd: round(Math.sqrt(variance)),
        min: round(intervals.reduce((m, v) => (v < m ? v : m), Infinity)),
        max: round(intervals.reduce((m, v) => (v > m ? v : m), -Infinity)),
      };
    }
    out.holes = holeAbove === null ? null : intervals.filter((v) => v > holeAbove).length;
    out.doubled = doubledBelow === null ? null : intervals.filter((v) => v < doubledBelow).length;
    out.runs = runs.map((r) => {
      const beatAt = r.startAt === null ? null : nearestBeat(r.startAt);
      return {
        startAt: round(r.startAt),
        continueAt: round(r.continueAt),
        startToFirstTickMs: r.startAt === null || r.ticks.length === 0 ? null : round(r.ticks[0] - r.startAt),
        startMinusBeatMs: beatAt === null ? null : round(r.startAt - beatAt),
        firstNoteOnMinusStartMs: r.startAt === null || r.firstNote === undefined ? null : round(r.firstNote - r.startAt),
        stopAt: round(r.stopAt),
        ticksAfterStop: r.after.length,
        lastTickAfterStopMs: r.stopAt === null || r.after.length === 0 ? null : round(r.after[r.after.length - 1] - r.stopAt),
      };
    });
    return out;
  };

  const result = { window: { from: from ?? null, to: to ?? null, entries: list.length }, ports: {} };
  for (const name of reported) result.ports[name] = readPort(perPort.get(name) ?? []);
  return result;
}

// The string to run in the page: it reads the page's own log and evaluates to the summary as JSON. Bad options fail here, in
// Node, before anything reaches the page.
export function clockSniffSummaryExpression(options = {}) {
  clockSniffSummary([], options);
  const readLog =
    "(() => { if (!Array.isArray(window.__clockSniff)) throw new Error('the clock sniffer is not installed in this page'); return window.__clockSniff; })()";
  return `JSON.stringify((${clockSniffSummary.toString()})(${readLog}, ${JSON.stringify(options)}))`;
}

function main(argv) {
  const [command, optionsText] = argv;
  const usage = (reason) => {
    console.error(`${reason}\nusage: node scripts/clock-sniff.mjs install | summary ['<options json>']`);
    process.exit(2);
  };
  if (command === 'install') {
    console.log(CLOCK_SNIFF_INSTALL_SOURCE);
  } else if (command === 'summary') {
    let options = {};
    if (optionsText !== undefined) {
      try {
        options = JSON.parse(optionsText);
      } catch (err) {
        usage(`the options are not valid JSON: ${err.message}`);
      }
    }
    try {
      console.log(clockSniffSummaryExpression(options));
    } catch (err) {
      usage(err.message);
    }
  } else {
    usage(command === undefined ? 'no command given' : `unknown command "${command}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
