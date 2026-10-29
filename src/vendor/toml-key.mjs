// Adapted from gpt-with-taste/src/toml-overlay.mjs (MIT), itself adapted from
// nb-codex-main/src/toml-overlay.mjs (MIT, Copyright (c) 2026 X-T-E-R).
// Change: the single-key scanner is generalized to one string key inside any
// standard table (or the root), so config.toml can be edited line-exactly.
function fail(message) { throw new Error(message); }
function isEscaped(value, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
function lexLine(raw, activeMultiline) {
  if (activeMultiline) {
    const closeAt = raw.indexOf(activeMultiline);
    return {code: '', depthDelta: 0, multiline: closeAt >= 0 ? null : activeMultiline, wasMultiline: true};
  }
  let quote = null, code = '', depthDelta = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index], triple = raw.slice(index, index + 3);
    if (!quote && (triple === '"""' || triple === "'''")) {
      const closeAt = raw.indexOf(triple, index + 3);
      if (closeAt < 0) return {code, depthDelta, multiline: triple, wasMultiline: false};
      code += raw.slice(index, closeAt + 3);
      index = closeAt + 2;
      continue;
    }
    if (!quote && char === '#') break;
    if (!quote && (char === '"' || char === "'")) quote = char;
    else if (quote === char && (quote === "'" || !isEscaped(raw, index))) quote = null;
    if (!quote) {
      if (char === '[' || char === '{') depthDelta += 1;
      if (char === ']' || char === '}') depthDelta -= 1;
    }
    code += char;
  }
  return {code, depthDelta, multiline: null, wasMultiline: false};
}
function findEquals(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!quote && (char === '"' || char === "'")) quote = char;
    else if (quote === char && (quote === "'" || !isEscaped(value, index))) quote = null;
    else if (!quote && char === '=') return index;
  }
  return -1;
}
function tokenRange(raw, equals) {
  let start = equals + 1;
  while (start < raw.length && /\s/.test(raw[start])) start += 1;
  const quote = raw[start];
  if (quote === '"' || quote === "'") {
    for (let index = start + 1; index < raw.length; index += 1)
      if (raw[index] === quote && (quote === "'" || !isEscaped(raw, index))) return {start, end: index + 1};
    return {start, end: raw.length};
  }
  let end = start;
  while (end < raw.length && !/\s|#/.test(raw[end])) end += 1;
  return {start, end};
}
/** Split a dotted TOML key (bare or quoted segments) into plain segments. */
export function splitKey(text) {
  const parts = [];
  let index = 0;
  const source = text.trim();
  while (index < source.length) {
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    const char = source[index];
    if (char === '"' || char === "'") {
      let end = index + 1, value = '';
      while (end < source.length && !(source[end] === char && (char === "'" || !isEscaped(source, end)))) end += 1;
      if (end >= source.length) fail(`unterminated quoted key: ${text}`);
      value = source.slice(index + 1, end);
      parts.push(char === '"' ? JSON.parse(`"${value}"`) : value);
      index = end + 1;
    } else {
      let end = index;
      while (end < source.length && source[end] !== '.' && source[end] !== ' ' && source[end] !== '\t') end += 1;
      parts.push(source.slice(index, end));
      index = end;
    }
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    if (index < source.length) {
      if (source[index] !== '.') fail(`unsupported key syntax: ${text}`);
      index += 1;
    }
  }
  return parts;
}
const samePath = (a, b) => a.length === b.length && a.every((part, index) => part === b[index]);


/**
 * Locate one single-line string assignment `key` inside standard table `table`
 * (array of segments; [] = root). Returns the split lines, the table header
 * line index (null for root, -1 when the table is absent), the index where the
 * table's body ends, and the assignment (or null).
 */
export function scanKey(text, table, key) {
  if (text.includes('\0')) fail('TOML contains a NUL byte');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hasBom = Boolean(lines.length && lines[0].startsWith('\uFEFF'));
  if (hasBom) lines[0] = lines[0].slice(1);
  const root = table.length === 0;
  let current = [], header = root ? null : -1, sectionEnd = root ? lines.length : -1, inTarget = root;
  let multiline = null, continuation = 0;
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r?\n$/, '');
    const lexical = lexLine(raw, multiline);
    multiline = lexical.multiline;
    if (lexical.wasMultiline) continue;
    const code = lexical.code.trim();
    if (!code) continue;
    if (continuation > 0) { continuation += lexical.depthDelta; continue; }
    if (code.startsWith('[')) {
      if (inTarget) { sectionEnd = index; inTarget = false; }
      if (code.startsWith('[[')) current = null;
      else {
        current = splitKey(code.slice(1, code.lastIndexOf(']')));
        if (!root && samePath(current, table)) {
          if (header !== -1) fail(`duplicate TOML table [${table.join('.')}]`);
          header = index; inTarget = true; sectionEnd = lines.length;
        }
      }
      continue;
    }
    const equals = findEquals(lexical.code);
    if (equals < 0) fail(`unsupported TOML statement at line ${index + 1}`);
    if (inTarget) {
      const keyPath = splitKey(lexical.code.slice(0, equals));
      if (keyPath.length === 1 && keyPath[0] === key) {
        const rest = lexical.code.slice(equals + 1).trim();
        if (lexical.multiline || rest.startsWith('"""') || rest.startsWith("'''")) fail(`${key} must be a single-line string`);
        const range = tokenRange(raw, equals), token = raw.slice(range.start, range.end), tail = raw.slice(range.end).trim();
        if (!['"', "'"].includes(token[0]) || token.length < 2 || token.at(-1) !== token[0] || (tail && !tail.startsWith('#')))
          fail(`${key} must be a single-line string`);
        found.push({index, raw, ...range});
      } else if (keyPath[0] === key && keyPath.length > 1) fail(`ambiguous dotted ${key} key`);
    }
    continuation = Math.max(0, lexical.depthDelta);
  }
  if (multiline || continuation !== 0) fail('unterminated TOML string, array or inline table');
  if (found.length > 1) fail(`duplicate ${key} key`);
  return {lines, newline, hasBom, header, sectionEnd, assignment: found[0] ?? null};
}

const join = doc => (doc.hasBom ? '\uFEFF' : '') + doc.lines.join('');

/** The exact current line (without newline) for table.key, or null. */
export function readKeyLine(text, table, key) {
  const doc = scanKey(text, table, key);
  return doc.assignment ? doc.assignment.raw : null;
}

/**
 * Replace (or insert) table.key with `line` (no newline), or remove it when
 * line is null. Inserting into an absent table is refused: callers only manage
 * keys of tables the user already defined, plus the root.
 */
export function writeKeyLine(text, table, key, line) {
  const doc = scanKey(text, table, key);
  if (doc.assignment) {
    const a = doc.assignment, ending = doc.lines[a.index].slice(a.raw.length);
    if (line === null) doc.lines.splice(a.index, 1);
    else doc.lines[a.index] = line + (ending || (a.index < doc.lines.length - 1 ? doc.newline : ''));
    return join(doc);
  }
  if (line === null) return text;
  if (doc.header === -1) fail(`TOML table [${table.join('.')}] is not defined; refusing to create it`);
  const at = doc.header === null ? 0 : doc.header + 1;
  doc.lines.splice(at, 0, line + doc.newline);
  return join(doc);
}

export const tomlString = value => JSON.stringify(value);
