// Depot content: a curated catalog (config/content.json) of things to fetch for depot services while
// a link is available: Kiwix ZIM archives, Kolibri channels and Ollama models. Shelter only downloads
// what the catalog lists, only over http(s) from the catalog's allowed hosts, and only into the
// service's own depot folder. Edit config/content.json, or add config/content.custom.json, to change it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GIB = 1024 ** 3;
/** Free space kept back after a download: below this the download needs confirmation. */
export const RESERVE = GIB;
const KINDS = new Set(['file', 'kolibri', 'ollama']);
const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
/** File names Shelter will create or delete: no separators, no leading dot, no "..". */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const CHANNEL = /^[0-9a-f]{32}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,79}(?:\/[a-z0-9][a-z0-9._-]{0,79})?(?::[a-z0-9][a-z0-9._-]{0,79})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- pure helpers (tested directly) ----------

/** A file name that is safe to create in a content folder and ends with ext, or null. */
export function safeFileName(name, ext = '') {
  const s = String(name ?? '');
  if (!SAFE_FILE.test(s) || s.includes('..')) return null;
  if (ext && !s.toLowerCase().endsWith(ext.toLowerCase())) return null;
  return s;
}

/** The absolute path of name directly inside dir; throws when it would land anywhere else. */
export function insideDir(dir, name) {
  const s = String(name ?? '');
  const root = path.resolve(dir);
  const full = path.resolve(root, s);
  // basename === name rules out separators of either kind; dirname === root rules out "..".
  if (!s || s === '.' || s === '..' || s.includes('\0') || path.basename(full) !== s || path.dirname(full) !== root) throw fail(400, 'bad file name');
  return full;
}

/** Last path segment of an http(s) URL, decoded, if it is a safe file name. */
export function fileFromUrl(url, ext = '') {
  try {
    const seg = new URL(url).pathname.split('/').pop();
    return safeFileName(decodeURIComponent(seg), ext);
  } catch {
    return null;
  }
}

/** Whether url is http(s) and its host is in hosts (exact, or a subdomain of an entry). */
export function allowedUrl(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Whether need bytes fit in free bytes. fits: there is room at all. tight: it fits but leaves less
 * than reserve free, so the person should confirm first.
 */
export function diskFit(need, free, reserve = RESERVE) {
  const n = Math.max(0, Number(need) || 0);
  if (!Number.isFinite(free)) return { fits: true, tight: false, need: n, free: null, after: null };
  return { fits: n <= free, tight: n > free - reserve, need: n, free, after: free - n };
}

/**
 * How to continue after asking for bytes from offset onwards. Returns { mode, total } where mode is
 * 'append' (the server sent the rest), 'restart' (it sent the whole file, or the part no longer
 * matches), 'complete' (nothing left to fetch) or 'error'.
 */
export function resumePlan(status, { contentRange = '', contentLength = '' } = {}, offset = 0) {
  const len = contentLength === '' || contentLength == null ? null : Number(contentLength);
  if (status === 200) return { mode: 'restart', total: Number.isFinite(len) ? len : null };
  if (status === 206) {
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(contentRange).trim());
    if (!m) return { mode: 'error', error: 'bad Content-Range from server' };
    if (Number(m[1]) !== offset) return { mode: 'restart', total: null };
    return { mode: 'append', total: m[3] === '*' ? null : Number(m[3]) };
  }
  if (status === 416) {
    const m = /^bytes \*\/(\d+)$/.exec(String(contentRange).trim());
    if (m && Number(m[1]) === offset) return { mode: 'complete', total: offset };
    return { mode: 'restart', total: null };
  }
  return { mode: 'error', error: `HTTP ${status}` };
}

/** sha256 of a file, hex. onBytes(n) is called as it reads. */
export async function sha256File(file, { onBytes = () => {}, signal } = {}) {
  const hash = crypto.createHash('sha256');
  const meter = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); onBytes(chunk.length); done(); } });
  await pipeline(fs.createReadStream(file), meter, signal ? { signal } : {});
  return hash.digest('hex');
}

