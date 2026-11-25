import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, xmlTree, decodeEntities, parseGpx, toGpx, planImport, xmlText } from '../public/js/lib/gpx.js';
import { kindFromGpx } from '../public/js/lib/waypoints.js';
import { MAX_TRACK_POINTS } from '../public/js/lib/route.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE gpx [ <!ENTITY x "y"> ]>
<!-- exported by a GPS unit -->
<gpx version="1.1" creator="Garmin &amp; co" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="38.8977" lon="-77.0365"><ele>18.5</ele><name>Gate &lt;A&gt;</name><desc><![CDATA[Meet <here> & wait]]></desc><sym>Flag, Blue</sym></wpt>
  <wpt lat='38.9' lon='-77.1'><name>Spring</name><sym>Drinking Water</sym></wpt>
  <wpt lat="91" lon="0"><name>Bad</name></wpt>
  <rte><name>North</name>
    <rtept lat="38.8977" lon="-77.0365"><name>Gate &lt;A&gt;</name></rtept>
    <rtept lat="39.0" lon="-77.2"><name>Bridge</name></rtept>
  </rte>
  <trk><name>Walk</name>
    <trkseg><trkpt lat="1" lon="2"><ele>10</ele><time>2026-01-01T10:00:00Z</time></trkpt><trkpt lat="1.001" lon="2.001"><ele>15</ele></trkpt></trkseg>
    <trkseg><trkpt lat="1.01" lon="2.01"/><trkpt lat="1.02" lon="2.02"/></trkseg>
  </trk>
