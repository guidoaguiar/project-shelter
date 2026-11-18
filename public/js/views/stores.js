// 07 STORES — supply inventory with days-of-autonomy and expiry tracking.
import { h, api, state, toast, viewHeader, panel, field, readiness } from '../lib/core.js';

const CATEGORIES = ['WATER', 'FOOD', 'MEDICAL', 'POWER', 'TOOLS', 'COMMS', 'OTHER'];
/** Inventory order: by category as listed above, then by name. */
const order = (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || String(a.name).localeCompare(String(b.name));
const UNITS = ['ea', 'L', 'gal', 'kg', 'lb', 'pack'];

export async function render(root) {
  let items = await api('/api/db/stores');
  let editing = null;
  const summary = h('div.pb'), tableBox = h('div.pb.flush'), formBox = h('div');

  function expiry(it) {
    if (!it.expires) return h('span.dim', '—');
    const days = Math.floor((Date.parse(it.expires) - Date.now()) / 864e5);
    if (days < 0) return h('span.bad', `${it.expires} EXPIRED`);
    if (days < 90) return h('span.warn', `${it.expires} (${days}D)`);
    return it.expires;
  }

  function paint() {
    const r = readiness(items, state.settings?.people);
    const days = (n) => (n >= 100 ? Math.round(n) : n.toFixed(1));
    summary.replaceChildren(h('div.stat-row',
      h('div.stat', h('div.lbl', 'WATER'), h('div.big', days(r.waterDays), h('small', 'DAYS'))),
      h('div.stat', h('div.lbl', 'FOOD'), h('div.big', days(r.foodDays), h('small', 'DAYS'))),
      h('div.stat', h('div.lbl', 'WATER HELD'), h('div.big', Math.round(r.waterL), h('small', 'L'))),
      h('div.stat', h('div.lbl', 'ENERGY HELD'), h('div.big', Math.round(r.kcal / 1000), h('small', 'K KCAL'))),
      h('div.stat', h('div.lbl', 'EXPIRED'), h('div.big' + (r.expired ? '.bad' : ''), r.expired)),
      h('div.stat', h('div.lbl', 'DUE < 90 D'), h('div.big' + (r.soon ? '.warn' : ''), r.soon))),
      h('p.hint', { style: 'margin:12px 0 0' }, `For a group of ${r.people} at 4 L and 2000 kcal per person per day. Water counts items in the WATER category measured in L or gal; food counts FOOD items with a kcal-per-unit figure. Change group size in Command.`));

    tableBox.replaceChildren(items.length ? h('div.scroll-x', h('table.t',
      h('thead', h('tr', h('th', 'ITEM'), h('th', 'CLASS'), h('th.num', 'QTY'), h('th', 'UNIT'), h('th.num', 'KCAL / UNIT'), h('th', 'EXPIRES'), h('th'))),
      h('tbody', [...items].sort(order).map((it) => h('tr',
        h('td', it.name), h('td', h('span.tag', it.category)), h('td.num', it.qty), h('td', it.unit),
        h('td.num', it.kcal || h('span.dim', '—')), h('td', expiry(it)),
        h('td.num', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
          h('button.btn.sm', { onclick: () => { editing = it; paintForm(); formBox.scrollIntoView({ block: 'nearest' }); } }, 'EDIT'),
          h('button.btn.sm.danger', { onclick: async () => {
            try { await api(`/api/db/stores/${it.id}`, { method: 'DELETE' }); items = items.filter((x) => x.id !== it.id); if (editing?.id === it.id) { editing = null; paintForm(); } paint(); } catch (error) { toast(error.message, true); }
          } }, 'DEL'))))))))
      : h('div.empty', 'NO SUPPLIES RECORDED'));
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
    };
    formBox.replaceChildren(panel(editing ? 'EDIT ITEM' : 'ADD ITEM', 'SUP-IN', h('form.pb', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: f.name.value.trim(), category: f.category.value, qty: +f.qty.value || 0, unit: f.unit.value, kcal: f.kcal.value ? +f.kcal.value : null, expires: f.expires.value || null };
        if (!body.name) return;
        try {
          if (editing) { const u = await api(`/api/db/stores/${editing.id}`, { method: 'PUT', body }); items = items.map((x) => (x.id === u.id ? u : x)); }
          else items = [...items, await api('/api/db/stores', { method: 'POST', body })];
          editing = null; paintForm(); paint(); toast('STORES UPDATED');
        } catch (error) { toast(error.message, true); }
      },
    },
      h('div.fr', field('ITEM', f.name), field('CLASS', f.category), field('QUANTITY', f.qty), field('UNIT', f.unit), field('KCAL PER UNIT', f.kcal), field('EXPIRES', f.expires)),
      h('div.row', h('button.btn.primary', editing ? 'UPDATE ITEM' : 'ADD ITEM'),
        editing ? h('button.btn.ghost', { type: 'button', onclick: () => { editing = null; paintForm(); } }, 'CANCEL') : null))));
  }

  root.append(
    viewHeader('07', 'STORES', 'What you hold, how long it lasts, and what needs rotating.'),
    h('div.grid',
      panel('READINESS', 'SUP-01', summary, 's12'),
      h('div.s12', formBox),
      panel('INVENTORY', `${String(items.length).padStart(2, '0')} ITEMS`, tableBox, 's12')));
  paint(); paintForm();
}
