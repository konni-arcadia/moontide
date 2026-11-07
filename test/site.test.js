import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { IMAGE_LIMITS, PNG_SAFE_CHUNKS, buildSite, readImage, readManual, renderMarkdown, SiteError } from '../scripts/build-site.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realSite = path.join(root, 'site');
const script = path.join(root, 'scripts', 'build-site.mjs');

const BOX = '## What was verified\n\n**Verified:**\n\n- a thing\n\n**Not verified:**\n\n- another thing\n';

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-site-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A small site folder: files maps a name to its text.
function writeSite(dir, files) {
  const siteDir = path.join(dir, 'site');
  fs.mkdirSync(siteDir);
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(siteDir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return siteDir;
}

// ---- Small pictures, built here, never read from disk ----

// zlib.crc32 is missing from early Node 22 releases, so the checksum is made here.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// A PNG: the signature, IHDR (the width and height are only claimed; no pixel is checked), the extra chunks, an
// IDAT made by zlib and IEND.
function makePng({ width = 2, height = 1, extra = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    ...extra,
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0]))),
    pngChunk('IEND'),
  ]);
}

const subBlocks = (...parts) => Buffer.concat([...parts.map((part) => Buffer.concat([Buffer.from([part.length]), part])), Buffer.from([0])]);

// A GIF: header, logical screen with a two-colour table, one frame for each delay (in hundredths of a second) with its
// graphic control extension, the extra blocks, the trailer.
function makeGif({ width = 2, height = 1, delays = [10], extra = [], version = 'GIF89a' } = {}) {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80;
  const frames = delays.map((delay) => {
    const control = Buffer.alloc(4);
    control.writeUInt16LE(delay, 1);
    return Buffer.concat([
      Buffer.from([0x21, 0xf9]),
      subBlocks(control),
      Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
      Buffer.from([2]),
      subBlocks(Buffer.from([0x4c, 0x01])),
    ]);
  });
  return Buffer.concat([
    Buffer.from(version, 'latin1'),
    screen,
    Buffer.from([0, 0, 0, 255, 255, 255]),
    ...frames,
    ...extra,
    Buffer.from([0x3b]),
  ]);
}

const gifComment = Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from('hello'))]);
const gifPlainText = Buffer.concat([Buffer.from([0x21, 0x01]), subBlocks(Buffer.alloc(12), Buffer.from('text'))]);
const gifApplication = (name, code) => Buffer.concat([Buffer.from([0x21, 0xff]), subBlocks(Buffer.from(name + code, 'latin1'), Buffer.from([1, 0, 0]))]);

const FIGURE = '![A small picture](images/a.png)\n\n*A caption.*\n';
const withFigure = (text, extra = '') => ({ ...goodFiles(), 'first.md': `# First\n\n${text}\n${extra}${BOX}` });

const goodFiles = () => ({
  'index.md': `# Home\n\n## Part one\n\n- [First](first.md): the first page.\n\n${BOX}`,
  'first.md': `# First\n\nSome text.\n\n${BOX}`,
  'style.css': 'body { margin: 0; }\n',
});

function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SiteError, `expected a SiteError, got ${error}`);
    return error;
  }
  assert.fail('expected a refusal');
}

// ---- the renderer ----

test('headings get ids by the GitHub rule and the title is plain text', () => {
  const page = renderMarkdown('# The `big` title\n\n## What\'s New? In v2_1 — a test\n\n### Two  Spaces\n');
  assert.equal(page.title, 'The big title');
  assert.deepEqual(page.ids, ['whats-new-in-v2_1--a-test', 'two--spaces']);
  assert.match(page.html, /<h2 id="whats-new-in-v2_1--a-test">/);
});

