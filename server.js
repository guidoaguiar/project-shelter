#!/usr/bin/env node
// SHELTER — offline-first survival knowledge node. Zero dependencies: `node server.js`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Manual } from './server/manual.js';
import { Collection, Settings, Doc } from './server/store.js';
import { systemStatus, setLowPower } from './server/system.js';
import { PowerMonitor } from './server/power.js';
import { aiStatus, streamChat, buildPrompt, householdPrompt, isLocalModelUrl, pullModel } from './server/ai.js';
import { EmbeddingIndex, pickEmbedModel, retrieve, isEmbedModel } from './server/retrieval.js';
import { modelName, registrySize, estimateSize, modelFit } from './server/models.js';
import { Attachments, MAX_BYTES as ATTACHMENT_MAX } from './server/attachments.js';
import { Depot } from './server/depot.js';
import { Content } from './server/content.js';
import { Maps, MAX_TILES, decompress } from './server/maps.js';
import { Sessions, Limiter, verifyPin, sessionToken, sessionCookie } from './server/access.js';
import { loadKitTemplates } from './server/kits.js';
import { buildBackup, restoreBackup, checkBackup, Snapshots } from './server/backup.js';
import { httpsRequested, loadCert, certHosts, machineName, dualServer } from './server/https.js';
import { shellManifest } from './server/offline.js';

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

const COLLECTIONS = ['notes', 'stores', 'waypoints', 'people', 'contacts', 'kits', 'routes'];
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

fs.mkdirSync(DATA, { recursive: true });
// A data folder with no settings or records is a new install; that decides the default LAN write policy.
const fresh = !['settings.json', 'plan.json', ...COLLECTIONS.map((n) => `${n}.json`)].some((f) => fs.existsSync(path.join(DATA, f)));
const manual = new Manual(path.join(ROOT, 'content', 'manual'));
const settings = new Settings(path.join(DATA, 'settings.json'), { fresh });
const collections = Object.fromEntries(COLLECTIONS.map((n) => [n, new Collection(path.join(DATA, `${n}.json`), { schema: n })]));
const plan = new Doc(path.join(DATA, 'plan.json'), 'plan');
const checkin = new Doc(path.join(DATA, 'checkin.json'), 'checkin');
const power = new PowerMonitor({ enabled: process.env.SHELTER_POWER_CHECK !== 'off', nut: process.env.SHELTER_NUT || '' });
const lowPower = () => !!settings.value.power?.lowPower;
/** Low-power mode slows the host samplers and the power reader; the advisor is turned off. */
function applyPowerMode() {
  setLowPower(lowPower());
  power.start(lowPower());
}
const attachments = new Attachments(path.join(DATA, 'attachments'));
const embeddings = new EmbeddingIndex(path.join(DATA, 'cache'));
const kitTemplates = loadKitTemplates(path.join(ROOT, 'config'));
const snapshots = new Snapshots(path.join(DATA, 'backups'));
const sessions = new Sessions();
const pinAttempts = new Limiter();
const maps = new Maps(path.join(DATA, 'maps'));
const depot = new Depot(path.join(ROOT, 'config', 'depot.json'), DATA, LOOPBACK_ONLY ? '127.0.0.1' : '0.0.0.0', {
  // When Shelter runs in a container, Docker resolves bind mounts on the host, so it needs host paths.
  hostDataDir: process.env.SHELTER_HOST_DATA || '',
  bindRoot: process.env.SHELTER_DEPOT_HOST_DIR || '',
});
// Depot content downloads (config/content.json). Ollama models go to the configured Ollama server.
const content = new Content(path.join(ROOT, 'config', 'content.json'), depot, {
  ollamaUrl: () => (settings.value.ai.provider === 'ollama' ? settings.value.ai.baseUrl : 'http://127.0.0.1:11434'),
});
const CONTENT_ADMIN = 'content can only be downloaded or deleted from the host machine';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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

