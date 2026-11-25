import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Depot } from '../server/depot.js';
import {
  Content, validateCatalog, mergeCatalog, loadCatalog, diskFit, resumePlan, safeFileName, insideDir, fileFromUrl, allowedUrl, downloadFile, dirSize, RESERVE,
} from '../server/content.js';
import { tmpDir, serve } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GIB = 1024 ** 3;
const quiet = () => {};
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((ok) => setTimeout(ok, 10));
  }
};

// ---------- catalog validation ----------

test('the shipped catalog is valid: every source and item survives validation', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf8'));
  const warnings = [];
  const cat = validateCatalog(raw, 'content.json', (w) => warnings.push(w));
  assert.deepEqual(warnings, []);
  assert.deepEqual(cat.sources.map((s) => s.id), ['kiwix', 'kolibri', 'ollama']);
  for (const s of raw.sources) assert.equal(cat.sources.find((x) => x.id === s.id).items.length, s.items.length, s.id);
  const kiwix = cat.sources[0];
  assert.ok(kiwix.items.every((it) => it.url.startsWith('https://download.kiwix.org/') && it.file.endsWith('.zim') && it.size > 0));
  for (const want of ['wikipedia-en-mini', 'wikipedia-en-nopic', 'wikipedia-en-maxi', 'mdwiki-en', 'ifixit-en', 'wikivoyage-en-nopic', 'gutenberg-en-lcc-u']) {
    assert.ok(kiwix.items.some((it) => it.id === want), want);
  }
  // Every source points at a service in the depot catalog.
  const depot = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'depot.json'), 'utf8'));
  for (const s of cat.sources) assert.ok(depot.some((d) => d.id === s.service), s.service);
});

test('catalog validation drops bad sources and items', () => {
  const warnings = [];
  const cat = validateCatalog({
    allowHosts: ['download.example.org', 'BAD HOST'],
    sources: [
      { id: 'zims', service: 'kiwix', kind: 'file', ext: '.zim', items: [
        { id: 'ok', url: 'https://download.example.org/zim/a_2026-01.zim', size: 10, sha256: 'A'.repeat(64) },
        { id: 'sub', url: 'http://mirror.download.example.org/b.zim' },
        { id: 'other-host', url: 'https://evil.example.com/c.zim' },
        { id: 'file-scheme', url: 'file:///etc/passwd.zim' },
        { id: 'creds', url: 'https://user:pw@download.example.org/d.zim' },
        { id: 'wrong-ext', url: 'https://download.example.org/e.exe' },
        { id: 'traversal', url: 'https://download.example.org/x/..%2F..%2Fetc.zim' },
        { id: 'bad-file', url: 'https://download.example.org/f.zim', file: '../f.zim' },
        { id: 'Bad Id', url: 'https://download.example.org/g.zim' },
        { id: 'ok', url: 'https://download.example.org/dup.zim' },
      ] },
      { id: 'noext', service: 'kiwix', kind: 'file', items: [] },
      { id: 'weird', service: 'kiwix', kind: 'shell', items: [] },
      { id: 'channels', service: 'kolibri', kind: 'kolibri', items: [{ id: 'good', channel: 'a'.repeat(32) }, { id: 'short', channel: 'abc' }, { id: 'inject', channel: `${'a'.repeat(32)}; rm -rf /` }] },
      { id: 'models', service: 'ollama', kind: 'ollama', items: [{ id: 'good', model: 'llama3.2:3b' }, { id: 'ns', model: 'library/qwen2.5:1.5b' }, { id: 'dots', model: '../x' }, { id: 'opt', model: '--help' }] },
    ],
  }, 'test.json', (w) => warnings.push(w));
  assert.deepEqual(cat.allowHosts, ['download.example.org']);
  assert.deepEqual(cat.sources.map((s) => s.id), ['zims', 'channels', 'models']);
  const zims = cat.sources[0];
  assert.deepEqual(zims.items.map((it) => it.id), ['ok', 'sub']);
  assert.equal(zims.items[0].file, 'a_2026-01.zim');
  assert.equal(zims.items[0].sha256, 'a'.repeat(64));
  assert.equal(zims.items[1].sha256, null);
  assert.deepEqual(cat.sources[1].items.map((it) => it.id), ['good']);
  assert.deepEqual(cat.sources[2].items.map((it) => it.id), ['good', 'ns']);
  assert.ok(warnings.length >= 10);
});

