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

const DEFAULT_CLOUD_RUN_BACKEND_HOST =
  'ais-pre-vjvg452vafw2n3arhxoh2l-129611115171.us-east1.run.app';
const MAX_RECONNECT_ATTEMPTS = 6;

/**
 * Resolve a lista ordenada de endpoints WebSocket candidatos:
 * 1. Variável de ambiente VITE_WS_URL (se configurada na Vercel ou .env).
 * 2. Se não estiver em domínio estático `.vercel.app` (ex.: localhost, Cloud Run `.run.app`, servidor Node próprio),
 *    usa `${protocol}//${window.location.host}/ws/match`.
 * 3. Se estiver em `.vercel.app` (onde a Vercel serve apenas o bundle estático e não executa `server.ts`),
 *    usa o servidor Node.js/Cloud Run autoritativo do projeto como endpoint primário e evita falhar em `wss://*.vercel.app/ws/match`.
 */
export function resolveWsCandidateUrls(
  envWsUrl?: string,
  locationObj?: { protocol: string; host: string; hostname: string }
): string[] {
  const candidates: string[] = [];
  const configured = (
    envWsUrl ??
    (typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.VITE_WS_URL as string | undefined)
      : undefined) ??
    ''
  ).trim();

  if (configured) {
    const normalized = configured.endsWith('/ws/match')
      ? configured
      : `${configured.replace(/\/+$/, '')}/ws/match`;
    candidates.push(normalized);
  }

  const loc =
    locationObj ??
    (typeof window !== 'undefined'
      ? {
          protocol: window.location.protocol,
          host: window.location.host,
          hostname: window.location.hostname,
        }
      : null);

  if (loc && loc.host) {
    const isVercelStaticHost = loc.hostname.endsWith('.vercel.app');
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const sameOriginWs = `${protocol}//${loc.host}/ws/match`;
    const cloudRunWs = `wss://${DEFAULT_CLOUD_RUN_BACKEND_HOST}/ws/match`;

    if (isVercelStaticHost) {
      // Em deploy estático na Vercel, conecta diretamente ao servidor Node.js/Cloud Run com suporte a HTTP Upgrade WebSocket
      if (!candidates.includes(cloudRunWs)) {
        candidates.push(cloudRunWs);
      }
    } else {
      if (!candidates.includes(sameOriginWs)) {
        candidates.push(sameOriginWs);
      }
      if (!candidates.includes(cloudRunWs)) {
        candidates.push(cloudRunWs);
      }
    }
  }

  return candidates;
}

/**
 * Calcula atraso de reconexão usando backoff exponencial com jitter aleatório (sem loops infinitos).
 */
export function computeReconnectDelayMs(attempt: number, randomValue = Math.random()): number {
  const clampedAttempt = Math.max(0, Math.min(attempt, MAX_RECONNECT_ATTEMPTS));
  const baseMs = Math.min(12000, 600 * Math.pow(2, clampedAttempt));
  const jitterMs = Math.floor(Math.max(0, Math.min(1, randomValue)) * 450);
  return baseMs + jitterMs;
}

export class RealtimeMatchClient {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private candidateUrls: string[] = [];
  private candidateIndex = 0;

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
  private httpFallbackPollTimer: number | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  private intentionalClose = false;
  private lastPingMs = 18;
  private webrtcSignalListeners = new Set<
    (signal: {
      roomCode: string;
      fromUid: string;
      toUid: string;
      signalType: 'offer' | 'answer' | 'ice';
      payload: string;
    }) => void
  >();

  public subscribeToWebRtcSignals(
    cb: (signal: {
      roomCode: string;
      fromUid: string;
      toUid: string;
      signalType: 'offer' | 'answer' | 'ice';
      payload: string;
    }) => void
  ): () => void {
    this.webrtcSignalListeners.add(cb);
    return () => {
      this.webrtcSignalListeners.delete(cb);
    };
  }

