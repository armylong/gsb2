// 录像带: 按步记录输入, 每步留存状态与指纹, 支持回跳与从历史位置开分支。

import { initialState, step, hashState, type Input, type SimState } from "./sim.ts";

export interface Branch {
  id: string;
  name: string;
  parentId: string | null; // 从哪个分支分叉而来
  forkStep: number; // 在父分支的第几步分叉
  inputs: Input[]; // 从初始状态起的完整输入序列
  hashes: string[]; // hashes[i] = 执行 i 步后的状态指纹, 长度 = inputs.length + 1
  states: SimState[]; // 运行时缓存, 与 hashes 同步, 不导出
  cursor: number; // 当前查看位置 (0..inputs.length)
}

export class Recorder {
  branches = new Map<string, Branch>();
  currentId: string;
  private idSeq = 1;

  constructor() {
    const s0 = initialState();
    const main: Branch = {
      id: this.genId(),
      name: "main",
      parentId: null,
      forkStep: 0,
      inputs: [],
      hashes: [hashState(s0)],
      states: [s0],
      cursor: 0,
    };
    this.branches.set(main.id, main);
    this.currentId = main.id;
  }

  private genId(): string {
    let id: string;
    do {
      id = `b${this.idSeq++}`;
    } while (this.branches.has(id));
    return id;
  }

  get current(): Branch {
    return this.branches.get(this.currentId)!;
  }

  get head(): number {
    return this.current.inputs.length;
  }

  stateAt(stepIndex: number, branch: Branch = this.current): SimState {
    const i = Math.max(0, Math.min(stepIndex, branch.inputs.length));
    return branch.states[i];
  }

  /** 快进/回跳: 纯移动游标, 不改数据 */
  seek(stepIndex: number): SimState {
    const b = this.current;
    b.cursor = Math.max(0, Math.min(stepIndex, b.inputs.length));
    return b.states[b.cursor];
  }

  /**
   * 录入一步输入。
   * 若游标在历史中间, 先截断当前分支的未来再追加 (想保留未来请先 fork)。
   */
  append(input: Input): SimState {
    const b = this.current;
    if (b.cursor < b.inputs.length) {
      b.inputs.length = b.cursor;
      b.hashes.length = b.cursor + 1;
      b.states.length = b.cursor + 1;
    }
    const s = step(b.states[b.states.length - 1], input);
    b.inputs.push(input);
    b.states.push(s);
    b.hashes.push(hashState(s));
    b.cursor = b.inputs.length;
    return s;
  }

  /** 在当前游标位置开新分支, 原分支数据原样保留 */
  fork(name: string): Branch {
    const p = this.current;
    const nb: Branch = {
      id: this.genId(),
      name,
      parentId: p.id,
      forkStep: p.cursor,
      inputs: p.inputs.slice(0, p.cursor),
      hashes: p.hashes.slice(0, p.cursor + 1),
      states: p.states.slice(0, p.cursor + 1),
      cursor: p.cursor,
    };
    this.branches.set(nb.id, nb);
    this.currentId = nb.id;
    return nb;
  }

  /** 切回任意分支, 各分支的游标与数据互不影响 */
  switchTo(id: string): void {
    if (!this.branches.has(id)) throw new Error(`未知分支: ${id}`);
    this.currentId = id;
  }
}
