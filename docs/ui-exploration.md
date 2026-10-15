# UI exploration

Where the page could grow after the MVP: from an editor that plays into a small jam DAW.
This is a direction, not settled work. It comes from a design discussion and a clickable
mockup. Some of it already exists in the page. Only the entries in
[decisions.md](decisions.md) are settled.

## Principles

- **The code is always the center.** Every other view is another angle on the same Strudel
  text. A control edits the text, so the code stays the single source of truth, and the code
  line it touched lights up.
- **Switch, don't choose.** Three layouts are modes of one screen, not rivals: a bottom strip
  (best for the linear timeline), a side panel (best for code plus mixer) and full-screen
  faces that flip in over faint code (best for focus). Views switch instantly from the
  keyboard.
- **Comfortable for long sessions** (10 minutes to 2 hours at a desk): dark and calm, few
  moving parts, and a switch to turn motion off. Every size derives from one font size, so
  the page scales from a 1080p laptop to 4K, and keeps an iPad or a stream possible later.
- **The chat stays in its own window.** The page only gets a small right-click prompt that
  attaches context to a message for Claude (see below).

## Views

| View | What it shows |
|---|---|
| History | Snapshots of the code over the session, with restore |
| Timeline | The music itself over time, one lane per track; literal notes can be edited |
| Mixer | Per-track signal flow, effects with their parameters, shared buses, the song's groups, a light per strip |
| Parts | Sections to launch, each showing where it is (the Song grid for a piece with a song) |
| Jam | The scale, what to avoid, what is coming, on a piano or a guitar |

- **History.** A snapshot appears after a short pause once something stops changing (a fader
  drag is one snapshot). Restoring adds a new snapshot, so history is append-only.
- **Timeline.** Everything loops, so the view unrolls the loops: 32 cycles, sections
  (`arrange()`), the chord loop repeating, each track's own loop length, and slow filter
  movements as curves with their own periods that drift apart. It should come from a query of
  the real pattern over a time range. Editing has started: a note that one place in the code
  holds can be moved by semitones, turned into a rest or given another velocity, and anything
  else becomes a ready-made request to Claude. Wider editing is still open.
- **Parts.** Parts are `arrange()` sections. The playing part shows its position (3/8 cycles)
  and a progress bar, a queued part counts down and starts at the next cycle, idle parts show
  their length. For a piece that declares a song, the Parts view is called Song and shows
  the sections as columns with the tracks, in foldable groups, as rows; a click launches a
  section or changes a cell.
- **Jam.** The scale stays constant ("D Dorian"). The status says "all safe" or names the
  note to avoid while a chord leaves the scale, and a short list gives the next warnings and
  part changes with a countdown. Chord names are secondary.

## Mixer, as Strudel really works

Checked against Strudel's effects documentation.

- Each track reads top to bottom like the signal: **Source** (envelope, vibrato), **Chain**,
  **Sends**, fader.
- **The chain order is fixed by Strudel**: lowpass, highpass, bandpass, vowel, coarse, crush,
  distortion, tremolo, compressor, pan, phaser. The UI shows that order. Strudel keeps one of
  each effect, so "add effect" lists only what a track lacks.
- **Every effect has its own parameters.** A chip opens an inspector with the main ones, the
  rest under "more". Untouched parameters keep Strudel's default and are not written. Some
  effects pack values in one string (the compressor), a filter can be modulated
  (`sine.range(a,b).slow(n)`).
- **Reverb and delay are shared: one of each per orbit (bus).** A track only sends a level.
  Size, fade, lowpass, damping, delay time and feedback belong to the bus. Strudel gives
  unpredictable results when two tracks set different values on one orbit, so the UI writes a
  bus parameter on every sending track. Some reverb parameters recalculate it: apply them on
  release, not while dragging.
- Bypass removes the effect from the code line while it is off.

## Talking to Claude from the page

A right-click anywhere opens a small prompt box with the context attached (a snapshot, a code
line, a fader, an effect or one of its parameters, a part, a timeline lane and the cycle under
the cursor, a note on the piano or fretboard). Enter sends. Delivery is proven with tools
that already exist: the page sends to the Moontide server over the existing WebSocket, and
Claude watches it with a background monitor that wakes Claude on each message. No
experimental flag is needed. The box and the delivery already work (see
[decisions.md](decisions.md) for the listener and the tokens that protect them); the Jam view
adds notes and warnings to what can be attached.

## Open questions

- Does Moontide parse code into tracks and parts, or does Claude keep a structured
  description beside the code? The first is more robust, the second cheaper.
- Rewriting Strudel text safely (adding, removing or changing a method on a chain) is the
  hard part of the mixer, more than the interface.
- Key and chord detection on real patterns, for the Jam view.
- The effect list in the mockup is written by hand from the docs. It could be generated from
  Strudel's own function metadata.
