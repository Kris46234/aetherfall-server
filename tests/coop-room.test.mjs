import assert from 'node:assert/strict';
import test from 'node:test';
import { CoopRoom } from '../packages/server-core/src/coop-room.js';

function roomFixture() {
  let now = 1_000;
  let token = 0;
  const room = new CoopRoom({
    code: 'TEST',
    seed: 77,
    now: () => now,
    tokenFactory: () => `token-${++token}`
  });
  return { room, setNow: value => { now = value; } };
}

test('co-op room admits exactly two allies and only host can start', () => {
  const { room } = roomFixture();
  const host = room.join({ clientId: 'client-a', classId: 'wind' });
  assert.equal(host.host, true);
  assert.equal(room.start('client-a').reason, 'waiting_for_player');
  const guest = room.join({ clientId: 'client-b', classId: 'disc' });
  assert.equal(guest.host, false);
  assert.equal(guest.ready, true);
  assert.equal(room.join({ clientId: 'client-c', classId: 'flame' }).reason, 'room_full');
  assert.equal(room.start('client-b').reason, 'host_only');
  const started = room.start('client-a');
  assert.equal(started.ok, true);
  assert.equal(started.phase, 'countdown');
  assert.equal(started.countdownRemaining, 3);
  assert.equal(started.snapshot.units.filter(unit => unit.team === 'allies').length, 2);
  assert.equal(started.snapshot.units.filter(unit => unit.team === 'enemies').length, 2);
});

test('both clients receive one identical authoritative world', () => {
  const { room } = roomFixture();
  room.join({ clientId: 'client-a', classId: 'wind' });
  room.join({ clientId: 'client-b', classId: 'disc' });
  room.start('client-a');
  assert.equal(room.input('client-a', { sequence: 1, x: 1, z: 0 }), false);
  for (let i = 0; i < 90; i += 1) room.tick(1 / 30);
  assert.equal(room.phase, 'running');
  room.input('client-a', { sequence: 1, x: 1, z: 0 });
  room.input('client-b', { sequence: 1, x: 0, z: -1 });
  for (let i = 0; i < 6; i += 1) room.tick(1 / 30);
  const first = room.snapshotFor('client-a');
  const second = room.snapshotFor('client-b');
  assert.equal(first.controlledUnitId, 'player1');
  assert.equal(second.controlledUnitId, 'player2');
  assert.deepEqual(first.world, second.world);
});

test('disconnect keeps the match and reconnect token restores the same unit', () => {
  const { room, setNow } = roomFixture();
  room.join({ clientId: 'client-a', classId: 'wind' });
  const guest = room.join({ clientId: 'client-b', classId: 'disc' });
  room.start('client-a');
  assert.equal(room.disconnect('client-b'), true);
  setNow(20_000);
  room.expireDisconnected();
  const restored = room.join({
    clientId: 'client-b-new-socket',
    classId: 'disc',
    sessionToken: guest.sessionToken
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.reconnected, true);
  assert.equal(restored.unitId, 'player2');
  assert.equal(restored.phase, 'countdown');
  assert.ok(room.snapshotFor('client-b-new-socket'));
});

test('expired disconnected lobby slot can be safely reused', () => {
  const { room, setNow } = roomFixture();
  room.join({ clientId: 'client-a', classId: 'wind' });
  const guest = room.join({ clientId: 'client-b', classId: 'disc' });
  room.disconnect('client-b');
  setNow(40_001);
  room.expireDisconnected();
  assert.equal(room.join({ clientId: 'client-c', classId: 'flame' }).slot, 'player2');
  assert.equal(room.join({ clientId: 'old-client', classId: 'disc', sessionToken: guest.sessionToken }).reason, 'room_full');
});

test('both enemy bots make deterministic authoritative combat decisions', () => {
  const firstFixture = roomFixture();
  const secondFixture = roomFixture();
  for (const { room } of [firstFixture, secondFixture]) {
    room.join({ clientId: 'client-a', classId: 'wind' });
    room.join({ clientId: 'client-b', classId: 'disc' });
    room.start('client-a');
    for (let tick = 0; tick < 300; tick += 1) room.tick(1 / 30);
  }
  const first = firstFixture.room.snapshotFor('client-a').world;
  const second = secondFixture.room.snapshotFor('client-b').world;
  assert.deepEqual(first, second);
  const warrior = first.units.find(unit => unit.id === 'bot1');
  const paladin = first.units.find(unit => unit.id === 'bot2');
  assert.ok(warrior.stats.damage > 0);
  assert.ok(paladin.stats.damage > 0 || paladin.stats.healing > 0);
  assert.ok(first.units.some(unit => unit.team === 'allies' && unit.hp < unit.maxHp));
});

test('authoritative Paladin follows the fight and uses a real healing priority', () => {
  const { room } = roomFixture();
  room.join({ clientId: 'client-a', classId: 'wind' });
  room.join({ clientId: 'client-b', classId: 'disc' });
  room.start('client-a');
  for (let tick = 0; tick < 90; tick += 1) room.tick(1 / 30);
  const warrior = room.simulation.state.units.get('bot1');
  const paladin = room.simulation.state.units.get('bot2');
  const start = { x: paladin.x, z: paladin.z };
  warrior.hp = 500;
  for (let tick = 0; tick < 240; tick += 1) room.tick(1 / 30);
  assert.ok(warrior.hp > 500);
  assert.ok(paladin.stats.healing > 0);
  assert.ok(paladin.stats.healingByAbility['Holy Shock'] || paladin.stats.healingByAbility['Bestow Faith'] || paladin.stats.healingByAbility['Holy Light']);
  assert.ok(Math.hypot(paladin.x - start.x, paladin.z - start.z) > 2);
});
