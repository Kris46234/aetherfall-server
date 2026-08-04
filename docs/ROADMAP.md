# Guided Roadmap

## 0.1 — Modular shell: complete

The 7.2 MB monolith was split into client assets while the original v210 file
was preserved as a reference and integrity fixture.

## 0.2 — Content extraction: complete

All nine classes, 69 base abilities and 51 talent abilities have stable IDs and
immutable server-readable data.

## 0.3 — Headless simulation: complete

The server owns a deterministic 30 Hz clock, arenas, movement, collision, line
of sight, resources, GCDs, cooldowns, casts, effects, combat, meters and bots.

## 0.4 — Authoritative co-op: implementation complete

- strict two-human co-op rooms
- host-only start; both humans are allies against two bots
- equal predicted clients with 20 Hz reconciliation
- immediate action acknowledgement and server rejection reasons
- session-token reconnect to the same unit
- shared arena/seed/state and server-owned details meters
- no PeerJS, WebRTC, public TURN or browser-host authority
- standalone Render bundle and Netlify client build
- two-socket adapter test and five-minute deterministic soak test

## 0.7 — Tactical AI and presentation parity: implementation complete

- explicit server-owned Warrior and Paladin talent builds
- passive stamina, throughput, cast-time, cooldown and damage talent modifiers
- casted Paladin healing, emergency saves, dispels and offensive weaving
- Warrior focus, execute, interrupt, reflection, defensive and AoE decisions
- line-of-sight recovery, pillar kiting and deterministic stuck recovery
- ordered event identifiers and delayed-spell presentation cues
- protocol 11 with matching Render and Netlify packages
- deterministic bot scenarios and five-minute zero-divergence soak coverage

## 0.8 — v217 combat and progression: implementation complete

- protocol 12 with Stormbolt and Touch of Death
- separate Lifesage HoTs, revised Pummel, Chain Spark and utility rules
- per-class Aether Cup rewards with migrated progress
- bounded 3v3 presentation effects and complete v216 audio/icon integration
- 75 deterministic combat, bot, adapter, reconnect and soak checks

## 0.9 — v218 Soul, Meteor and Dragon Punch: implementation complete

- protocol 13 with deliberate Meteor and Whirling Dragon Punch
- Touch of Death 20% detonation with persistent target mark
- DoT-focused Soulweaver tuning and stronger Essence Siphon healing
- Shadow Mend Atonement, four-second Charge snare and brighter proc glows
- artwork-backed passive talent icons and updated bot decision rules

## 0.10 — v219 Tempest, survivors and progression: implementation complete

- protocol 14 with Volcanic Eruption, Healing Surge and Avenging Wings
- survivor-duel healer AI that keeps fighting after tournament cross-kills
- Stormwarden mana-free utility, doubled Flame Shock and Static Aegis mitigation
- Soulweaver DoT and Pandemic proc tuning plus protected Soul Barrier cast bars
- exact two-stat armoury builds, visible stat formulas and 2.5x Valor rewards
- corrected class portraits, mount colour layout and expanded deterministic coverage

## 0.11 — v220 Stone Avatar and tactical pressure: implementation complete

- protocol 15 with 12-second independent Lifesage HoTs and exact UA stack scaling
- larger stone-form Avatar, Volcanic Eruption lava presentation and clearer readiness
- hostile casts lose stealthed targets while started Penance/Siphon channels persist
- retreating DPS maintain counter-pressure and Stormwarden respects kill windows
- target-of-target option, full-page change log and structured class guides
- 85 deterministic combat, AI, adapter, reconnect and soak checks

## Next — Production hardening

- record real RTT, snapshot age and Render region during friend tests
- add structured error/room metrics if usage grows
- add other enemy class pairings by moving more offline class tactics into the
  server-safe director
- tune prediction thresholds from real match traces

## Later — Persistence

- EU PostgreSQL for accounts, loadouts, progression and match history
- schema migrations, backups and server-side authentication
- no database query in the 30 Hz combat loop
