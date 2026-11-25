// Power awareness: battery and UPS status from the operating system, plus an optional NUT server.
// The parsers are pure functions; PowerMonitor reads the host on a timer and caches the result.
// Linux: /sys/class/power_supply. macOS: pmset. Windows: Win32_Battery through PowerShell.
// NUT (Network UPS Tools): SHELTER_NUT=ups[@host[:port]], read over its plain-text protocol.
// Disable all of it with SHELTER_POWER_CHECK=off.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';

/** How often the host is read, normally and in low-power mode. */
export const POWER_EVERY = { normal: 30_000, low: 180_000 };
const HISTORY = 40;
const SYSFS = '/sys/class/power_supply';
// Win32_Battery reports this run time when the machine is on mains or cannot estimate.
const WIN_UNKNOWN_RUNTIME = 71_582_788;

const finite = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(+v) ? +v : null;
};
const pct = (v) => {
  const n = finite(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
};

/**
 * The result shape every source produces. units: each battery or UPS found, with kind 'battery'
 * or 'ups', percent, state ('charging' | 'discharging' | 'full' | 'idle' | 'unknown') and runtimeMin.
 * mains: true or false when the source knows whether external power is present, else null.
 */
export function summarise(source, units, mains = null) {
  const onBattery = mains === null ? units.some((u) => u.state === 'discharging') : !mains;
  // The unit to report first: one on battery with the least time left, else the first found.
  const draining = units.filter((u) => u.state === 'discharging')
    .sort((a, b) => (a.runtimeMin ?? Infinity) - (b.runtimeMin ?? Infinity));
  const primary = draining[0] || units[0] || null;
  return {
    source, present: units.length > 0, onBattery: units.length > 0 && onBattery,
    charging: units.some((u) => u.state === 'charging'),
    percent: primary?.percent ?? null, runtimeMin: primary?.runtimeMin ?? null,
    primary: primary?.name ?? null, units,
  };
}

/** KEY=value lines of a power_supply uevent file, keys lower-cased without the POWER_SUPPLY_ prefix. */
export function parseUevent(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().replace(/^POWER_SUPPLY_/, '').toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const LINUX_STATE = { charging: 'charging', discharging: 'discharging', full: 'full', 'not charging': 'idle' };

/** Minutes left on a Linux battery: time_to_empty, energy/power (µWh/µW) or charge/current (µAh/µA). */
function linuxRuntime(s, state) {
  if (state !== 'discharging') return null;
  const tte = finite(s.time_to_empty_now);
  if (tte) return tte / 60;
  const energy = finite(s.energy_now), power = finite(s.power_now);
  if (energy !== null && power) return (energy / Math.abs(power)) * 60;
  const charge = finite(s.charge_now), current = finite(s.current_now);
  if (charge !== null && current) return (charge / Math.abs(current)) * 60;
  return null;
}

/** supplies: [{ name, ...parseUevent() }]. Device-scope batteries (mice, headsets) are left out. */
export function fromLinux(supplies) {
  const units = [];
  const adapters = [];
  for (const s of supplies) {
    const type = String(s.type || '').toLowerCase();
    if (type === 'mains' || type.startsWith('usb')) { adapters.push(s.online === '1'); continue; }
    if ((type !== 'battery' && type !== 'ups') || String(s.scope || '').toLowerCase() === 'device') continue;
    if (s.present === '0') continue;
    const state = LINUX_STATE[String(s.status || '').toLowerCase()] || 'unknown';
    let percent = pct(s.capacity);
    if (percent === null && finite(s.energy_full)) percent = pct((finite(s.energy_now) / finite(s.energy_full)) * 100);
    units.push({ name: s.model_name || s.name, kind: type === 'ups' ? 'ups' : 'battery', percent, state, runtimeMin: linuxRuntime(s, state) });
  }
  return summarise('linux', units, adapters.length ? adapters.some(Boolean) : null);
}

const PMSET_STATE = { charging: 'charging', discharging: 'discharging', charged: 'full', 'finishing charge': 'charging', 'ac attached': 'idle' };

/** Output of `pmset -g batt`. */
export function parsePmset(text) {
  const lines = String(text).split('\n');
  const head = lines[0] || '';
  let mains = null;
  if (head.includes("'AC Power'")) mains = true;
  else if (head.includes("'Battery Power'") || head.includes("'UPS Power'")) mains = false;
  const units = [];
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t.startsWith('-')) continue;
    const idAt = t.indexOf(' (id=');
    const close = t.indexOf(')', idAt);
    if (idAt < 0 || close < 0) continue;
    const name = t.slice(1, idAt).trim();
    const [p = '', s = '', rest = ''] = t.slice(close + 1).split(';').map((x) => x.trim());
    const time = /(\d{1,3}):(\d{2}) remaining/.exec(rest);
    const state = PMSET_STATE[s.toLowerCase()] || 'unknown';
    const runtimeMin = time && state === 'discharging' ? +time[1] * 60 + +time[2] : null;
    units.push({ name, kind: /ups/i.test(name) ? 'ups' : 'battery', percent: pct(Number.parseInt(p, 10)), state, runtimeMin: runtimeMin || null });
  }
  return summarise('macos', units, mains);
}

