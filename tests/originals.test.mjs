import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sandbox, exists, joinText, textOf} from './helpers.mjs';
import {resolve} from '../src/i18n.mjs';
import {Store, plan, applyPlan, planRestoreOriginal, applyRestoreOriginal, status} from '../src/engine.mjs';
import {readOriginals, originalBytes} from '../src/originals.mjs';
import {fileUnit} from '../src/drivers/common.mjs';

const recipe = {id: 'r', key: 'r@1', name: 'Original test', version: '1', texts: {main: 'MAIN', sub: 'SUB', userSteer: 'USER', subSteer: 'SUB'}};
const put = async (file, bytes) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes); };
async function box(t) { const b = await sandbox(t, {sources: []}); return {...b, store: new Store(b.file('original-state'))}; }
async function change(b, harness, value) {
  const home = b.file(harness), file = path.join(home, 'config.json');
  return applyPlan(b.store, await plan({store: b.store, harness, home, recipe, desired: [
    {type: 'jsonKey', path: file, pointer: ['instruction'], afterValue: value}, fileUnit(path.join(home, 'recipe-switch/main'), value),
  ]}));
}

test('originals: first-touch whole-file snapshot is immutable through multiple switches and restore is byte exact', async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'config.json');
  const before = Buffer.from('\uFEFF{\r\n  "model": "keep", "escaped": "\\u0041"\r\n}\r\n'); await put(file, before);
  await change(b, 'fixture', 'ONE');
  const first = await readOriginals(b.store, 'fixture', home), manifestBytes = await fs.readFile(first.manifest);
  assert.equal(first.files.length, 2); assert.equal(first.files[0].existed, true); assert.ok(first.files[0].mtime);
  assert.equal(first.files[1].existed, false); assert.equal(first.files[1].hash, null);
  assert.deepEqual(await originalBytes(b.store, first.files[0]), before);
  await change(b, 'fixture', 'TWO'); await change(b, 'fixture', 'THREE');
  assert.deepEqual(await fs.readFile(first.manifest), manifestBytes);
  const planned = await planRestoreOriginal(b.store, 'fixture', home);
  assert.deepEqual(planned.blocked, []); assert.equal(planned.files.length, 2);
  await applyRestoreOriginal(b.store, planned);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(await exists(path.join(home, 'recipe-switch')), false);
  assert.equal((await status(b.store, 'fixture', home)).installed, false);
  assert.equal(await exists(first.manifest), false, 'cycle ends and the manifest retires after restoration');
});

test('originals: two harnesses share one blob; absent original files do not allocate blobs', async t => {
  const b = await box(t), before = '{ "model": "same" }\n';
  for (const harness of ['one', 'two']) { await put(b.file(`${harness}/config.json`), before); await change(b, harness, 'MAIN'); }
  const one = await readOriginals(b.store, 'one', b.file('one')), two = await readOriginals(b.store, 'two', b.file('two'));
  assert.equal(one.files[0].hash, two.files[0].hash);
  assert.deepEqual(await fs.readdir(path.join(b.store.home, 'blobs')), [one.files[0].hash]);
  await change(b, 'absent', 'MAIN');
  const absent = await readOriginals(b.store, 'absent', b.file('absent'));
  assert.ok(absent.files.every(row => row.existed === false && row.hash === null));
  assert.deepEqual(await fs.readdir(path.join(b.store.home, 'blobs')), [one.files[0].hash]);
  const orphan = 'a'.repeat(64); await put(path.join(b.store.home, 'blobs', orphan), 'unreferenced interrupted capture');
  await applyRestoreOriginal(b.store, await planRestoreOriginal(b.store, 'one', b.file('one')));
  assert.equal(await exists(path.join(b.store.home, 'blobs', orphan)), false);
  assert.equal(await exists(path.join(b.store.home, 'blobs', two.files[0].hash)), true, 'referenced originals are never collected');
});

