// Offline street maps: serves vector tiles from PMTiles archives in <data>/maps, and downloads
// an area from the Protomaps OpenStreetMap planet build while a link is available.
// PMTiles v3 spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const BUILDS = 'https://build-metadata.protomaps.dev/builds.json';
const BUILD_BASE = 'https://build.protomaps.com/';
const HEADER_LEN = 127;
const COMPRESSION = { 1: 'none', 2: 'gzip', 3: 'brotli', 4: 'zstd' };
export const MAX_TILES = 400_000; // about a mid-sized country at zoom 15

// ---------- tile ids (Hilbert curve per zoom level) ----------

export function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  const n = 2 ** z;
  let tx = x, ty = y, d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (tx & s) > 0 ? 1 : 0, ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      [tx, ty] = [ty, tx];
    }
  }
  return acc + d;
}

const lonToX = (lon, z) => Math.min(2 ** z - 1, Math.max(0, Math.floor((lon + 180) / 360 * 2 ** z)));
const latToY = (lat, z) => {
  const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  return Math.min(2 ** z - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z)));
};

/** Number of tiles a bbox [w, s, e, n] covers from zoom 0 to maxzoom. */
export function countTiles(bbox, maxzoom) {
  let total = 0;
  for (let z = 0; z <= maxzoom; z++) {
    total += (lonToX(bbox[2], z) - lonToX(bbox[0], z) + 1) * (latToY(bbox[1], z) - latToY(bbox[3], z) + 1);
  }
  return total;
}

// ---------- binary helpers ----------

function readVarint(buf, pos) {
  let v = 0, mul = 1, b;
  do {
    if (pos.i >= buf.length) throw new Error('truncated varint');
    b = buf[pos.i++];
    v += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80);
  return v;
}

function writeVarint(out, v) {
  while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}

function decompress(buf, kind) {
  switch (kind) {
    case 1: return buf;
    case 2: return zlib.gunzipSync(buf);
    case 3: return zlib.brotliDecompressSync(buf);
    case 4:
      if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
      throw new Error('zstd archives need Node 22.15 or newer');
    default: throw new Error('unknown compression');
  }
}

function parseHeader(b) {
  if (b.length < HEADER_LEN || b.toString('latin1', 0, 7) !== 'PMTiles') throw new Error('not a PMTiles archive');
  if (b[7] !== 3) throw new Error(`PMTiles version ${b[7]} not supported (need 3)`);
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  return {
    rootOffset: u64(8), rootLength: u64(16), metaOffset: u64(24), metaLength: u64(32),
    leafOffset: u64(40), leafLength: u64(48), dataOffset: u64(56), dataLength: u64(64),
    addressed: u64(72), entries: u64(80), contents: u64(88),
    clustered: b[96] === 1, internalCompression: b[97], tileCompression: b[98], tileType: b[99],
    minZoom: b[100], maxZoom: b[101],
    bounds: [b.readInt32LE(102) / 1e7, b.readInt32LE(106) / 1e7, b.readInt32LE(110) / 1e7, b.readInt32LE(114) / 1e7],
    centerZoom: b[118], center: [b.readInt32LE(119) / 1e7, b.readInt32LE(123) / 1e7],
  };
}

function parseDirectory(buf) {
  const pos = { i: 0 };
  const n = readVarint(buf, pos);
  const entries = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last += readVarint(buf, pos); entries[i] = { tileId: last, offset: 0, length: 0, runLength: 1 }; }
  for (let i = 0; i < n; i++) entries[i].runLength = readVarint(buf, pos);
  for (let i = 0; i < n; i++) entries[i].length = readVarint(buf, pos);
  for (let i = 0; i < n; i++) {
    const v = readVarint(buf, pos);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

function serializeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) { writeVarint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], p = entries[i - 1];
    writeVarint(out, i > 0 && e.offset === p.offset + p.length ? 0 : e.offset + 1);
  }
  return zlib.gzipSync(Buffer.from(out));
}

/** Entry holding tileId: a tile (runLength > 0) or a leaf directory (runLength 0), or null. */
function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = entries[mid].tileId;
    if (c < tileId) lo = mid + 1; else if (c > tileId) hi = mid - 1; else return entries[mid];
  }
  if (hi >= 0) {
    const e = entries[hi];
    if (e.runLength === 0 || tileId - e.tileId < e.runLength) return e;
  }
  return null;
}

// ---------- local archives ----------

class Archive {
  constructor(file) { this.file = file; this.dirs = new Map(); }

