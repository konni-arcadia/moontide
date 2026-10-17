# Decisions

Settled choices. Revisit one only when real use shows it blocks us.

## Strudel is the only pattern language

Strudel gives immediacy: code runs in the browser with no install, and changes apply on the
next cycle without stopping the clock. It also supports MIDI output natively.
TidalCycles shares the mini-notation but needs Haskell and SuperCollider. We reconsider it
only if Strudel ever blocks us.

## Delivered as an MCP server

The tools and the Strudel reference material ship in one package. The reference is reached
through a tool, `get_strudel_reference`, because some MCP clients only show resources the
user attaches by hand; the same text is also offered as MCP resources for clients that do
show them. There are no ready-made commands (MCP prompts) for music: a prompt's text would
steer Claude's taste, so a surprise is asked in plain words instead. The only two prompts,
`page-requests-on` and `page-requests-off`, switch how page requests reach Claude; they carry
a command and facts, never taste. The tool `set_page_requests` does the same for clients that
do not offer MCP prompts. This works with any MCP client, and a single line of setup
is enough. We use no Claude skills.

## Facts, not taste

Moontide gives Claude facts about the pinned Strudel version and relies on Claude's own
knowledge of music theory to translate what the user asks. It ships no mood vocabulary, no
style or genre material, no model pieces, and no rule telling Claude to vary what it plays.
Drift toward one style is measured with `npm run tint:report`, never imposed as
a rule. We revisit this decision only when real use gives us facts that say otherwise.

## One repo

A solo project keeps one working repository. Development happens there, in a private
repository. Releases are published in the public repository as snapshots. Pull requests are
reviewed in the public repository and ported by hand into the private one, with credit to
their author.

## AGPL-3.0-or-later

Strudel is AGPL-3.0-or-later, so Moontide uses the same license.

## Easy install is a feature

A newcomer must be able to add the MCP server with one command, click the page and hear
music. Every setup step we add must be justified.

## Fresh start

Moontide does not inherit design choices from earlier experiments. Reason from first
principles.

## The code is the center of the page

Other views (history, timeline, mixer, parts, jam) are different angles on the same Strudel
text. Controls edit the text, so the code stays the single source of truth. The code stays
readable, though a layout may keep it in the background. See
[ui-exploration.md](ui-exploration.md).

## The chat stays in its own window for now

The page has a small right-click box: it sends one request to Claude with the context of what
was pointed at, and it shows no conversation. Claude answers in its own window, by changing the
music. A fuller chat on the page stays open until real use shows whether it is worth it.

## Requests from the page reach Claude through a listener Claude runs

Claude has to notice a request without the user typing in the chat. Claude Code's Monitor tool
does that: it runs a command and wakes Claude on each line the command prints. So Claude runs
Moontide's own listener (`dist/listen.js`) with Monitor; each request from the page is one
printed line. This needs no experimental channel, and nothing costs tokens while the listener
is idle.

A monitor lasts at most 30 minutes. So while no listener is connected and a page is open, the
tool replies carry the exact command again, and Claude starts a new one. A request sent while
nobody listens is not lost: it waits on the server and arrives in the next tool reply. This
also serves MCP clients that have no Monitor. A server restart loses the waiting requests; a
queue file that survives a restart is a future requirement. The delivery lives
in the listener and in tool replies; the only tool about page requests switches them on and off.

The page shows whether requests are live. The server pushes that state (one boolean) to
authenticated pages, and two MCP prompts and one tool switch it: `page-requests-on` gives Claude
the command to run with Monitor (a prompt cannot start the monitor; Claude runs the command), and
`page-requests-off` tells Claude to stop it. Off also sets a server switch so tool replies stop
carrying the command, and on clears it, even when no page is connected yet and on is refused for
that reason: the wish is kept, and the command comes back as soon as a page connects. Requests sent
while off still wait and arrive in the next tool reply. So "off" does not depend on Claude
remembering.

The tool, `set_page_requests` with state on or off, exists because the Code tab of the Claude
desktop app does not offer MCP prompts (an upstream request to add them was closed as not
planned). It gives the same texts as the prompts, through one shared function, so a terminal and
the app behave the same. Off does not close the listener from the server: Claude stops its
monitor, and the page status stays honest because it follows the real connection. User-facing text says "page
requests" and never the word for listening, because in a music tool it reads as listening to
the sound. The status is plain muted text, not an accent: the accent stays for what is live in
the music.

## The server instructions fit 2048 characters

Claude Code keeps only the first 2048 characters of an MCP server's instructions and cuts the rest
mid-sentence. So the whole text stays under that limit (a test checks it), and the entries come by
importance: the opening, what a page request line is and who wrote each field, the page-requests
tool, the track-naming and solo-label facts, then the rest. What a tool description, a tool reply
or a reference topic already says is not repeated: the bar and phrase option, the explanation after
a change and the ask-before-a-rewrite rule live in the `set_code` description, the sound option and
the MIDI notices in the MIDI tools and replies, and the `getTime()` and `.timeline(id)` rule in the
`set_code` description and in the reply note when the code reads `getTime()`, and in full in the
transitions topic. The rule for choosing between `edit_code` and `set_code` lives in their two
descriptions and in one `get_code` line. The text keeps a margin of a sentence or two below the limit, so a new standing
rule never forces cutting one that matters. Room is made by moving a fact to where Claude meets it,
never by dropping a rule, and the framing of page requests always stays in the instructions. One
rule is said twice, on purpose: "call `get_midi_instruments` before writing MIDI code" stays in the
instructions and opens that tool's description, because a guessed port, channel or sound can send
notes to the wrong channel of a real instrument (a test pins both).

