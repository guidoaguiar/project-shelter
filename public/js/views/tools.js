// 05 TOOLS — field calculators that work with no link.
import { h, api, home, viewHeader, panel, kv, field, hhmm, toast, state, saveSettings, isGuest } from '../lib/core.js';
import { powerBudget, DEVICE_PRESETS, ampHoursToWh, runtimeText } from '../lib/power.js';
import { parseCoord, toDMS, toMGRS, formatUTM, rangeBearing, compassPoint, sunTimes, moonPhase } from '../lib/geo.js';

let active = 'coord';
const num = (el) => { const v = Number.parseFloat(el.value); return Number.isFinite(v) ? v : null; };
const live = (els, fn) => {
  for (const el of els) el.addEventListener('input', fn);
  fn();
};
const norm = (d) => ((d % 360) + 360) % 360;
const hoursMinutes = (x) => `${Math.floor(x)}H ${String(Math.round((x % 1) * 60)).padStart(2, '0')}M`;
/** Morse words: split at "/" or "|" (spaces around them ignored), or at a gap of two or more spaces. */
const morseWords = (code) => code.split(/[/|]/).flatMap((part) => part.trim().split(/\s{2,}/));

// ---------- coordinates ----------
function coord() {
  const p = home();
  const from = h('input', { placeholder: '38.8977, -77.0365  or  38°53\'51"N 77°02\'11"W', value: p ? `${p.lat}, ${p.lon}` : '' });
  const to = h('input', { placeholder: 'OPTIONAL SECOND POINT FOR RANGE AND BEARING' });
  const out = h('div');
  live([from, to], () => {
    const a = parseCoord(from.value), b = parseCoord(to.value);
    if (!a) { out.replaceChildren(h('div.empty', from.value.trim() ? 'COORDINATE NOT RECOGNISED' : 'ENTER A COORDINATE')); return; }
    const rows = [
      kv('DECIMAL', `${a.lat.toFixed(6)}, ${a.lon.toFixed(6)}`), kv('DMS', toDMS(a.lat, a.lon)),
      kv('UTM', formatUTM(a.lat, a.lon)), kv('MGRS 1 M', toMGRS(a.lat, a.lon, 5) || 'outside MGRS limits'),
      kv('MGRS 100 M', toMGRS(a.lat, a.lon, 3) || '—'),
    ];
    if (b) {
      const r = rangeBearing(a, b);
      rows.push(kv('RANGE', `${r.km.toFixed(r.km < 100 ? 2 : 0)} KM / ${(r.km * 0.621371).toFixed(r.km < 100 ? 2 : 0)} MI`),
        kv('BEARING (TRUE)', `${r.bearing.toFixed(1)}° ${compassPoint(r.bearing)}`),
        kv('BACK BEARING', `${((r.bearing + 180) % 360).toFixed(1)}°`));
    }
    out.replaceChildren(...rows);
  });
  return h('div.grid',
    panel('INPUT', 'CRD-IN', h('div.pb', field('POSITION', from), field('TARGET', to),
      h('p.hint', 'Accepts decimal degrees, degrees and decimal minutes, or degrees-minutes-seconds with N/S/E/W.')), 's6'),
    panel('CONVERSION', 'CRD-OUT', h('div.pb', out), 's6'));
}

