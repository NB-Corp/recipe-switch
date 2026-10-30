// Harnesses whose native entry point is a file or one config key.
// Behavior artifacts come from the recipe source (gpt-with-taste dist/ or its
// adapters); this module only decides where they go.
import fs from 'node:fs/promises';
import path from 'node:path';
import {exists, readFile, decode, toPosix, displayPath} from '../fsx.mjs';
import {readKeyLine, splitKey} from '../vendor/toml-key.mjs';
import {fileUnit, tomlKeyUnit, jsonItemUnit, placeFiles, readJson, homeDir, marker} from './common.mjs';
import {MARK} from '../engine.mjs';
import {note} from '../i18n.mjs';

const own = line => line?.includes(MARK);
const keyValue = line => line?.match(/=\s*(["'])(.*?)\1/)?.[2] ?? null;
/** A recipe title from state may carry a version; foreign/live labels are catalog items or plain names. */
const snapLabel = snap => `${snap.name} ${snap.version}`;

// ---------------------------------------------------------------- Codex
export const codex = {
  id: 'codex', name: 'OpenAI Codex', mechanism: note('mechanism.codex'),
  steer: note('steer.codex'),
  resolveHome: env => path.resolve(env.CODEX_HOME || path.join(homeDir(env), '.codex')),
  async detect(home, {gwtRoot} = {}) {
    const config = await readFile(path.join(home, 'config.toml')), foreign = [], live = [];
    const line = config === null ? null : readKeyLine(decode(config), [], 'model_instructions_file');
    if (line && !own(line)) {
      const target = keyValue(line);
      const viaInstaller = target && /prompts\/gpt-with-taste\/main\.md$/.test(toPosix(target));
      foreign.push(viaInstaller
        ? {what: note('foreign.codex.gwtInstaller', {target: displayPath(toPosix(target))}), detail: note('foreign.codex.gwtInstallerDetail', {target: displayPath(toPosix(target))}), blocking: true}
        : {what: note('foreign.codex.customInstructions', {target: displayPath(toPosix(target))}), detail: displayPath(toPosix(target)), blocking: false});
      live.push(viaInstaller
        ? {label: note('foreign.codex.gwtInstaller', {target: displayPath(toPosix(target))}), where: 'config.toml model_instructions_file'}
        : {label: note('foreign.codex.customInstructions', {target: displayPath(toPosix(target))}), where: 'config.toml model_instructions_file'});
    }
    if (gwtRoot) {
      const receipt = await readJson(path.join(gwtRoot, '.gpt-with-taste', 'install-receipt.json'));
      if (receipt?.status === 'applied' && path.resolve(receipt.home) === path.resolve(home) && !foreign.some(f => f.blocking))
        foreign.push({what: note('foreign.codex.gwtReceipt'), detail: note('foreign.codex.gwtReceiptDetail', {dir: displayPath(toPosix(gwtRoot))}), blocking: true});
    }
    return {present: await exists(home), live, foreign};
  },
  async desired(recipe, home) {
    const files = await recipe.artifacts('codex'), dir = path.join(home, 'prompts', 'recipe-switch');
    const units = placeFiles(dir, files, {only: rel => ['main.md', 'sub.md'].includes(rel)});
    units.push(fileUnit(path.join(dir, 'recipe.json'), marker(recipe)));
    units.push(tomlKeyUnit(path.join(home, 'config.toml'), [], 'model_instructions_file', path.join(dir, 'main.md')));
    return {units, notes: [note('codex.note.newSession')]};
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
  id: 'kiki', name: 'Kiki', mechanism: note('mechanism.kiki'),
  steer: note('steer.kiki'),
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
        const managed = own(line);
        live.push(managed
          ? {label: `recipe-switch: ${path.basename(path.dirname(value))}`, where: `models.${alias}`, managed: true}
          : {label: installs.has(value) ? note('foreign.kiki.recipe', {label: `models.${alias}`}) : note('foreign.kiki.customRecipe', {label: `models.${alias}`}),
            where: `models.${alias} → ${installs.get(value) ?? value}`, managed: false});
      }
    }
    return {present: await exists(home), live, foreign: []};
  },
  async desired(recipe, home, options = {}) {
    const models = [].concat(options.models ?? []).filter(Boolean);
    if (!models.length) throw new Error('Kiki: choose at least one model (--models alias[,alias])');
    const known = await kikiModels(home);
    for (const alias of models) if (!known.includes(alias)) throw new Error(`Kiki: model ${alias} is not defined in config.toml`);
    const dir = path.join(home, 'recipe-switch', 'packages', recipe.id), units = [];
    if (recipe.kikiPackage) {
      for (const [rel, bytes] of recipe.kikiPackage.files) units.push(fileUnit(path.join(dir, rel), bytes));
    } else {
      const files = await recipe.artifacts('kiki');
      units.push(...placeFiles(dir, files, {only: rel => !rel.includes('/') && rel !== 'build-manifest.json'}));
    }
    const entry = path.join(dir, recipe.kikiPackage?.entry ?? 'recipe.toml');
    for (const alias of models) units.push(tomlKeyUnit(path.join(home, 'config.toml'), ['models', alias], 'recipe', entry));
    return {units, notes: [note('kiki.note.adopt')]};
  },
};

// ---------------------------------------------------------------- Claude Code
export const claude = {
  id: 'claude', name: 'Claude Code', mechanism: note('mechanism.claude'),
  steer: note('steer.claude'),
  resolveHome: env => path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir(env), '.claude')),
  async detect(home) {
    const snap = await readJson(path.join(home, 'recipe-switch', 'recipe.json'));
    return {present: await exists(home), live: snap?.managedBy ? [{label: snapLabel(snap), where: 'recipe-switch/'}] : [], foreign: []};
  },
  async desired(recipe, home) {
    const files = await recipe.artifacts('claude'), dir = path.join(home, 'recipe-switch');
    const units = placeFiles(dir, files, {only: rel => rel === 'main.md' || rel === 'independent.md' || rel.startsWith('plugin/')});
    units.push(fileUnit(path.join(dir, 'recipe.json'), marker(recipe)));
    const main = toPosix(path.join(dir, 'main.md')), plugin = toPosix(path.join(dir, 'plugin'));
    return {units, launch: `claude --append-system-prompt-file "${main}" --plugin-dir "${plugin}"`,
      notes: [note('claude.note.launch')]};
  },
};

