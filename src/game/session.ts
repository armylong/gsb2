import type { Action, GameState, Gear, LevelSpec, SimulationResult } from './types';
import { cloneState, initState, setGear, simulateTurn } from './engine';

// 每提交一拍先存「整回合开始」快照（熟度、炉位、剩余时间、日志全在内）。
// 撤销 = 弹快照，连档位调整一起回退；模拟结果只缓存、不落状态。
export class Session {
  level: LevelSpec;
  state: GameState;
  private undoStack: GameState[] = [];
  pendingAction: Action = { type: 'pass' };
  selectedDoughId: string | null = null;
  simulation: SimulationResult | null = null;

  constructor(level: LevelSpec) {
    this.level = level;
    this.state = initState(level);
  }

  load(level: LevelSpec): void {
    this.level = level;
    this.state = initState(level);
    this.undoStack = [];
    this.pendingAction = { type: 'pass' };
    this.selectedDoughId = null;
    this.simulation = null;
  }

  reset(): void {
    this.load(this.level);
  }

  changeGear(gear: Gear): void {
    this.state = setGear(this.state, gear);
    this.simulation = null;
  }

  selectDough(id: string | null): void {
    this.selectedDoughId = id;
    if (id) this.pendingAction = { type: 'pass' };
    this.simulation = null;
  }

  planMove(doughId: string, target: 'proof' | 'rack' | 'oven'): void {
    this.pendingAction = { type: 'move', doughId, target };
    this.selectedDoughId = doughId;
    this.simulation = null;
  }

  planPass(): void {
    this.pendingAction = { type: 'pass' };
    this.selectedDoughId = null;
    this.simulation = null;
  }

  /** 模拟这一拍：返回事件流与可能的拒绝原因，不修改真实状态 */
  preview(): SimulationResult {
    this.simulation = simulateTurn(this.state, this.level, this.pendingAction);
    return this.simulation;
  }

  /** 提交：先拍快照再结算；被拒的操作不会产生任何状态变化 */
  commit(): SimulationResult {
    const result = simulateTurn(this.state, this.level, this.pendingAction);
    if (result.rejected) return result;
    this.undoStack.push(cloneState(this.state));
    this.state = result.state;
    this.pendingAction = { type: 'pass' };
    this.selectedDoughId = null;
    this.simulation = null;
    return result;
  }

  /** 撤销到整回合开始时的熟度、炉位和剩余时间 */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.state = prev;
    this.pendingAction = { type: 'pass' };
    this.selectedDoughId = null;
    this.simulation = null;
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
}
