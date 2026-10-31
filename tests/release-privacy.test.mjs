import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {sandbox, exists} from './helpers.mjs';
import {Store, plan, applyPlan} from '../src/engine.mjs';
import {writeFile} from '../src/fsx.mjs';
import {privateDirectory} from '../src/private-storage.mjs';
const windows = process.platform === 'win32';
const run = (name, args) => execFileSync(path.join(process.env.SystemRoot, 'System32', name + '.exe'), args, {encoding: 'utf8', windowsHide: true});
const sid = () => run('whoami', ['/user', '/fo', 'csv', '/nh']).match(/S-1-\d+(?:-\d+)+/)[0];
async function acl(file, b) {
  const saved = b.file('acl-inspection');
  try { run('icacls', [file, '/save', saved, '/q']); return (await fs.readFile(saved)).toString('utf16le').trimEnd().split(/\r?\n/)[1]; }
  finally { await fs.unlink(saved).catch(() => {}); }
}
async function assertPrivate(file, b) {
  const stat = await fs.stat(file);
  if (!windows) { assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600, file); return; }
  const dacl = await acl(file, b);
  for (const match of dacl.matchAll(/\(([^()]*)\)/g)) {
    const [type, , , , , trustee] = match[1].split(';');
    if (type === 'A') assert.ok([sid(), 'BA', 'SY'].includes(trustee), `${file}: ${dacl}`);
  }
  assert.match(dacl, new RegExp(sid()));
}

test('O01: pre-existing explicit broad grants are removed from all private storage before payload', async t => {
  const b = await sandbox(t, {sources: []}), root = b.file('privacy-state'), store = new Store(root);
  const blobs = path.join(root, 'blobs'); await fs.mkdir(blobs, {recursive: true});
  const old = path.join(blobs, 'old'); await fs.writeFile(old, 'OLD SECRET');
  if (windows) { run('icacls', [blobs, '/grant', '*S-1-1-0:(OI)(CI)R', '/q']); run('icacls', [old, '/grant', '*S-1-5-32-545:R', '/q']); }
  else { await fs.chmod(blobs, 0o777); await fs.chmod(old, 0o666); }
  await store.load();
  for (const file of [root, blobs, old]) await assertPrivate(file, b);
  const home = b.file('target'), file = path.join(home, 'config.json');
  await fs.mkdir(home); await fs.writeFile(file, '{"api_key":"FAKE-PRIVATE-KEY"}\n');
  const originalJournal = store.journal.bind(store); let observed = false;
  store.journal = async value => {
    await originalJournal(value); await assertPrivate(store.pending, b);
    assert.match(Buffer.from(value.files[0].before, 'base64').toString(), /FAKE-PRIVATE-KEY/); observed = true;
  };
  const open = fs.open; let tempChecked = 0;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).startsWith(root) && String(file).endsWith('.tmp') && args[0] === 'wx') {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await assertPrivate(file, b); tempChecked++; return write(bytes); };
    }
    return handle;
  };
  try { await applyPlan(store, await plan({store, harness: 'fixture', home, recipe: {key: 'r'}, desired: [{type: 'jsonKey', path: file, pointer: ['instruction'], afterValue: 'MAIN'}]})); }
  finally { fs.open = open; }
  assert.ok(observed && tempChecked);
  assert.match(await fs.readFile(store.file, 'utf8'), /FAKE-PRIVATE-KEY/);
  async function walk(dir) { await assertPrivate(dir, b); for (const name of await fs.readdir(dir)) { const file = path.join(dir, name); if ((await fs.stat(file)).isDirectory()) await walk(file); else await assertPrivate(file, b); } }
  await store.load(); await walk(root);
});

