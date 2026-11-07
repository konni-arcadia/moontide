// The claims checker: README.md and every page of site/ may name only what the code still has.
// A helper module, like test/helpers.js: no test runs here, test/site-claims.test.js runs it.
//
// Every fact comes from the code, never from a copy: the tools and prompts from a real server, the
// reference topics from dist/reference.js, the views from page/views.js, the npm scripts from
// package.json, the environment variables and Strudel functions from the text of the sources and of
// reference/*.md, the files from the working tree. The limits and counts a page may state are the
// rows of pinnedRows(), built from the constants of the code. A false positive is fixed by an
// exemption with its reason or by rewording, never by loosening a rule.
//
// The rules, each a finding named by its rule: unknown tool, unknown prompt, unknown environment variable, unknown
// reference topic, unknown npm script, unknown function, unknown view, dead link, incomplete list, unpinned limit,
// missing image (an image of a page names a file that does not exist) and, from unusedImages, unused image (a file of
// site/images/ that no page names).
//
// Imports nothing from publish/: that folder is not published and the test runs in the snapshot.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderMarkdown } from '../scripts/build-site.mjs';
import { startMcpClient } from './helpers.js';

// ---- Exemptions, each with its reason ----

// Backticked snake_case names that are not Moontide tools.
export const NOT_A_TOOL = new Map([
  // (none yet; an entry is a name with the reason it is not a tool)
]);

// Files whose tool list names only some of the tools on purpose.
export const PARTIAL_TOOL_LIST = new Map([
  // (none yet; an entry is a file with the reason its list is partial)
]);

// Called names inside code that are not Strudel functions of the reference.
export const NOT_A_STRUDEL_CALL = new Map([
  // (none yet; an entry is a name with the reason it is not looked up in the reference)
]);

// Code block languages that hold shell commands, not Strudel calls.
export const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'powershell']);

// Limit-like phrases that are not a limit of Moontide. Checked before the rows, so another
// program's limit never counts as pinned by a Moontide constant that happens to share its number.
export const LIMIT_EXEMPTIONS = [
  { pattern: /gives up after 30 seconds/g, reason: "Claude Code's own start timeout for a server, not a Moontide limit" },
  { pattern: /\(3 minutes, with sound\)/g, reason: 'the length of the demo video, a measured number' },
  { pattern: /bring it up to 140 over eight bars/g, reason: 'an example request, with a tempo chosen to show the wording' },
];

// ---- Which phrases are limit-like ----

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';
const NUMBER_WORD_LIST = NUMBER_WORDS.split('|');
const NUMBER = String.raw`\d+(?:,\d{3})*`;
// Milliseconds are left out on purpose: the pages quote measured latencies in ms (what-was-measured and
// the pages that cite it). Those are results of a bench, not limits of the code, so no constant pins them.
const UNITS = 'seconds?|secs?|minutes?|mins?|hours?|days?|cycles?|notes?|sounds?|matches|steps?|versions?|inputs?|bytes?|bars?|rows?';
const COUNTED = 'topics?|views?|grids?|layouts?|models?|levels?';

// The shapes of a stated limit or count. A match must be covered by a row of pinnedRows() or by an
// exemption above.
export const LIMIT_SHAPES = [
  // "at most 30 minutes"
  new RegExp(String.raw`\bat most ${NUMBER}`, 'gi'),
  // "up to 25 matches"
  new RegExp(String.raw`\bup to ${NUMBER}`, 'gi'),
  // "the last 1000 versions"
  new RegExp(String.raw`\bthe last ${NUMBER}`, 'gi'),
  // "from 1 to 64"
  new RegExp(String.raw`\bfrom ${NUMBER} to ${NUMBER}`, 'gi'),
  // "1 to 8 cycles"
  new RegExp(String.raw`\b${NUMBER} to ${NUMBER} cycles?`, 'gi'),
  // "port 5757"
  /\bport \d{2,5}\b/gi,
  // "localhost:5757"
  /\blocalhost:\d+/gi,
  // "30 seconds", "4 inputs", "5,000 sounds", "a 45-second wait" (the unit follows a space or a hyphen)
  new RegExp(String.raw`\b${NUMBER}(?:\.\d+)?[ -](?:${UNITS})\b`, 'gi'),
  // "eleven topics", "seven views"
  new RegExp(String.raw`\b(?:${NUMBER_WORDS}) (?:${COUNTED})\b`, 'gi'),
  // "11 topics", "999 views": a count in digits, which any number above twenty has to be
  new RegExp(String.raw`\b${NUMBER} (?:${COUNTED})\b`, 'gi'),
  // "velocity 0.80", "velocity of 0.80"
  /\bvelocity (?:of |at |is )?\d\.\d{2}\b/gi,
];

