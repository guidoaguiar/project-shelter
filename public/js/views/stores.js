// STORES — supply inventory with days-of-autonomy and expiry tracking, plus kit checklists.
import { h, api, state, toast, viewHeader, panel, field, readiness, daysUntil, daysLeft, isLow, isGuest, lockedView, printDoc, printButton, plural } from '../lib/core.js';
import { storesCsv, download, today } from '../lib/export.js';
import { renderKits } from './parts/kits.js';

export const CATEGORIES = ['WATER', 'FOOD', 'MEDICAL', 'PET', 'POWER', 'TOOLS', 'COMMS', 'OTHER'];
const UNITS = ['ea', 'L', 'gal', 'kg', 'lb', 'pack', 'dose'];
/** Inventory order: by category as listed above, then by name. */
const order = (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || String(a.name).localeCompare(String(b.name));
const fmtDays = (n) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1));
const byText = (a, b) => a.localeCompare(b);
const warnDays = () => state.settings?.expiryWarnDays || 90;
/** A number input's value, or null when empty. */
const numOrNull = (el) => (el.value === '' ? null : +el.value);

/** Who the readiness figures are for. */
function forWhom(r, fromPlan) {
  if (!fromPlan) return `For a group of ${r.people} at 4 L and 2000 kcal per person per day. Add the people in your household under Plan for exact figures.`;
  const pets = r.pets ? ` and ${plural(r.pets, 'pet')}` : '';
  return `For the ${plural(r.people, 'person', 'people')}${pets} in the household plan.`;
}

/** A days-left cell: red under a week. */
function daysCell(left) {
  if (left === null) return h('span.dim', '—');
  return h(left < 7 ? 'span.bad' : 'span', fmtDays(left));
}

let tab = 'inventory';
const filters = { category: '', location: '', attention: false };

/** Expiry cell: expired, due within warnDays, or a plain date. */
export function expiry(it, warnDays) {
  if (!it.expires) return h('span.dim', '—');
  const days = Math.floor(daysUntil(it.expires) ?? 0);
  if (days < 0) return h('span.bad', `${it.expires} EXPIRED`);
  if (days < warnDays) return h('span.warn', `${it.expires} (${days}D)`);
  return it.expires;
}

/** Whether an item needs attention: expired, due soon or low. */
const needsAttention = (it, warnDays) => isLow(it) || (daysUntil(it.expires) ?? Infinity) < warnDays;

export async function render(root, arg, { code } = {}) {
  if (isGuest()) { root.append(...lockedView(code, 'STORES')); return; }
  if (arg === 'kits' || arg === 'inventory') tab = arg;
  const [items, people] = await Promise.all([api('/api/db/stores'), api('/api/db/people').catch(() => [])]);
  const tabs = h('div.tabs', { role: 'tablist' }, [['inventory', 'INVENTORY'], ['kits', 'KITS']].map(([id, label]) =>
    h('a', { role: 'tab', href: `#/stores/${id}`, class: id === tab ? 'active' : null }, label)));
  const body = h('div');
  root.append(viewHeader(code, 'STORES', 'What you hold, how long it lasts, what needs rotating, and your kits.'), tabs, body);
  if (tab === 'kits') return renderKits(body, items);
  inventory(body, items, people);
}

