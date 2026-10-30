import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../src/vendor/smol-toml/index.js';
import {readKeyLine, writeKeyLine} from '../src/vendor/toml-key.mjs';

const BASIC_FIXTURE = String.raw`[models.demo]
description = """
escaped \"""
recipe = "FAKE KEY IN DESCRIPTION"
ignore = \"""
"""
model = "keep"
`;

const LITERAL_FIXTURE = String.raw`[models.demo]
description = '''
literal \'''
recipe = "keep"
model = "keep"
`;

test('R07: escaped delimiters stay inside basic multiline strings during recipe edits', () => {
  assert.equal(readKeyLine(BASIC_FIXTURE, ['models', 'demo'], 'recipe'), null);
  const before = parse(BASIC_FIXTURE);
  assert.equal(before.models.demo.recipe, undefined);
  assert.equal(before.models.demo.model, 'keep');

  const edited = writeKeyLine(BASIC_FIXTURE, ['models', 'demo'], 'recipe', 'recipe = "actual"');
  assert.equal(edited, String.raw`[models.demo]
recipe = "actual"
description = """
escaped \"""
recipe = "FAKE KEY IN DESCRIPTION"
ignore = \"""
"""
model = "keep"
`);

  const after = parse(edited);
  assert.equal(after.models.demo.recipe, 'actual');
  assert.equal(after.models.demo.model, 'keep');
  assert.equal(after.models.demo.description, String.raw`escaped """
recipe = "FAKE KEY IN DESCRIPTION"
ignore = """
`);
});

test('R07: literal multiline strings do not treat a backslash as escaping triple single quotes', () => {
  assert.equal(readKeyLine(LITERAL_FIXTURE, ['models', 'demo'], 'recipe'), 'recipe = "keep"');

  const edited = writeKeyLine(LITERAL_FIXTURE, ['models', 'demo'], 'recipe', 'recipe = "actual"');
  const parsed = parse(edited);
  assert.equal(parsed.models.demo.description, 'literal \\');
  assert.equal(parsed.models.demo.recipe, 'actual');
  assert.equal(parsed.models.demo.model, 'keep');
});
