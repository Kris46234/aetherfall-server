import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  const ticks = Math.round(seconds * 30);
  for (let i = 0; i < ticks; i += 1) simulation.step(1 / 30);
};

function fixture(options = {}) {
  return createSimulation({
    seed: 9,
    roster: [
      {
        id: 'wind', team: 'allies', classId: 'wind', x: 0, z: 0,
        hp: options.windHp || 1650, maxHp: 1650, resource: 100,
        talents: options.talents || {}
      },
      { id: 'enemy', team: 'enemies', classId: 'flame', x: 2.5, z: 0, hp: 3000, maxHp: 3000, resource: 100 },
      { id: 'enemy2', team: 'enemies', classId: 'pala', x: 3, z: 1, hp: 3000, maxHp: 3000, resource: 100 }
    ]
  });
}

function act(simulation, sequence, abilityId, targetId = 'enemy') {
  return simulation.applyAction('wind', { sequence, abilityId, targetId });
}

test('Zephyr Palm owns real damage, energy, Flow and meter state', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'wind.zephyr_palm').ok, true);
  const wind = simulation.snapshot().units.find(unit => unit.id === 'wind');
  const enemy = simulation.snapshot().units.find(unit => unit.id === 'enemy');
  assert.equal(enemy.hp, 2950);
  assert.equal(wind.resource, 84);
  assert.equal(wind.effects.flow.stacks, 1);
  assert.equal(wind.stats.damage, 50);
  assert.equal(wind.stats.damageByAbility['Zephyr Palm'], 50);
});

test('every two Zephyr Palms grant two Brew stacks and Brew scales damage', () => {
  const simulation = fixture({ talents: { wind_tigereye_brew: 1 } });
  let sequence = 0;
  for (let palm = 0; palm < 6; palm += 1) {
    assert.equal(act(simulation, ++sequence, 'wind.zephyr_palm').ok, true);
    advance(simulation, 1);
  }
  assert.equal(simulation.snapshot().units[0].tigereyeStacks, 6);
  assert.equal(act(simulation, ++sequence, 'wind_tigereye_brew', null).ok, true);
  let wind = simulation.snapshot().units[0];
  assert.equal(wind.tigereyeStacks, 0);
  assert.equal(wind.effects.tigereyeBrew.power, .3);
  const before = simulation.snapshot().units[1].hp;
  assert.equal(act(simulation, ++sequence, 'wind.zephyr_palm').ok, true);
  const after = simulation.snapshot().units[1].hp;
  assert.equal(before - after, 65);
  wind = simulation.snapshot().units[0];
  assert.equal(wind.stats.damageByAbility['Zephyr Palm'], 365);
});

test('three Flow stacks convert into Tempest Flow and Windbound snare', () => {
  const simulation = fixture();
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    assert.equal(act(simulation, sequence, 'wind.zephyr_palm').ok, true);
    advance(simulation, 1);
  }
  const [wind, enemy] = simulation.snapshot().units;
  assert.equal(wind.effects.flow, undefined);
  assert.ok(wind.effects.tempestFlow);
  assert.equal(enemy.effects.slow.pct, .5);
  assert.ok(enemy.effects.windboundSnareIcd);
});

test('Windlord resets Cloudstep and arms one Rising Sun Kick', () => {
  const simulation = fixture();
  simulation.setCooldown('wind', 'wind.cloudstep_kick', 8);
  assert.equal(act(simulation, 1, 'wind_tiger_rush').ok, true);
  let wind = simulation.snapshot().units[0];
  assert.equal(wind.cooldowns['wind.cloudstep_kick'], undefined);
  assert.ok(wind.effects.risingSunReady);
  advance(simulation, 1);
  const before = simulation.snapshot().units[1].hp;
  assert.equal(act(simulation, 2, 'wind.zephyr_palm').ok, true);
  const after = simulation.snapshot().units[1].hp;
  assert.equal(before - after, 271);
  wind = simulation.snapshot().units[0];
  assert.equal(wind.effects.risingSunReady, undefined);
});

test('Fists of Fury is a seven-wave uninterruptible moving channel', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'wind.fists_of_fury', null).ok, true);
  assert.equal(simulation.snapshot().units[0].cast.channel, true);
  advance(simulation, 2.5);
  const wind = simulation.snapshot().units[0];
  const enemy = simulation.snapshot().units[1];
  assert.equal(wind.cast, null);
  assert.equal(enemy.hp, 3000 - 7 * 68);
  assert.equal(wind.stats.damageByAbility['Fists of Fury'], 14 * 68);
  assert.ok(enemy.effects.slow);
});

test('Disrupting Palm interrupts, locks the school and adds Flow', () => {
  const simulation = fixture();
  assert.equal(simulation.applyAction('enemy', {
    sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'wind'
  }).ok, true);
  assert.ok(simulation.snapshot().units[1].cast);
  assert.equal(act(simulation, 1, 'wind.disrupting_palm').ok, true);
  const wind = simulation.snapshot().units[0];
  const enemy = simulation.snapshot().units[1];
  assert.equal(enemy.cast, null);
  assert.ok(enemy.effects.lock_fire);
  assert.equal(wind.effects.flow.stacks, 1);
  assert.equal(wind.stats.interrupts, 1);
  assert.equal(simulation.applyAction('enemy', {
    sequence: 2, abilityId: 'flame.cinder_bolt', targetId: 'wind'
  }).reason, 'school_locked');
});

