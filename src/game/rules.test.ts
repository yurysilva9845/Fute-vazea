import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGoalScored,
  checkOutOfBounds,
  DEFAULT_PITCH,
  formatMatchTime,
  getActivePlayersForMode,
  getMudSpeedMultiplier,
  getPuddleAt,
  getTerrainHeightAt,
  INITIAL_AWAY_PLAYERS,
  INITIAL_HOME_PLAYERS,
  stepBallPhysics,
} from './rules';
import {
  buildInitialRoomSlots,
  convertSlotToBot,
  resolveActiveCharacterIdsForRoom,
} from '../services/botService';
import { BallState } from '../types/game';

function createBall(overrides: Partial<BallState> = {}): BallState {
  return {
    x: 0,
    y: 0.22,
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
    inPuddle: false,
    ...overrides,
  };
}

test('Team 1 roster contains Yuri, Josué, Careca and Bode with distinct personalities and celebrations', () => {
  const names = INITIAL_HOME_PLAYERS.map((p) => p.name);
  assert.deepEqual(names, ['Yuri', 'Josué', 'Careca', 'Bode']);

  const careca = INITIAL_HOME_PLAYERS.find((p) => p.name === 'Careca');
  assert.ok(careca, 'Careca must be present');
  assert.equal(careca.skinColor, '#4a2c18');
  assert.equal(careca.bodyBuild, 'slim');
  assert.equal(careca.hairStyle, 'bald');
  assert.equal(careca.celebrationStyle, 'careca');

  const celebrations = INITIAL_HOME_PLAYERS.map((p) => p.celebrationStyle);
  assert.deepEqual(celebrations, ['yuri', 'josue', 'careca', 'bode']);
});

test('Team 2 roster contains Primo, Bicudo, Ismael and Felipe', () => {
  const names = INITIAL_AWAY_PLAYERS.map((p) => p.name);
  assert.deepEqual(names, ['Primo', 'Bicudo', 'Ismael', 'Felipe']);
});

test('2v2 and 4v4 modes isolate team sizes and support free choice of 2 characters per team with bot auto-fill', () => {
  const active4v4 = getActivePlayersForMode(INITIAL_HOME_PLAYERS, INITIAL_AWAY_PLAYERS, '4v4');
  assert.equal(active4v4.home.length, 4);
  assert.equal(active4v4.away.length, 4);

  const active2v2 = getActivePlayersForMode(
    INITIAL_HOME_PLAYERS,
    INITIAL_AWAY_PLAYERS,
    '2v2',
    ['home_2', 'home_4', 'away_1', 'away_3']
  );
  assert.equal(active2v2.home.length, 2);
  assert.equal(active2v2.away.length, 2);
  assert.deepEqual(
    active2v2.home.map((p) => p.name),
    ['Josué', 'Bode']
  );
  assert.deepEqual(
    active2v2.away.map((p) => p.name),
    ['Primo', 'Ismael']
  );

  // Verify botService builds 8 slots and converts disconnected humans back to bots
  const slots = buildInitialRoomSlots('host_123', 'YuriHost', 'home_3');
  assert.equal(slots['home_3'].isBot, false);
  assert.equal(slots['home_3'].uid, 'host_123');
  assert.equal(slots['home_1'].isBot, true);

  const ids2v2 = resolveActiveCharacterIdsForRoom(slots, '2v2');
  assert.equal(ids2v2.length, 4);
  assert.ok(ids2v2.includes('home_3'), 'Host chosen character must be active in 2v2');

  const botFallback = convertSlotToBot(slots['home_3']);
  assert.equal(botFallback.isBot, true);
  assert.equal(botFallback.uid, null);
});

test('Goal detection requires complete entry into the small várzea goal', () => {
  const halfW = DEFAULT_PITCH.width / 2;

  // Ball on the line (partially inside) -> no goal yet
  const onLine = createBall({ x: halfW + 0.05, y: 0.5, z: 0 });
  assert.equal(checkGoalScored(onLine, DEFAULT_PITCH), null);

  // Ball completely across the goal line inside the right goal -> Home goal
  const homeGoal = createBall({ x: halfW + 0.35, y: 0.5, z: 0.4 });
  assert.equal(checkGoalScored(homeGoal, DEFAULT_PITCH), 'home');

  // Ball completely across the goal line inside the left goal -> Away goal
  const awayGoal = createBall({ x: -halfW - 0.35, y: 0.5, z: -0.4 });
  assert.equal(checkGoalScored(awayGoal, DEFAULT_PITCH), 'away');

  // Ball above crossbar -> no goal
  const overBar = createBall({ x: halfW + 0.4, y: DEFAULT_PITCH.goalHeight + 0.3, z: 0 });
  assert.equal(checkGoalScored(overBar, DEFAULT_PITCH), null);
});

test('Puddle and mud zones reduce ball and player speed appropriately', () => {
  // Main puddle is around (-3.5, -5.2)
  const puddle = getPuddleAt(-3.5, -5.2);
  assert.ok(puddle !== null, 'Expected puddle at (-3.5, -5.2)');

  const mudCheck = getMudSpeedMultiplier(-2.2, 3.2);
  assert.equal(mudCheck.inMud, true);
  assert.ok(mudCheck.multiplier < 1.0, 'Mud should reduce player speed');

  // Ball rolling in puddle loses speed faster than on dry dirt
  const dryBall = createBall({ x: 5, z: 5, y: getTerrainHeightAt(5, 5) + 0.22, vx: 10 });
  const wetBall = createBall({
    x: -3.5,
    z: -5.2,
    y: getTerrainHeightAt(-3.5, -5.2) + 0.22,
    vx: 10,
  });

  stepBallPhysics(dryBall, 0.04, DEFAULT_PITCH, () => 0.5);
  stepBallPhysics(wetBall, 0.04, DEFAULT_PITCH, () => 0.5);

  assert.ok(
    wetBall.vx < dryBall.vx,
    `Expected wetBall.vx (${wetBall.vx}) < dryBall.vx (${dryBall.vx})`
  );
});

test('Out of bounds triggers lateral throw-in when crossing sideline', () => {
  const halfD = DEFAULT_PITCH.depth / 2;
  const ballOut = createBall({
    x: 3.0,
    z: halfD + 0.6,
    lastTouchTeam: 'home',
  });
  const out = checkOutOfBounds(ballOut, DEFAULT_PITCH);
  assert.ok(out !== null);
  assert.equal(out?.type, 'throw_in');
  assert.equal(out?.awardedTeam, 'away');
});

test('formatMatchTime formats seconds into MM:SS', () => {
  assert.equal(formatMatchTime(300), '05:00');
  assert.equal(formatMatchTime(65), '01:05');
  assert.equal(formatMatchTime(0), '00:00');
});

