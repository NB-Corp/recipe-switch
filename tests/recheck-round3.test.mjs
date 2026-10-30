import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sandbox, exists} from './helpers.mjs';
import {Store, plan, applyPlan, planUndo, applyUndo} from '../src/engine.mjs';
import {fileUnit} from '../src/drivers/common.mjs';

const recipe = {id: 'r', key: 'r@1', name: 'Round 3', version: '1', texts: {main: 'MAIN', sub: 'SUB', userSteer: 'USER', subSteer: 'SUB'}};
async function box(t) {
  const b = await sandbox(t, {sources: []});
  return {...b, home: b.file('target'), store: new Store(b.file('round3-state'))};
}
const preview = (b, text) => plan({store: b.store, harness: 'fixture', home: b.home, recipe, desired: [fileUnit(path.join(b.home, 'nested', 'main'), text)]});
const install = async (b, text) => applyPlan(b.store, await preview(b, text));
const targetFile = b => path.join(b.home, 'nested', 'main');

test('R01: writes through a held displaced inode remain recoverable in the operation backup', async t => {
  const b = await box(t), file = targetFile(b);
  await install(b, 'MANAGED 1');
  const planned = await preview(b, 'MANAGED 2'), handle = await fs.open(file, 'r+'), link = fs.link;
  let injected = false, result;
  fs.link = async (from, to) => {
    if (to === file && !injected) { injected = true; await handle.write('USER VIA OPEN HANDLE', 0); await handle.truncate(20); }
    return link(from, to);
  };
  try { result = await applyPlan(b.store, planned); } finally { fs.link = link; await handle.close(); }
  assert.equal(injected, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 2');
  assert.equal(await fs.readFile(result.replacedVersions[0].saved, 'utf8'), 'USER VIA OPEN HANDLE');
  const op = (await b.store.target(planned.key)).stack.at(-1);
  assert.deepEqual(op.replacedVersions, result.replacedVersions);
  assert.ok(result.replacedVersions[0].saved.startsWith(result.backup));
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['main']);
});

for (const code of ['ENOTSUP', 'EPERM', 'EXDEV', 'EINVAL']) test(`R20: ${code} hardlinks fall back for install, switch, compensation and uninstall`, async t => {
  const b = await box(t), file = targetFile(b), link = fs.link;
  let failed = 0;
  fs.link = async () => { failed++; throw Object.assign(new Error('unsupported link'), {code}); };
  try {
    await install(b, 'MANAGED 1'); assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 1');
    await install(b, 'MANAGED 2'); assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 2');
    const planned = await preview(b, 'MANAGED 3'), save = b.store.save;
    b.store.save = async () => { throw new Error('R20 state failure'); };
    await assert.rejects(applyPlan(b.store, planned), /R20 state failure/); b.store.save = save;
    assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 2');
    await applyUndo(b.store, await planUndo(b.store, 'fixture', b.home, {all: true}));
    assert.equal(await exists(b.home), false); assert.equal(await exists(b.store.pending), false);
  } finally { fs.link = link; }
  assert.ok(failed >= 4);
});

const engine = new URL('../src/engine.mjs', import.meta.url).href;
const common = new URL('../src/drivers/common.mjs', import.meta.url).href;
function child(b, body, fallback = false) {
  const script = `import fs from 'node:fs/promises';import {Store,plan,applyPlan} from ${JSON.stringify(engine)};import {fileUnit} from ${JSON.stringify(common)};const s=new Store(process.argv[1]),home=process.argv[2],file=process.argv[3],recipe=${JSON.stringify(recipe)};${fallback ? "fs.link=async()=>{throw Object.assign(Error('unsupported'),{code:'ENOTSUP'})};" : ''}${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, b.store.home, b.home, targetFile(b)], {encoding: 'utf8', env: b.env});
  assert.equal(result.status, 0, result.stderr);
}

for (const fallback of [false, true]) test(`R21/R20: compensation survives a second crash (${fallback ? 'copy fallback' : 'hardlink'})`, async t => {
  const b = await box(t), file = targetFile(b);
  await install(b, 'MANAGED 1');
  child(b, `const p=await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED 2')]});s.save=async()=>process.exit(0);await applyPlan(s,p);`, fallback);
  assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 2');
  child(b, `const rename=fs.rename;fs.rename=async(f,to)=>{const x=await rename(f,to);if(f===file)process.exit(0);return x};await s.load();`, fallback);
  assert.equal(await exists(file), false);
  const link = fs.link;
  if (fallback) fs.link = async () => { throw Object.assign(Error('unsupported'), {code: 'ENOTSUP'}); };
  try { await b.store.load(); } finally { fs.link = link; }
  assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 1');
  assert.equal(await exists(b.store.pending), false);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['main']);
});

