import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  for (let index = 0; index < Math.round(seconds * 30); index += 1) simulation.step(1 / 30);
};

function simulationFor(roster, arena = { x: 30, z: 20, pillars: [] }) {
  return createSimulation({ seed: 220, arena, roster });
}

test('both Lifesage HoTs coexist for twelve seconds', () => {
  const simulation = simulationFor([
    { id: 'sage', team: 'allies', classId: 'sage', x: 0, z: 0, hp: 1500, maxHp: 1800, resource: 100 },
    { id: 'ally', team: 'allies', classId: 'warrior', x: 2, z: 0, hp: 900, maxHp: 1800, resource: 100 },
    { id: 'enemy', team: 'enemies', classId: 'flame', x: 6, z: 0, hp: 1800, maxHp: 1800, resource: 100 }
  ]);
  assert.equal(simulation.applyAction('sage', { sequence: 1, abilityId: 'sage.blooming_echo', targetId: 'ally' }).ok, true);
  advance(simulation, 1);
  assert.equal(simulation.applyAction('sage', { sequence: 2, abilityId: 'sage_rejuvenate', targetId: 'ally' }).ok, true);
  const effects = simulation.snapshot().units.find(unit => unit.id === 'ally').effects;
  assert.ok(effects['hot:sage.blooming_echo'].remaining > 10.9);
  assert.equal(effects['hot:sage_rejuvenate'].remaining, 12);
});

test('Unstable Affliction ticks for the exact one, two and three stack curve', () => {
  for (const [stacks, expected] of [[1, 50], [2, 80], [3, 110]]) {
    const simulation = simulationFor([
      { id: 'soul', team: 'allies', classId: 'soul', x: 0, z: 0, hp: 1800, maxHp: 1800, resource: 100 },
      { id: 'enemy', team: 'enemies', classId: 'warrior', x: 3, z: 0, hp: 2000, maxHp: 2000, resource: 100 }
    ]);
    const source = simulation.state.units.get('soul');
    const target = simulation.state.units.get('enemy');
    simulation.combat.addEffect(target, 'unstableAffliction', 10, {
      sourceId: source.id, value: 50, stacks, label: 'Unstable Affliction', interval: 1, tickRemaining: 1
    });
    advance(simulation, 1);
    assert.equal(2000 - target.hp, expected);
  }
});

test('Smoke Veil makes an in-flight hostile cast lose its target', () => {
  const simulation = simulationFor([
    { id: 'mage', team: 'enemies', classId: 'flame', x: 0, z: 0, hp: 1800, maxHp: 1800, resource: 100 },
    { id: 'rogue', team: 'allies', classId: 'shadow', x: 5, z: 0, hp: 1800, maxHp: 1800, resource: 100 }
  ]);
  assert.equal(simulation.applyAction('mage', { sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'rogue' }).ok, true);
  assert.equal(simulation.applyAction('rogue', { sequence: 1, abilityId: 'shadow.smoke_veil', targetId: null }).ok, true);
  advance(simulation, 1.6);
  assert.equal(simulation.state.units.get('rogue').hp, 1800);
  assert.ok(simulation.drainEvents().some(event => event.type === 'actionFailed' && event.reason === 'completion_validation'));
});

test('Penance and Essence Siphon keep ticking after a valid channel begins through line of sight', () => {
  for (const [classId, abilityId] of [['disc', 'disc.penance'], ['soul', 'soul.essence_siphon']]) {
    const simulation = simulationFor([
      { id: 'caster', team: 'allies', classId, x: -4, z: 0, hp: 1800, maxHp: 1800, resource: 100 },
      { id: 'enemy', team: 'enemies', classId: 'warrior', x: -2, z: 0, hp: 2400, maxHp: 2400, resource: 100 }
    ], { x: 30, z: 20, pillars: [{ id: 'centre', x: 0, z: 0, radius: 1.5 }] });
    assert.equal(simulation.applyAction('caster', { sequence: 1, abilityId, targetId: 'enemy' }).ok, true);
    simulation.state.units.get('enemy').x = 4;
    const before = simulation.state.units.get('enemy').hp;
    advance(simulation, .6);
    assert.ok(simulation.state.units.get('enemy').hp < before);
  }
});

test('Mortal Horror heals twenty percent and Cloudstep Kick respects the global cooldown', () => {
  const horror = simulationFor([
    { id: 'soul', team: 'allies', classId: 'soul', x: 0, z: 0, hp: 500, maxHp: 1000, resource: 100 },
    { id: 'enemy', team: 'enemies', classId: 'warrior', x: 3, z: 0, hp: 1800, maxHp: 1800, resource: 100 }
  ]);
  assert.equal(horror.applyAction('soul', { sequence: 1, abilityId: 'soul_horror', targetId: 'enemy' }).ok, true);
  assert.equal(horror.state.units.get('soul').hp, 700);

  const wind = simulationFor([
    { id: 'wind', team: 'allies', classId: 'wind', x: 0, z: 0, hp: 1800, maxHp: 1800, resource: 100 },
    { id: 'enemy', team: 'enemies', classId: 'warrior', x: 3, z: 0, hp: 1800, maxHp: 1800, resource: 100 }
  ]);
  assert.equal(wind.applyAction('wind', { sequence: 1, abilityId: 'wind.zephyr_palm', targetId: 'enemy' }).ok, true);
  assert.equal(wind.applyAction('wind', { sequence: 2, abilityId: 'wind.cloudstep_kick', targetId: 'enemy' }).reason, 'gcd');
});
