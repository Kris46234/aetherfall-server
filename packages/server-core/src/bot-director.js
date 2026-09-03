import { getAbility } from '../../content/src/catalogue.js';
import { clamp, distance, hasLineOfSight } from '../../simulation/src/geometry.js';
import { createAiHost } from './ai-host.js';

const HARD_CONTROL = ['stun', 'fear', 'poly', 'sleep', 'blind', 'windIncap'];
const DISPELLABLE_CONTROL = ['poly', 'sleep', 'blind', 'fear', 'windIncap', 'root', 'slow'];
const MAJOR_OFFENSIVES = [
  'combustion', 'stormkeeper', 'tempestBolts', 'instantBolt', 'meteorLance',
  'avatar', 'tigereyeBrew', 'risingSunReady', 'warbreakerReady',
  'empoweredSwing', 'gushingWoundReady', 'vendetta', 'eviscerateReady',
  'venomEdge', 'smokePower'
];
const CAST_OFF_GLOBAL = new Set([
  'pummel', 'reflect', 'warriorGuard', 'avatar', 'paladinSteed', 'avengingWings',
  'painSuppression', 'interrupt', 'interruptProc', 'windInterrupt',
  'shadowInterrupt'
]);

/**
 * Curated legal-style arena builds for the two authoritative enemies. These
 * are deliberately explicit: bot strength must not depend on either player's
 * local progression or browser storage.
 */
export const BOT_TALENT_LOADOUTS = Object.freeze({
  pala: Object.freeze({
    holytraining: 3,
    fastlight: 2,
    steadfast: 2,
    palpath: 1,
    radiance: 2,
    pala_divine_toll: 1,
    pala_radiant_shock: 2,
    pala_judgement: 1,
    pala_sacred_stamina: 2,
    pala_word_of_glory: 1,
    pala_blinding_light: 1
  }),
  warrior: Object.freeze({
    warlust: 3,
    deepwounds: 2,
    ironwall: 2,
    brutalchoice: 1,
    executioner: 2,
    war_pummel_chain: 2,
    war_hold_the_line: 2,
    war_skullbreaker: 1,
    war_plate_training: 2,
    war_heroic_leap: 1,
    war_victory_rush: 1,
    war_disarm: 1,
    war_execute_strike: 1
  }),
  disc: Object.freeze({ disc_archangel: 1, disc_angelic_body: 1 }),
  sage: Object.freeze({ sage_natures_grasp: 1, sage_rejuvenate: 1, sage_spirit_bloom: 1 }),
  flame: Object.freeze({ flame_combustion: 1, flame_meteor_spear: 1, flame_phoenix_guard: 1 }),
  shadow: Object.freeze({ shadow_cloak: 1, shadow_crimson_vial: 1, shadow_gouge: 1, shadow_garrote: 1 }),
  storm: Object.freeze({ storm_thunderstep: 1, storm_grounding_aegis: 1, storm_chain_spark: 1 }),
  wind: Object.freeze({ wind_karma: 1, wind_tiger_rush: 1, wind_tigereye_brew: 1 }),
  soul: Object.freeze({ soul_dark_pact: 1, soul_horror: 1, soul_shadowfury: 1, soul_void_mend: 1, soul_summon_infernal: 1 })
});

function ratio(unit) {
  return unit?.maxHp > 0 ? unit.hp / unit.maxHp : 0;
}

function effect(unit, type) {
  return unit?.effects?.get(type) || [...(unit?.effects?.values?.() || [])].find(entry => entry.type === type) || null;
}

function controlled(unit) {
  return HARD_CONTROL.some(type => effect(unit, type));
}

function hasMajorOffensive(unit) {
  return MAJOR_OFFENSIVES.some(type => effect(unit, type));
}

function visible(from, to, arena) {
  return !!from && !!to && hasLineOfSight(from, to, arena.pillars, .05);
}

