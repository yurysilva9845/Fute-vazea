import React, { useEffect, useRef, useState } from 'react';
import {
  CameraMode,
  GameSettings,
  MatchPhase,
  TeamConfig,
} from '../types/game';
import { formatMatchTime } from '../game/rules';
import { VarzeaInputManager } from '../game/controls';
import { LiveHUDUpdate } from '../game/MatchCanvas';

interface GameplayHUDProps {
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  homeGoals: number;
  awayGoals: number;
  half: 1 | 2;
  remainingSeconds: number;
  phase: MatchPhase;
  settings: GameSettings;
  inputManager: VarzeaInputManager;
  hudUpdateRef: React.MutableRefObject<LiveHUDUpdate>;
  onUpdateSettings: (updated: Partial<GameSettings>) => void;
  onPause: () => void;
  onRestart: () => void;
}

const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  follow: '3ª Pessoa',
  overview: 'Campinho Inteiro',
  sideline: 'Lateral',
  close: 'Pro Perto',
};

export const GameplayHUD: React.FC<GameplayHUDProps> = ({
  homeTeam,
  awayTeam,
  homeGoals,
  awayGoals,
  half,
  remainingSeconds,
  settings,
  inputManager,
  hudUpdateRef,
  onUpdateSettings,
  onPause,
  onRestart,
}) => {
  const playerNameRef = useRef<HTMLSpanElement | null>(null);
  const playerRoleRef = useRef<HTMLSpanElement | null>(null);
  const staminaBarRef = useRef<HTMLDivElement | null>(null);
  const kickChargeWrapRef = useRef<HTMLDivElement | null>(null);
  const kickChargeBarRef = useRef<HTMLDivElement | null>(null);
  const bannerWrapRef = useRef<HTMLDivElement | null>(null);
  const bannerTitleRef = useRef<HTMLDivElement | null>(null);
  const bannerSubRef = useRef<HTMLDivElement | null>(null);

  // Detect mobile / touch viewport or allow manual touch controls toggle
  const [showTouchControls, setShowTouchControls] = useState(() => {
    if (typeof window === 'undefined') return false;
    return (
      window.innerWidth <= 900 ||
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0
    );
  });

  useEffect(() => {
    const checkViewport = () => {
      if (window.innerWidth <= 900) {
        setShowTouchControls(true);
      }
    };
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  }, []);

  // Sync 60Hz player stamina, kick charge & goal/lateral banners via DOM refs
  useEffect(() => {
    let rafId = 0;
    const syncDOM = () => {
      const data = hudUpdateRef.current;
      if (playerNameRef.current && playerNameRef.current.textContent !== data.controlledPlayerName) {
        playerNameRef.current.textContent = data.controlledPlayerName;
      }
      if (playerRoleRef.current && playerRoleRef.current.textContent !== data.controlledPlayerRole) {
        playerRoleRef.current.textContent = data.controlledPlayerRole;
      }
      if (staminaBarRef.current) {
        const pct = Math.max(0, Math.min(100, Math.round(data.stamina)));
        staminaBarRef.current.style.transform = `scaleX(${pct / 100})`;
      }
      if (kickChargeWrapRef.current && kickChargeBarRef.current) {
        if (data.isChargingKick) {
          kickChargeWrapRef.current.style.opacity = '1';
          kickChargeBarRef.current.style.transform = `scaleX(${data.kickCharge})`;
        } else {
          kickChargeWrapRef.current.style.opacity = '0';
        }
      }
      if (bannerWrapRef.current && bannerTitleRef.current && bannerSubRef.current) {
        if (data.bannerMessage) {
          bannerWrapRef.current.style.opacity = '1';
          bannerTitleRef.current.textContent = data.bannerMessage;
          bannerSubRef.current.textContent = data.bannerSubtext || '';
        } else {
          bannerWrapRef.current.style.opacity = '0';
        }
      }
      rafId = requestAnimationFrame(syncDOM);
    };
    rafId = requestAnimationFrame(syncDOM);
    return () => cancelAnimationFrame(rafId);
  }, [hudUpdateRef]);

  // Virtual Joystick state
  const joystickBaseRef = useRef<HTMLDivElement | null>(null);
  const joystickKnobRef = useRef<HTMLDivElement | null>(null);
  const activePointerId = useRef<number | null>(null);

  const handleJoystickMove = (clientX: number, clientY: number) => {
    const base = joystickBaseRef.current;
    const knob = joystickKnobRef.current;
    if (!base || !knob) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxRadius = rect.width * 0.42;

    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    knob.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
    inputManager.setTouchJoystick(dx / maxRadius, dy / maxRadius);
  };

  const resetJoystick = () => {
    activePointerId.current = null;
    if (joystickKnobRef.current) {
      joystickKnobRef.current.style.transform = 'translate3d(0px, 0px, 0)';
    }
    inputManager.setTouchJoystick(0, 0);
  };

  const cycleCameraMode = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    const order: CameraMode[] = ['follow', 'overview', 'sideline', 'close'];
    const next = order[(order.indexOf(settings.cameraMode) + 1) % order.length];
    onUpdateSettings({ cameraMode: next });
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-2.5 sm:p-5 select-none">
      {/* Top Perimeter Bar: Scoreboard + Utility Icon Controls */}
      <div className="flex items-start justify-between gap-1.5 sm:gap-3 w-full max-w-7xl mx-auto">
        {/* Top-Left Active Player Badge & Stamina */}
        <div className="pointer-events-auto flex items-center gap-2 bg-stone-950/90 border border-stone-800 rounded-xl px-2.5 sm:px-3.5 py-1.5 sm:py-2 shadow-lg shrink-0">
          <div>
            <div className="flex items-center gap-1.5">
              <span
                ref={playerNameRef}
                className="font-extrabold text-xs sm:text-base text-amber-400 tracking-wide"
              >
                Yuri
              </span>
              <span
                ref={playerRoleRef}
                className="text-[10px] sm:text-[11px] font-mono text-stone-400 uppercase"
              >
                PIVÔ
              </span>
            </div>
            {/* Stamina Bar */}
            <div className="w-16 sm:w-28 h-1.5 sm:h-2 bg-stone-800 rounded-full overflow-hidden mt-1">
              <div
                ref={staminaBarRef}
                className="w-full h-full bg-emerald-500 origin-left transition-transform duration-75"
              />
            </div>
            {/* Kick Power Charge Bar */}
            <div
              ref={kickChargeWrapRef}
              style={{ opacity: 0 }}
              className="w-16 sm:w-28 h-1 sm:h-1.5 bg-stone-800 rounded-full overflow-hidden mt-0.5 transition-opacity"
            >
              <div
                ref={kickChargeBarRef}
                className="w-full h-full bg-amber-400 origin-left"
              />
            </div>
          </div>
        </div>

        {/* Top-Center Várzea Match Scoreboard */}
        <div className="pointer-events-auto flex items-center bg-stone-950/95 border border-stone-800 rounded-xl px-2.5 sm:px-4 py-1.5 sm:py-2 shadow-xl shrink-0">
          <div className="flex items-center gap-1.5 sm:gap-2.5 pr-2 sm:pr-3">
            <span
              className="hidden sm:inline-block w-3.5 h-3.5 rounded-sm border border-white/20 shrink-0"
              style={{ backgroundColor: homeTeam.primaryColor }}
            />
            <span className="font-bold text-xs sm:text-sm text-stone-100 uppercase tracking-wider whitespace-nowrap">
              {homeTeam.shortName}
            </span>
            <span
              data-testid="score-home"
              className="font-mono font-extrabold text-lg sm:text-2xl text-amber-400 tabular-nums"
            >
              {homeGoals}
            </span>
          </div>

          <div className="px-2 sm:px-3 border-x border-stone-800 flex flex-col items-center">
            <span className="text-[9px] sm:text-[10px] font-bold text-stone-400 uppercase tracking-wider whitespace-nowrap">
              {half}º TEMPO
            </span>
            <span
              data-testid="match-timer"
              className="font-mono font-bold text-xs sm:text-base text-stone-100 tabular-nums"
            >
              {formatMatchTime(remainingSeconds)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2.5 pl-2 sm:pl-3">
            <span
              data-testid="score-away"
              className="font-mono font-extrabold text-lg sm:text-2xl text-stone-100 tabular-nums"
            >
              {awayGoals}
            </span>
            <span className="font-bold text-xs sm:text-sm text-stone-100 uppercase tracking-wider whitespace-nowrap">
              {awayTeam.shortName}
            </span>
            <span
              className="hidden sm:inline-block w-3.5 h-3.5 rounded-sm border border-white/20 shrink-0"
              style={{ backgroundColor: awayTeam.primaryColor }}
            />
          </div>
        </div>

        {/* Top-Right Compact Utility Buttons (Camera, Touch Toggle, Mute, Restart, Pause) */}
        <div className="pointer-events-auto flex items-center gap-1 sm:gap-1.5 shrink-0">
          <button
            type="button"
            tabIndex={-1}
            onClick={cycleCameraMode}
            title="Alternar Câmera"
            aria-label={`Alternar Câmera (${CAMERA_MODE_LABELS[settings.cameraMode]})`}
            className="hidden md:flex items-center gap-1.5 px-3 h-10 bg-stone-950/90 hover:bg-stone-800 text-stone-200 border border-stone-800 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-none stroke-amber-400 stroke-2">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span>{CAMERA_MODE_LABELS[settings.cameraMode]}</span>
          </button>

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              setShowTouchControls((prev) => !prev);
            }}
            aria-label="Alternar Controles de Toque"
            title="Controles de Celular na Tela"
            className={`hidden sm:flex w-10 h-10 items-center justify-center rounded-xl border transition-colors cursor-pointer ${
              showTouchControls
                ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                : 'bg-stone-950/90 hover:bg-stone-800 border-stone-800 text-stone-300'
            }`}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current stroke-2">
              <rect x="2" y="6" width="20" height="12" rx="3" />
              <path d="M6 12h4M8 10v4M15 11h.01M18 13h.01" />
            </svg>
          </button>

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              onUpdateSettings({ soundEnabled: !settings.soundEnabled });
            }}
            aria-label={settings.soundEnabled ? 'Silenciar Áudio' : 'Ativar Áudio'}
            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center bg-stone-950/90 hover:bg-stone-800 text-stone-200 border border-stone-800 rounded-xl transition-colors cursor-pointer"
          >
            {settings.soundEnabled ? (
              <svg viewBox="0 0 24 24" className="w-4 h-4 sm:w-5 sm:h-5 fill-none stroke-current stroke-2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="w-4 h-4 sm:w-5 sm:h-5 fill-none stroke-red-400 stroke-2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            )}
          </button>

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              onRestart();
            }}
            aria-label="Reiniciar Partida"
            className="hidden sm:flex w-10 h-10 items-center justify-center bg-stone-950/90 hover:bg-stone-800 text-stone-200 border border-stone-800 rounded-xl transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current stroke-2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              onPause();
            }}
            aria-label="Pausar Partida"
            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center bg-stone-950/90 hover:bg-stone-800 text-amber-400 border border-stone-800 rounded-xl transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 sm:w-5 sm:h-5 fill-none stroke-current stroke-2">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Center Callout Banner for Goals / Lateral Throw-ins / Halftime */}
      <div
        ref={bannerWrapRef}
        style={{ opacity: 0 }}
        className="pointer-events-none self-center my-auto bg-stone-950/95 border-2 border-amber-500 rounded-2xl px-6 sm:px-8 py-3 sm:py-4 text-center shadow-2xl transition-opacity duration-200"
      >
        <div
          ref={bannerTitleRef}
          className="font-extrabold text-xl sm:text-4xl text-amber-400 tracking-wider uppercase"
        />
        <div
          ref={bannerSubRef}
          className="text-xs sm:text-sm font-semibold text-stone-200 mt-1"
        />
      </div>

      {/* Bottom Area: Mobile Touch Controls (Left Virtual Joystick + Right 5 Action Buttons) or Desktop Hint */}
      {showTouchControls ? (
        <div className="flex items-end justify-between w-full max-w-7xl mx-auto pb-1 pt-2">
          {/* Left Side: Virtual Joystick */}
          <div
            ref={joystickBaseRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              activePointerId.current = e.pointerId;
              handleJoystickMove(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (activePointerId.current === e.pointerId) {
                handleJoystickMove(e.clientX, e.clientY);
              }
            }}
            onPointerUp={resetJoystick}
            onPointerCancel={resetJoystick}
            aria-label="Joystick Virtual de Movimentação"
            className="pointer-events-auto relative w-28 h-28 sm:w-36 sm:h-36 rounded-full bg-stone-950/65 border-2 border-stone-500/45 flex items-center justify-center touch-none shadow-xl"
          >
            <div
              ref={joystickKnobRef}
              className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-amber-500/80 border-2 border-amber-200 shadow-md pointer-events-none"
            />
          </div>

          {/* Right Side: 5 Ergonomic Semi-Transparent Action Buttons (Chute, Passe, Corrida, Carrinho, Trocar) */}
          <div className="pointer-events-auto grid grid-cols-3 gap-2 sm:gap-3 items-end touch-none">
            <button
              type="button"
              onClick={() => inputManager.triggerTouchAction('switch')}
              className="w-15 h-15 sm:w-18 sm:h-18 rounded-full bg-stone-900/75 active:bg-stone-700 border-2 border-stone-400/50 text-stone-100 font-bold text-[10px] sm:text-xs flex flex-col items-center justify-center shadow-lg"
            >
              <span>TROCAR</span>
              <span className="text-[9px] text-stone-400">Q</span>
            </button>

            <button
              type="button"
              onClick={() => inputManager.triggerTouchAction('tackle')}
              className="w-15 h-15 sm:w-18 sm:h-18 rounded-full bg-orange-950/80 active:bg-orange-800 border-2 border-orange-400/60 text-orange-200 font-bold text-[10px] sm:text-xs flex flex-col items-center justify-center shadow-lg"
            >
              <span>CARRINHO</span>
              <span className="text-[9px] text-orange-300">F</span>
            </button>

            <button
              type="button"
              onPointerDown={() => {
                inputManager.touchSprintHeld = true;
              }}
              onPointerUp={() => {
                inputManager.touchSprintHeld = false;
              }}
              onPointerCancel={() => {
                inputManager.touchSprintHeld = false;
              }}
              className="w-15 h-15 sm:w-18 sm:h-18 rounded-full bg-emerald-950/80 active:bg-emerald-700 border-2 border-emerald-400/60 text-emerald-200 font-bold text-[10px] sm:text-xs flex flex-col items-center justify-center shadow-lg"
            >
              <span>CORRIDA</span>
              <span className="text-[9px] text-emerald-300">SHIFT</span>
            </button>

            <button
              type="button"
              onClick={() => inputManager.triggerTouchAction('pass')}
              className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-sky-950/85 active:bg-sky-700 border-2 border-sky-400/70 text-sky-100 font-extrabold text-xs sm:text-sm flex flex-col items-center justify-center shadow-xl"
            >
              <span>PASSE</span>
              <span className="text-[9px] text-sky-300">E</span>
            </button>

            <button
              type="button"
              onPointerDown={() => inputManager.setTouchKickHold(true)}
              onPointerUp={() => inputManager.setTouchKickHold(false)}
              onPointerCancel={() => inputManager.setTouchKickHold(false)}
              className="col-span-2 h-16 sm:h-20 rounded-2xl bg-amber-500/85 active:bg-amber-400 border-2 border-amber-200 text-stone-950 font-extrabold text-sm sm:text-base tracking-wide flex flex-col items-center justify-center shadow-xl px-2"
            >
              <span>CHUTAR</span>
              <span className="text-[9px] sm:text-[10px] font-bold text-stone-900">
                SEGURE P/ FORTE
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="hidden md:flex items-center justify-center w-full">
          <div className="bg-stone-950/80 border border-stone-800/80 rounded-lg px-4 py-1.5 text-xs text-stone-300">
            WASD Mover · Shift Correr · Espaço Chutar (Segure p/ Forte) · E Passe · R Lançamento · F Carrinho · Q Trocar
          </div>
        </div>
      )}
    </div>
  );
};
