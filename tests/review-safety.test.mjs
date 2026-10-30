import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sandbox, ROOT, exists, joinText} from './helpers.mjs';
import {Store, plan, applyPlan, planUndo, applyUndo, status, redact} from '../src/engine.mjs';
import {writeFile} from '../src/fsx.mjs';
import {fileUnit, tomlKeyUnit, jsonItemUnit} from '../src/drivers/common.mjs';
import {loadSource} from '../src/sources.mjs';
import {openclaw, hermes} from '../src/drivers/plugins.mjs';
import {DRIVERS} from '../src/service.mjs';

const recipe = {id: 'r', key: 'r@1', name: 'Review', version: '1', revision: '1', texts: {
  main: 'MAIN', sub: 'SUB', independent: 'INDEPENDENT', userSteer: 'USER', subSteer: 'SUB STEER', agentSteer: 'AGENT'}};
const put = async (file, text) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };
async function box(t) {
  const b = await sandbox(t, {sources: []});
  return {...b, home: b.file('review-home'), store: new Store(b.file('review-state'))};
}
const preview = (b, desired, extra = {}) => plan({store: b.store, harness: 'fixture', home: b.home, recipe, desired, ...extra});
const install = async (b, desired, extra) => applyPlan(b.store, await preview(b, desired, extra));
const undoPlan = (b, options = {all: true}) => planUndo(b.store, 'fixture', b.home, options);
async function junction(t, target, link, type = 'junction') {
  try { await fs.symlink(target, link, type); return true; }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) { t.skip(`symlink unavailable: ${error.code}`); return false; } throw error; }
}
const run = (code, args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {cwd: ROOT, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
});

test('R01: a hand edit during the final conditional read survives without being overwritten', async t => {
  const b = await box(t), file = path.join(b.home, 'main');
  await install(b, [fileUnit(file, 'MANAGED 1')]);
  const planned = await preview(b, [fileUnit(file, 'MANAGED 2')]);
  const originalRead = fs.readFile, originalWrite = fs.writeFile; let backupDone = false, injected = false;
  fs.writeFile = async function (target, ...args) {
    const result = await originalWrite(target, ...args);
    if (path.basename(String(target)).startsWith('index.json.recipe-switch-')) backupDone = true;
    return result;
  };
  fs.readFile = async function (target, ...args) {
    const bytes = await originalRead(target, ...args);
    if (path.resolve(String(target)) === file && backupDone && !injected) {
      injected = true; await originalWrite(file, 'USER AFTER BACKUP');
    }
    return bytes;
  };
  try { await assert.rejects(applyPlan(b.store, planned), /Changed during operation/); }
  finally { fs.readFile = originalRead; fs.writeFile = originalWrite; }
  assert.equal(injected, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'USER AFTER BACKUP');
  assert.equal((await b.store.target(planned.key)).stack.length, 1);
  assert.equal(await exists(b.store.pending), false);
});

test('R02: atomic temporary names do not collide even when time is frozen', async t => {
  const b = await box(t), file = b.file('temp-write');
  const now = Date.now, rename = fs.rename, temps = []; Date.now = () => 7;
  // Give each rename a separate sink: this tests temp ownership, not unlocked
  // concurrent replacements of the same Windows destination (Store locks those).
  fs.rename = async (from, to) => { const index = temps.push(from); return rename(from, `${to}.${index}`); };
  try { await Promise.all(Array.from({length: 12}, (_, i) => writeFile(file, Buffer.from(String(i))))); }
  finally { Date.now = now; fs.rename = rename; }
  assert.equal(new Set(temps).size, 12);
  assert.equal((await fs.readdir(b.dir)).filter(name => name.includes('.recipe-switch-')).length, 0);
});

