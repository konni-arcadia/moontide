// Pure pre-takeover query check for Moontide's browser page.
// No DOM access at import time, so this module can be imported directly by node:test
// and by page/main.js without a build step.

// Code can evaluate fine and still fail every time Strudel queries it (the pattern
// throws inside query), which plays nothing while the old music is already gone. The page
// test-queries a new pattern before it takes over; this is the start of the refusal text.
export const QUERY_REFUSAL_LEAD = 'the code evaluated but fails when queried, so it would play nothing: ';

/** The refusal text for a query failure: QUERY_REFUSAL_LEAD followed by the failure text. */
export function queryRefusalText(failure) {
  return QUERY_REFUSAL_LEAD + failure;
}

/**
 * Null when `pattern` can be queried over the cycle window [from, from + 1], or the
 * failure text (the Error message, or String(value) for a thrown non-Error). An empty result is not
 * a failure: silence is allowed. It calls `query`, never `queryArc`: queryArc catches the error,
 * logs it and returns [], which would hide exactly the failure this check looks for. `State` and
 * `TimeSpan` are injected (the caller passes the constructors it captured) so node:test can pass fakes.
 * When either is not a function the pinned Strudel is not what this page expects, so this throws a
 * `Moontide:` Error and the evaluation is refused: the check never skips silently. A finite positive
 * `cps` is passed as the query's `_cps` control, like the scheduler's own query (which also passes
 * `cyclist`; that one is left out on purpose, because it turns on `timeline`'s stateful anchoring).
 */
