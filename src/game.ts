/**
 * game.ts — 游戏状态与操作（不依赖 DOM）
 * main.ts 负责渲染；scripts/verify.ts 也可直接驱动这里验证重开还原等性质。
 */
import {
  evaluatePartition,
  outcomeOf,
  survivingAssignments,
  possibilitiesByPackage,
  type PackagePossibility,
  type PartitionVerdict,
  type Weighing,
} from './engine';
import { LEVELS, type LevelScript } from './levels';

export type TraySlot = 'left' | 'right' | null;
export type ShelfSlot = 'A' | 'B' | null;

export interface GameState {
  levelIndex: number;
  records: Weighing[];
  /** 当前未确认摆法：每个包裹在天平上的位置 */
  tray: TraySlot[];
  /** 提交分组：每个包裹分配到的货架 */
  shelf: ShelfSlot[];
  /** 正在 Canvas 上翻查的记录下标；'draft' 表示当前摆法 */
  viewing: number | 'draft';
  /** 最近一次提交的判定 */
  verdict: PartitionVerdict | null;
  /** 提交时的分组签名，用于判断之后是否又改动过分组 */
  verdictSignature: string | null;
  won: boolean;
  /** 每次重开自增，便于 UI 做重置动画/测试观察 */
  resetCount: number;
}

type Listener = (s: GameState) => void;

export function createInitialState(levelIndex: number, resetCount = 0): GameState {
  const level = LEVELS[levelIndex] ?? LEVELS[0];
  return {
    levelIndex: LEVELS[levelIndex] ? levelIndex : 0,
    records: [],
    tray: new Array(level.packageCount).fill(null),
    shelf: new Array(level.packageCount).fill(null),
    viewing: 'draft',
    verdict: null,
    verdictSignature: null,
    won: false,
    resetCount,
  };
}

export class GameStore {
  state: GameState;
  private listeners = new Set<Listener>();

  constructor(levelIndex = 0) {
    this.state = createInitialState(levelIndex);
  }

  get level(): LevelScript {
    return LEVELS[this.state.levelIndex];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /* ---------------- 关卡 / 重开 ---------------- */

  selectLevel(index: number): void {
    if (index < 0 || index >= LEVELS.length || index === this.state.levelIndex) {
      // 重复点击当前标签不做任何事，避免误清空；重开请用显式按钮
      return;
    }
    this.state = createInitialState(index);
    this.emit();
  }

  /** 重新开始：尝试次数（由 records 推导）与全部记录、摆法、分组、判定都还原。 */
  restart(): void {
    this.state = createInitialState(this.state.levelIndex, this.state.resetCount + 1);
    this.emit();
  }

  /* ---------------- 天平摆法（不消耗次数） ---------------- */

  /** 循环：未上秤 → 左盘 → 右盘 → 未上秤 */
  cycleTray(pkg: number): void {
    if (this.state.won) return;
    const cur = this.state.tray[pkg];
    this.state.tray[pkg] = cur === null ? 'left' : cur === 'left' ? 'right' : null;
    this.state.viewing = 'draft';
    this.emit();
  }

  setTray(pkg: number, slot: TraySlot): void {
    if (this.state.won) return;
    this.state.tray[pkg] = slot;
    this.state.viewing = 'draft';
    this.emit();
  }

  clearTray(): void {
    if (this.state.won) return;
    this.state.tray.fill(null);
    this.state.viewing = 'draft';
    this.emit();
  }

  draftSides(): { left: number[]; right: number[] } {
    const left: number[] = [];
    const right: number[] = [];
    this.state.tray.forEach((slot, i) => {
      if (slot === 'left') left.push(i);
      else if (slot === 'right') right.push(i);
    });
    return { left, right };
  }

  attemptsLeft(): number {
    return this.level.maxWeighings - this.state.records.length;
  }

  canConfirm(): { ok: boolean; reason?: string } {
    if (this.state.won) return { ok: false, reason: '本局已通关，可重开或进入下一关' };
    if (this.attemptsLeft() <= 0) return { ok: false, reason: '称量次数已用完，请提交分组或重新开始' };
    const { left, right } = this.draftSides();
    if (left.length === 0 || right.length === 0) {
      return { ok: false, reason: '天平两盘都至少要放一个包裹' };
    }
    return { ok: true };
  }

  /** 确认称量：只有这里新增记录并消耗一次机会。结果由真实重量公正计算。 */
  confirmWeighing(): Weighing | null {
    const check = this.canConfirm();
    if (!check.ok) return null;
    const { left, right } = this.draftSides();
    const record: Weighing = {
      left: [...left].sort((a, b) => a - b),
      right: [...right].sort((a, b) => a - b),
      outcome: outcomeOf(this.level.trueWeights, { left, right }),
    };
    this.state.records = [...this.state.records, record];
    // 确认后保留摆法并翻查这条新记录（摆法本身也仍在 draft/tray 中，不清空玩家思路）
    this.state.viewing = this.state.records.length - 1;
    this.state.verdict = null;
    this.state.verdictSignature = null;
    this.emit();
    return record;
  }

  viewRecord(index: number | 'draft'): void {
    this.state.viewing = index;
    this.emit();
  }

  /* ---------------- 可能性推导 ---------------- */

  survivors() {
    return survivingAssignments(
      this.level.packageCount,
      this.level.candidates,
      this.state.records,
    );
  }

  possibilities(): PackagePossibility[] {
    return possibilitiesByPackage(
      this.level.packageCount,
      this.level.candidates,
      this.survivors(),
    );
  }

  /* ---------------- 货架分组与提交 ---------------- */

  cycleShelf(pkg: number): void {
    if (this.state.won) return;
    const cur = this.state.shelf[pkg];
    this.state.shelf[pkg] = cur === null ? 'A' : cur === 'A' ? 'B' : null;
    this.state.verdict = null;
    this.state.verdictSignature = null;
    this.emit();
  }

  setShelf(pkg: number, slot: ShelfSlot): void {
    if (this.state.won) return;
    this.state.shelf[pkg] = slot;
    this.state.verdict = null;
    this.state.verdictSignature = null;
    this.emit();
  }

  shelfSides(): { A: number[]; B: number[] } {
    const A: number[] = [];
    const B: number[] = [];
    this.state.shelf.forEach((slot, i) => {
      if (slot === 'A') A.push(i);
      else if (slot === 'B') B.push(i);
    });
    return { A, B };
  }

  shelfComplete(): boolean {
    return this.state.shelf.every((s) => s !== null);
  }

  shelfSignature(): string {
    return this.state.shelf.map((s) => (s === 'A' ? 'L' : s === 'B' ? 'R' : '?')).join('');
  }

  /** 提交分组：按全部剩余可能检验必然性。 */
  submitPartition(): PartitionVerdict | null {
    if (!this.shelfComplete()) return null;
    const { A, B } = this.shelfSides();
    const verdict = evaluatePartition(this.survivors(), A, B);
    this.state.verdict = verdict;
    this.state.verdictSignature = this.shelfSignature();
    if (verdict.kind === 'necessary-equal') this.state.won = true;
    this.emit();
    return verdict;
  }
}
