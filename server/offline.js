// The app shell the service worker (public/sw.js) stores so a phone can open Shelter away from the node.
// Built from what is in public/ at the time, so new views and libraries are included without a list to maintain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** File types the shell includes. Everything else in public/ (and the worker itself) is left out. */
const SHELL_TYPES = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.webmanifest', '.ico', '.woff2']);
const SKIP = new Set(['/sw.js']);

/** Every file under dir as a URL path ("/js/app.js"), sorted. */
function walk(dir, base = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const url = `${base}/${e.name}`;
    if (e.isDirectory()) return walk(path.join(dir, e.name), url);
    return e.isFile() ? [url] : [];
  });
}

/**
 * { version, files } for the service worker: "/" plus each shell file in publicDir. version changes
 * when any of those files changes (size or modification time), so the worker knows to refresh them.
 */
export function shellManifest(publicDir) {
  const files = walk(publicDir).filter((f) => SHELL_TYPES.has(path.extname(f).toLowerCase()) && !SKIP.has(f)).sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    try { const st = fs.statSync(path.join(publicDir, f)); hash.update(`${f}:${st.size}:${st.mtimeMs}\n`); } catch { hash.update(`${f}:-\n`); }
  }
  return { version: hash.digest('hex').slice(0, 16), files: ['/', ...files.map((f) => encodeURI(f))] };
}
