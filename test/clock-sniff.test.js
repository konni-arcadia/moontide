import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CLOCK_SNIFF_INSTALL_SOURCE,
  clockSniffSummary,
  clockSniffSummaryExpression,
} from '../scripts/clock-sniff.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/clock-sniff.mjs', import.meta.url));

// A page stand-in: window is the context's own global, performance.now is driven by the test, and MIDIOutput is a fake whose
// original send records what reaches the "port" (the receiver and every argument).
function fakePage() {
  const ctx = vm.createContext({});
  vm.runInContext(
    `
    globalThis.window = globalThis;
    globalThis.__now = 0;
    globalThis.__reached = [];
    globalThis.performance = { now: () => globalThis.__now };
    globalThis.MIDIOutput = class MIDIOutput {
      constructor(name) { this.name = name; }
      send(...args) { globalThis.__reached.push({ self: this, args }); }
    };
    globalThis.__ports = {};
    `,
    ctx,
  );
  const send = (name, bytes, ts, now) => {
    ctx.__now = now;
    const args = ts === undefined ? '' : `, ${ts}`;
    return vm.runInContext(
      `(__ports[${JSON.stringify(name)}] ??= new MIDIOutput(${JSON.stringify(name)})).send(${bytes}${args})`,
      ctx,
    );
  };
  const json = (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, ctx));
  return { ctx, send, json };
}

// Log entries as the sniffer writes them: ts is when the port should act, t is when the page sent it.
const entry = (port, bytes, ts) => ({ t: ts - 100, port, bytes, ts });
// n ticks 25 ms apart (100 BPM) starting at `first`.
const grid = (port, first, n, step = 25) => Array.from({ length: n }, (_, i) => entry(port, [0xf8], first + i * step));

test('install: every send reaches the original with the same receiver, bytes, timestamp and argument count, and is logged', () => {
  const { ctx, send, json } = fakePage();
  assert.equal(vm.runInContext(CLOCK_SNIFF_INSTALL_SOURCE, ctx), 'installed');
  send('P', '[248]', 12.5, 5);
  send('P', '[0x90, 60, 100]', undefined, 6);
  send('P', 'new Uint8Array([250])', 0, 7);
  assert.deepEqual(json('__reached.map((c) => c.args)'), [[[248], 12.5], [[144, 60, 100]], [{ 0: 250 }, 0]]);
  assert.equal(vm.runInContext('__reached.every((c) => c.self === __ports.P)', ctx), true);
  assert.deepEqual(json('window.__clockSniff'), [
    { t: 5, port: 'P', bytes: [248], ts: 12.5 },
    { t: 6, port: 'P', bytes: [144, 60, 100], ts: null },
    { t: 7, port: 'P', bytes: [250], ts: 0 },
  ]);
});

test('install: a second install changes nothing and each later send is logged and forwarded once', () => {
  const { ctx, send, json } = fakePage();
  assert.equal(vm.runInContext(CLOCK_SNIFF_INSTALL_SOURCE, ctx), 'installed');
  send('P', '[248]', 1, 1);
  assert.equal(vm.runInContext(CLOCK_SNIFF_INSTALL_SOURCE, ctx), 'already installed');
  send('P', '[248]', 2, 2);
  assert.equal(json('window.__clockSniff.length'), 2);
  assert.equal(json('__reached.length'), 2);
});

test('install: in a page without MIDIOutput it throws and leaves no log behind, so a retry fails the same way', () => {
  const { ctx } = fakePage();
  vm.runInContext('delete globalThis.MIDIOutput', ctx);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => vm.runInContext(CLOCK_SNIFF_INSTALL_SOURCE, ctx), /MIDIOutput is not available/);
  }
  assert.equal(vm.runInContext('window.__clockSniff', ctx), undefined);
});

test('summary: a steady run reads as one Start, one Stop, even spacing, and the ticks already queued after the Stop', () => {
  const entries = [
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 20),
    entry('A', [0xfc], 1500),
    ...grid('A', 1500.5, 4),
  ];
  const a = clockSniffSummary(entries, { minBpm: 100, maxBpm: 100 }).ports.A;
  assert.equal(a.starts, 1);
  assert.equal(a.stops, 1);
  assert.equal(a.continues, 0);
  assert.equal(a.songPositions, 0);
  assert.equal(a.ticks, 24);
  assert.equal(a.late, 0);
  assert.deepEqual(a.transport, [250, 252]);
  assert.deepEqual(a.tickMs, { n: 19, mean: 25, sd: 0, min: 25, max: 25 });
  assert.equal(a.holes, 0);
  assert.equal(a.doubled, 0);
  assert.equal(a.runs.length, 1);
  assert.equal(a.runs[0].startAt, 1000);
  assert.equal(a.runs[0].startToFirstTickMs, 0.5);
  assert.equal(a.runs[0].stopAt, 1500);
  assert.equal(a.runs[0].ticksAfterStop, 4);
  assert.ok(a.runs[0].lastTickAfterStopMs <= 100);
});

