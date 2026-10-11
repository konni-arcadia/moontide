# Moontide

> The moon guides the tide.

**A hobby project: Claude plays live music for you. Describe a mood, a theme or an idea, and
Claude writes [Strudel](https://strudel.cc) code that plays in your browser and changes without
ever stopping.**

[![npm version](https://img.shields.io/npm/v/moontide-mcp)](https://www.npmjs.com/package/moontide-mcp)
[![CI](https://github.com/konni-arcadia/moontide/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/konni-arcadia/moontide/actions/workflows/ci.yml)

<!-- Demo media goes here, right under the pitch. -->

## How this was made

Moontide is a personal project. Most of the code, research and documentation was
written by an AI coding assistant working under my direction. I set the goals, listened to
every change, tried it on my own instruments, judged the results by ear, and made the
decisions. I am responsible for what is here, errors included.

## Why

Curiosity. I wanted to see how far an AI assistant can go at making real music, not a
technical demo, when it is given a good instrument. Strudel is that instrument: a live-coding
language where a change lands on the next cycle, with no cut, and where the music is plain text
that both of us can read.

So Claude writes the code, and the code stays on screen while it plays. You can watch it, edit
it by hand, go back to any earlier version, or point at something in the page and ask for a
change.

## What it does

- You talk ("start something dreamy in D minor", "darker", "add a bass"). Claude writes
  Strudel code, and a browser page plays it at once. Each change takes over within a fraction
  of a second, without stopping the music.
- The code is always visible and editable. Every version that played is kept, and Claude can
  bring any of them back.
- Around the code, the page shows the music in several views: the named tracks on a timeline,
  the parts of a piece, the history as a list or a tree, a mixer whose moves rewrite the code,
  and a jam view with the scale on a piano or a guitar.
- A right-click on anything in the page sends Claude a request with that context.
- The same code can play real MIDI instruments from the page, through Web MIDI.

Moontide does not start from scratch. The music engine is
**[Strudel](https://strudel.cc)**, the JavaScript port of TidalCycles by Felix Roos, Alex McLean and the
Strudel contributors. Moontide is the bridge between Claude and a Strudel page.

## How it works

```
 you ──talk──► Claude ──MCP (stdio)──► Moontide ──WebSocket (localhost)──► browser page
                                          │                                 Strudel plays
                                          └─ history file on your disk      the code, sound
                                                                            and Web MIDI out
```

1. Moontide runs as an MCP server that Claude connects to. It starts nothing until you ask
   for music or say "start Moontide".
2. It then opens a page in your browser with a Strudel editor.
3. Claude writes the code, the page plays it, and you watch the code come alive.
4. Claude can stop the music at any point. The page has its own Play and Stop button too.
5. Right-click anything in the page to ask Claude about it. A right-click on the Timeline also
   sends the moment under the pointer: the cycle and the beat, the version that was playing, and
   the notes sounding there or starting in the same sixteenth, with their velocities and, for a
   MIDI track, its instrument and channel. The Session drawer (the Session button in the top
   bar) says whether page requests are live (they reach Claude right away) or wait for Claude
   (they reach it with its next action). Its (i) explains how to switch.

## Install

The short version, for someone who already has Node 22 or later and Claude Code:

```bash
claude mcp add --scope user moontide -- npx -y moontide-mcp
```

Then start a new Claude session and ask for music. The steps below explain each part.

### 1. What you need

- **Node 22 or later**, with npm and npx (they come with Node).
- **Claude Code or Claude Desktop.** Moontide is an MCP server: Claude talks to it.
- **Chrome**, the browser Moontide was tried with. For MIDI (Web MIDI), use Chrome or Edge.
- **Internet access**: Strudel and its sounds load from the web.
- **Speakers or headphones.**

### 2. Check Node

In a terminal, run:

```bash
node --version
```

It must print `v22` or higher. If Node is missing or older, install the LTS version from
[nodejs.org](https://nodejs.org). On macOS with Homebrew, `brew install node` works too. Open a
new terminal afterwards and check again.

### 3. Get Claude

Install Claude Code or Claude Desktop from [claude.com](https://claude.com/claude-code) and sign
in once. Moontide works with either; Claude Code is the one tried most.

### 4. Add Moontide to Claude

<details open>
<summary>Claude Code (tested on macOS; Linux untested)</summary>

In a terminal, run:

```bash
claude mcp add --scope user moontide -- npx -y moontide-mcp
```

With `--scope user`, Moontide is available in every folder. The default scope (local) works
only in the folder where you ran the command, and the scope `project` shares it through a
`.mcp.json` file.

Keep the name `moontide`. The page-request commands below use it.

Check the install with:

```bash
claude mcp get moontide
```

The same line is meant for Linux. It is untested there.

</details>

<details>
<summary>Claude Desktop (tested on macOS; Windows untested)</summary>

Open Settings, then Developer, then Edit Config. The file is:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add Moontide to it:

```json
{
  "mcpServers": {
    "moontide": {
      "command": "npx",
      "args": ["-y", "moontide-mcp"]
    }
  }
}
```

If the file already has an `mcpServers` block, add the `moontide` entry inside it. Quit Claude
Desktop fully and start it again. Claude Desktop has no Linux version.

</details>

<details>
<summary>Windows with Claude Code (untested)</summary>

From PowerShell or Command Prompt (not Git Bash), run:

```bash
claude mcp add --scope user moontide -- cmd /c npx -y moontide-mcp
```

Check it with `claude mcp get moontide`. The command must read `cmd` with `/c npx -y moontide-mcp`. If it shows `C:/` instead of `/c`, edit the `moontide` entry in the `.claude.json` file of your user folder so it reads `"command": "cmd", "args": ["/c", "npx", "-y", "moontide-mcp"]`.

This form comes from community reports. It has not been tried here.

</details>

<details>
<summary>From the source code</summary>

To run Moontide from a copy of this repository instead of npm:

```bash
git clone https://github.com/konni-arcadia/moontide.git
cd moontide
npm ci
npm run build
```

Then add it with the full path of `dist/index.js`, written here as `<folder>`:

```bash
claude mcp add --scope user moontide -- node <folder>/dist/index.js
```

`npm test` runs the test suite. The real-browser checks (`npm run probe:page`) need Chrome.

</details>

### 5. First music

1. Start a new Claude session. Nothing opens yet: Moontide waits until you want it.
2. Ask for music, for example "Play something calm to start the day" or "Give me a slow, warm
   groove". Or say "start Moontide". In Claude Code, `/mcp__moontide__start` does the same.
3. The page opens in a new tab at http://localhost:5757, or on another port when 5757 is busy.
   Claude's replies name the address. The tab title names the folder Claude runs in and the
   port, for example "Moontide · my-project · 5757".
4. Click once anywhere in the page. Browsers start sound only after a click.
5. Ask for changes: "darker", "add a bass", "slower".

Set `MOONTIDE_NO_BROWSER=1` in the environment and starting Moontide opens no tab. Open the
address from Claude's reply yourself.

### Update

To see the version that runs, run `npx -y moontide-mcp --version`. Releases are listed in
[CHANGELOG.md](https://github.com/konni-arcadia/moontide/blob/main/CHANGELOG.md). npx can keep
using a copy it already downloaded; to move to the newest release, add Moontide again with
`@latest`:

```bash
claude mcp remove moontide --scope user
claude mcp add --scope user moontide -- npx -y moontide-mcp@latest
```

### Uninstall

```bash
claude mcp remove moontide --scope user
```

In Claude Desktop, remove the `moontide` entry from the config file and restart it. Moontide
keeps its history and settings in your data folder (see History); delete that folder if you
want them gone too.

### MIDI instruments (optional)

Moontide can play MIDI instruments from the code through Web MIDI. It ships ready models for the
Roland MT-32 and SC-55. You can describe your own instruments and models, add sound catalogs and
send MIDI clock. The setup is in
[docs/midi.md](https://github.com/konni-arcadia/moontide/blob/main/docs/midi.md).

## Page requests without a permission prompt

In the Code tab of the Claude app, ask Claude to turn page requests on or off. Claude calls
Moontide's `set_page_requests` tool. In Claude Code in a terminal, type
`/mcp__moontide__page-requests-on` to make them live or `/mcp__moontide__page-requests-off` to
make them wait. Live, Claude starts a monitor, which lasts at most 30 minutes and is started
again when a tool reply asks. Waiting, tool replies stop offering to start it until page
requests are turned on again. Page requests need an open page, so start Moontide first. These
names assume the server was added as `moontide`.

Claude Code asks permission before it starts the monitor for page requests, because it runs a
command. You can approve it each time. If you want a narrower permission rule instead, see the
permissions section of the Claude Code documentation. Do not allow broad `node` commands.

## Musical reference

Claude gets a factual reference of the exact Strudel version the page runs, through the
`get_strudel_reference` tool (also offered as MCP resources), covering eight topics: Strudel
vs TidalCycles, mini-notation, pattern functions, effects and sound controls, the sound
palette, music theory in Strudel, transitions, and MIDI output. It holds facts only: what
exists and how to write it. Moontide ships no mood vocabulary, no style material and no model
pieces; Claude translates your words with its own knowledge of music theory, then tells you in
one line what it chose. Ask for a surprise in your own words: there is no menu command for it.
Set a frame for the session, for example gradual changes, and Claude follows it for every
change until you lift it. Say what matters to you (a melody, a rhythm) and Claude keeps it,
and asks before a full rewrite.

## Small edits and harmony

Claude can change a few lines of a long piece without sending it again, through the
`edit_code` tool; a change that waits for its bar is edited, and your hand edits are kept.

The code can say which harmony it means with one top-level line, for example
`const harmony = 'C:minor'`, placed above the patterns. It plays nothing and is never a
track. The Jam view then shows two lines, "Declared:" and "Heard:", side by side.

## History

Every version that plays is kept: Claude's own changes and your Ctrl+Enter edits, each with
its time, who made it and a short label. Failed code and stops are not versions.

Ask Claude things like "go back to the previous version", "the one from 3 changes ago", "the
one with the bass", or "keep this one, call it Take two", and "list my favorites". The
Session drawer shows the number of the version that is playing, in its Last change card, for
example `v42`.

The history file lives in your OS's per-user data folder:

- macOS: `~/Library/Application Support/moontide/history.jsonl`
- Linux: `$XDG_DATA_HOME/moontide/history.jsonl`, or `~/.local/share/moontide/history.jsonl`
- Windows: `%APPDATA%\moontide\history.jsonl`

Set `MOONTIDE_DATA_DIR` to use another folder. The history is one text file with one entry
per line, and survives the end of the Claude session.

The history keeps the last 1000 versions; older ones are dropped in batches and Claude is
told. Favorites are never dropped.

If a line of the file cannot be read, Claude is told which lines; they stay in the file
untouched. If the file cannot be read or written at all, the music keeps working and Claude
is told.

Run one Moontide at a time with the same history file. Two at once can give two versions the
same number.

## Troubleshooting

**"Failed to connect" right after installing.** The first start downloads the package, and Claude Code gives up after 30 seconds. Wait a little and check again with `claude mcp list`. If it keeps failing, start Claude Code with a longer limit: `MCP_TIMEOUT=60000 claude`. In PowerShell, use `$env:MCP_TIMEOUT = "60000"; claude`.

**Moontide is missing in another folder.** It was added without `--scope user`. Add it again with the Install line.

**The page did not open.** Claude's replies name its address. Open it yourself, or ask Claude to start Moontide again: it gives the address and opens a new tab when no page is connected.

**Several Moontide tabs.** Each Claude session that started Moontide has its own page and port. The tab title says "Moontide · <folder> · <port>", with the folder that session runs in, and the Session drawer shows the same. Ask Claude which tab is its own: it answers with the address, the port and the tab title.

**No sound.** Click once in the page. Check that the browser tab is not muted, and keep the page open.

**Claude Desktop does not find `npx`.** Put the full path in `"command"`: the path printed by `which npx` on macOS or `where npx` on Windows, written here as `<full path printed by which npx>`. This is common advice and has not been tried here. The Claude Desktop logs are in `~/Library/Logs/Claude` on macOS and `%APPDATA%\Claude\logs` on Windows.

**MIDI says to use Chrome or Edge.** Web MIDI is missing in that browser.

## Status

Early and personal. It runs on one setup: a Mac, Chrome, Claude Code and Claude Desktop, and,
for MIDI, a Roland SC-55, the Munt MT-32 emulator and a Roland JUPITER-Xm. It has not been tried
anywhere else. The test suite runs on Windows, Linux and macOS in CI, but nobody has played
music on Windows or Linux yet. There are known bugs. Feedback is welcome, but support is not
something I can promise.

Known limits:

- Tried by hand only on macOS, with Chrome, Claude Code and Claude Desktop.
- Windows and Linux are untested by hand. Edge, Safari and Firefox are untested.
- Internet access is needed.
- MIDI needs Chrome or Edge.
- Run one Moontide at a time with the same history file.
- The first start through npx downloads the package and can be slow.

## Network and privacy

- The server listens on 127.0.0.1 only and refuses requests for any other host name.
- Moontide's own server code makes no outbound request and sends no telemetry.
- The page loads `@strudel/repl` 1.3.0 and `acorn` 8.18.0 from unpkg, pinned to exact versions with integrity hashes.
- Strudel then fetches sound lists and samples from raw.githubusercontent.com and cdn.jsdelivr.net. No hash covers those.
- The code Claude writes runs in the page and may load samples from other addresses.
- The history stays in the local data folder described above.

## Contributing and security

Bug reports and ideas are welcome as issues (use the bug form). How pull requests are handled is in
[CONTRIBUTING.md](https://github.com/konni-arcadia/moontide/blob/main/CONTRIBUTING.md).

Security problems go through a private report, never a public issue. See
https://github.com/konni-arcadia/moontide/security/policy.

## Credits

This builds on other people's work:

- **Felix Roos, Alex McLean and the Strudel contributors**: [Strudel](https://strudel.cc)
  (source: https://codeberg.org/uzu/strudel), the live-coding engine that plays every note.
- **Alex McLean and the TidalCycles community**: TidalCycles, the pattern language Strudel
  ports to JavaScript.
- **The sample makers** whose sets Strudel loads by default, including the TidalCycles
  Dirt-Samples and the Versilian Community Sample Library (VCSL).
- **Anthropic**: the Model Context Protocol and its TypeScript SDK, which let Claude talk to
  Moontide.
- **The acorn authors**: the JavaScript parser the page uses to read the code.

## License

Moontide plays Strudel, which is under AGPL-3.0-or-later. Moontide uses the same license. It
loads Strudel from unpkg at run time and does not ship it. The license text is in
[LICENSE](https://github.com/konni-arcadia/moontide/blob/main/LICENSE). Moontide is not
affiliated with, or endorsed by, the Strudel or TidalCycles projects, or Anthropic.

---

*Konni — built with an AI coding assistant.*
