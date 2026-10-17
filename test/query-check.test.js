import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUERY_REFUSAL_LEAD, captureQueryTypes, createSchedulerQueryScope, installQueryCheck, queryFailure, queryRefusalText } from '../page/query-check.js';

class FakeTimeSpan {
  constructor(begin, end) {
    this.begin = begin;
    this.end = end;
  }
}

class FakeState {
  constructor(span, controls) {
    this.span = span;
    this.controls = controls;
  }
}

function patternReturning(haps) {
  return { query: () => haps, queryArc: () => haps };
}

function patternThrowing(value) {
  return {
    query: () => {
      throw value;
    },
    queryArc: () => [],
  };
}

const constructors = { State: FakeState, TimeSpan: FakeTimeSpan };

test('queryFailure returns null for a pattern whose query returns no events, because silence is not a failure', () => {
  assert.equal(queryFailure(patternReturning([]), { ...constructors, from: 0 }), null);
});

test('queryFailure returns null for a pattern whose query returns events', () => {
  assert.equal(queryFailure(patternReturning([{ value: 'c3' }]), { ...constructors, from: 1 }), null);
});

test('queryFailure returns the message of a thrown Error', () => {
  const failure = queryFailure(patternThrowing(new Error('cannot parse as numeral: "a2"')), { ...constructors, from: 0 });
  assert.equal(failure, 'cannot parse as numeral: "a2"');
});

test('queryFailure returns String(value) for a thrown non-Error', () => {
  assert.equal(queryFailure(patternThrowing('boom'), { ...constructors, from: 0 }), 'boom');
});

test('queryFailure queries exactly the window from to from + 1, for from 0 and from 2.75', () => {
  for (const from of [0, 2.75]) {
    let seen = null;
    const pattern = {
      query: (state) => {
        seen = state;
        return [];
      },
    };
    queryFailure(pattern, { ...constructors, from });
    assert.ok(seen instanceof FakeState);
    assert.ok(seen.span instanceof FakeTimeSpan);
    assert.equal(seen.span.begin, from);
    assert.equal(seen.span.end, from + 1);
  }
});

test('queryFailure passes the scheduler tempo as the _cps control, and no controls when the tempo is not a positive number', () => {
  const seen = [];
  const pattern = {
    query: (state) => {
      seen.push(state);
      return [];
    },
  };
  class ControlsState {
    constructor(span, controls) {
      this.span = span;
      this.controls = controls;
    }
  }
  const types = { State: ControlsState, TimeSpan: FakeTimeSpan, from: 0 };
  queryFailure(pattern, { ...types, cps: 0.75 });
  queryFailure(pattern, { ...types, cps: 0 });
  queryFailure(pattern, { ...types, cps: undefined });
  queryFailure(pattern, { ...types, cps: Number.NaN });
  assert.deepEqual(seen[0].controls, { _cps: 0.75 });
  assert.equal(seen[1].controls, undefined);
  assert.equal(seen[2].controls, undefined);
  assert.equal(seen[3].controls, undefined);
  assert.equal('cyclist' in (seen[0].controls ?? {}), false);
});

test('queryFailure throws a Moontide error naming State and TimeSpan when either is not a function, never skipping the check', () => {
  for (const bad of [
    { State: undefined, TimeSpan: FakeTimeSpan },
    { State: FakeState, TimeSpan: undefined },
    { State: undefined, TimeSpan: undefined },
  ]) {
    assert.throws(
      () => queryFailure(patternReturning([]), { ...bad, from: 0 }),
      (err) => err instanceof Error && /^Moontide:/.test(err.message) && err.message.includes('State') && err.message.includes('TimeSpan'),
    );
  }
});

test('queryRefusalText puts QUERY_REFUSAL_LEAD in front of the failure text', () => {
  assert.equal(queryRefusalText('x'), QUERY_REFUSAL_LEAD + 'x');
  assert.equal(QUERY_REFUSAL_LEAD, 'the code evaluated but fails when queried, so it would play nothing: ');
});

