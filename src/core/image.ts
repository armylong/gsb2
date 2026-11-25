import { gaussian, mulberry32 } from './rng.ts';

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function createImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(image: RGBAImage): RGBAImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

export function hexRgb(hex: string): RGB {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

interface Blade {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  r: number;
  g: number;
  b: number;
  opacity: number;
}

interface Hole {
  x: number;
  y: number;
  radius: number;
}

export interface LeafTextureOptions {
  width?: number;
  height?: number;
  seed?: number;
  bladeCount?: number;
  palette?: string[];
  dirtyRGB?: RGB;
  clusters?: number;
  holeCount?: number;
}

const MAIN_PALETTE = ['#14532d', '#1f7a3a', '#2f9e44', '#66bb6a', '#a7d98c'];
const BLUE_PALETTE = ['#184f95', '#2a78d6', '#3987e5', '#86b6ef'];
const ORANGE_PALETTE = ['#9a3412', '#d95926', '#eb6834', '#fab219'];

/**
 * Generates a deterministic alpha texture with one-pixel tips and pores.
 * Transparent texels deliberately retain dark "dirty" RGB; safe mip reduction
 * must ignore them through alpha weighting.
 */
export function createLeafTexture(options: LeafTextureOptions = {}): RGBAImage {
  const width = options.width ?? 128;
  const height = options.height ?? 128;
  const seed = options.seed ?? 16960;
  const rng = mulberry32(seed);
  const palette = (options.palette ?? MAIN_PALETTE).map(hexRgb);
  const dirty = options.dirtyRGB ?? { r: 88, g: 43, b: 18 };
  const image = createImage(width, height);

  const clusterCount = options.clusters ?? Math.max(4, Math.round(Math.min(width, height) / 14));
  const centers = Array.from({ length: clusterCount }, () => ({
    x: width * (0.5 + gaussian(rng) * 0.22),
    y: height * (0.52 + gaussian(rng) * 0.2),
    spread: Math.min(width, height) * (0.16 + rng() * 0.16),
  }));

  const bladeCount = options.bladeCount ?? Math.round((width * height) / 115);
  const blades: Blade[] = [];
  for (let i = 0; i < bladeCount; i++) {
    const center = centers[Math.floor(rng() * centers.length)];
    const cx = center.x + gaussian(rng) * center.spread * 0.45;
    const cy = center.y + gaussian(rng) * center.spread * 0.45;
    const angle = rng() * Math.PI * 2;
    const length = Math.min(width, height) * (0.1 + rng() * 0.2);
    const halfLength = length * 0.5;
    const color = palette[Math.floor(rng() * palette.length)];
    blades.push({
      x0: cx - Math.cos(angle) * halfLength,
      y0: cy - Math.sin(angle) * halfLength,
      x1: cx + Math.cos(angle) * halfLength,
      y1: cy + Math.sin(angle) * halfLength,
      width: Math.max(0.72, Math.min(width, height) * (0.01 + rng() * 0.022)),
      r: color.r,
      g: color.g,
      b: color.b,
      opacity: 0.72 + rng() * 0.28,
    });
  }

  const holeCount = options.holeCount ?? Math.max(8, Math.round(Math.min(width, height) / 5));
  const holes: Hole[] = Array.from({ length: holeCount }, () => ({
    x: width * (0.16 + rng() * 0.68),
    y: height * (0.16 + rng() * 0.68),
    radius: Math.min(width, height) * (0.025 + rng() * 0.06),
  }));

  const premultiplied = new Float32Array(width * height * 3);
  const coverage = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let a = coverage[p];
      let pr = premultiplied[p * 3];
      let pg = premultiplied[p * 3 + 1];
      let pb = premultiplied[p * 3 + 2];
      const px = x + 0.5;
      const py = y + 0.5;

      for (const blade of blades) {
        const vx = blade.x1 - blade.x0;
        const vy = blade.y1 - blade.y0;
        const len2 = vx * vx + vy * vy;
        const t = ((px - blade.x0) * vx + (py - blade.y0) * vy) / len2;
        if (t < 0 || t > 1) continue;

        const qx = blade.x0 + vx * t;
        const qy = blade.y0 + vy * t;
        const distance = Math.hypot(px - qx, py - qy);
        // sin(pi*t)^0.55 gives pointed ends while retaining a broad middle.
        const halfWidth = blade.width * Math.pow(Math.sin(Math.PI * t), 0.55);
        const c = Math.max(0, Math.min(1, halfWidth + 0.62 - distance)) * blade.opacity;
        if (c <= 0) continue;

        const oneMinusA = 1 - a;
        pr += oneMinusA * c * blade.r;
        pg += oneMinusA * c * blade.g;
        pb += oneMinusA * c * blade.b;
        a += oneMinusA * c;
      }

      let hole = 0;
      for (const h of holes) {
        const d = Math.hypot(px - h.x, py - h.y);
        const local = 1 - Math.max(0, Math.min(1, (d - h.radius * 0.55) / (h.radius * 0.45)));
        hole = Math.max(hole, local);
      }
      const retain = 1 - hole * 0.94;
      a *= retain;
      pr *= retain;
      pg *= retain;
      pb *= retain;

      coverage[p] = a;
      premultiplied[p * 3] = pr;
      premultiplied[p * 3 + 1] = pg;
      premultiplied[p * 3 + 2] = pb;
    }
  }

  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const a = Math.round(Math.max(0, Math.min(1, coverage[p])) * 255);
    image.data[i + 3] = a;
    if (a > 0) {
      image.data[i] = Math.round(premultiplied[p * 3] / coverage[p]);
      image.data[i + 1] = Math.round(premultiplied[p * 3 + 1] / coverage[p]);
      image.data[i + 2] = Math.round(premultiplied[p * 3 + 2] / coverage[p]);
    } else {
      // Deliberately unusable RGB in transparent texels.
      image.data[i] = dirty.r;
      image.data[i + 1] = dirty.g;
      image.data[i + 2] = dirty.b;
    }
  }

  return image;
}

