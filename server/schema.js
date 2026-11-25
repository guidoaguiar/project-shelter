// Record schemas: what each collection may store. Validation runs on writes only, so records saved
// before a field existed still load. Unknown fields are dropped; ids are assigned by the server.
import crypto from 'node:crypto';
import { ATTACHMENT_NAME, IMAGE_TYPES, MAX_BYTES, MAX_PER_NOTE } from './attachments.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const invalid = (field, reason) => Object.assign(new Error(`${field}: ${reason}`), { status: 400 });

/**
 * A field rule: parse(value, field) returns the stored value or throws invalid(). `required` fields
 * must be present and non-empty on create; `fallback` is stored on create when the field is missing.
 */
const rule = (parse, { required = false, fallback } = {}) => ({ parse, required, fallback });
const isEmpty = (v) => v === null || v === undefined || v === '';
/** The value for an empty input: null when nullable, else a 'required' error. */
function emptyValue(nullable, f) {
  if (!nullable) throw invalid(f, 'required');
  return null;
}

/** A string of at most max characters, trimmed. Required strings may not be empty. */
export const str = (max, required = false) => rule((v, f) => {
  if (v === null || v === undefined) {
    if (required) throw invalid(f, 'required');
    return '';
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw invalid(f, 'must be text');
  const s = String(v).trim();
  if (required && !s) throw invalid(f, 'required');
  if (s.length > max) throw invalid(f, `longer than ${max} characters`);
  return s;
}, { required, fallback: required ? undefined : '' });

/** A finite number in lo..hi. Numeric strings are accepted. With nullable, '' and null store null. */
export const num = (lo, hi, nullable = false) => rule((v, f) => {
  if (isEmpty(v)) return emptyValue(nullable, f);
  let n = Number.NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') n = Number(v.trim());
  if (!Number.isFinite(n)) throw invalid(f, 'must be a number');
  if (n < lo || n > hi) throw invalid(f, `must be between ${lo} and ${hi}`);
  return n;
}, { required: !nullable, fallback: nullable ? null : undefined });

/** An integer in lo..hi. */
export const int = (lo, hi, nullable = false) => {
  const r = num(lo, hi, nullable);
  const parse = (v, f) => {
    const n = r.parse(v, f);
    if (n !== null && !Number.isInteger(n)) throw invalid(f, 'must be a whole number');
    return n;
  };
  return { ...r, parse };
};

/** A calendar date as YYYY-MM-DD. */
export const date = (nullable = true) => rule((v, f) => {
  if (isEmpty(v)) return emptyValue(nullable, f);
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) throw invalid(f, 'must be a date (YYYY-MM-DD)');
  return v;
}, { required: !nullable, fallback: nullable ? null : undefined });

/** One of a fixed list of values. Without a fallback the field is required. */
export const oneOf = (values, fallback) => rule((v, f) => {
  if (isEmpty(v) && fallback !== undefined) return fallback;
  if (!values.includes(v)) throw invalid(f, `must be one of ${values.join(', ')}`);
  return v;
}, { required: fallback === undefined, fallback });

export const bool = (fallback = false) => rule((v, f) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'boolean') throw invalid(f, 'must be true or false');
  return v;
}, { fallback });

/** A list of at most max items, each checked by item (a rule or an object schema). */
export const list = (item, max) => rule((v, f) => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw invalid(f, 'must be a list');
  if (v.length > max) throw invalid(f, `more than ${max} items`);
  return v.map((x, i) => (item.parse ? item.parse(x, `${f}[${i}]`) : record(item, x, `${f}[${i}]`)));
}, { fallback: [] });

/** A record id (UUID), or null. */
export const uuid = () => rule((v, f) => {
  if (isEmpty(v)) return null;
  if (typeof v !== 'string' || !UUID.test(v)) throw invalid(f, 'must be a record id');
  return v;
}, { fallback: null });