test('R02: concurrent applies retain both targets and cross-process Store updates serialize; stale locks recover', async t => {
  const b = await box(t);
  const plans = await Promise.all(['a', 'b'].map(name => preview({...b, home: b.file(name)}, [fileUnit(b.file(`${name}/main`), name)])));
  await Promise.all(plans.map(p => applyPlan(b.store, p)));
  assert.equal(Object.keys((await b.store.load()).targets).length, 2);
  const script = `import {Store} from './src/engine.mjs'; const s=new Store(process.argv[1]); for(let i=0;i<5;i++) await s.update(async state=>{const n=state.counter??0;await new Promise(r=>setTimeout(r,4));state.counter=n+1;});`;
  await Promise.all([run(script, [b.store.home], b.env), run(script, [b.store.home], b.env)]);
  assert.equal((await b.store.load()).counter, 10);
  await fs.writeFile(path.join(b.store.home, 'transaction.lock'), JSON.stringify({pid: 2147483647, token: 'dead'}));
  assert.equal((await b.store.load()).counter, 10);
});

test('R03: state-save failure compensates target writes and retains original bytes/stack', async t => {
  const b = await box(t), file = path.join(b.home, 'main'); await put(file, 'ORIGINAL');
  const planned = await preview(b, [fileUnit(file, 'MANAGED')], {force: true});
  b.store.save = async () => { throw new Error('synthetic state-save failure'); };
  await assert.rejects(applyPlan(b.store, planned), /state-save failure/);
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  assert.deepEqual((await b.store.load()).targets, {});
  assert.equal(await exists(b.store.pending), false);
});

test('R03: interrupted transaction journal recovers on the next normal Store read', async t => {
  const b = await box(t), file = path.join(b.home, 'main'); await put(file, 'MANAGED');
  const encode = value => Buffer.from(value).toString('base64');
  await put(b.store.pending, JSON.stringify({backup: 'fixture', stateAfter: encode('{"committed":true}'), missingDirs: [],
    files: [{path: file, boundary: b.home, before: encode('ORIGINAL'), after: encode('MANAGED')}]}));
  await b.store.load();
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  assert.equal(await exists(b.store.pending), false);
});

test('R04: stale uninstall preflights all files before restoring any; later failure compensates', async t => {
  const b = await box(t), a = path.join(b.home, 'a'), z = path.join(b.home, 'z');
  await put(a, 'ORIGINAL A'); await put(z, 'ORIGINAL Z');
  await install(b, [fileUnit(a, 'MANAGED A'), fileUnit(z, 'MANAGED Z')], {force: true});
  const planned = await undoPlan(b); await fs.writeFile(a, 'USER A');
  await assert.rejects(applyUndo(b.store, planned));
  assert.equal(await fs.readFile(z, 'utf8'), 'MANAGED Z');
  assert.equal((await b.store.target(planned.key)).stack.length, 1);
  await fs.writeFile(a, 'MANAGED A');
  const next = await undoPlan(b), link = fs.link; let failed = false;
  fs.link = async (from, to) => {
    if (to === a && !failed) { failed = true; throw new Error('synthetic later write failure'); }
    return link(from, to);
  };
  try { await assert.rejects(applyUndo(b.store, next), /later write failure/); }
  finally { fs.link = link; }
  assert.equal(failed, true, 'failure reached the exclusive publication boundary');
  assert.equal(await fs.readFile(z, 'utf8'), 'MANAGED Z');
  assert.equal(await fs.readFile(a, 'utf8'), 'MANAGED A');
  assert.equal((await b.store.target(next.key)).stack.length, 1);
});

test('R05: destination junctions are rejected at plan and mutation time', async t => {
  const b = await box(t), outside = b.file('outside'), rules = path.join(b.home, 'rules');
  await fs.mkdir(outside); await fs.mkdir(b.home);
  if (!await junction(t, outside, rules)) return;
  await assert.rejects(preview(b, [fileUnit(path.join(rules, 'main'), 'MANAGED')]), /escapes boundary/);
  assert.equal(await exists(path.join(outside, 'main')), false);
  await fs.unlink(rules); await fs.mkdir(rules);
  const planned = await preview(b, [fileUnit(path.join(rules, 'main'), 'MANAGED')]);
  await fs.rmdir(rules); await fs.symlink(outside, rules, 'junction');
  await assert.rejects(applyPlan(b.store, planned), /escapes boundary/);
  assert.equal(await exists(path.join(outside, 'main')), false);
});

