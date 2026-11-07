# What was measured

Moontide was measured in a few places, where a number was needed to decide how to build something. This
page lists each measurement: what was measured, how, the result, and what the figure does not say. A
measurement tells you what happened in one setup. It is not a promise about yours.

Most timing numbers come from one Mac, one version of Chrome and a loopback port, which is a MIDI pipe
inside the computer that connects the page to a listener on the same machine. A loopback adds no delay of
its own, so it shows what the page does, and not what a real cable or a real instrument adds. Windows and
Linux were not measured.

## MIDI notes leaving the page ahead

**What:** how steadily the page sends MIDI notes, and how close a note lands to the MIDI clock tick of
the same instant.

**How:** a bench script played notes through the loopback port in real Chrome, with a quiet page and a busy
page, before and after the page learned to send each note a little early with the clock's time stamp.

**Result:** before the change, the spread of the spacing between messages (its standard deviation) was
2.5 ms on a quiet page and 18.9 ms on a busy one, with 68 bursts and 42 gaps in 10 s, and a note could land up to about 20 ms away from the
clock tick of the same instant. After the change, the spread was 0.07 ms on both a quiet and a busy
page, with no burst, no gap and no late send, and every note-on carried a time stamp. With a clock
instrument, the note minus its nearest tick had a mean within 0.01 ms of zero and a spread of 0.18 ms
or less. A note that is late anyway goes out at once and keeps its length.

**What it does not say:** one Mac, one Chrome and a loopback port. The cost is heard: MIDI notes now sit
about 34 ms later than the browser's own sounds, because they follow the page clock and no audio offset is
applied. That is decided, not a bug. A note that Stop or a mute has to end early starts and ends 1 ms
later, which may click on a sound with a fast attack. That has not been heard on real hardware.

See [MIDI instruments and the setup file](midi-instruments.md).

## The MIDI clock, by ear

**What:** whether instruments that follow a clock keep time with Moontide.

**How:** by ear, in one session, on two instruments that follow MIDI clock: a Roland JUPITER-Xm arpeggiator
and a Moog Subharmonicon. The clock itself was measured first: a clock written as a Strudel pattern had a
spread of 2.5 ms when the page was idle and about 20 ms under load, while the page's own clock, which
sends each tick up to about 150 ms ahead with a time stamp, had a spread of 0.1 ms whatever the page did. On the wire, a page
that plays only MIDI showed about 0.5 ms of jitter and no missing tick.

**Result:** a steady tempo for two minutes, Start and Stop, an instrument joining while the music plays,
each started on the next downbeat, and a tempo ramp down were heard. A ramp up was heard on the
Subharmonicon only.

**What it does not say:** the open problems stay open. After a Stop, queued ticks still reach an
instrument for up to about 150 ms, and a follower was heard to jump to a faster tempo for an instant; the
cause is probable and not proven. The arpeggiator went off the beat at a sudden tempo change and during a
ramp up, and a wide ramp, a Stop in the middle of a ramp, a replug while playing and a muted track keeping
the clock were not tried. Other followers were not tried.

See [MIDI instruments and the setup file](midi-instruments.md) and [Tempo ramps](tempo.md).

## Where a played note lands on the grid

**What:** how close to its place a note lands when it is played on a keyboard and placed on the cycle
grid.

**How:** the page's own input was driven through a loopback port in real Chrome at 60, 90, 120, 140 and 180
BPM, with a silent page, a playing page and a busy page, headless and with a window, 40 cells in all. An
independent sender that stamps packets with the operating system's own clock was used as a check.

**Result:** the page reads the time stamp the system gives the note, never the time its own code happens
to run. A busy page ran its code as much as 85.8 ms late, and the stamp does not move, so reading it removes
that delay. The worst error in all 40 cells was 6 ms, which is the worst measured value, 5.68 ms, rounded
up. That is 9.5 percent of the finest step offered, a sixteenth-note triplet at 180 BPM, which is 55.56 ms
long. The worst value belongs to a page that makes no sound at all, whose clock drifts by a few
milliseconds after about twenty-five seconds. On a page that makes any sound, the worst error was 0.8 ms,
and the independent sender gave under half a millisecond at 120 BPM. Played with the computer keys, a
tap landed within 2.5 ms. With the music playing, the worst error of the page's own input was 0.33 ms.