</gpx>`;

test('xml scanner: entities, CDATA, comments, namespaces and case', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &bogus; &'), 'a & b <c> AB &bogus; &');
  const root = parseXml('<?xml version="1.0"?><g:GPX a="1" b=\'2\' c=3 d><!-- x --><g:Name>Hi &amp; <![CDATA[<there>]]></g:Name><e/></g:GPX>');
  const gpx = root.children[0];
  assert.equal(gpx.name, 'gpx');
  assert.deepEqual(gpx.attrs, { a: '1', b: '2', c: '3', d: '' });
  assert.equal(gpx.children[0].name, 'name');
  assert.equal(gpx.children[0].text, 'Hi & <there>');
  assert.equal(gpx.children[1].name, 'e');
});

test('xml scanner: malformed input never throws and keeps what it can', () => {
  for (const bad of ['', '<', '<<<>>>', '</a>', '<a', '<a b="unterminated', '<!-- open', '<![CDATA[ open', '<?xml', '<!DOCTYPE [', 'plain text', '<a><b></a>c</b>', '< a>', 'x < 2 > 1', '\u0000￿']) {
    assert.doesNotThrow(() => parseXml(bad), JSON.stringify(bad));
  }
  // An unclosed element is closed at the end; a stray closing tag is ignored.
  const r = parseXml('<gpx><wpt lat="1" lon="2"><name>A</wpt><wpt lat="3" lon="4"></foo></gpx>');
  assert.deepEqual(r.children[0].children.map((c) => c.attrs.lat), ['1', '3']);
  // A tag cut short by the next one.
  const cut = parseXml('<gpx><wpt lat="1" lon="2"<name>X</name></gpx>');
  assert.equal(cut.children[0].children[0].attrs.lat, '1');
  // A bare "<" in text stays text.
  assert.equal(parseXml('<a>depth < 2 m</a>').children[0].text, 'depth < 2 m');
});

const el = (localName, attrs, kids) => ({ nodeType: 1, localName, attributes: attrs, childNodes: kids });
const textNode = (v) => ({ nodeType: 3, nodeValue: v });

test('xmlTree uses a DOM parser when given one, and falls back to the scanner on parse errors', () => {
  const docOk = { documentElement: el('gpx', [{ localName: 'creator', value: 'X' }], [el('wpt', [{ localName: 'lat', value: '1' }, { localName: 'lon', value: '2' }], [el('name', [], [textNode('A')])])]), getElementsByTagName: () => [] };
  class Good { parseFromString() { return docOk; } }
  class Broken { parseFromString() { return { documentElement: {}, getElementsByTagName: () => [{}] }; } }
  const tree = xmlTree('ignored', Good);
  assert.equal(tree.children[0].attrs.creator, 'X');
  assert.equal(parseGpx('ignored', { Parser: Good }).waypoints[0].name, 'A');
  assert.equal(xmlTree('<gpx creator="S"/>', Broken).children[0].attrs.creator, 'S');
});

test('parseGpx: waypoints, routes and tracks, with bad points skipped', () => {
  const g = parseGpx(SAMPLE);
  assert.equal(g.creator, 'Garmin & co');
  assert.equal(g.waypoints.length, 2);
  assert.equal(g.skipped, 1);
  const [gate, spring] = g.waypoints;
  assert.deepEqual({ ...gate }, { lat: 38.8977, lon: -77.0365, ele: 18.5, time: null, name: 'Gate <A>', note: 'Meet <here> & wait', kind: 'rally' });
  assert.equal(spring.kind, 'water');
  assert.equal(g.routes.length, 1);
  assert.equal(g.routes[0].name, 'North');
  assert.deepEqual(g.routes[0].points.map((p) => p.name), ['Gate <A>', 'Bridge']);
  assert.equal(g.tracks.length, 2, 'one track per segment');
  assert.deepEqual(g.tracks.map((t) => t.name), ['Walk', 'Walk 2']);
  assert.equal(g.tracks[0].points[0].time, '2026-01-01T10:00:00Z');
  assert.equal(g.tracks[0].points[1].ele, 15);
});

test('parseGpx: rejects what is not GPX, accepts GPX 1.0 and bare fragments', () => {
  assert.throws(() => parseGpx('<html><body>hi</body></html>'), /not a GPX file/);
  assert.throws(() => parseGpx('just text'), /not a GPX file/);
  const v10 = parseGpx('<gpx version="1.0"><wpt lat="1.5" lon="2.5"><name>Old</name><type>cache</type></wpt></gpx>');
  assert.equal(v10.waypoints[0].kind, 'cache');
  const frag = parseGpx('<wpt lat="1" lon="2"><name>Bare</name></wpt>');
  assert.equal(frag.waypoints[0].name, 'Bare');
  const junk = parseGpx('<gpx><wpt lat="x" lon="2"/><wpt lon="2"/><trk><trkpt lat="1" lon="2"/><trkpt lat="1" lon="999"/></trk></gpx>');
  assert.equal(junk.skipped, 3);
  assert.equal(junk.tracks[0].points.length, 1, 'trkpt directly in trk, without trkseg');
});

test('categories from GPX type and sym', () => {
  assert.equal(kindFromGpx('hazard', ''), 'hazard');
  assert.equal(kindFromGpx('', 'Residence'), 'home');
  assert.equal(kindFromGpx('', 'Danger Area'), 'hazard');
  assert.equal(kindFromGpx('', 'Medical Facility'), 'medical');
  assert.equal(kindFromGpx('', 'Geocache'), 'cache');
  assert.equal(kindFromGpx('', 'Campground'), 'shelter');
  assert.equal(kindFromGpx('', 'Pin, Red'), 'other');
});

test('toGpx round-trips through parseGpx, escaping text and dropping control characters', () => {
  const waypoints = [{ name: 'A & <B> "q"\u0001', lat: 1.23456789, lon: -2, kind: 'hazard', note: "it's", ele: 12.34 }, { name: 'Old', lat: 0, lon: 0 }];
  const text = toGpx({
    waypoints,
    routes: [{ name: 'R', points: waypoints }, { name: 'Empty', points: [] }],
    tracks: [{ name: 'T', points: [[1, 2, 100], [1.1, 2.1]] }],
  }, { name: 'Test', time: '2026-01-01T00:00:00Z' });
  assert.ok(!text.includes('\u0001'), 'control characters are dropped');
  assert.match(text, /<sym>Danger Area<\/sym><type>hazard<\/type>/);
  assert.match(text, /<type>other<\/type>/, 'waypoints with no category export as other');
  assert.doesNotMatch(text, /Empty/);
  const g = parseGpx(text);
  assert.equal(g.waypoints[0].name, 'A & <B> "q"');
  assert.equal(g.waypoints[0].lat, 1.234568);
  assert.equal(g.waypoints[0].kind, 'hazard');
  assert.equal(g.waypoints[0].note, "it's");
  assert.equal(g.waypoints[0].ele, 12.3);
  assert.equal(g.routes.length, 1);
  assert.equal(g.routes[0].points.length, 2);
  assert.deepEqual(g.tracks[0].points.map((p) => [p.lat, p.lon, p.ele]), [[1, 2, 100], [1.1, 2.1, null]]);
  assert.equal(xmlText('<&>'), '&lt;&amp;&gt;');
});

test('planImport: reuses stored and repeated points, makes long routes tracks, clips names', () => {
  const existing = [{ id: 'old-1', name: 'Gate <A>', lat: 38.8977, lon: -77.0365 }];
  const p = planImport(parseGpx(SAMPLE), existing);
  assert.deepEqual(p.waypoints.map((w) => w.name), ['Spring', 'Bridge']);
  assert.equal(p.duplicates, 2, 'the gate is stored already, as a waypoint and as a route point');
  assert.deepEqual(p.routes[0].refs, [{ id: 'old-1' }, { key: p.waypoints[1].key }]);
  assert.equal(p.tracks.length, 2);
  assert.deepEqual(p.tracks[0].track, [[1, 2, 10], [1.001, 2.001, 15]]);

  const long = { waypoints: [{ name: 'x'.repeat(80), lat: 1, lon: 1, kind: 'other', note: 'n'.repeat(900) }], routes: [{ name: '', points: Array.from({ length: 250 }, (_, i) => ({ lat: 1, lon: i / 1000, name: '' })) }], tracks: [{ name: '', points: [{ lat: 1, lon: 1 }] }] };
  const q = planImport(long, []);
  assert.equal(q.waypoints[0].name.length, 60);
  assert.equal(q.waypoints[0].note.length, 500);
  assert.equal(q.routes.length, 0);
  assert.equal(q.tracks.length, 1, 'a 250-point route becomes a track; a 1-point track is dropped');
  assert.equal(q.tracks[0].name, 'ROUTE 1');

  const huge = { waypoints: [], routes: [], tracks: [{ name: 'Big', points: Array.from({ length: MAX_TRACK_POINTS + 500 }, (_, i) => ({ lat: 0, lon: i / 1e5 })) }] };
  const t = planImport(huge, []).tracks[0].track;
  assert.equal(t.length, MAX_TRACK_POINTS);
  assert.deepEqual(t.at(-1), [0, (MAX_TRACK_POINTS + 499) / 1e5], 'the last point is kept');
});
