# MIDI instruments

This page shows how to describe your MIDI instruments and their sounds for Moontide.

## Your instruments

Describe your MIDI instruments once, in a file named `instruments.json` in the Moontide data
folder (the folder that holds `history.jsonl`; `MOONTIDE_DATA_DIR` moves it). You write the
file yourself. Claude may propose its content in the chat, but no tool writes it for you.

```json
{
  "instruments": [
    { "id": "mt32", "model": "mt32", "port": "Mt32EmuPort" },
    { "id": "sc55", "model": "sc55", "port": "UM-ONE", "channels": [1, 2, 3, 10] }
  ]
}
```

Each entry has a short id you choose, the model it uses, the exact name of its MIDI output
port and, optionally, the channels you use. Channels default to the model's own. The port
names above are examples: use the names your system lists.

Moontide ships two models, `mt32` (Roland MT-32) and `sc55` (Roland SC-55). With the file in
place:

- Claude reads your instruments with `get_midi_instruments`: ports, channels, sounds and
  controls, as facts. It chooses a sound by name in the code, for example
  `.midi('UM-ONE', { midichannel: 3, sound: 'Str Sect 1' })`, and the page sends the program
  change just before the new code takes over.
- A port, channel or sound that the file does not know fails the change with the valid
  values, and the previous music keeps playing. A known port that is only unplugged stays a
  notice.
- A typo in the file is refused with the field and the reason, in Claude's reply and in the
  MIDI popover of the page. While the file is invalid, code that uses `.midi(` does not play.
- Each instrument is reset to a known state once each time it connects (page start, a replug,
  Munt started again), never on Play. Claude is told once. After a replug the music waits for that
  instrument until its setup has gone out twice, about 1.6 s, so it comes back with its sounds and
  controls.
- The Mixer's fader and inspector move a MIDI instrument's own volume and the controls its model
  declares. They are written in the code as `controls` in the `.midi()` options, for example
  `.midi('UM-ONE', { midichannel: 3, controls: { volume: 90 } })`, and they need the file. Muting or
  removing a MIDI track ends its notes.
- Moontide can send MIDI clock, Start and Stop to an instrument that follows the clock, such as a
  sequencer or an arpeggiator. Add `"clock": true` to its entry in `instruments.json` (a model can
  say it too, and the entry wins; the shipped models say `"clock": false`). Moontide then sends the
  clock while the code names that instrument in a `.midi()` call, even in a silent track such as
  `silence.midi('UM-ONE', { midichannel: 3 })`. The clock counts 4 beats per cycle, so `setcpm(120/4)`
  is 120 BPM. Stop stops the instrument too. The clock follows a tempo ramp step by step.
- This was checked by ear on a Roland JUPITER-Xm arpeggiator and a Moog Subharmonicon: a steady tempo for two
  minutes, Start and Stop, an instrument joining while the music plays (each one started on the next
  downbeat) and a tempo ramp down. A tempo ramp up was heard on the Subharmonicon only: the
  arpeggiator went off the beat during it, and the user says that arpeggiator is known to be
  capricious. Not verified on either: a wide ramp across the arpeggiator's rate and Stop in the
  middle of a ramp. Other instruments that follow the clock have not been tried.
- Open problems with a follower. After a Stop, the clock ticks already queued still reach the
  instrument for up to about 150 ms, because a sent tick cannot be called back; after each Stop
  a follower was heard to jump to a faster tempo for an instant and play a few notes, which is
  probably that, but the cause is not proven. At a sudden tempo change from 100 to 120 BPM the
  arpeggiator did something odd and quickly recovered. The first beat of a Play leaves about 30 ms
  before the clock's Start (measured, not heard as a fault). A JUPITER-Xm arpeggiates notes that
  come by MIDI only when its external keyboard setting points to the input the cable uses (USB or
  DIN).
