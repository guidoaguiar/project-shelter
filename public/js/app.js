// Shell: routing, top bar telemetry, display modes.
import { h, api, state, onStatus, refreshStatus, home, toast, isGuest } from './lib/core.js';
import { toMGRS } from './lib/geo.js';

const MODULES = [
  ['command', 'COMMAND'], ['plan', 'PLAN'], ['manual', 'MANUAL'], ['advisor', 'ADVISOR'], ['map', 'MAP'],
  ['tools', 'TOOLS'], ['log', 'LOG'], ['stores', 'STORES'], ['depot', 'DEPOT'],
];
/** A module's two-digit number, from its place in the rail. */
const codeOf = (id) => String(MODULES.findIndex(([m]) => m === id) + 1).padStart(2, '0');
// Modules that hold household data, which guests (devices without the PIN) cannot see.
const HOUSEHOLD = new Set(['plan', 'log', 'stores']);
const THEMES = ['dark', 'night', 'day'];
const $ = (id) => document.getElementById(id);
const view = $('view');
let cleanup = null;
let token = 0;

// ----- display mode -----
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').textContent = t === 'night' ? 'NIGHT' : t.toUpperCase();
  try { localStorage.setItem('shelter.theme', t); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('themechange'));
}
let saved = 'dark';
try { saved = localStorage.getItem('shelter.theme') || 'dark'; } catch { /* storage unavailable */ }
setTheme(THEMES.includes(saved) ? saved : 'dark');
$('theme').addEventListener('click', () => {
  setTheme(THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % THEMES.length]);
});

// ----- rail -----
$('rail').append(...MODULES.map(([id, label], i) =>
  h('a', { href: `#/${id}`, 'data-id': id }, h('span.n', String(i + 1).padStart(2, '0')), label)));

// ----- router -----
async function route() {
  const [, id = 'command', ...rest] = location.hash.split('/');
  const known = MODULES.find(([m]) => m === id);
  if (!known) { location.hash = '#/command'; return; }
  for (const a of $('rail').children) a.classList.toggle('active', a.dataset.id === id);
  const mine = ++token;
  try { cleanup?.(); } catch { /* ignore */ }
  cleanup = null;
  try {
    const mod = await import(`./views/${id}.js`);
    if (mine !== token) return;
    const root = h('div');
    const result = await mod.render(root, decodeURIComponent(rest.join('/')), { code: codeOf(id) });
    if (mine !== token) { result?.(); return; }
    view.replaceChildren(root);
    cleanup = result || null;
    document.title = `${known[1]} // SHELTER`;
  } catch (error) {
    if (mine !== token) return;
    view.replaceChildren(h('div.banner', h('b', 'FAULT'), `Module failed to load: ${error.message}`));
  }
}
window.addEventListener('hashchange', route);

// ----- telemetry -----
const p2 = (n) => String(n).padStart(2, '0');
function tick() {
  const d = new Date();
  $('clock-z').textContent = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
  $('clock-l').textContent = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function led(id, on) { $(id).className = 'led ' + (on ? 'on' : 'off'); }

onStatus(() => {
  const s = state.status;
  const pos = home();
  $('callsign').textContent = state.settings?.callsign || 'FIELD NODE';
  const guest = isGuest();
  $('guest').hidden = !guest;
  for (const a of $('rail').children) a.classList.toggle('locked', guest && HOUSEHOLD.has(a.dataset.id));
  if (guest) $('grid').textContent = 'LOCKED';
  else $('grid').textContent = pos ? (toMGRS(pos.lat, pos.lon, 4) || 'POLAR') : 'NOT SET';
  if (state.lost || !s) {
    led('led-net', false); led('led-ai', false); led('led-dkr', false);
    $('status-left').textContent = 'NODE LINK LOST — RETRYING';
    return;
  }
  led('led-net', s.net.online); led('led-ai', s.ai.online); led('led-dkr', s.docker.online);
  $('status-left').textContent = `NODE ${s.system.host.toUpperCase()} // ${s.server.lanMode ? 'LAN MODE' : 'LOCAL ONLY'} // ${s.net.online ? 'UPLINK AVAILABLE' : 'OFF GRID'}`;
  $('status-right').textContent = `MANUAL ${s.manual.articles} ENTRIES // V${s.server.version}`;
});

// ----- boot -----
tick();
setInterval(tick, 1000);
try { state.settings = await api('/api/settings'); } catch (error) { toast(error.message, true); }
await refreshStatus();
setInterval(refreshStatus, 5000);
if (location.hash) await route();
else location.hash = '#/command'; // the hashchange listener routes
