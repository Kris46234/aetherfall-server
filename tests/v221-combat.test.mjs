import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  for (let index = 0; index < Math.round(seconds * 30); index += 1) simulation.step(1 / 30);
};

function fixture(classId, hp = 1800, maxHp = 1800) {
  return createSimulation({
    seed: 221,
    arena: { x: 30, z: 20, pillars: [] },
    roster: [
      { id: 'player', team: 'allies', classId, x: 0, z: 0, hp, maxHp, resource: 100 },
      { id: 'enemy', team: 'enemies', classId: 'warrior', x: 3, z: 0, hp: 5000, maxHp: 5000, resource: 100 }
    ]
  });
}

test('Alter Time restores saved health and position on recast and starts a 60 second cooldown', () => {
  const simulation = fixture('flame', 1400, 1800);
  assert.equal(simulation.applyAction('player', { sequence: 1, abilityId: 'flame_phoenix_guard', targetId: 'player' }).ok, true);
  const player = simulation.state.units.get('player');
  assert.ok(simulation.snapshot().units[0].effects.alterTime);
  player.x = 9;
  player.z = 4;
  player.hp = 500;
  assert.equal(simulation.applyAction('player', { sequence: 2, abilityId: 'flame_phoenix_guard', targetId: 'player' }).ok, true);
  assert.equal(player.x, 0);
  assert.equal(player.z, 0);
  assert.equal(player.hp, 1400);
  assert.equal(simulation.snapshot().units[0].effects.alterTime, undefined);
  assert.equal(simulation.snapshot().units[0].cooldowns.flame_phoenix_guard, 60);
});

test('Alter Time automatically returns after five seconds', () => {
  const simulation = fixture('flame', 1500, 1800);
  assert.equal(simulation.applyAction('player', { sequence: 1, abilityId: 'flame_phoenix_guard', targetId: 'player' }).ok, true);
  const player = simulation.state.units.get('player');
  player.x = 8;
  player.hp = 600;
  advance(simulation, 5);
  assert.equal(player.x, 0);
  assert.equal(player.hp, 1500);
  assert.ok(simulation.snapshot().units[0].cooldowns.flame_phoenix_guard > 59.9);
});

test('Mortal Horror healing is always applied and then reduced by dampening', () => {
  const simulation = fixture('soul', 400, 1000);
  simulation.state.dampening = .5;
  assert.equal(simulation.applyAction('player', { sequence: 1, abilityId: 'soul_horror', targetId: 'enemy' }).ok, true);
  assert.equal(simulation.state.units.get('player').hp, 500);
});

test('Totem Mastery raises direct damage by five percent and costs no mana', () => {
  const simulation = fixture('storm');
  const player = simulation.state.units.get('player');
  const resource = player.resource;
  assert.equal(simulation.applyAction('player', { sequence: 1, abilityId: 'storm_mana_well', targetId: 'player' }).ok, true);
  assert.equal(player.resource, resource);
  advance(simulation, 1);
  const before = simulation.state.units.get('enemy').hp;
  assert.equal(simulation.applyAction('player', { sequence: 2, abilityId: 'storm.arc_spark', targetId: 'enemy' }).ok, true);
  advance(simulation, 1.3);
  assert.equal(before - simulation.state.units.get('enemy').hp, Math.round(124 * 1.05));
});
