import {
  addPos,
  Block,
  BELT_FORCE,
  Dir,
  GameState,
  GameMap,
  Input,
  PLAYER_PUSH_FORCE,
  Pos,
  TickEvent,
  key,
  posKey,
  samePos,
} from './types';
import {
  beltAt,
  blockAt,
  cloneMap,
  inBounds,
  teleAt,
  wallAt,
} from './map';

export function createState(map: GameMap, seed = 1): GameState {
  return { map: cloneMap(map), tick: 0, events: [], rngState: seed >>> 0 };
}

export function cloneState(s: GameState): GameState {
  return {
    map: cloneMap(s.map),
    tick: s.tick,
    events: s.events.map((e) => ({ ...e })),
    rngState: s.rngState,
  };
}

interface EntityRef {
  kind: 'block' | 'player';
  id: string;
  pos: Pos;
  block?: Block;
}

const blockSubject = (id: string) => `block:${id}`;
const PLAYER_SUBJECT = 'player';

function allEntities(map: GameMap): EntityRef[] {
  const blocks = map.blocks
    .map((b): EntityRef => ({ kind: 'block', id: blockSubject(b.id), pos: b, block: b }))
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));
  return [...blocks, { kind: 'player', id: PLAYER_SUBJECT, pos: map.player }];
}

// ---------------------------------------------------------------- 玩家阶段

function playerPhase(state: GameState, input: Input): void {
  if (input === 'idle') return;
  const dir: Dir = input;
  const { map } = state;
  const target = addPos(map.player, dir);
  const ev = (e: Omit<TickEvent, 'phase'>): TickEvent => ({ ...e, phase: 'player' });

  if (!inBounds(map, target)) {
    state.events.push(
      ev({ kind: 'player-blocked', subject: PLAYER_SUBJECT, detail: '地图边界', from: { ...map.player }, to: target }),
    );
    return;
  }
  if (wallAt(map, target)) {
    state.events.push(
      ev({ kind: 'player-blocked', subject: PLAYER_SUBJECT, detail: '墙', from: { ...map.player }, to: target }),
    );
    return;
  }

  // 沿推动方向收集整排方块
  const chain: Block[] = [];
  let cursor: Pos = target;
  let b = blockAt(map, cursor);
  while (b) {
    chain.push(b);
    cursor = addPos(cursor, dir);
    b = blockAt(map, cursor);
  }

  if (chain.length > 0) {
    // 链条末端的下一格决定整次推动是否可行
    if (!inBounds(map, cursor)) {
      state.events.push(
        ev({
          kind: 'push-blocked',
          subject: PLAYER_SUBJECT,
          detail: `链条末端是地图边界，整次移动失效（${chain.length} 个方块均不动）`,
          from: { ...map.player },
          to: target,
        }),
      );
      return;
    }
    if (wallAt(map, cursor)) {
      state.events.push(
        ev({
          kind: 'push-blocked',
          subject: PLAYER_SUBJECT,
          detail: `链条末端被墙阻塞，整次移动失效（${chain.length} 个方块均不动）`,
          from: { ...map.player },
          to: target,
        }),
      );
      return;
    }
    const totalWeight = chain.reduce((s, x) => s + x.weight, 0);
    if (totalWeight > PLAYER_PUSH_FORCE) {
      state.events.push(
        ev({
          kind: 'push-blocked',
          subject: PLAYER_SUBJECT,
          detail: `链条总重 ${totalWeight} > 玩家推力 ${PLAYER_PUSH_FORCE}，整次移动失效`,
          from: { ...map.player },
          to: target,
        }),
      );
      return;
    }
    // 全部检查通过：从末端开始依次移动，保证过程中也不重叠
    const v = { x: Math.sign(target.x - map.player.x), y: Math.sign(target.y - map.player.y) };
    for (let i = chain.length - 1; i >= 0; i--) {
      const blk = chain[i];
      const from = { x: blk.x, y: blk.y };
      blk.x += v.x;
      blk.y += v.y;
      state.events.push(
        ev({
          kind: 'block-push',
          subject: blockSubject(blk.id),
          detail: `被玩家推动（重量 ${blk.weight}，链条总重 ${totalWeight}）`,
          from,
          to: { x: blk.x, y: blk.y },
        }),
      );
    }
  }

  const from = { ...map.player };
  map.player = target;
  state.events.push(
    ev({ kind: 'player-move', subject: PLAYER_SUBJECT, detail: '玩家移动', from, to: { ...target } }),
  );
}

// ---------------------------------------------------------------- 传送阶段

