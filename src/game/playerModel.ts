import * as THREE from 'three';
import {
  CelebrationStyle,
  PlayerAnimState,
  PlayerCustomization,
} from '../types/game';

export interface HumanRig {
  root: THREE.Group;
  pelvis: THREE.Group;
  torso: THREE.Group;
  headGroup: THREE.Group;
  leftArm: THREE.Group;
  leftForearm: THREE.Group;
  rightArm: THREE.Group;
  rightForearm: THREE.Group;
  leftThigh: THREE.Group;
  leftCalf: THREE.Group;
  rightThigh: THREE.Group;
  rightCalf: THREE.Group;
  selectionRing: THREE.Mesh;
  shadowDisc: THREE.Mesh;
  celebrationStyle: CelebrationStyle;
}

/**
 * Builds an anatomically proportioned 3D human football player using smooth tapered
 * cylindrical/spherical limbs and articulated joints (pelvis, torso, shoulders, elbows, hips, knees, head).
 * Supports distinct body builds ('slim' for Careca, 'stocky' for Bode/Ismael, 'compact' for Josué/Bicudo, 'athletic' for Yuri/Primo).
 * Explicitly avoids boxy Minecraft/Roblox shapes.
 */
export function buildHumanPlayerRig(
  config: PlayerCustomization,
  isControlled = false
): HumanRig {
  const root = new THREE.Group();

  // Body build scaling factors
  const build = config.bodyBuild || 'athletic';
  const widthScale =
    build === 'slim'
      ? 0.84
      : build === 'stocky'
      ? 1.14
      : build === 'compact'
      ? 1.02
      : 1.0;
  const heightScale =
    build === 'slim'
      ? 1.04
      : build === 'compact'
      ? 0.95
      : build === 'stocky'
      ? 1.01
      : 1.0;

  // Contact shadow disc on the dirt
  const shadowGeo = new THREE.CircleGeometry(0.46, 20);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x1c140d,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
  shadowDisc.position.y = 0.018;
  root.add(shadowDisc);

  // Active player indicator ring on the dirt
  const ringGeo = new THREE.RingGeometry(0.48, 0.62, 28);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const selectionRing = new THREE.Mesh(ringGeo, ringMat);
  selectionRing.position.y = 0.024;
  selectionRing.visible = isControlled;
  root.add(selectionRing);

  // Shared materials for this player
  const skinMat = new THREE.MeshStandardMaterial({
    color: config.skinColor,
    roughness: 0.62,
    metalness: 0.04,
  });

  const shortsMat = new THREE.MeshStandardMaterial({
    color: config.shortsColor,
    roughness: 0.78,
    metalness: 0.02,
  });

  const shirtMat = new THREE.MeshStandardMaterial({
    color:
      config.shirtStyle === 'shirtless' ? config.skinColor : config.shirtPrimary,
    roughness: config.shirtStyle === 'shirtless' ? 0.62 : 0.74,
    metalness: 0.03,
  });

  const accentShirtMat = new THREE.MeshStandardMaterial({
    color: config.shirtSecondary,
    roughness: 0.72,
    metalness: 0.03,
  });

  const hairMat = new THREE.MeshStandardMaterial({
    color: config.hairColor,
    roughness: 0.85,
    metalness: 0.02,
  });

  const bootMat = new THREE.MeshStandardMaterial({
    color: config.barefoot ? config.skinColor : config.bootColor,
    roughness: config.barefoot ? 0.65 : 0.42,
    metalness: config.barefoot ? 0.02 : 0.15,
  });

  // 1. Pelvis / Shorts hip root at y = 0.92m
  const pelvis = new THREE.Group();
  pelvis.position.set(0, 0.92 * heightScale, 0);
  pelvis.scale.set(widthScale, heightScale, widthScale);
  root.add(pelvis);

  const hipsMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.165, 0.155, 0.2, 14),
    shortsMat
  );
  hipsMesh.scale.set(1.12, 1, 0.78);
  hipsMesh.castShadow = true;
  pelvis.add(hipsMesh);

  // 2. Torso & Chest (pivots at waist)
  const torso = new THREE.Group();
  torso.position.set(0, 0.08, 0);
  pelvis.add(torso);

  // Lower abdomen / waist
  const abdomenMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.175, 0.16, 0.26, 14),
    shirtMat
  );
  abdomenMesh.position.y = 0.13;
  abdomenMesh.scale.set(1.1, 1, 0.74);
  abdomenMesh.castShadow = true;
  torso.add(abdomenMesh);

  // Upper chest (athletic V-taper)
  const chestMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.205, 0.175, 0.3, 16),
    shirtMat
  );
  chestMesh.position.y = 0.38;
  chestMesh.scale.set(1.16, 1, 0.76);
  chestMesh.castShadow = true;
  torso.add(chestMesh);

  // Rounded shoulders bridge
  const shoulderBridge = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.11, 0.28, 8, 12),
    shirtMat
  );
  shoulderBridge.rotation.z = Math.PI / 2;
  shoulderBridge.position.set(0, 0.49, 0);
  shoulderBridge.scale.set(1, 1, 0.82);
  torso.add(shoulderBridge);

  // Optional jersey stripe or pattern detail so teams & patterned shirts stand out
  if (config.shirtStyle === 'striped') {
    const stripeGeo = new THREE.CylinderGeometry(
      0.208,
      0.178,
      0.28,
      16,
      1,
      true,
      -0.5,
      1.0
    );
    const stripeMesh = new THREE.Mesh(stripeGeo, accentShirtMat);
    stripeMesh.position.y = 0.38;
    stripeMesh.scale.set(1.17, 1, 0.77);
    torso.add(stripeMesh);
  } else if (config.shirtStyle === 'patterned') {
    // Diagonal/sash pattern like Yuri's patterned shirt in the reference photo
    const sashMesh = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.032, 8, 18),
      accentShirtMat
    );
    sashMesh.position.set(0, 0.36, 0);
    sashMesh.rotation.set(0.55, 0.2, 0.4);
    sashMesh.scale.set(1.15, 1, 0.75);
    torso.add(sashMesh);
  }

  // Collar / Neck
  const neckMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.068, 0.078, 0.11, 12),
    skinMat
  );
  neckMesh.position.set(0, 0.58, 0);
  torso.add(neckMesh);

  // 3. Head Group (natural human head ratio ~1:7.5 of body height, normalized against pelvis widthScale)
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.68, 0);
  headGroup.scale.set(1 / widthScale, 1 / heightScale, 1 / widthScale);
  torso.add(headGroup);

  // Cranium + Jaw sculpted composite
  const headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.125, 18, 16),
    skinMat
  );
  headMesh.scale.set(0.92, 1.12, 0.98);
  headMesh.position.y = 0.05;
  headMesh.castShadow = true;
  headGroup.add(headMesh);

  // Nose (+Z is forward)
  const noseMesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.022, 0.05, 8),
    skinMat
  );
  noseMesh.rotation.x = Math.PI / 2;
  noseMesh.position.set(0, 0.045, 0.125);
  headGroup.add(noseMesh);

  // Ears
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), skinMat);
    ear.scale.set(0.45, 1.1, 0.75);
    ear.position.set(side * 0.115, 0.045, 0);
    headGroup.add(ear);
  }

  // Eyes & Eyebrows
  const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xfafaf9 });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x141210 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.016, 8, 8),
      eyeWhiteMat
    );
    eye.position.set(side * 0.042, 0.068, 0.108);
    headGroup.add(eye);

    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.009, 6, 6),
      pupilMat
    );
    pupil.position.set(side * 0.042, 0.068, 0.121);
    headGroup.add(pupil);

    const brow = new THREE.Mesh(
      new THREE.BoxGeometry(0.034, 0.009, 0.012),
      hairMat
    );
    brow.position.set(side * 0.042, 0.09, 0.112);
    headGroup.add(brow);
  }

  // Hair / Cap styles (Note: 'bald' leaves the smooth cranium exposed for Careca)
  if (config.hairStyle === 'short_fade' || config.hairStyle === 'buzz') {
    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.129,
        16,
        12,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.58
      ),
      hairMat
    );
    hairCap.scale.set(0.93, 1.1, 1.0);
    hairCap.position.y = 0.058;
    headGroup.add(hairCap);
  } else if (config.hairStyle === 'curly' || config.hairStyle === 'afro') {
    const isAfro = config.hairStyle === 'afro';
    const baseHair = new THREE.Mesh(
      new THREE.SphereGeometry(
        isAfro ? 0.152 : 0.136,
        14,
        12,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.65
      ),
      hairMat
    );
    baseHair.position.set(0, 0.072, -0.005);
    headGroup.add(baseHair);

    // Goatee for Bode
    if (isAfro) {
      const goatee = new THREE.Mesh(
        new THREE.ConeGeometry(0.025, 0.045, 8),
        hairMat
      );
      goatee.rotation.x = Math.PI;
      goatee.position.set(0, -0.055, 0.1);
      headGroup.add(goatee);
    }
  } else if (
    config.hairStyle === 'cap_orange' ||
    config.hairStyle === 'cap_black'
  ) {
    const capColor = config.hairStyle === 'cap_orange' ? 0xd96b27 : 0x18181b;
    const capMat = new THREE.MeshStandardMaterial({
      color: capColor,
      roughness: 0.7,
    });
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.131,
        16,
        12,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.52
      ),
      capMat
    );
    crown.position.y = 0.065;
    headGroup.add(crown);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.012, 0.11),
      capMat
    );
    visor.position.set(0, 0.085, 0.12);
    visor.rotation.x = 0.12;
    headGroup.add(visor);
  }

  // 4. Arms (Upper Arm + Forearm + Hand)
  const buildArm = (side: -1 | 1) => {
    const upperArmGroup = new THREE.Group();
    upperArmGroup.position.set(side * 0.245, 0.48, 0);
    torso.add(upperArmGroup);

    const hasSleeve =
      config.shirtStyle !== 'shirtless' && config.shirtStyle !== 'tank_top';

    if (hasSleeve) {
      const sleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.058, 0.052, 0.14, 10),
        shirtMat
      );
      sleeve.position.y = -0.06;
      upperArmGroup.add(sleeve);
    }

    const upperArm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.042, 0.25, 10),
      skinMat
    );
    upperArm.position.y = -0.13;
    upperArm.castShadow = true;
    upperArmGroup.add(upperArm);

    const forearmGroup = new THREE.Group();
    forearmGroup.position.set(0, -0.25, 0);
    upperArmGroup.add(forearmGroup);

    const forearm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.033, 0.24, 10),
      skinMat
    );
    forearm.position.y = -0.12;
    forearmGroup.add(forearm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), skinMat);
    hand.scale.set(0.8, 1.15, 0.65);
    hand.position.y = -0.25;
    forearmGroup.add(hand);

    return { upperArmGroup, forearmGroup };
  };

  const leftArmRig = buildArm(-1);
  const rightArmRig = buildArm(1);

  // 5. Legs (Thigh + Knee + Calf + Foot/Boot)
  const buildLeg = (side: -1 | 1) => {
    const thighGroup = new THREE.Group();
    thighGroup.position.set(side * 0.105, -0.04, 0);
    pelvis.add(thighGroup);

    // Shorts leg cuff
    const shortLeg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.088, 0.082, 0.23, 12),
      shortsMat
    );
    shortLeg.position.y = -0.1;
    shortLeg.castShadow = true;
    thighGroup.add(shortLeg);

    // Lower thigh (skin)
    const thighSkin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.062, 0.24, 12),
      skinMat
    );
    thighSkin.position.y = -0.28;
    thighSkin.castShadow = true;
    thighGroup.add(thighSkin);

    // Calf group (pivots at knee y = -0.40)
    const calfGroup = new THREE.Group();
    calfGroup.position.set(0, -0.4, 0);
    thighGroup.add(calfGroup);

    const calf = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.042, 0.38, 12),
      skinMat
    );
    calf.position.y = -0.19;
    calf.castShadow = true;
    calfGroup.add(calf);

    // Foot / Boot at ankle y = -0.40
    const footGroup = new THREE.Group();
    footGroup.position.set(0, -0.4, 0.045);
    calfGroup.add(footGroup);

    const footMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.042, 0.12, 6, 10),
      bootMat
    );
    footMesh.rotation.x = Math.PI / 2;
    footMesh.scale.set(1.05, 1, 0.72);
    footGroup.add(footMesh);

    return { thighGroup, calfGroup };
  };

  const leftLegRig = buildLeg(-1);
  const rightLegRig = buildLeg(1);

  return {
    root,
    pelvis,
    torso,
    headGroup,
    leftArm: leftArmRig.upperArmGroup,
    leftForearm: leftArmRig.forearmGroup,
    rightArm: rightArmRig.upperArmGroup,
    rightForearm: rightArmRig.forearmGroup,
    leftThigh: leftLegRig.thighGroup,
    leftCalf: leftLegRig.calfGroup,
    rightThigh: rightLegRig.thighGroup,
    rightCalf: rightLegRig.calfGroup,
    selectionRing,
    shadowDisc,
    celebrationStyle: config.celebrationStyle || 'yuri',
  };
}

