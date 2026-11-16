import {
  BallState,
  PitchDimensions,
  PlayerRuntimeState,
} from '../types/game';
import { DEFAULT_PITCH, selectBestPassTarget } from './rules';

export interface AIDecision {
  moveX: number; // -1 to 1
  moveZ: number; // -1 to 1
  sprint: boolean;
  action: 'none' | 'pass' | 'shoot' | 'tackle' | 'clear';
  targetX?: number;
  targetZ?: number;
  kickPower?: number;
}

/**
 * Inteligência Artificial Tática para Futebol de Várzea (2v2 e 4v4).
 * Comportamentos distintos por posição:
 * 1. Goleiro: Protege a travinha, fecha o ângulo, intercepta bolas na área e distribui rápido.
 * 2. Fixo (Defensor): Protege o meio defensivo, marca o atacante rival e evita deixar o goleiro no mano a mano.
 * 3. Ala (Meia/Lateral): Abre linhas de passe pelas laterais, apoia o ataque e recompõe na defesa.
 * 4. Pivô (Atacante): Procura espaços vazios na frente, tabela e finaliza com equilíbrio.
 *
 * Regra anti-tumulto: apenas 1 jogador de linha por equipe pressiona diretamente o portador da bola;
 * os demais ocupam espaços táticos e linhas de passe.
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

  // Dificuldade equilibrada: sem roubos instantâneos nem precisão robótica
  const diffSpeedMult =
    difficulty === 'lenda' ? 1.04 : difficulty === 'equilibrado' ? 0.95 : 0.84;
  const aimDispersion =
    difficulty === 'lenda' ? 0.45 : difficulty === 'equilibrado' ? 0.78 : 1.15;

  const dxBall = ball.x - player.x;
  const dzBall = ball.z - player.z;
  const distToBall = Math.hypot(dxBall, dzBall);

  // 1. COMPORTAMENTO DIFERENCIADO DE GOLEIRO
  if (player.config.role === 'goleiro') {
    if (player.hasBall) {
      const bestMate = selectBestPassTarget(player, allPlayers, attackDirX, 0);
      return {
        moveX: attackDirX * 0.35,
        moveZ: 0,
        sprint: false,
        action: 'pass',
        targetX: bestMate ? bestMate.x + attackDirX * 1.8 : 0,
        targetZ: bestMate ? bestMate.z : 0,
        kickPower: 0.62,
      };
    }

    // Posiciona no arco da travinha acompanhando o eixo Z da bola
    const maxGoalZ = pitch.goalWidth * 0.46;
    const predictedBallZ = ball.z + ball.vz * 0.18;
    const clampedZ = Math.max(-maxGoalZ, Math.min(maxGoalZ, predictedBallZ * 0.72));
    let targetX = ownGoalX + attackDirX * 0.55;
    let targetZ = clampedZ;

    // Sai nos pés apenas quando a bola está solta muito perto da pequena área
    const ballDistToOwnGoal = Math.abs(ball.x - ownGoalX);
    if (ballDistToOwnGoal < 4.2 && Math.abs(ball.z) < 3.6 && !ball.ownerId) {
      targetX = ball.x;
      targetZ = ball.z;
    }

    const gx = targetX - player.x;
    const gz = targetZ - player.z;
    const gDist = Math.hypot(gx, gz);
    if (gDist < 0.16) {
      return { moveX: 0, moveZ: 0, sprint: false, action: 'none' };
    }
    return {
      moveX: (gx / gDist) * diffSpeedMult,
      moveZ: (gz / gDist) * diffSpeedMult,
      sprint: ballDistToOwnGoal < 5.5,
      action: distToBall < 0.92 && ballDistToOwnGoal < 4.2 ? 'clear' : 'none',
      targetX: 0,
      targetZ: (Math.random() - 0.5) * 6,
      kickPower: 0.72,
    };
  }

  // 2. QUANDO ESTE BOT ESTÁ COM A BOLA (ATAQUE, PASSE E FINALIZAÇÃO)
  if (player.hasBall) {
    const distToEnemyGoal = Math.hypot(enemyGoalX - player.x, 0 - player.z);
    const opponents = allPlayers.filter((p) => p.team !== player.team);

    let closestOppDist = Infinity;
    let closestOpp: PlayerRuntimeState | null = null;
    for (const opp of opponents) {
      const d = Math.hypot(opp.x - player.x, opp.z - player.z);
      if (d < closestOppDist) {
        closestOppDist = d;
        closestOpp = opp;
      }
    }

    // Finaliza se estiver em distância boa de chute para a travinha
    const shootRange = player.config.role === 'pivo' ? 11.2 : 9.2;
    if (distToEnemyGoal < shootRange && Math.abs(player.z) < 6.2) {
      // Dispersão natural conforme dificuldade para não acertar 100% dos chutes
      const aimZ = (Math.random() - 0.5) * (pitch.goalWidth * aimDispersion);
      const power = Math.min(0.88, 0.48 + (distToEnemyGoal / 14) * 0.35);
      return {
        moveX: attackDirX,
        moveZ: Math.sign(aimZ - player.z) * 0.25,
        sprint: true,
        action: 'shoot',
        targetX: enemyGoalX,
        targetZ: aimZ,
        kickPower: power,
      };
    }

    // Se pressionado ou se houver um companheiro bem melhor posicionado à frente, toca a bola
    const bestMate = selectBestPassTarget(player, allPlayers, attackDirX, 0);
    if (bestMate) {
      const mateAdvance = (bestMate.x - player.x) * attackDirX;
      const shouldPassUnderPressure = closestOppDist < 2.3 && mateAdvance > -2.0;
      const shouldThroughPass =
        mateAdvance > 3.2 &&
        Math.hypot(bestMate.x - player.x, bestMate.z - player.z) < 13.5 &&
        Math.random() < 0.08;

      if (shouldPassUnderPressure || shouldThroughPass) {
        return {
          moveX: attackDirX,
          moveZ: 0,
          sprint: false,
          action: 'pass',
          targetX: bestMate.x + attackDirX * 1.1,
          targetZ: bestMate.z,
          kickPower: 0.62,
        };
      }
    }

    // Conduz a bola desviando suavemente do marcador mais próximo e buscando o gol
    let evadeZ = -player.z * 0.38;
    if (closestOpp && closestOppDist < 3.4) {
      const dzOpp = player.z - closestOpp.z;
      evadeZ += (dzOpp >= 0 ? 1 : -1) * 2.2;
    }
    const goalDirX = enemyGoalX - player.x;
    const norm = Math.hypot(goalDirX, evadeZ) || 1;
    return {
      moveX: (goalDirX / norm) * diffSpeedMult,
      moveZ: (evadeZ / norm) * diffSpeedMult,
      sprint: player.stamina > 32 && distToEnemyGoal > 5.5,
      action: 'none',
    };
  }

  // 3. QUANDO ESTE BOT NÃO ESTÁ COM A BOLA (COORDENAÇÃO COLETIVA SEM TUMULTO)
  const outfieldMates = allPlayers.filter(
    (p) => p.team === player.team && p.config.role !== 'goleiro'
  );

  // Ordena companheiros de linha pela distância até a bola prevista
  const predBallX = ball.x + ball.vx * 0.22;
  const predBallZ = ball.z + ball.vz * 0.22;
  const sortedByBallDist = [...outfieldMates].sort((a, b) => {
    const da = Math.hypot(predBallX - a.x, predBallZ - a.z);
    const db = Math.hypot(predBallX - b.x, predBallZ - b.z);
    return da - db;
  });

  const isPrimaryChaser = sortedByBallDist[0]?.id === player.id;
  const teamHasBall = ball.lastTouchTeam === player.team && ball.ownerId !== null;

  // Apenas o companheiro mais próximo dá o bote/busca a bola solta (evita todos correndo atrás da bola juntos)
  if (!teamHasBall && isPrimaryChaser) {
    const norm = distToBall || 1;
    // Bote equilibrado: nunca rouba instantaneamente e respeita tempo de reação
    const tackleChance =
      difficulty === 'lenda' ? 0.08 : difficulty === 'equilibrado' ? 0.045 : 0.02;
    const shouldTackle =
      distToBall > 1.05 &&
      distToBall < 1.75 &&
      ball.ownerId !== null &&
      player.tackleCooldown <= 0 &&
      Math.random() < tackleChance;

    return {
      moveX: (dxBall / norm) * diffSpeedMult,
      moveZ: (dzBall / norm) * diffSpeedMult,
      sprint: distToBall > 2.8 && player.stamina > 28,
      action: shouldTackle ? 'tackle' : 'none',
    };
  }

  // Posicionamento tático inteligente por função (Fixo, Ala, Pivô) + repulsão entre companheiros
  let targetX = player.homeX;
  let targetZ = player.homeZ;

  if (player.config.role === 'fixo') {
    // Defensor: protege a entrada da área e fecha linha de chute para a travinha
    targetX = teamHasBall
      ? ownGoalX + attackDirX * 9.5 + ball.x * 0.25
      : ownGoalX + attackDirX * 6.2 + Math.max(0, ball.x * attackDirX) * attackDirX * 0.25;
    targetZ = ball.z * 0.52;
  } else if (player.config.role === 'ala') {
    // Ala: abre na lateral para oferecer opção limpa de passe ou recompor
    const preferredWingZ = Math.abs(player.homeZ) > 1 ? Math.sign(player.homeZ) * 6.4 : 5.5;
    targetX = teamHasBall
      ? ball.x + attackDirX * 4.2
      : ball.x - attackDirX * 2.8;
    targetZ = preferredWingZ * 0.72 + ball.z * 0.22;
  } else if (player.config.role === 'pivo') {
    // Atacante: infiltra no espaço vazio atacando a travinha adversária
    targetX = teamHasBall
      ? enemyGoalX - attackDirX * 4.8
      : ball.x * 0.35 + attackDirX * 3.8;
    targetZ = Math.abs(ball.z) > 2.5 ? -Math.sign(ball.z) * 3.2 : 2.8;
  }

  // Evita que dois companheiros fiquem colados no mesmo ponto do campo
  for (const mate of outfieldMates) {
    if (mate.id === player.id) continue;
    const mdx = targetX - mate.x;
    const mdz = targetZ - mate.z;
    const mDist = Math.hypot(mdx, mdz);
    if (mDist < 3.6 && mDist > 0.01) {
      const push = (3.6 - mDist) * 0.65;
      targetX += (mdx / mDist) * push;
      targetZ += (mdz / mDist) * push;
    }
  }

  // Mantém dentro das linhas do campinho
  const halfW = pitch.width / 2 - 1.2;
  const halfD = pitch.depth / 2 - 1.2;
  targetX = Math.max(-halfW, Math.min(halfW, targetX));
  targetZ = Math.max(-halfD, Math.min(halfD, targetZ));

  const tx = targetX - player.x;
  const tz = targetZ - player.z;
  const tDist = Math.hypot(tx, tz);

  if (tDist < 0.42) {
    return { moveX: 0, moveZ: 0, sprint: false, action: 'none' };
  }

  return {
    moveX: (tx / tDist) * 0.88 * diffSpeedMult,
    moveZ: (tz / tDist) * 0.88 * diffSpeedMult,
    sprint: tDist > 6.2 && player.stamina > 42,
    action: 'none',
  };
}

/**
 * Seleciona de forma rápida e previsível o melhor companheiro ao apertar Q ou TROCAR JOGADOR,
 * levando em conta a posição futura da bola e evitando alternância instável.
 */
export function findBestSwitchTeammate(
  currentControlledId: string,
  ball: BallState,
  players: PlayerRuntimeState[],
  team: 'home' | 'away' = 'home'
): string {
  const candidates = players.filter(
    (p) =>
      p.team === team &&
      p.id !== currentControlledId &&
      p.config.role !== 'goleiro'
  );
  if (candidates.length === 0) return currentControlledId;

  const predBallX = ball.x + ball.vx * 0.25;
  const predBallZ = ball.z + ball.vz * 0.25;

  candidates.sort((a, b) => {
    const da = Math.hypot(predBallX - a.x, predBallZ - a.z);
    const db = Math.hypot(predBallX - b.x, predBallZ - b.z);
    return da - db;
  });

  return candidates[0].id;
}

