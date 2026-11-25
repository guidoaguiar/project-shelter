// Routes and tracks on the map. A route is an ordered list of waypoint ids; a track is a recorded
// line of raw points ([lat, lon] or [lat, lon, elevation]), usually imported from GPX. Pure, no DOM.
import { pathLegs, pointBounds, compassPoint } from './geo.js';

export const ROUTE_KINDS = ['route', 'track'];
/** Most waypoints in one route and points in one track (the server enforces the same limits). */
export const MAX_ROUTE_POINTS = 200;
export const MAX_TRACK_POINTS = 10_000;
/** Walking speed used for the time estimate, km/h on flat ground with a load. */
export const WALK_KMH = 4;

/** A route's points as { lat, lon, name?, ele? }: waypoints in order (missing ones skipped), or the track's points. */
export function routePoints(route, waypoints = []) {
  if (route?.kind === 'track') return (route.track || []).map(([lat, lon, ele]) => ({ lat, lon, ele: ele ?? null }));
  const byId = new Map(waypoints.map((w) => [w.id, w]));
  return (route?.waypointIds || []).map((id) => byId.get(id)).filter(Boolean);
}

/** Climb and descent in metres along points that carry an elevation. */
function climb(points) {
  let up = 0, down = 0, last = null;
  for (const p of points) {
    if (!Number.isFinite(p.ele)) continue;
    if (last !== null) {
      if (p.ele > last) up += p.ele - last;
      else down += last - p.ele;
    }
    last = p.ele;
  }
  return { up, down };
}

/**
 * Everything the map shows about a route: points, legs (km and bearing each), total km, the
 * number of waypoint ids that no longer exist, bounds, climb and descent, and a walking time.
 */
export function routeSummary(route, waypoints = []) {
  const points = routePoints(route, waypoints);
  const { legs, km } = pathLegs(points);
  const missing = route?.kind === 'track' ? 0 : (route?.waypointIds || []).length - points.length;
  return { points, legs, km, missing, bounds: pointBounds(points), ...climb(points), hours: km / WALK_KMH };
}

/** A distance for display: 2 decimals below 10 km, 1 below 100, whole km above. */
export function formatKm(km) {
  if (km < 10) return `${km.toFixed(2)} KM`;
  return km < 100 ? `${km.toFixed(1)} KM` : `${Math.round(km)} KM`;
}

/** A bearing for display: three digits and the compass point, such as "045° NE". */
export const formatBearing = (deg) => `${String(Math.round(deg) % 360).padStart(3, '0')}° ${compassPoint(deg)}`;

/** Hours as "2 H 05 MIN" or "40 MIN". */
export function formatHours(hours) {
  const min = Math.round(hours * 60);
  if (min < 60) return `${min} MIN`;
  return `${Math.floor(min / 60)} H ${String(min % 60).padStart(2, '0')} MIN`;
}

/** A copy of list with item i moved by delta places (clamped to the ends). */
export function moveItem(list, i, delta) {
  const out = [...list];
  const j = Math.max(0, Math.min(out.length - 1, i + delta));
  if (i < 0 || i >= out.length || i === j) return out;
  const [x] = out.splice(i, 1);
  out.splice(j, 0, x);
  return out;
}

/** At most max points, evenly spaced, always keeping the first and the last. */
export function thin(points, max) {
  if (points.length <= max) return points;
  if (max < 2) return points.slice(0, max);
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** A track's stored points from { lat, lon, ele } points: [lat, lon] or [lat, lon, ele], rounded. */
export const trackCoords = (points) => thin(points, MAX_TRACK_POINTS).map((p) => {
  const c = [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6];
  if (Number.isFinite(p.ele)) c.push(Math.round(p.ele * 10) / 10);
  return c;
});