// ---- The rows: what a page may state, from the constants of the code ----

export const numberWord = (n) => (Number.isInteger(n) && n >= 1 && n <= NUMBER_WORD_LIST.length ? NUMBER_WORD_LIST[n - 1] : String(n));
const withComma = (n) => n.toLocaleString('en-US');

// A count or a cap with a unit, in the three ways a page words it.
function capRows(key, n, unit) {
  const digits = [String(n), withComma(n)];
  return [...new Set(digits)].flatMap((d) => [
    { key, text: `${d} ${unit}` },
    { key, text: `at most ${d} ${unit}` },
    { key, text: `up to ${d} ${unit}` },
  ]);
}

/**
 * The rows a page may rely on. `constants` holds the numbers of the code; the test builds the rows
 * from changed numbers to prove a changed constant is caught. A row whose phrase no page uses yet is
 * kept: the later pages use it. Each row names its constant.
 */
export function pinnedRows(constants) {
  const c = constants;
  const rows = [
    { key: 'topicCount', text: `${numberWord(c.topicCount)} topics` },
    { key: 'glideMin', text: `from ${c.glideMin} to ${c.glideMax}` },
    { key: 'glideMax', text: `from ${c.glideMin} to ${c.glideMax}` },
    ...capRows('historyCap', c.historyCap, 'versions'),
    { key: 'historyCap', text: `the last ${c.historyCap} versions` },
    { key: 'monitorMinutes', text: `at most ${c.monitorMinutes} minutes` },
    { key: 'monitorMinutes', text: `${c.monitorMinutes} minutes` },
    { key: 'quietSeconds', text: `${c.quietSeconds} seconds without news` },
    { key: 'finishedSeconds', text: `Recent list after ${c.finishedSeconds} seconds` },
    { key: 'port', text: `localhost:${c.port}` },
    { key: 'port', text: `port ${c.port}` },
    ...capRows('catalogSounds', c.catalogSounds, 'sounds'),
    ...capRows('searchResults', c.searchResults, 'matches'),
    ...capRows('partSounds', c.partSounds, 'sounds'),
    { key: 'cyclesMin', text: `from ${c.cyclesMin} to ${c.cyclesMax} cycles` },
    { key: 'cyclesMax', text: `from ${c.cyclesMin} to ${c.cyclesMax} cycles` },
    { key: 'cyclesMin', text: `${c.cyclesMin} to ${c.cyclesMax} cycles` },
    { key: 'cyclesMax', text: `${c.cyclesMin} to ${c.cyclesMax} cycles` },
    { key: 'cyclesDefault', text: `${c.cyclesDefault} cycles by default` },
    { key: 'cyclesDefault', text: `${c.cyclesDefault} cycles long` },
    { key: 'cyclesDefault', text: `default of ${c.cyclesDefault} cycles` },
    { key: 'bufferCycles', text: `the last ${c.bufferCycles} cycles` },
    { key: 'bufferCycles', text: `${c.bufferCycles} cycles back` },
    ...capRows('bufferNotes', c.bufferNotes, 'notes'),
    ...capRows('rigInputs', c.rigInputs, 'inputs'),
    ...capRows('requestLineBytes', c.requestLineBytes, 'bytes'),
    ...capRows('undoSteps', c.undoSteps, 'steps'),
    { key: 'undoSteps', text: `the last ${c.undoSteps} steps` },
    { key: 'gridCount', text: `${numberWord(c.gridCount)} grids` },
    { key: 'viewCount', text: `${numberWord(c.viewCount)} views` },
    { key: 'layoutCount', text: `${numberWord(c.layoutCount)} layouts` },
    { key: 'modelCount', text: `${numberWord(c.modelCount)} models` },
    { key: 'modelCount', text: `${numberWord(c.modelCount)} ready models` },
    // The same counts written in digits.
    { key: 'topicCount', text: `${c.topicCount} topics` },
    { key: 'gridCount', text: `${c.gridCount} grids` },
    { key: 'viewCount', text: `${c.viewCount} views` },
    { key: 'layoutCount', text: `${c.layoutCount} layouts` },
    { key: 'modelCount', text: `${c.modelCount} models` },
    { key: 'modelCount', text: `${c.modelCount} ready models` },
  ];
  const velocity = (c.velocity / 100).toFixed(2);
  for (const lead of ['velocity ', 'velocity of ', 'velocity at ', 'velocity is ']) {
    rows.push({ key: 'velocity', text: `${lead}${velocity}` });
  }
  return rows;
}

