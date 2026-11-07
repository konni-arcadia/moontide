# Sending a motif to Claude

**Early experimental:** sending a motif is part of the Scratchpad, and the whole Scratchpad is early
experimental. Read the phrase before you send: a played motif may hold notes that are shorter than you
held them (see [Playing in from a keyboard](keyboard-input.md)).

A motif made on the Scratchpad reaches Claude as one page request, like the ones the Ask box sends (see
[Asking from the page](page-requests.md)), with the motif itself in a field of its own. This page
explains what your press sends, what Claude is told about where the motif belongs in the music, and what
the page refuses. It assumes you know [the Scratchpad](scratchpad.md).

## Only your press sends

The **Send to Claude** button sends the motif, and so does Enter in the words field next to it. Nothing
else does. A held key that opened the field sends nothing.

The page changes no code and no version when it sends. What Claude does with the motif is Claude's change
to make, and yours to keep or undo. The request shows in the Requests list like any other.

## The words

The words field is prefilled with a short sentence, and you can change it. The words are your request:
"make this the new bass line", "add it as a lead in the second half", or anything else. The page never asks
for an addition or a replacement by itself. That is for your words to say.

## The phrase

Under the roll, the page shows the motif written as Strudel code: a `note("...")` with a velocity lane, or
several of them in a `stack`. One token stands for each grid step, `~` is a rest and `_` is a held step.

This is the phrase that is sent. One function writes it for the screen and for the request, so the phrase
you see is the phrase Claude gets. It is never cut. A motif whose request would pass the line limit of
8192 bytes is refused whole, with what makes it smaller: fewer cycles, a coarser grid, fewer notes
sounding together, or shorter words. Half a phrase would play as a different motif.

## The moment

The motif also carries the moment: the cycle of the music where the motif's first cycle stands. This is
how Claude can place the notes where you meant them.

- **A recorded take (Record that):** it carries the cycle where it was played.
- **A drawn, tapped or mixed motif:** it carries the cycle where the roll's first cycle stands when you
  press the button. This is a whole multiple of the motif's length, because Tap puts notes on the roll
  that way.
- **No moment:** a motif sent while the music is stopped carries no cycle. A recorded take whose notes
  come from more than one run of the music (a Stop and a Play between them), or from two laps of the 8
  columns of the live view, carries none either. Then Claude gets the motif with no moment, and nothing
  is guessed.
- **Align keeps the moment.** The same take sent before and after an Align names the same cycle, with a
  different phrase.

A motif request carries no gesture, because it did not come from a right-click.

## One at a time, and refusals

Only one motif request is on its way at a time. Send waits until Moontide has the last one. A refusal is
said in plain words in the strip under the roll, and nothing is sent. The refusals are: no notes, no
words, words that are too long, no connection to Moontide, a request over the line limit, and a motif
request still on its way. A refusal never touches the Ask box.

## What Claude reads

Claude gets the motif with its own facts and a pointer to the `motif` topic of its Strudel reference: the
fields of a motif, the moment, the grid, the phrase form and the velocities. The topic describes what
exists and decides nothing, so your words decide what the motif becomes: a new track, a change to a track
that plays, a replacement of what plays, or an answer in words.

## What was measured

Ten fresh Claude Code sessions, all on a single model, each with only the Moontide tools and one real motif
request sent from a real page. Five of the motifs were drawn on the roll and five were played on a fake
MIDI keyboard and recorded. The music was a short drum, hat and note line. Success was read from the code
that plays, by a strict rule: every note of the motif had to start at the stated cycle plus its place in
the motif.

- The notes were at the stated cycle in 10 of 10 sessions, and in 5 of 5 of the played ones. No session
  answered in words, and no session missed.
- Two promises were set before the first session and both were met: that a motif is worked in, and that a
  played motif is placed at the cycle where it was played. Only these two promises are made.

What the figure does not say: it is a single model and ten sessions. It reads the code and not the sound, so
nothing was heard, and nothing here says that a motif sounds right or that taste was met. In the five
drawn sessions, the stated cycle was a whole multiple of the motif's length, so a plain loop of the
phrase would have passed there too. The played sessions are where the moment was really tested, and
they were made with a fake keyboard, not a real one. The path where Claude answers in words because a
motif cannot be placed was not exercised. A different model, or another piece of music, may do worse.
The page [What was measured](what-was-measured.md) puts this figure next to the other measurements.

## What was verified

**Verified:**

- The phrase under the roll equals the phrase sent, for all five grids, by automated tests. The moment
  rules, the refusals and the line limit are covered by automated tests too.
- The request with a motif was sent from a real page and read by Claude in ten sessions, as above.

**Not verified:**

- Whether a worked-in motif comes through as played when heard: its pitches, its rhythm and its place in
  the music. This is for an ear.
- A real MIDI keyboard played, recorded and sent was tried once by hand, and its held notes reached
  Claude too short (the known problem above).
- The look of the send strip in the three layouts, and a screen reader on it.
- Another Claude model, and music other than the short line tried.