/**
 * What this client may do. host: everything (canAdmin). member: read and change household data.
 * guest: the manual, map tiles, tools and advisor only. See docs/MUST-HAVE-SPEC.md, section 1.
 */
function role(req) {
  if (canAdmin(req)) return 'host';
  const { lanWrites, pinHash } = settings.value.access;
  if (lanWrites === 'open') return 'member';
  if (lanWrites === 'pin' && pinHash && sessions.valid(sessionToken(req))) return 'member';
  return 'guest';
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(fail(413, 'payload too large')); req.destroy(); } else chunks.push(c);
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
function requireMember(req) {
  if (role(req) === 'guest') throw fail(403, 'enter the PIN on Command to see and change household data');
}
/** The client address used to count wrong PIN attempts. */
const clientKey = (req) => (req.socket.remoteAddress || '').replace(MAPPED_V4, '');

async function startSession(req, res) {
  const { pin } = await readBody(req);
  const key = clientKey(req);
  if (pinAttempts.blocked(key)) throw fail(429, 'too many wrong PINs: wait 10 minutes');
  const { lanWrites, pinHash } = settings.value.access;
  if (lanWrites !== 'pin' || !pinHash) throw fail(400, 'no PIN is set on this node');
  if (!verifyPin(String(pin ?? ''), pinHash)) { pinAttempts.fail(key); throw fail(403, 'wrong PIN'); }
  pinAttempts.reset(key);
  send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(sessions.create()) });
}

const BACKUP_ADMIN = 'backups are only available on the host machine';

/** After a record is deleted, clears links to it: waypoints from the plan, stores items from kits and medications. */
function dropReferences(name, id) {
  if (name === 'waypoints') {
    const p = plan.get();
    const meeting = Object.fromEntries(Object.entries(p.meeting).map(([k, m]) => [k, m.waypointId === id ? { ...m, waypointId: null } : m]));
    const routes = p.routes.map((r) => ({ ...r, waypointIds: r.waypointIds.filter((w) => w !== id) }));
    if (JSON.stringify({ meeting, routes }) !== JSON.stringify({ meeting: p.meeting, routes: p.routes })) plan.update({ meeting, routes });
    collections.routes.rewrite((r) => (r.waypointIds?.includes(id) ? { ...r, waypointIds: r.waypointIds.filter((w) => w !== id) } : r));
  }
  if (name === 'stores') {
    const unlink = (list) => list.map((x) => (x.storeId === id ? { ...x, storeId: null } : x));
    collections.kits.rewrite((k) => (k.items.some((x) => x.storeId === id) ? { ...k, items: unlink(k.items) } : k));
    collections.people.rewrite((p) => (p.medications?.some((x) => x.storeId === id) ? { ...p, medications: unlink(p.medications) } : p));
  }
}

/** Deletes the image files a Log entry had before a change, unless an entry still uses them. */
function dropAttachments(before) {
  const files = (before?.attachments || []).map((a) => a.file);
  if (files.length) attachments.removeUnreferenced(files, collections.notes.all());
}

/** Stores an uploaded Log image: { name, data (base64) }. The entry links it with a PUT afterwards. */
async function uploadAttachment(req, res) {
  requireMember(req);
  const { name, data } = await readBody(req, Math.ceil(ATTACHMENT_MAX / 3) * 4 + 64 * 1024);
  send(res, 201, attachments.save(name, data));
}

function serveAttachment(req, res, name) {
  requireMember(req);
  const file = attachments.file(name);
  if (!file) throw fail(404, 'no such attachment');
  // nosniff comes with SECURITY; the type is set from the server-chosen extension, never from the upload.
  sendFile(req, res, file, { 'cache-control': 'private, no-cache', 'content-disposition': 'inline' });
}

async function currentBackup() {
  const archives = await maps.scan().catch(() => []);
  return buildBackup({ settings, collections, plan, maps: archives, appVersion: VERSION, attachments });
}

