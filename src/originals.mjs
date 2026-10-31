// Immutable first-touch references; existing-file bytes are shared by content hash.
import fs from 'node:fs/promises';
import path from 'node:path';
import {readFile, writeFile, sha256, assertBoundary, captureBoundary, toPosix} from './fsx.mjs';
import {privateDirectory} from './private-storage.mjs';

export function originalManifestPath(store, harness, home) {
  if (!/^[a-z0-9-]+$/.test(harness)) throw new Error('Invalid harness id');
  const scope = sha256(Buffer.from(toPosix(path.resolve(home)).toLowerCase())).slice(0, 20);
  return path.join(store.home, 'originals', harness, scope, 'manifest.json');
}
export async function readOriginals(store, harness, home) {
  const file = originalManifestPath(store, harness, home);
  await assertBoundary(file, await captureBoundary(store.home));
  const bytes = await readFile(file);
  if (bytes === null) return null;
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== 1 || value.harness !== harness || path.resolve(value.home).toLowerCase() !== path.resolve(home).toLowerCase() || !Array.isArray(value.files))
    throw new Error(`Invalid original snapshot manifest: ${toPosix(file)}`);
  return {...value, manifest: toPosix(file)};
}
export async function originalBytes(store, entry) {
  if (!entry.existed) return null;
  if (!/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('Invalid original snapshot hash');
  const file = path.join(store.home, 'blobs', entry.hash);
  await assertBoundary(file, await captureBoundary(store.home));
  const bytes = await readFile(file);
  if (bytes === null || bytes.length !== entry.size || sha256(bytes) !== entry.hash)
    throw new Error(`Original snapshot is missing or corrupt: ${entry.path}`);
  return bytes;
}
export async function putBlob(store, bytes) {
  const hash = sha256(bytes), dir = path.join(store.home, 'blobs'), file = path.join(dir, hash);
  await assertBoundary(file, await captureBoundary(store.home));
  await privateDirectory(dir);
  if (process.platform !== 'win32' && await readFile(file) !== null) await fs.chmod(file, 0o600);
  if (await readFile(file) === null) await writeFile(file, bytes, {expected: null, durable: true, mode: 0o600, privateRoot: store.home});
  else await originalBytes(store, {existed: true, hash, size: bytes.length, path: toPosix(file)});
  return hash;
}

/** Blobs are durable before target writes. The manifest is staged in the journal. */
export async function prepareOriginals(store, harness, home, candidates) {
  const existing = await readOriginals(store, harness, home), now = new Date().toISOString();
  const value = existing ? {...existing, files: [...existing.files]} : {schema: 1, harness, home: toPosix(path.resolve(home)), capturedAt: now, files: []};
  delete value.manifest;
  let changed = false;
  for (const candidate of candidates) {
    const file = toPosix(path.resolve(candidate.path));
    if (value.files.some(row => row.path === file)) continue;
    const bytes = candidate.bytes;
    await assertBoundary(candidate.path, candidate.boundary ?? home);
    const stat = await fs.stat(candidate.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    value.files.push({path: file, boundary: candidate.boundary, existed: bytes !== null,
      hash: bytes === null ? null : await putBlob(store, bytes), size: bytes?.length ?? 0,
      mtime: bytes === null || candidate.source ? null : stat?.mtime.toISOString() ?? null, capturedAt: now,
      ...(candidate.source ? {source: candidate.source} : {}),
      ...(candidate.reconstructed ? {reconstructed: true, reason: candidate.reason} : {})});
    changed = true;
  }
  return changed ? {path: originalManifestPath(store, harness, home), value} : null;
}
export async function publishOriginals(store, staged) {
  if (!staged) return;
  await assertBoundary(staged.path, await captureBoundary(store.home));
  await writeFile(staged.path, staged.value === null ? null : Buffer.from(JSON.stringify(staged.value, null, 2) + '\n'), {durable: true, privateRoot: store.home});
}

/** Called only after restore-original committed and removed the target's stack. */
export async function collectOrphanBlobs(store) {
  const referenced = new Set(), root = path.join(store.home, 'originals'), boundary = await captureBoundary(store.home);
  async function walk(dir) {
    await assertBoundary(dir, boundary);
    const entries = await fs.readdir(dir, {withFileTypes: true}).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked original snapshot directory refused');
      if (entry.isDirectory()) await walk(file);
      else if (entry.name === 'manifest.json') {
        const manifest = JSON.parse((await readFile(file)).toString('utf8'));
        if (manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid original manifest; blob cleanup stopped');
        for (const row of manifest.files) if (row.existed) referenced.add(row.hash);
      }
    }
  }
  await walk(root);
  const backups = path.join(store.home, 'backups');
  for (const entry of await fs.readdir(backups, {withFileTypes: true}).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(backups, entry.name, 'index.json'); await assertBoundary(file, boundary);
    const bytes = await readFile(file);
    if (bytes !== null) for (const row of JSON.parse(bytes.toString('utf8'))) {
      if (row.blob) referenced.add(row.blob.hash);
      for (const version of row.laterVersions ?? []) referenced.add(version.hash);
    }
  }
  const dir = path.join(store.home, 'blobs'); await assertBoundary(dir, boundary);
  const entries = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of entries) if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) {
    const file = path.join(dir, name); await assertBoundary(file, boundary);
    await readFile(file); await fs.unlink(file);
  }
}