The standing rule that every new piece declares its song structure (see "Every new piece declares a
song structure") takes one sentence of 119 characters. To keep the margin, the sentence about acting on
a vague request moved into the `set_code` description, and the duty to say which sound replaced a failed
one moved to the end of the three failed-sound notices, where Claude meets it. The text is pinned at its
exact length, which leaves 162 characters under the limit. A failed-sound notice names at most seven
sounds, so the longer notice stays under the 500 characters the server keeps.

## What the two tokens protect

The request channel has two secrets, and they protect different things.

- The Origin check keeps other websites out. A browser always sends the real Origin of the
  page that opens a socket and cannot forge it, so a website the user visits cannot talk to
  Moontide.
- The page token changes at every start and is embedded in the page the server serves. It is
  required for every page message and before a connection can become the active page: a
  connection that has not presented it gets nothing, and every other message it sends is
  ignored and logged. It refuses a stale page and a page that was not served by this Moontide.
  It is not a secret from a local program: any local program that can load the page, and any
  code running in the page, can read it. It does not stop a determined local program from
  sending requests.
- The listener token is given only to Claude, in a tool reply. It is the real boundary: no
  other program can receive the user's requests without it, and no browser page can be the
  listener, because a listener connection that carries an Origin header is refused. On a
  shared machine the listener token is visible in the process list while the listener runs.

Every kind of refusal is logged by the server, at most once per second, with a count of the ones left out. The page shows each refusal it receives.

## VCSL sounds load from a pinned jsDelivr copy

Chrome refuses GitHub raw's response for VCSL files whose folder name holds a comma, so the
page loads VCSL audio from jsDelivr, pinned to one VCSL commit (the commit is in
page/ui-state.js). The other sample sets stay where Strudel loads them. There is no fallback:
if jsDelivr is down, the failure reaches Claude by sound name. `npm run check:reference`
checks one file per default sound on the host the page uses.


## The page restores through the server's restore path

A click in the History view becomes the same restore that Claude's `restore_version` does. The
server records it as a new version from the page, with the version it came from. Nothing in the
history is ever rewritten, and Claude sees the restore on its next tool call, like a hand edit.

## Versions record their parent

Each new version line carries the version that was playing when it was made; a restore carries
the version it brought back. The field is optional, so older lines and older readers stay valid.
The server resolves parents in one place: an older line falls back to the version it restored,
else to the previous id. A version whose parent is gone or damaged is sent as a root, never with
a made-up link.

## Stop retires the MIDI outputs it used

Stop has to leave no stale note behind. The callbacks of the stopped code are already scheduled
and hold the webmidi output objects they were made with, and they fire 0.03 to 0.29 seconds
after the next Play, mixed in with the first notes of the new code. A time window cannot tell
stale notes from new ones: we measured it, and no fixed window works. So Stop retires each
output the page used: the page swaps in a fresh output on the same native port and makes the
old one inert, so the stale callbacks send nothing. This adds no delay. webmidi keeps every output
whose port left, and when a port comes back it puts back the first output it holds for that port:
a retired output came back after a replug that followed a Stop, and the instrument stayed silent
(found at the 2026-10-02 bench). So Stop also empties that list of disconnected outputs and makes
the outputs in it inert, and a returning port always gets a new output: an unplugged port that
comes back resumes after any order of Stop, unplug and replug. After the AudioContext is suspended, Stop also sends a sustain
release and then All Notes Off on all 16 channels of every port the code has named since the
page loaded, raw, so a held pedal or a ringing note cannot survive it. A call that gives its
port by number or leaves it out cannot be pinned to a name, because Strudel picks that port at
every note, so one such call makes Stop silence every connected output.

## MIDI problems are notices, once per change

A missing port, a denied permission, a browser without Web MIDI and a hidden tab are said to
Claude as a notice in the next tool reply, once each time the state changes, and to the user in
the page. The music keeps playing: a wrong port name does not fail the evaluation, because the
other tracks are fine and the port may come back. A line per note or per beat would flood
Claude's context, so the server words facts once and the page never forwards Strudel's log
lines. Refusing an unknown port outright waits for the instrument setup file, which is when
Moontide knows what each port should be.

## Without Web MIDI, a .midi() track is silent and the others play

In a browser without Web MIDI, Strudel's `.midi()` throws, and the whole piece fails to start, so a
browser track next to a `.midi()` track played nothing while the notice to Claude said only the MIDI
tracks were silent. In such a browser the page now replaces `.midi()` with a silent trigger: the track
makes no sound, in the browser or on a port, and every other track plays. The notice to Claude ("Other
tracks keep playing.") is then true. A browser that has Web MIDI keeps Strudel's own `.midi()`.

## Web MIDI is asked for only by code that uses it

The browser's MIDI permission prompt appears only when code with a `.midi(` call is evaluated
(or at page start when the permission is already granted). People who never use MIDI never see
the prompt. SysEx access is asked for at once, because Strudel asks for it in the same request
and the user should answer only once. The permission belongs to the page's origin, so a Moontide
started on another port asks again.

## Instruments are one per-user file plus shipped models

The user describes the instruments in one file, `instruments.json`, in the data folder, and each
entry points at a model: a shipped one (`mt32`, `sc55`) or one the user saved. The models hold the
facts about an instrument (channels, sounds, reset, controls); the file holds only what is the
user's (ids, ports, the channels used). The file is read again at each page connection and each
change, so an edit applies without a restart. An invalid `instruments.json` means no setup until
it is fixed: the last valid version is not kept, and code that uses `.midi(` fails with the
field and the reason. A silent fallback would let a typo send notes to the wrong place.

## An instrument switched off is silent, not unknown

The user can switch an instrument off from the Instruments view. Off is an unplug: the page
silences its channels twice (sustain release and All Notes Off, now and again a moment later), stops
its clock, and drops the notes the playing code still makes for it by the same rule as a replugged
port. On is a replug: the instrument is reset, then set up twice, like a device that came back. The
instrument stays a valid entry of `instruments.json`, so it is silent and not unknown.

Code that newly aims `.midi()` at a switched-off instrument is refused, with the reason, and the
previous music keeps playing. The refusal is per instrument. A call is new when the playing code
names no `.midi()` call to that port. This matches "aimed at an instrument", needs no channel
reading, and works port by port. A second track added on an instrument the playing code already
names is allowed and stays silent. The playing code keeps its place, so Mixer moves, part launches
and a reload that replays the stored code keep working (the replay is never refused). Stop's panic
still reaches the instrument; All Notes Off is harmless there.

## The on/off choice lives in its own file

The choice is `instruments-state.json`, `{ "off": [ids] }`, next to `instruments.json` and never
inside it, because `instruments.json` is the user's own file. The server reads it at every use. A
file that cannot be read or is not that shape makes the setup invalid, because "everything on"
would send notes to a device the user switched off; the first reason says to delete the file. A
switch whose file cannot be written is refused, so a card never shows a choice that would not
survive a restart.

The page asks "set to on" or "set to off", never "toggle", and only the playing tab may ask. So a
repeated or stale request cannot flip the state twice, and no revision counter is needed. The
server tells Claude each change once, including a choice it finds at its first read.

Only the playing tab is pushed the instruments and their on/off state. A tab that lost the role
shows no instrument cards, only the notice that another tab plays, so it has no switch or form to
show a stale state with. It reads the current instruments again when it takes the role back.

## The page edits three fields of instruments.json

From an instrument's card the user can change the port, the channels and the clock of one entry.
The click is the authorization. The server patches those three keys of the entry, checks the
result with the same code that reads the file (so a channel the model lacks, an empty port or two
instruments on one port come back with the field and reason a hand edit would get), and writes it
through a temporary file. The previous text is kept as `instruments.json.bak`, and the save is
refused when the file changed in the meantime. The file keeps its key order, indentation and line
endings; a compact file is pretty-printed once, and its backup keeps the compact text. Only the
active tab may write.

Claude still has no tool for this and can only suggest a change in the chat. A Claude tool that
changes settings after the user's yes, and an undo button, are deferred; the backup is the way back
for now.

## The sound lives in the code

A sound is chosen on the `.midi()` call, in its options: `sound: 'name'`. Strudel ignores the
key, so the sound is part of the code. History, `restore_version`, hand edits and the Mixer keep
it without any extra state: a restored version brings its sounds back. The page sends the program
change just before the new version takes over, as a difference from what it last sent.

## A sound change drops the old code's notes on its channel

The old code keeps triggering notes until the new code takes over, and those notes already hold the
webmidi output they were made with. When the program change goes out, a note of the old code that
follows it would sound with the new sound (found at the 2026-10-02 bench). Delaying the program change
cannot close that gap. So the page drops, from just before the program change, the messages of that one
channel on the outputs the old code holds, and gives the new code fresh outputs at the takeover. A failed
change lifts the drop. Nothing is dropped at the first evaluation or after a Stop, where there are no old
notes. A note already held is still announced to Claude as one the change may cut.

## A refusal is a real failed evaluation

With an `instruments.json`, an unknown port, channel or sound fails the evaluation instead of
being a notice. The page refuses through the original evaluate, so the previous music keeps
playing and Claude gets the reason with the valid values. A known port that is only unplugged
stays a notice, because it may come back. Without the file nothing changes.

## An instrument is reset once per connection, never on Play

The model's own reset and wait bring an instrument to a known state when it connects: page
start with the port present, a port that comes back, Munt started again. Play and code changes
never reset, because that would cut the music and repeat on every edit. A short settle delay
and one reset per connection keep noisy port events from resetting twice. A reset is only ever
sent to a port that is in `instruments.json`, and Claude is told once.

## A replugged instrument's notes wait for its setup, sent twice

Right after a USB replug an instrument or its interface may not take its setup: at the 2026-10-02
bench an SC-55 played wrong sounds from the right bytes, and the same bytes sent a little later fixed
it. So from the moment a rig instrument's port is back, the page drops Strudel's notes to it, sends
the reset, the setup, and the same setup again `RECONNECT_REPEAT_MS` later (1 s, a starting value to
tune at the bench), and then lets the notes through. Notes are dropped, not queued, because a queue
would release the whole waiting window as one late burst. Only the setup repeats: a second reset
would cut notes and needs its own wait. Every reconnect does it, because the cause does not depend on
the model. The page's own bytes (the reset, the setup, Stop's silence, a control preview) are never
held; only the notes Strudel sends are.

## Instrument controls are static levels in the `.midi()` options

A control of an instrument (volume, pan, reverb send, sustain) is a number in the `controls` option
of the `.midi()` call, in the instrument's own range: `controls: { volume: 100 }`. Like the sound,
Strudel ignores the key, so the level is part of the code and history, restore and hand edits keep
it. The page sends it in the setup step, before the new code plays, because the spikes showed that a
CC7 that changes at the instant of a note arrives late on the MT-32. One CC goes out per change, and a
control that leaves the code goes back to the model's default. A sweep stays `ccn` and `ccv`: the
Mixer never writes over it and shows that control as moving. An accepted limit: after a sweep ends,
the instrument keeps the last swept value while the page believes it is at the default, because the
page does not track what a sweep sent.

## Muting a MIDI track ends its notes

Strudel times each note-off when the note starts, and the browser cannot take a queued MIDI message
back, so muting or removing a track would let its long notes ring on. The page compares the code that
played with the code that plays after each evaluation. When no other track plays the channel, it
sends that channel's silence (sustain off, then All Notes Off), the same pair Stop sends per channel.
When the channel is shared, it ends only the stopped track's own sounding notes with note-offs, found by
querying that track's pattern around the scheduler's now. Both go out twice, the second time 300 ms
later, to catch notes Strudel had already queued. A note-off also ends another track's note of the same
pitch at that instant: accepted. Unmuting replays nothing; the track comes back at its next note.
When two outputs match one port name, a mute sends neither note-offs nor silence and logs why (the
notes ring to their natural end), while Stop still silences both. Each pass also ends the note-ons
already queued ahead on that channel with the stopped track's pitches (see "MIDI notes leave the page
ahead"), with a note-off 1 ms after their own time. The record of queued notes does not know which
track sent a note, so the passes use the moment the note's trigger ran: they end only note-ons triggered
up to the instant the new code took over, never a later note of the track that keeps the channel. What
stays accepted: a note-on of the same pitch that the other track had already queued, or had triggered
before the takeover and sends within its next 140 ms or so, is ended too.

## Moontide owns the MIDI clock

A follower such as a hardware sequencer or arpeggiator needs MIDI clock, a Start and a Stop. The page
sends them, not the code. A clock written as a Strudel pattern rides the main thread: spike 008
measured a tick spacing with an SD of 2.5 ms when the page is idle and about 20 ms under load. The page
clock sends each tick up to 150 ms ahead with a timestamp taken from the scheduler's own cycle-to-time
mapping, so the system delivers it on time whatever the page does: SD 0.1 ms, unchanged by a busy page
or a tempo change.

The clock counts 4 beats per cycle, 24 ticks per beat, 96 ticks per cycle, so a tempo of N beats per
minute is `setcpm(N/4)`. A tempo change in the code moves the clock with it.

An instrument gets one Start on a cycle boundary: the first cycle when the music starts, the next one
when the code starts naming it while the music plays. Its notes wait until
`CLOCK_NOTE_LEAD_MS` (50 ms) before that Start, the first moment a note-on is let through (spike 010,
pass 5b). 50 ms is a starting value from one measurement; a bench session is meant to tune it. A
note-on that carries a timestamp (see "MIDI notes leave the page ahead") passes when its own
timestamp reaches the Start, with 1 ms of slack; the 50 ms lead applies only to a note-on without
one. A stamped note within the clock's horizon that finds no Start planned yet (on a busy page its callback can
run before the clock's own pass) plans the Start itself first, so the downbeat's note is not dropped. Stop
goes out at once, so followers stop with the music (spike 010), with one exception: a Start that is
still ahead gets its Stop after it, so no follower is left started. No Song Position Pointer and no
Continue are sent, so a follower always starts again from its beginning.

Which instruments follow the clock: a model or an `instruments.json` entry says `clock`, and the entry
in the file wins over the model. The shipped models say `clock: false`. The playing code names the
instrument, in a `.midi()` call, and a muted track still does: its clock keeps running, because a
sequencer that plays by itself would not stop with its track. Naming it needs no note
(`silence.midi('port name', { midichannel: 3 })`). Removing the name sends a Stop.

Strudel's own clock and transport bytes (a `midicmd` of clock, start, stop or continue, and the Start
Strudel sends on every MIDI track at cycle 0) are dropped in the page's guard, so a follower never gets
two clocks. Claude is told once per code that they were dropped. A written `midicmd("start")` that
fires only in cycle 0 cannot be told from Strudel's own Start there, so it is dropped without a notice.
The test is a limit: Strudel sends its Start for every event that begins at cycle 0 of the pattern, so a Start
it sends once the scheduler is past cycle 0 is taken for a written one, and the notice appears for it.
A second limit comes from notes leaving ahead: a Start written exactly at cycle 1 now leaves at about
cycle 0.95, so it is taken for Strudel's own and dropped without a notice.

The clock reads internal fields of the plain Cyclist of the pinned Strudel version. Three layers pin
that: `npm run check:reference` (the claims `midi-clock-cyclist` and `midi-transport`), a runtime check
that throws with the missing field's name, and `npm run probe:midi` in the real page.

## MIDI notes leave the page ahead, with the clock's timestamp

The pinned Strudel fires each MIDI send from a Web Audio timer at the note's own instant and gives
webmidi no time, so the main thread decided when a note left. Measured on the IAC loopback before the
change (with the bench `npm run bench:midi`): an interval SD of 2.5 ms on
an idle page, and 18.9 ms with 68 bursts and 42 gaps in 10 s on a busy one, with a note landing up to
about 20 ms off the page clock's tick of the same instant.

The choice: the page wraps `.midi()`, maps each hap's target time with the page clock's own mapping,
and lets Strudel's sends leave `NOTE_AHEAD_MS` (120 ms) early with that timestamp. A note and the tick
of the same instant now carry the same timestamp. After the change, on the same bench: an interval SD of
0.07 ms idle and 0.07 ms busy, no burst, no gap and no late send, every note-on stamped; with a clock
instrument the note minus its nearest tick has a mean within 0.01 ms of 0 and an SD of at most 0.18 ms,
idle and busy. A note that is late anyway goes out at once and keeps its length: it is never dropped.

What the user hears: MIDI notes now sit about 34 ms later relative to the browser's own sounds than
before. They follow the page clock, and no audio offset is applied. This is decided, not a bug.

