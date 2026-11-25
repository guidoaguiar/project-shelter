// Map routes and tracks (IMPROVEMENTS 2.3): schema, storage, backup and restore, and the HTTP API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { validate, coords, MAX_ROUTE_POINTS, MAX_TRACK_POINTS } from '../server/schema.js';
import { MAX_ROUTE_POINTS as CLIENT_ROUTE_POINTS, MAX_TRACK_POINTS as CLIENT_TRACK_POINTS } from '../public/js/lib/route.js';
import { Collection, Settings, Doc } from '../server/store.js';
import { buildBackup, restoreBackup } from '../server/backup.js';
import { tmpDir } from './helpers.js';

const WP = '0b9f6a1e-1b5c-4c1e-9a55-2f0d5f9b1c11';
const parse = (v) => coords(5).parse(v, 'track');
const node = (dir) => ({
  settings: new Settings(path.join(dir, 'settings.json')),
  collections: Object.fromEntries(['waypoints', 'routes'].map((n) => [n, new Collection(path.join(dir, `${n}.json`), { schema: n })])),
  plan: new Doc(path.join(dir, 'plan.json'), 'plan'),
});

test('route schema: defaults, waypoint ids, track points', () => {
  const r = validate('routes', { name: ' North ', waypointIds: [WP], extra: 1 });
  assert.deepEqual(r, { name: 'North', kind: 'route', waypointIds: [WP], track: [], notes: '' });
  assert.throws(() => validate('routes', {}), { message: /name: required/ });
  assert.throws(() => validate('routes', { name: 'x', kind: 'flight' }), { message: /kind/ });
  assert.throws(() => validate('routes', { name: 'x', waypointIds: ['forged'] }), { message: /waypointIds\[0\]/ });
  assert.throws(() => validate('routes', { name: 'x', waypointIds: Array.from({ length: MAX_ROUTE_POINTS + 1 }, () => WP) }), { message: /more than/ });
  const t = validate('routes', { name: 'Walk', kind: 'track', track: [[1.123456789, 2, 10.04], [1, 2]] });
  assert.deepEqual(t.track, [[1.123457, 2, 10], [1, 2]]);
  for (const bad of [[[91, 0]], [[0, 181]], [[1]], [[1, 2, 3, 4]], [['1', 2]], [[1, Number.NaN]], [[0, 0, 1e6]], 'x', [null]]) {
    assert.throws(() => parse(bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.throws(() => parse(Array.from({ length: 6 }, () => [0, 0])), { message: /more than 5 points/ });
  assert.deepEqual(parse(null), []);
  assert.equal(CLIENT_ROUTE_POINTS, MAX_ROUTE_POINTS, 'client and server agree on route length');
  assert.equal(CLIENT_TRACK_POINTS, MAX_TRACK_POINTS, 'client and server agree on track length');
});

test('waypoint categories: validated, and waypoints saved before them still load and update', (t) => {
  assert.equal(validate('waypoints', { name: 'W', lat: 1, lon: 2, kind: 'cache' }).kind, 'cache');
  assert.equal(validate('waypoints', { name: 'W', lat: 1, lon: 2, kind: '' }).kind, 'other');
  assert.throws(() => validate('waypoints', { name: 'W', lat: 1, lon: 2, kind: 'treasure' }), { message: /kind: must be one of/ });
  const file = path.join(tmpDir(t), 'waypoints.json');
  fs.writeFileSync(file, JSON.stringify([{ id: WP, name: 'Old', lat: 1, lon: 2 }])); // no kind: saved before categories
  const c = new Collection(file, { schema: 'waypoints' });
  assert.equal(c.all()[0].kind, undefined);
  const u = c.upsert({ name: 'Old gate' }, WP);
  assert.equal(u.kind, undefined, 'a partial update leaves a missing category alone');
  assert.equal(c.upsert({ kind: 'rally' }, WP).kind, 'rally');
});

test('routes travel in backups and restore with their ids', (t) => {
  const a = node(tmpDir(t));
  const w = a.collections.waypoints.upsert({ name: 'Gate', lat: 1, lon: 2, kind: 'rally' });
  const r = a.collections.routes.upsert({ name: 'North', waypointIds: [w.id] });
  a.collections.routes.upsert({ name: 'Walk', kind: 'track', track: [[1, 2], [1.1, 2.1]] });
  const backup = buildBackup({ ...a, appVersion: 'test' });
  assert.equal(backup.collections.routes.length, 2);

  const b = node(tmpDir(t));
  const report = restoreBackup(structuredClone(backup), { mode: 'replace', dryRun: false }, b);
  assert.equal(report.collections.routes.add, 2);
  assert.equal(b.collections.routes.all()[0].id, r.id);
  assert.deepEqual(b.collections.routes.all()[0].waypointIds, [w.id]);
  assert.deepEqual(b.collections.routes.all()[1].track, [[1, 2], [1.1, 2.1]]);

  const bad = { ...backup, collections: { ...backup.collections, routes: [{ id: crypto.randomUUID(), name: 'x', track: [[999, 0]] }] } };
  assert.equal(restoreBackup(bad, { mode: 'merge', dryRun: true }, b).collections.routes.invalid, 1, 'a broken track is not restored');
});

// ---------- over HTTP ----------

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let server, port, data;

async function freePort() {
  const probe = http.createServer();
  await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
  const { port: p } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return p;
}

before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-routes-'));
  const listenOn = await freePort();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(listenOn), HOST: '127.0.0.1', SHELTER_DATA: data, SHELTER_NET_CHECK: 'off', SHELTER_AI_URL: 'http://127.0.0.1:9', SHELTER_BIND: '', SHELTER_REMOTE_ADMIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((ok, fail) => {
    let out = '';
    server.stdout.on('data', (d) => { out += d; const m = /localhost:(\d+)/.exec(out); if (m && out.includes('manual')) ok(+m[1]); });
    server.on('exit', (code) => fail(new Error(`server exited (${code})`)));
  });
});

after(() => {
  server?.kill();
  fs.rmSync(data, { recursive: true, force: true });
});

function request(method, urlPath, body) {
  return new Promise((ok, fail) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json' };
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        ok({ status: res.statusCode, json: (res.headers['content-type'] || '').startsWith('application/json') ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('routes API: create, update, list, delete; deleting a waypoint takes it out of routes', async () => {
  const a = (await request('POST', '/api/db/waypoints', { name: 'Gate', lat: 1, lon: 2, kind: 'rally' })).json;
  const b = (await request('POST', '/api/db/waypoints', { name: 'Bridge', lat: 1.1, lon: 2.1, kind: 'hazard' })).json;
  assert.equal(b.kind, 'hazard');
  assert.equal((await request('POST', '/api/db/waypoints', { name: 'x', lat: 1, lon: 2, kind: 'bogus' })).status, 400);

  const created = await request('POST', '/api/db/routes', { name: 'North', waypointIds: [a.id, b.id], id: 'forged' });
  assert.equal(created.status, 201);
  const r = created.json;
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.kind, 'route');
  assert.equal((await request('POST', '/api/db/routes', { name: 'Bad', track: 'nope' })).status, 400);

  const track = (await request('POST', '/api/db/routes', { name: 'Walk', kind: 'track', track: [[1, 2, 5], [1.01, 2.01, 7]] })).json;
  assert.deepEqual(track.track, [[1, 2, 5], [1.01, 2.01, 7]]);

  const u = await request('PUT', `/api/db/routes/${r.id}`, { waypointIds: [b.id, a.id], notes: 'via the bridge' });
  assert.deepEqual(u.json.waypointIds, [b.id, a.id]);
  assert.equal(u.json.name, 'North', 'partial update keeps the name');

  assert.equal((await request('GET', '/api/db/routes')).json.length, 2);

  await request('DELETE', `/api/db/waypoints/${a.id}`, {});
  const after1 = (await request('GET', '/api/db/routes')).json.find((x) => x.id === r.id);
  assert.deepEqual(after1.waypointIds, [b.id]);

  assert.deepEqual((await request('DELETE', `/api/db/routes/${track.id}`, {})).json, { ok: true });
  assert.equal((await request('GET', '/api/db/routes')).json.length, 1);

  const backup = (await request('GET', '/api/backup')).json;
  assert.equal(backup.collections.routes.length, 1, 'routes are in the backup');
});
