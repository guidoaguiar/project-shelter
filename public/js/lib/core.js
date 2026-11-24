// Shared client utilities: DOM builder, API client, app state, formatters.

const isAttrs = (a) => a != null && typeof a === 'object' && !(a instanceof Node) && !Array.isArray(a);

/** Applies one h() attribute: on* listeners, raw html, extra classes, inline style, or a plain attribute. */
function setAttr(el, k, v) {
  if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
  else if (k === 'html') el.innerHTML = v;
  else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
  else if (k === 'style') el.style.cssText = v;
  else el.setAttribute(k, v === true ? '' : v);
}

/** h('div.cls', {attrs}, ...children) — builds DOM without innerHTML. */
export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (!isAttrs(attrs)) { kids.unshift(attrs); attrs = null; }
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') value = v; // set last, once a <select> has its options
    else setAttr(el, k, v);
  }
  appendKids(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}

/** Appends nodes and text, at any nesting depth; null, undefined and false are skipped. */
function appendKids(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method };
  if (method !== 'GET') { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body ?? {}); }
  let r;
  try { r = await fetch(path, init); } catch { throw new Error('node unreachable'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export const state = { settings: null, status: null, lost: false };
const listeners = new Set();
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export async function refreshStatus() {
  try { state.status = await api('/api/status'); state.lost = false; } catch { state.lost = true; }
  for (const fn of listeners) fn();
}
export async function saveSettings(patch) {
  state.settings = await api('/api/settings', { method: 'PUT', body: patch });
  await refreshStatus();
  return state.settings;
}
export const home = () => (state.settings?.lat != null && state.settings.lon != null
  ? { lat: state.settings.lat, lon: state.settings.lon } : null);

// ----- access: host, member or guest (the server decides and enforces; the interface only follows) -----
export const access = () => state.status?.access || { role: 'guest', lanWrites: 'readonly', pinSet: false };
export const isHost = () => access().role === 'host';
export const isGuest = () => access().role === 'guest';

/** Reloads settings and status after a sign-in or sign-out, then redraws the current view. */
async function accessChanged() {
  state.settings = await api('/api/settings');
  await refreshStatus();
  window.dispatchEvent(new Event('hashchange'));
}
export async function signIn(pin) {
  await api('/api/session', { method: 'POST', body: { pin } });
  await accessChanged();
}
export async function signOut() {
  await api('/api/session', { method: 'DELETE' });
  await accessChanged();
}

/** Why this device cannot see household data, with a PIN form when a PIN would help. */
export function pinForm() {
  const a = access();
  if (a.lanWrites === 'readonly') return h('p.hint', 'Household data is only available on the host machine.');
  if (!a.pinSet) {
    return h('p.hint', 'No PIN has been set yet. Set one on the host machine under Command, Configuration, or run the "pin" command there (see the README).');
  }
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 12, placeholder: 'PIN', 'aria-label': 'PIN', style: 'max-width:160px' });
  return h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try { await signIn(pin.value.trim()); toast('SIGNED IN'); } catch (error) { pin.value = ''; toast(error.message, true); }
    },
  }, h('div.row', { style: 'flex-wrap:nowrap' }, pin, h('button.btn.primary', 'ENTER')));
}

/** The whole view, for a module that holds household data, when this device is a guest. */
export function lockedView(code, title) {
  return [
    viewHeader(code, title, 'Household data. Enter the PIN to see it.'),
    panel('LOCKED', 'ACC', h('div.pb',
      h('p', { style: 'font:14px/1.6 var(--sans);margin:0 0 12px' }, 'Notes, supplies, kits, the household plan, waypoints and the home position are only shown to devices that have entered the PIN. The manual, map, tools and advisor work without it.'),
      pinForm())),
  ];
}

