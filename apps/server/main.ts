// Aetherfall Arena authoritative co-op server v3.
// Both browsers send only inputs/actions; this process owns the entire match.
import { getClass } from '../../packages/content/src/catalogue.js';
import { CoopRoom } from '../../packages/server-core/src/coop-room.js';
import { arenaFor } from '../../packages/content/src/arena-layouts.js';
import { AccountAccess } from '../../packages/server-core/src/account-access.js';

const PROTOCOL_VERSION = 20;
const TICK_RATE = 30;
// Match the 30 Hz authoritative simulation so clients receive one fresh state
// per simulated step instead of displaying repeated 20 Hz correction pulses.
const SNAPSHOT_RATE = 30;
const TICK_SECONDS = 1 / TICK_RATE;
const MAX_BUFFERED_BYTES = 64 * 1024;
const ROOM_IDLE_MS = 5 * 60_000;
const MAX_ROOMS = 200;
const MAX_MESSAGE_BYTES = 16 * 1024;
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);
const ALLOWED_ORIGINS = new Set(String(Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean));
const accounts = new AccountAccess({endpoint:Deno.env.get('ACCOUNT_VERIFY_URL') || 'https://amazing-fenglisu-72d040.netlify.app/api/arena-account'});

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
const chatRates = new WeakMap<WebSocket, number[]>();

function cleanCode(value: unknown) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

