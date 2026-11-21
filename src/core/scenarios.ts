import { analyzeMap, guardingColors } from './analyzer';
import { applyEdit } from './editor';
import { generateMap } from './generator';
import { idx } from './grid';
import type { GameMap } from './types';

export interface Scenario {
  id: 'roundtrip' | 'selflock' | 'broken';
  title: string;
  description: string;
  map: GameMap;
  /** 期望的检查结论特征,供 UI 与测试断言 */
  expect: 'exit_reachable_with_backtrack' | 'self_lock' | 'terrain_broken';
}

function mustGenerate(seed: string, roomCount: number, colorCount: number): GameMap {
  const res = generateMap({ seed, roomCount, colorCount });
  if (!res.ok || !res.map) throw new Error(`现场底图生成失败:${res.error}`);
  return res.map;
}

/** 尝试多个确定性种子,直到谓词满足;全部失败则抛错 */
function trySeeds(
  prefix: string,
  roomCount: number,
  colorCount: number,
  predicate: (map: GameMap) => boolean,
  tries = 12,
): GameMap {
  let lastErr = '谓词始终不满足';
  for (let i = 1; i <= tries; i++) {
    const map = mustGenerate(`${prefix}-v${i}`, roomCount, colorCount);
    try {
      if (predicate(map)) return map;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`${prefix}:尝试 ${tries} 个种子仍失败(${lastErr})`);
}

/** 由实际通道格子推导房间邻接表(通道可能穿过第三个房间) */
function roomAdjacency(map: GameMap): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const r of map.rooms) adj.set(r.id, new Set());
  const roomOf = (p: { x: number; y: number }): number => {
    for (const r of map.rooms) if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return r.id;
    return -1;
  };
  for (const c of map.corridors) {
    if (c.removed) continue;
    let prev = roomOf(c.cells[0]);
    for (const p of c.cells) {
      const r = roomOf(p);
      if (r !== -1 && r !== prev) {
        const a = prev === -1 ? r : prev;
        adj.get(a)!.add(r);
        adj.get(r)!.add(a);
        prev = r;
      }
    }
  }
  return adj;
}

/**
 * 现场一:返程开门。
 * 把某色钥匙放进“不过同色门即可达”的支路尽头房间,而去出口的路必须经过同色门,
 * 路线因此必然出现先取钥匙再折返开门的回头路。
 */
function buildRoundtrip(): Scenario {
  const color = 0;
  const map = trySeeds('scene-roundtrip', 12, 1, (m) => {
    const redKey = m.keys.find((k) => k.color === color);
    if (!redKey) return false;
    const adj = roomAdjacency(m);
    const candidates = m.rooms
      .filter((r) => r.id !== 0)
      .filter((r) => !guardingColors(m, idx(r.x, r.y, m.width), [color]).has(color))
      .filter((r) => (adj.get(r.id)?.size ?? 0) === 1);
    return candidates.length > 0;
  });
  const key = map.keys.find((k) => k.color === color)!;
  const adj = roomAdjacency(map);
  const candidates = map.rooms
    .filter((r) => r.id !== 0)
    .filter((r) => !guardingColors(map, idx(r.x, r.y, map.width), [color]).has(color))
    .filter((r) => (adj.get(r.id)?.size ?? 0) === 1)
    .map((r) => r.id);
  const targetRoom = candidates[0];
  const { map: edited } = applyEdit(map, { type: 'moveKey', keyId: key.id, targetRoomId: targetRoom });
  const analysis = analyzeMap(edited);
  if (!analysis.exitReachable || !analysis.route) throw new Error('现场一构造失败:布局不可解');
  // 确认路线真的走了回头路:取钥匙后再次经过取钥匙之前访问过的格子
  const beforePickup = new Set<number>();
  const pickupAt = analysis.route.steps.findIndex((s) => s.pickedKeyId === key.id);
  for (const s of analysis.route.steps.slice(0, pickupAt)) beforePickup.add(idx(s.x, s.y, edited.width));
  const backtracks = analysis.route.steps
    .slice(pickupAt + 1)
    .some((s) => beforePickup.has(idx(s.x, s.y, edited.width)));
  if (!backtracks) throw new Error('现场一构造失败:路线未发生返程');
  return {
    id: 'roundtrip',
    title: '现场一:返程开门',
    description: `红色钥匙被放在支路尽头的 R${targetRoom},通往出口的红门在另一条路上。玩家必须先走进支路取钥匙,再折返回来开门——检查器不能因为“图上有钥匙”就直接判连通。`,
    map: edited,
    expect: 'exit_reachable_with_backtrack',
  };
}