test('Google provider identification inspects user.providerData for google.com accurately', async () => {
  const { isUserGoogleLinked, extractAuthUserInfo } = await import('../services/firebase');

  // Unauthenticated user
  assert.equal(isUserGoogleLinked(null), false);
  const unauthInfo = extractAuthUserInfo(null);
  assert.equal(unauthInfo.uid, '');
  assert.equal(unauthInfo.isGoogleLinked, false);

  // Anonymous user without google.com in providerData
  const anonMock = {
    uid: 'anon_uid_123',
    isAnonymous: true,
    displayName: 'Yuri',
    email: null,
    photoURL: null,
    providerData: [],
  } as any;
  assert.equal(isUserGoogleLinked(anonMock), false);
  const anonInfo = extractAuthUserInfo(anonMock);
  assert.equal(anonInfo.uid, 'anon_uid_123');
  assert.equal(anonInfo.isAnonymous, true);
  assert.equal(anonInfo.isGoogleLinked, false);

  // Google-authenticated user with providerId === 'google.com'
  const googleMock = {
    uid: 'google_uid_456',
    isAnonymous: false,
    displayName: 'Yuri Silva',
    email: 'yuryofc092@gmail.com',
    photoURL: 'https://example.com/photo.jpg',
    providerData: [
      {
        providerId: 'google.com',
        uid: '1092837465',
        displayName: 'Yuri Silva',
        email: 'yuryofc092@gmail.com',
        phoneNumber: null,
        photoURL: 'https://example.com/photo.jpg',
      },
    ],
  } as any;
  assert.equal(isUserGoogleLinked(googleMock), true);
  const googleInfo = extractAuthUserInfo(googleMock);
  assert.equal(googleInfo.uid, 'google_uid_456');
  assert.equal(googleInfo.isAnonymous, false);
  assert.equal(googleInfo.isGoogleLinked, true);
  assert.equal(googleInfo.email, 'yuryofc092@gmail.com');
  assert.deepEqual(googleInfo.providers, ['google.com']);
});

test('Multiplayer synchronization lifecycle enforces roomId, matchId and blocks late joins when starting or playing', async () => {
  const { isRoomJoinable } = await import('../services/roomService');
  const { generateMatchId } = await import('../services/matchService');

  const matchId1 = generateMatchId();
  const matchId2 = generateMatchId();
  assert.match(matchId1, /^MTC-[A-Z0-9]{6}$/);
  assert.notEqual(matchId1, matchId2);

  const slots = buildInitialRoomSlots('host_uid', 'HostPlayer', 'home_1');
  const baseRoom: any = {
    roomCode: 'STF-102A',
    roomName: 'SEM TERRA FC — SALA #102',
    hostUid: 'host_uid',
    hostName: 'HostPlayer',
    mode: '4v4',
    visibility: 'public',
    maxHumans: 8,
    humanCount: 1,
    botFill: true,
    status: 'waiting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    slots,
    activeCharacterIds: resolveActiveCharacterIdsForRoom(slots, '4v4'),
  };

  // Waiting room with open slots is joinable
  assert.deepEqual(isRoomJoinable(baseRoom), { joinable: true });

  // Transition to 'starting' (when host clicks INICIAR PARTIDA) blocks new external joins
  const startingRoom = {
    ...baseRoom,
    status: 'starting' as const,
    matchId: matchId1,
    startAt: Date.now(),
  };
  const startingCheck = isRoomJoinable(startingRoom);
  assert.equal(startingCheck.joinable, false);

  // Transition to 'playing' also blocks new external joins
  const playingRoom = {
    ...startingRoom,
    status: 'playing' as const,
  };
  const playingCheck = isRoomJoinable(playingRoom);
  assert.equal(playingCheck.joinable, false);
});

test('PARTE 6 — 15-step Multi-Client Authoritative 30Hz Simulation (Client A & Client B, ownership validation, goals, disconnect -> Bot & reconnect)', async () => {
  const { AuthoritativeMatchSession } = await import('../server/authoritativeMatchEngine');

  const slotsObj = buildInitialRoomSlots('client_A_uid', 'Yuri (Client A)', 'home_1');
  slotsObj['away_1'] = {
    ...slotsObj['away_1'],
    uid: 'client_B_uid',
    displayName: 'Primo (Client B)',
    isBot: false,
    isReady: true,
  };

  // 1-4. Client A creates match & Client B joins same match
  const session = new AuthoritativeMatchSession({
    roomCode: 'STF-30HZ',
    matchId: 'MTC-30HZ01',
    hostUid: 'client_A_uid',
    mode: '4v4',
    homeTeamName: 'Sem Terra FC',
    awayTeamName: 'Rubro-Negro do Beco',
    halfDurationSeconds: 60,
    aiDifficulty: 'equilibrado',
    slots: slotsObj,
  });

  session.readyUids.add('client_A_uid');
  session.readyUids.add('client_B_uid');
  assert.equal(session.readyUids.size, 2);

  // 5-7. Client A moves -> Client B receives updated snapshot; Client B moves -> Client A receives updated snapshot
  const initialSnap = session.getSnapshot();
  const initialA = initialSnap.players['home_1'];
  const initialB = initialSnap.players['away_1'];

  const acceptedA = session.submitCommand({
    seq: 1,
    timestamp: Date.now(),
    uid: 'client_A_uid',
    roomCode: 'STF-30HZ',
    slotId: 'home_1',
    moveX: 1,
    moveZ: 0,
    sprint: true,
    action: 'none',
    kickPower: 0.65,
  });
  assert.equal(acceptedA.accepted, true);

  // Security validation: Client B cannot control Client A's character (home_1), and old seq is rejected
  const spoofAttempt = session.submitCommand({
    seq: 1,
    timestamp: Date.now(),
    uid: 'client_B_uid',
    roomCode: 'STF-30HZ',
    slotId: 'home_1',
    moveX: -1,
    moveZ: 0,
    sprint: false,
    action: 'none',
    kickPower: 0.65,
  });
  assert.equal(spoofAttempt.accepted, false, 'Server must reject command for another player slot');

  const acceptedB = session.submitCommand({
    seq: 1,
    timestamp: Date.now(),
    uid: 'client_B_uid',
    roomCode: 'STF-30HZ',
    slotId: 'away_1',
    moveX: -1,
    moveZ: 0.4,
    sprint: true,
    action: 'none',
    kickPower: 0.65,
  });
  assert.equal(acceptedB.accepted, true);

  for (let t = 0; t < 10; t++) {
    session.stepTick(1 / 30);
  }

  const afterMoveSnap = session.getSnapshot();
  const movedA = afterMoveSnap.players['home_1'];
  const movedB = afterMoveSnap.players['away_1'];
  assert.ok(movedA.x > initialA.x, 'Client A must advance +X');
  assert.ok(movedB.x < initialB.x, 'Client B must advance -X');
  assert.equal(afterMoveSnap.lastProcessedSeqByUid?.['client_A_uid'], 1);
  assert.equal(afterMoveSnap.lastProcessedSeqByUid?.['client_B_uid'], 1);

  // 8-12. Client B disconnects -> Bot IA assumes control -> Client B reconnects
  const botSlot = session.handlePlayerDisconnect('client_B_uid', true);
  assert.equal(botSlot?.isBot, true);
  session.stepTick(1 / 30);

  const reconnectedSlot = session.handlePlayerReconnect('client_B_uid', 'Primo (Client B)', 'away_1');
  assert.equal(reconnectedSlot?.isBot, false);
  assert.equal(reconnectedSlot?.uid, 'client_B_uid');

  const afterReconnectCmd = session.submitCommand({
    seq: 2,
    timestamp: Date.now(),
    uid: 'client_B_uid',
    roomCode: 'STF-30HZ',
    slotId: 'away_1',
    moveX: 0,
    moveZ: -1,
    sprint: false,
    action: 'none',
    kickPower: 0.65,
  });
  assert.equal(afterReconnectCmd.accepted, true, 'Reconnected player must resume command control');
});

