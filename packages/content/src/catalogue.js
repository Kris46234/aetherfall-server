import { generatedCatalogue } from '../generated/catalogue.generated.js';
import { defineCatalogue } from './schema.js';
import {tuneAbility} from './combat-tuning.js';

const updated=structuredClone(generatedCatalogue);
updated.classes.find(c=>c.id==='wind').talentAbilities.push({id:'wind_reverse_harm',classId:'wind',source:'talent',name:'Reverse Harm',type:'reverseHarm',school:'nature',castTime:0,cooldown:10,cost:0,range:0,baseValue:.16});
for(const cls of updated.classes){cls.baseAbilities=cls.baseAbilities.map(tuneAbility);cls.talentAbilities=cls.talentAbilities.map(tuneAbility);}
export const catalogue = defineCatalogue(updated);

export const classById = new Map(catalogue.classes.map(entry => [entry.id, entry]));

export const abilityById = new Map(
  catalogue.classes.flatMap(entry => entry.abilities.map(ability => [ability.id, ability]))
);

export function getClass(classId) {
  return classById.get(classId) || null;
}

/* Ability ids that older published clients still send. A client and server can be
   deployed minutes apart, and without this a rename silently turns a button into
   "No valid target" until both halves are updated. Map the old id onto the current
   ability instead of rejecting the cast. */
const LEGACY_ABILITY_IDS = new Map([
  ['wind_whirling_dragon', 'wind.whirling_dragon_punch'],
  ['storm.healing_stream_totem', 'storm_static_field'],
  ['warrior.sharpen_blade', 'war_rallying_wall'],
  ['warrior.intercept', 'war_battle_banner'],
  ['sage.g_hanir_the_mother_tree', 'sage.ghanir_the_mother_tree'],
  ['soul.immolate', 'soul.creeping_torment']
]);

export function getAbility(abilityId) {
  const direct = abilityById.get(abilityId);
  if (direct) return direct;
  const legacy = LEGACY_ABILITY_IDS.get(abilityId);
  return (legacy && abilityById.get(legacy)) || null;
}