test('originals: whole-file hand edits block restoration; force backs up the complete edited version', async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'config.json'), before = '{"model":"keep"}\n';
  await put(file, before); await change(b, 'fixture', 'MAIN');
  const edited = (await fs.readFile(file, 'utf8')).replace('keep', 'USER MODEL'); await put(file, edited);
  const blocked = await planRestoreOriginal(b.store, 'fixture', home);
  assert.equal(blocked.drift.length, 1); assert.match(joinText(blocked.blocked), /hand edit/);
  await assert.rejects(applyRestoreOriginal(b.store, blocked), /Blocked/);
  assert.equal(await fs.readFile(file, 'utf8'), edited);
  const forced = await planRestoreOriginal(b.store, 'fixture', home, {force: true}), result = await applyRestoreOriginal(b.store, forced);
  const index = JSON.parse(await fs.readFile(path.join(result.backup, 'index.json'), 'utf8')), row = index.find(row => path.resolve(row.path) === file);
  assert.equal(await fs.readFile(path.join(b.store.home, 'blobs', row.blob.hash), 'utf8'), edited);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('originals: Kimi SYSTEM.md and registry snapshots restore full originals after switches', async t => {
  const b = await sandbox(t, {sources: []}), home = b.file('kimi'), original = Buffer.from('USER ORIGINAL SYSTEM\r\n');
  b.service.homes['kimi-code'] = home; b.service.recipe = async key => ({...recipe, key, texts: {...recipe.texts, main: key}});
  await put(path.join(home, 'SYSTEM.md'), original); await put(path.join(home, 'plugins/installed.json'), '{ "version": 1, "plugins": [] }\n');
  for (const key of ['a', 'b', 'c']) await b.service.apply((await b.service.preview({harness: 'kimi-code', recipe: key, force: true})).id);
  const originalView = await readOriginals(b.service.store, 'kimi-code', home);
  assert.ok(originalView.files.some(row => row.path.endsWith('/SYSTEM.md') && row.existed));
  await applyRestoreOriginal(b.service.store, await planRestoreOriginal(b.service.store, 'kimi-code', home));
  assert.deepEqual(await fs.readFile(path.join(home, 'SYSTEM.md')), original);
  assert.equal(await fs.readFile(path.join(home, 'plugins/installed.json'), 'utf8'), '{ "version": 1, "plugins": [] }\n');
  assert.equal(await exists(path.join(home, 'plugins/managed')), false);
});

test('originals: corrupt blob stops before target mutation', async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'config.json');
  await put(file, '{"model":"keep"}\n'); await change(b, 'fixture', 'MAIN');
  const original = await readOriginals(b.store, 'fixture', home), before = await fs.readFile(file);
  await put(path.join(b.store.home, 'blobs', original.files[0].hash), 'CORRUPT');
  await assert.rejects(planRestoreOriginal(b.store, 'fixture', home), /missing or corrupt/);
  assert.deepEqual(await fs.readFile(file), before);
});


