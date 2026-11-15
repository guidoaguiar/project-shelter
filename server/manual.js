// Field manual: loads markdown from content/manual and provides ranked search.
// File format: one file per category. Each "# Title" starts an article; an optional
// "tags: a, b" line follows; the first paragraph is the summary.
import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set(('a an the and or of to in on for with is are was be it this that how do i what my can you ' +
  'from at by as if not when should does make get your we need use have has there their them then than into out up').split(' '));
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ies|es|ed|s)$/, '') : w);
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)).map(stem);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export class Manual {
  constructor(dir) {
    this.dir = dir;
    this.signature = '';
    this.articles = [];
    this.reload();
  }

  #sig() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.md')).sort()
        .map((f) => f + ':' + fs.statSync(path.join(this.dir, f)).mtimeMs).join('|');
    } catch { return ''; }
  }

  /** Re-read the content folder if any file changed. */
  reload() {
    const sig = this.#sig();
    if (sig === this.signature) return;
    this.signature = sig;
    const articles = [];
    const seen = new Set();
    const files = sig ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.md')).sort() : [];
    for (const file of files) {
      const category = file.replace(/^\d+[-_]/, '').replace(/\.md$/, '').replace(/[-_]/g, ' ').toUpperCase();
      const text = fs.readFileSync(path.join(this.dir, file), 'utf8').replace(/\r\n/g, '\n');
      for (const part of text.split(/^# (?=\S)/m).slice(1)) {
        const nl = part.indexOf('\n');
        const title = (nl < 0 ? part : part.slice(0, nl)).trim();
        let body = nl < 0 ? '' : part.slice(nl + 1);
        let tags = [];
        const m = body.match(/^\s*tags:\s*(.+)\n?/i);
        if (m) { tags = m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean); body = body.slice(m[0].length); }
        body = body.trim();
        const first = body.split(/\n\s*\n/)[0] || '';
        const summary = /^[#>|\-\d]/.test(first) ? '' : first.replace(/\s+/g, ' ').replace(/[*`]/g, '');
        let id = slug(title);
        while (seen.has(id)) id += '-2';
        seen.add(id);
        articles.push({ id, title, category, tags, summary, body });
      }
    }
    // Build the search index.
    const df = new Map();
    let total = 0;
    for (const a of articles) {
      const tf = new Map();
      const add = (text, weight) => { for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + weight); };
      add(a.title, 4); add(a.tags.join(' '), 3); add(a.category, 2); add(a.body, 1);
      a._tf = tf;
      a._len = [...tf.values()].reduce((x, y) => x + y, 0);
      total += a._len;
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    this.articles = articles;
    this.df = df;
    this.avgLen = total / (articles.length || 1);
  }

  index() {
    this.reload();
    return this.articles.map(({ id, title, category, tags, summary }) => ({ id, title, category, tags, summary }));
  }

  get(id) {
    this.reload();
    const a = this.articles.find((x) => x.id === id);
    return a ? { id: a.id, title: a.title, category: a.category, tags: a.tags, summary: a.summary, body: a.body } : null;
  }

  /** BM25 search; query terms of 3+ letters also match as prefixes (search-as-you-type). */
  search(query, limit = 10) {
    this.reload();
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = this.articles.length;
    const k1 = 1.4, b = 0.75;
    const expanded = [];
    for (const term of q) {
      if (this.df.has(term)) expanded.push([term, 1]);
      if (term.length >= 3) for (const t of this.df.keys()) if (t !== term && t.startsWith(term)) expanded.push([t, 0.5]);
    }
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
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, limit).map(({ a, score }) => ({
      id: a.id, title: a.title, category: a.category, summary: a.summary, score: +score.toFixed(3), snippet: snippet(a.body, q),
    }));
  }
}

function snippet(body, terms) {
  const plain = body.replace(/[#*`>|]/g, '').replace(/\s+/g, ' ');
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return plain.slice(0, 160);
  const start = Math.max(0, at - 60);
  return (start ? '…' : '') + plain.slice(start, start + 170).trim() + '…';
}
