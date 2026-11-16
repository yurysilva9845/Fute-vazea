import { KeyBindingsConfig } from '../types/game';

/**
 * Unified Input Controller for PC (Keyboard + Mouse with Remappable Keys) and
 * Mobile (360° Virtual Joystick + Ergonomic Touch Action Buttons).
 * Separates continuous `held` states from single-frame `justPressed` / `justReleased` edges
 * and clears held keys on window blur / visibilitychange.
 */
export interface InputSnapshot {
  moveX: number; // -1 to 1
  moveZ: number; // -1 to 1
  sprintHeld: boolean;
  kickHeld: boolean;
  kickJustPressed: boolean;
  kickJustReleased: boolean;
  kickChargePower: number; // 0.25 to 1.0
  passJustPressed: boolean;
  longPassJustPressed: boolean;
  switchJustPressed: boolean;
  tackleJustPressed: boolean;
  headerJustPressed: boolean;
  pauseJustPressed: boolean;
  mouseDeltaX: number;
  mouseDeltaY: number;
}

export const DEFAULT_KEY_BINDINGS: KeyBindingsConfig = {
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  sprint: 'ShiftLeft',
  shoot: 'Space',
  pass: 'KeyE',
  longPass: 'KeyR',
  switchPlayer: 'KeyQ',
  tackle: 'KeyF',
  pause: 'Escape',
};

/**
 * Remapeia uma tecla garantindo que não existam comandos duplicados ou conflitantes:
 * se a nova tecla já estiver atribuída a outra ação, realiza a troca automática entre elas.
 */
export function remapKeyWithoutConflict(
  current: KeyBindingsConfig,
  action: keyof KeyBindingsConfig,
  newKeyCode: string
): KeyBindingsConfig {
  const updated: KeyBindingsConfig = { ...current };
  const oldCode = updated[action];
  const conflictingAction = (Object.keys(updated) as Array<keyof KeyBindingsConfig>).find(
    (k) => k !== action && updated[k] === newKeyCode
  );
  if (conflictingAction) {
    updated[conflictingAction] = oldCode;
  }
  updated[action] = newKeyCode;
  return updated;
}

export function formatKeyCodeLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  switch (code) {
    case 'Space':
      return 'ESPAÇO';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'SHIFT';
    case 'ControlLeft':
    case 'ControlRight':
      return 'CTRL';
    case 'Escape':
      return 'ESC';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    default:
      return code.toUpperCase();
  }
}

export class VarzeaInputManager {
  private keysHeld = new Set<string>();
  private keysJustPressed = new Set<string>();
  private keysJustReleased = new Set<string>();
  private keyBindings: KeyBindingsConfig = { ...DEFAULT_KEY_BINDINGS };

  // Mobile / Touch virtual state
  public touchMoveX = 0;
  public touchMoveZ = 0;
  public touchSprintHeld = false;
  public joystickSensitivity = 1.0;
  private touchKickHeld = false;
  private kickHoldDuration = 0;
  private lastReleasedKickPower = 0.55;

