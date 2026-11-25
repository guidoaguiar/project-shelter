import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTile } from './helpers.js';
import { decodeTile } from '../public/js/lib/mvt.js';
import { parseQuery, fold, tileFeatures, matches, tilesAround, searchZoom, searchTiles, groupOf, pool } from '../public/js/lib/poi.js';

// Zoom 14 tile holding lat 0..~0.022, lon 0..0.022 (x = 8192, y = 8191 is just north of the equator).
const Z = 14, X = 8192, Y = 8191;
const tile = encodeTile({
  pois: [
    { type: 1, props: { kind: 'clinic', name: 'Hôpital Saint-Luc' }, rings: [[[100, 4000]]] },
    { type: 1, props: { kind: 'drinking_water' }, rings: [[[2000, 2000]]] },
    { type: 1, props: { kind: 'drinking_water' }, rings: [[[2010, 2000]]] },
    { type: 1, props: { kind: 'cafe', name: 'Spring Café' }, rings: [[[3000, 3000]]] },
  ],
  places: [{ type: 1, props: { kind: 'locality', name: 'Springfield' }, rings: [[[50, 50]]] }, { type: 1, props: { kind: 'locality' }, rings: [[[60, 60]]] }],
  roads: [{ type: 2, props: { kind: 'minor_road', name: 'Spring Street' }, rings: [[[0, 1000], [4000, 1000]]] }],
  water: [{ type: 3, props: { kind: 'lake', name: 'Blue Lake' }, rings: [[[500, 500], [600, 500], [600, 600]]] }],
});

test('queries: a lone group word asks for a kind of place, anything else matches names', () => {
  assert.deepEqual(parseQuery('nearest clinic'), { group: 'medical', words: [] });
  assert.deepEqual(parseQuery('Water point'), { group: 'water', words: [] });
  assert.deepEqual(parseQuery('medical'), { group: 'medical', words: [] });
  assert.deepEqual(parseQuery('Spring Street'), { group: null, words: ['spring', 'street'] });
  assert.deepEqual(parseQuery('  '), { group: null, words: [] });
  assert.equal(fold('Hôpital St-Luc!'), 'hopital st luc');
  assert.equal(groupOf('spring'), 'water');
  assert.equal(groupOf('cafe'), null);
});

test('tileFeatures: points of interest, places, water and roads with positions', () => {
  const f = tileFeatures(decodeTile(tile), Z, X, Y);
  assert.deepEqual(f.map((x) => x.layer).sort((a, b) => a.localeCompare(b)),['places', 'pois', 'pois', 'pois', 'pois', 'roads', 'water'], 'the unnamed place is left out');
  const clinic = f.find((x) => x.kind === 'clinic');
  assert.equal(clinic.group, 'medical');
  assert.ok(clinic.lon > 0 && clinic.lon < 0.001, `lon ${clinic.lon}`);
  assert.ok(clinic.lat > 0 && clinic.lat < 0.022, `lat ${clinic.lat}`);
  assert.equal(f.find((x) => x.layer === 'roads').kind, 'minor_road');
  assert.ok(matches(clinic, parseQuery('hopital')));
  assert.ok(matches(clinic, parseQuery('clinic')));
  assert.ok(!matches(clinic, parseQuery('water')));
  assert.ok(!matches(clinic, { group: null, words: [] }));
});

test('tilesAround and searchZoom', () => {
  const t = tilesAround(0.01, 0.01, 0.1, Z);
  assert.deepEqual(t[0], [Z, X, Y], 'the tile holding the centre comes first');
  const wide = tilesAround(0.01, 0.01, 5, Z);
  assert.ok(wide.length > 4);
  assert.ok(searchZoom(0.01, 0.01, 25, 15, 120) < 15);
  assert.equal(searchZoom(0.01, 0.01, 0.1, 15, 120), 15);
  assert.equal(searchZoom(0, 0, 1, 20, 1000), 15, 'never above zoom 15');
});

test('searchTiles: nearest first, within the radius, missing and broken tiles skipped', async () => {
  const fetched = [];
  const fetchTile = async (z, x, y) => {
    fetched.push(`${z}/${x}/${y}`);
    if (x === X && y === Y) return tile;
    if (x === X + 1 && y === Y) return Uint8Array.from([0xFF, 0xFF, 0xFF]); // garbage
    if (x === X - 1 && y === Y) throw new Error('offline');
    return null;
  };
  const origin = { lat: 0.011, lon: 0.011 };
  const water = await searchTiles({ fetchTile, ...origin, query: 'water', radiusKm: 3, zoom: Z });
  assert.equal(water.length, 2, 'two unnamed taps 7 m apart are both kept');
  assert.ok(water[0].km <= water[1].km);
  assert.ok(fetched.length > 1);
  const spring = await searchTiles({ fetchTile, ...origin, query: 'spring', radiusKm: 3, zoom: Z });
  assert.ok(spring.every((x) => x.group === 'water'), 'a lone "spring" asks for water');
  assert.deepEqual((await searchTiles({ fetchTile, ...origin, query: 'Spring Street', radiusKm: 3, zoom: Z })).map((x) => x.name), ['Spring Street']);
  assert.deepEqual((await searchTiles({ fetchTile, ...origin, query: 'springf', radiusKm: 3, zoom: Z })).map((x) => x.name), ['Springfield']);
  assert.deepEqual((await searchTiles({ fetchTile, ...origin, query: 'spring cafe', radiusKm: 3, zoom: Z })).map((x) => x.name), ['Spring Café'], 'accents do not matter');
  const near = await searchTiles({ fetchTile, lat: 0.0001, lon: 0.0001, query: 'blue lake', radiusKm: 0.05, zoom: Z });
  assert.equal(near.length, 0, 'outside the radius');
  assert.deepEqual(await searchTiles({ fetchTile, ...origin, query: 'nearest', zoom: Z }), [], 'an empty query finds nothing');
});

test('pool keeps order and limits concurrency', async () => {
  let running = 0, most = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    running++; most = Math.max(most, running);
    await new Promise((ok) => setTimeout(ok, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(most, 2);
  assert.deepEqual(await pool([], 3, async () => 1), []);
});