test('Willow Guard heals and reduces incoming damage by 50 percent', () => {
  const simulation = fixture({ windHp: 1000 });
  assert.equal(act(simulation, 1, 'wind.willow_guard', null).ok, true);
  assert.equal(simulation.snapshot().units[0].hp, 1135);
  const source = simulation.state.units.get('enemy');
  const target = simulation.state.units.get('wind');
  simulation.combat.damage(source, target, 100, 'Test Strike');
  assert.equal(simulation.snapshot().units[0].hp, 1085);
});

test('Incapacitate uses DR and breaks when real damage lands', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'wind.incapacitate').ok, true);
  assert.ok(simulation.snapshot().units[1].effects.windIncap);
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'wind.zephyr_palm').ok, true);
  assert.equal(simulation.snapshot().units[1].effects.windIncap, undefined);
  const target = simulation.state.units.get('enemy');
  assert.equal(simulation.combat.applyCrowdControl(target, 'windIncap', 4, 'incap'), 2);
  assert.equal(simulation.combat.applyCrowdControl(target, 'windIncap', 4, 'incap'), 1);
  assert.equal(simulation.combat.applyCrowdControl(target, 'windIncap', 4, 'incap'), 0);
});

test('Cloudstep Dash closes 17m once, then returns to normal melee range', () => {
  const simulation = fixture();
  const wind = simulation.state.units.get('wind');
  const enemy = simulation.state.units.get('enemy');
  enemy.x = 12;
  assert.equal(act(simulation, 1, 'wind.cloudstep_kick').ok, true);
  assert.equal(enemy.hp, 3000 - Math.round(127 * 1.2));
  assert.ok(distanceForTest(wind, enemy) <= 2.51);
  assert.ok(simulation.snapshot().units[0].effects.cloudstepDashCd);
  advance(simulation, 8);
  enemy.x = wind.x + 10;
  assert.equal(act(simulation, 2, 'wind.cloudstep_kick').reason, 'range');
});

test('Valley Sweep damages and stuns every nearby visible enemy', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'wind.valley_sweep').ok, true);
  const [, enemy, enemy2] = simulation.snapshot().units;
  assert.equal(enemy.hp, 2958);
  assert.equal(enemy2.hp, 2958);
  assert.equal(enemy.effects.stun.remaining, 5);
  assert.equal(enemy2.effects.stun.remaining, 5);
});

test('Touch of Death explodes for 30 percent of damage dealt during five seconds', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'wind_chi_burst').ok, true);
  assert.equal(act(simulation, 2, 'wind.zephyr_palm').ok, true);
  assert.equal(simulation.snapshot().units[1].effects.touchOfDeath.accumulated, 50);
  advance(simulation, 5);
  assert.equal(simulation.snapshot().units[0].stats.damageByAbility['Touch of Death'], 15);
  assert.equal(simulation.snapshot().units[1].effects.touchOfDeath, undefined);
});

test('Whirling Dragon Punch is off-global AoE unlocked only by Fists of Fury cooldown', () => {
  const simulation = fixture();
  assert.equal(act(simulation, 1, 'wind.whirling_dragon_punch', null).reason, 'requires_fists_cooldown');
  assert.equal(act(simulation, 2, 'wind.fists_of_fury', null).ok, true);
  advance(simulation, 2.6);
  const beforeOne = simulation.state.units.get('enemy').hp;
  const beforeTwo = simulation.state.units.get('enemy2').hp;
  assert.equal(act(simulation, 3, 'wind.whirling_dragon_punch', null).ok, true);
  assert.equal(beforeOne - simulation.state.units.get('enemy').hp, 180);
  assert.equal(beforeTwo - simulation.state.units.get('enemy2').hp, 180);
  assert.ok(simulation.snapshot().units[0].cooldowns['wind.whirling_dragon_punch'] > 23);
});

test("Tiger's Lust removes roots and Touch of Karma reflects damage", () => {
  const simulation = fixture();
  const wind = simulation.state.units.get('wind');
  const enemy = simulation.state.units.get('enemy');
  simulation.combat.applyCrowdControl(wind, 'root', 4, 'root');
  assert.equal(act(simulation, 1, 'wind_tigers_lust', null).ok, true);
  assert.equal(simulation.snapshot().units[0].effects.root, undefined);
  assert.equal(simulation.snapshot().units[0].effects.tigersLust.speed, 1.6);
  assert.equal(act(simulation, 2, 'wind_karma', null).reason, 'gcd');
  advance(simulation, 1);
  assert.equal(act(simulation, 3, 'wind_karma', null).ok, true);
  const enemyBefore = enemy.hp;
  const windBefore = wind.hp;
  simulation.combat.damage(enemy, wind, 100, 'Test Strike');
  assert.equal(windBefore - wind.hp, 80);
  assert.equal(enemyBefore - enemy.hp, 40);
});

test('shields, deaths and dampened healing are included in authoritative meters', () => {
  const simulation = fixture({ windHp: 1000 });
  const wind = simulation.state.units.get('wind');
  const enemy = simulation.state.units.get('enemy');
  simulation.combat.addEffect(wind, 'shield', 5, { value: 70 });
  wind.shield = 70;
  simulation.combat.damage(enemy, wind, 100, 'Shield Test');
  assert.equal(wind.hp, 970);
  assert.equal(wind.shield, 0);
  simulation.state.dampening = .50;
  assert.equal(simulation.combat.heal(wind, wind, 100, 'Dampened Test'), 50);
  simulation.combat.damage(wind, enemy, 5000, 'Finisher');
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.units[1].alive, false);
  assert.equal(snapshot.units[0].stats.killingBlows, 1);
  assert.equal(snapshot.units[0].stats.healingByAbility['Dampened Test'], 50);
});

function distanceForTest(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