// ---------------------------------------------------------------- OMP
export const omp = {
  id: 'omp', name: 'Oh My Pi', mechanism: note('mechanism.omp'),
  steer: note('steer.omp'),
  resolveHome: env => path.resolve(env.OMP_CODING_AGENT_DIR || path.join(homeDir(env), '.omp', 'agent')),
  async detect(home) {
    const snap = await readJson(path.join(home, 'extensions', 'recipe-switch', 'recipe.json'));
    return {present: await exists(home), live: snap?.managedBy ? [{label: snapLabel(snap), where: 'extensions/recipe-switch'}] : [], foreign: []};
  },
  async desired(recipe, home) {
    const files = await recipe.artifacts('omp'), dir = path.join(home, 'extensions', 'recipe-switch');
    const units = placeFiles(dir, files, {only: rel => rel !== 'build-manifest.json'});
    units.push(fileUnit(path.join(dir, 'recipe.json'), marker(recipe)));
    return {units, notes: [note('omp.note.restart')]};
  },
};

// ---------------------------------------------------------------- Grok Build
export const grok = {
  id: 'grok', name: 'Grok Build', mechanism: note('mechanism.grok'),
  steer: note('steer.grok'),
  resolveHome: env => path.resolve(env.GROK_HOME?.trim() ? env.GROK_HOME : path.join(homeDir(env), '.grok')),
  async detect(home) {
    const bytes = await readFile(path.join(home, 'rules', 'recipe-switch.md'));
    const head = bytes && decode(bytes).match(/^<!-- recipe-switch: (.+?) -->/);
    return {present: await exists(home), live: head ? [{label: head[1], where: 'rules/recipe-switch.md'}] : [], foreign: []};
  },
  async desired(recipe, home) {
    const body = `<!-- recipe-switch: ${recipe.name} ${recipe.version} (${recipe.revision}). Managed file; switch or uninstall with recipe-switch. -->\n\n${recipe.texts.main.trim()}\n`;
    return {units: [fileUnit(path.join(home, 'rules', 'recipe-switch.md'), body)], notes: [note('grok.note.coexist')]};
  },
};

// ---------------------------------------------------------------- OpenCode
export const opencode = {
  id: 'opencode', name: 'OpenCode', mechanism: note('mechanism.opencode'),
  steer: note('steer.opencode'),
  resolveHome: env => path.resolve(env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config'), 'opencode')),
  async detect(home) {
    const config = await readJson(path.join(home, 'opencode.json')), foreign = [];
    if (config === undefined) foreign.push({what: note('foreign.opencode.config'), detail: note('foreign.opencode.configDetail'), blocking: true});
    if (await exists(path.join(home, 'opencode.jsonc'))) foreign.push({what: note('foreign.opencode.jsonc'), detail: note('foreign.opencode.jsoncDetail'), blocking: false});
    const snap = await readJson(path.join(home, 'recipe-switch', 'recipe.json'));
    return {present: await exists(home), live: snap?.managedBy ? [{label: `${snap.name} ${snap.version}`, where: 'recipe-switch/main.md'}] : [], foreign};
  },
  async desired(recipe, home) {
    const dir = path.join(home, 'recipe-switch'), main = path.join(dir, 'main.md');
    return {units: [fileUnit(main, recipe.texts.main), fileUnit(path.join(dir, 'recipe.json'), marker(recipe)),
      jsonItemUnit(path.join(home, 'opencode.json'), ['instructions'], toPosix(main))],
    notes: [note('opencode.note.restart')]};
  },
};

export {fs};