test('captureQueryTypes keeps the first constructors for good, so a later assignment to the globals changes nothing', () => {
  const missing = { State: undefined, TimeSpan: undefined };
  const first = captureQueryTypes(missing, { State: FakeState, TimeSpan: FakeTimeSpan });
  assert.equal(first.State, FakeState);
  assert.equal(first.TimeSpan, FakeTimeSpan);
  const replaced = captureQueryTypes(first, { State: () => {}, TimeSpan: 'overwritten' });
  assert.equal(replaced.State, FakeState);
  assert.equal(replaced.TimeSpan, FakeTimeSpan);
});

test('captureQueryTypes keeps asking the globals while either constructor is missing, so queryFailure can refuse loudly', () => {
  const missing = { State: undefined, TimeSpan: undefined };
  const partial = captureQueryTypes(missing, { State: FakeState, TimeSpan: undefined });
  assert.equal(partial.TimeSpan, undefined);
  assert.throws(() => queryFailure(patternReturning([]), { ...partial, from: 0 }), /^Error: Moontide:/);
  const later = captureQueryTypes(partial, { State: FakeState, TimeSpan: FakeTimeSpan });
  assert.equal(later.TimeSpan, FakeTimeSpan);
});

function fakeScheduler() {
  const taken = [];
  return {
    taken,
    cps: 0.5,
    now: () => 0,
    setPattern(pattern, autostart) {
      taken.push({ pattern, autostart });
    },
  };
}

// A scheduler query scope that records the error texts it reports.
function newScope() {
  const errors = [];
  return { errors, scope: createSchedulerQueryScope({ getTypes: () => constructors, onError: (text) => errors.push(text) }) };
}

function countingErrors() {
  return { resets: 0, reset() { this.resets += 1; } };
}

test('installQueryCheck resets the once-per-change guard when a pattern takes over, never for a refused one', () => {
  const scheduler = fakeScheduler();
  const queryErrors = countingErrors();
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors, schedulerQueries: newScope().scope });
  scheduler.setPattern(patternReturning([]), true);
  assert.equal(queryErrors.resets, 1);
  assert.equal(scheduler.taken.length, 1);
  assert.equal(scheduler.taken[0].autostart, true);
  assert.throws(() => scheduler.setPattern(patternThrowing(new Error('boom')), true), (err) => err.message === queryRefusalText('boom'));
  assert.equal(queryErrors.resets, 1, 'a refused change leaves the guard alone');
  assert.equal(scheduler.taken.length, 1, 'a refused pattern never reaches the scheduler');
});

test('installQueryCheck resets the guard before the scheduler gets the pattern', () => {
  const scheduler = fakeScheduler();
  const order = [];
  const original = scheduler.setPattern;
  scheduler.setPattern = function (...args) {
    order.push('takeover');
    return original.apply(this, args);
  };
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: { reset: () => order.push('reset') }, schedulerQueries: newScope().scope });
  scheduler.setPattern(patternReturning([]));
  assert.deepEqual(order, ['reset', 'takeover']);
});

test('installQueryCheck passes a value that is not a pattern straight through, as a new change', () => {
  const scheduler = fakeScheduler();
  const queryErrors = countingErrors();
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors, schedulerQueries: newScope().scope });
  scheduler.setPattern(undefined, false);
  assert.equal(queryErrors.resets, 1);
  assert.equal(scheduler.taken.length, 1);
});

test('installQueryCheck refuses loudly while the constructors are missing, and a scheduler with no setPattern is a loud error', () => {
  const scheduler = fakeScheduler();
  const queryErrors = countingErrors();
  installQueryCheck(scheduler, { getTypes: () => ({ State: undefined, TimeSpan: undefined }), queryErrors, schedulerQueries: newScope().scope });
  assert.throws(() => scheduler.setPattern(patternReturning([])), /^Error: Moontide:/);
  assert.equal(queryErrors.resets, 0);
  assert.throws(() => installQueryCheck({}, { getTypes: () => constructors, queryErrors, schedulerQueries: newScope().scope }), /no setPattern function/);
});

