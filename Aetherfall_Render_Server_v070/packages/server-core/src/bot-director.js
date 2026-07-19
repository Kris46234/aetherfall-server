import { getAbility } from '../../content/src/catalogue.js';
import { clamp, distance, hasLineOfSight } from '../../simulation/src/geometry.js';

const HARD_CONTROL = ['stun', 'fear', 'poly', 'sleep', 'blind', 'windIncap'];
const DISPELLABLE_CONTROL = ['poly', 'sleep', 'blind', 'fear', 'windIncap', 'root', 'slow'];
const MAJOR_OFFENSIVES = [
  'combustion', 'stormkeeper', 'tempestBolts', 'instantBolt', 'meteorLance',
  'avatar', 'tigereyeBrew', 'risingSunReady', 'warbreakerReady',
  'empoweredSwing', 'gushingWoundReady', 'vendetta', 'eviscerateReady',
  'venomEdge', 'smokePower'
];
const CAST_OFF_GLOBAL = new Set([
  'pummel', 'reflect', 'warriorGuard', 'avatar', 'paladinSteed',
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
  })
});

function ratio(unit) {
  return unit?.maxHp > 0 ? unit.hp / unit.maxHp : 0;
}

function effect(unit, type) {
  return unit?.effects?.get(type) || null;
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
  constructor(simulation, botIds, { decisionInterval = .1 } = {}) {
    this.simulation = simulation;
    this.botIds = [...botIds].sort();
    this.decisionInterval = decisionInterval;
    this.accumulator = decisionInterval;
    this.inputSequence = new Map(this.botIds.map(id => [id, 0]));
    this.actionSequence = new Map(this.botIds.map(id => [id, 0]));
    this.memory = new Map(this.botIds.map(id => [id, {
      focusId: null,
      focusUntil: 0,
      health: new Map(),
      lastPosition: null,
      stuckFor: 0,
      strafeSign: id.localeCompare('bot2') < 0 ? 1 : -1
    }]));
  }

  update(elapsed) {
    this.accumulator += elapsed;
    while (this.accumulator + 1e-9 >= this.decisionInterval) {
      this.accumulator -= this.decisionInterval;
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
    memory.focusId = selected?.id || null;
    memory.focusUntil = now + 2.2;
    return selected;
  }

  #paladin(bot, allies, enemies) {
    const arena = this.simulation.state.arena;
    const evaluated = allies.map(ally => ({ ally, state: this.#pressure(bot, ally, enemies) }))
      .sort((a, b) => b.state.score - a.state.score || a.ally.id.localeCompare(b.ally.id));
    const injured = evaluated[0]?.ally || bot;
    const danger = evaluated[0]?.state || { ratio: 1, dropRate: 0, burst: 0 };
    const partner = allies.find(unit => unit !== bot) || bot;
    const nearestEnemy = [...enemies].sort((a, b) => distance(bot, a) - distance(bot, b) || a.id.localeCompare(b.id))[0];
    const enemyRange = distance(bot, nearestEnemy);
    const canHeal = distance(bot, injured) <= 28 && visible(bot, injured, arena);

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
    if (danger.ratio < .62 && this.#action(bot, 'pala_guardian_angel', injured)) return;
    if (danger.ratio < .55 && this.#action(bot, 'pala_divine_toll', injured)) return;
    if (danger.ratio < .68 && this.#action(bot, 'pala_word_of_glory', injured)) return;
    if (danger.ratio < .78 && this.#action(bot, 'pala.holy_shock', injured)) return;

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

    if (controlled(bot)) {
      this.#input(bot, 0, 0);
      if ((hp < .45 || healerControlled) && bot.trinketCooldown <= 0) this.simulation.useTrinket(bot.id);
      return;
    }
    if ((hp < .42 || healerControlled && hp < .64) && this.#action(bot, 'warrior.shield_wall', bot)) return;
    if (hp < .57 && range <= 4.5 && this.#action(bot, 'war_victory_rush', target)) return;
    if (incomingCast && this.#action(bot, 'warrior.spell_reflection', bot)) return;
    if (target.cast && range <= 3.5 && this.#action(bot, 'warrior.pummel', target)) return;
    if (nearbyEnemies.length >= 2 && (healerControlled || hp < .65) && this.#action(bot, 'warrior.intimidating_shout', bot)) return;

    if (range > 3.4) {
      if (range <= 17 && visible(bot, target, arena) && this.#action(bot, 'warrior.charge', target)) return;
      return this.#moveToward(bot, target);
    }
    this.#input(bot, 0, 0);
    if (!visible(bot, target, arena)) return this.#moveToward(bot, target);
    if (hp < .68 && this.#action(bot, 'war_victory_rush', target)) return;
    if (ratio(target) < .35 && this.#action(bot, 'war_execute_strike', target)) return;
    if (!effect(bot, 'avatar') && ratio(target) < .82 && this.#action(bot, 'war_skullbreaker', bot)) return;
    if (!effect(bot, 'warbreakerReady') && this.#action(bot, 'war_disarm', target)) return;
    if (nearbyEnemies.length >= 2 && this.#action(bot, 'war_heroic_leap', bot)) return;
    if (!effect(target, 'bleed') && this.#action(bot, 'warrior.rend', target)) return;
    if (effect(bot, 'gushingWoundReady') && this.#action(bot, 'warrior.rend', target)) return;
    this.#action(bot, 'warrior.mortal_swing', target);
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
  }
}
