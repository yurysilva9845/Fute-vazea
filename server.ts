import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  globalMatchRegistry,
  SERVER_TICK_DT,
  SERVER_TICK_RATE,
} from './src/server/authoritativeMatchEngine';
import { WsInputCommand } from './src/types/game';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

interface ConnectedClientMeta {
  ws: WebSocket;
  uid: string;
  displayName: string;
  roomCode: string;
  slotId: string;
  matchId: string;
  lastSeenMs: number;
}

const clientsBySocket = new Map<WebSocket, ConnectedClientMeta>();
const roomSockets = new Map<string, Set<WebSocket>>();
const disconnectTimersByRoomUid = new Map<string, NodeJS.Timeout>();

const VALID_ACTIONS = new Set<WsInputCommand['action']>([
  'none',
  'pass',
  'long_pass',
  'shoot',
  'tackle',
  'header',
  'switch',
]);

export function sanitizeRoomCode(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 16);
}

export function validateInputCommand(
  rawCmd: unknown,
  authenticatedUid?: string
): WsInputCommand | null {
  if (!rawCmd || typeof rawCmd !== 'object') return null;
  const c = rawCmd as Record<string, unknown>;
  const roomCode = sanitizeRoomCode(c.roomCode);
  const uid = String(authenticatedUid || c.uid || '').trim().slice(0, 128);
  const slotId = String(c.slotId || '').trim().slice(0, 24);
  if (!roomCode || !uid || !slotId) return null;

  const seq = Math.max(0, Math.floor(Number(c.seq) || 0));
  const moveX = Math.max(-1, Math.min(1, Number(c.moveX) || 0));
  const moveZ = Math.max(-1, Math.min(1, Number(c.moveZ) || 0));
  const kickPower = Math.max(0.25, Math.min(1.0, Number(c.kickPower) || 0.65));
  const rawAction = String(c.action || 'none') as WsInputCommand['action'];
  const action: WsInputCommand['action'] = VALID_ACTIONS.has(rawAction) ? rawAction : 'none';

  return {
    seq,
    timestamp: Number(c.timestamp) || Date.now(),
    uid,
    roomCode,
    matchId: c.matchId ? String(c.matchId).slice(0, 32) : undefined,
    slotId,
    moveX: Number(moveX.toFixed(3)),
    moveZ: Number(moveZ.toFixed(3)),
    sprint: Boolean(c.sprint),
    action,
    kickPower: Number(kickPower.toFixed(2)),
  };
}

function addSocketToRoom(roomCode: string, ws: WebSocket): void {
  const code = sanitizeRoomCode(roomCode);
  if (!code) return;
  let set = roomSockets.get(code);
  if (!set) {
    set = new Set();
    roomSockets.set(code, set);
  }
  set.add(ws);
}

function removeSocketFromRoom(roomCode: string, ws: WebSocket): void {
  const code = sanitizeRoomCode(roomCode);
  const set = roomSockets.get(code);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      roomSockets.delete(code);
    }
  }
}

function broadcastToRoom(roomCode: string, payload: unknown): void {
  const code = sanitizeRoomCode(roomCode);
  const set = roomSockets.get(code);
  if (!set || set.size === 0) return;
  const serialized = JSON.stringify(payload);
  for (const sock of set) {
    if (sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(serialized);
      } catch {
        // Ignore transient socket write error
      }
    }
  }
}

