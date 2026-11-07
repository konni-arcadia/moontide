# Tone, part and scene settings

A synthesizer has settings that no program change carries: the filter cut-off of its current tone, the
pan of a part, the delay of the whole scene. Claude can set them in the code, in the `.midi()` options,
the way it sets a sound or a control. The level is the key of the option, and the values are in the
instrument's own units.

```js
note("c3 e3 g3 c4").midi('SYNTH-PORT', {
  midichannel: 1,
  sound: 'Saw Lead',
  tone: { filterCutoff: 600 },
  part: { pan: 40 },
  scene: { reverbLevel: 80 },
})
```

Because the settings are in the code, the history, a restored version and your hand edits keep them like
any other part of the music. Moontide stores no setting of its own. This page builds on
[MIDI instruments and the setup file](midi-instruments.md).

## Which instruments can take them

Only an instrument whose model describes settings. No shipped model does. The model that holds them is
your own file in the data folder (see "Models of your own" on the instruments page), and
`get_midi_instruments` lists the settings it declares. Three kinds of instrument can take settings, each
only when your own model describes them:

- **The Roland JUPITER-Xm**, in three engines. The Analog Synth Model tones were the first built and
  checked. The ZCore tones take the partial 1 cutoff and the tone coarse tune. The JUPITER-X model tones
  take the filter cutoff and resonance, with the same names as the first engine. When several engines
  share a name, the engine of the sound named in the call picks the right row, so the code is written
  the same way whatever the engine. A setting of another engine than the sound's is refused, naming both
  engines. Partials 2 to 4 of ZCore are not offered, because they were not heard.
- **The Roland SC-55**, with eight offsets of a part: the cut-off, the resonance, the vibrato rate, depth
  and delay, and the attack, decay and release. Each is a move from the sound's own value, not an
  absolute value. They are written 14 to 114, and 64 changes nothing. The lowest value is the largest
  move down, and it is never off or closed. Moontide never sends 64 by itself, so a changed value stays.
  A rhythm channel is refused.
- **The MT-32**, treated as a hardware MT-32: every numeric setting its manual documents, for the timbre
  of a part, the patch of a part and the whole instrument.

## The levels

- **tone:** belongs to the temporary tone of the part that the channel of the call plays.
- **part:** reaches that part only. Pan and the sends are part settings.
- **scene:** reaches every part of the instrument, not only the channel of the call that carries it.
  Claude's reply and the Instruments view say so.

A name written at the wrong level is refused, and the refusal says where it belongs. A value outside its
range is refused too, with the range. A refused change keeps the previous music playing and sends
nothing.

## How a channel becomes a part

The parts are counted in the order of the model's channels, so the lowest channel is part 1. A rhythm
channel that comes after four melodic ones is part 5, whatever channels you list in `instruments.json`.

## When settings are sent

Every setting the code writes is sent with every evaluation, not only what changed. Each channel gets
its bank select and program change first, then its tone settings, its part settings and its controls.
The scene settings follow after all the channels. A change that waits for a bar or phrase line sends them
at the line, with the sound. They go out again, with the sound, after a replug, after a reset and when
an instrument is switched on.

## What stays

Moontide stores no setting. The code is the only record.

- A setting taken out of the code is not sent again, and nothing undoes it. The instrument keeps the
  last value until the instrument itself changes it. For a tone setting, that is until the instrument
  loads the tone again. Claude is told, and the Instruments view says the same.
- A new sound on a channel loads the tone again on the JUPITER-Xm and, as heard on Munt, on the MT-32.
  The tone settings still in the code are sent right after it.
- What else undoes a setting differs from one instrument to another. On the JUPITER-Xm, part and scene
  settings survive a program change, and a scene chosen on the instrument undoes the settings of all
  three kinds. On the SC-55, 64 brought a changed cut-off back within one run, but what a program
  change or a reset does to an offset is not established, and the SC-55 cannot be read back. On the
  MT-32, a restart of Munt clears the edits.

## What can never be written

Moontide sends a setting only into an area that holds nothing for good, and it checks the message itself
just before it leaves.

- On the JUPITER-X family, only the temporary scene and the temporary tones of parts 1 to 4.
- On the MT-32, only the timbre areas, the patch areas, the master tune, reverb and master volume of its
  system area, and the display. Patch memory, timbre memory, the write request and the partial reserve
  are never sent. Its all-parameters reset passes only as the model's own reset when the instrument
  connects, never from the code, because it puts the factory contents back.
- The check holds on every port, whether or not the setup file is valid, and for the system exclusive
  messages that the code itself asks for. Messages of other makers and other models pass as before.
- A setting that a model maps to a control change is refused, because that has not been checked either
  way on a real instrument.

An instrument whose temporary areas Moontide does not know gets no settings at all.

## What to set on the instrument

