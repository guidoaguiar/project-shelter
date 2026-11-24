import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Collection, Settings, Doc } from '../server/store.js';
import { buildBackup, restoreBackup, checkBackup, Snapshots } from '../server/backup.js';
import { tmpDir } from './helpers.js';

const id = () => crypto.randomUUID();
const byText = (a, b) => a.localeCompare(b);

function node(dir) {
  const collections = Object.fromEntries(['notes', 'stores', 'people'].map((n) => [n, new Collection(path.join(dir, `${n}.json`), { schema: n })]));
  return { settings: new Settings(path.join(dir, 'settings.json')), collections, plan: new Doc(path.join(dir, 'plan.json'), 'plan') };
}

test('a backup round trip restores records, the plan and portable settings, never secrets', (t) => {
  const a = node(tmpDir(t));
  a.settings.update({ callsign: 'alpha', lat: 10, lon: 20, ai: { apiKey: 'secret' }, access: { pin: '2468', lanWrites: 'pin' } });
  const note = a.collections.notes.upsert({ title: 'one', body: 'x' });
  a.collections.stores.upsert({ name: 'Rice', qty: 5 });
  a.collections.people.upsert({ name: 'Ana', medications: [{ name: 'Insulin' }] });
  a.plan.update({ alerts: 'Radio' });
  const backup = buildBackup({ ...a, maps: [{ file: 'home.pmtiles', bounds: [1, 2, 3, 4], maxZoom: 15 }, { file: 'bad', error: 'x' }], appVersion: '0.2.0' });
  const text = JSON.stringify(backup);
  for (const secret of ['secret', 'scrypt', 'pinHash', 'apiKey', 'lanWrites']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(backup.maps, [{ file: 'home.pmtiles', bounds: [1, 2, 3, 4], maxZoom: 15 }]);

  const b = node(tmpDir(t));
  const dry = restoreBackup(backup, { mode: 'replace', dryRun: true }, b);
  assert.deepEqual(dry.collections.notes, { add: 1, update: 0, skip: 0, remove: 0, invalid: 0 });
  assert.equal(b.collections.notes.all().length, 0, 'a dry run writes nothing');
  restoreBackup(backup, { mode: 'replace', dryRun: false }, b);
  assert.equal(b.collections.notes.all()[0].id, note.id, 'ids are kept');
  assert.equal(b.collections.people.all()[0].medications[0].name, 'Insulin');
  assert.equal(b.plan.get().alerts, 'Radio');
  assert.deepEqual([b.settings.value.callsign, b.settings.value.lat], ['ALPHA', 10]);
  assert.equal(b.settings.value.ai.apiKey, '');
});

test('merge: new ids are added, newer copies win, nothing is removed, settings stay', (t) => {
  const n = node(tmpDir(t));
  n.settings.update({ callsign: 'here' });
  const mine = n.collections.notes.upsert({ title: 'mine' });
  const shared = n.collections.notes.upsert({ title: 'shared old' });
  const backup = {
    format: 'shelter-backup', version: 1, settings: { callsign: 'there' },
    collections: {
      notes: [
        { ...shared, title: 'shared new', updated: '2999-01-01T00:00:00.000Z' },
        { ...mine, title: 'stale', updated: '2000-01-01T00:00:00.000Z' },
        { id: id(), title: 'theirs', updated: '2026-01-01T00:00:00.000Z' },
        { id: 'not-a-uuid', title: 'bad' },
        { id: id(), title: 'x'.repeat(500) },
      ],
    },
  };
  const r = restoreBackup(backup, { mode: 'merge', dryRun: false }, n);
  assert.deepEqual(r.collections.notes, { add: 1, update: 1, skip: 1, remove: 0, invalid: 2 });
  assert.deepEqual(n.collections.notes.all().map((x) => x.title).sort(byText), ['mine', 'shared new', 'theirs']);
  assert.equal(n.settings.value.callsign, 'HERE');
  assert.equal(r.settings, 'unchanged');
});

test('backups are checked before anything happens', () => {
  assert.throws(() => checkBackup({}), { status: 400, message: /not a Shelter backup/ });
  assert.throws(() => checkBackup({ format: 'shelter-backup', version: 99, collections: {} }), { message: /newer Shelter/ });
  assert.throws(() => checkBackup({ format: 'shelter-backup', version: 1 }), { message: /no collections/ });
  assert.throws(() => restoreBackup({ format: 'shelter-backup', version: 1, collections: {} }, { mode: 'wipe' }, {}), { message: /merge or replace/ });
});

test('snapshots: one a day when something changed, 14 kept, safe names only', (t) => {
  const dir = tmpDir(t);
  let now = Date.parse('2026-03-01T12:00:00Z');
  const snaps = new Snapshots(dir, { now: () => now });
  const backup = (v) => ({ format: 'shelter-backup', version: 1, created: new Date(now).toISOString(), collections: { notes: [v] } });
  assert.ok(snaps.daily(backup(1)));
  assert.equal(snaps.daily(backup(2)), null, 'today already has one');
  now += 864e5;
  assert.equal(snaps.daily(backup(1)), null, 'a new day, but nothing changed since the newest');
  for (let d = 3; d <= 20; d++) {
    now = Date.parse(`2026-03-${String(d).padStart(2, '0')}T12:00:00Z`);
    assert.ok(snaps.daily(backup(d)), `day ${d}`);
  }
  assert.equal(snaps.list().filter((s) => s.kind === 'auto').length, 14);
  assert.equal(snaps.file('../settings.json'), null);
  assert.equal(snaps.file('auto-nope.json'), null);
  assert.equal(snaps.list()[0].created, '2026-03-20T12:00:00.000Z');
  const pre = snaps.save('pre-restore', backup('x'));
  assert.ok(snaps.file(pre));
  now += 91 * 864e5;
  snaps.prune();
  assert.equal(snaps.file(pre), null, 'pre-restore snapshots go after 90 days');
});
