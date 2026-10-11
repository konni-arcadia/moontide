# Music theory in Strudel

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

Every demo below keeps C as the root (or uses no root at all) and changes exactly one thing at a time: a mechanism, never a piece. This bridges music theory to the pinned Strudel syntax; the reasoning about which theory fits a request is Claude's own.

## Notes and octaves

A note name is a letter, an optional accidental, and an optional octave number (see reference/mini-notation.md): a sharp is `#` or `s`, a flat is `b` or `f` (`eb` and `ef` name the same note), and the octave is 3 when none is written, so `note("c")` is C3 (MIDI 48). `note()` also accepts a plain number directly as a MIDI note number, with no letter name at all.

```js
note("c4 c5")   // one octave apart: same letter, different octave number
```

```js
note(60)   // a plain number is read as a MIDI note number, not a scale degree
```

`freq(hz)` sets an exact frequency in Hertz directly, bypassing note-to-pitch mapping entirely.

```js
freq(220).s("sine")
```

## Intervals and transposition

Note values are semitones underneath, so the arithmetic controls (`.add`, `.sub`, see reference/functions.md) shift a note by that many semitones; twelve semitones is one octave.

```js
note("c4").add(note("12"))   // up one octave: 12 semitones
```

`.transpose(amount)` (synonym `.trans`) does the same shift, but also accepts a named interval string such as `1P` (unison), `2M` (major second) or `3m` (minor third) instead of a semitone count — the same interval spelling the scale and chord data below use.

```js
note("c4").transpose("3m")   // up a minor third, named instead of counted
```

`scaleTranspose(steps)` shifts by scale degrees instead of semitones, staying inside whatever scale is already established with `.scale()` (used with `.apply()`, see reference/functions.md "Structure").

## Scales and modes

`n(pattern).scale("root:type")` turns plain scale-degree numbers into notes inside the named scale; degree `0` is the root, and degrees continue upward or downward past the scale's own length by wrapping around and shifting by whole octaves (so degree `7` in a 7-note scale is the root one octave up, and `-1` is the scale's last degree one octave down).

```js
n("0 1 2 3 4 5 6 7").scale("C:major")   // one octave, degree 7 wraps to C one octave up
```

The seven diatonic modes, as interval formulas from the root (`P` perfect, `M` major, `m` minor, `A` augmented, `d` diminished; scale degree order 1-2-3-4-5-6-7): ionian `1P 2M 3M 4P 5P 6M 7M`, dorian `1P 2M 3m 4P 5P 6M 7m`, phrygian `1P 2m 3m 4P 5P 6m 7m`, lydian `1P 2M 3M 4A 5P 6M 7M`, mixolydian `1P 2M 3M 4P 5P 6M 7m`, aeolian `1P 2M 3m 4P 5P 6m 7m`, locrian `1P 2m 3m 4P 5d 6m 7m`. Each is a shape (a pattern of whole and half steps between the same seven degrees), stated here with no further association.

```js
n("0 2 4").scale("C:dorian")   // same degrees as ionian above, different scale shape
```

Every scale name and alias in this bundle's scale dictionary (131 entries, including the seven modes above under their own names):

