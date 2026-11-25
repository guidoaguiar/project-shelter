import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathLegs, pointBounds } from '../public/js/lib/geo.js';
import { routeSummary, routePoints, formatKm, formatBearing, formatHours, moveItem, thin, trackCoords } from '../public/js/lib/route.js';
import { kindOf, kindShort, filterByKind, countByKind, KINDS } from '../public/js/lib/waypoints.js';
import { WAYPOINT_KINDS } from '../server/schema.js';

const byText = (a, b) => a.localeCompare(b);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('pathLegs: distance and bearing per leg, and the total', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, { lat: 1, lon: 1 }];
  const { legs, km } = pathLegs(pts);
  assert.equal(legs.length, 2);
  near(legs[0].km, 111.19, 0.05, 'one degree of latitude');
  near(legs[0].bearing, 0, 1e-9, 'due north');
  near(legs[1].bearing, 90, 0.01, 'about due east');
  near(km, legs[0].km + legs[1].km, 1e-9, 'total');
  assert.deepEqual(pathLegs([]), { legs: [], km: 0 });
  assert.deepEqual(pathLegs([{ lat: 1, lon: 1 }]), { legs: [], km: 0 });
  assert.deepEqual(pointBounds(pts), [0, 0, 1, 1]);
  assert.equal(pointBounds([]), null);
});

test('routeSummary: waypoint routes skip missing points; tracks give climb and descent', () => {
  const wps = [{ id: 'a', name: 'A', lat: 0, lon: 0 }, { id: 'b', name: 'B', lat: 0, lon: 0.1 }];
  const r = routeSummary({ kind: 'route', waypointIds: ['a', 'gone', 'b'] }, wps);
  assert.equal(r.points.length, 2);
  assert.equal(r.missing, 1);
  near(r.km, 11.12, 0.01, 'a tenth of a degree at the equator');
  near(r.legs[0].bearing, 90, 1e-6, 'east');
  near(r.hours, r.km / 4, 1e-9, 'at 4 km/h');
  assert.equal(routeSummary({ waypointIds: ['a'] }, wps).km, 0, 'kind defaults to route');

  const t = routeSummary({ kind: 'track', track: [[0, 0, 100], [0, 0.01, 150], [0, 0.02, 120], [0, 0.03]] });
  assert.equal(t.points.length, 4);
  assert.equal(t.up, 50);
  assert.equal(t.down, 30);
  assert.equal(t.missing, 0);
  assert.deepEqual(routePoints(null), []);
});

test('formatting and list helpers', () => {
  assert.equal(formatKm(1.234), '1.23 KM');
  assert.equal(formatKm(12.34), '12.3 KM');
  assert.equal(formatKm(123.4), '123 KM');
  assert.equal(formatBearing(45.4), '045° NE');
  assert.equal(formatBearing(359.7), '000° N');
  assert.equal(formatHours(0.5), '30 MIN');
  assert.equal(formatHours(2.1), '2 H 06 MIN');
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 5), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(['a'], 3, -1), ['a']);
  assert.deepEqual(thin([1, 2, 3, 4, 5], 3), [1, 3, 5]);
  assert.deepEqual(thin([1, 2], 5), [1, 2]);
  assert.deepEqual(trackCoords([{ lat: 1.123456789, lon: 2, ele: 10.06 }, { lat: 1, lon: 2, ele: null }]), [[1.123457, 2, 10.1], [1, 2]]);
});

test('waypoint categories: same list as the server, old waypoints count as other, filter', () => {
  assert.deepEqual([...KINDS].sort(byText), [...WAYPOINT_KINDS].sort(byText));
  for (const k of ['cache', 'water', 'rally', 'hazard', 'home']) assert.ok(KINDS.includes(k), k);
  assert.equal(kindOf({}), 'other');
  assert.equal(kindOf({ kind: 'bogus' }), 'other');
  assert.equal(kindShort('water'), 'H2O');
  const wps = [{ kind: 'water' }, { kind: 'home' }, {}, { kind: 'water' }];
  assert.equal(filterByKind(wps, new Set()).length, 4);
  assert.equal(filterByKind(wps, null).length, 4);
  assert.equal(filterByKind(wps, new Set(['water'])).length, 2);
  assert.equal(filterByKind(wps, new Set(['other'])).length, 1);
  assert.equal(countByKind(wps).water, 2);
  assert.equal(countByKind(wps).other, 1);
});
