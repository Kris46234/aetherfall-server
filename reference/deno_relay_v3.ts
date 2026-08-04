// Aetherfall Arena relay v3 — role-aware rendezvous + realtime fallback.
// Paste this entire file into Deno Deploy, then Save & Deploy.

type Role = "host" | "guest";
type Slot = { socket: WebSocket; clientId: string; lastSeen: number };
type Room = { host?: Slot; guest?: Slot };

const rooms = new Map<string, Room>();
const membership = new WeakMap<WebSocket, { code: string; role: Role }>();
const STALE_MS = 30_000;

function send(socket: WebSocket, payload: string, droppable = false) {
  if (socket.readyState !== WebSocket.OPEN) return;
  // Snapshots are replaceable. Never let them queue behind older snapshots.
  if (droppable && socket.bufferedAmount > 12 * 1024) return;
  try { socket.send(payload); } catch { /* close cleanup owns recovery */ }
}

function slot(room: Room, role: Role) {
  return role === "host" ? room.host : room.guest;
}

function setSlot(room: Room, role: Role, value?: Slot) {
  if (role === "host") room.host = value;
  else room.guest = value;
}

function otherRole(role: Role): Role {
  return role === "host" ? "guest" : "host";
}

function roomReady(room: Room) {
  return !!(room.host && room.guest);
}

function announceReady(room: Room) {
  if (!roomReady(room)) return;
  const message = JSON.stringify({ __sys: "ready", n: 2 });
  send(room.host!.socket, message);
  send(room.guest!.socket, message);
}

function leave(socket: WebSocket, notify = true) {
  const member = membership.get(socket);
  if (!member) return;
  const room = rooms.get(member.code);
  if (!room) return;
  const current = slot(room, member.role);
  // A replaced socket may close after its replacement is installed. It must not
  // remove the new socket or announce a false peer disconnect.
  if (!current || current.socket !== socket) return;
  setSlot(room, member.role, undefined);
  const other = slot(room, otherRole(member.role));
  if (notify && other) send(other.socket, JSON.stringify({ __sys: "peergone", role: member.role }));
  if (!room.host && !room.guest) rooms.delete(member.code);
}

function expireStale(room: Room) {
  const now = Date.now();
  (["host", "guest"] as Role[]).forEach((role) => {
    const current = slot(room, role);
    if (current && now - current.lastSeen > STALE_MS) {
      setSlot(room, role, undefined);
      const other = slot(room, otherRole(role));
      if (other) send(other.socket, JSON.stringify({ __sys: "peergone", role }));
      try { current.socket.close(4000, "stale"); } catch { /* ignored */ }
    }
  });
}

setInterval(() => {
  for (const [code, room] of rooms) {
    expireStale(room);
    if (!room.host && !room.guest) rooms.delete(code);
  }
}, 10_000);

Deno.serve((req: Request) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(`Aetherfall relay v3 OK — ${rooms.size} active room(s)`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }

    if (message.__ping) {
      const member = membership.get(socket);
      const room = member ? rooms.get(member.code) : undefined;
      const current = member && room ? slot(room, member.role) : undefined;
      if (current?.socket === socket) current.lastSeen = Date.now();
      send(socket, JSON.stringify({ __pong: message.__ping }));
      return;
    }

    if (message.__join) {
      const code = String(message.__join).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24);
      const role: Role | null = message.role === "host" || message.role === "guest" ? message.role : null;
      const clientId = String(message.clientId || "").slice(0, 64);
      if (!code || !role || !clientId) {
        send(socket, JSON.stringify({ __sys: "upgrade_required", relay: 3 }));
        return;
      }

      const previousMembership = membership.get(socket);
      if (previousMembership) leave(socket, false);

      let room = rooms.get(code);
      if (!room) { room = {}; rooms.set(code, room); }
      expireStale(room);

      const existing = slot(room, role);
      // Install the replacement first. Even if close dispatches synchronously,
      // the old socket can no longer clear the new slot or notify the peer.
      setSlot(room, role, { socket, clientId, lastSeen: Date.now() });
      membership.set(socket, { code, role });
      if (existing && existing.socket !== socket) {
        // A retry from the same tab or a refreshed invite replaces the stale role
        // immediately. Private room codes make this preferable to a dead lobby.
        send(existing.socket, JSON.stringify({ __sys: "replaced" }));
        try { existing.socket.close(4001, "replaced"); } catch { /* ignored */ }
      }

      const ready = roomReady(room);
      send(socket, JSON.stringify({ __sys: "joined", role, ready, n: ready ? 2 : 1, relay: 3 }));
      announceReady(room);
      return;
    }

    const member = membership.get(socket);
    const room = member ? rooms.get(member.code) : undefined;
    if (!member || !room) return;
    const current = slot(room, member.role);
    if (!current || current.socket !== socket) return;
    current.lastSeen = Date.now();
    const destination = slot(room, otherRole(member.role));
    if (!destination) return;
    const payload = String(event.data);
    send(destination.socket, payload, message.t === "snap" || message.t === "in");
  };

  socket.onclose = () => leave(socket, true);
  socket.onerror = () => leave(socket, true);
  return response;
});
