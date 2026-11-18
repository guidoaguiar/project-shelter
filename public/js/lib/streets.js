// Street-level layer for the map: fetches vector tiles from the node (/api/maps/tile/z/x/y),
// decodes them and draws roads, paths, water, green areas, buildings and labels on a canvas.
// World units are "mercator degrees": X = longitude, Y = mercY(latitude); both span -180..180.
import { decodeTile } from './mvt.js';

export const MAX_LAT = 85.0511;
export const mercY = (lat) => {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return Math.log(Math.tan(Math.PI / 4 + l * Math.PI / 360)) * 180 / Math.PI;
};
export const invMercY = (y) => Math.atan(Math.exp(y * Math.PI / 180)) * 360 / Math.PI - 90;

/** Tiles covering bbox [w, s, e, n] from zoom 0 to maxzoom (same count the server enforces). */
export function countTiles([w, s, e, n], maxzoom) {
  let total = 0;
  for (let z = 0; z <= maxzoom; z++) {
    const k = 2 ** z, tx = (lon) => Math.min(k - 1, Math.max(0, Math.floor((lon + 180) / 360 * k)));
    const ty = (lat) => Math.min(k - 1, Math.max(0, Math.floor((180 - mercY(lat)) / 360 * k)));
    total += (tx(e) - tx(w) + 1) * (ty(s) - ty(n) + 1);
  }
  return total;
}

// Draw order, bottom to top. w = line width in px at zoom 15 (scaled with zoom).
const STYLE = [
  { id: 'earth', fill: '--land' },
  { id: 'green', fill: '--green' },
  { id: 'water', fill: '--water' },
  { id: 'building', fill: '--building' },
  { id: 'stream', stroke: '--water-line', w: 1 },
  { id: 'river', stroke: '--water-line', w: 2.2 },
  { id: 'boundary2', stroke: '--faint', w: 0.8, dash: [4, 3] },
  { id: 'boundary', stroke: '--dim', w: 1.3, dash: [8, 4] },
  { id: 'tunnel', stroke: '--road-lo', w: 1.4, dash: [4, 3] },
  { id: 'ferry', stroke: '--water-line', w: 1, dash: [3, 4] },
  { id: 'rail', stroke: '--rail', w: 1.4, dash: [6, 3] },
  { id: 'path', stroke: '--path', w: 1.1, dash: [3, 2] },
  { id: 'track', stroke: '--path', w: 1.5, dash: [8, 3] },
  { id: 'service', stroke: '--road-lo', w: 1.2 },
  { id: 'street', stroke: '--road', w: 1.8, casing: 1.2 },
  { id: 'major', stroke: '--road-hi', w: 2.8, casing: 1.6 },
  { id: 'highway', stroke: '--road-hi', w: 3.8, casing: 2 },
];

const GREEN = new Set(['park', 'forest', 'wood', 'nature_reserve', 'national_park', 'grass', 'meadow', 'scrub', 'garden', 'golf_course', 'recreation_ground', 'grassland', 'wetland', 'orchard', 'village_green', 'cemetery']);
const BIG_WATER = new Set(['river', 'canal']);
// Points of interest worth finding without a link, with the zoom they appear from:
// water, medical, fuel, help and shelter early; everyday places only when zoomed right in.
export const POI = {
  drinking_water: ['WATER', 13.5], water_point: ['WATER', 13.5], spring: ['SPRING', 13.5],
  hospital: ['HOSPITAL', 12.5], clinic: ['CLINIC', 14], doctors: ['DOCTOR', 14.5], pharmacy: ['PHARMACY', 14.5],
  fuel: ['FUEL', 13.5], police: ['POLICE', 14], fire_station: ['FIRE STN', 14], defibrillator: ['AED', 15.5],
  shelter: ['SHELTER', 14], alpine_hut: ['HUT', 13], wilderness_hut: ['HUT', 13], camp_site: ['CAMP', 13.5], ranger_station: ['RANGER', 14],
  peak: ['PEAK', 12.5], saddle: ['PASS', 13.5],
  toilets: ['WC', 15.5], townhall: ['TOWN HALL', 15], supermarket: ['MARKET', 16],
};

// Road kinds that map straight to a style bucket, whatever their detail.
const ROAD_KIND = new Map([['highway', 'highway'], ['major_road', 'major'], ['rail', 'rail'], ['ferry', 'ferry'], ['other', 'service'], ['aeroway', 'service']]);
const ROAD_RANK = { highway: 5, major: 6, street: 8, service: 9, track: 9, path: 10 };

