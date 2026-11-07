# Troubleshooting

This page lists the problems people meet most, with what to do about each. It ends with the known
limits of Moontide. If your problem is not here, ask Claude what went wrong: when something cannot play,
Claude is told the real reason.

## Problems

### "Failed to connect" right after installing

The first start downloads the package, and Claude Code gives up after 30 seconds. Wait a little and
check again with `claude mcp list`. If it keeps failing, start Claude Code with a longer limit:

```bash
MCP_TIMEOUT=60000 claude
```

In PowerShell, use:

```powershell
$env:MCP_TIMEOUT = "60000"; claude
```

The [Install](install.md) page has the steps from the start.

### Moontide is missing in another folder

It was added without `--scope user`. Add it again with the line on the [Install](install.md) page.

### The page did not open

Claude's replies name the address of the page. Open it yourself, or ask Claude to start Moontide again:
it gives the address and opens a new tab when no page is connected. If you set `MOONTIDE_NO_BROWSER=1`,
no tab opens by design. See [First music](first-music.md).

### Several Moontide tabs

Each Claude session that started Moontide has its own page and port. The tab title says "Moontide ·
folder · port", with the folder that session runs in, and the Session drawer shows the same. Ask Claude
which tab is its own: it answers with the address, the port and the tab title.

### No sound

Click once in the page, because browsers start sound only after a click. Check that the browser tab is
not muted, and keep the page open.

### Claude Desktop does not find npx

Put the full path of `npx` in the `"command"` of the Moontide entry in the Claude Desktop config. The
path is printed by `which npx` on macOS and by `where npx` on Windows. This is common advice and has not
been tried here.

The Claude Desktop logs are in `~/Library/Logs/Claude` on macOS and in `%APPDATA%\Claude\logs` on
Windows.

### A change failed

When code cannot play, a banner appears under the top bar. It starts with "Change failed." and says
what the music does now: the previous music keeps playing, the sound is still stopped, or nothing plays
yet. Choose Details to read the error. Choose Ask Claude on the banner to send the error to Claude, who
can then look at the code. Copy copies the error, and Dismiss hides the banner.

### A request from the page seems lost

Open the Session drawer and look at the Page requests card. If requests wait for Claude, they reach it
with its next action; turn them on to make them live. The Requests list in the top bar shows what became
of each request. A row that reads No change yet is not a failure. See
[Asking from the page](page-requests.md).

### A line of the history cannot be read

Claude is told which lines. They stay in the file untouched, and the other versions keep working. You
can leave them. If the whole file cannot be read or written, the music keeps working and Claude is
told. See [History and favorites](history.md).

### MIDI says to use Chrome or Edge

Web MIDI is missing in that browser. Use Chrome or Edge for anything with MIDI. A track that plays a MIDI
instrument is silent in a browser without Web MIDI, and the other tracks play. See
[MIDI instruments and the setup file](midi-instruments.md).

### MIDI was refused by the browser

The page asks for MIDI once, and only when code with a `.midi(` call plays or when you press Allow MIDI
to listen in the Scratchpad. If you answered no, allow MIDI in the browser's site settings for the
page's address, then reload. The permission belongs to the address, so a Moontide started on another
port asks again. See [MIDI instruments and the setup file](midi-instruments.md).

### A port, channel or sound is refused

When you have a setup file, a port, a channel or a sound that it does not know fails the change. The
previous music keeps playing, and Claude is told the valid values. Ask Claude to read your instruments
with `get_midi_instruments` and correct the name. The port name must be the exact name your system lists.
A known port that is only unplugged is not a refusal: it is a notice, because the cable may come back.
Sounds from a catalog are found with a search. See [MIDI instruments and the setup file](midi-instruments.md)
and [Sounds, catalogs and drum maps](midi-sounds.md).

### The setup file is refused

