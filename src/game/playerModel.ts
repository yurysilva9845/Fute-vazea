import * as THREE from 'three';
import {
  CelebrationStyle,
  PhotoSkinId,
  PlayerAnimState,
  PlayerCustomization,
} from '../types/game';
import {
  createFabricBumpTexture,
  createKneeBraceTexture,
  createPlayerFaceTexture,
  createPlayerShirtTexture,
} from './playerTextures';

export interface HumanRig {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  leftShoulder: THREE.Group;
  rightShoulder: THREE.Group;
  leftHip: THREE.Group;
  rightHip: THREE.Group;
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  selectionRing: THREE.Mesh;
  celebrationStyle: CelebrationStyle;
  heightScale: number;
}

function resolveSkinId(config: PlayerCustomization): PhotoSkinId | undefined {
  if (config.photoSkinId) return config.photoSkinId;
  const lower = config.name.trim().toLowerCase();
  if (lower.includes('josu')) return 'josue';
  if (lower.includes('careca')) return 'careca';
  if (lower.includes('bode')) return 'bode';
  if (lower.includes('ismael')) return 'ismael';
  if (lower.includes('yuri')) return 'yuri';
  if (lower.includes('primo')) return 'primo';
  if (lower.includes('bicudo')) return 'bicudo';
  if (lower.includes('felipe')) return 'felipe';
  return undefined;
}

/**
 * Builds a high-detail 3D composite humanoid character model faithful to the attached
 * group photograph for BODE, JOSUÉ, CARECA, ISMAEL, YURI, PRIMO, BICUDO, and FELIPE.
 */
