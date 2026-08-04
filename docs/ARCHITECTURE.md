# Architecture Decision — Render authoritative co-op

## Decision

Use Netlify for the static client and one Frankfurt Render Web Service for
realtime match rooms. Keep Colyseus out of this migration so the project does not
change game architecture and hosting framework simultaneously.

## Authority boundary

The final server owns:

- match clock and deterministic seed
- arenas, positions, collision and line of sight
- resources, GCDs, cooldowns and casts
- damage, healing, shields, effects and crowd control
- bot decisions
- death and match result

The client owns:

- keyboard/mouse input collection
- local movement and cast presentation prediction
- rendering, UI, audio and VFX
- interpolation and reconciliation

The client may predict an outcome but may never commit damage, healing, CC or a
cooldown as authoritative.

## Persistence boundary

PostgreSQL will store accounts, progression, loadouts, rating and match history.
The database will not be queried on every simulation tick and will not contain
executable ability logic.

## Compatibility strategy

`reference/Aetherfall_Arena_v210_reference.html` remains the golden legacy
fixture. The protocol-15 client reuses its renderer but routes live co-op through
the tested headless engine. The archived v210 online client is retained only for
rollback.

## Free-service constraint

The Render service is pinned to Frankfurt and each room remains process-local.
Every connection reports its runtime instance and region. A free instance can
sleep after inactivity or restart, so the first connection can require a warmup
and a restart ends in-memory matches. A paid database is not required for combat.
