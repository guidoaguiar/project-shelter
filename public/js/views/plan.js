// PLAN — the household emergency plan: people and pets, contacts, meeting places and routes,
// sheltering in place, and a review checklist. Follows Ready.gov's planning questions.
import { h, api, toast, viewHeader, panel, field, kv, daysLeft, isGuest, lockedView, printDoc, printButton } from '../lib/core.js';
import { MEETING, CONTACT_ROLES, completeness, routeLegs, placeText, walletCard } from '../lib/plan.js';
import { compassPoint } from '../lib/geo.js';

const TABS = [['people', 'PEOPLE'], ['contacts', 'CONTACTS'], ['places', 'PLACES & ROUTES'], ['shelter', 'SHELTER'], ['review', 'REVIEW']];
const GROUPS = [['adult', 'ADULT'], ['child', 'CHILD'], ['infant', 'INFANT'], ['senior', 'SENIOR']];
const BLOOD = ['unknown', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const UTILITIES = [['gas', 'GAS'], ['water', 'WATER'], ['electric', 'ELECTRICITY'], ['other', 'OTHER']];
const roleLabel = (r) => CONTACT_ROLES.find(([k]) => k === r)?.[1] || 'OTHER';
const options = (pairs) => pairs.map(([v, label]) => h('option', { value: v }, label));
const textarea = (value, rows = 3, placeholder = '') => h('textarea', { rows, placeholder, style: 'font-family:var(--sans);font-size:13px' }, value || '');
const today = () => new Date().toISOString().slice(0, 10);
/** A number input's value, or null when empty. */
const numOrNull = (el) => (el.value === '' ? null : +el.value);
/** Days of a linked medication left: red under a week. */
function daysTag(left) {
  if (left === null) return null;
  return h(left < 7 ? 'span.tag.bad' : 'span.tag.ok', `${Math.floor(left)} DAYS`);
}

let tab = 'people';
let selectedPerson = null;
let selectedContact = null;

export async function render(root, arg, { code } = {}) {
  if (isGuest()) { root.append(...lockedView(code, 'PLAN')); return; }
  if (TABS.some(([id]) => id === arg)) tab = arg;
  const data = {};
  [data.plan, data.people, data.contacts, data.waypoints, data.stores] = await Promise.all(
    ['/api/plan', '/api/db/people', '/api/db/contacts', '/api/db/waypoints', '/api/db/stores'].map((u) => api(u)));
  const body = h('div');
  const check = completeness(data.plan, data.people, data.contacts);
  const tabs = h('div.tabs', { role: 'tablist' }, TABS.map(([id, label]) => h('a', { role: 'tab', href: `#/plan/${id}`, class: id === tab ? 'active' : null }, label)));
  root.append(
    viewHeader(code, 'PLAN', 'Who is in the household, who to call, where to meet, and how to shelter.',
      h('span.code', `${check.done}/${check.total} DONE`)),
    tabs, body);
  const ctx = { data, body, refresh: () => window.dispatchEvent(new Event('hashchange')) };
  ({ people, contacts, places, shelter, review })[tab](ctx);
}

/** Saves a record in a collection (create without an id), returning the stored one. */
async function saveRecord(name, id, record) {
  return id ? api(`/api/db/${name}/${id}`, { method: 'PUT', body: record }) : api(`/api/db/${name}`, { method: 'POST', body: record });
}

async function savePlan(patch, message = 'PLAN SAVED') {
  try {
    const p = await api('/api/plan', { method: 'PUT', body: patch });
    toast(message);
    return p;
  } catch (error) { toast(error.message, true); return null; }
}

// ---------- people ----------

function medRows(meds, stores) {
  const box = h('div');
  const medical = stores.filter((s) => s.category === 'MEDICAL');
  function paint() {
    box.replaceChildren(...meds.map((m, i) => {
      const linked = medical.find((s) => s.id === m.storeId);
      const left = linked ? daysLeft(linked) : null;
      const set = (k) => (e) => { meds[i] = { ...meds[i], [k]: e.target.value || (k === 'storeId' ? null : '') }; if (k === 'storeId') paint(); };
      return h('div.fr', { style: 'margin-bottom:6px' },
        h('input', { value: m.name || '', placeholder: 'MEDICATION', maxlength: 60, oninput: set('name') }),
        h('input', { value: m.dose || '', placeholder: 'DOSE', maxlength: 40, oninput: set('dose') }),
        h('input', { value: m.schedule || '', placeholder: 'WHEN', maxlength: 60, oninput: set('schedule') }),
        h('select', { value: m.storeId || '', onchange: set('storeId') }, h('option', { value: '' }, 'NO STORES LINK'), medical.map((s) => h('option', { value: s.id }, s.name.toUpperCase()))),
        h('div.row', { style: 'flex-wrap:nowrap' },
          daysTag(left),
          h('button.btn.sm.danger', { type: 'button', onclick: () => { meds.splice(i, 1); paint(); } }, 'DEL')));
    }), h('button.btn.sm', { type: 'button', onclick: () => { meds.push({ name: '', dose: '', schedule: '', storeId: null }); paint(); } }, '+ MEDICATION'));
  }
  paint();
  return box;
}

function personForm(person, ctx) {
  const pet = person.kind === 'pet';
  const meds = (person.medications || []).map((m) => ({ ...m }));
  const f = {
    name: h('input', { value: person.name || '', maxlength: 60, required: true }),
    group: pet ? h('input', { value: person.group || '', maxlength: 30, placeholder: 'e.g. DOG, 20 KG' }) : h('select', { value: person.group || 'adult' }, options(GROUPS)),
    birthYear: h('input', { type: 'number', min: 1900, max: 2100, value: person.birthYear ?? '' }),
    bloodType: h('select', { value: person.bloodType || 'unknown' }, BLOOD.map((b) => h('option', { value: b }, b.toUpperCase()))),
    allergies: h('input', { value: person.allergies || '', maxlength: 300 }),
    conditions: h('input', { value: person.conditions || '', maxlength: 300 }),
    needs: h('input', { value: person.needs || '', maxlength: 300, placeholder: pet ? 'CARRIER, MUZZLE, SPECIAL FOOD' : 'GLASSES, MOBILITY AIDS, FORMULA' }),
    waterL: h('input', { type: 'number', min: 0, max: 50, step: 'any', value: person.waterL ?? '', placeholder: pet ? 'REQUIRED FOR PETS' : '4 (DEFAULT)' }),
    kcal: h('input', { type: 'number', min: 0, max: 10_000, step: 'any', value: person.kcal ?? '', placeholder: '2000 (DEFAULT)' }),
    notes: textarea(person.notes, 3, pet ? 'Vet, microchip number, vaccinations' : ''),
  };
  return h('form.pb', {
    onsubmit: async (e) => {
      e.preventDefault();
      const record = {
        name: f.name.value.trim(), kind: person.kind || 'person', group: f.group.value.trim(), birthYear: numOrNull(f.birthYear),
        bloodType: f.bloodType.value, allergies: f.allergies.value.trim(), conditions: f.conditions.value.trim(), needs: f.needs.value.trim(),
        medications: meds.filter((m) => m.name.trim()), waterL: numOrNull(f.waterL), kcal: pet ? null : numOrNull(f.kcal), notes: f.notes.value,
      };
      try {
        const saved = await saveRecord('people', person.id, record);
        selectedPerson = saved.id;
        toast('SAVED');
        ctx.refresh();
      } catch (error) { toast(error.message, true); }
    },
  },
    h('div.fr', field('NAME', f.name), field(pet ? 'SPECIES / SIZE' : 'AGE GROUP', f.group), field('BIRTH YEAR', f.birthYear), pet ? null : field('BLOOD TYPE', f.bloodType)),
    h('div.fr', field('ALLERGIES', f.allergies), field('CONDITIONS', f.conditions), field('NEEDS', f.needs)),
    h('div.fr', field('WATER L / DAY', f.waterL), pet ? null : field('KCAL / DAY', f.kcal)),
    h('div.lbl', { style: 'margin:12px 0 6px' }, 'MEDICATIONS'),
    medRows(meds, ctx.data.stores),
    field('NOTES', f.notes),
    h('div.row', { style: 'justify-content:space-between;margin-top:10px' },
      h('button.btn.primary', person.id ? 'SAVE' : 'ADD'),
      person.id ? h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!confirm(`Remove ${person.name} from the plan?`)) return;
        try { await api(`/api/db/people/${person.id}`, { method: 'DELETE' }); selectedPerson = null; ctx.refresh(); } catch (error) { toast(error.message, true); }
      } }, 'REMOVE') : null));
}

