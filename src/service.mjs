// Service layer shared by the CLI and the local web server.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store, stateHome, plan, applyPlan, planUndo, applyUndo, planRestoreOriginal, applyRestoreOriginal, status, targetKey, redact, ownedUnits, deserialize} from './engine.mjs';
import {readOriginals, originalBytes} from './originals.mjs';
import {loadCatalog} from './sources.mjs';
import {readJson} from './drivers/common.mjs';
import {writeFile, toPosix, exists, readFile, assertBoundary, sha256} from './fsx.mjs';
import {render} from './units.mjs';
import {note} from './i18n.mjs';
import * as native from './drivers/native.mjs';
import * as builtin from './drivers/builtin.mjs';
import * as plugins from './drivers/plugins.mjs';

export const DRIVERS = [native.codex, native.claude, native.kiki, builtin.pi, builtin.dsh, native.omp, native.grok, native.opencode,
  plugins.kimiCode, plugins.hermes, plugins.openclaw];

/** Harnesses detected or requested that the loader deliberately does not write. */
export const UNCOVERED = [
  {id: 'gemini', name: 'Gemini CLI', home: '~/.gemini', reason: 'No native source checkout to confirm the global instruction slot or extension contract; only project-level GEMINI.md is documented by donors.'},
  {id: 'cursor', name: 'Cursor', home: '~/.cursor', reason: 'User rules live in the app settings database; file rules are project-scoped (.cursor/rules). No confirmed global file target.'},
  {id: 'qoder', name: 'Qoder', home: '~/.qoder', reason: 'Plugin manifest and hook route are known from Ponytail but no Qoder source or adapter exists here yet.'},
];

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const defaultGwt = () => process.env.RECIPE_SWITCH_GWT || path.resolve(ROOT, '..', 'gpt-with-taste');

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
  /** A recipe at its default options, or at `selection` (recipe option id → bool). */
  async recipe(key, selection) {
    const {recipes} = await this.catalog();
    const match = recipes.find(recipe => recipe.key === key) ?? recipes.filter(recipe => recipe.id === key).at(-1);
    if (!match) throw new Error(`Unknown recipe ${key}. Available: ${recipes.map(r => r.key).join(', ')}`);
    if (!selection || !match.withOptions) return match;
    const variant = await match.withOptions(selection);
    variant.key = match.key;
    return variant;
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
        const found = await driver.detect(target.home, {gwtRoot: gwt, env: this.env});
        Object.assign(row, found, {managed: await status(this.store, driver.id, target.home),
          originals: await this.originals({harness: driver.id, home: target.home})});
        if (driver.choices) row.choices = await driver.choices(target.home);
        if (found.capabilities) row.capability = {...found.capabilities, state: found.capabilities.state ?? 'unknown'};
      } catch (error) { Object.assign(row, {present: false, error: error.message, ...(error.note ? {errorNote: error.note} : {}), live: [], foreign: [], managed: {installed: false, history: [], drift: []}}); }
      rows.push(row);
    }
    const uncovered = [];
    for (const item of UNCOVERED) {
      const resolved = item.home.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '').split(' ')[0];
      uncovered.push({...item, detected: await exists(resolved)});
    }
    return {stateHome: toPosix(this.store.home), targets: rows, uncovered, warnings: this.store.warnings};
  }

  async resolveTarget(harness, home) {
    const driver = this.driver(harness);
    if (home) return {driver, home: path.resolve(home)};
    const targets = (await this.targets(harness)).filter(target => !target.missing);
    if (targets.length !== 1) throw new Error(`${harness} has ${targets.length} targets; pass --home (${targets.map(t => toPosix(t.home)).join(', ') || 'none found'})`);
    return {driver, home: targets[0].home};
  }

  /** Preview installing or switching to a recipe. */
  async preview({harness, home, recipe: recipeKey, options = {}, recipeOptions, force = false}) {
    const {driver, home: target} = await this.resolveTarget(harness, home), {gwt} = await this.config();
    const found = await driver.detect(target, {gwtRoot: gwt, env: this.env});
    const managed = await status(this.store, driver.id, target);
    const top = managed.installed ? (await this.store.target(targetKey(driver.id, target))).stack.at(-1) : null;
    const saved = top?.options ?? {};
    // Recipe options: explicit choices layer over the installed choice of the same recipe, then the defaults.
    const sameRecipe = top && (top.recipe?.key === recipeKey || top.recipe?.id === recipeKey);
    const kept = sameRecipe ? top.recipe?.optionValues ?? {} : {};
    const selection = recipeOptions || sameRecipe ? {...kept, ...recipeOptions} : undefined;
    const recipe = await this.recipe(recipeKey, selection);
    const merged = {...saved, ...options};
    for (const option of driver.options ?? []) if (option.consent) merged[option.key] = options[option.key] === true;
    if (['codex', 'claude', 'omp', 'grok', 'opencode'].includes(driver.id) && recipe.texts.main === null)
      throw new Error(`${driver.name}: explicit main=off is unsupported by this entry point; choose a recipe with Main enabled.`);
    const {units, notes = [], launch} = await driver.desired(recipe, target, merged, {env: this.env});
    const planned = await plan({store: this.store, harness: driver.id, home: target, recipe, desired: units, notes, force});
    const foreignEntry = item => {
      const isForeign = (item?.what?.id ?? '').startsWith('foreign.');
      const text = isForeign ? item.what : note('foreign.generic', {what: String(item.what ?? '')});
      const detail = isForeign && item.detail?.id ? item.detail : note('foreign.genericDetail', {detail: String(item.detail ?? '')});
      return {kind: 'foreign', text, detail};
    };
    const blocking = (found.foreign ?? []).filter(item => item.blocking && !managed.installed &&
      !(driver.id === 'kimi-code' && recipe.texts.main === null && item.what?.id === 'foreign.kimi.system'));
    if (blocking.length && !force) planned.blocked.push(...blocking.map(foreignEntry));
    planned.warnings = [...(found.foreign ?? []).filter(item => !item.blocking).map(foreignEntry),
      ...(recipe.unknownOptions ?? []).map(id => note('unknownRecipeOption', {id}))];
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
    if (planned.kind === 'restore-original') return applyRestoreOriginal(this.store, planned);
    const result = await applyPlan(this.store, planned);
    return {...result, launch: planned.launch, notes: planned.notes};
  }

  async previewUndo({harness, home, all = false, force = false}) {
    const {driver, home: target} = await this.resolveTarget(harness, home);
    const planned = await planUndo(this.store, driver.id, target, {all, force});
    planned.id = `undo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this.plans.set(planned.id, planned);
    return planned;
  }

  async originals({harness, home}) {
    const {driver, home: target} = await this.resolveTarget(harness, home);
    return this.store.transaction(async state => {
      const original = await readOriginals(this.store, driver.id, target);
      if (!original) {
        const ended = state.endedOriginals?.[targetKey(driver.id, target)];
        if (!ended) return null;
        let alreadyOriginal = true;
        for (const entry of ended.files) {
          await assertBoundary(entry.path, entry.boundary ?? target);
          const bytes = await readFile(entry.path);
          if ((bytes === null ? null : sha256(bytes)) !== entry.fingerprint) alreadyOriginal = false;
        }
        return {harness: driver.id, home: toPosix(target), capturedAt: ended.capturedAt, ended: true, alreadyOriginal, restorable: false, files: []};
      }
      return {harness: driver.id, home: original.home, capturedAt: original.capturedAt, manifest: original.manifest,
        restorable: true, reconstructed: original.files.some(file => file.reconstructed),
        reasons: original.files.filter(file => file.reconstructed).map(file => ({path: file.path, reason: file.reason})),
        files: original.files.map(({path, existed, hash, size, mtime, capturedAt, source, reconstructed, reason}, id) => ({id, path, existed, hash, size, mtime, capturedAt, source, reconstructed, reason}))};
    });
  }
  async originalText({harness, home, id}) {
    const {driver, home: target} = await this.resolveTarget(harness, home);
    return this.store.transaction(async () => {
      const original = await readOriginals(this.store, driver.id, target), entry = original?.files[id];
      if (!Number.isInteger(id) || id < 0 || !entry) throw new Error('Unknown original file.');
      const bytes = await originalBytes(this.store, entry);
      let text = null;
      if (bytes !== null && !bytes.includes(0)) try { text = redact(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch {}
      return {path: entry.path, existed: entry.existed, size: entry.size, text, binary: bytes !== null && text === null};
    });
  }

  /** Managed (recipe-owned) bytes vs the live hand-edited file, for "See your edit". */
  async driftDiff({harness, home, path: filePath}) {
    const {driver, home: target} = await this.resolveTarget(harness, home);
    const targetState = await this.store.target(targetKey(driver.id, target));
    const units = [...ownedUnits(targetState).values()].map(({latest}) => latest)
      .filter(unit => path.resolve(unit.path) === path.resolve(filePath));
    if (!units.length) throw new Error('Not a managed file.');
    for (const unit of units) await assertBoundary(unit.path, unit.boundary ?? target);
    const live = await readFile(units[0].path);
    let managed = live;
    for (const unit of units) managed = render(unit, 'after', managed);
    const toText = bytes => {
      if (bytes === null) return null;
      try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return '(binary)'; }
    };
    const {unifiedDiff} = await import('./diff.mjs');
    const diff = unifiedDiff(toText(managed), toText(live), {path: toPosix(units[0].path)});
    return {path: toPosix(units[0].path), state: live === null ? 'missing' : 'edited', diff: redact(diff.text), added: diff.added, removed: diff.removed};
  }
  async previewOriginal({harness, home, force = false}) {
    const {driver, home: target} = await this.resolveTarget(harness, home);
    const planned = await planRestoreOriginal(this.store, driver.id, target, {force});
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