function pathBucket(detail) {
  if (detail === 'sidewalk' || detail === 'crossing') return null; // drawn alongside the street they belong to
  return detail === 'pier' || detail === 'pedestrian' ? 'service' : 'path';
}

/** Style bucket for a road feature's properties, or null to skip it. */
export function roadBucket(p) {
  const k = p.kind, d = p.kind_detail;
  if (p.is_tunnel) return k === 'rail' ? null : 'tunnel';
  if (d === 'track' || d === 'bridleway') return 'track';
  if (k === 'minor_road') return d === 'service' ? 'service' : 'street';
  if (k === 'path') return pathBucket(d);
  return ROAD_KIND.get(k) ?? null;
}

function waterBucket(f) {
  if (f.type === 3) return f.props.kind === 'ocean' ? null : 'water';
  if (f.type === 2) return BIG_WATER.has(f.props.kind_detail || f.props.kind) ? 'river' : 'stream';
  return null;
}

/** Longest segment of a line feature: where its name label goes. */
function longestSegment(rings) {
  let best = null;
  for (const r of rings) {
    for (let i = 2; i < r.length; i += 2) {
      const dx = r[i] - r[i - 2], dy = r[i + 1] - r[i - 1], len = Math.hypot(dx, dy);
      if (!best || len > best.len) best = { len, x: (r[i] + r[i - 2]) / 2, y: (r[i + 1] + r[i - 1]) / 2, a: Math.atan2(dy, dx) };
    }
  }
  return best;
}

/** Keeps text upright: angles are folded into -90°..90°. */
function upright(a) {
  if (a > Math.PI / 2) return a - Math.PI;
  if (a < -Math.PI / 2) return a + Math.PI;
  return a;
}

function waterLabel(f) {
  const named = f.props.name && (f.type === 1 || (f.type === 3 && f.props.kind === 'lake'));
  if (!named) return null;
  const at = f.type === 1 ? f.rings[0] : f.rings[0].slice(0, 2);
  return at ? { kind: 'water', text: f.props.name, x: at[0], y: at[1], rank: 2, minz: f.props.min_zoom || 0 } : null;
}

function roadLabel(f, bucket) {
  const name = f.props.name || f.props.ref;
  const best = name && longestSegment(f.rings);
  if (!best) return null;
  return { kind: 'road', text: name, x: best.x, y: best.y, a: upright(best.a), len: best.len, rank: ROAD_RANK[bucket] ?? 10, minz: f.props.min_zoom || 0 };
}

function placeLabel(f) {
  const at = f.rings[0], p = f.props;
  if (f.type !== 1 || !at || !p.name) return null;
  const big = p.kind === 'country' || p.kind === 'region';
  const pop = p.population_rank || 0;
  const rank = big ? 0 : 1 + Math.max(0, 15 - pop) / 20;
  return { kind: 'place', text: p.name, x: at[0], y: at[1], rank, minz: p.min_zoom || 0, size: p.kind === 'locality' && pop >= 9 ? 12 : 10 };
}

function poiLabel(f) {
  const def = POI[f.props.kind], at = f.rings[0];
  if (f.type !== 1 || !def || !at) return null;
  const [tag, minz] = def;
  const ele = f.props.elevation ? ` ${Math.round(f.props.elevation)}m` : '';
  return { kind: 'poi', text: (f.props.name || tag) + ele, tag, x: at[0], y: at[1], rank: 2 + minz / 10, minz };
}

function addToPath(paths, id, f) {
  paths[id] ??= new Path2D();
  const p = paths[id];
  for (const r of f.rings) {
    p.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]);
    if (f.type === 3) p.closePath();
  }
}

