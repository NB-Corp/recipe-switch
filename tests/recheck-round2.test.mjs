import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sandbox, exists, install, undo} from './helpers.mjs';
import {Store, plan, applyPlan, planUndo, applyUndo, status, targetKey} from '../src/engine.mjs';
import {fileUnit} from '../src/drivers/common.mjs';
import {withLock} from '../src/fsx.mjs';
import {hermes, hermesCapabilities} from '../src/drivers/plugins.mjs';

const recipe = {id: 'r', key: 'r@1', name: 'Round 2', version: '1', revision: '1', texts: {
  main: 'MAIN', sub: 'SUB', userSteer: 'USER', subSteer: 'SUB STEER'}};
const put = async (file, text) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };
async function box(t) {
  const b = await sandbox(t, {sources: []});
  b.service.recipe = async () => recipe;
  return {...b, home: b.file('target'), store: new Store(b.file('round2-state'))};
}
const preview = (b, desired, extra = {}) => plan({store: b.store, harness: 'fixture', home: b.home, recipe, desired, ...extra});

for (const deleting of [false, true]) test(`R01: the actual displaced version survives an edit at rename-away (${deleting ? 'delete' : 'replace'})`, async t => {
  const b = await box(t), file = path.join(b.home, 'main');
  await applyPlan(b.store, await preview(b, [fileUnit(file, 'MANAGED 1')]));
  const planned = deleting ? await planUndo(b.store, 'fixture', b.home, {all: true}) : await preview(b, [fileUnit(file, 'MANAGED 2')]);
  const rename = fs.rename; let injected = false;
  fs.rename = async (from, to) => {
    if (from === file && !injected) { injected = true; await fs.writeFile(file, 'USER IMMEDIATELY BEFORE RENAME'); }
    return rename(from, to);
  };
  try { await assert.rejects(deleting ? applyUndo(b.store, planned) : applyPlan(b.store, planned), /Changed during operation/); }
  finally { fs.rename = rename; }
  assert.equal(injected, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'USER IMMEDIATELY BEFORE RENAME');
  assert.equal((await b.store.target(planned.key)).stack.length, 1);
  assert.equal(await exists(b.store.pending), false);
  assert.deepEqual(await fs.readdir(b.home), ['main']);
});

test('R01: exclusive publication keeps a new destination and retains the displaced version for recovery', async t => {
  const b = await box(t), file = path.join(b.home, 'main');
  await applyPlan(b.store, await preview(b, [fileUnit(file, 'MANAGED 1')]));
  const planned = await preview(b, [fileUnit(file, 'MANAGED 2')]);
  const link = fs.link; let injected = false;
  fs.link = async (from, to) => {
    if (to === file && !injected) { injected = true; await fs.writeFile(file, 'USER CREATED DURING PUBLICATION'); }
    return link(from, to);
  };
  try { await assert.rejects(applyPlan(b.store, planned), /displaced version|Recovery pending/); }
  finally { fs.link = link; }
  assert.equal(injected, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'USER CREATED DURING PUBLICATION');
  const journal = JSON.parse(await fs.readFile(b.store.pending, 'utf8'));
  assert.equal(await fs.readFile(journal.files[0].displaced, 'utf8'), 'MANAGED 1');
  assert.equal(JSON.parse(await fs.readFile(b.store.file, 'utf8')).targets[planned.key].stack.length, 1);
});

test('R01: recovery restores a displaced user version after a crash before publication', async t => {
  const b = await box(t), file = path.join(b.home, 'main'), displaced = file + '.displaced';
  await put(displaced, 'USER BEFORE RENAME');
  const encode = text => Buffer.from(text).toString('base64');
  await put(b.store.pending, JSON.stringify({backup: 'fixture', stateAfter: encode('not committed'), missingDirs: [],
    files: [{path: file, boundary: b.home, before: encode('OLD'), after: encode('NEW'), displaced}]}));
  await b.store.load();
  assert.equal(await fs.readFile(file, 'utf8'), 'USER BEFORE RENAME');
  assert.equal(await exists(displaced), false);
  assert.equal(await exists(b.store.pending), false);
});

