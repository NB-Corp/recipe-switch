#!/usr/bin/env node
/**
 * Zero-dependency local preview for the recipe-switch docs site.
 *
 * This is NOT Jekyll — it emulates only the Liquid subset this site actually
 * uses, so you can eyeball pages before pushing to GitHub Pages:
 *
 *   - front matter (--- yaml ---) on pages
 *   - _config.yml and _data/*.yml (flat maps, one level of nesting, string lists)
 *   - layouts: _layouts/*.html with {{ content }}
 *   - {% assign x = ... %} (string literal, literal | filter chain, or lookup)
 *   - {% if expr %} / {% elsif expr %} / {% else %} / {% endif %}
 *   - {% for item in expr %} / {% endfor %} (with forloop.first/last)
 *   - {{ path.to.value | filter }} with: relative_url, absolute_url, default,
 *     slice:N, upcase, downcase, strip, escape, uri_escape, date_to_string
 *   - {% seo %} is stubbed to a comment (real output only on GitHub Pages)
 *   - Markdown: headings, fenced code blocks, tables, lists, blockquotes,
 *     links, images, bold/italic/inline code, hr, and raw HTML passthrough
 *
 * Usage: node docs/_preview.mjs [port]   (default 127.0.0.1:4000)
 * The site is served at http://127.0.0.1:4000/recipe-switch/
 */
import http from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2] || 4000);

