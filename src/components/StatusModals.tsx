import React, { useEffect, useState } from 'react';
import {
  CameraMode,
  GameScreenState,
  GameSettings,
  KeyBindingsConfig,
  MatchStats,
  MultiplayerRoomState,
  TeamConfig,
} from '../types/game';
import {
  DEFAULT_KEY_BINDINGS,
  formatKeyCodeLabel,
  remapKeyWithoutConflict,
} from '../game/controls';
import { VoiceControlsBar } from './VoiceControlsBar';

interface StatusModalsProps {
  screenState: GameScreenState;
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  stats: MatchStats;
  settings: GameSettings;
  activeRoom?: MultiplayerRoomState | null;
  onResume: () => void;
  onRestart: () => void;
  onBackToTitle: () => void;
  onUpdateSettings: (updated: Partial<GameSettings>) => void;
}

const KEY_BINDING_LABELS: Array<{
  action: keyof KeyBindingsConfig;
  label: string;
}> = [
  { action: 'moveUp', label: 'Mover Cima' },
  { action: 'moveDown', label: 'Mover Baixo' },
  { action: 'moveLeft', label: 'Mover Esquerda' },
  { action: 'moveRight', label: 'Mover Direita' },
  { action: 'sprint', label: 'Correr (Sprint)' },
  { action: 'shoot', label: 'Chutar' },
  { action: 'pass', label: 'Passe Direcional' },
  { action: 'longPass', label: 'Lançamento' },
  { action: 'tackle', label: 'Carrinho / Desarme' },
  { action: 'switchPlayer', label: 'Trocar Jogador' },
];

