// Aetherfall Arena authoritative co-op server v3.
// Both browsers send only inputs/actions; this process owns the entire match.
import { getClass } from '../../packages/content/src/catalogue.js';
import { CoopRoom } from '../../packages/server-core/src/coop-room.js';

const PROTOCOL_VERSION = 11;
const TICK_RATE = 30;
const SNAPSHOT_RATE = 20;
const TICK_SECONDS = 1 / TICK_RATE;
const MAX_BUFFERED_BYTES = 64 * 1024;
const ROOM_IDLE_MS = 5 * 60_000;
const MAX_ROOMS = 200;
const MAX_MESSAGE_BYTES = 16 * 1024;
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);
const ALLOWED_ORIGINS = new Set(String(Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean));

type SocketState = {
  clientId: string;
  roomCode: string;
  sessionToken: string;
};

type LiveRoom = {
  room: CoopRoom;
  sockets: Map<string, WebSocket>;
  lastActive: number;
  lastPhase: string;
  snapshotAccumulator: number;
};

const liveRooms = new Map<string, LiveRoom>();
const socketState = new WeakMap<WebSocket, SocketState>();
const messageRates = new WeakMap<WebSocket, { startedAt: number; count: number }>();

function cleanCode(value: unknown) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

function cleanId(value: unknown) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function arenaFor(code: string) {
  const serpent = [...code].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 === 1;
  return {
    theme: serpent ? 'serpent' : 'runestone',
    x: 32,
    z: 22,
    pillars: (serpent
      ? [[-18, -10.7, 1.72], [18, -10.7, 1.72], [-18, 10.7, 1.72], [18, 10.7, 1.72]]
      : [[-17, -10.2, 1.76], [17, -10.2, 1.76], [-17, 10.2, 1.76], [17, 10.2, 1.76]])
      .map(([x, z, radius], index) => ({ id: `pillar-${index + 1}`, x, z, radius }))
  };
}

function json(socket: WebSocket, value: unknown, droppable = false) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (droppable && socket.bufferedAmount > MAX_BUFFERED_BYTES) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function roomSeed(code: string) {
  let seed = 2166136261;
  for (const char of code) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}

function getOrCreateRoom(code: string) {
  let live = liveRooms.get(code);
  if (live) return live;
  if (liveRooms.size >= MAX_ROOMS) throw new Error('server_busy');
  const room = new CoopRoom({ code, seed: roomSeed(code), arena: arenaFor(code) });
  live = { room, sockets: new Map(), lastActive: Date.now(), lastPhase: room.phase, snapshotAccumulator: 0 };
  liveRooms.set(code, live);
  return live;
}

function playerSummary(live: LiveRoom) {
  return [...live.room.players.values()].map((player) => ({
    slot: player.slot,
    unitId: player.unitId,
    classId: player.classId,
    connected: player.connected,
    host: player.slot === 'player1'
  }));
}

function broadcast(live: LiveRoom, value: unknown, droppable = false) {
  for (const [clientId, socket] of live.sockets) {
    const player = [...live.room.players.values()].find((entry) => entry.clientId === clientId && entry.connected);
    if (player) json(socket, value, droppable);
  }
}

function broadcastLobby(live: LiveRoom) {
  broadcast(live, {
    type: 'lobby',
    protocol: PROTOCOL_VERSION,
    roomCode: live.room.code,
    phase: live.room.phase,
    ready: live.room.ready,
    players: playerSummary(live)
  });
}

function detach(socket: WebSocket) {
  const state = socketState.get(socket);
  if (!state) return;
  const live = liveRooms.get(state.roomCode);
  if (!live) return;
  const current = live.sockets.get(state.clientId);
  if (current !== socket) return;
  live.sockets.delete(state.clientId);
  live.room.disconnect(state.clientId);
  live.lastActive = Date.now();
  broadcastLobby(live);
}

function join(socket: WebSocket, message: Record<string, unknown>) {
  const roomCode = cleanCode(message.roomCode);
  const clientId = cleanId(message.clientId);
  const classId = cleanId(message.classId);
  const sessionToken = cleanId(message.sessionToken);
  const talents = message.talents && typeof message.talents === 'object'
    ? Object.fromEntries(Object.entries(message.talents as Record<string, unknown>)
      .slice(0, 64)
      .map(([id, rank]) => [cleanId(id), Math.max(0, Math.min(3, Number(rank) || 0))]))
    : {};
  if (Number(message.protocol) !== PROTOCOL_VERSION) {
    json(socket, { type: 'error', reason: 'version_mismatch', protocol: PROTOCOL_VERSION });
    return;
  }
  if (!roomCode || !clientId || !getClass(classId)) {
    json(socket, { type: 'error', reason: 'invalid_join' });
    return;
  }
  detach(socket);
  let live: LiveRoom;
  try { live = getOrCreateRoom(roomCode); } catch {
    json(socket, { type: 'error', reason: 'server_busy' });
    return;
  }
  live.room.expireDisconnected();
  const result = live.room.join({ clientId, classId, talents, sessionToken: sessionToken || null });
  if (!result.ok) {
    json(socket, { type: 'error', reason: result.reason });
    return;
  }
  const replaced = live.sockets.get(clientId);
  live.sockets.set(clientId, socket);
  live.lastActive = Date.now();
  socketState.set(socket, { clientId, roomCode, sessionToken: result.sessionToken });
  if (replaced && replaced !== socket) {
    json(replaced, { type: 'replaced' });
    try { replaced.close(4001, 'replaced'); } catch { /* ignored */ }
  }
  json(socket, {
    type: 'joined',
    protocol: PROTOCOL_VERSION,
    ...result,
    players: playerSummary(live),
    region: Deno.env.get('DENO_REGION') || 'unknown',
    instance: INSTANCE_ID
  });
  broadcastLobby(live);
  if (result.reconnected && live.room.simulation) {
    const snapshot = live.room.snapshotFor(clientId);
    if (snapshot) json(socket, { type: 'snapshot', ...snapshot });
  }
}

