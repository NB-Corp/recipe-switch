import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sandbox, exists} from './helpers.mjs';
import {Store, plan, applyPlan, planUndo, applyUndo} from '../src/engine.mjs';
import {restoreDisplaced} from '../src/fsx.mjs';
import {fileUnit} from '../src/drivers/common.mjs';
import {collectOrphanBlobs} from '../src/originals.mjs';

const recipe = {id: 'r', key: 'r@1', name: 'Round 4', version: '1'};
async function box(t) {
  const b = await sandbox(t, {sources: []}), home = b.file('target');
  return {...b, home, target: path.join(home, 'nested/main'), store: new Store(b.file('round4-state'))};
}
const preview = (b, text, extra = {}) => plan({store: b.store, harness: 'fixture', home: b.home, recipe,
  desired: [fileUnit(b.target, text)], ...extra});
const install = async (b, text) => applyPlan(b.store, await preview(b, text));
const unsupported = () => Object.assign(Error('unsupported link'), {code: 'ENOTSUP'});

// These cases also replace the former COPYFILE_EXCL crash boundary: no copy is reachable.
test('R23: preview blocks unsafe filesystems in CLI/UI, even under force; target bytes stay exact', async t => {
  const b = await box(t); await install(b, 'ORIGINAL\r\n');
  const link = fs.link, copy = fs.copyFile; let copied = false;
  fs.link = async () => { throw unsupported(); };
  fs.copyFile = async () => { copied = true; throw Error('must never copy'); };
  try {
    const planned = await preview(b, 'NEXT', {force: true});
    assert.match(planned.blocked.join('\n'), /该位置的文件系统不支持硬链接（常见于 FAT\/exFAT\/部分网络盘），recipe-switch 无法保证安全写入/);
    assert.match(planned.blocked.join('\n'), /filesystem does not support hard links/);
    await assert.rejects(applyPlan(b.store, planned), /blocked/);
    assert.equal(await fs.readFile(b.target, 'utf8'), 'ORIGINAL\r\n');
    assert.deepEqual(await fs.readdir(path.dirname(b.target)), ['main']);
    const {main} = await import('../bin/recipe-switch.mjs'), log = [], original = console.log;
    console.log = (...xs) => log.push(xs.join(' '));
    try { await main(['install', 'fixture', 'r@1'], {preview: async () => planned}); } finally { console.log = original; }
    assert.match(log.join('\n'), /不支持硬链接/);
    const app = await fs.readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
    assert.match(app, /planned\.blocked/); // UI consumes the same bilingual blocked payload.
  } finally { fs.link = link; fs.copyFile = copy; }
  assert.equal(copied, false);
});

test('R23: link capability lost after preview restores the original via guarded rename', async t => {
  const b = await box(t); await install(b, 'ORIGINAL');
  const planned = await preview(b, 'NEXT'), link = fs.link, rename = fs.rename; let restored = false;
  fs.link = async () => { throw unsupported(); };
  fs.rename = async (from, to) => { if (to === b.target && String(from).endsWith('.displaced')) restored = true; return rename(from, to); };
  try { await assert.rejects(applyPlan(b.store, planned), /unsupported link/); }
  finally { fs.link = link; fs.rename = rename; }
  assert.equal(restored, true);
  assert.equal(await fs.readFile(b.target, 'utf8'), 'ORIGINAL');
  assert.equal(await exists(b.store.pending), false);
});

test('R23: restore hardlink EEXIST preserves both versions without rename or overwrite', async t => {
  const b = await box(t); await fs.mkdir(b.home, {recursive: true});
  const target = path.join(b.home, 'main'), saved = target + '.displaced';
  await fs.writeFile(target, 'NEW USER'); await fs.writeFile(saved, 'OLD USER');
  const rename = fs.rename; let renamed = false;
  fs.rename = async () => { renamed = true; throw Error('must not rename on EEXIST'); };
  try { await assert.rejects(restoreDisplaced(target, saved, b.home), /newer file kept.*displaced version kept/); }
  finally { fs.rename = rename; }
  assert.equal(renamed, false);
  assert.equal(await fs.readFile(target, 'utf8'), 'NEW USER'); assert.equal(await fs.readFile(saved, 'utf8'), 'OLD USER');
});

