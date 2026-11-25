// 01 COMMAND — the situation first (supplies, kits, reviews, sun, check-in, power), then position,
// readiness, plan and configuration, with the system meters folded away at the bottom.
import { h, api, state, onStatus, saveSettings, home, toast, bytes, duration, hhmm, viewHeader, panel, kv, field, readiness, access, isHost, isGuest, pinForm, signOut, plural } from '../lib/core.js';
import { completeness } from '../lib/plan.js';
import { toMGRS, toDMS, sunTimes, moonPhase } from '../lib/geo.js';
import { powerLevel, batteryBanner, runtimeText, stateText } from '../lib/power.js';
import { kitStatus, attention, checkinState, markCheckin, newCheckin } from '../lib/situation.js';
import { modelTools } from './parts/models.js';

/** Replaces an element's children, skipping null and false (which replaceChildren would print as text). */
const fill = (el, ...rows) => el.replaceChildren(...rows.flat(Infinity).filter((x) => x != null && x !== false));

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

/** A days-of-supply tile; a dash while nothing is tracked. */
const daysTile = (label, value, tracked, limit) =>
  h('div.stat', h('div.lbl', label), h('div.big' + (tracked && value < limit ? '.warn' : ''), tracked ? days(value) : '—', tracked ? h('small', 'DAYS') : null));

/** Days of water, food and meds, kit status and what is overdue. Sun times live in the Position panel. */
function situationRows(r, kits, todo, pos, now) {
  let kitText = 'SET UP';
  if (kits.total) kitText = kits.due ? `${kits.due}/${kits.total} DUE` : `${kits.total} OK`;
  return [
    h('div.stat-row',
      daysTile('WATER', r.waterDays, r.count, 3),
      daysTile('FOOD', r.foodDays, r.count, 3),
      h('div.stat', h('div.lbl', 'MEDS'), h('div.big' + (r.meds && r.meds.days < 7 ? '.bad' : ''), r.meds ? days(r.meds.days) : '—', r.meds ? h('small', 'DAYS') : null)),
      h('div.stat', h('div.lbl', 'KITS'), h('a.big.sit-link' + (kits.due ? '.warn' : ''), { href: '#/stores/kits' }, kitText))),
    h('div.lbl.sit-head', todo.length ? 'NEEDS ATTENTION' : 'NOTHING OVERDUE'),
    todo.length
      ? h('ul.checklist', todo.slice(0, 6).map((x) => h('li', h('span.mark.' + x.level, '!'), h('a', { href: x.href }, x.label))))
      : h('p.hint', 'No expired supplies, overdue kit checks or plan reviews.'),
    todo.length > 6 ? h('p.hint', `And ${todo.length - 6} more.`) : null,
  ];
}

/** One person's check-in button: a tick and the time once accounted for. */
function checkinRow(r, onclick) {
  let note = r.kind === 'pet' ? 'PET' : '';
  if (r.ok && r.at) note = hhmm(new Date(r.at));
  return h('button.item' + (r.ok ? '.ok' : ''), { type: 'button', 'aria-pressed': r.ok ? 'true' : 'false', onclick },
    h('span.mark', r.ok ? '✓' : '·'), h('span.t1', r.name), h('span.t3', note));
}

/** "Everyone accounted for": one line per person or pet in the plan, saved on the node. */
function checkinPanel(people, saved) {
  const body = h('div.pb');
  let doc = saved || {};
  async function save(next, message) {
    try { doc = await api('/api/checkin', { method: 'PUT', body: next }); toast(message); paint(); } catch (error) { toast(error.message, true); }
  }
  function paint() {
    const c = checkinState(doc, people);
    const when = c.startedAt ? `${String(c.startedAt).slice(0, 10)} ${hhmm(new Date(c.startedAt))}` : 'NO CHECK-IN YET';
    let headline = 'NOT CONFIRMED';
    if (c.complete) headline = 'ALL ACCOUNTED FOR';
    else if (c.total) headline = `${c.ok}/${c.total} ACCOUNTED FOR`;
    fill(body, 
      h('div.big' + (c.complete ? '.ok' : '.warn'), { style: 'font-size:18px' }, headline),
      kv('STARTED', when, 'dim'),
      c.total
        ? h('div.list.checkin', c.rows.map((r) => checkinRow(r, () => save(markCheckin(c, r.personId, !r.ok), `${r.name.toUpperCase()} ${r.ok ? 'NOT CONFIRMED' : 'ACCOUNTED FOR'}`))))
        : h('p.hint', 'Add the people in your household under Plan to check each one in by name.'),
      h('div.row', { style: 'margin-top:10px' },
        h('button.btn.primary', { type: 'button', onclick: () => save(markCheckin(c, null, true), 'EVERYONE ACCOUNTED FOR') }, 'EVERYONE ACCOUNTED FOR'),
        h('button.btn', { type: 'button', onclick: () => save(newCheckin(c), 'NEW CHECK-IN STARTED') }, 'NEW CHECK-IN')));
  }
  paint();
  return body;
}

