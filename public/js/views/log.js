// 06 LOG — field notes in Markdown, stored on this node: tags, search, date filter, templates
// (incident report, SITREP, daily check-in, radio log, medical observations) and photo attachments.
import { h, api, toast, viewHeader, panel, isGuest, lockedView, printDoc, printButton, bytes } from '../lib/core.js';
import { notesMarkdown, download, today } from '../lib/export.js';
import { md } from '../lib/md.js';
import { TEMPLATES, template, fromTemplate, parseTags, allTags, filterNotes, appendRow, localTime } from '../lib/logbook.js';

let selected = null;
const filter = { q: '', tag: '', from: '', to: '' }; // kept while the tab stays open

const MAX_IMAGE = 5 * 1024 * 1024;   // the server's limit per image
const MAX_IMAGES = 12;               // per entry
const MAX_SIDE = 2560;               // larger photos are scaled down before upload

const pad2 = (n) => String(n).padStart(2, '0');
/** Date and local time of an ISO timestamp: YYYY-MM-DD HH:MM. */
const when = (iso) => { const d = new Date(iso); return `${d.toISOString().slice(0, 10)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const attachmentUrl = (a) => `/api/attachments/${a.file}`;
const sorted = (items) => [...items].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

/**
 * A photo ready to upload: JPEG and WebP photos, and anything large, are redrawn as a JPEG of at
 * most MAX_SIDE pixels, which also drops embedded metadata such as the GPS position.
 */
async function prepareImage(file) {
  const redraw = file.type === 'image/jpeg' || file.type === 'image/webp' || (file.size > 1.5 * 1024 * 1024 && file.type !== 'image/gif');
  if (!redraw) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise((ok) => { canvas.toBlob(ok, 'image/jpeg', 0.85); });
    return blob && blob.size < file.size * 1.2 ? blob : file;
  } catch {
    return file; // the server decides whether it is an image it accepts
  }
}

const dataUrl = (blob) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => fail(new Error('could not read the file'));
  r.readAsDataURL(blob);
});

async function upload(file) {
  const blob = await prepareImage(file);
  if (blob.size > MAX_IMAGE) throw new Error(`${file.name}: larger than 5 MB`);
  return api('/api/attachments', { method: 'POST', body: { name: file.name, data: await dataUrl(blob) } });
}

function gallery(list, onRemove) {
  if (!list.length) return null;
  return h('div.log-gallery', list.map((a) => h('figure.log-thumb',
    h('a', { href: attachmentUrl(a), target: '_blank', rel: 'noopener', title: a.name }, h('img', { src: attachmentUrl(a), alt: a.name, loading: 'lazy' })),
    h('figcaption', h('span', a.name), h('span.hint', bytes(a.size)),
      onRemove ? h('button.btn.ghost.danger', { type: 'button', onclick: () => onRemove(a) }, 'REMOVE') : null))));
}

/** The quick-add form for an entry made from a template with a table (radio log, medical observations). */
function rowForm(columns, onAdd) {
  const inputs = Object.fromEntries(columns.map((c) => [c.key, h('input', { placeholder: c.label.toUpperCase(), 'aria-label': c.label })]));
  return h('form.log-rowform', {
    onsubmit: (e) => {
      e.preventDefault();
      const values = Object.fromEntries(columns.map((c) => [c.key, inputs[c.key].value.trim()]));
      if (!Object.entries(values).some(([k, v]) => k !== 'time' && v)) return;
      values.time ||= localTime();
      onAdd(values);
      // A radio operator usually stays on one frequency: keep it for the next row.
      for (const c of columns) if (c.key !== 'freq') inputs[c.key].value = '';
      inputs[columns[1].key].focus();
    },
  }, h('div.log-rowform-fields', columns.map((c) => inputs[c.key])), h('button.btn', 'ADD ROW'));
}

export async function render(root, _arg, { code } = {}) {
  if (isGuest()) { root.append(...lockedView(code, 'LOG')); return; }
  let notes = await api('/api/db/notes');
  const list = h('div.list.list-scroll');
  const editor = h('div');
  const count = h('span.code');
  let timer = null, dirty = false, current = null, titleEl, bodyEl, tagsEl, stamp;

  // ----- filters -----
  const q = h('input', { type: 'search', placeholder: 'SEARCH', value: filter.q, 'aria-label': 'Search the log' });
  const tagSel = h('select', { 'aria-label': 'Tag' });
  const from = h('input', { type: 'date', value: filter.from, 'aria-label': 'From date', title: 'From' });
  const to = h('input', { type: 'date', value: filter.to, 'aria-label': 'To date', title: 'To' });
  const reset = h('button.btn.ghost', { type: 'button' }, 'CLEAR');

  function paintTags() {
    const tags = allTags(notes);
    if (filter.tag && !tags.some(([t]) => t === filter.tag)) tags.push([filter.tag, 0]);
    tagSel.replaceChildren(h('option', { value: '' }, 'ALL TAGS'), ...tags.map(([t, n]) => h('option', { value: t }, `${t.toUpperCase()} (${n})`)));
    tagSel.value = filter.tag;
  }

  function paintList() {
    const shown = sorted(filterNotes(notes, filter));
    count.textContent = shown.length === notes.length ? `${notes.length}` : `${shown.length} / ${notes.length}`;
    let items = [h('div.empty', notes.length ? 'NO MATCHING ENTRIES' : 'NO ENTRIES')];
    if (shown.length) {
      items = shown.map((n) => h('button.item', { class: n.id === selected ? 'active' : null, onclick: () => open(n.id) },
        h('div.t1', n.title || 'UNTITLED'),
        h('div.t2', when(n.updated),
          (n.tags || []).slice(0, 4).map((t) => [' ', h('span.tag', t)]),
          n.attachments?.length ? [' ', h('span.tag.acc', `IMG ${n.attachments.length}`)] : null)));
    }
    list.replaceChildren(...items);
  }

  const refilter = () => {
    Object.assign(filter, { q: q.value.trim(), tag: tagSel.value, from: from.value, to: to.value });
    paintList();
  };
  q.addEventListener('input', refilter);
  for (const el of [tagSel, from, to]) el.addEventListener('change', refilter);
  reset.addEventListener('click', () => { q.value = ''; tagSel.value = ''; from.value = ''; to.value = ''; refilter(); });

  const replaceNote = (saved) => { notes = notes.map((n) => (n.id === saved.id ? saved : n)); };

  async function save() {
    clearTimeout(timer);
    if (!dirty || !current) return;
    dirty = false;
    const id = current.id;
    try {
      const savedNote = await api(`/api/db/notes/${id}`, { method: 'PUT', body: { title: titleEl.value.trim(), body: bodyEl.value, tags: parseTags(tagsEl.value) } });
      replaceNote(savedNote);
      if (current?.id === id) { current = savedNote; stamp.textContent = `SAVED ${when(savedNote.updated)}`; }
      paintTags();
      paintList();
    } catch (error) { dirty = true; toast(error.message, true); }
  }
  const touch = () => { dirty = true; stamp.textContent = 'UNSAVED'; clearTimeout(timer); timer = setTimeout(save, 900); };

  /** Saves a new attachment list for the open entry; the server deletes files no entry uses any more. */
  async function setAttachments(next) {
    await save();
    const id = current.id;
    const savedNote = await api(`/api/db/notes/${id}`, { method: 'PUT', body: { attachments: next } });
    replaceNote(savedNote);
    paintList();
    if (current?.id === id) await open(id);
  }

  async function attach(files) {
    const room = MAX_IMAGES - (current.attachments?.length || 0);
    if (room <= 0) { toast(`an entry holds at most ${MAX_IMAGES} images`, true); return; }
    const added = [];
    for (const file of [...files].slice(0, room)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one upload at a time keeps a phone's memory use low
        added.push(await upload(file));
      } catch (error) { toast(error.message, true); }
    }
    if (files.length > room) toast(`only ${room} more image(s) fit in this entry`, true);
    if (added.length) {
      try { await setAttachments([...(current.attachments || []), ...added]); toast(added.length === 1 ? 'IMAGE ATTACHED' : `${added.length} IMAGES ATTACHED`); } catch (error) { toast(error.message, true); }
    }
  }

  async function removeAttachment(a) {
    if (!confirm(`Remove the image "${a.name}" from this entry? The file is deleted.`)) return;
    try { await setAttachments((current.attachments || []).filter((x) => x.file !== a.file)); } catch (error) { toast(error.message, true); }
  }

  async function open(id) {
    await save();
    selected = id;
    current = notes.find((n) => n.id === id) || null;
    paintList();
    if (!current) { editor.replaceChildren(panel('ENTRY', 'LOG', h('div.empty', 'SELECT OR CREATE AN ENTRY'))); return; }
    titleEl = h('input', { value: current.title || '', placeholder: 'TITLE', maxlength: 120, oninput: touch, style: 'font-size:14px' });
    tagsEl = h('input', { value: (current.tags || []).join(', '), placeholder: 'TAGS, SEPARATED BY COMMAS', oninput: touch, 'aria-label': 'Tags' });
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
    const tpl = template(current.template);
    const quick = tpl?.columns ? rowForm(tpl.columns, (values) => {
      bodyEl.value = appendRow(bodyEl.value, tpl.columns, values);
      if (showing) preview.innerHTML = md(bodyEl.value);
      touch();
    }) : null;
    const picker = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true, hidden: true, onchange: () => { const files = [...picker.files]; picker.value = ''; return attach(files); } });
    const images = current.attachments || [];
    const printImages = () => images.map((a) => h('figure.log-print-img', h('img', { src: attachmentUrl(a), alt: a.name }), h('figcaption', a.name)));
    editor.replaceChildren(h('section.panel',
      h('div.ph', h('span', tpl ? `ENTRY · ${tpl.label}` : 'ENTRY'), stamp),
      h('div.pb', h('div', { style: 'margin-bottom:10px' }, titleEl), h('div', { style: 'margin-bottom:10px' }, tagsEl),
        quick, bodyEl, preview,
        h('div.log-attach',
          h('div.row', h('span.hint', `IMAGES ${images.length} / ${MAX_IMAGES}`),
            h('button.btn', { type: 'button', onclick: () => picker.click(), disabled: images.length >= MAX_IMAGES }, 'ATTACH PHOTO'), picker),
          gallery(images, removeAttachment)),
        h('div.row', { style: 'margin-top:10px;justify-content:space-between' },
          h('div.row', toggle, h('button.btn', { onclick: save }, 'SAVE'),
            printButton(() => printDoc(`LOG: ${(titleEl.value || 'UNTITLED').toUpperCase()}`, h('div.prose', { html: md(bodyEl.value || '*Empty entry.*') }), printImages()))),
          h('button.btn.danger', { onclick: async () => {
            if (!confirm(`Delete "${doomed.title || 'UNTITLED'}"${doomed.attachments?.length ? ' and its images' : ''}? This cannot be undone.`)) return;
            clearTimeout(timer); dirty = false;
            try {
              await api(`/api/db/notes/${doomed.id}`, { method: 'DELETE' });
              notes = notes.filter((n) => n.id !== doomed.id);
              paintTags();
              await open(null);
            } catch (error) { toast(error.message, true); }
          } }, 'DELETE')))));
  }

  async function create(templateId = '') {
    try {
      const n = await api('/api/db/notes', { method: 'POST', body: fromTemplate(templateId) });
      notes = [...notes, n];
      paintTags();
      await open(n.id);
      bodyEl?.focus();
    } catch (error) { toast(error.message, true); }
  }

  const templates = h('select', { 'aria-label': 'New entry from a template', onchange: () => { const id = templates.value; templates.value = ''; if (id) return create(id); } },
    h('option', { value: '' }, 'NEW FROM TEMPLATE…'), TEMPLATES.map((t) => h('option', { value: t.id }, t.label)));

  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    return save();
  };
  window.addEventListener('keydown', onKey);

  const filters = h('div.pb.log-filter',
    q, h('div.row', tagSel, reset), h('div.row.log-dates', h('label.f', h('span', 'FROM'), from), h('label.f', h('span', 'TO'), to)));
  const entries = h('section.panel', h('div.ph', h('span', 'ENTRIES'), count), filters, list);

  root.append(
    viewHeader(code, 'LOG', 'Field notes, reports and records, with photos. Saved automatically to this node.',
      h('button.btn.ghost', { onclick: async () => { await save(); download(`shelter-log-${today()}.md`, notesMarkdown(notes), 'text/markdown'); } }, 'EXPORT MARKDOWN'),
      templates,
      h('button.btn.primary', { onclick: () => create() }, 'NEW ENTRY')),
    h('div.split', h('div.sticky', entries), editor));
  paintTags();
  await open(notes.some((n) => n.id === selected) ? selected : sorted(filterNotes(notes, filter))[0]?.id ?? null);
  return () => { window.removeEventListener('keydown', onKey); return save(); };
}