The tail: Chrome cannot take back a message already queued, so a note-on queued ahead would still
sound after Stop, a mute or a solo. Stop, a mute and a solo end the note-ons already queued with a
note-off 1 ms after their own time (`QUEUED_NOTE_OFF_AFTER_MS`). Every other message leaves ahead too: a
sustain pedal (`ccn(64)`), another control change, pitch bend, NRPN or SysEx. The page records them as
well, and when one is still queued on a channel, Stop sends the sustain release (CC64 = 0) of that channel a
second time with a timestamp 2 ms after the latest of them (`QUEUED_SILENCE_AFTER_MS`), and a mute does the
same for its channel, so a pedal the stopped code pressed is released after it went down. That copy is
only the sustain release: every queued note-on already has its own note-off, and an All Notes Off landing up
to about 120 ms after Stop could cut the first notes of whoever plays next. A hold the page writes on that
channel before the release lands (a setup after a quick Stop and Play, a quick Mixer unmute, a dragged
control) goes out 1 ms after the release, not before it, so the release never lifts a hold for good. A tab
that lost the active role sends no timed release at all: it cannot know what the tab that took over sets
up, and a release landing after that setup would lift its hold. Accepted: a pedal press the old tab queued
in its last 120 ms before the take-over then stays down until the next Stop or the next sustain value the
new tab writes. A note-off needs no compensation and is not recorded. A SysEx belongs to no channel: a mute
leaves it recorded (a sound change on another track still waits for it), and only Stop forgets it. A sound change times its bank select, program change and controls just after the latest message
of any kind already queued on that channel, so no old pitch plays on the new sound and no old control
sweep lands over the new controls. A compensated note still starts, and ends 1 ms later; on a fast-attack sound that may click. That
is not yet heard on real hardware: the next hardware bench session checks it, together with a fast note
pattern on a busy page followed by Stop.

Accepted limits:

- A Start written exactly at cycle 1 now leaves at about cycle 0.95 and is taken for Strudel's own, so
  it is dropped without a notice.
- The reconnect hold drops the notes that leave during its last `NOTE_AHEAD_MS`, even when they would
  sound after it.
- The first notes after a fresh page load, before the mapping is warm, leave without a timestamp;
  preparing MIDI code warms it.
- The numbers are from one Mac, one Chrome and the IAC bus; Windows and Linux timestamps are not
  measured.

Pins: `npm run check:reference` (the claim `midi-trigger-seam` holds the Strudel and webmidi facts the
wrapper relies on, so a Strudel upgrade that moves one fails by name), a loud error when the wrapper
cannot be installed, and `npm run probe:midi` in the real page. The alternative kept in reserve: running
Strudel's timers from the page itself instead of moving the target time.

## A drafted model is saved only after the user's yes

A model drafted from a pasted manual page is a file that later reaches real hardware, so the
save is two steps. First Claude sends the draft and gets a summary with nothing written: the
channels, the sounds with their program as sent and as a manual numbers it, the controls, the
exact reset bytes and every note. The model is written only when the same model comes back after
the user said yes. It never replaces a shipped model or an existing one by accident, and a reset
in a drafted model is limited to 4 short framed SysEx messages. The file goes into the data
folder, never into Moontide. No tool writes `instruments.json`: the user
writes it by hand or changes three fields of an entry from the Instruments view, and Claude may only propose a change in the chat.

## Sound catalogs are per-model files in the data folder

