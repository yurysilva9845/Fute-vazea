import * as THREE from 'three';
import {
  DEFAULT_PITCH,
  getTerrainHeightAt,
  VARZEA_PUDDLES,
} from './rules';
import {
  createBrickTexture,
  createPuddleWaterTexture,
  createSpectatorShirtTexture,
  createVarzeaDirtTextures,
} from './textures';

export interface ParticleBurstPool {
  spawnBurst: (
    x: number,
    y: number,
    z: number,
    kind: 'dust' | 'mud' | 'water',
    count?: number
  ) => void;
  update: (dt: number) => void;
}

export interface VarzeaWorldObjects {
  sceneGroup: THREE.Group;
  spectatorHead: THREE.Group;
  leftNetMesh: THREE.Mesh;
  rightNetMesh: THREE.Mesh;
  particles: ParticleBurstPool;
  triggerNetRipple: (side: 'left' | 'right') => void;
  updateEnvironment: (dt: number, ballPos: THREE.Vector3) => void;
}

/**
 * Constructs the complete 3D Várzea environment faithfully reproducing the attached reference photos:
 * - Irregular sandy-brown dirt pitch with footprints, mud patches, and reflective water puddles
 * - Proportional small 4v4 várzea goals with nets
 * - Red clay brick walls ("muros de tijolos vermelhos") and the tall half-plastered brick column
 * - Rustic crooked wooden stick fences ("cerca de varas de madeira rústica")
 * - Stacked red clay hollow bricks ("pilha de tijolos baianos empilhados") on the sideline
 * - Pair of black flip-flops ("chinelos pretos") on the sand
 * - Spectator sitting on the 4-legged wooden stool ("banquinho de madeira") in white "THAFEF" tank top & orange cap
 * - Two large leafy trees on the right edge of the pitch + banana palms & lush tropical greenery
 * - Rural Brazilian houses with clay tile roofs, utility poles & overhead wires
 */
