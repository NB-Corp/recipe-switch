// Small filesystem helpers: exact bytes, atomic replace, hashing.
import fs from 'node:fs/promises';
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

/** Atomic replacement, optionally conditional on the exact verified/backup bytes. */
export async function writeFile(file, bytes, options = {}) {
  const {boundary} = options;
  if (boundary) await assertBoundary(file, boundary);
  const created = bytes === null ? [] : await mkdirp(path.dirname(file));
  const temp = `${file}.recipe-switch-${process.pid}-${crypto.randomUUID()}.tmp`;
  let ownTemp = false;
  try {
    if (boundary) await assertBoundary(temp, boundary);
    if (bytes !== null) { await fs.writeFile(temp, bytes, {flag: 'wx'}); ownTemp = true; }
    if (boundary) await assertBoundary(file, boundary);
    if ('expected' in options && !equalBytes(await checkedBytes(file), options.expected))
      throw new Error(`Changed during operation; stopped before writing ${toPosix(file)}`);
    if (bytes === null) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else await fs.rename(temp, file);
  } catch (error) {
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
      let owner, stat;
      try { owner = JSON.parse(await fs.readFile(lock, 'utf8')); } catch {}
      try { stat = await fs.stat(lock); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let dead = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      } else dead = Date.now() - stat.mtimeMs > 30000;
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
          const current = await fs.readFile(lock, 'utf8').catch(() => null);
          if (current !== null && (owner ? current === JSON.stringify(owner) : Date.now() - stat.mtimeMs > 30000))
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

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function decode(bytes) {
  return bytes === null ? '' : new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
}
