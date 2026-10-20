/* Branch expansion: shared, deterministic combat decisions for offline and online.
   Engines adapt state access; this module never deals secondary damage or healing. */
(function(root){
 'use strict';
 const node=(id,name,icon,lane,req,desc)=>({id,name,icon,talentLane:lane,req,desc,max:1,x:lane==='left'?20:80,y:90});
 const nodes={
  flame:[
   node('flame_ashen_reservoir','Ashen Reservoir','🔥','left',['meteorimpact'],'Your periodic Fire damage gathers Ash, once each second. At four Ash, your next Ember Lance within 8 sec deals 18% more damage and costs 3 less mana. Ash lasts 20 sec; the empowerment cannot stack.'),
   node('flame_falling_star','Falling Star','☄️','left',['flame_ashen_reservoir'],'Meteor striking an enemy already affected by your burn or Living Bomb prepares a free, instant Cinder Bolt for 8 sec. Can occur once every 12 sec, regardless of enemies hit.'),
   node('flame_pyric_cadence','Pyric Cadence','🌋','left',['meteorimpact'],'After Ember Lance hits, landing Cinder Bolt within 6 sec reduces Meteor cooldown by 2 sec. Can occur once every 6 sec.'),
   node('flame_flashfire','Flashfire','✨','right',['counterheat'],'Blazing Step makes your next Ember Lance within 6 sec cost no mana and deal 12% more damage. Can occur once every 8 sec.'),
   node('flame_temporal_weave','Temporal Weave','⏳','right',['flame_flashfire'],'Landing Cinder Bolt followed by Ember Lance within 6 sec reduces Blazing Step cooldown by 2 sec. Can occur once every 6 sec.'),
   node('flame_borrowed_flame','Borrowed Flame','🔶','right',['counterheat'],'Alter Time prepares two Cinder Bolts with 25% shorter cast times for 10 sec. Can occur once every 20 sec; returning through Alter Time does not grant another pair.')
  ],
  soul:[
   node('soul_lingering_misery','Lingering Misery','🕯️','left',['pandemic'],'Essence Siphon against an enemy with your Soul Scar, Creeping Torment and Unstable Affliction extends each by 1 sec, up to 15 sec. Can occur once every 3 sec across all targets.'),
   node('soul_nightfall','Nightfall','🌑','left',['soul_lingering_misery'],'Every six damaging ticks of Soul Scar, Creeping Torment or Unstable Affliction prepare a free, instant Unstable Affliction for 10 sec. Only one tick counts each second; progress lasts 20 sec.'),
   node('soul_malignant_bloom','Malignant Bloom','🧫','left',['soul_pandemic_bloom'],'Your periodic afflictions gather up to three Malice, once each second. Each stack increases your next Pandemic Bloom by 8%. Malice lasts 12 sec and is consumed when the spell hits.'),
   node('soul_roaring_embers','Roaring Embers','🔥','right',['soul_void_mend'],'Chaos Bolt extends your Immolate on its target by 3 sec, up to 12 sec. Can occur once every 6 sec. Does not apply Immolate to an unburned enemy.'),
   node('soul_cinderwake','Cinderwake','💚','right',['soul_roaring_embers'],'Every three damaging Immolate ticks prepare your next Chaos Bolt with a 20% shorter cast time for 10 sec. Only one tick counts each second. This empowerment cannot stack.'),
   node('soul_siphoned_flame','Siphoned Flame','🟢','right',['soul_void_mend'],'Essence Siphon against your Immolate empowers your next Immolate within 8 sec: its initial hit deals 25% more damage and costs no mana. Can occur once every 8 sec; periodic damage is unchanged.')
  ],
  disc:[
   node('disc_luminous_devotion','Luminous Devotion','✦','left',['disc_evangelism'],'Three effective Atonement heals prepare your next Power Shield at 50% reduced mana cost for 8 sec. Only one heal counts each second, regardless of allies healed. Progress lasts 20 sec.'),
   node('disc_penitent_shelter','Penitent Shelter','🪽','left',['disc_luminous_devotion'],'Power Shield empowers Penance damage and Penance Atonement healing by 12% for 6 sec. Can occur once every 10 sec; all bolts within the window benefit.'),
   node('disc_enduring_covenant','Enduring Covenant','🕊️','left',['disc_evangelism'],'When Shadow Mend restores health, the Atonement it applies lasts 3 sec longer, up to 17 sec. Can occur once every 6 sec across all allies.'),
   node('disc_painful_revelation','Painful Revelation','🕯️','right',['disc_shadow_word_pain'],'Every three damaging Shadow Word: Pain ticks prepare a free Smite or Mind Spike with a 30% shorter cast time for 8 sec. Only one tick counts each second. Progress lasts 20 sec.'),
   node('disc_twilight_reparation','Twilight Reparation','🌓','right',['disc_evangelism'],'Shadow Mend opens a 6 sec opportunity: your next Smite or Mind Spike prepares a Shadow Mend with 20% increased healing for 8 sec. Can prepare this healing bonus once every 8 sec.'),
   node('disc_duality','Duality','⚖️','right',['disc_twilight_reparation'],'Alternate direct Holy damage from Smite, Solace or Penance with Shadow damage from Mind Spike or Shadow Word: Pain. Completing the pair within 6 sec restores 3 mana, at most once every 4 sec.')
  ],
  wind:[
   node('wind_threefold_path','Threefold Path','☯️','left',['tigerdash'],'Land three different primary attacks within 8 sec to empower your next Zephyr Palm or Rising Sun Kick: it costs no Energy and deals 20% more damage for 8 sec. Channel ticks and secondary hits do not count. Can occur once every 12 sec.'),
   node('wind_sunrise_return','Sunrise Return','🌅','left',['tigerdash'],'After Rising Sun Kick, Cloudstep Kick or Chi Explosion within 6 sec reduces Fists of Fury or Hurricane Strikes cooldown by 2 sec. Can occur once every 8 sec.'),
   node('wind_jade_reservoir','Jade Reservoir','🍃','right',['cyclonetech'],'The first damaging hit of Fists of Fury or Hurricane Strikes restores 6 Energy. Can occur once every 12 sec across all targets.'),
   node('wind_willow_counter','Willow Counter','🥊','right',['wind_jade_reservoir'],'Willow Guard empowers Fists of Fury and Hurricane Strikes damage by 12% for 6 sec. All strikes within the window benefit.')
  ],
  storm:[
   node('storm_closed_circuit','Closed Circuit','⚡','left',['lavacore'],'Two Arc Sparks striking your Lightning Rod prepare your next Forked Current to deal 20% more damage for 8 sec. Only one Arc Spark counts each second. Progress lasts 12 sec.'),
   node('storm_rolling_thunder','Rolling Thunder','⛈️','left',['storm_closed_circuit'],'Forked Current hitting your Lightning Rod restores 3 mana and reduces Stormkeeper cooldown by 1 sec. Can occur once every 4 sec, regardless of enemies hit.'),
   node('storm_stone_to_sky','Stone to Sky','🪨','right',['grounded'],'Healing Surge prepares your next Arc Spark within 8 sec to cost no mana, cast 40% faster and deal 15% more damage. Can occur once every 8 sec.'),
   node('storm_earths_answer','Earth’s Answer','💧','right',['grounded'],'Four damaging Arc Sparks or Forked Currents prepare Healing Surge with 40% reduced mana cost and 20% increased healing for 8 sec. Only one hit counts each second. Progress lasts 20 sec; the empowerment cannot stack.')
  ],
  sage:[
   node('sage_grove_cadence','Grove Cadence','🌿','left',['wildgrowth'],'Three effective periodic heals from your HoTs or Spirit Blossom prepare your next Verdant Mend: 20% shorter cast time and 25% increased healing for 8 sec. Only one heal counts each second. Can occur once every 10 sec.'),
   node('sage_canopy_cycle','Canopy Cycle','🌳','left',['sage_grove_cadence'],'Effective Verdant Mend healing on an ally carrying two different healing-over-time effects from you reduces Spirit Blossom or Dream Breath cooldown by 2 sec. Can occur once every 4 sec.'),
   node('sage_lucid_reservoir','Lucid Reservoir','🦋','right',['barkskin'],'A direct heal that overheals by at least 1% of the target’s maximum health stores one Lucid charge, once each second. Up to three charges increase your next Renewal Tide or Swiftmend by 10% each. Charges last 12 sec.'),
   node('sage_fae_bloom','Fae Bloom','🌺','right',['barkskin'],'Fae Retreat prepares a free Blooming Echo or Dream Echo for 6 sec. Its initial healing is increased by 30%; periodic healing is unchanged. Can occur once every 8 sec.')
  ],
  pala:[
   node('pala_beacon_mercy','Beacon’s Mercy','🕯️','left',['guardianlight'],'Effective Holy Light healing on your Beacon prepares your next Holy Shock with 20% increased healing and 50% reduced mana cost for 8 sec. Can occur once every 10 sec.'),
   node('pala_lasting_light','Lasting Light','🪽','left',['pala_beacon_mercy'],'Effective Holy Shock healing on your Beacon extends its duration by 4 sec, up to 16 sec. Can occur once every 6 sec across all allies.'),
   node('pala_radiant_riposte','Radiant Riposte','⚔️','right',['radiance'],'Land Righteous Strike and Judgment within 6 sec, in either order, to make your next Holy Light instant for 8 sec. Can occur once every 12 sec.'),
   node('pala_crusader_reprieve','Crusader’s Reprieve','🔔','right',['radiance'],'Effective Holy Shock healing reduces Judgment cooldown by 2 sec and empowers your next Righteous Strike to deal 30% more damage for 6 sec. Can occur once every 6 sec; Divine Toll does not trigger this effect.')
  ],
  warrior:[
   node('war_sudden_execution','Sudden Execution','💀','left',['executioner'],'Two Mortal Swings against enemies below 35% health prepare your next Mortal Swing to cost no Rage and deal 20% more damage for 8 sec. Only one hit counts each second; progress lasts 12 sec. Can occur once every 12 sec.'),
   node('war_weight_of_steel','Weight of Steel','⚔️','left',['executioner'],'Charge prepares your next Mortal Swing for 6 sec. Against an enemy carrying your Rend, that swing deals 12% more damage. The preparation is consumed by a successful Mortal Swing.'),
   node('war_blood_reservoir','Blood Reservoir','🩸','right',['battlehardened'],'Three damaging Rend or Gushing Wound ticks prepare your next Rend or Gushing Wound to cost no Rage and deal 20% more initial damage for 8 sec. Only one tick counts each second; bleed damage is unchanged.'),
   node('war_sanguine_recovery','Sanguine Recovery','🏆','right',['war_blood_reservoir'],'Rend or Gushing Wound striking an enemy already carrying your bleed reduces Victory Rush cooldown by 2 sec. Can occur once every 6 sec. Does not add another healing effect.')
  ]
 };
 const profiles={
  ash:{color:0xffa94c,accent:0xff4d24,shape:'embers',sound:'proc'},
  chrono:{color:0xffd672,accent:0x97d7ff,shape:'clock',sound:'proc'},
  affliction:{color:0x9c73df,accent:0xbdf166,shape:'sigil',sound:'shadow'},
  chaos:{color:0x72ff4d,accent:0xffb251,shape:'flame',sound:'proc'},
  penance:{color:0xffebae,accent:0xffffff,shape:'halo',sound:'holy'},
  twilight:{color:0xb99aff,accent:0xffe4ac,shape:'crescent',sound:'proc'},
  combo:{color:0xffd780,accent:0x88ffe4,shape:'slashes',sound:'wind'},
  jade:{color:0x70ffc1,accent:0xeaffb5,shape:'leaves',sound:'proc'},
  tempest:{color:0x9eeaff,accent:0x8394ff,shape:'arcs',sound:'proc'},
  earth:{color:0xcabb85,accent:0x8ce8d6,shape:'stones',sound:'proc'},
  grove:{color:0xa4ff99,accent:0xf7df97,shape:'leaves',sound:'natureHeal'},
  dream:{color:0xc3a7ff,accent:0x87f5dd,shape:'petals',sound:'proc'},
  beacon:{color:0xffec9c,accent:0xffffff,shape:'halo',sound:'holy'},
  avenger:{color:0xffd05f,accent:0xfff7c7,shape:'rays',sound:'proc'},
  steel:{color:0xffb56b,accent:0xd9e4ed,shape:'slashes',sound:'proc'},
  blood:{color:0xdb5971,accent:0xffbe8a,shape:'embers',sound:'proc'}
 };
 const buffDefs={
  expAshenLance:['Ashen Lance','🔥','ash',['Ember Lance']],expFallingStar:['Falling Star','☄️','ash',['Cinder Bolt']],expFlashfire:['Flashfire','✨','chrono',['Ember Lance']],expBorrowedFlame:['Borrowed Flame','⏳','chrono',['Cinder Bolt']],
  expNightfall:['Nightfall','🌑','affliction',['Unstable Affliction']],expMalice:['Malice','🧫','affliction',['Pandemic Bloom']],expCinderwake:['Cinderwake','💚','chaos',['Chaos Bolt']],expSiphonedFlame:['Siphoned Flame','🔥','chaos',['Immolate']],
  expDevotion:['Luminous Devotion','✦','penance',['Power Shield']],expPenitentShelter:['Penitent Shelter','🪽','penance',['Penance']],expRevelation:['Painful Revelation','🕯️','twilight',['Smite','Mind Spike']],expReparation:['Twilight Reparation','🌓','twilight',['Shadow Mend']],
  expRadiantPurpose:['Radiant Purpose','🌠','penance',['Smite','Mind Spike','Penance','Solace','Shadow Word: Pain']],expUmbralReprieve:['Umbral Reprieve','🌒','twilight',['Shadow Mend']],
  expCloudstepRise:['Cloudstep Ascendance','🌅','combo',['Zephyr Palm','Rising Sun Kick']],
  expThreefold:['Threefold Path','☯️','combo',['Zephyr Palm','Rising Sun Kick']],expWillowCounter:['Willow Counter','🥊','jade',['Fists of Fury','Hurricane Strikes']],
  expClosedCircuit:['Closed Circuit','⚡','tempest',['Forked Current']],expStoneToSky:['Stone to Sky','🪨','earth',['Arc Spark']],expEarthAnswer:['Earth’s Answer','💧','earth',['Healing Surge']],expStormRebound:['Storm Rebound','⛈️','tempest',['Arc Spark']],
  expGroveCadence:['Grove Cadence','🌿','grove',['Verdant Mend']],expLucid:['Lucid Reservoir','🦋','dream',['Renewal Tide','Swiftmend']],expFaeBloom:['Fae Bloom','🌺','dream',['Blooming Echo','Dream Echo']],
  expBeaconMercy:['Beacon’s Mercy','🕯️','beacon',['Holy Shock']],expRadiantRiposte:['Radiant Riposte','⚔️','avenger',['Holy Light']],expCrusaderReprieve:['Crusader’s Reprieve','🔔','avenger',['Righteous Strike']],
  expSuddenExecution:['Sudden Execution','💀','steel',['Mortal Swing']],expWeightSteel:['Weight of Steel','⚔️','steel',['Mortal Swing']],expBloodReservoir:['Blood Reservoir','🩸','blood',['Rend','Gushing Wound']]
 };
 const effectMeta=Object.fromEntries(Object.entries(buffDefs).map(([key,[label,icon]])=>[key,{label,icon,buff:true}]));
 effectMeta.expCloudstepRise.description='Your next Rising Sun Kick deals 12% more damage and costs half as much Energy. Cloudstep Kick prepared this follow-up by completing an alternating attack sequence.';
 const actionHighlights=Object.fromEntries(Object.entries(buffDefs).map(([key,[,,profile,abilities]])=>[key,{abilities,profile}]));
 const cls=c=>c?.cls||c?.classId;
 const unitId=u=>u?.id??u?.netId;
 const canonicalLabel=value=>String(value||'').replace(/ Tick$/,'');
 const live=(api,u,key)=>{const e=api.get(u,key);return e&&api.time(e)>0?e:null;};
 const has=(api,c,id)=>api.rank(c,id)>0;
 const ready=(api,c,id,key)=>has(api,c,id)&&live(api,c,key);
 const owns=(api,c,t,predicate)=>!!t&&api.effects(t).some(e=>api.time(e)>0&&api.owned(e,c)&&predicate(e));
 const effectName=e=>e.label||e.name||e.type;
 const affliction=e=>['soulScar','agony','unstableAffliction'].includes(e.type);
 const periodicAffliction=label=>['Soul Scar','Creeping Torment','Unstable Affliction'].includes(label);
 const hotLabel=label=>['Blooming Echo','Rejuvenate','Spirit Blossom','Lifebloom','Dream Breath'].includes(label);
 const primaryWind=new Set(['Zephyr Palm','Rising Sun Kick','Cloudstep Kick','Chi Explosion','Strike of the Windlord','Whirling Dragon Punch','Cyclone Barrage']);
 const penance=label=>label==='Penance'||label==='Radiant Penance';
 const holyStrike=label=>label==='Righteous Strike'||label==='Judgment'||label==='Judgement';
 function set(api,c,key,time,data={}){api.remove(c,key);api.add(c,key,time,data);}
 function lock(api,c,key,time){if(live(api,c,key))return false;set(api,c,key,time);return true;}
 function grant(api,c,key,time,data={},target=c){set(api,c,key,time,data);const def=buffDefs[key];if(def)api.proc(c,def[2],def[0],target);}
 function counter(api,c,key,cap,time,gate=0){if(gate&&!lock(api,c,key+'Tick',gate))return 0;const previous=Number(live(api,c,key)?.stacks||0),count=Math.min(cap,previous+1);set(api,c,key,time,{stacks:count});if(count===cap&&previous<cap&&buffDefs[key]){const def=buffDefs[key];api.proc(c,def[2],def[0],c);}return count;}
 function spend(api,c,key){api.remove(c,key);}
 function castScale(a,factor){const cast=Number(a.cast??a.castTime??0);return {...a,cast:cast*factor,castTime:cast*factor};}
 function maybeProcCounter(api,c,id,countKey,cap,window,key,seconds,gate=1){if(!has(api,c,id)||live(api,c,key))return;if(counter(api,c,countKey,cap,window,gate)>=cap){spend(api,c,countKey);grant(api,c,key,seconds);}}
 function modifyAbility(api,c,input){
  let a={...input},cost=Number(a.cost||0),name=a.name;
  const discount=(id,key,factor)=>{if(ready(api,c,id,key))cost*=factor;};
  const quicken=(id,key,factor)=>{if(ready(api,c,id,key))a=castScale(a,factor);};
  if(name==='Ember Lance'){if(ready(api,c,'flame_ashen_reservoir','expAshenLance'))cost=Math.max(0,cost-3);discount('flame_flashfire','expFlashfire',0);}
  if(name==='Cinder Bolt'){if(ready(api,c,'flame_falling_star','expFallingStar')){cost=0;a=castScale(a,0);}quicken('flame_borrowed_flame','expBorrowedFlame',.75);}
  if(name==='Unstable Affliction'&&ready(api,c,'soul_nightfall','expNightfall')){cost=0;a=castScale(a,0);}
  if(name==='Chaos Bolt')quicken('soul_cinderwake','expCinderwake',.8);
  if(name==='Immolate')discount('soul_siphoned_flame','expSiphonedFlame',0);
  if(name==='Power Shield')discount('disc_luminous_devotion','expDevotion',.5);
  if(['Smite','Mind Spike'].includes(name)){discount('disc_painful_revelation','expRevelation',0);quicken('disc_painful_revelation','expRevelation',.7);}
  if(name==='Shadow Mend')quicken('disc_umbral_reprieve','expUmbralReprieve',.6);
  if(name==='Rising Sun Kick'&&ready(api,c,'tigerdash','expCloudstepRise'))cost*=.5;
  if(['Zephyr Palm','Rising Sun Kick'].includes(name))discount('wind_threefold_path','expThreefold',0);
  if(['Arc Spark','Tempest Bolt'].includes(name)){discount('storm_stone_to_sky','expStoneToSky',0);quicken('storm_stone_to_sky','expStoneToSky',.6);}
  if(cls(c)==='storm'&&name==='Arc Spark'&&!live(api,c,'tempestBolts')&&!live(api,c,'stormkeeper')&&live(api,c,'expStormRebound'))a=castScale(a,.6);
  if(name==='Healing Surge')discount('storm_earths_answer','expEarthAnswer',.6);
  if(name==='Verdant Mend')quicken('sage_grove_cadence','expGroveCadence',.8);
  if(['Blooming Echo','Dream Echo'].includes(name))discount('sage_fae_bloom','expFaeBloom',0);
  if(name==='Holy Shock')discount('pala_beacon_mercy','expBeaconMercy',.5);
  if(name==='Holy Light')quicken('pala_radiant_riposte','expRadiantRiposte',0);
  if(name==='Mortal Swing')discount('war_sudden_execution','expSuddenExecution',0);
  if(['Rend','Gushing Wound'].includes(name))discount('war_blood_reservoir','expBloodReservoir',0);
  a.cost=Math.max(0,cost);return a;
 }
 function damageMultiplier(api,c,t,label,options={}){
  label=canonicalLabel(label);
  let value=1;const bonus=(id,key,n)=>{if(ready(api,c,id,key))value*=n;};
  if(label==='Ember Lance'||label==='Meteor Lance'){bonus('flame_ashen_reservoir','expAshenLance',1.18);bonus('flame_flashfire','expFlashfire',1.12);}
  if(label==='Pandemic Bloom'&&has(api,c,'soul_malignant_bloom'))value*=1+.08*Math.min(3,Number(live(api,c,'expMalice')?.stacks||0));
  if(label==='Immolate'&&!options.periodic)bonus('soul_siphoned_flame','expSiphonedFlame',1.25);
  if(penance(label))bonus('disc_penitent_shelter','expPenitentShelter',1.12);
  if(['Zephyr Palm','Rising Sun Kick'].includes(label))bonus('wind_threefold_path','expThreefold',1.20);
  if(label==='Rising Sun Kick'&&ready(api,c,'tigerdash','expCloudstepRise'))value*=1.12;
  if(label==='Fists of Fury'||label==='Hurricane Strikes')bonus('wind_willow_counter','expWillowCounter',1.12);
  if(label==='Forked Current')bonus('storm_closed_circuit','expClosedCircuit',1.20);
  if(['Arc Spark','Tempest Bolt','Stormkeeper Arc Spark'].includes(label))bonus('storm_stone_to_sky','expStoneToSky',1.15);
  if(label==='Righteous Strike')bonus('pala_crusader_reprieve','expCrusaderReprieve',1.30);
  if(label==='Mortal Swing'){bonus('war_sudden_execution','expSuddenExecution',1.20);if(owns(api,c,t,e=>e.type==='bleed'&&effectName(e)==='Rend'))bonus('war_weight_of_steel','expWeightSteel',1.12);}
  if(['Rend','Gushing Wound'].includes(label)&&!options.periodic)bonus('war_blood_reservoir','expBloodReservoir',1.20);
  return value;
 }
 function healMultiplier(api,c,t,label,options={}){
  label=canonicalLabel(label);
  let value=1;const bonus=(id,key,n)=>{if(ready(api,c,id,key))value*=n;};
  if(/Penance Atonement/.test(label))bonus('disc_penitent_shelter','expPenitentShelter',1.12);
  if(/Atonement/.test(label))bonus('disc_radiant_purpose','expRadiantPurpose',1.15);
  if(label==='Penance Direct Heal'&&has(api,c,'disc_guiding_grace'))value*=1.15;
  if(label==='Shadow Mend')bonus('disc_twilight_reparation','expReparation',1.20);
  if(label==='Healing Surge')bonus('storm_earths_answer','expEarthAnswer',1.20);
  if(label==='Verdant Mend')bonus('sage_grove_cadence','expGroveCadence',1.25);
  if(['Renewal Tide','Swiftmend'].includes(label)&&has(api,c,'sage_lucid_reservoir'))value*=1+.10*Math.min(3,Number(live(api,c,'expLucid')?.stacks||0));
  if(['Blooming Echo','Dream Echo'].includes(label)&&!options.periodic)bonus('sage_fae_bloom','expFaeBloom',1.30);
  if(label==='Holy Shock')bonus('pala_beacon_mercy','expBeaconMercy',1.20);
  return value;
 }
 function onHit(api,c,t,event){
  if(!(Number(event.amount)>0))return;
  const label=canonicalLabel(event.label),periodic=!!event.periodic,id=cls(c);
  if(id==='flame'){
   if(periodic&&/Burn|Living Bomb|Flame Shock|Ember Trail/i.test(label))maybeProcCounter(api,c,'flame_ashen_reservoir','expAsh',4,20,'expAshenLance',8);
   if(['Meteor','Meteorfall'].includes(label)&&has(api,c,'flame_falling_star')&&owns(api,c,t,e=>e.type==='burn'||e.type==='livingBomb')&&lock(api,c,'expFallingStarLock',12))grant(api,c,'expFallingStar',8);
   if(['Ember Lance','Meteor Lance'].includes(label)){
    spend(api,c,'expAshenLance');spend(api,c,'expFlashfire');
    if(has(api,c,'flame_pyric_cadence'))set(api,c,'expEmberCadence',6);
    if(has(api,c,'flame_temporal_weave')&&live(api,c,'expCinderCadence')&&lock(api,c,'expTemporalLock',6)){spend(api,c,'expCinderCadence');api.reduce(c,'Blazing Step',2);api.proc(c,'chrono','Temporal Weave',c);}
   }
   if(label==='Cinder Bolt'){
    if(has(api,c,'flame_pyric_cadence')&&live(api,c,'expEmberCadence')&&lock(api,c,'expPyricLock',6)){spend(api,c,'expEmberCadence');api.reduce(c,'Meteor',2);api.proc(c,'ash','Pyric Cadence',c);}
    if(has(api,c,'flame_temporal_weave'))set(api,c,'expCinderCadence',6);
   }
  }
  if(id==='soul'){
   if(periodic&&periodicAffliction(label)){
    maybeProcCounter(api,c,'soul_nightfall','expNightfallCount',6,20,'expNightfall',10);
    if(has(api,c,'soul_malignant_bloom'))counter(api,c,'expMalice',3,12,1);
   }
   if(label==='Pandemic Bloom')spend(api,c,'expMalice');
   if(label==='Essence Siphon'){
    const afflictions=api.effects(t).filter(e=>api.time(e)>0&&api.owned(e,c)&&affliction(e));
    if(has(api,c,'soul_lingering_misery')&&new Set(afflictions.map(e=>e.type)).size===3&&lock(api,c,'expMiseryLock',3)){for(const e of afflictions)api.setTime(e,Math.min(15,api.time(e)+1));api.proc(c,'affliction','Lingering Misery',t);}
    if(has(api,c,'soul_siphoned_flame')&&owns(api,c,t,e=>e.type==='burn'&&effectName(e)==='Immolate')&&lock(api,c,'expSiphonedLock',8))grant(api,c,'expSiphonedFlame',8);
   }
   if(label==='Chaos Bolt'&&has(api,c,'soul_roaring_embers')&&lock(api,c,'expRoaringLock',6)){for(const e of api.effects(t))if(api.time(e)>0&&api.owned(e,c)&&e.type==='burn'&&effectName(e)==='Immolate')api.setTime(e,Math.min(12,api.time(e)+3));}
   if(label==='Immolate'&&periodic)maybeProcCounter(api,c,'soul_cinderwake','expCinderCount',3,20,'expCinderwake',10);
   if(label==='Immolate'&&!periodic)spend(api,c,'expSiphonedFlame');
  }
  if(id==='disc'){
   if(!periodic&&['Smite','Mind Spike'].includes(label)&&has(api,c,'disc_painkeeper')){
    const pain=api.effects(t).find(e=>e.type==='discPain'&&api.owned(e,c)&&api.time(e)>0);
    if(pain&&lock(api,c,'expPainkeeperLock',3)){api.setTime(pain,Math.min(12,api.time(pain)+2));api.proc(c,'twilight','Painkeeper',t);}
   }
   if(label==='Shadow Word: Pain'&&periodic)maybeProcCounter(api,c,'disc_painful_revelation','expRevelationCount',3,20,'expRevelation',8);
   if(['Smite','Mind Spike'].includes(label)&&has(api,c,'disc_twilight_reparation')&&live(api,c,'expMendOpportunity')&&lock(api,c,'expReparationLock',8)){spend(api,c,'expMendOpportunity');grant(api,c,'expReparation',8);}
   if(has(api,c,'disc_duality')){
    const school=(!periodic&&['Smite','Solace','Penance','Radiant Penance'].includes(label))?'holy':(['Mind Spike','Shadow Word: Pain'].includes(label)?'shadow':null),old=live(api,c,'expDuality');
    if(school){if(old&&old.school!==school&&lock(api,c,'expDualityLock',4)){api.resource(c,3);api.proc(c,'twilight','Duality',c);}set(api,c,'expDuality',6,{school});}
   }
  }
  if(id==='wind'){
   if(!periodic&&primaryWind.has(label)){
    const previous=live(api,c,'expCloudstepSequence')?.label;
    if(label==='Rising Sun Kick')spend(api,c,'expCloudstepRise');
    if(label==='Cloudstep Kick'&&previous&&previous!==label&&has(api,c,'tigerdash')&&lock(api,c,'expCloudstepLock',8)){
     set(api,c,'risingSunReady',8);grant(api,c,'expCloudstepRise',8);
    }
    set(api,c,'expCloudstepSequence',8,{label});
   }
   if(!periodic&&primaryWind.has(label)){
    if(['Zephyr Palm','Rising Sun Kick'].includes(label)&&live(api,c,'expThreefold'))spend(api,c,'expThreefold');
    else if(has(api,c,'wind_threefold_path')&&!live(api,c,'expThreefold')&&!live(api,c,'expThreefoldLock')){
     const old=live(api,c,'expThreefoldCount'),names=new Set(old?.names||[]);names.add(label);
     if(names.size>=3){spend(api,c,'expThreefoldCount');set(api,c,'expThreefoldLock',12);grant(api,c,'expThreefold',8);}else set(api,c,'expThreefoldCount',old?api.time(old):8,{names:[...names],stacks:names.size});
    }
    if(label==='Rising Sun Kick'&&has(api,c,'wind_sunrise_return'))set(api,c,'expSunrise',6);
    if(['Cloudstep Kick','Chi Explosion'].includes(label)&&has(api,c,'wind_sunrise_return')&&live(api,c,'expSunrise')&&lock(api,c,'expSunriseLock',8)){spend(api,c,'expSunrise');api.reduce(c,'Fists of Fury',2);api.reduce(c,'Hurricane Strikes',2);api.proc(c,'combo','Sunrise Return',c);}
   }
   if(['Fists of Fury','Hurricane Strikes'].includes(label)&&has(api,c,'wind_jade_reservoir')&&lock(api,c,'expJadeLock',12)){api.resource(c,6);api.proc(c,'jade','Jade Reservoir',c);}
  }
  if(id==='storm'){
   // Baseline Surge payoff, once per landed single-target bolt. No Shock,
   // cleave or periodic effect can generate this mobility preparation.
   if(label==='Tempest Bolt'&&!periodic&&lock(api,c,'expReboundBoltGate',.20)){
    api.reduce(c,'Forked Current',1);
    if(counter(api,c,'expReboundCount',2,10)>=2){spend(api,c,'expReboundCount');grant(api,c,'expStormRebound',8);}
   }
   const rod=owns(api,c,t,e=>e.type==='lightningRod');
   if(['Arc Spark','Tempest Bolt','Stormkeeper Arc Spark'].includes(label)){
    spend(api,c,'expStoneToSky');
    if(rod)maybeProcCounter(api,c,'storm_closed_circuit','expCircuitCount',2,12,'expClosedCircuit',8);
   }
   if(label==='Forked Current'){
    spend(api,c,'expClosedCircuit');
    if(rod&&has(api,c,'storm_rolling_thunder')&&lock(api,c,'expRollingLock',4)){api.resource(c,3);api.reduce(c,'Stormkeeper',1);api.proc(c,'tempest','Rolling Thunder',c);}
   }
   if(['Arc Spark','Tempest Bolt','Stormkeeper Arc Spark','Forked Current'].includes(label))maybeProcCounter(api,c,'storm_earths_answer','expEarthCount',4,20,'expEarthAnswer',8);
  }
  if(id==='pala'&&holyStrike(label)&&has(api,c,'pala_radiant_riposte')&&!live(api,c,'expRiposteLock')){
   const strike=label==='Righteous Strike'?'melee':'judgment',old=live(api,c,'expRiposteCount');
   if(old&&old.strike!==strike){spend(api,c,'expRiposteCount');set(api,c,'expRiposteLock',12);grant(api,c,'expRadiantRiposte',8);}else set(api,c,'expRiposteCount',6,{strike});
  }
  if(id==='pala'&&label==='Righteous Strike')spend(api,c,'expCrusaderReprieve');
  if(id==='warrior'){
   if(label==='Mortal Swing'){
    const used=!!live(api,c,'expSuddenExecution');spend(api,c,'expSuddenExecution');spend(api,c,'expWeightSteel');
    if(!used&&has(api,c,'war_sudden_execution')&&Number(t.hp)/Number(t.maxHp)<.35&&!live(api,c,'expExecuteLock')&&counter(api,c,'expExecuteCount',2,12,1)>=2){spend(api,c,'expExecuteCount');set(api,c,'expExecuteLock',12);grant(api,c,'expSuddenExecution',8);}
   }
   if(periodic&&['Rend','Gushing Wound'].includes(label))maybeProcCounter(api,c,'war_blood_reservoir','expBloodCount',3,20,'expBloodReservoir',8);
   if(['Rend','Gushing Wound'].includes(label)&&!periodic){spend(api,c,'expBloodReservoir');if(has(api,c,'war_sanguine_recovery')&&owns(api,c,t,e=>e.type==='bleed')&&lock(api,c,'expSanguineLock',6)){api.reduce(c,'Victory Rush',2);api.proc(c,'blood','Sanguine Recovery',c);}}
  }
 }
 function onHeal(api,c,t,event){
  const label=canonicalLabel(event.label),amount=Number(event.amount)||0,id=cls(c),periodic=!!event.periodic;
  if(id==='disc'){
   if(amount>0&&label==='Penance Direct Heal'&&has(api,c,'disc_guiding_grace')){
    const mark=api.effects(t).find(e=>e.type==='atonement'&&api.owned(e,c)&&api.time(e)>0);
    if(mark)api.setTime(mark,Math.min(17,api.time(mark)+1));
   }
   if(amount>0&&/Atonement/.test(label))maybeProcCounter(api,c,'disc_luminous_devotion','expDevotionCount',3,20,'expDevotion',8);
   if(label==='Shadow Mend'){
    spend(api,c,'expReparation');
    if(has(api,c,'disc_twilight_reparation'))set(api,c,'expMendOpportunity',6);
    if(amount>0&&has(api,c,'disc_enduring_covenant'))set(api,c,'expCovenantMend',1,{targetId:unitId(t)});
   }
  }
  if(id==='storm'&&label==='Healing Surge')spend(api,c,'expEarthAnswer');
  if(id==='sage'){
   if(amount>0&&hotLabel(label)&&periodic&&has(api,c,'sage_grove_cadence')&&!live(api,c,'expGroveLock')&&!live(api,c,'expGroveCadence')&&counter(api,c,'expGroveCount',3,20,1)>=3){spend(api,c,'expGroveCount');set(api,c,'expGroveLock',10);grant(api,c,'expGroveCadence',8);}
   if(label==='Verdant Mend'){
    spend(api,c,'expGroveCadence');
    const hots=api.effects(t).filter(e=>e.type==='hot'&&api.time(e)>0&&api.owned(e,c));
    if(amount>0&&has(api,c,'sage_canopy_cycle')&&new Set(hots.map(effectName)).size>=2&&lock(api,c,'expCanopyLock',4)){api.reduce(c,has(api,c,'sage_dream_breath')?'Dream Breath':'Spirit Blossom',2);api.proc(c,'grove','Canopy Cycle',c);}
   }
   if(['Renewal Tide','Swiftmend'].includes(label))spend(api,c,'expLucid');
   // Only cast heals can store overhealing. Mirrors, HoTs and proc heals never loop.
   if(!periodic&&['Verdant Mend','Renewal Tide','Swiftmend','Blooming Echo','Dream Echo','Rejuvenate'].includes(label)&&has(api,c,'sage_lucid_reservoir')&&Number(event.overheal)>=Number(t.maxHp)*.01)counter(api,c,'expLucid',3,12,1);
   if(['Blooming Echo','Dream Echo'].includes(label)&&!periodic)spend(api,c,'expFaeBloom');
  }
  if(id==='pala'){
   const beacon=api.effects(t).find(e=>e.type==='beaconFaith'&&api.time(e)>0&&api.owned(e,c));
   if(amount>0&&label==='Holy Light'&&beacon&&has(api,c,'pala_beacon_mercy')&&lock(api,c,'expMercyLock',10))grant(api,c,'expBeaconMercy',8);
   if(label==='Holy Shock'){
    spend(api,c,'expBeaconMercy');
    if(amount>0&&beacon&&has(api,c,'pala_lasting_light')&&lock(api,c,'expLastingLock',6)){api.setTime(beacon,Math.min(16,api.time(beacon)+4));api.proc(c,'beacon','Lasting Light',t);}
    if(amount>0&&has(api,c,'pala_crusader_reprieve')&&lock(api,c,'expReprieveLock',6)){api.reduce(c,'Judgement',2);grant(api,c,'expCrusaderReprieve',6);}
   }
  }
 }
 function onResolve(api,c,t,a){
  const name=a.name,id=cls(c);
  if(id==='flame'){
   if(name==='Blazing Step'&&has(api,c,'flame_flashfire')&&lock(api,c,'expFlashfireLock',8))grant(api,c,'expFlashfire',6);
   if(name==='Alter Time'&&has(api,c,'flame_borrowed_flame')&&lock(api,c,'expBorrowedLock',20))grant(api,c,'expBorrowedFlame',10,{stacks:2});
   if(name==='Cinder Bolt'){spend(api,c,'expFallingStar');const effect=live(api,c,'expBorrowedFlame');if(effect){if(Number(effect.stacks)>1)effect.stacks--;else spend(api,c,'expBorrowedFlame');}}
  }
  if(id==='soul'){if(name==='Unstable Affliction')spend(api,c,'expNightfall');if(name==='Chaos Bolt')spend(api,c,'expCinderwake');}
  if(id==='disc'){
   if(name==='Ultimate Radiance'&&has(api,c,'disc_radiant_purpose'))grant(api,c,'expRadiantPurpose',6);
   if(['Smite','Mind Spike'].includes(name)&&live(api,c,'expRevelation')&&has(api,c,'disc_umbral_reprieve')&&lock(api,c,'expUmbralLock',10))grant(api,c,'expUmbralReprieve',8);
   if(name==='Shadow Mend')spend(api,c,'expUmbralReprieve');
   if(name==='Power Shield'){spend(api,c,'expDevotion');if(has(api,c,'disc_penitent_shelter')&&lock(api,c,'expShelterLock',10))grant(api,c,'expPenitentShelter',6);}
   if(['Smite','Mind Spike'].includes(name))spend(api,c,'expRevelation');
   if(name==='Shadow Mend'&&has(api,c,'disc_enduring_covenant')&&live(api,c,'expCovenantMend')?.targetId===unitId(t)){spend(api,c,'expCovenantMend');const atonement=api.effects(t).find(e=>e.type==='atonement'&&api.owned(e,c)&&api.time(e)>0);if(atonement&&lock(api,c,'expCovenantLock',6)){api.setTime(atonement,Math.min(17,api.time(atonement)+3));api.proc(c,'penance','Enduring Covenant',t);}}
  }
  if(id==='wind'&&name==='Willow Guard'&&has(api,c,'wind_willow_counter'))grant(api,c,'expWillowCounter',6);
  if(id==='storm'&&name==='Healing Surge'&&has(api,c,'storm_stone_to_sky')&&lock(api,c,'expStoneSkyLock',8))grant(api,c,'expStoneToSky',8);
  if(id==='storm'&&name==='Arc Spark'&&!a.stormkeeperSpark&&!a.tempestProc&&!live(api,c,'stormkeeper'))spend(api,c,'expStormRebound');
  if(id==='sage'&&name==='Fae Retreat'&&has(api,c,'sage_fae_bloom')&&lock(api,c,'expFaeBloomLock',8))grant(api,c,'expFaeBloom',6);
  if(id==='pala'&&name==='Holy Light')spend(api,c,'expRadiantRiposte');
  if(id==='warrior'&&name==='Charge'&&has(api,c,'war_weight_of_steel'))grant(api,c,'expWeightSteel',6);
 }
 root.AETHER_CLASS_EXPANSION={nodes,effectMeta,profiles,actionHighlights,modifyAbility,damageMultiplier,healMultiplier,onHit,onHeal,onResolve};
})(globalThis);