// ---------- sun and moon ----------
function sun() {
  const p = home();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const pos = h('input', { placeholder: 'LAT, LON', value: p ? `${p.lat}, ${p.lon}` : '' });
  const date = h('input', { type: 'date', value: iso });
  const out = h('div');
  live([pos, date], () => {
    const c = parseCoord(pos.value);
    const [y, m, d] = (date.value || iso).split('-').map(Number);
    const moon = moonPhase(new Date(y, m - 1, d, 12));
    const moonRows = [kv('MOON PHASE', moon.name), kv('ILLUMINATION', `${Math.round(moon.illumination * 100)}%`), kv('MOON AGE', `${moon.age.toFixed(1)} DAYS`)];
    if (!c) { out.replaceChildren(h('div.empty', 'ENTER A POSITION FOR SUN TIMES'), ...moonRows); return; }
    const s = sunTimes(y, m, d, c.lat, c.lon);
    const hrs = Math.floor(s.dayHours), mins = Math.round((s.dayHours - hrs) * 60);
    const z = (t) => (t ? `${hhmm(t)}  (${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}Z)` : '—');
    out.replaceChildren(
      kv('SUNRISE', s.polar ? `POLAR ${s.polar.toUpperCase()}` : z(s.rise)), kv('SOLAR NOON', z(s.noon)), kv('SUNSET', z(s.set)),
      kv('DAYLIGHT', `${hrs}H ${String(mins).padStart(2, '0')}M`), ...moonRows);
  });
  return h('div.grid',
    panel('INPUT', 'SOL-IN', h('div.pb', field('POSITION', pos), field('DATE', date),
      h('p.hint', 'Times are shown in this device\'s time zone, with UTC in brackets. Accuracy is within a few minutes at mid latitudes.')), 's5'),
    panel('SUN AND MOON', 'SOL-OUT', h('div.pb', out), 's7'));
}

// ---------- morse ----------
const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '-': '-....-', '=': '-...-', '@': '.--.-.' };
const UNMORSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
let audio = null;
const stopAudio = () => {
  if (audio) { audio.close(); audio = null; }
};

function morse() {
  const text = h('textarea', { rows: 3, placeholder: 'TYPE TEXT, OR DOTS AND DASHES TO DECODE' }, 'SOS');
  const out = h('div.out');
  const wpm = h('input', { type: 'number', min: 5, max: 30, value: 12 });
  const playBtn = h('button.btn.primary', 'PLAY');
  let code = '';
  live([text], () => {
    const v = text.value.trim();
    if (/^[.\-_/|\s]+$/.test(v) && /[.\-_]/.test(v)) {
      code = v.replaceAll('_', '-');
      out.textContent = morseWords(code).map((w) => w.trim().split(/\s+/).map((c) => UNMORSE[c] || '?').join('')).join(' ');
    } else {
      code = v.toUpperCase().split(/\s+/).map((w) => [...w].map((c) => MORSE[c] || '').filter(Boolean).join(' ')).filter(Boolean).join(' / ');
      out.textContent = code;
    }
  });
  const stop = () => { stopAudio(); playBtn.textContent = 'PLAY'; };
  playBtn.addEventListener('click', () => {
    if (audio) return stop();
    if (!code) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return toast('AUDIO NOT SUPPORTED', true);
    audio = new Ctx();
    const unit = 1.2 / Math.max(5, Math.min(30, num(wpm) || 12));
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.frequency.value = 620; gain.gain.value = 0; osc.connect(gain).connect(audio.destination);
    let t = audio.currentTime + 0.1;
    for (const ch of code) {
      if (ch === '.' || ch === '-') {
        const len = ch === '.' ? unit : unit * 3;
        gain.gain.setValueAtTime(0.25, t); gain.gain.setValueAtTime(0, t + len); t += len + unit;
      } else if (ch === ' ') t += unit * 2; // letter gap: 3 units total
      else if (ch === '/') t += unit * 2;   // word gap: 7 units total with surrounding spaces
    }
    osc.start(); osc.stop(t);
    osc.onended = stop;
    playBtn.textContent = 'STOP';
  });
  return h('div.grid',
    panel('MESSAGE', 'MRS-IN', h('div.pb', field('TEXT OR CODE', text),
      h('div.row', h('div', { style: 'width:110px' }, field('SPEED (WPM)', wpm)), playBtn)), 's6'),
    panel('TRANSLATION', 'MRS-OUT', h('div.pb', out,
      h('p.hint', { style: 'margin-top:10px' }, 'By light or whistle: a dash lasts three dots. Pause one dot between symbols, three between letters, seven between words.')), 's6'));
}

