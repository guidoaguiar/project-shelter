// 01 COMMAND — node status, position, readiness and configuration.
import { h, api, state, onStatus, saveSettings, home, toast, bytes, duration, hhmm, viewHeader, panel, kv, field, readiness, access, isHost, isGuest, pinForm, signOut, plural } from '../lib/core.js';
import { completeness } from '../lib/plan.js';
import { overdue } from '../lib/kits.js';
import { toMGRS, toDMS, sunTimes, moonPhase } from '../lib/geo.js';

function meter(label, frac, text) {
  const pct = Math.max(0, Math.min(1, frac || 0)) * 100;
  return h('div.meter',
    h('div.row', h('span', label), h('b', text)),
    h('div.track', h('div.fill' + (pct > 90 ? '.hot' : ''), { style: `width:${pct.toFixed(1)}%` })));
}

const dim = (on) => (on ? 'ok' : 'dim');

function uplinkText(net) {
  if (!net.enabled) return 'CHECK DISABLED';
  return net.online ? 'AVAILABLE' : 'OFF GRID';
}

function systemRows(y) {
  const memUsed = y.memTotal - y.memFree;
  return [
    meter('CPU', y.cpu, `${Math.round(y.cpu * 100)}% / ${y.cores} CORES`),
    meter('MEMORY', memUsed / y.memTotal, `${bytes(memUsed)} / ${bytes(y.memTotal)}`),
    y.disk ? meter('STORAGE', 1 - y.disk.free / y.disk.total, `${bytes(y.disk.free)} FREE`) : null,
    kv('HOST', y.host), kv('PLATFORM', `${y.platform} ${y.arch}`), kv('UPTIME', duration(y.uptime)), kv('RUNTIME', `NODE ${y.node}`),
  ];
}

function linkRows(s) {
  const { port, lanMode } = s.server;
  const lan = lanMode && s.system.lan.length;
  return [
    kv('UPLINK', uplinkText(s.net), dim(s.net.online)),
    kv('MODEL LINK', s.ai.online ? (s.ai.model || 'NO MODEL INSTALLED') : 'OFFLINE', dim(s.ai.online && s.ai.model)),
    kv('DOCKER', s.docker.online ? `ENGINE ${s.docker.version}` : 'NOT RUNNING', dim(s.docker.online)),
    kv('ACCESS', lanMode ? 'LAN MODE' : 'LOCAL ONLY'),
    kv('ADDRESS', lan ? s.system.lan.map((ip) => `${ip}:${port}`).join('  ') : `localhost:${port}`),
    h('p.hint', lanMode
      ? 'Other devices on this network can open the address above. There is no login: do not expose this node to the internet.'
      : 'Serving this machine only. Restart with "npm run lan" to share with phones and tablets on your network.'),
  ];
}

function positionRows(pos, now) {
  const moon = moonPhase(now);
  const moonRow = kv('MOON', `${moon.name} ${Math.round(moon.illumination * 100)}%`);
  if (!pos) {
    return [
      h('div.empty', 'POSITION NOT SET'),
      h('p.hint', 'Enter your coordinates under Configuration, or pick a point in the Map module, to get grid reference and sun times.'),
      moonRow,
    ];
  }
  const sun = sunTimes(now.getFullYear(), now.getMonth() + 1, now.getDate(), pos.lat, pos.lon);
  const hrs = Math.floor(sun.dayHours), mins = Math.round((sun.dayHours - hrs) * 60);
  return [
    h('div.big', toMGRS(pos.lat, pos.lon, 4) || 'POLAR REGION'),
    h('div.hint', { style: 'margin:4px 0 10px' }, toDMS(pos.lat, pos.lon)),
    kv('SUNRISE', sun.polar ? `POLAR ${sun.polar.toUpperCase()}` : hhmm(sun.rise)),
    kv('SUNSET', sun.polar ? '—' : hhmm(sun.set)),
    kv('DAYLIGHT', `${hrs}H ${String(mins).padStart(2, '0')}M`),
    moonRow,
    h('p.hint', 'Sun times are shown in this device\'s time zone.'),
  ];
}

