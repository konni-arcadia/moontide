# Sounds, catalogs and drum maps

Some instruments hold thousands of sounds. This page shows how Claude finds a sound by its name, how
you give Moontide a list of the sounds of your instrument, and how drum names are shown. It builds on
[MIDI instruments and the setup file](midi-instruments.md).

## Sounds by name

Claude chooses a sound in the `.midi()` options with `sound: 'name'`. The name is part of the code, so
the history, a restored version, your hand edits and the Mixer all keep it. The shipped models list
their own sounds, and `get_midi_instruments` gives them to Claude.

## Catalogs

A model file is too small for an instrument with thousands of sounds. A catalog lists them for a single
model, in `catalogs/<model id>.json` in the data folder, the same folder as `instruments.json`. A catalog never
lives inside Moontide. It holds melodic sounds and, for an instrument whose rhythm channels take a
bank, its drum kits. Each sound has a name, a program, a bank when the instrument needs one, and a
category when the list has one. A catalog holds up to 5,000 sounds.

Once a catalog exists for a model that `instruments.json` uses:

- **Finding:** Claude searches it with `search_midi_sounds`, by words of the name or by category. It gets
  at most 25 matches at a time, each with its bank and program.
- **Choosing:** Claude then chooses one with the same `sound` option as any other sound.
- **Counting:** `get_midi_instruments` only counts the catalog and names its categories.

A catalog that is broken stops code that uses `.midi(` until it is fixed, like a broken
`instruments.json`. A silent fallback would play the wrong sound. A catalog of a model that no entry
uses is never read.

## Drum maps

`get_midi_instruments` also gives each instrument's drum map, which says which note plays which drum.
The maps of the SC-55 and the MT-32 come from their manuals, and General MIDI is built in. The Timeline
and the Instruments view show drum names where a map is known, and say so where it is not. The code
keeps writing note numbers: the names are only for reading.

## Import a MIDNAM file

Many patch lists exist as MIDNAM files, an XML format for patch names. Import one with:

```bash
npx -y moontide-mcp import-midnam <file> --model <id>
```

The model must exist first, either a shipped one or one saved with `save_midi_model`. Moontide prints a
summary: how many sounds it took, the first and the last one, and how many it skipped, merged or renamed.
Two sounds with one name get their bank and program added to the name.

- **`--replace`** replaces an existing catalog. Without it, an existing catalog is left as it is.
- A file that Moontide cannot read is refused with the reason, and nothing is written.
- The server reads the catalog at its next change.

A good place to look for MIDNAM files is the patch file collection of the Ardour project, the
`share/patchfiles` folder of its source repository at
https://github.com/Ardour/ardour/tree/master/share/patchfiles. That repository is under the GPL
version 2 or later. The files carry no license of their own and come from several authors, so each one
has its own provenance and terms, and you answer for what you import. Moontide never downloads, copies
or ships a patch list: you give it the file.

The `moontide-mcp` command takes one subcommand, `import-midnam`. With no argument it starts the server.
`--version` prints the version. Any other argument is refused with exit code 2.

## A catalog from a PDF

If the maker only publishes a PDF sound list, give the PDF to Claude. Moontide has no PDF reader, so
Claude reads it, drafts the catalog and sends it to `save_midi_catalog`.

- The first answer is a summary and nothing is written: the number of sounds, the categories, and three
  sounds (the first, the middle and the last) with their program as sent and as printed in the list, so
  a shift by one is visible.
- Claude shows you the summary. The catalog is saved only after you say yes.
- A long list goes in parts of at most 500 sounds in one session, and the summary comes after the last
  part.
- Moontide keeps the unsaved draft in memory only. A restart of Moontide loses it, and Claude starts
  again.
- An existing catalog is never replaced unless you asked for it.

## What was verified

**Verified:**

- The reading of catalogs, the search, the MIDNAM import, the two-step save and the refusals are covered
  by automated tests, and the import was tried on a file written for the tests.
- A catalog of 5,000 sounds was measured at about 330 KB and a few milliseconds to resolve.

**Not verified:**

- A catalog, imported or saved from a PDF, checked against the display of the real instrument it
  describes: a check that would show a shift by one program is not on record.
- The drum kits of a JUPITER-Xm: that path follows the printed bank numbers and has not been heard on
  the instrument. No JUPITER-Xm model ships.
- The SC-55 drum sets and the order of its banks, by ear.
- The terms of the files you import; they are yours to check.