test('R28: restricted target permissions are present before payload and survive replacement and compensation', async t => {
  const b = await sandbox(t, {sources: []}), home = b.file('acl-target'), file = path.join(home, 'config.json'), store = new Store(b.file('acl-state'));
  await fs.mkdir(home); const before = '{"api_key":"FAKE-PRIVATE-KEY"}\n'; await fs.writeFile(file, before);
  if (windows) run('icacls', [file, '/inheritance:r', '/grant:r', `*${sid()}:F`, '/q']); else await fs.chmod(file, 0o640);
  const permissions = async f => windows ? acl(f, b) : (await fs.stat(f)).mode & 0o777;
  const expected = await permissions(file), open = fs.open; let checked = 0;
  fs.open = async (f, ...args) => {
    const handle = await open(f, ...args);
    if (String(f).startsWith(file + '.recipe-switch-') && String(f).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { assert.equal(await permissions(f), expected); checked++; return write(bytes); };
    }
    return handle;
  };
  const preview = text => plan({store, harness: 'fixture', home, recipe: {key: 'r'}, desired: [{type: 'jsonKey', path: file, pointer: ['instruction'], afterValue: text}]});
  try {
    await applyPlan(store, await preview('ONE')); assert.equal(await permissions(file), expected);
    const p = await preview('TWO'), save = store.save;
    store.save = async () => { throw Error('injected state failure'); };
    try { await assert.rejects(applyPlan(store, p), /injected state failure/); } finally { store.save = save; }
    assert.equal(await permissions(file), expected); assert.match(await fs.readFile(file, 'utf8'), /ONE/);
    assert.equal(await exists(store.pending), false); assert.ok(checked >= 3);
  } finally { fs.open = open; }
});

test('O01/R28: failed permission setup leaves the existing target intact', async t => {
  const b = await sandbox(t, {sources: []}), file = b.file('kept.json'); await fs.writeFile(file, 'SECRET');
  // A non-directory private root must fail before any target temp/payload is created.
  await assert.rejects(writeFile(file, Buffer.from('NEW'), {expected: Buffer.from('SECRET'), privateRoot: file}), /private storage|ENOTDIR|EEXIST/);
  assert.equal(await fs.readFile(file, 'utf8'), 'SECRET');
  await assert.rejects(privateDirectory(file), /Cannot secure private storage/);
});

test('R28: recovery with a missing target and late-edited carrier privatizes restored secret bytes before writing', async t => {
  const b = await sandbox(t, {sources: []}), home = b.file('absent-target'), file = path.join(home, 'main'), store = new Store(b.file('absent-state'));
  await fs.mkdir(home); await fs.writeFile(file, 'FAKE PRIVATE ORIGINAL');
  if (windows) run('icacls', [file, '/inheritance:r', '/grant:r', `*${sid()}:F`, '/q']); else await fs.chmod(file, 0o600);
  const code = `import fs from 'node:fs/promises';import{Store,plan,applyPlan}from ${JSON.stringify(new URL('../src/engine.mjs', import.meta.url).href)};import{fileUnit}from ${JSON.stringify(new URL('../src/drivers/common.mjs', import.meta.url).href)};const [state,home,file]=process.argv.slice(1),s=new Store(state),p=await plan({store:s,harness:'fixture',home,recipe:{key:'r'},force:true,desired:[fileUnit(file,'NEW')]});const rename=fs.rename;fs.rename=async(f,t)=>{await rename(f,t);if(f===file)process.exit(0);};await applyPlan(s,p);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, store.home, home, file], {env: b.env, encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr); assert.equal(await exists(file), false);
  const journal = JSON.parse(await fs.readFile(store.pending)); await fs.writeFile(journal.files[0].displaced, 'LATE CARRIER');
  const open = fs.open; let inspected = false;
  fs.open = async (f, ...args) => {
    const handle = await open(f, ...args);
    if (String(f).endsWith('-undo.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await assertPrivate(f, b); inspected = true; return write(bytes); };
    }
    return handle;
  };
  try { await store.load(); } finally { fs.open = open; }
  assert.equal(inspected, true); await assertPrivate(file, b);
  assert.equal(await fs.readFile(file, 'utf8'), 'FAKE PRIVATE ORIGINAL'); assert.equal(await exists(store.pending), false);
});
