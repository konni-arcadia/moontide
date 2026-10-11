# Architecture

Two components for the MVP.

## Browser page

A Strudel editor that plays audio, shows the code and highlights notes as they play.
It receives code from the server, evaluates it, and sends back success or the error.

The page also reads the code that actually played into tracks and parts, with pure
modules that parse it (`page/tracks.js`, `page/timeline.js`, `page/parts.js`,
`page/views.js`) and a pinned parser loaded with subresource integrity. From this it
shows a Timeline and a Parts view, in three switchable layouts. A part launched from
the Parts view rewrites the playing code and sends it to the server, which records it
as a version from the page, the same way it records a hand edit.

The page also shows a History view: one row per version, newest first, with what changed
in each, an inline diff and an optional branching tree. It is built from a pure module
(`page/history.js`: line diff, change summary, lanes, key decisions) and a DOM module
(`page/history-view.js`). A click on a row, or the Enter key on the selected one, asks
the server to bring that version back; the page never writes a version itself.

A right-click opens a small box to ask Claude about what was pointed at. The page reads its
page token once from the page it was served, authenticates on open with `page-auth`, sends
`ask`, and shows the answer states. The rules are in a pure module (`page/ask.js`) and the box
is a DOM module (`page/ask-view.js`). A right-click on the Timeline adds a moment read from the events
the Timeline already drew (`momentAt` in `page/timeline.js`), sent in its own `moment` field of `ask`
next to `context`; the ruler, the gaps and the part headers over the lanes use the first lane as the
one reference for the pointer.

The page also shows a Jam view for a person playing along. It reads the same query and cache
as the Timeline through a shared reading, and finds the scale and the chords from the notes
played in pure modules (`page/jam-analysis.js` for the reading, `page/jam-model.js` for the
copy and the geometry). A DOM module (`page/jam-view.js`) draws them: a piano, a fretboard, a
status line and a coming-up list. `page/harmony.js` reads the optional harmony declaration (one
top-level `const harmony`) from the code text without evaluating it. `buildReading` carries the
declaration, and `page/jam-model.js` shows it as its own field, a Declared line beside the heard
scale; the declared scale drives nothing else. The reading leaves out the tracks of the rig's rhythm
channels (`drumTrackIndexes` in `page/timeline.js`), and `applyRig` rebuilds it while Jam is open, only when the drum tracks changed.
The view is read-only: a right-click on a note or a warning
sends a `note` or `warning` context through the same box, and the view only says what was
pointed at while `page/main.js` keeps the one right-click listener.

