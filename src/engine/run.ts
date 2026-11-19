import type {
  AbandonedBranch,
  DialogueConfig,
  HistoryEntry,
  RunState,
} from './types';
import { applyChoice, checkChoice } from './choices';
import { cloneState, createInitialState, deepClone, nodeById } from './state';

export function createRun(config: DialogueConfig): RunState {
  return {
    nodeId: config.entryNodeId,
    state: createInitialState(config.variables),
    history: [],
    abandonedBranches: [],
    nextSeq: 1,
  };
}

export interface SelectResult {
  ok: boolean;
  run: RunState;
  error?: string;
}

/**
 * 选择并推进。所有状态都是新对象：效果的唯一执行点在这里，
 * 历史里的 before/after 是快照，不会被后续操作改写。
 */
export function selectChoice(
  run: RunState,
  choiceId: string,
  config: DialogueConfig,
): SelectResult {
  const node = nodeById(config, run.nodeId);
  if (!node) {
    return { ok: false, run, error: `当前节点「${run.nodeId}」在配置中不存在` };
  }
  const choice = node.choices.find((entry) => entry.id === choiceId);
  if (!choice) {
    return { ok: false, run, error: `节点「${node.title}」中没有选项「${choiceId}」` };
  }

  const availability = checkChoice(choice, run.state, config);
  if (!availability.available) {
    return {
      ok: false,
      run,
      error: availability.reasons.map((reason) => reason.text).join('；'),
    };
  }

  const outcome = applyChoice(choice, run.state, config);
  if (!outcome.ok) {
    return {
      ok: false,
      run,
      error: outcome.reasons.map((reason) => reason.text).join('；'),
    };
  }

  const target = nodeById(config, choice.target);
  const before = cloneState(run.state);
  const after = cloneState(outcome.after);
  const entry: HistoryEntry = {
    seq: run.nextSeq,
    nodeId: node.id,
    nodeTitle: node.title,
    choiceId: choice.id,
    choiceLabel: choice.label,
    targetNodeId: choice.target,
    targetNodeTitle: target?.title ?? choice.target,
    before,
    after,
  };

  return {
    ok: true,
    run: {
      nodeId: outcome.nodeId,
      state: after,
      history: [...run.history, entry],
      abandonedBranches: run.abandonedBranches,
      nextSeq: run.nextSeq + 1,
    },
  };
}

/**
 * 回到历史中第 index 条（0 基）选择之前。
 * 当前路径中该选择及其之后的部分变为“已封存分支”，只读留存；
 * 新的选择会追加到恢复后的 history，不会混入旧分支状态。
 */
export function rewindToBefore(
  run: RunState,
  index: number,
  config: DialogueConfig,
): { ok: boolean; run: RunState; error?: string } {
  if (!Number.isInteger(index) || index < 0 || index >= run.history.length) {
    return { ok: false, run, error: '回溯位置不在历史记录范围内' };
  }
  const entry = run.history[index];
  const kept = run.history.slice(0, index);
  const dropped = run.history.slice(index);
  // nextSeq 单调递增, 因此即便反复回溯同一步, 分支 ID 也不会撞车。
  const branchId = `branch-${run.nextSeq}`;
  const branch: AbandonedBranch = {
    id: branchId,
    label: `${entry.nodeTitle} · ${entry.choiceLabel}`,
    entries: dropped.map((item) => deepClone(item)),
    finalNodeId: run.nodeId,
    finalNodeTitle: nodeById(config, run.nodeId)?.title ?? run.nodeId,
    finalState: cloneState(run.state),
  };

  return {
    ok: true,
    run: {
      nodeId: entry.nodeId,
      state: cloneState(entry.before),
      history: kept,
      abandonedBranches: [...run.abandonedBranches, branch],
      nextSeq: run.nextSeq + 1,
    },
  };
}

/** 从存档快照恢复；快照已通过兼容性检查与深拷贝。 */
export function hydrateRun(snapshot: {
  nodeId: string;
  state: RunState['state'];
  history: RunState['history'];
  abandonedBranches: RunState['abandonedBranches'];
  nextSeq: number;
}): RunState {
  return {
    nodeId: snapshot.nodeId,
    state: cloneState(snapshot.state),
    history: deepClone(snapshot.history),
    abandonedBranches: deepClone(snapshot.abandonedBranches ?? []),
    nextSeq: Math.max(1, snapshot.nextSeq),
  };
}

/** 从入口重开：变量回到初始值，历史与旧分支全部清空。 */
export function restartRun(config: DialogueConfig): RunState {
  return createRun(config);
}

export function isTerminal(run: RunState, config: DialogueConfig): boolean {
  const node = nodeById(config, run.nodeId);
  return Boolean(node?.terminal);
}
