// Shared client utilities: DOM builder, API client, app state, formatters.

/** h('div.cls', {attrs}, ...children) — builds DOM without innerHTML. */
export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = null; }
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'value') value = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
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
export const home = () => (state.settings && state.settings.lat != null && state.settings.lon != null
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
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}D ${hr}H` : hr ? `${hr}H ${m}M` : `${m}M`;
}
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const hhmm = (d) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '—');

export function viewHeader(code, title, sub, ...actions) {
  return h('div.vh',
    h('div', h('h1', h('span.n', code), title), sub && h('p', sub)),
    actions.length ? h('div.actions', actions) : null);
}
export function panel(title, code, body, cls = '') {
  return h('section.panel' + (cls ? '.' + cls.split(' ').join('.') : ''),
    h('div.ph', h('span', title), h('span.code', code)), body);
}
export const kv = (k, v, cls) => h('div.kv', h('span.k', k), h('span.v' + (cls ? '.' + cls : ''), v));
export const field = (label, input) => h('label.f', h('span', label), input);

/** Supply readiness from the stores inventory. */
export function readiness(items, people) {
  const p = Math.max(1, +people || 1);
  let waterL = 0, kcal = 0, expired = 0, soon = 0;
  const now = Date.now();
  for (const it of items) {
    const q = +it.qty || 0;
    if (it.category === 'WATER') waterL += it.unit === 'gal' ? q * 3.785 : it.unit === 'L' ? q : 0;
    if (it.category === 'FOOD' && +it.kcal) kcal += q * +it.kcal;
    if (it.expires) {
      const days = (Date.parse(it.expires) - now) / 864e5;
      if (days < 0) expired++; else if (days < 90) soon++;
    }
  }
  return { count: items.length, waterL, kcal, waterDays: waterL / (p * 4), foodDays: kcal / (p * 2000), expired, soon, people: p };
}