test('custom catalog entries replace by id and add sources; custom hosts only widen the list', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'content.json'), JSON.stringify({ allowHosts: ['a.org'], sources: [{ id: 'zims', service: 'kiwix', kind: 'file', ext: '.zim', items: [{ id: 'one', url: 'https://a.org/1.zim' }, { id: 'two', url: 'https://a.org/2.zim' }] }] }));
  fs.writeFileSync(path.join(dir, 'content.custom.json'), JSON.stringify({ allowHosts: ['b.org'], sources: [
    { id: 'zims', service: 'kiwix', kind: 'file', ext: '.zim', items: [{ id: 'two', url: 'https://b.org/2b.zim' }, { id: 'three', url: 'https://a.org/3.zim' }] },
    { id: 'models', service: 'ollama', kind: 'ollama', items: [{ id: 'm', model: 'gemma2:2b' }] },
  ] }));
  const cat = loadCatalog(path.join(dir, 'content.json'), quiet);
  assert.deepEqual(cat.allowHosts, ['a.org', 'b.org']);
  assert.deepEqual(cat.sources[0].items.map((it) => [it.id, it.file, !!it.custom]), [['one', '1.zim', false], ['two', '2b.zim', true], ['three', '3.zim', true]]);
  assert.equal(cat.sources[1].items[0].custom, true);
  const base = validateCatalog({ allowHosts: ['a.org'], sources: [] }, 'x', quiet);
  assert.deepEqual(mergeCatalog(base, base), base);
});

// ---------- pure helpers ----------

test('disk fit: refuse what does not fit, warn when it leaves less than the reserve', () => {
  assert.deepEqual(diskFit(5 * GIB, 10 * GIB), { fits: true, tight: false, need: 5 * GIB, free: 10 * GIB, after: 5 * GIB });
  assert.equal(diskFit(9.5 * GIB, 10 * GIB).tight, true);
  assert.equal(diskFit(9.5 * GIB, 10 * GIB).fits, true);
  assert.equal(diskFit(11 * GIB, 10 * GIB).fits, false);
  assert.equal(diskFit(10 * GIB, 10 * GIB).fits, true);
  assert.equal(diskFit(1, 100, 10).tight, false);
  assert.equal(diskFit(95, 100, 10).tight, true);
  assert.equal(diskFit(-5, 100).need, 0);
  assert.equal(diskFit(5, Number.NaN).fits, true, 'unknown free space never blocks');
  assert.equal(RESERVE, GIB);
});

test('path safety: file names and the content folder', (t) => {
  for (const ok of ['wikipedia_en_all_mini_2026-09.zim', 'A.zim', 'x-1.2_b.ZIM']) assert.equal(safeFileName(ok, '.zim'), ok);
  for (const bad of ['../x.zim', '..\\x.zim', 'a/b.zim', 'a\\b.zim', '.hidden.zim', '/etc/x.zim', 'C:\\x.zim', 'a..b.zim', 'x.zim.exe', '', 'x y.zim', 'x\0.zim']) {
    assert.equal(safeFileName(bad, '.zim'), null, bad);
  }
  const dir = tmpDir(t);
  assert.equal(insideDir(dir, 'a.zim'), path.join(path.resolve(dir), 'a.zim'));
  assert.equal(insideDir(dir, '.a.zim.part'), path.join(path.resolve(dir), '.a.zim.part'));
  for (const bad of ['../a.zim', '..', '.', '', 'sub/a.zim', 'sub\\a.zim', path.resolve(dir, '..', 'a.zim'), '/a.zim']) {
    assert.throws(() => insideDir(dir, bad), { status: 400 }, bad);
  }
  assert.equal(fileFromUrl('https://h.org/zim/wikipedia/w_2026-01.zim?x=1', '.zim'), 'w_2026-01.zim');
  assert.equal(fileFromUrl('https://h.org/zim/..%2Fpasswd.zim', '.zim'), null);
  assert.equal(fileFromUrl('https://h.org/zim/a%5Cb.zim', '.zim'), null);
  assert.equal(fileFromUrl('not a url', '.zim'), null);
  assert.equal(allowedUrl('https://h.org/a', ['h.org']), true);
  assert.equal(allowedUrl('https://xh.org/a', ['h.org']), false);
  assert.equal(allowedUrl('ftp://h.org/a', ['h.org']), false);
  assert.equal(allowedUrl('javascript:alert(1)', ['h.org']), false);
});