/** A battery meter: the bar turns red when the charge is low. */
function chargeMeter(label, percent) {
  const p = Math.max(0, Math.min(100, percent || 0));
  return h('div.meter',
    h('div.row', h('span', label), h('b', `${Math.round(p)}%`)),
    h('div.track', h('div.fill' + (p < 20 ? '.hot' : ''), { style: `width:${p.toFixed(1)}%` })));
}

const unitText = (u) => (u.percent === null ? '—' : Math.round(u.percent) + '%') + ' · ' + stateText(u.state);

/** Turns low-power mode on or off (saved in settings; the node slows its samplers and stops the advisor). */
const switchLowPower = (on) => saveSettings({ power: { lowPower: on } })
  .then(() => toast(on ? 'LOW-POWER MODE ON' : 'LOW-POWER MODE OFF'), (error) => toast(error.message, true));

/** The low-power button: off turns it on, on turns it off. */
function lowPowerButton(low) {
  if (low) return h('button.btn', { type: 'button', onclick: () => switchLowPower(false) }, 'TURN OFF LOW POWER');
  return h('button.btn.primary', { type: 'button', onclick: () => switchLowPower(true) }, 'LOW-POWER MODE');
}

/** The battery or UPS rows: charge, runtime, each unit when there are several, and where the figures come from. */
function batteryRows(p) {
  if (!p?.present) return [];
  const units = p.units || [];
  const runtime = p.estimated ? `${runtimeText(p.runtimeMin)} (EST.)` : runtimeText(p.runtimeMin);
  const label = units.length > 1 ? String(p.primary || 'BATTERY').toUpperCase() : 'CHARGE';
  return [
    p.percent === null ? null : chargeMeter(label, p.percent),
    p.onBattery ? kv('RUNTIME', runtime, 'warn') : kv('RUNTIME', 'ON MAINS', 'dim'),
    units.length > 1 ? units.map((u) => kv(String(u.name).toUpperCase(), unitText(u))) : null,
    kv('SOURCE', String(p.source).toUpperCase(), 'dim'),
  ];
}

/** Battery or UPS status, estimated runtime and the low-power switch. */
function powerRows(p, guest) {
  const lv = powerLevel(p);
  const low = !!p?.lowPower;
  return [
    kv('POWER', lv.text, lv.level),
    ...batteryRows(p),
    kv('LOW-POWER MODE', low ? 'ON' : 'OFF', low ? 'warn' : 'dim'),
    h('div.row', { style: 'margin-top:10px' },
      guest ? null : lowPowerButton(low),
      h('a.btn', { href: '#/tools/power', style: 'text-decoration:none' }, 'POWER BUDGET')),
    h('p.hint', 'Low-power mode checks status every 60 s instead of 5 s, samples the CPU less often and turns off the advisor.'),
    p?.error ? h('p.hint', `Power check: ${p.error}`) : null,
  ];
}

