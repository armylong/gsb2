import { adjacencyOfColor, holeSet, portsOf } from './board';
import {
  edgeKey,
  inBounds,
  isAdjacent,
  sameVertex,
  vKey,
} from './geometry';
import { detectCrossings } from './board';
import type { GameState, Puzzle, Vertex } from './types';

export interface OpResult {
  ok: boolean;
  state?: GameState;
  error?: string;
  code?:
    | 'OUT_OF_BOUNDS'
    | 'HOLE'
    | 'NOT_ADJACENT'
    | 'EDGE_TAKEN'
    | 'WRONG_COLOR'
    | 'NO_EDGE'
    | 'NOT_A_CROSSING'
    | 'BAD_PATH'
    | 'DISCONNECTED'
    | 'BRANCH'
    | 'LOOP';
}

export function emptyState(puzzle: Puzzle): GameState {
  return { puzzleId: puzzle.id, edges: {}, tops: {} };
}

function clone(state: GameState): GameState {
  return {
    puzzleId: state.puzzleId,
    edges: { ...state.edges },
    tops: { ...state.tops },
  };
}

/**
 * 清理失效的上下指定：某格点已不再是该颜色参与的合法交叉时，删掉它的 tops 记录。
 */
function pruneTops(state: GameState): void {
  const valid = new Map(
    detectCrossings(state)
      .filter((c) => c.valid)
      .map((c) => [vKey(c.vertex), new Set(c.colors)]),
  );
  for (const key of Object.keys(state.tops)) {
    const colors = valid.get(key);
    if (!colors || !colors.has(state.tops[key])) {
      delete state.tops[key];
    }
  }
}

/** 沿一条允许的格边画带。 */
export function drawEdge(
  puzzle: Puzzle,
  state: GameState,
  a: Vertex,
  b: Vertex,
  color: string,
): OpResult {
  if (!inBounds(a, puzzle.width, puzzle.height) || !inBounds(b, puzzle.width, puzzle.height)) {
    return { ok: false, code: 'OUT_OF_BOUNDS', error: '格点超出织框范围' };
  }
  if (!isAdjacent(a, b)) {
    return { ok: false, code: 'NOT_ADJACENT', error: '只能在相邻格点之间画带' };
  }
  const holes = holeSet(puzzle);
  if (holes.has(vKey(a)) || holes.has(vKey(b))) {
    return { ok: false, code: 'HOLE', error: '彩带不能经过禁用孔' };
  }
  const key = edgeKey(a, b);
  const existing = state.edges[key];
  if (existing !== undefined) {
    return {
      ok: false,
      code: 'EDGE_TAKEN',
      error:
        existing === color
          ? '这条格边已经是同色带，重复画没有效果'
          : `这条格边已被 ${existing} 带占用，一条格边只能走一条带`,
    };
  }

  const [entry, exit] = portsOf(puzzle, color);
  const adj = adjacencyOfColor(state, color);
  // 入口约束：新边必须从该颜色的入口起头，或接在该颜色已有的部分上。
  const touchesOwn =
    sameVertex(a, entry.vertex) ||
    sameVertex(b, entry.vertex) ||
    adj.has(vKey(a)) ||
    adj.has(vKey(b));
  if (!touchesOwn) {
    return {
      ok: false,
      code: 'DISCONNECTED',
      error: `${color} 带必须从它的入口 ${vKey(entry.vertex)} 起头，或接在已有的同色带上，不能凭空落子`,
    };
  }
  // 端口颜色必须对上：连到任何端口都要求颜色一致。
  for (const v of [a, b]) {
    const port = puzzle.ports.find((p) => sameVertex(p.vertex, v));
    if (port && port.color !== color) {
      return {
        ok: false,
        code: 'WRONG_COLOR',
        error: `${vKey(v)} 是 ${port.color} 带的${port.kind === 'entry' ? '入口' : '出口'}，${color} 带不能接`,
      };
    }
  }
  // 度数上限 2：防止分叉。
  for (const v of [a, b]) {
    if ((adj.get(vKey(v))?.length ?? 0) >= 2) {
      return {
        ok: false,
        code: 'BRANCH',
        error: `${vKey(v)} 上的 ${color} 带已经有两个方向，再接会分叉`,
      };
    }
  }
  // 不允许自闭合：边的两端已经在同一连通分量里（且不是新起头）会形成环。
  const compA = adj.has(vKey(a)) ? reachable(adj, a) : null;
  const compB = adj.has(vKey(b)) ? reachable(adj, b) : null;
  if (compA && compB) {
    const inSame = compA.has(vKey(b));
    const touchesEntry =
      sameVertex(a, entry.vertex) || sameVertex(b, entry.vertex);
    if (inSame && !touchesEntry) {
      return {
        ok: false,
        code: 'LOOP',
        error: '这一步会把彩带接成闭合环，环上没有入口和出口',
      };
    }
  }
  // 接到出口即收尾：出口侧不允许再继续延伸。
  if (sameVertex(a, exit.vertex) || sameVertex(b, exit.vertex)) {
    const exitV = sameVertex(a, exit.vertex) ? a : b;
    if ((adj.get(vKey(exitV))?.length ?? 0) >= 1) {
      return {
        ok: false,
        code: 'BRANCH',
        error: `${color} 带已经接到出口，不能再从出口往外延伸`,
      };
    }
  }

  const next = clone(state);
  next.edges[key] = color;
  pruneTops(next);
  return { ok: true, state: next };
}

