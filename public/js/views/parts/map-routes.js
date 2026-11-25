// MAP — routes and tracks (ordered waypoint lists with distance and bearing per leg), GPX import
// and export, and search of the stored street map tiles for places and points of interest.
import { h, api, toast, panel, kv, isGuest, plural } from '../../lib/core.js';
import { download, today } from '../../lib/export.js';
import { parseGpx, toGpx, planImport, MAX_GPX_CHARS } from '../../lib/gpx.js';
import { routeSummary, routePoints, formatKm, formatBearing, formatHours, moveItem, MAX_ROUTE_POINTS, WALK_KMH } from '../../lib/route.js';
import { routeLegs } from '../../lib/plan.js';
import { pointBounds } from '../../lib/geo.js';
import { GROUPS, searchTiles, searchZoom, pool } from '../../lib/poi.js';
import { POI } from '../../lib/streets.js';
import { paintRoutes, paintHits } from './map-draw.js';

const RADII = [2, 5, 10, 25];
/** Waypoint category suggested for a search hit's group. */
const KIND_FOR_GROUP = { water: 'water', medical: 'medical', shelter: 'shelter' };

const pointName = (p, i) => String(p.name || `PT ${i + 1}`).toUpperCase();
const hitName = (p) => p.name || POI[p.kind]?.[0] || String(p.kind).replaceAll('_', ' ').toUpperCase();

/**
 * Routes, GPX and search for the map view. m is the map's state and actions:
 * { waypoints, mark, planDoc (get/set), centre(), draw(), fit(bounds), centreOn(p, scale), paintSide(), streets }.
 */
