import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i += 1) simulation.step(1 / 30);
};

function fixture() {
  return createSimulation({
    seed: 15,
    roster: [
      { id: 'warrior', team: 'allies', classId: 'warrior', x: 0, z: 0, hp: 1500, maxHp: 1500, resource: 100 },
      { id: 'enemy', team: 'enemies', classId: 'flame', x: 2.5, z: 0, hp: 5000, maxHp: 5000, resource: 100 },
      { id: 'enemy2', team: 'enemies', classId: 'pala', x: 3, z: 1, hp: 5000, maxHp: 5000, resource: 100 }
    ]
  });
}

const act = (simulation, sequence, abilityId, targetId = 'enemy') =>
  simulation.applyAction('warrior', { sequence, abilityId, targetId });

test('Mortal Swing and Charge commit authoritative damage and movement', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'warrior.mortal_swing').ok, true);
  assert.equal(simulation.snapshot().units[1].hp, 4896);
  advance(simulation, 1);
  const enemy = simulation.state.units.get('enemy');
  enemy.x = 12;
  assert.equal(act(simulation, 2, 'warrior.charge').ok, true);
  const [warrior, target] = simulation.snapshot().units;
  assert.equal(target.hp, 4854);
  assert.ok(Math.hypot(warrior.x - target.x, warrior.z - target.z) <= 2.51);
  assert.ok(target.effects.root);
  assert.equal(target.effects.slow.pct, .45);
  assert.equal(target.effects.slow.remaining, 4);
});

test('Rend applies nine deterministic bleed ticks', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'warrior.rend').ok, true);
  advance(simulation, 9);
  const warrior = simulation.snapshot().units[0];
  const enemy = simulation.snapshot().units[1];
  assert.equal(enemy.hp, 5000 - 59 - 9 * 33);
  assert.equal(warrior.stats.damageByAbility.Rend, 59 + 9 * 33);
  assert.equal(enemy.effects.bleed, undefined);
});

test('Pummel locks the cast school and empowers one Mortal Swing by 30 percent', () => {
  const simulation = fixture();
  assert.equal(simulation.applyAction('enemy', {
    sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'warrior'
  }).ok, true);
  assert.equal(act(simulation, 1, 'warrior.pummel').ok, true);
  let warrior = simulation.snapshot().units[0];
  assert.equal(warrior.effects.empoweredSwing.stacks, 1);
  assert.equal(warrior.stats.interrupts, 1);
  assert.ok(simulation.snapshot().units[1].effects.lock_fire);
  const before = simulation.snapshot().units[1].hp;
  assert.equal(act(simulation, 2, 'warrior.mortal_swing').ok, true);
  const after = simulation.snapshot().units[1].hp;
  assert.equal(before - after, 135);
  warrior = simulation.snapshot().units[0];
  assert.equal(warrior.effects.empoweredSwing, undefined);
});

test('Stormbolt is a 22 metre ranged stun with a 25 second cooldown', () => {
  const simulation = fixture();
  simulation.state.units.get('enemy').x = 20;
  assert.equal(act(simulation, 1, 'war_execute_strike').ok, true);
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.units[1].effects.stun.remaining, 3);
  assert.equal(snapshot.units[0].cooldowns.war_execute_strike, 25);
});

test('Spell Reflection sends a casted spell back to its caster', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'warrior.spell_reflection', null).ok, true);
  assert.equal(simulation.applyAction('enemy', {
    sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'warrior'
  }).ok, true);
  advance(simulation, 1.5);
  const [warrior, enemy] = simulation.snapshot().units;
  assert.equal(warrior.hp, 1500);
  assert.equal(enemy.hp, 4870);
  assert.equal(warrior.effects.reflect, undefined);
});

test('Intimidating Shout fears visible nearby enemies', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'warrior.intimidating_shout', null).ok, true);
  const [, enemy, enemy2] = simulation.snapshot().units;
  assert.equal(enemy.effects.fear.remaining, 4);
  assert.equal(enemy2.effects.fear.remaining, 4);
});

test('Shield Wall gives a 60 percent wall and 25 percent damage penalty', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'warrior.shield_wall', null).ok, true);
  const warriorState = simulation.state.units.get('warrior');
  const enemyState = simulation.state.units.get('enemy');
  simulation.combat.damage(enemyState, warriorState, 100, 'Test Strike');
  assert.equal(warriorState.hp, 1460);
  assert.equal(act(simulation, 2, 'warrior.mortal_swing').ok, true);
  assert.equal(enemyState.hp, 5000 - 78);
});

test('Bladestorm produces eight server waves and is control immune', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'war_heroic_leap', null).ok, true);
  const warrior = simulation.state.units.get('warrior');
  assert.equal(simulation.combat.applyCrowdControl(warrior, 'stun', 5, 'stun'), 0);
  advance(simulation, 4);
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.units[0].cast, null);
  assert.equal(snapshot.units[1].hp, 5000 - 8 * 80);
  assert.equal(snapshot.units[2].hp, 5000 - 8 * 80);
  assert.equal(snapshot.units[0].stats.damageByAbility['Bladestorm Tick'], 16 * 80);
});

test('Warbreaker empowers one Mortal Swing and Shield Wall boosts Victory Rush', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'war_disarm').ok, true);
  advance(simulation, 1);
  const before = simulation.snapshot().units[1].hp;
  assert.equal(act(simulation, 2, 'warrior.mortal_swing').ok, true);
  assert.equal(before - simulation.snapshot().units[1].hp, 135);
  const warrior = simulation.state.units.get('warrior');
  warrior.hp = 800;
  assert.equal(act(simulation, 3, 'warrior.shield_wall', null).ok, true);
  advance(simulation, 1);
  assert.equal(act(simulation, 4, 'war_victory_rush').ok, true);
  assert.equal(warrior.hp, 800 + Math.round(185 * 1.6));
  assert.equal(simulation.snapshot().units[0].effects.victoryRushBoost, undefined);
});
