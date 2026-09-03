/* Runs the offline AIController against the authoritative simulation.

   The client AI addresses abilities by index into AB[cls], reads effects through
   unit.has(type), and casts through game.tryAbility(unit, index, target). The
   simulation addresses abilities by catalogue id, keeps effects in a Map, and casts
   through applyAction. Rather than rewrite the AI - which would immediately drift from
   the offline opponent - this host presents the simulation in the shape the AI expects.

   Units are decorated in place rather than proxied, because the AI compares units with
   === and stores them in Sets and Maps. */
import {
  createAIControllerClass, createGameHelpers, CLIENT_BASE_ORDER, CLIENT_TALENT_ORDER
} from '../generated/ai-controller.generated.js';
import { catalogue } from '../../content/src/catalogue.js';
import { hasLineOfSight } from '../../simulation/src/geometry.js';

const BALANCE = Object.freeze({ arenaX: 32, arenaZ: 22, gcd: 1, unitRadius: .62 });

function dist(a, b) {
  return Math.hypot((a ? a.x : 0) - (b ? b.x : 0), (a ? a.z : 0) - (b ? b.z : 0));
}
function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
function isUntargetableStealth() {
  return false;
}
function windTigereyeStacks(unit) {
  return Math.max(0, Math.min(6, Number((unit && unit.tigereyeStacks) || 0)));
}
function bracketKey() { return '2v2'; }
/* Difficulty tiers copied from the client so the ported AI reads the same table. */
const DIFFICULTY = Object.freeze({
  easy: { min: .55, max: .9, interrupt: .18, kite: .20 },
  normal: { min: .3, max: .6, interrupt: .48, kite: .42 },
  hard: { min: .17, max: .38, interrupt: .74, kite: .68 }
});
const CLASS_INFO = Object.fromEntries(catalogue.classes.map(c => [c.id, { name: c.name, role: c.role, resource: c.resource }]));
/* Talent ranks live on the unit server-side rather than in a global progression. */
function unitTalentRank(unit, id) { return Number((unit && unit.talents && unit.talents[id]) || 0); }
function talentRank() { return 0; }
function classRating() { return 1600; }

/* Rebuild AB[cls] exactly as the client does, because the AI casts by index. Base
   abilities in client order, then the learned talent abilities in the client's
   TALENT_UNLOCKED_ABILITIES key order - which is neither alphabetical nor the
   catalogue's order, so it is captured by the generator rather than guessed. */
const BY_ID = new Map();
const BY_CLASS_NAME = new Map();
for (const cls of catalogue.classes) {
  for (const ability of cls.abilities) {
    BY_ID.set(ability.id, ability);
    BY_CLASS_NAME.set(cls.id + '|' + ability.name, ability);
  }
}

function toClientAbility(ability) {
  return {
    id: ability.id,
    name: ability.name,
    type: ability.type,
    school: ability.school,
    range: ability.range,
    cast: ability.castTime || 0,
    cd: ability.cooldown || 0,
    cost: ability.cost || 0,
    value: ability.baseValue || 0,
    talentAbility: ability.source === 'talent'
  };
}

export function abilityListFor(classId, talents) {
  const learned = talents || {};
  const list = [];
  for (const name of CLIENT_BASE_ORDER[classId] || []) {
    const ability = BY_CLASS_NAME.get(classId + '|' + name);
    if (ability) list.push(toClientAbility(ability));
  }
  for (const talentId of [...(CLIENT_TALENT_ORDER[classId] || []),...(classId==='wind'?['wind_reverse_harm']:[])]) {
    if (!(Number(learned[talentId]) > 0)) continue;
    const ability = BY_ID.get(talentId);
    if (!ability) continue;
    const tuned = toClientAbility(ability);
    if (classId === 'soul' && talentId === 'soul_void_mend') {
      /* The client swaps Chaos Bolt in over Unstable Affliction rather than appending
         it, so indices after that point must not shift. */
      const replaced = list.findIndex(a => a.name === 'Unstable Affliction');
      if (replaced >= 0) list.splice(replaced, 1, tuned);
      else list.push(tuned);
      continue;
    }
    list.push(tuned);
  }
  return list;
}

