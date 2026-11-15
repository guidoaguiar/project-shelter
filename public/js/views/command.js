// 01 COMMAND — node status, position, readiness and configuration.
import { h, api, state, onStatus, saveSettings, home, toast, bytes, duration, hhmm, viewHeader, panel, kv, field, readiness } from '../lib/core.js';
import { toMGRS, toDMS, sunTimes, moonPhase } from '../lib/geo.js';

function meter(label, frac, text) {
  const pct = Math.max(0, Math.min(1, frac || 0)) * 100;
  return h('div.meter',
    h('div.row', h('span', label), h('b', text)),
    h('div.track', h('div.fill' + (pct > 90 ? '.hot' : ''), { style: `width:${pct.toFixed(1)}%` })));
}

export async function render(root) {
  const [index, stores] = await Promise.all([api('/api/manual').catch(() => []), api('/api/db/stores').catch(() => [])]);
  const sysBody = h('div.pb'), linkBody = h('div.pb'), posBody = h('div.pb'), readyBody = h('div.pb');

  function paint() {
    const s = state.status;
    if (!s) { sysBody.replaceChildren(h('div.empty', 'NO TELEMETRY')); return; }
    const y = s.system;
    const memUsed = y.memTotal - y.memFree;
    sysBody.replaceChildren(
      meter('CPU', y.cpu, `${Math.round(y.cpu * 100)}% / ${y.cores} CORES`),
      meter('MEMORY', memUsed / y.memTotal, `${bytes(memUsed)} / ${bytes(y.memTotal)}`),
      y.disk ? meter('STORAGE', 1 - y.disk.free / y.disk.total, `${bytes(y.disk.free)} FREE`) : null,
      kv('HOST', y.host), kv('PLATFORM', `${y.platform} ${y.arch}`), kv('UPTIME', duration(y.uptime)), kv('RUNTIME', `NODE ${y.node}`));

    const port = s.server.port;
    linkBody.replaceChildren(
      kv('UPLINK', s.net.enabled ? (s.net.online ? 'AVAILABLE' : 'OFF GRID') : 'CHECK DISABLED', s.net.online ? 'ok' : 'dim'),
      kv('MODEL LINK', s.ai.online ? (s.ai.model || 'NO MODEL INSTALLED') : 'OFFLINE', s.ai.online && s.ai.model ? 'ok' : 'dim'),
      kv('DOCKER', s.docker.online ? `ENGINE ${s.docker.version}` : 'NOT RUNNING', s.docker.online ? 'ok' : 'dim'),
      kv('ACCESS', s.server.lanMode ? 'LAN MODE' : 'LOCAL ONLY'),
      kv('ADDRESS', s.server.lanMode && y.lan.length ? y.lan.map((ip) => `${ip}:${port}`).join('  ') : `localhost:${port}`),
      h('p.hint', s.server.lanMode
        ? 'Other devices on this network can open the address above. There is no login: do not expose this node to the internet.'
        : 'Serving this machine only. Restart with "npm run lan" to share with phones and tablets on your network.'));

    const pos = home();
    const now = new Date();
    const moon = moonPhase(now);
    if (pos) {
      const sun = sunTimes(now.getFullYear(), now.getMonth() + 1, now.getDate(), pos.lat, pos.lon);
      const hrs = Math.floor(sun.dayHours), mins = Math.round((sun.dayHours - hrs) * 60);
      posBody.replaceChildren(
        h('div.big', toMGRS(pos.lat, pos.lon, 4) || 'POLAR REGION'),
        h('div.hint', { style: 'margin:4px 0 10px' }, toDMS(pos.lat, pos.lon)),
        kv('SUNRISE', sun.polar ? `POLAR ${sun.polar.toUpperCase()}` : hhmm(sun.rise)),
        kv('SUNSET', sun.polar ? '—' : hhmm(sun.set)),
        kv('DAYLIGHT', `${hrs}H ${String(mins).padStart(2, '0')}M`),
        kv('MOON', `${moon.name} ${Math.round(moon.illumination * 100)}%`),
        h('p.hint', 'Sun times are shown in this device\'s time zone.'));
    } else {
      posBody.replaceChildren(
        h('div.empty', 'POSITION NOT SET'),
        h('p.hint', 'Enter your coordinates under Configuration, or pick a point in the Map module, to get grid reference and sun times.'),
        kv('MOON', `${moon.name} ${Math.round(moon.illumination * 100)}%`));
    }

    const r = readiness(stores, state.settings?.people);
    const days = (n) => (n >= 100 ? Math.round(n) : n.toFixed(1));
    readyBody.replaceChildren(
      h('div.stat-row',
        h('div.stat', h('div.lbl', 'WATER'), h('div.big', days(r.waterDays), h('small', 'DAYS'))),
        h('div.stat', h('div.lbl', 'FOOD'), h('div.big', days(r.foodDays), h('small', 'DAYS')))),
      h('div', { style: 'margin-top:12px' },
        kv('GROUP SIZE', `${r.people} ${r.people === 1 ? 'PERSON' : 'PEOPLE'}`),
        kv('ITEMS TRACKED', r.count),
        kv('EXPIRED', r.expired, r.expired ? 'bad' : 'dim'),
        kv('EXPIRING < 90 DAYS', r.soon, r.soon ? 'warn' : 'dim')),
      h('p.hint', r.count ? 'Based on 4 L of water and 2000 kcal per person per day.' : 'Nothing recorded yet. Add supplies in the Stores module.'));
  }

  // Field brief: one manual entry per day, chosen by date.
  const pick = index.length ? index[Math.floor(Date.now() / 864e5) % index.length] : null;
  const search = h('input', { type: 'search', placeholder: 'SEARCH THE FIELD MANUAL', 'aria-label': 'Search the field manual' });
  const brief = h('div.pb',
    h('form', { onsubmit: (e) => { e.preventDefault(); if (search.value.trim()) location.hash = `#/manual/?q=${encodeURIComponent(search.value.trim())}`; } },
      h('div.row', { style: 'flex-wrap:nowrap;margin-bottom:14px' }, search, h('button.btn', 'FIND'))),
    pick ? [
      h('span.tag.acc', pick.category),
      h('h2', { style: 'font:600 18px/1.3 var(--sans);margin:8px 0 6px' }, pick.title),
      h('p', { style: 'font:14px/1.6 var(--sans);color:var(--dim);margin:0 0 12px' }, pick.summary),
      h('a.btn', { href: `#/manual/${pick.id}`, style: 'text-decoration:none;display:inline-block' }, 'OPEN ENTRY'),
    ] : h('div.empty', 'NO MANUAL ENTRIES LOADED'));

  // Configuration
  const st = state.settings || { ai: {} };
  const f = {
    callsign: h('input', { value: st.callsign || '', maxlength: 24 }),
    people: h('input', { type: 'number', min: 1, max: 999, value: st.people ?? 2 }),
    lat: h('input', { inputmode: 'decimal', placeholder: '38.8977', value: st.lat ?? '' }),
    lon: h('input', { inputmode: 'decimal', placeholder: '-77.0365', value: st.lon ?? '' }),
    provider: h('select', { value: st.ai.provider || 'ollama' }, h('option', { value: 'ollama' }, 'OLLAMA'), h('option', { value: 'openai' }, 'OPENAI-COMPATIBLE')),
    baseUrl: h('input', { value: st.ai.baseUrl || '', placeholder: 'http://127.0.0.1:11434' }),
    model: h('input', { value: st.ai.model || '', placeholder: 'AUTO (FIRST INSTALLED)', list: 'models' }),
    apiKey: h('input', { type: 'password', placeholder: st.ai.apiKeySet ? 'STORED — LEAVE BLANK TO KEEP' : 'OPTIONAL', autocomplete: 'off' }),
  };
  const models = h('datalist', { id: 'models' }, (state.status?.ai.models || []).map((m) => h('option', { value: m })));
  const config = h('form.pb', {
    onsubmit: async (e) => {
      e.preventDefault();
      const ai = { provider: f.provider.value, baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim() };
      if (f.apiKey.value) ai.apiKey = f.apiKey.value;
      try {
        await saveSettings({ callsign: f.callsign.value, people: f.people.value, lat: f.lat.value.trim(), lon: f.lon.value.trim(), ai });
        f.apiKey.value = '';
        toast('CONFIGURATION SAVED');
      } catch (err) { toast(err.message, true); }
    },
  },
    h('div.fr', field('CALLSIGN', f.callsign), field('GROUP SIZE', f.people), field('LATITUDE', f.lat), field('LONGITUDE', f.lon)),
    h('div.fr', field('MODEL PROVIDER', f.provider), field('MODEL SERVER URL', f.baseUrl), field('MODEL', f.model), field('API KEY', f.apiKey)),
    models,
    h('div.row', h('button.btn.primary', 'SAVE CONFIGURATION'),
      h('span.hint', 'Ollama default: http://127.0.0.1:11434. For LM Studio or llama.cpp choose OpenAI-compatible and include /v1 in the URL.')));

  root.append(
    viewHeader('01', 'COMMAND', 'Node status, position and readiness at a glance.'),
    h('div.grid',
      panel('SYSTEM', 'SYS-01', sysBody, 's4'),
      panel('LINKS', 'NET-02', linkBody, 's4'),
      panel('POSITION', 'POS-03', posBody, 's4'),
      panel('FIELD BRIEF', 'MAN-04', brief, 's7'),
      panel('READINESS', 'SUP-05', readyBody, 's5'),
      panel('CONFIGURATION', 'CFG-06', config, 's12')));

  paint();
  return onStatus(paint);
}
