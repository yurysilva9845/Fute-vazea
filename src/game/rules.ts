import {
  BallState,
  MudZone,
  PitchDimensions,
  PlayerCustomization,
  PlayerRuntimeState,
  PuddleZone,
  TeamConfig,
  TerrainBump,
} from '../types/game';

export const DEFAULT_PITCH: PitchDimensions = {
  width: 34,      // X: -17 to +17
  depth: 22,      // Z: -11 to +11
  goalWidth: 4.0, // Z: -2.0 to +2.0 (small proportional 4v4 várzea goal)
  goalHeight: 2.0,
  goalDepth: 1.35,
};

export const VARZEA_PUDDLES: PuddleZone[] = [
  {
    id: 'puddle_main_back',
    x: -3.5,
    z: -5.2,
    rx: 4.8,
    rz: 2.3,
    rotation: 0.12,
    waterDrag: 0.58,
  },
  {
    id: 'puddle_left_mid',
    x: -7.8,
    z: -1.6,
    rx: 2.2,
    rz: 1.3,
    rotation: -0.18,
    waterDrag: 0.52,
  },
  {
    id: 'puddle_right_back',
    x: 4.2,
    z: -5.8,
    rx: 2.6,
    rz: 1.2,
    rotation: 0.08,
    waterDrag: 0.48,
  },
];

export const VARZEA_MUD_ZONES: MudZone[] = [
  { id: 'mud_center_front', x: -2.2, z: 3.2, radius: 3.4, speedMultiplier: 0.78 },
  { id: 'mud_around_puddle', x: -3.5, z: -5.0, radius: 5.5, speedMultiplier: 0.74 },
  { id: 'mud_goal_left', x: -15.2, z: 0.2, radius: 2.6, speedMultiplier: 0.82 },
  { id: 'mud_goal_right', x: 15.2, z: -0.3, radius: 2.6, speedMultiplier: 0.82 },
];

export const VARZEA_BUMPS: TerrainBump[] = [
  { x: -2.2, z: 3.2, radius: 2.4, height: -0.09 },
  { x: 3.8, z: 1.5, radius: 2.1, height: 0.07 },
  { x: -6.5, z: 4.5, radius: 1.9, height: -0.06 },
  { x: 6.0, z: -2.8, radius: 2.5, height: 0.08 },
  { x: 0.4, z: -1.2, radius: 1.8, height: -0.05 },
  { x: -10.5, z: -3.0, radius: 2.2, height: 0.07 },
  { x: 10.2, z: 3.4, radius: 2.0, height: -0.06 },
];

/**
 * TIME PRINCIPAL (Time 1): Yuri, Josué, Careca e Bode
 * Cada um com aparência física, personalidade e comemoração exclusiva!
 */
