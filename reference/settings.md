# Synth settings

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

What `.midi()` can do to set the settings of an instrument: the tone, part and scene options, as the Moontide page reads, checks and sends them. Every fact here is a plain possibility, not a suggestion of when to use it.

## Where the names come from

Only an instrument whose model describes settings takes them: get_midi_instruments lists, under the Settings line of that instrument, the names and ranges each level takes, with the tone names given per engine. An instrument with no Settings line takes no setting.

The tone settings a sound takes are those of its engine. On an instrument whose model declares engines, search_midi_sounds and get_midi_instruments with instrument set give the engine of each sound or say it is in no engine, and a sound in no engine takes no tone setting. A catalog without an engine table places no sound in an engine.

A tone name may be a setting of several engines, each with its own range, and the engine of the sound in the call decides which one is sent; the code is written the same way whichever engine the sound has.

The names come from one vocabulary, listed below, and an instrument takes only the names its Settings line lists.

The tone names:

```names
osc1Wave osc1Feet osc1Tune osc1Level osc2Wave osc2Feet osc2Tune osc2Level filterType filterCutoff filterResonance
filterEnvDepth env1Attack env1Decay env1Sustain env1Release env2Attack env2Decay env2Sustain env2Release lfoRate
lfoOscDepth lfoFilterDepth algorithm feedback partial1Cutoff toneCoarseTune partialMute partial1Level op1Level op1Ratio
op1Detune op1Attack op1Decay op1Sustain op1Release op2Level op2Ratio op2Detune op2Attack op2Decay op2Sustain op2Release
op3Level op3Ratio op3Detune op3Attack op3Decay op3Sustain op3Release op4Level op4Ratio op4Detune op4Attack op4Decay
op4Sustain op4Release op5Level op5Ratio op5Detune op5Attack op5Decay op5Sustain op5Release op6Level op6Ratio op6Detune
op6Attack op6Decay op6Sustain op6Release structure12 structure34 envMode partial1CoarseTune partial1FineTune
partial1PitchKeyFollow partial1BendSwitch partial1Wave partial1PcmWave partial1PulseWidth partial1PulseWidthVelocity
partial1PitchEnvDepth partial1PitchEnvVelocity partial1PitchEnvTimeKeyFollow partial1PitchEnvTime1 partial1PitchEnvTime2
partial1PitchEnvTime3 partial1PitchEnvTime4 partial1PitchEnvLevel0 partial1PitchEnvLevel1 partial1PitchEnvLevel2
partial1PitchEnvSustain partial1PitchEnvEnd partial1PitchLfoRate partial1PitchLfoDepth partial1PitchLfoModSens
partial1Resonance partial1CutoffKeyFollow partial1FilterBiasPoint partial1FilterBiasLevel partial1FilterEnvDepth
partial1FilterEnvVelocity partial1FilterEnvDepthKeyFollow partial1FilterEnvTimeKeyFollow partial1FilterEnvTime1
partial1FilterEnvTime2 partial1FilterEnvTime3 partial1FilterEnvTime4 partial1FilterEnvTime5 partial1FilterEnvLevel1
partial1FilterEnvLevel2 partial1FilterEnvLevel3 partial1FilterEnvSustain partial1LevelVelocity partial1AmpBiasPoint1
partial1AmpBiasLevel1 partial1AmpBiasPoint2 partial1AmpBiasLevel2 partial1AmpEnvTimeKeyFollow partial1AmpEnvTimeVelocity
partial1AmpEnvTime1 partial1AmpEnvTime2 partial1AmpEnvTime3 partial1AmpEnvTime4 partial1AmpEnvTime5 partial1AmpEnvLevel1
partial1AmpEnvLevel2 partial1AmpEnvLevel3 partial1AmpEnvSustain partial2CoarseTune partial2FineTune
partial2PitchKeyFollow partial2BendSwitch partial2Wave partial2PcmWave partial2PulseWidth partial2PulseWidthVelocity
partial2PitchEnvDepth partial2PitchEnvVelocity partial2PitchEnvTimeKeyFollow partial2PitchEnvTime1 partial2PitchEnvTime2
partial2PitchEnvTime3 partial2PitchEnvTime4 partial2PitchEnvLevel0 partial2PitchEnvLevel1 partial2PitchEnvLevel2
partial2PitchEnvSustain partial2PitchEnvEnd partial2PitchLfoRate partial2PitchLfoDepth partial2PitchLfoModSens
partial2Cutoff partial2Resonance partial2CutoffKeyFollow partial2FilterBiasPoint partial2FilterBiasLevel
partial2FilterEnvDepth partial2FilterEnvVelocity partial2FilterEnvDepthKeyFollow partial2FilterEnvTimeKeyFollow
partial2FilterEnvTime1 partial2FilterEnvTime2 partial2FilterEnvTime3 partial2FilterEnvTime4 partial2FilterEnvTime5
partial2FilterEnvLevel1 partial2FilterEnvLevel2 partial2FilterEnvLevel3 partial2FilterEnvSustain partial2Level
partial2LevelVelocity partial2AmpBiasPoint1 partial2AmpBiasLevel1 partial2AmpBiasPoint2 partial2AmpBiasLevel2
partial2AmpEnvTimeKeyFollow partial2AmpEnvTimeVelocity partial2AmpEnvTime1 partial2AmpEnvTime2 partial2AmpEnvTime3
partial2AmpEnvTime4 partial2AmpEnvTime5 partial2AmpEnvLevel1 partial2AmpEnvLevel2 partial2AmpEnvLevel3
partial2AmpEnvSustain partial3CoarseTune partial3FineTune partial3PitchKeyFollow partial3BendSwitch partial3Wave
partial3PcmWave partial3PulseWidth partial3PulseWidthVelocity partial3PitchEnvDepth partial3PitchEnvVelocity
partial3PitchEnvTimeKeyFollow partial3PitchEnvTime1 partial3PitchEnvTime2 partial3PitchEnvTime3 partial3PitchEnvTime4
partial3PitchEnvLevel0 partial3PitchEnvLevel1 partial3PitchEnvLevel2 partial3PitchEnvSustain partial3PitchEnvEnd
partial3PitchLfoRate partial3PitchLfoDepth partial3PitchLfoModSens partial3Cutoff partial3Resonance
partial3CutoffKeyFollow partial3FilterBiasPoint partial3FilterBiasLevel partial3FilterEnvDepth partial3FilterEnvVelocity
partial3FilterEnvDepthKeyFollow partial3FilterEnvTimeKeyFollow partial3FilterEnvTime1 partial3FilterEnvTime2
partial3FilterEnvTime3 partial3FilterEnvTime4 partial3FilterEnvTime5 partial3FilterEnvLevel1 partial3FilterEnvLevel2
partial3FilterEnvLevel3 partial3FilterEnvSustain partial3Level partial3LevelVelocity partial3AmpBiasPoint1
partial3AmpBiasLevel1 partial3AmpBiasPoint2 partial3AmpBiasLevel2 partial3AmpEnvTimeKeyFollow partial3AmpEnvTimeVelocity
partial3AmpEnvTime1 partial3AmpEnvTime2 partial3AmpEnvTime3 partial3AmpEnvTime4 partial3AmpEnvTime5 partial3AmpEnvLevel1
partial3AmpEnvLevel2 partial3AmpEnvLevel3 partial3AmpEnvSustain partial4CoarseTune partial4FineTune
partial4PitchKeyFollow partial4BendSwitch partial4Wave partial4PcmWave partial4PulseWidth partial4PulseWidthVelocity
partial4PitchEnvDepth partial4PitchEnvVelocity partial4PitchEnvTimeKeyFollow partial4PitchEnvTime1 partial4PitchEnvTime2
partial4PitchEnvTime3 partial4PitchEnvTime4 partial4PitchEnvLevel0 partial4PitchEnvLevel1 partial4PitchEnvLevel2
partial4PitchEnvSustain partial4PitchEnvEnd partial4PitchLfoRate partial4PitchLfoDepth partial4PitchLfoModSens
partial4Cutoff partial4Resonance partial4CutoffKeyFollow partial4FilterBiasPoint partial4FilterBiasLevel
partial4FilterEnvDepth partial4FilterEnvVelocity partial4FilterEnvDepthKeyFollow partial4FilterEnvTimeKeyFollow
partial4FilterEnvTime1 partial4FilterEnvTime2 partial4FilterEnvTime3 partial4FilterEnvTime4 partial4FilterEnvTime5
partial4FilterEnvLevel1 partial4FilterEnvLevel2 partial4FilterEnvLevel3 partial4FilterEnvSustain partial4Level
partial4LevelVelocity partial4AmpBiasPoint1 partial4AmpBiasLevel1 partial4AmpBiasPoint2 partial4AmpBiasLevel2
partial4AmpEnvTimeKeyFollow partial4AmpEnvTimeVelocity partial4AmpEnvTime1 partial4AmpEnvTime2 partial4AmpEnvTime3
partial4AmpEnvTime4 partial4AmpEnvTime5 partial4AmpEnvLevel1 partial4AmpEnvLevel2 partial4AmpEnvLevel3
partial4AmpEnvSustain keyShift toneFineTune bendRange assignMode toneReverbSwitch
```

