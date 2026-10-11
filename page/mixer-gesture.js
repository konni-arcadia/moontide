// Pure module for the Mixer view: turns the many moves of one drag into few evaluations and ONE
// history record. While the user drags, each move is heard at once (a throttled live
// evaluation that records nothing); one record is sent 1.5 s after the last move. No DOM and no
// timers of its own: every side effect is injected, so node:test can drive it with a fake clock.
// Imported directly by page/main.js without a build step.

/** Live evaluation happens at most once per this many ms, plus a trailing call. */
export const THROTTLE_MS = 100;

/** A gesture is recorded this many ms after its last move (about 1.5 s). */
export const PAUSE_MS = 1500;

function defaultOnError(error) {
  console.error('Moontide: the last mixer move could not be applied:', error);
}

/**
 * `enqueue(fn)` runs `fn` after every earlier queued job (the page's serial chain) and returns a
 * promise. `applyNow(change)` applies one change immediately and resolves `{ played, code }` or
 * null; it is only ever called from inside a queued job, or from flushDirect (itself called from
 * inside one). `sendRecord(code, label)` sends one record. `onPreviewDropped()` is called once when a gesture that was
 * heard through `preview` ends without anything having played (no release came, or it did not play): the page then
 * puts the instrument back to what the playing code holds. `setTimer(fn, ms)` returns a handle for
 * `clearTimer`; `now()` reads a clock in ms. `onError(error)` reports a change that failed to apply
 * inside flushDirect (default: console.error), where a throw would swallow the job that called it. `isHeld()` says
 * whether the user still holds a MIDI control with the pointer: a previewed gesture whose pause ends while it is
 * held stays open (the user is listening at that value), so the instrument is not put back under the thumb.
 *
 * Returns `{ move, release, preview, discrete, flush, flushDirect, flushNow, hasPending }`. `preview(controlKey, label)`
 * keeps a gesture open and restarts its pause without any evaluation: a MIDI control is heard by a CC the page sends
 * itself while it is dragged, and only its release (`release`) rewrites the code.
 */