A model that has thousands of sounds gets a catalog: `catalogs/<model id>.json` in the data
folder, attached to the model by its file name and never shipped with Moontide. It holds melodic
sounds and, for a model whose rhythm channels take a bank, its drum kits (see "Rhythm channels may
take a bank, per model"). The catalog sounds travel in the `midi-rig` message after the model's own
(the kits in a kits list, after the model's own kits), so the page resolves them with the code it
already has: 5,000 sounds measured 330 KB and a few milliseconds. A broken catalog of a model that
is in use stops MIDI code until it is fixed, like a broken setup file, because a silent fallback
would play the wrong sound. A catalog of a model that is not in use is never read.

## MIDNAM files are read, never shipped

Many instruments have a MIDNAM patch file somewhere. Moontide reads one with an in-house reader
and no XML library, because the format needs only a handful of tags and a new dependency would
cost more than the reader. The user provides the file; Moontide never downloads or copies one, and
the repo holds only a file written for the tests. The files have several authors and no license of
their own, so the user answers for what they import. Name sets that only serve rhythm channels
are skipped, unless the model's rhythm channels take a bank, where they become kits; two sounds with one name are renamed by their address, and the model must exist
first, because the bank shape of the file is checked against it.

## A catalog from a PDF is saved only after the user's yes

Moontide has no PDF reader: Claude reads the maker's sound list and sends the sounds. The draft
lives in the session's memory, in parts of at most 500 sounds up to 5,000, with at most 3 drafts
at a time, so nothing is written before the user decides. The program numbering is converted once
on the server and the summary shows three sounds with both numbers, so a shift by one is visible.
The confirm carries no sound: it saves only the draft whose summary was shown, and every new part
clears that mark. A draft is lost when the server restarts, and Claude is told so plainly.

## Rhythm channels may take a bank, per model

Version 1.2 settled that the page never sends a bank select on a rhythm channel. That reopens for
instruments that choose a drum kit by bank. These choices are settled.

- **Why there was no bank.** General MIDI and the SC-55 choose a kit by program number alone. A bank
  select (CC0) on channel 10 is not needed there and, on some firmware, does harm. So a rhythm channel got a
  program change and nothing else.
- **That stays the default.** A model that says nothing sends exactly the bytes it sent before.
- **Why it is reopened.** The JUPITER-Xm chooses its drum kits by bank and program: bank MSB 86, with
  LSB 64 for its 17 PR-A kits and LSB 65 for its 74 CMN kits, on part 5 only (JUPITER-X/Xm MIDI
  Implementation v1.06, bank select table; JUPITER-Xm Reference Manual, the FAQ on part 5). Without a
  bank, no kit of that instrument can be chosen.
- **The choice is an explicit model field.** `rhythmBank` is optional and off when absent, so General MIDI,
  SC-55 and MT-32 models send exactly their old bytes. Golden tests written and green before the change
  pin this, and the fake MIDI device in the real-page probe checks it again on channel 10. A model
  that opts in must give every kit a bank, because a missing bank would go out as 0/0, which is a
  melodic bank on the drum part. The file is refused loudly instead.
- **A kit is chosen like a sound.** The `sound` option on the rhythm channel, with no new option. The
  page sends the bank select and then the program change before the new code plays. A kit change that
  only changes the bank is sent, the same kit sends nothing, and rollback, reset and replug send the
  kit again, as they do for every sound.
- **Maps are model data.** A model holds `drumMaps` (named lists of note and name), an optional
  default `drumMap`, and each kit may name its own map with `noteMap`. The server resolves them and
  the page receives the resolved maps in the rig message, so it has no table logic. A `noteMap` of
  null says that a kit's map is unknown. The page never falls back to General MIDI and never turns a
  name into a note: the code keeps writing note numbers.
- **Where the shipped maps come from.** General MIDI is built in. The SC-55 carries the maps of its
  Owner's Manual drum set table (pages 70 and 71): one standard map shared by the Standard and Jazz sets
  and the five sets that only replace a few voices, and its own maps for the Orchestra, SFX and
  CM-64/32L sets. The MT-32 carries the factory assignment of its Owner's Manual (page 13). The
  JUPITER-Xm kits have no published key table, so their maps are unknown. A lane with no kit written
  uses the model's map, which is right only while the instrument holds that kit.
- **Kits live in a catalog.** A catalog file may hold a `kits` list, and MIDNAM rhythm name sets become
  kits, both for models that opted in only. Kits follow the model's own kits in the rhythm sounds of
  the rig message.
- **The JUPITER-Xm kit path is not heard on hardware.** It follows the convention of the user's
  existing catalog (the printed bank numbers, the program as printed minus 1). Every check so far runs
  against a neutral fixture, the fake MIDI device and the page's bytes. A bench session on the
  instrument still has to check: the wire values of the banks, a kit change on part 5, the part's
  Rx Bank switch (a part ignores a bank select when it is off), the arpeggiator re-selecting a kit by
  itself, and the kit sent again at reset and replug. No JUPITER-Xm model is shipped: the user's own
  model and catalog live in the data folder.

## Claude is told the real reason

When something cannot play, Claude and the user are told the real reason, in words that fit the
reader. These choices are settled.

- **Found by content.** A build is told apart by a fingerprint of the bytes, with no manual version
  bump and no size or modification time. `npm run build` rewrites identical bytes with a new mtime,
  so an mtime check would say "restart" after every build and every test run. The page folder and
  the compiled code are hashed separately, because only a changed page breaks the contract between
  the page and the server. A server-only update asks for a restart and refuses nothing.
- **Its own message.** The server sends `build-mismatch` (or `server-updated`) only when something
  differs, before `midi-rig` and `hello`. The connect sequence of a matching build stays as it was.
  Rejected: a new field on `hello`.
- **Fail closed, with the true reason.** Under a mismatch, code with `.midi(` is still refused, but
  the reason given is the mismatch. A setup the page cannot read while no mismatch is known (the
  first upgrade, from a server that predates the check) is called not readable and never blamed on
  the file. Only a file that the server itself reports invalid keeps the "invalid" wording. The line
  stays in its own persistent place, not in the evaluation error line, which clears at the next good
  evaluation.
- **Worded for each reader.** The same mismatch is worded differently where it is read, on purpose,
  because page files and their pinned tests stay as they are. What they share: each one says
  different builds and restart, and none blames `instruments.json`.
  - The top bar says `Restart Claude: different builds`. The action comes first and the line is
    short so the top bar never cuts it; the full explanation is in its hover title. The Instruments
    view reuses this line and adds its own sub-line.
  - The MIDI indicator says `MIDI: different builds, restart the server`, in the indicator's own
    "MIDI: ..." form. Its popover says "The server and the page come from different builds, so no
    instruments are set up." and then "Restart Claude (the server), then reload this page."
  - The refusal of `.midi()` code says what cannot play and why: "Code with .midi() cannot play,
    because the server and the page come from different builds, restart the server (restart
    Claude)." It is read in the error line or in a `set_code` reply.
  - The Mixer strip reason is one line under the track name: "The server and the page come from
    different builds — restart Claude (the server) to use this instrument's controls."
  - Claude's note says that Claude runs the server: "Note: the server and the page come from
    different builds, restart the server. Moontide was updated since this server started; restart
    Claude (which runs the server) to use the update."
- **A test query before every takeover.** A new pattern is queried over the next cycle with
  `Pattern.query` before it takes over. Rejected: `queryArc`, which catches the error, logs it and
  returns nothing, so it hides the failure. Also rejected: checking after evaluate returns, because
  the failing pattern would already be the scheduler's and would silence the music before any
  rollback. An empty result passes, because silence is allowed.
- **Later query errors, once per change, from the scheduler only.** Strudel's log repeats an
  identical line at most once per second, which is not once per change, so the page keeps its own
  guard and resets it at each takeover. The Timeline, the Drawer and Stop's sweep also query
  patterns, and they must not speak for playback.
- **A notice for `t` and `f` flags, not a refusal.** In the pinned Strudel, no mini-notation atom is
  a boolean. `struct`, `mask` and `when` test truthiness, so `t` and `f` both count as true (`f` is
  also a note name), and the false steps are `0` and `~`. The functions topic says so and
  `npm run check:reference` pins it. The `set_code` and `restore_version` replies add a notice for a
  `t` and `f` string, whether it is written out or held in a top-level const. The check is a text
  match only, so a match inside a comment counts, by design. It is not a refusal, because the code
  plays as written.
- **The Parts view says why.** It reads top-level numeric constants as section lengths. For an
  `arrange()` it cannot read, it names the call and the reason instead of saying there are no parts,
  shows the calls it can read, and adds one line per skipped call. Nothing in it pushes toward
  sections (see "Facts, not taste"). Whether the Parts and Jam views should read sections and
  harmony is still an open question.
- Superseded when the sections and harmony views arrived: the Parts view now reads constant arithmetic, a spread
  of a constant list and a pair held in a constant, and reading harmony is settled. See the four
  sections at the end of this file.

- Superseded by the top bar redesign: the `Restart Claude: different builds` line and the softer updated line sit in
  the Session drawer, not in the bar. A one-line strip under the bar repeats them while the drawer is
  closed, and the Session button counts them. The evaluation error line is the failed-change banner.

## A change can wait for the bar line

A new version used to take over at the scheduler's next tick, a fraction of a second after the
evaluation and off the grid, so a scene change in a long piece had a rough seam. Now a change can take
over on the next bar or the next phrase.

- **The default stays now.** A change takes over at once, for Claude's `set_code` and for a hand
  evaluation. Claude asks for `at: "bar"` or `at: "phrase"` (optionally `phraseCycles`, 2 to 64) when it
  wants a clean scene change, and the user picks the same three choices for their own edits with the
  "Edits:" button in the top bar, remembered in the page. A surprise wait on every edit would feel like a
  broken editor, and the user chose this default.
- **Check at once, wait only for the takeover.** The new code is evaluated and checked when it is asked
  for: an evaluation error, the query check and a MIDI rig refusal fail it there, the old music keeps
  playing and the error shows as usual. A refusal that arrived a bar later would be too late to tell
  Claude anything useful.
- **A gate, not a timer.** The scheduler is handed a pattern that is the old one before the line and the
  new one from it. A timer would land a few milliseconds early or late and could be throttled in a
  hidden tab; the gate lands on the line whatever the slice grid is. The line is the first multiple of
  the bar or phrase length after the scheduler's frontier, at least half a second ahead, counted on the
  scheduler's own cycle count (which restarts at every Play), so no start time is stored.
- **What plays now follows the line.** The history entry, `get_code`, the version, the MIDI facts, the
  views and the hand-evaluation report all run when the line is audible. Until then the old code is the
  answer everywhere, and the Timeline and Jam views read it while a change waits.
- **The tempo changes at the line.** A `setcps` or `setcpm` in the waiting code is held back right after
  the evaluation and applied just after the gate's first query past the line, so the old bars keep their
  tempo and the downbeat is exact.
- **MIDI goes out at the lead.** The setup of the waiting code (sounds, controls, the clock Start of a new
  instrument) is only checked at the request, then sent a little before the line stamped on it, so
  nothing reaches an instrument early. A cancel before it went out drops it. Bytes stamped on the line
  cannot be recalled from the port, so a cancel after the lead sends the playing code's sounds and controls
  back stamped half a millisecond after them: the instrument takes the canceled sound on the line for that
  half millisecond, and the playing code keeps its own from then on. A newer timed change prepares its own
  setup later, at its own lead, and goes after that put-back. A newer immediate change (a change at now, a
  hand evaluation, a History restore) has already sent its own setup when it replaces the waiting one, so the
  put-back leaves the sounds it sets up alone, sends the playing code's sounds only on channels it does not
  set up, and sends its controls again after the canceled ones. If the rig changed meanwhile the setup is skipped and the MIDI facts say
  why; the change is not canceled.
- **Last wins, Stop cancels and keeps the text.** A newer change replaces a waiting one, and so does a
  History restore. Stop cancels the wait and leaves the new text in the editor, where it plays on the
  next Play like any edited code. Claude is told once about a canceled or replaced change.
- **What a cancel puts back still reports.** Stop, a tab that loses the role and a tab that closes put the
  pattern that played back in the scheduler. That pattern reports its own query errors from the moment its
  change was armed, so if the scheduler plays it again without a new evaluation, a query error still reaches
  Claude once. Every Play the page offers today evaluates code and installs a new pattern; this covers a
  restart that does not.
- **The first span past the line keeps the old tag (accepted).** The scheduler queries a little ahead of what
  is heard, so its first query past the line holds the end of the old music and the start of the new code,
  before the line is audible. A query error there is reported with the old change's tag: Claude reads it as
  coming from an earlier version, and its repeats in that change are held back. Only failures that need the
  scheduler's own query controls get there, because the test query from the line catches the others.
  Splitting it would need errors routed per half of the gate through the takeover, the query scope and the
  page's evaluate tag, and the tag given back when Stop cancels before the line. That is not small, so it is
  accepted, and a unit test pins it.
- **The Mixer and Parts refuse while a change waits.** A fader move or a part launch acts on the playing
  code; doing that silently would promote the waiting change. They show a short neutral notice instead
  and work again at the line.
- **No tempo tool.** The tempo shows in the top bar, and the `set_code` reply states it in one line when
  it changes. A smooth change of tempo is an option of the tools that change the music, not a tool of its own
  (see the tempo ramp, below).
- **The top bar stays calm.** The tempo, the countdown (counted in beats of the music from the cycle
  position) and the setting are plain text with no animation, and the page gives up words in a fixed
  order instead of clipping a control.
- Superseded by the top bar redesign: the "Edits:" button that cycled the setting is three buttons (now, next bar,
  next phrase) in the Settings card of the Session drawer, and the tempo is always in the bar (a dash while
  nothing plays). See "The top bar and the Session drawer".
- Superseded by the tempo ramp: the earlier note that a tempo ramp waits for a later design discussion is
  closed, because Claude wanted to move the tempo smoothly and a code that sets a tempo can only jump (the
  tempo functions read their value once). The discussion settled this. The code holds the tempo to reach, and
  `glideBars` on `set_code` and `edit_code` says over how many bars (1 to 64) the tempo moves to it. There is
  no separate start value: a ramp leaves the tempo that plays. It is linear in BPM, in steps of at least a tenth
  of a second and no finer than a tenth of a BPM. The steps go only through the tempo guard and are placed by
  the music's own cycle, so a scheduler that stalls stalls the ramp with it, and it ends exactly on the code's
  tempo. The course is put back after every evaluation: a program that states the same tempo, and one that
  fails, leave the ramp going; another tempo, or none, cancels it. A change that waits for a line starts its
  ramp at the line. Stop cancels the ramp and the next Play starts at the code's tempo. The ramp lives in the
  page's memory only: a reload or another tab loses it, and Claude is told once. A ramp is refused whole, with
  nothing changed, when nothing plays, when the code sets no tempo or when it sets the tempo that already
  plays. The top bar has no cancel control (Stop cancels). How a hardware instrument that follows the MIDI
  clock reacts to a ramp has not been verified; the bench is still to do.

## Claude can send only the change

Changing one value of a long piece used to mean sending the whole piece again. `edit_code` sends only the
change, and the server builds the whole program from it.

- **set_code stays.** `edit_code` changes part of an existing piece. `set_code` is for a new piece or a
  rewrite of most of its lines. The rule is a fact in both tool descriptions and in one `get_code` line for
  code of 8 lines or more. The server instructions do not change and keep their margin.
- **Exact, once, all or none.** Each `old_string` matches exactly once, or `replace_all` is set. Every edit
  is matched against the code as it was before the call, and edits must not overlap. CRLF counts as LF.
  Anything else refuses the whole call with the reason and the edit number, and nothing reaches the page.
  Nothing is applied approximately. The new text is built by index and slice, never by a pattern
  replacement, because Strudel code holds `$:` and `${}`, which a replacement would read as its own syntax.
- **The newest code that will play.** While a change waits for its line, an edit applies to that change's
  code. Applying it to the playing code would silently drop the waiting change. Otherwise it applies to the
  playing code with the user's evaluated hand edits. Text typed but not evaluated is replaced, as with
  `set_code`.
- **An optional base version.** The version `get_code` shows. It is compared with the version playing now,
  since a waiting change has none until its takeover. A different or unknown version refuses the edit.
- **One change at a time.** An edit states a delta, so it is built on the newest code. While an
  evaluate request the server sent (a `set_code`, an `edit_code`, a `restore_version`, a restore started
  from the page) has not been answered by the page yet, that code is about to change, and an edit built now
  would be dropped silently when the page plays the later whole program. The call is refused loudly
  instead, telling Claude to wait for the reply, call `get_code` and edit again. A `set_code` states the
  whole program, so it is never refused this way. Changes that start in the page (Mixer moves, part
  launches, hand evaluations) create no pending request, so they do not block an edit; see the next bullets.
- **Kept, and said to be kept.** An edit on hand-edited code keeps the hand edit, and its reply says so. A
  timed edit's takeover never claims it replaced the hand edit.
- **The reply shows the change.** The head line names the code that was edited and the version. Then come
  the changed lines with two lines around them, capped. One call is one history entry, a change from
  Claude, with no new label.
- **Accepted, shared with set_code.** A hand evaluation that itself waits for its line is unknown to the
  server until its takeover. An edit sent meanwhile applies to the playing code, and the page replaces the
  user's waiting change, as a `set_code` does today. A Mixer move still on its way to the server, a few
  milliseconds, can be lost the same way. Neither needs a page change, so they are written down, not built
  for. For the same reason the refusal of "One change at a time" does not cover a Mixer move, a part launch
  or a hand evaluation that lands just before an edit: the edit builds on the code before it.
- **Measured.** `npm run bench:edit` compares the characters sent and the call-to-reply time of both tools
  on pieces of three sizes.

## moontide-mcp takes one subcommand

`moontide-mcp import-midnam <file> --model <id>` is the only subcommand. With no argument the
server starts as before. Any other argument exits with code 2 and the usage line; it used to be
ignored, and a typo would have started a server that the user did not mean to start.

## The Mixer edits the tracks of real pieces

Four fixes that came from real sessions with tracks that Claude wrote with their own dynamics.

- **The fader multiplies, it does not replace.** In this Strudel a later `.gain(n)` replaces every gain
  set inside a track, so a fader that wrote `.gain(x)` made ghost notes as loud as accents. The fader
  writes `.postgain(x)` unless the track's own chain already holds a fixed `.gain(n)`, which it still
  edits in place. An older `.gain(n)` is never converted, because that would change the sound under the
  user's hand. An untouched track therefore reads 1.00 (as written) instead of the bundle's default gain, with a hover that
  says so. A track whose post-gain moves in the code gets a disabled fader and says why. So does a track that
  sets its own post-gains inside it or in the shared code it reads (a later `.postgain(n)` would replace
  them), and a track that plays MIDI without a MIDI strip (its `.midi()` is in shared code or inside
  another call): MIDI output reads gain and velocity but never the post-gain, so a post-gain fader would
  change nothing audible there. Such a track also gets no Add effect, no reverb or delay sends and no place on a
  bus, and its effects cannot be edited, because MIDI output never plays them: its strip says so in one line, and
  a change that reaches the writer anyway is refused. Its gain, mute and solo still work. A drag that ends at 1.00 on a track with no post-gain
  writes nothing, and every disabled browser fader reads 1.00 (a disabled MIDI fader shows an en dash). MIDI
  faders keep writing the instrument's volume (CC7). `npm run probe:page` queries the real pattern before and
  after a drag, and `npm run check:reference` pins the replace-and-multiply facts to the pinned bundle.
- **A track built from shared code is editable.** A track such as `kick: beat`, where `beat` is a
  constant, a destructured name or a function declared above, used to get a disabled strip. The Mixer now
  writes at the end of the track's own chain, so the constant and every other track that reads it never
  change. It reads only that chain, so the strip says "Built from shared code" instead of guessing what
  the constant holds. The Mixer looks through the code a track refers to for three things only: an orbit, a
  send or a bus value; a post-gain; and `.midi()`. It follows real references to a name declared
  at the top of the program (also one assigned later), through other constants and functions; a method
  name (`.scale(`), an object key or a name that a parameter or a local binding shadows is not a reference.
  A track that sets an orbit, a send or a bus value anywhere but on its own chain (in a constant or function
  it names, inside another call, through `.set({ orbit })` or a bare call) has its sends turned off, because
  a send or bus value written on it would reconfigure another orbit's reverb or delay; its rows show the send
  its own chain writes, or an en dash when the code the Mixer does not read may set it. The Mixer prefers
  refusing to guessing, so any such write turns the sends off, even one it could read. A track that sets
  its own post-gains or plays MIDI disables the fader (see above). Nothing else in the constant is read: an
  effect set there (`const beat = s("bd").lpf(500)`) is not shown as a chip, and an effect the Mixer adds on
  the track replaces it, because the last write wins. A condition (`a ? b : c`, `a && b`) or a shape the Mixer
  does not understand is still refused, with its reason. `npm run probe:page` drags the fader of a
  constant-rooted track in real Chrome and checks that only that line changed.
- **MIDI tracks that play no notes have no strip.** A track whose code provably cannot play a note (it
  only sends controls, changes the program, or is a silent clock track) is listed in one line at the
  bottom of the Mixer, with its instrument and channel, instead of getting a strip with a fader that does
  nothing. The reading is static and uses a closed list of names, so anything unknown keeps the strip: an
  instrument is never hidden by a guess. Folding changes only the display: the track still sends its
  controls and program changes, and it stays with the other tracks of its channel, so a strip on the same channel
  still names it under "Shared with". The line marks a track that does not sound as silent, and its hover
  says the Mixer cannot mute, solo or edit these tracks (ask Claude): keeping their channel controls
  reachable would need an inspector entry per folded track. `npm run probe:midi` checks both the line and the bytes sent.
- **A selected strip lights its code.** Clicking a strip's name, or touching any of its controls, selects
  the strip; its block of code (from the label to the end of the statement) is softly lit and scrolled into
  view. The light is an overlay in the editor's scroll container, like the change flash, so the text and the
  cursor never change and nothing is evaluated or recorded. It shows only while the editor holds the code
  that plays, so it is never drawn on the wrong lines: it goes away while an unevaluated edit or a waiting
  change makes the two differ, and comes back when they match. A measure that finds the text changed since
  it was scheduled takes the light away instead of drawing it on the old lines. The constants a track reads are not lit, only
  the track's own statement. The editor scrolls only when the selection changes, never when the light
  follows a render, an edit or a resize, so a user who scrolls away is not pulled back. The light has its own
  neutral color, softer than the flash, and no motion.

## A right-click on the Timeline sends a moment

- **The facts are the ones drawn.** The moment is read from the events the Timeline already holds, never
  from a new query. "Sounding" means the drawn span of the note holds the instant (a release tail is not
  part of it, and a note shorter than 0.05 cycles is drawn and counted 0.05 wide, so its `end` can come
  before the instant) and "starts" means it begins later in the same sixteenth of the bar, because one
  pixel is about half a sixteenth. A note that began earlier in that sixteenth and already ended is not
  in the moment. A right-click on a lane, the ruler, the space between or under the lanes and a
  part header over the lanes all give the same moment at the same x; the lane gutter, the Timeline's
  corner, the Parts and Jam views and a Timeline that shows a message give none.
- **Claude is told what it holds.** The instructions keep only the short framing (they stop at 2048
  characters), so the full explanation (what the notes are, "sounding" against "starts", that a very short
  note shows an end before `at`, that the right-clicked lane comes first) goes where Claude reads page
  requests and nothing limits the length: the arming line, the page-requests-on text, and a line in front
  of request lines that a tool reply hands over without an arming line.
- **Its own field.** It travels in `moment` next to `context`, so a lane right-click still points at its
  track. Strings are cut at 200 characters and a moment holds at most 32 notes plus a count of the rest;
  the notes of the right-clicked lane come first, so the cap never drops them for other lanes. The server
  rejects anything larger, never trims it.
- **The whole line is bounded.** A request line is at most 8192 bytes (UTF-8), counted by the page before it
  sends and by the server on arrival. The page cuts notes off the end of the moment, one at a time, and
  counts them in `more`, until the line fits; the server refuses a longer line as too long and never cuts
  JSON, because a line cut in the middle would leave a fragment where the user's text and the data fields
  can no longer be told apart. Printable text of 2000 characters fits with the rest of the line, but the
  character count does not bound the line: JSON writes a control character or U+2028 as six bytes, so
  2000 of them are over 8192 bytes. The box measures the line as JSON will write it, with the moment cut
  as far as it goes; when that still cannot fit it sends nothing and says "too long to send" (not
  "2000 characters at most", which would be wrong), and the server's own refusal of such a line has its own
  reason, so the page never blames the character limit for it.
- **A drum note carries its name.** A note on a MIDI rhythm lane whose drum map names it carries `drum`,
  that name, beside its number. The field is absent otherwise, never a guess (no General MIDI
  fallback, and a number outside the map has none). The server names the field in its schema, because
  its page messages drop a key they do not name, and a test pins the page's keys to the server's.
- **The version is part of it.** Cycle counts restart at Stop and at a reload, so the cycle alone does not
  say which music was playing.
- **Nothing is invented.** The lane gutter, the Timeline's corner and a Timeline that shows a message
  attach no moment. `npm run probe:page` compares the notes of a moment, lane by lane, with the rects the
  Timeline draws, and `npm run probe:midi` checks that a MIDI lane names its instrument and channel the
  way its tag does.
- **Known limit.** A note that began on the previous 32-cycle page is not in a moment at the very start of
  the next page, because each page holds only the notes that begin on it; a velocity written only in the
  `.midi()` options is not seen and such a note reads the default 0.9.

## The Timeline edits literal notes and asks Claude about the rest

- **Which notes it edits.** A note is edited only when exactly one double-quoted note string in the track's own code
  holds it, the code at that place is the bare token, and the pitch you hear is that token's own pitch. Every other
  note is refused, with one reason in plain words, and the first that applies is the one given: made by a function or
  by chance, or written in a single-quoted string (no one place holds it); a sample, not a pitched note; shaped by
  several places (an added note, a factor like `*2`); written in degrees; held in a string with an escape sequence;
  shifted (something adds to the pitch or copies it); written outside the track's own code (its statement, or the
  variations of a song); or coming from code shared by several tracks. The page cannot see which of these a note is
  by guessing, only by the offsets Strudel keeps, so a note it cannot trace is never edited "close enough".
- **The edit is read back before it is written.** The edited code is tried first and read back: it must give the same
  note at the same place with the new value, and nothing else may change. If it does not, nothing is written and the
  page says so instead of guessing; "Ask Claude" then carries the same change as a ready-made request. When the page
  runs into a problem after it has written the change, it says to check the code and does not offer the change to
  Claude, who would make it a second time. An evaluation that throws and whose text the page took back wrote nothing:
  it is told as a problem before the change, and offered to Claude.
- **The places sentence.** Before any write, a note that plays in several places says so ("Plays in 3 places: sections
  'x' and 'z'"), and the other notes of the same token on the page get a dotted ring, because one edit changes all of
  them. A place is a time a section that holds the token starts, counted from the song's section entries and repeats
  over at most 1024 cycles. Past that limit the count is of the drawn page only and the sentence says "on this page".
  In a piece with no song, a token is told only when it draws several notes in one cycle; a plain loop that repeats
  every cycle is not counted, because the loop marks already show it. A velocity number that plays in several places
  (a variation used by several sections) is counted the same way: the sentence names them, and the edit is read back over
  all of them, so a section that would play another velocity there refuses the edit.
- **Velocity only where one written number holds it.** The shown velocity is gain times velocity, which is what Claude
  receives. The two buttons change it by a tenth, between 0.10 and 1.00, and only when one written number, in the
  track's own code, gives the velocity. A number that several notes of the page share is fine: one step changes
  them all, and the sentence says "for 4 notes on this page". Otherwise (a signal, an option of `.midi()`, a string
  shared by several tracks, or a value that is not one written number) they are off, the panel says "fixed in the
  code", and pressing one says so and leaves the step to Claude. Because the shown value includes the gain, a step on a
  browser lane with a gain below 1 can write a number above 1.
- **The edit timing and the history entry.** An edit takes over with the user's usual hand-edit timing (now, the next
  bar or the next phrase), with no new setting, and is one history entry with the hand-edit notice for Claude. Steps
  from the keys or the buttons gather: 0.6 seconds after the last one the page writes once, so a run of presses is
  one entry, and a step of the other kind (pitch after velocity) starts an entry of its own. Steps that wait are
  written for their note first when the selection moves to another note, a range or a cursor, or when the lanes are
  drawn again; only Escape drops them on purpose.
- **One edit at a time, in order.** Every edit (a burst of steps, a rest, a drag release) waits its turn in one queue.
  The page writes one at a time: the next goes only after the answer of the one before and the lanes that answer
  draws, and it is aimed at its note as those lanes show it, so fast presses on several notes are all written, each on
  the code the edit before it left. A note is found by its lane, its time and its rank among the notes that begin with it, in
  the order of their tokens in the code, which an edit of a token never changes; its pitch is only a check: when the note at that
  rank does not have the pitch the page expects, nothing is written. A lane is found by its name, or, for a track written without
  one, by its place among the tracks, because the strings such a track is known by change with every edit. A rest takes a note
  out of its chord, so the other notes of that chord are found again only from the lanes drawn after the rest: those lanes must
  show the chord without the rested note (and without any copy a layered track drew of it), the other notes with the same
  pitches, in the same order and at the same places in the code. Their edits wait until then. When the rest did not take over,
  ended in an error at or after the write or with no answer, or those lanes show anything else, the page does not guess: their
  edits are dropped and the panel says they were not written, naming the note, and a redraw selects none of them. A rest the
  page refused or could not evaluate wrote nothing, so the notes beside it are found as before. So between the Timeline's own
  edits, an edit in a chord does not land on another note, even one that has or had the same pitch. When other code takes over
  in between (a change by Claude that plays at once), the ranks counted before are applied to the new code, and only the pitch
  check stands between an edit and another note. A burst or a drag on a note whose earlier edit
  still waits or is on its way is shown, and held at the ends of the range, from the value that edit will write, because that is
  what it is written on. The read-back then decides as for any edit; a note that is no
  longer there is named, with a sentence that its change was not written. Each answer belongs to its own note: when
  the selection has moved on, the sentence names that note ("c3 on t1: ...") and leaves the selected note's panel and
  "Ask Claude" alone. An answer that does not come within ten seconds is said to be late, with a sentence to check the
  code. The page may still be running that edit, so the next one waits for its answer up to ten seconds more and only
  then goes on; past that second wait it can be refused, because the late edit may have changed the code after all.
  When the page cannot write (a notice came on, a change is waiting for its line), when the Timeline closes or when
  its page turns, the steps and edits that wait are dropped and the panel says they were not written. The edit
  already handed to the page is not taken back: it is still written, even after the Timeline closed, its answer is
  told, and the next edit waits for it. Nothing new is handed over while the Timeline is closed. A late answer that
  says the change waits for its line keeps the edits made after it. They go when that wait ends, whether the change took over
  or not, aimed at the code that plays then. When the late answer came after the second wait, the queue has already gone on: the
  edits that still wait go while the change waits, and the page refuses them because a change is waiting for its line. The edits of the notes beside a rest are the
  exception told above: when the rest does not take over, they are dropped. While stopped, an edit rewrites and evaluates the code without
  starting the sound. When a change is waiting for its bar line, the editor has text that is not playing, or the
  socket is closed, the edit controls are off with one sentence saying why.
- **Prepared requests are never sent for the user.** A drag, a key or a button on a note the page cannot edit moves
  nothing and writes nothing; it opens the Ask box with a ready-made request ("Raise note c3 at cycle 4, beat 1 of 't1' by 2 semitones.") and the
  note's moment, and only the user's Enter sends it: a fresh press, so a held key that opened the box sends nothing.
  A draft already in the field is kept. The `ask` message carries
  the change in a `gesture` field, bounded and closed to four kinds, so Claude reads the intent instead of parsing text.
- **A range is one lane, whole cycles, inside the page shown.** Dragging across an empty part of one lane, or sideways from
  a note, or Shift with Left or Right from a note, selects whole cycles of that lane, never more than the 32 cycles on
  the page; a pointer that leaves the lane is held at the first or last cycle and the box says it was cut. The request
  names the lane, the cycles, every section the range crosses in playing order (a section that comes back after another
  is named again; a list too long for 200 characters ends with how many more) and at most 32 of the lane's notes in them,
  with a count of the rest; it is cut from the end until the whole line is at most 8192 bytes, as the right-click moment
  is. The note panel and the Ask box chip name the same list. A range on a lane with no notes is valid.
- **The numbers of the hand.** A press that moves less than a quarter of a rem is a click. A note is hit within half a
  rem in both directions, the nearest wins and equal distances go to the lower pitch. A drag changes the pitch by one
  semitone for each half rem of travel, up is higher, and the dominant axis decides: up or down on a note is a pitch drag,
  sideways is a range, and on empty area any direction is a range. All sizes are in rem, so they grow with the window.
- **The keyboard does all of it.** The lanes are one Tab stop that selects nothing. Left and Right walk the notes of a
  lane (by start, then pitch, stopping at the first and last note of the page), Home and End go to its ends, and Page
  Up and Page Down change lane keeping the cycle; a lane with no notes on the page gets a cursor, and the panel then
  offers only "Ask Claude". Up, Down, Delete and Backspace change a note only when one is selected. Escape steps back one
  thing at a time: the Ask box, steps not yet written, a range, the selection, and only with nothing left does it close
  the view. The note in focus is told to screen readers through one element the lanes point at, and the sentence slot is
  the Timeline's only live region.
- **Left out on purpose.** Notes in degrees, adding or lengthening a note, and a range over more than one lane stay
  requests for Claude. Claude's reference was not changed to steer how notes are written (for example toward
  double-quoted notes the Timeline can edit): that would tint every piece toward one way of writing.
