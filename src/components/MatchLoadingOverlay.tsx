import React, { useEffect, useState } from 'react';
import { RefreshCw, Shield, Users, Wifi } from 'lucide-react';
import { MatchFormatMode, MultiplayerRoomState, TeamConfig } from '../types/game';

interface MatchLoadingOverlayProps {
  type: 'connecting_lobby' | 'joining_room' | 'starting_match';
  customMessage?: string;
  room?: MultiplayerRoomState | null;
  homeTeam?: TeamConfig;
  awayTeam?: TeamConfig;
  onReadyToPlay?: () => void;
  onRetryOrCancel?: () => void;
}

const MATCH_LOADING_STEPS = [
  'PREPARANDO O CAMPO...',
  'CARREGANDO JOGADORES...',
  'SINCRONIZANDO A BOLA...',
  'CONECTANDO OS PARTICIPANTES...',
  'PREPARANDO A PARTIDA...',
];

export const MatchLoadingOverlay: React.FC<MatchLoadingOverlayProps> = ({
  type,
  customMessage,
  room,
  homeTeam,
  awayTeam,
  onReadyToPlay,
  onRetryOrCancel,
}) => {
  const [progress, setProgress] = useState(12);
  const [stepIdx, setStepIdx] = useState(0);
  const [slowWarning, setSlowWarning] = useState(false);

  useEffect(() => {
    if (type !== 'starting_match') return;

    setProgress(15);
    setStepIdx(0);
    setSlowWarning(false);

    const stepInterval = window.setInterval(() => {
      setProgress((prev) => {
        const next = Math.min(100, prev + 22);
        return next;
      });
      setStepIdx((prev) => Math.min(MATCH_LOADING_STEPS.length - 1, prev + 1));
    }, 420);

    const finishTimer = window.setTimeout(() => {
      setProgress(100);
      if (onReadyToPlay) {
        onReadyToPlay();
      }
    }, 2150);

    const slowTimer = window.setTimeout(() => {
      setSlowWarning(true);
    }, 5000);

    return () => {
      window.clearInterval(stepInterval);
      window.clearTimeout(finishTimer);
      window.clearTimeout(slowTimer);
    };
  }, [type, onReadyToPlay]);

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

  return (
    <div className="fixed inset-0 z-[80] bg-stone-950 flex flex-col justify-between p-4 sm:p-8 overflow-y-auto select-none">
      {/* Dirt pitch atmospheric background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-25"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 35%, rgba(217, 119, 6, 0.35), rgba(28, 25, 23, 0.95) 75%)',
        }}
      />

      {/* Top Header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-stone-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded bg-amber-500 text-stone-950 flex items-center justify-center font-black text-lg shadow-lg">
            STF
          </div>
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-amber-400">
              SEM TERRA FC · VÁRZEA {mode.toUpperCase()}
            </div>
            <h2 className="text-xl sm:text-2xl font-black uppercase text-white tracking-tight">
              {room?.roomName || `PARTIDA ONLINE ${mode.toUpperCase()}`}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 px-3 py-1.5 rounded">
          <Users className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-black uppercase text-stone-200">
            Modalidade: {mode === '2v2' ? '2 CONTRA 2' : '4 CONTRA 4'}
          </span>
        </div>
      </div>

      {/* Center Teams Showcase */}
      <div className="relative z-10 my-auto py-4 max-w-4xl w-full mx-auto grid grid-cols-1 md:grid-cols-11 gap-4 items-center">
        {/* Time 1 */}
        <div className="md:col-span-5 bg-stone-900/90 border-2 border-amber-500/40 rounded p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-stone-800 pb-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-amber-400">
                TIME 1 (CASA)
              </div>
              <div className="text-lg font-black uppercase text-white">
                {homeTeam?.name || 'Sem Terra FC'}
              </div>
            </div>
            <Shield className="w-6 h-6 text-amber-400" />
          </div>
          <div className="space-y-1.5">
            {homeSlots.map((slot) => (
              <div
                key={slot.characterId}
                className="flex items-center justify-between bg-stone-950/80 px-3 py-2 rounded border border-stone-800"
              >
                <div>
                  <span className="text-xs font-black uppercase text-white">
                    {slot.characterName}
                  </span>
                  <span className="text-[11px] text-stone-400 ml-2">
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
            ))}
          </div>
        </div>

        {/* VS */}
        <div className="md:col-span-1 flex flex-col items-center justify-center py-2">
          <div className="w-12 h-12 rounded-full bg-amber-500 text-stone-950 font-black text-base flex items-center justify-center shadow-lg">
            VS
          </div>
        </div>

        {/* Time 2 */}
        <div className="md:col-span-5 bg-stone-900/90 border-2 border-red-500/40 rounded p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-stone-800 pb-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-red-400">
                TIME 2 (VISITANTE)
              </div>
              <div className="text-lg font-black uppercase text-white">
                {awayTeam?.name || 'Rubro-Negro do Beco'}
              </div>
            </div>
            <Shield className="w-6 h-6 text-red-400" />
          </div>
          <div className="space-y-1.5">
            {awaySlots.map((slot) => (
              <div
                key={slot.characterId}
                className="flex items-center justify-between bg-stone-950/80 px-3 py-2 rounded border border-stone-800"
              >
                <div>
                  <span className="text-xs font-black uppercase text-white">
                    {slot.characterName}
                  </span>
                  <span className="text-[11px] text-stone-400 ml-2">
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
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Progress Bar & Step Message */}
      <div className="relative z-10 max-w-2xl w-full mx-auto space-y-3 pt-2">
        <div className="flex items-center justify-between text-xs font-black uppercase tracking-wider">
          <span className="text-amber-400">{MATCH_LOADING_STEPS[stepIdx]}</span>
          <span className="text-stone-300 font-mono">{progress}%</span>
        </div>
        <div className="w-full h-3 bg-stone-900 border border-stone-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-400 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        {slowWarning && (
          <div className="flex items-center justify-between bg-stone-900 border border-amber-500/40 px-3 py-2 rounded text-xs">
            <span className="text-stone-300">
              Conexão lenta detectada. Você pode entrar em campo imediatamente com os bots sincronizados.
            </span>
            {onReadyToPlay && (
              <button
                type="button"
                onClick={onReadyToPlay}
                className="flex items-center gap-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase px-3 py-1 rounded cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Iniciar Agora
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