export function buildVarzeaEnvironment(
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean
): VarzeaWorldObjects {
  const sceneGroup = new THREE.Group();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // 1. Irregular Dirt Ground Plane (64m x 46m) with real vertex displacement
  const groundW = 64;
  const groundD = 46;
  const groundGeo = new THREE.PlaneGeometry(groundW, groundD, 72, 52);
  groundGeo.rotateX(-Math.PI / 2);

  const posAttr = groundGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    const vy = getTerrainHeightAt(vx, vz);
    posAttr.setY(i, vy);
  }
  groundGeo.computeVertexNormals();

  const { colorMap, bumpMap, roughnessMap } = createVarzeaDirtTextures(maxAniso);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: colorMap,
    bumpMap,
    bumpScale: 0.045,
    roughnessMap,
    roughness: 0.92,
    metalness: 0.02,
  });

  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = !isSoftwareGl;
  sceneGroup.add(groundMesh);

  // 2. Reflective Water Puddles ("Poças de água espalhadas pelo campo")
  const puddleTex = createPuddleWaterTexture(maxAniso);
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: puddleTex,
    roughness: 0.08,
    metalness: 0.22,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  for (const puddle of VARZEA_PUDDLES) {
    const pGeo = new THREE.PlaneGeometry(2, 2);
    pGeo.rotateX(-Math.PI / 2);
    const pMesh = new THREE.Mesh(pGeo, puddleMat);
    const py = getTerrainHeightAt(puddle.x, puddle.z) + 0.022;
    pMesh.position.set(puddle.x, py, puddle.z);
    pMesh.rotation.y = puddle.rotation;
    pMesh.scale.set(puddle.rx * 1.12, 1, puddle.rz * 1.12);
    sceneGroup.add(pMesh);
  }

  // 3. Travinhas de Mini Campo ("Travinhas baixas e compactas de futebol de rua/várzea 4x4")
  const postMat = new THREE.MeshStandardMaterial({
    color: 0xe2ddd5, // cano de ferro/PVC pintado de branco desgastado pela terra
    roughness: 0.58,
    metalness: 0.28,
  });
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x9ca3af, // conexões / soldas nos cantos da travinha
    roughness: 0.65,
    metalness: 0.45,
  });
  const netMat = new THREE.MeshBasicMaterial({
    color: 0xf5f5f4,
    wireframe: true,
    transparent: true,
    opacity: 0.52,
  });

  const buildVarzeaGoal = (signX: -1 | 1) => {
    const goalGroup = new THREE.Group();
    const gx = signX * (DEFAULT_PITCH.width / 2);
    const halfZ = DEFAULT_PITCH.goalWidth / 2;
    const h = DEFAULT_PITCH.goalHeight; // 1.15m (travinha baixa)
    const d = DEFAULT_PITCH.goalDepth;  // 0.95m (profundidade compacta)
    const tubeRadius = 0.045;

    // Front Left & Right upright posts + corner joints + ground base bars + rear angled struts
    const postGeo = new THREE.CylinderGeometry(tubeRadius, tubeRadius, h, 12);
    const groundSideGeo = new THREE.CylinderGeometry(
      tubeRadius * 0.85,
      tubeRadius * 0.85,
      d,
      10
    );
    groundSideGeo.rotateZ(Math.PI / 2);

    const strutLen = Math.hypot(h, d);
    const strutGeo = new THREE.CylinderGeometry(
      tubeRadius * 0.78,
      tubeRadius * 0.78,
      strutLen,
      10
    );

    for (const sz of [-1, 1]) {
      // Front upright post
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(gx, h / 2, sz * halfZ);
      post.castShadow = !isSoftwareGl;
      goalGroup.add(post);

      // Top corner elbow joint
      const elbow = new THREE.Mesh(
        new THREE.SphereGeometry(tubeRadius * 1.28, 10, 10),
        jointMat
      );
      elbow.position.set(gx, h, sz * halfZ);
      goalGroup.add(elbow);

      // Ground side base tube extending backward
      const sideBase = new THREE.Mesh(groundSideGeo, postMat);
      sideBase.position.set(
        gx + signX * (d / 2),
        tubeRadius * 0.9,
        sz * halfZ
      );
      goalGroup.add(sideBase);

      // Angled rear support strut (from top corner down to rear ground corner)
      const backSupport = new THREE.Mesh(strutGeo, postMat);
      backSupport.position.set(gx + signX * (d * 0.5), h * 0.5, sz * halfZ);
      backSupport.rotation.z = signX * Math.atan2(d, h);
      backSupport.castShadow = !isSoftwareGl;
      goalGroup.add(backSupport);
    }

    // Front Crossbar ("travessão baixo da travinha")
    const crossbarGeo = new THREE.CylinderGeometry(
      tubeRadius,
      tubeRadius,
      DEFAULT_PITCH.goalWidth + tubeRadius * 1.5,
      12
    );
    crossbarGeo.rotateX(Math.PI / 2);
    const crossbar = new THREE.Mesh(crossbarGeo, postMat);
    crossbar.position.set(gx, h, 0);
    crossbar.castShadow = !isSoftwareGl;
    goalGroup.add(crossbar);

    // Rear ground base crossbar ("barra traseira no chão segurando a rede")
    const backGroundBarGeo = new THREE.CylinderGeometry(
      tubeRadius * 0.85,
      tubeRadius * 0.85,
      DEFAULT_PITCH.goalWidth + tubeRadius,
      10
    );
    backGroundBarGeo.rotateX(Math.PI / 2);
    const backGroundBar = new THREE.Mesh(backGroundBarGeo, jointMat);
    backGroundBar.position.set(gx + signX * d, tubeRadius * 0.9, 0);
    goalGroup.add(backGroundBar);

    // Sculpted 3D Net with natural sag/drape matching the sloped travinha profile
    const netGeo = new THREE.BoxGeometry(
      d,
      h,
      DEFAULT_PITCH.goalWidth,
      8,
      8,
      14
    );
    const netPos = netGeo.attributes.position;
    for (let i = 0; i < netPos.count; i++) {
      const lx = netPos.getX(i); // -d/2 to +d/2
      const ly = netPos.getY(i); // -h/2 to +h/2
      const lz = netPos.getZ(i); // -goalWidth/2 to +goalWidth/2

      // Progress from front of goal (0) to back of goal (1)
      const backProgress = THREE.MathUtils.clamp(
        (lx * signX + d / 2) / d,
        0,
        1
      );
      const heightRatio = THREE.MathUtils.clamp((ly + h / 2) / h, 0, 1);

      // Taper the back of the net along the angled rear struts + natural cloth sag
      const maxAllowedY = h * (1 - backProgress * 0.62) - h / 2;
      if (ly > maxAllowedY && backProgress > 0.15) {
        netPos.setY(i, THREE.MathUtils.lerp(ly, maxAllowedY, 0.85));
      }

      // Natural inward sag on the net mesh
      const centerZFactor = 1 - Math.pow(lz / halfZ, 2);
      const sagY =
        -0.06 * backProgress * (1 - backProgress) * centerZFactor * heightRatio;
      netPos.setY(i, netPos.getY(i) + sagY);
    }
    netGeo.computeVertexNormals();

    const netMesh = new THREE.Mesh(netGeo, netMat);
    netMesh.position.set(gx + signX * (d / 2), h / 2, 0);
    goalGroup.add(netMesh);

    sceneGroup.add(goalGroup);
    return netMesh;
  };

  const leftNetMesh = buildVarzeaGoal(-1);
  const rightNetMesh = buildVarzeaGoal(1);

  // 4. Red Brick Walls ("Muros de tijolos vermelhos nas laterais") & Iconic Tall Brick Pillar
  const brickTex = createBrickTexture(maxAniso);
  const brickWallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: brickTex,
    roughness: 0.88,
    metalness: 0.02,
  });
  const plasterMat = new THREE.MeshStandardMaterial({
    color: 0xc4b5a3,
    roughness: 0.86,
    metalness: 0.02,
  });

  // Back-left red brick wall & house structure (seen in photos 1, 2, 4)
  const leftBackWall = new THREE.Mesh(new THREE.BoxGeometry(11, 2.7, 0.35), brickWallMat);
  leftBackWall.position.set(-16.5, 1.35, -14.2);
  leftBackWall.castShadow = !isSoftwareGl;
  sceneGroup.add(leftBackWall);

  // Dark gray unfinished concrete wall next to it
  const darkWallMat = new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.9 });
  const midBackWall = new THREE.Mesh(new THREE.BoxGeometry(8.5, 1.9, 0.3), darkWallMat);
  midBackWall.position.set(-8.5, 0.95, -14.5);
  sceneGroup.add(midBackWall);

  // Iconic tall brick pillar with beige plastered lower half (center-left background of photos 1, 2, 4)
  const pillarGroup = new THREE.Group();
  pillarGroup.position.set(-3.8, 0, -13.6);
  const pillarBottom = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.1, 0.85), plasterMat);
  pillarBottom.position.y = 1.05;
  pillarGroup.add(pillarBottom);
  const pillarTop = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.5, 0.82), brickWallMat);
  pillarTop.position.y = 2.85;
  pillarGroup.add(pillarTop);
  sceneGroup.add(pillarGroup);

  // Right-side red brick wall behind the two large trees (photos 1, 2, 4)
  const rightBrickWall = new THREE.Mesh(new THREE.BoxGeometry(16, 2.35, 0.35), brickWallMat);
  rightBrickWall.position.set(14.5, 1.175, -12.5);
  rightBrickWall.rotation.y = -0.22;
  rightBrickWall.castShadow = !isSoftwareGl;
  sceneGroup.add(rightBrickWall);

  // Right sideline brick wall continuation
  const rightSideWall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.3, 18), brickWallMat);
  rightSideWall.position.set(22.2, 1.15, -2.0);
  sceneGroup.add(rightSideWall);

  // 5. Stacked Terracotta Hollow Bricks ("Pilha de tijolos baianos vermelhos empilhados")
  // Seen prominently in photos 3 & 5 on the sideline!
  const buildBrickStack = (bx: number, bz: number) => {
    const stackGroup = new THREE.Group();
    stackGroup.position.set(bx, getTerrainHeightAt(bx, bz), bz);

    const terracottaMat = new THREE.MeshStandardMaterial({
      color: 0xc85a32,
      roughness: 0.84,
      metalness: 0.03,
    });
    const darkGrooveMat = new THREE.MeshStandardMaterial({
      color: 0x7c2d12,
      roughness: 0.9,
    });

    // Base block of stacked bricks + individual top bricks for 3D silhouette
    const coreStack = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.05, 1.15), brickWallMat);
    coreStack.position.y = 0.525;
    coreStack.castShadow = !isSoftwareGl;
    stackGroup.add(coreStack);

    const singleBrickGeo = new THREE.BoxGeometry(0.32, 0.19, 0.16);
    for (let i = 0; i < 14; i++) {
      const b = new THREE.Mesh(singleBrickGeo, i % 3 === 0 ? darkGrooveMat : terracottaMat);
      b.position.set(
        ( (i * 37) % 10 - 4.5 ) * 0.19,
        1.14 + (i % 2) * 0.18,
        ( (i * 19) % 5 - 2 ) * 0.2
      );
      b.rotation.y = ((i % 3) - 1) * 0.08;
      stackGroup.add(b);
    }

    sceneGroup.add(stackGroup);
  };

  buildBrickStack(12.8, 11.8);
  buildBrickStack(-14.2, -10.8);

  // 6. Rustic Crooked Wooden Stick Fence ("Cercas rústicas de madeira")
  // Using InstancedMesh for > 120 crooked vertical wooden fence stakes around the perimeter
  const stakeGeo = new THREE.CylinderGeometry(0.038, 0.05, 1.75, 6);
  const woodFenceMat = new THREE.MeshStandardMaterial({
    color: 0x6e5a47,
    roughness: 0.92,
    metalness: 0.01,
  });

  const fencePositions: Array<{ x: number; z: number; tiltX: number; tiltZ: number; scaleY: number }> = [];
  // Back fence line
  for (let x = -20; x <= 18; x += 0.42) {
    fencePositions.push({
      x,
      z: -13.8 + Math.sin(x * 0.5) * 0.15,
      tiltX: Math.sin(x * 3.1) * 0.09,
      tiltZ: Math.cos(x * 2.7) * 0.11,
      scaleY: 0.85 + Math.abs(Math.sin(x * 1.9)) * 0.35,
    });
  }
  // Left fence line
  for (let z = -13; z <= 13; z += 0.48) {
    fencePositions.push({
      x: -20.5 + Math.cos(z * 0.4) * 0.15,
      z,
      tiltX: Math.cos(z * 2.3) * 0.1,
      tiltZ: Math.sin(z * 3.5) * 0.09,
      scaleY: 0.85 + Math.abs(Math.cos(z * 1.7)) * 0.32,
    });
  }

  const fenceInstanced = new THREE.InstancedMesh(stakeGeo, woodFenceMat, fencePositions.length);
  const dummy = new THREE.Object3D();
  fencePositions.forEach((fp, idx) => {
    dummy.position.set(fp.x, 0.85 * fp.scaleY, fp.z);
    dummy.rotation.set(fp.tiltX, idx * 0.4, fp.tiltZ);
    dummy.scale.set(1, fp.scaleY, 1);
    dummy.updateMatrix();
    fenceInstanced.setMatrixAt(idx, dummy.matrix);
  });
  fenceInstanced.instanceMatrix.needsUpdate = true;
  fenceInstanced.computeBoundingSphere();
  sceneGroup.add(fenceInstanced);

  // Horizontal rustic fence rails / wire binding
  const railMat = new THREE.MeshStandardMaterial({ color: 0x5c4938, roughness: 0.9 });
  const backRail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 38, 6), railMat);
  backRail.rotation.z = Math.PI / 2;
  backRail.position.set(-1, 1.15, -13.8);
  sceneGroup.add(backRail);

  // Leaning gray fiber-cement roof tiles against the fence (seen in photo 5)
  const tileSlabMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.85 });
  for (let i = 0; i < 5; i++) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.95, 0.04), tileSlabMat);
    slab.position.set(1.5 + i * 0.85, 0.45, -13.3);
    slab.rotation.x = -0.32;
    slab.rotation.y = (i - 2) * 0.08;
    sceneGroup.add(slab);
  }

  // 7. Large Leafy Trees on the Right Edge of the Field ("Árvores grandes nas proximidades do campo")
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.92 });
  const canopyMat1 = new THREE.MeshStandardMaterial({ color: 0x2d5a27, roughness: 0.82 });
  const canopyMat2 = new THREE.MeshStandardMaterial({ color: 0x3a6b31, roughness: 0.78 });

  const buildLargeTree = (tx: number, tz: number, scale = 1) => {
    const treeGroup = new THREE.Group();
    treeGroup.position.set(tx, getTerrainHeightAt(tx, tz), tz);

    // Main trunk + secondary branches
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.36, 3.8, 10), trunkMat);
    trunk.position.y = 1.9;
    trunk.rotation.z = 0.05;
    trunk.castShadow = !isSoftwareGl;
    treeGroup.add(trunk);

    for (const bSide of [-1, 1]) {
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 2.0, 8), trunkMat);
      branch.position.set(bSide * 0.55, 3.5, 0.2 * bSide);
      branch.rotation.z = -bSide * 0.48;
      treeGroup.add(branch);
    }

    // Multi-cluster lush canopy
    const clusters = [
      { x: 0, y: 5.2, z: 0, r: 2.3, mat: canopyMat1 },
      { x: -1.4, y: 4.6, z: 0.6, r: 1.75, mat: canopyMat2 },
      { x: 1.5, y: 4.7, z: -0.5, r: 1.8, mat: canopyMat2 },
      { x: 0.3, y: 4.3, z: 1.4, r: 1.65, mat: canopyMat1 },
      { x: -0.6, y: 5.6, z: -1.1, r: 1.7, mat: canopyMat2 },
    ];
    for (const c of clusters) {
      const foliage = new THREE.Mesh(new THREE.DodecahedronGeometry(c.r, 1), c.mat);
      foliage.position.set(c.x, c.y, c.z);
      foliage.scale.set(1.15, 0.82, 1.1);
      foliage.castShadow = !isSoftwareGl;
      treeGroup.add(foliage);
    }

    treeGroup.scale.setScalar(scale);
    sceneGroup.add(treeGroup);
  };

  // Two prominent trees on the right-back edge (matching photos 1, 2, 4)
  buildLargeTree(9.2, -9.8, 1.05);
  buildLargeTree(13.6, -9.2, 0.95);
  // Background trees around the community
  buildLargeTree(-12.5, -16.5, 1.15);
  buildLargeTree(2.0, -17.0, 1.2);
  buildLargeTree(-19.0, 6.5, 1.0);
  buildLargeTree(18.5, 8.5, 1.05);

  // Grass & scrub bush belt behind the rustic fence ("Vegetação e mato ao redor")
  const bushGeo = new THREE.DodecahedronGeometry(0.85, 1);
  const bushCount = 65;
  const bushInstanced = new THREE.InstancedMesh(bushGeo, canopyMat2, bushCount);
  for (let i = 0; i < bushCount; i++) {
    const angle = (i / bushCount) * Math.PI * 1.4 - Math.PI * 1.15;
    const dist = 14.5 + (i % 4) * 1.6;
    const bx = Math.cos(angle) * (dist * 1.35);
    const bz = Math.sin(angle) * dist - 2.0;
    dummy.position.set(bx, 0.45, bz);
    dummy.rotation.set(0, i * 1.1, 0);
    dummy.scale.set(1.2 + (i % 3) * 0.3, 0.7 + (i % 2) * 0.3, 1.1);
    dummy.updateMatrix();
    bushInstanced.setMatrixAt(i, dummy.matrix);
  }
  bushInstanced.instanceMatrix.needsUpdate = true;
  bushInstanced.computeBoundingSphere();
  sceneGroup.add(bushInstanced);

  // 8. Simple Rural Brazilian Houses ("Casas simples de interior ao redor")
  const buildRuralHouse = (hx: number, hz: number, rotY: number, wallColor: number) => {
    const house = new THREE.Group();
    house.position.set(hx, 0, hz);
    house.rotation.y = rotY;

    const wMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.88 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xa84a2b, roughness: 0.82 });
    const winMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(6.5, 3.0, 5.2), wMat);
    body.position.y = 1.5;
    house.add(body);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(5.0, 1.6, 4), roofMat);
    roof.position.y = 3.8;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.15, 1, 0.95);
    house.add(roof);

    // Door & windows
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.0, 0.1), winMat);
    door.position.set(-1.2, 1.0, 2.61);
    house.add(door);

    const win1 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.95, 0.1), winMat);
    win1.position.set(1.2, 1.65, 2.61);
    house.add(win1);

    sceneGroup.add(house);
  };

  buildRuralHouse(-7.5, -19.5, 0.08, 0xe7e5e4);
  buildRuralHouse(-18.5, -18.0, 0.25, 0xd6a682);
  buildRuralHouse(16.0, -18.5, -0.18, 0xd6d3d1);

  // 9. Utility Poles & Power Wires ("Postes de energia e fios ao fundo")
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.8 });
  const poleCoords = [
    [-16.0, -18.5],
    [-1.2, -19.0],
    [14.0, -18.5],
  ];
  for (const [px, pz] of poleCoords) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 6.8, 8), poleMat);
    pole.position.set(px, 3.4, pz);
    sceneGroup.add(pole);

    const crossarm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.1), poleMat);
    crossarm.position.set(px, 6.5, pz);
    sceneGroup.add(crossarm);
  }

  // Catenary power wires connecting the poles
  const wireMat = new THREE.LineBasicMaterial({
    color: 0x3f3f46,
    transparent: true,
    opacity: 0.55,
  });
  for (let w = 0; w < 2; w++) {
    const zOffset = (w - 0.5) * 0.5;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-16.0, 6.5, -18.5 + zOffset),
      new THREE.Vector3(-8.6, 6.05, -18.75 + zOffset),
      new THREE.Vector3(-1.2, 6.5, -19.0 + zOffset),
      new THREE.Vector3(6.4, 6.05, -18.75 + zOffset),
      new THREE.Vector3(14.0, 6.5, -18.5 + zOffset),
    ]);
    const wireGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
    const wireLine = new THREE.Line(wireGeo, wireMat);
    sceneGroup.add(wireLine);
  }

  // 10. Foreground Sideline Props from the Reference Photos:
  // (A) The pair of black flip-flops ("chinelos pretos") on the sand (Photo 2 bottom-right)
  const sandalMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.75 });
  const buildFlipFlop = (fx: number, fz: number, rotY: number) => {
    const sandal = new THREE.Group();
    sandal.position.set(fx, getTerrainHeightAt(fx, fz) + 0.02, fz);
    sandal.rotation.y = rotY;
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.022, 0.29), sandalMat);
    sandal.add(sole);
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 12, Math.PI), sandalMat);
    strap.position.set(0, 0.015, 0.02);
    strap.rotation.x = -0.35;
    sandal.add(strap);
    sceneGroup.add(sandal);
  };
  buildFlipFlop(9.5, 11.4, 0.45);
  buildFlipFlop(9.9, 11.6, 1.35);

  // (B) The Iconic Spectator sitting on the 4-legged wooden stool ("banquinho de madeira")
  // wearing the white "THAFEF" sleeveless tank top, white shorts, and orange cap (Photo 5)!
  const spectatorGroup = new THREE.Group();
  const specX = -4.2;
  const specZ = 12.6;
  spectatorGroup.position.set(specX, getTerrainHeightAt(specX, specZ), specZ);
  spectatorGroup.rotation.y = Math.PI; // facing the pitch (-Z)

  // Wooden 4-legged stool ("banquinho")
  const stoolMat = new THREE.MeshStandardMaterial({ color: 0x9a5b25, roughness: 0.65 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.045, 0.34), stoolMat);
  seat.position.y = 0.42;
  spectatorGroup.add(seat);

  for (const lx of [-0.15, 0.15]) {
    for (const lz of [-0.12, 0.12]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.42, 0.045), stoolMat);
      leg.position.set(lx, 0.21, lz);
      leg.rotation.z = lx * -0.18;
      leg.rotation.x = lz * 0.18;
      spectatorGroup.add(leg);
    }
  }

  // Spectator body seated on stool
  const specSkinMat = new THREE.MeshStandardMaterial({ color: 0x8d5837, roughness: 0.65 });
  const specShirtTex = createSpectatorShirtTexture();
  const specShirtMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: specShirtTex,
    roughness: 0.78,
  });
  const specShortsMat = new THREE.MeshStandardMaterial({ color: 0xe7e5e4, roughness: 0.8 });

  const specTorso = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.56, 14), specShirtMat);
  specTorso.position.set(0, 0.74, -0.02);
  specTorso.rotation.x = 0.16; // leaning slightly forward watching the match
  specTorso.scale.set(1.12, 1, 0.76);
  spectatorGroup.add(specTorso);

  const specHeadGroup = new THREE.Group();
  specHeadGroup.position.set(0, 1.12, 0.05);
  spectatorGroup.add(specHeadGroup);

  const specHead = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 14), specSkinMat);
  specHeadGroup.add(specHead);

  // Orange cap ("boné laranja")
  const orangeCapMat = new THREE.MeshStandardMaterial({ color: 0xd96b27, roughness: 0.7 });
  const capDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    orangeCapMat
  );
  capDome.position.y = 0.02;
  specHeadGroup.add(capDome);

  // Seated legs & arms resting on knees
  for (const side of [-1, 1]) {
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.42, 10), specShortsMat);
    thigh.position.set(side * 0.13, 0.48, 0.18);
    thigh.rotation.x = Math.PI / 2 - 0.15;
    spectatorGroup.add(thigh);

    const calf = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.42, 10), specSkinMat);
    calf.position.set(side * 0.14, 0.22, 0.36);
    spectatorGroup.add(calf);

    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.038, 0.44, 10), specSkinMat);
    arm.position.set(side * 0.22, 0.72, 0.14);
    arm.rotation.x = 0.55;
    spectatorGroup.add(arm);
  }

  sceneGroup.add(spectatorGroup);

  // 11. Zero-GC Pooled Particle System for Dust, Mud Splatters & Water Puddle Drops
  const maxParticles = 140;
  const partGeo = new THREE.DodecahedronGeometry(0.075, 0);
  const partMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.05,
  });
  const partInstanced = new THREE.InstancedMesh(partGeo, partMat, maxParticles);
  partInstanced.frustumCulled = false;

  const pX = new Float32Array(maxParticles);
  const pY = new Float32Array(maxParticles);
  const pZ = new Float32Array(maxParticles);
  const pVX = new Float32Array(maxParticles);
  const pVY = new Float32Array(maxParticles);
  const pVZ = new Float32Array(maxParticles);
  const pLife = new Float32Array(maxParticles);
  const pMaxLife = new Float32Array(maxParticles);
  const pScale = new Float32Array(maxParticles);

  const colorDust = new THREE.Color(0xcab092);
  const colorMud = new THREE.Color(0x523a26);
  const colorWater = new THREE.Color(0xcbd5e1);
  const pObj = new THREE.Object3D();

  // Initialize all off-screen
  for (let i = 0; i < maxParticles; i++) {
    pObj.position.set(0, -10, 0);
    pObj.scale.setScalar(0.001);
    pObj.updateMatrix();
    partInstanced.setMatrixAt(i, pObj.matrix);
    partInstanced.setColorAt(i, colorDust);
  }
  sceneGroup.add(partInstanced);

  let ringCursor = 0;

  const particles: ParticleBurstPool = {
    spawnBurst(x, y, z, kind, count = 6) {
      const col = kind === 'water' ? colorWater : kind === 'mud' ? colorMud : colorDust;
      for (let c = 0; c < count; c++) {
        const idx = ringCursor;
        ringCursor = (ringCursor + 1) % maxParticles;

        const angle = Math.random() * Math.PI * 2;
        const speed = 0.6 + Math.random() * 2.4;
        pX[idx] = x + (Math.random() - 0.5) * 0.25;
        pY[idx] = y + 0.05;
        pZ[idx] = z + (Math.random() - 0.5) * 0.25;
        pVX[idx] = Math.cos(angle) * speed;
        pVY[idx] = (kind === 'dust' ? 0.9 : 1.8) + Math.random() * 1.8;
        pVZ[idx] = Math.sin(angle) * speed;
        pMaxLife[idx] = 0.35 + Math.random() * 0.35;
        pLife[idx] = pMaxLife[idx];
        pScale[idx] = kind === 'dust' ? 1.15 : 0.85;

        partInstanced.setColorAt(idx, col);
      }
      if (partInstanced.instanceColor) {
        partInstanced.instanceColor.needsUpdate = true;
      }
    },
    update(dt) {
      let anyActive = false;
      for (let i = 0; i < maxParticles; i++) {
        if (pLife[i] <= 0) continue;
        anyActive = true;
        pLife[i] -= dt;
        if (pLife[i] <= 0) {
          pObj.position.set(0, -10, 0);
          pObj.scale.setScalar(0.001);
          pObj.updateMatrix();
          partInstanced.setMatrixAt(i, pObj.matrix);
          continue;
        }
        pVY[i] -= 9.8 * dt;
        pX[i] += pVX[i] * dt;
        pY[i] += pVY[i] * dt;
        pZ[i] += pVZ[i] * dt;

        const lifeRatio = pLife[i] / pMaxLife[i];
        pObj.position.set(pX[i], Math.max(0.02, pY[i]), pZ[i]);
        pObj.scale.setScalar(pScale[i] * lifeRatio);
        pObj.updateMatrix();
        partInstanced.setMatrixAt(i, pObj.matrix);
      }
      if (anyActive) {
        partInstanced.instanceMatrix.needsUpdate = true;
      }
    },
  };

  let leftRippleTimer = 0;
  let rightRippleTimer = 0;

  return {
    sceneGroup,
    spectatorHead: specHeadGroup,
    leftNetMesh,
    rightNetMesh,
    particles,
    triggerNetRipple(side) {
      if (side === 'left') leftRippleTimer = 0.7;
      else rightRippleTimer = 0.7;
    },
    updateEnvironment(dt, ballPos) {
      particles.update(dt);

      // Spectator turns his head slightly to watch the ball on the field
      const targetYaw = THREE.MathUtils.clamp(-ballPos.x * 0.035, -0.55, 0.55);
      specHeadGroup.rotation.y = THREE.MathUtils.damp(
        specHeadGroup.rotation.y,
        targetYaw,
        5,
        dt
      );

      // Goal net ripple animation when a goal is scored
      if (leftRippleTimer > 0) {
        leftRippleTimer = Math.max(0, leftRippleTimer - dt);
        const s = 1 + Math.sin(leftRippleTimer * 28) * 0.12 * leftRippleTimer;
        leftNetMesh.scale.set(s, 1, s);
      } else {
        leftNetMesh.scale.set(1, 1, 1);
      }

      if (rightRippleTimer > 0) {
        rightRippleTimer = Math.max(0, rightRippleTimer - dt);
        const s = 1 + Math.sin(rightRippleTimer * 28) * 0.12 * rightRippleTimer;
        rightNetMesh.scale.set(s, 1, s);
      } else {
        rightNetMesh.scale.set(1, 1, 1);
      }
    },
  };
}
