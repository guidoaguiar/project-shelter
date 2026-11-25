// Power helpers: status polling rate, battery wording and the power budget. Pure functions, no DOM.

/** How often the interface asks the node for its status, normally and in low-power mode (ms). */
export const STATUS_EVERY = { normal: 5000, low: 60_000 };
export const statusInterval = (settings) => (settings?.power?.lowPower ? STATUS_EVERY.low : STATUS_EVERY.normal);

/** "2H 05M", "45M", or "—" without a figure. */
export function runtimeText(min) {
  if (min === null || min === undefined || !Number.isFinite(min) || min < 0) return '—';
  const m = Math.round(min);
  if (m >= 48 * 60) return `${Math.floor(m / 1440)}D ${Math.floor((m % 1440) / 60)}H`;
  if (m >= 60) return `${Math.floor(m / 60)}H ${String(m % 60).padStart(2, '0')}M`;
  return `${m}M`;
}

const STATE_TEXT = { charging: 'CHARGING', discharging: 'ON BATTERY', full: 'FULL', idle: 'ON MAINS', unknown: 'UNKNOWN' };
export const stateText = (state) => STATE_TEXT[state] || 'UNKNOWN';

/**
 * How the power status reads on Command: { level: 'ok' | 'warn' | 'bad' | 'dim', text }.
 * Under 20% or 30 minutes on battery is 'bad'; any time on battery is 'warn'.
 */
export function powerLevel(p) {
  if (!p?.enabled) return { level: 'dim', text: 'CHECK DISABLED' };
  if (!p.checkedAt) return { level: 'dim', text: 'CHECKING' };
  if (!p.present) return { level: 'dim', text: 'NO BATTERY OR UPS FOUND' };
  if (!p.onBattery) return { level: 'ok', text: p.charging ? 'ON MAINS · CHARGING' : 'ON MAINS' };
  const low = (p.percent !== null && p.percent < 20) || (p.runtimeMin !== null && p.runtimeMin < 30);
  return { level: low ? 'bad' : 'warn', text: 'ON BATTERY' };
}

/** The battery banner text, or null when the node is not on battery. */
export function batteryBanner(p) {
  if (!p?.onBattery) return null;
  const parts = [];
  if (p.percent !== null) parts.push(`${Math.round(p.percent)}%`);
  if (p.runtimeMin !== null) parts.push(`about ${runtimeText(p.runtimeMin)} left${p.estimated ? ' (estimated)' : ''}`);
  const advice = p.lowPower ? 'Low-power mode is on.' : 'Turn on low-power mode to make it last longer.';
  return `This node is running on battery${parts.length ? ': ' + parts.join(', ') : ''}. ${advice}`;
}

/** Common loads, for a quick start in the power budget. Watts are typical, not exact. */
export const DEVICE_PRESETS = [
  { name: 'Phone charging', watts: 10, hours: 2 },
  { name: 'LED light', watts: 5, hours: 5 },
  { name: 'Laptop', watts: 45, hours: 3 },
  { name: 'Raspberry Pi node', watts: 6, hours: 24 },
  { name: 'Wi-Fi router', watts: 10, hours: 24 },
  { name: 'Radio receiver', watts: 3, hours: 4 },
  { name: 'Fridge (average)', watts: 60, hours: 24 },
  { name: 'Chest freezer (average)', watts: 40, hours: 24 },
  { name: 'CPAP machine', watts: 40, hours: 8 },
  { name: 'Fan', watts: 30, hours: 6 },
];

const n = (v, fallback = 0) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : fallback);

/**
 * The daily energy balance. devices: [{ name, watts, hours, qty }]. batteryWh: rated capacity;
 * usablePct: the share that may be used (about 80 for lithium, 50 for lead-acid); efficiency:
 * inverter and wiring efficiency in %; solarW: panel rating; sunHours: peak sun hours a day.
 * Solar output is derated by 25% for heat, dust and angle.
 */
export function powerBudget({ devices = [], batteryWh = 0, usablePct = 80, efficiency = 90, solarW = 0, sunHours = 4 } = {}) {
  const rows = devices.map((d) => ({ ...d, wh: n(d.watts) * n(d.hours) * Math.max(1, n(d.qty, 1)) }));
  const loadWh = rows.reduce((s, d) => s + d.wh, 0);
  const eff = Math.min(1, Math.max(0.5, n(efficiency, 90) / 100));
  const drawWh = loadWh / eff;
  const usableWh = n(batteryWh) * Math.min(1, Math.max(0.1, n(usablePct, 80) / 100));
  const solarWh = n(solarW) * n(sunHours, 4) * 0.75;
  const netWh = solarWh - drawWh;
  const averageW = drawWh / 24;
  // Days the battery lasts with this solar input; null when the input covers the draw.
  const autonomyDays = netWh < 0 ? usableWh / -netWh : null;
  return {
    devices: rows.map((d) => ({ ...d, share: loadWh ? d.wh / loadWh : 0 })),
    loadWh, drawWh, usableWh, solarWh, netWh, averageW,
    // With no sun at all: hours at the average draw.
    darkHours: averageW > 0 ? usableWh / averageW : null,
    autonomyDays,
    sustainable: drawWh > 0 && netWh >= 0,
    // Panel watts needed to cover the daily draw.
    solarNeededW: n(sunHours, 4) > 0 ? drawWh / (n(sunHours, 4) * 0.75) : null,
  };
}

/** Battery watt-hours from amp-hours and volts. */
export const ampHoursToWh = (ah, volts) => n(ah) * n(volts);
