# Strudel vs TidalCycles

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

## Strudel is JavaScript

Strudel has no custom infix operators or a pipeline operator: every transform is a method call chained with `.`, and every statement is plain JavaScript.

```tidal
d1 $ s "bd sd" # crush 4
```

```js
s("bd sd").crush(4)
```

## Operators

Tidal's `|+ |- |* |/ |%` operator family has no equivalent syntax in Strudel; each one is a chained method on the pattern.

```tidal
n "0 2 4" |+ n 12
```

```js
n("0 2 4").add(n(12))
```

The mapping: `|+` -> `.add`, `|-` -> `.sub`, `|*` -> `.mul`, `|/` -> `.div`, `|%` -> `.mod`.

## Strings

Double-quoted strings and untagged backtick strings are mini-notation, parsed as patterns; single-quoted strings stay plain JavaScript strings and are never parsed as mini-notation.

```tidal
s "bd sd hh"
```

```js
s("bd sd hh")   // mini-notation: three events
s(`bd sd hh`)   // mini-notation: same as above (untagged backtick)
sound === 'bd'  // plain string, never mini-notation
```

This applies to every such string in the code, including one inside a helper function that only builds or joins text and one in a function that never runs, so its text must be valid mini-notation on its own, or the whole evaluation fails with a `[mini] parse error`.
A backtick string keeps only the text before its first `${`, and the rest is dropped without an error.
A single-quoted string passed to a pattern function stays one value, not a sequence of events, even when built with `+` or `.join(' ')`, and `mini()` parses such a built string as mini-notation.

```js
note(mini('c3 ' + ['e3', 'g3'].join(' ')))   // three events, built from single-quoted strings
```

## Chords

```tidal
n "c'maj e'min7"
```

```js
chord("<C C-7>").voicing()
```

Tidal's apostrophe chord names do not exist here. An apostrophe inside a mini-notation string is a parse error. Chord symbols go through `chord()` and `.voicing()`, never `note()` (see reference/theory.md "Chords" for the accepted spellings).

## Tempo

This pinned bundle's scheduler starts at 0.5 cycles per second, not Tidal's 0.5625. Both `setcps` and `setcpm` (or the pattern method `.cpm`) change the rate: `setcpm` sets cycles per minute, useful when reasoning in beats per minute (cpm = bpm / beats-per-cycle).

```tidal
-- Tidal starts at 0.5625 cycles per second (cps)
```

```js
setcps(0.5)     // this bundle's own starting rate
setcpm(120)     // 120 cycles per minute == 2 cycles per second
s("bd sd").cpm(120)
```

## Several parts at once

Tidal plays several parts by sending each to its own numbered stream (`d1`, `d2`, ...). Strudel has no `d1`/`d2`: parts are combined with `stack()`, or a program of `$:` labels — each label starts its own part in the same evaluation. A label whose name starts or ends with `_` is silenced (kept in the code, not heard); a label longer than one character that starts with a capital `S` plays alone: while one exists, every other label is silent, and a label that also starts or ends with `_` is silenced instead; `hush()` silences every part at once.

```tidal
d1 $ s "bd sd"
d2 $ s "hh*4"
```

```js
stack(
  s("bd sd"),
  s("hh*4"),
)

$: s("bd sd")          // "$" is the plain, unnamed label
drums: s("hh*4")       // any identifier can label a part
_muted: s("cp*2")      // a label starting or ending with "_" silences that part

hush()                 // silences every part
```

## Names that differ or are missing

- `whenmod` does not appear anywhere in this bundle; there is no Strudel equivalent by that name.
- `d1`, `d2`, ... (Tidal's numbered streams) do not exist; use `stack()` or `$:` labels instead (see above).
- `#` and `$` as infix/pipeline operators do not exist; every transform is a chained method call (see "Strudel is JavaScript" above).
- Tidal's apostrophe chord syntax (`c'maj`) does not exist; chord symbols go through `chord()` and `.voicing()`, never `note()` (see "Chords" above).