// ---------- water ----------
function water() {
  const vol = h('input', { type: 'number', min: 0, step: 'any', value: 10 });
  const unit = h('select', h('option', { value: 'L' }, 'LITRES'), h('option', { value: 'gal' }, 'US GALLONS'));
  const strength = h('select', h('option', { value: '8' }, '5–6% BLEACH'), h('option', { value: '6' }, '8.25% BLEACH'));
  const clarity = h('select', h('option', { value: '1' }, 'CLEAR'), h('option', { value: '2' }, 'CLOUDY, COLOURED OR VERY COLD'));
  const out = h('div');
  const people = h('input', { type: 'number', min: 1, value: 2 }), days = h('input', { type: 'number', min: 1, value: 14 });
  const need = h('div');
  live([vol, unit, strength, clarity], () => {
    const v = num(vol);
    if (!v || v <= 0) { out.replaceChildren(h('div.empty', 'ENTER A VOLUME')); return; }
    const gal = unit.value === 'gal' ? v : v / 3.785;
    const drops = Math.max(1, Math.round(gal * +strength.value)) * +clarity.value;
    const ml = drops * 0.05;
    out.replaceChildren(
      h('div.big', drops, h('small', 'DROPS')),
      h('div', { style: 'margin-top:10px' },
        kv('APPROX. VOLUME', ml >= 5 ? `${ml.toFixed(1)} ML (${(ml / 4.93).toFixed(1)} TSP)` : `${ml.toFixed(2)} ML`),
        kv('CONTACT TIME', '30 MINUTES'), kv('CHECK', 'FAINT CHLORINE SMELL')),
      h('p.hint', 'Plain unscented bleach only. If there is no chlorine smell after 30 minutes, repeat the dose and wait 15 more. Boiling for 1 minute (3 minutes above 2000 m) is more reliable when fuel allows.'));
  });
  live([people, days], () => {
    const p = num(people) || 0, d = num(days) || 0;
    need.replaceChildren(kv('DRINKING AND COOKING', `${(p * d * 4).toFixed(0)} L / ${(p * d * 4 / 3.785).toFixed(0)} GAL`),
      kv('BARE MINIMUM (SHORT TERM)', `${(p * d * 2).toFixed(0)} L`));
  });
  return h('div.grid',
    panel('DISINFECTION DOSE', 'H2O-01', h('div.pb', h('div.fr', field('VOLUME', vol), field('UNIT', unit)), h('div.fr', field('BLEACH', strength), field('WATER', clarity)), out), 's7'),
    panel('STORAGE REQUIREMENT', 'H2O-02', h('div.pb', h('div.fr', field('PEOPLE', people), field('DAYS', days)), need,
      h('p.hint', 'Planning figure: 4 L per person per day. Heat, illness and hard work raise the need.')), 's5'));
}

// ---------- pace and bearing ----------
function pace() {
  const per = h('input', { type: 'number', min: 1, value: 65 }), count = h('input', { type: 'number', min: 0, value: 0 });
  const dist = h('div');
  const brg = h('input', { type: 'number', min: 0, max: 360, step: 'any', value: 0 });
  const decl = h('input', { type: 'number', step: 'any', value: 0 });
  const brgOut = h('div');
  const km = h('input', { type: 'number', min: 0, step: 'any', value: 10 }), climb = h('input', { type: 'number', min: 0, value: 300 });
  const time = h('div');
  live([per, count], () => {
    const m = ((num(count) || 0) / (num(per) || 65)) * 100;
    dist.replaceChildren(kv('DISTANCE', `${m.toFixed(0)} M / ${(m / 1000).toFixed(2)} KM`));
  });
  live([brg, decl], () => {
    const b = num(brg) || 0, d = num(decl) || 0;
    brgOut.replaceChildren(kv('BACK BEARING', `${norm(b + 180).toFixed(1)}°`),
      kv('MAP (TRUE) → COMPASS', `${norm(b - d).toFixed(1)}° MAG`), kv('COMPASS → MAP (TRUE)', `${norm(b + d).toFixed(1)}° TRUE`));
  });
  live([km, climb], () => {
    const hours = (num(km) || 0) / 5 + (num(climb) || 0) / 600;
    time.replaceChildren(kv('NAISMITH ESTIMATE', hoursMinutes(hours)), kv('LOADED OR ROUGH GROUND', `${hoursMinutes(hours * 1.25)} – ${hoursMinutes(hours * 1.5)}`));
  });
  return h('div.grid',
    panel('PACE COUNT', 'NAV-01', h('div.pb', h('div.fr', field('PACES PER 100 M', per), field('PACES COUNTED', count)), dist,
      h('p.hint', 'Count each time your left foot lands. Measure your own figure over a known 100 m.')), 's4'),
    panel('BEARINGS', 'NAV-02', h('div.pb', h('div.fr', field('BEARING °', brg), field('DECLINATION ° (EAST +)', decl)), brgOut), 's4'),
    panel('TRAVEL TIME', 'NAV-03', h('div.pb', h('div.fr', field('DISTANCE KM', km), field('CLIMB M', climb)), time,
      h('p.hint', '1 hour per 5 km plus 1 hour per 600 m of ascent.')), 's4'));
}