export const INITIAL_HOME_PLAYERS: PlayerCustomization[] = [
  {
    id: 'home_1',
    name: 'Yuri',
    role: 'pivo',
    number: 9,
    skinColor: '#a66e4a', // Pele morena
    hairColor: '#1a1615',
    hairStyle: 'short_fade',
    shirtStyle: 'patterned',
    shirtPrimary: '#f5f0eb',
    shirtSecondary: '#d9532f',
    shortsColor: '#5c2c16',
    barefoot: true,
    bootColor: '#1f2937',
    bodyBuild: 'athletic',
    personality: 'Descontraído · Artilheiro da Várzea',
    celebrationStyle: 'yuri',
    speedStat: 1.08,
    kickStat: 1.12,
    tackleStat: 0.95,
  },
  {
    id: 'home_2',
    name: 'Josué',
    role: 'ala',
    number: 10,
    skinColor: '#8d5837', // Pele morena
    hairColor: '#181413',
    hairStyle: 'curly',
    shirtStyle: 'solid',
    shirtPrimary: '#1d6b52',
    shirtSecondary: '#facc15',
    shortsColor: '#334155',
    barefoot: true,
    bootColor: '#111827',
    bodyBuild: 'compact',
    personality: 'Brincalhão · Rei do Drible Curto',
    celebrationStyle: 'josue',
    speedStat: 1.12,
    kickStat: 1.04,
    tackleStat: 1.0,
  },
  {
    id: 'home_3',
    name: 'Careca',
    role: 'fixo',
    number: 4,
    skinColor: '#4a2c18', // Pele negra
    hairColor: '#14110f',
    hairStyle: 'bald', // Cabeça raspada
    shirtStyle: 'solid',
    shirtPrimary: '#d97706',
    shirtSecondary: '#fef3c7',
    shortsColor: '#18181b',
    barefoot: true,
    bootColor: '#18181b',
    bodyBuild: 'slim', // Corpo magro e esguio
    personality: 'Engraçado e Descontraído · Xerife Esguio',
    celebrationStyle: 'careca',
    speedStat: 1.04,
    kickStat: 1.02,
    tackleStat: 1.15,
  },
  {
    id: 'home_4',
    name: 'Bode',
    role: 'goleiro',
    number: 1,
    skinColor: '#78472a', // Pele morena
    hairColor: '#141210',
    hairStyle: 'afro',
    shirtStyle: 'solid',
    shirtPrimary: '#292524',
    shirtSecondary: '#f59e0b',
    shortsColor: '#44403c',
    barefoot: false,
    bootColor: '#0f172a',
    bodyBuild: 'stocky',
    personality: 'Irreverente · Paredão do Terreirão',
    celebrationStyle: 'bode',
    speedStat: 0.96,
    kickStat: 1.05,
    tackleStat: 1.1,
  },
];

/**
 * TIME ADVERSÁRIO (Time 2): Primo, Bicudo, Ismael e Felipe
 */
export const INITIAL_AWAY_PLAYERS: PlayerCustomization[] = [
  {
    id: 'away_1',
    name: 'Primo',
    role: 'pivo',
    number: 11,
    skinColor: '#b57c56',
    hairColor: '#292018',
    hairStyle: 'buzz',
    shirtStyle: 'striped',
    shirtPrimary: '#b91c1c',
    shirtSecondary: '#111827',
    shortsColor: '#111827',
    barefoot: false,
    bootColor: '#dc2626',
    bodyBuild: 'athletic',
    personality: 'Atacante Fominha',
    celebrationStyle: 'rival',
    speedStat: 1.05,
    kickStat: 1.08,
    tackleStat: 0.98,
  },
  {
    id: 'away_2',
    name: 'Bicudo',
    role: 'ala',
    number: 7,
    skinColor: '#6b3e23',
    hairColor: '#14110f',
    hairStyle: 'short_fade',
    shirtStyle: 'striped',
    shirtPrimary: '#b91c1c',
    shirtSecondary: '#111827',
    shortsColor: '#111827',
    barefoot: false,
    bootColor: '#facc15',
    bodyBuild: 'compact',
    personality: 'Rei do Chute de Bico na Lama',
    celebrationStyle: 'rival',
    speedStat: 1.09,
    kickStat: 1.1,
    tackleStat: 1.0,
  },
  {
    id: 'away_3',
    name: 'Ismael',
    role: 'fixo',
    number: 3,
    skinColor: '#9c6644',
    hairColor: '#1c1613',
    hairStyle: 'cap_black',
    shirtStyle: 'striped',
    shirtPrimary: '#b91c1c',
    shirtSecondary: '#111827',
    shortsColor: '#18181b',
    barefoot: true,
    bootColor: '#27272a',
    bodyBuild: 'stocky',
    personality: 'Zagueiro de Carrinho Forte',
    celebrationStyle: 'rival',
    speedStat: 0.98,
    kickStat: 0.98,
    tackleStat: 1.12,
  },
  {
    id: 'away_4',
    name: 'Felipe',
    role: 'goleiro',
    number: 12,
    skinColor: '#845234',
    hairColor: '#181311',
    hairStyle: 'curly',
    shirtStyle: 'solid',
    shirtPrimary: '#1d4ed8',
    shirtSecondary: '#eff6ff',
    shortsColor: '#1e293b',
    barefoot: false,
    bootColor: '#1e293b',
    bodyBuild: 'slim',
    personality: 'Goleiro Elástico',
    celebrationStyle: 'rival',
    speedStat: 0.97,
    kickStat: 1.02,
    tackleStat: 1.08,
  },
];