function teleportPass(state: GameState, phase: TickEvent['phase']): void {
  const { map } = state;
  const moved = new Set<string>(); // 本波次已传送的实体，防止链条/自环无限传送

  // 每轮按稳定顺序扫描；移动可能让后续实体满足条件，故循环到无新传送为止
  let progress = true;
  while (progress) {
    progress = false;
    for (const ent of allEntities(map)) {
      if (moved.has(ent.id)) continue;
      const cell = teleAt(map, ent.pos);
      if (!cell || cell.kind !== 'in') continue;
      const out = map.teles.find((t) => t.pairId === cell.pairId && t.kind === 'out');
      if (!out) continue;

      const occupant =
        map.player.x === out.x && map.player.y === out.y
          ? PLAYER_SUBJECT
          : (blockAt(map, out)?.id ?? null);
      if (occupant || wallAt(map, out) || !inBounds(map, out)) {
        state.events.push({
          kind: 'teleport-blocked',
          subject: ent.id,
          phase,
          detail: `传送出口 (${out.x},${out.y}) 被占用/阻塞，实体留在入口`,
          from: { ...ent.pos },
          to: { x: out.x, y: out.y },
        });
        moved.add(ent.id); // 阻塞也结算一次，本波次不再重试
        continue;
      }

      const from = { ...ent.pos };
      if (ent.kind === 'player') {
        map.player = { x: out.x, y: out.y };
      } else if (ent.block) {
        ent.block.x = out.x;
        ent.block.y = out.y;
      }
      moved.add(ent.id);
      progress = true;
      state.events.push({
        kind: 'teleport',
        subject: ent.id,
        phase,
        detail: `经传送对 ${cell.pairId}：(${from.x},${from.y}) -> (${out.x},${out.y})`,
        from,
        to: { x: out.x, y: out.y },
      });
    }
  }
}

// ---------------------------------------------------------------- 输送带阶段

interface BeltIntention {
  subject: string;
  kind: 'block' | 'player';
  from: Pos;
  to: Pos;
  dir: Dir;
  block?: Block;
  canceled: boolean;
  cancelReason?: string;
}

/** 稳定优先级：源格行优先 (y,x) → 方块优先于玩家 → id 字典序 */
function intentionCmp(a: BeltIntention, b: BeltIntention): number {
  return (
    a.from.y - b.from.y ||
    a.from.x - b.from.x ||
    (a.kind === b.kind ? 0 : a.kind === 'block' ? -1 : 1) ||
    a.subject.localeCompare(b.subject)
  );
}