test('a nested list and an ordered list render as lists', () => {
  const page = renderMarkdown('# T\n\n- one\n  - inner\n  - inner two\n- two\n\n3. third\n4. fourth\n');
  assert.match(page.html, /<ul>\n<li>one\n<ul>\n<li>inner<\/li>\n<li>inner two<\/li>\n<\/ul><\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(page.html, /<ol start="3">\n<li>third<\/li>\n<li>fourth<\/li>\n<\/ol>/);
});

test('a list item can continue on an indented line', () => {
  const page = renderMarkdown('# T\n\n1. first line\n   goes on here\n2. second\n');
  assert.match(page.html, /<li>first line goes on here<\/li>/);
});

test('a fenced block keeps its text verbatim and escaped', () => {
  const page = renderMarkdown('# T\n\n```html\n<script>alert("x")</script> & more\n```\n');
  assert.match(page.html, /<pre><code class="language-html">&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; more<\/code><\/pre>/);
  assert.doesNotMatch(page.html, /<script/);
});

test('inline code is escaped and bold, italic and links render', () => {
  const page = renderMarkdown('# T\n\nUse `a < b && c` and **bold with `code`** and *soft* text.\n');
  assert.match(page.html, /<code>a &lt; b &amp;&amp; c<\/code>/);
  assert.match(page.html, /<strong>bold with <code>code<\/code><\/strong>/);
  assert.match(page.html, /<em>soft<\/em>/);
});

test('a .md#id link becomes .html#id and an external link is kept', () => {
  const page = renderMarkdown('# T\n\nSee [the page](other.md#part) and [outside](https://example.com/a?b=1&c=2).\n');
  assert.match(page.html, /<a href="other\.html#part">the page<\/a>/);
  assert.match(page.html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">outside<\/a>/);
  assert.deepEqual(page.links, [{ page: 'other.md', id: 'part', line: 3 }]);
});

test('a bare https address becomes a link without its closing dot', () => {
  const page = renderMarkdown('# T\n\nSee https://example.com/policy.\n');
  assert.match(page.html, /See <a href="https:\/\/example\.com\/policy">https:\/\/example\.com\/policy<\/a>\./);
});

test('a backslash inside backticks is code, not a refusal', () => {
  const page = renderMarkdown('# T\n\nOpen `C:\\music` now.\n');
  assert.match(page.html, /<code>C:\\music<\/code>/);
});

test('a bare address inside link text stays text, so no anchor holds another', () => {
  const page = renderMarkdown('# T\n\nSee [https://example.com](https://example.com) and **[https://a.example](https://a.example)**.\n');
  assert.equal(page.html.match(/<a /g).length, 2);
  assert.match(page.html, /<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/);
  assert.doesNotMatch(page.html, /<a [^>]*><a /);
});

test('an address in brackets of plain parentheses still links', () => {
  const page = renderMarkdown('# T\n\nThe policy (see https://example.com/policy) is short.\n');
  assert.match(page.html, /\(see <a href="https:\/\/example\.com\/policy">https:\/\/example\.com\/policy<\/a>\) is/);
});

test('CRLF line ends read like LF', () => {
  const page = renderMarkdown('# T\r\n\r\n- a\r\n- b\r\n');
  assert.equal(page.title, 'T');
  assert.match(page.html, /<li>b<\/li>/);
});

test('the verified section becomes a box and reports what it holds', () => {
  const page = renderMarkdown(`# T\n\ntext\n\n${BOX}`);
  assert.match(page.html, /<section class="verified">\n<h2 id="what-was-verified">/);
  assert.ok(page.html.trimEnd().endsWith('</section>'));
  assert.equal(page.verified.isLast, true);
  assert.equal(page.verified.hasVerified, true);
  assert.equal(page.verified.hasNotVerified, true);
});

const REFUSED = [
  ['raw HTML', '# T\n\n<div>hi</div>\n', /:3: raw HTML/],
  ['raw HTML inside a paragraph', '# T\n\nsome <b>bold</b> text\n', /:3: raw HTML/],
  ['a table row', '# T\n\n| a | b |\n', /:3: a table/],
  ['an image', '# T\n\ntext ![alt](pic.png)\n', /:3: an image/],
  ['a quote line', '# T\n\n> quoted\n', /:3: a quote/],
  ['a four-hash heading', '# T\n\n#### deep\n', /:3: a heading of four or more hashes/],
  ['a javascript link', '# T\n\n[x](javascript:alert(1))\n', /:3: a link scheme/],
  ['a page without a title', 'No title here\n', /a page starts with a "# Title" line/],
  ['a second title', '# T\n\n# Again\n', /:3: a page holds exactly one/],
  ['a duplicate id', '# T\n\n## Same\n\n## Same\n', /:5: the heading id "same" is used twice/],
  ['an unclosed fence', '# T\n\ntext\n\n```bash\nnever closed\n', /:5: a code fence that is never closed/],
  ['a fence inside a list item', '# T\n\n- item\n  ```\n  code\n  ```\n', /:4: a fenced code block inside a list item/],
  ['a setext underline', '# T\n\nTitle\n=====\n', /:4: a setext underline/],
  ['an unclosed backtick', '# T\n\na `b\n', /:3: a backtick that closes nothing/],
  ['a link to an unknown kind of target', '# T\n\n[x](some/where.html)\n', /:3: a link target must be/],
  ['text right after a list', '# T\n\n- item\nlazy\n', /:4: put a blank line after a list/],
  ['indented code', '# T\n\n    code\n', /:3: indented text/],
  ['an escaped asterisk', '# T\n\nuse \\*not italic\\* here\n', /:3: a backslash is not supported/],
  ['an escaped backtick', '# T\n\nuse \\` here\n', /:3: a backslash is not supported/],
  ['a backslash in a heading', '# T\n\n## A\\.B\n', /:3: a backslash is not supported/],
  ['parentheses in a link address', '# T\n\n[x](https://example.com/wiki/Foo_(bar))\n', /:3: parentheses in a link address/],
  ['parentheses in a bare address', '# T\n\nsee https://example.com/a_(b) now\n', /:3: parentheses in a bare address/],
];

for (const [name, text, expected] of REFUSED) {
  test(`renderMarkdown refuses ${name}, naming the line`, () => {
    const error = refusal(() => renderMarkdown(text, 'page.md'));
    assert.match(error.message, /^page\.md/);
    assert.match(error.message, expected);
    assert.equal(error.exitCode, 1);
  });
}

// ---- figures ----

test('a figure line and an italic caption render as one figure, record the image with its line and escape the alternative', () => {
  const text = '# T\n\nSome text.\n\n![Tom & "Jerry" <b>](images/song-grid.png)\n\n*The picture: see `code`, **bold** and [a link](other.md).\nIt wraps over two lines.*\n';
  const page = renderMarkdown(text, 'page.md');
  assert.deepEqual(page.images, [{ name: 'song-grid.png', line: 5 }]);
  assert.match(page.html, /<figure>\n<img src="images\/song-grid\.png" alt="Tom &amp; &quot;Jerry&quot; &lt;b&gt;" loading="lazy" decoding="async">\n<figcaption>/);
  assert.doesNotMatch(page.html, /width=/, 'no size is written without the facts of the images');
  assert.match(page.html, /<figcaption>The picture: see <code>code<\/code>, <strong>bold<\/strong> and <a href="other\.html">a link<\/a>\. It wraps over two lines\.<\/figcaption>\n<\/figure>/);
  assert.doesNotMatch(page.html, /<figcaption><em>/, 'the outer emphasis is not written');
  assert.deepEqual(page.links, [{ page: 'other.md', id: null, line: 7 }], 'a link in a caption is checked like any link');
});

test('a figure gets the width and height of the image it names when the facts are given', () => {
  const facts = new Map([['a.png', { width: 640, height: 360 }]]);
  const page = renderMarkdown(`# T\n\n${FIGURE}`, 'page.md', facts);
  assert.match(page.html, /<img src="images\/a\.png" alt="A small picture" width="640" height="360" loading="lazy" decoding="async">/);
});

const FIGURE_REFUSED = [
  ['an image inside text', '# T\n\ntext ![alt](images/a.png) more\n\n*Caption.*\n', /:3: an image stands alone/],
  ['an image in a list item', '# T\n\n- item ![alt](images/a.png)\n\n*Caption.*\n', /:3: an image stands alone/],
  ['an image that starts a list item', '# T\n\n- ![alt](images/a.png)\n\n*Caption.*\n', /:3: an image stands alone/],
  ['an image in a heading', '# T\n\n## Head ![alt](images/a.png)\n\n*Caption.*\n', /:3: an image stands alone/],
  ['an image inside a caption', '# T\n\n![alt](images/a.png)\n\n*Caption ![other](images/b.png) here.*\n', /:5: an image stands alone/],
  ['an image line with text after it', '# T\n\n![alt](images/a.png) after\n\n*Caption.*\n', /:3: an image stands alone/],
  ['an empty text alternative', '# T\n\n![](images/a.png)\n\n*Caption.*\n', /:3: an image needs a text alternative/],
  ['a blank text alternative', '# T\n\n![  ](images/a.png)\n\n*Caption.*\n', /:3: an image needs a text alternative/],
  ['a backtick in the text alternative', '# T\n\n![the `code`](images/a.png)\n\n*Caption.*\n', /:3: the text alternative is plain words/],
  ['an asterisk in the text alternative', '# T\n\n![the *word*](images/a.png)\n\n*Caption.*\n', /:3: the text alternative is plain words/],
  ['a bracket in the text alternative', '# T\n\n![the [word](images/a.png)\n\n*Caption.*\n', /:3: the text alternative is plain words/],
  ['a bare name as the target', '# T\n\n![alt](a.png)\n\n*Caption.*\n', /:3: an image comes from the images folder/],
  ['a subfolder of the images folder', '# T\n\n![alt](images/sub/a.png)\n\n*Caption.*\n', /:3: "sub\/a\.png" is not an image name/],
  ['an https address as the target', '# T\n\n![alt](https://example.com/a.png)\n\n*Caption.*\n', /:3: an image comes from the images folder/],
  ['a climb with two dots', '# T\n\n![alt](../images/a.png)\n\n*Caption.*\n', /:3: an image comes from the images folder/],
  ['a climb inside the images folder', '# T\n\n![alt](images/../a.png)\n\n*Caption.*\n', /:3: "\.\.\/a\.png" is not an image name/],
  ['a capital in the name', '# T\n\n![alt](images/Big.png)\n\n*Caption.*\n', /:3: "Big\.png" is not an image name/],
  ['an underscore in the name', '# T\n\n![alt](images/a_b.png)\n\n*Caption.*\n', /:3: "a_b\.png" is not an image name/],
  ['a .jpg name', '# T\n\n![alt](images/a.jpg)\n\n*Caption.*\n', /:3: "a\.jpg" is not an image name/],
  ['a .svg name', '# T\n\n![alt](images/a.svg)\n\n*Caption.*\n', /:3: "a\.svg" is not an image name/],
  ['a .webp name', '# T\n\n![alt](images/a.webp)\n\n*Caption.*\n', /:3: "a\.webp" is not an image name/],
  ['a double hyphen in the name', '# T\n\n![alt](images/a--b.png)\n\n*Caption.*\n', /:3: "a--b\.png" is not an image name/],
  ['an image at the end of the page with no caption', '# T\n\n![alt](images/a.png)\n', /:3: the image images\/a\.png has no caption/],
  ['an image followed by a plain paragraph', '# T\n\n![alt](images/a.png)\n\nNot italic.\n', /:3: the image images\/a\.png has no caption/],
  ['an image followed by a heading', '# T\n\n![alt](images/a.png)\n\n## Next\n', /:3: the image images\/a\.png has no caption/],
  ['an image followed by a bold paragraph', '# T\n\n![alt](images/a.png)\n\n**Bold.**\n', /:3: the image images\/a\.png has no caption/],
  ['a caption in italics only in part', '# T\n\n![alt](images/a.png)\n\n*Italic* and then plain.\n', /:5: the image images\/a\.png has no caption/],
  ['two italic spans as the caption', '# T\n\n![alt](images/a.png)\n\n*One* and *two*\n', /:5: the image images\/a\.png has no caption/],
  ['a caption that ends in bold', '# T\n\n![alt](images/a.png)\n\n*Caption with **bold***\n', /:5: the image images\/a\.png has no caption/],
  ['a figure paragraph of more than one line', '# T\n\n![alt](images/a.png)\n*Caption.*\n', /:3: an image stands alone on its line: put a blank line/],
  ['an image right after another figure', '# T\n\n![one](images/a.png)\n\n*One.*\n\n![two](images/b.png)\n\n*Two.*\n', /:7: two images in a row; put text between them/],
  ['a list right after a caption line', '# T\n\n![alt](images/a.png)\n\n*Caption.*\n- item\n', /:6: put a blank line after the caption/],
];

for (const [name, text, expected] of FIGURE_REFUSED) {
  test(`renderMarkdown refuses ${name}, naming the line`, () => {
    const error = refusal(() => renderMarkdown(text, 'page.md'));
    assert.match(error.message, /^page\.md:\d+: /);
    assert.match(error.message, expected);
    assert.equal(error.exitCode, 1);
  });
}

test('renderMarkdown refuses an image that is not among the facts of the images, naming the line', () => {
  const error = refusal(() => renderMarkdown('# T\n\n![alt](images/ghost.png)\n\n*Caption.*\n', 'page.md', new Map()));
  assert.match(error.message, /^page\.md:3: images\/ghost\.png is not a file of site\/images/);
});

test('two figures with text between them are fine', () => {
  const page = renderMarkdown('# T\n\n![one](images/a.png)\n\n*One.*\n\nText between.\n\n![two](images/b.gif)\n\n*Two.*\n', 'page.md');
  assert.deepEqual(page.images.map((image) => image.name), ['a.png', 'b.gif']);
});

// ---- the pictures ----

test('readImage reads the kind, width and height of a small PNG and a small GIF', () => {
  assert.deepEqual(readImage(makePng({ width: 640, height: 360 }), 'a.png'), { kind: 'png', width: 640, height: 360, durationMs: 0 });
  assert.deepEqual(readImage(makeGif({ width: 320, height: 200, delays: [10] }), 'a.gif'), { kind: 'gif', width: 320, height: 200, durationMs: 100 });
  assert.equal(readImage(makeGif({ version: 'GIF87a' }), 'a.gif').kind, 'gif');
});

test('readImage counts a delay of 0 or 1 hundredth of a second as 10, as browsers play it, and adds the frames', () => {
  assert.equal(readImage(makeGif({ delays: [0] }), 'a.gif').durationMs, 100);
  assert.equal(readImage(makeGif({ delays: [1] }), 'a.gif').durationMs, 100);
  assert.equal(readImage(makeGif({ delays: [0, 1, 2, 50] }), 'a.gif').durationMs, 100 + 100 + 20 + 500);
});

test('readImage accepts the limits themselves and refuses one more', () => {
  assert.equal(IMAGE_LIMITS.png.maxWidth, 1000);
  assert.equal(IMAGE_LIMITS.gif.maxWidth, 720);
  assert.equal(IMAGE_LIMITS.gif.maxDurationMs, 6000);
  assert.ok(Object.isFrozen(IMAGE_LIMITS) && Object.isFrozen(IMAGE_LIMITS.png) && Object.isFrozen(IMAGE_LIMITS.gif));
  assert.equal(readImage(makePng({ width: 1000 }), 'a.png').width, 1000);
  assert.match(refusal(() => readImage(makePng({ width: 1001 }), 'a.png')).message, /^a\.png: the image is 1001 px wide; a screenshot is at most 1000 px wide/);
  assert.equal(readImage(makeGif({ width: 720 }), 'a.gif').width, 720);
  assert.match(refusal(() => readImage(makeGif({ width: 721 }), 'a.gif')).message, /^a\.gif: the image is 721 px wide; a GIF is at most 720 px wide/);
  assert.equal(readImage(makeGif({ delays: [300, 300] }), 'a.gif').durationMs, 6000);
  assert.match(refusal(() => readImage(makeGif({ delays: [300, 301] }), 'a.gif')).message, /^a\.gif: the GIF plays for 6\.01 s; a GIF is at most 6 s long/);
});

test('readImage refuses first bytes that are not the extension\'s, an unknown extension and a cut-short file', () => {
  assert.match(refusal(() => readImage(makeGif(), 'a.png')).message, /^a\.png: the file does not start with the PNG signature/);
  assert.match(refusal(() => readImage(makePng(), 'a.gif')).message, /^a\.gif: the file does not start with GIF87a or GIF89a/);
  assert.match(refusal(() => readImage(Buffer.from('plain text, not a picture'), 'a.png')).message, /PNG signature/);
  assert.match(refusal(() => readImage(makePng(), 'a.jpg')).message, /^a\.jpg: an image is a \.png or a \.gif file/);
  const png = makePng();
  const gif = makeGif();
  for (const cut of [8, 20, png.length - 1, png.length - 13]) {
    assert.match(refusal(() => readImage(png.subarray(0, cut), 'a.png')).message, /^a\.png: the file is cut short/, `PNG cut at ${cut}`);
  }
  for (const cut of [6, 12, 14, gif.length - 1, gif.length - 6]) {
    assert.match(refusal(() => readImage(gif.subarray(0, cut), 'a.gif')).message, /^a\.gif: (the file is cut short|a block that is not part of a GIF)/, `GIF cut at ${cut}`);
  }
  assert.match(refusal(() => readImage(Buffer.concat([png, Buffer.from('extra')]), 'a.png')).message, /bytes after the end/);
  assert.match(refusal(() => readImage(Buffer.concat([gif, Buffer.from('extra')]), 'a.gif')).message, /bytes after the end/);
});

test('readImage refuses every PNG chunk outside the safe list and accepts each safe one', () => {
  for (const type of ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'iCCP', 'bKGD', 'sBIT', 'hIST', 'sPLT', 'acTL']) {
    assert.ok(!PNG_SAFE_CHUNKS.includes(type));
    const error = refusal(() => readImage(makePng({ extra: [pngChunk(type, Buffer.from('Comment\0secret'))] }), 'a.png'));
    assert.match(error.message, new RegExp(`^a\\.png: this image carries a ${type} chunk`));
    assert.match(error.message, /take it again without metadata/);
  }
  const lengths = { PLTE: 3, tRNS: 3, sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };
  const extra = Object.entries(lengths).map(([type, length]) => pngChunk(type, Buffer.alloc(length)));
  assert.equal(readImage(makePng({ extra }), 'a.png').width, 2);
  assert.deepEqual([...PNG_SAFE_CHUNKS], ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs']);
  assert.ok(Object.isFrozen(PNG_SAFE_CHUNKS));
});

test('readImage refuses a safe PNG chunk type with a length it cannot have, where text could ride', () => {
  const text = Buffer.from('Comment: a made-up folder and an address');
  const wrong = { sRGB: text, gAMA: Buffer.alloc(5), cHRM: Buffer.alloc(31), pHYs: Buffer.alloc(10), PLTE: Buffer.alloc(4), tRNS: Buffer.alloc(257) };
  for (const [type, data] of Object.entries(wrong)) {
    const error = refusal(() => readImage(makePng({ extra: [pngChunk(type, data)] }), 'a.png'));
    assert.match(error.message, new RegExp(`^a\\.png: this image carries a ${type} chunk of ${data.length} bytes`), type);
    assert.match(error.message, /take it again without metadata/);
  }
  assert.match(refusal(() => readImage(makePng({ extra: [pngChunk('PLTE')] }), 'a.png')).message, /PLTE chunk of 0 bytes/);
  assert.equal(readImage(makePng({ extra: [pngChunk('PLTE', Buffer.alloc(768)), pngChunk('tRNS', Buffer.alloc(256))] }), 'a.png').width, 2);
  // Text inside IEND, the last chunk: the picture ends there, so only its length says it is not empty.
  const header = makePng().subarray(8, 8 + 25);
  const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0])));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const withText = Buffer.concat([signature, header, idat, pngChunk('IEND', text)]);
  assert.match(refusal(() => readImage(withText, 'a.png')).message, new RegExp(`^a\\.png: this image carries a IEND chunk of ${text.length} bytes`));
});