for (const stage of ['after-rename-away', 'before-link', 'after-link', 'after-state-save']) test(`R22: journal cleans registered artifacts after ${stage} crash, then uninstall removes created directories`, async t => {
  const b = await box(t), file = targetFile(b);
  await install(b, 'MANAGED 1');
  child(b, `const p=await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED 2')]});const rename=fs.rename,link=fs.link;fs.rename=async(f,to)=>{const x=await rename(f,to);if(${JSON.stringify(stage)}==='after-rename-away'&&f===file)process.exit(0);return x};fs.link=async(f,to)=>{if(${JSON.stringify(stage)}==='before-link'&&to===file)process.exit(0);const x=await link(f,to);if(${JSON.stringify(stage)}==='after-link'&&to===file)process.exit(0);return x};if(${JSON.stringify(stage)}==='after-state-save'){const save=s.save.bind(s);s.save=async state=>{await save(state);process.exit(0)}}await applyPlan(s,p);`);
  await b.store.load();
  assert.equal(await fs.readFile(file, 'utf8'), stage === 'after-state-save' ? 'MANAGED 2' : 'MANAGED 1');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['main']);
  await applyUndo(b.store, await planUndo(b.store, 'fixture', b.home, {all: true}));
  assert.equal(await exists(b.home), false);
  assert.equal(await exists(b.store.pending), false);
});


test('R01: cross-volume displaced inode is registered beside target and survives later uninstall', async t => {
  const b = await box(t), file = targetFile(b); await install(b, 'MANAGED 1');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (String(from).endsWith('.displaced') && String(to).includes('backups')) throw Object.assign(Error('cross-volume archive'), {code: 'EXDEV'});
    return rename(from, to);
  };
  let result;
  try {
    result = await install(b, 'MANAGED 2');
    const actual = result.replacedVersions[0].saved;
    assert.equal(path.resolve(path.dirname(actual)), path.resolve(path.dirname(file)));
    assert.equal(await fs.readFile(actual, 'utf8'), 'MANAGED 1');
    assert.ok((await b.store.load()).replacedVersions.some(op => op.files.some(row => row.saved === actual)));
    const index = JSON.parse(await fs.readFile(path.join(result.backup, 'index.json'), 'utf8'));
    assert.ok(index[0].replacedVersions.includes(actual));
    await applyUndo(b.store, await planUndo(b.store, 'fixture', b.home, {all: true}));
    assert.equal(await exists(file), false);
    assert.equal(await fs.readFile(actual, 'utf8'), 'MANAGED 1');
    assert.equal(await exists(b.store.pending), false);
  } finally { fs.rename = rename; }
});

