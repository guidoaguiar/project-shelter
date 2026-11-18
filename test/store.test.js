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
  v = s.update({ ai: { provider: 'other', baseUrl: 'ftp://nope' } });
  assert.equal(v.ai.provider, 'ollama');
  assert.equal(v.ai.baseUrl, 'https://models.example');
  assert.equal(new Settings(file).value.ai.apiKey, 'secret', 'kept on disk');
});

test('a model URL of many slashes is handled in linear time', (t) => {
  const s = new Settings(path.join(tmpDir(t), 's.json'));
  const t0 = performance.now();
  s.update({ ai: { baseUrl: `http://x${'/'.repeat(200_000)}y` } });
  s.update({ ai: { baseUrl: `http://x${'/'.repeat(200_000)}` } });
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(s.value.ai.baseUrl, 'http://x');
});
