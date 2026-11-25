// End-to-end: runs server.js on a temporary data folder and talks to it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { makeArchive, encodeTile } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let server, port, data;

/** A port that is free right now (PORT=0 would mean the default port to server.js). */
async function freePort() {
  const probe = http.createServer();
  await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
  const { port: p } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return p;
}

before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-server-'));
  const listenOn = await freePort();
  fs.mkdirSync(path.join(data, 'maps'));
  fs.writeFileSync(path.join(data, 'maps', 'area.pmtiles'), makeArchive({ '0/0/0': zlib.gzipSync(encodeTile({ earth: [{ type: 3, rings: [[[0, 0], [10, 0], [10, 10]]] }] })) }, { maxZoom: 0 }));
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

/** One request on a fresh connection. body: object (sent as JSON) or string. */
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const h = { ...headers };
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const type = res.headers['content-type'] || '';
        let json;
        if (type.startsWith('application/json')) json = JSON.parse(buf.toString());
        ok({ status: res.statusCode, headers: res.headers, buf, text: buf.toString(), json });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('status reports the node, manual and model link', async () => {
  const r = await request('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.ok(r.json.manual.articles > 0);
  assert.equal(r.json.ai.online, false);
  assert.equal(r.json.server.lanMode, false);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
});

test('settings: the API key is stored but never returned', async () => {
  const put = await request('PUT', '/api/settings', { body: { callsign: 'test', ai: { apiKey: 'secret' } } });
  assert.equal(put.json.callsign, 'TEST');
  assert.equal(put.json.ai.apiKeySet, true);
  assert.ok(!put.text.includes('secret'));
  assert.ok(!(await request('GET', '/api/settings')).text.includes('secret'));
});

test('manual index, entry and search', async () => {
  const index = (await request('GET', '/api/manual')).json;
  assert.ok(index.length > 10);
  const entry = await request('GET', `/api/manual/${index[0].id}`);
  assert.equal(entry.json.id, index[0].id);
  assert.equal((await request('GET', '/api/manual/no-such-entry')).status, 404);
  assert.equal((await request('GET', '/api/manual/UPPER')).status, 404);
  assert.ok((await request('GET', '/api/search?q=water')).json.length > 0);
});

test('records: create, update, list, delete; ids come from the server', async () => {
  const created = await request('POST', '/api/db/notes', { body: { id: 'forged', title: 'a' } });
  assert.equal(created.status, 201);
  assert.notEqual(created.json.id, 'forged');
  const { id } = created.json;
  const updated = await request('PUT', `/api/db/notes/${id}`, { body: { id: 'forged', title: 'b' } });
  assert.deepEqual([updated.json.id, updated.json.title], [id, 'b']);
  assert.ok((await request('GET', '/api/db/notes')).json.some((n) => n.id === id && n.title === 'b'));
  assert.deepEqual((await request('DELETE', `/api/db/notes/${id}`, { body: {} })).json, { ok: true });
  assert.deepEqual((await request('DELETE', `/api/db/notes/${id}`, { body: {} })).json, { ok: false });
  assert.equal((await request('PUT', '/api/db/notes/00000000-0000-0000-0000-000000000000', { body: {} })).status, 404);
  assert.equal((await request('GET', '/api/db/secrets')).status, 404);
  assert.equal((await request('PATCH', '/api/db/notes', { body: {} })).status, 404);
});

test('writes must be JSON, valid, and under 2 MB', async () => {
  assert.equal((await request('POST', '/api/hash', { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('POST', '/api/hash', { body: '{bad' })).status, 400);
  const big = await request('POST', '/api/hash', { body: JSON.stringify({ text: 'x'.repeat(2.2 * 1024 * 1024) }) }).catch((error) => ({ error }));
  assert.ok(big.error || big.status === 413, 'oversized bodies are refused');
});

test('hash tool', async () => {
  assert.equal((await request('POST', '/api/hash', { body: { text: 'abc' } })).json.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal((await request('POST', '/api/hash', { body: { text: 'abc', algo: 'crc32' } })).status, 400);
});

test('advisor answers from the manual when no model is linked', async () => {
  const r = await request('POST', '/api/chat', { body: { messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'how do I purify water' }] } });
  assert.match(r.headers['content-type'], /ndjson/);
  const events = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'sources');
  assert.ok(events[0].items.length > 0);
  assert.deepEqual(events.at(-1), { type: 'offline', reason: 'model server unreachable' });
  assert.equal((await request('POST', '/api/chat', { body: { messages: [] } })).status, 400);
});

test('map tiles: gzip passthrough, inflated otherwise, empty and invalid', async () => {
  const gz = await request('GET', '/api/maps/tile/0/0/0', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  const plain = await request('GET', '/api/maps/tile/0/0/0');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(zlib.gunzipSync(gz.buf), plain.buf);
  assert.equal((await request('GET', '/api/maps/tile/1/0/0')).status, 204);
  assert.equal((await request('GET', '/api/maps/tile/16/0/0')).status, 400);
  assert.equal((await request('GET', '/api/maps/tile/2/4/0')).status, 400);
  const maps = (await request('GET', '/api/maps')).json;
  assert.deepEqual(maps.archives.map((a) => a.file), ['area.pmtiles']);
  assert.equal(maps.canAdmin, true, 'loopback clients may administer');
  assert.equal((await request('POST', '/api/maps/download', { body: { bbox: [1, 2] } })).status, 400);
  assert.equal((await request('DELETE', '/api/maps/..%2Fx.pmtiles', { body: {} })).status, 404);
});

test('depot rejects unknown services', async () => {
  const r = await request('POST', '/api/depot/no-such-service/start', { body: {} });
  assert.ok([404, 409].includes(r.status)); // 409 when Docker is not running on the test machine
});

test('static files, figures and path traversal', async () => {
  const index = await request('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match((await request('GET', '/js/lib/geo.js')).headers['content-type'], /javascript/);
  assert.equal((await request('HEAD', '/index.html')).text, '');
  assert.equal((await request('GET', '/nope.txt')).status, 404);
  assert.equal((await request('GET', '/..%2f..%2fserver.js')).status, 403);
  assert.equal((await request('GET', '/%E0%A4%A')).status, 400);
  assert.equal((await request('POST', '/index.html', { body: {} })).status, 405);
  assert.equal((await request('GET', '/content/chapters/img/fig04-02.png')).headers['content-type'], 'image/png');
  assert.equal((await request('GET', '/content/nope/img/a.png')).status, 404);
});

test('in loopback mode, other host names are refused (DNS rebinding guard)', async () => {
  assert.equal((await request('GET', '/api/settings', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request('GET', '/api/settings', { headers: { host: '[::1]:8080' } })).status, 200);
  assert.equal((await request('GET', '/api/settings', { headers: { host: 'localhost:4077' } })).status, 200);
});

test('unknown endpoints', async () => {
  assert.equal((await request('GET', '/api/nope')).status, 404);
  assert.equal((await request('DELETE', '/api/settings', { body: {} })).status, 404);
});

test('plan: defaults, partial updates, review, and waypoint links cleared on delete', async () => {
  const fresh = (await request('GET', '/api/plan')).json;
  assert.equal(fresh.reviewEveryDays, 365);
  assert.deepEqual(fresh.meeting.home, { label: '', waypointId: null, notes: '' });
  const w = (await request('POST', '/api/db/waypoints', { body: { name: 'Gate', lat: 1, lon: 2 } })).json;
  const w2 = (await request('POST', '/api/db/waypoints', { body: { name: 'Bridge', lat: 1.1, lon: 2.1 } })).json;
  let p = (await request('PUT', '/api/plan', { body: { meeting: { home: { label: 'Gate', waypointId: w.id } }, routes: [{ name: 'North', waypointIds: [w.id, w2.id] }] } })).json;
  assert.equal(p.meeting.home.waypointId, w.id);
  assert.equal(p.meeting.outOfTown.label, '', 'missing parts get defaults');
  assert.match(p.routes[0].id, /^[0-9a-f-]{36}$/);
  assert.equal((await request('PUT', '/api/plan', { body: { routes: 'nope' } })).status, 400);
  assert.equal((await request('PUT', '/api/plan', { body: { meeting: { home: { waypointId: 'forged' } } } })).status, 400);
  p = (await request('POST', '/api/plan/reviewed', { body: {} })).json;
  assert.equal(p.reviewedAt, new Date().toISOString().slice(0, 10));
  await request('DELETE', `/api/db/waypoints/${w.id}`, { body: {} });
  p = (await request('GET', '/api/plan')).json;
  assert.equal(p.meeting.home.waypointId, null);
  assert.deepEqual(p.routes[0].waypointIds, [w2.id]);
});

test('people, contacts and kits: validated, and stores links cleared on delete', async () => {
  assert.equal((await request('POST', '/api/db/people', { body: { kind: 'robot', name: 'x' } })).status, 400);
  assert.equal((await request('POST', '/api/db/contacts', { body: { role: 'family' } })).status, 400, 'a name is required');
  const med = (await request('POST', '/api/db/stores', { body: { name: 'Insulin', category: 'MEDICAL', qty: 30, dailyUse: 3 } })).json;
  const ana = (await request('POST', '/api/db/people', { body: { name: 'Ana', medications: [{ name: 'Insulin', storeId: med.id }] } })).json;
  const kit = (await request('POST', '/api/db/kits', { body: { name: 'Bag', items: [{ label: 'Insulin', storeId: med.id }] } })).json;
  assert.equal(kit.intervalDays, 180);
  await request('DELETE', `/api/db/stores/${med.id}`, { body: {} });
  const people = (await request('GET', '/api/db/people')).json;
  assert.equal(people.find((x) => x.id === ana.id).medications[0].storeId, null);
  assert.equal((await request('GET', '/api/db/kits')).json.find((x) => x.id === kit.id).items[0].storeId, null);
  const templates = (await request('GET', '/api/kits/templates')).json;
  assert.ok(templates.some((x) => x.id === 'ready-basic'));
});

test('backup download and restore (dry run, then merge) from the host', async () => {
  const note = (await request('POST', '/api/db/notes', { body: { title: 'backed up' } })).json;
  const dl = await request('GET', '/api/backup');
  assert.match(dl.headers['content-disposition'], /attachment; filename="shelter-.+\.json"/);
  assert.equal(dl.json.format, 'shelter-backup');
  assert.ok(dl.json.collections.notes.some((n) => n.id === note.id));
  assert.ok((await request('GET', '/api/settings')).json.lastBackup);
  await request('DELETE', `/api/db/notes/${note.id}`, { body: {} });
  const dry = (await request('POST', '/api/restore', { body: { backup: dl.json, mode: 'merge', dryRun: true } })).json;
  assert.equal(dry.report.collections.notes.add, 1);
  assert.ok(!(await request('GET', '/api/db/notes')).json.some((n) => n.id === note.id), 'dry run changed nothing');
  const done = (await request('POST', '/api/restore', { body: { backup: dl.json, mode: 'merge', dryRun: false } })).json;
  assert.match(done.snapshot, /^pre-restore-/);
  assert.ok((await request('GET', '/api/db/notes')).json.some((n) => n.id === note.id));
  const snaps = (await request('GET', '/api/snapshots')).json;
  assert.ok(snaps.some((s) => s.name === done.snapshot));
  assert.equal((await request('GET', `/api/snapshots/${done.snapshot}`)).status, 200);
  assert.equal((await request('GET', '/api/snapshots/..%2Fsettings.json')).status, 404);
  assert.equal((await request('POST', '/api/restore', { body: { backup: { format: 'other' }, mode: 'merge' } })).status, 400);
});

test('manual sections print whole, and the new content is there', async () => {
  const water = await request('GET', '/api/manual/section/WATER');
  assert.equal(water.status, 200);
  assert.ok(water.json.length > 1 && water.json.every((a) => a.category === 'WATER' && a.body));
  assert.equal((await request('GET', '/api/manual/section/NOPE')).status, 404);
});

test('power: status carries battery state; low-power mode turns the advisor off', async () => {
  const s = await request('GET', '/api/status');
  assert.equal(typeof s.json.power.present, 'boolean');
  assert.equal(s.json.power.lowPower, false);
  assert.equal(s.json.system.lowPower, false);
  assert.equal((await request('PUT', '/api/settings', { body: { power: { lowPower: true } } })).json.power.lowPower, true);
  const low = await request('GET', '/api/status');
  assert.deepEqual([low.json.power.lowPower, low.json.system.lowPower, low.json.ai.online], [true, true, false]);
  const chat = await request('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'water' }] } });
  assert.equal(chat.status, 503);
  assert.match(chat.json.error, /low-power/);
  assert.equal((await request('PUT', '/api/settings', { body: { power: { batteryWh: 'lots' } } })).status, 400);
  assert.equal((await request('PUT', '/api/settings', { body: { power: { lowPower: false } } })).json.power.lowPower, false);
});

test('check-in: saved, validated and read back', async () => {
  assert.equal((await request('GET', '/api/checkin')).json.startedAt, null);
  const body = { startedAt: '2026-01-01T10:00:00.000Z', allOk: true, people: [{ name: 'Ana', ok: true, at: '2026-01-01T10:02:00.000Z' }] };
  assert.equal((await request('PUT', '/api/checkin', { body })).status, 200);
  const back = await request('GET', '/api/checkin');
  assert.deepEqual([back.json.allOk, back.json.people[0].name], [true, 'Ana']);
  assert.equal((await request('PUT', '/api/checkin', { body: { startedAt: 'soon' } })).status, 400);
});
