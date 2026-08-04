import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../packages/simulation/src/index.js';

const advance = (simulation, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i += 1) simulation.step(1 / 30);
};

function fixture(classId, options = {}) {
  return createSimulation({
    seed: options.seed || 31,
    arena: { x: 30, z: 20, pillars: [] },
    roster: [
      { id: 'player', team: 'allies', classId, x: 0, z: 0, hp: 1000, maxHp: 1800, resource: 100 },
      { id: 'ally', team: 'allies', classId: 'warrior', x: 2, z: 0, hp: 600, maxHp: 1800, resource: 100 },
      { id: 'enemy', team: 'enemies', classId: 'flame', x: 3, z: 0, hp: 6000, maxHp: 6000, resource: 100 },
      { id: 'enemy2', team: 'enemies', classId: 'warrior', x: 5, z: 1, hp: 6000, maxHp: 6000, resource: 100 }
    ]
  });
}

const act = (simulation, sequence, abilityId, targetId = 'enemy') =>
  simulation.applyAction('player', { sequence, abilityId, targetId });

test('Shadowblade builds Venom Edge, empowers Viper Cut and owns poison ticks', () => {
  const simulation = fixture('shadow');
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    assert.equal(act(simulation, sequence, 'shadow.night_slash').ok, true);
    advance(simulation, 1);
  }
  assert.ok(simulation.snapshot().units[0].effects.venomEdge);
  const before = simulation.state.units.get('enemy').hp;
  assert.equal(act(simulation, 4, 'shadow.viper_cut').ok, true);
  assert.equal(before - simulation.state.units.get('enemy').hp, Math.round((70 + 78) * 1.10));
  assert.equal(simulation.snapshot().units[0].effects.venomEdge, undefined);
  advance(simulation, 1);
  assert.equal(before - simulation.state.units.get('enemy').hp, Math.round(148 * 1.10) + Math.round(28 * 1.10));
});

test('Shadowblade mobility, control setup and interrupt are authoritative', () => {
  const simulation = fixture('shadow');
  simulation.state.units.get('enemy').x = 12;
  assert.equal(act(simulation, 1, 'shadow.umbral_pounce').ok, true);
  assert.ok(simulation.state.units.get('player').x > 8);
  assert.equal(simulation.snapshot().units[0].effects.evasion.pct, .8);
  assert.equal(act(simulation, 2, 'shadow.ribbreaker').ok, true);
  assert.ok(simulation.snapshot().units[2].effects.stun);
  assert.ok(simulation.snapshot().units[0].effects.eviscerateReady);
  simulation.combat.removeEffect(simulation.state.units.get('enemy'), 'stun', 'test');
  assert.equal(simulation.applyAction('enemy', { sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'player' }).ok, true);
  assert.equal(act(simulation, 3, 'shadow.shadow_kick').ok, true);
  assert.equal(simulation.snapshot().units[2].cast, null);
});

test('Stormkeeper grants exactly three free instant empowered Arc Sparks', () => {
  const simulation = fixture('storm');
  assert.equal(act(simulation, 1, 'storm_thunderstep', null).ok, true);
  advance(simulation, 1.5);
  assert.equal(simulation.snapshot().units[0].effects.stormkeeper.stacks, 3);
  const before = simulation.state.units.get('enemy').hp;
  for (let sequence = 2; sequence <= 4; sequence += 1) {
    assert.equal(act(simulation, sequence, 'storm.arc_spark').ok, true);
    advance(simulation, .25);
  }
  assert.equal(before - simulation.state.units.get('enemy').hp, 3 * 136);
  assert.equal(simulation.snapshot().units[0].effects.stormkeeper, undefined);
});

test('Storm chain, Flame Shock, snare and reactive Wind Shear use server state', () => {
  const simulation = fixture('storm');
  assert.equal(act(simulation, 1, 'storm.forked_current').ok, true);
  assert.equal(simulation.state.units.get('enemy').hp, 6000 - 132);
  assert.equal(simulation.state.units.get('enemy2').hp, 6000 - Math.round(132 * .7));
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'storm.flame_shock').ok, true);
  advance(simulation, 1);
  assert.equal(simulation.state.units.get('enemy').hp, 6000 - 132 - 34);
  assert.equal(act(simulation, 3, 'storm_grounding_aegis').ok, true);
  assert.equal(simulation.snapshot().units[2].effects.slow.pct, .5);
  assert.equal(simulation.applyAction('enemy', { sequence: 1, abilityId: 'flame.cinder_bolt', targetId: 'player' }).ok, true);
  assert.equal(act(simulation, 4, 'storm.wind_shear').ok, true);
  assert.ok(simulation.snapshot().units[2].effects.lock_fire);
});

