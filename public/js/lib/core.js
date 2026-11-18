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

/** Supply readiness from the stores inventory. */
export function readiness(items, people) {
  const p = Math.max(1, +people || 1);
  const now = Date.now();
  const daysLeft = items.filter((it) => it.expires).map((it) => (Date.parse(it.expires) - now) / 864e5);
  const waterL = items.reduce((s, it) => s + waterLitres(it), 0);
  const kcal = items.reduce((s, it) => s + foodKcal(it), 0);
  return {
    count: items.length, waterL, kcal, waterDays: waterL / (p * 4), foodDays: kcal / (p * 2000),
    expired: daysLeft.filter((d) => d < 0).length, soon: daysLeft.filter((d) => d >= 0 && d < 90).length, people: p,
  };
}