export class BotDirector {
  constructor(simulation, botIds, { decisionInterval = .22, reactionMin = .42, reactionMax = .70, interruptChance = .28, usePortedAi = true, mode = '2v2' } = {}) {
    this.simulation = simulation;
    this.botIds = [...botIds].sort();
    this.decisionInterval = decisionInterval;
    this.reactionMin = reactionMin;
    this.reactionMax = reactionMax;
    this.interruptChance = interruptChance;
    this.castLockout = new Map(this.botIds.map(id => [id, 0]));
    /* The offline AIController, adapted onto this simulation. It is the preferred
       brain; the routine further down is only a fallback. */
    this.aiHost = usePortedAi === false ? null : createAiHost(simulation, {
      mode,
      profile: { min: reactionMin, max: reactionMax, interrupt: interruptChance, kite: .34, fakeDelay: .42 }
    });
    this.aiFailure = null;
    this.rngState = (this.botIds.join('|').split('').reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261) || 1) >>> 0;
    this.accumulator = decisionInterval;
    this.inputSequence = new Map(this.botIds.map(id => [id, 0]));
    this.actionSequence = new Map(this.botIds.map(id => [id, 0]));
    this.teamRegroup = new Map();
    this.memory = new Map(this.botIds.map(id => [id, {
      focusId: null,
      focusUntil: 0,
      health: new Map(),
      lastPosition: null,
      stuckFor: 0,
      interruptKey: null,
      interruptRoll: false,
      strafeSign: id.localeCompare('bot2') < 0 ? 1 : -1
    }]));
  }

  update(elapsed) {
    /* Preferred path: the real offline AIController, so online bots play each class the
       way they do in single player. It carries its own reaction pacing through
       ratingProfile(), so the simple cast lockout below is not stacked on top of it.
       If it ever throws, drop to the built-in routine rather than freezing the bots
       mid-match, and record the failure. */
    if (this.aiHost) {
      try {
        for (const botId of this.botIds) {
          const bot = this.simulation.state.units.get(botId);
          if (bot && bot.alive) this.aiHost.step(bot, elapsed);
        }
        return;
      } catch (error) {
        this.aiHost = null;
        this.aiFailure = error;
        if (typeof console !== 'undefined' && console.error) {
          console.error('Ported AI failed, falling back to built-in bots:', error && error.message);
        }
      }
    }
    for (const botId of this.botIds) {
      this.castLockout.set(botId, Math.max(0, (this.castLockout.get(botId) || 0) - elapsed));
    }
    this.accumulator += elapsed;
    while (this.accumulator + 1e-9 >= this.decisionInterval) {
      this.accumulator -= this.decisionInterval;
      for (const memory of this.memory.values()) {
        for (const id of memory.health.keys()) if (!this.simulation.state.units.has(id)) memory.health.delete(id);
      }
      for (const botId of this.botIds) this.#decide(botId);
    }
  }

  #nextInput(botId) {
    const sequence = (this.inputSequence.get(botId) || 0) + 1;
    this.inputSequence.set(botId, sequence);
    return sequence;
  }

  #nextAction(botId) {
    const sequence = (this.actionSequence.get(botId) || 0) + 1;
    this.actionSequence.set(botId, sequence);
    return sequence;
  }

  #input(bot, x, z) {
    const length = Math.hypot(x, z);
    this.simulation.applyInput(bot.id, {
      sequence: this.#nextInput(bot.id),
      x: length > .001 ? x / length : 0,
      z: length > .001 ? z / length : 0
    });
  }

  #ready(bot, abilityId) {
    const source = getAbility(abilityId);
    if (!source || source.classId !== bot.classId || !bot.alive) return false;
    if (source.source === 'talent' && !bot.talents?.[source.id]) return false;
    const ability = this.simulation.combat.prepareAbility(bot, source);
    if (!this.simulation.combat.supports(ability)) return false;
    if (effect(bot, 'iceBlock') || controlled(bot) && ability.type !== 'iceBlock') return false;
    if (effect(bot, 'silence') && ability.school !== 'physical') return false;
    if (effect(bot, `lock_${ability.school}`)) return false;
    if (bot.cast && !this.simulation.combat.canUseWhileCasting(bot, ability) && !CAST_OFF_GLOBAL.has(ability.type)) return false;
    if (!ability.offGlobal && bot.gcd > .001) return false;
    if ((this.castLockout.get(bot.id) || 0) > .001) return false;
    if (!ability.ignoreCooldown && (bot.cooldowns.get(ability.id) || 0) > .001) return false;
    return bot.resource + 1e-6 >= ability.cost;
  }

  #action(bot, abilityId, target = bot) {
    if (!this.#ready(bot, abilityId)) return false;
    const result = this.simulation.applyAction(bot.id, {
      sequence: this.#nextAction(bot.id),
      abilityId,
      targetId: target?.id || null
    });
    if (result.ok) this.#armReaction(bot);
    return !!result.ok;
  }

  /* Offline bots hold an interrupt until the target is actually casting and only land
     it a fraction of the time (botDifficultyProfile's `interrupt`, .28 at entry rating).
     Firing them straight off the priority list both wasted the kick and read nothing
     like the offline opponent. The roll is cached per cast so a bot does not re-roll
     every decision tick and end up interrupting everything anyway. */
  #shouldInterrupt(bot, target) {
    if (!target?.cast) return false;
    const memory = this.memory.get(bot.id);
    if (!memory) return true;
    const key = `${target.id}:${target.cast.abilityId}:${target.cast.sequence ?? ''}`;
    if (memory.interruptKey !== key) {
      memory.interruptKey = key;
      memory.interruptRoll = this.#random() < this.interruptChance;
    }
    return memory.interruptRoll;
  }

  #random() {
    this.rngState = (Math.imul(1664525, this.rngState) + 1013904223) >>> 0;
    return this.rngState / 0x100000000;
  }

  #armReaction(bot) {
    const spread = Math.max(0, this.reactionMax - this.reactionMin);
    this.castLockout.set(bot.id, this.reactionMin + this.#random() * spread);
  }

  #groundAction(bot, abilityId, point) {
    if (!this.#ready(bot, abilityId) || !point) return false;
    const result = this.simulation.applyAction(bot.id, {
      sequence: this.#nextAction(bot.id), abilityId,
      targetId: null, x: point.x, z: point.z
    });
    if (result.ok) this.#armReaction(bot);
    return !!result.ok;
  }

  #pressure(bot, target, enemies) {
    const memory = this.memory.get(bot.id);
    const now = this.simulation.state.time;
    const current = ratio(target);
    const previous = memory.health.get(target.id);
    const elapsed = previous ? Math.max(.001, now - previous.time) : this.decisionInterval;
    const dropRate = previous ? Math.max(0, (previous.ratio - current) / elapsed) : 0;
    memory.health.set(target.id, { ratio: current, time: now });

    let burst = 0;
    for (const enemy of enemies) {
      const focusing = enemy.cast?.targetId === target.id || distance(enemy, target) < 5.8;
      if (focusing) burst += .7;
      if (enemy.cast?.targetId === target.id) burst += enemy.cast.remaining < .55 ? 1.5 : 1;
      if (hasMajorOffensive(enemy)) burst += focusing ? 2.2 : .75;
      if (effect(target, 'smokeBomb')) burst += 1.7;
      if (effect(target, 'livingBomb')) burst += .55;
      if (effect(target, 'bleed') || effect(target, 'unstableAffliction')) burst += .3;
    }
    return { ratio: current, dropRate, burst, score: (1 - current) * 5.4 + Math.min(3, dropRate * 8) + burst * .58 };
  }

  #updateStuck(bot, wantedX, wantedZ) {
    const memory = this.memory.get(bot.id);
    const last = memory.lastPosition;
    const wantsMove = Math.hypot(wantedX, wantedZ) > .05;
    if (last && wantsMove && distance(last, bot) < .035) memory.stuckFor += this.decisionInterval;
    else memory.stuckFor = 0;
    memory.lastPosition = { x: bot.x, z: bot.z };
    if (memory.stuckFor > .45) {
      memory.strafeSign *= -1;
      memory.stuckFor = 0;
      return true;
    }
    return false;
  }

  #move(bot, x, z) {
    if (bot.cast && !bot.cast.channel) return this.#input(bot, 0, 0);
    const stuck = this.#updateStuck(bot, x, z);
    if (stuck) {
      const memory = this.memory.get(bot.id);
      return this.#input(bot, -z * memory.strafeSign, x * memory.strafeSign);
    }
    this.#input(bot, x, z);
  }

  #moveToward(bot, target, away = false) {
    const sign = away ? -1 : 1;
    this.#move(bot, (target.x - bot.x) * sign, (target.z - bot.z) * sign);
  }

  #healPosition(bot, target, enemies) {
    const arena = this.simulation.state.arena;
    const candidates = [{ x: bot.x, z: bot.z }];
    for (const radius of [4, 7.5, 11, 15]) {
      for (let index = 0; index < 20; index += 1) {
        const angle = index * Math.PI * 2 / 20;
        candidates.push({
          x: clamp(target.x + Math.cos(angle) * radius, -arena.x + 1.3, arena.x - 1.3),
          z: clamp(target.z + Math.sin(angle) * radius, -arena.z + 1.3, arena.z - 1.3)
        });
      }
    }
    let best = null;
    let bestScore = -Infinity;
    for (const point of candidates) {
      if (distance(point, target) > 27.5 || !visible(point, target, arena)) continue;
      const travel = distance(bot, point);
      const threatDistance = enemies.length ? Math.min(...enemies.map(enemy => distance(point, enemy))) : 12;
      const blockedThreats = enemies.filter(enemy => !visible(enemy, point, arena)).length;
      const edge = Math.abs(point.x) > arena.x - 3 || Math.abs(point.z) > arena.z - 3;
      const score = -travel * .26 + Math.min(8, threatDistance * .34) + blockedThreats * 2.3 - (edge ? 3 : 0);
      if (score > bestScore) { bestScore = score; best = point; }
    }
    return best;
  }

  #kitePosition(bot, threat, healTarget) {
    const arena = this.simulation.state.arena;
    let best = null;
    let bestScore = -Infinity;
    for (const pillar of arena.pillars) {
      for (const extra of [2.2, 3, 3.8]) {
        for (let index = 0; index < 24; index += 1) {
          const angle = index * Math.PI * 2 / 24;
          const point = {
            x: clamp(pillar.x + Math.cos(angle) * (pillar.radius + extra), -arena.x + 1.3, arena.x - 1.3),
            z: clamp(pillar.z + Math.sin(angle) * (pillar.radius + extra), -arena.z + 1.3, arena.z - 1.3)
          };
          if (healTarget && (distance(point, healTarget) > 27.5 || !visible(point, healTarget, arena))) continue;
          const hidden = visible(threat, point, arena) ? 0 : 1;
          const score = hidden * 10 + Math.min(9, distance(point, threat)) * .35 - distance(bot, point) * .18;
          if (score > bestScore) { bestScore = score; best = point; }
        }
      }
    }
    return best;
  }

  #regroupPlan(bot, allies, enemies, evaluated, threat) {
    const now = this.simulation.state.time;
    const current = this.teamRegroup.get(bot.team);
    if (current && current.until > now && allies.some(unit => unit.id === current.criticalId && unit.alive)) return current;
    const injured = evaluated.filter(entry => entry.state.ratio < .80);
    const critical = evaluated[0]?.ally || bot;
    const healerPressured = evaluated.find(entry => entry.ally === bot)?.state?.burst >= 1.4;
    const separated = critical !== bot && (distance(bot, critical) > 24 || !visible(bot, critical, this.simulation.state.arena));
    if (!threat || injured.length < 2 && !healerPressured && !separated) return null;
    const anchor = this.#kitePosition(bot, threat, critical) || this.#healPosition(bot, critical, enemies);
    if (!anchor) return null;
    const plan = { anchor, criticalId: critical.id, threatId: threat.id, until: now + 2.2 };
    this.teamRegroup.set(bot.team, plan);
    return plan;
  }

  #chooseFocus(bot, enemies) {
    const memory = this.memory.get(bot.id);
    const now = this.simulation.state.time;
    const current = enemies.find(enemy => enemy.id === memory.focusId && enemy.alive);
    if (current && now < memory.focusUntil) return current;
    const healer = enemies.find(enemy => ['sage', 'pala', 'disc'].includes(enemy.classId));
    const scored = enemies.map(enemy => {
      let score = (1 - ratio(enemy)) * 6 - distance(bot, enemy) * .045;
      if (enemy.cast) score += 1.1;
      if (controlled(enemy)) score += 1.35;
      if (healer && healer !== enemy && controlled(healer)) score += 1.8;
      if (effect(enemy, 'defensive') || effect(enemy, 'iceBlock')) score -= 2.2;
      return { enemy, score };
    }).sort((a, b) => b.score - a.score || a.enemy.id.localeCompare(b.enemy.id));
    const selected = scored[0]?.enemy || enemies[0];
    bot.targetId = selected?.id || null;
    memory.focusId = selected?.id || null;
    memory.focusUntil = now + 2.2;
    return selected;
  }

  #paladin(bot, allies, enemies) {
    const arena = this.simulation.state.arena;
    const evaluated = allies.map(ally => ({ ally, state: this.#pressure(bot, ally, enemies) }))
      .sort((a, b) => b.state.score - a.state.score || a.ally.id.localeCompare(b.ally.id));
    const injured = evaluated[0]?.ally || bot;
    bot.targetId = injured.id;
    const danger = evaluated[0]?.state || { ratio: 1, dropRate: 0, burst: 0 };
    const partner = allies.find(unit => unit !== bot) || bot;
    const nearestEnemy = [...enemies].sort((a, b) => distance(bot, a) - distance(bot, b) || a.id.localeCompare(b.id))[0];
    const enemyRange = distance(bot, nearestEnemy);
    const canHeal = distance(bot, injured) <= 28 && visible(bot, injured, arena);
    const regroup = this.#regroupPlan(bot, allies, enemies, evaluated, nearestEnemy);

    if (controlled(bot)) {
      this.#input(bot, 0, 0);
      if ((danger.ratio < .48 || danger.burst >= 3.5) && bot.trinketCooldown <= 0) this.simulation.useTrinket(bot.id);
      return;
    }

    const partnerControl = DISPELLABLE_CONTROL.some(type => effect(partner, type));
    if (partnerControl && this.#action(bot, 'pala.cleanse', partner)) return;
    if ((effect(bot, 'root') || effect(bot, 'slow')) && this.#action(bot, 'pala_freedom', bot)) return;

    const selfState = evaluated.find(entry => entry.ally === bot)?.state || this.#pressure(bot, bot, enemies);
    if ((selfState.ratio < .62 || selfState.burst >= 3.2) && this.#action(bot, 'pala.divine_protection', bot)) return;
    if (partner !== bot && danger.ratio < .74 && danger.burst >= 1.5 && !effect(partner, 'sacrifice') && this.#action(bot, 'pala.blessing_of_sacrifice', partner)) return;
    if (!effect(bot, 'avengingWings') && (danger.ratio < .76 || danger.burst >= 2.4) && this.#action(bot, 'pala.avenging_wings', bot)) return;
    if (danger.ratio < .62 && this.#action(bot, 'pala_guardian_angel', injured)) return;
    if (danger.ratio < .55 && this.#action(bot, 'pala_divine_toll', injured)) return;
    if (danger.ratio < .68 && this.#action(bot, 'pala_word_of_glory', injured)) return;
    if (danger.ratio < .78 && this.#action(bot, 'pala.holy_shock', injured)) return;

    // Under split pressure, spread the delayed heal before committing to a long
    // cast and keep crossing toward the same pillar the endangered partner chose.
    const secondary = evaluated.find(entry => entry.ally !== injured && entry.state.ratio < .88)?.ally;
    if (secondary && !effect(secondary, 'bestowFaith') && this.#action(bot, 'pala.bestow_faith', secondary)) return;
    if (regroup && distance(bot, regroup.anchor) > 1.1 && (danger.ratio < .90 || selfState.ratio < .80 || !canHeal)) {
      if (distance(bot, regroup.anchor) > 8 && this.#action(bot, 'pala.divine_steed', bot)) return;
      return this.#move(bot, regroup.anchor.x - bot.x, regroup.anchor.z - bot.z);
    }

    // The mature offline healer deliberately casts its efficient filler instead
    // of attempting every instant first. Infusion naturally shortens this cast.
    if (danger.ratio < .93 && canHeal && this.#action(bot, 'pala.holy_light', injured)) {
      this.#input(bot, 0, 0);
      return;
    }
    if (danger.ratio < .96 && !effect(injured, 'bestowFaith') && this.#action(bot, 'pala.bestow_faith', injured)) return;

    if (enemyRange <= 10 && (nearestEnemy.cast || danger.burst >= 2.5) && this.#action(bot, 'pala.hammer_of_justice', nearestEnemy)) return;
    if (enemyRange <= 16 && danger.ratio < .86 && this.#action(bot, 'pala_blinding_light', nearestEnemy)) return;

    if (bot.cast) {
      this.#input(bot, 0, 0);
      return;
    }
    if (!canHeal && danger.ratio < .98) {
      const point = this.#healPosition(bot, injured, enemies);
      if (point && distance(bot, point) > .8) return this.#move(bot, point.x - bot.x, point.z - bot.z);
      return this.#moveToward(bot, injured);
    }
    if (enemyRange < 8.5) {
      const point = this.#kitePosition(bot, nearestEnemy, injured);
      if (point) return this.#move(bot, point.x - bot.x, point.z - bot.z);
      return this.#moveToward(bot, nearestEnemy, true);
    }
    if (distance(bot, partner) > 13) return this.#moveToward(bot, partner);

    // Stable teams create pressure and restore mana instead of idling in mid.
    this.#input(bot, 0, 0);
    if (danger.ratio > .90 && this.#action(bot, 'pala_judgement', nearestEnemy)) return;
    if (danger.ratio > .92) this.#action(bot, 'pala.holy_shock', nearestEnemy);
  }

  #warrior(bot, allies, enemies) {
    const target = this.#chooseFocus(bot, enemies);
    if (!target) return this.#input(bot, 0, 0);
    const healer = allies.find(unit => unit !== bot && ['sage', 'pala', 'disc'].includes(unit.classId));
    const arena = this.simulation.state.arena;
    const range = distance(bot, target);
    const hp = ratio(bot);
    const healerControlled = healer ? controlled(healer) : false;
    const incomingCast = enemies.find(enemy => enemy.cast?.targetId === bot.id && enemy.cast.school !== 'physical');
    const nearbyEnemies = enemies.filter(enemy => distance(bot, enemy) <= 8 && visible(bot, enemy, arena));
    const regroup = this.teamRegroup.get(bot.team);
    const regroupActive = regroup && regroup.until > this.simulation.state.time;
    const healerThreat = regroupActive ? enemies.find(enemy => enemy.id === regroup.threatId && enemy.alive) : null;

    if (controlled(bot)) {
      this.#input(bot, 0, 0);
      if ((hp < .45 || healerControlled) && bot.trinketCooldown <= 0) this.simulation.useTrinket(bot.id);
      return;
    }
    if ((hp < .42 || healerControlled && hp < .64) && this.#action(bot, 'warrior.shield_wall', bot)) return;
    if (hp < .57 && range <= 4.5 && this.#action(bot, 'war_victory_rush', target)) return;
    if (incomingCast && this.#action(bot, 'warrior.spell_reflection', bot)) return;
    if (target.cast && range <= 3.8 && this.#action(bot, 'warrior.pummel', target)) return;
    if (nearbyEnemies.length >= 2 && (healerControlled || hp < .65) && this.#action(bot, 'warrior.intimidating_shout', bot)) return;
    const stormboltTarget = enemies
      .filter(enemy => distance(bot, enemy) <= 22 && visible(bot, enemy, arena) && !effect(enemy, 'stun'))
      .sort((a, b) => {
        const value = unit => (unit.cast ? 4 : 0)
          + (['sage', 'pala', 'disc'].includes(unit.classId) ? 2 : 0)
          + (1 - ratio(unit)) * 2;
        return value(b) - value(a);
      })[0];
    if (stormboltTarget && (stormboltTarget.cast || healerControlled || ratio(stormboltTarget) < .72)
      && this.#action(bot, 'war_execute_strike', stormboltTarget)) return;
    if (healerThreat && healer && ratio(healer) < .78 && distance(bot, healerThreat) <= 22 && visible(bot, healerThreat, arena)
      && this.#action(bot, 'war_execute_strike', healerThreat)) return;
    if (regroupActive && healer && ratio(healer) < .62 && distance(bot, regroup.anchor) > 7) {
      return this.#move(bot, regroup.anchor.x - bot.x, regroup.anchor.z - bot.z);
    }

    if (range > 3.7) {
      if (range <= 17 && visible(bot, target, arena) && this.#action(bot, 'warrior.charge', target)) return;
      return this.#moveToward(bot, target);
    }
    this.#input(bot, 0, 0);
    if (!visible(bot, target, arena)) return this.#moveToward(bot, target);
    if (hp < .68 && this.#action(bot, 'war_victory_rush', target)) return;
    if (!effect(bot, 'avatar') && ratio(target) < .82 && this.#action(bot, 'war_skullbreaker', bot)) return;
    if (!effect(bot, 'warbreakerReady') && this.#action(bot, 'war_disarm', target)) return;
    if (nearbyEnemies.length >= 2 && this.#action(bot, 'war_heroic_leap', bot)) return;
    if (!effect(target, 'bleed') && this.#action(bot, 'warrior.rend', target)) return;
    if (effect(bot, 'gushingWoundReady') && this.#action(bot, 'warrior.rend', target)) return;
    this.#action(bot, 'warrior.mortal_swing', target);
  }

  #genericHealer(bot, allies, enemies) {
    const arena = this.simulation.state.arena;
    const evaluated = allies.map(ally => ({ ally, state: this.#pressure(bot, ally, enemies) }))
      .sort((a, b) => b.state.score - a.state.score || a.ally.id.localeCompare(b.ally.id));
    const injured = evaluated[0]?.ally || bot;
    const danger = evaluated[0]?.state || { ratio: 1, burst: 0 };
    const nearestEnemy = [...enemies].sort((a, b) => distance(bot, a) - distance(bot, b))[0];
    const enemyRange = nearestEnemy ? distance(bot, nearestEnemy) : 99;
    const canHeal = distance(bot, injured) <= 27.5 && visible(bot, injured, arena);
    bot.targetId = injured.id;

    if (controlled(bot)) {
      this.#input(bot, 0, 0);
      if ((ratio(bot) < .48 || danger.burst >= 3.5) && bot.trinketCooldown <= 0) this.simulation.useTrinket(bot.id);
      return;
    }

    const defensive = bot.classId === 'disc'
      ? ['disc.pain_suppression', 'disc.fade']
      : ['sage_spirit_bloom', 'sage.fae_retreat'];
    if (danger.ratio < .46) for (const id of defensive) if (this.#action(bot, id, id.includes('pain') || id.includes('spirit') ? injured : bot)) return;

    const cleansable = allies.find(ally => DISPELLABLE_CONTROL.some(type => effect(ally, type)));
    const cleanseId = bot.classId === 'disc' ? 'disc.purify' : 'sage.purifying_light';
    if (cleansable && this.#action(bot, cleanseId, cleansable)) return;

    const priorities = bot.classId === 'disc'
      ? [
        ['disc.power_shield', .90], ['disc.penance', .84], ['disc.shadow_mend', .93],
        ['disc.ultimate_radiance', .54], ['disc.solace', .98]
      ]
      : [
        ['sage.renewal_tide', .48], ['sage.spirit_blossom', .70], ['sage.blooming_echo', .91],
        ['sage_rejuvenate', .94], ['sage.verdant_mend', .96]
      ];
    if (canHeal) {
      for (const [id, threshold] of priorities) {
        if (danger.ratio < threshold && this.#action(bot, id, injured)) {
          if (bot.cast && !bot.cast.channel) this.#input(bot, 0, 0);
          return;
        }
      }
    }

    if (!canHeal || enemyRange < 7.5) {
      const point = enemyRange < 7.5
        ? this.#kitePosition(bot, nearestEnemy, injured)
        : this.#healPosition(bot, injured, enemies);
      if (point) return this.#move(bot, point.x - bot.x, point.z - bot.z);
      return this.#moveToward(bot, enemyRange < 7.5 ? nearestEnemy : injured, enemyRange < 7.5);
    }

    this.#input(bot, 0, 0);
    if (danger.ratio > .88 && nearestEnemy) {
      const pressure = bot.classId === 'disc' ? ['disc.solace', 'disc.smite'] : ['sage.lullaby_bloom'];
      for (const id of pressure) if (this.#action(bot, id, nearestEnemy)) return;
    }
  }

  #genericDamage(bot, allies, enemies) {
    const target = this.#chooseFocus(bot, enemies);
    if (!target) return this.#input(bot, 0, 0);
    const arena = this.simulation.state.arena;
    const range = distance(bot, target);
    const melee = ['shadow', 'wind'].includes(bot.classId);
    const preferredRange = melee ? 3.8 : 19;
    if (controlled(bot)) {
      this.#input(bot, 0, 0);
      if (ratio(bot) < .45 && bot.trinketCooldown <= 0) this.simulation.useTrinket(bot.id);
      return;
    }

    const rotations = {
      flame: ['flame.ice_block', 'flame.counterflare', 'flame_combustion', 'flame_meteor_spear', 'flame.prism_hex', 'flame.ember_lance', 'flame.cinder_bolt'],
      shadow: ['shadow_cloak', 'shadow_crimson_vial', 'shadow.shadow_kick', 'shadow_shadowstep', 'shadow.ribbreaker', 'shadow_garrote', 'shadow.viper_cut', 'shadow.umbral_pounce', 'shadow.night_slash'],
      storm: ['storm.static_aegis', 'storm.wind_shear', 'storm_thunderstep', 'storm.skybreaker_pulse', 'storm.flame_shock', 'storm.forked_current', 'storm.arc_spark'],
      wind: ['wind.willow_guard', 'wind_karma', 'wind.disrupting_palm', 'wind.valley_sweep', 'wind_tiger_rush', 'wind.fists_of_fury', 'wind.cloudstep_kick', 'wind.zephyr_palm'],
      soul: ['soul_undying_resolve', 'soul_dark_pact', 'soul_void_mend', 'soul.fear', 'soul.creeping_torment', 'soul.soul_scar', 'soul.essence_siphon']
    };
    const interrupts = new Set([
      'flame.counterflare', 'shadow.shadow_kick', 'storm.wind_shear', 'wind.disrupting_palm'
    ]);
    const selfOnly = new Set([
      'flame.ice_block', 'flame_combustion', 'shadow_cloak', 'shadow_crimson_vial',
      'storm.static_aegis', 'storm_thunderstep', 'wind.willow_guard', 'wind_karma',
      'soul_undying_resolve', 'soul_dark_pact'
    ]);

    if (range > preferredRange || !visible(bot, target, arena)) {
      if (melee) {
        const gap = bot.classId === 'shadow' ? 'shadow.umbral_pounce' : 'wind.cloudstep_kick';
        if (this.#action(bot, gap, target)) return;
      }
      if (bot.cast) return this.#input(bot, 0, 0);
      return this.#moveToward(bot, target);
    }
    if (!melee && range < 7) return this.#moveToward(bot, target, true);
    this.#input(bot, 0, 0);
    if (bot.classId === 'soul' && this.#groundAction(bot, 'soul_summon_infernal', target)) return;
    for (const id of rotations[bot.classId] || []) {
      const selfTarget = selfOnly.has(id);
      if (selfTarget && ratio(bot) > .52 && !['flame_combustion', 'storm_thunderstep', 'wind_karma'].includes(id)) continue;
      if (interrupts.has(id) && !this.#shouldInterrupt(bot, target)) continue;
      if (this.#action(bot, id, selfTarget ? bot : target)) return;
    }
  }

  #decide(botId) {
    const bot = this.simulation.state.units.get(botId);
    if (!bot?.alive) return;
    const units = [...this.simulation.state.units.values()];
    const allies = units.filter(unit => unit.alive && unit.team === bot.team);
    const enemies = units.filter(unit => unit.alive && unit.team !== bot.team);
    if (!enemies.length) return this.#input(bot, 0, 0);

    if (bot.classId === 'pala') this.#paladin(bot, allies, enemies);
    else if (bot.classId === 'warrior') this.#warrior(bot, allies, enemies);
    else if (['disc', 'sage'].includes(bot.classId)) this.#genericHealer(bot, allies, enemies);
    else this.#genericDamage(bot, allies, enemies);
  }
}