function people(ctx) {
  const { data, body } = ctx;
  const editor = h('div');
  const open = (p) => {
    selectedPerson = p.id || null;
    const kind = p.kind === 'pet' ? 'PET' : 'PERSON';
    const title = p.id ? p.name.toUpperCase() : `NEW ${kind}`;
    editor.replaceChildren(panel(title, kind, personForm(p, ctx)));
  };
  const list = h('div.list', data.people.length ? data.people.map((p) => h('button.item', { class: p.id === selectedPerson ? 'active' : null, onclick: () => open(p) },
    h('div.t1', p.name),
    h('div.t2', [p.kind === 'pet' ? (p.group || 'PET') : (p.group || 'adult').toUpperCase(), p.bloodType && p.bloodType !== 'unknown' ? p.bloodType : null, p.allergies ? `ALLERGIES: ${p.allergies}` : null].filter(Boolean).join(' · '))))
    : h('div.empty', 'NOBODY ADDED YET'));
  body.append(h('div.split',
    h('div.sticky', panel('HOUSEHOLD', String(data.people.length).padStart(2, '0'), h('div', list,
      h('div.pb', h('div.row', h('button.btn.primary', { onclick: () => open({ kind: 'person' }) }, '+ PERSON'), h('button.btn', { onclick: () => open({ kind: 'pet' }) }, '+ PET')),
        h('p.hint', 'People and pets here set the water and food targets in Stores, and appear on the printed wallet card.'))))),
    editor));
  const current = data.people.find((p) => p.id === selectedPerson) || data.people[0];
  if (current) open(current);
  else editor.append(panel('PERSON', '—', h('div.pb', h('div.empty', 'ADD THE FIRST PERSON'))));
}

