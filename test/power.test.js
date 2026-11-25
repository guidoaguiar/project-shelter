import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Settings } from '../server/store.js';
import { validate } from '../server/schema.js';
import { parseUevent, fromLinux, parsePmset, fromWindows, parseNut, fromNut, nutTarget, estimateRuntime, summarise, PowerMonitor } from '../server/power.js';
import { tmpDir } from './helpers.js';

const uevent = (fields) => Object.entries(fields).map(([k, v]) => `POWER_SUPPLY_${k}=${v}`).join('\n');

test('linux: uevent files, adapters, runtime from energy and power, device batteries ignored', () => {
  assert.deepEqual(parseUevent('POWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_CAPACITY=57\nbad line\n'), { name: 'BAT0', capacity: '57' });
  const bat = { name: 'BAT0', ...parseUevent(uevent({ TYPE: 'Battery', STATUS: 'Discharging', PRESENT: 1, CAPACITY: 57, ENERGY_NOW: 20_000_000, POWER_NOW: 10_000_000, MODEL_NAME: 'Main' })) };
  const ac = { name: 'AC', ...parseUevent(uevent({ TYPE: 'Mains', ONLINE: 0 })) };
  const mouse = { name: 'hid', ...parseUevent(uevent({ TYPE: 'Battery', SCOPE: 'Device', STATUS: 'Discharging', CAPACITY: 5 })) };
  const r = fromLinux([bat, ac, mouse]);
  assert.equal(r.present, true);
  assert.equal(r.onBattery, true);
  assert.equal(r.percent, 57);
  assert.equal(r.runtimeMin, 120);
  assert.equal(r.units.length, 1);
  assert.equal(r.primary, 'Main');

  const charging = fromLinux([{ ...bat, status: 'Charging' }, { ...ac, online: '1' }]);
  assert.equal(charging.onBattery, false);
  assert.equal(charging.charging, true);
  assert.equal(charging.runtimeMin, null);

  // A desktop: mains only, nothing to report.
  const desk = fromLinux([{ ...ac, online: '1' }]);
  assert.equal(desk.present, false);
  assert.equal(desk.onBattery, false);

  // Charge and current instead of energy and power; capacity worked out from energy when missing.
  const alt = fromLinux([{ name: 'BAT1', type: 'Battery', status: 'Discharging', charge_now: '3000000', current_now: '1500000', energy_now: '5', energy_full: '10' }]);
  assert.equal(alt.runtimeMin, 120);
  assert.equal(alt.percent, 50);
  assert.equal(alt.onBattery, true);
});

test('macOS: pmset output on battery, on mains, and with a UPS', () => {
  const batt = parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t92%; discharging; 4:31 remaining present: true\n");
  assert.deepEqual([batt.onBattery, batt.percent, batt.runtimeMin, batt.units[0].kind], [true, 92, 271, 'battery']);
  const ac = parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n");
  assert.deepEqual([ac.onBattery, ac.runtimeMin, ac.units[0].state], [false, null, 'full']);
  const est = parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; (no estimate) present: true\n");
  assert.equal(est.runtimeMin, null);
  const ups = parsePmset("Now drawing from 'UPS Power'\n -CP1500 UPS (id=2)\t71%; discharging; 0:18 remaining present: true\n");
  assert.deepEqual([ups.onBattery, ups.units[0].kind, ups.runtimeMin], [true, 'ups', 18]);
  assert.equal(parsePmset("Now drawing from 'AC Power'\n").present, false);
});

test('windows: Win32_Battery as one object, a list, or nothing', () => {
  const one = fromWindows({ Name: 'DELL 1', EstimatedChargeRemaining: 64, EstimatedRunTime: 95, BatteryStatus: 1 });
  assert.deepEqual([one.onBattery, one.percent, one.runtimeMin], [true, 64, 95]);
  const ac = fromWindows([{ Name: 'B', EstimatedChargeRemaining: 100, EstimatedRunTime: 71_582_788, BatteryStatus: 2 }]);
  assert.deepEqual([ac.onBattery, ac.runtimeMin, ac.units[0].state], [false, null, 'idle']);
  assert.equal(fromWindows([{ BatteryStatus: 7, EstimatedChargeRemaining: 40 }]).charging, true);
  assert.equal(fromWindows(null).present, false);
});

test('NUT: LIST VAR reply, status flags and target parsing', () => {
  const text = 'BEGIN LIST VAR ups\nVAR ups battery.charge "83"\nVAR ups battery.runtime "1500"\nVAR ups ups.status "OB LB"\nVAR ups ups.model "Back-UPS 700"\nVAR other battery.charge "1"\nEND LIST VAR ups\n';
  const vars = parseNut(text, 'ups');
  assert.equal(vars['battery.charge'], '83');
  assert.equal(vars['ups.status'], 'OB LB');
  const u = fromNut(vars, 'ups');
  assert.deepEqual([u.kind, u.percent, u.state, u.runtimeMin, u.low, u.name], ['ups', 83, 'discharging', 25, true, 'Back-UPS 700']);
  assert.equal(fromNut({ 'ups.status': 'OL CHRG' }, 'ups').state, 'charging');
  assert.equal(fromNut({ 'ups.status': 'OL' }, 'ups').state, 'full');
  assert.deepEqual(nutTarget('myups'), { ups: 'myups', host: '127.0.0.1', port: 3493 });
  assert.deepEqual(nutTarget('ups@nas.local:3500'), { ups: 'ups', host: 'nas.local', port: 3500 });
});

