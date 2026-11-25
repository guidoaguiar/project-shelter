// Optional HTTPS: phones only allow GPS (navigator.geolocation) and service workers in a secure
// context, which over a LAN means HTTPS. Shelter makes a self-signed certificate with the system's
// openssl the first time it is needed and keeps it in <data>/tls. No npm packages are involved.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CERT_NAME = 'Shelter field node';
const DAY = 864e5;
/** Days a generated certificate is valid. Apple devices refuse server certificates valid for longer than 825 days. */
export const CERT_DAYS = 825;

/** Whether HTTPS was asked for: the --https flag or SHELTER_HTTPS=1 (or "true"). */
export const httpsRequested = (argv = process.argv, env = process.env) =>
  argv.includes('--https') || ['1', 'true', 'yes', 'on'].includes(String(env.SHELTER_HTTPS || '').toLowerCase());

/**
 * Where the key and certificate live. SHELTER_TLS_KEY and SHELTER_TLS_CERT point at your own pair
 * (own: true, never replaced); otherwise <data>/tls/key.pem and cert.pem, generated on demand.
 */
export function certPaths(dataDir, env = process.env) {
  if (env.SHELTER_TLS_KEY && env.SHELTER_TLS_CERT) {
    return { dir: path.dirname(path.resolve(env.SHELTER_TLS_CERT)), key: path.resolve(env.SHELTER_TLS_KEY), cert: path.resolve(env.SHELTER_TLS_CERT), own: true };
  }
  const dir = path.join(dataDir, 'tls');
  return { dir, key: path.join(dir, 'key.pem'), cert: path.join(dir, 'cert.pem'), own: false };
}

/**
 * The names and addresses the certificate must cover: localhost, the loopback addresses, the
 * machine's host name (and its .local mDNS name) and every LAN address clients may use.
 */
export function certHosts({ lan = [], hostname = '', extra = [] } = {}) {
  const names = ['localhost', '127.0.0.1', '::1', ...lan, ...extra];
  const host = String(hostname || '').trim().toLowerCase();
  if (host && /^[a-z0-9][a-z0-9.-]*$/.test(host)) names.push(host, ...(host.includes('.') ? [] : [`${host}.local`]));
  return [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
}

/** subjectAltName value for openssl: DNS: entries for names, IP: entries for addresses. */
export const subjectAltName = (hosts) => hosts.map((h) => (net.isIP(h) ? `IP:${h}` : `DNS:${h}`)).join(',');

/** openssl arguments for a self-signed certificate and unencrypted key (OpenSSL 1.1.1 or newer). */
export function opensslArgs({ key, cert, hosts, days = CERT_DAYS }) {
  return [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(days),
    '-keyout', key, '-out', cert, '-subj', `/CN=${CERT_NAME}`,
    '-addext', `subjectAltName=${subjectAltName(hosts)}`,
    '-addext', 'extendedKeyUsage=serverAuth',
  ];
}

/**
 * Whether a certificate still serves: readable, valid for at least another week, and covering
 * every host in hosts. Returns { ok, reason }.
 */
export function certCovers(pem, hosts, now = Date.now()) {
  let x509;
  try { x509 = new crypto.X509Certificate(pem); } catch { return { ok: false, reason: 'unreadable certificate' }; }
  if (Date.parse(x509.validTo) < now + 7 * DAY) return { ok: false, reason: 'certificate expires soon' };
  const missing = hosts.filter((h) => !(net.isIP(h) ? x509.checkIP(h) : x509.checkHost(h)));
  return missing.length ? { ok: false, reason: `certificate does not cover ${missing.join(', ')}` } : { ok: true };
}

/** SHA-256 fingerprint of a PEM certificate ("AB:CD:…"), for checking it on a phone. */
export const fingerprint = (pem) => new crypto.X509Certificate(pem).fingerprint256;

const OPENSSL_MISSING = (dir) => [
  'HTTPS needs a certificate and openssl was not found to make one.',
  'Install OpenSSL (on Windows it comes with Git for Windows), or put your own key.pem and cert.pem',
  `in ${dir}, or set SHELTER_TLS_KEY and SHELTER_TLS_CERT. Serving plain HTTP for now.`,
].join('\n  ');

/**
 * Key and certificate for the HTTPS server: { key, cert, file, fingerprint, created }. Uses your own
 * pair when configured; otherwise reuses <data>/tls when it still covers hosts, else makes a new one
 * with openssl. Throws an Error with a message fit for the console when that is not possible.
 * run: (cmd, args) => void, replaceable in tests.
 */
export function loadCert(dataDir, { hosts = certHosts(), env = process.env, now = Date.now(), run = runOpenssl } = {}) {
  const p = certPaths(dataDir, env);
  if (p.own) {
    try {
      const cert = fs.readFileSync(p.cert, 'utf8');
      return { key: fs.readFileSync(p.key, 'utf8'), cert, file: p.cert, fingerprint: fingerprint(cert), created: false };
    } catch (error) { throw new Error(`cannot read SHELTER_TLS_KEY / SHELTER_TLS_CERT: ${error.message}`, { cause: error }); }
  }
  if (fs.existsSync(p.key) && fs.existsSync(p.cert)) {
    const cert = fs.readFileSync(p.cert, 'utf8');
    if (certCovers(cert, hosts, now).ok) return { key: fs.readFileSync(p.key, 'utf8'), cert, file: p.cert, fingerprint: fingerprint(cert), created: false };
  }
  fs.mkdirSync(p.dir, { recursive: true });
  try { run('openssl', opensslArgs({ key: p.key, cert: p.cert, hosts })); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(OPENSSL_MISSING(p.dir), { cause: error });
    throw new Error(`openssl could not make a certificate: ${String(error.stderr || error.message).trim()}`, { cause: error });
  }
  try { fs.chmodSync(p.key, 0o600); } catch { /* not supported on this file system */ }
  const cert = fs.readFileSync(p.cert, 'utf8');
  return { key: fs.readFileSync(p.key, 'utf8'), cert, file: p.cert, fingerprint: fingerprint(cert), created: true };
}

function runOpenssl(cmd, args) {
  // openssl is found through PATH on purpose.
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
}

/** The host name of this machine (or the one set in SHELTER_HOSTNAME), for the certificate. */
export const machineName = (env = process.env) => env.SHELTER_HOSTNAME || os.hostname();

/** https:// address for a plain-HTTP request that should move to HTTPS, or null when the Host header is unusable. */
export function httpsLocation(req) {
  const host = String(req.headers.host || '');
  if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) return null;
  return `https://${host}${req.url || '/'}`;
}

/**
 * One listening socket that speaks both HTTPS and plain HTTP: a TLS handshake starts with byte 0x16.
 * Plain-HTTP requests go to handler when keepPlain(req) is true (this machine, health checks) and are
 * redirected to HTTPS otherwise, so old http:// bookmarks on phones keep working.
 */
export function dualServer(tls, handler, { keepPlain = () => false } = {}) {
  const secure = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  secure.on('tlsClientError', (_error, socket) => socket.destroy()); // e.g. a phone refusing the self-signed certificate
  const plain = http.createServer((req, res) => {
    if (keepPlain(req)) return handler(req, res);
    const to = httpsLocation(req);
    res.writeHead(to ? 308 : 400, { location: to || '', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(to ? `Shelter uses HTTPS: ${to}\n` : 'bad host\n');
  });
  return net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.once('data', (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
}
