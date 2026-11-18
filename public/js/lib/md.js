// Minimal, safe markdown renderer. All text is HTML-escaped before any markup is added;
// links and images are only emitted for URLs that pass an allow-list.
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function safeLink(url) {
  if (/^https?:\/\/[^\s"<>]+$/i.test(url)) return { href: url, external: true };
  if (/^#\/[\w\-/.?=%]*$/.test(url)) return { href: url, external: false };
  return null;
}

// Placeholder for markup kept aside while the rest of a line is escaped: a private-use character,
// removed from the input first so text can never forge a placeholder.
const MARK = '';
const STASHED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
// Link labels exclude "[" so an unclosed bracket cannot make the scan quadratic.
const LINK = /\[([^[\]]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g;

function inline(src) {
  const stash = [];
  const keep = (html) => { stash.push(html); return MARK + (stash.length - 1) + MARK; };
  let s = src.replaceAll(MARK, '').replaceAll(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replaceAll(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c) => keep(esc(c)));
  s = esc(s);
  s = s.replaceAll(LINK, (m, label, url) => {
    const link = safeLink(url.replaceAll('&amp;', '&'));
    if (!link) return label;
    const target = link.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return keep(`<a href="${esc(link.href)}"${target}>`) + label + keep('</a>');
  });
  s = s.replaceAll(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replaceAll(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>')
    .replaceAll(/(^|[^\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1<em>$2</em>');
  return s.replaceAll(STASHED, (_, i) => stash[+i]);
}

const cells = (line) => line.trim().replaceAll(/^\||\|$/g, '').split('|').map((c) => c.trim());
// "\s+(\S.*)?" rather than "\s+(.*)": the same captures, without backtracking between the two.
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\S.*)?$/;
const HEADING = /^(#{1,4})\s+(\S.*)?$/;
const RULE = /^\s*(---|\*\*\*)\s*$/;
const IMAGE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const FIGURE_FILE = /^img\/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|gif|webp)$/i;
const isBlockStart = (line) => /^(#{1,4}\s|>|\s*\||\s*!\[|\s*(---|\*\*\*)\s*$)/.test(line);
const isOrdered = (marker) => /\d/.test(marker);
// A table's second line: only spaces, colons, dashes and pipes, with a pipe after the first character.
const isTableRule = (line) => /^[\s:|-]+$/.test(line) && line.indexOf('|', 1) > 0;

/** Index of the next item when the list continues past the blank line at i, else -1. */
function resumeAfterBlank(lines, i, base, ordered) {
  let j = i + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  const next = j < lines.length && lines[j].match(LIST);
  if (!next || next[1].length < base) return -1;
  return next[1].length > base + 1 || isOrdered(next[2]) === ordered ? j : -1;
}

/** Consumes line i of a list into items. Returns the next line index, or -1 where the list ends. */
function listStep(lines, i, list) {
  const { base, ordered, items, opts } = list;
  const line = lines[i];
  if (!line.trim()) return resumeAfterBlank(lines, i, base, ordered);
  const m = line.match(LIST);
  if (!m) {
    if (isBlockStart(line) || !items.length) return -1;
    items.at(-1).text += ' ' + line.trim(); // lazy continuation
    return i + 1;
  }
  const indent = m[1].length;
  if (indent < base) return -1;
  if (indent > base + 1 && items.length) {
    const sub = renderList(lines, i, opts);
    items.at(-1).sub += sub.html;
    return sub.next;
  }
  if (isOrdered(m[2]) !== ordered) return -1;
  items.push({ text: m[3] ?? '', sub: '' });
  return i + 1;
}

function renderList(lines, start, opts) {
  const first = lines[start].match(LIST);
  const list = { base: first[1].length, ordered: isOrdered(first[2]), items: [], opts };
  let i = start;
  while (i < lines.length) {
    const next = listStep(lines, i, list);
    if (next < 0) break;
    i = next;
  }
  const tag = list.ordered ? 'ol' : 'ul';
  const lis = list.items.map((it) => `<li>${inline(it.text)}${it.sub}</li>`).join('');
  return { html: `<${tag}>${lis}</${tag}>`, next: i };
}

// Block parsers, tried in order. Each returns { html, next } when the block starts at line i, else null.
// html may be empty (a figure that is not allowed): the lines are consumed and nothing is shown.

function heading(lines, i) {
  const m = lines[i].match(HEADING);
  if (!m) return null;
  const level = Math.min(4, Math.max(2, m[1].length));
  return { html: `<h${level}>${inline(m[2] ?? '')}</h${level}>`, next: i + 1 };
}

const rule = (lines, i) => (RULE.test(lines[i]) ? { html: '<hr>', next: i + 1 } : null);

function quote(lines, i, opts) {
  if (!lines[i].startsWith('>')) return null;
  const buf = [];
  let j = i;
  while (j < lines.length && lines[j].startsWith('>')) buf.push(lines[j++].replace(/^>\s?/, ''));
  return { html: `<blockquote>${renderBlocks(buf, opts)}</blockquote>`, next: j };
}

function image(lines, i, opts) {
  const m = lines[i].match(IMAGE);
  if (!m) return null;
  if (!opts.imgBase || !FIGURE_FILE.test(m[2])) return { html: '', next: i + 1 };
  const caption = m[1].trim();
  const figcaption = caption ? `<figcaption>${inline(caption)}</figcaption>` : '';
  return { html: `<figure><div class="fig"><img src="${esc(opts.imgBase + m[2])}" alt="${esc(caption)}" loading="lazy"></div>${figcaption}</figure>`, next: i + 1 };
}

const tableRow = (row, tag) => '<tr>' + row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>';

function table(lines, i) {
  if (!lines[i].trim().startsWith('|') || i + 1 >= lines.length || !isTableRule(lines[i + 1])) return null;
  const head = cells(lines[i]);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim().startsWith('|')) rows.push(cells(lines[j++]));
  const thead = head.some(Boolean) ? `<thead>${tableRow(head, 'th')}</thead>` : '';
  const tbody = rows.map((r) => tableRow(r, 'td')).join('');
  return { html: `<div class="tw"><table>${thead}<tbody>${tbody}</tbody></table></div>`, next: j };
}

const list = (lines, i, opts) => (LIST.test(lines[i]) ? renderList(lines, i, opts) : null);

function paragraph(lines, i) {
  const buf = [];
  let j = i;
  while (j < lines.length && lines[j].trim() && !isBlockStart(lines[j]) && !LIST.test(lines[j])) buf.push(lines[j++].trim());
  if (!buf.length) buf.push(lines[j++].trim());
  return { html: `<p>${inline(buf.join(' '))}</p>`, next: j };
}

const BLOCKS = [heading, rule, quote, image, table, list, paragraph];

function renderBlocks(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    for (const parse of BLOCKS) {
      const block = parse(lines, i, opts);
      if (!block) continue;
      if (block.html) out.push(block.html);
      i = block.next;
      break;
    }
  }
  return out.join('\n');
}

/** md(source, { imgBase }) — imgBase is the URL prefix for "img/..." figures; without it images are dropped. */
export function md(src, opts = {}) {
  return renderBlocks(String(src).replaceAll('\r\n', '\n').split('\n'), opts);
}
