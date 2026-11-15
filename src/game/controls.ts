/**
 * Unified Input Controller for PC (Keyboard + Mouse) and Mobile (Virtual Joystick + Touch Buttons).
 * Separates continuous `held` states from single-frame `justPressed` / `justReleased` edges
 * and clears held keys on window blur / visibilitychange.
 */
export interface InputSnapshot {
  moveX: number; // -1 to 1
  moveZ: number; // -1 to 1
  sprintHeld: boolean;
  kickHeld: boolean;
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

export class VarzeaInputManager {
  private keysHeld = new Set<string>();
  private keysJustPressed = new Set<string>();
  private keysJustReleased = new Set<string>();

  // Mobile / Touch virtual state
  public touchMoveX = 0;
  public touchMoveZ = 0;
  public touchSprintHeld = false;
  private touchKickHeld = false;
  private kickHoldDuration = 0;
  private lastReleasedKickPower = 0.65;

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
    this.touchMoveX = x;
    this.touchMoveZ = z;
  }

  public setTouchKickHold(held: boolean) {
    if (this.touchKickHeld && !held) {
      this.keysJustReleased.add('Space');
    } else if (!this.touchKickHeld && held) {
      this.keysJustPressed.add('Space');
    }
    this.touchKickHeld = held;
  }

  public triggerTouchAction(action: 'pass' | 'tackle' | 'switch' | 'header') {
    if (action === 'pass') this.keysJustPressed.add('KeyE');
    if (action === 'tackle') this.keysJustPressed.add('KeyF');
    if (action === 'switch') this.keysJustPressed.add('KeyQ');
    if (action === 'header') this.keysJustPressed.add('KeyC');
  }

  public sampleFrame(dt: number): InputSnapshot {
    // Movement axes (WASD + Arrows + Virtual Joystick)
    let mx = this.touchMoveX;
    let mz = this.touchMoveZ;

    if (this.keysHeld.has('KeyD') || this.keysHeld.has('ArrowRight')) mx += 1;
    if (this.keysHeld.has('KeyA') || this.keysHeld.has('ArrowLeft')) mx -= 1;
    if (this.keysHeld.has('KeyS') || this.keysHeld.has('ArrowDown')) mz += 1;
    if (this.keysHeld.has('KeyW') || this.keysHeld.has('ArrowUp')) mz -= 1;

    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }

    const sprintHeld =
      this.touchSprintHeld ||
      this.keysHeld.has('ShiftLeft') ||
      this.keysHeld.has('ShiftRight');

    const kickHeld = this.touchKickHeld || this.keysHeld.has('Space');
    if (kickHeld) {
      this.kickHoldDuration = Math.min(0.85, this.kickHoldDuration + dt);
      this.lastReleasedKickPower = Math.min(
        1.0,
        0.35 + (this.kickHoldDuration / 0.65) * 0.65
      );
    }

    const kickJustReleased =
      this.keysJustReleased.has('Space') ||
      (this.keysJustPressed.has('Space') && !kickHeld);

    const snapshot: InputSnapshot = {
      moveX: mx,
      moveZ: mz,
      sprintHeld,
      kickHeld,
      kickJustReleased,
      kickChargePower: kickHeld
        ? Math.min(1.0, 0.35 + (this.kickHoldDuration / 0.65) * 0.65)
        : this.lastReleasedKickPower,
      passJustPressed: this.keysJustPressed.has('KeyE'),
      longPassJustPressed: this.keysJustPressed.has('KeyR'),
      switchJustPressed: this.keysJustPressed.has('KeyQ'),
      tackleJustPressed: this.keysJustPressed.has('KeyF'),
      headerJustPressed: this.keysJustPressed.has('KeyC'),
      pauseJustPressed:
        this.keysJustPressed.has('KeyP') || this.keysJustPressed.has('Escape'),
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
