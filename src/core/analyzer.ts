import { doorIndex, idx, inBounds, roomAt, walkableNeighbors } from './grid';
import type {
  BlockerInfo,
  FailureDetail,
  FailureReason,
  GameMap,
  KeyInfo,
  LockAnalysis,
  Route,
  RouteStep,
} from './types';
import { colorName, Tile } from './types';

const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/** 忽略所有门,纯地形 BFS:返回起点可达格子集合 */
function terrainBfs(map: GameMap): Set<number> {
  const reachable = new Set<number>();
  const startIdx = idx(map.start.x, map.start.y, map.width);
  const q: number[] = [startIdx];
  reachable.add(startIdx);
  while (q.length) {
    const cur = q.shift()!;
    const x = cur % map.width;
    const y = Math.floor(cur / map.width);
    for (const n of walkableNeighbors(map, x, y)) {
      const ni = idx(n.x, n.y, map.width);
      if (!reachable.has(ni)) {
        reachable.add(ni);
        q.push(ni);
      }
    }
  }
  return reachable;
}

/** 全图连通分量(只看可行走格子,门视为普通可行走格) */
function labelComponents(map: GameMap): Int16Array {
  const comps = new Int16Array(map.width * map.height).fill(-1);
  let next = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const start = idx(x, y, map.width);
      if (map.tiles[start] === Tile.Wall || comps[start] !== -1) continue;
      const q: number[] = [start];
      comps[start] = next;
      while (q.length) {
        const cur = q.shift()!;
        const cx = cur % map.width;
        const cy = Math.floor(cur / map.width);
        for (const n of walkableNeighbors(map, cx, cy)) {
          const ni = idx(n.x, n.y, map.width);
          if (comps[ni] === -1) {
            comps[ni] = next;
            q.push(ni);
          }
        }
      }
      next++;
    }
  }
  return comps;
}

/**
 * 锁钥不动点可达:
 * 每轮从起点全量 BFS,持有的颜色对应门可通过;途中拾取新颜色钥匙后再来一轮,
 * 直到持有的钥匙集合不再增长。天然支持“先去别的房间拿钥匙再返程开门”。
 */
function lockAwareReach(map: GameMap, doorAt: Map<number, number>): {
  reachable: Set<number>;
  heldColors: Set<number>;
} {
  const held = new Set<number>();
  let reachable = new Set<number>();
  let grown = true;
  while (grown) {
    grown = false;
    const next = new Set<number>();
    const q: number[] = [idx(map.start.x, map.start.y, map.width)];
    next.add(q[0]);
    while (q.length) {
      const cur = q.shift()!;
      const x = cur % map.width;
      const y = Math.floor(cur / map.width);
      for (const n of walkableNeighbors(map, x, y)) {
        const ni = idx(n.x, n.y, map.width);
        if (next.has(ni)) continue;
        const doorId = doorAt.get(ni);
        if (doorId !== undefined) {
          const door = map.doors[doorId];
          if (door.color !== null && !held.has(door.color)) continue; // 锁着,过不去
        }
        next.add(ni);
        q.push(ni);
      }
    }
    // 拾取可达格子上的全部钥匙(钥匙在锁后的格子里时自然拿不到)
    for (const k of map.keys) {
      if (next.has(idx(k.x, k.y, map.width)) && !held.has(k.color)) {
        held.add(k.color);
        grown = true;
      }
    }
    reachable = next;
    // grown 已在拾取新钥匙时置位;无新钥匙即不动点收敛,循环结束
  }
  return { reachable, heldColors: held };
}

/**
 * 计算到达某目标格时,哪些颜色的门是“绕不开”的。
 * 对每种颜色做一次把该色门视为墙的 BFS:到不了目标 => 目标依赖该颜色。
 */
export function guardingColors(map: GameMap, targetIdx: number, colors: number[]): Set<number> {
  const doorAt = doorIndex(map);
  const out = new Set<number>();
  for (const color of colors) {
    const seen = new Set<number>([idx(map.start.x, map.start.y, map.width)]);
    const q = [...seen];
    while (q.length) {
      const cur = q.shift()!;
      const x = cur % map.width;
      const y = Math.floor(cur / map.width);
      for (const n of walkableNeighbors(map, x, y)) {
        const ni = idx(n.x, n.y, map.width);
        if (seen.has(ni)) continue;
        const dId = doorAt.get(ni);
        if (dId !== undefined && map.doors[dId].color === color) continue; // 该色门视为墙
        seen.add(ni);
        q.push(ni);
      }
    }
    if (!seen.has(targetIdx)) out.add(color);
  }
  return out;
}

function makeBlocker(map: GameMap, doorId: number): BlockerInfo {
  const d = map.doors[doorId];
  const c = map.corridors[d.corridorId];
  return {
    doorId: d.id,
    color: d.color ?? -1,
    x: d.x,
    y: d.y,
    corridorId: d.corridorId,
    rooms: [c.roomA, c.roomB],
  };
}

