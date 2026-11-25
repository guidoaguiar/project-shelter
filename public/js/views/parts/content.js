// Depot content manager: browse the curated catalog (config/content.json), download with progress,
// resume, cancel and delete, with free disk space and per-service usage. Used by the Depot view.
import { h, api, toast, bytes } from '../../lib/core.js';

/** 'nofit' | 'tight' | 'ok' for downloading need more bytes, as the server will judge it. */
export function fitState(need, d) {
  if (!d.disk || !Number.isFinite(need)) return 'ok';
  const free = d.disk.free - (d.pending || 0);
  if (need > free) return 'nofit';
  return need > free - d.reserve ? 'tight' : 'ok';
}

function sizeText(it) {
  if (it.size == null) return 'SIZE UNKNOWN';
  return (it.approx ? '≈ ' : '') + bytes(it.size);
}
const running = (it) => it.job?.state === 'running';

function jobText(job) {
  if (job.state === 'done') return job.verified ? 'DONE · CHECKSUM OK' : 'DONE';
  if (job.state !== 'running') return `${job.state.toUpperCase()}: ${String(job.error || '').toUpperCase()}`;
  if (job.phase === 'verifying') return `VERIFYING ${bytes(job.checked || 0)} / ${bytes(job.total)}`;
  const of = job.total ? ' / ' + bytes(job.total) : '';
  return `${job.phase.toUpperCase()} · ${bytes(job.bytes)}${of}`;
}

function jobMeter(job) {
  const done = job.phase === 'verifying' ? job.checked || 0 : job.bytes;
  const pct = job.total ? Math.min(100, (done / job.total) * 100) : 0;
  return h('div.meter.ct-meter',
    h('div.row', h('span', job.phase === 'verifying' ? 'SHA-256' : 'TRANSFER'), h('b', jobText(job))),
    h('div.track', h('div.fill' + (job.state === 'error' ? '.hot' : ''), { style: `width:${job.state === 'done' ? 100 : pct}%` })),
    job.note && job.state === 'done' ? h('div.hint', job.note) : null);
}

/** What the item has on this node: installed, a partial download, or nothing. */
function stateTag(it) {
  if (it.installed) return h('span.tag.ok', it.installedSize ? `INSTALLED · ${bytes(it.installedSize)}` : 'INSTALLED');
  if (it.partial) return h('span.tag.acc', `PARTIAL · ${bytes(it.partial)}`);
  return null;
}

function fitTag(it, d) {
  if (it.installed || running(it)) return null;
  const f = fitState((it.size ?? 0) - (it.partial || 0), d);
  if (f === 'nofit') return h('span.tag.bad', "WON'T FIT");
  if (f === 'tight') return h('span.tag.warn', 'LOW SPACE');
  return null;
}

/** DOWNLOAD / RESUME / CANCEL / DELETE for one item. */
function itemButtons(src, it, d, act) {
  const off = !d.canAdmin;
  if (running(it)) return h('button.btn.sm', { type: 'button', disabled: off, onclick: () => act.cancel(src, it) }, 'CANCEL');
  if (it.installed) return h('button.btn.sm.danger', { type: 'button', disabled: off, onclick: () => act.remove(src, it) }, 'DELETE');
  const del = it.partial ? h('button.btn.sm.danger', { type: 'button', disabled: off, onclick: () => act.remove(src, it) }, 'DISCARD') : null;
  const need = (it.size ?? 0) - (it.partial || 0);
  const nofit = fitState(need, d) === 'nofit';
  const label = it.partial ? 'RESUME' : 'DOWNLOAD';
  return [h('button.btn.sm.primary', { type: 'button', disabled: off || nofit || (src.kind !== 'file' && !src.reachable), title: nofit ? 'Not enough free disk space' : null, onclick: () => act.download(src, it, need) }, label), del];
}

function itemRow(src, it, d, act) {
  return h('div.ct-item',
    h('div.ct-main',
      h('div.ct-title', it.title, it.custom ? h('span.tag', 'CUSTOM') : null),
      h('div.ct-sub', [it.category, it.lang?.toUpperCase(), sizeText(it)].filter(Boolean).join(' // ')),
      it.desc ? h('div.ct-desc', it.desc) : null,
      it.job ? jobMeter(it.job) : null),
    h('div.ct-side', h('div.row', stateTag(it), fitTag(it, d)), h('div.row', itemButtons(src, it, d, act))));
}

function sourceStatus(src) {
  if (src.kind === 'file') return h('span.tag', src.ext.toUpperCase());
  if (src.reachable) return h('span.tag.ok', `${src.serviceName} ONLINE`);
  return h('span.tag', `${src.serviceName} NOT RUNNING`);
}

/** Files of a source's type in its folder that the catalog does not list (added by hand, or older builds). */
function localFiles(src, d, act) {
  const extra = (src.local || []).filter((f) => !f.inCatalog);
  if (!extra.length) return null;
  return h('div.ct-local', h('div.hint', 'OTHER FILES IN THIS FOLDER'),
    extra.map((f) => h('div.ct-item',
      h('div.ct-main', h('div.ct-title', f.file), h('div.ct-sub', bytes(f.size))),
      h('div.ct-side', h('button.btn.sm.danger', { type: 'button', disabled: !d.canAdmin, onclick: () => act.removeFile(src, f.file) }, 'DELETE')))));
}

