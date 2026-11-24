// Exports made on this device: CSV, GPX and Markdown text, and a download helper.

/** One CSV field: always quoted, inner quotes doubled (RFC 4180). */
const field = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

/** CSV text for rows of values, with CRLF line ends and a BOM so spreadsheet apps read UTF-8. */
export const csv = (rows) => '﻿' + rows.map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';

export const STORES_COLUMNS = ['name', 'category', 'qty', 'unit', 'kcal', 'expires', 'location', 'minQty', 'dailyUse', 'note'];
export const storesCsv = (items) => csv([STORES_COLUMNS, ...items.map((it) => STORES_COLUMNS.map((k) => it[k]))]);

export const xmlEscape = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** GPX 1.1 with waypoints and routes ({ name, points: [{ lat, lon, name }] }). */
export function gpx(waypoints, routes = [], creator = 'Shelter') {
  const pt = (tag, p, indent) => {
    const desc = p.note ? '<desc>' + xmlEscape(p.note) + '</desc>' : '';
    return `${indent}<${tag} lat="${(+p.lat).toFixed(6)}" lon="${(+p.lon).toFixed(6)}"><name>${xmlEscape(p.name)}</name>${desc}</${tag}>`;
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlEscape(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    ...waypoints.map((w) => pt('wpt', w, '  ')),
    ...routes.filter((r) => r.points.length).map((r) => [`  <rte><name>${xmlEscape(r.name)}</name>`, ...r.points.map((p) => pt('rtept', p, '    ')), '  </rte>'].join('\n')),
    '</gpx>',
    '',
  ].join('\n');
}

/** All notes as one Markdown document, newest first. */
export function notesMarkdown(notes) {
  const sorted = [...notes].sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return sorted.map((n) => `# ${n.title || 'Untitled'}\n\n_Updated ${String(n.updated || '').slice(0, 16).replace('T', ' ')}_\n\n${n.body || ''}`.trimEnd()).join('\n\n---\n\n') + '\n';
}

/** Saves text as a file on this device. */
export function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Today as YYYYMMDD, for file names. */
export const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