  async open() {
    this.fh = await fsp.open(this.file, 'r');
    const st = await this.fh.stat();
    this.mtimeMs = st.mtimeMs; this.size = st.size;
    this.header = parseHeader(await this.read(0, HEADER_LEN));
    if (this.header.tileType !== 1) throw new Error('only vector (MVT) archives are supported');
    let meta = {};
    try {
      if (this.header.metaLength) meta = JSON.parse(decompress(await this.read(this.header.metaOffset, this.header.metaLength), this.header.internalCompression).toString('utf8'));
    } catch { /* metadata is optional */ }
    this.meta = meta;
    return this;
  }

  async read(offset, length) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }

  async dir(offset, length) {
    const key = `${offset}:${length}`;
    let d = this.dirs.get(key);
    if (!d) {
      d = parseDirectory(decompress(await this.read(offset, length), this.header.internalCompression));
      if (this.dirs.size > 64) this.dirs.delete(this.dirs.keys().next().value);
      this.dirs.set(key, d);
    }
    return d;
  }

  /** Raw (still compressed) tile bytes, or null. */
  tile(z, x, y) {
    const h = this.header;
    if (z < h.minZoom || z > h.maxZoom) return null;
    return this.#find(zxyToTileId(z, x, y), h.rootOffset, h.rootLength, 0);
  }

  /** Looks the tile up in the directory at offset, following leaf directories up to 3 levels down. */
  async #find(id, offset, length, depth) {
    const e = depth < 4 && findEntry(await this.dir(offset, length), id);
    if (!e) return null;
    const h = this.header;
    if (e.runLength > 0) return this.read(h.dataOffset + e.offset, e.length);
    return this.#find(id, h.leafOffset + e.offset, e.length, depth + 1);
  }

  info() {
    const h = this.header;
    return {
      file: path.basename(this.file), size: this.size, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: h.bounds,
      center: h.center, centerZoom: h.centerZoom, name: this.meta.name || '', attribution: this.meta.attribution || '',
      date: this.meta['planetiler:osm:osmosisreplicationtime'] || '',
    };
  }

  close() { return this.fh?.close().catch(() => {}); }
}

// ---------- downloading an area ----------

/** Bytes [offset, offset + length) of url, retried with a growing pause (attempt 1 of 4 by default). */
async function fetchRange(url, offset, length, signal, attempt = 1, tries = 4) {
  try {
    const r = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, signal });
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status === 200 && offset > 0) throw new Error('server ignored the range request');
    if (buf.length < length) throw new Error('short read');
    return buf.subarray(0, length);
  } catch (error) {
    if (signal?.aborted || attempt >= tries) throw error;
    await new Promise((ok) => setTimeout(ok, 800 * attempt));
    return fetchRange(url, offset, length, signal, attempt + 1, tries);
  }
}

/** Resolve the planet build URL: SHELTER_MAP_SOURCE, or the newest Protomaps daily build. */
async function sourceUrl(signal) {
  if (process.env.SHELTER_MAP_SOURCE) return process.env.SHELTER_MAP_SOURCE;
  const r = await fetch(BUILDS, { signal });
  if (!r.ok) throw new Error(`build list: HTTP ${r.status}`);
  const builds = (await r.json()).filter((b) => /^\d{8}\.pmtiles$/.test(b.key)).sort((a, b) => a.key.localeCompare(b.key));
  if (!builds.length) throw new Error('no planet build listed');
  return BUILD_BASE + builds.at(-1).key;
}

/** Group sorted {offset, length} ranges into fetches, allowing small gaps to save requests. */
function chunkRanges(items, gap = 64 * 1024, max = 8 * 1024 * 1024) {
  const chunks = [];
  let cur = null;
  for (const it of items) {
    if (cur && it.offset - (cur.offset + cur.length) <= gap && it.offset + it.length - cur.offset <= max) {
      cur.length = Math.max(cur.length, it.offset + it.length - cur.offset);
      cur.items.push(it);
    } else {
      cur = { offset: it.offset, length: it.length, items: [it] };
      chunks.push(cur);
    }
  }
  return chunks;
}

/** Build root + leaf directories; the root must fit in the first 16 KiB with the header. */
function buildDirectories(entries) {
  const root = serializeDirectory(entries);
  if (root.length <= 16_384 - HEADER_LEN) return { root, leaves: Buffer.alloc(0) };
  for (let per = 4096; ; per *= 2) {
    const leafBufs = [], rootEntries = [];
    let off = 0;
    for (let i = 0; i < entries.length; i += per) {
      const b = serializeDirectory(entries.slice(i, i + per));
      rootEntries.push({ tileId: entries[i].tileId, offset: off, length: b.length, runLength: 0 });
      leafBufs.push(b); off += b.length;
    }
    const r = serializeDirectory(rootEntries);
    if (r.length <= 16_384 - HEADER_LEN) return { root: r, leaves: Buffer.concat(leafBufs) };
  }
}

