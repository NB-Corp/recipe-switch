import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sandbox, exists} from './helpers.mjs';
import {Store, plan, applyPlan} from '../src/engine.mjs';
import {fileUnit} from '../src/drivers/common.mjs';
import {main} from '../bin/recipe-switch.mjs';
import {format} from '../src/i18n.mjs';

test('R30: CLI status shows the API rollback blocker, current/expected hashes, backup and recovery in zh/en', async t => {
  const b = await sandbox(t, {sources: []}), home = b.file('status-target'), file = path.join(home, 'main'), store = new Store(b.file('status-state'));
  const preview = text => plan({store, harness: 'fixture', home, recipe: {key: 'r'}, desired: [fileUnit(file, text)]});
  await applyPlan(store, await preview('MANAGED 1'));
  const p = await preview('MANAGED 2'), link = fs.link, save = store.save;
  store.save = async () => { fs.link = async () => { throw Object.assign(Error('capability lost'), {code: 'ENOTSUP'}); }; throw Error('state save failed'); };
  b.service.store = store;
  b.service.targets = async () => [{driver: {id: 'fixture', name: 'Fixture', detect: async () => ({present: true})}, home}];
  try {
    await assert.rejects(applyPlan(store, p), /Rollback could not complete/);
    const api = (await b.service.overview()).targets[0]; assert.equal(api.present, true); assert.equal(api.errorNote.id, 'safety.rollbackPending');
    for (const lang of ['zh', 'en']) {
      const lines = [], log = console.log; console.log = (...args) => lines.push(args.join(' '));
      try { await main(['status', '--lang', lang], b.service); } finally { console.log = log; }
      const output = lines.join('\n');
      assert.ok(output.includes(format(api.errorNote, lang)), output);
      for (const key of ['current', 'expected', 'backup', 'path']) assert.ok(output.includes(api.errorNote.vars[key]), key);
      assert.match(output, lang === 'zh' ? /状态读取受阻.*\n.*回滚没能完成/ : /Status blocked.*\n.*Rollback could not complete/);
      assert.doesNotMatch(output, /not found|recipe-switch: —/);
      assert.match(output, lang === 'zh' ? /先保留当前文件.*恢复.*重试/ : /Preserve the current file.*restore.*retry/);
    }
    assert.equal(await exists(store.pending), true); assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 2');
  } finally { fs.link = link; store.save = save; }
  await store.load(); assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 1');
});
