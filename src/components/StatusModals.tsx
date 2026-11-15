import React from 'react';
import {
  CameraMode,
  GameScreenState,
  GameSettings,
  MatchStats,
  TeamConfig,
} from '../types/game';

interface StatusModalsProps {
  screenState: GameScreenState;
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  stats: MatchStats;
  settings: GameSettings;
  onResume: () => void;
  onRestart: () => void;
  onBackToTitle: () => void;
  onUpdateSettings: (updated: Partial<GameSettings>) => void;
}

export const StatusModals: React.FC<StatusModalsProps> = ({
  screenState,
  homeTeam,
  awayTeam,
  stats,
  settings,
  onResume,
  onRestart,
  onBackToTitle,
  onUpdateSettings,
}) => {
  if (screenState !== 'paused' && screenState !== 'gameover') {
    return null;
  }

  const totalPossession =
    stats.homePossessionFrames + stats.awayPossessionFrames || 1;
  const homePossessionPct = Math.round(
    (stats.homePossessionFrames / totalPossession) * 100
  );
  const awayPossessionPct = 100 - homePossessionPct;

  const isVictory = stats.homeGoals > stats.awayGoals;
  const isDraw = stats.homeGoals === stats.awayGoals;

  return (
    <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center p-4 bg-stone-950/80">
      {screenState === 'paused' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pause-modal-title"
          className="w-full max-w-md bg-stone-950 border-2 border-stone-800 rounded-2xl p-6 shadow-2xl text-stone-100"
        >
          <div className="text-center mb-5">
            <span className="text-xs font-bold uppercase tracking-widest text-amber-400">
              Várzea Raiz 4x4
            </span>
            <h2
              id="pause-modal-title"
              className="text-2xl font-extrabold text-white mt-1"
            >
              Partida Pausada
            </h2>
          </div>

          {/* Camera & Distance Quick Controls */}
          <div className="space-y-3 bg-stone-900/90 border border-stone-800 rounded-xl p-4 mb-6 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-stone-300 font-semibold">Visão da Câmera</span>
              <div className="flex gap-1">
                {(
                  [
                    ['follow', '3ª Pessoa'],
                    ['overview', 'Campinho'],
                    ['sideline', 'Lateral'],
                  ] as Array<[CameraMode, string]>
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onUpdateSettings({ cameraMode: m })}
                    className={`px-2.5 py-1 rounded font-bold ${
                      settings.cameraMode === m
                        ? 'bg-amber-500 text-stone-950'
                        : 'bg-stone-800 text-stone-300 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-stone-800">
              <span className="text-stone-300 font-semibold">
                Distância da Câmera
              </span>
              <input
                type="range"
                aria-label="Distância da Câmera"
                min="0.75"
                max="1.35"
                step="0.05"
                value={settings.cameraDistance}
                onChange={(e) =>
                  onUpdateSettings({
                    cameraDistance: parseFloat(e.target.value),
                  })
                }
                className="w-32 accent-amber-500"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={onResume}
              className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-sm rounded-xl transition-colors cursor-pointer"
            >
              CONTINUAR PARTIDA
            </button>
            <button
              type="button"
              onClick={onRestart}
              className="w-full py-2.5 bg-stone-800 hover:bg-stone-700 text-stone-100 font-bold text-sm rounded-xl transition-colors cursor-pointer"
            >
              REINICIAR PARTIDA
            </button>
            <button
              type="button"
              onClick={onBackToTitle}
              className="w-full py-2.5 bg-stone-900 hover:bg-stone-800 text-stone-400 hover:text-stone-200 font-semibold text-sm rounded-xl border border-stone-800 transition-colors cursor-pointer"
            >
              MENU INICIAL
            </button>
          </div>
        </div>
      )}

      {screenState === 'gameover' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="gameover-modal-title"
          className="w-full max-w-lg bg-stone-950 border-2 border-amber-500/60 rounded-2xl p-6 shadow-2xl text-stone-100"
        >
          <div className="text-center mb-5">
            <span className="text-xs font-bold uppercase tracking-widest text-amber-400">
              Apito Final no Terreirão
            </span>
            <h2
              id="gameover-modal-title"
              className="text-3xl font-extrabold text-white mt-1"
            >
              {isVictory
                ? 'VITÓRIA NA VÁRZEA!'
                : isDraw
                ? 'EMPATE SUADO NA TERRA!'
                : 'FIM DE JOGO — DERROTA'}
            </h2>
            <p className="text-xs text-stone-400 mt-1">
              {isVictory
                ? 'Yuri, Josué, Careca e Bode dominaram o campinho de barro!'
                : isDraw
                ? 'Partida equilibrada até o último lance nas poças de lama.'
                : 'Os rivais levaram a melhor desta vez. Bora pedir revanche!'}
            </p>
          </div>

          {/* Final Scoreboard Box */}
          <div className="flex items-center justify-around bg-stone-900 border border-stone-800 rounded-xl p-4 mb-5">
            <div className="text-center">
              <div className="text-xs font-bold text-amber-400 uppercase">
                {homeTeam.name}
              </div>
              <div className="text-4xl font-mono font-extrabold text-white tabular-nums mt-1">
                {stats.homeGoals}
              </div>
            </div>
            <div className="text-stone-500 font-bold text-xl">X</div>
            <div className="text-center">
              <div className="text-xs font-bold text-stone-300 uppercase">
                {awayTeam.name}
              </div>
              <div className="text-4xl font-mono font-extrabold text-white tabular-nums mt-1">
                {stats.awayGoals}
              </div>
            </div>
          </div>

          {/* Tabular Match Statistics */}
          <div className="space-y-2.5 bg-stone-900/70 border border-stone-800/80 rounded-xl p-4 mb-6 text-xs">
            <div className="flex items-center justify-between font-mono tabular-nums">
              <span className="font-bold text-amber-400">{stats.homeShots}</span>
              <span className="font-sans text-stone-400">Finalizações</span>
              <span className="font-bold text-stone-200">{stats.awayShots}</span>
            </div>
            <div className="flex items-center justify-between font-mono tabular-nums">
              <span className="font-bold text-amber-400">{stats.homePasses}</span>
              <span className="font-sans text-stone-400">Passes Realizados</span>
              <span className="font-bold text-stone-200">{stats.awayPasses}</span>
            </div>
            <div className="flex items-center justify-between font-mono tabular-nums">
              <span className="font-bold text-amber-400">{stats.homeTackles}</span>
              <span className="font-sans text-stone-400">Carrinhos / Desarmes</span>
              <span className="font-bold text-stone-200">{stats.awayTackles}</span>
            </div>
            <div className="flex items-center justify-between font-mono tabular-nums">
              <span className="font-bold text-amber-400">{homePossessionPct}%</span>
              <span className="font-sans text-stone-400">Posse de Bola</span>
              <span className="font-bold text-stone-200">{awayPossessionPct}%</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              data-start="true"
              onClick={onRestart}
              className="flex-1 py-3 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-sm rounded-xl transition-colors cursor-pointer"
            >
              JOGAR NOVAMENTE
            </button>
            <button
              type="button"
              onClick={onBackToTitle}
              className="py-3 px-5 bg-stone-800 hover:bg-stone-700 text-stone-200 font-bold text-sm rounded-xl transition-colors cursor-pointer"
            >
              MENU INICIAL
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
