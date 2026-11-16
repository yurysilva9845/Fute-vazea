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
