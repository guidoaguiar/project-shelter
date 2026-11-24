#!/usr/bin/env node
// Sets the PIN and LAN write policy of a running Shelter, by talking to it on this machine's
// loopback address, where it always treats the caller as the host. Inside Docker:
//
//   docker exec -it shelter node server/pin.js            choose a new PIN (asks twice)
//   docker exec -it shelter node server/pin.js --policy open|pin|readonly
//   docker exec -it shelter node server/pin.js --remove   remove the PIN (other devices become read-only)
//   docker exec -it shelter node server/pin.js --status
//   ... --setup [--open]   installer step: only acts on a new install with no PIN yet
//
// SHELTER_PIN may carry the PIN instead of the prompt (avoid it: it shows in process lists).
import readline from 'node:readline';
import { PIN_FORMAT } from './access.js';

const PORT = +process.env.PORT || 4077;
const BASE = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  } catch {
    throw new Error(`Shelter is not answering on ${BASE}. Is it running?`);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Reads one line without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) { reject(new Error('no terminal to ask for a PIN: run with docker exec -it, or set SHELTER_PIN')); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (!muted) write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    muted = true;
  });
}

/** A new PIN from SHELTER_PIN or the terminal, asking again until it is valid and repeated. allowEmpty: Enter returns ''. */
async function choosePin(allowEmpty) {
  if (process.env.SHELTER_PIN) return process.env.SHELTER_PIN;
  const pin = await askHidden(allowEmpty ? '    PIN (4-12 digits, Enter to skip): ' : '    New PIN (4-12 digits): ');
  if (!pin && allowEmpty) return '';
  if (!PIN_FORMAT.test(pin)) {
    console.log('    The PIN must be 4 to 12 digits.');
    return choosePin(allowEmpty);
  }
  if (await askHidden('    Repeat the PIN: ') === pin) return pin;
  console.log('    The two PINs differ. Try again.');
  return choosePin(allowEmpty);
}

const describe = (a) => ({
  open: 'OPEN: any device on your network can see and change household data',
  pin: a.pinSet ? 'PIN: other devices need the PIN to see or change household data' : 'PIN (none set yet): other devices are read-only',
  readonly: 'READ-ONLY: only this machine can see and change household data',
}[a.lanWrites]);

async function main() {
  const { access } = await call('GET', '/api/settings');
  if (flag('--status')) { console.log(`    ${describe(access)}`); return; }

  if (flag('--setup')) {
    if (access.lanWrites !== 'pin' || access.pinSet) { console.log(`    Other devices: ${describe(access)}`); return; } // configured before: leave it alone
    if (flag('--open')) {
      await call('PUT', '/api/settings', { access: { lanWrites: 'open' } });
      console.log('    ! No PIN set: any device on your network can see and change household data.');
      console.log('    ! Set one later with the "pin" command, or under Command > Configuration on this machine.');
      return;
    }
    console.log('    Choose a PIN that phones and tablets enter to see and change household data.');
    console.log('    Without one they can still use the manual, map, tools and advisor.');
    const pin = await choosePin(true);
    if (!pin) { console.log('    No PIN set: other devices are read-only until you set one.'); return; }
    await call('PUT', '/api/settings', { access: { pin, lanWrites: 'pin' } });
    console.log('    PIN set.');
    return;
  }

  const policy = option('--policy');
  if (policy) {
    await call('PUT', '/api/settings', { access: { lanWrites: policy } });
  } else if (flag('--remove')) {
    await call('PUT', '/api/settings', { access: { pin: '' } });
  } else {
    // Setting a PIN turns PIN protection on, unless the node is read-only for other devices.
    const pin = await choosePin(false);
    await call('PUT', '/api/settings', { access: { pin, ...(access.lanWrites === 'readonly' ? {} : { lanWrites: 'pin' }) } });
  }
  const after = (await call('GET', '/api/settings')).access;
  console.log(`    ${describe(after)}`);
}

try {
  await main();
} catch (error) {
  console.error(`    x ${error.message}`);
  process.exitCode = 1;
}
