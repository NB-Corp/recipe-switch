import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store, plan, applyPlan, planUndo, applyUndo} from '../src/engine.mjs';
import {sandbox} from './helpers.mjs';
import {privateDirectory, privateScope, readAcl} from '../src/private-storage.mjs';
import {putBlob} from '../src/originals.mjs';
import {writeFile} from '../src/fsx.mjs';
const windows = process.platform === 'win32';
const ic = (...args) => execFileSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), args, {encoding: 'utf8', windowsHide: true});
const noEveryone = async file => assert.doesNotMatch(await readAcl(file), /;;;WD\)/);

test('R32/O01: recursive cache rechecks a leaf ACL widened without changing its parent, in the same scope and across scopes', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), store = {home: b.file('cache')}, bytes = Buffer.from('CACHE PRIVATE');
  const hash = await putBlob(store, bytes), file = path.join(store.home, 'blobs', hash);
  await privateScope(async () => {
    await privateDirectory(store.home); ic(file, '/grant', '*S-1-1-0:R', '/q');
    await putBlob(store, bytes); await noEveryone(file);
  });
  ic(file, '/grant', '*S-1-1-0:R', '/q');
  await privateScope(() => putBlob(store, bytes)); await noEveryone(file);
});

test('R32/O01: a widened cached private directory is reaudited before the next secret write', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), dir = b.file('cached-root');
  await privateDirectory(dir); ic(dir, '/grant', '*S-1-1-0:(OI)(CI)R', '/q');
  const file = path.join(dir, 'secret');
  await writeFile(file, Buffer.from('PRIVATE'), {privateRoot: dir});
  await noEveryone(dir); await noEveryone(file);
});

test('R32/R28: single-file temp ACL widening invalidates the fresh-inode token before private payload', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), root = b.file('temp-root'), file = path.join(root, 'secret'), temp = file + '.tmp';
  const open = fs.open; let checked = false;
  fs.open = async (f, ...args) => {
    const handle = await open(f, ...args);
    if (f === temp) { const write = handle.writeFile.bind(handle); handle.writeFile = async bytes => { await noEveryone(temp); checked = true; return write(bytes); }; }
    return handle;
  };
  try { await writeFile(file, Buffer.from('PRIVATE'), {privateRoot: root, temp, onStage: async phase => { if (phase === 'temp-created') ic(temp, '/grant', '*S-1-1-0:R', '/q'); }}); }
  finally { fs.open = open; }
  assert.ok(checked); await noEveryone(file);
});

test('R32: apply refuses a target ACL changed since preview before backing up or mutating targets', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), {service} = b;
  service.recipe = async key => ({id: key, key, texts: {main: 'MAIN', sub: 'SUB'}, artifacts: async () => new Map([['main.md', Buffer.from('MAIN')]])});
  const home = b.env.CODEX_HOME, file = path.join(home, 'config.toml'), original = await fs.readFile(file);
  const p = await service.preview({harness: 'codex', recipe: 'r'});
  ic(file, '/grant', '*S-1-5-32-546:R', '/q');
  await assert.rejects(service.apply(p.id), /目标权限.*Target ACL changed since preview/);
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual((await service.store.load()).targets, {});
});

test('R32/R28: target ACL changes after apply preflight invalidate its snapshot before payload', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), home = b.file('late-acl-home'), file = path.join(home, 'config.json'), store = new Store(b.file('late-acl-state'));
  await fs.mkdir(home); const before = Buffer.from('{"api_key":"FAKE-PRIVATE"}\n'); await fs.writeFile(file, before);
  const p = await plan({store, home, harness: 'fixture', recipe: {key: 'r'}, desired: [{type: 'jsonKey', path: file, pointer: ['instruction'], afterValue: 'MAIN'}]});
  const open = fs.open; let changed = false, payload = false;
  fs.open = async (f, ...args) => {
    const handle = await open(f, ...args);
    if (String(f).startsWith(file + '.recipe-switch-') && String(f).endsWith('.tmp')) {
      ic(file, '/grant', '*S-1-5-32-546:R', '/q'); changed = true;
      const write = handle.writeFile.bind(handle); handle.writeFile = async bytes => { payload = true; return write(bytes); };
    }
    return handle;
  };
  try { await assert.rejects(applyPlan(store, p), /File changed after permission inspection/); } finally { fs.open = open; }
  assert.ok(changed); assert.equal(payload, false); assert.deepEqual(await fs.readFile(file), before);
});

