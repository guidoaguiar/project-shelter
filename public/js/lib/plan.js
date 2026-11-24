// Household plan helpers: completeness checks, routes and the wallet card. Pure functions, no DOM.
import { rangeBearing } from './geo.js';

export const MEETING = [
  ['home', 'NEAR HOME', 'Right outside the home, for a sudden emergency such as a fire.'],
  ['neighbourhood', 'IN THE NEIGHBOURHOOD', 'Somewhere nearby if you cannot get home or have to leave it.'],
  ['outOfTown', 'OUT OF TOWN', 'Where to go if you have to leave the area.'],
];

export const CONTACT_ROLES = [
  ['out-of-area', 'OUT OF AREA'], ['family', 'FAMILY'], ['neighbour', 'NEIGHBOUR'], ['medical', 'MEDICAL'],
  ['utility', 'UTILITY'], ['insurance', 'INSURANCE'], ['emergency', 'EMERGENCY'], ['school-work', 'SCHOOL / WORK'], ['other', 'OTHER'],
];

const DAY = 864e5;
const addDays = (iso, days) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);

/** When the plan is next due for review (YYYY-MM-DD), or null when it was never reviewed. */
export const nextReview = (plan) => (plan.reviewedAt ? addDays(plan.reviewedAt, plan.reviewEveryDays || 365) : null);

/**
 * The plan's checklist: each item says whether it is done and which tab fixes it.
 * Returns { items, done, total, nextReview, overdue }.
 */
export function completeness(plan, people, contacts, today = new Date().toISOString().slice(0, 10)) {
  const next = nextReview(plan);
  const items = [
    ['people', 'At least one person in the household', people.some((p) => p.kind !== 'pet')],
    ['contacts', 'A contact outside your area', contacts.some((c) => c.role === 'out-of-area')],
    ['places', 'All three meeting places', MEETING.every(([k]) => plan.meeting?.[k]?.label || plan.meeting?.[k]?.waypointId)],
    ['places', 'At least one evacuation route', plan.routes?.some((r) => r.waypointIds.length >= 2)],
    ['shelter', 'Where to shut off a utility', plan.utilities?.length > 0],
    ['shelter', 'How you will get warnings', !!plan.alerts?.trim()],
    ['review', 'Reviewed in the last year', !!next && next >= today],
  ].map(([tab, label, done]) => ({ tab, label, done: !!done }));
  return { items, done: items.filter((x) => x.done).length, total: items.length, nextReview: next, overdue: !next || next < today };
}

/** A route's points (known waypoints only), each leg's distance and bearing, and the total in km. */
export function routeLegs(route, waypoints) {
  const byId = new Map(waypoints.map((w) => [w.id, w]));
  const points = route.waypointIds.map((id) => byId.get(id)).filter(Boolean);
  const legs = [];
  for (let i = 1; i < points.length; i++) legs.push({ from: points[i - 1], to: points[i], ...rangeBearing(points[i - 1], points[i]) });
  return { points, legs, km: legs.reduce((s, l) => s + l.km, 0) };
}

/** Where a meeting place is: its label, plus the waypoint's name when it is linked to one. */
export function placeText(place, waypoints) {
  const w = place?.waypointId ? waypoints.find((x) => x.id === place.waypointId) : null;
  const parts = [place?.label, w && w.name !== place?.label ? w.name : null].filter(Boolean);
  return parts.join(' · ') || '';
}

/** What goes on the printed wallet card: contacts marked for it, meeting places, and each person's medical essentials. */
export function walletCard(plan, people, contacts, waypoints) {
  return {
    contacts: contacts.filter((c) => c.onCard).map((c) => ({ name: c.name, role: c.role, phone: [c.phone, c.altPhone].filter(Boolean).join(' / '), radio: c.radio || '' })),
    meeting: MEETING.map(([k, label]) => ({ label, where: placeText(plan.meeting?.[k], waypoints) })).filter((m) => m.where),
    people: people.map((p) => ({
      name: p.name,
      kind: p.kind,
      bloodType: p.bloodType && p.bloodType !== 'unknown' ? p.bloodType : '',
      allergies: p.allergies || '',
      conditions: p.conditions || '',
      medications: (p.medications || []).map((m) => [m.name, m.dose, m.schedule].filter(Boolean).join(' ')).join('; '),
    })),
  };
}
