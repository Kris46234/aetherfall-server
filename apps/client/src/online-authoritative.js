/* Aetherfall authoritative co-op client.
   Both players are equal predicted renderers of one server-owned match. */
(function(){
'use strict';
var PROTOCOL=20,DEFAULT_SERVER='wss://aetherfall-authoritative-coop.onrender.com',BRIDGE=window.AETHER_ONLINE_BRIDGE||{},AB=BRIDGE.AB||{},CLASS_INFO=BRIDGE.CLASS_INFO||{};
var TALENT_ABILITY_IDS={"disc|Angelic Body":"disc_angelic_body","disc|Archangel":"disc_archangel","disc|Dark Archangel":"disc_dark_archangel","flame|Cauterize":"flame_cauterize","flame|Combustion":"flame_combustion","flame|Dragon Breath":"flame_dragon_breath","flame|Living Bomb":"flame_meteor_spear","flame|Fire Shield":"flame_molten_armor","flame|Alter Time":"flame_phoenix_guard","pala|Blinding Light":"pala_blinding_light","pala|Divine Toll":"pala_divine_toll","pala|Blessing of Freedom":"pala_freedom","pala|Guardian Angel":"pala_guardian_angel","pala|Judgement":"pala_judgement","pala|Word of Glory":"pala_word_of_glory","sage|Nature’s Grasp":"sage_natures_grasp","sage|Rejuvenate":"sage_rejuvenate","sage|Nature Swiftness":"sage_rejuvenating_gust","sage|Ironbark":"sage_spirit_bloom","shadow|Cloak of Shadows":"shadow_cloak","shadow|Evasion":"shadow_crimson_vial","shadow|Garrote":"shadow_garrote","shadow|Gouge":"shadow_gouge","shadow|Crimson Vial":"shadow_sap","shadow|Vendetta":"shadow_shadowstep","shadow|Shiv":"shadow_shiv","soul|Dark Pact":"soul_dark_pact","soul|Mortal Horror":"soul_horror","soul|Pandemic Bloom":"soul_pandemic_bloom","soul|Shadowfury":"soul_shadowfury","soul|Undying Resolve":"soul_undying_resolve","soul|Chaos Bolt":"soul_void_mend","soul|Summon Infernal":"soul_summon_infernal","storm|Healing Surge":"storm_chain_spark","storm|Frost Shock":"storm_grounding_aegis","storm|Volcanic Eruption":"storm_lava_burst","storm|Totem Mastery":"storm_mana_well","storm|Static Field":"storm_static_field","storm|Healing Stream Totem":"storm_static_field","storm|Stormkeeper":"storm_thunderstep","warrior|Battle Banner":"war_battle_banner","warrior|Warbreaker":"war_disarm","warrior|Stormbolt":"war_execute_strike","warrior|Bladestorm":"war_heroic_leap","warrior|Rallying Wall":"war_rallying_wall","warrior|Avatar":"war_skullbreaker","warrior|Victory Rush":"war_victory_rush","wind|Touch of Death":"wind_chi_burst","wind|Disabling Reach":"wind_disabling_reach","wind|Touch of Karma":"wind_karma","wind|Strike of the Windlord":"wind_tiger_rush","wind|Tigereye Brew":"wind_tigereye_brew","wind|Tiger's Lust":"wind_tigers_lust","warrior|Sharpen Blade":"war_rallying_wall","warrior|Intercept":"war_battle_banner","sage|G’Hanir, the Mother Tree":"sage.ghanir_the_mother_tree","sage|G'Hanir, the Mother Tree":"sage.ghanir_the_mother_tree"};
var BOT_ABILITY_DEFS={pala_blinding_light:{name:'Blinding Light',type:'blind',school:'holy',cast:0},pala_divine_toll:{name:'Divine Toll',type:'holyShock',school:'holy',cast:0},pala_freedom:{name:'Blessing of Freedom',type:'cleanse',school:'holy',cast:0},pala_guardian_angel:{name:'Guardian Angel',type:'shield',school:'holy',cast:0},pala_judgement:{name:'Judgement',type:'damage',school:'holy',cast:0},pala_word_of_glory:{name:'Word of Glory',type:'heal',school:'holy',cast:0},war_execute_strike:{name:'Stormbolt',type:'stormbolt',school:'physical',cast:0},war_disarm:{name:'Warbreaker',type:'warbreaker',school:'physical',cast:0},war_heroic_leap:{name:'Bladestorm',type:'bladestorm',school:'physical',cast:4},war_skullbreaker:{name:'Avatar',type:'avatar',school:'physical',cast:0},war_victory_rush:{name:'Victory Rush',type:'victoryRush',school:'physical',cast:0}};
Object.assign(BOT_ABILITY_DEFS,{pala_freedom:{name:'Blessing of Freedom',type:'freedom',school:'holy',cast:0},pala_guardian_angel:{name:'Guardian Angel',type:'guardianAngel',school:'holy',cast:0},sage_natures_grasp:{name:'Nature’s Grasp',type:'root',school:'nature',cast:0},sage_spirit_bloom:{name:'Ironbark',type:'ironbark',school:'nature',cast:0},soul_void_mend:{name:'Chaos Bolt',type:'chaosBolt',school:'shadow',cast:1.6},soul_dark_pact:{name:'Dark Pact',type:'shieldSelf',school:'shadow',cast:0},soul_summon_infernal:{name:'Summon Infernal',type:'summonInfernal',school:'shadow',cast:0},wind_tiger_rush:{name:'Strike of the Windlord',type:'windlordStrike',school:'wind',cast:0},wind_whirling_dragon:{name:'Whirling Dragon Punch',type:'whirlingDragonPunch',school:'wind',cast:0},wind_karma:{name:'Touch of Karma',type:'karma',school:'wind',cast:0}});
TALENT_ABILITY_IDS['storm|Healing Stream Totem']='storm_static_field';
TALENT_ABILITY_IDS['wind|Whirling Dragon Punch']='wind_whirling_dragon';
function $id(id){return document.getElementById(id);}
function whenGame(fn){var timer=setInterval(function(){if(window.game){clearInterval(timer);fn(window.game);}},120);}
function className(id){return CLASS_INFO[id]&&CLASS_INFO[id].name||String(id||'Unknown');}
function selectedClass(){return ($id('classSelect')||{}).value||'flame';}
function progression(){return BRIDGE.getProgression?BRIDGE.getProgression():{talents:{}};}
function talentsFor(cls){var all=progression().talents||{};return Object.assign({},all[cls]||{});}
function slug(value){return String(value||'').normalize('NFKD').replace(/[’']/g,'').replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'').toLowerCase();}
function abilityId(cls,ability){return TALENT_ABILITY_IDS[cls+'|'+(ability&&ability.name)]||cls+'.'+slug(ability&&ability.name);}
function abilityIndex(cls,id){var list=AB[cls]||[];for(var i=0;i<list.length;i++)if(abilityId(cls,list[i])===id)return i;return -1;}
function abilityForId(cls,id){var index=abilityIndex(cls,id),local=(AB[cls]||[])[index];return local||BOT_ABILITY_DEFS[id]||null;}
function clientId(){var key='aetherAuthorityClient',id='';try{id=sessionStorage.getItem(key)||'';}catch(e){}if(!id){id=crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36);try{sessionStorage.setItem(key,id);}catch(e){}}return id;}
function socketUrl(value){var url=String(value||'').trim();if(/^http/i.test(url))url=url.replace(/^http/i,'ws');if(!/^wss?:\/\//i.test(url))url='wss://'+url;return url.replace(/\/+$/,'');}
function roomCode(){return Math.random().toString(36).slice(2,8).toUpperCase();}
function sessionKey(url,room){return 'aetherAuthoritySession:'+url+':'+room;}
function hideLobby(){var panel=$id('anPanel');if(panel)panel.classList.add('hidden');}
function showLobby(){var panel=$id('anPanel');if(panel)panel.classList.remove('hidden');}
function sendable(ws){return ws&&ws.readyState===WebSocket.OPEN;}
function unlockAudio(game){try{game.audio.ensure();if(game.audio.ctx&&game.audio.ctx.state==='suspended')game.audio.ctx.resume();}catch(e){}}

function Session(game){
 this.g=game;this.ws=null;this.url='';this.room='';this.clientId=clientId();this.sessionToken='';
 this.unitId=null;this.host=false;this.players=[];this.ready=false;this.started=false;this.closed=false;this.format='2v2';this.round=0;
 this.inputSequence=0;this.actionSequence=0;this.lastInput='';this.inputTimer=0;this.pingTimer=0;
 this.pending={};this.lastSnapshotAt=0;this.snapCount=0;this.snapRate=0;this.snapWindow=performance.now();
 this.rtt=0;this.lastActionMs=0;this.lastActionOk=true;this.lastActionReason='';this.lastActionAt=0;this.region='';this.instance='';
 this.reconnectAttempts=0;this.reconnectTimer=null;this.connectGeneration=0;this.lastWorld=null;
 this.presented={};this.countdownShown=0;this.lastServerPhase='lobby';this.lastMessageAt=0;this.lastResyncAt=0;
}
Session.prototype.status=function(text,bad){var el=$id('anStatus');if(el){el.textContent=text;el.style.color=bad?'#ff8d7a':'#9fe8b2';}};
Session.prototype.send=function(message){if(sendable(this.ws))try{this.ws.send(JSON.stringify(message));return true;}catch(e){}return false;};
Session.prototype.connect=function(url,room,creating,format){
 this.url=socketUrl(url||DEFAULT_SERVER);this.room=String(room||'').toUpperCase();this.format=format==='1v1'?'1v1':'2v2';this.closed=false;this.reconnectAttempts=0;
 try{this.sessionToken=sessionStorage.getItem(sessionKey(this.url,this.room))||'';}catch(e){this.sessionToken='';}
 this.open(creating);
};
Session.prototype.open=function(creating){
 var self=this,generation=++this.connectGeneration,ws;
 clearTimeout(this.reconnectTimer);this.status(this.started?'Reconnecting to the match…':creating?'Creating authoritative room…':'Joining authoritative room…');
 try{ws=new WebSocket(this.url);}catch(e){this.status('The server URL is invalid.',true);return;}
 this.ws=ws;
 var joinedThisSocket=false,handshake=null;
 var wake=setTimeout(function(){if(generation===self.connectGeneration&&!sendable(ws))self.status('The free server is waking up — please keep this tab open…');},3500);
 var connectLimit=setTimeout(function(){if(generation===self.connectGeneration&&!joinedThisSocket){self.status('The server did not complete a protocol-20 join. Confirm the matching authoritative Render server is deployed.',true);try{ws.close();}catch(e){}}},45000);
 ws.onopen=function(){
  clearTimeout(wake);if(generation!==self.connectGeneration)return;
  self.send({type:'join',protocol:PROTOCOL,roomCode:self.room,clientId:self.clientId,classId:selectedClass(),displayName:className(selectedClass())+' Player',talents:talentsFor(selectedClass()),sessionToken:self.sessionToken||null,format:self.format,itemLevel:990,normalizeGear:true,botRoster:'varied',botClasses:['disc','sage','pala','flame','storm','soul','shadow','wind','warrior'],botToolkitVersion:'current',botMoveSpeed:'class-parity',botMoveSpeedCap:6.35});
  handshake=setTimeout(function(){if(!joinedThisSocket){self.status('Connected, but this is not answering as the protocol-20 authoritative server.',true);try{ws.close();}catch(e){}}},10000);
 };
 ws.onmessage=function(event){if(generation!==self.connectGeneration)return;var message;try{message=JSON.parse(event.data);}catch(e){return;}self.lastMessageAt=performance.now();if(message.type==='joined'){joinedThisSocket=true;clearTimeout(handshake);clearTimeout(connectLimit);}try{self.onMessage(message);}catch(error){console.error('Authoritative message failed',message&&message.type,error);self.status('A match update could not be rendered; recovery is continuing.',true);}};
 ws.onerror=function(){clearTimeout(wake);};
 ws.onclose=function(){clearTimeout(wake);clearTimeout(handshake);clearTimeout(connectLimit);if(generation!==self.connectGeneration||self.closed)return;self.scheduleReconnect();};
};
Session.prototype.scheduleReconnect=function(){
 var self=this;if(this.closed)return;this.reconnectAttempts++;
 if(this.reconnectAttempts>12){this.status('Could not reconnect. The match session expired; create a fresh room.',true);return;}
 var delay=Math.min(5000,350*Math.pow(1.55,this.reconnectAttempts-1));
 this.status((this.started?'Connection interrupted — match preserved, retrying in ':'Server connection interrupted — retrying in ')+Math.ceil(delay/1000)+'s…',true);
 this.reconnectTimer=setTimeout(function(){self.open(false);},delay);
};
Session.prototype.close=function(){this.closed=true;clearTimeout(this.reconnectTimer);this.send({type:'leave'});try{this.ws&&this.ws.close();}catch(e){}this.ws=null;};
Session.prototype.start=function(){if(!this.host){this.status('Only the party leader can start the match.',true);return;}this.send({type:'start',format:this.format,itemLevel:990,normalizeGear:true,botRoster:'varied',botClasses:['disc','sage','pala','flame','storm','soul','shadow','wind','warrior'],botToolkitVersion:'current',botMoveSpeed:'class-parity',botMoveSpeedCap:6.35});this.status('Starting the shared server match…');};
Session.prototype.changeClass=function(){if(this.started)return;this.send({type:'class',classId:selectedClass(),talents:talentsFor(selectedClass()),itemLevel:990});};
Session.prototype.refreshLobby=function(){
 var roster=$id('anRoster'),start=$id('anStart');
 if(start){start.disabled=!(this.host&&this.ready&&!this.started);start.textContent=this.started?'Match running':'Start '+this.format.toUpperCase();}
 if(!roster)return;
 var expected=2,players=this.players.slice().sort(function(a,b){return String(a.slot).localeCompare(String(b.slot));});
 function card(p,index){var info=p&&CLASS_INFO[p.classId]||{},badge=info.badge||'◈',name=p?(p.displayName||('Player '+(index+1))):('Open slot '+(index+1)),state=p?(p.connected?'READY':'RECONNECTING'):'WAITING',team=this.format==='1v1'?(index===0?'BLUE SIDE':'RED SIDE'):'PARTY';return '<div class="an-player-card '+(p&&p.connected?'connected':'waiting')+'"><div class="an-avatar" style="--an-col:'+(info.colour?'#'+Number(info.colour).toString(16).padStart(6,'0'):'#678099')+'">'+badge+'</div><div><strong>'+name+'</strong><span>'+(p?className(p.classId):'Choose a class')+'</span><small>'+team+' · '+state+' · ILVL 990</small></div></div>';}
 var cards=[];for(var i=0;i<expected;i++)cards.push(card.call(this,players[i],i));
 roster.innerHTML='<div class="an-roster-title">'+this.format.toUpperCase()+' LOBBY · '+players.length+'/'+expected+' PLAYERS</div><div class="an-roster-grid">'+cards.join('')+'</div><div class="an-lobby-note">'+(this.format==='1v1'?'Player versus player duel. No bots are added.':'Two players versus a varied, class-balanced bot team. Bots and players use normalized item level 990 gear.')+'</div>';
};
Session.prototype.onMessage=function(message){
 if(message.type==='joined'){
  if(message.protocol!==PROTOCOL){this.status('Server/client version mismatch.',true);return;}
  this.unitId=message.unitId;this.host=!!message.host;this.sessionToken=message.sessionToken||'';this.players=message.players||[];this.format=message.format==='1v1'?'1v1':this.format;
  this.ready=!!message.ready;this.region=message.region||'';this.instance=message.instance||'';this.reconnectAttempts=0;
  try{sessionStorage.setItem(sessionKey(this.url,this.room),this.sessionToken);}catch(e){}
  this.status(message.phase==='running'?'Rejoined the authoritative match.':this.host?'Room ready — send the invite link.':'Joined — waiting for Player 1 to start.');
  this.refreshLobby();return;
 }
 if(message.type==='lobby'){
  this.players=message.players||[];this.ready=!!message.ready;this.format=message.format==='1v1'?'1v1':this.format;this.started=false;this.refreshLobby();
  if(!this.started)this.status(this.ready?(this.host?'Both players are ready — start the next round.':'Both players connected — waiting for the party leader.'):'Waiting for the second player…');
  return;
 }
 if(message.type==='startAck'){if(!message.ok)this.status('Could not start: '+reasonText(message.reason),true);return;}
 if(message.type==='matchStart'){this.format=message.format==='1v1'?'1v1':'2v2';this.spawn(message.world,message.phase,message.countdownRemaining);return;}
 if(message.type==='snapshot'){
  this.format=message.format==='1v1'?'1v1':this.format;
  if(!this.started)this.spawn(message.world,message.phase,message.countdownRemaining);
  this.applySnapshot(message.world,message.phase,message.countdownRemaining);return;
 }
 if(message.type==='events'){this.applyEvents(message.events||[]);return;}
 if(message.type==='actionAck'){this.applyActionAck(message);return;}
 if(message.type==='trinketAck'){if(!message.ok)this.g.message(reasonText(message.reason));return;}
 if(message.type==='pong'){this.rtt=Math.max(0,performance.now()-Number(message.clientTime||performance.now()));return;}
 if(message.type==='matchEnd'){this.endMatch(message);return;}
 if(message.type==='returnedToLobby'||message.type==='rematchReady'){this.started=false;this.lastServerPhase='lobby';this.players=message.players||this.players;this.ready=message.ready!==false;this.returnToLobby(false);return;}
 if(message.type==='replaced'){this.closed=true;this.status('This tab was replaced by a newer connection.',true);return;}
 if(message.type==='error'){
  if(message.reason==='expired_session'){try{sessionStorage.removeItem(sessionKey(this.url,this.room));}catch(e){}this.sessionToken='';}
  this.status(reasonText(message.reason),true);return;
 }
};
function reasonText(reason){return ({room_full:'That room already has two players.',waiting_for_player:'Waiting for Player 2.',host_only:'Only Player 1 can start.',version_mismatch:'Server/client version mismatch. Deploy both new files together.',expired_session:'The reconnect session expired. Create or join a fresh room.',match_started:'This match already started and needs the original reconnect token.',not_running:'The round is not accepting abilities yet.',unit_unavailable:'Your character is unavailable.',cooldown:'Ability is still on cooldown.',gcd:'Global cooldown is not ready.',resource:'Not enough resource.',range:'Target is out of range.',line_of_sight:'A pillar blocks line of sight.',crowd_controlled:'You are crowd controlled.',silenced:'You are silenced.',already_casting:'You are already casting.',school_locked:'That spell school is locked.',target_unavailable:'No valid target.',friendly_target_required:'That spell needs a friendly target.',enemy_target_required:'That spell needs an enemy target.',requires_skybreaker_pulse:'Volcanic Eruption requires Skybreaker Pulse first.',requires_fists_cooldown:'Whirling Dragon Punch requires Fists of Fury to be on cooldown.',ability_not_migrated:'That ability is not available on this server build.'})[reason]||String(reason||'Unknown server error');}
function movementLocked(unit){return !!(unit&&['iceBlock','furyStun','cheapStun','stun','poly','sleep','gouge','blind','windIncap','fear','root'].some(function(type){return unit.has&&unit.has(type);}));}

Session.prototype.spawn=function(world,phase,countdownRemaining){
 if(!world||!Array.isArray(world.units))return;
 var g=this.g,self=this;this.lastWorld=world;this.format=world.format==='1v1'?'1v1':this.format;
 var controlledSnapshot=world.units.filter(function(unit){return unit.id===self.unitId;})[0];this.serverTeam=controlledSnapshot&&controlledSnapshot.team||'allies';
 g.queueType='skirmish';g.mode=this.format;try{g.setArenaTheme(world.arena&&world.arena.theme||'runestone');}catch(e){}
 g.audio.ensure();g.audio.play('start');g.clear();g.cameraRig.yaw=-Math.PI/2;g.cameraRig.pitch=.34;g.cameraRig.distance=12.4;
 world.units.forEach(function(su){
  var team=su.team===self.serverTeam?'ally':'enemy';
  var name=su.displayName||(su.id==='player1'?'Player 1':su.id==='player2'?'Player 2':className(su.classId)+' Bot');
  var unit=g.spawn(name,su.classId,team,su.x,su.z,su.id===self.unitId);unit.netId=su.id;unit.ai=null;unit.onlineItemLevel=990;unit.netTalents=su.talents||{};if(BRIDGE.getNormalizedGearStats)unit.gearStats=BRIDGE.getNormalizedGearStats(su.classId,990);
 });
 this.started=true;this.closed=false;g.netGuest=true;g.netSession=this;this.lastServerPhase=phase||'countdown';g.phase=this.lastServerPhase==='running'?'fight':'countdown';g.count=Number(countdownRemaining)||3;g.time=world.time||0;g.dampening=world.dampening||0;g.paused=false;
 var foes=g.units.filter(function(unit){return unit.team==='enemy'&&unit.alive;});g.target=foes[0]||null;
 $id('menu').classList.add('hidden');$id('hud').classList.remove('hidden');$id('overlay').classList.add('hidden');hideLobby();
 g.renderFrames();g.renderActions();g.message(g.phase==='countdown'?'Begins in '+Math.max(1,Math.ceil(g.count)):'FIGHT!');
 this.applySnapshot(world,phase,countdownRemaining);
};
Session.prototype.byId=function(id){for(var i=0;i<this.g.units.length;i++)if(this.g.units[i].netId===id)return this.g.units[i];return null;};
Session.prototype.applySnapshot=function(world,phase,countdownRemaining){
 if(!world||!Array.isArray(world.units))return;var self=this,g=this.g;this.lastWorld=world;this.lastSnapshotAt=performance.now();this.snapCount++;
 world.units.forEach(function(su){if(self.byId(su.id)||!su.summonKind)return;var team=su.team===self.serverTeam?'ally':'enemy',unit=g.spawn(su.displayName||'Guardian Angel',su.classId==='pala'?'pala':su.classId,team,su.x,su.z,false);unit.netId=su.id;unit.ai=null;unit.netSummon=true;unit.summonKind=su.summonKind;unit.healingStreamTotem=true;if(su.summonKind==='guardianAngel'){try{g.vfxAvengingWings(unit,6);g.vfxOrbit(unit,0xffe6a1,1.1);}catch(e){}}});
 g.time=world.time;g.dampening=world.dampening;
 var serverPhase=phase||this.lastServerPhase||'running',was=this.lastServerPhase;this.lastServerPhase=serverPhase;
 if(serverPhase==='countdown'){g.phase='countdown';g.count=Math.max(0,Number(countdownRemaining)||0);}
 else if(serverPhase==='running'){g.phase='fight';if(was==='countdown'){g.count=0;g.message('FIGHT!');try{g.audio.play('start');}catch(e){}}}
 world.units.forEach(function(su){var unit=self.byId(su.id);if(!unit)return;
  var previous=unit.netTarget,sampleDt=previous?Number(world.time)-Number(previous.serverTime):0,vx=0,vz=0;
  if(sampleDt>.001&&sampleDt<.5){vx=(su.x-previous.x)/sampleDt;vz=(su.z-previous.z)/sampleDt;var speed=Math.hypot(vx,vz),speedEffect=su.effects&&(su.effects.divineSteed||su.effects.tigersLust||su.effects.freedom||su.effects.angelicBody),limit=speedEffect?9.2:6.35;if(speed>limit){vx=vx/speed*limit;vz=vz/speed*limit;}}
  unit.netTarget={x:su.x,z:su.z,vx:vx,vz:vz,receivedAt:performance.now(),serverTime:Number(world.time)||0,inputSequence:su.inputSequence};unit.netFocusId=su.targetId||null;unit.maxHp=su.maxHp;unit.maxResource=su.maxResource;unit.hp=su.hp;unit.shield=su.shield;unit.alive=!!su.alive;unit.trinketCd=su.trinketCooldown||0;
  if(unit===g.player)Object.keys(self.pending).forEach(function(key){if(Number(key)<=Number(su.actionSequence||-1))delete self.pending[key];});
  var hasPending=unit===g.player&&Object.keys(self.pending).some(function(key){return Number(key)>Number(su.actionSequence||-1);});
  if(!hasPending){unit.resource=su.resource;unit.gcd=su.gcd;unit.tigereyeStacks=su.tigereyeStacks||0;
   var list=AB[unit.cls]||[];for(var i=0;i<list.length;i++)unit.cds[i]=Number(su.cooldowns&&su.cooldowns[abilityId(unit.cls,list[i])]||0);
   self.syncCast(unit,su.cast);self.syncEffects(unit,su.effects||{});
  }
  var stats=su.stats||{};unit.stats={damage:stats.damage||0,healing:stats.healing||0,absorb:stats.absorb||0,interrupts:stats.interrupts||0,kb:stats.killingBlows||0,damageByAbility:stats.damageByAbility||{},damageByTarget:{},healingByAbility:stats.healingByAbility||{},healingByTarget:{}};
 });
 try{g.updateDetailsMeter();}catch(e){}
};
Session.prototype.syncCast=function(unit,cast){
 if(!cast){unit.cast=null;return;}var index=abilityIndex(unit.cls,cast.abilityId),ability=abilityForId(unit.cls,cast.abilityId)||{name:'Casting',school:'physical'};
 unit.cast={a:ability,index:index,netI:index,total:cast.duration,left:cast.remaining,target:this.byId(cast.targetId)||unit,school:ability.school,channel:!!cast.channel,uninterruptible:!!cast.uninterruptible,moveCast:!!cast.channel,soulDrain:ability.type==='soulDrain',discPenance:ability.type==='discPenance',bladestorm:ability.type==='bladestorm'};
};
Session.prototype.syncEffects=function(unit,effects){
 var kept=[];Object.keys(effects).forEach(function(effectKey){var source=effects[effectKey]||{},type=source.type||effectKey,effect=unit.effects.filter(function(entry){return entry.netEffectKey===effectKey;})[0]||{type:type,netEffectKey:effectKey};effect.type=type;effect.time=source.remaining;Object.keys(source).forEach(function(key){if(key!=='remaining'&&key!=='type')effect[key]=source[key];});kept.push(effect);});unit.effects=kept;
};
Session.prototype.applyEvents=function(events){
 var self=this,g=this.g;events.forEach(function(event){var source=self.byId(event.sourceId||event.unitId),target=self.byId(event.targetId||event.unitId);
  if(event.type==='castStarted'&&source){self.presentCast(source,event);return;}
  if(event.type==='actionComplete'&&source){self.presentComplete(source,event);return;}
  if(event.type==='castCancelled'&&source){source.cast=null;self.stopChannelFx(source);return;}
  if(event.type==='presentation'){self.presentPresentation(event,source,target);return;}
  if(event.type==='effectApplied'&&target){self.applyEffectEvent(target,event);return;}
  if(event.type==='effectRemoved'&&target){target.effects=target.effects.filter(function(effect){return event.effectKey?effect.netEffectKey!==event.effectKey:effect.type!==event.effect;});return;}
  if(event.type==='resourceStack'&&target){if(event.resource==='tigereye')target.tigereyeStacks=Number(event.stacks)||0;try{g.float(target,'TIGEREYE '+event.stacks,'info');}catch(e){}return;}
  if(event.type==='damage'&&target){g.float(target,'-'+event.amount,'damage',event.ability);self.presentCombatTick(source,target,event,false);if(!event.periodic)try{g.audio.playImpact(event.ability,source,target);}catch(e){}return;}
  if(event.type==='healing'&&target){g.float(target,'+'+event.amount,'heal',event.ability);self.presentCombatTick(source,target,event,true);return;}
  if(event.type==='interrupt'&&target){g.float(target,'INTERRUPTED','error');try{g.audio.play('interrupt',source||target);}catch(e){}return;}
  if(event.type==='death'&&target){target.alive=false;target.hp=0;try{target.fallToGround();g.audio.play('death',target);}catch(e){}return;}
  if(event.type==='trinket'&&target){g.float(target,'MEDALLION!','info');try{g.vfxGlyph(target,0xffd36b,.8);g.vfxNova(target,0xffe6a0,1.6,12);}catch(e){}return;}
  if(event.type==='spellReflected'&&source)g.float(source,'REFLECT!','info');
 });
};
Session.prototype.presentPresentation=function(event,source,target){
 var key='presentation:'+(event.id==null?[event.cue,event.sourceId,event.targetId,event.time].join(':'):event.id);if(this.presented[key])return;this.markPresented(key);var g=this.g,point={x:Number(event.x)||(target&&target.x)||0,z:Number(event.z)||(target&&target.z)||0};try{
  if(event.cue==='meteorfall'){this.vfxMeteorfall(source,point.x,point.z,Number(event.duration)||.98);if(source){g.float(source,'METEORFALL INCOMING','info');g.vfxGlyph(source,0xff7038,.85);}return;}
  if(event.cue==='meteorfallImpact'){g.vfxRing(point,0xff7038,7);g.vfxNova(point,0xff7038,3.5,25);g.vfxGlyph(point,0xffb24d,.8);g.audio.play('meteorImpact',target||source||point);g.shake=.24;if(source){g.float(source,'METEOR LANCE READY','info');g.vfxOrbit(source,0xffd067,1.2);}return;}
  if(event.cue==='livingBombExplosion'){g.vfxRing(target||point,0xff7038,4.2);g.vfxNova(target||point,0xff7038,2.6,20);g.vfxGlyph(target||point,0xffb24d,.75);g.audio.play('fireBurst',target||source||point);return;}
  if(event.cue==='bestowFaithComplete'&&target){g.vfxGlyph(target,0xffe28a,.85);g.vfxRing(target,0xffe28a,2.2);g.audio.play('holy',target);}
  if(event.cue==='stormbolt'&&source&&target){g.projectile(source,target,'stormbolt',function(){g.vfxNova(target,0xb785ff,1.5,12);g.vfxGlyph(target,0xcdb1ff,.62);});return;}
  if(event.cue==='touchOfDeathApplied'&&target){g.vfxTouchOfDeathMark(target,5);g.vfxRing(target,0xff405d,1.8);return;}
  if(event.cue==='touchOfDeathExplosion'&&target){g.vfxNova(target,0xffd86c,2.6,22);g.vfxRing(target,0xa875ff,3.4);g.shake=.16;return;}
  if(event.cue==='whirlingDragonPunch'&&source){g.vfxWhirlingDragonPunch(source,.85);g.vfxNova(source,0x72e5a5,2.1,18);g.float(source,'WHIRLING DRAGON PUNCH','info');return;}
  if(event.cue==='volcanicEruption'&&source&&target){g.projectile(source,target,'fire',function(){g.vfxVolcanicEruption(target);g.vfxNova(target,0xff6f2f,2.2,18);g.vfxRing(target,0xffb24d,2.8);g.vfxGlyph(target,0xffd069,.72);g.audio.playSample('volcanic_eruption',{gain:.78,rate:.86,cooldown:0,source:target});});return;}
  if(event.cue==='volcanicLavaBurst'&&source&&target){var bolt=Number(event.bolt)||1;g.projectile(source,target,'fire',function(){g.vfxNova(target,bolt===1?0xff8a35:0xffb04a,1.15,9);g.vfxGlyph(target,0xffce6b,.42);g.audio.play('fire',target);});return;}
  if(event.cue==='alterTimeSaved'&&source){g.vfxAlterTimeClock(source,Number(event.duration)||5);g.vfxRing(source,0x8b78ff,2.5);g.vfxGlyph(source,0xb5a7ff,.85);g.float(source,'ALTER TIME · 5s TO RETURN','info');g.audio.playSample('magic_buff',{gain:.56,cooldown:.08,source:source});return;}
  if(event.cue==='alterTimeReturn'&&source){if(source.alterTimeFx&&source.alterTimeFx.obj)source.alterTimeFx.obj.dead=true;source.alterTimeFx=null;g.vfxNova(source,0x8b78ff,2.2,18);g.vfxRing(source,0xd6cdff,3);g.float(source,'ALTER TIME RETURN','info');g.audio.playSample('rune_activate',{gain:.62,cooldown:.08,source:source});return;}
  if(event.cue==='shieldWall'&&source){g.vfxShieldWall(source,Number(event.duration)||6);g.float(source,'SHIELD WALL','info');return;}
  if(event.cue==='avatar'&&source){g.vfxAvatarForm(source,Number(event.duration)||10);g.vfxRing(source,0xe04d45,3.2);g.float(source,'AVATAR · STONE FORM','info');return;}
  if(event.cue==='avengingWings'&&source){g.vfxAvengingWings(source,Number(event.duration)||8);g.vfxGlyph(source,0xffe28a,1);g.float(source,'AVENGING WINGS · +20%','info');return;}
  if(event.cue==='guardianAngel'&&target){g.shieldBubble(target,0xffe6a1,Number(event.duration)||6);g.vfxAvengingWings(target,Number(event.duration)||6);g.float(target,'GUARDIAN ANGEL · IMMUNE','info');return;}
  if(event.cue==='infernalLanding'){g.vfxNova(target||point,0x65ff20,3.4,22);g.vfxRing(target||point,0x65ff20,5);g.shake=.22;return;}
  if(event.cue==='infernalSlam'&&source){g.animateAction(source,{name:'Infernal Slam',type:'damage'});g.vfxRing(source,0x65ff20,2.8);g.vfxNova(source,0x238b12,1.9,8);g.shake=.06;return;}
 }catch(e){}
};
Session.prototype.vfxMeteorfall=function(source,x,z,duration){var g=this.g,THREE=window.THREE;if(!THREE||!g.scene||!g.effects)return;var reduced=$id('reducedFX');if(reduced&&reduced.checked)return;var holder=new THREE.Group(),warning=new THREE.Mesh(new THREE.RingGeometry(.5,5,40),new THREE.MeshBasicMaterial({color:0xff5127,transparent:true,opacity:.62,side:THREE.DoubleSide}));warning.rotation.x=-Math.PI/2;warning.position.set(x,.06,z);holder.add(warning);var rock=new THREE.Mesh(new THREE.SphereGeometry(.62,12,10),new THREE.MeshStandardMaterial({color:0x402018,emissive:0xff5522,emissiveIntensity:1.1,roughness:.7}));rock.position.set(x+1.2,16,z-.8);holder.add(rock);var light=new THREE.PointLight(0xff5522,26,17);light.position.copy(rock.position);holder.add(light);g.scene.add(holder);var elapsed=0,dur=Math.max(.2,Number(duration)||.98);g.effects.push({obj:holder,life:dur+.06,update:function(dt){elapsed+=dt;warning.material.opacity=.32+Math.abs(Math.sin(elapsed*14))*.3;warning.scale.multiplyScalar(1+dt*.22);rock.position.y-=dt*(16/dur);rock.position.x-=dt*1.2;rock.position.z+=dt*.8;light.position.copy(rock.position);}});};
Session.prototype.applyEffectEvent=function(unit,event){
 var key=event.effectKey||event.effect,current=unit.effects.filter(function(effect){return effect.netEffectKey===key;})[0];if(!current){current={type:event.effect,netEffectKey:key};unit.effects.push(current);}current.time=Number(event.duration)||current.time||0;
};
Session.prototype.presentCombatTick=function(source,target,event,healing){
 var g=this.g,label=String(event.ability||'');try{
  if(source&&/Penance/i.test(label)){g.vfxDisciplineStarBolt(source,target,{healing:healing,penance:true,bolt:Number(event.tick)||0});g.vfxGlyph(target,healing?0xffffff:0xffe7ab,.45);return;}
  if(source&&/Essence Siphon/i.test(label)){g.vfxSiphonPulse(source,target,1);return;}
  if(source&&/Fists of Fury/i.test(label)){var key='fury:'+source.netId+':'+event.tick;if(!this.presented[key]){this.markPresented(key);g.vfxFuryPulse(source,5,Number(event.tick)||0);}return;}
  if(source&&/Bladestorm Tick/i.test(label)){var bladeKey='blade:'+source.netId+':'+event.tick;if(!this.presented[bladeKey]){this.markPresented(bladeKey);g.vfxNova(source,0xffc45c,1.2,7);}return;}
  if(healing)g.vfxGlyph(target,0x72ffc0,.45);
 }catch(e){}
};
Session.prototype.presentationKey=function(unit,event){if(event.sequence==null&&event.id!=null)return 'event:'+event.id;return String(event.type||'presentation')+':'+(unit&&unit.netId||event.unitId||'unit')+':'+String(event.sequence==null?'?':event.sequence);};
Session.prototype.markPresented=function(key){this.presented[key]=performance.now();var now=performance.now(),map=this.presented;Object.keys(map).forEach(function(entry){if(now-map[entry]>15000)delete map[entry];});};
Session.prototype.stopChannelFx=function(unit){['fistsFx','bladestormFx'].forEach(function(name){if(unit&&unit[name])unit[name].dead=true;if(unit)unit[name]=null;});};
Session.prototype.presentCast=function(unit,event){
 var g=this.g,index=abilityIndex(unit.cls,event.abilityId),ability=abilityForId(unit.cls,event.abilityId)||{name:'Casting',type:'damage',school:event.school||'physical',cast:event.duration||1};
 var key=this.presentationKey(unit,event),already=!!this.presented[key],target=this.byId(event.targetId)||unit,duration=Number(event.duration)||Number(ability.cast)||1;
 unit.cast={a:ability,index:index,netI:index,total:duration,left:duration,target:target,school:ability.school,channel:!!event.channel,uninterruptible:!!event.uninterruptible,moveCast:!!event.channel,soulDrain:ability.type==='soulDrain',discPenance:ability.type==='discPenance',bladestorm:ability.type==='bladestorm'};
 if(already)return;this.markPresented(key);try{g.animateAction(unit,ability);if(event.channel)g.audio.playAbility(ability,unit);else g.audio.play('cast',unit);
  if(ability.type==='fistsChannel')g.vfxFistsChannel(unit,duration);
  else if(ability.type==='bladestorm')g.vfxBladestormChannel(unit,duration);
  else if(ability.type==='soulDrain'&&target)g.vfxSiphonChannel(unit,target,duration);
  else if(ability.type==='discPenance')g.vfxGlyph(unit,0xd8c0ff,.9);
 }catch(e){}
};
Session.prototype.presentComplete=function(unit,event){
 var key=this.presentationKey(unit,event);if(this.presented[key])return;this.markPresented(key);
 var g=this.g,index=abilityIndex(unit.cls,event.abilityId),ability=abilityForId(unit.cls,event.abilityId)||{name:event.abilityId||'Ability',type:'damage',school:'physical'},target=this.byId(event.targetId)||unit;
 if(['fistsChannel','bladestorm','soulDrain','discPenance'].indexOf(ability.type)>=0)return;
 try{g.animateAction(unit,ability);g.audio.playAbility(ability,unit);var type=ability.type||'',school=ability.school||'',color=school==='fire'?0xff7038:school==='holy'?0xffe28a:school==='shadow'?0xa875ff:school==='wind'?0x72e5a5:school==='nature'||school==='heal'?0x72ffc0:school==='storm'?0x72dfff:0x9edcff;
  if(target&&['damage','poly','fear','sleep','soulDot','chiBurst'].indexOf(type)>=0){g.projectile(unit,target,school==='nature'?'heal':school,function(){});return;}
  if(target&&type==='discSmite'){g.projectile(unit,target,'holy',function(){});g.vfxGlyph(target,0xfff2b8,.52);return;}
  if(target&&type==='discSolace'){g.vfxDisciplineStarBolt(unit,target,{solace:true});g.vfxNova(target,0xffeeb0,1.05,9);return;}
  if(target&&type==='chain'){g.lightning(unit,target);return;}
  if(type==='flameNova'){g.vfxRing(unit,0x86d9ff,4);g.vfxNova(unit,0x9ce9ff,2.6,18);return;}
  if(target&&['heal','hot','holyLight'].indexOf(type)>=0){g.healBolt(unit,target);g.vfxGlyph(target,color,.52);return;}
  if(target&&['holyShock','cleanse','discShield','discMend','bigHeal','bestowFaith','ironbark'].indexOf(type)>=0){g.vfxGlyph(target,color,.75);g.vfxRing(target,color,1.8);return;}
  if(target&&['frostShock','flameShock','livingBomb'].indexOf(type)>=0){g.vfxGlyph(target,color,.68);g.vfxNova(target,color,1.15,9);return;}
  if(target&&['agony','unstableAffliction','dot','rend','gushingWound'].indexOf(type)>=0){g.vfxAfflictionApply(target,color,type==='unstableAffliction'?'unstable':'torment');return;}
  if(target&&['leap','charge','mortalSwing','pummel','windInterrupt','shadowInterrupt','windlordStrike','monkFinisher','slow','shiv','singleStun'].indexOf(type)>=0){g.vfxTrail(unit,color);g.vfxKickArc(target,color);return;}
  if(target&&['root','paladinStun','windIncap','gouge','blind'].indexOf(type)>=0){g.vfxGlyph(target,color,.82);g.vfxRing(target,color,2.1);g.vfxSpiral(target,color,.72);return;}
  if(type==='windStun'||type==='stun'||type==='discFear'||type==='shout'){g.vfxRing(unit,color,4);g.vfxNova(unit,color,1.6,12);return;}
  if(type==='discPenance')return;
  if(type==='painSuppression'&&target){g.vfxPainSuppression(target,5);g.vfxGlyph(target,color,1);return;}
  if(type==='iceBlock'){g.vfxIceBlock(unit,8);return;}
  if(type==='paladinSteed'){g.vfxDivineSteed(unit,3);return;}
  if(type==='monkDefensive'){g.vfxWillowGuard(unit,6);return;}
  if(type==='reflect'){g.vfxReflectWard(unit,2.5);return;}
  if(type==='combustion'){if(g.spawnCombustionVisuals)g.spawnCombustionVisuals(unit,8);g.vfxNova(unit,color,3,24);return;}
  if(type==='ultimateRadiance'){g.vfxRing(unit,0xe8e1ff,4.2);g.vfxNova(unit,0xffffff,2.4,20);return;}
  if(target&&target!==unit)g.vfxBurst(target,color,.48);else{g.vfxGlyph(unit,color,.62);g.vfxNova(unit,color,1.25,9);}
 }catch(e){}
};
Session.prototype.resolveTarget=function(ability,target){
 var g=this.g,p=g.player;if(!p)return null;
 var selfTypes=['buff','dash','defensive','shieldSelf','push','healerEscape','natureSwiftness','undyingResolve','monkDefensive','fistsChannel','whirlingDragonPunch','ghanir','ultimateRadiance','discFade','discFear','archangel','darkArchangel','angelicBody','flameNova','paladinGuard','paladinSteed','avengingWings','iceBlock','reflect','shout','warriorGuard','avatar','combustion','flameShield','evasion','cloak','crimsonVial','totemMastery','healingStreamTotem','stormkeeper','tigereyeBrew','karma','bladestorm','tigersLust'];
 var friendly=['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','freedom','guardianAngel','holyLight','sacrifice','bestowFaith','discShield','discMend','painSuppression'];
 if(selfTypes.indexOf(ability.type)>=0)return p;
 if(ability.type==='holyShock'||ability.type==='discPenance')return target&&target.alive?target:p;
 if(friendly.indexOf(ability.type)>=0)return target&&target.alive&&target.team===p.team?target:p;
 return target&&target.alive&&target.team!==p.team?target:g.closestEnemy(p);
};
Session.prototype.sendCast=function(index,target){
 var p=this.g.player,ability=p&&(AB[p.cls]||[])[index];if(!p||!ability||!this.started)return false;if(p.has('iceBlock')&&ability.type!=='iceBlock'){this.g.message('Cannot cast while inside Ice Block');return false;}if(ability.type==='whirlingDragonPunch'){var fists=(AB[p.cls]||[]).findIndex(function(spell){return spell.type==='fistsChannel';});if(fists<0||(p.cds[fists]||0)<=0){this.g.message('Whirling Dragon Punch requires Fists of Fury to be on cooldown.');return false;}}if(ability.type==='volcanicEruption'&&!p.has('volcanicEruptionReady')){this.g.message('Skybreaker Pulse must ready Volcanic Eruption first.');return false;}target=this.resolveTarget(ability,target);var sequence=++this.actionSequence,now=performance.now();
 var packet={type:'action',sequence:sequence,abilityId:abilityId(p.cls,ability),targetId:target&&target.netId||null};if(target&&target.groundTarget){packet.x=Number(target.x)||0;packet.z=Number(target.z)||0;packet.groundTarget=true;}
 this.pending[sequence]={at:now,index:index};this.predict(index,target,sequence);this.send(packet);return true;
};
Session.prototype.predict=function(index,target,sequence){
 var g=this.g,p=g.player,ability=(AB[p.cls]||[])[index];if(!ability)return;var cast=Number(ability.cast)||0,cost=Number(ability.cost)||0,cd=Number(ability.cd)||0;
 if(ability.name==='Cinder Bolt'&&p.has('instantBolt'))cast=0;if(ability.name==='Holy Light'&&p.has('infusion')){cast=.75;cost=0;}if(ability.name==='Arc Spark'&&p.has('stormkeeper')){cast=0;cost=0;cd=0;}if(ability.name==='Ember Lance'&&p.has('meteorLance'))cd=.4;if(ability.name==='Penance'&&p.has('radiantPenanceProc'))cast=1.05;if(ability.name==='Lullaby Bloom'&&p.has('natureSwiftness'))cast=0;if(ability.name==='Healing Surge')cd=0;
 var off=['interrupt','interruptProc','windInterrupt','shadowInterrupt','pummel','reflect','warriorGuard','avatar','natureSwiftness','iceBlock','tigereyeBrew','vendetta','shiv','combustion','flameNova','painSuppression','archangel','darkArchangel','angelicBody','avengingWings','singleStun','touchOfDeath','whirlingDragonPunch','volcanicEruption'].indexOf(ability.type)>=0||(ability.type==='leap'&&p.cls==='shadow')||['Garrote','Living Bomb'].indexOf(ability.name)>=0||(ability.name==='Arc Spark'&&p.has('stormkeeper'));
 if((!off&&p.gcd>.08)||(p.cds[index]||0)>.08||p.resource<cost)return;
 p.resource=Math.max(0,p.resource-cost);p.cds[index]=Math.max(p.cds[index]||0,cd);if(!off)p.gcd=p.cls==='soul'?.5:1;
 var channel=['fistsChannel','discPenance','soulDrain','bladestorm'].indexOf(ability.type)>=0,event={type:cast>0?'castStarted':'actionComplete',unitId:p.netId,abilityId:abilityId(p.cls,ability),targetId:target&&target.netId||p.netId,sequence:sequence,duration:cast,channel:channel,school:ability.school,uninterruptible:['fistsChannel','bladestorm'].indexOf(ability.type)>=0};
 if(cast>0){this.presentCast(p,event);if(p.cast){p.cast.netPredicted=true;p.cast.netAction=sequence;}}
 else this.presentComplete(p,event);
 try{g.renderActions();}catch(e){}
};
Session.prototype.applyActionAck=function(message){
 var pending=this.pending[message.sequence];if(!pending)return;this.lastActionMs=Math.round(performance.now()-pending.at);this.lastActionOk=!!message.ok;this.lastActionReason=message.ok?'':reasonText(message.reason);this.lastActionAt=performance.now();delete this.pending[message.sequence];
 if(!message.ok){if(this.g.player&&this.g.player.cast&&this.g.player.cast.netAction===message.sequence){this.g.player.cast=null;this.stopChannelFx(this.g.player);}this.g.message(reasonText(message.reason));}
 if(message.unit)this.applySnapshot({time:this.g.time,dampening:this.g.dampening,units:[message.unit]});
};
Session.prototype.sendInput=function(dt){
 this.inputTimer-=dt;var p=this.g.player,intent=p&&!movementLocked(p)?p.intent:null,key=intent?intent.x.toFixed(3)+','+intent.z.toFixed(3):'0';
 if(key!==this.lastInput||this.inputTimer<=0){this.inputTimer=.033;this.lastInput=key;this.send({type:'input',sequence:++this.inputSequence,x:intent?intent.x:0,z:intent?intent.z:0,locked:!!(p&&movementLocked(p))});}
};
Session.prototype.frame=function(dt){
 if(!this.started)return;var g=this.g,self=this,now=performance.now();
 this.pingTimer-=dt;if(this.pingTimer<=0){this.pingTimer=1;this.send({type:'ping',clientTime:performance.now()});}
 if(g.phase==='countdown'){
  g.count=Math.max(0,g.count-dt);var shown=Math.max(1,Math.ceil(g.count));if(shown!==this.countdownShown){this.countdownShown=shown;g.message('Begins in '+shown);}
 }
 if(g.phase==='fight'&&g.player&&g.player.alive){g.player.intent=movementLocked(g.player)?null:g.localMoveIntent();if(g.player.intent)g.unitMoveByIntent(g.player,dt);this.sendInput(dt);}
 g.units.forEach(function(unit){var target=unit.netTarget;if(target&&unit.alive){var own=unit===g.player,locked=movementLocked(unit),age=locked?0:Math.min(.085,Math.max(0,(now-target.receivedAt)/1000)),tx=target.x+(own?0:target.vx*age),tz=target.z+(own?0:target.vz*age),gap=Math.hypot(tx-unit.x,tz-unit.z);if(own){var moving=!!unit.intent&&!locked,ackLag=Math.max(0,self.inputSequence-Number(target.inputSequence||0));if(gap>4.5){unit.x=target.x;unit.z=target.z;}else if(!moving&&gap>.015){var settle=1-Math.exp(-dt*26);unit.x+=(target.x-unit.x)*settle;unit.z+=(target.z-unit.z)*settle;}else if(moving&&ackLag<=3&&gap>.48){var correction=1-Math.exp(-dt*2.4);unit.x+=(target.x-unit.x)*correction;unit.z+=(target.z-unit.z)*correction;}}else{var blend=1-Math.exp(-dt*27);unit.x+=(tx-unit.x)*blend;unit.z+=(tz-unit.z)*blend;}}unit.update(dt);});
 this.updateHud();var streamAge=this.lastSnapshotAt?now-this.lastSnapshotAt:0;if(streamAge>1200&&now-this.lastResyncAt>1000&&sendable(this.ws)){this.lastResyncAt=now;this.send({type:'resync'});}if(streamAge>5000&&sendable(this.ws)){self.status('State stream stalled for '+(streamAge/1000).toFixed(1)+'s — reconnecting automatically…',true);try{this.ws.close();}catch(e){}}
};
Session.prototype.guestFrame=Session.prototype.frame;
Session.prototype.updateHud=function(){
 var now=performance.now(),elapsed=now-this.snapWindow;if(elapsed>=1000){this.snapRate=Math.round(this.snapCount*1000/elapsed);this.snapCount=0;this.snapWindow=now;}
 var el=$id('anNetHud');if(!el){el=document.createElement('div');el.id='anNetHud';el.style.cssText='position:fixed;z-index:9;top:76px;left:50%;transform:translateX(-50%);padding:5px 10px;border-radius:12px;background:rgba(5,10,18,.82);border:1px solid rgba(105,220,240,.35);font:800 10px/1.2 Inter,Segoe UI,sans-serif;letter-spacing:.06em;color:#bff8ff;pointer-events:none';document.body.appendChild(el);}
 var age=this.lastSnapshotAt?now-this.lastSnapshotAt:9999,recentAction=this.lastActionAt&&now-this.lastActionAt<2800,rateText=this.snapRate?this.snapRate+' updates/s':age<650?'syncing…':'0 updates/s';el.style.color=age>900?'#ff7569':recentAction&&!this.lastActionOk?'#ffd27a':'#bff8ff';el.textContent=(this.region?this.region.toUpperCase()+' · ':'')+(this.instance?'#'+this.instance.slice(0,4)+' · ':'')+Math.round(this.rtt)+'ms RTT · '+rateText+(age>650?' · STREAM STALE '+(age/1000).toFixed(1)+'s':'')+(recentAction&&this.lastActionMs?' · action '+this.lastActionMs+'ms'+(this.lastActionOk?' OK':' REJECTED: '+this.lastActionReason):'');
};
var fullRateNetworkHud=Session.prototype.updateHud;
Session.prototype.updateHud=function(){var now=performance.now();if(now<(this.nextNetworkHudAt||0))return;this.nextNetworkHudAt=now+100;return fullRateNetworkHud.call(this);};
Session.prototype.useTrinket=function(){if(!this.started)return false;this.send({type:'trinket'});return true;};
Session.prototype.endMatch=function(message){if(!this.started)return;var self=this,won=message&&typeof message.winnerTeam==='string'?message.winnerTeam===this.serverTeam:this.g.units.some(function(u){return u.team==='ally'&&u.alive&&!u.netSummon;});this.started=false;this.lastServerPhase='ended';this.g.netGuest=false;this.g.netSession=this;try{this.g.finish(won);}catch(e){}setTimeout(function(){var actions=document.querySelector('#overlay .result-actions');if(actions&&!$id('anPartyLobby')){var button=document.createElement('button');button.id='anPartyLobby';button.className='main-btn';button.textContent='Return to Party Lobby';button.onclick=function(){self.returnToLobby(true);};actions.prepend(button);}},900);};
Session.prototype.returnToLobby=function(notifyServer){
 if(notifyServer!==false)this.send({type:'returnToLobby',format:this.format,itemLevel:990,keepParty:true});this.started=false;this.lastServerPhase='lobby';this.g.netGuest=false;this.g.netSession=this;try{this.g.returnMenu();}catch(e){}showLobby();this.refreshLobby();this.status(this.host?'Party preserved — start another round when both players are ready.':'Party preserved — waiting for the leader to start another round.');
};
Session.prototype.leave=function(){this.close();this.started=false;this.g.netGuest=false;if(this.g.netSession===this)this.g.netSession=null;var hud=$id('anNetHud');if(hud)hud.remove();};

function buildUI(game){
 var css=document.createElement('style');css.textContent='#anBtn,#anChangelogBtn{position:fixed;right:18px;z-index:90;padding:12px 16px;border-radius:12px;font-weight:900;cursor:pointer;letter-spacing:.06em}#anBtn{bottom:66px;border:1px solid rgba(120,255,180,.45);background:linear-gradient(180deg,rgba(20,40,30,.92),rgba(8,14,12,.95));color:#c8ffe2}#anChangelogBtn{bottom:18px;border:1px solid rgba(244,205,89,.42);background:linear-gradient(180deg,rgba(48,38,17,.94),rgba(13,11,7,.96));color:#ffe58f}#anPanel{position:fixed;inset:0;z-index:140;display:grid;place-items:center;background:rgba(0,0,0,.62)}#anPanel.hidden{display:none}#anCard{width:min(590px,calc(100vw - 40px));border:1px solid rgba(120,255,180,.35);border-radius:16px;background:linear-gradient(180deg,rgba(16,24,20,.98),rgba(6,10,9,.98));padding:18px;color:#dff5ea;font-size:14px}#anCard h2{margin:0 0 4px;color:#9dffc9;letter-spacing:.1em}#anCard .an-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}#anCard button{padding:9px 13px;border-radius:10px;border:1px solid rgba(120,255,180,.4);background:rgba(255,255,255,.05);color:#d9ffe9;font-weight:800;cursor:pointer}#anCard button:disabled{opacity:.42;cursor:not-allowed}#anCard input{flex:1;min-width:140px;padding:9px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.4);color:#eafff3}#anStatus{margin-top:10px;min-height:18px;font-size:12.5px;color:#9fe8b2}#anRoster{margin-top:10px;font-size:13px;line-height:1.5}#anClose{float:right}';document.head.appendChild(css);
 css.textContent+='#anCard select{flex:1;min-width:170px;padding:10px;border-radius:10px;border:1px solid rgba(120,255,180,.32);background:#0b1713;color:#eafff3;font-weight:800}.an-roster-title{margin:14px 0 8px;color:#aefbd0;font-size:11px;font-weight:900;letter-spacing:.12em}.an-roster-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.an-player-card{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:13px;background:rgba(255,255,255,.035)}.an-player-card.connected{border-color:rgba(120,255,180,.42);background:rgba(55,154,101,.10)}.an-avatar{width:48px;height:48px;display:grid;place-items:center;border-radius:50%;font-size:25px;background:radial-gradient(circle at 35% 28%,color-mix(in srgb,var(--an-col) 75%,white),color-mix(in srgb,var(--an-col) 55%,#07110e));border:2px solid color-mix(in srgb,var(--an-col) 72%,white);box-shadow:0 0 16px color-mix(in srgb,var(--an-col) 40%,transparent)}.an-player-card strong,.an-player-card span,.an-player-card small{display:block}.an-player-card span{color:#d9ffe9}.an-player-card small{color:#90b5a0;font-size:9px;font-weight:800;letter-spacing:.07em}.an-lobby-note{margin-top:10px;padding:9px 11px;border-radius:10px;background:rgba(115,207,255,.07);color:#afd6ca;font-size:11px;line-height:1.45}@media(max-width:560px){.an-roster-grid{grid-template-columns:1fr}}';
 var button=document.createElement('button');button.id='anBtn';button.textContent='🌐 Play Online';document.body.appendChild(button);
 var changelogButton=document.createElement('button');changelogButton.id='anChangelogBtn';changelogButton.textContent='📜 Change Log';changelogButton.onclick=function(){var modal=$id('changelogModal');if(modal)modal.classList.remove('hidden');};document.body.appendChild(changelogButton);
 var panel=document.createElement('div');panel.id='anPanel';panel.className='hidden';panel.innerHTML='<div id="anCard"><button id="anClose">✕</button><h2>AETHERFALL ONLINE LOBBY</h2><div style="opacity:.8">Create a private party, choose a PvP duel or a two-player bot arena, and play with normalized item level 990 gear.</div><div class="an-row"><select id="anFormat"><option value="2v2">2v2 · Two players versus varied bots</option><option value="1v1">1v1 · Player versus player</option></select><button id="anCreate">Create Lobby</button></div><div class="an-row" id="anHostRow" style="display:none"><input id="anRoomOut" readonly aria-label="Private lobby invite"><button id="anCopy">Copy Invite</button><button id="anStart" disabled>Start Match</button></div><div class="an-row"><input id="anJoinIn" placeholder="Paste a private lobby invite"><button id="anJoin">Join / Retry</button><button id="anReset">Disconnect</button></div><div id="anRoster"></div><div id="anStatus"></div></div>';document.body.appendChild(panel);
 function session(){if(!window.__aetherNet)window.__aetherNet=new Session(game);return window.__aetherNet;}
 button.onclick=function(){unlockAudio(game);showLobby();};$id('anClose').onclick=function(){hideLobby();};
 var soundToggle=$id('soundEnabled'),soundVolume=$id('soundVolume'),soundLabel=$id('soundVolumeLabel');if(soundToggle)soundToggle.checked=game.audio.enabled!==false;if(soundVolume)soundVolume.value=String(Math.round((game.audio.volume||.34)*100));if(soundLabel)soundLabel.textContent=Math.round((game.audio.volume||.34)*100)+'%';
 $id('anCreate').onclick=function(){unlockAudio(game);var code=roomCode(),format=$id('anFormat').value==='1v1'?'1v1':'2v2',s=session();s.connect(DEFAULT_SERVER,code,true,format);var invite=location.origin+location.pathname+'#arena='+code+'&format='+format;$id('anRoomOut').value=invite;$id('anHostRow').style.display='flex';};
 $id('anCopy').onclick=function(){var value=$id('anRoomOut').value;try{navigator.clipboard.writeText(value);}catch(e){$id('anRoomOut').select();document.execCommand('copy');}};
 $id('anStart').onclick=function(){unlockAudio(game);session().start();};
 $id('anFormat').onchange=function(){if(window.__aetherNet&&!window.__aetherNet.started){window.__aetherNet.format=this.value==='1v1'?'1v1':'2v2';window.__aetherNet.send({type:'format',format:window.__aetherNet.format,itemLevel:990,botRoster:'varied',botMoveSpeed:'class-parity'});window.__aetherNet.refreshLobby();}};
 $id('anJoin').onclick=function(){unlockAudio(game);var value=$id('anJoinIn').value.trim(),modern=value.match(/#arena=([A-Za-z0-9_-]+)(?:&format=(1v1|2v2))?/),legacy=value.match(/#coop=([A-Za-z0-9_-]+)&server=([^&]+)/),code=modern&&modern[1]||legacy&&legacy[1],format=modern&&modern[2]||'2v2',url=legacy?decodeURIComponent(legacy[2]):DEFAULT_SERVER;if(!code){session().status('That is not a valid Aetherfall lobby invite.',true);return;}$id('anFormat').value=format;session().connect(url,code,false,format);};
 $id('anReset').onclick=function(){if(window.__aetherNet){window.__aetherNet.leave();window.__aetherNet=null;}session().status('Disconnected. You can create or join a fresh room.');};
 var select=$id('classSelect');if(select)select.addEventListener('change',function(){if(window.__aetherNet)window.__aetherNet.changeClass();});
 var hash=location.hash.match(/#(?:arena|coop)=/);if(hash){showLobby();$id('anJoinIn').value=location.href;setTimeout(function(){$id('anJoin').click();},350);}
 setInterval(function(){var visible=game.phase==='menu'?'block':'none';button.style.display=visible;changelogButton.style.display=visible;},500);
 var originalTrinket=game.useTrinket.bind(game);game.useTrinket=function(unit,fromAI){if(game.netSession&&game.netSession.started&&(unit||game.player)===game.player)return game.netSession.useTrinket();return originalTrinket(unit,fromAI);};
 var originalMount=game.tryMount.bind(game);game.tryMount=function(unit,announce){if(game.netSession&&game.netSession.started){game.message('Mounts are disabled during authoritative co-op.');return false;}return originalMount(unit,announce);};
 var originalReturn=game.returnMenu.bind(game);game.returnMenu=function(){if(window.__aetherNet&&window.__aetherNet.started)window.__aetherNet.leave();return originalReturn();};
 window.addEventListener('beforeunload',function(){if(window.__aetherNet)window.__aetherNet.close();});
}
whenGame(buildUI);
})();