async function fileSize(file) {
  try { return (await fsp.stat(file)).size; } catch { return 0; }
}
const rangeRequest = (offset, signal) => ({ headers: offset > 0 ? { range: `bytes=${offset}-` } : {}, signal, redirect: 'follow' });
const planFor = (r, offset) => resumePlan(r.status, { contentRange: r.headers.get('content-range') || '', contentLength: r.headers.get('content-length') ?? '' }, offset);
const drain = (r) => r.body?.cancel().catch(() => {});

/** Streams the response body into part (appending from start), reporting progress. */
async function writeBody(r, part, start, total, { signal, onProgress }) {
  let bytes = start;
  onProgress({ bytes, total });
  const meter = new Transform({ transform(chunk, _enc, done) { bytes += chunk.length; onProgress({ bytes, total }); done(null, chunk); } });
  await pipeline(Readable.fromWeb(r.body), meter, fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }), { signal });
  if (total != null && bytes !== total) throw new Error(`incomplete download (${bytes} of ${total} bytes); try again to resume`);
  return { size: bytes, total: total ?? bytes };
}

/**
 * Downloads url into part, continuing an earlier partial download with an HTTP Range request.
 * beforeWrite(remaining) may throw to refuse (for example, when the disk is too small).
 * onProgress({ bytes, total }) reports how much of the whole file is on disk.
 */
export async function downloadFile(url, part, { signal, onProgress = () => {}, beforeWrite = async () => {}, fetchImpl = fetch } = {}) {
  let offset = await fileSize(part);
  let r = await fetchImpl(url, rangeRequest(offset, signal));
  let plan = planFor(r, offset);
  if (plan.mode === 'restart' && r.status !== 200) {
    // The partial file does not line up with what the server has: start over.
    await drain(r);
    await fsp.rm(part, { force: true });
    offset = 0;
    r = await fetchImpl(url, rangeRequest(0, signal));
    plan = planFor(r, 0);
  }
  if (plan.mode === 'error') { await drain(r); throw new Error(plan.error); }
  if (plan.mode === 'complete') { await drain(r); onProgress({ bytes: offset, total: offset }); return { size: offset, total: offset }; }
  if (plan.mode === 'restart' && r.status !== 200) { await drain(r); throw new Error('the server would not resume the download'); }
  const start = plan.mode === 'append' ? offset : 0;
  await beforeWrite(plan.total == null ? null : plan.total - start);
  return writeBody(r, part, start, plan.total, { signal, onProgress });
}

// ---------- catalog ----------

const str = (v, max) => String(v ?? '').slice(0, max);
const size = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** A file item: its URL must be on an allowed host, and its file name safe and of the source's type. */
function fileItem(src, it, hosts, base) {
  if (typeof it.url !== 'string' || !allowedUrl(it.url, hosts)) return null;
  const file = it.file ? safeFileName(it.file, src.ext) : fileFromUrl(it.url, src.ext);
  if (!file) return null;
  const hex = typeof it.sha256 === 'string' ? it.sha256.toLowerCase() : '';
  return { ...base, url: it.url, file, sha256: SHA256.test(hex) ? hex : null };
}

function validItem(src, it, hosts) {
  if (!it || !ID.test(it.id || '')) return null;
  const base = { id: it.id, title: str(it.title || it.id, 120), desc: str(it.desc, 400), category: str(it.category || 'OTHER', 30).toUpperCase(), lang: str(it.lang, 12), size: size(it.size), approx: !!it.approx };
  if (src.kind === 'file') return fileItem(src, it, hosts, base);
  if (src.kind === 'kolibri') return CHANNEL.test(it.channel || '') ? { ...base, channel: it.channel } : null;
  return MODEL.test(it.model || '') && !it.model.includes('..') ? { ...base, model: it.model } : null;
}

