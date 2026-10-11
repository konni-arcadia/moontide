// Keeps the tempo of the music that plays when an evaluation fails. No DOM access at
// import time, so node:test can import it.

// The repl's evaluate runs the whole program, then hands the pattern to scheduler.setPattern. A top-level
// setcps(n) / setcpm(n) therefore calls scheduler.setCps before the new pattern is checked and taken over.
// When the evaluation then fails (an eval error, or the query check refusing the pattern) the previous
// pattern keeps playing, and without this guard it would keep playing at the tempo of the refused code.
// The guard watches setCps during one evaluation and puts the previous tempo back when it fails.
//
// A change that waits for a bar or phrase line must not touch the music that still plays, so its
// tempo is held back too: `end(false, { hold: true })` takes the program's tempo back right after the
// program ran and returns it, and `apply(cps)` sets it at the line.
//
// Known window: the new tempo is forwarded at once and restored only after the evaluation ends, so a
// program that awaits something after its setcps line (a sample load, for example) lets the old
// music play at the new tempo meanwhile (a refused program, and now every waiting change), and the restore
// re-anchors from the shifted position, so a small phase jump can remain. Deferring the forward until the
// pattern takes over would break code that reads the new tempo in the same program (cpm reads
// scheduler.cps while it builds the pattern).

/**
 * Wraps `scheduler.setCps`. Call `begin()` before an evaluation and `end(failed, { hold })` after it: when
 * `failed` is true, or `hold` is true, and the evaluation changed the tempo, the tempo from before it is
 * asked of the scheduler again. `end` returns `{ requested }`: the tempo the program asked for (the
 * scheduler's cps read before any restore), or undefined when it failed or never called `setCps`.
 * `apply(cps)` sets a tempo through the raw setter without touching an open evaluation's requested value; the applied
 * tempo becomes the tempo that evaluation restores on a failure or a hold, and an immediate success whose program set
 * its own tempo before the apply keeps the program's tempo.
 * Evaluations must not overlap (the page serializes them). The tempo from before is the scheduler's own
 * `cps` when the evaluation begins, because that is the tempo that plays: the page's scheduler is the
 * pinned Cyclist, whose `setCps` takes effect at once, and whose tick also sets `cps` itself when a hap
 * carries a `cps` control, a change that never went through `setCps`.
 */
export function createTempoGuard(scheduler) {
  const originalSetCps = scheduler.setCps;
  if (typeof originalSetCps !== 'function') {
    throw new Error('Moontide: the scheduler of the pinned @strudel/repl 1.3.0 has no setCps function.');
  }
  if (typeof scheduler.cps !== 'number') {
    throw new Error('Moontide: the scheduler of the pinned @strudel/repl 1.3.0 has no numeric cps, so the tempo that plays cannot be read.');
  }
  let open = null; // { before, requested } while an evaluation runs; requested stays undefined until setCps is called
  scheduler.setCps = function (cps) {
    if (open !== null) open.requested = cps;
    return originalSetCps.call(this, cps);
  };
  return {
    begin() {
      open = { before: scheduler.cps, requested: undefined };
    },
    end(failed, { hold = false } = {}) {
      const finished = open;
      open = null;
      if (finished === null || finished.requested === undefined) return { requested: undefined };
      // The tempo the program asked for is read before any restore; it also covers a tempo set another way.
      // An apply during the evaluation is not the program's own tempo, so then the last setCps value stands.
      const requested = failed ? undefined : finished.applied ? finished.requested : scheduler.cps;
      // `before` is the tempo that plays when the evaluation ends: an apply during it (a waiting change reaching its
      // line) moved it to the applied tempo, so a failed or held evaluation restores that one, never the older one.
      if (failed || hold) originalSetCps.call(scheduler, finished.before);
      // An immediate success whose program set its own tempo before an apply: the program's tempo is the one that
      // plays and the one the reply reports, so it is put back over the applied one.
      else if (finished.applied && scheduler.cps !== finished.requested) originalSetCps.call(scheduler, finished.requested);
      return { requested };
    },
    /**
     * The tempo that plays: while an evaluation is open the scheduler's cps already holds the tempo the program set
     * (a top-level setcps ran before the pattern is handed over), so it is the tempo from before the evaluation (or
     * the last apply); otherwise it is the scheduler's own cps. A timed change measures its line and its lead
     * hook with this one, because the old music, at the old tempo, is what covers the distance to the line.
     */
    playing() {
      return open !== null ? open.before : scheduler.cps;
    },
    apply(cps) {
      if (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0) {
        throw new Error(`Moontide: a tempo to apply must be a finite number above 0, got ${String(cps)}.`);
      }
      // The raw setter, never the wrapped property: an open evaluation's requested value is not touched.
      if (open !== null) {
        open.applied = true;
        open.before = cps;
      }
      originalSetCps.call(scheduler, cps);
    },
  };
}
