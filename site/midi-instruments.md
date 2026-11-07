# MIDI instruments and the setup file

Moontide can play MIDI instruments from the code, through Web MIDI in your browser. This page shows
how to describe your instruments once, in a small file, and what Claude and the page do with that
description. The next pages cover [sounds and catalogs](midi-sounds.md) and
[tone, part and scene settings](synth-settings.md).

## What you need

- **Chrome or Edge.** Only these browsers have Web MIDI. See [Troubleshooting](troubleshooting.md)
  if the page says it is missing.
- **An instrument and its MIDI output port.** A hardware synth, a USB MIDI interface, or an emulator
  that shows up as a port on your computer.
- **The exact name of that port**, as your system lists it.

Nothing else is needed to try it. Without any setup file, Claude can still write `.midi()` code, and
the page tells Claude about problems as notices (see "Without the file" below). The setup file makes
Moontide know your instruments, so that Claude gets facts instead of guesses and a wrong port is
refused instead of playing into the void.

## The setup file

Describe your instruments in a file named `instruments.json` in the Moontide data folder. This is the
folder that holds the history file (see [History and favorites](history.md)); the environment variable
`MOONTIDE_DATA_DIR` moves it. You write the file yourself. Claude may propose its content in the chat,
but no tool writes it for you.

```json
{
  "instruments": [
    { "id": "mt32", "model": "mt32", "port": "Mt32EmuPort" },
    { "id": "sc55", "model": "sc55", "port": "UM-ONE", "channels": [1, 2, 3, 10] }
  ]
}
```

Each entry has:

- **id:** a short name you choose.
- **model:** the model it uses (see below).
- **port:** the exact name of its MIDI output port.
- **channels:** optional. The channels you use. Without it, the channels are the model's own.

The port names above are examples. Use the names your system lists.

The file is read again each time the page connects and each time the code changes, so an edit applies
without a restart.

### The two shipped models

A model holds the facts about a kind of instrument: its channels, sounds, controls and reset. Moontide
ships two models:

- `mt32`, for the Roland MT-32.
- `sc55`, for the Roland SC-55.

You can describe other instruments too (see "Models of your own" below). The shipped models do not
carry any tone, part or scene settings, and they do not follow the MIDI clock.

## What Claude does with the file

With the file in place:

- Claude reads your instruments with `get_midi_instruments`. It gets, as facts, the ports, the
  channels, the sounds and the controls of each instrument.
- Claude chooses a sound by name in the code, for example
  `.midi('UM-ONE', { midichannel: 3, sound: 'Str Sect 1' })`. The page sends the program change just
  before the new code takes over.
- A port, a channel or a sound that the file does not know fails the change. Claude is told the valid
  values, and the previous music keeps playing. A known port that is only unplugged is different: it
  stays a notice, because the cable may come back.
- A typo in the file is refused with the field and the reason, in Claude's reply and in the MIDI
  popover of the page. While the file is invalid, code that uses `.midi(` does not play. This is
  on purpose: a silent fallback could send notes to the wrong place.

## Reset, replug and waiting

- Each instrument is reset to a known state once each time it connects: when the page starts, after a
  replug, or when an emulator is started again. The reset is never sent on Play. Claude is told once.
- After a replug, the music waits for that instrument until its setup has gone out twice, which takes
  about 1.6 s. The instrument then comes back with its sounds and controls. The wait comes from a
  problem seen on a real SC-55: right after a replug it played wrong sounds from the right bytes, and
  the same bytes sent a little later fixed it.

## Volume and controls

The Mixer's fader and inspector move a MIDI instrument's own volume and the controls its model
declares. They are written into the code as `controls` in the `.midi()` options, for example
`.midi('UM-ONE', { midichannel: 3, controls: { volume: 90 } })`, and they need the setup file.

Muting or removing a MIDI track ends its notes, so a long note does not ring on after the track is
gone.

## Switching an instrument off

The Instruments view has an On and Off switch on each instrument's card. An instrument that is off goes
silent, like an unplug. It comes back with its reset and setup when you switch it on. Code that newly
aims `.midi()` at an instrument that is off is refused, with the reason, and the previous music keeps
playing.

The choice is kept in its own small file next to `instruments.json`, so your own file is never
changed by the switch. Claude is told about each change once.

## Without the file

Without `instruments.json`, `.midi()` works as plain Strudel does, with notices only: nothing is
checked against your instruments, and a wrong port name is a notice, not a refusal.

