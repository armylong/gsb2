import type { GameMap, Point, Rect, Room } from './types';
import { Tile } from './types';

export function idx(x: number, y: number, width: number): number {
  return y * width + x;
}

export function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 两个矩形是否相交(含边界接触——房间之间必须留至少一格墙) */
export function rectsOverlap(a: Rect, b: Rect, padding = 1): boolean {
  return (
    a.x - padding < b.x + b.w &&
    a.x + a.w + padding > b.x &&
    a.y - padding < b.y + b.h &&
    a.y + a.h + padding > b.y
  );
}

export function pointInRoom(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

export function roomCenter(r: Rect): Point {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

/** 点所在的房间 id,不在任何房间内返回 -1 */
export function roomAt(map: GameMap, x: number, y: number): number {
  for (const r of map.rooms) {
    if (pointInRoom({ x, y }, r)) return r.id;
  }
  return -1;
}

export function getTile(map: GameMap, x: number, y: number): number {
  if (!inBounds(x, y, map.width, map.height)) return Tile.Wall;
  return map.tiles[idx(x, y, map.width)];
}

export function isWalkable(map: GameMap, x: number, y: number): boolean {
  return getTile(map, x, y) !== Tile.Wall;
}

/** 四邻接的可行走格子 */
export function walkableNeighbors(map: GameMap, x: number, y: number): Point[] {
  const out: Point[] = [];
  const candidates: Point[] = [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ];
  for (const c of candidates) {
    if (inBounds(c.x, c.y, map.width, map.height) && isWalkable(map, c.x, c.y)) {
      out.push(c);
    }
  }
  return out;
}

/** 门位置快速查表:cellIndex -> door */
export function doorIndex(map: GameMap): Map<number, number> {
  const m = new Map<number, number>();
  for (const d of map.doors) m.set(idx(d.x, d.y, map.width), d.id);
  return m;
}

export function keyAt(map: GameMap, x: number, y: number): number {
  for (const k of map.keys) if (k.x === x && k.y === y) return k.id;
  return -1;
}

/** 深拷贝地图(Uint8Array 也复制),用于编辑前快照 */
export function cloneMap(map: GameMap): GameMap {
  return {
    ...map,
    tiles: map.tiles.slice(),
    rooms: map.rooms.map((r) => ({ ...r })),
    corridors: map.corridors.map((c) => ({ ...c, cells: c.cells.map((p) => ({ ...p })) })),
    doors: map.doors.map((d) => ({ ...d })),
    keys: map.keys.map((k) => ({ ...k })),
    start: { ...map.start },
    exit: { ...map.exit },
  };
}

/** 把房间 id 列表转成可读名字 */
export function roomLabel(map: GameMap, roomId: number): string {
  const r = map.rooms.find((rm) => rm.id === roomId);
  return r ? r.name : `房间#${roomId}`;
}

/** 房间内全部格子 */
export function roomCells(r: Room): Point[] {
  const out: Point[] = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  }
  return out;
}
