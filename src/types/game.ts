export type GameScreenState = 'title' | 'playing' | 'paused' | 'gameover';

export type MatchPhase =
  | 'kickoff'
  | 'open_play'
  | 'goal_celebration'
  | 'throw_in'
  | 'halftime'
  | 'fulltime';

export type PlayerRole = 'goleiro' | 'fixo' | 'ala' | 'pivo';

export type HairStyle =
  | 'bald'
  | 'receding_careca'
  | 'short_fade'
  | 'curly'
  | 'afro'
  | 'buzz'
  | 'bucket_hat_josue'
  | 'cap_orange'
  | 'cap_black';

export type ShirtStyle =
  | 'solid'
  | 'striped'
  | 'patterned'
  | 'shirtless'
  | 'tank_top';

export type BodyBuild = 'slim' | 'athletic' | 'stocky' | 'compact' | 'tall_lean';

export type CelebrationStyle =
  | 'yuri'
  | 'josue'
  | 'careca'
  | 'bode'
  | 'ismael'
  | 'rival';

export type PhotoSkinId =
  | 'josue'
  | 'careca'
  | 'bode'
  | 'ismael'
  | 'yuri'
  | 'primo'
  | 'bicudo'
  | 'felipe';

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
  bodyBuild?: BodyBuild;
  photoSkinId?: PhotoSkinId;
  outfitDescription?: string;
  lockAuthenticOutfit?: boolean;
  personality?: string;
  celebrationStyle?: CelebrationStyle;
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
  waterDrag: number;
}

export interface MudZone {
  id: string;
  x: number;
  z: number;
  radius: number;
  speedMultiplier: number;
}

export interface TerrainBump {
  x: number;
  z: number;
  radius: number;
  height: number;
}

export interface PitchDimensions {
  width: number;
  depth: number;
  goalWidth: number;
  goalHeight: number;
  goalDepth: number;
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
  lastTouchPlayerId?: string | null;
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
  facingAngle: number;
  animState: PlayerAnimState;
  animTimer: number;
  stridePhase: number;
  stamina: number;
  isSprinting: boolean;
  tackleCooldown: number;
  stunTimer: number;
  homeX: number;
  homeZ: number;
  hasBall: boolean;
  inMud: boolean;
  inPuddle: boolean;
  controlledByUid?: string | null;
  isSpeaking?: boolean;
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
  scorers: Array<{
    playerName: string;
    playerId?: string;
    team: 'home' | 'away';
    timeFormatted: string;
    half: 1 | 2;
  }>;
}

export type CameraMode = 'follow' | 'overview' | 'sideline' | 'close';

export interface KeyBindingsConfig {
  moveUp: string;
  moveDown: string;
  moveLeft: string;
  moveRight: string;
  sprint: string;
  shoot: string;
  pass: string;
  longPass: string;
  switchPlayer: string;
  tackle: string;
  pause: string;
}

export interface MobileControlsConfig {
  scale: number; // 0.85 (Pequeno), 1.0 (Normal), 1.15 (Grande)
  layoutPreset: 'compacto' | 'padrao' | 'espacado';
  joystickSensitivity: number; // 0.8 - 1.3
}

export interface MatchLoadingConfig {
  minLoadTimeSeconds: number;           // default: 2
  maxWaitTimeSeconds: number;           // default: 20
  slowConnectionWarningSeconds: number; // default: 10
  extraSlowConnectionSeconds: number;   // default: 5
}

export interface GameSettings {
  cameraMode: CameraMode;
  cameraDistance: number;
  soundEnabled: boolean;
  musicEnabled: boolean;
  sfxVolume: number;     // 0.0 - 1.0
  ambientVolume: number; // 0.0 - 1.0
  musicVolume: number;   // 0.0 - 1.0
  vibrationEnabled: boolean;
  halfDurationSeconds: number;
  aiDifficulty: 'raiz' | 'equilibrado' | 'lenda';
  showPlayerNames: boolean;
  autoSwitchPlayer?: boolean;
  ballControlRadius?: number; // default: 0.92
  graphicsQuality?: 'auto' | 'alta' | 'desempenho';
  keyBindings?: KeyBindingsConfig;
  mobileControls?: MobileControlsConfig;
  loadingConfig?: MatchLoadingConfig;
}

// Multiplayer, Matchmaking, Voice Chat & Friends Types
export type MatchFormatMode = '2v2' | '4v4';
export type RoomVisibility = 'public' | 'private';
export type VoiceTransmissionMode = 'muted' | 'open_mic' | 'push_to_talk';

