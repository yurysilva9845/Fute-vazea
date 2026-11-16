import {
  BallState,
  MatchFormatMode,
  MatchPhase,
  MultiplayerMatchSnapshot,
  MultiplayerSlot,
  PlayerRuntimeState,
  WsInputCommand,
} from '../types/game';
import {
  computePassVelocity,
  computeShotVelocity,
  DEFAULT_PITCH,
  formatMatchTime,
  getActivePlayersForMode,
  getMudSpeedMultiplier,
  getTerrainHeightAt,
  INITIAL_AWAY_PLAYERS,
  INITIAL_HOME_PLAYERS,
  resolvePlayerBallInteraction,
  selectBestPassTarget,
  stepBallPhysics,
} from '../game/rules';
import { computeAIDecision } from '../game/ai';
import {
  buildInitialRoomSlots,
  convertSlotToBot,
  resolveActiveCharacterIdsForRoom,
} from '../services/botService';

export const SERVER_TICK_RATE = 30; // 30 ticks por segundo
export const SERVER_TICK_DT = 1 / SERVER_TICK_RATE;

export interface SessionConfig {
  roomCode: string;
  matchId: string;
  hostUid: string;
  mode: MatchFormatMode;
  homeTeamName: string;
  awayTeamName: string;
  halfDurationSeconds: number;
  aiDifficulty: 'raiz' | 'equilibrado' | 'lenda';
  slots: Record<string, MultiplayerSlot>;
  activeCharacterIds?: string[];
}

export class AuthoritativeMatchSession {
  public readonly roomCode: string;
  public matchId: string;
  public hostUid: string;
  public mode: MatchFormatMode;
  public homeTeamName: string;
  public awayTeamName: string;
  public halfDurationSeconds: number;
  public aiDifficulty: 'raiz' | 'equilibrado' | 'lenda';
  public slots: Record<string, MultiplayerSlot>;
  public activeCharacterIds: string[];

  public tickCount = 0;
  public phase: MatchPhase = 'open_play';
  public phaseTimer = 0;
  public currentHalf: 1 | 2 = 1;
  public remainingHalfSeconds: number;
  public homeGoals = 0;
  public awayGoals = 0;
  public celebratingPlayerId: string | null = null;
  public bannerMessage: string | null = null;
  public bannerSubtext: string | null = null;

  public ball: BallState;
  public players: PlayerRuntimeState[] = [];

  public readyUids = new Set<string>();
  public connectedUids = new Set<string>();
  public lastProcessedSeqByUid: Record<string, number> = {};
  public latestCommandByUid: Record<string, WsInputCommand> = {};
  public lastActionSeqByUid: Record<string, number> = {};
  public lastActivityMs: number = Date.now();

  constructor(config: SessionConfig) {
    this.roomCode = config.roomCode.toUpperCase();
    this.matchId = config.matchId || `MTC-${this.roomCode}`;
    this.hostUid = config.hostUid;
    this.mode = config.mode || '4v4';
    this.homeTeamName = config.homeTeamName || 'Sem Terra FC';
    this.awayTeamName = config.awayTeamName || 'Rubro-Negro do Beco';
    this.halfDurationSeconds = config.halfDurationSeconds || 300;
    this.remainingHalfSeconds = this.halfDurationSeconds;
    this.aiDifficulty = config.aiDifficulty || 'equilibrado';

    this.slots =
      config.slots && Object.keys(config.slots).length > 0
        ? { ...config.slots }
        : buildInitialRoomSlots(config.hostUid, 'Host', 'home_1');

    this.activeCharacterIds = resolveActiveCharacterIdsForRoom(
      this.slots,
      this.mode,
      config.activeCharacterIds
    );

    this.ball = {
      x: 0,
      y: getTerrainHeightAt(0, 0) + 0.22,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      radius: 0.22,
      spinX: 0,
      spinZ: 0,
      ownerId: null,
      lastTouchTeam: null,
      lastTouchPlayerName: null,
      lastTouchPlayerId: null,
      inPuddle: false,
    };

    this.initializePlayers();
  }

