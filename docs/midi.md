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
  is 120 BPM. Stop stops the instrument too.
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
