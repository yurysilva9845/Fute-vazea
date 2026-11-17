import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AVAILABLE_TEAMS,
  INITIAL_AWAY_PLAYERS,
  INITIAL_HOME_PLAYERS,
} from './game/rules';
import {
  GameScreenState,
  GameSettings,
  MatchPhase,
  MatchStats,
  MultiplayerRoomState,
  PlayerCustomization,
  TeamConfig,
} from './types/game';
import { DEFAULT_KEY_BINDINGS, VarzeaInputManager } from './game/controls';
import { LiveHUDUpdate, MatchCanvas } from './game/MatchCanvas';
import { TitleScreen } from './components/TitleScreen';
import { GameplayHUD } from './components/GameplayHUD';
import { StatusModals } from './components/StatusModals';
import { MultiplayerLobbyModal } from './components/MultiplayerLobbyModal';
import { MatchLoadingOverlay } from './components/MatchLoadingOverlay';
import { CharacterSelect3DModal } from './components/CharacterSelect3DModal';
import { audioEngine } from './game/audio';
import {
  ClientInputState,
  ensureAuthenticated,
  getCurrentAuthUser,
  leaveOnlineRoom,
  markPlayerMatchLoadingReady,
  promoteRoomToPlaying,
  recordMatchFinished,
  subscribeToMyProfile,
  subscribeToRoom,
} from './services/firebase';
import { presenceService } from './services/presenceService';
import { voiceChatService } from './services/voiceChatService';
import { realtimeMatchClient } from './services/realtimeMatchClient';