export const AVAILABLE_TEAMS: TeamConfig[] = [
  {
    id: 'unidos_do_barro',
    name: 'Unidos do Barro',
    shortName: 'BAR',
    primaryColor: '#d97706',
    secondaryColor: '#fef3c7',
    shortsColor: '#292524',
    description: 'O time raiz do campinho de terra: Yuri, Josué, Careca e Bode no estilo original da várzea.',
  },
  {
    id: 'canarinho_varzea',
    name: 'Canarinho da Vila',
    shortName: 'CAN',
    primaryColor: '#eab308',
    secondaryColor: '#15803d',
    shortsColor: '#1d4ed8',
    description: 'Camisa amarela clássica de domingo de manhã com calção azul e muita ginga.',
  },
  {
    id: 'rubro_negro_beco',
    name: 'Rubro-Negro do Beco',
    shortName: 'RNB',
    primaryColor: '#dc2626',
    secondaryColor: '#181827',
    shortsColor: '#18181b',
    description: 'Primo, Bicudo, Ismael e Felipe prontos para o clássico na terra batida.',
  },
  {
    id: 'alvinegro_terreirao',
    name: 'Alvinegro do Terreirão',
    shortName: 'ALV',
    primaryColor: '#f5f5f4',
    secondaryColor: '#1c1917',
    shortsColor: '#1c1917',
    description: 'Tradição no campinho entre os muros de tijolo e a cerca de madeira.',
  },
];

export const VARZEA_VOICE_PHRASES = {
  callForPass: ['Toca a bola!', 'Aqui!', 'Passa, passa!'],
  passRequest: ['Toca a bola!', 'Aqui!', 'Passa, passa!'],
  attacking: ['Vai, vai!', 'Chuta!', 'Bora!'],
  sprintCall: ['Vai, vai!', 'Bora!', 'Corre!'],
  shootCall: ['Chuta!', 'Solta a bomba!', 'Bate pro gol!'],
  defending: ['Marca ele!', 'Fecha o meio!', 'Tira daí!'],
  defendCall: ['Marca ele!', 'Fecha o meio!', 'Tira daí!'],
  goodPlay: ['Boa!', 'Aí sim!', 'Jogou muito!'],
  goalScored: ['Que golaço!', 'Foi gol!', 'É caixa na várzea!'],
  goalShout: ['Que golaço!', 'Foi gol!', 'É caixa na várzea!'],
};

export function getTerrainHeightAt(
  x: number,
  z: number,
  bumps: TerrainBump[] = VARZEA_BUMPS
): number {
  let h =
    Math.sin(x * 0.35) * Math.cos(z * 0.42) * 0.025 +
    Math.sin(x * 0.9 + z * 0.7) * 0.012;

  for (let i = 0; i < bumps.length; i++) {
    const b = bumps[i];
    const dx = x - b.x;
    const dz = z - b.z;
    const distSq = dx * dx + dz * dz;
    const rSq = b.radius * b.radius;
    if (distSq < rSq) {
      const factor = 1 - distSq / rSq;
      h += b.height * factor * factor;
    }
  }
  return h;
}

