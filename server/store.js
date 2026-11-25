// Tiny JSON-file persistence: one file per collection, atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validate, LIMITS } from './schema.js';
import { hashPin, PIN_FORMAT } from './access.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

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
  /** schema: a collection name in server/schema.js. Without one, records are stored as given. */
  constructor(file, { schema, limit } = {}) {
    this.file = file;
    this.schema = schema;
    this.limit = limit ?? (schema ? LIMITS[schema] : Infinity);
    this.items = readJson(file, []);
    if (!Array.isArray(this.items)) this.items = [];
  }
  all() { return this.items; }
  /** Creates a record, or updates the one with this id (null when there is none). Throws a 400 or 409 error on bad input. */
  upsert(input, id) {
    const now = new Date().toISOString();
    if (id) {
      const i = this.items.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const clean = this.schema ? validate(this.schema, input, { partial: true }) : input;
      this.items[i] = { ...this.items[i], ...clean, id, updated: now };
      writeJson(this.file, this.items);
      return this.items[i];
    }
    if (this.items.length >= this.limit) throw fail(409, `${this.schema || 'collection'} is full (${this.limit} items)`);
    const clean = this.schema ? validate(this.schema, input) : input;
    const item = { ...clean, id: crypto.randomUUID(), created: now, updated: now };
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
  /** Rewrites every record through fn (record -> record), saving only when something changed. */
  rewrite(fn) {
    let changed = false;
    this.items = this.items.map((x) => {
      const y = fn(x);
      changed ||= y !== x;
      return y;
    });
    if (changed) writeJson(this.file, this.items);
    return changed;
  }
  /**
   * Restores records from a backup. merge: add new ids, replace a record only when the backup's copy
   * is newer. replace: the backup's records become the collection. Returns counts; dryRun writes nothing.
   */
  restore(records, mode, dryRun = false) {
    const report = { add: 0, update: 0, skip: 0, remove: 0, invalid: 0 };
    const incoming = [];
    for (const r of Array.isArray(records) ? records : []) {
      const clean = fromBackup(r, this.schema);
      if (clean) incoming.push(clean); else report.invalid++;
    }
    const next = mode === 'replace' ? this.#replaced(incoming, report) : this.#merged(incoming, report);
    if (!dryRun) { this.items = next; writeJson(this.file, this.items); }
    return report;
  }
  #replaced(incoming, report) {
    const next = incoming.slice(0, this.limit);
    report.invalid += incoming.length - next.length;
    const had = new Set(this.items.map((x) => x.id));
    for (const r of next) report[had.has(r.id) ? 'update' : 'add']++;
    const kept = new Set(next.map((r) => r.id));
    report.remove = this.items.filter((x) => !kept.has(x.id)).length;
    return next;
  }
  #merged(incoming, report) {
    const next = [...this.items];
    const at = new Map(next.map((x, i) => [x.id, i]));
    for (const r of incoming) {
      const i = at.get(r.id);
      if (i === undefined) {
        if (next.length >= this.limit) { report.invalid++; continue; }
        at.set(r.id, next.length);
        next.push(r);
        report.add++;
      } else if ((r.updated || '') > (next[i].updated || '')) {
        next[i] = r;
        report.update++;
      } else {
        report.skip++;
      }
    }
    return next;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stamp = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString());

/** A backup record checked like a new one, keeping its id and timestamps when they are well formed; null when invalid. */
function fromBackup(r, schema) {
  if (!r || typeof r !== 'object' || !UUID.test(r.id || '')) return null;
  let clean;
  try { clean = schema ? validate(schema, r) : { ...r }; } catch { return null; }
  return { ...clean, id: r.id, created: stamp(r.created), updated: stamp(r.updated) };
}

