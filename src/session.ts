import { EXAMPLES, editOrders, exampleById, type ExampleDef } from './examples.ts';
import { buildLayout, type Edit, type Layout } from './layout.ts';
import {
  cloneState,
  runSignature,
  simulateRound,
  verifySequence,
  type AmountTable,
  type RoundRecord,
} from './sim.ts';

export const MAX_ROUNDS = 80;

export interface Branch {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /** 从父分支的哪一轮分出；根分支为 0。 */
  readonly forkRound: number;
  layout: Layout;
  readonly baseState: AmountTable;
  readonly baseRound: number;
  /** 分叉时从父分支继承的只读历史（第 1..baseRound 轮）。 */
  readonly inherited: readonly RoundRecord[];
  /** 分叉之后本分支新算出的轮次（第 baseRound+1 轮起）。 */
  records: RoundRecord[];
}

export interface OrderCheck {
  name: string;
  hash: string;
  signature: string;
  rounds: number;
}

export interface SelfCheckResult {
  layoutHash: string;
  orders: OrderCheck[];
  identical: boolean;
  ledgerErrors: string[];
}

export interface ForkInfo {
  branchId: string;
  fromBranch: string;
  round: number;
}

interface BranchInit {
  name: string;
  parentId: string | null;
  forkRound: number;
  layout: Layout;
  baseState: AmountTable;
  baseRound: number;
  inherited: readonly RoundRecord[];
}

/**
 * 会话层：当前分支 + 视图轮次 + 从历史分叉。
 *
 * 不变量：任何分支的 records 永远等于 baseState 在 layout 上从 baseRound 继续演算的结果。
 * 布局变化 → 从 baseState 整体重演；于是“同一布局必然同一结果”是结构性保证，
 * 不依赖增量状态是否恰好一致。
 */
export class SimulationSession {
  branches: Branch[] = [];
  activeId = '';
  viewRound = 0;
  private counter = 0;

  constructor(example: ExampleDef = EXAMPLES[0]!) {
    this.loadExample(example);
  }

  static fromExampleId(id: string): SimulationSession {
    return new SimulationSession(exampleById(id));
  }

  active(): Branch {
    const branch = this.branches.find((item) => item.id === this.activeId);
    if (!branch) throw new Error('没有活动分支');
    return branch;
  }

  tipRound(): number {
    const branch = this.active();
    return branch.baseRound + branch.records.length;
  }

  isAtTip(): boolean {
    return this.viewRound >= this.tipRound();
  }

  /**
   * 是否需要先分叉才能安全编辑：查看的是“中间某一轮”时才需要，
   * 因为这轮之后已有的记录会被新布局覆盖。最新一轮与分支起点都不需要分叉。
   */
  editNeedsFork(): boolean {
    const branch = this.active();
    return this.viewRound > branch.baseRound && this.viewRound < this.tipRound();
  }

  loadExample(example: ExampleDef): void {
    this.counter = 0;
    const branch = this.makeBranch({
      name: example.name,
      parentId: null,
      forkRound: 0,
      layout: buildLayout(example.edits),
      baseState: new Map(),
      baseRound: 0,
      inherited: [],
    });
    this.branches = [branch];
    this.activeId = branch.id;
    this.viewRound = 0;
  }

  setActive(branchId: string): void {
    const branch = this.branches.find((item) => item.id === branchId);
    if (!branch) return;
    this.activeId = branchId;
    this.viewRound = branch.baseRound + branch.records.length;
  }

  setViewRound(round: number): void {
    const branch = this.active();
    this.viewRound = Math.max(branch.baseRound, Math.min(round, this.tipRound()));
  }

  stateAt(round: number): AmountTable {
    const record = this.recordAt(round);
    if (record) return cloneState(record.state);
    return cloneState(this.active().baseState);
  }

  /**
   * 任意轮次的记录：分叉继承的轮次返回父分支快照（历史不可改写），
   * 分叉之后的轮次返回本分支自己的记录。
   */
  recordAt(round: number): RoundRecord | null {
    const branch = this.active();
    if (round <= 0 || round > this.tipRound()) return null;
    if (round <= branch.baseRound) return branch.inherited[round - 1] ?? null;
    return branch.records[round - branch.baseRound - 1] ?? null;
  }

  /** 本轮起点（分叉轮）之前是否有可显示的历史。 */
  hasInheritedHistory(): boolean {
    const branch = this.active();
    return branch.baseRound > 0 && branch.inherited.length === branch.baseRound;
  }

  previousRecord(): RoundRecord | null {
    return this.recordAt(this.viewRound - 1);
  }

  /** 追加演算；不改变已有轮次。 */
  advance(rounds = 1): number {
    const branch = this.active();
    const count = Math.max(0, Math.min(rounds, MAX_ROUNDS - branch.records.length));
    if (count === 0) return 0;
    let state = branch.records.length
      ? branch.records[branch.records.length - 1]!.state
      : branch.baseState;
    for (let i = 0; i < count; i += 1) {
      const round = branch.baseRound + branch.records.length + 1;
      const record = simulateRound(branch.layout, state, round);
      branch.records.push(record);
      state = record.state;
    }
    this.viewRound = this.tipRound();
    return count;
  }

