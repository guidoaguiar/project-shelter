import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Maps, zxyToTileId, countTiles, MAX_TILES, decompress, compressionName } from '../server/maps.js';
import { tmpDir, makeArchive, serveRanges, tileId } from './helpers.js';

const lonToX = (lon, z) => Math.min(2 ** z - 1, Math.max(0, Math.floor((lon + 180) / 360 * 2 ** z)));
const latToY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return Math.min(2 ** z - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z)));
};

/** Every tile of bbox up to maxzoom, each with distinct random-length content. */
function tilesFor(bbox, maxzoom) {
  const tiles = {};
  for (let z = 0; z <= maxzoom; z++) {
    for (let x = lonToX(bbox[0], z); x <= lonToX(bbox[2], z); x++) {
      for (let y = latToY(bbox[3], z); y <= latToY(bbox[1], z); y++) {
        tiles[`${z}/${x}/${y}`] = Buffer.concat([Buffer.from(`${z}/${x}/${y}:`), crypto.randomBytes(crypto.randomInt(20, 2000))]);
      }
    }
  }
  return tiles;
}

const waitFor = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((ok) => setTimeout(ok, 20));
  }
};

test('tile ids follow the PMTiles Hilbert curve', () => {
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.deepEqual([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y)), [1, 2, 3, 4]);
  for (const [z, x, y] of [[5, 3, 17], [12, 1500, 2300], [15, 12_345, 18_888]]) assert.equal(zxyToTileId(z, x, y), tileId(z, x, y));
});

test('tile counts per area', () => {
  assert.equal(countTiles([-180, -85, 180, 85], 0), 1);
  assert.equal(countTiles([-180, -85, 180, 85], 3), 1 + 4 + 16 + 64);
  assert.equal(countTiles([0.1, 0.1, 0.2, 0.2], 6), 7);
  assert.equal(compressionName(2), 'gzip');
  assert.equal(compressionName(9), 'unknown');
});

test('reads tiles from stored archives, most detailed first', async (t) => {
  const dir = tmpDir(t);
  const coarse = { '0/0/0': zlib.gzipSync('coarse root'), '1/1/1': zlib.gzipSync('coarse 1/1/1') };
  fs.writeFileSync(path.join(dir, 'coarse.pmtiles'), makeArchive(coarse, { maxZoom: 1 }));
  fs.writeFileSync(path.join(dir, 'fine.pmtiles'), makeArchive({ '1/1/1': Buffer.from('fine 1/1/1') }, { maxZoom: 5, tileCompression: 1, bounds: [0, -10, 10, 0] }));
  fs.writeFileSync(path.join(dir, 'broken.pmtiles'), 'not an archive');
  fs.writeFileSync(path.join(dir, '.hidden.pmtiles'), 'ignored');
  const maps = new Maps(dir);
  t.after(() => Promise.all([...maps.archives.values()].map((a) => a.close())));

  const list = await maps.scan();
  assert.deepEqual(list.map((a) => a.file), ['fine.pmtiles', 'coarse.pmtiles', 'broken.pmtiles']);
  assert.equal(list[2].error, 'not a PMTiles archive');
  assert.equal(list[1].name, 'fixture');

  const fine = await maps.tile(1, 1, 1);
  assert.equal(fine.compression, 1);
  assert.equal(fine.data.toString(), 'fine 1/1/1');
  const root = await maps.tile(0, 0, 0);
  assert.equal(decompress(root.data, root.compression).toString(), 'coarse root');
  assert.equal(await maps.tile(1, 0, 0), null);
  assert.equal(await maps.tile(9, 0, 0), null);

  await maps.remove('coarse.pmtiles');
  assert.equal(fs.existsSync(path.join(dir, 'coarse.pmtiles')), false);
  await assert.rejects(maps.remove('../x.pmtiles'), { status: 400 });
});