test('R06: source and option-patch junctions cannot read outside a package', async t => {
  const b = await box(t), pkg = b.file('package'), outside = b.file('outside');
  await put(path.join(outside, 'secret.md'), 'PRIVATE'); await fs.mkdir(pkg);
  if (!await junction(t, outside, path.join(pkg, 'link'))) return;
  await put(path.join(pkg, 'recipe.toml'), 'id="escape"\n[prompts]\nsystem={file="link/secret.md"}\n');
  await assert.rejects(loadSource(pkg), /file escapes package/);
  await put(path.join(pkg, 'recipe.toml'), 'id="escape"\n[prompts]\nsystem={text="# Heading\\nText"}\n[options.x]\nname="X"\ndefault=true\n[[options.x.patch]]\nslot="common.system"\nsection="Heading"\naction="append"\ncontent={file="link/secret.md"}\n');
  await assert.rejects(loadSource(pkg), /file escapes package/);
  const author = b.file('author'); await put(path.join(author, 'recipe/recipe.toml'), 'id="author"\n[prompts]\nsystem={text="MAIN"}\n');
  await fs.mkdir(path.join(author, 'dist')); await fs.symlink(outside, path.join(author, 'dist/codex'), 'junction');
  const [loaded] = await loadSource(author);
  await assert.rejects(loaded.artifacts('codex'), /escapes boundary/);
});

test('R08: preview redacts authorization, bearer, API-key and cookie headers; integrity remains real-byte exact', async t => {
  const b = await box(t), file = path.join(b.home, 'config.toml');
  const original = 'http_headers = { Authorization = "Bearer PRIVATE-A", "x-api-key" = "PRIVATE-B", "api-key" = "PRIVATE-C", Cookie = "a=PRIVATE-D; b=PRIVATE-E" }\n';
  await put(file, original);
  const planned = await preview(b, [tomlKeyUnit(file, [], 'recipe', 'managed')]);
  for (const secret of ['PRIVATE-A', 'PRIVATE-B', 'PRIVATE-C', 'PRIVATE-D', 'PRIVATE-E']) assert.ok(!planned.files[0].diff.includes(secret));
  await fs.writeFile(file, original.replace('PRIVATE-A', 'PRIVATE-Z'));
  await assert.rejects(applyPlan(b.store, planned), /changed since the preview/);
  assert.match(redact('Authorization: Bearer abc123\nx-api-key: key-value\nCookie: session=abc'), /\[redacted\]/);
});

test('R09: OpenClaw explicit conversation denial blocks even force; absent permission stays unset and is announced', async t => {
  const b = await box(t), file = path.join(b.home, 'openclaw.json');
  const original = '{"plugins":{"entries":{"recipe-switch":{"hooks":{"allowConversationAccess":false}}}}}\n';
  await put(file, original);
  await assert.rejects(openclaw.desired(recipe, b.home, {}, {env: {}}), /allowConversationAccess is false/);
  b.service.recipe = async () => recipe;
  await assert.rejects(b.service.preview({harness: 'openclaw', home: b.home, recipe: recipe.key, force: true}), /allowConversationAccess is false/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await fs.writeFile(file, '{}\n');
  const desired = await openclaw.desired(recipe, b.home, {}, {env: {}});
  assert.match(joinText(desired.notes), /requires non-bundled plugins to be granted conversation access/);
  await install(b, desired.units);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).plugins.entries['recipe-switch'].hooks?.allowConversationAccess, undefined);
  await applyUndo(b.store, await undoPlan(b));
  assert.equal(await fs.readFile(file, 'utf8'), '{}\n');
});