/** 带状态的 BFS 求到出口的最短合法路线:状态 = (格子, 钥匙位掩码) */
function findRoute(map: GameMap, doorAt: Map<number, number>): Route | null {
  const keyMaskAt = new Map<number, number>();
  for (const k of map.keys) keyMaskAt.set(idx(k.x, k.y, map.width), 1 << k.color);
  const startIdx = idx(map.start.x, map.start.y, map.width);
  const exitIdx = idx(map.exit.x, map.exit.y, map.width);
  const totalMasks = 1 << Math.max(1, map.colorCount);
  // parent[state] = 上一状态与本步信息
  const parent = new Int32Array(map.width * map.height * totalMasks).fill(-1);
  const stateId = (cell: number, mask: number): number => cell * totalMasks + mask;
  const startState = stateId(startIdx, keyMaskAt.get(startIdx) ?? 0);
  parent[startState] = startState;
  const q: number[] = [startState];
  let goalState = -1;
  while (q.length) {
    const st = q.shift()!;
    const mask = st % totalMasks;
    const cell = Math.floor(st / totalMasks);
    if (cell === exitIdx) {
      goalState = st;
      break;
    }
    const x = cell % map.width;
    const y = Math.floor(cell / map.width);
    for (const n of walkableNeighbors(map, x, y)) {
      const ni = idx(n.x, n.y, map.width);
      const dId = doorAt.get(ni);
      if (dId !== undefined) {
        const door = map.doors[dId];
        if (door.color !== null && (mask & (1 << door.color)) === 0) continue;
      }
      const newMask = mask | (keyMaskAt.get(ni) ?? 0);
      const ns = stateId(ni, newMask);
      if (parent[ns] !== -1) continue;
      parent[ns] = st;
      q.push(ns);
    }
  }
  if (goalState === -1) return null;

  // 回溯状态链
  const chain: number[] = [];
  let cur = goalState;
  while (cur !== startState) {
    chain.push(cur);
    cur = parent[cur];
  }
  chain.push(startState);
  chain.reverse();

  // 重放,生成逐步记录(第一次经过门记为开门,踩钥匙记为拾取)
  const steps: RouteStep[] = [];
  const events: string[] = [];
  const held = new Set<number>();
  const opened = new Set<number>();
  const picked = new Set<number>();
  for (let i = 0; i < chain.length; i++) {
    const st = chain[i];
    const cell = Math.floor(st / totalMasks);
    const x = cell % map.width;
    const y = Math.floor(cell / map.width);
    let openedDoorId: number | null = null;
    let pickedKeyId: number | null = null;
    if (i > 0) {
      const dId = doorAt.get(cell);
      if (dId !== undefined) {
        const door = map.doors[dId];
        if (door.color !== null && !opened.has(door.id)) {
          opened.add(door.id);
          openedDoorId = door.id;
          events.push(`第 ${i} 步:打开${colorName(door.color)}色门(门#${door.id})`);
        }
      }
      for (const k of map.keys) {
        if (k.x === x && k.y === y && !picked.has(k.id)) {
          picked.add(k.id);
          held.add(k.color);
          pickedKeyId = k.id;
          events.push(
            `第 ${i} 步:在${k.roomId !== null ? `房间 R${k.roomId}` : '通道'}拾取${colorName(k.color)}色钥匙`,
          );
        }
      }
    }
    // 起点格上的钥匙(第 0 步)也算持有
    if (i === 0) {
      for (const k of map.keys) {
        if (k.x === x && k.y === y && !picked.has(k.id)) {
          picked.add(k.id);
          held.add(k.color);
          pickedKeyId = k.id;
          events.push(`起点拾取${colorName(k.color)}色钥匙`);
        }
      }
    }
    steps.push({
      index: i,
      x,
      y,
      openedDoorId,
      pickedKeyId,
      heldColors: [...held].sort((a, b) => a - b),
      openedDoorIds: [...opened].sort((a, b) => a - b),
    });
  }
  events.push(`第 ${chain.length - 1} 步:到达出口`);
  return { steps, events, length: chain.length - 1 };
}

