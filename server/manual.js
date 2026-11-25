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
const slug = (s) => s.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');
// Link labels exclude "[" so an unclosed bracket cannot make the scan quadratic.
const plain = (s) => s.replaceAll(/!\[[^\]]*\]\([^)]*\)/g, ' ').replaceAll(/\[([^[\]]+)\]\([^)]*\)/g, '$1').replaceAll(/[#*`>|_\\]/g, '').replaceAll(/\s+/g, ' ').trim();
const DIR_NAME = /^[a-z0-9][a-z0-9-]*$/;
const ARTICLE_START = /^# (?=\S)/m;
const SUBHEADING = /^#{2,4}\s+(\S.*)?$/;
const LIST_OR_MARKUP = /^(#|\||!\[|\s*[-*+]\s|\s*\d+[.)]\s)/;

/** Value of a "name: value" line in a file's head, or null. */
function headField(head, name) {
  for (const line of head.split('\n')) {
    if (line.slice(0, name.length + 1).toLowerCase() !== `${name}:`) continue;
    const value = line.slice(name.length + 1).trim();
    if (value) return value;
  }
  return null;
}

/** Cuts text to at most max characters at a word boundary, marking the cut with "…". */
function clip(text, max) {
  if (text.length <= max + 3) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.search(/\s\S*$/);
  return (lastSpace < 0 ? cut : cut.slice(0, lastSpace).trimEnd()) + '…';
}

/** The first block of running text, cleaned of markup. */
function summaryOf(body) {
  for (const block of body.split(/\n\s*\n/)) {
    const t = plain(block.replaceAll(/^>\s?/gm, ''));
    if (t.length > 30 && !LIST_OR_MARKUP.test(block.trim())) return clip(t, 237);
  }
  return '';
}

/** Chapter entries are namespaced by their chapter so titles such as "Shelter" can repeat. */
function articleId(dir, group, title) {
  if (!dir || !group) return slug(title);
  return slug(title) === slug(group) ? slug(group) : `${slug(group)}-${slug(title)}`;
}

/** Splits one "# Title" section into its title, tags and body. */
function parseArticle(part) {
  const nl = part.indexOf('\n');
  const title = (nl < 0 ? part : part.slice(0, nl)).trim();
  let body = nl < 0 ? '' : part.slice(nl + 1);
  let tags = [];
  const m = /^\s*tags:\s*(.+)\n?/i.exec(body);
  if (m) { tags = m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean); body = body.slice(m[0].length); }
  return { title, tags, body: body.trim() };
}

/** Articles in one markdown file. */
function parseFile(text, dir, file) {
  const [head, ...parts] = text.split(ARTICLE_START);
  const category = (headField(head, 'category') ?? file.replace(/^\d+[-_]/, '').replace(/\.md$/, '').replaceAll(/[-_]/g, ' ')).toUpperCase();
  const group = headField(head, 'group') ?? '';
  return parts.map((part) => {
    const { title, tags, body } = parseArticle(part);
    return { id: articleId(dir, group, title), title, category, group, dir, tags, summary: summaryOf(body), body };
  });
}

/** Blocks of an article grouped into passages of about 300 to 1400 characters, each under its subheading. */
function passagesOf(body) {
  const out = [];
  let heading = '', buf = [], size = 0;
  const flush = () => {
    if (buf.length) out.push({ heading, text: buf.join('\n\n') });
    buf = []; size = 0;
  };
  for (const block of body.split(/\n\s*\n/)) {
    const h = SUBHEADING.exec(block);
    if (h) { flush(); heading = (h[1] ?? '').trim(); continue; }
    if (block.trim().startsWith('![')) continue;
    if (size + block.length > 1400 && size > 300) flush();
    buf.push(block.length > 1800 ? block.slice(0, 1800) + '…' : block);
    size += block.length;
  }
  flush();
  return out;
}

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
    for (const { dir, file } of files) {
      let text;
      try { text = fs.readFileSync(path.join(this.dir, dir, file), 'utf8').replaceAll('\r\n', '\n'); } catch { continue; }
      parsed.push(...parseFile(text, dir, file));
    }
    const seen = new Set();
    for (const a of parsed) {
      while (seen.has(a.id)) a.id += '-2';
      seen.add(a.id);
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

  /** Every entry of one section (category), in manual order, with bodies: for printing a section. */
  section(category) {
    this.reload();
    return this.articles.filter((a) => a.category === category).map((a) => this.get(a.id));
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
    const chunks = [];
    for (const { a, score } of ranked) {
      if (score < ranked[0].score * 0.45) continue;
      for (const { heading, text } of passagesOf(a.body)) {
        chunks.push({ article: a, heading, text, score: this.#passageScore(text, expanded) + score * 0.15 });
      }
    }
    return chunks.toSorted((x, y) => y.score - x.score).slice(0, limit);
  }

  /** Every passage of every entry ({ article, heading, text }), for the Advisor's embedding index. */
  chunks() {
    this.reload();
    if (this.chunked?.signature !== this.signature) {
      this.chunked = { signature: this.signature, list: this.articles.flatMap((a) => passagesOf(a.body).map(({ heading, text }) => ({ article: a, heading, text }))) };
    }
    return this.chunked.list;
  }

  /** How well one passage matches the expanded query terms (saturating term frequency times IDF). */
  #passageScore(text, expanded) {
    const N = this.articles.length;
    const tf = new Map();
    for (const t of tokens(plain(text))) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const [t, w] of expanded) {
      const f = tf.get(t);
      if (!f) continue;
      const n = this.df.get(t);
      s += w * Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f / (f + 1.2));
    }
    return s;
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