- The JUPITER-Xm needs device ID 17, and its receive switches for system exclusive, program change and
  bank select on. For the scene chorus, delay and reverb, the system effect sources must be set to SCENE,
  or the instrument ignores the scene settings.
- The MT-32 data sets go out with the same device byte (unit number 17). Another unit number on an MT-32
  was not tried.
- The SC-55 must be in GS mode for its offsets.

## What Claude reads

The `settings` topic of Claude's Strudel reference holds the rules that are true on every instrument:
the levels, what each reaches, what is refused, when settings are sent, and that nothing is stored.
`get_midi_instruments` adds, for each instrument, the names and ranges of each level, and a Notes line
with what undoes a setting there and what was heard on it. The sound search gives the engine of each
sound. See [Asking Claude](asking-claude.md) for the reference topics.

## What was heard

All of this was tried by the person who built it, on one rig, in short sessions. The count and the
instrument are stated for each.

- **JUPITER-Xm, Analog Synth Model, one session, one scene.** A tone setting made the lead darker and
  then brighter again. A part setting moved the pan of one part to the left and to the right while the
  other stayed. A value taken out of the code stayed on the instrument. A scene change made on the
  instrument brought back the stored sound, and nothing was left in the instrument afterwards. The scene
  delay could not be judged by ear with those sounds; values read back from the instrument showed that the
  scene setting and the part sends had reached both parts. A change on a bar line and a replug were not
  tried.
- **JUPITER-Xm, ZCore, one session.** The partial 1 cutoff went darker and then more open, and the tone
  coarse tune moved the pitch down and up and back to normal, each at once. A new choice of the same sound
  undid them. Values read back from the instrument matched what was sent.
- **JUPITER-Xm, JUPITER-X model, one session.** The filter cutoff and resonance changed the sound at
  once. A new choice of the sound and a scene change made on the instrument undid them. The values read
  back matched.
- **SC-55, one session.** The cut-off offset made the sound darker, and 64 brought it back within the
  same run. A bright offset stayed after the sound was changed and changed back with the offset in the
  code, and stayed after the offset left the code. A vibrato was heard. The effect of a slow attack and
  release on a string sound could not be judged. Nothing can be read back from the SC-55.
- **MT-32 on the Munt emulator, one session.** Each setting is marked in the Notes line as heard on Munt,
  sent but not heard, or only documented.
  - Heard: the partial mute, the level of partial 1, the cutoff of partial 1 (much darker at 10, bright at
    100, with only partial 1 left), the key shift (an octave up was heard higher), the fine tune (a small
    step up was heard a little higher), the level of a part (weaker at 30) and the pan of a part (0 is the
    right side, 14 the left). With the partial mute set to 1, the sound moved to the right, twice; it did
    not get shorter or thinner, so what the mute value leaves playing is not settled.
  - Sent but not heard: the resonance of partial 1, and the reverb type and level (the reverb could not be
    judged on the sounds tried, which are not dry enough).
  - Only documented: every other setting. It rests on the manual alone.

Sessions with Claude, on a made-up instrument with a fake MIDI device, where nothing was heard and only
the level and the names were judged:

- "More delay on the lead" became the delay send of the lead's part in 3 of 4 sessions. In 3 of the 4,
  Claude also switched on the scene delay, which reaches every part, not only the lead.
- "Put some drive on everything" became the scene's drive amount and drive switch in 3 of 4 sessions. The
  fourth changed nothing.
- "Make the bass darker" is not reliable yet. Only 3 of 8 sessions wrote tone settings on the bass; the
  other 5 wrote no setting.
- Across all of them, the 6 sessions that read the `settings` topic before changing the code passed every
  time, and 3 of the 10 that did not read it passed.

## What was verified

**Verified:**

- The bytes of the settings (address, value, checksum and order) were checked in a real browser against a
  fake MIDI device, for all three kinds of instrument: every engine, the SC-55 offsets, and every MT-32
  setting at its lowest and highest value. The refusals, the value that stays, the bar line and a replug
  were checked there too.
- On a loopback port of one Mac, with nothing listening, the messages that arrived were the messages the
  page had sent, in order.
- What was heard is stated above, instrument by instrument.

**Not verified:**

- The loopback is not full proof of what a real cable carries: in four earlier runs a second copy of a
  bank select pair arrived that the page never sent, and the cause was not found.
- A change on a bar line, and a replug, on a real instrument.
- A ZCore or JUPITER-X model setting sent to a part holding another engine's tone: that it changes
  nothing you can hear was not checked. The page refuses it before it is sent.
- The SC-55: what a program change or a reset does to an offset on its own, whether the cutoff still
  changes above the range of the manual, and a slow attack and release.
- The MT-32: the reverb, the resonance of partial 1, the order of the four bits of the partial mute, the
  rhythm setup of each key, the one unexplained silence of Munt that a restart fixed, and the spacing
  between data sets on a real MT-32. A real MT-32 was not tried.
- Any other instrument.