  public initializePlayers(): void {
    const active = getActivePlayersForMode(
      INITIAL_HOME_PLAYERS,
      INITIAL_AWAY_PLAYERS,
      this.mode,
      this.activeCharacterIds
    );

    const homeFormations =
      this.mode === '2v2'
        ? [
            { x: -3.5, z: -2.0 },
            { x: -8.5, z: 1.5 },
          ]
        : [
            { x: -3.2, z: 0.0 },
            { x: -6.5, z: -4.6 },
            { x: -9.8, z: 2.2 },
            { x: -15.6, z: 0.0 },
          ];

    const awayFormations =
      this.mode === '2v2'
        ? [
            { x: 3.5, z: 2.0 },
            { x: 8.5, z: -1.5 },
          ]
        : [
            { x: 3.2, z: 0.5 },
            { x: 6.5, z: 4.6 },
            { x: 9.8, z: -2.2 },
            { x: 15.6, z: 0.0 },
          ];

    this.players = [];

    active.home.forEach((cfg, idx) => {
      const pos = homeFormations[idx] || { x: -5, z: 0 };
      const slot = this.slots[cfg.id];
      this.players.push({
        id: cfg.id,
        team: 'home',
        config: cfg,
        x: pos.x,
        y: getTerrainHeightAt(pos.x, pos.z),
        z: pos.z,
        vx: 0,
        vz: 0,
        facingAngle: Math.PI / 2,
        animState: 'idle',
        animTimer: 0,
        stridePhase: 0,
        stamina: 100,
        isSprinting: false,
        tackleCooldown: 0,
        stunTimer: 0,
        homeX: pos.x,
        homeZ: pos.z,
        hasBall: false,
        inMud: false,
        inPuddle: false,
        controlledByUid: slot && !slot.isBot ? slot.uid : null,
      });
    });

    active.away.forEach((cfg, idx) => {
      const pos = awayFormations[idx] || { x: 5, z: 0 };
      const slot = this.slots[cfg.id];
      this.players.push({
        id: cfg.id,
        team: 'away',
        config: cfg,
        x: pos.x,
        y: getTerrainHeightAt(pos.x, pos.z),
        z: pos.z,
        vx: 0,
        vz: 0,
        facingAngle: -Math.PI / 2,
        animState: 'idle',
        animTimer: 0,
        stridePhase: 0,
        stamina: 100,
        isSprinting: false,
        tackleCooldown: 0,
        stunTimer: 0,
        homeX: pos.x,
        homeZ: pos.z,
        hasBall: false,
        inMud: false,
        inPuddle: false,
        controlledByUid: slot && !slot.isBot ? slot.uid : null,
      });
    });
  }

  public syncSlots(slots: Record<string, MultiplayerSlot>): void {
    this.slots = { ...slots };
    this.activeCharacterIds = resolveActiveCharacterIdsForRoom(
      this.slots,
      this.mode,
      this.activeCharacterIds
    );
    for (const p of this.players) {
      const slot = this.slots[p.id];
      p.controlledByUid = slot && !slot.isBot ? slot.uid : null;
    }
  }

  public resetPositionsToKickoff(): void {
    this.ball.x = 0;
    this.ball.z = 0;
    this.ball.y = getTerrainHeightAt(0, 0) + this.ball.radius;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.vz = 0;
    this.ball.ownerId = null;

    for (const p of this.players) {
      p.x = p.homeX;
      p.z = p.homeZ;
      p.y = getTerrainHeightAt(p.x, p.z);
      p.vx = 0;
      p.vz = 0;
      p.facingAngle = p.team === 'home' ? Math.PI / 2 : -Math.PI / 2;
      p.animState = 'idle';
      p.animTimer = 0;
      p.hasBall = false;
      p.stunTimer = 0;
    }
  }