const days = (n) => (n >= 100 ? Math.round(n) : n.toFixed(1));

function readinessRows(r, kitsDue, fromPlan) {
  let group = plural(r.people, 'PERSON', 'PEOPLE');
  if (fromPlan && r.pets) group += ' + ' + plural(r.pets, 'PET');
  return [
    h('div.stat-row',
      h('div.stat', h('div.lbl', 'WATER'), h('div.big', days(r.waterDays), h('small', 'DAYS'))),
      h('div.stat', h('div.lbl', 'FOOD'), h('div.big', days(r.foodDays), h('small', 'DAYS'))),
      h('div.stat', h('div.lbl', 'MEDS'), h('div.big' + (r.meds && r.meds.days < 7 ? '.bad' : ''), r.meds ? days(r.meds.days) : '—', r.meds ? h('small', 'DAYS') : null))),
    h('div', { style: 'margin-top:12px' },
      kv(fromPlan ? 'HOUSEHOLD' : 'GROUP SIZE', group),
      kv('ITEMS TRACKED', r.count),
      kv('EXPIRED', r.expired, r.expired ? 'bad' : 'dim'),
      kv(`EXPIRING < ${r.warnDays} DAYS`, r.soon, r.soon ? 'warn' : 'dim'),
      kv('LOW STOCK', r.low, r.low ? 'warn' : 'dim'),
      kv('KITS DUE A CHECK', kitsDue, kitsDue ? 'warn' : 'dim')),
    h('p.hint', r.count ? 'Water and food days use the household in Plan, or 4 L and 2000 kcal per person.' : 'Nothing recorded yet. Add supplies in the Stores module.'),
    r.meds ? h('p.hint', `Medication that runs out first: ${r.meds.name}.`) : null,
  ];
}

/** The plan's checklist score, review date, and links to what is missing. */
function planRows(c) {
  let review = 'NEVER REVIEWED';
  if (c.nextReview) review = c.overdue ? `OVERDUE SINCE ${c.nextReview}` : c.nextReview;
  return [
    h('div.stat-row', h('div.stat', h('div.lbl', 'PLAN'), h('div.big' + (c.done === c.total ? '' : '.warn'), `${c.done}/${c.total}`))),
    h('div', { style: 'margin-top:12px' }, kv('NEXT REVIEW', review, c.overdue ? 'warn' : 'ok')),
    h('ul.checklist', c.items.filter((x) => !x.done).slice(0, 4).map((x) => h('li', h('span.mark', '·'), h('a', { href: `#/plan/${x.tab}` }, x.label)))),
    h('a.btn', { href: '#/plan/review', style: 'text-decoration:none;display:inline-block' }, 'OPEN PLAN'),
  ];
}

const ago = (iso) => {
  if (!iso) return 'NEVER';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  if (d <= 0) return 'TODAY';
  return `${plural(d, 'DAY')} AGO`;
};

