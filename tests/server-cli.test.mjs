import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.mjs';
import {main} from '../bin/recipe-loader.mjs';
import {sandbox, tree} from './helpers.mjs';

async function listen(t, service) {
  const {server, token} = createServer({service});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const {address, port} = server.address();
  return {address, port, token, base: `http://127.0.0.1:${port}`};
}

test('server binds 127.0.0.1 and refuses missing tokens, foreign Origins and rebinding Hosts', async t => {
  const {service} = await sandbox(t);
  const {address, port, token, base} = await listen(t, service);
  assert.equal(address, '127.0.0.1');
  const page = await (await fetch(base + '/')).text().catch(() => '');
  assert.equal((await fetch(base + '/api/overview')).status, 401);
  assert.equal((await fetch(base + '/api/overview', {headers: {'x-recipe-loader-token': token, origin: 'https://evil.example'}})).status, 403);
  const rebinding = await new Promise(resolve => {
    import('node:http').then(({request}) => request({host: '127.0.0.1', port, path: '/api/overview', headers: {host: `evil.example:${port}`, 'x-recipe-loader-token': token}},
      res => resolve(res.statusCode)).end());
  });
  assert.equal(rebinding, 421);
  const ok = await fetch(base + '/api/overview', {headers: {'x-recipe-loader-token': token}});
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).targets.length >= 8);
  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(traversal.status, 200);
  assert.ok(typeof page === 'string');
});

test('server preview → apply → undo round trip over HTTP', async t => {
  const {service, dir} = await sandbox(t);
  const before = await tree(dir);
  const {token, base} = await listen(t, service);
  const call = async (route, body) => {
    const res = await fetch(base + route, {method: body ? 'POST' : 'GET', headers: {'x-recipe-loader-token': token, 'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    const value = await res.json();
    if (res.status !== 200) throw new Error(value.error);
    return value;
  };
  const planned = await call('/api/preview', {harness: 'grok', recipe: 'gpt-with-taste@0.1.0'});
  assert.equal(planned.units, undefined, 'raw unit bytes are not sent to the page');
  assert.equal(planned.files[0].action, 'create');
  assert.equal((await call('/api/apply', {planId: planned.id})).changed, true);
  await assert.rejects(call('/api/apply', {planId: planned.id}), /expired/);
  const undo = await call('/api/preview-undo', {harness: 'grok', all: true});
  await call('/api/apply', {planId: undo.id});
  assert.deepEqual(await tree(dir), before);
});

test('CLI dry run writes nothing; --yes applies; status reports the recipe', async t => {
  const {service, dir} = await sandbox(t);
  const before = await tree(dir, []);
  const log = [];
  const original = console.log;
  console.log = (...args) => log.push(args.join(' '));
  try {
    await main(['install', 'opencode', 'gpt-with-taste@0.1.0'], service);
    assert.deepEqual(await tree(dir, []), before, 'dry run leaves files and state untouched');
    assert.match(log.join('\n'), /Dry run\. Re-run with --yes/);
    await main(['install', 'opencode', 'gpt-with-taste@0.1.0', '--yes'], service);
    log.length = 0;
    await main(['status'], service);
    assert.match(log.join('\n'), /OpenCode {2}detected .*\n {2}recipe-loader: gpt-with-taste@0\.1\.0/);
    await main(['uninstall', 'opencode', '--yes'], service);
  } finally { console.log = original; }
});
