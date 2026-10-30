// Local web UI server. Listens on 127.0.0.1 only; every API call needs the
// per-process token (sent by the page) and a same-origin Host/Origin, which
// blocks other sites and DNS-rebinding pages from driving the loader.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Service} from './service.mjs';

const UI = fileURLToPath(new URL('../ui/', import.meta.url));
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};

function driftView(drift = []) {
  return drift.map(({path: file, unit, live}) => ({path: file, unit, state: live === 'absent' ? 'missing' : 'edited'}));
}
function strip(planned) {
  const {units, drift, manifestVersion, ...rest} = planned;
  return {...rest, drift: driftView(drift)};
}
const optionView = option => ({id: option.id, name: option.name, description: option.description, default: option.default, affects: option.affects ?? []});
function recipeView(recipe) {
  return {key: recipe.key, id: recipe.id, name: recipe.name, version: recipe.version, description: recipe.description,
    kind: recipe.kind, origin: recipe.origin, revision: recipe.revision,
    options: (recipe.options ?? []).map(optionView), optionValues: recipe.optionValues ?? {},
    sizes: Object.fromEntries(Object.entries(recipe.texts).map(([key, text]) => [key, text ? text.length : 0]))};
}
function catalogView({recipes, errors}) {
  return {recipes: recipes.map(recipeView), errors};
}

export function createServer({service = new Service(), token = crypto.randomBytes(24).toString('hex')} = {}) {
  const routes = {
    'GET /api/overview': () => service.overview(),
    'GET /api/recipes': async () => catalogView(await service.catalog()),
    'GET /api/recipe': async (_, query) => {
      const options = query.get('options') ? JSON.parse(query.get('options')) : undefined;
      const recipe = await service.recipe(query.get('key'), options);
      return {...recipeView(recipe), texts: recipe.texts};
    },
    'GET /api/config': () => service.config(),
    'POST /api/config': body => service.saveConfig({...(body.sources ? {sources: body.sources} : {}), ...(body.gwt ? {gwt: body.gwt} : {})}),
    'POST /api/preview': async body => strip(await service.preview(body)),
    'POST /api/preview-undo': async body => strip(await service.previewUndo(body)),
    'GET /api/originals': (_, query) => service.originals({harness: query.get('harness'), home: query.get('home') || undefined}),
    'GET /api/original-file': (_, query) => service.originalText({harness: query.get('harness'), home: query.get('home') || undefined, id: Number(query.get('id'))}),
    'POST /api/preview-original': async body => strip(await service.previewOriginal(body)),
    'POST /api/apply': body => service.apply(body.planId),
  };
  const server = http.createServer(async (req, res) => {
    const send = (code, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, {'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"});
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const {port} = server.address();
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return send(421, {error: 'Unexpected Host header'});
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.map(host => `http://${host}`).includes(origin)) return send(403, {error: 'Cross-origin request refused'});
        if (req.headers['x-recipe-switch-token'] !== token) return send(401, {error: 'Missing or wrong session token; reopen the URL printed by the CLI.'});
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return send(404, {error: 'Not found'});
        let body = {};
        if (req.method === 'POST') {
          if (!String(req.headers['content-type']).startsWith('application/json')) return send(415, {error: 'JSON required'});
          let raw = '';
          for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return send(413, {error: 'Too large'}); }
          body = raw ? JSON.parse(raw) : {};
        }
        return send(200, await handler(body, url.searchParams));
      }
      if (req.method !== 'GET') return send(405, {error: 'Method not allowed'});
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(UI, rel);
      if (!file.startsWith(UI)) return send(404, {error: 'Not found'});
      let bytes;
      try { bytes = await fs.readFile(file); } catch { return send(404, {error: 'Not found'}); }
      if (rel === 'index.html') bytes = Buffer.from(bytes.toString('utf8').replace('__TOKEN__', token));
      return send(200, bytes, TYPES[path.extname(file)] ?? 'application/octet-stream');
    } catch (error) {
      return send(400, {error: error.message});
    }
  });
  return {server, token};
}

export async function serve({service = new Service(), port = 4517, open = true} = {}) {
  const {server} = createServer({service});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`recipe-switch UI: ${url}\nListening on 127.0.0.1 only. Ctrl+C to stop.`);
  if (open) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref();
  }
  return server;
}
