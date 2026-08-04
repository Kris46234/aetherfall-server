import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_TALENT_LOADOUTS } from '../packages/server-core/src/bot-director.js';
import { CoopRoom } from '../packages/server-core/src/coop-room.js';

function runningRoom(code = 'TACTICAL') {
  const room = new CoopRoom({ code, seed: 90210 });
  room.join({ clientId: 'host', classId: 'flame' });
  room.join({ clientId: 'guest', classId: 'disc' });
  room.start('host');
  for (let tick = 0; tick < 90; tick += 1) room.tick(1 / 30);
  assert.equal(room.phase, 'running');
  return room;
}

function clearCombatState(unit) {
  unit.gcd = 0;
  unit.cast = null;
  unit.cooldowns.clear();
  unit.resource = unit.maxResource;
  unit.input = { sequence: unit.input.sequence, x: 0, z: 0 };
}

test('authoritative enemies spawn with explicit talent builds and stamina bonuses', () => {
  const room = runningRoom('TALENTS');
  const warrior = room.simulation.state.units.get('bot1');
  const paladin = room.simulation.state.units.get('bot2');
  assert.deepEqual(warrior.talents, BOT_TALENT_LOADOUTS.warrior);
  assert.deepEqual(paladin.talents, BOT_TALENT_LOADOUTS.pala);
  assert.equal(warrior.talents.war_heroic_leap, 1);
  assert.equal(paladin.talents.pala_divine_toll, 1);
  assert.ok(warrior.maxHp > 1650);
  assert.ok(paladin.maxHp > 1513);
});

test('Paladin uses talented casted healing instead of relying only on instants', () => {
  const room = runningRoom('CASTHEAL');
  const warrior = room.simulation.state.units.get('bot1');
  const paladin = room.simulation.state.units.get('bot2');
  clearCombatState(warrior);
  clearCombatState(paladin);
  warrior.hp = Math.round(warrior.maxHp * .86);
  room.tick(.1);
  assert.equal(paladin.cast?.abilityId, 'pala.holy_light');
  assert.equal(paladin.cast?.duration, 1.34);
  for (let tick = 0; tick < 45; tick += 1) room.tick(1 / 30);
  assert.ok(paladin.stats.healingByAbility['Holy Light'] > 0);
});

test('Warrior recognises a kill window and uses Stormbolt to secure it', () => {
  const room = runningRoom('EXECUTE');
  const warrior = room.simulation.state.units.get('bot1');
  const victim = room.simulation.state.units.get('player1');
  const other = room.simulation.state.units.get('player2');
  clearCombatState(warrior);
  warrior.x = 0; warrior.z = 0;
  victim.x = 2; victim.z = 0; victim.hp = Math.round(victim.maxHp * .30);
  other.x = -25; other.z = -18;
  room.tick(.1);
  assert.ok(victim.effects.get('stun'));
});

test('Warrior reacts to an incoming spell with talented tactical defence', () => {
  const room = runningRoom('REFLECT');
  const warrior = room.simulation.state.units.get('bot1');
  const caster = room.simulation.state.units.get('player1');
  clearCombatState(warrior);
  clearCombatState(caster);
  warrior.x = 0; warrior.z = 0;
  caster.x = 8; caster.z = 0;
  assert.equal(room.action('host', {
    sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'bot1'
  }).ok, true);
  room.tick(.1);
  assert.ok(warrior.effects.get('reflect'));
});
