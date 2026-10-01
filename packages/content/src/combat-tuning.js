import {combatTuning as data} from '../generated/combat-tuning.generated.js';
// Apply shared choice-pool limits to old or stale client builds at the lobby boundary.
export function limitTalentPools(classId,talents={}){
 const nodes=data.trees[classId]||[],result={},counts=new Map(),choices=new Set();
 for(const node of nodes){const rank=Math.min(Number(node.max)||1,Math.max(0,Math.floor(Number(talents[node.id])||0)));if(rank>0)result[node.id]=rank;}
 for(const node of nodes){
  if(node.choice&&Number(result[node.id])>0){if(choices.has(node.choice)){delete result[node.id];continue;}choices.add(node.choice);}
  if(!node.capstoneGroup||!(Number(result[node.id])>0))continue;
  const count=counts.get(node.capstoneGroup)||0;
  if(count>=(node.capstoneLimit||2))delete result[node.id];
  else counts.set(node.capstoneGroup,count+1);
 }
 const deepest=nodes.filter(node=>!node.virtualChoice).slice().sort((a,b)=>(b.y||0)-(a.y||0)||(b.x||0)-(a.x||0));
 let spent=Object.values(result).reduce((sum,rank)=>sum+rank,0);
 while(spent>29){const node=deepest.find(entry=>Number(result[entry.id]||0)>0);if(!node)break;if(--result[node.id]<=0)delete result[node.id];spent--;}
 return result;
}
export function normalizedVitals(classId,talents={}){
 const gear=data.gear[classId],healer=['sage','pala','disc'].includes(classId),energy=['shadow','wind','warrior'].includes(classId);
 const staminaMultiplier=1+(data.trees[classId]||[]).reduce((sum,n)=>sum+(talents[n.id]||0)*(n.effects?.staminaPct||0)/100,0);
 const maxHp=Math.round(((healer?data.balance.healerHP:data.balance.dpsHP)+Math.round(gear.Stamina*.78)+Math.min(300,Math.round(gear.Vitality*.5)))*staminaMultiplier*1.10*1.35);
 const baseResource=energy?100:100+Math.min(60,Math.round(gear.Mana*.18));
 return {maxHp,hp:maxHp,maxResource:classId==='soul'?Math.round(baseResource*1.15):baseResource,
 resourceRegen:energy?data.balance.energyRegen:(classId==='soul'?1.30:classId==='storm'?1.20:1)*(healer?data.balance.healerManaRegen:data.balance.manaRegen)*(1+Math.min(.30,gear.Mana*.00075))*(classId==='disc'?.88:1)};
}
export function botBuild(classId,random){
 const bank=data.builds[classId]||[{}],build=limitTalentPools(classId,{...bank[Math.floor(random()*bank.length)]});
 if(classId==='shadow'&&Number(build.eviscerate)>0&&random()<.72)build.shadow_find_weakness=1+(random()<.48?1:0);
 const tree=data.trees[classId]||[],spent=()=>Object.values(build).reduce((sum,rank)=>sum+Number(rank||0),0);
 while(spent()<29){const candidates=tree.filter(node=>{
  if(node.virtualChoice||Number(build[node.id]||0)>=(Number(node.max)||1))return false;
  if(node.req?.length&&!node.req.some(id=>Number(build[id]||0)>0))return false;
  if(node.choice&&tree.some(other=>other.id!==node.id&&other.choice===node.choice&&Number(build[other.id]||0)>0))return false;
  if(node.capstoneGroup&&tree.filter(other=>other.capstoneGroup===node.capstoneGroup&&Number(build[other.id]||0)>0).length>=(node.capstoneLimit||2)&&!build[node.id])return false;
  return true;
 });if(!candidates.length)break;const choice=candidates[Math.floor(random()*candidates.length)];build[choice.id]=Number(build[choice.id]||0)+1;}
 return limitTalentPools(classId,build);
}
export function tuneAbility(ability){
 const defs=data.abilities[ability.classId];if(!defs)return ability;
 const match=ability.source==='talent'?defs.talents[ability.id]:defs.base.find(a=>a.name===ability.name);
 if(!match)return ability;
 let cost=match.cost||0;
 if(ability.source==='talent'&&cost&&!['sage','pala','disc'].includes(ability.classId))cost=ability.classId==='storm'?Math.round(Math.max(1,Math.ceil(cost*.30))*1.10*10)/10:Math.max(1,Math.ceil(cost*.30));
 return {...ability,cost,range:match.range};
}
