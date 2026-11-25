// MAP — canvas drawing for waypoint category icons, map routes and tracks, and search hits.
import { kindOf } from '../../lib/waypoints.js';
import { routeSummary, formatKm, formatBearing } from '../../lib/route.js';

/** CSS colour variable per waypoint category. */
const KIND_COLOR = { home: '--accent', rally: '--accent', water: '--water-line', cache: '--warn', shelter: '--ok', medical: '--bad', hazard: '--bad', other: '--text' };
export const kindColor = (kind, c) => c(KIND_COLOR[kind] || '--text') || c('--text');

// One outline per category, about 14 px across, centred on (0, 0).
const SHAPES = {
  home: (p) => { p.moveTo(-6, -1); p.lineTo(0, -7); p.lineTo(6, -1); p.lineTo(4.5, -1); p.lineTo(4.5, 6); p.lineTo(-4.5, 6); p.lineTo(-4.5, -1); p.closePath(); },
  rally: (p) => { p.moveTo(-4, 7); p.lineTo(-4, -7); p.lineTo(6, -3.5); p.lineTo(-4, 0); },
  water: (p) => { p.moveTo(0, -7); p.bezierCurveTo(3, -3, 5.5, 0, 5.5, 2.5); p.arc(0, 2.5, 5.5, 0, Math.PI); p.bezierCurveTo(-5.5, 0, -3, -3, 0, -7); p.closePath(); },
  cache: (p) => { p.rect(-5.5, -5.5, 11, 11); p.moveTo(-5.5, -5.5); p.lineTo(5.5, 5.5); p.moveTo(5.5, -5.5); p.lineTo(-5.5, 5.5); },
  shelter: (p) => { p.moveTo(-7, 6); p.lineTo(0, -6); p.lineTo(7, 6); p.closePath(); p.moveTo(0, -6); p.lineTo(0, 6); },
  medical: (p) => { p.moveTo(-2, -6); p.lineTo(2, -6); p.lineTo(2, -2); p.lineTo(6, -2); p.lineTo(6, 2); p.lineTo(2, 2); p.lineTo(2, 6); p.lineTo(-2, 6); p.lineTo(-2, 2); p.lineTo(-6, 2); p.lineTo(-6, -2); p.lineTo(-2, -2); p.closePath(); },
  hazard: (p) => { p.moveTo(0, -7); p.lineTo(7, 6); p.lineTo(-7, 6); p.closePath(); p.moveTo(0, -2.5); p.lineTo(0, 2); p.moveTo(0, 3.6); p.lineTo(0, 4.4); },
  other: (p) => { p.moveTo(0, -5.5); p.lineTo(5.5, 0); p.lineTo(0, 5.5); p.lineTo(-5.5, 0); p.closePath(); },
};

/** A waypoint's category icon at (x, y): a background halo, then the outline in the category colour. */
export function drawIcon(ctx, kind, x, y, c, { selected = false } = {}) {
  const shape = SHAPES[kind] || SHAPES.other;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); shape(ctx);
  ctx.strokeStyle = c('--bg'); ctx.lineWidth = 4.5; ctx.stroke();
  ctx.fillStyle = c('--bg'); if (kind !== 'rally') ctx.fill();
  ctx.strokeStyle = kindColor(kind, c); ctx.lineWidth = selected ? 2.4 : 1.6; ctx.stroke();
  ctx.restore();
}

/** Waypoint icons and names. */
export function paintWaypoints(ctx, waypoints, toXY, c, label, selectedId) {
  ctx.font = '10px ui-monospace, Consolas, monospace';
  for (const w of waypoints) {
    const [x, y] = toXY(w.lon, w.lat);
    const kind = kindOf(w);
    drawIcon(ctx, kind, x, y, c, { selected: w.id === selectedId });
    label(String(w.name).toUpperCase(), x + 10, y + 3, c('--text'));
  }
}

function line(ctx, pts, toXY) {
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = toXY(p.lon, p.lat); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.stroke();
}

/** Leg labels for the route being edited: distance and bearing at the middle of each leg, point numbers at each point. */
function paintLegs(ctx, s, toXY, c, label) {
  ctx.font = '9px ui-monospace, Consolas, monospace';
  const accent = c('--accent');
  for (const leg of s.legs) {
    const [x1, y1] = toXY(leg.from.lon, leg.from.lat), [x2, y2] = toXY(leg.to.lon, leg.to.lat);
    if (Math.hypot(x2 - x1, y2 - y1) < 90) continue; // too short to label legibly
    label(`${formatKm(leg.km)} ${formatBearing(leg.bearing)}`, (x1 + x2) / 2 + 6, (y1 + y2) / 2 - 6, accent);
  }
  s.points.forEach((p, i) => {
    const [x, y] = toXY(p.lon, p.lat);
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = c('--accent-ink') || c('--bg'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  });
}

/** Map routes (solid) and tracks (thin), the active one thicker with its legs labelled. */
/** One route or track line with its name at the start. */
function paintRoute(ctx, r, s, toXY, c, label, isActive) {
  const isTrack = r.kind === 'track';
  const color = isTrack ? c('--warn') : c('--ok');
  const width = isActive ? 3.5 : 2.2;
  ctx.globalAlpha = isActive ? 1 : 0.85;
  ctx.setLineDash([]);
  ctx.strokeStyle = c('--bg'); ctx.lineWidth = width + 2.5; line(ctx, s.points, toXY);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(isTrack ? [6, 3] : []);
  line(ctx, s.points, toXY);
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  const [x, y] = toXY(s.points[0].lon, s.points[0].lat);
  ctx.font = '10px ui-monospace, Consolas, monospace';
  label(String(r.name).toUpperCase(), x + 10, y - 10, color);
}

export function paintRoutes(ctx, routes, waypoints, toXY, c, label, activeId) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  let active = null;
  for (const r of routes) {
    const s = routeSummary(r, waypoints);
    if (r.id === activeId) active = s;
    if (s.points.length >= 2) paintRoute(ctx, r, s, toXY, c, label, r.id === activeId);
  }
  if (active) paintLegs(ctx, active, toXY, c, label);
}

/** Search hits: small rings, numbered in order of distance. */
export function paintHits(ctx, hits, toXY, c, label) {
  ctx.font = '9px ui-monospace, Consolas, monospace';
  hits.forEach((p, i) => {
    const [x, y] = toXY(p.lon, p.lat);
    ctx.strokeStyle = c('--bg'); ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.stroke();
    ctx.strokeStyle = c('--accent'); ctx.lineWidth = 2; ctx.stroke();
    label(String(i + 1), x + 8, y - 6, c('--accent'));
  });
}

/** The waypoint or search hit nearest to screen point (x, y), within r px, or null. */
export function hitTest(items, toXY, x, y, r = 10) {
  let best = null, bestD = r;
  for (const it of items) {
    const [px, py] = toXY(it.lon, it.lat);
    const d = Math.hypot(px - x, py - y);
    if (d <= bestD) { best = it; bestD = d; }
  }
  return best;
}