test('readImage counts the time of a frame that has no graphic control block as 10 hundredths, as browsers play it', () => {
  const frame = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([2]), subBlocks(Buffer.from([0x4c, 0x01]))]);
  const bare = (count) => makeGif({ delays: [], extra: Array.from({ length: count }, () => frame) });
  assert.equal(readImage(bare(1), 'a.gif').durationMs, 100);
  assert.equal(readImage(bare(60), 'a.gif').durationMs, 6000);
  assert.match(refusal(() => readImage(bare(61), 'a.gif')).message, /^a\.gif: the GIF plays for 6\.1 s; a GIF is at most 6 s long/);
  assert.match(refusal(() => readImage(bare(200), 'a.gif')).message, /plays for 20 s/);
  // A frame with a control block takes that block's time; the next one without takes the default.
  const control = (delay) => Buffer.concat([Buffer.from([0x21, 0xf9]), subBlocks(Buffer.from([0, delay, 0, 0]))]);
  assert.equal(readImage(makeGif({ delays: [], extra: [control(50), frame, frame] }), 'a.gif').durationMs, 500 + 100);
  assert.equal(readImage(makeGif({ delays: [], extra: [frame, control(50), frame] }), 'a.gif').durationMs, 100 + 500);
});

test('readImage refuses extra sub-blocks in a NETSCAPE2.0 block and in a graphic control block', () => {
  const text = Buffer.from('Comment: a made-up folder');
  const app = (...blocks) => Buffer.concat([Buffer.from([0x21, 0xff]), subBlocks(...blocks)]);
  const loop = Buffer.from('NETSCAPE2.0');
  assert.equal(readImage(makeGif({ extra: [app(loop, Buffer.from([1, 0, 0]))] }), 'a.gif').kind, 'gif');
  assert.match(refusal(() => readImage(makeGif({ extra: [app(loop, Buffer.from([1, 0, 0]), text)] }), 'a.gif')).message, /^a\.gif: this image carries a NETSCAPE2\.0 block with more in it than the loop count/);
  assert.match(refusal(() => readImage(makeGif({ extra: [app(loop, text)] }), 'a.gif')).message, /NETSCAPE2\.0 block with more in it/);
  assert.match(refusal(() => readImage(makeGif({ extra: [app(loop)] }), 'a.gif')).message, /NETSCAPE2\.0 block with more in it/);
  const control = Buffer.concat([Buffer.from([0x21, 0xf9]), subBlocks(Buffer.from([0, 10, 0, 0]), text)]);
  assert.match(refusal(() => readImage(makeGif({ extra: [control] }), 'a.gif')).message, /^a\.gif: a graphic control block of the wrong size/);
});