test('resume plan: append, restart, complete and errors', () => {
  assert.deepEqual(resumePlan(200, { contentLength: '100' }, 0), { mode: 'restart', total: 100 });
  assert.deepEqual(resumePlan(200, { contentLength: '100' }, 40), { mode: 'restart', total: 100 }, 'server ignored Range');
  assert.deepEqual(resumePlan(206, { contentRange: 'bytes 40-99/100' }, 40), { mode: 'append', total: 100 });
  assert.deepEqual(resumePlan(206, { contentRange: 'bytes 40-99/*' }, 40), { mode: 'append', total: null });
  assert.deepEqual(resumePlan(206, { contentRange: 'bytes 0-99/100' }, 40), { mode: 'restart', total: null });
  assert.equal(resumePlan(206, { contentRange: 'garbage' }, 40).mode, 'error');
  assert.deepEqual(resumePlan(416, { contentRange: 'bytes */100' }, 100), { mode: 'complete', total: 100 });
  assert.deepEqual(resumePlan(416, { contentRange: 'bytes */100' }, 150), { mode: 'restart', total: null });
  assert.deepEqual(resumePlan(404, {}, 0), { mode: 'error', error: 'HTTP 404' });
});

// ---------- downloads against a local server ----------

const BODY = crypto.randomBytes(256 * 1024 + 17);
const SUM = crypto.createHash('sha256').update(BODY).digest('hex');

/** Serves BODY at /file.zim with Range support; opts change the behaviour per test. */
async function fileServer(t, opts = {}) {
  const log = [];
  const url = await serve(t, (req, res) => {
    log.push({ url: req.url, range: req.headers.range || null });
    if (req.url === '/file.zim.sha256') {
      if (opts.noSidecar) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(`${opts.badSum ? 'f'.repeat(64) : SUM}  file.zim\n`); return;
    }
    if (req.url !== '/file.zim') { res.writeHead(404); res.end(); return; }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (m && !opts.ignoreRange) {
      const a = Number(m[1]);
      if (a >= BODY.length) { res.writeHead(416, { 'content-range': `bytes */${BODY.length}` }); res.end(); return; }
      res.writeHead(206, { 'content-length': BODY.length - a, 'content-range': `bytes ${a}-${BODY.length - 1}/${BODY.length}` });
      res.end(BODY.subarray(a));
      return;
    }
    res.writeHead(200, { 'content-length': BODY.length });
    // A link that drops mid-transfer: send part of the file, then cut the connection.
    if (opts.cutAt) { res.write(BODY.subarray(0, opts.cutAt)); setTimeout(() => res.destroy(), 100); return; }
    res.end(BODY);
  });
  return { url: `${url}/file.zim`, base: url, log };
}

test('downloadFile: a fresh download, then resuming a partial file with a Range request', async (t) => {
  const dir = tmpDir(t);
  const srv = await fileServer(t);
  const part = path.join(dir, '.file.zim.part');
  const seen = [];
  const r = await downloadFile(srv.url, part, { onProgress: (p) => seen.push(p) });
  assert.deepEqual(r, { size: BODY.length, total: BODY.length });
  assert.ok(fs.readFileSync(part).equals(BODY));
  assert.equal(seen.at(-1).bytes, BODY.length);

  fs.writeFileSync(part, BODY.subarray(0, 1000));
  await downloadFile(srv.url, part);
  assert.equal(srv.log.at(-1).range, 'bytes=1000-');
  assert.ok(fs.readFileSync(part).equals(BODY), 'appended the rest');

  // Already complete: the server answers 416 and nothing changes.
  const done = await downloadFile(srv.url, part);
  assert.equal(done.size, BODY.length);
  assert.ok(fs.readFileSync(part).equals(BODY));
});