function reachable(adj: Map<string, Vertex[]>, start: Vertex): Set<string> {
  const seen = new Set<string>([vKey(start)]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adj.get(vKey(cur)) ?? []) {
      const k = vKey(n);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** 收回一条格边；只允许从同色带的端点（度 1）或端口处收，保证不会误删中间段。 */
export function removeEdge(
  puzzle: Puzzle,
  state: GameState,
  a: Vertex,
  b: Vertex,
): OpResult {
  const key = edgeKey(a, b);
  const color = state.edges[key];
  if (color === undefined) {
    return { ok: false, code: 'NO_EDGE', error: '这条格边上没有彩带' };
  }
  const adj = adjacencyOfColor(state, color);
  const [entry, exit] = portsOf(puzzle, color);
  const removable = (v: Vertex): boolean =>
    (adj.get(vKey(v))?.length ?? 0) === 1 ||
    sameVertex(v, entry.vertex) ||
    sameVertex(v, exit.vertex);
  if (!removable(a) && !removable(b)) {
    return {
      ok: false,
      code: 'BAD_PATH',
      error: '收带只能从带子的末端或入口/出口开始，中间段请用「改道」功能',
    };
  }
  const next = clone(state);
  delete next.edges[key];
  pruneTops(next);
  return { ok: true, state: next };
}

/** 显式设置某合法交叉点的顶层颜色；不传 color 时在两色之间翻转。 */
export function setTop(
  puzzle: Puzzle,
  state: GameState,
  vertex: Vertex,
  color?: string,
): OpResult {
  const info = detectCrossings(state).find((c) =>
    sameVertex(c.vertex, vertex),
  );
  if (!info || !info.valid) {
    return {
      ok: false,
      code: 'NOT_A_CROSSING',
      error: '只有对边穿过的合法交叉点才能指定谁压谁',
    };
  }
  let nextColor = color;
  if (!nextColor) {
    const current = state.tops[vKey(vertex)];
    if (current && info.colors.includes(current)) {
      nextColor = info.colors.find((c) => c !== current)!;
    } else {
      // 当前是自动裁定的顶层，翻转到另一种颜色
      const order = (c: string): number =>
        puzzle.ports.findIndex((p) => p.color === c);
      const autoTop = [...info.colors].sort((x, y) => order(x) - order(y))[0];
      nextColor = info.colors.find((c) => c !== autoTop)!;
    }
  }
  if (!info.colors.includes(nextColor)) {
    return {
      ok: false,
      code: 'WRONG_COLOR',
      error: `${nextColor} 没有在这个交叉点上`,
    };
  }
  const next = clone(state);
  next.tops[vKey(vertex)] = nextColor;
  return { ok: true, state: next };
}

function validatePath(
  puzzle: Puzzle,
  path: Vertex[],
): OpResult | null {
  if (path.length < 2) {
    return { ok: false, code: 'BAD_PATH', error: '路线至少要包含一条格边' };
  }
  const seen = new Set<string>();
  for (let i = 0; i < path.length; i++) {
    const v = path[i];
    if (!inBounds(v, puzzle.width, puzzle.height)) {
      return { ok: false, code: 'OUT_OF_BOUNDS', error: `${vKey(v)} 超出织框` };
    }
    if (holeSet(puzzle).has(vKey(v))) {
      return { ok: false, code: 'HOLE', error: `${vKey(v)} 是禁用孔` };
    }
    if (seen.has(vKey(v))) {
      return { ok: false, code: 'LOOP', error: '新路线不能重复经过同一格点' };
    }
    seen.add(vKey(v));
    if (i > 0 && !isAdjacent(path[i - 1], v)) {
      return {
        ok: false,
        code: 'NOT_ADJACENT',
        error: `新路线在 ${vKey(path[i - 1])} → ${vKey(v)} 处不连续`,
      };
    }
  }
  return null;
}

/**
 * 改道：用 newPath 替换同色带上的 oldPath 一段。
 * 两侧还连得上时保留其余走法；接不上、分叉、撞别的带都会被拒绝，
 * 因此误接出的圈或断头永远不会被当成完整路线。
 */
export function reroute(
  puzzle: Puzzle,
  state: GameState,
  color: string,
  oldPath: Vertex[],
  newPath: Vertex[],
): OpResult {
  if (oldPath.length < 2) {
    return { ok: false, code: 'BAD_PATH', error: '旧路线至少要包含一条格边' };
  }
  const pathError = validatePath(puzzle, newPath);
  if (pathError) return pathError;

  const oldEdgeKeys = new Set<string>();
  for (let i = 0; i < oldPath.length - 1; i++) {
    if (!isAdjacent(oldPath[i], oldPath[i + 1])) {
      return {
        ok: false,
        code: 'BAD_PATH',
        error: '旧路线本身不连续',
      };
    }
    oldEdgeKeys.add(edgeKey(oldPath[i], oldPath[i + 1]));
  }
  for (const k of oldEdgeKeys) {
    if (state.edges[k] !== color) {
      return {
        ok: false,
        code: 'NO_EDGE',
        error: `旧路线包含不属于 ${color} 带的格边，无法替换`,
      };
    }
  }

  const [entry, exit] = portsOf(puzzle, color);
  const next = clone(state);
  for (const k of oldEdgeKeys) delete next.edges[k];

  const remaining = adjacencyOfColor(next, color);
  const newEdgeKeys = pathToEdgeKeys(newPath);
  const overlapsOld = (k: string) => oldEdgeKeys.has(k);

  // 新边不能撞别的颜色；与旧段重合的边（即未改动的部分）直接跳过。
  for (const k of newEdgeKeys) {
    const owner = state.edges[k];
    if (owner !== undefined && owner !== color && !overlapsOld(k)) {
      return {
        ok: false,
        code: 'EDGE_TAKEN',
        error: `新路线的格边已被 ${owner} 带占用`,
      };
    }
  }

  // 端点接续规则：新路线两端必须落在旧段端点、仍连着剩余同色带的格点或端口上。
  const endpoints = [newPath[0], newPath[newPath.length - 1]];
  const oldEndpoints = [oldPath[0], oldPath[oldPath.length - 1]];
  const remainingEmpty = remaining.size === 0;
  if (remainingEmpty) {
    const portPair = new Set([vKey(entry.vertex), vKey(exit.vertex)]);
    if (!endpoints.every((v) => portPair.has(vKey(v)))) {
      return {
        ok: false,
        code: 'DISCONNECTED',
        error: '整条带替换时，新路线必须从入口走到出口',
      };
    }
  } else {
    for (const v of endpoints) {
      const isOldEnd = oldEndpoints.some((o) => sameVertex(o, v));
      const hasRemaining = (remaining.get(vKey(v))?.length ?? 0) > 0;
      const isPort =
        sameVertex(v, entry.vertex) || sameVertex(v, exit.vertex);
      if (!isOldEnd && !hasRemaining && !isPort) {
        return {
          ok: false,
          code: 'DISCONNECTED',
          error: `新路线在 ${vKey(v)} 处接不上原来的带子，两侧必须连得上`,
        };
      }
    }
  }

  // 端口颜色校验。
  for (const v of newPath) {
    const port = puzzle.ports.find((p) => sameVertex(p.vertex, v));
    if (port && port.color !== color) {
      return {
        ok: false,
        code: 'WRONG_COLOR',
        error: `${vKey(v)} 是 ${port.color} 带的端口，${color} 带不能经过`,
      };
    }
  }

  // 合入新边并检查度数（剩余边 + 新边，跳过与旧段重合的边）。
  for (const k of newEdgeKeys) {
    if (next.edges[k] === color) continue; // 与保留边重合
    const [a, b] = k.split('|').map((part) => {
      const [x, y] = part.split(',').map(Number);
      return { x, y } as Vertex;
    });
    next.edges[k] = color;
    for (const v of [a, b]) {
      const deg = countDegree(next, color, v);
      if (deg > 2) {
        return {
          ok: false,
          code: 'BRANCH',
          error: `改道后 ${vKey(v)} 出现分叉（度数 ${deg}）`,
        };
      }
    }
  }

  pruneTops(next);
  return { ok: true, state: next };
}

function pathToEdgeKeys(path: Vertex[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    keys.push(edgeKey(path[i], path[i + 1]));
  }
  return keys;
}

function countDegree(state: GameState, color: string, v: Vertex): number {
  let deg = 0;
  for (const [k, c] of Object.entries(state.edges)) {
    if (c !== color) continue;
    const [a, b] = k.split('|');
    if (a === vKey(v) || b === vKey(v)) deg++;
  }
  return deg;
}

/** 清空一种颜色（其余颜色不动）。 */
export function clearRibbon(
  _puzzle: Puzzle,
  state: GameState,
  color: string,
): GameState {
  const next = clone(state);
  for (const [k, c] of Object.entries(next.edges)) {
    if (c === color) delete next.edges[k];
  }
  pruneTops(next);
  return next;
}

/** 清空整盘。 */
export function clearAll(puzzle: Puzzle): GameState {
  return emptyState(puzzle);
}
