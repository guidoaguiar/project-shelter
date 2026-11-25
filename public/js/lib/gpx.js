// GPX 1.1 import and export for waypoints, routes and tracks. Pure functions, no DOM required:
// in a browser DOMParser reads the file when it is well-formed XML; otherwise, and under Node,
// a small tolerant XML scanner does, so truncated or sloppy files from GPS units still load.
import { kindFromGpx, kindSym, kindOf } from './waypoints.js';
import { MAX_ROUTE_POINTS, trackCoords } from './route.js';

/** Largest GPX text accepted, in characters. */
export const MAX_GPX_CHARS = 40 * 1024 * 1024;
const MAX_NODES = 1_000_000;

// ---------- XML ----------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The character for one entity body ("amp", "#38", "#x26"), or null when it is not one. */
function entity(body) {
  if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? null;
  const hex = body[1] === 'x' || body[1] === 'X';
  const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!Number.isFinite(code) || code < 1 || code > 0x10_FF_FF || (code >= 0xD8_00 && code <= 0xDF_FF)) return '�';
  return String.fromCodePoint(code);
}

/** Text with XML entities decoded; unknown entities are kept as written. */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replaceAll(/&(#x[0-9a-f]{1,8}|#\d{1,9}|[a-z]{2,8});/gi, (m, body) => entity(body) ?? m);
}

/** Lower-case local part of a qualified name: "gpx:WPT" -> "wpt". */
const local = (qname) => qname.slice(qname.indexOf(':') + 1).toLowerCase();
const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
const node = (name, attrs = {}) => ({ name, attrs, children: [], text: '' });

/** Where a <!...> declaration ends (after its '>'), allowing an internal [subset]. */
function declEnd(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') depth = Math.max(0, depth - 1);
    else if (s[i] === '>' && depth === 0) return i + 1;
  }
  return s.length;
}

/** Reads one attribute value starting at i (quoted or bare). Returns [value, next index]. */
function attrValue(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, i + 1);
    const stop = end < 0 ? s.length : end;
    return [s.slice(i + 1, stop), Math.min(s.length, stop + 1)];
  }
  let j = i;
  while (j < s.length && !isSpace(s[j]) && s[j] !== '>' && s[j] !== '<') j++;
  return [s.slice(i, j), j];
}

/** Parses a start tag at s[lt] === '<'. Returns { name, attrs, selfClose, end }. */
const skipSpace = (s, i) => {
  let j = i;
  while (j < s.length && isSpace(s[j])) j++;
  return j;
};

/** Reads one attribute (name, optional =value) starting at i into attrs. Returns the next index. */
function readAttr(s, i, attrs) {
  let j = i;
  while (j < s.length && !isSpace(s[j]) && !'=>/<'.includes(s[j])) j++;
  const key = local(s.slice(i, j));
  j = skipSpace(s, j);
  if (s[j] === '=') {
    const [v, next] = attrValue(s, skipSpace(s, j + 1));
    attrs[key] = decodeEntities(v);
    j = next;
  } else if (key) attrs[key] = '';
  return Math.max(j, i + 1);
}

function startTag(s, lt) {
  let i = lt + 1;
  while (i < s.length && !isSpace(s[i]) && !'>/<'.includes(s[i])) i++;
  const name = local(s.slice(lt + 1, i));
  const attrs = {};
  let selfClose = false;
  while (i < s.length && s[i] !== '<') { // a "<" inside a tag means it was cut short: the next tag starts there
    const c = s[i];
    if (c === '>') return { name, attrs, selfClose, end: i + 1 };
    if (c === '/') { selfClose = true; i++; continue; }
    if (isSpace(c)) { i++; continue; }
    i = readAttr(s, i, attrs);
    selfClose = false;
  }
  return { name, attrs, selfClose, end: i };
}

/** Index just past the next `end` after from, or the end of s. */
const skipPast = (s, from, end) => {
  const e = s.indexOf(end, from);
  return e < 0 ? s.length : e + end.length;
};

/** Handles a closing tag at lt: closes the innermost open element of that name, if any. */
function closeTag(s, lt, stack) {
  const gt = s.indexOf('>', lt);
  const name = local(s.slice(lt + 2, gt < 0 ? s.length : gt).trim());
  const at = stack.findLastIndex((n) => n.name === name);
  if (at > 0) stack.length = at; // close it and anything left open inside it
  return gt < 0 ? s.length : gt + 1;
}

/** Handles a start tag at lt. Returns the next index, or -1 when the node limit is reached. */
function openTag(s, lt, stack, state) {
  const t = startTag(s, lt);
  if (++state.count > MAX_NODES) return -1;
  const el = node(t.name, t.attrs);
  stack.at(-1).children.push(el);
  if (!t.selfClose) stack.push(el);
  return Math.max(t.end, lt + 1);
}

