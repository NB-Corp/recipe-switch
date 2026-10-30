#!/usr/bin/env node
// recipe-switch CLI. Every write command previews first; add --yes to apply.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Service, DRIVERS} from '../src/service.mjs';
import {toPosix} from '../src/fsx.mjs';

const HELP = `recipe-switch — install, switch and roll back behavior recipes across coding harnesses

  recipe-switch status [--json]                      Detected harnesses, active recipes, drift
  recipe-switch recipes [--json]                     Recipes from configured sources
  recipe-switch sources [add|remove <path>] [--gwt <gpt-with-taste checkout>]
  recipe-switch install  <harness> <recipe> [--home DIR] [options] [--yes]
  recipe-switch switch   <harness> <recipe> [--home DIR] [options] [--yes]
  recipe-switch rollback <harness> [--home DIR] [--yes]   Undo the latest install/switch
  recipe-switch uninstall <harness> [--home DIR] [--yes]  Undo everything; restore the original state
  recipe-switch history  <harness> [--home DIR]
  recipe-switch ui [--port 4517] [--no-open]          Local web UI on 127.0.0.1

Without --yes, write commands only print the diff (dry run).
--force overrides hand-edit and foreign-install guards; it is never implied.
Recipe options: --with a,b --without c   (ids from "recipes"; others keep the installed or default choice)
Harness options: --models a,b (kiki)  --root-role main|independent (dsh)
                 --providers p,q --model-pattern REGEX (pi)
Harnesses: ${DRIVERS.map(d => d.id).join(', ')}
State: RECIPE_SWITCH_HOME (default ~/.recipe-switch)
`;

