// Dependency-free unified line diff. Common prefix/suffix are trimmed first,
// so typical config edits (one changed line) stay cheap on large files.
// Keep each line's terminator separately: normalizing CRLF and dropping the
// final empty split entry would otherwise hide meaningful byte changes.
function sameLine(a, b) {
  return a.line === b.line && a.ending === b.ending;
}

function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map(line => ['-', line]), ...b.map(line => ['+', line])];
  const table = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = sameLine(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sameLine(a[i], b[j])) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function split(text) {
  if (text === null || text === '') return [];
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      const crlf = i > start && text[i - 1] === '\r';
      lines.push({line: text.slice(start, crlf ? i - 1 : i), ending: crlf ? '\r\n' : '\n'});
      start = i + 1;
    } else if (text[i] === '\r' && text[i + 1] !== '\n') {
      lines.push({line: text.slice(start, i), ending: '\r'});
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({line: text.slice(start), ending: ''});
  return lines;
}

function lineEndingMarker(record, counterpart) {
  if (counterpart && counterpart.ending === record.ending) return [];
  if (record.ending === '') return ['\\ No newline at end of file'];
  if (!counterpart && record.ending === '\n') return [];
  const name = record.ending === '\r\n' ? 'CRLF' : record.ending === '\r' ? 'CR' : 'LF';
  return [`\\ Line ending: ${name}`];
}

function renderBody(ops) {
  const rendered = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index][0] === ' ') {
      rendered.push(` ${ops[index][1].line}`);
      index++;
      continue;
    }
    const start = index;
    while (index < ops.length && ops[index][0] !== ' ') index++;
    const group = ops.slice(start, index);
    const removed = group.filter(([sign]) => sign === '-');
    const added = group.filter(([sign]) => sign === '+');
    const pairs = new Map();
    const usedAdded = new Set();
    const pair = (oldOp, newOp) => {
      pairs.set(oldOp, newOp[1]);
      pairs.set(newOp, oldOp[1]);
      usedAdded.add(newOp);
    };
    // Prefer equal text so an insertion does not obscure a CRLF/LF change on
    // a nearby line; then pair remaining replacements in their diff order.
    for (const oldOp of removed) {
      const newOp = added.find(candidate => !usedAdded.has(candidate) && candidate[1].line === oldOp[1].line);
      if (newOp) pair(oldOp, newOp);
    }
    const remainingOld = removed.filter(op => !pairs.has(op));
    const remainingNew = added.filter(op => !usedAdded.has(op));
    for (let i = 0; i < Math.min(remainingOld.length, remainingNew.length); i++) pair(remainingOld[i], remainingNew[i]);
    for (const op of group) {
      const [sign, record] = op;
      rendered.push(sign + record.line);
      rendered.push(...lineEndingMarker(record, pairs.get(op)));
    }
  }
  return rendered;
}

/** Returns {text, added, removed}; text is '' when equal. */
export function unifiedDiff(before, after, {path = 'file', context = 3} = {}) {
  const a = split(before), b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && sameLine(a[start], b[start])) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && sameLine(a[endA - 1], b[endB - 1])) { endA--; endB--; }
  const ops = [
    ...a.slice(0, start).map(line => [' ', line]),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(line => [' ', line]),
  ];
  const added = ops.filter(op => op[0] === '+').length, removed = ops.filter(op => op[0] === '-').length;
  const header = `--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n`;
  if (!added && !removed) {
    const presenceChanged = (before === null) !== (after === null);
    return {text: presenceChanged ? header : '', added, removed};
  }
  const hunks = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index][0] === ' ') index++;
    if (index >= ops.length) break;
    let from = Math.max(0, index - context), to = index;
    while (to < ops.length) {
      if (ops[to][0] !== ' ') { to++; continue; }
      let run = to;
      while (run < ops.length && ops[run][0] === ' ') run++;
      if (run >= ops.length || run - to > context * 2) { to = Math.min(ops.length, to + context); break; }
      to = run;
    }
    let lineA = 1, lineB = 1;
    for (let k = 0; k < from; k++) { if (ops[k][0] !== '+') lineA++; if (ops[k][0] !== '-') lineB++; }
    const body = ops.slice(from, to);
    const countA = body.filter(op => op[0] !== '+').length, countB = body.filter(op => op[0] !== '-').length;
    hunks.push(`@@ -${countA ? lineA : lineA - 1},${countA} +${countB ? lineB : lineB - 1},${countB} @@\n` +
      renderBody(body).join('\n'));
    index = to;
  }
  return {text: header + hunks.join('\n') + '\n', added, removed};
}
