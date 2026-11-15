// Tiny JSON-file persistence: one file per collection, atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export class Collection {
  constructor(file) { this.file = file; this.items = readJson(file, []); if (!Array.isArray(this.items)) this.items = []; }
  all() { return this.items; }
  upsert(input, id) {
    const now = new Date().toISOString();
    if (id) {
      const i = this.items.findIndex((x) => x.id === id);
      if (i < 0) return null;
      this.items[i] = { ...this.items[i], ...input, id, updated: now };
      writeJson(this.file, this.items);
      return this.items[i];
    }
    const item = { ...input, id: crypto.randomUUID(), created: now, updated: now };
    this.items.push(item);
    writeJson(this.file, this.items);
    return item;
  }
  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) writeJson(this.file, this.items);
    return this.items.length !== before;
  }
}

const DEFAULTS = {
  callsign: 'SHELTER-01',
  lat: null,
  lon: null,
  people: 2,
  ai: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '', apiKey: '' },
};

export class Settings {
  constructor(file) {
    this.file = file;
    const saved = readJson(file, {});
    this.value = { ...DEFAULTS, ...saved, ai: { ...DEFAULTS.ai, ...(saved.ai || {}) } };
  }
  /** Settings as sent to browsers: the API key never leaves the server. */
  public() {
    const { apiKey, ...ai } = this.value.ai;
    return { ...this.value, ai: { ...ai, apiKeySet: !!apiKey } };
  }
  update(input) {
    const v = this.value;
    const num = (x, lo, hi) => (x === null || x === '' || x === undefined || !Number.isFinite(+x) ? null : Math.min(hi, Math.max(lo, +x)));
    if ('callsign' in input) v.callsign = String(input.callsign || '').slice(0, 24).toUpperCase() || DEFAULTS.callsign;
    if ('lat' in input) v.lat = num(input.lat, -90, 90);
    if ('lon' in input) v.lon = num(input.lon, -180, 180);
    if ('people' in input) v.people = Math.round(num(input.people, 1, 999) || 1);
    if (input.ai && typeof input.ai === 'object') {
      const a = input.ai;
      if ('provider' in a) v.ai.provider = a.provider === 'openai' ? 'openai' : 'ollama';
      if ('baseUrl' in a && /^https?:\/\//i.test(String(a.baseUrl))) v.ai.baseUrl = String(a.baseUrl).replace(/\/+$/, '').slice(0, 300);
      if ('model' in a) v.ai.model = String(a.model || '').slice(0, 120);
      if (typeof a.apiKey === 'string') v.ai.apiKey = a.apiKey.slice(0, 400);
    }
    writeJson(this.file, v);
    return this.public();
  }
}