export function buildHumanPlayerRig(
  config: PlayerCustomization,
  isControlled = false
): HumanRig {
  const root = new THREE.Group();
  const skinId = resolveSkinId(config);
  const fabricBump = createFabricBumpTexture();

  const skinMat = new THREE.MeshStandardMaterial({
    color: config.skinColor,
    roughness: 0.62,
    metalness: 0.04,
  });

  const shirtTex = createPlayerShirtTexture(skinId, config.shirtPrimary);
  const shirtFrontMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: shirtTex,
    bumpMap: fabricBump,
    bumpScale: 0.004,
    roughness: 0.78,
  });

  const shirtPlainMat = new THREE.MeshStandardMaterial({
    color: config.shirtPrimary,
    bumpMap: fabricBump,
    bumpScale: 0.004,
    roughness: 0.8,
  });

  const shortsMat = new THREE.MeshStandardMaterial({
    color: config.shortsColor,
    bumpMap: fabricBump,
    bumpScale: 0.005,
    roughness: 0.84,
  });

  const hairMat = new THREE.MeshStandardMaterial({
    color: config.hairColor,
    roughness: 0.88,
  });

  const isSlim = config.bodyBuild === 'slim';
  const isStocky = config.bodyBuild === 'stocky';
  const isCompact = config.bodyBuild === 'compact';
  const isTallLean =
    config.bodyBuild === 'tall_lean' || skinId === 'bode' || skinId === 'josue';

  const heightScale =
    skinId === 'bode'
      ? 1.09
      : skinId === 'josue'
      ? 1.05
      : skinId === 'careca'
      ? 0.96
      : skinId === 'ismael'
      ? 0.99
      : isTallLean
      ? 1.05
      : isCompact
      ? 0.97
      : 1.0;

  const torsoWidthScale = isSlim
    ? 0.9
    : isStocky
    ? 1.15
    : skinId === 'bode'
    ? 1.05
    : 1.0;
  const limbThicknessScale = isSlim ? 0.88 : isStocky ? 1.16 : 1.0;

  // Ground selection ring
  const ringGeo = new THREE.RingGeometry(0.46, 0.58, 32);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: isControlled ? 0.88 : 0.0,
  });
  const selectionRing = new THREE.Mesh(ringGeo, ringMat);
  selectionRing.position.y = 0.025;
  root.add(selectionRing);

  // Soft ground shadow disc
  const shadowGeo = new THREE.CircleGeometry(0.42, 24);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x1a110a,
    transparent: true,
    opacity: 0.44,
    depthWrite: false,
  });
  const shadowDisk = new THREE.Mesh(shadowGeo, shadowMat);
  shadowDisk.position.y = 0.015;
  root.add(shadowDisk);

  // Hips root
  const hips = new THREE.Group();
  hips.position.y = 0.88 * heightScale;
  hips.scale.set(1, heightScale, 1);
  root.add(hips);

  // Pelvis / Shorts Waistband with real 3D thickness
  const pelvisGeo = new THREE.BoxGeometry(
    0.42 * torsoWidthScale,
    0.16,
    0.26 * torsoWidthScale
  );
  const pelvis = new THREE.Mesh(pelvisGeo, shortsMat);
  pelvis.castShadow = true;
  hips.add(pelvis);

  // Shorts elastic waistband ridge + drawstrings
  const waistBandGeo = new THREE.BoxGeometry(
    0.435 * torsoWidthScale,
    0.045,
    0.272 * torsoWidthScale
  );
  const waistBand = new THREE.Mesh(waistBandGeo, shortsMat);
  waistBand.position.y = 0.068;
  hips.add(waistBand);

  const cordMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.7,
  });
  for (const side of [-1, 1]) {
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.075, 6),
      cordMat
    );
    cord.position.set(side * 0.022, 0.035, 0.138 * torsoWidthScale);
    cord.rotation.z = side * 0.12;
    hips.add(cord);
  }

  // Torso group
  const torso = new THREE.Group();
  torso.position.y = 0.08;
  hips.add(torso);

  const isShirtless = config.shirtStyle === 'shirtless';

  if (!isShirtless) {
    const chestMaterials: THREE.Material[] = [
      shirtPlainMat, // +X right side
      shirtPlainMat, // -X left side
      shirtPlainMat, // +Y top shoulders
      shirtPlainMat, // -Y bottom
      shirtFrontMat, // +Z front chest with photo print
      shirtFrontMat, // -Z back
    ];

    const chestGeo = new THREE.BoxGeometry(
      0.45 * torsoWidthScale,
      0.48,
      0.265 * torsoWidthScale
    );
    const chest = new THREE.Mesh(chestGeo, chestMaterials);
    chest.position.y = 0.25;
    chest.castShadow = true;
    chest.receiveShadow = true;
    torso.add(chest);

    // Flared 3D lower shirt hem overlapping the top of the shorts
    const hemGeo = new THREE.CylinderGeometry(
      0.245 * torsoWidthScale,
      0.265 * torsoWidthScale,
      0.09,
      16
    );
    hemGeo.scale(1.0, 1.0, 0.64);
    const hemMat =
      skinId === 'careca'
        ? new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.8 })
        : shirtPlainMat;
    const shirtHem = new THREE.Mesh(hemGeo, hemMat);
    shirtHem.position.y = 0.025;
    shirtHem.castShadow = true;
    torso.add(shirtHem);

    // 3D Crew/V-Neck Collar ring around the neck base
    const collarColor =
      skinId === 'yuri'
        ? 0x1d4ed8
        : skinId === 'careca'
        ? 0x16181d
        : skinId === 'ismael'
        ? 0xf3f5f8
        : config.shirtPrimary;
    const collarMat = new THREE.MeshStandardMaterial({
      color: collarColor,
      roughness: 0.75,
    });
    const collarGeo = new THREE.TorusGeometry(0.092, 0.022, 8, 20);
    collarGeo.rotateX(Math.PI / 2);
    const collar = new THREE.Mesh(collarGeo, collarMat);
    collar.position.set(0, 0.49, 0.005);
    torso.add(collar);
  } else {
    const chestGeo = new THREE.BoxGeometry(
      0.43 * torsoWidthScale,
      0.47,
      0.24 * torsoWidthScale
    );
    const chest = new THREE.Mesh(chestGeo, skinMat);
    chest.position.y = 0.25;
    chest.castShadow = true;
    torso.add(chest);
  }

  // Neck
  const neckGeo = new THREE.CylinderGeometry(0.072, 0.084, 0.1, 14);
  const neck = new THREE.Mesh(neckGeo, skinMat);
  neck.position.y = 0.52;
  torso.add(neck);

  // Head Group
  const head = new THREE.Group();
  head.position.y = 0.65;
  torso.add(head);

  const faceTex = createPlayerFaceTexture(skinId, config.skinColor);
  const faceFrontMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: faceTex,
    roughness: 0.58,
    metalness: 0.03,
  });

  const headMaterials: THREE.Material[] = [
    skinMat, // +X
    skinMat, // -X
    skinMat, // +Y
    skinMat, // -Y
    faceFrontMat, // +Z front face
    skinMat, // -Z back of head
  ];

  const headWidth =
    skinId === 'careca' ? 0.225 : skinId === 'ismael' ? 0.255 : 0.24;
  const headHeight =
    skinId === 'josue' || skinId === 'bode' ? 0.268 : 0.258;
  const headGeo = new THREE.BoxGeometry(headWidth, headHeight, 0.245);
  const headMesh = new THREE.Mesh(headGeo, headMaterials);
  headMesh.castShadow = true;
  head.add(headMesh);

  // Smooth rounded cranium dome
  const craniumGeo = new THREE.SphereGeometry(
    headWidth * 0.51,
    16,
    12,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.55
  );
  const cranium = new THREE.Mesh(craniumGeo, skinMat);
  cranium.position.y = headHeight * 0.34;
  head.add(cranium);

  // 3D Sculpted Nose
  const noseGeo = new THREE.ConeGeometry(0.026, 0.058, 8);
  noseGeo.rotateX(Math.PI / 2);
  const nose = new THREE.Mesh(noseGeo, skinMat);
  nose.position.set(0, -0.008, 0.138);
  head.add(nose);

  // 3D Ears
  const earGeo = new THREE.BoxGeometry(0.026, 0.068, 0.042);
  const leftEar = new THREE.Mesh(earGeo, skinMat);
  leftEar.position.set(headWidth * 0.52, -0.005, 0);
  const rightEar = new THREE.Mesh(earGeo, skinMat);
  rightEar.position.set(-headWidth * 0.52, -0.005, 0);
  head.add(leftEar, rightEar);

  // 3D Eyebrow ridges
  const browMat = new THREE.MeshStandardMaterial({
    color: 0x161210,
    roughness: 0.85,
  });
  const browGeo = new THREE.BoxGeometry(0.052, 0.014, 0.016);
  const leftBrow = new THREE.Mesh(browGeo, browMat);
  leftBrow.position.set(0.048, 0.042, 0.124);
  const rightBrow = new THREE.Mesh(browGeo, browMat);
  rightBrow.position.set(-0.048, 0.042, 0.124);
  head.add(leftBrow, rightBrow);

  // 3D Facial Hair (Josué's mustache + chin goatee; Careca & Ismael's mustache)
  if (skinId === 'josue') {
    const mustacheGeo = new THREE.BoxGeometry(0.082, 0.018, 0.02);
    const mustache = new THREE.Mesh(mustacheGeo, browMat);
    mustache.position.set(0, -0.046, 0.124);
    head.add(mustache);

    const goateeGeo = new THREE.BoxGeometry(0.068, 0.036, 0.028);
    const goatee = new THREE.Mesh(goateeGeo, browMat);
    goatee.position.set(0, -0.112, 0.116);
    head.add(goatee);
  } else if (skinId === 'careca' || skinId === 'ismael') {
    const mustacheGeo = new THREE.BoxGeometry(0.074, 0.013, 0.016);
    const mustache = new THREE.Mesh(mustacheGeo, browMat);
    mustache.position.set(0, -0.048, 0.123);
    head.add(mustache);
  }

  // Hair & Headgear identical to the reference photographs
  if (skinId === 'josue' || config.hairStyle === 'bucket_hat_josue') {
    // JOSUÉ'S ICONIC RED/WHITE/NAVY BUCKET HAT (Chapéu Pescador)
    const bucketGroup = new THREE.Group();
    bucketGroup.position.set(0, 0.095, 0);

    const redHatMat = new THREE.MeshStandardMaterial({
      color: 0xd94645,
      bumpMap: fabricBump,
      bumpScale: 0.004,
      roughness: 0.82,
    });
    const whiteBandMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.78,
    });
    const navyBlockMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.8,
    });

    // Sloped bucket hat brim (red/coral)
    const brimGeo = new THREE.CylinderGeometry(0.145, 0.215, 0.048, 24, 1, true);
    const brimMat = new THREE.MeshStandardMaterial({
      color: 0xd94645,
      side: THREE.DoubleSide,
      roughness: 0.82,
    });
    const brim = new THREE.Mesh(brimGeo, brimMat);
    brim.position.y = -0.01;
    brim.castShadow = true;
    bucketGroup.add(brim);

    // White middle stripe band
    const bandGeo = new THREE.CylinderGeometry(0.132, 0.144, 0.038, 24);
    const band = new THREE.Mesh(bandGeo, whiteBandMat);
    band.position.y = 0.025;
    bucketGroup.add(band);

    // Dark navy rectangular accent blocks on front of the white band
    for (const bx of [-0.045, 0.045]) {
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(0.038, 0.026, 0.015),
        navyBlockMat
      );
      block.position.set(bx, 0.025, 0.136);
      bucketGroup.add(block);
    }

    // Red top crown of the bucket hat
    const crownGeo = new THREE.CylinderGeometry(0.118, 0.132, 0.058, 24);
    const crown = new THREE.Mesh(crownGeo, redHatMat);
    crown.position.y = 0.07;
    crown.castShadow = true;
    bucketGroup.add(crown);

    // Subtle dark hair visible at temples under the hat
    const sideHairGeo = new THREE.BoxGeometry(headWidth + 0.01, 0.06, 0.18);
    const sideHair = new THREE.Mesh(sideHairGeo, hairMat);
    sideHair.position.set(0, -0.035, -0.02);
    bucketGroup.add(sideHair);

    head.add(bucketGroup);
  } else if (
    skinId === 'careca' ||
    config.hairStyle === 'bald' ||
    config.hairStyle === 'receding_careca'
  ) {
    // CARECA: Prominent high bald forehead/crown + ultra-short cropped dark hair on sides and back
    const backHair = new THREE.Mesh(
      new THREE.BoxGeometry(headWidth + 0.008, 0.12, 0.14),
      hairMat
    );
    backHair.position.set(0, 0.01, -0.06);
    head.add(backHair);

    const sideTempleGeo = new THREE.BoxGeometry(0.014, 0.09, 0.14);
    const leftSideHair = new THREE.Mesh(sideTempleGeo, hairMat);
    leftSideHair.position.set(headWidth * 0.5, 0.01, -0.03);
    const rightSideHair = new THREE.Mesh(sideTempleGeo, hairMat);
    rightSideHair.position.set(-headWidth * 0.5, 0.01, -0.03);
    head.add(leftSideHair, rightSideHair);
  } else if (
    config.hairStyle === 'cap_orange' ||
    config.hairStyle === 'cap_black'
  ) {
    const capColor = new THREE.MeshStandardMaterial({
      color: config.hairStyle === 'cap_orange' ? 0xea580c : 0x18181b,
      roughness: 0.7,
    });
    const capCrown = new THREE.Mesh(
      new THREE.SphereGeometry(0.145, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      capColor
    );
    capCrown.position.y = 0.05;
    head.add(capCrown);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.018, 0.13),
      capColor
    );
    visor.position.set(0, 0.06, 0.13);
    visor.rotation.x = 0.12;
    head.add(visor);
  } else if (skinId === 'yuri' || config.hairStyle === 'curly') {
    // YURI: Fuller wavy/fluffy dark hair on top and sides
    const topHair = new THREE.Mesh(
      new THREE.BoxGeometry(headWidth + 0.03, 0.095, 0.27),
      hairMat
    );
    topHair.position.set(0, 0.115, 0.005);
    head.add(topHair);

    const fringe = new THREE.Mesh(
      new THREE.BoxGeometry(headWidth + 0.02, 0.045, 0.06),
      hairMat
    );
    fringe.position.set(0, 0.085, 0.122);
    head.add(fringe);

    const backHair = new THREE.Mesh(
      new THREE.BoxGeometry(headWidth + 0.02, 0.17, 0.09),
      hairMat
    );
    backHair.position.set(0, 0.02, -0.095);
    head.add(backHair);
  } else {
    // BODE, ISMAEL, PRIMO, BICUDO, FELIPE: Authentic low buzz cut / mid-fade
    const topBuzz = new THREE.Mesh(
      new THREE.BoxGeometry(headWidth + 0.008, 0.068, 0.252),
      hairMat
    );
    topBuzz.position.set(0, 0.112, 0);
    head.add(topBuzz);

    const backBuzz = new THREE.Mesh(
      new THREE.BoxGeometry(headWidth + 0.004, 0.13, 0.075),
      hairMat
    );
    backBuzz.position.set(0, 0.035, -0.092);
    head.add(backBuzz);
  }

  // Helper to build a 3D hand with palm and fingers
  const buildHand = (sideSign: number): THREE.Group => {
    const handGroup = new THREE.Group();
    const palm = new THREE.Mesh(
      new THREE.BoxGeometry(
        0.072 * limbThicknessScale,
        0.075,
        0.042 * limbThicknessScale
      ),
      skinMat
    );
    palm.castShadow = true;
    handGroup.add(palm);

    const fingers = new THREE.Mesh(
      new THREE.BoxGeometry(
        0.068 * limbThicknessScale,
        0.052,
        0.036 * limbThicknessScale
      ),
      skinMat
    );
    fingers.position.y = -0.055;
    handGroup.add(fingers);

    const thumb = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.045, 0.026),
      skinMat
    );
    thumb.position.set(sideSign * -0.042, -0.015, 0.018);
    thumb.rotation.z = sideSign * 0.35;
    handGroup.add(thumb);

    return handGroup;
  };

  // Arms & 3D Sleeves
  const buildArm = (isLeft: boolean) => {
    const sideSign = isLeft ? 1 : -1;
    const shoulder = new THREE.Group();
    shoulder.position.set(sideSign * (0.275 * torsoWidthScale), 0.43, 0);
    torso.add(shoulder);

    let sleeveMat: THREE.Material = shirtPlainMat;
    if (skinId === 'careca') {
      // Careca's right arm (!isLeft) is RED; left arm (isLeft) has WHITE shoulder + BLACK sleeve + RED cuff
      sleeveMat = new THREE.MeshStandardMaterial({
        color: isLeft ? 0x16181d : 0xc92a2a,
        bumpMap: fabricBump,
        bumpScale: 0.004,
        roughness: 0.8,
      });
    } else if (skinId === 'josue') {
      sleeveMat = new THREE.MeshStandardMaterial({
        color: 0x6e7889,
        bumpMap: fabricBump,
        bumpScale: 0.004,
        roughness: 0.8,
      });
    } else if (skinId === 'bode') {
      sleeveMat = new THREE.MeshStandardMaterial({
        color: 0x222733,
        bumpMap: fabricBump,
        bumpScale: 0.004,
        roughness: 0.8,
      });
    } else if (skinId === 'ismael') {
      sleeveMat = new THREE.MeshStandardMaterial({
        color: 0xf3f5f8,
        bumpMap: fabricBump,
        bumpScale: 0.004,
        roughness: 0.78,
      });
    }

    if (!isShirtless) {
      const sleeveGeo = new THREE.CylinderGeometry(
        0.072 * limbThicknessScale,
        0.084 * limbThicknessScale,
        0.21,
        14
      );
      const sleeve = new THREE.Mesh(sleeveGeo, sleeveMat);
      sleeve.position.y = -0.095;
      sleeve.castShadow = true;
      shoulder.add(sleeve);

      // Careca's left shoulder white panel & red sleeve cuff trim from the photo
      if (skinId === 'careca' && isLeft) {
        const whiteCap = new THREE.Mesh(
          new THREE.CylinderGeometry(
            0.075 * limbThicknessScale,
            0.079 * limbThicknessScale,
            0.085,
            14
          ),
          new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.78 })
        );
        whiteCap.position.y = -0.038;
        shoulder.add(whiteCap);

        const redCuff = new THREE.Mesh(
          new THREE.CylinderGeometry(
            0.083 * limbThicknessScale,
            0.086 * limbThicknessScale,
            0.028,
            14
          ),
          new THREE.MeshStandardMaterial({ color: 0xc92a2a, roughness: 0.78 })
        );
        redCuff.position.y = -0.19;
        shoulder.add(redCuff);
      }

      if (skinId === 'yuri') {
        const blueCuff = new THREE.Mesh(
          new THREE.CylinderGeometry(
            0.082 * limbThicknessScale,
            0.085 * limbThicknessScale,
            0.022,
            14
          ),
          new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.75 })
        );
        blueCuff.position.y = -0.19;
        shoulder.add(blueCuff);
      }
    } else {
      const upperArmSkin = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.062 * limbThicknessScale,
          0.056 * limbThicknessScale,
          0.21,
          12
        ),
        skinMat
      );
      upperArmSkin.position.y = -0.095;
      upperArmSkin.castShadow = true;
      shoulder.add(upperArmSkin);
    }

    // Forearm (Ismael wears long white/grey UV sleeves on both forearms)
    const forearmMat =
      skinId === 'ismael'
        ? new THREE.MeshStandardMaterial({
            color: 0xdce2ec,
            bumpMap: fabricBump,
            bumpScale: 0.003,
            roughness: 0.72,
          })
        : skinMat;

    const forearm = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.056 * limbThicknessScale,
        0.046 * limbThicknessScale,
        0.25,
        12
      ),
      forearmMat
    );
    forearm.position.y = -0.31;
    forearm.castShadow = true;
    shoulder.add(forearm);

    // CARECA'S WHITE ATHLETIC BANDAGE/WRAP ("atadura branca") on his right forearm (!isLeft)
    if (skinId === 'careca' && !isLeft) {
      const bandageMat = new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        bumpMap: fabricBump,
        bumpScale: 0.006,
        roughness: 0.85,
      });
      const bandage = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.061 * limbThicknessScale,
          0.053 * limbThicknessScale,
          0.135,
          14
        ),
        bandageMat
      );
      bandage.position.y = -0.325;
      bandage.castShadow = true;
      shoulder.add(bandage);
    }

    // PRIMO / BICUDO'S BLACK WRISTBAND ("munhequeira preta") on left wrist
    if ((skinId === 'primo' || skinId === 'bicudo') && isLeft) {
      const wristBand = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.053 * limbThicknessScale,
          0.051 * limbThicknessScale,
          0.055,
          12
        ),
        new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.85 })
      );
      wristBand.position.y = -0.4;
      shoulder.add(wristBand);
    }

    const hand = buildHand(sideSign);
    hand.position.y = -0.46;
    shoulder.add(hand);

    return shoulder;
  };

  const leftShoulder = buildArm(true);
  const rightShoulder = buildArm(false);

  // Helper to build realistic barefoot or socked foot with 3D toes
  const buildFoot = (isLeft: boolean): THREE.Group => {
    const footGroup = new THREE.Group();

    // CARECA wears a BLACK SOCK on his RIGHT foot (!isLeft) and is BAREFOOT on his LEFT foot (isLeft)!
    const hasCarecaRightSock = skinId === 'careca' && !isLeft;

    if (hasCarecaRightSock) {
      const blackSockMat = new THREE.MeshStandardMaterial({
        color: 0x111318,
        bumpMap: fabricBump,
        bumpScale: 0.004,
        roughness: 0.88,
      });
      const sockCuff = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.058 * limbThicknessScale,
          0.054 * limbThicknessScale,
          0.14,
          12
        ),
        blackSockMat
      );
      sockCuff.position.set(0, 0.09, -0.02);
      sockCuff.castShadow = true;
      footGroup.add(sockCuff);

      const sockFoot = new THREE.Mesh(
        new THREE.BoxGeometry(0.106 * limbThicknessScale, 0.068, 0.235),
        blackSockMat
      );
      sockFoot.position.set(0, 0.032, 0.045);
      sockFoot.castShadow = true;
      footGroup.add(sockFoot);
      return footGroup;
    }

    const isBarefoot = config.barefoot;
    const footBaseMat = isBarefoot
      ? skinMat
      : new THREE.MeshStandardMaterial({
          color: config.bootColor || 0x111827,
          roughness: 0.65,
        });

    const footArch = new THREE.Mesh(
      new THREE.BoxGeometry(0.102 * limbThicknessScale, 0.062, 0.195),
      footBaseMat
    );
    footArch.position.set(0, 0.03, 0.028);
    footArch.castShadow = true;
    footGroup.add(footArch);

    // ISMAEL wears a BLACK OPEN-TOE/OPEN-HEEL ANKLE BRACE ("tornozeleira preta") on his RIGHT ankle/foot (!isLeft)
    if (skinId === 'ismael' && !isLeft) {
      const ankleBraceMat = new THREE.MeshStandardMaterial({
        color: 0x111318,
        bumpMap: fabricBump,
        bumpScale: 0.004,
        roughness: 0.85,
      });
      const ankleSleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.06 * limbThicknessScale,
          0.056 * limbThicknessScale,
          0.125,
          12
        ),
        ankleBraceMat
      );
      ankleSleeve.position.set(0, 0.09, -0.018);
      ankleSleeve.castShadow = true;
      footGroup.add(ankleSleeve);

      const midfootWrap = new THREE.Mesh(
        new THREE.BoxGeometry(0.108 * limbThicknessScale, 0.068, 0.11),
        ankleBraceMat
      );
      midfootWrap.position.set(0, 0.032, 0.025);
      footGroup.add(midfootWrap);
    }

    // 5 Sculpted 3D Toes for barefoot players
    if (isBarefoot) {
      const toeOffsets = [-0.036, -0.018, 0, 0.017, 0.033];
      const toeSizes = [0.021, 0.017, 0.016, 0.015, 0.014];
      toeOffsets.forEach((ox, idx) => {
        const xPos = (isLeft ? -ox : ox) * limbThicknessScale;
        const r = toeSizes[idx];
        const toe = new THREE.Mesh(
          new THREE.BoxGeometry(r, r * 0.85, r * 1.65),
          skinMat
        );
        toe.position.set(xPos, 0.02, 0.135 - idx * 0.004);
        footGroup.add(toe);
      });
    }

    return footGroup;
  };

  // Legs, 3D Flared Shorts Cuffs, Knees, and Accessories
  const buildLeg = (isLeft: boolean) => {
    const sideSign = isLeft ? 1 : -1;
    const hipJoint = new THREE.Group();
    hipJoint.position.set(sideSign * (0.122 * torsoWidthScale), -0.06, 0);
    hips.add(hipJoint);

    // 3D Flared Shorts Leg Cuff with real volume around the thigh
    const shortsLegGeo = new THREE.CylinderGeometry(
      0.096 * limbThicknessScale,
      0.112 * limbThicknessScale,
      0.27,
      14
    );
    const shortsLeg = new THREE.Mesh(shortsLegGeo, shortsMat);
    shortsLeg.position.y = -0.135;
    shortsLeg.castShadow = true;
    hipJoint.add(shortsLeg);

    // White athletic swoosh on left thigh for Ismael and Yuri
    if ((skinId === 'ismael' || skinId === 'yuri') && isLeft) {
      const logoPatch = new THREE.Mesh(
        new THREE.BoxGeometry(0.042, 0.016, 0.01),
        new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 })
      );
      logoPatch.position.set(0.02, -0.22, 0.106 * limbThicknessScale);
      logoPatch.rotation.z = -0.22;
      hipJoint.add(logoPatch);
    }

    // Exposed Lower Thigh above the knee
    const lowerThigh = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.074 * limbThicknessScale,
        0.066 * limbThicknessScale,
        0.16,
        12
      ),
      skinMat
    );
    lowerThigh.position.y = -0.29;
    lowerThigh.castShadow = true;
    hipJoint.add(lowerThigh);

    // Knee Joint
    const kneeJoint = new THREE.Group();
    kneeJoint.position.y = -0.37;
    hipJoint.add(kneeJoint);

    // ISMAEL'S BLACK & NEON-GREEN KNEE BRACE on his RIGHT knee (!isLeft)
    if (skinId === 'ismael' && !isLeft) {
      const braceTex = createKneeBraceTexture();
      const braceMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: braceTex,
        roughness: 0.78,
      });
      const kneeBrace = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.076 * limbThicknessScale,
          0.071 * limbThicknessScale,
          0.155,
          16
        ),
        braceMat
      );
      kneeBrace.position.y = -0.02;
      kneeBrace.castShadow = true;
      kneeJoint.add(kneeBrace);
    }

    // Muscular Calf / Shin
    const shin = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.066 * limbThicknessScale,
        0.048 * limbThicknessScale,
        0.38,
        12
      ),
      skinMat
    );
    shin.position.y = -0.2;
    shin.castShadow = true;
    kneeJoint.add(shin);

    // Foot at ankle
    const foot = buildFoot(isLeft);
    foot.position.set(0, -0.41, 0);
    kneeJoint.add(foot);

    return { hipJoint, kneeJoint };
  };

  const leftLeg = buildLeg(true);
  const rightLeg = buildLeg(false);

  return {
    root,
    hips,
    torso,
    head,
    leftShoulder,
    rightShoulder,
    leftHip: leftLeg.hipJoint,
    rightHip: rightLeg.hipJoint,
    leftKnee: leftLeg.kneeJoint,
    rightKnee: rightLeg.kneeJoint,
    selectionRing,
    celebrationStyle: config.celebrationStyle || 'yuri',
    heightScale,
  };
}

