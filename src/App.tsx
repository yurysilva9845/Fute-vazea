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
  PlayerCustomization,
  TeamConfig,
} from './types/game';
import { VarzeaInputManager } from './game/controls';
import { LiveHUDUpdate, MatchCanvas } from './game/MatchCanvas';
import { TitleScreen } from './components/TitleScreen';
import { GameplayHUD } from './components/GameplayHUD';
import { StatusModals } from './components/StatusModals';
import { audioEngine } from './game/audio';

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
    halfDurationSeconds: 300, // 2 halves of 5 minutes
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

  const inputManager = useMemo(() => new VarzeaInputManager(), []);

  useEffect(() => {
    return () => {
      inputManager.dispose();
    };
  }, [inputManager]);

  const hudUpdateRef = useRef<LiveHUDUpdate>({
    controlledPlayerName: 'Yuri',
    controlledPlayerRole: 'PIVÔ',
    stamina: 100,
    kickCharge: 0,
    isChargingKick: false,
    bannerMessage: null,
    bannerSubtext: null,
  });

  // Mirror screenState to document.body.dataset.state
  useEffect(() => {
    document.body.dataset.state = screenState;
  }, [screenState]);

  const handleStartMatch = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    inputManager.clearAll();
    audioEngine.stopMenuBatucada();
    document.body.dataset.state = 'playing';
    setScreenState('playing');
  }, [inputManager]);

  // Bind Enter / Space on Title Screen to start immediately
  useEffect(() => {
    if (screenState !== 'title') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
        return;
      }
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        handleStartMatch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [screenState, handleStartMatch]);

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

  const handleMatchFinished = useCallback((stats: MatchStats) => {
    setFinalStats(stats);
    document.body.dataset.state = 'gameover';
    setScreenState('gameover');
  }, []);

  const handleTogglePause = useCallback(() => {
    setScreenState((prev) => {
      const next = prev === 'playing' ? 'paused' : prev === 'paused' ? 'playing' : prev;
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
    document.body.dataset.state = 'title';
    setScreenState('title');
  }, [inputManager]);

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
          settings={settings}
          onStartMatch={handleStartMatch}
          onSelectHomeTeam={handleSelectHomeTeam}
          onSelectAwayTeam={handleSelectAwayTeam}
          onUpdatePlayer={handleUpdateHomePlayer}
          onUpdateSettings={handleUpdateSettings}
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
