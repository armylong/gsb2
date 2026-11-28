import { buildMix } from '../core/mix';
import type { LevelDef, PaletteEntry } from '../core/types';

/** 全游戏共用的色彩系统；每关只挑选其中一部分作为可用颜色。 */
export const PALETTE: PaletteEntry[] = [
  { id: 'paper', name: '纸白', css: '#f4ead5', inkOn: 'dark', symbol: '○' },
  { id: 'rust', name: '铁锈红', css: '#c6533c', inkOn: 'light', symbol: '◆' },
  { id: 'indigo', name: '靛青', css: '#33556e', inkOn: 'light', symbol: '●' },
  { id: 'violet', name: '藤紫', css: '#7b5a8c', inkOn: 'light', symbol: '✿' },
  { id: 'brown', name: '焦褐', css: '#8a5b3d', inkOn: 'light', symbol: '▤' },
];

function palette(ids: string[]): PaletteEntry[] {
  return ids.map((id) => {
    const entry = PALETTE.find((p) => p.id === id);
    if (!entry) throw new Error(`调色板缺少颜色 ${id}`);
    return entry;
  });
}

const HOOK4 = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: 2 },
];

const ELBOW3 = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

const PLUS5 = [
  { x: -1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
];

const SQUARE3 = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) }));

const INKS = [
  { id: 'rust', name: '铁锈红', color: 'rust', symbol: '◆' },
  { id: 'indigo', name: '靛青', color: 'indigo', symbol: '●' },
];

/**
 * 第一关的叠色是对称的：铁锈与靛青谁先谁后都得藤紫；
 * 藤紫再叠任意一种墨仍是藤紫，三层也不会跑出既定颜色。
 */
const SYMMETRIC_MIX = [
  { below: 'rust', above: 'indigo', result: 'violet' },
  { below: 'indigo', above: 'rust', result: 'violet' },
  { below: 'violet', above: 'rust', result: 'violet' },
  { below: 'violet', above: 'indigo', result: 'violet' },
];

/**
 * 第二关故意不对称：铁锈在下、靛青在上是藤紫；反过来是焦褐。
 * 复色上的叠印也全部写死，保证三层以上的结果仍由关卡决定。
 */
const ASYMMETRIC_MIX = [
  { below: 'rust', above: 'indigo', result: 'violet' },
  { below: 'indigo', above: 'rust', result: 'brown' },
  { below: 'violet', above: 'rust', result: 'brown' },
  { below: 'violet', above: 'indigo', result: 'violet' },
  { below: 'brown', above: 'rust', result: 'brown' },
  { below: 'brown', above: 'indigo', result: 'violet' },
];

/**
 * 第一关「四角花」：四枚角钩围住中心十字。
 *
 * 参考解：钩四枚各 4 格（共 16 格铁锈），十字五格（5 格靛青），两种墨都恰好用尽。
 * 右上、左下两枚必须翻面才能让孔位朝向棋盘内侧。
 */
export const LEVEL_FLOWER: LevelDef = {
  id: 'four-corner-flower',
  name: '四角花',
  subtitle: '四枚角钩与一枚十字；铁锈 16 格、靛青 5 格，一格都不能多。',
  width: 6,
  height: 6,
  paperColor: 'paper',
  palette: palette(['paper', 'rust', 'indigo', 'violet']),
  inks: INKS,
  mix: buildMix('paper', INKS, SYMMETRIC_MIX),
  budget: { rust: 16, indigo: 5 },
  stencils: [
    {
      id: 'hook',
      name: '角钩四格',
      holes: HOOK4,
      note: '一竖一横；翻面会把横枝换到另一边。',
    },
    {
      id: 'plus',
      name: '十字五格',
      holes: PLUS5,
      note: '定位点就是正中心的那一格。',
    },
    {
      id: 'elbow',
      name: '肘三格',
      holes: ELBOW3,
      note: '短肘；在本关主要用来试探错位。',
    },
  ],
  plan: [
    ['rust', 'rust', 'clean', 'clean', 'rust', 'rust'],
    ['rust', 'clean', 'indigo', 'clean', 'free', 'rust'],
    ['rust', 'indigo', 'indigo', 'indigo', 'free', 'rust'],
    ['rust', 'clean', 'indigo', 'clean', 'free', 'rust'],
    ['rust', 'free', 'free', 'free', 'free', 'rust'],
    ['rust', 'rust', 'clean', 'clean', 'rust', 'rust'],
  ],
  hint: '先把四角钩摆正：右上和左下要翻面。靛青十字放在正中 (3,3)。铁锈 16 格与靛青 5 格都用尽。',
  parStamps: 5,
};

/**
 * 第二关「护心」：整块铁锈上护住中心，再用靛青十字压出藤紫环。
 *
 * 参考解：方三格铁锈 9 格恰好铺满；中心贴挡墨纸时靛青十字只落 4 格。
 * 四条肘三格补满四角，靛青共 16 格恰好用尽。
 * 叠色不对称：铁锈在下、靛青在上是藤紫；反过来是焦褐。
 */
export const LEVEL_HEART: LevelDef = {
  id: 'guarded-heart',
  name: '护心',
  subtitle: '挡墨纸护住中心，靛青十字只染它该染的四格。',
  width: 6,
  height: 6,
  paperColor: 'paper',
  palette: palette(['paper', 'rust', 'indigo', 'violet', 'brown']),
  inks: INKS,
  mix: buildMix('paper', INKS, ASYMMETRIC_MIX),
  budget: { rust: 9, indigo: 16 },
  stencils: [
    {
      id: 'square3',
      name: '方三格',
      holes: SQUARE3,
      note: '3×3 满格，一次铺底。',
    },
    {
      id: 'plus',
      name: '十字五格',
      holes: PLUS5,
      note: '正中心贴纸时只剩四臂可染。',
    },
    {
      id: 'elbow',
      name: '肘三格',
      holes: ELBOW3,
      note: '补角用；转动与翻面能照顾到四只角。',
    },
  ],
  plan: [
    ['indigo', 'indigo', 'clean', 'clean', 'indigo', 'indigo'],
    ['indigo', 'rust', 'violet', 'rust', 'clean', 'indigo'],
    ['clean', 'violet', 'rust', 'violet', 'clean', 'clean'],
    ['clean', 'rust', 'violet', 'rust', 'clean', 'clean'],
    ['indigo', 'clean', 'clean', 'clean', 'free', 'indigo'],
    ['indigo', 'indigo', 'free', 'free', 'indigo', 'indigo'],
  ],
  hint: '先铺 3×3 铁锈；给正中心 (3,3) 贴挡墨纸，再盖靛青十字。拿掉纸后中心仍是铁锈。四个角用肘三格收尾。',
  parStamps: 6,
};

export const LEVELS: LevelDef[] = [LEVEL_FLOWER, LEVEL_HEART];

export function getLevel(id: string): LevelDef {
  const level = LEVELS.find((l) => l.id === id);
  if (!level) throw new Error(`未知关卡：${id}`);
  return level;
}
