import { Rng } from './rng';
import { idx, inBounds, pointInRoom, rectsOverlap, roomCenter } from './grid';
import type { Corridor, Door, GameMap, KeyItem, Point, Rect, Room } from './types';
import { Tile } from './types';
import { analyzeMap } from './analyzer';

export interface GenParams {
  seed: string;
  roomCount: number;
  /** 锁色数量 0..3 */
  colorCount: number;
}

export interface GenResult {
  ok: boolean;
  map: GameMap | null;
  attempts: number;
  /** 有限尝试仍失败时的如实说明 */
  error: string | null;
}

export const GRID_W = 72;
export const GRID_H = 48;
const MAX_ATTEMPTS = 12;
const EXTRA_LINKS_MAX = 2;

interface RoomEdge {
  a: number;
  b: number;
  corridorId: number;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** 在一次 RNG 尝试内生成完整地图(不保证可解,由外层验证重试) */
function generateOnce(rng: Rng, params: GenParams): GameMap {
  const { roomCount, colorCount } = params;
  const tiles = new Uint8Array(GRID_W * GRID_H); // 默认全墙

  // ---- 1. 放置互不重叠(含 1 格墙间距)的矩形房间 ----
  const rooms: Room[] = [];
  for (let i = 0; i < roomCount; i++) {
    let placed = false;
    let room: Room | null = null;
    for (let tries = 0; tries < 80 && !placed; tries++) {
      const w = rng.int(4, 9);
      const h = rng.int(3, 7);
      const x = rng.int(1, GRID_W - w - 2);
      const y = rng.int(1, GRID_H - h - 2);
      const candidate: Rect = { x, y, w, h };
      if (rooms.every((r) => !rectsOverlap(candidate, r, 2))) {
        room = { id: i, name: `R${i}`, ...candidate };
        placed = true;
      }
    }
    if (!room || !placed) throw new Error('房间放置失败,空间不足');
    rooms.push(room);
    for (let yy = room.y; yy < room.y + room.h; yy++) {
      for (let xx = room.x; xx < room.x + room.w; xx++) {
        tiles[idx(xx, yy, GRID_W)] = Tile.Floor;
      }
    }
  }

  // ---- 2. 生成连接:最近邻生成树 + 少量额外连接 ----
  const linked = new Set<string>();
  const corridorPlan: [number, number][] = [];
  const connected = new Set<number>([0]);
  const order = rng.shuffle(rooms.slice(1).map((r) => r.id));
  for (const rid of order) {
    // 在已连通集合中找中心点最近的房间
    let best = -1;
    let bestD = Infinity;
    const c = roomCenter(rooms[rid]);
    for (const j of connected) {
      const d = Math.abs(c.x - roomCenter(rooms[j]).x) + Math.abs(c.y - roomCenter(rooms[j]).y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    connected.add(rid);
    const k = edgeKey(rid, best);
    if (!linked.has(k)) {
      linked.add(k);
      corridorPlan.push([rid, best]);
    }
  }
  const extraLinks = rng.int(0, EXTRA_LINKS_MAX);
  for (let e = 0; e < extraLinks; e++) {
    const a = rng.int(0, roomCount - 1);
    let b = rng.int(0, roomCount - 1);
    let guard = 0;
    while ((b === a || linked.has(edgeKey(a, b))) && guard++ < 20) {
      b = rng.int(0, roomCount - 1);
    }
    if (a !== b && !linked.has(edgeKey(a, b))) {
      linked.add(edgeKey(a, b));
      corridorPlan.push([a, b]);
    }
  }

  // ---- 3. 开凿 L 形通道,端点必须落在房间内部 ----
  const corridors: Corridor[] = [];
  let corridorId = 0;
  const carve = (x: number, y: number): boolean => {
    if (!inBounds(x, y, GRID_W, GRID_H)) return false;
    const i = idx(x, y, GRID_W);
    if (tiles[i] === Tile.Wall) tiles[i] = Tile.Corridor;
    return true;
  };
  for (const [ra, rb] of corridorPlan) {
    const ca = roomCenter(rooms[ra]);
    const cb = roomCenter(rooms[rb]);
    const cells: Point[] = [];
    let x = ca.x;
    let y = ca.y;
    cells.push({ x, y });
    const horizontalFirst = rng.next() < 0.5;
    const stepToward = (): boolean => {
      if (horizontalFirst) {
        if (x !== cb.x) {
          x += Math.sign(cb.x - x);
        } else if (y !== cb.y) {
          y += Math.sign(cb.y - y);
        } else return false;
      } else {
        if (y !== cb.y) {
          y += Math.sign(cb.y - y);
        } else if (x !== cb.x) {
          x += Math.sign(cb.x - x);
        } else return false;
      }
      carve(x, y);
      cells.push({ x, y });
      return true;
    };
    let guard = 0;
    while ((x !== cb.x || y !== cb.y) && guard++ < GRID_W * GRID_H) stepToward();
    corridors.push({ id: corridorId, roomA: ra, roomB: rb, cells, removed: false });
    corridorId++;
  }

  // ---- 4. 由实际格子推导房间邻接边(通道可能穿过第三个房间) ----
  const edges: RoomEdge[] = [];
  const edgeSeen = new Set<string>();
  const roomIdAt = (p: Point): number => {
    for (const r of rooms) if (pointInRoom(p, r)) return r.id;
    return -1;
  };
  for (const c of corridors) {
    let prevRoom = roomIdAt(c.cells[0]);
    for (const p of c.cells) {
      const r = roomIdAt(p);
      if (r !== -1 && r !== prevRoom) {
        const k = edgeKey(prevRoom === -1 ? r : prevRoom, r);
        if (!edgeSeen.has(k)) {
          edgeSeen.add(k);
          edges.push({ a: prevRoom === -1 ? r : prevRoom, b: r, corridorId: c.id });
        }
        prevRoom = r;
      }
    }
  }

  // ---- 5. 起点与出口:起点 R0 中心,出口为邻接图上离起点最远的房间 ----
  const start = roomCenter(rooms[0]);
  const adj = new Map<number, number[]>();
  for (const r of rooms) adj.set(r.id, []);
  for (const e of edges) {
    adj.get(e.a)!.push(e.b);
    adj.get(e.b)!.push(e.a);
  }
  const dist = new Map<number, number>([[0, 0]]);
  const queue = [0];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) {
      if (!dist.has(nb)) {
        dist.set(nb, dist.get(cur)! + 1);
        queue.push(nb);
      }
    }
  }
  let exitRoom = 0;
  let exitDist = -1;
  for (const r of rooms) {
    const d = dist.get(r.id) ?? -1;
    if (d > exitDist) {
      exitDist = d;
      exitRoom = r.id;
    }
  }
  const exit = roomCenter(rooms[exitRoom]);

  // ---- 6. 放置锁门:选通道中段的通道格,同色可多门 ----
  const doors: Door[] = [];
  const doorCells = new Set<number>();
  if (colorCount > 0) {
    const doorTarget = Math.max(colorCount, Math.min(rooms.length - 1, Math.floor(rooms.length / 2) + 1));
    const shuffledCorridors = rng.shuffle(corridors.map((c) => c.id));
    let doorId = 0;
    const usedColors = new Set<number>();
    for (const cid of shuffledCorridors) {
      if (doors.length >= doorTarget) break;
      const corr = corridors[cid];
      // 通道中不属于任何房间的格子才放门
      const openCells = corr.cells.filter((p) => roomIdAt(p) === -1);
      if (openCells.length === 0) continue;
      const cell = openCells[Math.floor(openCells.length / 2)];
      const ci = idx(cell.x, cell.y, GRID_W);
      if (doorCells.has(ci)) continue;
      // 前 colorCount 扇门保证每种颜色至少出现一次,之后随机赋色
      const color = usedColors.size < colorCount ? usedColors.size : rng.int(0, colorCount - 1);
      usedColors.add(color);
      doors.push({ id: doorId, x: cell.x, y: cell.y, color, corridorId: cid });
      doorCells.add(ci);
      doorId++;
    }
  }

  // ---- 7. 放钥匙:构造性保证可取得——放在不经过同色门即可达的房间里 ----
  const keys: KeyItem[] = [];
  if (colorCount > 0) {
    const doorsByCorridor = new Map<number, Door[]>();
    for (const d of doors) {
      const arr = doorsByCorridor.get(d.corridorId) ?? [];
      arr.push(d);
      doorsByCorridor.set(d.corridorId, arr);
    }
    let keyId = 0;
    for (let color = 0; color < colorCount; color++) {
      const blockedEdges = new Set<string>();
      for (const e of edges) {
        const ds = doorsByCorridor.get(e.corridorId) ?? [];
        if (ds.some((d) => d.color === color)) blockedEdges.add(edgeKey(e.a, e.b));
      }
      // BFS:从起点房间出发,跳过同色门阻塞的邻接边
      const reachableRooms = new Set<number>([0]);
      const q = [0];
      while (q.length) {
        const cur = q.shift()!;
        for (const nb of adj.get(cur) ?? []) {
          if (!reachableRooms.has(nb) && !blockedEdges.has(edgeKey(cur, nb))) {
            reachableRooms.add(nb);
            q.push(nb);
          }
        }
      }
      const candidates = [...reachableRooms].filter((rid) => {
        // 避免与起点/出口中心格、其他钥匙、门格冲突
        const c = roomCenter(rooms[rid]);
        const ci = idx(c.x, c.y, GRID_W);
        if (doorCells.has(ci)) return false;
        if (keys.some((k) => k.x === c.x && k.y === c.y)) return false;
        return true;
      });
      if (candidates.length === 0) throw new Error(`颜色 ${color} 钥匙无安全房间`);
      // 候选超过 3 个时优先不放在起点房,增加返程开门的趣味
      const pool = candidates.length > 3 ? candidates.filter((r) => r !== 0) : candidates;
      const rid = rng.pick(pool.length > 0 ? pool : candidates);
      const c = roomCenter(rooms[rid]);
      keys.push({ id: keyId, color, x: c.x, y: c.y, roomId: rid });
      keyId++;
    }
  }

  return {
    version: 1,
    width: GRID_W,
    height: GRID_H,
    tiles,
    rooms,
    corridors,
    doors,
    keys,
    start,
    exit,
    colorCount,
    seed: params.seed,
    roomCount,
  };
}

/** 带验证与有限重试的生成入口 */
export function generateMap(params: GenParams): GenResult {
  if (params.roomCount < 8 || params.roomCount > 20) {
    return { ok: false, map: null, attempts: 0, error: '房间数必须在 8 到 20 之间' };
  }
  if (params.colorCount < 0 || params.colorCount > 3) {
    return { ok: false, map: null, attempts: 0, error: '锁色数量必须在 0 到 3 之间' };
  }
  const rng = new Rng(params.seed);
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const map = generateOnce(rng, params);
      const analysis = analyzeMap(map);
      if (analysis.exitReachable) {
        return { ok: true, map, attempts: attempt, error: null };
      }
      lastError = analysis.failure?.message ?? '未知原因不可达';
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    ok: false,
    map: null,
    attempts: MAX_ATTEMPTS,
    error: `经过 ${MAX_ATTEMPTS} 次尝试仍无法生成可解布局:${lastError}。可更换种子或减少房间数/锁色数。`,
  };
}
