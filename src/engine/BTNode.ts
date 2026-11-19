import type { LogKind, NodeKind, NodeResult, NodeStatus } from './types';
import type { Engine } from './engine';

export abstract class BTNode {
  readonly id: number;
  readonly name: string;
  readonly kind: NodeKind;
  status: NodeStatus = 'idle';
  /** 本次判断依据的一句话说明, 渲染到树面板右侧 */
  reason = '';
  active = false; // 是否处于 enter 之后、exit/abort 之前

  protected constructor(id: number, name: string, kind: NodeKind) {
    this.id = id;
    this.name = name;
    this.kind = kind;
  }

  /** tick 开始时统一复位; 被中断的节点要保留 interrupted 状态一帧, 由 abort 自己设置 */
  resetForTick(): void {
    if (this.status !== 'interrupted') {
      this.status = 'idle';
      this.reason = ''; // 清掉上一 tick 的旧判定文案, 避免"未执行"却显示运行期 reason
    }
  }

  abstract tick(ctx: Engine): NodeResult;

  /** 抢占时调用: 正在运行才中断, 保证一次运行只 exit/abort 一次 */
  abort(ctx: Engine, reason: string): void {
    if (!this.active) return;
    this.active = false;
    this.status = 'interrupted';
    this.reason = `被中断: ${reason}`;
    this.log(ctx, 'interrupt', reason);
  }

  protected enter(ctx: Engine, detail: string): void {
    this.active = true;
    this.log(ctx, 'enter', detail);
  }

  protected exit(ctx: Engine, result: NodeResult, detail: string): void {
    this.active = false;
    this.status = result;
    this.log(ctx, 'exit', `${result === 'success' ? '成功' : '失败'} · ${detail}`);
  }

  log(ctx: Engine, kind: LogKind, detail: string): void {
    ctx.pushLog({ nodeId: this.id, nodeName: this.name, kind, detail });
  }
}
