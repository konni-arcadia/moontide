# Moontide

> The moon guides the tide.

**Early:** Moontide is young and has known bugs, and its Scratchpad is early experimental (see the
[known limits](https://konni-arcadia.github.io/moontide/troubleshooting.html#known-limits)).

**A hobby project: Claude plays live music for you. Describe a mood, a theme or an idea, and
Claude writes [Strudel](https://strudel.cc) code that plays in your browser and changes without
ever stopping.**

[![npm version](https://img.shields.io/npm/v/moontide-mcp)](https://www.npmjs.com/package/moontide-mcp)
[![CI](https://github.com/konni-arcadia/moontide/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/konni-arcadia/moontide/actions/workflows/ci.yml)

[![Moontide demo: Claude starts a dungeon theme from a few words, then changes it on requests typed in the page](https://i.ytimg.com/vi/kT4UdEi2Z-8/maxresdefault.jpg)](https://youtu.be/kT4UdEi2Z-8)

▶ [Watch the demo on YouTube](https://youtu.be/kT4UdEi2Z-8) (3 minutes, with sound)

## How this was made

Moontide is a personal project. Most of the code, research and documentation was
written by an AI coding assistant working under my direction. I set the goals, listened to
every change, tried it on my own instruments, judged the results by ear, and made the
decisions. I am responsible for what is here, errors included.

## What it does

- You talk ("start something dreamy in D minor", "darker", "add a bass"). Claude writes
  Strudel code, and a browser page plays it at once, without stopping the music.
- The code is always visible and editable. Every version that played is kept, and Claude can
  bring any of them back.
- The page shows the music in several views: a timeline of named tracks where you can edit
  notes, a Song grid, the history, a mixer and a jam view with the scale on a piano or a guitar.
- A right-click on anything in the page sends Claude a request with that context.
- Claude can move the tempo up or down over a number of bars, instead of jumping.
- The same code can play real MIDI instruments from the page, and a
  [Scratchpad](https://konni-arcadia.github.io/moontide/scratchpad.html) (early experimental) lets you draw or play in a motif and send
  it to Claude.
- On an instrument whose model describes them, Claude can set tone, part and scene
  [settings](https://konni-arcadia.github.io/moontide/synth-settings.html) that no program change carries, written in the code like a sound
  or a control. Moontide stores none of them. The models that describe settings are files of your own;
  none ships with Moontide.

Moontide does not start from scratch. The music engine is
**[Strudel](https://strudel.cc)**, the JavaScript port of TidalCycles by Felix Roos, Alex McLean and the
Strudel contributors. Moontide is the bridge between Claude and a Strudel page.

## Install

What you need: **Node 22 or later**, **Claude Code or Claude Desktop**, **Chrome** (Chrome or Edge
for MIDI), internet access (Strudel and its sounds load from the web), and speakers or headphones.

```bash
claude mcp add --scope user moontide -- npx -y moontide-mcp
```

Then start a new Claude session and ask for music. Claude Desktop, Windows, running from the
source code, updating and uninstalling are on the manual's
[Install page](https://konni-arcadia.github.io/moontide/install.html).

## First music

1. Start a new Claude session. Nothing opens yet: Moontide waits until you want it.
2. Ask for music, for example "Play something calm to start the day". Or say "start Moontide".
3. The page opens in a new tab at http://localhost:5757, or on another port when 5757 is busy.
4. Click once anywhere in the page. Browsers start sound only after a click.
5. Ask for changes: "darker", "add a bass", "slower".

More in [First music](https://konni-arcadia.github.io/moontide/first-music.html).

## The manual

The manual is at [https://konni-arcadia.github.io/moontide/](https://konni-arcadia.github.io/moontide/). It is written in plain words,
and every page ends with a box that says what was checked and what was not.

- Getting started: [Install](https://konni-arcadia.github.io/moontide/install.html),
  [First music](https://konni-arcadia.github.io/moontide/first-music.html) and
  [the page and its views](https://konni-arcadia.github.io/moontide/the-page.html).
- Working with Claude: [asking Claude](https://konni-arcadia.github.io/moontide/asking-claude.html),
  requests from the page, small edits, song structure, tempo ramps and history.
- MIDI gear: [instruments and the setup file](https://konni-arcadia.github.io/moontide/midi-instruments.html),
  [sounds and catalogs](https://konni-arcadia.github.io/moontide/midi-sounds.html),
  [tone, part and scene settings](https://konni-arcadia.github.io/moontide/synth-settings.html),
  [the Scratchpad](https://konni-arcadia.github.io/moontide/scratchpad.html),
  [keyboard input](https://konni-arcadia.github.io/moontide/keyboard-input.html) and
  [sending a motif](https://konni-arcadia.github.io/moontide/sending-a-motif.html).
- Troubleshooting: [problems and known limits](https://konni-arcadia.github.io/moontide/troubleshooting.html).
- How it works: [the pieces and the tools](https://konni-arcadia.github.io/moontide/how-it-works.html),
  what was measured, and
  [network, privacy, credits and license](https://konni-arcadia.github.io/moontide/privacy-and-credits.html).

The same pages can be read on GitHub, as Markdown, in the
[site folder](https://github.com/konni-arcadia/moontide/tree/main/site).

## Status

Early and personal. It runs on one setup: a Mac, Chrome, Claude Code and Claude Desktop, and,
for MIDI, a Roland SC-55, the Munt MT-32 emulator and a Roland JUPITER-Xm. It has not been tried
anywhere else. The test suite runs on Windows, Linux and macOS in CI, but nobody has played
music on Windows or Linux yet. There are known bugs. Feedback is welcome, but support is not
something I can promise. The list is in
[Known limits](https://konni-arcadia.github.io/moontide/troubleshooting.html#known-limits).
What is not yet checked by hand is listed at the end of each manual page and in the
[changelog](https://github.com/konni-arcadia/moontide/blob/main/CHANGELOG.md).

## Network and privacy

The server listens on 127.0.0.1 only and sends nothing out. The page loads Strudel and its
samples from the web. Details: [network, privacy, credits and license](https://konni-arcadia.github.io/moontide/privacy-and-credits.html).

## Contributing and security

Bug reports and ideas are welcome as issues (use the bug form). How pull requests are handled is in
[CONTRIBUTING.md](https://github.com/konni-arcadia/moontide/blob/main/CONTRIBUTING.md).

Security problems go through a private report, never a public issue. See
https://github.com/konni-arcadia/moontide/security/policy.

## Credits

Built on [Strudel](https://strudel.cc) by Felix Roos, Alex McLean and the Strudel contributors
(source: https://codeberg.org/uzu/strudel), on TidalCycles by Alex McLean and its community, on the
sample sets Strudel loads (including the TidalCycles Dirt-Samples and the Versilian Community
Sample Library), on the Model Context Protocol and its TypeScript SDK from Anthropic, and on the
acorn parser. The full list is on the
[credits page](https://konni-arcadia.github.io/moontide/privacy-and-credits.html#credits).

## License

Moontide plays Strudel, which is under AGPL-3.0-or-later. Moontide uses the same license. It
loads Strudel from unpkg at run time and does not ship it. The license text is in
[LICENSE](https://github.com/konni-arcadia/moontide/blob/main/LICENSE). Moontide is not
affiliated with, or endorsed by, the Strudel or TidalCycles projects, or Anthropic.

---

*Konni — built with an AI coding assistant.*