  /**
   * Valida e registra comando de entrada de um jogador humano conectado.
   * Impede que um jogador controle o personagem de outro ou envie números sequenciais antigos.
   */
  public submitCommand(cmd: WsInputCommand): { accepted: boolean; reason?: string } {
    if (!cmd || !cmd.uid || !cmd.slotId) {
      return { accepted: false, reason: 'Comando inválido.' };
    }

    const slot = this.slots[cmd.slotId];
    if (!slot) {
      return { accepted: false, reason: 'Personagem inexistente na partida.' };
    }

    // Validação rigorosa de permissão: o UID deve ser o dono legítimo daquela vaga
    if (slot.isBot || slot.uid !== cmd.uid) {
      return {
        accepted: false,
        reason: 'Permissão negada: você não pode controlar o personagem de outro jogador.',
      };
    }

    const lastSeq = this.lastProcessedSeqByUid[cmd.uid] || 0;
    if (cmd.seq < lastSeq) {
      return { accepted: false, reason: 'Pacote fora de ordem (sequência antiga).' };
    }

    this.lastProcessedSeqByUid[cmd.uid] = cmd.seq;
    this.latestCommandByUid[cmd.uid] = {
      ...cmd,
      moveX: Math.max(-1, Math.min(1, Number(cmd.moveX) || 0)),
      moveZ: Math.max(-1, Math.min(1, Number(cmd.moveZ) || 0)),
      kickPower: Math.max(0.25, Math.min(1.0, Number(cmd.kickPower) || 0.65)),
    };
    this.lastActivityMs = Date.now();
    return { accepted: true };
  }

  /**
   * Quando um jogador desconecta definitivamente, converte sua vaga para Bot automático
   * sem interromper a partida.
   */
  public handlePlayerDisconnect(uid: string, permanent = true): MultiplayerSlot | null {
    this.connectedUids.delete(uid);
    delete this.latestCommandByUid[uid];

    if (!permanent) return null;

    for (const key of Object.keys(this.slots)) {
      if (this.slots[key].uid === uid) {
        const botSlot = convertSlotToBot(this.slots[key]);
        this.slots[key] = botSlot;
        const player = this.players.find((p) => p.id === key);
        if (player) {
          player.controlledByUid = null;
        }
        return botSlot;
      }
    }
    return null;
  }

  public handlePlayerReconnect(
    uid: string,
    displayName: string,
    preferredSlotId?: string
  ): MultiplayerSlot | null {
    this.connectedUids.add(uid);
    this.lastActivityMs = Date.now();

    // Verifica se o jogador já possui vaga
    for (const key of Object.keys(this.slots)) {
      if (this.slots[key].uid === uid) {
        this.slots[key].isBot = false;
        this.slots[key].lastSeenMs = Date.now();
        const player = this.players.find((p) => p.id === key);
        if (player) player.controlledByUid = uid;
        return this.slots[key];
      }
    }

    // Caso tenha sido convertido temporariamente em bot, recupera a vaga preferida se ainda for bot
    if (preferredSlotId && this.slots[preferredSlotId]?.isBot) {
      this.slots[preferredSlotId] = {
        ...this.slots[preferredSlotId],
        uid,
        displayName: displayName || 'Jogador',
        isBot: false,
        isReady: true,
        lastSeenMs: Date.now(),
      };
      const player = this.players.find((p) => p.id === preferredSlotId);
      if (player) player.controlledByUid = uid;
      return this.slots[preferredSlotId];
    }

    return null;
  }

