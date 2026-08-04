import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { WebSocket } from 'ws';

function waitForMessage(socket, predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    function onMessage(event) {
      const message = JSON.parse(String(event.data));
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    }
    socket.addEventListener('message', onMessage);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: 'https://amazing-fenglisu-72d040.netlify.app' });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('Render adapter serves health and a shared two-player authoritative stream', { timeout: 15_000 }, async () => {
  const port = 12_000 + (process.pid % 2_000);
  const child = spawn(process.execPath, ['apps/server/render-shim.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      RENDER_REGION: 'frankfurt-test',
      ALLOWED_ORIGINS: 'https://amazing-fenglisu-72d040.netlify.app'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });

  const url = `http://127.0.0.1:${port}`;
  let health;
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch { /* server is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(health, `Render server did not start: ${errors}`);
    assert.equal(health.protocol, 20);
    assert.equal(health.region, 'frankfurt-test');

    const host = await connect(url.replace('http:', 'ws:'));
    const hostJoined = waitForMessage(host, message => message.type === 'joined');
    host.send(JSON.stringify({
      type: 'join', protocol: 20, roomCode: 'RENDERROOM', clientId: 'render-host',
      classId: 'flame', talents: {}
    }));
    const hostResult = await hostJoined;

    const guest = await connect(url.replace('http:', 'ws:'));
    const guestJoined = waitForMessage(guest, message => message.type === 'joined');
    guest.send(JSON.stringify({
      type: 'join', protocol: 20, roomCode: 'RENDERROOM', clientId: 'render-guest',
      classId: 'disc', talents: {}
    }));
    const guestResult = await guestJoined;
    assert.equal(hostResult.instance, guestResult.instance);
    assert.equal(guestResult.region, 'frankfurt-test');

    const hostStart = waitForMessage(host, message => message.type === 'matchStart');
    const guestStart = waitForMessage(guest, message => message.type === 'matchStart');
    host.send(JSON.stringify({ type: 'start' }));
    const [hostMatch, guestMatch] = await Promise.all([hostStart, guestStart]);
    assert.deepEqual(hostMatch.world, guestMatch.world);

    const hostSnapshot = waitForMessage(host, message => message.type === 'snapshot');
    const guestSnapshot = waitForMessage(guest, message => message.type === 'snapshot');
    const [hostWorld, guestWorld] = await Promise.all([hostSnapshot, guestSnapshot]);
    assert.deepEqual(hostWorld.world, guestWorld.world);
    host.close();
    guest.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
});
