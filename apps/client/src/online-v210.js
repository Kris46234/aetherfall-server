/* Aetherfall Online (v210): co-op only, atomic acknowledged match start,
   resilient actions/input, complete combat-state replication, WebRTC gameplay
   and relay fallback. */
(function(){
'use strict';
var NET_VERSION=7;
var BRIDGE=window.AETHER_ONLINE_BRIDGE||{};
var CLASS_INFO=BRIDGE.CLASS_INFO||{};
var AB=BRIDGE.AB||{};
var AIController=BRIDGE.AIController;
function currentProgression(){return BRIDGE.getProgression?BRIDGE.getProgression():(window.progression||{talents:{}});}
function classLabel(cls){return CLASS_INFO[cls]&&CLASS_INFO[cls].name||String(cls||'Unknown');}
function hideLobby(){var panel=$id('anPanel');if(panel)panel.classList.add('hidden');}
function $id(x){return document.getElementById(x);}
function whenGame(fn){var t=setInterval(function(){if(window.game){clearInterval(t);try{fn(window.game);}catch(e){console.error('AetherNet init failed',e);}}},120);}

/* ---------------- transports ---------------- */
function TabTransport(room){
 this.ch=new BroadcastChannel('aether-net-'+room);this.tag=Math.random().toString(36).slice(2);
 var self=this;this.ch.onmessage=function(ev){var d=ev.data;if(d&&d.__tag!==self.tag&&self._fn)self._fn(d);};
}
TabTransport.prototype.send=function(o){o.__tag=this.tag;try{this.ch.postMessage(o);}catch(e){}};
TabTransport.prototype.onMessage=function(fn){this._fn=fn;};
TabTransport.prototype.close=function(){try{this.ch.close();}catch(e){}};

function loadPeerJs(cb,err){
 if(window.Peer)return cb();
 var s=document.createElement('script');s.src='https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
 s.onload=function(){cb();};s.onerror=function(){err('Could not load PeerJS (are you online?)');};
 document.head.appendChild(s);
}
var ICE_CONFIG={iceServers:[
 {urls:'stun:stun.l.google.com:19302'},
 {urls:'stun:stun1.l.google.com:19302'},
 {urls:'turn:openrelay.metered.ca:80',username:'openrelayproject',credential:'openrelayproject'},
 {urls:'turn:openrelay.metered.ca:443',username:'openrelayproject',credential:'openrelayproject'},
 {urls:'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject',credential:'openrelayproject'}
]};
function makePeer(status){
 var p=new Peer({config:ICE_CONFIG,debug:1});
 p.on('disconnected',function(){status&&status('Signaling dropped — reconnecting…',true);try{p.reconnect();}catch(e){}});
 return p;
}
function watchIce(conn,status){
 var iv=setInterval(function(){
  var pc=conn.peerConnection;
  if(!pc){return;}
  var st=pc.iceConnectionState;
  if(st==='checking')status('Negotiating a route between your networks…');
  if(st==='connected'||st==='completed'){clearInterval(iv);}
  if(st==='failed'){clearInterval(iv);status('Direct + relay route both failed. One side is likely on a very strict network (corporate/VPN/mobile carrier). Try a different network or hotspot.',true);}
 },700);
 conn.on('close',function(){clearInterval(iv);});
 return iv;
}
function PeerTransport(){this.conn=null;this.peer=null;this.status=null;}
PeerTransport.prototype.host=function(onId,onConn,onErr){var self=this;loadPeerJs(function(){
 self.peer=makePeer(self.status);self.peer.on('open',function(id){onId(id);});
 self.peer.on('connection',function(c){
  self.conn=c;if(self.status)self.status('Friend found — negotiating connection…');
  if(self.status)watchIce(c,self.status);
  c.on('data',function(d){if(self._fn)self._fn(d);});
  c.on('open',function(){onConn();});
  c.on('error',function(e){onErr('conn: '+String(e&&e.type||e));});
  c.on('close',function(){if(self._onClose)self._onClose();});});
 self.peer.on('error',function(e){onErr(String(e&&e.type||e));});},onErr);};
PeerTransport.prototype.join=function(hostId,onOpen,onErr){var self=this;loadPeerJs(function(){
 self.peer=makePeer(self.status);
 if(self.status)self.status('Reaching signaling server…');
 self.peer.on('open',function(){
  if(self.status)self.status('Signaling ok — contacting host…');
  self.conn=self.peer.connect(hostId,{reliable:true});
  if(self.status)watchIce(self.conn,self.status);
  var opened=false;
  var to=setTimeout(function(){
   if(!opened)self.status&&self.status('Still trying (20s)… If this never completes: 1) confirm the HOST lobby is still open, 2) both of you avoid VPNs, 3) try phone hotspot on one side. The relay servers are free/public and occasionally busy — retrying can also work.',true);
  },20000);
  self.conn.on('data',function(d){if(self._fn)self._fn(d);});
  self.conn.on('open',function(){opened=true;clearTimeout(to);onOpen();});
  self.conn.on('error',function(e){onErr('conn: '+String(e&&e.type||e));});
  self.conn.on('close',function(){clearTimeout(to);if(self._onClose)self._onClose();});});
 self.peer.on('error',function(e){onErr(String(e&&e.type||e)+(String(e&&e.type)==='peer-unavailable'?' — the host lobby is not open (host must create the lobby first and keep that tab in the foreground).':''));});},onErr);};
PeerTransport.prototype.send=function(o){try{if(this.conn&&this.conn.open)this.conn.send(o);}catch(e){}};
PeerTransport.prototype.onMessage=function(fn){this._fn=fn;};
PeerTransport.prototype.onClose=function(fn){this._onClose=fn;};
PeerTransport.prototype.close=function(){try{this.conn&&this.conn.close();this.peer&&this.peer.destroy();}catch(e){}};

/* ---------------- relay transport (WebSocket forwarder; works through any NAT) -------- */
function relayClientId(role){
 var key='aetherRelayClient_'+role,id='';try{id=sessionStorage.getItem(key)||'';}catch(e){}
 if(!id){id=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36));try{sessionStorage.setItem(key,id);}catch(e){}}
 return id;
}
function RelayTransport(url,room,role){
 url=String(url||'').trim();
 if(/^http/i.test(url))url=url.replace(/^http/i,'ws');
 if(!/^wss?:\/\//i.test(url))url='wss://'+url;
 this.url=url.replace(/\/+$/,'');this.room=room;this.role=role;this.clientId=relayClientId(role);this.ws=null;this._fn=null;this._onClose=null;this._onPeer=null;this.pingIv=null;this._closed=false;this.joined=false;this.rtt=0;this.route='relay';this.pc=null;this.dcReliable=null;this.dcState=null;this._iceQueue=[];this.statusCb=null;this.directStarted=false;
}
RelayTransport.prototype.open=function(onUp,onErr,statusCb){
 var self=this;this.statusCb=statusCb;
 var patience=setTimeout(function(){statusCb&&statusCb('Relay is waking up (free tiers sleep when idle) \u2014 this can take up to a minute\u2026');},4000);
 var giveUp=setTimeout(function(){if(!self.joined){onErr('The relay opened but did not finish joining. Confirm its browser page says \u201cAetherfall relay v3 OK\u201d, then retry.');try{self.ws&&self.ws.close();}catch(e){}}},75000);
 var ws;
 try{ws=new WebSocket(this.url);}catch(e){clearTimeout(patience);clearTimeout(giveUp);onErr('That relay URL is not valid.');return;}
 this.ws=ws;
 ws.onopen=function(){clearTimeout(patience);ws.send(JSON.stringify({__join:self.room,role:self.role,clientId:self.clientId,protocol:6}));};
 ws.onmessage=function(ev){
  var d;try{d=JSON.parse(ev.data);}catch(e){return;}
  if(d.__ping)return;
  if(d.__pong){self.rtt=Math.max(0,Date.now()-Number(d.__pong));return;}
  if(d.__sys==='joined'){
   clearTimeout(giveUp);
   if(d.relay!==3){onErr('Relay upgrade required — replace the Deno code with deno_relay.ts v3, Save & Deploy, then retry.');self._closed=true;try{ws.close();}catch(e){}return;}
   self.joined=true;onUp(d);if(d.ready){if(self._onPeer)self._onPeer();self.beginDirect();}return;
  }
  if(d.__sys==='ready'){if(self._onPeer)self._onPeer();self.beginDirect();return;}
  if(d.__sys==='full'){onErr('This is the old relay behavior. Deploy deno_relay.ts v3, then create a fresh invite.');return;}
  if(d.__sys==='peer'){if(self._onPeer)self._onPeer();self.beginDirect();return;}
  if(d.__sys==='upgrade_required'){onErr('Relay upgrade required — deploy the supplied deno_relay.ts v3.');return;}
  if(d.__sys==='replaced'){self._closed=true;statusCb&&statusCb('This connection was replaced by a newer attempt from the same role.');try{ws.close();}catch(e){}return;}
  if(d.__sys==='peergone'){if(self._onClose)self._onClose();return;}
  if(d.__signal){self.handleSignal(d.__signal);return;}
  if(self._fn)self._fn(d);
 };
 ws.onerror=function(){clearTimeout(patience);};
 ws.onclose=function(){clearTimeout(patience);clearTimeout(giveUp);if(self._closed)return;if(self.route==='direct'){statusCb&&statusCb('Direct route active \u00b7 relay fallback disconnected.');return;}if(self._onClose)self._onClose();};
 this.pingIv=setInterval(function(){try{if(self.ws&&self.ws.readyState===1)self.ws.send(JSON.stringify({__ping:Date.now()}));}catch(e){}},2000);
};
RelayTransport.prototype.signal=function(data){try{if(this.ws&&this.ws.readyState===1)this.ws.send(JSON.stringify({__signal:data}));}catch(e){}};
RelayTransport.prototype.configureChannel=function(channel,kind){
 var self=this;if(!channel)return;channel.binaryType='arraybuffer';
 if(kind==='state')this.dcState=channel;else this.dcReliable=channel;
 channel.onopen=function(){
  if(kind==='reliable'){self.route='direct';self.statusCb&&self.statusCb('Direct low-latency route active · relay fallback standing by.');}
 };
 channel.onmessage=function(ev){var d;try{d=JSON.parse(typeof ev.data==='string'?ev.data:new TextDecoder().decode(ev.data));}catch(e){return;}if(self._fn)self._fn(d);};
 channel.onclose=function(){if(kind==='reliable'){self.route='relay';if(self.ws&&self.ws.readyState===1)self.statusCb&&self.statusCb('Direct route unavailable · continuing through relay fallback.');else if(!self._closed&&self._onClose)self._onClose();}};
};
RelayTransport.prototype.ensurePeer=function(){
 if(this.pc)return this.pc;var self=this;
 var pc=new RTCPeerConnection(ICE_CONFIG);this.pc=pc;
 pc.onicecandidate=function(ev){if(ev.candidate)self.signal({candidate:ev.candidate.toJSON?ev.candidate.toJSON():ev.candidate});};
 pc.ondatachannel=function(ev){self.configureChannel(ev.channel,ev.channel.label==='state'?'state':'reliable');};
 pc.onconnectionstatechange=function(){var st=pc.connectionState;if(st==='failed'||st==='closed'){self.route='relay';self.statusCb&&self.statusCb('Direct route failed · relay fallback active.');}};
 return pc;
};
RelayTransport.prototype.beginDirect=async function(){
 if(this.directStarted||this.role!=='host'||typeof RTCPeerConnection==='undefined')return;this.directStarted=true;
 try{var pc=this.ensurePeer();this.configureChannel(pc.createDataChannel('reliable',{ordered:true}),'reliable');this.configureChannel(pc.createDataChannel('state',{ordered:false,maxRetransmits:0}),'state');var offer=await pc.createOffer();await pc.setLocalDescription(offer);this.signal({description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});}catch(e){this.route='relay';this.statusCb&&this.statusCb('Direct setup unavailable · using relay fallback.');}
};
RelayTransport.prototype.handleSignal=async function(sig){
 if(typeof RTCPeerConnection==='undefined')return;try{
  var pc=this.ensurePeer();
  if(sig.description){await pc.setRemoteDescription(sig.description);while(this._iceQueue.length)await pc.addIceCandidate(this._iceQueue.shift());if(sig.description.type==='offer'){var answer=await pc.createAnswer();await pc.setLocalDescription(answer);this.signal({description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});}}
  else if(sig.candidate){if(pc.remoteDescription)await pc.addIceCandidate(sig.candidate);else this._iceQueue.push(sig.candidate);}
 }catch(e){this.route='relay';this.statusCb&&this.statusCb('Direct negotiation failed · relay fallback active.');}
};
RelayTransport.prototype.send=function(o){try{
 var payload=JSON.stringify(o),state=o&&(o.t==='snap'||o.t==='in');
 var channel=state?this.dcState:this.dcReliable;
 if(this.route==='direct'&&channel&&channel.readyState==='open'){
  if(state&&channel.bufferedAmount>12288)return;
  channel.send(payload);return;
 }
 if(!this.ws||this.ws.readyState!==1)return;
 /* A snapshot is disposable: when a connection is congested, sending an older
    world state only grows the queue and makes the guest fall further behind. */
 if(o&&(o.t==='snap'||o.t==='in')&&this.ws.bufferedAmount>24576)return;
 this.ws.send(payload);
}catch(e){}};
/* Always use the relay socket. This is the escape hatch when a WebRTC data
   channel still reports "open" but has stopped delivering application data. */
RelayTransport.prototype.sendRelay=function(o){try{
 if(this.ws&&this.ws.readyState===1)this.ws.send(JSON.stringify(o));
}catch(e){}};
RelayTransport.prototype.fallbackToRelay=function(reason){
 if(this.route==='relay')return;
 this.route='relay';this.directStarted=true;
 try{if(this.dcState)this.dcState.close();if(this.dcReliable)this.dcReliable.close();if(this.pc)this.pc.close();}catch(e){}
 this.dcState=null;this.dcReliable=null;this.pc=null;
 if(this.statusCb)this.statusCb('Direct route stalled · relay fallback active'+(reason?' ('+reason+')':''));
};
RelayTransport.prototype.onMessage=function(fn){this._fn=fn;};
RelayTransport.prototype.onClose=function(fn){this._onClose=fn;};
RelayTransport.prototype.close=function(){this._closed=true;clearInterval(this.pingIv);try{this.dcState&&this.dcState.close();this.dcReliable&&this.dcReliable.close();this.pc&&this.pc.close();this.ws&&this.ws.close();}catch(e){}};

/* ---------------- session ---------------- */
function NetSession(game){
 this.g=game;this.role=null;this.tp=null;this.connected=false;this.guest=null;
 this.mode='coop';this.myTeam='ally';this.snapTimer=0;this.outbox=[];this.lastSnap=null;
 this.intentTimer=0;this.intentReliableTimer=0;this.lastIntent='';this.inputSeq=0;this.hostGuestInputSeq=0;this._origs={};this.guestUnitId=null;this.started=false;
 this.actionSeq=0;this.pendingActions={};this.processedActions={};this.processedActionOrder=[];this.lastSnapshotAt=0;this.eventTimer=0;this.statsTimer=0;this.lastCastSignals={};
 this.snapCount=0;this.snapRate=0;this.snapWindowAt=performance.now();this.lastActionMs=0;this.lastActionOk=true;this.hudTimer=0;
 this.pingTimer=0;this.netRtt=0;this.recoveryAt=0;
 this.helloSent=false;this.connectionState='idle';this.pendingStart=null;this.startRetry=null;this.matchId=null;this.hostClass=null;
}
NetSession.prototype.byId=function(id){var us=this.g.units;for(var i=0;i<us.length;i++)if(us[i].netId===id)return us[i];return null;};
NetSession.prototype.send=function(o){if(this.tp)this.tp.send(o);};
NetSession.prototype.setStatus=function(t,bad){var el=$id('anStatus');if(el){el.textContent=t;el.style.color=bad?'#ff8d7a':'#9fe8b2';}};
NetSession.prototype.prepareConnection=function(role){
 if(this.tp){try{this.tp.close();}catch(e){}}
 clearInterval(this.startRetry);this.startRetry=null;this.pendingStart=null;this.matchId=null;
 this.tp=null;this.role=role;this.mode='coop';this.connected=false;this.guest=null;this.hostClass=null;this.started=false;this._left=false;this.helloSent=false;this.connectionState='connecting';
 this.inputSeq=0;this.hostGuestInputSeq=0;this.lastIntent='';this.processedActions={};this.processedActionOrder=[];this.pendingActions={};this.lastSnapshotAt=0;this.netRtt=0;this.recoveryAt=0;
};

/* host: relay floats/logs/vfx/audio to the guest by wrapping emitters for the session */
NetSession.prototype.installHostRelays=function(){
 var g=this.g,self=this,o=this._origs;
 o.float=g.float.bind(g);g.float=function(t,txt,kind,label){if(t&&t.netId!=null)self.outbox.push({k:'fl',u:t.netId,x:String(txt),kd:kind,lb:label});return o.float(t,txt,kind,label);};
 o.log=g.log.bind(g);g.log=function(t){self.outbox.push({k:'lg',x:String(t)});return o.log(t);};
 o.finish=g.finish.bind(g);g.finish=function(won){self.send({t:'end',allyWon:!!won});return o.finish(won);};
 o.playAbility=g.audio.playAbility.bind(g.audio);g.audio.playAbility=function(a,c){self.outbox.push({k:'sa',n:a&&a.name,ty:a&&a.type,s:a&&a.school,c:c&&c.cls});return o.playAbility(a,c);};
 o.playImpact=g.audio.playImpact.bind(g.audio);g.audio.playImpact=function(lb){self.outbox.push({k:'im',lb:lb});return o.playImpact(lb);};
 var vfx=['vfxRing','vfxNova','vfxGlyph','vfxBurst','vfxSpiral','vfxOrbit','vfxTrail','vfxKickArc','vfxCyclone','vfxAfflictionApply','shieldBubble'];
 vfx.forEach(function(name){ if(typeof g[name]!=='function')return; var orig=g[name].bind(g); o[name]=orig;
  g[name]=function(t){var args=Array.prototype.slice.call(arguments,1).filter(function(x){return typeof x==='number'||typeof x==='string';});
   if(t&&t.netId!=null)self.outbox.push({k:'vx',m:name,u:t.netId,a:args});
   else if(t&&typeof t.x==='number')self.outbox.push({k:'vx',m:name,p:[+t.x.toFixed(1),+t.z.toFixed(1)],a:args});
   return orig.apply(null,arguments);};});
};
NetSession.prototype.uninstall=function(){var g=this.g,o=this._origs;
 if(o.float)g.float=o.float; if(o.log)g.log=o.log; if(o.finish)g.finish=o.finish;
 if(o.playAbility)g.audio.playAbility=o.playAbility; if(o.playImpact)g.audio.playImpact=o.playImpact;
 for(var k in o)if(k.indexOf('vfx')===0||k==='shieldBubble')g[k]=o[k];
 this._origs={};};

/* ---------------- host flow ---------------- */
NetSession.prototype.hostRelay=function(url){
 var self=this;this.prepareConnection('host');
 var code=Math.random().toString(36).slice(2,8).toUpperCase();
 this.tp=new RelayTransport(url,code,'host');
 this.setStatus('Connecting to your relay\u2026');
 this.tp._onPeer=function(){self.connectionState='handshake';self.setStatus('Friend reached the relay room \u00b7 waiting for their game handshake\u2026');self.refreshLobby();};
 this.tp.open(function(info){
   var token='#relay='+encodeURIComponent(self.tp.url)+'&r='+code;
   var link=(location.protocol==='file:'?'':location.origin+location.pathname+'?v=210')+token;
   var out=$id('anRoomOut');if(out)out.value=link;
   var row=$id('anHostRow');if(row)row.style.display='block';
   if(info.ready)self.tp._onPeer();
   else self.setStatus(location.protocol==='file:'?'Relay lobby open \u2014 friend opens their v210 file, pastes this token, then clicks Join.':'Relay lobby open \u2014 send this new v210 invite link to your friend.');
 },function(err){self.setStatus(err,true);},this.setStatus.bind(this));
 this.tp.onClose(function(){self.onPeerGone();});
 this.wire();
};
NetSession.prototype.joinRelay=function(url,room){
 var self=this;this.prepareConnection('guest');
 this.tp=new RelayTransport(url,room,'guest');
 this.setStatus('Connecting to the relay\u2026');
 this.tp.open(function(info){
   if(info.ready){self.helloOnce();self.connectionState='handshake';self.setStatus('Relay connected \u2014 completing the game handshake\u2026');}
   else{self.setStatus('In the room \u2014 waiting for the host (did their lobby close?)\u2026');}
 },function(err){self.setStatus(err,true);},this.setStatus.bind(this));
 this.tp._onPeer=function(){self.helloOnce();self.connectionState='handshake';self.setStatus('Host is here \u2014 completing the game handshake\u2026');};
 this.tp.onClose(function(){self.onPeerGone();});
 this.wire();
};
NetSession.prototype.hostLocal=function(){
 var code=Math.random().toString(36).slice(2,7).toUpperCase();
 this.prepareConnection('host');this.tp=new TabTransport(code);this.wire();
 this.setStatus('Local room '+code+' — open this file in a second tab and join with the code.');
 $id('anRoomOut').value=code;$id('anHostRow').style.display='block';
};
NetSession.prototype.hostOnline=function(){
 var self=this;this.prepareConnection('host');this.tp=new PeerTransport();this.tp.status=this.setStatus.bind(this);
 this.setStatus('Creating online lobby…');
 this.tp.host(function(id){
   var link=(location.protocol==='file:'?'':location.origin+location.pathname)+'#join='+id;
   self.setStatus('Lobby open — send the invite link. Keep this tab focused while waiting.');
   $id('anRoomOut').value=link;$id('anHostRow').style.display='block';
   self.setStatus('Lobby open — send the invite link to your friend.');
 },function(){self.connected=true;self.wire();self.setStatus('Friend connected! Pick a mode and press Start Match.');self.refreshLobby();},
 function(err){self.setStatus('Online error: '+err+' (strict NATs sometimes block P2P)',true);});
 this.tp.onClose&&this.tp.onClose(function(){self.onPeerGone();});
 this.wire();
};
NetSession.prototype.joinLocal=function(code){
 this.prepareConnection('guest');this.tp=new TabTransport(code.trim().toUpperCase());this.wire();this.helloOnce();
 this.setStatus('Joined local room '+code.trim().toUpperCase()+' — waiting for host to start…');
};
NetSession.prototype.joinOnline=function(hostId){
 var self=this;this.prepareConnection('guest');this.tp=new PeerTransport();this.tp.status=this.setStatus.bind(this);
 this.setStatus('Connecting to host…');
 this.tp.join(hostId.trim(),function(){self.wire();self.helloOnce();self.setStatus('Connected — waiting for host to start…');},
 function(err){self.setStatus('Join failed: '+err,true);});
 this.tp.onClose&&this.tp.onClose(function(){self.onPeerGone();});
};
NetSession.prototype.localLoadout=function(cls){
 var abilities=(AB[cls]||[]).slice(0,24).map(function(a){
  var clean={};Object.keys(a||{}).forEach(function(k){var v=a[k];if(typeof v!=='function'&&typeof v!=='undefined')clean[k]=v;});return clean;
 });
 var talents={},progression=currentProgression();try{talents=Object.assign({},progression.talents&&progression.talents[cls]||{});}catch(e){}
 return {abilities:abilities,talents:talents};
};
NetSession.prototype.hello=function(){
 var cls=(document.getElementById('classSelect')||{}).value||'flame';
 var loadout=this.localLoadout(cls);
 this.send({t:'hello',v:NET_VERSION,name:'P2',cls:cls,abilities:loadout.abilities,talents:loadout.talents});
};
NetSession.prototype.helloOnce=function(){if(this.helloSent)return;this.helloSent=true;this.hello();};
NetSession.prototype.wire=function(){var self=this;this.tp.onMessage(function(m){try{self.onMsg(m);}catch(e){console.error('net msg failed',e,m);}});};

NetSession.prototype.buildRoster=function(){
 var dps=['flame','shadow','storm','wind','soul','warrior'],heals=['sage','pala','disc'];
 function rnd(a){return a[Math.floor(Math.random()*a.length)];}
 var hostCls=(document.getElementById('classSelect')||{}).value||'flame';
 if(!this.guest)throw new Error('Guest handshake is incomplete');
 var guestCls=this.guest.cls;
 return [
  {id:1,name:'Host',cls:hostCls,team:'ally',x:-16,z:4,hostLocal:true},
  {id:2,name:this.guest.name||'P2',cls:guestCls,team:'ally',x:-17,z:-4,guestLocal:true,abilities:this.guest.abilities,talents:this.guest.talents},
  {id:3,name:'Mira',cls:rnd(heals),team:'enemy',x:17,z:4},
  {id:4,name:'Vael',cls:rnd(dps),team:'enemy',x:16,z:-4}
 ];
};
NetSession.prototype.startMatch=function(){
 var self=this;
 if(this.role!=='host'){this.setStatus('Only the host can start the co-op match.',true);return;}
 if(!this.connected||!this.guest||this.connectionState!=='ready'){
  this.setStatus(this.connectionState==='handshake'?'Friend is in the relay room, but their game handshake is not complete yet.':'Waiting for Player 2 to complete the game handshake…',true);return;
 }
 if(this.pendingStart){this.send(this.pendingStart.packet);this.setStatus('Start request resent · waiting for Player 2 acknowledgement…');return;}
 var roster;try{roster=this.buildRoster();}catch(e){this.setStatus('Could not build the co-op roster: '+String(e&&e.message||e),true);return;}
 var selected=(document.getElementById('arenaSelect')||{}).value||'random';
 /* Resolve Random once on the host. Sending the concrete theme is essential:
    otherwise every browser rolls its own map and collision/LoS diverge. */
 var arenaTheme=selected==='random'&&this.g.arena&&['runestone','serpent'].indexOf(this.g.arena.theme)>=0
  ?this.g.arena.theme:selected;
 if(arenaTheme==='random')arenaTheme=Math.random()<.5?'runestone':'serpent';
 var id=Date.now().toString(36)+Math.random().toString(36).slice(2,7);
 var packet={t:'start',v:NET_VERSION,id:id,mode:'coop',roster:roster,arena:arenaTheme};
 this.pendingStart={packet:packet,attempts:1};this.connectionState='starting';
 this.setStatus('Starting co-op · waiting for Player 2 acknowledgement…');this.refreshLobby();
 clearInterval(this.startRetry);this.startRetry=setInterval(function(){
  if(!self.pendingStart){clearInterval(self.startRetry);self.startRetry=null;return;}
  if(self.pendingStart.attempts>=12){clearInterval(self.startRetry);self.startRetry=null;self.pendingStart=null;self.connectionState='ready';self.setStatus('Player 2 did not acknowledge match start. Ask them to click Join / Retry, then start again.',true);self.refreshLobby();return;}
  self.pendingStart.attempts++;self.send(self.pendingStart.packet);
 },750);this.send(packet);
};
NetSession.prototype.finishHostStart=function(id){
 if(!this.pendingStart||this.pendingStart.packet.id!==id||this.started)return;
 var packet=this.pendingStart.packet;clearInterval(this.startRetry);this.startRetry=null;this.pendingStart=null;
 try{
  this.spawnFromRoster(packet.roster,'host',packet.arena);this.installHostRelays();
  this.g.netSession=this;this.g.netGuest=false;this.started=true;this.matchId=id;this.connectionState='playing';hideLobby();
 }catch(e){
  console.error('Host match start failed',e);this.started=false;this.matchId=null;this.uninstall();this.send({t:'abort',id:id,message:String(e&&e.message||e)});
  this.g.netGuest=false;if(this.g.netSession===this)this.g.netSession=null;try{this.g.returnMenu();}catch(cleanupError){}
  var panel=$id('anPanel');if(panel)panel.classList.remove('hidden');this.connectionState='ready';this.setStatus('Host could not start the match: '+String(e&&e.message||e),true);this.refreshLobby();
 }
};
NetSession.prototype.spawnFromRoster=function(roster,side,arenaTheme){
 var g=this.g,self=this;
 g.queueType='skirmish';g.mode='2v2';
 try{g.setArenaTheme(arenaTheme||'runestone');}catch(e){}
 g.audio.ensure();g.audio.play('start');g.clear();
 g.cameraRig.yaw=-Math.PI/2;g.cameraRig.pitch=.34;g.cameraRig.distance=12.4;
 roster.forEach(function(slot){
  var isLocalPlayer=(side==='host'&&slot.hostLocal)||(side==='guest'&&slot.guestLocal);
  var u=g.spawn(slot.name,slot.cls,slot.team,slot.x,slot.z,isLocalPlayer);
  u.netId=slot.id;
  if(side==='guest'){u.ai=null;}
  else if(slot.guestLocal){u.ai=null;u.netControlled=true;u.netAbilities=Array.isArray(slot.abilities)?slot.abilities:null;u.netTalents=slot.talents||{};if(u.netAbilities)while(u.cds.length<u.netAbilities.length)u.cds.push(0);self.guestUnitId=slot.id;}
 });
 if(side==='guest'){var mine=roster.filter(function(s){return s.guestLocal;})[0];this.myTeam=mine?mine.team:'enemy';}
 else this.myTeam='ally';
 var foes=g.units.filter(function(u){return u.team!==(side==='guest'?self.myTeam:'ally');});
 g.target=foes[0]||null;
 g.phase='countdown';g.count=3;g.time=0;g.dampening=0;g.paused=false;
 document.getElementById('menu').classList.add('hidden');
 document.getElementById('hud').classList.remove('hidden');
 document.getElementById('overlay').classList.add('hidden');
 g.renderFrames();g.renderActions();
 g.message('Online skirmish — no rating changes');
 this._lastPhase='countdown';
};

/* ---------------- per-frame ---------------- */
NetSession.prototype.hostFrame=function(dt){
 if(this.role!=='host'||!this.started)return;
 var castChanges=[],self=this;
 this.g.units.forEach(function(u){var c=self.castState(u),sig=c?(c.i+':'+(c.nm||'')+':'+c.tg):'0';if(self.lastCastSignals[u.netId]!==sig){self.lastCastSignals[u.netId]=sig;castChanges.push({u:u.netId,c:c});}});
 if(castChanges.length)this.send({t:'cst',l:castChanges});
 /* Combat feedback is ordered and important, so flush it immediately instead
    of making it wait behind the next periodic world snapshot. */
 this.eventTimer-=dt;
 if(this.outbox.length&&this.eventTimer<=0){this.eventTimer=.033;this.send({t:'evb',l:this.outbox.splice(0,this.outbox.length)});}
 this.snapTimer-=dt;
 if(this.snapTimer<=0){
  this.snapTimer=.05;
  this.send({t:'snap',s:this.snapshot()});
 }
 this.statsTimer-=dt;
 if(this.statsTimer<=0){this.statsTimer=.5;this.send({t:'sts',l:this.statsSnapshot()});}
};
NetSession.prototype.snapshot=function(){
 var g=this.g;
 return {t:+g.time.toFixed(3),phase:g.phase,count:+(g.count||0).toFixed(2),damp:g.dampening,iq:this.hostGuestInputSeq||0,
  units:g.units.map(function(u){return {
   id:u.netId,x:+u.x.toFixed(2),z:+u.z.toFixed(2),r:+u.mesh.rotation.y.toFixed(2),
   hp:Math.round(u.hp),mhp:u.maxHp,res:Math.round(u.resource),sh:Math.round(u.shield||0),
   al:u.alive?1:0,mo:u.mounted?1:0,gcd:+u.gcd.toFixed(2),te:Math.round(u.tigereyeStacks||0),tp:Math.round(u.tigereyePalmCounter||0),
   cds:u.cds.map(function(c){return +c.toFixed(1);}),
   cast:u.cast?{i:u.cast.index,left:+(u.cast.left||0).toFixed(2),total:u.cast.total,tg:(u.cast.target&&u.cast.target.netId)||0,nm:u.cast.a&&u.cast.a.name,ic:u.cast.a&&u.cast.a.icon}:0,
   /* Slow/speed/power were absent in v209, so the guest predicted with the
      wrong movement speed and could not display several class mechanics. */
   fx:u.effects.map(function(e){return [e.type,+e.time.toFixed(1),e.stacks||0,
    Number.isFinite(e.power)?+e.power.toFixed(3):null,Number.isFinite(e.pct)?+e.pct.toFixed(3):null,
    Number.isFinite(e.reduction)?+e.reduction.toFixed(3):null,Number.isFinite(e.speed)?+e.speed.toFixed(3):null];})
  };})};
};
NetSession.prototype.statsSnapshot=function(){
 function map(src){var out={};Object.keys(src||{}).forEach(function(k){var n=Number(src[k]);if(Number.isFinite(n)&&n!==0)out[String(k).slice(0,80)]=+n.toFixed(1);});return out;}
 return this.g.units.map(function(u){var s=u.stats||{};return {id:u.netId,d:+(s.damage||0).toFixed(1),h:+(s.healing||0).toFixed(1),a:+(s.absorb||0).toFixed(1),i:s.interrupts||0,k:s.kb||0,da:map(s.damageByAbility),dt:map(s.damageByTarget),ha:map(s.healingByAbility),ht:map(s.healingByTarget)};});
};
NetSession.prototype.guestFrame=function(dt){
 var g=this.g,s=this.lastSnap;
 if(!this.started)return;
 this.updateNetHud(dt);
 var frameNow=performance.now();
 this.pingTimer-=dt;if(this.pingTimer<=0){this.pingTimer=1;this.send({t:'nping',n:frameNow});}
 /* A WebRTC channel can remain "open" after its route has silently died.
    Ask through the independent relay socket and switch both peers instead of
    leaving the guest in a permanently frozen match. */
 if(this.lastSnapshotAt&&frameNow-this.lastSnapshotAt>950&&(!this.recoveryAt||frameNow-this.recoveryAt>3000)&&this.tp&&this.tp.route==='direct'){
  this.recoveryAt=frameNow;this.tp.sendRelay({t:'routeFallback',why:'snapshot timeout'});this.tp.fallbackToRelay('state timeout');
 }
 if(s){
  g.dampening=s.damp;
  if(g.phase!==s.phase&&g.phase!=='ended'){g.phase=s.phase;if(s.phase==='fight')g.message('FIGHT!');}
  if(g.phase==='countdown')g.message('Begins in '+Math.max(1,Math.ceil(g.count)));
 }
 if(g.phase==='fight'||g.phase==='countdown'){
  if(g.phase==='fight')g.time+=dt;else g.count=Math.max(0,g.count-dt);
  if(g.player){g.player.intent=g.localMoveIntent();if(g.player.intent)g.unitMoveByIntent(g.player,dt);}
  this.maybeSendIntent(dt);
  var now=performance.now(),self=this;
  Object.keys(this.pendingActions).forEach(function(q){
   var pending=self.pendingActions[q],age=now-pending.at;
   if(age>2400){delete self.pendingActions[q];self.lastActionOk=false;if(g.player&&g.player.cast&&g.player.cast.netAction==q)g.player.cast=null;g.message('Action timed out — connection route is recovering');return;}
   if(pending.packet&&now-pending.lastSend>350&&pending.retries<5){pending.lastSend=now;pending.retries++;self.send(pending.packet);}
  });
  g.units.forEach(function(u){
   var n=u.netTarget;if(!n||!u.alive)return;
   var own=u===g.player,gap=Math.hypot(n.x-u.x,n.z-u.z);
   if(own){
    var locallyMoving=!!g.player.intent,hostHasLatest=!s||Number(s.iq||0)>=self.inputSeq;
    /* Do not continuously pull a moving player sideways toward a snapshot
       produced before their latest input. Settle quickly once input stops. */
    if(gap>2.5){u.x=n.x;u.z=n.z;}
    else if(!locallyMoving&&gap>.08){var stopK=Math.min(1,dt*22);u.x+=(n.x-u.x)*stopK;u.z+=(n.z-u.z)*stopK;}
    else if(hostHasLatest&&gap>.85){var moveK=Math.min(1,dt*3);u.x+=(n.x-u.x)*moveK;u.z+=(n.z-u.z)*moveK;}
    return;
   }
   var k=Math.min(1,dt*18);u.x+=(n.x-u.x)*k;u.z+=(n.z-u.z)*k;
   if(n.r!=null){var d=((n.r-u.mesh.rotation.y+Math.PI)%(Math.PI*2))-Math.PI;u.mesh.rotation.y+=d*Math.min(1,dt*18);}
  });
  g.units.forEach(function(u){u.update(dt);});
 }
};
NetSession.prototype.maybeSendIntent=function(dt){
 this.intentTimer-=dt;this.intentReliableTimer-=dt;
 var g=this.g,v=g.player?g.player.intent:null;
 var key=v?(v.x.toFixed(2)+','+v.z.toFixed(2)):'0';
 if(key!==this.lastIntent||this.intentTimer<=0){
  var changed=key!==this.lastIntent,q=++this.inputSeq;
  this.intentTimer=.05;this.lastIntent=key;
  var packet={t:'in',q:q,x:v?+v.x.toFixed(3):0,z:v?+v.z.toFixed(3):0};this.send(packet);
  /* Direction changes and especially key-up must not rely on an unreliable
     packet. A periodic ordered copy also repairs isolated state-channel loss. */
  if(changed||this.intentReliableTimer<=0){this.intentReliableTimer=.25;packet.t='inr';this.send(packet);}
 }
};
NetSession.prototype.predictAction=function(q,i,target){
 var g=this.g,p=g.player,a=AB[p&&p.cls]&&AB[p.cls][i];if(!p||!p.alive||!a)return;
 var predicted=a;
 try{predicted=g.applyTalentAbilityMods(p,a,i)||a;}catch(e){}
 if(p.has&&p.has('combustion')&&predicted.cast)predicted=Object.assign({},predicted,{cast:predicted.cast*.85});
 if(predicted.name==='Cinder Bolt'&&p.has('instantBolt'))predicted=Object.assign({},predicted,{cast:0});
 if(predicted.name==='Arc Spark'&&(p.has('stormkeeper')||p.has('tempestBolts')))predicted=Object.assign({},predicted,{cast:0});
 if(predicted.name==='Holy Light'&&p.has('infusion'))predicted=Object.assign({},predicted,{cast:.75});
 if(predicted.name==='Lullaby Bloom'&&p.has('natureSwiftness'))predicted=Object.assign({},predicted,{cast:0});
 var offGcd=['interrupt','interruptProc','windInterrupt','shadowInterrupt','pummel','reflect','warriorGuard','avatar','natureSwiftness','iceBlock','tigereyeBrew','vendetta','shiv','combustion','flameNova','painSuppression','archangel','darkArchangel','angelicBody'].indexOf(predicted.type)>=0||['Garrote','Chain Spark','Lava Burst','Cyclone Barrage','Living Bomb'].indexOf(predicted.name)>=0;
 var canPreview=(offGcd||p.gcd<=.08)&&(p.cds[i]||0)<=.08&&p.resource>=(predicted.cost||0)&&(!p.cast||offGcd);
 if(!canPreview)return;
 p.cds[i]=Math.max(p.cds[i]||0,predicted.cd||0);
 p.resource=Math.max(0,p.resource-(predicted.cost||0));
 if(!offGcd)p.gcd=Math.max(p.gcd,p.cls==='soul'?.5:1.5);
 if(predicted.cast>0){
  p.cast={a:predicted,index:i,target:target||p,total:predicted.cast,left:predicted.cast,school:predicted.school,netPredicted:true,netAction:q,channel:['fistsChannel','discPenance','soulDrain','bladestorm'].indexOf(predicted.type)>=0,moveCast:predicted.moveCast};
  try{g.audio.play('cast');}catch(e){}
 }else{
  try{g.animateAction(p,predicted);}catch(e){}
 }
};
NetSession.prototype.sendCast=function(i,target){
 var q=++this.actionSeq,p=this.g.player,now=performance.now();
 var a=AB[p&&p.cls]&&AB[p.cls][i],clean=null;if(a){clean={};Object.keys(a).forEach(function(k){if(typeof a[k]!=='function'&&typeof a[k]!=='undefined')clean[k]=a[k];});}
 var packet={t:'cast',q:q,i:i,tg:(target&&target.netId)||0,a:clean,px:p?+p.x.toFixed(2):0,pz:p?+p.z.toFixed(2):0,iq:this.inputSeq};
 this.pendingActions[q]={at:now,lastSend:now,retries:0,packet:packet,i:i,prev:p?{gcd:p.gcd,res:p.resource,cd:p.cds[i]}:null};
 this.predictAction(q,i,target);this.send(packet);
};
NetSession.prototype.castState=function(u){return u&&u.cast?{
 i:u.cast.index,left:+(u.cast.left||0).toFixed(3),total:u.cast.total,
 tg:(u.cast.target&&u.cast.target.netId)||0,nm:u.cast.a&&u.cast.a.name,ic:u.cast.a&&u.cast.a.icon
}:0;};
NetSession.prototype.unitState=function(u){return u?{
 gcd:+(u.gcd||0).toFixed(3),res:+(u.resource||0).toFixed(2),
 cds:u.cds.map(function(c){return +c.toFixed(2);}),cast:this.castState(u),te:Math.round(u.tigereyeStacks||0),tp:Math.round(u.tigereyePalmCounter||0)
}:null;};
NetSession.prototype.applyActionAck=function(m){
 var p=this.g.player,pending=this.pendingActions[m.q];if(!pending)return;
 this.lastActionMs=Math.max(0,Math.round(performance.now()-pending.at));this.lastActionOk=!!m.ok;
 delete this.pendingActions[m.q];
 if(!p)return;
 if(m.s){p.gcd=m.s.gcd;p.resource=m.s.res;p.tigereyeStacks=m.s.te||0;p.tigereyePalmCounter=m.s.tp||0;for(var si=0;si<m.s.cds.length&&si<p.cds.length;si++)p.cds[si]=m.s.cds[si];}
 var cast=m.s?m.s.cast:m.c;
 if(!m.ok){if(p.cast&&p.cast.netAction===m.q)p.cast=null;this.g.message(m.why||'Host rejected action');return;}
 if(cast){this.applyCastSignal({u:p.netId,c:cast},true);}
 else if(p.cast&&p.cast.netAction===m.q)p.cast=null;
};
NetSession.prototype.updateNetHud=function(dt){
 this.hudTimer-=dt;if(this.hudTimer>0)return;this.hudTimer=.25;
 var el=document.getElementById('anNetHud');if(!el){el=document.createElement('div');el.id='anNetHud';el.style.cssText='position:fixed;z-index:9;top:76px;left:50%;transform:translateX(-50%);padding:5px 10px;border-radius:12px;background:rgba(5,10,18,.82);border:1px solid rgba(105,220,240,.35);font:800 10px/1.2 Inter,Segoe UI,sans-serif;letter-spacing:.06em;color:#bff8ff;pointer-events:none';document.body.appendChild(el);}
 var now=performance.now(),elapsed=now-this.snapWindowAt;if(elapsed>=1000){this.snapRate=Math.round(this.snapCount*1000/elapsed);this.snapCount=0;this.snapWindowAt=now;}
 var age=this.lastSnapshotAt?now-this.lastSnapshotAt:9999,rtt=this.netRtt||this.tp&&this.tp.rtt||0,stalled=age>650,route=this.tp&&this.tp.route==='direct'?'DIRECT':'RELAY';
 el.style.color=stalled?'#ff9a82':this.lastActionOk?'#bff8ff':'#ffd27a';
 el.textContent=stalled?route+' · STATE STALLED '+Math.round(age)+'ms':route+' · '+(rtt?Math.round(rtt)+'ms RTT · ':'')+this.snapRate+' updates/s'+(this.lastActionMs?' · action '+this.lastActionMs+'ms'+(this.lastActionOk?'':' REJECTED'):'');
};
NetSession.prototype.applyCastSignal=function(entry,authoritative){
 var u=this.byId(entry.u);if(!u)return;
 if(!entry.c){
  if(u===this.g.player&&u.cast&&u.cast.netPredicted&&this.pendingActions[u.cast.netAction]&&!authoritative)return;
  u.cast=null;return;
 }
 var c=entry.c,local=AB[u.cls]&&AB[u.cls][c.i];
 var ab=local&&(!c.nm||local.name===c.nm)?local:{name:c.nm||'Casting',icon:c.ic||'✨',school:local&&local.school};
 u.cast={a:ab,index:c.i,netI:c.i,total:c.total,left:c.left,target:this.byId(c.tg)||u,school:ab.school};
};

/* ---------------- messages ---------------- */
NetSession.prototype.onMsg=function(m){
 var g=this.g,self=this;
 if(this.role==='host'){
  if(m.t==='hello'){
   if(m.v!==NET_VERSION){this.setStatus('Version mismatch — both players need the same game file.',true);return;}
   if(!m.cls||!AB[m.cls]){this.setStatus('Player 2 sent an unknown class. Both players must hard-refresh v210.',true);return;}
   var safeAbilities=Array.isArray(m.abilities)?m.abilities.slice(0,24).filter(function(a){return a&&typeof a.name==='string'&&typeof a.type==='string';}):[];
   if(!safeAbilities.length){this.setStatus('Player 2 loadout did not arrive. Both players must hard-refresh v210 and rejoin.',true);return;}
   this.guest={name:String(m.name||'P2').slice(0,24),cls:m.cls,abilities:safeAbilities,talents:m.talents&&typeof m.talents==='object'?m.talents:{}};
   this.connected=true;this.connectionState='ready';this._left=false;
   this.send({t:'welcome',v:NET_VERSION,mode:'coop',hostCls:(document.getElementById('classSelect')||{}).value||'flame'});this.refreshLobby();
   this.setStatus('Player 2 ready ('+classLabel(m.cls)+') — Start Co-op is unlocked.');
   return;
  }
  if(m.t==='startAck'){this.finishHostStart(m.id);return;}
  if(m.t==='startError'){
   clearInterval(this.startRetry);this.startRetry=null;this.pendingStart=null;this.connectionState='ready';
   this.setStatus('Player 2 could not load the match: '+String(m.message||'unknown start error'),true);this.refreshLobby();return;
  }
  if(m.t==='nping'){this.send({t:'npong',n:m.n});return;}
  if(m.t==='routeFallback'){
   if(this.tp){this.tp.fallbackToRelay(String(m.why||'peer request'));this.tp.sendRelay({t:'routeFallbackAck'});if(this.started)this.tp.sendRelay({t:'snap',s:this.snapshot()});}
   return;
  }
  if(!this.started)return;
  var gu=this.byId(this.guestUnitId);if(!gu)return;
  if(m.t==='in'||m.t==='inr'){
   var inputQ=Number(m.q)||0;if(inputQ<this.hostGuestInputSeq)return;this.hostGuestInputSeq=inputQ;
   gu.intent=(m.x||m.z)?{x:Number(m.x)||0,z:Number(m.z)||0}:null;return;
  }
  if(m.t==='cast'){
   var actionQ=Number(m.q)||0,cached=actionQ&&this.processedActions[actionQ];if(cached){this.send(cached);return;}
   if(m.a&&typeof m.a.name==='string'&&typeof m.a.type==='string'){
    if(!gu.netAbilities)gu.netAbilities=[];gu.netAbilities[m.i]=m.a;while(gu.cds.length<=m.i)gu.cds.push(0);
   }
   /* Co-op lag compensation: accept a small, constrained correction from the
      guest's predicted position before range/LoS validation. This prevents a
      cast at a pillar edge being rejected against an older host position. */
   if(Number.isFinite(m.px)&&Number.isFinite(m.pz)){
    var castGap=Math.hypot(m.px-gu.x,m.pz-gu.z);if(castGap<=3){gu.x=m.px;gu.z=m.pz;try{g.arena.constrain(gu);}catch(positionError){}}
   }
   var before={cast:gu.cast,gcd:gu.gcd,res:gu.resource,cd:gu.cds[m.i],fx:gu.effects.length};
   var progression=currentProgression(),originalAbilities=AB[gu.cls],originalTalents=progression.talents&&progression.talents[gu.cls],result=false,rejectReason='',originalFail=g.fail;
   try{
    g.fail=function(c,msg,show){if(c===gu)rejectReason=String(msg||'');return originalFail.call(g,c,msg,show);};
    if(gu.netAbilities&&gu.netAbilities.length)AB[gu.cls]=gu.netAbilities;
    if(progression.talents)progression.talents[gu.cls]=gu.netTalents||{};
    result=g.castFor(gu,m.i,this.byId(m.tg));
   }finally{
    g.fail=originalFail;AB[gu.cls]=originalAbilities;if(progression.talents)progression.talents[gu.cls]=originalTalents||{};
   }
   var accepted=result===true||gu.cast!==before.cast||gu.gcd!==before.gcd||gu.resource!==before.res||gu.cds[m.i]!==before.cd||gu.effects.length!==before.fx;
   if(!accepted&&!rejectReason){if(gu.cast)rejectReason='Already casting';else if(gu.gcd>.05)rejectReason='Global cooldown not ready';else if((gu.cds[m.i]||0)>.05)rejectReason='Ability not ready';else rejectReason='Host rejected action (range, line of sight, resource, or crowd control)';}
   var ack={t:'ack',q:actionQ,ok:accepted?1:0,why:accepted?'':rejectReason,s:this.unitState(gu)};
   if(actionQ){this.processedActions[actionQ]=ack;this.processedActionOrder.push(actionQ);if(this.processedActionOrder.length>128)delete this.processedActions[this.processedActionOrder.shift()];}
   this.send(ack);
   return;
  }
  if(m.t==='trk'){g.useTrinket(gu,true);return;}
  if(m.t==='mnt'){g.tryMount(gu,false);return;}
  if(m.t==='bye'){this.onPeerGone();return;}
 }else{
  if(m.t==='welcome'){
   if(m.v!==NET_VERSION){this.setStatus('Version mismatch — both players need v210.',true);return;}
   this.mode='coop';this.hostClass=m.hostCls||null;this.connected=true;this.connectionState='ready';this._left=false;this.refreshLobby();
   this.setStatus('Game handshake complete — waiting for the host to start co-op.');return;
  }
  if(m.t==='start'){
   if(m.v!==NET_VERSION){this.send({t:'startError',id:m.id,message:'version mismatch'});this.setStatus('Host is using a different game version.',true);return;}
   var validRoster=Array.isArray(m.roster)&&m.roster.length===4&&m.roster.some(function(s){return s&&s.guestLocal&&s.team==='ally';});
   if(m.mode!=='coop'||!validRoster){this.send({t:'startError',id:m.id,message:'invalid co-op roster'});this.setStatus('Host sent an invalid co-op roster.',true);return;}
   if(this.started&&this.matchId===m.id){this.send({t:'startAck',id:m.id});return;}
   try{
    this.mode='coop';g.netGuest=true;g.netSession=this;this.spawnFromRoster(m.roster,'guest',m.arena);
    this.started=true;this.matchId=m.id;this.connectionState='playing';hideLobby();this.send({t:'startAck',id:m.id});
   }catch(e){
    console.error('Guest match start failed',e);this.started=false;this.matchId=null;g.netGuest=false;if(g.netSession===this)g.netSession=null;
    try{g.returnMenu();}catch(cleanupError){}var panel=$id('anPanel');if(panel)panel.classList.remove('hidden');
    this.send({t:'startError',id:m.id,message:String(e&&e.message||e)});this.setStatus('Could not load co-op: '+String(e&&e.message||e),true);
   }
   return;
  }
  if(m.t==='abort'&&(!m.id||this.matchId===m.id)){
   this.started=false;this.matchId=null;this.connectionState='ready';g.netGuest=false;if(g.netSession===this)g.netSession=null;
   try{g.returnMenu();}catch(cleanupError){}var panel=$id('anPanel');if(panel)panel.classList.remove('hidden');
   this.setStatus('Host could not enter the match: '+String(m.message||'start aborted'),true);this.refreshLobby();return;
  }
  if(m.t==='ack'){this.applyActionAck(m);return;}
  if(m.t==='npong'){this.netRtt=Math.max(0,performance.now()-Number(m.n||performance.now()));return;}
  if(m.t==='routeFallbackAck'){if(this.tp)this.tp.fallbackToRelay('peer confirmed');return;}
  if(m.t==='cst'){(m.l||[]).forEach(function(entry){self.applyCastSignal(entry,false);});return;}
  if(m.t==='snap'){this.applySnapshot(m.s);return;}
  if(m.t==='sts'){this.applyStats(m.l);return;}
  if(m.t==='evb'){m.l.forEach(function(ev){self.applyEvent(ev);});return;}
  if(m.t==='end'){var won=this.myTeam==='ally'?m.allyWon:!m.allyWon;this.started=false;this.connectionState='ended';g.netGuest=false;if(g.netSession===this)g.netSession=null;g.finish(won);return;}
  if(m.t==='bye'){this.onPeerGone();return;}
 }
};
NetSession.prototype.applyEvent=function(ev){
 var g=this.g;
 if(ev.k==='fl'){var u=this.byId(ev.u);if(u)g.float(u,ev.x,ev.kd,ev.lb);return;}
 if(ev.k==='lg'){g.log(ev.x);return;}
 if(ev.k==='sa'){g.audio.playAbility({name:ev.n,type:ev.ty,school:ev.s},{cls:ev.c});return;}
 if(ev.k==='im'){g.audio.playImpact(ev.lb);return;}
 if(ev.k==='vx'){var fn=g[ev.m];if(typeof fn!=='function')return;
  var t=ev.u!=null?this.byId(ev.u):(ev.p?{x:ev.p[0],z:ev.p[1]}:null);
  if(t)try{fn.apply(g,[t].concat(ev.a||[]));}catch(e){}return;}
};
NetSession.prototype.applySnapshot=function(s){
 var g=this.g,self=this,actionDirty=false;this.lastSnap=s;this.lastSnapshotAt=performance.now();this.snapCount++;
 var timeError=s.t-g.time;if(Math.abs(timeError)>.75)g.time=s.t;else g.time+=timeError*.22;
 var countError=s.count-g.count;if(Math.abs(countError)>.75)g.count=s.count;else g.count+=countError*.28;
 s.units.forEach(function(su){
 var u=self.byId(su.id);if(!u)return;
  var oldActionSig=u===g.player?String(u.tigereyeStacks||0)+'|'+u.effects.map(function(e){return e.type+':'+(e.stacks||0);}).join(','):'';
  u.netTarget={x:su.x,z:su.z,r:su.r};
  u.maxHp=su.mhp;u.hp=su.hp;u.resource=su.res;u.shield=su.sh;u.gcd=su.gcd;
  u.tigereyeStacks=su.te||0;u.tigereyePalmCounter=su.tp||0;
  for(var i=0;i<su.cds.length&&i<u.cds.length;i++)u.cds[i]=su.cds[i];
  if(u.mounted!==!!su.mo)u.mounted=!!su.mo;
  if(u.alive&&!su.al)self.guestDie(u);
  if(su.cast){
   if(!u.cast||u.cast.netI!==su.cast.i||Math.abs((u.cast.left||0)-su.cast.left)>1.2){
    var localAb=AB[u.cls]&&AB[u.cls][su.cast.i];
    var ab=localAb&&(!su.cast.nm||localAb.name===su.cast.nm)?localAb:{name:su.cast.nm||'Casting',icon:su.cast.ic||'✨',school:localAb&&localAb.school};
    u.cast={a:ab,index:su.cast.i,netI:su.cast.i,total:su.cast.total,left:su.cast.left,target:self.byId(su.cast.tg)||u,school:ab.school};
   }else u.cast.left=su.cast.left;
  }else if(u.cast){
   var stillPending=u.cast.netPredicted&&self.pendingActions[u.cast.netAction];
   if(!stillPending)u.cast=null;
  }
  /* effects reconcile by type counts */
  function syncFx(e,f){e.time=f[1];e.stacks=f[2]||0;[['power',3],['pct',4],['reduction',5],['speed',6]].forEach(function(pair){if(f[pair[1]]==null)delete e[pair[0]];else e[pair[0]]=f[pair[1]];});}
  var want={};su.fx.forEach(function(f){(want[f[0]]=want[f[0]]||[]).push(f);});
  var kept=[];
  u.effects.forEach(function(e){var list=want[e.type];if(list&&list.length){var f=list.shift();syncFx(e,f);kept.push(e);}});
  u.effects=kept;
  Object.keys(want).forEach(function(type){want[type].forEach(function(f){
   try{u.effect(type,f[1]);var ne=u.effects[u.effects.length-1];if(ne)syncFx(ne,f);}catch(e){}
  });});
  if(u===g.player){var newActionSig=String(u.tigereyeStacks||0)+'|'+u.effects.map(function(e){return e.type+':'+(e.stacks||0);}).join(',');if(newActionSig!==oldActionSig)actionDirty=true;}
 });
 if(actionDirty)try{g.renderActions();}catch(e){}
};
NetSession.prototype.applyStats=function(list){
 var self=this;function map(v){return v&&typeof v==='object'?v:{};}
 (list||[]).forEach(function(ss){var u=self.byId(ss.id);if(!u)return;u.stats={damage:Number(ss.d)||0,healing:Number(ss.h)||0,absorb:Number(ss.a)||0,interrupts:Number(ss.i)||0,kb:Number(ss.k)||0,damageByAbility:map(ss.da),damageByTarget:map(ss.dt),healingByAbility:map(ss.ha),healingByTarget:map(ss.ht)};});
 try{self.g.updateDetailsMeter();}catch(e){}
};
NetSession.prototype.guestDie=function(u){
 var g=this.g;u.alive=false;u.hp=0;u.cast=null;u.mounted=false;
 if(u.mountVisual)u.mountVisual.visible=false;if(u.gearAppearance)u.gearAppearance.visible=false;if(u.prestigeVisual)u.prestigeVisual.visible=false;
 try{u.fallToGround();}catch(e){}
 g.audio.play('death');if(g.target===u)g.target=null;
};
NetSession.prototype.onPeerGone=function(){
 if(this._left)return;
 var g=this.g;
 if(!this.started){
  clearInterval(this.startRetry);this.startRetry=null;this.pendingStart=null;this.connected=false;this.connectionState='waiting';
  if(this.role==='host')this.guest=null;else this.helloSent=false;
  this.refreshLobby();this.setStatus(this.role==='host'?'Player 2 disconnected — the lobby is still open for them to rejoin.':'Host disconnected — waiting for the lobby to return.',true);return;
 }
 this._left=true;
 if(this.role==='host'){
  var gu=this.byId(this.guestUnitId);
  if(gu&&gu.alive&&!gu.ai&&AIController){gu.netControlled=false;gu.intent=null;gu.ai=new AIController(g,gu);g.log('P2 disconnected — a bot has taken over their character.');g.message('P2 disconnected — bot takes over');}
  this.teardown(true);
 }else if(this.role==='guest'){
  g.message('Connection to host lost');g.log('Connection lost — the match continues on the host.');
  g.netGuest=false;this.teardown(true);g.returnMenu();
 }else{this.setStatus('Peer disconnected.',true);this.connected=false;}
};
NetSession.prototype.leave=function(){this._left=true;try{this.send({t:'bye'});}catch(e){}this.teardown(true);};
NetSession.prototype.teardown=function(keepMatch){
 this.uninstall();
 clearInterval(this.startRetry);this.startRetry=null;this.pendingStart=null;
 if(this.tp){try{this.tp.close();}catch(e){}this.tp=null;}
 var g=this.g;
 if(!keepMatch||this.role==='guest'){g.netGuest=false;}
 if(g.netSession===this&&(this.role==='guest'||!keepMatch))g.netSession=null;
 if(this.role==='host'&&keepMatch){/* keep netSession so hostFrame no-ops harmlessly */ this.started=false;this.connected=false;}
 var netHud=document.getElementById('anNetHud');if(netHud)netHud.remove();
 window.__aetherNet=null;
};
NetSession.prototype.refreshLobby=function(){
 var el=$id('anRoster');if(!el)return;
 var hostCls=(document.getElementById('classSelect')||{}).value||'flame';
 var start=$id('anStart'),ready=this.role==='host'&&this.connected&&!!this.guest&&this.connectionState==='ready';
 if(start){start.disabled=!ready;start.textContent=this.connectionState==='starting'?'Starting…':'Start Co-op';}
 if(this.role==='guest'){
  el.innerHTML='<div>Host: <b>'+(this.hostClass?classLabel(this.hostClass):'waiting for handshake…')+'</b></div><div>P2 (you): <b>'+classLabel(hostCls)+'</b></div><div style="opacity:.75;margin-top:4px">Co-op only · both humans are allies against two bots.</div>';return;
 }
 var gTxt=this.connected&&this.guest?classLabel(this.guest.cls)+' — game handshake complete':this.connectionState==='handshake'?'in relay room — completing handshake…':'waiting…';
 el.innerHTML='<div>Host (you): <b>'+classLabel(hostCls)+'</b></div><div>Player 2: <b>'+gTxt+'</b></div><div style="opacity:.75;margin-top:4px">Co-op only · both humans are allies against two bots.</div>';
};

/* ---------------- lobby UI ---------------- */
function buildUI(game){
 var css=document.createElement('style');
 css.textContent='#anBtn{position:fixed;right:18px;bottom:18px;z-index:90;padding:12px 16px;border-radius:12px;border:1px solid rgba(120,255,180,.45);background:linear-gradient(180deg,rgba(20,40,30,.92),rgba(8,14,12,.95));color:#c8ffe2;font-weight:900;cursor:pointer;letter-spacing:.06em}#anBtn:hover{filter:brightness(1.2)}#anPanel{position:fixed;inset:0;z-index:140;display:grid;place-items:center;background:rgba(0,0,0,.62)}#anPanel.hidden{display:none}#anCard{width:min(560px,calc(100vw - 40px));border:1px solid rgba(120,255,180,.35);border-radius:16px;background:linear-gradient(180deg,rgba(16,24,20,.98),rgba(6,10,9,.98));padding:18px;color:#dff5ea;font-size:14px}#anCard h2{margin:0 0 4px;color:#9dffc9;letter-spacing:.1em}#anCard .an-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}#anCard button{padding:9px 13px;border-radius:10px;border:1px solid rgba(120,255,180,.4);background:rgba(255,255,255,.05);color:#d9ffe9;font-weight:800;cursor:pointer}#anCard button:hover{filter:brightness(1.25)}#anCard button:disabled{opacity:.42;cursor:not-allowed;filter:none}#anCard input{flex:1;min-width:140px;padding:9px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.4);color:#eafff3}#anStatus{margin-top:10px;min-height:18px;font-size:12.5px;color:#9fe8b2}#anRoster{margin-top:10px;font-size:13px;line-height:1.5}#anClose{float:right}';
 document.head.appendChild(css);
 var btn=document.createElement('button');btn.id='anBtn';btn.textContent='🌐 Play Online';document.body.appendChild(btn);
 var panel=document.createElement('div');panel.id='anPanel';panel.className='hidden';
 panel.innerHTML='<div id="anCard"><button id="anClose">✕</button><h2>PLAY ONLINE — CO-OP</h2><div style="opacity:.8">Two human allies versus two host-controlled bots · no rating. The game tries a low-latency DIRECT route automatically and keeps Deno as fallback.</div>'
 +'<div class="an-row"><input id="anRelayUrl" placeholder="Relay v3 URL (e.g. https://your-relay.deno.dev)"></div>'
 +'<div class="an-row"><button id="anHostRelay">Create Co-op Lobby</button></div>'
 +'<div class="an-row" id="anHostRow" style="display:none"><input id="anRoomOut" readonly><button id="anCopy">Copy Invite</button><button id="anStart" disabled>Start Co-op</button></div>'
 +'<div class="an-row"><input id="anJoinIn" placeholder="Paste the co-op invite link"><button id="anJoin">Join / Retry</button><button id="anReset">Disconnect</button></div>'
 +'<div id="anRoster"></div><div id="anStatus"></div></div>';
 document.body.appendChild(panel);
 function session(){if(!window.__aetherNet)window.__aetherNet=new NetSession(game);return window.__aetherNet;}
 btn.onclick=function(){panel.classList.remove('hidden');};
 $id('anClose').onclick=function(){panel.classList.add('hidden');};
 var savedRelay=null;try{savedRelay=localStorage.getItem('aetherRelayUrl');}catch(e){}
 if(savedRelay)$id('anRelayUrl').value=savedRelay;
 $id('anRelayUrl').addEventListener('change',function(){try{localStorage.setItem('aetherRelayUrl',$id('anRelayUrl').value.trim());}catch(e){}});
 $id('anHostRelay').onclick=function(){
  var url=$id('anRelayUrl').value.trim();
  if(!url){$id('anStatus').textContent='Paste your relay URL first \u2014 deploy takes ~3 minutes, see relay/README.md';$id('anStatus').style.color='#ff8d7a';return;}
  try{localStorage.setItem('aetherRelayUrl',url);}catch(e){}
  var s=session();s.mode='coop';s.hostRelay(url);
 };
 $id('anCopy').onclick=function(){var el=$id('anRoomOut');el.select();try{navigator.clipboard.writeText(el.value);}catch(e){document.execCommand('copy');}};
 $id('anStart').onclick=function(){if(window.__aetherNet)window.__aetherNet.startMatch();};
 $id('anJoin').onclick=function(){
  var v=$id('anJoinIn').value.trim();if(!v)return;var s=session();
  var rm=v.match(/#relay=([^&]+)&r=([A-Za-z0-9]+)/);
  if(rm){s.joinRelay(decodeURIComponent(rm[1]),rm[2]);return;}
  s.setStatus('That is not a v210 co-op relay invite. Ask the host to create a fresh lobby.',true);
 };
 $id('anReset').onclick=function(){
  if(window.__aetherNet){try{window.__aetherNet._left=true;window.__aetherNet.teardown(false);}catch(e){}window.__aetherNet=null;}
  $id('anStatus').textContent='Disconnected. You can create or join a fresh lobby.';$id('anStatus').style.color='#9fe8b2';
 };
 /* auto-join from invite link */
 if(location.hash.indexOf('#relay=')===0){
  var rm=location.hash.match(/#relay=([^&]+)&r=([A-Za-z0-9]+)/);
  if(rm){panel.classList.remove('hidden');$id('anJoinIn').value=location.hash;
   setTimeout(function(){session().joinRelay(decodeURIComponent(rm[1]),rm[2]);},400);}
 }
 /* hide button during matches */
 setInterval(function(){btn.style.display=(game.phase==='menu')?'block':'none';},500);
 /* A guest must never fall back into local-authority simulation. If any later
    UI exception flips netGuest, restore it before the next game frame. */
 function isGuestSession(){return !!(game.netGuest||(game.netSession&&game.netSession.role==='guest'&&game.netSession.started));}
 var origUpdate=game.update.bind(game);
 game.update=function(dt){if(game.netSession&&game.netSession.role==='guest'&&game.netSession.started)game.netGuest=true;return origUpdate(dt);};
 var origCastFor=game.castFor.bind(game);
 game.castFor=function(u,i,target){if(isGuestSession()&&u===game.player){if(game.netSession)game.netSession.sendCast(i,target);return;}return origCastFor(u,i,target);};
 /* guest input redirects for trinket + mount */
 var origTrk=game.useTrinket.bind(game);
 game.useTrinket=function(u,fromAI){u=u||game.player;if(isGuestSession()&&u===game.player){if(game.netSession)game.netSession.send({t:'trk'});return true;}return origTrk(u,fromAI);};
 var origMnt=game.tryMount.bind(game);
 game.tryMount=function(u,announce){if(isGuestSession()&&u===game.player){if(game.netSession)game.netSession.send({t:'mnt'});return true;}return origMnt(u,announce);};
 var origReturn=game.returnMenu.bind(game);
 game.returnMenu=function(){if(window.__aetherNet&&window.__aetherNet.started){window.__aetherNet.leave();}return origReturn();};
 window.addEventListener('beforeunload',function(){if(window.__aetherNet)try{window.__aetherNet.send({t:'bye'});}catch(e){}});
 document.addEventListener('visibilitychange',function(){
  var s=window.__aetherNet;
  if(!s||!s.started)return;
  if(document.hidden&&s.role==='host'){try{game.message('Host tab in background — game may stall until you return');}catch(e){}}
 });
}
whenGame(buildUI);
})();
