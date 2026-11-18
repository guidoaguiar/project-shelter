import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUTM, toMGRS, formatUTM, toDMS, parseCoord, rangeBearing, compassPoint, sunTimes, moonPhase } from '../public/js/lib/geo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} not within ${tol} of ${b}`);

test('UTM and MGRS for a known point (White House)', () => {
  const u = toUTM(38.8977, -77.0365);
  assert.equal(u.zone, 18);
  assert.equal(u.band, 'S');
  near(u.easting, 323_394, 2);
  near(u.northing, 4_307_396, 2);
  assert.equal(toMGRS(38.8977, -77.0365), '18S UJ 23394 07395');
  assert.equal(toMGRS(38.8977, -77.0365, 3), '18S UJ 233 073');
  assert.equal(formatUTM(38.8977, -77.0365), '18S 323394E 4307396N');
});

test('UTM zone exceptions: Norway and Svalbard', () => {
  assert.equal(toUTM(60, 5).zone, 32); // would be 31
  assert.equal(toUTM(60, 2).zone, 31);
  assert.deepEqual([5, 15, 25, 40].map((lon) => toUTM(78, lon).zone), [31, 33, 35, 37]);
  assert.equal(toUTM(78, 45).zone, 38);
  assert.equal(toUTM(10, 180).zone, 60);
});

test('UTM is limited to 80°S..84°N', () => {
  assert.equal(toUTM(84.5, 0), null);
  assert.equal(toMGRS(-81, 0), null);
  assert.equal(formatUTM(85, 0), 'outside UTM limits');
  assert.equal(toUTM(-30, 20).northing > 6_000_000, true); // southern hemisphere false northing
});

test('DMS formatting rounds seconds and carries into minutes', () => {
  assert.equal(toDMS(38.8977, -77.0365), '38°53\'51.7"N 77°02\'11.4"W');
  assert.equal(toDMS(-10.999999, 0), '11°00\'00.0"S 0°00\'00.0"E');
});

const close = (p, lat, lon) => { near(p.lat, lat, 1e-4); near(p.lon, lon, 1e-4); };

test('coordinate parsing: decimal, degrees-minutes, DMS, lon first', () => {
  close(parseCoord('38.8977, -77.0365'), 38.8977, -77.0365);
  close(parseCoord('38 53.862 N 77 2.19 W'), 38.8977, -77.0365);
  close(parseCoord('38°53\'51.7"N 77°02\'11.4"W'), 38.897694, -77.0365);
  close(parseCoord('77 2.19 W 38 53.862 N'), 38.8977, -77.0365);
  close(parseCoord('-0 30 0, 10 0 0'), -0.5, 10); // "-0" degrees still makes the whole value negative
  assert.equal(parseCoord('-0 30, 10'), null); // three numbers: ambiguous
  assert.equal(parseCoord('95, 10'), null);
  assert.equal(parseCoord('1 2 3'), null);
  assert.equal(parseCoord('nowhere'), null);
});

test('range and bearing', () => {
  const r = rangeBearing({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 }); // London to Paris
  near(r.km, 343.6, 1);
  near(r.bearing, 148, 1);
  assert.deepEqual([0, 22.5, 90, 200, 359].map(compassPoint), ['N', 'NNE', 'E', 'SSW', 'N']);
});

test('sun times: ordinary day, polar night and midnight sun', () => {
  const s = sunTimes(2024, 6, 21, 51.5, 0);
  assert.equal(s.polar, null);
  near(s.dayHours, 16.6, 0.2);
  assert.ok(s.rise < s.noon && s.noon < s.set);
  assert.equal(sunTimes(2024, 12, 21, 80, 0).polar, 'night');
  assert.equal(sunTimes(2024, 6, 21, 80, 0).polar, 'day');
});

test('moon phase for a known full moon', () => {
  const m = moonPhase(new Date('2024-04-23T23:49:00Z'));
  assert.equal(m.name, 'FULL MOON');
  assert.ok(m.illumination > 0.98);
});
