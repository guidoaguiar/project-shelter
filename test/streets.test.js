import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTile, FakePath2D, recordingContext } from './helpers.js';
import { countTiles as serverCountTiles } from '../server/maps.js';

globalThis.Path2D ??= FakePath2D;
const { roadBucket, build, countTiles, mercY, invMercY, StreetLayer, POI } = await import('../public/js/lib/streets.js');
const { decodeTile } = await import('../public/js/lib/mvt.js');

test('road styles by kind and detail', () => {
  const cases = [
    [{ kind: 'highway' }, 'highway'], [{ kind: 'major_road' }, 'major'], [{ kind: 'minor_road' }, 'street'],
    [{ kind: 'minor_road', kind_detail: 'service' }, 'service'], [{ kind: 'path' }, 'path'],
    [{ kind: 'path', kind_detail: 'sidewalk' }, null], [{ kind: 'path', kind_detail: 'pier' }, 'service'],
    [{ kind: 'minor_road', kind_detail: 'track' }, 'track'], [{ kind: 'rail' }, 'rail'], [{ kind: 'ferry' }, 'ferry'],
    [{ kind: 'aeroway' }, 'service'], [{ kind: 'highway', is_tunnel: true }, 'tunnel'], [{ kind: 'rail', is_tunnel: true }, null],
    [{ kind: 'constructor' }, null], [{ kind: 'unknown' }, null],
  ];
  for (const [props, want] of cases) assert.equal(roadBucket(props), want, JSON.stringify(props));
});

test('mercator helpers and tile counts match the server', () => {
  for (const lat of [-80, -22.5, 0, 45, 85]) assert.ok(Math.abs(invMercY(mercY(lat)) - lat) < 1e-9);
  assert.equal(mercY(90), mercY(85.0511));
  for (const [bbox, z] of [[[-43.3, -22.6, -43.1, -22.4], 15], [[-10, 35, 5, 44], 10], [[-180, -85, 180, 85], 4]]) {
    assert.equal(countTiles(bbox, z), serverCountTiles(bbox, z));
  }
  assert.equal(countTiles([-180, -85, 180, 85], 2), 1 + 4 + 16);
});

test('build: paths per style and ranked labels', () => {
  const t = build(decodeTile(encodeTile({
    earth: [{ type: 3, rings: [[[0, 0], [4096, 0], [4096, 4096]]] }],
    landuse: [{ type: 3, props: { kind: 'park' }, rings: [[[1, 1], [2, 1], [2, 2]]] }, { type: 3, props: { kind: 'residential' }, rings: [[[1, 1], [2, 1], [2, 2]]] }],
    water: [
      { type: 3, props: { kind: 'lake', name: 'Lagoa' }, rings: [[[100, 100], [200, 100], [200, 200]]] },
      { type: 3, props: { kind: 'ocean' }, rings: [[[0, 0], [9, 0], [9, 9]]] },
      { type: 2, props: { kind: 'river' }, rings: [[[0, 0], [50, 50]]] },
      { type: 2, props: { kind: 'stream' }, rings: [[[0, 0], [5, 5]]] },
    ],
    roads: [
      { type: 2, props: { kind: 'highway', name: 'BR-040' }, rings: [[[0, 0], [10, 0], [10, 300]]] },
      { type: 2, props: { kind: 'path', kind_detail: 'sidewalk', name: 'Hidden' }, rings: [[[0, 0], [10, 0]]] },
    ],
    places: [{ type: 1, props: { kind: 'locality', name: 'Vila', population_rank: 10 }, rings: [[[300, 300]]] }],
    pois: [{ type: 1, props: { kind: 'peak', name: 'Pico', elevation: 2263.4 }, rings: [[[50, 60]]] }, { type: 1, props: { kind: 'bench' }, rings: [[[1, 1]]] }],
  })));
  assert.deepEqual(Object.keys(t.paths).toSorted((a, b) => a.localeCompare(b)), ['earth', 'green', 'highway', 'river', 'stream', 'water']);
  assert.equal(t.extent, 4096);
  assert.deepEqual(t.labels.map((l) => [l.kind, l.text]), [['place', 'Vila'], ['water', 'Lagoa'], ['poi', 'Pico 2263m'], ['road', 'BR-040']]);
  const road = t.labels.find((l) => l.kind === 'road');
  assert.equal(road.len, 300); // label sits on the longest segment
  assert.ok(Math.abs(road.a) <= Math.PI / 2, 'road labels are kept upright');
  assert.equal(t.labels.find((l) => l.kind === 'place').size, 12);
  assert.deepEqual(POI.spring, ['SPRING', 13.5]);
});

