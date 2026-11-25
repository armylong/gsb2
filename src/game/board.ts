import {
  directionOf,
  edgeKey,
  inBounds,
  isBorder,
  isOppositeCrossing,
  sameVertex,
  vKey,
} from './geometry';
import type {
  CrossingDiagnosis,
  GameState,
  Port,
  Puzzle,
  RibbonDiagnosis,
  Vertex,
} from './types';

/** 题面静态校验：返回全部错误，空数组表示合法。 */
export function validatePuzzle(puzzle: Puzzle): string[] {
  const errors: string[] = [];
  const { width, height, ports, holes, targets } = puzzle;
  if (width < 2 || height < 2) errors.push('织框至少要 2×2 个格');

  const portKeys = new Set<string>();
  const byColor = new Map<string, Port[]>();
  for (const p of ports) {
    const key = vKey(p.vertex);
    if (!inBounds(p.vertex, width, height)) {
      errors.push(`端口 ${p.label} 超出织框`);
      continue;
    }
    if (!isBorder(p.vertex, width, height)) {
      errors.push(`端口 ${p.label} 必须在边框上`);
    }
    if (portKeys.has(key)) errors.push(`格点 ${key} 上有重复端口`);
    portKeys.add(key);
    const list = byColor.get(p.color) ?? [];
    list.push(p);
    byColor.set(p.color, list);
  }
  for (const [color, list] of byColor) {
    if (list.length !== 2) {
      errors.push(`颜色 ${color} 需要恰好一对入口/出口`);
      continue;
    }
    const kinds = list.map((p) => p.kind).sort().join(',');
    if (kinds !== 'entry,exit') {
      errors.push(`颜色 ${color} 的两个端口必须一个是入口、一个是出口`);
    }
    if (sameVertex(list[0].vertex, list[1].vertex)) {
      errors.push(`颜色 ${color} 的入口与出口不能在同一格点`);
    }
  }

  const holeKeys = new Set<string>();
  for (const h of holes) {
    const key = vKey(h);
    if (!inBounds(h, width, height)) {
      errors.push(`禁用孔 ${key} 超出织框`);
      continue;
    }
    if (portKeys.has(key)) errors.push(`禁用孔 ${key} 与端口重合`);
    if (holeKeys.has(key)) errors.push(`禁用孔 ${key} 重复`);
    holeKeys.add(key);
  }

  for (const t of targets) {
    const key = vKey(t.vertex);
    if (!inBounds(t.vertex, width, height)) {
      errors.push(`目标点 ${key} 超出织框`);
      continue;
    }
    if (holeKeys.has(key)) errors.push(`目标点 ${key} 落在禁用孔上`);
    if (portKeys.has(key)) errors.push(`目标点 ${key} 落在端口上`);
    if (!byColor.has(t.color)) {
      errors.push(`目标点 ${key} 要求的颜色 ${t.color} 没有对应端口`);
    }
  }
  return errors;
}

export function holeSet(puzzle: Puzzle): Set<string> {
  return new Set(puzzle.holes.map(vKey));
}

export function portsOf(puzzle: Puzzle, color: string): [Port, Port] {
  const entry = puzzle.ports.find((p) => p.color === color && p.kind === 'entry');
  const exit = puzzle.ports.find((p) => p.color === color && p.kind === 'exit');
  if (!entry || !exit) throw new Error(`颜色 ${color} 缺少端口`);
  return [entry, exit];
}

export function allColors(puzzle: Puzzle): string[] {
  const seen: string[] = [];
  for (const p of puzzle.ports) {
    if (!seen.includes(p.color)) seen.push(p.color);
  }
  return seen;
}

/** 某颜色当前占用的格边键。 */
export function edgesOfColor(state: GameState, color: string): string[] {
  return Object.entries(state.edges)
    .filter(([, c]) => c === color)
    .map(([k]) => k);
}