function readinessRows(r, kitsDue, fromPlan) {
  let group = plural(r.people, 'PERSON', 'PEOPLE');
  if (fromPlan && r.pets) group += ' + ' + plural(r.pets, 'PET');
  return [
    h('div',
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
      fill(report,
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
    fill(body, 
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

const FOLD_KEY = 'shelter.command.system';
/** The system meters and links, folded below the situation. Open or closed is remembered on this device. */
function systemFold(guest, summary, ...panels) {
  let open = guest;
  try { open = (localStorage.getItem(FOLD_KEY) ?? String(guest)) === 'true'; } catch { /* storage unavailable */ }
  const fold = h('details.sys-fold', { open }, h('summary', h('span', 'SYSTEM AND LINKS'), summary), h('div.grid', panels));
  fold.addEventListener('toggle', () => {
    try { localStorage.setItem(FOLD_KEY, String(fold.open)); } catch { /* storage unavailable */ }
  });
  return fold;
}

export async function render(root, _arg, { code } = {}) {
  const guest = isGuest();
  const get = (u, fallback) => (guest ? fallback : api(u).catch(() => fallback));
  const [index, stores, people, kits, contacts, planDoc, saved] = await Promise.all([api('/api/manual').catch(() => []),
    get('/api/db/stores', []), get('/api/db/people', []), get('/api/db/kits', []), get('/api/db/contacts', []), get('/api/plan', null), get('/api/checkin', null)]);
  const sysBody = h('div.pb'), linkBody = h('div.pb'), posBody = h('div.pb'), readyBody = h('div.pb'), accessBody = h('div.pb');
  const sitBody = h('div.pb'), powerBody = h('div.pb'), sysSummary = h('span.dim');
  const planCheck = planDoc ? completeness(planDoc, people, contacts) : null;
  const planBody = h('div.pb', planCheck ? planRows(planCheck) : h('div.empty', 'NO PLAN'));
  const kitInfo = kitStatus(kits);
  const banner = h('div'), powerBanner = h('div');
  let accessKey = '';

  function paintPower(s) {
    const p = s.power ? { ...s.power, lowPower: !!state.settings?.power?.lowPower } : null;
    fill(powerBody, powerRows(p, guest));
    const text = batteryBanner(p);
    if (!text) { powerBanner.replaceChildren(); return; }
    fill(powerBanner, h('div.banner.power-banner', h('b', 'ON BATTERY'), text,
      p.lowPower || guest ? null : h('button.btn.sm', { type: 'button', style: 'margin-left:10px', onclick: () => switchLowPower(true) }, 'LOW-POWER MODE')));
  }

  function paint() {
    const s = state.status;
    if (!s) { sysBody.replaceChildren(h('div.empty', 'NO TELEMETRY')); return; }
    fill(sysBody, systemRows(s.system));
    fill(linkBody, linkRows(s));
    sysSummary.textContent = `CPU ${Math.round(s.system.cpu * 100)}% · MEM ${bytes(s.system.memTotal - s.system.memFree)} · ${uplinkText(s.net)}`;
    paintPower(s);
    if (!guest) {
      const now = new Date();
      fill(posBody, positionRows(home(), now));
      const household = people.length ? people : state.settings?.people;
      const ready = readiness(stores, household, { warnDays: state.settings?.expiryWarnDays || 90 });
      fill(readyBody, readinessRows(ready, kitInfo.due, people.length > 0));
      fill(sitBody, situationRows(ready, kitInfo, attention({ planCheck, kits, ready }), home(), now));
    }
    // The access panel holds forms, so it is redrawn only when access itself changes.
    const a = access();
    const key = `${a.role}|${a.lanWrites}|${a.pinSet}|${s.server.lanMode}`;
    if (key === accessKey) return;
    accessKey = key;
    fill(accessBody, accessRows(a, s.server.lanMode));
    fill(banner, a.role === 'host' && s.server.lanMode && a.lanWrites === 'open'
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

  // Guests see no household data: no situation, check-in, position, readiness or configuration.
  const panels = guest
    ? [
      panel('POWER', 'PWR-11', powerBody, 's4'),
      panel('ACCESS', 'ACC-07', accessBody, 's4'),
      panel('FIELD BRIEF', 'MAN-04', brief, 's4'),
    ]
    : [
      panel('SITUATION', 'SIT-00', sitBody, 's8'),
      panel('CHECK-IN', 'HSE-10', checkinPanel(people, saved), 's4'),
      panel('POWER', 'PWR-11', powerBody, 's4'),
      panel('POSITION', 'POS-03', posBody, 's4'),
      panel('PLAN', 'PLN-08', planBody, 's4'),
      panel('FIELD BRIEF', 'MAN-04', brief, 's7'),
      panel('READINESS', 'SUP-05', readyBody, 's5'),
      isHost() ? panel('DATA', 'BAK-09', dataPanel(), 's8') : null,
      panel('ACCESS', 'ACC-07', accessBody, 's4'),
      panel('CONFIGURATION', 'CFG-06', [configForm(), modelTools()], 's12'),
    ].filter(Boolean);

  root.append(
    viewHeader(code, 'COMMAND', guest ? 'Node status at a glance.' : 'The situation at a glance: supplies, household, power and plan.'),
    powerBanner,
    banner,
    h('div.grid', panels),
    systemFold(guest, sysSummary, panel('SYSTEM', 'SYS-01', sysBody, 's6'), panel('LINKS', 'NET-02', linkBody, 's6')));

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
