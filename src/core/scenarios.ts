// 题面定义与构建。
// 两个题面共用同一套规则：
//   A. 交叉题：两条路线在同一格路口叠踩，落脚方向、重量、时刻各不相同；
//   B. 风埋题：两条路线共用一个路口，其中一条中段穿过迎风口被新雪埋掉，
//      需要靠避风区残留 + 浅痕 + 跳格规则把路线接起来。
// 所有抖动都由种子派生，同种子 + 同时刻重开 → 脚印状态逐格一致。

import { deriveRng } from './rng.js';
import {
  DEPTH_JITTER,
  RATE_JITTER,
  WEIGHT_DEPTH,
  ZONE_RATE,
} from './snow.js';
import {
  Dir,
  DIR_VECTORS,
  Impression,
  RouteDef,
  ScenarioDef,
  Zone,
} from './types.js';

const W = 16;
const H = 12;

function emptyGrid(w: number, h: number): Zone[][] {
  return Array.from({ length: h }, () => Array<Zone>(w).fill(Zone.Normal));
}

function fillRect(
  grid: Zone[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: Zone,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) grid[y][x] = z;
  }
}

function dirBetween(
  a: [number, number],
  b: [number, number],
): Dir {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let d = 0 as Dir; d < 4; d++) {
    const [vx, vy] = DIR_VECTORS[d];
    if (vx === dx && vy === dy) return d;
  }
  throw new Error(`路线不相邻: (${a}) → (${b})`);
}

/** 由题面 + 种子构建每格的足迹栈（确定性） */
export function buildImpressions(
  sc: ScenarioDef,
): Map<string, Impression[]> {
  const map = new Map<string, Impression[]>();
  const key = (x: number, y: number): string => `${x},${y}`;

  for (const route of sc.routes) {
    for (let i = 0; i < route.cells.length; i++) {
      const [x, y] = route.cells[i];
      if (sc.zones[y][x] === Zone.Block) {
        throw new Error(`路线 ${route.name} 经过不可走格 (${x},${y})`);
      }
      const dir =
        i < route.cells.length - 1
          ? dirBetween(route.cells[i], route.cells[i + 1])
          : // 末端没有下一格，沿用最后一段的行进方向
            dirBetween(route.cells[i - 1], route.cells[i]);
      const time = route.startTime + i * route.interval;

      // 格内固定的积雪速率抖动：同一格所有足迹共享，重开不变
      const rateRng = deriveRng(sc.seed, `rate:${x}:${y}`);
      const rateJitter = 1 + (rateRng() * 2 - 1) * RATE_JITTER;
      const coverRate = ZONE_RATE[sc.zones[y][x]] * rateJitter;

      // 落脚压深抖动：按 路线+步序 派生
      const depthRng = deriveRng(sc.seed, `depth:${route.id}:${i}`);
      const baseDepth = WEIGHT_DEPTH[route.weight];
      const initialDepth = Math.min(
        0.98,
        Math.max(0.05, baseDepth + (depthRng() * 2 - 1) * DEPTH_JITTER),
      );

      const imp: Impression = {
        routeId: route.id,
        step: i,
        dir,
        weight: route.weight,
        time,
        initialDepth,
        coverRate,
      };
      const k = key(x, y);
      const stack = map.get(k);
      if (stack) stack.push(imp);
      else map.set(k, [imp]);
    }
  }

  // 每格按落脚时刻升序（旧在下，新在上）
  for (const stack of map.values()) {
    stack.sort((a, b) => a.time - b.time || a.routeId - b.routeId);
  }
  return map;
}

