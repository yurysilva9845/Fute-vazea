import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Shield,
  Users,
  Wifi,
} from 'lucide-react';
import {
  MatchFormatMode,
  MatchLoadingConfig,
  MultiplayerRoomState,
  TeamConfig,
} from '../types/game';
import { getCurrentAuthUser } from '../services/firebase';
import { realtimeMatchClient } from '../services/realtimeMatchClient';

interface MatchLoadingOverlayProps {
  type: 'connecting_lobby' | 'joining_room' | 'starting_match';
  customMessage?: string;
  room?: MultiplayerRoomState | null;
  homeTeam?: TeamConfig;
  awayTeam?: TeamConfig;
  loadingConfig?: MatchLoadingConfig;
  onPlayerLoaded?: () => void;
  onReadyToPlay?: () => void;
  onRetryOrCancel?: () => void;
}

const MATCH_LOADING_STEPS = [
  'CONECTANDO AO SERVIDOR DE PARTIDA (30Hz)...',
  'PREPARANDO O CAMPO DE TERRA E TRAVINHAS...',
  'CARREGANDO SKINS E MODELOS 3D...',
  'SINCRONIZANDO BOLA E POSIÇÕES INICIAIS...',
  'AGUARDANDO CONFIRMAÇÃO DOS JOGADORES...',
];

const DEFAULT_LOADING_CONFIG: MatchLoadingConfig = {
  minLoadTimeSeconds: 2,
  slowConnectionWarningSeconds: 10,
  maxWaitTimeSeconds: 20,
  extraSlowConnectionSeconds: 5,
};

