#!/usr/bin/env node
// Regenerates expected.json and the materialized/ packages for each option selection.
//   node examples/options-sample/build-expected.mjs [--check]
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRecipeToml, evaluate} from '../../src/recipe-toml.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CASES = {
  defaults: {},
  'all-on': {brief: true, review: true, quiet: true},
  'all-off': {brief: false, review: false, quiet: false},
  'review-only': {brief: false, review: true},
};

const recipe = await readRecipeToml(path.join(DIR, 'recipe.toml'));
const expected = {}, outputs = new Map();
for (const [name, selection] of Object.entries(CASES)) {
  const values = Object.fromEntries(recipe.options.map(o => [o.id, selection[o.id] ?? o.default]));
  const {texts, toml} = await evaluate(recipe, values);
  expected[name] = {recipe_options: selection, values, slots: Object.fromEntries(texts)};
  outputs.set(path.join(DIR, 'materialized', name, 'recipe.toml'), toml);
  // Files still referenced by { file } items travel with the materialized package so Kiki can load it as-is.
  for (const rel of new Set([...toml.matchAll(/^file = "([^"]+)"$/gm)].map(m => m[1])))
    outputs.set(path.join(DIR, 'materialized', name, rel), await fs.readFile(path.join(DIR, rel), 'utf8'));
}
outputs.set(path.join(DIR, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');

const check = process.argv.includes('--check');
let stale = 0;
for (const [file, text] of outputs) {
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current === text) continue;
  if (check) { stale++; console.error(`stale: ${path.relative(DIR, file)}`); continue; }
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, text);
  console.log(`wrote ${path.relative(DIR, file)}`);
}
if (check && stale) process.exit(1);