The part names:

```names
level pan chorusSend reverbSend delaySend vibratoRateOffset vibratoDepthOffset vibratoDelayOffset cutoffOffset
resonanceOffset attackOffset decayOffset releaseOffset
```

The scene names:

```names
level chorusSwitch chorusType chorusLevel delaySwitch delayType delayLevel reverbSwitch reverbType reverbLevel
driveAmount driveSwitch masterTune reverbTime
```

## Writing them

The form is the tone, part and scene options of `.midi()`, each a plain object of names and values; every value below is a placeholder:

```js
note("c3 e3").midi('port name', { midichannel: channel, sound: 'sound name', tone: { name: value }, part: { name: value }, scene: { name: value } })
```

The level is the key of the option: a setting is tone, part or scene by where it is written, and each level is optional.

Each level is a plain object of names and whole numbers written as number literals in the call; a variable, a pattern or a value worked out while the code runs is refused.

Values are in the instrument's own units, inside the range get_midi_instruments lists for the name.

A setting is one value for the whole evaluation, never one per note.

## What each level reaches

Tone reaches the tone of the part that the channel of the call plays.

On an instrument whose model declares engines, tone needs a sound named in the same call, and the engine of that sound must have the setting.

Part reaches that part only.

Scene reaches every part of the instrument, not only the channel of the call that carries it, and the reply says so.

