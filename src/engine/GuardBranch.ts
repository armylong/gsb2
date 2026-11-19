import { BTNode } from './BTNode';
import type { NodeResult } from './types';
import type { Engine } from './engine';

/**
 * 守卫分支: [条件...] + 一个持续子节点。
 * 关键语义: 行动期间条件每个 tick 仍然重新检查 —— 条件由真变假时,
 * 主动 abort 正在运行的子节点并返回 failure, 让上层优先选择重新分配分支。
 */
export class GuardBranch extends BTNode {
  private readonly conditions: BTNode[];
  private readonly child: BTNode;

  constructor(id: number, name: string, conditions: BTNode[], child: BTNode) {
    super(id, name, 'guard');
    this.conditions = conditions;
    this.child = child;
  }

  getChildren(): BTNode[] {
    return [...this.conditions, this.child];
  }

  private conditionsHold(ctx: Engine): { ok: boolean; reason: string } {
    for (const cond of this.conditions) {
      const result = cond.tick(ctx);
      if (result !== 'success') {
        return { ok: false, reason: `条件[${cond.name}]不成立 (${cond.reason})` };
      }
    }
    return { ok: true, reason: this.conditions.map((c) => c.reason).join(' 且 ') };
  }

  tick(ctx: Engine): NodeResult {
    const guard = this.conditionsHold(ctx);

    if (this.child.active) {
      if (!guard.ok) {
        // 行动中条件失效: 中断当前持续动作(只退出一次), 本分支交还控制权
        this.child.abort(ctx, `守卫条件失效: ${guard.reason}`);
        this.active = false;
        this.status = 'failure';
        this.reason = `条件持续重检失败: ${guard.reason}`;
        this.log(ctx, 'exit', `分支退出 · ${guard.reason}`);
        return 'failure';
      }
      const result = this.child.tick(ctx);
      this.status = result === 'running' ? 'running' : result;
      this.reason = `条件持续成立(${guard.reason}), 运行: ${this.child.name}`;
      return result;
    }

    if (!guard.ok) {
      this.status = 'failure';
      this.reason = guard.reason;
      return 'failure';
    }

    const result = this.child.tick(ctx);
    if (result !== 'running') {
      // 子顺序成功完成 / 失败: 本轮守卫生命周期结束, 清除 active,
      // 否则下次抢占时 abort 会被 !active 短路
      this.active = false;
    } else {
      this.active = true; // 子节点已 enter, 守卫同步进入 active, 使抢占链可以向下传递
    }
    this.status = result === 'running' ? 'running' : result;
    this.reason = `条件成立(${guard.reason}), 进入: ${this.child.name}`;
    return result;
  }

  abort(ctx: Engine, reason: string): void {
    if (!this.active) return;
    if (this.child.active) this.child.abort(ctx, `守卫[${this.name}]被抢占: ${reason}`);
    // 不在此处手动置 active=false: 交给 super.abort 统一处理, 否则会短路中断日志
    super.abort(ctx, reason);
  }
}
