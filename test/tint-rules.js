// Shared no-tint word lists and text helpers for test/reference.test.js. Not a
// test file itself — plain JS exports, imported by reference.test.js and scripts/check-reference.mjs.
//
// Reference text and tool descriptions must carry facts and behavior only, never
// mood vocabulary, style associations or taste. Scale, chord and sound names that happen to
// contain one of these words (e.g. a "sad" chord voicing label) are API facts, not taste, so
// they live in ```names blocks, which findWords callers exclude via stripNamesBlocks.

// Mood words: emotional/atmosphere vocabulary, forbidden outside ```names blocks.
const MOOD_WORDS = [
  'dreamy',
  'melancholic',
  'melancholy',
  'sad',
  'sadness',
  'happy',
  'joyful',
  'uplifting',
  'epic',
  'chill',
  'chilled',
  'cozy',
  'cosy',
  'spooky',
  'eerie',
  'haunting',
  'romantic',
  'nostalgic',
  'nostalgia',
  'peaceful',
  'calm',
  'relaxing',
  'soothing',
  'energetic',
  'mysterious',
  'ethereal',
  'lush',
  'moody',
  'mood',
  'moods',
  'dark',
  'darker',
  'bright',
  'brighter',
  'warm',
  'warmth',
  'cold',
  'rain',
  'rainy',
  'emotional',
  'emotion',
  'mellow',
  'gloomy',
  'serene',
  'playful',
  'magical',
  'majestic',
  'heroic',
  'triumphant',
];

// Genre and style words: forbidden associations with a named genre, scene or region.
const GENRE_WORDS = [
  'jrpg',
  'rpg',
  'anime',
  'lofi',
  'lo-fi',
  'ambient',
  'cinematic',
  'orchestral',
  'techno',
  'trance',
  'dubstep',
  'jazz',
  'jazzy',
  'funky',
  'disco',
  'hip-hop',
  'hiphop',
  'synthwave',
  'vaporwave',
  'chiptune',
  'soundtrack',
  'video game',
  'spanish',
  'oriental',
  'exotic',
  'celtic',
  'medieval',
];

// Taste judgments: forbidden recommendations or preferences.
const TASTE_WORDS = [
  'beautiful',
  'nice',
  'pleasant',
  'lovely',
  'best',
  'recommended',
  'prefer',
  'preferred',
  'tasteful',
];

/** Applied to every Claude-facing text outside ```names blocks. */
export const TINT_WORDS = [...MOOD_WORDS, ...GENRE_WORDS, ...TASTE_WORDS];

/** Applied to instructions and tool descriptions: no variety rule. */
export const STEERING_WORDS = [
  'vary',
  'varied',
  'variety',
  'avoid repeating',
  'repetitive',
  'fresh',
  'novel',
  'unusual',
  'unexpected',
  'surprising',
  'something new',
  'move away',
  'different from',
  'creative',
  'interesting',
];

/**
 * Basic waveforms, noises and the default drum abbreviations: the only sounds a bare demo
 * may name. Everything else in the palette is listed in the sounds topic but never
 * used in a demo.
 */
export const ALLOWED_DEMO_SOUNDS = [
  'sine',
  'square',
  'triangle',
  'sawtooth',
  'supersaw',
  'pulse',
  'white',
  'pink',
  'brown',
  'bd',
  'sd',
  'hh',
  'oh',
  'cp',
  'rim',
  'cb',
  'cr',
  'rd',
  'ht',
  'mt',
  'lt',
  'sh',
  'tb',
  'perc',
  'misc',
  'fx',
  'brk',
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive search for any of `words` in `text`. Multi-word entries (e.g.
 * "video game") match across any run of whitespace. Returns the matched entries, in the order
 * they were found in `words` (not de-duplicated by design: callers only check emptiness).
 */
export function findWords(text, words) {
  const found = [];
  for (const word of words) {
    const pattern = escapeRegExp(word).replace(/ /g, '\\s+');
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(text)) found.push(word);
  }
  return found;
}

const FENCE_RE = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g;

/** Bodies of fenced code blocks tagged `tag` (e.g. ```js), in document order. */
export function fencedBlocks(markdown, tag) {
  const bodies = [];
  const re = new RegExp(FENCE_RE);
  let match;
  while ((match = re.exec(markdown))) {
    if (match[1] === tag) {
      bodies.push(match[2].replace(/\n$/, ''));
    }
  }
  return bodies;
}

/** Removes only ```names fenced blocks (their content is API facts, not taste). */
export function stripNamesBlocks(markdown) {
  return markdown.replace(/```names\n[\s\S]*?```\n?/g, '');
}

/** Every fence's tag, in document order; '' for an untagged fence. */
export function fenceTags(markdown) {
  const tags = [];
  const re = new RegExp(FENCE_RE);
  let match;
  while ((match = re.exec(markdown))) {
    tags.push(match[1]);
  }
  return tags;
}

// Matches a string argument of a bare or dotted s(/sound( call: an optional leading dot, the
// call name, then a quoted string. The leading \b (with the optional dot consuming any
// preceding non-word character) keeps this from matching inside a longer name like "resound(".
const SOUND_ARG_RE = /(\.)?\b(?:s|sound)\(\s*(["'`])((?:(?!\2)[^\\])*?)\2/g;

/**
 * Tokens of every string argument of s(, sound(, .s( and .sound( in a ```js block body, split
 * on mini-notation symbols and whitespace, with plain numbers dropped.
 */
export function demoSoundTokens(jsBlock) {
  const tokens = [];
  const re = new RegExp(SOUND_ARG_RE);
  let match;
  while ((match = re.exec(jsBlock))) {
    const content = match[3];
    for (const token of content.split(/[^a-zA-Z0-9]+/)) {
      if (token === '' || /^\d+$/.test(token)) continue;
      tokens.push(token);
    }
  }
  return tokens;
}