- A model can say that its instrument plays one note at a time, with `"monophonic": true` beside the clock field
  (a drafted model can say it when its manual does). Claude then reads "Notes at once: one" for that instrument, and
  the Scratchpad's Listen warns when the motif holds a chord, since a chord would be heard as one note. Leaving the
  field out means unknown, not polyphonic. The shipped models do not say it, so for them the warning never shows.
- The Instruments view switches each instrument on or off. An instrument that is off goes silent
  like an unplug, and comes back with its reset and setup when switched on. The choice is kept in
  its own small file next to `instruments.json`, and Claude is told about each change once.
- Without the file, `.midi()` works as before, with notices only.

An instrument Moontide does not ship can still be described. Paste a page of its manual in
the chat and ask Claude to draft the model. Claude shows a short summary first (channels,
sounds, controls, the reset bytes, the notes), and saves it with `save_midi_model` only after
you say yes. The model goes to `models/<id>.json` in the same folder, never over a shipped
model, and never over one of yours unless you ask for it. Then use its id as `model` in
`instruments.json`.

## Synth settings

A synthesizer has settings that no program change carries: the filter cut-off of its current tone,
the pan of a part, the delay of the whole scene. Claude can set them in the code, in the `.midi()`
options, the way it sets a sound or a control. The level is the key of the option, and the values
are in the instrument's own units:

```js
note("c3 e3 g3 c4").midi('SYNTH-PORT', {
  midichannel: 1,
  sound: 'Saw Lead',
  tone: { filterCutoff: 600 },
  part: { pan: 40 },
  scene: { reverbLevel: 80 },
})
```

