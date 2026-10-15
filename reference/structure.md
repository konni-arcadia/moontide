# Song structure

Applies to @strudel/repl 1.3.0, the version the Moontide page loads (it bundles @strudel/core 1.2.6, @strudel/mini 1.2.6, @strudel/tonal 1.2.6, @strudel/transpiler 1.2.6, @strudel/webaudio 1.3.0 and @strudel/soundfonts 1.3.0).

How a piece declares its song structure: one `const song` at the top that names the sections and their lengths and says, for every track in every section, which variation plays or that the track rests, followed by a few helper lines that turn the declaration into music. The page reads the declaration from the text of the code and shows it in the Parts view; nothing is added to the code by the page, and the same code plays in plain Strudel.

## The template

```js
const harmony = 'C3:major';
const song = {
  shift: 0,
  sections: [['sectionA', 6]],
  plan: { sectionA: { trackA: 'variationA' } },
  groups: {},
};
const total = song.sections.reduce((a, [, n]) => a + n, 0);
const clock = timeCat(...song.sections.map(([name, n]) => [n, pure(name)])).slow(total).late(song.shift);
const play = (track, variations) => {
  const cells = {};
  for (const [name, , own] of song.sections) {
    const key = (song.plan[name] || {})[track];
    if (key === undefined) throw new Error('song: section ' + name + ' has no cell for track ' + track);
    const v = key === '-' ? silence : variations[key];
    if (v === undefined) throw new Error('song: section ' + name + ', track ' + track + ': no variation ' + key + ' (it has ' + Object.keys(variations).join(', ') + ')');
    cells[name] = typeof v === 'function' ? v(own || harmony) : Array.isArray(v) ? v[1] : v;
  }
  return clock.pickRestart(cells);
};
const trackA = {
  variationA: (h) => n("0 2 4").scale(h),
};
trackA: play('trackA', trackA);
```

The block above is a complete piece with one section and one track, and it plays as it stands. The names and the length in it are placeholders.

## The declaration

- `song.shift` is a number of cycles that moves every section start later; 0 means no shift.
- `song.sections` lists the sections in playing order. Each entry is `['name', length]`, with a whole length above zero written out as a number; a third entry, as in `['name', length, 'E3:minor']`, gives that section its own harmony. A section name can come round again later in the list.
- `song.plan` is keyed by section name, then by track name. Each cell is the name of one of that track's variations, or `'-'` for a rest. Every track has a cell in every section.
- `song.groups` is data: an object of named groups, each a list of track names or an object of groups, nested to any depth. A group changes nothing in what plays; a track can sit in one group only.

A structure with one section is valid, as the template shows. There is no limit on the number of sections, tracks, variations or group depth, and a track can rest in any section.

There is no default form. How many sections and tracks a piece has, what they are called and how long each section lasts come from the music asked for, and can differ from one piece to the next.

Write section names, track names and harmonies in single quotes inside the song declaration: a double-quoted string is a mini-notation pattern and the clock then fails with a message about `late`. The helper's messages are joined with `+`, because a template literal is a mini-notation pattern in the page too (see the tidal-differences topic).

## The helper

The helper lines of the template are written as they are, with the declaration above them and the tracks below. The page recognises the text and says when it was changed or is missing; it never rewrites it.

The helper plays each track's variation for the section the clock names, starts it at its first cycle, and throws, naming the section and the track, for a missing cell or an unknown variation.

A section plays each track's variation from its first cycle every time the section comes round, also when the same name is used twice.

A cell that names no variation is refused when the code is evaluated, with the section and the track named. Without that check a wrong name would play one stray default tone per cycle and report nothing, so a mistake in the last section would go unseen.

## Tracks and variations

One const per track holds only that track's variations: an object from a variation name to a variation. The track's statement is `name: play('name', name)`, with the same name as its label and as the first argument of the call.

A variation is one of three kinds:

- a pattern, played as it is;
- a function that receives the section's harmony and returns a pattern;
- a two-element array, a harmony it was written for and then a pattern: a fixed variation, played as written whatever the section's harmony is.

Write each variation out where it is listed, as a call, a function or a pair. A variation given as a bare name or another expression is refused by the page, because the text does not say whether it is a pattern, a function or a pair.

Put `.postgain(n)` and `.midi('port')` at the end of the track's own statement, not inside its variations, which is where the Mixer reads and writes them. A fixed `.gain(n)` on the statement makes the Mixer's fader write the gain instead of the post-gain. A track's `.midi()` options are sent once when the code is evaluated, not at a section change (see the midi topic).

## Harmony

A section's harmony is its third entry; without one, the harmony is the piece's own `const harmony` line (see the theory topic). Both are single-quoted text, a scale such as `'E3:minor'` or chord symbols such as `'Am'`.

A variation in degrees is written as a function of the section's harmony, `(h) => n("0 2 4").scale(h)`; do not read a global harmony pattern inside a variation. A variation starts over at the first cycle of its section, so a global pattern read inside it starts over too and gives every section after the first the scale of the first one. A chord harmony works the same way: `(h) => chord(h).voicing()` receives the chord of its section.

To move a pattern of degrees up, add `n(k)`, not the bare number `k`. A bare number changes nothing in a pattern of degrees.

A note held across a section line is cut at the line and is not struck again; the next section's first note starts at the line, in its own harmony.

## Changing a structure

Changing a length, or adding or removing a section, counts the position again from the new lengths, so the music can move to another section. An older piece without a structure keeps its form when only part of it changes: a small change is made in place.

## Two more shapes

Another shape, with two sections, the second with its own harmony, and three tracks. It holds a rest, the three kinds of variation, and groups nested one level:

```js
// (the helper lines of the first block go here)
const harmony = 'D3:dorian';
const song = {
  shift: 2,
  sections: [['partOne', 10], ['partTwo', 6, 'A2:minor']],
  plan: {
    partOne: { trackB: 'plain', trackC: 'follow', trackD: '-' },
    partTwo: { trackB: 'plain', trackC: 'follow', trackD: 'fixed' },
  },
  groups: { lower: ['trackB'], upper: { inner: ['trackC', 'trackD'] } },
};
const trackB = { plain: note("c3 e3 g3") };
const trackC = { follow: (h) => n("0 2 4 6").scale(h) };
const trackD = { fixed: ['D3:dorian', note("d4 f4 a4")] };
trackB: play('trackB', trackB);
trackC: play('trackC', trackC);
trackD: play('trackD', trackD);
```

A third shape, with three entries in the section list, one name coming round again, a chord harmony and a track level set on the statement:

```js
// (the helper lines of the first block go here)
const harmony = 'Am';
const song = {
  shift: 0,
  sections: [['first', 12], ['second', 9], ['first', 12]],
  plan: {
    first: { trackE: 'low', trackF: 'follow' },
    second: { trackE: 'high', trackF: '-' },
  },
  groups: { both: ['trackE', 'trackF'] },
};
const trackE = { low: note("c3 g3"), high: note("c4 g4 e4") };
const trackF = { follow: (h) => chord(h).voicing() };
trackE: play('trackE', trackE);
trackF: play('trackF', trackF).postgain(0.6);
```
