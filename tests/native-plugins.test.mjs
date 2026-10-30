import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {sandbox, tree, install, undo, exists} from './helpers.mjs';
import {kimiCode, hermes, openclaw, openclawConfig} from '../src/drivers/plugins.mjs';
import {Store, plan, applyPlan, planUndo, applyUndo} from '../src/engine.mjs';

const recipes = Object.fromEntries(['a', 'b'].map(id => [id, {key: id, id, name: `Recipe ${id}`, version: '1.0.0', revision: id,
  texts: {main: `MAIN ${id}`, sub: `SUB ${id}`, independent: `INDEPENDENT ${id}`, userSteer: `USER ${id}`, subSteer: `SUB STEER ${id}`, agentSteer: null}}]));
async function fixture(t) {
  const box = await sandbox(t);
  box.service.recipe = async key => recipes[key];
  for (const id of ['kimi-code', 'hermes', 'openclaw']) box.service.homes[id] = box.file(id);
  return box;
}
const put = async (file, text) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };

for (const id of ['kimi-code', 'hermes', 'openclaw']) test(`${id}: install → switch → drift blocks → exact uninstall, preserving user identity/config`, async t => {
  const {service, dir, file, read} = await fixture(t);
  if (id === 'kimi-code') await put(file(`${id}/plugins/installed.json`), '\uFEFF{\r\n "version" : 1,\r\n "plugins" : [ { "id" : "neighbour", "enabled" : true, "root": "example" } ]\r\n}\r\n');
  if (id === 'hermes') await put(file(`${id}/config.yaml`), '\uFEFF# personal config\r\nmodel: example\r\nplugins:\r\n  other: yes # keep\r\n  enabled: # comment\r\n    - neighbour # keep\r\nterminal:\r\n  cwd: /example\r\n');
  if (id === 'openclaw') await put(file(`${id}/openclaw.json`), '\uFEFF{\r\n "model": "example", "plugins": { "allow": ["neighbour"], "entries": { "neighbour": {"enabled":true}, "recipe-switch": {"enabled":false, "hooks": { "allowConversationAccess":true, "other":true }} }}\r\n}\r\n');
  await put(file(`${id}/SOUL.md`), '# User identity\n');
  await put(file(`${id}/AGENTS.md`), '# User instructions\n');
  const before = await tree(dir);
  await install(service, id, 'a');
  const view = (await service.overview()).targets.find(row => row.harness === id);
  assert.equal(view.live[0].managed, true);
  assert.equal(view.managed.drift.length, 0);
  const {planned} = await install(service, id, 'b');
  assert.deepEqual(planned.files.map(file => path.basename(file.path)).sort(), id === 'kimi-code' ? ['SYSTEM.md', 'recipe.json'] : ['recipe.json']);
  const snapshot = file(id === 'kimi-code' ? `${id}/plugins/managed/recipe-switch/recipe.json` : `${id}/${id === 'hermes' ? 'plugins' : 'extensions'}/recipe-switch/recipe.json`);
  const managed = await fs.readFile(snapshot);
  await fs.appendFile(snapshot, '\nhand edit');
  const blocked = await service.preview({harness: id, recipe: 'a'});
  assert.match(blocked.blocked.join('\n'), /hand edit detected/);
  await assert.rejects(service.apply(blocked.id), /blocked/);
  const removal = await service.previewUndo({harness: id, all: true});
  assert.match(removal.blocked.join('\n'), /hand edit detected/);
  await fs.writeFile(snapshot, managed);
  await undo(service, id, {all: true});
  assert.deepEqual(await tree(dir), before);
  assert.equal(await read(`${id}/SOUL.md`), '# User identity\n');
});

for (const id of ['kimi-code', 'hermes', 'openclaw']) test(`${id}: absent home and config are completely removed on uninstall`, async t => {
  const {service, dir} = await fixture(t);
  const before = await tree(dir);
  await install(service, id, 'a');
  await install(service, id, 'b');
  await undo(service, id, {all: true});
  assert.deepEqual(await tree(dir), before);
});

