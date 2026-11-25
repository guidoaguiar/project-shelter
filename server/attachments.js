// Log attachments: images (a wound, storm damage) stored as files under <data>/attachments.
// Only JPEG, PNG, WebP and GIF are accepted, recognised by their first bytes rather than by what the
// client says; files are named by the server (<uuid>.<ext>) so a name can never point elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_PER_NOTE = 12;
export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
/** A stored attachment's file name. */
export const ATTACHMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|gif)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The image type of buf from its signature bytes, or null for anything else. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const gif = buf.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return null;
}

/** Bytes of a base64 string (a data: URL prefix is allowed). Throws a 400 error when it is not base64. */
export function decodeBase64(data) {
  if (typeof data !== 'string' || !data) throw fail(400, 'data: an image is required');
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  const b64 = (comma >= 0 ? data.slice(comma + 1) : data).replaceAll(/\s/g, '');
  if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw fail(413, `the image is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  if (!BASE64.test(b64)) throw fail(400, 'data: not base64');
  return Buffer.from(b64, 'base64');
}

/** The bytes of one image from a backup, or null when its name, encoding, size or type is wrong. */
function backupImage(name, data) {
  if (!ATTACHMENT_NAME.test(name)) return null;
  let buf;
  try { buf = decodeBase64(data); } catch { return null; }
  if (buf.length > MAX_BYTES) return null;
  const type = sniffImage(buf);
  return type && IMAGE_TYPES[type] === name.split('.').pop() ? buf : null;
}

export class Attachments {
  constructor(dir) { this.dir = dir; }

  /** Path of a stored attachment, or null when the name is not one or the file is missing. */
  file(name) {
    if (!ATTACHMENT_NAME.test(String(name))) return null;
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? f : null;
  }

  /** Stores an image. Returns the record a note keeps: { file, name, type, size }. */
  save(name, data) {
    const buf = decodeBase64(data);
    if (buf.length > MAX_BYTES) throw fail(413, `the image is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    const type = sniffImage(buf);
    if (!type) throw fail(415, 'only JPEG, PNG, WebP and GIF images can be attached');
    const file = `${crypto.randomUUID()}.${IMAGE_TYPES[type]}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, file + '.tmp'), buf);
    fs.renameSync(path.join(this.dir, file + '.tmp'), path.join(this.dir, file));
    const label = [...String(name ?? '')].filter((c) => c >= ' ' && c !== '\u007f').join('').trim().slice(0, 120) || file;
    return { file, name: label, type, size: buf.length };
  }

  /** Removes the named files that no remaining note refers to. */
  removeUnreferenced(files, notes) {
    const used = new Set(notes.flatMap((n) => (n.attachments || []).map((a) => a.file)));
    for (const f of files) {
      const p = this.file(f);
      if (p && !used.has(f)) fs.rmSync(p, { force: true });
    }
  }

  /** Files of attachments for a backup: { name: base64 }, stopping before maxBytes. Also lists what did not fit. */
  exportAll(notes, maxBytes) {
    const files = {}, omitted = [];
    let total = 0;
    const names = [...new Set(notes.flatMap((n) => (n.attachments || []).map((a) => a.file)))];
    for (const name of names) {
      const p = this.file(name);
      if (!p) continue;
      const size = fs.statSync(p).size;
      if (total + size > maxBytes) { omitted.push(name); continue; }
      files[name] = fs.readFileSync(p).toString('base64');
      total += size;
    }
    return { files, omitted };
  }

  /** Writes attachment files from a backup that this node does not have. Returns { add, skip, invalid }. */
  importAll(files, dryRun = false) {
    const report = { add: 0, skip: 0, invalid: 0 };
    for (const [name, data] of Object.entries(files && typeof files === 'object' ? files : {})) {
      const buf = backupImage(name, data);
      if (!buf) { report.invalid++; continue; }
      if (this.file(name)) { report.skip++; continue; }
      if (!dryRun) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, name), buf);
      }
      report.add++;
    }
    return report;
  }
}