export const MatchLoadingOverlay: React.FC<MatchLoadingOverlayProps> = ({
  type,
  customMessage,
  room,
  homeTeam,
  awayTeam,
  loadingConfig = DEFAULT_LOADING_CONFIG,
  onPlayerLoaded,
  onReadyToPlay,
  onRetryOrCancel,
}) => {
  const cfg = { ...DEFAULT_LOADING_CONFIG, ...loadingConfig };
  const [progress, setProgress] = useState(14);
  const [stepIdx, setStepIdx] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [maxWaitSec, setMaxWaitSec] = useState(cfg.maxWaitTimeSeconds);
  const [wsReadyMap, setWsReadyMap] = useState<Record<string, boolean>>({});

  const loadedNotifiedRef = useRef(false);
  const startedNotifiedRef = useRef(false);

  const onPlayerLoadedRef = useRef(onPlayerLoaded);
  const onReadyToPlayRef = useRef(onReadyToPlay);
  useEffect(() => {
    onPlayerLoadedRef.current = onPlayerLoaded;
    onReadyToPlayRef.current = onReadyToPlay;
  }, [onPlayerLoaded, onReadyToPlay]);

  useEffect(() => {
    realtimeMatchClient.setCallbacks({
      onPlayerReadyUpdate: (readyByUid, allReady) => {
        setWsReadyMap(readyByUid);
        if (allReady && elapsedSec >= cfg.minLoadTimeSeconds && !startedNotifiedRef.current) {
          startedNotifiedRef.current = true;
          onReadyToPlayRef.current?.();
        }
      },
    });
  }, [elapsedSec, cfg.minLoadTimeSeconds]);

  useEffect(() => {
    if (type !== 'starting_match') return;

    loadedNotifiedRef.current = false;
    startedNotifiedRef.current = false;
    setProgress(18);
    setStepIdx(0);
    setElapsedSec(0);
    setMaxWaitSec(cfg.maxWaitTimeSeconds);

    const stepInterval = window.setInterval(() => {
      setProgress((prev) => Math.min(100, prev + 22));
      setStepIdx((prev) => Math.min(MATCH_LOADING_STEPS.length - 1, prev + 1));
    }, 360);

    // Notifica que este cliente carregou recursos após minLoadTimeSeconds (~2s)
    const localReadyTimer = window.setTimeout(() => {
      setProgress(100);
      setStepIdx(MATCH_LOADING_STEPS.length - 1);
      if (!loadedNotifiedRef.current) {
        loadedNotifiedRef.current = true;
        realtimeMatchClient.sendPlayerReady(false);
        onPlayerLoadedRef.current?.();
      }
    }, cfg.minLoadTimeSeconds * 1000);

    const elapsedInterval = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);

    return () => {
      window.clearInterval(stepInterval);
      window.clearTimeout(localReadyTimer);
      window.clearInterval(elapsedInterval);
    };
  }, [type, cfg.minLoadTimeSeconds, cfg.maxWaitTimeSeconds]);

  // Verifica prontidão real de todos os jogadores humanos ou limite máximo configurável
  useEffect(() => {
    if (type !== 'starting_match') return;

    const humanUids = Object.values(room?.slots || {})
      .filter((s) => !s.isBot && s.uid)
      .map((s) => String(s.uid));
    const roomReadyUids = room?.loadingReadyUids || [];

    const allHumansReady =
      humanUids.length === 0 ||
      humanUids.every(
        (uid) => roomReadyUids.includes(uid) || Boolean(wsReadyMap[uid])
      );

    // Inicia imediatamente assim que o tempo mínimo (2s) passou E todos os humanos confirmaram
    if (
      (room?.status === 'playing' ||
        (elapsedSec >= cfg.minLoadTimeSeconds && allHumansReady && progress >= 95)) &&
      !startedNotifiedRef.current
    ) {
      const quickStart = window.setTimeout(() => {
        if (!startedNotifiedRef.current) {
          startedNotifiedRef.current = true;
          realtimeMatchClient.sendPlayerReady(true);
          onReadyToPlayRef.current?.();
        }
      }, 220);
      return () => window.clearTimeout(quickStart);
    }

    // Caso o limite máximo configurável (maxWaitSec) seja atingido, inicia com quem carregou
    if (elapsedSec >= maxWaitSec && !startedNotifiedRef.current) {
      startedNotifiedRef.current = true;
      realtimeMatchClient.sendPlayerReady(true);
      onReadyToPlayRef.current?.();
    }
    return undefined;
  }, [
    type,
    room,
    progress,
    elapsedSec,
    maxWaitSec,
    wsReadyMap,
    cfg.minLoadTimeSeconds,
  ]);

  if (type === 'connecting_lobby' || type === 'joining_room') {
    return (
      <div className="fixed inset-0 z-[70] bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-stone-900 border-2 border-amber-500/60 rounded p-6 text-center shadow-2xl space-y-4">
          <div className="w-14 h-14 mx-auto rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center">
            <Wifi className="w-7 h-7 text-amber-400 animate-pulse" />
          </div>
          <div>
            <div className="text-[11px] font-black uppercase tracking-widest text-amber-400">
              SEM TERRA FC · MULTIPLAYER ONLINE
            </div>
            <h3 className="text-xl font-black uppercase text-white mt-1">
              {customMessage ||
                (type === 'connecting_lobby'
                  ? 'Conectando ao servidor...'
                  : 'Entrando na sala...')}
            </h3>
            <p className="text-xs text-stone-400 mt-1">
              Sincronizando jogadores, travinhas e comunicação da sala em tempo real.
            </p>
          </div>
          <div className="w-full h-2 bg-stone-800 rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 w-2/3 animate-pulse rounded-full" />
          </div>
          {onRetryOrCancel && (
            <button
              type="button"
              onClick={onRetryOrCancel}
              className="text-xs font-bold uppercase tracking-wider text-stone-400 hover:text-white underline cursor-pointer"
            >
              Cancelar
            </button>
          )}
        </div>
      </div>
    );
  }

  const mode: MatchFormatMode = room?.mode === '2v2' ? '2v2' : '4v4';
  const activeIds = room?.activeCharacterIds || [];
  const allSlots = Object.values(room?.slots || {});
  const activeSlots =
    activeIds.length > 0
      ? allSlots.filter((s) => activeIds.includes(s.characterId))
      : allSlots;

  const homeSlots = activeSlots.filter((s) => s.team === 'home');
  const awaySlots = activeSlots.filter((s) => s.team === 'away');
  const humanSlots = allSlots.filter((s) => !s.isBot && s.uid);

  const isPlayerSlotReady = (uid?: string | null, isBot?: boolean) => {
    if (isBot || !uid) return true;
    return (
      (room?.loadingReadyUids || []).includes(uid) || Boolean(wsReadyMap[uid])
    );
  };

  const readyCount = humanSlots.filter((s) =>
    isPlayerSlotReady(s.uid, s.isBot)
  ).length;
  const myUid = getCurrentAuthUser()?.uid;
  const isHost = !room?.hostUid || room.hostUid === myUid;
  const isSlowConnectionWarning =
    elapsedSec >= cfg.slowConnectionWarningSeconds &&
    readyCount < humanSlots.length;
  const remainingWaitSec = Math.max(0, maxWaitSec - elapsedSec);

  return (
    <div className="fixed inset-0 z-[80] bg-stone-950 flex flex-col justify-between p-3 sm:p-6 overflow-y-auto select-none">
      {/* Dirt pitch atmospheric background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-25"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 35%, rgba(217, 119, 6, 0.35), rgba(28, 25, 23, 0.95) 75%)',
        }}
      />

      {/* Top Header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-b border-stone-800 pb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-amber-500 text-stone-950 flex items-center justify-center font-black text-base shadow-lg">
            STF
          </div>
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-amber-400">
              SEM TERRA FC · SINCRONIZAÇÃO DE PARTIDA {mode.toUpperCase()} (30Hz)
            </div>
            <h2 className="text-lg sm:text-xl font-black uppercase text-white tracking-tight">
              {room?.roomName || `PARTIDA ONLINE ${mode.toUpperCase()}`}
            </h2>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {room?.roomCode && (
            <div className="bg-stone-900 border border-stone-700 px-2.5 py-1 rounded text-[11px] font-mono text-stone-300">
              SALA: <strong className="text-amber-400">{room.roomCode}</strong>
            </div>
          )}
          {room?.matchId && (
            <div className="bg-stone-900 border border-stone-700 px-2.5 py-1 rounded text-[11px] font-mono text-stone-300">
              MATCH: <strong className="text-emerald-400">{room.matchId}</strong>
            </div>
          )}
          <div className="flex items-center gap-1.5 bg-stone-900 border border-stone-700 px-2.5 py-1 rounded">
            <Users className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[11px] font-black uppercase text-stone-200">
              {mode === '2v2' ? '2 CONTRA 2' : '4 CONTRA 4'} · Prontos:{' '}
              {Math.max(1, readyCount)}/{Math.max(1, humanSlots.length)}
            </span>
          </div>
        </div>
      </div>

      {/* Center Teams Showcase */}
      <div className="relative z-10 my-auto py-3 max-w-4xl w-full mx-auto grid grid-cols-1 md:grid-cols-11 gap-3 items-center">
        {/* Time 1 */}
        <div className="md:col-span-5 bg-stone-900/90 border-2 border-amber-500/40 rounded p-3.5 space-y-2.5">
          <div className="flex items-center justify-between border-b border-stone-800 pb-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-amber-400">
                TIME 1 (CASA)
              </div>
              <div className="text-base font-black uppercase text-white">
                {homeTeam?.name || 'Sem Terra FC'}
              </div>
            </div>
            <Shield className="w-5 h-5 text-amber-400" />
          </div>
          <div className="space-y-1.5">
            {homeSlots.map((slot) => {
              const isLoaded = isPlayerSlotReady(slot.uid, slot.isBot);
              return (
                <div
                  key={slot.characterId}
                  className="flex items-center justify-between bg-stone-950/80 px-3 py-1.5 rounded border border-stone-800"
                >
                  <div className="flex items-center gap-1.5">
                    {isLoaded ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <Clock className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                    )}
                    <span className="text-xs font-black uppercase text-white">
                      {slot.characterName}
                    </span>
                    <span className="text-[11px] text-stone-400">
                      ({slot.displayName})
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${
                      slot.isBot
                        ? 'bg-stone-800 text-stone-400'
                        : isLoaded
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    }`}
                  >
                    {slot.isBot
                      ? 'BOT IA'
                      : isLoaded
                      ? 'PRONTO'
                      : 'CARREGANDO...'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* VS */}
        <div className="md:col-span-1 flex flex-col items-center justify-center py-1">
          <div className="w-11 h-11 rounded-full bg-amber-500 text-stone-950 font-black text-sm flex items-center justify-center shadow-lg">
            VS
          </div>
        </div>

        {/* Time 2 */}
        <div className="md:col-span-5 bg-stone-900/90 border-2 border-red-500/40 rounded p-3.5 space-y-2.5">
          <div className="flex items-center justify-between border-b border-stone-800 pb-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-red-400">
                TIME 2 (VISITANTE)
              </div>
              <div className="text-base font-black uppercase text-white">
                {awayTeam?.name || 'Rubro-Negro do Beco'}
              </div>
            </div>
            <Shield className="w-5 h-5 text-red-400" />
          </div>
          <div className="space-y-1.5">
            {awaySlots.map((slot) => {
              const isLoaded = isPlayerSlotReady(slot.uid, slot.isBot);
              return (
                <div
                  key={slot.characterId}
                  className="flex items-center justify-between bg-stone-950/80 px-3 py-1.5 rounded border border-stone-800"
                >
                  <div className="flex items-center gap-1.5">
                    {isLoaded ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <Clock className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                    )}
                    <span className="text-xs font-black uppercase text-white">
                      {slot.characterName}
                    </span>
                    <span className="text-[11px] text-stone-400">
                      ({slot.displayName})
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${
                      slot.isBot
                        ? 'bg-stone-800 text-stone-400'
                        : isLoaded
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    }`}
                  >
                    {slot.isBot
                      ? 'BOT IA'
                      : isLoaded
                      ? 'PRONTO'
                      : 'CARREGANDO...'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom Progress Bar, Slow Connection Warning & Host Controls */}
      <div className="relative z-10 max-w-2xl w-full mx-auto space-y-2.5 pt-2">
        {isSlowConnectionWarning && (
          <div className="bg-amber-950/90 border border-amber-500/70 rounded p-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Conexão lenta detectada em um dos jogadores ({readyCount}/
                {humanSlots.length} prontos). Tempo restante: {remainingWaitSec}s
              </span>
            </div>
            {isHost && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setMaxWaitSec(
                      (prev) => prev + cfg.extraSlowConnectionSeconds
                    )
                  }
                  className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-amber-300 border border-amber-500/40 rounded font-bold text-[11px] cursor-pointer"
                >
                  AGUARDAR +{cfg.extraSlowConnectionSeconds}s
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!startedNotifiedRef.current) {
                      startedNotifiedRef.current = true;
                      realtimeMatchClient.sendPlayerReady(true);
                      onReadyToPlay?.();
                    }
                  }}
                  className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-stone-950 rounded font-black text-[11px] cursor-pointer"
                >
                  PROSSEGUIR AGORA
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-xs font-black uppercase tracking-wider">
          <span className="text-amber-400">{MATCH_LOADING_STEPS[stepIdx]}</span>
          <span className="text-stone-300 font-mono">
            {progress}% · Timeout máx: {remainingWaitSec}s
          </span>
        </div>
        <div className="w-full h-3 bg-stone-900 border border-stone-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-400 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="flex items-center justify-between bg-stone-900/90 border border-stone-800 px-3 py-2 rounded text-[11px]">
          <span className="text-stone-300">
            Início imediato após {cfg.minLoadTimeSeconds}s quando todos os
            jogadores confirmarem prontidão.
          </span>
          {onReadyToPlay && isHost && (
            <button
              type="button"
              onClick={() => {
                if (!startedNotifiedRef.current) {
                  startedNotifiedRef.current = true;
                  realtimeMatchClient.sendPlayerReady(true);
                  onReadyToPlay();
                }
              }}
              className="flex items-center gap-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase px-2.5 py-1 rounded cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3 h-3" />
              Iniciar Agora
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
