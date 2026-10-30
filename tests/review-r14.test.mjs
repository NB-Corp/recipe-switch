import test from 'node:test';
import assert from 'node:assert/strict';
import {unifiedDiff} from '../src/diff.mjs';

test('R14: CRLF-only changes are visible with line-ending markers', () => {
  const diff = unifiedDiff('value\r\n', 'value\n', {path: 'config.toml'});
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.text, [
    '--- a/config.toml',
    '+++ b/config.toml',
    '@@ -1,1 +1,1 @@',
    '-value',
    '\\ Line ending: CRLF',
    '+value',
    '\\ Line ending: LF',
    '',
  ].join('\n'));
});

test('R14: EOF newline additions and removals are visible', () => {
  const added = unifiedDiff('value', 'value\n', {path: 'file'});
  assert.match(added.text, /-value\n\\ No newline at end of file\n\+value\n\\ Line ending: LF/);

  const removed = unifiedDiff('value\n', 'value', {path: 'file'});
  assert.match(removed.text, /-value\n\\ Line ending: LF\n\+value\n\\ No newline at end of file/);
});

test('R14: empty-file creation and deletion stay visible with zero line counts', () => {
  const created = unifiedDiff(null, '', {path: 'empty.txt'});
  assert.equal(created.added, 0);
  assert.equal(created.removed, 0);
  assert.equal(created.text, '--- /dev/null\n+++ b/empty.txt\n');

  const deleted = unifiedDiff('', null, {path: 'empty.txt'});
  assert.equal(deleted.added, 0);
  assert.equal(deleted.removed, 0);
  assert.equal(deleted.text, '--- a/empty.txt\n+++ /dev/null\n');
});

test('R14: ordinary content diffs keep their existing unified output', () => {
  const diff = unifiedDiff('before\nkeep\n', 'after\nkeep\n', {path: 'config.toml'});
  assert.equal(diff.text, [
    '--- a/config.toml',
    '+++ b/config.toml',
    '@@ -1,2 +1,2 @@',
    '-before',
    '+after',
    ' keep',
    '',
  ].join('\n'));
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});
