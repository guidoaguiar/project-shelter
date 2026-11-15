// 08 DEPOT — deploy and control containerized services through Docker.
import { h, api, toast, viewHeader } from '../lib/core.js';

let filter = 'ALL';

export async function render(root) {
  const banner = h('div'), tabs = h('div.tabs', { role: 'tablist' }), grid = h('div.grid'), tally = h('span.hint');
  let alive = true, timer = null, last = null;

  async function act(id, action) {
    try { await api(`/api/depot/${id}/${action}`, { method: 'POST' }); } catch (e) { toast(e.message, true); }
    await load();
  }

  function card(s, docker, canAdmin) {
    const running = s.container?.state === 'running';
    const working = s.job?.state === 'working';
    const status = working ? h('span.tag.acc', s.job.message)
      : running ? h('span.tag.ok', 'RUNNING')
      : s.container ? h('span.tag', s.container.state)
      : h('span.tag', 'NOT DEPLOYED');
    const url = `http://${location.hostname}:${s.port}`;
    const off = !docker.online || !canAdmin || working;
    return h('section.panel.s4.col', h('div.ph', h('span', s.title.toUpperCase()), status),
      h('div.pb.svc',
        h('h3', s.name), h('div.sub', `${s.category} // PORT ${s.port}${s.custom ? ' // CUSTOM' : ''}`),
        h('p', s.desc),
        s.note ? h('p', { style: 'font-size:12px' }, s.note) : null,
        s.links.length ? h('div.links', h('span.hint', 'SOURCES'),
          s.links.map((l) => h('a.tag', { href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.label))) : null,
        h('div.meta', s.image, s.dataDir ? h('div', `DATA  ${s.dataDir}`) : null),
        s.job?.state === 'error' ? h('div.banner', h('b', 'FAULT'), s.job.message) : null,
        h('div.row',
          running
            ? [h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, 'OPEN'),
              h('button.btn', { disabled: off, onclick: () => act(s.id, 'stop') }, 'STOP')]
            : h('button.btn.primary', { disabled: off, onclick: () => act(s.id, 'start') }, s.container ? 'START' : 'DEPLOY'),
          s.container ? h('button.btn.danger', { disabled: off, title: 'Removes the container. Data on disk is kept.', onclick: () => { if (confirm(`Remove the ${s.name} container? Its data folder is kept.`)) act(s.id, 'remove'); } }, 'REMOVE') : null)));
  }

  function paint() {
    const d = last;
    if (!d) return;
    const cats = [...new Set(d.services.map((s) => s.category))];
    if (filter !== 'ALL' && filter !== 'ACTIVE' && !cats.includes(filter)) filter = 'ALL';
    const active = d.services.filter((s) => s.container);
    const count = (c) => (c === 'ALL' ? d.services.length : c === 'ACTIVE' ? active.length : d.services.filter((s) => s.category === c).length);
    tabs.replaceChildren(...['ALL', 'ACTIVE', ...cats].map((c) =>
      h('button', { role: 'tab', class: c === filter ? 'active' : null, onclick: () => { filter = c; paint(); } }, `${c} ${count(c)}`)));
    const shown = filter === 'ALL' ? d.services : filter === 'ACTIVE' ? active : d.services.filter((s) => s.category === filter);
    grid.replaceChildren(...(shown.length ? shown.map((s) => card(s, d.docker, d.canAdmin))
      : [h('div.s12.empty', filter === 'ACTIVE' ? 'NOTHING DEPLOYED YET' : 'NO SERVICES')]));
    const running = d.services.filter((s) => s.container?.state === 'running').length;
    tally.textContent = `${d.services.length} AVAILABLE // ${active.length} DEPLOYED // ${running} RUNNING`;
  }

  async function load() {
    if (!alive) return;
    try {
      const d = await api('/api/depot');
      if (!alive) return;
      last = d;
      banner.replaceChildren(...[
        !d.docker.online ? h('div.banner', h('b', 'DOCKER OFFLINE'), 'The Docker engine is not running on this node. Start Docker to deploy services. Everything else in Shelter works without it.')
        : !d.canAdmin ? h('div.banner', h('b', 'READ ONLY'), 'Services can only be deployed or stopped from the host machine itself.')
        : null].filter(Boolean));
      paint();
    } catch (e) {
      banner.replaceChildren(h('div.banner', h('b', 'FAULT'), e.message));
    }
    clearTimeout(timer);
    timer = setTimeout(load, 4000);
  }

  root.append(
    viewHeader('08', 'DEPOT', 'Optional heavy services, each in its own container. Images download once, then run offline.', tally),
    banner, tabs, grid,
    h('p.hint', { style: 'margin-top:12px' }, 'First deployment pulls the image and needs a link, as do the SOURCES links: fetch content while you have one. Add your own services in config/depot.custom.json (same format as config/depot.json), then restart the node.'));
  await load();
  return () => { alive = false; clearTimeout(timer); };
}
