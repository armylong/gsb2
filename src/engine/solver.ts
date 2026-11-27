import type { Action, BoxPlacement, GameState, LevelDef, Region, Side, TransferTarget } from './types';
import { applyAction, cloneState, createInitialState, isWon } from './engine';

export interface SolvedStep {
  action: Action;
  cost: number;
  turn: number;
  usedStage: boolean;
  usedWait: boolean;
}

export interface SolveResult {
  found: boolean;
  steps: SolvedStep[];
  totalTurns: number;
  /** 最短解里是否包含"放进暂存位"的动作 */
  shortestUsesStage: boolean;
  shortestUsesWait: boolean;
  explored: number;
}

/**
 * 状态键保留完整回合数：虽然交替门只取决于奇偶，但"等待 1 回合"与
 * "移动 1 层"产生的同奇偶状态在后续代价上不同，若只用奇偶去重会错误地
 * 把等待方案剪掉，使"禁用等待"的对照实验失真。预算上界保证状态空间有限。
 */
function stateKey(s: GameState): string {
  const p = s.placements
    .map((x) => `${x.boxId}@${x.region}:${x.floor ?? '_'}:${x.side ?? '_'}:${x.index}`)
    .sort()
    .join('|');
  return `${s.turn}#${s.carFloor}#${p}`;
}

interface Node {
  state: GameState;
  parent: Node | null;
  action: Action | null;
  cost: number;
  usedStage: boolean;
  usedWait: boolean;
}

/** 枚举当前状态下某个画箱所有"有意义"的搬运目标 */
function transferTargets(
  level: LevelDef,
  state: GameState,
  placement: BoxPlacement,
): TransferTarget[] {
  const targets: TransferTarget[] = [];
  const floor = state.carFloor;

  // 进入轿厢：站台箱子只能从自己所在侧的门上车
  if (placement.region !== 'car' && placement.floor === floor) {
    targets.push({ region: 'car', floor, side: placement.side! });
  }

  for (const side of ['L', 'R'] as Side[]) {
    for (const region of ['stage', 'case'] as Region[]) {
      const pf = level.floors.find((f) => f.id === floor)![side];
      const cap = region === 'stage' ? pf.stageSlots : pf.caseSlots;
      if (cap <= 0) continue;
      targets.push({ region, floor, side });
    }
  }
  return targets;
}

function expand(level: LevelDef, state: GameState): { action: Action; state: GameState; cost: number }[] {
  const out: { action: Action; state: GameState; cost: number }[] = [];

  for (const f of level.floors) {
    if (f.id === state.carFloor) continue;
    const action: Action = { type: 'move', toFloor: f.id };
    const r = applyAction(level, state, action);
    if (r.ok && r.state) out.push({ action, state: r.state, cost: r.cost });
  }

  const wait: Action = { type: 'wait' };
  const wr = applyAction(level, state, wait);
  if (wr.ok && wr.state) out.push({ action: wait, state: wr.state, cost: 1 });

  for (const p of state.placements) {
    for (const target of transferTargets(level, state, p)) {
      // 跳过同区域重新落位（引擎也会拒绝，这里提前剪枝）
      if (p.region === target.region) continue;
      const action: Action = { type: 'transfer', boxId: p.boxId, target };
      const r = applyAction(level, state, action);
      if (r.ok && r.state) out.push({ action, state: r.state, cost: r.cost });
    }
  }
  return out;
}

/** BFS：按"动作数"找最短通关序列（边权含移动层数，因此同时记录累计回合） */
export function solve(
  level: LevelDef,
  maxNodes = 300000,
  opts: { forbidStage?: boolean; forbidWait?: boolean; requireStage?: boolean } = {},
): SolveResult {
  const start = createInitialState(level);
  const turnLimit = level.budget + 12;
  const queue: Node[] = [
    { state: start, parent: null, action: null, cost: 0, usedStage: false, usedWait: false },
  ];
  const seen = new Set<string>([stateKey(start)]);
  let explored = 0;
  let goal: Node | null = null;

  while (queue.length > 0 && explored < maxNodes) {
    const node = queue.shift()!;
    explored++;
    if (isWon(level, node.state)) {
      if (opts.requireStage && !node.usedStage) {
        // 要求必须暂存：这个终点没用过暂存位，继续找
      } else {
        goal = node;
        break;
      }
    }
    for (const edge of expand(level, node.state)) {
      if (opts.forbidStage && edge.action.type === 'transfer' && edge.action.target.region === 'stage') {
        continue;
      }
      if (opts.forbidWait && edge.action.type === 'wait') continue;
      if (edge.state.turn > turnLimit) continue;
      const key = stateKey(edge.state);
      if (seen.has(key)) continue;
      seen.add(key);
      const usedStage =
        node.usedStage ||
        (edge.action.type === 'transfer' && edge.action.target.region === 'stage');
      const usedWait = node.usedWait || edge.action.type === 'wait';
      queue.push({
        state: edge.state,
        parent: node,
        action: edge.action,
        cost: node.cost + edge.cost,
        usedStage,
        usedWait,
      });
    }
  }

  if (!goal) {
    return {
      found: false,
      steps: [],
      totalTurns: 0,
      shortestUsesStage: false,
      shortestUsesWait: false,
      explored,
    };
  }

  const steps: SolvedStep[] = [];
  let cur: Node | null = goal;
  while (cur && cur.action) {
    const prev: Node = cur.parent!;
    steps.unshift({
      action: cur.action,
      cost: cur.cost - prev.cost,
      turn: cur.state.turn,
      usedStage: cur.usedStage,
      usedWait: cur.usedWait,
    });
    cur = cur.parent;
  }

  return {
    found: true,
    steps,
    totalTurns: goal.state.turn,
    shortestUsesStage: goal.usedStage,
    shortestUsesWait: goal.usedWait,
    explored,
  };
}

/** 重放一条解，返回每一步之后的状态（供验证脚本做不变量检查） */
export function replay(level: LevelDef, steps: SolvedStep[]): GameState[] {
  let state = createInitialState(level);
  const trace: GameState[] = [cloneState(state)];
  for (const s of steps) {
    const r = applyAction(level, state, s.action);
    if (!r.ok || !r.state) throw new Error('重放失败：解法中出现非法动作');
    state = r.state;
    trace.push(cloneState(state));
  }
  return trace;
}
