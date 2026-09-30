import { distance, hasLineOfSight, resolveArenaBounds, resolvePillarCollisions } from './geometry.js';
import { combatTuning } from '../../content/generated/combat-tuning.generated.js';

const TALENT_EFFECT_NODES = Object.fromEntries(Object.entries(combatTuning.trees).map(([classId,nodes])=>[classId,nodes.filter(node=>node.effects)]));

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
  , 'reverseHarm', 'crimsonVial', 'gouge', 'groundStun', 'chaosBolt', 'intercept', 'sharpenBlade', 'shadowStrike'
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
        const rank=talentRank(unit,'war_hold_the_line'),relentless=talentRank(unit,'war_relentless_charge');if(rank)addEffect(unit,'holdTheLine',3+relentless*.5,{reduction:rank*.02});if(relentless)unit.resource=Math.min(unit.maxResource,unit.resource+5*relentless);
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
    const previous=unit.effects.get(key),source=state.units.get(data.sourceId);
    if(previous&&source?.classId==='soul'&&['soulScar','agony','unstableAffliction'].includes(type)&&talentRank(source,'soul_curse_weaving'))addEffect(source,'curseWeavingPower',10,{pct:talentRank(source,'soul_curse_weaving')*.02});
    if(previous&&source?.classId==='soul'&&type==='burn'&&data.label==='Immolate'&&talentRank(source,'soul_curse_weaving'))addEffect(source,'curseWeavingPower',10,{pct:talentRank(source,'soul_curse_weaving')*.02});
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
    const speed = getEffect(unit, 'freedom') || getEffect(unit, 'tigersLust') || getEffect(unit, 'divineSteed') || getEffect(unit, 'discFade') || getEffect(unit, 'angelicBody') || getEffect(unit, 'bloodFrenzy') || getEffect(unit, 'comboSpeed') || getEffect(unit, 'faeMomentum');
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
    if(ability.id==='flame.blazing_step')ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'swiftstep'));
    if(ability.id==='flame.prism_hex')ability.castTime=Math.max(.4,ability.castTime-talentRank(unit,'hexmastery')*.10);
    if(ability.id==='storm.wind_shear')ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'windfocus'));
    if(ability.id==='soul.grasping_gloom')ability.range+=talentRank(unit,'gloomreach');
    if(ability.id==='sage.verdant_mend')ability.castTime=Math.max(.45,ability.castTime-talentRank(unit,'quickmend')*.08);
    if(ability.id==='sage.purifying_light')ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'cleanhands')*.5);
    if(['sage.fae_retreat','sage.lullaby_bloom','sage_natures_grasp'].includes(ability.id))ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'sage_root_warden')*2);
    if(ability.id==='shadow.umbral_pounce')ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'pounceflow'));
    if(ability.id==='wind.cloudstep_kick')ability.cooldown=Math.max(6,ability.cooldown-talentRank(unit,'longdash')-talentRank(unit,'tigerdash')-talentRank(unit,'wind_nimble_brew'));
    if(['wind_tigers_lust','wind_disabling_reach','wind_tiger_rush'].includes(ability.id))ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'wind_nimble_brew'));
    if(ability.type==='painSuppression')ability.cooldown=Math.max(1,ability.cooldown-talentRank(unit,'disc_pain')*3);
    if(ability.id==='disc.smite'&&hasTalent(unit,'disc_dark_archangel'))Object.assign(ability,{name:'Mind Spike',school:'shadow',castTime:1.30,baseValue:102,atonementHeal:96});
    if(ability.id==='shadow.night_slash'&&getEffect(unit,'eviscerateReady'))ability.name='Eviscerate';
    if(getEffect(unit,'borrowedTime')&&['disc.smite','disc.shadow_mend'].includes(ability.id)){ability.castTime=Math.max(.45,ability.castTime*.80);ability.borrowedTime=true;}
    if(ability.type==='chaosBolt'&&getEffect(unit,'backdraft')){ability.castTime=Math.max(.75,ability.castTime*(1-talentRank(unit,'souldrain')*.12));ability.backdraft=true;}
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
      if(getEffect(unit,'backdraft')){ability.castTime=Math.max(.75,ability.castTime*(1-talentRank(unit,'souldrain')*.12));ability.backdraft=true;}
    }
    if (ability.id === 'soul.creeping_torment' && hasTalent(unit, 'soul_void_mend')) {
      ability.name = 'Immolate';
      ability.type = 'dot';
      ability.school = 'fire';
      ability.castTime = 1.35;
      ability.cooldown = 0;
      ability.baseValue = 146.2;
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
    if(ability.id==='storm.arc_spark'&&getEffect(unit,'tempestBolts')&&!getEffect(unit,'stormkeeper')){
      ability.name='Tempest Bolt';ability.castTime=0;ability.baseValue=173;ability.cooldown=.25;ability.offGlobal=true;ability.tempestProc=true;
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
    if (ability.type === 'freedom') {
      ability.cooldown = Math.max(8, ability.cooldown - talentRank(unit, 'pala_unbound_freedom') * 2);
    }
    if (ability.type === 'fear') ability.cooldown = Math.max(2, ability.cooldown - talentRank(unit, 'soul_fear_tactics'));
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
    const genericDamage=(TALENT_EFFECT_NODES[unit.classId]||[]).reduce((sum,node)=>sum+talentRank(unit,node.id)*Number(node.effects.damagePct||0)/100,0);
    multiplier *= 1 + genericDamage;
    if (unit.classId === 'warrior' && /Rend|Gushing Wound/i.test(label)) {
      multiplier *= 1 + talentRank(unit, 'deepwounds') * .05;
    }
    return multiplier;
  }

  function healingMultiplier(unit, target, label = '') {
    const wings = getEffect(unit, 'avengingWings');
    const brew = getEffect(unit, 'tigereyeBrew');
    const genericHealing=(TALENT_EFFECT_NODES[unit.classId]||[]).reduce((sum,node)=>sum+talentRank(unit,node.id)*Number(node.effects.healingPct||0)/100,0);
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
      * (1 + genericHealing)
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
    const comboReady = getEffect(source, 'comboMasteryReady');
    const twilight = getEffect(source, 'twilightSurge');
    const backdraft = getEffect(source, 'backdraft');
    const holyFavour = getEffect(source, 'crusaderFavour');
    let outgoing = Number(amount) * (options.exact?1:damageMultiplier(source, label));
    const frostMark = getEffect(target, 'frostShockAmp');
    if (frostMark?.sourceId === source.id && /Arc Spark|Forked Current/i.test(String(label))) outgoing *= 1.15;
    const lightningRod = getEffect(target,'lightningRod');
    if(lightningRod?.sourceId===source.id&&/Arc Spark|Forked Current/i.test(String(label)))outgoing*=1.20;
    if (source.classId === 'warrior' && /Mortal Swing/i.test(label) && [...target.effects.values()].some(effect => effect.type === 'bleed' && effect.label === 'Rend' && effect.sourceId === source.id)) outgoing *= 1 + talentRank(source, 'executioner') * .06;
    if (source.classId === 'shadow' && label === 'Shadowstrike') outgoing *= 1 + talentRank(source, 'eviscerate') * .08;
    if (source.classId === 'shadow' && label === 'Eviscerate') outgoing *= 1 + talentRank(source, 'eviscerate') * .12;
    if (source.classId === 'storm' && /Forked Current|Volcanic|Lava|Tempest/i.test(label)) outgoing *= 1 + talentRank(source, 'lavacore') * .04;
    if (source.classId === 'wind' && /Fists of Fury/i.test(label) && getEffect(source, 'defensive')) outgoing *= 1 + talentRank(source, 'cyclonetech') * .12;
    if (source.classId === 'wind' && /Zephyr Palm|Cloudstep Kick/i.test(label) && comboReady) outgoing *= 1 + talentRank(source, 'tigerdash') * .25;
    if (source.classId === 'soul' && /Essence Siphon|Chaos Bolt|Immolate/i.test(label)) outgoing *= 1 + talentRank(source, 'souldrain') * .04;
    if (source.classId === 'soul' && /Soul Scar|Creeping Torment|Unstable Affliction|Essence Siphon/i.test(label)) {
      const afflictions = ['soulScar','agony','unstableAffliction'].reduce((count,type)=>count+(getEffect(target,type)?.sourceId===source.id?1:0),0);
      outgoing *= 1 + afflictions * talentRank(source, 'pandemic') * .03;
    }
    if (label === 'Chaos Bolt' && backdraft) outgoing *= 1 + talentRank(source, 'souldrain') * .05;
    if (label === 'Mind Spike' && twilight) outgoing *= 1 + Number(twilight.pct || .35);
    if (/Holy Shock/.test(label) && holyFavour) outgoing *= 1 + Number(holyFavour.stacks || 1) * (Number(holyFavour.pct || 0) + talentRank(source,'pala_awakening')*.03);
    const twilightHoly=getEffect(source,'twilightHoly'),twilightShadow=getEffect(source,'twilightShadow');if(source.classId==='disc'&&label==='Mind Spike'&&twilightHoly)outgoing*=1.15;if(source.classId==='disc'&&/Smite|Solace|Penance/.test(label)&&twilightShadow)outgoing*=1.15;
    const weakness = getEffect(target, 'findWeakness');
    if (source.classId === 'shadow' && weakness?.sourceId === source.id && /Shadowstrike|Night Slash|Eviscerate/.test(label)) outgoing *= 1 + talentRank(source, 'shadow_find_weakness') * .05;
    if(source.classId==='flame'&&/Living Bomb|Meteor/.test(label))outgoing*=1+talentRank(source,'flame_living_flame')*.04;
    if(source.classId==='flame'&&/Meteor Lance|Ember Lance/.test(label))outgoing*=1+talentRank(source,'flame_meteoric_precision')*.15;
    if(source.classId==='flame'&&label==='Cinder Bolt'&&getEffect(source,'instantBolt'))outgoing*=1+talentRank(source,'flame_temporal_velocity')*.06;
    if(source.classId==='flame'&&label==='Cinder Bolt'&&getEffect(source,'prismaticFocus'))outgoing*=1+talentRank(source,'flame_prismatic_focus')*.08;
    if(source.classId==='warrior'&&/Mortal Swing|Warbreaker|Slicing Winds/.test(label))outgoing*=1+talentRank(source,'war_crushing_force')*.04;
    if(source.classId==='warrior'&&/Rend|Gushing Wound|Internal Bleeding/.test(label))outgoing*=1+talentRank(source,'war_bloodletting')*.05;
    if(source.classId==='storm'&&/Arc Spark|Forked Current/.test(label)){outgoing*=1+talentRank(source,'storm_conduction')*.03;const rod=getEffect(target,'lightningRod');if(rod?.sourceId===source.id)outgoing*=1+talentRank(source,'storm_supercell')*.03;if(getEffect(source,'elementalEquilibrium'))outgoing*=1+talentRank(source,'storm_elemental_equilibrium')*.08;}
    if(source.classId==='wind'&&/Zephyr Palm|Cloudstep Kick/.test(label)){outgoing*=1+Number(getEffect(source,'comboMomentum')?.stacks||0)*talentRank(source,'wind_hit_combo')*.03;if(comboReady)outgoing*=1+talentRank(source,'wind_meridian_strikes')*.10;}
    if(source.classId==='wind'&&/Fists of Fury|Cyclone Barrage/.test(label))outgoing*=1+talentRank(source,'wind_jadefire_fists')*.05;
    if(source.classId==='soul'&&/Soul Scar|Creeping Torment|Unstable Affliction|Essence Siphon/.test(label))outgoing*=1+talentRank(source,'soul_creeping_death')*.04;
    if(source.classId==='soul'&&/Essence Siphon/.test(label))outgoing*=1+talentRank(source,'soul_malefic_grasp')*.05+Number(getEffect(source,'inevitableDemise')?.empowered||0);
    if(source.classId==='soul'&&label==='Chaos Bolt')outgoing*=1+talentRank(source,'soul_ruin')*.05;
    if(source.classId==='soul'&&/Immolate/.test(label))outgoing*=1+talentRank(source,'soul_demonfire')*.05;
    if(source.classId==='disc'&&/Smite|Solace|Penance/.test(label)){const atonements=[...state.units.values()].filter(unit=>unit.team===source.team&&getEffect(unit,'atonement')?.sourceId===source.id).length;outgoing*=1+Math.min(3,atonements)*talentRank(source,'disc_many_sins')*.03;}
    if(source.classId==='disc'&&/Mind Spike|Penance/.test(label))outgoing*=1+talentRank(source,'disc_shadow_covenant')*.05;
    if(source.classId==='shadow'&&/Poison|Garrote|Internal Bleeding|Viper Cut|Rend/.test(label))outgoing*=1+talentRank(source,'shadow_deadly_brew')*.04;
    if(source.classId==='shadow'&&getEffect(target,'vendetta')?.sourceId===source.id&&/Garrote|Internal Bleeding|Bleed|Rend/.test(label))outgoing*=1+talentRank(source,'shadow_doomblade')*.03;
    if(source.classId==='shadow'&&/Shadowstrike|Eviscerate/.test(label))outgoing*=1+talentRank(source,'shadow_deeper_daggers')*.05;
    if(source.classId==='shadow'&&getEffect(source,'controlledChaos'))outgoing*=1+talentRank(source,'shadow_controlled_chaos')*.04;
    if(source.classId==='shadow'&&/Poison|Garrote|Internal Bleeding|Viper Cut/.test(label))outgoing*=1+talentRank(source,'shadow_poisoncraft')*.03;
    if(source.classId==='wind'&&/Fists of Fury/.test(label))outgoing*=1+talentRank(source,'focusfury')*.04;
    const overheat=source.classId==='flame'&&label==='Cinder Bolt'&&!options.periodic&&getEffect(source,'overheatPower');
    const aftershock=source.classId==='storm'&&!options.periodic&&getEffect(source,'aftershockPower');
    const curseWeaving=source.classId==='soul'&&!options.periodic&&options.school==='shadow'&&getEffect(source,'curseWeavingPower');
    if(overheat)outgoing*=1+Number(overheat.pct||0);
    if(aftershock)outgoing*=1+Number(aftershock.pct||0);
    if(curseWeaving)outgoing*=1+Number(curseWeaving.pct||0);
    if (!Number.isFinite(outgoing) || outgoing <= 0) return { hit: false, amount: 0, absorbed: 0 };
    source.combatUntil = Math.max(Number(source.combatUntil) || 0, state.time + 4);
    target.combatUntil = Math.max(Number(target.combatUntil) || 0, state.time + 4);
    if (source.mounted) { source.mounted = false; emit({ type: 'mount', unitId: source.id, mounted: false, reason: 'combat' }); }
    if (target.mounted) { target.mounted = false; emit({ type: 'mount', unitId: target.id, mounted: false, reason: 'combat' }); }
    for (const type of BREAKABLE_CONTROL) {if(type==='fear'&&options.periodic&&getEffect(target,'fear')?.breakFromDots===false)continue;removeEffect(target, type, 'damage');}
    const defensive = getEffect(target, 'defensive');
    if (defensive) outgoing *= 1 - Number(defensive.reduction ?? .35);
    const elusive = getEffect(target, 'elusiveSteps');if(elusive)outgoing*=1-Number(elusive.reduction||.04);
    if (getEffect(target, 'infernalExposure')) outgoing *= 1.10;
    const staticGuard = getEffect(target, 'staticAegisGuard');
    if (staticGuard) outgoing *= 1 - Number(staticGuard.reduction || .20);
    if (getEffect(target, 'holdTheLine')) outgoing *= 1 - Number(getEffect(target, 'holdTheLine').reduction || 0);
    if(target.classId==='wind'&&(getEffect(target,'defensive')||getEffect(target,'touchKarma')))outgoing*=1-talentRank(target,'wind_temple_guard')*.03;
    if(getEffect(target,'temperedFocus'))outgoing*=1-Number(getEffect(target,'temperedFocus').reduction||0);
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
      if(overheat)removeEffect(source,'overheatPower','consumed');
      if(aftershock)removeEffect(source,'aftershockPower','consumed');
      if(curseWeaving)removeEffect(source,'curseWeavingPower','consumed');
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
      if (source.classId === 'flame' && label === 'Cinder Bolt' && talentRank(source, 'meteorimpact') > 0 && getEffect(target, 'burn')?.sourceId === source.id) {
        const readyAt = Number(source.cooldowns.get('flame.meteor') || 0);
        if (readyAt > 0) source.cooldowns.set('flame.meteor', Math.max(0, readyAt - .5 * talentRank(source, 'meteorimpact')));
      }
      if(source.classId==='flame'&&talentRank(source,'flame_kindling')>0&&/Burn|Living Bomb/.test(label)&&!getEffect(source,'kindlingLock')){const ready=Number(source.cooldowns.get('flame.meteor')||0);if(ready>0)source.cooldowns.set('flame.meteor',Math.max(0,ready-.15*talentRank(source,'flame_kindling')));addEffect(source,'kindlingLock',.5);}
      if(source.classId==='flame'&&label==='Cinder Bolt'&&getEffect(source,'prismaticFocus'))removeEffect(source,'prismaticFocus','consumed');
      if (source.classId === 'warrior' && label === 'Mortal Swing' && talentRank(source, 'executioner') > 0 && !getEffect(source, 'colossusLock') && target.alive) {
        const found=[...target.effects.entries()].find(([,effect])=>effect.type==='bleed'&&effect.label==='Rend'&&effect.sourceId===source.id);
        if(found){const [key,rend]=found,removed=Math.min(3,rend.remaining),ticks=removed/Math.max(.1,Number(rend.interval||1)),conversion=.55*(1+talentRank(source,'war_colossal_might')*.20),rupture=Number(rend.value||0)*ticks*conversion*talentRank(source,'executioner');rend.remaining=Math.max(0,rend.remaining-removed);if(rend.remaining<=0)target.effects.delete(key);addEffect(source,'colossusLock',3);if(rupture>0)damage(source,target,rupture,'Colossus Rupture',{school:'physical'});}
      }
      if (source.classId === 'warrior' && talentRank(source,'battlehardened') > 0 && /Rend|Gushing Wound|Internal Bleeding/i.test(label)){heal(source,source,actual*(.15*talentRank(source,'battlehardened')+.05*talentRank(source,'war_red_thirst')),'Bloodsteel');if(hasTalent(source,'war_blood_frenzy'))addEffect(source,'bloodFrenzy',2,{speed:1.12});}
      if(source.classId==='warrior'&&label==='Mortal Swing'&&target.hp/target.maxHp<.35&&hasTalent(source,'war_execution_rhythm'))source.resource=Math.min(source.maxResource,source.resource+8);
      if(source.classId==='warrior'&&/Mortal Swing|Rend|Warbreaker/.test(label)&&talentRank(source,'war_anger_management')>0){for(const id of ['war_skullbreaker','warrior.avatar']){const ready=Number(source.cooldowns.get(id)||0);if(ready>0)source.cooldowns.set(id,Math.max(0,ready-.5*talentRank(source,'war_anger_management')));}}
      if (source.classId === 'storm' && label === 'Arc Spark' && talentRank(source,'lavacore') > 0) addEffect(target,'lightningRod',getEffect(source,'stormkeeper')?6:4,{sourceId:source.id});
      if (source.classId === 'storm' && /Arc Spark|Forked Current/i.test(label) && talentRank(source,'grounded') > 0) {const rank=talentRank(source,'grounded'),harmony=1+talentRank(source,'storm_earthen_harmony')*.15,cap=source.maxHp*.08*rank*harmony,gain=source.maxHp*.0075*rank*harmony;source.shield=Math.min(cap,source.shield+gain);addEffect(source,'earthward',8,{value:Math.round(source.shield)});}
      if(source.classId==='storm'&&label==='Arc Spark'){source.resource=Math.min(source.maxResource,source.resource+talentRank(source,'storm_flowing_mana'));if(options.stormkeeperSpark&&hasTalent(source,'storm_overcharge')){const ready=Number(source.cooldowns.get('storm.forked_current')||0);if(ready>0)source.cooldowns.set('storm.forked_current',Math.max(0,ready-1));}}
      if(source.classId==='storm'&&/Arc Spark|Forked Current/.test(label)&&getEffect(source,'elementalEquilibrium'))removeEffect(source,'elementalEquilibrium','consumed');
      if (source.classId === 'wind' && /Zephyr Palm|Cloudstep Kick/i.test(label) && talentRank(source,'tigerdash') > 0) {if(comboReady){removeEffect(source,'comboMasteryReady','consumed');source.resource=Math.min(source.maxResource,source.resource+8);if(hasTalent(source,'wind_dance_of_wind'))addEffect(source,'comboSpeed',2,{speed:1.20});}else{const old=getEffect(source,'comboMomentum'),alternating=old?.last&&old.last!==label,stacks=alternating?Math.min(3,Number(old.stacks||0)+1):1;removeEffect(source,'comboMomentum','refreshed');if(stacks>=3)addEffect(source,'comboMasteryReady',10);else addEffect(source,'comboMomentum',10,{stacks,last:label});}}
      if(source.classId==='wind'&&label==='Zephyr Palm')source.resource=Math.min(source.maxResource,source.resource+2*talentRank(source,'wind_quickened_chi'));
      if(source.classId==='wind'&&label==='Cloudstep Kick'&&talentRank(source,'wind_elusive_steps'))addEffect(source,'elusiveSteps',2,{reduction:talentRank(source,'wind_elusive_steps')*.02});
      if (source.classId === 'wind' && /Fists of Fury/i.test(label) && talentRank(source,'cyclonetech') > 0) heal(source,source,actual*(.10*talentRank(source,'cyclonetech')+.08*talentRank(source,'wind_jade_recovery')),'Jade Brawler');
      if (source.classId === 'soul' && /Soul Scar|Creeping Torment|Unstable Affliction|Essence Siphon/i.test(label) && talentRank(source,'pandemic') > 0) heal(source,source,actual*.03*talentRank(source,'pandemic'),'Affliction Siphon');
      if(source.classId==='soul'&&hasTalent(source,'soul_inevitable_demise')&&/Soul Scar|Creeping Torment|Unstable Affliction/.test(label)){const stacks=Number(getEffect(source,'inevitableCounter')?.stacks||0)+1;removeEffect(source,'inevitableCounter','progress');if(stacks>=5){source.resource=Math.min(source.maxResource,source.resource+5);addEffect(source,'inevitableDemise',10,{empowered:.20});}else addEffect(source,'inevitableCounter',30,{stacks});}
      if(source.classId==='soul'&&label==='Essence Siphon'&&getEffect(source,'inevitableDemise'))removeEffect(source,'inevitableDemise','consumed');
      if(source.classId==='soul'&&label==='Chaos Bolt'&&backdraft&&hasTalent(source,'soul_reverse_entropy'))source.resource=Math.min(source.maxResource,source.resource+6);
      if (source.classId === 'disc' && /Smite|Mind Spike|Solace|Penance/i.test(label) && talentRank(source,'disc_archangel') > 0) for(const ally of state.units.values()){const atonement=getEffect(ally,'atonement');if(atonement?.sourceId===source.id)atonement.remaining=Math.min(18,atonement.remaining+.35);}
      if(source.classId==='disc'&&label==='Mind Spike'&&hasTalent(source,'disc_harsh_discipline')){const stacks=Number(getEffect(source,'harshDisciplineCount')?.stacks||0)+1;removeEffect(source,'harshDisciplineCount','progress');if(stacks>=2){removeEffect(source,'harshDisciplineReady','replaced');addEffect(source,'harshDisciplineReady',15);}else addEffect(source,'harshDisciplineCount',20,{stacks});}
      if (source.classId === 'pala' && /Righteous Strike|Judgement|Judgment/i.test(label) && talentRank(source,'radiance') > 0) {const rank=talentRank(source,'radiance'),stacks=Math.min(3,Number(getEffect(source,'crusaderFavour')?.stacks||0)+1);addEffect(source,'crusaderFavour',12,{stacks,pct:.10*rank});const shock=Number(source.cooldowns.get('pala.holy_shock')||0);if(shock)source.cooldowns.set('pala.holy_shock',Math.max(0,shock-.75*rank));}
      if(source.classId==='pala'&&/Judgement|Judgment/.test(label)&&talentRank(source,'pala_glimmer')>0){const marked=[...state.units.values()].find(unit=>unit.alive&&getEffect(unit,'glimmer')?.sourceId===source.id);if(marked){const echo=actual*.04*talentRank(source,'pala_glimmer');if(marked.team===source.team)heal(source,marked,echo,'Glimmer of Light');else if(marked!==target)damage(source,marked,echo,'Glimmer of Light',{school:'holy'});}}
      if(source.classId==='pala'&&/Righteous Strike|Judgement|Judgment/.test(label)&&hasTalent(source,'pala_crusaders_might')){const ready=Number(source.cooldowns.get('pala.holy_shock')||0);if(ready>0)source.cooldowns.set('pala.holy_shock',Math.max(0,ready-1));}
      if(source.classId==='shadow'&&hasTalent(source,'shadow_venomous_wounds')&&/Poison|Garrote|Internal Bleeding|Bleed|Rend/.test(label)){const stacks=Number(getEffect(source,'venomousCounter')?.stacks||0)+1;removeEffect(source,'venomousCounter','progress');if(stacks>=4)source.resource=Math.min(source.maxResource,source.resource+6);else addEffect(source,'venomousCounter',30,{stacks});}
      if(source.classId==='shadow'&&label==='Eviscerate')source.resource=Math.min(source.maxResource,source.resource+3*talentRank(source,'shadow_relentless_strikes'));
      if (label === 'Mind Spike' && twilight) removeEffect(source,'twilightSurge','consumed');
      if(source.classId==='disc'&&hasTalent(source,'disc_twilight_equilibrium')){if(label==='Mind Spike'){removeEffect(source,'twilightHoly','consumed');removeEffect(source,'twilightShadow','replaced');addEffect(source,'twilightShadow',10);}else if(/Smite|Solace|Penance/.test(label)){removeEffect(source,'twilightShadow','consumed');removeEffect(source,'twilightHoly','replaced');addEffect(source,'twilightHoly',10);}}
      if (label === 'Chaos Bolt' && backdraft) removeEffect(source,'backdraft','consumed');
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
    if(getEffect(target,'smokeBomb'))return 0;
    const wound = getEffect(target, 'mortalWound');
    const woundMult = wound ? Math.max(0, 1 - Number(wound.pct || .40)) : 1;
    const periodic = /Blooming Echo|Rejuvenate|Spirit Blossom|Atonement|Bloodsteel|Affliction Siphon|Grove Echo|Beacon Mirror|Jade Brawler/i.test(String(label||''));
    const before = target.hp, missing = Math.max(0,target.maxHp-before);
    let adjusted = Number(amount);
    if(source.classId==='sage'&&label==='Spirit Blossom')adjusted*=1+talentRank(source,'wildgrowth')*.06;
    if(source.classId==='disc'&&/Atonement/.test(label)&&talentRank(source,'disc_archangel')>0)adjusted*=1.10;
    const favour=getEffect(source,'crusaderFavour');if(source.classId==='pala'&&/Holy Shock/.test(label)&&favour)adjusted*=1+Number(favour.stacks||1)*(Number(favour.pct||0)+talentRank(source,'pala_awakening')*.03);
    if(source.classId==='sage'&&periodic)adjusted*=1+talentRank(source,'sage_photosynthesis')*.04;
    if(source.classId==='sage'&&getEffect(target,'dreamSeed')&&!periodic)adjusted*=1+talentRank(source,'sage_lucid_mending')*.02;
    if(source.classId==='soul'&&/Essence Siphon/.test(label))adjusted*=1+talentRank(source,'soul_malefic_grasp')*.05;
    if(source.classId==='disc'&&/Penance Atonement/.test(label))adjusted*=1+talentRank(source,'disc_contrition')*.06;
    if(source.classId==='disc'&&/Penance Atonement/.test(label))adjusted*=1+talentRank(source,'disc_penance')*.06;
    if(source.classId==='disc'&&label==='Ultimate Radiance')adjusted*=1+talentRank(source,'disc_radiance')*.06;
    if(source.classId==='disc'&&label==='Shadow Mend')adjusted*=1+talentRank(source,'disc_darklight')*.04;
    if(source.classId==='soul'&&/Essence Siphon/.test(label))adjusted*=1+talentRank(source,'drainrite')*.04;
    if(source.classId==='sage'&&periodic)adjusted*=1+talentRank(source,'sage_verdant_tempo')*.03;
    const requested = adjusted * (label==='Reverse Harm'?1:healingMultiplier(source, target, label)) * woundMult * (label==='Reverse Harm'?1:1 - state.dampening);
    const actual = Math.max(0, Math.min(target.maxHp - target.hp, Math.round(requested)));
    if (actual) {
      target.hp += actual;
      source.stats.healing += actual;
      source.stats.healingByAbility[label] = (source.stats.healingByAbility[label] || 0) + actual;
      emit({ type: 'healing', sourceId: source.id, targetId: target.id, ability: label, amount: actual });
    }
    if(source.classId==='storm'&&label==='Healing Surge'&&talentRank(source,'grounded')>0){applyShield(source,target,target.maxHp*.05*talentRank(source,'grounded')*(1+talentRank(source,'storm_earthen_harmony')*.15),8);if(hasTalent(source,'storm_resurgence'))source.resource=Math.min(source.maxResource,source.resource+3);if(talentRank(source,'storm_elemental_equilibrium'))addEffect(source,'elementalEquilibrium',10);}
    if(source.classId==='sage'&&label==='Verdant Mend'&&actual>0&&talentRank(source,'wildgrowth')>0&&[...target.effects.values()].some(effect=>effect.type==='hot'&&effect.sourceId===source.id)){
      const ally=[...state.units.values()].filter(unit=>unit.alive&&unit.team===source.team&&unit!==target&&distance(unit,target)<=28).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
      if(ally)heal(source,ally,actual*.12*talentRank(source,'wildgrowth'),'Grove Echo');
    }
    if(source.classId==='sage'&&label==='Verdant Mend'&&talentRank(source,'sage_verdant_infusion'))for(const effect of target.effects.values())if(effect.type==='hot'&&effect.sourceId===source.id)effect.remaining=Math.min(18,effect.remaining+talentRank(source,'sage_verdant_infusion'));
    if(source.classId==='sage'&&label==='Spirit Blossom'&&hasTalent(source,'sage_grove_blossom'))for(const unit of state.units.values())if(unit.alive&&unit.team===source.team&&distance(unit,source)<=12)for(const effect of unit.effects.values())if(effect.type==='hot'&&effect.sourceId===source.id)effect.remaining=Math.max(effect.remaining,6);
    if(source.classId==='sage'&&talentRank(source,'barkskin')>0&&!periodic){const rank=talentRank(source,'barkskin'),power=1+talentRank(source,'sage_dreamstate')*.15,minimum=label==='Renewal Tide'?target.maxHp*.02*rank:0,overheal=Math.max(0,requested-missing),seed=Math.max(minimum,overheal*.30*rank)*power,cap=target.maxHp*.08*rank*power;if(seed>0){const existing=Number(getEffect(target,'dreamSeed')?.value||0),next=Math.min(cap,existing+seed);addEffect(target,'dreamSeed',10,{value:Math.round(next),sourceId:source.id});target.shield=Math.max(target.shield,Math.round(next));}}
    if(source.classId==='sage'&&label==='Renewal Tide'&&hasTalent(source,'sage_waking_dream')){const ward=Math.round(target.maxHp*.04);target.shield=Math.max(target.shield,ward);addEffect(target,'dreamSeed',10,{value:ward,sourceId:source.id});}
    if(source.classId==='pala'&&talentRank(source,'guardianlight')>0&&!periodic&&actual>0){const beacon=[...state.units.values()].find(unit=>unit.alive&&unit.team===source.team&&unit!==target&&[...unit.effects.values()].some(effect=>effect.type==='beaconFaith'&&effect.sourceId===source.id));if(beacon)heal(source,beacon,actual*(.15*talentRank(source,'guardianlight')+.05*talentRank(source,'pala_beacon_light')),'Beacon Mirror');}
    if(source.classId==='pala'&&actual>0&&target.hp/target.maxHp<.30&&getEffect(target,'beaconFaith')?.sourceId===source.id&&hasTalent(source,'pala_saved_by_light')&&!getEffect(source,'savedLightLock')){applyShield(source,target,target.maxHp*.10,6);addEffect(source,'savedLightLock',30);}
    return actual;
  }

  function applyShield(source, target, amount, duration, label='') {
    const soulBonus=source.classId==='soul'?1+talentRank(source,'soul_barrier_rites')*.03:1;
    const palaBonus=source.classId==='pala'?1+talentRank(source,'guardianlight')*.04:1;
    const discBonus=source.classId==='disc'&&/Power Shield/i.test(label||'')?1+talentRank(source,'disc_shielding')*.06:1;
    const value = Math.round(Number(amount) * soulBonus * palaBonus * discBonus * (getEffect(source, 'totemMastery') ? 1.05 : 1) * (1 - state.dampening));
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
    addEffect(target, 'atonement', duration+talentRank(source,'disc_evangelism'), { sourceId: source.id });
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
    if (ability.borrowedTime) removeEffect(source, 'borrowedTime', 'consumed');
    if(source.classId==='flame'&&['livingBomb','flameShield','combustion'].includes(ability.type)&&talentRank(source,'flame_overheat'))addEffect(source,'overheatPower',10,{pct:talentRank(source,'flame_overheat')*.02});
    switch (ability.type) {
      case 'damage': {
        let amount = ability.baseValue;
        if (ability.alwaysCritical) amount *= 1.5;
        if (ability.name === 'Pandemic Bloom' && getEffect(source, 'pandemicSurge')) {
          amount *= 1.20;
          removeEffect(source, 'pandemicSurge', 'consumed');
        }
        if (ability.id === 'flame.cinder_bolt' && ability.instantProc) amount *= 1 + Number(getEffect(source,'instantBolt')?.pct || .20);
        if (ability.id === 'flame.ember_lance') {
          if (getEffect(target, 'burn')) amount *= 1.30;
          if (ability.meteorProc) amount *= 1.15;
        }
        let damageLabel = label;
        if (ability.id === 'shadow.night_slash' && getEffect(source, 'eviscerateReady')) {
          amount *= hasTalent(source, 'eviscerate') ? 1.85 : 1.45;
          damageLabel = 'Eviscerate';
          removeEffect(source, 'eviscerateReady', 'consumed');
          if(hasTalent(source,'eviscerate'))source.resource=Math.min(source.maxResource,source.resource+18);
        }
        const result = damage(source, target, amount, damageLabel, { school: ability.school, melee: source.classId === 'shadow', stormkeeperSpark: !!ability.stormkeeperSpark });
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
          if (ability.meteorProc) {const proc=getEffect(source,'meteorLance');if(proc){proc.stacks=Number(proc.stacks||1)-1;if(proc.stacks<=0)removeEffect(source,'meteorLance','consumed');}}
        }
        if (ability.id === 'shadow.night_slash' && result.hit && !hasTalent(source, 'eviscerate')) {
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
        if (ability.id === 'storm.arc_spark') {
          if(ability.tempestProc){const bolts=getEffect(source,'tempestBolts');if(bolts){bolts.stacks=Math.max(0,Number(bolts.stacks||2)-1);if(!bolts.stacks)removeEffect(source,'tempestBolts','consumed');}}
          if(result.hit){source.resource = Math.min(source.maxResource, source.resource + (ability.tempestProc?5:4));
          if(!ability.tempestProc&&!ability.stormkeeperSpark){const ramp=getEffect(source,'stormChance');const chance=Math.min(1,Number(ramp?.chance||.10)+(getEffect(source,'totemMastery')?.05:0));if(random()<chance){removeEffect(source,'stormChance','triggered');addEffect(source,'tempestBolts',10,{stacks:2});addEffect(source,'overload',10);source.resource=Math.min(source.maxResource,source.resource+10+talentRank(source,'storm_arc_battery'));emit({type:'presentation',cue:'stormSurge',sourceId:source.id});}else addEffect(source,'stormChance',16,{chance:Math.min(1,chance+.10+talentRank(source,'surgeflow')*.01)});}
          if (ability.stormkeeperSpark) {
            const keeper = getEffect(source, 'stormkeeper');
            keeper.stacks -= 1;
            if (keeper.stacks <= 0) removeEffect(source, 'stormkeeper', 'consumed');
          }
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
      case 'shadowStrike': {
        const hit = damage(source, target, ability.baseValue, 'Shadowstrike', { school: 'physical', melee: true }).hit;
        if (!hit) return false;
        source.resource=Math.min(source.maxResource,source.resource+4);
        const stacks = Math.min(3, Number(getEffect(source, 'shadowTechnique')?.stacks || 0) + 1);
        removeEffect(source, 'shadowTechnique', 'refreshed');
        if (talentRank(source, 'shadow_find_weakness') > 0) addEffect(target, 'findWeakness', 4, { sourceId: source.id });
        if (stacks >= 3) addEffect(source, 'eviscerateReady', 10);
        else addEffect(source, 'shadowTechnique', 8, { stacks });
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
        heal(source, source, source.maxHp * .08, 'Willow Guard');
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
        addEffect(target, 'freedom', 5, { sourceId: source.id, speed: 1.30+talentRank(source,'pala_unbound_freedom')*.05 });
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
        const actual=heal(source,source,source.maxHp*.16,'Reverse Harm');
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
      {const applied=applyCrowdControl(target,'gouge',ability.baseValue||3,'incap')>0;if(applied&&hasTalent(source,'shadow_controlled_chaos'))addEffect(source,'controlledChaos',4);return applied;}
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
        if(talentRank(source,'pala_glimmer')>0){for(const unit of state.units.values())if(getEffect(unit,'glimmer')?.sourceId===source.id)removeEffect(unit,'glimmer','replaced');addEffect(target,'glimmer',8,{sourceId:source.id});}
        if (getEffect(source,'crusaderFavour')) removeEffect(source,'crusaderFavour','consumed');
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
        addEffect(target, 'sacrifice', 6+talentRank(source,'pala_sacred_vow')*.25, { sourceId: source.id });
        addEffect(source, 'avengingWings', 6, { healingBonus: .20 });
        return true;
      case 'bestowFaith':
        addEffect(target, 'bestowFaith', 4, { sourceId: source.id, value: ability.baseValue || 240 });
        if(talentRank(source,'guardianlight')>0)addEffect(target,'beaconFaith',12,{sourceId:source.id});
        if(talentRank(source,'pala_bestowed_grace')>0)heal(source,target,target.maxHp*.03*talentRank(source,'pala_bestowed_grace'),'Bestowed Grace');
        return true;
      case 'cleanse': {
        const freedom = ability.name === 'Blessing of Freedom';
        const removable = freedom
          ? ['root', 'slow']
          : ['poly', 'sleep', 'blind', 'fear', 'windIncap', 'root', 'slow', 'burn', 'poison', 'bleed', 'livingBomb', 'soulScar', 'agony', 'unstableAffliction', 'flameShock'];
        const removed = removable.find(type => getEffect(target, type));
        if (removed) removeEffect(target, removed, 'dispelled');
        if(removed&&source.classId==='sage'&&talentRank(source,'sage_fae_momentum'))addEffect(source,'faeMomentum',2,{speed:1+talentRank(source,'sage_fae_momentum')*.10});
        return !!removed;
      }
      case 'shield':
        applyShield(source, target, ability.baseValue, 7);
        return true;
      case 'blind':
      {const applied=applyCrowdControl(target,'blind',ability.baseValue||3,'incap')>0;if(applied&&hasTalent(source,'shadow_controlled_chaos'))addEffect(source,'controlledChaos',4);return applied;}
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
        if(source.classId==='flame'&&talentRank(source,'counterheat')>0){const rank=talentRank(source,'counterheat'),stacks=Math.min(3,Number(getEffect(source,'instantBolt')?.stacks||0)+1);addEffect(source,'instantBolt',10,{stacks,pct:rank*.05});}
        if(source.classId==='flame'&&hasTalent(source,'flame_afterimage'))applyShield(source,source,source.maxHp*.06,3);
        return true;
      }
      case 'poly':
      {const applied=applyCrowdControl(target,'poly',ability.baseValue||7,'incap')>0;if(applied&&talentRank(source,'flame_prismatic_focus'))addEffect(source,'prismaticFocus',10);return applied;}
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
          const veilDuration=8+talentRank(source,'shadow_veil_training')*.25;
          addEffect(source, 'smokePower', veilDuration);
          addEffect(source, 'cheapReady', veilDuration);
          addEffect(source, 'smokeBombReady', veilDuration);
          addEffect(source, 'stealth', veilDuration);
          if(hasTalent(source,'eviscerate')){
            source.cooldowns.delete('eviscerate');source.resource=Math.min(source.maxResource,source.resource+10);
            removeEffect(source,'shadowTechnique','refreshed');removeEffect(source,'eviscerateReady','refreshed');if(hasTalent(source,'shadow_premeditation'))addEffect(source,'eviscerateReady',10);else addEffect(source,'shadowTechnique',8,{stacks:2});
          }
        }
        return true;
      case 'dot': {
        if (ability.immolate) {
          const hit = damage(source, target, ability.baseValue, 'Immolate', { school: 'fire' }).hit;
          if (hit) addEffect(target, 'burn', 8, {
            effectKey: `immolate:${source.id}`, sourceId: source.id, value: 59.5,
            label: 'Immolate', interval: 1, tickRemaining: 1
          });
          if(hit&&talentRank(source,'souldrain')>0)addEffect(source,'backdraft',12,{rank:talentRank(source,'souldrain')});
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
          if(source.classId==='shadow'&&hasTalent(source,'shadow_controlled_chaos'))addEffect(source,'controlledChaos',4);
          if(ability.id==='shadow.ribbreaker'&&hasTalent(source,'shadow_shadowstep'))addEffect(target,'bleed',6,{sourceId:source.id,value:28.1,label:'Internal Bleeding',school:'physical',interval:1,tickRemaining:1});
          if(source.classId==='shadow'&&getEffect(source,'smokeBombReady')){removeEffect(source,'smokeBombReady','consumed');addEffect(target,'smokeBomb',5+talentRank(source,'smoketactics')*.25,{sourceId:source.id});}
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
        addEffect(source, 'cloakShadows', 5+talentRank(source,'shadow_veil_training')*.25);
        applyShield(source, source, ability.baseValue || 180, 5);
        return true;
      case 'evasion':
        addEffect(source, 'evasion', 8+talentRank(source,'shadow_veil_training')*.25, { pct: .70 });
        return true;
      case 'vendetta':
        addEffect(target, 'vendetta', 10+talentRank(source,'shadow_doomblade'), { sourceId: source.id });
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
        const overloaded=!!getEffect(source,'overload'),power=overloaded?1.35:1;
        if(overloaded)removeEffect(source,'overload','consumed');
        let landed = damage(source, target, ability.baseValue*power, label, { school: 'storm' }).hit;
        for (const unit of state.units.values()) {
          if (!unit.alive || unit === target || unit.team === source.team || distance(target, unit) > 8) continue;
          landed = damage(source, unit, 64*power, `${label} Arc`, { school: 'storm' }).hit || landed;
        }
        source.resource=Math.min(source.maxResource,source.resource+(overloaded?10:6));
        if(overloaded)for(const unit of state.units.values()){if(!unit.alive||unit.team===source.team||!hasLineOfSight(source,unit,state.arena.pillars,.05))continue;for(let bolt=1;bolt<=3;bolt++){emit({type:'presentation',cue:'volcanicLavaBurst',sourceId:source.id,targetId:unit.id,bolt});damage(source,unit,45,'Lava Burst',{school:'fire'});}addEffect(unit,'burn',3,{sourceId:source.id,value:8,label:'Lava Burst',interval:1,tickRemaining:1});}
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
        if(source.classId==='storm'&&talentRank(source,'storm_aftershock'))addEffect(source,'aftershockPower',10,{pct:talentRank(source,'storm_aftershock')*.02});
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
        if(talentRank(source,'counterheat')>0)source.cooldowns.delete('flame.blazing_step');
        if(talentRank(source,'flame_rewind'))source.resource=Math.min(source.maxResource,source.resource+3*talentRank(source,'flame_rewind'));
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
        if(talentRank(source,'sage_fae_momentum'))addEffect(source,'faeMomentum',2,{speed:1+talentRank(source,'sage_fae_momentum')*.10});
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
        const hit = damage(source, target, ability.baseValue, label, { school: ability.school || 'holy' }).hit;
        if (hit) healAtonements(source, Number(ability.atonementHeal||112), `${label} Atonement`);
        return hit;
      }
      case 'discShield':
        applyShield(source, target, ability.baseValue, 8, 'Power Shield');
        applyAtonement(source, target, 14);
        if(hasTalent(source,'disc_borrowed_time'))addEffect(source,'borrowedTime',10);
        return true;
      case 'discMend': {
        const healed = heal(source, target, ability.baseValue, label);
        applyAtonement(source, target, 14);
        if (source === target) addEffect(source, 'defensive', 4, { reduction: .10 });
        if(talentRank(source,'disc_dark_archangel')>0)addEffect(source,'twilightSurge',10,{pct:.35});
        return healed > 0;
      }
      case 'discSolace': {
        const hit = damage(source, target, ability.baseValue, label, { school: 'holy' }).hit;
        if (hit) {
          healAtonements(source, 132, 'Solace Atonement');
          source.resource = Math.min(source.maxResource, source.resource + 7+talentRank(source,'disc_solace')*2);
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
      if(cast.harshDiscipline===undefined){const ready=getEffect(source,'harshDisciplineReady'),rank=talentRank(source,'disc_harsh_discipline');cast.harshDiscipline=ready?1+rank*.12:1;if(ready)removeEffect(source,'harshDisciplineReady','consumed');}
      cast.ticks += 1;
      if (target.team === source.team) heal(source, target, 132*cast.harshDiscipline, 'Penance Direct Heal');
      else {
        const multiplier = cast.radiant ? 1.15 : 1;
        if (damage(source, target, cast.baseValue * multiplier * cast.harshDiscipline, cast.radiant ? 'Radiant Penance' : 'Penance', { school: 'holy' }).hit) {
          healAtonements(source, 78 * multiplier * cast.harshDiscipline, cast.radiant ? 'Radiant Penance Atonement' : 'Penance Atonement');
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
        if(cast.kind==='fists'&&hasTalent(source,'wind_chi_wave')){damage(source,target,11,'Rushing Jade Wind',{school:'wind'});addEffect(source,'rushingJade',.8);}
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
        addEffect(unit, 'meteorLance', 60, { stacks: talentRank(unit,'meteorimpact')>=2?2:1 });
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
    hasTalent,
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