// ---------- contacts ----------

function contactForm(c, ctx) {
  const f = {
    name: h('input', { value: c.name || '', maxlength: 60, required: true }),
    role: h('select', { value: c.role || 'family' }, options(CONTACT_ROLES)),
    phone: h('input', { value: c.phone || '', maxlength: 30, inputmode: 'tel' }),
    altPhone: h('input', { value: c.altPhone || '', maxlength: 30, inputmode: 'tel' }),
    email: h('input', { value: c.email || '', maxlength: 120, inputmode: 'email' }),
    radio: h('input', { value: c.radio || '', maxlength: 60, placeholder: 'CALLSIGN, CHANNEL OR NODE' }),
    address: h('input', { value: c.address || '', maxlength: 200 }),
    policy: h('input', { value: c.policy || '', maxlength: 60, placeholder: 'POLICY OR ACCOUNT NO.' }),
    notes: h('input', { value: c.notes || '', maxlength: 500 }),
    onCard: h('input', { type: 'checkbox', checked: !!c.onCard }),
  };
  return h('form.pb', {
    onsubmit: async (e) => {
      e.preventDefault();
      const record = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, k === 'onCard' ? el.checked : el.value.trim()]));
      try {
        const saved = await saveRecord('contacts', c.id, record);
        selectedContact = saved.id;
        toast('SAVED');
        ctx.refresh();
      } catch (error) { toast(error.message, true); }
    },
  },
    h('div.fr', field('NAME', f.name), field('ROLE', f.role), field('PHONE', f.phone), field('OTHER PHONE', f.altPhone)),
    h('div.fr', field('EMAIL', f.email), field('RADIO', f.radio), field('ADDRESS', f.address), field('POLICY / ACCOUNT', f.policy)),
    field('NOTES', f.notes),
    h('label.chk', f.onCard, 'PRINT ON THE WALLET CARD'),
    h('div.row', { style: 'justify-content:space-between;margin-top:10px' },
      h('button.btn.primary', c.id ? 'SAVE' : 'ADD'),
      c.id ? h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!confirm(`Delete ${c.name}?`)) return;
        try { await api(`/api/db/contacts/${c.id}`, { method: 'DELETE' }); selectedContact = null; ctx.refresh(); } catch (error) { toast(error.message, true); }
      } }, 'DELETE') : null));
}