// A pattern like Strudel's: queryArc catches a failing query, logs it (here: records the text) and returns [].
// `query` throws while `failing` is set.
function strudelLikePattern(logs) {
  return {
    failing: true,
    query(state) {
      if (this.failing) throw new Error('cannot parse as numeral: "a2"');
      return [{ span: state.span }];
    },
    queryArc(begin, end, controls = {}) {
      try {
        return this.query(new FakeState(new FakeTimeSpan(begin, end), controls));
      } catch (err) {
        logs.push(`[query] error: ${err.message}`);
        return [];
      }
    },
  };
}

test('the scheduler query scope reports a failing query that carries a cyclist control straight to onError, and returns no events', () => {
  const { scope, errors } = newScope();
  const logs = [];
  const pattern = strudelLikePattern(logs);
  scope.wrap(pattern);
  assert.deepEqual(pattern.queryArc(0, 1, { _cps: 0.5, cyclist: 'cyclist' }), []);
  assert.deepEqual(pattern.queryArc(0, 1, { _cps: 0.5, cyclist: 'neocyclist' }), []);
  assert.deepEqual(errors, ['[query] error: cannot parse as numeral: "a2"', '[query] error: cannot parse as numeral: "a2"']);
  assert.deepEqual(logs, [], 'the scheduler query no longer goes through the bundle log, whose debounce could hide it');
});

test('a query without a cyclist control (the Drawer, the Timeline) keeps the bundle queryArc and reports nothing to onError', () => {
  const { scope, errors } = newScope();
  const logs = [];
  const pattern = strudelLikePattern(logs);
  scope.wrap(pattern);
  pattern.queryArc(0, 1);
  pattern.queryArc(0, 1, {});
  pattern.queryArc(0, 1, { _cps: 1 });
  assert.deepEqual(errors, [], 'a page query that fails first cannot hide or replace the scheduler report');
  assert.equal(logs.length, 3);
});

test('the scheduler query scope reports a thrown non-Error as its String value', () => {
  const { scope, errors } = newScope();
  const pattern = { query: () => { throw 'boom'; }, queryArc: () => [] };
  scope.wrap(pattern);
  assert.deepEqual(pattern.queryArc(0, 1, { cyclist: 'cyclist' }), []);
  assert.deepEqual(errors, ['[query] error: boom']);
});

test('the scheduler query scope passes arguments, this and the result through when the query succeeds', () => {
  const { scope, errors } = newScope();
  let seen = null;
  const pattern = {
    marker: 'me',
    query(state) {
      seen = { begin: state.span.begin, end: state.span.end, controls: state.controls, self: this.marker };
      return ['hap'];
    },
    queryArc: () => [],
  };
  scope.wrap(pattern);
  assert.deepEqual(pattern.queryArc(1, 2, { cyclist: 'cyclist' }), ['hap']);
  assert.deepEqual(seen, { begin: 1, end: 2, controls: { cyclist: 'cyclist' }, self: 'me' });
  assert.deepEqual(errors, []);
});

test('wrapping the same pattern twice does not stack wrappers, and a pattern with no queryArc is a loud error', () => {
  const { scope } = newScope();
  const pattern = { queryArc: () => [] };
  scope.wrap(pattern);
  const once = pattern.queryArc;
  scope.wrap(pattern);
  assert.equal(pattern.queryArc, once);
  assert.throws(() => scope.wrap({ query: () => [] }), /no queryArc function/);
});

