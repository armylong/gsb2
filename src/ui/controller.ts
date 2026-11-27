import {
  applyAction,
  cloneState,
  createInitialState,
  getBox,
  getFloor,
  isWon,
  remainingTurns,
  score,
  sideName,
  regionName,
} from '../engine/engine';
import type {
  Action,
  GameState,
  LevelDef,
  RejectReason,
  Side,
  TransferTarget,
} from '../engine/types';

export interface HistoryLine {
  turn: number;
  kind: 'move' | 'wait' | 'transfer' | 'deliver';
  text: string;
}

export interface Preview {
  ok: boolean;
  cost: number;
  projectedTurn: number;
  reason?: RejectReason;
}

export class GameController {
  level: LevelDef;
  state: GameState;
  private past: { state: GameState; line: HistoryLine }[] = [];
  private future: { state: GameState; line: HistoryLine }[] = [];
  selectedBoxId: string | null = null;
  lastReject: RejectReason | null = null;
  // 回看模式：非 null 时展示历史中的某个快照
  replayIndex: number | null = null;

  constructor(level: LevelDef) {
    this.level = level;
    this.state = createInitialState(level);
  }

  loadLevel(level: LevelDef): void {
    this.level = level;
    this.reset();
  }

  reset(): void {
    this.state = createInitialState(this.level);
    this.past = [];
    this.future = [];
    this.selectedBoxId = null;
    this.lastReject = null;
    this.replayIndex = null;
  }

  get history(): HistoryLine[] {
    return this.past.map((h) => h.line);
  }

  get canUndo(): boolean {
    return this.past.length > 0 && this.replayIndex === null;
  }

  get won(): boolean {
    return isWon(this.level, this.state);
  }

  get remaining(): number {
    return remainingTurns(this.level, this.state);
  }

  get scoreValue(): number {
    return score(this.level, this.state);
  }

  /** 回看用的快照列表（含初始状态） */
  get replayStates(): GameState[] {
    return [createInitialState(this.level), ...this.past.map((h) => h.state)];
  }

  get replayLines(): (HistoryLine | null)[] {
    return [null, ...this.past.map((h) => h.line)];
  }

  exitReplay(): void {
    this.replayIndex = null;
  }

  /** 回看模式下当前应渲染的状态 */
  get displayState(): GameState {
    if (this.replayIndex !== null) return this.replayStates[this.replayIndex];
    return this.state;
  }

  undo(): void {
    if (!this.canUndo) return;
    const entry = this.past.pop()!;
    this.future.push(entry);
    this.state = this.past.length === 0
      ? createInitialState(this.level)
      : cloneState(this.past[this.past.length - 1].state);
    this.selectedBoxId = null;
    this.lastReject = null;
  }

  select(boxId: string | null): void {
    this.selectedBoxId = boxId;
    this.lastReject = null;
  }

  /** 不落地，只预估动作结果与花费 */
  preview(action: Action): Preview {
    const r = applyAction(this.level, cloneState(this.state), action);
    return {
      ok: r.ok,
      cost: r.cost,
      projectedTurn: this.state.turn + r.cost,
      reason: r.reason,
    };
  }

  /** 提交动作；被拒时返回原因且状态不变 */
  commit(action: Action): RejectReason | null {
    if (this.replayIndex !== null) return { message: '回看模式中，请先退出回看再操作' };
    const r = applyAction(this.level, this.state, action);
    if (!r.ok || !r.state) {
      this.lastReject = r.reason ?? { message: '动作不合法' };
      return r.reason ?? null;
    }
    const line = this.describe(action, r.state.turn);
    this.past.push({ state: cloneState(r.state), line });
    this.future = [];
    this.state = r.state;
    this.lastReject = null;
    // 入柜后清空选择，避免选到已交付的箱子
    if (action.type === 'transfer' && action.target.region === 'case') {
      this.selectedBoxId = null;
    }
    return null;
  }

  private describe(action: Action, resultingTurn: number): HistoryLine {
    if (action.type === 'move') {
      return {
        turn: resultingTurn,
        kind: 'move',
        text: `轿厢移到 ${action.toFloor} 层`,
      };
    }
    if (action.type === 'wait') {
      return { turn: resultingTurn, kind: 'wait', text: '等待一拍（交替门切换）' };
    }
    const box = getBox(this.level, action.boxId);
    const t = action.target;
    const where =
      t.region === 'car'
        ? '轿厢'
        : `${t.floor} 层${sideName(t.side)}侧${regionName(t.region)}`;
    const delivered =
      t.region === 'case' &&
      this.level.goals.some(
        (g) => g.boxId === action.boxId && g.floor === t.floor && g.side === t.side,
      );
    return {
      turn: resultingTurn,
      kind: delivered ? 'deliver' : 'transfer',
      text: `${box.label} → ${where}${delivered ? '（入柜）' : '（暂存）'}`,
    };
  }

  /** 选中箱子可执行的搬运目标（供面板按钮与画布点击共用） */
  transferTargetsFor(boxId: string): TransferTarget[] {
    const placement = this.state.placements.find((p) => p.boxId === boxId);
    if (!placement) return [];
    const floor = this.state.carFloor;
    const targets: TransferTarget[] = [];
    if (placement.region !== 'car') {
      targets.push({ region: 'car', floor, side: placement.side! });
    }
    const floorSpec = getFloor(this.level, floor);
    for (const side of ['L', 'R'] as Side[]) {
      const pf = floorSpec[side];
      if (pf.stageSlots > 0) targets.push({ region: 'stage', floor, side });
      if (pf.caseSlots > 0) targets.push({ region: 'case', floor, side });
    }
    return targets;
  }
}