/** One catalog source with its valid items, or null (after a warning) when the source itself is bad. */
function validSource(s, hosts, source, warn) {
  if (!s || !ID.test(s.id || '') || !ID.test(s.service || '') || !KINDS.has(s.kind)) {
    warn(`content: skipped invalid source in ${source}: ${JSON.stringify(s?.id ?? s)}`);
    return null;
  }
  const fileKind = s.kind === 'file';
  if (fileKind && !/^\.[a-z0-9]{1,10}$/.test(s.ext || '')) {
    warn(`content: source ${s.id} in ${source} needs an "ext" such as ".zim"`);
    return null;
  }
  const src = {
    id: s.id, service: s.service, kind: s.kind, ext: fileKind ? s.ext : '', title: str(s.title || s.id, 80), desc: str(s.desc, 400),
    note: str(s.note, 400), checksum: s.checksum === 'sidecar' ? 'sidecar' : 'none', items: [],
  };
  for (const it of Array.isArray(s.items) ? s.items : []) {
    const v = validItem(src, it, hosts);
    if (v && !src.items.some((x) => x.id === v.id)) src.items.push(v);
    else warn(`content: skipped invalid item in ${source}/${s.id}: ${JSON.stringify(it?.id ?? it)}`);
  }
  return src;
}

/** Keeps the well-formed sources and items of a catalog document; warns about the rest. */
export function validateCatalog(doc, source = 'content.json', warn = console.warn) {
  const hosts = (Array.isArray(doc?.allowHosts) ? doc.allowHosts : []).map((h) => String(h).toLowerCase()).filter((h) => HOST.test(h));
  const sources = (Array.isArray(doc?.sources) ? doc.sources : []).map((s) => validSource(s, hosts, source, warn)).filter(Boolean);
  return { allowHosts: hosts, sources };
}

/** Merges a custom catalog into the built-in one: hosts are added, items with the same id replace. */
export function mergeCatalog(base, extra) {
  const out = { allowHosts: [...new Set([...base.allowHosts, ...extra.allowHosts])], sources: base.sources.map((s) => ({ ...s, items: [...s.items] })) };
  for (const s of extra.sources) {
    const mine = out.sources.find((x) => x.id === s.id);
    if (!mine) { out.sources.push({ ...s, items: s.items.map((it) => ({ ...it, custom: true })) }); continue; }
    for (const it of s.items) {
      const i = mine.items.findIndex((x) => x.id === it.id);
      if (i >= 0) mine.items[i] = { ...it, custom: true }; else mine.items.push({ ...it, custom: true });
    }
  }
  return out;
}

/** Reads config/content.json and the optional content.custom.json next to it. */
export function loadCatalog(file, warn = console.warn) {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  let cat = { allowHosts: [], sources: [] };
  try { cat = validateCatalog(read(file), path.basename(file), warn); } catch (error) { warn(`content: could not read ${path.basename(file)}: ${error.message}`); }
  const custom = path.join(path.dirname(file), 'content.custom.json');
  if (fs.existsSync(custom)) {
    try {
      const extra = read(custom);
      // Custom items may use the built-in hosts as well as their own.
      cat = mergeCatalog(cat, validateCatalog({ ...extra, allowHosts: [...cat.allowHosts, ...(extra.allowHosts || [])] }, 'content.custom.json', warn));
    } catch (error) { warn(`content: could not read content.custom.json: ${error.message}`); }
  }
  return cat;
}

// ---------- disk usage ----------

/** Total size of the files under dir (symbolic links are not followed). Stops counting after limit entries. */
export async function dirSize(dir, limit = 200_000) {
  let total = 0, seen = 0;
  const stack = [dir];
  while (stack.length && seen < limit) {
    const d = stack.pop();
    let entries = [];
    // eslint-disable-next-line no-await-in-loop -- one folder at a time keeps memory flat on large trees
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        // eslint-disable-next-line no-await-in-loop -- see above
        try { total += (await fsp.lstat(p)).size; } catch { /* removed meanwhile */ }
      }
    }
  }
  return total;
}

