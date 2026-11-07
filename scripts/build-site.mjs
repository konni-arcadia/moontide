#!/usr/bin/env node
// Builds the user manual: the Markdown pages of site/ become static HTML pages in a folder you give,
// with one hand-made stylesheet (site/style.css), a navigation in the order of site/index.md, previous
// and next links and a "What was verified" box on every page.
//
// Usage: node scripts/build-site.mjs --out <empty folder>
//
// Needs no install: Node 22+ and node: built-ins only, no shell, the same on macOS, Linux and Windows.
// It refuses rather than guesses: Markdown outside the small subset below, a broken link, a page the
// index does not list, a page without its verified box, a stray file in site/, an output folder that
// is not missing or empty. Every refusal names the file, the line when there is one, and the reason.
//
// The Markdown subset, written the way GitHub reads it so a page looks the same in both places:
//   - one "# Title" first line, then "##" and "###" headings (each gets an id by GitHub's rule);
//   - paragraphs, "- " and "1. " lists nested by indentation, fenced code blocks with three backticks;
//   - inline code, **bold**, *italic*, [text](target) links and bare https:// addresses;
//   - figures: a line that holds only ![text alternative](images/name.png), a blank line, then a caption
//     paragraph written wholly in italics. The image is a .png or .gif file of site/images/.
// Refused: raw HTML, tables, images anywhere else, quotes, deeper headings, rules, indented code, a fence
// inside a list item, a backslash outside backticks, parentheses in a link address, and any link target
// but https, http, mailto, "#id" or "page.md" / "page.md#id". A bare address inside link text stays text.
//
// Images: site/images/ may hold the manual's pictures and nothing else. Every picture is read by its first
// bytes (readImage), must be shown by exactly one figure, and is copied byte for byte into the output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SITE_DIR = path.join(SCRIPT_DIR, '..', 'site');
const PACKAGE_JSON = path.join(SCRIPT_DIR, '..', 'package.json');

const MANUAL_NAME = 'Moontide manual';
const VERIFIED_ID = 'what-was-verified';
const STYLE_FILE = 'style.css';
// Ids of the page layout. A colon cannot appear in a heading id (headingId drops it), so no heading
// and no "#id" link can ever collide with these.
const MAIN_ID = 'page:text';
const CONTENTS_ID = 'page:contents';

// Exit codes: 0 success; 1 the content of a page is refused; 2 a usage or environment refusal.
export class SiteError extends Error {
  constructor(message, { exitCode = 1, usage = false } = {}) {
    super(message);
    this.name = 'SiteError';
    this.exitCode = exitCode;
    this.usage = usage;
  }
}

const refuse = (file, line, reason) =>
  new SiteError(line ? `${file}:${line}: ${reason}` : `${file}: ${reason}`);

// ---- Images ----

const IMAGES_DIR = 'images';
// An image name: lower-case letters and digits in words joined by single hyphens, then .png or .gif.
export const IMAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|gif)$/;

// What a picture may weigh in width and length. A screenshot is at most 1000 px wide; a GIF at most 720 px
// wide and 6 seconds long.
export const IMAGE_LIMITS = Object.freeze({
  png: Object.freeze({ maxWidth: 1000 }),
  gif: Object.freeze({ maxWidth: 720, maxDurationMs: 6000 }),
});

// The PNG chunks a picture of the manual may carry: the picture itself and its colors, nothing that holds
// text, a time or camera data.
export const PNG_SAFE_CHUNKS = Object.freeze(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Whether a chunk of an allowed type has a length that type can have. A chunk of an allowed type with any
// other length could hold text instead of its few numbers, so the type alone does not make it safe. IDAT is the
// picture itself and has no fixed length.
export function pngChunkLengthOk(type, length) {
  switch (type) {
    case 'IHDR': return length === 13;
    case 'IEND': return length === 0;
    case 'sRGB': return length === 1;
    case 'gAMA': return length === 4;
    case 'cHRM': return length === 32;
    case 'pHYs': return length === 9;
    case 'PLTE': return length >= 3 && length <= 768 && length % 3 === 0;
    case 'tRNS': return length <= 256;
    default: return true;
  }
}

function readPng(bytes, name) {
  const bad = (reason) => new SiteError(`${name}: ${reason}`);
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw bad('the file does not start with the PNG signature, so it is not a PNG');
  }
  let at = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let first = true;
  for (;;) {
    if (at + 12 > bytes.length) throw bad('the file is cut short');
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > bytes.length) throw bad('the file is cut short');
    if (!PNG_SAFE_CHUNKS.includes(type)) {
      throw bad(`this image carries a ${type} chunk, which can hold text, a time or camera data; take it again without metadata`);
    }
    if (!pngChunkLengthOk(type, length)) {
      throw bad(`this image carries a ${type} chunk of ${length} bytes, which is not a length a ${type} chunk has and could hold text; take it again without metadata`);
    }
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw bad('the first chunk is not a valid IHDR');
      width = bytes.readUInt32BE(at + 8);
      height = bytes.readUInt32BE(at + 12);
      first = false;
    }
    at += 12 + length;
    if (type === 'IEND') break;
  }
  if (at !== bytes.length) throw bad('there are bytes after the end of the image');
  if (width === 0 || height === 0) throw bad('the image has no size');
  if (width > IMAGE_LIMITS.png.maxWidth) {
    throw bad(`the image is ${width} px wide; a screenshot is at most ${IMAGE_LIMITS.png.maxWidth} px wide`);
  }
  return { kind: 'png', width, height, durationMs: 0 };
}

