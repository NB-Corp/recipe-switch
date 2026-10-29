// Transaction engine. Every install or switch is one operation pushed onto the
// target's stack; rollback pops (undoes) the top operation and uninstall pops
// all of them. Units record exact before/after values, and nothing is written
// unless the live state still matches what the loader last wrote.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readFile, writeFile, rmdirIfEmpty, equalBytes, toPosix, sha256} from './fsx.mjs';
import {inspect, fingerprintOf, render, apply, identity, ABSENT} from './units.mjs';
import {unifiedDiff} from './diff.mjs';

export const MARK = 'managed by recipe-loader';

export function stateHome(env = process.env) {
  return path.resolve(env.RECIPE_LOADER_HOME || path.join(os.homedir(), '.recipe-loader'));
}

const enc = bytes => bytes === null || bytes === undefined ? null : Buffer.from(bytes).toString('base64');
const dec = value => value === null || value === undefined ? null : Buffer.from(value, 'base64');

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

export class Store {
  constructor(home = stateHome()) { this.home = home; this.file = path.join(home, 'state.json'); }
  async load() {
    const bytes = await readFile(this.file);
    if (bytes === null) return {schema: 1, targets: {}};
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.schema !== 1) throw new Error(`Unsupported state schema in ${this.file}`);
    return value;
  }
  async save(state) { await writeFile(this.file, Buffer.from(JSON.stringify(state, null, 2) + '\n')); }
  async target(key) { return (await this.load()).targets[key] ?? null; }
  async update(fn) { const state = await this.load(); const result = await fn(state); await this.save(state); return result; }
}

export const targetKey = (harness, home) => `${harness}:${toPosix(path.resolve(home)).toLowerCase()}`;

/** Latest managed value per unit identity, with the base (pre-first-op) value. */
export function ownedUnits(target) {
  const owned = new Map();
  for (const op of target?.stack ?? []) for (const raw of op.units) {
    const unit = deserialize(raw), id = identity(unit), prior = owned.get(id);
    owned.set(id, {latest: unit, base: prior ? prior.base : unit});
  }
  return owned;
}

function desiredToUnit(desired, current, base) {
  const unit = {...desired};
  if (desired.type === 'file') {
    unit.beforeBytes = current;
    unit.afterBytes = desired.afterBytes ?? null;
  } else if (desired.type === 'tomlKey') {
    unit.beforeLine = current;
    unit.afterLine = desired.afterLine ?? null;
  } else if (desired.type === 'jsonKey') {
    unit.beforeValue = current;
    unit.afterValue = desired.afterValue;
  } else {
    unit.beforePresent = current;
    unit.afterPresent = desired.afterPresent ?? true;
  }
  return unit;
}

async function currentSide(desired) {
  const {bytes} = await inspect(desired);
  if (desired.type === 'file') return {value: bytes, bytes};
  if (desired.type === 'tomlKey') {
    const {readKeyLine} = await import('./vendor/toml-key.mjs');
    return {value: bytes === null ? null : readKeyLine(bytes.toString('utf8'), desired.table, desired.key), bytes};
  }
  const {fp} = await inspect(desired);
  const {getKey} = await import('./json-edit.mjs');
  if (desired.type === 'jsonKey') return {value: fp === ABSENT ? undefined : JSON.parse(fp.slice(6)), bytes, parentMissing: bytes !== null && getKey(bytes.toString('utf8'), desired.pointer.slice(0, -1)) === undefined};
  // Count trailing pointer segments (array included) that do not exist yet.
  let createdDepth = desired.pointer.length;
  if (bytes !== null) {
    const text = bytes.toString('utf8');
    while (createdDepth > 0 && getKey(text, desired.pointer.slice(0, desired.pointer.length - createdDepth + 1)) !== undefined) createdDepth--;
  }
  return {value: fp === 'present', bytes, createdDepth};
}

/**
 * Build a plan: desired units for the new recipe plus reversion units for
 * anything the target still owns that the new recipe no longer needs.
 * Drift and unmanaged conflicts are reported; they block apply unless forced.
 */
