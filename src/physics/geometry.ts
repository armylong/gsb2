/**
 * 水槽几何常量（单位 cm）。
 * 物理追踪器 (physics/) 与 Three.js 场景 (scene/) 必须共用本文件，
 * 保证光线追踪的边界与画面里的玻璃、槽框、标尺严格对齐。
 *
 * 坐标系：x 向右，y 向上，z 朝向相机（相机初始在 +z 一侧）。
 */
export const TANK = {
  /** 内腔半宽 / 半高 / 半深（玻璃内表面） */
  innerHalf: { x: 20, y: 15, z: 15 },
  /** 玻璃厚度 */
  glass: 1,
  /** 槽底厚度 */
  bottom: 1,
  /** 水位（内腔 y=0 为槽底内表面） */
  waterLevel: 24,
} as const;

const g = TANK.glass;
const hx = TANK.innerHalf.x;
const hy = TANK.innerHalf.y;
const hz = TANK.innerHalf.z;

/** 关键平面 z / y 坐标 */
export const PLANES = {
  frontOuter: hz + g,   // 前玻璃外表面  z = 16
  frontInner: hz,       // 前玻璃内表面  z = 15
  backInner: -hz,       // 后玻璃内表面  z = -15
  backOuter: -hz - g,   // 后玻璃外表面  z = -16
  rightInner: hx,       // 右侧玻璃内表面 x = 20
  rightOuter: hx + g,   // 右侧玻璃外表面 x = 21
  leftInner: -hx,
  leftOuter: -hx - g,
  bottomInner: 0,
  bottomOuter: -TANK.bottom,
  topY: hy,             // 槽口 y = 15（内腔顶）
  waterY: TANK.waterLevel - hy, // 水面世界坐标 y = 9
} as const;

/** 不透明槽框：截面 2cm 的框条（AABB），区域与玻璃边缘对齐 */
export const FRAME_BARS: { min: V3; max: V3; name: string }[] = (() => {
  const t = 1; // 框条半厚
  const zOut = hz + g + t;
  const xOut = hx + g + t;
  const yB = PLANES.bottomOuter - t;
  const yT = hy + t;
  const bars: { min: V3; max: V3; name: string }[] = [];
  const add = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string) =>
    bars.push({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 + 0 }, name });

  // 四根竖直角柱
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (hx + g);
      const cz = sz * (hz + g);
      add(cx - t, cx + t, yB, yT, cz - t, cz + t, `角柱(${sx > 0 ? '右' : '左'}${sz > 0 ? '前' : '后'})`);
    }
  }
  // 前面 / 后面 上下横框
  for (const sz of [-1, 1]) {
    const cz = sz * (hz + g);
    add(-xOut, xOut, yB - 0, yB + 2 * t, cz - t, cz + t, `下横框(${sz > 0 ? '前' : '后'})`);
    add(-xOut, xOut, hy - t, yT, cz - t, cz + t, `上横框(${sz > 0 ? '前' : '后'})`);
  }
  // 左面 / 右面 上下横框
  for (const sx of [-1, 1]) {
    const cx = sx * (hx + g);
    add(cx - t, cx + t, yB, yB + 2 * t, -zOut, zOut, `侧下横框(${sx > 0 ? '右' : '左'})`);
    add(cx - t, cx + t, hy - t, yT, -zOut, zOut, `侧上横框(${sx > 0 ? '右' : '左'})`);
  }
  // 槽底板（不透明）
  add(-xOut, xOut, PLANES.bottomOuter, PLANES.bottomInner, -zOut, zOut, '槽底');
  return bars;
})();

/** 后标尺：贴在后玻璃之后的整面网格板 */
export const BACK_RULER = {
  x0: -hx, x1: hx,
  y0: PLANES.bottomInner, y1: hy,
  z: PLANES.backOuter - 0.4,
} as const;

/** 前标尺：前玻璃左侧框条旁的竖直刻度条（不透明，直接读数） */
export const FRONT_RULER = {
  x0: -hx - g - 3.2, x1: -hx - g - 0.2,
  y0: PLANES.bottomInner, y1: hy,
  z: PLANES.frontOuter + 0.35,
} as const;

/** 水中不透明方块 */
export const BLOCKS: { name: string; min: V3; max: V3; color: number }[] = [
  { name: '方块 A', min: { x: -12, y: 1, z: -10 }, max: { x: -8, y: 5, z: -6 }, color: 0xff8a65 },
  { name: '方块 B', min: { x: 2, y: 2, z: -8 }, max: { x: 6, y: 6, z: -4 }, color: 0x9ccc65 },
  { name: '方块 C', min: { x: -4, y: 6, z: 2 }, max: { x: 0, y: 10, z: 6 }, color: 0xba68c8 },
];

/** 世界逃逸边界（超出此范围判定为离开可用槽体） */
export const WORLD_BOUNDS = {
  min: { x: -45, y: -12, z: -40 },
  max: { x: 45, y: 35, z: 45 },
} as const;

export interface V3 { x: number; y: number; z: number }