- **Which instruments:** only an instrument whose model describes settings. No shipped model does. The model
  that holds them is your own file in the data folder, and `get_midi_instruments` lists the settings it
  declares. Three kinds of instrument can take them, each only when your own model describes them:
  - The Roland JUPITER-Xm, in three engines. The Analog Synth Model tones were the first built and checked.
    The ZCore tones take the partial 1 cutoff and the tone coarse tune (`partial1Cutoff`, `toneCoarseTune`).
    The JUPITER-X model tones take the filter cutoff and resonance, with the same names as the first engine
    (`filterCutoff`, `filterResonance`). A name that several engines share has one row per engine in the
    model, and the engine of the sound named in the call picks the row, so the code is written the same
    way whatever the engine. A setting of another engine than the sound's is refused, naming both engines.
    ZCore partials 2 to 4 are not offered: they were not heard.
  - The Roland SC-55, with eight offsets of a part: `cutoffOffset`, `resonanceOffset`, `vibratoRateOffset`,
    `vibratoDepthOffset`, `vibratoDelayOffset`, `attackOffset`, `decayOffset` and `releaseOffset`. They are
    part settings, and each is a move from the sound's own value, not an absolute value: they are written
    from 14 to 114 and 64 changes nothing. The lowest value is the largest move down, and it is never off or
    closed. Moontide never sends 64 by itself, so a changed value stays. Each goes out as five control
    changes (an NRPN, with the closing pair that leaves no parameter open) on the channel of its call, right
    after the program change of that channel. A rhythm channel is refused.
  - The MT-32, treated as a hardware MT-32: every numeric setting its owner's manual documents, for the
    timbre of a part (the common block and four partials), the patch of a part and the whole instrument.
    A program change reloads the timbre together with the patch's key shift, fine tune, bender range, assign
    mode and reverb switch (the manual's description; only the timbre was heard on Munt), so those are tone
    settings. The patch's level and pan are part settings, which the manual says a program change leaves
    alone. The system rows (master tune, the reverb mode, time and level, and the master volume) are scene
    settings and reach every part. The parts are the eight on the channels of the model; the timbre areas of
    the parts are 246 bytes apart and the patch areas 16.
- **What each MT-32 setting is marked:** heard on Munt, sent but not heard, or only documented.
  - Heard on Munt: the partial mute, the level of partial 1, the cutoff of partial 1 (much darker at 10,
    bright at 100, with only partial 1 left), the key shift (an octave up was heard higher), the fine tune
    (a small step up was heard a little higher), the level of a part (weaker at 30) and the pan of a part
    (0 is the right side, 14 the left). With the partial mute set to 1 the sound moved to the right, twice;
    it did not get shorter or thinner, so what the mute value leaves playing is not settled.
  - Sent but not heard: the resonance of partial 1, and the reverb type and level (the reverb could not be
    judged on the sounds tried, which are not dry enough).
  - Only documented: every other setting. It rests on the manual alone, and nothing says yet that the
    instrument acts on it. Where the manual is not exact, the point is open: the order of the four bits of the
    partial mute (which bit is which partial, and whether a set bit mutes or plays), the pitch the master
    tune moves, and how a bias point value maps to a note and a direction.
  - The mark of each setting is in the Notes line of the instrument in `get_midi_instruments`, once the notes
    of your own model say it.
- **Not offered, and why:**
  - Patch memory, timbre memory and the write request. They keep sounds, and Moontide writes no memory.
  - The timbre name and the display text. They are text, not a sound setting.
  - The MIDI channel of each part and the partial reserve. A channel would move the parts off the channels of
    the setup file. The reserve of the nine parts must be sent together, and their sum may not pass 32, which
    one value per setting cannot keep.
  - The rhythm setup per key (a timbre, level, pan and reverb switch for each of 64 keys). A setting per key
    has no written form yet; it waits for a choice of how a key's setting is written.
  - The patch of the rhythm part. The manual prints no layout of its own for it, so the rhythm part has no
    tone or part setting.
  - ZCore partials 2 to 4, and a control change setting (below).
- **What each level reaches:** a `tone` setting belongs to the temporary tone of the part that the
  channel of the call plays. A `part` setting reaches that part only. A `scene` setting reaches every
  part of the instrument, not only the channel of the call that carries it; the reply to Claude and
  the Instruments view say so. A name written at the wrong level is refused, and the refusal says where
  it belongs.
- **How a channel becomes a part:** the parts are counted in the order of the model's channels, so the
  lowest channel is part 1. A rhythm channel that comes after four melodic ones is part 5, whatever
  channels you list in `instruments.json`.
- **When they are sent:** every setting the code writes is sent with every evaluation, not only what
  changed. Each channel gets its bank select and program change first, then its tone settings, its part
  settings and its controls, and the scene settings follow after all the channels. A change that waits
  for a bar or phrase line sends them at the line, with the sound. They go out again, with the sound,
  after a replug, after a reset and when an instrument is switched on.
- **What stays:** Moontide stores no setting. The code is the only record. A setting taken out of the code is
  not sent again and nothing undoes it: the instrument keeps the last value until the instrument itself
  changes it, and a tone setting until the instrument loads the tone again. A new sound on that channel loads
  the tone again on the JUPITER-Xm and, as heard on Munt, on the MT-32. A program change from Moontide
  brings back the stored tone, so the tone settings still in the code are sent right after it. What else
  undoes a setting differs from one instrument to another, and is in the Notes line of that instrument in
  `get_midi_instruments`. What is established is thin. On the JUPITER-Xm, part and scene settings survive a
  program change, and a scene chosen on the instrument undoes the settings of all three levels (heard with
  the first engine, and read back with the other two). On the SC-55, 64 brought a changed cutoff back within one run, but what a program
  change or a reset does to an offset is not established, and the SC-55 cannot be read back. On the MT-32 a
  restart of Munt clears the edits; the rest is the manual's description. Claude is told when a setting has
  left the code, and the Instruments view says the same.
- **What Claude reads:** the settings topic of Claude's Strudel reference (the three levels and what each
  reaches, the names, a name that several engines share, the names that end in Offset, what is refused, when
  settings are sent, that nothing is stored, the NRPN rule and the system exclusive check), the Settings
  lines of `get_midi_instruments` (the names and ranges of each level, the tone ones per engine), its
  Notes line for each instrument (what undoes a setting there, the value that changes nothing for an offset,
  the mark of each setting), and the engine of each sound in the sound search results. Every fact of the
  topic is pinned to a check in a real browser against a fake MIDI device, and to a unit test, or is named
  as a fact of the instrument that the page cannot show.
