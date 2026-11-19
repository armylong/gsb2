import type { MoveRef, MoveTarget, SimConfig, Vec } from './types';
import { TICK_SECONDS } from './types';

export const FIELD = { width: 480, height: 360 };
export const NPC_SPEED = 55; // 世界单位 / 秒

export interface PatrolPoint extends Vec {
  index: number;
}

export interface World {
  npc: {
    pos: Vec;
    hp: number; // 0..100
    moveTarget: MoveTarget | null;
    /** 每个动作实例在 enter 时领取的自增 id, 用作移动目标的 owner token */
    nextActionId: number;
    /** 顺序节点之间共享的巡逻进度, 只有等待动作成功完成时才 +1(单一写入者) */
    patrolIndex: number;
  };
  target: {
    pos: Vec;
    exists: boolean;
  };
  restPoint: Vec;
  patrolPoints: PatrolPoint[];
  simTime: number;
  tick: number;
  config: SimConfig;
  /** UI 调整后先写到这里, 下一个 tick 开始时提交, 保证"下一周期生效" */
  stagedConfig: SimConfig;
}

export function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function defaultConfig(): SimConfig {
  return {
    lowHpThreshold: 30,
    alertRange: 130,
    patrolEnabled: true,
    patrolWait: 2,
    restWait: 3,
    branchOrder: ['retreat', 'chase', 'patrol', 'idle'],
  };
}

export function createWorld(): World {
  const restPoint: Vec = { x: 60, y: 300 };
  const patrolPoints: PatrolPoint[] = [
    { index: 0, x: 120, y: 90 },
    { index: 1, x: 380, y: 80 },
    { index: 2, x: 420, y: 260 },
    { index: 3, x: 200, y: 300 },
  ];
  const config = defaultConfig();
  return {
    npc: {
      pos: { ...restPoint },
      hp: 100,
      moveTarget: null,
      nextActionId: 1,
      patrolIndex: 0,
    },
    target: { pos: { x: 360, y: 180 }, exists: true },
    restPoint,
    patrolPoints,
    simTime: 0,
    tick: 0,
    config,
    stagedConfig: structuredClone(config),
  };
}

/** 重置只清运行期状态; 阈值 / 优先级等配置视为用户设定, 保留 */
export function resetWorld(world: World): void {
  world.npc.pos = { ...world.restPoint };
  world.npc.hp = 100;
  world.npc.moveTarget = null;
  world.npc.nextActionId = 1;
  world.npc.patrolIndex = 0;
  world.target.pos = { x: 360, y: 180 };
  world.target.exists = true;
  world.simTime = 0;
  world.tick = 0;
}

export function resolveMoveRef(world: World, ref: MoveRef): Vec {
  if (ref.kind === 'target') return world.target.pos;
  if (ref.index === -1) return world.restPoint;
  return world.patrolPoints[ref.index];
}

/** 只有持有 owner token 的动作能更新 / 清空移动目标 */
export function setMoveTarget(world: World, ownerActionId: number, ref: MoveRef): void {
  world.npc.moveTarget = {
    pos: resolveMoveRef(world, ref),
    ref,
    ownerActionId,
  };
}

export function clearMoveTarget(world: World, ownerActionId: number): void {
  const mt = world.npc.moveTarget;
  if (mt && mt.ownerActionId === ownerActionId) {
    world.npc.moveTarget = null;
  }
}

/** 每个 tick 调用一次: 暂停 / 单步之外不调用, 因此暂停时 NPC 不动、等待计时也不增加 */
export function stepMovement(world: World): void {
  const mt = world.npc.moveTarget;
  if (!mt) return;
  // 动态目标: 每 tick 重新取坐标, 拖动目标时移动方向实时跟随
  mt.pos = resolveMoveRef(world, mt.ref);
  const npc = world.npc;
  const step = NPC_SPEED * TICK_SECONDS;
  const d = distance(npc.pos, mt.pos);
  if (d <= step) {
    npc.pos = { ...mt.pos };
  } else {
    npc.pos = {
      x: npc.pos.x + ((mt.pos.x - npc.pos.x) / d) * step,
      y: npc.pos.y + ((mt.pos.y - npc.pos.y) / d) * step,
    };
  }
}
