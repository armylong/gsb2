import { describe, expect, it } from 'vitest';
import { analyzeMap, guardingColors, validateRoute } from '../src/core/analyzer';
import { applyEdit, deserializeMap, serializeMap } from '../src/core/editor';
import { generateMap, GRID_H, GRID_W } from '../src/core/generator';
import { doorIndex, idx, roomAt } from '../src/core/grid';
import { Player } from '../src/core/player';
import { Rng } from '../src/core/rng';
import { buildScenarios } from '../src/core/scenarios';
import type { GameMap } from '../src/core/types';
import { Tile } from '../src/core/types';

/** 用分析器把路线转成逐格方向,驱动 Player 重放(逐步走路线与手动控制共用规则) */
function replayWithPlayer(map: GameMap): Player {
  const analysis = analyzeMap(map);
  expect(analysis.route).not.toBeNull();
  const player = new Player(map);
  const steps = analysis.route!.steps;
  for (let i = 1; i < steps.length; i++) {
    const dx = steps[i].x - steps[i - 1].x;
    const dy = steps[i].y - steps[i - 1].y;
    const res = player.move(dx, dy);
    expect(res.ok, `第 ${i} 步移动被拒:${res.blockedReason}`).toBe(true);
    expect(player.x).toBe(steps[i].x);
    expect(player.y).toBe(steps[i].y);
    if (steps[i].openedDoorId !== null) expect(res.openedDoorId).toBe(steps[i].openedDoorId);
    if (steps[i].pickedKeyId !== null) expect(res.pickedKeyId).toBe(steps[i].pickedKeyId);
  }
  expect(player.atExit).toBe(true);
  return player;
}

