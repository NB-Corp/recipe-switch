// Position-preserving JSON edits: change one key or one array item and leave
// every other byte (indentation, key order, odd formatting) untouched.
function fail(message) { throw new Error(message); }

/** Parse JSON into a node tree that records source offsets. */
export function parseTree(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n\uFEFF'.includes(text[i])) i++; };
  function string() {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '"') fail('unterminated JSON string');
    i++;
    return {type: 'string', start, end: i, value: JSON.parse(text.slice(start, i))};
  }
  function value() {
    ws();
    const start = i, ch = text[i];
    if (ch === '{') {
      i++; const members = [];
      ws();
      if (text[i] === '}') { i++; return {type: 'object', start, end: i, members}; }
      for (;;) {
        ws(); if (text[i] !== '"') fail(`expected key at ${i}`);
        const key = string(); ws();
        if (text[i++] !== ':') fail(`expected : at ${i}`);
        const node = value();
        members.push({key: key.value, keyStart: key.start, node});
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return {type: 'object', start, end: i, members}; }
        fail(`expected , or } at ${i}`);
      }
    }
    if (ch === '[') {
      i++; const items = [];
      ws();
      if (text[i] === ']') { i++; return {type: 'array', start, end: i, items}; }
      for (;;) {
        items.push(value()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return {type: 'array', start, end: i, items}; }
        fail(`expected , or ] at ${i}`);
      }
    }
    if (ch === '"') return string();
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!match) fail(`unexpected JSON token at ${i}`);
    i += match[0].length;
    return {type: 'scalar', start, end: i, value: JSON.parse(match[0])};
  }
  const root = value(); ws();
  if (i !== text.length) fail('trailing content after JSON value');
  return root;
}

function find(root, pointer) {
  let node = root;
  for (const key of pointer) {
    if (node?.type !== 'object') return undefined;
    node = node.members.find(member => member.key === key)?.node;
  }
  return node;
}

function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
}
const newlineOf = text => text.includes('\r\n') ? '\r\n' : '\n';

function insertMember(text, object, key, rendered) {
  const nl = newlineOf(text);
  const entry = `${JSON.stringify(key)}: ${rendered}`;
  if (!object.members.length) {
    const indent = lineIndent(text, object.start) + '  ';
    return text.slice(0, object.start + 1) + nl + indent + entry + nl + lineIndent(text, object.start) + text.slice(object.end - 1);
  }
  const last = object.members.at(-1), indent = lineIndent(text, last.keyStart);
  const multiline = text.slice(object.start, last.keyStart).includes('\n');
  return text.slice(0, last.node.end) + ',' + (multiline ? nl + indent : ' ') + entry + text.slice(last.node.end);
}

/** Set (value !== undefined) or delete object key at pointer. */
export function setKey(text, pointer, value) {
  const root = parseTree(text), parent = find(root, pointer.slice(0, -1)), key = pointer.at(-1);
  if (parent?.type !== 'object') fail(`JSON object ${pointer.slice(0, -1).join('.') || '(root)'} not found`);
  const index = parent.members.findIndex(member => member.key === key);
  if (value === undefined) {
    if (index < 0) return text;
    const member = parent.members[index];
    if (parent.members.length === 1) return text.slice(0, parent.start + 1) + text.slice(parent.end - 1).replace(/^\s*/, '');
    if (index === parent.members.length - 1) {
      const prevEnd = parent.members[index - 1].node.end;
      return text.slice(0, prevEnd) + text.slice(member.node.end);
    }
    return text.slice(0, member.keyStart) + text.slice(parent.members[index + 1].keyStart);
  }
  const rendered = JSON.stringify(value);
  if (index >= 0) {
    const node = parent.members[index].node;
    return text.slice(0, node.start) + rendered + text.slice(node.end);
  }
  return insertMember(text, parent, key, rendered);
}

export function getKey(text, pointer) {
  const raw = rawAt(text, pointer);
  return raw === undefined ? undefined : JSON.parse(raw);
}

export function rawAt(text, pointer) {
  const node = find(parseTree(text), pointer);
  return node === undefined ? undefined : text.slice(node.start, node.end);
}

export function rawMember(text, pointer) {
  const parent = find(parseTree(text), pointer.slice(0, -1));
  const member = parent?.members?.find(member => member.key === pointer.at(-1));
  return member ? text.slice(member.keyStart, member.node.end) : undefined;
}

export function rawItem(text, pointer, value) {
  const array = find(parseTree(text), pointer);
  const item = array?.items?.find(item => item.type === 'string' && item.value === value);
  return item ? text.slice(item.start, item.end) : undefined;
}

export function replaceRawAt(text, pointer, raw) {
  const node = find(parseTree(text), pointer);
  if (!node) fail(`JSON value ${pointer.join('.')} not found`);
  return text.slice(0, node.start) + raw + text.slice(node.end);
}

/** Add or remove one string item of the array at pointer. */
export function setArrayItem(text, pointer, item, present) {
  const root = parseTree(text), array = find(root, pointer);
  if (array === undefined) {
    if (!present) return text;
    return setKey(text, pointer, [item]);
  }
  if (array.type !== 'array') fail(`${pointer.join('.')} is not an array`);
  const index = array.items.findIndex(node => node.type === 'string' && node.value === item);
  if (present) {
    if (index >= 0) return text;
    const rendered = JSON.stringify(item);
    if (!array.items.length) return text.slice(0, array.start + 1) + rendered + text.slice(array.start + 1);
    const last = array.items.at(-1);
    const multiline = text.slice(array.start, last.start).includes('\n');
    const spaced = array.items.length < 2 || /,s/.test(text.slice(array.items[0].end, array.items[1].start));
    return text.slice(0, last.end) + ',' + (multiline ? newlineOf(text) + lineIndent(text, last.start) : spaced ? ' ' : '') + rendered + text.slice(last.end);
  }
  if (index < 0) return text;
  const node = array.items[index];
  if (array.items.length === 1) return text.slice(0, node.start) + text.slice(node.end);
  if (index === array.items.length - 1) return text.slice(0, array.items[index - 1].end) + text.slice(node.end);
  return text.slice(0, node.start) + text.slice(array.items[index + 1].start);
}
