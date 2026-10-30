// Reversible transactions: exact source snapshots, conditional file writes,
// serialized state commits and a durable compensation journal.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readFile, writeFile, restoreDisplaced, rmdirIfEmpty, equalBytes, toPosix, sha256, assertBoundary, captureBoundary, withLock, exists, probeHardlinks} from './fsx.mjs';
import {inspect, inspectBytes, fingerprintOf, render, recordLayout, identity, ABSENT} from './units.mjs';
import {unifiedDiff} from './diff.mjs';
import {prepareOriginals, publishOriginals, readOriginals, originalBytes, collectOrphanBlobs, originalManifestPath, putBlob, RECONSTRUCTED_WARNING} from './originals.mjs';
import {privateDirectory} from './private-storage.mjs';
import {releaseCarrierReferences, retireCarriers, RETENTION_LIMIT} from './retained.mjs';

export const MARK = 'managed by recipe-switch';
export const stateHome = (env = process.env) => path.resolve(env.RECIPE_SWITCH_HOME || path.join(os.homedir(), '.recipe-switch'));
const enc = bytes => bytes == null ? null : Buffer.from(bytes).toString('base64');
const dec = value => value == null ? null : Buffer.from(value, 'base64');
const stateBytes = state => Buffer.from(JSON.stringify(state, null, 2) + '\n');
function serialize(unit) {
  const out = {...unit};
  for (const key of ['beforeBytes', 'afterBytes']) if (key in out) out[key] = enc(out[key]);
  return out;
}
function deserialize(unit) {
  const out = {...unit};
  for (const key of ['beforeBytes', 'afterBytes']) if (key in out) out[key] = dec(out[key]);
  return out;
}

function transactionPaths(file, id, i, backup) {
  const prefix = `${file}.recipe-switch-${id}-${i}`;
  return {temp: prefix + '.tmp', displaced: prefix + '.displaced', archive: path.join(backup, `${i}-displaced-${path.basename(file)}`),
    phase: 'planned', recovery: {temp: prefix + '-undo.tmp', displaced: prefix + '-undo.displaced',
      archive: path.join(backup, `${i}-compensated-${path.basename(file)}`), phase: 'planned'}};
}
async function carrierOf(row, journal) {
  for (const file of [row.displaced, row.archive]) if (file && await exists(file)) {
    const boundary = file === row.archive ? journal.backupBoundary : row.boundary;
    await assertBoundary(file, boundary);
    return {file, boundary, bytes: await readFile(file)};
  }
  return null;
}
async function archiveDisplaced(store, journal, row, artifact = row) {
  if (artifact.external || !artifact.displaced || !await exists(artifact.displaced)) return;
  await assertBoundary(artifact.displaced, row.boundary);
  await assertBoundary(artifact.archive, journal.backupBoundary);
  artifact.phase = 'archiving'; await store.journal(journal);
  // R01: rename retains the inode. Across volumes it stays beside the target;
  // copying would lose later writes through a held handle to that inode.
  if (await exists(artifact.archive)) throw new Error(`Backup destination already exists: ${toPosix(artifact.archive)}`);
  try { await fs.rename(artifact.displaced, artifact.archive); }
  catch (error) { if (error.code !== 'EXDEV') throw error; artifact.external = true; }
  artifact.phase = 'archived'; await store.journal(journal);
}
async function retainedIndex(journal) {
  const file = path.join(journal.backup, 'index.json'), bytes = await readFile(file);
  const index = bytes === null ? journal.files.map(row => ({path: toPosix(row.path), copy: null})) : JSON.parse(bytes.toString('utf8'));
  for (const row of journal.files) {
    const entry = index.find(entry => entry.path === toPosix(row.path));
    entry.replacedVersions = [];
    for (const artifact of [row, row.recovery]) {
      const saved = artifact.external ? artifact.displaced : artifact.archive;
      if (saved && await exists(saved)) {
        entry.replacedVersions.push(toPosix(saved));
        (entry.carrierHashes ??= {})[toPosix(saved)] = sha256(dec(artifact === row ? row.before : row.after));
      }
    }
  }
  await assertBoundary(file, journal.backupBoundary);
  await writeFile(file, Buffer.from(JSON.stringify(index, null, 2) + '\n'), {durable: true});
}
async function cleanTemp(row, artifact, expected, journal) {
  if (!artifact.temp || !await exists(artifact.temp)) return;
  const prefix = `${row.path}.recipe-switch-${journal.id}-`;
  await assertBoundary(artifact.temp, row.boundary);
  if (!artifact.temp.startsWith(prefix) || !artifact.temp.endsWith('.tmp'))
    throw new Error(`Unregistered transaction temp: ${toPosix(artifact.temp)}`);
  // R22: a registered random temp is ours, including an interrupted partial write.
  await fs.unlink(artifact.temp);
}
async function compensate(store, journal, row) {
  await assertBoundary(row.path, row.boundary);
  if (['planned', 'untouched', 'restored'].includes(row.phase) || ['restored', 'archived'].includes(row.recovery.phase)) return;
  const undo = row.recovery, carrier = await carrierOf(row, journal);
  const before = 'before' in undo ? dec(undo.before) : carrier?.bytes ?? dec(row.before);
  const current = await readFile(row.path), after = dec(row.after);
  if (equalBytes(current, before)) return;
  const movedDuringUndo = await exists(undo.displaced);
  if (current === null && (carrier || movedDuringUndo)) {
    undo.before = enc(before); undo.phase = 'publishing'; await store.journal(journal);
    if (before !== null) {
      let source = carrier?.file;
      if (!source) {
        if (!await exists(undo.temp)) throw new Error(`Recovery temp missing: ${toPosix(undo.temp)}`);
        source = undo.temp;
      }
      await restoreDisplaced(row.path, source, row.boundary, {retain: true, sourceBoundary: carrier?.boundary ?? row.boundary});
    }
    undo.phase = 'restored'; await store.journal(journal);
    return;
  }
  if (!equalBytes(current, after)) throw new Error(`Recovery needs a manual decision for ${toPosix(row.path)}; user edits kept. Backup: ${journal.backup}${carrier ? `; displaced version: ${toPosix(carrier.file)}` : ''}`);
  // R21: persist compensation's own paths and payload before it moves the target.
  await cleanTemp(row, undo, before, journal); // retry an interrupted preparation, using only its registered temp.
  undo.before = enc(before); undo.phase = 'prepared'; await store.journal(journal);
  await writeFile(row.path, before, {expected: after, boundary: row.boundary, temp: undo.temp, displaced: undo.displaced,
    retainDisplaced: true, durable: true, onStage: async phase => { undo.phase = phase; await store.journal(journal); }});
  undo.phase = 'restored'; await store.journal(journal);
}

