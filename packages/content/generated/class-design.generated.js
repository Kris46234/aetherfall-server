/* Shared class design and pure talent decisions. The generator copies this file
   into the authoritative bundle; combat engines provide effect/resource adapters. */
(function(root){
 const node=(id,name,icon,lane,req,desc,max=1)=>({id,name,icon,talentLane:lane,req,desc,max,x:lane==='left'?20:lane==='right'?80:50,y:90});
 const nodes={
  disc:[
   node('disc_shadow_word_pain','Shadow Word: Pain','🕯️','core',['disc_evangelism'],'Replaces Solace. Apply a 12 sec Shadow damage effect. Every 2 sec it deals 36 damage and triggers 28 Atonement healing. Applying it restores 4 mana, at most once every 6 sec. Solace of the Light also increases this return. You can maintain it on several enemies.'),
   node('disc_guiding_grace','Guiding Grace','🕊️','left',['disc_penitent_shelter'],'Penance cast on an ally heals for 15% more. Each bolt that restores health extends your existing Atonement on that ally by 1 sec, up to 17 sec. Does not apply Atonement to an unmarked ally.'),
   node('disc_radiant_purpose','Radiant Purpose','🌠','left',['disc_enduring_covenant'],'Ultimate Radiance increases all healing through your Atonement by 15% for 6 sec. The window begins after Radiance resolves and cannot stack.'),
   node('disc_painkeeper','Painkeeper','🕯️','right',['disc_painful_revelation'],'Smite and Mind Spike extend your active Shadow Word: Pain on their target by 2 sec, up to 12 sec. Can occur once every 3 sec across all targets; never applies a missing effect.'),
   node('disc_umbral_reprieve','Umbral Reprieve','🌒','right',['disc_painkeeper'],'Consuming Painful Revelation with Smite or Mind Spike prepares a Shadow Mend with a 40% shorter cast time for 8 sec. Can occur once every 10 sec; the preparation is consumed when Shadow Mend finishes.')
  ],
  wind:[node('wind_chi_explosion','Chi Explosion','💠','left',['tigerdash'],'Replaces Cloudstep Kick with an 8m Chi Explosion. Palm and your major attacks build up to 4 Chi. Consume all Chi for 90 damage plus 56 per Chi. At 3+ Chi, nearby enemies take 50% damage. At 4 Chi, gain 2 Tigereye stacks. No new button.'),node('wind_hurricane_strikes','Hurricane Strikes','🌪️','right',['cyclonetech'],'Replaces Fists of Fury. Channel four rushing strikes over 1.6 sec while moving at full speed. Each deals 115 damage to your chosen enemy within 8m, and 40% to nearby enemies. Landing the final strike grants 2 Chi. Can be interrupted by crowd control.')],
  storm:[node('storm_elemental_cycle','Elemental Rhythm','⚡','core',['overloadpath'],'Alternating normal Arc Spark and Forked Current within 8 sec generates 10 additional Maelstrom. At 100 Maelstrom, Storm Surge prepares two instant Tempest Bolts and an empowered Forked Current. Spend both rewards before building again.'),node('storm_lava_surge','Molten Feedback','🌋','left',['storm_lava_burst'],'Land a normal Arc Spark and Forked Current within 8 sec to prepare one Volcanic Eruption, if its cooldown is ready. No Shock is required. Empowered bolts and repeated Shocks cannot trigger this effect.')],
sage:[node('sage_swiftmend','Flourishing Mend','🌺','left',['wildgrowth'],'Replaces Renewal Tide with Swiftmend: an 18 sec recovery spell. Heal for 380, plus four ticks of one of your HoTs on the target, shortening that HoT by 4 sec. Empowers your next Verdant Mend just like Renewal Tide. Nature Swiftness lets you use Swiftmend once while it is on cooldown.'),node('sage_dream_echo','Dream Echo','🦋','right',['barkskin'],'Replaces Blooming Echo. Place an 8 sec Echo on an ally. Your next Verdant Mend, Renewal Tide or Swiftmend copies 45% of its base healing to each other Echo ally within 28m and line of sight, consuming those Echoes. Echo does not repeat itself.'),node('sage_emerald_flight','Emerald Flight','🪽','core',['sagepath'],'Fae Retreat prepares an instant Verdant Mend for 6 sec. Heal while repositioning instead of planting your feet.'),node('sage_dream_breath','Dream Breath','🦋','right',['barkskin'],'Replaces Spirit Blossom. Cast for 1.2 sec while moving and jumping, healing you and allies in a 16m, 100° cone for 195, then 52 each second for 6 sec. The cone follows your selected ally and is shown while casting. 18 sec cooldown; interrupts and line of sight still apply.'),node('sage_lifebloom','Lifebloom','🌼','left',['sage_rejuvenate'],'Replaces Rejuvenate. Heal for 35, then 32 each second for 10 sec. When the effect expires, it blossoms for 180 healing. Only one ally can carry your Lifebloom. Refreshing or moving it does not trigger the blossom; Swiftmend consumes it to blossom immediately.'),node('sage_cleansing_growth','Cleansing Growth','🍃','core',['cleanhands'],'Successfully dispelling an ally with Purifying Light extends your active healing-over-time effects on them by 2 sec, up to each effect’s normal duration. Does not apply missing effects.')],
  shadow:[
   node('shadow_dance_mastery','Dance of Daggers','🌘','right',['eviscerate'],'Replaces Smoke Veil with a 6 sec Shadow Dance. Shadowstrike has no cooldown, costs 14 Energy and generates 2 techniques. During Dance, press this button again for repeatable Cheap Shots; normal stun diminishing returns apply. Eviscerate extends Dance by 0.75 sec, up to 3 sec. 30 sec cooldown. Neither action triggers the global cooldown.'),
   node('shadow_sanguine_blades','Sanguine Blades','🩸','left',['garrote'],'Viper Cut on a target with your Garrote extends Garrote and Internal Bleeding by 2 sec, up to their original durations. Poison/bleed ticks reduce Vendetta cooldown by 0.25 sec, at most once each second.'),
   node('shadow_venomous_vigor','Venomous Vigor','🦂','left',['garrote'],'Your poison damage against an enemy affected by your bleed restores 2 Energy. Can occur once every 1 sec across all targets.'),
   node('shadow_toxic_opportunity','Toxic Opportunity','☠️','left',['shadow_venomous_vigor'],'Your poison damage against an enemy affected by your bleed has a 20% chance to reset Viper Cut and empower it for 10 sec. The empowered strike costs no Energy and deals 25% more direct damage. Can occur once every 10 sec; does not stack.'),
   node('shadow_deathmark','Deathmark','🎯','left',['shadow_shadowstep'],'Vendetta refreshes your existing Viper Cut poison, Garrote and Internal Bleeding on its target to their full durations. Does not apply missing effects.'),
   node('shadow_twisting_knife','Twisting Knife','🗡️','left',['shadow_deathmark'],'Shiv extends your active Vendetta on its target by 2 sec. Each Vendetta can be extended once. Requires Shiv to trigger.'),
   node('shadow_followthrough','Predatory Rhythm','⚔️','right',['eviscerate'],'Eviscerate empowers your next Shadowstrike within 6 sec to deal 20% more damage and cost 6 less Energy. This effect does not stack.'),
   node('shadow_echoing_strikes','Echoing Strikes','👥','right',['eviscerate'],'Shadowstrike has a 20% chance to generate one additional Shadow Technique and reduce Umbral Pounce cooldown by 2 sec. Can occur once every 5 sec. Techniques cannot exceed three.'),
   node('shadow_deepening_shadows','Deepening Shadows','🌑','right',['shadow_dance_mastery'],'Eviscerate reduces Shadow Dance cooldown by 2 sec. Can occur once every 1 sec.'),
   node('shadow_shadowed_finish','Shadowed Finish','💀','right',['shadow_find_weakness'],'Eviscerate deals 12% more damage to stunned enemies. Cheap Shot and Ribbreaker can create this opportunity, subject to normal stun diminishing returns.')
  ],
  warrior:[node('war_execution_sentence','Execution Sentence','💀','left',['executioner'],'Mortal Swing deals 12% more damage below 25% enemy health and restores 4 Rage. Does not add another ability.')],
  flame:[node('flame_controlled_burn','Controlled Burn','🔥','left',['meteorimpact'],'Ember Lance on your Living Bomb reduces Combustion cooldown by 2 sec, at most once every 2 sec.')],
  soul:[node('soul_haunting_echo','Haunting Echo','👻','core',['cursepath'],'Fear prepares your next Essence Siphon tick to heal 25% more. Applies to Affliction and Chaos builds; the bonus is consumed by one tick.')],
  pala:[node('pala_hallowed_return','Hallowed Return','🕯️','core',['palpath'],'Successfully cleansing crowd control reduces Holy Shock cooldown by 2 sec and restores 2 mana.')]
 };
 const replacements={
  sage_dream_breath:{from:'Spirit Blossom',name:'Dream Breath',icon:'🦋',type:'spiritBlossom',school:'nature',range:16,cast:1.2,cd:18,cost:10,value:195,tickValue:52,moveCast:true,tip:'Breathe restorative mist toward your selected ally. Heal yourself and allies in a 16m, 100° cone for 195, then 52 each second for 6 sec. Cast while moving and jumping; interrupts still stop the spell. The cone shows which area will be healed. Requires line of sight. Replaces Spirit Blossom.'},
  sage_lifebloom:{from:'Rejuvenate',name:'Lifebloom',icon:'🌼',type:'hot',school:'nature',range:28,cast:0,cd:0,cost:8,value:35,tickValue:32,bloomValue:180,tip:'Heal an ally for 35, then 32 each second for 10 sec. On expiry, bloom for 180 healing. Only one ally can carry your Lifebloom. Refreshing or moving it does not trigger the bloom. Swiftmend consumes it to bloom immediately. Replaces Rejuvenate.'},
  wind_chi_explosion:{from:'Cloudstep Kick',name:'Chi Explosion',icon:'💠',type:'chiExplosion',school:'wind',range:8,cast:0,cd:6,cost:20,value:90,tip:'Consume up to 4 Chi to deal 90 damage plus 56 per Chi. At 3+ Chi, enemies within 5m take 50% damage. At 4 Chi, gain 2 Tigereye Brew stacks. Zephyr Palm, Rising Sun Kick and Strike of the Windlord generate Chi. Replaces Cloudstep Kick.'},
  wind_hurricane_strikes:{from:'Fists of Fury',name:'Hurricane Strikes',icon:'🌪️',type:'hurricaneStrikes',school:'wind',range:8,cast:1.6,cd:18,cost:18,value:115,tip:'Channel four strikes over 1.6 sec while moving at full speed. Each strikes your selected enemy within 8m for 115 damage and nearby enemies for 40% damage. The final strike grants 2 Chi. Crowd control stops the channel. Press again to cancel.'},
  disc_shadow_word_pain:{from:'Solace',name:'Shadow Word: Pain',icon:'🕯️',type:'discPain',school:'shadow',range:25,cast:0,cd:0,cost:0,value:36,atonementHeal:28,tip:'Afflict an enemy for 12 sec, dealing 36 Shadow damage and triggering 28 Atonement healing every 2 sec. Applying it restores 4 mana, at most once every 6 sec. Solace of the Light also increases this return. Selecting an ally attacks that ally’s selected enemy.'},
  sage_swiftmend:{from:'Renewal Tide',name:'Swiftmend',icon:'🌺',type:'swiftmend',school:'nature',range:28,cast:0,cd:18,cost:6,value:380,tip:'Restore 380 health, plus four ticks of one of your healing-over-time effects on this ally, shortening that effect by 4 sec. Empowers your next Verdant Mend by 150%. Nature Swiftness lets you use this once while it is on cooldown.'},
  sage_dream_echo:{from:'Blooming Echo',name:'Dream Echo',icon:'🦋',type:'dreamEcho',school:'nature',range:28,cast:0,cd:0,cost:3,value:42,tip:'Heal an ally for 42 and leave an Echo for 8 sec. Your next Verdant Mend, Renewal Tide or Swiftmend copies 45% of its base healing to each other Echo ally within 28m and line of sight, consuming the marks.'}
 };
 function replace(cls,talents,input){
  let a={...input};
  if(cls==='shadow'&&(a.type==='shadowStrike'||['Smoke Veil','Shadow Dance','Cheap Shot'].includes(a.name)))a={...a,offGlobal:true,canUseWhileCasting:true};
  if(cls==='shadow'&&a.type==='shadowStrike'&&!String(a.tip||'').includes('global cooldown'))a.tip=(a.tip||'')+' Does not trigger the global cooldown.';
  if(cls==='shadow'&&a.name==='Smoke Veil')a.tip='Vanish and gain 10% increased damage for 8 sec. This button becomes Cheap Shot for one optional 3 sec stun during Veiled Assault. Your attacks do not stun automatically. Your next Ribbreaker deploys Smoke Bomb. Attacking breaks stealth, but does not end Veiled Assault. Neither action triggers the global cooldown.';
  if(cls==='wind'&&a.name==='Zephyr Palm')a.tip='Strike for 50 damage. Landing Zephyr Palm after a different damaging ability grants one Flow. At three Flow, your next Palm becomes Rising Sun Kick, dealing 271 damage for 12 Energy. Repeating Palm does not generate more Flow. With Chi Explosion, each Palm also generates one Chi.';
  if(cls==='wind'&&a.name==='Cloudstep Kick')a={...a,value:165,cost:18,tip:'Kick an enemy for 165 damage. Every 20 sec, become Cloudstep Dash: rush up to 17m and deal 20% more damage. With Combo Master, following a different primary attack prepares a Rising Sun Kick with 12% more damage at half Energy cost for 8 sec, once every 8 sec. Repeating Cloudstep does not trigger this reward.'};
  if(cls==='warrior'&&a.name==='Mortal Swing')a.tip='Strike for 104 Physical damage. Pummel and Warbreaker empower this attack; consuming Warbreaker triggers three Slicing Winds. Battle Trance: Mortal Swings against your Rend target have a 25% chance to reset Rend and prepare Gushing Wound for 8 sec. This can occur once every 10 sec.';
  if(cls==='storm'&&a.type==='volcanicEruption')a={...a,school:'fire',cast:0,cd:12,value:280,offGlobal:true,tip:'Consume one charge to launch 280 Fire damage, followed by two 40-damage embers. Skybreaker Pulse or Molten Feedback prepares a charge for 10 sec. Can be used between spells or during a cast without interrupting it. 12 sec cooldown.'};
  if(cls==='storm'&&a.name==='Arc Spark')a.tip='Deal 124 Storm damage, restore 4 mana and generate 25 Maelstrom. At 100 Maelstrom, gain two instant Tempest Bolts and an empowered Forked Current. Each Tempest Bolt hit reduces Forked Current cooldown by 1 sec; landing both prepares your next normal Arc Spark to cast 40% faster within 8 sec. Stormkeeper bolts create Lightning Rod instead of Maelstrom.';
  if(cls==='storm'&&a.name==='Forked Current')a.tip='Deal 132 Storm damage and arc to up to two enemies within 8m. Generate 35 Maelstrom once per cast. Storm Surge empowers one cast by 35% and launches three Lava Bursts at visible enemies. Restore 6 mana, or 10 when empowered. Each Tempest Bolt hit reduces this spell’s remaining cooldown by 1 sec.';
  if(cls==='storm'&&a.name==='Wind Shear')a={...a,offGlobal:true,canUseWhileCasting:true,tip:'Interrupt an enemy cast from up to 25m away and lock its spell school for 2.5 sec. Can be used during your own cast without interrupting it or triggering the global cooldown. A successful interrupt activates Aftershock if learned.'};
  if(cls==='storm'&&a.name==='Gale Reversal')a.tip='Blast all enemies within 9m backwards and slow them by 40% for 3 sec. Enemies behind cover or immune to knockbacks are unaffected. If no enemy is nearby, leap backwards instead.';
  if(cls==='storm'&&a.name==='Totem Mastery')a.tip='Place empowering totems for 20 sec. Increase damage, healing and shields by 5%, generate 5 additional Maelstrom per normal Arc Spark or Forked Current, and increase Flame Shock damage by 10%.';
  if(cls==='disc'&&['discSmite','discSolace'].includes(a.type)&&!String(a.tip||'').includes('selected enemy'))a.tip=(a.tip||'')+' Selecting an ally attacks that ally’s selected enemy.';
  if(cls==='wind'&&a.name==='Tigereye Brew')a.tip='Alternate successful damaging abilities to build up to 6 stacks. Repeating the same attack does not grant another stack. Consume 2, 4 or 6 stacks for 10%, 20% or 30% more damage and healing for 6 sec.';
  if(cls==='wind'&&Number(talents?.wind_hurricane_strikes)>0&&a.type==='whirlingDragonPunch')a.tip=String(a.tip||'').replaceAll('Fists of Fury','Hurricane Strikes');
  for(const [id,spec] of Object.entries(replacements))if(Number(talents?.[id])>0&&(a.name===spec.from||a.name===spec.name))a={...a,...spec};
  if(cls==='sage'&&a.name==='Swiftmend'&&Number(talents?.sage_lifebloom)>0)a.tip='Restore 380 health and empower your next Verdant Mend by 150%. If your Lifebloom is present, consume it to trigger its 180 healing bloom. Otherwise, add four ticks of one of your HoTs and shorten it by 4 sec. Nature Swiftness permits one use during cooldown.';
  if(cls==='sage'&&a.type==='ghanir')a.tip='For 7 sec, Blooming Echo, Rejuvenate, Lifebloom and Dream Breath heal for 50% more and their periodic effects tick twice as often. Their remaining durations are unchanged.';
  if(cls==='storm'&&a.name==='Flame Shock')a={...a,cd:6,tip:'Burn an enemy for 34 Fire damage each second for 12 sec. You do not need this effect to trigger Storm Surge. Icefury replaces this button with Frost Shock instead of adding another Shock.'};
  if(cls==='storm'&&Number(talents?.storm_grounding_aegis)>0&&['Flame Shock','Frost Shock'].includes(a.name))a={...a,from:'Flame Shock',name:'Frost Shock',icon:'❄️',type:'frostShock',school:'storm',range:25,cast:0,cd:6,cost:1,value:90,tip:'Deal 90 Frost damage and slow by 25% for 3 sec, subject to snare diminishing returns. Your Arc Spark and Forked Current deal 10% more damage to this target for 8 sec. Replaces Flame Shock; both never occupy separate buttons.'};
  if(cls==='shadow'&&a.name==='Smoke Veil'&&Number(talents?.shadow_dance_mastery)>0)a={...a,from:'Smoke Veil',name:'Shadow Dance',cd:30,tip:'Enter Shadow Dance for 6 sec. Shadowstrike has no cooldown, costs 14 Energy and builds 2 techniques. Eviscerate extends Dance by 0.75 sec, up to 3 sec. Press this button again for repeatable 3 sec Cheap Shots during Dance, subject to stun diminishing returns. Gain 10% increased damage for 8 sec and prepare Smoke Bomb on your next Ribbreaker. Neither Dance nor Cheap Shot triggers the global cooldown; normal attacks never stun automatically.'};
  return a;
 }
 // Shared combat decisions; adapters only translate offline/authoritative storage.
 const shadowTalents={
  followupMode(api,c){
   if(api.get(c,'shadowDance'))return 'dance';
   return !api.rank(c,'shadow_dance_mastery')&&api.get(c,'cheapReady')&&api.get(c,'smokePower')?'veil':null;
  },
  modifyAbility(api,c,a){
   // A temporary follow-up shares its parent's identity/slot, not its cooldown.
   // Both engines derive this from authoritative effects, never a client flag.
   const followup=this.followupMode(api,c);
   if(['Smoke Veil','Shadow Dance'].includes(a.name)&&followup)return {...a,from:a.from||a.name,name:'Cheap Shot',icon:'🔪',type:'cheapShot',school:'physical',range:4.8,cast:0,castTime:0,cd:0,cooldown:0,cost:0,value:0,baseValue:0,offGlobal:true,canUseWhileCasting:true,cheapFollowup:true,ignoreCooldown:true,tip:'Stun an enemy for 3 sec without triggering the global cooldown. Shares diminishing returns with Ribbreaker. '+(followup==='dance'?'Can be pressed repeatedly during Shadow Dance; its original cooldown continues in the background.':'Consumes your single Veiled Assault follow-up; Smoke Veil returns with its remaining cooldown.')+' Normal attacks never trigger this stun.'};
   if(a.type==='shadowStrike'&&api.get(c,'predatoryRhythm'))a={...a,cost:Math.max(0,a.cost-6)};
   if(a.name==='Viper Cut'&&api.get(c,'toxicOpportunity'))a={...a,cost:0};
   return a;
  },
  damageMultiplier(api,c,t,label){
   if(label==='Shadowstrike'&&api.get(c,'predatoryRhythm'))return 1.20;
   if(label==='Viper Cut'&&api.get(c,'toxicOpportunity'))return 1.25;
   if(label==='Eviscerate'&&api.rank(c,'shadow_shadowed_finish')&&['stun','cheapStun','furyStun'].some(k=>api.get(t,k)))return 1.12;
   return 1;
  },
  techniques(api,c){
   let gain=api.get(c,'shadowDance')?2:1;
   if(api.rank(c,'shadow_echoing_strikes')&&!api.get(c,'shadowEchoLock')&&api.random()<.20){gain++;api.add(c,'shadowEchoLock',5);api.reduce(c,'pounce',2);api.proc(c,'ECHOING STRIKES');}
   // A banked finisher is never overwritten by another generator.
   if(api.get(c,'eviscerateReady'))return;
   const stacks=Math.min(3,Number(api.get(c,'shadowTechnique')?.stacks||0)+gain);
   api.remove(c,'shadowTechnique');
   if(stacks>=3){api.add(c,'eviscerateReady',10);api.proc(c,'EVISCERATE READY');}
   else api.add(c,'shadowTechnique',8,{stacks});
  },
  onHit(api,c,t,label,periodic){
   if(label==='Shadowstrike')api.remove(c,'predatoryRhythm');
   if(label==='Viper Cut')api.remove(c,'toxicOpportunity');
   if(label==='Eviscerate'){
    if(api.rank(c,'shadow_followthrough')){api.add(c,'predatoryRhythm',6);api.proc(c,'PREDATORY RHYTHM');}
    if(api.rank(c,'shadow_deepening_shadows')&&!api.get(c,'deepeningLock')){api.reduce(c,'veil',2);api.add(c,'deepeningLock',1);}
   }
   if(label==='Shiv'&&api.rank(c,'shadow_twisting_knife')){
    const mark=api.effects(t).find(e=>e.type==='vendetta'&&api.owned(e,c));
    if(mark&&!mark.twisted){api.setTime(mark,api.time(mark)+2);mark.twisted=true;}
   }
   if(!periodic||!/Poison/i.test(label)||!api.effects(t).some(e=>e.type==='bleed'&&api.owned(e,c)&&api.time(e)>0))return;
   if(api.rank(c,'shadow_venomous_vigor')&&!api.get(c,'venomVigorLock')){api.energy(c,2);api.add(c,'venomVigorLock',1);}
   if(api.rank(c,'shadow_toxic_opportunity')&&!api.get(c,'toxicOpportunity')&&!api.get(c,'toxicOpportunityLock')&&api.random()<.20){
    api.reduce(c,'viper',99);api.add(c,'toxicOpportunity',10);api.add(c,'toxicOpportunityLock',10);api.proc(c,'TOXIC OPPORTUNITY');
   }
  },
  onVendetta(api,c,t){
   if(!api.rank(c,'shadow_deathmark'))return;
   for(const e of api.effects(t))if(api.owned(e,c)){
    if(e.type==='poison'||(e.type==='bleed'&&e.label==='Garrote'))api.setTime(e,8);
    else if(e.type==='bleed'&&e.label==='Internal Bleeding')api.setTime(e,6);
   }
  }
 };
 // Geometry is shared so both engines heal the exact same cone at resolution.
 const lifesage={
  breathYaw(source,target){
   const dx=(target?.x??source.x)-source.x,dz=(target?.z??source.z)-source.z;
   return Math.hypot(dx,dz)>.1?Math.atan2(dx,dz):Number(source.facing??source.mesh?.rotation?.y??0);
  },
  breathRayDistance(source,yaw,obstacles,range=16,clearance=.18){
   const dx=Math.sin(yaw),dz=Math.cos(yaw);let reach=range;
   for(const p of obstacles||[]){
    const x=p.x-source.x,z=p.z-source.z,r=Number(p.r??p.radius??0)+clearance,along=x*dx+z*dz,side=x*x+z*z-along*along;
    if(side>=r*r||along+r<0)continue;
    const entry=along-Math.sqrt(Math.max(0,r*r-side));
    if(entry>=0)reach=Math.min(reach,entry);else if(x*x+z*z<r*r)reach=0;
   }
   return Math.max(0,reach);
  },
  inBreath(source,target,ally,range=16){
   if(!ally?.alive||ally.team!==source.team)return false;
   const dx=ally.x-source.x,dz=ally.z-source.z,d=Math.hypot(dx,dz);
   if(d>range)return false;if(d<.01)return true;
   const facing=this.breathYaw(source,target),fx=Math.sin(facing),fz=Math.cos(facing);
   return (dx*fx+dz*fz)/d>=Math.cos(50*Math.PI/180);
  },
  extension(time,label){return Math.max(time,Math.min(label==='Lifebloom'?10:label==='Dream Breath'?6:12,Math.max(0,time)+2));}
 };
 // One rotation state machine for both engines. Only successful primary hits
 // enter here; a short Fork gate prevents cleave from granting extra resources.
 const stormRotation={
  displace(unit,dx,dz,distance,constrain){
   // Check the travelled path, not only the landing point: a knockback must
   // never tunnel through a pillar that happens to sit between its endpoints.
   const steps=Math.ceil(distance/.25),step=distance/Math.max(1,steps);
   for(let i=0;i<steps;i++){unit.x+=dx*step;unit.z+=dz*step;constrain(unit);}
  },
  onBuilder(api,c,label){
   if(!['Arc Spark','Forked Current'].includes(label))return;
   if(label==='Forked Current'){
    if(api.get(c,'stormForkGate'))return;
    api.add(c,'stormForkGate',.5);
   }
   if(api.rank(c,'storm_lava_surge')&&!api.get(c,'volcanicEruptionReady')&&api.eruptionReady(c)){
    const own=label==='Arc Spark'?'moltenSpark':'moltenFork',other=label==='Arc Spark'?'moltenFork':'moltenSpark';
    if(api.get(c,other)){
     api.remove(c,own);api.remove(c,other);api.remove(c,'moltenFeedbackReady');
     api.add(c,'volcanicEruptionReady',10);api.proc(c,'eruption');
    }else api.add(c,own,8);
   }
   if(api.get(c,'tempestBolts')||api.get(c,'overload'))return;
   const last=api.get(c,'stormRhythmLast'),alternating=last&&last.label!==label;
   const amount=(label==='Arc Spark'?25+2*api.rank(c,'surgeflow'):35)+(api.get(c,'totemMastery')?5:0)+(alternating&&api.rank(c,'storm_elemental_cycle')?10:0);
   api.add(c,'stormRhythmLast',8,{label});
   const total=Number(api.get(c,'maelstrom')?.stacks||0)+amount;
   api.add(c,'maelstrom',30,{stacks:total%100});
   if(total>=100){
    api.remove(c,'stormChance');api.remove(c,'stormRhythmLast');
    api.add(c,'tempestBolts',10,{stacks:2});api.add(c,'overload',10);
    api.resource(c,10+api.rank(c,'storm_arc_battery'));api.proc(c,'surge');
   }
  }
 };
 root.AETHER_CLASS_DESIGN={nodes,replacements,replace,shadowTalents,lifesage,stormRotation};
})(globalThis);
