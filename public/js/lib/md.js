// Minimal, safe markdown renderer. All text is HTML-escaped before any markup is added;
// links and images are only emitted for URLs that pass an allow-list.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeLink(url) {
  if (/^https?:\/\/[^\s"<>]+$/i.test(url)) return { href: url, external: true };
  if (/^#\/[\w\-/.?=%]*$/.test(url)) return { href: url, external: false };
  return null;
}

function inline(src) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  let s = src.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c) => keep(esc(c)));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g, (m, label, url) => {
    const link = safeLink(url.replace(/&amp;/g, '&'));
    if (!link) return label;
    return keep(`<a href="${esc(link.href)}"${link.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>`) + label + keep('</a>');
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const IMAGE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const isBlockStart = (line) => /^(#{1,4}\s|>|\s*\||\s*!\[|\s*(---|\*\*\*)\s*$)/.test(line);

function renderList(lines, start, opts) {
  const first = lines[start].match(LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the list clearly continues after it.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length && lines[j].match(LIST);
      if (next && next[1].length >= base && (next[1].length > base + 1 || /\d/.test(next[2]) === ordered)) { i = j; continue; }
      break;
    }
    const m = line.match(LIST);
    if (m) {
      const indent = m[1].length;
      if (indent < base) break;
      if (indent > base + 1 && items.length) {
        const sub = renderList(lines, i, opts);
        items[items.length - 1].sub += sub.html;
        i = sub.next;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ text: m[3], sub: '' });
      i++;
      continue;
    }
    if (isBlockStart(line) || !items.length) break;
    items[items.length - 1].text += ' ' + line.trim(); // lazy continuation
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.sub}</li>`).join('')}</${tag}>`, next: i };
}

function renderBlocks(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const level = Math.min(4, Math.max(2, m[1].length));
      out.push(`<h${level}>${inline(m[2])}</h${level}>`); i++; continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(buf, opts)}</blockquote>`); continue;
    }
    if ((m = line.match(IMAGE))) {
      i++;
      if (opts.imgBase && /^img\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp)$/i.test(m[2])) {
        const caption = m[1].trim();
        out.push(`<figure><div class="fig"><img src="${esc(opts.imgBase + m[2])}" alt="${esc(caption)}" loading="lazy"></div>${caption ? `<figcaption>${inline(caption)}</figcaption>` : ''}</figure>`);
      }
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      const thead = head.some(Boolean) ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
      out.push(`<div class="tw"><table>${thead}<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(line)) {
      const list = renderList(lines, i, opts);
      out.push(list.html);
      i = list.next;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !LIST.test(lines[i])) buf.push(lines[i++].trim());
    if (!buf.length) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** md(source, { imgBase }) — imgBase is the URL prefix for "img/..." figures; without it images are dropped. */
export function md(src, opts = {}) {
  return renderBlocks(String(src).replace(/\r\n/g, '\n').split('\n'), opts);
}
