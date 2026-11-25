// 内置目标花纹: 目标是一条环形圆带 (rMin, rMax) 加若干必须留白的弧段
// 圆带之外、以及留白弧之内都不允许有颜料

export interface BlankArc {
  /** 起始角 (弧度, 局部坐标系, 0 = 右侧零度线, 顺时针为正) */
  start: number;
  /** 弧长 (弧度), ∈ (0, 2π); start+length 可超过 2π, 表示跨过零度线 */
  length: number;
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  /** 允许涂色的圆带内半径 (逻辑像素) */
  rMin: number;
  /** 允许涂色的圆带外半径 */
  rMax: number;
  /** 必须留白的弧段 */
  blanks: BlankArc[];
}

export const DISC_RADIUS = 260;
export const HUB_RADIUS = 34;

const DEG = Math.PI / 180;

export const PATTERNS: Pattern[] = [
  {
    id: 'double-ring',
    name: '可完成花纹: 双环满涂',
    description:
      '在绿色圆带内涂满整整两圈, 圆带外不能出界。一笔画不完可以抬笔接着画。',
    rMin: 128,
    rMax: 212,
    blanks: [],
  },
  {
    id: 'cross-zero-gap',
    name: '跨零度测试: 留白弧跨过零度线',
    description:
      '红色留白弧从 350° 延伸到 10°, 跨过零度线。测试快速拖过零度时不会画出横穿盘心的线, 且留白弧内不能落色。',
    rMin: 96,
    rMax: 176,
    blanks: [{ start: 350 * DEG, length: 20 * DEG }],
  },
];

export function getPattern(id: string): Pattern {
  const p = PATTERNS.find((x) => x.id === id);
  if (!p) throw new Error(`未知花纹: ${id}`);
  return p;
}
