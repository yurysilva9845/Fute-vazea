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
import { VarzeaInputManager } from './game/controls';
import { LiveHUDUpdate, MatchCanvas } from './game/MatchCanvas';
import { TitleScreen } from './components/TitleScreen';
import { GameplayHUD } from './components/GameplayHUD';
import { StatusModals } from './components/StatusModals';
import { MultiplayerLobbyModal } from './components/MultiplayerLobbyModal';
import { audioEngine } from './game/audio';
import {
  auth,
  ensureAuthenticatedUser,
  onAuthStateChanged,
  recordMatchHistory,
  testFirebaseConnection,
} from './services/firebase';

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
    voiceVolume: 0.9,
    ambientVolume: 0.65,
    musicVolume: 0.5,
    vibrationEnabled: true,
    halfDurationSeconds: 300,
    aiDifficulty: 'equilibrado',
    showPlayerNames: true,
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

  // Online Multiplayer & Friends Modal state
  const [multiplayerModalTab, setMultiplayerModalTab] = useState<
    'none' | 'lobby' | 'friends' | 'diagnostic'
  >('none');
  const [activeRoom, setActiveRoom] = useState<MultiplayerRoomState | null>(
    null
  );
  const [onlineControlledCharId, setOnlineControlledCharId] =
    useState<string>('home_1');
  const [pingMs, setPingMs] = useState<number>(18);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const inputManager = useMemo(() => new VarzeaInputManager(), []);

  useEffect(() => {
    return () => {
      inputManager.dispose();
    };
  }, [inputManager]);

  // Boot-time Firebase connection & presence warm-up + Fullscreen listener
  useEffect(() => {
    testFirebaseConnection().then((res) => {
      setPingMs(res.pingMs);
    });
    const unsubAuth = onAuthStateChanged(auth, () => {
      ensureAuthenticatedUser().catch(() => {});
    });

    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      unsubAuth();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

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
    // If on mobile, automatically attempt fullscreen & landscape lock on JOGAR click
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
    if (screenState !== 'title' || multiplayerModalTab !== 'none') return;
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
  }, [screenState, multiplayerModalTab, handleStartMatch]);

  const handleSelectHomeTeam = useCallback((team: TeamConfig) => {
    setHomeTeam(team);
    setHomePlayers((prev) =>
      prev.map((p) => ({
        ...p,
        shirtPrimary: team.primaryColor,
        shirtSecondary: team.secondaryColor,
        shortsColor: team.shortsColor,
      }))
    );
  }, []);

  const handleSelectAwayTeam = useCallback((team: TeamConfig) => {
    setAwayTeam(team);
    setAwayPlayers((prev) =>
      prev.map((p) => ({
        ...p,
        shirtPrimary: team.primaryColor,
        shirtSecondary: team.secondaryColor,
        shortsColor: team.shortsColor,
      }))
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

  const handleUpdateSettings = useCallback((partial: Partial<GameSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      if (partial.soundEnabled !== undefined) {
        audioEngine.setSoundEnabled(partial.soundEnabled);
      }
      if (partial.musicEnabled !== undefined) {
        audioEngine.setMusicEnabled(partial.musicEnabled);
      }
      audioEngine.updateVolumes({
        sfxVolume: next.sfxVolume,
        voiceVolume: next.voiceVolume,
        ambientVolume: next.ambientVolume,
        musicVolume: next.musicVolume,
        vibrationEnabled: next.vibrationEnabled,
      });
      return next;
    });
  }, []);

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

      // Persist match result to Firestore /matchHistory
      const mvp =
        stats.scorers[0]?.playerName ||
        (stats.homeGoals >= stats.awayGoals ? 'Yuri' : 'Primo');
      recordMatchHistory({
        roomCode: activeRoom?.roomCode || 'LOCAL',
        homeTeamName: homeTeam.name,
        awayTeamName: awayTeam.name,
        homeGoals: stats.homeGoals,
        awayGoals: stats.awayGoals,
        mvpName: mvp,
      }).catch(() => {});
    },
    [activeRoom?.roomCode, homeTeam.name, awayTeam.name]
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

  const handleBackToTitle = useCallback(() => {
    inputManager.clearAll();
    exitFullscreenSafe();
    document.body.dataset.state = 'title';
    setScreenState('title');
  }, [inputManager, exitFullscreenSafe]);

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

      {/* Title Screen Overlay */}
      {screenState === 'title' && (
        <TitleScreen
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          settings={settings}
          activeRoom={activeRoom}
          onStartMatch={handleStartMatch}
          onStartFullscreenMatch={handleStartFullscreenMatch}
          onOpenMultiplayer={(tab) => setMultiplayerModalTab(tab)}
          onSelectHomeTeam={handleSelectHomeTeam}
          onSelectAwayTeam={handleSelectAwayTeam}
          onUpdatePlayer={handleUpdateHomePlayer}
          onUpdateSettings={handleUpdateSettings}
        />
      )}

      {/* Online Multiplayer Lobby, Friends & Firebase Diagnostic Modal */}
      {multiplayerModalTab !== 'none' && (
        <MultiplayerLobbyModal
          initialTab={multiplayerModalTab}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          activeRoom={activeRoom}
          controlledCharacterId={onlineControlledCharId}
          onRoomUpdated={(room, myCharId) => {
            setActiveRoom(room);
            setOnlineControlledCharId(myCharId);
          }}
          onStartMultiplayerGame={() => {
            setMultiplayerModalTab('none');
            handleStartMatch();
          }}
          onClose={() => setMultiplayerModalTab('none')}
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

      {/* Pause & Victory / Defeat / Draw Modals */}
      <StatusModals
        screenState={screenState}
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        stats={finalStats}
        settings={settings}
        onResume={handleTogglePause}
        onRestart={handleRestartMatch}
        onBackToTitle={handleBackToTitle}
        onUpdateSettings={handleUpdateSettings}
      />
    </main>
  );
}
