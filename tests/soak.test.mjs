import assert from 'node:assert/strict';
import test from 'node:test';
import { CoopRoom } from '../packages/server-core/src/coop-room.js';

function createRoom(code) {
  let token = 0;
  const room = new CoopRoom({ code, seed: 424242, tokenFactory: () => `${code}-${++token}` });
  room.join({ clientId: 'host', classId: 'flame' });
  room.join({ clientId: 'guest', classId: 'wind', talents: { wind_tigereye_brew: 1 } });
  room.start('host');
  for (let tick = 0; tick < 90; tick += 1) room.tick(1 / 30);
  for (const unit of room.simulation.state.units.values()) {
    unit.hp = 1_000_000;
    unit.maxHp = 1_000_000;
  }
  return room;
}

test('five-minute deterministic room soak has zero client divergence and bounded state', () => {
  const first = createRoom('SOAK-A');
  const second = createRoom('SOAK-B');
  let inputSequence = 0;
  let actionSequence = 0;
  for (let tick = 0; tick < 9_000; tick += 1) {
    if (tick % 30 === 0) {
      inputSequence += 1;
      const phase = Math.floor(tick / 30) % 4;
      const vectors = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      const [x, z] = vectors[phase];
      for (const room of [first, second]) {
        room.input('host', { sequence: inputSequence, x, z });
        room.input('guest', { sequence: inputSequence, x: -x, z: -z });
      }
    }
    if (tick % 90 === 60) {
      actionSequence += 1;
      inputSequence += 1;
      for (const room of [first, second]) {
        room.input('host', { sequence: inputSequence, x: 0, z: 0 });
        room.action('host', { sequence: actionSequence, abilityId: 'flame.cinder_bolt', targetId: 'bot1' });
        room.action('guest', { sequence: actionSequence, abilityId: 'wind.zephyr_palm', targetId: 'bot1' });
      }
    }
    first.tick(1 / 30);
    second.tick(1 / 30);
    if (tick % 300 === 0) {
      const hostView = first.snapshotFor('host');
      const guestView = first.snapshotFor('guest');
      assert.deepEqual(hostView.world, guestView.world);
      assert.deepEqual(first.snapshotFor('host').world, second.snapshotFor('host').world);
    }
  }
  const world = first.snapshotFor('host').world;
  assert.equal(world.tick, 9_000);
  assert.equal(world.time, 300);
  for (const unit of world.units) {
    for (const value of [unit.x, unit.z, unit.hp, unit.resource, unit.gcd, unit.trinketCooldown]) assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(unit.x) <= world.arena.x);
    assert.ok(Math.abs(unit.z) <= world.arena.z);
    assert.ok(unit.resource >= 0 && unit.resource <= unit.maxResource);
  }
});
