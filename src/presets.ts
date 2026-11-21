import { Simulation } from './engine.ts';

export const GRID_W = 21;
export const GRID_H = 16;

export interface Preset {
  id: string;
  name: string;
  hint: string;
  build(): Simulation;
}

/** 四周外墙，内部清空 */
function boxed(): Simulation {
  const sim = new Simulation(GRID_W, GRID_H);
  for (let x = 0; x < GRID_W; x++) {
    sim.setWall(x, 0, true);
    sim.setWall(x, GRID_H - 1, true);
  }
  for (let y = 0; y < GRID_H; y++) {
    sim.setWall(0, y, true);
    sim.setWall(GRID_W - 1, y, true);
  }
  return sim;
}

/**
 * 预设 1：U 形区域 + 全高隔板
 * 左室底部 4 层水（36），右室底部 4 层油（36），无任何口。
 * 点「移开隔板」后两室连通，可验证无进出口时两种液体各自守恒并按密度分层。
 */
function buildUTube(): Simulation {
  const sim = boxed();
  for (let y = 1; y <= GRID_H - 2; y++) sim.setWall(10, y, true);
  for (let y = 11; y <= 14; y++) {
    for (let x = 1; x <= 9; x++) sim.setLiquid(x, y, 1, 0);
    for (let x = 11; x <= 19; x++) sim.setLiquid(x, y, 0, 1);
  }
  return sim;
}

/**
 * 预设 2：狭缝双室
 * 隔墙在 x=10、y=1..12，底部 y=13..14 留出两格高的狭缝。
 * 左室 4 层水（36），右室 2 层油（18），水只能经狭缝流入右室，验证狭缝流动。
 */
function buildSlit(): Simulation {
  const sim = boxed();
  for (let y = 1; y <= 12; y++) sim.setWall(10, y, true);
  for (let y = 11; y <= 14; y++) {
    for (let x = 1; x <= 9; x++) sim.setLiquid(x, y, 1, 0);
  }
  for (let y = 13; y <= 14; y++) {
    for (let x = 11; x <= 19; x++) sim.setLiquid(x, y, 0, 1);
  }
  return sim;
}

/**
 * 预设 3：容器 + 底部排水口（默认关闭）
 * 底部 2 层水、其上 1 层油。用「排水口开关」工具点底部门形格子可开/关，
 * 打开后该口按格抽干液体，右侧统计表记录累计排走量。
 */
function buildDrain(): Simulation {
  const sim = boxed();
  for (let y = 13; y <= 14; y++) {
    for (let x = 1; x <= 19; x++) sim.setLiquid(x, y, 1, 0);
  }
  for (let x = 1; x <= 19; x++) sim.setLiquid(x, 12, 0, 1);
  sim.togglePort(10, 14);
  sim.setPortOpen(10, 14, false);
  return sim;
}

/** 预设 4：空白容器，自由加液/放挡板/开口 */
function buildEmpty(): Simulation {
  return boxed();
}

export const PRESETS: Preset[] = [
  {
    id: 'utube',
    name: 'U形管+隔板',
    hint: '左水右油，无口；点「移开隔板」验证守恒与分层',
    build: buildUTube,
  },
  {
    id: 'slit',
    name: '狭缝双室',
    hint: '隔墙底部留两格狭缝，水只能经狭缝流入右室',
    build: buildSlit,
  },
  {
    id: 'drain',
    name: '容器+排水口',
    hint: '排水口默认关闭，用排水口工具点底部格子开关',
    build: buildDrain,
  },
  { id: 'empty', name: '空白容器', hint: '自由加液、放挡板、开排水口', build: buildEmpty },
];
