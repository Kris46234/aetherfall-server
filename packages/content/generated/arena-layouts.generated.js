/* Canonical combat geometry. The content build copies this exact file into the
   authoritative server. Visual scenery never adds hidden combat obstacles. */
(function (root) {
 'use strict';
 const common = {x:32,z:22,groundY:-.55};
 const spawns = {
  duel:[{x:-20,z:0},{x:20,z:0}],
  team:[{x:-16,z:4},{x:-17,z:-4},{x:-12,z:0},{x:16,z:-4},{x:17,z:4},{x:12,z:0}],
  healer:[{x:-17,z:-4},{x:-15,z:4},{x:17,z:4},{x:16,z:-4}]
 };
 const definitions = {
  runestone:{name:'Twilight Runestone Court',pillars:[[-17,-10.2,1.76],[17,-10.2,1.76],[-17,10.2,1.76],[17,10.2,1.76]]},
  serpent:{name:'Serpent Gate Ruins',pillars:[[-18,-10.7,1.72],[18,-10.7,1.72],[-18,10.7,1.72],[18,10.7,1.72]]},
  'jade-summit':{
   name:'Jade Summit Sanctuary',
   description:'A mountaintop temple with two broad central sanctuaries, an open crossing, and long outer flanks.',
   // Broad, isolated cover instead of four corner pillars. Both team spawn
   // sides have identical distances, entrances and cover opportunities.
   pillars:[[0,-8,3.05],[0,8,3.05]]
  },
  training:{name:'Sanctum Training Grounds',pillars:[]}
 };
 for (const definition of Object.values(definitions)) {
  definition.pillars.forEach(Object.freeze);Object.freeze(definition.pillars);Object.freeze(definition);
 }
 Object.freeze(definitions);
 const pool=Object.freeze(['runestone','serpent','jade-summit']);
 function resolve(theme,random=Math.random) {
  if(theme==='random')return pool[Math.min(pool.length-1,Math.max(0,Math.floor(random()*pool.length)))];
  return definitions[theme]?theme:'runestone';
 }
 function create(theme) {
  theme=resolve(theme);const definition=definitions[theme];
  return {...common,theme,name:definition.name,description:definition.description||'',
   pillars:definition.pillars.map(([x,z,radius],i)=>({id:`${theme}-cover-${i+1}`,x,z,radius,r:radius})),
   spawns:Object.fromEntries(Object.entries(spawns).map(([mode,positions])=>[mode,positions.map(p=>({...p}))]))};
 }
 function forRoom(code) {
  // Stable per room: reconnecting never changes the battlefield beneath players.
  const hash=Array.from(String(code)).reduce((sum,char)=>sum+char.charCodeAt(0),0);
  return create(pool[hash%pool.length]);
 }
 root.AETHER_ARENAS=Object.freeze({version:1,pool,definitions,resolve,create,forRoom});
})(globalThis);
