# Transitions

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

How one code change can unfold over several cycles instead of landing all at once: sweeps, fades, parts that enter later, sections spread over many cycles, and crossfades. Every technique here is a plain possibility, not a suggestion of when to reach for it — that judgment stays with Claude and the request.

## Keeping a transition running across changes

A transition that should keep running across later changes — a fade, a sweep, a ramp, a delayed entry — is anchored with `.timeline(id)`, never with a bare `getTime()` anchor: every `set_code` runs the whole program again and reads `getTime()` again, so a `getTime()` anchor restarts at each change, even on a line copied unchanged, while a `.timeline(id)` anchor continues as long as the code keeps the same `id`. Inside `.timeline(id)` the signal's `t` counts cycles from the anchor itself, starting at 0, not the absolute cycle count.

`.timeline(id)` on a control's signal — the pattern carrying the transition, as proven live in the page — keeps the anchor it got the first time it played, for as long as the code keeps the same `id`. A later change that copies that line unchanged continues the transition from where it was instead of restarting it, because the anchor itself, not the line of code, is what survives the evaluation.

The anchor lands on a cycle boundary at the change: the start of the cycle the change landed in, or of the next one. Before its own anchor a transition's elapsed time is negative, so clamp its low end with `Math.max(0, ...)`, the same way as below.

One `id` belongs to one transition: two parts sharing the same `id` share one anchor. A new transition needs an `id` not already used since the last Stop or page reload — an `id` keeps its anchor even across a version of the code that does not use it at all, so reusing a number picks up wherever that transition last was. Writing the same number negated (`-id`) starts a fresh anchor for that transition, as if it were a new one; `id` 0 is reserved for the absolute count (see "Time is absolute", below). Stop and a page reload clear every anchor, the same moments that reset the cycle count to 0.

```js
s("bd*4").lpf(signal((t) => Math.max(0, Math.min(1, t / 8))).range(400, 2000).timeline(1))
```

A later change whose code keeps this exact line — same `id` `1` — continues the same sweep from its anchor instead of reopening it.

## Time is absolute

Pattern time is the scheduler's own cycle count: it starts at 0 when playback starts and keeps counting upward across every change — evaluating new code does not reset it. Reloading the page starts the count again from 0, and so does Stop: the page's Stop stops the scheduler, and the next change starts it again from 0. The code itself is evaluated again on the page's reload replay, on `restore_version`, and on a hand evaluation, so anything computed at evaluation time (such as `getTime()`, below) is recomputed at that moment too, not carried over from before. A signal slowed with `.slow(n)` completes one full pass every `n` cycles of this same absolute count, so a change landing mid-count can land in the middle of that pass, not necessarily at its start.

By default, a change takes over at the scheduler's next tick, a fraction of a second after the page evaluates it — not at a cycle boundary. The moment a change lands is the moment the page evaluates it, which is the moment the code in the page editor changes. A change can take over on a bar or phrase line instead (see "Taking over on a bar or phrase line", below). At the default tempo, one cycle lasts 2 seconds at the default 0.5 cycles per second (see "Tempo", below).

## Continuous sweeps

A signal (see reference/functions.md "Signals") driving a control changes it smoothly instead of stepping it.

```js
s("bd*4").lpf(sine.range(400, 2000).slow(8))   // one full sweep every 8 cycles, repeating
```

```js
s("bd*4").lpf(saw.range(400, 2000))   // a ramp that restarts every single cycle instead
```

```js
s("bd*4").lpf(sine.rangex(400, 2000).slow(8))   // rangex: exponential, for a frequency-like sweep
```

## Starting from the moment of the change

`getTime()` reads the current absolute cycle position at the instant it is called; the page sets this time source to the scheduler's own current position right before every evaluation, so a `getTime()` call that runs at evaluation captures that moment once. `signal(fn)` builds a pattern whose value is `fn(currentCyclePosition)` on the same absolute-cycle timeframe, so subtracting a `getTime()` reading from it measures elapsed cycles since that moment.

```js
const sweepStart = getTime()
s("bd*4").lpf(signal((t) => Math.max(0, Math.min(1, (t - sweepStart) / 8))).range(400, 2000))
```

Every `set_code` runs the whole program again, so every `getTime()` anchor restarts at that new evaluation — including one copied unchanged from the code that was already playing (see "When the next change lands", below). Clamping both ends of the ramp with `Math.max(0, ...)` and `Math.min(1, ...)` keeps its value inside range even before its own zero point.

A `getTime()` anchor belongs to one evaluation only; a transition that should keep running across later changes is anchored with `.timeline(id)` instead (see "Keeping a transition running across changes", above).

## Fades

`gain()` (see reference/effects.md "Level and pan") driven by a sweep, or by the anchored ramp above, fades a part in or out.

```js
s("bd*4").gain(signal((t) => Math.max(0, Math.min(1, t / 4))).timeline(2))   // fades in over 4 cycles from its anchor; a later change that keeps id 2 continues it
```

```js
s("bd*4").gain(signal((t) => Math.max(0, Math.min(1, 1 - t / 4))).timeline(3))   // fades out over 4 cycles from its anchor
```

## Parts that enter later

A part can be gated on the cycle count, anchored to the moment of the change or to the absolute count. `mask()` (see reference/functions.md "Structure") mutes a pattern's `false` steps while keeping its own timing.

