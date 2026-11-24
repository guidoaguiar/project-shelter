// End-to-end access control in LAN mode. Requests to this machine's own network address arrive
// from that address, not from loopback, so the server treats them like any other device's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LAN_IP = Object.values(os.networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address;
const skip = LAN_IP ? false : 'no non-loopback IPv4 interface on this machine';
let server, port, data;

/** A port that is free right now (PORT=0 would mean the default port to server.js). */
async function freePort() {
  const probe = http.createServer();
  await new Promise((ok) => probe.listen(0, '0.0.0.0', ok));
  const { port: p } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return p;
}

before(async () => {
  if (skip) return;
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-lan-'));
  const listenOn = await freePort();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(listenOn), HOST: '0.0.0.0', SHELTER_DATA: data, SHELTER_NET_CHECK: 'off', SHELTER_AI_URL: 'http://127.0.0.1:9', SHELTER_BIND: '', SHELTER_REMOTE_ADMIN: '', SHELTER_PORT: '' },
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
  if (data) fs.rmSync(data, { recursive: true, force: true });
});

/** One request from host (loopback) or from the LAN address. */
function request(from, method, urlPath, { body, cookie } = {}) {
  return new Promise((ok, fail) => {
    const headers = {};
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: from === 'host' ? '127.0.0.1' : LAN_IP, port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        ok({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', fail);
    if (method !== 'GET') req.write(JSON.stringify(body ?? {}));
    req.end();
  });
}
const host = (...a) => request('host', ...a);
const lan = (...a) => request('lan', ...a);
const cookieOf = (r) => String(r.headers['set-cookie'] || '').split(';')[0];

test('LAN access: guests, PIN sessions, host-only settings, policies', { skip }, async () => {
  // A new install: PIN policy with no PIN, so other devices are guests.
  let st = await lan('GET', '/api/status');
  assert.equal(st.json.server.lanMode, true);
  assert.deepEqual(st.json.access, { role: 'guest', lanWrites: 'pin', pinSet: false });
  assert.equal((await host('GET', '/api/status')).json.access.role, 'host');

  // Guests: no household data, no home position, but the manual and advisor work.
  assert.equal((await host('PUT', '/api/settings', { body: { lat: 47.5, lon: 19 } })).status, 200);
  assert.equal((await host('POST', '/api/db/notes', { body: { title: 'private' } })).status, 201);
  assert.equal((await lan('GET', '/api/db/notes')).status, 403);
  assert.equal((await lan('POST', '/api/db/stores', { body: { name: 'x', qty: 1 } })).status, 403);
  assert.equal((await lan('PUT', '/api/settings', { body: { callsign: 'x' } })).status, 403);
  const guestSettings = (await lan('GET', '/api/settings')).json;
  assert.deepEqual([guestSettings.lat, guestSettings.lon], [null, null]);
  assert.equal((await lan('GET', '/api/manual')).status, 200);
  assert.equal((await lan('GET', '/api/search?q=water')).status, 200);
  assert.equal((await lan('POST', '/api/session', { body: { pin: '1234' } })).status, 400, 'no PIN set yet');
  for (const p of ['/api/plan', '/api/db/people', '/api/db/contacts', '/api/db/kits', '/api/backup', '/api/snapshots']) {
    assert.equal((await lan('GET', p)).status, 403, p);
  }
  assert.equal((await lan('GET', '/api/kits/templates')).status, 200, 'templates are not household data');

  // The host sets a PIN; a device that enters it becomes a member.
  assert.equal((await host('PUT', '/api/settings', { body: { access: { pin: '2468', lanWrites: 'pin' } } })).status, 200);
  assert.equal((await lan('POST', '/api/session', { body: { pin: '0000' } })).status, 403);
  const ok = await lan('POST', '/api/session', { body: { pin: '2468' } });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const cookie = cookieOf(ok);
  assert.equal((await lan('GET', '/api/status', { cookie })).json.access.role, 'member');
  assert.ok((await lan('GET', '/api/db/notes', { cookie })).json.some((n) => n.title === 'private'));
  assert.equal((await lan('GET', '/api/settings', { cookie })).json.lat, 47.5);
  assert.equal((await lan('PUT', '/api/settings', { body: { callsign: 'phone' }, cookie })).status, 200);
  assert.equal((await lan('GET', '/api/plan', { cookie })).status, 200);
  assert.equal((await lan('GET', '/api/backup', { cookie })).status, 403, 'backups are host-only');
  assert.equal((await lan('POST', '/api/restore', { body: { backup: {}, mode: 'merge' }, cookie })).status, 403);

  // Members still cannot touch model or access settings (the API key theft this guards against).
  assert.equal((await host('PUT', '/api/settings', { body: { ai: { baseUrl: 'http://127.0.0.1:9', apiKey: 'secret' } } })).status, 200);
  assert.equal((await lan('PUT', '/api/settings', { body: { ai: { baseUrl: 'http://attacker.example' } }, cookie })).status, 403);
  assert.equal((await lan('PUT', '/api/settings', { body: { access: { lanWrites: 'open' } }, cookie })).status, 403);
  assert.equal((await host('GET', '/api/settings')).json.ai.baseUrl, 'http://127.0.0.1:9');

  // Logging out, and a PIN change, end sessions.
  const second = cookieOf(await lan('POST', '/api/session', { body: { pin: '2468' } }));
  await lan('DELETE', '/api/session', { cookie });
  assert.equal((await lan('GET', '/api/db/notes', { cookie })).status, 403);
  await host('PUT', '/api/settings', { body: { access: { pin: '13579' } } });
  assert.equal((await lan('GET', '/api/db/notes', { cookie: second })).status, 403);

  // Policies: open makes every device a member; read-only makes every device a guest.
  await host('PUT', '/api/settings', { body: { access: { lanWrites: 'open' } } });
  assert.equal((await lan('GET', '/api/db/notes')).status, 200);
  await host('PUT', '/api/settings', { body: { access: { lanWrites: 'readonly' } } });
  st = await lan('GET', '/api/status');
  assert.equal(st.json.access.role, 'guest');
  assert.equal((await lan('POST', '/api/session', { body: { pin: '13579' } })).status, 400);

  // Wrong PINs: the sixth attempt in ten minutes is refused even when right.
  await host('PUT', '/api/settings', { body: { access: { lanWrites: 'pin' } } });
  for (let i = 0; i < 5; i++) assert.equal((await lan('POST', '/api/session', { body: { pin: '1111' } })).status, 403);
  assert.equal((await lan('POST', '/api/session', { body: { pin: '13579' } })).status, 429);

  // Nothing secret is ever served.
  for (const r of [await host('GET', '/api/settings'), await host('GET', '/api/status')]) {
    assert.ok(!r.text.includes('secret') && !r.text.includes('scrypt'));
  }
});
