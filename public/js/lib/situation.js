// Situation helpers for Command: kit status, what is overdue, and the household check-in. Pure functions, no DOM.
import { overdue as kitOverdue, nextDue, progress } from './kits.js';

/** Kits at a glance: how many, how many are due a check, and how many have every item ticked. */
export function kitStatus(kits, today = new Date().toISOString().slice(0, 10)) {
  const due = kits.filter((k) => kitOverdue(k, today));
  return {
    total: kits.length,
    due: due.length,
    complete: kits.filter((k) => { const p = progress(k); return p.total > 0 && p.done === p.total; }).length,
    dueNames: due.map((k) => k.name),
  };
}

/**
 * What needs attention, most urgent first: [{ level: 'bad' | 'warn', label, href }].
 * planCheck: completeness() from lib/plan.js, or null; ready: readiness() from lib/core.js.
 */
export function attention({ planCheck = null, kits = [], ready = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  if (ready?.expired) out.push({ level: 'bad', label: `${ready.expired} expired ${ready.expired === 1 ? 'item' : 'items'} in stores`, href: '#/stores' });
  if (ready?.meds && ready.meds.days < 7) out.push({ level: 'bad', label: `${ready.meds.name} runs out in ${Math.max(0, Math.floor(ready.meds.days))} days`, href: '#/stores' });
  if (planCheck?.overdue) {
    out.push({ level: 'warn', label: planCheck.nextReview ? `Plan review overdue since ${planCheck.nextReview}` : 'The plan has never been reviewed', href: '#/plan/review' });
  }
  for (const k of kits.filter((x) => kitOverdue(x, today))) {
    const due = nextDue(k);
    out.push({ level: 'warn', label: due ? `${k.name}: check overdue since ${due}` : `${k.name}: never checked`, href: '#/stores/kits' });
  }
  if (ready?.low) out.push({ level: 'warn', label: `${ready.low} ${ready.low === 1 ? 'item' : 'items'} at or below minimum stock`, href: '#/stores' });
  return out;
}

/**
 * The check-in list for the people (and pets) in the plan, merged with the saved check-in.
 * Returns { rows: [{ personId, name, kind, ok, at }], ok, total, complete, startedAt }.
 * With no people in the plan the household is one row-less check: complete when allOk is set.
 */
export function checkinState(saved, people) {
  const marks = new Map((saved?.people || []).map((p) => [p.personId, p]));
  const rows = people.map((p) => {
    const m = marks.get(p.id);
    return { personId: p.id, name: p.name, kind: p.kind || 'person', ok: !!m?.ok, at: m?.at || null };
  });
  const ok = rows.filter((r) => r.ok).length;
  const complete = rows.length ? ok === rows.length : !!saved?.allOk;
  return { rows, ok, total: rows.length, complete, startedAt: saved?.startedAt || null };
}

/** The document to save after marking one person (or, with personId null, everyone) as accounted for or not. */
export function markCheckin(current, personId, ok, now = new Date().toISOString()) {
  const people = current.rows.map((r) => {
    if (personId !== null && r.personId !== personId) return { personId: r.personId, name: r.name, ok: r.ok, at: r.at };
    return { personId: r.personId, name: r.name, ok, at: ok ? now : null };
  });
  return { startedAt: current.startedAt || now, allOk: personId === null ? ok : people.length > 0 && people.every((p) => p.ok), people };
}

/** A new check-in: nobody marked yet. */
export const newCheckin = (current, now = new Date().toISOString()) => ({
  startedAt: now, allOk: false, people: current.rows.map((r) => ({ personId: r.personId, name: r.name, ok: false, at: null })),
});