export function createGestureRecorder({ enqueue, applyNow, sendRecord, setTimer, clearTimer, now, onError = defaultOnError, onPreviewDropped = () => {}, isHeld = () => false, throttleMs = THROTTLE_MS, pauseMs = PAUSE_MS }) {
  // The one open gesture (still being dragged, or waiting out the pause), or null.
  let open = null;
  // Gestures taken by flush() whose queued finalize job has not run yet.
  const unrecorded = new Set();

  function newGesture(controlKey, label) {
    return { controlKey, label, lastPlayedCode: null, lastPlayedLabel: null, lastTickAt: null, trailing: null, trailingTimer: null, pauseTimer: null, dropped: false, recorded: false, previewed: false };
  }

  function clearTimers(gesture) {
    if (gesture.trailingTimer !== null) clearTimer(gesture.trailingTimer);
    if (gesture.pauseTimer !== null) clearTimer(gesture.pauseTimer);
    gesture.trailingTimer = null;
    gesture.pauseTimer = null;
  }

  /** Sends the record exactly once, and only when something played. The label is the one of the
   * change that played last, so a record never names a value its code does not hold. */
  function finalize(gesture) {
    if (gesture.recorded) return;
    gesture.recorded = true;
    unrecorded.delete(gesture);
    if (gesture.lastPlayedCode !== null) sendRecord(gesture.lastPlayedCode, gesture.lastPlayedLabel);
    else if (gesture.previewed) onPreviewDropped();
  }

  /** Applies `change` and remembers the code it played and the label that goes with it. */
  async function applyAndRemember(gesture, { change, label }) {
    const result = await applyNow(change);
    if (result && result.played) {
      gesture.lastPlayedCode = result.code;
      gesture.lastPlayedLabel = label;
    }
  }

  /** One live evaluation, queued behind every earlier job; skipped once the gesture was dropped. */
  function tick(gesture, step) {
    gesture.lastTickAt = now();
    return enqueue(async () => {
      if (gesture.dropped) return;
      await applyAndRemember(gesture, step);
    });
  }

  function restartPause(gesture) {
    if (gesture.pauseTimer !== null) clearTimer(gesture.pauseTimer);
    gesture.pauseTimer = setTimer(() => {
      gesture.pauseTimer = null;
      if (open !== gesture) return;
      // A previewed MIDI control that is still held is being listened to: wait for its release or for the pointer to leave.
      if (gesture.previewed && gesture.lastPlayedCode === null && isHeld()) restartPause(gesture);
      else void flush();
    }, pauseMs);
  }

  function cancelTrailing(gesture) {
    if (gesture.trailingTimer !== null) clearTimer(gesture.trailingTimer);
    gesture.trailingTimer = null;
    gesture.trailing = null;
  }

  /** A different control than the open gesture's ends that gesture first; then the open one is returned. */
  function prelude(controlKey, label) {
    if (open && open.controlKey !== controlKey) void flush();
    if (!open) open = newGesture(controlKey, label);
    open.label = label;
    return open;
  }

  function move(controlKey, change, label) {
    const gesture = prelude(controlKey, label);
    const t = now();
    if (gesture.lastTickAt === null || t - gesture.lastTickAt >= throttleMs) {
      cancelTrailing(gesture);
      tick(gesture, { change, label });
    } else {
      gesture.trailing = { change, label };
      if (gesture.trailingTimer === null) {
        gesture.trailingTimer = setTimer(() => {
          gesture.trailingTimer = null;
          const trailing = gesture.trailing;
          gesture.trailing = null;
          if (trailing && !gesture.dropped && !gesture.recorded) tick(gesture, trailing);
        }, throttleMs - (t - gesture.lastTickAt));
      }
    }
    restartPause(gesture);
  }

  function release(controlKey, change, label) {
    const gesture = prelude(controlKey, label);
    cancelTrailing(gesture);
    tick(gesture, { change, label });
    restartPause(gesture);
  }

  /** A move that is heard some other way (a MIDI preview): the gesture stays open and its pause restarts, with no evaluation. */
  function preview(controlKey, label) {
    const gesture = prelude(controlKey, label);
    gesture.previewed = true;
    restartPause(gesture);
  }

  /** Ends the open gesture: its trailing change is applied, then its record is sent, in queue order. */
  function flush() {
    const gesture = open;
    if (!gesture) return Promise.resolve();
    open = null;
    clearTimers(gesture);
    unrecorded.add(gesture);
    return enqueue(async () => {
      if (gesture.recorded) return;
      const trailing = gesture.trailing;
      gesture.trailing = null;
      if (trailing) await applyAndRemember(gesture, trailing);
      finalize(gesture);
    });
  }

  /** A one-shot action: ends any open gesture first, then applies and records at once. */
  function discrete(change, label) {
    void flush();
    return enqueue(async () => {
      const result = await applyNow(change);
      if (result && result.played) sendRecord(result.code, label);
    });
  }

  /**
   * Records every pending gesture now, from inside a queued job (Claude's evaluate, the hello
   * replay): the open gesture's trailing change is applied directly first, so the record equals
   * the code that played, and ticks still queued behind the current job do nothing. The gesture
   * is recorded before the new code applies.
   */
  async function flushDirect() {
    const gestures = [...unrecorded];
    if (open) gestures.push(open);
    open = null;
    for (const gesture of gestures) {
      gesture.dropped = true;
      clearTimers(gesture);
      const trailing = gesture.trailing;
      gesture.trailing = null;
      try {
        if (trailing && !gesture.recorded) await applyAndRemember(gesture, trailing);
      } catch (error) {
        // Claude's evaluate (or the replay, or the part launch) runs right after this: a mixer move
        // that cannot be applied must be reported, but never stop that job or the other gestures.
        onError(error);
      } finally {
        finalize(gesture);
      }
    }
  }

  /** Like flushDirect but synchronous and without applying a trailing change: pagehide, and the
   * start of a hand evaluation (the gesture must be recorded before the hand edit is reported). */
  function flushNow() {
    const gestures = [...unrecorded];
    if (open) gestures.push(open);
    open = null;
    for (const gesture of gestures) {
      gesture.dropped = true;
      clearTimers(gesture);
      gesture.trailing = null;
      finalize(gesture);
    }
  }

  function hasPending() {
    return open !== null || unrecorded.size > 0;
  }

  return { move, release, preview, discrete, flush, flushDirect, flushNow, hasPending };
}