test('readImage refuses a GIF comment, a plain-text block and a foreign application block, and accepts NETSCAPE2.0', () => {
  assert.match(refusal(() => readImage(makeGif({ extra: [gifComment] }), 'a.gif')).message, /^a\.gif: this image carries a comment block; take it again without metadata/);
  assert.match(refusal(() => readImage(makeGif({ extra: [gifPlainText] }), 'a.gif')).message, /^a\.gif: this image carries a plain-text block/);
  assert.match(refusal(() => readImage(makeGif({ extra: [gifApplication('XMP Data', 'XMP')] }), 'a.gif')).message, /^a\.gif: this image carries an application block other than NETSCAPE2\.0/);
  assert.equal(readImage(makeGif({ extra: [gifApplication('NETSCAPE', '2.0')] }), 'a.gif').kind, 'gif');
});

// ---- the real site ----

test('the real site builds: pages, stylesheet, links, ids, no script and nothing from another site', () => {
  withTemp((dir) => {
    const outDir = path.join(dir, 'out');
    const written = buildSite({ siteDir: realSite, outDir });
    const entries = readManual(realSite);
    const images = fs.readdirSync(path.join(realSite, 'images')).sort().map((name) => `images/${name}`);
    assert.ok(images.length > 0, 'the real site shows at least one image');
    const expected = ['index.html', ...entries.map((e) => e.file.replace(/\.md$/, '.html')), 'style.css', ...images];
    assert.deepEqual(written, expected);
    assert.equal(fs.readFileSync(path.join(outDir, 'style.css'), 'utf8'), fs.readFileSync(path.join(realSite, 'style.css'), 'utf8'));
    for (const image of images) {
      assert.ok(
        fs.readFileSync(path.join(outDir, image)).equals(fs.readFileSync(path.join(realSite, image))),
        `${image}: the copy is byte for byte`,
      );
    }

    const pages = written.filter((name) => name.endsWith('.html'));
    const idsOf = new Map();
    const html = new Map();
    for (const name of pages) {
      const text = fs.readFileSync(path.join(outDir, name), 'utf8');
      html.set(name, text);
      idsOf.set(name, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    }
    for (const [name, text] of html) {
      assert.equal(text.match(/aria-current="page"/g)?.length, 1, `${name}: one current page`);
      assert.equal(text.match(/<section class="verified">/g)?.length, 1, `${name}: one verified box`);
      assert.doesNotMatch(text, /<script/i, `${name}: no script element`);
      assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${name}: no event handler`);
      for (const tag of text.matchAll(/<(?:img|link|iframe|source|video|audio|embed|object)\b[^>]*>/gi)) {
        assert.doesNotMatch(tag[0], /(?:src|href)="https?:/i, `${name}: nothing loaded from another site: ${tag[0]}`);
      }
      // The only src attribute is the img of a figure with a caption: a written image, an alternative, a size.
      const figures = [...text.matchAll(/<figure>\n(<img [^>]*>)\n<figcaption>[\s\S]*?<\/figcaption>\n<\/figure>/g)].map((m) => m[1]);
      assert.equal(text.match(/\ssrc=/gi)?.length ?? 0, figures.length, `${name}: every src attribute belongs to the img of a figure with a caption`);
      for (const tag of figures) {
        const src = /\ssrc="(images\/[a-z0-9-]+\.(?:png|gif))"/.exec(tag)?.[1];
        assert.ok(src && written.includes(src), `${name}: ${tag} names a written image`);
        assert.match(tag, /\salt="[^"]+"/, `${name}: ${src} has an alternative`);
        assert.match(tag, /\swidth="\d+"/, `${name}: ${src} has a width`);
        assert.match(tag, /\sheight="\d+"/, `${name}: ${src} has a height`);
      }
      assert.match(text, /<link rel="stylesheet" href="style\.css">/);
      for (const m of text.matchAll(/<a\s[^>]*?href="([^"]+)"/g)) {
        const href = m[1].replaceAll('&amp;', '&');
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [file, id] = href.split('#');
        const target = file === '' ? name : file;
        assert.ok(written.includes(target), `${name}: ${href} names a written file`);
        if (id) assert.ok(idsOf.get(target)?.has(id), `${name}: ${href} names an id the page has`);
      }
    }
  });
});

// ---- refusals of the build ----

test('a good small site builds', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    const written = buildSite({ siteDir, outDir: path.join(dir, 'out') });
    assert.deepEqual(written, ['index.html', 'first.html', 'style.css']);
    const first = fs.readFileSync(path.join(dir, 'out', 'first.html'), 'utf8');
    assert.match(first, /<title>First · Moontide manual<\/title>/);
    assert.match(first, /rel="prev" href="index\.html"/);
    assert.doesNotMatch(first, /rel="next"/);
  });
});

const SITE_REFUSALS = [
  ['a page that index.md does not list', (f) => ({ ...f, 'extra.md': `# Extra\n\n${BOX}` }), /extra\.md: this page is not listed/],
  [
    'an entry for a missing page',
    (f) => ({ ...f, 'index.md': f['index.md'].replace('first.md', 'missing.md') }),
    /index\.md:5: missing\.md does not exist/,
  ],
  [
    'a link to a missing id',
    (f) => ({ ...f, 'first.md': `# First\n\nSee [here](index.md#nowhere).\n\n${BOX}` }),
    /first\.md:3: the link goes to #nowhere/,
  ],
  [
    'a link to a missing page',
    (f) => ({ ...f, 'first.md': `# First\n\nSee [here](ghost.md).\n\n${BOX}` }),
    /first\.md:3: the link goes to ghost\.md/,
  ],
  ['a page without its box', (f) => ({ ...f, 'first.md': '# First\n\nNo box.\n' }), /first\.md: the page has no "## What was verified"/],
  [
    'a box that is not the last section',
    (f) => ({ ...f, 'first.md': `# First\n\n${BOX}\n## After\n\nmore\n` }),
    /first\.md:3: "What was verified" must be the last/,
  ],
  [
    'a box without both lead words',
    (f) => ({ ...f, 'first.md': '# First\n\n## What was verified\n\n**Verified:** this only.\n' }),
    /first\.md:3: the box needs both/,
  ],
  ['an extra file in site/', (f) => ({ ...f, 'notes.txt': 'x' }), /notes\.txt: the site folder holds only/],
  ['a page that lists itself', (f) => ({ ...f, 'index.md': f['index.md'].replace('first.md', 'index.md') }), /index\.md cannot list itself/],
];

for (const [name, change, expected] of SITE_REFUSALS) {
  test(`the build refuses ${name}`, () => {
    withTemp((dir) => {
      const siteDir = writeSite(dir, change(goodFiles()));
      const outDir = path.join(dir, 'out');
      const error = refusal(() => buildSite({ siteDir, outDir }));
      assert.match(error.message, expected);
      assert.equal(fs.existsSync(outDir), false, 'nothing is written when a page is refused');
    });
  });
}

// ---- the build and the pictures ----

const PNG_A = () => makePng();
const imageSite = (extra = {}, page = FIGURE) => ({ ...withFigure(page), 'images/a.png': PNG_A(), ...extra });

test('a site with a picture builds it into a figure and copies the picture byte for byte, after style.css', () => {
  withTemp((dir) => {
    const png = makePng({ width: 640, height: 360 });
    const siteDir = writeSite(dir, { ...withFigure(FIGURE), 'images/a.png': png });
    const outDir = path.join(dir, 'out');
    assert.deepEqual(buildSite({ siteDir, outDir }), ['index.html', 'first.html', 'style.css', 'images/a.png']);
    assert.ok(fs.readFileSync(path.join(outDir, 'images', 'a.png')).equals(png));
    const html = fs.readFileSync(path.join(outDir, 'first.html'), 'utf8');
    assert.match(html, /<img src="images\/a\.png" alt="A small picture" width="640" height="360" loading="lazy" decoding="async">/);
  });
});

test('a site with a picture of each kind lists them in name order', () => {
  withTemp((dir) => {
    const page = '![One](images/b.gif)\n\n*One.*\n\nText.\n\n![Two](images/a.png)\n\n*Two.*\n';
    const siteDir = writeSite(dir, { ...withFigure(page), 'images/a.png': makePng(), 'images/b.gif': makeGif() });
    assert.deepEqual(buildSite({ siteDir, outDir: path.join(dir, 'out') }), ['index.html', 'first.html', 'style.css', 'images/a.png', 'images/b.gif']);
  });
});

test('a site with an empty images folder builds with no images entry', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    fs.mkdirSync(path.join(siteDir, 'images'));
    const outDir = path.join(dir, 'out');
    assert.deepEqual(buildSite({ siteDir, outDir }), ['index.html', 'first.html', 'style.css']);
    assert.equal(fs.existsSync(path.join(outDir, 'images')), false);
  });
});

const IMAGE_REFUSALS = [
  ['a page naming an image the folder lacks', () => withFigure(FIGURE), /first\.md:3: images\/a\.png is not a file of site\/images/],
  ['an image no page names', () => imageSite({ 'images/extra.png': makePng() }), /images\/extra\.png: no page shows this image/],
  [
    'an image shown twice on one page',
    () => imageSite({}, `${FIGURE}\nText between.\n\n${FIGURE}`),
    /images\/a\.png is shown twice: first\.md:3 and first\.md:9/,
  ],
  [
    'an image shown on two pages',
    () => ({ ...imageSite(), 'index.md': `# Home\n\n${FIGURE}\n## Part one\n\n- [First](first.md): the first page.\n\n${BOX}` }),
    /images\/a\.png is shown twice: index\.md:3 and first\.md:3/,
  ],
  ['a subfolder in site/images', () => imageSite({ 'images/sub/x.png': makePng() }), /images\/sub: the images folder holds only image files, no folder/],
  ['a text file in site/images', () => imageSite({ 'images/notes.txt': 'x' }), /images\/notes\.txt: an image name is lower-case letters/],
  ['an image name with a capital', () => imageSite({ 'images/Big.png': makePng() }), /images\/Big\.png: an image name is lower-case letters/],
  ['a .png whose first bytes are a GIF', () => imageSite({ 'images/a.png': makeGif() }), /images\/a\.png: the file does not start with the PNG signature/],
  ['a .gif whose first bytes are a PNG', () => imageSite({ 'images/a.png': PNG_A(), 'images/b.gif': makePng() }, `${FIGURE}\nText.\n\n![B](images/b.gif)\n\n*B.*\n`), /images\/b\.gif: the file does not start with GIF87a or GIF89a/],
  ['a cut-short PNG', () => imageSite({ 'images/a.png': makePng().subarray(0, 40) }), /images\/a\.png: the file is cut short/],
  ['a PNG 1001 px wide', () => imageSite({ 'images/a.png': makePng({ width: 1001 }) }), /images\/a\.png: the image is 1001 px wide/],
  ['a GIF 721 px wide', () => imageSite({ 'images/a.png': makeGif({ width: 721 }), 'images/a.gif': makeGif({ width: 721 }) }, '![G](images/a.gif)\n\n*G.*\n'), /images\/a\.gif: the image is 721 px wide/],
  ['a GIF longer than 6 s', () => imageSite({ 'images/a.gif': makeGif({ delays: [300, 301] }) }, '![G](images/a.gif)\n\n*G.*\n'), /images\/a\.gif: the GIF plays for 6\.01 s/],
  ...['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].map((type) => [
    `a PNG with a ${type} chunk`,
    () => imageSite({ 'images/a.png': makePng({ extra: [pngChunk(type, Buffer.from('k\0v'))] }) }),
    new RegExp(`images/a\\.png: this image carries a ${type} chunk`),
  ]),
  ['a GIF with a comment block', () => imageSite({ 'images/a.gif': makeGif({ extra: [gifComment] }) }, '![G](images/a.gif)\n\n*G.*\n'), /images\/a\.gif: this image carries a comment block/],
  ['a GIF with a plain-text block', () => imageSite({ 'images/a.gif': makeGif({ extra: [gifPlainText] }) }, '![G](images/a.gif)\n\n*G.*\n'), /images\/a\.gif: this image carries a plain-text block/],
  [
    'a GIF with another application block',
    () => imageSite({ 'images/a.gif': makeGif({ extra: [gifApplication('ADOBE', 'XMP')] }) }, '![G](images/a.gif)\n\n*G.*\n'),
    /images\/a\.gif: this image carries an application block other than NETSCAPE2\.0/,
  ],
];

for (const [name, files, expected] of IMAGE_REFUSALS) {
  test(`the build refuses ${name} and writes nothing`, () => {
    withTemp((dir) => {
      const siteDir = writeSite(dir, files());
      const outDir = path.join(dir, 'out');
      const error = refusal(() => buildSite({ siteDir, outDir }));
      assert.match(error.message, expected);
      assert.equal(fs.existsSync(outDir), false, 'nothing is written when an image is refused');
    });
  });
}

test('the build accepts a GIF with the NETSCAPE2.0 loop block', () => {
  withTemp((dir) => {
    const gif = makeGif({ extra: [], delays: [10, 10] });
    const withLoop = Buffer.concat([gif.subarray(0, 19), Buffer.from([0x21, 0xff]), subBlocks(Buffer.from('NETSCAPE2.0'), Buffer.from([1, 0, 0])), gif.subarray(19)]);
    const siteDir = writeSite(dir, { ...withFigure('![G](images/a.gif)\n\n*G.*\n'), 'images/a.gif': withLoop });
    assert.deepEqual(buildSite({ siteDir, outDir: path.join(dir, 'out') }).at(-1), 'images/a.gif');
  });
});

test('the build refuses an output folder that is not empty and never touches it', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'keep.txt'), 'keep');
    const error = refusal(() => buildSite({ siteDir, outDir }));
    assert.match(error.message, /not empty/);
    assert.equal(error.exitCode, 2);
    assert.deepEqual(fs.readdirSync(outDir), ['keep.txt']);
  });
});

