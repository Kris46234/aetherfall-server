import { abilityById as defaultAbilityById } from '../../content/src/catalogue.js';
import { createCombatResolver } from './combat.js';
import { createRandom } from './random.js';
import {
  distance,
  hasLineOfSight,
  resolveArenaBounds,
  resolvePillarCollisions,
  resolveUnitCollisions
} from './geometry.js';

export const FIXED_DT = 1 / 30;
const round = value => Number(value.toFixed(4));

function resourceDefaults(entry) {
  const kind = entry.resourceType || (entry.classId === 'wind' || entry.classId === 'shadow' || entry.classId === 'warrior' ? 'energy' : 'mana');
  return {
    resourceType: kind,
    maxResource: Number(entry.maxResource) || 100,
    resourceRegen: Number.isFinite(entry.resourceRegen) ? entry.resourceRegen : kind === 'energy' ? 16 : 1
  };
}

/**
 * Deterministic authoritative simulation foundation. Combat effects are not
 * resolved here yet; validated actions produce completion events that the next
 * migration layer will consume.
 */
export function createSimulation({
  seed = 1,
  roster = [],
  arena = { x: 24, z: 16, pillars: [] },
  abilities = defaultAbilityById,
  fixedDt = FIXED_DT
} = {}) {
  if (!Number.isFinite(fixedDt) || fixedDt <= 0 || fixedDt > .1) throw new RangeError('Fixed dt is invalid');
  const random = createRandom(seed);
  const state = {
    seed,
    time: 0,
    tick: 0,
    eventSequence: 0,
    dampening: 0,
    accumulator: 0,
    arena: {
      theme: String(arena.theme || 'runestone'),
      x: Number(arena.x) || 24,
      z: Number(arena.z) || 16,
      pillars: (arena.pillars || []).map((pillar, index) => ({
        id: pillar.id || `pillar-${index + 1}`,
        x: Number(pillar.x) || 0,
        z: Number(pillar.z) || 0,
        radius: Math.max(.1, Number(pillar.radius) || 1)
      }))
    },
    units: new Map(),
    events: []
  };

  for (const entry of roster) {
    if (state.units.has(entry.id)) throw new Error(`Duplicate unit ${entry.id}`);
    const resources = resourceDefaults(entry);
    const maxHp = Number(entry.maxHp) || Number(entry.hp) || 1000;
    state.units.set(entry.id, {
      id: entry.id,
      team: entry.team,
      classId: entry.classId,
      x: Number(entry.x) || 0,
      z: Number(entry.z) || 0,
      radius: Math.max(.1, Number(entry.radius) || .62),
      speed: Number(entry.speed) || 5.15,
      hp: Number(entry.hp) || maxHp,
      maxHp,
      resourceType: resources.resourceType,
      resource: Number.isFinite(entry.resource) ? entry.resource : resources.maxResource,
      maxResource: resources.maxResource,
      resourceRegen: resources.resourceRegen,
      alive: entry.alive !== false,
      shield: Math.max(0, Number(entry.shield) || 0),
      effects: new Map(),
      dr: {
        stun: { level: 0, until: 0 },
        fear: { level: 0, until: 0 },
        incap: { level: 0, until: 0 },
        root: { level: 0, until: 0 }
      },
      talents: { ...(entry.talents || {}) },
      tigereyeStacks: Math.max(0, Math.min(6, Number(entry.tigereyeStacks) || 0)),
      tigereyePalmCounter: 0,
      stats: {
        damage: 0,
        healing: 0,
        absorb: 0,
        interrupts: 0,
        killingBlows: 0,
        damageByAbility: {},
        healingByAbility: {}
      },
      input: { sequence: 0, x: 0, z: 0 },
      lastActionSequence: -1,
      gcd: 0,
      cast: null,
      cooldowns: new Map(),
      trinketCooldown: 0,
      spawnRoll: random()
    });
  }

  function emit(event) {
    state.eventSequence += 1;
    state.events.push({ id: state.eventSequence, tick: state.tick, time: round(state.time), ...event });
  }

  const combat = createCombatResolver({ state, emit, fixedDt, random });

  function applyInput(unitId, input) {
    const unit = state.units.get(unitId);
    if (!unit || !unit.alive || !Number.isInteger(input.sequence) || input.sequence <= unit.input.sequence) return false;
    const x = Number(input.x);
    const z = Number(input.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const length = Math.hypot(x, z);
    unit.input = {
      sequence: input.sequence,
      x: length > 1 ? x / length : x,
      z: length > 1 ? z / length : z
    };
    return true;
  }

  function setCooldown(unitId, abilityId, seconds) {
    const unit = state.units.get(unitId);
    if (!unit) return false;
    unit.cooldowns.set(abilityId, Math.max(0, Number(seconds) || 0));
    return true;
  }

  function useTrinket(unitId) {
    const unit = state.units.get(unitId);
    if (!unit?.alive || unit.trinketCooldown > 0) return { ok: false, reason: 'trinket_cooldown' };
    const removable = ['stun', 'fear', 'poly', 'sleep', 'blind', 'windIncap', 'root', 'slow', 'silence'];
    let removed = 0;
    for (const type of [...unit.effects.keys()]) {
      if (removable.includes(type) || type.startsWith('lock_')) {
        combat.removeEffect(unit, type, 'trinket');
        removed += 1;
      }
    }
    unit.trinketCooldown = 60;
    if (removed) unit.cast = null;
    emit({ type: 'trinket', unitId, removed });
    return { ok: true, reason: null, removed };
  }

  function rejectAction(unit, action, reason) {
    emit({ type: 'actionRejected', unitId: unit?.id || null, sequence: action?.sequence ?? null, reason });
    return { ok: false, reason };
  }

  function applyAction(unitId, action) {
    const unit = state.units.get(unitId);
    if (!unit || !unit.alive) return rejectAction(unit, action, 'unit_unavailable');
    if (!Number.isInteger(action.sequence) || action.sequence <= unit.lastActionSequence) {
      return rejectAction(unit, action, 'stale_sequence');
    }
    unit.lastActionSequence = action.sequence;
    const sourceAbility = abilities.get(action.abilityId);
    if (!sourceAbility || sourceAbility.classId !== unit.classId) return rejectAction(unit, action, 'unknown_ability');
    const ability = combat.prepareAbility(unit, sourceAbility);
    if (!combat.supports(ability)) return rejectAction(unit, action, 'ability_not_migrated');
    const iceBlocked = combat.getEffect(unit, 'iceBlock');
    if (iceBlocked && ability.type === 'iceBlock') {
      combat.removeEffect(unit, 'iceBlock', 'manual');
      emit({ type: 'castCancelled', unitId, abilityId: ability.id, reason: 'manual' });
      return { ok: true, reason: null };
    }
    if (iceBlocked) return rejectAction(unit, action, 'ice_blocked');
    if (combat.isControlled(unit) && !combat.getEffect(unit, 'bladestorm') && ability.type !== 'iceBlock') return rejectAction(unit, action, 'crowd_controlled');
    if (combat.getEffect(unit, 'silence') && ability.school !== 'physical') return rejectAction(unit, action, 'silenced');
    if (combat.getEffect(unit, `lock_${ability.school}`)) return rejectAction(unit, action, 'school_locked');
    if (unit.cast?.abilityId === ability.id && unit.cast.channel) {
      unit.cast = null;
      if (ability.type === 'bladestorm') combat.removeEffect(unit, 'bladestorm', 'manual');
      emit({ type: 'castCancelled', unitId, abilityId: ability.id, reason: 'manual' });
      return { ok: true, reason: null };
    }
    if (unit.cast && !combat.canUseWhileCasting(unit, ability)) return rejectAction(unit, action, 'already_casting');
    if (!ability.offGlobal && unit.gcd > 0) return rejectAction(unit, action, 'gcd');
    if (!ability.ignoreCooldown && (unit.cooldowns.get(ability.id) || 0) > 0) return rejectAction(unit, action, 'cooldown');
    if (unit.resource < ability.cost) return rejectAction(unit, action, 'resource');

    let target = combat.isSelfTarget(ability) ? unit : null;
    if (!target && action.targetId) {
      target = state.units.get(action.targetId);
      if (!target || !target.alive) return rejectAction(unit, action, 'target_unavailable');
      if (ability.range > 0 && distance(unit, target) > ability.range + unit.radius + target.radius) {
        return rejectAction(unit, action, 'range');
      }
      if (ability.range > 0 && !hasLineOfSight(unit, target, state.arena.pillars, .05)) {
        return rejectAction(unit, action, 'line_of_sight');
      }
    }
    if (!target) return rejectAction(unit, action, 'target_unavailable');
    if (combat.requiresFriendlyTarget(ability) && target.team !== unit.team) {
      return rejectAction(unit, action, 'friendly_target_required');
    }
    if (ability.type === 'sacrifice' && target === unit) return rejectAction(unit, action, 'ally_target_required');
    if (combat.requiresEnemyTarget(ability) && target.team === unit.team) {
      return rejectAction(unit, action, 'enemy_target_required');
    }

    unit.resource -= ability.cost;
    combat.commitAbility(unit, ability);
    if (ability.type === 'iceBlock' && unit.cast) {
      emit({ type: 'castCancelled', unitId, abilityId: unit.cast.abilityId, reason: 'ice_block' });
      unit.cast = null;
    }
    if (ability.cooldown > 0 && !ability.commitCooldownOnComplete) unit.cooldowns.set(ability.id, ability.cooldown);
    if (!ability.offGlobal) unit.gcd = ability.gcd || 1;
    const castTime = Math.max(0, ability.castTime || 0);
    if (['fistsChannel', 'bladestorm', 'soulDrain', 'discPenance'].includes(ability.type)) {
      const bladestorm = ability.type === 'bladestorm';
      const soulDrain = ability.type === 'soulDrain';
      const discPenance = ability.type === 'discPenance';
      const duration = soulDrain ? 2.5 : discPenance ? castTime || 1.5 : bladestorm ? 4 : castTime || 2.5;
      unit.cast = {
        kind: bladestorm ? 'bladestorm' : soulDrain ? 'soulDrain' : discPenance ? 'discPenance' : 'fists',
        abilityId: ability.id,
        ability,
        targetId: soulDrain || discPenance ? target.id : unit.id,
        sequence: action.sequence,
        remaining: duration,
        duration,
        school: ability.school,
        channel: true,
        uninterruptible: bladestorm || ability.type === 'fistsChannel',
        moveSpeedMultiplier: discPenance ? 1 : bladestorm ? .78 : soulDrain ? 0 : .30,
        tickInterval: discPenance ? (ability.radiant ? .35 : .5) : soulDrain ? .5 : bladestorm ? .55 : .4,
        tickRemaining: .02,
        radius: ability.range || (bladestorm ? 5.2 : 5),
        baseValue: ability.baseValue,
        radiant: !!ability.radiant,
        ticks: 0
      };
      if (bladestorm) combat.addEffect(unit, 'bladestorm', 4, { immune: true });
      emit({
        type: 'castStarted', unitId, abilityId: ability.id, targetId: unit.id,
        sequence: action.sequence, channel: true, duration: round(duration),
        school: ability.school, uninterruptible: !!unit.cast.uninterruptible
      });
    } else if (castTime > 0) {
      unit.cast = {
        abilityId: ability.id,
        ability,
        targetId: target?.id || null,
        sequence: action.sequence,
        remaining: castTime,
        duration: castTime,
        school: ability.school,
        channel: false,
        uninterruptible: false
      };
      emit({
        type: 'castStarted', unitId, abilityId: ability.id, targetId: target?.id || null,
        sequence: action.sequence, channel: false, duration: round(castTime),
        school: ability.school, uninterruptible: false
      });
    } else {
      emit({ type: 'actionComplete', unitId, abilityId: ability.id, targetId: target?.id || null, sequence: action.sequence });
      combat.resolveAbility(unit, ability, target);
    }
    return { ok: true, reason: null };
  }

  function decrementTimer(value) {
    const next = value - fixedDt;
    return next <= 1e-9 ? 0 : next;
  }

  function fixedStep() {
    state.time += fixedDt;
    state.tick += 1;
    state.dampening = state.time < 30
      ? 0
      : Math.min(.99, (Math.floor((state.time - 30) / 10) + 1) * .05);
    for (const unit of state.units.values()) {
      if (!unit.alive) continue;
      const moveLength = Math.hypot(unit.input.x, unit.input.z);
      if (unit.cast && !unit.cast.channel && moveLength > 0) {
        emit({ type: 'castCancelled', unitId: unit.id, abilityId: unit.cast.abilityId, reason: 'movement' });
        unit.cast = null;
      }
      const moveMultiplier = combat.movementMultiplier(unit);
      unit.x += unit.input.x * unit.speed * moveMultiplier * fixedDt;
      unit.z += unit.input.z * unit.speed * moveMultiplier * fixedDt;
      resolvePillarCollisions(unit, state.arena.pillars, unit.radius);
      resolveArenaBounds(unit, state.arena, unit.radius);
      unit.gcd = decrementTimer(unit.gcd);
      unit.trinketCooldown = decrementTimer(unit.trinketCooldown);
      unit.resource = Math.min(unit.maxResource, unit.resource + unit.resourceRegen * fixedDt);
      for (const [abilityId, remaining] of unit.cooldowns) {
        const next = decrementTimer(remaining);
        if (next === 0) unit.cooldowns.delete(abilityId);
        else unit.cooldowns.set(abilityId, next);
      }
      if (unit.cast) {
        if (unit.cast.channel) {
          unit.cast.tickRemaining -= fixedDt;
          while (unit.cast.tickRemaining <= 0 && unit.cast.remaining > 0) {
            combat.channelTick(unit, unit.cast);
            unit.cast.tickRemaining += unit.cast.tickInterval;
          }
        }
        unit.cast.remaining = decrementTimer(unit.cast.remaining);
        if (unit.cast.remaining === 0) {
          const completed = unit.cast;
          unit.cast = null;
          if (!completed.channel) {
            const target = state.units.get(completed.targetId);
            if (target?.alive && distance(unit, target) <= completed.ability.range + unit.radius + target.radius && hasLineOfSight(unit, target, state.arena.pillars, .05)) {
              emit({
                type: 'actionComplete', unitId: unit.id, abilityId: completed.abilityId,
                targetId: completed.targetId, sequence: completed.sequence
              });
              combat.resolveAbility(unit, completed.ability, target);
              if (completed.ability.commitCooldownOnComplete && completed.ability.cooldown > 0) {
                unit.cooldowns.set(completed.ability.id, completed.ability.cooldown);
              }
            } else {
              emit({ type: 'actionFailed', unitId: unit.id, abilityId: completed.abilityId, sequence: completed.sequence, reason: 'completion_validation' });
            }
          } else emit({
            type: 'actionComplete', unitId: unit.id, abilityId: completed.abilityId,
            targetId: completed.targetId, sequence: completed.sequence
          });
        }
      }
      combat.tickEffects(unit);
    }
    resolveUnitCollisions(state.units.values());
    for (const unit of state.units.values()) {
      resolvePillarCollisions(unit, state.arena.pillars, unit.radius);
      resolveArenaBounds(unit, state.arena, unit.radius);
    }
  }

  function step(elapsed) {
    if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > .25) throw new RangeError('Simulation elapsed time is invalid');
    state.accumulator += elapsed;
    let count = 0;
    while (state.accumulator + 1e-10 >= fixedDt) {
      fixedStep();
      state.accumulator -= fixedDt;
      count += 1;
    }
    return count;
  }

  function drainEvents() {
    return state.events.splice(0);
  }

  function snapshot() {
    return {
      seed: state.seed,
      time: round(state.time),
      tick: state.tick,
      dampening: round(state.dampening),
      arena: {
        theme: state.arena.theme,
        x: state.arena.x,
        z: state.arena.z,
        pillars: state.arena.pillars.map(pillar => ({ ...pillar }))
      },
      units: [...state.units.values()].map(unit => ({
        id: unit.id,
        team: unit.team,
        classId: unit.classId,
        x: round(unit.x),
        z: round(unit.z),
        radius: unit.radius,
        hp: unit.hp,
        maxHp: unit.maxHp,
        shield: round(unit.shield),
        resourceType: unit.resourceType,
        resource: round(unit.resource),
        maxResource: unit.maxResource,
        alive: unit.alive,
        inputSequence: unit.input.sequence,
        actionSequence: unit.lastActionSequence,
        gcd: round(unit.gcd),
        trinketCooldown: round(unit.trinketCooldown),
        cast: unit.cast ? {
          abilityId: unit.cast.abilityId,
          targetId: unit.cast.targetId,
          sequence: unit.cast.sequence,
          remaining: round(unit.cast.remaining),
          duration: unit.cast.duration,
          channel: !!unit.cast.channel,
          uninterruptible: !!unit.cast.uninterruptible,
          ticks: unit.cast.ticks || 0
        } : null,
        effects: combat.effectSnapshot(unit),
        tigereyeStacks: unit.tigereyeStacks,
        stats: structuredClone(unit.stats),
        cooldowns: Object.fromEntries([...unit.cooldowns].map(([id, value]) => [id, round(value)]))
      }))
    };
  }

  return {
    state,
    applyInput,
    applyAction,
    setCooldown,
    useTrinket,
    step,
    snapshot,
    drainEvents,
    combat,
    hasLineOfSight: (fromId, toId) => {
      const from = state.units.get(fromId);
      const to = state.units.get(toId);
      return !!from && !!to && hasLineOfSight(from, to, state.arena.pillars, .05);
    }
  };
}
