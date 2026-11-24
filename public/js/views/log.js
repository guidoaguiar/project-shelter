// 06 LOG — field notes in Markdown, stored on this node.
import { h, api, toast, viewHeader, panel, isGuest, lockedView, printDoc, printButton } from '../lib/core.js';
import { notesMarkdown, download, today } from '../lib/export.js';
import { md } from '../lib/md.js';

let selected = null;

const pad2 = (n) => String(n).padStart(2, '0');
/** Date and local time of an ISO timestamp: YYYY-MM-DD HH:MM. */
const when = (iso) => { const d = new Date(iso); return `${d.toISOString().slice(0, 10)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

export async function render(root, _arg, { code } = {}) {
  if (isGuest()) { root.append(...lockedView(code, 'LOG')); return; }
  let notes = await api('/api/db/notes');
  const list = h('div.list.list-scroll');
  const editor = h('div');
  let timer = null, dirty = false, current = null, titleEl, bodyEl, stamp;

  const sorted = () => [...notes].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

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
    } catch (error) { dirty = true; toast(error.message, true); }
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
          h('div.row', toggle, h('button.btn', { onclick: save }, 'SAVE'),
            printButton(() => printDoc(`LOG: ${(titleEl.value || 'UNTITLED').toUpperCase()}`, h('div.prose', { html: md(bodyEl.value || '*Empty entry.*') })))),
          h('button.btn.danger', { onclick: async () => {
            if (!confirm(`Delete "${doomed.title || 'UNTITLED'}"? This cannot be undone.`)) return;
            clearTimeout(timer); dirty = false;
            try { await api(`/api/db/notes/${doomed.id}`, { method: 'DELETE' }); notes = notes.filter((n) => n.id !== doomed.id); await open(null); } catch (error) { toast(error.message, true); }
          } }, 'DELETE')))));
  }

  async function create() {
    try {
      const d = new Date();
      const n = await api('/api/db/notes', { method: 'POST', body: { title: `LOG ${d.toISOString().slice(0, 10)}`, body: '' } });
      notes = [...notes, n];
      await open(n.id);
      bodyEl?.focus();
    } catch (error) { toast(error.message, true); }
  }

  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    return save();
  };
  window.addEventListener('keydown', onKey);

  root.append(
    viewHeader(code, 'LOG', 'Field notes, plans and records. Saved automatically to this node.',
      h('button.btn.ghost', { onclick: async () => { await save(); download(`shelter-log-${today()}.md`, notesMarkdown(notes), 'text/markdown'); } }, 'EXPORT MARKDOWN'),
      h('button.btn.primary', { onclick: create }, 'NEW ENTRY')),
    h('div.split', h('div.sticky', panel('ENTRIES', 'LOG', list)), editor));
  await open(notes.some((n) => n.id === selected) ? selected : sorted()[0]?.id ?? null);
  return () => { window.removeEventListener('keydown', onKey); return save(); };
}
