import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTile } from '../public/js/lib/mvt.js';
import { encodeTile } from './helpers.js';

test('decodes layers, properties of every value type, and geometry', () => {
  const tile = encodeTile({
    roads: [{ type: 2, props: { kind: 'highway', name: 'Rua A', min_zoom: 7, tunnel: false, score: 1.5, delta: -3 }, rings: [[[0, 0], [100, 50], [90, -20]]] }],
    water: [{ type: 3, props: { kind: 'lake' }, rings: [[[10, 10], [20, 10], [20, 20]], [[12, 12], [14, 12], [14, 14]]] }],
    pois: [{ type: 1, props: { kind: 'spring' }, rings: [[[5, 6]], [[7, 8]]] }],
  }, 512);
  const layers = decodeTile(tile);
  assert.deepEqual(Object.keys(layers), ['roads', 'water', 'pois']);
  assert.equal(layers.roads.extent, 512);
  const road = layers.roads.features[0];
  assert.deepEqual(road, { type: 2, props: { kind: 'highway', name: 'Rua A', min_zoom: 7, tunnel: false, score: 1.5, delta: -3 }, rings: [[0, 0, 100, 50, 90, -20]] });
  assert.deepEqual(layers.water.features[0].rings, [[10, 10, 20, 10, 20, 20], [12, 12, 14, 12, 14, 14]]);
  // A multipoint: each point starts its own ring.
  assert.deepEqual(layers.pois.features[0].rings, [[5, 6], [7, 8]]);
});

test('an empty tile has no layers', () => {
  assert.deepEqual(decodeTile(new Uint8Array(0)), {});
});

test('unknown fields are skipped', () => {
  // Field 9 (varint) and field 10 (64-bit) before a layer.
  const unknown = [9 << 3, 5, (10 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8];
  const tile = Uint8Array.from([...unknown, ...encodeTile({ l: [{ type: 1, rings: [[[1, 1]]] }] })]);
  assert.deepEqual(Object.keys(decodeTile(tile)), ['l']);
});
