import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store, plan, applyPlan, planUndo, applyUndo, status} from '../src/engine.mjs';
import {fileUnit, tomlKeyUnit, jsonItemUnit} from '../src/drivers/common.mjs';
import {writeKeyLine, readKeyLine} from '../src/vendor/toml-key.mjs';
import {setKey, setArrayItem} from '../src/json-edit.mjs';
import {ROOT, tree} from './helpers.mjs';

async function scratch(t) {
  await fs.mkdir(path.join(ROOT, '.tmp', 'test'), {recursive: true});
  const dir = await fs.mkdtemp(path.join(ROOT, '.tmp', 'test', 'engine-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const home = path.join(dir, 'home');
  await fs.mkdir(home);
  return {dir, home, store: new Store(path.join(dir, 'state'))};
}
const recipe = version => ({key: `r@${version}`, id: 'r', name: 'R', version, revision: `rev-${version}`});
const ORIGINAL_TOML = '\uFEFF# keep me\r\nmodel = "gpt"\r\nmodel_instructions_file = \'old/main.md\' # mine\r\n[models."a/b"]\r\nprovider = "p"\r\n[mcp_servers.x]\r\ncommand = "y"\r\n';
const ORIGINAL_JSON = '{\n    "a": 1,\n    "list": [ "x" ],\n  "odd":   true\n}';

function desired(home, version, {withJson = true} = {}) {
  return [
    fileUnit(path.join(home, 'rl', 'main.md'), `MAIN ${version}\n`),
    tomlKeyUnit(path.join(home, 'config.toml'), [], 'model_instructions_file', path.join(home, 'rl', 'main.md')),
    tomlKeyUnit(path.join(home, 'config.toml'), ['models', 'a/b'], 'recipe', `pkg-${version}`),
    ...(withJson ? [jsonItemUnit(path.join(home, 's.json'), ['list'], 'mine'),
      {type: 'jsonKey', path: path.join(home, 's.json'), pointer: ['deps', 'mine'], afterValue: `v${version}`}] : []),
  ];
}

test('install → switch → rollback → uninstall restores every original byte and removes created dirs', async t => {
  const {home, store} = await scratch(t);
  await fs.writeFile(path.join(home, 'config.toml'), ORIGINAL_TOML);
  await fs.writeFile(path.join(home, 's.json'), ORIGINAL_JSON);
  const before = await tree(home);

  const dry = await plan({store, harness: 't', home, recipe: recipe(1), desired: desired(home, 1)});
  assert.equal(dry.kind, 'install');
  assert.deepEqual(await tree(home), before, 'planning writes nothing');
  assert.match(dry.files.find(f => f.path.endsWith('config.toml')).diff, /\+model_instructions_file = ".*rl\/main\.md" # managed by recipe-switch/);
  await applyPlan(store, dry);

  const config = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  assert.ok(config.startsWith('\uFEFF# keep me\r\nmodel = "gpt"\r\n'), 'BOM, CRLF and unrelated keys preserved');
  assert.match(config, /\[models\."a\/b"\]\r\nrecipe = "pkg-1" # managed by recipe-switch\r\nprovider = "p"/);
  assert.match(await fs.readFile(path.join(home, 's.json'), 'utf8'), /"list": \[ "x", "mine" \],\n {2}"odd": {3}true,\n {2}"deps": \{\n/);

  const switched = await plan({store, harness: 't', home, recipe: recipe(2), desired: desired(home, 2, {withJson: false})});
  assert.equal(switched.kind, 'switch');
  await applyPlan(store, switched);
  assert.equal(await fs.readFile(path.join(home, 's.json'), 'utf8'), ORIGINAL_JSON, 'units no longer needed are restored on switch');
  assert.equal((await status(store, 't', home)).recipe.key, 'r@2');

  const back = await planUndo(store, 't', home);
  assert.equal(back.restores.key, 'r@1');
  await applyUndo(store, back);
  assert.equal(await fs.readFile(path.join(home, 'rl', 'main.md'), 'utf8'), 'MAIN 1\n');
  assert.match(await fs.readFile(path.join(home, 's.json'), 'utf8'), /"mine"/);

  await applyUndo(store, await planUndo(store, 't', home, {all: true}));
  assert.deepEqual(await tree(home), before, 'uninstall restores the exact original tree');
  assert.equal((await status(store, 't', home)).installed, false);
  const backups = await fs.readdir(path.join(store.home, 'backups'));
  assert.equal(backups.length, 4, 'each apply and undo keeps a backup');
});

test('hand edits block switch, rollback and uninstall unless forced; drift is reported', async t => {
  const {home, store} = await scratch(t);
  await fs.writeFile(path.join(home, 'config.toml'), 'model = "x"\n[models."a/b"]\nprovider = "p"\n');
  await applyPlan(store, await plan({store, harness: 't', home, recipe: recipe(1), desired: desired(home, 1, {withJson: false})}));
  await fs.appendFile(path.join(home, 'rl', 'main.md'), 'my own line\n');
  const text = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  await fs.writeFile(path.join(home, 'config.toml'), text.replace('recipe = "pkg-1"', 'recipe = "hand"'));

  const view = await status(store, 't', home);
  assert.deepEqual(view.drift.map(d => d.state).sort(), ['edited', 'edited']);
  const next = await plan({store, harness: 't', home, recipe: recipe(2), desired: desired(home, 2, {withJson: false})});
  assert.equal(next.blocked.length, 2);
  await assert.rejects(applyPlan(store, next), /blocked/);
  const undo = await planUndo(store, 't', home, {all: true});
  assert.equal(undo.blocked.length, 2);
  await assert.rejects(applyUndo(store, undo), /Blocked/);
  assert.match(await fs.readFile(path.join(home, 'rl', 'main.md'), 'utf8'), /my own line/, 'nothing overwritten');

  const forced = await planUndo(store, 't', home, {all: true, force: true});
  await applyUndo(store, forced);
  assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), 'model = "x"\n[models."a/b"]\nprovider = "p"\n');
});

test('an unmanaged file at a target path is a conflict; a file changed after preview aborts apply', async t => {
  const {home, store} = await scratch(t);
  await fs.mkdir(path.join(home, 'rl'));
  await fs.writeFile(path.join(home, 'rl', 'main.md'), 'someone else\n');
  const planned = await plan({store, harness: 't', home, recipe: recipe(1), desired: [fileUnit(path.join(home, 'rl', 'main.md'), 'MAIN\n')]});
  assert.match(planned.blocked[0], /unmanaged file already exists/);

  await fs.rm(path.join(home, 'rl'), {recursive: true});
  const fresh = await plan({store, harness: 't', home, recipe: recipe(1), desired: [fileUnit(path.join(home, 'a.md'), 'A'), fileUnit(path.join(home, 'b.md'), 'B')]});
  await fs.writeFile(path.join(home, 'b.md'), 'raced');
  await assert.rejects(applyPlan(store, fresh), /changed since the preview/);
  assert.equal(await fs.readFile(path.join(home, 'b.md'), 'utf8'), 'raced');
  assert.equal(await fs.access(path.join(home, 'a.md')).then(() => true, () => false), false);
});

test('a TOML file and JSON parent created only for managed keys are removed again', async t => {
  const {home, store} = await scratch(t);
  await fs.writeFile(path.join(home, 'p.json'), '{\n  "name": "x"\n}\n');
  const units = [tomlKeyUnit(path.join(home, 'new.toml'), [], 'k', 'v'),
    {type: 'jsonKey', path: path.join(home, 'p.json'), pointer: ['dependencies', 'pkg'], afterValue: 'file:x'}];
  await applyPlan(store, await plan({store, harness: 't', home, recipe: recipe(1), desired: units}));
  assert.match(await fs.readFile(path.join(home, 'new.toml'), 'utf8'), /^k = "v" # managed by recipe-switch\n$/);
  await applyUndo(store, await planUndo(store, 't', home, {all: true}));
  assert.deepEqual(await fs.readdir(home), ['p.json']);
  assert.equal(await fs.readFile(path.join(home, 'p.json'), 'utf8'), '{\n  "name": "x"\n}\n', 'dependency parent created by the loader is removed');
});

test('TOML and JSON editors leave unrelated bytes untouched and refuse unsafe edits', () => {
  assert.equal(writeKeyLine('a = 1\n[t]\nx = "1"\n', ['t'], 'x', 'x = "2"'), 'a = 1\n[t]\nx = "2"\n');
  assert.equal(writeKeyLine('a = 1\n[t]\n', ['t'], 'x', 'x = "2"'), 'a = 1\n[t]\nx = "2"\n');
  assert.equal(readKeyLine('[t.u]\nx = "no"\n[t]\nx = "yes" # c\n', ['t'], 'x'), 'x = "yes" # c');
  assert.throws(() => writeKeyLine('a = 1\n', ['missing'], 'x', 'x = "1"'), /not defined/);
  assert.throws(() => readKeyLine('x = """\nmulti\n"""\n', [], 'x'), /single-line/);
  assert.throws(() => readKeyLine('x = "a"\nx = "b"\n', [], 'x'), /duplicate/);
  assert.equal(setArrayItem('{"l":["a","c"],"k":2}', ['l'], 'b', true), '{"l":["a","c","b"],"k":2}');
  assert.equal(setArrayItem('{"l":["a","b"],"k":2}', ['l'], 'a', false), '{"l":["b"],"k":2}');
  assert.equal(setKey('{\n  "a": 1\n}', ['b'], 2), '{\n  "a": 1,\n  "b": 2\n}');
  assert.equal(setKey('{\n  "a": 1,\n  "b": 2\n}', ['b'], undefined), '{\n  "a": 1\n}');
});
