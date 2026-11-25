// Optional HTTPS (server/https.js): certificate paths and coverage, the openssl fallback, the
// HTTP/HTTPS port sharing, and the installable-app files served by server.js over HTTPS.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';
import {
  httpsRequested, certPaths, certHosts, subjectAltName, opensslArgs, certCovers, loadCert, dualServer, httpsLocation, CERT_DAYS,
} from '../server/https.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HAS_OPENSSL = (() => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- looking openssl up through PATH is what is tested
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const NEEDS_OPENSSL = HAS_OPENSSL ? false : 'openssl is not installed';

test('HTTPS is asked for by --https or SHELTER_HTTPS', () => {
  assert.equal(httpsRequested(['node', 'server.js'], {}), false);
  assert.equal(httpsRequested(['node', 'server.js', '--https'], {}), true);
  assert.equal(httpsRequested([], { SHELTER_HTTPS: '1' }), true);
  assert.equal(httpsRequested([], { SHELTER_HTTPS: 'true' }), true);
  assert.equal(httpsRequested([], { SHELTER_HTTPS: '0' }), false);
});

test('certificate paths: generated under <data>/tls, or your own pair from the environment', () => {
  const data = path.resolve('/srv/shelter-data');
  assert.deepEqual(certPaths(data, {}), { dir: path.join(data, 'tls'), key: path.join(data, 'tls', 'key.pem'), cert: path.join(data, 'tls', 'cert.pem'), own: false });
  const own = certPaths(data, { SHELTER_TLS_KEY: '/etc/ssl/k.pem', SHELTER_TLS_CERT: '/etc/ssl/c.pem' });
  assert.equal(own.own, true);
  assert.equal(own.key, path.resolve('/etc/ssl/k.pem'));
  // Only one of the two is not a pair: the generated one is used.
  assert.equal(certPaths(data, { SHELTER_TLS_CERT: '/etc/ssl/c.pem' }).own, false);
});

test('certificate hosts and subjectAltName', () => {
  const hosts = certHosts({ lan: ['192.0.2.20', '192.0.2.20'], hostname: 'Shelter-Pi' });
  assert.deepEqual(hosts, ['localhost', '127.0.0.1', '::1', '192.0.2.20', 'shelter-pi', 'shelter-pi.local']);
  assert.ok(!certHosts({ hostname: 'bad name;rm' }).some((h) => h.includes(' ')));
  assert.equal(subjectAltName(['localhost', '198.51.100.2', '::1']), 'DNS:localhost,IP:198.51.100.2,IP:::1');
  const args = opensslArgs({ key: 'k.pem', cert: 'c.pem', hosts: ['localhost', '198.51.100.2'] });
  assert.deepEqual(args.slice(0, 2), ['req', '-x509']);
  assert.ok(args.includes('subjectAltName=DNS:localhost,IP:198.51.100.2'));
  assert.equal(args[args.indexOf('-days') + 1], String(CERT_DAYS));
  assert.ok(CERT_DAYS <= 825, 'Apple devices refuse longer-lived server certificates');
});

const missing = () => { throw Object.assign(new Error('spawn openssl ENOENT'), { code: 'ENOENT' }); };
const broken = () => { throw Object.assign(new Error('exit 1'), { stderr: Buffer.from('bad option') }); };

test('without openssl the error says what to do', (t) => {
  const data = tmpDir(t);
  assert.throws(() => loadCert(data, { env: {}, run: missing }), (e) => /openssl was not found/.test(e.message) && e.message.includes(path.join(data, 'tls')));
  assert.throws(() => loadCert(data, { env: {}, run: broken }), /bad option/);
  assert.throws(() => loadCert(data, { env: { SHELTER_TLS_KEY: path.join(data, 'no.pem'), SHELTER_TLS_CERT: path.join(data, 'no.pem') } }), /SHELTER_TLS_KEY/);
});

test('plain-HTTP requests are sent to the same host over HTTPS', () => {
  assert.equal(httpsLocation({ headers: { host: '192.0.2.20:4077' }, url: '/#/map' }), 'https://192.0.2.20:4077/#/map');
  assert.equal(httpsLocation({ headers: { host: '[::1]:4077' }, url: '/x' }), 'https://[::1]:4077/x');
  assert.equal(httpsLocation({ headers: { host: 'evil.example/path' }, url: '/' }), null);
  assert.equal(httpsLocation({ headers: {}, url: '/' }), null);
});