/** One JSON document with a schema, such as the household plan. */
export class Doc {
  constructor(file, schema) {
    this.file = file;
    this.schema = schema;
    const saved = readJson(file, null);
    this.value = { ...validate(schema, {}), ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
  }
  get() { return this.value; }
  /** Changes the fields present in input; each top-level field is replaced as a whole. */
  update(input) {
    const clean = validate(this.schema, input, { partial: true });
    this.value = { ...this.value, ...clean, updated: new Date().toISOString() };
    writeJson(this.file, this.value);
    return this.value;
  }
  /** Replaces the whole document (a restore). Throws a 400 error when it is invalid. */
  replace(input) {
    this.value = { ...validate(this.schema, input || {}), updated: typeof input?.updated === 'string' ? input.updated : new Date().toISOString() };
    writeJson(this.file, this.value);
    return this.value;
  }
}

export const LAN_POLICIES = ['open', 'pin', 'readonly'];

const DEFAULTS = {
  callsign: 'SHELTER-01',
  lat: null,
  lon: null,
  people: 2,
  expiryWarnDays: 90,
  lastBackup: null,
  power: validate('power', {}), // low-power mode and the power budget (server/schema.js)
  // SHELTER_AI_URL changes the default only; a URL saved under Configuration wins.
  // householdContext: the host allows the Advisor to see people, allergies and medications (local model servers only).
  // embedModel: embedding model for Advisor retrieval; '' picks an installed one automatically.
  ai: { provider: 'ollama', baseUrl: process.env.SHELTER_AI_URL || 'http://127.0.0.1:11434', model: '', apiKey: '', householdContext: false, embedModel: '' },
};

export class Settings {
  /**
   * fresh: no earlier data exists (a new install). The LAN write policy then defaults to 'pin',
   * which with no PIN set keeps other devices read-only; an upgraded install keeps 'open'.
   */
  constructor(file, { fresh = false } = {}) {
    this.file = file;
    const saved = readJson(file, {});
    this.value = { ...DEFAULTS, ...saved, ai: { ...DEFAULTS.ai, ...saved.ai }, power: { ...DEFAULTS.power, ...saved.power } };
    if (!saved.access || !LAN_POLICIES.includes(saved.access.lanWrites)) {
      this.value.access = { lanWrites: fresh ? 'pin' : 'open', pinHash: saved.access?.pinHash || '' };
      writeJson(file, this.value); // the default is decided once, then kept
    }
  }
  /** Settings as sent to browsers: the API key and PIN hash never leave the server; guests get no home position. */
  public(role = 'host') {
    const { apiKey, ...ai } = this.value.ai;
    const { pinHash, lanWrites } = this.value.access;
    const out = { ...this.value, ai: { ...ai, apiKeySet: !!apiKey }, access: { lanWrites, pinSet: !!pinHash } };
    if (role === 'guest') { out.lat = null; out.lon = null; }
    return out;
  }
  markBackup() {
    this.value.lastBackup = new Date().toISOString();
    writeJson(this.file, this.value);
  }
  /** Applies a change from a client with the given role. Model and access settings need the host. */
  update(input, role = 'host') {
    if (role !== 'host' && ('ai' in input || 'access' in input)) throw fail(403, 'model and access settings can only be changed on the host machine');
    const power = 'power' in input ? validate('power', input.power, { partial: true }) : null; // throws before anything changes
    if (input.access && typeof input.access === 'object') updateAccess(this.value.access, input.access);
    const v = this.value;
    if (power) v.power = { ...v.power, ...power };
    if ('callsign' in input) v.callsign = String(input.callsign || '').slice(0, 24).toUpperCase() || DEFAULTS.callsign;
    if ('lat' in input) v.lat = clampOrNull(input.lat, -90, 90);
    if ('lon' in input) v.lon = clampOrNull(input.lon, -180, 180);
    if ('people' in input) v.people = Math.round(clampOrNull(input.people, 1, 999) || 1);
    if ('expiryWarnDays' in input) v.expiryWarnDays = Math.round(clampOrNull(input.expiryWarnDays, 7, 365) || DEFAULTS.expiryWarnDays);
    if (input.ai && typeof input.ai === 'object') updateAi(v.ai, input.ai);
    writeJson(this.file, v);
    return this.public(role);
  }
}

/** The settings a backup carries and a restore brings back: never model, access or backup state. */
export const PORTABLE_SETTINGS = ['callsign', 'lat', 'lon', 'people', 'expiryWarnDays', 'power'];

/** pin: a new PIN, or '' to remove it. lanWrites: the policy; 'pin' needs a PIN. Validated before anything changes. */
function updateAccess(access, a) {
  let { pinHash, lanWrites } = access;
  if ('pin' in a) {
    const pin = String(a.pin ?? '');
    if (pin && !PIN_FORMAT.test(pin)) throw fail(400, 'the PIN must be 4 to 12 digits');
    pinHash = pin ? hashPin(pin) : '';
  }
  if ('lanWrites' in a) {
    if (!LAN_POLICIES.includes(a.lanWrites)) throw fail(400, `lanWrites must be one of ${LAN_POLICIES.join(', ')}`);
    if (a.lanWrites === 'pin' && !pinHash) throw fail(400, 'set a PIN first');
    lanWrites = a.lanWrites;
  }
  Object.assign(access, { pinHash, lanWrites });
}

/** x as a number limited to lo..hi, or null when it is empty or not a number. */
function clampOrNull(x, lo, hi) {
  if (x === null || x === '' || x === undefined || !Number.isFinite(+x)) return null;
  return Math.min(hi, Math.max(lo, +x));
}

/** s without trailing slashes. A loop, not /\/+$/, which is quadratic on a long run of slashes. */
function stripTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

function updateAi(ai, a) {
  const before = `${ai.provider}|${ai.baseUrl}`;
  if ('provider' in a) ai.provider = a.provider === 'openai' ? 'openai' : 'ollama';
  if ('baseUrl' in a && /^https?:\/\//i.test(String(a.baseUrl))) ai.baseUrl = stripTrailingSlashes(String(a.baseUrl)).slice(0, 300);
  if ('model' in a) ai.model = String(a.model || '').slice(0, 120);
  if ('householdContext' in a) ai.householdContext = a.householdContext === true;
  if ('embedModel' in a) ai.embedModel = String(a.embedModel || '').trim().slice(0, 120);
  if (typeof a.apiKey === 'string') ai.apiKey = a.apiKey.slice(0, 400);
  // A key is only ever sent to the server it was entered for.
  else if (`${ai.provider}|${ai.baseUrl}` !== before) ai.apiKey = '';
}
