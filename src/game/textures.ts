import * as THREE from 'three';
import { DEFAULT_PITCH, VARZEA_MUD_ZONES, VARZEA_PUDDLES } from './rules';

/**
 * Generates the main high-detail procedural dirt & sand texture matching the reference photo:
 * - Warm sandy clay base (#b8997a to #9e7d5e)
 * - Darker wet mud patches (#6d523b)
 * - Scratched dirt field lines (subtle, worn in the sand)
 * - Hundreds of barefoot & boot footprints scattered in the play area
 */
export function createVarzeaDirtTextures(maxAnisotropy = 4): {
  colorMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const width = 1024;
  const height = 1024;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = width;
  roughCanvas.height = height;
  const rCtx = roughCanvas.getContext('2d')!;

  // 1. Base sandy earth fill matching the exact photo color tone
  ctx.fillStyle = '#b99b7d';
  ctx.fillRect(0, 0, width, height);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, width, height);

  rCtx.fillStyle = '#e5e5e5'; // High roughness for dry sand
  rCtx.fillRect(0, 0, width, height);

  // World plane is 64m x 46m centered at (0,0)
  const worldW = 64;
  const worldD = 46;
  const worldToUV = (wx: number, wz: number) => ({
    u: ((wx + worldW / 2) / worldW) * width,
    v: ((wz + worldD / 2) / worldD) * height,
  });

  // Deterministic pseudo-random helper so terrain looks consistent
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  // 2. Organic sand/soil mottling & coarse patches
  for (let i = 0; i < 2600; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const r = 4 + rand() * 26;
    const shade = rand();
    if (shade < 0.35) {
      ctx.fillStyle = 'rgba(124, 93, 66, 0.18)';
      bCtx.fillStyle = 'rgba(90, 90, 90, 0.18)';
    } else if (shade < 0.7) {
      ctx.fillStyle = 'rgba(206, 179, 150, 0.16)';
      bCtx.fillStyle = 'rgba(165, 165, 165, 0.16)';
    } else {
      ctx.fillStyle = 'rgba(98, 72, 49, 0.16)';
      bCtx.fillStyle = 'rgba(70, 70, 70, 0.2)';
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    bCtx.beginPath();
    bCtx.arc(x, y, r * 0.8, 0, Math.PI * 2);
    bCtx.fill();
  }

  // 3. Dark mud zones ("Áreas de lama mais escura" e entorno das poças)
  for (const mud of VARZEA_MUD_ZONES) {
    const { u, v } = worldToUV(mud.x, mud.z);
    const radPx = (mud.radius / worldW) * width * 1.25;
    const grad = ctx.createRadialGradient(u, v, radPx * 0.15, u, v, radPx);
    grad.addColorStop(0, 'rgba(72, 53, 37, 0.86)');
    grad.addColorStop(0.55, 'rgba(92, 68, 48, 0.58)');
    grad.addColorStop(1, 'rgba(115, 88, 64, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(u, v, radPx, 0, Math.PI * 2);
    ctx.fill();

    // Lower roughness (wetter sheen) in mud
    const rGrad = rCtx.createRadialGradient(u, v, radPx * 0.1, u, v, radPx);
    rGrad.addColorStop(0, 'rgba(65, 65, 65, 0.85)');
    rGrad.addColorStop(1, 'rgba(220, 220, 220, 0)');
    rCtx.fillStyle = rGrad;
    rCtx.beginPath();
    rCtx.arc(u, v, radPx, 0, Math.PI * 2);
    rCtx.fill();
  }

  // Dark wet basin under each puddle
  for (const puddle of VARZEA_PUDDLES) {
    const { u, v } = worldToUV(puddle.x, puddle.z);
    const rxPx = (puddle.rx / worldW) * width * 1.25;
    const rzPx = (puddle.rz / worldD) * height * 1.25;
    ctx.save();
    ctx.translate(u, v);
    ctx.rotate(puddle.rotation);
    ctx.scale(1, rzPx / rxPx);
    const pGrad = ctx.createRadialGradient(0, 0, rxPx * 0.1, 0, 0, rxPx);
    pGrad.addColorStop(0, 'rgba(58, 44, 31, 0.92)');
    pGrad.addColorStop(0.75, 'rgba(82, 62, 45, 0.68)');
    pGrad.addColorStop(1, 'rgba(115, 88, 64, 0)');
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.arc(0, 0, rxPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 4. Subtle scratched lines in the dirt ("Linhas de marcação discretas, feitas na terra")
  const topLeft = worldToUV(-DEFAULT_PITCH.width / 2, -DEFAULT_PITCH.depth / 2);
  const botRight = worldToUV(DEFAULT_PITCH.width / 2, DEFAULT_PITCH.depth / 2);
  const pitchW = botRight.u - topLeft.u;
  const pitchH = botRight.v - topLeft.v;
  const midU = (topLeft.u + botRight.u) / 2;
  const midV = (topLeft.v + botRight.v) / 2;

  ctx.save();
  ctx.strokeStyle = 'rgba(225, 204, 179, 0.36)';
  ctx.lineWidth = 3.5;
  ctx.setLineDash([12, 7, 6, 6]);

  // Outer rectangle scratched in the dirt
  ctx.strokeRect(topLeft.u, topLeft.v, pitchW, pitchH);

  // Halfway line
  ctx.beginPath();
  ctx.moveTo(midU, topLeft.v);
  ctx.lineTo(midU, botRight.v);
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(midU, midV, (3.2 / worldW) * width, 0, Math.PI * 2);
  ctx.stroke();

  // Small goal boxes ("Pequena área de gol")
  const boxW = (3.8 / worldW) * width;
  const boxH = (6.8 / worldD) * height;
  ctx.strokeRect(topLeft.u, midV - boxH / 2, boxW, boxH);
  ctx.strokeRect(botRight.u - boxW, midV - boxH / 2, boxW, boxH);
  ctx.restore();

  // 5. Footprints, drag marks & pebbles ("Marcas de pegadas e movimentação dos jogadores")
  for (let i = 0; i < 3400; i++) {
    const wx = (rand() - 0.5) * (DEFAULT_PITCH.width + 6);
    const wz = (rand() - 0.5) * (DEFAULT_PITCH.depth + 5);
    const { u, v } = worldToUV(wx, wz);
    const angle = rand() * Math.PI * 2;

    ctx.save();
    ctx.translate(u, v);
    ctx.rotate(angle);
    ctx.fillStyle = rand() > 0.4 ? 'rgba(88, 64, 44, 0.36)' : 'rgba(218, 192, 162, 0.28)';
    ctx.fillRect(-3.5, -1.5, 7, 3);
    ctx.restore();

    bCtx.save();
    bCtx.translate(u, v);
    bCtx.rotate(angle);
    bCtx.fillStyle = 'rgba(45, 45, 45, 0.45)';
    bCtx.fillRect(-3.5, -1.5, 7, 3);
    bCtx.restore();
  }

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.anisotropy = maxAnisotropy;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.anisotropy = maxAnisotropy;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.anisotropy = maxAnisotropy;

  return { colorMap, bumpMap, roughnessMap };
}

/**
 * Generates an organic, soft-edged muddy water puddle texture reflecting the overcast sky and trees,
 * eliminating hard geometric oval edges.
 */
export function createPuddleWaterTexture(maxAnisotropy = 4): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 256, 256);

  // Soft radial alpha + sky/mud reflection gradient
  const grad = ctx.createRadialGradient(128, 128, 18, 128, 128, 120);
  grad.addColorStop(0, 'rgba(138, 154, 164, 0.88)'); // overcast sky reflection in center
  grad.addColorStop(0.55, 'rgba(116, 124, 122, 0.78)');
  grad.addColorStop(0.82, 'rgba(82, 64, 48, 0.55)'); // muddy rim transition
  grad.addColorStop(1, 'rgba(72, 54, 38, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  // Organic irregular contour
  for (let a = 0; a <= Math.PI * 2; a += 0.1) {
    const r =
      108 +
      Math.sin(a * 3) * 8 +
      Math.cos(a * 5) * 6 +
      Math.sin(a * 7) * 4;
    const x = 128 + Math.cos(a) * r;
    const y = 128 + Math.sin(a) * r;
    if (a === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // Subtle sky/tree reflection streaks inside the puddle
  ctx.fillStyle = 'rgba(210, 224, 235, 0.28)';
  ctx.beginPath();
  ctx.ellipse(115, 118, 52, 22, -0.1, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Generates a tileable red terracotta clay brick texture ("muros de tijolos vermelhos / tijolo baiano")
 */
export function createBrickTexture(maxAnisotropy = 4): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Mortar background
  ctx.fillStyle = '#8c7a6b';
  ctx.fillRect(0, 0, 256, 256);

  const rows = 8;
  const cols = 4;
  const brickH = 256 / rows;
  const brickW = 256 / cols;

  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (brickW / 2);
    for (let c = -1; c <= cols; c++) {
      const x = c * brickW + offset;
      const y = r * brickH;
      const hueShift = ((r * 7 + c * 13) % 5) * 4;
      ctx.fillStyle = `rgb(${178 + hueShift}, ${76 + hueShift}, ${52 + Math.floor(hueShift / 2)})`;
      ctx.fillRect(x + 2, y + 2, brickW - 4, brickH - 4);

      // Subtle clay brick grooves (tijolo baiano)
      ctx.fillStyle = 'rgba(90, 32, 18, 0.25)';
      ctx.fillRect(x + 4, y + brickH * 0.33, brickW - 8, 2);
      ctx.fillRect(x + 4, y + brickH * 0.66, brickW - 8, 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 2);
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Generates the texture for the iconic spectator's white tank top with "THAFEF" printed on the upper back,
 * directly matching the attached reference photograph.
 */
export function createSpectatorShirtTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f5f5f4';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle fabric folds
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 4;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(40 + i * 30, 60);
    ctx.lineTo(50 + i * 28, 220);
    ctx.stroke();
  }

  // "T H A F E F" across upper back collar
  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('T H A F E F', 128, 52);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Generates a worn várzea soccer ball texture (scuffed white leather + classic pentagons).
 */
export function createSoccerBallTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Slightly scuffed cream-white leather
  ctx.fillStyle = '#ebe4d8';
  ctx.fillRect(0, 0, 256, 256);

  // Dirt smudges on ball
  ctx.fillStyle = 'rgba(148, 114, 82, 0.25)';
  for (let i = 0; i < 18; i++) {
    ctx.beginPath();
    ctx.arc((i * 53) % 256, (i * 97) % 256, 14 + (i % 9), 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark pentagon patches
  ctx.fillStyle = '#262320';
  const spots = [
    [64, 64],
    [192, 64],
    [128, 128],
    [64, 192],
    [192, 192],
    [128, 24],
    [128, 232],
  ];
  for (const [cx, cy] of spots) {
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
