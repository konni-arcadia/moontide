import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as midnam from '../dist/midnam.js';

// The pure MIDNAM reader. Every string here is written for the project with made-up names;
// no line of a real patch file is used anywhere.

const { MidnamError, decodeEntities, tags, readMidnam, midnamSounds } = midnam;

/** A one-device document around `inner`. */
const doc = (inner) => `<MIDINameDocument><MasterDeviceNames>${inner}</MasterDeviceNames></MIDINameDocument>`;
/** One name set holding `banks`. */
const named = (banks) => doc(`<ChannelNameSet Name="Set">${banks}</ChannelNameSet>`);
const bank = (name, commands, patches) =>
  `<PatchBank Name="${name}">${commands}<PatchNameList>${patches}</PatchNameList></PatchBank>`;
const cc = (control, value) => `<ControlChange Control="${control}" Value="${value}"/>`;
const patch = (name, program) => `<Patch Number="1" Name="${name}" ProgramChange="${program}"/>`;

function refuses(run, pattern) {
  assert.throws(run, (err) => {
    assert.ok(err instanceof MidnamError, `expected a MidnamError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });
}

test('tags: the declaration, a DOCTYPE with an internal subset, a comment and a CDATA section are skipped, and only elements are yielded', () => {
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE Root PUBLIC "-//X//Y//EN" "http://example.invalid/x.dtd" [ <!ENTITY e "x"> <!-- it\'s [odd] --> ]>',
    '<!-- a comment with <Patch Name="no"/> in it -->',
    '<Root a="1">',
    '<![CDATA[ <Patch Name="no"/> ]]>',
    '<Item Name="Yes"/>',
    '</Root>',
  ].join('\n');
  const found = [...tags(text)];
  assert.deepEqual(
    found.map((tag) => [tag.name, tag.close, tag.self, tag.line]),
    [
      ['Root', false, false, 4],
      ['Item', false, true, 6],
      ['Root', true, false, 7],
    ],
  );
  assert.equal(found[0].attrs.a, '1');
  assert.equal(found[1].attrs.Name, 'Yes');
});

test('tags: a raw > and = inside a quoted value are part of the value', () => {
  const [arrow, equals] = [...tags('<Patch Name="Line -> Arrow" ProgramChange="1"/><Patch Name="=Edge= Tone"/>')];
  assert.equal(arrow.attrs.Name, 'Line -> Arrow');
  assert.equal(arrow.attrs.ProgramChange, '1');
  assert.equal(equals.attrs.Name, '=Edge= Tone');
});

test('tags: the five named entities and numeric references are decoded, and a lone & is kept', () => {
  const [tag] = [
    ...tags('<P a="Alpha &amp; Beta" b="&lt;x&gt;" c="&quot;q&quot; &apos;s&apos;" d="Caf&#233; &#xE9;" e="Fish & Chips &amp;lt; a&b"/>'),
  ];
  assert.equal(tag.attrs.a, 'Alpha & Beta');
  assert.equal(tag.attrs.b, '<x>');
  assert.equal(tag.attrs.c, '"q" \'s\'');
  assert.equal(tag.attrs.d, 'Café é');
  assert.equal(tag.attrs.e, 'Fish & Chips &lt; a&b');
});

test('tags: a DTD or HTML entity and a bad character reference are refused with the tag, the attribute and the line', () => {
  refuses(() => [...tags('<A/>\n<P a="Caf&eacute; Bass"/>')], /cannot read "&eacute;" in a of <P> at line 2; only &amp; &lt; &gt; &quot; &apos; and numeric references are read/);
  refuses(() => [...tags('<P a="x" b=\'&lol9;\'/>')], /cannot read "&lol9;" in b of <P> at line 1/);
  refuses(() => [...tags('<P a="&constructor; &__proto__;"/>')], /cannot read "&constructor;"/);
  refuses(() => [...tags('<P a="&#0;"/>')], /cannot read "&#0;" in a of <P>/);
  refuses(() => [...tags('<P a="&#xD800;"/>')], /cannot read "&#xD800;"/);
  refuses(() => [...tags('<P a="&#x110000;"/>')], /cannot read "&#x110000;"/);
  // A DOCTYPE entity is never expanded, so its use is refused as well.
  refuses(() => readMidnam('<!DOCTYPE R [ <!ENTITY e "x"> ]>' + named(bank('A', '', patch('&e;', 1)))), /cannot read "&e;" in Name of <Patch> at line 1/);
});

test('decodeEntities decodes once and never recursively, and leaves what it does not know as written', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeEntities('no entity'), 'no entity');
  assert.equal(decodeEntities('&e; &#0; &constructor;'), '&e; &#0; &constructor;');
});

test('tags: single-quoted values read like double-quoted ones', () => {
  const [tag] = [...tags(`<P a='one "two"' b="it's"/>`)];
  assert.equal(tag.attrs.a, 'one "two"');
  assert.equal(tag.attrs.b, "it's");
});

test('tags: a close tag and a self-closing tag are flagged, and CRLF line ends count as one line each', () => {
  const found = [...tags('<A>\r\n<B/>\r\n</A>')];
  assert.deepEqual(
    found.map((tag) => [tag.name, tag.close, tag.self, tag.line]),
    [
      ['A', false, false, 1],
      ['B', false, true, 2],
      ['A', true, false, 3],
    ],
  );
});

test('tags refuses a "<" inside a tag, an unterminated tag and unreadable attributes, each with its line', () => {
  refuses(() => [...tags('<A>\n<B>\n<Patch Name="x" <C/>')], /"<" inside a tag at line 3/);
  refuses(() => [...tags('<A>\n<B>\n<Patch Name="x"')], /unterminated tag at line 3/);
  refuses(() => [...tags('<A>\n<B>\n<Patch Name=x/>')], /cannot read the attributes of <Patch> at line 3/);
  refuses(() => [...tags('<A>\n<Patch Name="x" Name="y"/>')], /duplicate attribute "Name" in <Patch> at line 2/);
});

test('tags refuses an unterminated comment, CDATA section and DOCTYPE', () => {
  refuses(() => [...tags('<A>\n<!-- never closed')], /unterminated comment at line 2/);
  refuses(() => [...tags('<A>\n<![CDATA[ never closed')], /unterminated CDATA section at line 2/);
  refuses(() => [...tags('<!DOCTYPE A [\n<!ENTITY e "x">\n')], /unterminated DOCTYPE at line 1/);
});

test('readMidnam: a root other than MIDINameDocument is refused with its name', () => {
  refuses(() => readMidnam('<Foo><Bar/></Foo>'), /the root element is <Foo>, not <MIDINameDocument>/);
});

test('readMidnam: a close tag that does not match names both lines', () => {
  const text = [
    '<MIDINameDocument>',
    '<MasterDeviceNames>',
    '<ChannelNameSet Name="Set">',
    '<PatchBank Name="A">',
    '<PatchNameList>',
    '<Patch Name="x" ProgramChange="1">',
    '</PatchBank>',
  ].join('\n');
  refuses(() => readMidnam(text), /<\/PatchBank> at line 7 does not close <Patch> \(line 6\)/);
});

test('readMidnam: a bank with CC0 in its MIDICommands and an inline list gives its patches that MSB and no LSB', () => {
  const file = readMidnam(named(bank('Group A', `<MIDICommands>${cc(0, 8)}</MIDICommands>`, patch('One', 1) + patch('Two', 2))));
  assert.equal(file.banks.length, 1);
  assert.equal(file.banks[0].name, 'Group A');
  assert.equal(file.banks[0].channels, null);
  assert.deepEqual(
    file.banks[0].patches.map(({ name, program, msb, lsb }) => ({ name, program, msb, lsb })),
    [
      { name: 'One', program: 1, msb: 8, lsb: null },
      { name: 'Two', program: 2, msb: 8, lsb: null },
    ],
  );
});

test('readMidnam: CC0 and CC32 give both, and a bank with no MIDICommands gives neither', () => {
  const both = readMidnam(named(bank('A', `<MIDICommands>${cc(0, 8)}${cc(32, 3)}</MIDICommands>`, patch('One', 1))));
  assert.deepEqual([both.banks[0].patches[0].msb, both.banks[0].patches[0].lsb], [8, 3]);
  const none = readMidnam(named(bank('A', '', patch('One', 1))));
  assert.deepEqual([none.banks[0].patches[0].msb, none.banks[0].patches[0].lsb], [null, null]);
});

test('readMidnam: the program is the ProgramChange value with leading zeros read as decimal, never the Patch Number label', () => {
  const file = readMidnam(named(bank('A', '', '<Patch Number="999" Name="One" ProgramChange="003"/>')));
  assert.equal(file.banks[0].patches[0].program, 3);
});

test('readMidnam: banks come in file order and patches in list order', () => {
  const file = readMidnam(named(bank('B', '', patch('b1', 9) + patch('b2', 1)) + bank('A', '', patch('a1', 5))));
  assert.deepEqual(
    file.banks.map((entry) => [entry.name, entry.patches.map((one) => one.name)]),
    [
      ['B', ['b1', 'b2']],
      ['A', ['a1']],
    ],
  );
});

test('readMidnam: a file with no patch under a PatchBank is refused', () => {
  refuses(() => readMidnam(named('<PatchBank Name="Empty"><PatchNameList/></PatchBank>')), /no patch found under a PatchBank/);
  refuses(() => readMidnam('<MIDINameDocument/>'), /no patch found under a PatchBank/);
});

// Form A: the bank select and the program sit in the commands of each patch.

const slim = (patches) => patches.map(({ name, program, msb, lsb }) => ({ name, program, msb, lsb }));
const commands = (...inner) => `<PatchMIDICommands>${inner.join('')}</PatchMIDICommands>`;
const pc = (number) => `<ProgramChange Number="${number}"/>`;

test('form A: a patch with PatchMIDICommands holding CC0 and a ProgramChange reads that MSB and program', () => {
  const file = readMidnam(named(bank('A', '', `<Patch Number="9" Name="One">${commands(cc(0, 16), pc(5))}</Patch>`)));
  assert.deepEqual(slim(file.banks[0].patches), [{ name: 'One', program: 5, msb: 16, lsb: null }]);
});

test('form A: a patch-level control overrides the bank-level one for that patch only, and the other control is kept', () => {
  const file = readMidnam(
    named(
      bank(
        'A',
        `<MIDICommands>${cc(0, 12)}${cc(32, 1)}</MIDICommands>`,
        `<Patch Name="Own">${commands(cc(0, 16), cc(32, 2), pc(5))}</Patch><Patch Name="Inherits">${commands(pc(6))}</Patch><Patch Name="Half">${commands(cc(0, 3), pc(7))}</Patch>`,
      ),
    ),
  );
  assert.deepEqual(slim(file.banks[0].patches), [
    { name: 'Own', program: 5, msb: 16, lsb: 2 },
    { name: 'Inherits', program: 6, msb: 12, lsb: 1 },
    { name: 'Half', program: 7, msb: 3, lsb: 1 },
  ]);
});

test('form A: an attribute and a command that agree are fine, and ones that differ are refused with the patch and its line', () => {
  const agree = readMidnam(named(bank('A', '', `<Patch Name="One" ProgramChange="003">${commands(pc(3))}</Patch>`)));
  assert.equal(agree.banks[0].patches[0].program, 3);
  refuses(
    () => readMidnam(named(bank('A', '', `<Patch Name="One" ProgramChange="3">${commands(pc(4))}</Patch>`))),
    /patch "One" \(line 1\): ProgramChange attribute 3 and command 4 differ/,
  );
});

// Form C: the bank names a list that the file defines later.

test('form C: a bank takes the patches of a list defined after the banks, with its own MSB, in its place in the file order', () => {
  const file = readMidnam(
    doc(
      `<ChannelNameSet Name="Set">` +
        bank('First', `<MIDICommands>${cc(0, 1)}</MIDICommands>`, patch('f1', 1)) +
        `<PatchBank Name="Shared"><MIDICommands>${cc(0, 24)}</MIDICommands><UsesPatchNameList Name="Later"/></PatchBank>` +
        bank('Last', `<MIDICommands>${cc(0, 2)}</MIDICommands>`, patch('l1', 3)) +
        `</ChannelNameSet><PatchNameList Name="Later">${patch('s1', 10)}${patch('s2', 11)}</PatchNameList>`,
    ),
  );
  assert.deepEqual(
    file.banks.map((entry) => [entry.name, slim(entry.patches)]),
    [
      ['First', [{ name: 'f1', program: 1, msb: 1, lsb: null }]],
      [
        'Shared',
        [
          { name: 's1', program: 10, msb: 24, lsb: null },
          { name: 's2', program: 11, msb: 24, lsb: null },
        ],
      ],
      ['Last', [{ name: 'l1', program: 3, msb: 2, lsb: null }]],
    ],
  );
});

test('form C: banks sharing one list are capped before the copies are made, and a big list is no stack overflow', () => {
  const sharing = (banks, patches) =>
    doc(
      `<ChannelNameSet Name="Set">${'<PatchBank Name="B"><UsesPatchNameList Name="L"/></PatchBank>'.repeat(banks)}</ChannelNameSet>` +
        `<PatchNameList Name="L">${patch('p', 1).repeat(patches)}</PatchNameList>`,
    );
  // 3000 banks of 50 patches would be 150000 copies: refused, with a MidnamError, not an out-of-memory crash.
  refuses(() => readMidnam(sharing(3000, 50)), /more than 100000 patches once the lists its banks use are counted \(bank "B", line 1\)/);
  // One list of 150000 patches: a MidnamError, not a RangeError from a spread.
  refuses(() => readMidnam(sharing(1, 150000)), /more than 100000 patches/);
  // At the cap the copy works (a loop, not a spread of 100000 arguments).
  const [only] = readMidnam(sharing(1, 100000)).banks;
  assert.equal(only.patches.length, 100000);
  // Inline patches count too.
  refuses(() => readMidnam(named(bank('Big', '', patch('p', 1).repeat(100001)))), /more than 100000 patches/);
});

test('form C: a list name that the file does not define is refused with the bank and the list', () => {
  refuses(
    () => readMidnam(named(`<PatchBank Name="Shared"><UsesPatchNameList Name="Nowhere"/></PatchBank>${bank('B', '', patch('b', 1))}`)),
    /bank "Shared" \(line 1\) uses the patch list "Nowhere", which the file does not define/,
  );
});

// Files that hold no bank of their own, and commands that are not banks.

test('a file that only extends another device is refused as such', () => {
  const text =
    '<MIDINameDocument><ExtendingDeviceNames><Manufacturer>M</Manufacturer><Model>X</Model>' +
    `<PatchNameList>${patch('a', 1)}</PatchNameList></ExtendingDeviceNames></MIDINameDocument>`;
  refuses(() => readMidnam(text), /the file only extends another device's names \(ExtendingDeviceNames\) and holds no patch bank of its own/);
});

test('patches under two MasterDeviceNames are refused with both lines', () => {
  const one = `<MasterDeviceNames><ChannelNameSet Name="S">${bank('A', '', patch('a', 1))}</ChannelNameSet></MasterDeviceNames>`;
  refuses(() => readMidnam(`<MIDINameDocument>\n${one}\n${one}\n</MIDINameDocument>`), /patches under more than one MasterDeviceNames \(lines 2 and 3\)/);
});

test('ControlChange and ProgramChange outside a bank and a patch are device commands and ignored', () => {
  const file = readMidnam(
    doc(
      `<DeviceModeEnable>${cc(120, 1)}${pc(999)}</DeviceModeEnable>` +
        `<ChannelNameSet Name="S"><MIDICommands>${cc(0, 99)}${cc(120, 5)}</MIDICommands>${bank('A', '', patch('a', 1))}</ChannelNameSet>`,
    ),
  );
  assert.deepEqual(slim(file.banks[0].patches), [{ name: 'a', program: 1, msb: null, lsb: null }]);
});

// Values: each refusal names the value, the bank and the patch.

test('a program above 127 or not a whole number is refused with the patch, the bank and the line', () => {
  refuses(() => readMidnam(named(bank('Group', '', patch('Tone', 128)))), /program 128 of patch "Tone" in bank "Group" \(line 1\) is not between 0 and 127/);
  refuses(() => readMidnam(named(bank('Group', '', patch('Tone', 'x')))), /program "x" of patch "Tone" in bank "Group" \(line 1\) is not a whole number/);
  refuses(() => readMidnam(named(bank('Group', '', patch('Tone', '-1')))), /is not a whole number/);
});

test('a control value outside 0-127 is refused in a bank and in a patch', () => {
  refuses(
    () => readMidnam(named(bank('Group', `<MIDICommands>${cc(0, 200)}</MIDICommands>`, patch('Tone', 1)))),
    /value 200 of ControlChange 0 in bank "Group" \(line 1\) is not between 0 and 127/,
  );
  refuses(
    () => readMidnam(named(bank('Group', '', `<Patch Name="Tone">${commands(cc(32, 200), pc(1))}</Patch>`))),
    /value 200 of ControlChange 32 of patch "Tone" in bank "Group" \(line 1\) is not between 0 and 127/,
  );
});

test('a ControlChange other than 0 and 32 in a bank or a patch is not a bank select', () => {
  refuses(
    () => readMidnam(named(bank('Group', `<MIDICommands>${cc(120, 0)}</MIDICommands>`, patch('Tone', 1)))),
    /ControlChange 120 in bank "Group" \(line 1\) is not a bank select \(only 0 and 32 are read\)/,
  );
  refuses(
    () => readMidnam(named(bank('Group', '', `<Patch Name="Tone">${commands(cc(7, 0), pc(1))}</Patch>`))),
    /ControlChange 7 in patch "Tone" \(line 1\) is not a bank select \(only 0 and 32 are read\)/,
  );
});

test('a patch with no program is refused', () => {
  refuses(() => readMidnam(named(bank('Group', '', '<Patch Number="1" Name="Tone"/>'))), /patch "Tone" \(line 1\) has no program/);
});

// The cleaning into catalog sounds.

const model = (extra = {}) => ({
  id: 'm',
  name: 'Model',
  channels: { melodic: [1, 2], rhythm: [10] },
  bankSelect: 'msb',
  defaultVolume: 100,
  controls: [],
  sounds: { melodic: [], rhythm: [] },
  notes: [],
  ...extra,
});
const mountedAt = (patches, extra = {}) => ({ name: 'Group', line: 1, channels: null, patches, ...extra });
const raw = (name, program, msb = null, lsb = null, line = 1) => ({ name, program, msb, lsb, line });
const sounds = (banks, withModel = model()) => midnamSounds({ banks }, withModel);

test('names: tabs, newlines and &#10; collapse to one space and are trimmed; another control character is refused', () => {
  const read = readMidnam(named(bank('Group', '', '<Patch Name="  Tone&#10;\tOne  " ProgramChange="1"/>')));
  assert.equal(midnamSounds(read, model()).sounds[0].name, 'Tone One');
  refuses(() => sounds([mountedAt([raw('Tone\u0007One', 1)])]), /patch at line 1 has a control character in its name/);
  refuses(() => sounds([mountedAt([raw('Tone', 1)], { name: 'Gro\u0000up' })]), /bank at line 1 has a control character in its name/);
});

test('an empty name is skipped and counted as without a name, and a bank with no name gives no category', () => {
  const result = sounds([mountedAt([raw('  ', 1), raw('Tone', 2)], { name: ' ' })]);
  assert.deepEqual(result.sounds, [{ name: 'Tone', program: 2 }]);
  assert.equal(result.counts.unnamed, 1);
});

test('rhythm: a name set available only on the rhythm channels of the model is skipped and counted', () => {
  const melodic = mountedAt([raw('Tone', 1)], { name: 'Melodic', channels: [1, 2] });
  const unsaid = mountedAt([raw('Free', 2)], { name: 'Unsaid', channels: null });
  const kits = mountedAt([raw('Kit One', 0), raw('Kit Two', 1)], { name: 'Kits', channels: [10] });
  const result = sounds([melodic, unsaid, kits]);
  assert.deepEqual(
    result.sounds.map((sound) => sound.name),
    ['Tone', 'Free'],
  );
  assert.equal(result.counts.rhythm, 2);
  assert.equal(result.banks, 2);
  const without = sounds([kits], model({ channels: { melodic: [1, 2, 10], rhythm: [] } }));
  assert.deepEqual(
    without.sounds.map((sound) => sound.name),
    ['Kit One', 'Kit Two'],
  );
  assert.equal(without.counts.rhythm, 0);
});

test('a file whose sounds are all for rhythm channels, or all without a name, leaves nothing and says why', () => {
  refuses(
    () => sounds([mountedAt([raw('Kit One', 0), raw('Kit Two', 1)], { channels: [10] })]),
    /no melodic sound left: 2 sounds are in name sets for rhythm channels only/,
  );
  refuses(() => sounds([mountedAt([raw('', 0), raw(' ', 1)])]), /no named patch/);
});

test('duplicates: one name at two addresses is renamed with each address, and both are counted', () => {
  const result = sounds([mountedAt([raw('Tone One', 4, 0)]), mountedAt([raw('Tone One', 0, 8)], { name: 'Other' })]);
  assert.deepEqual(
    result.sounds.map((sound) => [sound.name, sound.category]),
    [
      ['Tone One (bank 0, program 4)', 'Group'],
      ['Tone One (bank 8, program 0)', 'Other'],
    ],
  );
  assert.equal(result.counts.renamed, 2);
  assert.equal(result.counts.merged, 0);
});

test('duplicates: the same name at the same address is kept once and counted as merged', () => {
  const result = sounds([mountedAt([raw('Tone One', 4, 8), raw('tone  one', 4, 8), raw('Other', 5, 8)])]);
  assert.deepEqual(
    result.sounds.map((sound) => sound.name),
    ['Tone One', 'Other'],
  );
  assert.equal(result.counts.merged, 1);
  assert.equal(result.counts.renamed, 0);
});

test('duplicates: the suffix follows the bank select of the model, and a missing MSB or LSB counts as 0', () => {
  const two = [mountedAt([raw('Tone One', 4, null, 7)]), mountedAt([raw('Tone One', 0, 8, 1)])];
  assert.deepEqual(
    sounds(two, model({ bankSelect: 'msb-lsb' })).sounds.map((sound) => sound.name),
    ['Tone One (bank 0/7, program 4)', 'Tone One (bank 8/1, program 0)'],
  );
  const plain = [mountedAt([raw('Tone One', 4)]), mountedAt([raw('Tone One', 5)])];
  assert.deepEqual(
    sounds(plain, model({ bankSelect: 'none' })).sounds.map((sound) => sound.name),
    ['Tone One (program 4)', 'Tone One (program 5)'],
  );
});

test('duplicates: a name the model already has is skipped at the same address and renamed at another', () => {
  const own = model({ sounds: { melodic: [{ name: 'Tone One', program: 4 }], rhythm: [] } });
  const same = sounds([mountedAt([raw('tone one', 4), raw('Other', 9)])], own);
  assert.deepEqual(
    same.sounds.map((sound) => sound.name),
    ['Other'],
  );
  assert.equal(same.counts.inModel, 1);
  const elsewhere = sounds([mountedAt([raw('Tone One', 4, 8)])], own);
  assert.deepEqual(
    elsewhere.sounds.map((sound) => sound.name),
    ['Tone One (bank 8, program 4)'],
  );
  assert.equal(elsewhere.counts.renamed, 1);
  refuses(() => sounds([mountedAt([raw('Tone One', 4)])], own), /no sound left: every named patch is already a sound of the model/);
});

test('duplicates: a long name is cut so the name with its suffix has 80 characters', () => {
  const long = 'n'.repeat(78);
  const names = sounds([mountedAt([raw(long, 4, 0), raw(long, 5, 0)])]).sounds.map((sound) => sound.name);
  assert.deepEqual(
    names.map((name) => name.length),
    [80, 80],
  );
  assert.equal(names[0], `${'n'.repeat(60)} (bank 0, program 4)`);
  assert.equal(names[1], `${'n'.repeat(60)} (bank 0, program 5)`);
});

test('banks: the sound carries no bank, the MSB, or the MSB with the LSB as the file gives it, and an LSB alone is written with MSB 0 and counted', () => {
  const none = sounds([mountedAt([raw('A', 1)])]);
  assert.equal('bank' in none.sounds[0], false);
  const msb = sounds([mountedAt([raw('A', 1, 8)])]);
  assert.deepEqual(msb.sounds[0].bank, { msb: 8 });
  const both = sounds([mountedAt([raw('A', 1, 8, 3)])], model({ bankSelect: 'msb-lsb' }));
  assert.deepEqual(both.sounds[0].bank, { msb: 8, lsb: 3 });
  const lsbOnly = sounds([mountedAt([raw('A', 1, null, 3), raw('B', 2, null, 3)]), mountedAt([raw('C', 1, 5)], { name: 'Other' })], model({ bankSelect: 'msb-lsb' }));
  assert.deepEqual(lsbOnly.sounds.map((sound) => sound.bank), [{ msb: 0, lsb: 3 }, { msb: 0, lsb: 3 }, { msb: 5 }]);
  assert.equal(lsbOnly.counts.lsbOnly, 1, 'one bank, not two sounds');
});

test('ordering: the sounds keep the bank order and each bank its patch order', () => {
  const result = sounds([mountedAt([raw('z', 9), raw('a', 1)], { name: 'Second' }), mountedAt([raw('m', 5)], { name: 'First' })]);
  assert.deepEqual(
    result.sounds.map((sound) => `${sound.category}/${sound.name}`),
    ['Second/z', 'Second/a', 'First/m'],
  );
});

test('encoding: a declaration other than UTF-8 is refused, UTF-8 in any case and a leading BOM are read, and CRLF line ends count right', () => {
  const body = named(bank('A', '', patch('One', 1)));
  refuses(() => readMidnam(`<?xml version="1.0" encoding="ISO-8859-1"?>${body}`), /the file declares the encoding "ISO-8859-1"; only UTF-8 is read/);
  assert.equal(readMidnam(`﻿<?xml version='1.0' encoding='utf-8'?>${body}`).banks.length, 1);
  refuses(() => readMidnam(`<MIDINameDocument>\r\n<MasterDeviceNames>\r\n<Patch Name="x"`), /unterminated tag at line 3/);
});

test('a document nested too deep, never closed, or with a second root is refused', () => {
  refuses(() => readMidnam(`<MIDINameDocument>${'<A>'.repeat(200)}`), /nested more than 100 levels deep/);
  refuses(() => readMidnam('<MIDINameDocument><MasterDeviceNames>'), /<MasterDeviceNames> at line 1 is never closed/);
  refuses(() => readMidnam('<MIDINameDocument/><Other/>'), /<Other> at line 1 is a second root element/);
});

// A model whose rhythm channels take a bank keeps the name sets of its rhythm channels as drum kits.

const bankDrums = () => ({
  id: 'bankdrums',
  name: 'Bank Drum Synth',
  channels: { melodic: [1, 2, 3, 4], rhythm: [5] },
  bankSelect: 'msb-lsb',
  rhythmBank: true,
  defaultVolume: 100,
  controls: [],
  drumMap: 'general-midi',
  sounds: {
    melodic: [{ name: 'Tone One', program: 0, bank: { msb: 1, lsb: 2 } }],
    rhythm: [
      { name: 'Kit A', program: 0, bank: { msb: 86, lsb: 64 } },
      { name: 'Kit C', program: 3, bank: { msb: 86, lsb: 65 }, noteMap: null },
    ],
  },
  notes: [],
});
const kitBank = (patches, extra = {}) => mountedAt(patches, { name: 'Drum Group', channels: [5], ...extra });

test('kits: for a model whose rhythm channels take a bank, the rhythm name sets become kits with the bank name as category', () => {
  const melodic = mountedAt([raw('Tone Two', 1, 3, 4)], { name: 'Melodic', channels: [1, 2] });
  const result = sounds([melodic, kitBank([raw('Pdf Kit One', 7, 86, 66), raw('Pdf Kit Two', 8, 86)])], bankDrums());
  assert.deepEqual(result.sounds, [{ name: 'Tone Two', category: 'Melodic', program: 1, bank: { msb: 3, lsb: 4 } }]);
  assert.deepEqual(result.kits, [
    { name: 'Pdf Kit One', category: 'Drum Group', program: 7, bank: { msb: 86, lsb: 66 } },
    { name: 'Pdf Kit Two', category: 'Drum Group', program: 8, bank: { msb: 86 } },
  ]);
  assert.equal(result.counts.rhythm, 0);
  assert.equal(result.banks, 2);
  const only = sounds([kitBank([raw('Pdf Kit One', 7, 86, 66)])], bankDrums());
  assert.deepEqual(only.sounds, []);
  assert.equal(only.kits.length, 1);
  assert.equal(only.banks, 1);
});

test('kits: the same name at the same address is kept once, a kit of the model at its address is skipped, another address renames it', () => {
  const result = sounds(
    [kitBank([raw('Pdf Kit One', 7, 86, 66), raw('Pdf Kit One', 7, 86, 66), raw('Kit C', 3, 86, 65), raw('Kit A', 0, 86, 70)])],
    bankDrums(),
  );
  assert.deepEqual(
    result.kits.map((one) => one.name),
    ['Pdf Kit One', 'Kit A (bank 86/70, program 0)'],
  );
  assert.equal(result.counts.merged, 1);
  assert.equal(result.counts.inModel, 1);
  assert.equal(result.counts.renamed, 1);
  const twice = sounds([kitBank([raw('Pdf Kit One', 7, 86, 66), raw('Pdf Kit One', 8, 86, 66)])], bankDrums());
  assert.deepEqual(
    twice.kits.map((one) => one.name),
    ['Pdf Kit One (bank 86/66, program 7)', 'Pdf Kit One (bank 86/66, program 8)'],
  );
});

test('kits: a kit patch with no bank select is refused naming the patch, and nothing is left when every kit is in the model', () => {
  refuses(
    () => sounds([kitBank([raw('Bare Kit', 2, null, null, 12)])], bankDrums()),
    /patch at line 12 \("Bare Kit"\) serves rhythm channels only and model bankdrums chooses its kits by bank select, but the file gives it no bank/,
  );
  refuses(() => sounds([kitBank([raw('Kit C', 3, 86, 65)])], bankDrums()), /no sound left: every named patch is already a sound of the model/);
  refuses(() => sounds([kitBank([raw('', 3, 86, 65)])], bankDrums()), /no named patch/);
});

test('kits: a model without rhythmBank returns no kits, whatever the file holds', () => {
  const result = sounds([mountedAt([raw('Tone', 1)], { name: 'Melodic', channels: [1] }), mountedAt([raw('Kit One', 0, 86, 64)], { channels: [10] })]);
  assert.deepEqual(result.kits, []);
  assert.equal(result.counts.rhythm, 1);
});
