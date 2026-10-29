// Recipe sources. A recipe is the six-text behavior contract used by
// gpt-with-taste (main, sub, independent, userSteer, subSteer, agentSteer).
// Harness artifacts come from gpt-with-taste's own dist/ or adapters/ — this
// module never compiles behavior itself.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256, exists, listFiles, toPosix} from './fsx.mjs';

export const TEXT_KEYS = ['main', 'sub', 'independent', 'userSteer', 'subSteer', 'agentSteer'];
const GWT_TARGETS = ['codex', 'kiki', 'claude', 'pi', 'omp', 'dsh'];

function revisionOf(texts, extra = '') {
  return 'sha256:' + sha256(Buffer.from(JSON.stringify(TEXT_KEYS.map(key => texts[key] ?? null)) + extra)).slice(0, 16);
}

/** gpt-with-taste style: <root>/recipe/manifest.json + committed dist/<target>/. */
async function loadAuthorRepo(root) {
  const {loadRecipe} = await import(pathToFileURL(path.join(root, 'src/build.mjs')).href);
  const {meta, texts} = await loadRecipe(root, ['codex']);
  const recipe = {
    kind: 'author-repo', id: meta.id, name: meta.name, version: meta.version,
    description: meta.description ?? '', origin: toPosix(root), texts,
    revision: revisionOf(texts), gwtRoot: root,
    /** Pre-built artifacts are authoritative for the author repo itself. */
    async artifacts(target) {
      if (!GWT_TARGETS.includes(target)) throw new Error(`No ${target} artifacts in ${root}`);
      const dir = path.join(root, 'dist', target), files = new Map();
      for (const rel of await listFiles(dir)) files.set(rel, await fs.readFile(path.join(dir, rel)));
      if (!files.size) throw new Error(`Missing dist/${target} in ${root}; run node scripts/build.mjs --target ${target}`);
      return files;
    },
  };
  return recipe;
}

// Minimal reader for the Kiki Recipe fields the loader needs. Values are
// `{ file = "x.md" }`, `{ text = "..." }` or "off"; other keys are ignored.
function tables(text) {
  const out = new Map();
  let current = '';
  out.set('', []);
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
    if (header) { current = header[1].trim(); if (!out.has(current)) out.set(current, []); continue; }
    out.get(current).push(line);
  }
  return out;
}
const STRING = '"((?:[^"\\\\]|\\\\.)*)"';
function slot(lines, key) {
  for (const line of lines ?? []) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (!match) continue;
    const value = match[1].trim();
    if (value.startsWith('"off"')) return {off: true};
    const inline = value.match(new RegExp(`^\\{\\s*(file|text)\\s*=\\s*${STRING}\\s*\\}`));
    if (inline) return {[inline[1]]: JSON.parse(`"${inline[2]}"`)};
    if (value.startsWith('{')) {
      const nested = value.match(new RegExp(`steering\\s*=\\s*\\{\\s*(file|text)\\s*=\\s*${STRING}\\s*\\}`));
      if (nested) return {[nested[1]]: JSON.parse(`"${nested[2]}"`)};
    }
    throw new Error(`Unsupported value for ${key}: ${value.slice(0, 60)} (use { file = ... } or { text = ... })`);
  }
  return undefined;
}

