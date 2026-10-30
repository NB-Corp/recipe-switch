// Managed write units. Each unit owns exactly one thing on disk:
//   file          a whole file the loader owns (inside a recipe-switch directory)
//   tomlKey       one single-line string key of a user TOML file (line-exact edit)
//   jsonArrayItem one string item of an array inside a user JSON file
//   jsonKey       one key of an object inside a user JSON file
//   jsonArrayRecord one object matched by id in a user JSON array
//   yamlArrayItem one string in Hermes's plugins.enabled block list
// A unit is compared through a fingerprint so drift (a hand edit) is detected
// before anything is written or restored.
import path from 'node:path';
import {readFile, writeFile, sha256, decode, equalBytes, assertBoundary} from './fsx.mjs';
import {readKeyLine, writeKeyLine, splitKey} from './vendor/toml-key.mjs';
import {setArrayItem, getKey, setKey, rawAt, rawMember, rawItem, replaceRawAt} from './json-edit.mjs';
import {getRecord, setRecord, rawRecord} from './json-record.mjs';
import {inspectYamlList, editYamlList} from './yaml-list.mjs';

const valueUnit = unit => ['jsonKey', 'jsonArrayRecord'].includes(unit.type);

export const ABSENT = 'absent';

const tomlValue = line => line === null ? ABSENT : 'line:' + line;


export const identity = unit => `${unit.type}|${path.resolve(unit.path).toLowerCase()}|${(unit.table ?? []).join('.')}|${unit.key ?? ''}|${(unit.pointer ?? []).join('.')}|${unit.value ?? ''}`;

/** Current fingerprint and the full current file text (for diffs). */
export async function inspect(unit) {
  if (unit.boundary) await assertBoundary(unit.path, unit.boundary);
  return inspectBytes(unit, await readFile(unit.path));
}

export function inspectBytes(unit, bytes) {
  if (unit.type === 'file') return {fp: bytes === null ? ABSENT : 'sha256:' + sha256(bytes), bytes};
  if (unit.type === 'tomlKey') return {fp: bytes === null ? ABSENT : tomlValue(readKeyLine(decode(bytes), unit.table, unit.key)), bytes};
  if (unit.type === 'jsonArrayItem') {
    if (bytes === null) return {fp: ABSENT, bytes};
    let list;
    try { list = getKey(decode(bytes), unit.pointer); } catch { throw new Error(`Not valid JSON; refusing to edit: ${unit.path}`); }
    if (list !== undefined && !Array.isArray(list)) throw new Error(`${unit.pointer.join('.')} is not an array in ${unit.path}`);
    return {fp: list?.includes(unit.value) ? unit.exactSource ? 'raw:' + rawItem(decode(bytes), unit.pointer, unit.value) : 'present' : ABSENT, bytes};
  }
  if (unit.type === 'yamlArrayItem') {
    const state = inspectYamlList(decode(bytes), unit.value);
    // Legacy schema-1 records can derive exact ownership from their saved layout.
    const exact = unit.exactSource || unit.layoutAfter !== undefined || unit.afterFingerprint !== undefined || unit.beforeFingerprint !== undefined;
    return {fp: state.present ? exact ? 'line:' + state.item.body : 'present' : ABSENT, bytes, createdDepth: state.createdDepth};
  }
  if (valueUnit(unit)) {
    if (bytes === null) return {fp: ABSENT, bytes};
    let value;
    try { value = unit.type === 'jsonArrayRecord' ? getRecord(decode(bytes), unit.pointer, unit.value) : getKey(decode(bytes), unit.pointer); }
    catch (error) { throw new Error(`Cannot edit JSON in ${unit.path}: ${error.message}`); }
    const raw = unit.exactSource && value !== undefined ? unit.type === 'jsonArrayRecord'
      ? rawRecord(decode(bytes), unit.pointer, unit.value) : rawMember(decode(bytes), unit.pointer) : undefined;
    return {fp: value === undefined ? ABSENT : unit.exactSource ? 'raw:' + raw : 'value:' + JSON.stringify(value), value, bytes};
  }
  throw new Error(`Unknown unit type ${unit.type}`);
}

