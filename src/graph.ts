// 群岛潮汐传送 —— 状态图算法
//
// 状态 = (岛, 卡面)。边 = 一次完整操作：
//   1. 岛上若有潮钟，可免费把卡面换成另一面（cost 0，且不消耗翻卡）
//   2. 从某扇门按当前卡面规则传送（flip=true 记一次翻卡）
//
// 玩家走过的路径完全不参与这里的任何判断：算法每次从“给定状态”重新遍历全图。

import { ISLANDS, findGate } from './data.js';
import type { GraphState, Side } from './types.js';

export function stateKey(islandId: string, side: Side): GraphState {
  return `${islandId}:${side}`;
}

export function parseState(key: GraphState): { islandId: string; side: Side } {
  const [islandId, side] = key.split(':');
  return { islandId, side: side as Side };
}

export interface GraphEdge {
  from: GraphState;
  to: GraphState;
  gateId: string;
  flip: boolean;
  /** 标记这是潮钟换面产生的边，而不是过门 */
  viaClock: boolean;
}

const ALL_STATES: GraphState[] = ISLANDS.flatMap((isl) => [
  stateKey(isl.id, 'tide'),
  stateKey(isl.id, 'ebb'),
]);

/** 展开状态图的全部有向边 */
export function buildEdges(): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const isl of ISLANDS) {
    for (const side of ['tide', 'ebb'] as Side[]) {
      const from = stateKey(isl.id, side);

      // 潮钟：同岛换面，cost 0
      if (isl.hasClock) {
        const other: Side = side === 'tide' ? 'ebb' : 'tide';
        edges.push({
          from,
          to: stateKey(isl.id, other),
          gateId: '',
          flip: false,
          viaClock: true,
        });
      }

      // 门：封死的门（单向门背面）没有任何出边
      for (const g of isl.gates) {
        if (g.sealed) continue;
        const rule = side === 'tide' ? g.tide : g.ebb;
        if (!rule) continue;
        const nextSide: Side = rule.flip
          ? side === 'tide'
            ? 'ebb'
            : 'tide'
          : side;
        edges.push({
          from,
          to: stateKey(rule.toIsland, nextSide),
          gateId: g.id,
          flip: rule.flip,
          viaClock: false,
        });
      }
    }
  }
  return edges;
}

function adjacency(): Map<GraphState, GraphEdge[]> {
  const map = new Map<GraphState, GraphEdge[]>();
  for (const s of ALL_STATES) map.set(s, []);
  for (const e of buildEdges()) map.get(e.from)!.push(e);
  return map;
}

/** 从某状态出发能到达的全部状态（含起点自身） */
export function reachableFrom(islandId: string, side: Side): Set<GraphState> {
  const adj = adjacency();
  const seen = new Set<GraphState>([stateKey(islandId, side)]);
  const stack = [...seen];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of adj.get(cur) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

/** 可达状态按岛归类（供 UI 高亮：这些岛在当前岛+卡面下理论可达） */
export function reachableIslands(islandId: string, side: Side): Set<string> {
  const out = new Set<string>();
  for (const key of reachableFrom(islandId, side)) {
    out.add(parseState(key).islandId);
  }
  return out;
}

/**
 * “可能到达却回不到起点”的状态：
 * 从 (islandId, side) 能走到 s，但从 s 的任何卡面都走不回原岛。
 * 返回的每个状态附带一条从起点到它的示例路径，方便在界面里解释。
 */
export function trappedStates(
  islandId: string,
  side: Side
): { state: GraphState; path: GraphEdge[] }[] {
  const adj = adjacency();
  const start = stateKey(islandId, side);
  const reach = reachableFrom(islandId, side);

  // 反向图：求“哪些状态能回到起点所在岛”
  const rev = new Map<GraphState, GraphEdge[]>();
  for (const s of ALL_STATES) rev.set(s, []);
  for (const e of buildEdges()) rev.get(e.to)!.push(e);

  const canReturnToIsland = new Set<GraphState>();
  const stack = ALL_STATES.filter(
    (s) => parseState(s).islandId === islandId
  );
  for (const s of stack) canReturnToIsland.add(s);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of rev.get(cur) ?? []) {
      if (!canReturnToIsland.has(e.from)) {
        canReturnToIsland.add(e.from);
        stack.push(e.from);
      }
    }
  }

  // BFS 记录从起点到每个状态的一条示例路径
  const parent = new Map<GraphState, GraphEdge>();
  const q: GraphState[] = [start];
  const visited = new Set<GraphState>([start]);
  while (q.length) {
    const cur = q.shift()!;
    for (const e of adj.get(cur) ?? []) {
      if (!visited.has(e.to)) {
        visited.add(e.to);
        parent.set(e.to, e);
        q.push(e.to);
      }
    }
  }

  const result: { state: GraphState; path: GraphEdge[] }[] = [];
  for (const s of reach) {
    if (parseState(s).islandId === islandId) continue;
    if (canReturnToIsland.has(s)) continue;
    // 回溯路径
    const path: GraphEdge[] = [];
    let cur = s;
    while (cur !== start) {
      const e = parent.get(cur);
      if (!e) break;
      path.unshift(e);
      cur = e.from;
    }
    result.push({ state: s, path });
  }
  return result;
}

/**
 * 最短“过门翻卡次数”路径（Dijkstra，翻卡边 cost 1，潮钟换面 cost 0）。
 * 返回 null 表示不可达。路径是边序列，可用于题面自检与界面演示。
 */
export function shortestFlipPath(
  fromIsland: string,
  fromSide: Side,
  toIsland: string
): { flips: number; edges: GraphEdge[] } | null {
  const adj = adjacency();
  const start = stateKey(fromIsland, fromSide);
  const dist = new Map<GraphState, number>();
  const prev = new Map<GraphState, GraphEdge>();
  for (const s of ALL_STATES) dist.set(s, Infinity);
  dist.set(start, 0);

  const done = new Set<GraphState>();
  while (done.size < ALL_STATES.length) {
    let cur: GraphState | null = null;
    let best = Infinity;
    for (const s of ALL_STATES) {
      if (!done.has(s) && (dist.get(s) ?? Infinity) < best) {
        best = dist.get(s) ?? Infinity;
        cur = s;
      }
    }
    if (cur === null || best === Infinity) break;
    done.add(cur);

    for (const e of adj.get(cur) ?? []) {
      const w = e.flip ? 1 : 0;
      const nd = best + w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, e);
      }
    }
  }

  // 目标岛两个卡面中取最优
  let endState: GraphState | null = null;
  let endDist = Infinity;
  for (const side of ['tide', 'ebb'] as Side[]) {
    const k = stateKey(toIsland, side);
    if ((dist.get(k) ?? Infinity) < endDist) {
      endDist = dist.get(k)!;
      endState = k;
    }
  }
  if (endState === null || endDist === Infinity) return null;

  const edges: GraphEdge[] = [];
  let cur: GraphState = endState;
  while (cur !== start) {
    const e = prev.get(cur);
    if (!e) break;
    edges.unshift(e);
    cur = e.from;
  }
  return { flips: endDist, edges };
}

/** 供界面/自检描述一条边走的是哪扇门 */
export function describeEdge(e: GraphEdge): string {
  if (e.viaClock) return '潮钟换面';
  const { islandId } = parseState(e.from);
  const g = findGate(islandId, e.gateId);
  return `${g.name}${e.flip ? '（翻卡）' : ''}`;
}
