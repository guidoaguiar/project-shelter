import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Collection, Settings } from '../server/store.js';
import { tmpDir } from './helpers.js';

test('collections create, update, remove and persist', (t) => {
  const file = path.join(tmpDir(t), 'sub', 'notes.json');
  const c = new Collection(file);
  const a = c.upsert({ title: 'one' });
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(c.upsert({ title: 'two' }, a.id).title, 'two');
  assert.equal(c.upsert({}, 'missing'), null);
  assert.deepEqual(new Collection(file).all().map((x) => x.title), ['two']);
  assert.equal(c.remove(a.id), true);
  assert.equal(c.remove(a.id), false);
  assert.deepEqual(new Collection(file).all(), []);
});

test('a corrupt or non-array file starts empty', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  fs.writeFileSync(path.join(dir, 'obj.json'), '{"a":1}');
  assert.deepEqual(new Collection(path.join(dir, 'bad.json')).all(), []);
  assert.deepEqual(new Collection(path.join(dir, 'obj.json')).all(), []);
});

test('settings are validated and the API key never leaves', (t) => {
  const file = path.join(tmpDir(t), 'settings.json');
  const s = new Settings(file);
  let v = s.update({ callsign: 'alpha', lat: '12.5', lon: 500, people: '0' });
  assert.equal(v.callsign, 'ALPHA');
  assert.equal(v.lat, 12.5);
  assert.equal(v.lon, 180);
  assert.equal(v.people, 1);
  v = s.update({ callsign: '', lat: '', ai: { provider: 'openai', baseUrl: 'https://models.example///', model: 'm', apiKey: 'secret' } });
  assert.equal(v.callsign, 'SHELTER-01');
  assert.equal(v.lat, null);
  assert.equal(v.ai.baseUrl, 'https://models.example');
  assert.equal(v.ai.apiKey, undefined);
  assert.equal(v.ai.apiKeySet, true);
  s.update({ ai: { provider: 'openai', baseUrl: 'https://models.example', model: 'other' } });
  assert.equal(new Settings(file).value.ai.apiKey, 'secret', 'kept on disk while the server stays the same');
  v = s.update({ ai: { provider: 'other', baseUrl: 'ftp://nope' } });
  assert.equal(v.ai.provider, 'ollama');
  assert.equal(v.ai.baseUrl, 'https://models.example');
  assert.equal(v.ai.apiKeySet, false, 'a key is dropped when the server it was entered for changes');
});

test('the API key is dropped when the model URL changes, unless a new key comes with it', (t) => {
  const s = new Settings(path.join(tmpDir(t), 's.json'));
  s.update({ ai: { baseUrl: 'http://a.example', apiKey: 'k1' } });
  s.update({ ai: { baseUrl: 'http://evil.example' } });
  assert.equal(s.value.ai.apiKey, '');
  s.update({ ai: { baseUrl: 'http://b.example', apiKey: 'k2' } });
  assert.equal(s.value.ai.apiKey, 'k2');
});

test('access: default policy, PIN rules, roles', (t) => {
  const dir = tmpDir(t);
  assert.equal(new Settings(path.join(dir, 'new.json'), { fresh: true }).value.access.lanWrites, 'pin', 'new install');
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ callsign: 'OLD' }));
  assert.equal(new Settings(path.join(dir, 'old.json'), { fresh: false }).value.access.lanWrites, 'open', 'upgrade');
  assert.equal(new Settings(path.join(dir, 'old.json'), { fresh: true }).value.access.lanWrites, 'open', 'the default is decided once');

  const s = new Settings(path.join(dir, 's.json'), { fresh: true });
  assert.throws(() => s.update({ access: { lanWrites: 'pin' } }), { status: 400, message: /set a PIN first/ });
  assert.throws(() => s.update({ access: { pin: '12' } }), { status: 400 });
  assert.throws(() => s.update({ access: { pin: 'abcd' } }), { status: 400 });
  assert.throws(() => s.update({ access: { lanWrites: 'everyone' } }), { status: 400 });
  let v = s.update({ access: { pin: '2468', lanWrites: 'pin' } });
  assert.deepEqual(v.access, { lanWrites: 'pin', pinSet: true });
  assert.ok(!JSON.stringify(v).includes('scrypt'), 'the hash never leaves');
  assert.match(s.value.access.pinHash, /^scrypt\$/);
  assert.ok(!fs.readFileSync(path.join(dir, 's.json'), 'utf8').includes('2468'), 'the PIN is not stored');

  for (const who of ['member', 'guest']) {
    assert.throws(() => s.update({ ai: { baseUrl: 'http://x.example' } }, who), { status: 403 });
    assert.throws(() => s.update({ access: { lanWrites: 'open' } }, who), { status: 403 });
  }
  v = s.update({ callsign: 'bravo', lat: 10, lon: 20 }, 'member');
  assert.equal(v.callsign, 'BRAVO');
  assert.deepEqual([s.public('member').lat, s.public('guest').lat, s.public('guest').lon], [10, null, null]);
});

test('a model URL of many slashes is handled in linear time', (t) => {
  const s = new Settings(path.join(tmpDir(t), 's.json'));
  const t0 = performance.now();
  s.update({ ai: { baseUrl: `http://x${'/'.repeat(200_000)}y` } });
  s.update({ ai: { baseUrl: `http://x${'/'.repeat(200_000)}` } });
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(s.value.ai.baseUrl, 'http://x');
});