Web MIDI is asked for only by code that uses it. The browser's MIDI permission prompt appears when code
with a `.midi(` call plays, or at page start when you already granted it. If you never use MIDI, you
never see the prompt. The permission belongs to the page's address, so a Moontide on another port asks
again.

## The MIDI clock

Some instruments follow a clock: a hardware sequencer, an arpeggiator. Moontide can send them MIDI
clock, Start and Stop. Add `"clock": true` to the entry of the instrument:

```json
{ "id": "seq", "model": "my-sequencer", "port": "SYNTH-PORT", "channels": [3], "clock": true }
```

Here `my-sequencer` stands for a model of your own (see "Models of your own" below).

Moontide then sends the clock as long as the code names that instrument in a `.midi()` call, even in a
silent track such as `silence.midi('SYNTH-PORT', { midichannel: 3 })`. The clock counts four beats
per cycle, so `setcpm(120/4)` is 120 BPM. Stop stops the instrument too, and the clock follows a
tempo ramp step by step (see [Tempo ramps](tempo.md)). Moontide sends no Song Position Pointer, so a
follower always starts again from its beginning.

A model can say `clock` too, and the entry in your file wins. The shipped models say it is off.

What was heard: the clock was checked by ear on two instruments that follow it, a Roland JUPITER-Xm
arpeggiator and a Moog Subharmonicon. A steady tempo for two minutes, Start and Stop, an instrument
joining while the music plays (each one started on the next downbeat) and a tempo ramp down were
heard. A tempo ramp up was heard on the Subharmonicon only. During it the arpeggiator went off the beat,
and the person who tried it says that arpeggiator is known to be unpredictable.

The open problems, as found:

- After a Stop, clock ticks already queued still reach the instrument for up to about 150 ms, because a
  sent tick cannot be called back. After each Stop a follower was heard to jump to a faster tempo for
  an instant and play a few notes. This is probably the cause, but it is not proven.
- At a sudden tempo change, 100 BPM to 120 BPM, the arpeggiator did something odd and quickly
  recovered.
- The first beat of a Play leaves about 30 ms before the clock's Start. This was measured, not heard as
  a fault.
- A JUPITER-Xm arpeggiates notes that come by MIDI only when its external keyboard setting points to
  the input the cable uses (USB or DIN).

Other instruments that follow the clock have not been tried.

## Instruments that play one note at a time

A model can say that its instrument plays one note at a time, with `"monophonic": true` beside the
clock field. Claude then reads "Notes at once: one" for that instrument, and the Scratchpad's Listen
button warns when the motif holds a chord, since a chord would be heard as one note (see
[The Scratchpad](scratchpad.md)). Leaving the field out means unknown, not polyphonic. The shipped
models do not say it, so for them the warning never shows.

## Models of your own

An instrument that Moontide does not ship can still be described. Paste a page of its manual into the
chat and ask Claude to draft the model. Claude shows a short summary first: the channels, the sounds,
the controls, the reset bytes and the notes. It saves the model with `save_midi_model` only after you
say yes. The model goes to `models/<id>.json` in the data folder, never over a shipped model, and
never over one of yours unless you ask for it. Then use its id as `model` in `instruments.json`.

Check the reset bytes in the summary against your manual before you say yes, because the model later
reaches real hardware.

## What was verified

**Verified:**

- The reading of the setup file, its refusals, the reset once per connection, the wait after a replug,
  the controls, the muting of MIDI tracks and the On and Off switch are covered by automated tests,
  and the page's behavior with a fake MIDI device is checked in a real browser.
- The MIDI clock was heard on a JUPITER-Xm arpeggiator and a Moog Subharmonicon, in one session: a
  steady tempo for two minutes, Start and Stop, an instrument joining, and a ramp down. A ramp up was
  heard on the Subharmonicon only.
- The shipped models were used with a Roland SC-55 and the Munt MT-32 emulator.

**Not verified:**

- A wide tempo ramp across an arpeggiator's rate, Stop in the middle of a ramp, a replug while playing,
  a muted track keeping the clock, code that writes the clock itself, and the clock rows of the MIDI
  popover.
- The cause of the jump after a Stop is probable, not proven.
- Other instruments that follow the clock.
- A real MT-32.
- That the wait after a replug is long enough for every instrument and interface; it is a starting
  value.
- Windows and Linux.
