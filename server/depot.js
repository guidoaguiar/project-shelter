// Depot: runs a fixed catalog of containerized services through the Docker CLI.
// Only images listed in config/depot.json can be started; arguments are passed
// as an argv array (never through a shell).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn('docker', args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out, err: e.message }); }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

/** Joins path segments in the host's style, which may differ from this process's (a Windows host behind a Linux container). */
function joinHost(root, ...parts) {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

/** Keeps only well-formed catalog entries; ids become container names and URL segments. */
function validate(entries, source) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const ok = e && /^[a-z0-9][a-z0-9-]{0,40}$/.test(e.id || '') && typeof e.image === 'string' && /^[A-Za-z0-9_.\-/:@]+$/.test(e.image)
      && Number.isInteger(e.port) && e.port > 0 && e.port < 65536 && Number.isInteger(e.containerPort);
    if (ok) out.push({ ...e, name: String(e.name || e.id).toUpperCase(), title: String(e.title || 'Service'), desc: String(e.desc || ''), category: String(e.category || 'OTHER').toUpperCase() });
    else console.warn(`depot: skipped invalid entry in ${source}: ${JSON.stringify(e?.id ?? e)}`);
  }
  return out;
}

export class Depot {
  /**
   * hostDataDir: the data folder as the Docker host sees it, when Shelter itself runs in a container.
   * bindRoot: overrides where Docker finds depot folders (Docker Desktop on Windows needs /run/desktop/mnt/host/...).
   */
  constructor(catalogFile, dataDir, bindHost, { hostDataDir = '', bindRoot = '' } = {}) {
    this.catalog = validate(JSON.parse(fs.readFileSync(catalogFile, 'utf8')), path.basename(catalogFile));
    // Optional user additions: config/depot.custom.json, same format. Entries with a matching id replace the built-in one.
    const customFile = path.join(path.dirname(catalogFile), 'depot.custom.json');
    if (fs.existsSync(customFile)) {
      try {
        for (const e of validate(JSON.parse(fs.readFileSync(customFile, 'utf8')), 'depot.custom.json')) {
          const i = this.catalog.findIndex((x) => x.id === e.id);
          const entry = { ...e, custom: true };
          if (i >= 0) this.catalog[i] = entry; else this.catalog.push(entry);
        }
      } catch (err) { console.warn(`depot: could not read depot.custom.json: ${err.message}`); }
    }
    this.dataDir = dataDir;
    this.hostDataDir = hostDataDir;
    this.bindRoot = bindRoot;
    this.bindHost = bindHost;
    this.jobs = new Map(); // id -> { state: 'working'|'error', message }
    this.dockerCache = { at: 0, value: { online: false, version: null } };
  }

  async docker() {
    if (Date.now() - this.dockerCache.at < 10000) return this.dockerCache.value;
    const r = await run(['version', '--format', '{{.Server.Version}}'], 5000);
    const value = r.code === 0 && r.out ? { online: true, version: r.out } : { online: false, version: null };
    this.dockerCache = { at: Date.now(), value };
    return value;
  }

  /** The service folder as this process sees it. */
  volumeDir(svc) { return path.join(this.dataDir, 'depot', svc.id); }

  /** The service folder as the person sees it on the host (shown in the interface). */
  displayDir(svc) { return this.hostDataDir ? joinHost(this.hostDataDir, 'depot', svc.id) : this.volumeDir(svc); }

  /** The service folder as the Docker daemon resolves it. */
  bindDir(svc) {
    if (this.bindRoot) return joinHost(this.bindRoot, svc.id);
    if (this.hostDataDir) return joinHost(this.hostDataDir, 'depot', svc.id);
    return this.volumeDir(svc);
  }

  /** [local folder, bind source, container path]. "volume" mounts the service folder itself; "volumes" mounts named subfolders. */
  mounts(svc) {
    const out = [];
    if (typeof svc.volume === 'string') out.push([this.volumeDir(svc), this.bindDir(svc), svc.volume]);
    for (const [name, target] of Object.entries(svc.volumes || {})) {
      if (/^[a-z0-9-]+$/.test(name) && typeof target === 'string' && target.startsWith('/')) {
        out.push([path.join(this.volumeDir(svc), name), joinHost(this.bindDir(svc), name), target]);
      }
    }
    return out;
  }

