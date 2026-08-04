import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i += 1) simulation.step(1 / 30);
};

function fixture() {
  return createSimulation({
    seed: 17,
    arena: { x: 30, z: 20, pillars: [] },
    roster: [
      { id: 'flame', team: 'allies', classId: 'flame', x: 0, z: 0, hp: 1000, maxHp: 1500, resource: 60 },
      { id: 'enemy', team: 'enemies', classId: 'flame', x: 4, z: 0, hp: 5000, maxHp: 5000, resource: 100 },
      { id: 'enemy2', team: 'enemies', classId: 'warrior', x: 5, z: 1, hp: 5000, maxHp: 5000, resource: 100 }
    ]
  });
}

const act = (simulation, sequence, abilityId, targetId = 'enemy') =>
  simulation.applyAction('flame', { sequence, abilityId, targetId });

test('Cinder Bolt no longer auto-triggers Meteor and the deliberate cooldown burns nearby enemies', () => {
  const simulation = fixture();
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    assert.equal(act(simulation, sequence, 'flame.cinder_bolt').ok, true);
    advance(simulation, 1.5);
  }
  assert.equal(simulation.snapshot().units[0].effects.meteorPending, undefined);
  assert.equal(act(simulation, 4, 'flame.meteor').ok, true);
  assert.ok(simulation.snapshot().units[0].effects.meteorPending);
  advance(simulation, 1);
  const [flame, enemy, enemy2] = simulation.snapshot().units;
  assert.equal(enemy.hp, 5000 - 3 * 130 - 205);
  assert.equal(enemy2.hp, 5000 - 205);
  assert.ok(enemy.effects.burn);
  assert.ok(enemy2.effects.burn);
  assert.ok(flame.effects.meteorLance);
  assert.equal(flame.cooldowns['flame.ember_lance'], undefined);
});

test('Meteorfall and delayed explosions emit ordered reliable presentation cues', () => {
  const simulation = fixture();
  simulation.drainEvents();
  assert.equal(act(simulation, 1, 'flame.meteor').ok, true);
  let events = simulation.drainEvents();
  const telegraph = events.find(event => event.type === 'presentation' && event.cue === 'meteorfall');
  assert.ok(telegraph);
  assert.equal(telegraph.duration, .98);
  assert.equal(telegraph.radius, 5.2);
  advance(simulation, 1);
  events = simulation.drainEvents();
  const impact = events.find(event => event.type === 'presentation' && event.cue === 'meteorfallImpact');
  assert.ok(impact);
  assert.ok(impact.id > telegraph.id);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);

  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'flame_meteor_spear').ok, true);
  simulation.drainEvents();
  advance(simulation, 6);
  events = simulation.drainEvents();
  assert.ok(events.some(event => event.type === 'presentation' && event.cue === 'livingBombExplosion'));
});

test('Counterflare owns interrupt lockout, mana restoration and two instant bolts', () => {
  const simulation = fixture();
  const flame = simulation.state.units.get('flame');
  flame.resource = 20;
  assert.equal(simulation.applyAction('enemy', {
    sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'flame'
  }).ok, true);
  assert.equal(act(simulation, 1, 'flame.counterflare').ok, true);
  let snapshot = simulation.snapshot();
  assert.equal(snapshot.units[1].cast, null);
  assert.ok(snapshot.units[1].effects.lock_fire);
  assert.equal(snapshot.units[0].resource, 40);
  assert.equal(snapshot.units[0].effects.instantBolt.stacks, 2);
  assert.equal(act(simulation, 2, 'flame.cinder_bolt').ok, true);
  snapshot = simulation.snapshot();
  assert.equal(snapshot.units[1].hp, 5000 - 156);
  assert.equal(snapshot.units[0].cast, null);
  assert.equal(snapshot.units[0].effects.instantBolt.stacks, 1);
});

test('Ember Lance consumes Meteor Lance and gains both burn multipliers', () => {
  const simulation = fixture();
  const flame = simulation.state.units.get('flame');
  const enemy = simulation.state.units.get('enemy');
  simulation.combat.addEffect(enemy, 'burn', 5, { sourceId: flame.id, value: 17 });
  simulation.combat.addEffect(flame, 'meteorLance', 30, { stacks: 1 });
  assert.equal(act(simulation, 1, 'flame.ember_lance').ok, true);
  assert.equal(5000 - enemy.hp, Math.round(158 * 1.30 * 1.15));
  assert.equal(simulation.snapshot().units[0].effects.meteorLance, undefined);
  assert.equal(simulation.snapshot().units[0].cooldowns['flame.ember_lance'], .4);
});

test('Frostfire Nova roots and slows every nearby visible enemy', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'flame.frostfire_nova', null).ok, true);
  const [, enemy, enemy2] = simulation.snapshot().units;
  assert.equal(enemy.hp, 4964);
  assert.equal(enemy2.hp, 4964);
  assert.ok(enemy.effects.root);
  assert.equal(enemy.effects.slow.pct, .6);
});

test('Blazing Step works during Cinder and preserves the original cast', () => {
  const simulation = fixture();
  simulation.state.units.get('flame').input = { sequence: 1, x: 0, z: 1 };
  assert.equal(act(simulation, 1, 'flame.cinder_bolt').ok, true);
  const original = simulation.snapshot().units[0].cast;
  assert.equal(act(simulation, 2, 'flame.blazing_step', null).ok, true);
  const flame = simulation.snapshot().units[0];
  assert.equal(flame.cast.abilityId, original.abilityId);
  assert.ok(flame.z > 14);
  assert.ok(flame.effects.defensive);
});

test('Prism Hex only commits its cooldown after a valid completed cast', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'flame.prism_hex').ok, true);
  assert.equal(simulation.snapshot().units[0].cooldowns['flame.prism_hex'], undefined);
  advance(simulation, 1.5);
  assert.ok(simulation.snapshot().units[1].effects.poly);
  assert.ok(simulation.snapshot().units[0].cooldowns['flame.prism_hex'] > 4.9);
});

test('Ice Block breaks control, cancels casts, immunes damage, heals and can end early', () => {
  const simulation = fixture();
  const flame = simulation.state.units.get('flame');
  const enemy = simulation.state.units.get('enemy');
  assert.equal(act(simulation, 1, 'flame.cinder_bolt').ok, true);
  simulation.combat.applyCrowdControl(flame, 'stun', 4, 'stun');
  assert.equal(act(simulation, 2, 'flame.ice_block', null).ok, true);
  assert.equal(simulation.snapshot().units[0].cast, null);
  assert.equal(simulation.snapshot().units[0].effects.stun, undefined);
  const hp = flame.hp;
  assert.equal(simulation.combat.damage(enemy, flame, 500, 'Test').immune, true);
  advance(simulation, 1);
  assert.equal(flame.hp, hp + 38);
  assert.equal(act(simulation, 3, 'flame.ice_block', null).ok, true);
  assert.equal(simulation.snapshot().units[0].effects.iceBlock, undefined);
});

test('Living Bomb applies six ticks and an authoritative expiry explosion', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'flame_meteor_spear').ok, true);
  advance(simulation, 6);
  const enemy = simulation.snapshot().units[1];
  assert.equal(enemy.hp, 5000 - 6 * 18 - 190);
  assert.equal(enemy.effects.livingBomb, undefined);
});
