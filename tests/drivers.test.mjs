import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sandbox, tree, install, undo, GWT, KIKI_RECIPES, exists} from './helpers.mjs';

const GWT_KEY = 'gpt-with-taste@0.1.0';
const hasKiki = await exists(KIKI_RECIPES);
const ALT = hasKiki ? 'deepseek-v4-intent-and-depth@1.0.0' : null;
const dist = rel => fs.readFile(path.join(GWT, 'dist', rel), 'utf8');

test('catalog: gpt-with-taste dist plus Kiki Recipe packages from another system', async t => {
  const {service} = await sandbox(t);
  const {recipes, errors} = await service.catalog();
  assert.deepEqual(errors, []);
  const gwt = recipes.find(r => r.key === GWT_KEY);
  assert.equal(gwt.kind, 'author-repo');
  assert.equal(gwt.texts.main, await dist('codex/main.md'));
  if (hasKiki) {
    const other = recipes.find(r => r.key === ALT);
    assert.equal(other.kind, 'kiki-recipe');
    for (const key of ['main', 'sub', 'independent', 'userSteer', 'subSteer', 'agentSteer']) assert.ok(other.texts[key]?.length > 20, key);
  }
});

test('codex: managed prompt + one config key; other config bytes and roles stay; uninstall is exact', async t => {
  const {service, dir, read} = await sandbox(t);
  const before = await tree(dir);
  const {planned} = await install(service, 'codex', GWT_KEY);
  assert.deepEqual(planned.files.map(f => f.action).sort(), ['create', 'create', 'create', 'modify']);
  assert.equal(await read('codex/prompts/recipe-loader/main.md'), await dist('codex/main.md'));
  const config = await read('codex/config.toml');
  assert.match(config, /^model_instructions_file = ".*\/codex\/prompts\/recipe-loader\/main\.md" # managed by recipe-loader\n# fake Codex home\nmodel = "gpt-5\.5"/);
  assert.match(config, /\[mcp_servers\.local\]\ncommand = "fixture"/);
  await undo(service, 'codex', {all: true});
  assert.deepEqual(await tree(dir), before);
});

test('codex: a gpt-with-taste installer-managed home is detected and not taken over', async t => {
  const {service, file} = await sandbox(t);
  await fs.mkdir(file('codex/prompts/gpt-with-taste'), {recursive: true});
  await fs.writeFile(file('codex/prompts/gpt-with-taste/main.md'), 'x');
  await fs.writeFile(file('codex/config.toml'), `model_instructions_file = "${file('codex/prompts/gpt-with-taste/main.md').replaceAll('\\', '/')}"\n`);
  const planned = await service.preview({harness: 'codex', recipe: GWT_KEY});
  assert.match(planned.blocked.join('\n'), /gpt-with-taste install\.mjs/);
  await assert.rejects(service.apply(planned.id), /blocked/);
});

test('kiki: package beside the home; only the chosen models get a recipe key; existing bindings return', async t => {
  const {service, dir, read} = await sandbox(t);
  const before = await tree(dir);
  await assert.rejects(service.preview({harness: 'kiki', recipe: GWT_KEY}), /choose at least one model/);
  await assert.rejects(service.preview({harness: 'kiki', recipe: GWT_KEY, options: {models: ['nope']}}), /not defined/);
  await install(service, 'kiki', GWT_KEY, {options: {models: ['axon/gpt-6.1-sol', 'deepseek-v4-flash']}});
  const config = await read('kiki/config.toml');
  assert.match(config, /\[models\."axon\/gpt-6\.1-sol"\]\nrecipe = ".*\/kiki\/recipe-loader\/packages\/gpt-with-taste\/recipe\.toml" # managed by recipe-loader\nprovider = "axon"/);
  assert.match(config, /\[models\."deepseek-v4-flash"\]\nrecipe = ".*recipe\.toml" # managed by recipe-loader\nprovider = "axon-chat"/);
  assert.equal(await read('kiki/recipe-loader/packages/gpt-with-taste/recipe.toml'), await dist('kiki/recipe.toml'));
  const view = await service.overview();
  assert.equal(view.targets.find(r => r.harness === 'kiki').live.filter(l => l.managed).length, 2);
  if (hasKiki) {
    const {planned} = await install(service, 'kiki', ALT);
    assert.equal(planned.kind, 'switch');
    assert.deepEqual(planned.options.models, ['axon/gpt-6.1-sol', 'deepseek-v4-flash'], 'switch reuses the selected models');
    assert.match(await read('kiki/config.toml'), /packages\/deepseek-v4-intent-and-depth\/deepseek\.toml/);
    assert.ok(await read('kiki/recipe-loader/packages/deepseek-v4-intent-and-depth/deepseek-main.md'));
    assert.equal(await exists(path.join(dir, 'kiki/recipe-loader/packages/gpt-with-taste')), false, 'previous package removed on switch');
  }
  await undo(service, 'kiki', {all: true});
  assert.deepEqual(await tree(dir), before);
  assert.match(await read('kiki/config.toml'), /recipe = "6bccd1ea-0000-0000-0000-000000000000"/);
});

test('pi: built-in extension; switching rewrites only recipe.json; foreign gpt-with-taste package blocks', async t => {
  const {service, dir, read, file} = await sandbox(t);
  const before = await tree(dir);
  await install(service, 'pi', GWT_KEY, {options: {providers: 'openai', modelIdPattern: '^gpt-'}});
  const snap = JSON.parse(await read('pi/agent/extensions/recipe-loader/recipe.json'));
  assert.deepEqual(snap.scope, {providers: ['openai'], modelIdPattern: '^gpt-'});
  assert.equal(snap.texts.main, await dist('codex/main.md'));
  assert.deepEqual(JSON.parse(await read('pi/agent/extensions/recipe-loader/package.json')).pi, {extensions: ['./index.js']});
  if (hasKiki) {
    const {planned} = await install(service, 'pi', ALT);
    assert.deepEqual(planned.files.map(f => path.basename(f.path)), ['recipe.json']);
    assert.match(planned.files[0].diff, /"name": "DeepSeek/);
    const rolled = await undo(service, 'pi');
    assert.equal(rolled.planned.restores.key, GWT_KEY);
  }
  await undo(service, 'pi', {all: true});
  assert.deepEqual(await tree(dir), before);
  await fs.writeFile(file('pi/agent/settings.json'), '{"packages": ["git:github.com/NB-Corp/gpt-with-taste"]}');
  const blocked = await service.preview({harness: 'pi', recipe: GWT_KEY});
  assert.match(blocked.blocked.join('\n'), /gpt-with-taste Pi package/);
});

test('dsh: one target per profile; bundle + dependency + mounted copy; uninstall is exact', async t => {
  const {service, dir, read} = await sandbox(t);
  const before = await tree(dir);
  await assert.rejects(service.preview({harness: 'dsh', recipe: GWT_KEY}), /has 2 targets; pass --home/);
  const web = path.join(dir, 'dsh/profiles/web');
  await install(service, 'dsh', GWT_KEY, {home: web, options: {rootRole: 'independent'}});
  const manifest = JSON.parse(await read('dsh/profiles/web/package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-recipe-loader']);
  assert.deepEqual(manifest.dependencies, {'dsh-recipe-loader': 'file:.recipe-loader/dsh-recipe-loader'});
  assert.match(await read('dsh/profiles/web/node_modules/dsh-recipe-loader/cordis.patch.yml'), /rootRole: independent/);
  assert.equal(await read('dsh/profiles/web/node_modules/dsh-recipe-loader/recipe.json'), await read('dsh/profiles/web/.recipe-loader/dsh-recipe-loader/recipe.json'));
  assert.equal(await read('dsh/profiles/web/cordis.patch.yml'), '[]\n', 'user patch layer untouched');
  const work = (await service.overview()).targets.find(r => r.label === 'profile work');
  assert.equal(work.managed.installed, false, 'other profile untouched');
  await undo(service, 'dsh', {home: web, all: true});
  assert.deepEqual(await tree(dir), before);
});

test('claude, omp, grok, opencode: managed files only, launch command for Claude, exact uninstall', async t => {
  const {service, dir, read} = await sandbox(t);
  const before = await tree(dir);
  const claude = await install(service, 'claude', GWT_KEY);
  assert.match(claude.result.launch, /--append-system-prompt-file ".*claude\/recipe-loader\/main\.md" --plugin-dir ".*claude\/recipe-loader\/plugin"/);
  assert.equal(await read('claude/settings.json'), '{\n  "model": "opus"\n}\n');
  assert.equal(await read('claude/recipe-loader/plugin/hooks/hooks.json'), await dist('claude/plugin/hooks/hooks.json'));
  await install(service, 'omp', GWT_KEY);
  assert.equal(await read('omp/agent/extensions/recipe-loader/index.js'), await dist('omp/index.js'));
  await install(service, 'grok', GWT_KEY);
  assert.match(await read('grok/rules/recipe-loader.md'), /^<!-- recipe-loader: GPT with Taste 0\.1\.0/);
  assert.equal(await read('grok/rules/engineering.md'), '# My engineering rules\n');
  await install(service, 'opencode', GWT_KEY);
  const oc = JSON.parse(await read('opencode/opencode.json'));
  assert.deepEqual(oc.instructions, [path.join(dir, 'opencode/recipe-loader/main.md').replaceAll('\\', '/')]);
  assert.equal(oc.model, 'axon/gpt-5.5');
  for (const harness of ['claude', 'omp', 'grok', 'opencode']) await undo(service, harness, {all: true});
  assert.deepEqual(await tree(dir), before);
});

test('overview lists every driver target and the uncovered harnesses with reasons', async t => {
  const {service} = await sandbox(t);
  const view = await service.overview();
  assert.deepEqual([...new Set(view.targets.map(r => r.harness))], ['codex', 'claude', 'kiki', 'pi', 'dsh', 'omp', 'grok', 'opencode']);
  assert.deepEqual(view.targets.filter(r => r.harness === 'dsh').map(r => r.label), ['profile web', 'profile work']);
  assert.ok(view.uncovered.every(item => item.reason.length > 30));
});
