const EPSILON = 1e-8;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function resolveArenaBounds(point, arena, radius = 0) {
  point.x = clamp(point.x, -arena.x + radius, arena.x - radius);
  point.z = clamp(point.z, -arena.z + radius, arena.z - radius);
}

export function resolvePillarCollisions(point, pillars, radius = 0) {
  for (const pillar of pillars) {
    const dx = point.x - pillar.x;
    const dz = point.z - pillar.z;
    const minimum = radius + pillar.radius;
    const length = Math.hypot(dx, dz);
    if (length >= minimum) continue;
    if (length < EPSILON) {
      point.x = pillar.x + minimum;
      point.z = pillar.z;
    } else {
      point.x = pillar.x + dx / length * minimum;
      point.z = pillar.z + dz / length * minimum;
    }
  }
}

export function resolveUnitCollisions(units) {
  const active = [...units].filter(unit => unit.alive).sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const first = active[i];
      const second = active[j];
      const dx = second.x - first.x;
      const dz = second.z - first.z;
      const minimum = first.radius + second.radius;
      const length = Math.hypot(dx, dz);
      if (length >= minimum) continue;
      const nx = length < EPSILON ? 1 : dx / length;
      const nz = length < EPSILON ? 0 : dz / length;
      const overlap = minimum - length;
      first.x -= nx * overlap / 2;
      first.z -= nz * overlap / 2;
      second.x += nx * overlap / 2;
      second.z += nz * overlap / 2;
    }
  }
}

function segmentDistanceSquared(from, to, point) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared < EPSILON) return (point.x - from.x) ** 2 + (point.z - from.z) ** 2;
  const t = clamp(((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared, 0, 1);
  const x = from.x + dx * t;
  const z = from.z + dz * t;
  return (point.x - x) ** 2 + (point.z - z) ** 2;
}

export function hasLineOfSight(from, to, pillars, clearance = 0) {
  return !pillars.some(pillar =>
    segmentDistanceSquared(from, to, pillar) < (pillar.radius + clearance) ** 2
  );
}