/** Backup, restore and automatic snapshots. Host machine only. */
function dataPanel() {
  const body = h('div.pb');
  const report = h('div');
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Backup file' });
  let backup = null;

  async function run(mode, dryRun) {
    const r = await api('/api/restore', { method: 'POST', body: { backup, mode, dryRun } });
    return r.report;
  }
  const line = ([name, c]) => h('tr', h('td', name.toUpperCase()), ...['add', 'update', 'skip', 'remove', 'invalid'].map((k) => h('td.num', c[k] || '—')));
  async function preview() {
    report.replaceChildren(h('p.hint', 'Checking the file…'));
    try {
      backup = JSON.parse(await file.files[0].text());
      const [merge, replace] = await Promise.all([run('merge', true), run('replace', true)]);
      const apply = (mode) => async () => {
        const warning = mode === 'replace'
          ? 'Replace everything on this node with the backup? A snapshot of the current data is saved first.'
          : 'Merge the backup into this node? Newer records win; nothing is deleted. A snapshot is saved first.';
        if (!confirm(warning)) return;
        try { await run(mode, false); toast('RESTORED'); setTimeout(() => location.reload(), 600); } catch (error) { toast(error.message, true); }
      };
      const table = (title, rep) => [h('div.lbl', { style: 'margin:10px 0 4px' }, title),
        h('div.scroll-x', h('table.t', h('thead', h('tr', h('th', ''), ['ADD', 'UPDATE', 'SKIP', 'REMOVE', 'INVALID'].map((x) => h('th.num', x)))), h('tbody', Object.entries(rep.collections).map(line)))),
        h('p.hint', `Plan: ${rep.plan}. Settings: ${rep.settings}.`)];
      report.replaceChildren(
        h('p.hint', `Backup of ${backup.node?.callsign || 'a node'}, made ${String(backup.created || '').slice(0, 16).replace('T', ' ')}.`),
        ...table('MERGE', merge), ...table('REPLACE', replace),
        h('div.row', h('button.btn', { onclick: apply('merge') }, 'MERGE'), h('button.btn.danger', { onclick: apply('replace') }, 'REPLACE')));
    } catch (error) { backup = null; report.replaceChildren(h('p.hint.bad', error.message)); }
  }
  file.addEventListener('change', () => { if (file.files[0]) preview().catch(() => {}); });

  async function paint() {
    const snaps = await api('/api/snapshots').catch(() => []);
    const last = state.settings?.lastBackup;
    const stale = !last || Date.now() - Date.parse(last) > 30 * 864e5;
    body.replaceChildren(
      kv('LAST DOWNLOADED BACKUP', ago(last), stale ? 'warn' : 'ok'),
      h('div.row', { style: 'margin:10px 0' },
        h('a.btn.primary', { href: '/api/backup', download: '', style: 'text-decoration:none', onclick: () => setTimeout(() => api('/api/settings').then((v) => { state.settings = v; }, () => {}), 1500) }, 'DOWNLOAD BACKUP')),
      h('p.hint', 'One file with settings, notes, supplies, waypoints, the plan and kits. Never the model key or the PIN. Keep a copy on a USB stick.'),
      h('div.lbl', { style: 'margin:14px 0 6px' }, 'RESTORE'),
      file, report,
      h('div.lbl', { style: 'margin:14px 0 6px' }, 'AUTOMATIC SNAPSHOTS'),
      snaps.length ? h('div.list', snaps.slice(0, 8).map((x) => h('a', { href: `/api/snapshots/${x.name}`, download: '' },
        h('div.t1', x.created.slice(0, 16).replace('T', ' ')), h('div.t2', `${x.kind.toUpperCase()} · ${bytes(x.size)}`)))) : h('p.hint', 'None yet. One is saved each day the data changes.'));
  }
  paint().catch(() => {});
  return body;
}

const POLICIES = [
  ['pin', 'PIN', 'Other devices need the PIN to see or change household data. Without it they still get the manual, map, tools and advisor.'],
  ['readonly', 'READ-ONLY', 'Only this machine can see and change household data.'],
  ['open', 'OPEN', 'Any device on your network can see and change household data.'],
];

async function saveAccess(patch, message) {
  try { await saveSettings({ access: patch }); toast(message); } catch (error) { toast(error.message, true); }
}

function removePin() {
  if (confirm('Remove the PIN? Other devices become read-only until you set a new one.')) return saveAccess({ pin: '' }, 'PIN REMOVED');
  return Promise.resolve();
}

