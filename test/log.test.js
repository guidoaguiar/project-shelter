// Log: templates, tags, search and date filters, table rows, and image attachments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES, template, fromTemplate, parseTags, allTags, filterNotes, appendRow, noteDay, localStamp } from '../public/js/lib/logbook.js';
import { Attachments, sniffImage, decodeBase64, MAX_BYTES, ATTACHMENT_NAME } from '../server/attachments.js';
import { validate } from '../server/schema.js';
import { Collection, Settings, Doc } from '../server/store.js';
import { buildBackup, restoreBackup } from '../server/backup.js';
import { tmpDir } from './helpers.js';

/** The smallest byte runs each image type is recognised by, padded to 16 bytes. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(4)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10)]);

test('templates: every one makes an entry with its tag; tables for radio and medical logs', () => {
  const now = new Date(2026, 10, 24, 14, 7);
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['incident', 'sitrep', 'checkin', 'radio', 'medical']);
  for (const t of TEMPLATES) {
    const n = fromTemplate(t.id, now);
    assert.equal(n.template, t.id);
    assert.deepEqual(n.tags, [t.tag]);
    assert.equal(n.title, `${t.label} 2026-11-24 14:07`);
    assert.ok(n.body.length > 10);
    validate('notes', n); // what a template makes is a valid entry
  }
  assert.match(fromTemplate('radio', now).body, /\| Time \| Frequency \| Callsign \| Message \|\n\|---\|---\|---\|---\|/);
  assert.match(fromTemplate('medical', now).body, /\| Time \| Pulse \| Resp \| BP \| Temp \| SpO2 \| AVPU \| Notes \|/);
  assert.deepEqual(fromTemplate('', now), { title: 'LOG 2026-11-24', body: '', tags: [], template: '' });
  assert.equal(template('nope'), null);
  assert.equal(localStamp(now), '2026-11-24 14:07');
});

test('appendRow adds to the end of the right table, or starts one', () => {
  const radio = template('radio');
  let body = fromTemplate('radio').body + '\nAfter the table.';
  body = appendRow(body, radio.columns, { time: '14:00', freq: '146.520', callsign: 'K1ABC', message: 'All well | over\nout' });
  body = appendRow(body, radio.columns, { time: '14:05', freq: '146.520', callsign: 'K1XYZ', message: 'Copy' });
  const lines = body.split('\n');
  const head = lines.indexOf('| Time | Frequency | Callsign | Message |');
  assert.equal(lines[head + 2], String.raw`| 14:00 | 146.520 | K1ABC | All well \| over out |`);
  assert.equal(lines[head + 3], '| 14:05 | 146.520 | K1XYZ | Copy |');
  assert.ok(body.endsWith('After the table.'));
  assert.equal(appendRow('', radio.columns, { time: '1' }), '| Time | Frequency | Callsign | Message |\n|---|---|---|---|\n| 1 |   |   |   |\n');
  assert.match(appendRow('Notes', template('medical').columns, { time: '09:00', pulse: '88' }), /^Notes\n\n\| Time \| Pulse/);
});

test('tags: parsed from typed text and counted', () => {
  assert.deepEqual(parseTags('Water, #repair  radio,,water ÿx'), ['water', 'repair', 'radio', 'x']);
  assert.deepEqual(parseTags(''), []);
  assert.equal(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ')).length, 20);
  assert.equal(parseTags('a'.repeat(50))[0].length, 32);
  assert.deepEqual(allTags([{ tags: ['b', 'a'] }, { tags: ['a'] }, {}]), [['a', 2], ['b', 1]]);
});

test('filterNotes: search, tag and dates, including entries saved before tags existed', () => {
  const notes = [
    { id: 1, title: 'Storm damage', body: 'Roof leak in the attic', tags: ['incident'], created: '2026-11-01T10:00:00Z', updated: '2026-11-02T10:00:00Z' },
    { id: 2, title: 'Radio net', body: 'K1ABC checked in', tags: ['radio'], created: '2026-11-10T10:00:00Z' },
    { id: 3, title: 'Old note', body: 'From before tags', updated: '2026-10-01T10:00:00Z' },
  ];
  const ids = (f) => filterNotes(notes, f).map((n) => n.id);
  assert.deepEqual(ids({}), [1, 2, 3]);
  assert.deepEqual(ids({ q: 'roof ATTIC' }), [1]);
  assert.deepEqual(ids({ q: 'roof radio' }), []);
  assert.deepEqual(ids({ q: 'radio' }), [2], 'tags are searched too');
  assert.deepEqual(ids({ tag: 'incident' }), [1]);
  assert.deepEqual(ids({ from: '2026-11-01' }), [1, 2]);
  assert.deepEqual(ids({ to: '2026-11-01' }), [1, 3]);
  assert.deepEqual(ids({ from: '2026-11-02', to: '2026-11-30' }), [2]);
  assert.equal(noteDay(notes[2]), '2026-10-01');
});

test('sniffImage and decodeBase64 accept images only', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(WEBP), 'image/webp');
  assert.equal(sniffImage(GIF), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
  assert.deepEqual(decodeBase64(`data:image/png;base64,${PNG.toString('base64')}`), PNG);
  assert.throws(() => decodeBase64('not base64!'), { status: 400 });
  assert.throws(() => decodeBase64(''), { status: 400 });
  assert.throws(() => decodeBase64('A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 100)), { status: 413 });
});

test('Attachments: saved under a server-chosen name, typed by content, removed when unused', (t) => {
  const dir = tmpDir(t);
  const store = new Attachments(path.join(dir, 'attachments'));
  const a = store.save('wound\u0000.png', PNG.toString('base64'));
  assert.match(a.file, ATTACHMENT_NAME);
  assert.ok(a.file.endsWith('.png'));
  assert.deepEqual({ name: a.name, type: a.type, size: a.size }, { name: 'wound.png', type: 'image/png', size: PNG.length });
  assert.ok(store.file(a.file));
  assert.equal(store.save('x.jpg', GIF.toString('base64')).type, 'image/gif', 'the type comes from the bytes, not the name');
  assert.throws(() => store.save('x.png', Buffer.from('<svg/>        ').toString('base64')), { status: 415 });
  for (const bad of ['../settings.json', 'x.png', `${a.file}/..`, '00000000-0000-0000-0000-000000000000.svg']) assert.equal(store.file(bad), null, bad);

  store.removeUnreferenced([a.file], [{ attachments: [a] }]);
  assert.ok(store.file(a.file), 'still used by an entry');
  store.removeUnreferenced([a.file, '../../etc/passwd'], [{}]);
  assert.equal(store.file(a.file), null);
});

test('notes schema: attachments are validated, older entries still load', () => {
  const file = '0b6f6a52-2f6e-4f53-9d0a-4d1c1d2c3b4a.jpg';
  const v = validate('notes', { title: 't', tags: ['x'], template: 'radio', attachments: [{ file, name: 'a', type: 'image/jpeg', size: 10 }] });
  assert.equal(v.attachments[0].file, file);
  assert.equal(v.template, 'radio');
  assert.deepEqual(validate('notes', { title: 'old' }).attachments, []);
  assert.deepEqual(validate('notes', { title: 'old' }, { partial: true }), { title: 'old' }, 'an update without attachments keeps them');
  assert.throws(() => validate('notes', { attachments: [{ file: '../x.jpg', type: 'image/jpeg', size: 1 }] }), /attachments\[0\]\.file/);
  assert.throws(() => validate('notes', { attachments: [{ file, type: 'image/svg+xml', size: 1 }] }), /type/);
  assert.throws(() => validate('notes', { attachments: [{ file, type: 'image/jpeg', size: MAX_BYTES + 1 }] }), /size/);
  assert.throws(() => validate('notes', { attachments: Array.from({ length: 13 }, () => ({ file, type: 'image/jpeg', size: 1 })) }), /more than 12/);
});

/** A node's stores in a folder, as backup.js sees them. */
const make = (dir) => ({
  settings: new Settings(path.join(dir, 'settings.json')),
  collections: { notes: new Collection(path.join(dir, 'notes.json'), { schema: 'notes' }) },
  plan: new Doc(path.join(dir, 'plan.json'), 'plan'),
  attachments: new Attachments(path.join(dir, 'attachments')),
});

