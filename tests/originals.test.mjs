import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sandbox, exists, joinText} from './helpers.mjs';
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
  assert.deepEqual(await fs.readFile(first.manifest), manifestBytes, 'original references survive restoration');
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
  assert.equal(await fs.readFile(path.join(result.backup, row.copy), 'utf8'), edited);
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
  assert.equal(row.managed.installed, false); assert.equal(row.originals.files.length, list.files.length);
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
