/**
 * 内置装配与展开预设
 *
 * 坐标系: Y 轴向上, 尺寸单位为任意世界单位(可理解为厘米)。
 * 零件 id 同时是 src/geometry/factories.ts 里的建模入口。
 */
import type { EditorConfig, PartDef, Vec3Tuple } from './types';

/** 零件 id 常量, 建模与 UI 共用 */
export const PART_IDS = {
  housing: 'housing',
  hingePin: 'hingePin',
  cover: 'cover',
  coverScrewA1: 'coverScrewA1',
  coverScrewA2: 'coverScrewA2',
  coverWasherA1: 'coverWasherA1',
  coverWasherA2: 'coverWasherA2',
  bracket: 'bracket',
  bracketScrewB1: 'bracketScrewB1',
  bracketScrewB2: 'bracketScrewB2',
  bracketWasherB1: 'bracketWasherB1',
  bracketWasherB2: 'bracketWasherB2',
} as const;

/** 铰链轴位置(世界坐标), 翻盖预览绕穿过该点、平行 X 的轴旋转 */
export const HINGE_POINT: Vec3Tuple = [0, 3.125, -2];

/** A 组(盖板紧固件)孔位, 相对盖板局部空间 */
const A_POS: Vec3Tuple[] = [
  [-2.2, 0.125, -1.1],
  [2.2, 0.125, -1.1],
];
/** B 组(内支架紧固件)孔位, 相对支架局部空间; 支架节点位于板件中心, y=0.12 即板顶面 */
const B_POS: Vec3Tuple[] = [
  [-1.4, 0.12, 0],
  [1.4, 0.12, 0],
];

/**
 * 合法装拆顺序(可以来回装合):
 * 第一段: 先抽出铰链销轴 -> 再整体提起盖板组件(螺钉/垫片作为子节点跟随)
 * 第二段: 先从盖板上拧出 A 组螺钉垫片 -> 再抽出壳内 B 组紧固件 -> 最后取出内支架
 */
export function buildValidConfig(): EditorConfig {
  const parts: PartDef[] = [
    {
      id: PART_IDS.housing,
      name: '外壳',
      parentId: null,
      position: [0, 0, 0],
      step: null,
    },
    {
      id: PART_IDS.hingePin,
      name: '铰链销轴',
      parentId: null,
      position: [0, 3.125, -2],
      step: { phase: 0, start: 0.0, end: 0.35, dir: [-1, 0, 0], distance: 3.4 },
    },
    {
      id: PART_IDS.cover,
      name: '盖板组件',
      parentId: null,
      position: [0, 3.125, 0],
      step: { phase: 0, start: 0.45, end: 1.0, dir: [0, 1, 0], distance: 2.4 },
    },
    {
      id: PART_IDS.coverWasherA1,
      name: '盖板垫片 A1',
      parentId: PART_IDS.cover,
      position: A_POS[0],
      step: { phase: 1, start: 0.0, end: 0.35, dir: [0, 1, 0], distance: 1.0 },
    },
    {
      id: PART_IDS.coverWasherA2,
      name: '盖板垫片 A2',
      parentId: PART_IDS.cover,
      position: A_POS[1],
      step: { phase: 1, start: 0.0, end: 0.35, dir: [0, 1, 0], distance: 1.0 },
    },
    {
      id: PART_IDS.coverScrewA1,
      name: '盖板螺钉 A1',
      parentId: PART_IDS.cover,
      position: A_POS[0],
      step: { phase: 1, start: 0.0, end: 0.45, dir: [0, 1, 0], distance: 1.6 },
    },
    {
      id: PART_IDS.coverScrewA2,
      name: '盖板螺钉 A2',
      parentId: PART_IDS.cover,
      position: A_POS[1],
      step: { phase: 1, start: 0.0, end: 0.45, dir: [0, 1, 0], distance: 1.6 },
    },
    {
      id: PART_IDS.bracket,
      name: '内支架',
      parentId: null,
      position: [0, 0.65, 0],
      step: { phase: 1, start: 0.55, end: 1.0, dir: [0, 1, 0], distance: 2.2 },
    },
    {
      id: PART_IDS.bracketWasherB1,
      name: '支架垫片 B1',
      parentId: PART_IDS.bracket,
      position: B_POS[0],
      step: { phase: 1, start: 0.05, end: 0.4, dir: [0, 1, 0], distance: 1.8 },
    },
    {
      id: PART_IDS.bracketWasherB2,
      name: '支架垫片 B2',
      parentId: PART_IDS.bracket,
      position: B_POS[1],
      step: { phase: 1, start: 0.05, end: 0.4, dir: [0, 1, 0], distance: 1.8 },
    },
    {
      id: PART_IDS.bracketScrewB1,
      name: '支架螺钉 B1',
      parentId: PART_IDS.bracket,
      position: B_POS[0],
      step: { phase: 1, start: 0.05, end: 0.5, dir: [0, 1, 0], distance: 2.2 },
    },
    {
      id: PART_IDS.bracketScrewB2,
      name: '支架螺钉 B2',
      parentId: PART_IDS.bracket,
      position: B_POS[1],
      step: { phase: 1, start: 0.05, end: 0.5, dir: [0, 1, 0], distance: 2.2 },
    },
  ];

  return {
    version: 1,
    name: '合法装拆顺序',
    parts,
    collisionIgnore: [
      // 铰链销轴与外壳耳片、盖板耳片是同轴配合面, 抽销轴过程中的重叠属于设计配合
      { a: PART_IDS.hingePin, b: PART_IDS.housing },
      { a: PART_IDS.hingePin, b: PART_IDS.cover },
      // 同孔螺钉与垫片是共拆紧固件, 抽出时短暂同向重叠属于正常装配关系
      { a: PART_IDS.coverScrewA1, b: PART_IDS.coverWasherA1 },
      { a: PART_IDS.coverScrewA2, b: PART_IDS.coverWasherA2 },
      { a: PART_IDS.bracketScrewB1, b: PART_IDS.bracketWasherB1 },
      { a: PART_IDS.bracketScrewB2, b: PART_IDS.bracketWasherB2 },
    ],
  };
}

