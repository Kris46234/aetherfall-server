import { createSimulation } from '../../simulation/src/index.js';
import { getClass } from '../../content/src/catalogue.js';
import { BOT_TALENT_LOADOUTS, BotDirector } from './bot-director.js';

const HUMAN_SLOTS = Object.freeze(['player1', 'player2']);
const MATCH_COUNTDOWN_SECONDS = 3;
const ONLINE_ITEM_LEVEL = 990;
/* Bot feel, kept in step with the offline game so online bots do not read as a
   different, harsher opponent. These are the tiers the offline client uses in
   botDifficultyProfile():
     1600-1800  reaction .42-.70      2400-2700  reaction .16-.32
     1800-2000  reaction .32-.56      2700+      reaction .09-.22
     2000-2400  reaction .23-.43
   Online has no rating context yet, so it uses the entry tier, which is what a new
   player meets offline. decisionInterval is how often a bot re-evaluates; reactionMin/Max
   is the randomised pause after any cast before it may press anything again. */
const BOT_TUNING = Object.freeze({ decisionInterval: .22, reactionMin: .42, reactionMax: .70, interruptChance: .28 });
const HEALER_BOT_CLASSES = Object.freeze(['pala', 'disc', 'sage']);
const DAMAGE_BOT_CLASSES = Object.freeze(['warrior', 'flame', 'shadow', 'storm', 'wind', 'soul']);

function cleanFormat(value) {
  return value === '1v1' ? '1v1' : '2v2';
}

function classSpeed(classId) {
  if (['flame', 'storm', 'soul'].includes(classId)) return 5.9225;
  if (['sage', 'pala', 'disc'].includes(classId)) return 5.4075;
  return 5.15;
}

export class CoopRoom {
  constructor({
    code,
    seed = 1,
    now = () => Date.now(),
    tokenFactory = () => crypto.randomUUID(),
    reconnectGraceMs = 30_000,
    arena = { x: 24, z: 16, pillars: [] },
    format = '2v2'
  }) {
    if (!code) throw new TypeError('Room code is required');
    this.code = code;
    this.seed = seed;
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.reconnectGraceMs = reconnectGraceMs;
    this.arena = arena;
    this.format = cleanFormat(format);
    this.round = 0;
    this.phase = 'lobby';
    this.countdownRemaining = 0;
    this.players = new Map();
    this.sessions = new Map();
    this.simulation = null;
    this.botDirector = null;
  }

  get host() {
    return this.players.get('player1') || null;
  }

  get ready() {
    return HUMAN_SLOTS.every(slot => this.players.get(slot)?.connected);
  }

  join({ clientId, classId, talents = {}, displayName = '', format = this.format, sessionToken = null }) {
    if (!clientId || !getClass(classId)) return { ok: false, reason: 'invalid_player' };
    if (sessionToken && this.sessions.has(sessionToken)) {
      const slot = this.sessions.get(sessionToken);
      const player = this.players.get(slot);
      if (!player) return { ok: false, reason: 'expired_session' };
      player.clientId = clientId;
      player.talents = { ...talents };
      player.displayName = String(displayName || player.displayName || classId).slice(0, 24);
      player.connected = true;
      player.disconnectedAt = null;
      return this.#joinResult(player, true);
    }
    if (this.phase !== 'lobby') return { ok: false, reason: 'match_started' };
    if (!this.players.size) this.format = cleanFormat(format);
    const slot = HUMAN_SLOTS.find(candidate => !this.players.has(candidate));
    if (!slot) return { ok: false, reason: 'room_full' };
    if (sessionToken) return { ok: false, reason: 'expired_session' };
    const token = this.tokenFactory();
    const player = {
      slot,
      unitId: slot,
      clientId,
      classId,
      displayName: String(displayName || classId).slice(0, 24),
      itemLevel: ONLINE_ITEM_LEVEL,
      talents: { ...talents },
      sessionToken: token,
      connected: true,
      joinedAt: this.now(),
      disconnectedAt: null
    };
    this.players.set(slot, player);
    this.sessions.set(token, slot);
    return this.#joinResult(player, false);
  }

