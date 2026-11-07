// Guards the words that say how mature Moontide is: "Early" for the project and "Early experimental" for the whole Scratchpad, the
// same in every place they are promised (the page, the manual, the README, the package descriptions and the changelog). A label that
// goes missing, or a third maturity word (beta, alpha, or experimental without early), fails here. Each failure names the file and
// the place. The held-note problem named next to the labels is not pinned here: its fix will remove those sentences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkFile, describe, loadFacts, pinnedRows, realConstants } from './site-claims.js';
import { SCRATCH_COPY } from '../page/scratch-model.js';
import { BAR_COPY } from '../page/bar-model.js';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

/** The first paragraph after the `# ` title of a Markdown file: lines joined by single spaces until the next blank line. */
function firstParagraph(relative) {
  const lines = read(relative).split(/\r?\n/);
  const title = lines.findIndex((line) => line.startsWith('# '));
  assert.notEqual(title, -1, `${relative} has no title line`);
  const paragraph = [];
  for (const line of lines.slice(title + 1)) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  return paragraph.join(' ');
}

/** The paragraphs of a Markdown file before its first `## ` heading, each as one line. */
function paragraphsBeforeFirstSection(relative) {
  const lines = read(relative).split(/\r?\n/);
  const end = lines.findIndex((line) => line.startsWith('## '));
  const paragraphs = [];
  let current = [];
  for (const line of lines.slice(0, end === -1 ? lines.length : end)) {
    if (line.trim() === '') {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs;
}

/** The text of a `##` or `###` section of a Markdown file, from its heading to the next heading of the same or higher level. */
function section(relative, heading) {
  const lines = read(relative).split(/\r?\n/);
  const start = lines.findIndex((line) => line.replace(/^#+\s+/, '') === heading && line.startsWith('#'));
  assert.notEqual(start, -1, `${relative} has no section "${heading}"`);
  const level = lines[start].match(/^#+/)[0].length;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^#+\s/.test(line) && line.match(/^#+/)[0].length <= level);
  return rest.slice(0, next === -1 ? rest.length : next).join('\n');
}

const siteFiles = readdirSync(fileURLToPath(new URL('site/', root)))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `site/${name}`);

test('page: the Scratchpad label reads Early experimental, with a one-sentence tooltip', () => {
  assert.equal(SCRATCH_COPY.early, 'Early experimental', 'page/scratch-model.js SCRATCH_COPY.early');
  const title = SCRATCH_COPY.earlyTitle;
  assert.ok(title.endsWith('.'), 'page/scratch-model.js SCRATCH_COPY.earlyTitle must end with a full stop');
  assert.equal(/[.!?]\s/.test(title), false, 'page/scratch-model.js SCRATCH_COPY.earlyTitle must be one sentence');
});

test('page: #scratch-early sits once in the Scratchpad toolbar, before the roll', () => {
  const html = read('page/index.html');
  assert.equal(html.split('id="scratch-early"').length - 1, 1, 'page/index.html must hold id="scratch-early" once');
  const controls = html.indexOf('id="scratch-controls"');
  const early = html.indexOf('id="scratch-early"');
  const scroll = html.indexOf('id="scratch-scroll"');
  assert.ok(controls !== -1 && controls < early && early < scroll, 'page/index.html: #scratch-early must sit between #scratch-controls and #scratch-scroll');
});

test('page: the Session card line starts with Early: and sits once in the Session card', () => {
  assert.ok(BAR_COPY.earlyNote.startsWith('Early: '), 'page/bar-model.js BAR_COPY.earlyNote must start with "Early: "');
  const html = read('page/index.html');
  assert.equal(html.split('data-copy="earlyNote"').length - 1, 1, 'page/index.html must hold data-copy="earlyNote" once');
  const start = html.indexOf('id="session-card-session"');
  const end = html.indexOf('</section>', start);
  const at = html.indexOf('data-copy="earlyNote"');
  assert.ok(start !== -1 && start < at && at < end, 'page/index.html: the Early line must sit inside the Session card');
});

test('manual: the home page opens with the Early note', () => {
  const paragraph = firstParagraph('site/index.md');
  assert.ok(paragraph.startsWith('**Early:**'), 'site/index.md: the first paragraph after the title must start with **Early:**');
  assert.match(paragraph, /early experimental/i, 'site/index.md: the Early note must say early experimental');
  assert.match(paragraph, /Scratchpad/, 'site/index.md: the Early note must name the Scratchpad');
});

test('manual: the page tour names the label and the Early line', () => {
  const views = section('site/the-page.md', 'The views');
  assert.match(views, /Early experimental/, 'site/the-page.md "The views" must say Early experimental');
  const drawer = section('site/the-page.md', 'The Session drawer');
  assert.match(drawer, /\bearly\b/i, 'site/the-page.md "The Session drawer" must say early');
});

test('README: one paragraph before the first section starts with **Early:** and names the Scratchpad', () => {
  const early = paragraphsBeforeFirstSection('README.md').filter((paragraph) => paragraph.startsWith('**Early:**'));
  assert.equal(early.length, 1, 'README.md: exactly one paragraph before the first "## " heading must start with **Early:**');
  assert.match(early[0], /early experimental/i, 'README.md: the Early paragraph must say early experimental');
  assert.match(early[0], /Scratchpad/, 'README.md: the Early paragraph must name the Scratchpad');
});

test('one wording: no beta, no alpha, and experimental only right after early', () => {
  const texts = new Map([
    ['README.md', read('README.md')],
    ['CHANGELOG.md', read('CHANGELOG.md')],
    ['page/index.html', read('page/index.html')],
    ['page/scratch-model.js SCRATCH_COPY', Object.values(SCRATCH_COPY).filter((value) => typeof value === 'string').join('\n')],
    ['page/bar-model.js BAR_COPY', Object.values(BAR_COPY).filter((value) => typeof value === 'string').join('\n')],
  ]);
  for (const file of siteFiles) texts.set(file, read(file));
  for (const [name, text] of texts) {
    assert.equal(/\b(beta|alpha)\b/i.test(text), false, `${name}: the words beta and alpha are not used; say early`);
    for (const match of text.matchAll(/experimental/gi)) {
      const before = text.slice(Math.max(0, match.index - 20), match.index);
      assert.match(before, /early\s+$/i, `${name}: "experimental" must come right after "early" (near "${text.slice(Math.max(0, match.index - 20), match.index + 12).replace(/\s+/g, ' ')}")`);
    }
  }
});

test('manual: the Scratchpad, keyboard-input and sending-a-motif pages open with the Early experimental note', () => {
  for (const file of ['site/scratchpad.md', 'site/keyboard-input.md', 'site/sending-a-motif.md']) {
    assert.ok(firstParagraph(file).startsWith('**Early experimental:**'), `${file}: the first paragraph after the title must start with **Early experimental:**`);
  }
});

test('manual: Known limits holds the Scratchpad bullet', () => {
  const limits = section('site/troubleshooting.md', 'Known limits');
  assert.match(limits, /^- The Scratchpad is early experimental/m, 'site/troubleshooting.md "Known limits" must hold a bullet that starts with "The Scratchpad is early experimental"');
});

test('descriptions: package.json starts with "Early: " and server.json carries the same text', () => {
  const pkg = JSON.parse(read('package.json'));
  const server = JSON.parse(read('server.json'));
  assert.ok(pkg.description.startsWith('Early: '), 'package.json: the description must start with "Early: "');
  assert.equal(server.description, pkg.description, 'server.json: the description must equal the one in package.json');
});

test('changelog: a paragraph says early experimental and names the Scratchpad', () => {
  const paragraphs = read('CHANGELOG.md').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.replace(/\s+/g, ' '));
  assert.ok(
    paragraphs.some((paragraph) => /early experimental/i.test(paragraph) && /Scratchpad/.test(paragraph)),
    'CHANGELOG.md: no paragraph says early experimental and names the Scratchpad',
  );
});

/** The newest section of the changelog: from the first `## [` heading up to the next one. */
// The newest section that ships features. A maintenance release (its section opens with "A maintenance
// release.") changes nothing in Moontide, so the features and open checks stay those of the release before.
function newestChangelogSection() {
  const lines = read('CHANGELOG.md').split(/\r?\n/);
  const starts = lines.flatMap((line, index) => (line.startsWith('## [') ? [index] : []));
  assert.notEqual(starts.length, 0, 'CHANGELOG.md has no version heading');
  for (const [i, start] of starts.entries()) {
    const body = lines.slice(start + 1, starts[i + 1] ?? lines.length);
    if (body.find((line) => line.trim() !== '')?.startsWith('A maintenance release.')) continue;
    return body.join('\n');
  }
  assert.fail('CHANGELOG.md has only maintenance sections');
}

test('changelog: the newest section points into the manual, at the settings page and the Scratchpad page', async () => {
  const facts = await loadFacts(fileURLToPath(root));
  const section = newestChangelogSection();
  for (const page of ['synth-settings.html', 'scratchpad.html']) {
    assert.ok(section.includes(`${facts.siteAddress}${page}`), `CHANGELOG.md: the newest section must hold the manual address ${facts.siteAddress}${page}`);
  }
});

test('changelog: the newest section passes the manual\'s claims check', async () => {
  const rootPath = fileURLToPath(root);
  const facts = await loadFacts(rootPath);
  const rows = pinnedRows(await realConstants(rootPath));
  const findings = checkFile('CHANGELOG.md', newestChangelogSection(), facts, rows);
  assert.deepEqual(findings.map(describe), []);
});

test('changelog: the newest section lists the hand checks still open, as open', () => {
  const section = newestChangelogSection();
  assert.match(section, /^Not yet checked by hand/m, 'CHANGELOG.md: the newest section must hold a line that starts with "Not yet checked by hand"');
  for (const word of ['ramp', 'bass', 'keyboard', 'screen reader', 'eighth', 'held']) {
    assert.ok(section.toLowerCase().includes(word), `CHANGELOG.md: the newest section must still mention "${word}" among the open checks`);
  }
});
