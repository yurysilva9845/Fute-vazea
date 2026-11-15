import * as THREE from 'three';
import {
  BallState,
  CameraMode,
  GameScreenState,
  MatchPhase,
  PlayerRuntimeState,
} from '../types/game';
import { DEFAULT_PITCH } from './rules';

/**
 * Third-person dynamic Várzea football camera controller.
 * Features:
 * - Smooth exponential damping (never jerks or snaps)
 * - Keeps both the ball and active players framed in view
 * - Zooms in subtly during attacks near the goal boxes
 * - Spotlights the goal scorer during 'goal_celebration' so custom 3D celebrations shine
 * - Supports 4 camera presets: 'follow' (3ª Pessoa / TV Dinâmica), 'overview' (Campinho Inteiro),
 *   'sideline' (Lateral da Várzea), and 'close' (Pro Player)
 */
export class VarzeaCameraRig {
  public currentPos = new THREE.Vector3(0, 11.5, 19.5);
  public currentLookAt = new THREE.Vector3(0, 0.8, 0);
  public trauma = 0;
  public mouseYawOffset = 0;
  public mousePitchOffset = 0;
  private titleTourTime = 0;

  private readonly _targetPos = new THREE.Vector3();
  private readonly _targetLook = new THREE.Vector3();

  public addTrauma(amount: number) {
    this.trauma = Math.min(1.0, this.trauma + amount);
  }

  public resetOffsets() {
    this.mouseYawOffset = 0;
    this.mousePitchOffset = 0;
  }

