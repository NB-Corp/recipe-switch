// Recipe sources. A recipe is a Kiki Recipe package (recipe.toml), optionally
// with [options] that the user toggles. Recipe Switch turns one choice of options into
// the six behavior texts (main, sub, independent, userSteer, subSteer,
// agentSteer). Harness artifacts come from gpt-with-taste's adapters (or its
// committed dist/ for the default choice); Recipe Switch never compiles behavior itself.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {exists, listFiles, toPosix} from './fsx.mjs';
import {readRecipeToml, optionValues, evaluate, sixTexts, revisionOf} from './recipe-toml.mjs';

export const TEXT_KEYS = ['main', 'sub', 'independent', 'userSteer', 'subSteer', 'agentSteer'];
const GWT_TARGETS = ['codex', 'kiki', 'claude', 'pi', 'omp', 'dsh'];

async function readDist(root, target) {
  const dir = path.join(root, 'dist', target), out = new Map();
  for (const rel of await listFiles(dir)) out.set(rel, await fs.readFile(path.join(dir, rel)));
  return out;
}

/**
 * Load a recipe.toml. The result is the recipe at its default options; call
 * `withOptions(selection)` for another choice. `authorRoot` marks a
 * gpt-with-taste-style repo whose committed dist/ is the default build.
 */
async function loadPackage(file, {gwtRoot, authorRoot} = {}) {
  const parsed = await readRecipeToml(file), raw = parsed.raw;
  const info = {id: raw.id, name: raw.name ?? raw.id, version: raw.version ?? '0.0.0', description: raw.description ?? ''};
  const adapters = authorRoot ?? gwtRoot;
  const build = async (selection = {}) => {
    const {values, unknown} = optionValues(parsed.options, selection);
    const {manifest, toml, texts: slotTexts, files} = await evaluate(parsed, values);
    const texts = sixTexts(manifest, slotTexts);
    const isDefault = parsed.options.every(option => values[option.id] === option.default);
    return {
      kind: authorRoot ? 'author-repo' : 'kiki-recipe', ...info,
      origin: toPosix(authorRoot ?? file), texts, gwtRoot: adapters,
      revision: revisionOf(toml, files, values),
      options: parsed.options, optionValues: values, unknownOptions: unknown,
      kikiPackage: {entry: 'recipe.toml', files: new Map([['recipe.toml', Buffer.from(toml)], ...files])},
      async artifacts(target) {
        if (authorRoot && isDefault && GWT_TARGETS.includes(target) && await exists(path.join(authorRoot, 'dist', target))) return readDist(authorRoot, target);
        return renderWithAdapters(adapters, target, info, texts);
      },
      withOptions: build,
    };
  };
  return build();
}

/** Legacy gpt-with-taste layout: recipe/manifest.json + six Markdown files. */
async function loadLegacyAuthorRepo(root) {
  const {loadRecipe} = await import(pathToFileURL(path.join(root, 'src/build.mjs')).href);
  const {meta, texts} = await loadRecipe(root, ['codex']);
  const {sha256} = await import('./fsx.mjs');
  const revision = 'sha256:' + sha256(Buffer.from(JSON.stringify(TEXT_KEYS.map(key => texts[key] ?? null)))).slice(0, 16);
  const recipe = {
    kind: 'author-repo', id: meta.id, name: meta.name, version: meta.version, description: meta.description ?? '',
    origin: toPosix(root), texts, revision, gwtRoot: root, options: [], optionValues: {}, unknownOptions: [],
    async artifacts(target) {
      if (!GWT_TARGETS.includes(target)) throw new Error(`No ${target} artifacts in ${root}`);
      const files = await readDist(root, target);
      if (!files.size) throw new Error(`Missing dist/${target} in ${root}; run node scripts/build.mjs --target ${target}`);
      return files;
    },
    withOptions: async () => recipe,
  };
  return recipe;
}

/** Render one gpt-with-taste adapter with another recipe's texts. */
export async function renderWithAdapters(gwtRoot, target, info, texts) {
  if (!gwtRoot) throw new Error('A gpt-with-taste checkout is required to render adapters (sources --gwt)');
  if (!GWT_TARGETS.includes(target)) throw new Error(`Unknown adapter target: ${target}`);
  const {render} = await import(pathToFileURL(path.join(gwtRoot, 'adapters', target, 'build.mjs')).href);
  const files = Object.fromEntries(TEXT_KEYS.map(key => [key, `${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}.md`]));
  const meta = {schemaVersion: 1, ...info, texts: files, compatibility: {kiki: {version: info.version, packages: []}}};
  const filled = Object.fromEntries(TEXT_KEYS.map(key => [key, texts[key] ?? '']));
  const out = await render({root: gwtRoot, meta, texts: filled, kikiPackages: []});
  return new Map([...out].map(([rel, value]) => [rel, Buffer.from(value)]));
}

const isRecipeFile = name => name.endsWith('.toml') && name !== 'mapping.toml';

/** Resolve a source locator to one or more recipes. */
export async function loadSource(locator, {gwtRoot} = {}) {
  const target = path.resolve(locator);
  const stat = await fs.stat(target);
  if (stat.isDirectory() && await exists(path.join(target, 'recipe/recipe.toml')))
    return [await loadPackage(path.join(target, 'recipe/recipe.toml'), {authorRoot: target})];
  if (stat.isDirectory() && await exists(path.join(target, 'recipe/manifest.json'))) return [await loadLegacyAuthorRepo(target)];
  if (stat.isFile() && target.endsWith('.toml')) return [await loadPackage(target, {gwtRoot})];
  if (stat.isDirectory()) {
    if (await exists(path.join(target, 'recipe.toml'))) return [await loadPackage(path.join(target, 'recipe.toml'), {gwtRoot})];
    const out = [];
    for (const entry of (await fs.readdir(target, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(target, entry.name);
      if (entry.isFile() && isRecipeFile(entry.name)) out.push(await loadPackage(child, {gwtRoot}));
      else if (entry.isDirectory())
        for (const file of (await fs.readdir(child)).filter(isRecipeFile).sort()) out.push(await loadPackage(path.join(child, file), {gwtRoot}));
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
    try { for (const recipe of await loadSource(locator, {gwtRoot})) recipes.push(recipe); }
    catch (error) { errors.push({locator: toPosix(locator), error: error.message}); }
  }
  const seen = new Set();
  for (const recipe of recipes) {
    let key = `${recipe.id}@${recipe.version}`;
    if (seen.has(key)) key = `${key}#${recipe.revision.slice(7, 13)}`;
    seen.add(key);
    recipe.key = key;
  }
  return {recipes, errors};
}
