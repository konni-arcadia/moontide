# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.3] - 2026-11-07

A maintenance release. It carries two small fixes found by the first code scan.

### Fixed

- The chord reader of the harmony check no longer slows down on a long run of slash chords with an
  altered bass note. Typed text could not reach that case; every chord read before still reads.
- A failed step in the page now logs its context as written, even when the context holds a `%`.

### Changed

- Code scanning leaves out the real-browser check scripts and the unit tests, which run only locally:
  they send code to a test page on purpose, so their findings were noise.
- The Node types move to 22.20.5.

## [2.4.2] - 2026-11-07

A maintenance release. Nothing changes in Moontide itself.

### Security

- Dependency updates with security fixes: zod 4.6.7, and body-parser, hono, @hono/node-server, fast-uri
  and ip-address raised within their ranges. `npm audit` reports no known vulnerability.

### Changed

- Minor updates: the MCP SDK 1.32.2, ws 8.22.1, and newer pinned versions of the GitHub Actions used
  by the workflows.
- Dependabot no longer proposes a major version of the Node types, which follow the oldest supported
  Node, nor acorn, which the page pins together with its integrity hash.

## [2.4.1] - 2026-11-07

A maintenance release. Nothing changes in Moontide itself.

### Added

- A `glama.json` file that names the maintainer for the Glama MCP directory.
- Code scanning with CodeQL on the JavaScript and TypeScript sources: on every push to main, every pull
  request to main, and once a week.
- Dependabot, kept quiet: at most one grouped pull request a month for npm and one for GitHub Actions.
  This repository is a mirror, so such a pull request is not merged here: the update lands in a
  release.

## [2.4.0] - 2026-11-07

Moontide is early: a young project with known bugs, tried on one setup. The whole Scratchpad is early
experimental: the piano roll, playing in from a MIDI keyboard, Record that, Listen and sending a motif
to Claude are new and may still change in how they look and how they work.

A known problem in the Scratchpad: a key held while you play in is often recorded as a very short note.
Check the lengths on the roll before you send a played motif.

This release carries two pieces of work together: the settings of an instrument's tone, parts and scene,
and the Scratchpad. The version number skips 2.3, because the settings work prepared for it was never
released and ships here.

Not yet checked by hand: how hardware that follows the MIDI clock reacts to a wide tempo ramp across
an arpeggiator's rate and to a Stop in the middle of a ramp. "Make the bass darker" in fresh Claude
sessions: it became tone settings in only 3 of 8 sessions, so it is not promised. The settings on
instruments: a ZCore or JUPITER-X model setting sent to a part that holds another engine's tone; on
the SC-55, what a program change or a reset does to an offset, whether the cut-off still changes above
the range of the manual, and a slow attack and release; on the MT-32, the reverb, the resonance of
partial 1, the order of the four bits of the partial mute, the rhythm setup of each key, the spacing
between data sets on a real MT-32 (none was tried) and one unexplained silence of the Munt emulator; a
change on a bar line and a replug on a real instrument; and the loopback test, which is not full proof
of what a real cable carries. In the Scratchpad: a real keyboard's own delay was never measured, the
choice between eighths and sixteenths as one choice or two on the roll was skipped (sixteenths stay
the default), a screen reader on the Scratchpad strips, including the send strip, hearing Listen on
real synths and Stop on real hardware, and the look of the three layouts. The held-note problem above
is still open. The automated tests and the checks in a real browser cover how these parts behave.

### Added

- Tone, part and scene settings. Claude sets them in the options of `.midi()`, under the keys `tone`,
  `part` and `scene`, in the instrument's own units, the way it sets a sound or a control. Tone
  reaches the temporary tone of the part that the call's channel plays, part reaches that part only,
  and scene reaches every part of the instrument. Moontide stores nothing: the code is the only
  record. A setting taken out of the code is not sent again and stays on the instrument until the
  instrument itself changes it, and a scene change made on the instrument resets them. A setting at
  the wrong level, a value out of range, an instrument that cannot take settings and a rhythm channel
  on the SC-55 are refused, and the previous music keeps playing. Settings go only into areas of the
  instrument that hold nothing for good, and the Instruments view shows the settings the playing code
  writes. No shipped instrument model describes settings, so they work with a model file of your own;
  the JUPITER-Xm in three engines, SC-55 offsets and MT-32 settings are the kinds that can. What was
  heard: once each, on one rig, the three JUPITER-Xm engines, the SC-55 cut-off and vibrato, and part
  of the MT-32 on the Munt emulator, with every MT-32 setting marked heard, sent but not heard, or
  only documented. In fresh Claude sessions, a delay on the lead and drive on everything became
  settings at the right level in 3 of 4 sessions each. Read more: https://konni-arcadia.github.io/moontide/synth-settings.html
