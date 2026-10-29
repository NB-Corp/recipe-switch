// Service layer shared by the CLI and the local web server.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store, stateHome, plan, applyPlan, planUndo, applyUndo, status, targetKey} from './engine.mjs';
import {loadCatalog} from './sources.mjs';
import {readJson} from './drivers/common.mjs';
import {writeFile, toPosix, exists} from './fsx.mjs';
import * as native from './drivers/native.mjs';
import * as builtin from './drivers/builtin.mjs';

export const DRIVERS = [native.codex, native.claude, native.kiki, builtin.pi, builtin.dsh, native.omp, native.grok, native.opencode];

/** Harnesses detected or requested that the loader deliberately does not write. */
export const UNCOVERED = [
  {id: 'kimi-code', name: 'Kimi Code CLI', home: '~/.kimi-code', reason: 'Its only persistent slot, SYSTEM.md, replaces the whole built-in main prompt (tools and environment guidance included); AGENTS.md is a user-owned file. Needs a plugin systemPromptPath target first.'},
  {id: 'hermes', name: 'Hermes Agent', home: '~/.hermes (HERMES_HOME)', reason: 'SOUL.md is the user\'s identity slot and AGENTS.md is user-owned; a behavior recipe belongs in a plugin with pre_llm_call, which has no adapter yet.'},
  {id: 'openclaw', name: 'OpenClaw', home: '~/.openclaw', reason: 'Instructions live in the user\'s workspace AGENTS.md/SOUL.md; a before_prompt_build plugin adapter is not built yet.'},
  {id: 'gemini', name: 'Gemini CLI', home: '~/.gemini', reason: 'No native source checkout to confirm the global instruction slot or extension contract; only project-level GEMINI.md is documented by donors.'},
  {id: 'cursor', name: 'Cursor', home: '~/.cursor', reason: 'User rules live in the app settings database; file rules are project-scoped (.cursor/rules). No confirmed global file target.'},
  {id: 'qoder', name: 'Qoder', home: '~/.qoder', reason: 'Plugin manifest and hook route are known from Ponytail but no Qoder source or adapter exists here yet.'},
];

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const defaultGwt = () => process.env.RECIPE_LOADER_GWT || path.resolve(ROOT, '..', 'gpt-with-taste');

export class Service {
  constructor({env = process.env, home = stateHome(env), homes = {}} = {}) {
    this.env = env;
    this.store = new Store(home);
    this.homes = homes; // explicit per-harness home overrides (tests, --home)
    this.plans = new Map();
  }
  async config() {
    const saved = await readJson(path.join(this.store.home, 'config.json'));
    const gwt = saved?.gwt ?? defaultGwt();
    return {gwt, sources: saved?.sources ?? [gwt]};
  }
  async saveConfig(next) {
    const current = await this.config();
    const value = {...current, ...next};
    await writeFile(path.join(this.store.home, 'config.json'), Buffer.from(JSON.stringify(value, null, 2) + '\n'));
    return value;
  }
  async catalog() {
    const {gwt, sources} = await this.config();
    return loadCatalog(sources, {gwtRoot: gwt});
  }
  async recipe(key) {
    const {recipes} = await this.catalog();
    const match = recipes.find(recipe => recipe.key === key) ?? recipes.filter(recipe => recipe.id === key).at(-1);
    if (!match) throw new Error(`Unknown recipe ${key}. Available: ${recipes.map(r => r.key).join(', ')}`);
    return match;
  }
  driver(id) {
    const driver = DRIVERS.find(item => item.id === id);
    if (!driver) throw new Error(`Unknown harness ${id}. Supported: ${DRIVERS.map(d => d.id).join(', ')}`);
    return driver;
  }
  harnessHome(driver) { return path.resolve(this.homes[driver.id] ?? driver.resolveHome(this.env)); }

  /** All install targets: one per harness, or one per DSH profile. */
  async targets(filter) {
    const out = [];
    for (const driver of DRIVERS) {
      if (filter && driver.id !== filter) continue;
      const home = this.harnessHome(driver);
      const instances = driver.instances ? await driver.instances(home) : [{label: null, home}];
      if (driver.instances && !instances.length) out.push({driver, home, label: null, missing: true});
      for (const item of instances) out.push({driver, home: item.home, label: item.label, root: home});
    }
    return out;
  }