The page plays a MIDI instrument through Strudel's own `.midi()`, and three modules keep
MIDI from failing silently. `page/midi-plan.js` is pure: it reads the `.midi(` calls of the
code with the pinned parser, applies Strudel's own port rule to the connected outputs, and
holds the indicator and banner copy. `page/midi-out.js` does the IO behind injected
dependencies: it turns Web MIDI on before the first evaluation that needs it (through one
wrapper on the repl's evaluate, so a hand edit, the Mixer, a part launch and Claude's code all
pass it), watches the ports, sends Stop's raw panic, and retires the webmidi outputs at Stop
(which also empties webmidi's list of disconnected outputs, so a replugged port always gets a new one).
`page/midi-view.js` draws the top-bar indicator with its popover, the return banner, and the
segment a tab shows after another tab took the active role.

The Instruments view (key 6) shows one card per instrument of `instruments.json`: its model, its
port with a live plugged or unplugged dot, its channels, its controls, its catalog size and the
tracks of the playing code that use it. It is a pure model (`page/instruments-model.js`, which
decides the sentence that replaces the cards, the notice above them and the rows of each card) and
a thin view (`page/instruments-view.js`, DOM methods only, text through `textContent`), wired by
`page/main.js`. The model reads one snapshot of its inputs: the `midi-rig` message the page keeps,
the live port reading of `page/midi-out.js`, the playing code (read for its tracks with the same
`readMidiTracks` and `readMidiCalls` the Mixer and Timeline tags use), the socket and tab-role
flags (`pageHelloSeen`, `pageRefused`, superseded, no active page), whether the browser has Web MIDI
and the data folder the server sent. While the view is open it redraws from the events that redraw
the MIDI card of the Session drawer (a port plugged or unplugged, a new rig, the tab role, the clock), plus
a new version, a waiting change and every socket state change; a model identical to the one on
screen writes nothing, and a plug change updates only the dot, the words and the In use lines of
its card, so focus and scroll stay where they are. Each card starts with a switch (a native button
with `role="switch"`, the words `On` and `Off`, and a thumb that sits right, left or in the middle).
The view modules still never send, store or enable Web MIDI: a press calls back into `page/main.js`
(`onInstrumentSwitch(id, enabled)`, the target state, never a toggle), and `page/main.js` sends an
`instrument-switch` message and waits up to 5 s (the take-back figure) for the matching
`instrument-result`. While it waits the switch says `Turning off…` and keeps its confirmed state; the
card changes only when the server's new rig arrives, so it never shows a guess. A refusal, a write
failure, 5 s of silence or a socket that closes ends the wait with one line under the card's header
(`Could not switch sc55 off: <reason>` or `Moontide did not confirm — try again.`); the reason is the
server's text, set as text. A switched-off card keeps every row, with a dashed outline, a crossed dot
and the words `switched off`. `Edit settings` on a card opens a small native form for the port (among the
outputs the browser lists now, read without enabling Web MIDI), the channels (one chip for each channel of
the model) and the clock; `Save` calls back into `page/main.js`, which sends one `instrument-settings` message
with the full chosen set. The page never validates it: the server's reasons come back in the answer and are
listed in the card (as text) while the draft stays. A change made elsewhere replaces only the card it
concerns and keeps the user's focus, scroll and open editor. Opening the view never raises the browser's permission prompt (a port
reads `not checked` until MIDI is allowed, and a browser without Web MIDI is told at once). A
right-click on a card sends an `instrument` context through the same box, and `page/main.js` keeps
the one right-click listener.

With an `instruments.json` the same layer knows the user's instruments. `page/midi-rig.js`
mirrors the `midi-rig` message by hand (the server's schema is the source), finds the instrument
of each port, and checks the code against it: a port, channel or sound the file does not know is a
refusal that lists the valid values. `page/midi-rig.js` takes up to 5,000 catalog sounds after a
model's own, and a catalog sound is chosen like any other. The evaluate wrapper is serialized, so two evaluations never
interleave their setup. A refusal is a real failed evaluation: the wrapper passes a throwing
expression to the original evaluate, so the previous music keeps playing and the page shows the
error like any other. Otherwise the wrapper sends the setup step (bank select and program change,
as a difference from what was last sent on that port and channel), waits a short guard, runs the
evaluation, and rolls the setup back when the evaluation fails. `page/midi-out.js` also resets each
instrument once per connection (page start with the port present, a port that comes back, Munt
started again) after a settle delay, never on Play, and reports what it did as `events` in
`midi-state`. One guard on the `send` of each webmidi output, which touches Strudel's path only,
carries two rules: a replugged rig instrument's notes are dropped until its setup has gone out twice,
the second time `RECONNECT_REPEAT_MS` after the first, and a channel whose sound just changed drops the
old code's notes until the new code takes over. In a browser without Web MIDI, `page/main.js` installs
`installNoMidiShim` (from `page/midi-out.js`), which turns `.midi()` into a silent trigger so the other
tracks still play.

Instrument controls and the end of a stopped track's notes come from two more pieces.
`page/midi-controls.js` reads each MIDI track (port, channel, instrument, the controls written in the
`.midi()` options, the sweeps), writes `controls` in the `.midi()` options for the Mixer, and tells what
stopped between two evaluations. `page/midi-out.js` sends the controls in the setup step against a
per-channel control shadow, previews a dragged control straight to the port, repairs the shadow after a
failed or abandoned gesture, and silences the channel of a stopped MIDI track (or ends its own notes on
a channel another track still plays), twice, the second time after the lookahead.

Notes leave the page ahead of their sound, with a timestamp. `page/midi-out.js` wraps `.midi()`
(`installNoteStamps`, installed by `page/main.js` where Web MIDI exists), maps each hap's target time
with the page clock's `stamp`, and lets Strudel's sends fire `NOTE_AHEAD_MS` early through per-call
Output proxies that tell the guard the timestamp; the guard rewrites the time option of the send, and
the note-offs follow with it. The page records the messages still ahead (note-ons by pitch, control
changes, pitch bend and SysEx by time), per native port id, so Stop, a mute and a sound change can end
them or wait for them: Chrome cannot take back a queued message. Where a control change is queued, Stop
and a mute add a timed sustain release (CC64 = 0) for that channel, and a hold the page writes there before
it lands goes out just after it. A tab that lost the active role sends none, so it cannot land after the
new tab's setup.

Moontide sends MIDI clock to the instruments that follow it. `page/midi-clock.js` is created by
`page/midi-out.js`, which gives it the ports the playing code names (the same reading as the indicator),
the native port lookup and the reconnect state. Every 10 ms it reads `editor.repl.scheduler` and the
AudioContext's output timestamp, and sends Start, ticks and Stop with timestamps through the native
port, never through webmidi, up to 150 ms ahead. The guard on Strudel's sends drops clock and transport
bytes and holds a joining clock instrument's note-ons until shortly before its Start (a note's own timestamp
is compared with the Start when it has one). Stop, page hide
and losing the playing role stop the clock. The popover row of a clock instrument reads its state
through `rigView()`.

Claude is told the real reason a change fails or cannot play, and the page checks each new pattern before
it takes over. The `setPattern` wrapper of `page/query-check.js` (`installQueryCheck`, `queryFailure`) test-queries
every new pattern over the next cycle with `Pattern.query`, never `queryArc`. A failure is a failed evaluation
(`QUERY_REFUSAL_LEAD` starts its text), so the old music and its tempo keep playing. Every caller passes through
it: Claude's changes, Ctrl+Enter, the Mixer, a part launch and the replay after `hello`. The `State` and `TimeSpan`
constructors are captured (`captureQueryTypes`), so user code cannot replace them. The pattern that takes over is
wrapped by `createSchedulerQueryScope`: only the scheduler's own queries report a later query error, and the page
forwards it once per change (the `queryErrors` guard resets when a pattern takes over, never for a refused one).
The Timeline, the Drawer and Stop's sweep also query patterns and never speak for playback. The page shows the
`build-mismatch` line and the softer `server-updated` line in the Session drawer (the strip under the bar repeats them while the drawer is closed), and it
marks the MIDI setup it holds when it knows the builds differ (`withBuildMismatch` in `page/midi-rig.js`), so
the refusal, the MIDI indicator and popover, the Mixer reason and the Instruments view say "different builds" and
never that `instruments.json` is invalid. The Parts view (`page/parts.js`) reads section lengths
written as constant arithmetic, a spread of a constant list of pairs and a pair held in a constant. For an
`arrange()` it cannot read, it names the call and the reason (`PARTS_COPY`)
and still shows the calls it can read.

A change can take over on a bar or phrase line instead of at once. `page/change-timing.js` is pure:
a bar is one cycle (4 beats), a phrase is 4 cycles unless the change asks for 2 to 64, and the line is the
first multiple of that length strictly after the scheduler's frontier (`lastEnd`), moved one line further
when it leaves less than half a second at the current tempo. The scheduler's cycle count restarts at 0 at
every Play, so a phrase is counted from Play and nothing is stored. `page/takeover.js` holds the rest. The
seam is the `setPattern` wrapper of `page/query-check.js`: a change that waits is evaluated and checked at
once (an evaluation error, the query check or a MIDI rig refusal fails it there, and the old music keeps
playing), and then the wrapper hands the scheduler a gate instead of the new pattern. The gate is the old
pattern for every query before the line and the new one from it, a span that crosses the line is split,
so the takeover lands on the line whatever the scheduler's slice grid is, with no timer. Its hooks (one a
little before the line, one on the first query past it) never throw into the scheduler: they only queue a
microtask. The waiting change is one record at most: a newer change replaces it (last wins), a History
restore or an immediate change replaces it, and Stop cancels it and leaves the new text in the editor, so
it plays on the next Play like any edited code.

