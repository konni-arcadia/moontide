# Mini-notation

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

Every symbol below is part of the string passed to a pattern function such as `note()`, `n()` or `s()`; the string is parsed as one cycle of events.

## Sequences and subdivision

Space-separated steps divide the cycle into equal parts. `[ ]` nests a group of steps into the time of one step.

```js
note("c e g")       // three equal steps in one cycle
note("c [e g] b")   // "e g" together take the time of one step
```

## One event per cycle

`< >` plays one of its steps per cycle, advancing by one each cycle (equivalent to the same list inside `[ ]` sped up by its own length).

```js
note("<c e g>")   // c on cycle 1, e on cycle 2, g on cycle 3, then repeats
```

## Speed

`*` speeds a group up (plays it more than once in the same time); `/` slows it down (spreads it over more than one cycle).

```js
note("[c e g]*2")   // twice as fast: two full passes per cycle
note("[c e g]/2")   // half as fast: one pass over two cycles
```

## Rests

`~` or `-` is a silent step, taking up its share of the cycle with nothing sounding.

```js
note("c ~ e ~")
```

## Simultaneous events

`,` inside `[ ]` plays several steps at once (a chord, or several parts stacked in one string).

```js
note("[c,e,g]")
```

## Weights and repeats

`@` gives a step a relative duration weight (bigger number, longer step). `!` repeats a step that many times in place of one.

```js
note("<c@3 e>")     // c takes three times as long as e
note("c!3 e")        // c c c e — four equal steps
```

## Elongation

`_` extends the previous step by one more step's worth of time, without repeating it.

```js
note("c _ e")   // c held for two steps, then e
```

## Randomness

`?` removes a step at random (optionally with a probability, `?0.3` for 30% of the time). `|` picks one of several alternatives at random, once per cycle.

```js
s("bd? sd")        // "bd" sometimes silent
s("bd|sd|hh")       // one of the three, chosen at random each cycle
```

## Euclidean rhythms

`(pulses,steps,rotation)` after a step distributes that many pulses evenly across that many steps (rotation is optional and shifts the starting pulse).

```js
s("bd(3,8)")     // 3 pulses spread across 8 steps
s("bd(3,8,2)")   // the same pulses, rotated by 2 steps
```

## Polymeter

`{ }` plays several sequences of different lengths together, each keeping its own step length but sharing one clock; `{...}%n` sets how many steps of that clock play per cycle.

```js
note("{c e g, a b}")       // a 3-step and a 2-step sequence, same clock
note("{c e g, a b}%4")     // both play 4 steps per cycle
```

## Sample numbers

`:` after a sample name selects a numbered variant from that sample's bank.

```js
s("bd:3 sd:1")
```

## Note names and numbers

A note name is a letter (`a`-`g`), an optional accidental, and an optional octave number: a sharp is `#` or `s`, a flat is `b` or `f` (`eb` and `ef` name the same note), and the octave is 3 when none is written.

```js
note("c cs4 df5")   // c in octave 3 (the default), c-sharp in octave 4, d-flat in octave 5
n("0 2 4")           // plain scale-degree numbers, for use with .scale()
```

`note()` takes note names and numbers only. A chord symbol such as `Cm7` inside `note()` fails with "not a note": chords go through `chord()` and `.voicing()` (see reference/theory.md "Chords"). An apostrophe is not a mini-notation character, so a note followed by an apostrophe and a chord name (Tidal's chord syntax, see reference/tidal-differences.md "Chords") does not parse in this page.

## Mini-notation as a control argument

A mini-notation string works as the argument to any control, not only `note()` or `s()` — it patterns that control's value over the cycle.

```js
note("c e g").lpf("<400 2000>")   // filter cutoff alternates each cycle
```