/** Runs fn over items with at most `limit` calls in flight; results keep the order of items. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await fn(items[i]);
    await worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Every tile id in bbox [w, s, e, n] from zoom 0 to maxzoom, ascending. */
function tileIds(bbox, maxzoom) {
  const ids = [];
  for (let z = 0; z <= maxzoom; z++) {
    const x0 = lonToX(bbox[0], z), x1 = lonToX(bbox[2], z), y0 = latToY(bbox[3], z), y1 = latToY(bbox[1], z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) ids.push(zxyToTileId(z, x, y));
    }
  }
  return ids.sort((a, b) => a - b);
}

/** Files tile id under found when entry e is the tile, or under the leaf directory e points to. */
function sortId(e, id, found, leafWant) {
  if (!e) return;
  if (e.runLength > 0) {
    found.push({ tileId: id, offset: e.offset, length: e.length });
    return;
  }
  if (!leafWant.has(e.offset)) leafWant.set(e.offset, { entry: e, ids: [] });
  leafWant.get(e.offset).ids.push(id);
}

/**
 * Finds where each tile id lives in a remote archive. found receives { tileId, offset, length } (source data
 * space) for each tile; ids that sit in leaf directories are followed down, fetching each needed leaf once.
 */
async function locateTiles(src, pending, found, depth = 0) {
  if (depth >= 4 || !pending.length) return found;
  const leafWant = new Map(); // leaf offset -> { entry, ids }
  for (const { entries, ids } of pending) {
    for (const id of ids) sortId(findEntry(entries, id), id, found, leafWant);
  }
  const leaves = [...leafWant.values()].sort((a, b) => a.entry.offset - b.entry.offset);
  const chunks = chunkRanges(leaves.map((w) => ({ offset: w.entry.offset, length: w.entry.length, w })));
  const ic = src.header.internalCompression;
  const dirs = await mapLimit(chunks, 4, async (c) => {
    const buf = await src.range(src.header.leafOffset + c.offset, c.length);
    return c.items.map((it) => ({ entries: parseDirectory(decompress(buf.subarray(it.offset - c.offset, it.offset - c.offset + it.length), ic)), ids: it.w.ids }));
  });
  return locateTiles(src, dirs.flat(), found, depth + 1);
}

/**
 * Copies the tile contents into fh, back to back in source order, and returns the bytes written. Each
 * content's position in the file (content.out) is known up front, so 4 chunks are fetched and written at once.
 */
async function copyContents(src, contents, fh, onBytes) {
  let out = 0;
  for (const c of contents) { c.out = out; out += c.length; }
  await mapLimit(chunkRanges(contents, 32 * 1024, 4 * 1024 * 1024), 4, async (chunk) => {
    const buf = await src.range(src.header.dataOffset + chunk.offset, chunk.length);
    await Promise.all(chunk.items.map((it) => fh.write(buf, it.offset - chunk.offset, it.length, it.out)));
    onBytes(chunk.items.reduce((s, it) => s + it.length, 0));
  });
  return out;
}

/** Directory entries for the copied tiles, merging runs of consecutive ids that share one content. */
function outputEntries(found, unique) {
  const entries = [];
  for (const f of found.toSorted((a, b) => a.tileId - b.tileId)) {
    const c = unique.get(f.offset), last = entries.at(-1);
    if (last && last.offset === c.out && f.tileId === last.tileId + last.runLength) last.runLength++;
    else entries.push({ tileId: f.tileId, offset: c.out, length: c.length, runLength: 1 });
  }
  return entries;
}

function writeHeader(h) {
  const b = Buffer.alloc(HEADER_LEN);
  b.write('PMTiles', 0, 'latin1'); b[7] = 3;
  const u64 = (o, v) => b.writeBigUInt64LE(BigInt(v), o);
  u64(8, h.rootOffset); u64(16, h.rootLength); u64(24, h.metaOffset); u64(32, h.metaLength);
  u64(40, h.leafOffset); u64(48, h.leafLength); u64(56, h.dataOffset); u64(64, h.dataLength);
  u64(72, h.addressed); u64(80, h.entries); u64(88, h.contents);
  b[96] = 1; b[97] = 2; b[98] = h.tileCompression; b[99] = h.tileType; b[100] = 0; b[101] = h.maxZoom;
  const e7 = (o, v) => b.writeInt32LE(Math.round(v * 1e7), o);
  e7(102, h.bounds[0]); e7(106, h.bounds[1]); e7(110, h.bounds[2]); e7(114, h.bounds[3]);
  b[118] = h.centerZoom; e7(119, h.center[0]); e7(123, h.center[1]);
  return b;
}

