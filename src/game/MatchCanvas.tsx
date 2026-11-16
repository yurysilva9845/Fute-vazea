import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BallState,
  GameScreenState,
  GameSettings,
  MatchPhase,
  MatchStats,
  MultiplayerRoomState,
  PlayerCustomization,
  PlayerRuntimeState,
  TeamConfig,
} from '../types/game';
import {
  DEFAULT_PITCH,
  formatMatchTime,
  getActivePlayersForMode,
  getMudSpeedMultiplier,
  getTerrainHeightAt,
  resolvePlayerBallInteraction,
  stepBallPhysics,
} from './rules';
import { buildVarzeaEnvironment } from './environment';
import {
  buildHumanPlayerRig,
  HumanRig,
  updateHumanPlayerAnimation,
} from './playerModel';
import { createSoccerBallTexture } from './textures';
import { computeAIDecision, findBestSwitchTeammate } from './ai';
import { VarzeaCameraRig } from './camera';
import { VarzeaInputManager } from './controls';
import { audioEngine } from './audio';
import {
  auth,
  publishClientInput,
  publishHostMatchSnapshot,
} from '../services/firebase';

export interface LiveHUDUpdate {
  controlledPlayerName: string;
  controlledPlayerRole: string;
  stamina: number;
  kickCharge: number;
  isChargingKick: boolean;
  bannerMessage: string | null;
  bannerSubtext: string | null;
}

interface MatchCanvasProps {
  screenState: GameScreenState;
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  homePlayersConfig: PlayerCustomization[];
  awayPlayersConfig: PlayerCustomization[];
  settings: GameSettings;
  inputManager: VarzeaInputManager;
  restartSignal: number;
  activeRoom?: MultiplayerRoomState | null;
  onlineControlledCharacterId?: string;
  onScoreAndClockUpdate: (
    homeGoals: number,
    awayGoals: number,
    half: 1 | 2,
    remainingSeconds: number,
    phase: MatchPhase
  ) => void;
  onHUDRefUpdate: (hud: LiveHUDUpdate) => void;
  onMatchFinished: (stats: MatchStats) => void;
  onTogglePause: () => void;
}

interface FormationSlot {
  x: number;
  z: number;
}

const HOME_FORMATION: FormationSlot[] = [
  { x: -3.2, z: -1.5 }, // Yuri (Pivô / Atacante)
  { x: -5.8, z: 4.2 },  // Josué (Ala)
  { x: -9.5, z: -0.8 }, // Careca (Fixo / Defensor)
  { x: -15.6, z: 0.0 }, // Bode (Goleiro)
];

const AWAY_FORMATION: FormationSlot[] = [
  { x: 3.2, z: 1.5 },   // Primo (Pivô)
  { x: 5.8, z: -4.2 },  // Bicudo (Ala)
  { x: 9.5, z: 0.8 },   // Ismael (Fixo)
  { x: 15.6, z: 0.0 },  // Felipe (Goleiro)
];

