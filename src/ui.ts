import type { EffectInstance, SettlementRecord, TimelineEvent } from './engine/types';
import { formatMs } from './engine/simulator';

export const KIND_LABEL = {
  attackBuff: '攻击加成',
  periodicDamage: '周期伤害',
  shield: '护盾',
} as const;

export const KIND_CLASS = {
  attackBuff: 'tone-buff',
  periodicDamage: 'tone-dot',
  shield: 'tone-shield',
} as const;

export const CATEGORY_LABEL: Record<SettlementRecord['kind'], string> = {
  apply: '施加',
  stack: '叠层',
  refresh: '刷新',
  tick: '周期伤害',
  shieldAbsorb: '护盾吸收',
  shieldBreak: '护盾耗尽',
  damage: '伤害',
  death: '死亡',
  dispel: '驱散',
  expire: '到期',
  skipped: '跳过',
};

export const CATEGORY_ICON: Record<SettlementRecord['kind'], string> = {
  apply: '＋',
  stack: '◆',
  refresh: '↻',
  tick: '▾',
  shieldAbsorb: '◈',
  shieldBreak: '◇',
  damage: '✕',
  death: '☠',
  dispel: '⊘',
  expire: '⏱',
  skipped: '⚠',
};

export function eventTitle(event: TimelineEvent): string {
  if (event.kind === 'apply') {
    return `施加${KIND_LABEL[event.effectKind]} · ${event.source}`;
  }
  if (event.kind === 'dispel') {
    return `驱散${KIND_LABEL[event.effectKind]} · ${event.source}`;
  }
  return `普通伤害 · ${event.amount}`;
}

export function eventSummary(event: TimelineEvent): string {
  if (event.kind === 'apply') {
    if (event.effectKind === 'attackBuff') {
      const parts = [];
      if (event.attackFlat) parts.push(`+${event.attackFlat} 固定`);
      if (event.attackPct) parts.push(`+${event.attackPct}%`);
      return `${parts.join(' / ') || '无加成'} · 每层 ${formatMs(event.durationMs ?? 0)}`;
    }
    if (event.effectKind === 'periodicDamage') {
      return `${event.tickDamage ?? 0} 点 / ${formatMs(event.intervalMs ?? 0)} · 持续 ${formatMs(event.durationMs ?? 0)}`;
    }
    return `吸收 ${event.absorb ?? 0} · 持续 ${formatMs(event.durationMs ?? 0)}`;
  }
  if (event.kind === 'dispel') return '只移除该来源的实例';
  return `${event.amount} 点`;
}

export function effectLabel(effect: EffectInstance): string {
  return effect.source;
}

export function formatValue(value: number | string | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value;
}

export const KIND_ORDER = ['attackBuff', 'periodicDamage', 'shield'] as const;

export const DELTA_LABEL: Record<string, string> = {
  source: '来源',
  trigger: '触发来源',
  reason: '原因',
  note: '说明',
  stackId: '层 id',
  stacks: '层数',
  stacksLeft: '剩余层数',
  expiresAt: '到期时刻',
  nextTickAt: '下一跳',
  tick: '跳数',
  tickDamage: '每跳伤害',
  scheduledAt: '原定时刻',
  skippedTick: '是否跳过跳数',
  flat: '固定加成',
  pct: '百分比加成',
  removed: '移除层数',
  absorb: '吸收量',
  absorbed: '本次吸收',
  absorbedBy: '吸收明细',
  remaining: '剩余量',
  remainingInShield: '护盾剩余',
  incoming: '来袭伤害',
  hpLost: '生命损失',
  overflow: '溢出伤害',
  deadAt: '死亡时刻',
};

export function deltaRows(delta: Record<string, number | string>): { label: string; value: string }[] {
  return Object.entries(delta)
    .filter(([key]) => key !== 'note')
    .map(([key, value]) => ({
      label: DELTA_LABEL[key] ?? key,
      value: formatDeltaValue(key, value),
    }));
}

function formatDeltaValue(key: string, value: number | string): string {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '无定时到期';
  if (!Number.isInteger(value)) return value.toFixed(2);
  return /(At|expires|nextTickAt|time|scheduledAt)$/i.test(key) ? `${value}ms` : String(value);
}