let toastTimer;
export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isError ? 5000 : 2200);
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function duration(sec) {
  const d = Math.floor(sec / 86_400), hr = Math.floor((sec % 86_400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}D ${hr}H`;
  if (hr) return `${hr}H ${m}M`;
  return `${m}M`;
}
export const pad = (n, w = 2) => String(n).padStart(w, '0');
/** "1 pet", "2 pets". */
export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
export const hhmm = (d) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '—');

export function viewHeader(code, title, sub, ...actions) {
  return h('div.vh',
    h('div', h('h1', h('span.n', code), title), sub && h('p', sub)),
    actions.length ? h('div.actions', actions) : null);
}
export function panel(title, code, body, cls = '') {
  return h('section.panel' + (cls ? '.' + cls.replaceAll(' ', '.') : ''),
    h('div.ph', h('span', title), h('span.code', code)), body);
}
export const kv = (k, v, cls) => h('div.kv', h('span.k', k), h('span.v' + (cls ? '.' + cls : ''), v));
export const field = (label, input) => h('label.f', h('span', label), input);

const LITRES_PER = { L: 1, gal: 3.785 };

/** Litres of water in a stores item (WATER items measured in L or gal), else 0. */
const waterLitres = (it) => (it.category === 'WATER' ? (+it.qty || 0) * (LITRES_PER[it.unit] ?? 0) : 0);
/** Calories in a stores item (FOOD items with a kcal-per-unit figure), else 0. */
const foodKcal = (it) => (it.category === 'FOOD' && +it.kcal ? (+it.qty || 0) * +it.kcal : 0);

export const WATER_PER_PERSON = 4; // litres per day
export const KCAL_PER_PERSON = 2000;
const DAY = 864e5;
/** Whether a per-person figure was filled in. */
const set = (v) => v != null && v !== '' && Number.isFinite(+v);

/** Days until a date (negative once past), or null without a valid date. */
export function daysUntil(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (t - now) / DAY;
}

/** Days a stores item lasts at its daily use, or null when it has none. */
export const daysLeft = (it) => (+it.dailyUse > 0 ? (+it.qty || 0) / +it.dailyUse : null);
/** Whether a stores item is at or below its minimum quantity. */
export const isLow = (it) => it.minQty != null && it.minQty !== '' && (+it.qty || 0) <= +it.minQty;

/**
 * The household's daily needs. household: people records (people and pets) from the plan, or, when
 * there are none, a group size: that many adults, as before the plan existed.
 */
export function needs(household) {
  const list = Array.isArray(household) && household.length ? household : null;
  if (!list) {
    const n = Math.max(1, Math.round(+household) || 1);
    return { people: n, pets: 0, petsMissingWater: 0, waterL: n * WATER_PER_PERSON, kcal: n * KCAL_PER_PERSON };
  }
  const humans = list.filter((p) => p.kind !== 'pet'), pets = list.filter((p) => p.kind === 'pet');
  return {
    people: humans.length,
    pets: pets.length,
    // A pet's water need has no default: an animal's size changes it too much to guess.
    petsMissingWater: pets.filter((p) => !set(p.waterL)).length,
    waterL: humans.reduce((s, p) => s + (set(p.waterL) ? +p.waterL : WATER_PER_PERSON), 0) + pets.reduce((s, p) => s + (set(p.waterL) ? +p.waterL : 0), 0),
    kcal: humans.reduce((s, p) => s + (set(p.kcal) ? +p.kcal : KCAL_PER_PERSON), 0),
  };
}

/**
 * Supply readiness from the stores inventory. household: see needs(). warnDays: items expiring
 * within this many days count as due soon.
 */
export function readiness(items, household, { warnDays = 90 } = {}) {
  const now = Date.now();
  const need = needs(household);
  const left = items.map((it) => daysUntil(it.expires, now)).filter((d) => d !== null);
  const waterL = items.reduce((s, it) => s + waterLitres(it), 0);
  const kcal = items.reduce((s, it) => s + foodKcal(it), 0);
  const meds = items.filter((it) => it.category === 'MEDICAL' && daysLeft(it) !== null)
    .map((it) => ({ name: it.name, days: daysLeft(it) })).sort((a, b) => a.days - b.days);
  return {
    count: items.length, waterL, kcal,
    waterDays: need.waterL ? waterL / need.waterL : 0,
    foodDays: need.kcal ? kcal / need.kcal : 0,
    expired: left.filter((d) => d < 0).length, soon: left.filter((d) => d >= 0 && d < warnDays).length,
    low: items.filter(isLow).length,
    meds: meds[0] || null,
    people: need.people, pets: need.pets, petsMissingWater: need.petsMissingWater, warnDays,
  };
}

// ----- printing: clean pages built for paper, not the live view -----

/**
 * Prints title and nodes on their own: the app is hidden and the print stylesheet applies.
 * Each node with class "page" starts a new sheet.
 */
export function printDoc(title, ...nodes) {
  const box = document.getElementById('print');
  const stamp = `${state.settings?.callsign || 'SHELTER'} · printed ${new Date().toLocaleString()}`;
  box.replaceChildren(h('header.print-head', h('b', title), h('span', stamp)), ...nodes.flat());
  box.hidden = false;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); box.hidden = true; box.replaceChildren(); };
  window.addEventListener('afterprint', done, { once: true });
  // Let figures load before the print dialog takes its snapshot.
  const images = [...box.querySelectorAll('img')].filter((img) => !img.complete);
  Promise.all(images.map((img) => new Promise((ok) => { img.onload = ok; img.onerror = ok; })))
    .then(() => window.print())
    .catch(done);
}

/** A PRINT button. */
export const printButton = (onclick, label = 'PRINT') => h('button.btn.ghost', { type: 'button', onclick }, label);
