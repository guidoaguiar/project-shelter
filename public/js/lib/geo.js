// Geodesy and astronomy helpers. Pure functions, no DOM: usable from Node for testing.
const RAD = Math.PI / 180;
const A = 6_378_137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);

// Svalbard uses four wide zones instead of 31 to 37: [east limit, zone].
const SVALBARD = [[9, 31], [21, 33], [33, 35], [42, 37]];

/** UTM zone number, with the Norway and Svalbard exceptions. */
function utmZone(lat, lon) {
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32; // Norway
  if (lat >= 72 && lat < 84 && lon >= 0 && lon < 42) return SVALBARD.find(([east]) => lon < east)[1];
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}

/** WGS84 lat/lon to UTM. Valid for latitudes 80°S to 84°N. */
export function toUTM(lat, lon) {
  if (lat < -80 || lat > 84) return null;
  const zone = utmZone(lat, lon);
  const phi = lat * RAD, lam = lon * RAD, lam0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin), T = tan * tan, C = EP2 * cos * cos, a = cos * (lam - lam0);
  const M = A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));
  const easting = K0 * N * (a + (1 - T + C) * a ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * a ** 5 / 120) + 500_000;
  let northing = K0 * (M + N * tan * (a * a / 2 + (5 - T + 9 * C + 4 * C * C) * a ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * a ** 6 / 720));
  if (lat < 0) northing += 10_000_000;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.floor((lat + 80) / 8)];
  return { zone, band, easting, northing };
}

/** MGRS grid reference. digits = 1..5 per axis (5 = 1 m, 4 = 10 m ...). */
export function toMGRS(lat, lon, digits = 5) {
  const u = toUTM(lat, lon);
  if (!u) return null;
  const cols = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(u.zone - 1) % 3];
  const rows = 'ABCDEFGHJKLMNPQRSTUV';
  const col = cols[Math.floor(u.easting / 100_000) - 1];
  const row = rows[(Math.floor(u.northing / 100_000) + (u.zone % 2 === 0 ? 5 : 0)) % 20];
  const cut = (v) => String(Math.floor(v % 100_000)).padStart(5, '0').slice(0, digits);
  return `${String(u.zone).padStart(2, '0')}${u.band} ${col}${row} ${cut(u.easting)} ${cut(u.northing)}`;
}

export function formatUTM(lat, lon) {
  const u = toUTM(lat, lon);
  return u ? `${u.zone}${u.band} ${Math.round(u.easting)}E ${Math.round(u.northing)}N` : 'outside UTM limits';
}

/** One axis in degrees, minutes and seconds to 0.1", with its hemisphere letter. */
function dms(v, pos, neg) {
  const a = Math.abs(v);
  let d = Math.floor(a), m = Math.floor((a - d) * 60), s = (a - d - m / 60) * 3600;
  if (s >= 59.95) { s = 0; m++; }
  if (m >= 60) { m = 0; d++; }
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${v < 0 ? neg : pos}`;
}

export function toDMS(lat, lon) {
  return `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'W')}`;
}

/** Parses "38.8977, -77.0365", "38 53.862 N 77 2.19 W" or "38°53'51.7"N 77°02'11.4"W". */
export function parseCoord(text) {
  const s = String(text).toUpperCase();
  const nums = (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const hemi = s.match(/[NSEW]/g) || [];
  if (![2, 4, 6].includes(nums.length)) return null;
  const n = nums.length / 2;
  const dec = (part) => {
    const sign = part[0] < 0 || Object.is(part[0], -0) ? -1 : 1;
    return sign * (Math.abs(part[0]) + (part[1] || 0) / 60 + (part[2] || 0) / 3600);
  };
  let a = dec(nums.slice(0, n)), b = dec(nums.slice(n));
  if (hemi.length === 2) {
    if (hemi[0] === 'S' || hemi[0] === 'W') a = -Math.abs(a);
    if (hemi[1] === 'S' || hemi[1] === 'W') b = -Math.abs(b);
    if (hemi[0] === 'E' || hemi[0] === 'W') [a, b] = [b, a]; // lon given first
  }
  if (!(Math.abs(a) <= 90 && Math.abs(b) <= 180)) return null;
  return { lat: a, lon: b };
}

/** Great-circle distance (km) and initial bearing (degrees true). */
export function rangeBearing(p, q) {
  const f1 = p.lat * RAD, f2 = q.lat * RAD, dl = (q.lon - p.lon) * RAD;
  const hav = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  const km = 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(hav)));
  const brg = Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) / RAD;
  return { km, bearing: (brg + 360) % 360 };
}

export const compassPoint = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];

const jdToDate = (jd) => new Date((jd - 2_440_587.5) * 86_400_000);

/** Sunrise, sunset and solar noon for the calendar day (y, m 1-12, d) at a position. */
export function sunTimes(y, m, d, lat, lon) {
  const n = Math.round(Date.UTC(y, m - 1, d, 12) / 86_400_000 + 2_440_587.5 - 2_451_545.0);
  const j = n - lon / 360;
  const M = ((357.5291 + 0.98560028 * j) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2_451_545.0 + j + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const dec = Math.asin(Math.sin(L * RAD) * Math.sin(23.4397 * RAD));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) / (Math.cos(lat * RAD) * Math.cos(dec));
  const noon = jdToDate(transit);
  if (cosH > 1) return { noon, rise: null, set: null, polar: 'night', dayHours: 0 };
  if (cosH < -1) return { noon, rise: null, set: null, polar: 'day', dayHours: 24 };
  const H = Math.acos(cosH) / RAD;
  return { noon, rise: jdToDate(transit - H / 360), set: jdToDate(transit + H / 360), polar: null, dayHours: (2 * H) / 15 };
}

/** Moon phase from the mean synodic month. Accurate to about a day. */
export function moonPhase(date = new Date()) {
  const SYN = 29.530588853;
  const jd = date.getTime() / 86_400_000 + 2_440_587.5;
  const age = (((jd - 2_451_550.26) % SYN) + SYN) % SYN;
  const names = ['NEW MOON', 'WAXING CRESCENT', 'FIRST QUARTER', 'WAXING GIBBOUS', 'FULL MOON', 'WANING GIBBOUS', 'LAST QUARTER', 'WANING CRESCENT'];
  return { age, illumination: (1 - Math.cos((2 * Math.PI * age) / SYN)) / 2, name: names[Math.round((age / SYN) * 8) % 8] };
}
