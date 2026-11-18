// Shared test helpers: temporary folders, a tiny HTTP server, and writers for the binary formats
// Shelter reads (Mapbox Vector Tiles and PMTiles v3), so tests need no real map data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

/** A fresh temporary folder, removed when the test ends. */
export function tmpDir(t, prefix = 'shelter-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Starts an HTTP server on a free loopback port. Returns its base URL; closed when the test ends. */
export async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Serves one buffer with HTTP range support, counting requests. */
export async function serveRanges(t, buf) {
  const stats = { requests: 0 };
  const url = await serve(t, (req, res) => {
    stats.requests++;
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-length': buf.length }); res.end(buf); return; }
    const a = +m[1], b = Math.min(+m[2], buf.length - 1);
    res.writeHead(206, { 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${buf.length}` });
    res.end(buf.subarray(a, b + 1));
  });
  return { url: `${url}/planet.pmtiles`, stats };
}

// ---------- protobuf / Mapbox Vector Tile writer ----------

function varint(out, v) {
  while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const key = (field, wire) => field * 8 + wire;

function lenField(out, field, bytes) { varint(out, key(field, 2)); varint(out, bytes.length); out.push(...bytes); }
const strBytes = (s) => [...Buffer.from(s, 'utf8')];
function packed(out, field, values) {
  const b = [];
  for (const v of values) varint(b, v);
  lenField(out, field, b);
}

/** Geometry commands for rings of [x, y] points: type 1 point(s), 2 line(s), 3 polygon(s). */
function geometry(type, rings) {
  const cmds = [];
  let cx = 0, cy = 0;
  const moveTo = (pts) => {
    cmds.push(((pts.length) << 3) | 1);
    for (const [x, y] of pts) { cmds.push(zig(x - cx), zig(y - cy)); cx = x; cy = y; }
  };
  if (type === 1) { moveTo(rings.map((r) => r[0])); return cmds; }
  for (const ring of rings) {
    moveTo([ring[0]]);
    const rest = ring.slice(1);
    cmds.push((rest.length << 3) | 2);
    for (const [x, y] of rest) { cmds.push(zig(x - cx), zig(y - cy)); cx = x; cy = y; }
    if (type === 3) cmds.push((1 << 3) | 7);
  }
  return cmds;
}

function value(v) {
  const out = [];
  if (typeof v === 'string') lenField(out, 1, strBytes(v));
  else if (typeof v === 'boolean') { varint(out, key(7, 0)); varint(out, v ? 1 : 0); }
  else if (Number.isInteger(v) && v >= 0) { varint(out, key(5, 0)); varint(out, v); }
  else if (Number.isInteger(v)) { varint(out, key(6, 0)); varint(out, zig(v)); }
  else { varint(out, key(3, 1)); const b = Buffer.alloc(8); b.writeDoubleLE(v); out.push(...b); }
  return out;
}

/**
 * Encodes { layerName: [{ type, props, rings }] } as a vector tile (extent 4096).
 * rings: arrays of [x, y] points; a point feature is [[[x, y]], ...].
 */
export function encodeTile(layers, extent = 4096) {
  const tile = [];
  for (const [name, features] of Object.entries(layers)) lenField(tile, 3, encodeLayer(name, features, extent));
  return Uint8Array.from(tile);
}

/** Index of item in list (compared as JSON), appending it when new. */
function indexIn(list, item) {
  const enc = JSON.stringify(item);
  const i = list.findIndex((x) => JSON.stringify(x) === enc);
  if (i >= 0) return i;
  list.push(item);
  return list.length - 1;
}

function encodeLayer(name, features, extent) {
  const keys = [], values = [], layer = [];
  varint(layer, key(15, 0)); varint(layer, 2); // version
  lenField(layer, 1, strBytes(name));
  for (const f of features) {
    const tags = Object.entries(f.props || {}).flatMap(([k, v]) => [indexIn(keys, k), indexIn(values, value(v))]);
    const feat = [];
    packed(feat, 2, tags);
    varint(feat, key(3, 0)); varint(feat, f.type);
    packed(feat, 4, geometry(f.type, f.rings));
    lenField(layer, 2, feat);
  }
  for (const k of keys) lenField(layer, 3, strBytes(k));
  for (const v of values) lenField(layer, 4, v);
  varint(layer, key(5, 0)); varint(layer, extent);
  return layer;
}

// ---------- PMTiles v3 writer (single root directory, clustered) ----------

/** PMTiles tile id for z/x/y (Hilbert curve per zoom level), as in the spec. */
export function tileId(z, x, y) {
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

function directory(entries) {
  const out = [];
  varint(out, entries.length);
  let last = 0;
  for (const e of entries) { varint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) varint(out, e.runLength);
  for (const e of entries) varint(out, e.length);
  entries.forEach((e, i) => {
    const p = entries[i - 1];
    varint(out, i > 0 && e.offset === p.offset + p.length ? 0 : e.offset + 1);
  });
  return zlib.gzipSync(Buffer.from(out));
}

/**
 * A PMTiles v3 archive holding tiles { 'z/x/y': Buffer } (stored as given; tileCompression says how
 * they are compressed: 1 none, 2 gzip). Identical tile contents are stored once.
 */
export function makeArchive(tiles, { tileCompression = 2, minZoom = 0, maxZoom = 14, bounds = [-180, -85, 180, 85], meta = { name: 'fixture' } } = {}) {
  const items = Object.entries(tiles).map(([zxy, data]) => { const [z, x, y] = zxy.split('/').map(Number); return { tileId: tileId(z, x, y), data }; })
    .sort((a, b) => a.tileId - b.tileId);
  const blobs = new Map(), parts = [];
  let off = 0;
  const entries = [];
  for (const it of items) {
    const k = it.data.toString('base64');
    if (!blobs.has(k)) { blobs.set(k, { offset: off, length: it.data.length }); parts.push(it.data); off += it.data.length; }
    const b = blobs.get(k), last = entries.at(-1);
    if (last && last.offset === b.offset && it.tileId === last.tileId + last.runLength) last.runLength++;
    else entries.push({ tileId: it.tileId, offset: b.offset, length: b.length, runLength: 1 });
  }
  const root = directory(entries);
  const metaBuf = zlib.gzipSync(Buffer.from(JSON.stringify(meta)));
  const data = Buffer.concat(parts);
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'latin1'); h[7] = 3;
  const u64 = (o, v) => h.writeBigUInt64LE(BigInt(v), o);
  const rootOffset = 127, metaOffset = rootOffset + root.length, leafOffset = metaOffset + metaBuf.length, dataOffset = leafOffset;
  u64(8, rootOffset); u64(16, root.length); u64(24, metaOffset); u64(32, metaBuf.length);
  u64(40, leafOffset); u64(48, 0); u64(56, dataOffset); u64(64, data.length);
  u64(72, items.length); u64(80, entries.length); u64(88, blobs.size);
  h[96] = 1; h[97] = 2; h[98] = tileCompression; h[99] = 1; h[100] = minZoom; h[101] = maxZoom;
  const e7 = (o, v) => h.writeInt32LE(Math.round(v * 1e7), o);
  e7(102, bounds[0]); e7(106, bounds[1]); e7(110, bounds[2]); e7(114, bounds[3]);
  h[118] = Math.min(maxZoom, 12); e7(119, (bounds[0] + bounds[2]) / 2); e7(123, (bounds[1] + bounds[3]) / 2);
  return Buffer.concat([h, root, metaBuf, data]);
}

/** Records every call and property write on a 2D canvas context, for drawing tests. */
export function recordingContext() {
  const calls = [];
  const target = { measureText: (s) => ({ width: String(s).length * 6 }) };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => { calls.push([k, ...args]); };
    },
    set(t, k, v) { calls.push([`=${String(k)}`, v]); t[k] = v; return true; },
  });
  return { ctx, calls };
}

/** Minimal Path2D stand-in for Node: records moveTo/lineTo/closePath. */
export class FakePath2D {
  constructor() { this.ops = []; }
  moveTo(x, y) { this.ops.push(['M', x, y]); }
  lineTo(x, y) { this.ops.push(['L', x, y]); }
  closePath() { this.ops.push(['Z']); }
}
