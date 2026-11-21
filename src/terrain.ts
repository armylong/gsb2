import { fnv1a, hash2 } from './rng';

export type Zone = 'water' | 'wet' | 'slope' | 'clearing' | 'plain';
export type TerrainStyle = 'riverbank' | 'hills' | 'wetland';

export const ZONE_LABEL: Record<Zone, string> = {
  water: '水面',
  wet: '湿区',
  slope: '坡边',
  clearing: '空地',
  plain: '平地',
};

export interface Cell {
  x: number;
  y: number;
  height: number;
  moisture: number;
  slope: number;
  zone: Zone;
}

export interface Terrain {
  w: number;
  h: number;
  cells: Cell[]; // 行主序，下标 y*w+x
}

const SLOPE_THRESHOLD = 0.15;
const WET_THRESHOLD = 0.6;
const CLEARING_MOISTURE = 0.35;
const CLEARING_SLOPE = 0.08;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2(seed, ix, iy, 777);
  const b = hash2(seed, ix + 1, iy, 777);
  const c = hash2(seed, ix, iy + 1, 777);
  const d = hash2(seed, ix + 1, iy + 1, 777);
  const ux = smooth(fx);
  const uy = smooth(fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(seed: number, x: number, y: number, octaves: number): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise(seed + i * 101, x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return v / norm;
}

export function cellAt(t: Terrain, x: number, y: number): Cell {
  return t.cells[y * t.w + x];
}

export function genTerrain(seedStr: string, style: TerrainStyle, w: number, h: number): Terrain {
  const seed = fnv1a(seedStr);
  const cells: Cell[] = [];
  const water: boolean[] = new Array(w * h).fill(false);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let height = fbm(seed, x * 0.08, y * 0.08, 3);
      let moisture = fbm(seed ^ 0x9e37, x * 0.1, y * 0.1, 2);

      if (style === 'riverbank') {
        // 狭窄蜿蜒的河岸：河道宽 1~2 格，越靠近河越湿
        const phase = (seed % 100) / 10;
        const cx = w / 2 + Math.sin(y * 0.35 + phase) * 2.5 + Math.sin(y * 0.11 + phase) * 1.5;
        const d = Math.abs(x - cx);
        if (d <= 1.2) {
          water[y * w + x] = true;
          height = -1;
        }
        moisture = Math.max(moisture, 1 - d / 6);
      } else if (style === 'wetland') {
        moisture = 0.45 + moisture * 0.55;
        if (moisture > 0.88) {
          water[y * w + x] = true;
          height = -1;
        }
      } else if (style === 'hills') {
        height = height * 1.4;
        if (height < 0.22) {
          water[y * w + x] = true;
          height = -1;
        }
      }

      cells.push({ x, y, height, moisture, slope: 0, zone: 'plain' });
    }
  }

  // 坡度 = 与四邻高度差的最大值
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cells[y * w + x];
      if (water[y * w + x]) {
        c.zone = 'water';
        continue;
      }
      let s = 0;
      const nb = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      for (const [dx, dy] of nb) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        s = Math.max(s, Math.abs(c.height - cells[ny * w + nx].height));
      }
      c.slope = s;
      if (c.moisture >= WET_THRESHOLD) c.zone = 'wet';
      else if (s >= SLOPE_THRESHOLD) c.zone = 'slope';
      else if (c.moisture < CLEARING_MOISTURE && s < CLEARING_SLOPE) c.zone = 'clearing';
      else c.zone = 'plain';
    }
  }

  return { w, h, cells };
}
