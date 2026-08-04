# Aetherfall Online

Version 0.16.0 / client v225 uses one server-owned protocol-20 co-op match with event-backed presentation,
talent-enabled tactical Warrior/Paladin enemies, explicit stream recovery,
synchronized countdown/audio, and smoothed remote motion.
Both players are equal predicted clients; neither player simulates real damage,
cooldowns, enemies, casts or bots.

## What is authoritative

- one deterministic arena, seed and 30 Hz match clock
- positions, collision, line of sight and movement modifiers
- resources, GCDs, cooldowns, casts and channels
- all nine classes and all 120 catalogue abilities
- damage, healing, shields, effects, crowd control and medallions
- talent-enabled Warrior/Paladin enemies with focus selection, burst response,
  interrupts, reflection, casted healing, dispels, pillar movement and executes
- two-player lobby, host-only start and reconnect-to-the-same-unit tokens
- Alter Time, deliberate Meteor, Whirling Dragon Punch, persistent Touch of Death,
  Volcanic Eruption follow-up bolts and the v225 Atonement-first Discipline AI

The client predicts only local movement, cast bars, GCDs and cooldown presentation.
Server snapshots reconcile prediction at 20 Hz. Gameplay no longer uses PeerJS,
WebRTC or a public TURN service.

## Project layout

- `apps/client` — Netlify browser client and preserved 3D renderer
- `apps/server/main.ts` — authoritative WebSocket adapter used by Render
- `dist` — generated Netlify upload
- `dist-server/main.js` — generated standalone server bundle
- `packages/simulation` — fixed-step combat engine
- `packages/server-core` — co-op rooms, bots and reconnect lifecycle
- `packages/content` — immutable server-readable ability catalogue
- `reference` — original v210 working file

## Verify and build

```bash
npm install
npm run check
npm test
npm run build
```

The full build produces both deployable directories. `npm test` covers combat,
bot rotations, two-client adapter/reconnect and five-minute zero-divergence checks.

## Deploy

Keep the client on Netlify; do not distribute downloaded HTML files to players.
Deploy the server to the Frankfurt Render service, then deploy `dist/` to
Netlify. See `docs/DEPLOYMENT.md` for the exact guarded order and smoke test.

## Data boundary

Combat rules remain versioned code. A future PostgreSQL layer may store
accounts, progression, loadouts and results, but is deliberately excluded from
the real-time simulation loop.
