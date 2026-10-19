import {combatTuning} from '../../content/generated/combat-tuning.generated.js';

/* Baseline combat scaling, mirrored from the offline runtime and cross-checked
   against those actual functions in numeric-parity.test.mjs. Talent percentages
   belong to one additive pool; gear and temporary buffs multiply that pool.
   New specialization modules remain separate and must not be applied here. */
export function createCombatScaling({state,getEffect,talentRank}) {
 const get=(unit,type)=>unit?getEffect(unit,type):null;
 const rank=(unit,id)=>talentRank(unit,id);
 const effects=unit=>unit?.effects?.values?.()||[];
 const owned=(effect,unit)=>!!effect&&effect.sourceId===unit?.id;
 const nodes=cls=>combatTuning.trees[cls]||[];
 const brew=unit=>get(unit,'tigereyeBrew')?1+Number(get(unit,'tigereyeBrew').power||0):1;

 function talentDamage(unit,target,label=''){
  const cls=unit.classId,r=id=>rank(unit,id);
  let m=1+nodes(cls).reduce((sum,n)=>sum+r(n.id)*Number(n.effects?.damagePct||0)/100,0);
  if(cls==='flame'&&/Meteor|Ember Lance/.test(label))m+=r('meteorimpact')*.04;
  if(cls==='warrior'&&/Mortal Swing/.test(label)&&[...effects(target)].some(e=>e.type==='bleed'&&e.label==='Rend'&&owned(e,unit)))m+=r('executioner')*.06;
  if(cls==='warrior'&&/Rend|Gushing Wound/.test(label))m+=r('deepwounds')*.05;
  if(cls==='storm'&&/Volcanic|Forked|Lava|Tempest/.test(label))m+=r('lavacore')*.04;
  if(cls==='wind'&&/Fists/.test(label))m+=r('focusfury')*.04;
  if(cls==='wind'&&/Fists of Fury|Hurricane Strikes/.test(label)&&get(unit,'defensive'))m+=r('cyclonetech')*.12;
  if(cls==='wind'&&/Zephyr Palm|Cloudstep Kick|Chi Explosion(?! Cleave)|Rising Sun Kick/.test(label)&&get(unit,'comboMasteryReady'))m+=r('tigerdash')*.25;
  if(cls==='soul'&&/Essence Siphon|Chaos Bolt|Immolate/.test(label))m+=r('souldrain')*.04;
  if(cls==='soul'&&target){const afflictions=['soulScar','agony','unstableAffliction'].reduce((count,type)=>count+(get(target,type)?1:0),0);if(/Soul Scar|Creeping Torment|Unstable Affliction|Essence Siphon/.test(label))m+=afflictions*r('pandemic')*.03;}
  if(cls==='shadow'&&/Poison|Bleed|Garrote|Viper Cut|Internal Bleeding/.test(label))m+=r('shadow_poisoncraft')*.03;
  if(cls==='shadow'&&/Garrote|Internal Bleeding/.test(label))m+=r('garrote')*.04;
  if(cls==='shadow'&&r('shadow_gouge')>0)m+=.10;
  if(cls==='shadow'&&label==='Shadowstrike')m+=r('eviscerate')*.08;
  if(cls==='shadow'&&label==='Eviscerate')m+=r('eviscerate')*.12;
  if(cls==='disc'&&label==='Mind Spike')m+=.18;
  if(cls==='shadow'&&owned(get(target,'findWeakness'),unit)&&/Shadowstrike|Night Slash|Eviscerate/.test(label))m+=r('shadow_find_weakness')*.05;
  if(cls==='flame'&&/Living Bomb|Meteor/.test(label))m+=r('flame_living_flame')*.04;
  if(cls==='flame'&&/Meteor Lance|Ember Lance/.test(label))m+=r('flame_meteoric_precision')*.15;
  if(cls==='flame'&&label==='Cinder Bolt'&&get(unit,'instantBolt'))m+=r('flame_temporal_velocity')*.06;
  if(cls==='flame'&&label==='Cinder Bolt'&&get(unit,'prismaticFocus'))m+=r('flame_prismatic_focus')*.08;
  if(cls==='warrior'&&/Mortal Swing|Warbreaker|Slicing Winds/.test(label))m+=r('war_crushing_force')*.04;
  if(cls==='warrior'&&/Rend|Gushing Wound|Internal Bleeding/.test(label))m+=r('war_bloodletting')*.05;
  if(cls==='storm'&&/Arc Spark|Forked Current/.test(label)){m+=r('storm_conduction')*.03;if(owned(get(target,'lightningRod'),unit))m+=r('storm_supercell')*.03;if(get(unit,'elementalEquilibrium'))m+=r('storm_elemental_equilibrium')*.08;}
  if(cls==='wind'&&/Zephyr Palm|Cloudstep Kick|Chi Explosion(?! Cleave)|Rising Sun Kick/.test(label)){m+=Number(get(unit,'comboMomentum')?.stacks||0)*r('wind_hit_combo')*.03;if(get(unit,'comboMasteryReady'))m+=r('wind_meridian_strikes')*.10;}
  if(cls==='wind'&&/Fists of Fury|Hurricane Strikes|Cyclone Barrage/.test(label))m+=r('wind_jadefire_fists')*.05;
  if(cls==='soul'&&/Soul Scar|Creeping Torment|Unstable Affliction|Essence Siphon/.test(label))m+=r('soul_creeping_death')*.04;
  if(cls==='soul'&&/Essence Siphon/.test(label))m+=r('soul_malefic_grasp')*.05+Number(get(unit,'inevitableDemise')?.empowered||0);
  if(cls==='soul'&&label==='Chaos Bolt')m+=r('soul_ruin')*.05;
  if(cls==='soul'&&/Immolate/.test(label))m+=r('soul_demonfire')*.05;
  if(cls==='disc'&&/Smite|Solace|Penance/.test(label))m+=Math.min(3,[...state.units.values()].filter(u=>u.team===unit.team&&owned(get(u,'atonement'),unit)).length)*r('disc_many_sins')*.03;
  if(cls==='disc'&&/Mind Spike|Penance/.test(label))m+=r('disc_shadow_covenant')*.05;
  if(cls==='shadow'&&/Poison|Garrote|Internal Bleeding|Viper Cut|Rend/.test(label))m+=r('shadow_deadly_brew')*.04;
  if(cls==='shadow'&&owned(get(target,'vendetta'),unit)&&/Garrote|Internal Bleeding|Bleed|Rend/.test(label))m+=r('shadow_doomblade')*.03;
  if(cls==='shadow'&&/Shadowstrike|Eviscerate/.test(label))m+=r('shadow_deeper_daggers')*.05;
  if(cls==='shadow'&&get(unit,'controlledChaos'))m+=r('shadow_controlled_chaos')*.04;
  if(get(unit,'totemMastery')){m*=1.05/1.03;if(/Flame Shock/i.test(label))m*=1.10;}
  if(cls==='wind')m*=brew(unit);
  return Number.isFinite(m)&&m>0?m:1;
 }
 function talentHealing(unit){
  let m=1+nodes(unit.classId).reduce((sum,n)=>sum+rank(unit,n.id)*Number(n.effects?.healingPct||0)/100,0);
  if(unit.classId==='sage')m*=.90;if(unit.classId==='wind')m*=brew(unit);if(get(unit,'totemMastery'))m*=1.05/1.03;
  return m;
 }
 function gearMultiplier(unit,kind){
  const gear=unit.gearStats||{},primary=Number(gear.Intellect||0)+Number(gear.Agility||0)+Number(gear.Strength||0);
  return 1+Math.min(.30,Number(gear[kind]||0)*.00038)+primary*.00014+Number(gear.Versatility||0)*.00018;
 }
 function criticalChance(unit,base=.05){
  const holyShock=unit.classId==='pala'&&base>.05?rank(unit,'pala_radiant_shock')*.03:0;
  return Math.max(0,Math.min(base>.05?.95:.35,base+holyShock+Math.max(0,Number(unit.gearStats?.['Critical Strike']||0))*.00030));
 }
 function damageMultiplier(unit,target,label=''){
  const cls=unit.classId;
  let m=(cls==='soul'?.67068:cls==='disc'?1.30:cls==='storm'?.805:1)*talentDamage(unit,target,label)*gearMultiplier(unit,'Power');
  if(cls==='shadow'&&label!=='Night Slash')m*=1.10;
  if(get(unit,'darkArchangel'))m*=1.30;
  if(get(unit,'avatar'))m*=1.18;
  if(get(unit,'defensive')?.damagePenalty)m*=1-get(unit,'defensive').damagePenalty;
  if(get(unit,'crimsonVial'))m*=.75;
  if(get(unit,'totemMastery'))m*=1.03;
  if(get(unit,'avengingWings'))m*=1+Number(get(unit,'avengingWings').damageBonus||0);
  if(get(unit,'tigereye'))m*=1+Math.min(10,Number(get(unit,'tigereye').stacks||0))*.005;
  return m;
 }
 function healingMultiplier(unit,target,label=''){
  const cls=unit.classId;
  let m=talentHealing(unit)*gearMultiplier(unit,'Restoration');
  if(cls==='sage'&&target.hp/target.maxHp<.45)m*=1+rank(unit,'wildgrowth')*.04;
  if(cls==='sage'&&/Blooming Echo|Rejuvenate|Lifebloom|Dream Breath|Healing over Time/i.test(label))m*=1+rank(unit,'sage_verdant_tempo')*.03;
  if(cls==='soul'&&/Essence Siphon/i.test(label))m*=1+rank(unit,'drainrite')*.04;
  if(cls==='pala'&&/Holy Shock|Divine Toll|Light of Dawn/i.test(label))m*=1+rank(unit,'radiance')*.04;
  if(['sage','pala','disc'].includes(cls)){m*=1.15;if(state.mode==='3v3')m*=1.20;}
  if(cls==='pala')m*=1.16;if(cls==='sage')m*=1.045;
  if(get(unit,'totemMastery'))m*=1.03;
  if(get(unit,'avengingWings'))m*=1.20;
  if(get(target,'ironbark'))m*=1.20;
  if(get(unit,'ghanir')&&['Blooming Echo','Rejuvenate','Lifebloom','Dream Breath'].includes(label))m*=1.50;
  // healAtonements applies this before Game.heal in the offline pipeline.
  if(get(unit,'archangel')&&/Atonement/.test(label))m*=1.30;
  return m;
 }
 return {talentDamage,talentHealing,gearMultiplier,criticalChance,damageMultiplier,healingMultiplier};
}
