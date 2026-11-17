/**
 * 标量场定义与采样。
 *
 * 坐标约定（全局统一，渲染、切片、导出均使用同一套）：
 *  - 右手坐标系，单位统一为 "su"（scene unit，场景单位）。
 *  - 采样区域为轴对齐盒 [min, max]^3，默认 [-10, 10]^3。
 *  - 网格点 i (0..N-1) 的世界坐标: x = min.x + i * hx, hx = (max.x-min.x)/(N-1)。
 *    y、z 同理。数组下标排列为 x 最快: idx = i + N*(j + N*k)。
 *
 * 场值含义：球体并集的有符号距离（SDF）。负值 = 内部，0 = 球面，正值 = 外部。
 */

export interface Sphere {
  center: [number, number, number];
  radius: number;
}

export interface SampleDef {
  id: string;
  label: string;
  spheres: Sphere[];
  /** 采样范围（三轴相同） */
  rangeMin: number;
  rangeMax: number;
  /** true 表示有球体伸出采样边界，等值面会被边界截断（开口） */
  truncated: boolean;
}

export const UNITS = 'su';
export const RANGE_MIN = -10;
export const RANGE_MAX = 10;

function makeSamples(): SampleDef[] {
  const single: SampleDef = {
    id: 'single',
    label: '单球（闭合）',
    spheres: [{ center: [0, 0, 0], radius: 5 }],
    rangeMin: RANGE_MIN,
    rangeMax: RANGE_MAX,
    truncated: false,
  };
  const intersecting: SampleDef = {
    id: 'intersecting',
    label: '两球相交（闭合）',
    spheres: [
      { center: [-3, 0, 0], radius: 4.5 },
      { center: [3, 0, 0], radius: 4.5 },
    ],
    rangeMin: RANGE_MIN,
    rangeMax: RANGE_MAX,
    truncated: false,
  };
  const separated: SampleDef = {
    id: 'separated',
    label: '两球分离（其一伸出边界，截断）',
    spheres: [
      { center: [-5, 0, 0], radius: 3 },
      { center: [7.5, 0, 0], radius: 4 },
    ],
    rangeMin: RANGE_MIN,
    rangeMax: RANGE_MAX,
    truncated: true, // 球2 x 方向延伸到 11.5 > 10
  };
  return [single, intersecting, separated];
}

export const SAMPLES: SampleDef[] = makeSamples();

export function getSample(id: string): SampleDef {
  const s = SAMPLES.find((s) => s.id === id);
  if (!s) throw new Error(`unknown sample: ${id}`);
  return s;
}

/** 球体并集 SDF：min 各球 (|p-c| - r)。负值内部，0 球面。 */
export function evalField(sample: SampleDef, x: number, y: number, z: number): number {
  let d = Infinity;
  for (const s of sample.spheres) {
    const dx = x - s.center[0];
    const dy = y - s.center[1];
    const dz = z - s.center[2];
    const v = Math.sqrt(dx * dx + dy * dy + dz * dz) - s.radius;
    if (v < d) d = v;
  }
  return d;
}

export interface Grid {
  /** 每轴采样点数 N（32..64） */
  n: number;
  min: [number, number, number];
  max: [number, number, number];
  /** 网格间距（三轴相同） */
  h: number;
  /** 场值，长度 N^3，下标 i + N*(j + N*k)，x 最快 */
  values: Float32Array;
  minValue: number;
  maxValue: number;
}

/** 在采样盒内均匀采样标量场。 */
export function sampleGrid(sample: SampleDef, n: number): Grid {
  const min: [number, number, number] = [sample.rangeMin, sample.rangeMin, sample.rangeMin];
  const max: [number, number, number] = [sample.rangeMax, sample.rangeMax, sample.rangeMax];
  const h = (max[0] - min[0]) / (n - 1);
  const values = new Float32Array(n * n * n);
  let minV = Infinity;
  let maxV = -Infinity;
  for (let k = 0; k < n; k++) {
    const z = min[2] + k * h;
    for (let j = 0; j < n; j++) {
      const y = min[1] + j * h;
      for (let i = 0; i < n; i++) {
        const x = min[0] + i * h;
        const v = evalField(sample, x, y, z);
        const idx = i + n * (j + n * k);
        values[idx] = v;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  return { n, min, max, h, values, minValue: minV, maxValue: maxV };
}

/** 网格点 (i,j,k) 的世界坐标。 */
export function gridPoint(grid: Grid, i: number, j: number, k: number): [number, number, number] {
  return [grid.min[0] + i * grid.h, grid.min[1] + j * grid.h, grid.min[2] + k * grid.h];
}

/** 三线性插值取任意世界坐标处的场值（用于切片显示，与提取所见数据一致）。 */
export function sampleTrilinear(grid: Grid, x: number, y: number, z: number): number {
  const n = grid.n;
  const fx = (x - grid.min[0]) / grid.h;
  const fy = (y - grid.min[1]) / grid.h;
  const fz = (z - grid.min[2]) / grid.h;
  const i0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
  const j0 = Math.max(0, Math.min(n - 2, Math.floor(fy)));
  const k0 = Math.max(0, Math.min(n - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i0));
  const ty = Math.max(0, Math.min(1, fy - j0));
  const tz = Math.max(0, Math.min(1, fz - k0));
  const v = grid.values;
  const at = (i: number, j: number, k: number) => v[i + n * (j + n * k)];
  const c00 = at(i0, j0, k0) * (1 - tx) + at(i0 + 1, j0, k0) * tx;
  const c10 = at(i0, j0 + 1, k0) * (1 - tx) + at(i0 + 1, j0 + 1, k0) * tx;
  const c01 = at(i0, j0, k0 + 1) * (1 - tx) + at(i0 + 1, j0, k0 + 1) * tx;
  const c11 = at(i0, j0 + 1, k0 + 1) * (1 - tx) + at(i0 + 1, j0 + 1, k0 + 1) * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}