test('R02: malformed stale lock cannot authorize deleting a new live owner inside the reaper', async t => {
  const b = await box(t), lock = b.file('lock-home/transaction.lock');
  await put(lock, ''); const old = new Date(Date.now() - 60000); await fs.utimes(lock, old, old);
  const mkdir = fs.mkdir; let replaced = false, guarded = false;
  fs.mkdir = async (file, ...args) => {
    if (file === lock + '.reap' && !replaced) {
      replaced = true; await fs.unlink(lock); await fs.writeFile(lock, JSON.stringify({pid: process.pid, token: 'LIVE-OTHER'}));
    }
    return mkdir(file, ...args);
  };
  const read = fs.readFile;
  fs.readFile = async (file, ...args) => {
    const bytes = await read(file, ...args);
    if (file === lock && replaced && String(bytes).includes('LIVE-OTHER')) guarded = true;
    return bytes;
  };
  const unlink = fs.unlink;
  let externalRelease = false;
  fs.unlink = async file => {
    if (file === lock && !externalRelease && String(await read(file)).includes('LIVE-OTHER'))
      assert.fail('waiter deleted a replacement live lock');
    return unlink(file);
  };
  // Release the modelled writer only once the guard finishes inspecting it,
  // rather than unlinking on a timer while Windows may still hold a read handle.
  const rmdir = fs.rmdir;
  fs.rmdir = async (file, ...args) => {
    const result = await rmdir(file, ...args);
    if (file === lock + '.reap') { assert.equal(guarded, true); externalRelease = true; await unlink(lock); }
    return result;
  };
  try {
    await withLock(path.dirname(lock), async () => {
      assert.equal(externalRelease, true);
      assert.equal(JSON.parse(await read(lock, 'utf8')).pid, process.pid);
    });
  } finally { fs.mkdir = mkdir; fs.readFile = read; fs.unlink = unlink; fs.rmdir = rmdir; }
  assert.equal(replaced, true); assert.equal(guarded, true);
  assert.equal(await exists(lock), false);
});

test('R09: absent permission is untouched; explicit opt-in writes it, survives a switch and restores on uninstall', async t => {
  const {service, file, read} = await box(t);
  service.homes.openclaw = file('openclaw');
  const config = file('openclaw/openclaw.json'); await put(config, '{}\n');
  let {planned} = await install(service, 'openclaw', recipe.key);
  assert.match(planned.notes.join('\n'), /prerequisite.*allowConversationAccess/);
  assert.equal(JSON.parse(await read('openclaw/openclaw.json')).plugins.entries['recipe-switch'].hooks?.allowConversationAccess, undefined);
  await undo(service, 'openclaw', {all: true}); assert.equal(await read('openclaw/openclaw.json'), '{}\n');
  ({planned} = await install(service, 'openclaw', recipe.key, {options: {grantConversationAccess: true}}));
  assert.match(planned.notes.join('\n'), /explicitly granted/);
  assert.equal(JSON.parse(await read('openclaw/openclaw.json')).plugins.entries['recipe-switch'].hooks.allowConversationAccess, true);
  const switched = await install(service, 'openclaw', recipe.key);
  assert.equal(switched.planned.options.grantConversationAccess, false, 'saved grant is not fresh consent');
  assert.equal(JSON.parse(await read('openclaw/openclaw.json')).plugins.entries['recipe-switch'].hooks.allowConversationAccess, true);
  await undo(service, 'openclaw', {all: true}); assert.equal(await read('openclaw/openclaw.json'), '{}\n');
  const denied = '{"plugins":{"entries":{"recipe-switch":{"hooks":{"allowConversationAccess":false}}}}}\n';
  await put(config, denied);
  await assert.rejects(service.preview({harness: 'openclaw', recipe: recipe.key, options: {grantConversationAccess: true}, force: true}), /allowConversationAccess is false/);
  assert.equal(await read('openclaw/openclaw.json'), denied);
});