function inventory(body, initial, people) {
  let items = initial;
  let editing = null;
  const household = () => (people.length ? people : state.settings?.people);
  const summary = h('div.pb'), tableBox = h('div.pb.flush'), formBox = h('div'), filterBox = h('div.pb');

  async function save(id, patch) {
    const u = await api(`/api/db/stores/${id}`, { method: 'PUT', body: patch });
    items = items.map((x) => (x.id === u.id ? u : x));
    return u;
  }

  async function use(it) {
    const answer = prompt(`Use how many ${it.unit} of "${it.name}"?`, String(it.dailyUse || 1));
    if (answer === null) return;
    const n = Number(answer);
    if (!Number.isFinite(n) || n <= 0) { toast('ENTER A POSITIVE NUMBER', true); return; }
    try {
      await save(it.id, { qty: Math.max(0, +(+it.qty - n).toFixed(3)), lastUsed: new Date().toISOString().slice(0, 10) });
      paint();
    } catch (error) { toast(error.message, true); }
  }

  async function remove(it) {
    if (!confirm(`Delete "${it.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/db/stores/${it.id}`, { method: 'DELETE' });
      items = items.filter((x) => x.id !== it.id);
      if (editing?.id === it.id) { editing = null; paintForm(); }
      paint();
    } catch (error) { toast(error.message, true); }
  }

  function summaryRows(r) {
    const stats = [
      ['WATER', fmtDays(r.waterDays), 'DAYS'], ['FOOD', fmtDays(r.foodDays), 'DAYS'],
      ['WATER HELD', Math.round(r.waterL), 'L'], ['ENERGY HELD', Math.round(r.kcal / 1000), 'K KCAL'],
      ['MEDS', r.meds ? fmtDays(r.meds.days) : '—', r.meds ? 'DAYS' : '', r.meds && r.meds.days < 7 ? 'bad' : ''],
      ['LOW STOCK', r.low, '', r.low ? 'warn' : ''],
      ['EXPIRED', r.expired, '', r.expired ? 'bad' : ''], [`DUE < ${r.warnDays} D`, r.soon, '', r.soon ? 'warn' : ''],
    ];
    const who = forWhom(r, people.length > 0);
    return [
      h('div.stat-row', stats.map(([lbl, v, unit, cls]) => h('div.stat', h('div.lbl', lbl), h('div.big' + (cls ? '.' + cls : ''), v, unit ? h('small', unit) : null)))),
      r.meds ? h('p.hint', { style: 'margin:10px 0 0' }, `Medication that runs out first: ${r.meds.name}.`) : null,
      r.petsMissingWater ? h('p.hint.warn', `Set the daily water need for ${plural(r.petsMissingWater, 'pet')} under Plan, People. It is not counted until then.`) : null,
      h('p.hint', { style: 'margin:10px 0 0' }, `${who} Water counts WATER items in L or gal; food counts FOOD items with a kcal-per-unit figure; days left need a daily use.`),
    ];
  }

  function visible() {
    return [...items].sort(order).filter((it) => (!filters.category || it.category === filters.category)
      && (!filters.location || (it.location || '') === filters.location)
      && (!filters.attention || needsAttention(it, warnDays())));
  }

  function paintFilters() {
    const locations = [...new Set(items.map((it) => it.location).filter(Boolean))].sort(byText);
    const cat = h('select', { value: filters.category, onchange: (e) => { filters.category = e.target.value; paint(); } },
      h('option', { value: '' }, 'ALL CLASSES'), CATEGORIES.map((c) => h('option', { value: c }, c)));
    const loc = h('select', { value: filters.location, onchange: (e) => { filters.location = e.target.value; paint(); } },
      h('option', { value: '' }, 'ALL LOCATIONS'), locations.map((l) => h('option', { value: l }, l.toUpperCase())));
    const att = h('input', { type: 'checkbox', checked: filters.attention, onchange: (e) => { filters.attention = e.target.checked; paint(); } });
    filterBox.replaceChildren(h('div.row', field('CLASS', cat), field('LOCATION', loc), h('label.chk', att, 'NEEDS ATTENTION ONLY')));
  }

  function table(list) {
    if (!items.length) return h('div.empty', 'NO SUPPLIES RECORDED');
    if (!list.length) return h('div.empty', 'NOTHING MATCHES THE FILTER');
    return h('div.scroll-x', h('table.t',
      h('thead', h('tr', h('th', 'ITEM'), h('th', 'CLASS'), h('th.num', 'QTY'), h('th', 'UNIT'), h('th', 'LOCATION'), h('th.num', 'DAYS LEFT'), h('th', 'EXPIRES'), h('th'))),
      h('tbody', list.map((it) => h('tr',
          h('td', it.name, isLow(it) ? h('span.tag.warn', { style: 'margin-left:6px' }, 'LOW') : null, it.note ? h('div.hint', it.note) : null),
          h('td', h('span.tag', it.category)), h('td.num', it.qty), h('td', it.unit), h('td', it.location || h('span.dim', '—')),
          h('td.num', daysCell(daysLeft(it))),
          h('td', expiry(it, warnDays())),
          h('td.num', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
            h('button.btn.sm', { title: 'Record use', onclick: () => use(it) }, 'USE'),
            h('button.btn.sm', { onclick: () => { editing = it; paintForm(); formBox.scrollIntoView({ block: 'nearest' }); } }, 'EDIT'),
            h('button.btn.sm.danger', { onclick: () => remove(it) }, 'DEL'))))))));
  }

  function paint() {
    summary.replaceChildren(...summaryRows(readiness(items, household(), { warnDays: warnDays() })));
    paintFilters();
    tableBox.replaceChildren(table(visible()));
  }

  function paintForm() {
    const it = editing || {};
    const f = {
      name: h('input', { value: it.name || '', maxlength: 80, required: true, placeholder: 'e.g. WATER JERRICAN 20 L' }),
      category: h('select', { value: it.category || 'WATER' }, CATEGORIES.map((c) => h('option', { value: c }, c))),
      qty: h('input', { type: 'number', min: 0, step: 'any', value: it.qty ?? 1, required: true }),
      unit: h('select', { value: it.unit || 'L' }, UNITS.map((u) => h('option', { value: u }, u.toUpperCase()))),
      kcal: h('input', { type: 'number', min: 0, step: 'any', value: it.kcal ?? '', placeholder: 'FOOD ONLY' }),
      expires: h('input', { type: 'date', value: it.expires || '' }),
      location: h('input', { value: it.location || '', maxlength: 60, placeholder: 'e.g. GARAGE SHELF B', list: 'store-locations' }),
      minQty: h('input', { type: 'number', min: 0, step: 'any', value: it.minQty ?? '', placeholder: 'WARN AT OR BELOW' }),
      dailyUse: h('input', { type: 'number', min: 0, step: 'any', value: it.dailyUse ?? '', placeholder: 'UNITS PER DAY' }),
      note: h('input', { value: it.note || '', maxlength: 500 }),
    };
    const locations = h('datalist', { id: 'store-locations' }, [...new Set(items.map((x) => x.location).filter(Boolean))].map((l) => h('option', { value: l })));
    formBox.replaceChildren(panel(editing ? 'EDIT ITEM' : 'ADD ITEM', 'SUP-IN', h('form.pb', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = {
          name: f.name.value.trim(), category: f.category.value, qty: +f.qty.value || 0, unit: f.unit.value, kcal: numOrNull(f.kcal),
          expires: f.expires.value || null, location: f.location.value.trim(), minQty: numOrNull(f.minQty), dailyUse: numOrNull(f.dailyUse), note: f.note.value.trim(),
        };
        if (!body.name) return;
        try {
          if (editing) await save(editing.id, body);
          else items = [...items, await api('/api/db/stores', { method: 'POST', body })];
          editing = null; paintForm(); paint(); toast('STORES UPDATED');
        } catch (error) { toast(error.message, true); }
      },
    },
      h('div.fr', field('ITEM', f.name), field('CLASS', f.category), field('QUANTITY', f.qty), field('UNIT', f.unit), field('KCAL PER UNIT', f.kcal), field('EXPIRES', f.expires)),
      h('div.fr', field('LOCATION', f.location), field('MINIMUM QTY', f.minQty), field('DAILY USE', f.dailyUse), field('NOTE', f.note)),
      locations,
      h('p.hint', 'Daily use gives days left, for medication, pet food, batteries or fuel. Minimum quantity marks the item LOW.'),
      h('div.row', h('button.btn.primary', editing ? 'UPDATE ITEM' : 'ADD ITEM'),
        editing ? h('button.btn.ghost', { type: 'button', onclick: () => { editing = null; paintForm(); } }, 'CANCEL') : null))));
  }

  function print() {
    const r = readiness(items, household(), { warnDays: warnDays() });
    const rows = [...items].sort(order);
    printDoc('SUPPLIES',
      h('p', `Water ${fmtDays(r.waterDays)} days · food ${fmtDays(r.foodDays)} days · ${r.count} items · ${r.expired} expired · ${r.soon} due within ${r.warnDays} days · ${r.low} low`),
      h('table.t', h('thead', h('tr', ['ITEM', 'CLASS', 'QTY', 'UNIT', 'LOCATION', 'EXPIRES', 'NOTE'].map((x) => h('th', x)))),
        h('tbody', rows.map((it) => h('tr', h('td', it.name), h('td', it.category), h('td', it.qty), h('td', it.unit), h('td', it.location || ''), h('td', it.expires || ''), h('td', it.note || ''))))));
  }

  body.append(h('div.grid',
    panel('READINESS', 'SUP-01', summary, 's12'),
    h('div.s12', formBox),
    panel('INVENTORY', `${String(items.length).padStart(2, '0')} ITEMS`, h('div',
      filterBox,
      h('div.pb', { style: 'padding-top:0' }, h('div.row',
        h('button.btn.ghost', { type: 'button', onclick: () => download(`shelter-stores-${today()}.csv`, storesCsv(items), 'text/csv') }, 'EXPORT CSV'),
        printButton(print))),
      tableBox), 's12')));
  paint(); paintForm();
}
