import {
  BallState,
  PitchDimensions,
  PlayerRuntimeState,
} from '../types/game';
import { DEFAULT_PITCH } from './rules';

export interface AIDecision {
  moveX: number; // -1 to 1
  moveZ: number; // -1 to 1
  sprint: boolean;
  action: 'none' | 'pass' | 'shoot' | 'tackle' | 'clear';
  targetX?: number;
  targetZ?: number;
}

/**
 * Computes tactical 4v4 Várzea AI decisions for non-controlled teammates and AI opponents.
 * Implements distinct role policies:
 * 1. Goleiro (Goalkeeper): Automatic positioning on goal arc, shot blocking, distribution.
 * 2. Fixo (Defender): Marks opponents, protects the defensive half, intercepts and tackles.
 * 3. Ala (Winger/Midfielder): Supports ball carrier, offers passing lanes, transitions fast.
 * 4. Pivô (Striker): Attacks goal space, dribbles toward the small várzea goal, shoots when open.
 */
export function computeAIDecision(
  player: PlayerRuntimeState,
  ball: BallState,
  allPlayers: PlayerRuntimeState[],
  difficulty: 'raiz' | 'equilibrado' | 'lenda',
  pitch: PitchDimensions = DEFAULT_PITCH
): AIDecision {
  if (player.stunTimer > 0) {
    return { moveX: 0, moveZ: 0, sprint: false, action: 'none' };
  }

  const isHome = player.team === 'home';
  const attackDirX = isHome ? 1 : -1;
  const ownGoalX = isHome ? -pitch.width / 2 + 0.9 : pitch.width / 2 - 0.9;
  const enemyGoalX = isHome ? pitch.width / 2 : -pitch.width / 2;

  const diffMult =
    difficulty === 'lenda' ? 1.12 : difficulty === 'equilibrado' ? 1.0 : 0.86;

  const dxBall = ball.x - player.x;
  const dzBall = ball.z - player.z;
  const distToBall = Math.hypot(dxBall, dzBall);

  // 1. AUTOMATIC GOALKEEPER LOGIC ("Goleiro com comportamento automático")
  if (player.config.role === 'goleiro') {
    if (player.hasBall) {
      // Find best open teammate to pass to
      const teammates = allPlayers.filter(
        (p) => p.team === player.team && p.id !== player.id
      );
      let bestMate = teammates[0];
      let bestScore = -Infinity;
      for (const mate of teammates) {
        const forwardScore = mate.x * attackDirX;
        if (forwardScore > bestScore) {
          bestScore = forwardScore;
          bestMate = mate;
        }
      }
      return {
        moveX: attackDirX * 0.4,
        moveZ: 0,
        sprint: false,
        action: 'pass',
        targetX: bestMate ? bestMate.x + attackDirX * 2.5 : 0,
        targetZ: bestMate ? bestMate.z : 0,
      };
    }

    // Track ball Z within the small várzea goal mouth
    const maxGoalZ = pitch.goalWidth * 0.44;
    const clampedZ = Math.max(-maxGoalZ, Math.min(maxGoalZ, ball.z * 0.65));
    let targetX = ownGoalX + attackDirX * 0.45;
    let targetZ = clampedZ;

    // If ball is loose inside the small goal area, rush out to claim/clear it
    const ballDistToOwnGoal = Math.abs(ball.x - ownGoalX);
    if (ballDistToOwnGoal < 4.6 && Math.abs(ball.z) < 4.2) {
      targetX = ball.x;
      targetZ = ball.z;
    }

    const gx = targetX - player.x;
    const gz = targetZ - player.z;
    const gDist = Math.hypot(gx, gz);
    if (gDist < 0.18) {
      return { moveX: 0, moveZ: 0, sprint: false, action: 'none' };
    }
    return {
      moveX: (gx / gDist) * diffMult,
      moveZ: (gz / gDist) * diffMult,
      sprint: ballDistToOwnGoal < 6.0,
      action: distToBall < 0.95 && ballDistToOwnGoal < 4.5 ? 'clear' : 'none',
      targetX: 0,
      targetZ: (Math.random() - 0.5) * 8,
    };
  }

  // 2. WHEN THIS AI PLAYER HAS THE BALL
  if (player.hasBall) {
    const distToEnemyGoal = Math.hypot(enemyGoalX - player.x, 0 - player.z);

    // Shoot if within shooting range and good angle
    const shootRange = player.config.role === 'pivo' ? 11.5 : 9.5;
    if (distToEnemyGoal < shootRange && Math.abs(player.z) < 6.5) {
      const aimZ = (Math.random() - 0.5) * (pitch.goalWidth * 0.68);
      return {
        moveX: attackDirX,
        moveZ: 0,
        sprint: true,
        action: 'shoot',
        targetX: enemyGoalX,
        targetZ: aimZ,
      };
    }

    // Check if closely pressured by an opponent -> pass to open teammate
    const opponents = allPlayers.filter((p) => p.team !== player.team);
    let closestOppDist = Infinity;
    for (const opp of opponents) {
      const d = Math.hypot(opp.x - player.x, opp.z - player.z);
      if (d < closestOppDist) closestOppDist = d;
    }

    if (closestOppDist < 2.2) {
      const teammates = allPlayers.filter(
        (p) => p.team === player.team && p.id !== player.id && p.config.role !== 'goleiro'
      );
      for (const mate of teammates) {
        // Prefer passing forward or to an unmarked teammate
        if ((mate.x - player.x) * attackDirX > -1.5) {
          return {
            moveX: attackDirX,
            moveZ: 0,
            sprint: false,
            action: 'pass',
            targetX: mate.x + attackDirX * 1.5,
            targetZ: mate.z,
          };
        }
      }
    }

    // Otherwise dribble toward the opponent's small goal, weaving slightly around defenders
    const goalDirX = enemyGoalX - player.x;
    const goalDirZ = -player.z * 0.45;
    const norm = Math.hypot(goalDirX, goalDirZ) || 1;
    return {
      moveX: (goalDirX / norm) * diffMult,
      moveZ: (goalDirZ / norm) * diffMult,
      sprint: player.stamina > 30,
      action: 'none',
    };
  }

  // 3. WHEN THIS AI PLAYER DOES NOT HAVE THE BALL
  // Determine if this player is the closest outfield player on their team to the ball
  const outfieldMates = allPlayers.filter(
    (p) => p.team === player.team && p.config.role !== 'goleiro'
  );
  let closestMateToBall: PlayerRuntimeState | null = null;
  let minMateDist = Infinity;
  for (const m of outfieldMates) {
    const d = Math.hypot(ball.x - m.x, ball.z - m.z);
    if (d < minMateDist) {
      minMateDist = d;
      closestMateToBall = m;
    }
  }

  const teamHasBall = ball.lastTouchTeam === player.team && ball.ownerId !== null;

  // Chaser policy: closest player on defending team (or loose ball) presses the ball
  if (!teamHasBall && closestMateToBall?.id === player.id) {
    const norm = distToBall || 1;
    const shouldTackle =
      distToBall > 0.9 &&
      distToBall < 1.85 &&
      ball.ownerId !== null &&
      player.tackleCooldown <= 0 &&
      Math.random() < (difficulty === 'lenda' ? 0.14 : 0.07);

    return {
      moveX: (dxBall / norm) * diffMult,
      moveZ: (dzBall / norm) * diffMult,
      sprint: distToBall > 2.5 && player.stamina > 25,
      action: shouldTackle ? 'tackle' : 'none',
    };
  }

  // Tactical positioning based on distinct Role Archetype (Fixo, Ala, Pivô)
  let targetX = player.homeX;
  let targetZ = player.homeZ;

  if (player.config.role === 'fixo') {
    // Defender: stays between the ball and own goal, marking the opponent's forward
    targetX = ownGoalX + attackDirX * 7.5 + ball.x * 0.28;
    targetZ = ball.z * 0.55;
  } else if (player.config.role === 'ala') {
    // Winger/Midfielder: shifts dynamically with ball X and stays wide for passing lanes
    targetX = ball.x + (teamHasBall ? attackDirX * 3.5 : -attackDirX * 2.5);
    targetZ = player.homeZ * 0.75 + ball.z * 0.25;
  } else if (player.config.role === 'pivo') {
    // Striker: pushes up toward opponent goal box looking for through-balls
    targetX = teamHasBall
      ? enemyGoalX - attackDirX * 5.2
      : ball.x * 0.4 + attackDirX * 3.5;
    targetZ = -ball.z * 0.35;
  }

  // Clamp inside pitch bounds
  const halfW = pitch.width / 2 - 1.2;
  const halfD = pitch.depth / 2 - 1.2;
  targetX = Math.max(-halfW, Math.min(halfW, targetX));
  targetZ = Math.max(-halfD, Math.min(halfD, targetZ));

  const tx = targetX - player.x;
  const tz = targetZ - player.z;
  const tDist = Math.hypot(tx, tz);

  if (tDist < 0.45) {
    return { moveX: 0, moveZ: 0, sprint: false, action: 'none' };
  }

  return {
    moveX: (tx / tDist) * 0.85 * diffMult,
    moveZ: (tz / tDist) * 0.85 * diffMult,
    sprint: tDist > 6.5 && player.stamina > 45,
    action: 'none',
  };
}

/**
 * Finds the best teammate to switch control to when pressing Q or the mobile Switch button.
 */
export function findBestSwitchTeammate(
  currentControlledId: string,
  ball: BallState,
  players: PlayerRuntimeState[]
): string {
  const candidates = players.filter(
    (p) =>
      p.team === 'home' &&
      p.id !== currentControlledId &&
      p.config.role !== 'goleiro'
  );
  if (candidates.length === 0) return currentControlledId;

  candidates.sort((a, b) => {
    const da = Math.hypot(ball.x - a.x, ball.z - a.z);
    const db = Math.hypot(ball.x - b.x, ball.z - b.z);
    return da - db;
  });

  return candidates[0].id;
}
