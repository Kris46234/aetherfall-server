export const PROTOCOL_VERSION = 11;

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function playerInput(sequence, x, z) {
  if (!Number.isInteger(sequence) || sequence < 0 || !finite(x) || !finite(z)) {
    throw new TypeError('Invalid player input');
  }
  const length = Math.hypot(x, z);
  return Object.freeze({
    type: 'input',
    sequence,
    x: length > 1 ? x / length : x,
    z: length > 1 ? z / length : z,
  });
}

export function playerAction(sequence, abilityId, targetId = null) {
  if (!Number.isInteger(sequence) || sequence < 0 || typeof abilityId !== 'string') {
    throw new TypeError('Invalid player action');
  }
  return Object.freeze({ type: 'action', sequence, abilityId, targetId });
}

export function isClientMessage(value) {
  return !!value && (
    value.type === 'input' && Number.isInteger(value.sequence) && finite(value.x) && finite(value.z) ||
    value.type === 'action' && Number.isInteger(value.sequence) && typeof value.abilityId === 'string'
  );
}
