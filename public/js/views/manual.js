// 02 MANUAL — offline field manual with ranked search.
import { h, api, viewHeader, panel } from '../lib/core.js';
import { md } from '../lib/md.js';

let lastQuery = '';

export async function render(root, arg) {
  const index = await api('/api/manual');
  let currentId = '';
  if (arg.startsWith('?q=')) lastQuery = arg.slice(3);
  else currentId = arg;

  const list = h('div.list.list-scroll');
  const reader = h('div.pb');
  const search = h('input', { type: 'search', placeholder: 'SEARCH: WATER, SPLINT, KNOTS…', value: lastQuery, 'aria-label': 'Search the field manual' });

  const link = (a, sub) => h('a', { href: `#/manual/${a.id}`, class: a.id === currentId ? 'active' : null },
    h('div.t1', a.title), sub ? h('div.t2', sub) : null);

  function showIndex() {
    const kids = [];
    let cat = '';
    for (const a of index) {
      if (a.category !== cat) { cat = a.category; kids.push(h('div.cat', cat)); }
      kids.push(link(a));
    }
    list.replaceChildren(...(kids.length ? kids : [h('div.empty', 'NO ENTRIES')]));
  }

  let timer, seq = 0;
  async function runSearch() {
    const q = search.value.trim();
    lastQuery = q;
    if (!q) return showIndex();
    const mine = ++seq;
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
    if (mine !== seq) return;
    list.replaceChildren(h('div.cat', `${hits.length} RESULT${hits.length === 1 ? '' : 'S'}`),
      ...(hits.length ? hits.map((a) => link(a, a.snippet)) : [h('div.empty', 'NOTHING FOUND')]));
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 140); });

  if (currentId) {
    try {
      const a = await api(`/api/manual/${encodeURIComponent(currentId)}`);
      reader.replaceChildren(
        h('div.article-head',
          h('div.row', h('span.tag.acc', a.category), a.tags.slice(0, 6).map((t) => h('span.tag', t))),
          h('h1', a.title)),
        h('div.prose', { html: md(a.body) }));
    } catch {
      reader.replaceChildren(h('div.empty', 'ENTRY NOT FOUND'));
    }
  } else {
    const cats = [...new Set(index.map((a) => a.category))];
    reader.replaceChildren(
      h('div.prose',
        h('h2', { style: 'margin-top:0' }, 'Field manual'),
        h('p', `${index.length} entries across ${cats.length} sections. Everything here is stored on this node and readable with no outside link.`),
        h('p', 'Select an entry from the index, or search. Skills are learned by doing: practise them before you need them.'),
        h('h2', 'Adding your own'),
        h('p', 'Drop a Markdown file into content/manual. The file name sets the section, each line starting with a single # starts a new entry, and an optional "tags:" line beneath it improves search. New files appear without a restart.')),
      h('div.row', { style: 'margin-top:14px' }, cats.map((c) => h('span.tag', c))));
  }

  root.append(
    viewHeader('02', 'MANUAL', 'Survival and self-reliance reference. Fully offline.'),
    h('div.split',
      h('div.sticky', panel('INDEX', `${index.length} ENTRIES`, h('div', h('div.pb', search), list))),
      panel(currentId ? 'ENTRY' : 'OVERVIEW', 'MAN', reader)));

  if (lastQuery) runSearch(); else showIndex();
  return () => clearTimeout(timer);
}
