import React, { useState } from 'react';
import {
  CameraMode,
  GameSettings,
  HairStyle,
  PlayerCustomization,
  ShirtStyle,
  TeamConfig,
} from '../types/game';
import { AVAILABLE_TEAMS } from '../game/rules';

interface TitleScreenProps {
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  homePlayers: PlayerCustomization[];
  settings: GameSettings;
  onStartMatch: () => void;
  onSelectHomeTeam: (team: TeamConfig) => void;
  onSelectAwayTeam: (team: TeamConfig) => void;
  onUpdatePlayer: (index: number, updated: PlayerCustomization) => void;
  onUpdateSettings: (updated: Partial<GameSettings>) => void;
}

type ActiveSubModal = 'none' | 'teams' | 'players' | 'settings';

const HAIR_LABELS: Record<HairStyle, string> = {
  short_fade: 'Degradê Curto',
  curly: 'Cacheado',
  bald: 'Careca Raiz',
  afro: 'Black / Cavanhaque',
  buzz: 'Raspado Baixo',
  cap_orange: 'Boné Laranja',
  cap_black: 'Boné Preto',
};

const SHIRT_LABELS: Record<ShirtStyle, string> = {
  patterned: 'Estampada Várzea',
  solid: 'Camisa Lisa',
  striped: 'Listrada Tradicional',
  shirtless: 'Sem Camisa (Pelada)',
  tank_top: 'Regata Raiz',
};

const SKIN_TONES = [
  '#c68b63',
  '#b57c56',
  '#a66e4a',
  '#8d5837',
  '#78472a',
  '#5c3319',
];