```names
aeolian
aeolian b5
altered
altered dorian
arabian
augmented
augmented heptatonic
balinese
bebop
bebop locrian
bebop major
bebop minor
blues
chinese
chromatic
composite blues
diminished
diminished whole tone
dominant
dominant diminished
dorian
dorian #4
dorian b2
double harmonic lydian
double harmonic major
egyptian
enigmatic
flamenco
flat six pentatonic
flat three pentatonic
gypsy
half-diminished
half-whole diminished
harmonic major
harmonic minor
hindu
hirajoshi
hungarian major
hungarian minor
ichikosucho
in-sen
indian
ionian
ionian #5
ionian augmented
ionian pentatonic
iwato
kafi raga
kumoi
kumoijoshi
leading whole tone
locrian
locrian #2
locrian 6
locrian major
locrian natural 6
locrian pentatonic
locrian sharp 6
lydian
lydian #5P pentatonic
lydian #9
lydian augmented
lydian b7
lydian diminished
lydian dominant
lydian dominant pentatonic
lydian minor
lydian pentatonic
major
major #5
major augmented
major blues
major pentatonic
malkos raga
melodic minor
melodic minor fifth mode
melodic minor second mode
messiaen's mode #1
messiaen's mode #2
messiaen's mode #3
messiaen's mode #4
messiaen's mode #5
messiaen's mode #6
messiaen's mode #7
minor
minor #7M pentatonic
minor bebop
minor blues
minor hexatonic
minor pentatonic
minor seven flat five pentatonic
minor six diminished
minor six pentatonic
mixolydian
mixolydian b6
mixolydian pentatonic
mystery #1
neopolitan major
neopolitan major pentatonic
oriental
overtone
pelog
pentatonic
persian
phrygian
phrygian #6
phrygian dominant
phrygian major
piongio
pomeroy
prometheus
prometheus neopolitan
purvi raga
ritusen
romanian minor
scriabin
six tone symmetric
spanish
spanish heptatonic
super locrian
super locrian pentatonic
superlocrian bb7
superlocrian diminished
todi raga
ukrainian dorian
ultralocrian
vietnamese 1
vietnamese 2
whole tone
whole tone pentatonic
whole-half diminished
```

## Chords

Chords are chord symbols passed to `chord()` and turned into notes by `.voicing()`, for example `chord("C").voicing()`; a mini-notation string chained directly with `.voicing()` also plays. Demos stay C-rooted and change one thing at a time.

```js
chord("C").voicing()
```

```js
chord("<C C^7 C-7>").voicing()
```

A chord root is an uppercase letter `A` to `G` with an optional `b` or `#`. A lowercase root, and the note-name accidentals `s` and `f`, are never chord roots — a chord accidental is only ever `b` or `#`.

