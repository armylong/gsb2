import type { Vertex } from './types';

/** 格点键 "x,y"，也是交叉点 tops 的键。 */
export function vKey(v: Vertex): string {
  return `${v.x},${v.y}`;
}

export function parseKey(key: string): Vertex {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/**
 * 无向格边键：小端格点在前，保证 (a,b) 与 (b,a) 同键。
 * 一条格边同一时刻只能被一种颜色占用。
 */
export function edgeKey(a: Vertex, b: Vertex): string {
  const ka = vKey(a);
  const kb = vKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** 解析格边键，返回两个端点。 */
export function parseEdge(key: string): [Vertex, Vertex] {
  const [a, b] = key.split('|');
  return [parseKey(a), parseKey(b)];
}

/** 两点是否相邻（曼哈顿距离为 1），只有相邻格点之间允许画边。 */
export function isAdjacent(a: Vertex, b: Vertex): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

export function sameVertex(a: Vertex, b: Vertex): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 上下左右四个邻居。 */
export function neighbors(v: Vertex): Vertex[] {
  return [
    { x: v.x + 1, y: v.y },
    { x: v.x - 1, y: v.y },
    { x: v.x, y: v.y + 1 },
    { x: v.x, y: v.y - 1 },
  ];
}

/** 格点是否在织框范围内。 */
export function inBounds(v: Vertex, width: number, height: number): boolean {
  return v.x >= 0 && v.x <= width && v.y >= 0 && v.y <= height;
}

/** 格点是否在边框上（端口只能开在边框）。 */
export function isBorder(v: Vertex, width: number, height: number): boolean {
  return v.x === 0 || v.x === width || v.y === 0 || v.y === height;
}

/**
 * 判断同一格点上两条带的四个占用方向是否构成「对边穿过」。
 * 合法交叉：水平一对（左右）+ 垂直一对（上下），各由一种颜色占据。
 * 入参 directions: 颜色 -> 该颜色在该点占用的方向集合。
 */
export function isOppositeCrossing(
  directions: Map<string, Array<'L' | 'R' | 'U' | 'D'>>,
): boolean {
  const colors = [...directions.keys()];
  if (colors.length !== 2) return false;
  const [c1, c2] = colors.map((c) => new Set(directions.get(c)));
  const horizontal = new Set(['L', 'R']);
  const vertical = new Set(['U', 'D']);
  const c1Horizontal =
    c1.size === 2 && [...c1].every((d) => horizontal.has(d));
  const c1Vertical = c1.size === 2 && [...c1].every((d) => vertical.has(d));
  const c2Horizontal =
    c2.size === 2 && [...c2].every((d) => horizontal.has(d));
  const c2Vertical = c2.size === 2 && [...c2].every((d) => vertical.has(d));
  return (c1Horizontal && c2Vertical) || (c1Vertical && c2Horizontal);
}

/** 由格点和邻居反推方向。 */
export function directionOf(from: Vertex, to: Vertex): 'L' | 'R' | 'U' | 'D' {
  if (to.x === from.x + 1) return 'R';
  if (to.x === from.x - 1) return 'L';
  if (to.y === from.y + 1) return 'D';
  return 'U';
}

/** 路径上相邻两个格点之间的全部格边键。 */
export function pathEdgeKeys(path: Vertex[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    if (!isAdjacent(path[i], path[i + 1])) {
      throw new Error(
        `路径不连续: ${vKey(path[i])} -> ${vKey(path[i + 1])}`,
      );
    }
    keys.push(edgeKey(path[i], path[i + 1]));
  }
  return keys;
}

/** 两条格边键集合是否有交集。 */
export function shareEdge(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((k) => set.has(k));
}