/** A nested object without an id (one fixed part of a document), checked field by field. */
export const obj = (schema) => rule((v, f) => {
  if (v === null || v === undefined) return check(schema, {}, { partial: false, prefix: `${f}.` });
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid(f, 'must be an object');
  return check(schema, v, { partial: false, prefix: `${f}.` });
}, { fallback: check(schema, {}, { partial: false }) });

/** rule made optional, with this value stored on create when the field is missing. */
export const withDefault = (r, fallback) => ({ ...r, required: false, fallback });

/** A nested object with its own schema. List items of this kind get an id when they have none. */
function record(schema, input, prefix) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(prefix, 'must be an object');
  const out = { id: typeof input.id === 'string' && UUID.test(input.id) ? input.id : crypto.randomUUID() };
  return Object.assign(out, check(schema, input, { partial: false, prefix: `${prefix}.` }));
}

function check(schema, input, { partial, prefix = '' }) {
  const out = {};
  for (const [k, r] of Object.entries(schema)) {
    const f = prefix + k;
    if (!Object.hasOwn(input, k) || input[k] === undefined) {
      if (partial) continue;
      if (r.required) throw invalid(f, 'required');
      if (r.fallback !== undefined) out[k] = structuredClone(r.fallback);
      continue;
    }
    out[k] = r.parse(input[k], f);
  }
  return out;
}

export const STORE_CATEGORIES = ['WATER', 'FOOD', 'MEDICAL', 'PET', 'POWER', 'TOOLS', 'COMMS', 'OTHER'];
export const STORE_UNITS = ['ea', 'L', 'gal', 'kg', 'lb', 'pack', 'dose'];
export const WAYPOINT_KINDS = ['home', 'rally', 'water', 'cache', 'shelter', 'medical', 'hazard', 'other'];

export const SCHEMAS = {
  notes: {
    title: str(120), body: str(200_000), tags: list(str(32), 20),
    // Log templates and image attachments (2.6); entries saved before these existed load unchanged.
    template: str(40),
    attachments: list({
      file: rule((v, f) => {
        if (typeof v !== 'string' || !ATTACHMENT_NAME.test(v)) throw invalid(f, 'must be an attachment file name');
        return v;
      }, { required: true }),
      name: str(120), type: oneOf(Object.keys(IMAGE_TYPES)), size: int(0, MAX_BYTES),
    }, MAX_PER_NOTE),
  },
  stores: {
    name: str(80, true), category: oneOf(STORE_CATEGORIES, 'OTHER'), qty: num(0, 1e7), unit: oneOf(STORE_UNITS, 'ea'),
    kcal: num(0, 1e6, true), expires: date(), location: str(60), minQty: num(0, 1e7, true), dailyUse: num(0, 1e5, true), note: str(500),
    lastUsed: date(),
  },
  waypoints: { name: str(60, true), lat: num(-90, 90), lon: num(-180, 180), kind: oneOf(WAYPOINT_KINDS, 'other'), note: str(500) },
};