// Reads the sub-blocks that start at `at` (a size byte, that many bytes, again, until a size of 0). Gives where
// the next block starts, how many sub-blocks there were and the first two of them. `cutShort()` makes the error
// to throw when the bytes end inside the sub-blocks.
export function readSubBlocks(bytes, at, cutShort) {
  const blocks = [];
  let count = 0;
  for (;;) {
    if (at >= bytes.length) throw cutShort();
    const size = bytes[at];
    at += 1;
    if (size === 0) return { next: at, count, blocks };
    if (at + size > bytes.length) throw cutShort();
    if (blocks.length < 2) blocks.push(bytes.subarray(at, at + size));
    count += 1;
    at += size;
  }
}

// A graphic control block is exactly one sub-block of 4 bytes; a NETSCAPE2.0 loop block is exactly the 11-byte
// name and one sub-block of 3 bytes. Anything more is room for text inside a block that is allowed.
export const isGraphicControl = (sub) => sub.count === 1 && sub.blocks[0].length === 4;
export const isNetscapeLoop = (sub) =>
  sub.count === 2 && sub.blocks[0].toString('latin1') === 'NETSCAPE2.0' && sub.blocks[1].length === 3;

function readGif(bytes, name) {
  const bad = (reason) => new SiteError(`${name}: ${reason}`);
  const header = bytes.toString('latin1', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') throw bad('the file does not start with GIF87a or GIF89a, so it is not a GIF');
  if (bytes.length < 13) throw bad('the file is cut short');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const tableSize = (packed) => 3 * 2 ** ((packed & 7) + 1);
  let at = 13;
  if (bytes[10] & 0x80) at += tableSize(bytes[10]);
  const cutShort = () => bad('the file is cut short');
  // A browser shows an image block for the delay of the graphic control block just before it, and for 10
  // hundredths of a second when there is none, so time is counted at each image block.
  let hundredths = 0;
  let pending = null;
  let ended = false;
  while (!ended) {
    if (at >= bytes.length) throw bad('the file is cut short');
    const block = bytes[at];
    if (block === 0x3b) {
      at += 1;
      ended = true;
    } else if (block === 0x21) {
      if (at + 2 > bytes.length) throw bad('the file is cut short');
      const label = bytes[at + 1];
      const sub = readSubBlocks(bytes, at + 2, cutShort);
      const metadata = 'take it again without metadata';
      if (label === 0xf9) {
        if (!isGraphicControl(sub)) throw bad('a graphic control block of the wrong size');
        const delay = sub.blocks[0].readUInt16LE(1);
        pending = delay <= 1 ? 10 : delay;
      } else if (label === 0xfe) {
        throw bad(`this image carries a comment block; ${metadata}`);
      } else if (label === 0x01) {
        throw bad(`this image carries a plain-text block; ${metadata}`);
      } else if (label === 0xff) {
        if (sub.count === 0 || sub.blocks[0].toString('latin1') !== 'NETSCAPE2.0') {
          throw bad(`this image carries an application block other than NETSCAPE2.0; ${metadata}`);
        }
        if (!isNetscapeLoop(sub)) {
          throw bad(`this image carries a NETSCAPE2.0 block with more in it than the loop count; ${metadata}`);
        }
      } else {
        throw bad(`this image carries an extension block it may not; ${metadata}`);
      }
      at = sub.next;
    } else if (block === 0x2c) {
      if (at + 10 > bytes.length) throw bad('the file is cut short');
      const packed = bytes[at + 9];
      at += 10;
      if (packed & 0x80) at += tableSize(packed);
      at += 1;
      at = readSubBlocks(bytes, at, cutShort).next;
      hundredths += pending ?? 10;
      pending = null;
    } else {
      throw bad('a block that is not part of a GIF');
    }
  }
  if (at !== bytes.length) throw bad('there are bytes after the end of the image');
  if (width === 0 || height === 0) throw bad('the image has no size');
  const durationMs = hundredths * 10;
  if (width > IMAGE_LIMITS.gif.maxWidth) {
    throw bad(`the image is ${width} px wide; a GIF is at most ${IMAGE_LIMITS.gif.maxWidth} px wide`);
  }
  if (durationMs > IMAGE_LIMITS.gif.maxDurationMs) {
    throw bad(`the GIF plays for ${durationMs / 1000} s; a GIF is at most ${IMAGE_LIMITS.gif.maxDurationMs / 1000} s long`);
  }
  return { kind: 'gif', width, height, durationMs };
}

// Reads a picture's header without decoding a pixel. `name` is the name to show in a refusal; its ending
// (.png or .gif) says what the first bytes must be. Gives { kind, width, height, durationMs } (durationMs is
// 0 for a PNG) and throws a SiteError naming the file and the reason.
export function readImage(bytes, name) {
  if (/\.png$/.test(name)) return readPng(bytes, name);
  if (/\.gif$/.test(name)) return readGif(bytes, name);
  throw new SiteError(`${name}: an image is a .png or a .gif file`);
}

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- Markdown ----

// GitHub's heading id: lower case, drop what is not a letter, a digit, a space, a hyphen or an
// underscore, spaces become hyphens.
function headingId(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

// The words of a heading without its markup, for the id and the page title.
function plainText(markup) {
  return markup
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*+/g, '')
    .trim();
}

const indentOf = (text) => text.length - text.trimStart().length;
const ITEM = /^( *)(-|\d{1,9}\.)( +)(\S.*)$/;
const BARE_MARKER = /^ *(?:-|\d{1,9}\.)\s*$/;
const FENCE = /^`{3,}/;

// Lines that start a construct the subset does not have.
function refuseUnsupportedLine(rec, ctx) {
  const t = rec.text.trimStart();
  const no = rec.no;
  if (t.startsWith('|')) throw refuse(ctx.file, no, 'a table is not supported; write a list');
  if (t.startsWith('>')) throw refuse(ctx.file, no, 'a quote line is not supported');
  if (/^<[A-Za-z/!?]/.test(t)) throw refuse(ctx.file, no, 'raw HTML is not supported');
  if (/^(?:=+|-{2,}|\*{3,}|_{3,})\s*$/.test(t)) throw refuse(ctx.file, no, 'a setext underline or a horizontal rule is not supported');
  if (/^[*+] +\S/.test(t)) throw refuse(ctx.file, no, 'start a list item with "- "');
  if (BARE_MARKER.test(rec.text)) throw refuse(ctx.file, no, 'an empty list item');
  if (rec.text.includes('\u0000')) throw refuse(ctx.file, no, 'a control character in the text');
}

// Turns the inline Markup of a paragraph or heading into HTML. lineAt(index) names the file line of a
// character of `raw`, for refusals. Relative links are collected in ctx.links.
function renderInline(raw, ctx, lineAt) {
  const codes = new Map();
  let prot = '';
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === '\\') throw refuse(ctx.file, lineAt(i), 'a backslash is not supported; rephrase, or put the text in backticks');
    if (raw[i] !== '`') {
      prot += raw[i];
      i += 1;
      continue;
    }
    let n = 0;
    while (raw[i + n] === '`') n += 1;
    let found = -1;
    for (let j = i + n; j < raw.length; ) {
      if (raw[j] !== '`') {
        j += 1;
        continue;
      }
      let m = 0;
      while (raw[j + m] === '`') m += 1;
      if (m === n) {
        found = j;
        break;
      }
      j += m;
    }
    if (found < 0) throw refuse(ctx.file, lineAt(i), 'a backtick that closes nothing');
    let content = raw.slice(i + n, found);
    if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    codes.set(i, content);
    prot += '\u0000'.repeat(found + n - i);
    i = found + n;
  }

  const imageAt = prot.indexOf('![');
  if (imageAt >= 0) {
    throw refuse(ctx.file, lineAt(imageAt), 'an image stands alone on its line with its caption in italics after it; it cannot sit inside text, a list, a heading or a caption');
  }
  const tagAt = prot.search(/<[A-Za-z/!?]/);
  if (tagAt >= 0) throw refuse(ctx.file, lineAt(tagAt), 'raw HTML is not supported; put code in backticks');

  const pattern =
    /\u0000+|\[([^\]]*)\]\(([^)\s]*)\)|\*\*(?=\S)(.+?)(?<=\S)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|https?:\/\/[^\s<>()\u0000]*[^\s<>()\u0000.,;:!?'"]/gi;

  const plain = (from, to) => {
    const text = prot.slice(from, to);
    const bad = text.indexOf('](');
    if (bad >= 0) throw refuse(ctx.file, lineAt(from + bad), 'a link that could not be read; write [text](target)');
    return escapeHtml(text);
  };

  // inLink is true inside link text: a bare address there stays plain text, so no anchor holds another.
  const render = (from, to, inLink = false) => {
    let html = '';
    let last = from;
    for (const m of prot.slice(from, to).matchAll(pattern)) {
      const at = from + m.index;
      html += plain(last, at);
      last = at + m[0].length;
      if (m[0][0] === '\u0000') {
        html += `<code>${escapeHtml(codes.get(at))}</code>`;
      } else if (m[0][0] === '[') {
        if (m[1] === '') throw refuse(ctx.file, lineAt(at), 'a link with no text');
        const href = linkHref(m[2], ctx, lineAt(at));
        html += `<a href="${escapeHtml(href)}">${render(at + 1, at + 1 + m[1].length, true)}</a>`;
      } else if (m[0].startsWith('**')) {
        html += `<strong>${render(at + 2, at + 2 + m[3].length, inLink)}</strong>`;
      } else if (m[0][0] === '*') {
        html += `<em>${render(at + 1, at + 1 + m[4].length, inLink)}</em>`;
      } else if (prot[at + m[0].length] === '(') {
        throw refuse(ctx.file, lineAt(at), 'parentheses in a bare address are not supported; write [text](address) with an address without parentheses');
      } else if (inLink) {
        html += escapeHtml(m[0]);
      } else {
        html += `<a href="${escapeHtml(linkHref(m[0], ctx, lineAt(at)))}">${escapeHtml(m[0])}</a>`;
      }
    }
    return html + plain(last, to);
  };

  return render(0, prot.length);
}