/** Access controls for the host: the LAN policy and the PIN. */
function hostAccess(a, lanMode) {
  const policy = h('select', { value: a.lanWrites, 'aria-label': 'Other devices' }, POLICIES.map(([v, label]) => h('option', { value: v }, label)));
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 12, placeholder: a.pinSet ? 'NEW PIN' : '4-12 DIGITS' });
  const explain = h('p.hint');
  const describe = () => { explain.textContent = POLICIES.find(([v]) => v === policy.value)[2]; };
  policy.addEventListener('change', describe);
  describe();
  return [
    kv('THIS DEVICE', 'HOST MACHINE'),
    lanMode ? null : h('p.hint', 'Serving this machine only, so these settings take effect once LAN mode is on.'),
    h('div.fr', field('OTHER DEVICES', policy)),
    explain,
    h('div.row', h('button.btn', { onclick: () => saveAccess({ lanWrites: policy.value }, 'ACCESS POLICY SAVED') }, 'SAVE POLICY')),
    h('form', {
      style: 'margin-top:14px',
      onsubmit: (e) => {
        e.preventDefault();
        // Setting a PIN turns PIN protection on, unless other devices are read-only.
        return saveAccess({ pin: pin.value.trim(), ...(a.lanWrites === 'readonly' ? {} : { lanWrites: 'pin' }) }, 'PIN SET');
      },
    },
      h('div.fr', field(a.pinSet ? 'CHANGE PIN' : 'SET A PIN', pin)),
      h('div.row',
        h('button.btn.primary', a.pinSet ? 'CHANGE PIN' : 'SET PIN'),
        a.pinSet ? h('button.btn.danger', { type: 'button', onclick: removePin }, 'REMOVE PIN') : null)),
    h('p.hint', 'The PIN stops people on your network from reading or changing your data by accident. It does not protect against someone who can watch your network traffic.'),
  ];
}

function accessRows(a, lanMode) {
  if (a.role === 'host') return hostAccess(a, lanMode);
  if (a.role === 'member') {
    const out = () => signOut().then(() => toast('SIGNED OUT'), (error) => toast(error.message, true));
    return [
      kv('THIS DEVICE', 'MEMBER', 'ok'),
      a.lanWrites === 'open'
        ? h('p.hint', 'Any device on this network can see and change household data.')
        : h('div.row', h('button.btn', { onclick: out }, 'SIGN OUT')),
      h('p.hint', 'Model and access settings can only be changed on the host machine.'),
    ];
  }
  return [kv('THIS DEVICE', 'GUEST', 'warn'), h('p.hint', 'Enter the PIN to see and change notes, supplies, waypoints and the home position.'), pinForm()];
}

