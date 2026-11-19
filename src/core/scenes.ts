import { Grid } from './Grid';

/**
 * 三个内置现场（均为 40x24，远小于 100x60 上限）。
 * 设计约束：初始时所有实心块都与底部地基 4 邻接连通（无悬空碎片），
 * 这样用户可以亲手制造第一次切割；各现场同时包含地基、细桥/细柱与空洞。
 */

export interface SceneDef {
  id: string;
  name: string;
  description: string;
  build: () => Grid;
}

const WIDTH = 40;
const HEIGHT = 24;

function emptyGrid(): Grid {
  return new Grid(WIDTH, HEIGHT);
}

function fillRect(grid: Grid, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) grid.set(x, y, 1);
  }
}

function fillFoundation(grid: Grid): void {
  for (let x = 0; x < WIDTH; x++) grid.set(x, HEIGHT - 1, 1);
}

/**
 * 现场 1：切断桥梁。
 * 左右两座山体（底部接地），中间由一条 1 格细桥在 y=12 相连；
 * 桥中央 (20,12) 上方立着一根细柱，撑起一块平台 (x14..26, y8..10)。
 * 细桥不断时整块平台经细柱-桥-山体接地；挖断桥的任一格，
 * 平台、细柱与桥身整体转出为一个碎片。
 */
function buildBridge(): Grid {
  const grid = emptyGrid();
  fillFoundation(grid);
  // 左右山体（顶部 y=12，与桥行同高度，保证正交相连）
  fillRect(grid, 0, 12, 12, HEIGHT - 2);
  fillRect(grid, 28, 12, WIDTH - 1, HEIGHT - 2);
  // 1 格细桥（y=12，x13..27），两端与山体正交相连
  for (let x = 13; x <= 27; x++) grid.set(x, 12, 1);
  // 细柱 (20,11) 撑起平台 (x14..26, y8..10)
  fillRect(grid, 14, 8, 26, 10);
  grid.set(20, 11, 1);
  return grid;
}

/**
 * 现场 2：多块同时掉落。
 * 三个互相分离的岩体 (x3..9 / x16..22 / x29..35, y3..6)，
 * 各由一根 1 格细柱 (x6 / x19 / x32, y7..17) 撑到地基。
 * 在 y=12 做一次矩形横扫即可同时切断三根柱子，三个块同一次编辑全部转出。
 */
function buildMulti(): Grid {
  const grid = emptyGrid();
  fillFoundation(grid);
  const blocks: Array<[number, number]> = [
    [3, 9],
    [16, 22],
    [29, 35],
  ];
  for (const [x0, x1] of blocks) {
    fillRect(grid, x0, 3, x1, 6);
    const cx = Math.floor((x0 + x1) / 2);
    for (let y = 7; y <= HEIGHT - 2; y++) grid.set(cx, y, 1);
  }
  return grid;
}

/**
 * 现场 3：仅对角接触。
 * 左右两个岩体各自由一根细柱撑到地基，4 邻接下是两个独立连通块：
 * 底行地基在 x=23..24 处断开两格，使左右两侧的接地路径互不相通；
 * 两岩体之间只在一个角上相碰：右块左下角 (24,9) 与左块右上角 (23,10)。
 * 右柱在右块右缘 x=28、y10 起；左柱在左块正下方 x=20、y15 起。
 * 挖掉右侧细柱 (x=28, y10..22) 后，右岩体整体转出而左岩体不动；
 * 在对角缝 (23,9) 或 (24,10) 补一格则两块合并为同一接地块。
 */
function buildDiagonal(): Grid {
  const grid = emptyGrid();
  fillFoundation(grid);
  // 断开水印之间的两格地基，隔离左右接地路径
  grid.set(23, HEIGHT - 1, 0);
  grid.set(24, HEIGHT - 1, 0);
  // 右岩体 (24..28, 6..9)，左岩体 (18..23, 10..14)：仅 (24,9)-(23,10) 对角
  fillRect(grid, 24, 6, 28, 9);
  fillRect(grid, 18, 10, 23, 14);
  // 右细柱：右岩体右缘列 x=28，从 y10 直连右侧地基
  for (let y = 10; y <= HEIGHT - 2; y++) grid.set(28, y, 1);
  // 左细柱：左块正下方列 x=20，从 y15（紧贴左块底 y14）直连左侧地基
  for (let y = 15; y <= HEIGHT - 2; y++) grid.set(20, y, 1);
  return grid;
}

export const SCENES: readonly SceneDef[] = [
  {
    id: 'bridge',
    name: '切断桥梁',
    description: '挖断 1 格细桥，观察桥上方平台整体失去支撑',
    build: buildBridge,
  },
  {
    id: 'multi',
    name: '多块同时掉落',
    description: '一次矩形挖除切断三根细柱，三块同时转出',
    build: buildMulti,
  },
  {
    id: 'diagonal',
    name: '仅对角接触',
    description: '两岩体只在角上相碰；挖掉右侧细柱，对角接触不构成连接',
    build: buildDiagonal,
  },
];

export function buildScene(id: string): Grid {
  const scene = SCENES.find((s) => s.id === id);
  if (!scene) throw new Error(`未知场景: ${id}`);
  return scene.build();
}