export class Store {
  constructor(home = stateHome()) {
    this.home = path.resolve(home); this.file = path.join(this.home, 'state.json');
    this.pending = path.join(this.home, 'pending.json');
  }
  async readState() {
    const bytes = await readFile(this.file);
    if (bytes === null) return {schema: 1, targets: {}};
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.schema !== 1) throw new Error(`Unsupported state schema in ${this.file}`);
    return value;
  }
  async journal(value) { await writeFile(this.pending, Buffer.from(JSON.stringify(value) + '\n'), {durable: true}); }
  async recover() {
    const bytes = await readFile(this.pending);
    if (bytes === null) return;
    const journal = JSON.parse(bytes.toString('utf8'));
    // Upgrade legacy pending records before compensation can create any new path.
    if (!journal.id) {
      journal.id = crypto.randomUUID();
      if (!path.isAbsolute(journal.backup)) journal.backup = path.join(this.home, 'backups', `recovered-${journal.id}`);
      await fs.mkdir(journal.backup, {recursive: true});
      journal.backupBoundary = await captureBoundary(journal.backup);
      for (const [i, row] of journal.files.entries()) {
        const paths = transactionPaths(row.path, journal.id, i, journal.backup);
        Object.assign(row, {...paths, displaced: row.displaced ?? paths.displaced, phase: 'unknown'});
      }
      await this.journal(journal);
    }
    const committed = equalBytes(await readFile(this.file), dec(journal.stateAfter));
    if (!committed) for (const row of [...journal.files].reverse()) await compensate(this, journal, row);
    // Retain the current operation's displaced inodes, including compensation.
    for (const row of journal.files) {
      await archiveDisplaced(this, journal, row);
      if (row.recovery) await archiveDisplaced(this, journal, row, row.recovery);
      await cleanTemp(row, row, dec(row.after), journal);
      if (row.recovery) await cleanTemp(row, row.recovery, dec(row.recovery.before), journal);
    }
    if (committed) await publishOriginals(this, journal.originals);
    await retainedIndex(journal);
    if (committed) await retireCarriers(this, journal.files.map(row => row.path), journal.backup);
    for (const dir of committed ? journal.cleanupDirs ?? [] : [...journal.missingDirs].reverse()) await rmdirIfEmpty(dir);
    await collectOrphanBlobs(this);
    await writeFile(this.pending, null, {durable: true});
  }
  async transaction(fn) { return withLock(this.home, async () => {
    await this.recover();
    const state = await this.readState();
    for (const [key, ended] of Object.entries(state.endedOriginals ?? {})) if (!state.targets[key] && ended.harness) {
      const manifest = originalManifestPath(this, ended.harness, ended.home);
      if (await exists(manifest)) {
        await publishOriginals(this, {path: manifest, value: null}); await collectOrphanBlobs(this);
      }
    }
    for (const target of Object.values(state.targets)) if (target.stack?.length && !await readOriginals(this, target.harness, target.home))
      await publishOriginals(this, await prepareOriginals(this, target.harness, target.home, await originalCandidates(this, target, [])));
    return fn(state);
  }); }
  async load() { return this.transaction(state => state); }
  async save(state) { await writeFile(this.file, stateBytes(state), {durable: true}); }
  async target(key) { return (await this.load()).targets[key] ?? null; }
  async update(fn) { return this.transaction(async state => { const result = await fn(state); await this.save(state); return result; }); }
}
export const targetKey = (harness, home) => `${harness}:${toPosix(path.resolve(home)).toLowerCase()}`;
const stackIds = target => (target?.stack ?? []).map(op => op.id);
export function ownedUnits(target) {
  const owned = new Map();
  for (const op of target?.stack ?? []) for (const raw of op.units) {
    const unit = deserialize(raw), id = identity(unit), prior = owned.get(id);
    owned.set(id, {latest: unit, base: prior ? prior.base : unit});
  }
  return owned;
}
function desiredToUnit(desired, current) {
  const unit = {...desired};
  if (desired.type === 'file') { unit.beforeBytes = current; unit.afterBytes = desired.afterBytes ?? null; }
  else if (desired.type === 'tomlKey') { unit.beforeLine = current; unit.afterLine = desired.afterLine ?? null; }
  else if (['jsonKey', 'jsonArrayRecord'].includes(desired.type)) { unit.beforeValue = current; unit.afterValue = desired.afterValue; }
  else { unit.beforePresent = current; unit.afterPresent = desired.afterPresent ?? true; }
  return unit;
}
async function currentSide(desired) {
  const {bytes, fp, value: jsonValue, createdDepth: yamlDepth} = await inspect(desired);
  if (desired.type === 'file') return {value: bytes, bytes, fp};
  if (desired.type === 'tomlKey') {
    const {readKeyLine} = await import('./vendor/toml-key.mjs');
    return {value: bytes === null ? null : readKeyLine(bytes.toString('utf8'), desired.table, desired.key), bytes, fp};
  }
  if (desired.type === 'yamlArrayItem') return {value: fp !== ABSENT, bytes, fp, createdDepth: yamlDepth};
  const {getKey} = await import('./json-edit.mjs');
  let createdDepth = desired.pointer.length;
  if (bytes !== null) while (createdDepth > 0 && getKey(bytes.toString('utf8'), desired.pointer.slice(0, desired.pointer.length - createdDepth + 1)) !== undefined) createdDepth--;
  if (['jsonKey', 'jsonArrayRecord'].includes(desired.type)) return {
    value: jsonValue, bytes, fp, createdDepth,
    parentMissing: bytes === null || getKey(bytes.toString('utf8'), desired.pointer.slice(0, -1)) === undefined,
  };
  return {value: fp !== ABSENT, bytes, fp, createdDepth};
}

