// 预置房间。所有状态均可由 LevelDef 重建，实现“重来后完全复原”。
//
// 地图 12 列 × 9 行，四周墙，右侧 (11,4) 是出口门。
// 两块 3x3 步道 A/B 横在房间中部，中间列 x=5 整列空洞，两板隔坑相望，
// 只有各自转到东西两侧同时开口时，端口在 (4,4)/(6,4) 对口才能跨过去。
//
// 每块步道初始有 3 个端口：北 / 西 / 南（唯独缺东）。
// 顺时针转 90° 后变为 东 / 北 / 西（缺南）——西侧进、东侧出同时打开，
// 才能沿 西→东 方向穿过；未转动时玩家上得来却向东走不出去。

import type { LevelDef, Vec2 } from './types.js';

const COLS = 12;
const ROWS = 9;

function borderWalls(exit: Vec2): Vec2[] {
  const walls: Vec2[] = [];
  for (let x = 0; x < COLS; x++) {
    for (const y of [0, ROWS - 1]) walls.push({ x, y });
  }
  for (let y = 1; y < ROWS - 1; y++) {
    for (const x of [0, COLS - 1]) walls.push({ x, y });
  }
  return walls.filter((w) => !(w.x === exit.x && w.y === exit.y));
}

const EXIT: Vec2 = { x: 11, y: 4 };
const SPAWN: Vec2 = { x: 1, y: 4 };

const PLATFORM_A = {
  id: 'A' as const,
  origin: { x: 2, y: 3 },
  size: 3,
  orientation: 0,
  // 三端口：北/西/南，缺东。顺时针 90° 后为 东/北/西，缺南。
  ports: [
    { offset: { x: 1, y: 0 }, dir: 'N' as const },
    { offset: { x: 0, y: 1 }, dir: 'W' as const },
    { offset: { x: 1, y: 2 }, dir: 'S' as const },
  ],
};

const PLATFORM_B = {
  id: 'B' as const,
  origin: { x: 6, y: 3 },
  size: 3,
  orientation: 0,
  ports: [
    { offset: { x: 1, y: 0 }, dir: 'N' as const },
    { offset: { x: 0, y: 1 }, dir: 'W' as const },
    { offset: { x: 1, y: 2 }, dir: 'S' as const },
  ],
};

const LEVERS: Vec2[] = [
  { x: 3, y: 7 },
  { x: 7, y: 7 },
];

const PITS: Vec2[] = [
  { x: 5, y: 1 },
  { x: 5, y: 2 },
  { x: 5, y: 3 },
  { x: 5, y: 4 },
  { x: 5, y: 5 },
  { x: 5, y: 6 },
  { x: 5, y: 7 },
];

/** 房间 1：按 A、B 顺序各顺时针转一次即可走到出口 */
export function createSolvableLevel(): LevelDef {
  return {
    id: 'solvable',
    name: '房间 1：分段对接（可通关）',
    cols: COLS,
    rows: ROWS,
    cells: {
      wall: borderWalls(EXIT),
      pit: PITS,
      rail: [],
      floor: [],
    },
    platforms: [structuredClone(PLATFORM_A), structuredClone(PLATFORM_B)],
    levers: structuredClone(LEVERS),
    spawn: structuredClone(SPAWN),
    exit: structuredClone(EXIT),
  };
}

/**
 * 房间 2：转到一半遇挡。
 * 直接 SAT 几何验证的结论：3x3 方板旋转时，贴邻格总会在某方向起步阶段（1~5°）
 * 被旋转的边擦到，只有对角格能让旋转顶点走到约 40° 才进入——这是相邻栏杆
 * 能做到的最晚接触。在步道 A 右上角外的对角格 (4,2) 设一根栏杆：
 * 顺时针转动时平台顶点约 40° 才撞上墙角（半程截停），被挡则原位与原通路保留。
 * 玩家初始就站在 A 上，用于验证“载人转动被墙角截住”。
 */
export function createBlockedLevel(): LevelDef {
  const level = createSolvableLevel();
  level.id = 'blocked';
  level.name = '房间 2：栏杆截停（转到一半遇挡）';
  level.cells.rail = [{ x: 4, y: 2 }];
  level.spawn = { x: 3, y: 4 };
  return level;
}

export const LEVEL_FACTORIES = [createSolvableLevel, createBlockedLevel];
