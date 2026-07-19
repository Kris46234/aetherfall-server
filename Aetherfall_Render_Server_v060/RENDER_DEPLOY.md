# Aetherfall Render Server — Free Deployment

This package replaces only the suspended Deno server. The existing Netlify
client remains unchanged and continues to use authoritative protocol 10.

## Create the service

1. Extract this ZIP.
2. Create an empty GitHub repository, for example `aetherfall-server`.
3. Upload the extracted files and folders to the repository root. `render.yaml`
   must be visible at the top level beside `package.json`.
4. Sign in to Render and choose **New > Blueprint**.
5. Connect the GitHub repository and apply the Blueprint.
6. Confirm these settings before creating it:
   - Service type: Web Service
   - Plan: Free
   - Region: Frankfurt
   - Build: `npm ci && npm run build:server`
   - Start: `npm run start:render`
7. Wait for **Live**, then open the generated `https://...onrender.com` URL.

A healthy deployment returns JSON containing:

```json
{"service":"Aetherfall authoritative co-op","protocol":10,"tickRate":30,"snapshotRate":20}
```

## Connect the existing game

1. Open the current Netlify game.
2. Open **Play Online — Co-op**.
3. Replace the suspended Deno address with the new Render HTTPS address.
4. Create the lobby and send the newly generated invite link.

Do not use an old invitation: it contains the suspended Deno server address.
The client automatically changes the Render HTTPS address to secure WebSocket
(`wss://`) when connecting.

## Free-service behaviour

Render's free service can sleep after it has been idle. Opening its HTTPS URL
first wakes it; the first wake can take about a minute. Once the health JSON is
visible, create the lobby. An active WebSocket match does not have a fixed
connection-duration limit, but free services can still restart for platform
maintenance.

The server sends WebSocket heartbeats and the client already resynchronizes and
reconnects after a stale stream. A server restart still ends an in-memory match,
so create a new lobby if both players are disconnected at once.
