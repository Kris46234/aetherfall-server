# Aetherfall Render Server — Free Deployment

This package updates the authoritative Render server to protocol 11. The
matching protocol-11 Netlify package must be deployed immediately afterward.

## Update the existing service

1. Extract this ZIP.
2. Open `Kris46234/aetherfall-server` on GitHub.
3. Upload the extracted contents to the repository root. `render.yaml`
   must be visible at the top level beside `package.json`.
4. Commit to `main`; the existing Blueprint should sync automatically.
5. If it does not, use **Manual Deploy > Deploy latest commit** in Render.
6. Confirm these service settings:
   - Service type: Web Service
   - Plan: Free
   - Region: Frankfurt
   - Build: `npm ci && npm run build:server`
   - Start: `npm run start:render`
7. Wait for **Live**, then open the generated `https://...onrender.com` URL.

A healthy deployment returns JSON containing:

```json
{"service":"Aetherfall authoritative co-op","protocol":11,"tickRate":30,"snapshotRate":20}
```

## Connect the existing game

1. Deploy the matching `Aetherfall_Online_v070_Netlify.zip` package to Netlify.
2. Open the Netlify game and hard-refresh it.
3. Open **Play Online — Co-op**.
4. Enter the Render HTTPS address.
5. Create the lobby and send a newly generated invite link.

Do not use an old invitation: it might contain the suspended Deno address or an
older client protocol.
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
