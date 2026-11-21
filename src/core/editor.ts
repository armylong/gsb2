import { cloneMap, idx, pointInRoom } from './grid';
import type { GameMap } from './types';
import { Tile } from './types';

export type MapEdit =
  | { type: 'moveKey'; keyId: number; targetRoomId: number }
  | { type: 'setDoorColor'; doorId: number; color: number | null }
  | { type: 'removeCorridor'; corridorId: number }
  | { type: 'restoreCorridor'; corridorId: number };

export type EditRecord = MapEdit & {
  at: string; // ISO 时间,仅用于 UI 展示
  note: string;
};

function findFreeCell(map: GameMap, roomId: number): { x: number; y: number } | null {
  const room = map.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const blocked = new Set<number>();
  for (const d of map.doors) blocked.add(idx(d.x, d.y, map.width));
  for (const k of map.keys) blocked.add(idx(k.x, k.y, map.width));
  blocked.add(idx(map.start.x, map.start.y, map.width));
  blocked.add(idx(map.exit.x, map.exit.y, map.width));
  // 优先中心,再逐格扫描
  const cx = Math.floor(room.x + room.w / 2);
  const cy = Math.floor(room.y + room.h / 2);
  const tryCell = (x: number, y: number): boolean => !blocked.has(idx(x, y, map.width));
  if (tryCell(cx, cy)) return { x: cx, y: cy };
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (tryCell(x, y)) return { x, y };
    }
  }
  return null;
}

function corridorCellsInUseByOthers(map: GameMap, exceptId: number): Set<number> {
  const used = new Set<number>();
  for (const c of map.corridors) {
    if (c.id === exceptId || c.removed) continue;
    for (const p of c.cells) used.add(idx(p.x, p.y, map.width));
  }
  return used;
}

function cellInsideAnyRoom(map: GameMap, x: number, y: number): boolean {
  return map.rooms.some((r) => pointInRoom({ x, y }, r));
}

/** 应用一次人工修改,返回新地图(不可变更新);旧分析结果应由调用方作废重算 */
export function applyEdit(map: GameMap, edit: MapEdit): { map: GameMap; note: string } {
  const next = cloneMap(map);
  let note = '';
  switch (edit.type) {
    case 'moveKey': {
      const key = next.keys.find((k) => k.id === edit.keyId);
      if (!key) throw new Error(`钥匙 #${edit.keyId} 不存在`);
      const cell = findFreeCell(next, edit.targetRoomId);
      if (!cell) throw new Error(`房间 R${edit.targetRoomId} 没有可放钥匙的空格`);
      key.x = cell.x;
      key.y = cell.y;
      key.roomId = edit.targetRoomId;
      note = `钥匙 #${key.id} 移至房间 R${edit.targetRoomId}`;
      break;
    }
    case 'setDoorColor': {
      const door = next.doors.find((d) => d.id === edit.doorId);
      if (!door) throw new Error(`门 #${edit.doorId} 不存在`);
      door.color = edit.color;
      note = `门 #${door.id} 改为${edit.color === null ? '无锁(敞开)' : `颜色 ${edit.color}`}`;
      break;
    }
    case 'removeCorridor': {
      const corr = next.corridors.find((c) => c.id === edit.corridorId);
      if (!corr) throw new Error(`通道 #${edit.corridorId} 不存在`);
      if (corr.removed) throw new Error(`通道 #${edit.corridorId} 已移除`);
      corr.removed = true;
      const usedByOthers = corridorCellsInUseByOthers(next, corr.id);
      for (const p of corr.cells) {
        const i = idx(p.x, p.y, next.width);
        if (cellInsideAnyRoom(next, p.x, p.y)) continue;
        if (usedByOthers.has(i)) continue;
        next.tiles[i] = Tile.Wall;
      }
      note = `移除通道 #${corr.id}(R${corr.roomA}↔R${corr.roomB})`;
      break;
    }
    case 'restoreCorridor': {
      const corr = next.corridors.find((c) => c.id === edit.corridorId);
      if (!corr) throw new Error(`通道 #${edit.corridorId} 不存在`);
      if (!corr.removed) throw new Error(`通道 #${edit.corridorId} 未被移除`);
      corr.removed = false;
      for (const p of corr.cells) {
        const i = idx(p.x, p.y, next.width);
        if (!cellInsideAnyRoom(next, p.x, p.y)) next.tiles[i] = Tile.Corridor;
      }
      note = `恢复通道 #${corr.id}`;
      break;
    }
  }
  return { map: next, note };
}

// ---------- 保存 / 恢复 ----------

interface SerializedMap {
  version: 1;
  width: number;
  height: number;
  tiles: number[];
  rooms: GameMap['rooms'];
  corridors: GameMap['corridors'];
  doors: GameMap['doors'];
  keys: GameMap['keys'];
  start: GameMap['start'];
  exit: GameMap['exit'];
  colorCount: number;
  seed: string;
  roomCount: number;
}

export function serializeMap(map: GameMap): string {
  const data: SerializedMap = {
    version: 1,
    width: map.width,
    height: map.height,
    tiles: Array.from(map.tiles),
    rooms: map.rooms,
    corridors: map.corridors,
    doors: map.doors,
    keys: map.keys,
    start: map.start,
    exit: map.exit,
    colorCount: map.colorCount,
    seed: map.seed,
    roomCount: map.roomCount,
  };
  return JSON.stringify(data, null, 2);
}

export function deserializeMap(text: string): GameMap {
  const data = JSON.parse(text) as SerializedMap;
  if (data.version !== 1) throw new Error(`不支持的存档版本:${data.version}`);
  return { ...data, tiles: Uint8Array.from(data.tiles) };
}
