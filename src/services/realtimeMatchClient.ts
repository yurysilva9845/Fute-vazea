import {
  MatchFormatMode,
  MultiplayerMatchSnapshot,
  MultiplayerSlot,
  WsInputCommand,
} from '../types/game';

export interface RealtimeMatchClientCallbacks {
  onSnapshot?: (snapshot: MultiplayerMatchSnapshot) => void;
  onPlayerReadyUpdate?: (readyByUid: Record<string, boolean>, allReady: boolean) => void;
  onStatusChange?: (status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting') => void;
  onPingUpdate?: (pingMs: number) => void;
  onPlayerLeft?: (uid: string, replacedByBot: boolean) => void;
}

interface PendingCommand extends WsInputCommand {
  dt: number;
}

interface TimestampedSnapshot {
  receivedAt: number;
  snapshot: MultiplayerMatchSnapshot;
}

export class RealtimeMatchClient {
  private ws: WebSocket | null = null;
  private roomCode: string | null = null;
  private matchId: string | null = null;
  private uid: string | null = null;
  private displayName = 'Jogador';
  private slotId: string | null = null;
  private mode: MatchFormatMode = '4v4';
  private slots: Record<string, MultiplayerSlot> = {};
  private halfDurationSeconds = 300;
  private status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  private callbacks: RealtimeMatchClientCallbacks = {};

  private seq = 0;
  private lastSentInputAt = 0;
  private pendingCommands: PendingCommand[] = [];
  private snapshotBuffer: TimestampedSnapshot[] = [];
  private latestSnapshot: MultiplayerMatchSnapshot | null = null;

  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private intentionalClose = false;
  private lastPingMs = 18;

  public setCallbacks(callbacks: RealtimeMatchClientCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public getStatus() {
    return this.status;
  }

  public getPingMs() {
    return this.lastPingMs;
  }

  public getLatestSnapshot(): MultiplayerMatchSnapshot | null {
    return this.latestSnapshot;
  }

  public connectAndJoin(params: {
    roomCode: string;
    matchId: string;
    uid: string;
    displayName?: string;
    slotId: string;
    mode: MatchFormatMode;
    slots: Record<string, MultiplayerSlot>;
    halfDurationSeconds: number;
  }) {
    this.roomCode = params.roomCode.toUpperCase();
    this.matchId = params.matchId;
    this.uid = params.uid;
    this.displayName = params.displayName || 'Jogador';
    this.slotId = params.slotId;
    this.mode = params.mode;
    this.slots = params.slots;
    this.halfDurationSeconds = params.halfDurationSeconds;
    this.intentionalClose = false;
    this.seq = 0;
    this.pendingCommands = [];
    this.snapshotBuffer = [];

    this.openSocket(false);
  }

  private openSocket(isReconnect: boolean) {
    if (typeof window === 'undefined' || !this.roomCode || !this.uid) return;
    this.clearTimers();

    this.setStatus(isReconnect ? 'reconnecting' : 'connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/match`;

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        this.reconnectAttempt = 0;
        this.setStatus('connected');
        this.sendRaw({
          type: isReconnect ? 'reconnect' : 'join_match',
          roomCode: this.roomCode,
          matchId: this.matchId,
          uid: this.uid,
          displayName: this.displayName,
          slotId: this.slotId,
          mode: this.mode,
          slots: this.slots,
          halfDurationSeconds: this.halfDurationSeconds,
        });

        this.pingTimer = window.setInterval(() => {
          this.sendRaw({
            type: 'ping',
            clientTs: performance.now(),
          });
        }, 2000);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          this.handleMessage(msg);
        } catch {
          // Ignore malformed packet
        }
      };

      socket.onclose = () => {
        this.ws = null;
        if (this.pingTimer !== null) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        if (!this.intentionalClose && this.roomCode && this.uid) {
          this.scheduleReconnect();
        } else {
          this.setStatus('disconnected');
        }
      };

      socket.onerror = () => {
        // Handled by onclose
      };
    } catch {
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose) return;
    this.setStatus('reconnecting');
    const delays = [500, 1000, 2000, 4000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;

    this.reconnectTimer = window.setTimeout(() => {
      this.openSocket(true);
    }, delay);
  }