/** A layer over one archive whose tiles are served by a stubbed fetch. */
function layerWithTiles(t, tiles) {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = url.replace('/api/maps/tile/', '');
    requested.push(key);
    const body = tiles[key];
    if (!body) return { status: 204, ok: true };
    return { status: 200, ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  let updates = 0;
  const layer = new StreetLayer(() => { updates++; });
  layer.setArchives([{ file: 'a.pmtiles', minZoom: 0, maxZoom: 14, bounds: [-43.3, -22.7, -43.0, -22.4] }, { file: 'bad.pmtiles', error: 'broken' }]);
  return { layer, requested, updates: () => updates };
}

const color = (name) => `color(${name})`;
const settle = () => new Promise((ok) => setTimeout(ok, 20));

test('StreetLayer: covers(), loading, and drawing paths and labels', async (t) => {
  // z14 tile holding (-43.2, -22.5), and the camera centred on it.
  const z = 14, x = Math.floor((-43.2 + 180) / 360 * 2 ** z), y = Math.floor((180 - mercY(-22.5)) / 360 * 2 ** z);
  const tile = encodeTile({
    roads: [{ type: 2, props: { kind: 'major_road', name: 'Avenida Central' }, rings: [[[0, 2048], [4096, 2048]]] }],
    places: [{ type: 1, props: { kind: 'neighbourhood', name: 'Centro' }, rings: [[[2048, 1024]]] }],
  });
  const { layer, requested, updates } = layerWithTiles(t, { [`${z}/${x}/${y}`]: tile });
  assert.equal(layer.enabled, true);
  assert.equal(layer.maxZoom, 14);
  assert.equal(layer.covers(z, x, y), true);
  assert.equal(layer.covers(z, 0, 0), false);

  const cam = { W: 400, H: 300, dpr: 1, scale: 2 ** 14.2 * 256 / 360, cx: -43.2, cy: mercY(-22.5) };
  assert.equal(layer.draw(recordingContext().ctx, cam, color), false, 'nothing loaded yet');
  await settle();
  assert.ok(requested.includes(`${z}/${x}/${y}`));
  assert.ok(updates() > 0);

  const { ctx, calls } = recordingContext();
  assert.equal(layer.draw(ctx, cam, color), true);
  assert.equal(layer.drawn, true);
  const strokes = calls.filter(([k]) => k === 'stroke').length;
  assert.ok(strokes >= 2, 'road casing and line');
  const texts = new Set(calls.filter(([k]) => k === 'fillText').map(([, s]) => s));
  assert.ok(texts.has('Avenida Central'));
  assert.ok(texts.has('CENTRO'));
});

test('StreetLayer: a missing tile falls back to its parent', async (t) => {
  const z = 14, x = Math.floor((-43.2 + 180) / 360 * 2 ** z), y = Math.floor((180 - mercY(-22.5)) / 360 * 2 ** z);
  const parent = encodeTile({ earth: [{ type: 3, rings: [[[0, 0], [4096, 0], [4096, 4096]]] }] });
  const { layer, requested } = layerWithTiles(t, { [`${z - 1}/${x >> 1}/${y >> 1}`]: parent });
  const cam = { W: 200, H: 200, dpr: 1, scale: 2 ** 14 * 256 / 360, cx: -43.2, cy: mercY(-22.5) };
  for (let i = 0; i < 5 && !layer.draw(recordingContext().ctx, cam, String); i++) await settle();
  assert.ok(requested.includes(`${z - 1}/${x >> 1}/${y >> 1}`));
  assert.equal(layer.draw(recordingContext().ctx, cam, String), true);
});

test('StreetLayer: disabled without usable archives', () => {
  const layer = new StreetLayer(() => {});
  layer.setArchives([{ error: 'x' }]);
  assert.equal(layer.enabled, false);
  assert.equal(layer.draw(recordingContext().ctx, { W: 1, H: 1, dpr: 1, scale: 1, cx: 0, cy: 0 }, String), false);
});
