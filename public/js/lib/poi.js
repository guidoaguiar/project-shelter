// Search the street map tiles stored on this node for place names and points of interest, such as
// the nearest clinic, water point or shelter. Works offline: it reads the same vector tiles the map
// draws. Pure apart from the fetchTile callback the caller passes, so it runs under Node for tests.
import { decodeTile } from './mvt.js';
import { invMercY, mercY } from './streets.js';
import { rangeBearing } from './geo.js';

/** [group, label, OSM kinds in the Protomaps "pois" layer, words that ask for the group]. */
export const GROUPS = [
  ['water', 'WATER', ['drinking_water', 'water_point', 'spring', 'water_well', 'water_tap', 'fountain'], ['water', 'spring', 'well', 'tap', 'drinking']],
  ['medical', 'MEDICAL', ['hospital', 'clinic', 'doctors', 'pharmacy', 'defibrillator', 'dentist'], ['clinic', 'hospital', 'doctor', 'doctors', 'medical', 'pharmacy', 'aed', 'defibrillator', 'health']],
  ['shelter', 'SHELTER', ['shelter', 'alpine_hut', 'wilderness_hut', 'camp_site', 'community_centre', 'place_of_worship'], ['shelter', 'hut', 'camp', 'campsite', 'refuge']],
  ['fuel', 'FUEL', ['fuel'], ['fuel', 'petrol', 'gas', 'diesel']],
  ['help', 'POLICE / FIRE', ['police', 'fire_station', 'ranger_station', 'townhall'], ['police', 'fire', 'ranger', 'townhall']],
  ['food', 'FOOD', ['supermarket', 'convenience', 'marketplace', 'bakery'], ['food', 'supermarket', 'shop', 'market', 'grocery']],
];
const GROUP_BY_WORD = new Map(GROUPS.flatMap(([g, , , words]) => words.map((w) => [w, g])));
const GROUP_KINDS = new Map(GROUPS.map(([g, , kinds]) => [g, new Set(kinds)]));
const FILLER = new Set(['nearest', 'near', 'closest', 'nearby', 'the', 'a', 'an', 'find', 'point', 'points', 'station']);

/** Lower case, without accents or punctuation: "Hôpital St-Luc" -> "hopital st luc". */
export const fold = (s) => String(s ?? '').normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * What a query asks for: { group, words }. A lone group word ("clinic", "nearest water") asks for
 * that kind of place; otherwise every word must appear in the name ("spring street"). Words such
 * as "nearest" and "near" are ignored. A group name itself ("medical") also works.
 */
export function parseQuery(q) {
  const words = fold(q).split(' ').filter((w) => w && !FILLER.has(w));
  if (words.length === 1 && GROUP_BY_WORD.has(words[0])) return { group: GROUP_BY_WORD.get(words[0]), words: [] };
  if (words.length === 1 && GROUP_KINDS.has(words[0])) return { group: words[0], words: [] };
  return { group: null, words };
}

/** The group a POI kind belongs to, or null. */
export const groupOf = (kind) => GROUPS.find(([g]) => GROUP_KINDS.get(g).has(kind))?.[0] ?? null;

/** Tile units (x, y) of tile z/x/y to { lat, lon }. */
function toLatLon(z, tx, ty, extent, px, py) {
  const n = 2 ** z;
  return { lon: ((tx + px / extent) / n) * 360 - 180, lat: invMercY(180 - ((ty + py / extent) / n) * 360) };
}

/** A point roughly in the middle of a line: its middle vertex. */
function midVertex(rings) {
  const r = rings[0];
  if (!r || r.length < 2) return null;
  const i = Math.floor(r.length / 4) * 2;
  return [r[i], r[i + 1]];
}

/**
 * Searchable features of one decoded tile: [{ name, kind, layer, group, lat, lon }]. Points of
 * interest (named or not), named places and water, and named roads (at a middle vertex).
 */
// Per layer: which features are searchable, and where each one is (tile units).
const PICK = {
  pois: (f) => (f.type === 1 ? f.rings[0] : null),
  places: (f) => (f.type === 1 && f.props.name ? f.rings[0] : null),
  water: (f) => {
    if (!f.props.name) return null;
    return f.type === 1 ? f.rings[0] : midVertex(f.rings);
  },
  roads: (f) => (f.type === 2 && f.props.name ? midVertex(f.rings) : null),
};