  // Mouse camera drag delta
  private isRightOrLeftDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private accumMouseDX = 0;
  private accumMouseDY = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.clearAll);
      window.addEventListener('mousemove', this.onMouseMove);
      window.addEventListener('mousedown', this.onMouseDown);
      window.addEventListener('mouseup', this.onMouseUp);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  public setKeyBindings(bindings?: Partial<KeyBindingsConfig>) {
    if (!bindings) return;
    this.keyBindings = { ...DEFAULT_KEY_BINDINGS, ...bindings };
  }

  public getKeyBindings(): KeyBindingsConfig {
    return { ...this.keyBindings };
  }

  public dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.clearAll);
      window.removeEventListener('mousemove', this.onMouseMove);
      window.removeEventListener('mousedown', this.onMouseDown);
      window.removeEventListener('mouseup', this.onMouseUp);
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  public clearAll = () => {
    this.keysHeld.clear();
    this.keysJustPressed.clear();
    this.keysJustReleased.clear();
    this.touchMoveX = 0;
    this.touchMoveZ = 0;
    this.touchSprintHeld = false;
    this.touchKickHeld = false;
    this.kickHoldDuration = 0;
    this.isRightOrLeftDragging = false;
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      this.clearAll();
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const code = e.code;
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    if (!this.keysHeld.has(code)) {
      this.keysJustPressed.add(code);
    }
    this.keysHeld.add(code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const code = e.code;
    if (this.keysHeld.has(code)) {
      this.keysHeld.delete(code);
      this.keysJustReleased.add(code);
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && target.tagName === 'CANVAS') {
      this.isRightOrLeftDragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    }
  };

  private onMouseUp = () => {
    this.isRightOrLeftDragging = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.isRightOrLeftDragging) return;
    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.accumMouseDX += dx * 0.004;
    this.accumMouseDY += dy * 0.003;
  };

  // Touch button triggers for mobile UI
  public setTouchJoystick(x: number, z: number) {
    const sens = Math.max(0.75, Math.min(1.35, this.joystickSensitivity));
    this.touchMoveX = Math.max(-1, Math.min(1, x * sens));
    this.touchMoveZ = Math.max(-1, Math.min(1, z * sens));
  }

  public setTouchKickHold(held: boolean) {
    const shootKey = this.keyBindings.shoot;
    if (this.touchKickHeld && !held) {
      this.keysJustReleased.add(shootKey);
    } else if (!this.touchKickHeld && held) {
      this.keysJustPressed.add(shootKey);
    }
    this.touchKickHeld = held;
  }

  public triggerTouchAction(action: 'pass' | 'tackle' | 'switch' | 'header') {
    if (action === 'pass') this.keysJustPressed.add(this.keyBindings.pass);
    if (action === 'tackle') this.keysJustPressed.add(this.keyBindings.tackle);
    if (action === 'switch') this.keysJustPressed.add(this.keyBindings.switchPlayer);
    if (action === 'header') this.keysJustPressed.add('KeyC');
  }

  public sampleFrame(dt: number): InputSnapshot {
    const kb = this.keyBindings;

    // Movement axes (Configured Keys + Arrow keys + Virtual 360° Joystick)
    let mx = this.touchMoveX;
    let mz = this.touchMoveZ;

    if (this.keysHeld.has(kb.moveRight) || this.keysHeld.has('ArrowRight')) mx += 1;
    if (this.keysHeld.has(kb.moveLeft) || this.keysHeld.has('ArrowLeft')) mx -= 1;
    if (this.keysHeld.has(kb.moveDown) || this.keysHeld.has('ArrowDown')) mz += 1;
    if (this.keysHeld.has(kb.moveUp) || this.keysHeld.has('ArrowUp')) mz -= 1;

    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }

    const sprintHeld =
      this.touchSprintHeld ||
      this.keysHeld.has(kb.sprint) ||
      (kb.sprint === 'ShiftLeft' && this.keysHeld.has('ShiftRight'));

    const kickHeld = this.touchKickHeld || this.keysHeld.has(kb.shoot);
    const kickJustPressed = this.keysJustPressed.has(kb.shoot);

    if (kickHeld) {
      this.kickHoldDuration = Math.min(0.75, this.kickHoldDuration + dt);
      // Curva progressiva: toque rápido = chute fraco/colocado (~0.32), segurar = chute normal (~0.65) até chute forte máximo (1.0)
      this.lastReleasedKickPower = Math.min(
        1.0,
        0.28 + Math.pow(this.kickHoldDuration / 0.62, 0.9) * 0.72
      );
    }

    const kickJustReleased =
      this.keysJustReleased.has(kb.shoot) ||
      (kickJustPressed && !kickHeld);

    const snapshot: InputSnapshot = {
      moveX: mx,
      moveZ: mz,
      sprintHeld,
      kickHeld,
      kickJustPressed,
      kickJustReleased,
      kickChargePower: kickHeld
        ? Math.min(1.0, 0.28 + Math.pow(this.kickHoldDuration / 0.62, 0.9) * 0.72)
        : this.lastReleasedKickPower,
      passJustPressed: this.keysJustPressed.has(kb.pass),
      longPassJustPressed: this.keysJustPressed.has(kb.longPass),
      switchJustPressed: this.keysJustPressed.has(kb.switchPlayer),
      tackleJustPressed: this.keysJustPressed.has(kb.tackle),
      headerJustPressed: this.keysJustPressed.has('KeyC'),
      pauseJustPressed:
        this.keysJustPressed.has(kb.pause) ||
        this.keysJustPressed.has('Escape') ||
        this.keysJustPressed.has('KeyP'),
      mouseDeltaX: this.accumMouseDX,
      mouseDeltaY: this.accumMouseDY,
    };

    if (kickJustReleased) {
      this.kickHoldDuration = 0;
    }

    this.keysJustPressed.clear();
    this.keysJustReleased.clear();
    this.accumMouseDX = 0;
    this.accumMouseDY = 0;

    return snapshot;
  }
}

