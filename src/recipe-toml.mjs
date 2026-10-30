// Kiki Recipe packages (recipe.toml) with optional, checkbox-style options.
//
//   [options.research]
//   name = "Research guidance"
//   default = true
//
//   [prompts.main]
//   system = [{ file = "main.md" }, { file = "research.md", when = "research" }]
//
// A text source item ({ file } or { text }) may carry `when = "<id>"` (kept
// when the option is on) or `unless = "<id>"` (kept when it is off). Items
// keep their order and are joined with a blank line, as Kiki does. A slot
// whose items are all filtered out stays declared with empty text. Options
// never touch model settings, hooks, permissions or fields.
//
// Shorthand for "this switch adds a sentence before/after a slot":
//   [options.cite]
//   name = "Cite sources"
//   default = false
//   append.main.steering = { text = "Cite the source of each claim." }
//   prepend.common.system = { file = "preface.md" }
// Slot keys: common|main|independent . system|steering|anchor|steering_sources.<source>.
// It expands to gated items (`when = "<id>"`) at the start or end of that slot.
//
// General form, for any text slot and optionally one Markdown section in it:
//   [[options.cite.patch]]
//   slot = "main.system"
//   section = "Verify what determines acceptance"   # heading text, any level
//   action = "append"   # prepend|append (inside section/slot), before|after|replace|remove (section)
//   content = { text = "Cite the source of each claim." }
// Section patches apply, in declaration order, to the slot's assembled text.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse, stringify} from './vendor/smol-toml/index.js';
import {sha256, toPosix} from './fsx.mjs';

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const fail = (file, message) => { throw new Error(`${toPosix(file)}: ${message}`); };
const plain = value => JSON.parse(JSON.stringify(value));
const isSource = value => value && typeof value === 'object' && !Array.isArray(value) && ('file' in value || 'text' in value);

/** Text slots inside one prompts branch, as [path, value] pairs. */
function* slots(branch, at) {
  if (!branch || typeof branch !== 'object') return;
  for (const key of ['system', 'steering']) if (branch[key] !== undefined) yield [[...at, key], branch[key]];
  if (branch.anchor && typeof branch.anchor === 'object' && branch.anchor.content !== undefined) yield [[...at, 'anchor', 'content'], branch.anchor.content];
  for (const [source, setting] of Object.entries(branch.steering_sources ?? {}))
    if (setting?.custom?.steering !== undefined) yield [[...at, 'steering_sources', source, 'custom', 'steering'], setting.custom.steering];
}
function* allSlots(prompts) {
  if (!prompts) return;
  yield* slots(prompts, ['prompts']);
  for (const position of ['main', 'independent'])
    if (prompts[position] && typeof prompts[position] === 'object') yield* slots(prompts[position], ['prompts', position]);
}
const getAt = (object, at) => at.reduce((node, key) => node?.[key], object);

/** TOML dotted keys arrive nested; flatten to "main.steering" → value. */
function flattenTargets(object, prefix = []) {
  const out = [];
  for (const [key, value] of Object.entries(object)) {
    const at = [...prefix, key];
    if (Array.isArray(value) || isSource(value) || !value || typeof value !== 'object') out.push([at.join('.'), value]);
    else out.push(...flattenTargets(value, at));
  }
  return out;
}

/** "main.steering" → ['prompts','main','steering']; "common.system" → ['prompts','system']. */
function patchPath(target) {
  const match = /^(common|main|independent)\.(system|steering|anchor|steering_sources\.([a-z_]+))$/.exec(target);
  if (!match) return null;
  const base = match[1] === 'common' ? ['prompts'] : ['prompts', match[1]];
  if (match[2] === 'anchor') return [...base, 'anchor', 'content'];
  if (match[3]) return [...base, 'steering_sources', match[3], 'custom', 'steering'];
  return [...base, match[2]];
}
export const PATCH_ACTIONS = ['prepend', 'append', 'before', 'after', 'replace', 'remove'];

/**
 * Section-level edit on assembled slot text. A section is a Markdown heading
 * (any level) whose text equals `section`, up to the next heading of the same
 * or higher level. prepend/append insert at the start or end of that section's
 * body; before/after insert next to the whole section; replace/remove swap it.
 */