- The Scratchpad, early experimental: a piano roll, opened with key 7, where you draw, tap, select,
  move, align, clear and undo a short motif. It has five grids, with sixteenths as the default.
  Listen plays the motif on one of your instruments only when you press it, and sends no sound
  change. The roll changes no code and stores nothing. Read more: https://konni-arcadia.github.io/moontide/scratchpad.html
- Playing in from a MIDI keyboard. Name the input in the setup file. The page keeps the last 8 cycles
  in a rolling buffer, in memory only: a reload empties it and nothing is written to a file. Each
  note is placed by its own time stamp, within 6 ms of its place on a loopback port in real Chrome,
  on one Mac with one Chrome. The live view shows the buffer on the roll as you play. Record that
  turns exactly what is shown into the motif and empties the buffer. Playing only listens and sends
  nothing to an instrument. Read more: https://konni-arcadia.github.io/moontide/keyboard-input.html
- Sending a motif to Claude. The Send to Claude button, or Enter in its words field, sends one page
  request that carries the motif as a Strudel phrase and the moment, the cycle of the music where it
  stands. The page changes no code and no version: what Claude does with the motif is Claude's change
  to make. In ten fresh sessions on a single model, the notes were at the stated cycle in 10 of 10, read
  from the code and never heard. Read more: https://konni-arcadia.github.io/moontide/sending-a-motif.html
- The manual, a user manual in plain words at https://konni-arcadia.github.io/moontide/. Every page ends with what was
  checked and what was not.
- The words Early and Early experimental, the same everywhere: a label Early experimental at the end of
  the Scratchpad's toolbar with a one-sentence tooltip, an Early line in the Session drawer, a note at
  the top of the manual's home page and of its Scratchpad pages, a sentence under the title of the
  README, and the package description.

## [2.2.0] - 2026-10-17

Claude can now move the tempo over several bars, the page shows what became of each request, and
the Jam view proposes a scale when several fit.

Not yet checked by hand: how hardware that follows the MIDI clock (an arpeggiator, a step
sequencer) reacts to a tempo ramp, how a ramp sounds on speakers and instruments, whether the
request states and the proposed scale with its reason read right in real sessions, and how the
top bar during a ramp, the request list and the piano look on large screens. The automated tests
and the checks in a real browser cover how they behave.

### Added

- A tempo ramp. `set_code` and `edit_code` take `glideBars`, a whole number of bars from 1 to 64,
  and the code states the tempo to reach. The tempo moves in equal small steps and ends exactly
  on it. The top bar shows the live tempo, an arrow and the tempo to reach, and the bars left
  when you hover it. Your Mixer, Song grid, Timeline and hand edits keep the ramp going. Code
  with another tempo or with none cancels it, and so does Stop, after which Play starts at the
  code's tempo. A ramp that cannot be made (nothing plays, no tempo in the code, or the tempo
  that already plays) is refused and nothing changes. The MIDI clock follows every step. How
  hardware that follows the clock, such as an arpeggiator or a step sequencer, reacts to a ramp
  has not been verified.
- Request status. A Requests button in the top bar opens one row per request, with its state in
  the page's words: received or waiting for Claude's next action, started, waiting for its line,
  applied as a version, Answered or Declined with Claude's sentence, failed with the error,
  replaced or canceled, and No change yet after a quiet wait, which is not a failure. A request
  shows as applied only when Claude names it with its change (the `answering` field on `set_code`,
  `edit_code` and `restore_version`). The new `answer_request` tool closes a request in words.
  The rows are kept in memory only.
- A proposed scale in the Jam view. When the notes fit several scales, the view proposes one and
  says why in a sentence, and lists the scales that fit so one click or Enter switches. Your pick
  holds while the same scales fit and is forgotten on reload. When it cannot choose, it says so
  and lists the scales. The piano is now coloured like the guitar, with the same legend and a
  shape or text cue besides colour.

### Changed

- A Timeline range that crosses several sections now names each of them, in playing order.
- The one-line status of your latest request is replaced by the Requests list.

### Fixed

- A Menu key or Shift+F10 press opens the Ask box once, with no browser menu over it.
- A Mixer light no longer stays lit in the middle of a fade.

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

[2.4.3]: https://github.com/konni-arcadia/moontide/releases/tag/v2.4.3
[2.4.2]: https://github.com/konni-arcadia/moontide/releases/tag/v2.4.2
[2.4.1]: https://github.com/konni-arcadia/moontide/releases/tag/v2.4.1
[2.4.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.4.0
[2.2.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.2.0
[2.1.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.1.0
[2.0.2]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.2
[2.0.1]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.1
[2.0.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.0