/** { free, total } bytes of the filesystem holding dir, or null when unknown. */
export async function diskSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

// ---------- the manager ----------

export class Content {
  /**
   * depot: the Depot (catalog of services, their folders and the Docker CLI).
   * ollamaUrl: () => base URL of the Ollama server. fetchImpl and space are replaceable in tests.
   */
  constructor(catalogFile, depot, { ollamaUrl = () => 'http://127.0.0.1:11434', fetchImpl = fetch, space = diskSpace, warn = console.warn } = {}) {
    this.catalog = loadCatalog(catalogFile, warn);
    this.depot = depot;
    this.ollamaUrl = ollamaUrl;
    this.fetch = fetchImpl;
    this.space = space;
    this.jobs = new Map(); // "source/item" -> job
    this.usageCache = { at: 0, value: null };
  }

  root() { return path.join(this.depot.dataDir, 'depot'); }

  #source(id) {
    const src = this.catalog.sources.find((s) => s.id === id);
    if (!src) throw fail(404, 'unknown content source');
    const svc = this.depot.catalog.find((s) => s.id === src.service);
    if (!svc) throw fail(404, `the ${src.service} service is not in the depot catalog`);
    return { src, svc };
  }

  /** The folder a file source downloads into: the service's own depot folder. */
  dirFor(svc) { return this.depot.volumeDir(svc); }

  /** Bytes used under each service's depot folder; cached for 30 seconds. */
  async usage(force = false) {
    if (!force && this.usageCache.value && Date.now() - this.usageCache.at < 30_000) return this.usageCache.value;
    const entries = await Promise.all(this.depot.catalog.map(async (svc) => [svc.id, await dirSize(this.depot.volumeDir(svc))]));
    const value = Object.fromEntries(entries.filter(([, n]) => n > 0));
    this.usageCache = { at: Date.now(), value };
    return value;
  }

  async disk() {
    fs.mkdirSync(this.root(), { recursive: true });
    return this.space(this.root());
  }

  /** Bytes still to come for running downloads; they count against free space. */
  pending() {
    let n = 0;
    for (const j of this.jobs.values()) if (j.state === 'running' && j.total) n += Math.max(0, j.total - j.bytes);
    return n;
  }

  job(key) {
    const j = this.jobs.get(key);
    if (!j) return null;
    const { controller, ...rest } = j;
    return rest;
  }

  /** The catalog with what is installed, partial downloads, local files and jobs. */
  async list() {
    const containers = {};
    const depot = await this.depot.list().catch(() => ({ services: [] }));
    for (const s of depot.services) if (s.container) containers[s.id] = s.container.state;
    const [disk, usage] = await Promise.all([this.disk(), this.usage()]);
    const sources = await Promise.all(this.catalog.sources.map((src) => this.#describe(src, containers)));
    return { disk, reserve: RESERVE, pending: this.pending(), usage, sources: sources.filter(Boolean), jobs: [...this.jobs.keys()].map((k) => this.job(k)) };
  }

  async #describe(src, containers) {
    const svc = this.depot.catalog.find((s) => s.id === src.service);
    if (!svc) return null;
    const running = containers[svc.id] === 'running';
    const head = { id: src.id, service: svc.id, serviceName: svc.name, kind: src.kind, title: src.title, desc: src.desc, note: src.note, running, ext: src.ext };
    if (src.kind === 'file') return { ...head, ...(await this.#fileState(src, svc)) };
    const installed = src.kind === 'ollama' ? await this.#ollamaModels() : await this.#kolibriChannels(svc, running);
    return {
      ...head,
      reachable: installed !== null,
      items: src.items.map((it) => {
        const key = src.kind === 'ollama' ? it.model : it.channel;
        const found = installed?.get(key) ?? installed?.get(`${key}:latest`);
        return { ...it, installed: !!found, installedSize: found?.size ?? null, job: this.job(`${src.id}/${it.id}`) };
      }),
    };
  }

  async #fileState(src, svc) {
    const dir = this.dirFor(svc);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { /* no folder yet */ }
    const stat = async (n) => { try { return (await fsp.stat(path.join(dir, n))).size; } catch { return null; } };
    const ext = src.ext.toLowerCase();
    const files = names.filter((n) => n.toLowerCase().endsWith(ext) && safeFileName(n));
    const sizes = new Map(await Promise.all(files.map(async (n) => [n, await stat(n)])));
    const items = await Promise.all(src.items.map(async (it) => ({
      ...it,
      installed: sizes.has(it.file), installedSize: sizes.get(it.file) ?? null,
      partial: names.includes(partName(it.file)) ? await stat(partName(it.file)) : null,
      job: this.job(`${src.id}/${it.id}`),
    })));
    const known = new Set(src.items.map((it) => it.file));
    const local = files.map((file) => ({ file, size: sizes.get(file), inCatalog: known.has(file) })).sort((a, b) => a.file.localeCompare(b.file));
    return { dir: this.depot.displayDir(svc), items, local };
  }

  /** Installed Ollama models by name, or null when Ollama cannot be reached. */
  async #ollamaModels() {
    try {
      const r = await this.fetch(`${this.ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return null;
      const data = await r.json();
      return new Map((data.models || []).map((m) => [m.name, { size: m.size }]));
    } catch {
      return null;
    }
  }

  /** Imported Kolibri channel ids, or null when the container is not running. */
  async #kolibriChannels(svc, running) {
    if (!running) return null;
    const r = await this.depot.run(['exec', `shelter-${svc.id}`, 'kolibri', 'manage', 'listchannels'], 20_000);
    if (r.code !== 0) return null;
    return new Map([...r.out.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => [m[1], {}]));
  }

  /** Starts downloading one catalog item. force: go ahead although it leaves less than RESERVE free. */
  async download({ source, item, force = false } = {}) {
    const { src, svc } = this.#source(source);
    const it = src.items.find((x) => x.id === item);
    if (!it) throw fail(404, 'unknown catalog item');
    const key = `${src.id}/${it.id}`;
    if (this.jobs.get(key)?.state === 'running') throw fail(409, 'that download is already running');

    if (src.kind !== 'file') {
      const docker = src.kind === 'kolibri' ? await this.depot.docker() : null;
      if (docker && !docker.online) throw fail(409, 'Docker is not running on this host');
    }
    let have = 0;
    if (src.kind === 'file') {
      if (fs.existsSync(path.join(this.dirFor(svc), it.file))) throw fail(409, `${it.file} is already downloaded`);
      try { have = fs.statSync(path.join(this.dirFor(svc), partName(it.file))).size; } catch { /* fresh start */ }
    }
    this.#checkSpace(await this.disk(), it.size == null ? 0 : it.size - have, force === true);

    const controller = new AbortController();
    const job = { key, source: src.id, item: it.id, title: it.title, kind: src.kind, state: 'running', phase: 'connecting', bytes: have, total: it.size, started: Date.now(), force: force === true, controller };
    this.jobs.set(key, job);
    const run = { file: () => this.#runFile(job, src, svc, it), kolibri: () => this.#runKolibri(job, svc, it), ollama: () => this.#runOllama(job, it) }[src.kind];
    run().then(
      () => { job.state = 'done'; job.phase = 'done'; job.finished = Date.now(); },
      (error) => {
        job.state = controller.signal.aborted ? 'cancelled' : 'error';
        job.error = controller.signal.aborted ? 'cancelled' : downloadError(error);
        job.finished = Date.now();
      },
    ).finally(() => { this.usageCache.at = 0; });
    return this.job(key);
  }

  /** Refuses when need bytes do not fit, or leave less than RESERVE free and force is not set. */
  #checkSpace(disk, need, force) {
    if (!disk) return;
    const fit = diskFit(need + this.pending(), disk.free);
    if (!fit.fits) throw fail(507, `not enough disk space: needs ${gb(need)}, ${gb(Math.max(0, disk.free - this.pending()))} free`);
    if (fit.tight && !force) throw fail(409, `low disk space: this leaves ${gb(Math.max(0, fit.after))} free. Confirm to download anyway.`);
  }

  cancel({ source, item } = {}) {
    const j = this.jobs.get(`${source}/${item}`);
    if (j?.state === 'running') j.controller.abort();
    return { ok: true };
  }

  async #runFile(job, src, svc, it) {
    const dir = this.dirFor(svc);
    fs.mkdirSync(dir, { recursive: true });
    this.depot.ownFolders?.(svc, []);
    const final = insideDir(dir, it.file);
    const part = insideDir(dir, partName(it.file));
    const { signal } = job.controller;
    job.phase = 'downloading';
    await downloadFile(it.url, part, {
      signal, fetchImpl: this.fetch,
      onProgress: ({ bytes, total }) => { job.bytes = bytes; if (total) job.total = total; },
      // The real size is known now: check it again against free space (other downloads excluded).
      beforeWrite: async (remaining) => {
        const disk = await this.disk();
        if (!disk || remaining == null) return;
        const fit = diskFit(remaining, disk.free);
        if (!fit.fits) throw new Error(`not enough disk space: needs ${gb(remaining)}, ${gb(disk.free)} free`);
        if (fit.tight && !job.force) throw new Error(`low disk space: the file is ${gb(remaining)} and would leave ${gb(fit.after)} free. Download again to confirm.`);
      },
    });
    const expected = it.sha256 || (src.checksum === 'sidecar' ? await this.#sidecar(it.url, signal) : null);
    if (expected) {
      job.phase = 'verifying';
      job.checked = 0;
      const got = await sha256File(part, { onBytes: (n) => { job.checked += n; }, signal });
      if (got !== expected) {
        await fsp.rm(part, { force: true });
        throw new Error('checksum mismatch: the file was damaged in transfer and has been removed. Try again.');
      }
      job.verified = true;
    } else job.verified = false;
    await fsp.rename(part, final);
    if (svc.id === 'kiwix' || svc.needsFiles) job.note = `Restart ${svc.name} (STOP, then START) to load it.`;
  }

  /** The sha256 the server publishes next to url (url + ".sha256"), or null when there is none. */
  async #sidecar(url, signal) {
    try {
      const r = await this.fetch(`${url}.sha256`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      if (!r.ok) return null;
      const hex = (await r.text()).trim().split(/\s/)[0].toLowerCase();
      return SHA256.test(hex) ? hex : null;
    } catch {
      return null;
    }
  }

  async #runKolibri(job, svc, it) {
    const name = `shelter-${svc.id}`;
    const state = await this.depot.run(['inspect', '--format', '{{.State.Status}}', name]);
    if (state.code !== 0 || state.out !== 'running') throw new Error(`start ${svc.name} first`);
    const { signal } = job.controller;
    const dir = this.depot.volumeDir(svc);
    const before = await dirSize(dir);
    // Kolibri reports no machine-readable progress: watch its folder grow instead.
    const timer = setInterval(() => { dirSize(dir).then((n) => { job.bytes = Math.max(0, n - before); }, () => {}); }, 5000);
    try {
      for (const [phase, cmd] of [['channel index', 'importchannel'], ['downloading', 'importcontent']]) {
        job.phase = phase;
        // eslint-disable-next-line no-await-in-loop -- the content import needs the channel index first
        const r = await this.depot.run(['exec', name, 'kolibri', 'manage', cmd, 'network', it.channel], 24 * 3600 * 1000, { signal });
        if (signal.aborted) throw new Error('cancelled');
        if (r.code !== 0) throw new Error((r.err || `kolibri ${cmd} failed`).split('\n').slice(-2).join(' ').slice(0, 300));
      }
    } finally { clearInterval(timer); }
  }

  async #runOllama(job, it) {
    const { signal } = job.controller;
    const r = await this.fetch(`${this.ollamaUrl()}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: it.model, name: it.model, stream: true }), signal,
    }).catch((error) => { throw signal.aborted ? error : new Error('cannot reach Ollama: deploy and start the OLLAMA service first'); });
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}`);
    const layers = new Map();
    for await (const line of ndjson(r.body)) {
      if (line.error) throw new Error(String(line.error).slice(0, 300));
      job.phase = String(line.status || 'pulling').slice(0, 60);
      if (line.digest && line.total) {
        layers.set(line.digest, { total: line.total, completed: line.completed || 0 });
        job.bytes = [...layers.values()].reduce((s, l) => s + l.completed, 0);
        job.total = Math.max(it.size || 0, [...layers.values()].reduce((s, l) => s + l.total, 0));
      }
      if (line.status === 'success') return;
    }
    throw new Error('Ollama ended the pull early');
  }

  /** Deletes an item (a catalog id) or a local file of a source. */
  async remove({ source, item, file } = {}) {
    const { src, svc } = this.#source(source);
    const key = item ? `${src.id}/${item}` : null;
    if (key && this.jobs.get(key)?.state === 'running') throw fail(409, 'cancel the download first');
    try {
      if (src.kind === 'file') return await this.#removeFile(src, svc, item, file);
      const it = src.items.find((x) => x.id === item);
      if (!it) throw fail(404, 'unknown catalog item');
      if (src.kind === 'ollama') return await this.#removeModel(it);
      const r = await this.depot.run(['exec', `shelter-${svc.id}`, 'kolibri', 'manage', 'deletechannel', it.channel], 10 * 60 * 1000);
      if (r.code !== 0) throw fail(409, r.err ? r.err.split('\n').at(-1).slice(0, 300) : `start ${svc.name} first`);
      return { ok: true };
    } finally {
      this.usageCache.at = 0;
      if (key && this.jobs.get(key)?.state !== 'running') this.jobs.delete(key);
    }
  }

  async #removeFile(src, svc, item, file) {
    const dir = this.dirFor(svc);
    const it = item ? src.items.find((x) => x.id === item) : null;
    if (item && !it) throw fail(404, 'unknown catalog item');
    const name = it ? it.file : safeFileName(file, src.ext);
    if (!name) throw fail(400, 'bad file name');
    await fsp.rm(insideDir(dir, name), { force: true });
    await fsp.rm(insideDir(dir, partName(name)), { force: true });
    return { ok: true };
  }

  async #removeModel(it) {
    let r;
    try {
      r = await this.fetch(`${this.ollamaUrl()}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: it.model, name: it.model }), signal: AbortSignal.timeout(30_000) });
    } catch { throw fail(409, 'cannot reach Ollama: start the OLLAMA service first'); }
    if (!r.ok && r.status !== 404) throw fail(502, `Ollama returned HTTP ${r.status}`);
    return { ok: true };
  }
}

/** The partial-download name for a file: hidden, so services never load it. */
const partName = (file) => `.${file}.part`;

const gb = (n) => (n >= GIB ? `${(n / GIB).toFixed(1)} GB` : `${Math.max(0, Math.round(n / 1024 ** 2))} MB`);

function downloadError(error) {
  const offline = error.message === 'fetch failed' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET/.test(String(error.cause?.code || error.code || ''));
  return offline ? 'cannot reach the download server: is there an internet link? Try again later to resume.' : String(error.message).slice(0, 400);
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Parsed JSON objects from a newline-delimited JSON body; unparsable lines are skipped. */
async function* ndjson(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const v = parse(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
      if (v) yield v;
    }
  }
  const last = parse(buf.trim());
  if (last) yield last;
}