- **Known limits.** A page that turns while a note is selected clears the selection. The look and feel of the gestures, and
  how the edits sound, are judged by hand and by ear, not by a check.

## The Instruments view changes only what the user clicks

The Instruments view (key 6) shows each instrument of `instruments.json` as a card: its port with a
live plugged or unplugged dot, its channels, its controls, its catalog size and the tracks that use it
now. These choices are settled.

- **It changes only what the user clicks.** Each card has an On/Off switch (and an editor for port,
  channels and clock). The view modules still never send and never store: two
  callbacks in `page/main.js` own the only two sends, authenticated with the page token and sent only
  from the playing tab, and a card shows the server's state, never a guess. The static test and the
  `npm run probe:page` check were rewritten, not dropped, to allow exactly those controls and those
  message types; a person's clicks, scrolls and Tab still send nothing else, and nothing is stored.
  The one thing a card does besides is answer a right-click with an Ask chip, `Instrument <id>`,
  through the box every other view uses.
- **Why it was reopened.** The user plays only some of the instruments in the file and
  had to say so in words every session. The choice belongs on the page, where the instruments are
  listed, and in the server's truth, where Claude reads it. The view stayed read-only while it only
  reported; once it could change what plays, a card that says `On` for a sound that is not made
  would be a lie.
