// Kit templates: config/kits.json, plus optional user additions in config/kits.custom.json
// (same format; an entry with a matching id replaces the built-in one).
import fs from 'node:fs';
import path from 'node:path';

/** Keeps well-formed templates: an id, a name and a list of item labels. */
function valid(entries, source) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const ok = e && /^[a-z0-9][a-z0-9-]{0,39}$/.test(e.id || '') && typeof e.name === 'string' && Array.isArray(e.items)
      && e.items.every((x) => typeof x === 'string' && x.trim() && x.length <= 120);
    if (ok) {
      const days = Number.isInteger(e.intervalDays) && e.intervalDays >= 7 && e.intervalDays <= 730 ? e.intervalDays : 180;
      out.push({ id: e.id, name: e.name.slice(0, 60), intervalDays: days, source: String(e.source || ''), items: e.items.slice(0, 200).map((x) => x.trim()) });
    } else {
      console.warn(`kits: skipped invalid template in ${source}: ${JSON.stringify(e?.id ?? e)}`);
    }
  }
  return out;
}

export function loadKitTemplates(configDir) {
  const read = (name) => {
    const file = path.join(configDir, name);
    if (!fs.existsSync(file)) return [];
    try { return valid(JSON.parse(fs.readFileSync(file, 'utf8')), name); } catch (error) {
      console.warn(`kits: could not read ${name}: ${error.message}`);
      return [];
    }
  };
  const list = read('kits.json');
  for (const t of read('kits.custom.json')) {
    const i = list.findIndex((x) => x.id === t.id);
    if (i >= 0) list[i] = { ...t, custom: true }; else list.push({ ...t, custom: true });
  }
  return list;
}