export const TitleScreen: React.FC<TitleScreenProps> = ({
  homeTeam,
  awayTeam,
  homePlayers,
  settings,
  onStartMatch,
  onSelectHomeTeam,
  onSelectAwayTeam,
  onUpdatePlayer,
  onUpdateSettings,
}) => {
  const [activeModal, setActiveModal] = useState<ActiveSubModal>('none');
  const [selectedPlayerIdx, setSelectedPlayerIdx] = useState(0);

  const selectedPlayer = homePlayers[selectedPlayerIdx] || homePlayers[0];

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-5 md:p-10">
      {/* Measured left-only scrim for 4.5:1 text contrast while keeping the 3D Várzea campinho bright and clear */}
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'linear-gradient(90deg, rgba(12, 10, 9, 0.76) 0%, rgba(12, 10, 9, 0.42) 38%, rgba(12, 10, 9, 0.0) 68%)',
        }}
      />

      {/* Top Row: Custom SVG Title Lockup & Main Menu Actions */}
      <div className="flex flex-col lg:flex-row items-start justify-between gap-8 w-full max-w-7xl mx-auto my-auto">
        {/* Left Negative-Space Column: Bespoke SVG Emblem + Roster + Menu CTAs */}
        <div className="pointer-events-auto flex flex-col items-start max-w-lg w-full">
          {/* Bespoke Inline SVG Title Emblem */}
          <div className="mb-4 w-full">
            <svg
              viewBox="0 0 460 128"
              className="w-full max-w-[430px] h-auto drop-shadow-[0_6px_16px_rgba(0,0,0,0.85)]"
              role="img"
              aria-label="Várzea Raiz 4x4"
            >
              {/* Rustic Terracotta Plaque Backing */}
              <path
                d="M12 20 L438 12 L448 92 L20 104 Z"
                fill="#1c1917"
                stroke="#d97706"
                strokeWidth="3"
              />
              <path
                d="M18 26 L432 18 L440 86 L26 98 Z"
                fill="#292524"
                stroke="#78350f"
                strokeWidth="1.5"
              />
              {/* Emblem Soccer Ball + Dirt Splash Icon */}
              <g transform="translate(54, 58)">
                <circle cx="0" cy="0" r="26" fill="#e7e5e4" stroke="#1c1917" strokeWidth="2.5" />
                <polygon points="0,-12 11,-4 7,9 -7,9 -11,-4" fill="#1c1917" />
                <path d="M0,-12 L0,-25 M11,-4 L23,-8 M7,9 L17,20 M-7,9 L-17,20 M-11,-4 L-23,-8" stroke="#1c1917" strokeWidth="2.5" />
              </g>
              {/* Main Display Typography */}
              <text
                x="96"
                y="62"
                fill="#fef3c7"
                fontFamily="'Barlow Condensed', sans-serif"
                fontWeight="800"
                fontStyle="italic"
                fontSize="50"
                letterSpacing="1.5"
              >
                VÁRZEA RAIZ
              </text>
              {/* 4x4 Stamp */}
              <rect x="352" y="24" rx="6" width="74" height="44" fill="#d97706" />
              <text
                x="389"
                y="55"
                textAnchor="middle"
                fill="#1c1917"
                fontFamily="'Barlow Condensed', sans-serif"
                fontWeight="800"
                fontSize="34"
              >
                4x4
              </text>
              {/* Subtitle Kicker */}
              <text
                x="98"
                y="84"
                fill="#fbbf24"
                fontFamily="'Plus Jakarta Sans', sans-serif"
                fontWeight="700"
                fontSize="12.5"
                letterSpacing="2.8"
              >
                FUTEBOL DE TERRA BATIDA · LAMA &amp; RAÇA
              </text>
            </svg>
          </div>

          <p className="text-stone-300 text-sm md:text-base leading-relaxed mb-5 max-w-md">
            O campinho de barro real com poças d&apos;água, muros de tijolo, cerca de
            madeira e disputa 4 contra 4 sem frescura.
          </p>

          {/* Team 1 Squad Roster Summary (Yuri, Josué, Careca, Bode) */}
          <div className="w-full bg-stone-950/90 border border-stone-800 rounded-xl p-3.5 mb-6 shadow-xl">
            <div className="flex items-center justify-between text-xs text-stone-400 mb-2.5 pb-2 border-b border-stone-800/80">
              <span className="font-semibold text-amber-400 uppercase tracking-wider">
                Nosso Time: {homeTeam.name}
              </span>
              <span>Titulares 4x4</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {homePlayers.map((player, idx) => (
                <button
                  key={player.id}
                  type="button"
                  onClick={() => {
                    setSelectedPlayerIdx(idx);
                    setActiveModal('players');
                  }}
                  className="group flex flex-col items-center p-2 rounded-lg bg-stone-900/90 hover:bg-stone-800 border border-stone-800 hover:border-amber-500/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span
                      className="w-3 h-3 rounded-full border border-white/20 shrink-0"
                      style={{
                        backgroundColor:
                          player.shirtStyle === 'shirtless'
                            ? player.skinColor
                            : player.shirtPrimary,
                      }}
                    />
                    <span className="text-xs font-mono font-bold text-stone-400 tabular-nums">
                      #{player.number}
                    </span>
                  </div>
                  <span className="text-sm font-bold text-stone-100 group-hover:text-amber-300 truncate w-full text-center">
                    {player.name}
                  </span>
                  <span className="text-[11px] text-stone-400 uppercase tracking-tight">
                    {player.role}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* 4 Required Menu Buttons: JOGAR, ESCOLHER TIME, PERSONALIZAR JOGADORES, CONFIGURAÇÕES */}
          <div className="flex flex-col sm:flex-row flex-wrap gap-3 w-full">
            <button
              type="button"
              data-start="true"
              onClick={onStartMatch}
              className="w-full sm:w-auto flex-1 py-3.5 px-7 bg-amber-500 hover:bg-amber-400 active:translate-y-0.5 text-stone-950 font-extrabold text-lg tracking-wide rounded-xl shadow-lg transition-all cursor-pointer whitespace-nowrap"
            >
              JOGAR
            </button>

            <button
              type="button"
              onClick={() =>
                setActiveModal(activeModal === 'teams' ? 'none' : 'teams')
              }
              className={`py-3 px-4 font-bold text-sm rounded-xl border transition-colors cursor-pointer whitespace-nowrap ${
                activeModal === 'teams'
                  ? 'bg-stone-800 text-amber-300 border-amber-500'
                  : 'bg-stone-900/95 hover:bg-stone-800 text-stone-200 border-stone-700'
              }`}
            >
              ESCOLHER TIME
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 w-full mt-3">
            <button
              type="button"
              onClick={() =>
                setActiveModal(activeModal === 'players' ? 'none' : 'players')
              }
              className={`py-2.5 px-4 font-semibold text-xs sm:text-sm rounded-xl border transition-colors cursor-pointer whitespace-nowrap truncate ${
                activeModal === 'players'
                  ? 'bg-stone-800 text-amber-300 border-amber-500'
                  : 'bg-stone-900/95 hover:bg-stone-800 text-stone-200 border-stone-800'
              }`}
            >
              PERSONALIZAR JOGADORES
            </button>

            <button
              type="button"
              onClick={() =>
                setActiveModal(activeModal === 'settings' ? 'none' : 'settings')
              }
              className={`py-2.5 px-4 font-semibold text-xs sm:text-sm rounded-xl border transition-colors cursor-pointer whitespace-nowrap truncate ${
                activeModal === 'settings'
                  ? 'bg-stone-800 text-amber-300 border-amber-500'
                  : 'bg-stone-900/95 hover:bg-stone-800 text-stone-200 border-stone-800'
              }`}
            >
              CONFIGURAÇÕES
            </button>
          </div>
        </div>

        {/* Right Side Panel: Active Sub-Modal (Escolher Time / Personalizar Jogadores / Configurações) */}
        {activeModal !== 'none' && (
          <div className="pointer-events-auto w-full max-w-md bg-stone-950/95 border border-stone-800 rounded-2xl p-5 shadow-2xl text-stone-100 self-center">
            {activeModal === 'teams' && (
              <div>
                <div className="flex items-center justify-between pb-3 mb-4 border-b border-stone-800">
                  <h2 className="text-lg font-bold text-amber-400">
                    Escolher Time e Uniforme
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    className="px-2.5 py-1 text-xs font-semibold text-stone-400 hover:text-white bg-stone-900 rounded-lg"
                  >
                    Fechar
                  </button>
                </div>

                <p className="text-xs text-stone-400 mb-3">
                  Selecione o manto para Yuri, Josué, Careca e Bode:
                </p>

                <div className="space-y-2.5 mb-5">
                  {AVAILABLE_TEAMS.map((team) => {
                    const isSelected = team.id === homeTeam.id;
                    return (
                      <button
                        key={team.id}
                        type="button"
                        onClick={() => onSelectHomeTeam(team)}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-colors ${
                          isSelected
                            ? 'bg-stone-900 border-amber-500'
                            : 'bg-stone-900/60 border-stone-800 hover:border-stone-700'
                        }`}
                      >
                        <div>
                          <div className="font-bold text-sm text-stone-100">
                            {team.name}
                          </div>
                          <div className="text-xs text-stone-400 mt-0.5">
                            {team.description}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-3">
                          <span
                            className="w-5 h-5 rounded-full border border-white/20"
                            style={{ backgroundColor: team.primaryColor }}
                          />
                          <span
                            className="w-5 h-5 rounded-full border border-white/20"
                            style={{ backgroundColor: team.shortsColor }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="pt-3 border-t border-stone-800 flex items-center justify-between text-xs text-stone-400">
                  <span>Adversário: {awayTeam.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const others = AVAILABLE_TEAMS.filter(
                        (t) => t.id !== awayTeam.id && t.id !== homeTeam.id
                      );
                      if (others.length > 0) {
                        onSelectAwayTeam(others[0]);
                      }
                    }}
                    className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 rounded-lg font-semibold"
                  >
                    Trocar Rival
                  </button>
                </div>
              </div>
            )}

            {activeModal === 'players' && selectedPlayer && (
              <div>
                <div className="flex items-center justify-between pb-3 mb-4 border-b border-stone-800">
                  <h2 className="text-lg font-bold text-amber-400">
                    Personalizar Jogadores
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    className="px-2.5 py-1 text-xs font-semibold text-stone-400 hover:text-white bg-stone-900 rounded-lg"
                  >
                    Fechar
                  </button>
                </div>

                {/* Player Selector Tabs */}
                <div className="grid grid-cols-4 gap-1.5 mb-4 p-1 bg-stone-900 rounded-xl">
                  {homePlayers.map((p, idx) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedPlayerIdx(idx)}
                      className={`py-2 px-2 rounded-lg text-xs font-bold transition-colors truncate ${
                        selectedPlayerIdx === idx
                          ? 'bg-amber-500 text-stone-950'
                          : 'text-stone-300 hover:text-white'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>

                <div className="space-y-3.5 text-xs">
                  <div>
                    <label
                      htmlFor="player-name-input"
                      className="block text-stone-400 mb-1 font-medium"
                    >
                      Nome do Jogador ({selectedPlayer.role.toUpperCase()})
                    </label>
                    <input
                      id="player-name-input"
                      type="text"
                      maxLength={14}
                      value={selectedPlayer.name}
                      onChange={(e) =>
                        onUpdatePlayer(selectedPlayerIdx, {
                          ...selectedPlayer,
                          name: e.target.value || 'Jogador',
                        })
                      }
                      className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm font-bold text-white focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="player-hair-select"
                        className="block text-stone-400 mb-1 font-medium"
                      >
                        Cabelo / Boné
                      </label>
                      <select
                        id="player-hair-select"
                        value={selectedPlayer.hairStyle}
                        onChange={(e) =>
                          onUpdatePlayer(selectedPlayerIdx, {
                            ...selectedPlayer,
                            hairStyle: e.target.value as HairStyle,
                          })
                        }
                        className="w-full px-2.5 py-2 bg-stone-900 border border-stone-700 rounded-lg text-white"
                      >
                        {(Object.keys(HAIR_LABELS) as HairStyle[]).map((hs) => (
                          <option key={hs} value={hs}>
                            {HAIR_LABELS[hs]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="player-shirt-select"
                        className="block text-stone-400 mb-1 font-medium"
                      >
                        Estilo de Camisa
                      </label>
                      <select
                        id="player-shirt-select"
                        value={selectedPlayer.shirtStyle}
                        onChange={(e) =>
                          onUpdatePlayer(selectedPlayerIdx, {
                            ...selectedPlayer,
                            shirtStyle: e.target.value as ShirtStyle,
                          })
                        }
                        className="w-full px-2.5 py-2 bg-stone-900 border border-stone-700 rounded-lg text-white"
                      >
                        {(Object.keys(SHIRT_LABELS) as ShirtStyle[]).map(
                          (ss) => (
                            <option key={ss} value={ss}>
                              {SHIRT_LABELS[ss]}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>

                  <div>
                    <span className="block text-stone-400 mb-1.5 font-medium">
                      Tom de Pele
                    </span>
                    <div className="flex items-center gap-2">
                      {SKIN_TONES.map((tone) => (
                        <button
                          key={tone}
                          type="button"
                          aria-label={`Tom de pele ${tone}`}
                          onClick={() =>
                            onUpdatePlayer(selectedPlayerIdx, {
                              ...selectedPlayer,
                              skinColor: tone,
                            })
                          }
                          className={`w-7 h-7 rounded-full border-2 transition-transform ${
                            selectedPlayer.skinColor === tone
                              ? 'border-amber-400 scale-110'
                              : 'border-stone-700'
                          }`}
                          style={{ backgroundColor: tone }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-stone-800">
                    <span className="text-stone-300 font-medium">
                      Jogar Descalço na Terra
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdatePlayer(selectedPlayerIdx, {
                          ...selectedPlayer,
                          barefoot: !selectedPlayer.barefoot,
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                        selectedPlayer.barefoot
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-800 text-stone-300'
                      }`}
                    >
                      {selectedPlayer.barefoot ? 'Descalço (Raiz)' : 'De Chuteira'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeModal === 'settings' && (
              <div>
                <div className="flex items-center justify-between pb-3 mb-4 border-b border-stone-800">
                  <h2 className="text-lg font-bold text-amber-400">
                    Configurações da Partida
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    className="px-2.5 py-1 text-xs font-semibold text-stone-400 hover:text-white bg-stone-900 rounded-lg"
                  >
                    Fechar
                  </button>
                </div>

                <div className="space-y-4 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-stone-300 font-medium">
                      Câmera da Partida
                    </span>
                    <div className="flex gap-1 bg-stone-900 p-1 rounded-lg">
                      {(
                        [
                          ['follow', '3ª Pessoa'],
                          ['overview', 'Campinho Todo'],
                          ['sideline', 'Lateral'],
                        ] as Array<[CameraMode, string]>
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => onUpdateSettings({ cameraMode: mode })}
                          className={`px-2.5 py-1.5 rounded-md font-semibold transition-colors ${
                            settings.cameraMode === mode
                              ? 'bg-amber-500 text-stone-950'
                              : 'text-stone-400 hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-stone-300 font-medium">
                      Dificuldade dos Adversários
                    </span>
                    <div className="flex gap-1 bg-stone-900 p-1 rounded-lg">
                      {(
                        [
                          ['raiz', 'Casual'],
                          ['equilibrado', 'Raiz'],
                          ['lenda', 'Lenda'],
                        ] as const
                      ).map(([diff, label]) => (
                        <button
                          key={diff}
                          type="button"
                          onClick={() =>
                            onUpdateSettings({ aiDifficulty: diff })
                          }
                          className={`px-2.5 py-1.5 rounded-md font-semibold transition-colors ${
                            settings.aiDifficulty === diff
                              ? 'bg-amber-500 text-stone-950'
                              : 'text-stone-400 hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-stone-300 font-medium">
                      Duração de Cada Tempo
                    </span>
                    <div className="flex gap-1 bg-stone-900 p-1 rounded-lg">
                      {[
                        [180, '3 min'],
                        [300, '5 min (Padrão)'],
                      ].map(([secs, label]) => (
                        <button
                          key={secs}
                          type="button"
                          onClick={() =>
                            onUpdateSettings({
                              halfDurationSeconds: Number(secs),
                            })
                          }
                          className={`px-2.5 py-1.5 rounded-md font-semibold transition-colors ${
                            settings.halfDurationSeconds === secs
                              ? 'bg-amber-500 text-stone-950'
                              : 'text-stone-400 hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-stone-300 font-medium">
                      Efeitos Sonoros (Terra, Bola, Apito)
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          soundEnabled: !settings.soundEnabled,
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg font-bold ${
                        settings.soundEnabled
                          ? 'bg-emerald-600 text-white'
                          : 'bg-stone-800 text-stone-400'
                      }`}
                    >
                      {settings.soundEnabled ? 'Ativado' : 'Mudo'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-stone-300 font-medium">
                      Batucada no Menu Inicial
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          musicEnabled: !settings.musicEnabled,
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg font-bold ${
                        settings.musicEnabled
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-800 text-stone-400'
                      }`}
                    >
                      {settings.musicEnabled ? 'Ligada' : 'Desligada'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Safe Margin: Single Flat Borderless Control Hint Line */}
      <div className="w-full max-w-7xl mx-auto pt-4 flex flex-wrap items-center justify-between gap-4 text-xs text-stone-300/90">
        <span>
          WASD Movimentar · Shift Correr · Espaço Chutar · E Passe · F Carrinho · Q Trocar Jogador · P Pausar
        </span>
        <span className="text-stone-400">
          Celular: Joystick Virtual + Botões de Toque Adaptativos
        </span>
      </div>
    </div>
  );
};