// Checks a link target and returns the href to write. A relative page link is recorded for the
// cross-page check once every page is known.
function linkHref(target, ctx, line) {
  if (target === '') throw refuse(ctx.file, line, 'a link with no target');
  const noParentheses = () => {
    if (target.includes('(')) throw refuse(ctx.file, line, 'parentheses in a link address are not supported; use an address without them');
  };
  if (/^https?:\/\//i.test(target)) {
    noParentheses();
    try {
      new URL(target);
    } catch {
      throw refuse(ctx.file, line, 'a link address that is not valid');
    }
    return target;
  }
  if (/^mailto:\S+$/i.test(target)) {
    noParentheses();
    return target;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    throw refuse(ctx.file, line, 'a link scheme other than https, http and mailto is not supported');
  }
  let m = /^#([^#\s]+)$/.exec(target);
  if (m) {
    ctx.links.push({ page: null, id: m[1], line });
    return target;
  }
  m = /^([A-Za-z0-9_-]+)\.md(?:#([^#\s]+))?$/.exec(target);
  if (m) {
    ctx.links.push({ page: `${m[1]}.md`, id: m[2] ?? null, line });
    return `${m[1]}.html${m[2] ? `#${m[2]}` : ''}`;
  }
  throw refuse(ctx.file, line, 'a link target must be an https address, #id, or a page of the manual such as install.md');
}

// Joins the lines of one paragraph into one string and gives a function that names the file line of a
// character of it.
function joinLines(lines) {
  const starts = [];
  let joined = '';
  for (const rec of lines) {
    if (joined !== '') joined += ' ';
    starts.push({ at: joined.length, no: rec.no });
    joined += rec.text.trim();
  }
  const lineAt = (index) => {
    let no = starts[0].no;
    for (const s of starts) if (s.at <= index) no = s.no;
    return no;
  };
  return { joined, lineAt };
}

function paragraphBlock(recs, i, ctx) {
  const lines = [];
  let j = i;
  while (j < recs.length && recs[j].text.trim() !== '') {
    const rec = recs[j];
    if (j > i) {
      if (/^#+(\s|$)/.test(rec.text) || FENCE.test(rec.text)) break;
      if (ITEM.test(rec.text)) {
        // Inside a list item a nested list may follow its text at once; elsewhere it needs a blank line.
        if (ctx.inList) break;
        throw refuse(ctx.file, rec.no, 'put a blank line before a list');
      }
    }
    refuseUnsupportedLine(rec, ctx);
    lines.push(rec);
    j += 1;
  }
  const { joined, lineAt } = joinLines(lines);
  const inner = renderInline(joined, ctx, lineAt);
  return { next: j, block: { type: 'p', line: recs[i].no, inner, html: `<p>${inner}</p>` } };
}

// A figure: one line that holds only ![text alternative](images/name.png), a blank line, then a caption
// paragraph written wholly in italics. Anything else around an image is refused.
const FIGURE_LINE = /^!\[([^\]]*)\]\(([^)\s]*)\)$/;

