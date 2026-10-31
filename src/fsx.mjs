// Small filesystem helpers: exact bytes, atomic replace, hashing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {note, format, messageError} from './i18n.mjs';
import {privateDirectory, privateFile, copyPermissions, privateScope, rememberPrivate, rememberPrivateParent} from './private-storage.mjs';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex');

export function equalBytes(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return b !== null && b !== undefined && Buffer.from(a).equals(Buffer.from(b));
}

/** Read a regular file; null when absent. Refuses symlinks and directories. */
export async function readFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

/** Resolve even an absent path through its nearest existing ancestor. */
async function canonical(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}

/** Freeze the chosen root so replacing the home itself cannot authorize a redirect. */
export async function captureBoundary(boundary) {
  if (typeof boundary === 'object') return boundary;
  const root = path.resolve(boundary);
  return {path: root, real: await canonical(root)};
}

/** R05/R06: both lexical and canonical paths must stay in the chosen boundary. */
export async function assertBoundary(file, boundary) {
  const root = path.resolve(typeof boundary === 'object' ? boundary.path : boundary), target = path.resolve(file);
  const real = await canonical(root);
  if (typeof boundary === 'object' && boundary.real !== real || !isInside(root, target) || !isInside(real, await canonical(target)))
    throw new Error(`Path escapes boundary ${toPosix(root)}: ${toPosix(target)}`);
}

const statToken = stat => stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
async function checkedBytes(file) {
  const stat = () => fs.lstat(file, {bigint: true}).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const before = await stat(), bytes = await readFile(file), after = await stat();
  if (statToken(before) !== statToken(after)) throw new Error(`Changed during operation: ${toPosix(file)}`);
  return bytes;
}

const unsupportedLink = error => ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EINVAL'].includes(error.code);

/** R23: only a hardlink publishes a complete file atomically without replacing. */
export async function publishExclusive(source, file) { await fs.link(source, file); }

