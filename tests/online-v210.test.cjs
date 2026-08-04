const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const online = fs.readFileSync(
  '/workspace/scratch/c17cbdb3a523/aetherfall-online/apps/client/src/online-v210.js',
  'utf8',
).replace('whenGame(buildUI);', 'window.__NET_TEST={NetSession,RelayTransport,TabTransport,NET_VERSION};');

const AB = { wind: [
  {name:'Zephyr Palm',type:'damage',school:'wind',range:3.5,cast:0,cd:1.5,cost:10,value:100},
  {name:'Tigereye Brew',type:'tigereyeBrew',school:'wind',range:0,cast:0,cd:1,cost:0,value:0}
] };
const progression = {talents:{wind:{wind_tigereye_brew:1}}};
const sandbox = {
  console, performance, crypto: require('crypto').webcrypto,
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextDecoder, TextEncoder, URL, Math, Date, JSON,
  window: {AETHER_ONLINE_BRIDGE:{CLASS_INFO:{wind:{name:'Windwalker'}},AB,AIController:function(){},getProgression:()=>progression},addEventListener(){}},
  document: {getElementById(){return null;}, addEventListener(){}, createElement(){return {style:{},appendChild(){},remove(){}};}, body:{appendChild(){}}, head:{appendChild(){}}},
  location:{protocol:'http:',origin:'http://test',pathname:'/index.html',hash:''},
  sessionStorage:{getItem(){return null;},setItem(){}},localStorage:{getItem(){return null;},setItem(){}},
  BroadcastChannel:function(){this.postMessage=()=>{};this.close=()=>{};},
  WebSocket:function(){},RTCPeerConnection:function(){},navigator:{clipboard:{writeText(){}}}
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox); vm.runInContext(online, sandbox, {filename:'v210-online.js'});
const {NetSession, NET_VERSION} = sandbox.window.__NET_TEST;
assert.equal(NET_VERSION, 7);

function stats(){return {damage:0,healing:0,absorb:0,interrupts:0,kb:0,damageByAbility:{},damageByTarget:{},healingByAbility:{},healingByTarget:{}};}
function unit(id, player=false){
  return {netId:id,cls:'wind',name:player?'P2':'Bot',team:player?'ally':'enemy',x:0,z:0,hp:1000,maxHp:1000,resource:100,shield:0,alive:true,mounted:false,gcd:0,cds:[0,0],cast:null,effects:[],stats:stats(),tigereyeStacks:0,tigereyePalmCounter:0,intent:null,mesh:{rotation:{y:0}},
    has(type){return this.effects.find(e=>e.type===type&&e.time>0);},
    effect(type,time,data={}){let e=this.effects.find(x=>x.type===type);if(!e){e={type,time};this.effects.push(e);}e.time=time;Object.assign(e,data);return e;},
    update(){},
  };
}
function gameWith(units){
  const g={units,player:units[0],phase:'fight',time:5,count:0,dampening:.1,netGuest:false,netSession:null,
    arena:{constrain(){},los(){return true;}},message(){},renderActions(){g.renderCount=(g.renderCount||0)+1;},updateDetailsMeter(){g.meterCount=(g.meterCount||0)+1;},
    localMoveIntent(){return null;},unitMoveByIntent(){},audio:{play(){}},applyTalentAbilityMods(u,a){return a;},animateAction(){},
    castFor(u,i){g.castExecutions=(g.castExecutions||0)+1;u.gcd=1.5;u.cds[i]=1.5;return true;},fail(){return false;}
  };return g;
}