function figureBlock(recs, i, ctx, previous) {
  const rec = recs[i];
  const m = FIGURE_LINE.exec(rec.text.trimEnd());
  if (!m) {
    throw refuse(ctx.file, rec.no, 'an image stands alone on its line, written ![text alternative](images/name.png), with its caption in italics after it');
  }
  if (i + 1 < recs.length && recs[i + 1].text.trim() !== '') {
    throw refuse(ctx.file, rec.no, 'an image stands alone on its line: put a blank line after it, then its caption in italics');
  }
  if (previous && previous.type === 'figure') throw refuse(ctx.file, rec.no, 'two images in a row; put text between them');
  const alt = m[1].trim();
  if (alt === '') throw refuse(ctx.file, rec.no, 'an image needs a text alternative between the brackets');
  if (/[`*[\]]/.test(alt)) throw refuse(ctx.file, rec.no, 'the text alternative is plain words: no backtick, asterisk or bracket');
  const target = m[2];
  if (!target.startsWith(`${IMAGES_DIR}/`)) {
    throw refuse(ctx.file, rec.no, `an image comes from the images folder: write ${IMAGES_DIR}/name.png`);
  }
  const file = target.slice(IMAGES_DIR.length + 1);
  if (!IMAGE_NAME.test(file)) {
    throw refuse(ctx.file, rec.no, `"${file}" is not an image name: use lower-case letters and digits in words joined by single hyphens, then .png or .gif, directly in ${IMAGES_DIR}/`);
  }

  let size = '';
  if (ctx.imageFacts !== null) {
    const facts = ctx.imageFacts.get(file);
    if (!facts) throw refuse(ctx.file, rec.no, `${IMAGES_DIR}/${file} is not a file of site/${IMAGES_DIR}`);
    size = ` width="${facts.width}" height="${facts.height}"`;
  }

  const noCaption = `the image ${IMAGES_DIR}/${file} has no caption: the next paragraph must be wholly in italics, *like this*`;
  let j = i + 1;
  while (j < recs.length && recs[j].text.trim() === '') j += 1;
  if (j >= recs.length || !/^\*(?!\*)/.test(recs[j].text)) throw refuse(ctx.file, rec.no, noCaption);
  const lines = [];
  let k = j;
  while (k < recs.length && recs[k].text.trim() !== '') {
    const line = recs[k];
    if (k > j && (/^#+(\s|$)/.test(line.text) || FENCE.test(line.text) || ITEM.test(line.text))) {
      throw refuse(ctx.file, line.no, 'put a blank line after the caption');
    }
    refuseUnsupportedLine(line, ctx);
    lines.push(line);
    k += 1;
  }
  const { joined, lineAt } = joinLines(lines);
  const inner = joined.slice(1, -1);
  const masked = joined.replace(/(`+)[\s\S]*?\1/g, '\u0000');
  const pairs = masked.match(/\*\*/g)?.length ?? 0;
  const wholly =
    joined.length >= 3 &&
    joined.endsWith('*') &&
    !joined.endsWith('**') &&
    !/^[\s*]/.test(inner) &&
    !/[\s*]$/.test(inner) &&
    pairs % 2 === 0 &&
    !masked.slice(1, -1).replaceAll('**', '').includes('*');
  if (!wholly) throw refuse(ctx.file, lines[0].no, noCaption);

  const caption = renderInline(inner, ctx, (index) => lineAt(index + 1));
  ctx.images.push({ name: file, line: rec.no });
  const html =
    '<figure>\n' +
    `<img src="${IMAGES_DIR}/${file}" alt="${escapeHtml(alt)}"${size} loading="lazy" decoding="async">\n` +
    `<figcaption>${caption}</figcaption>\n` +
    '</figure>';
  return { next: k, block: { type: 'figure', line: rec.no, html } };
}