/**
 * 现场二:钥匙自锁。
 * 把红色钥匙移到只能通过红色门到达的房间里:不开红门就拿不到红钥匙。
 */
function buildSelfLock(): Scenario {
  const color = 0;
  // 必须守卫颜色恰好只有红色:若还能经别的颜色门绕行,放钥匙后布局仍然可解。
  // 最终以“移动钥匙后的完整分析结果”为准,避免被其他颜色钥匙的可达路径绕过。
  const map = trySeeds('scene-selflock', 12, 2, (m) => {
    const redKey = m.keys.find((k) => k.color === color);
    if (!redKey) return false;
    for (const r of m.rooms) {
      if (r.id === 0) continue;
      const g = guardingColors(m, idx(r.x, r.y, m.width), [0, 1]);
      if (g.size !== 1 || !g.has(color)) continue;
      const { map: edited } = applyEdit(m, { type: 'moveKey', keyId: redKey.id, targetRoomId: r.id });
      const a = analyzeMap(edited);
      if (!a.exitReachable && a.failure?.reason === 'self_lock') return true;
    }
    return false;
  });
  const key = map.keys.find((k) => k.color === color)!;
  let targetRoom = -1;
  for (const r of map.rooms) {
    if (r.id === 0) continue;
    const g = guardingColors(map, idx(r.x, r.y, map.width), [0, 1]);
    if (g.size !== 1 || !g.has(color)) continue;
    const { map: edited } = applyEdit(map, { type: 'moveKey', keyId: key.id, targetRoomId: r.id });
    const a = analyzeMap(edited);
    if (!a.exitReachable && a.failure?.reason === 'self_lock') {
      targetRoom = r.id;
      break;
    }
  }
  const { map: edited } = applyEdit(map, { type: 'moveKey', keyId: key.id, targetRoomId: targetRoom });
  const analysis = analyzeMap(edited);
  if (analysis.exitReachable || analysis.failure?.reason !== 'self_lock') {
    throw new Error(`现场二构造失败:期望 self_lock,实际 ${analysis.failure?.reason ?? '可达'}`);
  }
  return {
    id: 'selflock',
    title: '现场二:钥匙自锁',
    description: `红色钥匙被移进了红门后面的 R${targetRoom}。不持有红钥匙就打不开红门,打不开门就永远拿不到红钥匙——检查器必须拒绝这种布局并指出阻塞门与相关房间。`,
    map: edited,
    expect: 'self_lock',
  };
}

/**
 * 现场三:通道断裂。
 * 从一张可解地图上移除一段通道,使出口与起点在纯地形层面就断开。
 */
function buildBroken(): Scenario {
  const base = trySeeds('scene-broken', 14, 1, (m) =>
    m.corridors.some((corr) => {
      const { map: trial } = applyEdit(m, { type: 'removeCorridor', corridorId: corr.id });
      const a = analyzeMap(trial);
      return !a.exitReachable && a.failure?.reason === 'terrain';
    }),
  );
  for (const corr of base.corridors) {
    const { map: trial } = applyEdit(base, { type: 'removeCorridor', corridorId: corr.id });
    const analysis = analyzeMap(trial);
    if (!analysis.exitReachable && analysis.failure?.reason === 'terrain') {
      return {
        id: 'broken',
        title: '现场三:通道断裂',
        description: `通道 #${corr.id}(R${corr.roomA}↔R${corr.roomB})被移除,出口所在区域与起点之间连可行走格子都不连通。检查器应先在忽略锁的连通性检查中标出断开区域,而不是误报成钥匙问题。`,
        map: trial,
        expect: 'terrain_broken',
      };
    }
  }
  throw new Error('现场三构造失败:移除任何通道都未造成地形断开');
}

export function buildScenarios(): Scenario[] {
  return [buildRoundtrip(), buildSelfLock(), buildBroken()];
}