async function startServer() {
  const app = express();

  // CORS para permitir conexões de clientes hospedados na Vercel (fute-vazea.vercel.app) ou outros domínios
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  // Health & diagnostics endpoint for the Authoritative Real-Time Server
  app.get('/api/realtime/health', (_req, res) => {
    const sessions = globalMatchRegistry.getAllSessions();
    res.json({
      status: 'ok',
      architecture: 'Node.js Authoritative WebSocket Server',
      wsPath: '/ws/match',
      tickRateHz: SERVER_TICK_RATE,
      activeSessions: sessions.length,
      connectedClients: clientsBySocket.size,
      rooms: sessions.map((s) => ({
        roomCode: s.roomCode,
        matchId: s.matchId,
        tickCount: s.tickCount,
        phase: s.phase,
        score: `${s.homeGoals}x${s.awayGoals}`,
        connectedUids: Array.from(s.connectedUids),
        readyUids: Array.from(s.readyUids),
      })),
    });
  });

  // Endpoint HTTP compartilhado para sincronização/consulta de estado entre instâncias ou fallback
  app.get('/api/realtime/session/:roomCode', (req, res) => {
    const code = sanitizeRoomCode(req.params.roomCode);
    const session = globalMatchRegistry.getSession(code);
    if (!session) {
      res.status(404).json({ ok: false, error: 'Sessão não encontrada.' });
      return;
    }
    res.json({
      ok: true,
      roomCode: session.roomCode,
      matchId: session.matchId,
      tickRateHz: SERVER_TICK_RATE,
      snapshot: session.getSnapshot(),
      slots: session.slots,
      readyUids: Array.from(session.readyUids),
    });
  });

  // Endpoint HTTP de comando validado para fallback quando WebSocket estiver bloqueado na rede do cliente
  app.post('/api/realtime/command', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const type = String(body.type || '');

    if (type === 'join_match' || type === 'reconnect') {
      const roomCode = sanitizeRoomCode(body.roomCode);
      const uid = String(body.uid || '').trim().slice(0, 128);
      const displayName = String(body.displayName || 'Jogador').slice(0, 28);
      const slotId = String(body.slotId || 'home_1').slice(0, 24);
      const matchId = String(body.matchId || `MTC-${roomCode}`).slice(0, 32);
      if (!roomCode || !uid) {
        res.status(400).json({ ok: false, error: 'roomCode e uid são obrigatórios.' });
        return;
      }

      const session = globalMatchRegistry.getOrCreateSession({
        roomCode,
        matchId,
        hostUid: String(body.hostUid || uid),
        mode: body.mode === '2v2' ? '2v2' : '4v4',
        homeTeamName: String(body.homeTeamName || 'Sem Terra FC'),
        awayTeamName: String(body.awayTeamName || 'Rubro-Negro do Beco'),
        halfDurationSeconds: Number(body.halfDurationSeconds) || 300,
        aiDifficulty:
          body.aiDifficulty === 'raiz' || body.aiDifficulty === 'lenda'
            ? body.aiDifficulty
            : 'equilibrado',
        slots: (body.slots as Record<string, any>) || {},
        activeCharacterIds: Array.isArray(body.activeCharacterIds)
          ? (body.activeCharacterIds as string[])
          : undefined,
      });

      session.handlePlayerReconnect(uid, displayName, slotId);
      res.json({
        ok: true,
        type: 'joined_ack',
        roomCode,
        matchId: session.matchId,
        tickRateHz: SERVER_TICK_RATE,
        snapshot: session.getSnapshot(),
        slots: session.slots,
        readyUids: Array.from(session.readyUids),
      });
      return;
    }

    if (type === 'input_cmd') {
      const validated = validateInputCommand(body.command);
      if (!validated) {
        res.status(400).json({ ok: false, error: 'Comando inválido.' });
        return;
      }
      const session = globalMatchRegistry.getSession(validated.roomCode);
      if (!session) {
        res.status(404).json({ ok: false, error: 'Sessão não encontrada.' });
        return;
      }
      const result = session.submitCommand(validated);
      res.json({
        ok: result.accepted,
        reason: result.reason,
        snapshot: session.getSnapshot(),
      });
      return;
    }

    if (type === 'webrtc_signal') {
      const roomCode = sanitizeRoomCode(body.roomCode);
      const fromUid = String(body.fromUid || '').trim().slice(0, 128);
      const toUid = String(body.toUid || '').trim().slice(0, 128);
      const signalType = String(body.signalType || '');
      const payload = String(body.payload || '');
      if (!roomCode || !fromUid || !toUid || !payload) {
        res.status(400).json({ ok: false, error: 'Sinal WebRTC incompleto.' });
        return;
      }
      broadcastToRoom(roomCode, {
        type: 'webrtc_signal',
        roomCode,
        fromUid,
        toUid,
        signalType,
        payload,
      });
      res.json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'Tipo de mensagem desconhecido.' });
  });

  // Resposta explícita 200 OK para sondagens HTTP GET em /ws/match (evita 404 quando testado sem cabeçalho Upgrade)
  app.get(['/ws/match', '/api/ws/match', '/api/realtime/ws'], (_req, res) => {
    res.status(200).json({
      ok: true,
      endpoint: '/ws/match',
      transport: 'WebSocket (RFC 6455)',
      upgradeSupported: true,
      tickRateHz: SERVER_TICK_RATE,
      activeSessions: globalMatchRegistry.getAllSessions().length,
      connectedClients: clientsBySocket.size,
    });
  });

  const httpServer = http.createServer(app);

  // Dedicated Low-Latency WebSocket Server for Real-Time Match Physics & Commands
  const wss = new WebSocketServer({
    noServer: true,
  });

  // Aceita HTTP Upgrade em /ws/match, /api/ws/match e /api/realtime/ws (inclusive com barra final ou query string)
  httpServer.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url || '';
    const pathname = rawUrl.split('?')[0].replace(/\/+$/, '') || '/';
    if (
      pathname === '/ws/match' ||
      pathname === '/api/ws/match' ||
      pathname === '/api/realtime/ws'
    ) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const text = String(raw);
        if (text.length > 65536) return; // Proteção contra payloads gigantes
        const msg = JSON.parse(text) as Record<string, unknown>;
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'ping') {
          ws.send(
            JSON.stringify({
              type: 'pong',
              clientTs: Number(msg.clientTs) || 0,
              serverTs: Date.now(),
            })
          );
          return;
        }

        if (msg.type === 'join_match' || msg.type === 'reconnect') {
          const roomCode = sanitizeRoomCode(msg.roomCode);
          const uid = String(msg.uid || '').trim().slice(0, 128);
          const displayName = String(msg.displayName || 'Jogador').trim().slice(0, 28);
          const slotId = String(msg.slotId || 'home_1').trim().slice(0, 24);
          const matchId = String(msg.matchId || `MTC-${roomCode}`).trim().slice(0, 32);
          if (!roomCode || !uid) return;

          // Cancel pending disconnect-to-bot timer if player reconnected within grace window
          const timerKey = `${roomCode}:${uid}`;
          const existingTimer = disconnectTimersByRoomUid.get(timerKey);
          if (existingTimer) {
            clearTimeout(existingTimer);
            disconnectTimersByRoomUid.delete(timerKey);
          }

          // Prevent duplicate socket entries for the same UID in the same room
          const existingRoomSet = roomSockets.get(roomCode);
          if (existingRoomSet) {
            for (const otherWs of existingRoomSet) {
              if (otherWs !== ws) {
                const otherMeta = clientsBySocket.get(otherWs);
                if (otherMeta && otherMeta.uid === uid) {
                  removeSocketFromRoom(roomCode, otherWs);
                  clientsBySocket.delete(otherWs);
                  try {
                    otherWs.close(1000, 'Replaced by newer connection');
                  } catch {
                    // Ignore
                  }
                }
              }
            }
          }

          const session = globalMatchRegistry.getOrCreateSession({
            roomCode,
            matchId,
            hostUid: String(msg.hostUid || uid),
            mode: msg.mode === '2v2' ? '2v2' : '4v4',
            homeTeamName: String(msg.homeTeamName || 'Sem Terra FC'),
            awayTeamName: String(msg.awayTeamName || 'Rubro-Negro do Beco'),
            halfDurationSeconds: Number(msg.halfDurationSeconds) || 300,
            aiDifficulty:
              msg.aiDifficulty === 'raiz' || msg.aiDifficulty === 'lenda'
                ? msg.aiDifficulty
                : 'equilibrado',
            slots: (msg.slots as Record<string, any>) || {},
            activeCharacterIds: Array.isArray(msg.activeCharacterIds)
              ? (msg.activeCharacterIds as string[])
              : undefined,
          });

          session.handlePlayerReconnect(uid, displayName, slotId);

          clientsBySocket.set(ws, {
            ws,
            uid,
            displayName,
            roomCode,
            slotId,
            matchId: session.matchId,
            lastSeenMs: Date.now(),
          });
          addSocketToRoom(roomCode, ws);

          ws.send(
            JSON.stringify({
              type: 'joined_ack',
              roomCode,
              matchId: session.matchId,
              tickRateHz: SERVER_TICK_RATE,
              snapshot: session.getSnapshot(),
              slots: session.slots,
              readyUids: Array.from(session.readyUids),
            })
          );

          broadcastToRoom(roomCode, {
            type: 'player_joined',
            roomCode,
            matchId: session.matchId,
            uid,
            displayName,
            slotId,
            slots: session.slots,
            readyUids: Array.from(session.readyUids),
          });
          return;
        }

        if (msg.type === 'player_ready') {
          const meta = clientsBySocket.get(ws);
          const roomCode = sanitizeRoomCode(msg.roomCode || meta?.roomCode);
          const uid = String(msg.uid || meta?.uid || '').trim().slice(0, 128);
          const session = globalMatchRegistry.getSession(roomCode);
          if (!session || !uid) return;

          session.readyUids.add(uid);
          broadcastToRoom(roomCode, {
            type: 'ready_status',
            roomCode,
            readyUids: Array.from(session.readyUids),
          });
          return;
        }

        if (msg.type === 'input_cmd') {
          const meta = clientsBySocket.get(ws);
          if (meta) {
            meta.lastSeenMs = Date.now();
          }
          const verifiedCmd = validateInputCommand(msg.command, meta?.uid);
          if (!verifiedCmd) return;

          const session = globalMatchRegistry.getSession(verifiedCmd.roomCode);
          if (!session) return;

          session.submitCommand(verifiedCmd);
          return;
        }

        if (msg.type === 'webrtc_signal') {
          const meta = clientsBySocket.get(ws);
          const roomCode = sanitizeRoomCode(msg.roomCode || meta?.roomCode);
          const fromUid = String(meta?.uid || msg.fromUid || '').trim().slice(0, 128);
          const toUid = String(msg.toUid || '').trim().slice(0, 128);
          const signalType = String(msg.signalType || '');
          const payload = String(msg.payload || '');
          if (!roomCode || !fromUid || !toUid || !payload) return;

          broadcastToRoom(roomCode, {
            type: 'webrtc_signal',
            roomCode,
            fromUid,
            toUid,
            signalType,
            payload,
          });
          return;
        }

        if (msg.type === 'leave_match') {
          const meta = clientsBySocket.get(ws);
          if (!meta) return;
          const session = globalMatchRegistry.getSession(meta.roomCode);
          if (session) {
            const botSlot = session.handlePlayerDisconnect(meta.uid, true);
            broadcastToRoom(meta.roomCode, {
              type: 'player_replaced_by_bot',
              roomCode: meta.roomCode,
              uid: meta.uid,
              slot: botSlot,
              slots: session.slots,
            });
          }
          removeSocketFromRoom(meta.roomCode, ws);
          clientsBySocket.delete(ws);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      const meta = clientsBySocket.get(ws);
      if (!meta) return;
      removeSocketFromRoom(meta.roomCode, ws);
      clientsBySocket.delete(ws);

      const session = globalMatchRegistry.getSession(meta.roomCode);
      if (!session) return;

      // Temporarily mark disconnected; if not reconnected within 8 seconds, convert slot permanently to Bot
      session.handlePlayerDisconnect(meta.uid, false);
      const timerKey = `${meta.roomCode}:${meta.uid}`;
      const graceTimer = setTimeout(() => {
        disconnectTimersByRoomUid.delete(timerKey);
        const activeSession = globalMatchRegistry.getSession(meta.roomCode);
        if (!activeSession) return;
        if (!activeSession.connectedUids.has(meta.uid)) {
          const botSlot = activeSession.handlePlayerDisconnect(meta.uid, true);
          broadcastToRoom(meta.roomCode, {
            type: 'player_replaced_by_bot',
            roomCode: meta.roomCode,
            uid: meta.uid,
            slot: botSlot,
            slots: activeSession.slots,
          });
        }
      }, 8000);
      disconnectTimersByRoomUid.set(timerKey, graceTimer);
    });
  });

  // Authoritative 30Hz Simulation Loop (33.33ms fixed interval)
  setInterval(() => {
    const now = Date.now();
    for (const session of globalMatchRegistry.getAllSessions()) {
      const roomSet = roomSockets.get(session.roomCode);
      const hasConnectedSockets = Boolean(roomSet && roomSet.size > 0);
      const isRecentlyActive = now - session.lastActivityMs <= 15000;

      if (!hasConnectedSockets && !isRecentlyActive) {
        // Clean up idle sessions after 60s without connected sockets or HTTP commands
        if (now - session.lastActivityMs > 60000) {
          globalMatchRegistry.removeSession(session.roomCode);
        }
        continue;
      }

      const snapshot = session.stepTick(SERVER_TICK_DT);
      if (hasConnectedSockets) {
        broadcastToRoom(session.roomCode, {
          type: 'match_state',
          roomCode: session.roomCode,
          matchId: session.matchId,
          snapshot,
        });
      }
    }
  }, Math.round(1000 / SERVER_TICK_RATE));

  // Vite middleware in development, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[SEM TERRA FC] Servidor Autoritativo 30Hz + WebSocket ativo em http://0.0.0.0:${PORT}`
    );
  });
}

startServer();

