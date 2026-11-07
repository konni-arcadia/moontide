# Asking Claude

You talk and Claude writes the code. This page says what to ask, how Claude answers and what Claude
can look up. The page of the browser is only one way to ask: you can also type in the chat, as you
did for [your first music](first-music.md).

## You talk, Claude writes

Describe what you want in your own words: "start something dreamy in D minor", "darker", "add a
bass", "slower". Claude turns your words into Strudel code with its own knowledge of music, and the
page plays it within a fraction of a second. Then Claude tells you in one line what it chose. If the
choice was not what you meant, say so and Claude changes it.

Moontide ships no mood vocabulary, no style material and no model pieces. It does not tell Claude
what "sad" or "dreamy" should sound like. That is your words and Claude's knowledge.

## Ask for a surprise

There is no menu command for a surprise. Ask for one in your own words: "surprise me", "something
unexpected in the middle", "break the pattern for a moment".

## Set a frame

You can set a frame for the session, for example gradual changes. Claude then follows it for every
change, surprises and small edits included, until you change it or lift it. With the frame of gradual
changes, each change arrives through a transition that unfolds over several cycles, not as a jump.

## Say what matters

If a melody or a rhythm matters to you, say so. Claude keeps it through the changes that follow, and it
asks before it rewrites the whole piece.

## Pieces and tracks

Every new piece starts with a song structure, written once at the top of the code: the sections of the
piece, and what each track plays in each. The page [Song structure](song-structure.md)
explains how to use it. A small request on an older piece is made in place and does not turn it into a
structured one.

Claude writes each layer of the music as a named track, such as a bass or a lead. The page shows the
tracks under these names, in the Timeline, in the Mixer and in the Song grid.

## What Claude reads

Claude gets a factual reference for the exact Strudel version the page runs. It reads it through the
`get_strudel_reference` tool, and the same texts are offered as resources. The reference has eleven
topics:

- Strudel vs TidalCycles (`tidal-differences`): the syntax that differs from TidalCycles, and the
  names this version does not have.
- Mini-notation (`mini-notation`): every symbol of the pattern strings, such as sequences, rests,
  chords, repeats, randomness and Euclidean rhythms.
- Pattern functions (`functions`): building, combining and changing patterns.
- Effects and sound controls (`effects`): gain, pan, filters, envelopes, distortion, delay, reverb and
  modulation.
- Sound palette (`sounds`): every sound the page loads by default, and how to load more.
- Music theory in Strudel (`theory`): notes, intervals, scales, modes, chords, rhythm, swing, dynamics
  and arpeggios.
- Transitions (`transitions`): how one change can unfold over several cycles.
- Song structure (`structure`): the song declaration at the top of a piece.
- MIDI output (`midi`): sending a track to a MIDI port, the MIDI clock Moontide sends and what Stop
  sends.
- Synth settings (`settings`): the tone, part and scene settings of a MIDI instrument.
- Motif requests (`motif`): how to read a motif sent from the Scratchpad.

The reference holds facts only: what exists and how to write it. It never says what sounds good. That
is the choice of the person and of Claude.

## What was verified

**Verified:**

- The topic list on this page, the tool name and the count are checked by a test against the code at
  each change.
- The reference texts are checked against the Strudel version the page loads.
- Claude followed the rule of a song structure at the top of a new piece in a trial with headless
  Claude sessions, each with one plain request.

**Not verified:**

- How the sections of a piece feel. That is judged by ear.
- That Claude follows a frame such as gradual changes in a long real session.
- That Claude keeps a melody you named through many changes.