function handle(socket: WebSocket, message: Record<string, unknown>) {
  if (message.type === 'ping') {
    json(socket, { type: 'pong', clientTime: Number(message.clientTime) || 0, serverTime: Date.now() });
    return;
  }
  if (message.type === 'join') {
    join(socket, message);
    return;
  }
  const state = socketState.get(socket);
  const live = state ? liveRooms.get(state.roomCode) : null;
  if (!state || !live || live.sockets.get(state.clientId) !== socket) {
    json(socket, { type: 'error', reason: 'not_joined' });
    return;
  }
  live.lastActive = Date.now();
  if (message.type === 'start') {
    const result = live.room.start(state.clientId);
    json(socket, { type: 'startAck', ...result });
    if (result.ok) {
      broadcast(live, {
        type: 'matchStart',
        phase: result.phase,
        countdownRemaining: result.countdownRemaining,
        seed: result.seed,
        controlledUnits: Object.fromEntries([...live.room.players.values()].map((player) => [player.clientId, player.unitId])),
        world: result.snapshot
      });
    }
    return;
  }
  if (message.type === 'class') {
    const classId = cleanId(message.classId);
    const talents = message.talents && typeof message.talents === 'object'
      ? Object.fromEntries(Object.entries(message.talents as Record<string, unknown>)
        .slice(0, 64)
        .map(([id, rank]) => [cleanId(id), Math.max(0, Math.min(3, Number(rank) || 0))]))
      : {};
    if (live.room.updateClass(state.clientId, classId, talents)) broadcastLobby(live);
    else json(socket, { type: 'error', reason: 'class_change_rejected' });
    return;
  }
  if (message.type === 'input') {
    const accepted = live.room.input(state.clientId, {
      sequence: Number(message.sequence), x: Number(message.x), z: Number(message.z)
    });
    if (!accepted) json(socket, { type: 'inputRejected', sequence: message.sequence });
    return;
  }
  if (message.type === 'resync') {
    const snapshot = live.room.snapshotFor(state.clientId);
    if (snapshot) json(socket, { type: 'snapshot', ...snapshot });
    return;
  }
  if (message.type === 'action') {
    const result = live.room.action(state.clientId, {
      sequence: Number(message.sequence),
      abilityId: String(message.abilityId || ''),
      targetId: message.targetId == null ? null : String(message.targetId)
    });
    const snapshot = live.room.snapshotFor(state.clientId);
    json(socket, {
      type: 'actionAck', sequence: Number(message.sequence), ...result,
      unit: snapshot?.world.units.find((unit) => unit.id === snapshot.controlledUnitId) || null
    });
    return;
  }
  if (message.type === 'trinket') {
    json(socket, { type: 'trinketAck', ...live.room.trinket(state.clientId) });
    return;
  }
  if (message.type === 'leave') {
    detach(socket);
    try { socket.close(1000, 'left'); } catch { /* ignored */ }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, live] of liveRooms) {
    live.room.expireDisconnected();
    if (live.room.phase === 'countdown' || live.room.phase === 'running') {
      live.room.tick(TICK_SECONDS);
      const events = live.room.simulation?.drainEvents() || [];
      if (events.length) broadcast(live, { type: 'events', events });
      live.snapshotAccumulator += TICK_SECONDS;
      if (live.snapshotAccumulator + 1e-9 >= 1 / SNAPSHOT_RATE) {
        live.snapshotAccumulator -= 1 / SNAPSHOT_RATE;
        for (const [clientId, socket] of live.sockets) {
          const snapshot = live.room.snapshotFor(clientId);
          if (snapshot) json(socket, { type: 'snapshot', ...snapshot }, true);
        }
      }
      if (live.lastPhase !== 'ended' && live.room.phase === 'ended') {
        broadcast(live, { type: 'matchEnd', phase: live.room.phase });
      }
    }
    live.lastPhase = live.room.phase;
    if (now - live.lastActive > ROOM_IDLE_MS && ![...live.room.players.values()].some((player) => player.connected)) {
      liveRooms.delete(code);
    }
  }
}, 1000 / TICK_RATE);

Deno.serve((request: Request) => {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({
      service: 'Aetherfall authoritative co-op',
      protocol: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      activeRooms: liveRooms.size,
      region: Deno.env.get('DENO_REGION') || 'unknown',
      instance: INSTANCE_ID
    }, { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  }
  const origin = request.headers.get('origin');
  if (ALLOWED_ORIGINS.size && origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response('Origin not allowed', { status: 403 });
  }
  const { socket, response } = Deno.upgradeWebSocket(request);
  messageRates.set(socket, { startedAt: Date.now(), count: 0 });
  socket.onmessage = (event) => {
    const raw = String(event.data);
    if (raw.length > MAX_MESSAGE_BYTES) {
      try { socket.close(1009, 'message too large'); } catch { /* ignored */ }
      return;
    }
    const rate = messageRates.get(socket)!;
    const now = Date.now();
    if (now - rate.startedAt >= 1000) { rate.startedAt = now; rate.count = 0; }
    rate.count += 1;
    if (rate.count > 240) {
      try { socket.close(1008, 'rate limit'); } catch { /* ignored */ }
      return;
    }
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (message && typeof message === 'object') handle(socket, message as Record<string, unknown>);
  };
  socket.onclose = () => detach(socket);
  socket.onerror = () => detach(socket);
  return response;
});
