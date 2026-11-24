// Kit helpers: progress and when a kit is next due for a check. Pure functions, no DOM.
const DAY = 864e5;

export const progress = (kit) => ({ done: kit.items.filter((x) => x.done).length, total: kit.items.length });

/** The date (YYYY-MM-DD) a kit is next due, or null when it was never checked (due now). */
export const nextDue = (kit) => (kit.checkedAt ? new Date(Date.parse(kit.checkedAt) + (kit.intervalDays || 180) * DAY).toISOString().slice(0, 10) : null);

/** Whether a kit needs checking: never checked, or past its interval. */
export function overdue(kit, today = new Date().toISOString().slice(0, 10)) {
  const due = nextDue(kit);
  return !due || due < today;
}

/** A new kit's fields from a template. */
export const fromTemplate = (t, name, location = '') => ({
  name: name || t.name, template: t.id, location, intervalDays: t.intervalDays || 180,
  items: t.items.map((label) => ({ label, done: false })),
});