- **Measured with Claude:** fresh Claude sessions were given one plain request each, on a made-up
  instrument with a fake MIDI device (nothing was heard). Only the level and the names were judged,
  never how it sounds. "More delay on the lead" became the delay send of the lead's part in 3 of 4
  sessions; 3 of the 4 also switched on the scene delay, which reaches every part of the instrument, not
  only the lead. "Put some drive on everything" became the scene's drive amount and drive switch in 3 of
  4 sessions; the fourth changed nothing. "Make the bass darker" is not reliable yet: only 3 of 8 sessions
  wrote tone settings on the bass; the other 5 wrote no setting (where the code was recorded, the bass
  was moved lower and made softer instead). Across all the sessions, the 6 that read the settings topic before changing the code passed
  every time, and 3 of the 10 that did not read it passed.
- **What can never be written:** Moontide sends a setting only into an area that holds nothing for good,
  and the check is made on the message itself, just before it leaves. A Roland system exclusive message for
  the JUPITER-X family (model ID 00 00 00 65) must be a data set whose every address, up to its last byte,
  lies in the temporary scene or the temporary tones of parts 1 to 4. A message for the MT-32 (model ID 16)
  must be a data set whose every address lies in the timbre area of a part, the patch area, the patch and setup areas of the
  rhythm part, the master tune, reverb and master volume of the system area, the display text or the display reset; patch
  memory, timbre memory, the write request and the partial reserve and MIDI channel of each part are never sent. The one all-parameters reset passes only when Moontide sends it as the shipped model's reset when the instrument
  connects, never from the code, since it puts the factory contents back. Any
  other is not sent. That holds on every port, whether or not the setup file is valid, and for the system
  exclusive messages that the code itself asks for, whatever shape the code gives them: every byte is read
  the way the browser sends it, and a buffer with several messages is checked whole. So the code's own MT-32
  data sets into patch or timbre memory are now dropped on every port, where before they passed, and so is
  its all-parameters reset; its display and its temporary areas pass. GS messages and the messages of other makers and other
  models pass as before, so the code can still send them to the instruments that take them. An NRPN is sent
  only for a family Moontide knows (the GS part offsets) and a pair on the model's list, and is checked
  again against the rig when it is sent. A setting that the model maps to a control change is refused: it
  has not been checked either way on a real instrument. An instrument whose temporary areas Moontide does
  not know gets no settings at all.
- **On the instrument:** the JUPITER-Xm needs device ID 17, and the receive switches for system exclusive,
  program change and bank select on. For the scene chorus, delay and reverb, the system effect sources must
  be set to SCENE, or the instrument ignores the scene rows. The MT-32 data sets go out with the same
  device byte (10 in hexadecimal, unit number 17); another unit number on an MT-32 was not tried. The SC-55
  must be in GS mode for its offsets.
- **What was checked:** the bytes (address, value pieces, checksum and order) in a real browser against a
  fake MIDI device, for all three levels on the three kinds of instrument: the other two JUPITER-Xm engines
  at their own addresses, the SC-55 offsets as five control changes on the channel of their call, and every
  setting of the MT-32 at its lowest and highest value at the part spacing of its area. Also the value that
  stays, the refusals, the bar line and a replug. On a loopback port of one Mac, with nothing listening, the
  runs of the bench script for the three newer kinds (the engines, the offsets and the MT-32 timbres)
  delivered exactly the messages the page had sent, in order, and the first engine's runs did the same. In
  four earlier runs a second copy of the bank select pair arrived that the page never sent (its own log
  showed one send). The cause was not found. It looks like something in the loopback, but that is not
  proved, so the loopback is not offered as full proof of what a real cable carries. The bench line lists
  any message that arrived without being sent and any that was sent and did not arrive.
