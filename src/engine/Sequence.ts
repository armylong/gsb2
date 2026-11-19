import { BTNode } from './BTNode';
import type { NodeResult } from './types';
import type { Engine } from './engine';

/**
 * 顺序节点: 持续动作运行期间保留游标, 后续 tick 直接 tick 同一个子节点, 不从头进入。
 * 中断(abort)时游标归零 —— 重新进入规则: 顺序整体重新开始, 等待计时清零;
 * 但世界级巡逻点编号 patrolIndex 不在此处重置, 它只由等待动作成功完成时推进。
 */
export class Sequence extends BTNode {
  private cursor = 0;
  private readonly children: BTNode[];

  constructor(id: number, name: string, children: BTNode[]) {
    super(id, name, 'sequence');
    this.children = children;
  }

  getChildren(): BTNode[] {
    return this.children;
  }

  tick(ctx: Engine): NodeResult {
    while (this.cursor < this.children.length) {
      const child = this.children[this.cursor];
      const result = child.tick(ctx);
      if (result === 'running') {
        this.active = true;
        this.status = 'running';
        this.reason = `执行第 ${this.cursor + 1}/${this.children.length} 步: ${child.name}`;
        return 'running';
      }
      if (result === 'failure') {
        this.cursor = 0; // 下次进入从头开始
        this.active = false;
        this.status = 'failure';
        this.reason = `${child.name} 失败, 顺序终止`;
        return 'failure';
      }
      this.cursor += 1; // success -> 下一步(下一 tick 才执行, 一个 tick 内不连跑)
    }
    this.cursor = 0; // 整条顺序完成, 下轮自然从头进入(界面会标注这是正常轮转, 不是中断)
    this.active = false;
    this.status = 'success';
    this.reason = '顺序全部完成';
    return 'success';
  }

  abort(ctx: Engine, reason: string): void {
    if (!this.active) return;
    // 只中断当前正在跑的子节点; 已完成的子节点早已 exit, 不会重复退出
    const child = this.children[this.cursor];
    if (child?.active) child.abort(ctx, `父顺序[${this.name}]被中断: ${reason}`);
    this.cursor = 0;
    super.abort(ctx, reason); // 基类统一置 active=false 并记录中断日志
  }
}