  public sendWebRtcSignal(params: {
    roomCode: string;
    fromUid: string;
    toUid: string;
    signalType: 'offer' | 'answer' | 'ice';
    payload: string;
  }): boolean {
    const packet = {
      type: 'webrtc_signal',
      roomCode: params.roomCode,
      fromUid: params.fromUid,
      toUid: params.toUid,
      signalType: params.signalType,
      payload: params.payload,
    };
    this.broadcastCrossTab({ ...packet, senderUid: params.fromUid });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendRaw(packet);
      return true;
    }
    if (typeof fetch === 'function') {
      const baseUrl = this.getHttpRelayBaseUrl();
      fetch(`${baseUrl}/api/realtime/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
      }).catch(() => {});
      return true;
    }
    return false;
  }

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
    const nextRoomCode = params.roomCode.trim().toUpperCase();
    const nextMatchId = params.matchId;

    // Evita reconexões concorrentes desnecessárias se já estiver conectado ou conectando na mesma sala/partida
    if (
      this.roomCode === nextRoomCode &&
      this.matchId === nextMatchId &&
      this.uid === params.uid &&
      (this.isConnecting ||
        (this.ws &&
          (this.ws.readyState === WebSocket.OPEN ||
            this.ws.readyState === WebSocket.CONNECTING)))
    ) {
      this.slots = params.slots;
      this.slotId = params.slotId;
      return;
    }

    // Fecha conexão anterior de forma controlada caso estivesse em outra sala
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close(1000, 'Switching match session');
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    this.roomCode = nextRoomCode;
    this.matchId = nextMatchId;
    this.uid = params.uid;
    this.displayName = params.displayName || 'Jogador';
    this.slotId = params.slotId;
    this.mode = params.mode;
    this.slots = params.slots;
    this.halfDurationSeconds = params.halfDurationSeconds;
    this.intentionalClose = false;
    this.isConnecting = false;
    this.reconnectAttempt = 0;
    this.candidateUrls = resolveWsCandidateUrls();
    this.candidateIndex = 0;
    this.seq = 0;
    this.pendingCommands = [];
    this.snapshotBuffer = [];

    this.setupCrossTabBroadcastChannel(nextRoomCode);
    this.openSocket(false);
  }

  private setupCrossTabBroadcastChannel(roomCode: string) {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
        // Ignore
      }
      this.broadcastChannel = null;
    }

    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const bc = new BroadcastChannel(`stf_match_${roomCode}`);
        bc.onmessage = (ev) => {
          if (!ev?.data || typeof ev.data !== 'object') return;
          const msg = ev.data as Record<string, unknown>;
          if (msg.senderUid === this.uid) return;
          this.handleMessage(msg);
        };
        this.broadcastChannel = bc;
      } catch {
        // BroadcastChannel opcional
      }
    }
  }

  private openSocket(isReconnect: boolean) {
    if (typeof window === 'undefined' || !this.roomCode || !this.uid) return;
    if (this.isConnecting) return; // Impede tentativas simultâneas de conexão

    this.clearTimers();

    if (this.candidateUrls.length === 0) {
      this.candidateUrls = resolveWsCandidateUrls();
    }
    const wsUrl =
      this.candidateUrls[this.candidateIndex % Math.max(1, this.candidateUrls.length)];
    if (!wsUrl) {
      this.setStatus('disconnected');
      return;
    }

    this.isConnecting = true;
    this.setStatus(isReconnect ? 'reconnecting' : 'connecting');

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      const handshakeTimeout = window.setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          try {
            socket.close();
          } catch {
            // Ignore
          }
        }
      }, 5500);

      socket.onopen = () => {
        window.clearTimeout(handshakeTimeout);
        this.isConnecting = false;
        this.reconnectAttempt = 0;
        this.stopHttpFallbackRelay();
        this.setStatus('connected');

        // Reentra automaticamente na sala e slot corretos ao conectar ou reconectar
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
        }, 2500);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          this.handleMessage(msg);
        } catch {
          // Ignore malformed packet
        }
      };

      socket.onclose = () => {
        window.clearTimeout(handshakeTimeout);
        this.isConnecting = false;
        if (this.ws === socket) {
          this.ws = null;
        }
        if (this.pingTimer !== null) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        if (!this.intentionalClose && this.roomCode && this.uid) {
          this.candidateIndex = (this.candidateIndex + 1) % Math.max(1, this.candidateUrls.length);
          this.scheduleReconnect();
        } else {
          this.setStatus('disconnected');
        }
      };

      socket.onerror = () => {
        // Tratado de forma controlada pelo onclose com backoff exponencial
      };
    } catch {
      this.isConnecting = false;
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer !== null) return;

    // Respeita limite máximo de tentativas para nunca criar loops infinitos de reconexão
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('disconnected');
      this.startHttpFallbackRelay();
      return;
    }

    this.setStatus('reconnecting');
    const delay = computeReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(true);
    }, delay);
  }

  private getHttpRelayBaseUrl(): string {
    const configuredWs = this.candidateUrls[0] || '';
    if (configuredWs.startsWith('wss://')) {
      return configuredWs.replace(/^wss:\/\//, 'https://').replace(/\/ws\/match$/, '');
    }
    if (configuredWs.startsWith('ws://')) {
      return configuredWs.replace(/^ws:\/\//, 'http://').replace(/\/ws\/match$/, '');
    }
    return `https://${DEFAULT_CLOUD_RUN_BACKEND_HOST}`;
  }

  private startHttpFallbackRelay() {
    if (this.httpFallbackPollTimer !== null || typeof window === 'undefined' || !this.roomCode || !this.uid) {
      return;
    }
    const baseUrl = this.getHttpRelayBaseUrl();

    // Registra presença na sessão HTTP compartilhada
    fetch(`${baseUrl}/api/realtime/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reconnect',
        roomCode: this.roomCode,
        matchId: this.matchId,
        uid: this.uid,
        displayName: this.displayName,
        slotId: this.slotId,
        mode: this.mode,
        slots: this.slots,
        halfDurationSeconds: this.halfDurationSeconds,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.snapshot) {
          this.setStatus('connected');
          this.handleMessage(data);
        }
      })
      .catch(() => {});

    this.httpFallbackPollTimer = window.setInterval(() => {
      if (!this.roomCode || this.intentionalClose) return;
      fetch(`${baseUrl}/api/realtime/session/${encodeURIComponent(this.roomCode)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.snapshot) {
            this.setStatus('connected');
            this.handleMessage({
              type: 'match_state',
              roomCode: data.roomCode,
              matchId: data.matchId,
              snapshot: data.snapshot,
              readyUids: data.readyUids,
            });
          }
        })
        .catch(() => {});
    }, 120);
  }

  private stopHttpFallbackRelay() {
    if (this.httpFallbackPollTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.httpFallbackPollTimer);
      this.httpFallbackPollTimer = null;
    }
  }

  public handleMessage(msg: Record<string, unknown>) {
    const type = String(msg.type || '');

    // Aceita tanto 'match_state' (enviado a 30Hz pelo server.ts) quanto 'snapshot' e 'joined_ack'
    if (type === 'match_state' || type === 'snapshot' || type === 'joined_ack') {
      const snap = msg.snapshot as MultiplayerMatchSnapshot | undefined;
      if (snap && snap.ball && snap.players) {
        this.latestSnapshot = snap;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.snapshotBuffer.push({ receivedAt: now, snapshot: snap });
        while (this.snapshotBuffer.length > 16) {
          this.snapshotBuffer.shift();
        }

        if (this.uid && snap.lastProcessedSeqByUid) {
          const ackSeq = snap.lastProcessedSeqByUid[this.uid] || 0;
          this.pendingCommands = this.pendingCommands.filter((cmd) => cmd.seq > ackSeq);
        }

        this.callbacks.onSnapshot?.(snap);
      }
      if (msg.slots && typeof msg.slots === 'object') {
        this.slots = msg.slots as Record<string, MultiplayerSlot>;
      }
      if (Array.isArray(msg.readyUids)) {
        this.notifyReadyList(msg.readyUids as string[]);
      }
      return;
    }

    if (type === 'player_joined') {
      if (msg.slots && typeof msg.slots === 'object') {
        this.slots = msg.slots as Record<string, MultiplayerSlot>;
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
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (clientTs > 0) {
        const rtt = Math.max(1, Math.round(now - clientTs));
        this.lastPingMs = Math.round(this.lastPingMs * 0.65 + rtt * 0.35);
        this.callbacks.onPingUpdate?.(this.lastPingMs);
      }
      return;
    }

    if (type === 'player_replaced_by_bot') {
      if (msg.slots && typeof msg.slots === 'object') {
        this.slots = msg.slots as Record<string, MultiplayerSlot>;
      }
      this.callbacks.onPlayerLeft?.(String(msg.uid || ''), true);
      return;
    }

    if (type === 'webrtc_signal') {
      const sig = {
        roomCode: String(msg.roomCode || ''),
        fromUid: String(msg.fromUid || ''),
        toUid: String(msg.toUid || ''),
        signalType: String(msg.signalType || 'offer') as 'offer' | 'answer' | 'ice',
        payload: String(msg.payload || ''),
      };
      this.webrtcSignalListeners.forEach((cb) => {
        try {
          cb(sig);
        } catch {
          // Ignore listener error
        }
      });
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
    const allReady = humanUids.length > 0 && humanUids.every((u) => Boolean(readyByUid[u]));
    this.callbacks.onPlayerReadyUpdate?.(readyByUid, allReady);
  }

  public sendPlayerReady(forceStart = false) {
    if (!this.roomCode || !this.uid) return;
    const payload = {
      type: 'player_ready',
      roomCode: this.roomCode,
      matchId: this.matchId,
      uid: this.uid,
      forceStart,
    };
    this.sendRaw(payload);
    this.broadcastCrossTab({ ...payload, senderUid: this.uid });
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
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
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
      moveX: Number(Math.max(-1, Math.min(1, input.moveX)).toFixed(3)),
      moveZ: Number(Math.max(-1, Math.min(1, input.moveZ)).toFixed(3)),
      sprint: Boolean(input.sprint),
      action,
      kickPower: Number(Math.max(0.25, Math.min(1, input.shootPower)).toFixed(2)),
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

    if (this.httpFallbackPollTimer !== null && typeof fetch === 'function') {
      const baseUrl = this.getHttpRelayBaseUrl();
      fetch(`${baseUrl}/api/realtime/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'input_cmd',
          command: cmd,
        }),
      }).catch(() => {});
    }

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

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const targetTime = now - renderDelayMs;
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
    this.isConnecting = false;
    if (notifyLeave && this.roomCode && this.uid) {
      this.sendRaw({
        type: 'leave_match',
        roomCode: this.roomCode,
        matchId: this.matchId,
        uid: this.uid,
      });
    }
    this.clearTimers();
    this.stopHttpFallbackRelay();
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
        // Ignore
      }
      this.broadcastChannel = null;
    }
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close(1000, 'Client left match');
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

  private broadcastCrossTab(payload: Record<string, unknown>) {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(payload);
      } catch {
        // Ignore
      }
    }
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