test('R10: edits to the owned TOML marker line cause drift and block uninstall', async t => {
  const b = await box(t), file = path.join(b.home, 'config.toml'); await put(file, 'model="keep"\n');
  await install(b, [tomlKeyUnit(file, [], 'recipe', 'managed')]);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('# managed by recipe-switch', '# USER NOTE'));
  assert.equal((await status(b.store, 'fixture', b.home)).drift.length, 1);
  const planned = await undoPlan(b); assert.match(joinText(planned.blocked), /hand edit/);
  await assert.rejects(applyUndo(b.store, planned), /Blocked/);
  assert.match(await fs.readFile(file, 'utf8'), /USER NOTE/);
});

test('R11: all JSON unit kinds restore original source spans, including empty arrays and escapes, with unrelated edits', async t => {
  for (const [name, original, desired] of [
    ['item', '\uFEFF{\r\n "other":1,"items":[  \r\n ]\r\n}\r\n', file => [jsonItemUnit(file, ['items'], 'managed')]],
    ['key', '{"other":1,"dep":"file:\\u002eold"}\r\n', file => [{type: 'jsonKey', path: file, pointer: ['dep'], afterValue: 'managed'}]],
    ['record', '{"other":1,"plugins":[{ "id":"recipe-switch", "label":"\\u006fold" }]}\r\n', file => [{type: 'jsonArrayRecord', path: file, pointer: ['plugins'], value: 'recipe-switch', afterValue: {id: 'recipe-switch', label: 'managed'}}]],
  ]) {
    const b = await box(t), file = path.join(b.home, name + '.json'); await put(file, original);
    await install(b, desired(file));
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"other":1', '"other":2'));
    await applyUndo(b.store, await undoPlan(b));
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('"other":1', '"other":2'), name);
  }
});

test('R12: forced retirement backs up the edited live bytes and rollback restores that version', async t => {
  const b = await box(t), file = path.join(b.home, 'retired');
  await install(b, [fileUnit(file, 'MANAGED')]); await fs.writeFile(file, 'USER EDIT');
  const planned = await preview(b, [], {force: true}), result = await applyPlan(b.store, planned);
  assert.equal(await exists(file), false);
  const index = JSON.parse(await fs.readFile(path.join(result.backup, 'index.json'), 'utf8'));
  assert.equal(await fs.readFile(path.join(b.store.home, 'blobs', index[0].blob.hash), 'utf8'), 'USER EDIT');
  await applyUndo(b.store, await undoPlan(b, {}));
  assert.equal(await fs.readFile(file, 'utf8'), 'USER EDIT');
});

test('R13: explicit off remains null and each driver preserves it or gives a manual conversion prerequisite', async t => {
  const b = await box(t), pkg = b.file('off-package');
  await put(path.join(pkg, 'recipe.toml'), 'id="off-test"\n[prompts]\nsystem={text="SUB ONLY"}\nmain="off"\nindependent="off"\n');
  const [loaded] = await loadSource(pkg); assert.equal(loaded.texts.main, null); assert.equal(loaded.texts.independent, null); assert.equal(loaded.texts.sub, 'SUB ONLY');
  loaded.key = 'off-test@0.0.0';
  b.service.recipe = async () => loaded;
  await put(b.file('kimi-code/SYSTEM.md'), 'USER SYSTEM');
  for (const driver of DRIVERS) {
    let home = b.service.harnessHome(driver), options = {};
    if (driver.id === 'dsh') home = b.file('dsh/profiles/web');
    if (driver.id === 'kiki') options = {models: ['axon/gpt-6.1-sol']};
    if (['codex', 'claude', 'omp', 'grok', 'opencode'].includes(driver.id)) {
      await assert.rejects(b.service.preview({harness: driver.id, home, recipe: loaded.key, options}), /explicit main=off is unsupported/);
    } else {
      const planned = await b.service.preview({harness: driver.id, home, recipe: loaded.key, options});
      assert.equal(planned.blocked.length, 0, driver.id);
      await b.service.apply(planned.id);
    }
  }
  assert.equal(await fs.readFile(b.file('kimi-code/SYSTEM.md'), 'utf8'), 'USER SYSTEM');
  const entry = b.file('pi/agent/extensions/recipe-switch/runtime.mjs');
  const {createRecipeExtension} = await import(pathToFileURL(entry).href);
  const handlers = new Map(); createRecipeExtension()({on: (key, fn) => handlers.set(key, fn), registerCommand() {}});
  const messages = [{role: 'system', content: 'HOST', sections: {host: 'HOST'}}];
  const ctx = {model: {provider: 'x', id: 'y'}, sessionManager: {getBranch: () => []}};
  assert.deepEqual((await handlers.get('context_with_system')({messages}, ctx)).messages, messages);
  assert.equal(handlers.get('before_provider_request')({payload: {instructions: 'HOST'}}, ctx), undefined);
});