for (const [name, original, add, expected] of [
  ['created mapping', 'model: keep\n', text => text + '  neighbour: true\n', 'model: keep\nplugins: # managed by recipe-switch\n  neighbour: true\n'],
  ['created list', 'plugins:\n  other: true\n', text => text.replace('    - recipe-switch # managed by recipe-switch\n', '    - recipe-switch # managed by recipe-switch\n    - neighbour\n'), 'plugins:\n  enabled: # managed by recipe-switch\n    - neighbour\n  other: true\n'],
]) test(`R16: uninstall keeps user additions under the ${name} and valid YAML`, async t => {
  const b = await box(t), file = path.join(b.home, 'config.yaml'); await put(file, original);
  const {units} = await hermes.desired(recipe, b.home);
  await applyPlan(b.store, await preview(b, units));
  await fs.writeFile(file, add(await fs.readFile(file, 'utf8')));
  const planned = await planUndo(b.store, 'fixture', b.home, {all: true}); assert.deepEqual(planned.blocked, []);
  await applyUndo(b.store, planned);
  const after = await fs.readFile(file, 'utf8'); assert.equal(after, expected);
  const result = spawnSync('python', ['-B', '-c', 'import sys,yaml; x=yaml.safe_load(sys.stdin.read()); assert x["plugins"].get("neighbour") is True or x["plugins"].get("enabled")==["neighbour"]; print("PyYAML valid; user neighbour kept")'], {input: after, encoding: 'utf8', env: b.env});
  if (result.error?.code === 'ENOENT' || result.stderr.includes("No module named 'yaml'")) t.diagnostic('PyYAML unavailable; exact expected structure checked');
  else { assert.equal(result.status, 0, result.stderr); t.diagnostic(result.stdout.trim()); }
});