async function downloadBackup(req, res) {
  requireAdmin(req, BACKUP_ADMIN);
  const backup = await currentBackup();
  settings.markBackup();
  const day = backup.created.slice(0, 16).replaceAll(/[-:]/g, '').replace('T', '-');
  const name = `shelter-${backup.node.callsign.toLowerCase().replaceAll(/[^a-z0-9-]/g, '')}-${day}.json`;
  send(res, 200, backup, { 'content-disposition': `attachment; filename="${name}"` });
}

/** Restores a backup: { backup, mode: 'merge' | 'replace', dryRun }. A real restore first saves a pre-restore snapshot. */
async function restore(req, res) {
  requireAdmin(req, BACKUP_ADMIN);
  const { backup, mode, dryRun = true } = await readBody(req, 50 * 1024 * 1024);
  checkBackup(backup);
  let snapshot = null;
  if (!dryRun) snapshot = snapshots.save('pre-restore', await currentBackup());
  const report = restoreBackup(backup, { mode, dryRun: !!dryRun }, { settings, collections, plan, attachments });
  send(res, 200, { dryRun: !!dryRun, mode, report, snapshot });
}

/** Today's automatic snapshot; runs at start and every six hours (a new day gets a new one). */
async function dailySnapshot() {
  try { snapshots.daily(await currentBackup()); } catch (error) { console.error(`snapshot failed: ${error.message}`); }
}

async function putSettings(req, res) {
  requireMember(req);
  const who = role(req);
  const before = settings.value.access.pinHash;
  const value = settings.update(await readBody(req), who);
  if (settings.value.access.pinHash !== before) sessions.clear(); // a new or removed PIN signs every device out
  applyPowerMode();
  send(res, 200, value);
}
const MAP_ADMIN = 'map downloads are only available from the host machine';

async function status(req, res) {
  // In low-power mode the advisor is off, so the model server is not probed.
  const LOW_POWER_AI = { online: false, models: [], error: 'low-power mode' };
  const [ai, docker] = await Promise.all([lowPower() ? LOW_POWER_AI : aiStatus(settings.value.ai), depot.docker()]);
  const cats = new Set(manual.index().map((a) => a.category));
  send(res, 200, {
    ...systemStatus(DATA),
    power: { ...power.status(), lowPower: lowPower() },
    ai: {
      online: ai.online, models: ai.models, error: ai.error, provider: settings.value.ai.provider, model: chatModel(settings.value.ai, ai),
      household: householdAllowed(req), householdLocal: isLocalModelUrl(settings.value.ai.baseUrl),
      retrieval: advisorRetrieval(ai),
    },
    docker,
    manual: { articles: manual.articles.length, categories: cats.size },
    server: { port: PORT, lanMode: !LOOPBACK_ONLY, version: VERSION },
    access: { role: role(req), lanWrites: settings.value.access.lanWrites, pinSet: !!settings.value.access.pinHash },
    time: new Date().toISOString(),
  });
}

async function hash(req, res) {
  const { text = '', algo = 'sha256' } = await readBody(req);
  if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) throw fail(400, 'unsupported algorithm');
  send(res, 200, { hash: crypto.createHash(algo).update(String(text), 'utf8').digest('hex') });
}

const DB = `^/api/db/(${COLLECTIONS.join('|')})`;
const DB_ITEM = new RegExp(`${DB}/([0-9a-f-]{36})$`);

/**
 * [method, path, handler]. path is a string for an exact match or a RegExp whose groups are passed
 * to the handler after { req, res, url }. The first route matching both method and path wins.
 */