/** Kiki Recipe package: <dir>/<name>.toml with Markdown files beside it. */
async function loadKikiRecipe(file, gwtRoot) {
  const dir = path.dirname(file), source = await fs.readFile(file, 'utf8'), t = tables(source);
  const head = key => { const m = source.match(new RegExp(`^${key}\\s*=\\s*${STRING}`, 'm')); return m ? JSON.parse(`"${m[1]}"`) : undefined; };
  const id = head('id'), name = head('name') ?? id, version = head('version') ?? '0.0.0';
  if (!id) throw new Error(`${file}: missing top-level id`);
  const read = async value => {
    if (!value || value.off) return null;
    if (value.text !== undefined) return value.text;
    const target = path.resolve(dir, value.file);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`${file}: file escapes package: ${value.file}`);
    return fs.readFile(target, 'utf8');
  };
  const common = await read(slot(t.get('prompts'), 'system'));
  const main = await read(slot(t.get('prompts.main'), 'system')) ?? common;
  const independent = await read(slot(t.get('prompts.independent'), 'system')) ?? common ?? main;
  const userSteer = await read(slot(t.get('prompts.main'), 'steering'));
  const subSteer = await read(slot(t.get('prompts'), 'steering'));
  const agentSteer = await read(slot(t.get('prompts.main.steering_sources.agent'), 'custom')) ?? userSteer;
  if (!main) throw new Error(`${file}: no main or common system text`);
  const texts = {main, sub: common ?? main, independent, userSteer, subSteer, agentSteer};
  const ownFiles = new Map([[path.basename(file), Buffer.from(source)]]);
  for (const match of source.matchAll(new RegExp(`file\\s*=\\s*${STRING}`, 'g'))) {
    const rel = JSON.parse(`"${match[1]}"`);
    ownFiles.set(rel, await fs.readFile(path.resolve(dir, rel)));
  }
  return {
    kind: 'kiki-recipe', id, name, version, description: head('description') ?? '',
    origin: toPosix(file), texts, revision: revisionOf(texts, source), gwtRoot,
    kikiPackage: {entry: path.basename(file), files: ownFiles},
    artifacts: target => renderWithAdapters(gwtRoot, target, {id, name, version, description: head('description') ?? ''}, texts),
  };
}

/** Render one gpt-with-taste adapter with another recipe's texts. */
export async function renderWithAdapters(gwtRoot, target, info, texts) {
  if (!gwtRoot) throw new Error('A gpt-with-taste checkout is required to render adapters (--gwt)');
  if (!GWT_TARGETS.includes(target)) throw new Error(`Unknown adapter target: ${target}`);
  const {render} = await import(pathToFileURL(path.join(gwtRoot, 'adapters', target, 'build.mjs')).href);
  const files = Object.fromEntries(TEXT_KEYS.map(key => [key, `${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}.md`]));
  const meta = {schemaVersion: 1, ...info, texts: files, compatibility: {kiki: {version: info.version, packages: []}}};
  const filled = Object.fromEntries(TEXT_KEYS.map(key => [key, texts[key] ?? '']));
  const out = await render({root: gwtRoot, meta, texts: filled, kikiPackages: []});
  return new Map([...out].map(([rel, value]) => [rel, Buffer.from(value)]));
}

/** Resolve a source locator to one or more recipes. */
export async function loadSource(locator, {gwtRoot} = {}) {
  const target = path.resolve(locator);
  const stat = await fs.stat(target);
  if (stat.isDirectory() && await exists(path.join(target, 'recipe/manifest.json'))) return [await loadAuthorRepo(target)];
  if (stat.isFile() && target.endsWith('.toml')) return [await loadKikiRecipe(target, gwtRoot)];
  if (stat.isDirectory()) {
    const out = [];
    for (const entry of (await fs.readdir(target, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(target, entry.name);
      if (entry.isFile() && entry.name.endsWith('.toml') && entry.name !== 'mapping.toml') out.push(await loadKikiRecipe(child, gwtRoot));
      else if (entry.isDirectory()) {
        for (const file of (await fs.readdir(child)).filter(name => name.endsWith('.toml')).sort())
          out.push(await loadKikiRecipe(path.join(child, file), gwtRoot));
      }
    }
    if (!out.length) throw new Error(`No recipes found in ${target}`);
    return out;
  }
  throw new Error(`Unsupported recipe source: ${target}`);
}

/** Load all configured sources; a broken source is reported, not fatal. */
export async function loadCatalog(locators, {gwtRoot} = {}) {
  const recipes = [], errors = [];
  for (const locator of locators) {
    try { for (const recipe of await loadSource(locator, {gwtRoot})) recipes.push({...recipe, key: `${recipe.id}@${recipe.version}`}); }
    catch (error) { errors.push({locator: toPosix(locator), error: error.message}); }
  }
  const seen = new Map();
  for (const recipe of recipes) {
    if (seen.has(recipe.key)) recipe.key = `${recipe.key}#${recipe.revision.slice(7, 13)}`;
    seen.set(recipe.key, recipe);
  }
  return {recipes, errors};
}
