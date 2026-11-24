// 04 MAP — offline map: world outline everywhere, plus roads, paths, water and place names
// from street map archives stored on this node. Waypoints, range and bearing from home.
import { h, api, saveSettings, home, toast, viewHeader, panel, kv, bytes, isGuest, printDoc, printButton } from '../lib/core.js';
import { MEETING, routeLegs } from '../lib/plan.js';
import { gpx, download, today } from '../lib/export.js';
import { toMGRS, toDMS, rangeBearing, compassPoint, parseCoord } from '../lib/geo.js';
import { StreetLayer, mercY, invMercY, MAX_LAT, countTiles } from '../lib/streets.js';
import { worldRings } from '../lib/world.js';

let world = null; // Path2D in (lon, -mercY(lat)) space, built once

async function loadWorld() {
  if (world) return world;
  const topo = await (await fetch('/data/world-110m.json')).json();
  const path = new Path2D();
  for (const ring of worldRings(topo)) {
    path.moveTo(ring[0][0], -mercY(ring[0][1]));
    for (let k = 1; k < ring.length; k++) path.lineTo(ring[k][0], -mercY(ring[k][1]));
    path.closePath();
  }
  world = path;
  return world;
}

/** Hemisphere letter for a signed coordinate: neg below zero, pos above, none at zero. */
function hemi(v, neg, pos) {
  if (v < 0) return neg;
  return v > 0 ? pos : '';
}

const fmt = (p) => `${Math.abs(p.lat).toFixed(4)}${p.lat < 0 ? 'S' : 'N'} ${Math.abs(p.lon).toFixed(4)}${p.lon < 0 ? 'W' : 'E'}`;

/** Range and bearing from home to p, or a dash when home is not set. */
function fromHome(p) {
  const o = home();
  if (!o) return '—';
  const r = rangeBearing(o, p);
  const km = r.km < 10 ? r.km.toFixed(2) : r.km.toFixed(0);
  return `${km} KM / ${String(Math.round(r.bearing) % 360).padStart(3, '0')}° ${compassPoint(r.bearing)}`;
}

/** Status line for a map download job. */
function jobText(job) {
  if (job.state === 'done') return `DONE · ${bytes(job.size)}`;
  if (job.state !== 'running') return `FAILED: ${String(job.error || job.state).toUpperCase()}`;
  return job.phase === 'downloading' ? `${bytes(job.bytes)} / ${bytes(job.total)}` : job.phase.toUpperCase();
}

const cancelDownload = () => api('/api/maps/cancel', { method: 'POST' }).catch(() => {});

/** Progress bar for a map download job, with a cancel button while it runs. */
function jobMeter(job) {
  const pct = job.total ? Math.min(100, (job.bytes / job.total) * 100) : 0;
  return h('div.meter', { style: 'margin:0 0 12px' },
    h('div.row', h('span', job.file.replace(/\.pmtiles$/, '').toUpperCase()), h('b', jobText(job))),
    h('div.track', h('div.fill' + (job.state === 'error' ? '.hot' : ''), { style: `width:${job.state === 'done' ? 100 : pct}%` })),
    job.state === 'running' ? h('div', { style: 'margin-top:8px' }, h('button.btn.sm', { type: 'button', onclick: cancelDownload }, 'CANCEL')) : null);
}

/** Zoom levels, size and date of a stored archive, or why it cannot be read. */
function archiveText(a) {
  if (a.error) return `UNREADABLE: ${a.error}`;
  const date = a.date ? ` · OSM ${a.date.slice(0, 10)}` : '';
  return `Z${a.minZoom}–${a.maxZoom} · ${bytes(a.size)}${date}`;
}

const DETAIL = [
  [15, 'STREETS + FOOTPATHS (Z15)'],
  [14, 'STREETS + TRACKS (Z14)'],
  [13, 'ALL ROADS (Z13)'],
  [12, 'MAIN ROADS (Z12)'],
  [10, 'REGION OVERVIEW (Z10)'],
];

