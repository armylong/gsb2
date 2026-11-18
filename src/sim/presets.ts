/**
 * 程序生成的布局预设:
 *  P1 bidirectional —— 双向对穿
 *  P2 crossing      —— 十字交汇
 *  P3 pillars       —— 绕柱换位
 *  P4 narrow-gate   —— 窄口过度拥堵对照(不保证解开,如实显示停滞)
 *
 * 每个代理的编号即数组下标,起点/目标固定,不写任何预设路径。
 */
import type { AgentSpec, PresetDef, Rect } from './types';
import { WORLD_W, WORLD_H, MAX_AGENTS, MAX_RECTS } from './types';
import { Rng, type Vec } from './math';

const PALETTE = [
  '#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
  '#4dd0e1', '#aed581', '#fff176', '#f06292', '#7986cb',
];

let nextId = 0;
let rng = new Rng(1);

function jittered(p: Vec, amount: number): Vec {
  if (amount <= 0) return p;
  return { x: p.x + rng.range(-amount, amount), y: p.y + rng.range(-amount, amount) };
}

function agent(
  pos: Vec,
  goal: Vec,
  radius = 0.34,
  maxSpeed = 2.4,
  prefSpeed = 2.0,
  maxAccel = 3.6,
  jitter = 0.1,
): AgentSpec {
  // 种子驱动的微小个体差异,使“固定种子”真正决定布局与轨迹
  const r = radius + rng.range(-0.03, 0.03);
  const ps = Math.min(maxSpeed * 0.92, prefSpeed * (1 + rng.range(-0.08, 0.08)));
  return {
    id: nextId++,
    pos: jittered(pos, jitter),
    goal: jittered(goal, jitter),
    radius: r,
    maxSpeed,
    prefSpeed: ps,
    maxAccel,
    color: PALETTE[nextId % PALETTE.length],
  };
}

function linspace(lo: number, hi: number, n: number): number[] {
  if (n === 1) return [(lo + hi) / 2];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

/** P1 双向对穿:左右各 8 个,同排正面对穿 */
function presetBidirectional(): PresetDef {
  nextId = 0;
  const agents: AgentSpec[] = [];
  const rows = linspace(2, WORLD_H - 2, 8);
  for (const y of rows) {
    agents.push(agent({ x: 1.6, y }, { x: WORLD_W - 1.6, y }));
    agents.push(agent({ x: WORLD_W - 1.6, y }, { x: 1.6, y }));
  }
  return {
    key: 'bidirectional',
    name: 'P1 双向对穿',
    desc: '16 个代理分两列迎面穿过,同排正面冲突,ORCA 产生左右偏让',
    timeLimit: 45,
    rects: [],
    agents,
  };
}

/** P2 十字交汇:四个方向各 4 个,在中心区域同时汇合 */
function presetCrossing(): PresetDef {
  nextId = 0;
  const agents: AgentSpec[] = [];
  const hy = linspace(8.8, 11.8, 4);
  for (const y of hy) {
    agents.push(
      agent({ x: 1.5, y }, { x: WORLD_W - 1.5, y }, 0.32, 2.3, 1.9, 3.4),
    );
    agents.push(
      agent({ x: WORLD_W - 1.5, y }, { x: 1.5, y }, 0.32, 2.3, 1.9, 3.4),
    );
  }
  const vx = linspace(13.5, 16.5, 4);
  for (const x of vx) {
    agents.push(
      agent({ x, y: 1.5 }, { x, y: WORLD_H - 1.5 }, 0.32, 2.3, 1.9, 3.4),
    );
    agents.push(
      agent({ x, y: WORLD_H - 1.5 }, { x, y: 1.5 }, 0.32, 2.3, 1.9, 3.4),
    );
  }
  return {
    key: 'crossing',
    name: 'P2 十字交汇',
    desc: '横向与纵向各 8 个代理在中心十字交汇,需要交错让行',
    timeLimit: 45,
    rects: [],
    agents,
  };
}

/** P3 绕柱换位:三根立柱,两侧代理对穿并绕柱 */
function presetPillars(): PresetDef {
  nextId = 0;
  const rects: Rect[] = [
    { x: 8, y: 8.5, w: 2, h: 3 },
    { x: 14, y: 8.5, w: 2, h: 3 },
    { x: 20, y: 8.5, w: 2, h: 3 },
  ];
  const agents: AgentSpec[] = [];
  const rows = [2, 5, 8, 12, 15, 18];
  for (const y of rows) {
    agents.push(
      agent({ x: 1.8, y }, { x: WORLD_W - 1.8, y }, 0.35, 2.4, 2.0, 3.6),
    );
    agents.push(
      agent({ x: WORLD_W - 1.8, y }, { x: 1.8, y }, 0.35, 2.4, 2.0, 3.6),
    );
  }
  return {
    key: 'pillars',
    name: 'P3 绕柱换位',
    desc: '12 个代理绕过 3 根静态立柱对穿,避障计入角色半径',
    timeLimit: 60,
    rects,
    agents,
  };
}

/** P4 窄口拥堵对照:1.6 单位缺口,14 个代理双向汇聚 */
function presetNarrowGate(): PresetDef {
  nextId = 0;
  const rects: Rect[] = [
    { x: 8, y: 0, w: 14, h: 9.2 },
    { x: 8, y: 10.8, w: 14, h: 9.2 },
  ];
  const agents: AgentSpec[] = [];
  const rows = linspace(2, 18, 7);
  for (const y of rows) {
    agents.push(
      agent({ x: 1.8, y }, { x: WORLD_W - 1.8, y }, 0.3, 2.2, 1.8, 3.2),
    );
    agents.push(
      agent({ x: WORLD_W - 1.8, y }, { x: 1.8, y }, 0.3, 2.2, 1.8, 3.2),
    );
  }
  return {
    key: 'narrow-gate',
    name: 'P4 窄口拥堵(对照)',
    desc: '双向 14 个代理挤向 1.6 单位窄口,可能持续停滞,系统如实报告',
    timeLimit: 75,
    rects,
    agents,
    stress: true,
  };
}

/** 故意制造初始重叠的布局,用于验证“标出问题并暂停该布局” */
export function makeOverlapDemo(): PresetDef {
  nextId = 0;
  rng = new Rng(99);
  const rects: Rect[] = [{ x: 10, y: 10, w: 3, h: 3 }];
  const agents: AgentSpec[] = [
    agent({ x: 5, y: 5 }, { x: 25, y: 15 }, 0.34, 2.4, 2.0, 3.6, 0),
    agent({ x: 5.4, y: 5 }, { x: 25, y: 5 }, 0.34, 2.4, 2.0, 3.6, 0), // 与 0 号重叠(直径 0.68)
    agent({ x: 11.5, y: 11.5 }, { x: 25, y: 3 }, 0.34, 2.4, 2.0, 3.6, 0), // 落在矩形内部
  ];
  return {
    key: 'overlap-demo',
    name: '初始重叠演示',
    desc: '故意制造代理重叠与入墙,布局应被暂停并标红,而非当作已安全避开',
    timeLimit: 30,
    rects,
    agents,
  };
}

export function buildPresets(seed: number): PresetDef[] {
  rng = new Rng(seed >>> 0);
  const presets = [
    presetBidirectional(),
    presetCrossing(),
    presetPillars(),
    presetNarrowGate(),
  ];
  for (const p of presets) {
    if (p.agents.length > MAX_AGENTS || p.rects.length > MAX_RECTS) {
      throw new Error(`预设 ${p.key} 超出场景容量限制`);
    }
  }
  return presets;
}