- **Heard on the instrument: checked once, on one JUPITER-Xm.** With the page's own settings, a
  tone setting made the Analog Synth Model lead darker and then brighter again, a part setting moved
  the pan of one part to the left and to the right while the other stayed, a value taken out of the code
  stayed on the instrument, a scene change made on the instrument brought back the stored sound and
  nothing was left in the instrument afterwards. The scene delay could not be judged by ear with
  those sounds; the values read back from the instrument showed that the scene setting and the part
  sends had reached both parts. A change on a bar line and a replug were not tried. One session, one
  instrument, one scene.
- **Heard on the other engines and instruments: checked once each, on the bench of the same day.**
  - ZCore, on one JUPITER-Xm: on a part holding a ZCore tone, the partial 1 cutoff and the tone coarse tune
    changed the sound at once (the cutoff went darker then brighter; the pitch went down then up and came
    back normal), a new choice of the same sound undid them, and a scene change made on the instrument undid
    the tune (read back from the instrument).
  - JUPITER-X model, on one JUPITER-Xm: the filter cutoff and resonance of a part holding a JUPITER-X model
    tone changed the sound at once ("the filter and the resonance moved as expected"), and both a new choice
    of the sound and a scene change made on the instrument undid them (read back from the instrument).
  - SC-55: the filter, vibrato and envelope offsets each changed the sound at once, as scripts sent them
    before Moontide did. The sound was not compared with its earlier self from memory.
  - MT-32, on Munt: a data set into the timbre area of a part reaches Munt and is applied at once; the level
    of partial 1 and the partial mute work; a new choice of the sound brings the stored timbre back, and a
    restart of Munt clears the edits.
- **Heard through Moontide's own tools: one bench, one session, one rig.** The same settings were then set
  from the code with `set_code`, one block at a time, and the user said whether the sound moved.
  - ZCore, on one JUPITER-Xm: the partial 1 cutoff went darker, then more open, and the tone coarse tune moved
    the pitch down and up by a fifth, each at once. After every block the values were read back from the
    instrument and matched what was sent (cutoff 0 and 1023, coarse tune 57 and 71).
  - JUPITER-X model, on the same instrument: the filter cutoff went darker, then more open, then darker at
    half, and the resonance was heard when raised, each at once. The values read back matched (cutoff 0, 1023
    and 600, resonance 900). The display showed the JUPITER-X model engine for the tone.
  - SC-55: a cutoff offset of 30 made the sound darker than the chord just before, and 64 brought it back
    within the same run; a bright offset (100) was heard bright, was still bright after the sound was
    changed and changed back with the offset in the code, and stayed bright after the offset left the code;
    a vibrato was heard. The effect of a slow attack and release on a string sound could not be judged.
    Nothing can be read back from the SC-55.
  - MT-32, on Munt: see the marks above. A new choice of the sound again brought back the stored timbre after
    an edit, and a restart of Munt cleared the edit. Nothing can be read back from Munt.
- **Still open:**
  - A ZCore or JUPITER-X model setting sent to a part holding another engine's tone: that it changes nothing
    you can hear was not checked (the page refuses it before it is sent).
  - The SC-55: what a program change or a reset does to an offset on its own, whether the cutoff still
    changes above the panel range of the manual, and the slow attack and release (not judged).
  - The MT-32: the reverb rows, the resonance of partial 1, the bit order of the partial mute and what a
    mute value leaves playing, and the rhythm setup per key.
  - Hardware spacing between data sets on a real MT-32: Munt may not need what a real instrument needs. A
    real MT-32 was not tried.
  - The one unexplained silence of Munt, fixed by a restart.

## Sound catalogs