  private handleMessage(msg: Record<string, unknown>) {
    const type = String(msg.type || '');

    if (type === 'snapshot' || type === 'joined_ack') {
      const snap = msg.snapshot as MultiplayerMatchSnapshot | undefined;
      if (snap) {
        this.latestSnapshot = snap;
        const now = performance.now();
        this.snapshotBuffer.push({ receivedAt: now, snapshot: snap });
        while (this.snapshotBuffer.length > 16) {
          this.snapshotBuffer.shift();
        }

        if (this.uid && snap.lastProcessedSeqByUid) {
          const ackSeq = snap.lastProcessedSeqByUid[this.uid] || 0;
          this.pendingCommands = this.pendingCommands.filter(
            (cmd) => cmd.seq > ackSeq
          );
        }

        this.callbacks.onSnapshot?.(snap);
      }
      if (Array.isArray(msg.readyUids)) {
        this.notifyReadyList(msg.readyUids as string[]);
      }
      return;
    }

    if (type === 'ready_status') {
      if (Array.isArray(msg.readyUids)) {
        this.notifyReadyList(msg.readyUids as string[]);
      }
      return;
    }

    if (type === 'pong') {
      const clientTs = Number(msg.clientTs) || 0;
      if (clientTs > 0) {
        const rtt = Math.max(1, Math.round(performance.now() - clientTs));
        this.lastPingMs = Math.round(this.lastPingMs * 0.65 + rtt * 0.35);
        this.callbacks.onPingUpdate?.(this.lastPingMs);
      }
      return;
    }

    if (type === 'player_replaced_by_bot') {
      this.callbacks.onPlayerLeft?.(String(msg.uid || ''), true);
    }
  }

  private notifyReadyList(readyUids: string[]) {
    const readyByUid: Record<string, boolean> = {};
    for (const u of readyUids) {
      readyByUid[u] = true;
    }
    const humanUids = Object.values(this.slots)
      .filter((s) => !s.isBot && s.uid)
      .map((s) => String(s.uid));
    const allReady =
      humanUids.length > 0 && humanUids.every((u) => Boolean(readyByUid[u]));
    this.callbacks.onPlayerReadyUpdate?.(readyByUid, allReady);
  }

  public sendPlayerReady(forceStart = false) {
    if (!this.roomCode || !this.uid) return;
    this.sendRaw({
      type: 'player_ready',
      roomCode: this.roomCode,
      matchId: this.matchId,
      uid: this.uid,
      forceStart,
    });
  }

  public sendInputCommand(
    input: {
      slotId: string;
      moveX: number;
      moveZ: number;
      sprint: boolean;
      pass: boolean;
      longPass?: boolean;
      shoot: boolean;
      shootPower: number;
      tackle: boolean;
      header?: boolean;
      switchPlayer: boolean;
    },
    dt: number
  ): number {
    if (!this.roomCode || !this.uid) return this.seq;
    const now = performance.now();
    const action: WsInputCommand['action'] = input.tackle
      ? 'tackle'
      : input.shoot
      ? 'shoot'
      : input.longPass
      ? 'long_pass'
      : input.pass
      ? 'pass'
      : input.header
      ? 'header'
      : input.switchPlayer
      ? 'switch'
      : 'none';

    // 30Hz command send interval (~32ms), or immediately on discrete action edge
    if (action === 'none' && now - this.lastSentInputAt < 31) {
      return this.seq;
    }

    this.lastSentInputAt = now;
    this.seq += 1;
    this.slotId = input.slotId;

    const cmd: WsInputCommand = {
      seq: this.seq,
      timestamp: Date.now(),
      uid: this.uid,
      roomCode: this.roomCode,
      matchId: this.matchId || undefined,
      slotId: input.slotId,
      moveX: Number(input.moveX.toFixed(3)),
      moveZ: Number(input.moveZ.toFixed(3)),
      sprint: input.sprint,
      action,
      kickPower: Number(input.shootPower.toFixed(2)),
    };

    this.pendingCommands.push({
      ...cmd,
      dt: Math.min(0.05, Math.max(0.01, dt)),
    });
    while (this.pendingCommands.length > 45) {
      this.pendingCommands.shift();
    }

    this.sendRaw({
      type: 'input_cmd',
      command: cmd,
    });

    return this.seq;
  }

