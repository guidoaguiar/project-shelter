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
  constructor(catalogFile, dataDir, bindHost) {
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

  volumeDir(svc) { return path.join(this.dataDir, 'depot', svc.id); }

  /** Host folder to container path pairs. "volume" mounts the service folder itself; "volumes" mounts named subfolders. */
  mounts(svc) {
    const out = [];
    if (typeof svc.volume === 'string') out.push([this.volumeDir(svc), svc.volume]);
    for (const [name, target] of Object.entries(svc.volumes || {})) {
      if (/^[a-z0-9-]+$/.test(name) && typeof target === 'string' && target.startsWith('/')) out.push([path.join(this.volumeDir(svc), name), target]);
    }
    return out;
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
        dataDir: this.mounts(svc).length ? this.volumeDir(svc) : null,
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
    if (mounts.length) {
      if (svc.needsFiles && !fs.readdirSync(this.volumeDir(svc)).some((f) => f.toLowerCase().endsWith(svc.needsFiles))) {
        throw Object.assign(new Error(`no ${svc.needsFiles} files in ${this.volumeDir(svc)} — add content first`), { status: 409 });
      }
    }
    const exists = (await run(['inspect', '--format', '{{.State.Status}}', name])).code === 0;
    let args;
    if (exists) {
      args = ['start', name];
    } else {
      args = ['run', '-d', '--name', name, '--label', `shelter.service=${svc.id}`, '--restart', 'unless-stopped',
        '-p', `${this.bindHost}:${svc.port}:${svc.containerPort}`];
      for (const [dir, target] of mounts) args.push('-v', `${dir}:${target}`);
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
