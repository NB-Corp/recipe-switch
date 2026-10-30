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

/** Write via temp file + rename; null removes the file. Returns created directories. */
export async function writeFile(file, bytes) {
  if (bytes === null) {
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return [];
  }
  const created = await mkdirp(path.dirname(file));
  const temp = `${file}.recipe-switch-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, bytes, {flag: 'wx'});
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return created;
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