/**
 * Updates skeletal joint angles for walk, run, kick, pass, tackle, fall, header, and character celebrations.
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
  const ringMat = rig.selectionRing.material as THREE.MeshBasicMaterial;
  ringMat.opacity = isControlled ? 0.88 : 0.0;

  const hScale = rig.heightScale || 1.0;

  // Reset base transforms
  rig.hips.position.y = 0.88 * hScale;
  rig.hips.rotation.set(0, 0, 0);
  rig.torso.rotation.set(0, 0, 0);
  rig.head.rotation.set(0, 0, 0);
  rig.leftKnee.rotation.x = 0;
  rig.rightKnee.rotation.x = 0;

  if (animState === 'tackle') {
    rig.hips.position.y = 0.34 * hScale;
    rig.hips.rotation.x = -Math.PI / 2.5;
    rig.leftHip.rotation.x = -0.5;
    rig.rightHip.rotation.x = 0.4;
    rig.rightKnee.rotation.x = 0.9;
    rig.leftShoulder.rotation.x = -0.8;
    rig.rightShoulder.rotation.x = 0.6;
    return;
  }

  if (animState === 'fall') {
    rig.hips.position.y = 0.28 * hScale;
    rig.hips.rotation.x = Math.PI / 2.6;
    rig.leftShoulder.rotation.x = -0.6;
    rig.rightShoulder.rotation.x = -0.6;
    rig.leftHip.rotation.x = 0.25;
    rig.rightHip.rotation.x = -0.25;
    return;
  }

  if (animState === 'kick' || animState === 'pass') {
    const swing = Math.sin(Math.min(1, animTimer / 0.32) * Math.PI);
    rig.torso.rotation.x = -0.18 * swing;
    rig.rightHip.rotation.x = -1.22 * swing;
    rig.rightKnee.rotation.x = 0.25 * swing;
    rig.leftHip.rotation.x = 0.32 * swing;
    rig.leftShoulder.rotation.x = -0.85 * swing;
    rig.rightShoulder.rotation.x = 0.72 * swing;
    return;
  }

  if (animState === 'header') {
    const jump = Math.sin(Math.min(1, animTimer / 0.34) * Math.PI);
    rig.hips.position.y = (0.88 + jump * 0.34) * hScale;
    rig.torso.rotation.x = 0.32 * jump;
    rig.head.rotation.x = 0.25 * jump;
    rig.leftShoulder.rotation.x = -1.1 * jump;
    rig.rightShoulder.rotation.x = -1.1 * jump;
    return;
  }

  if (animState === 'celebrate') {
    const style = rig.celebrationStyle;

    if (style === 'yuri') {
      const dance = elapsedTime * 11;
      rig.hips.position.y =
        (0.88 + Math.abs(Math.sin(dance)) * 0.14) * hScale;
      rig.hips.rotation.y = Math.sin(dance * 0.5) * 0.35;
      rig.torso.rotation.z = Math.sin(dance) * 0.18;
      rig.leftShoulder.rotation.x = -2.2 + Math.sin(dance) * 0.5;
      rig.rightShoulder.rotation.x = -2.2 - Math.sin(dance) * 0.5;
      rig.leftHip.rotation.x = Math.sin(dance) * 0.55;
      rig.rightHip.rotation.x = -Math.sin(dance) * 0.55;
      rig.leftKnee.rotation.x = Math.max(0, Math.sin(dance) * 0.6);
      rig.rightKnee.rotation.x = Math.max(0, -Math.sin(dance) * 0.6);
      return;
    }

    if (style === 'josue') {
      const wave = elapsedTime * 8;
      rig.hips.position.y =
        (0.88 + Math.abs(Math.sin(wave)) * 0.08) * hScale;
      rig.torso.rotation.x = -0.25;
      rig.head.rotation.y = Math.sin(wave) * 0.45;
      rig.leftShoulder.rotation.x = -2.85 + Math.sin(wave * 1.5) * 0.25;
      rig.rightShoulder.rotation.x = -2.85 - Math.sin(wave * 1.5) * 0.25;
      rig.leftHip.rotation.x = Math.sin(wave) * 0.3;
      rig.rightHip.rotation.x = -Math.sin(wave) * 0.3;
      return;
    }

    if (style === 'careca') {
      const punch = elapsedTime * 14;
      rig.hips.position.y =
        (0.85 + Math.abs(Math.sin(punch * 0.5)) * 0.18) * hScale;
      rig.torso.rotation.x = 0.18;
      rig.torso.rotation.y = Math.sin(punch * 0.5) * 0.3;
      rig.rightShoulder.rotation.x = -2.6 + Math.sin(punch) * 0.6;
      rig.leftShoulder.rotation.x = -1.4 - Math.sin(punch) * 0.4;
      rig.leftHip.rotation.x = -0.35;
      rig.rightHip.rotation.x = 0.35;
      return;
    }

    if (style === 'bode') {
      const leap = Math.abs(Math.sin(elapsedTime * 6.5));
      rig.hips.position.y = (0.88 + leap * 0.38) * hScale;
      rig.torso.rotation.x = -0.22 * leap;
      rig.leftShoulder.rotation.x = -2.5 * leap;
      rig.rightShoulder.rotation.x = -2.5 * leap;
      rig.leftHip.rotation.x = -0.4 * leap;
      rig.rightHip.rotation.x = -0.4 * leap;
      rig.leftKnee.rotation.x = 0.7 * leap;
      rig.rightKnee.rotation.x = 0.7 * leap;
      return;
    }

    if (style === 'ismael') {
      const flex = elapsedTime * 9;
      rig.hips.position.y =
        (0.87 + Math.abs(Math.sin(flex)) * 0.12) * hScale;
      rig.torso.rotation.x = -0.18;
      rig.leftShoulder.rotation.x = -2.1 + Math.sin(flex) * 0.3;
      rig.rightShoulder.rotation.x = -2.1 + Math.sin(flex) * 0.3;
      rig.leftHip.rotation.x = -0.25;
      rig.rightHip.rotation.x = 0.25;
      return;
    }

    // Default / Rival celebration
    rig.hips.position.y =
      (0.88 + Math.abs(Math.sin(elapsedTime * 9)) * 0.2) * hScale;
    rig.leftShoulder.rotation.x = -2.7;
    rig.rightShoulder.rotation.x = -2.7;
    rig.leftHip.rotation.x = Math.sin(elapsedTime * 9) * 0.35;
    rig.rightHip.rotation.x = -Math.sin(elapsedTime * 9) * 0.35;
    return;
  }

  if (animState === 'walk' || animState === 'run') {
    const strideAmp = Math.min(0.95, 0.32 + speedRatio * 0.56);
    const s = Math.sin(stridePhase);
    const c = Math.cos(stridePhase);

    rig.hips.position.y = (0.88 + Math.abs(c) * 0.055) * hScale;
    rig.torso.rotation.x = Math.min(0.24, speedRatio * 0.18);
    rig.torso.rotation.y = s * 0.12;

    rig.leftHip.rotation.x = s * strideAmp;
    rig.rightHip.rotation.x = -s * strideAmp;

    rig.leftKnee.rotation.x = Math.max(0, -s * strideAmp * 0.9);
    rig.rightKnee.rotation.x = Math.max(0, s * strideAmp * 0.9);

    rig.leftShoulder.rotation.x = -s * strideAmp * 0.85;
    rig.rightShoulder.rotation.x = s * strideAmp * 0.85;
  } else {
    // Natural athletic idle breathing
    const breath = Math.sin(elapsedTime * 3.0);
    rig.hips.position.y = (0.88 + breath * 0.015) * hScale;
    rig.leftHip.rotation.x = 0.04;
    rig.rightHip.rotation.x = -0.04;
    rig.leftShoulder.rotation.x = breath * 0.05;
    rig.rightShoulder.rotation.x = -breath * 0.05;
  }
}
