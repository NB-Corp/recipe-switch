// Harnesses whose native entry point is a file or one config key.
// Behavior artifacts come from the recipe source (gpt-with-taste dist/ or its
// adapters); this module only decides where they go.
import fs from 'node:fs/promises';
import path from 'node:path';
import {exists, readFile, decode, toPosix} from '../fsx.mjs';
import {readKeyLine, splitKey} from '../vendor/toml-key.mjs';
import {fileUnit, tomlKeyUnit, jsonItemUnit, placeFiles, readJson, homeDir, marker} from './common.mjs';
import {MARK} from '../engine.mjs';

const own = line => line?.includes(MARK);
const keyValue = line => line?.match(/=\s*(["'])(.*?)\1/)?.[2] ?? null;

// ---------------------------------------------------------------- Codex
export const codex = {
  id: 'codex', name: 'OpenAI Codex', mechanism: 'model_instructions_file in config.toml → managed main.md',
  steer: 'None from the loader; gpt-with-taste\'s own --hooks plugin remains the Steer route',
  resolveHome: env => path.resolve(env.CODEX_HOME || path.join(homeDir(env), '.codex')),
  async detect(home, {gwtRoot} = {}) {
    const config = await readFile(path.join(home, 'config.toml')), foreign = [], live = [];
    const line = config === null ? null : readKeyLine(decode(config), [], 'model_instructions_file');
    if (line && !own(line)) {
      const target = keyValue(line);
      const viaInstaller = target && /prompts\/gpt-with-taste\/main\.md$/.test(toPosix(target));
      foreign.push({what: viaInstaller ? 'gpt-with-taste install.mjs' : 'existing model_instructions_file',
        detail: viaInstaller ? `${target} (restore it with gpt-with-taste scripts/install.mjs --restore before the loader takes over)` : target,
        blocking: Boolean(viaInstaller)});
      live.push({label: viaInstaller ? 'gpt-with-taste (installer)' : 'custom instructions', where: target});
    }
    if (gwtRoot) {
      const receipt = await readJson(path.join(gwtRoot, '.gpt-with-taste', 'install-receipt.json'));
      if (receipt?.status === 'applied' && path.resolve(receipt.home) === path.resolve(home) && !foreign.some(f => f.blocking))
        foreign.push({what: 'gpt-with-taste install receipt', detail: `active receipt for this home in ${toPosix(gwtRoot)}`, blocking: true});
    }
    return {present: await exists(home), live, foreign};
  },
  async desired(recipe, home) {
    const files = await recipe.artifacts('codex'), dir = path.join(home, 'prompts', 'recipe-loader');
    const units = placeFiles(dir, files, {only: rel => ['main.md', 'sub.md'].includes(rel)});
    units.push(fileUnit(path.join(dir, 'recipe.json'), marker(recipe)));
    units.push(tomlKeyUnit(path.join(home, 'config.toml'), [], 'model_instructions_file', path.join(dir, 'main.md')));
    return {units, notes: ['Open a new Codex session. sub.md is installed for role composition (developer_instructions); the loader does not edit roles.']};
  },
};

// ---------------------------------------------------------------- Kiki
async function kikiModels(home) {
  const bytes = await readFile(path.join(home, 'config.toml'));
  if (bytes === null) return [];
  const out = [];
  for (const match of decode(bytes).matchAll(/^\s*\[models\.([^\]\n]+)\]\s*(?:#.*)?$/gm)) {
    const segments = splitKey(match[1]);
    if (segments.length === 1) out.push(segments[0]);
  }
  return out;
}
async function kikiInstallations(home) {
  const value = await readJson(path.join(home, 'store', 'recipes', 'installations'));
  const map = new Map();
  for (const [id, entry] of Object.entries(value ?? {})) map.set(id, `${entry.summary?.name ?? id} ${entry.summary?.version ?? ''}`.trim());
  return map;
}
export const kiki = {
  id: 'kiki', name: 'Kiki', mechanism: 'Recipe package + [models."<alias>"].recipe = <package path>',
  steer: 'Native Recipe steering (main/sub/independent branches, agent and task sources)',
  resolveHome: env => path.resolve(env.KIKI_HOME || path.join(homeDir(env), '.kiki')),
  options: [{key: 'models', label: 'Models to bind', type: 'multi', required: true}],
  async choices(home) { return {models: await kikiModels(home)}; },
  async detect(home) {
    const bytes = await readFile(path.join(home, 'config.toml')), installs = await kikiInstallations(home), live = [];
    if (bytes !== null) {
      const text = decode(bytes);
      for (const alias of await kikiModels(home)) {
        const line = readKeyLine(text, ['models', alias], 'recipe');
        if (!line) continue;
        const value = keyValue(line);
        live.push({label: own(line) ? `recipe-loader: ${path.basename(path.dirname(value))}` : installs.get(value) ?? value, where: `models.${alias}`, managed: own(line)});
      }
    }
    return {present: await exists(home), live, foreign: []};
  },
  async desired(recipe, home, options = {}) {
    const models = [].concat(options.models ?? []).filter(Boolean);
    if (!models.length) throw new Error('Kiki: choose at least one model (--models alias[,alias])');
    const known = await kikiModels(home);
    for (const alias of models) if (!known.includes(alias)) throw new Error(`Kiki: model ${alias} is not defined in config.toml`);
    const dir = path.join(home, 'recipe-loader', 'packages', recipe.id), units = [];
    if (recipe.kikiPackage) {
      for (const [rel, bytes] of recipe.kikiPackage.files) units.push(fileUnit(path.join(dir, rel), bytes));
    } else {
      const files = await recipe.artifacts('kiki');
      units.push(...placeFiles(dir, files, {only: rel => !rel.includes('/') && rel !== 'build-manifest.json'}));
    }
    const entry = path.join(dir, recipe.kikiPackage?.entry ?? 'recipe.toml');
    for (const alias of models) units.push(tomlKeyUnit(path.join(home, 'config.toml'), ['models', alias], 'recipe', entry));
    return {units, notes: ['New bindings use the recipe; an idle session adopts it after Rebuild context. Existing recipe values are restored on rollback/uninstall.']};
  },
};

// ---------------------------------------------------------------- Claude Code
export const claude = {
  id: 'claude', name: 'Claude Code', mechanism: 'Session-local: managed main.md + plugin dir passed at launch',
  steer: 'User, Sub and Agent Steer through the bundled plugin hooks',
  resolveHome: env => path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir(env), '.claude')),
  async detect(home) {
    const snap = await readJson(path.join(home, 'recipe-loader', 'recipe.json'));
    return {present: await exists(home), live: snap?.managedBy ? [{label: `${snap.name} ${snap.version}`, where: 'recipe-loader/'}] : [], foreign: []};
  },
  async desired(recipe, home) {
    const files = await recipe.artifacts('claude'), dir = path.join(home, 'recipe-loader');
    const units = placeFiles(dir, files, {only: rel => rel === 'main.md' || rel === 'independent.md' || rel.startsWith('plugin/')});
    units.push(fileUnit(path.join(dir, 'recipe.json'), marker(recipe)));
    const main = toPosix(path.join(dir, 'main.md')), plugin = toPosix(path.join(dir, 'plugin'));
    return {units, launch: `claude --append-system-prompt-file "${main}" --plugin-dir "${plugin}"`,
      notes: ['Claude Code settings are not edited. Start new sessions with the launch command; switching rewrites these files in place.']};
  },
};

// ---------------------------------------------------------------- OMP
export const omp = {
  id: 'omp', name: 'Oh My Pi', mechanism: 'User extension directory extensions/recipe-loader (gpt-with-taste OMP adapter)',
  steer: 'User, Sub and completed Task Steer through the adapter (GPT models by default)',
  resolveHome: env => path.resolve(env.OMP_CODING_AGENT_DIR || path.join(homeDir(env), '.omp', 'agent')),
  async detect(home) {
    const snap = await readJson(path.join(home, 'extensions', 'recipe-loader', 'recipe.json'));
    return {present: await exists(home), live: snap?.managedBy ? [{label: `${snap.name} ${snap.version}`, where: 'extensions/recipe-loader'}] : [], foreign: []};
  },
  async desired(recipe, home) {
    const files = await recipe.artifacts('omp'), dir = path.join(home, 'extensions', 'recipe-loader');
    const units = placeFiles(dir, files, {only: rel => rel !== 'build-manifest.json'});
    units.push(fileUnit(path.join(dir, 'recipe.json'), marker(recipe)));
    return {units, notes: ['Restart OMP. The adapter applies to openai / openai-codex gpt-* models, as in gpt-with-taste.']};
  },
};

// ---------------------------------------------------------------- Grok Build
export const grok = {
  id: 'grok', name: 'Grok Build', mechanism: 'Global rule file rules/recipe-loader.md (always loaded)',
  steer: 'None: Grok hooks cannot add model context',
  resolveHome: env => path.resolve(env.GROK_HOME?.trim() ? env.GROK_HOME : path.join(homeDir(env), '.grok')),
  async detect(home) {
    const bytes = await readFile(path.join(home, 'rules', 'recipe-loader.md'));
    const head = bytes && decode(bytes).match(/^<!-- recipe-loader: (.+?) -->/);
    return {present: await exists(home), live: head ? [{label: head[1], where: 'rules/recipe-loader.md'}] : [], foreign: []};
  },
  async desired(recipe, home) {
    const body = `<!-- recipe-loader: ${recipe.name} ${recipe.version} (${recipe.revision}). Managed file; switch or uninstall with recipe-loader. -->\n\n${recipe.texts.main.trim()}\n`;
    return {units: [fileUnit(path.join(home, 'rules', 'recipe-loader.md'), body)], notes: ['Existing rules files stay in place and keep loading alongside this one.']};
  },
};

// ---------------------------------------------------------------- OpenCode
export const opencode = {
  id: 'opencode', name: 'OpenCode', mechanism: 'Managed main.md listed in opencode.json "instructions"',
  steer: 'None yet (the system-transform plugin hook is a later step)',
  resolveHome: env => path.resolve(env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config'), 'opencode')),
  async detect(home) {
    const config = await readJson(path.join(home, 'opencode.json')), foreign = [];
    if (config === undefined) foreign.push({what: 'opencode.json', detail: 'not plain JSON (comments?); the loader will not edit it', blocking: true});
    if (await exists(path.join(home, 'opencode.jsonc'))) foreign.push({what: 'opencode.jsonc', detail: 'also present; the loader edits opencode.json only', blocking: false});
    const snap = await readJson(path.join(home, 'recipe-loader', 'recipe.json'));
    return {present: await exists(home), live: snap?.managedBy ? [{label: `${snap.name} ${snap.version}`, where: 'recipe-loader/main.md'}] : [], foreign};
  },
  async desired(recipe, home) {
    const dir = path.join(home, 'recipe-loader'), main = path.join(dir, 'main.md');
    return {units: [fileUnit(main, recipe.texts.main), fileUnit(path.join(dir, 'recipe.json'), marker(recipe)),
      jsonItemUnit(path.join(home, 'opencode.json'), ['instructions'], toPosix(main))],
    notes: ['Added after the global AGENTS.md and project instructions; restart OpenCode.']};
  },
};

export {fs};