// Complete snapshot + Details synchronization.
{
  const p2=unit(2,true),bot=unit(3),g=gameWith([p2,bot]),s=new NetSession(g);
  p2.tigereyeStacks=4;p2.tigereyePalmCounter=1;p2.effect('slow',4,{pct:.6});p2.effect('tigereyeBrew',6,{power:.2,stacks:4});
  p2.stats.damage=321.5;p2.stats.healing=87;p2.stats.damageByAbility['Zephyr Palm']=321.5;p2.stats.damageByTarget.Bot=321.5;
  s.hostGuestInputSeq=12;
  const snap=s.snapshot(),wire=JSON.parse(JSON.stringify(snap));
  assert.equal(wire.iq,12);assert.equal(wire.units[0].te,4);assert.equal(wire.units[0].tp,1);
  assert.equal(wire.units[0].fx.find(x=>x[0]==='slow')[4],.6);
  assert.equal(wire.units[0].fx.find(x=>x[0]==='tigereyeBrew')[3],.2);
  const meter=JSON.parse(JSON.stringify(s.statsSnapshot()));assert.equal(meter[0].d,321.5);assert.equal(meter[0].da['Zephyr Palm'],321.5);

  const gp=unit(2,true),gb=unit(3),gg=gameWith([gp,gb]),gs=new NetSession(gg);gs.lastSnapshotAt=0;
  gs.applySnapshot(wire);gs.applyStats(meter);
  assert.equal(gp.tigereyeStacks,4);assert.equal(gp.tigereyePalmCounter,1);assert.equal(gp.has('slow').pct,.6);assert.equal(gp.has('tigereyeBrew').power,.2);
  assert.equal(gp.stats.damage,321.5);assert.equal(gp.stats.damageByAbility['Zephyr Palm'],321.5);assert.ok(gg.renderCount>0);assert.ok(gg.meterCount>0);
}

// Changed/stop input gets an unreliable fast copy plus an ordered copy.
{
  const p=unit(2,true),g=gameWith([p]),s=new NetSession(g),sent=[];s.send=o=>sent.push(JSON.parse(JSON.stringify(o)));
  p.intent={x:1,z:0};s.maybeSendIntent(.016);p.intent=null;s.maybeSendIntent(.016);
  assert.deepEqual(sent.map(x=>x.t),['in','inr','in','inr']);assert.ok(sent[2].q>sent[0].q);assert.equal(sent[3].x,0);assert.equal(sent[3].z,0);
}

// Retried actions are idempotent on the host.
{
  const host=unit(1,true),p2=unit(2),bot=unit(3),g=gameWith([host,p2,bot]),s=new NetSession(g),sent=[];
  s.role='host';s.started=true;s.guestUnitId=2;s.send=o=>sent.push(JSON.parse(JSON.stringify(o)));
  p2.netAbilities=AB.wind.slice();p2.netTalents={wind_tigereye_brew:1};
  const msg={t:'cast',q:55,i:0,tg:3,a:AB.wind[0],px:0,pz:0,iq:2};s.onMsg(msg);s.onMsg(msg);
  assert.equal(g.castExecutions,1);assert.equal(sent.filter(x=>x.t==='ack'&&x.q===55).length,2);assert.ok(s.processedActions[55]);
}

// Guest retries an unacknowledged cast and falls back from a silent direct route.
{
  const p=unit(2,true),bot=unit(3),g=gameWith([p,bot]),s=new NetSession(g),sent=[];s.role='guest';s.started=true;s.lastSnap=null;s.hudTimer=10;s.pingTimer=10;s.send=o=>sent.push(JSON.parse(JSON.stringify(o)));
  s.pendingActions[9]={at:performance.now()-500,lastSend:performance.now()-400,retries:0,packet:{t:'cast',q:9}};
  s.guestFrame(.016);assert.ok(sent.some(x=>x.t==='cast'&&x.q===9));assert.equal(s.pendingActions[9].retries,1);
  let relay=null,why=null;s.tp={route:'direct',send(){},sendRelay(m){relay=m;},fallbackToRelay(r){this.route='relay';why=r;}};s.lastSnapshotAt=performance.now()-1100;s.recoveryAt=0;s.hudTimer=10;s.pingTimer=10;
  s.guestFrame(.016);assert.equal(s.tp.route,'relay');assert.equal(relay.t,'routeFallback');assert.equal(why,'state timeout');
}

console.log('v210 protocol tests passed: snapshots/effects, Tigereye, meters, input stop, cast idempotency/retry, route recovery');