```js
stack(
  s("bd*4"),
  s("hh*8").mask(signal((t) => t >= 4).timeline(4)),   // silent for 4 cycles from its anchor, then plays; a later change that keeps id 4 keeps this entry point
)
```

Without `.timeline()`, the same gate is anchored only to this one evaluation and restarts on every later change, the same way the ramp in "Starting from the moment of the change" does:

```js
const entryStart = getTime()
s("hh*8").mask(signal((t) => t - entryStart >= 4))   // silent for 4 cycles from this change, then plays; a later change re-reads getTime() and restarts the wait
```

`lastOf(n, fn)` and `firstOf(n, fn)` (see reference/functions.md "Conditions") instead count from the absolute cycle count, not from when the current code was last changed:

```js
s("bd*4").lastOf(4, (x) => x.rev())   // every 4th cycle of the absolute count, not of this change
```

## Sections over many cycles

`arrange()` (see reference/functions.md "Combining patterns") repeats its whole list of parts every total number of cycles — 4 cycles of one part then 4 of another is one 8-cycle repeating unit, not a single pass — counted on the absolute cycle count (see "Time is absolute", above), so it does not start over from the moment of a change; `< >` alternation with `/n` also repeats, in equal-length slices instead of the given lengths.

```js
arrange([4, s("bd*4")], [4, s("bd*2 sd")])   // 4 cycles of one part, then 4 of another, repeating every 8 cycles
```

```js
s("<bd*4 bd*2>/4")   // alternates every 4 cycles, repeating for as long as this code plays
```

`pick(pattern, list)` (see reference/functions.md "Conditions") selects a whole section from a list by a patterned index, for a section order that can itself change over time.

## Crossfades

`xfade(left, envelope, right)` mixes two patterns by an envelope pattern from 0 (all `left`) to 1 (all `right`), confirmed from this bundle's own function text and doc example.

```js
xfade(s("bd*2"), "<0 .25 .5 .75 1>", s("hh*8"))
```

## When the next change lands

`set_code` sends the whole program, and the page evaluates it again from the top. By default, the new pattern replaces the old one at the scheduler's next tick, a fraction of a second later — not at a cycle boundary; `at: 'bar'` and `at: 'phrase'` move the takeover to a line (see "Taking over on a bar or phrase line", below). Every `getTime()` call runs again too, so each `getTime()` anchor restarts, including one on a line copied unchanged from the code that was already playing. A pattern anchored with `.timeline(id)` is different: its anchor continues as long as the new code keeps the same `id` (see "Keeping a transition running across changes", above); a transition that has already finished can also be written as its own end value instead. `restore_version`, a hand evaluation in the page, and the page's own reload replay are evaluations too, with all of the same rules. Stop and a page reload clear every `.timeline(id)` anchor and restart the cycle count at 0.

## Taking over on a bar or phrase line

`set_code` takes `at`: `'now'` (the default, described above), `'bar'` or `'phrase'`. A bar is one cycle. `'bar'` takes over on the next whole cycle after the one in progress; `'phrase'` takes over on the next multiple of the phrase length, which is 4 cycles unless `phraseCycles` gives a whole number from 2 to 64. Lines are counted on the absolute cycle count, which restarts at 0 at every Play (see "Time is absolute", above). `phraseCycles` is accepted only with `at: 'phrase'`.

The line is at least about half a second ahead, measured at the tempo that plays when the change is sent (not at a tempo the new code sets with `setcps` or `setcpm`, which applies at the line); when the next line is closer than that, the change takes over on the line after it. When nothing plays, a change asked for a line starts at once, because Play starts on cycle 0.

The code is evaluated and checked at once. An error or a failing query refuses the change and the old music keeps playing; only the takeover waits. The reply gives the cycle the change takes over at and about how many seconds away it is. Until the line, `get_code`, the history and the version number still show the code that plays.

A newer change replaces a waiting one (last wins), a `restore_version` takes over at once, and Stop cancels the wait. A waiting change that does not take over is reported once in a later tool reply.

Events of the old code that begin before the line sound. Events of the new code begin at the line; a new-code event that began before the line and is still going does not sound, as with any change. A `getTime()` anchor is read when the program runs, which is at the request. A new `.timeline(id)` anchor starts on the line.

A tempo set by the waiting code with `setcps` or `setcpm` applies in the scheduler pass at the line, not before. The first beat of the new bar is exactly on the line; the rest of that bar can be a few ms off for a small tempo change and tens of ms for a large one. A `.cps()` on a pattern changes the tempo when its first event is scheduled.

## Tempo

`setcps(n)` and `setcpm(n)` (or the chained `.cpm(n)`, see reference/functions.md "Tempo") take effect the instant the code is evaluated — each is a single value read once at that moment, not a control that is queried continuously like a signal. In a change that waits for a bar or phrase line, they take effect at the line (see "Taking over on a bar or phrase line", above). Whether tempo itself can follow a continuous signal: this bundle's own `setcps`/`setcpm` accept a plain number, and unwrap a single-value ("pure") pattern into that same plain number if given one, but do not continuously sample a changing signal.

```js
setcpm(120)   // takes effect immediately when this code evaluates, then stays fixed
```