function contacts(ctx) {
  const { data, body } = ctx;
  const editor = h('div');
  const open = (c) => { selectedContact = c.id || null; editor.replaceChildren(panel(c.id ? c.name.toUpperCase() : 'NEW CONTACT', 'CON', contactForm(c, ctx))); };
  const sorted = [...data.contacts].sort((a, b) => CONTACT_ROLES.findIndex(([r]) => r === a.role) - CONTACT_ROLES.findIndex(([r]) => r === b.role) || a.name.localeCompare(b.name));
  const table = sorted.length ? h('div.scroll-x', h('table.t', h('tbody', sorted.map((c) => h('tr', { class: c.id === selectedContact ? 'active' : null },
    h('td', h('span.tag', roleLabel(c.role))), h('td', c.name, c.onCard ? h('span.tag.acc', { style: 'margin-left:6px' }, 'CARD') : null),
    h('td', [c.phone, c.radio].filter(Boolean).join(' · ') || h('span.dim', '—')),
    h('td.num', h('button.btn.sm', { onclick: () => open(c) }, 'EDIT')))))))
    : h('div.empty', 'NO CONTACTS YET');
  const warn = data.contacts.some((c) => c.role === 'out-of-area') ? null
    : h('div.banner', h('b', 'TIP'), 'Add a contact outside your area. Local lines are often busy in a disaster, and long-distance calls or texts can get through.');
  body.append(warn, h('div.grid',
    panel('CONTACTS', String(data.contacts.length).padStart(2, '0'), h('div', table, h('div.pb', h('button.btn.primary', { onclick: () => open({ role: 'family' }) }, '+ CONTACT'))), 's7'),
    h('div.s5', editor)));
  const current = data.contacts.find((c) => c.id === selectedContact);
  if (current) open(current);
  else editor.append(panel('CONTACT', '—', h('div.pb', h('div.empty', 'SELECT OR ADD A CONTACT'))));
}

// ---------- places and routes ----------

const waypointSelect = (waypoints, value, onchange) => h('select', { value: value || '', onchange },
  h('option', { value: '' }, 'NO WAYPOINT'), waypoints.map((w) => h('option', { value: w.id }, String(w.name).toUpperCase())));

function meetingCard([key, label, help], ctx) {
  const m = ctx.data.plan.meeting[key];
  const f = {
    label: h('input', { value: m.label || '', maxlength: 80, placeholder: 'e.g. THE OAK TREE AT THE CORNER' }),
    waypointId: waypointSelect(ctx.data.waypoints, m.waypointId, () => {}),
    notes: h('input', { value: m.notes || '', maxlength: 300 }),
  };
  return panel(label, 'MEET', h('form.pb', {
    onsubmit: async (e) => {
      e.preventDefault();
      const meeting = { ...ctx.data.plan.meeting, [key]: { label: f.label.value.trim(), waypointId: f.waypointId.value || null, notes: f.notes.value.trim() } };
      if (await savePlan({ meeting })) ctx.refresh();
    },
  },
    h('p.hint', { style: 'margin-top:0' }, help),
    field('PLACE', f.label), field('WAYPOINT', f.waypointId), field('NOTES', f.notes),
    h('div.row', { style: 'margin-top:8px' }, h('button.btn.primary', 'SAVE'), h('a.btn.ghost', { href: `#/map/pick/meeting.${key}`, style: 'text-decoration:none' }, 'PICK ON MAP'))), 's4');
}

