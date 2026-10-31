// Permissions are established before any sensitive payload reaches a new inode.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import {AsyncLocalStorage} from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const privateScope = fn => scope.getStore() ? fn() : scope.run(new Map(), fn);
// R32: process-wide cache, invalidated by inode/mode/NTFS ChangeTime (ACL writes
// change ctime too). Always walk children: a leaf ACL edit need not touch its parent.
const permissions = new Map();
const permissionKey = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.ctimeNs}`;
const remembered = (file, stat) => permissions.get(path.resolve(file)) === permissionKey(stat);
export async function rememberPrivate(file) {
  const stat = await fs.lstat(file, {bigint: true});
  if (stat.isSymbolicLink()) throw new Error(`Linked private storage refused: ${file}`);
  permissions.set(path.resolve(file), permissionKey(stat));
}
// Only call after our own name operations in an already verified private parent.
export async function rememberPrivateParent(file) {
  const parent = path.dirname(path.resolve(file));
  if (permissions.has(parent)) await rememberPrivate(parent);
}
const execute = promisify(execFile);
const native = name => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe');
const icacls = (args, cwd) => execute(native('icacls'), args, {cwd, windowsHide: true});
let currentUser;
async function userSid() {
  currentUser ??= execute(native('whoami'), ['/user', '/fo', 'csv', '/nh'], {windowsHide: true}).then(({stdout}) => {
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/i)?.[0];
    if (!sid) throw new Error('Cannot identify the current Windows user SID');
    return sid;
  });
  return currentUser;
}

// A process-local export directory is protected once while empty. Export files
// inherit it; no per-export ACL mutation and no metadata temp beside credentials.
let scratchHome;
async function aclScratch() {
  scratchHome ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recipe-switch-acl-'));
    try { await icacls([dir, '/inheritance:r', '/grant:r', `*${await userSid()}:(OI)(CI)F`, '/q']); }
    catch (error) { await fs.rm(dir, {recursive: true, force: true}); throw error; }
    process.once('beforeExit', () => fs.rm(dir, {recursive: true, force: true}).catch(() => {}));
    return dir;
  })();
  return scratchHome;
}
// icacls /save uses UTF-16LE SDDL, independent of localized account names.
async function savedAcl(file, fn, recursive = false) {
  const scratch = path.join(await aclScratch(), `.recipe-switch-acl-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(scratch, Buffer.alloc(0), {flag: 'wx', mode: 0o600});
    await icacls([path.basename(file), '/save', scratch, ...(recursive ? ['/t'] : []), '/q'], path.dirname(file));
    const text = (await fs.readFile(scratch)).toString('utf16le').replace(/^\uFEFF/, '');
    return await fn(text, scratch);
  } finally { await fs.unlink(scratch).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const trustees = {WD: 'S-1-1-0', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', BA: 'S-1-5-32-544', SY: 'S-1-5-18',
  AU: 'S-1-5-11', CO: 'S-1-3-0', CG: 'S-1-3-1', NU: 'S-1-5-2', IU: 'S-1-5-4', SU: 'S-1-5-6', AN: 'S-1-5-7',
  LS: 'S-1-5-19', NS: 'S-1-5-20', AC: 'S-1-15-2-1', RC: 'S-1-5-12'};
const resolvedTrustees = new Map(Object.entries(trustees));
async function principalSid(trustee) {
  if (/^S-1-\d+(?:-\d+)+$/i.test(trustee)) return trustee;
  if (!resolvedTrustees.has(trustee)) {
    // ConvertStringSidToSid (via .NET) knows every SDDL alias, including domain
    // aliases; do not guess a localized account name or reject a valid SID.
    const {stdout} = await execute(native('WindowsPowerShell\\v1.0\\powershell'), ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $s = New-Object System.Security.Principal.SecurityIdentifier($env:RS_ACL_TRUSTEE); $s.Value'],
    {windowsHide: true, env: {...process.env, RS_ACL_TRUSTEE: trustee}});
    const sid = stdout.trim();
    if (!/^S-1-\d+(?:-\d+)+$/i.test(sid)) throw aclError(`cannot resolve SID ${trustee}`);
    resolvedTrustees.set(trustee, sid);
  }
  return resolvedTrustees.get(trustee);
}
async function secureWindows(file, directory, sddl = null, fresh = false) {
  const sid = await userSid(), remove = new Set();
  let full = false, broad = false, aces = [];
  if (!fresh) {
    ({aces} = parseAcl(sddl ?? await readAcl(file)));
    for (const [type, flags, mask, , , trustee] of aces) {
      if (type !== 'A') continue; // Keep explicit denies.
      const principal = await principalSid(trustee);
      if (![sid, trustees.SY, trustees.BA].includes(principal)) { broad = true; if (!flags.includes('ID')) remove.add('*' + principal); }
      if (principal === sid && maskValue(mask) === 0x1f01ff && !flags.includes('IO') && (!directory || flags.includes('OI') && flags.includes('CI'))) full = true;
    }
    if (!broad && full) return;
  }
  await icacls([file, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)' : ''}F`, '/q']);
  if (remove.size) try { await icacls([file, '/remove:g', ...remove, '/q']); }
  catch (error) {
    if (error.code !== 1332) throw error;
    const keep = aces.filter(([type, flags, , , , trustee]) => !flags.includes('ID') &&
      (type === 'D' || [trustees.SY, trustees.BA].includes(resolvedTrustees.get(trustee) ?? trustee)));
    keep.sort((a, b) => (a[0] === 'D' ? 0 : 1) - (b[0] === 'D' ? 0 : 1));
    const grants = keep.map(a => `(${a.join(';')})`).join('');
    await setOrdinaryAcl(file, `D:P${grants}(A;${directory ? 'OICI' : ''};FA;;;${sid})`, directory);
  }
}

/** Secure existing storage too; never follow a linked subtree. Metadata walks
 * are cheap; only unknown/changed ACLs require an export (batched per subtree). */
export async function privateDirectory(dir, {recursive = true} = {}) {
  dir = path.resolve(dir);
  try {
    let ancestor = path.dirname(dir), parentStat;
    while (!(parentStat = await fs.lstat(ancestor, {bigint: true}).catch(e => { if (e.code === 'ENOENT') return null; throw e; }))) ancestor = path.dirname(ancestor);
    const inherited = remembered(ancestor, parentStat);
    const created = await fs.mkdir(dir, {recursive: true, mode: 0o700});
    if (created) {
      if (process.platform === 'win32' && !inherited) await secureWindows(created, true, null, true);
      const first = path.resolve(created).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
      let current = dir;
      for (;;) {
        await rememberPrivate(current); if (current === first) break;
        if (path.dirname(current) === current) throw new Error('Invalid created private directory');
        current = path.dirname(current);
      }
      if (inherited) await rememberPrivate(ancestor);
    }
    const unknown = [];
    const walk = async current => {
      const stat = await fs.lstat(current, {bigint: true});
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error(`Linked/nonregular private storage refused: ${current}`);
      if (!remembered(current, stat)) unknown.push({file: current, directory: stat.isDirectory()});
      // Never let a cached parent hide a leaf whose ACL changed independently.
      if (recursive && stat.isDirectory()) for (const entry of await fs.readdir(current)) await walk(path.join(current, entry));
    };
    await walk(dir);
    let acls;
    if (process.platform === 'win32' && unknown.length > 1) acls = await savedAcl(dir, text => {
      const result = new Map(), lines = text.trimEnd().split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 2) {
        const file = path.resolve(path.dirname(dir), lines[i]), relative = path.relative(dir, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid saved ACL path');
        result.set(file, lines[i + 1]);
      }
      return result;
    }, recursive);
    for (const {file, directory} of unknown) {
      if (process.platform === 'win32') await secureWindows(file, directory, acls?.get(file));
      else await fs.chmod(file, directory ? 0o700 : 0o600);
      await rememberPrivate(file);
    }
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error('Not a private directory');
  } catch (error) { throw new Error(`无法保护私有存储权限，拒绝写入 / Cannot secure private storage; refusing to write: ${dir}: ${error.message}`); }
  return dir;
}
export async function privateFile(file) {
  const stat = await fs.lstat(file, {bigint: true});
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular private file: ${file}`);
  if (remembered(file, stat)) return;
  if (process.platform === 'win32') await secureWindows(file, false);
  else await fs.chmod(file, 0o600);
  await rememberPrivate(file);
}

/** The temp is still empty. Preserve the existing target's DACL/mode before payload. */
export async function copyPermissions(source, temp, {privateWhenMissing = false, aclSnapshot, aclToken} = {}) {
  const stat = await fs.lstat(source, {bigint: process.platform === 'win32'}).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (aclToken !== undefined && (stat ? permissionKey(stat) : null) !== aclToken) throw changedPermissions(source);
  if (!stat) {
    // New installs inherit normally; recovery of saved secret bytes fails closed
    // to current-user-only when the former permission source is absent.
    if (privateWhenMissing) await privateFile(temp);
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular permission source: ${source}`);
  if (process.platform !== 'win32') {
    const created = await fs.stat(temp);
    if (created.uid !== stat.uid || created.gid !== stat.gid) await fs.chown(temp, stat.uid, stat.gid);
    return fs.chmod(temp, stat.mode & 0o7777);
  }
  const sddl = aclSnapshot ?? await readAcl(source);
  const token = aclToken ?? permissionKey(stat), {aces, protected: protectedAcl} = parseAcl(sddl);
  // R31: an ordinary sibling inherits equivalent ACEs. AI is Windows' auto-
  // inheritance bookkeeping, not an additional permission or a protection bit.
  if (!protectedAcl && aces.every(([, flags]) => flags.includes('ID'))) {
    const inherited = await readAcl(temp);
    if (equivalentAcl(sddl, inherited)) { await assertPermissionToken(source, token); return; }
  }
  // /restore requires SeRestorePrivilege on some Windows installations. Copy
  // ordinary DACL grants/denies with icacls, then verify the complete DACL.
  await icacls([temp, protectedAcl ? '/inheritance:r' : '/inheritance:e', '/q']);
  const bits = [[0x10000000, 'GA'], [0x20000000, 'GE'], [0x40000000, 'GW'], [0x80000000, 'GR'],
    [1, 'RD'], [2, 'WD'], [4, 'AD'], [8, 'REA'], [16, 'WEA'], [32, 'X'], [64, 'DC'], [128, 'RA'], [256, 'WA'],
    [0x10000, 'DE'], [0x20000, 'RC'], [0x40000, 'WDAC'], [0x80000, 'WO'], [0x100000, 'S'], [0x1000000, 'AS'], [0x2000000, 'MA']];
  for (const [type, flags, mask, , , trustee] of [...aces].sort((a, b) => (a[0] === 'D' ? 0 : 1) - (b[0] === 'D' ? 0 : 1))) {
    if (flags.includes('ID')) continue; // Same parent supplies the same inherited ACEs.
    const principal = await principalSid(trustee);
    let remaining = maskValue(mask); const rights = [];
    for (const [bit, name] of bits) if ((remaining & bit) !== 0) { rights.push(name); remaining = (remaining & ~bit) >>> 0; }
    if (remaining || !rights.length) throw aclError(`unrepresentable access mask ${mask}`);
    const inheritance = (flags.match(/OI|CI|IO|NP/g) ?? []).map(flag => `(${flag})`).join('');
    try { await icacls([temp, type === 'D' ? '/deny' : '/grant', `*${principal}:${inheritance}(${rights.join(',')})`, '/q']); }
    catch (error) {
      if (error.code !== 1332) throw error; // Unknown account, not a permission denial.
      await setOrdinaryAcl(temp, sddl);
      break; // .NET preserves unresolved numeric SIDs that icacls refuses to map.
    }
  }
  if (!equivalentAcl(sddl, await readAcl(temp))) {
    // icacls may merge separate explicit ACEs or regenerate inherited entries.
    // Ordinary DACLs are still expressible through Windows' SDDL API.
    await setOrdinaryAcl(temp, sddl);
    if (!equivalentAcl(sddl, await readAcl(temp))) throw aclError('Windows could not reproduce the original ACEs; inspect the parent inheritance settings');
  }
  await assertPermissionToken(source, token);
}
async function setOrdinaryAcl(file, sddl, directory = false) {
  parseAcl(sddl); // Never send conditional/object ACEs to this ordinary-ACL path.
  const kind = directory ? 'Directory' : 'File'; // Fixed API names, never source text.
  await execute(native('WindowsPowerShell\\v1.0\\powershell'), ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference="Stop"; $a=New-Object System.Security.AccessControl.${kind}Security; $a.SetSecurityDescriptorSddlForm($env:RS_ACL_SDDL,[System.Security.AccessControl.AccessControlSections]::Access); [IO.${kind}]::SetAccessControl($env:RS_ACL_PATH,$a)`],
  {windowsHide: true, env: {...process.env, RS_ACL_SDDL: sddl, RS_ACL_PATH: file}});
}

const aclError = reason => new Error(`无法保留目标权限（${reason}），已停止写入。请在 Windows 安全设置中将此文件的条件/对象权限改为普通允许/拒绝权限后重试，或手动安装。 / Cannot preserve target ACL (${reason}); writing stopped. Use Windows Security to replace conditional/object permissions with ordinary allow/deny entries, then retry, or install manually.`);
function maskValue(mask) {
  if (/^0x[0-9a-f]+$/i.test(mask)) return Number(mask) >>> 0;
  const values = {FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0, GA: 0x10000000, GX: 0x20000000, GW: 0x40000000, GR: 0x80000000,
    CC: 1, DC: 2, LC: 4, SW: 8, RP: 16, WP: 32, DT: 64, LO: 128, CR: 256, SD: 0x10000, RC: 0x20000, WD: 0x40000, WO: 0x80000};
  const parts = mask.match(/../g) ?? [];
  if (parts.join('') !== mask || parts.some(p => values[p] === undefined)) throw aclError(`unsupported rights ${mask}`);
  return parts.reduce((n, p) => (n | values[p]) >>> 0, 0);
}
function parseAcl(sddl) {
  const header = sddl?.match(/^D:([A-Z]*)/)?.[1];
  const entries = [...(sddl ?? '').matchAll(/\(([^()]*)\)/g)];
  if (header === undefined || sddl.slice(2 + header.length) !== entries.map(m => m[0]).join('')) throw aclError('conditional or malformed ACE');
  const aces = entries.map(m => m[1].split(';'));
  if (aces.some(a => a.length !== 6 || !['A', 'D'].includes(a[0]) || a[3] || a[4] || a[1].replace(/OI|CI|IO|NP|ID/g, '')))
    throw aclError('object/conditional ACE or unsupported inheritance flag');
  if (header.replace(/AI|AR|P/g, '')) throw aclError('unsupported DACL control flag');
  return {protected: header.includes('P'), control: header.replace(/AI/g, ''), aces};
}
export function equivalentAcl(a, b) {
  const left = parseAcl(a), right = parseAcl(b);
  // Preserve P/AR and every ACE flag. Ignore only AI bookkeeping and ACE order;
  // rights may have equivalent numeric or symbolic spellings in Windows output.
  const normalize = x => x.aces.map(([type, flags, mask, object, inherited, trustee]) =>
    [type, (flags.match(/../g) ?? []).sort().join(''), maskValue(mask), object, inherited, resolvedTrustees.get(trustee) ?? trustee].join(';')).sort();
  return left.control === right.control && JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
export const readAcl = file => savedAcl(file, text => {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length !== 2 || !lines[1]?.startsWith('D:')) throw aclError('invalid saved target DACL');
  return lines[1];
});

/** Read each target once, using one export per sibling group. Absent targets
 * have no DACL yet. Preview retains these strings; apply compares them once. */
export async function targetPermissions(files) {
  const result = new Map(), groups = new Map();
  result.tokens = new Map();
  if (process.platform !== 'win32') return result;
  for (const file of new Set(files.map(file => path.resolve(file)))) {
    const stat = await fs.lstat(file, {bigint: true}).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    result.tokens.set(file, stat ? permissionKey(stat) : null);
    if (!stat) { result.set(file, null); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular permission source: ${file}`);
    const dir = path.dirname(file); if (!groups.has(dir)) groups.set(dir, []); groups.get(dir).push(file);
  }
  for (const [dir, siblings] of groups) {
    if (siblings.length === 1) result.set(siblings[0], await readAcl(siblings[0]));
    else await savedAcl(path.join(dir, '*'), text => {
      const lines = text.trimEnd().split(/\r?\n/), wanted = new Set(siblings);
      for (let i = 0; i < lines.length; i += 2) {
        const file = path.resolve(dir, lines[i]);
        if (wanted.has(file)) result.set(file, lines[i + 1]);
      }
      if (siblings.some(file => !result.has(file))) throw aclError('a target changed during ACL inspection');
    });
  }
  for (const [file, sddl] of result) {
    if (sddl !== null) parseAcl(sddl);
    await assertPermissionToken(file, result.tokens.get(file));
  }
  return result;
}
const changedPermissions = file => new Error(`目标权限检查后文件发生变化，已停止写入，请重新预览 / File changed after permission inspection; writing stopped; preview again: ${file}`);
async function assertPermissionToken(file, token) {
  const stat = await fs.lstat(file, {bigint: true}).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if ((stat ? permissionKey(stat) : null) !== token) throw changedPermissions(file);
}