- **Off is a word and a shape, never a color.** A switched-off card says `Off` and `switched off`,
  has a dashed outline and a crossed dot, and keeps every row and its place in the grid. The card
  shows the server's state: a press shows `Turning off…` and the old state until the server's new rig
  arrives, and a refusal or a silence of 5 s ends with a plain line saying why.
- **What still holds.** The view keeps no storage entry, never asks for MIDI access and builds no
  markup from text. A tab that is not the playing one shows a message instead of switches.
- **One exception: the Drum map line.** A card of an instrument with a rhythm channel shows a Drum
  kit row and a Drum map line. When the map is known, the line is a native `details` element that only
  expands the list of notes. It sends nothing, stores nothing and changes no setting. Its open state
  lives in memory, by instrument and map, so a redraw keeps it. The static test allows `details`,
  `summary` and a list as the only new tags, and still forbids listeners, sends, storage and markup
  from text. An unknown map is a plain line with no `details`.
- **The data folder reaches only the authenticated page.** With no `instruments.json` the view says
  where to create it. The page sends `data-folder-request` once per connection, after `page-auth`, and
  the server answers `data-folder` only to a connection that presented the page token, with the whole
  path or `null` (never cut). A request and an answer, not a field of `hello`, so the connect sequence
  stays as it was and nothing else on the machine learns the path (it can hold the OS user name). The
  path is shown with `textContent`, never logged, and never written to the repo. This replaced the
  first interface contract, which showed no path.
- **It never asks for MIDI.** Opening a view must not raise the browser's permission prompt: the page
  asks only when a track plays a MIDI instrument. So a port reads `not checked` until MIDI is allowed,
  and the view says in one line that port states show once it is. Safari is told at once, from whether
  the browser has Web MIDI at all, without waiting for MIDI code. A change from `not checked` to a read
  state is not announced to a screen reader; a plug and an unplug are.
- **A hand edit shows after a reload; a change made here shows at once.** The server reads
  `instruments.json` when the page attaches and before Claude's changes, not live, so the footer says
  that edits made by hand show after a reload and that changes made in the page show at once. A footer
  that said nothing would let someone edit the file and trust a stale card.
- **In use comes from the playing code.** The tracks on a card are read from the code that plays, with
  the same reading as the Mixer and Timeline tags (`readMidiTracks` and `readMidiCalls`), not from the
  popover's own bookkeeping, so the card, the tag and the top-bar indicator agree on what uses an
  instrument.
- **Problems keep their own words.** A build mismatch says `Restart Claude: different builds`, as the
  top bar does (other places word the same mismatch for their own reader, see
  "Claude is told the real reason"), and never that the file is invalid; a setup the page cannot read says so and never
  blames the file; an invalid file lists up to 20 problems as `field · reason` and the count of the
  rest. A tab that lost the playing role shows a message instead of cards, and a page that is still
  connecting says `Connecting…`, never a no-file sentence.

## The top bar and the Session drawer

The top bar redesign rebuilt the bar so the music reads at a glance and the rest stays out of the way. The look
was picked from sketches before the build. These choices are settled.

- **The bar holds the music and the controls.** The wordmark, the Play or Stop button with the state word,
  the tempo, the cycle and beat, the countdown and status of a waiting change, the Views and Layout
  buttons and the Session button. Everything that is quiet moved into the Session drawer.
- **The drawer is an overlay.** It opens over the workspace and pushes nothing, so the music's view does
  not jump. It holds cards for Session (Connected is plain text, with the Ask hint), Page requests, MIDI,
  Settings (how hand edits take over, Motion) and Last change, which holds the version number.
- **The Session button counts what needs the user.** Disconnected or refused, a build mismatch (or, softer,
  the updated-server line), a tab that lost the role and MIDI that wants attention. It never counts the
  failed-change banner, which has its own place. A count of zero draws nothing.
- **A strip repeats the three lines that must not hide.** While the drawer is closed, one muted line under
  the bar repeats the build line, the updated line and the lost-tab line, with Play in this tab. A count
  alone would let a restart request go unseen.
- **Why.** The user picked this look from sketches before the build, so the state of the music reads at a
  glance and the page stays calm. The accent color means one thing: live now.

## Play is a hand evaluation and the bar has two states

- **Two honest states.** The state word says `Playing` or `Stopped`, and the button says the action: Stop
  while playing, Play while stopped. There is no pause (the scheduler keeps no position to resume
  from) and no Space shortcut (Space is a typing key in the editor).
- **Play is the hand evaluation of the editor.** A press resumes the audio inside the click (a browser
  allows it only there), then takes the same path as Ctrl+Enter. The server clears its stopped flag and
  records the code once, so Play and Ctrl+Enter make the same version. Play in a tab that lost the role is
  disabled and says why.
- **Stop is neutral, not red.** Red appears only on the failed-change banner, so red always means a
  failure. The accent color shows only on the live state: a dot, the word and a heavier weight, and a ring
  with a plainer word when stopped, so color is never the only signal.

## A failed change shows a banner whose sentence is true

- **A banner under the bar, not a red line in it.** It says `Change failed.` for a failed evaluation (or
  `Problem.` for a notice: a Mixer, Ask or refusal problem), then one sentence about the music, then the error's first line cut
  with an ellipsis. Details shows the whole text, Copy writes it, Ask Claude asks about it and Dismiss hides it.
- **The sentence must be true, so it follows a fixed order.** Never evaluated: `Nothing is playing yet.`
  Stopped: `Sound is still stopped.` Playing: `The previous music keeps playing.` Any other state (sound
  blocked, another tab) gets no sentence at all. A notice never has one. A wrong sentence is worse than
  none.
- **Details draws 4000 characters at most.** Longer text is cut with an ellipsis in the box; Copy always
  writes all of it. Copy only writes, never reads the clipboard, and a clipboard refusal is shown loudly.
- **The text is only text.** It is set with `textContent`, so markup in an error message stays text.
- **A right-click opens three plain buttons** (copy, ask, dismiss), reachable by keyboard.

## Asking Claude about an error adds one context kind

- **One new kind, `error`.** A page request's context kinds are one closed list on the page and the
  server. `error` carries a `text` of 1 to 200 characters, the first line of the error. One kind is enough
  for every error, since Claude reads the words.
- **The Ask field is prefilled.** Ask Claude on the banner opens the box with the error text in it, cut at
  1500 characters, so the user can add a sentence or send it as it is.

## A page request shows what happens to it

- **A change is linked to a request only through the id Claude passes.** `set_code`, `edit_code` and
  `restore_version` take an optional `answering` field with the request id. The page never guesses a link
  from timing: a change that happens to follow a request says nothing about it, so a request shows as
  applied only when it really was.
- **An id that is not open never fails the music change.** A wrong or closed `answering` id changes no
  request, the change goes ahead, and the reply says so once. `answer_request` refuses such an id loudly
  instead, because it changes no music and a silent success would hide the mistake.
- **Silence is never shown as failure.** A request without news for 30 seconds reads No change yet and keeps
  counting. Claude may still be working, or may have missed it; the page cannot tell, so it does not guess.
- **Started is an observation, and says its basis.** Claude has started on it means Claude made a Moontide
  call after the request arrived. The basis is in the row's tooltip and in its detail, so the user can judge
  how much it means.
- **A timed change that is replaced or canceled says so.** A change that waits for its bar or phrase and is
  replaced by a newer change, or canceled by Stop, ends as Replaced by a newer change or Canceled. It never
  stays on Waiting for its line.
