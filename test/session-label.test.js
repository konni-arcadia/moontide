import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  LABEL_FOLDER_MAX,
  LABEL_SEPARATOR,
  cleanFolderName,
  folderName,
  sessionLabel,
  tabTitle,
} from '../dist/session-label.js';

test('session label: the folder name, a middle dot and the port', () => {
  assert.equal(LABEL_SEPARATOR, ' \u00b7 ');
  assert.equal(sessionLabel('my-project', 5757), 'my-project \u00b7 5757');
});

test('session label: an empty or blank folder gives the port alone', () => {
  assert.equal(sessionLabel('', 5757), '5757');
  assert.equal(sessionLabel(' \t\n ', 5757), '5757');
  assert.equal(sessionLabel('\u0000\u001f\u007f\u009f', 5757), '5757');
});

test('session label: control characters become spaces, runs collapse, the ends are trimmed', () => {
  assert.equal(cleanFolderName('a\nb\tc'), 'a b c');
  assert.equal(cleanFolderName('a   b'), 'a b');
  assert.equal(cleanFolderName('  my-project  '), 'my-project');
  assert.equal(cleanFolderName('a\u0000b\u007fc\u009fd'), 'a b c d');
});

test('session label: a long name is cut to 40 code points ending with an ellipsis', () => {
  assert.equal(LABEL_FOLDER_MAX, 40);
  const cut = cleanFolderName('x'.repeat(60));
  assert.equal(Array.from(cut).length, 40);
  assert.equal(cut, `${'x'.repeat(39)}\u2026`);
  assert.equal(cleanFolderName('y'.repeat(40)), 'y'.repeat(40));
});

test('session label: a cut never splits a surrogate pair', () => {
  const name = `${'x'.repeat(38)}\u{1F600}${'z'.repeat(10)}`;
  const cut = cleanFolderName(name);
  assert.equal(cut, `${'x'.repeat(38)}\u{1F600}\u2026`);
  assert.equal(Array.from(cut).length, 40);
});

test('session label: the folder name is the base name, on both kinds of path', () => {
  assert.equal(folderName('C:\\', path.win32), '');
  assert.equal(folderName('/', path.posix), '');
  assert.equal(folderName('C:\\work\\my-project', path.win32), 'my-project');
  assert.equal(folderName('/work/my-project', path.posix), 'my-project');
  assert.equal(folderName('/work/my-project/', path.posix), 'my-project');
});

test('session label: the tab title puts Moontide first', () => {
  assert.equal(tabTitle('my-project \u00b7 5757'), 'Moontide \u00b7 my-project \u00b7 5757');
});