test('summary: a missing tick is a hole, an extra tick is a doubled one, and without a tempo range both are null', () => {
  const ticks = grid('A', 1000.5, 20);
  const missing = ticks.filter((_, i) => i !== 10);
  const extra = [...ticks, entry('A', [0xf8], 1000.5 + 25 * 10 + 11.5)];
  const range = { minBpm: 100, maxBpm: 100 };
  const m = clockSniffSummary([entry('A', [0xfa], 1000), ...missing], range).ports.A;
  assert.equal(m.holes, 1);
  assert.equal(m.doubled, 0);
  const x = clockSniffSummary([entry('A', [0xfa], 1000), ...extra], range).ports.A;
  assert.equal(x.holes, 0);
  assert.equal(x.doubled, 1);
  const none = clockSniffSummary([entry('A', [0xfa], 1000), ...ticks]).ports.A;
  assert.equal(none.holes, null);
  assert.equal(none.doubled, null);
});

test('summary: two runs separated by a gap are two runs and no spacing spans the gap', () => {
  const entries = [
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 20),
    entry('A', [0xfc], 1500),
    entry('A', [0xfa], 3500),
    ...grid('A', 3500.5, 20),
    entry('A', [0xfc], 4000),
  ];
  const a = clockSniffSummary(entries, { minBpm: 100, maxBpm: 100 }).ports.A;
  assert.deepEqual(a.transport, [250, 252, 250, 252]);
  assert.equal(a.runs.length, 2);
  assert.equal(a.tickMs.max, 25);
  assert.equal(a.tickMs.n, 38);
  assert.equal(a.holes, 0);
});

test('summary: a stamped note-on before the Start reads negative; a velocity-0 note-on and a note-off are not note-ons', () => {
  const entries = [
    entry('A', [0x99, 37, 0], 900),
    entry('A', [0x89, 37, 64], 950),
    entry('A', [0x99, 37, 100], 999.5),
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 3),
  ];
  const a = clockSniffSummary(entries).ports.A;
  assert.equal(a.noteOns, 1);
  assert.equal(a.runs[0].firstNoteOnMinusStartMs, -0.5);
});

test('summary: a note-on left over from before the previous Stop is not the first note of the next Start', () => {
  const entries = [
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 20),
    entry('A', [0xfc], 1500),
    entry('A', [0x90, 60, 90], 1520),
    entry('A', [0xfa], 3500),
    ...grid('A', 3500.5, 3),
  ];
  const a = clockSniffSummary(entries).ports.A;
  assert.equal(a.runs.length, 2);
  assert.equal(a.runs[1].firstNoteOnMinusStartMs, null);
  const near = clockSniffSummary([...entries, entry('A', [0x90, 60, 90], 3499.5)]).ports.A;
  assert.equal(near.runs[1].firstNoteOnMinusStartMs, -0.5);
});

test('summary: a note-on after the Start is read against that Start', () => {
  const entries = [entry('A', [0xfa], 1000), entry('A', [0x90, 60, 90], 1030), ...grid('A', 1000.5, 3)];
  assert.equal(clockSniffSummary(entries).ports.A.runs[0].firstNoteOnMinusStartMs, 30);
});

test('summary: the Start is read against the nearest beat note of the beat port, which is read even when ports lists only the clock port', () => {
  const entries = [
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 3),
    entry('B', [0x99, 37, 100], 1000.5),
    entry('B', [0x99, 37, 100], 1600.5),
    entry('B', [0x99, 42, 100], 1000),
  ];
  const s = clockSniffSummary(entries, { ports: ['A'], beat: { port: 'B', note: 37 } });
  assert.deepEqual(Object.keys(s.ports), ['A']);
  assert.equal(s.ports.A.runs[0].startMinusBeatMs, -0.5);
  assert.equal(clockSniffSummary(entries).ports.A.runs[0].startMinusBeatMs, null);
});

test('summary: the nearest beat is looked for in the whole log, also just outside the window', () => {
  const entries = [
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 3),
    entry('B', [0x99, 37, 100], 999.5),
    entry('B', [0x99, 37, 100], 1600.5),
  ];
  const s = clockSniffSummary(entries, { from: 1000, to: 1100, ports: ['A'], beat: { port: 'B', note: 37 } });
  assert.equal(s.ports.A.runs[0].startMinusBeatMs, 0.5);
});

test('summary: from and to keep the entries inside them, and ticks before the first Start in the window form a run with no Start', () => {
  const entries = [entry('A', [0xfa], 1000), ...grid('A', 1000.5, 20)];
  const s = clockSniffSummary(entries, { from: 1200, to: 1400 });
  assert.deepEqual(s.window, { from: 1200, to: 1400, entries: 8 });
  assert.equal(s.ports.A.starts, 0);
  assert.equal(s.ports.A.ticks, 8);
  assert.equal(s.ports.A.runs.length, 1);
  assert.equal(s.ports.A.runs[0].startAt, null);
  assert.equal(s.ports.A.runs[0].startToFirstTickMs, null);
});

