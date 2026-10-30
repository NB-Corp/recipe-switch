// Built-in plugins, exercised from the files the loader actually installed
// into a fake home. DSH uses the real installed Cordis Loader when available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {sandbox, install, undo, KIKI_RECIPES, exists} from './helpers.mjs';

const GWT_KEY = 'gpt-with-taste@0.1.0';
const ALT = await exists(KIKI_RECIPES) ? 'deepseek-v4-intent-and-depth@1.0.0' : null;

function piApi() {
  const handlers = new Map(), commands = new Map(), entries = [];
  return {handlers, commands, entries, on: (name, fn) => handlers.set(name, fn), registerCommand: (name, spec) => commands.set(name, spec),
    appendEntry: (type, data) => entries.push({type: 'custom', customType: type, data})};
}
const piCtx = (api, model = {provider: 'openai', id: 'gpt-5.5'}) => ({model, hasUI: false, sessionManager: {getBranch: () => api.entries}});

test('pi: installed extension injects the active recipe, follows a switch without reload, honors scope', async t => {
  const {service, file} = await sandbox(t);
  await install(service, 'pi', GWT_KEY, {options: {providers: 'openai'}});
  const entry = file('pi/agent/extensions/recipe-switch/index.js');
  const module = await import(pathToFileURL(entry).href + `?t=${Date.now()}`);
  const api = piApi();
  module.default(api);
  assert.deepEqual([...api.handlers.keys()], ['context_with_system', 'before_provider_request']);
  assert.ok(api.commands.has('recipe'));
  const snapshot = JSON.parse(await fs.readFile(file('pi/agent/extensions/recipe-switch/recipe.json'), 'utf8'));
  const system = {role: 'system', content: '', sections: {host: 'HOST TOOLS'}, timestamp: 0};
  const user = {role: 'user', content: 'hello', timestamp: 1};
  const run = async (ctx = piCtx(api)) => (await api.handlers.get('context_with_system')({messages: [system, user]}, ctx)).messages;

  let out = await run();
  assert.equal(out[0].sections.host, 'HOST TOOLS');
  assert.ok(out[0].sections.gpt_with_taste.includes(snapshot.texts.main.trim()));
  assert.ok(out[2].content.includes(snapshot.texts.userSteer.trim()));
  const payload = api.handlers.get('before_provider_request')({payload: {model: 'gpt-5.5', input: [], instructions: 'HOST'}}, piCtx(api));
  assert.match(payload.instructions, /^HOST\n\n<gpt-with-taste>/);

  const other = await run(piCtx(api, {provider: 'anthropic', id: 'claude'}));
  assert.equal(other[0].sections.gpt_with_taste, undefined, 'out-of-scope provider untouched');

  if (ALT) {
    await install(service, 'pi', ALT);
    const next = JSON.parse(await fs.readFile(file('pi/agent/extensions/recipe-switch/recipe.json'), 'utf8'));
    out = await run();
    assert.ok(out[0].sections.gpt_with_taste.includes(next.texts.main.trim()), 'switch is picked up by the running extension');
    assert.ok(!out[0].sections.gpt_with_taste.includes(snapshot.texts.main.trim().slice(0, 200)));
  }
  await undo(service, 'pi', {all: true});
  assert.equal(await exists(file('pi/agent/extensions')), false);
});

const DSH_ROOT = process.env.DSH_PACKAGE_ROOT || path.join(process.env.APPDATA ? path.dirname(process.env.APPDATA) : '', 'Local/nvm/v24.12.0/node_modules/@deepseek-ai/dsh');
const hasDsh = await exists(path.join(DSH_ROOT, 'package.json'));

test('dsh: real DSH profile discovery + Cordis Loader activate the installed bundle; switch and rootRole apply', {skip: !hasDsh && 'set DSH_PACKAGE_ROOT to an installed @deepseek-ai/dsh'}, async t => {
  const {service, file, dir} = await sandbox(t);
  const requireDsh = createRequire(path.join(DSH_ROOT, 'package.json'));
  const sdk = name => import(pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href);
  const {Context} = await sdk('cordis');
  const {default: Loader} = await sdk('cordis-plugin-loader');
  const {loadProfile, composeEntries, healProfilesModuleFallback} = await sdk('dsh-app-boot');
  const {createUserMessage} = await sdk('dsh-llm');
  const {SessionId} = await sdk('dsh-session');
  const {agentEvents, assembleContextFor} = await sdk('dsh-agent');

  const home = file('dsh'), profile = path.join(home, 'profiles', 'web');
  await install(service, 'dsh', GWT_KEY, {home: profile});
  healProfilesModuleFallback(path.join(DSH_ROOT, 'package.json'), home);
  const native = loadProfile('dsh', 'web', path.join(DSH_ROOT, 'package.json'), home);
  const layer = native.layers.find(item => item.packageDir?.endsWith(path.join('node_modules', 'dsh-recipe-switch')));
  assert.ok(layer, 'DSH resolves dsh-recipe-switch from the profile bundles list');
  const rows = composeEntries([native.layers.filter(item => item === layer).map(item => item.patches)[0], native.patches]);

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader, {baseUrl: pathToFileURL(profile + path.sep).href});
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop'])
    await ctx.loader.create({name: pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href,
      config: name === 'dsh-agent-loop' ? {agents: []} : name === 'dsh-system-prompt' ? {persona: 'HOST PERSONA'} : {}});
  await ctx.loader.root.update([...ctx.loader.root.data, ...rows]);
  await ctx.loader.await();
  assert.equal(ctx.loader.resolve('recipe-switch').fiber.state, 2, 'plugin is ACTIVE');

  const makeAgent = async (id, origin) => (await ctx.agents.create({sessionId: SessionId(id), meta: origin ? {origin} : {},
    agentOptions: {provider: 'p', model: 'm', maxTokens: 1}})).agent;
  const main = await makeAgent('main'), sub = await makeAgent('sub', 'subagent');
  const section = async agent => (await ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.find(s => s.name === 'recipe-switch:behavior')?.text;
  const snap = async () => JSON.parse(await fs.readFile(path.join(profile, 'node_modules/dsh-recipe-switch/recipe.json'), 'utf8'));
  let texts = (await snap()).texts;
  assert.equal(await section(main), texts.main);
  assert.equal(await section(sub), texts.sub);

  const message = kind => createUserMessage({source: {kind}, content: [{type: 'text', text: 'hi'}]});
  const step = (agent, messages) => agentEvents(ctx, agent).waterfall('agent/pre-step', {messages, turn: 1, step: 1, signal: new AbortController().signal},
    async () => ({kind: 'enter', messages}));
  const stepped = await step(main, [message('user')]);
  assert.equal(stepped.messages.length, 2);
  assert.equal(stepped.messages[0].content[0].text, texts.userSteer.trim());
  assert.deepEqual(stepped.messages[0].source, {kind: 'plugin', plugin: 'recipe-switch', form: 'instructions'});
  const tool = message('tool');
  assert.deepEqual((await step(main, [tool])).messages, [tool]);

  if (ALT) {
    await install(service, 'dsh', ALT, {home: profile});
    texts = (await snap()).texts;
    await step(main, []); // pre-step refreshes the snapshot
    assert.equal(await section(main), texts.main, 'switched recipe reaches the live plugin without a restart');
  }
  await undo(service, 'dsh', {home: profile, all: true});
  assert.equal(await exists(path.join(profile, 'node_modules')), false);
  assert.ok(dir);
});