export function getPuddleAt(
  x: number,
  z: number,
  puddles: PuddleZone[] = VARZEA_PUDDLES
): PuddleZone | null {
  for (let i = 0; i < puddles.length; i++) {
    const p = puddles[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const cos = Math.cos(-p.rotation);
    const sin = Math.sin(-p.rotation);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    const normDist = (lx * lx) / (p.rx * p.rx) + (lz * lz) / (p.rz * p.rz);
    if (normDist <= 1.0) {
      return p;
    }
  }
  return null;
}

export function getMudSpeedMultiplier(
  x: number,
  z: number,
  mudZones: MudZone[] = VARZEA_MUD_ZONES,
  puddles: PuddleZone[] = VARZEA_PUDDLES
): { multiplier: number; inMud: boolean; inPuddle: boolean } {
  const puddle = getPuddleAt(x, z, puddles);
  if (puddle) {
    return { multiplier: 0.72, inMud: true, inPuddle: true };
  }
  let minMult = 1.0;
  let inMud = false;
  for (let i = 0; i < mudZones.length; i++) {
    const m = mudZones[i];
    const dx = x - m.x;
    const dz = z - m.z;
    if (dx * dx + dz * dz <= m.radius * m.radius) {
      inMud = true;
      if (m.speedMultiplier < minMult) {
        minMult = m.speedMultiplier;
      }
    }
  }
  return { multiplier: minMult, inMud, inPuddle: false };
}

export function checkGoalScored(
  ball: BallState,
  pitch: PitchDimensions = DEFAULT_PITCH
): 'home' | 'away' | null {
  const halfW = pitch.width / 2;
  const halfGoalZ = pitch.goalWidth / 2;

  const insideGoalZ = Math.abs(ball.z) <= halfGoalZ - ball.radius * 0.35;
  const belowCrossbar = ball.y + ball.radius * 0.5 <= pitch.goalHeight;

  if (!insideGoalZ || !belowCrossbar) {
    return null;
  }

  if (ball.x - ball.radius >= halfW && ball.x <= halfW + pitch.goalDepth + ball.radius) {
    return 'home';
  }

  if (ball.x + ball.radius <= -halfW && ball.x >= -halfW - pitch.goalDepth - ball.radius) {
    return 'away';
  }

  return null;
}

export interface OutOfBoundsEvent {
  type: 'throw_in' | 'goal_kick' | 'corner';
  restartX: number;
  restartZ: number;
  awardedTeam: 'home' | 'away';
}

export function checkOutOfBounds(
  ball: BallState,
  pitch: PitchDimensions = DEFAULT_PITCH
): OutOfBoundsEvent | null {
  const halfW = pitch.width / 2;
  const halfD = pitch.depth / 2;
  const halfGoalZ = pitch.goalWidth / 2;

  if (Math.abs(ball.z) > halfD + ball.radius * 1.2) {
    const signZ = ball.z > 0 ? 1 : -1;
    const clampedX = Math.max(-halfW + 1.5, Math.min(halfW - 1.5, ball.x));
    const awardedTeam: 'home' | 'away' =
      ball.lastTouchTeam === 'home' ? 'away' : 'home';
    return {
      type: 'throw_in',
      restartX: clampedX,
      restartZ: signZ * (halfD - 0.3),
      awardedTeam,
    };
  }

  const inGoalMouthZ = Math.abs(ball.z) <= halfGoalZ;
  const belowCrossbar = ball.y <= pitch.goalHeight;

  if (Math.abs(ball.x) > halfW + ball.radius * 1.2 && !(inGoalMouthZ && belowCrossbar)) {
    const signX = ball.x > 0 ? 1 : -1;
    const awardedTeam: 'home' | 'away' =
      ball.lastTouchTeam === 'home' ? 'away' : 'home';

    if (
      (signX > 0 && awardedTeam === 'away') ||
      (signX < 0 && awardedTeam === 'home')
    ) {
      return {
        type: 'goal_kick',
        restartX: signX * (halfW - 2.2),
        restartZ: 0,
        awardedTeam,
      };
    } else {
      const cornerZ = (ball.z >= 0 ? 1 : -1) * (halfD - 0.5);
      return {
        type: 'corner',
        restartX: signX * (halfW - 0.5),
        restartZ: cornerZ,
        awardedTeam,
      };
    }
  }

  return null;
}

export interface BallStepEvents {
  bouncedOnDirt: boolean;
  splashedInPuddle: boolean;
  hitGoalpost: boolean;
  goalScored: 'home' | 'away' | null;
  outOfBounds: OutOfBoundsEvent | null;
}

export function stepBallPhysics(
  ball: BallState,
  dt: number,
  pitch: PitchDimensions = DEFAULT_PITCH,
  rng: () => number = Math.random
): BallStepEvents {
  const events: BallStepEvents = {
    bouncedOnDirt: false,
    splashedInPuddle: false,
    hitGoalpost: false,
    goalScored: null,
    outOfBounds: null,
  };

  const gravity = 19.5;
  const groundY = getTerrainHeightAt(ball.x, ball.z) + ball.radius;
  const puddle = getPuddleAt(ball.x, ball.z);
  ball.inPuddle = Boolean(puddle) && ball.y <= groundY + 0.15;

  if (ball.y > groundY + 0.005 || ball.vy > 0) {
    ball.vy -= gravity * dt;
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  const newGroundY = getTerrainHeightAt(ball.x, ball.z) + ball.radius;

  if (ball.y <= newGroundY) {
    ball.y = newGroundY;

    if (ball.vy < -1.1) {
      const inWater = Boolean(getPuddleAt(ball.x, ball.z));
      if (inWater) {
        ball.vy = -ball.vy * 0.18;
        ball.vx *= 0.62;
        ball.vz *= 0.62;
        events.splashedInPuddle = true;
      } else {
        const restitution = 0.56;
        ball.vy = -ball.vy * restitution;
        const speedHoriz = Math.hypot(ball.vx, ball.vz);
        if (speedHoriz > 1.5) {
          const jitterAngle = (rng() - 0.5) * 0.24;
          const cos = Math.cos(jitterAngle);
          const sin = Math.sin(jitterAngle);
          const nvx = ball.vx * cos - ball.vz * sin;
          const nvz = ball.vx * sin + ball.vz * cos;
          ball.vx = nvx * 0.88;
          ball.vz = nvz * 0.88;
        }
        events.bouncedOnDirt = true;
      }
    } else {
      ball.vy = 0;
    }

    const activePuddle = getPuddleAt(ball.x, ball.z);
    if (activePuddle) {
      const waterDamp = Math.exp(-3.8 * activePuddle.waterDrag * dt * 2.2);
      ball.vx *= waterDamp;
      ball.vz *= waterDamp;
      if (Math.hypot(ball.vx, ball.vz) > 2.2 && rng() < 0.35) {
        events.splashedInPuddle = true;
      }
    } else {
      const mud = getMudSpeedMultiplier(ball.x, ball.z);
      const frictionRate = mud.inMud ? 2.4 : 1.45;
      const damp = Math.exp(-frictionRate * dt);
      ball.vx *= damp;
      ball.vz *= damp;
    }
  } else {
    const airDamp = Math.exp(-0.25 * dt);
    ball.vx *= airDamp;
    ball.vz *= airDamp;
  }

  if (Math.hypot(ball.vx, ball.vz) < 0.06 && Math.abs(ball.vy) < 0.06) {
    ball.vx = 0;
    ball.vz = 0;
  }

  const halfW = pitch.width / 2;
  const halfGoalZ = pitch.goalWidth / 2;
  const postRadius = 0.08;

  const posts = [
    { x: -halfW, z: -halfGoalZ },
    { x: -halfW, z: halfGoalZ },
    { x: halfW, z: -halfGoalZ },
    { x: halfW, z: halfGoalZ },
  ];

  if (ball.y <= pitch.goalHeight + ball.radius) {
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      const dx = ball.x - p.x;
      const dz = ball.z - p.z;
      const dist = Math.hypot(dx, dz);
      const minDist = ball.radius + postRadius;
      if (dist > 0.0001 && dist < minDist) {
        const nx = dx / dist;
        const nz = dz / dist;
        ball.x = p.x + nx * minDist;
        ball.z = p.z + nz * minDist;
        const dot = ball.vx * nx + ball.vz * nz;
        if (dot < 0) {
          ball.vx = (ball.vx - 2 * dot * nx) * 0.75;
          ball.vz = (ball.vz - 2 * dot * nz) * 0.75;
          events.hitGoalpost = true;
        }
      }
    }
  }

  if (
    Math.abs(Math.abs(ball.x) - halfW) < ball.radius + postRadius &&
    Math.abs(ball.z) <= halfGoalZ &&
    Math.abs(ball.y - pitch.goalHeight) < ball.radius + postRadius
  ) {
    ball.vy = Math.abs(ball.vy) * 0.7 + 1.5;
    ball.vx = -ball.vx * 0.7;
    events.hitGoalpost = true;
  }

  for (const signX of [-1, 1]) {
    const goalFrontX = signX * halfW;
    const goalBackX = signX * (halfW + pitch.goalDepth);
    const insideDepth =
      signX > 0
        ? ball.x >= goalFrontX && ball.x <= goalBackX + 0.5
        : ball.x <= goalFrontX && ball.x >= goalBackX - 0.5;

    if (insideDepth && Math.abs(ball.z) <= halfGoalZ + 0.4 && ball.y <= pitch.goalHeight + 0.2) {
      if (signX > 0 && ball.x + ball.radius > goalBackX) {
        ball.x = goalBackX - ball.radius;
        ball.vx = -Math.abs(ball.vx) * 0.25;
        ball.vz *= 0.5;
      } else if (signX < 0 && ball.x - ball.radius < goalBackX) {
        ball.x = goalBackX + ball.radius;
        ball.vx = Math.abs(ball.vx) * 0.25;
        ball.vz *= 0.5;
      }
      if (Math.abs(ball.z) + ball.radius > halfGoalZ) {
        ball.z = Math.sign(ball.z) * (halfGoalZ - ball.radius);
        ball.vz = -ball.vz * 0.3;
      }
    }
  }

  events.goalScored = checkGoalScored(ball, pitch);
  if (!events.goalScored) {
    events.outOfBounds = checkOutOfBounds(ball, pitch);
  }

  const maxWorldX = halfW + 4.2;
  const maxWorldZ = pitch.depth / 2 + 3.8;
  if (Math.abs(ball.x) > maxWorldX) {
    ball.x = Math.sign(ball.x) * maxWorldX;
    ball.vx = -ball.vx * 0.5;
  }
  if (Math.abs(ball.z) > maxWorldZ) {
    ball.z = Math.sign(ball.z) * maxWorldZ;
    ball.vz = -ball.vz * 0.5;
  }

  return events;
}

export function resolvePlayerBallInteraction(
  player: PlayerRuntimeState,
  ball: BallState,
  allPlayers: PlayerRuntimeState[]
): { touched: boolean; intercepted: boolean } {
  if (player.stunTimer > 0) {
    player.hasBall = false;
    return { touched: false, intercepted: false };
  }

  const dx = ball.x - player.x;
  const dz = ball.z - player.z;
  const dist = Math.hypot(dx, dz);
  const controlRadius = 0.78;
  const heightReach = player.animState === 'header' ? 2.35 : 1.35;

  if (dist > controlRadius || ball.y > getTerrainHeightAt(player.x, player.z) + heightReach) {
    if (ball.ownerId === player.id && dist > 1.35) {
      ball.ownerId = null;
      player.hasBall = false;
    }
    return { touched: false, intercepted: false };
  }

  const previousOwner = ball.ownerId;
  const intercepted = previousOwner !== null && previousOwner !== player.id;

  for (let i = 0; i < allPlayers.length; i++) {
    allPlayers[i].hasBall = allPlayers[i].id === player.id;
  }

  ball.ownerId = player.id;
  ball.lastTouchTeam = player.team;
  ball.lastTouchPlayerName = player.config.name;
  ball.lastTouchPlayerId = player.id;

  const dirX = Math.sin(player.facingAngle);
  const dirZ = Math.cos(player.facingAngle);

  const targetBallX = player.x + dirX * 0.58;
  const targetBallZ = player.z + dirZ * 0.58;

  const pushFactor = player.isSprinting ? 1.28 : 1.08;
  ball.vx = player.vx * pushFactor + (targetBallX - ball.x) * 4.5;
  ball.vz = player.vz * pushFactor + (targetBallZ - ball.z) * 4.5;

  if (ball.vy < 0) {
    ball.vy *= 0.35;
  }

  return { touched: true, intercepted };
}

export function formatMatchTime(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
