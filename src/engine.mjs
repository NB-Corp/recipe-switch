// Reversible transactions: exact source snapshots, conditional file writes,
// serialized state commits and a durable compensation journal.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readFile, writeFile, restoreDisplaced, rmdirIfEmpty, equalBytes, toPosix, sha256, assertBoundary, captureBoundary, withLock, exists} from './fsx.mjs';
import {inspect, inspectBytes, fingerprintOf, render, recordLayout, identity, ABSENT} from './units.mjs';
import {unifiedDiff} from './diff.mjs';

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
      if (saved && await exists(saved)) entry.replacedVersions.push(toPosix(saved));
    }
  }
  await assertBoundary(file, journal.backupBoundary);
  await writeFile(file, Buffer.from(JSON.stringify(index, null, 2) + '\n'), {durable: true});
}
async function cleanTemp(row, artifact, expected, journal) {
  if (!artifact.temp || !await exists(artifact.temp)) return;
  const prefix = `${row.path}.recipe-switch-${journal.id}-`;
  await assertBoundary(artifact.temp, row.boundary);
  if (!artifact.temp.startsWith(prefix) || !artifact.temp.endsWith('.tmp') || !equalBytes(await readFile(artifact.temp), expected))
    throw new Error(`Transaction temp changed; kept at ${toPosix(artifact.temp)}`);
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
    // Retain displaced inodes on both commit and compensation. Never unlink them.
    for (const row of journal.files) {
      await archiveDisplaced(this, journal, row);
      if (row.recovery) await archiveDisplaced(this, journal, row, row.recovery);
      await cleanTemp(row, row, dec(row.after), journal);
      if (row.recovery) await cleanTemp(row, row.recovery, dec(row.recovery.before), journal);
    }
    await retainedIndex(journal);
    for (const dir of committed ? journal.cleanupDirs ?? [] : [...journal.missingDirs].reverse()) await rmdirIfEmpty(dir);
    await writeFile(this.pending, null, {durable: true});
  }
  async transaction(fn) { return withLock(this.home, async () => { await this.recover(); return fn(await this.readState()); }); }
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
  const blocked = !force ? [...drift.map(d => `hand edit detected: ${d.path} (${d.unit})`), ...conflicts.map(c => `${c.reason}: ${c.path}`)] : [];
  return {id: crypto.randomUUID(), key, harness, home: toPosix(path.resolve(home)), kind: kind ?? (target?.stack?.length ? 'switch' : 'install'),
    stateVersion: stackIds(target), recipe: recipe && {key: recipe.key, id: recipe.id, name: recipe.name, version: recipe.version, revision: recipe.revision,
      origin: recipe.origin, optionValues: recipe.optionValues ?? {}}, units, files, drift, conflicts, notes, blocked, force};
}
export function describe(unit) {
  if (unit.type === 'file') return 'managed file';
  if (unit.type === 'tomlKey') return `TOML key ${[...unit.table, unit.key].join('.')}`;
  if (unit.type === 'jsonKey') return `JSON key ${unit.pointer.join('.')}`;
  return `${unit.type === 'yamlArrayItem' ? 'YAML' : 'JSON'} ${unit.pointer.join('.')} ${unit.type === 'jsonArrayRecord' ? 'record' : 'item'} ${JSON.stringify(unit.value)}`;
}

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
  for (const row of rows) {
    const name = `${index.length}-${path.basename(row.path)}`;
    if (row.before !== null) await writeFile(path.join(dir, name), row.before);
    index.push({path: toPosix(row.path), copy: row.before === null ? null : name, sha256: row.before === null ? null : sha256(row.before)});
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
async function commitFiles(store, rows, state, backupDir, beforeSave, cleanupDirs = []) {
  const dirs = await missingDirs(rows), created = [], id = crypto.randomUUID();
  const files = rows.filter(row => !equalBytes(row.before, row.after)).map((row, i) => ({path: row.path, boundary: row.boundary,
    before: enc(row.before), after: enc(row.after), ...transactionPaths(row.path, id, i, backupDir)}));
  const replacedVersions = files.filter(row => row.before !== null).map(row => ({path: toPosix(row.path), saved: toPosix(row.archive)}));
  if (replacedVersions.length) (state.replacedVersions ??= []).push({backup: backupDir, files: replacedVersions});
  const journal = {id, backup: backupDir, backupBoundary: await captureBoundary(backupDir), stateAfter: enc(stateBytes(state)), missingDirs: dirs,
    cleanupDirs: [...new Set(cleanupDirs)].sort((a, b) => b.length - a.length), files};
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
    const knownDirs = target.stack.flatMap(op => op.createdDirs ?? []);
    const op = {id: opId, kind: planned.kind, at: new Date().toISOString(), recipe: planned.recipe, options: planned.options,
      backup: backupDir, forced: planned.force || undefined, units: units.map(serialize)};
    target.stack.push(op);
    const replacedVersions = await commitFiles(store, rows, state, backupDir, (created, replaced) => {
      op.createdDirs = created.map(toPosix); op.replacedVersions = replaced;
    }, knownDirs);
    return {changed: true, op: opId, backup: backupDir, replacedVersions, message: `${planned.kind === 'switch' ? 'Switched' : 'Installed'} ${planned.recipe?.key ?? ''}`};
  });
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
  return {key, harness, home: toPosix(path.resolve(home)), kind: all ? 'uninstall' : 'rollback', ops: ops.map(op => op.id),
    restores: all ? null : target.stack.at(-2)?.recipe ?? null, files: await previewFiles(units, 'before'), drift,
    blocked: !force ? drift.map(d => `hand edit detected: ${d.path} (${d.unit})`) : [], force};
}
export async function applyUndo(store, planned) {
  if (planned.blocked.length) throw new Error(`Blocked:\n  ${planned.blocked.join('\n  ')}`);
  return store.transaction(async state => {
    const target = state.targets[planned.key];
    const ops = planned.kind === 'uninstall' ? [...(target?.stack ?? [])].reverse() : target?.stack?.length ? [target.stack.at(-1)] : [];
    if (!ops.length || JSON.stringify(planned.ops) !== JSON.stringify(ops.map(op => op.id))) throw new Error('Installation state changed since the preview; preview again.');
    const units = ops.flatMap(op => op.units.map(deserialize).reverse()).map(unit => ({...unit, boundary: unit.boundary ?? planned.home}));
    const rows = await prepare(units, 'before', 'after', planned.force);
    checkPreview(rows, planned);
    const backupDir = await backup(store, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`, rows);
    target.stack.splice(target.stack.length - ops.length);
    if (!target.stack.length) delete state.targets[planned.key];
    const replacedVersions = await commitFiles(store, rows, state, backupDir, undefined, ops.flatMap(op => op.createdDirs ?? []));
    return {changed: true, backup: backupDir, replacedVersions, message: planned.kind === 'uninstall' ? 'Uninstalled; original state restored.'
      : planned.restores ? `Rolled back to ${planned.restores.key}` : 'Rolled back; original state restored.'};
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
