import {
  addPos,
  Block,
  Dir,
  GameMap,
  key,
  Pos,
  TeleCell,
} from './types';
import { Rng } from './rng';

export const blockAt = (map: GameMap, p: Pos): Block | undefined =>
  map.blocks.find((b) => b.x === p.x && b.y === p.y);

export const wallAt = (map: GameMap, p: Pos): boolean => !!map.walls[key(p.x, p.y)];

export const beltAt = (map: GameMap, p: Pos): Dir | undefined => map.belts[key(p.x, p.y)];

export const teleAt = (map: GameMap, p: Pos): TeleCell | undefined =>
  map.teles.find((t) => t.x === p.x && t.y === p.y);

export const inBounds = (map: GameMap, p: Pos): boolean =>
  p.x >= 0 && p.y >= 0 && p.x < map.w && p.y < map.h;

/** 深拷贝地图（快照/倒退/回放都依赖它） */
export function cloneMap(map: GameMap): GameMap {
  return {
    w: map.w,
    h: map.h,
    walls: { ...map.walls },
    belts: { ...map.belts },
    blocks: map.blocks.map((b) => ({ ...b })),
    teles: map.teles.map((t) => ({ ...t })),
    player: { ...map.player },
  };
}

let seq = 0;
export const nextBlockId = (): string => `b${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * 预设 1：对推 / 同格竞争
 *  - 两条输送带把两个方块送往同一个格（同格合并竞争，按稳定优先级取消败者）
 *  - 另有一组迎头对撞（循环，双方同时取消）
 */
export function presetOpposingPush(): GameMap {
  const w = 10;
  const h = 8;
  const walls: Record<string, true> = {};
  const belts: Record<string, Dir> = {};

  // 同格竞争：(2,1) 向右、(4,3) 向上，目标都是 (3,1)... 设计成共同目标 (4,1)
  // A: (2,1) -> right -> (3,1) -> right -> (4,1)
  belts[key(2, 1)] = 'right';
  belts[key(3, 1)] = 'right';
  // B: (4,3) -> up -> (4,2) -> up -> (4,1)
  belts[key(4, 3)] = 'up';
  belts[key(4, 2)] = 'up';

  // 迎头对撞：同一行两条方向相反的输送带
  belts[key(2, 5)] = 'right';
  belts[key(3, 5)] = 'right';
  belts[key(5, 5)] = 'left';
  belts[key(6, 5)] = 'left';

  // 输送带撞墙：左送带尽头放墙，方块应被取消
  belts[key(1, 7)] = 'left';
  walls[key(0, 7)] = true;

  // 重量 3 的方块放在输送带上，力 2 推不动，应被取消并高亮
  belts[key(8, 3)] = 'up';

  return {
    w,
    h,
    walls,
    belts,
    blocks: [
      { id: 'A', x: 2, y: 1, weight: 1 },
      { id: 'B', x: 4, y: 3, weight: 1 },
      { id: 'C', x: 2, y: 5, weight: 1 },
      { id: 'D', x: 6, y: 5, weight: 1 },
      { id: 'E', x: 1, y: 7, weight: 1 },
      { id: 'H', x: 8, y: 3, weight: 3 },
    ],
    teles: [],
    player: { x: 0, y: 0 },
  };
}

/**
 * 预设 2：连续推动（链条）
 *  - 第一行：玩家 + 重量1 + 重量1 + 重量1，总重 3 = 推力，整排可推，尽头是空地
 *  - 第二行：玩家 + 重量2 + 重量2，总重 4 > 推力 3，整次移动失效
 *  - 第三行：玩家 + 链条，尽头是墙，整次移动失效（无一物移动）
 *  - 右侧：重量3 单块，玩家可推（3 <= 3），再往后一格是重量1，则总重 4 推不动
 */
export function presetChainPush(): GameMap {
  const walls: Record<string, true> = {};
  walls[key(9, 4)] = true;
  return {
    w: 10,
    h: 8,
    walls,
    belts: {},
    blocks: [
      // 链条 1：可推
      { id: 'S1', x: 1, y: 1, weight: 1 },
      { id: 'S2', x: 2, y: 1, weight: 1 },
      { id: 'S3', x: 3, y: 1, weight: 1 },
      // 链条 2：超重
      { id: 'T1', x: 1, y: 3, weight: 2 },
      { id: 'T2', x: 2, y: 3, weight: 2 },
      // 链条 3：撞墙
      { id: 'U1', x: 6, y: 4, weight: 1 },
      { id: 'U2', x: 7, y: 4, weight: 1 },
      { id: 'U3', x: 8, y: 4, weight: 1 },
      // 单块重 3 可推；再加一块则超重
      { id: 'V1', x: 4, y: 6, weight: 3 },
      { id: 'V2', x: 6, y: 6, weight: 1 },
    ],
    teles: [],
    player: { x: 0, y: 1 },
  };
}

/**
 * 预设 3：传送入口冲突
 *  - 传送对 P1：入口 (2,2) -> 出口 (7,2)
 *  - 传送对 P2：入口 (7,5) -> 出口 (2,5)
 *  - 出口 (7,2) 初始被方块占据：玩家走入入口时传送被阻塞，玩家留在入口
 *  - 方块 X 被输送带送进入口 P1（同拍先输送带后传送，下一拍传送）
 *  - 两个方块经不同入口同拍到达同一出口：按稳定优先级只过一个，另一个阻塞
 *  - 自环保护：P3 入口出口在地图右下，供编辑器试验，链条传送同拍每实体至多一次
 */
export function presetTeleportConflict(): GameMap {
  const walls: Record<string, true> = {};
  const belts: Record<string, Dir> = {};
  // 方块 X：(1,2) 输送带向右送入入口 (2,2)
  belts[key(1, 2)] = 'right';

  // 同拍双入口争同一出口：
  // 入口 (2,6) 与 (5,0) 都配到出口 (8,6)；用两个方块分别压住入口
  // （用 P4/P5 两对，出口同格——允许多对共享出口，竞争规则与输送带一致）
  return {
    w: 10,
    h: 8,
    walls,
    belts,
    blocks: [
      { id: 'O', x: 7, y: 2, weight: 1 }, // 堵住 P1 出口
      { id: 'X', x: 1, y: 2, weight: 1 }, // 被送进入口
      { id: 'L', x: 2, y: 6, weight: 1 }, // 压住 P4 入口
      { id: 'R', x: 5, y: 0, weight: 1 }, // 压住 P5 入口
    ],
    teles: [
      { pairId: 'P1', kind: 'in', x: 2, y: 2 },
      { pairId: 'P1', kind: 'out', x: 7, y: 2 },
      { pairId: 'P2', kind: 'in', x: 7, y: 5 },
      { pairId: 'P2', kind: 'out', x: 2, y: 5 },
      { pairId: 'P4', kind: 'in', x: 2, y: 6 },
      { pairId: 'P4', kind: 'out', x: 8, y: 6 },
      { pairId: 'P5', kind: 'in', x: 5, y: 0 },
      { pairId: 'P5', kind: 'out', x: 8, y: 6 },
    ],
    player: { x: 0, y: 0 },
  };
}

export const PRESETS: Record<string, () => GameMap> = {
  '对推/同格竞争': presetOpposingPush,
  '连续推动链条': presetChainPush,
  '传送入口冲突': presetTeleportConflict,
};

/**
 * 种子随机地图：保证地图合法（墙/带/方块/传送门不互占，玩家唯一，传送成对）。
 * 不保证可解，只用于快速铺大量场景做不变量压力测试。
 */
export function randomMap(seed: number, w = 10, h = 8): GameMap {
  const rng = new Rng(seed);
  const occupied = new Set<string>();
  const walls: Record<string, true> = {};
  const belts: Record<string, Dir> = {};
  const blocks: Block[] = [];
  const teles: TeleCell[] = [];
  const dirs: Dir[] = ['up', 'down', 'left', 'right'];
  const take = (): Pos | null => {
    for (let tries = 0; tries < 50; tries++) {
      const p = { x: rng.int(0, w - 1), y: rng.int(0, h - 1) };
      const k = key(p.x, p.y);
      if (!occupied.has(k)) {
        occupied.add(k);
        return p;
      }
    }
    return null;
  };

  const playerPos = take() ?? { x: 0, y: 0 };
  occupied.add(key(playerPos.x, playerPos.y));

  const wallCount = rng.int(4, 8);
  for (let i = 0; i < wallCount; i++) {
    const p = take();
    if (p) walls[key(p.x, p.y)] = true;
  }
  const beltCount = rng.int(4, 10);
  for (let i = 0; i < beltCount; i++) {
    const p = take();
    if (p) belts[key(p.x, p.y)] = rng.pick(dirs);
  }
  const blockCount = rng.int(4, 9);
  for (let i = 0; i < blockCount; i++) {
    const p = take();
    if (p) blocks.push({ id: `r${i}`, ...p, weight: rng.int(1, 3) as 1 | 2 | 3 });
  }
  // 1~2 对传送门
  const pairCount = rng.int(1, 2);
  for (let i = 0; i < pairCount; i++) {
    const a = take();
    const b = take();
    if (a && b) {
      teles.push({ pairId: `T${i}`, kind: 'in', ...a });
      teles.push({ pairId: `T${i}`, kind: 'out', ...b });
    }
  }
  return { w, h, walls, belts, blocks, teles, player: playerPos };
}

/** 编辑器放置校验：目标格当前是否被刚性对象占据 */
export function occupiedBySolid(map: GameMap, p: Pos): 'wall' | 'block' | 'tele' | 'player' | null {
  if (wallAt(map, p)) return 'wall';
  if (blockAt(map, p)) return 'block';
  if (teleAt(map, p)) return 'tele';
  if (map.player.x === p.x && map.player.y === p.y) return 'player';
  return null;
}

export function dirsFromTool(tool: string): Dir | null {
  if (tool.startsWith('belt-')) return tool.slice(5) as Dir;
  return null;
}

export { addPos };
