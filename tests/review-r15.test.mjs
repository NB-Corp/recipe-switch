import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sandbox, joinText} from './helpers.mjs';
import {loadSource} from '../src/sources.mjs';
import {createServer} from '../src/server.mjs';

const fixture = String.raw`id="numeric-options"
[prompts]
system={text="MAIN"}
[prompts.main]
system={text="MAIN"}
steering={text="S"}
[options.20]
name="Twenty"
default=true
append.main.steering={text="T20"}
[options.a]
name="A"
default=true
append.main.steering={text="TA"}
[options.3]
name="Three"
default=true
append.main.steering={text="T3"}
`;

test('R15: numeric option ids evaluate and list in TOML declaration order; unknown selections warn and are ignored', async t => {
  const b = await sandbox(t, {sources: []}), pkg = b.file('numeric-options');
  await fs.mkdir(pkg); await fs.writeFile(path.join(pkg, 'recipe.toml'), fixture);
  const [recipe] = await loadSource(pkg);
  assert.deepEqual(recipe.options.map(option => option.id), ['20', 'a', '3']);
  assert.equal(recipe.texts.userSteer, 'S\n\nT20\n\nTA\n\nT3');
  const selected = await recipe.withOptions({unknown: true});
  assert.deepEqual(selected.unknownOptions, ['unknown']);
  assert.equal(selected.texts.userSteer, recipe.texts.userSteer);
  await b.service.saveConfig({sources: [pkg]});
  const planned = await b.service.preview({harness: 'hermes', recipe: recipe.id, recipeOptions: {unknown: true}});
  assert.match(joinText(planned.warnings), /Unknown recipe option unknown; ignored/);
  assert.equal(planned.blocked.length, 0);
  const {server, token} = createServer({service: b.service});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recipes`, {headers: {'x-recipe-switch-token': token}});
  assert.deepEqual((await response.json()).recipes[0].options.map(option => option.id), ['20', 'a', '3']);
});

test('R15: dotted option declarations and patch-array tables retain first source appearance', async t => {
  const b = await sandbox(t, {sources: []}), pkg = b.file('dotted-options');
  await fs.mkdir(pkg);
  await fs.writeFile(path.join(pkg, 'recipe.toml'), String.raw`id="dotted-options"
options.20.name="Twenty"
options.20.default=true
options.20.append.main.steering={text="T20"}
options.a.name="A"
options.a.default=true
options.a.append.main.steering={text="TA"}
[prompts]
system={text="MAIN"}
[prompts.main]
steering={text="S"}
[options.3]
name="Three"
default=true
[[options.3.patch]]
slot="main.steering"
action="append"
content={text="T3"}
`);
  const [recipe] = await loadSource(pkg);
  assert.deepEqual(recipe.options.map(option => option.id), ['20', 'a', '3']);
  assert.equal(recipe.texts.userSteer, 'S\n\nT20\n\nTA\n\nT3');
});


test('R15: inline option tables preserve numeric declaration order too', async t => {
  const b = await sandbox(t, {sources: []}), pkg = b.file('inline-options'); await fs.mkdir(pkg);
  await fs.writeFile(path.join(pkg, 'recipe.toml'), 'id="inline-options"\noptions={20={name="Twenty",default=true,append.main.steering={text="T20"}},a={name="A",default=true,append.main.steering={text="TA"}},3={name="Three",default=true,append.main.steering={text="T3"}}}\n[prompts]\nsystem={text="MAIN"}\n[prompts.main]\nsteering={text="S"}\n');
  const [recipe] = await loadSource(pkg);
  assert.deepEqual(recipe.options.map(option => option.id), ['20', 'a', '3']);
  assert.equal(recipe.texts.userSteer, 'S\n\nT20\n\nTA\n\nT3');
});