Some instruments hold thousands of sounds, too many for a model file. A catalog lists them for
one model, in `catalogs/<model id>.json` in the same data folder. It never lives in Moontide,
and a catalog holds melodic sounds and, for an instrument whose rhythm channels take a bank, its
drum kits. Each sound has a name, a program, a bank when the instrument needs one, and a category
when the list has one. A catalog holds up to 5,000 sounds.

Once a catalog exists for a model that `instruments.json` uses, Claude finds sounds in it with
`search_midi_sounds`: by words of the name or by category, at most 25 matches at a time, each
with its bank and program. It then chooses one with the same `sound` option as any other sound.
`get_midi_instruments` only counts the catalog and names its categories. A catalog that is
broken stops code that uses `.midi(` until it is fixed, like a broken `instruments.json`.

`get_midi_instruments` also gives each instrument's drum map, which note plays which drum. The
SC-55 and MT-32 maps come from their manuals, and General MIDI is built in. The Timeline and the
Instruments view show drum names where a map is known, and say so where it is not.

### Import a MIDNAM file

Many patch lists exist as MIDNAM files (an XML format for patch names). Import one with:

```bash
npx -y moontide-mcp import-midnam <file> --model <id>
```

The model must exist first (a shipped one, or one saved with `save_midi_model`). Moontide
prints a summary: how many sounds it took, the first and the last one, and how many it skipped,
merged or renamed (two sounds with one name get their bank and program added to the name).
`--replace` replaces an existing catalog; without it an existing catalog is left as it is. A file
Moontide cannot read is refused with the reason and nothing is written. The server reads the
catalog at its next change.

A good place to look for MIDNAM files is Ardour's patch file collection, the `share/patchfiles`
folder of the Ardour source repository (https://github.com/Ardour/ardour/tree/master/share/patchfiles).
That repository is under the GPL version 2 or later. The files carry no license of their own and
come from several authors, so each one has its own provenance and terms, and you answer for what
you import. Moontide never downloads, copies or ships a patch list: you give it the file.

`moontide-mcp` takes one subcommand, `import-midnam`. With no argument it starts the server.
`--version` prints the version. Any other argument is refused with exit code 2.

### From a PDF

If the maker only publishes a PDF sound list, give the PDF to Claude. Claude reads it (Moontide
has no PDF reader), drafts the catalog and sends it to `save_midi_catalog`. The first answer is a
summary, with nothing written: the number of sounds, the categories, and three sounds (first,
middle, last) with their program as sent and as printed in the list, so a shift by one is
visible. Claude shows it to you, and the catalog is saved only after you say yes. A long list goes
in parts of at most 500 sounds in one session, and the summary comes after the last part. Moontide
keeps the unsaved draft in memory only: a restart of Moontide loses it, and Claude starts again.
An existing catalog is never replaced unless you asked for it.

## Playing into the page

You can play a motif on a MIDI keyboard. The page hears it, places each note on the music's cycle by the
time stamp the system gives the note, keeps the last cycles in a rolling buffer, shows it on the Scratchpad's roll as you play,
and "Record that" turns the buffer into the motif on the roll after the fact. Nothing you play is sent to an
instrument: playing only listens. The page sends the motif to an instrument only when you press Listen (see
"Hearing a motif" below).

Name your keyboard in `instruments.json`, with an `inputs` list beside `instruments`:

```json
{
  "instruments": [
    { "id": "mt32", "model": "mt32", "port": "Mt32EmuPort" }
  ],
  "inputs": [{ "port": "My Keyboard" }]
}
```

- **The name.** Write the exact and full name of the input port, as your system lists it. If the name is
  not connected, the Scratchpad says so and lists the inputs it does see (once MIDI is allowed), so a first
  try shows you the right name. Unlike an output, an input is never matched by a part of its name. At most 4 inputs. The list is optional, and a file still needs its instruments. You write the
  file yourself: Claude may propose the line in the chat, but nothing writes it for you, and a change made
  from the Instruments view keeps your `inputs` as they are.
- **Permission.** Listening needs the same browser permission as the MIDI output. The page asks once. The
  first time it asks only when you press "Allow MIDI to listen" in the Scratchpad, never by itself.
- **When it listens.** In every view, while the page's tab is visible and holds the music. A tab that is
  hidden, or has lost the music to another tab, listens to nothing and says so, so there is never a second
  buffer. Showing the tab again listens again, with no reload. A window covered by another window may or
  may not count as hidden, depending on the system.
- **What it hears.** Notes, on every channel. The sustain pedal, pitch bend, aftertouch, other controllers,
  clock and active sensing are ignored. A note from a device that sends no time stamp, a stamp of 0 or a
  stamp too far from the present is refused and said, never placed at a guess.
- **The buffer.** It keeps the 8 whole cycles that end with the current one, which is the longest motif the
  roll holds. It lives in memory only, so a reload empties it. A note from before the window is cut at its
  edge, a held note is closed when the cable is unplugged, the tab is hidden or the setup changes, and the
  buffer keeps at most 2000 notes (the newest ones are not kept past that, and the status says so).
- **Seeing the buffer as you play.** While the Scratchpad is open and an input is listened to, the roll shows
  the buffer's 8 cycles under a playhead that runs across them and starts again at the end. Each note you play
  appears in the accent colour as you play it, a key you hold lights its key in the pitch column and its note
  grows, and the roll gains rows if you play a pitch it did not show. Before the first note, the roll shows where
  the music is, so you can feel the beat. The ruler numbers the 8 columns 1 to 8, which are not the music's own
  cycle numbers. This view only reads: it sends nothing to an instrument.
- **Record that.** It replaces the motif on the roll with what the live view shows, in one step that Undo takes
  back: the notes are placed on the same 8 columns, quantized to the roll's grid, with the velocities as played (in
  hundredths), and the empty cycles before the first note are dropped, so the motif starts at the cycle of
  your first note and lasts up to the last. No phrase is guessed; cleaning is left to you or to Claude. A note the
  roll cannot show (outside C0 to B8) is left out, and the line says how many. It writes nothing to the History or
  to the code. After the press the buffer is empty: pressing again says there is nothing to record, and Undo brings
  back the earlier motif but not the notes. A take that starts in the last cycle of the 8 and goes on into the first
  is written as it lies on the ring, the later bar first.
