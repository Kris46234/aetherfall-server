// Node/Render transport adapter for the bundled Deno authoritative server.
// Gameplay and protocol logic remain in dist-server/main.js; this file only
// provides Deno-compatible environment, HTTP, and WebSocket primitives.
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 10000);
const host = '0.0.0.0';
let requestHandler = null;
let upgradingSocket = null;
let server = null;

process.env.DENO_REGION ||= process.env.RENDER_REGION || 'frankfurt';
globalThis.WebSocket = WebSocket;

function webRequest(request) {
  const hostname = request.headers.host || `localhost:${port}`;
  return new Request(`http://${hostname}${request.url || '/'}`, {
    method: request.method || 'GET',
    headers: request.headers
  });
}

async function sendResponse(response, outgoing) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  outgoing.end(body);
}

function start() {
  if (server || !requestHandler) return;

  const sockets = new Set();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server = createServer(async (request, response) => {
    try {
      await sendResponse(await requestHandler(webRequest(request)), response);
    } catch (error) {
      console.error('HTTP request failed', error);
      response.statusCode = 500;
      response.end('Internal server error');
    }
  });

  webSockets.on('connection', (socket) => {
    socket.isAlive = true;
    sockets.add(socket);
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, networkSocket, head) => {
    webSockets.handleUpgrade(request, networkSocket, head, (socket) => {
      try {
        upgradingSocket = socket;
        requestHandler(webRequest(request));
        if (upgradingSocket) throw new Error('WebSocket upgrade was not accepted');
        webSockets.emit('connection', socket, request);
      } catch (error) {
        upgradingSocket = null;
        console.error('WebSocket upgrade failed', error);
        socket.close(1011, 'upgrade failed');
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 20_000);
  heartbeat.unref();

  const shutdown = () => {
    clearInterval(heartbeat);
    for (const socket of sockets) socket.close(1012, 'server restarting');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  server.listen(port, host, () => {
    console.log(`Aetherfall authoritative co-op listening on ${host}:${port}`);
  });
}

globalThis.Deno = {
  env: {
    get(name) {
      return process.env[name];
    }
  },
  serve(handler) {
    requestHandler = handler;
    start();
  },
  upgradeWebSocket() {
    if (!upgradingSocket) throw new Error('No pending WebSocket upgrade');
    const socket = upgradingSocket;
    upgradingSocket = null;
    // The Deno response is ignored because Node's `ws` already completed the
    // HTTP upgrade. Status 101 cannot be constructed by Node's Response class.
    return { socket, response: new Response(null, { status: 200 }) };
  }
};

await import('../../dist-server/main.js');
