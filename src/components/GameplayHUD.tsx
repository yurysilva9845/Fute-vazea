import React, { useEffect, useRef, useState } from 'react';
import {
  CameraMode,
  GameSettings,
  MatchPhase,
  MultiplayerRoomState,
  TeamConfig,
} from '../types/game';
import { formatMatchTime } from '../game/rules';
import { VarzeaInputManager } from '../game/controls';
import { LiveHUDUpdate } from '../game/MatchCanvas';
import { audioEngine } from '../game/audio';
import { VoiceControlsBar } from './VoiceControlsBar';

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
  activeRoom?: MultiplayerRoomState | null;
  pingMs?: number;
  isFullscreen?: boolean;
  onRequestFullscreenLandscape: () => void;
  onExitFullscreen: () => void;
  onBackToMenu: () => void;
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

function detectMobileOrTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const narrow = window.innerWidth <= 920;
  const touchPoints =
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  return narrow || coarse || (touchPoints && window.innerWidth < 1024);
}

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
  activeRoom = null,
  pingMs = 18,
  isFullscreen = false,
  onRequestFullscreenLandscape,
  onExitFullscreen,
  onBackToMenu,
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

  // Strict mobile / touchscreen detection: controls appear ONLY on mobile/touch devices and disappear completely on desktop PC
  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(() =>
    detectMobileOrTouchDevice()
  );
  const [isPortraitMobile, setIsPortraitMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return detectMobileOrTouchDevice() && window.innerHeight > window.innerWidth;
  });
  const [dismissedOrientationBanner, setDismissedOrientationBanner] =
    useState(false);

  useEffect(() => {
    const checkDeviceAndOrientation = () => {
      const mobile = detectMobileOrTouchDevice();
      setIsMobileDevice(mobile);
      setIsPortraitMobile(mobile && window.innerHeight > window.innerWidth);
    };
    window.addEventListener('resize', checkDeviceAndOrientation);
    window.addEventListener('orientationchange', checkDeviceAndOrientation);
    return () => {
      window.removeEventListener('resize', checkDeviceAndOrientation);
      window.removeEventListener(
        'orientationchange',
        checkDeviceAndOrientation
      );
    };
  }, []);

  // Sync 60Hz player stamina, kick charge & goal/lateral banners via DOM refs
  useEffect(() => {
    let rafId = 0;
    const syncDOM = () => {
      const data = hudUpdateRef.current;
      if (
        playerNameRef.current &&
        playerNameRef.current.textContent !== data.controlledPlayerName
      ) {
        playerNameRef.current.textContent = data.controlledPlayerName;
      }
      if (
        playerRoleRef.current &&
        playerRoleRef.current.textContent !== data.controlledPlayerRole
      ) {
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
      if (
        bannerWrapRef.current &&
        bannerTitleRef.current &&
        bannerSubRef.current
      ) {
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

  // Virtual 360-degree Joystick state (walk on inner tilt, automatic sprint on outer tilt > 78%)
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

    const normX = dx / maxRadius;
    const normY = dy / maxRadius;
    const tiltMagnitude = Math.hypot(normX, normY);

    knob.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(
      1
    )}px, 0)`;
    inputManager.setTouchJoystick(normX, normY);
    // Smooth walk -> run transition when tilting joystick near outer rim
    inputManager.touchSprintHeld = tiltMagnitude > 0.82;
  };

  const resetJoystick = () => {
    activePointerId.current = null;
    if (joystickKnobRef.current) {
      joystickKnobRef.current.style.transform = 'translate3d(0px, 0px, 0)';
    }
    inputManager.setTouchJoystick(0, 0);
    inputManager.touchSprintHeld = false;
  };

  const cycleCameraMode = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    const order: CameraMode[] = ['follow', 'overview', 'sideline', 'close'];
    const next = order[(order.indexOf(settings.cameraMode) + 1) % order.length];
    onUpdateSettings({ cameraMode: next });
  };

  return (
    <div
      className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-2 sm:p-4 select-none touch-none"
      style={{
        paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(0.65rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.65rem, env(safe-area-inset-right))',
      }}
    >
      {/* Mobile Landscape & Fullscreen Friendly Prompt when in Portrait or non-fullscreen on mobile */}
      {isMobileDevice &&
        (isPortraitMobile || !isFullscreen) &&
        !dismissedOrientationBanner && (
          <div className="pointer-events-auto w-full max-w-xl mx-auto mb-1.5 bg-stone-950/95 border-2 border-amber-500 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 shadow-2xl">
            <p className="text-[11px] sm:text-xs font-bold text-amber-200 leading-snug flex-1">
              Vire seu celular para jogar na horizontal e toque para entrar em
              tela cheia.
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  onRequestFullscreenLandscape();
                  setDismissedOrientationBanner(true);
                }}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-[11px] rounded-lg shadow cursor-pointer whitespace-nowrap"
              >
                JOGAR EM TELA CHEIA
              </button>
              <button
                type="button"
                onClick={() => setDismissedOrientationBanner(true)}
                aria-label="Ocultar aviso de tela cheia"
                className="px-2 py-1 text-[11px] text-stone-400 hover:text-white"
              >
                ✕
              </button>
            </div>
          </div>
        )}

      {/* Top Perimeter Bar: Scoreboard + Online Ping + Utility Controls */}
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

          {/* Online Room & Ping Indicator when in Multiplayer */}
          {activeRoom && (
            <div className="pl-2 border-l border-stone-800 text-[10px] font-mono">
              <div className="text-amber-400 font-bold">
                {activeRoom.roomCode}
              </div>
              <div className="text-emerald-400">{pingMs} ms</div>
            </div>
          )}
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

        {/* Top-Right Compact Utility Buttons (Camera, Fullscreen Exit/Toggle, Mute, Restart, Pause, Menu) */}
        <div className="pointer-events-auto flex items-center gap-1 sm:gap-1.5 shrink-0">
          <button
            type="button"
            tabIndex={-1}
            onClick={cycleCameraMode}
            title="Alternar Câmera"
            aria-label={`Alternar Câmera (${CAMERA_MODE_LABELS[settings.cameraMode]})`}
            className="hidden lg:flex items-center gap-1.5 px-3 h-10 bg-stone-950/90 hover:bg-stone-800 text-stone-200 border border-stone-800 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 fill-none stroke-amber-400 stroke-2"
            >
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span>{CAMERA_MODE_LABELS[settings.cameraMode]}</span>
          </button>

          {isFullscreen ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.currentTarget.blur();
                onExitFullscreen();
              }}
              title="Sair da Tela Cheia"
              aria-label="Sair da Tela Cheia"
              className="px-2.5 h-9 sm:h-10 flex items-center justify-center bg-stone-950/90 hover:bg-stone-800 text-amber-300 border border-stone-800 rounded-xl text-[11px] font-bold transition-colors cursor-pointer"
            >
              Sair Tela Cheia
            </button>
          ) : (
            isMobileDevice && (
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onRequestFullscreenLandscape();
                }}
                title="Tela Cheia"
                aria-label="Entrar em Tela Cheia"
                className="px-2.5 h-9 flex items-center justify-center bg-amber-500/90 text-stone-950 rounded-xl text-[10px] font-extrabold cursor-pointer"
              >
                Tela Cheia
              </button>
            )
          )}

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              onUpdateSettings({ soundEnabled: !settings.soundEnabled });
            }}
            aria-label={
              settings.soundEnabled ? 'Silenciar Áudio' : 'Ativar Áudio'
            }
            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center bg-stone-950/90 hover:bg-stone-800 text-stone-200 border border-stone-800 rounded-xl transition-colors cursor-pointer"
          >
            {settings.soundEnabled ? (
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4 sm:w-5 sm:h-5 fill-none stroke-current stroke-2"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4 sm:w-5 sm:h-5 fill-none stroke-red-400 stroke-2"
              >
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
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5 fill-none stroke-current stroke-2"
            >
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
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 sm:w-5 sm:h-5 fill-none stroke-current stroke-2"
            >
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          </button>

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              onPause();
            }}
            title="Menu da Partida"
            aria-label="Menu da Partida"
            className="px-2.5 h-9 sm:h-10 flex items-center justify-center bg-stone-950/90 hover:bg-stone-800 text-stone-300 border border-stone-800 rounded-xl text-[11px] font-bold transition-colors cursor-pointer"
          >
            Menu
          </button>
        </div>
      </div>

      {/* Online WebRTC Voice Chat Quick Bar during Match */}
      {activeRoom && (
        <div className="w-full max-w-7xl mx-auto mt-1 flex justify-end">
          <VoiceControlsBar roomCode={activeRoom.roomCode} compact />
        </div>
      )}

      {/* Compact Top Broadcast Banner for Goals / Lateral Throw-ins / Halftime (Never blocks center gameplay) */}
      <div
        ref={bannerWrapRef}
        data-testid="match-event-banner"
        style={{ opacity: 0 }}
        className="pointer-events-none self-center mt-1.5 mb-auto max-w-md w-auto bg-stone-950/90 border border-amber-500/85 rounded-xl px-4 py-1.5 text-center shadow-lg transition-opacity duration-200 backdrop-blur-xs"
      >
        <div
          ref={bannerTitleRef}
          className="font-extrabold text-xs sm:text-sm text-amber-400 tracking-wider uppercase leading-tight"
        />
        <div
          ref={bannerSubRef}
          className="text-[10px] sm:text-xs font-semibold text-stone-200 mt-0.5 leading-tight"
        />
      </div>

      {/* Bottom Area: Mobile Virtual Controls ONLY on Mobile/Touchscreen Devices; Desktop Hint on PC */}
      {isMobileDevice ? (
        <div
          data-testid="mobile-virtual-controls"
          className={`flex items-end justify-between w-full max-w-7xl mx-auto pb-1 pt-2 ${
            settings.mobileControls?.layoutPreset === 'compacto'
              ? 'px-1'
              : settings.mobileControls?.layoutPreset === 'espacado'
              ? 'px-3 sm:px-6'
              : 'px-1.5 sm:px-3'
          }`}
        >
          {/* Left Side: 360-Degree Virtual Joystick (Walk & Run, continuous pointer tracking even outside ring) */}
          <div
            ref={joystickBaseRef}
            onPointerDown={(e) => {
              e.preventDefault();
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
            aria-label="Joystick Virtual 360 Graus"
            style={{
              transform: `scale(${settings.mobileControls?.scale ?? 1})`,
              transformOrigin: 'bottom left',
            }}
            className="pointer-events-auto relative w-28 h-28 sm:w-36 sm:h-36 rounded-full bg-stone-950/60 border-2 border-stone-400/50 flex items-center justify-center touch-none shadow-xl"
          >
            <div
              ref={joystickKnobRef}
              className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-amber-500/85 border-2 border-amber-200 shadow-md pointer-events-none transition-transform duration-75"
            />
          </div>

          {/* Right Side: 5 Ergonomic Semi-Transparent Action Buttons (CHUTAR, PASSE, CORRER, CARRINHO, TROCAR JOGADOR) */}
          <div
            style={{
              transform: `scale(${settings.mobileControls?.scale ?? 1})`,
              transformOrigin: 'bottom right',
            }}
            className={`pointer-events-auto grid grid-cols-3 items-end touch-none ${
              settings.mobileControls?.layoutPreset === 'compacto'
                ? 'gap-1.5'
                : settings.mobileControls?.layoutPreset === 'espacado'
                ? 'gap-3 sm:gap-3.5'
                : 'gap-2 sm:gap-2.5'
            }`}
          >
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                audioEngine.triggerVibration(15);
                inputManager.triggerTouchAction('switch');
              }}
              className="w-16 h-14 sm:w-20 sm:h-16 rounded-2xl bg-stone-900/70 active:bg-stone-700 border-2 border-stone-400/50 text-stone-100 font-extrabold text-[10px] sm:text-xs flex flex-col items-center justify-center shadow-lg leading-tight px-1"
            >
              <span>TROCAR</span>
              <span className="text-[9px] text-amber-300">JOGADOR</span>
            </button>

            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                audioEngine.triggerVibration(25);
                inputManager.triggerTouchAction('tackle');
              }}
              className="w-16 h-14 sm:w-20 sm:h-16 rounded-2xl bg-orange-950/75 active:bg-orange-800 border-2 border-orange-400/60 text-orange-100 font-extrabold text-[10px] sm:text-xs flex flex-col items-center justify-center shadow-lg"
            >
              <span>CARRINHO</span>
            </button>

            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                inputManager.touchSprintHeld = true;
              }}
              onPointerUp={() => {
                inputManager.touchSprintHeld = false;
              }}
              onPointerCancel={() => {
                inputManager.touchSprintHeld = false;
              }}
              className="w-16 h-14 sm:w-20 sm:h-16 rounded-2xl bg-emerald-950/75 active:bg-emerald-700 border-2 border-emerald-400/60 text-emerald-100 font-extrabold text-[10px] sm:text-xs flex flex-col items-center justify-center shadow-lg"
            >
              <span>CORRER</span>
            </button>

            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                audioEngine.triggerVibration(18);
                inputManager.triggerTouchAction('pass');
              }}
              className="w-16 h-16 sm:w-20 sm:h-18 rounded-2xl bg-sky-950/80 active:bg-sky-700 border-2 border-sky-400/70 text-sky-100 font-extrabold text-xs sm:text-sm flex flex-col items-center justify-center shadow-xl"
            >
              <span>PASSE</span>
            </button>

            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                audioEngine.triggerVibration(30);
                inputManager.setTouchKickHold(true);
              }}
              onPointerUp={() => inputManager.setTouchKickHold(false)}
              onPointerCancel={() => inputManager.setTouchKickHold(false)}
              className="col-span-2 h-16 sm:h-18 rounded-2xl bg-amber-500/85 active:bg-amber-400 border-2 border-amber-200 text-stone-950 font-extrabold text-sm sm:text-base tracking-wide flex flex-col items-center justify-center shadow-xl px-2"
            >
              <span>CHUTAR</span>
              <span className="text-[9px] sm:text-[10px] font-bold text-stone-900">
                TOQUE FRACO · SEGURE P/ FORTE
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div
          data-testid="desktop-controls-hint"
          className="hidden md:flex items-center justify-center w-full"
        >
          <div className="bg-stone-950/80 border border-stone-800/80 rounded-lg px-4 py-1.5 text-xs text-stone-300">
            WASD Mover · Shift Correr · Espaço Chutar (Toque Fraco / Segure Forte) · E Passe Direcional · F Carrinho · Q Trocar · ESC Menu
          </div>
        </div>
      )}
    </div>
  );
};