test('Hermes: YAML owned-line drift blocks, unrelated changes survive exact uninstall, disable policy stays authoritative', async t => {
  const b = await box(t), file = path.join(b.home, 'config.yaml'), original = '\uFEFFmodel: keep\r\nplugins:\r\n  enabled:\r\n    - neighbour # keep\r\n';
  await put(file, original); await install(b, (await hermes.desired(recipe, b.home)).units);
  const managed = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, managed.replace('# managed by recipe-switch', '# USER MARKER'));
  assert.equal((await status(b.store, 'fixture', b.home)).drift.length, 1);
  assert.match(joinText((await undoPlan(b)).blocked), /hand edit/);
  await fs.writeFile(file, managed.replace('model: keep', 'model: changed'));
  await applyUndo(b.store, await undoPlan(b));
  assert.equal(await fs.readFile(file, 'utf8'), original.replace('model: keep', 'model: changed'));
  const denied = 'plugins:\n  disabled: [recipe-switch]\n'; await fs.writeFile(file, denied);
  await assert.rejects(hermes.desired(recipe, b.home), /remove that entry yourself/);
  assert.equal(await fs.readFile(file, 'utf8'), denied);
});


test('Hermes: inserted YAML separator is restored byte-exactly with unrelated edits in an EOF-only original', async t => {
  const b = await box(t), file = path.join(b.home, 'config.yaml');
  await put(file, '# USER NO EOF'); await install(b, (await hermes.desired(recipe, b.home)).units);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('# USER NO EOF', '# CHANGED NO EOF'));
  await applyUndo(b.store, await undoPlan(b));
  assert.equal(await fs.readFile(file, 'utf8'), '# CHANGED NO EOF');
});

