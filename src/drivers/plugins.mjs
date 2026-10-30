// Source-verified native plugin entry points. Runtime files are stable; recipe
// switches replace only snapshots (and Kimi's main SYSTEM.md append wrapper).
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exists, readFile, decode, toPosix, displayPath} from '../fsx.mjs';
import {MARK} from '../engine.mjs';
import {inspectYamlList, pluginDisabled} from '../yaml-list.mjs';
import {fileUnit, jsonItemUnit, readJson, homeDir} from './common.mjs';
import {snapshot} from './builtin.mjs';
import {probeHermes as hermesCapabilities} from '../hermes-capabilities.mjs';
import {note} from '../i18n.mjs';

const PLUGINS = fileURLToPath(new URL('../../plugins/', import.meta.url));
const ID = 'recipe-switch';
const keyUnit = (file, pointer, afterValue) => ({type: 'jsonKey', path: file, pointer, afterValue, preserveLayout: true});
const userPath = (value, env) => path.resolve(value.replace(/^~(?=$|[\\/])/, () => homeDir(env)));
async function filesFor(kind, dir, files, recipe) {
  const units = await Promise.all(files.map(async file => fileUnit(path.join(dir, file), await fs.readFile(path.join(PLUGINS, kind, file)))));
  units.push(fileUnit(path.join(dir, 'recipe.json'), snapshot(recipe)));
  return units;
}
async function snapAt(dir) {
  const snap = await readJson(path.join(dir, 'recipe.json'));
  return snap?.managedBy === ID ? snap : null;
}
const liveAt = (snap, where, enabled) => snap ? [{label: `${snap.recipe.name} ${snap.recipe.version}${enabled ? '' : ' (not enabled)'}`, where, revision: snap.recipe.revision, managed: true}] : [];
async function identityInfo(home) {
  return await exists(path.join(home, 'SOUL.md')) ? [{what: note('foreign.identity.soul'), detail: note('foreign.identity.soulDetail'), blocking: false}] : [];
}

async function kimiRegistry(home) {
  const file = path.join(home, 'plugins', 'installed.json'), value = await readJson(file);
  if (value === undefined || value !== null && (value.version !== 1 || !Array.isArray(value.plugins)))
    throw new Error(`Invalid Kimi plugin registry ${toPosix(file)}; expected version 1 with a plugins array.`);
  const matches = value?.plugins.filter(entry => entry?.id === ID) ?? [];
  if (matches.length > 1) throw new Error(`Duplicate ${ID} entries in ${toPosix(file)}; resolve them before installing.`);
  return {file, value, entry: matches[0]};
}
export const kimiCode = {
  id: 'kimi-code', name: 'Kimi Code CLI',
  mechanism: note('mechanism.kimiCode'),
  steer: note('steer.kimiCode'),
  resolveHome: env => userPath(env.KIMI_CODE_HOME || path.join(homeDir(env), '.kimi-code'), env),
  async detect(home) {
    const dir = path.join(home, 'plugins', 'managed', ID), snap = await snapAt(dir), foreign = [];
    const system = await readFile(path.join(home, 'SYSTEM.md'));
    if (system !== null && !decode(system).includes(`<!-- ${MARK} -->`)) foreign.push({what: note('foreign.kimi.system'), detail: note('foreign.kimi.systemDetail'), blocking: true});
    const {entry} = await kimiRegistry(home);
    if (entry && entry.originalSource !== MARK) foreign.push({what: note('foreign.kimi.registry'), detail: note('foreign.kimi.registryDetail'), blocking: true});
    return {present: await exists(home), live: liveAt(snap, 'SYSTEM.md + plugins/managed/recipe-switch', Boolean(entry?.enabled)), foreign};
  },
  async desired(recipe, home) {
    const dir = path.join(home, 'plugins', 'managed', ID), {file, entry} = await kimiRegistry(home);
    const units = await filesFor('kimi-code', dir, ['kimi.plugin.json', 'steer.mjs'], recipe);
    if (recipe.texts.main !== null) units.push(fileUnit(path.join(home, 'SYSTEM.md'), '${base_prompt}\n\n' + `<!-- ${MARK} -->\n` + (recipe.texts.main || '') + '\n'));
    units.push(keyUnit(file, ['version'], 1));
    units.push({type: 'jsonArrayRecord', path: file, pointer: ['plugins'], value: ID,
      afterValue: {id: ID, root: toPosix(dir), source: 'local-path', enabled: true,
        installedAt: entry?.installedAt ?? new Date().toISOString(), originalSource: MARK}});
    return {units, notes: [note('kimi.note.restart'), note('kimi.note.steer')]};
  },
};