describe('RNG 确定性', () => {
  it('相同字符串种子产生相同序列', () => {
    const a = new Rng('hello-13774');
    const b = new Rng('hello-13774');
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('不同种子产生不同序列', () => {
    const a = new Rng('seed-a');
    const b = new Rng('seed-b');
    expect(a.next()).not.toBe(b.next());
  });

  it('洗牌与区间整数稳定', () => {
    const r1 = new Rng(42);
    const r2 = new Rng(42);
    expect(r1.shuffle([1, 2, 3, 4, 5])).toEqual(r2.shuffle([1, 2, 3, 4, 5]));
    const r3 = new Rng(42);
    const r4 = new Rng(42);
    const intsA = Array.from({ length: 50 }, () => r3.int(8, 20));
    const intsB = Array.from({ length: 50 }, () => r4.int(8, 20));
    expect(intsA).toEqual(intsB);
    expect(intsA.every((n) => n >= 8 && n <= 20)).toBe(true);
  });
});

describe('固定种子的布局确定性', () => {
  it('相同种子与参数生成完全相同的布局与物品位置', () => {
    const params = { seed: 'fixed-seed-xyz', roomCount: 12, colorCount: 3 };
    const r1 = generateMap(params);
    const r2 = generateMap(params);
    expect(r1.ok && r2.ok).toBe(true);
    expect(serializeMap(r1.map!)).toBe(serializeMap(r2.map!));
    expect(Array.from(r1.map!.tiles)).toEqual(Array.from(r2.map!.tiles));
    expect(r1.map!.doors).toEqual(r2.map!.doors);
    expect(r1.map!.keys).toEqual(r2.map!.keys);
  });

  it('种子相同但参数不同,布局不同', () => {
    const r1 = generateMap({ seed: 'same', roomCount: 10, colorCount: 1 });
    const r2 = generateMap({ seed: 'same', roomCount: 14, colorCount: 1 });
    expect(serializeMap(r1.map!)).not.toBe(serializeMap(r2.map!));
  });

  it('房间数超出范围被拒绝', () => {
    expect(generateMap({ seed: 'x', roomCount: 7, colorCount: 0 }).ok).toBe(false);
    expect(generateMap({ seed: 'x', roomCount: 21, colorCount: 0 }).ok).toBe(false);
    expect(generateMap({ seed: 'x', roomCount: 12, colorCount: 4 }).ok).toBe(false);
  });
});

describe('地图几何与实际格子连通', () => {
  const seeds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const counts = [8, 10, 14, 20];

  it.each(seeds.flatMap((s) => counts.map((c) => [s, c] as const)))(
    '种子 %s / %s 房间:房间互不重叠且全部地形连通',
    (seed, roomCount) => {
      const res = generateMap({ seed, roomCount, colorCount: 2 });
      expect(res.ok, res.error ?? undefined).toBe(true);
      const map = res.map!;
      expect(map.rooms).toHaveLength(roomCount);
      // 矩形互不重叠(含 1 格墙间距)
      for (let i = 0; i < map.rooms.length; i++) {
        for (let j = i + 1; j < map.rooms.length; j++) {
          const a = map.rooms[i];
          const b = map.rooms[j];
          const overlap =
            a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
          expect(overlap, `R${a.id} 与 R${b.id} 重叠`).toBe(false);
        }
      }
      // 所有通道格子确实可行走,且每条通道两端接入房间内部
      for (const c of map.corridors) {
        expect(c.cells.length).toBeGreaterThan(1);
        for (const p of c.cells) {
          expect(map.tiles[idx(p.x, p.y, map.width)]).not.toBe(Tile.Wall);
        }
        expect(roomAt(map, c.cells[0].x, c.cells[0].y)).toBe(c.roomA);
        expect(roomAt(map, c.cells[c.cells.length - 1].x, c.cells[c.cells.length - 1].y)).toBe(c.roomB);
      }
      // 分析器:忽略锁时所有房间都从起点可达
      const analysis = analyzeMap(map);
      expect(analysis.disconnectedRooms).toEqual([]);
      for (const r of map.rooms) {
        expect(analysis.terrainReachable.has(idx(r.x, r.y, map.width))).toBe(true);
      }
      // 生成器正常输出必须通过锁钥检查
      expect(analysis.exitReachable).toBe(true);
    },
  );

  it('起点与出口明确且为可行走格', () => {
    const map = generateMap({ seed: 'start-exit', roomCount: 9, colorCount: 0 }).map!;
    expect(map.tiles[idx(map.start.x, map.start.y, map.width)]).not.toBe(Tile.Wall);
    expect(map.tiles[idx(map.exit.x, map.exit.y, map.width)]).not.toBe(Tile.Wall);
    expect(roomAt(map, map.start.x, map.start.y)).toBe(0);
    expect(roomAt(map, map.exit.x, map.exit.y)).not.toBe(-1);
  });

  it('门与钥匙都落在可行走格上,门属于某条通道', () => {
    const map = generateMap({ seed: 'doors', roomCount: 12, colorCount: 3 }).map!;
    const corridorCells = new Set(map.corridors.flatMap((c) => c.cells.map((p) => idx(p.x, p.y, map.width))));
    for (const d of map.doors) {
      expect(map.tiles[idx(d.x, d.y, map.width)]).not.toBe(Tile.Wall);
      expect(corridorCells.has(idx(d.x, d.y, map.width))).toBe(true);
    }
    for (const k of map.keys) {
      expect(map.tiles[idx(k.x, k.y, map.width)]).not.toBe(Tile.Wall);
      expect(roomAt(map, k.x, k.y)).toBe(k.roomId);
    }
    expect(new Set(map.keys.map((k) => k.color))).toEqual(new Set([0, 1, 2]));
  });
});

describe('锁钥可达与返程取钥匙', () => {
  it('现场一:钥匙在支路尽头,路线先取钥匙再返程开门', () => {
    const scenario = buildScenarios().find((s) => s.id === 'roundtrip')!;
    const map = scenario.map;
    const analysis = analyzeMap(map);
    expect(analysis.exitReachable).toBe(true);
    expect(analysis.route).not.toBeNull();
    const redKey = map.keys.find((k) => k.color === 0)!;
    const redDoors = map.doors.filter((d) => d.color === 0);
    expect(redDoors.length).toBeGreaterThan(0);
    const pickup = analysis.route!.steps.findIndex((s) => s.pickedKeyId === redKey.id);
    expect(pickup).toBeGreaterThan(0);
    // 路线实际经过的红门,通过时刻都晚于拾取时刻(未经过的门 findIndex 为 -1,跳过)
    for (const d of redDoors) {
      const openAt = analysis.route!.steps.findIndex((s) => s.openedDoorId === d.id);
      if (openAt !== -1) expect(openAt).toBeGreaterThan(pickup);
    }
    // 至少经过一扇红门,否则锁钥逻辑没有被路线检验
    expect(analysis.route!.steps.some((s) => s.openedDoorId !== null)).toBe(true);
    // 钥匙所在格子在开门之前不在路线前段可达门的捷径上:验证发生返程
    const before = new Set(analysis.route!.steps.slice(0, pickup).map((s) => idx(s.x, s.y, map.width)));
    const after = analysis.route!.steps.slice(pickup + 1);
    expect(after.some((s) => before.has(idx(s.x, s.y, map.width)))).toBe(true);
    // 逐步合法性校验
    const v = validateRoute(map, analysis.route!.steps);
    expect(v.ok, v.error ?? undefined).toBe(true);
    replayWithPlayer(map);
  });

  it('锁后钥匙不会被算作已获得:移动前可达,移动后不可达', () => {
    const map = generateMap({ seed: 'reach-check', roomCount: 13, colorCount: 2 }).map!;
    const before = analyzeMap(map);
    expect(before.keyInfos.every((k) => k.obtainable)).toBe(true);
    // 把红色钥匙塞进红门后的房间
    const redKey = map.keys.find((k) => k.color === 0)!;
    const behind = map.rooms
      .filter((r) => guardingColors(map, idx(r.x, r.y, map.width), [0]).has(0))
      .map((r) => r.id);
    expect(behind.length).toBeGreaterThan(0);
    const { map: edited } = applyEdit(map, { type: 'moveKey', keyId: redKey.id, targetRoomId: behind[0] });
    const after = analyzeMap(edited);
    expect(after.exitReachable).toBe(false);
    expect(after.keyInfos.find((k) => k.keyId === redKey.id)!.obtainable).toBe(false);
    expect(after.failure?.reason === 'self_lock' || after.failure?.reason === 'circular').toBe(true);
  });

  it('现场二:钥匙自锁被拒绝并指出阻塞门与房间', () => {
    const scenario = buildScenarios().find((s) => s.id === 'selflock')!;
    const analysis = analyzeMap(scenario.map);
    expect(analysis.exitReachable).toBe(false);
    expect(analysis.failure?.reason).toBe('self_lock');
    expect(analysis.failure!.blockers.length).toBeGreaterThan(0);
    expect(analysis.failure!.roomIds.length).toBeGreaterThan(0);
    expect(analysis.failure!.colors).toContain(0);
    // 阻塞门确实是红门且邻接当前可达区域
    for (const b of analysis.failure!.blockers) {
      expect(b.color).toBe(0);
      expect(scenario.map.doors[b.doorId].color).toBe(0);
    }
    // 自锁图没有路线
    expect(analysis.route).toBeNull();
  });

  it('缺少钥匙:同色门存在但地图上没有该色钥匙', () => {
    const map = generateMap({ seed: 'missing', roomCount: 10, colorCount: 1 }).map!;
    // 把唯一的红钥匙移出地图:通过把钥匙颜色改成不存在的新 id 不行,改为删钥匙
    const edited: GameMap = {
      ...map,
      tiles: map.tiles.slice(),
      keys: map.keys.filter((k) => k.color !== 0),
      doors: map.doors.map((d) => ({ ...d })),
    };
    const analysis = analyzeMap(edited);
    expect(analysis.exitReachable).toBe(false);
    expect(analysis.failure?.reason).toBe('missing_key');
    expect(analysis.failure!.colors).toContain(0);
  });

  it('门改无锁后无需钥匙即可通过', () => {
    const map = generateMap({ seed: 'unlock', roomCount: 10, colorCount: 1 }).map!;
    const door = map.doors.find((d) => d.color === 0)!;
    const { map: edited } = applyEdit(map, { type: 'setDoorColor', doorId: door.id, color: null });
    const analysis = analyzeMap(edited);
    expect(analysis.exitReachable).toBe(true);
    // 不持有红钥匙的玩家也能走通
    const player = new Player(edited);
    const steps = analysis.route!.steps;
    for (let i = 1; i < steps.length; i++) {
      const res = player.move(steps[i].x - steps[i - 1].x, steps[i].y - steps[i - 1].y);
      expect(res.ok).toBe(true);
    }
    expect(player.atExit).toBe(true);
  });
});

describe('通道断裂与地形诊断', () => {
  it('现场三:移除通道后地形断开,报告断开房间', () => {
    const scenario = buildScenarios().find((s) => s.id === 'broken')!;
    const analysis = analyzeMap(scenario.map);
    expect(analysis.exitReachable).toBe(false);
    expect(analysis.failure?.reason).toBe('terrain');
    expect(analysis.disconnectedRooms.length).toBeGreaterThan(0);
    expect(analysis.disconnectedComponents.size).toBeGreaterThan(0);
    // 断开区域的格子确实与起点不在同一分量
    const startComp = analysis.components[idx(scenario.map.start.x, scenario.map.start.y, scenario.map.width)];
    for (const rid of analysis.disconnectedRooms) {
      const r = scenario.map.rooms[rid];
      expect(analysis.components[idx(r.x, r.y, scenario.map.width)]).not.toBe(startComp);
    }
  });

  it('移除通道会把独占格子变回墙,恢复后重新连通', () => {
    const map = generateMap({ seed: 'remove-restore', roomCount: 10, colorCount: 1 }).map!;
    // 找一条带独占格子的通道
    const target = map.corridors.find((c) => {
      const others = map.corridors.filter((o) => o.id !== c.id);
      return c.cells.some((p) => {
        if (roomAt(map, p.x, p.y) !== -1) return false;
        return !others.some((o) => o.cells.some((q) => q.x === p.x && q.y === p.y));
      });
    })!;
    const cell = target.cells.find((p) => {
      if (roomAt(map, p.x, p.y) !== -1) return false;
      return !map.corridors
        .filter((o) => o.id !== target.id)
        .some((o) => o.cells.some((q) => q.x === p.x && q.y === p.y));
    })!;
    const { map: removed } = applyEdit(map, { type: 'removeCorridor', corridorId: target.id });
    expect(removed.tiles[idx(cell.x, cell.y, removed.width)]).toBe(Tile.Wall);
    const { map: restored } = applyEdit(removed, { type: 'restoreCorridor', corridorId: target.id });
    expect(restored.tiles[idx(cell.x, cell.y, restored.width)]).toBe(Tile.Corridor);
    expect(analyzeMap(restored).exitReachable).toBe(true);
  });
});

describe('路线每一步合法性', () => {
  it('多种子路线全部通过逐步校验且 Player 重放到出口', () => {
    for (const seed of ['rt-1', 'rt-2', 'rt-3', 'rt-4']) {
      for (const colorCount of [0, 1, 2, 3]) {
        const res = generateMap({ seed, roomCount: 11, colorCount });
        expect(res.ok, res.error ?? undefined).toBe(true);
        const map = res.map!;
        const analysis = analyzeMap(map);
        expect(analysis.route).not.toBeNull();
        const v = validateRoute(map, analysis.route!.steps);
        expect(v.ok, `${seed}/${colorCount}: ${v.error}`).toBe(true);
        const player = replayWithPlayer(map);
        // 经过门时一定已持有对应颜色
        for (const s of analysis.route!.steps) {
          if (s.openedDoorId !== null) {
            const door = map.doors[s.openedDoorId];
            expect(s.heldColors).toContain(door.color);
          }
        }
        expect(player.history).toHaveLength(analysis.route!.steps.length);
      }
    }
  });

  it('非法路线被拒绝:穿墙、无钥匙过门、跳跃移动', () => {
    const map = generateMap({ seed: 'illegal', roomCount: 10, colorCount: 1 }).map!;
    const good = analyzeMap(map).route!.steps;
    expect(validateRoute(map, good).ok).toBe(true);

    // 跳跃移动
    const jump = good.map((s) => ({ ...s }));
    jump[1] = { ...jump[1], x: jump[1].x + 2 };
    expect(validateRoute(map, jump).ok).toBe(false);

    // 穿墙:把一步改成墙格
    const wallStep = good.find((s) => map.tiles[idx(s.x, s.y, map.width)] !== Tile.Wall)!;
    void wallStep;
    let wallPoint = { x: 0, y: 0 };
    outer: for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.tiles[idx(x, y, map.width)] === Tile.Wall) {
          wallPoint = { x, y };
          break outer;
        }
      }
    }
    const intoWall = good.map((s) => ({ ...s }));
    intoWall[1] = { ...intoWall[1], x: wallPoint.x, y: wallPoint.y };
    expect(validateRoute(map, intoWall).ok).toBe(false);

    // 无钥匙过门:清空路线里所有持有记录
    const noKeys = good.map((s) => ({ ...s, heldColors: [] }));
    expect(validateRoute(map, noKeys).ok).toBe(false);
  });

  it('钥匙不消耗:同色多门共用一把钥匙', () => {
    // 手工构造:需要至少两扇同色门
    const res = generateMap({ seed: 'shared-key', roomCount: 16, colorCount: 1 });
    const map = res.map!;
    if (map.doors.filter((d) => d.color === 0).length < 2) {
      // 给第二扇门加红锁
      const unlocked = map.corridors.find((c) => !map.doors.some((d) => d.corridorId === c.id));
      expect(unlocked).toBeDefined();
      const cell = unlocked!.cells.find((p) => roomAt(map, p.x, p.y) === -1)!;
      map.doors.push({
        id: map.doors.length,
        x: cell.x,
        y: cell.y,
        color: 0,
        corridorId: unlocked!.id,
      });
    }
    const analysis = analyzeMap(map);
    expect(analysis.exitReachable).toBe(true);
    const redKeyCount = map.keys.filter((k) => k.color === 0).length;
    const redDoorCount = map.doors.filter((d) => d.color === 0).length;
    expect(redDoorCount).toBeGreaterThanOrEqual(2);
    expect(redKeyCount).toBe(1); // 一把钥匙
    const player = replayWithPlayer(map);
    expect(player.heldColors.has(0)).toBe(true); // 仍然持有,未消耗
    // 路线实际经过的红门都被同一把钥匙打开
    const passedDoors = new Set(analysis.route!.steps.map((s) => s.openedDoorId).filter((x): x is number => x !== null));
    expect(passedDoors.size).toBeGreaterThanOrEqual(1);
    for (const id of passedDoors) {
      expect(map.doors[id].color).toBe(0);
      expect(player.openedDoorIds.has(id)).toBe(true);
    }
  });
});