- **The board lives in memory and is bounded.** The server keeps at most 50 requests, with the start of the
  text (200 characters) so a reloaded page can show what it asked. The text never reaches the disk or the
  History view, and everything is gone when the server stops. The bound drops the oldest finished request
  first; an open one goes only when all 50 are still open, so a request the user still waits on stays
  closable.
- **Statuses go only to the page that sent the request.** A second tab never sees the requests of the first.
  A reloaded page takes over the requests whose page has gone, so a reload keeps the list.
- **The closing sentence is short.** `answer_request` takes answered or declined and one sentence of at most
  200 characters, shown under the request. A longer or empty sentence is refused, never trimmed.
- **The duty to pass the id is told where Claude needs it.** It lives in the description of the `answering`
  field and in the facts Claude reads with each request, not in the server instructions, whose 2048
  characters are kept for the framing every session needs.
- **The page shows only the states that were measured to hold.** Before this shipped, fresh Claude sessions
  were given one plain request each from the real page, with no hint of ids or tools. In all 5 sessions whose
  request changed the music, Claude named the request with its change, and in all 5 sessions whose request
  needed only an answer, Claude closed it with `answer_request` on the right id, answered or declined as
  expected. The bar was 4 of 5 for each kind. No session named another id or linked a change to a request
  that needed none. A state that was not measured to hold would not be shown: the row would stay on its last
  honest state.

## The border between the editor and the view

- **The border is draggable and works from the keyboard.** The value is the view's share of the main axis,
  15 to 85 percent. Layouts a and b have a border; layout c has none.
- **The defaults changed from 38 and 40 percent to 42 and 45 percent** (layout a and layout b). A
  double-click on the border brings the size back to them.
- **The size is kept per layout** under two storage keys. A stored value that is not plain digits inside
  the range is refused, logged once and ignored. A double-click resets it.
- **CodeMirror reflows by itself.** Its own observer follows the editor's size, so the separator code never
  calls a manual measure. A click that does not move the border stores nothing.
- **A readout helps while dragging.** It shows the size while dragging, while the border has keyboard
  focus and for a moment after a step. Screen readers hear the separator's name, value and keys.

## Fit gives up text in a fixed order, and the 24 px rule is 1.75rem

- **Four steps, always in the same order.** When the bar overflows, the page gives up: 1 decoration (the wordmark and
  the cycle and beat), 2 the names of the unselected view buttons, 3 long texts to short forms, 4 tighter
  spacing. The loop restarts from zero on every run, so the result depends only on the widths, and an
  observer on the bar and on every direct child re-runs it. A step is kept as long as the bar no longer overflows
  (no margin is added). The worst case (every longest string at once) must fit at every width with no exemption.
- **Every control is at least 24 px.** The root font is exactly 15 px from 1024 to 1923 px wide, so the
  rule is `1.75rem` (26.25 px). `1.5rem` would be 22.5 px, under the floor.

## The harmony is declared in one constant that plays nothing

- **One top-level `const harmony`, on one line at the top of the code.** The page reads it from the code
  text. It plays nothing and is never a track, a strip, a lane or a part. This was proven in real Chrome
  and offline (the harmony checks of `npm run probe:page` and `test/tracks.test.js`).
- **Not a labeled statement.** The page's track splitter turns every top-level labeled expression into a
  track, and Strudel plays it.
- **Not a comment.** Nothing reads a comment, so it can lie. A constant can be read by the patterns of the
  piece, so the declaration can be the real harmony.