// ---------- codec ----------
const utf8 = new TextEncoder(), strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/** Shifts letters n places through the alphabet, keeping case. */
const rot = (s, n) => s.replaceAll(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCodePoint(((c.codePointAt(0) - base + n + 26) % 26) + base);
});
function hexDecode(s) {
  const hex = s.replaceAll(/[^0-9a-f]/gi, '');
  if (hex.length % 2) throw new Error('odd length');
  return strictUtf8.decode(Uint8Array.from(hex.match(/../g) || [], (x) => Number.parseInt(x, 16)));
}
// Local operations: (text, caesar shift) -> result. Hashes are computed by the node.
const CODEC = {
  b64e: (s) => btoa(Array.from(utf8.encode(s), (b) => String.fromCodePoint(b)).join('')),
  b64d: (s) => strictUtf8.decode(Uint8Array.from(atob(s.replaceAll(/\s+/g, '')), (c) => c.codePointAt(0))),
  hexe: (s) => Array.from(utf8.encode(s), (b) => b.toString(16).padStart(2, '0')).join(' '),
  hexd: hexDecode,
  rot13: (s) => rot(s, 13),
  caesar: (s, shift) => rot(s, ((Math.round(shift) % 26) + 26) % 26),
};

function codec() {
  const input = h('textarea', { rows: 5, placeholder: 'INPUT' });
  const op = h('select', ...[['b64e', 'BASE64 ENCODE'], ['b64d', 'BASE64 DECODE'], ['hexe', 'HEX ENCODE'], ['hexd', 'HEX DECODE'],
    ['rot13', 'ROT13'], ['caesar', 'CAESAR SHIFT'], ['sha256', 'SHA-256'], ['sha1', 'SHA-1'], ['md5', 'MD5']].map(([v, l]) => h('option', { value: v }, l)));
  const shift = h('input', { type: 'number', value: 3, min: -25, max: 25 });
  const out = h('div.out');
  const compute = async (s) => {
    const local = CODEC[op.value];
    if (local) return local(s, num(shift) || 0);
    return s ? (await api('/api/hash', { method: 'POST', body: { text: s, algo: op.value } })).hash : '';
  };
  let seq = 0;
  async function run() {
    const s = input.value, mine = ++seq;
    let r;
    try { r = await compute(s); } catch { r = 'INPUT IS NOT VALID FOR THIS OPERATION'; }
    if (mine === seq) out.textContent = r;
  }
  for (const el of [input, op, shift]) el.addEventListener('input', run);
  return h('div.grid',
    panel('INPUT', 'COD-IN', h('div.pb', field('TEXT', input), h('div.fr', field('OPERATION', op), field('SHIFT (CAESAR)', shift))), 's6'),
    panel('OUTPUT', 'COD-OUT', h('div.pb', out,
      h('div.row', { style: 'margin-top:10px' }, h('button.btn', { onclick: () => navigator.clipboard?.writeText(out.textContent).then(() => toast('COPIED'), () => toast('COPY BLOCKED', true)) }, 'COPY'),
        h('span.hint', 'ROT13 and Caesar are obfuscation, not security.'))), 's6'));
}

// ---------- power budget ----------
const fixed = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const wh = (x) => (Math.abs(x) >= 10_000 ? `${fixed(x / 1000, 1)} KWH` : `${fixed(x)} WH`);