function headingBlock(recs, i, ctx) {
  const rec = recs[i];
  const m = /^(#+)(?:\s+(.*))?$/.exec(rec.text.trimEnd());
  const level = m[1].length;
  if (ctx.inList) throw refuse(ctx.file, rec.no, 'a heading inside a list item is not supported');
  if (level > 3) throw refuse(ctx.file, rec.no, 'a heading of four or more hashes is not supported');
  const markup = (m[2] ?? '').replace(/\s+#+\s*$/, '').trim();
  if (markup === '') throw refuse(ctx.file, rec.no, 'a heading with no text');
  if (level === 1) {
    if (ctx.title !== null) throw refuse(ctx.file, rec.no, 'a page holds exactly one "# Title" heading');
    ctx.title = plainText(markup);
    return { next: i + 1, block: { type: 'h1', line: rec.no, html: `<h1>${renderInline(markup, ctx, () => rec.no)}</h1>` } };
  }
  const id = headingId(plainText(markup));
  if (id === '') throw refuse(ctx.file, rec.no, 'a heading that gives an empty id');
  if (ctx.ids.has(id)) throw refuse(ctx.file, rec.no, `the heading id "${id}" is used twice on this page`);
  ctx.ids.add(id);
  const html = `<h${level} id="${id}">${renderInline(markup, ctx, () => rec.no)}</h${level}>`;
  return { next: i + 1, block: { type: `h${level}`, id, line: rec.no, html } };
}

function fenceBlock(recs, i, ctx) {
  const open = recs[i];
  if (ctx.inList) throw refuse(ctx.file, open.no, 'a fenced code block inside a list item is not supported');
  const m = /^```([A-Za-z0-9_+#.-]*)\s*$/.exec(open.text);
  if (!m) throw refuse(ctx.file, open.no, 'a code fence is three backticks and an optional language word');
  const code = [];
  let j = i + 1;
  while (j < recs.length && !/^```\s*$/.test(recs[j].text)) {
    code.push(recs[j].text);
    j += 1;
  }
  if (j >= recs.length) throw refuse(ctx.file, open.no, 'a code fence that is never closed');
  const cls = m[1] ? ` class="language-${escapeHtml(m[1])}"` : '';
  const html = `<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`;
  return { next: j + 1, block: { type: 'pre', line: open.no, html } };
}

function listBlock(recs, i, ctx) {
  const region = [];
  let j = i;
  while (j < recs.length) {
    const t = recs[j].text;
    if (t.trim() === '') {
      let k = j + 1;
      while (k < recs.length && recs[k].text.trim() === '') k += 1;
      if (k >= recs.length) break;
      if (indentOf(recs[k].text) > 0 || ITEM.test(recs[k].text)) {
        region.push(...recs.slice(j, k));
        j = k;
        continue;
      }
      break;
    }
    if (indentOf(t) === 0 && !ITEM.test(t)) {
      throw refuse(ctx.file, recs[j].no, 'put a blank line after a list');
    }
    region.push(recs[j]);
    j += 1;
  }

  const items = [];
  for (const rec of region) {
    const m = indentOf(rec.text) === 0 ? ITEM.exec(rec.text) : null;
    if (m) {
      if (m[3].length > 4) throw refuse(ctx.file, rec.no, 'too many spaces after a list marker');
      const width = m[2].length + m[3].length;
      items.push({ ordered: m[2] !== '-', number: Number.parseInt(m[2], 10), width, recs: [{ text: m[4], no: rec.no }] });
      continue;
    }
    const item = items[items.length - 1];
    if (rec.text.trim() === '') {
      item.recs.push({ text: '', no: rec.no });
      continue;
    }
    if (indentOf(rec.text) < item.width) {
      throw refuse(
        ctx.file,
        rec.no,
        `indent a line inside a list item by the width of its marker (${item.width} spaces here)`,
      );
    }
    item.recs.push({ text: rec.text.slice(item.width), no: rec.no });
  }

  let html = '';
  for (let a = 0; a < items.length; ) {
    let b = a;
    while (b < items.length && items[b].ordered === items[a].ordered) b += 1;
    const tag = items[a].ordered ? 'ol' : 'ul';
    const start = items[a].ordered && items[a].number !== 1 ? ` start="${items[a].number}"` : '';
    html += `<${tag}${start}>\n`;
    for (const item of items.slice(a, b)) {
      const blocks = parseBlocks(item.recs, { ...ctx, inList: true });
      const paragraphs = blocks.filter((x) => x.type === 'p').length;
      const bare = paragraphs === 1 && blocks[0].type === 'p';
      const body = blocks.map((x) => (x.type === 'p' && bare ? x.inner : x.html)).join('\n');
      html += `<li>${body}</li>\n`;
    }
    html += `</${tag}>\n`;
    a = b;
  }
  return { next: j, block: { type: 'list', line: recs[i].no, html: html.trimEnd() } };
}

function parseBlocks(recs, ctx) {
  const blocks = [];
  let i = 0;
  while (i < recs.length) {
    const rec = recs[i];
    if (rec.text.trim() === '') {
      i += 1;
      continue;
    }
    let result;
    if (FENCE.test(rec.text)) {
      result = fenceBlock(recs, i, ctx);
    } else {
      refuseUnsupportedLine(rec, ctx);
      if (indentOf(rec.text) > 0) throw refuse(ctx.file, rec.no, 'indented text outside a list is not supported');
      if (rec.text.startsWith('![') && !ctx.inList) result = figureBlock(recs, i, ctx, blocks[blocks.length - 1]);
      else if (/^#+(\s|$)/.test(rec.text)) result = headingBlock(recs, i, ctx);
      else if (ITEM.test(rec.text)) result = listBlock(recs, i, ctx);
      else result = paragraphBlock(recs, i, ctx);
    }
    blocks.push(result.block);
    i = result.next;
  }
  return blocks;
}

// Renders one page. Returns the title, the HTML of the body, the heading ids, the relative links to
// check once every page is known, the images it shows (name and line), and what the page says about its
// verified box. `imageFacts` is a Map from an image name to its width and height: with it an image gets its
// size and an image that is not in it is refused; without it (the claims checker, unit tests) no size is
// written.
export function renderMarkdown(text, file = 'page.md', imageFacts = null) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const recs = source.split(/\r?\n/).map((line, index) => ({ text: line, no: index + 1 }));
  const first = recs.find((rec) => rec.text.trim() !== '');
  if (!first || !/^# \S/.test(first.text)) {
    throw refuse(file, first ? first.no : 0, 'a page starts with a "# Title" line');
  }
  const ctx = { file, inList: false, title: null, ids: new Set(), links: [], images: [], imageFacts };
  const blocks = parseBlocks(recs, ctx);

  const verifiedAt = blocks.findIndex((b) => b.type === 'h2' && b.id === VERIFIED_ID);
  let verified = null;
  let htmlBlocks = blocks.map((b) => b.html);
  if (verifiedAt >= 0) {
    let end = blocks.findIndex((b, index) => index > verifiedAt && b.type === 'h2');
    const isLast = end < 0;
    if (isLast) end = blocks.length;
    const from = blocks[verifiedAt].line;
    const section = recs.filter((rec) => rec.no >= from).map((rec) => rec.text).join('\n');
    verified = {
      line: from,
      isLast,
      hasVerified: section.includes('**Verified:**'),
      hasNotVerified: section.includes('**Not verified:**'),
    };
    htmlBlocks = [
      ...htmlBlocks.slice(0, verifiedAt),
      '<section class="verified">',
      ...htmlBlocks.slice(verifiedAt, end),
      '</section>',
      ...htmlBlocks.slice(end),
    ];
  }
  return { title: ctx.title, html: htmlBlocks.join('\n'), ids: [...ctx.ids], links: ctx.links, images: ctx.images, verified };
}

// ---- The manual ----

const ENTRY = /^\s*(?:-|\d+\.)\s+\[[^\]]+\]\(([A-Za-z0-9_-]+\.md)(?:#[^)\s]*)?\)/;

// The pages of the manual in order, read from the list items of index.md that start with a link to a
// page: the nearest "##" heading above an item is its part.
export function readManual(siteDir) {
  let names;
  try {
    names = fs.readdirSync(siteDir, { withFileTypes: true });
  } catch (error) {
    throw new SiteError(`the site folder cannot be read (${error.code ?? 'error'})`, { exitCode: 2 });
  }
  for (const entry of names) {
    const ok =
      (entry.isFile() && (entry.name === STYLE_FILE || /^[A-Za-z0-9_-]+\.md$/.test(entry.name))) ||
      (entry.isDirectory() && entry.name === IMAGES_DIR);
    if (!ok) throw new SiteError(`${entry.name}: the site folder holds only .md pages, ${STYLE_FILE} and an ${IMAGES_DIR} folder`);
  }
  if (!names.some((entry) => entry.name === 'index.md')) throw new SiteError('index.md: the manual has no index.md');

  const lines = fs.readFileSync(path.join(siteDir, 'index.md'), 'utf8').split(/\r?\n/);
  const entries = [];
  let part = null;
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      part = plainText(heading[1]);
      return;
    }
    const m = ENTRY.exec(line);
    if (!m) return;
    const file = m[1];
    if (file === 'index.md') throw refuse('index.md', index + 1, 'index.md cannot list itself');
    if (part === null) throw refuse('index.md', index + 1, 'a page entry needs a "##" part heading above it');
    if (entries.some((e) => e.file === file)) throw refuse('index.md', index + 1, `${file} is listed twice`);
    if (!names.some((entry) => entry.name === file)) throw refuse('index.md', index + 1, `${file} does not exist in the site folder`);
    const title = renderMarkdown(fs.readFileSync(path.join(siteDir, file), 'utf8'), file).title;
    entries.push({ file, title, part, line: index + 1 });
  });
  for (const entry of names) {
    if (entry.name === 'index.md' || entry.name === STYLE_FILE || entry.name === IMAGES_DIR) continue;
    if (!entries.some((e) => e.file === entry.name)) {
      throw new SiteError(`${entry.name}: this page is not listed in index.md`);
    }
  }
  return entries;
}

