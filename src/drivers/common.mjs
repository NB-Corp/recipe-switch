// Shared driver helpers. A driver turns (recipe, home, options) into desired
// write units and reports detection, foreign installations and current state.
import os from 'node:os';
import path from 'node:path';
import {exists, readFile, decode, toPosix} from '../fsx.mjs';
import {MARK} from '../engine.mjs';

export const homeDir = env => env.USERPROFILE && process.platform === 'win32' ? env.USERPROFILE : (env.HOME || os.homedir());

export function fileUnit(file, bytes) {
  return {type: 'file', path: path.resolve(file), afterBytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)};
}

export function tomlKeyUnit(file, table, key, value) {
  return {type: 'tomlKey', path: path.resolve(file), table, key,
    afterLine: `${key} = ${JSON.stringify(toPosix(value))} # ${MARK}`};
}

export function jsonItemUnit(file, pointer, value) {
  return {type: 'jsonArrayItem', path: path.resolve(file), pointer, value, afterPresent: true};
}

/** Files of a built artifact Map placed under dir, optionally filtered/renamed. */
export function placeFiles(dir, files, {only, rename = {}} = {}) {
  const units = [];
  for (const [rel, bytes] of files) {
    if (only && !only(rel)) continue;
    units.push(fileUnit(path.join(dir, rename[rel] ?? rel), bytes));
  }
  return units;
}

export async function readJson(file) {
  const bytes = await readFile(file);
  if (bytes === null) return null;
  try { return JSON.parse(decode(bytes).replace(/^\uFEFF/, '')); } catch { return undefined; }
}

export async function dirExists(dir) { return exists(dir); }

export const marker = recipe => JSON.stringify({
  managedBy: 'recipe-switch', recipe: recipe.id, name: recipe.name, version: recipe.version,
  revision: recipe.revision, origin: recipe.origin,
}, null, 2) + '\n';
