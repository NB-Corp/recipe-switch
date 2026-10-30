// Conservative block-YAML editor for Hermes's plugins.enabled list. It never
// parses/reformats unrelated settings and refuses aliases, flow and complex shapes.
const fail = detail => { throw new Error(`Cannot safely edit plugins.enabled: ${detail}. Use block YAML with a string list, then preview again.`); };
const significant = line => line.body.trim() && !line.body.trimStart().startsWith('#');

function linesOf(text) {
  const lines = []; let offset = text.startsWith('\uFEFF') ? 1 : 0;
  for (const raw of text.slice(offset).match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []) {
    if (!raw) continue;
    const body = raw.replace(/[\r\n]+$/, '');
    lines.push({start: offset, end: offset + raw.length, body, indent: body.match(/^ */)[0].length});
    offset += raw.length;
  }
  return lines;
}

export function inspectYamlList(text, value = 'recipe-switch') {
  const lines = linesOf(text), active = lines.filter(significant);
  if (active.some(line => /^\s*\t/.test(line.body) || /^(?:---|\.\.\.|%)/.test(line.body.trim()))) fail('tabs or document directives');
  const roots = active.filter(line => line.indent === 0);
  if (roots.some(line => !/^[A-Za-z_][\w-]*\s*:/.test(line.body))) fail('root is not a simple mapping');
  const plugins = roots.filter(line => /^plugins\s*:/.test(line.body));
  if (plugins.length > 1) fail('duplicate plugins keys');
  const plugin = plugins[0];
  if (!plugin) return {present: false, createdDepth: 2, text, lines};
  if (!/^plugins\s*:\s*(?:#.*)?$/.test(plugin.body)) fail('plugins must be a block mapping (no flow style, anchors or aliases)');
  const end = roots.find(line => line.start > plugin.start)?.start ?? text.length;
  const children = active.filter(line => line.start > plugin.start && line.start < end);
  const indent = children.length ? Math.min(...children.map(line => line.indent)) : plugin.indent + 2;
  const direct = children.filter(line => line.indent === indent);
  if (direct.some(line => !/^\s+[A-Za-z_][\w-]*\s*:/.test(line.body) || /^\s*<<\s*:/.test(line.body))) fail('complex plugins mapping');
  const enabledKeys = direct.filter(line => /^\s+enabled\s*:/.test(line.body));
  if (enabledKeys.length > 1) fail('duplicate enabled keys');
  const enabled = enabledKeys[0];
  if (!enabled) return {present: false, createdDepth: 1, text, lines, plugin, end, indent};
  if (!/^\s+enabled\s*:\s*(?:#.*)?$/.test(enabled.body)) fail('enabled must be a block list (no flow style, anchors or aliases)');
  const listEnd = direct.find(line => line.start > enabled.start)?.start ?? end;
  const items = children.filter(line => line.start > enabled.start && line.start < listEnd);
  const itemIndent = items[0]?.indent ?? indent + 2;
  const matches = [];
  for (const line of items) {
    const match = /^\s+-\s+(?:([A-Za-z0-9_.\/-]+)|"([A-Za-z0-9_.\/-]+)"|'([A-Za-z0-9_.\/-]+)')\s*(?:#.*)?$/.exec(line.body);
    if (!match || line.indent !== itemIndent || itemIndent < indent) fail('enabled contains a complex or non-string list item');
    if ((match[1] ?? match[2] ?? match[3]) === value) matches.push(line);
  }
  if (matches.length > 1) fail('duplicate recipe-switch items');
  return {present: matches.length === 1, createdDepth: 0, text, lines, plugin, enabled, end, listEnd, indent, itemIndent, items, item: matches[0]};
}

// Hermes's explicit disable list wins over enabled. Read it without changing
// it; simple flow lists are fine here because this key is never rewritten.
export function pluginDisabled(state, value = 'recipe-switch') {
  if (!state.plugin) return false;
  const direct = state.lines.filter(line => significant(line) && line.start > state.plugin.start && line.start < state.end && line.indent === state.indent);
  const keys = direct.filter(line => /^\s+disabled\s*:/.test(line.body));
  if (keys.length > 1) fail('duplicate disabled keys');
  const key = keys[0];
  if (!key) return false;
  const raw = key.body.replace(/^\s+disabled\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
  const end = direct.find(line => line.start > key.start)?.start ?? state.end;
  const scalars = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).split(',').filter(item => item.trim())
    : !raw || raw.startsWith('#') ? state.lines.filter(line => significant(line) && line.start > key.start && line.start < end).map(line => line.body.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, ''))
      : fail('disabled uses an alias or unsupported value; resolve it before installing');
  return scalars.some(item => {
    const match = /^(?:([A-Za-z0-9_.\/-]+)|"([A-Za-z0-9_.\/-]+)"|'([A-Za-z0-9_.\/-]+)')$/.exec(item.trim());
    if (!match) fail('disabled contains a complex item; resolve it before installing');
    return (match[1] ?? match[2] ?? match[3]) === value;
  });
}

export function editYamlList(text, value, present, createdDepth = 0) {
  const state = inspectYamlList(text, value);
  if (state.present === present) return text;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  if (present) {
    const at = state.enabled ? (state.items.at(-1)?.end ?? state.enabled.end) : state.plugin ? state.plugin.end : text.length;
    const separator = at > (text.startsWith('\uFEFF') ? 1 : 0) && !/[\r\n]$/.test(text.slice(0, at)) ? nl : '';
    const indent = state.indent ?? 2;
    const block = !state.plugin ? `plugins: # managed by recipe-switch${nl}  enabled: # managed by recipe-switch${nl}    - ${value} # managed by recipe-switch${nl}`
      : !state.enabled ? `${' '.repeat(indent)}enabled: # managed by recipe-switch${nl}${' '.repeat(indent + 2)}- ${value} # managed by recipe-switch${nl}`
        : `${' '.repeat(state.itemIndent)}- ${value} # managed by recipe-switch${nl}`;
    return text.slice(0, at) + separator + block + text.slice(at);
  }
  let result = text.slice(0, state.item.start) + text.slice(state.item.end);
  if (createdDepth >= 1) {
    const next = inspectYamlList(result, value);
    if (next.enabled && !next.items.length) result = result.slice(0, next.enabled.start) + result.slice(next.enabled.end);
  }
  if (createdDepth >= 2) {
    const next = inspectYamlList(result, value);
    const children = next.lines.filter(line => significant(line) && line.start > next.plugin.start && line.start < next.end);
    if (!children.length) result = result.slice(0, next.plugin.start) + result.slice(next.plugin.end);
  }
  return result;
}