test('downloadFile: a server that ignores Range restarts from zero; a part longer than the file restarts', async (t) => {
  const dir = tmpDir(t);
  const part = path.join(dir, '.file.zim.part');
  const srv = await fileServer(t, { ignoreRange: true });
  fs.writeFileSync(part, Buffer.alloc(500, 1));
  await downloadFile(srv.url, part);
  assert.ok(fs.readFileSync(part).equals(BODY));

  const srv2 = await fileServer(t);
  fs.writeFileSync(part, Buffer.concat([BODY, Buffer.alloc(10)]));
  await downloadFile(srv2.url, part);
  assert.deepEqual(srv2.log.map((l) => l.range), [`bytes=${BODY.length + 10}-`, null]);
  assert.ok(fs.readFileSync(part).equals(BODY));
});

test('downloadFile: an interrupted transfer keeps its part and resumes; beforeWrite can refuse', async (t) => {
  const dir = tmpDir(t);
  const part = path.join(dir, '.file.zim.part');
  const cut = await fileServer(t, { cutAt: 100_000 });
  await assert.rejects(downloadFile(cut.url, part));
  const kept = fs.statSync(part).size;
  assert.ok(kept > 0 && kept <= 100_000, `kept ${kept}`);
  const srv = await fileServer(t);
  await downloadFile(srv.url, part);
  assert.equal(srv.log[0].range, `bytes=${kept}-`);
  assert.ok(fs.readFileSync(part).equals(BODY));

  const other = path.join(dir, '.other.part');
  await assert.rejects(downloadFile(srv.url, other, { beforeWrite: async (n) => { throw new Error(`no room for ${n}`); } }), /no room for 262161/);
  assert.equal(fs.existsSync(other), false);
  await assert.rejects(downloadFile(`${srv.base}/missing.zim`, other), /HTTP 404/);
});

// ---------- the manager ----------

const SERVICES = [
  { id: 'kiwix', image: 'k/k:1', port: 8090, containerPort: 8080, volume: '/data', needsFiles: '.zim' },
  { id: 'kolibri', image: 'k/o:1', port: 8300, containerPort: 8080, volume: '/root/.kolibri' },
  { id: 'ollama', image: 'o/o:1', port: 11_434, containerPort: 11_434, volume: '/root/.ollama' },
];

/** A Content manager over temporary config, a Depot with a fake Docker CLI, and a local download server. */
async function setup(t, { free = 100 * GIB, srvOpts = {}, size = BODY.length, sha256, ollama } = {}) {
  const dir = tmpDir(t);
  const srv = await fileServer(t, srvOpts);
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'depot.json'), JSON.stringify(SERVICES));
  fs.writeFileSync(path.join(dir, 'config', 'content.json'), JSON.stringify({
    allowHosts: ['127.0.0.1'],
    sources: [
      { id: 'zims', service: 'kiwix', kind: 'file', ext: '.zim', checksum: 'sidecar', items: [{ id: 'f', title: 'File', url: srv.url, size, sha256 }] },
      { id: 'channels', service: 'kolibri', kind: 'kolibri', items: [{ id: 'ka', title: 'KA', channel: 'c9d7f950ab6b5a1199e3d6c10d7f0103', size: 1000 }] },
      { id: 'models', service: 'ollama', kind: 'ollama', items: [{ id: 'small', title: 'Small', model: 'llama3.2:1b', size: 1000 }] },
    ],
  }));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'version') return { code: 0, out: '27.0.0', err: '' };
    if (args[0] === 'ps') return { code: 0, out: 'kolibri\trunning\tUp', err: '' };
    if (args[0] === 'inspect') return { code: 0, out: 'running', err: '' };
    if (args.includes('listchannels')) return { code: 0, out: 'Pos ID Name\n1 c9d7f950ab6b5a1199e3d6c10d7f0103 Khan Academy', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const depot = new Depot(path.join(dir, 'config', 'depot.json'), path.join(dir, 'data'), '127.0.0.1', { run });
  const ollamaUrl = ollama ? await serve(t, ollama) : 'http://127.0.0.1:9';
  const content = new Content(path.join(dir, 'config', 'content.json'), depot, { ollamaUrl: () => ollamaUrl, space: async () => ({ free, total: 200 * GIB }), warn: quiet });
  const zimDir = depot.volumeDir(depot.catalog[0]);
  return { content, depot, srv, calls, zimDir };
}

const settle = (content, key) => until(() => content.jobs.get(key)?.state !== 'running');