test('summary: an entry without a usable ts is placed by its send time, and a tick that left late or without a timestamp is late', () => {
  const entries = [
    { t: 1000, port: 'A', bytes: [0xfa], ts: null },
    { t: 1010, port: 'A', bytes: [0xf8], ts: null },
    { t: 1040, port: 'A', bytes: [0xf8], ts: 1030 },
    entry('A', [0xf8], 1050),
  ];
  const a = clockSniffSummary(entries, { from: 1000, to: 1100 }).ports.A;
  assert.equal(a.ticks, 3);
  assert.equal(a.late, 2);
  assert.equal(a.runs[0].startAt, 1000);
});

test('summary: ticks after a Continue that follows a Stop are a run of their own, not ticks left after the Stop', () => {
  const entries = [
    entry('A', [0xfa], 1000),
    ...grid('A', 1000.5, 10),
    entry('A', [0xfc], 1250),
    entry('A', [0xfb], 2000),
    ...grid('A', 2000.5, 10),
  ];
  const a = clockSniffSummary(entries, { minBpm: 100, maxBpm: 100 }).ports.A;
  assert.deepEqual(a.transport, [250, 252, 251]);
  assert.equal(a.runs.length, 2);
  assert.equal(a.runs[0].ticksAfterStop, 0);
  assert.equal(a.runs[1].startAt, null);
  assert.equal(a.runs[1].continueAt, 2000);
  assert.equal(a.runs[1].ticksAfterStop, 0);
  assert.equal(a.tickMs.n, 18);
  assert.equal(a.holes, 0);
});

test('summary: transport and position messages are counted by their bytes', () => {
  const entries = [entry('A', [0xfa], 1), entry('A', [0xfb], 2), entry('A', [0xf2, 0, 0], 3), entry('A', [0xfc], 4)];
  const a = clockSniffSummary(entries).ports.A;
  assert.deepEqual([a.starts, a.continues, a.songPositions, a.stops], [1, 1, 1, 1]);
  assert.deepEqual(a.transport, [250, 251, 252]);
});

test('summary: the expression evaluated in the page after real sends reads the same as the function on the same log', () => {
  const { ctx, send, json } = fakePage();
  vm.runInContext(CLOCK_SNIFF_INSTALL_SOURCE, ctx);
  send('A', '[250]', 1000, 900);
  for (let i = 0; i < 12; i++) send('A', '[248]', 1000.5 + 25 * i, 901 + i);
  send('B', '[0x99, 37, 100]', 1000.5, 902);
  send('A', '[252]', 1300, 950);
  const options = { minBpm: 100, maxBpm: 100, beat: { port: 'B', note: 37 }, ports: ['A'] };
  const fromPage = JSON.parse(vm.runInContext(clockSniffSummaryExpression(options), ctx));
  const direct = JSON.parse(JSON.stringify(clockSniffSummary(json('window.__clockSniff'), options)));
  assert.deepEqual(fromPage, direct);
  assert.equal(fromPage.ports.A.starts, 1);
  assert.equal(fromPage.ports.A.runs[0].startMinusBeatMs, -0.5);
});

test('summary: the expression in a page without the sniffer throws instead of returning empty numbers', () => {
  const { ctx } = fakePage();
  assert.throws(() => vm.runInContext(clockSniffSummaryExpression({}), ctx), /the clock sniffer is not installed in this page/);
});

test('summary: bad options throw an error that names the option', () => {
  assert.throws(() => clockSniffSummary([], { bogus: 1 }), /bogus/);
  assert.throws(() => clockSniffSummary([], { minBpm: 100 }), /maxBpm/);
  assert.throws(() => clockSniffSummary([], { maxBpm: 100 }), /minBpm/);
  assert.throws(() => clockSniffSummary([], { minBpm: 120, maxBpm: 100 }), /minBpm/);
  assert.throws(() => clockSniffSummary([], { minBpm: 60, maxBpm: 130 }), /narrower range/);
  assert.doesNotThrow(() => clockSniffSummary([], { minBpm: 60, maxBpm: 110 }));
  assert.throws(() => clockSniffSummary([], { beat: { port: 'B', note: 128 } }), /note/);
  assert.throws(() => clockSniffSummary([], { from: 'x' }), /from/);
  assert.throws(() => clockSniffSummary([], { from: 200, to: 100 }), /below from/);
  assert.throws(() => clockSniffSummary([], { ports: 'A' }), /ports/);
  assert.throws(() => clockSniffSummaryExpression({ minBpm: 100 }), /maxBpm/);
});

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('cli: install prints the install source and summary prints the expression, both with exit 0', () => {
  const install = cli('install');
  assert.equal(install.status, 0);
  assert.ok(install.stdout.includes('__clockSniff'));
  const summary = cli('summary', '{"minBpm":100,"maxBpm":100}');
  assert.equal(summary.status, 0);
  assert.ok(summary.stdout.startsWith('JSON.stringify('));
});

test('cli: no argument, an unknown command or invalid options exit 2 with a reason on stderr', () => {
  for (const args of [[], ['bogus'], ['summary', '{not json'], ['summary', '{"minBpm":100}']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}`);
    assert.ok(r.stderr.trim().length > 0, `args ${JSON.stringify(args)}`);
  }
});