function routeCard(route, i, ctx) {
  const { plan, waypoints } = ctx.data;
  const ids = [...route.waypointIds];
  const name = h('input', { value: route.name, maxlength: 60, required: true });
  const notes = h('input', { value: route.notes || '', maxlength: 300 });
  const pts = h('div');
  const add = waypointSelect(waypoints, '', () => {});
  function paint() {
    const r = routeLegs({ waypointIds: ids }, waypoints);
    const byId = new Map(waypoints.map((w) => [w.id, w]));
    pts.replaceChildren(
      ids.length ? h('ol.route', ids.map((id, j) => h('li', String(byId.get(id)?.name || 'MISSING').toUpperCase(),
        j > 0 && r.legs[j - 1] ? h('span.hint', ` ${r.legs[j - 1].km.toFixed(2)} KM ${Math.round(r.legs[j - 1].bearing)}° ${compassPoint(r.legs[j - 1].bearing)}`) : null,
        h('span.row', { style: 'display:inline-flex;margin-left:8px' },
          h('button.btn.sm', { type: 'button', disabled: j === 0, onclick: () => { [ids[j - 1], ids[j]] = [ids[j], ids[j - 1]]; paint(); } }, '↑'),
          h('button.btn.sm', { type: 'button', disabled: j === ids.length - 1, onclick: () => { [ids[j + 1], ids[j]] = [ids[j], ids[j + 1]]; paint(); } }, '↓'),
          h('button.btn.sm.danger', { type: 'button', onclick: () => { ids.splice(j, 1); paint(); } }, 'DEL'))))) : h('p.hint', 'No points yet.'),
      r.legs.length ? kv('TOTAL', `${r.km.toFixed(2)} KM`) : null);
  }
  paint();
  return panel(route.name.toUpperCase() || 'ROUTE', `RTE-${i + 1}`, h('form.pb', {
    onsubmit: async (e) => {
      e.preventDefault();
      const routes = plan.routes.map((x, j) => (j === i ? { ...x, name: name.value.trim(), notes: notes.value.trim(), waypointIds: ids } : x));
      if (await savePlan({ routes })) ctx.refresh();
    },
  },
    h('div.fr', field('NAME', name), field('NOTES', notes)),
    pts,
    h('div.row', { style: 'flex-wrap:nowrap;margin-top:8px' }, add, h('button.btn', { type: 'button', onclick: () => { if (add.value) { ids.push(add.value); paint(); } } }, 'ADD POINT')),
    h('div.row', { style: 'justify-content:space-between;margin-top:10px' },
      h('div.row', h('button.btn.primary', 'SAVE ROUTE'), h('a.btn.ghost', { href: `#/map/pick/route.${route.id}`, style: 'text-decoration:none' }, 'ADD FROM MAP')),
      h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!confirm(`Delete the route "${route.name}"?`)) return;
        if (await savePlan({ routes: plan.routes.filter((_, j) => j !== i) }, 'ROUTE DELETED')) ctx.refresh();
      } }, 'DELETE'))), 's6');
}

function places(ctx) {
  const { data, body } = ctx;
  const newRoute = async () => {
    const routes = [...data.plan.routes, { name: `Route ${data.plan.routes.length + 1}`, waypointIds: [], notes: '' }];
    if (await savePlan({ routes }, 'ROUTE ADDED')) ctx.refresh();
  };
  body.append(
    data.waypoints.length ? null : h('div.banner', h('b', 'TIP'), 'Places and routes use map waypoints. Use PICK ON MAP, or save waypoints in the Map module first.'),
    h('div.grid', MEETING.map((m) => meetingCard(m, ctx))),
    h('div.vh', { style: 'margin-top:18px' }, h('div', h('h2', { style: 'font-size:13px;letter-spacing:.2em;margin:0' }, 'EVACUATION ROUTES')),
      h('div.actions', h('button.btn.primary', { onclick: newRoute, disabled: data.plan.routes.length >= 10 }, '+ ROUTE'))),
    data.plan.routes.length ? h('div.grid', data.plan.routes.map((r, i) => routeCard(r, i, ctx)))
      : panel('ROUTES', '00', h('div.pb', h('div.empty', 'NO ROUTES YET'), h('p.hint', 'Plan a main and an alternate way out, in case roads are blocked.'))),
    h('p.hint', 'Routes and meeting places are drawn on the Map.'));
}

// ---------- shelter ----------

