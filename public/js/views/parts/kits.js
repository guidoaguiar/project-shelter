// STORES, KITS tab — kit checklists from templates, checked on a schedule.
import { h, api, toast, panel, field, kv, daysUntil, isLow, printDoc, printButton } from '../../lib/core.js';
import { progress, nextDue, overdue, fromTemplate } from '../../lib/kits.js';

let selected = null;

/** A linked stores item's state, shown beside the kit item. */
function storeState(it) {
  if (!it) return null;
  const d = daysUntil(it.expires);
  if (d !== null && d < 0) return h('span.tag.bad', 'EXPIRED');
  if (isLow(it)) return h('span.tag.warn', 'LOW');
  if (d !== null && d < 90) return h('span.tag.warn', `${Math.floor(d)}D`);
  return h('span.tag.ok', 'OK');
}

function dueText(kit) {
  const due = nextDue(kit);
  if (!due) return 'NEVER CHECKED';
  return overdue(kit) ? `OVERDUE SINCE ${due}` : `NEXT CHECK ${due}`;
}

export async function renderKits(body, stores) {
  let [kits, templates] = await Promise.all([api('/api/db/kits'), api('/api/kits/templates').catch(() => [])]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const listBox = h('div'), detail = h('div');

  async function save(kit, patch) {
    try {
      const u = await api(`/api/db/kits/${kit.id}`, { method: 'PUT', body: patch });
      kits = kits.map((k) => (k.id === u.id ? u : k));
      paint();
      return u;
    } catch (error) { toast(error.message, true); return null; }
  }

  function newKitForm() {
    const tpl = h('select', h('option', { value: '' }, 'EMPTY KIT'), templates.map((t) => h('option', { value: t.id }, t.name.toUpperCase())));
    const name = h('input', { maxlength: 60, placeholder: 'NAME (OPTIONAL WITH A TEMPLATE)' });
    const location = h('input', { maxlength: 60, placeholder: 'e.g. HALL CUPBOARD' });
    return h('form.pb', {
      onsubmit: async (e) => {
        e.preventDefault();
        const t = templates.find((x) => x.id === tpl.value);
        const bodyIn = t ? fromTemplate(t, name.value.trim(), location.value.trim()) : { name: name.value.trim(), location: location.value.trim(), items: [] };
        if (!bodyIn.name) { toast('NAME THE KIT', true); return; }
        try {
          const k = await api('/api/db/kits', { method: 'POST', body: bodyIn });
          kits = [...kits, k];
          selected = k.id;
          paint();
        } catch (error) { toast(error.message, true); }
      },
    }, h('div.fr', field('TEMPLATE', tpl)), h('div.fr', field('NAME', name), field('LOCATION', location)), h('button.btn.primary', 'CREATE KIT'));
  }

  function list() {
    if (!kits.length) return h('div.empty', 'NO KITS YET');
    return h('div.list', kits.map((k) => {
      const p = progress(k);
      return h('button.item', { class: k.id === selected ? 'active' : null, onclick: () => { selected = k.id; paint(); } },
        h('div.t1', k.name, overdue(k) ? h('span.tag.warn', { style: 'margin-left:6px' }, 'DUE') : null),
        h('div.t2', `${k.location || 'NO LOCATION'} · ${p.done}/${p.total} · ${dueText(k)}`));
    }));
  }

  function itemRow(kit, item, i) {
    const linked = item.storeId ? storeById.get(item.storeId) : null;
    const setItems = (items) => save(kit, { items });
    const toggle = h('input', { type: 'checkbox', checked: item.done, 'aria-label': item.label,
      onchange: (e) => setItems(kit.items.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x))) });
    if (kit.checking) {
      return h('label.check-row', toggle, h('span', item.label), storeState(linked));
    }
    const link = h('select', { value: item.storeId || '', 'aria-label': 'Linked stores item',
      onchange: (e) => setItems(kit.items.map((x, j) => (j === i ? { ...x, storeId: e.target.value || null } : x))) },
    h('option', { value: '' }, 'NO STORES LINK'), stores.map((s) => h('option', { value: s.id }, `${s.name} (${s.qty} ${s.unit})`.toUpperCase())));
    return h('tr',
      h('td', toggle),
      h('td', item.label, item.note ? h('div.hint', item.note) : null),
      h('td', link, ' ', storeState(linked)),
      h('td.num', h('button.btn.sm.danger', { title: 'Remove item', onclick: () => setItems(kit.items.filter((_, j) => j !== i)) }, 'DEL')));
  }

  function print(kit) {
    printDoc(`KIT: ${kit.name.toUpperCase()}`,
      h('p', `${kit.location || 'No location'} · ${dueText(kit)} · check every ${kit.intervalDays} days`),
      h('ul.print-checklist', kit.items.map((x) => h('li', x.label, x.note ? ` (${x.note})` : ''))));
  }

  function kitDetail(kit) {
    const p = progress(kit);
    const add = h('input', { maxlength: 120, placeholder: 'ADD AN ITEM' });
    const tpl = templates.find((t) => t.id === kit.template);
    const settings = {
      name: h('input', { value: kit.name, maxlength: 60 }),
      location: h('input', { value: kit.location || '', maxlength: 60 }),
      interval: h('input', { type: 'number', min: 7, max: 730, value: kit.intervalDays }),
    };
    const checkControls = kit.checking
      ? [h('button.btn.primary', { onclick: () => save(kit, { checking: false, checkedAt: new Date().toISOString().slice(0, 10) }).then((u) => u && toast('KIT CHECKED')) }, 'FINISH CHECK'),
        h('button.btn.ghost', { onclick: () => save(kit, { checking: false }) }, 'PAUSE')]
      : [h('button.btn.primary', { onclick: () => save(kit, { checking: true, items: kit.items.map((x) => ({ ...x, done: false })) }) }, 'START CHECK')];
    const items = kit.items.map((x, i) => itemRow(kit, x, i));
    return panel(kit.checking ? 'CHECKING' : 'KIT', `${p.done}/${p.total}`, h('div.pb',
      kv('LOCATION', kit.location || '—'), kv('STATUS', dueText(kit), overdue(kit) ? 'warn' : 'ok'),
      tpl?.source ? h('p.hint', `Template: ${tpl.name}. Source: ${tpl.source}`) : null,
      h('div.row', { style: 'margin:12px 0' }, checkControls, printButton(() => print(kit))),
      kit.checking
        ? [h('p.hint', 'Tick each item as you find it in the kit. You can pause and finish later.'), h('div.check-list', items)]
        : h('div.scroll-x', h('table.t', h('tbody', items))),
      kit.checking ? null : h('form', { style: 'margin-top:12px', onsubmit: (e) => {
        e.preventDefault();
        if (!add.value.trim()) return null;
        return save(kit, { items: [...kit.items, { label: add.value.trim(), done: false }] });
      } }, h('div.row', { style: 'flex-wrap:nowrap' }, add, h('button.btn', 'ADD'))),
      kit.checking ? null : h('form', { style: 'margin-top:14px', onsubmit: (e) => {
        e.preventDefault();
        return save(kit, { name: settings.name.value.trim(), location: settings.location.value.trim(), intervalDays: +settings.interval.value }).then((u) => u && toast('KIT SAVED'));
      } },
      h('div.fr', field('NAME', settings.name), field('LOCATION', settings.location), field('CHECK EVERY (DAYS)', settings.interval)),
      h('div.row', { style: 'justify-content:space-between' },
        h('button.btn', 'SAVE KIT'),
        h('button.btn.danger', { type: 'button', onclick: async () => {
          if (!confirm(`Delete the kit "${kit.name}"?`)) return;
          try { await api(`/api/db/kits/${kit.id}`, { method: 'DELETE' }); kits = kits.filter((k) => k.id !== kit.id); selected = null; paint(); } catch (error) { toast(error.message, true); }
        } }, 'DELETE KIT')))));
  }

  function paint() {
    listBox.replaceChildren(panel('KITS', String(kits.length).padStart(2, '0'), h('div', list())), h('div', { style: 'height:14px' }), panel('NEW KIT', 'KIT-IN', newKitForm()));
    const kit = kits.find((k) => k.id === selected);
    detail.replaceChildren(kit ? kitDetail(kit) : panel('KIT', '—', h('div.pb', h('div.empty', 'SELECT OR CREATE A KIT'),
      h('p.hint', 'Templates follow the Ready.gov lists. Check each kit on a schedule; expired or low stores items show inside the kit when you link them.'))));
  }

  if (!kits.some((k) => k.id === selected)) selected = kits[0]?.id ?? null;
  body.append(h('div.split', h('div.sticky', listBox), detail));
  paint();
}