function parse(argv) {
  const args = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { args.push(arg); continue; }
    const name = arg.slice(2);
    if (['yes', 'json', 'force', 'no-open', 'help'].includes(name)) flags[name] = true;
    else {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${name} requires a value`);
      flags[name] = argv[++i];
    }
  }
  return {args, flags};
}

function options(flags) {
  const out = {};
  if (flags.models) out.models = flags.models.split(',').map(s => s.trim()).filter(Boolean);
  if (flags['root-role']) out.rootRole = flags['root-role'];
  if (flags.providers !== undefined) out.providers = flags.providers;
  if (flags['model-pattern'] !== undefined) out.modelIdPattern = flags['model-pattern'];
  return out;
}

function recipeOptions(flags) {
  if (flags.with === undefined && flags.without === undefined) return undefined;
  const out = {}, list = value => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const id of list(flags.with)) out[id] = true;
  for (const id of list(flags.without)) out[id] = false;
  return out;
}

function printPlan(planned) {
  const title = planned.kind === 'rollback' ? `Rollback ${planned.harness}${planned.restores ? ` → ${planned.restores.key}` : ' → original state'}`
    : planned.kind === 'uninstall' ? `Uninstall ${planned.harness} → original state`
    : `${planned.kind === 'switch' ? 'Switch' : 'Install'} ${planned.harness}: ${planned.current ? planned.current.key + ' → ' : ''}${planned.recipe.key}`;
  console.log(`${title}\nTarget: ${planned.home}`);
  for (const file of planned.files) console.log(`\n${file.action.toUpperCase()} ${file.path}  (+${file.added} -${file.removed})\n${file.diff.trimEnd()}`);
  if (!planned.files.length) console.log('\nNo changes.');
  for (const note of planned.notes ?? []) console.log(`note: ${note}`);
  for (const warning of planned.warnings ?? []) console.log(`warning: ${warning}`);
  if (planned.launch) console.log(`launch: ${planned.launch}`);
  if (planned.blocked?.length) console.log(`\nBlocked:\n  ${planned.blocked.join('\n  ')}\nResolve the item, or pass --force to override.`);
}

export async function main(argv = process.argv.slice(2), service = new Service()) {
  const {args, flags} = parse(argv), [command, ...rest] = args;
  if (!command || flags.help || command === 'help') { console.log(HELP); return; }
  if (command === 'status') {
    const view = await service.overview();
    if (flags.json) { console.log(JSON.stringify(view, null, 2)); return; }
    console.log(`State: ${view.stateHome}`);
    for (const row of view.targets) {
      const managed = row.managed?.installed ? `recipe-switch: ${row.managed.recipe.key}` : 'recipe-switch: —';
      const others = (row.live ?? []).filter(item => !item.managed).map(item => `${item.label} (${item.where})`);
      console.log(`\n${row.name}${row.label ? ` [${row.label}]` : ''}  ${row.present ? 'detected' : 'not found'}  ${row.home}\n  ${managed}`);
      if (others.length) console.log(`  other: ${others.join('; ')}`);
      for (const item of row.foreign ?? []) console.log(`  ${item.blocking ? 'blocks' : 'note'}: ${item.what} — ${item.detail}`);
      for (const item of row.managed?.drift ?? []) console.log(`  hand edit: ${item.path} (${item.state})`);
    }
    console.log('\nNot covered:');
    for (const item of view.uncovered) console.log(`  ${item.name}${item.detected ? ' (detected)' : ''}: ${item.reason}`);
    return;
  }
  if (command === 'recipes') {
    const {recipes, errors} = await service.catalog();
    if (flags.json) { console.log(JSON.stringify({recipes: recipes.map(({texts, artifacts, kikiPackage, ...r}) => r), errors}, null, 2)); return; }
    for (const recipe of recipes) {
      console.log(`${recipe.key.padEnd(40)} ${recipe.name}  [${recipe.kind}] ${recipe.origin}`);
      for (const option of recipe.options ?? []) console.log(`    ${option.default ? '[x]' : '[ ]'} ${option.id.padEnd(20)} ${option.name}${option.description ? ` — ${option.description}` : ''}`);
    }
    for (const error of errors) console.log(`error: ${error.locator}: ${error.error}`);
    return;
  }
  if (command === 'sources') {
    const config = await service.config();
    const [action, target] = rest;
    if (action === 'add' || action === 'remove') {
      if (!target) throw new Error(`sources ${action} needs a path`);
      const resolved = toPosix(path.resolve(target));
      const sources = action === 'add' ? [...new Set([...config.sources, resolved])] : config.sources.filter(item => toPosix(path.resolve(item)) !== resolved);
      await service.saveConfig({sources});
    }
    if (flags.gwt) await service.saveConfig({gwt: toPosix(path.resolve(flags.gwt))});
    const now = await service.config();
    console.log(`gpt-with-taste: ${now.gwt}\nsources:\n${now.sources.map(item => `  ${item}`).join('\n')}`);
    return;
  }
  if (['install', 'switch'].includes(command)) {
    const [harness, recipe] = rest;
    if (!harness || !recipe) throw new Error(`Usage: recipe-switch ${command} <harness> <recipe>`);
    const planned = await service.preview({harness, home: flags.home, recipe, options: options(flags), recipeOptions: recipeOptions(flags), force: flags.force});
    if (command === 'install' && planned.kind === 'switch') console.log('(already managed: this is a switch)');
    printPlan(planned);
    if (!flags.yes) { console.log('\nDry run. Re-run with --yes to apply.'); return planned; }
    if (planned.blocked.length) { process.exitCode = 2; return planned; }
    const result = await service.apply(planned.id);
    console.log(`\n${result.message}${result.backup ? `\nBackup: ${result.backup}` : ''}`);
    for (const version of result.replacedVersions ?? []) console.log(`被替换的版本保存在 ${version.saved}`);
    return result;
  }
  if (['rollback', 'uninstall'].includes(command)) {
    const [harness] = rest;
    if (!harness) throw new Error(`Usage: recipe-switch ${command} <harness>`);
    const planned = await service.previewUndo({harness, home: flags.home, all: command === 'uninstall', force: flags.force});
    printPlan(planned);
    if (!flags.yes) { console.log('\nDry run. Re-run with --yes to apply.'); return planned; }
    if (planned.blocked.length) { process.exitCode = 2; return planned; }
    const result = await service.applyUndo(planned.id);
    console.log(`\n${result.message}\nBackup: ${result.backup}`);
    for (const version of result.replacedVersions ?? []) console.log(`被替换的版本保存在 ${version.saved}`);
    return result;
  }
  if (command === 'history') {
    const [harness] = rest;
    const {driver, home} = await service.resolveTarget(harness, flags.home);
    const {status} = await import('../src/engine.mjs');
    const view = await status(service.store, driver.id, home);
    if (!view.installed) { console.log('Nothing installed by recipe-switch.'); return; }
    for (const item of view.history) console.log(`${item.at}  ${item.kind.padEnd(8)} ${item.recipe}  backup ${item.backup}`);
    return;
  }
  if (command === 'ui') {
    const {serve} = await import('../src/server.mjs');
    await serve({service, port: Number(flags.port ?? 4517), open: !flags['no-open']});
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(`recipe-switch: ${error.message}`); process.exitCode = 1; });