**What it does not say:** a real keyboard's own delay, which a loopback cannot show, a guitar-to-MIDI unit,
Windows and Linux, a device that sends no time stamp, and real key presses for Tap, since the taps were
injected key events. The grid choice (sixteenths as the default) came from passages generated with an
assumed timing spread, not played by a person, so it is a good start and not a verdict on anyone's playing.

See [Playing in from a keyboard](keyboard-input.md) and [The Scratchpad](scratchpad.md).

## The timing of Listen

**What:** whether Listen sends the right bytes at the right times.

**How:** on a fake keyboard and a fake output in real Chrome, with the bytes and their time stamps read.

**Result:** Listen sent only note-ons and note-offs on the chosen channel. Stop left a note-off for every
note-on. In the music put the first note 0.05 ms from the music's own note of the same cycle line, and the
passes of a loop of two cycles began 2000 ms apart.

**What it does not say:** nothing was heard. Whether Listen sounds like the motif in the music on a real
synth, and whether notes that end 10 ms early sound in time, is for an ear. Stop on real hardware was not
tried.

See [The Scratchpad](scratchpad.md).

## Settings: the bytes, and what was heard

**What:** whether the tone, part and scene settings reach an instrument as the right bytes, and whether
they change the sound.

**How:** the bytes (address, value, checksum and order) were checked in a real browser against a fake
MIDI device, for every kind of setting and at the lowest and highest value of each range. Then the bench
script was run on a loopback port. Then the settings were heard, once each, on real instruments: one
JUPITER-Xm in three engines, an SC-55, and an MT-32 emulator, with values read back from the JUPITER-Xm
after every block.

**Result:** on the loopback, the messages that arrived were the messages the page had sent, in order. On the
instruments, tone, part and scene settings changed the sound as described on the settings page, and the
values read back matched what was sent.

**What it does not say:** in four earlier loopback runs, a second copy of a bank select pair arrived that
the page never sent. The cause was not found. It looks like something in the loopback, but that is not
proved, so the loopback is not full proof of what a real cable carries. Every instrument was tried in one
session. A change on a bar line and a replug were not tried, and several settings of the MT-32 rest on its
manual alone.

See [Tone, part and scene settings](synth-settings.md).

## Sessions with Claude

Two measurements asked fresh Claude sessions to do one thing each, and read what they wrote.

**Settings.** *What:* whether a plain request becomes settings at the right level. *How:* fresh sessions
were given one request each on a made-up instrument with a fake MIDI device, so nothing was heard, and
only the level and the names were judged. *Result:* "more delay on the lead" became the delay send of the
lead's part in 3 of 4 sessions, and 3 of those 4 also switched on the scene delay, which reaches every
part. "Put some drive on everything" became the scene's drive in 3 of 4 sessions. "Make the bass darker"
wrote tone settings on the bass in only 3 of 8 sessions, so it is not promised. The 6 sessions that read
the `settings` topic first passed every time, and 3 of the 10 that did not read it passed. *What it does
not say:* how any of it sounds, and how other models do.

**Motifs.** *What:* whether a motif sent from the Scratchpad is worked into the music at the right cycle.
*How:* ten fresh Claude Code sessions on a single model, each with only the Moontide tools and one real
request sent from a real page. Five motifs were drawn and five were played on a fake keyboard and
recorded. The bar was written down before the first session, and the cost of the sessions was capped.
*Result:* the notes were at the stated cycle in 10 of 10 sessions, and in 5 of 5 of the played ones. Both
promises made were met. *What it does not say:* it reads the code and not the sound, so nothing was heard.
In the five drawn sessions a plain loop of the phrase would have passed too. The played motifs came from a
fake keyboard. The answer in words for a motif that cannot be placed was not exercised.

See [Sending a motif to Claude](sending-a-motif.md) and [Tone, part and scene settings](synth-settings.md).

## What was verified

**Verified:**

- Each figure is copied from the record kept when it was measured, with its setup stated. The
  measurements were not repeated for this manual.
- The pages that describe each feature are linked, so a figure can be read next to what it is about.

**Not verified:**

- That a figure from one Mac, one Chrome and a loopback holds on your computer.
- A real keyboard, a real MT-32, Windows and Linux.
- Everything that is for an ear and was not heard, as each section says.
