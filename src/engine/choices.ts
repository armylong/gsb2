import type {
  ChoiceAvailability,
  ChoiceView,
  DialogueChoice,
  DialogueConfig,
  DialogueNode,
  Effect,
  GameState,
  LockReason,
  VariableCatalog,
} from './types';
import { applyEffects, evaluateCondition, normalizeEffect } from './conditions';
import { getFlagLabel, getItemLabel, getStatLabel, nodeById } from './state';

function negativeConsumptions(effects: Effect[]): Effect[] {
  return effects
    .map(normalizeEffect)
    .filter((effect) => effect.kind === 'item' && effect.delta < 0);
}

function describeEffect(effect: Effect, catalog: VariableCatalog): string {
  switch (effect.kind) {
    case 'flag':
      return `${getFlagLabel(catalog, effect.key)} → ${effect.value ? '是' : '否'}`;
    case 'stat':
      return `${getStatLabel(catalog, effect.key)} ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
    case 'item':
      return `${getItemLabel(catalog, effect.key)} ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
    default:
      return '';
  }
}

export function describeEffects(effects: Effect[], catalog: VariableCatalog): string[] {
  return effects.map((effect) => describeEffect(effect, catalog)).filter(Boolean);
}

/**
 * 单条选项的可用性。条件与“正在检查的消耗”都在选择前检查；
 * 物品消耗额外检查一次，保证不会出现库存为负的选项。
 */
export function checkChoice(
  choice: DialogueChoice,
  state: GameState,
  config: DialogueConfig,
): ChoiceAvailability {
  const reasons: LockReason[] = [];
  const catalog = config.variables;

  if (!nodeById(config, choice.target)) {
    reasons.push({
      kind: 'missing-target',
      text: `目标节点「${choice.target}」不存在，无法进入`,
    });
  }

  if (choice.when) {
    const evaluation = evaluateCondition(choice.when, state, catalog);
    if (!evaluation.ok) {
      for (const text of evaluation.reasons) reasons.push({ kind: 'condition', text });
    }
  }

  for (const effect of negativeConsumptions(choice.effects)) {
    if (effect.kind !== 'item') continue;
    const current = state.items[effect.key] ?? 0;
    const cost = Math.abs(effect.delta);
    if (current < cost) {
      reasons.push({
        kind: 'item-cost',
        text: `${getItemLabel(catalog, effect.key)}不足：需要 ${cost}，当前 ${current}`,
      });
    }
  }

  return { available: reasons.length === 0, reasons };
}

export function buildChoiceViews(
  node: DialogueNode,
  state: GameState,
  config: DialogueConfig,
  view: 'player' | 'debug',
): ChoiceView[] {
  return node.choices.map((choice) => {
    const availability = checkChoice(choice, state, config);
    return {
      choice,
      available: availability.available,
      reasons: availability.reasons,
      visible: view === 'debug' || availability.available || choice.lockedDisplay === 'disable',
    };
  });
}

/** 玩家视图与调试视图共用的“能选哪些”结论。 */
export function selectableChoiceIds(
  node: DialogueNode,
  state: GameState,
  config: DialogueConfig,
  view: 'player' | 'debug',
): string[] {
  return buildChoiceViews(node, state, config, view)
    .filter((entry) => entry.visible && entry.available)
    .map((entry) => entry.choice.id);
}

export interface ChoiceApplication {
  ok: true;
  nodeId: string;
  after: GameState;
}

export interface ChoiceRejection {
  ok: false;
  reasons: LockReason[];
}

export type ChoiceOutcome = ChoiceApplication | ChoiceRejection;

/**
 * 唯一的效果执行点。返回应用后的状态，绝不在原对象里就地执行效果，
 * 因此“重复渲染 / 切换视图 / 回看记录”都不会再次发奖励。
 */
export function applyChoice(
  choice: DialogueChoice,
  currentState: GameState,
  config: DialogueConfig,
): ChoiceOutcome {
  const availability = checkChoice(choice, currentState, config);
  if (!availability.available) {
    return { ok: false, reasons: availability.reasons };
  }
  const after = applyEffects(currentState, choice.effects);
  return {
    ok: true,
    nodeId: choice.target,
    after,
  };
}