test('R22: process exit during registered partial temp preparation replays without payload comparison', async t => {
  const b = await box(t); await install(b, 'MANAGED 1');
  const engine = new URL('../src/engine.mjs', import.meta.url).href, common = new URL('../src/drivers/common.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs/promises';import{Store,plan,applyPlan}from ${JSON.stringify(engine)};import{fileUnit}from ${JSON.stringify(common)};const s=new Store(process.argv[1]),home=process.argv[2],file=process.argv[3];const p=await plan({store:s,harness:'fixture',home,recipe:${JSON.stringify(recipe)},desired:[fileUnit(file,'MANAGED 2')]});const write=fs.writeFile;fs.writeFile=async(f,bytes,...args)=>{if(String(f).startsWith(file+'.recipe-switch-')&&String(f).endsWith('.tmp')){await write(f,Buffer.from(bytes).subarray(0,3),...args);process.exit(0)}return write(f,bytes,...args)};await applyPlan(s,p);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, b.store.home, b.home, b.target], {env: b.env, encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr);
  const journal = JSON.parse(await fs.readFile(b.store.pending));
  assert.equal((await fs.readFile(journal.files[0].temp)).length, 3);
  await b.store.load(); await b.store.load();
  assert.equal(await exists(journal.files[0].temp), false); assert.equal(await exists(b.store.pending), false);
  assert.equal(await fs.readFile(b.target, 'utf8'), 'MANAGED 1');
  await install(b, 'MANAGED 3');
});

for (const crossVolume of [false, true]) test(`R01: latest carrier only; late writes become blobs at next-commit read (${crossVolume ? 'EXDEV' : 'same volume'})`, async t => {
  const b = await box(t); await install(b, 'MANAGED 1');
  const rename = fs.rename;
  if (crossVolume) fs.rename = async (from, to) => {
    if (String(from).endsWith('.displaced') && String(to).includes('backups')) throw Object.assign(Error('EXDEV'), {code: 'EXDEV'});
    return rename(from, to);
  };
  const handle = await fs.open(b.target, 'r+');
  try {
    const switched = await install(b, 'MANAGED 2'), saved = switched.replacedVersions[0].saved;
    await handle.write('LATE USER', 0); await handle.truncate(9);
    assert.equal(await fs.readFile(saved, 'utf8'), 'LATE USER');
    // A failed next operation has not reached the retention cutoff.
    const planned = await preview(b, 'FAIL'), save = b.store.save;
    b.store.save = async () => { throw Error('save failure'); };
    try { await assert.rejects(applyPlan(b.store, planned), /save failure/); } finally { b.store.save = save; }
    assert.equal(await fs.readFile(saved, 'utf8'), 'LATE USER');
    for (let n = 3; n <= 6; n++) await install(b, `MANAGED ${n}`);
    assert.equal(await exists(saved), false);
    const oldIndex = JSON.parse(await fs.readFile(path.join(switched.backup, 'index.json')))[0];
    assert.equal(oldIndex.laterVersions.length, 1);
    const blob = path.join(b.store.home, 'blobs', oldIndex.laterVersions[0].hash);
    assert.equal(await fs.readFile(blob, 'utf8'), 'LATE USER');
    // This is after the documented cutoff; it must not change the saved snapshot.
    await handle.write('AFTER CUT', 0); await handle.truncate(9);
    assert.equal(await fs.readFile(blob, 'utf8'), 'LATE USER');
    await applyUndo(b.store, await planUndo(b.store, 'fixture', b.home, {all: true}));
    const state = await b.store.load();
    assert.equal(state.replacedVersions.flatMap(group => group.files).length, 1);
    let carriers = 0;
    for (const dir of await fs.readdir(path.join(b.store.home, 'backups'))) {
      const index = JSON.parse(await fs.readFile(path.join(b.store.home, 'backups', dir, 'index.json')));
      for (const row of index) for (const file of row.replacedVersions ?? []) { assert.equal(await exists(file), true); carriers++; }
    }
    assert.equal(carriers, 1);
    assert.equal(await exists(b.target), false);
    await collectOrphanBlobs(b.store); assert.equal(await fs.readFile(blob, 'utf8'), 'LATE USER');
  } finally { fs.rename = rename; await handle.close(); }
});