const ROUTES = [
  ['GET', '/api/status', ({ req, res }) => status(req, res)],
  ['GET', '/api/settings', ({ req, res }) => send(res, 200, settings.public(role(req)))],
  ['PUT', '/api/settings', ({ req, res }) => putSettings(req, res)],
  ['POST', '/api/session', ({ req, res }) => startSession(req, res)],
  ['DELETE', '/api/session', ({ req, res }) => {
    sessions.revoke(sessionToken(req));
    send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('') });
  }],

  ['GET', '/api/manual', ({ res }) => send(res, 200, manual.index())],
  ['GET', '/api/search', ({ res, url }) => send(res, 200, manual.search(url.searchParams.get('q') || '', 12))],
  ['GET', /^\/api\/manual\/section\/([^/]{1,120})$/, ({ res }, category) => {
    let name;
    try { name = decodeURIComponent(category); } catch { throw fail(400, 'bad section'); }
    const entries = manual.section(name);
    if (!entries.length) throw fail(404, 'no such section');
    send(res, 200, entries);
  }],
  ['GET', /^\/api\/manual\/([a-z0-9-]{1,200})$/, ({ res }, id) => {
    const a = manual.get(id);
    if (!a) throw fail(404, 'no such entry');
    send(res, 200, a);
  }],

  // Household data: members and the host only, for reading as well as writing.
  ['GET', new RegExp(`${DB}$`), ({ req, res }, name) => { requireMember(req); send(res, 200, collections[name].all()); }],
  ['POST', new RegExp(`${DB}$`), async ({ req, res }, name) => { requireMember(req); send(res, 201, collections[name].upsert(await bodyWithoutId(req))); }],
  ['PUT', DB_ITEM, async ({ req, res }, name, id) => {
    requireMember(req);
    const before = collections[name].all().find((x) => x.id === id);
    const item = collections[name].upsert(await bodyWithoutId(req), id);
    if (!item) throw fail(404, 'not found');
    if (name === 'notes') dropAttachments(before);
    send(res, 200, item);
  }],
  ['DELETE', DB_ITEM, ({ req, res }, name, id) => {
    requireMember(req);
    const before = collections[name].all().find((x) => x.id === id);
    const ok = collections[name].remove(id);
    if (ok) dropReferences(name, id);
    if (ok && name === 'notes') dropAttachments(before);
    send(res, 200, { ok });
  }],

  ['GET', '/api/plan', ({ req, res }) => { requireMember(req); send(res, 200, plan.get()); }],
  ['PUT', '/api/plan', async ({ req, res }) => { requireMember(req); send(res, 200, plan.update(await readBody(req))); }],
  ['POST', '/api/plan/reviewed', ({ req, res }) => {
    requireMember(req);
    send(res, 200, plan.update({ reviewedAt: new Date().toISOString().slice(0, 10) }));
  }],
  ['GET', '/api/kits/templates', ({ res }) => send(res, 200, kitTemplates)],
  ['GET', '/api/checkin', ({ req, res }) => { requireMember(req); send(res, 200, checkin.get()); }],
  ['PUT', '/api/checkin', async ({ req, res }) => { requireMember(req); send(res, 200, checkin.update(await readBody(req))); }],

  ['GET', '/api/backup', ({ req, res }) => downloadBackup(req, res)],
  ['POST', '/api/restore', ({ req, res }) => restore(req, res)],
  ['GET', '/api/snapshots', ({ req, res }) => { requireAdmin(req, BACKUP_ADMIN); send(res, 200, snapshots.list()); }],
  ['GET', /^\/api\/snapshots\/([A-Za-z0-9-]+\.json)$/, ({ req, res }, name) => {
    requireAdmin(req, BACKUP_ADMIN);
    const file = snapshots.file(name);
    if (!file) throw fail(404, 'no such snapshot');
    sendFile(req, res, file, { 'content-disposition': `attachment; filename="shelter-${name}"` });
  }],

  ['POST', '/api/hash', ({ req, res }) => hash(req, res)],
  ['POST', '/api/chat', ({ req, res }) => chat(req, res)],
  ['POST', '/api/ai/pull/check', ({ req, res }) => pullCheck(req, res)],
  ['POST', '/api/ai/pull', ({ req, res }) => pull(req, res)],

  ['POST', '/api/attachments', ({ req, res }) => uploadAttachment(req, res)],
  ['GET', /^\/api\/attachments\/([0-9a-f-]{36}\.(?:jpg|png|webp|gif))$/, ({ req, res }, name) => serveAttachment(req, res, name)],

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

  ['GET', '/api/depot', async ({ req, res }) => {
    const [list, usage] = await Promise.all([depot.list(), content.usage().catch(() => ({}))]);
    send(res, 200, { ...list, usage, canAdmin: canAdmin(req) });
  }],
  ['GET', '/api/depot/content', async ({ req, res }) => send(res, 200, { ...(await content.list()), canAdmin: canAdmin(req) })],
  ['POST', '/api/depot/content/download', async ({ req, res }) => {
    requireAdmin(req, CONTENT_ADMIN);
    send(res, 202, await content.download(await readBody(req)));
  }],
  ['POST', '/api/depot/content/cancel', async ({ req, res }) => {
    requireAdmin(req, CONTENT_ADMIN);
    send(res, 200, content.cancel(await readBody(req)));
  }],
  ['POST', '/api/depot/content/delete', async ({ req, res }) => {
    requireAdmin(req, CONTENT_ADMIN);
    send(res, 200, await content.remove(await readBody(req)));
  }],
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