test('Skybreaker readies one Volcanic Eruption and Storm utility is mana-free', () => {
  const simulation = fixture('storm');
  const source = simulation.state.units.get('player');
  const startingResource = source.resource;
  simulation.drainEvents();
  assert.equal(act(simulation, 1, 'storm.skybreaker_pulse').ok, true);
  assert.equal(source.resource, startingResource);
  assert.ok(simulation.snapshot().units[0].effects.volcanicEruptionReady);
  assert.equal(act(simulation, 2, 'storm_lava_burst').ok, true);
  assert.equal(6000 - simulation.state.units.get('enemy').hp, 55 + 353 + 60 + 60);
  assert.equal(simulation.state.units.get('player').stats.damageByAbility['Volcanic Lava Burst 1'], 60);
  assert.equal(simulation.state.units.get('player').stats.damageByAbility['Volcanic Lava Burst 2'], 60);
  assert.equal(simulation.drainEvents().filter(event => event.type === 'presentation' && event.cue === 'volcanicLavaBurst').length, 2);
  const afterEruptionResource = source.resource;
  assert.equal(simulation.snapshot().units[0].effects.volcanicEruptionReady, undefined);
  assert.equal(act(simulation, 3, 'storm_lava_burst').ok, false);
  advance(simulation, 1);
  const beforeGale = source.resource;
  assert.equal(act(simulation, 4, 'storm.gale_reversal', null).ok, true);
  assert.equal(source.resource, beforeGale);
  advance(simulation, 1);
  const beforeSnare = source.resource;
  assert.equal(act(simulation, 5, 'storm.static_snare').ok, true);
  assert.equal(source.resource, beforeSnare);
});

test('Healing Surge is a casted friendly heal and Static Aegis carries 20 percent reduction', () => {
  const simulation = fixture('storm');
  const ally = simulation.state.units.get('ally');
  const before = ally.hp;
  assert.equal(act(simulation, 1, 'storm_chain_spark', 'ally').ok, true);
  assert.ok(simulation.snapshot().units[0].cast);
  advance(simulation, 1.5);
  assert.equal(ally.hp - before, 340);
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'storm.static_aegis', null).ok, true);
  assert.equal(simulation.snapshot().units[0].effects.staticAegisGuard.reduction, .20);
});

test('Soulweaver afflictions stack and amplify each Essence Siphon channel tick', () => {
  const simulation = fixture('soul');
  assert.equal(act(simulation, 1, 'soul.soul_scar').ok, true);
  assert.equal(simulation.combat.getEffect(simulation.state.units.get('enemy'), 'soulScar').remaining, 15);
  advance(simulation, .5);
  assert.equal(act(simulation, 2, 'soul.creeping_torment').ok, true);
  assert.equal(simulation.combat.getEffect(simulation.state.units.get('enemy'), 'agony').remaining, 15);
  advance(simulation, .5);
  assert.equal(act(simulation, 3, 'soul.unstable_affliction').ok, true);
  advance(simulation, 1.3);
  const hp = simulation.state.units.get('player').hp;
  assert.equal(act(simulation, 4, 'soul.essence_siphon').ok, true);
  assert.equal(simulation.snapshot().units[2].effects.unstableAffliction.remaining, 10);
  advance(simulation, 2.5);
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.units[0].stats.damageByAbility['Essence Siphon'], 5 * 92);
  assert.ok(snapshot.units[0].hp > hp);
  assert.equal(snapshot.units[0].cast, null);
});

test('Shadowfury empowers exactly one Pandemic Bloom by 20 percent', () => {
  const simulation = fixture('soul');
  assert.equal(act(simulation, 1, 'soul_shadowfury').ok, true);
  assert.ok(simulation.snapshot().units[0].effects.pandemicSurge);
  advance(simulation, 1);
  const before = simulation.state.units.get('enemy').hp;
  assert.equal(act(simulation, 2, 'soul_pandemic_bloom').ok, true);
  assert.equal(before - simulation.state.units.get('enemy').hp, Math.round(274 * 1.2));
  assert.equal(simulation.snapshot().units[0].effects.pandemicSurge, undefined);
});

test('Blooming Echo and Rejuvenate coexist and both tick on the same ally', () => {
  const simulation = fixture('sage');
  assert.equal(act(simulation, 1, 'sage.blooming_echo', 'ally').ok, true);
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'sage_rejuvenate', 'ally').ok, true);
  let ally = simulation.snapshot().units[1];
  assert.ok(ally.effects['hot:sage.blooming_echo']);
  assert.ok(ally.effects['hot:sage_rejuvenate']);
  const before = ally.hp;
  advance(simulation, 1);
  ally = simulation.snapshot().units[1];
  assert.ok(ally.hp - before >= 50);
  assert.ok(simulation.snapshot().units[0].stats.healingByAbility['Blooming Echo'] > 0);
  assert.ok(simulation.snapshot().units[0].stats.healingByAbility.Rejuvenate > 0);
});

