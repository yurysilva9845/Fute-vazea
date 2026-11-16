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

function addSocketToRoom(roomCode: string, ws: WebSocket): void {
  const code = roomCode.toUpperCase();
  let set = roomSockets.get(code);
  if (!set) {
    set = new Set();
    roomSockets.set(code, set);
  }
  set.add(ws);
}

function removeSocketFromRoom(roomCode: string, ws: WebSocket): void {
  const code = roomCode.toUpperCase();
  const set = roomSockets.get(code);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      roomSockets.delete(code);
    }
  }
}

function broadcastToRoom(roomCode: string, payload: unknown): void {
  const code = roomCode.toUpperCase();
  const set = roomSockets.get(code);
  if (!set || set.size === 0) return;
  const serialized = JSON.stringify(payload);
  for (const sock of set) {
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(serialized);
    }
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Health & diagnostics endpoint for the Authoritative Real-Time Server
  app.get('/api/realtime/health', (_req, res) => {
    const sessions = globalMatchRegistry.getAllSessions();
    res.json({
      status: 'ok',
      architecture: 'Node.js Authoritative WebSocket Server',
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

  const httpServer = http.createServer(app);

  // Dedicated Low-Latency WebSocket Server for Real-Time Match Physics & Commands
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/match',
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'ping') {
          ws.send(
            JSON.stringify({
              type: 'pong',
              clientTs: msg.clientTs,
              serverTs: Date.now(),
            })
          );
          return;
        }

        if (msg.type === 'join_match' || msg.type === 'reconnect') {
          const roomCode = String(msg.roomCode || '').toUpperCase();
          const uid = String(msg.uid || '');
          const displayName = String(msg.displayName || 'Jogador');
          const slotId = String(msg.slotId || 'home_1');
          const matchId = String(msg.matchId || `MTC-${roomCode}`);
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
            aiDifficulty: msg.aiDifficulty || 'equilibrado',
            slots: msg.slots || {},
            activeCharacterIds: msg.activeCharacterIds,
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
          return;
        }

        if (msg.type === 'player_ready') {
          const meta = clientsBySocket.get(ws);
          const roomCode = String(msg.roomCode || meta?.roomCode || '').toUpperCase();
          const uid = String(msg.uid || meta?.uid || '');
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
          const cmd = msg.command as WsInputCommand;
          if (!cmd || !cmd.roomCode) return;

          const session = globalMatchRegistry.getSession(cmd.roomCode);
          if (!session) return;

          // Ensure UID matches authenticated socket session
          const verifiedCmd: WsInputCommand = {
            ...cmd,
            uid: meta?.uid || cmd.uid,
          };
          session.submitCommand(verifiedCmd);
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
      if (!roomSet || roomSet.size === 0) {
        // Clean up idle sessions after 60s without connected sockets
        if (now - session.lastActivityMs > 60000) {
          globalMatchRegistry.removeSession(session.roomCode);
        }
        continue;
      }

      const snapshot = session.stepTick(SERVER_TICK_DT);
      broadcastToRoom(session.roomCode, {
        type: 'match_state',
        roomCode: session.roomCode,
        matchId: session.matchId,
        snapshot,
      });
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