// ---- HTML pages ----

function repositoryAddress() {
  let url;
  try {
    url = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).repository?.url;
  } catch (error) {
    throw new SiteError(`package.json cannot be read (${error.code ?? 'error'})`, { exitCode: 2 });
  }
  const address = typeof url === 'string' ? url.replace(/^git\+/, '').replace(/\.git$/, '') : '';
  if (!/^https:\/\/\S+$/.test(address)) {
    throw new SiteError('package.json has no https repository address', { exitCode: 2 });
  }
  return address;
}

const htmlName = (file) => file.replace(/\.md$/, '.html');

function navigation(entries, current) {
  const link = (file, label) => {
    const here = file === current ? ' aria-current="page"' : '';
    return `<a href="${htmlName(file)}"${here}>${escapeHtml(label)}</a>`;
  };
  let html = `<nav id="${CONTENTS_ID}" class="manual" aria-label="Manual">\n<p class="home">${link('index.md', 'Home')}</p>\n`;
  const parts = [...new Set(entries.map((e) => e.part))];
  for (const part of parts) {
    html += `<h2>${escapeHtml(part)}</h2>\n<ul>\n`;
    for (const entry of entries.filter((e) => e.part === part)) html += `<li>${link(entry.file, entry.title)}</li>\n`;
    html += '</ul>\n';
  }
  return `${html}</nav>`;
}

