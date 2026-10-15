import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Strudel reference for @strudel/repl 1.3.0: static facts about the pinned
// Strudel version — what exists and how to write it, never taste (no mood, genre or
// technique preference). The pin lives in page/index.html; whenever that pin changes, the
// reference must be re-checked with `npm run check:reference`.

export const STRUDEL_REPL_VERSION = '1.3.0';

export const REFERENCE_APPLIES_TO =
  'Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).';

export const REFERENCE_URI_PREFIX = 'moontide://reference';

export const REFERENCE_MAX_CHARS = 24000;

interface ReferenceTopic {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly summary: string;
}

// Table order is the order topics are listed in the index and in the tool description.
export const REFERENCE_TOPICS = [
  {
    id: 'tidal-differences',
    file: 'tidal-differences.md',
    title: 'Strudel vs TidalCycles',
    summary:
      'syntax that differs from TidalCycles: operators, strings, tempo, several parts at once, and Tidal names this version does not have',
  },
  {
    id: 'mini-notation',
    file: 'mini-notation.md',
    title: 'Mini-notation',
    summary:
      'every symbol of the pattern strings: sequences, subdivision, alternation, speed, rests, chords, weights, repeats, randomness, Euclidean rhythms, polymeter and sample numbers',
  },
  {
    id: 'functions',
    file: 'functions.md',
    title: 'Pattern functions',
    summary:
      'building, combining and transforming patterns: sources, stacking and sequencing, time, structure, randomness, signals, conditions, tempo, sample slicing and several parts at once',
  },
  {
    id: 'effects',
    file: 'effects.md',
    title: 'Effects and sound controls',
    summary: 'gain, pan, filters and their envelopes, amplitude envelopes, distortion, delay, reverb, modulation and orbits',
  },
  {
    id: 'sounds',
    file: 'sounds.md',
    title: 'Sound palette',
    summary:
      'every sound the page loads by default: synth waveforms, noises, ZZFX synths, General MIDI soundfonts, drum machines and sample sets, and how to load more',
  },
  {
    id: 'theory',
    file: 'theory.md',
    title: 'Music theory in Strudel',
    summary:
      'notes and octaves, intervals, scales and modes, chords, voicings and inversions, rhythm and meter, swing, polyrhythm, dynamics, articulation and arpeggios',
  },
  {
    id: 'transitions',
    file: 'transitions.md',
    title: 'Transitions',
    summary:
      'how one change can unfold over several cycles and keep running across later changes with .timeline(id): sweeps, fades, parts that enter later, sections and crossfades',
  },
  {
    id: 'structure',
    file: 'structure.md',
    title: 'Song structure',
    summary:
      'the song declaration at the top of a piece: sections and lengths, a variation or a rest per track and section, nested groups, harmony per piece and per section, and the play() helper',
  },
  {
    id: 'midi',
    file: 'midi.md',
    title: 'MIDI output',
    summary:
      'sending a track to a MIDI port with .midi(): port names, channels, notes, control and program changes, the MIDI clock Moontide sends, and what Stop sends',
  },
] as const satisfies readonly ReferenceTopic[];

export type ReferenceTopicId = (typeof REFERENCE_TOPICS)[number]['id'];

export const REFERENCE_TOPIC_IDS: readonly ReferenceTopicId[] = REFERENCE_TOPICS.map((topic) => topic.id);

/** Module-relative, not cwd-relative (works wherever npm installs the package). */
export function referenceDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reference');
}

export function referenceUnavailableMessage(file: string, reason: string): string {
  return `Strudel reference unavailable: could not read reference/${file} (${reason}). The music tools still work.`;
}

/**
 * Reads a bundled reference topic file. The file name only ever comes from REFERENCE_TOPICS,
 * never from the input — `topic` is validated as a z.enum by the caller, and an id absent
 * from the table (defense in depth) throws rather than reading anything.
 */
export function readReferenceTopic(topic: ReferenceTopicId, dir: string = referenceDir()): string {
  const entry = REFERENCE_TOPICS.find((candidate) => candidate.id === topic);
  if (!entry) {
    throw new Error(`Unknown reference topic: ${topic}`);
  }
  try {
    return readFileSync(path.join(dir, entry.file), 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(referenceUnavailableMessage(entry.file, reason));
  }
}

export function referenceIndexText(): string {
  const lines = [
    `Strudel reference for @strudel/repl ${STRUDEL_REPL_VERSION}, the version the Moontide page loads. Facts only: what exists and how to write it.`,
    'Call get_strudel_reference with one of these topics:',
    ...REFERENCE_TOPICS.map((topic) => `- ${topic.id}: ${topic.summary}`),
  ];
  return lines.join('\n');
}

export function referenceToolDescription(): string {
  const ids = REFERENCE_TOPIC_IDS.join(', ');
  return (
    `Returns the Strudel reference for @strudel/repl ${STRUDEL_REPL_VERSION}, the version the Moontide page loads: ` +
    `facts about what exists and how to write it, not what to choose. Topics: ${ids}. Call it without a topic for ` +
    'the index. Strudel is JavaScript, not TidalCycles: read tidal-differences before writing Strudel from Tidal habits.'
  );
}

const FIRST_JS_BLOCK_RE = /```js\n([\s\S]*?)\n```/;

/**
 * The template get_code shows when nothing plays yet: the body of the first js block of the structure topic, a
 * complete song structure to start a new piece from. The block is read at call time, so the topic and the template
 * cannot drift apart. A missing block, or a block that declares no song, throws: an empty reply would hide the
 * mistake from Claude.
 */
export function structureTemplateText(dir: string = referenceDir()): string {
  const topic = readReferenceTopic('structure', dir);
  const match = FIRST_JS_BLOCK_RE.exec(topic);
  const body = match?.[1];
  if (body === undefined || !/^const song\b/m.test(body)) {
    throw new Error('Moontide: the structure topic has no template block (its first js block must hold const song).');
  }
  return body;
}