export async function plan({store, harness, home, recipe, desired, notes = [], force = false, kind}) {
  const key = targetKey(harness, home), target = await store.target(key), owned = ownedUnits(target);
  const units = [], drift = [], conflicts = [], seen = new Set();
  for (const want of desired) {
    const id = identity(want);
    seen.add(id);
    const prior = owned.get(id), {value, bytes, parentMissing, createdDepth} = await currentSide(want);
    const unit = desiredToUnit(want, value, prior?.base);
    if (want.type !== 'file') unit.fileCreated = prior ? prior.base.fileCreated : bytes === null;
    if (want.type === 'jsonKey') unit.parentCreated = prior ? prior.base.parentCreated : Boolean(parentMissing);
    if (want.type === 'jsonArrayItem') unit.createdDepth = prior ? prior.base.createdDepth : createdDepth;
    if (prior) {
      const live = (await inspect(want)).fp;
      if (live !== fingerprintOf(prior.latest, 'after')) drift.push({path: toPosix(want.path), unit: describe(want), live});
    } else if (want.type === 'file' && bytes !== null && !equalBytes(bytes, unit.afterBytes)) {
      conflicts.push({path: toPosix(want.path), reason: 'an unmanaged file already exists here'});
    }
    if (fingerprintOf(unit, 'before') !== fingerprintOf(unit, 'after')) units.push(unit);
  }
  for (const [id, {latest, base}] of owned) {
    if (seen.has(id)) continue;
    const live = (await inspect(latest)).fp;
    if (live !== fingerprintOf(latest, 'after')) drift.push({path: toPosix(latest.path), unit: describe(latest), live});
    const revert = {...latest};
    if (latest.type === 'file') { revert.beforeBytes = latest.afterBytes; revert.afterBytes = base.beforeBytes; }
    else if (latest.type === 'tomlKey') { revert.beforeLine = latest.afterLine; revert.afterLine = base.beforeLine; }
    else if (latest.type === 'jsonKey') { revert.beforeValue = latest.afterValue; revert.afterValue = base.beforeValue; }
    else { revert.beforePresent = latest.afterPresent; revert.afterPresent = base.beforePresent; }
    if (fingerprintOf(revert, 'before') !== fingerprintOf(revert, 'after')) units.push(revert);
  }
  const files = await previewFiles(units, 'after');
  const blocked = (!force && (drift.length || conflicts.length)) ? [...drift.map(d => `hand edit detected: ${d.path} (${d.unit})`),
    ...conflicts.map(c => `${c.reason}: ${c.path}`)] : [];
  return {
    id: crypto.randomUUID(), key, harness, home: toPosix(path.resolve(home)), kind: kind ?? (target?.stack?.length ? 'switch' : 'install'),
    recipe: recipe && {key: recipe.key, id: recipe.id, name: recipe.name, version: recipe.version, revision: recipe.revision, origin: recipe.origin},
    units, files, drift, conflicts, notes, blocked, force,
  };
}

export function describe(unit) {
  if (unit.type === 'file') return 'managed file';
  if (unit.type === 'tomlKey') return `TOML key ${[...unit.table, unit.key].join('.')}`;
  if (unit.type === 'jsonKey') return `JSON key ${unit.pointer.join('.')}`;
  return `JSON ${unit.pointer.join('.')} item ${JSON.stringify(unit.value)}`;
}

const SECRET = /((?:api[_-]?key|token|secret|password|bearer)[^:=]*["']?\s*[:=]\s*["']?)([^"',\s]{4,})/gi;
export const redact = text => text.replace(SECRET, (_, head, value) => `${head}${value.slice(0, 2)}…[redacted]`);