/** Win32_Battery BatteryStatus codes. */
function windowsState(code) {
  if ([6, 7, 8, 9].includes(code)) return 'charging';
  if ([1, 4, 5, 11].includes(code)) return 'discharging';
  if (code === 3) return 'full';
  if (code === 2) return 'idle';
  return 'unknown';
}

/** Win32_Battery records as parsed from ConvertTo-Json: one object, a list, or nothing. */
export function fromWindows(json) {
  let list = [];
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object') list = [json];
  const units = list.map((b, i) => {
    const state = windowsState(finite(b.BatteryStatus));
    const rt = finite(b.EstimatedRunTime);
    return {
      name: b.Name || `Battery ${i + 1}`, kind: /ups/i.test(b.Name || '') ? 'ups' : 'battery',
      percent: pct(b.EstimatedChargeRemaining), state,
      runtimeMin: state === 'discharging' && rt && rt !== WIN_UNKNOWN_RUNTIME ? rt : null,
    };
  });
  const mains = units.length ? !units.some((u) => u.state === 'discharging') : null;
  return summarise('windows', units, mains);
}

/** `LIST VAR` reply from a NUT server: { 'battery.charge': '100', ... }. */
export function parseNut(text, ups) {
  const vars = {};
  const prefix = `VAR ${ups} `;
  for (const line of String(text).split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    const sp = rest.indexOf(' ');
    if (sp <= 0) continue;
    let value = rest.slice(sp + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replaceAll(String.raw`\"`, '"');
    vars[rest.slice(0, sp)] = value;
  }
  return vars;
}

/** One NUT UPS as a unit. ups.status holds flags such as OL (online), OB (on battery), LB (low), CHRG. */
export function fromNut(vars, ups) {
  const flags = new Set(String(vars['ups.status'] || '').split(/\s+/).filter(Boolean));
  let state = 'unknown';
  if (flags.has('OB')) state = 'discharging';
  else if (flags.has('CHRG')) state = 'charging';
  else if (flags.has('OL')) state = 'full';
  const runtime = finite(vars['battery.runtime']);
  const name = [vars['device.mfr'] || vars['ups.mfr'], vars['device.model'] || vars['ups.model']].filter(Boolean).join(' ') || ups;
  return { name, kind: 'ups', percent: pct(vars['battery.charge']), state, runtimeMin: runtime === null ? null : runtime / 60, low: flags.has('LB'), load: finite(vars['ups.load']) };
}

/** "ups@host:port" as { ups, host, port }. */
export function nutTarget(spec) {
  const [ups, where = '127.0.0.1'] = String(spec).split('@');
  const [host, port] = where.split(':');
  return { ups: ups.trim(), host: host || '127.0.0.1', port: +port || 3493 };
}

/**
 * Minutes left from a battery's falling charge: samples [{ t (ms), percent }], newest last.
 * Uses the latest unbroken fall of at least 2 points over at least 5 minutes; null otherwise.
 */
export function estimateRuntime(samples) {
  const run = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.percent === null || s.percent === undefined) break;
    if (run.length && s.percent < run[0].percent) break; // charge rose going back: the fall started later
    run.unshift(s);
  }
  if (run.length < 2) return null;
  const first = run[0], last = run.at(-1);
  const drop = first.percent - last.percent, minutes = (last.t - first.t) / 60_000;
  if (drop < 2 || minutes < 5) return null;
  return last.percent / (drop / minutes);
}