/** One searchable feature of a layer. */
function feature(layer, p, pos) {
  const kind = layer === 'roads' && p.kind_detail ? p.kind_detail : p.kind || layer;
  return { name: String(p.name ?? p.ref ?? '').trim(), kind: String(kind), layer, group: layer === 'pois' ? groupOf(p.kind) : null, ...pos };
}

export function tileFeatures(layers, z, x, y) {
  const out = [];
  for (const [layer, pick] of Object.entries(PICK)) {
    const l = layers[layer];
    for (const f of l?.features || []) {
      const at = pick({ ...f, props: f.props || {} });
      if (at) out.push(feature(layer, f.props || {}, toLatLon(z, x, y, l.extent || 4096, at[0], at[1])));
    }
  }
  return out;
}

/** Whether feature f answers the parsed query. */
export function matches(f, { group, words }) {
  if (group && f.group !== group) return false;
  if (!words.length) return !!group;
  const name = fold(f.name);
  return words.every((w) => name.includes(w));
}

/** Tiles at zoom z that cover a circle of radiusKm around (lat, lon), nearest first. */
export function tilesAround(lat, lon, radiusKm, z) {
  const n = 2 ** z;
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  const tx = (v) => Math.min(n - 1, Math.max(0, Math.floor(((v + 180) / 360) * n)));
  const ty = (v) => Math.min(n - 1, Math.max(0, Math.floor(((180 - mercY(v)) / 360) * n)));
  const cx = ((lon + 180) / 360) * n, cy = ((180 - mercY(lat)) / 360) * n;
  const out = [];
  for (let x = tx(lon - dLon); x <= tx(lon + dLon); x++) {
    for (let y = ty(lat + dLat); y <= ty(lat - dLat); y++) out.push({ z, x, y, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
  }
  out.sort((a, b) => a.d - b.d);
  return out.map(({ z: tz, x, y }) => [tz, x, y]);
}

/** The most detailed zoom at or below maxZoom whose tiles for the circle number at most maxTiles. */
export function searchZoom(lat, lon, radiusKm, maxZoom, maxTiles = 120) {
  let z = Math.max(0, Math.min(15, maxZoom));
  while (z > 0 && tilesAround(lat, lon, radiusKm, z).length > maxTiles) z--;
  return z;
}

/** Runs async fn over items with at most `limit` running at once. Results keep the items' order. */
export function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    if (next >= items.length) return;
    const k = next++;
    out[k] = await fn(items[k]);
    await worker();
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => out);
}

/** Drops repeats: the same name and kind within 300 m of a nearer hit (roads repeat across tiles). Unnamed points are all kept. */
function dedupe(hits) {
  const kept = [];
  for (const h of hits) {
    const twin = h.name && kept.some((k) => k.kind === h.kind && fold(k.name) === fold(h.name) && rangeBearing(k, h).km < 0.3);
    if (!twin) kept.push(h);
  }
  return kept;
}

/**
 * Searches the stored tiles around { lat, lon }. fetchTile(z, x, y) resolves to the tile's bytes
 * (Uint8Array) or null. Returns up to limit hits { name, kind, layer, group, lat, lon, km, bearing },
 * nearest first, within radiusKm. Unreadable tiles are skipped.
 */
export async function searchTiles({ fetchTile, lat, lon, query, radiusKm = 5, zoom = 14, limit = 25, maxTiles = 120 }) {
  const q = typeof query === 'string' ? parseQuery(query) : query;
  if (!q.group && !q.words.length) return [];
  const tiles = tilesAround(lat, lon, radiusKm, zoom).slice(0, maxTiles);
  const found = await pool(tiles, 6, async ([z, x, y]) => {
    try {
      const bytes = await fetchTile(z, x, y);
      return bytes?.length ? tileFeatures(decodeTile(bytes), z, x, y).filter((f) => matches(f, q)) : [];
    } catch {
      return [];
    }
  });
  const hits = found.flat()
    .map((f) => ({ ...f, ...rangeBearing({ lat, lon }, f) }))
    .filter((f) => f.km <= radiusKm)
    .sort((a, b) => a.km - b.km);
  return dedupe(hits).slice(0, limit);
}