test('installQueryCheck wraps the pattern that takes over, and a refused pattern is left alone', () => {
  const scheduler = fakeScheduler();
  const { scope, errors } = newScope();
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: scope });
  const logs = [];
  const taken = strudelLikePattern(logs);
  taken.failing = false;
  scheduler.setPattern(taken, true);
  taken.failing = true;
  taken.queryArc(0, 1, { cyclist: 'cyclist' });
  taken.queryArc(0, 1);
  assert.deepEqual(errors, ['[query] error: cannot parse as numeral: "a2"']);
  assert.equal(logs.length, 1);
  const refused = { query: () => { throw new Error('no'); }, queryArc: () => [] };
  const before = refused.queryArc;
  assert.throws(() => scheduler.setPattern(refused, true), /no/);
  assert.equal(refused.queryArc, before);
});

// The takeover seam. A pattern that records the states it is queried with.
function recordingPattern() {
  const states = [];
  return { states, query: (state) => { states.push(state); return []; }, queryArc: () => [] };
}

// A fake takeover that records its calls; plan() answers `deferral` and arm() returns a marker gate.
function fakeTakeover(deferral) {
  const calls = [];
  const gate = { marker: 'gate', query: () => [], queryArc: () => [] };
  return {
    calls,
    gate,
    plan() {
      calls.push(['plan']);
      return deferral;
    },
    arm(args) {
      calls.push(['arm', args]);
      return gate;
    },
    settleReached() {
      calls.push(['settleReached']);
    },
    replaceForImmediate() {
      calls.push(['replaceForImmediate']);
    },
  };
}

function wrapSpy() {
  const wrapped = [];
  return { wrapped, wrap: (pattern) => wrapped.push(pattern) };
}

test('installQueryCheck with a deferral checks the new pattern over [line, line + 1] with _cps and no cyclist control', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover({ boundary: 12 });
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover });
  const pattern = recordingPattern();
  scheduler.setPattern(pattern, true);
  assert.equal(pattern.states.length, 1);
  const [state] = pattern.states;
  assert.equal(state.span.begin, 12);
  assert.equal(state.span.end, 13);
  assert.deepEqual(state.controls, { _cps: 0.5 });
  assert.equal('cyclist' in state.controls, false);
});

test('installQueryCheck with a deferral hands the gate to the scheduler and wraps the new pattern and the gate, with the reset at the line', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover({ boundary: 12 });
  const queryErrors = countingErrors();
  const schedulerQueries = wrapSpy();
  installQueryCheck(scheduler, {
    getTypes: () => constructors,
    queryErrors,
    schedulerQueries,
    takeover,
    getPlayingCode: () => 'the playing code',
  });
  const pattern = recordingPattern();
  scheduler.setPattern(pattern, true);
  assert.equal(scheduler.taken.length, 1);
  assert.equal(scheduler.taken[0].pattern, takeover.gate, 'the scheduler plays the gate, not the new pattern');
  assert.equal(scheduler.taken[0].autostart, true);
  assert.deepEqual(schedulerQueries.wrapped, [pattern, takeover.gate], 'the new pattern is wrapped before arm, then the gate');
  const armCall = takeover.calls.find(([name]) => name === 'arm');
  const names = takeover.calls.map(([name]) => name);
  assert.ok(names.indexOf('settleReached') !== -1 && names.indexOf('settleReached') < names.indexOf('arm'), 'a reached change is settled before the new gate is built');
  assert.equal(armCall[1].boundary, 12);
  assert.equal(armCall[1].pattern, pattern);
  assert.equal(armCall[1].playingCode, 'the playing code');
  assert.equal(takeover.calls.some(([name]) => name === 'replaceForImmediate'), false);
  assert.equal(queryErrors.resets, 0, 'the guard is not reset at the request');
  armCall[1].onReached();
  assert.equal(queryErrors.resets, 1, 'the guard resets when the gate first queries past the line');
});

