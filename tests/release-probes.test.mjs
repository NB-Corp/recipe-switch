import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sandbox, exists, joinText} from './helpers.mjs';
import {Store} from '../src/engine.mjs';

async function crash(t, mode) {
  const b = await sandbox(t, {sources: []}), store = new Store(b.file('probe-state')), home = b.file('probe-home'), file = path.join(home, 'nested/main');
  const code = `import fs from 'node:fs/promises';import{Store,plan}from ${JSON.stringify(new URL('../src/engine.mjs', import.meta.url).href)};import{fileUnit}from ${JSON.stringify(new URL('../src/drivers/common.mjs', import.meta.url).href)};const [state,home,file,mode]=process.argv.slice(1);const s=new Store(state);if(mode==='open'){const open=fs.open;fs.open=async(f,...a)=>{const h=await open(f,...a);if(String(f).includes('.recipe-switch-probe-'))process.exit(0);return h;};}else if(mode==='write'){const write=fs.writeFile;fs.writeFile=async(f,...a)=>{await write(f,...a);if(String(f).includes('.recipe-switch-probe-'))process.exit(0);};}else{const mkdir=fs.mkdir;fs.mkdir=async(f,...a)=>{const r=await mkdir(f,...a);if(f===home)process.exit(0);return r;};}await plan({store:s,harness:'fixture',home,recipe:{key:'r'},desired:[fileUnit(file,'MAIN')]});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, store.home, home, file, mode], {env: b.env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(store.home, 'probes'), names = await fs.readdir(dir); assert.equal(names.length, 1);
  const recordFile = path.join(dir, names[0]), record = JSON.parse(await fs.readFile(recordFile));
  return {...b, store, home, file, dir, record, recordFile};
}
for (const mode of ['mkdir', 'open', 'write']) test(`R25: crash after ${mode} before identity registration leaves no residue after two loads`, async t => {
  const b = await crash(t, mode);
  if (mode === 'mkdir') assert.ok(b.record.createdDirs.some(item => item.newlyCreated && !item.identity));
  else { assert.equal(b.record.probeIdentity, undefined); assert.match(await fs.readFile(b.record.probe, 'utf8'), /^recipe-switch hardlink probe v1\n$/); }
  await b.store.load(); await b.store.load();
  for (const file of [b.home, b.record.probe, b.record.link, b.dir]) assert.equal(await exists(file), false, file);
  assert.equal(b.store.warnings.length, 0);
});

test('R25/R24: unknown or partial probe content is preserved with its recovery record through repeated loads', async t => {
  const b = await crash(t, 'write'); await fs.writeFile(b.record.probe, 'USER REPLACEMENT');
  await b.store.load(); await b.store.load();
  assert.equal(await fs.readFile(b.record.probe, 'utf8'), 'USER REPLACEMENT');
  assert.equal(await exists(b.recordFile), true); assert.match(joinText(b.store.warnings), /Path replaced; not deleted/);
});

test('R25: an unregistered newly-created directory is removed only when empty', async t => {
  const b = await crash(t, 'mkdir'), precious = path.join(b.home, 'precious'); await fs.writeFile(precious, 'USER FILE');
  await b.store.load(); await b.store.load();
  assert.equal(await fs.readFile(precious, 'utf8'), 'USER FILE'); assert.equal(await exists(b.recordFile), true);
});
