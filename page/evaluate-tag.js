// The evaluate id that tags the runtime errors of the code that plays, while Claude's evaluation runs. No DOM
// access at import time, so node:test can import it.
//
// handleEvaluate tags the new code from the start of its evaluation (an eager error is raised before the evaluation
// returns) and gives the old tag back when the evaluation fails or only waits for its line. But a waiting change can
// take over INSIDE that evaluation (the newer change settles it before it is installed, or its timer fires), and its
// finisher then says which id plays. While an evaluation is in flight that id must become the tag to give back, never
// the live tag: the live one is the new code's until the evaluation says otherwise.
//
// `read` and `write` are the accessors of the page's one tag variable.

/**
 * `begin(id)` starts an evaluation: it remembers the tag that plays now (the baseline) and tags the new code.
 * `end()` ends it. `fromTakeover(id)` is what a takeover finisher calls: it writes the live tag, except while an
 * evaluation is in flight, where it only moves the baseline. `baseline()` is the tag of the code that plays when the
 * evaluation fails or waits: the one from before it, or the one a takeover inside it set.
 */
export function createEvaluateTag({ read, write }) {
  let inFlight = false;
  let baseline = null;
  return {
    begin(id) {
      baseline = read();
      inFlight = true;
      write(id);
    },
    end() {
      inFlight = false;
    },
    fromTakeover(id) {
      if (inFlight) baseline = id;
      else write(id);
    },
    baseline() {
      return baseline;
    },
  };
}