/** Handles the markup starting at s[lt] === '<'. Returns the index to continue from (-1 to stop). */
function markup(s, lt, stack, state) {
  if (s.startsWith('<!--', lt)) return skipPast(s, lt + 4, '-->');
  if (s.startsWith('<![CDATA[', lt)) {
    const e = s.indexOf(']]>', lt + 9);
    stack.at(-1).text += s.slice(lt + 9, e < 0 ? s.length : e);
    return e < 0 ? s.length : e + 3;
  }
  const c = s[lt + 1] || '';
  if (c === '?') return skipPast(s, lt + 2, '?>');
  if (c === '!') return declEnd(s, lt + 2);
  if (c === '/') return closeTag(s, lt, stack);
  if (/[A-Za-z_]/.test(c)) return openTag(s, lt, stack, state);
  stack.at(-1).text += '<'; // a bare "<" in text, as in "depth < 2 m"
  return lt + 1;
}

/**
 * A forgiving XML parser: returns a tree of { name, attrs, children, text } with lower-case local
 * names. Comments, processing instructions and DOCTYPEs are skipped; CDATA is text; unclosed
 * elements are closed at the end, and stray closing tags are ignored. Never throws on bad markup.
 */
export function parseXml(text) {
  const s = String(text ?? '');
  const root = node('#root');
  const stack = [root];
  const state = { count: 0 };
  let i = 0;
  while (i >= 0 && i < s.length) {
    const lt = s.indexOf('<', i);
    const end = lt < 0 ? s.length : lt;
    if (end > i) stack.at(-1).text += decodeEntities(s.slice(i, end));
    i = lt < 0 ? -1 : markup(s, lt, stack, state);
  }
  return root;
}

/** The same tree shape from a DOM element (DOMParser output). */
function fromDom(el) {
  const out = node(String(el.localName || el.nodeName).toLowerCase());
  for (const a of el.attributes || []) out.attrs[String(a.localName || a.name).toLowerCase()] = a.value;
  for (const c of el.childNodes || []) {
    if (c.nodeType === 1) out.children.push(fromDom(c));
    else if (c.nodeType === 3 || c.nodeType === 4) out.text += c.nodeValue;
  }
  return out;
}

/** XML text as a tree: DOMParser when there is one and the file is well formed, else parseXml. */
export function xmlTree(text, Parser = globalThis.DOMParser) {
  if (Parser) {
    try {
      const doc = new Parser().parseFromString(text, 'application/xml');
      if (doc?.documentElement && !doc.getElementsByTagName('parsererror').length) {
        const root = node('#root');
        root.children.push(fromDom(doc.documentElement));
        return root;
      }
    } catch { /* fall back to the scanner */ }
  }
  return parseXml(text);
}

// ---------- reading GPX ----------

const child = (el, name) => el.children.find((c) => c.name === name);
const childText = (el, name) => (child(el, name)?.text || '').trim();
const kids = (el, name) => el.children.filter((c) => c.name === name);

/** Every element named name under el, not looking inside elements named in `stop`. */
function findAll(el, name, stop = [], out = []) {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    else if (!stop.includes(c.name)) findAll(c, name, stop, out);
  }
  return out;
}

