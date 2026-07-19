import { distance } from '../../simulation/src/geometry.js';

export class BotDirector {
  constructor(simulation, botIds, { decisionInterval = .2 } = {}) {
    this.simulation = simulation;
    this.botIds = [...botIds].sort();
    this.decisionInterval = decisionInterval;
    this.accumulator = decisionInterval;
    this.sequence = new Map(this.botIds.map(id => [id, 0]));
  }

  update(elapsed) {
    this.accumulator += elapsed;
    while (this.accumulator >= this.decisionInterval) {
      this.accumulator -= this.decisionInterval;
      for (const botId of this.botIds) this.#decide(botId);
    }
  }

  #next(botId) {
    const sequence = (this.sequence.get(botId) || 0) + 1;
    this.sequence.set(botId, sequence);
    return sequence;
  }

  #input(bot, x, z) {
    const length = Math.hypot(x, z);
    this.simulation.applyInput(bot.id, {
      sequence: this.#next(bot.id),
      x: length > .001 ? x / length : 0,
      z: length > .001 ? z / length : 0
    });
  }

  #action(bot, abilityId, target = bot) {
    return this.simulation.applyAction(bot.id, {
      sequence: this.#next(bot.id),
      abilityId,
      targetId: target?.id || bot.id
    });
  }

  #paladin(bot, allies, enemies) {
    const allyByHealth = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id));
    const injured = allyByHealth[0] || bot;
    const partner = allies.find(unit => unit !== bot) || bot;
    const enemy = [...enemies].sort((a, b) => distance(bot, a) - distance(bot, b) || a.id.localeCompare(b.id))[0];
    const enemyRange = distance(bot, enemy);
    const partnerRange = distance(bot, partner);
    const injuredRange = distance(bot, injured);

    // Stay connected to the melee partner, close distance to an out-of-range
    // heal target, and kite a player who reaches the healer. A small
    // deterministic strafe prevents the healer from becoming a static turret.
    let moveX = 0;
    let moveZ = 0;
    if (!bot.cast) {
      if (enemyRange < 7.5) {
        moveX = bot.x - enemy.x;
        moveZ = bot.z - enemy.z;
      } else if (injuredRange > 25) {
        moveX = injured.x - bot.x;
        moveZ = injured.z - bot.z;
      } else if (partnerRange > 10.5) {
        moveX = partner.x - bot.x;
        moveZ = partner.z - bot.z;
      } else if (partnerRange > 5.5) {
        const dx = partner.x - bot.x;
        const dz = partner.z - bot.z;
        moveX = -dz * .32;
        moveZ = dx * .32;
      }
    }
    this.#input(bot, moveX, moveZ);

    const selfRatio = bot.hp / bot.maxHp;
    const injuredRatio = injured.hp / injured.maxHp;
    if (selfRatio < .46 && this.#action(bot, 'pala.divine_protection', bot).ok) return;
    if (partner !== bot && partner.hp / partner.maxHp < .58 && this.#action(bot, 'pala.blessing_of_sacrifice', partner).ok) return;
    if (injuredRatio < .90 && this.#action(bot, 'pala.bestow_faith', injured).ok) return;
    if (injuredRatio < .94 && this.#action(bot, 'pala.holy_shock', injured).ok) return;
    if (injuredRatio < .82 && this.#action(bot, 'pala.holy_light', injured).ok) return;
    if (enemy.cast && enemyRange <= 10 && this.#action(bot, 'pala.hammer_of_justice', enemy).ok) return;
    // When the team is stable, Holy Shock contributes pressure instead of the
    // healer standing idle in the centre of the arena.
    this.#action(bot, 'pala.holy_shock', enemy);
  }

  #warrior(bot, target) {
    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const range = distance(bot, target);
    this.#input(bot, range > 3.1 ? dx : 0, range > 3.1 ? dz : 0);
    if (bot.hp / bot.maxHp < .38 && this.#action(bot, 'warrior.shield_wall', bot).ok) return;
    if (target.cast && range <= 3.5 && this.#action(bot, 'warrior.pummel', target).ok) return;
    if (range > 3.4 && range <= 17 && this.#action(bot, 'warrior.charge', target).ok) return;
    if (range <= 3.4 && this.#action(bot, 'warrior.rend', target).ok) return;
    this.#action(bot, 'warrior.mortal_swing', target);
  }

  #decide(botId) {
    const bot = this.simulation.state.units.get(botId);
    if (!bot?.alive) return;
    const allies = [...this.simulation.state.units.values()].filter(unit => unit.alive && unit.team === bot.team);
    const enemies = [...this.simulation.state.units.values()].filter(unit => unit.alive && unit.team !== bot.team);
    if (!enemies.length) return;
    const target = enemies.sort((a, b) => distance(bot, a) - distance(bot, b) || a.id.localeCompare(b.id))[0];

    if (bot.classId === 'pala') return this.#paladin(bot, allies, enemies);
    this.#warrior(bot, target);
  }
}
