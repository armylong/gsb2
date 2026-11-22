import type { WorldPreset } from './types';

/**
 * 有限测试场地（1000×600，单屏无需滚动，便于同屏录制画面与读数）：
 * - 四周地面 / 墙
 * - 一块低顶（验证撞顶停止上升）
 * - 三级静止台阶
 * - 水平、垂直往返移动平台各一
 */
export const WORLD: WorldPreset = {
  width: 1000,
  height: 600,
  player: { x: 60, y: 520, w: 28, h: 44 },
  statics: [
    { id: 'ground', label: '地面', x: 0, y: 564, w: 1000, h: 36, kind: 'ground' },
    { id: 'wall-l', label: '左墙', x: 0, y: 0, w: 16, h: 600, kind: 'wall' },
    { id: 'wall-r', label: '右墙', x: 984, y: 0, w: 16, h: 600, kind: 'wall' },
    // 低顶：净高 200 - 148 = 52，仅容站立；起跳必然撞顶
    { id: 'ceiling', label: '低顶', x: 300, y: 148, w: 210, h: 24, kind: 'ceiling' },
    // 静止台阶三级
    { id: 'step-1', label: '台阶1', x: 150, y: 516, w: 96, h: 48, kind: 'step' },
    { id: 'step-2', label: '台阶2', x: 270, y: 476, w: 84, h: 88, kind: 'step' },
    { id: 'step-3', label: '台阶3', x: 560, y: 500, w: 90, h: 64, kind: 'step' },
  ],
  platforms: [
    {
      id: 'plat-h',
      label: '水平平台',
      w: 130,
      h: 18,
      baseX: 420,
      baseY: 392,
      axis: 'horizontal',
      range: 120,
      halfPeriod: 2.2,
    },
    {
      id: 'plat-v',
      label: '垂直平台',
      w: 104,
      h: 18,
      baseX: 760,
      baseY: 420,
      axis: 'vertical',
      // 最低位置顶部 420+90=510，与地面顶 564 保持 54px 净空，换向不被地面接管
      range: 90,
      halfPeriod: 2.6,
    },
  ],
};

/** 自动化测试 / 自检用的独立小场地（主场地之外，互不干扰） */
export const TEST_PRESETS: Record<string, WorldPreset> = {
  supportSwitch: {
    width: 700,
    height: 420,
    // 出生在平台正上方（平台初始 x 60..160，顶 y=320）
    player: { x: 76, y: 260, w: 28, h: 44 },
    statics: [
      { id: 'ground', label: '地面', x: 0, y: 380, w: 700, h: 40, kind: 'ground' },
      // 与水平平台同高的固定台面：平台驶过时触发支撑切换
      { id: 'strip', label: '固定台面', x: 300, y: 320, w: 120, h: 60, kind: 'step' },
    ],
    platforms: [
      {
        id: 'plat-h',
        label: '测试水平平台',
        w: 100,
        h: 16,
        baseX: 260,
        baseY: 320,
        axis: 'horizontal',
        range: 200,
        halfPeriod: 2,
      },
    ],
  },
  jump: {
    width: 500,
    height: 420,
    // 出生在平台正上方（平台初始 x 60..160）
    player: { x: 96, y: 260, w: 28, h: 44 },
    statics: [{ id: 'ground', label: '地面', x: 0, y: 380, w: 500, h: 40, kind: 'ground' }],
    platforms: [
      {
        id: 'plat-h',
        label: '测试水平平台',
        w: 100,
        h: 16,
        baseX: 180,
        baseY: 320,
        axis: 'horizontal',
        range: 120,
        halfPeriod: 2,
      },
    ],
  },
  flat: {
    width: 500,
    height: 420,
    player: { x: 40, y: 320, w: 28, h: 44 },
    statics: [
      { id: 'ground', label: '地面', x: 0, y: 380, w: 500, h: 40, kind: 'ground' },
      { id: 'wall-l', label: '左墙', x: 0, y: 0, w: 12, h: 380, kind: 'wall' },
      { id: 'wall-r', label: '右墙', x: 488, y: 0, w: 12, h: 380, kind: 'wall' },
    ],
    platforms: [],
  },
  edge: {
    width: 500,
    height: 420,
    // 直接出生在台面右缘，向右走即落（台面顶 y=344，角色脚底对齐）
    player: { x: 300, y: 300, w: 28, h: 44 },
    statics: [
      { id: 'ground', label: '地面', x: 0, y: 380, w: 500, h: 40, kind: 'ground' },
      { id: 'ledge', label: '悬空台沿', x: 200, y: 344, w: 130, h: 16, kind: 'step' },
    ],
    platforms: [],
  },
  ceiling: {
    width: 500,
    height: 420,
    // 出生在低顶正下方；站立头顶 y=276，低顶底 y=280，间隙 4px，起跳即撞
    player: { x: 220, y: 276, w: 28, h: 44 },
    statics: [
      { id: 'ground', label: '地面', x: 0, y: 380, w: 500, h: 40, kind: 'ground' },
      { id: 'ceiling', label: '低顶', x: 150, y: 200, w: 200, h: 80, kind: 'ceiling' },
      { id: 'wall-l', label: '左墙', x: 0, y: 0, w: 12, h: 380, kind: 'wall' },
      { id: 'wall-r', label: '右墙', x: 488, y: 0, w: 12, h: 380, kind: 'wall' },
    ],
    platforms: [],
  },
  platformRide: {
    width: 600,
    height: 420,
    // 出生在水平移动平台正上方，落下即建立支撑
    player: { x: 96, y: 260, w: 28, h: 44 },
    statics: [{ id: 'ground', label: '地面', x: 0, y: 380, w: 600, h: 40, kind: 'ground' }],
    platforms: [
      {
        id: 'plat-h',
        label: '水平平台',
        w: 100,
        h: 16,
        baseX: 180,
        baseY: 320,
        axis: 'horizontal',
        range: 150,
        halfPeriod: 1.8,
      },
    ],
  },
};