test('the build refuses an output folder inside site/', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    const error = refusal(() => buildSite({ siteDir, outDir: path.join(siteDir, 'out') }));
    assert.match(error.message, /inside it/);
    assert.equal(error.exitCode, 2);
    assert.deepEqual(fs.readdirSync(siteDir).sort(), ['first.md', 'index.md', 'style.css']);
  });
});

test('a heading called Text or Contents cannot collide with the ids of the page layout', () => {
  withTemp((dir) => {
    const files = goodFiles();
    files['first.md'] = `# First\n\n## Text\n\nsome\n\n## Manual\n\nmore\n\n## Contents\n\nhere\n\n${BOX}`;
    const siteDir = writeSite(dir, files);
    const outDir = path.join(dir, 'out');
    buildSite({ siteDir, outDir });
    const html = fs.readFileSync(path.join(outDir, 'first.html'), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `every id is unique: ${ids.join(', ')}`);
    for (const id of ['text', 'manual', 'contents']) assert.ok(ids.includes(id), `the heading id ${id} is kept`);
    for (const m of html.matchAll(/<a [^>]*href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), `#${m[1]} names an id of the page`);
    assert.match(html, /<a class="skip" href="#page:text">/);
    assert.match(html, /<main id="page:text">/);
  });
});

test('the build refuses an output folder whose name only starts with two dots, as it lies inside site/', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    const error = refusal(() => buildSite({ siteDir, outDir: path.join(siteDir, '..hidden') }));
    assert.match(error.message, /inside it/);
    assert.equal(error.exitCode, 2);
    assert.deepEqual(fs.readdirSync(siteDir).sort(), ['first.md', 'index.md', 'style.css']);
  });
});