export const StatusModals: React.FC<StatusModalsProps> = ({
  screenState,
  homeTeam,
  awayTeam,
  stats,
  settings,
  activeRoom = null,
  onResume,
  onRestart,
  onBackToTitle,
  onUpdateSettings,
}) => {
  const [activeTab, setActiveTab] = useState<'geral' | 'teclado' | 'mobile'>('geral');
  const [listeningAction, setListeningAction] = useState<keyof KeyBindingsConfig | null>(null);

  const currentBindings: KeyBindingsConfig = {
    ...DEFAULT_KEY_BINDINGS,
    ...(settings.keyBindings || {}),
  };

  useEffect(() => {
    if (!listeningAction) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListeningAction(null);
        return;
      }
      const updated = remapKeyWithoutConflict(
        currentBindings,
        listeningAction,
        e.code
      );
      onUpdateSettings({ keyBindings: updated });
      setListeningAction(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listeningAction, currentBindings, onUpdateSettings]);

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

  const roomParticipants = activeRoom
    ? Object.values(activeRoom.slots || {}).filter((s) =>
        activeRoom.activeCharacterIds
          ? activeRoom.activeCharacterIds.includes(s.characterId)
          : true
      )
    : [];

  const mobileCfg = {
    scale: settings.mobileControls?.scale ?? 1.0,
    joystickSensitivity: settings.mobileControls?.joystickSensitivity ?? 1.0,
    layoutPreset: settings.mobileControls?.layoutPreset ?? 'padrao',
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-sm overflow-y-auto">
      {screenState === 'paused' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pause-modal-title"
          className="w-full max-w-lg bg-stone-950 border-2 border-stone-800 rounded-2xl p-4 sm:p-6 shadow-2xl text-stone-100 space-y-4 my-auto max-h-[92vh] overflow-y-auto"
        >
          <div className="text-center">
            <span className="text-xs font-bold uppercase tracking-widest text-amber-400">
              SEM TERRA FC · VÁRZEA {activeRoom?.mode === '2v2' ? '2x2' : '4x4'}
            </span>
            <h2
              id="pause-modal-title"
              className="text-xl sm:text-2xl font-extrabold text-white mt-0.5"
            >
              Menu e Controles da Partida
            </h2>
          </div>

          {activeRoom && <VoiceControlsBar roomCode={activeRoom.roomCode} />}

          {/* Settings Sub-tabs */}
          <div className="grid grid-cols-3 gap-1.5 bg-stone-900 p-1 rounded-xl border border-stone-800 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab('geral')}
              className={`py-1.5 rounded-lg font-extrabold cursor-pointer transition-colors ${
                activeTab === 'geral'
                  ? 'bg-amber-500 text-stone-950'
                  : 'text-stone-300 hover:text-white'
              }`}
            >
              Câmera & Jogo
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('teclado')}
              className={`py-1.5 rounded-lg font-extrabold cursor-pointer transition-colors ${
                activeTab === 'teclado'
                  ? 'bg-amber-500 text-stone-950'
                  : 'text-stone-300 hover:text-white'
              }`}
            >
              Teclas (PC)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('mobile')}
              className={`py-1.5 rounded-lg font-extrabold cursor-pointer transition-colors ${
                activeTab === 'mobile'
                  ? 'bg-amber-500 text-stone-950'
                  : 'text-stone-300 hover:text-white'
              }`}
            >
              Touch (Mobile)
            </button>
          </div>

          {activeTab === 'geral' && (
            <div className="space-y-3 bg-stone-900/90 border border-stone-800 rounded-xl p-3.5 text-xs">
              <div className="flex items-center justify-between gap-2">
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
                      className={`px-2.5 py-1 rounded font-bold cursor-pointer ${
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
                  className="w-32 accent-amber-500 cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-stone-800">
                <span className="text-stone-300 font-semibold">
                  Troca Automática ao Receber Passe
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({
                      autoSwitchPlayer: settings.autoSwitchPlayer === false,
                    })
                  }
                  className={`px-3 py-1 rounded font-bold cursor-pointer ${
                    settings.autoSwitchPlayer !== false
                      ? 'bg-emerald-500 text-stone-950'
                      : 'bg-stone-800 text-stone-400'
                  }`}
                >
                  {settings.autoSwitchPlayer !== false ? 'ATIVADA' : 'MANUAL'}
                </button>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-stone-800">
                <span className="text-stone-300 font-semibold">
                  Qualidade Gráfica 3D
                </span>
                <div className="flex gap-1">
                  {(
                    [
                      ['auto', 'Auto'],
                      ['desempenho', 'Desempenho'],
                      ['alta', 'Alta'],
                    ] as const
                  ).map(([q, label]) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => onUpdateSettings({ graphicsQuality: q })}
                      className={`px-2 py-1 rounded font-bold cursor-pointer ${
                        (settings.graphicsQuality || 'auto') === q
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-800 text-stone-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'teclado' && (
            <div className="space-y-2.5 bg-stone-900/90 border border-stone-800 rounded-xl p-3.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-stone-400">
                  Clique em uma ação para remapear a tecla (sem conflitos):
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({ keyBindings: { ...DEFAULT_KEY_BINDINGS } })
                  }
                  className="text-[11px] font-bold text-amber-400 hover:underline cursor-pointer"
                >
                  Restaurar Padrão
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {KEY_BINDING_LABELS.map(({ action, label }) => {
                  const isListening = listeningAction === action;
                  return (
                    <button
                      key={action}
                      type="button"
                      onClick={() =>
                        setListeningAction(isListening ? null : action)
                      }
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-left cursor-pointer ${
                        isListening
                          ? 'bg-amber-500/20 border-amber-400 text-amber-200 animate-pulse'
                          : 'bg-stone-950 border-stone-800 text-stone-200 hover:border-stone-700'
                      }`}
                    >
                      <span className="truncate pr-1 font-medium">{label}</span>
                      <span className="px-2 py-0.5 rounded bg-stone-800 font-mono font-bold text-amber-400 text-[10px] shrink-0">
                        {isListening
                          ? 'TECLE...'
                          : formatKeyCodeLabel(currentBindings[action])}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'mobile' && (
            <div className="space-y-3 bg-stone-900/90 border border-stone-800 rounded-xl p-3.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-stone-300 font-semibold">
                  Tamanho dos Botões e Joystick ({Math.round(mobileCfg.scale * 100)}%)
                </span>
                <input
                  type="range"
                  min="0.8"
                  max="1.25"
                  step="0.05"
                  value={mobileCfg.scale}
                  onChange={(e) =>
                    onUpdateSettings({
                      mobileControls: {
                        ...mobileCfg,
                        scale: parseFloat(e.target.value),
                      },
                    })
                  }
                  className="w-32 accent-amber-500 cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-stone-800">
                <span className="text-stone-300 font-semibold">
                  Sensibilidade do Joystick 360°
                </span>
                <input
                  type="range"
                  min="0.7"
                  max="1.4"
                  step="0.05"
                  value={mobileCfg.joystickSensitivity}
                  onChange={(e) =>
                    onUpdateSettings({
                      mobileControls: {
                        ...mobileCfg,
                        joystickSensitivity: parseFloat(e.target.value),
                      },
                    })
                  }
                  className="w-32 accent-amber-500 cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-stone-800">
                <span className="text-stone-300 font-semibold">
                  Disposição dos Botões Touch
                </span>
                <div className="flex gap-1">
                  {(
                    [
                      ['compacto', 'Compacto'],
                      ['padrao', 'Padrão'],
                      ['espacado', 'Espaçado'],
                    ] as const
                  ).map(([preset, label]) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          mobileControls: {
                            ...mobileCfg,
                            layoutPreset: preset,
                          },
                        })
                      }
                      className={`px-2.5 py-1 rounded font-bold cursor-pointer ${
                        mobileCfg.layoutPreset === preset
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-800 text-stone-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onResume}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-sm rounded-xl transition-colors cursor-pointer"
            >
              CONTINUAR JOGANDO
            </button>
            {!activeRoom && (
              <button
                type="button"
                onClick={onRestart}
                className="w-full py-2.5 bg-stone-800 hover:bg-stone-700 text-stone-100 font-bold text-sm rounded-xl transition-colors cursor-pointer"
              >
                REINICIAR PARTIDA
              </button>
            )}
            <button
              type="button"
              onClick={onBackToTitle}
              className="w-full py-2.5 bg-red-950/80 hover:bg-red-900 text-red-200 border border-red-800/80 font-extrabold text-sm rounded-xl transition-colors cursor-pointer"
            >
              SAIR DA PARTIDA
            </button>
            <button
              type="button"
              onClick={onBackToTitle}
              className="w-full py-2 bg-stone-900 hover:bg-stone-800 text-stone-400 hover:text-stone-200 font-semibold text-xs rounded-xl border border-stone-800 transition-colors cursor-pointer"
            >
              VOLTAR AO MENU PRINCIPAL
            </button>
          </div>
        </div>
      )}

      {screenState === 'gameover' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="gameover-modal-title"
          className="w-full max-w-lg bg-stone-950 border-2 border-amber-500/60 rounded-2xl p-6 shadow-2xl text-stone-100 space-y-4"
        >
          <div className="text-center">
            <span className="text-xs font-bold uppercase tracking-widest text-amber-400">
              SEM TERRA FC · APITO FINAL NO TERREIRÃO
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
          <div className="flex items-center justify-around bg-stone-900 border border-stone-800 rounded-xl p-4">
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

          {/* Goal Scorers Summary */}
          {stats.scorers && stats.scorers.length > 0 && (
            <div className="bg-stone-900/80 border border-stone-800 rounded-xl p-3 text-xs space-y-1">
              <div className="font-bold text-amber-400 uppercase text-[10px] tracking-wider">
                Gols Marcados na Partida
              </div>
              <div className="flex flex-wrap gap-1.5">
                {stats.scorers.map((sc, idx) => (
                  <span
                    key={`${sc.playerName}-${idx}`}
                    className="px-2 py-0.5 rounded bg-stone-950 border border-stone-800 text-stone-200 font-semibold"
                  >
                    ⚽ {sc.playerName} ({sc.timeFormatted} · {sc.half}ºT)
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Participating Players in Online Room */}
          {roomParticipants.length > 0 && (
            <div className="bg-stone-900/80 border border-stone-800 rounded-xl p-3 text-xs space-y-1.5">
              <div className="font-bold text-stone-300 uppercase text-[10px] tracking-wider">
                Jogadores Participantes ({activeRoom?.mode === '2v2' ? '2v2' : '4v4'})
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {roomParticipants.map((slot) => (
                  <div
                    key={slot.characterId}
                    className="px-2 py-1 rounded bg-stone-950 border border-stone-800 flex items-center justify-between text-[11px]"
                  >
                    <span className="font-bold text-white">{slot.characterName}</span>
                    <span className="text-stone-400 truncate max-w-[90px]">
                      {slot.isBot ? 'Bot IA' : slot.displayName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tabular Match Statistics */}
          <div className="space-y-2 bg-stone-900/70 border border-stone-800/80 rounded-xl p-3.5 text-xs">
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
              VOLTAR AO MENU
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