/** 某颜色的邻接表（格点键 -> 相邻格点）。 */
export function adjacencyOfColor(
  state: GameState,
  color: string,
): Map<string, Vertex[]> {
  const adj = new Map<string, Vertex[]>();
  for (const key of edgesOfColor(state, color)) {
    const [a, b] = key.split('|').map((part) => {
      const [x, y] = part.split(',').map(Number);
      return { x, y } as Vertex;
    });
    const ka = vKey(a);
    const kb = vKey(b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(b);
    adj.get(kb)!.push(a);
  }
  return adj;
}

/** 全棋盘每格点的占用情况：颜色 -> 方向集合。 */
export function occupancyAtVertices(
  state: GameState,
): Map<string, Map<string, Set<'L' | 'R' | 'U' | 'D'>>> {
  const map = new Map<string, Map<string, Set<'L' | 'R' | 'U' | 'D'>>>();
  for (const [key, color] of Object.entries(state.edges)) {
    const [a, b] = key.split('|').map((part) => {
      const [x, y] = part.split(',').map(Number);
      return { x, y } as Vertex;
    });
    for (const [v, other] of [
      [a, b],
      [b, a],
    ] as Array<[Vertex, Vertex]>) {
      const k = vKey(v);
      if (!map.has(k)) map.set(k, new Map());
      const at = map.get(k)!;
      if (!at.has(color)) at.set(color, new Set());
      at.get(color)!.add(directionOf(v, other));
    }
  }
  return map;
}

export interface CrossingInfo {
  vertex: Vertex;
  colors: string[];
  valid: boolean;
}

/** 找出所有混色格点；只有对边穿压才算合法交叉。 */
export function detectCrossings(state: GameState): CrossingInfo[] {
  const result: CrossingInfo[] = [];
  const occ = occupancyAtVertices(state);
  for (const [key, at] of occ) {
    if (at.size < 2) continue;
    const directions = new Map(
      [...at.entries()].map(([color, dirs]) => [color, [...dirs]]),
    );
    const [x, y] = key.split(',').map(Number);
    result.push({
      vertex: { x, y },
      colors: [...at.keys()],
      valid: isOppositeCrossing(directions),
    });
  }
  return result.sort((a, b) => vKey(a.vertex).localeCompare(vKey(b.vertex)));
}

/**
 * 交叉点顶层颜色裁定：
 * 1. 玩家在 tops 中显式指定且颜色仍在场 -> 用指定值；
 * 2. 否则按题面端口声明序自动裁定（排在前面的颜色在顶层），保证未指定时也有确定判断。
 */
export function resolveTop(
  puzzle: Puzzle,
  state: GameState,
  vertex: Vertex,
  colors: string[],
): string | null {
  const key = vKey(vertex);
  const manual = state.tops[key];
  if (manual && colors.includes(manual)) return manual;
  if (colors.length === 0) return null;
  const order = (c: string): number =>
    puzzle.ports.findIndex((p) => p.color === c);
  return [...colors].sort((a, b) => order(a) - order(b))[0];
}

function walkPath(adj: Map<string, Vertex[]>, start: Vertex): Vertex[] {
  const path: Vertex[] = [start];
  const visited = new Set<string>([vKey(start)]);
  let prev: Vertex | null = null;
  let cur = start;
  for (;;) {
    const nexts = (adj.get(vKey(cur)) ?? []).filter(
      (n) => !prev || !sameVertex(n, prev),
    );
    if (nexts.length === 0) return path;
    const next = nexts[0];
    if (visited.has(vKey(next))) return path; // 环：停在闭合处
    visited.add(vKey(next));
    path.push(next);
    prev = cur;
    cur = next;
  }
}

function bfsComponent(adj: Map<string, Vertex[]>, start: Vertex): Vertex[] {
  const seen = new Set<string>([vKey(start)]);
  const queue: Vertex[] = [start];
  const out: Vertex[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const n of adj.get(vKey(cur)) ?? []) {
      const k = vKey(n);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return out.sort((a, b) => vKey(a).localeCompare(vKey(b)));
}

/** 追踪一种颜色的全部结构问题。 */
export function traceRibbon(
  puzzle: Puzzle,
  state: GameState,
  color: string,
): RibbonDiagnosis {
  const [entry, exit] = portsOf(puzzle, color);
  const adj = adjacencyOfColor(state, color);
  const crossingKeys = new Set(
    detectCrossings(state).map((c) => vKey(c.vertex)),
  );

  const deadEnds: Vertex[] = [];
  const branches: Vertex[] = [];
  const openPorts: Vertex[] = [];
  if (!adj.has(vKey(entry.vertex))) openPorts.push(entry.vertex);
  if (!adj.has(vKey(exit.vertex))) openPorts.push(exit.vertex);

  for (const [key, ns] of adj) {
    const [x, y] = key.split(',').map(Number);
    const v = { x, y };
    const isPort =
      sameVertex(v, entry.vertex) || sameVertex(v, exit.vertex);
    if (ns.length > 2) branches.push(v);
    if (ns.length === 1 && !isPort) deadEnds.push(v);
  }

  // 连通分量
  const globalVisited = new Set<string>();
  const fragments: Vertex[][] = [];
  for (const key of adj.keys()) {
    if (globalVisited.has(key)) continue;
    const [x, y] = key.split(',').map(Number);
    const comp = bfsComponent(adj, { x, y });
    comp.forEach((v) => globalVisited.add(vKey(v)));
    fragments.push(comp);
  }

  const entryComp = adj.has(vKey(entry.vertex))
    ? bfsComponent(adj, entry.vertex)
    : null;
  const exitReached =
    entryComp?.some((v) => sameVertex(v, exit.vertex)) ?? false;
  const allInOne = fragments.length === 1;
  const endpointsOk =
    (adj.get(vKey(entry.vertex))?.length ?? 0) === 1 &&
    (adj.get(vKey(exit.vertex))?.length ?? 0) === 1;
  const complete =
    allInOne &&
    exitReached &&
    endpointsOk &&
    deadEnds.length === 0 &&
    branches.length === 0;

  let vertices: Vertex[] = [];
  if (complete) {
    vertices = walkPath(adj, entry.vertex);
  } else if (entryComp) {
    vertices = walkPath(adj, entry.vertex);
  } else if (fragments[0]) {
    vertices = fragments[0];
  }

  const ordered = complete
    ? vertices
    : [...adj.keys()]
        .sort()
        .map((k) => {
          const [x, y] = k.split(',').map(Number);
          return { x, y } as Vertex;
        });
  const crossings = ordered.filter((v) => crossingKeys.has(vKey(v)));

  return {
    color,
    complete,
    vertices,
    crossings,
    deadEnds: deadEnds.sort((a, b) => vKey(a).localeCompare(vKey(b))),
    branches: branches.sort((a, b) => vKey(a).localeCompare(vKey(b))),
    fragments,
    openPorts,
  };
}

/** 交叉点完整诊断（含顶层裁定与目标判断）。 */
export function diagnoseCrossing(
  puzzle: Puzzle,
  state: GameState,
  info: CrossingInfo,
): CrossingDiagnosis {
  const top = info.valid
    ? resolveTop(puzzle, state, info.vertex, info.colors)
    : resolveTop(puzzle, state, info.vertex, info.colors);
  const bottom =
    top && info.colors.length === 2
      ? info.colors.find((c) => c !== top) ?? null
      : null;
  const target =
    puzzle.targets.find((t) => sameVertex(t.vertex, info.vertex))?.color ??
    null;
  const targetMet = info.valid && top !== null && target !== null && top === target;
  return {
    vertex: info.vertex,
    colors: info.colors,
    valid: info.valid,
    top,
    bottom,
    target,
    targetMet: target === null ? true : targetMet,
    inConflict: false,
  };
}

/** 当前格边总数（UI 状态展示用）。 */
export function edgeCount(state: GameState): number {
  return Object.keys(state.edges).length;
}

export { edgeKey };