test('Soul Barrier grants absorb and interrupt immunity; fear respects DR', () => {
  const simulation = fixture('soul');
  assert.equal(act(simulation, 1, 'soul.soul_barrier', null).ok, true);
  assert.equal(simulation.snapshot().units[0].shield, 225);
  assert.ok(simulation.snapshot().units[0].effects.interruptWard);
  advance(simulation, .5);
  assert.equal(act(simulation, 2, 'soul_horror').ok, true);
  assert.equal(simulation.snapshot().units[2].effects.fear.remaining, 3.5);
});

test('Lifesage HoTs, Ghanir acceleration and Spirit Blossom are server-timed', () => {
  const simulation = fixture('sage');
  assert.equal(act(simulation, 1, 'sage.ghanir_the_mother_tree', null).ok, true);
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'sage.blooming_echo', 'ally').ok, true);
  const afterDirect = simulation.state.units.get('ally').hp;
  advance(simulation, 1);
  assert.equal(simulation.state.units.get('ally').hp - afterDirect, 72);
  assert.equal(act(simulation, 3, 'sage.spirit_blossom', 'ally').ok, true);
  advance(simulation, .1);
  assert.ok(simulation.snapshot().units[1].shield >= 23);
  assert.ok(simulation.snapshot().units[0].effects.spiritBlossomTree);
});

test('Fae Retreat travels nine metres and grants its defensive window', () => {
  const simulation = fixture('sage');
  simulation.applyInput('player', { sequence: 1, x: 1, z: 0 });
  assert.equal(act(simulation, 1, 'sage.fae_retreat', null).ok, true);
  assert.equal(simulation.state.units.get('player').x, -9);
  assert.equal(simulation.snapshot().units[0].effects.defensive.reduction, .30);
});

test('Nature Swiftness makes a cooldown-blocked Renewal Tide immediate', () => {
  const simulation = fixture('sage');
  simulation.setCooldown('player', 'sage.renewal_tide', 20);
  assert.equal(act(simulation, 1, 'sage_rejuvenating_gust', null).ok, true);
  assert.equal(act(simulation, 2, 'sage.renewal_tide', 'ally').ok, true);
  assert.equal(simulation.snapshot().units[0].effects.natureSwiftness, undefined);
  assert.equal(simulation.snapshot().units[1].hp, 1417);
});

test('Discipline Atonement converts Smite and Solace damage into shared healing', () => {
  const simulation = fixture('disc');
  assert.equal(act(simulation, 1, 'disc.power_shield', 'ally').ok, true);
  advance(simulation, 1);
  assert.equal(act(simulation, 2, 'disc.smite').ok, true);
  advance(simulation, 1.2);
  assert.equal(simulation.snapshot().units[1].hp, 740);
  assert.equal(act(simulation, 3, 'disc.solace').ok, true);
  assert.equal(simulation.snapshot().units[1].hp, 905);
  assert.equal(simulation.snapshot().units[0].stats.healingByAbility['Smite Atonement'], 140);
});

test('Shadow Mend applies Atonement to its healed target', () => {
  const simulation = fixture('disc');
  assert.equal(act(simulation, 1, 'disc.shadow_mend', 'ally').ok, true);
  advance(simulation, 1.5);
  const ally = simulation.snapshot().units[1];
  assert.equal(ally.hp, 886);
  assert.ok(ally.effects.atonement);
  assert.ok(ally.effects.atonement.remaining > 13);
});

test('Ultimate Radiance and Penance own group recovery, proc speed and meters', () => {
  const simulation = fixture('disc');
  assert.equal(act(simulation, 1, 'disc.ultimate_radiance', null).ok, true);
  assert.ok(simulation.snapshot().units[0].effects.radiantPenanceProc);
  advance(simulation, 1);
  const enemyBefore = simulation.state.units.get('enemy').hp;
  assert.equal(act(simulation, 2, 'disc.penance').ok, true);
  assert.equal(simulation.snapshot().units[0].cast.duration, 1.05);
  advance(simulation, 1.1);
  assert.equal(enemyBefore - simulation.state.units.get('enemy').hp, 3 * Math.round(82 * 1.15));
  assert.equal(simulation.snapshot().units[0].effects.radiantPenanceProc, undefined);
});
