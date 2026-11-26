import type { Level, NodeId, PlanAction } from './types';

export function edgeTime(level: Level, a: NodeId, b: NodeId): number | null {
  const e = level.edges.find(
    (edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a),
  );
  return e ? e.beats : null;
}

export function pathCost(level: Level, path: NodeId[]): number | null {
  if (path.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const t = edgeTime(level, path[i], path[i + 1]);
    if (t === null) return null;
    total += t;
  }
  return total;
}

/** 枚举少量简单路径，供编辑器选择走法。 */
export function findRoutes(level: Level, start: NodeId, goal: NodeId): NodeId[][] {
  if (start === goal) return [[start]];
  const results: NodeId[][] = [];
  const dfs = (node: NodeId, path: NodeId[], seen: Set<NodeId>) => {
    if (results.length >= 8) return;
    for (const edge of level.edges) {
      const next = edge.a === node ? edge.b : edge.b === node ? edge.a : null;
      if (!next || seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === goal) {
        results.push(nextPath);
      } else {
        seen.add(next);
        dfs(next, nextPath, seen);
        seen.delete(next);
      }
    }
  };
  dfs(start, [start], new Set([start]));
  return results.sort((a, b) => (pathCost(level, a) ?? 99) - (pathCost(level, b) ?? 99));
}

export function shortestPathCost(level: Level, start: NodeId, goal: NodeId): number | null {
  const routes = findRoutes(level, start, goal);
  if (routes.length === 0) return null;
  return pathCost(level, routes[0]);
}

export function nodeName(level: Level, id: NodeId): string {
  return level.nodes.find((n) => n.id === id)?.name ?? id;
}

export function formatTime(beat: number): string {
  return `第 ${beat} 拍`;
}

let counter = 0;
export function uid(prefix = 'a'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function sortActions(actions: PlanAction[]): PlanAction[] {
  return [...actions].sort((a, b) => a.start - b.start || a.actorId.localeCompare(b.actorId));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
