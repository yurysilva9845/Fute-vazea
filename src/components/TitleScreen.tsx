import React, { useEffect, useState } from 'react';
import {
  CameraMode,
  GameSettings,
  HairStyle,
  MultiplayerRoomState,
  PlayerCustomization,
  ShirtStyle,
  TeamConfig,
} from '../types/game';
import { AVAILABLE_TEAMS } from '../game/rules';

interface TitleScreenProps {
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  homePlayers: PlayerCustomization[];
  awayPlayers: PlayerCustomization[];
  settings: GameSettings;
  activeRoom: MultiplayerRoomState | null;
  onStartMatch: () => void;
  onStartFullscreenMatch: () => void;
  onOpenMultiplayer: (tab: 'lobby' | 'friends' | 'diagnostic') => void;
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
  receding_careca: 'Calvo Lateral',
  afro: 'Black / Cavanhaque',
  buzz: 'Raspado Baixo',
  bucket_hat_josue: 'Chapéu Pescador (Josué)',
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
  '#4a2c18',
];

function detectMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.innerWidth <= 920 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches)
  );
}

export const TitleScreen: React.FC<TitleScreenProps> = ({
  homeTeam,
  awayTeam,
  homePlayers,
  awayPlayers,
  settings,
  activeRoom,
  onStartMatch,
  onStartFullscreenMatch,
  onOpenMultiplayer,
  onSelectHomeTeam,
  onSelectAwayTeam,
  onUpdatePlayer,
  onUpdateSettings,
}) => {
  const [activeModal, setActiveModal] = useState<ActiveSubModal>('none');
  const [selectedPlayerIdx, setSelectedPlayerIdx] = useState(0);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    detectMobileViewport()
  );

  useEffect(() => {
    const onResize = () => setIsMobile(detectMobileViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const selectedPlayer = homePlayers[selectedPlayerIdx] || homePlayers[0];

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-4 md:p-8 overflow-y-auto">
      {/* Measured left-only scrim for 4.5:1 text contrast while keeping the 3D Várzea campinho bright and clear */}
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'linear-gradient(90deg, rgba(12, 10, 9, 0.78) 0%, rgba(12, 10, 9, 0.45) 42%, rgba(12, 10, 9, 0.0) 70%)',
        }}
      />

      {/* Mobile Landscape & Fullscreen Banner */}
      {isMobile && (
        <div className="pointer-events-auto w-full max-w-2xl mx-auto mb-3 bg-stone-950/95 border-2 border-amber-500 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-2.5 shadow-2xl">
          <p className="text-xs font-bold text-amber-200 text-center sm:text-left">
            Vire seu celular para jogar na horizontal e toque para entrar em
            tela cheia.
          </p>
          <button
            type="button"
            onClick={onStartFullscreenMatch}
            className="w-full sm:w-auto px-4 py-2 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-xs rounded-lg shadow-lg cursor-pointer whitespace-nowrap"
          >
            JOGAR EM TELA CHEIA
          </button>
        </div>
      )}

      {/* Top Row: Custom SVG Title Lockup & Main Menu Actions */}
      <div className="flex flex-col lg:flex-row items-start justify-between gap-6 w-full max-w-7xl mx-auto my-auto">
        {/* Left Negative-Space Column: Bespoke SVG Emblem + Roster + Menu CTAs */}
        <div className="pointer-events-auto flex flex-col items-start max-w-lg w-full">
          {/* Bespoke Inline SVG Title Emblem — SEM TERRA FC VÁRZEA 4x4 */}
          <div className="mb-3 w-full">
            <svg
              viewBox="0 0 460 128"
              className="w-full max-w-[420px] h-auto drop-shadow-[0_6px_16px_rgba(0,0,0,0.85)]"
              role="img"
              aria-label="SEM TERRA FC Várzea 4x4"
            >
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
              <g transform="translate(52, 58)">
                <circle
                  cx="0"
                  cy="0"
                  r="26"
                  fill="#e7e5e4"
                  stroke="#1c1917"
                  strokeWidth="2.5"
                />
                <polygon
                  points="0,-12 11,-4 7,9 -7,9 -11,-4"
                  fill="#1c1917"
                />
                <path
                  d="M0,-12 L0,-25 M11,-4 L23,-8 M7,9 L17,20 M-7,9 L-17,20 M-11,-4 L-23,-8"
                  stroke="#1c1917"
                  strokeWidth="2.5"
                />
              </g>
              <text
                x="92"
                y="62"
                fill="#fef3c7"
                fontFamily="'Barlow Condensed', sans-serif"
                fontWeight="800"
                fontStyle="italic"
                fontSize="44"
                letterSpacing="1.2"
              >
                SEM TERRA FC
              </text>
              <rect
                x="352"
                y="24"
                rx="6"
                width="74"
                height="44"
                fill="#d97706"
              />
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
              <text
                x="94"
                y="84"
                fill="#fbbf24"
                fontFamily="'Plus Jakarta Sans', sans-serif"
                fontWeight="700"
                fontSize="11.5"
                letterSpacing="2.0"
              >
                VÁRZEA 4x4 · 2v2 &amp; 4v4 MULTIPLAYER ONLINE
              </text>
            </svg>
          </div>

          <p className="text-stone-300 text-xs sm:text-sm leading-relaxed mb-4 max-w-md">
            O campinho de barro real com poças d&apos;água, travinhas de mini
            campo, skins fiéis e multiplayer online 2v2 e 4v4 com voz em tempo
            real!
          </p>

          {/* Team 1 & Team 2 Squad Roster Summary */}
          <div className="w-full bg-stone-950/90 border border-stone-800 rounded-xl p-3 mb-4 shadow-xl space-y-2.5">
            <div>
              <div className="flex items-center justify-between text-xs text-stone-400 mb-1.5">
                <span className="font-bold text-amber-400 uppercase tracking-wider">
                  Time 1: {homeTeam.name}
                </span>
                <span className="text-[11px] text-stone-400">
                  Adversários: {awayPlayers.map((a) => a.name).join(', ')}
                </span>
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
                    className="group flex flex-col items-center p-2 rounded-lg bg-stone-900/90 hover:bg-stone-800 border border-stone-800 hover:border-amber-500/50 transition-colors text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span
                        className="w-2.5 h-2.5 rounded-full border border-white/20 shrink-0"
                        style={{
                          backgroundColor: player.skinColor,
                        }}
                      />
                      <span className="text-[11px] font-mono font-bold text-stone-400 tabular-nums">
                        #{player.number}
                      </span>
                    </div>
                    <span className="text-xs sm:text-sm font-bold text-stone-100 group-hover:text-amber-300 truncate w-full text-center">
                      {player.name}
                    </span>
                    <span className="text-[10px] text-stone-400 uppercase tracking-tight">
                      {player.role}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Primary Play & Fullscreen Buttons */}
          <div className="flex flex-col sm:flex-row gap-2.5 w-full">
            <button
              type="button"
              data-start="true"
              onClick={onStartMatch}
              className="flex-1 py-3.5 px-6 bg-amber-500 hover:bg-amber-400 active:translate-y-0.5 text-stone-950 font-extrabold text-base sm:text-lg tracking-wide rounded-xl shadow-lg transition-all cursor-pointer whitespace-nowrap"
            >
              JOGAR AGORA
            </button>

            <button
              type="button"
              onClick={onStartFullscreenMatch}
              className="py-3.5 px-5 bg-stone-900/95 hover:bg-stone-800 text-amber-400 border-2 border-amber-500/80 font-extrabold text-xs sm:text-sm tracking-wide rounded-xl shadow-lg transition-all cursor-pointer whitespace-nowrap"
            >
              JOGAR EM TELA CHEIA
            </button>
          </div>

          {/* Online Multiplayer & Friends Row */}
          <div className="grid grid-cols-2 gap-2.5 w-full mt-2.5">
            <button
              type="button"
              onClick={() => onOpenMultiplayer('lobby')}
              className="py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs sm:text-sm rounded-xl shadow-md transition-colors cursor-pointer flex items-center justify-center gap-1.5"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-200 animate-pulse" />
              <span>
                {activeRoom
                  ? `SALA ${activeRoom.roomCode}`
                  : 'MULTIPLAYER ONLINE'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onOpenMultiplayer('friends')}
              className="py-3 px-4 bg-sky-700 hover:bg-sky-600 text-white font-extrabold text-xs sm:text-sm rounded-xl shadow-md transition-colors cursor-pointer"
            >
              JOGAR COM AMIGOS
            </button>
          </div>

          {/* Secondary Customization, Teams, Settings & Firebase Diagnostic Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full mt-2.5">
            <button
              type="button"
              onClick={() =>
                setActiveModal(activeModal === 'teams' ? 'none' : 'teams')
              }
              className={`py-2.5 px-2 font-bold text-[11px] rounded-xl border transition-colors cursor-pointer whitespace-nowrap ${
                activeModal === 'teams'
                  ? 'bg-stone-800 text-amber-300 border-amber-500'
                  : 'bg-stone-900/95 hover:bg-stone-800 text-stone-200 border-stone-800'
              }`}
            >
              ESCOLHER TIME
            </button>

            <button
              type="button"
              onClick={() =>
                setActiveModal(activeModal === 'players' ? 'none' : 'players')
              }
              className={`py-2.5 px-2 font-bold text-[11px] rounded-xl border transition-colors cursor-pointer whitespace-nowrap ${
                activeModal === 'players'
                  ? 'bg-stone-800 text-amber-300 border-amber-500'
                  : 'bg-stone-900/95 hover:bg-stone-800 text-stone-200 border-stone-800'
              }`}
            >
              JOGADORES
            </button>

            <button
              type="button"
              onClick={() =>
                setActiveModal(
                  activeModal === 'settings' ? 'none' : 'settings'
                )
              }
              className={`py-2.5 px-2 font-bold text-[11px] rounded-xl border transition-colors cursor-pointer whitespace-nowrap ${
                activeModal === 'settings'
                  ? 'bg-stone-800 text-amber-300 border-amber-500'
                  : 'bg-stone-900/95 hover:bg-stone-800 text-stone-200 border-stone-800'
              }`}
            >
              CONFIGURAÇÕES
            </button>

            <button
              type="button"
              onClick={() => onOpenMultiplayer('diagnostic')}
              className="py-2.5 px-2 font-bold text-[11px] rounded-xl border bg-stone-900/95 hover:bg-stone-800 text-amber-300 border-stone-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              STATUS ONLINE
            </button>
          </div>
        </div>

        {/* Right Side Panel: Active Sub-Modal (Escolher Time / Personalizar Jogadores / Configurações de Áudio) */}
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
                  <span>
                    Adversário: {awayTeam.name} (Primo, Bicudo, Ismael, Felipe)
                  </span>
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
                      {selectedPlayer.barefoot
                        ? 'Descalço (Raiz)'
                        : 'De Chuteira'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeModal === 'settings' && (
              <div>
                <div className="flex items-center justify-between pb-3 mb-4 border-b border-stone-800">
                  <h2 className="text-lg font-bold text-amber-400">
                    Configurações &amp; Volumes
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    className="px-2.5 py-1 text-xs font-semibold text-stone-400 hover:text-white bg-stone-900 rounded-lg"
                  >
                    Fechar
                  </button>
                </div>

                <div className="space-y-3.5 text-xs">
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
                          onClick={() =>
                            onUpdateSettings({ cameraMode: mode })
                          }
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

                  {/* 3 Independent Volume Sliders: Efeitos Sonoros, Ambiente, Música */}
                  <div className="pt-2 border-t border-stone-800 space-y-2.5">
                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-stone-300 font-medium">
                          Volume: Efeitos Sonoros (Bola, Terra, Apito)
                        </span>
                        <span className="font-mono text-amber-400">
                          {Math.round((settings.sfxVolume ?? 0.85) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.sfxVolume ?? 0.85}
                        onChange={(e) =>
                          onUpdateSettings({
                            sfxVolume: Number(e.target.value),
                          })
                        }
                        className="w-full accent-amber-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-stone-300 font-medium">
                          Volume: Ambiente da Várzea (Torcida e Campinho)
                        </span>
                        <span className="font-mono text-amber-400">
                          {Math.round((settings.ambientVolume ?? 0.65) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.ambientVolume ?? 0.65}
                        onChange={(e) =>
                          onUpdateSettings({
                            ambientVolume: Number(e.target.value),
                          })
                        }
                        className="w-full accent-amber-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-stone-300 font-medium">
                          Volume: Música / Batucada do Menu
                        </span>
                        <span className="font-mono text-amber-400">
                          {Math.round((settings.musicVolume ?? 0.5) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.musicVolume ?? 0.5}
                        onChange={(e) =>
                          onUpdateSettings({
                            musicVolume: Number(e.target.value),
                            musicEnabled: Number(e.target.value) > 0,
                          })
                        }
                        className="w-full accent-amber-500"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-stone-800">
                    <span className="text-stone-300 font-medium">
                      Vibração no Celular (Chutes e Gols)
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          vibrationEnabled: !(
                            settings.vibrationEnabled ?? true
                          ),
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg font-bold ${
                        settings.vibrationEnabled ?? true
                          ? 'bg-emerald-600 text-white'
                          : 'bg-stone-800 text-stone-400'
                      }`}
                    >
                      {settings.vibrationEnabled ?? true
                        ? 'Ativada'
                        : 'Desativada'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Safe Margin: Single Flat Borderless Control Hint Line */}
      <div className="w-full max-w-7xl mx-auto pt-3 flex flex-wrap items-center justify-between gap-4 text-xs text-stone-300/90">
        <span>
          PC: WASD Movimentar · Shift Correr · Espaço Chutar · E Passe · F
          Carrinho · Q Trocar Jogador · P Pausar
        </span>
        <span className="text-stone-400">
          Celular: Tela Horizontal + Controles Virtuais Automáticos
        </span>
      </div>
    </div>
  );
};