export const PERSON_GROUPS = ['adult', 'child', 'infant', 'senior'];
export const BLOOD_TYPES = ['unknown', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
export const CONTACT_ROLES = ['out-of-area', 'family', 'neighbour', 'medical', 'utility', 'insurance', 'emergency', 'school-work', 'other'];
export const UTILITY_KINDS = ['gas', 'water', 'electric', 'other'];

SCHEMAS.people = {
  name: str(60, true), kind: oneOf(['person', 'pet'], 'person'), group: str(30), birthYear: int(1900, 2100, true),
  bloodType: oneOf(BLOOD_TYPES, 'unknown'), allergies: str(300), conditions: str(300), needs: str(300),
  medications: list({ name: str(60, true), dose: str(40), schedule: str(60), storeId: uuid() }, 20),
  waterL: num(0, 50, true), kcal: num(0, 10_000, true), notes: str(1000),
};
SCHEMAS.contacts = {
  name: str(60, true), role: oneOf(CONTACT_ROLES, 'other'), phone: str(30), altPhone: str(30), email: str(120),
  radio: str(60), address: str(200), policy: str(60), notes: str(500), onCard: bool(),
};
SCHEMAS.kits = {
  name: str(60, true), template: str(40), location: str(60),
  items: list({ label: str(120, true), done: bool(), storeId: uuid(), note: str(200) }, 200),
  intervalDays: withDefault(int(7, 730), 180), checkedAt: date(), checking: bool(),
};

// ----- map routes and tracks (IMPROVEMENTS 2.3) -----

export const ROUTE_KINDS = ['route', 'track'];
export const MAX_ROUTE_POINTS = 200;
export const MAX_TRACK_POINTS = 10_000;

/** Track points: a list of [lat, lon] or [lat, lon, elevation in m], stored rounded (6 decimals, 0.1 m). */
export const coords = (max) => rule((v, f) => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw invalid(f, 'must be a list');
  if (v.length > max) throw invalid(f, `more than ${max} points`);
  return v.map((p, i) => {
    const ok = Array.isArray(p) && (p.length === 2 || p.length === 3) && p.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!ok || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180 || (p.length === 3 && Math.abs(p[2]) > 20_000)) throw invalid(`${f}[${i}]`, 'must be [lat, lon] or [lat, lon, elevation]');
    const c = [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
    if (p.length === 3) c.push(Math.round(p[2] * 10) / 10);
    return c;
  });
}, { fallback: [] });

/** A route is an ordered list of waypoints; a track is a recorded line of points (from GPX). */
SCHEMAS.routes = {
  name: str(60, true), kind: oneOf(ROUTE_KINDS, 'route'),
  waypointIds: list(uuid(), MAX_ROUTE_POINTS), track: coords(MAX_TRACK_POINTS), notes: str(500),
};

const place = { label: str(80), waypointId: uuid(), notes: str(300) };
/** The household plan: one document, not a collection. */
SCHEMAS.plan = {
  alerts: str(1000),
  meeting: obj({ home: obj(place), neighbourhood: obj(place), outOfTown: obj(place) }),
  routes: list({ name: str(60, true), waypointIds: list(uuid(), 50), notes: str(300) }, 10),
  shelter: obj({ room: str(80), notes: str(1000) }),
  utilities: list({ kind: oneOf(UTILITY_KINDS, 'other'), location: str(120), howTo: str(500), tool: str(80) }, 20),
  documents: str(1000),
  reviewedAt: date(),
  reviewEveryDays: withDefault(int(30, 730), 365),
};

// ----- power and situation (IMPROVEMENTS 2.1 and 2.7) -----

/** A date and time (ISO 8601), or null. */
const instant = () => rule((v, f) => {
  if (isEmpty(v)) return null;
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw invalid(f, 'must be a date and time');
  return v;
}, { fallback: null });

/** Power settings, kept inside settings.power: low-power mode and the power budget in Tools. */
SCHEMAS.power = {
  lowPower: bool(),
  batteryWh: num(0, 1e6, true), usablePct: withDefault(num(10, 100), 80), efficiency: withDefault(num(50, 100), 90),
  solarW: num(0, 1e5, true), sunHours: withDefault(num(0, 24), 4),
  devices: list({ name: str(40, true), watts: num(0, 1e5), hours: num(0, 24), qty: withDefault(int(1, 999), 1) }, 40),
};

/** The household check-in: one document. Each person is marked accounted for, with the time. */
SCHEMAS.checkin = {
  startedAt: instant(),
  allOk: bool(),
  people: list({ personId: uuid(), name: str(60, true), ok: bool(), at: instant() }, 120),
};

/** Most records each collection may hold. */
export const LIMITS = { notes: 5000, stores: 10_000, waypoints: 5000, people: 100, contacts: 500, kits: 100, routes: 500 };

/** The stored form of input for collection name. partial: an update, where missing fields keep their values. */
export function validate(name, input, { partial = false } = {}) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error(`no schema for ${name}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(name, 'must be an object');
  return check(schema, input, { partial });
}
