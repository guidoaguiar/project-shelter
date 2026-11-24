// Access for other devices in LAN mode: PIN hashing, sessions and a limit on wrong PIN attempts.
// The host machine never needs any of this; see role() in server.js.
import crypto from 'node:crypto';

export const PIN_FORMAT = /^\d{4,12}$/;
export const COOKIE = 'shelter_session';
export const SESSION_TTL = 12 * 3600 * 1000;

/** 'scrypt$<salt hex>$<hash hex>' for a PIN. */
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}

/** Whether pin matches a hash from hashPin(). Malformed hashes never match. */
export function verifyPin(pin, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || hashHex?.length !== 64) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** In-memory sessions: a restart signs every device out. */
export class Sessions {
  constructor({ ttl = SESSION_TTL, now = Date.now } = {}) { this.ttl = ttl; this.now = now; this.map = new Map(); }
  create() {
    const token = crypto.randomBytes(32).toString('hex');
    this.map.set(token, this.now() + this.ttl);
    return token;
  }
  valid(token) {
    if (!token) return false;
    const expires = this.map.get(token);
    if (expires === undefined) return false;
    if (expires <= this.now()) { this.map.delete(token); return false; }
    return true;
  }
  revoke(token) { this.map.delete(token); }
  clear() { this.map.clear(); }
}

/** Counts failures per key (a client address) in a sliding window. */
export class Limiter {
  constructor({ max = 5, windowMs = 10 * 60 * 1000, now = Date.now } = {}) { this.max = max; this.windowMs = windowMs; this.now = now; this.map = new Map(); }
  #recent(key) {
    const since = this.now() - this.windowMs;
    const list = (this.map.get(key) || []).filter((t) => t > since);
    if (list.length) this.map.set(key, list); else this.map.delete(key);
    return list;
  }
  blocked(key) { return this.#recent(key).length >= this.max; }
  fail(key) { this.map.set(key, [...this.#recent(key), this.now()]); }
  reset(key) { this.map.delete(key); }
}

/** The session token from a request's cookies, or ''. */
export function sessionToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

/** Set-Cookie value for a session; an empty token clears the cookie. */
export const sessionCookie = (token) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_TTL / 1000 : 0}`;