describe('with openssl', { skip: NEEDS_OPENSSL }, () => {
  test('a certificate is made once, reused, and remade when it no longer covers the hosts', (t) => {
    const data = tmpDir(t);
    const hosts = certHosts({ lan: ['203.0.113.9'], hostname: 'node' });
    const first = loadCert(data, { hosts, env: {} });
    assert.equal(first.created, true);
    assert.match(first.cert, /BEGIN CERTIFICATE/);
    assert.match(first.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(certCovers(first.cert, hosts).ok, true);
    assert.equal(loadCert(data, { hosts, env: {} }).created, false);

    const moved = certHosts({ lan: ['198.51.100.5'], hostname: 'node' });
    assert.ok(certCovers(first.cert, moved).reason.includes('198.51.100.5'));
    assert.equal(loadCert(data, { hosts: moved, env: {} }).created, true);

    const later = Date.now() + (CERT_DAYS - 3) * 864e5;
    assert.match(certCovers(first.cert, hosts, later).reason, /expires/);
    assert.equal(certCovers('not a certificate', hosts).ok, false);
  });

  test('one port speaks HTTPS, keeps plain HTTP for this machine and redirects the rest', async (t) => {
    const tls = loadCert(tmpDir(t), { hosts: certHosts(), env: {} });
    let keep = true;
    const srv = dualServer(tls, (req, res) => res.end(`${req.socket.encrypted ? 'tls' : 'plain'} ${req.socket.remoteAddress}`), { keepPlain: () => keep });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    t.after(() => new Promise((ok) => srv.close(ok)));
    const { port } = srv.address();
    const get = (mod) => new Promise((ok, fail) => {
      mod.get({ host: '127.0.0.1', port, path: '/x', rejectUnauthorized: false, agent: false }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => ok({ status: res.statusCode, location: res.headers.location, body }));
      }).on('error', fail);
    });
    assert.deepEqual(await get(https), { status: 200, location: undefined, body: 'tls 127.0.0.1' });
    assert.deepEqual(await get(http), { status: 200, location: undefined, body: 'plain 127.0.0.1' });
    keep = false;
    const moved = await get(http);
    assert.equal(moved.status, 308);
    assert.equal(moved.location, `https://127.0.0.1:${port}/x`);
  });
});

describe('server.js --https', { skip: NEEDS_OPENSSL }, () => {
  let server, port, data;

  before(async () => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-https-'));
    const probe = http.createServer();
    await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
    const listenOn = probe.address().port;
    await new Promise((ok) => probe.close(ok));
    server = spawn(process.execPath, ['server.js', '--https'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(listenOn), HOST: '127.0.0.1', SHELTER_DATA: data, SHELTER_NET_CHECK: 'off', SHELTER_POWER_CHECK: 'off', SHELTER_AI_URL: 'http://127.0.0.1:9', SHELTER_BIND: '', SHELTER_REMOTE_ADMIN: '', SHELTER_TLS_KEY: '', SHELTER_TLS_CERT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    port = await new Promise((ok, fail) => {
      let out = '';
      server.stdout.on('data', (d) => { out += d; const m = /https:\/\/localhost:(\d+)/.exec(out); if (m && out.includes('manual')) ok(+m[1]); });
      server.on('exit', (code) => fail(new Error(`server exited (${code}): ${out}`)));
    });
  });

  after(() => {
    server?.kill();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const get = (urlPath) => new Promise((ok, fail) => {
    https.get({ host: '127.0.0.1', port, path: urlPath, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }).on('error', fail);
  });

  test('the certificate is stored in the data folder and offered to phones', async () => {
    assert.ok(fs.existsSync(path.join(data, 'tls', 'cert.pem')));
    const r = await get('/shelter.crt');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/x-x509-ca-cert');
    assert.match(r.text, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(r.text, /PRIVATE KEY/);
  });

  test('the API works over HTTPS with the security headers, including worker and manifest sources', async () => {
    const r = await get('/api/status');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /worker-src 'self'/);
    assert.match(r.headers['content-security-policy'], /manifest-src 'self'/);
  });

  test('the service worker is served for the whole site and never cached stale', async () => {
    const r = await get('/sw.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.equal(r.headers['service-worker-allowed'], '/');
    assert.equal(r.headers['cache-control'], 'no-cache');
  });

  test('the manifest and the app shell list', async () => {
    const m = await get('/manifest.webmanifest');
    assert.match(m.headers['content-type'], /^application\/manifest\+json/);
    const manifest = JSON.parse(m.text);
    assert.equal(manifest.start_url.startsWith('/'), true);
    for (const icon of manifest.icons) assert.equal((await get(icon.src)).status, 200, icon.src);

    const shell = await get('/app-shell.json');
    assert.equal(shell.status, 200);
    const { version, files } = JSON.parse(shell.text);
    assert.match(version, /^[0-9a-f]{16}$/);
    for (const f of ['/', '/index.html', '/js/app.js', '/css/shelter.css', '/manifest.webmanifest']) assert.ok(files.includes(f), f);
    assert.ok(!files.includes('/sw.js'));
  });
});
