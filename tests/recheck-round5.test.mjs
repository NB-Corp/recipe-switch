import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sandbox, exists} from './helpers.mjs';
import {Store, plan, applyPlan, status} from '../src/engine.mjs';
import {fileUnit} from '../src/drivers/common.mjs';
import {collectOrphanBlobs} from '../src/originals.mjs';
const recipe = {id: 'r', key: 'r@1', name: 'R5', version: '1'};
async function box(t, installed = true) {
  const b = await sandbox(t, {sources: []}), home = b.file('target'), file = path.join(home, 'nested/main');
  const result = {...b, home, file, store: new Store(b.file('round5-state'))};
  if (installed) await install(result, 'MANAGED 1');
  return result;
}
const preview = (b, text) => plan({store: b.store, harness: 'fixture', home: b.home, recipe, desired: [fileUnit(b.file, text)]});
const install = async (b, text) => applyPlan(b.store, await preview(b, text));
function child(b, body) {
  const code = `import fs from 'node:fs/promises';import{Store,plan,applyPlan}from ${JSON.stringify(new URL('../src/engine.mjs', import.meta.url).href)};import{fileUnit}from ${JSON.stringify(new URL('../src/drivers/common.mjs', import.meta.url).href)};const s=new Store(process.argv[1]),home=process.argv[2],file=process.argv[3],recipe=${JSON.stringify(recipe)};${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, b.store.home, b.home, b.file], {env: b.env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}
const partial = b => child(b, `const p=await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED 2')]});const open=fs.open;fs.open=async(f,...args)=>{const h=await open(f,...args);if(String(f).startsWith(file+'.recipe-switch-')&&String(f).endsWith('.tmp'))h.writeFile=async bytes=>{await h.write(Buffer.from(bytes).subarray(0,3));process.exit(0)};return h};await applyPlan(s,p);`);

for (const replaced of [false, true]) test(`R24/R22: registered partial temp ${replaced ? 'replacement inode is kept and warned' : 'same inode is cleaned without payload comparison'}`, async t => {
  const b = await box(t); partial(b);
  const journal = JSON.parse(await fs.readFile(b.store.pending)), row = journal.files[0];
  assert.ok(row.tempIdentity.dev); assert.ok(row.tempIdentity.ino); assert.equal((await fs.readFile(row.temp)).length, 3);
  if (replaced) { await fs.rename(row.temp, row.temp + '.owned'); await fs.writeFile(row.temp, 'USER REPLACEMENT'); }
  await b.store.load(); await b.store.load();
  assert.equal(await exists(b.store.pending), false); assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 1');
  assert.equal(await exists(row.temp), replaced);
  if (replaced) { assert.equal(await fs.readFile(row.temp, 'utf8'), 'USER REPLACEMENT'); assert.match(b.store.warnings.join('\n'), /路径已被替换，未删除/); }
});

test('R24: journal path with traversal is rejected before cleanup or compensation', async t => {
  const b = await box(t); partial(b);
  const journal = JSON.parse(await fs.readFile(b.store.pending)), row = journal.files[0], precious = path.join(path.dirname(b.file), 'precious.tmp');
  await fs.writeFile(precious, 'USER PRECIOUS');
  const folder = row.path + '.recipe-switch-' + journal.id + '-attack'; await fs.mkdir(folder);
  row.temp = folder + '/../precious.tmp'; await fs.writeFile(b.store.pending, JSON.stringify(journal));
  await assert.rejects(b.store.load(), /Unregistered transaction temp/);
  assert.equal(await fs.readFile(precious, 'utf8'), 'USER PRECIOUS'); assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 1');
});

test('R24: replaced archived displaced inode is neither restored nor deleted', async t => {
  const b = await box(t); await install(b, 'MANAGED 2');
  child(b, `const p=await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED 3')]});const save=s.save.bind(s);s.save=async state=>{await save(state);process.exit(0)};await applyPlan(s,p);`);
  const journal = JSON.parse(await fs.readFile(b.store.pending)), row = journal.files[0];
  assert.ok(row.displacedIdentity.ino); await fs.rename(row.archive, row.archive + '.original'); await fs.writeFile(row.archive, 'USER ARCHIVE');
  await b.store.load(); assert.equal(await exists(b.store.pending), false);
  assert.equal(await fs.readFile(row.archive, 'utf8'), 'USER ARCHIVE'); assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 3');
  assert.match(b.store.warnings.join('\n'), /路径已被替换，未删除/);
});

for (const replaced of [false, true]) test(`R25: interrupted probe reclaims only registered identities (${replaced ? 'replacement kept' : 'files and new directories removed'})`, async t => {
  const b = await box(t, false);
  child(b, `const link=fs.link;fs.link=async(f,t)=>{await link(f,t);if(String(f).includes('.recipe-switch-probe-'))process.exit(0)};await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED')]});`);
  const dir = path.join(b.store.home, 'probes'), names = await fs.readdir(dir); assert.equal(names.length, 1);
  const record = JSON.parse(await fs.readFile(path.join(dir, names[0])));
  assert.ok(record.probeIdentity.ino); assert.ok(record.createdDirs.every(item => item.identity?.ino));
  if (replaced) { await fs.rename(record.probe, record.probe + '.original'); await fs.writeFile(record.probe, 'USER PROBE'); }
  await b.store.load(); await b.store.load();
  assert.equal(await exists(dir), false); assert.equal(await exists(record.link), false);
  if (replaced) { assert.equal(await fs.readFile(record.probe, 'utf8'), 'USER PROBE'); assert.match(b.store.warnings.join('\n'), /路径已被替换，未删除/); }
  else assert.equal(await exists(b.home), false);
});

async function carrierCount(b) {
  let count = 0;
  for (const dir of await fs.readdir(path.join(b.store.home, 'backups'))) {
    const rows = JSON.parse(await fs.readFile(path.join(b.store.home, 'backups', dir, 'index.json')));
    for (const row of rows) for (const saved of row.replacedVersions ?? []) { assert.equal(await exists(saved), true); count++; }
  }
  return count;
}
test('R26: three compensated state-save failures keep the last successful carrier only, including late-written failure blobs', async t => {
  const b = await box(t), successful = await install(b, 'MANAGED 2'), saved = successful.replacedVersions[0].saved;
  const counts = [];
  for (let n = 0; n < 3; n++) {
    const p = await preview(b, `FAIL ${n}`), save = b.store.save, rename = fs.rename;
    b.store.save = async () => { throw Error('state save failed'); };
    fs.rename = async (from, to) => {
      if (n === 0 && String(from).endsWith('-undo.displaced')) await fs.writeFile(from, 'LATER FAILURE BYTES');
      return rename(from, to);
    };
    try { await assert.rejects(applyPlan(b.store, p), /state save failed/); } finally { b.store.save = save; fs.rename = rename; }
    counts.push(await carrierCount(b)); assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 2'); assert.equal(await exists(saved), true);
  }
  assert.deepEqual(counts, [1, 1, 1]); assert.equal((await b.store.load()).replacedVersions.flatMap(group => group.files).length, 1);
  let later;
  for (const dir of await fs.readdir(path.join(b.store.home, 'backups'))) {
    const rows = JSON.parse(await fs.readFile(path.join(b.store.home, 'backups', dir, 'index.json')));
    later ??= rows.flatMap(row => row.laterVersions ?? [])[0];
  }
  assert.ok(later); await collectOrphanBlobs(b.store);
  assert.equal(await fs.readFile(path.join(b.store.home, 'blobs', later.hash), 'utf8'), 'LATER FAILURE BYTES');
});

test('R27: capability loss in compensation stays pending through second load, blocks CLI/UI and recovers after support returns', async t => {
  const b = await box(t), p = await preview(b, 'MANAGED 2'), link = fs.link, save = b.store.save;
  b.store.save = async () => { fs.link = async (from, to) => { if (to === b.file) throw Object.assign(Error('capability lost'), {code: 'ENOTSUP'}); return link(from, to); }; throw Error('state save failed'); };
  try {
    await assert.rejects(applyPlan(b.store, p), /回滚没能完成.*Current content is/);
    assert.equal(JSON.parse(await fs.readFile(b.store.pending)).files[0].recovery.phase, 'compensation-pending');
    assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 2');
    await assert.rejects(b.store.load(), /filesystem no longer supports safe writes/);
    assert.equal(await exists(b.store.pending), true); assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 2');
    assert.equal((await b.store.readState()).targets[p.key].stack.length, 1);
    await assert.rejects(preview(b, 'MANAGED 3'), /回滚没能完成/);
    const {main} = await import('../bin/recipe-switch.mjs');
    await assert.rejects(main(['install', 'fixture', 'r@1'], {preview: () => preview(b, 'MANAGED 3')}), /backup:/);
    b.service.store = b.store;
    b.service.targets = async () => [{driver: {id: 'fixture', name: 'Fixture', detect: async () => ({present: true})}, home: b.home}];
    const row = (await b.service.overview()).targets[0]; assert.match(row.error, /回滚没能完成.*Current content is/);
  } finally { fs.link = link; b.store.save = save; }
  await b.store.load(); assert.equal(await exists(b.store.pending), false); assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 1');
  assert.deepEqual((await status(b.store, 'fixture', b.home)).drift, []);
  await collectOrphanBlobs(b.store);
});


test('R26/R27: compensation verifies original before bytes; a late carrier edit becomes a preserved later-version blob', async t => {
  const b = await box(t), p = await preview(b, 'MANAGED 2'), save = b.store.save;
  b.store.save = async () => {
    const journal = JSON.parse(await fs.readFile(b.store.pending));
    await fs.writeFile(journal.files[0].archive, 'LATE BEFORE CARRIER');
    throw Error('state save failed');
  };
  try { await assert.rejects(applyPlan(b.store, p), /state save failed/); } finally { b.store.save = save; }
  assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 1'); assert.equal(await exists(b.store.pending), false);
  assert.deepEqual((await status(b.store, 'fixture', b.home)).drift, []);
  let later;
  for (const dir of await fs.readdir(path.join(b.store.home, 'backups'))) {
    const rows = JSON.parse(await fs.readFile(path.join(b.store.home, 'backups', dir, 'index.json')));
    later ??= rows.flatMap(row => row.laterVersions ?? [])[0];
  }
  assert.equal(await fs.readFile(path.join(b.store.home, 'blobs', later.hash), 'utf8'), 'LATE BEFORE CARRIER');
});


test('R24: replaced compensation temp is preserved while a new computed name finishes rollback', async t => {
  const b = await box(t);
  child(b, `const p=await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED 2')]});s.save=async()=>process.exit(0);await applyPlan(s,p);`);
  child(b, `const open=fs.open;fs.open=async(f,...args)=>{const h=await open(f,...args);if(String(f).endsWith('-undo.tmp'))h.writeFile=async bytes=>{await h.write(Buffer.from(bytes).subarray(0,3));process.exit(0)};return h};await s.load();`);
  const journal = JSON.parse(await fs.readFile(b.store.pending)), temp = journal.files[0].recovery.temp;
  await fs.rename(temp, temp + '.owned'); await fs.writeFile(temp, 'USER COMPENSATION TEMP');
  await b.store.load(); await b.store.load();
  assert.equal(await fs.readFile(temp, 'utf8'), 'USER COMPENSATION TEMP'); assert.equal(await exists(b.store.pending), false);
  assert.equal(await fs.readFile(b.file, 'utf8'), 'MANAGED 1'); assert.match(b.store.warnings.join('\n'), /路径已被替换，未删除/);
});