/** Per-file before/after bytes and a redacted unified diff. */
export async function previewFiles(units, side) {
  const byPath = new Map();
  for (const unit of units) {
    const file = path.resolve(unit.path);
    if (!byPath.has(file)) byPath.set(file, {current: await readFile(file), units: []});
    byPath.get(file).units.push(unit);
  }
  const out = [];
  for (const [file, {current, units: list}] of byPath) {
    let next = current;
    for (const unit of list) next = render(unit, side, next);
    const binary = buf => buf !== null && buf.includes(0);
    const diff = binary(current) || binary(next) ? {text: '(binary)', added: 0, removed: 0}
      : unifiedDiff(current === null ? null : current.toString('utf8'), next === null ? null : next.toString('utf8'), {path: toPosix(file)});
    out.push({path: toPosix(file), action: current === null ? 'create' : next === null ? 'delete' : 'modify',
      units: list.map(describe), added: diff.added, removed: diff.removed, diff: redact(diff.text)});
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function backup(store, opId, units) {
  const dir = path.join(store.home, 'backups', opId), index = [];
  const seen = new Set();
  for (const unit of units) {
    const file = path.resolve(unit.path);
    if (seen.has(file)) continue;
    seen.add(file);
    const bytes = await readFile(file);
    const name = `${index.length}-${path.basename(file)}`;
    if (bytes !== null) await writeFile(path.join(dir, name), bytes);
    index.push({path: toPosix(file), copy: bytes === null ? null : name, sha256: bytes === null ? null : sha256(bytes)});
  }
  await writeFile(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index, null, 2) + '\n'));
  return toPosix(dir);
}

async function writeUnits(units, side, expectSide) {
  const created = [], done = [];
  try {
    for (const unit of units) {
      const live = (await inspect(unit)).fp;
      if (live !== fingerprintOf(unit, expectSide)) throw new Error(`Changed during operation; stopped before writing ${toPosix(unit.path)}`);
      created.push(...await apply(unit, side));
      done.push(unit);
    }
  } catch (error) {
    error.done = done;
    error.created = created;
    throw error;
  }
  return created;
}