describe('人工修改失效与保存恢复', () => {
  it('修改后必须重新检查:旧路线对新地图不再合法', () => {
    const map = generateMap({ seed: 'stale', roomCount: 12, colorCount: 2 }).map!;
    const oldRoute = analyzeMap(map).route!;
    // 移动钥匙制造自锁
    const redKey = map.keys.find((k) => k.color === 0)!;
    const behind = map.rooms
      .filter((r) => guardingColors(map, idx(r.x, r.y, map.width), [0]).has(0))
      .map((r) => r.id);
    const { map: edited } = applyEdit(map, { type: 'moveKey', keyId: redKey.id, targetRoomId: behind[0] });
    const newAnalysis = analyzeMap(edited);
    expect(newAnalysis.exitReachable).toBe(false);
    // 旧路线在新地图上校验失败(门还在,但钥匙拿不到 → 持有状态对不上)
    const oldOnNew = validateRoute(edited, oldRoute.steps);
    expect(oldOnNew.ok).toBe(false);
  });

  it('存档往返:序列化后恢复的地图与原地图字节级一致', () => {
    const map = generateMap({ seed: 'save-me', roomCount: 13, colorCount: 3 }).map!;
    const text = serializeMap(map);
    const restored = deserializeMap(text);
    expect(serializeMap(restored)).toBe(text);
    expect(restored).toEqual(map);
    // 恢复后检查结论一致
    expect(analyzeMap(restored).exitReachable).toBe(analyzeMap(map).exitReachable);
  });

  it('手动控制撞锁门被拒,拿到钥匙后同一扇门可通过', () => {
    const map = generateMap({ seed: 'manual', roomCount: 10, colorCount: 1 }).map!;
    const player = new Player(map);
    const doorAt = doorIndex(map);
    // 找到从起点最近的红门,尝试在没钥匙时走过去:沿无锁 BFS 走到门旁
    const door = map.doors.find((d) => d.color === 0)!;
    const seen = new Set<number>([idx(player.x, player.y, map.width)]);
    const prev = new Map<number, number>();
    const q = [idx(player.x, player.y, map.width)];
    while (q.length) {
      const cur = q.shift()!;
      const x = cur % map.width;
      const y = Math.floor(cur / map.width);
      for (const n of [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 },
      ]) {
        const ni = idx(n.x, n.y, map.width);
        if (seen.has(ni) || map.tiles[ni] === Tile.Wall) continue;
        if (doorAt.has(ni)) continue; // 不走门
        seen.add(ni);
        prev.set(ni, cur);
        q.push(ni);
      }
    }
    // 门的邻居中找一个可达格子
    const neighbor = [
      { x: door.x + 1, y: door.y },
      { x: door.x - 1, y: door.y },
      { x: door.x, y: door.y + 1 },
      { x: door.x, y: door.y - 1 },
    ].find((p) => seen.has(idx(p.x, p.y, map.width)))!;
    const path: number[] = [];
    let cur = idx(neighbor.x, neighbor.y, map.width);
    while (cur !== idx(map.start.x, map.start.y, map.width)) {
      path.push(cur);
      cur = prev.get(cur)!;
    }
    path.reverse();
    let last = idx(player.x, player.y, map.width);
    for (const cell of path) {
      const res = player.move((cell % map.width) - (last % map.width), Math.floor(cell / map.width) - Math.floor(last / map.width));
      expect(res.ok).toBe(true);
      last = cell;
    }
    expect(player.heldColors.has(0)).toBe(false);
    const blocked = player.move(door.x - player.x, door.y - player.y);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedReason).toContain('锁');
  });
});

describe('内置现场集合', () => {
  it('三个现场均可确定性重建且符合各自预期', () => {
    const s1 = buildScenarios();
    const s2 = buildScenarios();
    expect(s1.map((s) => serializeMap(s.map))).toEqual(s2.map((s) => serializeMap(s.map)));
    expect(s1.map((s) => s.id)).toEqual(['roundtrip', 'selflock', 'broken']);
    expect(analyzeMap(s1[0].map).exitReachable).toBe(true);
    expect(analyzeMap(s1[1].map).failure?.reason).toBe('self_lock');
    expect(analyzeMap(s1[2].map).failure?.reason).toBe('terrain');
  });
});

describe('网格尺寸常量', () => {
  it('地图尺寸符合渲染约定', () => {
    expect(GRID_W).toBeGreaterThan(0);
    expect(GRID_H).toBeGreaterThan(0);
    const map = generateMap({ seed: 'size', roomCount: 8, colorCount: 0 }).map!;
    expect(map.width).toBe(GRID_W);
    expect(map.height).toBe(GRID_H);
    expect(map.tiles.length).toBe(GRID_W * GRID_H);
  });
});