export function editSection(text, {action, section}, content, where) {
  const fences = [];
  let open = null;
  for (const m of text.matchAll(/^[ \t]{0,3}(`{3,}|~{3,}).*$/gm)) {
    if (!open) open = {index: m.index, marker: m[1]};
    else if (m[1][0] === open.marker[0] && m[1].length >= open.marker.length) { fences.push([open.index, m.index + m[0].length]); open = null; }
  }
  if (open) fences.push([open.index, text.length]);
  const inFence = index => fences.some(([a, b]) => index >= a && index < b);
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/gm)].filter(m => !inFence(m.index))
    .map(m => ({index: m.index, level: m[1].length, title: m[2], end: m.index + m[0].length}));
  const hits = headings.filter(h => h.title === section);
  if (hits.length !== 1) throw new Error(`${where}: expected exactly one heading "${section}", found ${hits.length}`);
  const head = hits[0], next = headings.find(h => h.index > head.index && h.level <= head.level);
  const start = head.index, end = next?.index ?? text.length;
  const block = text.slice(start, end).replace(/\s+$/, ''), tail = text.slice(start + block.length, end);
  const join = (...pieces) => pieces.filter(piece => piece !== '').join('\n\n');
  let replacement;
  if (action === 'remove') replacement = '';
  else if (action === 'replace') replacement = content.replace(/\s+$/, '');
  else if (action === 'before') replacement = join(content.replace(/\s+$/, ''), block);
  else if (action === 'after') replacement = join(block, content.replace(/\s+$/, ''));
  else {
    const headLine = text.slice(start, head.end), body = block.slice(headLine.length).replace(/^\s+/, '');
    replacement = join(headLine, action === 'prepend' ? join(content.replace(/\s+$/, ''), body) : join(body, content.replace(/\s+$/, '')));
  }
  if (replacement === '') return (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, '\n\n');
  return text.slice(0, start) + replacement + (tail || (next ? '\n\n' : '')) + text.slice(end);
}

function setAt(object, at, value) {
  const parent = getAt(object, at.slice(0, -1));
  parent[at.at(-1)] = value;
}

/** Read and validate a recipe.toml. */
export async function readRecipeToml(file) {
  const source = await fs.readFile(file, 'utf8');
  let raw;
  try { raw = plain(parse(source)); } catch (error) { fail(file, `invalid TOML: ${error.message.split('\n')[0]}`); }
  if (!raw.id || !ID.test(raw.id)) fail(file, 'missing or invalid top-level id');
  if (raw.extends) fail(file, 'extends is not supported by Recipe Switch yet; install the materialized package');
  const options = [];
  for (const [id, option] of Object.entries(raw.options ?? {})) {
    if (!ID.test(id)) fail(file, `invalid option id ${id}`);
    if (!option || typeof option.name !== 'string' || !option.name) fail(file, `options.${id}.name is required`);
    if (typeof option.default !== 'boolean') fail(file, `options.${id}.default must be true or false`);
    const extra = Object.keys(option).filter(key => !['name', 'description', 'default', 'prepend', 'append', 'patch'].includes(key));
    if (extra.length) fail(file, `options.${id}: unknown key ${extra[0]}`);
    const where = `options.${id}`, patches = [];
    const items = (value, label, allowEmpty = false) => {
      if (value === undefined && allowEmpty) return [];
      const list = Array.isArray(value) ? value : [value];
      if (!list.length || !list.every(item => isSource(item) && item.when === undefined && item.unless === undefined))
        fail(file, `${label}: expected { file } or { text } items without when/unless`);
      return list;
    };
    const target = (slot, label) => {
      const at = typeof slot === 'string' ? patchPath(slot) : null;
      if (!at) fail(file, `${label}: unknown slot "${slot}" (use common|main|independent . system|steering|anchor|steering_sources.<source>)`);
      const declaredSlot = getAt(raw, at);
      if (declaredSlot === undefined || declaredSlot === 'off') fail(file, `${label}: slot "${slot}" is not declared in this package`);
      return at;
    };
    for (const side of ['prepend', 'append']) for (const [slot, value] of flattenTargets(option[side] ?? {}))
      patches.push({action: side, slot, at: target(slot, `${where}.${side}`), items: items(value, `${where}.${side}.${slot}`)});
    for (const [index, patch] of (option.patch ?? []).entries()) {
      const label = `${where}.patch[${index}]`;
      const unknownKey = Object.keys(patch ?? {}).find(key => !['slot', 'section', 'action', 'content'].includes(key));
      if (unknownKey) fail(file, `${label}: unknown key ${unknownKey}`);
      if (!PATCH_ACTIONS.includes(patch.action)) fail(file, `${label}: action must be one of ${PATCH_ACTIONS.join(', ')}`);
      if (patch.section !== undefined && (typeof patch.section !== 'string' || !patch.section)) fail(file, `${label}: section must be a heading text`);
      if (['before', 'after', 'replace', 'remove'].includes(patch.action) && patch.section === undefined) fail(file, `${label}: ${patch.action} needs a section`);
      if (patch.action === 'remove' && patch.content !== undefined) fail(file, `${label}: remove takes no content`);
      patches.push({action: patch.action, slot: patch.slot, at: target(patch.slot, label), section: patch.section,
        items: items(patch.content, label, patch.action === 'remove')});
    }
    options.push({id, name: option.name, description: option.description ?? '', default: option.default, patches});
  }
  const declared = new Set(options.map(option => option.id));
  const usedBy = new Map(options.map(option => [option.id, []]));
  for (const [at, slot] of allSlots(raw.prompts)) {
    if (slot === 'off') continue;
    for (const item of Array.isArray(slot) ? slot : [slot]) {
      if (!isSource(item)) fail(file, `${at.join('.')}: expected { file } or { text } items`);
      if (item.when !== undefined && item.unless !== undefined) fail(file, `${at.join('.')}: when and unless are exclusive`);
      const ref = item.when ?? item.unless;
      if (ref === undefined) continue;
      if (!declared.has(ref)) fail(file, `${at.join('.')}: unknown option "${ref}"`);
      usedBy.get(ref).push(at.slice(1).join('.'));
    }
  }
  for (const option of options) {
    for (const patch of option.patches) usedBy.get(option.id).push(patch.at.slice(1).join('.'));
    option.affects = [...new Set(usedBy.get(option.id))];
  }
  return {file, dir: path.dirname(file), source, raw, options};
}

/** Option values: declared defaults, overridden by known keys of `selection`. */
export function optionValues(options, selection = {}) {
  const values = {}, unknown = [];
  for (const option of options) values[option.id] = option.default;
  for (const [id, value] of Object.entries(selection ?? {})) {
    if (!(id in values)) { unknown.push(id); continue; }
    values[id] = Boolean(value);
  }
  return {values, unknown};
}

/**
 * Apply option values. Returns the materialized manifest (no [options], no
 * when/unless) and the texts of every slot, joined as Kiki joins them.
 */
export async function evaluate(recipe, values) {
  const out = plain(recipe.raw);
  delete out.options;
  // Whole-slot prepend/append become gated items at the start or end of the slot.
  const sectionPatches = new Map();
  for (const option of recipe.options) for (const patch of option.patches) {
    if (patch.section === undefined) {
      const slot = getAt(out, patch.at), list = Array.isArray(slot) ? slot : [slot];
      const gated = patch.items.map(item => ({...item, when: option.id}));
      setAt(out, patch.at, patch.action === 'prepend' ? [...gated, ...list] : [...list, ...gated]);
    } else if (values[option.id]) {
      const key = patch.at.join('.');
      if (!sectionPatches.has(key)) sectionPatches.set(key, []);
      sectionPatches.get(key).push({...patch, option: option.id});
    }
  }
  const files = new Map(), read = async rel => {
    const target = path.resolve(recipe.dir, rel);
    if (!target.startsWith(path.resolve(recipe.dir) + path.sep)) fail(recipe.file, `file escapes package: ${rel}`);
    if (!files.has(rel)) files.set(rel, await fs.readFile(target));
    return files.get(rel).toString('utf8');
  };
  const texts = new Map();
  for (const [at, slot] of [...allSlots(out.prompts)]) {
    if (slot === 'off') { texts.set(at.join('.'), null); continue; }
    const single = !Array.isArray(slot), kept = [];
    for (const item of single ? [slot] : slot) {
      const ref = item.when ?? item.unless;
      if (ref !== undefined && (item.when !== undefined ? !values[ref] : values[ref])) continue;
      const {when, unless, ...rest} = item;
      kept.push(rest);
    }
    const parts = [];
    for (const item of kept) parts.push('text' in item ? item.text : await read(item.file));
    let text = parts.join('\n\n');
    const edits = sectionPatches.get(at.join('.'));
    if (edits) {
      for (const edit of edits) {
        const content = [];
        for (const item of edit.items) content.push('text' in item ? item.text : await read(item.file));
        text = editSection(text, edit, content.join('\n\n'), `${recipe.file} options.${edit.option}`);
      }
      texts.set(at.join('.'), text);
      setAt(out, at, {text});
      continue;
    }
    texts.set(at.join('.'), text);
    setAt(out, at, kept.length === 0 ? {text: ''} : single || kept.length === 1 ? kept[0] : kept);
  }
  const toml = stringify(out) + '\n';
  return {manifest: out, toml, texts, files};
}

/** The six loader texts from evaluated Kiki slots (same mapping as Kiki positions). */
export function sixTexts(manifest, slotTexts) {
  const prompts = manifest.prompts ?? {};
  const get = key => slotTexts.has(key) ? slotTexts.get(key) : undefined;
  const branch = position => prompts[position] === 'off' ? 'off' : prompts[position] === 'same' || prompts[position] === undefined ? 'common' : 'own';
  const pick = (position, slot) => {
    const kind = branch(position);
    if (kind === 'off') return null;
    return kind === 'own' ? get(`prompts.${position}.${slot}`) ?? null : get(`prompts.${slot}`) ?? null;
  };
  const common = get('prompts.system') ?? null;
  const main = pick('main', 'system') ?? common;
  if (main === null) throw new Error('recipe has no main or common system text');
  const userSteer = pick('main', 'steering');
  const agentSteer = branch('main') === 'own'
    ? get('prompts.main.steering_sources.agent.custom.steering') ?? (prompts.main?.steering_sources?.agent?.mode === 'off' ? null : userSteer)
    : get('prompts.steering_sources.agent.custom.steering') ?? userSteer;
  return {main, sub: common ?? main, independent: pick('independent', 'system') ?? common ?? main,
    userSteer, subSteer: get('prompts.steering') ?? null, agentSteer};
}

/** Stable digest of a materialized package and its option values. */
export function revisionOf(toml, files, values) {
  const parts = [toml, JSON.stringify(values), ...[...files].sort(([a], [b]) => a.localeCompare(b)).map(([rel, bytes]) => rel + '\0' + sha256(bytes))];
  return 'sha256:' + sha256(Buffer.from(parts.join('\n'))).slice(0, 16);
}