- **Sending a recorded motif.** A motif made by Record that and sent with Send to Claude carries the music's cycle where
  it was played, so Claude can place it there. If it was played with the music stopped, or its notes come from more than
  one run of the music (a Stop and a Play between them) or from two laps of the 8 columns, it carries no cycle and is
  sent with no moment. Align keeps the moment: the same take sent before and after an Align names the same cycle with a
  different phrase.
- **With the music stopped.** The page keeps listening and keeps counting cycles by the tempo, so a
  motif can be played with no music running, and Record that works. The cycle count never goes back: on
  Play it moves on to the next whole cycle of the music, so the music's downbeats stay downbeats. Notes
  played before a Play have no meaningful place against the new music.
- **The status.** The Scratchpad says in its own words why it is not listening: no `instruments.json`, a
  file with a problem, no input named, MIDI not allowed yet (with the button), refused by the browser, no
  Web MIDI, another tab holding the music, a hidden tab, an input name that is not connected (with the
  inputs that are), an input that was unplugged (it listens again by itself when plugged back in), or
  two inputs with the same name.

The timing of a played note was measured before the input was built, and the rule, the margin and the
conditions are in the decision "A played note is placed by its own time stamp" in `docs/decisions.md`. The
choices of the keyboard and its buffer are in "A keyboard fills a rolling buffer, and Record that takes it".

- **Checked:** `npm run bench:midi -- --input` plays the page's own input on a loopback port in real
  Chrome. At 60, 90, 120, 140 and 180 BPM, with the music playing and with it stopped, every note landed
  on its place within 6 ms (the worst error was 0.33 ms).
