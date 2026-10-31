import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sandbox} from './helpers.mjs';
import {copyPermissions, equivalentAcl, readAcl} from '../src/private-storage.mjs';
import {writeFile} from '../src/fsx.mjs';
const windows = process.platform === 'win32';
const native = name => path.join(process.env.SystemRoot, 'System32', name + '.exe');
const ic = (...args) => execFileSync(native('icacls'), args, {encoding: 'utf8', windowsHide: true});
let user;
const sid = () => user ??= execFileSync(native('whoami'), ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8'}).match(/S-1-\d+(?:-\d+)+/)[0];

// This comparison is deliberately limited: P, deny rights and all ACE flags matter.
test('R31: ACL equivalence ignores AI and ACE order, but preserves protection, denies and inheritance', () => {
  const a = 'D:(A;ID;FA;;;BA)(A;ID;FR;;;BU)';
  assert.ok(equivalentAcl(a, 'D:AI(A;ID;FR;;;BU)(A;ID;FA;;;BA)'));
  assert.equal(equivalentAcl(a, 'D:P(A;ID;FA;;;BA)(A;ID;FR;;;BU)'), false);
  assert.equal(equivalentAcl(a, 'D:(A;;FA;;;BA)(A;ID;FR;;;BU)'), false);
  assert.equal(equivalentAcl(a, 'D:(D;ID;FA;;;BA)(A;ID;FR;;;BU)'), false);
  assert.throws(() => equivalentAcl('D:(XA;;FA;;;WD;(@User.test == 1))', a), /无法保留目标权限.*Windows 安全设置.*Cannot preserve target ACL.*install manually/);
  assert.throws(() => equivalentAcl('D:(OA;;FA;object;;WD)', a), /object\/conditional/);
});

test('R31: six inherited/protected/deny/redirected ACL cases preserve every account and ACE before payload', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: [], base: path.join(os.tmpdir(), 'recipe-switch-acl-tests')});
  for (const name of ['default-inherited', 'user-home-inherited', 'protected-user', 'inherited-plus-deny', 'protected-deny', 'redirected-home']) await t.test(name, async t => {
    const parent = b.file(name); await fs.mkdir(parent); let home = parent;
    if (['user-home-inherited', 'inherited-plus-deny', 'redirected-home'].includes(name))
      ic(parent, '/inheritance:r', '/grant:r', `*${sid()}:(OI)(CI)F`, '/grant', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/q');
    if (name === 'redirected-home') {
      home = b.file('junction');
      try { await fs.symlink(parent, home, 'junction'); } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip(e.code); throw e; }
    }
    const file = path.join(home, 'config.toml'), temp = file + '.replacement';
    await fs.writeFile(file, 'api_key = "FAKE-PRIVATE"\n'); await fs.writeFile(temp, '');
    if (name.startsWith('protected-')) ic(file, '/inheritance:r', '/grant:r', `*${sid()}:F`, '/q');
    if (name.includes('deny')) ic(file, '/deny', '*S-1-5-32-546:(WD)', '/q');
    const before = await readAcl(file);
    await copyPermissions(file, temp);
    const after = await readAcl(temp);
    assert.ok(equivalentAcl(before, after), `${before}\n${after}`);
    await fs.writeFile(temp, 'api_key = "FAKE-PRIVATE"\ninstruction = "MAIN"\n');
    assert.ok(equivalentAcl(before, await readAcl(temp)));
    t.diagnostic(JSON.stringify({name, before, after}));
  });
});

test('R31: arbitrary numeric SID grants and denies with explicit inheritance flags are expressible', {skip: !windows}, async t => {
  const b = await sandbox(t, {sources: []}), file = b.file('raw-sid'), temp = b.file('raw-sid-temp');
  await fs.writeFile(file, 'private'); await fs.writeFile(temp, '');
  execFileSync(native('WindowsPowerShell\\v1.0\\powershell'), ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetSecurityDescriptorSddlForm($env:RS_ACL_SDDL,[System.Security.AccessControl.AccessControlSections]::Access); [IO.File]::SetAccessControl($env:RS_ACL_PATH,$a)'],
  {env: {...process.env, RS_ACL_PATH: file, RS_ACL_SDDL: `D:P(D;;WP;;;BG)(A;;FA;;;${sid()})(A;OICI;FR;;;S-1-5-21-111-222-333-444)`}, windowsHide: true});
  await copyPermissions(file, temp);
  assert.ok(equivalentAcl(await readAcl(file), await readAcl(temp)));
});

test('R31: install, switch and uninstall work in os.tmpdir default inherited ACL without changing original bytes or ACL', async t => {
  const b = await sandbox(t, {sources: [], base: path.join(os.tmpdir(), 'recipe-switch-acl-tests')}), {service} = b;
  const home = b.env.CODEX_HOME, config = path.join(home, 'config.toml');
  const before = await fs.readFile(config), acl = windows ? await readAcl(config) : null;
  service.recipe = async key => ({id: key, key, name: key, version: '1', texts: {main: key, sub: key}, artifacts: async () => new Map([['main.md', Buffer.from(key)], ['sub.md', Buffer.from(key)]])});
  for (const recipe of ['one', 'two']) { const p = await service.preview({harness: 'codex', recipe}); assert.deepEqual(p.blocked, []); await service.apply(p.id); if (windows) assert.ok(equivalentAcl(acl, await readAcl(config))); }
  const p = await service.previewUndo({harness: 'codex', all: true}); await service.applyUndo(p.id);
  assert.deepEqual(await fs.readFile(config), before);
  if (windows) assert.ok(equivalentAcl(acl, await readAcl(config)));
});

test('R28/R32: a temp swapped before ACL setup never receives private bytes through the old handle', async t => {
  const b = await sandbox(t, {sources: []}), file = b.file('secret'), temp = file + '.tmp', alias = file + '.moved';
  await fs.writeFile(file, 'PRIVATE');
  await assert.rejects(writeFile(file, Buffer.from('NEW PRIVATE'), {expected: Buffer.from('PRIVATE'), temp, onStage: async phase => {
    if (phase === 'temp-created') { await fs.rename(temp, alias); await fs.writeFile(temp, ''); }
  }}), /Path replaced|路径已被替换/);
  assert.equal(await fs.readFile(alias, 'utf8'), ''); assert.equal(await fs.readFile(file, 'utf8'), 'PRIVATE');
});