/** 诊断出口不可达的病因 */
function diagnose(map: GameMap, analysis: {
  terrainReachable: Set<number>;
  reachable: Set<number>;
  disconnectedRooms: number[];
}): FailureDetail {
  const exitIdx = idx(map.exit.x, map.exit.y, map.width);

  // 1) 地形断开:忽略锁也到不了出口
  if (!analysis.terrainReachable.has(exitIdx)) {
    const rooms = new Set<number>(analysis.disconnectedRooms);
    return {
      reason: 'terrain',
      colors: [],
      blockers: [],
      roomIds: [...rooms],
      message:
        rooms.size > 0
          ? `地形断开:出口所在区域与起点之间没有可行走格子连接,断开的房间:${[...rooms].map((r) => `R${r}`).join('、')}`
          : '地形断开:出口与起点之间没有可行走格子连接',
    };
  }

  // 2) 找前沿阻塞门:门邻接可达区域,但因缺钥匙过不去
  const frontier: number[] = [];
  for (const d of map.doors) {
    if (d.color === null) continue;
    const di = idx(d.x, d.y, map.width);
    if (analysis.reachable.has(di)) continue;
    for (const dir of DIRS) {
      const nx = d.x + dir.x;
      const ny = d.y + dir.y;
      if (inBounds(nx, ny, map.width, map.height) && analysis.reachable.has(idx(nx, ny, map.width))) {
        frontier.push(d.id);
        break;
      }
    }
  }
  const blockers = frontier.map((id) => makeBlocker(map, id));
  const blockerColors = [...new Set(frontier.map((id) => map.doors[id].color as number))];
  const roomSet = new Set<number>();
  for (const b of blockers) roomSet.add(b.rooms[0]), roomSet.add(b.rooms[1]);

  // 3) 缺钥匙:某阻塞颜色在整张图上根本没有钥匙
  const existingColors = new Set(map.keys.map((k) => k.color));
  const missing = blockerColors.filter((c) => !existingColors.has(c));
  if (missing.length > 0) {
    return {
      reason: 'missing_key',
      colors: missing,
      blockers: blockers.filter((b) => missing.includes(b.color)),
      roomIds: [...roomSet],
      message: `缺少钥匙:存在${missing.map((c) => colorName(c)).join('、')}色门,但地图上没有对应颜色的钥匙`,
    };
  }

  // 4) 自锁 / 依赖环分析:对每把钥匙计算绕不开的守卫颜色
  const allColors = [...new Set(map.doors.map((d) => d.color).filter((c): c is number => c !== null))];
  const guardOf = new Map<number, Set<number>>(); // 颜色 -> 拿到该色钥匙必须经过的门色
  const keyRoomOf = new Map<number, number | null>();
  for (const k of map.keys) {
    const guards = guardingColors(map, idx(k.x, k.y, map.width), allColors);
    // 同色可能有多把钥匙,取并集之外还要保证:任一可取得即可,这里取最小守卫集
    const prev = guardOf.get(k.color);
    if (!prev || guards.size < prev.size) guardOf.set(k.color, guards);
    keyRoomOf.set(k.color, k.roomId);
  }
  const selfLocked: number[] = [];
  for (const [color, guards] of guardOf) {
    if (guards.has(color)) selfLocked.push(color);
  }
  const relevantSelf = selfLocked.filter((c) => blockerColors.includes(c) || blockerColors.some((bc) => guardOf.get(bc)?.has(c)));
  if (relevantSelf.length > 0) {
    for (const c of relevantSelf) {
      const kr = keyRoomOf.get(c);
      if (kr !== null && kr !== undefined) roomSet.add(kr);
    }
    return {
      reason: 'self_lock',
      colors: relevantSelf,
      blockers: blockers.filter((b) => relevantSelf.includes(b.color)),
      roomIds: [...roomSet],
      message: `钥匙自锁:${relevantSelf.map((c) => `${colorName(c)}色钥匙被${colorName(c)}色门挡在后面`).join(';')},不先开门就拿不到钥匙`,
    };
  }

  // 5) 依赖环:c1 的钥匙在 c2 门后,c2 的钥匙又在 c1 门后
  const dep = new Map<number, number[]>();
  for (const [color, guards] of guardOf) dep.set(color, [...guards]);
  const inCycle = new Set<number>();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const mark = new Map<number, number>();
  const dfs = (node: number, stack: number[]): void => {
    mark.set(node, GRAY);
    for (const nb of dep.get(node) ?? []) {
      if (mark.get(nb) === GRAY) {
        for (const c of stack.slice(stack.indexOf(nb))) inCycle.add(c);
        inCycle.add(nb);
      } else if (mark.get(nb) !== BLACK) {
        dfs(nb, [...stack, node]);
      }
    }
    mark.set(node, BLACK);
  };
  for (const c of dep.keys()) {
    if (mark.get(c) === WHITE) dfs(c, []);
  }
  if (inCycle.size > 0) {
    const colors = [...inCycle];
    for (const c of colors) {
      const kr = keyRoomOf.get(c);
      if (kr !== null && kr !== undefined) roomSet.add(kr);
    }
    return {
      reason: 'circular',
      colors,
      blockers: blockers.filter((b) => colors.includes(b.color)),
      roomIds: [...roomSet],
      message: `锁钥依赖环:${colors.map((c) => `${colorName(c)}色`).join('、')}钥匙互相被对方颜色的门锁住,无法取得任何一把`,
    };
  }

  // 6) 兜底:列出前沿阻塞门,如实说明无法进一步归类
  return {
    reason: 'missing_key',
    colors: blockerColors,
    blockers,
    roomIds: [...roomSet],
    message: `出口不可达:被${blockerColors.map((c) => colorName(c)).join('、')}色门阻塞,且当前钥匙获取链条无法闭合`,
  };
}