/** 路线完整性自检：相邻、不出界、不穿阻挡 */
export function validateRoutes(sc: ScenarioDef): void {
  for (const route of sc.routes) {
    if (route.cells.length < 2) {
      throw new Error(`路线 ${route.name} 至少需要两个格子`);
    }
    for (let i = 0; i < route.cells.length; i++) {
      const [x, y] = route.cells[i];
      if (x < 0 || y < 0 || x >= sc.width || y >= sc.height) {
        throw new Error(`路线 ${route.name} 出界 (${x},${y})`);
      }
      if (sc.zones[y][x] === Zone.Block) {
        throw new Error(`路线 ${route.name} 穿过阻挡 (${x},${y})`);
      }
      if (i > 0) dirBetween(route.cells[i - 1], route.cells[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// 题面 A：交叉题
// ---------------------------------------------------------------------------

function scenarioA(): ScenarioDef {
  const zones = emptyGrid(W, H);
  // 左侧迎风口竖带
  fillRect(zones, 1, 1, 2, 10, Zone.Wind);
  // 右上避风区
  fillRect(zones, 12, 1, 14, 4, Zone.Shelter);
  // 左下避风区
  fillRect(zones, 3, 8, 5, 10, Zone.Shelter);
  // 几块不可走岩石，限制绕行（均避开两条路线）
  fillRect(zones, 2, 2, 3, 3, Zone.Block);
  fillRect(zones, 10, 7, 11, 7, Zone.Block);
  fillRect(zones, 8, 2, 8, 3, Zone.Block);

  // R1：重、晚到，从西向东横穿（穿过迎风口带）
  const r1: RouteDef = {
    id: 1,
    name: 'R1',
    weight: 2,
    startTime: 10,
    interval: 4,
    cells: [
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6],
      [7, 6],
      [8, 6],
      [9, 6], // 路口 (9,6)
      [10, 6],
      [11, 6],
      [12, 6],
      [13, 6],
    ],
  };

  // R2：轻、更早，从左下避风区走向右上避风区
  const r2: RouteDef = {
    id: 2,
    name: 'R2',
    weight: 0,
    startTime: 2,
    interval: 5,
    cells: [
      [4, 9],
      [4, 8],
      [5, 8],
      [5, 7],
      [6, 7],
      [7, 7],
      [8, 7],
      [9, 7],
      [9, 6], // 同一路口 (9,6)，方向朝北
      [9, 5],
      [10, 5],
      [11, 5],
      [12, 5],
      [12, 4],
      [13, 4],
    ],
  };

  return {
    id: 'cross',
    title: '题面 A · 交叉路口',
    description:
      '两条路线在 (9,6) 叠踩：一条重脚印向东、一条轻脚印向北，落脚时刻不同。迎风口的旧脚印快被埋平，避风区里的轻脚印留得更久。',
    width: W,
    height: H,
    zones,
    routes: [r1, r2],
    playerStart: [0, 11],
    initialTime: 65,
    seed: 'snow-cross-01',
  };
}

// ---------------------------------------------------------------------------
// 题面 B：风埋题
// ---------------------------------------------------------------------------

function scenarioB(): ScenarioDef {
  const zones = emptyGrid(W, H);
  // 两条单行迎风口带：每条路线每次穿风只经过一格，
  // 保证「被风埋掉」的断点恰好一格，可以用一次跳格接上
  fillRect(zones, 3, 4, 12, 4, Zone.Wind);
  fillRect(zones, 3, 7, 12, 7, Zone.Wind);
  // 左上、右下避风区
  fillRect(zones, 1, 1, 3, 3, Zone.Shelter);
  fillRect(zones, 13, 9, 15, 11, Zone.Shelter);
  // 岩石阻挡
  fillRect(zones, 6, 2, 7, 2, Zone.Block);
  fillRect(zones, 10, 10, 11, 10, Zone.Block);
  fillRect(zones, 0, 6, 1, 6, Zone.Block);

  // R1：重、最早，从左上避风区出发，穿过两条风带，进右下避风区
  const r1: RouteDef = {
    id: 1,
    name: 'R1',
    weight: 2,
    startTime: 5,
    interval: 4,
    cells: [
      [2, 2],
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
      [5, 4],
      [5, 5],
      [5, 6],
      [5, 7],
      [5, 8],
      [6, 8],
      [7, 8],
      [8, 8],
      [9, 8], // 路口 (9,8)，方向朝东
      [10, 8],
      [11, 8],
      [12, 8],
      [13, 8],
      [13, 9],
      [14, 9],
    ],
  };

  // R2：中、稍晚，从西侧上来，在 (9,8) 共用路口后向北
  const r2: RouteDef = {
    id: 2,
    name: 'R2',
    weight: 1,
    startTime: 12,
    interval: 4,
    cells: [
      [4, 9],
      [5, 9],
      [6, 9],
      [7, 9],
      [8, 9],
      [9, 9],
      [9, 8], // 同一路口 (9,8)，方向朝北
      [9, 7],
      [9, 6],
      [9, 5],
      [10, 5],
      [11, 5],
      [12, 5],
      [13, 5],
    ],
  };

  return {
    id: 'wind-buried',
    title: '题面 B · 风埋中段',
    description:
      '一条路线的中段连续穿过迎风口，脚印被新雪埋到只剩浅痕甚至消失；两条路线在 (9,8) 共用路口但去向不同。用跳格把断开的线索接起来。',
    width: W,
    height: H,
    zones,
    routes: [r1, r2],
    playerStart: [0, 0],
    initialTime: 70,
    seed: 'snow-wind-02',
  };
}

export const SCENARIOS: ScenarioDef[] = [scenarioA(), scenarioB()];

export function getScenario(id: string): ScenarioDef {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`未知题面: ${id}`);
  validateRoutes(s);
  return s;
}
