// Retain only the newest displaced inode per target; older bytes live in backups/blobs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {readFile, writeFile, sha256, assertBoundary, captureBoundary, toPosix, pathIdentity, sameIdentity, removeIdentified, replacedWarning} from './fsx.mjs';
import {putBlob} from './originals.mjs';

const targetPaths = paths => new Set(paths.map(file => toPosix(path.resolve(file))));

// Stage reference retirement in the same state commit as the new versions.
// Disk cleanup happens only after that commit, replayed from the pending journal.
export function releaseCarrierReferences(state, paths) {
  const targets = targetPaths(paths);
  state.replacedVersions = (state.replacedVersions ?? []).map(group => ({...group,
    files: group.files.filter(record => !targets.has(record.path))})).filter(group => group.files.length);
  for (const target of Object.values(state.targets)) for (const op of target.stack ?? [])
    for (const record of op.replacedVersions ?? []) if (targets.has(record.path) && record.saved) {
      record.saved = null; record.releasedAt = new Date().toISOString();
    }
}

export async function retireCarriers(store, paths, keepBackup, {onlyBackup} = {}) {
  const targets = targetPaths(paths);
  const root = path.join(store.home, 'backups'), boundary = await captureBoundary(store.home);
  const dirs = await fs.readdir(root, {withFileTypes: true}).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const dir of dirs) {
    if (!dir.isDirectory() || keepBackup && path.resolve(root, dir.name) === path.resolve(keepBackup)
      || onlyBackup && path.resolve(root, dir.name) !== path.resolve(onlyBackup)) continue;
    const indexFile = path.join(root, dir.name, 'index.json');
    await assertBoundary(indexFile, boundary);
    const bytes = await readFile(indexFile);
    if (bytes === null) continue;
    const index = JSON.parse(bytes.toString('utf8'));
    for (const entry of index) {
      if (!targets.has(entry.path)) continue;
      for (const saved of [...entry.replacedVersions ?? []]) {
        // Archive paths stay inside state; EXDEV carriers stay beside their target.
        const carrierBoundary = saved.startsWith(toPosix(root) + '/') ? boundary : await captureBoundary(path.dirname(entry.path));
        const expectedIdentity = entry.carrierIdentities?.[saved], actualIdentity = await pathIdentity(saved);
        const replaced = await fs.lstat(saved).then(() => !sameIdentity(actualIdentity, expectedIdentity), error => { if (error.code === 'ENOENT') return false; throw error; });
        if (replaced) store.warn(replacedWarning(saved));
        else await assertBoundary(saved, carrierBoundary);
        const current = replaced ? null : await readFile(saved);
        if (current !== null && sha256(current) !== (entry.carrierHashes?.[saved] ?? entry.sha256)) {
          const hash = await putBlob(store, current);
          // A retry after a crash must not register the same captured bytes twice.
          if (!(entry.laterVersions ?? []).some(version => version.hash === hash && version.source === saved))
            (entry.laterVersions ??= []).push({hash, size: current.length, capturedAt: new Date().toISOString(),
              label: '后来写入的版本 / Later-written version', source: saved});
          // Durable blob reference precedes unlink, even if cleanup is interrupted.
          await writeFile(indexFile, Buffer.from(JSON.stringify(index, null, 2) + '\n'), {durable: true, privateRoot: store.home});
        }
        // This single read is the retention cutoff. No promise for later old-handle writes.
        if (current !== null) await removeIdentified(saved, expectedIdentity, {warn: message => store.warn(message)});
        entry.replacedVersions = entry.replacedVersions.filter(file => file !== saved);
        delete entry.carrierHashes?.[saved]; delete entry.carrierIdentities?.[saved];
        await writeFile(indexFile, Buffer.from(JSON.stringify(index, null, 2) + '\n'), {durable: true, privateRoot: store.home});
      }
    }
  }
}
