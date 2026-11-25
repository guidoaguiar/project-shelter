// Host telemetry: CPU, memory, disk, LAN addresses and an uplink probe. Low-power mode samples less often.
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';

let cpuLoad = 0;
let last = snapshot();

function snapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function sample() {
  const now = snapshot();
  const dt = now.total - last.total;
  if (dt > 0) cpuLoad = 1 - (now.idle - last.idle) / dt;
  last = now;
}

// Uplink probe: a bare TCP connect, no payload. Disable with SHELTER_NET_CHECK=off.
const uplink = { online: false, checkedAt: null, enabled: process.env.SHELTER_NET_CHECK !== 'off' };
function probe() {
  const [host, port] = (process.env.SHELTER_NET_CHECK || '1.1.1.1:443').split(':');
  const sock = net.connect({ host, port: +port || 443, timeout: 2500 });
  const done = (ok) => { uplink.online = ok; uplink.checkedAt = new Date().toISOString(); sock.destroy(); };
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
}

/** Sampling rates in ms, normally and in low-power mode. */
export const SAMPLE_EVERY = { normal: { cpu: 2000, uplink: 60_000 }, low: { cpu: 60_000, uplink: 300_000 } };
const timers = { cpu: null, uplink: null };
let lowPower = null;

/** Sets how often the CPU sampler and the uplink probe run. Low-power mode slows both down. */
export function setLowPower(on) {
  if (lowPower === !!on) return;
  lowPower = !!on;
  const every = lowPower ? SAMPLE_EVERY.low : SAMPLE_EVERY.normal;
  clearInterval(timers.cpu);
  timers.cpu = setInterval(sample, every.cpu);
  timers.cpu.unref();
  if (uplink.enabled) {
    clearInterval(timers.uplink);
    timers.uplink = setInterval(probe, every.uplink);
    timers.uplink.unref();
  }
}
export const isLowPower = () => !!lowPower;

setLowPower(false);
if (uplink.enabled) probe();

export function systemStatus(dataDir) {
  let disk = null;
  try {
    const s = fs.statfsSync(dataDir);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { /* statfs unavailable */ }
  // In a bridged container the interfaces are Docker's, so the installer passes the host's addresses.
  const lan = (process.env.SHELTER_HOST_LAN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!lan.length) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) lan.push(i.address);
    }
  }
  return {
    system: {
      host: process.env.SHELTER_HOSTNAME || os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version,
      uptime: os.uptime(), cores: os.cpus().length, cpu: +cpuLoad.toFixed(3),
      memTotal: os.totalmem(), memFree: os.freemem(), disk, lan, lowPower: isLowPower(),
    },
    net: { ...uplink },
  };
}