Everything that says what plays now follows the line, not the request. A finisher list on the record
runs once when the line is audible: the Mixer and Parts stop saying "waiting", the MIDI facts of the new
code are committed, the version indicator and the views follow, the hand-evaluation report is sent, and
the page sends `takeover` for the server's history entry. A tempo written in the waiting code is taken
back right after the evaluation (`page/tempo-guard.js` holds it) and applied in the microtask after the
gate's first query past the line, so the downbeat is exact and the old bars keep their tempo. The MIDI
setup of the waiting code (bank select, program change, controls, the clock Start of a new clock
instrument) is checked at the request, prepared again at the lead and sent stamped on the line
(`prepareSetup` with `atCycle`, `stampOfCycle` on the page clock); a cancel before it went out drops it,
and a cancel after it went out (stamped bytes cannot be recalled) sends the playing code's sounds and
controls back stamped just after them; a rig that changed meanwhile skips it and reports through the MIDI
facts. While a change waits, the Timeline and
Jam views, the Mixer and Parts read the playing code (`playingCode()` in `page/main.js`), not the
editor's text, so a view never shows a change that has not taken over; the Mixer and Parts refuse a
move or a launch with a neutral notice until the line, because acting on the committed code would
promote the waiting change by accident. The Mixer's selected-strip light, like its change flash, is an overlay
in the editor's scroll container (`syncMixerLit` in `page/main.js`), positioned from the editor's own text
and shown only while that text equals the playing code. A hand evaluation (Ctrl+Enter) takes its timing from a stored page
setting (`moontide.changeTiming`: now, bar or phrase, default now); the timing of every other caller is
bound at the `editor.repl.evaluate` wrapper, so Claude's timing and the hand setting never cross.

