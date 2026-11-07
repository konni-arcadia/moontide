# Motif requests

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

How to read a motif request: the fields it holds, the moment, the grid, the phrase form, the velocities and the source words. Every fact here is a plain possibility, not a suggestion of what to do with a motif.

## What a motif request holds

A motif is a short pattern of notes made on the Scratchpad of the page. The user sends it to Claude with the Send to Claude button, as a page request whose context has kind motif. The request text is the user's words, prefilled with a short default sentence they can change. The motif rides in the motif field, which holds these names:

```names
source cycle cycles grid notes phrase
```

source says how the notes got onto the Scratchpad. cycle is the moment and may be absent. cycles is the length of the motif in cycles, from 1 to 8. grid is the grid of the steps. notes is how many notes the motif holds. phrase is the motif written as Strudel code.

## The moment

For a played motif, cycle is the cycle of the music where the motif's first cycle was played. For any other motif, cycle is the cycle where the first cycle of the roll stood when the user pressed the button, a whole multiple of the cycles of the motif.

An absent cycle means the motif has no moment: the music was stopped, or the notes of a played motif came from more than one run of the music.

A pattern repeats from the start of the count, so a phrase that spans its cycles starts again at every multiple of them. A time shift moves it; the functions topic of get_strudel_reference lists the time functions.

## The grid

The grid is one of five ids:

```names
quarter eighth sixteenth eighth-triplet sixteenth-triplet
```

The steps of each grid in one cycle:

- `quarter`: 4 steps per cycle
- `eighth`: 8 steps per cycle
- `sixteenth`: 16 steps per cycle
- `eighth-triplet`: 12 steps per cycle
- `sixteenth-triplet`: 24 steps per cycle

A cycle holds 4 beats. Every note starts on a step and lasts a whole number of steps.

## The phrase

One lane is `note("…").velocity("…")`, and several lanes are `stack(…)` of lanes. The ellipses stand for the strings of a lane; this topic gives no example phrase.

- A string holds one entry per step of the whole motif, from its first step to its last.
- `~` is a step where no note of that lane starts.
- `_` is a step the note before still holds.
- Voices that start together with the same length and velocity are one entry in square brackets with commas between the pitch names.
- Voices that differ go in separate lanes.
- A motif of more than one cycle is one sequence in square brackets followed by a slash and the value of cycles, so a note can be held across the line between two cycles.
- The velocity string mirrors the note string entry for entry: a note or a chord has its velocity at the same place, and ~ and _ stay the same.
- Pitch names are lowercase letters from a to g, with # for a sharp and the octave number after them; MIDI note 60 is written c4.

The phrase is the whole motif, and it is the text the page showed the user. The mini-notation topic of get_strudel_reference lists every symbol of the strings.

## Velocities

A velocity runs from 0.01 to 1, written with at most two decimals. On a MIDI track `.gain()` multiplies the velocity; the midi topic of get_strudel_reference has the MIDI facts.

## How the notes got there

The source words:

```names
played drawn tapped mixed
```

- played: the notes were played on a MIDI keyboard and put on the roll.
- drawn: the notes were placed on the roll by the user.
- tapped: the notes were tapped in time with the music.
- mixed: the notes got there in more than one of these ways.

Played notes can include very short, very quiet notes that the player may not have meant.

## What the words can ask

The user's words decide what a motif request asks for. The motif can become a new labeled track, a change to a track that plays, or a replacement of what plays, or the answer can be in words. The page asks for none of these by itself.

## What the page did

The page changed no code and no version. The music plays as it did until a change is written with set_code or edit_code. A change that passes the id of the request as answering links to it, and answer_request closes the request in words.