/** Turn decoded layers into Path2D buckets (tile units) and label candidates. */
export function build(layers) {
  const paths = {};
  const labels = [];
  const add = (id, f) => { if (id) addToPath(paths, id, f); };
  const label = (l) => { if (l) labels.push(l); };
  const L = (n) => layers[n]?.features || [];
  const polygons = (n) => L(n).filter((f) => f.type === 3);
  const lines = (n) => L(n).filter((f) => f.type === 2);
  const road = (f) => {
    const b = roadBucket(f.props);
    if (b) { add(b, f); label(roadLabel(f, b)); }
  };

  for (const f of polygons('earth')) add('earth', f);
  for (const f of [...polygons('landcover'), ...polygons('landuse')].filter((g) => GREEN.has(g.props.kind))) add('green', f);
  for (const f of L('water')) { add(waterBucket(f), f); label(waterLabel(f)); }
  for (const f of polygons('buildings')) add('building', f);
  for (const f of lines('boundaries')) add(f.props.kind === 'country' ? 'boundary' : 'boundary2', f);
  lines('roads').forEach(road);
  for (const f of L('places')) label(placeLabel(f));
  for (const f of L('pois')) label(poiLabel(f));
  labels.sort((a, b) => a.rank - b.rank);
  return { paths, labels, extent: layers.roads?.extent || layers.earth?.extent || 4096 };
}

export class StreetLayer {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.archives = [];
    this.cache = new Map(); // "z/x/y" -> { state, tile }
    this.queue = [];
    this.active = 0;
    this.wanted = new Set();
    this.drawn = false;
  }

  setArchives(list) {
    this.archives = (list || []).filter((a) => !a.error && Array.isArray(a.bounds));
    this.cache.clear();
    this.maxZoom = this.archives.reduce((m, a) => Math.max(m, a.maxZoom), -1);
  }

  get enabled() { return this.archives.length > 0; }

  /** Does any archive hold this tile (bounds overlap and zoom in range)? */
  covers(z, x, y) {
    const n = 2 ** z;
    const w = x / n * 360 - 180, e = (x + 1) / n * 360 - 180;
    const nLat = invMercY(180 - y / n * 360), sLat = invMercY(180 - (y + 1) / n * 360);
    return this.archives.some((a) => z >= a.minZoom && z <= a.maxZoom
      && w <= a.bounds[2] && e >= a.bounds[0] && sLat <= a.bounds[3] && nLat >= a.bounds[1]);
  }

  #get(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let c = this.cache.get(key);
    if (!c) {
      c = this.covers(z, x, y) ? { state: 'queued', z, x, y, key } : { state: 'empty' };
      this.cache.set(key, c);
      if (c.state === 'queued') this.queue.push(c);
    } else { this.cache.delete(key); this.cache.set(key, c); } // LRU touch
    return c;
  }

  #pump() {
    while (this.active < 6 && this.queue.length) {
      const c = this.queue.pop(); // newest first: what is on screen now
      if (c.state !== 'queued') continue;
      if (!this.wanted.has(c.key)) {
        this.cache.delete(c.key);
        continue;
      }
      c.state = 'loading';
      this.active++;
      fetch(`/api/maps/tile/${c.z}/${c.x}/${c.y}`)
        .then(async (r) => {
          if (r.status === 204) { c.state = 'empty'; return; }
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          c.tile = build(decodeTile(new Uint8Array(await r.arrayBuffer())));
          c.state = 'ready';
        })
        .catch(() => { c.state = 'error'; })
        .finally(() => { this.active--; this.#trim(); this.onUpdate(); this.#pump(); });
    }
  }

  #trim() {
    for (const [k, c] of this.cache) {
      if (this.cache.size <= 400) break;
      if (!this.wanted.has(k) && c.state !== 'loading') this.cache.delete(k);
    }
  }

  /** Nearest loaded tile at or above (z, x, y), queueing what is missing. */
  #resolve(z, x, y) {
    this.wanted.add(`${z}/${x}/${y}`);
    const c0 = this.#get(z, x, y);
    if (c0.state === 'ready') return { c: c0, z, x, y };
    // Stand-in while loading, or for good where this zoom has no tile: the nearest loaded ancestor.
    // A parent is only fetched when the level below it is known to be missing.
    let needParent = c0.state === 'empty' || c0.state === 'error';
    for (let d = 1; d <= z; d++) {
      const key = `${z - d}/${x >> d}/${y >> d}`;
      let c = this.cache.get(key);
      if (!c && needParent) { c = this.#get(z - d, x >> d, y >> d); this.wanted.add(key); }
      if (c && (c.state === 'queued' || c.state === 'loading')) this.wanted.add(key);
      if (c?.state === 'ready') return { c, z: z - d, x: x >> d, y: y >> d };
      needParent = c ? c.state === 'empty' || c.state === 'error' : false;
    }
    return null;
  }

  /**
   * Draw tiles. cam: { W, H, dpr, scale (px per mercator degree), cx, cy (centre in mercator degrees) }.
   * color(name) reads a CSS variable. Returns true if any tile was drawn.
   */
  draw(ctx, cam, color) {
    this.drawn = false;
    if (!this.enabled) return false;
    const zf = Math.log2(cam.scale * 360 / 256);
    const z = Math.max(0, Math.min(this.maxZoom, Math.round(zf)));
    this.wanted = new Set();
    const jobs = this.#jobs(z, visibleTiles(cam, z));
    this.#pump();
    if (!jobs.length) return false;

    const colors = Object.fromEntries([...STYLE.map((s) => s.fill || s.stroke), '--bg', '--text', '--dim', '--accent'].map((v) => [v, color(v)]));
    const style = { colors, zf, lw: Math.max(0.45, Math.min(2.4, 2 ** ((zf - 15) * 0.5))) };

    // Coarse stand-ins first, so exact tiles paint over them.
    jobs.sort((a, b) => a.z - b.z);
    const labels = [];
    for (const j of jobs) {
      const o = tileScreen(cam, j.z, j.x, j.y), cl = tileScreen(cam, j.clip.z, j.clip.x, j.clip.y);
      const k = o.px / j.c.tile.extent;
      paintTile(ctx, cam, j.c.tile, o, cl, k, style);
      if (j.z >= z - 1) labels.push(...tileLabels(j.c.tile, o, cl, k, zf));
    }
    ctx.setLineDash([]);
    drawLabels(ctx, cam, labels, colors, zf);
    this.drawn = true;
    return true;
  }

  /** Resolve every visible tile at zoom z to what can be drawn for it now. */
  #jobs(z, { x0, x1, y0, y1 }) {
    const jobs = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const r = this.#resolve(z, x, y);
        if (r) jobs.push({ ...r, clip: { z, x, y } });
      }
    }
    return jobs;
  }
}