  /**
   * Run natively, Shelter creates service folders as the logged-in user (usually uid 1000), which is
   * what images that drop root expect. In a container Shelter runs as root, so hand the folders over
   * to that uid. SHELTER_DEPOT_UID changes it; "off" disables it.
   */
  ownFolders(svc, mounts) {
    const setting = process.env.SHELTER_DEPOT_UID || '1000';
    if (setting === 'off' || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    const [uid, gid = uid] = setting.split(':').map(Number);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
    for (const dir of [this.volumeDir(svc), ...mounts.map(([d]) => d)]) {
      try {
        const st = fs.statSync(dir);
        // Only folders still owned by root, so an owner set by the service itself is left alone.
        if (st.uid === 0) fs.chownSync(dir, uid, gid);
      } catch { /* some host filesystems (Docker Desktop on Windows) do not support ownership */ }
    }
  }

  async list() {
    const docker = await this.docker();
    const states = new Map();
    if (docker.online) {
      const r = await run(['ps', '-a', '--filter', 'label=shelter.service', '--format', '{{.Label "shelter.service"}}\t{{.State}}\t{{.Status}}']);
      for (const line of r.out.split('\n')) {
        const [id, state, status] = line.split('\t');
        if (id) states.set(id, { state, status });
      }
    }
    return {
      docker,
      services: this.catalog.map((svc) => ({
        id: svc.id, name: svc.name, title: svc.title, desc: svc.desc, image: svc.image, port: svc.port, note: svc.note || '',
        category: svc.category, custom: !!svc.custom,
        links: (Array.isArray(svc.links) ? svc.links : []).filter((l) => l && /^https?:\/\//.test(l.url || '')).map((l) => ({ label: String(l.label || l.url), url: l.url })),
        dataDir: this.mounts(svc).length ? this.displayDir(svc) : null,
        container: states.get(svc.id) || null,
        job: this.jobs.get(svc.id) || null,
      })),
    };
  }

  async action(id, action) {
    const svc = this.catalog.find((s) => s.id === id);
    if (!svc) throw Object.assign(new Error('unknown service'), { status: 404 });
    if (!(await this.docker()).online) throw Object.assign(new Error('Docker is not running on this host'), { status: 409 });
    if (this.jobs.get(id)?.state === 'working') throw Object.assign(new Error('operation already in progress'), { status: 409 });
    const name = `shelter-${svc.id}`;

    if (action === 'stop' || action === 'remove') {
      const r = await run(action === 'stop' ? ['stop', name] : ['rm', '-f', name], 30000);
      if (r.code !== 0) throw Object.assign(new Error(r.err || 'docker command failed'), { status: 500 });
      this.jobs.delete(id);
      return { ok: true };
    }
    if (action !== 'start') throw Object.assign(new Error('unknown action'), { status: 400 });

    const mounts = this.mounts(svc);
    for (const [dir] of mounts) fs.mkdirSync(dir, { recursive: true });
    this.ownFolders(svc, mounts);
    if (mounts.length) {
      if (svc.needsFiles && !fs.readdirSync(this.volumeDir(svc)).some((f) => f.toLowerCase().endsWith(svc.needsFiles))) {
        throw Object.assign(new Error(`no ${svc.needsFiles} files in ${this.displayDir(svc)} — add content first`), { status: 409 });
      }
    }
    const exists = (await run(['inspect', '--format', '{{.State.Status}}', name])).code === 0;
    let args;
    if (exists) {
      args = ['start', name];
    } else {
      args = ['run', '-d', '--name', name, '--label', `shelter.service=${svc.id}`, '--restart', 'unless-stopped',
        '-p', `${this.bindHost}:${svc.port}:${svc.containerPort}`];
      // --mount rather than -v: a Windows host path contains a colon.
      for (const [, source, target] of mounts) args.push('--mount', `type=bind,source=${source},target=${target}`);
      for (const h of svc.extraHosts || []) args.push('--add-host', String(h));
      for (const [k, v] of Object.entries(svc.env || {})) args.push('-e', `${k}=${v}`);
      args.push(svc.image, ...(svc.args || []));
    }
    // Pulling an image can take minutes: run in the background and report through list().
    this.jobs.set(id, { state: 'working', message: exists ? 'starting' : 'pulling image / starting' });
    run(args, 30 * 60 * 1000).then((r) => {
      if (r.code === 0) this.jobs.delete(id);
      else this.jobs.set(id, { state: 'error', message: (r.err || 'docker run failed').split('\n').slice(-3).join(' ').slice(0, 400) });
    });
    return { ok: true, started: true };
  }
}