- **Not verified:**
  - A real keyboard's own delay. The loopback adds none, so it cannot show it, and a real keyboard was not
    tried: its plug and unplug, a played passage and its time stamps are left to the person who owns one.
  - A guitar-to-MIDI unit, which makes many weak extra notes and a tracking delay of its own.
  - Windows and Linux time stamps: the numbers are from one Mac and one Chrome.
  - A source that sends no time stamp. Such a note is refused and said, never placed at a guess.
  - Whether a window covered by another window counts as hidden, on each system.
  - A real keyboard playing a motif that is recorded and sent to Claude: its moment was checked with a fake keyboard only.
  - How the live view feels with a real keyboard: whether the playhead and the live notes make it easy to land in the bar. The
    checks use a fake keyboard.

## Hearing a motif

The Scratchpad's Listen button plays the motif on the roll on one of your instruments, so you can hear it before you send it to
Claude. It uses the page's own MIDI layer, the one that sends the music's notes, and it needs the `instruments.json` file. It sends
only on your press.

- **Choosing where.** The menu lists each instrument of your file with each of its channels, for example `mt32 · channel 3`. The
  output is found by a part of the instrument's port name, as the music's own `.midi()` ports are. If no output contains the name,
  or several do, Listen says so and plays nothing. An instrument you switched off is in the list, and Listen on it says why it did
  not play.
- **No sound change.** Listen sends note-on and note-off and nothing else: no program change, no controller, no reset. The sound on
  the channel is the one the music or you already set there, which is the sound the motif will have in the music.
- **In the music and At once.** In the music, the default, waits for the next cycle line of the music and plays from there, so the
  motif falls on the beat; the line says which cycle it waits for. It needs the music playing, and says so if it is not. At once
  plays now, with or without music.
- **Loop.** With Loop on, the motif starts again after its last note (on the music's cycle lines for In the music), and a change you
  make on the roll is heard on the next pass.
- **Stop.** It ends the play and sends a note-off for each note that sounds and for each note already on its way. It does not send
  All Notes Off, so a track of the music on the same channel keeps playing.
- **What stops a play by itself.** A tab that is hidden (a hidden tab cannot keep time), another view opening or the Scratchpad
  closing, leaving the page, the output being unplugged, and, for In the music, the music stopping. Each is said in plain words.
- **The first press.** If the page has not asked for MIDI yet, the first Listen press asks for it (through the same single prompt)
  and says it waits; Stop cancels. Allowing MIDI makes the page reset the instruments it finds, so a press right after the allow
  can be answered with "try again in a moment"; the next press plays.
- **Heads up.** Two sentences can appear next to the state of Listen, and neither stops it. One says a track of the playing code
  that is not muted uses the same instrument and channel, so both would sound on it. The other says the instrument plays one note
  at a time and the motif holds a chord, so the chord would be heard as one note; it needs `"monophonic": true` in the instrument's
  model (see "Your instruments"), which the shipped models do not have.
- **What it does not do.** Listen changes no code, adds nothing to the History and sends no request to Claude. Your choice of
  instrument and channel, the Start choice and Loop are not stored: a reload resets them.

- **Checked:** on a fake keyboard and a fake output in real Chrome, Listen sent only note-ons and note-offs on the chosen channel,
  Stop left a note-off for every note-on, In the music put the first note 0.05 ms from the music's own note of the same cycle line,
  and the passes of a two-cycle loop began 2000 ms apart.
- **Not verified:**
  - Hearing it: whether Listen sounds like the motif in the music on a real synth, and whether the notes that end 10 ms early sound
    in time. Only the bytes and their time stamps were read.
  - Stop on real hardware: that a held note is silent on a real instrument after Stop.
  - The first press after allowing MIDI on a real system, where the instrument's reset may take longer than in the checks.
  - The Heads up sentence about one note at a time: no shipped model claims it, and it was checked by unit tests only, not in
    real Chrome and not with a real instrument.
