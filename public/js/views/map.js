// 04 MAP — offline vector world map with waypoints, range and bearing.
import { h, api, saveSettings, home, toast, viewHeader, panel, kv } from '../lib/core.js';
import { toMGRS, toDMS, rangeBearing, compassPoint, parseCoord } from '../lib/geo.js';

let world = null; // Path2D in lon/lat space, built once

async function loadWorld() {
  if (world) return world;
  const topo = await (await fetch('/data/world-110m.json')).json();
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }); });
  const path = new Path2D();
  for (const g of topo.objects.countries.geometries) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    for (const poly of polys) for (const ring of poly) {
      // Collect the ring, unwrapping longitude so shapes crossing the 180° line stay continuous.
      const pts = [];
      let offset = 0, latSum = 0;
      for (const idx of ring) {
        const a = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx];
        for (let k = pts.length ? 1 : 0; k < a.length; k++) {
          let lon = a[k][0] + offset;
          if (pts.length) {
            const prev = pts[pts.length - 1][0];
            if (lon - prev > 180) { offset -= 360; lon -= 360; } else if (lon - prev < -180) { offset += 360; lon += 360; }
          }
          pts.push([lon, a[k][1]]);
          latSum += a[k][1];
        }
      }
      if (pts.length < 3) continue;
      // A ring that ends a full turn away from its start circles a pole (Antarctica): close it through the pole.
      const start = pts[0][0], end = pts[pts.length - 1][0];
      if (Math.abs(end - start) > 180) { const pole = latSum < 0 ? -90 : 90; pts.push([end, pole], [start, pole]); }
      let min = Infinity, max = -Infinity;
      for (const p of pts) { if (p[0] < min) min = p[0]; if (p[0] > max) max = p[0]; }
      // Draw the ring, plus a copy shifted a full turn for any part that spills past an edge.
      const shifts = [0];
      if (max > 180) shifts.push(-360);
      if (min < -180) shifts.push(360);
      for (const s of shifts) {
        path.moveTo(pts[0][0] + s, -pts[0][1]);
        for (let k = 1; k < pts.length; k++) path.lineTo(pts[k][0] + s, -pts[k][1]);
        path.closePath();
      }
    }
  }
  return (world = path);
}