export function analyzeMap(map: GameMap): LockAnalysis {
  const doorAt = doorIndex(map);
  const terrainReachable = terrainBfs(map);
  const components = labelComponents(map);
  const startComp = components[idx(map.start.x, map.start.y, map.width)];

  const disconnectedRooms: number[] = [];
  const disconnectedComponents = new Map<number, number[]>();
  for (const r of map.rooms) {
    const ci = idx(r.x, r.y, map.width);
    const comp = components[ci];
    if (comp !== startComp) {
      disconnectedRooms.push(r.id);
      const arr = disconnectedComponents.get(comp) ?? [];
      arr.push(r.id);
      disconnectedComponents.set(comp, arr);
    }
  }

  const { reachable } = lockAwareReach(map, doorAt);
  const reachableRooms = map.rooms
    .filter((r) => reachable.has(idx(r.x, r.y, map.width)))
    .map((r) => r.id);

  const keyInfos: KeyInfo[] = map.keys.map((k) => {
    const ki = idx(k.x, k.y, map.width);
    return {
      keyId: k.id,
      color: k.color,
      x: k.x,
      y: k.y,
      roomId: k.roomId,
      terrainReachable: terrainReachable.has(ki),
      obtainable: reachable.has(ki),
    };
  });

  const exitReachable = reachable.has(idx(map.exit.x, map.exit.y, map.width));
  const failure: FailureDetail | null = exitReachable
    ? null
    : diagnose(map, { terrainReachable, reachable, disconnectedRooms });
  const route = exitReachable ? findRoute(map, doorAt) : null;

  return {
    terrainReachable,
    components,
    disconnectedRooms,
    disconnectedComponents,
    reachable,
    reachableRooms,
    keyInfos,
    exitReachable,
    failure,
    route,
  };
}

/** 供 UI/测试使用的病因优先级常量 */
export const FAILURE_ORDER: FailureReason[] = ['terrain', 'missing_key', 'self_lock', 'circular'];

/** 校验一条路线在给定地图上逐步合法(测试与手动走格子共用) */
export function validateRoute(map: GameMap, steps: RouteStep[]): { ok: boolean; error: string | null } {
  const doorAt = doorIndex(map);
  const held = new Set<number>();
  const opened = new Set<number>();
  const prev = { x: map.start.x, y: map.start.y };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i === 0) {
      if (s.x !== map.start.x || s.y !== map.start.y) return { ok: false, error: `第 0 步不在起点` };
    } else {
      const dist = Math.abs(s.x - prev.x) + Math.abs(s.y - prev.y);
      if (dist !== 1) return { ok: false, error: `第 ${i} 步不是相邻格移动` };
      if (map.tiles[idx(s.x, s.y, map.width)] === Tile.Wall) {
        return { ok: false, error: `第 ${i} 步走进了墙 (${s.x},${s.y})` };
      }
      const dId = doorAt.get(idx(s.x, s.y, map.width));
      if (dId !== undefined) {
        const door = map.doors[dId];
        if (door.color !== null && !held.has(door.color)) {
          return { ok: false, error: `第 ${i} 步未持有${colorName(door.color)}色钥匙却通过锁门` };
        }
        if (s.openedDoorId === door.id) {
          if (opened.has(door.id)) return { ok: false, error: `第 ${i} 步重复记录开门` };
          opened.add(door.id);
        }
      }
      if (s.openedDoorId !== null && dId === undefined) {
        return { ok: false, error: `第 ${i} 步声称打开了不存在的门` };
      }
    }
    for (const k of map.keys) {
      if (k.x === s.x && k.y === s.y) held.add(k.color);
    }
    if (s.pickedKeyId !== null) {
      const k = map.keys.find((kk) => kk.id === s.pickedKeyId);
      if (!k || k.x !== s.x || k.y !== s.y) return { ok: false, error: `第 ${i} 步拾取事件与格子不符` };
    }
    const expectHeld = [...held].sort((a, b) => a - b);
    if (JSON.stringify(expectHeld) !== JSON.stringify(s.heldColors)) {
      return { ok: false, error: `第 ${i} 步持有钥匙状态不符` };
    }
    prev.x = s.x;
    prev.y = s.y;
  }
  const last = steps[steps.length - 1];
  if (!last || last.x !== map.exit.x || last.y !== map.exit.y) {
    return { ok: false, error: '路线终点不是出口' };
  }
  return { ok: true, error: null };
}

export { roomAt };
