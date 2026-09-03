import { distance, hasLineOfSight, resolveArenaBounds, resolvePillarCollisions } from './geometry.js';

const HARD_CONTROL = new Set(['stun', 'fear', 'poly', 'sleep', 'blind', 'windIncap', 'gouge']);
const BREAKABLE_CONTROL = ['poly', 'sleep', 'blind', 'fear', 'windIncap', 'gouge'];
const SELF_TYPES = new Set([
  'monkDefensive', 'fistsChannel', 'whirlingDragonPunch', 'tigereyeBrew', 'karma', 'tigersLust',
  'healingStreamTotem', 'crimsonVial', 'sharpenBlade', 'reverseHarm',
  'paladinGuard', 'paladinSteed', 'warriorGuard', 'shieldSelf', 'buff',
  'reflect', 'shout', 'avatar', 'bladestorm', 'flameNova', 'dash', 'iceBlock',
  'combustion', 'flameShield', 'defensive', 'evasion', 'cloak', 'push',
  'shieldSelf', 'totemMastery', 'stormkeeper', 'healerEscape', 'natureSwiftness',
  'ghanir', 'undyingResolve', 'ultimateRadiance', 'discFear', 'discFade',
  'archangel', 'darkArchangel', 'angelicBody', 'avengingWings'
  , 'alterTime'
]);
const FRIENDLY_TYPES = new Set([
  'heal', 'holyLight', 'sacrifice', 'bestowFaith', 'shield', 'cleanse', 'hot',
  'spiritBlossom', 'bigHeal', 'ironbark', 'discShield', 'discMend', 'painSuppression',
  'freedom', 'guardianAngel', 'intercept'
]);
const SUPPORTED_TYPES = new Set([
  'damage', 'meteor', 'leap', 'fistsChannel', 'whirlingDragonPunch', 'windInterrupt', 'windStun', 'touchOfDeath', 'stormbolt',
  'monkDefensive', 'windIncap', 'windlordStrike', 'monkFinisher', 'slow',
  'tigereyeBrew', 'karma', 'tigersLust', 'heal', 'holyLight', 'holyShock',
  'mortalSwing', 'charge', 'rend', 'gushingWound', 'pummel', 'reflect',
  'shout', 'warriorGuard', 'avatar', 'buff', 'bladestorm', 'warbreaker',
  'victoryRush', 'paladinGuard', 'paladinSteed', 'paladinStun', 'sacrifice',
  'bestowFaith', 'cleanse', 'shield', 'blind', 'shieldSelf'
  , 'flameNova', 'dash', 'poly', 'interruptProc', 'iceBlock', 'combustion',
  'livingBomb', 'flameShield', 'defensive', 'dot', 'singleStun', 'shadowInterrupt',
  'cloak', 'evasion', 'vendetta', 'shiv', 'chain', 'stun', 'push', 'root',
  'interrupt', 'flameShock', 'frostShock', 'totemMastery', 'stormkeeper',
  'soulDot', 'agony', 'unstableAffliction', 'soulDrain', 'fear', 'undyingResolve',
  'hot', 'spiritBlossom', 'bigHeal', 'healerEscape', 'sleep', 'ghanir',
  'natureSwiftness', 'ironbark', 'discSmite', 'discShield', 'discPenance',
  'discMend', 'discSolace', 'painSuppression', 'ultimateRadiance', 'discFear',
  'discFade', 'archangel', 'darkArchangel', 'angelicBody', 'volcanicEruption', 'avengingWings', 'alterTime'
  , 'freedom', 'guardianAngel', 'summonInfernal', 'healingStreamTotem'
  , 'reverseHarm', 'crimsonVial', 'gouge', 'groundStun', 'chaosBolt', 'intercept', 'sharpenBlade'
]);
const round = value => Number(value.toFixed(4));