test('originals: CLI list and restore dry run use the same snapshots and --yes restoration', async t => {
  const b = await sandbox(t, {sources: []}), {main} = await import('../bin/recipe-switch.mjs');
  b.service.recipe = async () => recipe; b.service.homes.opencode = b.file('opencode');
  const file = b.file('opencode/opencode.json'), before = '{ "model": "keep", "instructions": [] }\r\n'; await put(file, before);
  await b.service.apply((await b.service.preview({harness: 'opencode', recipe: recipe.key})).id);
  const current = await fs.readFile(file), log = [], originalLog = console.log;
  console.log = (...args) => log.push(args.join(' '));
  try {
    await main(['originals', 'opencode'], b.service);
    assert.match(log.join('\n'), /Original backup:.*\nManifest:/); assert.match(log.join('\n'), /sha256/);
    await main(['restore-original', 'opencode'], b.service);
    assert.match(log.join('\n'), /Dry run/); assert.deepEqual(await fs.readFile(file), current);
    await main(['restore-original', 'opencode', '--yes'], b.service);
  } finally { console.log = originalLog; }
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('originals: HTTP list, redacted original viewer, blocked preview and force restore form a complete flow', async t => {
  const b = await sandbox(t, {sources: []}), {createServer} = await import('../src/server.mjs');
  b.service.recipe = async () => recipe;
  const file = b.file('opencode/opencode.json'), before = '{"model":"keep","api_key":"ORIGINAL-SECRET","instructions":[]}\n'; await put(file, before);
  await b.service.apply((await b.service.preview({harness: 'opencode', recipe: recipe.key})).id);
  const {server, token} = createServer({service: b.service});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(base + route, {method: body ? 'POST' : 'GET', headers: {'x-recipe-switch-token': token, 'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const list = await call('/api/originals?harness=opencode'), original = list.files.find(row => row.path.endsWith('/opencode.json'));
  const view = await call(`/api/original-file?harness=opencode&id=${original.id}`);
  assert.match(view.text, /redacted/); assert.doesNotMatch(view.text, /ORIGINAL-SECRET/);
  await put(file, (await fs.readFile(file, 'utf8')).replace('keep', 'USER EDIT'));
  const blocked = await call('/api/preview-original', {harness: 'opencode'});
  assert.equal(blocked.kind, 'restore-original'); assert.equal(blocked.blocked.length, 1);
  assert.equal(blocked.units, undefined); assert.equal(blocked.manifestVersion, undefined);
  const force = await call('/api/preview-original', {harness: 'opencode', force: true});
  assert.equal(force.blocked.length, 0); assert.doesNotMatch(JSON.stringify(force), /ORIGINAL-SECRET/);
  await call('/api/apply', {planId: force.id});
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const row = (await call('/api/overview')).targets.find(row => row.harness === 'opencode');
  assert.equal(row.managed.installed, false); assert.equal(row.originals.ended, true); assert.equal(row.originals.restorable, false); assert.equal(row.originals.alreadyOriginal, true);
});

test('originals: a failed first write does not publish a snapshot of an install that never committed', async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'config.json'); await put(file, '{"model":"first"}\n');
  const save = b.store.save; b.store.save = async () => { throw new Error('state not committed'); };
  await assert.rejects(change(b, 'fixture', 'MAIN'), /state not committed/); b.store.save = save;
  assert.equal(await readOriginals(b.store, 'fixture', home), null);
  await put(file, '{"model":"actual original"}\n'); await change(b, 'fixture', 'MAIN');
  const original = await readOriginals(b.store, 'fixture', home);
  assert.equal((await originalBytes(b.store, original.files[0])).toString(), '{"model":"actual original"}\n');
});


test('originals: crash after state commit publishes the staged first snapshot on the next load', async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'original'), before = Buffer.from('ORIGINAL\r\n'); await put(file, before);
  const {spawnSync} = await import('node:child_process'), engine = new URL('../src/engine.mjs', import.meta.url).href;
  const source = `import {Store,plan,applyPlan} from ${JSON.stringify(engine)};const s=new Store(process.argv[1]),home=process.argv[2],file=process.argv[3];const p=await plan({store:s,harness:'fixture',home,recipe:{key:'r'},desired:[{type:'file',path:file,afterBytes:Buffer.from('MANAGED')}],force:true});const save=s.save.bind(s);s.save=async state=>{await save(state);process.exit(0)};await applyPlan(s,p);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, b.store.home, home, file], {encoding: 'utf8', env: b.env});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readOriginals(b.store, 'fixture', home), null);
  await b.store.load();
  const original = await readOriginals(b.store, 'fixture', home); assert.deepEqual(await originalBytes(b.store, original.files[0]), before);
  await applyRestoreOriginal(b.store, await planRestoreOriginal(b.store, 'fixture', home));
  assert.deepEqual(await fs.readFile(file), before); assert.equal(await exists(b.store.pending), false);
});


test('O01: blobs and operation backups are private before bytes; ACL failure refuses capture', async t => {
  const b = await box(t), file = b.file('fixture/config.json'); await put(file, '{"api_key":"FAKE PRIVATE"}');
  const result = await change(b, 'fixture', 'ONE'), original = await readOriginals(b.store, 'fixture', b.file('fixture'));
  const blob = path.join(b.store.home, 'blobs', original.files[0].hash);
  if (process.platform === 'win32') {
    const {execFileSync} = await import('node:child_process');
    for (const item of [path.dirname(blob), blob, result.backup]) {
      const acl = execFileSync('icacls', [item], {encoding: 'utf8'});
      assert.doesNotMatch(acl, /(?:BUILTIN\\Users|Authenticated Users|S-1-5-32-545|S-1-5-11)/i);
    }
  } else {
    assert.equal((await fs.stat(path.dirname(blob))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(blob)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o700);
  }
  const {privateDirectory} = await import('../src/private-storage.mjs');
  await assert.rejects(privateDirectory(file)); // a file cannot become a private directory
});

for (const backupOnly of [false, true]) test(`O02/O03: legacy migration on load prefers earliest ${backupOnly ? 'complete operation backup' : 'layoutBefore'} over later neighbour edits`, async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'config.json'), before = '{"model":"REAL ORIGINAL"}\r\n';
  await put(file, before); await change(b, 'fixture', 'ONE');
  const first = await readOriginals(b.store, 'fixture', home); await fs.unlink(first.manifest);
  const state = await b.store.readState(), target = Object.values(state.targets)[0];
  if (backupOnly) for (const op of target.stack) for (const unit of op.units) { delete unit.layoutBefore; delete unit.layoutAfter; }
  await b.store.save(state); await put(file, (await fs.readFile(file, 'utf8')).replace('REAL ORIGINAL', 'LATER NEIGHBOUR'));
  const live = await fs.readFile(file); await b.store.load();
  assert.deepEqual(await fs.readFile(file), live, 'load migrates metadata only');
  const original = await readOriginals(b.store, 'fixture', home), entry = original.files.find(entry => entry.path.endsWith('config.json'));
  assert.equal((await originalBytes(b.store, entry)).toString(), before);
  assert.equal(entry.source, backupOnly ? 'operation-backup-blob' : 'operation-layout-before');
  assert.equal(entry.reconstructed, undefined);
});

test('O02/O03: incomplete legacy records are labelled reconstructed per file and require extra CLI/API confirmation', async t => {
  const b = await box(t), home = b.file('opencode'), file = path.join(home, 'opencode.json');
  b.service.homes.opencode = home; b.service.recipe = async () => recipe;
  await put(file, '{"model":"BASE","instructions":[]}'); await b.service.apply((await b.service.preview({harness: 'opencode', recipe: recipe.key})).id);
  const original = await readOriginals(b.service.store, 'opencode', home); await fs.unlink(original.manifest);
  const state = await b.service.store.readState();
  for (const target of Object.values(state.targets)) for (const op of target.stack) {
    delete op.backup;
    for (const unit of op.units) { delete unit.layoutBefore; delete unit.layoutAfter; }
  }
  await b.service.store.save(state); await put(file, (await fs.readFile(file, 'utf8')).replace('BASE', 'LATER'));
  const view = await b.service.originals({harness: 'opencode'});
  assert.equal(view.reconstructed, true); assert.match(textOf(view.reasons[0].reason), /No earliest whole-file/);
  const p = await b.service.previewOriginal({harness: 'opencode'});
  assert.match(joinText(p.blocked), /reconstructed.*--force/);
  await assert.rejects(b.service.apply(p.id), /Blocked/);
  const {main} = await import('../bin/recipe-switch.mjs'), log = [], output = console.log;
  console.log = (...xs) => log.push(xs.join(' '));
  try { await main(['originals', 'opencode', '--lang', 'zh'], b.service); } finally { console.log = output; }
  assert.match(log.join('\n'), /重建版本：可能包含安装后的其它修改/);
  const force = await b.service.previewOriginal({harness: 'opencode', force: true}); assert.deepEqual(force.blocked, []);
});

for (const ordinary of [true, false]) test(`O04: ${ordinary ? 'ordinary uninstall' : 'restore-original'} ends cycle, retires manifest and next install recaptures`, async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'config.json'); await put(file, '{"model":"FIRST"}');
  await change(b, 'fixture', 'ONE'); const first = await readOriginals(b.store, 'fixture', home);
  if (ordinary) {
    const {planUndo, applyUndo} = await import('../src/engine.mjs'); await applyUndo(b.store, await planUndo(b.store, 'fixture', home, {all: true}));
  } else await applyRestoreOriginal(b.store, await planRestoreOriginal(b.store, 'fixture', home));
  assert.equal(await exists(first.manifest), false);
  await put(file, '{"model":"SECOND"}'); await change(b, 'fixture', 'TWO');
  const next = await readOriginals(b.store, 'fixture', home);
  assert.equal((await originalBytes(b.store, next.files[0])).toString(), '{"model":"SECOND"}');
  assert.notEqual(next.capturedAt, first.capturedAt);
});

test('O04: 1 MiB install then four restores stores one original blob and at most one carrier; no-op creates no backups', async t => {
  const b = await box(t), home = b.file('fixture'), file = path.join(home, 'SYSTEM.md'), before = Buffer.alloc(1024 * 1024, 65); before[0] = 0;
  await put(file, before);
  await applyPlan(b.store, await plan({store: b.store, harness: 'fixture', home, recipe, desired: [fileUnit(file, 'MANAGED')], force: true}));
  const original = await readOriginals(b.store, 'fixture', home), hash = original.files[0].hash;
  const changes = [];
  for (let i = 0; i < 4; i++) changes.push((await applyRestoreOriginal(b.store, await planRestoreOriginal(b.store, 'fixture', home))).changed);
  assert.deepEqual(changes, [true, false, false, false]);
  assert.equal((await fs.readdir(path.join(b.store.home, 'backups'))).length, 2);
  let copies = 0, carriers = 0;
  async function walk(dir) { for (const e of await fs.readdir(dir, {withFileTypes: true})) {
    const f = path.join(dir, e.name); if (e.isDirectory()) await walk(f);
    else { const bytes = await fs.readFile(f); if (bytes.equals(before)) copies++; if (e.name.includes('displaced')) carriers++; }
  } }
  await walk(b.store.home);
  assert.equal(copies, 1); assert.ok(carriers <= 1); assert.deepEqual(await fs.readFile(path.join(b.store.home, 'blobs', hash)), before);
  const orphan = 'b'.repeat(64); await put(path.join(b.store.home, 'blobs', orphan), 'unreferenced');
  const {collectOrphanBlobs} = await import('../src/originals.mjs'); await collectOrphanBlobs(b.store); assert.equal(await exists(path.join(b.store.home, 'blobs', orphan)), false);
});


test('O01: failing Windows ACL command refuses blob bytes before capture', async t => {
  if (process.platform !== 'win32') return t.skip('Windows ACL failure injection');
  const b = await box(t), {spawnSync} = await import('node:child_process');
  const source = `import fs from 'node:fs/promises';import{putBlob}from ${JSON.stringify(new URL('../src/originals.mjs', import.meta.url).href)};process.env.PATH=process.argv[2];process.env.Path=process.argv[2];try{await putBlob({home:process.argv[1]},Buffer.from('PRIVATE MUST NOT WRITE'));process.exit(2)}catch(e){console.log(e.message)}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, b.store.home, b.file('empty-path')], {env: b.env, encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /Cannot secure backup directory; refusing to write/);
  assert.deepEqual(await fs.readdir(path.join(b.store.home, 'blobs')), []);
});

