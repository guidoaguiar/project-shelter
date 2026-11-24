// Household plan, kits, readiness and export helpers (all pure, no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { completeness, routeLegs, walletCard, nextReview, placeText } from '../public/js/lib/plan.js';
import { progress, nextDue, overdue, fromTemplate } from '../public/js/lib/kits.js';
import { readiness, needs, daysLeft, isLow } from '../public/js/lib/core.js';
import { csv, storesCsv, gpx, xmlEscape, notesMarkdown } from '../public/js/lib/export.js';
import { loadKitTemplates } from '../server/kits.js';
import { validate } from '../server/schema.js';
import { tmpDir } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const emptyPlan = () => validate('plan', {});
const W = (id, name, lat, lon) => ({ id, name, lat, lon });

test('plan completeness: each item, and the review date', () => {
  const plan = emptyPlan();
  let c = completeness(plan, [], [], '2026-06-01');
  assert.equal(c.done, 0);
  assert.equal(c.total, 7);
  assert.equal(c.overdue, true);

  plan.meeting.home.label = 'Front gate';
  plan.meeting.neighbourhood.waypointId = '0b9f6a1e-1b5c-4c1e-9a55-2f0d5f9b1c11';
  plan.meeting.outOfTown.label = 'Aunt Mia';
  plan.routes = [{ id: 'r', name: 'North', waypointIds: ['a', 'b'], notes: '' }];
  plan.utilities = [{ kind: 'gas', location: 'Cellar', howTo: '', tool: '' }];
  plan.alerts = 'Weather radio';
  plan.reviewedAt = '2026-01-10';
  c = completeness(plan, [{ kind: 'pet' }, { kind: 'person' }], [{ role: 'out-of-area' }], '2026-06-01');
  assert.equal(c.done, 7, JSON.stringify(c.items.filter((x) => !x.done)));
  assert.equal(c.nextReview, '2027-01-10');
  assert.equal(nextReview({ reviewedAt: '2026-01-10', reviewEveryDays: 30 }), '2026-02-09');
  assert.equal(completeness(plan, [{ kind: 'pet' }], [], '2027-02-01').overdue, true, 'pets alone are not a household; review lapsed');
});

test('routes: legs, distance, and missing waypoints are skipped', () => {
  const wps = [W('a', 'A', 0, 0), W('b', 'B', 0, 1), W('c', 'C', 1, 1)];
  const r = routeLegs({ waypointIds: ['a', 'gone', 'b', 'c'] }, wps);
  assert.deepEqual(r.points.map((p) => p.name), ['A', 'B', 'C']);
  assert.equal(r.legs.length, 2);
  assert.ok(Math.abs(r.legs[0].km - 111.19) < 0.5);
  assert.ok(Math.abs(r.legs[0].bearing - 90) < 0.1);
  assert.ok(Math.abs(r.km - (r.legs[0].km + r.legs[1].km)) < 1e-9);
  assert.equal(placeText({ label: 'Gate', waypointId: 'a' }, wps), 'Gate · A');
  assert.equal(placeText({ label: '', waypointId: null }, wps), '');
});

test('wallet card: only marked contacts, set meeting places, medical essentials', () => {
  const plan = emptyPlan();
  plan.meeting.home.label = 'Front gate';
  const card = walletCard(plan,
    [{ name: 'Ana', kind: 'person', bloodType: 'O-', allergies: 'penicillin', medications: [{ name: 'Insulin', dose: '10 u', schedule: 'meals' }] },
      { name: 'Rex', kind: 'pet', bloodType: 'unknown' }],
    [{ name: 'Mia', role: 'out-of-area', phone: '555', onCard: true }, { name: 'Bob', role: 'family', phone: '777' }], []);
  assert.deepEqual(card.contacts.map((c) => c.name), ['Mia']);
  assert.deepEqual(card.meeting, [{ label: 'NEAR HOME', where: 'Front gate' }]);
  assert.equal(card.people[0].medications, 'Insulin 10 u meals');
  assert.equal(card.people[0].bloodType, 'O-');
  assert.equal(card.people[1].bloodType, '');
});