export function createCombatResolver({ state, emit, fixedDt, random }) {
  // Gameplay travel is server-owned; visual effects never decide when damage lands.
  const projectiles = [];
  function advanceCharge(unit) {
    const charge = unit.charge;
    if (!charge) return false;
    const target = state.units.get(charge.targetId);
    if (!unit.alive || !target?.alive || movementMultiplier(unit) <= 0 || !hasLineOfSight(unit, target, state.arena.pillars, .1)) { unit.charge = null; return true; }
    const dx=target.x-unit.x, dz=target.z-unit.z, length=Math.hypot(dx,dz), step=Math.min(Math.max(0,length-2.5),32*fixedDt);
    if(length>0){unit.x+=dx/length*step;unit.z+=dz/length*step;}
    charge.remaining-=fixedDt;
    if(length-step<=2.51){
      unit.charge=null;
      if(charge.ally) addEffect(target,'sacrifice',4,{sourceId:unit.id});
      else if(charge.kind==='cloudstep') damage(unit,target,charge.value,charge.label,{school:charge.school,melee:true});
      else if(damage(unit,target,charge.value,charge.label).hit){
        applyCrowdControl(target,'root',1.5,'root');addEffect(target,'slow',4,{pct:.45,sourceId:unit.id});
        const rank=talentRank(unit,'war_hold_the_line');if(rank)addEffect(unit,'holdTheLine',3,{reduction:rank*.02});
      }
    } else if(charge.remaining<=0)unit.charge=null;
    return true;
  }
  function tickProjectiles(){
    for(let i=projectiles.length-1;i>=0;i--){
      const bolt=projectiles[i],source=state.units.get(bolt.sourceId),target=state.units.get(bolt.targetId);
      bolt.life-=fixedDt;
      if(!source||!target?.alive||bolt.life<=0||!hasLineOfSight(bolt,target,state.arena.pillars,.05)){projectiles.splice(i,1);continue;}
      const dx=target.x-bolt.x,dz=target.z-bolt.z,length=Math.hypot(dx,dz),step=22*fixedDt;
      if(length<=step+.45){damage(source,target,bolt.value,'Chaos Bolt',{school:'shadow'});projectiles.splice(i,1);}
      else{bolt.x+=dx/length*step;bolt.z+=dz/length*step;}
    }
  }
  function getEffect(unit, type) {
    if (!unit?.effects) return null;
    return unit.effects.get(type) || [...unit.effects.values()].find(effect => effect.type === type) || null;
  }

  function addEffect(unit, type, duration, data = {}) {
    const effect = { type, remaining: duration, ...data };
    const key = data.effectKey || (['bleed','poison'].includes(type)&&state.units.get(data.sourceId)?.classId==='shadow'?`${type}:${data.sourceId}:${data.label||type}`:type);
    unit.effects.set(key, effect);
    emit({ type: 'effectApplied', unitId: unit.id, effect: type, effectKey: key, duration: round(duration) });
    return effect;
  }

  function removeEffect(unit, type, reason = 'removed') {
    let key = type;
    let effect = unit.effects.get(key);
    if (!effect) {
      const found = [...unit.effects.entries()].find(([, entry]) => entry.type === type);
      if (!found) return false;
      [key, effect] = found;
    }
    unit.effects.delete(key);
    if (effect.type === 'shield') unit.shield = 0;
    emit({ type: 'effectRemoved', unitId: unit.id, effect: effect.type, effectKey: key, reason });
    return true;
  }

  function isControlled(unit) {
    return [...HARD_CONTROL].some(type => getEffect(unit, type));
  }

  function movementMultiplier(unit) {
    // Immunity effects are movement locks too. The client may continue sending
    // held-key input while Ice Block is active, but the server must remain the
    // final authority and refuse that movement.
    if (isControlled(unit) || getEffect(unit, 'root') || getEffect(unit, 'iceBlock')) return 0;
    const slow = getEffect(unit, 'slow');
    const speed = getEffect(unit, 'freedom') || getEffect(unit, 'tigersLust') || getEffect(unit, 'divineSteed') || getEffect(unit, 'discFade') || getEffect(unit, 'angelicBody');
    const channel = unit.cast?.channel ? unit.cast.moveSpeedMultiplier || 1 : 1;
    const pounce = getEffect(unit, 'pounceSpeed');
return (1 - Math.min(.95, slow?.pct || 0)) * (speed?.speed || 1) * (pounce?.speed || 1) * channel * (unit.mounted ? 1.704 : 1);
  }

  function hasTalent(unit, id) {
    return Number(unit.talents?.[id] || 0) > 0;
  }

  function talentRank(unit, id) {
    return Math.max(0, Number(unit?.talents?.[id] || 0));
  }

  function prepareAbility(unit, source) {
    const ability = { ...source };
    if (ability.id === 'pala_judgement' || ability.type === 'bestowFaith') ability.cost = 0;
    // Reach and resource costs come from the generated, client-matched tuning.
    if (ability.type === 'iceBlock' && hasTalent(unit,'flame_glacial_recovery')) ability.cooldown = 40;
    if (ability.id === 'soul_void_mend') {
      ability.name = 'Chaos Bolt';
      ability.type = 'chaosBolt';
      ability.castTime = 1.6;
      ability.cooldown = 10;
      ability.baseValue = 510;
      ability.alwaysCritical = true;
      ability.commitCooldownOnComplete = true;
    }
    if (ability.id === 'soul.creeping_torment' && hasTalent(unit, 'soul_void_mend')) {
      ability.name = 'Immolate';
      ability.type = 'dot';
      ability.school = 'fire';
      ability.castTime = 1.35;
      ability.cooldown = 0;
      ability.baseValue = 86;
      ability.immolate = true;
    }
    if (ability.id === 'flame_phoenix_guard') {
      ability.type = 'alterTime';
      ability.cooldown = 0;
      ability.offGlobal = true;
    }
    if (['windInterrupt', 'whirlingDragonPunch', 'tigereyeBrew', 'touchOfDeath', 'pummel', 'reflect', 'warriorGuard', 'avatar', 'paladinSteed'].includes(ability.type)) ability.offGlobal = true;
    if (ability.id === 'wind.zephyr_palm' && getEffect(unit, 'risingSunReady')) {
      ability.name = 'Rising Sun Kick';
      ability.cost = 12;
      ability.baseValue = 271;
      ability.risingSunProc = true;
    }
    if (ability.id === 'wind.cloudstep_kick') {
      if (!getEffect(unit, 'cloudstepDashCd')) {
        ability.range = 17;
        ability.baseValue = Math.round(ability.baseValue * 1.20);
        ability.dashReady = true;
      }
      if (getEffect(unit, 'windlordReady')) ability.baseValue = Math.round(ability.baseValue * 1.15);
    }
    if (ability.id === 'warrior.rend' && getEffect(unit, 'gushingWoundReady')) {
      ability.name = 'Gushing Wound';
      ability.type = 'gushingWound';
      ability.cost = 15;
      ability.cooldown = 6;
      ability.baseValue = 141;
    }
    if (ability.id === 'pala.holy_light' && getEffect(unit, 'infusion')) {
      ability.castTime = .75;
      ability.cost = 0;
      ability.infused = true;
    }
    if (ability.id === 'pala.holy_light' && !ability.infused) {
      ability.castTime = Math.max(.85, ability.castTime - talentRank(unit, 'fastlight') * .08);
    }
    if (ability.id === 'pala.divine_steed') {
      ability.cooldown = Math.max(10, ability.cooldown - talentRank(unit, 'steadfast') * 2);
    }
    if (ability.id === 'warrior.shield_wall') {
      ability.cooldown = Math.max(20, ability.cooldown - talentRank(unit, 'ironwall') * 3);
    }
    if (ability.id === 'flame.cinder_bolt' && getEffect(unit, 'instantBolt')) {
      ability.castTime = 0;
      ability.offGlobal = true;
      ability.instantProc = true;
    }
    if (ability.id === 'flame.ember_lance' && getEffect(unit, 'meteorLance')) {
      ability.cooldown = .4;
      ability.offGlobal = true;
      ability.meteorProc = true;
    }
    if (getEffect(unit, 'combustion') && ability.castTime > 0) ability.castTime *= .85;
    if (ability.id === 'storm.arc_spark' && getEffect(unit, 'stormkeeper')) {
      ability.castTime = 0;
      ability.cost = 0;
      ability.cooldown = .25;
      ability.baseValue = Math.round(ability.baseValue * 1.10);
      ability.offGlobal = true;
      ability.stormkeeperSpark = true;
    }
    if (ability.type === 'volcanicEruption') ability.offGlobal = true;
    if (getEffect(unit, 'natureSwiftness') && ['sage.renewal_tide', 'sage.lullaby_bloom'].includes(ability.id)) {
      ability.castTime = 0;
      ability.ignoreCooldown = true;
      ability.natureSwift = true;
    }
    if (ability.id === 'disc.penance' && getEffect(unit, 'radiantPenanceProc')) {
      ability.radiant = true;
      ability.castTime = 1.05;
    }
    if (unit.classId === 'soul') ability.gcd = .5;
    if (['singleStun', 'shadowInterrupt', 'vendetta', 'shiv', 'interrupt', 'natureSwiftness', 'painSuppression', 'archangel', 'darkArchangel', 'angelicBody'].includes(ability.type)) ability.offGlobal = true;
    if (ability.type === 'leap' && unit.classId === 'shadow') ability.offGlobal = true;
    if (ability.id === 'shadow_garrote' || ability.id === 'storm.skybreaker_pulse' || ability.id === 'storm_lava_burst' || ability.id === 'soul.grasping_gloom') ability.offGlobal = true;
    if (['dash', 'interruptProc', 'flameNova', 'iceBlock', 'combustion', 'livingBomb'].includes(ability.type)) ability.offGlobal = true;
    if (['poly', 'sleep', 'fear', 'stormkeeper'].includes(ability.type) && ability.castTime > 0) ability.commitCooldownOnComplete = true;
    return ability;
  }

  function commitAbility(unit, ability) {
    if (ability.infused) removeEffect(unit, 'infusion', 'consumed');
    if (ability.natureSwift) removeEffect(unit, 'natureSwiftness', 'consumed');
    if (ability.radiant) removeEffect(unit, 'radiantPenanceProc', 'consumed');
  }

  function canUseWhileCasting(unit, ability) {
    return ability.type === 'interruptProc'
      || ability.type === 'interrupt'
      || ability.type === 'iceBlock'
      || ability.type === 'livingBomb'
      || ability.type === 'combustion'
      || (ability.type === 'dash' && unit.classId === 'flame');
  }

  function supports(ability) {
    return SUPPORTED_TYPES.has(ability.type);
  }

  function damageMultiplier(unit, label = '') {
    const brew = getEffect(unit, 'tigereyeBrew');
    const avatar = getEffect(unit, 'avatar');
    const defensive = getEffect(unit, 'defensive');
    let multiplier = (brew ? 1 + Number(brew.power || 0) : 1)
      * (avatar ? 1 + Number(avatar.damagePct || .16) : 1)
      * (defensive?.damagePenalty ? 1 - defensive.damagePenalty : 1);
    if (unit.classId === 'shadow' && label !== 'Night Slash') multiplier *= 1.10;
    if (getEffect(unit, 'crimsonVial')) multiplier *= .75;
    if (getEffect(unit, 'smokePower')) multiplier *= 1.10;
    if (getEffect(unit, 'darkArchangel')) multiplier *= 1.30;
    if (getEffect(unit, 'totemMastery')) {
      multiplier *= 1.05;
      if (/Flame Shock/i.test(label)) multiplier *= 1.10;
    }
    const wings = getEffect(unit, 'avengingWings');
    if (wings?.damageBonus) multiplier *= 1 + Number(wings.damageBonus);
    if (getEffect(unit, 'combustion') && random() < .80) multiplier *= 1.5;
    if (unit.classId === 'warrior' && !/Rend$|Gushing Wound/i.test(label)) {
      multiplier *= 1 + talentRank(unit, 'warlust') * .03;
    }
    if (unit.classId === 'warrior' && /Rend|Gushing Wound/i.test(label)) {
      multiplier *= 1 + talentRank(unit, 'deepwounds') * .05;
    }
    return multiplier;
  }

  function healingMultiplier(unit, target, label = '') {
    const wings = getEffect(unit, 'avengingWings');
    const brew = getEffect(unit, 'tigereyeBrew');
    const holyTraining = unit.classId === 'pala' ? 1 + talentRank(unit, 'holytraining') * .02 : 1;
    const radiance = unit.classId === 'pala' && /Holy Shock|Divine Toll/i.test(label)
      ? 1 + talentRank(unit, 'radiance') * .04 : 1;
    return (brew ? 1 + Number(brew.power || 0) : 1)
      * (unit.classId === 'pala' ? 1.16 : 1)
      * (unit.classId === 'sage' ? 1.045 : 1)
      * (wings ? 1 + Number(wings.healingBonus || .20) : 1)
      * (getEffect(unit, 'totemMastery') ? 1.05 : 1)
      * (getEffect(target, 'ironbark') ? 1.20 : 1)
      * (getEffect(unit, 'ghanir') && ['Blooming Echo', 'Rejuvenate'].includes(label) ? 1.50 : 1)
      * (getEffect(unit, 'archangel') && /Atonement/.test(label) ? 1.30 : 1)
      * holyTraining
      * radiance;
  }

  function damage(source, target, amount, label, options = {}) {
    if (!source?.alive || !target?.alive) return { hit: false, amount: 0, absorbed: 0 };
    if (getEffect(target, 'iceBlock')) return { hit: false, amount: 0, absorbed: 0, immune: true };
    const guardian = getEffect(target, 'guardianImmunity');
    if (guardian) {
      const valkyr = state.units.get(guardian.guardianId);
      if (valkyr?.alive) return { hit: false, amount: 0, absorbed: 0, immune: true };
      removeEffect(target, 'guardianImmunity', 'guardian_gone');
    }
    const sacrifice = getEffect(target, 'sacrifice');
    const protector = sacrifice ? state.units.get(sacrifice.sourceId) : null;
    if (protector?.alive && protector !== target && !options.redirected) {
      const redirected = damage(source, protector, amount, label, { ...options, redirected: true });
      emit({ type: 'damageRedirected', sourceId: source.id, protectedId: target.id, protectorId: protector.id, amount: redirected.amount });
      return { hit: redirected.hit, amount: 0, absorbed: 0, redirected: redirected.amount };
    }
    const reflection = getEffect(target, 'reflect');
    const melee = /mortal swing|charge|rend|pummel|zephyr palm|cloudstep|rising sun|fists of fury|valley sweep|disrupting palm/i.test(String(label));
    if (reflection && !options.cannotReflect && options.school !== 'physical' && !melee) {
      removeEffect(target, 'reflect', 'triggered');
      emit({ type: 'spellReflected', sourceId: target.id, targetId: source.id, ability: label });
      return damage(target, source, amount, `${label} (Reflected)`, { ...options, cannotReflect: true });
    }
    if (getEffect(target, 'cloakShadows') && options.school !== 'physical' && !options.melee) return { hit: false, amount: 0, absorbed: 0, immune: true };
    if (getEffect(target, 'evasion') && options.melee && random() < Number(getEffect(target, 'evasion').pct || .50)) return { hit: false, amount: 0, absorbed: 0, dodged: true };
    let outgoing = Number(amount) * (options.exact?1:damageMultiplier(source, label));
    const frostMark = getEffect(target, 'frostShockAmp');
    if (frostMark?.sourceId === source.id && /Arc Spark|Forked Current/i.test(String(label))) outgoing *= 1.15;
    if (source.classId === 'warrior' && /Mortal Swing/i.test(label) && target.hp / target.maxHp < .35) {
      outgoing *= 1 + talentRank(source, 'executioner') * .05;
    }
    if (!Number.isFinite(outgoing) || outgoing <= 0) return { hit: false, amount: 0, absorbed: 0 };
    source.combatUntil = Math.max(Number(source.combatUntil) || 0, state.time + 4);
    target.combatUntil = Math.max(Number(target.combatUntil) || 0, state.time + 4);
    if (source.mounted) { source.mounted = false; emit({ type: 'mount', unitId: source.id, mounted: false, reason: 'combat' }); }
    if (target.mounted) { target.mounted = false; emit({ type: 'mount', unitId: target.id, mounted: false, reason: 'combat' }); }
    for (const type of BREAKABLE_CONTROL) {if(type==='fear'&&options.periodic&&getEffect(target,'fear')?.breakFromDots===false)continue;removeEffect(target, type, 'damage');}
    const defensive = getEffect(target, 'defensive');
    if (defensive) outgoing *= 1 - Number(defensive.reduction ?? .35);
    if (getEffect(target, 'infernalExposure')) outgoing *= 1.10;
    const staticGuard = getEffect(target, 'staticAegisGuard');
    if (staticGuard) outgoing *= 1 - Number(staticGuard.reduction || .20);
    if (getEffect(target, 'holdTheLine')) outgoing *= 1 - Number(getEffect(target, 'holdTheLine').reduction || 0);
    if (target.classId === 'warrior' && target.hp / target.maxHp < .45) {
      outgoing *= 1 - talentRank(target, 'battlehardened') * .03;
    }
    const karma = getEffect(target, 'touchKarma');
    let absorbed = 0;
    if (target.shield > 0) {
      absorbed = Math.min(target.shield, outgoing);
      target.shield -= absorbed;
      outgoing -= absorbed;
      if (target.shield <= 0) removeEffect(target, 'shield', 'depleted');
    }
    const actual = Math.max(0, Math.round(outgoing));
    if (actual > 0) {
      target.hp = Math.max(0, target.hp - actual);
      source.stats.damage += actual;
      source.stats.damageByAbility[label] = (source.stats.damageByAbility[label] || 0) + actual;
      if (label !== 'Touch of Death') {
        const deathTouch = [...target.effects.values()].find(effect =>
          effect.type === 'touchOfDeath' && effect.sourceId === source.id
        );
        if (deathTouch) deathTouch.accumulated = Number(deathTouch.accumulated || 0) + actual;
      }
      emit({
        type: 'damage', sourceId: source.id, targetId: target.id,
        ability: label, amount: actual, absorbed: Math.round(absorbed),
        periodic: !!options.periodic
      });
      if (karma && !options.cannotReflect && source !== target && source.alive && label !== 'Touch of Karma') {
        damage(target, source, Math.max(1, Math.round(actual * .30)), 'Touch of Karma', { cannotReflect: true, school: 'wind' });
        heal(target, target, actual * .50, 'Touch of Karma');
      }
      if (target.hp <= 0) {
        if (target.classId === 'flame' && hasTalent(target, 'flame_cauterize') && !target.cauterizeConsumed) {
          target.cauterizeConsumed = true;
          target.hp = Math.max(1, Math.round(target.maxHp * .30));
          addEffect(target, 'cauterizeDoom', 5, { sourceId: source.id });
          emit({ type: 'presentation', cue: 'cauterize', sourceId: target.id, targetId: target.id, duration: 5 });
        } else {
          target.alive = false;
          target.cast = null;
          source.stats.killingBlows += 1;
          emit({ type: 'death', unitId: target.id, killerId: source.id });
          if (target.summonKind === 'guardianAngel' && target.protectedId) {
            const protectedUnit = state.units.get(target.protectedId);
            if (protectedUnit) removeEffect(protectedUnit, 'guardianImmunity', 'guardian_killed');
          }
        }
      }
    }
    return { hit: true, amount: actual, absorbed: Math.round(absorbed) };
  }

  function heal(source, target, amount, label) {
    if (!source?.alive || !target?.alive) return 0;
    const wound = getEffect(target, 'mortalWound');
    const woundMult = wound ? Math.max(0, 1 - Number(wound.pct || .40)) : 1;
    const requested = Number(amount) * (label==='Reverse Harm'?1:healingMultiplier(source, target, label)) * woundMult * (1 - state.dampening);
    const actual = Math.max(0, Math.min(target.maxHp - target.hp, Math.round(requested)));
    if (!actual) return 0;
    target.hp += actual;
    source.stats.healing += actual;
    source.stats.healingByAbility[label] = (source.stats.healingByAbility[label] || 0) + actual;
    emit({ type: 'healing', sourceId: source.id, targetId: target.id, ability: label, amount: actual });
    return actual;
  }

  function applyShield(source, target, amount, duration) {
    const value = Math.round(Number(amount) * (getEffect(source, 'totemMastery') ? 1.05 : 1) * (1 - state.dampening));
    target.shield = Math.max(target.shield, value);
    addEffect(target, 'shield', duration, { value });
    source.stats.absorb += value;
    return value;
  }

  function applyCrowdControl(target, type, duration, category) {
    if (getEffect(target, 'freedom') && (type === 'root' || type === 'slow')) return 0;
    if (getEffect(target, 'bladestorm') && ['stun', 'root', 'slow', 'fear', 'poly'].includes(type)) {
      emit({ type: 'crowdControlImmune', unitId: target.id, effect: type, category, reason: 'bladestorm' });
      return 0;
    }
    const dr = target.dr[category] ||= {level:0,until:0};
    if (state.time > dr.until) dr.level = 0;
    if (dr.level >= 3) {
      emit({ type: 'crowdControlImmune', unitId: target.id, effect: type, category });
      return 0;
    }
    const applied = duration * [1, .5, .25][dr.level];
    dr.level += 1;
    dr.until = state.time + 18;
    if (HARD_CONTROL.has(type)) target.cast = null;
    addEffect(target, type, applied, { category });
    return applied;
  }

  function addFlow(source, target = null) {
    const flow = getEffect(source, 'flow');
    const stacks = Math.min(3, Number(flow?.stacks || 0) + 1);
    if (stacks < 3) {
      addEffect(source, 'flow', 10, { stacks });
      return stacks;
    }
    removeEffect(source, 'flow', 'converted');
    addEffect(source, 'tempestFlow', 10);
    if (target?.alive && !getEffect(target, 'windboundSnareIcd')) {
      addEffect(target, 'slow', 3, { pct: .50, sourceId: source.id });
      addEffect(target, 'windboundSnareIcd', 12, { sourceId: source.id });
    }
    return 3;
  }

  function applyAtonement(source, target, duration = 14) {
    addEffect(target, 'atonement', duration, { sourceId: source.id });
  }

  function healAtonements(source, amount, label) {
    let total = 0;
    for (const ally of state.units.values()) {
      if (!ally.alive || ally.team !== source.team || getEffect(ally, 'atonement')?.sourceId !== source.id) continue;
      total += heal(source, ally, amount * 1.25, label);
    }
    return total;
  }

  function landInfernal(source, x, z, baseValue = 90) {
    if (!source?.alive) return null;
    for (const existing of state.units.values()) {
      if (existing.summonKind === 'infernal' && existing.ownerId === source.id && existing.alive) {
        existing.alive = false;
        existing.hp = 0;
        emit({ type: 'death', unitId: existing.id, killerId: null, expired: true });
      }
    }
    const infernalId = `infernal-${source.id}-${state.tick}`;
    const maxHp = Math.max(1, Math.round(source.maxHp * .25));
    const infernal = {
      id: infernalId, team: source.team, classId: 'soul', displayName: 'Infernal', itemLevel: 990,
      summonKind: 'infernal', ownerId: source.id, x, z,
      radius: .82, speed: 3.6, hp: maxHp, maxHp,
      resourceType: 'mana', resource: 0, maxResource: 0, resourceRegen: 0, alive: true, shield: 0,
      effects: new Map(), dr: {
        stun: { level: 0, until: 0 }, fear: { level: 0, until: 0 },
        incap: { level: 0, until: 0 }, root: { level: 0, until: 0 }
      }, talents: {}, tigereyeStacks: 0, tigereyePalmCounter: 0,
      stats: { damage: 0, healing: 0, absorb: 0, interrupts: 0, killingBlows: 0, damageByAbility: {}, healingByAbility: {} },
      input: { sequence: 0, x: 0, z: 0 }, lastActionSequence: -1, gcd: 0, cast: null,
      cooldowns: new Map(), trinketCooldown: 0, spawnRoll: random()
    };
    state.units.set(infernalId, infernal);
    addEffect(infernal, 'infernalLifetime', 10, { sourceId: source.id, manaRemaining: 1, pulseRemaining: 2 });
    emit({ type: 'presentation', cue: 'infernalLanding', sourceId: source.id, targetId: infernalId, x: round(x), z: round(z), duration: 10 });
    for (const enemy of state.units.values()) {
      if (!enemy.alive || enemy.team === source.team || enemy.summonKind || Math.hypot(enemy.x - x, enemy.z - z) > 5) continue;
      if (!hasLineOfSight(infernal, enemy, state.arena.pillars, .05)) continue;
      damage(source, enemy, baseValue, 'Infernal Landing', { school: 'shadow' });
      applyCrowdControl(enemy, 'stun', 2, 'stun');
      addEffect(enemy, 'infernalExposure', 10, { sourceId: source.id });
    }
    return infernal;
  }

  function resolveAbility(source, ability, target) {
    const label = ability.name;
    switch (ability.type) {
      case 'damage': {
        let amount = ability.baseValue;
        if (ability.alwaysCritical) amount *= 1.5;
        if (ability.name === 'Pandemic Bloom' && getEffect(source, 'pandemicSurge')) {
          amount *= 1.20;
          removeEffect(source, 'pandemicSurge', 'consumed');
        }
        if (ability.id === 'flame.cinder_bolt' && ability.instantProc) amount *= 1.20;
        if (ability.id === 'flame.ember_lance') {
          if (getEffect(target, 'burn')) amount *= 1.30;
          if (ability.meteorProc) amount *= 1.15;
        }
        if (ability.id === 'shadow.night_slash' && getEffect(source, 'eviscerateReady')) {
          amount *= 1.45;
          removeEffect(source, 'eviscerateReady', 'consumed');
        }
        const result = damage(source, target, amount, label, { school: ability.school });
        if (ability.id === 'flame.cinder_bolt' && result.hit) {
          source.resource = Math.min(source.maxResource, source.resource + 4);
          if (ability.instantProc) {
            const proc = getEffect(source, 'instantBolt');
            proc.stacks = Number(proc.stacks || 1) - 1;
            if (proc.stacks <= 0) removeEffect(source, 'instantBolt', 'consumed');
          }
        }
        if (ability.id === 'flame.ember_lance' && result.hit) {
          source.resource = Math.min(source.maxResource, source.resource + 6);
          if (ability.meteorProc) removeEffect(source, 'meteorLance', 'consumed');
        }
        if (ability.id === 'shadow.night_slash' && result.hit) {
          const marks = Math.min(3, Number(getEffect(source, 'shadowMarks')?.stacks || 0) + 1);
          if (marks >= 3) {
            removeEffect(source, 'shadowMarks', 'converted');
            addEffect(source, 'venomEdge', 12);
          } else addEffect(source, 'shadowMarks', 12, { stacks: marks });
          if (getEffect(source, 'cheapReady')) {
            removeEffect(source, 'cheapReady', 'consumed');
            applyCrowdControl(target, 'stun', 3, 'stun');
          }
        }
        if (ability.id === 'storm.arc_spark' && result.hit) {
          source.resource = Math.min(source.maxResource, source.resource + 4);
          if (ability.stormkeeperSpark) {
            const keeper = getEffect(source, 'stormkeeper');
            keeper.stacks -= 1;
            if (keeper.stacks <= 0) removeEffect(source, 'stormkeeper', 'consumed');
          }
        }
        if (ability.id === 'wind.zephyr_palm' && result.hit) {
          addFlow(source, target);
          if (hasTalent(source, 'wind_tigereye_brew')) {
            source.tigereyePalmCounter += 1;
            if (source.tigereyePalmCounter >= 2) {
              source.tigereyePalmCounter = 0;
              source.tigereyeStacks = Math.min(6, source.tigereyeStacks + 2);
              emit({ type: 'resourceStack', unitId: source.id, resource: 'tigereye', stacks: source.tigereyeStacks });
            }
          }
          if (ability.risingSunProc) removeEffect(source, 'risingSunReady', 'consumed');
        }
        if ((ability.name === 'Judgement' || ability.name === 'Judgment') && result.hit) {
          source.resource = Math.min(source.maxResource, source.resource + 8);
          for (const ally of state.units.values()) {
            if (ally.alive && ally.team === source.team && distance(source, ally) <= 10) heal(source, ally, 101, 'Judgement');
          }
        }
        return result.hit;
      }
      case 'meteor':
        emit({
          type: 'presentation', cue: 'meteorfall', sourceId: source.id,
          targetId: target.id, x: round(target.x), z: round(target.z), duration: .98, radius: 5.2
        });
        addEffect(source, 'meteorPending', .98, { x: target.x, z: target.z });
        return true;
      case 'leap': {
        if (ability.id === 'wind.cloudstep_kick' && ability.dashReady) {
          source.charge={kind:'cloudstep',targetId:target.id,value:ability.baseValue,label,school:ability.school,remaining:1.5};
          addEffect(source,'cloudstepDashCd',20);
          emit({type:'presentation',cue:'cloudstepDashStart',sourceId:source.id,targetId:target.id,duration:Math.max(.18,(distance(source,target)-2.5)/32)});
          return true;
        }
        if (ability.id === 'shadow.umbral_pounce') {
          const dx = source.x - target.x;
          const dz = source.z - target.z;
          const length = Math.hypot(dx, dz) || 1;
          source.x = target.x + dx / length * 2.5;
          source.z = target.z + dz / length * 2.5;
          resolvePillarCollisions(source, state.arena.pillars, source.radius);
          resolveArenaBounds(source, state.arena, source.radius);
        }
        const hit = damage(source, target, ability.baseValue, label, { school: ability.school, melee: true }).hit;
        if (hit && ability.id === 'shadow.umbral_pounce') {
          addEffect(source, 'evasion', 1.5, { pct: .50 });
          addEffect(source, 'pounceSpeed', 1.5, { speed: 1.30 });
        }
        return hit;
      }
      case 'windInterrupt': {
        const hit = damage(source, target, ability.baseValue, label).hit;
        if (hit && target.cast && !target.cast.uninterruptible) {
          const school = target.cast.school;
          target.cast = null;
          addEffect(target, `lock_${school}`, 3);
          source.stats.interrupts += 1;
          addFlow(source);
          emit({ type: 'interrupt', sourceId: source.id, targetId: target.id, school, duration: 3 });
        }
        return hit;
      }
      case 'windStun': {
        for (const unit of state.units.values()) {
          if (unit.team === source.team || !unit.alive || distance(source, unit) > 5.4) continue;
          if (!hasLineOfSight(source, unit, state.arena.pillars, .05)) continue;
          if (damage(source, unit, ability.baseValue, label).hit) applyCrowdControl(unit, 'stun', 5, 'stun');
        }
        return true;
      }
      case 'whirlingDragonPunch': {
        let hits = 0;
        for (const unit of state.units.values()) {
          if (unit.team === source.team || !unit.alive || distance(source, unit) > 5.5) continue;
          if (!hasLineOfSight(source, unit, state.arena.pillars, .05)) continue;
          if (damage(source, unit, ability.baseValue, label, { school: 'wind', melee: true }).hit) hits += 1;
        }
        emit({ type: 'presentation', cue: 'whirlingDragonPunch', sourceId: source.id, hits });
        return hits > 0;
      }
      case 'monkDefensive':
        addEffect(source, 'defensive', 6, { reduction: .50 });
        heal(source, source, 135, 'Willow Guard');
        return true;
      case 'windIncap':
        return applyCrowdControl(target, 'windIncap', ability.baseValue || 3, 'incap') > 0;
      case 'windlordStrike': {
        const hit = damage(source, target, ability.baseValue, label).hit;
        if (hit) {
          source.cooldowns.delete('wind.cloudstep_kick');
          addEffect(source, 'windlordReady', 8);
          removeEffect(source, 'risingSunReady', 'replaced');
          addEffect(source, 'risingSunReady', 10);
        }
        return hit;
      }
      case 'monkFinisher': {
        const empowered = !!getEffect(source, 'tempestFlow');
        if (empowered) removeEffect(source, 'tempestFlow', 'consumed');
        const hit = damage(source, target, ability.baseValue * (empowered ? 2.55 : 1), label).hit;
        if (hit && empowered) addEffect(target, 'slow', 3, { pct: .35, sourceId: source.id });
        return hit;
      }
      case 'touchOfDeath':
        addEffect(target, 'touchOfDeath', 5, {
          sourceId: source.id,
          accumulated: 0
        });
        emit({ type: 'presentation', cue: 'touchOfDeathApplied', sourceId: source.id, targetId: target.id });
        return true;
      case 'stormbolt': {
        const applied = applyCrowdControl(target, 'stun', ability.baseValue || 3, 'stun');
        emit({ type: 'presentation', cue: 'stormbolt', sourceId: source.id, targetId: target.id });
        return applied > 0;
      }
      case 'slow': {
        const hit = damage(source, target, ability.baseValue, label).hit;
        if (hit) applyCrowdControl(target, 'slow', 4, 'root') && Object.assign(getEffect(target, 'slow'), { pct: .60 });
        return hit;
      }
      case 'tigereyeBrew': {
        const stacks = Math.max(0, Math.min(6, source.tigereyeStacks));
        if (!stacks) {
          source.cooldowns.delete(ability.id);
          emit({ type: 'actionNoEffect', unitId: source.id, abilityId: ability.id, reason: 'no_stacks' });
          return false;
        }
        const power = Number((Math.floor(stacks / 2) * .10).toFixed(2));
        source.tigereyeStacks = 0;
        addEffect(source, 'tigereyeBrew', 6, { power, stacks });
        return true;
      }
      case 'tigersLust':
        removeEffect(source, 'slow', 'cleansed');
        removeEffect(source, 'root', 'cleansed');
        addEffect(source, 'tigersLust', 4, { speed: 1.6 });
        return true;
      case 'karma':
        addEffect(source, 'touchKarma', 4, { reflectPct: .30, healPct: .50 });
        emit({ type: 'presentation', cue: 'touchOfKarma', sourceId: source.id, duration: 4 });
        return true;
      case 'freedom':
        removeEffect(target, 'slow', 'freedom');
        removeEffect(target, 'root', 'freedom');
        addEffect(target, 'freedom', 5, { sourceId: source.id, speed: 1.30 });
        return true;
      case 'guardianAngel': {
        const guardianId = `guardian-${source.id}-${state.tick}`;
        const angle = random() * Math.PI * 2;
        const x = target.x + Math.cos(angle) * 1.4;
        const z = target.z + Math.sin(angle) * 1.4;
        state.units.set(guardianId, {
          id: guardianId, team: source.team, classId: 'pala', displayName: 'Guardian Angel', itemLevel: 990,
          summonKind: 'guardianAngel', ownerId: source.id, protectedId: target.id,
          x, z, radius: .5, speed: 6, hp: 124, maxHp: 124,
          resourceType: 'mana', resource: 0, maxResource: 0, resourceRegen: 0, alive: true, shield: 0,
          effects: new Map(), dr: {
            stun: { level: 0, until: 0 }, fear: { level: 0, until: 0 },
            incap: { level: 0, until: 0 }, root: { level: 0, until: 0 }
          }, talents: {}, tigereyeStacks: 0, tigereyePalmCounter: 0,
          stats: { damage: 0, healing: 0, absorb: 0, interrupts: 0, killingBlows: 0, damageByAbility: {}, healingByAbility: {} },
          input: { sequence: 0, x: 0, z: 0 }, lastActionSequence: -1, gcd: 0, cast: null,
          cooldowns: new Map(), trinketCooldown: 0, spawnRoll: random()
        });
        const valkyr = state.units.get(guardianId);
        addEffect(valkyr, 'guardianLifetime', 6, { protectedId: target.id, sourceId: source.id });
        addEffect(target, 'guardianImmunity', 6, { guardianId, sourceId: source.id });
        emit({ type: 'presentation', cue: 'guardianAngel', sourceId: source.id, targetId: target.id, guardianId, duration: 6 });
        return true;
      }
      case 'reverseHarm': {
        const actual=heal(source,source,source.maxHp*.08,'Reverse Harm');
        const enemy=[...state.units.values()].filter(u=>u.alive&&u.team!==source.team&&distance(source,u)<=5&&hasLineOfSight(source,u,state.arena.pillars,.05)).sort((a,b)=>distance(source,a)-distance(source,b))[0];
        if(actual&&enemy)damage(source,enemy,actual,'Reverse Harm',{school:'nature',exact:true});
        return true;
      }
      case 'crimsonVial':
        /* 2.5% max health each second for 6 sec, ignoring dampening. */
        addEffect(source, 'crimsonVial', 6, { tickRemaining: 1, pct: ability.baseValue || .025 });
        emit({ type: 'presentation', cue: 'crimsonVial', sourceId: source.id, duration: 6 });
        return true;
      case 'gouge':
        /* Incapacitate that any damage breaks early. */
        return applyCrowdControl(target, 'gouge', ability.baseValue || 3, 'incap') > 0;
      case 'chaosBolt':
        projectiles.push({sourceId:source.id,targetId:target.id,x:source.x,z:source.z,value:(ability.baseValue||510)*1.5,life:3});
        emit({type:'presentation',cue:'chaosBoltLaunch',sourceId:source.id,targetId:target.id});
        return true;
      case 'sharpenBlade':
        addEffect(source, 'sharpenBlade', 20, { sourceId: source.id });
        emit({ type: 'presentation', cue: 'sharpenBlade', sourceId: source.id, duration: 20 });
        return true;
      case 'intercept': {
        /* Charge to the ally, then eat their damage for 4 sec. */
        if (!target || target === source || target.team !== source.team) return false;
        source.charge={targetId:target.id,ally:true,remaining:1.5};
        emit({ type: 'presentation', cue: 'intercept', sourceId: source.id, targetId: target.id, duration: 4 });
        return true;
      }
      case 'groundStun': {
        /* Shadowfury: 4.5m circle at the chosen point. */
        let hits = 0;
        for (const enemy of state.units.values()) {
          if (!enemy.alive || enemy.team === source.team || enemy.summonKind) continue;
          if (distance(target, enemy) > 4.5) continue;
          if (!hasLineOfSight(source, enemy, state.arena.pillars, .05)) continue;
          damage(source, enemy, ability.baseValue || 42, label, { school: 'shadow' });
          applyCrowdControl(enemy, 'stun', 3, 'stun');
          hits++;
        }
        addEffect(source, 'pandemicSurge', 8, { bonus: .20 });
        emit({ type: 'presentation', cue: 'shadowfury', sourceId: source.id, x: round(target.x), z: round(target.z), hits });
        return true;
      }
      case 'healingStreamTotem': {
        const totemId = `totem-${source.id}-${state.tick}`;
        for (const existing of state.units.values()) {
          if (existing.summonKind === 'healingStreamTotem' && existing.ownerId === source.id && existing.alive) {
            existing.alive = false; existing.hp = 0;
            emit({ type: 'death', unitId: existing.id, killerId: null, expired: true });
          }
        }
        state.units.set(totemId, {
          id: totemId, team: source.team, classId: 'storm', displayName: 'Healing Stream Totem', itemLevel: 990,
          summonKind: 'healingStreamTotem', ownerId: source.id, x: source.x, z: source.z,
          radius: .42, speed: 0, hp: 280, maxHp: 280,
          resourceType: 'mana', resource: 0, maxResource: 0, resourceRegen: 0, alive: true, shield: 0,
          effects: new Map(), dr: {
            stun: { level: 0, until: 0 }, fear: { level: 0, until: 0 },
            incap: { level: 0, until: 0 }, root: { level: 0, until: 0 }
          }, talents: {}, tigereyeStacks: 0, tigereyePalmCounter: 0,
          stats: { damage: 0, healing: 0, absorb: 0, interrupts: 0, killingBlows: 0, damageByAbility: {}, healingByAbility: {} },
          input: { sequence: 0, x: 0, z: 0 }, lastActionSequence: -1, gcd: 0, cast: null,
          cooldowns: new Map(), trinketCooldown: 0, spawnRoll: random()
        });
        const totem = state.units.get(totemId);
        addEffect(totem, 'totemLifetime', 10, { sourceId: source.id, tickRemaining: 2, interval: 2, healValue: ability.baseValue || 90 });
        emit({ type: 'presentation', cue: 'healingStreamTotem', sourceId: source.id, targetId: totemId, x: round(source.x), z: round(source.z), duration: 10 });
        return true;
      }
      case 'summonInfernal': {
        const x = Number.isFinite(target?.x) ? target.x : source.x;
        const z = Number.isFinite(target?.z) ? target.z : source.z;
        emit({ type: 'presentation', cue: 'infernalIncoming', sourceId: source.id, x: round(x), z: round(z), duration: .98, radius: 5 });
        addEffect(source, 'infernalPending', .98, { x, z, baseValue: ability.baseValue || 90 });
        return true;
      }
      case 'heal':
      case 'holyLight':
        return heal(source, target, ability.baseValue, label) > 0;
      case 'holyShock':
      {
        const shots = Math.max(1, Number(ability.shots || 1));
        let landed = false;
        for (let shot = 0; shot < shots; shot += 1) {
          const critical = random() < .35 + talentRank(source, 'pala_radiant_shock') * .03;
          const base = target.team === source.team ? ability.baseValue : ability.damageValue || ability.baseValue;
          const value = critical ? Math.round(base * 1.5) : base;
          landed = (target.team === source.team
            ? heal(source, target, value, label) > 0
            : damage(source, target, value, label, { school: 'holy' }).hit) || landed;
          if (critical) addEffect(source, 'infusion', 10);
        }
        return landed;
      }
      case 'mortalSwing': {
        const empowered = getEffect(source, 'empoweredSwing');
        const warbreaker = getEffect(source, 'warbreakerReady');
        const pummelBonus = empowered ? talentRank(source, 'war_pummel_chain') * .02 : 0;
        const multiplier = (empowered ? 1.30 + pummelBonus : 1) * (warbreaker ? 1.30 : 1);
        if (warbreaker) removeEffect(source, 'warbreakerReady', 'consumed');
        let hit = damage(source, target, ability.baseValue * multiplier, label, { school: 'physical' }).hit;
        if (empowered) removeEffect(source, 'empoweredSwing', 'consumed');
        if (hit && getEffect(source, 'sharpenBlade')) {
          removeEffect(source, 'sharpenBlade', 'consumed');
          addEffect(target, 'mortalWound', 3, { pct: .40, sourceId: source.id });
          addEffect(source, 'sharpenRecovery', 3, { tickRemaining: 1, pct: .03 });
        }
        return hit;
      }
      case 'charge': {
        source.charge={targetId:target.id,value:ability.baseValue,label,remaining:1.5};
        emit({type:'presentation',cue:'chargeStart',sourceId:source.id,targetId:target.id});
        return true;
      }
      case 'rend': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical' }).hit;
        if (hit) {
          addEffect(target, 'bleed', 9, {
            value: 33,
            sourceId: source.id,
            label: 'Rend',
            interval: 1,
            tickRemaining: 1
          });
          if (random() < .30) {
            addEffect(source, 'gushingWoundReady', 10);
            source.cooldowns.delete('warrior.rend');
          }
        }
        return hit;
      }
      case 'gushingWound': {
        removeEffect(source, 'gushingWoundReady', 'consumed');
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical' }).hit;
        if (hit) addEffect(target, 'bleed', 6, {
          value: 26.4,
          sourceId: source.id,
          label: 'Gushing Wound',
          interval: .5,
          tickRemaining: .14
        });
        return hit;
      }
      case 'pummel': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical' }).hit;
        if (target.cast && !target.cast.uninterruptible) {
          const school = target.cast.school;
          target.cast = null;
          addEffect(target, `lock_${school}`, 3);
          addEffect(source, 'empoweredSwing', 12, { stacks: 1, pct: .30 });
          source.stats.interrupts += 1;
          emit({ type: 'interrupt', sourceId: source.id, targetId: target.id, school, duration: 3 });
        }
        return hit;
      }
      case 'reflect':
        addEffect(source, 'reflect', 2.5);
        return true;
      case 'shout':
        for (const unit of state.units.values()) {
          if (!unit.alive || unit.team === source.team || distance(source, unit) > 8) continue;
          if (hasLineOfSight(source, unit, state.arena.pillars, .05)) applyCrowdControl(unit, 'fear', ability.baseValue || 4, 'fear');
        }
        return true;
      case 'warriorGuard':
        addEffect(source, 'defensive', 6, { reduction: .60, damagePenalty: .25 });
        addEffect(source, 'victoryRushBoost', 12, { pct: .60 });
        emit({ type: 'presentation', cue: 'shieldWall', sourceId: source.id, duration: 6 });
        return true;
      case 'avatar':
        removeEffect(source, 'root', 'cleansed');
        addEffect(source, 'avatar', 10, { damagePct: .16 });
        emit({ type: 'presentation', cue: 'avatar', sourceId: source.id, duration: 10 });
        return true;
      case 'buff':
        addEffect(source, 'defensive', 3, { reduction: .12 });
        return true;
      case 'warbreaker': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical' }).hit;
        if (hit) addEffect(source, 'warbreakerReady', 10, { pct: .30 });
        return hit;
      }
      case 'victoryRush': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical' }).hit;
        if (hit) {
          const boost = getEffect(source, 'victoryRushBoost');
          heal(source, source, Number(ability.healValue || 185) * (boost ? 1.60 : 1), label);
          if (boost) removeEffect(source, 'victoryRushBoost', 'consumed');
        }
        return hit;
      }
      case 'paladinGuard':
        addEffect(source, 'defensive', 6, { reduction: .30 });
        return true;
      case 'paladinSteed':
        addEffect(source, 'divineSteed', 3, { speed: 1.65 });
        return true;
      case 'paladinStun':
        return applyCrowdControl(target, 'stun', ability.baseValue || 4.5, 'stun') > 0;
      case 'avengingWings':
        addEffect(source, 'avengingWings', 8, { healingBonus: .20, damageBonus: .20 });
        emit({ type: 'presentation', cue: 'avengingWings', sourceId: source.id, duration: 8 });
        return true;
      case 'sacrifice':
        addEffect(target, 'sacrifice', 6, { sourceId: source.id });
        addEffect(source, 'avengingWings', 6, { healingBonus: .20 });
        return true;
      case 'bestowFaith':
        addEffect(target, 'bestowFaith', 4, { sourceId: source.id, value: ability.baseValue || 240 });
        return true;
      case 'cleanse': {
        const freedom = ability.name === 'Blessing of Freedom';
        const removable = freedom
          ? ['root', 'slow']
          : ['poly', 'sleep', 'blind', 'fear', 'windIncap', 'root', 'slow', 'burn', 'poison', 'bleed', 'livingBomb', 'soulScar', 'agony', 'unstableAffliction', 'flameShock'];
        const removed = removable.find(type => getEffect(target, type));
        if (removed) removeEffect(target, removed, 'dispelled');
        return !!removed;
      }
      case 'shield':
        applyShield(source, target, ability.baseValue, 7);
        return true;
      case 'blind':
        return applyCrowdControl(target, 'blind', ability.baseValue || 3, 'incap') > 0;
      case 'shieldSelf':
        applyShield(source, source, ability.id === 'soul_dark_pact' ? source.maxHp * .30 : ability.baseValue, 6);
        if (source.classId === 'soul' && ability.id !== 'soul_dark_pact') addEffect(source, 'interruptWard', 6);
        if (source.classId === 'storm') addEffect(source, 'staticAegisGuard', 6, { reduction: .20 });
        return true;
      case 'flameNova': {
        let landed = false;
        for (const unit of state.units.values()) {
          if (!unit.alive || unit.team === source.team || distance(source, unit) > (ability.range || 8)) continue;
          if (!hasLineOfSight(source, unit, state.arena.pillars, .05)) continue;
          landed = damage(source, unit, ability.baseValue, label, { school: 'fire' }).hit || landed;
          applyCrowdControl(unit, 'root', 4, 'root');
          addEffect(unit, 'slow', 6, { pct: .60, sourceId: source.id });
        }
        return landed;
      }
      case 'dash': {
        const requested = source.actionDirection;
        const length = Math.hypot(requested?.x || source.input.x, requested?.z || source.input.z);
        const dx = length > 0 ? (requested?.x ?? source.input.x) / length : 1;
        const dz = length > 0 ? (requested?.z ?? source.input.z) / length : 0;
        source.x += dx * 15;
        source.z += dz * 15;
        resolvePillarCollisions(source, state.arena.pillars, source.radius);
        resolveArenaBounds(source, state.arena, source.radius);
        addEffect(source, 'defensive', 2, { reduction: .20 });
        return true;
      }
      case 'poly':
        return applyCrowdControl(target, 'poly', ability.baseValue || 7, 'incap') > 0;
      case 'interruptProc': {
        if (!target.cast || target.cast.uninterruptible) return false;
        const school = target.cast.school;
        target.cast = null;
        addEffect(target, `lock_${school}`, 3);
        addEffect(source, 'instantBolt', 20, { stacks: 2 });
        source.resource = Math.min(source.maxResource, source.resource + 20);
        source.stats.interrupts += 1;
        emit({ type: 'interrupt', sourceId: source.id, targetId: target.id, school, duration: 3 });
        return true;
      }
      case 'iceBlock':
        removeEffect(source, 'stun', 'cleansed');
        removeEffect(source, 'fear', 'cleansed');
        removeEffect(source, 'poly', 'cleansed');
        removeEffect(source, 'sleep', 'cleansed');
        removeEffect(source, 'blind', 'cleansed');
        removeEffect(source, 'root', 'cleansed');
        removeEffect(source, 'slow', 'cleansed');
        addEffect(source, 'iceBlock', 8, {
          sourceId: source.id,
          value: source.maxHp * .025 * (hasTalent(source,'flame_glacial_recovery')?1.30:1),
          interval: 1,
          tickRemaining: 1
        });
        return true;
      case 'combustion':
        addEffect(source, 'combustion', 8, { critChance: .80, castSpeed: .15 });
        return true;
      case 'livingBomb':
        addEffect(target, 'livingBomb', 6, {
          sourceId: source.id,
          value: ability.baseValue || 18,
          explosion: 190,
          interval: 1,
          tickRemaining: 1
        });
        return true;
      case 'flameShield':
        applyShield(source, source, ability.baseValue || 260, 8);
        addEffect(source, 'fireShield', 8, { sourceId: source.id });
        return true;
      case 'defensive':
        addEffect(source, 'defensive', 4, { reduction: source.classId === 'shadow' ? 0 : .35 });
        if (source.classId === 'shadow') {
          addEffect(source, 'smokePower', 8);
          addEffect(source, 'cheapReady', 8);
          addEffect(source, 'stealth', 8);
        }
        return true;
      case 'dot': {
        if (ability.immolate) {
          const hit = damage(source, target, ability.baseValue, 'Immolate', { school: 'fire' }).hit;
          if (hit) addEffect(target, 'burn', 8, {
            effectKey: `immolate:${source.id}`, sourceId: source.id, value: 35,
            label: 'Immolate', interval: 1, tickRemaining: 1
          });
          return hit;
        }
        const garrote = ability.id === 'shadow_garrote';
        const venom = getEffect(source, 'venomEdge');
        const immediate = garrote ? Math.round(ability.baseValue * .70) : ability.baseValue + (venom ? 78 : 0);
        const hit = damage(source, target, immediate, label, { school: ability.school, melee: true }).hit;
        if (!hit) return false;
        if (venom) removeEffect(source, 'venomEdge', 'consumed');
        const vendetta = getEffect(target, 'vendetta')?.sourceId === source.id;
        addEffect(target, garrote ? 'bleed' : 'poison', 8, {
          sourceId: source.id,
          value: garrote ? 46 : venom ? 28 : 14,
          label: garrote ? 'Garrote' : 'Viper Cut Poison',
          school: garrote ? 'physical' : 'shadow',
          interval: vendetta ? .5 : 1,
          tickRemaining: vendetta ? .5 : 1
        });
        return true;
      }
      case 'singleStun': {
        const hit = damage(source, target, ability.baseValue, label, { school: ability.school, melee: true }).hit;
        if (hit) {
          applyCrowdControl(target, 'stun', ability.id === 'shadow.ribbreaker' ? 4 : 6, 'stun');
          if (source.classId === 'shadow') addEffect(source, 'eviscerateReady', 10);
          if(ability.id==='shadow.ribbreaker'&&hasTalent(source,'shadow_shadowstep'))addEffect(target,'bleed',6,{sourceId:source.id,value:28.1,label:'Internal Bleeding',school:'physical',interval:1,tickRemaining:1});
          if (ability.id === 'soul_shadowfury') addEffect(source, 'pandemicSurge', 8, { pct: .20 });
        }
        return hit;
      }
      case 'shadowInterrupt': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical', melee: true }).hit;
        if (hit && target.cast && !target.cast.uninterruptible && !getEffect(target, 'interruptWard')) {
          const school = target.cast.school;
          target.cast = null;
          addEffect(target, `lock_${school}`, 3);
          source.stats.interrupts += 1;
          emit({ type: 'interrupt', sourceId: source.id, targetId: target.id, school, duration: 3 });
        }
        return hit;
      }
      case 'cloak':
        for (const type of ['slow', 'root', 'burn', 'poison', 'bleed', 'livingBomb', 'soulScar', 'agony', 'unstableAffliction', 'flameShock']) removeEffect(source, type, 'cleansed');
        addEffect(source, 'cloakShadows', 5);
        applyShield(source, source, ability.baseValue || 180, 5);
        return true;
      case 'evasion':
        addEffect(source, 'evasion', 8, { pct: .50 });
        return true;
      case 'vendetta':
        addEffect(target, 'vendetta', 8, { sourceId: source.id });
        return true;
      case 'shiv': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'physical', melee: true }).hit;
        if (hit) {
          addEffect(target, 'slow', 4, { pct: .65, sourceId: source.id });
          addEffect(target, 'shivPoisonAmp', 4, { sourceId: source.id, pct: .30 });
        }
        return hit;
      }
      case 'chain': {
        let landed = damage(source, target, ability.baseValue, label, { school: 'storm' }).hit;
        for (const unit of state.units.values()) {
          if (!unit.alive || unit === target || unit.team === source.team || distance(target, unit) > 8) continue;
          landed = damage(source, unit, ability.baseValue * .70, `${label} Arc`, { school: 'storm' }).hit || landed;
        }
        return landed;
      }
      case 'stun': {
        let landed = false;
        for (const unit of state.units.values()) {
          if (!unit.alive || unit.team === source.team || distance(source, unit) > (ability.range || 7)) continue;
          landed = damage(source, unit, ability.baseValue, label, { school: 'storm' }).hit || landed;
          applyCrowdControl(unit, 'stun', 4, 'stun');
        }
        if (landed && ability.id === 'storm.skybreaker_pulse') addEffect(source, 'volcanicEruptionReady', 30);
        return landed;
      }
      case 'push': {
        const enemy = [...state.units.values()].filter(unit => unit.alive && unit.team !== source.team)
          .sort((a, b) => distance(source, a) - distance(source, b))[0];
        if (!enemy || distance(source, enemy) > 9) return false;
        const dx = enemy.x - source.x;
        const dz = enemy.z - source.z;
        const length = Math.hypot(dx, dz) || 1;
        enemy.x += dx / length * 6;
        enemy.z += dz / length * 6;
        resolvePillarCollisions(enemy, state.arena.pillars, enemy.radius);
        resolveArenaBounds(enemy, state.arena, enemy.radius);
        return true;
      }
      case 'root':
        return applyCrowdControl(target, 'root', ability.baseValue || 4, 'root') > 0;
      case 'interrupt': {
        if (!target.cast || target.cast.uninterruptible || getEffect(target, 'interruptWard')) return false;
        const school = target.cast.school;
        target.cast = null;
        addEffect(target, `lock_${school}`, 3);
        source.stats.interrupts += 1;
        emit({ type: 'interrupt', sourceId: source.id, targetId: target.id, school, duration: 3 });
        return true;
      }
      case 'flameShock':
        addEffect(target, 'flameShock', 12, {
          sourceId: source.id, value: ability.baseValue, label, interval: 1, tickRemaining: 1
        });
        return true;
      case 'volcanicEruption': {
        removeEffect(source, 'volcanicEruptionReady', 'consumed');
        const hit = damage(source, target, ability.baseValue, label, { school: 'storm' }).hit;
        if (hit) {
          emit({ type: 'presentation', cue: 'volcanicEruption', sourceId: source.id, targetId: target.id });
          for (let bolt = 1; bolt <= 2 && target.alive; bolt += 1) {
            damage(source, target, 60, `Volcanic Lava Burst ${bolt}`, { school: 'storm' });
            emit({ type: 'presentation', cue: 'volcanicLavaBurst', sourceId: source.id, targetId: target.id, bolt });
          }
        }
        return hit;
      }
      case 'frostShock': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'storm' }).hit;
        if (hit) {
          const snareDuration = applyCrowdControl(target, 'slow', 3, 'root');
          const snare = getEffect(target, 'slow');
          if (snareDuration > 0 && snare) { snare.pct = .25; snare.sourceId = source.id; }
          addEffect(target, 'frostShockAmp', 8, { pct: .15, sourceId: source.id });
        }
        return hit;
      }
      case 'totemMastery':
        addEffect(source, 'totemMastery', 20);
        return true;
      case 'stormkeeper':
        addEffect(source, 'stormkeeper', 10, { stacks: 3 });
        return true;
      case 'soulDot':
        addEffect(target, 'soulScar', 15, {
          sourceId: source.id, value: ability.baseValue, label, interval: 1, tickRemaining: 1
        });
        return true;
      case 'agony':
        addEffect(target, 'agony', 15, {
          sourceId: source.id, value: ability.baseValue, stacks: 1, label, interval: 1, tickRemaining: 1
        });
        return true;
      case 'unstableAffliction': {
        const effect = getEffect(target, 'unstableAffliction');
        const stacks = Math.min(3, Number(effect?.stacks || 0) + 1);
        addEffect(target, 'unstableAffliction', 10, {
          sourceId: source.id, value: ability.baseValue, stacks, label, interval: 1, tickRemaining: 1
        });
        return true;
      }
      case 'fear': {
        const applied = applyCrowdControl(target, 'fear', ability.baseValue || 3.5, 'fear') > 0;
        if(applied)getEffect(target,'fear').breakFromDots=source.classId!=='soul';
        if (ability.name === 'Mortal Horror') heal(source, source, source.maxHp * .20, 'Mortal Horror');
        return applied;
      }
      case 'alterTime': {
        const saved = getEffect(source, 'alterTime');
        if (saved) {
          source.x = saved.x;
          source.z = saved.z;
          source.hp = Math.max(1, Math.min(source.maxHp, saved.hp));
          resolvePillarCollisions(source, state.arena.pillars, source.radius);
          resolveArenaBounds(source, state.arena, source.radius);
          source.cooldowns.set(ability.id, 60);
          removeEffect(source, 'alterTime', 'recast');
          emit({ type: 'presentation', cue: 'alterTimeReturn', sourceId: source.id });
        } else {
          addEffect(source, 'alterTime', 5, { x: source.x, z: source.z, hp: source.hp, abilityId: ability.id });
          emit({ type: 'presentation', cue: 'alterTimeSaved', sourceId: source.id, duration: 5 });
        }
        return true;
      }
      case 'undyingResolve':
        addEffect(source, 'defensive', 5, { reduction: .50 });
        return true;
      case 'hot': {
        const direct = heal(source, target, ability.baseValue, label);
        const fast = !!getEffect(source, 'ghanir');
        addEffect(target, 'hot', 12, {
          effectKey: `hot:${ability.id}`,
          sourceId: source.id,
          value: ability.tickValue || (ability.id === 'sage_rejuvenate' ? 28 : 23),
          label,
          interval: fast ? .5 : 1,
          tickRemaining: fast ? .5 : 1
        });
        return direct > 0;
      }
      case 'spiritBlossom':
        addEffect(source, 'spiritBlossomTree', 9, {
          x: target.x, z: target.z, value: ability.baseValue, shield: 23,
          interval: 1, tickRemaining: .02
        });
        return true;
      case 'bigHeal':
        return heal(source, target, ability.baseValue, label) > 0;
      case 'healerEscape': {
        const length = Math.hypot(source.input.x, source.input.z);
        const dx = length > 0 ? -source.input.x / length : -1;
        const dz = length > 0 ? -source.input.z / length : 0;
        source.x += dx * 9;
        source.z += dz * 9;
        resolvePillarCollisions(source, state.arena.pillars, source.radius);
        resolveArenaBounds(source, state.arena, source.radius);
        addEffect(source, 'defensive', 3, { reduction: .30 });
        return true;
      }
      case 'sleep':
        return applyCrowdControl(target, 'sleep', ability.baseValue || 4.5, 'incap') > 0;
      case 'ghanir':
        addEffect(source, 'ghanir', 7, { hotBonus: .50, hotInterval: .50 });
        return true;
      case 'natureSwiftness':
        addEffect(source, 'natureSwiftness', 8);
        return true;
      case 'ironbark':
        addEffect(target, 'ironbark', 6, { sourceId: source.id, healingTaken: .20 });
        addEffect(target, 'defensive', 6, { sourceId: source.id, reduction: .20 });
        return true;
      case 'discSmite': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'holy' }).hit;
        if (hit) healAtonements(source, 112, 'Smite Atonement');
        return hit;
      }
      case 'discShield':
        applyShield(source, target, ability.baseValue, 8);
        applyAtonement(source, target, 14);
        return true;
      case 'discMend': {
        const healed = heal(source, target, ability.baseValue, label);
        applyAtonement(source, target, 14);
        if (source === target) addEffect(source, 'defensive', 4, { reduction: .10 });
        return healed > 0;
      }
      case 'discSolace': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'holy' }).hit;
        if (hit) {
          healAtonements(source, 132, 'Solace Atonement');
          source.resource = Math.min(source.maxResource, source.resource + 7);
        }
        return hit;
      }
      case 'painSuppression':
        addEffect(target, 'painSuppression', 5, { sourceId: source.id });
        addEffect(target, 'defensive', 5, { sourceId: source.id, reduction: .60 });
        return true;
      case 'ultimateRadiance':
        for (const ally of state.units.values()) {
          if (!ally.alive || ally.team !== source.team) continue;
          heal(source, ally, ability.baseValue, label);
          applyAtonement(source, ally, 10);
        }
        addEffect(source, 'radiantPenanceProc', 12, { stacks: 1 });
        return true;
      case 'discFear':
        for (const unit of state.units.values()) {
          if (unit.alive && unit.team !== source.team && distance(source, unit) <= 8 && hasLineOfSight(source, unit, state.arena.pillars, .05)) {
            applyCrowdControl(unit, 'fear', ability.baseValue || 4, 'fear');
          }
        }
        return true;
      case 'discFade':
        addEffect(source, 'discFade', 4, { speed: 1.25 });
        addEffect(source, 'defensive', 4, { reduction: .30 });
        return true;
      case 'archangel':
        removeEffect(source, 'darkArchangel', 'replaced');
        addEffect(source, 'archangel', 12, { atonementBonus: .30 });
        return true;
      case 'darkArchangel':
        removeEffect(source, 'archangel', 'replaced');
        addEffect(source, 'darkArchangel', 12, { damagePct: .30 });
        return true;
      case 'angelicBody':
        addEffect(source, 'angelicBody', 5, { speed: 1.30 });
        return true;
      default:
        return false;
    }
  }

  function channelTick(source, cast) {
    if (cast.kind === 'soulDrain') {
      const target = state.units.get(cast.targetId);
      if (!target?.alive) return;
      const afflictions = (getEffect(target, 'soulScar') ? 1 : 0)
        + (getEffect(target, 'agony') ? 1 : 0)
        + Number(getEffect(target, 'unstableAffliction')?.stacks || 0);
      const amount = cast.baseValue + afflictions * 15;
      if (damage(source, target, amount, cast.ability.name, { school: 'shadow' }).hit) heal(source, source, amount * .575, cast.ability.name);
      if (hasTalent(source, 'soul_void_mend')) {
        const remaining = source.cooldowns.get('soul_void_mend') || 0;
        if (remaining > 0) source.cooldowns.set('soul_void_mend', Math.max(0, remaining - 3));
      }
      cast.ticks += 1;
      return;
    }
    if (cast.kind === 'discPenance') {
      const target = state.units.get(cast.targetId);
      if (!target?.alive) return;
      cast.ticks += 1;
      if (target.team === source.team) heal(source, target, 132, 'Penance Direct Heal');
      else {
        const multiplier = cast.radiant ? 1.15 : 1;
        if (damage(source, target, cast.baseValue * multiplier, cast.radiant ? 'Radiant Penance' : 'Penance', { school: 'holy' }).hit) {
          healAtonements(source, 78 * multiplier, cast.radiant ? 'Radiant Penance Atonement' : 'Penance Atonement');
        }
      }
      return;
    }
    if (!['fists', 'bladestorm'].includes(cast.kind)) return;
    cast.ticks += 1;
    for (const target of state.units.values()) {
      if (!target.alive || target.team === source.team || distance(source, target) > cast.radius) continue;
      if (!hasLineOfSight(source, target, state.arena.pillars, .05)) continue;
      const label = cast.kind === 'bladestorm' ? 'Bladestorm Tick' : 'Fists of Fury';
      if (damage(source, target, cast.baseValue, label, { school: cast.kind === 'bladestorm' ? 'physical' : 'wind' }).hit) {
        addEffect(target, 'slow', cast.kind === 'bladestorm' ? .75 : .72, { pct: .60, sourceId: source.id });
      }
    }
  }

  function tickEffects(unit) {
    for (const [effectKey, effect] of unit.effects) {
      const type = effect.type || effectKey;
      const nextRemaining = effect.remaining - fixedDt;
      effect.remaining = nextRemaining <= 1e-9 ? 0 : nextRemaining;
      if (type === 'cauterizeDoom' && unit.alive) {
        unit.hp = Math.min(unit.hp, Math.max(1, Math.floor(unit.maxHp * .30 * effect.remaining / 5)));
        if (effect.remaining === 0) {
          const source = state.units.get(effect.sourceId);
          unit.hp = 0;
          unit.alive = false;
          unit.cast = null;
          if (source?.stats) source.stats.killingBlows += 1;
          emit({ type: 'death', unitId: unit.id, killerId: source?.id || null, cauterize: true });
        }
      }
      if (Number.isFinite(effect.tickRemaining)) {
        effect.tickRemaining -= fixedDt;
        while (effect.tickRemaining <= 1e-9) {
          const source = state.units.get(effect.sourceId);
          if (source?.alive && unit.alive && ['bleed', 'poison'].includes(type)) {
            const amp = type === 'poison' && getEffect(unit, 'shivPoisonAmp')?.sourceId === source.id ? 1.30 : 1;
            damage(source, unit, effect.value * amp, effect.label || type, { school: effect.school || 'physical', periodic: true });
          }
          if (source?.alive && unit.alive && ['burn', 'livingBomb'].includes(type)) {
            damage(source, unit, effect.value, effect.label || (type === 'livingBomb' ? 'Living Bomb' : 'Burn'), { school: 'fire', periodic: true });
          }
          if (source?.alive && unit.alive && type === 'iceBlock') {
            heal(source, unit, effect.value, 'Ice Block');
          }
          if (source?.alive && unit.alive && ['soulScar', 'flameShock'].includes(type)) {
            damage(source, unit, effect.value, effect.label || type, { school: type === 'flameShock' ? 'fire' : 'shadow', periodic: true });
          }
          if (source?.alive && unit.alive && type === 'agony') {
            damage(source, unit, effect.value * effect.stacks, effect.label || type, { school: 'shadow', periodic: true });
            effect.stacks = Math.min(10, effect.stacks + 1);
          }
          if (source?.alive && unit.alive && type === 'unstableAffliction') {
            const stacks = Math.max(1, Math.min(3, Number(effect.stacks || 1)));
            const totalTick = [0, 50, 80, 110][stacks];
            damage(source, unit, totalTick, effect.label || type, { school: 'shadow', periodic: true });
          }
          if (source?.alive && unit.alive && type === 'hot') heal(source, unit, effect.value, effect.label || 'Healing Over Time');
          if (unit.alive && (type === 'crimsonVial' || type === 'sharpenRecovery')) {
            /* Percent-of-health recovery that ignores dampening, matching the client. */
            let bonus=0;
            if(type==='crimsonVial')for(const enemy of state.units.values()){
              if(!enemy.alive||enemy.team===unit.team||distance(unit,enemy)>25)continue;
              const dots=new Set([...enemy.effects.values()].filter(e=>e.remaining>0&&e.sourceId===unit.id&&['poison','bleed'].includes(e.type)).map(e=>e.label||e.type));
              bonus=Math.max(bonus,Math.min(3,dots.size)*.005);
            }
            const amount = Math.min(unit.maxHp-unit.hp,Math.max(0, Math.round(unit.maxHp * ((effect.pct || .025)+bonus))));
            unit.hp = Math.min(unit.maxHp, unit.hp + amount);
            unit.stats.healing += amount;
          }
          if (type === 'totemLifetime' && unit.alive) {
            emit({ type: 'presentation', cue: 'healingStreamPulse', sourceId: unit.id, duration: .5 });
            if (source?.alive) for (const ally of state.units.values()) {
              if (!ally.alive || ally.team !== unit.team || ally.summonKind || distance(unit, ally) > 18) continue;
              heal(source, ally, effect.healValue || 90, 'Healing Stream Totem');
            }
          }
          if (type === 'spiritBlossomTree' && unit.alive) {
            for (const ally of state.units.values()) {
              if (!ally.alive || ally.team !== unit.team || Math.hypot(ally.x - effect.x, ally.z - effect.z) > 6) continue;
              heal(unit, ally, effect.value, 'Spirit Blossom');
              applyShield(unit, ally, effect.shield, 1.35);
            }
          }
          effect.tickRemaining += effect.interval || 1;
          if (effect.remaining <= 0) break;
        }
      }
      if (effect.remaining === 0 && type === 'bestowFaith') {
        const source = state.units.get(effect.sourceId);
        if (source?.alive && unit.alive) {
          emit({ type: 'presentation', cue: 'bestowFaithComplete', sourceId: source.id, targetId: unit.id });
          heal(source, unit, effect.value || 240, 'Bestow Faith');
        }
      }
      if (effect.remaining === 0 && type === 'guardianLifetime') {
        unit.alive = false;
        unit.hp = 0;
        const protectedUnit = state.units.get(effect.protectedId);
        if (protectedUnit) removeEffect(protectedUnit, 'guardianImmunity', 'guardian_expired');
        emit({ type: 'death', unitId: unit.id, killerId: null, expired: true });
      }
      if (type === 'infernalLifetime' && unit.alive && !isControlled(unit)) {
        effect.manaRemaining -= fixedDt;
        effect.pulseRemaining -= fixedDt;
        const owner = state.units.get(effect.sourceId);
        while (effect.manaRemaining <= 1e-9) {
          effect.manaRemaining += 1;
          if (owner?.alive) owner.resource = Math.min(owner.maxResource, owner.resource + 4);
        }
        while (effect.pulseRemaining <= 1e-9) {
          effect.pulseRemaining += 2;
          emit({ type: 'presentation', cue: 'infernalSlam', sourceId: unit.id, duration: .62 });
          if (owner?.alive) for (const enemy of state.units.values()) {
            if (!enemy.alive || enemy.team === unit.team || enemy.summonKind || distance(unit, enemy) > 8) continue;
            if (!hasLineOfSight(unit, enemy, state.arena.pillars, .05)) continue;
            damage(owner, enemy, 50, 'Infernal Immolation', { school: 'shadow' });
            addEffect(enemy, 'infernalExposure', 10, { sourceId: owner.id });
          }
        }
      }
      if (effect.remaining === 0 && (type === 'infernalLifetime' || type === 'totemLifetime')) {
        unit.alive = false;
        unit.hp = 0;
        emit({ type: 'death', unitId: unit.id, killerId: null, expired: true });
      }
      if (effect.remaining === 0 && type === 'infernalLifetime') {
        unit.alive = false;
        unit.hp = 0;
        emit({ type: 'death', unitId: unit.id, killerId: null, expired: true });
      }
      if (effect.remaining === 0 && type === 'livingBomb') {
        const source = state.units.get(effect.sourceId);
        if (source?.alive && unit.alive) {
          emit({ type: 'presentation', cue: 'livingBombExplosion', sourceId: source.id, targetId: unit.id, x: round(unit.x), z: round(unit.z) });
          damage(source, unit, effect.explosion || 190, 'Living Bomb Explosion', { school: 'fire' });
        }
      }
      if (effect.remaining === 0 && type === 'infernalPending') {
        landInfernal(unit, effect.x, effect.z, Number(effect.baseValue) || 90);
      }
      if (effect.remaining === 0 && type === 'meteorPending') {
        emit({
          type: 'presentation', cue: 'meteorfallImpact', sourceId: unit.id,
          x: round(effect.x), z: round(effect.z), radius: 5.2
        });
        for (const target of state.units.values()) {
          if (!target.alive || target.team === unit.team || Math.hypot(target.x - effect.x, target.z - effect.z) > 5.2) continue;
          if (damage(unit, target, 205, 'Meteorfall', { school: 'fire' }).hit) {
            addEffect(target, 'burn', 5, {
              sourceId: unit.id,
              value: 17,
              label: 'Meteorfall Burn',
              interval: 1,
              tickRemaining: 1
            });
          }
        }
        addEffect(unit, 'meteorLance', 60, { stacks: 1 });
        unit.cooldowns.delete('flame.ember_lance');
      }
      if (effect.remaining === 0 && type === 'touchOfDeath') {
        const source = state.units.get(effect.sourceId);
        if (source?.alive && unit.alive) {
          const burst = Math.max(0, Math.round(Number(effect.accumulated || 0) * .30));
          emit({
            type: 'presentation', cue: 'touchOfDeathExplosion',
            sourceId: source.id, targetId: unit.id, amount: burst
          });
          if (burst > 0) damage(source, unit, burst, 'Touch of Death', { school: 'wind', cannotReflect: true });
        }
      }
      if (effect.remaining === 0 && type === 'alterTime' && unit.alive) {
        unit.x = effect.x;
        unit.z = effect.z;
        unit.hp = Math.max(1, Math.min(unit.maxHp, effect.hp));
        resolvePillarCollisions(unit, state.arena.pillars, unit.radius);
        resolveArenaBounds(unit, state.arena, unit.radius);
        unit.cooldowns.set(effect.abilityId || 'flame_phoenix_guard', 60);
        emit({ type: 'presentation', cue: 'alterTimeReturn', sourceId: unit.id });
      }
      if (effect.remaining === 0) removeEffect(unit, effectKey, 'expired');
    }
  }

  function effectSnapshot(unit) {
    return Object.fromEntries([...unit.effects].map(([type, effect]) => [type, {
      ...effect,
      remaining: round(effect.remaining)
    }]));
  }

  return {
    advanceCharge,
    tickProjectiles,
    addEffect,
    applyCrowdControl,
    channelTick,
    canUseWhileCasting,
    commitAbility,
    damage,
    effectSnapshot,
    getEffect,
    heal,
    isControlled,
    isSelfTarget: ability => SELF_TYPES.has(ability.type),
    movementMultiplier,
    prepareAbility,
    removeEffect,
    requiresEnemyTarget: ability => !SELF_TYPES.has(ability.type) && !FRIENDLY_TYPES.has(ability.type) && !['holyShock', 'discPenance'].includes(ability.type),
    requiresFriendlyTarget: ability => FRIENDLY_TYPES.has(ability.type),
    resolveAbility,
    supports,
    tickEffects
  };
}