export async function plan({store, harness, home, recipe, desired, notes = [], force = false, kind}) {
  const key = targetKey(harness, home), target = await store.target(key), owned = ownedUnits(target);
  const units = [], drift = [], conflicts = [], seen = new Set();
  for (const wanted of desired) {
    const want = {...wanted, exactSource: true, boundary: await captureBoundary(wanted.boundary ?? home)};
    const id = identity(want); seen.add(id);
    const prior = owned.get(id), {value, bytes, fp, parentMissing, createdDepth} = await currentSide(want);
    const unit = desiredToUnit(want, value);
    unit.beforeFingerprint = fp;
    if (want.type !== 'file') unit.fileCreated = prior ? prior.base.fileCreated : bytes === null;
    if (want.type === 'jsonKey') unit.parentCreated = prior ? prior.base.parentCreated : Boolean(parentMissing);
    if (['jsonArrayItem', 'jsonArrayRecord', 'yamlArrayItem'].includes(want.type) || want.type === 'jsonKey' && (parentMissing || prior?.base.createdDepth !== undefined))
      unit.createdDepth = prior ? prior.base.createdDepth : createdDepth;
    if (prior && inspectBytes(prior.latest, bytes).fp !== fingerprintOf(prior.latest, 'after')) drift.push({path: toPosix(want.path), unit: describe(want), live: fp});
    else if (!prior && want.type === 'file' && bytes !== null && !equalBytes(bytes, unit.afterBytes))
      conflicts.push({path: toPosix(want.path), reason: 'an unmanaged file already exists here'});
    if (!equalBytes(bytes, render(unit, 'after', bytes))) units.push(unit);
  }
  for (const [id, {latest, base}] of owned) {
    if (seen.has(id)) continue;
    latest.boundary ??= path.resolve(home);
    const {value, bytes, fp} = await currentSide(latest);
    if (fp !== fingerprintOf(latest, 'after')) drift.push({path: toPosix(latest.path), unit: describe(latest), live: fp});
    // R12: forced retirement owns the live before-side, not yesterday's bytes.
    const revert = desiredToUnit(latest, value);
    revert.beforeFingerprint = fp;
    delete revert.afterFingerprint;
    if (latest.type === 'file') revert.afterBytes = base.beforeBytes;
    else if (latest.type === 'tomlKey') revert.afterLine = base.beforeLine;
    else if (['jsonKey', 'jsonArrayRecord'].includes(latest.type)) revert.afterValue = base.beforeValue;
    else revert.afterPresent = base.beforePresent;
    // Retiring structured units uses the original lexical restoration too.
    const restored = render(base, 'before', bytes);
    if (!equalBytes(bytes, restored) || force && fp !== fingerprintOf(latest, 'after')) {
      revert.retirement = serialize(base);
      units.push(revert);
    }
  }
  const files = await previewFiles(units, 'after');
  const blocked = [...await publicationBlocks(units), ...(!force ? [...drift.map(d => `hand edit detected: ${d.path} (${d.unit})`), ...conflicts.map(c => `${c.reason}: ${c.path}`)] : [])];
  return {id: crypto.randomUUID(), key, harness, home: toPosix(path.resolve(home)), kind: kind ?? (target?.stack?.length ? 'switch' : 'install'),
    stateVersion: stackIds(target), recipe: recipe && {key: recipe.key, id: recipe.id, name: recipe.name, version: recipe.version, revision: recipe.revision,
      origin: recipe.origin, optionValues: recipe.optionValues ?? {}}, units, files, drift, conflicts, notes: [...notes, RETENTION_LIMIT, RESTORE_LIMIT], blocked, force};
}
export function describe(unit) {
  if (unit.type === 'file') return 'managed file';
  if (unit.type === 'tomlKey') return `TOML key ${[...unit.table, unit.key].join('.')}`;
  if (unit.type === 'jsonKey') return `JSON key ${unit.pointer.join('.')}`;
  return `${unit.type === 'yamlArrayItem' ? 'YAML' : 'JSON'} ${unit.pointer.join('.')} ${unit.type === 'jsonArrayRecord' ? 'record' : 'item'} ${JSON.stringify(unit.value)}`;
}

