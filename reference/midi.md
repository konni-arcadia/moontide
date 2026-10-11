# MIDI output

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

What `.midi()` does in the Moontide page: which port and channel a track reaches, how notes, control changes and program changes go out, the MIDI clock Moontide sends, and what Stop sends. Every fact here is a plain possibility, not a suggestion of when to use it.

## Port

Write the port name in single quotes: `.midi('port name')`. A double-quoted port name is a mini-notation pattern, and `.midi()` refuses it with the error `.midi does not accept Pattern input for midiport`.

```js
note("c3 e3 g3").midi('port name')
```

The port name is matched as part of an output name, case-sensitive, and the first output in the browser's list whose name contains it is used. With no port, the first output whose name contains `IAC` is used, else the first output.

A port written another way (a variable that is not a top-level const, or a value built while the code runs) cannot be checked by the page, and Stop then silences every connected output.

## Channel

The channel is the `midichannel` option, 1 to 16, and it is 1 when none is given: `.midi('port name', { midichannel: 2 })`. `.midichan(n)` sets the channel of each event instead.

```js
note("c3 e3").midi('port name', { midichannel: 2 })
```

## Notes

`velocity` is 0 to 1 and is 0.9 when none is given; on a MIDI track `.gain()` multiplies the velocity, so it changes how hard a note is played, not the volume of the instrument.

A velocity that goes above 1 after the multiplication by `.gain()` is an error.

```js
note("c3").velocity(0.5).midi('port name')
```

A note goes out only for an event that has a `note` value: `s("bd hh sd hh").midi('port name')` and a bare `n("36 42").midi('port name')` send no notes; `n()` works only once `.scale()` has turned it into notes (reference/theory.md).

A drum track for a MIDI instrument therefore writes note numbers, such as the General MIDI drum notes 36, 38 and 42, on the instrument's drum channel (10 on a General MIDI instrument):

```js
note("36 42 38 42").midi('port name', { midichannel: 10 })
```

A drum kit is chosen like a sound, with the sound option of `.midi()` on the instrument's rhythm channel. On an instrument whose rhythm channels take a bank, the page sends the kit's bank select and then its program change before the new code plays; on every other instrument a kit is a program change alone. get_midi_instruments gives each instrument's drum map, which note plays which drum, and says when a kit has no known map; the code keeps writing note numbers.

A note lasts its event's length, times `legato` (or `clip`) when set, minus 10 ms.

Each note-on goes out with its note-off already timed for the note's end, so Strudel itself cannot end a note early.

For the same reason `legato` above 1 on a repeated pitch is cut: the earlier note's note-off ends the next note of the same pitch.

The Moontide page ends the notes of a track that is muted, silenced by a solo or removed: it sends a sustain release and All Notes Off on that track's channel when no other track plays there, and a note-off for each of the track's sounding notes when one does.

## Control changes and program changes

`ccn(n)` sets the controller number and `ccv(x)` its value, a number from 0 to 1, sent as `x * 127` rounded; a value outside 0 to 1 is an error.

A control-change sweep takes its structure from the left: `ccv(sine.segment(16)).ccn(74)` sends 16 values per cycle, while `ccn(74).ccv(sine.segment(16))` sends one.

```js
ccv(sine.segment(16)).ccn(74).midi('port name')
```

`progNum(n)` sends a program change, 0 to 127.

A program change and a note at the same instant go out in no fixed order, so a program change inside a pattern can cut or change the note it shares an instant with; a sound chosen at an instant where the track plays no note cannot cut one, which is why sounds are chosen before notes.

## Choosing a sound

`.midi()` ignores option keys it does not know: its options object is spread into its settings and each note reads only the keys Strudel defines, so a `sound` or `controls` key changes nothing in Strudel.

The Moontide page reads `sound` when the user has described instruments in instruments.json: `.midi('port name', { midichannel: 3, sound: 'sound name' })` makes the page send that instrument's program change before the new code plays, and get_midi_instruments lists each instrument's sounds. With a change that waits for a bar or phrase line, the page sends the program change just before the line, timestamped at the line.

The Moontide page also reads `controls` when the user has described instruments in instruments.json: `.midi('port name', { midichannel: 3, controls: { volume: 100 } })` sets one static level per control of that instrument, in the control's own range, and the page sends it before the new code plays. Control ids and ranges come from get_midi_instruments; a control that leaves the code goes back to the instrument's default; a sweep stays `ccn` and `ccv`. With a change that waits for a bar or phrase line, the page sends the controls just before the line, timestamped at the line.

## What a MIDI track ignores

A track with `.midi()` plays nothing in the browser, so browser sounds and effects on it (`s`, `lpf`, `room`, `delay`) do nothing.

## Clock

Moontide sends MIDI clock, Start and Stop itself to each instrument that follows the clock (get_midi_instruments says which ones), while the playing code names that instrument in a `.midi()` call.

The clock counts 4 beats per cycle, 24 ticks per beat, so 96 ticks per cycle: a tempo of N beats per minute is `setcpm(N/4)`, and a tempo change in the code moves the clock with it.

The code never writes clock or transport: a `midicmd` of `clock`, `midiClock`, `start`, `stop` or `continue` is dropped before it reaches a port, and so is the Start Strudel sends on every MIDI track at cycle 0.

Moontide cannot tell Strudel's own Start from a written one by its byte: it takes a Start while the scheduler is at cycle 0 as Strudel's and one from cycle 1 onward as written, so a Start that Strudel sends later (a pattern with an event that begins at cycle 0 once the scheduler is past it) can raise the notice that the code wrote clock or transport with no such code. A Start leaves a little before it sounds, so one written exactly on cycle 1 counts as Strudel's.

A track names an instrument without playing a note when its pattern is `silence`, with a channel the instrument declares (get_midi_instruments lists them):

```js
$: silence.midi('port name', { midichannel: 3 })
```

An instrument gets its Start on a cycle boundary: the first cycle when the music starts, the next one when the code starts naming it while the music plays; its notes wait until that Start.

A muted track still names its instrument, so its clock keeps running; Stop, or code that no longer names the instrument, sends it a Stop.

## Stop and the page

Stop sends, on every port the code has named since the page loaded (on every connected output when a call gives its port by number or leaves it out, because Strudel picks that port at every note), a sustain release (CC 64 at 0) then All Notes Off (CC 123) on channels 1 to 16.

Stop also sends a MIDI Stop to each instrument that gets the clock; a follower always starts again from its beginning, because no Song Position Pointer and no Continue are sent.

MIDI messages from `.midi()` leave the page shortly before they sound, with a timestamp from the page's clock, so a busy page no longer shifts them; Stop, a mute and a sound change still end or wait for the notes already sent.

MIDI timing follows the page: while the Moontide tab is hidden the browser slows its timers, so notes can come late or be missing until the tab is in front again.

MIDI output needs a browser with Web MIDI (Chrome or Edge) and the user's permission for this page.