A name belongs to one level, except `level`, which both part and scene have and which is a different setting at each: under part it is the level of that part, under scene the level of the whole scene.

A name ending in Offset moves the value of the instrument itself up or down, so its lowest value is the largest move down and never off or closed; the value that changes nothing is given with the instrument.

## What is refused

A name the level does not have is refused, and the refusal lists the names that exist.

A name written at the wrong level is refused, and the refusal says the level it belongs to.

A value outside the range is refused, and the refusal gives the range.

Two values of one setting for one channel, or of one scene setting for one instrument, are refused, and the refusal names both.

Tone settings with no sound in the call, on a sound in no engine, or on a sound of another engine are refused, and each refusal gives its own reason; only the refusal for a sound of another engine names the engines, the one of the sound and those of the setting.

A setting Moontide cannot send safely to that instrument is refused, and the refusal says why.

A refused evaluation keeps the music that was playing and sends nothing.

## When they are sent

Every evaluation sends every setting the code writes, not only what changed.

Each channel's bank select and program change go first, then its tone and part settings, and the scene settings follow after all the channels.

On an instrument whose model maps a setting to an NRPN, the setting goes out on the channel of its call as that NRPN, and Moontide never sends a value back by itself.

A change that waits for a bar or phrase line sends its settings at the line, with its sound.

They are sent again, with the sound, when the instrument is plugged in again.

## Nothing is stored

Moontide stores no setting: the code is the only record.

A setting taken out of the code is not sent again and nothing undoes it; the instrument keeps the last value, and the reply says so.

A new sound on a channel loads that tone again, which undoes the channel's tone settings, and the tone settings still in the code are sent right after its program change.

## What the instrument undoes

On the instrument, what undoes a setting differs from one instrument to another: the Notes line of the instrument in get_midi_instruments says what undoes each of its settings and what was heard on it.

## System exclusive messages from the code

The MIDI messages the code sends itself are checked just before they leave, on every port, whatever instruments are described. A Roland system exclusive message of a model whose temporary areas Moontide knows is sent only as a complete data set whose whole address range lies inside those areas; otherwise the whole send is dropped and the reply gives the reason. A send whose data cannot be read as byte-like values is dropped too. System exclusive messages of other makers and of other Roland models pass.