  private executePlayerStrike(
    player: PlayerRuntimeState,
    type: 'pass' | 'long_pass' | 'shoot' | 'header',
    power: number,
    moveX: number,
    moveZ: number
  ): void {
    const dist = Math.hypot(this.ball.x - player.x, this.ball.z - player.z);
    const maxStrikeDist = type === 'shoot' ? 1.65 : 1.55;
    if (dist > maxStrikeDist) return;

    this.ball.ownerId = null;
    for (const p of this.players) {
      p.hasBall = false;
    }
    this.ball.lastTouchTeam = player.team;
    this.ball.lastTouchPlayerName = player.config.name;
    this.ball.lastTouchPlayerId = player.id;

    if (type === 'pass' || type === 'long_pass') {
      const targetMate = selectBestPassTarget(player, this.players, moveX, moveZ);
      const passVel = computePassVelocity(
        player,
        this.ball,
        targetMate,
        moveX,
        moveZ,
        type === 'long_pass'
      );
      this.ball.vx = passVel.vx;
      this.ball.vy = passVel.vy;
      this.ball.vz = passVel.vz;
      player.facingAngle = Math.atan2(passVel.vx, passVel.vz);
      player.animState = 'pass';
      player.animTimer = 0;
    } else if (type === 'shoot' || type === 'header') {
      const shotVel = computeShotVelocity(
        player,
        this.ball,
        power,
        moveX,
        moveZ,
        DEFAULT_PITCH
      );
      this.ball.vx = shotVel.vx;
      this.ball.vy = type === 'header' ? Math.min(1.6, shotVel.vy) : shotVel.vy;
      this.ball.vz = shotVel.vz;
      player.facingAngle = Math.atan2(shotVel.vx, shotVel.vz);
      player.animState = type === 'header' ? 'header' : 'kick';
      player.animTimer = 0;
    }
  }

