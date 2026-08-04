import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogue, getAbility, getClass } from '../packages/content/src/catalogue.js';
import { isClientMessage, playerAction, playerInput, PROTOCOL_VERSION } from '../packages/protocol/src/messages.js';

test('checkpoint content is immutable and server-readable', () => {
  const windwalker = getClass('wind');
  assert.equal(catalogue.classes.length, 9);
  assert.equal(windwalker.id, 'wind');
  assert.equal(getAbility('wind.zephyr_palm').baseValue, 50);
  assert.equal(getAbility('wind.zephyr_palm').cost, 16);
  assert.equal(getAbility('wind_tigereye_brew').type, 'tigereyeBrew');
  assert.equal(getAbility('wind_tiger_rush').definedCost, 8);
  assert.equal(getAbility('wind_tiger_rush').cost, 3);
  assert.equal(getAbility('flame.meteor').type, 'meteor');
  assert.equal(getAbility('wind.whirling_dragon_punch').offGlobal, true);
  assert.equal(getAbility('soul.unstable_affliction').baseValue, 50);
  assert.equal(getAbility('soul_pandemic_bloom').baseValue, 274);
  assert.equal(getAbility('disc.power_shield').cost, 6);
  assert.equal(getAbility('disc.penance').cost, 8);
  assert.equal(getAbility('disc.psychic_scream').cost, 4);
  assert.equal(getAbility('disc.shadow_mend').cost, 6);
  assert.equal(getAbility('disc.shadow_mend').baseValue, 286);
  assert.throws(() => { windwalker.id = 'changed'; }, TypeError);
});

test('protocol constructs bounded inputs and validates actions', () => {
  assert.equal(PROTOCOL_VERSION, 20);
  const input = playerInput(4, 2, 0);
  assert.equal(input.x, 1);
  assert.ok(isClientMessage(input));
  assert.ok(isClientMessage(playerAction(5, 'wind.zephyr_palm', 'enemy')));
  assert.equal(isClientMessage({ type: 'input', sequence: 1, x: Infinity, z: 0 }), false);
});
