// Source-verified native plugin entry points. Runtime files are stable; recipe
// switches replace only snapshots (and Kimi's main SYSTEM.md append wrapper).
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exists, readFile, decode, toPosix} from '../fsx.mjs';
import {MARK} from '../engine.mjs';
import {inspectYamlList, pluginDisabled} from '../yaml-list.mjs';
import {fileUnit, jsonItemUnit, readJson, homeDir} from './common.mjs';
import {snapshot} from './builtin.mjs';

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
  return await exists(path.join(home, 'SOUL.md')) ? [{what: 'User identity SOUL.md', detail: 'Left unchanged; the plugin adds recipe context separately.', blocking: false}] : [];
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
  mechanism: 'SYSTEM.md with ${base_prompt} + managed UserPromptSubmit plugin',
  steer: 'User Steer on user turns; subagent profiles and steering are unchanged',
  resolveHome: env => userPath(env.KIMI_CODE_HOME || path.join(homeDir(env), '.kimi-code'), env),
  async detect(home) {
    const dir = path.join(home, 'plugins', 'managed', ID), snap = await snapAt(dir), foreign = [];
    const system = await readFile(path.join(home, 'SYSTEM.md'));
    if (system !== null && !decode(system).includes(`<!-- ${MARK} -->`)) foreign.push({what: 'Non-managed SYSTEM.md', detail: 'Move SYSTEM.md aside before installing; recipe-switch does not merge a user prompt.', blocking: true});
    const {entry} = await kimiRegistry(home);
    if (entry && entry.originalSource !== MARK) foreign.push({what: 'Existing recipe-switch Kimi plugin', detail: 'Remove or move the non-managed plugin registry entry first.', blocking: true});
    return {present: await exists(home), live: liveAt(snap, 'SYSTEM.md + plugins/managed/recipe-switch', Boolean(entry?.enabled)), foreign};
  },
  async desired(recipe, home) {
    const dir = path.join(home, 'plugins', 'managed', ID), {file, entry} = await kimiRegistry(home);
    const units = await filesFor('kimi-code', dir, ['kimi.plugin.json', 'steer.mjs'], recipe);
    units.push(fileUnit(path.join(home, 'SYSTEM.md'), '${base_prompt}\n\n' + `<!-- ${MARK} -->\n` + (recipe.texts.main || '') + '\n'));
    units.push(keyUnit(file, ['version'], 1));
    units.push({type: 'jsonArrayRecord', path: file, pointer: ['plugins'], value: ID,
      afterValue: {id: ID, root: toPosix(dir), source: 'local-path', enabled: true,
        installedAt: entry?.installedAt ?? new Date().toISOString(), originalSource: MARK}});
    return {units, notes: ['Restart Kimi Code to load SYSTEM.md and the plugin after installation or Main changes. ${base_prompt} retains the built-in default main prompt; project agent.md, --agent-file and other bound profiles can override it.',
      'User Steer is re-read from recipe.json on each UserPromptSubmit. System-triggered subagent turns do not fire that hook; subagent profiles are left unchanged.']};
  },
};

export const hermes = {
  id: 'hermes', name: 'Hermes Agent', mechanism: 'Full Main/Sub via session-frozen llm_request middleware + pre_llm_call; one YAML enabled-list item',
  steer: 'User Steer for main turns; Sub Steer for delegated children',
  resolveHome: env => userPath(env.HERMES_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(homeDir(env), 'AppData', 'Local'), 'hermes')
    : path.join(homeDir(env), '.hermes')), env),
  async detect(home) {
    const dir = path.join(home, 'plugins', ID), config = await readFile(path.join(home, 'config.yaml'));
    const state = inspectYamlList(decode(config)), disabled = pluginDisabled(state), foreign = await identityInfo(home);
    if (disabled) foreign.push({what: 'Hermes plugin explicitly disabled', detail: 'Remove recipe-switch from plugins.disabled yourself before installing.', blocking: true});
    return {present: await exists(home), live: liveAt(await snapAt(dir), 'plugins/recipe-switch', state.present && !disabled), foreign};
  },
  async desired(recipe, home) {
    if (pluginDisabled(inspectYamlList(decode(await readFile(path.join(home, 'config.yaml'))))))
      throw new Error('Hermes plugins.disabled includes recipe-switch; remove that entry yourself before installing.');
    const dir = path.join(home, 'plugins', ID), units = await filesFor('hermes', dir, ['plugin.yaml', '__init__.py'], recipe);
    units.push({type: 'yamlArrayItem', path: path.join(home, 'config.yaml'), pointer: ['plugins', 'enabled'], value: ID, afterPresent: true});
    const notes = ['Restart Hermes after installing or updating plugin code. Main/Sub are appended in full by llm_request middleware, frozen per session_id on its first request for the running plugin; recipe switches apply to new sessions and preserve existing-session prompt bytes.',
      'Chat system/developer messages, Anthropic system blocks, Responses instructions and Bedrock Converse system blocks are supported. Unknown request shapes or missing session ids are left unchanged.',
      'Hermes codex_app_server, auxiliary calls and max-iteration summary calls bypass llm_request and do not receive this Main/Sub injection.',
      'Delegated children use Sub and Sub Steer (platform=subagent); SOUL.md and AGENTS.md are left unchanged. User/Sub Steer are re-read on each pre_llm_call.'];
    for (const role of ['userSteer', 'subSteer']) if ([...(recipe.texts[role] || '')].length > 10000)
      notes.push(`Hermes ${role} exceeds the default 10,000-character hook-output budget; Hermes may spill it to a file and inject a preview.`);
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
  return {file, config};
}
export const openclaw = {
  id: 'openclaw', name: 'OpenClaw', mechanism: 'Native before_prompt_build plugin; strict-JSON enablement keys',
  steer: 'User Steer; Sub and Sub Steer for subagent session keys',
  resolveHome: openclawHome,
  async detect(home, {env = process.env} = {}) {
    const dir = path.join(home, 'extensions', ID), {config} = await openclawSettings(home, env);
    const entry = config?.plugins?.entries?.[ID];
    const enabled = entry?.enabled && entry.hooks?.allowConversationAccess && (!config.plugins.allow || config.plugins.allow.includes(ID));
    return {present: await exists(home), live: liveAt(await snapAt(dir), 'extensions/recipe-switch', enabled), foreign: await identityInfo(home)};
  },
  async desired(recipe, home, _options = {}, {env = process.env} = {}) {
    const dir = path.join(home, 'extensions', ID), {file, config} = await openclawSettings(home, env);
    const units = await filesFor('openclaw', dir, ['package.json', 'openclaw.plugin.json', 'index.mjs'], recipe);
    units.push(keyUnit(file, ['plugins', 'entries', ID, 'enabled'], true));
    units.push(keyUnit(file, ['plugins', 'entries', ID, 'hooks', 'allowConversationAccess'], true));
    if (config?.plugins?.allow !== undefined) units.push({...jsonItemUnit(file, ['plugins', 'allow'], ID), preserveLayout: true});
    return {units, notes: ['Restart the OpenClaw Gateway after installing or changing plugin code. Later recipe switches are re-read on the next before_prompt_build.',
      'Main + User Steer apply to regular sessions. Sub + Sub Steer apply when ctx.sessionKey is subagent:<id> or agent:<agent>:subagent:<id>; absent session keys use Main.',
      `Config: ${toPosix(file)}. Only plugin enablement, conversation-hook access and an existing allowlist are edited; AGENTS.md/SOUL.md stay unchanged.`]};
  },
};