/** Fingerprint a unit would have after writing `side` ('before' | 'after'). */
export function fingerprintOf(unit, side) {
  if (unit[side + 'Fingerprint'] !== undefined) return unit[side + 'Fingerprint'];
  if (unit.type === 'file') {
    const bytes = unit[side + 'Bytes'];
    return bytes === null ? ABSENT : 'sha256:' + sha256(bytes);
  }
  if (unit.type === 'tomlKey') return tomlValue(unit[side + 'Line']);
  if (unit.type === 'yamlArrayItem' && unit.layoutAfter !== undefined) {
    const state = inspectYamlList((side === 'after' ? unit.layoutAfter : unit.layoutBefore) ?? '', unit.value);
    return state.present ? 'line:' + state.item.body : ABSENT;
  }
  if (valueUnit(unit)) return unit[side + 'Value'] === undefined ? ABSENT : 'value:' + JSON.stringify(unit[side + 'Value']);
  return unit[side + 'Present'] ? 'present' : ABSENT;
}

/** Compute the file bytes after applying `side` to the current file bytes. */
export function render(unit, side, current) {
  if (unit.type === 'file') return unit[side + 'Bytes'];
  if (unit.type === 'tomlKey') {
    const line = unit[side + 'Line'];
    const text = writeKeyLine(decode(current), unit.table, unit.key, line);
    // A file the loader created for this key alone is removed with the key.
    if (line === null && unit.fileCreated && text.trim() === '') return null;
    return Buffer.from(text);
  }
  // R11: restore the largest unchanged source span, not a reserialized value.
  if (side === 'before' && unit.layoutAfter !== undefined && decode(current) === unit.layoutAfter)
    return unit.layoutBefore === null ? null : Buffer.from(unit.layoutBefore);
  if (side === 'before' && current !== null) for (const span of unit.jsonSpans ?? []) {
    if (span.before !== undefined && rawAt(decode(current), span.pointer) === span.after)
      return Buffer.from(replaceRawAt(decode(current), span.pointer, span.before));
  }
  if (unit.type === 'yamlArrayItem') {
    if (side === 'before' && unit.yamlPatch?.after) {
      const text = decode(current), at = text.indexOf(unit.yamlPatch.after), state = inspectYamlList(text, unit.value);
      const hasOtherItems = unit.createdDepth >= 1 && state.items?.some(item => item !== state.item);
      const hasOtherKeys = unit.createdDepth >= 2 && state.plugin && state.lines.some(line => line.start > state.plugin.start && line.start < state.end &&
        line.indent === state.indent && line.body.trim() && !line.body.trimStart().startsWith('#') && line !== state.enabled);
      if (!hasOtherItems && !hasOtherKeys && at >= 0 && text.indexOf(unit.yamlPatch.after, at + 1) < 0)
        return Buffer.from(text.slice(0, at) + unit.yamlPatch.before + text.slice(at + unit.yamlPatch.after.length));
    }
    const text = editYamlList(decode(current), unit.value, unit[side + 'Present'], unit.createdDepth);
    return unit.fileCreated && !text.trim() ? null : Buffer.from(text);
  }
  if (valueUnit(unit)) {
    const value = unit[side + 'Value'];
    if (current === null && value === undefined) return null;
    let text = current === null ? '{}\n' : decode(current);
    if (value !== undefined) {
      text = ensureParents(text, unit.pointer);
      return Buffer.from(unit.type === 'jsonArrayRecord' ? setRecord(text, unit.pointer, unit.value, value,
        side === 'before' ? unit.recordBefore : undefined) : setKey(text, unit.pointer, value));
    }
    text = unit.type === 'jsonArrayRecord' ? setRecord(text, unit.pointer, unit.value, undefined) : setKey(text, unit.pointer, undefined);
    // Keep the original existing-file jsonKey removal behavior for old records.
    if (unit.createdDepth === undefined) {
      const parent = unit.pointer.slice(0, -1);
      if (unit.parentCreated && parent.length && JSON.stringify(getKey(text, parent)) === '{}') text = setKey(text, parent, undefined);
    } else {
      const start = unit.type === 'jsonArrayRecord' ? unit.pointer.length : unit.pointer.length - 1;
      for (let depth = start; depth > unit.pointer.length - unit.createdDepth; depth--) {
        const at = unit.pointer.slice(0, depth), child = getKey(text, at);
        if (!child || typeof child !== 'object' || Object.keys(child).length) break;
        text = setKey(text, at, undefined);
      }
    }
    return unit.fileCreated && JSON.stringify(JSON.parse(text.replace(/^\uFEFF/, ''))) === '{}' ? null : Buffer.from(text);
  }
  // jsonArrayItem: position-preserving edit. Missing parents are created; on
  // removal, an array (and parents) the loader created are dropped again.
  const want = unit[side + 'Present'];
  if (current === null) {
    if (!want) return null;
    return Buffer.from(setArrayItem(ensureParents('{}\n', unit.pointer), unit.pointer, unit.value, true));
  }
  let text = decode(current);
  if (want) return Buffer.from(setArrayItem(ensureParents(text, unit.pointer), unit.pointer, unit.value, true));
  text = setArrayItem(text, unit.pointer, unit.value, false);
  const createdDepth = unit.createdDepth ?? 0; // how many trailing pointer segments the loader created
  for (let depth = unit.pointer.length; depth > unit.pointer.length - createdDepth; depth--) {
    const at = unit.pointer.slice(0, depth), value = getKey(text, at);
    const empty = Array.isArray(value) ? value.length === 0 : value && typeof value === 'object' && !Object.keys(value).length;
    if (!empty) break;
    text = setKey(text, at, undefined);
  }
  if (unit.fileCreated && JSON.stringify(JSON.parse(text)) === '{}') return null;
  return Buffer.from(text);
}