const finite = (v) => {
  const n = Number.parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/** One wpt, rtept or trkpt, or null when its position is missing or out of range. */
function readPoint(el) {
  const lat = finite(el.attrs.lat), lon = finite(el.attrs.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const time = childText(el, 'time');
  return {
    lat, lon,
    ele: finite(childText(el, 'ele')),
    time: time && !Number.isNaN(Date.parse(time)) ? time : null,
    name: childText(el, 'name'),
    note: childText(el, 'desc') || childText(el, 'cmt'),
    kind: kindFromGpx(childText(el, 'type'), childText(el, 'sym')),
  };
}

/** Points of the elements, dropping bad ones; counts what was dropped in stats.skipped. */
function readPoints(els, stats) {
  const out = [];
  for (const el of els) {
    const p = readPoint(el);
    if (p) out.push(p); else stats.skipped++;
  }
  return out;
}

/**
 * Reads GPX text. Returns { waypoints, routes, tracks, skipped, creator } where waypoints are
 * { name, lat, lon, ele, time, note, kind }, routes { name, note, points } and tracks
 * { name, note, points } (one per track segment). Points with a missing or impossible position
 * are skipped and counted. Throws when the text is not GPX at all.
 */
export function parseGpx(text, { Parser } = {}) {
  const s = String(text ?? '');
  if (s.length > MAX_GPX_CHARS) throw new Error('GPX file too large');
  const root = xmlTree(s, Parser);
  const gpx = findAll(root, 'gpx')[0];
  const base = gpx || root;
  const stats = { skipped: 0 };
  const waypoints = readPoints(findAll(base, 'wpt', ['rte', 'trk']), stats);
  const routes = findAll(base, 'rte', ['trk']).map((r) => ({ name: childText(r, 'name'), note: childText(r, 'desc') || childText(r, 'cmt'), points: readPoints(findAll(r, 'rtept'), stats) }));
  const tracks = [];
  for (const t of findAll(base, 'trk', ['rte'])) {
    const name = childText(t, 'name'), note = childText(t, 'desc') || childText(t, 'cmt');
    const segs = kids(t, 'trkseg');
    const parts = segs.length ? segs.map((g) => findAll(g, 'trkpt')) : [kids(t, 'trkpt')];
    parts.forEach((els, i) => tracks.push({ name: parts.length > 1 && i ? `${name} ${i + 1}`.trim() : name, note, points: readPoints(els, stats) }));
  }
  if (!gpx && !waypoints.length && !routes.length && !tracks.length) throw new Error('not a GPX file');
  return { waypoints, routes, tracks, skipped: stats.skipped, creator: gpx?.attrs.creator || '' };
}

// ---------- writing GPX ----------

// XML 1.0 forbids most control characters, even escaped.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
export const xmlText = (s) => String(s ?? '').replaceAll(CONTROL, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

const coord = (v) => (+v).toFixed(6);
const tag = (name, value) => (value === '' || value == null ? '' : `<${name}>${xmlText(value)}</${name}>`);

function pointXml(name, p, indent, { withKind = true } = {}) {
  const ele = Number.isFinite(p.ele) ? `<ele>${Math.round(p.ele * 10) / 10}</ele>` : '';
  const kind = withKind ? tag('sym', kindSym(kindOf(p))) + tag('type', kindOf(p)) : '';
  return `${indent}<${name} lat="${coord(p.lat)}" lon="${coord(p.lon)}">${ele}${tag('time', p.time)}${tag('name', p.name)}${tag('desc', p.note)}${kind}</${name}>`;
}

const asPoint = (p) => (Array.isArray(p) ? { lat: p[0], lon: p[1], ele: p[2] } : p);

/**
 * GPX 1.1 text. waypoints: { name, lat, lon, kind?, note?, ele? }. routes: { name, note?, points }
 * with waypoint-like points. tracks: { name, note?, points } with { lat, lon, ele? } or
 * [lat, lon, ele?] points. Routes and tracks without points are left out.
 */
export function toGpx({ waypoints = [], routes = [], tracks = [] } = {}, { creator = 'Shelter', name = '', time = new Date().toISOString() } = {}) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlText(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata>${tag('name', name)}${tag('time', time)}</metadata>`,
    ...waypoints.map((w) => pointXml('wpt', w, '  ')),
  ];
  for (const r of routes.filter((x) => x.points?.length)) {
    lines.push(`  <rte>${tag('name', r.name)}${tag('desc', r.note)}`, ...r.points.map((p) => pointXml('rtept', p, '    ')), '  </rte>');
  }
  for (const t of tracks.filter((x) => x.points?.length)) {
    lines.push(`  <trk>${tag('name', t.name)}${tag('desc', t.note)}`, '    <trkseg>',
      ...t.points.map((p) => pointXml('trkpt', { ...asPoint(p), name: '' }, '      ', { withKind: false })), '    </trkseg>', '  </trk>');
  }
  lines.push('</gpx>', '');
  return lines.join('\n');
}

// ---------- import planning ----------

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const placeKey = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)},${clip(p.name, 60).toLowerCase()}`;

/**
 * What importing a parsed GPX file would create, given the waypoints already stored. Returns
 * { waypoints, routes, tracks, duplicates }: waypoints to create ({ key, name, lat, lon, kind, note }),
 * routes ({ name, kind: 'route', notes, refs: [{ id } | { key }] }) whose points are existing
 * waypoints (id) or new ones (key), and tracks ({ name, kind: 'track', notes, track }). A point with
 * the same name and position (to about 1 m) as a stored or earlier one is reused, not duplicated.
 * Routes longer than MAX_ROUTE_POINTS become tracks.
 */
export function planImport(parsed, existing = []) {
  const known = new Map(existing.map((w) => [placeKey(w), { id: w.id }]));
  const create = [];
  let duplicates = 0;
  const ref = (p, fallbackName) => {
    const name = clip(p.name, 60) || fallbackName;
    const k = placeKey({ ...p, name });
    const hit = known.get(k);
    if (hit) { duplicates++; return hit; }
    const r = { key: `n${create.length}` };
    create.push({ key: r.key, name, lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6), kind: p.kind || 'other', note: clip(p.note, 500) });
    known.set(k, r);
    return r;
  };
  parsed.waypoints.forEach((w, i) => ref(w, `WPT ${i + 1}`));
  const routes = [], tracks = [];
  parsed.routes.forEach((r, i) => {
    const name = clip(r.name, 60) || `ROUTE ${i + 1}`;
    if (!r.points.length) return;
    if (r.points.length > MAX_ROUTE_POINTS) {
      tracks.push({ name, kind: 'track', notes: clip(r.note, 500), track: trackCoords(r.points) });
      return;
    }
    routes.push({ name, kind: 'route', notes: clip(r.note, 500), refs: r.points.map((p, j) => ref(p, clip(`${name} ${j + 1}`, 60))) });
  });
  parsed.tracks.forEach((t, i) => {
    if (t.points.length < 2) return;
    tracks.push({ name: clip(t.name, 60) || `TRACK ${i + 1}`, kind: 'track', notes: clip(t.note, 500), track: trackCoords(t.points) });
  });
  return { waypoints: create, routes, tracks, duplicates };
}
