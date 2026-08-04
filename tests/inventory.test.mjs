import assert from 'node:assert/strict';
import test from 'node:test';
import inventory from '../reports/legacy-content-inventory.json' with { type: 'json' };

test('legacy inventory has stable unique IDs and complete class coverage', () => {
  assert.equal(inventory.totals.classes, 9);
  const abilities = inventory.classes.flatMap((entry) => [
    ...entry.baseAbilities,
    ...entry.talentAbilities
  ]);
  assert.equal(abilities.length, inventory.totals.baseAbilities + inventory.totals.talentAbilities);
  assert.equal(new Set(abilities.map((ability) => ability.id)).size, abilities.length);
  assert.ok(inventory.classes.every((entry) => entry.baseAbilities.length >= 7));
});

test('known mechanics needed by the authoritative migration are present', () => {
  const wind = inventory.classes.find((entry) => entry.id === 'wind');
  assert.ok(wind.baseAbilities.some((ability) => ability.name === 'Zephyr Palm'));
  assert.ok(wind.talentAbilities.some((ability) => ability.type === 'tigereyeBrew'));
  const discipline = inventory.classes.find((entry) => entry.id === 'disc');
  assert.ok(discipline.baseAbilities.some((ability) => ability.atonementHeal));
});