test('runtime estimate from a falling charge', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z'), min = 60_000;
  assert.equal(estimateRuntime([{ t: t0, percent: 90 }]), null);
  // 10 points in 20 minutes: 0.5 per minute, 80 left -> 160 minutes.
  assert.equal(estimateRuntime([{ t: t0, percent: 90 }, { t: t0 + 10 * min, percent: 85 }, { t: t0 + 20 * min, percent: 80 }]), 160);
  // Too short or too small a drop.
  assert.equal(estimateRuntime([{ t: t0, percent: 90 }, { t: t0 + 2 * min, percent: 80 }]), null);
  assert.equal(estimateRuntime([{ t: t0, percent: 90 }, { t: t0 + 30 * min, percent: 89 }]), null);
  // A rise breaks the run: only the fall after it counts.
  assert.equal(estimateRuntime([{ t: t0, percent: 50 }, { t: t0 + min, percent: 95 }, { t: t0 + 11 * min, percent: 90 }]), 180);
});

test('summarise picks the unit on battery with the least time left', () => {
  const r = summarise('x', [{ name: 'a', percent: 90, state: 'full', runtimeMin: null }, { name: 'b', percent: 40, state: 'discharging', runtimeMin: 30 }, { name: 'c', percent: 60, state: 'discharging', runtimeMin: 10 }]);
  assert.equal(r.primary, 'c');
  assert.equal(r.onBattery, true);
});

test('monitor: combines the OS reader with NUT, records errors, estimates runtime', async () => {
  const m = new PowerMonitor({
    reader: async () => fromWindows({ Name: 'Laptop', EstimatedChargeRemaining: 100, BatteryStatus: 2 }),
    nut: 'ups@127.0.0.1', nutReader: async () => ({ name: 'UPS', kind: 'ups', percent: 70, state: 'discharging', runtimeMin: 42 }),
  });
  assert.equal(m.status().checkedAt, null);
  const r = await m.refresh();
  assert.deepEqual([r.source, r.onBattery, r.primary, r.runtimeMin, r.units.length], ['windows+nut', true, 'UPS', 42, 2]);

  const broken = new PowerMonitor({ reader: async () => { throw new Error('no pmset'); } });
  const b = await broken.refresh();
  assert.equal(b.present, false);
  assert.match(b.error, /no pmset/);

  let pct = 90;
  const draining = new PowerMonitor({ reader: async () => summarise('t', [{ name: 'b', kind: 'battery', percent: pct, state: 'discharging', runtimeMin: null }]) });
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (let i = 0; i < 3; i++) { await draining.refresh(); clock += 10 * 60_000; pct -= 5; }
  } finally { Date.now = realNow; }
  assert.equal(draining.status().estimated, true);
  assert.equal(Math.round(draining.status().runtimeMin), 160);
  assert.equal(new PowerMonitor({ enabled: false }).status().enabled, false);
});

test('settings: power fields are validated, merged and kept', (t) => {
  const file = path.join(tmpDir(t), 'settings.json');
  const s = new Settings(file);
  assert.equal(s.value.power.lowPower, false);
  assert.equal(s.value.power.usablePct, 80);
  s.update({ power: { lowPower: true, batteryWh: 1200, devices: [{ name: 'Fridge', watts: 60, hours: 24 }] } }, 'member');
  s.update({ power: { solarW: 200 } });
  const again = new Settings(file);
  assert.deepEqual([again.value.power.lowPower, again.value.power.batteryWh, again.value.power.solarW, again.value.power.devices[0].qty], [true, 1200, 200, 1]);
  assert.throws(() => s.update({ power: { batteryWh: -1 } }), /batteryWh/);
  assert.throws(() => s.update({ power: { devices: [{ watts: 5, hours: 1 }] } }), /name/);
  assert.throws(() => s.update({ power: 'on' }), /power/);
  assert.equal(s.public('guest').power.lowPower, true);
});

test('check-in schema: times and people are checked', () => {
  const ok = validate('checkin', { startedAt: '2026-01-01T10:00:00.000Z', people: [{ name: 'Ana', ok: true, at: '2026-01-01T10:05:00.000Z' }] });
  assert.equal(ok.people[0].ok, true);
  assert.equal(ok.allOk, false);
  assert.throws(() => validate('checkin', { startedAt: 'yesterday' }), /startedAt/);
  assert.throws(() => validate('checkin', { people: [{ ok: true }] }), /name/);
});
