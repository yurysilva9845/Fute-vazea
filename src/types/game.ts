export type GameScreenState = 'title' | 'playing' | 'paused' | 'gameover';

export type MatchPhase =
  | 'kickoff'
  | 'open_play'
  | 'goal_celebration'
  | 'throw_in'
  | 'halftime'
  | 'fulltime';

export type PlayerRole = 'goleiro' | 'fixo' | 'ala' | 'pivo';

export type HairStyle = 'bald' | 'short_fade' | 'curly' | 'afro' | 'buzz' | 'cap_orange' | 'cap_black';

export type ShirtStyle = 'solid' | 'striped' | 'patterned' | 'shirtless' | 'tank_top';

export type PlayerAnimState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'kick'
  | 'pass'
  | 'tackle'
  | 'fall'
  | 'celebrate'
  | 'header';

export interface PlayerCustomization {
  id: string;
  name: string;
  role: PlayerRole;
  number: number;
  skinColor: string;
  hairColor: string;
  hairStyle: HairStyle;
  shirtStyle: ShirtStyle;
  shirtPrimary: string;
  shirtSecondary: string;
  shortsColor: string;
   barefoot: boolean;
  bootColor: string;
  speedStat: number;   // 0.85 - 1.15
  kickStat: number;    // 0.85 - 1.15
  tackleStat: number;  // 0.85 - 1.15
}

export interface TeamConfig {
  id: string;
  name: string;
  shortName: string;
  primaryColor: string;
  secondaryColor: string;
  shortsColor: string;
  description: string;
}

export interface PuddleZone {
  id: string;
  x: number;
  z: number;
  rx: number;
  rz: number;
  rotation: number;
  waterDrag: number; // 0.35 - 0.65 velocity damping per second
}

export interface MudZone {
  id: string;
  x: number;
  z: number;
  radius: number;
  speedMultiplier: number; // e.g. 0.75
}

export interface TerrainBump {
  x: number;
  z: number;
  radius: number;
  height: number; // + for bump, - for shallow hole
}

export interface PitchDimensions {
  width: number;       // X axis (goal to goal): e.g., 36m
  depth: number;       // Z axis (sideline to sideline): e.g., 24m
  goalWidth: number;   // Z span of small varzea goal: e.g., 4.2m
  goalHeight: number;  // Y height of small varzea goal: e.g., 2.05m
  goalDepth: number;   // X depth of net: e.g., 1.3m
}

export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  spinX: number;
  spinZ: number;
  ownerId: string | null;
  lastTouchTeam: 'home' | 'away' | null;
  lastTouchPlayerName: string | null;
  inPuddle: boolean;
}

export interface PlayerRuntimeState {
  id: string;
  team: 'home' | 'away';
  config: PlayerCustomization;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  facingAngle: number; // radians in XZ plane
  animState: PlayerAnimState;
  animTimer: number;
  stridePhase: number;
  stamina: number;     // 0 - 100
  isSprinting: boolean;
  tackleCooldown: number;
  stunTimer: number;   // > 0 when fallen/tackled
  homeX: number;       // tactical anchor X
  homeZ: number;       // tactical anchor Z
  hasBall: boolean;
  inMud: boolean;
  inPuddle: boolean;
}

export interface MatchStats {
  homeGoals: number;
  awayGoals: number;
  homeShots: number;
  awayShots: number;
  homePasses: number;
  awayPasses: number;
  homeTackles: number;
  awayTackles: number;
  homePossessionFrames: number;
  awayPossessionFrames: number;
  scorers: Array<{ playerName: string; team: 'home' | 'away'; timeFormatted: string; half: 1 | 2 }>;
}

export type CameraMode = 'follow' | 'overview' | 'sideline' | 'close';

export interface GameSettings {
  cameraMode: CameraMode;
  cameraDistance: number; // 0.7 to 1.4 multiplier
  soundEnabled: boolean;
  musicEnabled: boolean;
  halfDurationSeconds: number; // default 300 (5 minutes)
  aiDifficulty: 'raiz' | 'equilibrado' | 'lenda';
  showPlayerNames: boolean;
}
