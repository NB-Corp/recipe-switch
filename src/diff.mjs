// Dependency-free unified line diff. Common prefix/suffix are trimmed first,
// so typical config edits (one changed line) stay cheap on large files.
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map(line => ['-', line]), ...b.map(line => ['+', line])];
  const table = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

const split = text => text === null ? [] : text.replace(/\r\n/g, '\n').split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));

/** Returns {text, added, removed}; text is '' when equal. */
export function unifiedDiff(before, after, {path = 'file', context = 3} = {}) {
  const a = split(before), b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [
    ...a.slice(0, start).map(line => [' ', line]),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(line => [' ', line]),
  ];
  const added = ops.filter(op => op[0] === '+').length, removed = ops.filter(op => op[0] === '-').length;
  if (!added && !removed) return {text: '', added, removed};
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
      body.map(([sign, line]) => sign + line).join('\n'));
    index = to;
  }
  const header = `--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n`;
  return {text: header + hunks.join('\n') + '\n', added, removed};
}
