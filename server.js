#!/usr/bin/env node
// SHELTER — offline-first survival knowledge node. Zero dependencies: `node server.js`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Manual } from './server/manual.js';
import { Collection, Settings } from './server/store.js';
import { systemStatus } from './server/system.js';
import { aiStatus, streamChat, buildPrompt } from './server/ai.js';
import { Depot } from './server/depot.js';
import { Maps, MAX_TILES, decompress } from './server/maps.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.SHELTER_DATA || path.join(ROOT, 'data'));
const LAN = process.argv.includes('--lan');
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : '127.0.0.1');
const PORT = +process.env.PORT || 4077;
const isLoopbackHost = (h) => ['127.0.0.1', 'localhost', '::1'].includes(h);
// SHELTER_BIND is the address clients actually reach Shelter on. In a bridged container the server
// listens on 0.0.0.0 while Docker publishes the port on SHELTER_BIND (127.0.0.1 unless LAN mode).
const PUBLISHED = process.env.SHELTER_BIND || HOST;
const LOOPBACK_ONLY = isLoopbackHost(PUBLISHED);
const REMOTE_ADMIN = process.env.SHELTER_REMOTE_ADMIN === '1';
// Behind a port published only on the host's loopback, every client is on the host,
// but requests arrive from the Docker gateway address rather than 127.0.0.1.
const BEHIND_LOCAL_PUBLISH = LOOPBACK_ONLY && !isLoopbackHost(HOST);