test('backups carry Log images, and a restore brings back the missing ones', (t) => {
  const a = make(tmpDir(t));
  const img = a.attachments.save('roof.jpg', JPEG.toString('base64'));
  a.collections.notes.upsert({ title: 'Roof', attachments: [img] });
  const backup = buildBackup({ ...a, appVersion: 'test' });
  assert.deepEqual(Object.keys(backup.attachments), [img.file]);
  assert.equal(backup.attachmentsOmitted, undefined);

  const b = make(tmpDir(t));
  const dry = restoreBackup(backup, { mode: 'merge', dryRun: true }, b);
  assert.deepEqual(dry.attachments, { add: 1, skip: 0, invalid: 0 });
  assert.equal(b.attachments.file(img.file), null);
  restoreBackup(backup, { mode: 'merge', dryRun: false }, b);
  assert.deepEqual(fs.readFileSync(b.attachments.file(img.file)), JPEG);
  assert.deepEqual(restoreBackup(backup, { mode: 'merge', dryRun: false }, b).attachments, { add: 0, skip: 1, invalid: 0 });

  const forged = { ...backup, attachments: { '../evil.jpg': JPEG.toString('base64'), [img.file.replace('.jpg', '.png')]: JPEG.toString('base64'), 'x.png': 'zz' } };
  assert.deepEqual(restoreBackup(forged, { mode: 'merge', dryRun: true }, b).attachments, { add: 0, skip: 0, invalid: 3 });
  assert.equal(buildBackup({ ...a, attachments: undefined, appVersion: 't' }).attachments, undefined, 'no attachment store, no images');
});
