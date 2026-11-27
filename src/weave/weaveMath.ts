// 织纹核心数学：纯函数，不依赖 three.js。
// 三维管道路径、拾取反算、导出图逐像素采样全部共用这里的同一套公式，
// 保证「屏幕上看到的」和「导出图平铺的」完全一致。
//
// 坐标约定：
//   经线(warp)沿 Z 方向延伸，第 i 根经线的中心 X = i * warp.spacing
//   纬线(weft)沿 X 方向延伸，第 j 根纬线的中心 Z = j * weft.spacing
//   组织矩阵 matrix[i * sizeF + j]：1 = 经线上浮，0 = 纬线上浮
//   所有索引都按循环尺寸取模，因此重复单元的四条边天然保持相同穿插关系。

export interface YarnSpec {
  /** 线的半径（粗细 = 2 * radius） */
  radius: number;
  /** 相邻两根同方向线的中心间距 */
  spacing: number;
  /** 颜色循环表，按「一个循环内的线号」取色，循环接缝处不会变色 */
  colors: string[];
}

export interface YarnParams {
  warp: YarnSpec;
  weft: YarnSpec;
}

export interface WeaveModel {
  /** 经线数（列方向） */
  sizeW: number;
  /** 纬线数（行方向） */
  sizeF: number;
  /** 行优先：matrix[i * sizeF + j]，1 经线上浮，0 纬线上浮 */
  matrix: Uint8Array;
}

export interface WeaveState {
  model: WeaveModel;
  yarn: YarnParams;
  /** X 方向重复次数（沿经线排列方向） */
  repsX: number;
  /** Z 方向重复次数（沿纬线排列方向） */
  repsZ: number;
}

