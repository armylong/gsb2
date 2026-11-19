import { BTNode } from './BTNode';
import type { NodeResult } from './types';
import type { Engine } from './engine';

/**
 * 优先选择(反应式选择): 每 tick 从最高优先子节点开始重检。
 * 若已有分支在运行, 先重评排在它前面的高优先分支:
 * 一旦高优先分支条件成立, 抢占并只中断一次旧分支(旧分支内的持续动作随之 abort,
 * 由动作自身清空移动目标, 不会留下旧目标继续控制 NPC)。
 */
export class ReactiveSelector extends BTNode {
  private children: BTNode[];
  private activeChild: BTNode | null = null;

  constructor(id: number, name: string, children: BTNode[]) {
    super(id, name, 'selector');
    this.children = children;
  }

  setChildren(children: BTNode[]): void {
    // 调整分支优先级时调用: 节点实例与内部进度保留, 仅改变评估顺序
    this.children = children;
  }

  getChildren(): BTNode[] {
    return this.children;
  }

  tick(ctx: Engine): NodeResult {
    for (const child of this.children) {
      const wasRunning = child.active;
      const result = child.tick(ctx);

      if (result === 'running') {
        if (this.activeChild && this.activeChild !== child) {
          const old = this.activeChild;
          // 旧分支本轮已 tick 过且仍 active, 说明被更高优先分支抢占
          if (old.active) {
            old.abort(ctx, `更高优先分支[${child.name}]抢占`);
          }
          ctx.pushLog({
            nodeId: this.id,
            nodeName: this.name,
            kind: 'info',
            detail: `分支切换: ${old.name} → ${child.name}(优先级更高且条件成立)`,
          });
        }
        this.activeChild = child;
        if (!this.active) {
          this.active = true;
          this.log(ctx, 'enter', '优先选择开始调度');
        }
        this.status = 'running';
        this.reason = `选中分支: ${child.name}`;
        return 'running';
      }

      // 分支本轮返回 success(典型: 巡逻顺序完成一轮): 粘性保持, 下轮继续从该分支重检,
      // 不掉到 idle 造成"待命→被抢回"的抖动
      if (result === 'success' && this.activeChild === child) {
        this.status = 'running';
        this.reason = `分支[${child.name}]完成一轮, 保持选中`;
        return 'running';
      }

      if (wasRunning) {
        // 运行中的分支本轮主动退出(条件失效), 不是抢占, 继续向下评估
        if (this.activeChild === child) this.activeChild = null;
        ctx.pushLog({
          nodeId: this.id,
          nodeName: this.name,
          kind: 'info',
          detail: `分支[${child.name}]主动退出, 继续评估后续分支`,
        });
      }
    }
    if (this.active) {
      this.active = false;
      this.log(ctx, 'exit', '所有分支均不可用');
    }
    this.activeChild = null;
    this.status = 'failure';
    this.reason = '无分支可运行';
    return 'failure';
  }

  abort(ctx: Engine, reason: string): void {
    if (!this.active) return;
    if (this.activeChild?.active) this.activeChild.abort(ctx, reason);
    this.activeChild = null;
    super.abort(ctx, reason);
  }}
