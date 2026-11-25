// Installable app: the service worker's caching rules (public/js/lib/offline.js), the app shell list
// (server/offline.js) and the "use this device's location" helper (public/js/lib/locate.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';
import { strategyFor, cacheFor, staleCaches, manualUrls, manualDue, registerWorker, CACHES, MANUAL_REFRESH_MS } from '../public/js/lib/offline.js';
import { shellManifest } from '../server/offline.js';
import { locationProblem, locationError, currentPosition, accuracyText } from '../public/js/lib/locate.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGIN = 'https://192.0.2.20:4077';
const s = (p, method = 'GET', origin = ORIGIN) => strategyFor(method, new URL(p, origin), ORIGIN);

test('service worker: what is stored and how', () => {
  assert.equal(s('/'), 'shell');
  assert.equal(s('/js/views/map.js'), 'shell');
  assert.equal(s('/manifest.webmanifest'), 'shell');
  assert.equal(s('/api/manual'), 'manual');
  assert.equal(s('/api/manual/water-purification'), 'manual');
  assert.equal(s('/api/manual/section/FIRST%20AID'), 'manual');
  assert.equal(s('/api/settings'), 'manual');
  assert.equal(s('/content/manual/img/knot.png'), 'figure');
  // Never stored: live status, household data, map tiles, the advisor, writes, other sites and the worker files.
  for (const p of ['/api/status', '/api/db/notes', '/api/plan', '/api/maps/tile/3/1/2', '/api/search?q=water', '/sw.js', '/app-shell.json']) assert.equal(s(p), 'network', p);
  assert.equal(s('/api/manual', 'POST'), 'network');
  assert.equal(s('/api/manual', 'PUT'), 'network');
  assert.equal(strategyFor('GET', new URL('https://tiles.example/x.js'), ORIGIN), 'network');
  assert.equal(cacheFor('shell'), CACHES.shell);
  assert.equal(cacheFor('figure'), CACHES.runtime);
  assert.equal(cacheFor('network'), null);
});

test('service worker: old caches are dropped, others left alone', () => {
  assert.deepEqual(staleCaches(['shelter-shell-v0', CACHES.shell, CACHES.manual, 'other-app', 'shelter-runtime-v0']), ['shelter-shell-v0', 'shelter-runtime-v0']);
});

test('service worker: manual URLs from the index', () => {
  const urls = manualUrls([{ id: 'water-1', category: 'WATER' }, { id: 'fire', category: 'FIRE & HEAT' }, { id: 'water-2', category: 'WATER' }, { id: '../etc', category: 'X' }, null]);
  assert.deepEqual(urls, ['/api/manual', '/api/kits/templates', '/api/manual/water-1', '/api/manual/fire', '/api/manual/water-2',
    '/api/manual/section/WATER', '/api/manual/section/FIRE%20%26%20HEAT', '/api/manual/section/X']);
  assert.deepEqual(manualUrls(null), ['/api/manual', '/api/kits/templates']);
  const now = Date.now();
  assert.equal(manualDue(null, now), true);
  assert.equal(manualDue(Number.NaN, now), true);
  assert.equal(manualDue(now - 1000, now), false);
  assert.equal(manualDue(now - MANUAL_REFRESH_MS, now), true);
});

test('service worker: registered only in a secure context', async () => {
  assert.match(registerWorker({ navigator: {} }), /no service workers/);
  const calls = [];
  const sw = { register: async (...a) => { calls.push(a); }, ready: Promise.resolve({ active: { postMessage: (m) => calls.push(m) } }) };
  assert.match(registerWorker({ navigator: { serviceWorker: sw }, isSecureContext: false }), /HTTPS/);
  assert.equal(calls.length, 0);
  assert.equal(registerWorker({ navigator: { serviceWorker: sw }, isSecureContext: true }), null);
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(calls[0], ['/sw.js', { type: 'module', scope: '/' }]);
  assert.equal(calls[1], 'refresh');
});

test('app shell list: every page asset in public/, not the worker, with a version that follows changes', (t) => {
  const real = shellManifest(path.join(ROOT, 'public'));
  for (const f of ['/', '/index.html', '/js/app.js', '/js/lib/offline.js', '/js/lib/locate.js', '/css/shelter.css', '/icons/icon-192.png']) assert.ok(real.files.includes(f), f);
  assert.ok(!real.files.includes('/sw.js'));

  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'sw.js'), '');
  fs.writeFileSync(path.join(dir, 'js', 'a b.js'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'not served to the shell');
  fs.writeFileSync(path.join(dir, '.hidden.js'), '');
  const one = shellManifest(dir);
  assert.deepEqual(one.files, ['/', '/index.html', '/js/a%20b.js']);
  fs.writeFileSync(path.join(dir, 'js', 'a b.js'), 'changed');
  assert.notEqual(shellManifest(dir).version, one.version);
  assert.deepEqual(shellManifest(path.join(dir, 'missing')).files, ['/']);
});

test('device location: explains an insecure page, and reads a fix', async () => {
  const geolocation = {
    getCurrentPosition: (ok, _fail, opts) => { assert.equal(opts.enableHighAccuracy, true); ok({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8.4 } }); },
  };
  const insecure = locationProblem({ isSecureContext: false, location: { hostname: '192.0.2.20', port: '4077' }, navigator: { geolocation } });
  assert.match(insecure, /HTTPS/);
  assert.match(insecure, /https:\/\/192.0.2.20:4077/);
  assert.match(insecure, /--https/);
  assert.match(locationProblem({ isSecureContext: true, navigator: {} }), /NO LOCATION SERVICE/);
  assert.equal(locationProblem({ isSecureContext: true, navigator: { geolocation } }), null);
  assert.deepEqual(await currentPosition(geolocation), { lat: 51.5, lon: -0.12, accuracy: 8.4 });

  const denied = { getCurrentPosition: (_ok, fail) => fail({ code: 1, message: 'User denied' }) };
  await assert.rejects(currentPosition(denied), (e) => e.code === 1);
  assert.match(locationError({ code: 1 }), /DENIED/);
  assert.match(locationError({ code: 2 }), /NO POSITION/);
  assert.match(locationError({ code: 3 }), /TIMED OUT/);
  assert.match(locationError(new Error('boom')), /BOOM/);
  assert.equal(accuracyText(8.4), '±8 M');
  assert.equal(accuracyText(2500), '±2.5 KM');
  assert.equal(accuracyText(undefined), '');
});