- **One default harmony for the piece, and optionally one per section.** The constant is the piece's
  default. A song declares a harmony of its own as the third entry of a section (see "Every new piece
  declares a song structure"). The Jam view still shows the piece's default only.
- **Accepted values:** a scale string, a chord pattern written as text, or a chord call with one string.
  The page reads only written text. Anything else (a number, an array, a computed value) shows as not
  readable, with one of seven reasons.
- **Strudel refuses a program whose last statement is a const**, with its own message, and the previous
  music keeps playing. The reference says the line goes above the patterns. The page does not rewrite the
  code.
- **Claude's reference states the form as a fact** in the theory topic (see "Facts, not taste"). The
  server instructions did not change.

## Jam shows the declared and the heard harmony as two lines

- **Two separate lines, Declared and Heard, with no verdict.** No mark of agreement or difference, no
  accent, no red or amber. The user sees both and decides.
- **Without a declaration, Jam is unchanged.**
- **With one, the words "No clear scale" are gone.** The tie and no-fit sentences and the piano and
  fretboard names say it another way. This holds also when the declaration cannot be read, because an
  intention exists.
- **A declaration with no pitched notes keeps the body**, so the Declared line stays.
- **A single token naming one of the nine scales shows under the page's own name.** Anything else shows as
  written.
- **The declared scale does not drive the piano, the avoid marks or the warnings.** That would blur what
  is heard with what is meant. The one exception: it breaks a tie among the scales that fit the notes
  (see "Jam proposes a scale when several fit"). The declaration is read once per version, with the
  reading.
- **Left for later:** asking Claude about the Declared line, and telling Claude in the `set_code` reply
  when the declaration cannot be read.

## Jam proposes a scale when several fit

- **Same notes or different notes.** Scales that share their notes (C major and A minor) agree on which
  notes are outside, but not on the root mark, the avoid notes or the spelling, which depend on the root.
  So Jam uses one, says why, and lets the user switch. Scales with different notes (A minor and A Dorian)
  change which notes are outside, so Jam does not guess between them.
- **The order of the choice.** First the user's pick for this same set of candidates. Then the declared
  scale of the section that plays (or of the piece without sections), matched on root and mode, when it is
  among the candidates. Then the proposal kept from the evidence for the same set, so two near-equal
  readings do not make the choice jump. Last, the strongest evidence in the notes (bass and chord roots
  first, then the weight of the notes).
- **The reason is always a sentence, never the word alone.** "Proposed: C major, C is the note heard
  most." Five reasons exist: declared by the section, declared by the code, the bass and chords lean on
  the root, the root is the note heard most, and nothing in the notes says which scale is the key.
- **Cannot choose.** Different notes and nothing usable declared: warnings are off, one sentence says
  why, the scales are named in a plain list and no control is shown. A declaration that names none of
  the candidates reads the same.
- **The pick.** One click or Enter on a scale of the list switches the whole view in the same turn. It
  holds while the same set of candidates comes back, across sections and pieces, and wins over the
  declared scale. It lives in page memory only: 32 sets at most, forgotten on reload, no browser storage.
- **Warnings of every candidate are computed with the reading**, so a switch is a lookup, not a new
  reading.
- **The piano shares the guitar's roles and legend.** Every role has a shape or text cue besides its
  colour (fill and note text for scale, a ring and bold text for the root, a slash and struck-through text
  for avoid, a dashed border for outside, a corner square for a chord tone), and the piano and guitar
  names say the source of the scale, the scale notes, the root, what to avoid, what is outside and the
  chord tones. Each piano key also has a hover title of its note and role.
- **Known limits.** Candidates are shown in evidence order, eight at most, then a count of the rest. The
  later parts of the reading window resolve with the declaration in effect where the music plays.

## MIDI drum tracks do not count as pitches in Jam

- **The rig's rhythm channel decides, not a note range.** A note from 36 to 42 on a melodic channel is a
  pitch.
- **The Jam reading leaves those tracks out** (`drumTrackIndexes` in `page/timeline.js`) and is rebuilt
  when the rig changes while Jam is open.
- **Known limit:** a track whose port cannot be read, or whose port is not in the rig, is not known as a
  drum track and keeps counting.
- **Sample drums were already ignored** (a sample has no note).
- **Checked with the fake MIDI device** (the "drums in Jam" checks of `npm run probe:midi`).

## The Parts view reads more shapes and says why for the rest

- **Shapes read now:** constant arithmetic in a length (`+ - * /`, unary signs, parentheses, constants
  resolved in source order); a spread of a top-level constant holding a list of pairs; a pair held in a
  top-level constant. A list or pair constant that the code changes (`push`, an index assignment) or
  uses before it is declared is not read as written; it gets a reason.
- **The rest gets a reason.** There are seventeen reason ids. Each quotes the cause, cut at 40 characters.
  Nothing in them recommends a shape (see "Facts, not taste").
- **Known limitation, decided not to build:** an `arrange()` call followed by a call that changes how long
  it plays (for example `.slow()`) is read with the lengths as written, while Strudel plays it stretched.
  A guard with its own reason was weighed and left out. This stays a known wrong read.
- **Member patterns are not given section names.**
- **A song takes the place of the rows.** A piece that declares a song structure gets its sections and
  tracks in the Parts view instead of the `arrange()` rows (a list at first, the Song grid since; see
  "The Song grid launches sections, edits cells and says whether notes fit"). A piece that uses
  `arrange()` is read and shown as before, and so is a piece with neither.

## Every new piece declares a song structure

- **The form.** One top-level `const song` holds a shift, the sections with their lengths in cycles, a
  plan that gives every track a cell in every section, and optional groups. A cell is the name of one of
  the track's variations, or `'-'` for a rest. Groups are data and change nothing in what plays. Three
  helper statements (`total`, `clock`, `play`) are written as they are and turn the declaration into one
  shared section clock and one lookup per track. Each track has one `const` holding only its variations;
  its statement is `name: play('name', name)`, so the label, the play name and the constant agree. The
  page reads the text of the code and evaluates nothing to read it, and the same code plays in plain
  Strudel.
- **Harmony.** The piece's own `const harmony` is the default; a section can carry its own as a third
  entry. A variation in degrees is a function of its section's harmony; a fixed variation carries the
  harmony it was written for.
- **One clock, restarted at each use.** The shared clock picks each track's variation for the section it
  names and starts it at its first cycle every time the section comes round, also when a name returns. A
  note held across a section line is cut at the line and not struck again. This keeps a section sounding
  the same each time, whatever came before it. It was measured in real Chrome before it was chosen.
- **One standing rule, and the rest in the places Claude looks.** The server instructions say in one
  sentence that every new piece declares its structure once at the top. The form lives in a reference
  topic named `structure`, which states facts and shapes only: placeholder names, three shapes that
  differ, no section role, no style and no advice. `get_code` shows the topic's first block as a
  template whenever nothing plays yet, before the start included, because the first `get_code` of a
  fresh session comes before the start.
- **The new-piece reply line.** A `set_code` that plays a new piece without a top-level `const song`
  carries one plain line saying so. The call never fails because of it and the music plays as written.
  A piece is new when the code before it is empty, has no line of 8 or more characters, or keeps fewer
  than half of those lines. This is a text match; the server never parses the code. `edit_code` and
  `restore_version` never carry the line, and an older piece is not restructured: a small request is made
  in place.
- **What the page says.** A structure the page cannot read gets one sentence naming the cause, in the
  Parts view, and the same sentence reaches Claude with its next tool reply, led by the fixed phrase
  "Song structure". There is no banner. When the helper differs from the written text, or is missing,
  the page says it cannot vouch for what the structure declares; it never rewrites the code.
- **Declared against played.** After a version plays, the page compares, for every unmuted track made by
  `play()`, the first cycle of each section entry with what the song declares: the number of onsets,
  where each whole begins and ends (a declared whole that runs past the end of its section counts as cut
  there), and every key the declaration holds. Extra keys on the played side and function values are
  ignored, and onsets pair one to one. The declared side is built by the page from the code's own
  constants and not through the code's `play()`, so a changed helper shows as a difference instead of
  hiding itself. A difference gives one line naming the first place in section order and then track
  order, and how many others there are. The check starts after the page has settled, yields to the page
  between tracks, stops at 2 seconds, and is dropped when a newer version takes over. A check that fails
  or runs out of time says so in a muted line; it is never silent. The answer reaches Claude with the
  next reply.
- **One copy of the helper.** The helper text lives in a page module. The probes and the topic are tied
  to it by a test and by a claim of `npm run check:reference`, so they cannot drift.
- **How it was tried.** The teaching was tried on headless Claude sessions, one per plain request with no
  style, tempo, instrument or part named, each against a scratch Moontide server of its own: a port the
  system picks, a temporary data folder and a headless browser with a fresh profile. Only the Moontide
  tools were allowed, no other server or setting was loaded, and each session was bounded by a cost cap,
  a turn cap and a time limit, run one after the other. The harness and its results stay in private notes.
  In that trial all six first pieces declared a structure the page reads, and a small request on an older
  piece changed only the asked line. The shapes differed in length and in number of sections, but the
  section names repeated from session to session; the topic names none, so they come from Claude. How
  the sections feel is judged by ear.
- **Editing the song from the page** came later, with the Song grid (see the section named above).

## The Song grid launches sections, edits cells and says whether notes fit

- **Where it lives.** For a piece that declares a readable song, the grid replaces the Parts list in the
  same view. The view keeps its key (4) and its id; only the name in the top bar reads Song instead of
  Parts. A piece without a song keeps the `arrange()` rows as they were, and a song the page cannot read
  keeps its one sentence and shows no grid.
- **A launch pins its line.** A click on a section header reads the scheduler's frontier once, works out
  the line from the launch point the toolbar holds (the end of the section that plays, the next phrase or
  the next bar), writes the shift that puts that section on that line, and pins the takeover to the very
  same line. All of it happens in one turn, so the frontier cannot move between the maths and the write.
  An evaluation can still take real time (samples, MIDI), and then the takeover may find a different
  line; the page recomputes once, and if the line still moves it cancels the launch and says so in a
  sentence. It never lets the shift and the line disagree.
- **A launch that needs no change.** When the section already starts on that line, nothing is written and
  nothing is evaluated: the header only shows its countdown, and a second click hides it.
- **Cancel and replace.** A second click on the queued header cancels the launch and puts the editor back
  to the code that plays; nothing is recorded. A click on another header replaces the queued one and is
  built on the waiting code. Typing in the editor that was never evaluated switches every control off with
  one sentence saying why; the grid never discards that text.
- **Play after Stop starts from the first section.** Play after a Stop writes shift 0 into the code before
  it evaluates, so a structured piece starts from its first section (the count restarts at 0 at every
  Play); that is one history entry, and none when the shift is already 0. Ctrl+Enter is left as it is: it
  evaluates the text as written, shift included. A header clicked while the sound is stopped starts the
  piece at that section at once.
- **A cell edit follows the user's hand-edit timing.** A cell opens a list of the track's variations and a
  rest. Choosing one replaces exactly one string of the plan and takes over by the timing the person set
  for their own edits (now, next bar or next phrase); until the line the cell shows what was chosen with
  the words that say it is not playing yet. It is one history entry, recorded through the same message the
  Mixer uses. A section name used twice shares one cell, so the change shows in every column of that name
  and the list says so. The page refuses with a sentence, and writes nothing, when another change waits,
  when the editor holds unevaluated typing, or when the cell changed since the click.
- **The fit check compares notes, never blocks.** For a fixed variation the page asks the code's own
  constants (through a query, the same way the declared-side check does, never through the code's `play()`)
  which pitch classes it plays in the first cycles of the section, and compares them with the section's
  scale over the nine scales the Jam view knows. A note within a quarter of a semitone of a pitch counts as
  that pitch; one farther off is left out. The grid says only `fits`, `does not fit (F#, A)` or `cannot
  check` with one reason, in the muted colour. Nothing is drawn while the answer is pending, a query that
  fails says `cannot check` and never `fits`, and the check changes no code, no music and no launch.
- **Jam follows the section.** The Jam view's Declared line shows the harmony of the section that plays
  (its own, else the piece's) and names the section; while stopped it shows the first section. A piece
  without sections shows the line as before.
- **Asking Claude from the grid.** A right-click on a section header gives a part context, on a track name
  a track context, on a cell a cell context (the section, the track, the variation or a rest, and the fit
  word the cell showed at that moment), and on a group row a group context (with the group it sits in).
  The most specific target wins, and the toolbar, the corner and empty space mean the whole session. The
  page's single right-click listener leaves a Shift press to the browser, so the Menu key and Shift+F10 on
  a focused control are handled by the grid and open the same box at the middle of the control.
- **A ready-made request only for a cell that does not fit.** Its text is put in the Ask field with the
  caret at the end and is never sent for the user: they read it, may change it and press Enter. A draft
  already in the field is kept and the request follows it after a blank line. A cell that fits, or that
  cannot be checked, adds nothing.
- **The old Parts launch is unchanged.** A launch from an `arrange()` row still replaces unevaluated
  typing, as it always did; only the grid keeps that text.

## The Mixer shows the song's groups

- **Frames follow the song.** For a piece that declares a readable song with groups, the Mixer draws one
  frame per group, at any depth, with the strips of its tracks inside, then the tracks no group names, then
  the bus strips. A piece with no song, an unreadable song or a song that names no group keeps the flat
  Mixer, every control working. The structure only places strips: for the same code, every strip is the same
  with and without it, so a song never makes the Mixer refuse a track it would otherwise handle. A MIDI
  track sits in its frame like any other, with its instrument tag, its channel and its controls.
- **Folding is shared with the Song grid.** A frame folds with its fold button (click, Enter or Space) and
  hides its strips; the strips keep their state in the code. The folded groups are one stored value in this
  browser, read by both views, so folding in one folds in the other. A fold writes no code and records no
  version, and it works even when the group's other buttons are off. An unreadable stored value is ignored
  and every group starts open. Arrow keys, Home and End do nothing on a group's buttons, as in the grid;
  Tab goes fold, M, S, then the strips of an open group.
- **A group's M and S are one change.** One click on M mutes every track below the group, sub-groups
  included, and the next click unmutes them; S does the same with the solo marker. It is one rewrite of the
  code, one evaluation and one history version, built from the same per-track rules as a strip's own
  buttons. If any track cannot be written, nothing is written and the usual failure line says why. A group
  with only some of its tracks muted or soloed shows a dashed button, a count line ("2 of 3 muted") and a
  hover sentence, and one click then mutes or solos all. A track the Mixer cannot change (an unlabeled
  track for solo, a label it does not own) is left as it is, kept out of the counts and named in a short
  note under the group; a group with no track it can change has its buttons off and says so.
- **No group fader.** Plain Strudel has no gain for a group of tracks, and MIDI output ignores a post-gain,
  so a group fader would be a lie for the tracks that matter most. The group has mute and solo only; levels
  stay on the strips.
- **A track written with `play()` no longer says it is built from shared code.** The helper the song
  structure puts in the code is the same for every track, so the line told the user nothing. A track built
  from any other constant still shows the line.
- **Asking Claude about a group.** A right-click on a group's head or frame opens the Ask box with a group
  context (with the group it sits in when it is nested); a right-click on a strip inside the frame still
  asks about that track. The right-click only reads: nothing is evaluated or recorded. There is no keyboard
  route to the box from a group yet.

## Mixer lights follow the moment a note is heard

- **A light is a blink tied to a note.** Every labeled track strip and every group head has a small light
  before its name. With motion on, the light goes to full in the first frame at or after the moment one of
  the track's notes is heard and falls to dark in a straight line over 180 ms; a note that comes while it
  fades starts it over. A group's light shows the brightest of the tracks below it, at any depth, folded or
  open. With motion off nothing blinks: a light stays lit while a note was heard within the last cycle. The
  lights run only while the Mixer is open, the tab is visible and sound is playing; Stop, a hidden tab,
  opening the Mixer and switching motion take every light to dark, and a muted track, or a track another
  track's solo silences, never lights.
- **When a note is heard.** A browser sound is due at a time on the audio clock; the page moves it to the
  page clock through the audio context's output timestamp, which already counts the output delay the browser
  knows about, and reads that timestamp once per animation frame. A MIDI note is heard at the timestamp its
  port got, the same one that leaves with the message. The note's track comes from a tag the page puts on
  every labeled statement, so the light needs no guess about which track played.
- **The skew that remains.** The lights are right to within a frame, not to the sample:
  - A browser that reports no output latency draws the light early by that latency. The page falls back to
    the context's own latencies when the timestamp is stale, and to nothing when they are not reported.
  - MIDI notes sit about 34 ms after the browser's target time (the decision above) and about 5 ms after
    the heard browser sound, so a MIDI light sits about 5 ms after a browser light for notes struck together.
  - The synth's own delay after the timestamp is not known to the page, so a slow instrument sounds a little
    after its light.
  - A light changes on whole frames: up to about 17 ms late at 60 Hz.
  - The two offsets (one for browser sounds, one for MIDI notes) start at 0 and the fade at 180 ms. They are
    named constants in `page/lights.js`, to be tuned by ear on real hardware.
- **Strips with no light.** A strip of a program with no label has a hidden light and says so in its note:
  no label means no way to know which track played a note. A bus strip is not a track and has none. A
  `.midi()` track in a browser without Web MIDI makes no sound, so its light stays dark.
- **Blinks without a sound.** Two cases blink a light for a note nobody hears: a `.midi()` note to a port
  that is not connected, and a `.midi()` track after the browser refused MIDI access. The light follows the
  note the page sent, not what the instrument did with it.
- **Tracks written with `$:`.** They have no name, so the page numbers them in code order, and the number
  restarts with each evaluation. While a change waits for the bar line, the new code is already numbered
  and the old code still plays, so for the notes heard right after such a change a `$` track's light may
  blink on the wrong `$` strip. Named tracks are not affected.
- **Cost.** The light state is plain data, with no document access. A frame writes only the lights whose
  brightness changed in one of 64 steps. With 40 tracks in 8 groups it costs well under 0.2 ms of
  JavaScript a frame, and 40 silent tracks playing 320 notes a second with the Mixer open drop no more frames
  than the same piece with the Mixer closed.

Pins: `npm run test` holds the light state with fake time, `npm run probe:page -- --only mixer` the
lights in the real Mixer against the heard moment and the cost at 40 tracks, and `npm run probe:midi --
--only mixer` a `.midi()` track's light against the timestamp its port got.

## Moontide starts on demand

- **Why:** Claude Code starts every configured MCP server with each session. A user-scope install would
  then open a tab in every session of every project.
- **What starts it:** the start command or tool, or the first `set_code` or `restore_version`, which is already
  the intent to play. Reading the reference, the instruments or the history does not start it. A request that
  cannot play fails before the start: an `edit_code` before any start, or a `restore_version` of an unknown id.
- **The wait:** a music request waits up to 30 s for the page that opens. After that it fails with a plain
  message and nothing is sent.
- **One behavior only:** there is no setting to start with the session again. `MOONTIDE_NO_BROWSER=1`
  still means start without a tab.
- **The label:** the folder name and the port tell tabs apart. It is local data, shown only in the page
  and in Claude's replies, never written to a file or a log.
- **Left out on purpose:** a command that lists every running server. The tab titles are enough; add one
  if the need comes back.
