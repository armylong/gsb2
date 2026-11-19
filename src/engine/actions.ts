import { BTNode } from './BTNode';
import type { MoveRef, NodeResult } from './types';
import type { Engine } from './engine';
import { distance, resolveMoveRef, setMoveTarget, clearMoveTarget } from './world';
import { TICK_SECONDS } from './types';

const ARRIVE_EPSILON = 1.5;

/**
 * 持续移动动作: enter 只发生一次, 领取 owner token 并写入移动目标;
 * 之后每个 tick 复用同一动作实例, 不重新 enter。
 * abort 时凭 token 清掉自己的移动目标 —— 若移动目标已被新动作接管则不动它,
 * 保证旧动作不会留下 / 覆盖新的移动目标。
 */
export class MoveToAction extends BTNode {
  private readonly refProvider: (ctx: Engine) => MoveRef;
  private readonly describe: (ctx: Engine) => string;
  /** succeed: 到达即成功(用于顺序); hold: 到达后保持运行不退出(用于追逐, 避免每 tick 重复 enter) */
  private readonly arriveBehavior: 'succeed' | 'hold';
  private ownerId = -1;

  constructor(
    id: number,
    name: string,
    refProvider: (ctx: Engine) => MoveRef,
    describe: (ctx: Engine) => string,
    arriveBehavior: 'succeed' | 'hold' = 'succeed',
  ) {
    super(id, name, 'action');
    this.refProvider = refProvider;
    this.describe = describe;
    this.arriveBehavior = arriveBehavior;
  }

  tick(ctx: Engine): NodeResult {
    const world = ctx.world;
    if (!this.active) {
      this.ownerId = world.npc.nextActionId++;
      const ref = this.refProvider(ctx);
      setMoveTarget(world, this.ownerId, ref);
      this.enter(ctx, `移动目标=${this.describe(ctx)}, owner=#${this.ownerId}`);
    }
    const ref = this.refProvider(ctx);
    const dest = resolveMoveRef(world, ref);
    const d = distance(world.npc.pos, dest);
    if (d <= ARRIVE_EPSILON) {
      if (this.arriveBehavior === 'hold') {
        // 追逐: 贴着目标保持, 动作不退出、不重复 enter, 目标移动时继续跟随
        this.status = 'running';
        this.reason = `已到达${this.describe(ctx)}, 保持跟随`;
        return 'running';
      }
      clearMoveTarget(world, this.ownerId);
      this.exit(ctx, 'success', `到达${this.describe(ctx)} (距离 ${d.toFixed(1)})`);
      return 'success';
    }
    this.status = 'running';
    this.reason = `前往${this.describe(ctx)}, 剩余 ${d.toFixed(1)}`;
    return 'running';
  }

  abort(ctx: Engine, reason: string): void {
    if (!this.active) return;
    clearMoveTarget(ctx.world, this.ownerId);
    this.ownerId = -1;
    super.abort(ctx, reason);
  }
}

/**
 * 持续等待动作: 进度 waitRemaining 保存在动作实例上, 运行期间逐 tick 扣减,
 * 不会每次检查从头计时。被中断后再次 enter 时按"重新开始"规则从满时长计时。
 */
export class WaitAction extends BTNode {
  private readonly durationProvider: (ctx: Engine) => number;
  private readonly waitKind: 'patrol' | 'rest';
  private remaining = 0;
  private ownerId = -1;

  constructor(
    id: number,
    name: string,
    waitKind: 'patrol' | 'rest',
    durationProvider: (ctx: Engine) => number,
  ) {
    super(id, name, 'action');
    this.waitKind = waitKind;
    this.durationProvider = durationProvider;
  }

  tick(ctx: Engine): NodeResult {
    if (!this.active) {
      // 重新进入规则: 中断后重新 enter 一律重新计时
      this.remaining = this.durationProvider(ctx);
      this.ownerId = ctx.world.npc.nextActionId++;
      this.enter(
        ctx,
        `等待 ${this.remaining.toFixed(1)}s${this.waitKind === 'patrol' ? '(巡逻点)' : '(休息点)'}, owner=#${this.ownerId}`,
      );
    }
    this.remaining -= TICK_SECONDS; // 只有 tick 被调用时才扣减, 暂停不增加计时
    if (this.remaining <= 0) {
      if (this.waitKind === 'patrol') {
        // 巡逻点编号的唯一写入点: 等待正常完成才推进, 中断不推进, 杜绝两个旧动作同时更新
        const prev = ctx.world.npc.patrolIndex;
        ctx.world.npc.patrolIndex =
          (prev + 1) % ctx.world.patrolPoints.length;
        this.exit(
          ctx,
          'success',
          `等待结束, 巡逻点编号 ${prev} → ${ctx.world.npc.patrolIndex}`,
        );
      } else {
        this.exit(ctx, 'success', '休息等待结束');
      }
      return 'success';
    }
    this.status = 'running';
    this.reason = `等待中, 剩余 ${this.remaining.toFixed(1)}s`;
    return 'running';
  }

  abort(ctx: Engine, reason: string): void {
    if (!this.active) return;
    this.remaining = 0;
    this.ownerId = -1;
    super.abort(ctx, reason);
  }
}

/** 兜底空闲动作: 无分支可用时持续运行, 使根选择节点始终有 running 分支 */export class IdleAction extends BTNode {
  constructor(id: number) {
    super(id, '原地待命', 'action');
  }

  tick(ctx: Engine): NodeResult {
    if (!this.active) {
      this.enter(ctx, '无更高优先分支, 原地待命');
    }
    this.status = 'running';
    this.reason = '待命中';
    return 'running';
  }
}
