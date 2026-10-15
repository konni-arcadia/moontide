# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-10-15

Pieces now declare their sections, and the page shows them, launches them and lets you edit them.

### Added

- A song structure. Every new piece Claude writes starts with one `const song` that names the
  sections with their lengths in cycles, says which version of each track plays in each section
  or that it rests, and may group tracks. It is still ordinary Strudel. A new reference topic,
  `structure`, holds the form, and the page tells Claude when it cannot read a structure or when
  what plays differs from what the structure declares.
- The Song grid. For a piece with a song, the Parts view shows the tracks under foldable groups,
  with one column per section. A click on a section header launches it on the next line the
  toolbar names, and a second click cancels it. A click on a cell picks another version of a
  track, or a rest, with your usual hand-edit timing. A fixed version says whether its notes fit
  the section's harmony, and the Jam view's Declared line follows the playing section.
- Groups in the Mixer. The groups of a song show as frames that fold together with the grid, and
  one click on a group's M or S mutes or solos every track below it as one change.
- Lights in the Mixer. A small light on each strip and each group blinks when its note is heard.
  With motion off, it stays lit while notes come.
- Editing notes on the Timeline. Click a note, then drag it or use the Up and Down keys to change
  its pitch, turn it into a rest with Delete, Backspace or "Make a rest", or change its velocity
  with two buttons. The page checks each edit before it writes it, and says first when one edit
  changes a note in several places.
- Requests for notes the page cannot edit. The gesture opens the Ask box with a ready-made
  request, and it goes to Claude only when you press Enter.
- A range of whole cycles on one lane of the Timeline, picked by dragging or with Shift and the
  Left and Right keys, that you can send to Claude.
- A right-click on a section, a track, a cell or a group asks Claude about it.

### Changed

- For a piece with a song, the Parts view is called Song.
- Play after Stop starts a piece with a song from its first section.
- A track written with the song helper no longer says that it is built from shared code.

## [2.0.2] - 2026-10-12

A maintenance release: nothing changes in how Moontide works.

### Added

- A short demo video with sound, linked from a poster image at the top of the README. The video is
  hosted on YouTube.

### Fixed

- The three tests that check that a refused page request prints nothing now send a valid request
  afterwards and wait for its line on the same output before they conclude. The 2.0.1 note said such
  tests made a round trip to the server first; that was not true of these three, which waited on a
  different output. The start test still waits a fixed 300 ms for a late log line.

## [2.0.1] - 2026-10-11

A maintenance release: nothing changes in how Moontide works.

### Added

- An npm version badge and a CI badge at the top of the README.

### Fixed

- A test wait for server log lines now fails with the log when it times out, instead of passing on quietly.
- Tests that check that something did not happen now make a round trip to the server first, so a slow
  machine cannot pass them too early.
- A test whose server fails to start now stops that server process.
- The wait for the page-request line has the same 10-second bound as the other waits.

## [2.0.0] - 2026-10-11

2.0.0 is the first public release. Earlier versions were never published.

### Added

- An MCP server that lets Claude play Strudel code in a browser page, with tools to write, edit,
  read and stop the code.
- The page: a Strudel editor with a timeline, a mixer, an instruments view and a session drawer.
  You can right-click anything in it to ask Claude about it.
- A session history of every version that plays, with favorites, kept in a local file.
- A factual Strudel reference for the exact Strudel version the page runs.
- MIDI instruments through Web MIDI: instrument and model files, sound catalogs, MIDNAM import
  and MIDI clock.
- Install through npx.
- Moontide starts when you ask for music or say start, not with every Claude session. Each page and its
  tab title name the folder and the port of their server.

[2.1.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.1.0
[2.0.2]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.2
[2.0.1]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.1
[2.0.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.0
