import '../generated/arena-layouts.generated.js';

export const arenaLayouts = globalThis.AETHER_ARENAS;
export const arenaFor = code => arenaLayouts.forRoom(code);
