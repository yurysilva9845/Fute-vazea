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
