import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusInterval, runtimeText, powerLevel, batteryBanner, powerBudget, ampHoursToWh, STATUS_EVERY } from '../public/js/lib/power.js';
import { kitStatus, attention, checkinState, markCheckin, newCheckin } from '../public/js/lib/situation.js';

test('status polling slows down in low-power mode', () => {
  assert.equal(statusInterval(null), STATUS_EVERY.normal);
  assert.equal(statusInterval({ power: { lowPower: false } }), 5000);
  assert.equal(statusInterval({ power: { lowPower: true } }), 60_000);
});

test('runtime text', () => {
  assert.deepEqual([null, -1, Number.NaN, 0, 45, 65, 125.4, 3000].map(runtimeText), ['—', '—', '—', '0M', '45M', '1H 05M', '2H 05M', '2D 2H']);
});

test('power level and banner', () => {
  assert.equal(powerLevel(null).level, 'dim');
  assert.equal(powerLevel({ enabled: true, checkedAt: null }).text, 'CHECKING');
  assert.equal(powerLevel({ enabled: true, checkedAt: 'x', present: false }).text, 'NO BATTERY OR UPS FOUND');
  assert.equal(powerLevel({ enabled: true, checkedAt: 'x', present: true, onBattery: false }).level, 'ok');
  assert.equal(powerLevel({ enabled: true, checkedAt: 'x', present: true, onBattery: true, percent: 50, runtimeMin: 90 }).level, 'warn');
  assert.equal(powerLevel({ enabled: true, checkedAt: 'x', present: true, onBattery: true, percent: 15, runtimeMin: null }).level, 'bad');
  assert.equal(batteryBanner({ onBattery: false }), null);
  const text = batteryBanner({ onBattery: true, percent: 64.4, runtimeMin: 130, estimated: true, lowPower: false });
  assert.match(text, /64%, about 2H 10M left \(estimated\)/);
  assert.match(text, /Turn on low-power mode/);
  assert.match(batteryBanner({ onBattery: true, percent: null, runtimeMin: null, lowPower: true }), /running on battery\. Low-power mode is on/);
});

test('power budget: load, losses, battery, solar and autonomy', () => {
  const b = powerBudget({
    devices: [{ name: 'Fridge', watts: 60, hours: 24, qty: 1 }, { name: 'Light', watts: 5, hours: 4, qty: 3 }],
    batteryWh: 2000, usablePct: 50, efficiency: 100, solarW: 100, sunHours: 4,
  });
  assert.equal(b.loadWh, 1440 + 60);
  assert.equal(b.drawWh, 1500);
  assert.equal(b.usableWh, 1000);
  assert.equal(b.solarWh, 300);
  assert.equal(b.netWh, -1200);
  assert.ok(Math.abs(b.autonomyDays - 1000 / 1200) < 1e-9);
  assert.equal(b.darkHours, 16);
  assert.equal(b.solarNeededW, 500);
  assert.equal(b.sustainable, false);
  assert.ok(Math.abs(b.devices[0].share - 0.96) < 1e-9);

  const sunny = powerBudget({ devices: [{ name: 'Radio', watts: 3, hours: 4 }], batteryWh: 100, solarW: 50 });
  assert.equal(sunny.sustainable, true);
  assert.equal(sunny.autonomyDays, null);
  assert.ok(Math.abs(sunny.drawWh - 12 / 0.9) < 1e-9);

  const empty = powerBudget();
  assert.deepEqual([empty.loadWh, empty.darkHours, empty.sustainable], [0, null, false]);
  assert.equal(ampHoursToWh(100, 12), 1200);
});

const kit = (name, checkedAt, done = [true]) => ({ name, checkedAt, intervalDays: 30, items: done.map((d) => ({ label: 'x', done: d })) });

test('kit status and what needs attention', () => {
  const today = '2026-03-01';
  const kits = [kit('Car', '2026-02-20'), kit('Go bag', '2025-01-01', [true, false]), kit('Work', null, [])];
  const k = kitStatus(kits, today);
  assert.deepEqual([k.total, k.due, k.complete, k.dueNames], [3, 2, 1, ['Go bag', 'Work']]);

  const todo = attention({
    planCheck: { overdue: true, nextReview: '2026-02-01' }, kits, today,
    ready: { expired: 2, low: 1, meds: { name: 'Insulin', days: 3.6 } },
  });
  assert.deepEqual(todo.map((x) => x.level), ['bad', 'bad', 'warn', 'warn', 'warn', 'warn']);
  assert.match(todo[0].label, /2 expired items/);
  assert.match(todo[1].label, /Insulin runs out in 3 days/);
  assert.match(todo[2].label, /since 2026-02-01/);
  assert.match(todo[3].label, /Go bag: check overdue since 2025-01-31/);
  assert.match(todo[4].label, /Work: never checked/);
  assert.equal(todo[4].href, '#/stores/kits');
  assert.match(todo[5].label, /1 item at or below/);
  assert.deepEqual(attention({ planCheck: { overdue: true, nextReview: null } }).map((x) => x.label), ['The plan has never been reviewed']);
  assert.deepEqual(attention(), []);
});

test('check-in: merge with people, mark one, mark all, start again', () => {
  const people = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Ben' }, { id: 'c', name: 'Rex', kind: 'pet' }];
  const saved = { startedAt: '2026-01-01T10:00:00.000Z', people: [{ personId: 'a', name: 'Ana', ok: true, at: '2026-01-01T10:01:00.000Z' }, { personId: 'gone', name: 'Old', ok: true }] };
  const c = checkinState(saved, people);
  assert.deepEqual([c.ok, c.total, c.complete, c.rows[2].kind], [1, 3, false, 'pet']);

  const now = '2026-01-01T10:05:00.000Z';
  const one = markCheckin(c, 'b', true, now);
  assert.deepEqual(one.people.map((p) => [p.personId, p.ok, p.at]), [['a', true, '2026-01-01T10:01:00.000Z'], ['b', true, now], ['c', false, null]]);
  assert.equal(one.allOk, false);
  assert.equal(one.startedAt, saved.startedAt);

  const all = markCheckin(checkinState(one, people), null, true, now);
  assert.equal(all.allOk, true);
  assert.equal(checkinState(all, people).complete, true);

  const undo = markCheckin(checkinState(all, people), 'a', false, now);
  assert.deepEqual([undo.allOk, undo.people[0].at], [false, null]);

  const fresh = newCheckin(checkinState(all, people), now);
  assert.equal(checkinState(fresh, people).ok, 0);
  assert.equal(fresh.startedAt, now);

  // No people in the plan: one household-wide confirmation.
  const none = checkinState(null, []);
  assert.deepEqual([none.total, none.complete], [0, false]);
  const done = markCheckin(none, null, true, now);
  assert.deepEqual([done.allOk, checkinState(done, []).complete, done.startedAt], [true, true, now]);
});