/** Two differently colored adjacent 64×64 leaf groups in one 128×64 atlas. */
export function createLeafAtlas(): RGBAImage {
  const atlas = createImage(128, 64);
  const left = createLeafTexture({ width: 64, height: 64, seed: 2401, palette: BLUE_PALETTE, bladeCount: 42 });
  const right = createLeafTexture({ width: 64, height: 64, seed: 9601, palette: ORANGE_PALETTE, bladeCount: 42 });
  atlas.data.set(left.data, 0);
  atlas.data.set(right.data, 64 * 4);
  return atlas;
}

export type HandImageId = 'hand4' | 'hand8';

/** Small matrices whose passing area can be counted by hand. */
export function createHandImage(id: HandImageId): RGBAImage {
  if (id === 'hand4') {
    const image = createImage(4, 4);
    const alpha = [
      255, 0, 255, 0,
      0, 0, 0, 0,
      255, 0, 255, 0,
      0, 0, 0, 0,
    ];
    for (let i = 0; i < 16; i++) {
      image.data[i * 4] = 92;
      image.data[i * 4 + 1] = 214;
      image.data[i * 4 + 2] = 120;
      image.data[i * 4 + 3] = alpha[i];
      if (alpha[i] === 0) {
        image.data[i * 4] = 255;
        image.data[i * 4 + 1] = 0;
        image.data[i * 4 + 2] = 255;
      }
    }
    return image;
  }

  const size = 8;
  const image = createImage(size, size);
  const setAlpha = (x: number, y: number, a: number) => {
    const i = (y * size + x) * 4;
    image.data[i] = 92;
    image.data[i + 1] = 214;
    image.data[i + 2] = 120;
    image.data[i + 3] = a;
    if (a === 0) {
      image.data[i] = 255;
      image.data[i + 1] = 0;
      image.data[i + 2] = 255;
    }
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) setAlpha(x, y, 0);
  }
  // A 4×4 opaque core: 16 source texels.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) setAlpha(x, y, 255);
  }
  // Four isolated one-texel tips, each alone in its 2×2 reduction block.
  for (const [x, y] of [[6, 0], [6, 2], [1, 4], [6, 6]] as const) setAlpha(x, y, 255);
  return image;
}

/**
 * Hostile atlas fixture: a red leaf edge next to a blue leaf edge, with
 * magenta dirty RGB in every transparent texel.
 */
export function createBleedFixture(): RGBAImage {
  const image = createImage(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 0;
      image.data[i + 2] = 255;
      image.data[i + 3] = 0;
    }
  }
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * 4 + x) * 4;
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = 255;
  };
  put(1, 1, 255, 0, 0); // right edge of left cell
  put(2, 2, 0, 0, 255); // left edge of right cell
  return image;
}
