// Harnesses served by the loader's own built-in plugin: Pi and DeepSeek
// Harness (DSH). The plugin is installed once per target; switching a recipe
// rewrites only its recipe.json snapshot, which the plugin re-reads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exists, toPosix} from '../fsx.mjs';
import {fileUnit, jsonItemUnit, readJson, homeDir} from './common.mjs';

const PLUGINS = fileURLToPath(new URL('../../plugins/', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';

export function snapshot(recipe, scope = {}) {
  return json({managedBy: 'recipe-loader',
    recipe: {id: recipe.id, name: recipe.name, version: recipe.version, revision: recipe.revision, origin: recipe.origin},
    scope, texts: recipe.texts});
}
const readPlugin = (dir, file) => fs.readFile(path.join(PLUGINS, dir, file));
async function readSnapshot(file) { const value = await readJson(file); return value?.managedBy === 'recipe-loader' ? value : null; }

export const pi = {
  id: 'pi', name: 'Pi', mechanism: 'Built-in recipe-loader extension (auto-discovered user extension)',
  steer: 'User, Sub and completed-result Steer through the extension',
  resolveHome: env => path.resolve(env.PI_CODING_AGENT_DIR || path.join(homeDir(env), '.pi', 'agent')),
  options: [{key: 'providers', label: 'Providers (comma separated, empty = all)', type: 'text'},
    {key: 'modelIdPattern', label: 'Model id regex (empty = all)', type: 'text'}],
  async detect(home) {
    const present = await exists(home), foreign = [];
    const settings = await readJson(path.join(home, 'settings.json'));
    for (const entry of [...(settings?.packages ?? []), ...(settings?.extensions ?? [])]) {
      const source = typeof entry === 'string' ? entry : entry?.source;
      if (typeof source === 'string' && /gpt-with-taste/i.test(source))
        foreign.push({what: 'gpt-with-taste Pi package', detail: `settings.json loads ${source}; two behavior extensions would both inject`, blocking: true});
    }
    const ext = path.join(home, 'extensions');
    for (const name of await fs.readdir(ext).catch(() => [])) {
      if (name === 'recipe-loader') continue;
      const manifest = await readJson(path.join(ext, name, 'package.json'));
      if (manifest?.name?.startsWith('gpt-with-taste')) foreign.push({what: 'gpt-with-taste Pi extension', detail: `extensions/${name}`, blocking: true});
    }
    const snap = await readSnapshot(path.join(ext, 'recipe-loader', 'recipe.json'));
    return {present, live: snap ? [{label: `${snap.recipe.name} ${snap.recipe.version}`, where: 'extensions/recipe-loader', revision: snap.recipe.revision}] : [], foreign};
  },
  async desired(recipe, home, options = {}) {
    const dir = path.join(home, 'extensions', 'recipe-loader'), units = [];
    const scope = {};
    if (options.providers) scope.providers = String(options.providers).split(',').map(s => s.trim()).filter(Boolean);
    if (options.modelIdPattern) { new RegExp(options.modelIdPattern); scope.modelIdPattern = options.modelIdPattern; }
    for (const file of ['runtime.mjs', 'projection.mjs', 'payload.mjs', 'THIRD_PARTY_LICENSE'])
      units.push(fileUnit(path.join(dir, file), await readPlugin('pi', file)));
    units.push(fileUnit(path.join(dir, 'index.js'), "// recipe-loader built-in entry (main role).\nexport {default, createRecipeExtension} from './runtime.mjs';\n"));
    for (const role of ['sub', 'independent']) units.push(fileUnit(path.join(dir, `${role}.js`),
      `// Explicit-role entry for integrations; not auto-loaded.\nimport {createRecipeExtension} from './runtime.mjs';\nexport default createRecipeExtension({role: '${role}'});\n`));
    units.push(fileUnit(path.join(dir, 'package.json'), json({name: 'recipe-loader-pi', private: true, type: 'module',
      description: 'Managed by recipe-loader. Switch recipes with the loader; uninstall restores the previous state.', pi: {extensions: ['./index.js']}})));
    units.push(fileUnit(path.join(dir, 'recipe.json'), snapshot(recipe, scope)));
    return {units, notes: ['Pi re-reads recipe.json on the next request; run /reload or start a new session after installing the extension.',
      Object.keys(scope).length ? `Scope: ${JSON.stringify(scope)}` : 'Scope: every model (set providers / model pattern to narrow it).']};
  },
};

const PKG = 'dsh-recipe-loader';
export const dsh = {
  id: 'dsh', name: 'DeepSeek Harness', mechanism: 'Built-in recipe-loader Cordis bundle, one per profile',
  steer: 'User, coordinator and subagent-report Steer at agent/pre-step',
  multi: true,
  resolveHome: env => path.resolve(env.DSH_HOME?.trim() ? env.DSH_HOME : path.join(homeDir(env), '.dsh')),
  /** Each profile is its own install target. */
  async instances(home) {
    const dir = path.join(home, 'profiles');
    const names = [];
    for (const entry of await fs.readdir(dir, {withFileTypes: true}).catch(() => []))
      if (entry.isDirectory() && entry.name !== 'node_modules' && await exists(path.join(dir, entry.name, 'package.json'))) names.push(entry.name);
    return names.sort().map(name => ({label: `profile ${name}`, home: path.join(dir, name)}));
  },
  options: [{key: 'rootRole', label: 'Root role', type: 'select', choices: ['main', 'independent']}],
  async detect(profile) {
    const manifest = await readJson(path.join(profile, 'package.json')), foreign = [];
    const bundles = manifest?.dsh?.profile?.bundles ?? [];
    if (bundles.includes('dsh-gpt-with-taste')) foreign.push({what: 'dsh-gpt-with-taste bundle', detail: 'mounted in this profile; both would inject behavior text', blocking: true});
    if (bundles.includes('dsh-kiki-recipe')) foreign.push({what: 'dsh-kiki-recipe bundle', detail: 'Kiki Recipes bound there would stack with this recipe', blocking: false});
    const snap = await readSnapshot(path.join(profile, 'node_modules', PKG, 'recipe.json'));
    return {present: manifest !== null, live: snap ? [{label: `${snap.recipe.name} ${snap.recipe.version}`, where: `node_modules/${PKG}`, revision: snap.recipe.revision}] : [], foreign};
  },
  async desired(recipe, profile, options = {}) {
    const manifest = await readJson(path.join(profile, 'package.json'));
    if (!manifest) throw new Error(`${toPosix(profile)}/package.json is missing or not valid JSON`);
    const rootRole = options.rootRole ?? 'main';
    if (!['main', 'independent'].includes(rootRole)) throw new Error('rootRole must be main or independent');
    const files = new Map([
      ['index.mjs', await readPlugin('dsh', 'index.mjs')],
      ['LICENSE', await fs.readFile(path.join(PLUGINS, '..', 'LICENSE'))],
      ['package.json', Buffer.from(json({name: PKG, version: '1.0.0', private: true, type: 'module', main: './index.mjs',
        description: 'Managed by recipe-loader.', exports: {'.': './index.mjs'},
        peerDependencies: {'@deepseek-ai/dsh-llm': '>=0.1.0-rc.6 <0.2.0'}, dsh: {bundle: {patch: './cordis.patch.yml'}}}))],
      ['cordis.patch.yml', Buffer.from(`# Managed by recipe-loader.\n- insert:\n    - id: recipe-loader\n      name: ${PKG}\n      config:\n        rootRole: ${rootRole}\n`)],
      ['recipe.json', Buffer.from(snapshot(recipe))],
    ]);
    const units = [];
    // The source copy keeps a later `pnpm install` from pruning the mounted package.
    for (const base of [path.join(profile, '.recipe-loader', PKG), path.join(profile, 'node_modules', PKG)])
      for (const [rel, bytes] of files) units.push(fileUnit(path.join(base, rel), bytes));
    units.push({type: 'jsonKey', path: path.join(profile, 'package.json'), pointer: ['dependencies', PKG], afterValue: `file:.recipe-loader/${PKG}`});
    units.push(jsonItemUnit(path.join(profile, 'package.json'), ['dsh', 'profile', 'bundles'], PKG));
    return {units, notes: ['Takes effect in the next DSH process started with this profile; a running process keeps its plugin generation.',
      'Switching later rewrites only recipe.json; the plugin re-reads it before each step.']};
  },
};