  public update(
    camera: THREE.PerspectiveCamera,
    dt: number,
    screenState: GameScreenState,
    mode: CameraMode,
    distanceMultiplier: number,
    ball: BallState,
    controlledPlayer: PlayerRuntimeState | undefined,
    matchPhase: MatchPhase = 'open_play',
    celebratingPlayer?: PlayerRuntimeState
  ) {
    // 1. Live World Camera Tour during Title Screen
    if (screenState === 'title') {
      this.titleTourTime += dt * 0.24;
      const angle = Math.sin(this.titleTourTime) * 0.48;
      const radius = 21.5;
      this._targetPos.set(
        Math.sin(angle) * radius * 0.85,
        6.2 + Math.cos(this.titleTourTime * 0.7) * 1.4,
        Math.cos(angle) * radius
      );
      this._targetLook.set(
        Math.sin(this.titleTourTime * 1.2) * 3.5,
        1.1,
        -2.0
      );

      this.currentPos.lerp(this._targetPos, 1 - Math.exp(-3.5 * dt));
      this.currentLookAt.lerp(this._targetLook, 1 - Math.exp(-4.0 * dt));
      camera.position.copy(this.currentPos);
      camera.lookAt(this.currentLookAt);
      return;
    }

    // 2. Goal Celebration Spotlight Camera (focuses on the goal scorer & celebrating teammates)
    if (matchPhase === 'goal_celebration' && celebratingPlayer) {
      this._targetPos.set(
        celebratingPlayer.x + Math.sin(celebratingPlayer.facingAngle) * 3.8,
        2.35,
        celebratingPlayer.z + Math.cos(celebratingPlayer.facingAngle) * 3.8 + 1.2
      );
      this._targetLook.set(
        celebratingPlayer.x,
        1.25,
        celebratingPlayer.z
      );

      this.currentPos.x = THREE.MathUtils.damp(this.currentPos.x, this._targetPos.x, 4.8, dt);
      this.currentPos.y = THREE.MathUtils.damp(this.currentPos.y, this._targetPos.y, 4.8, dt);
      this.currentPos.z = THREE.MathUtils.damp(this.currentPos.z, this._targetPos.z, 4.8, dt);

      this.currentLookAt.x = THREE.MathUtils.damp(this.currentLookAt.x, this._targetLook.x, 6.5, dt);
      this.currentLookAt.y = THREE.MathUtils.damp(this.currentLookAt.y, this._targetLook.y, 6.5, dt);
      this.currentLookAt.z = THREE.MathUtils.damp(this.currentLookAt.z, this._targetLook.z, 6.5, dt);

      camera.position.copy(this.currentPos);
      if (this.trauma > 0) {
        const shake = this.trauma * this.trauma * 0.25;
        camera.position.x += (Math.random() - 0.5) * shake;
        camera.position.y += (Math.random() - 0.5) * shake;
        this.trauma = Math.max(0, this.trauma - dt * 2.4);
      }
      camera.lookAt(this.currentLookAt);
      return;
    }

    // 3. Gameplay Camera Modes
    const pX = controlledPlayer ? controlledPlayer.x : ball.x;
    const pZ = controlledPlayer ? controlledPlayer.z : ball.z;

    // Blend focus point between ball (65%) and controlled player (35%) so both stay in frame
    const focusX = THREE.MathUtils.clamp(ball.x * 0.65 + pX * 0.35, -14.5, 14.5);
    const focusZ = THREE.MathUtils.clamp(ball.z * 0.65 + pZ * 0.35, -8.5, 8.5);

    // Attack proximity zoom factor (zooms in slightly when near either goal)
    const attackProximity = Math.min(
      1,
      Math.abs(ball.x) / (DEFAULT_PITCH.width * 0.5)
    );
    const attackZoom = 1 - attackProximity * 0.14;
    const distScale = distanceMultiplier * attackZoom;

    if (mode === 'overview') {
      // Wide view showing the entire dirt field, puddles, walls & trees
      this._targetPos.set(
        focusX * 0.25,
        17.5 * distanceMultiplier,
        24.5 * distanceMultiplier
      );
      this._targetLook.set(focusX * 0.35, 0.5, focusZ * 0.25);
    } else if (mode === 'sideline') {
      // Broadcast sideline perspective right over the spectator's wooden stool
      this._targetPos.set(
        focusX * 0.68,
        8.6 * distScale,
        17.2 * distScale
      );
      this._targetLook.set(focusX * 0.85, 0.9, focusZ * 0.55 - 1.2);
    } else if (mode === 'close') {
      // Closer third-person action perspective behind the active player/ball
      const yaw = this.mouseYawOffset;
      const offsetX = -4.2 + Math.sin(yaw) * 4.0;
      const offsetZ = 11.8 * distScale + Math.cos(yaw) * 2.0;
      this._targetPos.set(
        focusX + offsetX,
        5.8 * distScale + this.mousePitchOffset * 2.5,
        focusZ + offsetZ
      );
      this._targetLook.set(ball.x * 0.75 + pX * 0.25, 1.0, ball.z * 0.75 + pZ * 0.25);
    } else {
      // Default 'follow': balanced third-person Várzea camera
      const yaw = this.mouseYawOffset;
      this._targetPos.set(
        focusX * 0.78 + Math.sin(yaw) * 5.0,
        10.4 * distScale + this.mousePitchOffset * 3.0,
        focusZ * 0.45 + 17.8 * distScale
      );
      this._targetLook.set(focusX * 0.9, 0.8, focusZ * 0.65 - 0.8);
    }

    // Exponentially damp camera position and lookAt target
    const posLambda = 5.8;
    const lookLambda = 7.5;
    this.currentPos.x = THREE.MathUtils.damp(this.currentPos.x, this._targetPos.x, posLambda, dt);
    this.currentPos.y = THREE.MathUtils.damp(this.currentPos.y, this._targetPos.y, posLambda, dt);
    this.currentPos.z = THREE.MathUtils.damp(this.currentPos.z, this._targetPos.z, posLambda, dt);

    this.currentLookAt.x = THREE.MathUtils.damp(this.currentLookAt.x, this._targetLook.x, lookLambda, dt);
    this.currentLookAt.y = THREE.MathUtils.damp(this.currentLookAt.y, this._targetLook.y, lookLambda, dt);
    this.currentLookAt.z = THREE.MathUtils.damp(this.currentLookAt.z, this._targetLook.z, lookLambda, dt);

    camera.position.copy(this.currentPos);

    // Apply decaying trauma * trauma camera shake on heavy shots/tackles/goals
    if (this.trauma > 0) {
      const shake = this.trauma * this.trauma * 0.32;
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      this.trauma = Math.max(0, this.trauma - dt * 2.4);
    }

    camera.lookAt(this.currentLookAt);
  }
}
