import {combatTuning as data} from '../generated/combat-tuning.generated.js';
// Apply shared choice-pool limits to old or stale client builds at the lobby boundary.
export function limitTalentPools(classId,talents={}){
 const result={...talents},counts=new Map();
 for(const node of data.trees[classId]||[]){
  if(!node.capstoneGroup||!(Number(result[node.id])>0))continue;
  const count=counts.get(node.capstoneGroup)||0;
  if(count>=(node.capstoneLimit||2))delete result[node.id];
  else counts.set(node.capstoneGroup,count+1);
 }
 return result;
}
export function normalizedVitals(classId,talents={}){
 const gear=data.gear[classId],healer=['sage','pala','disc'].includes(classId),energy=['shadow','wind','warrior'].includes(classId);
 const staminaMultiplier=1+(data.trees[classId]||[]).reduce((sum,n)=>sum+(talents[n.id]||0)*(n.effects?.staminaPct||0)/100,0);
 const maxHp=Math.round(((healer?data.balance.healerHP:data.balance.dpsHP)+Math.round(gear.Stamina*.78)+Math.min(300,Math.round(gear.Vitality*.5)))*staminaMultiplier*1.10);
 const baseResource=energy?100:100+Math.min(60,Math.round(gear.Mana*.18));
 return {maxHp,hp:maxHp,maxResource:classId==='soul'?Math.round(baseResource*1.15):baseResource,
 resourceRegen:energy?data.balance.energyRegen:(classId==='soul'?1.30:classId==='storm'?1.20:1)*(healer?data.balance.healerManaRegen:data.balance.manaRegen)*(1+Math.min(.30,gear.Mana*.00075))*(classId==='disc'?.88:1)};
}
export function botBuild(classId,random){const bank=data.builds[classId]||[{}];return {...bank[Math.floor(random()*bank.length)]};}
export function tuneAbility(ability){
 const defs=data.abilities[ability.classId];if(!defs)return ability;
 const match=ability.source==='talent'?defs.talents[ability.id]:defs.base.find(a=>a.name===ability.name);
 if(!match)return ability;
 let cost=match.cost||0;
 if(ability.source==='talent'&&cost&&!['sage','pala','disc'].includes(ability.classId))cost=ability.classId==='storm'?Math.round(Math.max(1,Math.ceil(cost*.30))*1.10*10)/10:Math.max(1,Math.ceil(cost*.30));
 return {...ability,cost,range:match.range};
}
