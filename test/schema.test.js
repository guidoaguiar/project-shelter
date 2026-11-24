import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validate, str, num, int, date, oneOf, bool, list } from '../server/schema.js';
import { Collection } from '../server/store.js';
import { tmpDir } from './helpers.js';

const parse = (rule, v) => rule.parse(v, 'f');

test('field rules', () => {
  assert.equal(parse(str(5), '  ab  '), 'ab');
  assert.equal(parse(str(5), 12), '12');
  assert.throws(() => parse(str(3), 'abcd'), { status: 400, message: /f: longer than 3/ });
  assert.throws(() => parse(str(3, true), '  '), { message: /required/ });
  assert.throws(() => parse(str(3), {}), { message: /text/ });

  assert.equal(parse(num(0, 10), '4.5'), 4.5);
  assert.equal(parse(num(0, 10, true), ''), null);
  assert.throws(() => parse(num(0, 10), ''), { message: /required/ });
  assert.throws(() => parse(num(0, 10), 11), { message: /between 0 and 10/ });
  assert.throws(() => parse(num(0, 10), 'x'), { message: /number/ });
  assert.throws(() => parse(num(0, 10), true), { message: /number/ });
  assert.throws(() => parse(int(0, 10), 1.5), { message: /whole/ });

  assert.equal(parse(date(), '2026-02-28'), '2026-02-28');
  assert.equal(parse(date(), null), null);
  assert.throws(() => parse(date(), '28/02/2026'), { message: /YYYY-MM-DD/ });
  assert.throws(() => parse(date(false), ''), { message: /required/ });

  assert.equal(parse(oneOf(['a', 'b'], 'a'), ''), 'a');
  assert.throws(() => parse(oneOf(['a', 'b']), 'c'), { message: /one of a, b/ });
  assert.equal(parse(bool(), undefined), false);
  assert.throws(() => parse(bool(), 'yes'), { message: /true or false/ });
});

test('lists: length, item rules, and ids for nested records', () => {
  assert.deepEqual(parse(list(str(3), 2), ['a', 'b']), ['a', 'b']);
  assert.throws(() => parse(list(str(3), 1), ['a', 'b']), { message: /more than 1/ });
  assert.throws(() => parse(list(str(3), 2), ['abcd']), { message: /f\[0\]: longer/ });
  const kept = '0b9f6a1e-1b5c-4c1e-9a55-2f0d5f9b1c11';
  const items = parse(list({ label: str(10, true), done: bool() }, 5), [{ id: kept, label: 'x', extra: 1 }, { id: 'forged', label: 'y', done: true }]);
  assert.equal(items[0].id, kept);
  assert.notEqual(items[1].id, 'forged');
  assert.deepEqual(items.map(({ id, ...rest }) => rest), [{ label: 'x', done: false }, { label: 'y', done: true }]);
  assert.throws(() => parse(list({ label: str(10, true) }, 5), [{}]), { message: /f\[0\]\.label: required/ });
});

test('collection schemas: required fields, defaults, unknown fields dropped, partial updates', () => {
  const s = validate('stores', { name: 'Rice', qty: '5', unit: 'kg', category: 'FOOD', kcal: 3600, secret: 'x' });
  assert.equal(s.qty, 5);
  assert.equal(s.secret, undefined);
  assert.equal(s.expires, null);
  assert.throws(() => validate('stores', { qty: 1 }), { message: /name: required/ });
  assert.throws(() => validate('stores', { name: 'x', qty: -1 }), { message: /qty/ });
  assert.throws(() => validate('stores', { name: 'x', qty: 1, category: 'GOLD' }), { message: /category/ });
  assert.deepEqual(validate('stores', { qty: 2 }, { partial: true }), { qty: 2 });
  assert.throws(() => validate('stores', { name: '' }, { partial: true }), { message: /name: required/ });
  assert.equal(validate('waypoints', { name: 'Home', lat: 1, lon: 2 }).kind, 'other');
  assert.throws(() => validate('waypoints', { name: 'x', lat: 91, lon: 0 }), { message: /lat/ });
  assert.throws(() => validate('notes', []), { status: 400 });
});

test('a collection with a schema validates writes and stops at its limit', (t) => {
  const c = new Collection(path.join(tmpDir(t), 'stores.json'), { schema: 'stores', limit: 2 });
  const a = c.upsert({ name: 'A', qty: 1, junk: true });
  assert.equal(a.junk, undefined);
  assert.throws(() => c.upsert({ qty: 1 }), { status: 400 });
  c.upsert({ name: 'B', qty: 1 });
  assert.throws(() => c.upsert({ name: 'C', qty: 1 }), { status: 409, message: /full/ });
  const u = c.upsert({ qty: 9 }, a.id);
  assert.deepEqual([u.name, u.qty], ['A', 9]);
});