function ensureParents(text, pointer) {
  for (let depth = 1; depth < pointer.length; depth++)
    if (getKey(text, pointer.slice(0, depth)) === undefined) text = setKey(text, pointer.slice(0, depth), {});
  return text;
}

/** Capture all lexical restoration data from the same bytes used to render. */
export function recordLayout(unit, current, next) {
  if (unit.type === 'file' || unit.type === 'tomlKey') return;
  unit.layoutBefore = current === null ? null : decode(current);
  unit.layoutAfter = next === null ? '' : decode(next);
  if (unit.type === 'yamlArrayItem') {
    unit.beforeFingerprint = inspectBytes(unit, current).fp;
    unit.afterFingerprint = inspectBytes(unit, next).fp;
    const before = unit.layoutBefore ?? '', after = unit.layoutAfter;
    let start = 0, endBefore = before.length, endAfter = after.length;
    while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
    unit.yamlPatch = {before: before.slice(start, endBefore), after: after.slice(start, endAfter)};
    return;
  }
  unit.jsonSpans = [];
  for (let depth = 1; depth <= unit.pointer.length; depth++) {
    const pointer = unit.pointer.slice(0, depth);
    unit.jsonSpans.push({pointer, before: current === null ? undefined : rawAt(decode(current), pointer),
      after: next === null ? undefined : rawAt(decode(next), pointer)});
  }
  if (unit.type === 'jsonArrayRecord' && current !== null) unit.recordBefore = rawRecord(decode(current), unit.pointer, unit.value);
}

/** Write one side conditionally; engine transactions group units by file. */
export async function apply(unit, side, current = undefined) {
  if (unit.boundary) await assertBoundary(unit.path, unit.boundary);
  if (current === undefined) current = await readFile(unit.path);
  const next = render(unit, side, current);
  if (side === 'after') recordLayout(unit, current, next);
  if (equalBytes(current, next)) return [];
  return writeFile(unit.path, next, {expected: current, boundary: unit.boundary});
}

export {splitKey};