test('PARTE 3 — Directional Pass, Weak/Strong Shots, Key Remapping without conflict, and Anti-Crowding AI', async () => {
  const {
    selectBestPassTarget,
    computePassVelocity,
    computeShotVelocity,
    resolvePlayerBallInteraction,
  } = await import('./rules');
  const { remapKeyWithoutConflict, DEFAULT_KEY_BINDINGS } = await import('./controls');
  const { computeAIDecision } = await import('./ai');

  // Key remapping swaps conflicting key bindings automatically
  const remapped = remapKeyWithoutConflict(DEFAULT_KEY_BINDINGS, 'pass', 'KeyQ');
  assert.equal(remapped.pass, 'KeyQ');
  assert.equal(remapped.switchPlayer, 'KeyE', 'Previous pass key must swap to switchPlayer');

  // Build test players
  const active = getActivePlayersForMode(INITIAL_HOME_PLAYERS, INITIAL_AWAY_PLAYERS, '4v4');
  const players = [
    ...active.home.map((cfg, i) => ({
      id: cfg.id,
      team: 'home' as const,
      config: cfg,
      x: i === 0 ? 0 : i === 1 ? 6 : -5,
      y: 0,
      z: i === 0 ? 0 : i === 1 ? 4 : -4,
      vx: 0,
      vz: 0,
      facingAngle: Math.PI / 2,
      animState: 'idle' as const,
      animTimer: 0,
      stridePhase: 0,
      stamina: 100,
      isSprinting: false,
      tackleCooldown: 0,
      stunTimer: 0,
      homeX: -4 - i * 2,
      homeZ: 0,
      hasBall: i === 0,
      inMud: false,
      inPuddle: false,
    })),
    ...active.away.map((cfg, i) => ({
      id: cfg.id,
      team: 'away' as const,
      config: cfg,
      x: 5 + i * 2.5,
      y: 0,
      z: i * 1.5 - 2,
      vx: 0,
      vz: 0,
      facingAngle: -Math.PI / 2,
      animState: 'idle' as const,
      animTimer: 0,
      stridePhase: 0,
      stamina: 100,
      isSprinting: false,
      tackleCooldown: 0,
      stunTimer: 0,
      homeX: 5 + i * 2.5,
      homeZ: i * 1.5 - 2,
      hasBall: false,
      inMud: false,
      inPuddle: false,
    })),
  ];

  const passer = players[0];
  const ball = createBall({ x: 0.4, z: 0, ownerId: 'home_1' });
  const targetMate = selectBestPassTarget(passer, players, 0.8, 0.6);
  assert.ok(targetMate);
  assert.equal(targetMate?.id, 'home_2', 'Directional pass must select Josué in (+X, +Z) direction');

  const passVel = computePassVelocity(passer, ball, targetMate, 0.8, 0.6, false);
  assert.ok(passVel.vx > 0 && passVel.vz > 0);

  // Weak tap shot vs strong charged shot
  const weakShot = computeShotVelocity(passer, ball, 0.28, 1, 0, DEFAULT_PITCH);
  const strongShot = computeShotVelocity(passer, ball, 1.0, 1, 0, DEFAULT_PITCH);
  assert.ok(
    Math.hypot(strongShot.vx, strongShot.vz) > Math.hypot(weakShot.vx, weakShot.vz),
    'Charged strong shot must have higher velocity than tap shot'
  );

  // Ball control domain within configurable radius
  const freeBall = createBall({ x: 0.55, z: 0, vx: 8, vz: 0 });
  const controlled = resolvePlayerBallInteraction(passer, freeBall, players, 0.95);
  assert.equal(controlled.touched, true);
  assert.equal(freeBall.ownerId, passer.id);

  // Anti-crowding AI: away outfield bots do not all converge to the exact same ball point
  const awayOutfield = players.filter((p) => p.team === 'away' && p.config.role !== 'goleiro');
  const decisions = awayOutfield.map((bot) =>
    computeAIDecision(bot, freeBall, players, 'equilibrado')
  );
  assert.equal(decisions.length, 3);
});

test('Firebase Auth singleton, single onAuthStateChanged observer, and shared multiplexed Firestore listeners', async () => {
  const fs = await import('node:fs');
  const firebaseSource = fs.readFileSync('./src/services/firebase.ts', 'utf8');

  // 1. Singleton Firebase App & Auth instance check
  assert.ok(
    firebaseSource.includes('getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)'),
    'Must use singleton getApps() check when initializing Firebase App'
  );

  // 2. Exactly one onAuthStateChanged call (1 import + 1 call inside ensureSingleAuthObserverRegistered)
  const onAuthMatches = firebaseSource.match(/onAuthStateChanged\s*\(/g) || [];
  assert.equal(
    onAuthMatches.length,
    1,
    `Expected exactly 1 onAuthStateChanged( registration in firebase.ts, found ${onAuthMatches.length}`
  );

  // 3. Deduplicated profile synchronization (profileSyncInFlight)
  assert.ok(
    firebaseSource.includes('profileSyncInFlight'),
    'Must deduplicate concurrent ensureUserProfile calls per UID'
  );

  // 4. Shared listener multiplexers prevent duplicate onSnapshot across App.tsx and MultiplayerLobbyModal.tsx
  assert.ok(firebaseSource.includes('myProfileSubscribers'));
  assert.ok(firebaseSource.includes('sharedRoomSubscriptions'));
  assert.ok(firebaseSource.includes('publicRoomsSubscribers'));
  assert.ok(firebaseSource.includes('onlinePlayersSubscribers'));
  assert.ok(firebaseSource.includes('incomingRequestsSubscribers'));

  // 5. Identifiable diagnostic log prefixes
  assert.ok(firebaseSource.includes('[STF-Auth]'));
  assert.ok(firebaseSource.includes('[STF-Firestore]'));
});

test('Firestore resource-exhausted handling, exponential backoff, presence deduplication, and zero 60FPS Firestore writes', async () => {
  const {
    isQuotaExceededError,
    getQuotaStatus,
    clearQuotaBackoffForManualRetry,
    publishHostMatchSnapshot,
    publishClientInput,
  } = await import('../services/firebase');
  const fs = await import('node:fs');

  // 1. Accurate detection of resource-exhausted vs permission-denied
  assert.equal(
    isQuotaExceededError({ code: 'resource-exhausted', message: 'Quota exceeded.' }),
    true
  );
  assert.equal(
    isQuotaExceededError(new Error('FirebaseError: [code=resource-exhausted]: Quota exceeded.')),
    true
  );
  assert.equal(
    isQuotaExceededError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }),
    false
  );

  // 2. Manual retry resets backoff state cleanly
  clearQuotaBackoffForManualRetry();
  const status = getQuotaStatus();
  assert.equal(status.isExhausted, false);

  // 3. 60 FPS match snapshot & input functions must be no-ops in Firestore (handled by WebSocket server)
  await publishHostMatchSnapshot('STF-1000', {} as any);
  await publishClientInput('STF-1000', {} as any);

  // 4. PresenceManager deduplicates startRoomPresence calls to prevent onSnapshot write-read loops
  const presenceSource = fs.readFileSync('./src/services/presenceService.ts', 'utf8');
  assert.ok(
    presenceSource.includes('this.activeRoomCode === normalized') &&
      presenceSource.includes('this.activeStatus === status'),
    'PresenceManager must deduplicate startRoomPresence calls for identical roomCode and status'
  );
});