export default function App() {
  const [screenState, setScreenState] = useState<GameScreenState>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') {
        return 'playing';
      }
    }
    return 'title';
  });

  const screenStateRef = useRef<GameScreenState>(screenState);
  useEffect(() => {
    screenStateRef.current = screenState;
  }, [screenState]);

  const [homeTeam, setHomeTeam] = useState<TeamConfig>(AVAILABLE_TEAMS[0]);
  const [awayTeam, setAwayTeam] = useState<TeamConfig>(AVAILABLE_TEAMS[2]);

  const [homePlayers, setHomePlayers] = useState<PlayerCustomization[]>(
    INITIAL_HOME_PLAYERS
  );
  const [awayPlayers, setAwayPlayers] = useState<PlayerCustomization[]>(
    INITIAL_AWAY_PLAYERS
  );

  const [settings, setSettings] = useState<GameSettings>({
    cameraMode: 'follow',
    cameraDistance: 1.0,
    soundEnabled: true,
    musicEnabled: false,
    sfxVolume: 0.85,
    ambientVolume: 0.65,
    musicVolume: 0.5,
    vibrationEnabled: true,
    halfDurationSeconds: 300,
    aiDifficulty: 'equilibrado',
    showPlayerNames: true,
    ballControlRadius: 0.92,
    autoSwitchPlayer: true,
    graphicsQuality: 'auto',
    keyBindings: { ...DEFAULT_KEY_BINDINGS },
    mobileControls: {
      scale: 1.0,
      joystickSensitivity: 1.0,
      layoutPreset: 'padrao',
    },
    loadingConfig: {
      minLoadTimeSeconds: 2,
      slowConnectionWarningSeconds: 10,
      maxWaitTimeSeconds: 20,
      extraSlowConnectionSeconds: 5,
    },
  });

  const [scoreAndClock, setScoreAndClock] = useState<{
    homeGoals: number;
    awayGoals: number;
    half: 1 | 2;
    remainingSeconds: number;
    phase: MatchPhase;
  }>({
    homeGoals: 0,
    awayGoals: 0,
    half: 1,
    remainingSeconds: 300,
    phase: 'open_play',
  });

  const [finalStats, setFinalStats] = useState<MatchStats>({
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
  });

  const [restartSignal, setRestartSignal] = useState(0);

  // Online Multiplayer, Voice Chat & Pre-Match Loading state
  const [multiplayerModalOpen, setMultiplayerModalOpen] = useState<boolean>(false);
  const [characterSelectModalOpen, setCharacterSelectModalOpen] = useState<boolean>(false);
  const [activeRoomCode, setActiveRoomCode] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<
    (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null
  >(null);
  const [onlineControlledCharId, setOnlineControlledCharId] = useState<string>('home_1');
  const [showMatchLoadingOverlay, setShowMatchLoadingOverlay] = useState<boolean>(false);
  const [pingMs, setPingMs] = useState<number>(18);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const inputManager = useMemo(() => new VarzeaInputManager(), []);

  useEffect(() => {
    realtimeMatchClient.setCallbacks({
      onPingUpdate: (rttMs) => setPingMs(rttMs),
    });
    return () => {
      inputManager.dispose();
    };
  }, [inputManager]);

  const lastMarkedReadyKeyRef = useRef<string | null>(null);

  // Boot-time Firebase auth warm-up, profile room recovery & Fullscreen listener
  useEffect(() => {
    const startTs = performance.now();
    ensureAuthenticated()
      .then(() => {
        setPingMs(Math.max(12, Math.min(95, Math.round(performance.now() - startTs))));
      })
      .catch((err) => {
        console.warn('[STF-Auth] Aviso na inicialização de sessão no boot:', err);
      });

    const unsubProfile = subscribeToMyProfile((prof) => {
      if (prof?.currentRoomCode && prof.currentRoomCode.trim().length >= 4) {
        setActiveRoomCode((prev) => prev || prof.currentRoomCode.trim().toUpperCase());
      }
    });

    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      unsubProfile();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  // Persistent root room listener: keeps activeRoom synced in real time and automatically transitions
  // both Host (Client A) and Guest (Client B) when room.status becomes 'starting' or 'playing'
  useEffect(() => {
    if (!activeRoomCode) {
      setActiveRoom(null);
      lastMarkedReadyKeyRef.current = null;
      return;
    }
    const unsub = subscribeToRoom(activeRoomCode, (room) => {
      if (!room) {
        setActiveRoom(null);
        setActiveRoomCode(null);
        setShowMatchLoadingOverlay(false);
        lastMarkedReadyKeyRef.current = null;
        presenceService.stopRoomPresence();
        voiceChatService.leaveRoomVoice();
        return;
      }
      setActiveRoom(room);
      voiceChatService.syncRoomSlots(room.slots || {});

      const myUid = getCurrentAuthUser()?.uid;
      if (myUid) {
        const mySlot = Object.values(room.slots || {}).find((s) => s.uid === myUid);
        if (mySlot) {
          setOnlineControlledCharId(mySlot.characterId);
        }
      }

      if (room.status === 'starting') {
        setMultiplayerModalOpen(false);
        setShowMatchLoadingOverlay(true);
        presenceService.startRoomPresence(room.roomCode, 'in_match');
        const readyKey = `${room.roomCode}:${room.matchId || 'default'}`;
        const alreadyReady = Boolean(myUid && (room.loadingReadyUids || []).includes(myUid));
        if (!alreadyReady && lastMarkedReadyKeyRef.current !== readyKey) {
          lastMarkedReadyKeyRef.current = readyKey;
          markPlayerMatchLoadingReady(room.roomCode).catch(() => {});
        }
      } else if (room.status === 'playing') {
        setMultiplayerModalOpen(false);
        setShowMatchLoadingOverlay(false);
        presenceService.startRoomPresence(room.roomCode, 'in_match');
        if (
          screenStateRef.current !== 'playing' &&
          screenStateRef.current !== 'paused' &&
          screenStateRef.current !== 'gameover'
        ) {
          inputManager.clearAll();
          audioEngine.stopMenuBatucada();
          setRestartSignal((s) => s + 1);
          document.body.dataset.state = 'playing';
          setScreenState('playing');
        }
      }
    });
    return () => unsub();
  }, [activeRoomCode, inputManager]);

  const hudUpdateRef = useRef<LiveHUDUpdate>({
    controlledPlayerName: 'Yuri',
    controlledPlayerRole: 'PIVÔ',
    stamina: 100,
    kickCharge: 0,
    isChargingKick: false,
    bannerMessage: null,
    bannerSubtext: null,
  });

  useEffect(() => {
    document.body.dataset.state = screenState;
  }, [screenState]);

  /**
   * Requests Fullscreen API & Screen Orientation API ('landscape') upon user interaction
   */
  const requestFullscreenAndLandscape = useCallback(async () => {
    if (typeof document !== 'undefined' && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        // Browser may block if not allowed in iframe; friendly fallback banner is shown
      }
    }
    if (
      typeof screen !== 'undefined' &&
      screen.orientation &&
      'lock' in screen.orientation
    ) {
      try {
        await (
          screen.orientation as unknown as {
            lock: (mode: string) => Promise<void>;
          }
        ).lock('landscape');
      } catch {
        // Orientation lock is optional on desktop/iOS Safari
      }
    }
  }, []);

  const exitFullscreenSafe = useCallback(async () => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore
      }
    }
  }, []);

  const handleStartMatch = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (
      typeof window !== 'undefined' &&
      (window.innerWidth <= 920 || 'ontouchstart' in window)
    ) {
      requestFullscreenAndLandscape();
    }
    inputManager.clearAll();
    audioEngine.stopMenuBatucada();
    document.body.dataset.state = 'playing';
    setScreenState('playing');
  }, [inputManager, requestFullscreenAndLandscape]);

  const handleStartFullscreenMatch = useCallback(() => {
    requestFullscreenAndLandscape();
    handleStartMatch();
  }, [requestFullscreenAndLandscape, handleStartMatch]);

  // Bind Enter / Space on Title Screen to start immediately (unless modal is open)
  useEffect(() => {
    if (
      screenState !== 'title' ||
      multiplayerModalOpen ||
      characterSelectModalOpen ||
      showMatchLoadingOverlay
    ) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        tag === 'BUTTON'
      ) {
        return;
      }
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        handleStartMatch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    screenState,
    multiplayerModalOpen,
    characterSelectModalOpen,
    showMatchLoadingOverlay,
    handleStartMatch,
  ]);

  const handleSelectHomeTeam = useCallback((team: TeamConfig) => {
    setHomeTeam(team);
    setHomePlayers((prev) =>
      prev.map((p) =>
        p.lockAuthenticOutfit
          ? p
          : {
              ...p,
              shirtPrimary: team.primaryColor,
              shirtSecondary: team.secondaryColor,
              shortsColor: team.shortsColor,
            }
      )
    );
  }, []);

  const handleSelectAwayTeam = useCallback((team: TeamConfig) => {
    setAwayTeam(team);
    setAwayPlayers((prev) =>
      prev.map((p) =>
        p.lockAuthenticOutfit
          ? p
          : {
              ...p,
              shirtPrimary: team.primaryColor,
              shirtSecondary: team.secondaryColor,
              shortsColor: team.shortsColor,
            }
      )
    );
  }, []);

  const handleUpdateHomePlayer = useCallback(
    (index: number, updated: PlayerCustomization) => {
      setHomePlayers((prev) =>
        prev.map((p, i) => (i === index ? updated : p))
      );
    },
    []
  );

  const handleUpdateSettings = useCallback(
    (partial: Partial<GameSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...partial };
        if (partial.soundEnabled !== undefined) {
          audioEngine.setSoundEnabled(partial.soundEnabled);
        }
        if (partial.musicEnabled !== undefined) {
          audioEngine.setMusicEnabled(partial.musicEnabled);
        }
        if (partial.keyBindings) {
          inputManager.setKeyBindings(partial.keyBindings);
        }
        if (partial.mobileControls?.joystickSensitivity !== undefined) {
          inputManager.joystickSensitivity =
            partial.mobileControls.joystickSensitivity;
        }
        audioEngine.updateVolumes({
          sfxVolume: next.sfxVolume,
          ambientVolume: next.ambientVolume,
          musicVolume: next.musicVolume,
          vibrationEnabled: next.vibrationEnabled,
        });
        return next;
      });
    },
    [inputManager]
  );

  const handleScoreAndClockUpdate = useCallback(
    (
      homeGoals: number,
      awayGoals: number,
      half: 1 | 2,
      remainingSeconds: number,
      phase: MatchPhase
    ) => {
      setScoreAndClock({
        homeGoals,
        awayGoals,
        half,
        remainingSeconds,
        phase,
      });
    },
    []
  );

  const handleHUDRefUpdate = useCallback((hud: LiveHUDUpdate) => {
    hudUpdateRef.current = hud;
  }, []);

  const handleMatchFinished = useCallback(
    (stats: MatchStats) => {
      setFinalStats(stats);
      document.body.dataset.state = 'gameover';
      setScreenState('gameover');

      // Record legitimate completed match in Firestore (/matchHistory & /users career stats)
      const participantUids = activeRoom
        ? Object.values(activeRoom.slots || {})
            .filter((s) => !s.isBot && s.uid)
            .map((s) => String(s.uid))
        : [];
      const myUid = getCurrentAuthUser()?.uid;
      const mySlot =
        activeRoom && myUid
          ? Object.values(activeRoom.slots || {}).find((s) => s.uid === myUid)
          : null;
      const myTeam: 'home' | 'away' = mySlot?.team || 'home';

      recordMatchFinished(
        activeRoom?.roomCode || 'LOCAL',
        homeTeam.name,
        awayTeam.name,
        stats.homeGoals,
        stats.awayGoals,
        participantUids,
        myTeam,
        true
      ).catch(() => {});
    },
    [activeRoom, homeTeam.name, awayTeam.name]
  );

  const handleTogglePause = useCallback(() => {
    setScreenState((prev) => {
      const next =
        prev === 'playing' ? 'paused' : prev === 'paused' ? 'playing' : prev;
      document.body.dataset.state = next;
      return next;
    });
  }, []);

  const handleRestartMatch = useCallback(() => {
    inputManager.clearAll();
    setRestartSignal((s) => s + 1);
    document.body.dataset.state = 'playing';
    setScreenState('playing');
  }, [inputManager]);

  /**
   * Encerra a partida atual, desconecta o servidor WebSocket 30Hz e o chat de voz WebRTC,
   * desliga o microfone, remove o jogador da sala e volta ao menu inicial.
   */
  const handleBackToTitle = useCallback(() => {
    inputManager.clearAll();
    exitFullscreenSafe();
    setShowMatchLoadingOverlay(false);
    realtimeMatchClient.disconnect(true);

    if (activeRoomCode) {
      const codeToLeave = activeRoomCode;
      setActiveRoomCode(null);
      setActiveRoom(null);
      presenceService.stopRoomPresence();
      voiceChatService.leaveRoomVoice();
      leaveOnlineRoom(codeToLeave).catch(() => {});
    }

    document.body.dataset.state = 'title';
    setScreenState('title');
  }, [inputManager, exitFullscreenSafe, activeRoomCode]);

  const handleMultiplayerStartMatch = useCallback(
    (room: MultiplayerRoomState) => {
      setActiveRoom(room);
      setActiveRoomCode(room.roomCode);
      setMultiplayerModalOpen(false);
      setShowMatchLoadingOverlay(true);
      presenceService.startRoomPresence(room.roomCode, 'in_match');
      markPlayerMatchLoadingReady(room.roomCode).catch(() => {});
    },
    []
  );

  const handlePlayerLoadedInOverlay = useCallback(() => {
    if (activeRoomCode) {
      markPlayerMatchLoadingReady(activeRoomCode).catch(() => {});
    }
  }, [activeRoomCode]);

  const handleCompleteMatchLoading = useCallback(() => {
    if (activeRoomCode) {
      promoteRoomToPlaying(activeRoomCode).catch(() => {});
    }
    setShowMatchLoadingOverlay(false);
    setRestartSignal((s) => s + 1);
    handleStartMatch();
  }, [activeRoomCode, handleStartMatch]);

  const handleOpenMultiplayerModal = useCallback(() => {
    if (
      typeof window !== 'undefined' &&
      (window.innerWidth <= 920 || 'ontouchstart' in window)
    ) {
      requestFullscreenAndLandscape();
    }
    setMultiplayerModalOpen(true);
  }, [requestFullscreenAndLandscape]);

  return (
    <main className="relative w-full h-full overflow-hidden bg-stone-950 select-none">
      {/* 3D WebGL Match Simulation & Várzea Environment */}
      <MatchCanvas
        screenState={screenState}
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        homePlayersConfig={homePlayers}
        awayPlayersConfig={awayPlayers}
        settings={settings}
        inputManager={inputManager}
        restartSignal={restartSignal}
        activeRoom={activeRoom}
        onlineControlledCharacterId={onlineControlledCharId}
        onScoreAndClockUpdate={handleScoreAndClockUpdate}
        onHUDRefUpdate={handleHUDRefUpdate}
        onMatchFinished={handleMatchFinished}
        onTogglePause={handleTogglePause}
      />

      {/* Pre-Match Synchronized Loading Screen for Online Matches */}
      {showMatchLoadingOverlay && (
        <MatchLoadingOverlay
          type="starting_match"
          room={activeRoom}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          loadingConfig={settings.loadingConfig}
          onPlayerLoaded={handlePlayerLoadedInOverlay}
          onReadyToPlay={handleCompleteMatchLoading}
        />
      )}

      {/* Title Screen Overlay */}
      {screenState === 'title' && !showMatchLoadingOverlay && (
        <TitleScreen
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          settings={settings}
          activeRoom={activeRoom}
          onStartMatch={handleStartMatch}
          onStartFullscreenMatch={handleStartFullscreenMatch}
          onOpenMultiplayer={handleOpenMultiplayerModal}
          onSelectHomeTeam={handleSelectHomeTeam}
          onSelectAwayTeam={handleSelectAwayTeam}
          onUpdatePlayer={handleUpdateHomePlayer}
          onUpdateSettings={handleUpdateSettings}
        />
      )}

      {/* 360° 3D Character Skin Selector Modal */}
      {characterSelectModalOpen && (
        <CharacterSelect3DModal
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          selectedCharacterId={onlineControlledCharId}
          onSelectCharacter={(charId) => {
            setOnlineControlledCharId(charId);
          }}
          onStartWithCharacter={(charId) => {
            setOnlineControlledCharId(charId);
            setCharacterSelectModalOpen(false);
            handleStartMatch();
          }}
          onClose={() => setCharacterSelectModalOpen(false)}
        />
      )}

      {/* Online Multiplayer Lobby (2v2 & 4v4, Public & Private Rooms, Bots, WebRTC Voice & Friends) */}
      {multiplayerModalOpen && (
        <MultiplayerLobbyModal
          homeTeamId={homeTeam.id}
          awayTeamId={awayTeam.id}
          halfDurationSeconds={settings.halfDurationSeconds}
          activeRoomCode={activeRoomCode}
          onRoomJoined={(room) => {
            setActiveRoom(room);
            setActiveRoomCode(room.roomCode);
          }}
          onRoomLeft={() => {
            setActiveRoom(null);
            setActiveRoomCode(null);
          }}
          onStartMultiplayerMatch={handleMultiplayerStartMatch}
          onClose={() => setMultiplayerModalOpen(false)}
        />
      )}

      {/* Active Match HUD & Mobile Touch Controls */}
      {screenState === 'playing' && (
        <GameplayHUD
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          homeGoals={scoreAndClock.homeGoals}
          awayGoals={scoreAndClock.awayGoals}
          half={scoreAndClock.half}
          remainingSeconds={scoreAndClock.remainingSeconds}
          phase={scoreAndClock.phase}
          settings={settings}
          inputManager={inputManager}
          hudUpdateRef={hudUpdateRef}
          activeRoom={activeRoom}
          pingMs={pingMs}
          isFullscreen={isFullscreen}
          onRequestFullscreenLandscape={requestFullscreenAndLandscape}
          onExitFullscreen={exitFullscreenSafe}
          onBackToMenu={handleBackToTitle}
          onUpdateSettings={handleUpdateSettings}
          onPause={handleTogglePause}
          onRestart={handleRestartMatch}
        />
      )}

      {/* Pause / In-Match Exit Menu & Victory / Defeat / Draw Modals */}
      <StatusModals
        screenState={screenState}
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        stats={finalStats}
        settings={settings}
        activeRoom={activeRoom}
        onResume={handleTogglePause}
        onRestart={handleRestartMatch}
        onBackToTitle={handleBackToTitle}
        onUpdateSettings={handleUpdateSettings}
      />
    </main>
  );
}
