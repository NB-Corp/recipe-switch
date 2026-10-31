// Permissions are established before any sensitive payload reaches a new inode.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const privateScope = fn => scope.getStore() ? fn() : scope.run(new Map(), fn);
// Cache only within one locked transaction. Directory entry churn is expected;
// file metadata changes and replacement inodes invalidate the remembered result.
const permissionKey = stat => `${stat.dev}:${stat.ino}:${stat.mode}${stat.isDirectory() ? '' : ':' + stat.ctimeNs}`;
const remembered = (file, stat, recursive) => {
  const saved = scope.getStore()?.get(path.resolve(file));
  return saved?.key === permissionKey(stat) && (!recursive || saved.recursive);
};
export async function rememberPrivate(file, recursive = false) {
  const stat = await fs.lstat(file, {bigint: true});
  scope.getStore()?.set(path.resolve(file), {key: permissionKey(stat), recursive});
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

// icacls /save uses UTF-16LE SDDL, independent of localized account names.
async function savedAcl(file, fn, recursive = false) {
  const scratch = path.join(path.dirname(file), `.recipe-switch-acl-${crypto.randomUUID()}.tmp`);
  try {
    await icacls([path.basename(file), '/save', scratch, ...(recursive ? ['/t'] : []), '/q'], path.dirname(file));
    const text = (await fs.readFile(scratch)).toString('utf16le').replace(/^\uFEFF/, '');
    return await fn(text, scratch);
  } finally { await fs.unlink(scratch).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const trustees = {WD: 'S-1-1-0', BU: 'S-1-5-32-545', AU: 'S-1-5-11', CO: 'S-1-3-0',
  CG: 'S-1-3-1', NU: 'S-1-5-2', IU: 'S-1-5-4', SU: 'S-1-5-6', AN: 'S-1-5-7',
  LS: 'S-1-5-19', NS: 'S-1-5-20', AC: 'S-1-15-2-1', RC: 'S-1-5-12'};
async function secureWindows(file, directory, recursive) {
  const sid = await userSid();
  await icacls([file, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)' : ''}F`, ...(recursive ? ['/t'] : []), '/q']);
  await savedAcl(file, async text => {
    const lines = text.trimEnd().split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 2) {
      const target = path.resolve(path.dirname(file), lines[i]);
      const relative = path.relative(file, target);
      if (target !== path.resolve(file) && (!directory || relative.startsWith('..') || path.isAbsolute(relative))) throw new Error('Invalid saved ACL path');
      const remove = new Set();
      for (const match of (lines[i + 1] ?? '').matchAll(/\(([^()]*)\)/g)) {
        const [type, , , , , trustee] = match[1].split(';');
        if (!['A', 'OA', 'XA', 'ZA'].includes(type)) continue; // Keep denies; remove other accounts' grants only.
        // Retain SYSTEM and Administrators for system maintenance and recovery.
        if ([sid, 'SY', 'BA', 'S-1-5-18', 'S-1-5-32-544'].includes(trustee)) continue;
        const principal = trustee?.startsWith('S-1-') ? trustee : trustees[trustee];
        if (!principal) throw new Error(`Unsupported ACL trustee: ${trustee}`); // Fail closed.
        remove.add('*' + principal);
      }
      if (remove.size) await icacls([target, '/remove:g', ...remove, '/q']);
    }
  }, recursive);
}

/** Secure existing storage too; never follow a linked subtree. */
export async function privateDirectory(dir, {recursive = true} = {}) {
  try {
    await fs.mkdir(dir, {recursive: true, mode: 0o700});
    const walk = async current => {
      const stat = await fs.lstat(current, {bigint: true});
      if (stat.isSymbolicLink()) throw new Error(`Linked private storage refused: ${current}`);
      if (remembered(current, stat, recursive)) return;
      if (process.platform === 'win32') await secureWindows(current, stat.isDirectory(), false);
      else await fs.chmod(current, stat.isDirectory() ? 0o700 : 0o600);
      if (recursive && stat.isDirectory()) for (const entry of await fs.readdir(current)) await walk(path.join(current, entry));
      await rememberPrivate(current, recursive);
    };
    await walk(dir);
  } catch (error) { throw new Error(`无法保护私有存储权限，拒绝写入 / Cannot secure private storage; refusing to write: ${dir}: ${error.message}`); }
  return dir;
}
export async function privateFile(file) {
  const stat = await fs.lstat(file, {bigint: true});
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular private file: ${file}`);
  if (remembered(file, stat, false)) return;
  if (process.platform === 'win32') await secureWindows(file, false, false);
  else await fs.chmod(file, 0o600);
  await rememberPrivate(file);
}

/** The temp is still empty. Preserve the existing target's DACL/mode before payload. */
export async function copyPermissions(source, temp, {privateWhenMissing = false} = {}) {
  const stat = await fs.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
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
  await savedAcl(source, async text => {
    const lines = text.trimEnd().split(/\r?\n/), sddl = lines[1];
    if (lines.length !== 2 || !sddl?.startsWith('D:')) throw new Error('Invalid saved target ACL');
    const aces = [...sddl.matchAll(/\(([^()]*)\)/g)].map(match => match[1].split(';'));
    if (!aces.length || aces.some(([type, flags, , object, inherited]) => !['A', 'D'].includes(type) || object || inherited || flags.replace(/OI|CI|IO|NP|ID/g, '')))
      throw new Error('Unsupported target ACL; refusing to write');
    // /restore requires SeRestorePrivilege on some Windows installations. Copy
    // ordinary DACL grants/denies with icacls instead, then verify exact SDDL.
    await icacls([temp, sddl.slice(2).split('(')[0].includes('P') ? '/inheritance:r' : '/inheritance:e', '/q']);
    const bits = [[0x10000000, 'GA'], [0x20000000, 'GE'], [0x40000000, 'GW'], [0x80000000, 'GR'],
      [1, 'RD'], [2, 'WD'], [4, 'AD'], [8, 'REA'], [16, 'WEA'], [32, 'X'], [64, 'DC'], [128, 'RA'], [256, 'WA'],
      [0x10000, 'DE'], [0x20000, 'RC'], [0x40000, 'WDAC'], [0x80000, 'WO'], [0x100000, 'S'], [0x1000000, 'AS'], [0x2000000, 'MA']];
    for (const [type, flags, mask, , , trustee] of aces) {
      if (flags.includes('ID')) continue; // Same parent supplies the same inherited ACEs.
      const principal = trustee.startsWith('S-1-') ? trustee : ({SY: 'S-1-5-18', BA: 'S-1-5-32-544', ...trustees})[trustee];
      if (!principal) throw new Error(`Unsupported target ACL trustee: ${trustee}`);
      let rights;
      if (/^0x[0-9a-f]+$/i.test(mask)) {
        let remaining = Number(mask); rights = [];
        for (const [bit, name] of bits) if ((remaining & bit) !== 0) { rights.push(name); remaining = (remaining & ~bit) >>> 0; }
        if (remaining || !rights.length) throw new Error('Unsupported target ACL mask');
      } else {
        const names = {FA: 'F', FR: 'R', FW: 'W', FX: 'RX', GA: 'GA', GR: 'GR', GW: 'GW', GX: 'GE'};
        rights = [names[mask]];
        if (!rights[0]) throw new Error('Unsupported target ACL rights');
      }
      const inheritance = (flags.match(/OI|CI|IO|NP/g) ?? []).map(flag => `(${flag})`).join('');
      await icacls([temp, type === 'D' ? '/deny' : '/grant', `*${principal}:${inheritance}(${rights.join(',')})`, '/q']);
    }
    await savedAcl(temp, async actual => {
      if (actual.trimEnd().split(/\r?\n/)[1] !== sddl) throw new Error('Target ACL could not be copied exactly; refusing to write');
    });
  });
}