export {probeHermes as hermesCapabilities} from '../hermes-capabilities.mjs';

export const hermes = {
  id: 'hermes', name: 'Hermes Agent', mechanism: note('mechanism.hermes'),
  steer: note('steer.hermes'),
  resolveHome: env => userPath(env.HERMES_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(homeDir(env), 'AppData', 'Local'), 'hermes')
    : path.join(homeDir(env), '.hermes')), env),
  async detect(home, {env = process.env} = {}) {
    const dir = path.join(home, 'plugins', ID), config = await readFile(path.join(home, 'config.yaml'));
    const state = inspectYamlList(decode(config)), disabled = pluginDisabled(state), foreign = await identityInfo(home);
    const capabilities = await hermesCapabilities(home, {env});
    if (!capabilities.llmRequest) foreign.push({what: note('foreign.hermes.steeringOnly'), detail: note('foreign.hermes.steeringOnlyDetail', {reason: capabilities.reason ?? ''}), blocking: false});
    else foreign.push({what: note('foreign.hermes.mainSub'), detail: capabilities.statusText, blocking: false});
    if (disabled) foreign.push({what: note('foreign.hermes.disabled'), detail: note('foreign.hermes.disabledDetail'), blocking: true});
    return {present: await exists(home), capabilities, capability: capabilities,
      mechanism: capabilities.llmRequest ? this.mechanism : note('mechanism.hermesSteeringOnly'),
      live: liveAt(await snapAt(dir), 'plugins/recipe-switch', state.present && !disabled), foreign};
  },
  async desired(recipe, home, options = {}, {env = process.env} = {}) {
    if (pluginDisabled(inspectYamlList(decode(await readFile(path.join(home, 'config.yaml'))))))
      throw new Error('Hermes plugins.disabled includes recipe-switch; remove that entry yourself before installing.');
    const dir = path.join(home, 'plugins', ID), units = await filesFor('hermes', dir, ['plugin.yaml', '__init__.py'], recipe);
    units.push({type: 'yamlArrayItem', path: path.join(home, 'config.yaml'), pointer: ['plugins', 'enabled'], value: ID, afterPresent: true});
    const capabilities = await hermesCapabilities(home, {env});
    const snap = units.find(unit => path.basename(unit.path) === 'recipe.json');
    snap.afterBytes = Buffer.from(JSON.stringify({...JSON.parse(decode(snap.afterBytes)), hermesMiddleware: capabilities.llmRequest}, null, 2) + '\n');
    if (!capabilities.llmRequest) {
      const manifest = units.find(unit => path.basename(unit.path) === 'plugin.yaml');
      manifest.afterBytes = Buffer.from(decode(manifest.afterBytes).replace('provides_middleware:\n  - llm_request\n', ''));
    }
    const notes = capabilities.llmRequest
      ? [capabilities.statusText, ...(!capabilities.main ? [note('hermes.note.pending')] : []),
        note('hermes.note.middleware'), note('hermes.note.shapes'), note('hermes.note.bypass')]
      : [note('hermes.note.steeringOnly'), note('hermes.note.steeringOnlyWhy', {reason: capabilities.reason ?? ''})];
    notes.push(note('hermes.note.steer'));
    for (const role of ['userSteer', 'subSteer']) if ([...(recipe.texts[role] || '')].length > 10000)
      notes.push(note('hermes.note.steerTooLong', {role}));
    return {units, notes};
  },
};

