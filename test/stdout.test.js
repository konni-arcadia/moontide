// Stdout carries the MCP protocol to Claude: one stray line from server code corrupts the session.
// This guard reads every source file and fails when code outside the allowed places writes to stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizer } from 'acorn';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

const STDOUT_CONSOLE_METHODS = new Set([
  'log', 'info', 'debug', 'dir', 'dirxml', 'table', 'count', 'group', 'groupCollapsed', 'timeLog', 'timeEnd',
]);

/** The source text as a list of token texts, with every kind of comment gone (also ones after code on a line). */
function tokenTexts(text) {
  const out = [];
  for (const token of tokenizer(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })) {
    if (token.type.label === 'eof') break;
    out.push(text.slice(token.start, token.end));
  }
  return out;
}

/** Every place where a file writes to stdout, as short descriptions. */
export function stdoutWrites(fileName, text) {
  const t = tokenTexts(text);
  const found = [];
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === 'console' && t[i + 1] === '.' && STDOUT_CONSOLE_METHODS.has(t[i + 2])) found.push(`console.${t[i + 2]}`);
    if (t[i] === 'process' && t[i + 1] === '.' && t[i + 2] === 'stdout') found.push('process.stdout');
    if ((t[i] === 'writeSync' || t[i] === 'writeFileSync') && t[i + 1] === '(' && t[i + 2] === '1') found.push(`${t[i]} on descriptor 1`);
    if (/^['"`]\/dev\/(?:stdout|fd\/1)['"`]$/.test(t[i])) found.push('a write path for stdout');
  }
  return found.map((use) => `${fileName}: ${use}`);
}

test('stdout: server code never writes to stdout (the listener command prints on purpose; the CLI prints twice)', () => {
  const files = fs.readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts')).sort();
  assert.ok(files.length > 10, 'the source folder was found');
  for (const name of files) {
    const uses = stdoutWrites(`src/${name}`, fs.readFileSync(path.join(SRC_DIR, name), 'utf8'));
    if (name === 'listen.ts') continue; // it prints requests to stdout so a monitor can read them
    if (name === 'index.ts') {
      // The import-midnam output callback and the --version answer: both are short commands, never the server.
      assert.deepEqual(uses, ['src/index.ts: process.stdout', 'src/index.ts: process.stdout'], uses.join('; '));
      continue;
    }
    assert.deepEqual(uses, [], `${name} writes to stdout, which carries the protocol: ${uses.join('; ')}`);
  }
});

test('stdout: the checker itself finds each kind of stdout write and skips comments and stderr', () => {
  assert.deepEqual(stdoutWrites('src/session.ts', "console.log('x');"), ['src/session.ts: console.log']);
  assert.deepEqual(stdoutWrites('src/session.ts', 'process.stdout.write("x");'), ['src/session.ts: process.stdout']);
  assert.deepEqual(stdoutWrites('src/session.ts', "fs.writeSync(1, 'x');"), ['src/session.ts: writeSync on descriptor 1']);
  assert.deepEqual(stdoutWrites('src/session.ts', "writeFileSync('/dev/stdout', 'x');"), ['src/session.ts: a write path for stdout']);
  assert.deepEqual(
    stdoutWrites('src/session.ts', "console.error('ok'); // console.log('x') in a comment\n/* process.stdout */ fs.writeSync(2, 'x');"),
    [],
  );
});