  /** 用当前布局把已有轮次整体重演。 */
  replay(): void {
    const branch = this.active();
    const rounds = branch.records.length;
    branch.records = [];
    this.viewRound = branch.baseRound;
    if (rounds > 0) this.advance(rounds);
  }

  /**
   * 修改当前分支布局并重演。想“保留原历史、另做试验”请先 fork()。
   */
  updateLayout(mutator: (layout: Layout) => void): void {
    const branch = this.active();
    const draft = branch.layout.clone();
    mutator(draft);
    branch.layout = draft;
    this.replay();
    this.viewRound = this.tipRound();
  }

  /** 从当前查看的轮次分叉：复制该轮末状态与布局，父分支不受影响。 */
  fork(label?: string): ForkInfo {
    const parent = this.active();
    const round = this.viewRound;
    const child = this.makeBranch({
      name: label ?? `${parent.name} · 第 ${round} 轮试验`,
      parentId: parent.id,
      forkRound: round,
      layout: parent.layout.clone(),
      baseState: this.stateAt(round),
      baseRound: round,
      inherited: this.recordsUpTo(round),
    });
    this.branches.push(child);
    this.activeId = child.id;
    this.viewRound = round;
    return { branchId: child.id, fromBranch: parent.id, round };
  }

  /** 合并继承历史与自有记录，截取到指定轮次（只读用途）。 */
  private recordsUpTo(round: number): RoundRecord[] {
    const branch = this.active();
    const out: RoundRecord[] = [];
    for (let r = 1; r <= round; r += 1) {
      const record =
        r <= branch.baseRound
          ? branch.inherited[r - 1]
          : branch.records[r - branch.baseRound - 1];
      if (record) out.push(record);
    }
    return out;
  }

  resetBranch(): void {
    const branch = this.active();
    branch.records = [];
    this.viewRound = branch.baseRound;
  }

  /**
   * 把当前布局拆成编辑集，按多种顺序重建并各自演算，比较布局哈希与逐轮签名。
   * 运行时的“编辑顺序无关”自检。
   */
  selfCheck(rounds = 8): SelfCheckResult {
    const branch = this.active();
    const edits = layoutToEdits(branch.layout);
    const results: OrderCheck[] = editOrders(edits).map((order) => {
      const layout = buildLayout(order.edits, branch.layout.width, branch.layout.height);
      let state = cloneState(branch.baseState);
      const records: RoundRecord[] = [];
      for (let i = 0; i < rounds; i += 1) {
        const record = simulateRound(layout, state, branch.baseRound + i + 1);
        records.push(record);
        state = record.state;
      }
      return {
        name: order.name,
        hash: layout.hash(),
        signature: runSignature(records),
        rounds,
      };
    });
    const first = results[0];
    const identical = results.every(
      (item) => item.hash === first?.hash && item.signature === first?.signature,
    );
    return {
      layoutHash: branch.layout.hash(),
      orders: results,
      identical,
      ledgerErrors: this.ledgerErrors(),
    };
  }

  ledgerErrors(): string[] {
    const branch = this.active();
    // 继承轮次与本次试验分开检查：分叉后改建会让两者的布局哈希不同，
    // 但仍应各自跨轮连续、账目闭合。
    const errors: string[] = [];
    for (const error of verifySequence(branch.inherited)) errors.push(`继承: ${error}`);
    if (branch.records.length > 0) {
      const chain = [branch.inherited[branch.inherited.length - 1], ...branch.records].filter(
        (record): record is RoundRecord => record !== undefined,
      );
      for (const error of verifySequence(chain)) errors.push(`试验: ${error}`);
    }
    return errors;
  }

  /** 当前分支可展示的全部轮次（继承历史 + 自有记录）。 */
  allRecords(): RoundRecord[] {
    const branch = this.active();
    return [...branch.inherited, ...branch.records];
  }

  activePath(): Branch[] {
    const path: Branch[] = [];
    let current: Branch | undefined = this.active();
    let guard = 0;
    while (current && guard < 64) {
      path.unshift(current);
      current = current.parentId
        ? this.branches.find((item) => item.id === current?.parentId)
        : undefined;
      guard += 1;
    }
    return path;
  }

  private makeBranch(init: BranchInit): Branch {
    this.counter += 1;
    return {
      id: `b${this.counter}`,
      name: init.name,
      parentId: init.parentId,
      forkRound: init.forkRound,
      layout: init.layout,
      baseState: cloneState(init.baseState),
      baseRound: init.baseRound,
      inherited: init.inherited,
      records: [],
    };
  }
}

/** 从布局提取编辑集（固定顺序：格子 row-major，然后阀门）。 */
export function layoutToEdits(layout: Layout): Edit[] {
  const edits: Edit[] = [];
  for (const { x, y, content } of layout.sortedCells()) {
    edits.push({ kind: 'cell', x, y, content: { ...content } });
  }
  for (const valve of layout.getValves()) {
    edits.push({ kind: 'valve', a: valve.a, b: valve.b, allowAtoB: valve.allowAtoB });
  }
  return edits;
}