test('Hermes: installed snapshot reader refuses a redirected snapshot path and symlink', async t => {
  const b = await box(t); await install(b, (await hermes.desired(recipe, b.home)).units);
  const entry = path.join(b.home, 'plugins/recipe-switch/__init__.py'), external = b.file('external.json');
  await put(external, JSON.stringify({managedBy: 'recipe-switch', texts: {main: 'PRIVATE'}}));
  const python = String.raw`import importlib.util,sys
from pathlib import Path
entry=Path(sys.argv[1]); spec=importlib.util.spec_from_file_location("review_snapshot",entry)
plugin=importlib.util.module_from_spec(spec);spec.loader.exec_module(plugin)
assert plugin._texts()["main"] == "MAIN"
plugin._SNAPSHOT=Path(sys.argv[2])
try: plugin._texts()
except ValueError as error: assert "escapes" in str(error)
else: raise AssertionError("external snapshot was read")
`;
  const child = spawn('python', ['-c', python, entry, external], {cwd: ROOT, env: {...process.env, ...b.env, PYTHONDONTWRITEBYTECODE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  let errorText = ''; child.stderr.on('data', chunk => errorText += chunk);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, errorText);
  const snap = path.join(path.dirname(entry), 'recipe.json'); await fs.unlink(snap);
  if (!await junction(t, external, snap, 'file')) return;
  const symlinkScript = String.raw`import importlib.util,sys
from pathlib import Path
entry=Path(sys.argv[1]);spec=importlib.util.spec_from_file_location("review_link",entry)
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
try: p._texts()
except ValueError as error: assert "escapes" in str(error)
else: raise AssertionError("snapshot symlink was read")
`;
  const linked = spawn('python', ['-c', symlinkScript, entry], {cwd: ROOT, env: {...process.env, ...b.env, PYTHONDONTWRITEBYTECODE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  let linkedError = ''; linked.stderr.on('data', chunk => linkedError += chunk);
  assert.equal(await new Promise((resolve, reject) => { linked.on('error', reject); linked.on('close', resolve); }), 0, linkedError);
});


test('R05: replacing the chosen home with a junction cannot redefine the authorized boundary', async t => {
  const b = await box(t), outside = b.file('other-home'); await fs.mkdir(b.home); await fs.mkdir(outside);
  const planned = await preview(b, [fileUnit(path.join(b.home, 'main'), 'MANAGED')]);
  await fs.rename(b.home, b.file('original-home'));
  if (!await junction(t, outside, b.home)) return;
  await assert.rejects(applyPlan(b.store, planned), /escapes boundary/);
  assert.equal(await exists(path.join(outside, 'main')), false);
});

test('R11: lexical hand edits of an owned JSON member block restoration instead of disappearing', async t => {
  const b = await box(t), file = path.join(b.home, 'config.json'); await put(file, '{"other":1,"dep":"original"}\n');
  await install(b, [{type: 'jsonKey', path: file, pointer: ['dep'], afterValue: 'MANAGED'}]);
  const edited = (await fs.readFile(file, 'utf8')).replace('"dep":"MANAGED"', '"dep" :  "MANAGED"');
  await fs.writeFile(file, edited);
  assert.equal((await status(b.store, 'fixture', b.home)).drift.length, 1);
  const planned = await undoPlan(b); assert.match(joinText(planned.blocked), /hand edit/);
  await assert.rejects(applyUndo(b.store, planned), /Blocked/);
  assert.equal(await fs.readFile(file, 'utf8'), edited);
});


test('R12: full uninstall crosses a forced-retirement history and restores the original base', async t => {
  const b = await box(t), file = path.join(b.home, 'main'); await put(file, 'ORIGINAL');
  await install(b, [fileUnit(file, 'MANAGED')], {force: true}); await fs.writeFile(file, 'USER EDIT');
  await install(b, [], {force: true});
  await applyUndo(b.store, await undoPlan(b));
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
});

test('R06: legacy author-package reads reject source junctions before executing its loader', async t => {
  const b = await box(t), author = b.file('legacy-author'), outside = b.file('private-source');
  await put(path.join(outside, 'secret.md'), 'PRIVATE');
  await put(path.join(author, 'recipe/manifest.json'), '{}');
  await put(path.join(author, 'src/build.mjs'), `import fs from 'node:fs/promises';import path from 'node:path';export async function loadRecipe(root){return {meta:{id:'legacy',name:'Legacy',version:'1'},texts:{main:await fs.readFile(path.join(root,'recipe/link/secret.md'),'utf8')}};}`);
  if (!await junction(t, outside, path.join(author, 'recipe/link'))) return;
  await assert.rejects(loadSource(author), /Linked source refused|escapes boundary/);
});

test('R13: committed adapter artifacts cannot re-enable an explicitly disabled independent role', async t => {
  const b = await box(t), author = b.file('off-author');
  await put(path.join(author, 'recipe/recipe.toml'), 'id="off-author"\n[prompts]\nsystem={text="MAIN"}\nindependent="off"\n');
  await put(path.join(author, 'dist/codex/main.md'), 'STALE COMMON CONTENT');
  const [loaded] = await loadSource(author);
  await assert.rejects(loaded.artifacts('codex'), /explicit independent=off is unsupported/);
});


test('R12: force records retirement even when the live hand edit already equals the original base', async t => {
  const b = await box(t), file = path.join(b.home, 'main'); await put(file, 'ORIGINAL');
  await install(b, [fileUnit(file, 'MANAGED')], {force: true}); await fs.writeFile(file, 'ORIGINAL');
  const planned = await preview(b, [], {force: true}); assert.equal(planned.units.length, 1);
  await applyPlan(b.store, planned);
  assert.equal((await status(b.store, 'fixture', b.home)).drift.length, 0);
  await applyUndo(b.store, await undoPlan(b));
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
});