test('the build accepts an output folder next to site/ whose name starts with two dots', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    const outDir = path.join(dir, '..out');
    assert.deepEqual(buildSite({ siteDir, outDir }), ['index.html', 'first.html', 'style.css']);
  });
});

test('the build accepts an existing empty output folder', () => {
  withTemp((dir) => {
    const siteDir = writeSite(dir, goodFiles());
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    assert.deepEqual(buildSite({ siteDir, outDir }), ['index.html', 'first.html', 'style.css']);
  });
});

// ---- the command line ----

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('the CLI without --out exits 2 and prints the usage line', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node scripts\/build-site\.mjs --out <empty folder>/);
});

test('the CLI refuses an unknown option and a positional argument with exit 2', () => {
  assert.equal(runCli(['--nope']).status, 2);
  assert.equal(runCli(['--out', os.tmpdir(), 'extra']).status, 2);
});

test('the CLI builds the real site into an empty folder and prints one line', () => {
  withTemp((dir) => {
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    const result = runCli(['--out', outDir]);
    assert.equal(result.status, 0, result.stderr);
    const pages = fs.readdirSync(outDir).filter((name) => name.endsWith('.html')).length;
    const images = fs.readdirSync(path.join(outDir, 'images')).length;
    assert.equal(result.stdout, `site: ${pages} pages and ${images} ${images === 1 ? 'image' : 'images'} written to ${outDir}\n`);
  });
});

test('the CLI exits 2 on an output folder that is not empty', () => {
  withTemp((dir) => {
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    const result = runCli(['--out', dir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^site: /);
  });
});