test('installQueryCheck with a deferral refuses a failing pattern before arming anything', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover({ boundary: 12 });
  const queryErrors = countingErrors();
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors, schedulerQueries: wrapSpy(), takeover });
  assert.throws(() => scheduler.setPattern(patternThrowing(new Error('boom')), true), (err) => err.message === queryRefusalText('boom'));
  assert.equal(takeover.calls.some(([name]) => name === 'arm'), false);
  assert.equal(takeover.calls.some(([name]) => name === 'replaceForImmediate'), false, 'a waiting change is left untouched');
  assert.equal(scheduler.taken.length, 0);
  assert.equal(queryErrors.resets, 0);
});

test('installQueryCheck without a deferral replaces a waiting change, then behaves as before from the clamped now', () => {
  const scheduler = fakeScheduler();
  scheduler.now = () => 7;
  const takeover = fakeTakeover(null);
  const queryErrors = countingErrors();
  const schedulerQueries = wrapSpy();
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors, schedulerQueries, takeover });
  const pattern = recordingPattern();
  scheduler.setPattern(pattern, false);
  assert.equal(takeover.calls.filter(([name]) => name === 'replaceForImmediate').length, 1);
  assert.equal(takeover.calls.some(([name]) => name === 'arm'), false);
  assert.equal(pattern.states[0].span.begin, 7);
  assert.equal(pattern.states[0].span.end, 8);
  assert.deepEqual(schedulerQueries.wrapped, [pattern]);
  assert.equal(queryErrors.resets, 1);
  assert.equal(scheduler.taken[0].pattern, pattern);
  assert.equal(scheduler.taken[0].autostart, false);
});

test('installQueryCheck replaces a waiting change only after the scheduler took the new pattern, and keeps it when that throws', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover(null);
  const order = [];
  const original = scheduler.setPattern;
  scheduler.setPattern = function (...args) {
    order.push('install');
    return original.apply(this, args);
  };
  const realReplace = takeover.replaceForImmediate;
  takeover.replaceForImmediate = () => {
    order.push('replace');
    realReplace();
  };
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover });
  scheduler.setPattern(recordingPattern(), true);
  assert.deepEqual(order, ['install', 'replace']);

  const failing = fakeScheduler();
  failing.setPattern = () => {
    throw new Error('install broke');
  };
  const kept = fakeTakeover(null);
  installQueryCheck(failing, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover: kept });
  assert.throws(() => failing.setPattern(recordingPattern(), true), /install broke/);
  assert.equal(kept.calls.some(([name]) => name === 'replaceForImmediate'), false, 'the waiting change stays');
});

test('installQueryCheck settles a change that already plays before the new pattern is installed', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover(null);
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover });
  scheduler.setPattern(recordingPattern(), true);
  const names = takeover.calls.map(([name]) => name);
  assert.deepEqual(names.filter((name) => name !== 'plan'), ['settleReached', 'replaceForImmediate']);
});

test('installQueryCheck waits for an asynchronous original setPattern before it replaces a waiting change', async () => {
  const scheduler = fakeScheduler();
  let release;
  scheduler.setPattern = () => new Promise((resolve) => (release = resolve));
  const takeover = fakeTakeover(null);
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover });
  const result = scheduler.setPattern(recordingPattern(), true);
  assert.equal(takeover.calls.some(([name]) => name === 'replaceForImmediate'), false);
  release('done');
  assert.equal(await result, 'done');
  assert.equal(takeover.calls.filter(([name]) => name === 'replaceForImmediate').length, 1);
});

test('installQueryCheck without a deferral keeps a waiting change when the pattern is refused', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover(null);
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover });
  assert.throws(() => scheduler.setPattern(patternThrowing(new Error('boom'))), /fails when queried/);
  assert.equal(takeover.calls.some(([name]) => name === 'replaceForImmediate'), false);
});

test('installQueryCheck with a takeover replaces a waiting change when the value is not a pattern', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover({ boundary: 12 });
  installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors: countingErrors(), schedulerQueries: wrapSpy(), takeover });
  scheduler.setPattern(undefined, false);
  assert.equal(takeover.calls.filter(([name]) => name === 'replaceForImmediate').length, 1);
  assert.equal(scheduler.taken.length, 1);
});