const matches = (it, q) => !q || `${it.title} ${it.desc} ${it.category} ${it.lang}`.toLowerCase().includes(q);

function sourcePanel(src, d, view, act) {
  const items = src.items.filter((it) => matches(it, view.q) && (!view.installedOnly || it.installed || it.partial || it.job));
  const used = d.usage?.[src.service];
  return h('section.panel.s12',
    h('div.ph', h('span', src.title.toUpperCase()), sourceStatus(src)),
    h('div.pb',
      src.desc ? h('p', src.desc) : null,
      h('div.ct-sub', [src.dir ? `FOLDER  ${src.dir}` : null, used ? `USES ${bytes(used)}` : null].filter(Boolean).join(' // ')),
      src.note ? h('p.hint', src.note) : null,
      items.length ? items.map((it) => itemRow(src, it, d, act)) : h('div.empty', 'NOTHING MATCHES'),
      localFiles(src, d, act)));
}

function diskMeter(disk, reserve) {
  if (!disk) return h('p.hint', 'Free disk space is not available on this system.');
  const fill = disk.free < reserve ? 'div.fill.hot' : 'div.fill';
  return h('div.meter', h('div.row', h('span', 'DISK'), h('b', `${bytes(disk.free)} FREE OF ${bytes(disk.total)}`)),
    h('div.track', h(fill, { style: `width:${Math.min(100, (1 - disk.free / disk.total) * 100)}%` })));
}

function storagePanel(d) {
  const meter = diskMeter(d.disk, d.reserve);
  const rows = Object.entries(d.usage || {}).sort((a, b) => b[1] - a[1])
    .map(([id, n]) => h('div.kv', h('span.k', id.toUpperCase()), h('span.v', bytes(n))));
  return h('section.panel.s12',
    h('div.ph', h('span', 'STORAGE'), h('span.code', 'DEPOT')),
    h('div.pb',
      meter,
      d.pending ? h('div.ct-sub', `${bytes(d.pending)} STILL TO DOWNLOAD`) : null,
      rows.length ? h('div.ct-usage', rows) : h('p.hint', 'No service data on disk yet.'),
      h('p.hint', `Downloads that would leave less than ${bytes(d.reserve)} free ask for confirmation; ones that do not fit are refused.`)));
}

/** Renders the content manager into host; returns { load, stop, setAdmin }. */
export function contentManager(host, { canAdmin = false } = {}) {
  const view = { q: '', installedOnly: false };
  let last = null, timer = null, alive = true;
  const grid = h('div.grid');
  const toolbar = h('div.row.ct-tools',
    h('input', { type: 'search', placeholder: 'FILTER CONTENT', 'aria-label': 'Filter content', oninput: (e) => { view.q = e.target.value.trim().toLowerCase(); paint(); } }),
    h('label.row', h('input', { type: 'checkbox', onchange: (e) => { view.installedOnly = e.target.checked; paint(); } }), h('span.hint', 'ON THIS NODE ONLY')));

  async function call(path, body, okText) {
    try {
      await api(path, { method: 'POST', body });
      if (okText) toast(okText);
    } catch (error) { toast(error.message, true); }
    await load();
  }

  const act = {
    download(src, it, need) {
      const d = last;
      if (fitState(need, d) === 'tight' && !confirm(`${it.title} needs ${bytes(need)}. That leaves less than ${bytes(d.reserve)} free on this disk. Download anyway?`)) return;
      return call('/api/depot/content/download', { source: src.id, item: it.id, force: fitState(need, d) === 'tight' }, 'DOWNLOAD STARTED');
    },
    cancel(src, it) { return call('/api/depot/content/cancel', { source: src.id, item: it.id }); },
    remove(src, it) {
      if (confirm(`Delete ${it.title} from this node?`)) return call('/api/depot/content/delete', { source: src.id, item: it.id }, 'DELETED');
    },
    removeFile(src, file) {
      if (confirm(`Delete ${file} from this node?`)) return call('/api/depot/content/delete', { source: src.id, file }, 'DELETED');
    },
  };

  function paint() {
    if (!last) return;
    const d = { ...last, canAdmin: canAdmin && last.canAdmin };
    grid.replaceChildren(storagePanel(d), ...d.sources.map((src) => sourcePanel(src, d, view, act)));
  }
  host.replaceChildren(toolbar, grid);

  async function load() {
    if (!alive) return;
    clearTimeout(timer);
    try {
      last = await api('/api/depot/content');
      if (!alive) return;
      paint();
    } catch (error) {
      grid.replaceChildren(h('div.s12.banner', h('b', 'FAULT'), error.message));
    }
    const busy = last?.jobs?.some((j) => j.state === 'running');
    timer = setTimeout(load, busy ? 1500 : 6000);
  }

  return { load, stop: () => { alive = false; clearTimeout(timer); } };
}
