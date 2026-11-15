// Field manual: loads markdown from content/manual and provides ranked search.
//
// Layout: markdown files in content/manual and in its subfolders form one manual. A subfolder
// may carry figures in img/.
// File format: optional "category: NAME" (the section) and "group: Name" (a chapter within the
// section) lines, then articles. Each "# Title" starts an article; an optional "tags: a, b"
// line follows; the first paragraph is the summary. Without a category line the file name is used.
import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set(('a an the and or of to in on for with is are was be it this that how do i what my can you ' +
  'from at by as if not when should does make get your we need use have has there their them then than into out up').split(' '));
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ies|es|ed|s)$/, '') : w);
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)).map(stem);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plain = (s) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*`>|_\\]/g, '').replace(/\s+/g, ' ').trim();
const DIR_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class Manual {
  constructor(dir) {
    this.dir = dir;
    this.signature = null;
    this.articles = [];
    this.dirs = new Set();
    this.reload();
  }

  /** [{ dir, file }] in reading order: top-level files first, then each subfolder. */
  #files() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return out; }
    for (const f of entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort()) out.push({ dir: '', file: f });
    for (const d of entries.filter((e) => e.isDirectory() && DIR_NAME.test(e.name)).map((e) => e.name).sort()) {
      let files = [];
      try { files = fs.readdirSync(path.join(this.dir, d)).filter((f) => f.endsWith('.md') && /^\d/.test(f)).sort(); } catch { /* unreadable */ }
      for (const f of files) out.push({ dir: d, file: f });
    }
    return out;
  }

  /** Re-read the content folder if any file changed. */
  reload() {
    const files = this.#files();
    const sig = files.map(({ dir, file }) => {
      try { return `${dir}/${file}:${fs.statSync(path.join(this.dir, dir, file)).mtimeMs}`; } catch { return `${dir}/${file}`; }
    }).join('|');
    if (sig === this.signature) return;
    this.signature = sig;
    const parsed = [];
    const seen = new Set();
    for (const { dir, file } of files) {
      let text;
      try { text = fs.readFileSync(path.join(this.dir, dir, file), 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }
      const head = text.split(/^# (?=\S)/m)[0];
      const named = head.match(/^category:\s*(.+)$/mi);
      const category = (named ? named[1].trim() : file.replace(/^\d+[-_]/, '').replace(/\.md$/, '').replace(/[-_]/g, ' ')).toUpperCase();
      const group = (head.match(/^group:\s*(.+)$/mi) || [])[1]?.trim() || '';
      for (const part of text.split(/^# (?=\S)/m).slice(1)) {
        const nl = part.indexOf('\n');
        const title = (nl < 0 ? part : part.slice(0, nl)).trim();
        let body = nl < 0 ? '' : part.slice(nl + 1);
        let tags = [];
        const m = body.match(/^\s*tags:\s*(.+)\n?/i);
        if (m) { tags = m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean); body = body.slice(m[0].length); }
        body = body.trim();
        // Summary: the first block of running text, cleaned of markup.
        let summary = '';
        for (const block of body.split(/\n\s*\n/)) {
          const t = plain(block.replace(/^>\s?/gm, ''));
          if (t.length > 30 && !/^(#|\||!\[|\s*[-*+]\s|\s*\d+[.)]\s)/.test(block.trim())) { summary = t.length > 240 ? t.slice(0, 237).replace(/\s+\S*$/, '') + '…' : t; break; }
        }
        // Chapter entries are namespaced by their chapter so titles such as "Shelter" can repeat.
        let id = dir && group ? (slug(title) === slug(group) ? slug(group) : `${slug(group)}-${slug(title)}`) : slug(title);
        while (seen.has(id)) id += '-2';
        seen.add(id);
        parsed.push({ id, title, category, group, dir, tags, summary, body });
      }
    }
    // Keep each section together, in order of first appearance.
    const order = new Map();
    for (const a of parsed) if (!order.has(a.category)) order.set(a.category, order.size);
    const articles = parsed.map((a, i) => [a, i]).sort((x, y) => order.get(x[0].category) - order.get(y[0].category) || x[1] - y[1]).map(([a]) => a);

    // Build the search index.
    const df = new Map();
    let total = 0;
    for (const a of articles) {
      const tf = new Map();
      const add = (text, weight) => { for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + weight); };
      add(a.title, 4); add(a.tags.join(' '), 3); add(a.category, 2); add(a.group, 2); add(plain(a.body), 1);
      a._tf = tf;
      a._len = [...tf.values()].reduce((x, y) => x + y, 0);
      total += a._len;
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    this.articles = articles;
    this.dirs = new Set(files.map((f) => f.dir).filter(Boolean));
    this.df = df;
    this.avgLen = total / (articles.length || 1);
  }

  index() {
    this.reload();
    return this.articles.map(({ id, title, category, group, tags, summary }) => ({ id, title, category, group, tags, summary }));
  }

  get(id) {
    this.reload();
    const i = this.articles.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const a = this.articles[i];
    const near = (j) => { const n = this.articles[j]; return n && n.category === a.category ? { id: n.id, title: n.title } : null; };
    return {
      id: a.id, title: a.title, category: a.category, group: a.group, tags: a.tags, summary: a.summary, body: a.body,
      imgBase: a.dir ? `/content/${a.dir}/` : null, prev: near(i - 1), next: near(i + 1),
    };
  }

  /** Folder holding a content subfolder's figures, or null. */
  imageDir(dir) {
    this.reload();
    return this.dirs.has(dir) ? path.join(this.dir, dir, 'img') : null;
  }

  #expand(query) {
    const q = [...new Set(tokens(query))];
    const expanded = [];
    for (const term of q) {
      if (this.df.has(term)) expanded.push([term, 1]);
      if (term.length >= 3) for (const t of this.df.keys()) if (t !== term && t.startsWith(term)) expanded.push([t, 0.5]);
    }
    return { q, expanded };
  }

  #rank(expanded) {
    const N = this.articles.length;
    const k1 = 1.4, b = 0.75;
    const out = [];
    for (const a of this.articles) {
      let score = 0;
      for (const [t, w] of expanded) {
        const f = a._tf.get(t);
        if (!f) continue;
        const n = this.df.get(t);
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * a._len / this.avgLen));
      }
      if (score > 0) out.push({ a, score });
    }
    return out.sort((x, y) => y.score - x.score);
  }

  /** BM25 search; query terms of 3+ letters also match as prefixes (search-as-you-type). */
  search(query, limit = 10) {
    this.reload();
    const { q, expanded } = this.#expand(query);
    if (!q.length) return [];
    return this.#rank(expanded).slice(0, limit).map(({ a, score }) => ({
      id: a.id, title: a.title, category: a.category, group: a.group, summary: a.summary, score: +score.toFixed(3), snippet: snippet(a.body, q),
    }));
  }

  /**
   * Best passages for a question, for grounding the Advisor. Long articles are cut into
   * chunks at paragraph boundaries and each chunk is scored on its own.
   */
  passages(query, limit = 4) {
    this.reload();
    const { q, expanded } = this.#expand(query);
    if (!q.length) return [];
    const ranked = this.#rank(expanded).slice(0, 6);
    if (!ranked.length) return [];
    const N = this.articles.length;
    const chunks = [];
    for (const { a, score } of ranked) {
      if (score < ranked[0].score * 0.45) continue;
      let heading = '', buf = [], size = 0;
      const flush = () => {
        if (!buf.length) return;
        const text = buf.join('\n\n');
        const tf = new Map();
        for (const t of tokens(plain(text))) tf.set(t, (tf.get(t) || 0) + 1);
        let s = 0;
        for (const [t, w] of expanded) { const f = tf.get(t); if (f) { const n = this.df.get(t); s += w * Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f / (f + 1.2)); } }
        chunks.push({ article: a, heading, text, score: s + score * 0.15 });
        buf = []; size = 0;
      };
      for (const block of a.body.split(/\n\s*\n/)) {
        const h = block.match(/^#{2,4}\s+(.*)$/);
        if (h) { flush(); heading = h[1].trim(); continue; }
        if (/^!\[/.test(block.trim())) continue;
        if (size + block.length > 1400 && size > 300) flush();
        buf.push(block.length > 1800 ? block.slice(0, 1800) + '…' : block); size += block.length;
      }
      flush();
    }
    return chunks.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}

function snippet(body, terms) {
  const text = plain(body);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, 160);
  const start = Math.max(0, at - 60);
  return (start ? '…' : '') + text.slice(start, start + 170).trim() + '…';
}