export const inodeIdentity = stat => stat ? {dev: String(stat.dev), ino: String(stat.ino)} : null;
export async function pathIdentity(file) {
  const stat = await fs.lstat(file, {bigint: true}).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return stat?.isSymbolicLink() ? null : inodeIdentity(stat);
}
export const sameIdentity = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
export const replacedWarning = file => note('safety.pathReplaced', {path: toPosix(file)});
export async function removeIdentified(file, identity, {directory = false, boundary, warn = message => process.emitWarning(typeof message === 'string' ? message : format(message))} = {}) {
  const stat = await fs.lstat(file, {bigint: true}).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (stat.isSymbolicLink() || !sameIdentity(inodeIdentity(stat), identity)) { warn(replacedWarning(file)); return; }
  if (boundary) try { await assertBoundary(file, boundary); } catch { warn(replacedWarning(file)); return; }
  if (directory) await rmdirIfEmpty(file); else await fs.unlink(file);
  await rememberPrivateParent(file);
}
const activeProbes = new Set();
const PROBE_CONTENT = Buffer.from('recipe-switch hardlink probe v1\n');
async function cleanProbe(record, warn) {
  if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error('Invalid safety probe id');
  let complete = true;
  const source = path.join(path.dirname(record.target), `.recipe-switch-probe-${record.id}.tmp`);
  for (const [file, identity, expected] of [[record.link, record.linkIdentity, source + '.link'], [record.probe, record.probeIdentity, source]]) {
    if (file !== expected || path.resolve(file) !== file) { warn(replacedWarning(file)); complete = false; continue; }
    if (identity) await removeIdentified(file, identity, {warn, boundary: record.boundary});
    else if (await exists(file)) {
      // A crash may happen after creating the marker but before recording its inode.
      // An unregistered path needs both this probe's UUID and the fixed payload.
      try {
        await assertBoundary(file, record.boundary);
        const found = await pathIdentity(file);
        if (!found || !equalBytes(await readFile(file), PROBE_CONTENT)) throw new Error('Unknown probe content');
        await removeIdentified(file, found, {warn, boundary: record.boundary});
      } catch { warn(replacedWarning(file)); complete = false; }
    }
  }
  for (const item of [...record.createdDirs].reverse()) {
    if (item.identity) await removeIdentified(item.path, item.identity, {directory: true, warn, boundary: item.boundary ?? record.boundary});
    else if (item.newlyCreated && await exists(item.path)) {
      try {
        if (path.resolve(item.path) !== item.path || !isInside(item.path, path.dirname(record.target))) throw new Error('Invalid probe directory');
        await assertBoundary(item.path, item.boundary ?? record.boundary);
        const stat = await fs.lstat(item.path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Replaced probe directory');
        // Never remove contents or a nonempty directory, even without an identity.
        if (!await rmdirIfEmpty(item.path)) complete = false;
      } catch { warn(replacedWarning(item.path)); complete = false; }
    }
  }
  return complete;
}
export async function recoverProbes(stateDir, warn = message => process.emitWarning(typeof message === 'string' ? message : format(message))) {
  return withLock(stateDir, () => recoverProbeRecords(stateDir, warn), 'probe.lock');
}
async function recoverProbeRecords(stateDir, warn) {
  const root = path.join(stateDir, 'probes'), boundary = await captureBoundary(stateDir);
  await assertBoundary(root, boundary);
  for (const name of await fs.readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const file = path.join(root, name); await assertBoundary(file, boundary);
    const record = JSON.parse(await readFile(file));
    if (activeProbes.has(record.id)) continue;
    if (record.pid !== process.pid) {
      try { process.kill(record.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
    }
    if (name !== record.id + '.json') { warn(replacedWarning(file)); continue; }
    if (await cleanProbe(record, warn)) await writeFile(file, null, {durable: true});
    else warn(note('safety.probeCleanupPending', {path: toPosix(file)}));
  }
  await rmdirIfEmpty(root);
}

/** R25: publish a durable cleanup record before touching the target directory. */
export async function probeHardlinks(file, boundary, stateDir) {
  if (!stateDir) throw new Error('A state directory is required for a recoverable safety probe');
  return withLock(stateDir, () => runHardlinkProbe(file, boundary, stateDir), 'probe.lock');
}
async function runHardlinkProbe(file, boundary, stateDir) {
  boundary = await captureBoundary(boundary ?? path.dirname(file));
  await assertBoundary(file, boundary);
  const dir = path.dirname(file), id = crypto.randomUUID(), source = path.join(dir, `.recipe-switch-probe-${id}.tmp`);
  const journal = path.join(stateDir, 'probes', id + '.json'), missing = [];
  let cursor = dir;
  while (!await exists(cursor)) { missing.unshift(cursor); cursor = path.dirname(cursor); }
  const creationBoundary = await captureBoundary(cursor);
  const record = {id, pid: process.pid, target: file, boundary, probe: source, link: source + '.link',
    createdDirs: missing.map(path => ({path, boundary: creationBoundary, identity: null}))};
  const save = () => writeFile(journal, Buffer.from(JSON.stringify(record)), {durable: true, privateRoot: stateDir});
  let linking = false;
  activeProbes.add(id);
  try {
    await save();
    for (const item of record.createdDirs) {
      await assertBoundary(item.path, item.boundary);
      item.newlyCreated = true; await save(); // Creation intent is durable before mkdir.
      try { await fs.mkdir(item.path); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        item.newlyCreated = false; await save(); continue;
      }
      item.identity = inodeIdentity(await fs.stat(item.path, {bigint: true})); await save();
    }
    await assertBoundary(source, boundary);
    await fs.writeFile(source, PROBE_CONTENT, {flag: 'wx', mode: 0o600});
    const handle = await fs.open(source, 'r+');
    try {
      record.probeIdentity = inodeIdentity(await handle.stat({bigint: true}));
      record.linkIdentity = record.probeIdentity; await save(); await handle.sync();
    } finally { await handle.close(); }
    linking = true; await fs.link(source, record.link);
    return null;
  } catch (error) {
    return {id: linking && unsupportedLink(error) ? 'safety.hardlinksUnsupported' : 'safety.probeFailed',
      vars: {path: toPosix(dir), error: error.code ?? error.message}};
  } finally {
    try {
      if (await cleanProbe(record, message => process.emitWarning(typeof message === 'string' ? message : format(message)))) await writeFile(journal, null, {durable: true});
      await rmdirIfEmpty(path.dirname(journal));
    }
    finally { activeProbes.delete(id); }
  }
}

/** Restore without replacing a newer destination. Transactions retain the inode. */
export async function restoreDisplaced(file, displaced, boundary, {sourceBoundary = boundary, identity} = {}) {
  if (boundary) await assertBoundary(file, boundary);
  if (sourceBoundary) await assertBoundary(displaced, sourceBoundary);
  if (identity && !sameIdentity(await pathIdentity(displaced), identity)) throw messageError(replacedWarning(displaced));
  const collision = () => new Error(`Changed during operation; newer file kept at ${toPosix(file)}; displaced version kept at ${toPosix(displaced)}`);
  try { await publishExclusive(displaced, file); }
  catch (error) {
    if (error.code === 'EEXIST') throw collision();
    if (!unsupportedLink(error)) throw error;
    // Rare capability loss after preview: guarded rename, not an atomic noreplace.
    // The accepted boundary excludes a target recreated between this check and rename.
    if (await exists(file)) throw collision();
    await fs.rename(displaced, file);
    return;
  }
  await fs.unlink(displaced);
}

/** Flush directory metadata after publishing a name. */
async function syncDirectory(dir) {
  let handle;
  try { handle = await fs.open(dir, 'r'); await handle.sync(); }
  catch (error) { if (!['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

/** Conditional writes verify the inode actually displaced, then publish exclusively. */
export async function writeFile(file, bytes, options = {}) {
  const {boundary, retainDisplaced = false, onStage = async () => {}} = options;
  if (boundary) await assertBoundary(file, boundary);
  if (options.privateRoot) {
    await assertBoundary(file, await captureBoundary(options.privateRoot));
    await privateDirectory(options.privateRoot, {recursive: false});
    if (bytes !== null) await privateDirectory(path.dirname(file), {recursive: false});
    if (await exists(file)) await privateFile(file);
  }
  const created = bytes === null ? [] : await mkdirp(path.dirname(file));
  const temp = options.temp ?? `${file}.recipe-switch-${process.pid}-${crypto.randomUUID()}.tmp`;
  const displaced = options.displaced ?? `${file}.recipe-switch-${crypto.randomUUID()}.displaced`;
  let ownTemp = null, moved = false, published = false, displacedIdentity = null, privateCommitted = false;
  try {
    if (boundary) await assertBoundary(temp, boundary);
    if (bytes !== null) {
      const handle = await fs.open(temp, 'wx', options.mode ?? (options.privateRoot ? 0o600 : 0o666));
      try {
        ownTemp = inodeIdentity(await handle.stat({bigint: true}));
        // Fresh inode in the audited private parent: no explicit grants exist.
        // Remember before callbacks so an ACL edit there invalidates this token.
        if (options.privateRoot) { await rememberPrivate(temp); await rememberPrivateParent(temp); }
        await onStage('temp-created', {tempIdentity: ownTemp});
        // R28/R32: ACL commands operate on names, but payload uses this handle.
        // Refuse a swapped path both before and after setting its permissions.
        if (!sameIdentity(await pathIdentity(temp), ownTemp)) throw messageError(replacedWarning(temp));
        if (options.privateRoot) await privateFile(temp);
        else await copyPermissions(file, temp, options);
        if (!sameIdentity(await pathIdentity(temp), ownTemp)) throw messageError(replacedWarning(temp));
        await handle.writeFile(bytes);
        if (options.durable) await handle.sync();
      } finally { await handle.close(); }
    }
    if (boundary) await assertBoundary(file, boundary);
    if ('expected' in options) {
      if (!equalBytes(await checkedBytes(file), options.expected))
        throw new Error(`Changed during operation; stopped before writing ${toPosix(file)}`);
      if (boundary) await assertBoundary(displaced, boundary);
      displacedIdentity = await pathIdentity(file);
      await onStage('displacing', {displacedIdentity}); // identity is durable before rename-away.
      try { await fs.rename(file, displaced); moved = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (moved) {
        displacedIdentity = await pathIdentity(displaced);
        await onStage('displaced', {displacedIdentity});
      }
      const actual = moved ? await checkedBytes(displaced) : null;
      if (!equalBytes(actual, options.expected))
        throw new Error(`Changed during operation; displaced version differs from preview: ${toPosix(file)}`);
      await onStage('publishing');
      if (bytes !== null) {
        if (!sameIdentity(await pathIdentity(temp), ownTemp)) throw messageError(replacedWarning(temp));
        await publishExclusive(temp, file);
      }
      published = true;
      await onStage('published');
      // R01: retain the actual inode, including later writes through open handles.
      if (moved && !retainDisplaced) await fs.unlink(displaced);
      moved = false;
    } else if (bytes === null) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else await fs.rename(temp, file);
    privateCommitted = Boolean(options.privateRoot);
    if (options.durable) await syncDirectory(path.dirname(file));
  } catch (error) {
    if (moved) {
      try {
        await restoreDisplaced(file, displaced, boundary, {identity: displacedIdentity}); moved = false;
        await onStage('restored');
      } catch (recovery) { throw new Error(`${error.message}\n${recovery.message}`); }
    } else if (!published) await onStage('untouched');
    for (const dir of [...created].reverse()) await rmdirIfEmpty(dir);
    throw error;
  } finally {
    if (ownTemp) await removeIdentified(temp, ownTemp, {warn: options.warn});
    if (options.privateRoot) {
      if (privateCommitted && bytes !== null) await rememberPrivate(file);
      await rememberPrivateParent(file);
    }
  }
  return created;
}

/** R02: cross-process lock; a dead owner's lock is reclaimable, never a live one. */
export async function withLock(home, fn, name = 'transaction.lock') {
  await privateDirectory(home, {recursive: false});
  const lock = path.join(home, name), token = crypto.randomUUID(), started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      try { await handle.writeFile(JSON.stringify({pid: process.pid, token})); } finally { await handle.close(); }
      await rememberPrivate(lock); await rememberPrivateParent(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner, stat, raw;
      try {
        stat = await fs.stat(lock, {bigint: true});
        raw = await fs.readFile(lock, 'utf8');
        if (statToken(stat) !== statToken(await fs.stat(lock, {bigint: true}))) continue;
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { owner = JSON.parse(raw); } catch {}
      let dead = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      } else dead = Date.now() - Number(stat.mtimeMs) > 30000;
      if (dead) {
        // Serialize stale reclaimers so one cannot delete a new owner's lock
        // after another has already reclaimed the stale inode.
        const reaper = lock + '.reap';
        let claimed = false;
        try { await fs.mkdir(reaper); claimed = true; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const age = await fs.stat(reaper).then(stat => Date.now() - stat.mtimeMs, () => 0);
          if (age > 30000) await fs.rmdir(reaper).catch(() => {});
        }
        if (claimed) try {
          const currentStat = await fs.stat(lock, {bigint: true}).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          const current = await fs.readFile(lock, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (current === raw && statToken(currentStat) === statToken(stat))
            await fs.unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
        } finally { await fs.rmdir(reaper); }
        await new Promise(resolve => setTimeout(resolve, 15));
        continue;
      }
      if (Date.now() - started > 30000) throw new Error(`Timed out waiting for transaction lock: ${toPosix(lock)}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  try { return await privateScope(async () => { if (name === 'transaction.lock') await privateDirectory(home); return fn(); }); }
  finally {
    const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (owner.token === token) { await fs.unlink(lock); await rememberPrivateParent(lock); }
  }
}

/** mkdir -p that reports which directories it actually created (outermost first). */
export async function mkdirp(dir) {
  const missing = [];
  let cursor = path.resolve(dir);
  while (!(await exists(cursor))) {
    missing.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const item of missing) await fs.mkdir(item).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return missing;
}

/** Remove a directory only when empty; ignore when it is absent or not empty. */
export async function rmdirIfEmpty(dir) {
  try { await fs.rmdir(dir); return true; }
  catch (error) { if (['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) return false; throw error; }
}

/** All regular files below dir as relative POSIX paths, sorted. */
export async function listFiles(dir) {
  const out = [];
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, {withFileTypes: true})) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Linked source refused: ${toPosix(path.join(current, entry.name))}`);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  if (await exists(dir)) await walk(dir, '');
  return out.sort();
}

export const toPosix = value => value.replaceAll('\\', '/');

/** Home-relative display form; middle-ellipsized when longer than max. */
export function displayPath(value, {max = 48, env = process.env} = {}) {
  let p = toPosix(String(value ?? ''));
  const rawHome = env.RECIPE_SWITCH_USER_HOME || (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const home = toPosix(path.resolve(rawHome));
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  if (p.length > max) {
    const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
    p = p.slice(0, head) + '…' + p.slice(p.length - tail);
  }
  return p;
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function decode(bytes) {
  return bytes === null ? '' : new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
}