export function mapRoutes(m) {
  const st = { routes: [], activeId: null, hits: [], searching: false, searchNote: '' };
  const active = () => st.routes.find((r) => r.id === st.activeId) || null;
  const refresh = () => { m.paintSide(); m.draw(); };

  async function load() {
    st.routes = isGuest() ? [] : await api('/api/db/routes').catch(() => []);
  }

  function paint(ctx, toXY, c, label) {
    paintRoutes(ctx, st.routes, m.waypoints, toXY, c, label, st.activeId);
    paintHits(ctx, st.hits, toXY, c, label);
  }

  async function saveRoute(r, patch) {
    try {
      const u = await api(`/api/db/routes/${r.id}`, { method: 'PUT', body: patch });
      st.routes = st.routes.map((x) => (x.id === u.id ? u : x));
      refresh();
      return u;
    } catch (error) { toast(error.message, true); return null; }
  }

  async function createRoute(body) {
    const r = await api('/api/db/routes', { method: 'POST', body });
    st.routes = [...st.routes, r];
    return r;
  }

  /** Appends a point to the active route: the marked waypoint, or a new waypoint at the mark. */
  async function addMarkToRoute(name, kind) {
    const r = active();
    if (!r || !m.mark) return;
    if (r.waypointIds.length >= MAX_ROUTE_POINTS) { toast(`A ROUTE HOLDS AT MOST ${MAX_ROUTE_POINTS} POINTS`, true); return; }
    let id = m.mark.id;
    if (!id) {
      try {
        const w = await api('/api/db/waypoints', { method: 'POST', body: { name: name || `${r.name} ${r.waypointIds.length + 1}`.slice(0, 60), lat: +m.mark.lat.toFixed(6), lon: +m.mark.lon.toFixed(6), kind: kind || 'other' } });
        m.waypoints = [...m.waypoints, w];
        id = w.id;
      } catch (error) { toast(error.message, true); return; }
    }
    m.mark = null;
    if (await saveRoute(r, { waypointIds: [...r.waypointIds, id] })) toast('POINT ADDED TO THE ROUTE');
  }

  /** Button under Selected point that adds it to the route being edited, or null. */
  function markAction(nameInput, kindSelect) {
    const r = active();
    if (r?.kind !== 'route' || isGuest()) return null;
    const label = m.mark?.id ? `ADD ${String(m.mark.name || 'WAYPOINT').toUpperCase()} TO ${r.name.toUpperCase()}` : `ADD TO ROUTE: ${r.name.toUpperCase()}`;
    return h('div.row', { style: 'margin-top:10px' }, h('button.btn.primary', { type: 'button', onclick: () => addMarkToRoute(nameInput?.value.trim(), kindSelect?.value) }, label));
  }

  // ---------- GPX ----------

  const gpxRoute = (r) => ({ name: r.name, note: r.notes, points: routePoints(r, m.waypoints) });

  function exportAll() {
    const mine = st.routes.filter((r) => r.kind !== 'track').map(gpxRoute);
    const plan = (m.planDoc?.routes || []).map((r) => ({ name: `PLAN: ${r.name}`, note: r.notes, points: routeLegs(r, m.waypoints).points }));
    const tracks = st.routes.filter((r) => r.kind === 'track').map(gpxRoute);
    download(`shelter-map-${today()}.gpx`, toGpx({ waypoints: m.waypoints, routes: [...mine, ...plan], tracks }, { name: 'Shelter waypoints, routes and tracks' }), 'application/gpx+xml');
  }

  function exportOne(r) {
    const data = r.kind === 'track' ? { tracks: [gpxRoute(r)] } : { waypoints: routePoints(r, m.waypoints), routes: [gpxRoute(r)] };
    const file = r.name.toLowerCase().split(/[^a-z0-9]/).filter(Boolean).join('-') || 'route';
    download(`shelter-${file}-${today()}.gpx`, toGpx(data, { name: r.name }), 'application/gpx+xml');
  }

  /** Creates what planImport says, with a few requests at a time. Returns counts. */
  async function runImport(plan) {
    const ids = new Map();
    let failed = 0;
    const made = await pool(plan.waypoints, 4, async ({ key, ...body }) => {
      try { const w = await api('/api/db/waypoints', { method: 'POST', body }); ids.set(key, w.id); return w; } catch { failed++; return null; }
    });
    m.waypoints = [...m.waypoints, ...made.filter(Boolean)];
    const bodies = [
      ...plan.routes.map(({ refs, ...r }) => ({ ...r, waypointIds: refs.map((x) => x.id || ids.get(x.key)).filter(Boolean) })),
      ...plan.tracks,
    ];
    const routes = await pool(bodies, 2, (b) => createRoute(b).catch(() => { failed++; return null; }));
    const count = (kind) => routes.filter((r) => r?.kind === kind).length;
    return { waypoints: made.filter(Boolean).length, routes: count('route'), tracks: count('track'), failed };
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_GPX_CHARS) { toast('GPX FILE TOO LARGE', true); return; }
    let parsed;
    try { parsed = parseGpx(await file.text()); } catch (error) { toast(`CANNOT READ ${file.name}: ${error.message}`.toUpperCase(), true); return; }
    const plan = planImport(parsed, m.waypoints);
    const parts = [plural(plan.waypoints.length, 'new waypoint'), plural(plan.routes.length, 'route'), plural(plan.tracks.length, 'track')];
    if (!plan.waypoints.length && !plan.routes.length && !plan.tracks.length) { toast('NOTHING NEW IN THIS FILE'); return; }
    const extra = [plan.duplicates ? `${plural(plan.duplicates, 'point')} already stored will be reused.` : '', parsed.skipped ? `${plural(parsed.skipped, 'point')} with a bad position will be skipped.` : ''].filter(Boolean).join(' ');
    if (!confirm(`Import ${parts.join(', ')} from ${file.name}? ${extra}`)) return;
    const done = await runImport(plan);
    const pts = [...plan.waypoints, ...plan.tracks.flatMap((t) => t.track.map(([lat, lon]) => ({ lat, lon })))];
    const b = pointBounds(pts);
    if (b) m.fit(b[0] === b[2] && b[1] === b[3] ? [b[0] - 0.01, b[1] - 0.01, b[2] + 0.01, b[3] + 0.01] : b);
    const failed = done.failed ? ' · ' + done.failed + ' FAILED' : '';
    toast(`IMPORTED ${done.waypoints} WAYPOINTS, ${done.routes} ROUTES, ${done.tracks} TRACKS${failed}`, done.failed > 0);
    refresh();
  }

  function gpxRow() {
    const input = h('input', { type: 'file', accept: '.gpx,application/gpx+xml,application/xml,text/xml', hidden: true, onchange: async () => { await importFile(input.files[0]); input.value = ''; } });
    return h('div.row', input,
      h('button.btn.ghost', { type: 'button', onclick: () => input.click() }, 'IMPORT GPX'),
      h('button.btn.ghost', { type: 'button', onclick: exportAll, disabled: !m.waypoints.length && !st.routes.length }, 'EXPORT GPX'));
  }

  // ---------- route list and editor ----------

  async function toPlan(r) {
    try {
      const p = await api('/api/plan');
      if (p.routes.length >= 10) { toast('THE PLAN HOLDS AT MOST 10 ROUTES', true); return; }
      m.planDoc = await api('/api/plan', { method: 'PUT', body: { routes: [...p.routes, { name: r.name, waypointIds: r.waypointIds.slice(0, 50), notes: r.notes || '' }] } });
      toast('ADDED TO THE PLAN AS AN EVACUATION ROUTE');
      m.draw();
    } catch (error) { toast(error.message, true); }
  }

  function legsTable(s) {
    if (!s.legs.length) return h('p.hint', 'Add at least two points: mark them on the map, or pick saved waypoints below.');
    return h('div.scroll-x', h('table.t.legs', h('thead', h('tr', ['LEG', 'KM', 'BEARING'].map((x) => h('th', x)))),
      h('tbody', s.legs.map((l, i) => h('tr', h('td', `${pointName(l.from, i)} → ${pointName(l.to, i + 1)}`), h('td.num', formatKm(l.km).replace(' KM', '')), h('td.num', formatBearing(l.bearing)))))));
  }

  function editor(r) {
    const s = routeSummary(r, m.waypoints);
    const byId = new Map(m.waypoints.map((w) => [w.id, w]));
    const name = h('input', { value: r.name, maxlength: 60, required: true, 'aria-label': 'Route name' });
    const notes = h('input', { value: r.notes || '', maxlength: 500, placeholder: 'NOTES', 'aria-label': 'Route notes' });
    const add = h('select', { 'aria-label': 'Waypoint to add' }, h('option', { value: '' }, 'ADD A SAVED WAYPOINT'), m.waypoints.map((w) => h('option', { value: w.id }, String(w.name).toUpperCase())));
    const ids = r.waypointIds;
    const points = r.kind === 'route' && ids.length ? h('ol.route', ids.map((id, j) => h('li',
      String(byId.get(id)?.name || 'MISSING').toUpperCase(),
      h('span.row', { style: 'display:inline-flex;margin-left:8px' },
        h('button.btn.sm', { type: 'button', title: 'Move up', disabled: j === 0, onclick: () => saveRoute(r, { waypointIds: moveItem(ids, j, -1) }) }, '↑'),
        h('button.btn.sm', { type: 'button', title: 'Move down', disabled: j === ids.length - 1, onclick: () => saveRoute(r, { waypointIds: moveItem(ids, j, 1) }) }, '↓'),
        h('button.btn.sm.danger', { type: 'button', title: 'Remove from route', onclick: () => saveRoute(r, { waypointIds: ids.filter((_, k) => k !== j) }) }, '✕'))))) : null;
    const verb = s.missing === 1 ? 'exists' : 'exist';
    const climb = s.up || s.down ? kv('CLIMB / DESCENT', `${Math.round(s.up)} M / ${Math.round(s.down)} M`) : null;
    return h('form.pb.route-edit', {
      onsubmit: async (e) => { e.preventDefault(); if (await saveRoute(r, { name: name.value.trim(), notes: notes.value.trim() })) toast('ROUTE SAVED'); },
    },
      h('div', { style: 'display:grid;gap:6px' }, name, notes),
      kv('TOTAL', `${formatKm(s.km)} · ${plural(r.kind === 'track' ? s.points.length : s.legs.length, r.kind === 'track' ? 'point' : 'leg')}`),
      kv('ON FOOT', `${formatHours(s.hours)} AT ${WALK_KMH} KM/H`),
      climb,
      s.missing ? h('p.hint', { style: 'color:var(--warn)' }, `${plural(s.missing, 'waypoint')} in this route no longer ${verb}.`) : null,
      r.kind === 'route' ? [points, legsTable(s),
        h('div.row', { style: 'flex-wrap:nowrap;margin-top:8px' }, add, h('button.btn', { type: 'button', onclick: () => { if (add.value) void saveRoute(r, { waypointIds: [...ids, add.value] }); } }, 'ADD')),
        h('p.hint', 'Or click the map (or a waypoint on it), then ADD TO ROUTE under Selected point. Bearings are true, not magnetic.')] : null,
      h('div.row', { style: 'margin-top:10px' },
        h('button.btn.primary', 'SAVE'),
        r.kind === 'route' && ids.length >= 2 ? h('button.btn', { type: 'button', title: 'Add to the household plan as an evacuation route', onclick: () => toPlan(r) }, 'TO PLAN') : null,
        h('button.btn.ghost', { type: 'button', onclick: () => { st.activeId = null; refresh(); } }, 'DONE')));
  }

  function routeRow(r) {
    const s = routeSummary(r, m.waypoints);
    const remove = async () => {
      if (!confirm(`Delete the ${r.kind} "${r.name}"? Its waypoints are kept.`)) return;
      try {
        await api(`/api/db/routes/${r.id}`, { method: 'DELETE' });
        st.routes = st.routes.filter((x) => x.id !== r.id);
        if (st.activeId === r.id) st.activeId = null;
        refresh();
      } catch (error) { toast(error.message, true); }
    };
    const go = () => { if (s.bounds) m.fit(s.bounds[0] === s.bounds[2] ? [s.bounds[0] - 0.01, s.bounds[1] - 0.01, s.bounds[2] + 0.01, s.bounds[3] + 0.01] : s.bounds); };
    return h('tr' + (r.id === st.activeId ? '.on' : ''),
      h('td', h('div', String(r.name).toUpperCase(), ' ', h('span.tag', r.kind === 'track' ? 'TRK' : 'RTE')), h('div.hint', `${formatKm(s.km)} · ${formatHours(s.hours)} ON FOOT`)),
      h('td.num', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
        h('button.btn.sm', { title: 'Show the whole route', disabled: !s.bounds, onclick: go }, 'GO'),
        h('button.btn.sm', { title: 'Edit, see legs and bearings', onclick: () => { st.activeId = st.activeId === r.id ? null : r.id; refresh(); if (st.activeId) go(); } }, 'EDIT'),
        h('button.btn.sm', { title: 'Save as a GPX file', onclick: () => exportOne(r) }, 'GPX'),
        h('button.btn.sm.danger', { title: 'Delete', onclick: remove }, 'DEL'))));
  }

  function routesPanel() {
    if (isGuest()) return panel('ROUTES', '—', h('div.pb', h('div.empty', 'ROUTES NEED THE PIN')));
    const name = h('input', { placeholder: 'NEW ROUTE NAME', maxlength: 60, 'aria-label': 'New route name' });
    const create = h('form', { style: 'margin-top:10px', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await createRoute({ name: name.value.trim() || `ROUTE ${st.routes.length + 1}`, kind: 'route', waypointIds: m.mark?.id ? [m.mark.id] : [] });
        st.activeId = r.id; refresh();
      } catch (error) { toast(error.message, true); }
    } }, h('div.row', { style: 'flex-wrap:nowrap' }, name, h('button.btn.primary', 'NEW')));
    const list = st.routes.length ? h('div.scroll-x', h('table.t', h('tbody', st.routes.map(routeRow)))) : h('div.empty', 'NO ROUTES');
    const r = active();
    return panel('ROUTES', String(st.routes.length).padStart(2, '0'), h('div',
      h('div.pb.flush', list),
      r ? h('div', { style: 'border-top:1px solid var(--line)' }, h('div.pb', { style: 'padding-bottom:0' }, h('b', `EDITING: ${r.name.toUpperCase()}`)), editor(r)) : null,
      h('div.pb', create, h('div', { style: 'margin-top:10px' }, gpxRow()),
        h('p.hint', { style: 'margin:8px 0 0' }, 'A route is an ordered list of waypoints: distance and bearing for each leg. GPX files from GPS units and phone apps bring in waypoints, routes and tracks.'))));
  }

  // ---------- search ----------

  const query = h('input', { placeholder: 'CLINIC, WATER, A PLACE NAME', maxlength: 60, 'aria-label': 'Search the stored map', autocomplete: 'off' });
  const radius = h('select', { 'aria-label': 'Search radius', value: '5' }, RADII.map((k) => h('option', { value: k }, `${k} KM`)));

  const fetchTile = async (z, x, y) => {
    if (!m.streets.covers(z, x, y)) return null;
    const r = await fetch(`/api/maps/tile/${z}/${x}/${y}`);
    if (r.status === 204 || !r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  };

  async function search(q) {
    if (!m.streets.enabled) { toast('NO STREET MAP STORED: DOWNLOAD AN AREA FIRST', true); return; }
    const origin = m.mark || m.centre();
    const km = +radius.value;
    st.searching = true; st.hits = []; st.searchNote = ''; refresh();
    try {
      const zoom = searchZoom(origin.lat, origin.lon, km, m.streets.maxZoom, 200);
      st.hits = await searchTiles({ fetchTile, lat: origin.lat, lon: origin.lon, query: q, radiusKm: km, zoom, limit: 25, maxTiles: 200 });
      st.searchNote = `${plural(st.hits.length, 'result')} within ${km} km of the ${m.mark ? 'marked point' : 'map centre'}`;
    } finally {
      st.searching = false;
      refresh();
    }
  }

  function pickHit(p) {
    m.mark = { lat: p.lat, lon: p.lon, poi: hitName(p), kind: KIND_FOR_GROUP[p.group] || 'other' };
    m.centreOn(p, 60);
    m.paintSide();
  }

  function searchPanel() {
    const results = st.hits.length ? h('div.scroll-x', h('table.t', h('tbody', st.hits.map((p, i) => h('tr', { style: 'cursor:pointer', onclick: () => pickHit(p) },
      h('td', h('div', `${i + 1}. ${hitName(p).toUpperCase()}`), h('div.hint', `${String(p.kind).replaceAll('_', ' ').toUpperCase()} · ${formatKm(p.km)} ${formatBearing(p.bearing)}`)))))))
      : null;
    return panel('SEARCH MAP', 'POI', h('div',
      h('form.pb', { onsubmit: (e) => { e.preventDefault(); if (query.value.trim()) void search(query.value); } },
        h('div.row', { style: 'flex-wrap:nowrap' }, query, radius, h('button.btn.primary', { disabled: st.searching }, st.searching ? '…' : 'FIND')),
        h('div.row.poi-groups', { style: 'margin-top:8px' }, GROUPS.slice(0, 5).map(([g, label]) => h('button.btn.sm', { type: 'button', disabled: st.searching, onclick: () => { query.value = label.split(' ')[0].toLowerCase(); void search({ group: g, words: [] }); } }, label))),
        st.searchNote ? h('p.hint', { style: 'margin:8px 0 0' }, st.searchNote.toUpperCase()) : null,
        st.hits.length ? h('div.row', { style: 'margin-top:6px' }, h('button.btn.sm.ghost', { type: 'button', onclick: () => { st.hits = []; st.searchNote = ''; refresh(); } }, 'CLEAR RESULTS')) : null),
      results ? h('div.pb.flush', results) : null,
      h('div.pb', { style: 'padding-top:0' }, h('p.hint', { style: 'margin:0' }, 'Searches the street maps stored on this node, around the marked point or the map centre. Results are only as complete as OpenStreetMap is in your area.'))));
  }

  return { st, load, paint, markAction, routesPanel, searchPanel, active };
}
