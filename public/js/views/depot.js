// 08 DEPOT — deploy and control containerized services through Docker, and fetch their content.
import { h, api, toast, viewHeader, bytes } from '../lib/core.js';
import { contentManager } from './parts/content.js';

const CONTENT = 'CONTENT';

let filter = 'ALL';

function statusTag(s) {
  if (s.job?.state === 'working') return h('span.tag.acc', s.job.message);
  if (s.container?.state === 'running') return h('span.tag.ok', 'RUNNING');
  if (s.container) return h('span.tag', s.container.state);
  return h('span.tag', 'NOT DEPLOYED');
}

/** OPEN + STOP for a running service, else START (or DEPLOY the first time); REMOVE once a container exists. */
function controls(s, off, act) {
  const start = h('button.btn.primary', { disabled: off, onclick: () => act(s.id, 'start') }, s.container ? 'START' : 'DEPLOY');
  const main = s.container?.state === 'running'
    ? [h('a.btn.primary', { href: `http://${location.hostname}:${s.port}`, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, 'OPEN'),
      h('button.btn', { disabled: off, onclick: () => act(s.id, 'stop') }, 'STOP')]
    : start;
  const remove = () => {
    if (confirm(`Remove the ${s.name} container? Its data folder is kept.`)) return act(s.id, 'remove');
  };
  return h('div.row', main,
    s.container ? h('button.btn.danger', { disabled: off, title: 'Removes the container. Data on disk is kept.', onclick: remove }, 'REMOVE') : null);
}

function card(s, d, act) {
  const { docker, canAdmin } = d;
  const off = !docker.online || !canAdmin || s.job?.state === 'working';
  const used = d.usage?.[s.id];
  return h('section.panel.s4.col', h('div.ph', h('span', s.title.toUpperCase()), statusTag(s)),
    h('div.pb.svc',
      h('h3', s.name), h('div.sub', `${s.category} // PORT ${s.port}${s.custom ? ' // CUSTOM' : ''}`),
      h('p', s.desc),
      s.note ? h('p', { style: 'font-size:12px' }, s.note) : null,
      s.links.length ? h('div.links', h('span.hint', 'SOURCES'),
        s.links.map((l) => h('a.tag', { href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.label))) : null,
      h('div.meta', s.image, s.dataDir ? h('div', `DATA  ${s.dataDir}`) : null, used ? h('div', `DISK  ${bytes(used)}`) : null),
      s.job?.state === 'error' ? h('div.banner', h('b', 'FAULT'), s.job.message) : null,
      controls(s, off, act)));
}

/** Services under a tab: ALL, ACTIVE (has a container) or one category. */
function servicesIn(services, tab) {
  if (tab === 'ALL') return services;
  if (tab === 'ACTIVE') return services.filter((s) => s.container);
  return services.filter((s) => s.category === tab);
}

function bannerFor(d) {
  if (!d.docker.online) return h('div.banner', h('b', 'DOCKER OFFLINE'), 'The Docker engine is not running on this node. Start Docker to deploy services. Everything else in Shelter works without it.');
  if (!d.canAdmin) return h('div.banner', h('b', 'READ ONLY'), 'Services can only be deployed or stopped from the host machine itself.');
  return null;
}

export async function render(root, _arg, { code } = {}) {
  const banner = h('div'), tabs = h('div.tabs', { role: 'tablist' }), grid = h('div.grid'), tally = h('span.hint');
  const contentHost = h('div.ct-host');
  let alive = true, timer = null, last = null, manager = null;

  /** Shows the content manager on the CONTENT tab and the service grid on the others. */
  function showContent(on) {
    grid.hidden = on;
    contentHost.hidden = !on;
    if (on && !manager) { manager = contentManager(contentHost, { canAdmin: !!last?.canAdmin }); manager.load().catch(() => {}); }
    if (!on && manager) { manager.stop(); manager = null; contentHost.replaceChildren(); }
  }

  async function act(id, action) {
    try { await api(`/api/depot/${id}/${action}`, { method: 'POST' }); } catch (error) { toast(error.message, true); }
    await load();
  }

  function paint() {
    const d = last;
    if (!d) return;
    const cats = [...new Set(d.services.map((s) => s.category))];
    if (![CONTENT, 'ALL', 'ACTIVE', ...cats].includes(filter)) filter = 'ALL';
    tabs.replaceChildren(...['ALL', 'ACTIVE', ...cats].map((c) =>
      h('button', { role: 'tab', class: c === filter ? 'active' : null, onclick: () => { filter = c; paint(); } }, `${c} ${servicesIn(d.services, c).length}`)),
    h('button', { role: 'tab', class: filter === CONTENT ? 'active' : null, title: 'Download ZIM archives, Kolibri channels and Ollama models', onclick: () => { filter = CONTENT; paint(); } }, CONTENT));
    showContent(filter === CONTENT);
    const shown = filter === CONTENT ? [] : servicesIn(d.services, filter);
    grid.replaceChildren(...(shown.length ? shown.map((s) => card(s, d, act))
      : [h('div.s12.empty', filter === 'ACTIVE' ? 'NOTHING DEPLOYED YET' : 'NO SERVICES')]));
    const deployed = servicesIn(d.services, 'ACTIVE').length;
    const running = d.services.filter((s) => s.container?.state === 'running').length;
    tally.textContent = `${d.services.length} AVAILABLE // ${deployed} DEPLOYED // ${running} RUNNING`;
  }

  async function load() {
    if (!alive) return;
    try {
      const d = await api('/api/depot');
      if (!alive) return;
      last = d;
      banner.replaceChildren(...[bannerFor(d)].filter(Boolean));
      paint();
    } catch (error) {
      banner.replaceChildren(h('div.banner', h('b', 'FAULT'), error.message));
    }
    clearTimeout(timer);
    timer = setTimeout(load, 4000);
  }

  root.append(
    viewHeader(code, 'DEPOT', 'Optional heavy services, each in its own container. Images download once, then run offline.', tally),
    banner, tabs, grid, contentHost,
    h('p.hint', { style: 'margin-top:12px' }, 'First deployment pulls the image and needs a link, as do the SOURCES links and the CONTENT tab: fetch content while you have one. Add your own services in config/depot.custom.json (same format as config/depot.json), and your own downloads in config/content.custom.json (same format as config/content.json), then restart the node.'));
  await load();
  return () => { alive = false; clearTimeout(timer); manager?.stop(); };
}
