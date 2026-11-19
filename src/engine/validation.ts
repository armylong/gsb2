import type {
  DialogueConfig,
  DialogueNode,
  Effect,
  ValidationIssue,
  ValidationReport,
} from './types';
import { normalizeEffect } from './conditions';

function keyExists(config: DialogueConfig, kind: Effect['kind'], key: string): boolean {
  if (kind === 'flag') return config.variables.flags.some((entry) => entry.key === key);
  if (kind === 'stat') return config.variables.stats.some((entry) => entry.key === key);
  return config.variables.items.some((entry) => entry.key === key);
}

function isUnconditionalExit(choice: {
  when?: unknown;
  effects: Effect[];
  target: string;
}): boolean {
  if (choice.when) return false;
  return !choice.effects.some((raw) => {
    const effect = normalizeEffect(raw);
    return effect.kind === 'item' && effect.delta < 0;
  });
}

/** Tarjan 强连通分量，用来找“有意设计的循环”，不将其视为错误。 */
function findLoopNodeIds(config: DialogueConfig): string[] {
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const loopNodes = new Set<string>();
  let counter = 0;

  const edges = (node: DialogueNode): string[] =>
    node.choices.map((choice) => choice.target).filter((target) => config.nodes.some((n) => n.id === target));

  const strongConnect = (nodeId: string) => {
    indexById.set(nodeId, counter);
    lowById.set(nodeId, counter);
    counter += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    const node = config.nodes.find((entry) => entry.id === nodeId);
    for (const target of node ? edges(node) : []) {
      if (!indexById.has(target)) {
        strongConnect(target);
        lowById.set(nodeId, Math.min(lowById.get(nodeId)!, lowById.get(target)!));
      } else if (onStack.has(target)) {
        lowById.set(nodeId, Math.min(lowById.get(nodeId)!, indexById.get(target)!));
      }
    }

    if (lowById.get(nodeId) === indexById.get(nodeId)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member && member !== nodeId);

      const selfLoop =
        component.length === 1 &&
        (config.nodes.find((entry) => entry.id === nodeId)?.choices ?? []).some(
          (choice) => choice.target === nodeId,
        );
      if (component.length > 1 || selfLoop) {
        for (const id of component) loopNodes.add(id);
      }
    }
  };

  for (const node of config.nodes) {
    if (!indexById.has(node.id)) strongConnect(node.id);
  }
  return [...loopNodes];
}