/** The constants, read from the code that owns them. */
export async function realConstants(root) {
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  const [reference, history, ask, webServer, catalog, protocol, glide, status, scratch, buffer, views] = await Promise.all([
    load('dist/reference.js'),
    load('dist/history.js'),
    load('dist/ask.js'),
    load('dist/web-server.js'),
    load('dist/catalog.js'),
    load('dist/protocol.js'),
    load('page/tempo-glide.js'),
    load('page/request-status.js'),
    load('page/scratch-model.js'),
    load('page/played-buffer.js'),
    load('page/views.js'),
  ]);
  return {
    topicCount: reference.REFERENCE_TOPICS.length,
    glideMin: glide.MIN_GLIDE_BARS,
    glideMax: glide.MAX_GLIDE_BARS,
    historyCap: history.HISTORY_CAP,
    monitorMinutes: ask.MONITOR_TIMEOUT_MS / 60000,
    quietSeconds: status.QUIET_AFTER_MS / 1000,
    finishedSeconds: status.FINISHED_SHOWN_MS / 1000,
    port: webServer.DEFAULT_PORT,
    catalogSounds: catalog.MAX_CATALOG_SOUNDS,
    searchResults: catalog.MAX_SEARCH_RESULTS,
    partSounds: catalog.MAX_PART_SOUNDS,
    cyclesMin: scratch.MIN_CYCLES,
    cyclesMax: scratch.MAX_CYCLES,
    cyclesDefault: scratch.DEFAULT_CYCLES,
    bufferCycles: buffer.BUFFER_CYCLES,
    bufferNotes: buffer.MAX_BUFFER_NOTES,
    rigInputs: protocol.MAX_RIG_INPUTS,
    requestLineBytes: protocol.MAX_REQUEST_LINE_BYTES,
    undoSteps: scratch.HISTORY_DEPTH,
    gridCount: scratch.GRIDS.length,
    viewCount: views.BUILT_VIEWS.length,
    layoutCount: views.LAYOUTS.length,
    modelCount: fs.readdirSync(path.join(root, 'instruments')).filter((name) => name.endsWith('.json')).length,
    velocity: scratch.DEFAULT_VELOCITY,
  };
}

// ---- The facts ----

function filesUnder(dir, extension) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(extension)).sort() : [];
}

