// What the service worker (public/sw.js) keeps for offline use, and how it answers each request.
// Pure functions, so the rules are tested in Node (test/offline.test.js).

export const CACHE_PREFIX = 'shelter-';
/** Cache names. Bump a version to drop that cache on the next activation. */
export const CACHES = { shell: 'shelter-shell-v1', manual: 'shelter-manual-v1', runtime: 'shelter-runtime-v1' };
/** Served by server.js: { version, files } for the app shell. */
export const SHELL_LIST = '/app-shell.json';
/** How long a network answer may take before the stored copy is used instead. */
export const NETWORK_TIMEOUT_MS = 4000;
/** How often the whole manual is fetched again in the background. */
export const MANUAL_REFRESH_MS = 12 * 3600 * 1000;
/** Most stored figures and other runtime entries; the oldest go first. */
export const RUNTIME_MAX = 300;

const MANUAL_API = /^\/api\/manual(?:\/|$)/;
const FIGURE = /^\/content\/[a-z0-9][a-z0-9-]*\/img\/[^/]+$/;
// Read-only data the interface needs to open, which is safe to show from a stored copy.
const BOOT_DATA = new Set(['/api/settings', '/api/kits/templates']);

/**
 * How the worker handles a request: 'shell' and 'manual' (network first, stored copy offline),
 * 'figure' (stored copy first), or 'network' (never stored: live status, household data, writes,
 * map tiles, the advisor). url: a URL object; origin: the worker's own origin.
 */
export function strategyFor(method, url, origin) {
  if (method !== 'GET' || url.origin !== origin) return 'network';
  const p = url.pathname;
  if (MANUAL_API.test(p)) return 'manual';
  if (BOOT_DATA.has(p)) return 'manual';
  if (p.startsWith('/api/')) return 'network';
  if (FIGURE.test(p)) return 'figure';
  if (p === '/sw.js' || p === SHELL_LIST) return 'network';
  return 'shell';
}

/** Which cache a strategy stores into. */
export const cacheFor = (strategy) => ({ shell: CACHES.shell, manual: CACHES.manual, figure: CACHES.runtime })[strategy] || null;

/** Caches from older versions of this worker, to delete on activation. */
export const staleCaches = (names) => names.filter((n) => n.startsWith(CACHE_PREFIX) && !Object.values(CACHES).includes(n));

/** Every manual URL worth storing, from the manual index: the index, each entry and each section. */
export function manualUrls(index) {
  const list = Array.isArray(index) ? index : [];
  const ids = list.map((a) => a?.id).filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,200}$/.test(id));
  const sections = [...new Set(list.map((a) => a?.category).filter((c) => typeof c === 'string' && c))];
  return ['/api/manual', '/api/kits/templates', ...ids.map((id) => `/api/manual/${id}`), ...sections.map((c) => `/api/manual/section/${encodeURIComponent(c)}`)];
}

/** Whether the stored manual is old enough to fetch again. storedAt: ms timestamp or null. */
export const manualDue = (storedAt, now = Date.now()) => !Number.isFinite(storedAt) || storedAt <= 0 || now - storedAt >= MANUAL_REFRESH_MS;

/**
 * Registers the worker when the browser allows it (a secure context: HTTPS or localhost), then asks
 * it to refresh anything stale. Returns why not, or null once registration was started.
 */
export function registerWorker(env = globalThis) {
  const sw = env.navigator?.serviceWorker;
  if (!sw) return 'this browser has no service workers';
  if (env.isSecureContext === false) return 'offline use needs HTTPS (or localhost)';
  sw.register('/sw.js', { type: 'module', scope: '/' })
    .then(() => sw.ready)
    .then((reg) => reg.active?.postMessage('refresh'))
    .catch(() => { /* no offline copy (e.g. an untrusted certificate); the app still works online */ });
  return null;
}