const EFFECT_ALIASES = new Map([['cloakShadows', 'cloak'], ['touchKarma', 'karma']]);

export function createAiHost(simulation, options) {
  const opts = options || {};
  const deps = {
    dist, clamp, isUntargetableStealth, windTigereyeStacks, bracketKey, classRating,
    AB: {}, BALANCE, DIFFICULTY, CLASS_INFO, talentRank, unitTalentRank
  };
  const AIController = createAIControllerClass(deps);
  const Helpers = createGameHelpers(deps);
  const state = simulation.state;
  const combat = simulation.combat;
  const abilityCache = new Map();
  const sequences = new Map();

  function abilitiesFor(unit) {
    const key = unit.classId + '|' + Object.keys(unit.talents || {}).sort().join(',');
    if (!abilityCache.has(key)) abilityCache.set(key, abilityListFor(unit.classId, unit.talents));
    const list = abilityCache.get(key);
    deps.AB[unit.classId] = list;
    return list;
  }

  function decorate(unit) {
    if (unit.__aiReady) return unit;
    Object.defineProperty(unit, 'cls', { get() { return this.classId; }, configurable: true });
    Object.defineProperty(unit, 'trinketCd', {
      get() { return this.trinketCooldown; },
      set(v) { this.trinketCooldown = v; },
      configurable: true
    });
    /* The AI treats effects as an array (filter/some/find) while the simulation keeps
       a Map. Add value-iterating helpers rather than replacing the Map. */
    const effects = unit.effects;
    const values = () => {
      const out = [];
      for (const [key, effect] of effects) {
        effect.time = effect.remaining;
        if (!effect.type) effect.type = key;
        out.push(effect);
      }
      return out;
    };
    effects.filter = fn => values().filter(fn);
    effects.some = fn => values().some(fn);
    effects.find = fn => values().find(fn);
    unit.has = function (type) {
      let effect = combat.getEffect(this, type);
      if (!effect) {
        const alias = EFFECT_ALIASES.get(type);
        effect = alias ? combat.getEffect(this, alias) : null;
      }
      if (!effect) return null;
      /* The AI reads effect.time; the simulation stores remaining. Without this every
         duration check in the AI silently compares against undefined. */
      effect.time = effect.remaining;
      if (!effect.type) effect.type = type;
      return effect;
    };
    unit.name = unit.displayName || unit.id;
    unit.ai = null;
    unit.mounted = false;
    unit.aiMountDelay = 0;
    unit.aiPoint = null;
    unit.fistsFx = null;
    unit.mesh = { rotation: { x: 0, y: 0, z: 0 } };
    unit.combatUntil = Number.POSITIVE_INFINITY;
    unit.__aiReady = true;
    return unit;
  }

  /* The AI reads unit.cds[index], iterates unit.effects as an array, and expects the
     client cast shape. Rebuild those views once per decision tick. */
  function refresh(unit) {
    const list = abilitiesFor(unit);
    const cds = new Array(list.length);
    for (let i = 0; i < list.length; i++) cds[i] = Number(unit.cooldowns.get(list[i].id) || 0);
    unit.cds = cds;
    unit.moveSpeed = unit.speed;
    const cast = unit.cast;
    if (cast && !cast.__aiReady) {
      Object.defineProperty(cast, 'a', { get() { return this.ability; }, configurable: true });
      Object.defineProperty(cast, 'left', { get() { return this.remaining; }, configurable: true });
      Object.defineProperty(cast, 'total', { get() { return this.duration; }, configurable: true });
      Object.defineProperty(cast, 'target', {
        get() { return state.units.get(this.targetId) || null; }, configurable: true
      });
      cast.uninterruptible = cast.kind === 'bladestorm' || cast.kind === 'fists';
      cast.bladestorm = cast.kind === 'bladestorm';
      cast.discPenance = cast.kind === 'discPenance';
      cast.__aiReady = true;
    }
  }

  function buildArena() {
    const pillars = state.arena.pillars.map(p => (p.r === undefined ? Object.assign(p, { r: p.radius }) : p));
    const blockingPillar = (a, b) => {
      if (!a || !b) return null;
      const vx = b.x - a.x, vz = b.z - a.z, len2 = vx * vx + vz * vz || .0001;
      for (const p of pillars) {
        const t = clamp(((p.x - a.x) * vx + (p.z - a.z) * vz) / len2, 0, 1);
        const cx = a.x + vx * t, cz = a.z + vz * t;
        if (Math.hypot(cx - p.x, cz - p.z) < p.r + .18) return p;
      }
      return null;
    };
    return {
      get x() { return state.arena.x; },
      get z() { return state.arena.z; },
      pillars,
      colliders: [],
      blockingPillar,
      los: (a, b) => !blockingPillar(a, b),
      /* The simulation resolves bounds and pillar overlap every step; this only keeps
         the AI from walking a unit far outside the arena between ticks. */
      constrain: (pos) => {
        pos.x = clamp(pos.x, -state.arena.x, state.arena.x);
        pos.z = clamp(pos.z, -state.arena.z, state.arena.z);
      }
    };
  }

  class AiHost extends Helpers {
    constructor() {
      super();
      this.difficulty = opts.difficulty || 'normal';
      this.mode = opts.mode || '2v2';
      this.queueType = 'skirmish';
      this.phase = 'fight';
      this.paused = false;
      this.player = null;
      this.target = null;
      this.aiRegroupPlans = new Map();
      this.teamPlans = new Map();
      this.controllers = new Map();
    }
    get time() { return state.time; }
    get dampening() { return state.dampening; }
    get units() { return [...state.units.values()]; }
    get arena() { return this.__arena || (this.__arena = buildArena()); }
    /* Casting is bridged to the authoritative simulation rather than the client
       pipeline, so the server stays the only thing deciding what happens. */
    tryAbility(caster, index, target) {
      if (!caster || !caster.alive) return false;
      const ability = abilitiesFor(caster)[index];
      if (!ability) return false;
      const sequence = (sequences.get(caster.id) || 0) + 1;
      sequences.set(caster.id, sequence);
      const result = simulation.applyAction(caster.id, {
        sequence,
        abilityId: ability.id,
        targetId: target && target.id ? target.id : null
      });
      if (result && result.ok) refresh(caster);
      return !!(result && result.ok);
    }
    useTrinket(unit) {
      const r = simulation.useTrinket(unit.id);
      return !!(r && r.ok);
    }
    ratingProfile() {
      return opts.profile || { min: .42, max: .70, interrupt: .28, kite: .34, fakeDelay: .42 };
    }
    tryMount() { return false; }
    float() {}
    log() {}
    message() {}
    animateAction() {}
    vfxBurst() {}
    vfxRing() {}
    vfxGlyph() {}
    vfxNova() {}
    vfxTrail() {}
    controllerFor(unit) {
      decorate(unit);
      if (!this.controllers.has(unit.id)) this.controllers.set(unit.id, new AIController(this, unit));
      return this.controllers.get(unit.id);
    }
    /* The AI inspects allies and enemies as well as itself, so every unit in the
       simulation has to carry the client-shaped view before any controller runs. */
    syncAll() {
      for (const unit of state.units.values()) {
        decorate(unit);
        refresh(unit);
      }
    }
    step(unit, dt) {
      this.syncAll();
      abilitiesFor(unit);
      if(unit.classId==='wind'&&unit.talents.wind_reverse_harm&&unit.hp/unit.maxHp<.88&&!unit.cast){const i=abilitiesFor(unit).findIndex(a=>a.type==='reverseHarm');if(i>=0&&this.tryAbility(unit,i,unit))return;}
      this.controllerFor(unit).update(dt);
    }
  }
  return new AiHost();
}
