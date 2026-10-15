# Pattern functions

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

Signatures below use `Pattern` for a value returned by one of these functions; most also exist as chained methods on a `Pattern` (for example `pat.fast(2)` as well as `fast(2, pat)`).

## Sources

- `note(pattern)` — a pattern of pitches (mini-notation note names, scale degrees or numbers).
- `n(pattern)` — a pattern of plain numbers (sample index, scale degree; meaning depends on what it is chained onto).
- `s(pattern)` / `sound(pattern)` — a pattern of sound names (samples or synths); `s` and `sound` are the same function.
- `silence` — a pattern with no events, useful as a placeholder or a `stack()` slot.
- `run(n)` — the numbers `0` to `n - 1`, one per step.
- `irand(n)` — a random whole number pattern between `0` and `n - 1`, re-rolled each cycle.

```js
note("c e g")
n(run(4))
```

## Combining patterns

- `stack(...patterns)` — plays every pattern at once, in the same cycle.
- `cat(...patterns)` / `slowcat(...patterns)` — plays one whole pattern per cycle, cycling through the list (`cat` and `slowcat` are the same function).
- `seq(...patterns)` / `fastcat(...patterns)` — plays each pattern in its own equal slice of one cycle (`seq` and `fastcat` are the same function).
- `arrange(...[cycles, pattern])` — plays each pattern for the given number of cycles, in order, then repeats the whole list every total number of cycles (see reference/transitions.md "Sections over many cycles").
- `arrange` takes patterns: it calls `.fast` on each item without turning it into a pattern, so a single-quoted string item throws when the code is evaluated.
- The page's Parts view and Timeline section row show an `arrange()` call as parts only when each section is a `[length, pattern]` array whose length is a whole number above zero; the length is written as a number, as the name of a top-level `const` holding a number, or as arithmetic with `+ - * /` over those; a section may be the name of a top-level `const` holding one `[length, pattern]` array, and a spread of a top-level `const` holding such arrays is read as its sections; other `arrange()` calls still play but are not shown as parts, and the Parts view says why.
- `polymeter(...patterns)` — like `{ }` mini-notation: several sequences of different lengths sharing one clock.

```js
stack(note("c e g"), s("bd sd"))
cat(note("c"), note("e"))   // c on cycle 1, e on cycle 2
```

## Time

- `fast(n)` / `slow(n)` — speeds a pattern up or down by a factor.
- `early(n)` / `late(n)` — shifts a pattern earlier or later by a fraction of a cycle.
- `rev()` — reverses a pattern within each cycle.
- `palindrome()` — plays forwards then backwards on alternating cycles.
- `iter(n)` — rotates the pattern's steps by one more step each cycle, over `n` cycles.
- `ply(n)` — repeats each event in place `n` times, faster.
- `hurry(n)` — `fast(n)` combined with `speed(n)` (raises sample playback speed to match).
- `linger(n)` — plays only the first `n` fraction of the cycle, looped to fill the rest.
- `compress(start, end)` — squeezes a pattern into the `[start, end]` fraction of the cycle, silent outside it.
- `zoom(start, end)` — plays only the `[start, end]` fraction of the pattern, stretched to fill the cycle.
- `inside(n, fn)` / `outside(n, fn)` — applies `fn` after slowing down by `n` (`inside`) or speeding up by `n` (`outside`), then undoes the change — useful for applying a per-cycle function across several cycles at once.

```js
note("c e g b").fast(2)
note("c e g b").iter(4)
```

## Structure

- `struct(flags)` — plays this pattern's values on the steps where `flags` has a truthy value, silent elsewhere.
- `mask(flags)` — like `struct`, but keeps this pattern's own timing and only mutes the steps where `flags` is not truthy.
- No function of this Strudel reads `t` or `f` as a boolean: in mini-notation `t`, `f`, `true` and `false` are plain strings (`f` is also a note name), so `struct`, `mask` and `when` treat each of them as true. The false values are `0` and `~` (a rest) for `struct` and `mask`; a JavaScript `true` or `false`, such as one a `signal` function returns, works as written.
- `euclid(pulses, steps)` / `euclidRot(pulses, steps, rotation)` — the Euclidean rhythm as a function, equivalent to the `(pulses,steps)` mini-notation.
- `euclidLegato(pulses, steps)` — a Euclidean rhythm where each pulse is held until the next one, with no gaps.
- `segment(n)` — samples a continuous pattern (a signal) into `n` discrete steps per cycle.
- `chunk(n, fn)` — applies `fn` to a different `1/n` slice of the cycle each cycle, cycling through all `n` slices.
- `off(time, fn)` — layers a copy of the pattern, shifted later by `time` and transformed by `fn`, on top of the original.
- `superimpose(fn)` — `off(0, fn)`: layers a transformed copy with no time shift.
- `layer(...fns)` — applies each function in the list to the pattern and stacks all the results.
- `jux(fn)` — plays the original pattern panned left and a version transformed by `fn` panned right.

```js
s("bd").struct("1 0 1 1")
note("c e g").off(0.125, (x) => x.add(note("12")))
```

## Randomness

