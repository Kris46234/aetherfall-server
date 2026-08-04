import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../packages/simulation/src/index.js';
import { playerInput } from '../packages/protocol/src/messages.js';

const roster = [
  { id: 'p1', team: 'ally', classId: 'wind', x: -4, z: 0, speed: 5, hp: 1000 },
  { id: 'bot', team: 'enemy', classId: 'pala', x: 4, z: 0, speed: 4, hp: 1200 },
];

test('headless simulation is deterministic for a seed and input stream', () => {
  const first = createSimulation({ seed: 42, roster });
  const second = createSimulation({ seed: 42, roster });
  for (const simulation of [first, second]) {
    assert.equal(simulation.applyInput('p1', playerInput(1, 1, .5)), true);
    simulation.setCooldown('p1', 'wind.zephyr_palm', 1.5);
    for (let i = 0; i < 30; i += 1) simulation.step(1 / 30);
  }
  assert.deepEqual(first.snapshot(), second.snapshot());
});

test('older inputs cannot overwrite newer authoritative input', () => {
  const simulation = createSimulation({ roster });
  assert.equal(simulation.applyInput('p1', playerInput(10, 1, 0)), true);
  assert.equal(simulation.applyInput('p1', playerInput(9, -1, 0)), false);
  simulation.step(.1);
  assert.equal(simulation.snapshot().units[0].inputSequence, 10);
  assert.ok(simulation.snapshot().units[0].x > -4);
});

test('arena bounds and cooldown expiry are authoritative', () => {
  const simulation = createSimulation({ roster, arena: { x: 5, z: 5 } });
  simulation.applyInput('p1', playerInput(1, -1, 0));
  simulation.setCooldown('p1', 'test', .1);
  for (let i = 0; i < 50; i += 1) simulation.step(.05);
  const player = simulation.snapshot().units[0];
  assert.equal(player.x, -4.38);
  assert.deepEqual(player.cooldowns, {});
});

test('resources, GCD and instant action acknowledgement are server-owned', () => {
  const simulation = createSimulation({ roster: [
    { ...roster[0], x: 0, resource: 40 },
    { ...roster[1], x: 2 }
  ] });
  assert.deepEqual(
    simulation.applyAction('p1', { sequence: 1, abilityId: 'wind.zephyr_palm', targetId: 'bot' }),
    { ok: true, reason: null }
  );
  assert.equal(simulation.snapshot().units[0].resource, 24);
  assert.equal(simulation.applyAction('p1', { sequence: 2, abilityId: 'wind.zephyr_palm', targetId: 'bot' }).reason, 'gcd');
  assert.equal(simulation.drainEvents().at(-1).reason, 'gcd');
  for (let i = 0; i < 30; i += 1) simulation.step(1 / 30);
  assert.equal(simulation.snapshot().units[0].gcd, 0);
  assert.ok(simulation.snapshot().units[0].resource > 24);
});

test('cast completion happens on the fixed simulation clock', () => {
  const simulation = createSimulation({ roster: [
    { id: 'mage', team: 'ally', classId: 'flame', x: 0, z: 0, resource: 50 },
    { id: 'enemy', team: 'enemy', classId: 'wind', x: 5, z: 0 }
  ] });
  assert.equal(simulation.applyAction('mage', {
    sequence: 1,
    abilityId: 'flame.cinder_bolt',
    targetId: 'enemy'
  }).ok, true);
  assert.equal(simulation.drainEvents()[0].type, 'castStarted');
  for (let i = 0; i < 42; i += 1) simulation.step(1 / 30);
  assert.equal(simulation.drainEvents().length, 0);
  for (let i = 0; i < 3; i += 1) simulation.step(1 / 30);
  const completed = simulation.drainEvents();
  const actionComplete = completed.find(event => event.type === 'actionComplete');
  assert.ok(actionComplete);
  assert.equal(actionComplete.abilityId, 'flame.cinder_bolt');
});

test('pillars authoritatively block movement and line of sight', () => {
  const simulation = createSimulation({
    arena: { x: 10, z: 10, pillars: [{ id: 'middle', x: 0, z: 0, radius: 1.5 }] },
    roster: [
      { id: 'left', team: 'ally', classId: 'flame', x: -4, z: 0, radius: .5, speed: 5 },
      { id: 'right', team: 'enemy', classId: 'wind', x: 4, z: 0, radius: .5 }
    ]
  });
  assert.equal(simulation.hasLineOfSight('left', 'right'), false);
  assert.equal(simulation.applyAction('left', {
    sequence: 1,
    abilityId: 'flame.cinder_bolt',
    targetId: 'right'
  }).reason, 'line_of_sight');
  simulation.applyInput('left', playerInput(1, 1, 0));
  for (let i = 0; i < 60; i += 1) simulation.step(1 / 30);
  assert.ok(simulation.snapshot().units.find(unit => unit.id === 'left').x <= -2);
});

test('unit collision is deterministic and prevents overlap', () => {
  const create = () => createSimulation({ roster: [
    { id: 'a', team: 'ally', classId: 'wind', x: -.2, z: 0, radius: .6 },
    { id: 'b', team: 'enemy', classId: 'wind', x: .2, z: 0, radius: .6 }
  ] });
  const first = create();
  const second = create();
  first.step(1 / 30);
  second.step(1 / 30);
  assert.deepEqual(first.snapshot(), second.snapshot());
  const [a, b] = first.snapshot().units;
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 1.2);
});
