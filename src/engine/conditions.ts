import { BTNode } from './BTNode';
import type { NodeResult } from './types';
import type { Engine } from './engine';
import { distance } from './world';

/** 条件节点不写进入/退出日志(每 tick 都评估, 会刷屏), 只保留状态与判定依据 */
abstract class Condition extends BTNode {
  protected constructor(id: number, name: string) {
    super(id, name, 'condition');
  }
  abstract evaluate(ctx: Engine): { result: NodeResult; reason: string };

  tick(ctx: Engine): NodeResult {
    const { result, reason } = this.evaluate(ctx);
    this.status = result;
    this.reason = reason;
    return result;
  }
}

export class LowHpCondition extends Condition {
  constructor(id: number) {
    super(id, '生命 < 撤退阈值?');
  }
  evaluate(ctx: Engine): { result: NodeResult; reason: string } {
    const { npc, config } = ctx.world;
    const ok = npc.hp < config.lowHpThreshold;
    return {
      result: ok ? 'success' : 'failure',
      reason: `HP=${npc.hp.toFixed(0)} ${ok ? '<' : '≥'} 阈值${config.lowHpThreshold}`,
    };
  }
}

export class TargetInAlertCondition extends Condition {
  constructor(id: number) {
    super(id, '目标在警戒范围内?');
  }
  evaluate(ctx: Engine): { result: NodeResult; reason: string } {
    const { npc, target, config } = ctx.world;
    if (!target.exists) {
      return { result: 'failure', reason: '目标不存在' };
    }
    const d = distance(npc.pos, target.pos);
    const ok = d <= config.alertRange;
    return {
      result: ok ? 'success' : 'failure',
      reason: `距离=${d.toFixed(1)} ${ok ? '≤' : '>'} 警戒${config.alertRange}`,
    };
  }
}

export class PatrolEnabledCondition extends Condition {
  constructor(id: number) {
    super(id, '巡逻启用?');
  }
  evaluate(ctx: Engine): { result: NodeResult; reason: string } {
    const ok = ctx.world.config.patrolEnabled;
    return {
      result: ok ? 'success' : 'failure',
      reason: `巡逻开关=${ok ? '开' : '关'}`,
    };
  }
}
