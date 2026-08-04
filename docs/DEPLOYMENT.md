# Protocol 20 deployment guide

## Topology

- Netlify serves the browser files.
- The Frankfurt Render Web Service owns rooms, bots and combat.
- Both players connect to the same Render process over secure WebSockets.

The server and client are a matched protocol-20 pair. Deploy the Render package
first, verify its health response, and immediately deploy the Netlify package.
Do not upload the Render ZIP to Netlify.

## 1. Verify locally

```bash
npm install
npm run check
npm test
npm run build
```

Expected outputs are `dist/` and `dist-server/main.js`.

## 2. Update GitHub and Render

1. Extract the v225 `RENDER_SERVER` package.
2. Open `Kris46234/aetherfall-server` on GitHub.
3. Upload the extracted **contents** to the repository root. At the root, GitHub
   must show `package.json`, `package-lock.json`, `render.yaml`, `apps/` and
   `packages/` directly.
4. Commit the upload to `main`.
5. Render should deploy the commit automatically. If it does not, open the
   service and choose **Manual Deploy > Deploy latest commit**.
6. Wait for the service to say **Live**.
7. Open its `https://...onrender.com` URL. It must return JSON containing:

```json
{"service":"Aetherfall authoritative co-op","protocol":20,"tickRate":30,"snapshotRate":20,"region":"frankfurt"}
```

Do not continue unless the health response says protocol 20.

## 3. Update Netlify

1. Extract the v225 `NETLIFY_CLIENT` package.
2. Confirm the extracted folder directly contains `index.html`, `src/`,
   `assets/`, `styles/` and `_headers`.
3. Open the existing Netlify site and go to **Deploys**.
4. Choose **Add new deploy > Deploy manually**.
5. Drag the extracted folder containing `index.html` into Netlify.
6. Wait for **Published**, then use `Ctrl+Shift+R` or an Incognito window.
7. The online panel must say **Protocol 20**.

## 4. Two-player smoke test

1. Both players hard-refresh the Netlify site and choose a class.
2. Player 1 enters the Render HTTPS URL and creates a new lobby.
3. Send the newly generated invite; do not reuse an old invitation.
4. Start and confirm the synchronized three-second countdown.
5. Confirm both HUDs show Frankfurt, roughly 20 updates/s and the same instance.
6. Test Volcanic Eruption after Skybreaker Pulse, Healing Surge, Avenging Wings,
   protected Soul Barrier cast bars, enemy casts, cooldowns and meters.
7. Refresh Player 2 once and confirm the reconnect token restores Player 2.

## Expected free-tier behaviour

After inactivity, Render can sleep. The first connection can take around a
minute while it wakes. A free-instance restart ends in-memory matches, so make a
new lobby if both clients lose the room. Neither condition permits a browser to
simulate combat locally; the server remains authoritative.

## Rollback

Render and Netlify must be rolled back together. A protocol-20 client cannot
join a different server protocol and vice versa. Render can redeploy an earlier commit,
and Netlify can publish an earlier deploy from its deployment history.