function pager(sequence, index) {
  const prev = sequence[index - 1];
  const next = sequence[index + 1];
  const label = (page, word) => `<a rel="${word === 'Previous' ? 'prev' : 'next'}" href="${htmlName(page.file)}"><span>${word}</span> ${escapeHtml(page.title)}</a>`;
  return (
    '<nav class="pager" aria-label="Previous and next page">\n' +
    `<p class="prev">${prev ? label(prev, 'Previous') : ''}</p>\n` +
    `<p class="next">${next ? label(next, 'Next') : ''}</p>\n` +
    '</nav>'
  );
}

function pageHtml({ page, sequence, index, entries, repository }) {
  const title = page.file === 'index.md' ? MANUAL_NAME : `${page.title} · ${MANUAL_NAME}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${STYLE_FILE}">
</head>
<body>
<a class="skip" href="#${MAIN_ID}">Skip to the text</a>
<header class="top">
<a class="brand" href="index.html">${MANUAL_NAME}</a>
<a class="contents" href="#${CONTENTS_ID}">Contents</a>
</header>
<div class="layout">
<main id="${MAIN_ID}">
${page.rendered.html}
${pager(sequence, index)}
</main>
${navigation(entries, page.file)}
</div>
<footer class="bottom">
<p>Moontide is free software under the AGPL-3.0-or-later license. <a href="${escapeHtml(repository)}">Source code</a></p>
</footer>
</body>
</html>
`;
}

function checkOutDir(siteDir, outDir) {
  const site = path.resolve(siteDir);
  const out = path.resolve(outDir);
  const rel = path.relative(site, out);
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (rel === '' || !outside) {
    throw new SiteError('the output folder must not be the site folder or lie inside it', { exitCode: 2 });
  }
  let stat = null;
  try {
    stat = fs.lstatSync(out);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new SiteError(`the output folder cannot be read (${error.code ?? 'error'})`, { exitCode: 2 });
  }
  if (stat !== null) {
    if (!stat.isDirectory()) throw new SiteError('the output folder is a file; give a missing or empty folder', { exitCode: 2 });
    if (fs.readdirSync(out).length > 0) {
      throw new SiteError('the output folder is not empty; give a missing or empty folder, the build never overwrites', { exitCode: 2 });
    }
  }
  return out;
}