export async function render(root, _arg, { code } = {}) {
  const guest = isGuest();
  const get = (u, fallback) => (guest ? fallback : api(u).catch(() => fallback));
  const [index, stores, people, kits, contacts, planDoc] = await Promise.all([api('/api/manual').catch(() => []),
    get('/api/db/stores', []), get('/api/db/people', []), get('/api/db/kits', []), get('/api/db/contacts', []), get('/api/plan', null)]);
  const sysBody = h('div.pb'), linkBody = h('div.pb'), posBody = h('div.pb'), readyBody = h('div.pb'), accessBody = h('div.pb');
  const planBody = h('div.pb', planDoc ? planRows(completeness(planDoc, people, contacts)) : h('div.empty', 'NO PLAN'));
  const kitsDue = kits.filter((k) => overdue(k)).length;
  const banner = h('div');
  let accessKey = '';

  function paint() {
    const s = state.status;
    if (!s) { sysBody.replaceChildren(h('div.empty', 'NO TELEMETRY')); return; }
    sysBody.replaceChildren(...systemRows(s.system));
    linkBody.replaceChildren(...linkRows(s));
    posBody.replaceChildren(...positionRows(home(), new Date()));
    const household = people.length ? people : state.settings?.people;
    readyBody.replaceChildren(...readinessRows(readiness(stores, household, { warnDays: state.settings?.expiryWarnDays || 90 }), kitsDue, people.length > 0));
    // The access panel holds forms, so it is redrawn only when access itself changes.
    const a = access();
    const key = `${a.role}|${a.lanWrites}|${a.pinSet}|${s.server.lanMode}`;
    if (key === accessKey) return;
    accessKey = key;
    accessBody.replaceChildren(...accessRows(a, s.server.lanMode));
    banner.replaceChildren(a.role === 'host' && s.server.lanMode && a.lanWrites === 'open'
      ? h('div.banner', { style: 'margin-bottom:14px' }, h('b', 'NOTICE'), 'Any device on your network can see and change household data. Set a PIN under Access below.')
      : '');
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

  // Guests see no household data: no position, readiness or configuration.
  const panels = guest
    ? [
      panel('SYSTEM', 'SYS-01', sysBody, 's4'),
      panel('LINKS', 'NET-02', linkBody, 's4'),
      panel('ACCESS', 'ACC-07', accessBody, 's4'),
      panel('FIELD BRIEF', 'MAN-04', brief, 's12'),
    ]
    : [
      panel('SYSTEM', 'SYS-01', sysBody, 's4'),
      panel('LINKS', 'NET-02', linkBody, 's4'),
      panel('POSITION', 'POS-03', posBody, 's4'),
      panel('FIELD BRIEF', 'MAN-04', brief, 's7'),
      panel('READINESS', 'SUP-05', readyBody, 's5'),
      panel('PLAN', 'PLN-08', planBody, 's4'),
      isHost() ? panel('DATA', 'BAK-09', dataPanel(), 's8') : null,
      panel('CONFIGURATION', 'CFG-06', configForm(), 's8'),
      panel('ACCESS', 'ACC-07', accessBody, 's4'),
    ].filter(Boolean);

  root.append(
    viewHeader(code, 'COMMAND', 'Node status, position and readiness at a glance.'),
    banner,
    h('div.grid', panels));

  paint();
  return onStatus(paint);
}

/** Node configuration. Model settings can only be changed on the host machine. */
function configForm() {
  const host = isHost();
  const st = state.settings || { ai: {} };
  const f = {
    callsign: h('input', { value: st.callsign || '', maxlength: 24 }),
    people: h('input', { type: 'number', min: 1, max: 999, value: st.people ?? 2 }),
    expiry: h('input', { type: 'number', min: 7, max: 365, value: st.expiryWarnDays ?? 90 }),
    lat: h('input', { inputmode: 'decimal', placeholder: '38.8977', value: st.lat ?? '' }),
    lon: h('input', { inputmode: 'decimal', placeholder: '-77.0365', value: st.lon ?? '' }),
    provider: h('select', { value: st.ai.provider || 'ollama', disabled: !host }, h('option', { value: 'ollama' }, 'OLLAMA'), h('option', { value: 'openai' }, 'OPENAI-COMPATIBLE')),
    baseUrl: h('input', { value: st.ai.baseUrl || '', placeholder: 'http://127.0.0.1:11434', disabled: !host }),
    model: h('input', { value: st.ai.model || '', placeholder: 'AUTO (FIRST INSTALLED)', list: 'models', disabled: !host }),
    apiKey: h('input', { type: 'password', placeholder: st.ai.apiKeySet ? 'STORED — LEAVE BLANK TO KEEP' : 'OPTIONAL', autocomplete: 'off', disabled: !host }),
  };
  const models = h('datalist', { id: 'models' }, (state.status?.ai.models || []).map((m) => h('option', { value: m })));
  const hint = host
    ? 'Ollama default: http://127.0.0.1:11434. For LM Studio or llama.cpp choose OpenAI-compatible and include /v1 in the URL. Changing the server clears a stored API key.'
    : 'Model settings can only be changed on the host machine.';
  return h('form.pb', {
    onsubmit: async (e) => {
      e.preventDefault();
      const patch = { callsign: f.callsign.value, people: f.people.value, lat: f.lat.value.trim(), lon: f.lon.value.trim(), expiryWarnDays: f.expiry.value };
      if (host) {
        patch.ai = { provider: f.provider.value, baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim() };
        if (f.apiKey.value) patch.ai.apiKey = f.apiKey.value;
      }
      try {
        await saveSettings(patch);
        f.apiKey.value = '';
        toast('CONFIGURATION SAVED');
      } catch (error) { toast(error.message, true); }
    },
  },
    h('div.fr', field('CALLSIGN', f.callsign), field('GROUP SIZE', f.people), field('LATITUDE', f.lat), field('LONGITUDE', f.lon), field('EXPIRY WARNING (DAYS)', f.expiry)),
    h('div.fr', field('MODEL PROVIDER', f.provider), field('MODEL SERVER URL', f.baseUrl), field('MODEL', f.model), field('API KEY', f.apiKey)),
    models,
    h('div.row', h('button.btn.primary', 'SAVE CONFIGURATION'), h('span.hint', hint)));
}