/** Apply a previously computed plan. Re-verifies every unit first. */
export async function applyPlan(store, planned) {
  if (planned.blocked.length) throw new Error(`Plan is blocked:\n  ${planned.blocked.join('\n  ')}`);
  if (!planned.units.length) return {changed: false, message: 'Already up to date; nothing to write.'};
  const fresh = await previewFiles(planned.units, 'after');
  if (JSON.stringify(fresh.map(f => f.diff)) !== JSON.stringify(planned.files.map(f => f.diff)))
    throw new Error('Files changed since the preview; preview again before applying.');
  const opId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${planned.id.slice(0, 8)}`;
  const backupDir = await backup(store, opId, planned.units);
  const units = planned.units.map(unit => ({...unit}));
  let created;
  try { created = await writeUnits(units, 'after', 'before'); }
  catch (error) {
    // Roll back what this operation already wrote, newest first.
    for (const unit of [...(error.done ?? [])].reverse()) await apply(unit, 'before').catch(() => {});
    for (const dir of [...(error.created ?? [])].reverse()) await rmdirIfEmpty(dir);
    throw new Error(`${error.message}\nWritten units were reverted; backup kept at ${backupDir}`);
  }
  // Files this switch removed may leave directories an earlier operation created.
  const before = await store.target(planned.key);
  await pruneDirs(units, new Set((before?.stack ?? []).flatMap(op => op.createdDirs ?? []).map(dir => dir.toLowerCase())));
  const op = {id: opId, kind: planned.kind, at: new Date().toISOString(), recipe: planned.recipe, backup: backupDir,
    createdDirs: created.map(toPosix), forced: planned.force || undefined, units: units.map(serialize)};
  await store.update(state => {
    const target = state.targets[planned.key] ??= {harness: planned.harness, home: planned.home, stack: []};
    target.stack.push(op);
  });
  return {changed: true, op: opId, backup: backupDir, message: `${planned.kind === 'switch' ? 'Switched' : 'Installed'} ${planned.recipe?.key ?? ''}`};
}

async function pruneDirs(units, known) {
  for (const unit of units) {
    if (unit.type !== 'file' || unit.afterBytes !== null) continue;
    let dir = path.dirname(path.resolve(unit.path));
    while (known.has(toPosix(dir).toLowerCase()) && await rmdirIfEmpty(dir)) dir = path.dirname(dir);
  }
}

/** Preview undoing the top operation (rollback) or all operations (uninstall). */
export async function planUndo(store, harness, home, {all = false, force = false} = {}) {
  const key = targetKey(harness, home), target = await store.target(key);
  if (!target?.stack?.length) throw new Error(`Nothing installed by recipe-loader for ${harness} at ${toPosix(home)}`);
  const ops = all ? [...target.stack].reverse() : [target.stack.at(-1)];
  const drift = [], steps = [];
  for (const op of ops) steps.push({op, units: op.units.map(deserialize).reverse()});
  // Only the newest values are live; check those.
  const owned = ownedUnits(target);
  for (const [, {latest}] of owned) {
    if (!all && !ops[0].units.some(raw => identity(deserialize(raw)) === identity(latest))) continue;
    const live = (await inspect(latest)).fp;
    if (live !== fingerprintOf(latest, 'after')) drift.push({path: toPosix(latest.path), unit: describe(latest), live});
  }
  const flat = steps.flatMap(step => step.units);
  const files = await previewFiles(collapse(flat), 'before');
  const previous = all ? null : target.stack.at(-2)?.recipe ?? null;
  return {key, harness, home: toPosix(path.resolve(home)), kind: all ? 'uninstall' : 'rollback', ops: ops.map(op => op.id),
    restores: previous, files, drift, blocked: !force && drift.length ? drift.map(d => `hand edit detected: ${d.path} (${d.unit})`) : [], force};
}

/** Combine sequential undo steps per identity so previews show the end state. */
function collapse(units) {
  const byId = new Map();
  for (const unit of units) {
    const id = identity(unit), prior = byId.get(id);
    if (!prior) byId.set(id, {...unit});
    else {
      // Later (older op) before-values win; keep the newest after-values.
      if (unit.type === 'file') prior.beforeBytes = unit.beforeBytes;
      else if (unit.type === 'tomlKey') { prior.beforeLine = unit.beforeLine; prior.fileCreated = unit.fileCreated; }
      else if (unit.type === 'jsonKey') { prior.beforeValue = unit.beforeValue; prior.parentCreated = unit.parentCreated; }
      else { prior.beforePresent = unit.beforePresent; prior.fileCreated = unit.fileCreated; prior.createdDepth = unit.createdDepth; }
    }
  }
  return [...byId.values()];
}

export async function applyUndo(store, planned) {
  if (planned.blocked.length) throw new Error(`Blocked:\n  ${planned.blocked.join('\n  ')}`);
  const target = await store.target(planned.key);
  if (!target || JSON.stringify(planned.ops) !== JSON.stringify(planned.kind === 'uninstall' ? [...target.stack].reverse().map(o => o.id) : [target.stack.at(-1).id]))
    throw new Error('Installation state changed since the preview; preview again.');
  const ops = planned.kind === 'uninstall' ? [...target.stack].reverse() : [target.stack.at(-1)];
  const backupDir = await backup(store, `${new Date().toISOString().replace(/[:.]/g, '-')}-${planned.kind}`, ops.flatMap(op => op.units.map(deserialize)));
  for (const op of ops) {
    const units = op.units.map(deserialize).reverse();
    if (planned.force) for (const unit of units) await apply(unit, 'before');
    else await writeUnits(units, 'before', 'after');
    for (const dir of [...(op.createdDirs ?? [])].reverse()) await rmdirIfEmpty(dir);
    await store.update(state => {
      const live = state.targets[planned.key];
      live.stack.pop();
      if (!live.stack.length) delete state.targets[planned.key];
    });
  }
  return {changed: true, backup: backupDir, message: planned.kind === 'uninstall' ? 'Uninstalled; original state restored.'
    : planned.restores ? `Rolled back to ${planned.restores.key}` : 'Rolled back; original state restored.'};
}

/** Live status of a target: active recipe, history, drift. */
export async function status(store, harness, home) {
  const target = await store.target(targetKey(harness, home));
  if (!target?.stack?.length) return {installed: false, drift: [], history: []};
  const drift = [];
  for (const [, {latest}] of ownedUnits(target)) {
    const live = (await inspect(latest)).fp;
    if (live !== fingerprintOf(latest, 'after')) drift.push({path: toPosix(latest.path), unit: describe(latest), state: live === ABSENT ? 'missing' : 'edited'});
  }
  const top = target.stack.at(-1);
  return {installed: true, recipe: top.recipe, since: top.at, drift,
    history: target.stack.map(op => ({id: op.id, kind: op.kind, at: op.at, recipe: op.recipe?.key, backup: op.backup})).reverse()};
}

export {fs};
