# Sound palette

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

Every default sound the Moontide page can play, by family. Nothing here is hidden to avoid tint: a full, honest palette is the point — every registered instrument is listed with no more and no less prominence than any other, in the General MIDI soundfonts section below.

## How to play a sound

`s(name)` and `sound(name)` play a sound by name (they are the same function); a mini-notation string can hold several names separated by spaces. `n(i)` or `name:i` selects a numbered variant from a sample bank that has more than one sample per slot (for example a drum machine's velocity layers, or a sample set with several takes). A drum abbreviation (`bd`, `sd`, and so on) plays from the default kit unless `.bank(machine)` names one of the drum machines below, in which case the abbreviation selects that machine's own sample. `note(pattern)` plays a pitched set (a synth, a soundfont, the piano, or a pitched VCSL instrument) at the given pitch instead of at its recorded pitch. Synth-specific parameters (`attack`, `pw`, `unison`, and the rest) live in the effects topic, not here.

## Synths

The basic oscillator waveforms and noise sources:

```names
triangle square sawtooth sine user one
pink white brown crackle
```

`tri`, `sqr`, `saw` and `sin` are short aliases for `triangle`, `square`, `sawtooth` and `sine`.

The other registered synths:

```names
supersaw pulse sbd bytebeat
```

- `supersaw` — a stack of detuned unison sawtooth voices (use with `unison` and `detune`).
- `pulse` — a pulse wave with an adjustable pulse width (`pw`, `pwrate`, `pwsweep`).
- `sbd` — a synthesized bass drum (kick) with its own pitch envelope (`penv`, `pdecay`).
- `bytebeat` — a family of algorithmic bytebeat waveform generators, selected by index.
- `user` — a custom waveform built from harmonic partials (falls back to `triangle` if none are given).
- `one` — a constant value of 1 (a DC source, useful as a control multiplier rather than an audible tone).

## ZZFX synths

```names
zzfx z_sine z_sawtooth z_triangle z_square z_tan z_noise
```

`z_sine`, `z_sawtooth`, `z_triangle`, `z_square`, `z_tan` and `z_noise` are the ZZFX voice fixed to one waveform shape; bare `zzfx` is the same voice with no shape fixed. Played the same way as any other sound, with `s()` or `sound()`.

## General MIDI soundfonts

```names
gm_accordion gm_acoustic_bass gm_acoustic_guitar_nylon gm_acoustic_guitar_steel gm_agogo gm_alto_sax gm_applause gm_bagpipe gm_bandoneon gm_banjo
gm_baritone_sax gm_bassoon gm_bird_tweet gm_blown_bottle gm_brass_section gm_breath_noise gm_celesta gm_cello gm_choir_aahs gm_church_organ gm_clarinet
gm_clavinet gm_contrabass gm_distortion_guitar gm_drawbar_organ gm_dulcimer gm_electric_bass_finger gm_electric_bass_pick gm_electric_guitar_clean
gm_electric_guitar_jazz gm_electric_guitar_muted gm_english_horn gm_epiano1 gm_epiano2 gm_fiddle gm_flute gm_french_horn gm_fretless_bass gm_fx_atmosphere
gm_fx_brightness gm_fx_crystal gm_fx_echoes gm_fx_goblins gm_fx_rain gm_fx_sci_fi gm_fx_soundtrack gm_glockenspiel gm_guitar_fret_noise gm_guitar_harmonics
gm_gunshot gm_harmonica gm_harpsichord gm_helicopter gm_kalimba gm_koto gm_lead_1_square gm_lead_2_sawtooth gm_lead_3_calliope gm_lead_4_chiff
gm_lead_5_charang gm_lead_6_voice gm_lead_7_fifths gm_lead_8_bass_lead gm_marimba gm_melodic_tom gm_music_box gm_muted_trumpet gm_oboe gm_ocarina
gm_orchestra_hit gm_orchestral_harp gm_overdriven_guitar gm_pad_bowed gm_pad_choir gm_pad_halo gm_pad_metallic gm_pad_new_age gm_pad_poly gm_pad_sweep
gm_pad_warm gm_pan_flute gm_percussive_organ gm_piano gm_piccolo gm_pizzicato_strings gm_recorder gm_reed_organ gm_reverse_cymbal gm_rock_organ gm_seashore
gm_shakuhachi gm_shamisen gm_shanai gm_sitar gm_slap_bass_1 gm_slap_bass_2 gm_soprano_sax gm_steel_drums gm_string_ensemble_1 gm_string_ensemble_2
gm_synth_bass_1 gm_synth_bass_2 gm_synth_brass_1 gm_synth_brass_2 gm_synth_choir gm_synth_drum gm_synth_strings_1 gm_synth_strings_2 gm_taiko_drum
gm_telephone gm_tenor_sax gm_timpani gm_tinkle_bell gm_tremolo_strings gm_trombone gm_trumpet gm_tuba gm_tubular_bells gm_vibraphone gm_viola gm_violin
gm_voice_oohs gm_whistle gm_woodblock gm_xylophone
```

125 General MIDI instruments, each a note()-following soundfont — pitch is set the same way as any pitched sound.

## Drum machines

17 standard drum-machine sound types appear across these 71 machines: bd (bass drum), cb (cowbell), cp (clap), cr (crash cymbal), fx (sound effect), hh (closed hi-hat), ht (high tom), lt (low tom), misc (miscellaneous percussion), mt (mid tom), oh (open hi-hat), perc (generic percussion), rd (ride cymbal), rim (rimshot), sd (snare drum), sh (shaker), tb (tambourine).

Each line below is one machine and exactly the sound types it has:

```names
AJKPercusyn: bd cb ht sd
AkaiLinn: bd cb cp cr hh ht lt mt oh rd sd sh tb
AkaiMPC60: bd cp cr hh ht lt misc mt oh perc rd rim sd
AkaiXR10: bd cb cp cr hh ht lt misc mt oh perc rd rim sd sh tb
AlesisHR16: bd cp hh ht lt oh perc rim sd sh
AlesisSR16: bd cb cp cr hh misc oh perc rd rim sd sh tb
BossDR110: bd cp cr hh oh rd sd
BossDR220: bd cp cr hh ht lt mt oh perc rd sd
BossDR55: bd hh rim sd
BossDR550: bd cb cp cr hh ht lt misc mt oh perc rd rim sd sh tb
CasioRZ1: bd cb cp cr hh ht lt mt rd rim sd
CasioSK1: bd hh ht mt oh sd
CasioVL1: bd hh sd
DoepferMS404: bd hh lt oh sd
EmuDrumulator: bd cb cp cr hh ht lt mt oh perc rim sd
EmuModular: bd misc perc
EmuSP12: bd cb cp cr hh ht lt misc mt oh perc rd rim sd
KorgDDM110: bd cp cr hh ht lt oh rim sd
KorgKPR77: bd cp hh oh sd
KorgKR55: bd cb cr hh ht oh perc rim sd
KorgKRZ: bd cr fx hh ht lt misc oh rd sd
KorgM1: bd cb cp cr hh ht misc mt oh perc rd rim sd sh tb
KorgMinipops: bd hh misc oh sd
KorgPoly800: bd
KorgT3: bd cp hh misc oh perc rim sd sh
Linn9000: bd cb cr hh ht lt mt oh perc rd rim sd tb
LinnDrum: bd cb cp cr hh ht lt mt oh perc rd rim sd sh tb
LinnLM1: bd cb cp hh ht lt oh perc rim sd sh tb
LinnLM2: bd cb cp cr hh ht lt mt oh rd rim sd sh tb
MFB512: bd cp cr hh ht lt mt oh sd
MPC1000: bd cp hh oh perc sd sh
MoogConcertMateMG1: bd sd
OberheimDMX: bd cp cr hh ht lt mt oh rd rim sd sh tb
RhodesPolaris: bd misc sd
RhythmAce: bd hh ht lt oh perc sd
RolandCompurhythm1000: bd cb cp cr hh ht lt mt oh perc rd rim sd
RolandCompurhythm78: bd cb hh misc oh perc sd tb
RolandCompurhythm8000: bd cb cp cr hh ht lt mt oh perc rim sd
RolandD110: bd cb cr hh lt oh perc rd rim sd sh tb
RolandD70: bd cb cp cr hh lt mt oh perc rd rim sd sh
RolandDDR30: bd ht lt sd
RolandJD990: bd cb cp cr hh ht lt misc mt oh perc rd sd tb
RolandMC202: bd ht perc
RolandMC303: bd cb cp fx hh ht lt misc mt oh perc rd rim sd sh tb
RolandMT32: bd cb cp cr hh ht lt mt oh perc rd rim sd sh tb
RolandR8: bd cb cp cr hh ht lt mt oh perc rd rim sd sh tb
RolandS50: bd cb cp cr ht lt misc mt oh perc rd sd sh tb
RolandSH09: bd
RolandSystem100: bd hh misc oh perc sd
RolandTR505: bd cb cp cr hh ht lt mt oh perc rd rim sd
RolandTR606: bd cr hh ht lt oh sd
RolandTR626: bd cb cp cr hh ht lt mt oh perc rd rim sd sh tb
RolandTR707: bd cb cp cr hh ht lt mt oh rim sd tb
RolandTR727: perc sh
RolandTR808: bd cb cp cr hh ht lt mt oh perc rim sd sh
RolandTR909: bd cp cr hh ht lt mt oh rd rim sd
SakataDPM48: bd cp cr hh ht lt mt oh perc rd rim sd sh
SequentialCircuitsDrumtracks: bd cb cp cr hh ht oh rd rim sd sh tb
SequentialCircuitsTom: bd cp cr hh ht oh sd
SergeModular: bd misc perc
SimmonsSDS400: ht lt mt sd
SimmonsSDS5: bd hh ht lt mt oh rim sd
SoundmastersR88: bd cr hh oh sd
UnivoxMicroRhythmer12: bd hh oh sd
ViscoSpaceDrum: bd cb hh ht lt misc mt oh perc rim sd
XdrumLM8953: bd cr hh ht lt mt oh rd rim sd tb
YamahaRM50: bd cb cp cr hh ht lt misc mt oh perc rd sd sh tb
YamahaRX21: bd cp cr hh ht lt mt oh sd
YamahaRX5: bd cb fx hh lt oh rim sd sh tb
YamahaRY30: bd cb cp cr hh ht lt misc mt oh perc rd rim sd sh tb
YamahaTG33: bd cb cp cr fx ht lt misc mt oh perc rd rim sd sh tb
```

A machine name works with `.bank()` on its own, or through a shorter alias (67 machines have one):

```names
9000 Ace CircuitsDrumtracks CircuitsTom Compurhythm1000 Compurhythm78 Compurhythm8000 ConcertMateMG1 D110 D70 DDM110 DDR30 DMX DPM48 DR110 DR220 DR55 DR550
Drumulator HR16 JD990 KPR77 KR55 KRZ LM1 LM2 LM8953 Linn M1 MC202 MC303 MPC60 MS404 MT32 MicroRhythmer12 Minipops Percysyn Polaris Poly800 R8 R88 RM50 RX21
RX5 RY30 RZ1 S50 SDS400 SDS5 SH09 SK1 SP12 SR16 Serge SpaceDrum System100 T3 TG33 TR505 TR606 TR626 TR707 TR727 TR808 TR909 VL1 XR10
```

## Default drum kit

When no `.bank()` is set, a drum abbreviation plays from this default kit instead of a named machine:

```names
bd brk cb cp cr hh ht lt misc mt oh rd rim sd sh tb
```

## Sample sets

Piano (one name, played across its full recorded range with `note()`):

```names
piano
```

The Dirt-Samples subset loaded by default:

```names
casio crow east insect jazz metal numbers space wind
```

VCSL (Versilian Community Sample Library), 127 instruments:

```names
agogo anvil balafon balafon_hard balafon_soft ballwhistle bassdrum1 bassdrum2 belltree bongo brakedrum cabasa cajon clap clash clash2 clave clavisynth
conga cowbell dantranh dantranh_tremolo dantranh_vibrato darbuka didgeridoo fingercymbal flexatone fmpiano folkharp framedrum glockenspiel gong gong2 guiro
handbells handchimes harmonica harmonica_soft harmonica_vib harp hihat kalimba kalimba2 kalimba3 kalimba4 kalimba5 kawai marimba marktrees ocarina
ocarina_small ocarina_small_stacc ocarina_vib oceandrum organ_4inch organ_8inch organ_full piano1 pipeorgan_loud pipeorgan_loud_pedal pipeorgan_quiet
pipeorgan_quiet_pedal psaltery_bow psaltery_pluck psaltery_spiccato ratchet recorder_alto_stacc recorder_alto_sus recorder_alto_vib recorder_bass_stacc
recorder_bass_sus recorder_bass_vib recorder_soprano_stacc recorder_soprano_sus recorder_tenor_stacc recorder_tenor_sus recorder_tenor_vib sax sax_stacc
sax_vib saxello saxello_stacc saxello_vib shaker_large shaker_small siren slapstick sleighbells slitdrum snare_hi snare_low snare_modern snare_rim steinway
strumstick super64 super64_acc super64_vib sus_cymbal sus_cymbal2 tambourine tambourine2 timpani timpani2 timpani_roll tom2_mallet tom2_rim tom2_stick
tom_rim tom_stick trainwhistle triangles tubularbells tubularbells2 vibraphone vibraphone_bowed vibraphone_soft vibraslap wineglass
wineglass_slow woodblock xylophone_hard_ff xylophone_hard_pp xylophone_medium_ff xylophone_medium_pp xylophone_soft_ff xylophone_soft_pp
```

Mridangam (South Indian drum), one name per stroke:

```names
ardha chaapu dhi dhin dhum gumki ka ki na nam ta tha thom
```

## Loading more

`samples(url)` loads another sample bank from a JSON manifest URL, or from a `github:user/repo` shorthand; the browser page needs network access to fetch it, and a `github:` repo needs its own `strudel.json` manifest at the root. A name starting with `wt_` is loaded as a wavetable instead of a plain sample (`registerWaveTable` vs `registerSample`); no `wt_`-prefixed name is loaded by default in this bundle — the prebake step above never calls `samples()` on a wavetable manifest.

## Where these names come from

Extracted 2026-09-27 by reading `@strudel/repl@1.3.0`'s bundle text and the sample manifests it loads at startup, never by running them: the synth, ZZFX and General MIDI names come from `https://unpkg.com/@strudel/repl@1.3.0/dist/index.js`; the drum machines, default kit and sample sets come from `https://raw.githubusercontent.com/felixroos/dough-samples/main/` (`tidal-drum-machines.json`, `piano.json`, `Dirt-Samples.json`, `vcsl.json`, `mridangam.json`) and `https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json`; the bank aliases come from `https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json`. The page loads all of these sample manifests from GitHub main branches when it starts, so their names can change without a Strudel version change — run `npm run check:reference` to see if this list has drifted from what the page actually loads today.

VCSL audio files themselves load from `https://cdn.jsdelivr.net/gh/sgossner/VCSL@c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/`, the VCSL repository pinned to one commit, instead of the GitHub base vcsl.json declares. The reason: Chrome refuses GitHub's response for files whose folder name holds a comma. The names still come from vcsl.json; its tom_mallet entry is left out of the list above, because its files are missing at the paths the manifest gives.
