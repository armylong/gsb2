import { BTNode } from './BTNode';
import type { LogEntry, NodeStatus, SimConfig } from './types';
import { TICK_SECONDS } from './types';
import { createWorld, resetWorld, stepMovement, type World } from './world';
import { buildTree, type BuiltTree } from './tree';

const MAX_LOGS = 200;

export class Engine {
  world: World;
  tree: BuiltTree;
  logs: LogEntry[] = [];
  private logId = 0;

  constructor() {
    this.world = createWorld();
    this.tree = buildTree();
  }

  /** 推进一个决策周期: 提交暂存配置 → 树判断 → 移动结算 */
  tick(): void {
    // 1) 下一周期生效: tick 边界提交 UI 上修改的阈值 / 等待时长 / 优先级
    this.commitStagedConfig();

    // 2) 节点状态复位(interrupted 保留一帧用于渲染)
    this.forEachNode((n) => n.resetForTick());

    this.world.tick += 1;
    this.world.simTime += TICK_SECONDS;

    // 3) 行为树决策(动作的 enter / 复用 / abort 都在这里发生)
    this.tree.root.tick(this);

    // 4) 移动结算: 只按当前(可能刚被新动作接管的)移动目标走一步
    stepMovement(this.world);
  }

  reset(): void {
    resetWorld(this.world);
    this.logs = [];
    this.logId = 0;
    this.tree = buildTree(); // 重建树: 清掉游标、等待进度、interrupted 等全部运行期状态
    this.pushLog({
      nodeId: this.tree.root.id,
      nodeName: this.tree.root.name,
      kind: 'info',
      detail: '重置: 上次运行的节点状态 / 游标 / 等待进度已清空(配置保留)',
    });
  }

  get nodes(): BTNode[] {
    const out: BTNode[] = [];
    const walk = (n: BTNode): void => {
      out.push(n);
      const wc = n as unknown as { getChildren?: () => BTNode[] };
      for (const c of wc.getChildren?.() ?? []) walk(c);
    };
    walk(this.tree.root);
    return out;
  }

  getNode(id: number): BTNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  statusOf(id: number): NodeStatus {
    return this.getNode(id)?.status ?? 'idle';
  }

  /** 当前实际在运行的最底层动作名, 供场景 HUD 显示"当前行为" */
  activeActionName(): string {
    const action = this.nodes.find((n) => n.kind === 'action' && n.active);
    return action?.name ?? '无';
  }

  pushLog(entry: Omit<LogEntry, 'id' | 'tick' | 'simTime'>): void {
    this.logs.push({
      ...entry,
      id: ++this.logId,
      tick: this.world.tick,
      simTime: this.world.simTime,
    });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  clearLogs(): void {
    this.logs = [];
  }

  private forEachNode(fn: (n: BTNode) => void): void {
    this.nodes.forEach(fn);
  }

  private commitStagedConfig(): void {
    const staged = this.world.stagedConfig;
    const current = this.world.config;
    const orderChanged =
      staged.branchOrder.length !== current.branchOrder.length ||
      staged.branchOrder.some((b, i) => b !== current.branchOrder[i]);

    this.world.config = structuredClone(staged);

    if (orderChanged) {
      // 优先级调整: 节点实例(含内部进度)保留, 仅按新顺序重排根选择节点的子节点;
      // 若旧的运行分支在新顺序里被更高分支抢占, 本 tick 的正常重检流程会完成中断
      const reordered = staged.branchOrder
        .map((branchId) => this.branchNode(branchId))
        .filter((n): n is BTNode => n !== undefined);
      this.tree.root.setChildren(reordered);
      this.pushLog({
        nodeId: this.tree.root.id,
        nodeName: this.tree.root.name,
        kind: 'info',
        detail: `分支优先级已调整, 新评估顺序: ${staged.branchOrder.join(' > ')}`,
      });
    }
  }

  private branchNode(branchId: SimConfig['branchOrder'][number]): BTNode | undefined {
    if (branchId === 'idle') return this.tree.idle;
    return this.tree.branches[branchId];
  }
}
