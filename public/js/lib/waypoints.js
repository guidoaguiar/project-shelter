// Waypoint categories: labels, short map codes and GPX symbols. Pure functions, no DOM.
// The category is stored in the waypoint's `kind` field (server/schema.js WAYPOINT_KINDS);
// waypoints saved before categories existed have no kind and count as 'other'.

/** [kind, label, short code drawn on the map, GPX <sym> name used on export]. */
export const CATEGORIES = [
  ['home', 'HOME', 'HOME', 'Residence'],
  ['rally', 'RALLY POINT', 'RALLY', 'Flag, Blue'],
  ['water', 'WATER', 'H2O', 'Drinking Water'],
  ['cache', 'CACHE', 'CACHE', 'Geocache'],
  ['shelter', 'SHELTER', 'SHLT', 'Lodge'],
  ['medical', 'MEDICAL', 'MED', 'Medical Facility'],
  ['hazard', 'HAZARD', 'HAZ', 'Danger Area'],
  ['other', 'OTHER', 'WPT', 'Waypoint'],
];
export const KINDS = CATEGORIES.map(([k]) => k);
const BY_KIND = new Map(CATEGORIES.map((c) => [c[0], c]));

/** A waypoint's category, 'other' when it has none or an unknown one. */
export const kindOf = (w) => (BY_KIND.has(w?.kind) ? w.kind : 'other');
export const kindLabel = (kind) => (BY_KIND.get(kind) || BY_KIND.get('other'))[1];
export const kindShort = (kind) => (BY_KIND.get(kind) || BY_KIND.get('other'))[2];
export const kindSym = (kind) => (BY_KIND.get(kind) || BY_KIND.get('other'))[3];

// Words in GPX <sym> or <type> values (Garmin, OsmAnd, Locus and others) that name a category.
const SYM_WORDS = [
  { kind: 'home', re: /\b(home|house|residence)\b/ },
  { kind: 'water', re: /\b(water|spring|well|fountain|tap)\b/ },
  { kind: 'medical', re: /\b(medical|hospital|clinic|first aid|pharmacy|doctor|aed)\b/ },
  { kind: 'hazard', re: /\b(danger|hazard|skull|warning|caution)\b/ },
  { kind: 'shelter', re: /\b(shelter|lodge|hut|camp|campground|tent|cabin)\b/ },
  { kind: 'cache', re: /\b(cache|geocache|treasure|stash|box)\b/ },
  { kind: 'rally', re: /\b(rally|meeting|muster|flag|assembly)\b/ },
];

/** Category for GPX <type> and <sym> text: an exact kind name first, then known symbol words. */
export function kindFromGpx(type, sym) {
  const t = String(type || '').trim().toLowerCase();
  if (BY_KIND.has(t)) return t;
  const text = `${t} ${String(sym || '').toLowerCase()}`;
  return SYM_WORDS.find((w) => w.re.test(text))?.kind ?? 'other';
}

/** Waypoints whose category is in the set `shown` (all of them when shown is empty or missing). */
export function filterByKind(waypoints, shown) {
  if (!shown?.size) return waypoints;
  return waypoints.filter((w) => shown.has(kindOf(w)));
}

/** Number of waypoints per category, for the filter buttons. */
export function countByKind(waypoints) {
  const out = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const w of waypoints) out[kindOf(w)]++;
  return out;
}