  /**
   * Computes reconciled target position for local player by taking authoritative server state
   * and re-applying unacknowledged pending movement commands (Client-Side Prediction + Server Reconciliation).
   */
  public getReconciledLocalPlayerTarget(
    slotId: string,
    serverPlayer: MultiplayerMatchSnapshot['players'][string],
    baseSpeed = 5.4
  ): { x: number; z: number; vx: number; vz: number } {
    let x = serverPlayer.x;
    let z = serverPlayer.z;
    let vx = serverPlayer.vx;
    let vz = serverPlayer.vz;

    for (const cmd of this.pendingCommands) {
      if (cmd.slotId !== slotId) continue;
      const mag = Math.hypot(cmd.moveX, cmd.moveZ);
      const nx = mag > 1 ? cmd.moveX / mag : cmd.moveX;
      const nz = mag > 1 ? cmd.moveZ / mag : cmd.moveZ;
      const speed = baseSpeed * (cmd.sprint ? 1.32 : 1.0);
      vx = nx * speed;
      vz = nz * speed;
      x = Math.max(-18.6, Math.min(18.6, x + vx * cmd.dt));
      z = Math.max(-11.8, Math.min(11.8, z + vz * cmd.dt));
    }

    return { x, z, vx, vz };
  }

  /**
   * Returns interpolated snapshot for remote entities ~50ms behind latest received snapshot
   * to eliminate jitter between 30Hz packets.
   */
  public getInterpolatedSnapshot(renderDelayMs = 50): MultiplayerMatchSnapshot | null {
    if (this.snapshotBuffer.length === 0) return this.latestSnapshot;
    if (this.snapshotBuffer.length === 1) return this.snapshotBuffer[0].snapshot;

    const targetTime = performance.now() - renderDelayMs;
    for (let i = this.snapshotBuffer.length - 1; i >= 1; i--) {
      const newer = this.snapshotBuffer[i];
      const older = this.snapshotBuffer[i - 1];
      if (targetTime >= older.receivedAt && targetTime <= newer.receivedAt) {
        const span = Math.max(1, newer.receivedAt - older.receivedAt);
        const alpha = Math.max(0, Math.min(1, (targetTime - older.receivedAt) / span));
        return this.interpolateSnapshots(older.snapshot, newer.snapshot, alpha);
      }
    }

    return this.snapshotBuffer[this.snapshotBuffer.length - 1].snapshot;
  }

  private interpolateSnapshots(
    a: MultiplayerMatchSnapshot,
    b: MultiplayerMatchSnapshot,
    alpha: number
  ): MultiplayerMatchSnapshot {
    const interpolatedPlayers: MultiplayerMatchSnapshot['players'] = {};
    for (const playerId of Object.keys(b.players || {})) {
      const bp = b.players[playerId];
      const ap = a.players?.[playerId];
      if (!ap) {
        interpolatedPlayers[playerId] = bp;
      } else {
        interpolatedPlayers[playerId] = {
          ...bp,
          x: ap.x + (bp.x - ap.x) * alpha,
          z: ap.z + (bp.z - ap.z) * alpha,
          vx: ap.vx + (bp.vx - ap.vx) * alpha,
          vz: ap.vz + (bp.vz - ap.vz) * alpha,
        };
      }
    }

    return {
      ...b,
      ball: {
        x: a.ball.x + (b.ball.x - a.ball.x) * alpha,
        y: a.ball.y + (b.ball.y - a.ball.y) * alpha,
        z: a.ball.z + (b.ball.z - a.ball.z) * alpha,
        vx: b.ball.vx,
        vy: b.ball.vy,
        vz: b.ball.vz,
        ownerId: b.ball.ownerId,
      },
      players: interpolatedPlayers,
    };
  }

  public disconnect(notifyLeave = true) {
    this.intentionalClose = true;
    if (notifyLeave && this.roomCode && this.uid) {
      this.sendRaw({
        type: 'leave_match',
        roomCode: this.roomCode,
        matchId: this.matchId,
        uid: this.uid,
      });
    }
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.roomCode = null;
    this.matchId = null;
    this.pendingCommands = [];
    this.snapshotBuffer = [];
    this.latestSnapshot = null;
    this.setStatus('disconnected');
  }

  private sendRaw(payload: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch {
        // Ignore send errors
      }
    }
  }

  private clearTimers() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setStatus(next: 'disconnected' | 'connecting' | 'connected' | 'reconnecting') {
    if (this.status !== next) {
      this.status = next;
      this.callbacks.onStatusChange?.(next);
    }
  }
}

export const realtimeMatchClient = new RealtimeMatchClient();