/** Tile index range covering the camera view at zoom z. */
function visibleTiles(cam, z) {
  const n = 2 ** z, size = 360 / n;
  const left = cam.cx - cam.W / 2 / cam.scale, right = cam.cx + cam.W / 2 / cam.scale;
  const top = cam.cy + cam.H / 2 / cam.scale, bottom = cam.cy - cam.H / 2 / cam.scale;
  return {
    x0: Math.max(0, Math.floor((left + 180) / size)), x1: Math.min(n - 1, Math.floor((right + 180) / size)),
    y0: Math.max(0, Math.floor((180 - top) / size)), y1: Math.min(n - 1, Math.floor((180 - bottom) / size)),
  };
}

/** Screen position (sx, sy) and size in px of tile (tz, tx, ty). */
function tileScreen(cam, tz, tx, ty) {
  const s = 360 / 2 ** tz;
  return { sx: cam.W / 2 + (tx * s - 180 - cam.cx) * cam.scale, sy: cam.H / 2 - (180 - ty * s - cam.cy) * cam.scale, px: s * cam.scale };
}

/** Paint one tile's paths, clipped to the screen square cl. o is the tile's own square, k tile units to px. */
function paintTile(ctx, cam, tile, o, cl, k, { colors, zf, lw }) {
  ctx.save();
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
  ctx.beginPath(); ctx.rect(cl.sx, cl.sy, cl.px, cl.px); ctx.clip();
  ctx.fillStyle = colors['--bg']; ctx.fillRect(cl.sx, cl.sy, cl.px, cl.px);
  ctx.setTransform(cam.dpr * k, 0, 0, cam.dpr * k, cam.dpr * o.sx, cam.dpr * o.sy);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of STYLE) {
    const p = tile.paths[s.id];
    if (!p || (s.id === 'building' && zf < 13.5)) continue;
    if (s.fill) { ctx.fillStyle = colors[s.fill]; ctx.fill(p); continue; }
    const w = s.w * lw;
    if (s.casing && zf >= 12) {
      ctx.setLineDash([]); ctx.strokeStyle = colors['--bg']; ctx.lineWidth = (w + s.casing * lw) / k; ctx.stroke(p);
    }
    ctx.setLineDash(s.dash ? s.dash.map((v) => v * Math.max(1, lw) / k) : []);
    ctx.strokeStyle = colors[s.stroke]; ctx.lineWidth = w / k; ctx.stroke(p);
  }
  ctx.restore();
}