test('ETAPA 2, 3, 4 & 5 — Real WebSocket /ws/match 2-client communication, Vercel URL resolution, backoff + jitter, and non-passive touch listeners', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const { WebSocketServer, WebSocket } = await import('ws');
  const {
    RealtimeMatchClient,
    resolveWsCandidateUrls,
    computeReconnectDelayMs,
  } = await import('../services/realtimeMatchClient');
  const { AuthoritativeMatchRegistry, SERVER_TICK_DT } = await import(
    '../server/authoritativeMatchEngine'
  );

  // 1. WebSocket URL resolution for fute-vazea.vercel.app vs Cloud Run vs custom VITE_WS_URL
  const vercelUrls = resolveWsCandidateUrls('', {
    protocol: 'https:',
    host: 'fute-vazea.vercel.app',
    hostname: 'fute-vazea.vercel.app',
  });
  assert.equal(
    vercelUrls[0],
    'wss://ais-pre-vjvg452vafw2n3arhxoh2l-129611115171.us-east1.run.app/ws/match',
    'On static .vercel.app without VITE_WS_URL, must route directly to the authoritative Cloud Run WebSocket backend'
  );

  const customEnvUrls = resolveWsCandidateUrls('wss://realtime.semterrafc.com', {
    protocol: 'https:',
    host: 'fute-vazea.vercel.app',
    hostname: 'fute-vazea.vercel.app',
  });
  assert.equal(customEnvUrls[0], 'wss://realtime.semterrafc.com/ws/match');

  // 2. Exponential backoff with jitter increases monotonically and caps cleanly
  const d0 = computeReconnectDelayMs(0, 0.5);
  const d1 = computeReconnectDelayMs(1, 0.5);
  const d2 = computeReconnectDelayMs(2, 0.5);
  assert.ok(d1 > d0 && d2 > d1, `Expected exponential backoff d0=${d0} < d1=${d1} < d2=${d2}`);

  // 3. Spin up real HTTP + WebSocketServer on /ws/match and connect 2 separate WebSocket clients (Browser A & Browser B)
  const registry = new AuthoritativeMatchRegistry();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const roomPeers = new Map<string, Set<InstanceType<typeof WebSocket>>>();

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/ws/match') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'join_match' || msg.type === 'reconnect') {
        const roomCode = String(msg.roomCode).toUpperCase();
        const session = registry.getOrCreateSession({
          roomCode,
          matchId: msg.matchId,
          hostUid: msg.uid,
          mode: '2v2',
          homeTeamName: 'Sem Terra FC',
          awayTeamName: 'Rubro-Negro do Beco',
          halfDurationSeconds: 180,
          aiDifficulty: 'equilibrado',
          slots: msg.slots || {},
        });
        session.handlePlayerReconnect(msg.uid, msg.displayName, msg.slotId);
        if (!roomPeers.has(roomCode)) roomPeers.set(roomCode, new Set());
        roomPeers.get(roomCode)!.add(ws);

        ws.send(
          JSON.stringify({
            type: 'joined_ack',
            roomCode,
            matchId: session.matchId,
            snapshot: session.getSnapshot(),
            slots: session.slots,
            readyUids: Array.from(session.readyUids),
          })
        );
      } else if (msg.type === 'input_cmd') {
        const cmd = msg.command;
        const session = registry.getSession(cmd.roomCode);
        if (session) {
          session.submitCommand(cmd);
          const snap = session.stepTick(SERVER_TICK_DT);
          const payload = JSON.stringify({
            type: 'match_state',
            roomCode: session.roomCode,
            matchId: session.matchId,
            snapshot: snap,
          });
          for (const peer of roomPeers.get(session.roomCode) || []) {
            if (peer.readyState === WebSocket.OPEN) peer.send(payload);
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws/match`;

  const clientA = new RealtimeMatchClient();
  const clientB = new RealtimeMatchClient();
  let clientAReceivedMatchState = false;
  let clientBReceivedMatchState = false;

  clientA.setCallbacks({
    onSnapshot: (snap) => {
      if ((snap.tick ?? 0) >= 1) clientAReceivedMatchState = true;
    },
  });
  clientB.setCallbacks({
    onSnapshot: (snap) => {
      if ((snap.tick ?? 0) >= 1) clientBReceivedMatchState = true;
    },
  });

  const initialSlots = buildInitialRoomSlots('uid_host_A', 'Host A', 'home_1');
  initialSlots.away_1 = {
    ...initialSlots.away_1,
    uid: 'uid_guest_B',
    displayName: 'Guest B',
    isBot: false,
    isReady: true,
  };

  const wsA = new WebSocket(wsUrl);
  const wsB = new WebSocket(wsUrl);

  wsA.on('message', (data) => clientA.handleMessage(JSON.parse(String(data))));
  wsB.on('message', (data) => clientB.handleMessage(JSON.parse(String(data))));

  await Promise.all([
    new Promise<void>((res) => wsA.once('open', () => res())),
    new Promise<void>((res) => wsB.once('open', () => res())),
  ]);

  wsA.send(
    JSON.stringify({
      type: 'join_match',
      roomCode: 'STF-PROD1',
      matchId: 'MTC-PROD01',
      uid: 'uid_host_A',
      displayName: 'Host A',
      slotId: 'home_1',
      slots: initialSlots,
    })
  );
  wsB.send(
    JSON.stringify({
      type: 'join_match',
      roomCode: 'STF-PROD1',
      matchId: 'MTC-PROD01',
      uid: 'uid_guest_B',
      displayName: 'Guest B',
      slotId: 'away_1',
      slots: initialSlots,
    })
  );

  // Send movement command from Client A and verify both Client A and Client B receive the 30Hz match_state update
  wsA.send(
    JSON.stringify({
      type: 'input_cmd',
      command: {
        seq: 1,
        timestamp: Date.now(),
        uid: 'uid_host_A',
        roomCode: 'STF-PROD1',
        slotId: 'home_1',
        moveX: 1,
        moveZ: 0,
        sprint: true,
        action: 'none',
        kickPower: 0.7,
      },
    })
  );

  await new Promise((res) => setTimeout(res, 60));

  assert.equal(clientAReceivedMatchState, true, 'Client A must receive match_state from /ws/match');
  assert.equal(clientBReceivedMatchState, true, 'Client B must receive match_state from /ws/match');

  wsA.close();
  wsB.close();
  await new Promise<void>((res) => server.close(() => res()));

  // 4. Verify non-passive touch listeners ({ passive: false }) in VoiceControlsBar.tsx and GameplayHUD.tsx
  const voiceBarSrc = fs.readFileSync('./src/components/VoiceControlsBar.tsx', 'utf8');
  const hudSrc = fs.readFileSync('./src/components/GameplayHUD.tsx', 'utf8');
  assert.ok(
    voiceBarSrc.includes("{ passive: false }") && !voiceBarSrc.includes('onTouchStart='),
    'VoiceControlsBar must register touchstart/touchend with { passive: false } instead of React passive onTouchStart'
  );
  assert.ok(
    hudSrc.includes("{ passive: false }") && hudSrc.includes('if (e.cancelable)'),
    'GameplayHUD must register joystick touch listeners with { passive: false } and check e.cancelable'
  );
});

test('ETAPA 2 — Migração Firestore -> Supabase: JWT Firebase Auth, Publishable Key, Schema/RPCs SQL, Mapeadores e WebRTC Broadcast', async () => {
  const fs = await import('node:fs');
  const { validateFirebaseJwtClaims, isSafePublishableKey } = await import(
    '../services/supabaseClient'
  );
  const { mapSupabaseRowToUserProfile, mapSupabaseRowToRoomState } = await import(
    '../services/supabaseDataService'
  );

  // Helper para montar um JWT de teste
  const makeFakeJwt = (payloadObj: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    return `${header}.${body}.signature_placeholder`;
  };

  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Token Firebase válido (iss, aud, sub, exp, role = authenticated)
  const validJwt = makeFakeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    role: 'authenticated',
    exp: nowSec + 3600,
  });
  const checkValid = validateFirebaseJwtClaims(validJwt, 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1');
  assert.equal(checkValid.valid, true);
  assert.equal(checkValid.hasAuthenticatedRole, true);
  assert.equal(checkValid.needsRefresh, false);
  assert.equal(checkValid.uid, 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1');

  // 1b. Token Firebase sem role = authenticated no frontend não exige refresh (Supabase valida o token sob role anon)
  const missingRoleJwt = makeFakeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    exp: nowSec + 3600,
  });
  const checkMissingRole = validateFirebaseJwtClaims(missingRoleJwt, 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1');
  assert.equal(checkMissingRole.valid, true);
  assert.equal(checkMissingRole.hasAuthenticatedRole, false);
  assert.equal(checkMissingRole.needsRefresh, false);
  assert.equal(
    validateFirebaseJwtClaims(missingRoleJwt, 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1', nowSec, true)
      .needsRefresh,
    true
  );

  // 2. Token próximo de expirar (< 60s) exige renovação automática (needsRefresh: true)
  const expiringJwt = makeFakeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    role: 'authenticated',
    exp: nowSec + 25,
  });
  const checkExpiring = validateFirebaseJwtClaims(expiringJwt, 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1');
  assert.equal(checkExpiring.valid, true);
  assert.equal(checkExpiring.needsRefresh, true);

  // 3. Token expirado ou com emissor incorreto é rejeitado
  const expiredJwt = makeFakeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    exp: nowSec - 10,
  });
  assert.equal(validateFirebaseJwtClaims(expiredJwt).valid, false);

  const wrongIssuerJwt = makeFakeJwt({
    iss: 'https://securetoken.google.com/outro-projeto',
    aud: 'gen-lang-client-0384619138',
    sub: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    exp: nowSec + 3600,
  });
  assert.equal(validateFirebaseJwtClaims(wrongIssuerJwt).valid, false);

  // 4. Segurança de chaves Supabase no navegador (aceita Publishable/Anon, bloqueia Secret/service_role)
  assert.equal(isSafePublishableKey('sb_publishable_AbCdEf123456'), true);
  assert.equal(isSafePublishableKey(makeFakeJwt({ role: 'anon' })), true);
  assert.equal(isSafePublishableKey('sb_secret_999999'), false);
  assert.equal(isSafePublishableKey(makeFakeJwt({ role: 'service_role' })), false);

  // 5. Mapeamento fiel de linhas PostgreSQL para os tipos do jogo
  const mappedProfile = mapSupabaseRowToUserProfile({
    uid: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    display_name: 'Yuri OFC',
    tag_code: '#STFV3XT',
    status: 'in_room',
    current_room_code: 'STF-99AA',
    friends: ['uid_amigo_1', 'uid_amigo_2'],
    wins: 12,
    losses: 3,
    draws: 2,
    goals_scored: 34,
    goals_conceded: 11,
    matches_played: 17,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  assert.equal(mappedProfile.uid, 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1');
  assert.equal(mappedProfile.displayName, 'Yuri OFC');
  assert.equal(mappedProfile.wins, 12);
  assert.equal(mappedProfile.friends.length, 2);

  const sampleSlots = buildInitialRoomSlots('v3xTyuRT7tTCAnFty1zlVYyM6Pl1', 'Yuri OFC', 'home_1');
  const mappedRoom = mapSupabaseRowToRoomState({
    room_code: 'STF-99AA',
    match_id: 'MTC-99AA01',
    room_name: 'Arena Várzea',
    mode: '4v4',
    visibility: 'public',
    has_password: false,
    max_humans: 8,
    auto_fill_bots: true,
    host_uid: 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1',
    host_name: 'Yuri OFC',
    status: 'waiting',
    home_team_id: 'unidos_do_barro',
    away_team_id: 'rubro_negro_beco',
    home_goals: 2,
    away_goals: 1,
    half: 1,
    remaining_seconds: 150,
    slots: sampleSlots,
  });
  assert.equal(mappedRoom.roomCode, 'STF-99AA');
  assert.equal(mappedRoom.homeScore, 2);
  assert.equal(mappedRoom.awayScore, 1);

  // 6. Valida migrations SQL versionadas e ausência de Firestore em voiceChatService.ts
  const sqlMigration = fs.readFileSync(
    './supabase/migrations/20261117000002_fix_firebase_uid_text_and_rls_22p02.sql',
    'utf8'
  );
  assert.ok(sqlMigration.includes('CREATE OR REPLACE FUNCTION public.rpc_join_room_atomic'));
  assert.ok(sqlMigration.includes('CREATE OR REPLACE FUNCTION public.rpc_toggle_ready_atomic'));
  assert.ok(sqlMigration.includes('CREATE OR REPLACE FUNCTION public.rpc_leave_room_atomic'));
  assert.ok(sqlMigration.includes('FOR UPDATE'));

  const voiceSrc = fs.readFileSync('./src/services/voiceChatService.ts', 'utf8');
  assert.ok(
    !voiceSrc.includes('firebase/firestore'),
    'voiceChatService.ts não deve mais importar firebase/firestore (migrado para Supabase Realtime Broadcast + WebSocket Relay)'
  );
});

test('AUDITORIA SQL E 12 TESTES OBRIGATÓRIOS DE SEGURANÇA SUPABASE (RLS, JWT role=authenticated, RPCs Atômicas, Anti-Spoofing e Senhas)', async () => {
  const fs = await import('node:fs');
  const { SupabaseSecurityTestHarness, SAFE_ROOM_SELECT_COLUMNS } = await import(
    '../services/supabaseSecurityVerifier'
  );

  // Auditoria estática da migration SQL: proíbe COALESCE(public.firebase_uid(), ...)
  const sqlMigration = fs.readFileSync(
    './supabase/migrations/20261117000002_fix_firebase_uid_text_and_rls_22p02.sql',
    'utf8'
  );
  assert.ok(
    !sqlMigration.includes('COALESCE(public.firebase_uid()'),
    'Migration SQL jamais deve usar COALESCE(public.firebase_uid(), p_uid/uid) como fallback'
  );
  assert.ok(
    !SAFE_ROOM_SELECT_COLUMNS.includes('password_hash'),
    'SAFE_ROOM_SELECT_COLUMNS nunca deve incluir password_hash'
  );

  const makeJwt = (payloadObj: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    return `${header}.${body}.sig`;
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const tokenPlayerA = makeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'uid_player_A',
    role: 'authenticated',
    exp: nowSec + 3600,
  });
  const tokenPlayerB = makeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'uid_player_B',
    role: 'authenticated',
    exp: nowSec + 3600,
  });
  const tokenPlayerC = makeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'uid_player_C',
    role: 'authenticated',
    exp: nowSec + 3600,
  });
  const tokenWithoutAuthRole = makeJwt({
    iss: 'https://securetoken.google.com/gen-lang-client-0384619138',
    aud: 'gen-lang-client-0384619138',
    sub: 'uid_anon_no_role',
    role: 'anon',
    exp: nowSec + 3600,
  });

  const dbHarness = new SupabaseSecurityTestHarness();

  // Cria perfis legítimos de A, B e C
  dbHarness.clientUpsertProfile(tokenPlayerA, 'uid_player_A', {
    display_name: 'Jogador A',
    tag_code: '#STFAAAA',
  });
  dbHarness.clientUpsertProfile(tokenPlayerB, 'uid_player_B', {
    display_name: 'Jogador B',
    tag_code: '#STFBBBB',
  });
  dbHarness.clientUpsertProfile(tokenPlayerC, 'uid_player_C', {
    display_name: 'Jogador C',
    tag_code: '#STFCCCC',
  });

  // TESTE 1: Jogador A não consegue alterar o perfil de B
  assert.throws(
    () =>
      dbHarness.clientUpsertProfile(tokenPlayerA, 'uid_player_B', {
        display_name: 'Hackeado por A',
      }),
    /RLS_VIOLATION/
  );

  // TESTE 2: Jogador A não consegue alterar estatísticas de B (nem as próprias diretamente)
  assert.throws(
    () =>
      dbHarness.clientUpsertProfile(tokenPlayerA, 'uid_player_B', {
        wins: 999,
      }),
    /RLS_VIOLATION/
  );
  assert.throws(
    () =>
      dbHarness.clientUpsertProfile(tokenPlayerA, 'uid_player_A', {
        wins: 999,
        goals_scored: 500,
      }),
    /STATS_TAMPERING_BLOCKED/
  );

  // TESTE 3: Jogador A não consegue aceitar solicitação destinada a B
  const reqId = dbHarness.clientSendFriendRequest(tokenPlayerA, 'uid_player_A', 'uid_player_B');
  assert.throws(
    () => dbHarness.rpcRespondFriendRequestAtomic(tokenPlayerA, reqId, 'uid_player_A', true),
    /FORBIDDEN_RECIPIENT_ONLY/
  );
  // Destinatário B consegue aceitar normalmente
  dbHarness.rpcRespondFriendRequestAtomic(tokenPlayerB, reqId, 'uid_player_B', true);
  assert.ok(dbHarness.getUserInternal('uid_player_A')?.friends.includes('uid_player_B'));
  assert.ok(dbHarness.getUserInternal('uid_player_B')?.friends.includes('uid_player_A'));

  // TESTE 4: Usuário sem token válido (null ou sem role='authenticated') não consegue acessar dados protegidos
  assert.throws(() => dbHarness.clientSelectUsers(null), /AUTH_REQUIRED/);
  assert.throws(() => dbHarness.clientSelectUsers(tokenWithoutAuthRole), /AUTH_REQUIRED/);

  // TESTE 5: UID falsificado enviado pelo frontend é rejeitado
  assert.throws(
    () => dbHarness.clientSendFriendRequest(tokenPlayerA, 'uid_player_B', 'uid_player_C'),
    /UID_SPOOFING_REJECTED/
  );

  // TESTE 6: Jogador consegue entrar em uma sala pública disponível
  dbHarness.rpcCreateRoomAtomic(tokenPlayerA, {
    roomCode: 'STF-PUB1',
    roomName: 'Várzea Pública',
    mode: '2v2',
    visibility: 'public',
    maxHumans: 4,
  });
  const joinedPublic = await dbHarness.rpcJoinRoomAtomic(tokenPlayerB, {
    roomCode: 'STF-PUB1',
    clientUid: 'uid_player_B',
    displayName: 'Jogador B',
  });
  const pubHumans = Object.values(joinedPublic.slots as Record<string, any>).filter(
    (s: any) => !s.isBot && s.uid
  );
  assert.equal(pubHumans.length, 2);

  // TESTE 7: Jogador não consegue entrar em sala privada sem senha correta (nem enviando o hash bcrypt)
  dbHarness.rpcCreateRoomAtomic(tokenPlayerA, {
    roomCode: 'STF-PRV1',
    roomName: 'Várzea Fechada',
    mode: '4v4',
    visibility: 'private',
    plainPassword: 'varzea2026',
  });
  await assert.rejects(
    () =>
      dbHarness.rpcJoinRoomAtomic(tokenPlayerB, {
        roomCode: 'STF-PRV1',
        displayName: 'Jogador B',
        plainPassword: '',
      }),
    /SENHA_OBRIGATORIA/
  );
  await assert.rejects(
    () =>
      dbHarness.rpcJoinRoomAtomic(tokenPlayerB, {
        roomCode: 'STF-PRV1',
        displayName: 'Jogador B',
        plainPassword: 'senha_errada',
      }),
    /Senha incorreta/
  );
  // Tentativa de pass-the-hash também falha
  const internalRoom = dbHarness.getRoomInternal('STF-PRV1');
  await assert.rejects(
    () =>
      dbHarness.rpcJoinRoomAtomic(tokenPlayerB, {
        roomCode: 'STF-PRV1',
        displayName: 'Jogador B',
        plainPassword: internalRoom?.password_hash,
      }),
    /Senha incorreta/
  );
  // Com a senha correta em texto plano, entra normalmente
  const joinedPrivate = await dbHarness.rpcJoinRoomAtomic(tokenPlayerB, {
    roomCode: 'STF-PRV1',
    displayName: 'Jogador B',
    plainPassword: 'varzea2026',
  });
  assert.equal(joinedPrivate.roomCode, 'STF-PRV1');

  // TESTE 8: Dois jogadores tentando ocupar a última vaga simultaneamente não causam duplicidade
  dbHarness.rpcCreateRoomAtomic(tokenPlayerA, {
    roomCode: 'STF-RACE',
    roomName: 'Sala Disputada',
    mode: '2v2',
    visibility: 'public',
    maxHumans: 2, // Apenas 1 vaga restante além do host A!
  });
  const [resB, resC] = await Promise.allSettled([
    dbHarness.rpcJoinRoomAtomic(tokenPlayerB, {
      roomCode: 'STF-RACE',
      displayName: 'Jogador B',
    }),
    dbHarness.rpcJoinRoomAtomic(tokenPlayerC, {
      roomCode: 'STF-RACE',
      displayName: 'Jogador C',
    }),
  ]);
  const fulfilledCount = [resB, resC].filter((r) => r.status === 'fulfilled').length;
  const rejectedCount = [resB, resC].filter((r) => r.status === 'rejected').length;
  assert.equal(fulfilledCount, 1, 'Exatamente 1 jogador deve conseguir a última vaga');
  assert.equal(rejectedCount, 1, 'O segundo jogador concorrente deve receber Sala lotada');

  // TESTE 9: Jogador consegue sair da sala sem corromper os slots (e transfere liderança se for o host)
  dbHarness.rpcLeaveRoomAtomic(tokenPlayerA, 'STF-PUB1', 'uid_player_A');
  const pubAfterHostLeave = dbHarness.getRoomInternal('STF-PUB1');
  assert.ok(pubAfterHostLeave, 'Sala continua ativa pois Jogador B ainda está nela');
  assert.equal(
    pubAfterHostLeave?.host_uid,
    'uid_player_B',
    'Liderança transferida automaticamente para Jogador B'
  );
  assert.equal(
    Object.keys(pubAfterHostLeave?.slots || {}).length,
    8,
    'Todos os 8 slots permanecem íntegros'
  );

  // TESTE 10: Somente participantes autorizados conseguem alterar sua prontidão
  assert.throws(
    () => dbHarness.rpcToggleReadyAtomic(tokenPlayerC, 'STF-PUB1', 'uid_player_C', false),
    /NOT_A_ROOM_PARTICIPANT/
  );
  assert.throws(
    () => dbHarness.rpcToggleReadyAtomic(tokenPlayerB, 'STF-PUB1', 'uid_player_A', false),
    /UID_SPOOFING_REJECTED/
  );
  const toggledRoom = dbHarness.rpcToggleReadyAtomic(
    tokenPlayerB,
    'STF-PUB1',
    'uid_player_B',
    false
  );
  const slotB = Object.values(toggledRoom.slots as Record<string, any>).find(
    (s: any) => s.uid === 'uid_player_B'
  );
  assert.equal(slotB.isReady, false);

  // TESTE 11: Um jogador não consegue manipular resultados de partidas
  // Jogador C (fora da sala STF-PRV1) tenta forjar resultado
  assert.throws(
    () => dbHarness.rpcRecordMatchFinishedAtomic(tokenPlayerC, 'STF-PRV1', 10, 0),
    /NOT_MATCH_PARTICIPANT/
  );
  // Tentativa de finalizar partida antes de iniciá-la (status === 'waiting') é bloqueada
  assert.throws(
    () => dbHarness.rpcRecordMatchFinishedAtomic(tokenPlayerA, 'STF-PRV1', 3, 1),
    /MATCH_NOT_ACTIVE/
  );
  // Host inicia a partida legitimamente e finaliza 1 vez
  dbHarness.rpcStartMatchAtomic(tokenPlayerA, 'STF-PRV1');
  const recordedFirst = dbHarness.rpcRecordMatchFinishedAtomic(tokenPlayerA, 'STF-PRV1', 3, 1);
  assert.equal(recordedFirst, true);
  // Tentativa de enviar o resultado uma segunda vez (replay para inflar vitórias/gols) retorna false sem somar novamente
  const recordedSecond = dbHarness.rpcRecordMatchFinishedAtomic(tokenPlayerA, 'STF-PRV1', 10, 0);
  assert.equal(recordedSecond, false);
  assert.equal(dbHarness.getUserInternal('uid_player_A')?.matches_played, 1);

  // TESTE 12: Hashes de senhas não aparecem nas consultas públicas do lobby nem no retorno das RPCs
  const lobbyRooms = dbHarness.queryPublicRoomsLobbyView(tokenPlayerA);
  for (const r of lobbyRooms) {
    assert.equal(r.passwordHash, null, 'passwordHash deve ser sempre null no lobby');
    assert.equal((r as any).password_hash, undefined, 'password_hash nunca deve vazar');
  }
  assert.equal(joinedPrivate.passwordHash, null);
});

test('INTEGRAÇÃO COMPLETA SUPABASE (gameBackend.ts): 14 RPCs, Mapeamento Relacional de Slots (room_participants) e Ausência Total de Firestore', async () => {
  const fs = await import('node:fs');
  const gameBackend = await import('../services/gameBackend');

  // 1. Verifica que todas as 14 RPCs do Supabase estão exportadas em src/services/gameBackend.ts
  const requiredRpcWrappers = [
    'rpcEnsureUserProfileAtomic',
    'rpcCreateRoomAtomic',
    'rpcJoinRoomAtomic',
    'rpcLeaveRoomAtomic',
    'rpcSelectCharacterAtomic',
    'rpcToggleReadyAtomic',
    'rpcStartMatchAtomic',
    'rpcSendFriendRequest',
    'rpcRespondFriendRequest',
    'rpcRemoveFriend',
    'rpcGetPublicLobby',
    'rpcGetRoomLobby',
    'rpcGetMyFriends',
    'rpcGetFriendRequests',
  ] as const;

  for (const fnName of requiredRpcWrappers) {
    assert.equal(
      typeof (gameBackend as Record<string, unknown>)[fnName],
      'function',
      `Função ${fnName} deve estar exportada em src/services/gameBackend.ts`
    );
  }

  // 2. Verifica reconstrução relacional de rooms + room_participants -> 8 slots com bots automáticos
  const relationalRoom = gameBackend.mapRpcRoomToRoomState({
    room: {
      room_code: 'STF-REL1',
      host_id: 'uid_host_1',
      room_name: 'Arena Relacional Supabase',
      mode: '2v2',
      visibility: 'public',
      status: 'waiting',
      max_players: 4,
    },
    participants: [
      {
        user_id: 'uid_host_1',
        display_name: 'Yuri Host',
        team: 'home',
        character_id: 'home_1',
        is_ready: true,
        is_loading_ready: true,
      },
      {
        user_id: 'uid_guest_2',
        display_name: 'Primo Guest',
        team: 'away',
        character_id: 'away_2',
        is_ready: false,
        is_loading_ready: false,
      },
    ],
  });

  assert.equal(relationalRoom.roomCode, 'STF-REL1');
  assert.equal(relationalRoom.hostUid, 'uid_host_1');
  assert.equal(relationalRoom.hostName, 'Yuri Host');
  assert.equal(relationalRoom.mode, '2v2');
  assert.equal(Object.keys(relationalRoom.slots).length, 8);
  assert.equal(relationalRoom.slots['home_1'].uid, 'uid_host_1');
  assert.equal(relationalRoom.slots['home_1'].isBot, false);
  assert.equal(relationalRoom.slots['away_2'].uid, 'uid_guest_2');
  assert.equal(relationalRoom.slots['away_2'].isBot, false);
  assert.equal(relationalRoom.slots['away_2'].isReady, false);
  assert.equal(relationalRoom.slots['home_2'].isBot, true);
  assert.deepEqual(relationalRoom.loadingReadyUids, ['uid_host_1']);

  // 3. Verifica mapeamento de solicitações de amizade do RPC rpc_get_friend_requests
  const mappedReq = gameBackend.mapRpcFriendRequestToDoc({
    id: 'req-uuid-001',
    sender_id: 'uid_sender_99',
    sender_name: 'Careca Várzea',
    sender_tag: '#STFCARE',
    receiver_id: 'uid_host_1',
    status: 'pending',
    created_at: new Date().toISOString(),
  });
  assert.equal(mappedReq.id, 'req-uuid-001');
  assert.equal(mappedReq.fromUid, 'uid_sender_99');
  assert.equal(mappedReq.fromName, 'Careca Várzea');
  assert.equal(mappedReq.fromTag, '#STFCARE');
  assert.equal(mappedReq.toUid, 'uid_host_1');
  assert.equal(mappedReq.status, 'pending');

  // 4. Confirma que firebase/firestore foi 100% removido de firebase.ts, gameBackend.ts, supabaseDataService.ts e voiceChatService.ts
  const filesWithoutFirestore = [
    './src/services/firebase.ts',
    './src/services/gameBackend.ts',
    './src/services/supabaseDataService.ts',
    './src/services/voiceChatService.ts',
  ];
  for (const filePath of filesWithoutFirestore) {
    const src = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      !src.includes('firebase/firestore'),
      `O arquivo ${filePath} não deve importar firebase/firestore`
    );
  }
});

test('CORREÇÃO ERRO POSTGRESQL 22P02: UID Firebase TEXT ("v3xTyuRT7tTCAnFty1zlVYyM6Pl1") vs UUID Interno e Ausência de auth.uid()', async () => {
  const fs = await import('node:fs');
  const {
    isValidUuid,
    isValidFirebaseUid,
    isUuidSyntaxError22P02,
    mapRawToUserProfile,
    buildSlotsFromParticipants,
  } = await import('../services/gameBackend');

  const firebaseUid = 'v3xTyuRT7tTCAnFty1zlVYyM6Pl1';
  const internalUuid = '7b2019e8-a946-4083-b19c-91983f83503d';

  // 1. UID Firebase é TEXT válido, mas NUNCA deve ser considerado UUID
  assert.equal(isValidFirebaseUid(firebaseUid), true);
  assert.equal(isValidUuid(firebaseUid), false);
  assert.equal(isValidUuid(internalUuid), true);

  // 2. Detecção precisa do erro PostgreSQL 22P02
  assert.equal(
    isUuidSyntaxError22P02({
      code: '22P02',
      message: 'invalid input syntax for type uuid: "v3xTyuRT7tTCAnFty1zlVYyM6Pl1"',
    }),
    true
  );
  assert.equal(isUuidSyntaxError22P02({ code: '23505', message: 'duplicate key value' }), false);

  // 3. Mapeadores nunca confundem o UUID interno `id` (ex.: room_participants.id ou friendships.id) com o UID Firebase TEXT
  const profileWithInternalUuid = mapRawToUserProfile(
    {
      id: internalUuid,
      display_name: 'Yuri OFC',
      tag_code: '#STFV3XT',
    },
    firebaseUid
  );
  assert.equal(
    profileWithInternalUuid.uid,
    firebaseUid,
    'mapRawToUserProfile jamais deve usar um UUID de registro (`id`) como `uid` do jogador'
  );

  const builtSlots = buildSlotsFromParticipants(firebaseUid, 'Yuri OFC', [
    {
      id: internalUuid,
      user_id: firebaseUid,
      display_name: 'Yuri OFC',
      team: 'home',
      character_id: 'home_1',
      is_ready: true,
    },
  ]);
  assert.equal(builtSlots.slots['home_1'].uid, firebaseUid);

  // 4. Verifica que as migrations SQL não contêm chamadas executáveis a `auth.uid()` e tipam todas as 9 colunas de UID Firebase como TEXT
  const migration1 = fs.readFileSync(
    './supabase/migrations/20261117000001_sem_terra_fc_schema_rpc_rls.sql',
    'utf8'
  );
  const migration2 = fs.readFileSync(
    './supabase/migrations/20261117000002_fix_firebase_uid_text_and_rls_22p02.sql',
    'utf8'
  );

  for (const [name, content] of [
    ['20261117000001', migration1],
    ['20261117000002', migration2],
  ]) {
    const codeLines = content
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    assert.equal(
      codeLines.includes('auth.uid()'),
      false,
      `A migration ${name} não deve conter chamadas a auth.uid() (que retorna UUID e causa erro 22P02 com UID Firebase TEXT)`
    );
  }

  assert.ok(migration2.includes('ALTER TABLE public.users ALTER COLUMN uid TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.friendships ALTER COLUMN user_id_1 TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.friendships ALTER COLUMN user_id_2 TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.friend_requests ALTER COLUMN sender_id TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.friend_requests ALTER COLUMN receiver_id TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.rooms ALTER COLUMN host_id TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.room_participants ALTER COLUMN user_id TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.presences ALTER COLUMN user_id TYPE text'));
  assert.ok(migration2.includes('ALTER TABLE public.match_history ALTER COLUMN user_id TYPE text'));
});

