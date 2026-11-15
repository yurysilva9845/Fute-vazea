import * as THREE from 'three';
import { PhotoSkinId } from '../types/game';

const shirtTextureCache = new Map<string, THREE.CanvasTexture>();
const faceTextureCache = new Map<string, THREE.CanvasTexture>();
let fabricBumpTextureCache: THREE.CanvasTexture | null = null;
let kneeBraceTextureCache: THREE.CanvasTexture | null = null;

/**
 * Generates a subtle woven fabric normal/bump texture for 3D shirts and shorts.
 */
export function createFabricBumpTexture(): THREE.CanvasTexture {
  if (fabricBumpTextureCache) return fabricBumpTextureCache;

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 128, 128);

  for (let y = 0; y < 128; y += 2) {
    for (let x = 0; x < 128; x += 2) {
      const v = 115 + ((x + y) % 4 === 0 ? 18 : -14);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  fabricBumpTextureCache = tex;
  return tex;
}

/**
 * Generates high-definition authentic shirt textures matching the reference photo for each player:
 * - josue: Slate-grey "RIO DE JANEIRO" palm tree / Sugarloaf beach scene t-shirt
 * - careca: Half-red / half-black "BIKETOUR" jersey with white left shoulder panel and mountain crest
 * - bode: Dark navy/charcoal crew-neck t-shirt with realistic fabric folds
 * - ismael: Crisp white t-shirt with lime-green left chest logo and green/blue curved side graphic
 * - yuri: White Al-Hilal style jersey with blue V-collar, blue chest crests and "SAVVY GAMES GROUP"
 * - primo / bicudo: Purple & black vertical striped jersey with circular crest and golden "betsson"
 * - felipe: Classic várzea athletic jersey with subtle folds
 */
export function createPlayerShirtTexture(
  skinId: PhotoSkinId | undefined,
  fallbackColor: string
): THREE.CanvasTexture {
  const key = `${skinId || 'custom'}_${fallbackColor}`;
  const cached = shirtTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Helper to add natural cloth folds & sweat/dirt shading
  const drawClothFolds = (alpha = 0.12) => {
    for (let i = 0; i < 14; i++) {
      const y = 70 + i * 28;
      const grad = ctx.createLinearGradient(80, y, 430, y + 18);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, `rgba(0,0,0,${alpha})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(60, y, 392, 14);
    }
  };

  if (skinId === 'josue') {
    // Slate grey weathered cotton t-shirt ("RIO DE JANEIRO")
    ctx.fillStyle = '#6e7889';
    ctx.fillRect(0, 0, 512, 512);
    drawClothFolds(0.14);

    // Graphic box on chest (centered on front of cylinder/box)
    const bx = 136;
    const by = 110;
    const bw = 240;
    const bh = 250;

    // Sky/beach monochrome print background
    const skyGrad = ctx.createLinearGradient(bx, by, bx, by + bh);
    skyGrad.addColorStop(0, '#272c36');
    skyGrad.addColorStop(0.45, '#cfd6e0');
    skyGrad.addColorStop(0.75, '#8c96a6');
    skyGrad.addColorStop(1, '#1e232b');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(bx, by, bw, bh);

    // Sugarloaf mountain silhouette in the background
    ctx.fillStyle = '#232832';
    ctx.beginPath();
    ctx.moveTo(bx, by + 165);
    ctx.quadraticCurveTo(bx + 75, by + 95, bx + 125, by + 160);
    ctx.quadraticCurveTo(bx + 185, by + 110, bx + bw, by + 165);
    ctx.lineTo(bx + bw, by + 195);
    ctx.lineTo(bx, by + 195);
    ctx.closePath();
    ctx.fill();

    // Palm tree silhouettes
    const drawPalm = (px: number, py: number, scale: number) => {
      ctx.strokeStyle = '#14181f';
      ctx.lineWidth = 5 * scale;
      ctx.beginPath();
      ctx.moveTo(px, py + 75 * scale);
      ctx.quadraticCurveTo(px + 8 * scale, py + 35 * scale, px + 4 * scale, py);
      ctx.stroke();

      for (let a = -2.4; a <= 0.6; a += 0.5) {
        ctx.beginPath();
        ctx.moveTo(px + 4 * scale, py);
        ctx.quadraticCurveTo(
          px + Math.cos(a) * 28 * scale,
          py + Math.sin(a) * 18 * scale - 8 * scale,
          px + Math.cos(a) * 44 * scale,
          py + Math.sin(a) * 26 * scale + 10 * scale
        );
        ctx.stroke();
      }
    };
    drawPalm(bx + 48, by + 82, 1.0);
    drawPalm(bx + 190, by + 76, 1.05);
    drawPalm(bx + 150, by + 96, 0.75);

    // Bold white "RIO DE" at top of print
    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 38px Impact, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 4;
    ctx.fillText('RIO DE', bx + bw / 2, by + 44);

    // Bold white "JANEIRO" at bottom of print
    ctx.font = '900 36px Impact, Arial Black, sans-serif';
    ctx.fillText('JANEIRO', bx + bw / 2, by + bh - 18);
    ctx.shadowBlur = 0;

    // Distressed screenprint lines
    ctx.strokeStyle = '#6e7889';
    ctx.lineWidth = 2;
    for (let i = 0; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo(bx, by + i * 25);
      ctx.lineTo(bx + bw, by + i * 25 + 3);
      ctx.stroke();
    }
  } else if (skinId === 'careca') {
    // Half-Red (viewer left / player right) & Half-Black (viewer right / player left) "BIKETOUR" jersey
    ctx.fillStyle = '#c92a2a';
    ctx.fillRect(0, 0, 256, 512);

    // Subtle dark-red horizontal stripes on the red side
    ctx.fillStyle = 'rgba(20, 10, 10, 0.22)';
    for (let y = 60; y < 480; y += 28) {
      ctx.fillRect(0, y, 256, 10);
    }

    // Black half on right side of texture (player's left torso)
    ctx.fillStyle = '#16181d';
    ctx.fillRect(256, 0, 256, 512);

    // White diagonal shoulder block on top-right (player's left shoulder)
    ctx.fillStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.moveTo(256, 0);
    ctx.lineTo(512, 0);
    ctx.lineTo(512, 128);
    ctx.lineTo(256, 86);
    ctx.closePath();
    ctx.fill();

    // Central mountain peak emblem (white & red geometric peak)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(190, 210);
    ctx.lineTo(256, 148);
    ctx.lineTo(322, 210);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#d92626';
    ctx.beginPath();
    ctx.moveTo(222, 210);
    ctx.lineTo(256, 172);
    ctx.lineTo(290, 210);
    ctx.closePath();
    ctx.fill();

    // Green & White "BIKETOUR" badge across chest
    ctx.fillStyle = '#16a34a';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(142, 212, 228, 46, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 30px Impact, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BIKETOUR', 256, 246);

    drawClothFolds(0.15);
  } else if (skinId === 'bode') {
    // Dark navy/charcoal crew-neck t-shirt
    ctx.fillStyle = '#222733';
    ctx.fillRect(0, 0, 512, 512);
    drawClothFolds(0.18);

    // Subtle chest seam & minimal athletic logo on left chest
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(325, 150, 12, 0, Math.PI * 2);
    ctx.fill();
  } else if (skinId === 'ismael') {
    // Crisp white crew-neck t-shirt with lime-green left chest graphic & green/blue curved right-side graphic
    ctx.fillStyle = '#f3f5f8';
    ctx.fillRect(0, 0, 512, 512);

    // Lime-green emblem on left chest (viewer right)
    ctx.fillStyle = '#84cc16';
    ctx.beginPath();
    ctx.arc(335, 160, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#365314';
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VÁRZEA', 335, 165);

    // Curved green & teal ribbon graphic on viewer's left (player's right ribs)
    ctx.lineWidth = 18;
    ctx.strokeStyle = '#65a30d';
    ctx.beginPath();
    ctx.moveTo(110, 210);
    ctx.quadraticCurveTo(195, 265, 130, 350);
    ctx.stroke();

    ctx.lineWidth = 12;
    ctx.strokeStyle = '#0284c7';
    ctx.beginPath();
    ctx.moveTo(95, 240);
    ctx.quadraticCurveTo(175, 290, 115, 375);
    ctx.stroke();

    drawClothFolds(0.09);
  } else if (skinId === 'yuri') {
    // White Al-Hilal style jersey with blue V-neck, blue crests & "SAVVY GAMES GROUP"
    ctx.fillStyle = '#eef2f9';
    ctx.fillRect(0, 0, 512, 512);

    // Subtle chevron wave pattern in fabric
    ctx.strokeStyle = 'rgba(30, 64, 175, 0.08)';
    ctx.lineWidth = 3;
    for (let y = 60; y < 480; y += 22) {
      ctx.beginPath();
      ctx.moveTo(80, y + 15);
      ctx.lineTo(256, y - 10);
      ctx.lineTo(432, y + 15);
      ctx.stroke();
    }

    // Blue V-neck collar trim at top
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(195, 10);
    ctx.lineTo(256, 78);
    ctx.lineTo(317, 10);
    ctx.stroke();

    // Right chest blue puma-like leaping cat mark
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath();
    ctx.ellipse(180, 145, 16, 7, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // Left chest blue shield crest
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath();
    ctx.roundRect(316, 126, 34, 42, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('H', 333, 153);

    // Center sponsor: "SAVVY" + "GAMES GROUP"
    ctx.fillStyle = '#1e3a8a';
    ctx.font = '900 44px Arial Black, Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SAVVY', 256, 236);
    ctx.font = '700 18px Arial, sans-serif';
    ctx.fillText('GAMES GROUP', 256, 262);

    drawClothFolds(0.1);
  } else if (skinId === 'primo' || skinId === 'bicudo') {
    // Purple & Black vertical striped jersey with circular crest and golden "betsson"
    ctx.fillStyle = '#141218';
    ctx.fillRect(0, 0, 512, 512);

    // Vertical purple stripes
    ctx.fillStyle = '#581c87';
    for (let x = 32; x < 512; x += 64) {
      ctx.fillRect(x, 0, 34, 512);
    }

    // White swoosh on right chest
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(168, 148);
    ctx.quadraticCurveTo(180, 162, 208, 138);
    ctx.stroke();

    // Circular crest on left chest
    ctx.fillStyle = '#1e1b4b';
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(334, 148, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('IM', 334, 154);

    // Golden "betsson" sponsor across chest
    ctx.fillStyle = '#eab308';
    ctx.font = '900 38px Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('betsson', 256, 240);

    drawClothFolds(0.16);
  } else {
    // Default / Felipe shirt with authentic várzea folds & subtle crest
    ctx.fillStyle = fallbackColor || '#dc2626';
    ctx.fillRect(0, 0, 512, 512);
    drawClothFolds(0.15);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  shirtTextureCache.set(key, tex);
  return tex;
}

/**
 * Generates a realistic facial texture for each character based on the group photo:
 * - Natural skin tone variations, cheekbones, nose bridge highlight, nostrils, lips
 * - Character-specific facial lines (e.g., Careca's forehead & nasolabial lines)
 * - Character-specific eyes, eyebrows, mustache, and goatee details
 */
export function createPlayerFaceTexture(
  skinId: PhotoSkinId | undefined,
  skinColorHex: string
): THREE.CanvasTexture {
  const key = `${skinId || 'default'}_${skinColorHex}`;
  const cached = faceTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Base skin tone
  ctx.fillStyle = skinColorHex;
  ctx.fillRect(0, 0, 256, 256);

  // Subtle warm/cool facial shading (forehead highlight, cheek warmth, jawline shadow)
  const radGrad = ctx.createRadialGradient(128, 120, 20, 128, 128, 130);
  radGrad.addColorStop(0, 'rgba(255, 225, 200, 0.14)');
  radGrad.addColorStop(0.65, 'rgba(0, 0, 0, 0)');
  radGrad.addColorStop(1, 'rgba(25, 10, 5, 0.28)');
  ctx.fillStyle = radGrad;
  ctx.fillRect(0, 0, 256, 256);

  // Careca has distinctive weathered forehead and nasolabial expression lines in the photo
  if (skinId === 'careca') {
    ctx.strokeStyle = 'rgba(30, 12, 4, 0.42)';
    ctx.lineWidth = 2.5;
    for (let y = 52; y <= 76; y += 11) {
      ctx.beginPath();
      ctx.moveTo(78, y);
      ctx.quadraticCurveTo(128, y - 5, 178, y);
      ctx.stroke();
    }
    // Nasolabial folds
    ctx.beginPath();
    ctx.moveTo(106, 145);
    ctx.quadraticCurveTo(92, 168, 96, 192);
    ctx.moveTo(150, 145);
    ctx.quadraticCurveTo(164, 168, 160, 192);
    ctx.stroke();
  }

  // Eyebrows
  ctx.fillStyle = '#181311';
  const browThickness = skinId === 'bode' || skinId === 'josue' ? 8 : 6;
  ctx.beginPath();
  ctx.roundRect(72, 86, 40, browThickness, 4);
  ctx.roundRect(144, 86, 40, browThickness, 4);
  ctx.fill();

  // Eyes (sclera + dark brown iris + pupil + upper eyelid shadow)
  const drawEye = (ex: number, ey: number) => {
    ctx.fillStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.ellipse(ex, ey, 14, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2b1911';
    ctx.beginPath();
    ctx.arc(ex, ey, 6.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#09090b';
    ctx.beginPath();
    ctx.arc(ex, ey, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Eye catchlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex - 2, ey - 2, 1.4, 0, Math.PI * 2);
    ctx.fill();

    // Upper eyelid crease
    ctx.strokeStyle = 'rgba(20, 10, 5, 0.6)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(ex, ey + 2, 14, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
  };
  drawEye(92, 108);
  drawEye(164, 108);

  // Nose bridge shading & nostrils
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.arc(120, 152, 3.5, 0, Math.PI * 2);
  ctx.arc(136, 152, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Natural lips
  ctx.fillStyle = 'rgba(75, 32, 28, 0.55)';
  ctx.beginPath();
  ctx.ellipse(128, 184, 20, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 10, 8, 0.65)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(108, 184);
  ctx.quadraticCurveTo(128, 186, 148, 184);
  ctx.stroke();

  // Facial hair in texture + reinforced by 3D mesh in playerModel.ts
  if (skinId === 'josue') {
    // Full dark mustache + chin goatee + light jawline stubble
    ctx.fillStyle = 'rgba(22, 18, 16, 0.85)';
    ctx.beginPath();
    ctx.roundRect(100, 168, 56, 9, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(128, 212, 24, 14, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (skinId === 'ismael' || skinId === 'careca') {
    // Distinct thin dark mustache
    ctx.fillStyle = 'rgba(24, 18, 15, 0.78)';
    ctx.beginPath();
    ctx.roundRect(102, 170, 52, 6.5, 3);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  faceTextureCache.set(key, tex);
  return tex;
}

/**
 * Generates the black & neon-green elastic knee brace texture worn by Ismael on his right knee.
 */
export function createKneeBraceTexture(): THREE.CanvasTexture {
  if (kneeBraceTextureCache) return kneeBraceTextureCache;

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#141619';
  ctx.fillRect(0, 0, 128, 128);

  // Neon lime green elastic top, middle, and bottom bands matching the photo
  ctx.fillStyle = '#84cc16';
  ctx.fillRect(0, 8, 128, 14);
  ctx.fillRect(0, 106, 128, 14);

  ctx.strokeStyle = '#84cc16';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(0, 42);
  ctx.quadraticCurveTo(64, 68, 128, 42);
  ctx.moveTo(0, 86);
  ctx.quadraticCurveTo(64, 60, 128, 86);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  kneeBraceTextureCache = tex;
  return tex;
}
