/**
 * Content is version-controlled data. Runtime behavior stays in the simulation
 * package so an edited database row can never inject executable combat logic.
 */
export function defineAbility(value) {
  const ability = structuredClone(value);
  for (const key of ['id', 'name', 'type']) {
    if (typeof ability[key] !== 'string' || !ability[key]) {
      throw new TypeError(`Ability ${key} must be a non-empty string`);
    }
  }
  for (const key of ['cooldown', 'cost', 'range', 'castTime']) {
    if (!Number.isFinite(ability[key]) || ability[key] < 0) {
      throw new TypeError(`Ability ${ability.id} has invalid ${key}`);
    }
  }
  return Object.freeze(ability);
}

export function defineClass(value) {
  if (!value || typeof value.id !== 'string' || !Array.isArray(value.baseAbilities) || !Array.isArray(value.talentAbilities)) {
    throw new TypeError('Class requires an id, baseAbilities and talentAbilities');
  }
  const baseAbilities = value.baseAbilities.map(defineAbility);
  const talentAbilities = value.talentAbilities.map(defineAbility);
  return Object.freeze({
    ...structuredClone(value),
    baseAbilities,
    talentAbilities,
    abilities: Object.freeze([...baseAbilities, ...talentAbilities])
  });
}

export function defineCatalogue(value) {
  if (!value || !Number.isInteger(value.formatVersion) || !Array.isArray(value.classes)) {
    throw new TypeError('Catalogue requires a formatVersion and classes');
  }
  const classes = value.classes.map(defineClass);
  const ids = classes.flatMap(entry => entry.abilities.map(ability => ability.id));
  if (new Set(ids).size !== ids.length) throw new TypeError('Ability IDs must be globally unique');
  return Object.freeze({ ...structuredClone(value), classes });
}