const MODEL_ADMIN = 'models can only be pulled from the host machine';

/** How the Advisor finds manual passages: { mode: 'keyword' } or the embedding index's status. */
function advisorRetrieval(status) {
  const embedModel = status.online ? pickEmbedModel(settings.value.ai.embedModel, status.models) : '';
  if (!embedModel) return { mode: 'keyword' };
  const s = embeddings.status(embedModel, manual.signature);
  // Start indexing as soon as an embedding model shows up; a failed build is retried by the next question.
  if (!s.ready && !s.building && !s.error) embeddings.build(settings.value.ai, embedModel, manual.chunks(), manual.signature);
  return { mode: s.ready ? 'embeddings' : 'keyword', ...s };
}

/** The chat model: the configured one, else the first installed model that is not an embedding model. */
const chatModel = (ai, status) => ai.model || status.models.find((m) => !isEmbedModel(m)) || '';

/**
 * Whether household data (people, allergies, medications) may go into the system prompt: the host
 * turned it on, this device may see household data, and the model server is local (never a cloud API).
 */
const householdAllowed = (req) => settings.value.ai.householdContext === true && role(req) !== 'guest' && isLocalModelUrl(settings.value.ai.baseUrl);

/** Size and fit of a model before pulling it: { model, size, source, fit, memTotal, memFree, diskFree }. */
async function pullCheck(req, res) {
  requireAdmin(req, MODEL_ADMIN);
  const model = modelName((await readBody(req)).model);
  if (!model) throw fail(400, 'not a model name (for example llama3.2:3b)');
  const found = await registrySize(model);
  if (found?.missing) throw fail(404, `the Ollama library has no model called ${model}`);
  const size = found?.size ?? estimateSize(model);
  let source = 'unknown';
  if (found?.size) source = 'registry';
  else if (size) source = 'estimate';
  const { system } = systemStatus(DATA);
  const machine = { memTotal: system.memTotal, memFree: system.memFree, diskFree: system.disk?.free ?? null };
  send(res, 200, { model, size, source, ...machine, fit: modelFit({ size, ...machine }) });
}

let pulling = null; // the model being pulled, one at a time

/** Pulls a model on the Ollama server, streaming progress as NDJSON: { type: 'progress' | 'done' | 'error' }. */
async function pull(req, res) {
  requireAdmin(req, MODEL_ADMIN);
  const ai = settings.value.ai;
  if (ai.provider !== 'ollama') throw fail(400, 'models can only be pulled on an Ollama server; use your server\'s own tools');
  const model = modelName((await readBody(req)).model);
  if (!model) throw fail(400, 'not a model name (for example llama3.2:3b)');
  if (pulling) throw fail(409, `already pulling ${pulling}`);
  pulling = model;
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    await pullModel(ai, model, (p) => emit({ type: 'progress', ...p }), abort.signal);
    emit({ type: 'done', model });
  } catch (error) {
    if (!abort.signal.aborted) emit({ type: 'error', message: error.cause?.code || error.message });
  } finally {
    pulling = null;
  }
  res.end();
}