test('a scheduler query (cyclist control) calls onSchedulerQuery once, before the query; a page query does not', () => {
  const calls = [];
  const logs = [];
  const scope = createSchedulerQueryScope({
    getTypes: () => constructors,
    onError: () => {},
    onSchedulerQuery: () => calls.push('hook'),
  });
  const pattern = strudelLikePattern(logs);
  pattern.failing = false;
  const original = pattern.query;
  pattern.query = function (state) {
    calls.push('query');
    return original.call(this, state);
  };
  scope.wrap(pattern);
  pattern.queryArc(0, 1, { _cps: 0.5, cyclist: 'cyclist' });
  assert.deepEqual(calls, ['hook', 'query']);
  calls.length = 0;
  pattern.queryArc(0, 1);
  pattern.queryArc(0, 1, {});
  pattern.queryArc(0, 1, { _cps: 1 });
  assert.deepEqual(calls.filter((entry) => entry === 'hook'), [], 'a page query is not the scheduler');
});

test('a throwing onSchedulerQuery leaves the events of the query intact and logs one line', () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const scope = createSchedulerQueryScope({
      getTypes: () => constructors,
      onError: () => {},
      onSchedulerQuery: () => {
        throw new Error('hook failed');
      },
    });
    const pattern = strudelLikePattern([]);
    pattern.failing = false;
    scope.wrap(pattern);
    const events = pattern.queryArc(0, 1, { _cps: 0.5, cyclist: 'cyclist' });
    assert.equal(events.length, 1, 'the scheduler still gets the events of its query');
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('Moontide:'));
});

test('installQueryCheck: a refuse that returns a text throws it before the pattern is checked, before plan and before anything is armed or installed', () => {
  const scheduler = fakeScheduler();
  const takeover = fakeTakeover({ boundary: 12 });
  const queryErrors = countingErrors();
  const schedulerQueries = wrapSpy();
  installQueryCheck(scheduler, {
    getTypes: () => constructors,
    queryErrors,
    schedulerQueries,
    takeover,
    refuse: () => 'a refusal text',
  });
  const pattern = recordingPattern();
  assert.throws(() => scheduler.setPattern(pattern, true), (err) => err instanceof Error && err.message === 'a refusal text');
  assert.equal(pattern.states.length, 0, 'the pattern was not even queried');
  assert.deepEqual(takeover.calls, [], 'no plan, no settle, no arm and no replace');
  assert.deepEqual(schedulerQueries.wrapped, []);
  assert.equal(scheduler.taken.length, 0);
  assert.equal(queryErrors.resets, 0);
  // A value that is not a pattern is refused too.
  assert.throws(() => scheduler.setPattern(undefined, true), /a refusal text/);
  assert.equal(scheduler.taken.length, 0);
});

test('installQueryCheck: a refuse that returns null changes nothing, and so does leaving the option out', () => {
  for (const refuse of [() => null, undefined]) {
    const scheduler = fakeScheduler();
    const queryErrors = countingErrors();
    installQueryCheck(scheduler, { getTypes: () => constructors, queryErrors, schedulerQueries: newScope().scope, refuse });
    scheduler.setPattern(patternReturning([]), true);
    assert.equal(scheduler.taken.length, 1);
    assert.equal(queryErrors.resets, 1);
  }
});

test('installQueryCheck: refuse is asked for every value handed over, in order, once each', () => {
  const scheduler = fakeScheduler();
  let asked = 0;
  installQueryCheck(scheduler, {
    getTypes: () => constructors,
    queryErrors: countingErrors(),
    schedulerQueries: newScope().scope,
    refuse: () => {
      asked += 1;
      return null;
    },
  });
  scheduler.setPattern(patternReturning([]), true);
  scheduler.setPattern(undefined, true);
  assert.equal(asked, 2);
});