// ---------- readers (they touch the host) ----------

function readLinux(root = SYSFS) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return summarise('linux', []); }
  const supplies = [];
  for (const name of names) {
    try { supplies.push({ name, ...parseUevent(fs.readFileSync(path.join(root, name, 'uevent'), 'utf8')) }); } catch { /* unreadable supply */ }
  }
  return fromLinux(supplies);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(String(stdout));
    });
  });
}

const WIN_QUERY = 'Get-CimInstance -ClassName Win32_Battery | Select-Object Name,EstimatedChargeRemaining,EstimatedRunTime,BatteryStatus | ConvertTo-Json -Compress';

async function readWindows() {
  // PowerShell ships with Windows and is found through PATH on purpose.
  const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY])).trim();
  return fromWindows(out ? JSON.parse(out) : null);
}

async function readMac() {
  // pmset ships with macOS and is found through PATH on purpose.
  return parsePmset(await run('pmset', ['-g', 'batt']));
}

/** Reads every variable of one UPS from a NUT server. */
export function readNut({ ups, host, port }, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout });
    let buf = '';
    const end = `END LIST VAR ${ups}`;
    const finish = (error) => {
      sock.destroy();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(fromNut(parseNut(buf, ups), ups));
    };
    sock.once('connect', () => sock.write(`LIST VAR ${ups}\n`));
    sock.on('data', (d) => {
      buf += d;
      if (buf.startsWith('ERR')) finish(new Error(`NUT: ${buf.trim()}`));
      else if (buf.includes(end) || buf.length > 256 * 1024) finish();
    });
    sock.once('timeout', () => finish(new Error('NUT server timed out')));
    sock.once('error', (e) => finish(e));
  });
}

/** The operating system's own battery reader for platform, or null when there is none. */
function osReader(platform) {
  if (platform === 'linux') return () => Promise.resolve(readLinux());
  if (platform === 'darwin') return readMac;
  if (platform === 'win32') return readWindows;
  return null;
}

/** Reads power status on a timer and keeps the latest result. */
export class PowerMonitor {
  /** reader/nutReader: injectable for tests. */
  constructor({ enabled = true, platform = process.platform, nut = '', reader, nutReader } = {}) {
    this.enabled = enabled;
    this.reader = reader ?? osReader(platform);
    this.nut = nut ? nutTarget(nut) : null;
    this.nutReader = nutReader ?? readNut;
    this.history = [];
    this.timer = null;
    this.every = POWER_EVERY.normal;
    this.last = { ...summarise('none', []), checkedAt: null, enabled, error: null };
  }

  /** Starts polling, or changes its rate. low: low-power mode. */
  start(low = false) {
    if (!this.enabled) return;
    const every = low ? POWER_EVERY.low : POWER_EVERY.normal;
    if (this.timer && every === this.every) return;
    clearInterval(this.timer);
    this.every = every;
    if (!this.last.checkedAt) this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), every);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async refresh() {
    const errors = [];
    const units = [];
    let source = 'none', mains = null;
    if (this.reader) {
      try {
        const os = await this.reader();
        units.push(...os.units);
        source = os.source;
        if (os.present) mains = !os.onBattery;
      } catch (error) { errors.push(error.message); }
    }
    if (this.nut) {
      try {
        const u = await this.nutReader(this.nut);
        units.push(u);
        source = source === 'none' ? 'nut' : `${source}+nut`;
        mains = u.state !== 'discharging' && mains !== false;
      } catch (error) { errors.push(error.message); }
    }
    const result = summarise(source, units, units.length ? mains : null);
    this.#track(result);
    this.last = { ...result, checkedAt: new Date().toISOString(), enabled: true, error: errors.join('; ') || null };
    return this.last;
  }

  #track(result) {
    if (!result.onBattery) { this.history = []; return; }
    this.history.push({ t: Date.now(), percent: result.percent });
    if (this.history.length > HISTORY) this.history.shift();
    if (result.runtimeMin === null) {
      const est = estimateRuntime(this.history);
      if (est !== null) { result.runtimeMin = est; result.estimated = true; }
    }
  }

  status() { return this.last; }
}