async function publicationBlocks(units) {
  const dirs = new Set(), blocked = [];
  for (const unit of units) {
    const dir = path.dirname(path.resolve(unit.path));
    if (dirs.has(dir)) continue;
    dirs.add(dir);
    const reason = await probeHardlinks(unit.path, unit.boundary);
    if (reason) blocked.push(reason);
  }
  return blocked;
}
export const RESTORE_LIMIT = '若探测后硬链接能力丢失，恢复会检查目标不存在后 rename；检查与 rename 之间被外部重新创建的目标无法原子保护。If hard-link support disappears after preview, recovery checks absence then renames; a target recreated between that check and rename cannot be protected atomically.';

// Presentation only. Integrity comparisons below always use real bytes.
const SECRET = /((?:["']?)(?:authorization|proxy-authorization|x-api-key|api[_-]?key|set-cookie|cookie|auth|[\w.-]*(?:token|secret|password))["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\r\n,}]+)/gi;
export const redact = text => text.replace(SECRET, (_, head) => `${head}"[redacted]"`)
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');

async function prepare(units, side, expectSide, force = false) {
  const rows = new Map(), checked = new Set();
  // R04: every path is read and every unit preflighted before the first write.
  for (const unit of units) {
    const file = path.resolve(unit.path);
    if (unit.boundary) await assertBoundary(file, unit.boundary);
    if (!rows.has(file)) { const bytes = await readFile(file); rows.set(file, {path: file, boundary: unit.boundary, before: bytes, after: bytes, units: []}); }
    const row = rows.get(file);
    const id = identity(unit);
    // Only the newest value of an identity is live. Forced historical takeover
    // may deliberately have a before-side different from the older after-side.
    if (expectSide && !force && !checked.has(id) && inspectBytes(unit, row.before).fp !== fingerprintOf(unit, expectSide))
      throw new Error(`Files changed since the preview; stopped before writing ${toPosix(file)}`);
    checked.add(id);
    const current = row.after;
    row.after = side === 'after' && unit.retirement ? render(deserialize(unit.retirement), 'before', current) : render(unit, side, current);
    if (side === 'after') {
      recordLayout(unit, current, row.after);
      unit.afterFingerprint = inspectBytes(unit, row.after).fp;
    }
    row.units.push(unit);
  }
  return [...rows.values()];
}
function display(rows) {
  return rows.filter(row => !equalBytes(row.before, row.after)).map(({path: file, before, after, units}) => {
    const binary = bytes => bytes !== null && bytes.includes(0);
    const diff = binary(before) || binary(after) ? {text: '(binary)', added: 0, removed: 0}
      : unifiedDiff(before === null ? null : before.toString('utf8'), after === null ? null : after.toString('utf8'), {path: toPosix(file)});
    return {path: toPosix(file), action: before === null ? 'create' : after === null ? 'delete' : 'modify', units: units.map(describe),
      integrity: [before === null ? null : sha256(before), after === null ? null : sha256(after)], added: diff.added, removed: diff.removed, diff: redact(diff.text)};
  }).sort((a, b) => a.path.localeCompare(b.path));
}
export async function previewFiles(units, side) { return display(await prepare(units, side)); }
function checkPreview(rows, planned) {
  if (JSON.stringify(display(rows).map(f => f.integrity)) !== JSON.stringify(planned.files.map(f => f.integrity)))
    throw new Error('Files changed since the preview; preview again before applying.');
}
async function backup(store, opId, rows) {
  const dir = path.join(store.home, 'backups', opId), index = [];
  await assertBoundary(dir, await captureBoundary(store.home));
  await privateDirectory(dir);
  for (const row of rows) {
    const hash = row.before === null ? null : await putBlob(store, row.before);
    index.push({path: toPosix(row.path), copy: null, sha256: hash,
      blob: hash === null ? null : {hash, size: row.before.length}});
  }
  await writeFile(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index, null, 2) + '\n'));
  return toPosix(dir);
}
async function missingDirs(rows) {
  const dirs = new Set();
  for (const row of rows) {
    let cursor = path.dirname(row.path);
    while (!(await exists(cursor))) { dirs.add(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  }
  return [...dirs].sort((a, b) => a.length - b.length);
}
async function commitFiles(store, rows, state, backupDir, beforeSave, cleanupDirs = [], originals = null) {
  const dirs = await missingDirs(rows), created = [], id = crypto.randomUUID();
  const files = rows.filter(row => !equalBytes(row.before, row.after)).map((row, i) => ({path: row.path, boundary: row.boundary,
    before: enc(row.before), after: enc(row.after), ...transactionPaths(row.path, id, i, backupDir)}));
  releaseCarrierReferences(state, files.map(row => row.path));
  const replacedVersions = files.filter(row => row.before !== null).map(row => ({path: toPosix(row.path), saved: toPosix(row.archive), hash: sha256(dec(row.before))}));
  if (replacedVersions.length) (state.replacedVersions ??= []).push({backup: backupDir, files: replacedVersions});
  const journal = {id, backup: backupDir, backupBoundary: await captureBoundary(backupDir), stateAfter: enc(stateBytes(state)), missingDirs: dirs,
    cleanupDirs: [...new Set(cleanupDirs)].sort((a, b) => b.length - a.length), files, originals};
  await store.journal(journal);
  try {
    for (const row of files) {
      created.push(...await writeFile(row.path, dec(row.after), {expected: dec(row.before), boundary: row.boundary,
        temp: row.temp, displaced: row.displaced, retainDisplaced: true, durable: true,
        onStage: async phase => { row.phase = phase; await store.journal(journal); }}));
    }
    for (const row of files) await archiveDisplaced(store, journal, row);
    for (const version of replacedVersions) {
      const row = files.find(row => toPosix(row.path) === version.path);
      version.saved = toPosix(row.external ? row.displaced : row.archive);
    }
    await retainedIndex(journal);
    if (beforeSave) beforeSave(created, replacedVersions);
    journal.stateAfter = enc(stateBytes(state)); await store.journal(journal);
    await store.save(state);
  } catch (error) {
    try { await store.recover(); }
    catch (recovery) { throw new Error(`${error.message}\nRecovery pending: ${recovery.message}`); }
    throw new Error(`${error.message}\nWritten files reverted; backup kept at ${backupDir}`);
  }
  await store.recover();
  return replacedVersions;
}

async function originalCandidates(store, target, rows) {
  const candidates = new Map(rows.map(row => [path.resolve(row.path), {path: row.path, bytes: row.before, boundary: row.boundary}]));
  const grouped = new Map();
  for (const op of target?.stack ?? []) for (const raw of op.units) {
    const unit = deserialize(raw), file = path.resolve(unit.path);
    if (!grouped.has(file)) grouped.set(file, []);
    grouped.get(file).push({unit, op});
  }
  for (const [file, history] of grouped) {
    const {unit: first, op} = history[0], boundary = first.boundary ?? target.home;
    await assertBoundary(file, boundary);
    let bytes, source, reason;
    if (first.type === 'file' && 'beforeBytes' in first) { bytes = first.beforeBytes; source = 'operation-before-bytes'; }
    else if (first.layoutBefore !== undefined) { bytes = first.layoutBefore === null ? null : Buffer.from(first.layoutBefore); source = 'operation-layout-before'; }
    else if (first.fileCreated === true) { bytes = null; source = 'operation-file-created'; }
    else if (op.backup) {
      try {
        const indexFile = path.join(op.backup, 'index.json'); await assertBoundary(indexFile, await captureBoundary(store.home));
        const index = JSON.parse(await readFile(indexFile)), entry = index.find(row => path.resolve(row.path) === file);
        if (entry?.blob) { bytes = await originalBytes(store, {...entry.blob, existed: true, path: file}); source = 'operation-backup-blob'; }
        else if (entry?.copy) {
          const copy = path.join(op.backup, entry.copy); await assertBoundary(copy, await captureBoundary(op.backup));
          bytes = await readFile(copy);
          if (bytes === null || entry.sha256 && sha256(bytes) !== entry.sha256) throw new Error('Complete backup missing or corrupt');
          source = 'operation-backup';
        } else if (entry && entry.sha256 === null) { bytes = null; source = 'operation-backup-absent'; }
      } catch (error) { reason = error.message; }
    }
    if (!source) {
      bytes = candidates.get(file)?.bytes ?? await readFile(file);
      for (const {unit} of [...history].reverse()) bytes = render(unit, 'before', bytes);
      source = 'reconstructed';
      reason = `没有最早的完整文件记录或可靠操作备份 / No earliest whole-file record or reliable operation backup${reason ? ': ' + reason : ''}`;
    }
    candidates.set(file, {path: file, boundary, bytes, source, reconstructed: source === 'reconstructed', reason});
  }
  return [...candidates.values()];
}

async function endOriginalCycle(store, state, key, harness, home, rows) {
  const original = await readOriginals(store, harness, home);
  if (!original) return null;
  const files = [];
  for (const entry of original.files)
    files.push({path: entry.path, boundary: entry.boundary, fingerprint: entry.existed ? entry.hash : null});
  (state.endedOriginals ??= {})[key] = {harness, home: toPosix(path.resolve(home)), capturedAt: original.capturedAt, endedAt: new Date().toISOString(), files};
  return {path: originalManifestPath(store, harness, home), value: null};
}

export async function applyPlan(store, planned) {
  if (planned.blocked.length) throw new Error(`Plan is blocked:\n  ${planned.blocked.join('\n  ')}`);
  return store.transaction(async state => {
    if (JSON.stringify(stackIds(state.targets[planned.key])) !== JSON.stringify(planned.stateVersion)) throw new Error('Installation state changed since the preview; preview again.');
    if (!planned.units.length) return {changed: false, message: 'Already up to date; nothing to write.'};
    const units = planned.units.map(unit => ({...unit}));
    const rows = await prepare(units, 'after', 'before');
    checkPreview(rows, planned);
    const opId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${planned.id.slice(0, 8)}`;
    const backupDir = await backup(store, opId, rows);
    const target = state.targets[planned.key] ??= {harness: planned.harness, home: planned.home, stack: []};
    const originals = await prepareOriginals(store, planned.harness, planned.home, await originalCandidates(store, target, rows));
    delete state.endedOriginals?.[planned.key];
    const knownDirs = target.stack.flatMap(op => op.createdDirs ?? []);
    const op = {id: opId, kind: planned.kind, at: new Date().toISOString(), recipe: planned.recipe, options: planned.options,
      backup: backupDir, forced: planned.force || undefined, units: units.map(serialize)};
    target.stack.push(op);
    const replacedVersions = await commitFiles(store, rows, state, backupDir, (created, replaced) => {
      op.createdDirs = created.map(toPosix); op.replacedVersions = replaced;
    }, knownDirs, originals);
    return {changed: true, op: opId, backup: backupDir, replacedVersions, message: `${planned.kind === 'switch' ? 'Switched' : 'Installed'} ${planned.recipe?.key ?? ''}`};
  });
}
async function runtimeCleanup(target) {
  if (target?.harness !== 'hermes') return [];
  const file = path.join(target.home, 'plugins', 'recipe-switch', 'capabilities.json');
  const boundary = await captureBoundary(target.home);
  await assertBoundary(file, boundary);
  const bytes = await readFile(file);
  if (bytes === null) return [];
  // Runtime evidence is not owned prompt content and never participates in drift.
  // Remove only our own marked report when the plugin is fully uninstalled.
  try { if (JSON.parse(bytes).managedBy !== 'recipe-switch') return []; } catch { return []; }
  return [{type: 'file', path: file, boundary, beforeBytes: null, afterBytes: bytes}];
}
export async function planUndo(store, harness, home, {all = false, force = false} = {}) {
  const key = targetKey(harness, home), target = await store.target(key);
  if (!target?.stack?.length) throw new Error(`Nothing installed by recipe-switch for ${harness} at ${toPosix(home)}`);
  const ops = all ? [...target.stack].reverse() : [target.stack.at(-1)];
  const drift = [];
  for (const [, {latest}] of ownedUnits(target)) {
    if (!all && !ops[0].units.some(raw => identity(deserialize(raw)) === identity(latest))) continue;
    latest.boundary ??= path.resolve(home);
    const live = (await inspect(latest)).fp;
    if (live !== fingerprintOf(latest, 'after')) drift.push({path: toPosix(latest.path), unit: describe(latest), live});
  }
  const units = ops.flatMap(op => op.units.map(deserialize).reverse()).map(unit => ({...unit, boundary: unit.boundary ?? path.resolve(home)}));
  if (ops.length === target.stack.length) units.unshift(...await runtimeCleanup(target));
  return {key, harness, home: toPosix(path.resolve(home)), kind: all ? 'uninstall' : 'rollback', ops: ops.map(op => op.id),
    restores: all ? null : target.stack.at(-2)?.recipe ?? null, files: await previewFiles(units, 'before'), drift,
    notes: [RETENTION_LIMIT, RESTORE_LIMIT],
    blocked: [...await publicationBlocks(units), ...(!force ? drift.map(d => `hand edit detected: ${d.path} (${d.unit})`) : [])], force};
}
export async function applyUndo(store, planned) {
  if (planned.blocked.length) throw new Error(`Blocked:\n  ${planned.blocked.join('\n  ')}`);
  return store.transaction(async state => {
    const target = state.targets[planned.key];
    const ops = planned.kind === 'uninstall' ? [...(target?.stack ?? [])].reverse() : target?.stack?.length ? [target.stack.at(-1)] : [];
    if (!ops.length || JSON.stringify(planned.ops) !== JSON.stringify(ops.map(op => op.id))) throw new Error('Installation state changed since the preview; preview again.');
    const units = ops.flatMap(op => op.units.map(deserialize).reverse()).map(unit => ({...unit, boundary: unit.boundary ?? planned.home}));
    if (ops.length === target.stack.length) units.unshift(...await runtimeCleanup(target));
    const rows = await prepare(units, 'before', 'after', planned.force);
    checkPreview(rows, planned);
    const backupDir = await backup(store, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`, rows);
    target.stack.splice(target.stack.length - ops.length);
    const retirement = !target.stack.length ? await endOriginalCycle(store, state, planned.key, planned.harness, planned.home, rows) : null;
    if (!target.stack.length) delete state.targets[planned.key];
    const replacedVersions = await commitFiles(store, rows, state, backupDir, undefined, ops.flatMap(op => op.createdDirs ?? []), retirement);
    return {changed: true, backup: backupDir, replacedVersions, message: planned.kind === 'uninstall' ? 'Uninstalled; original state restored.'
      : planned.restores ? `Rolled back to ${planned.restores.key}` : 'Rolled back; original state restored.'};
  });
}
export async function planRestoreOriginal(store, harness, home, {force = false} = {}) {
  return store.transaction(async state => {
    const original = await readOriginals(store, harness, home);
    const key = targetKey(harness, home), target = state.targets[key], files = new Map();
    if (!original) {
      const ended = state.endedOriginals?.[key];
      if (!target?.stack?.length && ended) {
        let same = true;
        for (const entry of ended.files) {
          await assertBoundary(entry.path, entry.boundary ?? home);
          const bytes = await readFile(entry.path);
          if ((bytes === null ? null : sha256(bytes)) !== entry.fingerprint) same = false;
        }
        return {id: crypto.randomUUID(), key, harness, home: toPosix(path.resolve(home)), kind: 'restore-original',
          noChange: same, ended: true, stateVersion: [], files: [], units: [], drift: [], force,
          notes: [same ? '已经是装之前的状态 / Already at the pre-install state' : '安装周期已结束，备份已退役；新修改将作为下次安装的起点 / Installation cycle ended; retired backup cannot replace later changes.'],
          blocked: same ? [] : ['安装周期已结束，不能恢复已退役的快照 / Installation cycle ended; snapshot retired.']};
      }
      throw new Error('No original snapshot for this target.');
    }
    for (const entry of original.files) {
      await assertBoundary(entry.path, entry.boundary ?? home);
      const bytes = await originalBytes(store, entry);
      files.set(path.resolve(entry.path), {entry, original: bytes, expected: bytes});
    }
    for (const op of target?.stack ?? []) for (const raw of op.units) {
      const unit = deserialize(raw), file = files.get(path.resolve(unit.path));
      if (!file) throw new Error(`Original snapshot does not cover ${toPosix(unit.path)}`);
      file.expected = unit.retirement ? render(deserialize(unit.retirement), 'before', file.expected) : render(unit, 'after', file.expected);
    }
    const units = [], drift = [];
    for (const {entry, original: bytes, expected} of files.values()) {
      const current = await readFile(entry.path), fp = inspectBytes({type: 'file'}, current).fp;
      if (!equalBytes(current, expected)) drift.push({path: entry.path, unit: 'original whole-file snapshot', live: fp});
      units.push({type: 'file', path: entry.path, boundary: entry.boundary ?? await captureBoundary(home),
        beforeBytes: current, afterBytes: bytes, beforeFingerprint: fp});
    }
    for (const report of await runtimeCleanup(target)) units.push({...report, beforeBytes: report.afterBytes, afterBytes: null,
      beforeFingerprint: inspectBytes({type: 'file'}, report.afterBytes).fp});
    const changedFiles = await previewFiles(units, 'after'), noChange = !target?.stack?.length && !changedFiles.length;
    return {id: crypto.randomUUID(), key, harness, home: toPosix(path.resolve(home)), kind: 'restore-original', units,
      stateVersion: stackIds(target), manifestVersion: sha256(await readFile(original.manifest)),
      files: changedFiles, noChange, drift, force,
      reconstructed: original.files.some(file => file.reconstructed), capturedAt: original.capturedAt,
      notes: [...(original.files.some(file => file.reconstructed) ? [RECONSTRUCTED_WARNING] : []),
        'Restores complete pre-install backup files and removes every recipe-switch operation for this target. Unrelated changes in these files also require force and are backed up first.', RETENTION_LIMIT, RESTORE_LIMIT],
      blocked: [...await publicationBlocks(units), ...(!force && original.files.some(file => file.reconstructed)
        ? [`${RECONSTRUCTED_WARNING}。请额外确认 --force / Confirm explicitly with --force.`] : []),
        ...(!force ? drift.map(row => `hand edit detected: ${row.path} (${row.unit})`) : [])]};
  });
}
export async function applyRestoreOriginal(store, planned) {
  if (planned.blocked.length) throw new Error(`Blocked:\n  ${planned.blocked.join('\n  ')}`);
  return store.transaction(async state => {
    const target = state.targets[planned.key], original = await readOriginals(store, planned.harness, planned.home);
    if (planned.noChange && !target?.stack?.length && !original) {
      for (const entry of state.endedOriginals?.[planned.key]?.files ?? []) {
        await assertBoundary(entry.path, entry.boundary ?? planned.home);
        const bytes = await readFile(entry.path);
        if ((bytes === null ? null : sha256(bytes)) !== entry.fingerprint) throw new Error('Files changed since the preview; preview again.');
      }
      return {changed: false, message: '已经是装之前的状态 / Already at the pre-install state'};
    }
    if (JSON.stringify(stackIds(target)) !== JSON.stringify(planned.stateVersion) || !original || sha256(await readFile(original.manifest)) !== planned.manifestVersion)
      throw new Error('Installation state changed since the preview; preview again.');
    // Revalidate blob integrity before any mutation, including a forced restore.
    for (const entry of original.files) await originalBytes(store, entry);
    const rows = await prepare(planned.units.map(unit => ({...unit})), 'after', 'before');
    checkPreview(rows, planned);
    if (!target?.stack?.length && rows.every(row => equalBytes(row.before, row.after))) {
      const retirement = await endOriginalCycle(store, state, planned.key, planned.harness, planned.home, rows);
      await store.save(state); await publishOriginals(store, retirement); await collectOrphanBlobs(store);
      return {changed: false, message: '已经是装之前的状态 / Already at the pre-install state'};
    }
    const backupDir = await backup(store, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`, rows);
    const dirs = (target?.stack ?? []).flatMap(op => op.createdDirs ?? []);
    const retirement = await endOriginalCycle(store, state, planned.key, planned.harness, planned.home, rows);
    delete state.targets[planned.key];
    const replacedVersions = await commitFiles(store, rows, state, backupDir, undefined, dirs, retirement);
    return {changed: true, backup: backupDir, replacedVersions, message: 'Restored pre-install backup; recipe-switch is fully uninstalled from this target.'};
  });
}

export async function status(store, harness, home) {
  const target = await store.target(targetKey(harness, home));
  if (!target?.stack?.length) return {installed: false, drift: [], history: []};
  const drift = [];
  for (const [, {latest}] of ownedUnits(target)) {
    latest.boundary ??= path.resolve(home);
    const live = (await inspect(latest)).fp;
    if (live !== fingerprintOf(latest, 'after')) drift.push({path: toPosix(latest.path), unit: describe(latest), state: live === ABSENT ? 'missing' : 'edited'});
  }
  const top = target.stack.at(-1);
  return {installed: true, recipe: top.recipe, options: top.options ?? {}, since: top.at, drift,
    history: target.stack.map(op => ({id: op.id, kind: op.kind, at: op.at, recipe: op.recipe?.key, backup: op.backup})).reverse()};
}
export {fs};
