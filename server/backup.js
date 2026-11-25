// Backups: one JSON file with settings (never the API key or PIN), every collection and the plan.
// Daily automatic snapshots go to <data>/backups; a replace-restore first saves a pre-restore snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PORTABLE_SETTINGS } from './store.js';

export const FORMAT = 'shelter-backup';
export const VERSION = 1;
const KEEP_AUTO = 14;
const KEEP_PRE_RESTORE_DAYS = 90;
const NAME = /^(auto|pre-restore)-[0-9TZ-]+\.json$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Most bytes of Log images a backup carries (base64 adds a third), so a restore stays under its upload limit. */
export const ATTACHMENTS_MAX = 24 * 1024 * 1024;

/**
 * The backup object for the node's current state. attachments (optional, server/attachments.js):
 * Log images go in as base64 up to ATTACHMENTS_MAX; any that do not fit are listed in attachmentsOmitted.
 */
export function buildBackup({ settings, collections, plan, maps = [], appVersion, attachments }) {
  const s = settings.value;
  const images = attachments && collections.notes ? attachments.exportAll(collections.notes.all(), ATTACHMENTS_MAX) : null;
  return {
    format: FORMAT,
    version: VERSION,
    created: new Date().toISOString(),
    node: { callsign: s.callsign, appVersion },
    settings: Object.fromEntries(PORTABLE_SETTINGS.map((k) => [k, s[k]])),
    collections: Object.fromEntries(Object.entries(collections).map(([name, c]) => [name, c.all()])),
    plan: plan.get(),
    maps: maps.filter((m) => !m.error).map((m) => ({ file: m.file, bounds: m.bounds, maxZoom: m.maxZoom })),
    ...(images && { attachments: images.files }),
    ...(images?.omitted.length ? { attachmentsOmitted: images.omitted } : {}),
  };
}

/** Checks a backup's format and version; throws a 400 error explaining what is wrong. */
export function checkBackup(b) {
  if (!b || typeof b !== 'object' || b.format !== FORMAT) throw fail(400, 'not a Shelter backup file');
  if (!Number.isInteger(b.version) || b.version < 1) throw fail(400, 'backup version missing');
  if (b.version > VERSION) throw fail(400, 'this backup was made by a newer Shelter: update this node first');
  if (!b.collections || typeof b.collections !== 'object') throw fail(400, 'backup has no collections');
}

/**
 * Restores a backup. mode: 'merge' or 'replace'. Returns a report per collection, plus the plan and
 * settings. With dryRun nothing changes. Merge never touches settings; replace restores the portable ones.
 */
export function restoreBackup(b, { mode, dryRun }, { settings, collections, plan, attachments }) {
  checkBackup(b);
  if (mode !== 'merge' && mode !== 'replace') throw fail(400, 'mode must be merge or replace');
  const report = { collections: {}, plan: restorePlan(b.plan, plan, mode, dryRun), settings: restoreSettings(b.settings, settings, mode, dryRun) };
  for (const [name, c] of Object.entries(collections)) report.collections[name] = c.restore(b.collections[name] || [], mode, dryRun);
  // Log images are only ever added: a restore never deletes an image file.
  if (attachments) report.attachments = attachments.importAll(b.attachments, dryRun);
  return report;
}

/** The plan comes back on replace, or on merge when the backup's copy is newer. */
function restorePlan(theirs, plan, mode, dryRun) {
  if (!theirs || typeof theirs !== 'object') return 'unchanged';
  if (mode !== 'replace' && (theirs.updated || '') <= (plan.get().updated || '')) return 'unchanged';
  if (dryRun) return 'restored';
  try {
    plan.replace(theirs);
    return 'restored';
  } catch {
    return 'invalid';
  }
}

/** Portable settings come back on replace only. */
function restoreSettings(theirs, settings, mode, dryRun) {
  if (mode !== 'replace' || !theirs || typeof theirs !== 'object') return 'unchanged';
  const patch = Object.fromEntries(PORTABLE_SETTINGS.filter((k) => k in theirs).map((k) => [k, theirs[k]]));
  if (!dryRun) settings.update(patch, 'host');
  return 'restored';
}

/** Content hash of a backup, ignoring when it was made: equal hashes mean nothing changed. */
const fingerprint = (b) => crypto.createHash('sha256').update(JSON.stringify({ ...b, created: null })).digest('hex');
const stamp = (t) => new Date(t).toISOString().replaceAll(/[:.]/g, '-');
/** When a snapshot was made, from its name (auto-2026-03-01T12-00-00-000Z.json). */
function madeAt(name) {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/** Automatic and pre-restore snapshots in one folder. */
export class Snapshots {
  constructor(dir, { now = Date.now } = {}) { this.dir = dir; this.now = now; }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => NAME.test(n)); } catch { /* no folder yet */ }
    return names.map((name) => {
      const st = fs.statSync(path.join(this.dir, name));
      return { name, kind: name.startsWith('auto') ? 'auto' : 'pre-restore', size: st.size, created: madeAt(name) || st.mtime.toISOString() };
    }).sort((a, b) => b.created.localeCompare(a.created));
  }

  /** Path of a snapshot by name, or null for anything that is not one. */
  file(name) {
    if (!NAME.test(name)) return null;
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? f : null;
  }

  save(kind, backup) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `${kind}-${stamp(this.now())}.json`;
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(backup));
    return name;
  }

  /** Saves backup as today's automatic snapshot, unless one exists or nothing changed since the newest; then prunes. */
  daily(backup) {
    const newest = this.list().find((s) => s.kind === 'auto');
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let saved = null;
    if (newest?.created.slice(0, 10) !== today && !this.#same(newest, backup)) saved = this.save('auto', backup);
    this.prune();
    return saved;
  }

  /** Whether snapshot s holds the same content as backup. */
  #same(s, backup) {
    if (!s) return false;
    try { return fingerprint(JSON.parse(fs.readFileSync(path.join(this.dir, s.name), 'utf8'))) === fingerprint(backup); } catch { return false; }
  }

  prune() {
    const all = this.list();
    const cutoff = this.now() - KEEP_PRE_RESTORE_DAYS * 864e5;
    const doomed = [
      ...all.filter((s) => s.kind === 'auto').slice(KEEP_AUTO),
      ...all.filter((s) => s.kind === 'pre-restore' && Date.parse(s.created) < cutoff),
    ];
    for (const s of doomed) fs.rmSync(path.join(this.dir, s.name), { force: true });
  }
}