The top bar shows it. The bar holds the wordmark, the Play or Stop button with the state word (`Playing` or
`Stopped`), the tempo, the cycle and beat, the countdown and status of a waiting change, the Views and Layout
buttons and the Session button. `page/bar-model.js` is the pure model (the Session count and its rule, the
strip line, the transport, the tempo text and the banner sentences, with the words in `BAR_COPY`);
`page/top-bar-view.js` draws the transport, the tempo, the countdown, the status line and the fit step;
`page/change-timing.js` (`CHANGE_COPY`) keeps the timing words and numbers. All of them take facts and draw
with DOM methods and `textContent`; `page/main.js` owns every send. The always-on 250 ms page poll in
`page/main.js` draws the tempo (the scheduler's cps times 60 times 4, one decimal; the cps keeps its old value
until a waiting change's line) and the countdown (the distance to the waiting line in beats, counted from the
scheduler's cycle position, so a throttled hidden tab shows the right number on return), and the view writes a
text only when it changed. The tempo is always there: a dash while this tab does not play. Play is a hand
evaluation (the audio resumes in the click, then the Ctrl+Enter path), and Stop is neutral.

The Session drawer is an overlay opened by the Session button (`page/session-view.js`). Its cards hold the
connection, the page requests, MIDI, the settings and the last change (with its version number). The button
counts what needs the user: a lost connection, a build mismatch or the updated-server line, a tab that lost
the role and MIDI that wants attention; the failed-change banner never counts. While the drawer is closed a
strip under the bar repeats the build, updated and lost-tab lines. The stored hand setting is three buttons
(`now`, `next bar`, `next phrase`) in the Settings card, built from `timingOptions()`; a press goes through
`setChangeTiming`. A hidden live region says "Change waiting" once for a whole wait, "Change canceled." after
Stop, and what the setting now means after a press; a takeover clears it silently.

A failed change shows the banner under the bar (`page/problem-view.js`). Its sentence about the music is
chosen by `bannerCopy` in a fixed order and left out when none is true. Details shows up to 4000 characters,
Copy writes the whole text and fails loudly, Ask Claude sends the `error` context kind, and a right-click
opens three plain buttons. Red appears only there.

The border between the editor and the view is a separator in layouts a and b. `page/split-model.js` is pure
(limits 15 to 85, defaults 42 and 45, key steps, pointer geometry, the stored-size parse) and
`page/split-view.js` handles the pointer, keys, double-click and ARIA values with callbacks only. `page/main.js`
applies the size as the CSS variable `--view-size`, stores it per layout and never calls a manual measure:
CodeMirror reflows by itself.

When the bar overflows (its `scrollWidth` above its `clientWidth`) the fit step gives text up in a fixed
order: 1 the wordmark and the cycle and beat, 2 the names of the unselected view buttons, 3 long texts to
their short forms (the request status, the countdown's first word, the tempo's unit, the word "Layout"), 4
tighter spacing. It restarts from step 0 on every run, so the result is a function of the widths, and a
`ResizeObserver` watches the bar and every direct child; the stylesheet has no at-rule, so the steps are
attribute selectors on `#top-bar[data-fit]`. The views and the layout are real buttons (the keys `a b c` and
`1` to `6` and Esc still work), and every control is at least 1.75rem (24 px or more).

## Node server

Moontide starts on demand. The MCP process connects at once and starts nothing: no web server, no port, no tab.
`src/start.ts` starts the web server and opens the page once, on the `start` tool or prompt, or on the first
`set_code` or `restore_version`. A music request waits up to 30 s for the page that opens, then fails with a
plain message and sends nothing. A request that cannot work fails first and starts nothing: an `edit_code`
before any start (nothing plays yet), or a `restore_version` of an id that is not in the history. A second
start opens a tab only when no page is connected.
`src/session-label.ts` builds the label from the name of the folder the process runs in and the port the
server is bound to. The server writes the label, escaped, into the served page's meta tag and title, and
`page/session-identity.js` reads it once for the tab title and the first row of the Session card. The start
reply and `get_code` give the same page line (address, port and tab title). `MOONTIDE_NO_BROWSER=1` starts
without opening a tab; tests and probes use it.

The server holds the current code and exposes the MCP tools to Claude. It serves the page, pushes
code to it over a WebSocket, and waits for the evaluation result. It also keeps every
version that played in a history file in the user's data folder, which Claude can list
and restore through MCP tools. It answers the page's history requests: the newest 100
versions first, then older ones by an id cursor (`history-request`, `history`,
`history-more`, `history-older`, `history-older-error`, `history-error`). It pushes each new version, each
favorite and each compaction of the file to the pages that asked (`history-add`,
`history-favorite`, or a fresh `history`), and a page's request to bring a version back
arrives as `history-restore`. Every version carries the version that was playing when it
was made; the server resolves that parent in one place before sending it. It also serves a factual reference of the pinned Strudel
version — static files in `reference/`, checked against the pinned bundle with
`npm run check:reference` — through the `get_strudel_reference` tool and as MCP resources.

A change that waits for a line is told in two messages. `set_code` takes `at` ('now', 'bar' or 'phrase',
default 'now') and `phraseCycles` (2 to 64, only with 'phrase'); they travel in the `evaluate` message.
The page answers `evaluated` at once with `pending` (the cycle it takes over on and about how many
seconds away that is) and `bpm`, and the server's reply says when the change takes over and states the
tempo in one line when it changed. The version, `get_code` and the history entry follow the later
`takeover` message, sent when the line is audible, and until then `get_code` returns the playing code
with one line saying a change waits. `takeover-canceled` (reason `stop` or `replaced`) tells the server a
change whose `pending` reply went out will never take over; a closing or superseded page sends nothing
and the server drops the waiting change itself when the page detaches. The server keeps one waiting
change, queues one notice for a change that was canceled, replaced or lost with its page, and drains it
once into the next tool reply, like its other notices.

`edit_code` changes part of the code without Claude sending the whole program. `src/edit-code.ts` applies its
edits (`old_string`, `new_string`, `replace_all`) with `indexOf` and `slice`, never a pattern replacement, to
the newest code that will play: the waiting change's code when one waits, else the confirmed code, which holds
the user's evaluated hand edits. The server then sends the whole composed program in the same `evaluate`
message as `set_code`, so the page, the test query, the timing, the history entry and the notices are the same
and the page needs no change. A refusal (no match, several matches, overlap, no change, a stale `base`) is
answered before anything reaches the page. The reply shows the changed lines with a few lines around them,
and `get_code` adds a version line for programs of 8 lines or more.

The page-to-Claude channel lives in `src/ask.ts`. The page sends `page-auth` and gets
`ask-auth`; it sends `ask` and gets `ask-result` (received, waiting or refused), and later
`ask-received` when a waiting request was handed over. `page-auth` also gates the whole page
connection: a page becomes the active page and gets `hello` only after it authenticates (the
last page to authenticate wins), and the server ignores and logs every other message from a
connection that has not. The `/listen` endpoint on the same
127.0.0.1 server takes one listener at a time: it must hold the listener token and send no
Origin header. `dist/listen.js` prints one line per request (it carries `moment` when the page sent one) and acknowledges each one it
wrote. Waiting requests and the line that gives Claude the listener command ride the tool
replies. Authenticated pages also get `page-requests` (one boolean: is a listener connected)
right after `ask-auth` and each time a listener connects or goes, and the Page requests card of the Session drawer shows it.
Two MCP prompts, `page-requests-on` and `page-requests-off`, and one tool, `set_page_requests`
(for clients that offer no MCP prompts, such as the Code tab of the Claude desktop app), give
Claude the command or tell it to stop, and switch whether tool replies carry that command; the
prompts and the tool share one function in `src/mcp.ts`.

MIDI facts travel the same way as runtime errors: the page sends facts, the server words them.
The page sends `midi-state` (access, connected outputs, the ports the code names, hidden or
not, playing or not) before `evaluated`, and `src/midi-state.ts` (`MidiChannel`, owned by the
session like `AskChannel`) words each change once into the next tool replies. Strudel's own
per-hap MIDI log lines are never forwarded. When a second tab becomes the active page, the
server sends `superseded` to the page that lost the role; that page stops its sound, sends the
MIDI panic, refuses every evaluation, and takes the role back with `take-over`, which the server
answers with the usual `hello` replay. When the active page goes away and no other page takes the
role, the server sends `no-active-page` to the superseded pages so they say "No tab is playing"
instead of "playing in another tab" (the button still works); a page that becomes active after that
sends them `superseded` again.

The server also tells the truth about its own build. `src/build-id.ts` fingerprints the bytes of the page folder
and of the compiled server folder separately when the server starts (`BuildWatch`), and the Session asks again at
each page connection. A changed page folder sends `build-mismatch`. A change in the compiled code alone sends
`server-updated`. Both go out before `midi-rig` and `hello`, on the same socket. Claude gets
`BUILD_MISMATCH_NOTE` or `BUILD_UPDATED_NOTE` (`src/session.ts`) once each time the state changes, drained into the
next tool reply like the other notices. The `set_code` and `restore_version` replies add `FLAG_STRING_NOTE` through
`whenFlagLines` (`src/mcp.ts`) when the code gives `.when()`, `.struct()` or `.mask()` a string of only `t` and `f`,
written out or held in a top-level const. This is a text match: the server never parses the code, and changes it only by the exact replacements Claude sends with `edit_code`. The
functions topic of the reference states the `t` and `f` facts, and `npm run check:reference` pins them.

The instruments live on the server in `src/instruments.ts`. It reads `instruments.json` from the
data folder at every use (never throwing: a problem is a state, with each field and reason), and
the models: the shipped ones in `instruments/` (read-only package data) and the user's in `models/`
of the data folder. It builds the reset bytes, so the page never needs the checksum, and words the
facts Claude reads. `Session.syncRig` pushes `midi-rig` to the active page before `hello` and
again before each evaluation, only when the state changed, so a fixed file applies on the next
change without a restart. `src/midi-state.ts` words the page's reset events once, like the other
MIDI facts, and `Session` words the state of the file once per change (invalid, valid again,
removed). Two tools reach it: `get_midi_instruments` lists the instruments, or one instrument's
sounds, and `save_midi_model` saves a model drafted from a pasted manual page. It validates the
draft with the same schema as every model, returns a summary with nothing written, and saves into
`models/` only a model whose summary was produced earlier in the session, only after the user's
yes; an existing model needs `overwrite`, a shipped model id is always refused, and no tool writes
`instruments.json`; the server rewrites three fields of one entry on the user's click from the page.

The server also reads `instruments-state.json` (the instruments the user switched off) at every use,
and puts `enabled` and `modelChannels` (every channel of the model, with its role) on each instrument of
`midi-rig`. After `page-auth` the playing tab can send `instrument-switch` (set one instrument on or off)
and `instrument-settings` (the port, channels and clock of one instrument); a tab that is not the playing
one is refused. Each is answered by one `instrument-result` (`ok`, `refused`, `write-failed`, or for a
settings edit `invalid` with the problems of the file's own checks), sent after the new `midi-rig`, so the
page applies the rig before it clears its pending look. A settings edit patches the raw entry, validates
the result with `RigStore.validateRigValue` (the code that reads the file), writes it through a temporary
file, keeps the previous text as `instruments.json.bak` and refuses when the file changed while saving.
Claude hears each change once in the next tool reply.

The Instruments view also needs to say where the data folder is. After `page-auth` and
`history-request` the page sends `data-folder-request` once per connection, and the server answers
`{ type: 'data-folder', path }` only to a connection that presented the page token (also to a trusted
page that is not the active one), with the folder the setup store resolves (`resolveDataDir()`, the
one that holds `instruments.json`), or `null` when it cannot say (no setup store, an unresolvable folder, a control character,
or more than 1,024 characters; a path is never cut). The server never sends it unasked, so the
connect sequence stays as it was. The page shows the path with `textContent` only. A page request's
context kinds are one closed list on the page and the server, and the list has an `instrument` kind
(an `id` of 1 to 200 characters) for a right-click on an instrument card, and an `error` kind (a `text` of
1 to 200 characters, the first line of the error) for Ask Claude from the failed-change banner; the page
also prefills the Ask field with the error, cut at 1500 characters.

Sound catalogs extend a model with more sounds than a model file should hold. `src/catalog.ts` holds
the catalog file format (`catalogs/<model id>.json` in the data folder), its checks against the
model, the search and the summaries, and the atomic write. `src/rig-util.ts` holds the helpers it
shares with `src/instruments.ts`; it is a leaf module, so the two never import each other's
constants at load. `RigStore.read` reads the catalog of each model the setup file uses and appends
its sounds after the model's melodic sounds in `midi-rig`, with a `catalogSounds` count, so the page
resolves and refuses a catalog name like a model name and its refusal points to
`search_midi_sounds`. The drum fields of the rig message (`rhythmBank`, `drumMap`, `drumMaps` with
the resolved maps, and `catalogKits`) form one block after `catalogSounds`. The kits of a catalog
follow the model's own kits in `sounds.rhythm`, counted by `catalogKits`. `src/drum-maps.ts` holds
the map schema, the built-in General MIDI map and the one rule that resolves a kit's map; the page
reads it through `drumMapFor` and uses the maps only to show names (the Timeline rows, the moment's
`drum` field and the Instruments card), never to write a note. `src/midnam.ts` is the pure MIDNAM reader, and `src/import-midnam.ts` is the
`import-midnam` command that `src/index.ts` runs before it starts the server. `save_midi_catalog`
keeps a draft filled in parts in the session's memory, checks each part against the draft so far,
and writes only a draft whose summary was produced, after the user's yes.

## Stack

- Node.js 22+ and TypeScript
- `@modelcontextprotocol/sdk` for the MCP server
- Strudel (`@strudel/*`) in the browser
