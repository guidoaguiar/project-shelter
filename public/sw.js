// Shelter service worker: keeps the app shell and the whole field manual on the device, so a phone
// that has opened Shelter once can still read the manual (and use the tools) away from the node.
// Network first with a short timeout: on the home network the node is always the source of truth.
// Live status, household data, map tiles and the advisor are never stored here.
import { CACHES, SHELL_LIST, NETWORK_TIMEOUT_MS, RUNTIME_MAX, strategyFor, cacheFor, staleCaches, manualUrls, manualDue } from './js/lib/offline.js';

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const MANUAL_STAMP = '/__shelter/manual-stored-at';
const SHELL_STAMP = '/__shelter/shell-version';

/** fetch() that gives up after ms, so a weak Wi-Fi link falls back to the stored copy quickly. */
async function fetchSoon(request, ms = NETWORK_TIMEOUT_MS) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try { return await fetch(request, { signal: abort.signal }); } finally { clearTimeout(timer); }
}

const storable = (res) => res?.ok && res.type === 'basic';

/** Fetches each URL into cache, a few at a time. Failures are skipped: what is stored stays. */
async function storeAll(cacheName, urls, width = 4) {
  const cache = await caches.open(cacheName);
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- a few parallel workers, each one request at a time
        const res = await fetchSoon(url, 20_000);
        // eslint-disable-next-line no-await-in-loop -- as above
        if (storable(res)) await cache.put(url, res);
      } catch { /* offline or gone: keep the stored copy */ }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}

/** Stores every shell file when the node's shell version differs from the stored one. */
async function storeShell() {
  const { version, files } = await (await fetchSoon(SHELL_LIST, 20_000)).json();
  const cache = await caches.open(CACHES.shell);
  const stamp = await cache.match(SHELL_STAMP);
  if (stamp && (await stamp.text()) === version) return;
  await storeAll(CACHES.shell, files);
  await cache.put(SHELL_STAMP, new Response(String(version)));
}

/** Stores the manual index, every entry and every section, at most every MANUAL_REFRESH_MS unless forced. */
async function storeManual(force = false) {
  const cache = await caches.open(CACHES.manual);
  const stamp = await cache.match(MANUAL_STAMP);
  if (!force && !manualDue(stamp ? Number(await stamp.text()) : null)) return;
  let index;
  try { index = await (await fetchSoon('/api/manual', 20_000)).json(); } catch { return; }
  await storeAll(CACHES.manual, manualUrls(index));
  await cache.put(MANUAL_STAMP, new Response(String(Date.now())));
}

/** Drops the oldest runtime entries beyond RUNTIME_MAX. */
async function trimRuntime() {
  const cache = await caches.open(CACHES.runtime);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - RUNTIME_MAX)).map((k) => cache.delete(k)));
}

/** Network first; on failure or timeout the stored copy; for a page load, the stored app. */
async function networkFirst(event, cacheName) {
  const { request } = event;
  try {
    const res = await fetchSoon(request);
    if (storable(res)) {
      const copy = res.clone();
      event.waitUntil(caches.open(cacheName).then((c) => c.put(request, copy)));
    }
    return res;
  } catch (error) {
    const stored = await caches.match(request, { ignoreVary: true });
    if (stored) return stored;
    if (request.mode === 'navigate') {
      const app = await caches.match('/', { cacheName: CACHES.shell });
      if (app) return app;
    }
    throw error;
  }
}

/** Stored copy first (figures do not change), else the network, stored for next time. */
async function cacheFirst(event, cacheName) {
  const stored = await caches.match(event.request);
  if (stored) return stored;
  const res = await fetch(event.request);
  if (storable(res)) {
    const copy = res.clone();
    event.waitUntil(caches.open(cacheName).then((c) => c.put(event.request, copy)).then(trimRuntime));
  }
  return res;
}

sw.addEventListener('install', (event) => {
  event.waitUntil(storeShell().catch(() => { /* the shell is also stored as pages are used */ }).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all(staleCaches(await caches.keys()).map((n) => caches.delete(n)));
    await sw.clients.claim();
    await storeManual(true);
  })());
});

sw.addEventListener('message', (event) => {
  // The page asks on each start; the worker only refreshes what is older than MANUAL_REFRESH_MS.
  if (event.data === 'refresh') event.waitUntil(Promise.all([storeManual(false), storeShell().catch(() => {})]));
});

sw.addEventListener('fetch', (event) => {
  const strategy = strategyFor(event.request.method, new URL(event.request.url), sw.location.origin);
  if (strategy === 'network') return; // the browser handles it as if there were no worker
  const cacheName = cacheFor(strategy);
  event.respondWith(strategy === 'figure' ? cacheFirst(event, cacheName) : networkFirst(event, cacheName));
});