  async overview() {
    const {gwt} = await this.config(), rows = [];
    for (const target of await this.targets()) {
      const {driver} = target;
      const row = {harness: driver.id, name: driver.name, label: target.label, home: toPosix(target.home), mechanism: driver.mechanism, steer: driver.steer,
        options: driver.options ?? [], key: targetKey(driver.id, target.home)};
      if (target.missing) { Object.assign(row, {present: await exists(target.home), detail: 'no profiles found', live: [], foreign: [], managed: {installed: false, history: [], drift: []}}); rows.push(row); continue; }
      try {
        const found = await driver.detect(target.home, {gwtRoot: gwt});
        Object.assign(row, found, {managed: await status(this.store, driver.id, target.home)});
        if (driver.choices) row.choices = await driver.choices(target.home);
      } catch (error) { Object.assign(row, {present: false, error: error.message, live: [], foreign: [], managed: {installed: false, history: [], drift: []}}); }
      rows.push(row);
    }
    const uncovered = [];
    for (const item of UNCOVERED) {
      const resolved = item.home.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '').split(' ')[0];
      uncovered.push({...item, detected: await exists(resolved)});
    }
    return {stateHome: toPosix(this.store.home), targets: rows, uncovered};
  }

  async resolveTarget(harness, home) {
    const driver = this.driver(harness);
    if (home) return {driver, home: path.resolve(home)};
    const targets = (await this.targets(harness)).filter(target => !target.missing);
    if (targets.length !== 1) throw new Error(`${harness} has ${targets.length} targets; pass --home (${targets.map(t => toPosix(t.home)).join(', ') || 'none found'})`);
    return {driver, home: targets[0].home};
  }

  /** Preview installing or switching to a recipe. */
  async preview({harness, home, recipe: recipeKey, options = {}, force = false}) {
    const {driver, home: target} = await this.resolveTarget(harness, home), {gwt} = await this.config();
    const recipe = await this.recipe(recipeKey);
    const found = await driver.detect(target, {gwtRoot: gwt});
    const managed = await status(this.store, driver.id, target);
    const saved = managed.installed ? (await this.store.target(targetKey(driver.id, target))).stack.at(-1).options ?? {} : {};
    const merged = {...saved, ...options};
    const {units, notes = [], launch} = await driver.desired(recipe, target, merged);
    const planned = await plan({store: this.store, harness: driver.id, home: target, recipe, desired: units, notes, force});
    const blocking = (found.foreign ?? []).filter(item => item.blocking && !managed.installed);
    if (blocking.length && !force) planned.blocked.push(...blocking.map(item => `${item.what}: ${item.detail}`));
    planned.warnings = (found.foreign ?? []).filter(item => !item.blocking).map(item => `${item.what}: ${item.detail}`);
    planned.options = merged;
    planned.launch = launch;
    planned.current = managed.recipe ?? null;
    this.plans.set(planned.id, planned);
    return planned;
  }

  async apply(planId) {
    const planned = this.plans.get(planId);
    if (!planned) throw new Error('Unknown or expired preview; preview again.');
    if (['rollback', 'uninstall'].includes(planned.kind)) return this.applyUndo(planId);
    this.plans.delete(planId);
    const result = await applyPlan(this.store, planned);
    if (result.changed) await this.store.update(state => { state.targets[planned.key].stack.at(-1).options = planned.options; });
    return {...result, launch: planned.launch, notes: planned.notes};
  }

  async previewUndo({harness, home, all = false, force = false}) {
    const {driver, home: target} = await this.resolveTarget(harness, home);
    const planned = await planUndo(this.store, driver.id, target, {all, force});
    planned.id = `undo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this.plans.set(planned.id, planned);
    return planned;
  }

  async applyUndo(planId) {
    const planned = this.plans.get(planId);
    if (!planned?.kind || !['rollback', 'uninstall'].includes(planned.kind)) throw new Error('Unknown or expired preview; preview again.');
    this.plans.delete(planId);
    return applyUndo(this.store, planned);
  }
}
