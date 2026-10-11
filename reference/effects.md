# Effects and sound controls

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

Every control below is a method chained onto a pattern (for example `s("bd").gain(0.8)`); most also take a mini-notation string or a signal to pattern the value over time.

## Level and pan

- `gain(n)` — output level, roughly 0 (silent) to 1 (full), can go higher.
- `velocity(n)` — a separate, multiplicative level control (0 to 1), for layering dynamics onto `gain`.
- `postgain(n)` — a second gain stage applied after effects, useful when an effect changes the level unexpectedly.
- A later `.gain(n)` replaces every gain set earlier in the track (in its pattern strings, its `stack` branches and its echoes), so loud and quiet notes end up at one level. On a browser track with no post-gain of its own, `.postgain(n)` scales what the track plays after its effects and keeps that difference; a later `.postgain(n)` replaces an earlier one the same way, and a MIDI track ignores `postgain` (use `.gain(n)` or `.velocity(n)` there).
- `pan(n)` — stereo position, 0 (left) to 1 (right), 0.5 is center.

```js
s("bd sd").gain(0.8).pan(0.3)
```

## Filters

- `lpf(n)` / `cutoff(n)` — low-pass filter cutoff frequency in Hz (`lpf` and `cutoff` are the same control).
- `lpq(n)` / `resonance(n)` — low-pass filter resonance, emphasizing the frequencies near the cutoff.
- `hpf(n)` / `hpq(n)` — high-pass filter cutoff and resonance, same shape as the low-pass pair.
- `bpf(n)` / `bpq(n)` — band-pass filter center frequency and resonance.
- `vowel(name)` — a formant filter shaped like a spoken vowel. The accepted values are `a`, `e`, `i`, `o`, `u`, `ae`, `aa`, `oe`, `ue`, `y`, `uh`, `un`, `en`, `an` and `on`.
- `ftype(name)` — selects the filter's underlying algorithm where more than one is available in this bundle.

```js
s("bd*4").lpf(800).lpq(6)
```

## Filter envelopes

Each filter has its own attack/decay/sustain/release and a depth (`env`), for a cutoff that moves over the note instead of staying fixed. The low-pass set: `lpattack`, `lpdecay`, `lpsustain`, `lprelease`, `lpenv`. The same five names exist prefixed `hp` and `bp` for the high-pass and band-pass filters.

```js
note("c e g").lpf(400).lpenv(4).lpattack(0.05)
```

## Amplitude envelope

- `attack(n)` / `decay(n)` / `sustain(n)` / `release(n)` — the four stages of the note's volume over time, each in seconds (sustain is a level, 0 to 1).
- `adsr(a:d:s:r)` — sets all four at once from one mini-notation string.

```js
note("c").attack(0.01).decay(0.2).sustain(0.3).release(0.5)
```

## Distortion

- `distort(n)` — waveshaping distortion amount.
- `distortvol(n)` — the linear level applied after the distortion, 1 by default.
- `shape(n)` — a different waveshaping curve, similar effect.
- `crush(n)` — bitcrusher: lower `n` means fewer bits, more distortion (8 is barely audible, 1 is extreme).
- `coarse(n)` — sample-rate reduction: higher `n` skips more samples, adding grit.

```js
s("bd sd").crush(4)
```

## Delay

- `delay(n)` — delay effect send level, 0 to 1.
- `delaytime(n)` — the delay time in seconds, up to 1 (the delay line holds at most one second); when absent, a time derived from the tempo is used.
- `delayfeedback(n)` — how much of the delayed signal feeds back in, 0 to 1 (close to 1 rings longer).

```js
s("bd sd").delay(0.4).delaytime(0.125).delayfeedback(0.5)
```

## Reverb

- `room(n)` — reverb send level, 0 to 1.
- `roomsize(n)` / `size(n)` — the size of the simulated space (`roomsize` and `size` are the same control).
- `roomfade(n)` — the time in seconds over which the reverb tail fades in.
- `roomlp(n)` — a low-pass filter on the reverb tail only (darkens the reflections without affecting the dry signal).
- `roomdim(n)` — the reverb tail's low-pass frequency at -60 dB, in Hz.

```js
s("bd sd").room(0.5).roomsize(4)
```

## Orbit

- `orbit(n)` — routes this pattern's delay and reverb through a separate numbered bus, so different parts can have independent, non-mixing delay and reverb settings.

```js
s("bd").delay(0.3).orbit(1)
```

## Modulation

- `phaser(rate)` — a phaser effect cycling at `rate` Hz.
- `phaserdepth(n)` — how strongly the phaser sweeps, 0 to 1, 0.75 by default.
- `phasercenter(n)` — the centre frequency of the phaser sweep in Hz, 1000 by default.
- `phasersweep(n)` — how far the sweep reaches around its centre in Hz, 2000 by default.
- `vib(rate)` — vibrato (pitch wobble) rate in Hz.
- `vibmod(depth)` — how far the vibrato swings.
- `fm(depth)` — frequency-modulation synthesis depth.
- `fmh(ratio)` — the FM modulator's frequency, as a ratio of the base frequency.
- `detune(n)` — offsets a voice's pitch slightly, used with `unison`.
- `unison(n)` — stacks `n` detuned copies of a synth voice (used with `supersaw`, for example).
- `tremolo(rate)` — amplitude wobble at `rate` Hz, the volume equivalent of `vib`.
- `tremolosync(n)` — the same wobble, `n` times per cycle instead of in Hz. When both are set, `tremolosync` is used.
- `tremolodepth(n)` — how deep the wobble goes, 0 to 1, 1 by default.
- `tremoloshape(name)` — the wobble's waveform: `sine`, `tri`, `square`, `saw` or `ramp`.

```js
note("c").s("supersaw").unison(4).detune(0.2)
```

## Speed and pitch envelope

- `penv(n)` — pitch envelope depth, in semitones, over the note's attack/decay/sustain/release.

## Compression

- `compressor(threshold)` — dynamic range compression, reducing the level above `threshold` (dB). A plain number sets the threshold only.
- `compressor("threshold:ratio:knee:attack:release")` — the string form sets up to five fields at once: threshold in dB, ratio, knee in dB, attack in seconds and release in seconds. The defaults are -3, 10, 10, 0.005 and 0.05, and a prefix such as `"-20:4"` sets the first fields only.
