import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { PlayerAnimState, PlayerCustomization } from '../types/game';
import {
  buildHumanPlayerRig,
  HumanRig,
  updateHumanPlayerAnimation,
} from '../game/playerModel';

interface CharacterSelect3DModalProps {
  homePlayers: PlayerCustomization[];
  awayPlayers: PlayerCustomization[];
  selectedCharacterId: string;
  onSelectCharacter: (characterId: string) => void;
  onStartWithCharacter: (characterId: string) => void;
  onClose: () => void;
}

const ANIM_PREVIEW_BUTTONS: Array<{ state: PlayerAnimState; label: string }> = [
  { state: 'idle', label: 'Parado' },
  { state: 'walk', label: 'Caminhar' },
  { state: 'run', label: 'Correr' },
  { state: 'kick', label: 'Chutar' },
  { state: 'tackle', label: 'Carrinho' },
  { state: 'celebrate', label: 'Comemorar' },
];

export const CharacterSelect3DModal: React.FC<CharacterSelect3DModalProps> = ({
  homePlayers,
  awayPlayers,
  selectedCharacterId,
  onSelectCharacter,
  onStartWithCharacter,
  onClose,
}) => {
  // Prioritize the 4 featured photo characters (Bode, Josué, Careca, Ismael) at the top of the selector, followed by the rest of the squad
  const allPlayers = [...homePlayers, ...awayPlayers];
  const featuredOrder = [
    'Bode',
    'Josué',
    'Careca',
    'Ismael',
    'Yuri',
    'Primo',
    'Bicudo',
    'Felipe',
  ];

  const sortedPlayers = [...allPlayers].sort((a, b) => {
    const ia = featuredOrder.indexOf(a.name);
    const ib = featuredOrder.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const [activeCharId, setActiveCharId] = useState<string>(
    selectedCharacterId || 'home_4'
  );
  const [previewAnim, setPreviewAnim] = useState<PlayerAnimState>('idle');
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [turntableAngleDeg, setTurntableAngleDeg] = useState<number>(0);

  const activePlayer =
    sortedPlayers.find((p) => p.id === activeCharId) || sortedPlayers[0];

  const mountRef = useRef<HTMLDivElement | null>(null);
  const rigRef = useRef<HumanRig | null>(null);
  const pedestalGroupRef = useRef<THREE.Group | null>(null);
  const previewAnimRef = useRef<PlayerAnimState>(previewAnim);
  const autoRotateRef = useRef<boolean>(autoRotate);
  const yawAngleRef = useRef<number>(0);

  useEffect(() => {
    previewAnimRef.current = previewAnim;
  }, [previewAnim]);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  // Initialize 3D Turntable Viewer
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2)
    );

    const w = container.clientWidth || 380;
    const h = container.clientHeight || 380;
    renderer.setSize(w, h);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 30);
    camera.position.set(0, 1.25, 3.15);
    camera.lookAt(0, 0.92, 0);

    const hemi = new THREE.HemisphereLight(0xe0f2fe, 0x9a7b5c, 1.05);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.55);
    keyLight.position.set(2.5, 4.2, 3.2);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
    rimLight.position.set(-2.5, 2.4, -2.5);
    scene.add(rimLight);

    // Várzea Dirt Turntable Pedestal
    const pedestalGroup = new THREE.Group();
    scene.add(pedestalGroup);
    pedestalGroupRef.current = pedestalGroup;

    const dirtBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.82, 0.9, 0.1, 32),
      new THREE.MeshStandardMaterial({
        color: 0xb5926b,
        roughness: 0.92,
      })
    );
    dirtBase.position.y = -0.05;
    pedestalGroup.add(dirtBase);

    const rimRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.84, 0.022, 10, 40).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        roughness: 0.4,
        metalness: 0.3,
      })
    );
    rimRing.position.y = 0.0;
    pedestalGroup.add(rimRing);

    const onResize = () => {
      if (!container) return;
      const nw = container.clientWidth || 380;
      const nh = container.clientHeight || 380;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', onResize);

    let frameId = 0;
    let lastTime = performance.now();
    let elapsed = 0;
    let stridePhase = 0;
    let animTimer = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    const animate = () => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      elapsed += dt;

      if (autoRotateRef.current) {
        yawAngleRef.current = (yawAngleRef.current + dt * 0.65) % (Math.PI * 2);
        setTurntableAngleDeg(
          Math.round(((yawAngleRef.current * 180) / Math.PI) % 360)
        );
      }

      if (pedestalGroupRef.current) {
        pedestalGroupRef.current.rotation.y = yawAngleRef.current;
      }

      const st = previewAnimRef.current;
      if (st === 'walk') {
        stridePhase += dt * 6.5;
      } else if (st === 'run') {
        stridePhase += dt * 11.5;
      } else if (st === 'kick' || st === 'tackle') {
        animTimer = (animTimer + dt) % 0.65;
      } else {
        animTimer = 0;
      }

      if (rigRef.current) {
        updateHumanPlayerAnimation(
          rigRef.current,
          st,
          stridePhase,
          animTimer,
          st === 'run' ? 1.0 : st === 'walk' ? 0.55 : 0,
          true,
          elapsed
        );
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(animate);
      } else {
        frameId = requestAnimationFrame(animate);
      }
    };

    animate();

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
    };
  }, []);

  // Rebuild 3D character model whenever activePlayer changes
  useEffect(() => {
    const pedestal = pedestalGroupRef.current;
    if (!pedestal || !activePlayer) return;

    if (rigRef.current) {
      pedestal.remove(rigRef.current.root);
    }

    const rig = buildHumanPlayerRig(activePlayer, true);
    rig.root.position.set(0, 0, 0);
    pedestal.add(rig.root);
    rigRef.current = rig;
  }, [activePlayer]);

  // Pointer drag for manual 360° inspection
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);

  return (
    <div
      data-testid="character-select-3d-modal"
      className="pointer-events-auto fixed inset-0 z-50 bg-stone-950/90 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
    >
      <div className="w-full max-w-5xl bg-stone-950 border-2 border-amber-500/70 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[96vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 sm:px-6 sm:py-3.5 bg-stone-900 border-b border-stone-800 shrink-0">
          <div>
            <h2 className="text-base sm:text-xl font-extrabold text-amber-400 tracking-wide uppercase">
              Seleção de Personagens 3D (Visão 360°)
            </h2>
            <p className="text-[11px] sm:text-xs text-stone-400">
              Modelos 3D fiéis às fotografias reais da várzea · Gire em 360° e
              teste as animações
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 font-bold text-xs rounded-xl cursor-pointer"
          >
            Fechar ✕
          </button>
        </div>

        {/* Body Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4 p-3 sm:p-5 overflow-y-auto">
          {/* Left Column: Character Roster Cards (BODE, JOSUÉ, CARECA, ISMAEL + Elenco) */}
          <div className="lg:col-span-4 flex flex-col gap-2">
            <div className="text-xs font-bold text-stone-400 uppercase tracking-wider">
              Escolha o Craque da Várzea:
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-2">
              {sortedPlayers.map((p) => {
                const isSelected = p.id === activePlayer.id;
                const isPhotoStar = [
                  'Bode',
                  'Josué',
                  'Careca',
                  'Ismael',
                ].includes(p.name);
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`select-char-${p.name.toLowerCase()}`}
                    onClick={() => {
                      setActiveCharId(p.id);
                      onSelectCharacter(p.id);
                    }}
                    className={`flex flex-col items-start p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-amber-500/20 border-amber-400 shadow-lg'
                        : 'bg-stone-900/90 hover:bg-stone-800 border-stone-800'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full mb-1">
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-stone-950 text-amber-400">
                        #{p.number}
                      </span>
                      {isPhotoStar && (
                        <span className="text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          FOTO REAL
                        </span>
                      )}
                    </div>
                    <span className="text-sm font-extrabold text-white uppercase tracking-wide">
                      {p.name.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-stone-400 uppercase">
                      {p.role}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Center Column: Interactive 360° 3D Turntable Stage */}
          <div className="lg:col-span-5 flex flex-col items-center justify-between bg-gradient-to-b from-stone-900/90 to-stone-950 border border-stone-800 rounded-2xl p-3 relative min-h-[260px] sm:min-h-[340px]">
            {/* Top Floating Name Tag in Uppercase */}
            <div className="w-full flex items-center justify-between z-10 pointer-events-none">
              <div className="px-3 py-1 rounded-lg bg-stone-950/90 border border-amber-500/60 shadow">
                <span
                  data-testid="turntable-player-name"
                  className="text-sm sm:text-base font-extrabold text-amber-400 tracking-wider uppercase"
                >
                  {activePlayer.name.toUpperCase()}
                </span>
              </div>
              <span className="text-[11px] font-mono text-stone-400 bg-stone-950/80 px-2 py-1 rounded-lg">
                Giro 360° ({turntableAngleDeg}°)
              </span>
            </div>

            {/* 3D Canvas Mount (Drag horizontally to rotate 360 degrees) */}
            <div
              ref={mountRef}
              onPointerDown={(e) => {
                draggingRef.current = true;
                lastXRef.current = e.clientX;
                setAutoRotate(false);
              }}
              onPointerMove={(e) => {
                if (!draggingRef.current) return;
                const dx = e.clientX - lastXRef.current;
                lastXRef.current = e.clientX;
                yawAngleRef.current += dx * 0.015;
                setTurntableAngleDeg(
                  Math.round(
                    (((yawAngleRef.current * 180) / Math.PI) % 360 + 360) % 360
                  )
                );
              }}
              onPointerUp={() => {
                draggingRef.current = false;
              }}
              onPointerCancel={() => {
                draggingRef.current = false;
              }}
              className="w-full h-56 sm:h-72 cursor-grab active:cursor-grabbing touch-none"
              title="Arraste para girar o personagem em 360 graus"
            />

            {/* 360 Rotation Controls */}
            <div className="w-full flex items-center justify-between gap-2 z-10 pt-1">
              <button
                type="button"
                onClick={() => {
                  setAutoRotate(false);
                  yawAngleRef.current -= Math.PI / 4;
                }}
                className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-bold rounded-lg cursor-pointer"
              >
                ↺ -45°
              </button>
              <button
                type="button"
                onClick={() => setAutoRotate(!autoRotate)}
                className={`px-3 py-1 text-xs font-bold rounded-lg cursor-pointer ${
                  autoRotate
                    ? 'bg-amber-500 text-stone-950'
                    : 'bg-stone-800 text-stone-300'
                }`}
              >
                {autoRotate ? 'Giro 360° Automático: ON' : 'Girar 360° Auto'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAutoRotate(false);
                  yawAngleRef.current += Math.PI / 4;
                }}
                className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-bold rounded-lg cursor-pointer"
              >
                +45° ↻
              </button>
            </div>
          </div>

          {/* Right Column: Authentic Photo Details, Animation Tester & Play CTA */}
          <div className="lg:col-span-3 flex flex-col justify-between gap-3 bg-stone-900/70 border border-stone-800 rounded-2xl p-3.5">
            <div className="space-y-3">
              <div>
                <div className="text-[11px] font-bold text-amber-400 uppercase tracking-wider">
                  Fidelidade Visual da Foto
                </div>
                <h3 className="text-lg font-extrabold text-white uppercase mt-0.5">
                  {activePlayer.name.toUpperCase()} #{activePlayer.number}
                </h3>
                <p className="text-xs text-stone-300 mt-1 leading-relaxed">
                  {activePlayer.outfitDescription || activePlayer.personality}
                </p>
              </div>

              {/* Attributes */}
              <div className="space-y-1.5 pt-2 border-t border-stone-800 text-xs">
                <div className="flex justify-between">
                  <span className="text-stone-400">Velocidade</span>
                  <span className="font-mono font-bold text-emerald-400">
                    {Math.round(activePlayer.speedStat * 88)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-400">Força do Chute</span>
                  <span className="font-mono font-bold text-amber-400">
                    {Math.round(activePlayer.kickStat * 88)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-400">Desarme / Raça</span>
                  <span className="font-mono font-bold text-sky-400">
                    {Math.round(activePlayer.tackleStat * 88)}
                  </span>
                </div>
              </div>

              {/* Animation Tester Buttons */}
              <div className="pt-2 border-t border-stone-800">
                <span className="block text-[11px] font-bold text-stone-400 uppercase mb-1.5">
                  Testar Animação 3D:
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  {ANIM_PREVIEW_BUTTONS.map((btn) => (
                    <button
                      key={btn.state}
                      type="button"
                      onClick={() => setPreviewAnim(btn.state)}
                      className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        previewAnim === btn.state
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-800 hover:bg-stone-700 text-stone-200'
                      }`}
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onStartWithCharacter(activePlayer.id)}
              className="w-full py-3 px-4 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-xs sm:text-sm uppercase tracking-wide rounded-xl shadow-lg cursor-pointer"
            >
              JOGAR COM {activePlayer.name.toUpperCase()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