// ---------- public API ----------

export class Maps {
  constructor(dir) {
    this.dir = dir;
    this.archives = new Map(); // file name -> Archive
    this.job = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Re-scan the folder, opening new or changed archives. Most detailed first. */
  async scan() {
    let names = [];
    try { names = (await fsp.readdir(this.dir)).filter((n) => n.toLowerCase().endsWith('.pmtiles') && !n.startsWith('.')); } catch { /* no folder */ }
    // Close archives whose file was removed or replaced.
    await Promise.all([...this.archives].map(async ([name, a]) => {
      const st = await fsp.stat(path.join(this.dir, name)).catch(() => null);
      if (!st || st.mtimeMs !== a.mtimeMs || st.size !== a.size) { await a.close(); this.archives.delete(name); }
    }));
    const added = names.filter((name) => !this.archives.has(name));
    const opened = await Promise.all(added.map((name) => new Archive(path.join(this.dir, name)).open().catch((error) => unreadable(name, error))));
    added.forEach((name, i) => this.archives.set(name, opened[i]));
    return this.list();
  }

  list() {
    return [...this.archives.values()].map((a) => a.info())
      .sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.maxZoom - a.maxZoom || area(a.bounds) - area(b.bounds));
  }

  /** First archive holding the tile wins; result says how the bytes are compressed. */
  async tile(z, x, y) {
    if (!this.archives.size) await this.scan();
    const usable = this.list().map((info) => this.archives.get(info.file)).filter((a) => a && !a.error);
    return firstTile(usable, z, x, y);
  }

  async remove(file) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.pmtiles$/.test(file)) throw Object.assign(new Error('bad file name'), { status: 400 });
    const a = this.archives.get(file);
    if (a) { await a.close(); this.archives.delete(file); }
    await fsp.rm(path.join(this.dir, file), { force: true });
  }

  /** The current or last download, without its abort controller. */
  status() {
    if (!this.job) return null;
    const j = { ...this.job };
    delete j.controller;
    return j;
  }

  cancel() { if (this.job?.state === 'running') this.job.controller.abort(); }

  /** Start downloading bbox [w, s, e, n] from zoom 0 to maxzoom into <name>.pmtiles. */
  download({ bbox, maxzoom, name }) {
    if (this.job?.state === 'running') throw Object.assign(new Error('a download is already running'), { status: 409 });
    if (!validArea(bbox)) throw Object.assign(new Error('invalid area'), { status: 400 });
    maxzoom = Math.round(+maxzoom);
    if (!(maxzoom >= 6 && maxzoom <= 15)) throw Object.assign(new Error('detail must be zoom 6 to 15'), { status: 400 });
    const tiles = countTiles(bbox, maxzoom);
    if (tiles > MAX_TILES) throw Object.assign(new Error(`area too large (${tiles} tiles, limit ${MAX_TILES}): pick a smaller area or lower detail`), { status: 400 });
    const controller = new AbortController();
    const job = { state: 'running', phase: 'connecting', file: `${fileSlug(name)}.pmtiles`, bbox, maxzoom, tiles, bytes: 0, total: 0, started: Date.now(), controller };
    this.job = job;
    this.#run(job, controller.signal).then(
      () => { job.state = 'done'; job.phase = 'done'; },
      (error) => {
        job.state = controller.signal.aborted ? 'cancelled' : 'error';
        job.error = downloadError(error, controller.signal.aborted);
      },
    );
    return this.status();
  }

  async #run(job, signal) {
    const url = await sourceUrl(signal);
    job.source = url;
    const head = await fetchRange(url, 0, 16_384, signal);
    const h = parseHeader(head);
    if (!h.clustered) throw new Error('source archive is not clustered');
    const src = { header: h, range: (offset, length) => fetchRange(url, offset, length, signal) };
    const metaRaw = h.metaLength ? decompress(await src.range(h.metaOffset, h.metaLength), h.internalCompression) : Buffer.from('{}');

    job.phase = 'indexing';
    const rootRaw = h.rootOffset + h.rootLength <= head.length ? head.subarray(h.rootOffset, h.rootOffset + h.rootLength) : await src.range(h.rootOffset, h.rootLength);
    const root = parseDirectory(decompress(rootRaw, h.internalCompression));
    const found = await locateTiles(src, [{ entries: root, ids: tileIds(job.bbox, job.maxzoom) }], []);
    if (!found.length) throw new Error('no tiles found for this area');

    // Unique tile contents, in source order (the source is clustered, so the output stays clustered).
    const unique = new Map();
    for (const f of found) if (!unique.has(f.offset)) unique.set(f.offset, { offset: f.offset, length: f.length, out: 0 });
    const contents = [...unique.values()].sort((a, b) => a.offset - b.offset);
    job.total = contents.reduce((s, c) => s + c.length, 0);
    job.phase = 'downloading';

    const tmpData = path.join(this.dir, `.${job.file}.data`);
    const tmpOut = path.join(this.dir, `.${job.file}.part`);
    const fh = await fsp.open(tmpData, 'w');
    try {
      const dataLength = await copyContents(src, contents, fh, (n) => { job.bytes += n; });
      await fh.close();
      job.phase = 'writing';
      await writeArchive(tmpOut, tmpData, {
        entries: outputEntries(found, unique), contents: contents.length, dataLength, meta: archiveMeta(metaRaw, job.file, url),
        tileCompression: h.tileCompression, tileType: h.tileType, maxZoom: job.maxzoom, bbox: job.bbox,
      });
      const final = path.join(this.dir, job.file);
      const old = this.archives.get(job.file);
      if (old) { await old.close(); this.archives.delete(job.file); }
      await fsp.rename(tmpOut, final);
      job.size = (await fsp.stat(final)).size;
    } finally {
      await fh.close().catch(() => {});
      await fsp.rm(tmpData, { force: true });
      await fsp.rm(tmpOut, { force: true });
      await this.scan().catch(() => {});
    }
  }
}