/** One device row in the budget table; edits change the device in place and recalculate. */
function deviceRow(d, onChange, onRemove) {
  const cell = (k, attrs) => {
    const el = h('input', { value: d[k] ?? '', 'aria-label': k, ...attrs });
    el.addEventListener('input', () => { d[k] = attrs.type === 'number' ? num(el) : el.value; onChange(); });
    return h('td', el);
  };
  return h('tr',
    cell('name', { maxlength: 40 }),
    cell('watts', { type: 'number', min: 0, step: 'any', style: 'width:80px' }),
    cell('hours', { type: 'number', min: 0, max: 24, step: 'any', style: 'width:70px' }),
    cell('qty', { type: 'number', min: 1, max: 999, style: 'width:60px' }),
    h('td', h('button.btn.sm.danger', { type: 'button', onclick: onRemove, 'aria-label': `Remove ${d.name}` }, 'DEL')));
}

function powerBudgetResults(b) {
  let withSolar = 'NO LOAD';
  if (b.drawWh > 0) withSolar = b.autonomyDays === null ? 'INDEFINITELY' : `${fixed(b.autonomyDays, 1)} DAYS`;
  return [
    h('div.stat-row',
      h('div.stat', h('div.lbl', 'DAILY USE'), h('div.big', fixed(b.drawWh), h('small', 'WH'))),
      h('div.stat', h('div.lbl', 'NET / DAY'), h('div.big' + (b.netWh < 0 ? '.warn' : '.ok'), (b.netWh > 0 ? '+' : '') + fixed(b.netWh), h('small', 'WH')))),
    h('div', { style: 'margin-top:12px' },
      kv('LOAD (AT THE DEVICES)', `${wh(b.loadWh)} · AVG ${fixed(b.averageW, 1)} W`),
      kv('USABLE BATTERY', wh(b.usableWh)),
      kv('SOLAR (DERATED)', `${wh(b.solarWh)} / DAY`),
      kv('NO SUN: BATTERY LASTS', b.darkHours === null ? '—' : runtimeText(b.darkHours * 60)),
      kv('WITH THIS SOLAR', withSolar, b.autonomyDays === null ? 'ok' : 'warn'),
      kv('PANEL TO COVER THE LOAD', b.solarNeededW === null ? '—' : `${fixed(b.solarNeededW)} W`)),
    b.devices.length ? h('div', { style: 'margin-top:12px' }, b.devices.filter((d) => d.wh > 0).sort((x, y) => y.wh - x.wh).map((d) =>
      h('div.meter', h('div.row', h('span', String(d.name || 'DEVICE').toUpperCase()), h('b', `${fixed(d.wh)} WH · ${Math.round(d.share * 100)}%`)),
        h('div.track', h('div.fill', { style: `width:${(d.share * 100).toFixed(1)}%` }))))) : null,
  ];
}