test('downloads an area from a remote archive, with leaf directories in the result', async (t) => {
  const bbox = [-20, -20, 20, 20], maxzoom = 10;
  const tiles = tilesFor(bbox, maxzoom);
  const source = makeArchive(tiles, { tileCompression: 1, maxZoom: 12, meta: { name: 'planet', attribution: 'test data' } });
  const { url, stats } = await serveRanges(t, source);
  process.env.SHELTER_MAP_SOURCE = url;
  t.after(() => { delete process.env.SHELTER_MAP_SOURCE; });

  const dir = tmpDir(t);
  const maps = new Maps(dir);
  t.after(() => Promise.all([...maps.archives.values()].map((a) => a.close())));
  const job = maps.download({ bbox, maxzoom, name: '  Test Area!! ' });
  assert.equal(job.state, 'running');
  assert.equal(job.file, 'test-area.pmtiles');
  assert.equal(job.controller, undefined, 'status() does not expose the abort controller');
  assert.throws(() => maps.download({ bbox, maxzoom, name: 'again' }), { status: 409 });
  await waitFor(() => maps.status().state !== 'running');

  const done = maps.status();
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.bytes, done.total);
  assert.ok(stats.requests >= 3, 'header, root directory and data fetched as separate ranges');
  const out = fs.readFileSync(path.join(dir, 'test-area.pmtiles'));
  assert.equal(done.size, out.length);
  assert.ok(Number(out.readBigUInt64LE(48)) > 0, 'large directories are split into leaves');
  assert.deepEqual(fs.readdirSync(dir), ['test-area.pmtiles'], 'temporary files are removed');

  const [info] = await maps.scan();
  assert.equal(info.name, 'test-area');
  assert.equal(info.maxZoom, maxzoom);
  assert.deepEqual(info.bounds, bbox);
  for (const [zxy, data] of Object.entries(tiles)) {
    const [z, x, y] = zxy.split('/').map(Number);
    const got = await maps.tile(z, x, y);
    assert.ok(got?.data.equals(data), `tile ${zxy}`);
  }
});

test('rejects invalid downloads', (t) => {
  const maps = new Maps(tmpDir(t));
  const bad = [
    [{ bbox: [0, 0, 1], maxzoom: 10 }, /invalid area/],
    [{ bbox: [1, 0, 0, 1], maxzoom: 10 }, /invalid area/],
    [{ bbox: [0, 0, 1, 90], maxzoom: 10 }, /invalid area/],
    [{ bbox: [0, 0, 1, 1], maxzoom: 5 }, /zoom 6 to 15/],
    [{ bbox: [0, 0, 1, 1], maxzoom: 'x' }, /zoom 6 to 15/],
    [{ bbox: [-100, -50, 100, 50], maxzoom: 15 }, new RegExp(`limit ${MAX_TILES}`)],
  ];
  for (const [body, message] of bad) assert.throws(() => maps.download(body), (e) => e.status === 400 && message.test(e.message));
});

test('reports an unreachable map server', async (t) => {
  process.env.SHELTER_MAP_SOURCE = 'http://127.0.0.1:9/planet.pmtiles';
  t.after(() => { delete process.env.SHELTER_MAP_SOURCE; });
  const maps = new Maps(tmpDir(t));
  maps.download({ bbox: [0, 0, 0.1, 0.1], maxzoom: 6, name: '' });
  assert.match(maps.status().file, /^area-[0-9a-z]+\.pmtiles$/);
  await waitFor(() => maps.status().state !== 'running');
  assert.equal(maps.status().state, 'error');
  assert.match(maps.status().error, /cannot reach the map server/);
});

test('a download can be cancelled', async (t) => {
  const source = makeArchive(tilesFor([-5, -5, 5, 5], 8), { tileCompression: 1 });
  const { url } = await serveRanges(t, source);
  process.env.SHELTER_MAP_SOURCE = url;
  t.after(() => { delete process.env.SHELTER_MAP_SOURCE; });
  const dir = tmpDir(t);
  const maps = new Maps(dir);
  maps.download({ bbox: [-5, -5, 5, 5], maxzoom: 8, name: 'cancel me' });
  maps.cancel();
  await waitFor(() => maps.status().state !== 'running');
  assert.equal(maps.status().state, 'cancelled');
  assert.equal(maps.status().error, 'cancelled');
  assert.deepEqual(fs.readdirSync(dir), []);
});