Unlike the older seventh-chord convention, a bare letter with no suffix is a major triad (the dictionary's own `^` entry, which the page also files under the empty suffix when it loads).

The `+` suffix exists in the dictionary but cannot be written inside a mini-notation string, since `+` is not a mini-notation step character; write `aug` instead.

An unknown chord symbol inside `.voicing()` plays nothing (the page logs it, but that log is not yet forwarded to Claude).

The default `ireal` dictionary's own keys (62 entries):

```names
+
-
-#5
-11
-6
-69
-7
-7b5
-9
-^7
-^9
-add9
-b6
11
13
13#11
13#9
13b9
13sus
2
5
6
69
7
7#11
7#5
7#9
7#9#11
7#9#5
7#9b5
7alt
7b13
7b13sus
7b5
7b9
7b9#11
7b9#5
7b9#9
7b9b13
7b9b5
7b9sus
7sus
7susadd3
9
9#11
9#5
9b5
9sus
^
^13
^7
^7#11
^7#5
^9
^9#11
add9
h
h7
h9
o
o7
sus
```

These spellings are also accepted because the page builds them from the keys above when it loads (`m` for `-`, `M` for `^`, `aug` for `+`):

```names
aug
m
m#5
m11
m6
m69
m7
m7b5
m9
m^7
-M7
m^9
-M9
madd9
mb6
M
M13
M7
M7#11
M7#5
M9
M9#11
```

Common spellings that are not accepted, each next to the accepted spelling: maj7 (accepted: `^7` or `M7`), min7 (accepted: `-7` or `m7`), sus4 (accepted: `sus`), sus2 (accepted: `2` — its intervals are a root, a compound second and a fifth, with no third), dim (accepted: `o`), dim7 (accepted: `o7`).

## Voicings and inversions

`.voicing()` takes no argument: passing it one, for example an options object, fails in the page with ".voicing() expects 0 inputs but got 1." Its options are controls chained on the chord pattern before `.voicing()`, never passed as an argument: `chord()` (the chord symbols, see "Chords" above), `dict()` (same as `dictionary()`, which chord table to use), `anchor()` (the note the voicing is built around), and `mode()` (which note of the found voicing lands closest to the anchor: `below`, `duck`, `above` or `root`; the form `mode("below:c4")` sets mode and anchor together, because mode is registered together with anchor as one control pair). `offset()` shifts to a different, equivalent voicing among the chord's own stored options, wrapping by a whole octave past the last one; `octaves()` sets how many octaves that shift can wrap across. The defaults are dictionary `ireal`, mode `below`, anchor `c5`, offset 0 and octaves 1.

```js
chord("C").voicing()
```

```js
chord("C").mode("below").voicing()
```

```js
chord("C").mode("above").voicing()   // same chord, same anchor, different mode
```

```js
chord("C").anchor("c4").voicing()   // same chord, same mode, different anchor
```

`rootNotes(octave)` returns just the root note of each chord, in the given octave, instead of a full voicing. An inversion can also be written directly in mini-notation by reordering a chord's notes inside `[ , ]` (see reference/mini-notation.md "Simultaneous events") so the lowest note is no longer the root.

```js
note("[c4,e4,g4]")   // root position: c is lowest
```

```js
note("[e4,g4,c5]")   // first inversion: same three notes, e is now lowest
```

## Declaring the harmony

A top-level `const harmony = ...` is the one place the page reads as the harmony the code means. It holds a scale string or a chord pattern, written as text in the line itself:

```js
const harmony = 'C:major'   // a scale: root, optional octave, ":", scale name; a name with spaces uses ":" in place of each space
n("0 2 4").scale(harmony)   // the code may read the constant like any other
```

```js
const harmony = "<C C^7 C-7>"   // chord symbols, one per step; chord("<C C^7 C-7>") is read the same way
chord(harmony).voicing()
```

The line plays nothing and makes no track: Strudel evaluates it like any constant and ignores it unless the code uses it. A labeled statement `harmony: ...` is a track and plays. The Jam view shows the declared harmony next to the scale it hears in the notes, as two separate lines. The page reads only the written text: a value it would have to compute (a call other than `chord()`, another name, a template with `${}`) is shown as not readable. A program whose last top-level statement is a `const` fails to evaluate with "unexpected ast format without body expression", so the line goes above the patterns, never last.

## Rhythm and meter

A pattern's meter is just how many steps share its cycle: mini-notation's space-separated steps, `@` weights and `{ }` polymeter (see reference/mini-notation.md) all shape meter without any separate "time signature" concept. An odd step count is not a special case — it is simply that many equal steps.

```js
s("bd sd bd sd bd")   // five equal steps, no different from any other count
```

## Swing

`.swingBy(amount, subdivision)` delays the second half of every group of `subdivision` steps by `amount` of a step; `.swing(subdivision)` is `.swingBy(1/3, subdivision)`.

```js
s("hh*8").swingBy(1/3, 4)
```

```js
s("hh*8").swing(4)   // the same swing, written with the shorthand
```

## Polyrhythm

`stack()` (see reference/functions.md "Combining patterns") plays several parts in the same cycle at once; giving each part its own step count, independent of the others, is what makes it a polyrhythm rather than a single shared meter.

```js
stack(s("bd*3"), s("hh*4"))   // three against four, in the same cycle
```

## Dynamics

`gain()` and `velocity()` (see reference/effects.md "Level and pan") each take a mini-notation string or a signal, so a level can be patterned per step exactly like a pitch or a sound name — an accent is simply a higher value on one step than its neighbors. A dynamic that changes gradually across several cycles, rather than step to step, is a transition (see reference/transitions.md).

```js
s("bd*4").gain("1 0.5 1 0.5")   // an accent pattern, alternating loud and soft
```

## Articulation

How long a note actually sounds within its step is articulation: `.legato(n)` and `.clip(n)` scale the sounding duration against the step's own length (see reference/effects.md "Sample slicing"), and the amplitude envelope's `.decay()`/`.sustain()`/`.release()` (see reference/effects.md "Amplitude envelope") shape how it fades.

```js
note("c4 c4").clip(0.2)   // short and detached
```

```js
note("c4 c4").clip(1)   // held for the full step, same notes otherwise
```

## Arpeggios

`.arp(indexPattern)` plays the notes of a chord one at a time instead of together, picking them by index (cycling through the chord's own note count); `.arpWith(fn)` is the general form, applying any function to the whole list of the chord's notes at once.

```js
"C".voicing().arp("0 1 2")   // the chord's notes, one after another instead of stacked
```
