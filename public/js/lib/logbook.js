// Log helpers: templates, tags, search and date filters, and table rows for radio and medical logs.
// Pure functions, no DOM.

const pad2 = (n) => String(n).padStart(2, '0');
/** Local date and time as YYYY-MM-DD HH:MM. */
export const localStamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** Local time as HH:MM. */
export const localTime = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const tableHead = (columns) => `| ${columns.map((c) => c.label).join(' | ')} |\n|${columns.map(() => '---').join('|')}|`;

const RADIO = [
  { key: 'time', label: 'Time' }, { key: 'freq', label: 'Frequency' }, { key: 'callsign', label: 'Callsign' }, { key: 'message', label: 'Message' },
];
const VITALS = [
  { key: 'time', label: 'Time' }, { key: 'pulse', label: 'Pulse' }, { key: 'resp', label: 'Resp' }, { key: 'bp', label: 'BP' },
  { key: 'temp', label: 'Temp' }, { key: 'spo2', label: 'SpO2' }, { key: 'avpu', label: 'AVPU' }, { key: 'notes', label: 'Notes' },
];

/**
 * Entry templates. body(now) is the starting Markdown; columns, when present, is the table the
 * entry's quick-add form appends rows to.
 */
export const TEMPLATES = [
  {
    id: 'incident', label: 'INCIDENT REPORT', tag: 'incident',
    body: (now) => [
      `**Reported:** ${localStamp(now)}`, '', '## What happened', '', '## When and where', '', '## People involved or injured', '',
      '## Damage', '', '## Actions taken', '', '## Follow-up needed', '', '## Reported to', '',
    ].join('\n'),
  },
  {
    id: 'sitrep', label: 'SITREP', tag: 'sitrep',
    body: (now) => [
      `**Time:** ${localStamp(now)}`, '**Location:** ', '', '## Situation', '', '## People (accounted for / injured / missing)', '',
      '## Supplies (water, food, medication: days left)', '', '## Power and comms', '', '## Needs', '', '## Next report', '',
    ].join('\n'),
  },
  {
    id: 'checkin', label: 'DAILY CHECK-IN', tag: 'checkin',
    body: () => [
      '- [ ] Everyone accounted for', '- [ ] Health: anyone ill or injured?', '- [ ] Water and food checked', '- [ ] Medication taken',
      '- [ ] Power and batteries checked', '- [ ] Hazards outside (weather, fire, flood)', '', '## Tasks today', '', '## Notes', '',
    ].join('\n'),
  },
  {
    id: 'radio', label: 'RADIO LOG', tag: 'radio', columns: RADIO,
    body: () => `**Station:** \n\n${tableHead(RADIO)}\n`,
  },
  {
    id: 'medical', label: 'MEDICAL OBSERVATIONS', tag: 'medical', columns: VITALS,
    body: (now) => [
      '**Patient:** ', '**Age / weight:** ', '**Allergies:** ', '**Problem:** ', `**Started:** ${localStamp(now)}`, '',
      '## Observations', '', tableHead(VITALS), '', '## Treatment given', '',
    ].join('\n'),
  },
];

export const template = (id) => TEMPLATES.find((t) => t.id === id) || null;

/** A new entry from a template: { title, body, tags, template }. */
export function fromTemplate(id, now = new Date()) {
  const t = template(id);
  if (!t) return { title: `LOG ${localStamp(now).slice(0, 10)}`, body: '', tags: [], template: '' };
  return { title: `${t.label} ${localStamp(now)}`, body: t.body(now), tags: [t.tag], template: t.id };
}

/** Tags from typed text ("water, #Repair  radio"): lowercase, letters, digits, - and _, unique, at most 20. */
export function parseTags(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,]+/)) {
    const t = raw.replace(/^#+/, '').toLowerCase().replaceAll(/[^a-z0-9_-]/g, '').slice(0, 32);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 20);
}

/** Every tag in use with its count, most used first, then by name: [[tag, count]]. */
export function allTags(notes) {
  const count = new Map();
  for (const n of notes) for (const t of n.tags || []) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The day an entry belongs to (YYYY-MM-DD, UTC, as the list shows it): when it was created. */
export const noteDay = (n) => String(n.created || n.updated || '').slice(0, 10);

/**
 * Entries matching a filter. q: every word must appear in the title, body or tags. tag: entries
 * with that tag. from / to: YYYY-MM-DD, inclusive, on the day the entry was created.
 */
export function filterNotes(notes, { q = '', tag = '', from = '', to = '' } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (tag && !(n.tags || []).includes(tag)) return false;
    const day = noteDay(n);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (!words.length) return true;
    const hay = `${n.title || ''}\n${n.body || ''}\n${(n.tags || []).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** One table cell: pipes escaped, line breaks flattened. */
const cell = (v) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' ').replaceAll('\\', '\\\\').replaceAll('|', String.raw`\|`);

/**
 * body with one row added to the table whose header is columns (after its last row). When the
 * entry has no such table, the table is added at the end.
 */
export function appendRow(body, columns, values) {
  const row = `| ${columns.map((c) => cell(values[c.key]) || ' ').join(' | ')} |`;
  const head = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const lines = String(body || '').split('\n');
  const at = lines.findLastIndex((l) => l.trim() === head);
  if (at < 0) {
    const text = String(body || '').trimEnd();
    return `${text ? text + '\n\n' : ''}${tableHead(columns)}\n${row}\n`;
  }
  let end = at + 1;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  lines.splice(end, 0, row);
  return lines.join('\n');
}