  /**
   * Avança 1 tick autoritativo (dt = 1/30s = 33.33ms).
   */
  public stepTick(dt = SERVER_TICK_DT): MultiplayerMatchSnapshot {
    this.tickCount++;
    this.lastActivityMs = Date.now();

    // 1. Cronômetro e fases da partida
    if (this.phase === 'open_play') {
      this.remainingHalfSeconds = Math.max(0, this.remainingHalfSeconds - dt);
      if (this.remainingHalfSeconds <= 0) {
        if (this.currentHalf === 1) {
          this.phase = 'halftime';
          this.phaseTimer = 2.5;
          this.bannerMessage = 'FIM DO 1º TEMPO';
          this.bannerSubtext = 'Virando de lado no campinho...';
        } else {
          this.phase = 'fulltime';
          this.bannerMessage = 'FIM DE JOGO';
          this.bannerSubtext = `${this.homeTeamName} ${this.homeGoals} x ${this.awayGoals} ${this.awayTeamName}`;
        }
      }
    } else if (this.phase === 'goal_celebration') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.phase = 'open_play';
        this.bannerMessage = null;
        this.bannerSubtext = null;
        this.celebratingPlayerId = null;
        this.resetPositionsToKickoff();
      }
    } else if (this.phase === 'throw_in') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.phase = 'open_play';
        this.bannerMessage = null;
        this.bannerSubtext = null;
      }
    } else if (this.phase === 'halftime') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.currentHalf = 2;
        this.remainingHalfSeconds = this.halfDurationSeconds;
        this.phase = 'open_play';
        this.bannerMessage = null;
        this.bannerSubtext = null;
        this.resetPositionsToKickoff();
      }
    }

    // 2. Movimentação e ações de cada jogador (Humanos Validados + Bots IA)
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const slot = this.slots[p.id];
      const isHumanControlled = Boolean(slot && !slot.isBot && slot.uid);
      const cmd = isHumanControlled && slot.uid ? this.latestCommandByUid[slot.uid] : undefined;

      if (p.tackleCooldown > 0) {
        p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);
      }
      if (p.stunTimer > 0) {
        p.stunTimer = Math.max(0, p.stunTimer - dt);
        p.animState = 'fall';
        p.animTimer += dt;
        p.vx *= 0.84;
        p.vz *= 0.84;
      }

      const mudInfo = getMudSpeedMultiplier(p.x, p.z);
      p.inMud = mudInfo.inMud;
      p.inPuddle = mudInfo.inPuddle;

      if (this.phase === 'goal_celebration') {
        p.animTimer += dt;
        p.vx = 0;
        p.vz = 0;
        p.animState = p.id === this.celebratingPlayerId ? 'celebrate' : 'idle';
        continue;
      }

      if (this.phase !== 'open_play' || p.stunTimer > 0) {
        continue;
      }

      let moveX = 0;
      let moveZ = 0;
      let wantSprint = false;

      if (isHumanControlled && cmd && slot?.uid) {
        moveX = cmd.moveX;
        moveZ = cmd.moveZ;
        wantSprint = Boolean(cmd.sprint) && p.stamina > 8;

        const lastActionSeq = this.lastActionSeqByUid[slot.uid] || 0;
        if (cmd.action !== 'none' && cmd.seq > lastActionSeq) {
          this.lastActionSeqByUid[slot.uid] = cmd.seq;

          if (cmd.action === 'tackle' && p.tackleCooldown <= 0) {
            p.tackleCooldown = 1.15;
            p.animState = 'tackle';
            p.animTimer = 0;
            const lungeSpeed = 9.4 * p.config.tackleStat;
            p.vx = Math.sin(p.facingAngle) * lungeSpeed;
            p.vz = Math.cos(p.facingAngle) * lungeSpeed;
          } else if (cmd.action === 'pass' || cmd.action === 'long_pass') {
            this.executePlayerStrike(p, cmd.action, 0.68, moveX, moveZ);
          } else if (cmd.action === 'shoot' || cmd.action === 'header') {
            this.executePlayerStrike(p, cmd.action, cmd.kickPower || 0.75, moveX, moveZ);
          }
        }
      } else {
        const ai = computeAIDecision(
          p,
          this.ball,
          this.players,
          this.aiDifficulty,
          DEFAULT_PITCH
        );
        moveX = ai.moveX;
        moveZ = ai.moveZ;
        wantSprint = ai.sprint;

        if (ai.action === 'tackle' && p.tackleCooldown <= 0) {
          p.tackleCooldown = 1.35;
          p.animState = 'tackle';
          p.animTimer = 0;
          p.vx = Math.sin(p.facingAngle) * 8.4;
          p.vz = Math.cos(p.facingAngle) * 8.4;
        } else if (ai.action === 'pass' || ai.action === 'clear') {
          this.executePlayerStrike(
            p,
            ai.action === 'clear' ? 'long_pass' : 'pass',
            ai.kickPower || 0.65,
            moveX,
            moveZ
          );
        } else if (ai.action === 'shoot') {
          this.executePlayerStrike(p, 'shoot', ai.kickPower || 0.76, moveX, moveZ);
        }
      }

      if (
        p.animState === 'tackle' ||
        p.animState === 'kick' ||
        p.animState === 'pass' ||
        p.animState === 'header'
      ) {
        p.animTimer += dt;
        const maxDur = p.animState === 'tackle' ? 0.44 : 0.3;
        if (p.animState === 'tackle') {
          p.vx *= Math.exp(-3.4 * dt);
          p.vz *= Math.exp(-3.4 * dt);
        }
        if (p.animTimer >= maxDur) {
          p.animState = 'idle';
          p.animTimer = 0;
        }
      }

      if (p.animState !== 'tackle') {
        const inputMag = Math.hypot(moveX, moveZ);
        p.isSprinting = wantSprint && inputMag > 0.08;
        if (p.isSprinting) {
          p.stamina = Math.max(0, p.stamina - 13 * dt);
        } else {
          p.stamina = Math.min(100, p.stamina + 12 * dt);
        }

        const baseSpeed = 5.65 * p.config.speedStat * mudInfo.multiplier;
        const topSpeed = p.isSprinting ? baseSpeed * 1.34 : baseSpeed;

        const targetVX = moveX * topSpeed;
        const targetVZ = moveZ * topSpeed;

        // Aceleração e mudança de direção responsivas (sem sensação de veículo pesado)
        const isStopping = inputMag < 0.05;
        const dotReverse = p.vx * targetVX + p.vz * targetVZ;
        const accelRate = isStopping ? 18 : dotReverse < 0 ? 20 : 15;
        const blend = 1 - Math.exp(-accelRate * dt);

        p.vx += (targetVX - p.vx) * blend;
        p.vz += (targetVZ - p.vz) * blend;

        const speed = Math.hypot(p.vx, p.vz);
        if (speed > 0.2) {
          const targetAngle = Math.atan2(p.vx, p.vz);
          let diff = targetAngle - p.facingAngle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          p.facingAngle += diff * Math.min(1, 16 * dt);
          p.stridePhase += speed * dt * 2.35;

          if (
            p.animState !== 'kick' &&
            p.animState !== 'pass' &&
            p.animState !== 'header'
          ) {
            p.animState = p.isSprinting ? 'run' : 'walk';
          }
        } else {
          p.vx = 0;
          p.vz = 0;
          if (
            p.animState !== 'kick' &&
            p.animState !== 'pass' &&
            p.animState !== 'header'
          ) {
            p.animState = 'idle';
          }
        }
      }

      p.x = Math.max(
        -DEFAULT_PITCH.width / 2 - 1.8,
        Math.min(DEFAULT_PITCH.width / 2 + 1.8, p.x + p.vx * dt)
      );
      p.z = Math.max(
        -DEFAULT_PITCH.depth / 2 - 1.8,
        Math.min(DEFAULT_PITCH.depth / 2 + 1.8, p.z + p.vz * dt)
      );
      p.y = getTerrainHeightAt(p.x, p.z);

      if (p.animState !== 'kick' && p.animState !== 'pass') {
        resolvePlayerBallInteraction(p, this.ball, this.players, 0.92);
      }
    }

    // 3. Colisões entre jogadores e desarmes de carrinho
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const minSep = 0.66;

        if (dist > 0.001 && dist < minSep) {
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (minSep - dist) * 0.5;
          a.x -= nx * overlap;
          a.z -= nz * overlap;
          b.x += nx * overlap;
          b.z += nz * overlap;

          if (a.animState === 'tackle' && b.team !== a.team && b.stunTimer <= 0) {
            b.stunTimer = 0.68; // Recuperação ágil após colisão
            b.hasBall = false;
            if (this.ball.ownerId === b.id) {
              this.ball.ownerId = a.id;
              this.ball.vx = Math.sin(a.facingAngle) * 4.2;
              this.ball.vz = Math.cos(a.facingAngle) * 4.2;
            }
          } else if (b.animState === 'tackle' && a.team !== b.team && a.stunTimer <= 0) {
            a.stunTimer = 0.68;
            a.hasBall = false;
            if (this.ball.ownerId === a.id) {
              this.ball.ownerId = b.id;
              this.ball.vx = Math.sin(b.facingAngle) * 4.2;
              this.ball.vz = Math.cos(b.facingAngle) * 4.2;
            }
          }
        }
      }
    }

    // 4. Física autoritativa da bola, detecção de gol e reposições
    if (this.phase === 'open_play') {
      const ballEvents = stepBallPhysics(this.ball, dt, DEFAULT_PITCH);

      if (ballEvents.goalScored) {
        const scoringTeam = ballEvents.goalScored;
        if (scoringTeam === 'home') {
          this.homeGoals++;
        } else {
          this.awayGoals++;
        }

        const scorerName =
          this.ball.lastTouchPlayerName ||
          (scoringTeam === 'home' ? 'Yuri' : 'Primo');
        const scorer =
          this.players.find((p) => p.config.name === scorerName) ||
          this.players.find((p) => p.team === scoringTeam) ||
          this.players[0];

        this.celebratingPlayerId = scorer?.id || null;
        this.phase = 'goal_celebration';
        this.phaseTimer = 2.6;
        const teamLabel =
          scoringTeam === 'home'
            ? this.homeTeamName.toUpperCase()
            : this.awayTeamName.toUpperCase();
        this.bannerMessage = `GOL DO ${teamLabel}!`;
        this.bannerSubtext = `${scorerName} (${formatMatchTime(
          this.halfDurationSeconds - this.remainingHalfSeconds
        )})`;
      } else if (ballEvents.outOfBounds) {
        const out = ballEvents.outOfBounds;
        this.phase = 'throw_in';
        this.phaseTimer = 0.9;
        this.ball.x = out.restartX;
        this.ball.z = out.restartZ;
        this.ball.y = getTerrainHeightAt(out.restartX, out.restartZ) + this.ball.radius;
        this.ball.vx = 0;
        this.ball.vy = 0;
        this.ball.vz = 0;
        this.ball.ownerId = null;

        this.bannerMessage =
          out.type === 'throw_in'
            ? 'LATERAL'
            : out.type === 'corner'
            ? 'ESCANTEIO'
            : 'TIRO DE META';
        this.bannerSubtext =
          out.awardedTeam === 'home'
            ? `Posse: ${this.homeTeamName}`
            : `Posse: ${this.awayTeamName}`;
      }
    }

    return this.getSnapshot();
  }

  public getSnapshot(): MultiplayerMatchSnapshot {
    const playersMap: MultiplayerMatchSnapshot['players'] = {};
    for (const p of this.players) {
      const slot = this.slots[p.id];
      playersMap[p.id] = {
        x: Number(p.x.toFixed(3)),
        z: Number(p.z.toFixed(3)),
        vx: Number(p.vx.toFixed(2)),
        vz: Number(p.vz.toFixed(2)),
        facingAngle: Number(p.facingAngle.toFixed(3)),
        animState: p.animState,
        stamina: Math.round(p.stamina),
        controlledByUid: slot && !slot.isBot ? slot.uid : null,
        isBot: slot ? slot.isBot : true,
      };
    }

    return {
      tick: this.tickCount,
      lastProcessedSeqByUid: { ...this.lastProcessedSeqByUid },
      ball: {
        x: Number(this.ball.x.toFixed(3)),
        y: Number(this.ball.y.toFixed(3)),
        z: Number(this.ball.z.toFixed(3)),
        vx: Number(this.ball.vx.toFixed(2)),
        vy: Number(this.ball.vy.toFixed(2)),
        vz: Number(this.ball.vz.toFixed(2)),
        ownerId: this.ball.ownerId,
      },
      players: playersMap,
      homeGoals: this.homeGoals,
      awayGoals: this.awayGoals,
      half: this.currentHalf,
      remainingSeconds: Math.ceil(this.remainingHalfSeconds),
      phase: this.phase,
      celebratingPlayerId: this.celebratingPlayerId,
      bannerMessage: this.bannerMessage,
      bannerSubtext: this.bannerSubtext,
      timestamp: Date.now(),
    };
  }
}

export class AuthoritativeMatchRegistry {
  private sessions = new Map<string, AuthoritativeMatchSession>();

  public getOrCreateSession(config: SessionConfig): AuthoritativeMatchSession {
    const code = config.roomCode.toUpperCase();
    let session = this.sessions.get(code);
    if (!session) {
      session = new AuthoritativeMatchSession(config);
      this.sessions.set(code, session);
    } else {
      if (config.slots && Object.keys(config.slots).length > 0) {
        session.syncSlots(config.slots);
      }
      if (config.matchId) {
        session.matchId = config.matchId;
      }
    }
    return session;
  }

  public getSession(roomCode: string): AuthoritativeMatchSession | undefined {
    return this.sessions.get(roomCode.toUpperCase());
  }

  public removeSession(roomCode: string): void {
    this.sessions.delete(roomCode.toUpperCase());
  }

  public getAllSessions(): AuthoritativeMatchSession[] {
    return Array.from(this.sessions.values());
  }
}

export const globalMatchRegistry = new AuthoritativeMatchRegistry();