/** A tile's labels in screen px, keeping only those inside its clip square (each label is owned by one tile). */
function tileLabels(tile, o, cl, k, zf) {
  const out = [];
  for (const l of tile.labels) {
    if (zf + 0.5 < l.minz) continue;
    const x = o.sx + l.x * k, y = o.sy + l.y * k;
    if (x < cl.sx || x >= cl.sx + cl.px || y < cl.sy || y >= cl.sy + cl.px) continue;
    out.push({ ...l, x, y, plen: l.len ? l.len * k : 0 });
  }
  return out;
}

const FONT = 'ui-monospace, Consolas, monospace';

function pointFont(l) {
  if (l.kind === 'place') return `600 ${l.size || 10}px ${FONT}`;
  if (l.kind === 'water') return `italic 10px ${FONT}`;
  return `10px ${FONT}`;
}

function pointColor(l, colors) {
  if (l.kind === 'water') return colors['--water-line'] || colors['--dim'];
  if (l.kind === 'poi') return colors['--accent'];
  return colors['--text'];
}

/** Place labels by rank, skipping any that overlap one already placed or repeat a nearby one. */
function drawLabels(ctx, cam, labels, colors, zf) {
  ctx.save();
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
  labels.sort((a, b) => a.rank - b.rank);
  const boxes = [];
  const seen = new Map();
  const placed = {
    free: (b) => !boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]),
    near: (key, l, dist) => seen.get(key)?.some((p) => Math.hypot(p[0] - l.x, p[1] - l.y) < dist),
    add: (key, l, box) => { boxes.push(box); seen.set(key, [...(seen.get(key) || []), [l.x, l.y]]); },
  };
  ctx.lineJoin = 'round';
  for (const l of labels) {
    if (l.x < -50 || l.y < -20 || l.x > cam.W + 50 || l.y > cam.H + 20) continue;
    if (l.kind === 'road') drawRoadLabel(ctx, l, colors, zf, placed);
    else drawPointLabel(ctx, l, colors, placed);
  }
  ctx.restore();
}

/** Road name along its longest segment, if it fits there. */
function drawRoadLabel(ctx, l, colors, zf, placed) {
  if (zf < (l.rank <= 6 ? 12 : 14.5)) return;
  ctx.font = `10px ${FONT}`;
  const tw = ctx.measureText(l.text).width;
  if (l.plen < tw + 10 || placed.near(l.text, l, 260)) return;
  const c = Math.abs(Math.cos(l.a)), s = Math.abs(Math.sin(l.a));
  const hw = (tw * c + 12 * s) / 2 + 2, hh = (tw * s + 12 * c) / 2 + 2;
  const box = [l.x - hw, l.y - hh, l.x + hw, l.y + hh];
  if (!placed.free(box)) return;
  placed.add(l.text, l, box);
  ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.a);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = colors['--bg']; ctx.lineWidth = 3; ctx.strokeText(l.text, 0, 0);
  ctx.fillStyle = colors['--text']; ctx.fillText(l.text, 0, 0);
  ctx.restore();
}

/** Place, water or point-of-interest label (points of interest get a marker). */
function drawPointLabel(ctx, l, colors, placed) {
  const text = l.kind === 'place' ? l.text.toUpperCase() : l.text;
  ctx.font = pointFont(l);
  const tw = ctx.measureText(text).width;
  const dx = l.kind === 'poi' ? 7 : -tw / 2;
  const box = [l.x + dx - 3, l.y - 8, l.x + dx + tw + 3, l.y + 6];
  if (!placed.free(box)) return;
  const key = `${l.kind}:${text}`;
  if (placed.near(key, l, 120)) return;
  placed.add(key, l, box);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (l.kind === 'poi') {
    ctx.fillStyle = colors['--bg']; ctx.fillRect(l.x - 3.5, l.y - 3.5, 7, 7);
    ctx.strokeStyle = colors['--accent']; ctx.lineWidth = 1.5; ctx.strokeRect(l.x - 2.5, l.y - 2.5, 5, 5);
  }
  ctx.strokeStyle = colors['--bg']; ctx.lineWidth = 3; ctx.strokeText(text, l.x + dx, l.y);
  ctx.fillStyle = pointColor(l, colors);
  ctx.fillText(text, l.x + dx, l.y);
}