export async function render(root) {
  let waypoints = await api('/api/db/waypoints').catch(() => []);
  const land = await loadWorld().catch(() => null);
  const pos0 = home();
  const view = { lon: pos0?.lon ?? 10, lat: pos0?.lat ?? 25, scale: pos0 ? 14 : 3.2 };
  let mark = null; // selected point

  const canvas = h('canvas', { 'aria-label': 'World map. Drag to pan, scroll to zoom, click to mark a point.' });
  const read = h('div.map-read', 'MOVE OVER MAP');
  const box = h('div.map-box.panel', canvas, read,
    h('div.map-ctl',
      h('button.btn', { title: 'Zoom in', onclick: () => zoom(1.6) }, '+'),
      h('button.btn', { title: 'Zoom out', onclick: () => zoom(1 / 1.6) }, '−'),
      h('button.btn', { title: 'Centre on home position', onclick: () => { const p = home(); if (p) { view.lon = p.lon; view.lat = p.lat; draw(); } else toast('HOME POSITION NOT SET', true); } }, '⌂')));
  const side = h('div');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;

  const toXY = (lon, lat) => [W / 2 + (lon - view.lon) * view.scale, H / 2 - (lat - view.lat) * view.scale];
  const toLL = (x, y) => ({ lon: view.lon + (x - W / 2) / view.scale, lat: view.lat - (y - H / 2) / view.scale });
  const clamp = () => {
    view.scale = Math.max(1.2, Math.min(6000, view.scale));
    view.lon = Math.max(-180, Math.min(180, view.lon));
    view.lat = Math.max(-90, Math.min(90, view.lat));
  };
  function zoom(f, x = W / 2, y = H / 2) {
    const before = toLL(x, y);
    view.scale *= f; clamp();
    const after = toLL(x, y);
    view.lon += before.lon - after.lon; view.lat += before.lat - after.lat; clamp();
    draw();
  }

  function draw() {
    if (!W || !H) return;
    const css = getComputedStyle(document.documentElement);
    const c = (n) => css.getPropertyValue(n).trim();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c('--bg'); ctx.fillRect(0, 0, W, H);

    if (land) {
      ctx.save();
      ctx.translate(W / 2 - view.lon * view.scale, H / 2 + view.lat * view.scale);
      ctx.scale(view.scale, view.scale);
      ctx.beginPath(); ctx.rect(-180, -90, 360, 180); ctx.clip(); // keep wrapped copies inside the chart
      ctx.fillStyle = c('--land'); ctx.fill(land, 'evenodd');
      ctx.strokeStyle = c('--land-line'); ctx.lineWidth = 1 / view.scale; ctx.stroke(land);
      ctx.restore();
    }

    // graticule
    const step = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01].filter((s) => s * view.scale >= 70).pop() || 30;
    const a = toLL(0, H), b = toLL(W, 0);
    ctx.strokeStyle = c('--line2'); ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
    ctx.fillStyle = c('--dim'); ctx.font = '9px ui-monospace, Consolas, monospace';
    const dp = step < 0.1 ? 2 : step < 1 ? (step === 0.25 ? 2 : 1) : 0;
    ctx.beginPath();
    for (let lon = Math.ceil(Math.max(-180, a.lon) / step) * step; lon <= Math.min(180, b.lon) + 1e-9; lon += step) {
      const x = Math.round(toXY(lon, 0)[0]) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let lat = Math.ceil(Math.max(-90, a.lat) / step) * step; lat <= Math.min(90, b.lat) + 1e-9; lat += step) {
      const y = Math.round(toXY(0, lat)[1]) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (let lon = Math.ceil(Math.max(-180, a.lon) / step) * step; lon <= Math.min(180, b.lon) + 1e-9; lon += step) {
      ctx.fillText(`${Math.abs(lon).toFixed(dp)}${lon < 0 ? 'W' : lon > 0 ? 'E' : ''}`, toXY(lon, 0)[0] + 3, 10);
    }
    for (let lat = Math.ceil(Math.max(-90, a.lat) / step) * step; lat <= Math.min(90, b.lat) + 1e-9; lat += step) {
      ctx.fillText(`${Math.abs(lat).toFixed(dp)}${lat < 0 ? 'S' : lat > 0 ? 'N' : ''}`, 3, toXY(0, lat)[1] - 3);
    }

    const accent = c('--accent'), text = c('--text');
    const pos = home();
    // range line home -> mark
    if (pos && mark) {
      const [x1, y1] = toXY(pos.lon, pos.lat), [x2, y2] = toXY(mark.lon, mark.lat);
      ctx.strokeStyle = accent; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = '10px ui-monospace, Consolas, monospace';
    for (const w of waypoints) {
      const [x, y] = toXY(w.lon, w.lat);
      ctx.strokeStyle = text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = text; ctx.fillText(String(w.name).toUpperCase(), x + 9, y + 3);
    }
    if (pos) {
      const [x, y] = toXY(pos.lon, pos.lat);
      ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 5); ctx.lineTo(x - 6, y + 5); ctx.closePath(); ctx.fill();
      ctx.fillText('HOME', x + 10, y + 4);
    }
    if (mark) {
      const [x, y] = toXY(mark.lon, mark.lat);
      ctx.strokeStyle = accent; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 12, y + 0.5); ctx.lineTo(x - 4, y + 0.5); ctx.moveTo(x + 4, y + 0.5); ctx.lineTo(x + 12, y + 0.5);
      ctx.moveTo(x + 0.5, y - 12); ctx.lineTo(x + 0.5, y - 4); ctx.moveTo(x + 0.5, y + 4); ctx.lineTo(x + 0.5, y + 12); ctx.stroke();
      ctx.strokeRect(x - 3.5, y - 3.5, 8, 8);
    }
  }

  const fmt = (p) => `${Math.abs(p.lat).toFixed(4)}${p.lat < 0 ? 'S' : 'N'} ${Math.abs(p.lon).toFixed(4)}${p.lon < 0 ? 'W' : 'E'}`;
  const rb = (p) => { const o = home(); if (!o) return '—'; const r = rangeBearing(o, p); return `${r.km < 10 ? r.km.toFixed(2) : r.km.toFixed(0)} KM / ${String(Math.round(r.bearing) % 360).padStart(3, '0')}° ${compassPoint(r.bearing)}`; };

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

  function paintSide() {
    const name = h('input', { placeholder: 'WAYPOINT NAME', maxlength: 40 });
    const markPanel = mark ? h('div.pb',
      kv('LAT / LON', fmt(mark)), kv('DMS', toDMS(mark.lat, mark.lon)), kv('MGRS', toMGRS(mark.lat, mark.lon, 4) || 'POLAR'),
      kv('FROM HOME', rb(mark)),
      h('form', { style: 'margin-top:10px', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const w = await api('/api/db/waypoints', { method: 'POST', body: { name: name.value.trim() || `WPT ${waypoints.length + 1}`, lat: +mark.lat.toFixed(6), lon: +mark.lon.toFixed(6) } });
          waypoints = [...waypoints, w]; mark = null; paintSide(); draw();
        } catch (err) { toast(err.message, true); }
      } }, h('div.row', { style: 'flex-wrap:nowrap' }, name, h('button.btn.primary', 'SAVE'))),
      h('div.row', { style: 'margin-top:8px' },
        h('button.btn', { onclick: async () => {
          try { await saveSettings({ lat: +mark.lat.toFixed(6), lon: +mark.lon.toFixed(6) }); toast('HOME POSITION SET'); mark = null; paintSide(); draw(); } catch (err) { toast(err.message, true); }
        } }, 'SET AS HOME'),
        h('button.btn.ghost', { onclick: () => { mark = null; paintSide(); draw(); } }, 'CLEAR')))
      : h('div.pb', h('div.empty', 'NO POINT SELECTED'), h('p.hint', 'Type coordinates above or click the map to mark a point, then save it as a waypoint or set it as your home position.'));

    const list = waypoints.length ? h('div.scroll-x', h('table.t', h('tbody', waypoints.map((w) => h('tr',
      h('td', h('div', String(w.name).toUpperCase()), h('div.hint', rb(w))),
      h('td.num', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
        h('button.btn.sm', { title: 'Centre map here', onclick: () => { view.lon = w.lon; view.lat = w.lat; if (view.scale < 20) view.scale = 20; draw(); } }, 'GO'),
        h('button.btn.sm.danger', { title: 'Delete waypoint', onclick: async () => {
          try { await api(`/api/db/waypoints/${w.id}`, { method: 'DELETE' }); waypoints = waypoints.filter((x) => x.id !== w.id); paintSide(); draw(); } catch (err) { toast(err.message, true); }
        } }, 'DEL'))))))))
      : h('div.empty', 'NO WAYPOINTS');

    side.replaceChildren(
      entry,
      h('div', { style: 'height:14px' }),
      panel('SELECTED POINT', 'MRK', markPanel),
      h('div', { style: 'height:14px' }),
      panel('WAYPOINTS', String(waypoints.length).padStart(2, '0'), h('div.pb.flush', list)));
  }

  // interaction
  let drag = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { const [x, y] = local(e); drag = { x, y, lon: view.lon, lat: view.lat, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (drag) {
      if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
      if (drag.moved) { view.lon = drag.lon - (x - drag.x) / view.scale; view.lat = drag.lat + (y - drag.y) / view.scale; clamp(); draw(); }
    }
    const p = toLL(x, y);
    read.textContent = Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 ? `${fmt(p)}  //  ${toMGRS(p.lat, p.lon, 3) || 'POLAR'}` : 'OFF CHART';
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      const p = toLL(...local(e));
      if (Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) { mark = p; paintSide(); draw(); }
    }
    drag = null;
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0015), ...local(e)); }, { passive: false });

  const ro = new ResizeObserver(() => {
    const r = box.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = Math.floor(r.width); H = Math.floor(r.height);
    canvas.width = Math.max(1, Math.floor(W * dpr)); canvas.height = Math.max(1, Math.floor(H * dpr));
    draw();
  });
  ro.observe(box);
  window.addEventListener('themechange', draw);

  root.append(viewHeader('04', 'MAP', 'World reference chart stored on this node. Drag to pan, scroll to zoom, click to mark.'));
  if (!land) root.append(h('div.banner', h('b', 'NOTICE'), 'Map data file missing (public/data/world-110m.json). Grid and waypoints still work.'));
  root.append(
    h('div.map-wrap', box, side),
    h('p.hint', { style: 'margin-top:8px' }, 'Coastlines and borders are 1:110m Natural Earth data: good for orientation and range, not for route-level detail. Carry paper maps of your own area.'));
  paintSide();
  return () => { ro.disconnect(); window.removeEventListener('themechange', draw); };
}
