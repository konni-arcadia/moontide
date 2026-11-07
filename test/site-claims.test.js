import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIMIT_EXEMPTIONS,
  NOT_A_STRUDEL_CALL,
  NOT_A_TOOL,
  PARTIAL_TOOL_LIST,
  checkFile,
  claimFiles,
  describe,
  loadFacts,
  pinnedRows,
  readUnits,
  realConstants,
  unusedImages,
} from './site-claims.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const facts = await loadFacts(root);
const constants = await realConstants(root);
const rows = pinnedRows(constants);
const files = claimFiles(root);

const findingsOf = (text, theRows = rows) => checkFile('fixture.md', text, facts, theRows);
const rulesOf = (text) => [...new Set(findingsOf(text).map((f) => f.rule))];

function realFindings(theRows) {
  return files.flatMap(({ file, text }) => checkFile(file, text, facts, theRows));
}

test('the facts come from the running server and the code', () => {
  assert.ok(facts.tools.size > 0, 'the server lists tools');
  assert.ok(facts.prompts.size > 0, 'the server lists prompts');
  assert.ok(facts.topicIds.size > 0, 'the reference has topics');
  assert.ok(facts.viewTitles.has('Song'), "the Parts view's title for a piece with a song is a view title");
  assert.ok(facts.environmentVariables.size > 0, 'the sources name environment variables');
  assert.ok(facts.strudelCalls.size > 0, 'the reference holds calls');
  assert.match(facts.siteAddress, /^https:\/\/[^/]+\.github\.io\/[^/]+\/$/);
});

test('the real README and every page give no finding', () => {
  const findings = realFindings(rows);
  assert.deepEqual(findings.map(describe), []);
});

test('the real images and pages give no missing image and no unused image', () => {
  assert.deepEqual(realFindings(rows).filter((f) => f.rule === 'missing image').map(describe), []);
  assert.deepEqual(unusedImages(root, files).map(describe), []);
  assert.ok(fs.readdirSync(path.join(root, 'site', 'images')).length > 0, 'the real site has images, so the two rules have something to check');
});

// ---- one planted fixture per rule ----

const [aTopic, ...otherTopics] = [...facts.topicIds];
const [aTool, ...otherTools] = [...facts.tools].filter((name) => /^[a-z][a-z_]*$/.test(name));
const topicLine = (id) => `- Some title (\`${id}\`)`;

const FIXTURES = [
  ['unknown tool', 'Call `get_nothing` to see.'],
  ['unknown prompt', 'Type `/mcp__moontide__nothing` to start.'],
  ['unknown environment variable', 'Set `MOONTIDE_NOTHING` to 1.'],
  ['unknown reference topic', 'Read the `nothing` topic first.'],
  ['unknown npm script', 'Run `npm run nothing` now.'],
  ['unknown function', 'Write `.nothing()` after the pattern.'],
  ['unknown function', ['```js', 'nothing("c3").s("sawtooth")', '```'].join('\n')],
  ['unknown view', 'Open the Nothing view to see it.'],
  ['dead link', `See [the page](${facts.siteAddress}nothing.html) for more.`],
  ['dead link', `See [the page](${facts.siteAddress}index.html#nothing) for more.`],
  ['dead link', `See [the file](https://github.com/${facts.owner}/${facts.repo}/blob/main/nothing.md) for more.`],
  ['missing image', 'A picture follows.\n\n![A picture](images/nothing.png)\n\n*A caption.*'],
  ['missing image', 'A picture follows.\n\n![A picture](nothing/at/all.gif)'],
  ['missing image', 'A picture follows.\n\n![A picture](../outside-the-repository.png)'],
  ['incomplete list', otherTopics.map(topicLine).join('\n')],
  ['incomplete list', [...otherTopics, 'nothing'].map(topicLine).join('\n')],
  ['incomplete list', otherTools.map((name) => `- \`${name}\`: what it does`).join('\n')],
  ['unpinned limit', 'A rig has at most 9 inputs.'],
  ['unpinned limit', 'It keeps the last 12345 versions.'],
  // Counts written in digits, and durations written with a hyphen or in short forms.
  ['unpinned limit', `It keeps ${constants.topicCount + 1} topics.`],
  ['unpinned limit', `It has ${constants.viewCount + 1} views.`],
  ['unpinned limit', 'There are 999 views.'],
  ['unpinned limit', 'It has a 45-second timeout.'],
  ['unpinned limit', 'It waits 90 secs before it stops.'],
  ['unpinned limit', 'It waits 20 mins before it stops.'],
  ['unpinned limit', 'It stops after 3 hours.'],
  ['unpinned limit', 'It stops after 2 days.'],
  // Dead links the first version of the check let through.
  ['dead link', `See [the page](https://${facts.owner.toUpperCase()}.github.io/${facts.repo}/nothing.html) for more.`],
  ['dead link', `See [the page](http://${facts.owner}.github.io/${facts.repo}/nothing.html) for more.`],
  ['dead link', `See [the page](https://${facts.owner}.github.io/${facts.repo}#nothing) for more.`],
  ['dead link', `See [the file](https://github.com/${facts.owner}/${facts.repo}/blob/dev/nothing.md) for more.`],
  ['dead link', `See [the file](http://GitHub.com/${facts.owner.toUpperCase()}/${facts.repo}/tree/v1/nothing.md) for more.`],
  ['dead link', `See [the file](https://github.com/${facts.owner}/${facts.repo}/blob/main/..) for more.`],
  ['dead link', `See [the file](https://github.com/${facts.owner}/${facts.repo}/blob/main/../x) for more.`],
];

