// Test helpers: every test gets its own sandbox of fake harness homes under
// this repository's .tmp/. No test reads or writes a real user home.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeSandbox} from '../scripts/demo.mjs';
import {Service} from '../src/service.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GWT = process.env.RECIPE_SWITCH_GWT || path.resolve(ROOT, '..', 'gpt-with-taste');
export const KIKI_RECIPES = path.resolve(ROOT, '..', 'kimi', 'recipes');

export async function sandbox(t, {sources} = {}) {
  const base = path.join(ROOT, '.tmp', 'test');
  await fs.mkdir(base, {recursive: true});
  const dir = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const env = await makeSandbox(dir);
  // Isolate from the real machine: no HOME/USERPROFILE fallback can resolve outside dir.
  const fullEnv = {...env, HOME: path.join(dir, 'user'), USERPROFILE: path.join(dir, 'user'), XDG_CONFIG_HOME: path.join(dir, 'xdg')};
  const service = new Service({env: fullEnv, home: env.RECIPE_SWITCH_HOME});
  await service.saveConfig({gwt: GWT, sources: sources ?? [GWT, ...(await exists(KIKI_RECIPES) ? [KIKI_RECIPES] : [])]});
  return {dir, env: fullEnv, service, read: rel => fs.readFile(path.join(dir, rel), 'utf8'), file: rel => path.join(dir, rel)};
}

export const exists = target => fs.access(target).then(() => true, () => false);

/** Snapshot every file under dir (excluding loader state) as {rel: bytes-hex}. */
export async function tree(dir, skip = ['state']) {
  const out = {};
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, {withFileTypes: true})) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && skip.includes(entry.name)) continue;
      if (entry.isDirectory()) { out[rel + '/'] = 'dir'; await walk(path.join(current, entry.name), rel); }
      else out[rel] = (await fs.readFile(path.join(current, entry.name))).toString('hex');
    }
  }
  await walk(dir, '');
  return out;
}

export async function install(service, harness, recipe, extra = {}) {
  const planned = await service.preview({harness, recipe, ...extra});
  if (planned.blocked.length) throw new Error(`blocked: ${planned.blocked.join('; ')}`);
  return {planned, result: await service.apply(planned.id)};
}

export async function undo(service, harness, extra = {}) {
  const planned = await service.previewUndo({harness, ...extra});
  if (planned.blocked.length) throw new Error(`blocked: ${planned.blocked.join('; ')}`);
  return {planned, result: await service.applyUndo(planned.id)};
}
