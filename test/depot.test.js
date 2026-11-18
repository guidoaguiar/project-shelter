import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Depot, joinHost } from '../server/depot.js';
import { tmpDir } from './helpers.js';

const CATALOG = [
  { id: 'kiwix', name: 'kiwix', title: 'Offline wiki', image: 'ghcr.io/kiwix/kiwix-serve:3.7.0', port: 8090, containerPort: 8080, volume: '/data', needsFiles: '.zim', args: ['*.zim'], category: 'reference' },
  { id: 'maps', image: 'example/maps:1', port: 8091, containerPort: 80, volumes: { tiles: '/tiles', 'BAD NAME': '/x', rel: 'not/absolute' }, env: { MODE: 'offline' }, extraHosts: ['host.docker.internal:host-gateway'], links: [{ label: 'Docs', url: 'https://example.org' }, { url: 'javascript:alert(1)' }] },
  { id: 'Bad ID', image: 'x', port: 1, containerPort: 1 },
  { id: 'noport', image: 'x', port: 0, containerPort: 1 },
];

/** A Depot over a temporary catalog, with a fake Docker CLI that records its calls. */
function depot(t, { online = true, exists = false, custom } = {}) {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'depot.json'), JSON.stringify(CATALOG));
  if (custom) fs.writeFileSync(path.join(dir, 'config', 'depot.custom.json'), JSON.stringify(custom));
  const calls = [];
  let release;
  const started = new Promise((ok) => { release = ok; });
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'version') return online ? { code: 0, out: '27.1.0', err: '' } : { code: 1, out: '', err: 'no daemon' };
    if (args[0] === 'inspect') return { code: exists ? 0 : 1, out: '', err: '' };
    if (args[0] === 'ps') return { code: 0, out: 'kiwix\trunning\tUp 2 minutes', err: '' };
    if (args[0] === 'run' || args[0] === 'start') { await started; return { code: 1, out: '', err: 'line 1\nline 2\npull access denied' }; }
    return { code: 0, out: '', err: '' };
  };
  const d = new Depot(path.join(dir, 'config', 'depot.json'), path.join(dir, 'data'), '127.0.0.1', { run });
  return { d, calls, dir, finishBackground: release };
}

test('the catalog keeps only valid entries, and custom entries replace by id', (t) => {
  const { d } = depot(t, { custom: [{ id: 'maps', image: 'mine/maps:2', port: 9000, containerPort: 80 }, { id: 'extra', image: 'mine/extra', port: 9001, containerPort: 80 }] });
  assert.deepEqual(d.catalog.map((s) => [s.id, s.custom ?? false]), [['kiwix', false], ['maps', true], ['extra', true]]);
  assert.equal(d.catalog[0].name, 'KIWIX');
  assert.equal(d.catalog[0].category, 'REFERENCE');
  assert.equal(d.catalog[2].category, 'OTHER');
});

test('list() reports Docker state, containers, links and data folders', async (t) => {
  const { d } = depot(t);
  const { docker, services } = await d.list();
  assert.deepEqual(docker, { online: true, version: '27.1.0' });
  const kiwix = services.find((s) => s.id === 'kiwix');
  assert.deepEqual(kiwix.container, { state: 'running', status: 'Up 2 minutes' });
  assert.ok(kiwix.dataDir.endsWith(path.join('depot', 'kiwix')));
  const maps = services.find((s) => s.id === 'maps');
  assert.deepEqual(maps.links, [{ label: 'Docs', url: 'https://example.org' }]);
  assert.equal(maps.container, null);
});

test('docker run arguments: ports, mounts, env, extra hosts', (t) => {
  const { d } = depot(t);
  const svc = d.catalog.find((s) => s.id === 'maps');
  const args = d.runArgs(svc, d.mounts(svc));
  assert.deepEqual(args.slice(0, 10), ['run', '-d', '--name', 'shelter-maps', '--label', 'shelter.service=maps', '--restart', 'unless-stopped', '-p', '127.0.0.1:8091:80']);
  assert.ok(args.some((a) => a.startsWith('type=bind,source=') && a.endsWith('tiles,target=/tiles')));
  assert.equal(args.filter((a) => a === '--mount').length, 1, 'only well-formed named volumes are mounted');
  assert.deepEqual(args.slice(-5), ['--add-host', 'host.docker.internal:host-gateway', '-e', 'MODE=offline', 'example/maps:1']);
});

test('host paths keep the host style', () => {
  assert.equal(joinHost('C:\\Shelter\\data\\', 'depot', 'kiwix'), 'C:\\Shelter\\data\\depot\\kiwix');
  assert.equal(joinHost('/srv/shelter//', 'depot'), '/srv/shelter/depot');
  assert.equal(joinHost('/', 'x'), '/x');
});

test('actions: unknown service, Docker offline, stop and remove', async (t) => {
  await assert.rejects(depot(t).d.action('nope', 'start'), { status: 404 });
  await assert.rejects(depot(t, { online: false }).d.action('maps', 'start'), { status: 409, message: /not running/ });
  const { d, calls } = depot(t);
  assert.deepEqual(await d.action('maps', 'stop'), { ok: true });
  assert.deepEqual(await d.action('maps', 'remove'), { ok: true });
  await assert.rejects(d.action('maps', 'explode'), { status: 400 });
  assert.deepEqual(calls.filter((c) => c[0] !== 'version'), [['stop', 'shelter-maps'], ['rm', '-f', 'shelter-maps']]);
});

test('start: content check, background job, and its failure', async (t) => {
  const { d, calls, finishBackground } = depot(t);
  await assert.rejects(d.action('kiwix', 'start'), { status: 409, message: /no \.zim files/ });
  fs.writeFileSync(path.join(d.volumeDir(d.catalog[0]), 'wiki.zim'), '');
  assert.deepEqual(await d.action('kiwix', 'start'), { ok: true, started: true });
  assert.deepEqual(d.jobs.get('kiwix'), { state: 'working', message: 'pulling image / starting' });
  await assert.rejects(d.action('kiwix', 'start'), { status: 409, message: /in progress/ });
  assert.equal(calls.at(-1)[0], 'run');
  finishBackground();
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(d.jobs.get('kiwix'), { state: 'error', message: 'line 1 line 2 pull access denied' });
});

test('start an existing container', async (t) => {
  const { d, calls } = depot(t, { exists: true });
  await d.action('maps', 'start');
  assert.deepEqual(calls.at(-1), ['start', 'shelter-maps']);
  assert.equal(d.jobs.get('maps').message, 'starting');
});