function shelter(ctx) {
  const { plan } = ctx.data;
  const utilities = plan.utilities.map((u) => ({ ...u }));
  const box = h('div');
  function paintUtilities() {
    box.replaceChildren(...utilities.map((u, i) => {
      const set = (k) => (e) => { utilities[i] = { ...utilities[i], [k]: e.target.value }; };
      return h('div.fr', { style: 'margin-bottom:8px' },
        h('select', { value: u.kind || 'gas', onchange: set('kind') }, options(UTILITIES)),
        h('input', { value: u.location || '', maxlength: 120, placeholder: 'WHERE THE SHUT-OFF IS', oninput: set('location') }),
        h('input', { value: u.howTo || '', maxlength: 500, placeholder: 'HOW TO CLOSE IT', oninput: set('howTo') }),
        h('input', { value: u.tool || '', maxlength: 80, placeholder: 'TOOL NEEDED', oninput: set('tool') }),
        h('button.btn.sm.danger', { type: 'button', onclick: () => { utilities.splice(i, 1); paintUtilities(); } }, 'DEL'));
    }), h('button.btn.sm', { type: 'button', onclick: () => { utilities.push({ kind: 'gas', location: '', howTo: '', tool: '' }); paintUtilities(); } }, '+ SHUT-OFF'));
  }
  paintUtilities();
  const f = {
    alerts: textarea(plan.alerts, 3, 'Weather radio, sirens, local alert app, a neighbour who calls…'),
    room: h('input', { value: plan.shelter.room || '', maxlength: 80, placeholder: 'e.g. INTERIOR BATHROOM, GROUND FLOOR' }),
    shelterNotes: textarea(plan.shelter.notes, 3, 'What to bring into the room, how to seal it'),
    documents: textarea(plan.documents, 2, 'Where originals and copies are kept'),
  };
  ctx.body.append(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      await savePlan({ alerts: f.alerts.value, shelter: { room: f.room.value.trim(), notes: f.shelterNotes.value }, utilities, documents: f.documents.value });
    },
  }, h('div.grid',
    panel('ALERTS AND WARNINGS', 'ALR', h('div.pb', h('p.hint', { style: 'margin-top:0' }, 'How will the household hear about an emergency, including at night and with the power off?'), f.alerts), 's6'),
    panel('SHELTER IN PLACE', 'SIP', h('div.pb', field('ROOM', f.room), field('NOTES', f.shelterNotes)), 's6'),
    panel('UTILITY SHUT-OFFS', 'UTL', h('div.pb', h('p.hint', { style: 'margin-top:0' }, 'Only turn off gas if you smell it or are told to: a professional has to turn it back on.'), box), 's12'),
    panel('IMPORTANT DOCUMENTS', 'DOC', h('div.pb', f.documents), 's12')),
  h('div.row', { style: 'margin-top:14px' }, h('button.btn.primary', 'SAVE SHELTER PLAN'))));
}

// ---------- review and printing ----------

function printPlan(data) {
  const { plan, people: ppl, contacts: cons, waypoints } = data;
  const section = (title, ...kids) => h('section.page', h('h2', title), ...kids);
  const rows = (list) => h('table.t', h('tbody', list.map(([k, v]) => h('tr', h('th', k), h('td', v || '—')))));
  printDoc('HOUSEHOLD EMERGENCY PLAN',
    section('People and pets', ...ppl.map((p) => h('div.print-block', h('h3', p.name), rows([
      ['Group', p.kind === 'pet' ? `Pet: ${p.group}` : p.group], ['Blood type', p.bloodType === 'unknown' ? '' : p.bloodType], ['Allergies', p.allergies],
      ['Conditions', p.conditions], ['Needs', p.needs], ['Medications', (p.medications || []).map((m) => [m.name, m.dose, m.schedule].filter(Boolean).join(' ')).join('; ')], ['Notes', p.notes],
    ])))),
    section('Contacts', h('table.t', h('thead', h('tr', ['Role', 'Name', 'Phone', 'Radio', 'Address / policy'].map((x) => h('th', x)))),
      h('tbody', cons.map((c) => h('tr', h('td', roleLabel(c.role)), h('td', c.name), h('td', [c.phone, c.altPhone].filter(Boolean).join(' / ')), h('td', c.radio), h('td', [c.address, c.policy].filter(Boolean).join(' · '))))))),
    section('Meeting places and routes',
      rows(MEETING.map(([k, label]) => [label, [placeText(plan.meeting[k], waypoints), plan.meeting[k].notes].filter(Boolean).join(' — ')])),
      ...plan.routes.map((r) => {
        const legs = routeLegs(r, waypoints);
        return h('div.print-block', h('h3', `${r.name} (${legs.km.toFixed(1)} km)`), h('ol', legs.points.map((p) => h('li', p.name))), r.notes ? h('p', r.notes) : null);
      })),
    section('Sheltering, utilities and warnings',
      rows([['Warnings', plan.alerts], ['Shelter room', plan.shelter.room], ['Shelter notes', plan.shelter.notes], ['Documents', plan.documents]]),
      h('table.t', h('thead', h('tr', ['Utility', 'Shut-off', 'How', 'Tool'].map((x) => h('th', x)))),
        h('tbody', plan.utilities.map((u) => h('tr', h('td', u.kind), h('td', u.location), h('td', u.howTo), h('td', u.tool)))))),
    h('p.hint', `Last reviewed: ${plan.reviewedAt || 'never'}.`));
}