function cleanId(value: unknown) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function cleanFormat(value: unknown) {
  return value === '1v1' ? '1v1' : '2v2';
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

function getOrCreateRoom(code: string, format = '2v2') {
  let live = liveRooms.get(code);
  if (live) return live;
  if (liveRooms.size >= MAX_ROOMS) throw new Error('server_busy');
  const room = new CoopRoom({ code, seed: roomSeed(code), arena: arenaFor(code), format });
  live = { room, sockets: new Map(), lastActive: Date.now(), lastPhase: room.phase, snapshotAccumulator: 0 };
  liveRooms.set(code, live);
  return live;
}

function playerSummary(live: LiveRoom) {
  return [...live.room.players.values()].map((player) => ({
    slot: player.slot,
    unitId: player.unitId,
    classId: player.classId,
    displayName: player.displayName,
    itemLevel: 990,
    connected: player.connected,
    lockedIn: !!player.lockedIn,
    host: player === live.room.host
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
    hostClientId: live.room.host?.clientId,
    ready: live.room.ready,
    format: live.room.format,
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

function rejectAccount(socket: WebSocket, result: Record<string, unknown>) {
  if(result.code==='ACCOUNT_CHECK_PENDING'||result.code==='ACCOUNT_CHECK_SUPERSEDED')return;
  json(socket,{type:'accountDenied',reason:result.code||'ACCOUNT_AUTH_REQUIRED',ban:result.ban});
  detach(socket);accounts.forget(socket);socketState.delete(socket);
  try{socket.close(4003,'account access denied');}catch{/* already closed */}
}

async function join(socket: WebSocket, message: Record<string, unknown>) {
  const roomCode = cleanCode(message.roomCode);
  const clientId = cleanId(message.clientId);
  const classId = cleanId(message.classId);
  const sessionToken = cleanId(message.sessionToken);
  const format = cleanFormat(message.format);
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
  const account=await accounts.verify(socket,message.playTicket,{refresh:!!accounts.current(socket)});
  if(!account.allowed){rejectAccount(socket,account);return;}
  if(socket.readyState!==WebSocket.OPEN)return;
  const existingRoom=liveRooms.get(roomCode)?.room;
  const oldPlayer=[...(existingRoom?.players.values()||[])].find(player=>player.clientId===clientId);
  const tokenSlot=sessionToken?existingRoom?.sessions.get(sessionToken):null;
  const sessionPlayer=tokenSlot?existingRoom?.players.get(tokenSlot):null;
  const sessionClientId=sessionPlayer?.clientId;
  if([oldPlayer,sessionPlayer].some(player=>player?.accountId&&player.accountId!==account.playerId)){rejectAccount(socket,{code:'ACCOUNT_SUBJECT_MISMATCH'});return;}
  const displayName=account.nickname;
  detach(socket);
  let live: LiveRoom;
  try { live = getOrCreateRoom(roomCode, format); } catch {
    json(socket, { type: 'error', reason: 'server_busy' });
    return;
  }
  live.room.expireDisconnected();
  const result = live.room.join({ clientId, classId, talents, displayName, format, sessionToken: sessionToken || null });
  if (!result.ok) {
    json(socket, { type: 'error', reason: result.reason });
    return;
  }
  const joinedPlayer=[...live.room.players.values()].find(player=>player.clientId===clientId);
  if(joinedPlayer)joinedPlayer.accountId=account.playerId;
  const replaced = live.sockets.get(clientId) || (sessionClientId ? live.sockets.get(sessionClientId) : null);
  if(sessionClientId&&sessionClientId!==clientId)live.sockets.delete(sessionClientId);
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

async function handle(socket: WebSocket, message: Record<string, unknown>) {
  if (message.type === 'ping') {
    json(socket, { type: 'pong', clientTime: Number(message.clientTime) || 0, serverTime: Date.now() });
    return;
  }
  if (message.type === 'join') {
    await join(socket, message);
    return;
  }
  if(message.type==='authenticate'){
    if(!socketState.has(socket)){rejectAccount(socket,{code:'ACCOUNT_AUTH_REQUIRED'});return;}
    const result=await accounts.verify(socket,message.playTicket,{refresh:true});
    if(!result.allowed)rejectAccount(socket,result);else json(socket,{type:'accountVerified',expiresAt:result.expiresAt});
    return;
  }
  if(!accounts.current(socket)){rejectAccount(socket,{code:'ACCOUNT_AUTH_REQUIRED'});return;}
  const state = socketState.get(socket);
  const live = state ? liveRooms.get(state.roomCode) : null;
  if (!state || !live || live.sockets.get(state.clientId) !== socket) {
    json(socket, { type: 'error', reason: 'not_joined' });
    return;
  }
  live.lastActive = Date.now();
  if(message.type === 'chat') {
    const player=[...live.room.players.values()].find(p=>p.clientId===state.clientId&&p.connected);
    if(!player)return;
    const now=Date.now(),recent=(chatRates.get(socket)||[]).filter(t=>now-t<10000);
    const text=String(message.text||'').replace(/[\u0000-\u001f\u007f<>]/g,' ').trim().slice(0,240);
    if(!text)return;
    if(recent.length>=6){json(socket,{type:'chatError',text:'Please wait a moment before sending more messages.'});return;}
    recent.push(now);chatRates.set(socket,recent);
    broadcast(live,{type:'chat',senderId:player.unitId,senderName:player.displayName,text,createdAt:now});
    return;
  }
  if (message.type === 'start') {
    const requestedFormat = cleanFormat(message.format);
    const result = live.room.start(state.clientId, requestedFormat);
    json(socket, { type: 'startAck', ...result });
    if (result.ok) {
      broadcast(live, {
        type: 'matchStart',
        phase: result.phase,
        countdownRemaining: result.countdownRemaining,
        seed: result.seed,
        format: result.format,
        controlledUnits: Object.fromEntries([...live.room.players.values()].map((player) => [player.clientId, player.unitId])),
        world: result.snapshot
      });
    }
    return;
  }
  if (message.type === 'format') {
    if (live.room.updateFormat(state.clientId, cleanFormat(message.format))) broadcastLobby(live);
    else json(socket, { type: 'error', reason: 'format_change_rejected' });
    return;
  }
  if(message.type==='ready'){
    if(live.room.setReady(state.clientId,message.ready===true))broadcastLobby(live);
    else json(socket,{type:'error',reason:'ready_change_rejected'});return;
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
      sequence: Number(message.sequence), x: Number(message.x), z: Number(message.z), facing:Number(message.facing),jumpSequence:Number(message.jumpSequence),
      ...(Object.hasOwn(message,'targetId')?{targetId:typeof message.targetId==='string'?cleanId(message.targetId):null}:{})
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
      targetId: message.targetId == null ? null : String(message.targetId),
      x: Number.isFinite(Number(message.x)) ? Number(message.x) : null,
      z: Number.isFinite(Number(message.z)) ? Number(message.z) : null,
      directionX: Number.isFinite(Number(message.directionX)) ? Number(message.directionX) : null,
      directionZ: Number.isFinite(Number(message.directionZ)) ? Number(message.directionZ) : null
    });
    const snapshot = live.room.snapshotFor(state.clientId);
    json(socket, {
      type: 'actionAck', sequence: Number(message.sequence), ...result,
      unit: snapshot?.world.units.find((unit) => unit.id === snapshot.controlledUnitId) || null
    });
    return;
  }
  if (message.type === 'returnToLobby') {
    if (!live.room.returnToLobby(state.clientId)) {
      json(socket, { type: 'error', reason: 'return_to_lobby_rejected' });
      return;
    }
    live.lastPhase = 'lobby';
    broadcast(live, {
      type: 'returnedToLobby', protocol: PROTOCOL_VERSION,
      roomCode: live.room.code, phase: live.room.phase, format: live.room.format,
      ready: live.room.ready, players: playerSummary(live)
    });
    broadcastLobby(live);
    return;
  }
  if (message.type === 'trinket') {
    json(socket, { type: 'trinketAck', ...live.room.trinket(state.clientId) });
    return;
  }
  if (message.type === 'mount') {
    json(socket, { type: 'mountAck', ...live.room.mount(state.clientId, {
      mounted: !!message.mounted,
      mountId: cleanId(message.mountId),
      mountSkinId: cleanId(message.mountSkinId)
    }) });
    return;
  }
  if (message.type === 'leave') {
    live.room.leave(state.clientId);live.sockets.delete(state.clientId);socketState.delete(socket);live.lastPhase='lobby';
    broadcast(live,{type:'returnedToLobby',players:playerSummary(live),ready:live.room.ready});broadcastLobby(live);
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
        broadcast(live, {
          type: 'matchEnd', phase: live.room.phase,
          winnerTeam: live.room.winnerTeam, format: live.room.format
        });
      }
    }
    live.lastPhase = live.room.phase;
    if (now - live.lastActive > ROOM_IDLE_MS && ![...live.room.players.values()].some((player) => player.connected)) {
      liveRooms.delete(code);
    }
  }
}, 1000 / TICK_RATE);

// No network calls inside the simulation tick. Recheck live accounts separately;
// new bans revoke existing matches as well as future joins.
setInterval(()=>{
  for(const live of liveRooms.values())for(const socket of live.sockets.values())if(accounts.needsCheck(socket)){
    accounts.recheck(socket).then(result=>{if(!result.allowed)rejectAccount(socket,result);});
  }
},5000);

Deno.serve((request: Request) => {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({
      service: 'Aetherfall authoritative co-op',
      release: '2.61.1',
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
    if (message && typeof message === 'object') handle(socket, message as Record<string, unknown>).catch(()=>{
      json(socket,{type:'error',reason:'request_failed'});
    });
  };
  socket.onclose = () => {detach(socket);accounts.forget(socket);};
  socket.onerror = () => {detach(socket);accounts.forget(socket);};
  return response;
});
