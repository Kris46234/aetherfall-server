import { generatedCatalogue } from '../generated/catalogue.generated.js';
import { defineCatalogue } from './schema.js';

export const catalogue = defineCatalogue(generatedCatalogue);

export const classById = new Map(catalogue.classes.map(entry => [entry.id, entry]));

export const abilityById = new Map(
  catalogue.classes.flatMap(entry => entry.abilities.map(ability => [ability.id, ability]))
);

export function getClass(classId) {
  return classById.get(classId) || null;
}

export function getAbility(abilityId) {
  return abilityById.get(abilityId) || null;
}
