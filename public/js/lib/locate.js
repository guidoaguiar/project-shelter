// "Use this device's location": the phone's or laptop's own GPS / location service.
// Browsers only allow it in a secure context (HTTPS or localhost), so over plain-HTTP LAN it explains why not.
import { h, toast } from './core.js';

/** Why the location service cannot be used here, or null when it can. env: window, or a stand-in in tests. */
export function locationProblem(env = globalThis) {
  if (env.isSecureContext === false) {
    const loc = env.location || {};
    const port = loc.port ? `:${loc.port}` : '';
    return `LOCATION NEEDS HTTPS: this page is plain HTTP, so the browser blocks GPS. Start Shelter with --https (or SHELTER_HTTPS=1) and open https://${loc.hostname || 'this-node'}${port}, or use localhost on the node itself.`;
  }
  if (!env.navigator?.geolocation) return 'THIS BROWSER HAS NO LOCATION SERVICE';
  return null;
}

/** A readable message for a GeolocationPositionError (code 1 denied, 2 unavailable, 3 timeout). */
export function locationError(error) {
  switch (error?.code) {
    case 1: return 'LOCATION PERMISSION DENIED: allow location for this site in the browser settings';
    case 2: return 'NO POSITION FIX: move to open sky or turn on location services';
    case 3: return 'LOCATION TIMED OUT: try again in the open';
    default: return `LOCATION FAILED: ${String(error?.message || 'unknown error').toUpperCase()}`;
  }
}

/** One position fix: { lat, lon, accuracy (m) }. geo: navigator.geolocation. */
export function currentPosition(geo, { timeout = 20_000, maximumAge = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout, maximumAge });
  });
}

/** "±12 M" style accuracy, or '' when unknown. */
export function accuracyText(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? `±${Math.round(m)} M` : `±${(m / 1000).toFixed(1)} KM`;
}

/**
 * A map control button that asks this device for its position and calls onFix({ lat, lon, accuracy }).
 * In an insecure context it stays visible and explains what to do instead.
 */
export function locateButton(onFix, env = globalThis) {
  const problem = locationProblem(env);
  const btn = h('button.btn' + (problem ? '.ghost' : ''), {
    type: 'button',
    title: problem ? 'Use this device\'s location (needs HTTPS)' : 'Use this device\'s location',
    'aria-label': 'Use this device\'s location',
    onclick: async () => {
      const now = locationProblem(env);
      if (now) { toast(now, true); return; }
      btn.disabled = true;
      toast('LOCATING…');
      try {
        const fix = await currentPosition(env.navigator.geolocation);
        onFix(fix);
        toast(`POSITION FIXED ${accuracyText(fix.accuracy)}`.trim());
      } catch (error) { toast(locationError(error), true); } finally { btn.disabled = false; }
    },
  }, '◎');
  return btn;
}