export const MatchCanvas: React.FC<MatchCanvasProps> = ({
  screenState,
  homeTeam,
  awayTeam,
  homePlayersConfig,
  awayPlayersConfig,
  settings,
  inputManager,
  restartSignal,
  activeRoom = null,
  onlineControlledCharacterId = 'home_1',
  onScoreAndClockUpdate,
  onHUDRefUpdate,
  onMatchFinished,
  onTogglePause,
}) => {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const labelRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Store latest React props in ref so WebGL loop never tears down
  const propsRef = useRef({
    screenState,
    homeTeam,
    awayTeam,
    homePlayersConfig,
    awayPlayersConfig,
    settings,
    activeRoom,
    onlineControlledCharacterId,
    onScoreAndClockUpdate,
    onHUDRefUpdate,
    onMatchFinished,
    onTogglePause,
  });

  useEffect(() => {
    propsRef.current = {
      screenState,
      homeTeam,
      awayTeam,
      homePlayersConfig,
      awayPlayersConfig,
      settings,
      activeRoom,
      onlineControlledCharacterId,
      onScoreAndClockUpdate,
      onHUDRefUpdate,
      onMatchFinished,
      onTogglePause,
    };
  }, [
    screenState,
    homeTeam,
    awayTeam,
    homePlayersConfig,
    awayPlayersConfig,
    settings,
    activeRoom,
    onlineControlledCharacterId,
    onScoreAndClockUpdate,
    onHUDRefUpdate,
    onMatchFinished,
    onTogglePause,
  ]);

  const rebuildRigsSignalRef = useRef(0);
  useEffect(() => {
    rebuildRigsSignalRef.current += 1;
  }, [
    homePlayersConfig,
    awayPlayersConfig,
    homeTeam,
    awayTeam,
    activeRoom?.mode,
    activeRoom?.activeCharacterIds?.join(','),
  ]);

  const restartSignalRef = useRef(restartSignal);
  useEffect(() => {
    restartSignalRef.current = restartSignal;
  }, [restartSignal]);

  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    // 1. Software-WebGL detection per Three.js skill
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2)
    );
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight
    );

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // 2. Scene, Partly Cloudy Rural Brazilian Sky & Studio IBL Environment
    const scene = new THREE.Scene();
    const skyHorizonColor = new THREE.Color(0xc2ced9);
    scene.background = skyHorizonColor;
    scene.fog = new THREE.FogExp2(0xc2ced9, 0.011);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(
      new RoomEnvironment(),
      0.04
    ).texture;
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(
      48,
      (container.clientWidth || window.innerWidth) /
        (container.clientHeight || window.innerHeight),
      0.2,
      140
    );

    // 3. Warm/Cool Color-Temperature Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x8c6d53, 0.85);
    hemiLight.position.set(0, 40, 0);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.45);
    sunLight.position.set(16, 28, 14);
    sunLight.castShadow = !isSoftwareGl;
    if (!isSoftwareGl) {
      sunLight.shadow.mapSize.width = 1024;
      sunLight.shadow.mapSize.height = 1024;
      const d = 22;
      sunLight.shadow.camera.left = -d;
      sunLight.shadow.camera.right = d;
      sunLight.shadow.camera.top = d;
      sunLight.shadow.camera.bottom = -d;
      sunLight.shadow.camera.near = 2;
      sunLight.shadow.camera.far = 65;
      sunLight.shadow.bias = -0.0005;
      sunLight.shadow.normalBias = 0.02;
    }
    scene.add(sunLight);

    // 4. Build Várzea Dirt Field, Puddles, Brick Walls, Fences, Trees, Flip-Flops & Spectator
    const world = buildVarzeaEnvironment(renderer, isSoftwareGl);
    scene.add(world.sceneGroup);

    // 5. Build 3D Soccer Ball + Ground Shadow
    const ballRadius = 0.22;
    const ballTex = createSoccerBallTexture();
    const ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(ballRadius, 20, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: ballTex,
        roughness: 0.55,
        metalness: 0.05,
      })
    );
    ballMesh.castShadow = !isSoftwareGl;
    scene.add(ballMesh);

    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 16).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x1a120b,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      })
    );
    scene.add(ballShadow);

    // 6. Initialize Players (4 Home: Yuri, Josué, Careca, Bode + 4 Away: Primo, Bicudo, Ismael, Felipe)
    const playersGroup = new THREE.Group();
    scene.add(playersGroup);

    let playersState: PlayerRuntimeState[] = [];
    const playerRigs = new Map<string, HumanRig>();
    let controlledPlayerId =
      propsRef.current.onlineControlledCharacterId || 'home_1';
    let celebratingPlayerId: string | null = null;

    const createPlayersFromConfig = () => {
      playersGroup.clear();
      playerRigs.clear();

      const {
        homePlayersConfig: hCfg,
        awayPlayersConfig: aCfg,
        activeRoom: roomCfg,
      } = propsRef.current;

      const matchMode = roomCfg?.mode === '2v2' ? '2v2' : '4v4';
      const activeTeams = getActivePlayersForMode(
        hCfg,
        aCfg,
        matchMode,
        roomCfg?.activeCharacterIds
      );

      const nextPlayers: PlayerRuntimeState[] = [];

      activeTeams.home.forEach((cfg, idx) => {
        const slot = HOME_FORMATION[idx] || { x: -4 - idx * 2, z: 0 };
        const pState: PlayerRuntimeState = {
          id: cfg.id,
          team: 'home',
          config: cfg,
          x: slot.x,
          y: getTerrainHeightAt(slot.x, slot.z),
          z: slot.z,
          vx: 0,
          vz: 0,
          facingAngle: Math.PI / 2,
          animState: 'idle',
          animTimer: 0,
          stridePhase: idx * 1.1,
          stamina: 100,
          isSprinting: false,
          tackleCooldown: 0,
          stunTimer: 0,
          homeX: slot.x,
          homeZ: slot.z,
          hasBall: false,
          inMud: false,
          inPuddle: false,
        };
        nextPlayers.push(pState);
        const rig = buildHumanPlayerRig(cfg, cfg.id === controlledPlayerId);
        rig.root.position.set(pState.x, pState.y, pState.z);
        rig.root.rotation.y = pState.facingAngle;
        playersGroup.add(rig.root);
        playerRigs.set(cfg.id, rig);
      });

      activeTeams.away.forEach((cfg, idx) => {
        const slot = AWAY_FORMATION[idx] || { x: 4 + idx * 2, z: 0 };
        const pState: PlayerRuntimeState = {
          id: cfg.id,
          team: 'away',
          config: cfg,
          x: slot.x,
          y: getTerrainHeightAt(slot.x, slot.z),
          z: slot.z,
          vx: 0,
          vz: 0,
          facingAngle: -Math.PI / 2,
          animState: 'idle',
          animTimer: 0,
          stridePhase: idx * 1.3,
          stamina: 100,
          isSprinting: false,
          tackleCooldown: 0,
          stunTimer: 0,
          homeX: slot.x,
          homeZ: slot.z,
          hasBall: false,
          inMud: false,
          inPuddle: false,
        };
        nextPlayers.push(pState);
        const rig = buildHumanPlayerRig(cfg, false);
        rig.root.position.set(pState.x, pState.y, pState.z);
        rig.root.rotation.y = pState.facingAngle;
        playersGroup.add(rig.root);
        playerRigs.set(cfg.id, rig);
      });

      playersState = nextPlayers;
      if (!playersState.some((p) => p.id === controlledPlayerId) && playersState.length > 0) {
        controlledPlayerId = playersState[0].id;
      }
    };

    createPlayersFromConfig();

    const ballState: BallState = {
      x: 0,
      y: getTerrainHeightAt(0, 0) + ballRadius,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      radius: ballRadius,
      spinX: 0,
      spinZ: 0,
      ownerId: null,
      lastTouchTeam: null,
      lastTouchPlayerName: null,
      inPuddle: false,
    };

    // Match runtime state
    let matchPhase: MatchPhase = 'open_play';
    let phaseTimer = 0;
    let currentHalf: 1 | 2 = 1;
    let remainingHalfSeconds = propsRef.current.settings.halfDurationSeconds;
    let lastReportedSecond = -1;
    let bannerMessage: string | null = null;
    let bannerSubtext: string | null = null;
    let hitstopTimer = 0;
    let lastNetworkSyncMs = 0;

    const stats: MatchStats = {
      homeGoals: 0,
      awayGoals: 0,
      homeShots: 0,
      awayShots: 0,
      homePasses: 0,
      awayPasses: 0,
      homeTackles: 0,
      awayTackles: 0,
      homePossessionFrames: 1,
      awayPossessionFrames: 1,
      scorers: [],
    };

    const resetPositionsToKickoff = () => {
      ballState.x = 0;
      ballState.z = 0;
      ballState.y = getTerrainHeightAt(0, 0) + ballRadius;
      ballState.vx = 0;
      ballState.vy = 0;
      ballState.vz = 0;
      ballState.ownerId = null;
      celebratingPlayerId = null;

      playersState.forEach((p, idx) => {
        const slot =
          p.team === 'home'
            ? HOME_FORMATION[idx % 4]
            : AWAY_FORMATION[idx % 4];
        p.x = slot.x;
        p.z = slot.z;
        p.y = getTerrainHeightAt(p.x, p.z);
        p.vx = 0;
        p.vz = 0;
        p.facingAngle = p.team === 'home' ? Math.PI / 2 : -Math.PI / 2;
        p.animState = 'idle';
        p.animTimer = 0;
        p.stunTimer = 0;
        p.hasBall = false;
      });
      controlledPlayerId =
        propsRef.current.onlineControlledCharacterId || 'home_1';
    };

    const resetFullMatch = () => {
      stats.homeGoals = 0;
      stats.awayGoals = 0;
      stats.homeShots = 0;
      stats.awayShots = 0;
      stats.homePasses = 0;
      stats.awayPasses = 0;
      stats.homeTackles = 0;
      stats.awayTackles = 0;
      stats.homePossessionFrames = 1;
      stats.awayPossessionFrames = 1;
      stats.scorers = [];
      currentHalf = 1;
      remainingHalfSeconds = propsRef.current.settings.halfDurationSeconds;
      matchPhase = 'open_play';
      phaseTimer = 0;
      bannerMessage = 'BOLA ROLANDO NO TERREIRÃO!';
      bannerSubtext = '1º Tempo · Várzea Raiz 4x4';
      setTimeout(() => {
        if (bannerMessage === 'BOLA ROLANDO NO TERREIRÃO!') {
          bannerMessage = null;
          bannerSubtext = null;
        }
      }, 2200);
      resetPositionsToKickoff();
      audioEngine.playWhistle('short');
      audioEngine.startAmbientLoop();
      propsRef.current.onScoreAndClockUpdate(
        0,
        0,
        1,
        remainingHalfSeconds,
        'open_play'
      );
    };

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const cameraRig = new VarzeaCameraRig();
    const _projVec = new THREE.Vector3();
    const _ballVec = new THREE.Vector3();

    let lastHandledRebuild = rebuildRigsSignalRef.current;
    let lastHandledRestart = restartSignalRef.current;
    let prevScreenState = propsRef.current.screenState;

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      if (w <= 0 || h <= 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => onResize())
        : null;
    if (resizeObserver) {
      resizeObserver.observe(container);
    }

    // Helper to execute a pass or shot from a player
    const executeBallStrike = (
      player: PlayerRuntimeState,
      kind: 'pass' | 'long_pass' | 'shoot' | 'header',
      power: number,
      aimX?: number,
      aimZ?: number
    ) => {
      const dirX =
        aimX !== undefined ? aimX - player.x : Math.sin(player.facingAngle);
      const dirZ =
        aimZ !== undefined ? aimZ - player.z : Math.cos(player.facingAngle);
      const len = Math.hypot(dirX, dirZ) || 1;
      const nx = dirX / len;
      const nz = dirZ / len;

      player.facingAngle = Math.atan2(nx, nz);
      player.hasBall = false;
      ballState.ownerId = null;
      ballState.lastTouchTeam = player.team;
      ballState.lastTouchPlayerName = player.config.name;

      ballState.x = player.x + nx * 0.65;
      ballState.z = player.z + nz * 0.65;

      if (kind === 'pass') {
        const speed = 11.5 * player.config.kickStat;
        ballState.vx = nx * speed;
        ballState.vz = nz * speed;
        ballState.vy = 1.1;
        player.animState = 'pass';
        player.animTimer = 0;
        if (player.team === 'home') stats.homePasses++;
        else stats.awayPasses++;
        audioEngine.playKick(0.45);
        world.particles.spawnBurst(
          ballState.x,
          ballState.y,
          ballState.z,
          'dust',
          5
        );
      } else if (kind === 'long_pass') {
        const speed = 15.5 * player.config.kickStat;
        ballState.vx = nx * speed;
        ballState.vz = nz * speed;
        ballState.vy = 5.4;
        player.animState = 'kick';
        player.animTimer = 0;
        if (player.team === 'home') stats.homePasses++;
        else stats.awayPasses++;
        audioEngine.playKick(0.75);
        world.particles.spawnBurst(
          ballState.x,
          ballState.y,
          ballState.z,
          'dust',
          9
        );
      } else if (kind === 'header') {
        const speed = 12.5 * player.config.kickStat;
        ballState.vx = nx * speed;
        ballState.vz = nz * speed;
        ballState.vy = 3.2;
        player.animState = 'header';
        player.animTimer = 0;
        audioEngine.playKick(0.6);
      } else {
        const clampedPower = THREE.MathUtils.clamp(power, 0.35, 1.0);
        const speed = (13.0 + clampedPower * 11.5) * player.config.kickStat;
        ballState.vx = nx * speed;
        ballState.vz = nz * speed;
        ballState.vy = 1.6 + clampedPower * 4.4;
        player.animState = 'kick';
        player.animTimer = 0;
        if (player.team === 'home') stats.homeShots++;
        else stats.awayShots++;

        audioEngine.playKick(clampedPower);
        const pKind = player.inPuddle
          ? 'water'
          : player.inMud
          ? 'mud'
          : 'dust';
        world.particles.spawnBurst(
          ballState.x,
          0.05,
          ballState.z,
          pKind,
          clampedPower > 0.7 ? 14 : 7
        );
        if (clampedPower > 0.72) {
          cameraRig.addTrauma(0.32);
          hitstopTimer = 0.035;
        }
      }
    };

    // 7. Main Simulation & Render Loop (with Software-WebGL afterDraw guard)
    let frameId = 0;
    let lastTimestamp = performance.now();
    let elapsedTime = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      const now = performance.now();
      const rawDt = (now - lastTimestamp) / 1000;
      lastTimestamp = now;
      const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
      elapsedTime += dt;

      const currentProps = propsRef.current;

      if (rebuildRigsSignalRef.current !== lastHandledRebuild) {
        lastHandledRebuild = rebuildRigsSignalRef.current;
        createPlayersFromConfig();
      }

      if (restartSignalRef.current !== lastHandledRestart) {
        lastHandledRestart = restartSignalRef.current;
        resetFullMatch();
      }

      if (prevScreenState === 'title' && currentProps.screenState === 'playing') {
        cameraRig.resetOffsets();
        resetFullMatch();
      } else if (
        prevScreenState === 'playing' &&
        currentProps.screenState !== 'playing'
      ) {
        audioEngine.stopAmbientLoop();
      }
      prevScreenState = currentProps.screenState;

      // Online Multiplayer role check
      const room = currentProps.activeRoom;
      const isOnlineMatch = Boolean(room && room.roomCode);
      const myUid = auth.currentUser?.uid;
      const isOnlineHost =
        !isOnlineMatch || !room?.hostUid || room.hostUid === myUid;

      if (isOnlineMatch && currentProps.onlineControlledCharacterId) {
        controlledPlayerId = currentProps.onlineControlledCharacterId;
      }

      const input = inputManager.sampleFrame(dt);

      if (
        input.pauseJustPressed &&
        (currentProps.screenState === 'playing' ||
          currentProps.screenState === 'paused')
      ) {
        currentProps.onTogglePause();
      }

      cameraRig.mouseYawOffset = THREE.MathUtils.clamp(
        cameraRig.mouseYawOffset - input.mouseDeltaX,
        -0.8,
        0.8
      );
      cameraRig.mousePitchOffset = THREE.MathUtils.clamp(
        cameraRig.mousePitchOffset + input.mouseDeltaY,
        -0.5,
        0.7
      );

      const isSimulating =
        currentProps.screenState === 'playing' ||
        currentProps.screenState === 'title';

      if (hitstopTimer > 0) {
        hitstopTimer = Math.max(0, hitstopTimer - dt);
      } else if (isSimulating) {
        // If Online Non-Host Client: interpolate authoritative ball, clock, score & non-controlled players from room.matchState
        if (isOnlineMatch && !isOnlineHost && room?.matchState) {
          const ms = room.matchState;
          ballState.x = THREE.MathUtils.lerp(ballState.x, ms.ball.x, 0.35);
          ballState.y = THREE.MathUtils.lerp(ballState.y, ms.ball.y, 0.35);
          ballState.z = THREE.MathUtils.lerp(ballState.z, ms.ball.z, 0.35);
          ballState.vx = ms.ball.vx;
          ballState.vy = ms.ball.vy;
          ballState.vz = ms.ball.vz;
          matchPhase = ms.phase || 'open_play';
          celebratingPlayerId = ms.celebratingPlayerId || null;
          bannerMessage = ms.bannerMessage;
          bannerSubtext = ms.bannerSubtext;

          playersState.forEach((p) => {
            if (p.id !== controlledPlayerId && ms.players?.[p.id]) {
              const netP = ms.players[p.id];
              p.x = THREE.MathUtils.lerp(p.x, netP.x, 0.35);
              p.z = THREE.MathUtils.lerp(p.z, netP.z, 0.35);
              p.y = getTerrainHeightAt(p.x, p.z);
              p.vx = netP.vx;
              p.vz = netP.vz;
              p.facingAngle = netP.facingAngle;
              p.animState = netP.animState;
            }
          });
        }

        // Match Clock in 'playing' (Authoritative on Host or Singleplayer)
        if (
          isOnlineHost &&
          currentProps.screenState === 'playing' &&
          matchPhase === 'open_play'
        ) {
          remainingHalfSeconds = Math.max(0, remainingHalfSeconds - dt);
          const secInt = Math.ceil(remainingHalfSeconds);
          if (secInt !== lastReportedSecond) {
            lastReportedSecond = secInt;
            currentProps.onScoreAndClockUpdate(
              stats.homeGoals,
              stats.awayGoals,
              currentHalf,
              secInt,
              matchPhase
            );
          }

          if (remainingHalfSeconds <= 0) {
            if (currentHalf === 1) {
              matchPhase = 'halftime';
              phaseTimer = 2.6;
              audioEngine.playWhistle('fulltime');
              bannerMessage = 'FIM DO 1º TEMPO!';
              bannerSubtext = 'Virando de lado no campinho de terra...';
            } else {
              matchPhase = 'fulltime';
              audioEngine.playWhistle('fulltime');
              currentProps.onMatchFinished({ ...stats });
            }
          }
        }

        // Phase transitions (Goal Celebration, Throw-in, Halftime)
        if (isOnlineHost) {
          if (matchPhase === 'goal_celebration') {
            phaseTimer -= dt;
            if (phaseTimer <= 0) {
              matchPhase = 'open_play';
              bannerMessage = null;
              bannerSubtext = null;
              resetPositionsToKickoff();
              audioEngine.playWhistle('short');
            }
          } else if (matchPhase === 'throw_in') {
            phaseTimer -= dt;
            if (phaseTimer <= 0) {
              matchPhase = 'open_play';
              bannerMessage = null;
              bannerSubtext = null;
            }
          } else if (matchPhase === 'halftime') {
            phaseTimer -= dt;
            if (phaseTimer <= 0) {
              currentHalf = 2;
              remainingHalfSeconds = currentProps.settings.halfDurationSeconds;
              matchPhase = 'open_play';
              bannerMessage = 'COMEÇA O 2º TEMPO!';
              bannerSubtext = 'Agora vale tudo na várzea!';
              resetPositionsToKickoff();
              audioEngine.playWhistle('short');
              setTimeout(() => {
                if (bannerMessage === 'COMEÇA O 2º TEMPO!') {
                  bannerMessage = null;
                  bannerSubtext = null;
                }
              }, 2000);
            }
          }
        }

        // Switch active player with Q (only in offline / singleplayer mode; in online mode each human controls their locked character)
        if (
          !isOnlineMatch &&
          currentProps.screenState === 'playing' &&
          input.switchJustPressed
        ) {
          controlledPlayerId = findBestSwitchTeammate(
            controlledPlayerId,
            ballState,
            playersState
          );
        }

        // Auto-switch to teammate if a teammate gains possession of the ball (offline mode)
        const currentControlledPlayer = playersState.find(
          (p) => p.id === controlledPlayerId
        );
        const userTeam = currentControlledPlayer?.team || 'home';
        if (
          !isOnlineMatch &&
          currentProps.screenState === 'playing' &&
          ballState.ownerId &&
          ballState.ownerId.startsWith(`${userTeam}_`) &&
          ballState.ownerId !== controlledPlayerId
        ) {
          controlledPlayerId = ballState.ownerId;
        }

        const celebratingScorer = playersState.find(
          (p) => p.id === celebratingPlayerId
        );

        // Update all 8 players
        for (let i = 0; i < playersState.length; i++) {
          const p = playersState[i];
          const isUserControlled =
            currentProps.screenState === 'playing' &&
            p.id === controlledPlayerId;

          // If online host, check if this character is controlled by another remote human client
          const slotInfo = room?.slots?.[p.id];
          const isRemoteHumanOnHost =
            isOnlineMatch &&
            isOnlineHost &&
            slotInfo &&
            !slotInfo.isBot &&
            slotInfo.uid &&
            slotInfo.uid !== myUid;

          if (isRemoteHumanOnHost && room?.matchState?.players?.[p.id]) {
            const remoteP = room.matchState.players[p.id];
            p.x = THREE.MathUtils.lerp(p.x, remoteP.x, 0.4);
            p.z = THREE.MathUtils.lerp(p.z, remoteP.z, 0.4);
            p.y = getTerrainHeightAt(p.x, p.z);
            p.vx = remoteP.vx;
            p.vz = remoteP.vz;
            p.facingAngle = remoteP.facingAngle;
            p.animState = remoteP.animState;
            continue;
          }

          // If online non-host client, only simulate the locally controlled player
          if (isOnlineMatch && !isOnlineHost && !isUserControlled) {
            continue;
          }

          if (p.tackleCooldown > 0)
            p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);
          if (p.stunTimer > 0) {
            p.stunTimer = Math.max(0, p.stunTimer - dt);
            p.animState = 'fall';
            p.animTimer += dt;
            p.vx *= 0.85;
            p.vz *= 0.85;
          }

          const mudInfo = getMudSpeedMultiplier(p.x, p.z);
          p.inMud = mudInfo.inMud;
          p.inPuddle = mudInfo.inPuddle;

          if (matchPhase === 'goal_celebration') {
            p.animTimer += dt;
            if (celebratingScorer && p.id === celebratingScorer.id) {
              // Goal scorer runs briefly toward the sideline camera, then performs their signature 3D celebration!
              const targetZ = Math.min(6.2, p.z + 2.5);
              if (p.animTimer < 0.55 && p.z < 5.0) {
                p.vx = 0;
                p.vz = 4.2;
                p.facingAngle = 0; // Face +Z camera
                p.stridePhase += 4.2 * dt * 2.4;
              } else {
                p.vx = 0;
                p.vz = 0;
                p.facingAngle = 0; // Face camera for celebration
              }
              p.z = Math.min(targetZ, p.z + p.vz * dt);
              p.animState = 'celebrate';
            } else if (
              celebratingScorer &&
              p.team === celebratingScorer.team
            ) {
              // Teammates jog toward the goal scorer to celebrate together!
              const dx = celebratingScorer.x - p.x;
              const dz = celebratingScorer.z - p.z;
              const dist = Math.hypot(dx, dz);
              if (dist > 1.65) {
                const speed = 4.6;
                p.vx = (dx / dist) * speed;
                p.vz = (dz / dist) * speed;
                p.facingAngle = Math.atan2(p.vx, p.vz);
                p.stridePhase += speed * dt * 2.3;
                p.animState = 'run';
              } else {
                p.vx = 0;
                p.vz = 0;
                p.facingAngle = Math.atan2(dx, dz);
                p.animState = 'celebrate';
              }
            } else {
              // Conceding team stands idle
              p.vx = 0;
              p.vz = 0;
              p.animState = 'idle';
            }
          } else if (p.stunTimer <= 0) {
            let moveX = 0;
            let moveZ = 0;
            let wantSprint = false;

            if (isUserControlled) {
              moveX = input.moveX;
              moveZ = input.moveZ;
              wantSprint = input.sprintHeld && p.stamina > 8;

              if (input.tackleJustPressed && p.tackleCooldown <= 0) {
                p.tackleCooldown = 1.25;
                p.animState = 'tackle';
                p.animTimer = 0;
                const lungeSpeed = 9.2 * p.config.tackleStat;
                p.vx = Math.sin(p.facingAngle) * lungeSpeed;
                p.vz = Math.cos(p.facingAngle) * lungeSpeed;
                audioEngine.playSlideTackle(p.inPuddle);
                world.particles.spawnBurst(
                  p.x,
                  0.05,
                  p.z,
                  p.inPuddle ? 'water' : 'mud',
                  12
                );
              }

              const distBall = Math.hypot(
                ballState.x - p.x,
                ballState.z - p.z
              );
              if (input.headerJustPressed && distBall < 1.55) {
                executeBallStrike(p, 'header', 0.75);
              }

              if (
                (input.passJustPressed || input.longPassJustPressed) &&
                distBall < 1.45
              ) {
                const mates = playersState.filter(
                  (m) => m.team === p.team && m.id !== p.id
                );
                let targetMate = mates[0];
                let bestScore = -Infinity;
                const aimDirX =
                  Math.abs(moveX) > 0.1 || Math.abs(moveZ) > 0.1
                    ? moveX
                    : Math.sin(p.facingAngle);
                const aimDirZ =
                  Math.abs(moveX) > 0.1 || Math.abs(moveZ) > 0.1
                    ? moveZ
                    : Math.cos(p.facingAngle);
                for (const m of mates) {
                  const dx = m.x - p.x;
                  const dz = m.z - p.z;
                  const d = Math.hypot(dx, dz) || 1;
                  const align = (dx * aimDirX + dz * aimDirZ) / d;
                  const score = align * 2.0 - d * 0.04;
                  if (score > bestScore) {
                    bestScore = score;
                    targetMate = m;
                  }
                }
                executeBallStrike(
                  p,
                  input.longPassJustPressed ? 'long_pass' : 'pass',
                  0.65,
                  targetMate
                    ? targetMate.x + (p.team === 'home' ? 1.2 : -1.2)
                    : undefined,
                  targetMate ? targetMate.z : undefined
                );
              }

              if (input.kickJustReleased && distBall < 1.55) {
                const targetGoalX =
                  p.team === 'home'
                    ? DEFAULT_PITCH.width / 2
                    : -DEFAULT_PITCH.width / 2;
                const aimX =
                  Math.abs(moveX) > 0.15 ? p.x + moveX * 12 : targetGoalX;
                const aimZ =
                  Math.abs(moveZ) > 0.15
                    ? moveZ * (DEFAULT_PITCH.goalWidth * 0.45)
                    : (Math.random() - 0.5) * 1.4;
                executeBallStrike(
                  p,
                  'shoot',
                  input.kickChargePower,
                  aimX,
                  aimZ
                );
              }
            } else {
              // AI control for teammates and opponents (Primo, Bicudo, Ismael, Felipe)
              const ai = computeAIDecision(
                p,
                ballState,
                playersState,
                currentProps.settings.aiDifficulty
              );
              moveX = ai.moveX;
              moveZ = ai.moveZ;
              wantSprint = ai.sprint;

              if (ai.action === 'tackle' && p.tackleCooldown <= 0) {
                p.tackleCooldown = 1.4;
                p.animState = 'tackle';
                p.animTimer = 0;
                p.vx = Math.sin(p.facingAngle) * 8.4;
                p.vz = Math.cos(p.facingAngle) * 8.4;
                audioEngine.playSlideTackle(p.inPuddle);
                world.particles.spawnBurst(p.x, 0.05, p.z, 'mud', 10);
              } else if (ai.action === 'pass' || ai.action === 'clear') {
                executeBallStrike(
                  p,
                  ai.action === 'clear' ? 'long_pass' : 'pass',
                  0.7,
                  ai.targetX,
                  ai.targetZ
                );
              } else if (ai.action === 'shoot') {
                executeBallStrike(
                  p,
                  'shoot',
                  0.78,
                  ai.targetX,
                  ai.targetZ
                );
              }
            }

            if (
              p.animState === 'tackle' ||
              p.animState === 'kick' ||
              p.animState === 'pass' ||
              p.animState === 'header'
            ) {
              p.animTimer += dt;
              const maxDur = p.animState === 'tackle' ? 0.48 : 0.34;
              if (p.animState === 'tackle') {
                p.vx *= Math.exp(-3.2 * dt);
                p.vz *= Math.exp(-3.2 * dt);
              }
              if (p.animTimer >= maxDur) {
                p.animState = 'idle';
                p.animTimer = 0;
              }
            }

            if (p.animState !== 'tackle') {
              p.isSprinting =
                wantSprint &&
                (Math.abs(moveX) > 0.05 || Math.abs(moveZ) > 0.05);
              if (p.isSprinting) {
                p.stamina = Math.max(0, p.stamina - 14 * dt);
              } else {
                p.stamina = Math.min(100, p.stamina + 11 * dt);
              }

              const baseSpeed = 5.4 * p.config.speedStat * mudInfo.multiplier;
              const topSpeed = p.isSprinting ? baseSpeed * 1.34 : baseSpeed;

              const targetVX = moveX * topSpeed;
              const targetVZ = moveZ * topSpeed;
              p.vx = THREE.MathUtils.damp(p.vx, targetVX, 10, dt);
              p.vz = THREE.MathUtils.damp(p.vz, targetVZ, 10, dt);

              const speed = Math.hypot(p.vx, p.vz);
              if (speed > 0.25) {
                const targetAngle = Math.atan2(p.vx, p.vz);
                let diff = targetAngle - p.facingAngle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                p.facingAngle += diff * Math.min(1, 12 * dt);

                const prevStride = p.stridePhase;
                p.stridePhase += speed * dt * 2.35;

                if (
                  Math.floor(prevStride / Math.PI) !==
                  Math.floor(p.stridePhase / Math.PI)
                ) {
                  if (isUserControlled || Math.random() < 0.25) {
                    audioEngine.playFootstep(p.inPuddle, p.inMud);
                  }
                  if (p.inPuddle) {
                    world.particles.spawnBurst(p.x, 0.03, p.z, 'water', 4);
                  } else if (p.isSprinting) {
                    world.particles.spawnBurst(
                      p.x,
                      0.03,
                      p.z,
                      p.inMud ? 'mud' : 'dust',
                      3
                    );
                  }
                }

                if (
                  p.animState !== 'kick' &&
                  p.animState !== 'pass' &&
                  p.animState !== 'header'
                ) {
                  p.animState = p.isSprinting ? 'run' : 'walk';
                }
              } else if (
                p.animState !== 'kick' &&
                p.animState !== 'pass' &&
                p.animState !== 'header'
              ) {
                p.animState = 'idle';
              }
            }
          }

          p.x = THREE.MathUtils.clamp(
            p.x + p.vx * dt,
            -DEFAULT_PITCH.width / 2 - 2.0,
            DEFAULT_PITCH.width / 2 + 2.0
          );
          p.z = THREE.MathUtils.clamp(
            p.z + p.vz * dt,
            -DEFAULT_PITCH.depth / 2 - 2.0,
            DEFAULT_PITCH.depth / 2 + 2.0
          );
          p.y = getTerrainHeightAt(p.x, p.z);

          if (
            isOnlineHost &&
            matchPhase === 'open_play' &&
            p.animState !== 'kick' &&
            p.animState !== 'pass'
          ) {
            resolvePlayerBallInteraction(p, ballState, playersState);
          }
        }

        // Player-to-Player Collisions & Slide Tackle Dispossessions
        for (let i = 0; i < playersState.length; i++) {
          for (let j = i + 1; j < playersState.length; j++) {
            const a = playersState[i];
            const b = playersState[j];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const dist = Math.hypot(dx, dz);
            const minSep = 0.68;

            if (dist > 0.001 && dist < minSep) {
              const nx = dx / dist;
              const nz = dz / dist;
              const overlap = (minSep - dist) * 0.5;
              a.x -= nx * overlap;
              a.z -= nz * overlap;
              b.x += nx * overlap;
              b.z += nz * overlap;

              if (Math.random() < 0.08) {
                audioEngine.playCollision();
              }

              if (
                a.animState === 'tackle' &&
                b.team !== a.team &&
                b.stunTimer <= 0
              ) {
                b.stunTimer = 1.05;
                b.hasBall = false;
                if (ballState.ownerId === b.id) {
                  ballState.ownerId = a.id;
                  ballState.vx = Math.sin(a.facingAngle) * 4.5;
                  ballState.vz = Math.cos(a.facingAngle) * 4.5;
                }
                if (a.team === 'home') stats.homeTackles++;
                else stats.awayTackles++;
                cameraRig.addTrauma(0.22);
              } else if (
                b.animState === 'tackle' &&
                a.team !== b.team &&
                a.stunTimer <= 0
              ) {
                a.stunTimer = 1.05;
                a.hasBall = false;
                if (ballState.ownerId === a.id) {
                  ballState.ownerId = b.id;
                  ballState.vx = Math.sin(b.facingAngle) * 4.5;
                  ballState.vz = Math.cos(b.facingAngle) * 4.5;
                }
                if (b.team === 'home') stats.homeTackles++;
                else stats.awayTackles++;
                cameraRig.addTrauma(0.22);
              }
            }
          }
        }

        if (ballState.lastTouchTeam === 'home') stats.homePossessionFrames++;
        else if (ballState.lastTouchTeam === 'away')
          stats.awayPossessionFrames++;

        // Step Authoritative Ball Physics (on Host or Offline)
        if (isOnlineHost && matchPhase === 'open_play') {
          const ballEvents = stepBallPhysics(ballState, dt, DEFAULT_PITCH);

          if (ballEvents.bouncedOnDirt) {
            audioEngine.playDirtBounce(0.55);
            world.particles.spawnBurst(
              ballState.x,
              0.02,
              ballState.z,
              'dust',
              4
            );
          }
          if (ballEvents.splashedInPuddle) {
            world.particles.spawnBurst(
              ballState.x,
              0.03,
              ballState.z,
              'water',
              7
            );
          }
          if (ballEvents.hitGoalpost) {
            audioEngine.playGoalpostHit();
            cameraRig.addTrauma(0.28);
          }

          // Handle Goal Scored
          if (
            ballEvents.goalScored &&
            currentProps.screenState === 'playing'
          ) {
            const scoringTeam = ballEvents.goalScored;
            if (scoringTeam === 'home') {
              stats.homeGoals++;
              world.triggerNetRipple('right');
            } else {
              stats.awayGoals++;
              world.triggerNetRipple('left');
            }

            const scorerName =
              ballState.lastTouchPlayerName ||
              (scoringTeam === 'home' ? 'Yuri' : 'Primo');

            const scorerPlayer =
              playersState.find((p) => p.config.name === scorerName) ||
              playersState.find((p) => p.team === scoringTeam) ||
              playersState[0];

            celebratingPlayerId = scorerPlayer.id;
            scorerPlayer.animTimer = 0;

            const elapsedInHalf =
              currentProps.settings.halfDurationSeconds - remainingHalfSeconds;
            stats.scorers.push({
              playerName: scorerName,
              team: scoringTeam,
              timeFormatted: formatMatchTime(elapsedInHalf),
              half: currentHalf,
            });

            matchPhase = 'goal_celebration';
            phaseTimer = 3.4; // Enough time to watch the custom 3D celebration & teammates gathering
            bannerMessage = `GOOOOL DO ${
              scoringTeam === 'home'
                ? currentProps.homeTeam.name.toUpperCase()
                : currentProps.awayTeam.name.toUpperCase()
            }!`;
            bannerSubtext = `${scorerName} mandou pra rede e puxou a comemoração na várzea!`;

            audioEngine.playGoalCelebration();
            cameraRig.addTrauma(0.45);
            world.particles.spawnBurst(
              ballState.x,
              ballState.y,
              ballState.z,
              'dust',
              22
            );

            currentProps.onScoreAndClockUpdate(
              stats.homeGoals,
              stats.awayGoals,
              currentHalf,
              Math.ceil(remainingHalfSeconds),
              matchPhase
            );
          } else if (
            ballEvents.outOfBounds &&
            currentProps.screenState === 'playing'
          ) {
            const out = ballEvents.outOfBounds;
            matchPhase = 'throw_in';
            phaseTimer = 1.1;

            ballState.x = out.restartX;
            ballState.z = out.restartZ;
            ballState.y =
              getTerrainHeightAt(out.restartX, out.restartZ) + ballRadius;
            ballState.vx = 0;
            ballState.vy = 0;
            ballState.vz = 0;
            ballState.ownerId = null;

            const teamPlayers = playersState.filter(
              (p) => p.team === out.awardedTeam && p.config.role !== 'goleiro'
            );
            if (teamPlayers.length > 0) {
              teamPlayers.sort(
                (a, b) =>
                  Math.hypot(a.x - out.restartX, a.z - out.restartZ) -
                  Math.hypot(b.x - out.restartX, b.z - out.restartZ)
              );
              const taker = teamPlayers[0];
              taker.x = out.restartX;
              taker.z = out.restartZ;
              taker.vx = 0;
              taker.vz = 0;
              taker.facingAngle = Math.atan2(-out.restartX, -out.restartZ);
              if (!isOnlineMatch && out.awardedTeam === 'home') {
                controlledPlayerId = taker.id;
              }
            }

            audioEngine.playWhistle('short');
            bannerMessage =
              out.type === 'throw_in'
                ? 'COBRANÇA DE LATERAL'
                : out.type === 'corner'
                ? 'ESCANTEIO NA TERRA'
                : 'TIRO DE META';
            bannerSubtext =
              out.awardedTeam === 'home'
                ? `Posse: ${currentProps.homeTeam.name}`
                : `Posse: ${currentProps.awayTeam.name}`;
          }
        }

        // Network Sync Publishing (~7Hz to Firestore when in an online room)
        if (
          isOnlineMatch &&
          room?.roomCode &&
          currentProps.screenState === 'playing' &&
          now - lastNetworkSyncMs > 140
        ) {
          lastNetworkSyncMs = now;
          if (isOnlineHost) {
            const playersMap: Record<
              string,
              {
                x: number;
                z: number;
                vx: number;
                vz: number;
                facingAngle: number;
                animState: PlayerRuntimeState['animState'];
              }
            > = {};
            playersState.forEach((p) => {
              playersMap[p.id] = {
                x: Number(p.x.toFixed(2)),
                z: Number(p.z.toFixed(2)),
                vx: Number(p.vx.toFixed(2)),
                vz: Number(p.vz.toFixed(2)),
                facingAngle: Number(p.facingAngle.toFixed(2)),
                animState: p.animState,
              };
            });
            publishHostMatchSnapshot(room.roomCode, {
              ball: {
                x: Number(ballState.x.toFixed(2)),
                y: Number(ballState.y.toFixed(2)),
                z: Number(ballState.z.toFixed(2)),
                vx: Number(ballState.vx.toFixed(2)),
                vy: Number(ballState.vy.toFixed(2)),
                vz: Number(ballState.vz.toFixed(2)),
              },
              players: playersMap,
              homeGoals: stats.homeGoals,
              awayGoals: stats.awayGoals,
              half: currentHalf,
              remainingSeconds: Math.ceil(remainingHalfSeconds),
              phase: matchPhase,
              celebratingPlayerId,
              bannerMessage,
              bannerSubtext,
              timestamp: Date.now(),
            });
          } else {
            publishClientInput(room.roomCode, {
              moveX: Number(input.moveX.toFixed(2)),
              moveZ: Number(input.moveZ.toFixed(2)),
              sprint: input.sprintHeld,
              action: input.tackleJustPressed
                ? 'tackle'
                : input.passJustPressed || input.longPassJustPressed
                ? 'pass'
                : input.kickJustReleased
                ? 'shoot'
                : 'none',
              kickPower: Number(input.kickChargePower.toFixed(2)),
              timestamp: Date.now(),
            });
          }
        }
      }

      // 8. Sync 3D Meshes (Ball, Player Rigs, Environment, Camera, Floating Name Labels & Voice Bubbles)
      ballMesh.position.set(ballState.x, ballState.y, ballState.z);
      ballMesh.rotation.z -= (ballState.vx * dt) / ballRadius;
      ballMesh.rotation.x += (ballState.vz * dt) / ballRadius;

      const groundUnderBall = getTerrainHeightAt(ballState.x, ballState.z);
      ballShadow.position.set(
        ballState.x,
        groundUnderBall + 0.016,
        ballState.z
      );
      const heightAbove = Math.max(
        0,
        ballState.y - groundUnderBall - ballRadius
      );
      const shadowScale = Math.max(0.4, 1 - heightAbove * 0.22);
      ballShadow.scale.setScalar(shadowScale);

      _ballVec.set(ballState.x, ballState.y, ballState.z);
      world.updateEnvironment(dt, _ballVec);

      const controlledPlayer = playersState.find(
        (p) => p.id === controlledPlayerId
      );
      const celebratingPlayer = playersState.find(
        (p) => p.id === celebratingPlayerId
      );

      // Update Camera (including celebration spotlight)
      cameraRig.update(
        camera,
        dt,
        currentProps.screenState,
        currentProps.settings.cameraMode,
        currentProps.settings.cameraDistance,
        ballState,
        controlledPlayer,
        matchPhase,
        celebratingPlayer
      );

      const cWidth = container?.clientWidth || window.innerWidth;
      const cHeight = container?.clientHeight || window.innerHeight;

      for (let i = 0; i < playersState.length; i++) {
        const p = playersState[i];
        const rig = playerRigs.get(p.id);
        if (rig) {
          rig.root.position.set(p.x, p.y, p.z);
          rig.root.rotation.y = p.facingAngle;
          const speedRatio = Math.min(1.2, Math.hypot(p.vx, p.vz) / 5.5);
          updateHumanPlayerAnimation(
            rig,
            p.animState,
            p.stridePhase,
            p.animTimer,
            speedRatio,
            currentProps.screenState === 'playing' &&
              p.id === controlledPlayerId,
            elapsedTime
          );
        }

        const labelEl = labelRefs.current[p.id];
        if (labelEl) {
          if (
            !currentProps.settings.showPlayerNames ||
            currentProps.screenState === 'title'
          ) {
            labelEl.style.opacity = '0';
          } else {
            _projVec.set(p.x, p.y + 2.08, p.z);
            _projVec.project(camera);
            if (_projVec.z >= -1 && _projVec.z <= 1) {
              const sx = (_projVec.x * 0.5 + 0.5) * cWidth;
              const sy = (-_projVec.y * 0.5 + 0.5) * cHeight;
              labelEl.style.opacity = '1';
              labelEl.style.transform = `translate3d(${sx.toFixed(
                1
              )}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
            } else {
              labelEl.style.opacity = '0';
            }
          }
        }
      }

      if (controlledPlayer) {
        currentProps.onHUDRefUpdate({
          controlledPlayerName: controlledPlayer.config.name,
          controlledPlayerRole: controlledPlayer.config.role.toUpperCase(),
          stamina: controlledPlayer.stamina,
          kickCharge: input.kickHeld ? input.kickChargePower : 0,
          isChargingKick: input.kickHeld,
          bannerMessage,
          bannerSubtext,
        });
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      audioEngine.stopAmbientLoop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      renderer.dispose();
    };
  }, [inputManager]);

  const matchMode = activeRoom?.mode === '2v2' ? '2v2' : '4v4';
  const activeTeamsForLabels = getActivePlayersForMode(
    homePlayersConfig,
    awayPlayersConfig,
    matchMode,
    activeRoom?.activeCharacterIds
  );

  const allConfigs = [
    ...activeTeamsForLabels.home.map((c) => ({ ...c, team: 'home' as const })),
    ...activeTeamsForLabels.away.map((c) => ({ ...c, team: 'away' as const })),
  ];

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Dedicated WebGL Mount Container */}
      <div
        ref={canvasMountRef}
        data-testid="varzea-canvas-container"
        className="w-full h-full"
      />

      {/* 3D Projected Player Name Labels & WebRTC Live Speaking Indicator (Pointer-events: none) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden z-10">
        {allConfigs.map((p) => {
          const slotInfo = activeRoom?.slots?.[p.id];
          const isSpeakingLive = Boolean(slotInfo && !slotInfo.isBot && slotInfo.isSpeaking);
          return (
            <div
              key={p.id}
              ref={(el) => {
                labelRefs.current[p.id] = el;
              }}
              style={{ opacity: 0, left: 0, top: 0 }}
              className="absolute will-change-transform transition-opacity duration-75 flex flex-col items-center"
            >
              {/* Player Name Badge in UPPERCASE (BODE, JOSUÉ, CARECA, ISMAEL, etc.) */}
              <div
                data-testid={`player-label-${p.name.toLowerCase()}`}
                className={`px-2 py-0.5 rounded text-[11px] font-extrabold tracking-wider uppercase whitespace-nowrap shadow-md flex items-center gap-1 ${
                  p.team === 'home'
                    ? 'bg-stone-950/88 text-amber-300 border border-amber-500/50'
                    : 'bg-stone-950/85 text-stone-100 border border-red-500/50'
                }`}
              >
                {isSpeakingLive && (
                  <span
                    className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"
                    title="Falando no microfone"
                  />
                )}
                <span>{p.name.toUpperCase()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
