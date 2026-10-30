import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from '../src/server.mjs';
import {sandbox} from './helpers.mjs';

const recipe = {
  id: 'r08', key: 'r08@1', name: 'R08 fixture', version: '1', revision: '1', origin: 'test',
  texts: {main: 'MAIN', sub: 'SUB', independent: null, userSteer: null, subSteer: null, agentSteer: null},
  artifacts: async () => new Map([['main.md', Buffer.from('MAIN')], ['sub.md', Buffer.from('SUB')]]),
};

async function listen(t, service) {
  const {server, token} = createServer({service});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {token, base: `http://127.0.0.1:${server.address().port}`};
}

async function call(base, token, route, body) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-recipe-switch-token': token},
    body: JSON.stringify(body),
  });
  const value = await response.json();
  return {response, value, text: JSON.stringify(value)};
}

function assertSafe(value, credential) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(credential, 'g'));
  for (const drift of value.drift ?? []) {
    assert.equal('live' in drift, false);
    assert.ok(['edited', 'missing'].includes(drift.state));
    assert.equal(typeof drift.path, 'string');
    assert.equal(typeof drift.unit, 'string');
  }
}

test('R08: authenticated preview projections hide drift source while preserving integrity and safe missing/edited state', async t => {
  const box = await sandbox(t, {sources: []});
  box.service.recipe = async () => recipe;
  const home = box.file('codex'), config = box.file('codex/config.toml');
  const {base, token} = await listen(t, box.service);
  const install = await box.service.preview({harness: 'codex', home, recipe: recipe.key});
  await box.service.apply(install.id);

  const credential = 'Bearer R08-PRIVATE-CREDENTIAL';
  const edited = (await fs.readFile(config, 'utf8')).replace(
    '# managed by recipe-switch', `# Authorization = "${credential}"`,
  );
  await fs.writeFile(config, edited);

  const preview = await call(base, token, '/api/preview', {harness: 'codex', home, recipe: recipe.key});
  assert.equal(preview.response.status, 200);
  assertSafe(preview.value, credential);
  assert.deepEqual(preview.value.drift.map(({path, unit, state}) => ({path, unit, state})), [{
    path: config.replaceAll('\\', '/'), unit: 'TOML key model_instructions_file', state: 'edited',
  }]);

  const undo = await call(base, token, '/api/preview-undo', {harness: 'codex', home, all: true});
  assert.equal(undo.response.status, 200);
  assertSafe(undo.value, credential);
  assert.deepEqual(undo.value.drift.map(({path, unit, state}) => ({path, unit, state})), [{
    path: config.replaceAll('\\', '/'), unit: 'TOML key model_instructions_file', state: 'edited',
  }]);

  const forced = await call(base, token, '/api/preview', {harness: 'codex', home, recipe: recipe.key, force: true});
  assert.equal(forced.response.status, 200);
  assertSafe(forced.value, credential);
  await fs.writeFile(config, edited.replace(credential, 'Bearer R08-CHANGED-AFTER-PREVIEW'));
  const applied = await call(base, token, '/api/apply', {planId: forced.value.id});
  assert.equal(applied.response.status, 400);
  assert.match(applied.value.error, /changed since the preview/i);

  await fs.rm(config);
  const missingPreview = await call(base, token, '/api/preview', {harness: 'codex', home, recipe: recipe.key});
  assert.equal(missingPreview.response.status, 200);
  assertSafe(missingPreview.value, credential);
  assert.equal(missingPreview.value.drift[0].state, 'missing');

  const missingUndo = await call(base, token, '/api/preview-undo', {harness: 'codex', home, all: true});
  assert.equal(missingUndo.response.status, 200);
  assertSafe(missingUndo.value, credential);
  assert.equal(missingUndo.value.drift[0].state, 'missing');
});
