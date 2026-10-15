// Which track played a note.
//
// Strudel runs every labeled statement (`name: pattern`) through `Pattern.prototype.p`. This module
// wraps that method so each note of a labeled pattern carries the key of its track, and adds an
// observer that tells every subscriber when such a note is triggered: `{ key, hap, target, stamp }`
// (the hap, the audio time it is due, and for a MIDI note the timestamp its port got, else null).
// It changes no sound and no MIDI message; nothing is drawn here.
//
// Why `p` is an accessor: the repl assigns a brand new `p` at the start of every evaluation, so a
// plain wrapper would be replaced by the first run. The accessor hands out one wrapper for good and
// its setter keeps the repl's newest function, which the wrapper calls. The setter also runs once at
// the start of each evaluation, which is where the count of `$` statements starts again.
//
// Why the observer is not dominant: a trigger that is dominant replaces the browser sound. A track
// that ends in `.midi()` already carries a dominant trigger and one without any plays the browser
// sound; passing `false` keeps whichever the note had. The earlier trigger runs first, so by the time
// the observer runs, `.midi()` has recorded the timestamp its port got and `stampOf` can read it.
//
// Why an outer tag wins: a pattern labeled inside another labeled pattern is tagged twice. The
// outer tag sets the key last, every observer compares the key on the note with its own, and only
// the outer one reports it.

import { labelKey } from './tracks.js';

const subscribers = new Set();

/**
 * Calls `listener(event)` for every note of a labeled track, where event is `{ key, hap, target,
 * stamp }`. The key is the track's Mixer identity, or `$n` for the n-th `$` statement of the
 * evaluation (counted from 0, in code order). Returns the function that stops the calls.
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new Error('Moontide: a note listener must be a function.');
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/**
 * Tags every labeled statement of Strudel's `Pattern` with its track's key and reports each note to
 * the subscribers. `stampOf(hap)` gives the timestamp a MIDI note was sent with, or null. Install
 * it once, at page start, before any code is evaluated; a second install throws.
 */
export function installNoteTag(PatternClass, { stampOf } = {}) {
  const lost = 'so lights cannot learn which track played a note';
  if (typeof PatternClass !== 'function') {
    throw new Error(`Moontide: Strudel's Pattern is not available, ${lost}.`);
  }
  for (const name of ['withHap', 'onTrigger']) {
    if (typeof PatternClass.prototype[name] !== 'function') {
      throw new Error(`Moontide: Strudel's Pattern has no ${name}, ${lost}.`);
    }
  }
  if (typeof stampOf !== 'function') {
    throw new Error(`Moontide: the note tag needs a way to read a note's MIDI timestamp, ${lost}.`);
  }
  if (Object.getOwnPropertyDescriptor(PatternClass.prototype, 'p')?.get) {
    throw new Error("Moontide: the note tag is already installed on Strudel's Pattern.");
  }

  // Undefined at page start: the repl assigns p only when it evaluates code.
  let repl = PatternClass.prototype.p;
  let dollar = 0;
  let errorReported = false;
  // A note reaches one observer per tag; this keeps a pattern tagged twice under one key to one report.
  const reported = new WeakSet();

  function reportOnce(err) {
    if (errorReported) return;
    errorReported = true;
    console.error('Moontide: a note listener or the MIDI timestamp lookup failed; later failures are not repeated:', err);
  }

  function observerFor(key) {
    return function noteObserver(hap, now, cps, target) {
      if (hap === null || typeof hap !== 'object' || hap.context?.noteTrack !== key || reported.has(hap)) return;
      reported.add(hap);
      let stamp = null;
      try {
        const got = stampOf(hap);
        stamp = typeof got === 'number' && Number.isFinite(got) ? got : null;
      } catch (err) {
        reportOnce(err);
      }
      const event = { key, hap, target, stamp };
      for (const listener of [...subscribers]) {
        try {
          listener(event);
        } catch (err) {
          reportOnce(err);
        }
      }
    };
  }

  function tag(pattern, key) {
    return pattern
      .withHap((hap) => hap.setContext({ ...hap.context, noteTrack: key }))
      .onTrigger(observerFor(key), false);
  }

  const wrapper = function taggedP(id) {
    if (typeof repl !== 'function') {
      throw new Error("Moontide: Strudel has not set up labeled tracks yet, so a labeled statement ran before the note tag could reach it.");
    }
    // A label that starts or ends with an underscore is silenced by the repl: nothing to report.
    if (typeof id === 'string' && !id.startsWith('_') && !id.endsWith('_')) {
      const key = id.includes('$') ? `$${dollar++}` : labelKey(id);
      return repl.call(tag(this, key), id);
    }
    return repl.call(this, id);
  };

  Object.defineProperty(PatternClass.prototype, 'p', {
    configurable: true,
    enumerable: true,
    get: () => wrapper,
    set: (fn) => {
      repl = fn;
      dollar = 0;
    },
  });
}