const openclawHome = env => userPath(env.OPENCLAW_STATE_DIR?.trim() || path.join(
  env.OPENCLAW_HOME?.trim() ? userPath(env.OPENCLAW_HOME.trim(), env) : homeDir(env), '.openclaw'), env);
export const openclawConfig = (home, env) => env.OPENCLAW_CONFIG_PATH?.trim()
  ? userPath(env.OPENCLAW_CONFIG_PATH.trim(), {...env, HOME: env.OPENCLAW_HOME || homeDir(env), USERPROFILE: env.OPENCLAW_HOME || homeDir(env)})
  : path.join(home, 'openclaw.json');
async function openclawSettings(home, env) {
  const file = openclawConfig(home, env), config = await readJson(file);
  if (config === undefined) throw new Error(`OpenClaw config ${toPosix(file)} contains JSON5-only syntax or invalid JSON. Convert it to strict JSON before installing; recipe-switch will not rewrite JSON5.`);
  if (config !== null && (typeof config !== 'object' || Array.isArray(config))) throw new Error(`OpenClaw config must be a JSON object: ${toPosix(file)}`);
  if (config?.plugins?.enabled === false) throw new Error('OpenClaw plugins.enabled is false; enable plugins yourself before installing.');
  if (config?.plugins?.deny?.includes(ID)) throw new Error('OpenClaw plugins.deny includes recipe-switch; remove that deny entry yourself before installing.');
  if (config?.plugins?.entries?.[ID]?.hooks?.allowPromptInjection === false) throw new Error('OpenClaw recipe-switch hooks.allowPromptInjection is false; change that policy yourself before installing.');
  if (config?.plugins?.entries?.[ID]?.hooks?.allowConversationAccess === false) throw new Error('OpenClaw recipe-switch hooks.allowConversationAccess is false; enable that hook yourself before installing.');
  return {file, config};
}
export const openclaw = {
  id: 'openclaw', name: 'OpenClaw', mechanism: note('mechanism.openclaw'),
  steer: note('steer.openclaw'),
  resolveHome: openclawHome,
  options: [{key: 'grantConversationAccess', type: 'boolean', consent: true, label: note('openclaw.option.grant')}],
  async detect(home, {env = process.env} = {}) {
    const dir = path.join(home, 'extensions', ID), {config} = await openclawSettings(home, env);
    const entry = config?.plugins?.entries?.[ID];
    const enabled = entry?.enabled && entry.hooks?.allowConversationAccess && (!config.plugins.allow || config.plugins.allow.includes(ID));
    return {present: await exists(home), live: liveAt(await snapAt(dir), 'extensions/recipe-switch', enabled), foreign: await identityInfo(home)};
  },
  async desired(recipe, home, options = {}, {env = process.env} = {}) {
    const dir = path.join(home, 'extensions', ID), {file, config} = await openclawSettings(home, env);
    const units = await filesFor('openclaw', dir, ['package.json', 'openclaw.plugin.json', 'index.mjs'], recipe);
    const permission = config?.plugins?.entries?.[ID]?.hooks?.allowConversationAccess;
    units.push(keyUnit(file, ['plugins', 'entries', ID, 'enabled'], true));
    if (permission === true || options.grantConversationAccess === true)
      units.push(keyUnit(file, ['plugins', 'entries', ID, 'hooks', 'allowConversationAccess'], true));
    if (config?.plugins?.allow !== undefined) units.push({...jsonItemUnit(file, ['plugins', 'allow'], ID), preserveLayout: true});
    if (env.OPENCLAW_CONFIG_PATH?.trim()) for (const unit of units) if (unit.path === file) unit.boundary = path.dirname(file);
    return {units, notes: [...(permission === undefined ? [note(options.grantConversationAccess === true ? 'openclaw.note.granted' : 'openclaw.note.prerequisite')] : []),
      note('openclaw.note.restart'), note('openclaw.note.scope'), note('openclaw.note.config', {file: displayPath(toPosix(file), {env})})]};
  },
};