fs.mkdirSync(DATA, { recursive: true });
const manual = new Manual(path.join(ROOT, 'content', 'manual'));
const settings = new Settings(path.join(DATA, 'settings.json'));
const collections = Object.fromEntries(['notes', 'stores', 'waypoints'].map((n) => [n, new Collection(path.join(DATA, `${n}.json`))]));
const maps = new Maps(path.join(DATA, 'maps'));
const depot = new Depot(path.join(ROOT, 'config', 'depot.json'), DATA, LOOPBACK_ONLY ? '127.0.0.1' : '0.0.0.0', {
  // When Shelter runs in a container, Docker resolves bind mounts on the host, so it needs host paths.
  hostDataDir: process.env.SHELTER_HOST_DATA || '',
  bindRoot: process.env.SHELTER_DEPOT_HOST_DIR || '',
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const fail = (status, message) => Object.assign(new Error(message), { status });
// IPv4 clients of a dual-stack socket show up as IPv4-mapped IPv6 addresses ("::ffff:a.b.c.d").
const MAPPED_V4 = '::ffff:';
const isLoopback = (req) => {
  const addr = req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1'].includes(addr.startsWith(MAPPED_V4) ? addr.slice(MAPPED_V4.length) : addr);
};
const canAdmin = (req) => isLoopback(req) || REMOTE_ADMIN || BEHIND_LOCAL_PUBLISH;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(fail(413, 'payload too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(fail(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// In loopback mode, reject requests addressed to any other hostname (DNS-rebinding guard).
function hostAllowed(req) {
  if (!LOOPBACK_ONLY) return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '').replaceAll(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

/** Request body without an "id": records get their id from the URL or the store, never from the client. */
async function bodyWithoutId(req) {
  const body = await readBody(req);
  delete body.id;
  return body;
}

function requireAdmin(req, message) {
  if (!canAdmin(req)) throw fail(403, message);
}
const MAP_ADMIN = 'map downloads are only available from the host machine';

async function status(req, res) {
  const [ai, docker] = await Promise.all([aiStatus(settings.value.ai), depot.docker()]);
  const cats = new Set(manual.index().map((a) => a.category));
  send(res, 200, {
    ...systemStatus(DATA),
    ai: { online: ai.online, models: ai.models, error: ai.error, provider: settings.value.ai.provider, model: settings.value.ai.model || ai.models[0] || '' },
    docker,
    manual: { articles: manual.articles.length, categories: cats.size },
    server: { port: PORT, lanMode: !LOOPBACK_ONLY, version: '0.1.0' },
    time: new Date().toISOString(),
  });
}

async function hash(req, res) {
  const { text = '', algo = 'sha256' } = await readBody(req);
  if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) throw fail(400, 'unsupported algorithm');
  send(res, 200, { hash: crypto.createHash(algo).update(String(text), 'utf8').digest('hex') });
}

const DB = '^/api/db/(notes|stores|waypoints)';
const DB_ITEM = new RegExp(`${DB}/([0-9a-f-]{36})$`);

/**
 * [method, path, handler]. path is a string for an exact match or a RegExp whose groups are passed
 * to the handler after { req, res, url }. The first route matching both method and path wins.
 */
const ROUTES = [
  ['GET', '/api/status', ({ req, res }) => status(req, res)],
  ['GET', '/api/settings', ({ res }) => send(res, 200, settings.public())],
  ['PUT', '/api/settings', async ({ req, res }) => send(res, 200, settings.update(await readBody(req)))],

  ['GET', '/api/manual', ({ res }) => send(res, 200, manual.index())],
  ['GET', '/api/search', ({ res, url }) => send(res, 200, manual.search(url.searchParams.get('q') || '', 12))],
  ['GET', /^\/api\/manual\/([a-z0-9-]{1,200})$/, ({ res }, id) => {
    const a = manual.get(id);
    if (!a) throw fail(404, 'no such entry');
    send(res, 200, a);
  }],

  ['GET', new RegExp(`${DB}$`), ({ res }, name) => send(res, 200, collections[name].all())],
  ['POST', new RegExp(`${DB}$`), async ({ req, res }, name) => send(res, 201, collections[name].upsert(await bodyWithoutId(req)))],
  ['PUT', DB_ITEM, async ({ req, res }, name, id) => {
    const item = collections[name].upsert(await bodyWithoutId(req), id);
    if (!item) throw fail(404, 'not found');
    send(res, 200, item);
  }],
  ['DELETE', DB_ITEM, ({ res }, name, id) => send(res, 200, { ok: collections[name].remove(id) })],

  ['POST', '/api/hash', ({ req, res }) => hash(req, res)],
  ['POST', '/api/chat', ({ req, res }) => chat(req, res)],

  ['GET', /^\/api\/maps\/tile\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/, ({ req, res }, z, x, y) => mapTile(req, res, +z, +x, +y)],
  ['GET', '/api/maps', async ({ req, res }) => send(res, 200, { archives: await maps.scan(), job: maps.status(), canAdmin: canAdmin(req), maxTiles: MAX_TILES })],
  ['POST', '/api/maps/download', async ({ req, res }) => {
    requireAdmin(req, MAP_ADMIN);
    send(res, 202, maps.download(await readBody(req)));
  }],
  ['POST', '/api/maps/cancel', ({ req, res }) => {
    requireAdmin(req, MAP_ADMIN);
    maps.cancel();
    send(res, 200, { ok: true });
  }],
  ['DELETE', /^\/api\/maps\/([A-Za-z0-9][A-Za-z0-9._-]*\.pmtiles)$/, async ({ req, res }, file) => {
    requireAdmin(req, 'map files can only be removed from the host machine');
    await maps.remove(file);
    send(res, 200, { ok: true });
  }],

  ['GET', '/api/depot', async ({ req, res }) => send(res, 200, { ...(await depot.list()), canAdmin: canAdmin(req) })],
  ['POST', /^\/api\/depot\/([a-z0-9-]+)\/(start|stop|remove)$/, async ({ req, res }, id, action) => {
    requireAdmin(req, 'depot control is only available from the host machine');
    send(res, 200, await depot.action(id, action));
  }],
];

/** Path parameters when the route matches this request, else null. */
function matchRoute([method, path], req, pathname) {
  if (method !== req.method) return null;
  if (typeof path === 'string') return path === pathname ? [] : null;
  return path.exec(pathname)?.slice(1) ?? null;
}

function api(req, res, url) {
  // Writes must be JSON, which forces a CORS preflight for cross-site pages (and none is granted).
  if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'JSON required');
  for (const route of ROUTES) {
    const params = matchRoute(route, req, url.pathname);
    if (params) return route[2]({ req, res, url }, ...params);
  }
  throw fail(404, 'no such endpoint');
}

async function chat(req, res) {
  const body = await readBody(req);
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((x) => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string' && x.content.trim())
    .slice(-12)
    .map((x) => ({ role: x.role, content: x.content.slice(0, 8000) }));
  const question = [...history].reverse().find((x) => x.role === 'user');
  if (!question) throw fail(400, 'no question');

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  // Ground the answer in the best-matching passages; cite each article once.
  const passages = manual.passages(question.content, 4);
  const cited = [...new Map(passages.map((x) => [x.article.id, x.article])).values()];
  emit({ type: 'sources', items: cited.map(({ id, title, category, summary }) => ({ id, title, category, summary })) });

  const ai = settings.value.ai;
  const status = await aiStatus(ai);
  const model = ai.model || status.models[0];
  if (!status.online || !model) {
    emit({ type: 'offline', reason: status.online ? 'no model installed on the model server' : 'model server unreachable' });
    return res.end();
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const system = buildPrompt(passages);
    await streamChat(ai, model, [{ role: 'system', content: system }, ...history], (text) => emit({ type: 'delta', text }), abort.signal);
    emit({ type: 'done', model });
  } catch (error) {
    if (!abort.signal.aborted) emit({ type: 'error', message: error.message });
  }
  res.end();
}

// Vector tile bytes. Gzip tiles pass through with Content-Encoding; others are inflated here.
async function mapTile(req, res, z, x, y) {
  if (z > 15 || x >= 2 ** z || y >= 2 ** z) throw fail(400, 'bad tile');
  const t = await maps.tile(z, x, y);
  if (!t) { res.writeHead(204, { 'cache-control': 'no-store', ...SECURITY }); return res.end(); }
  const headers = { 'content-type': 'application/vnd.mapbox-vector-tile', 'cache-control': 'no-cache', ...SECURITY };
  let body = t.data;
  if (t.compression === 2 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) headers['content-encoding'] = 'gzip';
  else body = decompress(t.data, t.compression);
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(body);
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size, 'cache-control': 'no-cache', ...SECURITY,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'method not allowed');
  // Figures stored beside manual content: /content/<folder>/img/<file>
  const fig = url.pathname.match(/^\/content\/([a-z0-9][a-z0-9-]*)\/img\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp))$/);
  if (fig) {
    const dir = manual.imageDir(fig[1]);
    if (!dir) throw fail(404, 'not found');
    return sendFile(req, res, path.join(dir, fig[2]));
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw fail(400, 'bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) throw fail(403, 'forbidden');
  sendFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) throw fail(403, 'host not allowed');
    const url = new URL(req.url, 'http://localhost'); // base only for parsing the path and query
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) return res.end();
    if (!error.status) console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : 'internal error' });
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Set PORT=<n> to choose another.` : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  SHELTER // field node online`);
  // In a bridged container PORT is the internal one; SHELTER_PORT is what the host publishes.
  const shown = process.env.SHELTER_PORT || PORT;
  console.log(`  local   http://localhost:${shown}`);
  if (!LOOPBACK_ONLY) for (const ip of systemStatus(DATA).system.lan) console.log(`  lan     http://${ip}:${shown}`);
  else console.log(`  lan     disabled (start with --lan to serve other devices)`);
  console.log(`  manual  ${manual.articles.length} entries   data  ${DATA}\n`);
});
