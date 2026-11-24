import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, Sessions, Limiter, sessionToken, sessionCookie, COOKIE } from '../server/access.js';

test('PIN hashes are salted and verify only the right PIN', () => {
  const a = hashPin('1234'), b = hashPin('1234');
  assert.match(a, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(a, b, 'salted');
  assert.equal(verifyPin('1234', a), true);
  assert.equal(verifyPin('1235', a), false);
  for (const bad of ['', 'plain', 'scrypt$00$11', null]) assert.equal(verifyPin('1234', bad), false);
});

test('sessions expire, and can be revoked or cleared', () => {
  let now = 0;
  const s = new Sessions({ ttl: 1000, now: () => now });
  const t1 = s.create(), t2 = s.create();
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.equal(s.valid(t1), true);
  assert.equal(s.valid(''), false);
  assert.equal(s.valid('nope'), false);
  s.revoke(t1);
  assert.equal(s.valid(t1), false);
  now = 1000;
  assert.equal(s.valid(t2), false, 'expired');
  const t3 = s.create();
  s.clear();
  assert.equal(s.valid(t3), false);
});

test('the limiter blocks after max failures in the window, per key', () => {
  let now = 0;
  const l = new Limiter({ max: 5, windowMs: 600, now: () => now });
  for (let i = 0; i < 5; i++) { assert.equal(l.blocked('a'), false); l.fail('a'); }
  assert.equal(l.blocked('a'), true);
  assert.equal(l.blocked('b'), false);
  now = 601;
  assert.equal(l.blocked('a'), false, 'old failures age out');
  l.fail('a');
  l.reset('a');
  assert.equal(l.blocked('a'), false);
});

test('session cookie round trip', () => {
  const req = { headers: { cookie: `theme=night; ${COOKIE}=abc123; other=1` } };
  assert.equal(sessionToken(req), 'abc123');
  assert.equal(sessionToken({ headers: {} }), '');
  assert.match(sessionCookie('abc'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
  assert.match(sessionCookie(''), /Max-Age=0/);
});