function printCard(data) {
  const card = walletCard(data.plan, data.people, data.contacts, data.waypoints);
  const side = (title, ...kids) => h('div.wallet', h('div.wallet-title', title), ...kids);
  printDoc('WALLET CARD',
    h('p.hint', 'Cut along the dashed lines and fold in the middle.'),
    h('div.wallet-pair',
      side('EMERGENCY CONTACTS',
        card.contacts.length ? card.contacts.map((c) => h('div', h('b', c.name), ` (${roleLabel(c.role).toLowerCase()}) ${c.phone}${c.radio ? ' · ' + c.radio : ''}`)) : h('div', 'Mark contacts for the card under Plan, Contacts.'),
        card.meeting.length ? [h('div.wallet-sub', 'MEETING PLACES'), card.meeting.map((m) => h('div', h('b', m.label.toLowerCase()), ': ', m.where))] : null),
      side('MEDICAL',
        card.people.filter((p) => p.kind !== 'pet').map((p) => h('div', h('b', p.name), [p.bloodType, p.allergies && `allergies: ${p.allergies}`, p.conditions, p.medications].filter(Boolean).map((x) => ` · ${x}`))),
        card.people.some((p) => p.kind === 'pet') ? [h('div.wallet-sub', 'PETS'), card.people.filter((p) => p.kind === 'pet').map((p) => h('div', h('b', p.name), p.medications ? ` · ${p.medications}` : ''))] : null)));
}

function review(ctx) {
  const { data, body } = ctx;
  const c = completeness(data.plan, data.people, data.contacts);
  const every = h('input', { type: 'number', min: 30, max: 730, value: data.plan.reviewEveryDays });
  let reviewState = 'NEVER REVIEWED';
  if (c.nextReview) reviewState = c.overdue ? `OVERDUE SINCE ${c.nextReview}` : `NEXT REVIEW ${c.nextReview}`;
  body.append(h('div.grid',
    panel('CHECKLIST', `${c.done}/${c.total}`, h('div.pb', h('ul.checklist', c.items.map((x) => h('li', { class: x.done ? 'done' : null },
      h('span.mark', x.done ? '✓' : '·'), x.done ? x.label : h('a', { href: `#/plan/${x.tab}` }, x.label)))),
    h('p.hint', 'Practise the plan with everyone in the household, including how to reach the meeting places, at least once a year.')), 's7'),
    panel('REVIEW', 'REV', h('div.pb',
      kv('LAST REVIEWED', data.plan.reviewedAt || 'NEVER'), kv('STATUS', reviewState, c.overdue ? 'warn' : 'ok'),
      h('form', { style: 'margin-top:10px', onsubmit: async (e) => { e.preventDefault(); if (await savePlan({ reviewEveryDays: +every.value })) ctx.refresh(); } },
        h('div.row', { style: 'flex-wrap:nowrap' }, field('REVIEW EVERY (DAYS)', every), h('button.btn', 'SAVE'))),
      h('div.row', { style: 'margin-top:12px' },
        h('button.btn.primary', { onclick: async () => {
          try { await api('/api/plan/reviewed', { method: 'POST' }); toast('PLAN MARKED REVIEWED'); ctx.refresh(); } catch (error) { toast(error.message, true); }
        } }, 'MARK REVIEWED TODAY')),
      h('div.lbl', { style: 'margin:16px 0 6px' }, 'PAPER COPIES'),
      h('div.row', printButton(() => printPlan(data), 'PRINT PLAN'), printButton(() => printCard(data), 'PRINT WALLET CARD')),
      h('p.hint', `Keep a printed copy with each kit. Today is ${today()}.`)), 's5')));
}
