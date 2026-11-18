import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { worldRings } from '../public/js/lib/world.js';
import { MAX_LAT } from '../public/js/lib/streets.js';

const delta = (arc) => arc.map((p, i) => (i ? [p[0] - arc[i - 1][0], p[1] - arc[i - 1][1]] : p));

/** TopoJSON with an identity transform: arcs are given as absolute points, then delta-encoded. */
function topo(arcs, geometries) {
  return { transform: { scale: [1, 1], translate: [0, 0] }, arcs: arcs.map(delta), objects: { countries: { geometries } } };
}

test('rings join their arcs, reversing negative ones', () => {
  const t = topo([[[0, 0], [10, 0], [10, 10]], [[0, 0], [0, 10], [10, 10]]], [{ type: 'Polygon', arcs: [[0, ~1]] }]);
  assert.deepEqual(worldRings(t), [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
});

test('a ring crossing the 180° line is unwrapped and drawn twice', () => {
  const t = topo([[[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]]], [{ type: 'MultiPolygon', arcs: [[[0]]] }]);
  const rings = worldRings(t);
  assert.equal(rings.length, 2);
  assert.deepEqual(rings[0].map((p) => p[0]), [170, 190, 190, 170, 170]);
  assert.deepEqual(rings[1].map((p) => p[0]), [-190, -170, -170, -190, -190]);
});

test('a ring around the pole is closed along the chart edge', () => {
  const t = topo([[[-180, -70], [-90, -75], [0, -70], [90, -75], [180, -70]]], [{ type: 'Polygon', arcs: [[0]] }]);
  const [ring] = worldRings(t);
  assert.deepEqual(ring.slice(-2), [[180, -MAX_LAT], [-180, -MAX_LAT]]);
});

test('tiny rings and other geometry types are skipped', () => {
  const t = topo([[[0, 0], [1, 1]]], [{ type: 'Polygon', arcs: [[0]] }, { type: 'Point', coordinates: [0, 0] }]);
  assert.deepEqual(worldRings(t), []);
});

test('the bundled world outline loads', () => {
  const file = new URL('../public/data/world-110m.json', import.meta.url);
  const rings = worldRings(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(rings.length > 200);
  for (const r of rings) assert.ok(r.every(([lon, lat]) => Math.abs(lon) <= 540 && Math.abs(lat) <= 90));
});
