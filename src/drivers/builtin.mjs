// Harnesses served by the loader's own built-in plugin: Pi and DeepSeek
// Harness (DSH). The plugin is installed once per target; switching a recipe
// rewrites only its recipe.json snapshot, which the plugin re-reads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exists, toPosix, displayPath} from '../fsx.mjs';
import {fileUnit, jsonItemUnit, readJson, homeDir} from './common.mjs';
import {note} from '../i18n.mjs';

const PLUGINS = fileURLToPath(new URL('../../plugins/', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';

export function snapshot(recipe, scope = {}) {
  return json({managedBy: 'recipe-switch',
    recipe: {id: recipe.id, name: recipe.name, version: recipe.version, revision: recipe.revision, origin: recipe.origin},
    scope, texts: recipe.texts});
}
const readPlugin = (dir, file) => fs.readFile(path.join(PLUGINS, dir, file));
async function readSnapshot(file) { const value = await readJson(file); return value?.managedBy === 'recipe-switch' ? value : null; }

export const pi = {
  id: 'pi', name: 'Pi', mechanism: note('mechanism.pi'),
  steer: note('steer.pi'),
  resolveHome: env => path.resolve(env.PI_CODING_AGENT_DIR || path.join(homeDir(env), '.pi', 'agent')),
  options: [{key: 'providers', label: 'Providers (comma separated, empty = all)', type: 'text'},
    {key: 'modelIdPattern', label: 'Model id regex (empty = all)', type: 'text'}],
  async detect(home) {
    const present = await exists(home), foreign = [];
    const settings = await readJson(path.join(home, 'settings.json'));
    for (const entry of [...(settings?.packages ?? []), ...(settings?.extensions ?? [])]) {
      const source = typeof entry === 'string' ? entry : entry?.source;
      if (typeof source === 'string' && /gpt-with-taste/i.test(source))
        foreign.push({what: note('foreign.pi.gwtPackage', {source: displayPath(toPosix(source))}), detail: note('foreign.pi.gwtPackageDetail', {source: displayPath(toPosix(source))}), blocking: true});
    }
    const ext = path.join(home, 'extensions');
    for (const name of await fs.readdir(ext).catch(() => [])) {
      if (name === 'recipe-switch') continue;
      const manifest = await readJson(path.join(ext, name, 'package.json'));
      if (manifest?.name?.startsWith('gpt-with-taste')) foreign.push({what: note('foreign.pi.gwtExtension', {name}), detail: `extensions/${name}`, blocking: true});
    }
    const snap = await readSnapshot(path.join(ext, 'recipe-switch', 'recipe.json'));
    return {present, live: snap ? [{label: `${snap.recipe.name} ${snap.recipe.version}`, where: 'extensions/recipe-switch', revision: snap.recipe.revision}] : [], foreign};
  },
  async desired(recipe, home, options = {}) {
    const dir = path.join(home, 'extensions', 'recipe-switch'), units = [];
    const scope = {};
    if (options.providers) scope.providers = String(options.providers).split(',').map(s => s.trim()).filter(Boolean);
    if (options.modelIdPattern) { new RegExp(options.modelIdPattern); scope.modelIdPattern = options.modelIdPattern; }
    for (const file of ['runtime.mjs', 'projection.mjs', 'payload.mjs', 'THIRD_PARTY_LICENSE'])
      units.push(fileUnit(path.join(dir, file), await readPlugin('pi', file)));
    units.push(fileUnit(path.join(dir, 'index.js'), "// recipe-switch built-in entry (main role).\nexport {default, createRecipeExtension} from './runtime.mjs';\n"));
    for (const role of ['sub', 'independent']) units.push(fileUnit(path.join(dir, `${role}.js`),
      `// Explicit-role entry for integrations; not auto-loaded.\nimport {createRecipeExtension} from './runtime.mjs';\nexport default createRecipeExtension({role: '${role}'});\n`));
    units.push(fileUnit(path.join(dir, 'package.json'), json({name: 'recipe-switch-pi', private: true, type: 'module',
      description: 'Managed by recipe-switch. Switch recipes with the loader; uninstall restores the previous state.', pi: {extensions: ['./index.js']}})));
    units.push(fileUnit(path.join(dir, 'recipe.json'), snapshot(recipe, scope)));
    return {units, notes: [note('pi.note.reload'),
      Object.keys(scope).length ? note('pi.note.scope', {scope: JSON.stringify(scope)}) : note('pi.note.scopeAll')]};
  },
};

const PKG = 'dsh-recipe-switch';
export const dsh = {
  id: 'dsh', name: 'DeepSeek Harness', mechanism: note('mechanism.dsh'),
  steer: note('steer.dsh'),
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
    if (bundles.includes('dsh-gpt-with-taste')) foreign.push({what: note('foreign.dsh.gwtBundle'), detail: note('foreign.dsh.gwtBundleDetail'), blocking: true});
    if (bundles.includes('dsh-kiki-recipe')) foreign.push({what: note('foreign.dsh.kikiBundle'), detail: note('foreign.dsh.kikiBundleDetail'), blocking: false});
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
        description: 'Managed by recipe-switch.', exports: {'.': './index.mjs'},
        peerDependencies: {'@deepseek-ai/dsh-llm': '>=0.1.0-rc.6 <0.2.0'}, dsh: {bundle: {patch: './cordis.patch.yml'}}}))],
      ['cordis.patch.yml', Buffer.from(`# Managed by recipe-switch.\n- insert:\n    - id: recipe-switch\n      name: ${PKG}\n      config:\n        rootRole: ${rootRole}\n`)],
      ['recipe.json', Buffer.from(snapshot(recipe))],
    ]);
    const units = [];
    // The source copy keeps a later `pnpm install` from pruning the mounted package.
    for (const base of [path.join(profile, '.recipe-switch', PKG), path.join(profile, 'node_modules', PKG)])
      for (const [rel, bytes] of files) units.push(fileUnit(path.join(base, rel), bytes));
    units.push({type: 'jsonKey', path: path.join(profile, 'package.json'), pointer: ['dependencies', PKG], afterValue: `file:.recipe-switch/${PKG}`});
    units.push(jsonItemUnit(path.join(profile, 'package.json'), ['dsh', 'profile', 'bundles'], PKG));
    return {units, notes: [note('dsh.note.nextProcess'), note('dsh.note.switchLight')]};
  },
};