/**
 * 顺序冲突示例:
 * 把壳内 B 组紧固件(及内支架)的爆炸错误地排进第一段, 同时盖板组件与铰链销轴
 * 被推迟到第二段 —— 第一段里盖板仍然封闭盖在外壳上, B 组螺钉沿装配方向(+Y)
 * 抽出时会一头撞上盖板底面、永远越不过盖板顶端面, 干涉检测应标出:
 * 相交零件 = 支架螺钉/垫片 vs 盖板, 出问题的进度段 = 第一段。
 * 把这些零件改回第二段(恢复「先开盖后拆钉」的顺序)后提示自动消失。
 */
export function buildConflictConfig(): EditorConfig {
  const config = buildValidConfig();
  const wrongPhaseIds = new Set<string>([
    PART_IDS.bracketScrewB1,
    PART_IDS.bracketScrewB2,
    PART_IDS.bracketWasherB1,
    PART_IDS.bracketWasherB2,
  ]);
  config.name = '顺序冲突示例(盖板未开先抽壳内螺钉)';
  for (const part of config.parts) {
    if (wrongPhaseIds.has(part.id) && part.step) {
      // B 组紧固件错误地提到第一段, 而盖板此时还封闭着
      part.step = { ...part.step, phase: 0, start: 0.25, end: 0.95 };
    }
    if (part.id === PART_IDS.cover && part.step) {
      // 盖板开盖被推迟到第二段, 第一段全程保持封闭
      part.step = { ...part.step, phase: 1, start: 0.05, end: 0.55 };
    }
    if (part.id === PART_IDS.hingePin && part.step) {
      // 销轴也跟着推迟, 保证第一段盖板无法绕铰链翻开
      part.step = { ...part.step, phase: 1, start: 0.0, end: 0.3 };
    }
  }
  return config;
}

/** 深拷贝配置, 预设切换时不能让编辑污染原始工厂数据 */
export function cloneConfig(config: EditorConfig): EditorConfig {
  return JSON.parse(JSON.stringify(config)) as EditorConfig;
}