// Reads every file of site/images/ before anything is written. Gives a Map from the file name to what its
// header says (kind, width, height, durationMs), in name order. No images folder gives an empty Map.
function readImages(siteDir) {
  const dir = path.join(siteDir, IMAGES_DIR);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new SiteError(`${IMAGES_DIR}: the images folder cannot be read (${error.code ?? 'error'})`, { exitCode: 2 });
  }
  const images = new Map();
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const shown = `${IMAGES_DIR}/${entry.name}`;
    if (!entry.isFile()) throw new SiteError(`${shown}: the images folder holds only image files, no folder`);
    if (!IMAGE_NAME.test(entry.name)) {
      throw new SiteError(`${shown}: an image name is lower-case letters and digits in words joined by single hyphens, then .png or .gif`);
    }
    images.set(entry.name, readImage(fs.readFileSync(path.join(dir, entry.name)), shown));
  }
  return images;
}

// Builds the manual from siteDir into outDir. Everything is checked before the first write. Returns
// the names of the files written: the pages, the stylesheet, then images/<name> for each image.
export function buildSite({ siteDir = DEFAULT_SITE_DIR, outDir }) {
  if (typeof outDir !== 'string' || outDir === '') throw new SiteError('no output folder given', { exitCode: 2, usage: true });
  const out = checkOutDir(siteDir, outDir);
  const entries = readManual(siteDir);
  const repository = repositoryAddress();
  const images = readImages(siteDir);
  const facts = new Map([...images].map(([name, info]) => [name, { width: info.width, height: info.height }]));

  const home = { file: 'index.md', title: MANUAL_NAME };
  const pages = [home, ...entries].map((page) => {
    const rendered = renderMarkdown(fs.readFileSync(path.join(siteDir, page.file), 'utf8'), page.file, facts);
    if (rendered.verified === null) throw new SiteError(`${page.file}: the page has no "## What was verified" section`);
    const v = rendered.verified;
    if (!v.isLast) throw refuse(page.file, v.line, '"What was verified" must be the last "##" section');
    if (!v.hasVerified || !v.hasNotVerified) {
      throw refuse(page.file, v.line, 'the box needs both **Verified:** and **Not verified:**');
    }
    return { file: page.file, title: page.title, rendered };
  });

  const idsOf = new Map(pages.map((page) => [page.file, new Set(page.rendered.ids)]));
  for (const page of pages) {
    for (const link of page.rendered.links) {
      const target = link.page ?? page.file;
      if (!idsOf.has(target)) throw refuse(page.file, link.line, `the link goes to ${target}, which is not a page of the manual`);
      if (link.id !== null && !idsOf.get(target).has(link.id)) {
        throw refuse(page.file, link.line, `the link goes to #${link.id}, which ${target} does not have`);
      }
    }
  }

  // Each image is shown by exactly one figure of one page.
  const shownBy = new Map();
  for (const page of pages) {
    for (const image of page.rendered.images) {
      shownBy.set(image.name, [...(shownBy.get(image.name) ?? []), `${page.file}:${image.line}`]);
    }
  }
  for (const [name, places] of shownBy) {
    if (places.length > 1) throw new SiteError(`${IMAGES_DIR}/${name} is shown twice: ${places.join(' and ')}`);
  }
  for (const name of images.keys()) {
    if (!shownBy.has(name)) throw new SiteError(`${IMAGES_DIR}/${name}: no page shows this image; show it on the page of its feature or take the file out`);
  }

  fs.mkdirSync(out, { recursive: true });
  const written = [];
  pages.forEach((page, index) => {
    const name = htmlName(page.file);
    fs.writeFileSync(path.join(out, name), pageHtml({ page, sequence: pages, index, entries, repository }), 'utf8');
    written.push(name);
  });
  fs.copyFileSync(path.join(siteDir, STYLE_FILE), path.join(out, STYLE_FILE));
  written.push(STYLE_FILE);
  if (images.size > 0) {
    fs.mkdirSync(path.join(out, IMAGES_DIR));
    for (const name of images.keys()) {
      fs.copyFileSync(path.join(siteDir, IMAGES_DIR, name), path.join(out, IMAGES_DIR, name));
      written.push(`${IMAGES_DIR}/${name}`);
    }
  }
  return written;
}

// ---- CLI ----

const USAGE = 'usage: node scripts/build-site.mjs --out <empty folder>';

export function main(argv) {
  try {
    let values;
    try {
      values = parseArgs({ args: argv, options: { out: { type: 'string' } }, strict: true, allowPositionals: false }).values;
    } catch (error) {
      throw new SiteError(error.message, { exitCode: 2, usage: true });
    }
    const written = buildSite({ outDir: values.out });
    const pageCount = written.filter((name) => name.endsWith('.html')).length;
    const imageCount = written.filter((name) => name.startsWith(`${IMAGES_DIR}/`)).length;
    const imageWords = imageCount === 0 ? '' : ` and ${imageCount} ${imageCount === 1 ? 'image' : 'images'}`;
    process.stdout.write(`site: ${pageCount} pages${imageWords} written to ${values.out}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`site: ${error.message}\n`);
    if (error instanceof SiteError) {
      if (error.usage) process.stderr.write(`${USAGE}\n`);
      return error.exitCode;
    }
    return 2;
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