  #joinResult(player, reconnected) {
    return {
      ok: true,
      roomCode: this.code,
      slot: player.slot,
      unitId: player.unitId,
      host: player.slot === 'player1',
      sessionToken: player.sessionToken,
      ready: this.ready,
      phase: this.phase,
      format: this.format,
      reconnected
    };
  }

  disconnect(clientId) {
    const player = [...this.players.values()].find(entry => entry.clientId === clientId && entry.connected);
    if (!player) return false;
    player.connected = false;
    player.disconnectedAt = this.now();
    return true;
  }

  updateClass(clientId, classId, talents = {}) {
    if (this.phase !== 'lobby' || !getClass(classId)) return false;
    const player = this.#connectedPlayer(clientId);
    if (!player) return false;
    player.classId = classId;
    player.talents = { ...talents };
    return true;
  }

  updateFormat(clientId, format) {
    if (this.phase !== 'lobby' || !this.host || this.host.clientId !== clientId) return false;
    this.format = cleanFormat(format);
    return true;
  }

  resetToLobby() {
    this.phase = 'lobby';
    this.countdownRemaining = 0;
    this.simulation = null;
    this.botDirector = null;
  }

  returnToLobby(clientId) {
    const player = this.#connectedPlayer(clientId);
    if (!player || this.phase !== 'ended') return false;
    this.resetToLobby();
    return true;
  }

  expireDisconnected() {
    for (const [slot, player] of this.players) {
      if (player.connected || player.disconnectedAt === null) continue;
      if (this.now() - player.disconnectedAt < this.reconnectGraceMs) continue;
      if (this.phase === 'lobby') {
        this.players.delete(slot);
        this.sessions.delete(player.sessionToken);
      }
    }
  }

  start(clientId, format = null) {
    if (this.phase === 'ended') this.resetToLobby();
    if (this.phase !== 'lobby') return { ok: false, reason: 'already_started' };
    if (!this.host || this.host.clientId !== clientId) return { ok: false, reason: 'host_only' };
    if (!this.ready) return { ok: false, reason: 'waiting_for_player' };
    if (format) this.format = cleanFormat(format);
    this.phase = 'countdown';
    this.round += 1;
    this.countdownRemaining = MATCH_COUNTDOWN_SECONDS;
    const rosterEntry = (id, team, classId, x, z, talents = {}, displayName = classId) => {
      const healer = ['sage', 'pala', 'disc'].includes(classId);
      const staminaTalent = {
        flame: 'flame_ashen_vitality', warrior: 'war_plate_training', storm: 'storm_static_hide',
        soul: 'soul_dark_resilience', sage: 'sage_vital_growth', pala: 'pala_sacred_stamina',
        shadow: 'shadow_elusiveness', wind: 'wind_iron_body', disc: 'disc_focused_will'
      }[classId];
      const staminaRank = Math.max(0, Number(talents?.[staminaTalent] || 0));
      const maxHp = Math.round((healer ? 1513 : 1650) * (1 + staminaRank * .03));
      const resourceRegen = ['wind', 'shadow', 'warrior'].includes(classId)
        ? 16
        : healer ? 2.38 : classId === 'soul' ? 2.35 : classId === 'storm' ? 1.48 : 1.42;
      return {
        id, team, classId, displayName, itemLevel: ONLINE_ITEM_LEVEL,
        x, z, hp: maxHp, maxHp, speed: classSpeed(classId), resourceRegen, talents
      };
    };
    const first = this.players.get('player1');
    const second = this.players.get('player2');
    const pick = (list, salt) => {
      let h = (Math.imul(this.seed ^ salt, 2654435761) ^ Math.imul(this.round, 40503)) >>> 0;
      h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h = (h ^ (h >>> 13)) >>> 0;
      return list[h % list.length];
    };
    const healerClass = pick(HEALER_BOT_CLASSES, 0x9e37);
    const damageClass = pick(DAMAGE_BOT_CLASSES, 0x85eb);
    const botTalents = classId => BOT_TALENT_LOADOUTS[classId] || {};
    const roster = this.format === '1v1'
      ? [
        rosterEntry('player1', 'allies', first.classId, -20, 0, first.talents, first.displayName),
        rosterEntry('player2', 'enemies', second.classId, 20, 0, second.talents, second.displayName)
      ]
      : [
        rosterEntry('player1', 'allies', first.classId, -16, 4, first.talents, first.displayName),
        rosterEntry('player2', 'allies', second.classId, -17, -4, second.talents, second.displayName),
        rosterEntry('bot1', 'enemies', damageClass, 16, -4, botTalents(damageClass), `${getClass(damageClass)?.name || damageClass} Bot`),
        rosterEntry('bot2', 'enemies', healerClass, 17, 4, botTalents(healerClass), `${getClass(healerClass)?.name || healerClass} Bot`)
      ];
    this.simulation = createSimulation({
      seed: this.seed,
      arena: this.arena,
      roster
    });
    this.botDirector = this.format === '2v2' ? new BotDirector(this.simulation, ['bot1', 'bot2'], BOT_TUNING) : null;
    return {
      ok: true,
      phase: this.phase,
      countdownRemaining: this.countdownRemaining,
      seed: this.seed,
      format: this.format,
      snapshot: this.simulation.snapshot()
    };
  }

  input(clientId, message) {
    const player = this.#connectedPlayer(clientId);
    if (!player || this.phase !== 'running') return false;
    return this.simulation.applyInput(player.unitId, message);
  }

  action(clientId, message) {
    const player = this.#connectedPlayer(clientId);
    if (!player || this.phase !== 'running') return { ok: false, reason: 'not_running' };
    return this.simulation.applyAction(player.unitId, message);
  }

  trinket(clientId) {
    const player = this.#connectedPlayer(clientId);
    if (!player || this.phase !== 'running') return { ok: false, reason: 'not_running' };
    return this.simulation.useTrinket(player.unitId);
  }

  tick(elapsed) {
    if (this.phase === 'countdown') {
      this.countdownRemaining = Math.max(0, this.countdownRemaining - elapsed);
      if (this.countdownRemaining > 1e-9) return 0;
      this.countdownRemaining = 0;
      this.phase = 'running';
      return 0;
    }
    if (this.phase !== 'running') return 0;
    this.botDirector?.update(elapsed);
    const ticks = this.simulation.step(elapsed);
    const aliveAllies = [...this.simulation.state.units.values()].some(unit => unit.alive && !unit.summonKind && unit.team === 'allies');
    const aliveEnemies = [...this.simulation.state.units.values()].some(unit => unit.alive && !unit.summonKind && unit.team === 'enemies');
    if (!aliveAllies || !aliveEnemies) this.phase = 'ended';
    return ticks;
  }

  snapshotFor(clientId) {
    const player = [...this.players.values()].find(entry => entry.clientId === clientId);
    if (!player || !this.simulation) return null;
    return {
      roomCode: this.code,
      phase: this.phase,
      format: this.format,
      countdownRemaining: this.countdownRemaining,
      controlledUnitId: player.unitId,
      world: this.simulation.snapshot()
    };
  }

  get winnerTeam() {
    if (!this.simulation || this.phase !== 'ended') return null;
    const allies = [...this.simulation.state.units.values()].some(unit => unit.alive && !unit.summonKind && unit.team === 'allies');
    const enemies = [...this.simulation.state.units.values()].some(unit => unit.alive && !unit.summonKind && unit.team === 'enemies');
    return allies && !enemies ? 'allies' : enemies && !allies ? 'enemies' : null;
  }

  #connectedPlayer(clientId) {
    return [...this.players.values()].find(entry => entry.clientId === clientId && entry.connected) || null;
  }
}