/** What a pick from the Plan is for: { kind: 'meeting' | 'route', key, label }, or null. */
function pickTarget(arg) {
  const m = /^pick\/(meeting|route)\.([A-Za-z0-9-]+)$/.exec(arg || '');
  if (!m) return null;
  const label = m[1] === 'meeting' ? MEETING.find(([k]) => k === m[2])?.[1] : 'ROUTE';
  return label ? { kind: m[1], key: m[2], label } : null;
}

export async function render(root, arg, { code } = {}) {
  const pick = isGuest() ? null : pickTarget(arg);
  let waypoints = await api('/api/db/waypoints').catch(() => []);
  let planDoc = isGuest() ? null : await api('/api/plan').catch(() => null);
  let mapInfo = await api('/api/maps').catch(() => ({ archives: [], job: null, canAdmin: false, maxTiles: 0 }));
  const land = await loadWorld().catch(() => null);
  const pos0 = home();
  // scale = pixels per degree of longitude (and per mercator degree vertically).
  const view = { lon: pos0?.lon ?? 10, lat: pos0?.lat ?? 25, scale: pos0 ? 14 : 3.2 };
  let mark = null; // selected point

  const canvas = h('canvas', { 'aria-label': 'Map. Drag to pan, scroll to zoom, click to mark a point.' });
  const read = h('div.map-read', 'MOVE OVER MAP');
  const box = h('div.map-box.panel', canvas, read,
    h('div.map-ctl',
      h('button.btn', { title: 'Zoom in', onclick: () => zoom(1.6) }, '+'),
      h('button.btn', { title: 'Zoom out', onclick: () => zoom(1 / 1.6) }, '−'),
      h('button.btn', { title: 'Centre on home position', onclick: () => goHome() }, '⌂')));
  const side = h('div');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;

  const streets = new StreetLayer(() => draw());
  streets.setArchives(mapInfo.archives);

  const toXY = (lon, lat) => [W / 2 + (lon - view.lon) * view.scale, H / 2 - (mercY(lat) - mercY(view.lat)) * view.scale];
  const toLL = (x, y) => ({ lon: view.lon + (x - W / 2) / view.scale, lat: invMercY(mercY(view.lat) - (y - H / 2) / view.scale) });
  const clamp = () => {
    view.scale = Math.max(1.2, Math.min(200_000, view.scale));
    view.lon = Math.max(-180, Math.min(180, view.lon));
    view.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, view.lat));
  };
  function zoom(f, x = W / 2, y = H / 2) {
    const before = toLL(x, y);
    view.scale *= f; clamp();
    const after = toLL(x, y);
    view.lon += before.lon - after.lon;
    view.lat = invMercY(mercY(view.lat) + mercY(before.lat) - mercY(after.lat));
    clamp(); draw();
  }
  /** Visible area as [west, south, east, north], limited to the chart. */
  const viewBounds = () => {
    const a = toLL(0, H), b = toLL(W, 0);
    return [Math.max(-180, a.lon), Math.max(-MAX_LAT, a.lat), Math.min(180, b.lon), Math.min(MAX_LAT, b.lat)];
  };
  function fit([w, s, e, n]) {
    view.lon = (w + e) / 2;
    view.lat = invMercY((mercY(s) + mercY(n)) / 2);
    view.scale = 0.9 * Math.min(W / Math.max(1e-6, e - w), H / Math.max(1e-6, mercY(n) - mercY(s)));
    clamp(); draw();
  }

  let raf = 0;
  function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
  function centreOn(p, minScale) {
    view.lon = p.lon; view.lat = p.lat;
    view.scale = Math.max(view.scale, minScale);
    clamp(); draw();
  }
  function goHome() {
    const p = home();
    if (p) centreOn(p, 14);
    else toast('HOME POSITION NOT SET', true);
  }

  function paint() {
    if (!W || !H) return;
    const css = getComputedStyle(document.documentElement);
    const c = (n) => css.getPropertyValue(n).trim();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c('--bg'); ctx.fillRect(0, 0, W, H);
    if (land) paintLand(c);
    const detailed = streets.draw(ctx, { W, H, dpr, scale: view.scale, cx: view.lon, cy: mercY(view.lat) }, c);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintGraticule(c, detailed);
    const label = (s, x, y, color) => { ctx.strokeStyle = c('--bg'); ctx.lineWidth = 3; ctx.strokeText(s, x, y); ctx.fillStyle = color; ctx.fillText(s, x, y); };
    paintMarks(c, label);
    paintScaleBar(c, label, detailed);
    updateEstimate();
  }

  function paintLand(c) {
    ctx.save();
    ctx.translate(W / 2 - view.lon * view.scale, H / 2 + mercY(view.lat) * view.scale);
    ctx.scale(view.scale, view.scale);
    ctx.beginPath(); ctx.rect(-180, -180, 360, 360); ctx.clip(); // keep wrapped copies inside the chart
    ctx.fillStyle = c('--land'); ctx.fill(land, 'evenodd');
    ctx.strokeStyle = c('--land-line'); ctx.lineWidth = 1 / view.scale; ctx.stroke(land);
    ctx.restore();
  }

  /** Grid lines every `step` degrees (chosen to be at least 70 px apart), labelled along the top and left edges. */
  function paintGraticule(c, detailed) {
    const step = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001].findLast((s) => s * view.scale >= 70) || 30;
    const a = toLL(0, H), b = toLL(W, 0);
    const lons = [], lats = [];
    for (let lon = Math.ceil(Math.max(-180, a.lon) / step) * step; lon <= Math.min(180, b.lon) + 1e-9; lon += step) lons.push(lon);
    for (let lat = Math.ceil(Math.max(-90, a.lat) / step) * step; lat <= Math.min(90, b.lat) + 1e-9; lat += step) lats.push(lat);
    ctx.strokeStyle = c('--line2'); ctx.globalAlpha = detailed ? 0.35 : 0.55; ctx.lineWidth = 1;
    ctx.fillStyle = c('--dim'); ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.beginPath();
    for (const lon of lons) { const x = Math.round(toXY(lon, 0)[0]) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (const lat of lats) { const y = Math.round(toXY(0, lat)[1]) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const dp = (String(step).split('.')[1] || '').length;
    for (const lon of lons) ctx.fillText(`${Math.abs(lon).toFixed(dp)}${hemi(lon, 'W', 'E')}`, toXY(lon, 0)[0] + 3, 10);
    for (const lat of lats) ctx.fillText(`${Math.abs(lat).toFixed(dp)}${hemi(lat, 'S', 'N')}`, 3, toXY(0, lat)[1] - 3);
  }

  /** Plan routes as lines through their waypoints, and rings around meeting places. */
  function paintPlan(c, label) {
    if (!planDoc) return;
    const accent = c('--accent');
    ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8; ctx.lineJoin = 'round';
    for (const r of planDoc.routes) {
      const pts = routeLegs(r, waypoints).points;
      if (pts.length < 2) continue;
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = toXY(p.lon, p.lat); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      const [x, y] = toXY(pts[0].lon, pts[0].lat);
      label(String(r.name).toUpperCase(), x + 9, y - 9, accent);
    }
    ctx.globalAlpha = 1;
    for (const [k, name] of MEETING) {
      const w = waypoints.find((x) => x.id === planDoc.meeting[k]?.waypointId);
      if (!w) continue;
      const [x, y] = toXY(w.lon, w.lat);
      ctx.strokeStyle = accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 2 * Math.PI); ctx.stroke();
      label(`MEET: ${name}`, x + 13, y + 15, accent);
    }
  }

  /** Waypoints, home, the selected point, and a range line from home to it. */
  function paintMarks(c, label) {
    const accent = c('--accent'), text = c('--text'), bg = c('--bg');
    const pos = home();
    ctx.font = '10px ui-monospace, Consolas, monospace';
    paintPlan(c, label);
    if (pos && mark) {
      const [x1, y1] = toXY(pos.lon, pos.lat), [x2, y2] = toXY(mark.lon, mark.lat);
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.lineJoin = 'round';
    for (const w of waypoints) {
      const [x, y] = toXY(w.lon, w.lat);
      ctx.fillStyle = bg; ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.stroke();
      label(String(w.name).toUpperCase(), x + 9, y + 3, text);
    }
    if (pos) {
      const [x, y] = toXY(pos.lon, pos.lat);
      ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 5); ctx.lineTo(x - 6, y + 5); ctx.closePath(); ctx.fill();
      label('HOME', x + 10, y + 4, accent);
    }
    if (mark) {
      const [x, y] = toXY(mark.lon, mark.lat);
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 12, y + 0.5); ctx.lineTo(x - 4, y + 0.5); ctx.moveTo(x + 4, y + 0.5); ctx.lineTo(x + 12, y + 0.5);
      ctx.moveTo(x + 0.5, y - 12); ctx.lineTo(x + 0.5, y - 4); ctx.moveTo(x + 0.5, y + 4); ctx.lineTo(x + 0.5, y + 12); ctx.stroke();
      ctx.strokeRect(x - 3.5, y - 3.5, 8, 8);
    }
  }

  /** Scale bar of a round length about 110 px long, true at the centre latitude, plus the OSM credit. */
  function paintScaleBar(c, label, detailed) {
    const text = c('--text');
    const mPerPx = 111_319.49 * Math.cos(view.lat * Math.PI / 180) / view.scale;
    const target = mPerPx * 110;
    const p10 = 10 ** Math.floor(Math.log10(target));
    const len = [5, 2, 1].map((k) => k * p10).find((v) => v <= target) || p10;
    const px = len / mPerPx, sx = W - 12 - px, sy = H - (detailed ? 24 : 12);
    const lenTxt = len >= 1000 ? `${len / 1000} KM` : `${len} M`;
    ctx.strokeStyle = c('--bg'); ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy); ctx.lineTo(sx + px, sy); ctx.lineTo(sx + px, sy - 5); ctx.stroke();
    ctx.strokeStyle = text; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textAlign = 'right'; label(lenTxt, W - 12, sy - 8, text);
    if (detailed) { ctx.font = '9px ui-monospace, Consolas, monospace'; label('© OPENSTREETMAP CONTRIBUTORS', W - 12, H - 8, c('--dim')); }
    ctx.textAlign = 'left';
  }

  // Typed coordinates: built once so the text survives side-panel repaints.
  const coordIn = h('input', { placeholder: '38.8977, -77.0365', 'aria-label': 'Coordinates to mark', autocomplete: 'off', spellcheck: 'false' });
  const entry = panel('ENTER COORDINATES', 'CRD', h('form.pb', {
    onsubmit: (e) => {
      e.preventDefault();
      const p = parseCoord(coordIn.value);
      if (!p) { toast('COORDINATE NOT RECOGNISED', true); return; }
      mark = p;
      view.lon = p.lon; view.lat = p.lat;
      if (view.scale < 40) view.scale = 40;
      clamp(); paintSide(); draw();
    },
  },
    h('div.row', { style: 'flex-wrap:nowrap' }, coordIn, h('button.btn.primary', 'MARK')),
    h('p.hint', { style: 'margin:8px 0 0' }, 'Decimal degrees, or degrees-minutes-seconds with N/S/E/W, such as 38°53\'51"N 77°02\'11"W. The point is marked and centred; then save it as a waypoint or set it as home.')));

  // ---------- offline street maps ----------
  const areaName = h('input', { placeholder: 'AREA NAME', maxlength: 40, 'aria-label': 'Name for the downloaded area' });
  const detailSel = h('select', { 'aria-label': 'Detail level' }, DETAIL.map(([z, t]) => h('option', { value: z }, t)));
  const estimate = h('div.hint', { style: 'margin:8px 0' });
  const dlBtn = h('button.btn.primary', { type: 'submit' }, 'DOWNLOAD VISIBLE AREA');
  detailSel.addEventListener('change', () => updateEstimate());
  const dlForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const bbox = viewBounds().map((v) => +v.toFixed(5));
      try {
        mapInfo.job = await api('/api/maps/download', { method: 'POST', body: { bbox, maxzoom: +detailSel.value, name: areaName.value.trim() || `area ${fmt({ lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 })}` } });
        paintMaps(); poll();
      } catch (error) { toast(error.message.toUpperCase(), true); }
    },
  }, h('div', { style: 'display:grid;gap:6px' }, areaName, detailSel), estimate, dlBtn);

  function updateEstimate() {
    if (!W || !estimate.isConnected) return;
    const [w, s, e, n] = viewBounds();
    if (!(e > w && n > s)) return;
    const kmW = 111.32 * (e - w) * Math.cos(((s + n) / 2) * Math.PI / 180), kmH = 111.32 * (n - s);
    const tiles = countTiles([w, s, e, n], +detailSel.value);
    const tooBig = mapInfo.maxTiles && tiles > mapInfo.maxTiles;
    estimate.textContent = `VISIBLE AREA ${kmW < 10 ? kmW.toFixed(1) : Math.round(kmW)} × ${kmH < 10 ? kmH.toFixed(1) : Math.round(kmH)} KM · ${tiles.toLocaleString()} TILES${tooBig ? ' · TOO LARGE: ZOOM IN OR LOWER DETAIL' : ''}`;
    estimate.style.color = tooBig ? 'var(--bad)' : '';
    dlBtn.disabled = !!tooBig || mapInfo.job?.state === 'running';
  }

  const mapsBox = h('div');
  function archiveRow(a) {
    const remove = async () => {
      if (!confirm(`Delete the stored map ${a.file}?`)) return;
      try { await api(`/api/maps/${encodeURIComponent(a.file)}`, { method: 'DELETE' }); await refreshMaps(); } catch (error) { toast(error.message, true); }
    };
    return h('tr',
      h('td', h('div', String(a.name || a.file).toUpperCase()), h('div.hint', archiveText(a))),
      h('td.num', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
        a.error ? null : h('button.btn.sm', { title: 'Show this area', onclick: () => fit(a.bounds) }, 'GO'),
        mapInfo.canAdmin ? h('button.btn.sm.danger', { title: 'Delete this map file', onclick: remove }, 'DEL') : null)));
  }

  function paintMaps() {
    const rows = mapInfo.archives.length
      ? h('div.scroll-x', h('table.t', h('tbody', mapInfo.archives.map(archiveRow))))
      : h('div.empty', 'NO STREET MAPS STORED');
    mapsBox.replaceChildren(panel('OFFLINE MAPS', String(mapInfo.archives.length).padStart(2, '0'), h('div',
      h('div.pb.flush', rows),
      h('div.pb', mapInfo.job ? jobMeter(mapInfo.job) : null,
        mapInfo.canAdmin ? dlForm : h('p.hint', { style: 'margin:0 0 8px' }, 'Downloads can be started from the host machine only.'),
        h('p.hint', { style: 'margin:8px 0 0' }, 'While you have a link, pan and zoom to your area and download it: roads, footpaths, tracks, rivers, buildings, place names and key points (water, medical, fuel, shelter). Zoom 15 is needed for footpaths. Map data © OpenStreetMap contributors, via the Protomaps daily build. You can also copy .pmtiles files into the maps folder of the data directory.')))));
    updateEstimate();
  }

  async function refreshMaps() {
    try { mapInfo = await api('/api/maps'); } catch { return; }
    streets.setArchives(mapInfo.archives);
    paintMaps(); draw();
  }

  let pollTimer = 0;
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      let next;
      try { next = await api('/api/maps'); } catch { poll(); return; }
      const was = mapInfo.job?.state;
      mapInfo = next;
      if (mapInfo.job?.state === 'running') { paintMaps(); poll(); return; }
      streets.setArchives(mapInfo.archives);
      paintMaps(); draw();
      if (was === 'running' && mapInfo.job?.state === 'done') toast('STREET MAP STORED');
      else if (was === 'running' && mapInfo.job?.state === 'error') toast(`MAP DOWNLOAD FAILED: ${mapInfo.job.error}`.toUpperCase(), true);
    }, 1000);
  }
  if (mapInfo.job?.state === 'running') poll();

  /** Uses the marked point for the Plan: a meeting place (then back to the Plan) or the next point of a route. */
  async function usePick(name) {
    try {
      const w = await api('/api/db/waypoints', { method: 'POST', body: { name: name || `${pick.label} ${waypoints.length + 1}`, lat: +mark.lat.toFixed(6), lon: +mark.lon.toFixed(6), kind: 'rally' } });
      waypoints = [...waypoints, w];
      const p = await api('/api/plan');
      if (pick.kind === 'meeting') {
        const m = p.meeting[pick.key];
        planDoc = await api('/api/plan', { method: 'PUT', body: { meeting: { ...p.meeting, [pick.key]: { ...m, waypointId: w.id, label: m.label || w.name } } } });
        location.hash = '#/plan/places';
        return;
      }
      planDoc = await api('/api/plan', { method: 'PUT', body: { routes: p.routes.map((r) => (r.id === pick.key ? { ...r, waypointIds: [...r.waypointIds, w.id] } : r)) } });
      toast('POINT ADDED TO THE ROUTE');
      mark = null; paintSide(); draw();
    } catch (error) { toast(error.message, true); }
  }

  /** Save-as-waypoint and set-as-home controls for the marked point. Guests get a hint instead. */
  function markActions() {
    const clear = h('button.btn.ghost', { onclick: () => { mark = null; paintSide(); draw(); } }, 'CLEAR');
    if (isGuest()) {
      return [h('p.hint', { style: 'margin-top:10px' }, 'Enter the PIN on Command to save waypoints or set the home position.'), h('div.row', clear)];
    }
    const name = h('input', { placeholder: 'WAYPOINT NAME', maxlength: 40 });
    let forPlan = null;
    if (pick) {
      const label = pick.kind === 'meeting' ? `USE AS MEETING PLACE: ${pick.label}` : 'ADD TO THE ROUTE';
      forPlan = h('div.row', { style: 'margin-top:10px' }, h('button.btn.primary', { type: 'button', onclick: () => usePick(name.value.trim()) }, label));
    }
    return [
      forPlan,
      h('form', { style: 'margin-top:10px', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const w = await api('/api/db/waypoints', { method: 'POST', body: { name: name.value.trim() || `WPT ${waypoints.length + 1}`, lat: +mark.lat.toFixed(6), lon: +mark.lon.toFixed(6) } });
          waypoints = [...waypoints, w]; mark = null; paintSide(); draw();
        } catch (error) { toast(error.message, true); }
      } }, h('div.row', { style: 'flex-wrap:nowrap' }, name, h('button.btn.primary', 'SAVE'))),
      h('div.row', { style: 'margin-top:8px' },
        h('button.btn', { onclick: async () => {
          try { await saveSettings({ lat: +mark.lat.toFixed(6), lon: +mark.lon.toFixed(6) }); toast('HOME POSITION SET'); mark = null; paintSide(); draw(); } catch (error) { toast(error.message, true); }
        } }, 'SET AS HOME'),
        clear),
    ];
  }

  function paintSide() {
    const markPanel = mark ? h('div.pb',
      kv('LAT / LON', fmt(mark)), kv('DMS', toDMS(mark.lat, mark.lon)), kv('MGRS', toMGRS(mark.lat, mark.lon, 4) || 'POLAR'),
      kv('FROM HOME', fromHome(mark)),
      markActions())
      : h('div.pb', h('div.empty', 'NO POINT SELECTED'), h('p.hint', 'Type coordinates above or click the map to mark a point, then save it as a waypoint or set it as your home position.'));

    const noWaypoints = isGuest() ? 'WAYPOINTS NEED THE PIN' : 'NO WAYPOINTS';
    const list = waypoints.length ? h('div.scroll-x', h('table.t', h('tbody', waypoints.map((w) => h('tr',
      h('td', h('div', String(w.name).toUpperCase()), h('div.hint', fromHome(w))),
      h('td.num', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
        h('button.btn.sm', { title: 'Centre map here', onclick: () => centreOn(w, 20) }, 'GO'),
        h('button.btn.sm.danger', { title: 'Delete waypoint', onclick: async () => {
          try { await api(`/api/db/waypoints/${w.id}`, { method: 'DELETE' }); waypoints = waypoints.filter((x) => x.id !== w.id); paintSide(); draw(); } catch (error) { toast(error.message, true); }
        } }, 'DEL'))))))))
      : h('div.empty', noWaypoints);
    const tools = !isGuest() && waypoints.length ? h('div.pb', h('div.row',
      h('button.btn.ghost', { type: 'button', onclick: exportGpx }, 'EXPORT GPX'), printButton(printWaypoints))) : null;

    side.replaceChildren(
      entry,
      h('div', { style: 'height:14px' }),
      panel('SELECTED POINT', 'MRK', markPanel),
      h('div', { style: 'height:14px' }),
      panel('WAYPOINTS', String(waypoints.length).padStart(2, '0'), h('div', h('div.pb.flush', list), tools)),
      h('div', { style: 'height:14px' }),
      mapsBox);
  }

  function exportGpx() {
    const routes = (planDoc?.routes || []).map((r) => ({ name: r.name, points: routeLegs(r, waypoints).points }));
    download(`shelter-waypoints-${today()}.gpx`, gpx(waypoints, routes), 'application/gpx+xml');
  }

  function printWaypoints() {
    printDoc('WAYPOINTS',
      h('table.t', h('thead', h('tr', ['NAME', 'LAT, LON', 'MGRS', 'FROM HOME', 'NOTE'].map((x) => h('th', x)))),
        h('tbody', waypoints.map((w) => h('tr', h('td', w.name), h('td', `${(+w.lat).toFixed(5)}, ${(+w.lon).toFixed(5)}`), h('td', toMGRS(w.lat, w.lon, 5) || '—'), h('td', fromHome(w)), h('td', w.note || ''))))),
      h('p.hint', 'Bearings are true, not magnetic.'));
  }

  // interaction: one pointer drags, two pointers pinch-zoom
  const pointers = new Map();
  let drag = null, pinch = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = local(e);
    pointers.set(e.pointerId, [x, y]);
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]) || 1 };
      drag = null;
    } else if (pointers.size === 1) drag = { x, y, lon: view.lon, my: mercY(view.lat), moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [x, y]);
    if (pinch && pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      zoom(d / pinch.d, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      pinch.d = d;
      return;
    }
    if (drag) {
      if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
      if (drag.moved) { view.lon = drag.lon - (x - drag.x) / view.scale; view.lat = invMercY(drag.my + (y - drag.y) / view.scale); clamp(); draw(); }
    }
    const p = toLL(x, y);
    read.textContent = Math.abs(p.lat) <= MAX_LAT && Math.abs(p.lon) <= 180 ? `${fmt(p)}  //  ${toMGRS(p.lat, p.lon, 3) || 'POLAR'}` : 'OFF CHART';
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      drag = null;
      return;
    }
    if (e.type === 'pointerup' && drag && !drag.moved) {
      const p = toLL(...local(e));
      if (Math.abs(p.lat) <= MAX_LAT && Math.abs(p.lon) <= 180) { mark = p; paintSide(); draw(); }
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0015), ...local(e)); }, { passive: false });

  const ro = new ResizeObserver(() => {
    const r = box.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = Math.floor(r.width); H = Math.floor(r.height);
    canvas.width = Math.max(1, Math.floor(W * dpr)); canvas.height = Math.max(1, Math.floor(H * dpr));
    paint();
  });
  ro.observe(box);
  window.addEventListener('themechange', draw);

  root.append(viewHeader(code, 'MAP', 'Chart stored on this node. Drag to pan, scroll or pinch to zoom, click to mark.'));
  if (pick) {
    root.append(h('div.banner', h('b', 'PLAN'), pick.kind === 'meeting'
      ? `Click the map to choose the meeting place ${pick.label.toLowerCase()}, then use the button under Selected point. `
      : 'Click the map to add points to the route, one at a time. ',
    h('a', { href: '#/plan/places' }, 'Back to the plan')));
  }
  if (!land) root.append(h('div.banner', h('b', 'NOTICE'), 'World outline file missing (public/data/world-110m.json). Street maps, grid and waypoints still work.'));
  if (!mapInfo.archives.length) root.append(h('div.banner', h('b', 'NO STREET MAP'), 'Only the world outline is stored. While you have a link, zoom to your area and use DOWNLOAD VISIBLE AREA under Offline maps to keep its roads and paths on this node.'));
  root.append(
    h('div.map-wrap', box, side),
    h('p.hint', { style: 'margin-top:8px' }, 'Coastlines and borders come from 1:110m Natural Earth data. Where a street map is stored, roads, paths, tracks, water and place names come from OpenStreetMap. Check them against the ground: OSM coverage varies, and trails change.'));
  paintMaps();
  paintSide();
  return () => { ro.disconnect(); window.removeEventListener('themechange', draw); clearTimeout(pollTimer); cancelAnimationFrame(raf); };
}
