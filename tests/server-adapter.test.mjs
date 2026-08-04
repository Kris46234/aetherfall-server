import assert from 'node:assert/strict';
import test from 'node:test';

class FakeSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = FakeSocket.OPEN;
    this.bufferedAmount = 0;
    this.messages = [];
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  send(payload) { this.messages.push(JSON.parse(payload)); }
  close() {
    if (this.readyState !== FakeSocket.OPEN) return;
    this.readyState = 3;
    this.onclose?.();
  }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function last(socket, type) {
  return socket.messages.filter(message => message.type === type).at(-1);
}

test('Deno adapter gives two WebSocket clients one authoritative world and reconnects the same unit', async () => {
  const originalInterval = globalThis.setInterval;
  const originalWebSocket = globalThis.WebSocket;
  const intervals = [];
  let handler = null;
  globalThis.setInterval = callback => { intervals.push(callback); return intervals.length; };
  globalThis.WebSocket = FakeSocket;
  globalThis.Deno = {
    env: { get: key => key === 'DENO_REGION' ? 'eu-test' : undefined },
    serve: callback => { handler = callback; },
    upgradeWebSocket: request => ({ socket: request.socket, response: new Response(null) })
  };
  try {
    await import(`../dist-server/main.js?adapter-test=${Date.now()}`);
  } finally {
    globalThis.setInterval = originalInterval;
  }
  assert.equal(typeof handler, 'function');
  assert.equal(intervals.length, 1);

  const health = await handler(new Request('https://server.example/'));
  const healthBody = await health.json();
  assert.equal(healthBody.service, 'Aetherfall authoritative co-op');
  assert.equal(healthBody.protocol, 20);
  assert.equal(healthBody.tickRate, 30);
  assert.equal(healthBody.snapshotRate, 20);
  assert.equal(healthBody.activeRooms, 0);
  assert.equal(healthBody.region, 'eu-test');
  assert.equal(typeof healthBody.instance, 'string');

  function connect() {
    const socket = new FakeSocket();
    handler({ headers: new Headers({ upgrade: 'websocket' }), socket });
    return socket;
  }

  const host = connect();
  host.receive({ type: 'join', protocol: 20, roomCode: 'EUROOM', clientId: 'host-client', classId: 'flame', talents: {} });
  assert.equal(last(host, 'joined').unitId, 'player1');
  assert.equal(last(host, 'joined').region, 'eu-test');

  const guest = connect();
  guest.receive({ type: 'join', protocol: 20, roomCode: 'EUROOM', clientId: 'guest-client', classId: 'disc', talents: {} });
  const guestJoin = last(guest, 'joined');
  assert.equal(guestJoin.unitId, 'player2');
  assert.equal(last(host, 'lobby').ready, true);
  assert.equal(last(host, 'joined').instance, guestJoin.instance);

  const third = connect();
  third.receive({ type: 'join', protocol: 20, roomCode: 'EUROOM', clientId: 'third-client', classId: 'wind', talents: {} });
  assert.equal(last(third, 'error').reason, 'room_full');

  host.receive({ type: 'start' });
  assert.equal(last(host, 'startAck').ok, true);
  assert.equal(last(host, 'matchStart').phase, 'countdown');
  assert.deepEqual(last(host, 'matchStart').world, last(guest, 'matchStart').world);
  assert.equal(last(host, 'matchStart').world.units.filter(unit => unit.team === 'allies').length, 2);

  host.receive({ type: 'input', sequence: 1, x: 1, z: 0 });
  assert.ok(last(host, 'inputRejected'));
  for (let tick = 0; tick < 95; tick += 1) intervals[0]();
  host.receive({ type: 'input', sequence: 1, x: 1, z: 0 });
  guest.receive({ type: 'input', sequence: 1, x: 1, z: 0 });
  for (let tick = 0; tick < 60; tick += 1) intervals[0]();
  host.receive({ type: 'input', sequence: 2, x: 0, z: 0 });
  host.receive({ type: 'action', sequence: 1, abilityId: 'flame.ember_lance', targetId: 'bot2' });
  assert.equal(last(host, 'actionAck').ok, true);
  for (let tick = 0; tick < 50; tick += 1) intervals[0]();

  const hostWorld = last(host, 'snapshot').world;
  const guestWorld = last(guest, 'snapshot').world;
  assert.deepEqual(hostWorld, guestWorld);
  assert.ok(hostWorld.units.find(unit => unit.id === 'player1').stats.damageByAbility['Ember Lance'] > 0);
  assert.equal(hostWorld.units.find(unit => unit.id === 'player1').inputSequence, 2);

  const snapshotsBeforeResync = host.messages.filter(message => message.type === 'snapshot').length;
  host.receive({ type: 'resync' });
  assert.equal(host.messages.filter(message => message.type === 'snapshot').length, snapshotsBeforeResync + 1);

  host.receive({ type: 'trinket' });
  assert.equal(last(host, 'trinketAck').ok, true);
  intervals[0]();
  assert.ok(last(host, 'snapshot').world.units.find(unit => unit.id === 'player1').trinketCooldown > 59);

  guest.close();
  assert.equal(last(host, 'lobby').players.find(player => player.slot === 'player2').connected, false);
  const reconnected = connect();
  reconnected.receive({
    type: 'join', protocol: 20, roomCode: 'EUROOM', clientId: 'guest-client-new',
    classId: 'disc', talents: {}, sessionToken: guestJoin.sessionToken
  });
  assert.equal(last(reconnected, 'joined').reconnected, true);
  assert.equal(last(reconnected, 'joined').unitId, 'player2');
  assert.deepEqual(last(reconnected, 'snapshot').world, last(host, 'snapshot').world);

  host.close();
  reconnected.close();
  third.close();
  globalThis.WebSocket = originalWebSocket;
  delete globalThis.Deno;
});
