import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readRecipeToml, optionValues, evaluate, sixTexts} from '../src/recipe-toml.mjs';

async function pack(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recipe-switch-opt-'));
  for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, rel)), {recursive: true}); await fs.writeFile(path.join(dir, rel), text); }
  return path.join(dir, 'recipe.toml');
}

const MANIFEST = `schema_version = 1
id = "demo"
name = "Demo"
version = "1.0.0"

[options.research]
name = "Research"
default = true

[options.terse]
name = "Terse"
default = false

[options.cite]
name = "Cite"
default = false
append.main.steering = { text = "Cite sources." }
prepend.common.system = { text = "PRE" }

[prompts]
system = { file = "sub.md" }
steering = { text = "sub steer" }

[prompts.main]
system = [{ file = "main.md" }, { file = "research.md", when = "research" }, { text = "Long form.", unless = "terse" }]
steering = { text = "Keep going." }

[prompts.independent]
system = [{ text = "only research", when = "research" }]
`;

test('options: defaults, when/unless, prepend/append, empty slot stays declared', async () => {
  const file = await pack({'recipe.toml': MANIFEST, 'main.md': 'MAIN', 'research.md': 'RESEARCH', 'sub.md': 'SUB'});
  const recipe = await readRecipeToml(file);
  assert.deepEqual(recipe.options.map(o => [o.id, o.default]), [['research', true], ['terse', false], ['cite', false]]);
  assert.deepEqual(recipe.options.find(o => o.id === 'cite').affects.sort(), ['main.steering', 'system']);

  const base = await evaluate(recipe, optionValues(recipe.options).values);
  const t = sixTexts(base.manifest, base.texts);
  assert.equal(t.main, 'MAIN\n\nRESEARCH\n\nLong form.');
  assert.equal(t.userSteer, 'Keep going.');
  assert.equal(t.sub, 'SUB');
  assert.doesNotMatch(base.toml, /options|when|unless/);

  const {values, unknown} = optionValues(recipe.options, {research: false, terse: true, cite: true, gone: true});
  assert.deepEqual(unknown, ['gone']);
  const flipped = await evaluate(recipe, values);
  const f = sixTexts(flipped.manifest, flipped.texts);
  assert.equal(f.main, 'MAIN');
  assert.equal(f.userSteer, 'Keep going.\n\nCite sources.');
  assert.equal(f.sub, 'PRE\n\nSUB');
  assert.equal(f.independent, '');
  const {parse} = await import('../src/vendor/smol-toml/index.js');
  const back = JSON.parse(JSON.stringify(parse(flipped.toml)));
  assert.deepEqual(back.prompts.independent.system, {text: ''});
  assert.deepEqual(back.prompts.main.steering, [{text: 'Keep going.'}, {text: 'Cite sources.'}]);
  assert.equal(back.options, undefined);
});

test('options: section patches insert, replace and remove inside any text slot', async () => {
  const main = '# Main\n\nIntro.\n\n## Verify\n\nCheck it.\n\n### Detail\n\nDeep.\n\n## Write\n\nPlainly.\n';
  const file = await pack({'recipe.toml': `schema_version = 1
id = "p"
name = "P"
version = "1.0.0"

[options.cite]
name = "Cite"
default = true

[[options.cite.patch]]
slot = "main.system"
section = "Verify"
action = "append"
content = { text = "Cite sources." }

[[options.cite.patch]]
slot = "main.system"
section = "Write"
action = "before"
content = { file = "extra.md" }

[options.lean]
name = "Lean"
default = false

[[options.lean.patch]]
slot = "main.system"
section = "Detail"
action = "remove"

[[options.lean.patch]]
slot = "common.steering"
action = "prepend"
content = { text = "Be brief." }

[prompts]
system = { text = "sub" }
steering = { text = "steer" }

[prompts.main]
system = { file = "main.md" }
`, 'main.md': main, 'extra.md': '## Extra\n\nMore.'});
  const recipe = await readRecipeToml(file);
  const on = await evaluate(recipe, optionValues(recipe.options).values);
  const t = sixTexts(on.manifest, on.texts);
  assert.equal(t.main, '# Main\n\nIntro.\n\n## Verify\n\nCheck it.\n\n### Detail\n\nDeep.\n\nCite sources.\n\n## Extra\n\nMore.\n\n## Write\n\nPlainly.\n');
  assert.equal(t.subSteer, 'steer');
  const lean = await evaluate(recipe, optionValues(recipe.options, {cite: false, lean: true}).values);
  const l = sixTexts(lean.manifest, lean.texts);
  assert.equal(l.main, '# Main\n\nIntro.\n\n## Verify\n\nCheck it.\n\n## Write\n\nPlainly.\n');
  assert.equal(l.subSteer, 'Be brief.\n\nsteer');
  const {editSection} = await import('../src/recipe-toml.mjs');
  assert.equal(editSection('# A\n\n```md\n## B\n```\n\n## B\n\nx\n', {action: 'remove', section: 'B'}, '', 't'), '# A\n\n```md\n## B\n```\n\n');
  await assert.rejects(evaluate(await readRecipeToml(await pack({'recipe.toml': `schema_version = 1\nid = "q"\nname = "Q"\nversion = "1.0.0"\n[options.o]\nname = "O"\ndefault = true\n[[options.o.patch]]\nslot = "main.system"\nsection = "Missing"\naction = "remove"\n[prompts.main]\nsystem = { text = "# A" }\n`})), {o: true}), /exactly one heading "Missing"/);
});

test('options: validation errors', async () => {
  const bad = async body => readRecipeToml(await pack({'recipe.toml': `schema_version = 1\nid = "x"\nname = "X"\nversion = "1.0.0"\n${body}`, 'a.md': 'A'}));
  await assert.rejects(bad('[prompts]\nsystem = [{ file = "a.md", when = "nope" }]\n'), /unknown option "nope"/);
  await assert.rejects(bad('[options.o]\nname = "O"\ndefault = true\n[prompts]\nsystem = [{ file = "a.md", when = "o", unless = "o" }]\n'), /exclusive/);
  await assert.rejects(bad('[options.o]\nname = "O"\n'), /default must be/);
  await assert.rejects(bad('[options.o]\nname = "O"\ndefault = true\nappend.main.steering = { text = "x" }\n[prompts]\nsystem = { file = "a.md" }\n'), /not declared/);
  await assert.rejects(bad('[options.o]\nname = "O"\ndefault = true\nappend.main.bogus = { text = "x" }\n'), /unknown slot/);
});
