import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sandbox, install} from './helpers.mjs';
import {createServer} from '../src/server.mjs';
import {note, resolve, format, blockedMessage, browserCatalog, messageError, cliLang} from '../src/i18n.mjs';

const ids = ['retentionLimit', 'safety.hardlinksUnsupported', 'safety.rollbackPending',
  'hermes.capability.confirmed', 'hermes.capability.registered', 'hermes.capability.unknown', 'hermes.capability.unsupported',
  'originals.restore', 'originals.date', 'originals.alreadyOriginal', 'originals.reconstructed', 'originals.confirmReconstructed'];
test('merge i18n: R19/R23/R27 and originals have one bilingual catalog with technical details', () => {
  for (const id of ids) for (const lang of ['zh', 'en']) {
    const value = resolve(note(id, {date: '2026-10-31', current: 'X', expected: 'Y', backup: 'Z'}), lang);
    assert.notEqual(value.text, id); assert.ok(value.text.length);
    assert.equal(blockedMessage({kind: 'generic', text: note(id)}, lang), format(note(id), lang));
  }
  assert.match(resolve(note('retentionLimit'), 'zh').text, /下一次操作/);
  assert.match(resolve(note('hermes.capability.registered'), 'zh').text, /尚未见到请求/);
  assert.match(resolve(note('safety.rollbackPending', {current: 'X', expected: 'Y', backup: 'Z'}), 'zh').text, /当前内容是 X，应为 Y，备份在 Z/);
  assert.equal(cliLang({LANG: 'zh_CN.UTF-8'}), 'zh'); assert.equal(cliLang({LANG: 'zh'}, 'en'), 'en');
});

test('merge HTTP: browser receives the shared catalog and R27 structured recovery errors', async t => {
  const {server} = createServer({service: {overview: async () => { throw messageError(note('safety.rollbackPending', {current: 'X', expected: 'Y', backup: 'Z'})); }}, token: 'test'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const script = await (await fetch(url + '/i18n.js')).text();
  assert.ok(script.includes(JSON.stringify(browserCatalog())));
  const result = await fetch(url + '/api/overview', {headers: {'x-recipe-switch-token': 'test'}});
  assert.equal(result.status, 400);
  const body = await result.json(); assert.equal(body.note.id, 'safety.rollbackPending');
  assert.match(resolve(body.note, 'zh').text, /回滚没能完成/);
});

test('merge R05/R08: drift diff is redacted after diffing real bytes and refuses redirected ancestors', async t => {
  const b = await sandbox(t), home = b.file('opencode'); b.service.homes.opencode = home;
  await fs.mkdir(home, {recursive: true}); await fs.writeFile(path.join(home, 'opencode.json'), '{}\n');
  const {recipes} = await b.service.catalog(); await install(b.service, 'opencode', recipes[0].key);
  const file = path.join(home, 'recipe-switch/main.md');
  await fs.appendFile(file, '\nAuthorization: Bearer private-token\nx-api-key: do-not-show\nCookie: session=private-cookie\n');
  const diff = await b.service.driftDiff({harness: 'opencode', path: file});
  assert.match(diff.diff, /redacted/); assert.doesNotMatch(diff.diff, /private-token|do-not-show|private-cookie/);
  const moved = b.file('moved-prompts'); await fs.rename(path.dirname(file), moved);
  try { await fs.symlink(moved, path.dirname(file), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(error.code); throw error; }
  await assert.rejects(b.service.driftDiff({harness: 'opencode', path: file}), /Path escapes boundary/);
});
