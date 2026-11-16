import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, RefreshCw, Shield, Users, Wifi } from 'lucide-react';
import { MatchFormatMode, MultiplayerRoomState, TeamConfig } from '../types/game';

interface MatchLoadingOverlayProps {
  type: 'connecting_lobby' | 'joining_room' | 'starting_match';
  customMessage?: string;
  room?: MultiplayerRoomState | null;
  homeTeam?: TeamConfig;
  awayTeam?: TeamConfig;
  onPlayerLoaded?: () => void;
  onReadyToPlay?: () => void;
  onRetryOrCancel?: () => void;
}

const MATCH_LOADING_STEPS = [
  'CONECTANDO AOS JOGADORES...',
  'PREPARANDO O CAMPO...',
  'CARREGANDO PERSONAGENS...',
  'SINCRONIZANDO A BOLA...',
  'INICIANDO PARTIDA...',
];

export const MatchLoadingOverlay: React.FC<MatchLoadingOverlayProps> = ({
  type,
  customMessage,
  room,
  homeTeam,
  awayTeam,
  onPlayerLoaded,
  onReadyToPlay,
  onRetryOrCancel,
}) => {
  const [progress, setProgress] = useState(14);
  const [stepIdx, setStepIdx] = useState(0);
  const [countdownSec, setCountdownSec] = useState(5);
  const loadedNotifiedRef = useRef(false);
  const startedNotifiedRef = useRef(false);

  const onPlayerLoadedRef = useRef(onPlayerLoaded);
  const onReadyToPlayRef = useRef(onReadyToPlay);
  useEffect(() => {
    onPlayerLoadedRef.current = onPlayerLoaded;
    onReadyToPlayRef.current = onReadyToPlay;
  }, [onPlayerLoaded, onReadyToPlay]);

  useEffect(() => {
    if (type !== 'starting_match') return;

    loadedNotifiedRef.current = false;
    startedNotifiedRef.current = false;
    setProgress(16);
    setStepIdx(0);
    setCountdownSec(5);

    const stepInterval = window.setInterval(() => {
      setProgress((prev) => Math.min(100, prev + 21));
      setStepIdx((prev) => Math.min(MATCH_LOADING_STEPS.length - 1, prev + 1));
    }, 380);

    // Marca este cliente como carregado após preparar cenário/personagens (~1.8s)
    const localReadyTimer = window.setTimeout(() => {
      setProgress(100);
      setStepIdx(MATCH_LOADING_STEPS.length - 1);
      if (!loadedNotifiedRef.current) {
        loadedNotifiedRef.current = true;
        onPlayerLoadedRef.current?.();
      }
    }, 1850);

    // Contador regressivo de 5 segundos para início automático com quem carregou
    const countdownInterval = window.setInterval(() => {
      setCountdownSec((prev) => Math.max(0, prev - 1));
    }, 1000);

    // Timeout máximo de 5 segundos (conforme definido: iniciar automaticamente após 5s com quem carregou)
    const maxTimeout = window.setTimeout(() => {
      if (!startedNotifiedRef.current) {
        startedNotifiedRef.current = true;
        onReadyToPlayRef.current?.();
      }
    }, 5000);

    return () => {
      window.clearInterval(stepInterval);
      window.clearTimeout(localReadyTimer);
      window.clearInterval(countdownInterval);
      window.clearTimeout(maxTimeout);
    };
  }, [type]);

  // Se todos os jogadores humanos já confirmaram carregamento ou o status virou 'playing', inicia imediatamente
  useEffect(() => {
    if (type !== 'starting_match' || !room) return;
    const humanUids = Object.values(room.slots || {})
      .filter((s) => !s.isBot && s.uid)
      .map((s) => String(s.uid));
    const readyUids = room.loadingReadyUids || [];
    const allHumansReady =
      humanUids.length > 0 && humanUids.every((uid) => readyUids.includes(uid));

    if ((room.status === 'playing' || (allHumansReady && progress >= 95)) && !startedNotifiedRef.current) {
      const quickStart = window.setTimeout(() => {
        if (!startedNotifiedRef.current) {
          startedNotifiedRef.current = true;
          onReadyToPlayRef.current?.();
        }
      }, 350);
      return () => window.clearTimeout(quickStart);
    }
  }, [type, room, progress]);

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
  const readyCount = humanSlots.filter((s) =>
    (room?.loadingReadyUids || []).includes(String(s.uid))
  ).length;

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
              SEM TERRA FC · SINCRONIZAÇÃO DE PARTIDA {mode.toUpperCase()}
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
              const isLoaded =
                slot.isBot ||
                (slot.uid && (room?.loadingReadyUids || []).includes(slot.uid));
              return (
                <div
                  key={slot.characterId}
                  className="flex items-center justify-between bg-stone-950/80 px-3 py-1.5 rounded border border-stone-800"
                >
                  <div className="flex items-center gap-1.5">
                    {isLoaded && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
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
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    }`}
                  >
                    {slot.isBot ? 'BOT IA' : 'HUMANO'}
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
              const isLoaded =
                slot.isBot ||
                (slot.uid && (room?.loadingReadyUids || []).includes(slot.uid));
              return (
                <div
                  key={slot.characterId}
                  className="flex items-center justify-between bg-stone-950/80 px-3 py-1.5 rounded border border-stone-800"
                >
                  <div className="flex items-center gap-1.5">
                    {isLoaded && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
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
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    }`}
                  >
                    {slot.isBot ? 'BOT IA' : 'HUMANO'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom Progress Bar & Step Message */}
      <div className="relative z-10 max-w-2xl w-full mx-auto space-y-2.5 pt-2">
        <div className="flex items-center justify-between text-xs font-black uppercase tracking-wider">
          <span className="text-amber-400">{MATCH_LOADING_STEPS[stepIdx]}</span>
          <span className="text-stone-300 font-mono">
            {progress}% · Início automático em {countdownSec}s
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
            Sincronizando estado da sala, posições iniciais e bola compartilhada...
          </span>
          {onReadyToPlay && (
            <button
              type="button"
              onClick={() => {
                if (!startedNotifiedRef.current) {
                  startedNotifiedRef.current = true;
                  onReadyToPlay();
                }
              }}
              className="flex items-center gap-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase px-2.5 py-1 rounded cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3 h-3" />
              Entrar Agora
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