export interface SurfaceSample {
  /** 顶面颜色，0..1 线性分量 */
  r: number;
  g: number;
  b: number;
  /** 顶面世界 Y（高度） */
  y: number;
  /** 是否落在两根线之间的空隙 */
  gap: boolean;
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 取组织点，索引自动按循环尺寸取模（跨边界长浮线也成立） */
export function getCell(model: WeaveModel, i: number, j: number): number {
  const ii = mod(i, model.sizeW);
  const jj = mod(j, model.sizeF);
  return model.matrix[ii * model.sizeF + jj];
}

export function setCell(model: WeaveModel, i: number, j: number, value: number): void {
  const ii = mod(i, model.sizeW);
  const jj = mod(j, model.sizeF);
  model.matrix[ii * model.sizeF + jj] = value & 1;
}

/**
 * 交叉点处上下两层的中心面高度振幅。
 * 两层中心距 = 2*amp，略小于两半径之和，让线之间有轻微挤压，
 * 任何粗细组合下交叉点都不会露出空洞。
 */
export function amp(yarn: YarnParams): number {
  return 0.48 * (yarn.warp.radius + yarn.weft.radius);
}

/** 交叉点处经线中心高度 */
export function warpCrossY(model: WeaveModel, yarn: YarnParams, i: number, j: number): number {
  return getCell(model, i, j) === 1 ? amp(yarn) : -amp(yarn);
}

/** 交叉点处纬线中心高度 */
export function weftCrossY(model: WeaveModel, yarn: YarnParams, i: number, j: number): number {
  return getCell(model, i, j) === 1 ? -amp(yarn) : amp(yarn);
}

/**
 * 第 i 根经线在世界坐标 z 处的中心高度。
 * 高度在相邻纬线交叉点之间用 smoothstep 连续过渡：
 *   - 起伏穿过交叉点时平滑上下
 *   - 连续从上方经过多根纬线时，两端高度相同，中段保持水平 → 看得出是一整根完整的线
 * 高度函数只依赖 z / spacing 与取模后的组织值，平移任意整数个循环都完全重合。
 */
export function warpCenterY(model: WeaveModel, yarn: YarnParams, i: number, z: number): number {
  const sf = yarn.weft.spacing;
  const j0 = Math.floor(z / sf);
  const t = clamp01(z / sf - j0);
  const e = smoothstep(t);
  const h0 = warpCrossY(model, yarn, i, j0);
  const h1 = warpCrossY(model, yarn, i, j0 + 1);
  return h0 + (h1 - h0) * e;
}

/** 第 j 根纬线在世界坐标 x 处的中心高度 */
export function weftCenterY(model: WeaveModel, yarn: YarnParams, j: number, x: number): number {
  const sw = yarn.warp.spacing;
  const i0 = Math.floor(x / sw);
  const t = clamp01(x / sw - i0);
  const e = smoothstep(t);
  const h0 = weftCrossY(model, yarn, i0, j);
  const h1 = weftCrossY(model, yarn, i0 + 1, j);
  return h0 + (h1 - h0) * e;
}

/** 一个循环在 X / Z 方向的物理宽度 */
export function tileSizeX(yarn: YarnParams, model: WeaveModel): number {
  return model.sizeW * yarn.warp.spacing;
}

export function tileSizeZ(yarn: YarnParams, model: WeaveModel): number {
  return model.sizeF * yarn.weft.spacing;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface Palettes {
  /** 按一个循环内经线线号取色 */
  warp: Float32Array; // length sizeW*3
  /** 按一个循环内纬线线号取色 */
  weft: Float32Array; // length sizeF*3
}

export function buildPalettes(state: WeaveState): Palettes {
  const warp = new Float32Array(state.model.sizeW * 3);
  const weft = new Float32Array(state.model.sizeF * 3);
  for (let i = 0; i < state.model.sizeW; i++) {
    const c = hexToRgb(state.yarn.warp.colors[mod(i, state.yarn.warp.colors.length)]);
    warp.set(c, i * 3);
  }
  for (let j = 0; j < state.model.sizeF; j++) {
    const c = hexToRgb(state.yarn.weft.colors[mod(j, state.yarn.weft.colors.length)]);
    weft.set(c, j * 3);
  }
  return { warp, weft };
}

/** 高度图归一化使用的高度区间（与实际几何的上下界一致） */
export function heightRange(yarn: YarnParams): { min: number; max: number } {
  const a = amp(yarn);
  return {
    min: -a - 0.5 * (yarn.warp.radius + yarn.weft.radius),
    max: a + Math.max(yarn.warp.radius, yarn.weft.radius),
  };
}

const LIGHT_DIR = (() => {
  const v = [-0.45, 0.95, 0.38];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();

/**
 * 俯视采样：求 (x, z) 处布面最顶端的颜色与高度。
 * 全部使用周期坐标，输出在循环四边严格连续，可直接无缝平铺。
 */
export function evalTop(state: WeaveState, x: number, z: number, pal: Palettes): SurfaceSample {
  const { model, yarn } = state;
  const sw = yarn.warp.spacing;
  const sf = yarn.weft.spacing;
  const rw = yarn.warp.radius;
  const rf = yarn.weft.radius;
  const tx = tileSizeX(yarn, model);
  const tz = tileSizeZ(yarn, model);

  // 折回一个循环内的局部坐标
  const lx = mod(x, tx);
  const lz = mod(z, tz);
  const iPos = lx / sw;
  const jPos = lz / sf;
  const i = Math.floor(iPos);
  const j = Math.floor(jPos);
  const dx = lx - i * sw; // 距最近经线中心的横向距离
  const dz = lz - j * sf;

  let warpTop = -Infinity;
  let warpNormal: [number, number, number] = [0, 1, 0];
  if (Math.abs(dx) < rw) {
    const q = Math.sqrt(Math.max(0, 1 - (dx / rw) ** 2));
    const cy = warpCenterY(model, yarn, i, z);
    warpTop = cy + rw * q;
    warpNormal = [dx / rw, q, 0];
  }

  let weftTop = -Infinity;
  let weftNormal: [number, number, number] = [0, 1, 0];
  if (Math.abs(dz) < rf) {
    const q = Math.sqrt(Math.max(0, 1 - (dz / rf) ** 2));
    const cy = weftCenterY(model, yarn, j, x);
    weftTop = cy + rf * q;
    weftNormal = [0, q, dz / rf];
  }

  if (warpTop === -Infinity && weftTop === -Infinity) {
    const hr = heightRange(yarn);
    return { r: 0.055, g: 0.06, b: 0.07, y: hr.min, gap: true };
  }

  const isWarp = warpTop >= weftTop;
  const localIdx = mod(isWarp ? i : j, isWarp ? model.sizeW : model.sizeF);
  const palArr = isWarp ? pal.warp : pal.weft;
  const n = isWarp ? warpNormal : weftNormal;
  const shade = 0.62 + 0.38 * Math.max(0, n[0] * LIGHT_DIR[0] + n[1] * LIGHT_DIR[1] + n[2] * LIGHT_DIR[2]);
  const p = localIdx * 3;
  return {
    r: palArr[p] * shade,
    g: palArr[p + 1] * shade,
    b: palArr[p + 2] * shade,
    y: isWarp ? warpTop : weftTop,
    gap: false,
  };
}
