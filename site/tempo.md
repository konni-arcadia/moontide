# Tempo ramps

Sometimes a piece should speed up or slow down smoothly, not jump. Ask Claude for a tempo change over a
number of bars, and the tempo moves there step by step. This page says how to ask, what you see while
it runs, and what keeps it going or ends it.

## Ask for it

Ask in your own words, for example "bring it up to 140 over eight bars". Claude sends the new code with two things: the tempo to reach, written in the code, and `glideBars`,
a whole number of bars from 1 to 64. It sends them with `set_code` or `edit_code`.

The tempo then moves from the tempo that plays now to the one in the code, in equal small steps, and it
ends exactly on the tempo you asked for. It starts at once, or at the line when the change waits for the
next bar or phrase.

There is no separate start value: a ramp always leaves from the tempo that plays.

## Watch it in the top bar

While a ramp runs, the tempo in the top bar shows three things: the live tempo, an arrow and the tempo
to reach. Hover it to see how many bars are left.

## What keeps it going

A ramp goes on when you:

- move something in the Mixer;
- pick a cell in the Song grid;
- edit a note on the Timeline;
- edit the code by hand, as long as the tempo in it stays the same.

## What ends it

A ramp ends when:

- the code gets another tempo. The new tempo plays at once.
- the code has no tempo. The tempo stays where it was.
- a new `glideBars` arrives. The new ramp replaces the old one.
- you press Stop. The next Play starts at the tempo of the code.
- you reload the page, or another tab takes over.

There is no cancel button of its own: Stop is the way.

## When it is refused

A ramp is refused as a whole, and nothing changes, when nothing plays, when the code sets no tempo, or
when it sets the tempo that already plays.

## A ramp is not a version

A ramp writes nothing into the code and nothing into the history. The tempo moves in the page, and the
code keeps the tempo it was given. See [History and favorites](history.md) for what is kept.

## MIDI instruments

The MIDI clock follows every step of a ramp, so an instrument that follows the clock follows the ramp.
The MIDI gear part of this manual says more about the clock.

## What was verified

**Verified:**

- The steps, the end on the exact tempo, the refusals, and what keeps a ramp going or ends it are
  covered by automated tests, and a drive of the real page in headless Chrome checks them.
- A ramp down was heard on two instruments that follow the clock: a Roland JUPITER-Xm arpeggiator and a
  Moog Subharmonicon. A ramp up was heard on the Subharmonicon.

**Not verified:**

- A ramp up on the arpeggiator: it went off the beat during the ramp.
- A wide ramp across the arpeggiator's rate.
- Stop in the middle of a ramp.
- How a ramp sounds on speakers, and whether it sounds continuous.
- How the top bar reads during a ramp at 1080p and at 4K.
