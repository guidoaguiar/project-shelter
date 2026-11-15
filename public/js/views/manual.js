// 02 MANUAL — offline reference manual with ranked search.
import { h, api, viewHeader, panel } from '../lib/core.js';
import { md } from '../lib/md.js';

let lastQuery = '';

export async function render(root, arg) {
  const index = await api('/api/manual');
  let currentId = '';
  if (arg.startsWith('?q=')) lastQuery = arg.slice(3);
  else currentId = arg;
  const article = currentId ? await api(`/api/manual/${encodeURIComponent(currentId)}`).catch(() => null) : null;

  const list = h('div.list.list-scroll');
  const reader = h('div.pb');
  const search = h('input', { type: 'search', placeholder: 'SEARCH: WATER, SPLINT, KNOTS…', value: lastQuery, 'aria-label': 'Search the manual' });

  const link = (a, sub, tag) => h('a', { href: `#/manual/${a.id}`, class: a.id === currentId ? 'active' : null },
    h('div.t1', a.title), tag ? h('div.t3', tag) : null, sub ? h('div.t2', sub) : null);

  // Sections hold chapters; entries without a chapter are the section's quick-reference essentials.
  const sections = new Map();
  for (const a of index) {
    if (!sections.has(a.category)) sections.set(a.category, new Map());
    const groups = sections.get(a.category);
    const key = a.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const chapters = new Set(index.map((a) => a.group).filter(Boolean)).size;

  function showIndex() {
    const kids = [...sections].map(([cat, groups]) => {
      const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
      const here = article?.category === cat;
      const body = [...groups].map(([name, items]) => {
        if (groups.size === 1) return items.map((a) => link(a));
        const label = name || 'Essentials';
        return h('details.grp', { open: !name || items.some((a) => a.id === currentId) },
          h('summary', h('span', label.toUpperCase()), h('span.n', items.length)), items.map((a) => link(a)));
      });
      return h('details', { open: here }, h('summary.cat', h('span', cat), h('span.n', total)), body);
    });
    list.replaceChildren(...(kids.length ? kids : [h('div.empty', 'NO ENTRIES')]));
    list.querySelector('a.active')?.scrollIntoView({ block: 'nearest' });
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
      ...(hits.length ? hits.map((a) => link(a, a.snippet, a.group ? `${a.category} // ${a.group.toUpperCase()}` : a.category)) : [h('div.empty', 'NOTHING FOUND')]));
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 140); });

  if (article) {
    const nav = (n, label) => (n ? h('a.btn', { href: `#/manual/${n.id}`, style: 'text-decoration:none', title: n.title }, label) : h('span'));
    reader.replaceChildren(
      h('div.article-head',
        h('div.row', h('span.tag.acc', article.category), article.group ? h('span.tag', article.group) : null),
        h('h1', article.title)),
      h('div.prose', { html: md(article.body, { imgBase: article.imgBase }) }),
      h('div.article-foot', h('div.row', { style: 'justify-content:space-between' }, nav(article.prev, '← PREVIOUS'), nav(article.next, 'NEXT →'))));
  } else if (currentId) {
    reader.replaceChildren(h('div.empty', 'ENTRY NOT FOUND'));
  } else {
    reader.replaceChildren(
      h('div.prose',
        h('h2', { style: 'margin-top:0' }, 'Field manual'),
        h('p', `${index.length} entries in ${sections.size} sections and ${chapters} chapters. Everything here is stored on this node and readable with no outside link.`),
        h('p', 'Each section opens with short essentials for quick reference, followed by full chapters with figures. Select an entry from the index, or search. Skills are learned by doing: practise them before you need them.')),
      h('div.grid', { style: 'margin:16px 0' }, [...sections].map(([cat, groups]) => {
        const first = [...groups.values()][0][0];
        return h('a.colcard.s4', { href: `#/manual/${first.id}` },
          h('div.name', cat),
          h('div.lbl', `${[...groups.values()].reduce((n, g) => n + g.length, 0)} ENTRIES`),
          h('div.desc', [...groups.keys()].filter(Boolean).join(' · ') || 'Essentials'));
      })),
      h('div.prose',
        h('h2', 'Adding your own'),
        h('p', 'Drop a Markdown file into content/manual. The file name sets the section, each line starting with a single # starts a new entry, and an optional "tags:" line beneath it improves search. New files appear without a restart.')));
  }

  root.append(
    viewHeader('02', 'MANUAL', 'Survival and self-reliance reference. Fully offline.'),
    h('div.split',
      h('div.sticky', panel('INDEX', `${index.length} ENTRIES`, h('div', h('div.pb', search), list))),
      panel(article ? 'ENTRY' : 'OVERVIEW', 'MAN', reader)));

  if (lastQuery) runSearch(); else showIndex();
  return () => clearTimeout(timer);
}
