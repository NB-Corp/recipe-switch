// Small filesystem helpers: exact bytes, atomic replace, hashing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

/** Preview probes the actual destination directory and leaves no persistent files. */
export async function probeHardlinks(file, boundary) {
  if (boundary) await assertBoundary(file, boundary);
  const dir = path.dirname(file), created = await mkdirp(dir), id = crypto.randomUUID();
  const source = path.join(dir, `.recipe-switch-probe-${id}.tmp`), linked = source + '.link';
  let ownSource = false, ownLink = false;
  try {
    if (boundary) await assertBoundary(source, boundary);
    await fs.writeFile(source, Buffer.alloc(0), {flag: 'wx'}); ownSource = true;
    await fs.link(source, linked); ownLink = true;
    return null;
  } catch (error) {
    const reason = unsupportedLink(error)
      ? '该位置的文件系统不支持硬链接（常见于 FAT/exFAT/部分网络盘），recipe-switch 无法保证安全写入。This location’s filesystem does not support hard links (common on FAT/exFAT and some network drives); recipe-switch cannot guarantee safe writes.'
      : '无法完成硬链接安全探测；请检查目录访问权限。Could not complete the hard-link safety probe; check directory access permissions.';
    return `${reason} ${toPosix(dir)} (${error.code ?? error.message})`;
  } finally {
    if (ownLink) await fs.unlink(linked);
    if (ownSource) await fs.unlink(source);
    for (const item of created.reverse()) await rmdirIfEmpty(item);
  }
}

/** Restore without replacing a newer destination. Transactions retain the inode. */
export async function restoreDisplaced(file, displaced, boundary, {sourceBoundary = boundary} = {}) {
  if (boundary) await assertBoundary(file, boundary);
  if (sourceBoundary) await assertBoundary(displaced, sourceBoundary);
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

/** Flush a file before publishing its name (journals must precede target moves). */
async function syncFile(file) {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
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
  const created = bytes === null ? [] : await mkdirp(path.dirname(file));
  const temp = options.temp ?? `${file}.recipe-switch-${process.pid}-${crypto.randomUUID()}.tmp`;
  const displaced = options.displaced ?? `${file}.recipe-switch-${crypto.randomUUID()}.displaced`;
  let ownTemp = false, moved = false, published = false;
  try {
    if (boundary) await assertBoundary(temp, boundary);
    if (bytes !== null) {
      await fs.writeFile(temp, bytes, {flag: 'wx'}); ownTemp = true;
      if (options.durable) await syncFile(temp);
    }
    if (boundary) await assertBoundary(file, boundary);
    if ('expected' in options) {
      if (!equalBytes(await checkedBytes(file), options.expected))
        throw new Error(`Changed during operation; stopped before writing ${toPosix(file)}`);
      if (boundary) await assertBoundary(displaced, boundary);
      await onStage('displacing'); // temp/displaced paths are durable before rename-away.
      try { await fs.rename(file, displaced); moved = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const actual = moved ? await checkedBytes(displaced) : null;
      if (!equalBytes(actual, options.expected))
        throw new Error(`Changed during operation; displaced version differs from preview: ${toPosix(file)}`);
      await onStage('publishing');
      if (bytes !== null) await publishExclusive(temp, file);
      published = true;
      await onStage('published');
      // R01: retain the actual inode, including later writes through open handles.
      if (moved && !retainDisplaced) await fs.unlink(displaced);
      moved = false;
    } else if (bytes === null) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else await fs.rename(temp, file);
    if (options.durable) await syncDirectory(path.dirname(file));
  } catch (error) {
    if (moved) {
      try {
        await restoreDisplaced(file, displaced, boundary, {retain: retainDisplaced}); moved = false;
        await onStage('restored');
      } catch (recovery) { throw new Error(`${error.message}\n${recovery.message}`); }
    } else if (!published) await onStage('untouched');
    for (const dir of [...created].reverse()) await rmdirIfEmpty(dir);
    throw error;
  } finally {
    if (ownTemp) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return created;
}

/** R02: cross-process lock; a dead owner's lock is reclaimable, never a live one. */
export async function withLock(home, fn) {
  await mkdirp(home);
  const lock = path.join(home, 'transaction.lock'), token = crypto.randomUUID(), started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      try { await handle.writeFile(JSON.stringify({pid: process.pid, token})); } finally { await handle.close(); }
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
  try { return await fn(); }
  finally {
    const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (owner.token === token) await fs.unlink(lock);
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
