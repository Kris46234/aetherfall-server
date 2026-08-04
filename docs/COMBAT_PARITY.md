# Authoritative Combat Coverage

Version 0.11.0 routes every catalogue ability through the fixed-step simulation.
The browser can predict presentation but cannot commit combat state.

| Class | Covered class-defining server rules |
| --- | --- |
| Flame | Cinders/Meteorfall, burn, Meteor Lance, Counterflare procs, Nova, Step, Hex, Ice Block, Living Bomb, Combustion |
| Shadow | marks/Venom Edge, Pounce/Evasion, poison/bleed, Ribbreaker/Eviscerate, Kick, Cloak, Vendetta, Shiv |
| Storm | Arc Spark, mana-free utility, Skybreaker/Volcanic Eruption, doubled Flame Shock, Healing Surge, Static Aegis, Wind Shear, Stormkeeper and totems |
| Wind | Flow/Tempest Flow, Tigereye, Cloudstep, Fists, Palm interrupt, Sweep, Windlord/Rising Sun, Touch of Death, Karma |
| Soul | Soul Scar, ramping Torment, stacked UA, amplified Siphon, Fear DR, Barrier ward, Undying Resolve |
| Lifesage | direct heals, HoTs, G'Hanir tick acceleration, Spirit Blossom tree, Renewal, Lullaby, Swiftness, Ironbark |
| Paladin | Holy Light/Shock, Infusion, Sacrifice, Avenging Wings, Bestow Faith, Protection, Hammer, Steed, Cleanse and talents |
| Discipline | Atonement, Shield, Smite/Solace conversion, three-bolt Penance, Radiance proc, Pain Suppression, Fade/Archangels |
| Warrior | Mortal Swing, Charge, Rend/Gushing, one-strike Pummel empowerment, Stormbolt, Reflection, Shout, Wall, Bladestorm, Avatar, Victory Rush |

Shared coverage includes resources, one-second or Soulweaver half-second GCDs,
cooldowns, completion validation, interrupts and school locks, immunity,
reflection, redirection, dispels, periodic ticks, shields, dampening, diminishing
returns, medallions, deaths and per-ability damage/healing meters.

Scenario tests intentionally assert actual values and timing rather than merely
checking that an ability message is accepted.

## Tactical bot parity

The authoritative Warrior and Paladin use server-owned talent loadouts and
passive talent modifiers. Their director includes target focus windows, health
drop and enemy burst evaluation, trinkets, dispels, cast cancellation avoidance,
healing line-of-sight recovery, pillar kiting, casted filler healing, emergency
cooldowns, interrupts, spell reflection, crowd-control peeling, executes and
offensive pressure while stable.

This is a server-safe port of the behaviours relevant to the current enemy pair,
not a copy of browser rendering or UI code. The original offline AI remains the
reference for adding other class pairings later.

## Presentation parity

All server events carry monotonically increasing identifiers. Normal actions,
casts and channels reuse the existing client effects. Delayed world mechanics
emit dedicated reliable cues; Meteorfall has separate telegraph and impact cues,
and Living Bomb and Bestow Faith have authoritative completion cues.