function power() {
  const saved = state.settings?.power || {};
  const devices = (saved.devices?.length ? saved.devices : DEVICE_PRESETS.slice(0, 3)).map((d) => ({ qty: 1, ...d }));
  const f = {
    battery: h('input', { type: 'number', min: 0, step: 'any', value: saved.batteryWh ?? 1000 }),
    usable: h('input', { type: 'number', min: 10, max: 100, value: saved.usablePct ?? 80 }),
    eff: h('input', { type: 'number', min: 50, max: 100, value: saved.efficiency ?? 90 }),
    solar: h('input', { type: 'number', min: 0, step: 'any', value: saved.solarW ?? 0 }),
    sunH: h('input', { type: 'number', min: 0, max: 24, step: 'any', value: saved.sunHours ?? 4 }),
  };
  const ah = h('input', { type: 'number', min: 0, step: 'any', placeholder: '100' }), volts = h('input', { type: 'number', min: 0, step: 'any', placeholder: '12' });
  const tbody = h('tbody'), out = h('div');
  const preset = h('select', { 'aria-label': 'Device' }, h('option', { value: '' }, 'CUSTOM DEVICE'), DEVICE_PRESETS.map((d, i) => h('option', { value: i }, `${d.name.toUpperCase()} · ${d.watts} W`)));
  const calc = () => out.replaceChildren(...powerBudgetResults(powerBudget({
    devices, batteryWh: num(f.battery), usablePct: num(f.usable), efficiency: num(f.eff), solarW: num(f.solar), sunHours: num(f.sunH),
  })));
  function table() {
    tbody.replaceChildren(...devices.map((d, i) => deviceRow(d, calc, () => { devices.splice(i, 1); table(); calc(); })));
  }
  const add = () => {
    const p = DEVICE_PRESETS[preset.value];
    devices.push(p ? { ...p, qty: 1 } : { name: 'Device', watts: 10, hours: 1, qty: 1 });
    table(); calc();
  };
  const fromAh = () => {
    const v = ampHoursToWh(num(ah), num(volts));
    if (v > 0) { f.battery.value = String(Math.round(v)); calc(); }
  };
  const save = async () => {
    const list = devices.map((d) => ({ name: String(d.name || '').trim() || 'Device', watts: d.watts || 0, hours: Math.min(24, d.hours || 0), qty: Math.max(1, Math.round(d.qty || 1)) }));
    try {
      await saveSettings({ power: { devices: list, batteryWh: num(f.battery), usablePct: num(f.usable) ?? 80, efficiency: num(f.eff) ?? 90, solarW: num(f.solar), sunHours: num(f.sunH) ?? 4 } });
      toast('POWER BUDGET SAVED');
    } catch (error) { toast(error.message, true); }
  };
  live(Object.values(f), calc);
  table();
  return h('div.grid',
    panel('LOADS', 'PWR-01', h('div.pb',
      h('div.scroll-x', h('table.t.power-table', h('thead', h('tr', ['DEVICE', 'WATTS', 'HOURS / DAY', 'QTY', ''].map((x) => h('th', x)))), tbody)),
      h('div.row', { style: 'margin-top:10px;flex-wrap:nowrap' }, preset, h('button.btn', { type: 'button', onclick: add }, 'ADD')),
      h('p.hint', 'Watts from the label or a plug-in meter. Fridges and freezers cycle: use the average draw, about a third of the rated figure.'),
      h('div.lbl', { style: 'margin:14px 0 6px' }, 'BATTERY AND SOLAR'),
      h('div.fr', field('BATTERY (WH)', f.battery), field('USABLE %', f.usable), field('EFFICIENCY %', f.eff)),
      h('div.fr', field('AMP-HOURS', ah), field('VOLTS', volts), h('label.f', h('span', ' '), h('button.btn', { type: 'button', onclick: fromAh }, 'USE AH × V'))),
      h('div.fr', field('SOLAR PANELS (W)', f.solar), field('PEAK SUN HOURS', f.sunH)),
      h('p.hint', 'Usable: about 80% for lithium, 50% for lead-acid. Efficiency covers the inverter and wiring; use 100 for DC loads. Peak sun hours: 1–2 in winter at high latitudes, 4–6 in summer.'),
      isGuest() ? h('p.hint', 'Enter the PIN on Command to save this budget.') : h('div.row', h('button.btn.primary', { type: 'button', onclick: save }, 'SAVE BUDGET'))), 's7'),
    panel('BALANCE', 'PWR-02', h('div.pb', out,
      h('p.hint', { style: 'margin-top:10px' }, 'Solar output is taken at 75% of the panel rating for heat, dust and angle. See the manual chapter on power and electricity.')), 's5'));
}

const TOOLS = [['coord', 'COORDINATES', coord], ['sun', 'SUN / MOON', sun], ['morse', 'MORSE', morse], ['water', 'WATER', water], ['pace', 'PACE / BEARING', pace], ['power', 'POWER BUDGET', power], ['codec', 'CODEC', codec]];

export function render(root, arg, { code } = {}) {
  if (TOOLS.some(([id]) => id === arg)) active = arg;
  const body = h('div');
  const tabs = h('div.tabs', { role: 'tablist' });
  function show() {
    stopAudio();
    tabs.replaceChildren(...TOOLS.map(([id, label]) => h('button', { role: 'tab', class: id === active ? 'active' : null, onclick: () => { active = id; show(); } }, label)));
    body.replaceChildren(TOOLS.find(([id]) => id === active)[2]());
  }
  root.append(viewHeader(code, 'TOOLS', 'Calculators for navigation, signalling, water and power. All computed on this device.'), tabs, body);
  show();
  return stopAudio;
}