A typo in `instruments.json` is refused with the field and the reason, in Claude's reply and in the MIDI
popover of the page. While it is refused, code that uses `.midi(` does not play, and the last good
version of the file is not kept. Fix the field that is named. A broken catalog does the same for its
model. If the small file that remembers which instruments are switched off cannot be read, the first
reason says to delete that file. See [MIDI instruments and the setup file](midi-instruments.md).

### No sound from an instrument after a replug

After a replug, the music waits for that instrument until its setup has gone out twice, which takes about
1.6 s. Wait a moment. If it stays silent, open the Instruments view and check that the instrument is
switched on, and keep the Moontide tab visible: a hidden tab shows a warning, and a second tab can hold
the music. See [MIDI instruments and the setup file](midi-instruments.md).

### A MIDI track is silent while the others play

Four things make a track silent on its own: the browser has no Web MIDI, the instrument is switched off
in the Instruments view, its port is unplugged, or the setup file is refused. Claude is told about each.
Check them in that order. See [MIDI instruments and the setup file](midi-instruments.md).

### The Scratchpad is not listening to my keyboard

The Scratchpad says why in its own words. The usual reasons are that `instruments.json` names no input,
the name is not the exact and full name your system lists (the Scratchpad lists the inputs it sees),
MIDI is not allowed yet (press Allow MIDI to listen), the tab is hidden, or another Moontide tab holds
the music. See [Playing in from a keyboard](keyboard-input.md) for every reason and what to do, and
[MIDI instruments and the setup file](midi-instruments.md) for the file.

### Listen did not play, or stopped

Listen says why too. It plays nothing when no output has the instrument's port name, or when several do,
or when the instrument is switched off, or when In the music is chosen and the music is not playing. A
play stops by itself when the tab is hidden, when another view opens, when the output is unplugged, or,
for In the music, when the music stops. See [The Scratchpad](scratchpad.md) and
[MIDI instruments and the setup file](midi-instruments.md).

## Known limits

Moontide is early and personal. It was used on one setup: a Mac, Chrome, Claude Code and Claude
Desktop, and, for MIDI, a Roland SC-55, the Munt MT-32 emulator and a Roland JUPITER-Xm. It has not
been tried anywhere else. There are known bugs. Feedback is welcome, but support is not something that
can be promised.

- Tried by hand only on macOS, with Chrome, Claude Code and Claude Desktop.
- Windows and Linux are untested by hand. The test suite runs on Windows, Linux and macOS, but nobody
  has played music on Windows or Linux yet.
- Edge, Safari and Firefox are untested.
- Internet access is needed: Strudel and its sounds load from the web.
- MIDI needs Chrome or Edge.
- The Scratchpad is early experimental, and it may still change. A key you hold while playing in is often
  recorded as a very short note; check the lengths on the roll before you send (see
  [Playing in from a keyboard](keyboard-input.md)).
- The MIDI clock of Moontide was checked by ear on two instruments that follow it only, a Roland
  JUPITER-Xm arpeggiator and a Moog Subharmonicon. A wide tempo ramp, Stop in the middle of a ramp, a
  replug while playing and a muted track keeping the clock were not verified. A follower jumped to a
  faster tempo for an instant and played a few notes after each Stop, probably because clock ticks
  already queued still arrive up to about 150 ms after a Stop. The arpeggiator went off the beat at a
  sudden tempo change and during a ramp up.
- Run one Moontide at a time with the same history file.
- The first start through npx downloads the package and can be slow.
- Some advice on these pages comes from other people's reports and has not been tried here: the Windows
  line for Claude Code, and the full path of `npx` for Claude Desktop.

## What was verified

**Verified:**

- The first start through npx from the registry works on macOS, which is the case the first entry is
  about.
- The failed-change banner, the Requests list and the history notes are covered by automated tests.

**Not verified:**

- The `MCP_TIMEOUT` advice itself: no hand check of it is on record, in a shell or in PowerShell.
- Everything on Windows and Linux.
- The full path of `npx` in the Claude Desktop config, and the places of its logs.
- Whether the advice here is enough for a reader who has never used Moontide.