test('kits: progress, due dates and templates', () => {
  const kit = { items: [{ done: true }, { done: false }], intervalDays: 180, checkedAt: '2026-01-01' };
  assert.deepEqual(progress(kit), { done: 1, total: 2 });
  assert.equal(nextDue(kit), '2026-06-30');
  assert.equal(overdue(kit, '2026-06-30'), false);
  assert.equal(overdue(kit, '2026-07-01'), true);
  assert.equal(overdue({ ...kit, checkedAt: null }), true, 'never checked is due now');
  const k = fromTemplate({ id: 't', name: 'Car kit', intervalDays: 90, items: ['Jumper cables'] }, '', 'Boot');
  assert.deepEqual(k, { name: 'Car kit', template: 't', location: 'Boot', intervalDays: 90, items: [{ label: 'Jumper cables', done: false }] });
  assert.doesNotThrow(() => validate('kits', k), 'a template kit passes the schema');
});

test('kit templates: the shipped file loads, and custom entries replace by id', (t) => {
  const shipped = loadKitTemplates(path.join(ROOT, 'config'));
  assert.ok(shipped.length >= 5);
  assert.ok(shipped.every((x) => x.items.length && x.name && x.source));
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'kits.json'), JSON.stringify([{ id: 'a', name: 'A', items: ['x'] }, { id: 'Bad ID', name: 'B', items: ['y'] }]));
  fs.writeFileSync(path.join(dir, 'kits.custom.json'), JSON.stringify([{ id: 'a', name: 'Mine', items: ['z'], intervalDays: 30 }, { id: 'b', name: 'B', items: ['w'] }]));
  const list = loadKitTemplates(dir);
  assert.deepEqual(list.map((x) => [x.id, x.name, x.intervalDays, x.custom || false]), [['a', 'Mine', 30, true], ['b', 'B', 180, true]]);
});

test('needs and readiness: no people keeps the old numbers; people and pets change them', () => {
  assert.deepEqual(needs(3), { people: 3, pets: 0, petsMissingWater: 0, waterL: 12, kcal: 6000 });
  const items = [
    { category: 'WATER', unit: 'L', qty: 24 }, { category: 'FOOD', qty: 10, kcal: 1200 },
    { name: 'Insulin', category: 'MEDICAL', qty: 30, dailyUse: 3 }, { name: 'Inhaler', category: 'MEDICAL', qty: 4, dailyUse: 1, minQty: 5 },
    { category: 'PET', qty: 6, dailyUse: 0.5, expires: '2000-01-01' },
  ];
  const before = readiness(items, 3);
  assert.equal(before.waterDays, 2);
  assert.equal(before.foodDays, 2);
  const household = [{ kind: 'person' }, { kind: 'person', waterL: 2, kcal: 1000 }, { kind: 'pet', waterL: 1 }, { kind: 'pet' }];
  const r = readiness(items, household, { warnDays: 30 });
  assert.equal(r.waterDays, 24 / 7);
  assert.equal(r.foodDays, 12_000 / 3000);
  assert.deepEqual([r.people, r.pets, r.petsMissingWater], [2, 2, 1]);
  assert.deepEqual(r.meds, { name: 'Inhaler', days: 4 });
  assert.equal(r.low, 1);
  assert.equal(r.expired, 1);
  assert.equal(r.warnDays, 30);
  assert.equal(daysLeft({ qty: 10 }), null);
  assert.equal(isLow({ qty: 2, minQty: '' }), false);
});

test('exports: CSV quoting, GPX escaping, notes as Markdown', () => {
  assert.equal(csv([['a', 'b,c'], ['say "hi"', 'x\ny']]), '﻿"a","b,c"\r\n"say ""hi""","x\ny"\r\n');
  assert.match(storesCsv([{ name: 'Rice', qty: 5 }]), /^﻿"name","category"/);
  assert.equal(xmlEscape(`<a & "b" 'c'>`), '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  const g = gpx([{ name: 'Home & <garden>', lat: 1, lon: 2, note: 'x' }], [{ name: 'R', points: [{ name: 'P', lat: 3, lon: 4 }] }, { name: 'Empty', points: [] }]);
  assert.match(g, /<wpt lat="1\.000000" lon="2\.000000"><name>Home &amp; &lt;garden&gt;<\/name><desc>x<\/desc><\/wpt>/);
  assert.match(g, /<rte><name>R<\/name>\n {4}<rtept lat="3\.000000"/);
  assert.ok(!g.includes('Empty'));
  const md = notesMarkdown([{ title: 'Old', body: 'a', updated: '2026-01-01T10:00:00Z' }, { title: '', body: 'b', updated: '2026-02-01T10:00:00Z' }]);
  assert.ok(md.indexOf('# Untitled') < md.indexOf('# Old'), 'newest first');
  assert.match(md, /\n---\n/);
});
