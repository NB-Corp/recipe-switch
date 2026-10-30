// Position-preserving object-array entry edits for Kimi's installed registry.
import {parseTree, setKey} from './json-edit.mjs';

function arrayAt(text, pointer) {
  let node = parseTree(text);
  for (const key of pointer) node = node?.type === 'object' ? node.members.find(member => member.key === key)?.node : undefined;
  if (node && node.type !== 'array') throw new Error(`${pointer.join('.')} is not an array`);
  return node;
}

export function getRecord(text, pointer, id) {
  const array = arrayAt(text, pointer);
  const matches = (array?.items ?? []).filter(node => node.type === 'object' && JSON.parse(text.slice(node.start, node.end)).id === id);
  if (matches.length > 1) throw new Error(`Duplicate plugin id ${id} in ${pointer.join('.')}`);
  const node = matches[0];
  return node ? JSON.parse(text.slice(node.start, node.end)) : undefined;
}

export function setRecord(text, pointer, id, value) {
  const array = arrayAt(text, pointer);
  if (!array) return value === undefined ? text : setKey(text, pointer, [value]);
  getRecord(text, pointer, id); // Reject ambiguous ownership before editing.
  const index = array.items.findIndex(node => node.type === 'object' && JSON.parse(text.slice(node.start, node.end)).id === id);
  if (index >= 0) {
    const node = array.items[index];
    if (value !== undefined) return text.slice(0, node.start) + JSON.stringify(value) + text.slice(node.end);
    if (array.items.length === 1) return text.slice(0, node.start) + text.slice(node.end);
    if (index === array.items.length - 1) return text.slice(0, array.items[index - 1].end) + text.slice(node.end);
    return text.slice(0, node.start) + text.slice(array.items[index + 1].start);
  }
  if (value === undefined) return text;
  const last = array.items.at(-1), at = last?.end ?? array.start + 1;
  const multiline = last && text.slice(array.start, last.start).includes('\n');
  const indent = last ? /^\s*/.exec(text.slice(text.lastIndexOf('\n', last.start - 1) + 1, last.start))[0] : '';
  const separator = last ? ',' + (multiline ? (text.includes('\r\n') ? '\r\n' : '\n') + indent : ' ') : '';
  return text.slice(0, at) + separator + JSON.stringify(value) + text.slice(at);
}
