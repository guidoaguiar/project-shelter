// End-to-end for the Advisor (household context, model pulls) and Log attachments: runs server.js
// in LAN mode on a temporary data folder, with a fake Ollama server.
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
let server, port, data, ollama;
const seen = []; // requests the fake Ollama received

async function freePort() {
  const probe = http.createServer();
  await new Promise((ok) => probe.listen(0, '0.0.0.0', ok));
  const { port: p } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return p;
}

before(async () => {
  ollama = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'tiny:1b' }] })); return; }
    if (req.url === '/api/chat') { res.writeHead(200); res.end('{"message":{"content":"Use the EpiPen."}}\n{"done":true}\n'); return; }
    if (req.url === '/api/pull') { res.writeHead(200); res.end('{"status":"pulling x","total":10,"completed":5}\n{"status":"success"}\n'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => ollama.listen(0, '127.0.0.1', ok));
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-advlog-'));
  const listenOn = await freePort();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(listenOn), HOST: '0.0.0.0', SHELTER_DATA: data, SHELTER_NET_CHECK: 'off', SHELTER_POWER_CHECK: 'off',
      SHELTER_AI_URL: `http://127.0.0.1:${ollama.address().port}`, SHELTER_BIND: '', SHELTER_REMOTE_ADMIN: '', SHELTER_PORT: '',
    },
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
  ollama?.closeAllConnections();
  ollama?.close();
  if (data) fs.rmSync(data, { recursive: true, force: true });
});

function request(method, urlPath, { body, from = '127.0.0.1', type = 'application/json' } = {}) {
  return new Promise((ok, fail) => {
    const headers = method === 'GET' ? {} : { 'content-type': type };
    const req = http.request({ host: from, port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        ok({ status: res.statusCode, headers: res.headers, buf, text: buf.toString(), json: ct.startsWith('application/json') ? JSON.parse(buf.toString()) : undefined });
      });
    });
    req.on('error', fail);
    if (method !== 'GET') req.write(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    req.end();
  });
}
const events = (r) => r.text.trim().split('\n').map((l) => JSON.parse(l));

test('Log attachments: upload, serve with nosniff, delete with the entry', async () => {
  const up = await request('POST', '/api/attachments', { body: { name: 'cut.png', data: PNG.toString('base64') } });
  assert.equal(up.status, 201);
  const img = up.json;
  assert.equal(img.type, 'image/png');
  assert.equal((await request('POST', '/api/attachments', { body: { name: 'x.svg', data: Buffer.from('<svg onload="alert(1)">   ').toString('base64') } })).status, 415);
  assert.equal((await request('POST', '/api/attachments', { body: 'raw', type: 'image/png' })).status, 415, 'uploads must be JSON');

  const got = await request('GET', `/api/attachments/${img.file}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(got.buf, PNG);
  assert.equal((await request('GET', '/api/attachments/..%2Fsettings.json')).status, 404);
  assert.equal((await request('GET', '/api/attachments/00000000-0000-0000-0000-000000000000.png')).status, 404);

  const note = (await request('POST', '/api/db/notes', { body: { title: 'Wound', tags: ['medical'], template: 'medical', attachments: [img] } })).json;
  assert.equal(note.attachments[0].file, img.file);
  assert.equal((await request('POST', '/api/db/notes', { body: { attachments: [{ ...img, file: '../x.png' }] } })).status, 400);

  const backup = await request('GET', '/api/backup');
  assert.ok(backup.json.attachments[img.file], 'the backup carries the image');

  // Removing the image from the entry deletes the file.
  await request('PUT', `/api/db/notes/${note.id}`, { body: { attachments: [] } });
  assert.equal((await request('GET', `/api/attachments/${img.file}`)).status, 404);

  const second = (await request('POST', '/api/attachments', { body: { name: 'b.png', data: PNG.toString('base64') } })).json;
  const n2 = (await request('POST', '/api/db/notes', { body: { title: 'Damage', attachments: [second] } })).json;
  await request('PUT', `/api/db/notes/${n2.id}`, { body: { title: 'Damage, roof' } });
  assert.equal((await request('GET', `/api/attachments/${second.file}`)).status, 200, 'an edit that leaves the images alone keeps them');
  await request('DELETE', `/api/db/notes/${n2.id}`, { body: {} });
  assert.equal((await request('GET', `/api/attachments/${second.file}`)).status, 404);
});

test('Advisor: household context only when the host allows it', async () => {
  await request('POST', '/api/db/people', { body: { name: 'Ana', group: 'child', allergies: 'peanuts' } });
  const ask = async (from) => {
    const r = await request('POST', '/api/chat', { from, body: { messages: [{ role: 'user', content: 'What can Ana eat?' }] } });
    return { evs: events(r), system: seen.findLast((s) => s.url === '/api/chat').body.messages[0].content };
  };
  let r = await ask();
  assert.doesNotMatch(r.system, /peanuts/, 'off by default');
  assert.ok(!r.evs.some((e) => e.type === 'context'));
  assert.equal(r.evs.at(-1).type, 'done');
  assert.ok(r.evs.find((e) => e.type === 'sources').retrieval === 'keyword');

  const put = await request('PUT', '/api/settings', { body: { ai: { householdContext: true } } });
  assert.equal(put.json.ai.householdContext, true);
  assert.equal((await request('GET', '/api/status')).json.ai.household, true);
  r = await ask();
  assert.match(r.system, /HOUSEHOLD[\s\S]*Ana \(child\): allergies: peanuts/);
  assert.ok(r.evs.some((e) => e.type === 'context' && e.household));

  if (LAN_IP) {
    // Another device that has not entered a PIN is a guest: no household data for it, and no settings changes.
    r = await ask(LAN_IP);
    assert.doesNotMatch(r.system, /peanuts/);
    assert.equal((await request('GET', '/api/status', { from: LAN_IP })).json.ai.household, false);
    assert.equal((await request('PUT', '/api/settings', { from: LAN_IP, body: { ai: { householdContext: false } } })).status, 403);
    assert.equal((await request('POST', '/api/attachments', { from: LAN_IP, body: { name: 'a.png', data: PNG.toString('base64') } })).status, 403);
  }
  await request('PUT', '/api/settings', { body: { ai: { householdContext: false } } });
});

test('Advisor: model pulls are host-only and stream progress', async () => {
  assert.equal((await request('POST', '/api/ai/pull/check', { body: { model: 'bad name; rm' } })).status, 400);
  assert.equal((await request('POST', '/api/ai/pull', { body: { model: '../x' } })).status, 400);
  const r = await request('POST', '/api/ai/pull', { body: { model: 'tiny:1b' } });
  assert.equal(r.status, 200);
  const evs = events(r);
  assert.deepEqual(evs[0], { type: 'progress', status: 'pulling x', total: 10, completed: 5 });
  assert.deepEqual(evs.at(-1), { type: 'done', model: 'tiny:1b' });
  assert.deepEqual(seen.findLast((s) => s.url === '/api/pull').body, { model: 'tiny:1b', stream: true });
  if (LAN_IP) {
    assert.equal((await request('POST', '/api/ai/pull', { from: LAN_IP, body: { model: 'tiny:1b' } })).status, 403);
    assert.equal((await request('POST', '/api/ai/pull/check', { from: LAN_IP, body: { model: 'tiny:1b' } })).status, 403);
  }
});