async function chat(req, res) {
  const body = await readBody(req);
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((x) => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string' && x.content.trim())
    .slice(-12)
    .map((x) => ({ role: x.role, content: x.content.slice(0, 8000) }));
  const question = [...history].reverse().find((x) => x.role === 'user');
  if (!question) throw fail(400, 'no question');
  if (lowPower()) throw fail(503, 'the advisor is off in low-power mode: turn it off under Command, Power');

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  const ai = settings.value.ai;
  const status = await aiStatus(ai);
  // Ground the answer in the best-matching passages (embeddings when available, else keywords); cite each article once.
  const embedModel = status.online ? pickEmbedModel(ai.embedModel, status.models) : '';
  const { passages, mode } = await retrieve({ manual, index: embeddings, ai, embedModel, question: question.content });
  const cited = [...new Map(passages.map((x) => [x.article.id, x.article])).values()];
  emit({ type: 'sources', retrieval: mode, items: cited.map(({ id, title, category, summary }) => ({ id, title, category, summary })) });

  const model = chatModel(ai, status);
  if (!status.online || !model) {
    emit({ type: 'offline', reason: status.online ? 'no model installed on the model server' : 'model server unreachable' });
    return res.end();
  }
  const household = householdAllowed(req) ? householdPrompt(collections.people.all()) : '';
  if (household) emit({ type: 'context', household: true });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const system = buildPrompt(passages, { household });
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

function sendFile(req, res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size, 'cache-control': 'no-cache', ...SECURITY, ...extra,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'method not allowed');
  // Installable app: the shell list for the service worker, the worker itself (whole-site scope), and the
  // HTTPS certificate so phones can trust it (public: it holds no key).
  if (url.pathname === '/app-shell.json') return send(res, 200, shellManifest(PUBLIC));
  if (url.pathname === '/sw.js') return sendFile(req, res, path.join(PUBLIC, 'sw.js'), { 'service-worker-allowed': '/' });
  if (url.pathname === '/shelter.crt') {
    if (!tls) throw fail(404, 'HTTPS is off');
    return sendFile(req, res, tls.file, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="shelter.crt"' });
  }
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

async function handle(req, res) {
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
}

// Optional HTTPS (--https or SHELTER_HTTPS=1): phones only allow GPS and offline install over HTTPS.
// A self-signed certificate is made in <data>/tls on demand (server/https.js). Without openssl, plain HTTP.
let tls = null;
if (httpsRequested()) {
  try {
    tls = loadCert(DATA, { hosts: certHosts({ lan: systemStatus(DATA).system.lan, hostname: machineName() }) });
  } catch (error) { console.warn(`\n  ${error.message}\n`); }
}
const SCHEME = tls ? 'https' : 'http';
// With HTTPS, plain-HTTP requests from this machine (health checks, installers) are still answered; others are redirected.
const server = tls ? dualServer(tls, handle, { keepPlain: isLoopback }) : http.createServer(handle);

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Set PORT=<n> to choose another.` : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  dailySnapshot().catch(() => {}); // logs its own errors
  applyPowerMode();
  setInterval(dailySnapshot, 6 * 3600 * 1000).unref();
  console.log(`\n  SHELTER // field node online`);
  // In a bridged container PORT is the internal one; SHELTER_PORT is what the host publishes.
  const shown = process.env.SHELTER_PORT || PORT;
  console.log(`  local   ${SCHEME}://localhost:${shown}`);
  if (!LOOPBACK_ONLY) for (const ip of systemStatus(DATA).system.lan) console.log(`  lan     ${SCHEME}://${ip}:${shown}`);
  else console.log(`  lan     disabled (start with --lan to serve other devices)`);
  if (tls) console.log(`  https   ${tls.created ? 'new ' : ''}certificate ${tls.file}\n          SHA-256 ${tls.fingerprint}\n          phones can install it from /shelter.crt`);
  console.log(`  manual  ${manual.articles.length} entries   data  ${DATA}\n`);
});
