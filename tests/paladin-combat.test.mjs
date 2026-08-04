import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i += 1) simulation.step(1 / 30);
};

function fixture() {
  return createSimulation({
    seed: 9,
    roster: [
      { id: 'pala', team: 'allies', classId: 'pala', x: 0, z: 0, hp: 1200, maxHp: 1375, resource: 60 },
      { id: 'ally', team: 'allies', classId: 'warrior', x: 2, z: 0, hp: 700, maxHp: 1500, resource: 100 },
      { id: 'enemy', team: 'enemies', classId: 'wind', x: 3, z: 0, hp: 3000, maxHp: 3000, resource: 100 }
    ]
  });
}

const act = (simulation, sequence, abilityId, targetId) =>
  simulation.applyAction('pala', { sequence, abilityId, targetId });

test('Holy Light is a 1.5 second server cast with Paladin healing tuning', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala.holy_light', 'ally').ok, true);
  assert.equal(simulation.snapshot().units[0].cast.duration, 1.5);
  advance(simulation, 1.5);
  assert.equal(simulation.snapshot().units[1].hp, 920);
  assert.equal(simulation.snapshot().units[0].stats.healingByAbility['Holy Light'], 220);
});

test('critical Holy Shock grants Infusion and makes Holy Light fast and free', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala.holy_shock', 'ally').ok, true);
  let pala = simulation.snapshot().units[0];
  assert.equal(simulation.snapshot().units[1].hp, 992);
  assert.ok(pala.effects.infusion);
  const resource = pala.resource;
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'pala.holy_light', 'ally').ok, true);
  pala = simulation.snapshot().units[0];
  assert.equal(pala.cast.duration, .75);
  assert.equal(pala.resource, resource + 1);
  assert.equal(pala.effects.infusion, undefined);
});

test('Blessing of Sacrifice redirects damage and grants Avenging Wings', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala.blessing_of_sacrifice', 'ally').ok, true);
  const pala = simulation.state.units.get('pala');
  const ally = simulation.state.units.get('ally');
  const enemy = simulation.state.units.get('enemy');
  simulation.combat.damage(enemy, ally, 100, 'Redirect Test');
  assert.equal(ally.hp, 700);
  assert.equal(pala.hp, 1100);
  assert.ok(simulation.snapshot().units[0].effects.avengingWings);
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'pala.holy_light', 'ally').ok, true);
  advance(simulation, 1.5);
  assert.equal(ally.hp, 964);
});

test('standalone Avenging Wings grants 20 percent damage and healing for eight seconds', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala.avenging_wings', null).ok, true);
  const wings = simulation.snapshot().units[0].effects.avengingWings;
  assert.equal(wings.remaining, 8);
  assert.equal(wings.damageBonus, .20);
  assert.equal(wings.healingBonus, .20);
  advance(simulation, 1);
  const enemyBefore = simulation.state.units.get('enemy').hp;
  assert.equal(act(simulation, 2, 'pala.holy_shock', 'enemy').ok, true);
  assert.equal(enemyBefore - simulation.state.units.get('enemy').hp, Math.round(112 * 1.5 * 1.20));
});

test('Bestow Faith heals exactly when its four second effect expires', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala.bestow_faith', 'ally').ok, true);
  advance(simulation, 3.9);
  assert.equal(simulation.snapshot().units[1].hp, 700);
  advance(simulation, .1);
  assert.equal(simulation.snapshot().units[1].hp, 978);
  assert.equal(simulation.snapshot().units[1].effects.bestowFaith, undefined);
});

test('Divine Protection, Hammer, Steed and Cleanse are server-owned', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala.divine_protection', null).ok, true);
  const pala = simulation.state.units.get('pala');
  const enemy = simulation.state.units.get('enemy');
  simulation.combat.damage(enemy, pala, 100, 'Guard Test');
  assert.equal(pala.hp, 1130);
  assert.equal(act(simulation, 2, 'pala.divine_steed', null).ok, true);
  assert.equal(simulation.snapshot().units[0].effects.divineSteed.speed, 1.65);
  advance(simulation, 1);
  assert.equal(act(simulation, 3, 'pala.hammer_of_justice', 'enemy').ok, true);
  assert.equal(simulation.snapshot().units[2].effects.stun.remaining, 4.5);
  simulation.combat.applyCrowdControl(pala, 'windIncap', 3, 'incap');
  advance(simulation, 1);
  assert.equal(act(simulation, 4, 'pala.cleanse', 'pala').reason, 'crowd_controlled');
  simulation.combat.removeEffect(pala, 'windIncap', 'test');
  assert.equal(act(simulation, 5, 'pala.cleanse', 'ally').ok, true);
});

test('Guardian Angel shields and Judgement restores mana and heals allies', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'pala_guardian_angel', 'ally').ok, true);
  assert.equal(simulation.snapshot().units[1].shield, 315);
  advance(simulation, 1);
  const pala = simulation.state.units.get('pala');
  pala.resource = 50;
  assert.equal(act(simulation, 2, 'pala_judgement', 'enemy').ok, true);
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.units[2].hp, 2835);
  assert.equal(snapshot.units[0].resource, 55);
  assert.equal(snapshot.units[0].hp, 1317);
  assert.equal(snapshot.units[1].hp, 817);
});