export function validateConfig(config: DialogueConfig): ValidationReport {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const missingTargets: ValidationReport['missingTargets'] = [];

  for (const node of config.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        kind: 'duplicate-node',
        severity: 'error',
        message: `节点 ID「${node.id}」重复`,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
  }

  if (!nodeIds.has(config.entryNodeId)) {
    issues.push({
      kind: 'missing-entry',
      severity: 'error',
      message: `入口节点「${config.entryNodeId}」不存在`,
    });
  }

  const declared = {
    flags: new Set(config.variables.flags.map((entry) => entry.key)),
    stats: new Set(config.variables.stats.map((entry) => entry.key)),
    items: new Set(config.variables.items.map((entry) => entry.key)),
  };

  const walkEffects = (effects: Effect[], node: DialogueNode, choiceId: string | undefined) => {
    for (const effect of effects) {
      if (!keyExists(config, effect.kind, effect.key)) {
        issues.push({
          kind: 'unknown-variable',
          severity: 'warning',
          message: `节点「${node.title}」的效果引用了未声明的${effect.kind === 'flag' ? '标记' : effect.kind === 'stat' ? '数值' : '物品'}「${effect.key}」`,
          nodeId: node.id,
          choiceId,
        });
      }
      if (effect.kind !== 'flag' && !Number.isFinite(effect.delta)) {
        issues.push({
          kind: 'invalid-effect',
          severity: 'error',
          message: `节点「${node.title}」的效果增量不是有限数字`,
          nodeId: node.id,
          choiceId,
        });
      }
    }
  };

  for (const node of config.nodes) {
    const choiceIds = new Set<string>();
    if (node.terminal && node.choices.length > 0) {
      issues.push({
        kind: 'terminal-with-choices',
        severity: 'warning',
        message: `结局节点「${node.title}」仍带有 ${node.choices.length} 个选项，这些选项不会在玩家视图中展示`,
        nodeId: node.id,
      });
    }
    if (!node.terminal && node.choices.length === 0) {
      issues.push({
        kind: 'dead-end',
        severity: 'error',
        message: `节点「${node.title}」没有选项，也不是结局，流程会卡死`,
        nodeId: node.id,
      });
    }

    for (const choice of node.choices) {
      if (choiceIds.has(choice.id)) {
        issues.push({
          kind: 'duplicate-choice',
          severity: 'error',
          message: `节点「${node.title}」内选项 ID「${choice.id}」重复`,
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
      choiceIds.add(choice.id);
      if (!choice.label.trim()) {
        issues.push({
          kind: 'empty-label',
          severity: 'warning',
          message: `节点「${node.title}」的选项「${choice.id}」没有可见文字`,
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
      if (!nodeIds.has(choice.target)) {
        missingTargets.push({ nodeId: node.id, choiceId: choice.id, target: choice.target });
        issues.push({
          kind: 'missing-target',
          severity: 'error',
          message: `节点「${node.title}」的选项「${choice.label}」指向不存在的目标「${choice.target}」`,
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
      walkEffects(choice.effects, node, choice.id);
      if (choice.when) walkCondition(choice.when, node, choice.id);

      if (choice.lockedDisplay !== 'disable' && choice.lockedDisplay !== 'hide') {
        issues.push({
          kind: 'invalid-effect',
          severity: 'warning',
          message: `选项「${choice.label}」的不可用展示方式无效，已按“禁用”处理`,
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
    }

    if (!node.terminal && node.choices.length > 0) {
      const hasUnconditional = node.choices.some(
        (choice) => nodeIds.has(choice.target) && isUnconditionalExit(choice),
      );
      if (!hasUnconditional) {
        issues.push({
          kind: 'no-unconditional-exit',
          severity: 'warning',
          message: `节点「${node.title}」的所有出口都带条件或物品消耗；一旦均不满足，玩家会滞留在该节点`,
          nodeId: node.id,
        });
      }
    }
  }

  function walkCondition(condition: NonNullable<DialogueNode['choices'][number]['when']>, node: DialogueNode, choiceId: string) {
    if (condition.kind === 'group') {
      for (const child of condition.conditions) walkCondition(child, node, choiceId);
      return;
    }
    const set =
      condition.kind === 'flag'
        ? declared.flags
        : condition.kind === 'stat'
          ? declared.stats
          : declared.items;
    if (!set.has(condition.key)) {
      issues.push({
        kind: 'unknown-variable',
        severity: 'warning',
        message: `节点「${node.title}」的条件引用了未声明的变量「${condition.key}」`,
        nodeId: node.id,
        choiceId,
      });
    }
  }

  // 可达性：从入口出发沿所有选项走。
  const reachable = new Set<string>();
  const queue = nodeIds.has(config.entryNodeId) ? [config.entryNodeId] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = config.nodes.find((entry) => entry.id === id);
    for (const choice of node?.choices ?? []) {
      if (nodeIds.has(choice.target) && !reachable.has(choice.target)) queue.push(choice.target);
    }
  }

  const unreachableNodeIds = config.nodes
    .map((node) => node.id)
    .filter((id) => !reachable.has(id));
  for (const id of unreachableNodeIds) {
    const node = config.nodes.find((entry) => entry.id === id);
    if (!node) continue;
    // 不可达的结局节点通常是编辑器里正在补的草稿，记为警告。
    issues.push({
      kind: 'unreachable',
      severity: node.terminal ? 'warning' : 'error',
      message: `节点「${node.title}」无法从入口到达`,
      nodeId: id,
    });
  }

  // 反向可达：能到达任一结局的节点集合。
  const terminalIds = new Set(config.nodes.filter((node) => node.terminal).map((node) => node.id));
  const reverse = new Map<string, string[]>();
  for (const node of config.nodes) {
    for (const choice of node.choices) {
      if (!nodeIds.has(choice.target)) continue;
      const list = reverse.get(choice.target) ?? [];
      list.push(node.id);
      reverse.set(choice.target, list);
    }
  }
  const canEnd = new Set<string>(terminalIds);
  const endQueue = [...terminalIds];
  while (endQueue.length > 0) {
    const id = endQueue.shift()!;
    for (const parent of reverse.get(id) ?? []) {
      if (!canEnd.has(parent)) {
        canEnd.add(parent);
        endQueue.push(parent);
      }
    }
  }
  const noPathToEndingNodeIds = config.nodes
    .map((node) => node.id)
    .filter((id) => !canEnd.has(id));
  for (const id of noPathToEndingNodeIds) {
    const node = config.nodes.find((entry) => entry.id === id);
    if (!node) continue;
    issues.push({
      kind: 'no-path-to-ending',
      severity: 'warning',
      message: `节点「${node.title}」沿任何路径都无法抵达结局`,
      nodeId: id,
    });
  }

  if (config.nodes.length > 0 && terminalIds.size === 0) {
    issues.push({
      kind: 'no-reachable-ending',
      severity: 'error',
      message: '配置中没有任何结局节点，任何路径都无法结束',
    });
  }

  // 循环节点只作为提示信息，不计入问题列表，避免把有意设计的回路判成坏图。
  const loopNodeIds = findLoopNodeIds(config);

  const deadEnds = config.nodes
    .filter((node) => !node.terminal && node.choices.length === 0)
    .map((node) => node.id);
  const noUnconditionalExitNodeIds = config.nodes
    .filter(
      (node) =>
        !node.terminal && node.choices.length > 0 && !node.choices.some((choice) => isUnconditionalExit(choice)),
    )
    .map((node) => node.id);

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return {
    issues,
    errors,
    warnings,
    missingTargets,
    deadEnds,
    unreachableNodeIds,
    noUnconditionalExitNodeIds,
    noPathToEndingNodeIds,
    loopNodeIds,
    reachableEndingIds: [...terminalIds].filter((id) => reachable.has(id)),
  };
}
