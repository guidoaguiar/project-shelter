import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, duration, pad, hhmm, readiness } from '../public/js/lib/core.js';

test('bytes, duration and clock formatting', () => {
  assert.deepEqual([0, 1023, 1024, 1_500_000, 5e12, Number.NaN].map(bytes), ['0 B', '1023 B', '1.0 KB', '1.4 MB', '4.5 TB', '—']);
  assert.deepEqual([0, 59, 60, 3661, 90_061].map(duration), ['0M', '0M', '1M', '1H 1M', '1D 1H']);
  assert.equal(pad(7), '07');
  assert.equal(hhmm(new Date(2024, 0, 1, 5, 3)), '05:03');
  assert.equal(hhmm(null), '—');
});

test('readiness: water in L and gal, food kcal, expiry', () => {
  const day = 864e5, now = Date.now();
  const r = readiness([
    { category: 'WATER', unit: 'gal', qty: 2 },
    { category: 'WATER', unit: 'L', qty: '5' },
    { category: 'WATER', unit: 'bottles', qty: 9 }, // unknown unit: not counted
    { category: 'FOOD', kcal: 100, qty: 3, expires: new Date(now - 2 * day).toISOString() },
    { category: 'FOOD', qty: 3, expires: new Date(now + 30 * day).toISOString() }, // no kcal figure
    { category: 'GEAR', expires: new Date(now + 200 * day).toISOString() },
    { category: 'GEAR', expires: 'not a date' },
  ], 2);
  assert.ok(Math.abs(r.waterL - (2 * 3.785 + 5)) < 1e-9);
  assert.equal(r.kcal, 300);
  assert.ok(Math.abs(r.waterDays - r.waterL / 8) < 1e-9);
  assert.equal(r.foodDays, 300 / 4000);
  assert.equal(r.expired, 1);
  assert.equal(r.soon, 1);
  assert.equal(r.count, 7);
});

test('readiness: group size defaults to at least one person', () => {
  assert.equal(readiness([], 0).people, 1);
  assert.equal(readiness([], 'x').people, 1);
  assert.equal(readiness([], '3').people, 3);
});