export interface VoicePeerState {
  uid: string;
  displayName: string;
  characterId?: string;
  team?: 'home' | 'away';
  micEnabled: boolean;
  isSpeaking: boolean;
  mutedByMe: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'failed';
}

export interface RoomSlotAssignment {
  slotId: string; // 'home_1' .. 'home_4', 'away_1' .. 'away_4'
  playerName: string;
  team: 'home' | 'away';
  uid: string;
  userDisplayName: string;
  pingMs: number;
  ready: boolean;
}

export interface RemotePlayerInputPacket {
  uid: string;
  slotId: string;
  moveX: number;
  moveZ: number;
  sprint: boolean;
  action: 'none' | 'pass' | 'long_pass' | 'shoot' | 'tackle' | 'header';
  kickPower: number;
  seq: number;
  timestamp: number;
}

export interface NetworkSyncSnapshot {
  tick: number;
  timestamp: number;
  phase: MatchPhase;
  half: 1 | 2;
  remainingSeconds: number;
  homeGoals: number;
  awayGoals: number;
  celebratingPlayerId: string | null;
  celebrationStyle: CelebrationStyle | null;
  bannerMessage: string | null;
  bannerSubtext: string | null;
  ball: {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    ownerId: string | null;
  };
  players: Array<{
    id: string;
    x: number;
    z: number;
    vx: number;
    vz: number;
    facingAngle: number;
    animState: PlayerAnimState;
    stamina: number;
    isSpeaking?: boolean;
  }>;
}

export type UserPresenceStatus = 'online' | 'offline' | 'in_room' | 'in_match';

export interface OnlineUserProfile {
  uid: string;
  displayName: string;
  tagCode: string;
  status: UserPresenceStatus;
  currentRoomCode: string;
  wins?: number;
  losses?: number;
  draws?: number;
  goalsScored?: number;
  goalsConceded?: number;
  matchesPlayed?: number;
  updatedAt: number;
  createdAt: number;
}

export interface MultiplayerSlot {
  characterId: string;
  characterName: string;
  team: 'home' | 'away';
  uid: string | null;
  displayName: string;
  isBot: boolean;
  isReady: boolean;
  pingMs: number;
  micEnabled?: boolean;
  isSpeaking?: boolean;
  lastSeenMs?: number;
}

export interface MultiplayerMatchSnapshot {
  tick?: number;
  seq?: number;
  lastProcessedSeqByUid?: Record<string, number>;
  ball: {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    ownerId?: string | null;
  };
  players: Record<
    string,
    {
      x: number;
      z: number;
      vx: number;
      vz: number;
      facingAngle: number;
      animState: PlayerAnimState;
      stamina?: number;
      isSpeaking?: boolean;
      controlledByUid?: string | null;
      isBot?: boolean;
    }
  >;
  homeGoals: number;
  awayGoals: number;
  half: 1 | 2;
  remainingSeconds: number;
  phase: MatchPhase;
  celebratingPlayerId: string | null;
  bannerMessage: string | null;
  bannerSubtext: string | null;
  timestamp: number;
}

export interface AuthUserInfo {
  uid: string;
  displayName: string;
  email: string | null;
  photoURL: string | null;
  isAnonymous: boolean;
  isGoogleLinked: boolean;
  providers: string[];
  loginProviderLabel: 'google.com' | 'anonymous' | 'unauthenticated';
}

export interface MultiplayerRoomState {
  roomCode: string;
  matchId?: string;
  roomName?: string;
  mode?: MatchFormatMode;
  visibility?: RoomVisibility;
  hasPassword?: boolean;
  passwordHash?: string | null;
  maxHumans?: number;
  autoFillBots?: boolean;
  activeCharacterIds?: string[];
  loadingReadyUids?: string[];
  startAt?: number;
  lastActivityMs?: number;
  hostUid: string;
  hostName: string;
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  half: 1 | 2;
  remainingSeconds: number;
  slots: Record<string, MultiplayerSlot>;
  matchState: MultiplayerMatchSnapshot | null;
}

export interface WsInputCommand {
  seq: number;
  timestamp: number;
  uid: string;
  roomCode: string;
  matchId?: string;
  slotId: string;
  moveX: number;
  moveZ: number;
  sprint: boolean;
  action: 'none' | 'pass' | 'long_pass' | 'shoot' | 'tackle' | 'header' | 'switch';
  kickPower: number;
  aimX?: number;
  aimZ?: number;
}
