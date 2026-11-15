// 06 LOG — field notes in Markdown, stored on this node.
import { h, api, toast, viewHeader, panel } from '../lib/core.js';
import { md } from '../lib/md.js';

let selected = null;

export async function render(root) {
  let notes = await api('/api/db/notes');
  const list = h('div.list.list-scroll');
  const editor = h('div');
  let timer = null, dirty = false, current = null, titleEl, bodyEl, stamp;

  const sorted = () => [...notes].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const when = (iso) => { const d = new Date(iso); return `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  function paintList() {
    list.replaceChildren(...(notes.length ? sorted().map((n) => h('button.item', { class: n.id === selected ? 'active' : null, onclick: () => open(n.id) },
      h('div.t1', n.title || 'UNTITLED'), h('div.t2', when(n.updated)))) : [h('div.empty', 'NO ENTRIES')]));
  }

  async function save() {
    clearTimeout(timer);
    if (!dirty || !current) return;
    dirty = false;
    const id = current.id;
    try {
      const savedNote = await api(`/api/db/notes/${id}`, { method: 'PUT', body: { title: titleEl.value.trim(), body: bodyEl.value } });
      notes = notes.map((n) => (n.id === id ? savedNote : n));
      if (current?.id === id) { current = savedNote; stamp.textContent = `SAVED ${when(savedNote.updated)}`; }
      paintList();
    } catch (e) { dirty = true; toast(e.message, true); }
  }
  const touch = () => { dirty = true; stamp.textContent = 'UNSAVED'; clearTimeout(timer); timer = setTimeout(save, 900); };

  async function open(id) {
    await save();
    selected = id;
    current = notes.find((n) => n.id === id) || null;
    paintList();
    if (!current) { editor.replaceChildren(panel('ENTRY', 'LOG', h('div.empty', 'SELECT OR CREATE AN ENTRY'))); return; }
    titleEl = h('input', { value: current.title || '', placeholder: 'TITLE', maxlength: 120, oninput: touch, style: 'font-size:14px' });
    bodyEl = h('textarea', { rows: 18, placeholder: 'Write in Markdown: ## headings, - lists, **bold**, | tables |', oninput: touch, style: 'font-family:var(--sans);font-size:14px' }, current.body || '');
    stamp = h('span.code', `SAVED ${when(current.updated)}`);
    const preview = h('div.prose');
    const toggle = h('button.btn', 'PREVIEW');
    let showing = false;
    toggle.addEventListener('click', () => {
      showing = !showing;
      toggle.textContent = showing ? 'EDIT' : 'PREVIEW';
      if (showing) preview.innerHTML = md(bodyEl.value || '*Empty entry.*');
      bodyEl.hidden = showing; preview.hidden = !showing;
    });
    preview.hidden = true;
    const doomed = current;
    editor.replaceChildren(h('section.panel',
      h('div.ph', h('span', 'ENTRY'), stamp),
      h('div.pb', h('div', { style: 'margin-bottom:10px' }, titleEl), bodyEl, preview,
        h('div.row', { style: 'margin-top:10px;justify-content:space-between' },
          h('div.row', toggle, h('button.btn', { onclick: save }, 'SAVE')),
          h('button.btn.danger', { onclick: async () => {
            if (!confirm(`Delete "${doomed.title || 'UNTITLED'}"? This cannot be undone.`)) return;
            clearTimeout(timer); dirty = false;
            try { await api(`/api/db/notes/${doomed.id}`, { method: 'DELETE' }); notes = notes.filter((n) => n.id !== doomed.id); open(null); } catch (e) { toast(e.message, true); }
          } }, 'DELETE')))));
  }

  async function create() {
    try {
      const d = new Date();
      const n = await api('/api/db/notes', { method: 'POST', body: { title: `LOG ${d.toISOString().slice(0, 10)}`, body: '' } });
      notes = [...notes, n];
      await open(n.id);
      bodyEl?.focus();
    } catch (e) { toast(e.message, true); }
  }

  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
  window.addEventListener('keydown', onKey);

  root.append(
    viewHeader('06', 'LOG', 'Field notes, plans and records. Saved automatically to this node.', h('button.btn.primary', { onclick: create }, 'NEW ENTRY')),
    h('div.split', h('div.sticky', panel('ENTRIES', 'LOG', list)), editor));
  await open(notes.some((n) => n.id === selected) ? selected : sorted()[0]?.id ?? null);
  return () => { window.removeEventListener('keydown', onKey); save(); };
}