const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);

/** Stand-in for an archive that could not be opened, so the listing can say why. */
const unreadable = (name, error) => ({ error: error.message, info: () => ({ file: name, error: error.message }), close() {} });

/** Tile bytes from the first archive in the list that has them. */
async function firstTile([a, ...rest], z, x, y) {
  if (!a) return null;
  const data = await Promise.resolve(a.tile(z, x, y)).catch(() => null);
  if (data?.length) return { data, compression: a.header.tileCompression };
  return firstTile(rest, z, x, y);
}

const validArea = (bbox) => Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
  && bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -85.06 && bbox[3] <= 85.06 && bbox[0] < bbox[2] && bbox[1] < bbox[3];

/** File name for a download: the name in lower case, a-z 0-9 and dashes, or a generated one. */
function fileSlug(name) {
  // Runs of other characters become one dash, so trimming a single dash at each end is enough.
  const slug = String(name || '').slice(0, 80).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 40);
  return slug || `area-${Date.now().toString(36)}`;
}

function downloadError(error, aborted) {
  if (aborted) return 'cancelled';
  const offline = error.message === 'fetch failed' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(error.cause?.code || ''));
  return offline ? 'cannot reach the map server: is there an internet link?' : error.message;
}

/** The source archive's metadata, renamed for the downloaded area. */
function archiveMeta(raw, file, source) {
  let meta = {};
  try { meta = JSON.parse(raw.toString('utf8')); } catch { /* keep empty */ }
  meta.name = file.replace(/\.pmtiles$/, '');
  meta['shelter:source'] = source;
  return meta;
}

/** Writes header, directories and metadata to out, then appends the tile data from dataFile. */
async function writeArchive(out, dataFile, { entries, contents, dataLength, meta, tileCompression, tileType, maxZoom, bbox }) {
  const { root, leaves } = buildDirectories(entries);
  const metaBuf = zlib.gzipSync(Buffer.from(JSON.stringify(meta)));
  const [w, s, e, n] = bbox;
  const hdr = {
    rootOffset: HEADER_LEN, rootLength: root.length,
    metaOffset: HEADER_LEN + root.length, metaLength: metaBuf.length,
    leafOffset: HEADER_LEN + root.length + metaBuf.length, leafLength: leaves.length,
    dataOffset: HEADER_LEN + root.length + metaBuf.length + leaves.length, dataLength,
    addressed: entries.reduce((t, x) => t + x.runLength, 0), entries: entries.length, contents,
    tileCompression, tileType, maxZoom,
    bounds: [w, s, e, n], center: [(w + e) / 2, (s + n) / 2], centerZoom: Math.min(maxZoom, 12),
  };
  await fsp.writeFile(out, Buffer.concat([writeHeader(hdr), root, metaBuf, leaves]));
  await new Promise((ok, fail) => {
    const ws = fs.createWriteStream(out, { flags: 'a' });
    fs.createReadStream(dataFile).on('error', fail).pipe(ws).on('finish', ok).on('error', fail);
  });
}

export const compressionName = (c) => COMPRESSION[c] || 'unknown';
export { decompress };