/** The repository address of package.json: owner and name, as the build reads it. */
export function repositoryOf(packageJson) {
  const url = String(packageJson.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  if (!m) throw new Error('package.json has no https://github.com/<owner>/<repo> repository address');
  return { owner: m[1], repo: m[2] };
}

/**
 * Reads every fact from the code. Starts a real server without starting Moontide, to list its tools and
 * prompts, and closes it again.
 */
export async function loadFacts(root) {
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const session = await startMcpClient({ start: false });
  let tools;
  let prompts;
  try {
    tools = (await session.client.listTools()).tools.map((tool) => tool.name);
    prompts = (await session.client.listPrompts()).prompts.map((prompt) => prompt.name);
  } finally {
    await session.client.close().catch(() => {});
  }

  const reference = await load('dist/reference.js');
  const views = await load('page/views.js');
  const structure = await load('page/structure.js');

  const sourceText = [
    ...filesUnder(path.join(root, 'src'), '.ts').map((n) => fs.readFileSync(path.join(root, 'src', n), 'utf8')),
    ...filesUnder(path.join(root, 'page'), '.js').map((n) => fs.readFileSync(path.join(root, 'page', n), 'utf8')),
  ].join('\n');
  const environmentVariables = new Set(sourceText.match(/\bMOONTIDE_[A-Z0-9_]+\b/g) ?? []);

  const referenceText = filesUnder(path.join(root, 'reference'), '.md')
    .map((n) => fs.readFileSync(path.join(root, 'reference', n), 'utf8'))
    .join('\n');
  const strudelCalls = new Set([...referenceText.matchAll(/([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]));

  const { owner, repo } = repositoryOf(packageJson);
  const sitePages = new Map();
  const siteDir = path.join(root, 'site');
  for (const name of filesUnder(siteDir, '.md')) {
    sitePages.set(name, new Set(renderMarkdown(fs.readFileSync(path.join(siteDir, name), 'utf8'), name).ids));
  }

  return {
    root,
    tools: new Set(tools),
    prompts: new Set(prompts),
    topicIds: new Set(reference.REFERENCE_TOPIC_IDS),
    viewTitles: new Set([...Object.values(views.VIEW_TITLES), structure.SONG_COPY.viewTitle]),
    npmScripts: new Set(Object.keys(packageJson.scripts ?? {})),
    environmentVariables,
    strudelCalls,
    owner,
    repo,
    siteAddress: `https://${owner.toLowerCase()}.github.io/${repo}/`,
    sitePages,
  };
}

// ---- Reading a file as units ----

// A unit is a paragraph, a list item, a heading or one line of a code block, with the file line of
// every character, so a phrase that wraps over two lines is still one phrase.
export function readUnits(text) {
  const units = [];
  let current = null;
  let fence = null;
  const flush = () => {
    if (current) units.push(current);
    current = null;
  };
  text.split(/\r?\n/).forEach((line, index) => {
    const no = index + 1;
    if (fence !== null) {
      if (/^\s*```\s*$/.test(line)) fence = null;
      else units.push({ kind: 'code', lang: fence, item: false, text: line, parts: [{ at: 0, no }] });
      return;
    }
    const open = /^\s*```\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (open) {
      flush();
      fence = open[1];
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:-|\*|\d+\.)\s+(.*)$/.exec(line);
    if (heading || item) {
      flush();
      current = { kind: 'prose', lang: '', item: Boolean(item), text: (heading ?? item)[1], parts: [{ at: 0, no }] };
      if (heading) flush();
      return;
    }
    if (current) {
      current.parts.push({ at: current.text.length + 1, no });
      current.text += ` ${line.trim()}`;
    } else {
      current = { kind: 'prose', lang: '', item: false, text: line.trim(), parts: [{ at: 0, no }] };
    }
  });
  flush();
  for (const unit of units) {
    const parts = unit.parts;
    unit.lineAt = (index) => parts.reduce((no, part) => (part.at <= index ? part.no : no), parts[0].no);
  }
  return units;
}

// ---- The rules ----

const spansOf = (text, pattern) => [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length, groups: m }));

function backticked(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => ({ start: m.index, content: m[1] }));
}

const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/** True when `text` holds `phrase` around [start, end), whole-word at its edges, in any letter case. */
function covers(original, phrase, start, end) {
  const lower = original.toLowerCase();
  const text = lower.length === original.length ? lower : original;
  const needle = lower.length === original.length ? phrase.toLowerCase() : phrase;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const stop = at + needle.length;
    const before = text[at - 1];
    const after = text[stop];
    const edgeOk =
      !(isWordChar(needle[0]) && (isWordChar(before) || before === ',' || before === '.')) && !(isWordChar(needle[needle.length - 1]) && isWordChar(after));
    if (edgeOk && at <= start && end <= stop) return true;
    from = at + 1;
  }
}

/**
 * Checks one file. Returns findings, each `{ file, line, rule, words }`, in file order. `rows` is
 * pinnedRows(constants).
 */
export function checkFile(file, text, facts, rows) {
  const findings = [];
  const add = (unit, index, rule, words) => findings.push({ file, line: unit.lineAt(index), rule, words });
  const units = readUnits(text);

  const toolNames = new Set();
  const topicMentions = new Set();
  const topicItemsAt = [];
  const toolItemsAt = [];

  for (const unit of units) {
    const body = unit.text;

    if (unit.kind === 'prose') {
      for (const { start, content } of backticked(body)) {
        if (/^[a-z]+(?:_[a-z]+)+$/.test(content) && !facts.tools.has(content) && !NOT_A_TOOL.has(content)) {
          add(unit, start, 'unknown tool', content);
        }
      }
      for (const m of body.matchAll(/\/mcp__moontide__([A-Za-z0-9-]+)/g)) {
        if (!facts.prompts.has(m[1])) add(unit, m.index, 'unknown prompt', m[0]);
      }
      for (const m of body.matchAll(/\bMOONTIDE_[A-Z0-9_]+\b/g)) {
        if (!facts.environmentVariables.has(m[0])) add(unit, m.index, 'unknown environment variable', m[0]);
      }
      for (const m of body.matchAll(/`([A-Za-z0-9_-]+)` topic\b/g)) {
        if (!facts.topicIds.has(m[1])) add(unit, m.index, 'unknown reference topic', m[1]);
      }
      for (const m of body.replaceAll('*', '').matchAll(/\b[Tt]he ([A-Z][A-Za-z]+) view\b/g)) {
        if (!facts.viewTitles.has(m[1])) add(unit, m.index, 'unknown view', m[1]);
      }

      if (unit.item) {
        const topic = /^[^`(]*\(`([a-z][a-z-]*)`\)/.exec(body.replaceAll('*', ''));
        if (topic) topicItemsAt.push({ unit, id: topic[1] });
        const tool = /^`([a-z][a-z_]*)`/.exec(body);
        if (tool) toolItemsAt.push({ unit, name: tool[1] });
      }
    }

    // npm scripts, in prose and in code alike.
    for (const m of body.matchAll(/\bnpm run ([A-Za-z][\w:.-]*)/g)) {
      if (!facts.npmScripts.has(m[1])) add(unit, m.index, 'unknown npm script', m[1]);
    }

    // Called names: inside a backticked span of prose, or in a code block that is not shell commands.
    const callSources = [];
    if (unit.kind === 'prose') {
      for (const { start, content } of backticked(body)) callSources.push({ start: start + 1, content });
    } else if (!SHELL_LANGUAGES.has(unit.lang)) {
      callSources.push({ start: 0, content: body });
    }
    for (const source of callSources) {
      for (const m of source.content.matchAll(/([A-Za-z_$][\w$]*)\(/g)) {
        if (!facts.strudelCalls.has(m[1]) && !NOT_A_STRUDEL_CALL.has(m[1])) {
          add(unit, source.start + m.index, 'unknown function', m[1]);
        }
      }
    }

    if (unit.kind !== 'prose') continue;

    // Links: to the published site, to a file of the repository, and relative ones.
    const images = imageTargets(body);
    const insideImage = (index) => images.some((image) => image.index < index && index < image.index + image.length);
    const links = [
      ...[...body.matchAll(/\]\(([^)\s]+)\)/g)].filter((m) => !insideImage(m.index)).map((m) => ({ target: m[1], index: m.index })),
      ...[...body.matchAll(/(?<![(\w])(https?:\/\/[^\s<>()\]`]*[^\s<>()\]`.,;:!?'"])/g)].map((m) => ({ target: m[1], index: m.index })),
    ];
    for (const { target, index } of links) {
      checkLink(target, (words) => add(unit, index, 'dead link', words), facts, file);
    }

    // An image names a file of the repository, resolved from the folder of the file that shows it.
    for (const image of images) {
      if (/^https?:\/\//i.test(image.target)) continue;
      if (!repositoryHas(facts.root, imagePath(file, image.target))) add(unit, image.index, 'missing image', image.target);
    }

    // Limits and counts.
    const exempt = LIMIT_EXEMPTIONS.flatMap((e) => spansOf(body, e.pattern));
    for (const shape of LIMIT_SHAPES) {
      for (const match of body.matchAll(shape)) {
        const start = match.index;
        const end = start + match[0].length;
        if (exempt.some((span) => span.start <= start && end <= span.end)) continue;
        if (rows.some((row) => covers(body, row.text, start, end))) continue;
        add(unit, start, 'unpinned limit', match[0]);
      }
    }
  }

  // A list of the reference topics names every topic and nothing else.
  const topicsNamed = new Set(topicItemsAt.map((x) => x.id));
  if ([...topicsNamed].some((id) => facts.topicIds.has(id))) {
    const first = topicItemsAt[0].unit;
    for (const id of facts.topicIds) if (!topicsNamed.has(id)) add(first, 0, 'incomplete list', `topic ${id} is missing`);
    for (const { unit, id } of topicItemsAt) if (!facts.topicIds.has(id)) add(unit, 0, 'incomplete list', `${id} is not a topic`);
  }

  // A list of the tools names every tool and nothing else.
  const toolsNamed = new Set(toolItemsAt.map((x) => x.name));
  if ([...toolsNamed].some((name) => facts.tools.has(name)) && !PARTIAL_TOOL_LIST.has(file)) {
    const first = toolItemsAt[0].unit;
    for (const name of facts.tools) if (!toolsNamed.has(name)) add(first, 0, 'incomplete list', `tool ${name} is missing`);
    for (const { unit, name } of toolItemsAt) if (!facts.tools.has(name)) add(unit, 0, 'incomplete list', `${name} is not a tool`);
  }

  return findings.sort((a, b) => a.line - b.line);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when `rel`, a path inside the repository, names something that exists and stays inside the root:
// a ".." that climbs out of the repository never counts.
function repositoryHas(root, rel) {
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, decoded);
  return resolved.startsWith(base + path.sep) && fs.existsSync(resolved);
}

function checkLink(target, dead, facts, file) {
  // The published site, in any letter case of the host, with http or https, with or without the final
  // slash. Read from the text of the address, so a ".." is seen and not folded away.
  const site = new RegExp(`^https?://${escapeRegExp(facts.owner)}\\.github\\.io/${escapeRegExp(facts.repo)}(?=[/#?]|$)`, 'i').exec(target);
  if (site) {
    const rest = target.slice(site[0].length).replace(/^\//, '');
    const [beforeHash, id] = rest.split('#');
    const pagePart = beforeHash.split('?')[0];
    const page = pagePart === '' || pagePart === 'index.html' ? 'index.md' : /^([A-Za-z0-9_-]+)\.html$/.test(pagePart) ? pagePart.replace(/\.html$/, '.md') : null;
    if (page === null || !facts.sitePages.has(page)) return dead(target);
    if (id !== undefined && !facts.sitePages.get(page).has(id)) return dead(target);
    return undefined;
  }
  // A file of the repository on GitHub, on any branch, tag or commit.
  const blob = new RegExp(`^https?://github\\.com/${escapeRegExp(facts.owner)}/${escapeRegExp(facts.repo)}/(?:blob|tree)/[^/#?]+/`, 'i').exec(target);
  if (blob) {
    const rel = target.slice(blob[0].length).split(/[#?]/)[0].replace(/\/$/, '');
    if (rel === '' || !repositoryHas(facts.root, rel)) return dead(target);
    return undefined;
  }
  // A relative link in README.md names a file of the repository. Site pages are checked by the build.
  if (file === 'README.md' && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) {
    const rel = target.split(/[#?]/)[0];
    if (rel !== '' && !repositoryHas(facts.root, rel)) return dead(target);
  }
  return undefined;
}

// The images a text shows, as ![text](target): the target, where the image starts and how long it is.
function imageTargets(text) {
  return [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => ({ target: m[1], index: m.index, length: m[0].length }));
}

// The path, from the root of the repository, of the file an image target names when it stands in `file`: a page
// of site/ resolves from site/, README.md and a fixture named without a folder from the root.
function imagePath(file, target) {
  return path.posix.join(path.posix.dirname(file), target.split(/[#?]/)[0]);
}

/**
 * The files of site/images/ that no page of site/ names as an image, as findings `{ file, line: 0, rule, words }`
 * with the file `site/images/<name>` and the name as the words. `files` is claimFiles(root).
 */
export function unusedImages(root, files) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, 'site', 'images')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const named = new Set(
    files
      .filter(({ file }) => file.startsWith('site/'))
      .flatMap(({ file, text }) => imageTargets(text).map((image) => imagePath(file, image.target))),
  );
  return names.filter((name) => !named.has(`site/images/${name}`)).map((name) => ({ file: `site/images/${name}`, line: 0, rule: 'unused image', words: name }));
}

/** README.md and every page of site/, as `{ file, text }`. */
export function claimFiles(root) {
  const files = [{ file: 'README.md', text: fs.readFileSync(path.join(root, 'README.md'), 'utf8') }];
  const siteDir = path.join(root, 'site');
  for (const name of filesUnder(siteDir, '.md')) {
    files.push({ file: `site/${name}`, text: fs.readFileSync(path.join(siteDir, name), 'utf8') });
  }
  return files;
}

export const describe = (finding) => `${finding.file}:${finding.line}: ${finding.rule}: ${finding.words}`;
