import { hash2d } from '../core/rng';

export interface TextureSpec {
  readonly key: string;
  readonly name: string;
  readonly edgeNote: string;
  readonly rgb: readonly [number, number, number];
  readonly alphaAt: (u: number, v: number, size: number) => number;
}

export interface TextureDef {
  readonly key: string;
  readonly name: string;
  readonly edgeNote: string;
  readonly size: number;
  /** 直通 alpha，给 2D canvas 预览用。 */
  readonly straight: Uint8Array;
  /** 预乘 alpha，给 WebGL 用。 */
  readonly premultiplied: Uint8Array;
}

export const TEXTURE_SIZE = 320;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 低频 value noise，形状比纯哈希更连贯。 */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2d(xi, yi, seed);
  const b = hash2d(xi + 1, yi, seed);
  const c = hash2d(xi, yi + 1, seed);
  const d = hash2d(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function sharpen(t: number, power: number): number {
  return Math.pow(Math.max(0, Math.min(1, t)), power);
}

/** 抗锯齿覆盖率：dist 为像素距离，edgePx 为过渡宽度的一半（像素）。 */
function coverage(dist: number, edgePx: number): number {
  return Math.max(0, Math.min(1, 0.5 - dist / (edgePx * 2)));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function roundedBoxSdf(px: number, py: number, half: number, radius: number): number {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

export const TEXTURE_SPECS: readonly TextureSpec[] = [
  {
    key: 'glow',
    name: '柔光团',
    edgeNote: '无硬边，二次幂羽化',
    rgb: [255, 246, 234],
    alphaAt: (u, v) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const r = Math.hypot(x, y) / 0.94;
      return sharpen(1 - r, 2.6) * 0.96;
    },
  },
  {
    key: 'disc',
    name: '圆片',
    edgeNote: '硬边 + 1.2px 抗锯齿',
    rgb: [255, 255, 255],
    alphaAt: (u, v, size) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const r = Math.hypot(x, y);
      const edge = 1.2 / size;
      return coverage(r - 0.84, edge);
    },
  },
  {
    key: 'ring',
    name: '空心环',
    edgeNote: '环形软边，中心全透明',
    rgb: [240, 249, 255],
    alphaAt: (u, v, size) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const r = Math.hypot(x, y);
      const band = Math.abs(r - 0.76);
      const soft = sharpen(1 - band / 0.095, 1.35);
      const aa = coverage(band - 0.085, 0.9 / size);
      return Math.min(1, soft * 0.92 + aa * 0.08);
    },
  },
  {
    key: 'smoke',
    name: '烟团',
    edgeNote: '不规则烟雾软边',
    rgb: [236, 242, 255],
    alphaAt: (u, v) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const n = valueNoise(u * 4.2, v * 4.2, 9173) - 0.5;
      const fine = valueNoise(u * 17, v * 17, 6131) - 0.5;
      const warpX = x + n * 0.16 + fine * 0.03;
      const warpY = y + (valueNoise(u * 3.1 + 11, v * 3.1, 4421) - 0.5) * 0.16;
      const lobes =
        0.62 * Math.exp(-(Math.hypot(warpX - 0.16, warpY + 0.06) ** 2) / 0.17) +
        0.44 * Math.exp(-(Math.hypot(warpX + 0.26, warpY - 0.2) ** 2) / 0.085) +
        0.34 * Math.exp(-(Math.hypot(warpX + 0.06, warpY + 0.34) ** 2) / 0.1);
      const falloff = smoothstep(1, 0.58, Math.hypot(x, y));
      return Math.max(0, Math.min(1, lobes * falloff * 1.15 + n * 0.07 + fine * 0.03));
    },
  },
  {
    key: 'spark',
    name: '星芒',
    edgeNote: '细尖角软衰减',
    rgb: [255, 247, 226],
    alphaAt: (u, v) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const r = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      const rays = Math.pow(Math.max(0, Math.cos(angle * 5)), 22);
      const rayMask = rays * Math.pow(Math.max(0, 1 - r / 0.97), 2.4) * 1.7;
      const cross = Math.pow(Math.max(0, Math.cos(angle * 2)), 40) * Math.pow(Math.max(0, 1 - r), 3.2);
      const core = Math.pow(Math.max(0, 1 - r / 0.34), 2.2);
      return Math.max(0, Math.min(1, rayMask + cross * 0.6 + core));
    },
  },
  {
    key: 'card',
    name: '圆角卡',
    edgeNote: '圆角硬边，角落抗锯齿',
    rgb: [255, 255, 255],
    alphaAt: (u, v, size) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const sd = roundedBoxSdf(x, y, 0.72, 0.24);
      return coverage(sd, 1.15 / size);
    },
  },
  {
    key: 'eroded',
    name: '侵蚀片',
    edgeNote: '噪点侵蚀边，软硬混合',
    rgb: [244, 250, 240],
    alphaAt: (u, v) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      const r = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      // 两层 value noise + 一层细颗粒；都用双线性插值的噪声，避免方块状锯齿。
      const n1 = valueNoise(u * 9.5, v * 9.5, 3319) - 0.5;
      const n2 = valueNoise(u * 34, v * 34, 1723) - 0.5;
      const grain = valueNoise(u * 110, v * 110, 5501) - 0.5;
      const boundary = 0.7 + Math.sin(angle * 3 + 0.7) * 0.055 + n1 * 0.1 + n2 * 0.045;
      return smoothstep(boundary + 0.022, boundary - 0.018, r) * (0.87 + n2 * 0.1 + grain * 0.06);
    },
  },
];

export function buildTexture(spec: TextureSpec, size: number): TextureDef {
  const straight = new Uint8Array(size * size * 4);
  const premultiplied = new Uint8Array(size * size * 4);
  const [r, g, b] = spec.rgb;
  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const a = Math.max(0, Math.min(1, spec.alphaAt(u, v, size)));
      const ai = Math.round(a * 255);
      const idx = (py * size + px) * 4;
      straight[idx] = r;
      straight[idx + 1] = g;
      straight[idx + 2] = b;
      straight[idx + 3] = ai;
      premultiplied[idx] = Math.round((r * ai) / 255);
      premultiplied[idx + 1] = Math.round((g * ai) / 255);
      premultiplied[idx + 2] = Math.round((b * ai) / 255);
      premultiplied[idx + 3] = ai;
    }
  }
  return {
    key: spec.key,
    name: spec.name,
    edgeNote: spec.edgeNote,
    size,
    straight,
    premultiplied,
  };
}

export function buildAllTextures(size = TEXTURE_SIZE): TextureDef[] {
  return TEXTURE_SPECS.map((spec) => buildTexture(spec, size));
}