test('manager: download, verify the published checksum, list it, then delete it', async (t) => {
  const { content, srv, zimDir } = await setup(t);
  const job = await content.download({ source: 'zims', item: 'f' });
  assert.equal(job.state, 'running');
  assert.equal(job.controller, undefined, 'the abort controller is not exposed');
  await assert.rejects(content.download({ source: 'zims', item: 'f' }), { status: 409 });
  await settle(content, 'zims/f');
  const done = content.job('zims/f');
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.verified, true);
  assert.match(done.note, /Restart/);
  assert.ok(srv.log.some((l) => l.url === '/file.zim.sha256'));
  assert.ok(fs.readFileSync(path.join(zimDir, 'file.zim')).equals(BODY));
  assert.equal(fs.existsSync(path.join(zimDir, '.file.zim.part')), false);

  fs.writeFileSync(path.join(zimDir, 'mine.zim'), 'x');
  fs.writeFileSync(path.join(zimDir, 'notes.txt'), 'x');
  const list = await content.list();
  const zims = list.sources.find((s) => s.id === 'zims');
  assert.equal(zims.items[0].installed, true);
  assert.equal(zims.items[0].installedSize, BODY.length);
  assert.deepEqual(zims.local.map((f) => [f.file, f.inCatalog]), [['file.zim', true], ['mine.zim', false]]);
  assert.ok(list.usage.kiwix >= BODY.length);
  assert.equal(list.disk.free, 100 * GIB);
  assert.equal(list.sources.find((s) => s.id === 'channels').items[0].installed, true, 'from kolibri listchannels');
  assert.equal(list.sources.find((s) => s.id === 'models').reachable, false, 'Ollama is not running');

  await assert.rejects(content.download({ source: 'zims', item: 'f' }), { status: 409, message: /already downloaded/ });
  await content.remove({ source: 'zims', item: 'f' });
  assert.equal(fs.existsSync(path.join(zimDir, 'file.zim')), false);
  await content.remove({ source: 'zims', file: 'mine.zim' });
  assert.equal(fs.existsSync(path.join(zimDir, 'mine.zim')), false);
  for (const file of ['../config/depot.json', '..\\x.zim', 'notes.txt', '.file.zim.part', 'sub/x.zim']) {
    await assert.rejects(content.remove({ source: 'zims', file }), { status: 400 }, file);
  }
  assert.ok(fs.existsSync(path.join(zimDir, 'notes.txt')));
});

test('manager: a checksum mismatch removes the file; no published checksum still installs', async (t) => {
  const bad = await setup(t, { srvOpts: { badSum: true } });
  await bad.content.download({ source: 'zims', item: 'f' });
  await settle(bad.content, 'zims/f');
  assert.equal(bad.content.job('zims/f').state, 'error');
  assert.match(bad.content.job('zims/f').error, /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(bad.zimDir), []);

  const none = await setup(t, { srvOpts: { noSidecar: true } });
  await none.content.download({ source: 'zims', item: 'f' });
  await settle(none.content, 'zims/f');
  assert.equal(none.content.job('zims/f').state, 'done');
  assert.equal(none.content.job('zims/f').verified, false);

  const pinned = await setup(t, { sha256: SUM, srvOpts: { badSum: true } });
  await pinned.content.download({ source: 'zims', item: 'f' });
  await settle(pinned.content, 'zims/f');
  assert.equal(pinned.content.job('zims/f').verified, true, 'a checksum in the catalog wins over the sidecar');
});

test('manager: refuses downloads that do not fit, and asks before ones that leave little space', async (t) => {
  const small = await setup(t, { free: 100_000 });
  await assert.rejects(small.content.download({ source: 'zims', item: 'f' }), { status: 507, message: /not enough disk space/ });
  assert.equal(small.content.jobs.size, 0);

  const tight = await setup(t, { free: BODY.length + 1000 });
  await assert.rejects(tight.content.download({ source: 'zims', item: 'f' }), { status: 409, message: /low disk space/ });
  await assert.rejects(tight.content.download({ source: 'zims', item: 'f', force: 'yes' }), { status: 409 }, 'force must be true');
  await tight.content.download({ source: 'zims', item: 'f', force: true });
  await settle(tight.content, 'zims/f');
  assert.equal(tight.content.job('zims/f').state, 'done');

  // The catalog size was an underestimate: the real size from the server is checked again.
  const under = await setup(t, { free: 50_000 + RESERVE, size: 10 });
  await under.content.download({ source: 'zims', item: 'f' });
  await settle(under.content, 'zims/f');
  assert.match(under.content.job('zims/f').error, /low disk space/);
  const none = await setup(t, { free: 50_000, size: 10 });
  await none.content.download({ source: 'zims', item: 'f', force: true });
  await settle(none.content, 'zims/f');
  assert.match(none.content.job('zims/f').error, /not enough disk space/);
});