- `rand` — a continuous random signal between 0 and 1, re-sampled with `.segment(n)` or a control.
- `perlin` — a continuous, smoothly-varying random signal between 0 and 1.
- `choose(...values)` — a signal that picks one of the values at random.
- `wchoose(...[value, weight])` — like `choose`, weighted so higher-weight values come up more often.
- `degrade()` — randomly drops about half of the events.
- `degradeBy(amount)` — randomly drops events with probability `amount` (0 to 1).
- `sometimes(fn)` / `sometimesBy(amount, fn)` — applies `fn` to a random subset of events (about half, or `amount` for `sometimesBy`).
- `often(fn)` / `rarely(fn)` — `sometimesBy` with a high (0.75) or low (0.25) amount.
- `almostAlways(fn)` / `almostNever(fn)` — `sometimesBy` with a very high (0.9) or very low (0.1) amount.
- `someCyclesBy(amount, fn)` — applies `fn` to whole cycles at random, with probability `amount`.

```js
s("bd*8").degradeBy(0.3)
s("bd sd").sometimes((x) => x.crush(4))
```

## Signals

A signal is a continuous pattern of values (not discrete steps) — useful as the argument to a control, so the control's value changes smoothly instead of jumping between steps.

- `sine`, `cosine`, `saw`, `isaw`, `tri`, `square` — continuous waveform signals oscillating once per cycle, between 0 and 1.
- `.range(low, high)` — rescales a 0-to-1 signal to a different range.
- `.rangex(low, high)` — like `.range`, but exponential (useful for a frequency that should sweep evenly by ear).
- `.segment(n)` — turns a continuous signal into `n` discrete steps per cycle (see also Structure, above).
- `.slow(n)` — stretches a signal's one-cycle oscillation over `n` cycles.
- `signal(fn)` — builds a custom signal: `fn` receives the current cycle position (a number) and returns a value.

```js
s("bd*4").lpf(sine.range(400, 2000).slow(4))
```

## Conditions

- `when(flags, fn)` — applies `fn` where the value of `flags` is truthy; `when` needs `1`/`0`, and a `t`/`f` string applies `fn` everywhere.
- `firstOf(n, fn)` / `lastOf(n, fn)` — applies `fn` on the first, or the last, of every `n` cycles.
- `pick(pattern, list)` — selects an item from `list` by index, patterned.
- `inhabit(list, pattern)` — like `pick`, but the list holds whole patterns rather than plain values.
- `squeeze(pattern, list)` — like `pick`, but squeezes the chosen pattern from `list` into the current step's time.

```js
note("c e g b").lastOf(4, (x) => x.rev())
```

## Arithmetic on values

- `.add(n)` / `.sub(n)` / `.mul(n)` / `.div(n)` / `.mod(n)` — adds, subtracts, multiplies, divides or takes the modulo of a pattern's numeric values by `n` (a plain number or another pattern).

```js
note("0 2 4").add(note("<0 12>"))
```

## Tempo

- `setcps(n)` — sets the scheduler's rate directly, in cycles per second. This bundle starts at 0.5.
- `setcpm(n)` / `.cpm(n)` — sets the rate in cycles per minute (`cpm` = beats-per-minute divided by beats-per-cycle); `.cpm` is also a pattern method.

```js
setcpm(120)
```

## Several parts at once

- `$: pattern` or `label: pattern` — a top-level labeled statement starts its own part, combined with every other labeled part in the same evaluation (see reference/tidal-differences.md).
- a label starting or ending with `_` silences that part, without deleting it.
- a label longer than one character that starts with a capital `S` plays alone: while one exists, every other label is silent; a label that also starts or ends with `_` is silenced instead.
- `stack(...)` — the function form of combining several parts in one expression.
- `hush()` — silences every part at once.
- `.hush()` — silences one pattern (unlike `hush()`, which silences every part).
- `all(fn)` — applies `fn` to every currently playing part.

## Loading more samples

- `samples(url)` — loads a sample bank from a URL (a JSON manifest) or a `github:user/repo` shorthand; needs network access from the browser page.

## Sample slicing

- `begin(n)` / `end(n)` — plays only from fraction `n` (0 to 1) of the sample onward, or up to fraction `n`.
- `speed(n)` — plays the sample at `n` times its recorded speed (negative reverses it).
- `loop(bool)` — repeats the sample for as long as the event lasts, instead of stopping at its natural end.
- `chop(n)` — cuts the sample into `n` equal pieces and plays them as separate steps.
- `striate(n)` — like `chop`, but interleaves the pieces across the whole pattern instead of playing them in place.
- `slice(n, indexPattern)` — cuts the sample into `n` pieces and plays them in the order given by `indexPattern`.
- `splice(n, indexPattern)` — like `slice`, but stretches each piece to fill its step exactly.
- `loopAt(n)` — stretches the sample to last `n` cycles, looping it in time with the pattern's tempo.
- `fit()` — advances through a list of samples, one per event, rather than repeating the first one.
- `cut(n)` — stops any other sample playing in the same numbered group `n` when a new one starts (prevents overlap).
- `clip(n)` — plays the sample for `n` times the event's own duration, then stops (or holds if longer than the event).
- `legato(n)` — sets the sample's playback duration to `n` times the event's duration, independent of `clip`.

```js
s("bd*4").chop(4)
s("bd").cut(1)
```
