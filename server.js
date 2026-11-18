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
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
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
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

async function api(req, res, url) {
  const { method } = req;
  const p = url.pathname;
  // Writes must be JSON, which forces a CORS preflight for cross-site pages (and none is granted).
  if (method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'JSON required');
  let m;

  if (method === 'GET' && p === '/api/status') {
    const [ai, docker] = await Promise.all([aiStatus(settings.value.ai), depot.docker()]);
    const cats = new Set(manual.index().map((a) => a.category));
    return send(res, 200, {
      ...systemStatus(DATA),
      ai: { online: ai.online, models: ai.models, error: ai.error, provider: settings.value.ai.provider, model: settings.value.ai.model || ai.models[0] || '' },
      docker,
      manual: { articles: manual.articles.length, categories: cats.size },
      server: { port: PORT, lanMode: !LOOPBACK_ONLY, version: '0.1.0' },
      time: new Date().toISOString(),
    });
  }

  if (p === '/api/settings') {
    if (method === 'GET') return send(res, 200, settings.public());
    if (method === 'PUT') return send(res, 200, settings.update(await readBody(req)));
  }

  if (method === 'GET' && p === '/api/manual') return send(res, 200, manual.index());
  if (method === 'GET' && p === '/api/search') return send(res, 200, manual.search(url.searchParams.get('q') || '', 12));
  if (method === 'GET' && (m = p.match(/^\/api\/manual\/([a-z0-9-]{1,200})$/))) {
    const a = manual.get(m[1]);
    if (!a) throw fail(404, 'no such entry');
    return send(res, 200, a);
  }

  if ((m = p.match(/^\/api\/db\/(notes|stores|waypoints)(?:\/([0-9a-f-]{36}))?$/))) {
    const col = collections[m[1]];
    const id = m[2];
    if (method === 'GET' && !id) return send(res, 200, col.all());
    if (method === 'POST' && !id) { const { id: _i, ...body } = await readBody(req); return send(res, 201, col.upsert(body)); }
    if (method === 'PUT' && id) {
      const { id: _i, ...body } = await readBody(req);
      const item = col.upsert(body, id);
      if (!item) throw fail(404, 'not found');
      return send(res, 200, item);
    }
    if (method === 'DELETE' && id) return send(res, 200, { ok: col.remove(id) });
  }

  if (method === 'POST' && p === '/api/hash') {
    const { text = '', algo = 'sha256' } = await readBody(req);
    if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) throw fail(400, 'unsupported algorithm');
    return send(res, 200, { hash: crypto.createHash(algo).update(String(text), 'utf8').digest('hex') });
  }

  if (method === 'POST' && p === '/api/chat') return chat(req, res);

  if (method === 'GET' && p === '/api/depot') return send(res, 200, { ...(await depot.list()), canAdmin: canAdmin(req) });
  if (method === 'POST' && (m = p.match(/^\/api\/depot\/([a-z0-9-]+)\/(start|stop|remove)$/))) {
    if (!canAdmin(req)) throw fail(403, 'depot control is only available from the host machine');
    return send(res, 200, await depot.action(m[1], m[2]));
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
  } catch (e) {
    if (!abort.signal.aborted) emit({ type: 'error', message: e.message });
  }
  res.end();
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
    const url = new URL(req.url, 'http://shelter.local');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
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
