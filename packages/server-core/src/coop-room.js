import { createSimulation } from '../../simulation/src/index.js';
import { getClass } from '../../content/src/catalogue.js';
import { BOT_TALENT_LOADOUTS, BotDirector } from './bot-director.js';

const HUMAN_SLOTS = Object.freeze(['player1', 'player2']);
const MATCH_COUNTDOWN_SECONDS = 3;

export class CoopRoom {
  constructor({
    code,
    seed = 1,
    now = () => Date.now(),
    tokenFactory = () => crypto.randomUUID(),
    reconnectGraceMs = 30_000,
    arena = { x: 24, z: 16, pillars: [] }
  }) {
    if (!code) throw new TypeError('Room code is required');
    this.code = code;
    this.seed = seed;
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.reconnectGraceMs = reconnectGraceMs;
    this.arena = arena;
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

  join({ clientId, classId, talents = {}, sessionToken = null }) {
    if (!clientId || !getClass(classId)) return { ok: false, reason: 'invalid_player' };
    if (sessionToken && this.sessions.has(sessionToken)) {
      const slot = this.sessions.get(sessionToken);
      const player = this.players.get(slot);
      if (!player) return { ok: false, reason: 'expired_session' };
      player.clientId = clientId;
      player.talents = { ...talents };
      player.connected = true;
      player.disconnectedAt = null;
      return this.#joinResult(player, true);
    }
    if (this.phase !== 'lobby') return { ok: false, reason: 'match_started' };
    const slot = HUMAN_SLOTS.find(candidate => !this.players.has(candidate));
    if (!slot) return { ok: false, reason: 'room_full' };
    if (sessionToken) return { ok: false, reason: 'expired_session' };
    const token = this.tokenFactory();
    const player = {
      slot,
      unitId: slot,
      clientId,
      classId,
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

  start(clientId) {
    if (this.phase !== 'lobby') return { ok: false, reason: 'already_started' };
    if (!this.host || this.host.clientId !== clientId) return { ok: false, reason: 'host_only' };
    if (!this.ready) return { ok: false, reason: 'waiting_for_player' };
    this.phase = 'countdown';
    this.countdownRemaining = MATCH_COUNTDOWN_SECONDS;
    const rosterEntry = (id, team, classId, x, z, talents = {}) => {
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
      return { id, team, classId, x, z, hp: maxHp, maxHp, resourceRegen, talents };
    };
    this.simulation = createSimulation({
      seed: this.seed,
      arena: this.arena,
      roster: [
        rosterEntry('player1', 'allies', this.players.get('player1').classId, -16, 4, this.players.get('player1').talents),
        rosterEntry('player2', 'allies', this.players.get('player2').classId, -17, -4, this.players.get('player2').talents),
        rosterEntry('bot1', 'enemies', 'warrior', 16, -4, BOT_TALENT_LOADOUTS.warrior),
        rosterEntry('bot2', 'enemies', 'pala', 17, 4, BOT_TALENT_LOADOUTS.pala)
      ]
    });
    this.botDirector = new BotDirector(this.simulation, ['bot1', 'bot2']);
    return {
      ok: true,
      phase: this.phase,
      countdownRemaining: this.countdownRemaining,
      seed: this.seed,
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
    this.botDirector.update(elapsed);
    const ticks = this.simulation.step(elapsed);
    const aliveAllies = [...this.simulation.state.units.values()].some(unit => unit.alive && unit.team === 'allies');
    const aliveEnemies = [...this.simulation.state.units.values()].some(unit => unit.alive && unit.team === 'enemies');
    if (!aliveAllies || !aliveEnemies) this.phase = 'ended';
    return ticks;
  }

  snapshotFor(clientId) {
    const player = [...this.players.values()].find(entry => entry.clientId === clientId);
    if (!player || !this.simulation) return null;
    return {
      roomCode: this.code,
      phase: this.phase,
      countdownRemaining: this.countdownRemaining,
      controlledUnitId: player.unitId,
      world: this.simulation.snapshot()
    };
  }

  #connectedPlayer(clientId) {
    return [...this.players.values()].find(entry => entry.clientId === clientId && entry.connected) || null;
  }
}