/* ── tiny YAML reader: flat maps + one nested level + scalar lists ── */
function parseYaml(text) {
  // strip trailing whitespace comments outside quotes
  text = text.replace(/\r\n/g, '\n').split('\n').map(l => {
    if (/^\s*#/.test(l)) return l;
    const m = l.match(/^(.*?)(\s+#.*)$/);
    if (!m) return l;
    const before = m[1];
    const quotes = (before.match(/["']/g) || []).length;
    return quotes % 2 === 0 && /:\s*\S/.test(before) ? before : l;
  }).join('\n');
  const root = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stack = [{ indent: -1, obj: root }];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const m = raw.trim();
    if (m.startsWith('- ')) {
      const parent = stack[stack.length - 1].obj;
      if (Array.isArray(parent)) {
        const item = m.slice(2).trim();
        if (/^[\w.-]+:/.test(item)) {
          const k = item.slice(0, item.indexOf(':')).trim();
          const v = item.slice(item.indexOf(':') + 1).trim();
          const o = {}; o[k] = scalar(v);
          parent.push(o);
          stack.push({ indent, obj: o });
        } else {
          parent.push(scalar(item));
        }
      }
      continue;
    }
    const km = m.match(/^([\w.''" -]+):\s*(.*)$/);
    if (!km) continue;
    const key = km[1].replace(/^["']|["']$/g, '').trim();
    let val = km[2];
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === '' || val === '>-' || val === '>' || val === '|') {
      // lookahead: folded scalar or nested block?
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      const next = lines[j] || '';
      const nextIndent = (next.match(/^ */) || [''])[0].length;
      if (val !== '' || nextIndent <= indent) {
        if (val !== '') { // folded scalar
          const parts = [];
          while (i + 1 < lines.length && (lines[i + 1].match(/^ */)[0].length > indent) && lines[i + 1].trim()) {
            parts.push(lines[++i].trim());
          }
          parent[key] = parts.join(' ');
          continue;
        }
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
        continue;
      }
      if (next.trim().startsWith('- ')) {
        parent[key] = [];
        stack.push({ indent, obj: parent[key] });
      } else {
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
      }
    } else {
      parent[key] = scalar(val);
    }
  }
  return root;
}
function scalar(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function lookup(ctx, path) {
  // dot-path with support for ['quoted-key'] and [variable] segments
  const parts = [];
  let buf = '';
  for (let k = 0; k < path.length; k++) {
    const c = path[k];
    if (c === '.') { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf) parts.push(buf);
  let cur = ctx;
  for (let p of parts) {
    if (cur == null) return undefined;
    if (p === 'size' && (typeof cur === 'string' || Array.isArray(cur))) return cur.length;
    const m = p.match(/^([^\[]*)\[([^\]]+)\]$/);
    if (m) {
      if (m[1]) cur = cur[m[1]];
      const key = /^["']/.test(m[2]) ? m[2].slice(1, -1) : lookup(ctx, m[2]);
      cur = cur == null ? undefined : cur[key];
      continue;
    }
    cur = cur[p];
  }
  return cur;
}

/* ── Liquid subset renderer ── */
function renderLiquid(tpl, ctx) {
  let out = '';
  let i = 0;
  const n = tpl.length;
  function evalExpr(expr) {
    expr = expr.trim();
    const pipeParts = expr.split('|').map(s => s.trim());
    let value = evalTerm(pipeParts[0]);
    for (const f of pipeParts.slice(1)) {
      const [fname, ...argRest] = f.split(':');
      // filter args may contain commas ("slice: 0, 2"); keep everything after the first colon
      const arg = argRest.join(':');
      value = applyFilter(fname.trim(), value, arg);
    }
    return value;
  }
  function evalTerm(term) {
    term = term.trim();
    if ((term.startsWith('"') && term.endsWith('"')) || (term.startsWith("'") && term.endsWith("'"))) {
      return term.slice(1, -1);
    }
    if (term === 'true') return true;
    if (term === 'false') return false;
    if (term === 'nil' || term === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(term)) return Number(term);
    return lookup(ctx, term);
  }
  function applyFilter(name, value, arg) {
    const site = ctx.site;
    switch (name) {
      case 'relative_url': {
        const v = String(value ?? '');
        if (/^https?:/i.test(v)) return v;
        const base = site.baseurl || '';
        return (base + (v.startsWith('/') ? v : '/' + v)).replace(/\/+/g, '/');
      }
      case 'absolute_url': {
        const v = applyFilter('relative_url', value, arg);
        if (/^https?:/i.test(String(value))) return value;
        return (site.url || '') + v;
      }
      case 'default': {
        const fallback = /^["']/.test(arg) ? arg.slice(1, -1) : evalTerm(arg);
        return (value === undefined || value === null || value === '' || value === false) ? fallback : value;
      }
      case 'upcase': return String(value ?? '').toUpperCase();
      case 'downcase': return String(value ?? '').toLowerCase();
      case 'strip': return String(value ?? '').trim();
      case 'escape': return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      case 'uri_escape': return encodeURIComponent(String(value ?? ''));
      case 'slice': {
        const parts = arg.split(',');
        const offset = Number(evalTerm(parts[0].trim())) || 0;
        const len = parts.length > 1 && parts[1].trim() !== '' ? Number(parts[1].trim()) : undefined;
        return String(value ?? '').substr(offset, len);
      }
      case 'date_to_string': return String(value ?? '');
      case 'append': return String(value ?? '') + evalTerm(arg);
      case 'prepend': return evalTerm(arg) + String(value ?? '');
      case 'remove': return String(value ?? '').split(evalTerm(arg)).join('');
      case 'replace': { const [a, b] = arg.split(',').map(s => s.trim()); return String(value ?? '').split(evalTerm(a)).join(evalTerm(b)); }
      default: return value;
    }
  }
  function truthy(v) { return v !== undefined && v !== null && v !== false && v !== '' && !(Array.isArray(v) && v.length === 0); }

  function parseCondition(expr) {
    // supports: A == B, A != B, bare truthy A
    let m = expr.match(/^(.*?)\s*(==|!=)\s*(.*)$/);
    if (m) {
      const a = evalTerm(m[1]); const b = evalTerm(m[3]);
      return m[2] === '==' ? a === b : a !== b;
    }
    return truthy(evalTerm(expr));
  }

  function readTag() {
    const end = tpl.indexOf('%}', i);
    const tag = tpl.slice(i + 2, end).trim().replace(/-$/, '').trim();
    i = end + 2;
    return tag;
  }
  function readVar() {
    const end = tpl.indexOf('}}', i);
    const v = tpl.slice(i + 2, end).trim().replace(/-$/, '').trim();
    i = end + 2;
    return v;
  }

  function renderBlock(stopAt) {
    // stopAt: array of tag-name prefixes that end this block
    while (i < n) {
      if (tpl.startsWith('{{', i)) {
        const expr = readVar();
        const v = evalExpr(expr);
        if (v !== undefined && v !== null) out += String(v);
        continue;
      }
      if (tpl.startsWith('{%', i)) {
        const tag = readTag();
        const [name, ...rest] = tag.split(/\s+/);
        const argStr = rest.join(' ');
        if (stopAt.includes(name)) return name + ' ' + argStr;
        if (name === 'assign') {
          const m = argStr.match(/^([\w-]+)\s*=\s*(.*)$/);
          if (m) ctx[m[1]] = evalExpr(m[2]);
          continue;
        }
        if (name === 'comment') {
          // skip until endcomment
          while (i < n) {
            if (tpl.startsWith('{%', i)) { const t = readTag(); if (t.startsWith('endcomment')) break; continue; }
            if (tpl.startsWith('{{', i)) { readVar(); continue; }
            i++;
          }
          continue;
        }
        if (name === 'seo') { out += '<!-- seo tags (jekyll-seo-tag output appears on GitHub Pages) -->'; continue; }
        if (name === 'if' || name === 'elsif') {
          // Split the whole if-chain into segments [cond|null, bodyStart, bodyEnd]
          // by scanning raw template text; then render only the matching body.
          const segments = [[argStr, i]];
          let depth = 0, scan = i, afterEndif = -1;
          while (scan < n) {
            const nx = tpl.indexOf('{%', scan);
            if (nx < 0) break;
            const e2 = tpl.indexOf('%}', nx);
            if (e2 < 0) break;
            const t2 = tpl.slice(nx + 2, e2).trim();
            const t2name = t2.split(/\s+/)[0];
            if (t2name === 'if') depth++;
            if (t2name === 'endif') {
              if (depth === 0) { afterEndif = e2 + 2; break; }
              depth--;
            }
            if (depth === 0 && (t2name === 'elsif' || t2name === 'else')) {
              segments[segments.length - 1].push(nx); // body end
              segments.push([t2name === 'else' ? null : t2.slice(6).trim(), e2 + 2]);
            }
            scan = e2 + 2;
          }
          // body of the last segment ends at the endif tag
          let endifStart = n;
          if (afterEndif >= 0) {
            endifStart = tpl.lastIndexOf('{%', afterEndif);
            if (endifStart < 0) endifStart = n;
          }
          segments[segments.length - 1].push(endifStart);
          // render the first matching segment
          let picked = null;
          for (const [cond, bodyStart, bodyEnd] of segments) {
            if (cond === null || parseCondition(cond)) { picked = [cond, bodyStart, bodyEnd]; break; }
          }
          if (picked) {
            const bodyTpl = tpl.slice(picked[1], picked[2]);
            out += renderLiquid(bodyTpl, ctx);
          }
          i = afterEndif >= 0 ? afterEndif : n;
          continue;
        }
        if (name === 'for') {
          const m = argStr.match(/^([\w-]+)\s+in\s+(.*)$/);
          if (!m) continue;
          const arr = evalExpr(m[2]);
          const items = Array.isArray(arr) ? arr : (arr && typeof arr === 'object' ? Object.entries(arr).map(([k, v]) => ({ ...v, name: k })) : []);
          const start = i;
          // locate the matching endfor first (single pass, no nesting needed for this site)
          let depth = 0, endPos = -1, scan = i;
          while (scan < n) {
            const nx = tpl.indexOf('{%', scan);
            if (nx < 0) break;
            const e2 = tpl.indexOf('%}', nx);
            const t2 = tpl.slice(nx + 2, e2).trim();
            if (t2.startsWith('for ')) depth++;
            if (t2.startsWith('endfor')) { if (depth === 0) { endPos = e2 + 2; break; } depth--; }
            scan = e2 + 2;
          }
          for (let k = 0; k < items.length; k++) {
            ctx[m[1]] = items[k];
            ctx.forloop = { first: k === 0, last: k === items.length - 1, index: k + 1, index0: k };
            i = start;
            renderBlock(['endfor']);
          }
          i = endPos > 0 ? endPos : i;
          delete ctx[m[1]]; delete ctx.forloop;
          continue;
        }
        // unknown tags are dropped silently in preview
        continue;
      }
      out += tpl[i++];
    }
    return null;
  }
  renderBlock([]);
  return out;
}

/* ── tiny Markdown renderer (commonmark subset used by this site) ── */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, a, u) => `<img src="${u}" alt="${a}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  s = s.replace(/  $/gm, '');
  return s;
}
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ').trim()) + '</p>'); para = []; }
  };
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // raw HTML block (pass through) — `i` only at end (avoids matching <install> etc.)
    if (/^\s*<\/?(div|section|details|summary|figure|figcaption|table|tr|td|th|script|style|span|a|p|ul|ol|li|h[1-6]|pre|code|blockquote|img|br|hr|em|b|strong|svg|path|rect|circle|nav|header|footer|main|button)\b/i.test(line)) {
      flushPara();
      out.push(line);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    if (/^---+\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      const text = h[2].trim();
      const id = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, '-');
        out.push(`<h${lvl} id="${id}">${inline(text)}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      let body = rows.slice(1).filter(r => !/^\s*\|?\s*:?-{2,}/.test(r.replace(/\|/g, '').trim()) && !cells(r).every(c => /^:?-{2,}:?$/.test(c)));
      let html = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of body) html += '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
      html += '</tbody></table>';
      out.push(html);
      continue;
    }
    const olm = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    const ulm = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (olm || ulm) {
      flushPara();
      const ordered = !!olm;
      const baseIndent = (olm || ulm)[1].length;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const mo = l.match(/^(\s*)(\d+)\.\s+(.*)$/);
        const mu = l.match(/^(\s*)[-*]\s+(.*)$/);
        const mm = ordered ? mo : (mu || (l.match(/^(\s*)(\d+)\.\s+(.*)$/) && ordered ? mo : null));
        const any = mo || mu;
        if (any && any[1].length === baseIndent && ((ordered && mo) || (!ordered && mu))) {
          items.push(any[any.length - 1]);
          i++;
        } else if (any && any[1].length > baseIndent) {
          // nested list: treat as part of current item (rare on this site)
          items[items.length - 1] += '\n' + any[any.length - 1];
          i++;
        } else if (/^\s+\S/.test(l) && items.length) {
          items[items.length - 1] += ' ' + l.trim();
          i++;
        } else if (/^\s*$/.test(l)) {
          break;
        } else break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map(t => `<li>${inline(t)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

/* ── site assembly ── */
function splitFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return [{}, text];
  return [parseYaml(m[1]), text.slice(m[0].length)];
}

const config = parseYaml(readFileSync(join(ROOT, '_config.yml'), 'utf8'));
const data = {};
const dataDir = join(ROOT, '_data');
if (existsSync(dataDir)) {
  for (const f of readdirSync(dataDir)) {
    if (f.endsWith('.yml') || f.endsWith('.yaml')) data[f.replace(/\.ya?ml$/, '')] = parseYaml(readFileSync(join(dataDir, f), 'utf8'));
  }
}
const layouts = {};
const layoutDir = join(ROOT, '_layouts');
for (const f of readdirSync(layoutDir)) layouts[f.replace(/\.html$/, '')] = readFileSync(join(layoutDir, f), 'utf8');

function langFor(relPath, page) {
  if (page.lang) return page.lang;
  return relPath.startsWith('zh/') ? 'zh-CN' : 'en-US';
}

const pageCache = new Map();
function buildPage(relPath) {
  const abs = join(ROOT, relPath);
  const raw = readFileSync(abs, 'utf8');
  let [fm, body] = splitFrontMatter(raw);
  const page = { ...fm };
  page.lang = langFor(relPath, fm);
  // per-language values (mirrors _config.yml defaults)
  const pl = page.lang.slice(0, 2);
  const site = { ...config, lang: page.lang, data, pages: [] };
  const ctx = { site, page };
  ctx.page = page;
  // page content: liquid then markdown
  let content = renderLiquid(body, ctx);
  content = renderMarkdown(content);
  ctx.content = content;
  // layout chain: a layout may itself declare layout: default (doc.html does).
  // Strip each layout's own front matter first so it never leaks into output.
  let layoutName = fm.layout || 'default';
  let guard = 0;
  let inner = content;
  while (layoutName && layouts[layoutName] && guard++ < 5) {
    const [lfm, lbody] = splitFrontMatter(layouts[layoutName]);
    ctx.content = inner;
    inner = renderLiquid(lbody, ctx);
    layoutName = lfm.layout || null;
  }
  return inner;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const base = (config.baseurl || '').replace(/\/$/, '');
  let rel = urlPath;
  if (base && rel.startsWith(base)) rel = rel.slice(base.length) || '/';
  rel = rel.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  let fileRel = rel;
  // extensionless page URLs: /harnesses(.html)? → harnesses.md; /zh/ → zh/index.md
  const candidates = [];
  if (fileRel.endsWith('/')) fileRel += 'index.html';
  if (fileRel.endsWith('.html')) {
    candidates.push(fileRel.replace(/\.html$/, '.md'));
    candidates.push(fileRel);
  } else if (!extname(fileRel)) {
    candidates.push(fileRel + '.md');
    candidates.push(fileRel + '/index.md');
    candidates.push(fileRel + '.html');
  } else {
    candidates.push(fileRel);
  }
  for (const cand of candidates) {
    const abs = join(ROOT, cand);
    if (existsSync(abs) && statSync(abs).isFile()) {
      if (cand.endsWith('.md')) {
        let html = pageCache.get(cand);
        if (!html) { html = buildPage(cand); pageCache.set(cand, html); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      const ext = extname(cand).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(abs));
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404: ' + urlPath + '\n(tried: ' + candidates.join(', ') + ')');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`recipe-switch docs preview (Jekyll-subset, NOT a real build)`);
  console.log(`  EN: http://127.0.0.1:${PORT}${config.baseurl || ''}/`);
  console.log(`  ZH: http://127.0.0.1:${PORT}${config.baseurl || ''}/zh/`);
});
