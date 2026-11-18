// World outline from a TopoJSON file (Natural Earth 1:110m countries). Pure functions, no DOM:
// usable from Node for testing.
import { MAX_LAT } from './streets.js';

/** Arcs decoded from quantized, delta-encoded TopoJSON into [lon, lat] points. */
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

/** Polygons of a geometry, each a list of rings given as arc indexes. */
function polygonsOf(g) {
  if (g.type === 'Polygon') return [g.arcs];
  if (g.type === 'MultiPolygon') return g.arcs;
  return [];
}

/** Longitude adjusted by whole turns to stay within 180° of the previous point. */
function unwrap(lon, prev) {
  if (lon - prev > 180) return lon - 360;
  if (lon - prev < -180) return lon + 360;
  return lon;
}

/**
 * The points of one ring, joined from its arcs (a negative index ~i means arc i reversed), with
 * longitude unwrapped so shapes crossing the 180° line stay continuous.
 */
function ringPoints(ring, arcs) {
  const pts = [];
  let offset = 0, latSum = 0;
  for (const idx of ring) {
    const arc = idx < 0 ? [...arcs[~idx]].reverse() : arcs[idx];
    // Consecutive arcs share their joining point: skip it after the first arc.
    for (const [lon0, lat] of pts.length ? arc.slice(1) : arc) {
      const lon = pts.length ? unwrap(lon0 + offset, pts.at(-1)[0]) : lon0 + offset;
      offset += lon - (lon0 + offset);
      pts.push([lon, lat]);
      latSum += lat;
    }
  }
  // A ring that ends a full turn away from its start circles a pole (Antarctica): close it along the chart edge.
  const start = pts[0]?.[0], end = pts.at(-1)?.[0];
  if (pts.length >= 3 && Math.abs(end - start) > 180) {
    const pole = latSum < 0 ? -MAX_LAT : MAX_LAT;
    pts.push([end, pole], [start, pole]);
  }
  return pts;
}

/** Longitude shifts to draw a ring at: as is, plus a copy a full turn over for any part past an edge. */
function shiftsFor(pts) {
  const lons = pts.map((p) => p[0]);
  const shifts = [0];
  if (Math.max(...lons) > 180) shifts.push(-360);
  if (Math.min(...lons) < -180) shifts.push(360);
  return shifts;
}

/** Closed rings of [lon, lat] points covering the world's land, ready to project and fill (even-odd). */
export function worldRings(topo) {
  const arcs = decodeArcs(topo);
  const out = [];
  for (const g of topo.objects.countries.geometries) {
    for (const ring of polygonsOf(g).flat()) {
      const pts = ringPoints(ring, arcs);
      if (pts.length < 3) continue;
      for (const s of shiftsFor(pts)) out.push(s ? pts.map(([lon, lat]) => [lon + s, lat]) : pts);
    }
  }
  return out;
}
