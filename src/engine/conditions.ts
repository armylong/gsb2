import type {
  CompareOp,
  Condition,
  Effect,
  GameState,
  VariableCatalog,
} from './types';
import { getFlagLabel, getItemLabel, getStatLabel } from './state';

export const COMPARE_LABELS: Record<CompareOp, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '至少',
  lt: '小于',
  lte: '至多',
};

export const COMPARE_SYMBOLS: Record<CompareOp, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

function compare(current: number, op: CompareOp, expected: number): boolean {
  switch (op) {
    case 'eq':
      return current === expected;
    case 'ne':
      return current !== expected;
    case 'gt':
      return current > expected;
    case 'gte':
      return current >= expected;
    case 'lt':
      return current < expected;
    case 'lte':
      return current <= expected;
    default:
      return false;
  }
}

function currentNumber(state: GameState, kind: 'stat' | 'item', key: string): number {
  const bucket = kind === 'stat' ? state.stats : state.items;
  const value = bucket[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 不依赖当前状态，仅描述条件本身；用于编辑器与图例。 */
export function describeCondition(condition: Condition, catalog: VariableCatalog): string {
  switch (condition.kind) {
    case 'flag': {
      const suffix = catalog.flags.some((entry) => entry.key === condition.key) ? '' : '（未声明）';
      return `标记「${getFlagLabel(catalog, condition.key)}」为${condition.value ? '是' : '否'}${suffix}`;
    }
    case 'stat': {
      const suffix = catalog.stats.some((entry) => entry.key === condition.key) ? '' : '（未声明）';
      return `${getStatLabel(catalog, condition.key)} ${COMPARE_SYMBOLS[condition.op]} ${condition.value}${suffix}`;
    }
    case 'item': {
      const suffix = catalog.items.some((entry) => entry.key === condition.key) ? '' : '（未声明）';
      return `${getItemLabel(catalog, condition.key)} ${COMPARE_SYMBOLS[condition.op]} ${condition.value}${suffix}`;
    }
    case 'group': {
      const joiner = condition.mode === 'all' ? ' 且 ' : ' 或 ';
      const inner = condition.conditions.map((child) => describeCondition(child, catalog));
      if (inner.length === 0) return condition.mode === 'all' ? '（空的全满足组）' : '（空的任一满足组）';
      return inner
        .map((text, index) => (index === 0 ? text : `${joiner}${text}`))
        .join('');
    }
    default:
      return '未知条件';
  }
}

export interface ConditionEvaluation {
  ok: boolean;
  reasons: string[];
}

/** 带当前值的条件求值；失败时 reasons 直接可读。 */
export function evaluateCondition(
  condition: Condition,
  state: GameState,
  catalog: VariableCatalog,
): ConditionEvaluation {
  switch (condition.kind) {
    case 'flag': {
      const current = Boolean(state.flags[condition.key]);
      if (current === condition.value) return { ok: true, reasons: [] };
      const suffix = catalog.flags.some((entry) => entry.key === condition.key) ? '' : '（未声明）';
      return {
        ok: false,
        reasons: [
          `标记「${getFlagLabel(catalog, condition.key)}」${suffix}需要为${condition.value ? '是' : '否'}，当前为${current ? '是' : '否'}`,
        ],
      };
    }
    case 'stat':
    case 'item': {
      const current = currentNumber(state, condition.kind, condition.key);
      if (compare(current, condition.op, condition.value)) return { ok: true, reasons: [] };
      const label =
        condition.kind === 'stat'
          ? getStatLabel(catalog, condition.key)
          : getItemLabel(catalog, condition.key);
      const declared =
        condition.kind === 'stat'
          ? catalog.stats.some((entry) => entry.key === condition.key)
          : catalog.items.some((entry) => entry.key === condition.key);
      return {
        ok: false,
        reasons: [
          `${label}${declared ? '' : '（未声明）'}需要 ${COMPARE_SYMBOLS[condition.op]} ${condition.value}，当前为 ${current}`,
        ],
      };
    }
    case 'group': {
      if (condition.conditions.length === 0) {
        // 空组按布尔恒等式处理：全满足为真，任一满足为假。
        return condition.mode === 'all'
          ? { ok: true, reasons: [] }
          : { ok: false, reasons: ['任一满足组为空，无法满足'] };
      }
      if (condition.mode === 'all') {
        const failures = condition.conditions.flatMap(
          (child) => evaluateCondition(child, state, catalog).reasons,
        );
        return failures.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons: failures };
      }
      const results = condition.conditions.map((child) =>
        evaluateCondition(child, state, catalog),
      );
      if (results.some((result) => result.ok)) return { ok: true, reasons: [] };
      return {
        ok: false,
        reasons: [
          `以下条件需任一满足，但均未达成：${results
            .flatMap((result) => result.reasons)
            .join('；')}`,
        ],
      };
    }
    default:
      return { ok: false, reasons: ['无法识别的条件类型'] };
  }
}

/** 将效果的数值统一成整数；物品增减由应用层负责夹到 0 以上。 */
export function normalizeEffect(effect: Effect): Effect {
  if (effect.kind === 'flag') {
    return { kind: 'flag', key: effect.key, value: Boolean(effect.value) };
  }
  const delta = Number.isFinite(effect.delta) ? Math.trunc(effect.delta) : 0;
  return { kind: effect.kind, key: effect.key, delta };
}

/** 只应用一次；纯函数，不修改传入的 before。 */
export function applyEffects(before: GameState, effects: Effect[]): GameState {
  const after = {
    flags: { ...before.flags },
    stats: { ...before.stats },
    items: { ...before.items },
  };

  for (const raw of effects) {
    const effect = normalizeEffect(raw);
    switch (effect.kind) {
      case 'flag':
        after.flags[effect.key] = effect.value;
        break;
      case 'stat':
        after.stats[effect.key] =
          (Number.isFinite(after.stats[effect.key]) ? after.stats[effect.key] : 0) + effect.delta;
        break;
      case 'item': {
        const current = Number.isFinite(after.items[effect.key]) ? after.items[effect.key] : 0;
        // 兜底：即使条件缺失，库存也不会被扣成负数。
        after.items[effect.key] = Math.max(0, current + effect.delta);
        break;
      }
      default:
        break;
    }
  }

  return after;
}