/**
 * Updates skeletal joint rotations smoothly for all required animations:
 * idle, walk, run, kick, pass, header, tackle (carrinho), fall/recover,
 * and personalized 3D goal celebrations for Yuri, Josué, Careca, and Bode.
 */
export function updateHumanPlayerAnimation(
  rig: HumanRig,
  animState: PlayerAnimState,
  stridePhase: number,
  animTimer: number,
  speedRatio: number,
  isControlled: boolean,
  elapsedTime: number
) {
  rig.selectionRing.visible = isControlled;
  if (isControlled) {
    const scale = 1 + Math.sin(elapsedTime * 5) * 0.05;
    rig.selectionRing.scale.set(scale, scale, 1);
  }

  const basePelvisY = 0.92 * rig.pelvis.scale.y;

  // Reset base pelvis height and rotation
  rig.pelvis.position.y = basePelvisY;
  rig.pelvis.rotation.set(0, 0, 0);
  rig.torso.rotation.set(0, 0, 0);
  rig.headGroup.rotation.set(0, 0, 0);

  if (animState === 'tackle') {
    // Slide tackle ("carrinho na terra/lama")
    rig.pelvis.position.y = 0.28;
    rig.pelvis.rotation.x = -1.15;
    rig.torso.rotation.x = 0.25;
    rig.rightThigh.rotation.set(-0.35, 0, 0);
    rig.rightCalf.rotation.set(0.1, 0, 0);
    rig.leftThigh.rotation.set(0.45, 0, -0.2);
    rig.leftCalf.rotation.set(1.1, 0, 0);
    rig.leftArm.rotation.set(-0.6, 0, -0.4);
    rig.rightArm.rotation.set(0.5, 0, 0.4);
    return;
  }

  if (animState === 'fall') {
    // Fallen on the dirt and recovering ("queda e recuperação")
    const recoverFactor = Math.min(1, animTimer * 1.4);
    rig.pelvis.position.y = 0.25 + recoverFactor * 0.45;
    rig.pelvis.rotation.x = (1 - recoverFactor) * 1.25;
    rig.torso.rotation.x = 0.35;
    rig.leftThigh.rotation.set(-0.6, 0, 0);
    rig.rightThigh.rotation.set(-0.4, 0, 0);
    rig.leftCalf.rotation.set(0.8, 0, 0);
    rig.rightCalf.rotation.set(0.7, 0, 0);
    rig.leftArm.rotation.set(-0.9, 0, -0.2);
    rig.rightArm.rotation.set(-0.9, 0, 0.2);
    return;
  }

  if (animState === 'celebrate') {
    const style = rig.celebrationStyle;

    if (style === 'yuri') {
      // YURI: Runs toward camera, raises arms, performs a high joy jump ("salto de alegria"), then lands in a relaxed pose
      const t = animTimer;
      if (t < 1.35) {
        // Joy jump arc + raised arms
        const jumpPhase = Math.sin((t / 1.35) * Math.PI);
        rig.pelvis.position.y = basePelvisY + Math.max(0, jumpPhase) * 0.44;
        rig.torso.rotation.x = -0.22 * jumpPhase;
        rig.leftArm.rotation.set(-2.75, 0, -0.35);
        rig.rightArm.rotation.set(-2.75, 0, 0.35);
        rig.leftForearm.rotation.set(-0.2, 0, 0);
        rig.rightForearm.rotation.set(-0.2, 0, 0);
        rig.leftThigh.rotation.set(-0.35 * jumpPhase, 0, -0.1);
        rig.rightThigh.rotation.set(-0.45 * jumpPhase, 0, 0.1);
        rig.leftCalf.rotation.set(0.75 * jumpPhase, 0, 0);
        rig.rightCalf.rotation.set(0.85 * jumpPhase, 0, 0);
      } else {
        // Relaxed cool várzea pose (arms crossed / pointing up)
        const sway = Math.sin(elapsedTime * 4) * 0.08;
        rig.pelvis.position.y = basePelvisY;
        rig.torso.rotation.x = -0.12;
        rig.torso.rotation.y = sway;
        rig.headGroup.rotation.y = -sway * 0.6;
        rig.leftArm.rotation.set(-0.55, 0, -0.45);
        rig.leftForearm.rotation.set(-1.35, 0, 0.6);
        rig.rightArm.rotation.set(-2.6, 0, 0.25 + sway);
        rig.rightForearm.rotation.set(-0.25, 0, 0);
        rig.leftThigh.rotation.set(-0.08, 0, -0.12);
        rig.rightThigh.rotation.set(0.12, 0, 0.12);
      }
      return;
    }

    if (style === 'josue') {
      // JOSUÉ: Short funny dance swaying arms and hips ("dancinha curta engraçada balançando braços e quadril"), finishing with victory pose
      const t = animTimer;
      if (t < 2.1) {
        const beat = elapsedTime * 12;
        const hipSwing = Math.sin(beat);
        rig.pelvis.position.y = basePelvisY + Math.abs(Math.cos(beat)) * 0.09;
        rig.pelvis.rotation.z = hipSwing * 0.22;
        rig.pelvis.rotation.y = hipSwing * 0.28;
        rig.torso.rotation.z = -hipSwing * 0.18;
        rig.torso.rotation.y = -hipSwing * 0.32;
        rig.leftArm.rotation.set(-1.4 + hipSwing * 0.65, 0, -0.55);
        rig.rightArm.rotation.set(-1.4 - hipSwing * 0.65, 0, 0.55);
        rig.leftForearm.rotation.set(-1.1, 0, 0);
        rig.rightForearm.rotation.set(-1.1, 0, 0);
        rig.leftThigh.rotation.set(hipSwing * 0.35, 0, -0.12);
        rig.rightThigh.rotation.set(-hipSwing * 0.35, 0, 0.12);
        rig.leftCalf.rotation.set(0.45, 0, 0);
        rig.rightCalf.rotation.set(0.45, 0, 0);
      } else {
        // V-Victory pose
        rig.pelvis.position.y = basePelvisY + 0.04;
        rig.torso.rotation.x = -0.18;
        rig.leftArm.rotation.set(-2.65, 0, -0.55);
        rig.rightArm.rotation.set(-2.65, 0, 0.55);
        rig.leftForearm.rotation.set(-0.1, 0, 0);
        rig.rightForearm.rotation.set(-0.1, 0, 0);
      }
      return;
    }

    if (style === 'careca') {
      // CARECA: Rapid funny rhythmic dance moves ("movimentos rápidos e engraçados de dança"), finishing pointing toward teammates
      const t = animTimer;
      if (t < 2.0) {
        const fast = elapsedTime * 16.5;
        const s = Math.sin(fast);
        const c = Math.cos(fast);
        rig.pelvis.position.y = basePelvisY + Math.abs(s) * 0.13;
        rig.pelvis.rotation.y = s * 0.38;
        rig.torso.rotation.x = 0.12 + c * 0.1;
        rig.torso.rotation.y = -s * 0.42;
        rig.headGroup.rotation.z = s * 0.18;
        // Fast alternating windmill/samba arms
        rig.leftArm.rotation.set(-1.5 + s * 0.95, 0, -0.45 + c * 0.25);
        rig.rightArm.rotation.set(-1.5 - s * 0.95, 0, 0.45 - c * 0.25);
        rig.leftForearm.rotation.set(-0.85, 0, 0);
        rig.rightForearm.rotation.set(-0.85, 0, 0);
        // Fast high-stepping legs ("passinho")
        rig.leftThigh.rotation.set(Math.min(0, s * 0.85), 0, -0.08);
        rig.rightThigh.rotation.set(Math.min(0, -s * 0.85), 0, 0.08);
        rig.leftCalf.rotation.set(Math.max(0.15, -s * 0.95), 0, 0);
        rig.rightCalf.rotation.set(Math.max(0.15, s * 0.95), 0, 0);
      } else {
        // Points forward toward teammates
        rig.pelvis.position.y = basePelvisY;
        rig.torso.rotation.y = -0.25;
        rig.rightArm.rotation.set(-1.55, 0, 0.1);
        rig.rightForearm.rotation.set(-0.05, 0, 0);
        rig.leftArm.rotation.set(-0.4, 0, -0.35);
        rig.leftForearm.rotation.set(-0.8, 0, 0);
      }
      return;
    }

    if (style === 'bode') {
      // BODE: Irreverent celebration raising arms and doing a chest/shoulder groove with teammates
      const groove = Math.sin(elapsedTime * 11);
      const bounce = Math.abs(Math.cos(elapsedTime * 11)) * 0.16;
      rig.pelvis.position.y = basePelvisY + bounce;
      rig.torso.rotation.x = -0.2 + groove * 0.12;
      rig.torso.rotation.y = groove * 0.3;
      rig.leftArm.rotation.set(-2.35 + groove * 0.35, 0, -0.5);
      rig.rightArm.rotation.set(-2.35 - groove * 0.35, 0, 0.5);
      rig.leftForearm.rotation.set(-0.55, 0, 0);
      rig.rightForearm.rotation.set(-0.55, 0, 0);
      rig.leftThigh.rotation.set(-groove * 0.45, 0, -0.14);
      rig.rightThigh.rotation.set(groove * 0.45, 0, 0.14);
      rig.leftCalf.rotation.set(0.4, 0, 0);
      rig.rightCalf.rotation.set(0.4, 0, 0);
      return;
    }

    // Default / Rival celebration jump & raised arms
    const bounce = Math.abs(Math.sin(elapsedTime * 9)) * 0.18;
    rig.pelvis.position.y = basePelvisY + bounce;
    rig.torso.rotation.y = Math.sin(elapsedTime * 6) * 0.25;
    rig.torso.rotation.x = -0.15;
    rig.leftArm.rotation.set(
      -2.55,
      0,
      -0.35 + Math.sin(elapsedTime * 10) * 0.15
    );
    rig.rightArm.rotation.set(
      -2.55,
      0,
      0.35 - Math.sin(elapsedTime * 10) * 0.15
    );
    rig.leftForearm.rotation.set(-0.3, 0, 0);
    rig.rightForearm.rotation.set(-0.3, 0, 0);
    rig.leftThigh.rotation.set(Math.sin(elapsedTime * 9) * 0.4, 0, -0.08);
    rig.rightThigh.rotation.set(-Math.sin(elapsedTime * 9) * 0.4, 0, 0.08);
    rig.leftCalf.rotation.set(0.3, 0, 0);
    rig.rightCalf.rotation.set(0.3, 0, 0);
    return;
  }

  if (animState === 'kick' || animState === 'pass') {
    // Windup -> Strike -> Follow-through
    const isStrong = animState === 'kick';
    const swing = Math.sin(Math.min(1, animTimer / 0.32) * Math.PI);
    const legAngle = isStrong ? -1.25 * swing : -0.85 * swing;

    rig.torso.rotation.x = -0.18 * swing;
    rig.torso.rotation.y = 0.25 * swing;

    rig.rightThigh.rotation.set(legAngle, 0, 0);
    rig.rightCalf.rotation.set(swing < 0.4 ? 0.85 : 0.1, 0, 0);

    rig.leftThigh.rotation.set(0.28 * swing, 0, 0);
    rig.leftCalf.rotation.set(0.25, 0, 0);

    rig.leftArm.rotation.set(-0.75 * swing, 0, -0.35);
    rig.rightArm.rotation.set(0.55 * swing, 0, 0.25);
    rig.leftForearm.rotation.set(-0.6, 0, 0);
    rig.rightForearm.rotation.set(-0.5, 0, 0);
    return;
  }

  if (animState === 'header') {
    const jumpArc = Math.sin(Math.min(1, animTimer / 0.4) * Math.PI);
    rig.pelvis.position.y = basePelvisY + jumpArc * 0.38;
    rig.torso.rotation.x = 0.35 * jumpArc;
    rig.headGroup.rotation.x = 0.25 * jumpArc;
    rig.leftArm.rotation.set(-0.6, 0, -0.45);
    rig.rightArm.rotation.set(-0.6, 0, 0.45);
    rig.leftThigh.rotation.set(0.2, 0, 0);
    rig.rightThigh.rotation.set(0.2, 0, 0);
    rig.leftCalf.rotation.set(0.65, 0, 0);
    rig.rightCalf.rotation.set(0.65, 0, 0);
    return;
  }

  // Locomotion: Idle, Walk, Run
  if (speedRatio > 0.05) {
    const amp = Math.min(1.05, 0.35 + speedRatio * 0.68);
    const s = Math.sin(stridePhase);
    const c = Math.cos(stridePhase);

    // Vertical gait bob synced to stride
    rig.pelvis.position.y = basePelvisY + Math.abs(c) * 0.055 * speedRatio;
    rig.torso.rotation.x = 0.14 * speedRatio; // natural athletic forward lean
    rig.torso.rotation.y = -s * 0.16 * amp;

    // Counter-swinging thighs & knees
    rig.leftThigh.rotation.set(-s * 0.85 * amp, 0, 0);
    rig.rightThigh.rotation.set(s * 0.85 * amp, 0, 0);

    rig.leftCalf.rotation.set(Math.max(0.08, c * 0.85 * amp + 0.35), 0, 0);
    rig.rightCalf.rotation.set(Math.max(0.08, -c * 0.85 * amp + 0.35), 0, 0);

    // Arms swing opposite to legs
    rig.leftArm.rotation.set(s * 0.72 * amp, 0, -0.14);
    rig.rightArm.rotation.set(-s * 0.72 * amp, 0, 0.14);

    const elbowBend = -0.55 - speedRatio * 0.45;
    rig.leftForearm.rotation.set(elbowBend, 0, 0);
    rig.rightForearm.rotation.set(elbowBend, 0, 0);
  } else {
    // Athletic breathing idle stance
    const breath = Math.sin(elapsedTime * 2.6);
    rig.pelvis.position.y = basePelvisY - 0.01 + breath * 0.01;
    rig.torso.rotation.x = 0.04 + breath * 0.015;
    rig.leftThigh.rotation.set(-0.06, 0, -0.05);
    rig.rightThigh.rotation.set(0.06, 0, 0.05);
    rig.leftCalf.rotation.set(0.12, 0, 0);
    rig.rightCalf.rotation.set(0.12, 0, 0);
    rig.leftArm.rotation.set(0.04, 0, -0.14);
    rig.rightArm.rotation.set(-0.04, 0, 0.14);
    rig.leftForearm.rotation.set(-0.35, 0, 0);
    rig.rightForearm.rotation.set(-0.35, 0, 0);
  }
}