test('R16: forced uninstall respects a user-removed YAML parent mapping', async t => {
  const b = await box(t), file = path.join(b.home, 'config.yaml'), original = 'model: keep\n';
  await put(file, original);
  await applyPlan(b.store, await preview(b, (await hermes.desired(recipe, b.home)).units));
  await put(file, original);
  const planned = await planUndo(b.store, 'fixture', b.home, {all: true, force: true});
  assert.equal(planned.drift.length, 1);
  await applyUndo(b.store, planned);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('R17: a crash after uninstall state-save replays directory cleanup before removing the journal', async t => {
  const b = await box(t), file = path.join(b.home, 'nested', 'main');
  await applyPlan(b.store, await preview(b, [fileUnit(file, 'MANAGED')]));
  const engine = new URL('../src/engine.mjs', import.meta.url).href;
  const script = `import {Store,planUndo,applyUndo} from ${JSON.stringify(engine)}; const s=new Store(process.argv[1]); const p=await planUndo(s,'fixture',process.argv[2],{all:true}); const save=s.save.bind(s); s.save=async state=>{await save(state);process.exit(0)}; await applyUndo(s,p);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, b.store.home, b.home], {encoding: 'utf8', env: b.env});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await exists(b.store.pending), true); assert.equal(await exists(path.dirname(file)), true);
  const journal = JSON.parse(await fs.readFile(b.store.pending, 'utf8'));
  assert.ok(journal.cleanupDirs.some(dir => path.resolve(dir) === path.resolve(b.home)));
  assert.ok(journal.cleanupDirs.some(dir => path.resolve(dir) === path.dirname(file)));
  assert.deepEqual((await b.store.load()).targets, {});
  assert.equal(await exists(b.home), false); assert.equal(await exists(b.store.pending), false);
  await b.store.load(); assert.equal(await exists(b.home), false);
});

test('R18: legacy schema-1 YAML records have no false drift and uninstall without force', async t => {
  const b = await box(t), file = path.join(b.home, 'config.yaml'), before = 'model: keep\n';
  const after = before + 'plugins: # managed by recipe-switch\n  enabled: # managed by recipe-switch\n    - recipe-switch # managed by recipe-switch\n';
  await put(file, after);
  await b.store.save({schema: 1, targets: {[targetKey('hermes', b.home)]: {harness: 'hermes', home: b.home, stack: [{id: 'ea07297-op', recipe, createdDirs: [], units: [
    {type: 'yamlArrayItem', path: file, pointer: ['plugins', 'enabled'], value: 'recipe-switch', beforePresent: false, afterPresent: true, fileCreated: false,
      createdDepth: 2, layoutBefore: before, layoutAfter: after},
  ]}]}}});
  assert.deepEqual((await status(b.store, 'hermes', b.home)).drift, []);
  await put(file, after.replace('- recipe-switch # managed by recipe-switch', '- recipe-switch # USER NOTE'));
  assert.equal((await status(b.store, 'hermes', b.home)).drift.length, 1, 'legacy saved layout still detects owned-line edits');
  assert.equal((await planUndo(b.store, 'hermes', b.home, {all: true})).blocked.length, 1);
  await put(file, after);
  const planned = await planUndo(b.store, 'hermes', b.home, {all: true}); assert.deepEqual(planned.blocked, []);
  await applyUndo(b.store, planned); assert.equal(await fs.readFile(file, 'utf8'), before);
});

for (const supported of [false, true]) test(`R19: read-only host capability probe and plugin registration (${supported ? 'middleware' : 'steering only'})`, async t => {
  const b = await box(t), home = b.file('hermes'); b.service.homes.hermes = home;
  const source = path.join(home, 'hermes-agent', 'hermes_cli', 'plugins.py');
  await put(source, 'raise RuntimeError("host source must never execute")\nclass PluginContext:\n    def register_hook(self, name, callback):\n        pass\n' +
    (supported ? '\n    def register_middleware(self, name, callback):\n        pass\n' : '\n# register_middleware is not a host method\n'));
  const caps = await hermesCapabilities(home); assert.equal(caps.llmRequest, supported);
  const {planned} = await install(b.service, 'hermes', recipe.key);
  const row = (await b.service.overview()).targets.find(row => row.harness === 'hermes');
  assert.equal(row.capabilities.main, supported); assert.equal(row.capabilities.sub, supported);
  if (supported) { assert.match(planned.notes.join('\n'), /appended in full/); assert.match(await fs.readFile(path.join(home, 'plugins/recipe-switch/plugin.yaml'), 'utf8'), /provides_middleware/); }
  else {
    assert.match(row.mechanism, /Main\/Sub unavailable/);
    assert.match(planned.notes.join('\n'), /此 Hermes 版本不支持 llm_request middleware，只装每轮 steering；主\/子代理系统提示需升级 Hermes 后生效/);
    assert.doesNotMatch(await fs.readFile(path.join(home, 'plugins/recipe-switch/plugin.yaml'), 'utf8'), /provides_middleware/);
  }
  const python = String.raw`import importlib.util,sys
s=importlib.util.spec_from_file_location('candidate',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p)
class Old:
    def __init__(self): self.hooks={}
    def register_hook(self,name,fn): self.hooks[name]=fn
class New(Old):
    def __init__(self): super().__init__(); self.middleware={}
    def register_middleware(self,name,fn): self.middleware[name]=fn
old=Old(); p.register(old); assert old.hooks['pre_llm_call']()=={'context':'USER'}
new=New(); p.register(new); assert 'llm_request' in new.middleware; assert new.hooks['pre_llm_call'](platform='subagent')=={'context':'SUB STEER'}
print('old: steering registered; new: steering and llm_request registered')`;
  const result = spawnSync('python', ['-B', '-c', python, path.join(home, 'plugins/recipe-switch/__init__.py')], {encoding: 'utf8', env: b.env});
  assert.equal(result.status, 0, result.stderr); t.diagnostic(result.stdout.trim());
});