for (const [rule, text] of FIXTURES) {
  test(`a planted "${text.split('\n')[0].slice(0, 40)}" gives ${rule}`, () => {
    const findings = findingsOf(text);
    assert.ok(findings.length > 0, 'a finding');
    assert.deepEqual(rulesOf(text), [rule]);
    assert.ok(findings.every((f) => f.file === 'fixture.md' && f.line >= 1));
  });
}

test('an image that exists, from the folder of the file that shows it, gives no finding', () => {
  const page = '![The grid](images/song-grid.png)\n\n*A caption.*';
  assert.deepEqual(checkFile('site/song-structure.md', page, facts, rows).map(describe), []);
  assert.deepEqual(checkFile('site/song-structure.md', '![The grid](images/missing.png)', facts, rows).map((f) => f.rule), ['missing image']);
  // The same target from the root is another file, so it is missing there.
  assert.deepEqual(checkFile('README.md', page, facts, rows).map((f) => f.rule), ['missing image']);
  assert.deepEqual(checkFile('README.md', '![A badge](https://img.shields.io/badge/x-y-green)', facts, rows).map(describe), []);
});

test('a missing image is one finding, not also a dead link, in README.md', () => {
  assert.deepEqual(checkFile('README.md', '![A picture](docs/nothing.png)', facts, rows).map((f) => f.rule), ['missing image']);
});