test('manager: cancel keeps the partial file, a second download resumes it', async (t) => {
  const { content, srv, zimDir } = await setup(t, { srvOpts: { cutAt: 50_000 } });
  await content.download({ source: 'zims', item: 'f' });
  await settle(content, 'zims/f');
  assert.equal(content.job('zims/f').state, 'error');
  const kept = fs.statSync(path.join(zimDir, '.file.zim.part')).size;
  assert.ok(kept > 0);
  const list = await content.list();
  assert.equal(list.sources[0].items[0].partial, kept);

  // Cancelling a running job.
  const slow = await setup(t);
  slow.content.fetch = async (url, init) => {
    if (url.endsWith('.sha256')) return fetch(url, init);
    await new Promise((ok, fail) => {
      if (init.signal.aborted) fail(new Error('aborted'));
      init.signal.addEventListener('abort', () => fail(new Error('aborted')));
    });
  };
  await slow.content.download({ source: 'zims', item: 'f' });
  assert.deepEqual(slow.content.cancel({ source: 'zims', item: 'f' }), { ok: true });
  await settle(slow.content, 'zims/f');
  assert.equal(slow.content.job('zims/f').state, 'cancelled');

  srv.log.length = 0;
  await assert.rejects(content.download({ source: 'nope', item: 'f' }), { status: 404 });
  await assert.rejects(content.download({ source: 'zims', item: 'nope' }), { status: 404 });
});

test('manager: Kolibri imports run docker exec with an argv array; Ollama pulls report progress', async (t) => {
  const pulls = [];
  const { content, calls } = await setup(t, {
    ollama: (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        pulls.push({ method: req.method, url: req.url, body: JSON.parse(body || '{}') });
        if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'llama3.2:1b', size: 1234 }] })); return; }
        if (req.url === '/api/delete') { res.end(); return; }
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total: 2000, completed: 500 })}\n`);
        res.write(`${JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total: 2000, completed: 2000 })}\n`);
        res.end(`${JSON.stringify({ status: 'success' })}\n`);
      });
    },
  });
  await content.download({ source: 'channels', item: 'ka' });
  await settle(content, 'channels/ka');
  assert.equal(content.job('channels/ka').state, 'done', content.job('channels/ka').error);
  const execs = calls.filter((c) => c[0] === 'exec' && !c.includes('listchannels'));
  assert.deepEqual(execs, [
    ['exec', 'shelter-kolibri', 'kolibri', 'manage', 'importchannel', 'network', 'c9d7f950ab6b5a1199e3d6c10d7f0103'],
    ['exec', 'shelter-kolibri', 'kolibri', 'manage', 'importcontent', 'network', 'c9d7f950ab6b5a1199e3d6c10d7f0103'],
  ]);

  await content.download({ source: 'models', item: 'small' });
  await settle(content, 'models/small');
  const job = content.job('models/small');
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.bytes, 2000);
  assert.equal(job.total, 2000);
  assert.deepEqual(pulls.find((p) => p.url === '/api/pull').body, { model: 'llama3.2:1b', name: 'llama3.2:1b', stream: true });
  const list = await content.list();
  assert.equal(list.sources.find((s) => s.id === 'models').items[0].installed, true);
  await content.remove({ source: 'models', item: 'small' });
  assert.equal(pulls.at(-1).method, 'DELETE');
  await content.remove({ source: 'channels', item: 'ka' });
  assert.deepEqual(calls.at(-1), ['exec', 'shelter-kolibri', 'kolibri', 'manage', 'deletechannel', 'c9d7f950ab6b5a1199e3d6c10d7f0103']);
});

test('dirSize adds up files in nested folders', async (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, 'a', 'b', 'y'), Buffer.alloc(32));
  assert.equal(await dirSize(dir), 42);
  assert.equal(await dirSize(path.join(dir, 'missing')), 0);
});