function beltPhase(state: GameState): void {
  const { map } = state;
  const intentions: BeltIntention[] = [];
  const cancel = (i: BeltIntention, reason: string): void => {
    if (i.canceled) return;
    i.canceled = true;
    i.cancelReason = reason;
    state.events.push({
      kind: 'belt-cancel',
      subject: i.subject,
      phase: 'belt',
      detail: reason,
      from: { ...i.from },
      to: { ...i.to },
    });
  };

  // 1) 收集意图（方块按数组稳定顺序，玩家最后）
  for (const blk of map.blocks) {
    const dir = beltAt(map, blk);
    if (!dir) continue;
    const to = addPos(blk, dir);
    const intent: BeltIntention = {
      subject: blockSubject(blk.id),
      kind: 'block',
      from: { x: blk.x, y: blk.y },
      to,
      dir,
      block: blk,
      canceled: false,
    };
    if (blk.weight > BELT_FORCE) {
      cancel(intent, `方块重量 ${blk.weight} > 输送带力 ${BELT_FORCE}，无法带动`);
    } else if (!inBounds(map, to) || wallAt(map, to)) {
      cancel(intent, '输送带方向指向边界/墙，移动取消');
    } else {
      intentions.push(intent);
    }
  }
  const playerBelt = beltAt(map, map.player);
  if (playerBelt) {
    const to = addPos(map.player, playerBelt);
    const intent: BeltIntention = {
      subject: PLAYER_SUBJECT,
      kind: 'player',
      from: { ...map.player },
      to,
      dir: playerBelt,
      canceled: false,
    };
    if (!inBounds(map, to) || wallAt(map, to)) {
      cancel(intent, '输送带方向指向边界/墙，玩家不移动');
    } else {
      intentions.push(intent);
    }
  }

  // 2) 同格竞争：同一目标格只保留稳定优先级最高者，其余立即取消
  const byTarget = new Map<string, BeltIntention[]>();
  for (const i of intentions) {
    const list = byTarget.get(posKey(i.to)) ?? [];
    list.push(i);
    byTarget.set(posKey(i.to), list);
  }
  for (const list of byTarget.values()) {
    if (list.length < 2) continue;
    list.sort(intentionCmp);
    for (let k = 1; k < list.length; k++) {
      cancel(list[k], `同格竞争：与 ${list[0].subject} 争夺 (${list[k].to.x},${list[k].to.y})，稳定优先级落败`);
    }
  }
  const active = intentions.filter((i) => !i.canceled);

  // 3) 图解析。
  //    每个活动意图的目标格按【当前地图】只可能是：空地 / 另一个实体。
  //    若目标是另一个【带活动意图】的实体，则连一条边，得到出度 ≤ 1 的函数图；
  //    否则目标是静止实体（重块、被取消者、未站输送带者）→ 静止阻挡，删点并级联。
  const intentAt = new Map<string, BeltIntention>();
  for (const i of active) intentAt.set(posKey(i.from), i);

  const edgeOf = (i: BeltIntention): BeltIntention | undefined => intentAt.get(posKey(i.to));

  // 3a) 级联移除：目标为静止实体的意图取消；其后随者可能因此也撞上"静止"
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of active) {
      if (i.canceled) continue;
      if (edgeOf(i)) continue; // 指向另一个活动意图，留给环检测
      // 没有活动意图占据目标格 → 目标必为空地或静止实体
      const blk = blockAt(map, i.to);
      const isPlayer = samePos(map.player, i.to);
      if (blk || isPlayer) {
        cancel(i, '目标格被静止实体占据，输送带移动取消');
        intentAt.delete(posKey(i.from));
        changed = true;
      }
    }
  }

  // 3b) 剩余活动意图构成出度 ≤ 1 的函数图：沿边走，终点没有出边意味着通向空地
  //     （合法链条，整体可移动）；走回已访问节点意味着存在环（迎头对撞/循环），
  //     环上及汇入环的对象全部同时取消。
  const cycleMembers = new Set<string>();
  for (const start of active) {
    if (start.canceled || cycleMembers.has(start.subject)) continue;
    const path: BeltIntention[] = [];
    const indexInPath = new Map<string, number>();
    let cur: BeltIntention | undefined = start;
    while (cur && !cur.canceled && !cycleMembers.has(cur.subject) && !indexInPath.has(cur.subject)) {
      indexInPath.set(cur.subject, path.length);
      path.push(cur);
      cur = edgeOf(cur); // undefined = 通向空地
    }
    if (cur && !cur.canceled) {
      // 走到已知环节点，或在本条路径上回到某节点 → 本路径汇入/构成环
      const loopAt = indexInPath.get(cur.subject);
      const from = loopAt ?? path.length; // 汇入已知环时整条路径都在喂环
      for (let k = from; k < path.length; k++) cycleMembers.add(path[k].subject);
    }
  }
  for (const i of active) {
    if (!i.canceled && cycleMembers.has(i.subject)) {
      cancel(i, '对撞/循环：输送带意图形成环，环上及汇入环的对象同时取消');
    }
  }

  // 4) 幸存者同时落位（先基于旧位置算好，再统一写回，杜绝中间态重叠）
  const survivors = intentions.filter((i) => !i.canceled);
  for (const i of survivors) {
    if (i.kind === 'player') {
      map.player = { ...i.to };
    } else if (i.block) {
      i.block.x = i.to.x;
      i.block.y = i.to.y;
    }
    state.events.push({
      kind: 'belt-move',
      subject: i.subject,
      phase: 'belt',
      detail: `输送带向${i.dir}带动一格 (${i.from.x},${i.from.y}) -> (${i.to.x},${i.to.y})`,
      from: { ...i.from },
      to: { ...i.to },
    });
  }
}

// ---------------------------------------------------------------- 主步进

/**
 * 一个拍的完整结算：
 *   玩家移动 → 传送波次 1 → 输送带稳定结算 → 传送波次 2
 * 原地修改 state 并返回它；事件列表每拍重置。
 */
export function step(state: GameState, input: Input): GameState {
  state.events = [];
  state.tick += 1;
  playerPhase(state, input);
  teleportPass(state, 'teleport-1');
  beltPhase(state);
  teleportPass(state, 'teleport-2');
  assertInvariants(state);
  return state;
}

/** 不变量：所有动态实体在界内、不压墙、两两不重叠；方块 id 唯一不丢失 */
export function assertInvariants(state: GameState): void {
  const { map } = state;
  const seen = new Map<string, string>();
  const check = (p: Pos, who: string): void => {
    if (!inBounds(map, p)) throw new Error(`不变量破坏：${who} 越界 (${p.x},${p.y})`);
    if (wallAt(map, p)) throw new Error(`不变量破坏：${who} 压墙 (${p.x},${p.y})`);
    const k = key(p.x, p.y);
    const other = seen.get(k);
    if (other) throw new Error(`不变量破坏：${who} 与 ${other} 重叠于 (${p.x},${p.y})`);
    seen.set(k, who);
  };
  const ids = new Set<string>();
  for (const b of map.blocks) {
    if (ids.has(b.id)) throw new Error(`不变量破坏：方块 id 重复 ${b.id}`);
    ids.add(b.id);
    check(b, `方块 ${b.id}`);
  }
  check(map.player, '玩家');
}