test('Kimi: SYSTEM wrapper preserves base prompt; plugin record and hook print user steering from the installed snapshot', async t => {
  const {service, file, read} = await fixture(t);
  await install(service, 'kimi-code', 'a');
  assert.equal(await read('kimi-code/SYSTEM.md'), '${base_prompt}\n\n<!-- managed by recipe-switch -->\nMAIN a\n');
  const registry = JSON.parse(await read('kimi-code/plugins/installed.json'));
  assert.equal(registry.version, 1);
  assert.equal(registry.plugins[0].id, 'recipe-switch');
  assert.equal(registry.plugins[0].enabled, true);
  assert.equal(registry.plugins[0].root, file('kimi-code/plugins/managed/recipe-switch').replaceAll('\\', '/'));
  const manifest = JSON.parse(await read('kimi-code/plugins/managed/recipe-switch/kimi.plugin.json'));
  assert.equal(manifest.hooks[0].event, 'UserPromptSubmit');
  const run = event => spawnSync(process.execPath, [file('kimi-code/plugins/managed/recipe-switch/steer.mjs')], {
    cwd: file('kimi-code'), input: JSON.stringify(event), encoding: 'utf8', env: service.env,
  });
  let result = run({hook_event_name: 'UserPromptSubmit', prompt: 'sample', session_id: 'fixture'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'USER a\n');
  await install(service, 'kimi-code', 'b');
  assert.equal(JSON.parse(await read('kimi-code/plugins/installed.json')).version, 1, 'switch keeps the registry schema key');
  result = run({hook_event_name: 'UserPromptSubmit', prompt: 'sample', session_id: 'fixture'});
  assert.equal(result.stdout, 'USER b\n');
  assert.equal(run({hook_event_name: 'SubagentStart', agent_name: 'worker'}).stdout, '');
});

test('Kimi: foreign SYSTEM and existing plugin id block without changing bytes', async t => {
  const {service, file, dir} = await fixture(t);
  await put(file('kimi-code/SYSTEM.md'), '# My system prompt\n');
  const before = await tree(dir);
  const planned = await service.preview({harness: 'kimi-code', recipe: 'a'});
  assert.match(planned.blocked.join('\n'), /Non-managed SYSTEM.md/);
  assert.deepEqual(await tree(dir), before);
  await fs.rm(file('kimi-code/SYSTEM.md'));
  await put(file('kimi-code/plugins/installed.json'), JSON.stringify({version: 1, plugins: [{id: 'recipe-switch', enabled: true, root: 'example'}]}));
  const foreign = await service.preview({harness: 'kimi-code', recipe: 'a'});
  assert.match(foreign.blocked.join('\n'), /Existing recipe-switch Kimi plugin/);
});

test('Hermes: full Main/Sub middleware covers provider shapes, freezes sessions and keeps fresh per-turn steer', async t => {
  const {service, file, read} = await sandbox(t);
  service.homes.hermes = file('hermes');
  const {planned} = await install(service, 'hermes', 'gpt-with-taste@0.1.0');
  const python = spawnSync('python', ['--version'], {encoding: 'utf8', env: service.env});
  if (python.error?.code === 'ENOENT' || python.status !== 0) return t.skip('python is not available');
  const result = spawnSync('python', ['-B', fileURLToPath(new URL('./fixtures/hermes-middleware.py', import.meta.url)), file('hermes/plugins/recipe-switch/__init__.py')], {encoding: 'utf8', env: service.env});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hermes full middleware OK/);
  t.diagnostic(result.stdout.trim());
  assert.match(await read('hermes/config.yaml'), /- recipe-switch # managed by recipe-switch/);
  assert.match(await read('hermes/plugins/recipe-switch/plugin.yaml'), /provides_middleware:\n  - llm_request/);
  assert.match(planned.notes.join('\n'), /appended in full/);
  assert.doesNotMatch(planned.notes.join('\n'), /7,600|omitted|4,000/);
});

test('OpenClaw: dependency-free installed entry injects role-correct hook results and sees switches without reload', async t => {
  const {service, file} = await fixture(t);
  await install(service, 'openclaw', 'a');
  const plugin = (await import(pathToFileURL(file('openclaw/extensions/recipe-switch/index.mjs')).href)).default;
  const hooks = new Map();
  plugin.register({on: (name, fn) => hooks.set(name, fn)});
  const run = ctx => hooks.get('before_prompt_build')({prompt: 'sample', messages: []}, ctx);
  assert.deepEqual(await run({sessionKey: 'agent:main:main'}), {appendSystemContext: 'MAIN a', prependContext: 'USER a'});
  for (const sessionKey of ['subagent:worker', 'agent:main:subagent:worker'])
    assert.deepEqual(await run({sessionKey}), {appendSystemContext: 'SUB a', prependContext: 'SUB STEER a'});
  assert.deepEqual(await run({}), {appendSystemContext: 'MAIN a', prependContext: 'USER a'});
  await install(service, 'openclaw', 'b');
  assert.deepEqual(await run({}), {appendSystemContext: 'MAIN b', prependContext: 'USER b'});
  const config = JSON.parse(await fs.readFile(file('openclaw/openclaw.json'), 'utf8'));
  assert.equal(config.plugins.entries['recipe-switch'].enabled, true);
  assert.equal(config.plugins.entries['recipe-switch'].hooks.allowConversationAccess, true);
});

test('OpenClaw: config override uses Service env; JSON5 and explicit policy blocks stay untouched', async t => {
  const {service, file, dir} = await fixture(t);
  service.env.OPENCLAW_CONFIG_PATH = file('custom/openclaw.json');
  await put(service.env.OPENCLAW_CONFIG_PATH, '{"model":"example"}\n');
  const before = await tree(dir);
  const defaultConfig = await fs.readFile(file('openclaw/openclaw.json'), 'utf8').catch(() => null);
  await install(service, 'openclaw', 'a');
  assert.equal(await fs.readFile(file('openclaw/openclaw.json'), 'utf8').catch(() => null), defaultConfig, 'default config untouched when OPENCLAW_CONFIG_PATH is set');
  assert.equal(JSON.parse(await fs.readFile(service.env.OPENCLAW_CONFIG_PATH, 'utf8')).plugins.entries['recipe-switch'].enabled, true);
  await undo(service, 'openclaw', {all: true});
  assert.deepEqual(await tree(dir), before);
  for (const text of ['{ plugins: {} } // JSON5\n', '{"plugins":{"enabled":false}}', '{"plugins":{"deny":["recipe-switch"]}}', '{"plugins":{"entries":{"recipe-switch":{"hooks":{"allowPromptInjection":false}}}}}']) {
    await put(service.env.OPENCLAW_CONFIG_PATH, text);
    await assert.rejects(service.preview({harness: 'openclaw', recipe: 'a'}), /JSON5|enable plugins|deny|allowPromptInjection/);
    assert.equal(await fs.readFile(service.env.OPENCLAW_CONFIG_PATH, 'utf8'), text);
  }
});

test('home resolution follows each source without reading the resolved homes', () => {
  const env = {HOME: path.resolve('fixture/user'), USERPROFILE: path.resolve('fixture/user'), LOCALAPPDATA: path.resolve('fixture/local')};
  assert.equal(kimiCode.resolveHome(env), path.join(env.HOME, '.kimi-code'));
  assert.equal(hermes.resolveHome(env), process.platform === 'win32' ? path.join(env.LOCALAPPDATA, 'hermes') : path.join(env.HOME, '.hermes'));
  assert.equal(openclaw.resolveHome({...env, OPENCLAW_HOME: path.resolve('fixture/alt')}), path.resolve('fixture/alt/.openclaw'));
  assert.equal(openclaw.resolveHome({...env, OPENCLAW_STATE_DIR: path.resolve('fixture/state')}), path.resolve('fixture/state'));
  assert.equal(openclawConfig(path.resolve('fixture/state'), {...env, OPENCLAW_CONFIG_PATH: '~/custom.json'}), path.join(env.HOME, 'custom.json'));
});

async function unitFixture(t, relative, text, desired) {
  const box = await fixture(t), file = box.file(`target/${relative}`);
  if (text !== null) await put(file, text);
  const store = new Store(box.file('unit-state'));
  const planned = await plan({store, harness: 'fixture', home: box.file('target'), recipe: recipes.a, desired: desired(file)});
  await applyPlan(store, planned);
  return {...box, file, store, async remove() { await applyUndo(store, await planUndo(store, 'fixture', box.file('target'), {all: true})); }};
}

test('jsonArrayRecord: neighbours retain exact bytes, hand-edited owned record blocks, unrelated edit survives removal', async t => {
  const original = '{ "version":1, "plugins": [\n  { "id" : "one", "nested" : { "keep":  1 } },\n\t{"id":"two","enabled":false}\n ] }\n';
  const neighbour = '{ "id" : "one", "nested" : { "keep":  1 } }';
  const box = await unitFixture(t, 'registry/installed.json', original, file => [{type: 'jsonArrayRecord', path: file, pointer: ['plugins'], value: 'recipe-switch', afterValue: {id: 'recipe-switch', enabled: true}}]);
  let current = await fs.readFile(box.file, 'utf8');
  assert.ok(current.includes(neighbour));
  await fs.writeFile(box.file, current.replace('"enabled":true', '"enabled":false'));
  assert.match((await planUndo(box.store, 'fixture', box.service.homes['kimi-code'].replace(/kimi-code$/, 'target'), {all: true})).blocked.join('\n'), /hand edit/);
  await fs.writeFile(box.file, current.replace('"version":1', '"version":2'));
  await box.remove();
  assert.equal(await fs.readFile(box.file, 'utf8'), original.replace('"version":1', '"version":2'));
});

for (const original of [null, '', '# no final newline', '\uFEFF# BOM\r\nmodel: example\r\n', 'plugins:\n  other: true\n', 'plugins:\n  enabled:\n    - neighbour\n']) test(`YAML list: exact restoration for ${JSON.stringify(original)}`, async t => {
  const box = await unitFixture(t, 'yaml/config.yaml', original, file => [{type: 'yamlArrayItem', path: file, pointer: ['plugins', 'enabled'], value: 'recipe-switch'}]);
  const text = await fs.readFile(box.file, 'utf8');
  assert.match(text, /- recipe-switch # managed by recipe-switch/);
  await box.remove();
  if (original === null) assert.equal(await exists(box.file), false);
  else assert.equal(await fs.readFile(box.file, 'utf8'), original);
});

test('YAML list: refuse complex target shapes without changing config', async t => {
  const {service, file} = await fixture(t);
  for (const text of ['plugins: {enabled: []}\n', 'plugins:\n  enabled: []\n', 'plugins: &anchor\n  enabled:\n    - other\n', 'plugins:\n  enabled: *alias\n', 'plugins:\n  <<: *defaults\n', 'plugins:\n  enabled:\n    - {name: other}\n', 'plugins:\n  enabled:\n    - other\n  enabled:\n    - duplicate\n']) {
    await put(file('hermes/config.yaml'), text);
    await assert.rejects(service.preview({harness: 'hermes', recipe: 'a'}), /Cannot safely edit plugins.enabled/);
    assert.equal(await fs.readFile(file('hermes/config.yaml'), 'utf8'), text);
  }
});

test('jsonKey: missing file/deep ancestors undo exactly; unrelated values survive created-parent cleanup', async t => {
  for (const original of [null, '{ "model": "example" }\r\n']) {
    const box = await unitFixture(t, `json-${original === null ? 'missing' : 'existing'}/config.json`, original,
      file => [{type: 'jsonKey', path: file, pointer: ['plugins', 'entries', 'recipe-switch', 'enabled'], afterValue: true}]);
    await box.remove();
    if (original === null) assert.equal(await exists(box.file), false);
    else assert.equal(await fs.readFile(box.file, 'utf8'), original);
  }
  const box = await unitFixture(t, 'json-keep/config.json', null,
    file => [{type: 'jsonKey', path: file, pointer: ['plugins', 'entries', 'recipe-switch', 'enabled'], afterValue: true}]);
  const {setKey} = await import('../src/json-edit.mjs');
  // Edit only the neighbour; reserializing the entire document also edits the
  // managed member's source span and correctly counts as drift.
  await fs.writeFile(box.file, setKey(await fs.readFile(box.file, 'utf8'), ['plugins', 'entries', 'neighbour'], {enabled: true}));
  await box.remove();
  assert.deepEqual(JSON.parse(await fs.readFile(box.file, 'utf8')), {plugins: {entries: {neighbour: {enabled: true}}}});
});

test('Hermes: explicit disabled entry wins; safe empty disable list is left byte-identical', async t => {
  const {service, file} = await fixture(t);
  for (const disabled of ['  disabled:\n    - recipe-switch # disabled by user\n', '  disabled: ["other", recipe-switch]\n']) {
    const text = 'plugins:\n' + disabled;
    await put(file('hermes/config.yaml'), text);
    await assert.rejects(service.preview({harness: 'hermes', recipe: 'a'}), /plugins.disabled/);
    assert.equal(await fs.readFile(file('hermes/config.yaml'), 'utf8'), text);
  }
  const text = 'plugins:\n  disabled: [] # keep this line\n';
  await put(file('hermes/config.yaml'), text);
  await install(service, 'hermes', 'a');
  assert.match(await fs.readFile(file('hermes/config.yaml'), 'utf8'), /  disabled: \[\] # keep this line\n/);
  await undo(service, 'hermes', {all: true});
  assert.equal(await fs.readFile(file('hermes/config.yaml'), 'utf8'), text);
});

test('OpenClaw: existing empty-object layout and whitespace restore exactly after adding new keys', async t => {
  const {service, file} = await fixture(t);
  for (const text of ['{  }\r\n', '{"plugins":{"entries":{"recipe-switch":{"hooks":{ \n    }}}}}\n', '{"plugins":{"allow":[  \n ], "entries":{"recipe-switch":{"enabled":false,"hooks":{"allowConversationAccess":true}}}}}\n']) {
    await put(file('openclaw/openclaw.json'), text);
    await install(service, 'openclaw', 'a');
    await install(service, 'openclaw', 'b');
    await undo(service, 'openclaw', {all: true});
    assert.equal(await fs.readFile(file('openclaw/openclaw.json'), 'utf8'), text);
  }
});