test('O04 UI: both languages show dated backup, reconstructed confirmation and disable completed restoration', async t => {
  const b = await box(t), {default: vm} = await import('node:vm'), app = await fs.readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  const strings = app.slice(app.indexOf('const STRINGS ='), app.indexOf('let lang ='));
  const block = app.slice(app.indexOf('function originalsBlock('), app.indexOf('async function viewOriginal('));
  const el = (tag, attrs, ...children) => ({tag, ...attrs, children: children.flat(Infinity).filter(Boolean)});
  for (const lang of ['zh', 'en']) {
    const context = {el, fmtTime: value => value, displayPath: value => value, pathRow: value => value,
      msg: item => typeof item === 'string' ? item : resolve(item, lang).text,
      msgDetail: item => resolve(item, lang).detail,
      note: (kind, title, items) => ({kind, title, children: items}), undoFlow() {}, viewOriginal() {}};
    vm.createContext(context); vm.runInContext(strings + `\nconst t=(key,...args)=>typeof STRINGS.${lang}[key]==='function'?STRINGS.${lang}[key](...args):STRINGS.${lang}[key];\n` + block + ';globalThis.render=originalsBlock;', context);
    const active = context.render({harness: 'fixture', originals: {capturedAt: '2026-10-31T00:00:00Z', restorable: true, files: []}});
    assert.match(JSON.stringify(active), lang === 'zh' ? /2026-10-31 的备份/ : /backup from 2026-10-31/);
    const ended = context.render({harness: 'fixture', originals: {capturedAt: '2026-10-31T00:00:00Z', ended: true, alreadyOriginal: true, restorable: false, files: []}});
    assert.match(JSON.stringify(ended), /"disabled":true/); assert.match(JSON.stringify(ended), lang === 'zh' ? /已经是装之前的状态/ : /Already at the pre-install state/);
  }
  assert.doesNotMatch(app, /Tool default/); assert.match(app, /planned\.reconstructed && !force/); assert.match(app, /Boolean\(planned\.noChange\)/);
});