test('R32: Codex preview/apply subprocess budgets stay bounded across install, switch and uninstall', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), root = b.file('perf'), home = path.join(root, 'codex'), state = path.join(root, 'state');
  await fs.mkdir(home, {recursive: true}); await fs.writeFile(path.join(home, 'config.toml'), 'model = "keep"\n');
  const sid = execFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8'}).match(/S-1-\d+(?:-\d+)+/)[0];
  ic(home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/q');
  const code = `import cp from 'node:child_process';import path from 'node:path';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
    let calls=0,users=0;const original=cp.execFile,run=promisify(original);function wrapper(...a){return original(...a)};
    wrapper[promisify.custom]=async(file,...a)=>{if(path.basename(file)==='icacls.exe')calls++;if(path.basename(file)==='whoami.exe')users++;return run(file,...a)};cp.execFile=wrapper;syncBuiltinESMExports();
    const {Service}=await import(${JSON.stringify(new URL('../src/service.mjs', import.meta.url).href)}),s=new Service({env:process.env,home:process.argv[2],homes:{codex:process.argv[1]}}),out=[];
    s.recipe=async key=>({id:key,key,texts:{main:key,sub:key},artifacts:async()=>new Map([['main.md',Buffer.from(key)],['sub.md',Buffer.from(key)]])});
    async function measure(name,fn){calls=0;const start=performance.now(),result=await fn();out.push({name,calls,ms:performance.now()-start});return result}
    let p=await measure('install-preview',()=>s.preview({harness:'codex',recipe:'one'}));await measure('install-apply',()=>s.apply(p.id));
    p=await measure('switch-preview',()=>s.preview({harness:'codex',recipe:'two'}));await measure('switch-apply',()=>s.apply(p.id));
    p=await measure('uninstall-preview',()=>s.previewUndo({harness:'codex',all:true}));await measure('uninstall-apply',()=>s.applyUndo(p.id));console.log(JSON.stringify({out,users}));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code, home, state], {encoding: 'utf8', env: {...process.env, ...b.env}});
  const {out, users} = JSON.parse(output); assert.equal(users, 1);
  for (const row of out) assert.ok(row.calls <= (row.name.endsWith('preview') ? 3 : 10), JSON.stringify(row));
  t.diagnostic(JSON.stringify(out));
});

test('R31/O01: installing and uninstalling an unresolved SID target also privatizes its archived inode', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), home = b.file('unresolved-home'), file = path.join(home, 'config.json'), store = new Store(b.file('unresolved-state'));
  await fs.mkdir(home); const before = Buffer.from('{"api_key":"FAKE-PRIVATE"}\n'); await fs.writeFile(file, before);
  const sid = execFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8'}).match(/S-1-\d+(?:-\d+)+/)[0];
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetSecurityDescriptorSddlForm($env:RS_ACL_SDDL,[System.Security.AccessControl.AccessControlSections]::Access); [IO.File]::SetAccessControl($env:RS_ACL_PATH,$a)'],
  {env: {...process.env, RS_ACL_PATH: file, RS_ACL_SDDL: `D:P(D;;WP;;;BG)(A;;FA;;;${sid})(A;;FR;;;S-1-5-21-111-222-333-444)`}, windowsHide: true});
  const expected = await readAcl(file), p = await plan({store, home, harness: 'fixture', recipe: {key: 'r'}, desired: [{type: 'jsonKey', path: file, pointer: ['instruction'], afterValue: 'MAIN'}]});
  const result = await applyPlan(store, p);
  assert.equal(await readAcl(file), expected);
  for (const version of result.replacedVersions) assert.doesNotMatch(await readAcl(version.saved), /;;;S-1-5-21-111-222-333-444\)/);
  await applyUndo(store, await planUndo(store, 'fixture', home, {all: true}));
  assert.deepEqual(await fs.readFile(file), before); assert.equal(await readAcl(file), expected);
});