test('an unused image: a file of site/images that no page names gives one finding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-claims-'));
  try {
    fs.mkdirSync(path.join(dir, 'site', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'site', 'images', 'used.png'), 'x');
    fs.writeFileSync(path.join(dir, 'site', 'images', 'lonely.gif'), 'x');
    const pages = [
      { file: 'site/page.md', text: '![Used](images/used.png)\n\n*Caption.*' },
      { file: 'README.md', text: '![Lonely](site/images/lonely.gif)' },
    ];
    const findings = unusedImages(dir, pages);
    assert.deepEqual(findings, [{ file: 'site/images/lonely.gif', line: 0, rule: 'unused image', words: 'lonely.gif' }]);
    assert.equal(describe(findings[0]), 'site/images/lonely.gif:0: unused image: lonely.gif');
    assert.deepEqual(unusedImages(dir, [...pages, { file: 'site/other.md', text: '![Also](images/lonely.gif)' }]), []);
    assert.deepEqual(unusedImages(path.join(dir, 'nowhere'), pages), [], 'no images folder, no finding');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('things that exist give no finding', () => {
  const text = [
    `Call \`${aTool}\` and read the \`${aTopic}\` topic.`,
    `Type \`/mcp__moontide__${[...facts.prompts][0]}\`.`,
    `Run \`npm run ${[...facts.npmScripts][0]}\`.`,
    `Open the ${[...facts.viewTitles][0]} view.`,
    `See [the home page](${facts.siteAddress}) and [the guide](https://github.com/${facts.owner}/${facts.repo}/blob/main/README.md).`,
  ].join('\n\n');
  assert.deepEqual(findingsOf(text).map(describe), []);
});

test('a complete list of topics and a complete list of tools give no finding', () => {
  const topics = [aTopic, ...otherTopics].map(topicLine).join('\n');
  const tools = [aTool, ...otherTools].map((name) => `- \`${name}\`: what it does`).join('\n');
  assert.deepEqual(findingsOf(topics).map(describe), []);
  assert.deepEqual(findingsOf(tools).map(describe), []);
});

test('digit counts that match the code, and measured milliseconds, give no finding', () => {
  const text = [
    `There are ${constants.viewCount} views and ${constants.topicCount} topics.`,
    'Every note landed within 6 ms of its place.',
  ].join('\n\n');
  assert.deepEqual(findingsOf(text).map(describe), []);
});

test('links to the site and to the repository are accepted in any letter case, scheme and ref', () => {
  const site = `${facts.owner.toUpperCase()}.github.io/${facts.repo}`;
  const text = [
    `[a](https://${site}/) [b](http://${site}/index.html) [c](https://${facts.owner}.github.io/${facts.repo}) [d](https://${site}/index.html#${[...facts.sitePages.get('index.md')][0]})`,
    `[e](https://github.com/${facts.owner}/${facts.repo}/blob/dev/README.md) [f](https://GITHUB.com/${facts.owner}/${facts.repo}/tree/v1/README.md)`,
  ].join('\n\n');
  assert.deepEqual(findingsOf(text).map(describe), []);
});

test('a relative README link may not climb out of the repository', () => {
  const check = (target) => checkFile('README.md', `See [it](${target}).`, facts, rows).map((f) => f.rule);
  assert.deepEqual(check('README.md'), []);
  assert.deepEqual(check('./README.md#top'), []);
  assert.deepEqual(check('..'), ['dead link']);
  assert.deepEqual(check('../README.md'), ['dead link']);
  assert.deepEqual(check('docs/../../README.md'), ['dead link']);
  assert.deepEqual(check('nothing.md'), ['dead link']);
});

test('shell blocks hold commands, not Strudel calls', () => {
  assert.deepEqual(findingsOf(['```bash', 'echo $(nothing)', '```'].join('\n')).map(describe), []);
});

test('a phrase that wraps over two lines is still one phrase', () => {
  const wrapped = `The history keeps the last\n${constants.historyCap} versions of the piece.`;
  assert.deepEqual(findingsOf(wrapped).map(describe), []);
  assert.equal(readUnits(wrapped).length, 1);
});

test('a number that only ends like a pinned one is not covered by it', () => {
  assert.deepEqual(rulesOf(`It keeps ${constants.historyCap}0 versions.`), ['unpinned limit']);
});

test('a finding names the line of the words, not of the paragraph', () => {
  const [finding] = findingsOf('Some words here.\nMore words, then `get_nothing` on this line.');
  assert.equal(finding.line, 2);
});

// ---- every exemption carries its reason ----

test('every exemption entry carries its reason', () => {
  for (const map of [NOT_A_TOOL, PARTIAL_TOOL_LIST, NOT_A_STRUDEL_CALL]) {
    for (const [name, reason] of map) assert.ok(typeof reason === 'string' && reason.trim().length > 10, `${name} has a reason`);
  }
  for (const { pattern, reason } of LIMIT_EXEMPTIONS) {
    assert.ok(pattern instanceof RegExp && pattern.global, 'an exemption is a global pattern');
    assert.ok(typeof reason === 'string' && reason.trim().length > 10, `${pattern} has a reason`);
  }
});

// ---- a changed constant is caught on the real text ----

const unitTexts = files.map(({ text }) => readUnits(text).map((unit) => unit.text.toLowerCase()).join('\n'));
const usedInRealText = (row) => unitTexts.some((all) => all.includes(row.text.toLowerCase()));

test('the rows build from the constants of the code', () => {
  assert.ok(Object.keys(constants).length > 10);
  for (const [key, value] of Object.entries(constants)) assert.ok(Number.isFinite(value), `${key} is a number`);
  assert.ok(rows.every((row) => typeof row.key === 'string' && row.text.length > 0));
});

for (const key of Object.keys(constants)) {
  const used = rows.filter((row) => row.key === key && usedInRealText(row));
  const check = () => {
    const changed = pinnedRows({ ...constants, [key]: constants[key] + 1 });
    const findings = realFindings(changed).filter((f) => f.rule === 'unpinned limit');
    assert.ok(findings.length > 0, `changing ${key} by one gives a finding on the real text (rows used: ${used.map((r) => r.text).join(' | ')})`);
  };
  // A number no page states yet has no phrase to check; the pages written later bring one.
  if (used.length > 0) test(`changing ${key} by one is caught on the real text`, check);
}

test('the real text states several pinned numbers, so the changed-constant loop is not empty', () => {
  const keys = new Set(rows.filter(usedInRealText).map((row) => row.key));
  assert.ok(keys.size >= 5, `only ${keys.size} pinned numbers occur in the real text`);
});