export function queryFailure(pattern, { State, TimeSpan, from, cps }) {
  if (typeof State !== 'function' || typeof TimeSpan !== 'function') {
    throw new Error(
      'Moontide: the pinned Strudel has no State or TimeSpan constructor, so the code cannot be test-queried before it plays.',
    );
  }
  try {
    const controls = Number.isFinite(cps) && cps > 0 ? { _cps: cps } : undefined;
    pattern.query(new State(new TimeSpan(from, from + 1), controls));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The State and TimeSpan constructors the check uses. User code runs in the page's global
 * realm, so an assignment such as `State = ...` in a hand edit would otherwise replace them for every
 * later check. The page calls this at the start of every evaluation, before the user code runs: once
 * both are functions they are kept for good; until then the current globals are returned, and
 * queryFailure refuses loudly when they are still missing.
 */
export function captureQueryTypes(kept, globals) {
  if (typeof kept.State === 'function' && typeof kept.TimeSpan === 'function') return kept;
  return { State: globals.State, TimeSpan: globals.TimeSpan };
}

/**
 * Replaces `scheduler.setPattern` with a version that test-queries the pattern over
 * the next cycle window and throws the refusal text on a failure. The repl's evaluate ends in
 * `await scheduler.setPattern(pattern, autostart)` inside its own try/catch (pinned @strudel/repl 1.3.0
 * bundle, same call through the property), just before it records the new pattern and activeCode. The
 * throw lands in that catch, so the previous pattern keeps playing, the evaluation error is recorded and
 * the update events fire. Ctrl+Enter, the hello replay, the Mixer and a part launch all pass here too,
 * so a hand evaluation follows the same rule. Checking after evaluate returns would be too late: the
 * failing pattern would already be the scheduler's pattern. `getTypes()` gives { State, TimeSpan } and
 * `queryErrors` is the once-per-change guard of the forwarded query errors: it is reset here, when a
 * pattern takes over and never for a refused one. A pattern that takes over is wrapped by
 * `schedulerQueries` (createSchedulerQueryScope) so the page hears the scheduler's own query errors.
 *
 * With a `takeover` (page/takeover.js createTakeover), `takeover.plan()` says whether this change
 * waits for a cycle line. Both paths refuse before any state changes, so a failing check leaves a waiting
 * change untouched:
 * - Immediate (plan() is null): the window starts at the clamped now, the pattern is wrapped, the guard is reset and
 *   the pattern goes to the original setPattern, exactly as without a takeover. A waiting change whose gate already
 *   passed its line plays and is finished first (`takeover.settleReached()`); a waiting change is replaced
 *   (`takeover.replaceForImmediate()`) only after the original setPattern returned, so a failing install leaves it.
 * - Timed: the window starts at the line (the first query the scheduler makes of the new pattern is there)
 *   and, like every check, carries no `cyclist` control, so it creates no `.timeline` anchor.
 *   `takeover.arm()` returns the gate (old pattern before the line, new pattern from it); the new pattern is
 *   wrapped too, before arm, so a cancel that hands it back to the scheduler (Stop, a lost role, an unload) leaves
 *   a pattern that reports its own scheduler query errors; inside the gate it is queried with `query`, so its
 *   wrapper stays idle there and nothing is reported twice. The gate is wrapped and handed to the original
 *   setPattern. The guard is not reset now: arm() calls the given
 *   `onReached` when the gate first queries past the line, because the old music that keeps playing must
 *   not have its errors forwarded a second time and the new pattern's first errors must still count.
 *   `getPlayingCode()` gives the code that plays now, for the waiting record.
 */
export function installQueryCheck(scheduler, { getTypes, queryErrors, schedulerQueries, takeover, getPlayingCode }) {
  const originalSetPattern = scheduler.setPattern;
  if (typeof originalSetPattern !== 'function') {
    throw new Error('Moontide: the scheduler of the pinned @strudel/repl 1.3.0 has no setPattern function.');
  }
  // Hands `value` to the scheduler. A waiting change is replaced only after that succeeded (when the original throws,
  // the old music and the waiting change stay as they were); one whose gate already passed its line plays, so it is
  // finished before the new pattern is installed.
  function install(self, value, autostart) {
    if (takeover) takeover.settleReached();
    const result = originalSetPattern.call(self, value, autostart);
    if (!takeover) return result;
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      return result.then((resolved) => {
        takeover.replaceForImmediate();
        return resolved;
      });
    }
    takeover.replaceForImmediate();
    return result;
  }
  scheduler.setPattern = function (pattern, autostart) {
    // The repl's own handling of a value that is not a pattern stays as before (a waiting change is replaced too).
    if (pattern === null || pattern === undefined || typeof pattern.query !== 'function') {
      queryErrors.reset();
      return install(this, pattern, autostart);
    }
    // A throw from plan() (no usable frontier or tempo) is not caught: it fails the evaluation too.
    const deferral = takeover ? takeover.plan() : null;
    let from;
    if (deferral !== null) {
      from = deferral.boundary;
    } else {
      const raw = scheduler.now();
      from = Number.isFinite(raw) && raw > 0 ? raw : 0;
    }
    // A throw from queryFailure itself (State or TimeSpan missing) is not caught: it fails the evaluation too.
    const failure = queryFailure(pattern, { ...getTypes(), from, cps: scheduler.cps });
    if (failure !== null) throw new Error(queryRefusalText(failure));
    if (deferral !== null) {
      // A waiting change whose gate already passed its line plays: it is finished first, so the playing code read
      // below and the pattern the new gate is built over are the ones that play.
      takeover.settleReached();
      // The new pattern is wrapped before arm(): after the change finished, arm() hands it out as the pattern that plays,
      // and a cancel (Stop, a lost role, an unload) puts it back in the scheduler. Inside the gate it is queried with
      // `query`, so this wrapper stays idle there. A pattern is never wrapped twice.
      schedulerQueries.wrap(pattern);
      const gate = takeover.arm({
        boundary: deferral.boundary,
        pattern,
        playingCode: typeof getPlayingCode === 'function' ? getPlayingCode() : '',
        onReached: () => queryErrors.reset(),
      });
      schedulerQueries.wrap(gate);
      return originalSetPattern.call(this, gate, autostart);
    }
    schedulerQueries.wrap(pattern);
    queryErrors.reset();
    return install(this, pattern, autostart);
  };
}

/**
 * Reports a failing query of the scheduler itself, and only that one. The pinned bundle's
 * `queryArc` catches a failing query and logs `[query] error:` for any caller, and the page queries
 * patterns outside playback too (the Timeline, the Drawer's lookahead, the MIDI stop sweep), so a log
 * line cannot say that the music fails. Worse, Strudel drops a log text that equals the last one
 * dispatched within a second, so a page query that logs first would swallow the scheduler's own report.
 * The scheduler's own query always carries a `cyclist` control; `wrap(pattern)` makes the pattern run
 * those queries itself (the same `query` call as the bundle's `queryArc`) and hand a failure straight
 * to `onError` as the bundle's log text (`[query] error: <message>`), then return no events as the
 * bundle does. Every other query keeps the bundle's own `queryArc`, whose log the page ignores.
 * `getTypes()` gives { State, TimeSpan }.
 */
export function createSchedulerQueryScope({ getTypes, onError }) {
  const wrapped = new WeakSet();
  return {
    wrap(pattern) {
      if (wrapped.has(pattern)) return;
      const original = pattern.queryArc;
      if (typeof original !== 'function') {
        throw new Error('Moontide: the pattern has no queryArc function, so the scheduler cannot play it.');
      }
      wrapped.add(pattern);
      pattern.queryArc = function (begin, end, controls) {
        if (controls === null || typeof controls !== 'object' || typeof controls.cyclist !== 'string') {
          return original.call(this, begin, end, controls);
        }
        const { State, TimeSpan } = getTypes();
        try {
          return this.query(new State(new TimeSpan(begin, end), controls));
        } catch (err) {
          onError(`[query] error: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      };
    },
  };
}