const {hermesCapabilities, hermes} = await import('../src/drivers/plugins.mjs');
const put = async (file, text) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };
const contextSource = 'raise RuntimeError("MUST NOT EXECUTE HOST")\nclass PluginContext:\n    def register_middleware(self, name, callback):\n        pass\n';
const dispatchSource = 'raise RuntimeError("MUST NOT EXECUTE REQUEST CODE")\ndef request(manager, payload):\n    return manager.run_middleware("llm_request", payload)\n';
for (const [name, source, request, supported] of [
  ['docstring fake method', 'class PluginContext:\n    """Documentation example:\n    def register_middleware(self, name, callback):\n        pass\n    """\n', dispatchSource, false],
  ['registration without dispatch', contextSource, 'def request(client, payload):\n    return client.create(payload)\n', false],
  ['inherited definition', 'class Base:\n    def register_middleware(self,name,callback):\n        pass\nclass PluginContext(Base):\n    pass\n', dispatchSource, true],
  ['real registration and agent dispatch', contextSource, dispatchSource, true],
  ['parse failure', 'class PluginContext(:\n', dispatchSource, false],
]) test(`R19: AST distinguishes ${name} and keeps overview/preview/manifest consistent`, async t => {
  const b = await box(t), home = b.file('hermes'), host = path.join(home, 'hermes-agent');
  await put(path.join(host, 'hermes_cli/plugins.py'), source);
  await put(path.join(host, name.includes('agent dispatch') ? 'agent/request.py' : 'run_agent.py'), request);
  const caps = await hermesCapabilities(home);
  if (caps.reason?.includes('Python unavailable')) { t.skip(caps.reason); return; }
  assert.equal(caps.llmRequest, supported);
  b.service.homes.hermes = home; b.service.recipe = async () => recipe;
  const p = await b.service.preview({harness: 'hermes', recipe: recipe.key});
  const row = (await b.service.overview()).targets.find(row => row.harness === 'hermes');
  assert.equal(row.capabilities.main, supported);
  assert.equal(p.units.find(unit => unit.path.endsWith('plugin.yaml')).afterBytes.includes(Buffer.from('provides_middleware')), supported);
  if (!supported) {
    assert.match(row.mechanism, /Main\/Sub unavailable/);
    assert.ok(p.notes.some(note => note.includes(caps.reason)));
    assert.ok(row.foreign.some(item => item.detail.includes(caps.reason)));
  }
});

test('R19: Python unavailable degrades to steering with a reason', async t => {
  const b = await box(t), home = b.file('hermes'), host = path.join(home, 'hermes-agent');
  await put(path.join(host, 'hermes_cli/plugins.py'), contextSource); await put(path.join(host, 'run_agent.py'), dispatchSource);
  const env = {...b.env, PATH: b.file('empty-path'), Path: b.file('empty-path')};
  const caps = await hermesCapabilities(home, {env});
  assert.equal(caps.llmRequest, false); assert.match(caps.reason, /Python unavailable/);
  const found = await hermes.detect(home, {env}), desired = await hermes.desired(recipe, home, {}, {env});
  assert.match(found.mechanism, /Main\/Sub unavailable/); assert.match(desired.notes.join('\n'), /Python unavailable/);
});

test('R01: CLI and both UI result languages show the retained version actual path', async t => {
  const b = await box(t), {main} = await import('../bin/recipe-switch.mjs'), vm = await import('node:vm');
  b.service.recipe = async () => recipe;
  const log = [], original = console.log;
  console.log = (...args) => log.push(args.join(' '));
  let result;
  try {
    await main(['install', 'grok', recipe.key, '--yes'], b.service);
    result = await main(['uninstall', 'grok', '--yes'], b.service);
  } finally { console.log = original; }
  assert.ok(log.some(line => line === `被替换的版本保存在 ${result.replacedVersions[0].saved}`));
  const app = await fs.readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  const functionText = app.slice(app.indexOf('function showResult('), app.indexOf('// ---------------------------------------------------------------- recipes screen'));
  for (const text of ['被替换的版本保存在', 'Replaced version saved at']) {
    let shown;
    const context = {el: (tag, attrs, ...children) => ({tag, ...attrs, children, addEventListener() {}}), t: key => key === 'replacedAt' ? text : key,
      svg: () => null, ICON: {}, sheetBody: (...xs) => xs, sheetFoot: x => x, note: () => null, shortPath: x => x,
      openSheet: options => { shown = options; return {close() {}}; }};
    vm.createContext(context); vm.runInContext(functionText + ';globalThis.show=showResult;', context);
    context.show('Done', result);
    assert.ok(JSON.stringify(shown).includes(`${text} ${result.replacedVersions[0].saved}`));
  }
});


test('R21/R22: compensation preparation can replay its already-created registered temp', async t => {
  const b = await box(t), file = targetFile(b); await install(b, 'MANAGED 1');
  child(b, `const p=await plan({store:s,harness:'fixture',home,recipe,desired:[fileUnit(file,'MANAGED 2')]});s.save=async()=>process.exit(0);await applyPlan(s,p);`);
  child(b, `const rename=fs.rename;fs.rename=async(f,to)=>{if(f===file)process.exit(0);return rename(f,to)};await s.load();`);
  await b.store.load();
  assert.equal(await fs.readFile(file, 'utf8'), 'MANAGED 1');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['main']);
  assert.equal(await exists(b.store.pending), false);
});
