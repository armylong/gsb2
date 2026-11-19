import {
  indexAtTime,
  simulate,
  stateAtIndex,
  stateAtTime,
  stateFingerprint,
} from './simulator';
import type {
  ApplyEffectEvent,
  DamageEvent,
  DispelEvent,
  TargetConfig,
  TimelineEvent,
} from './types';
import { getScenario } from '../scenarios';

export interface VerificationCheck {
  id: string;
  title: string;
  expected: string;
  actual: string;
  pass: boolean;
  detail?: string;
}

export interface VerificationGroup {
  id: string;
  title: string;
  checks: VerificationCheck[];
}

const TARGET: TargetConfig = { maxHp: 1000, baseAttack: 100, initialShield: 0 };
const OPTIONS = { horizonMs: 30000 };

let counter = 0;
function make<T extends TimelineEvent>(fields: Omit<T, 'id' | 'order'>): T {
  counter += 1;
  return { id: `verify-${counter}`, order: counter, ...fields } as T;
}
function apply(fields: Omit<ApplyEffectEvent, 'id' | 'order' | 'kind'>): ApplyEffectEvent {
  return make<ApplyEffectEvent>({ kind: 'apply', ...fields });
}
function damage(fields: Omit<DamageEvent, 'id' | 'order' | 'kind'>): DamageEvent {
  return make<DamageEvent>({ kind: 'damage', ...fields });
}
function dispel(time: number, effectKind: DispelEffectKind, source: string): DispelEvent {
  return make<DispelEvent>({ kind: 'dispel', time, effectKind, source });
}
type DispelEffectKind = DispelEvent['effectKind'];

function check(
  id: string,
  title: string,
  expected: unknown,
  actual: unknown,
  detail?: string,
): VerificationCheck {
  const expectedText = JSON.stringify(expected);
  const actualText = JSON.stringify(actual);
  return {
    id,
    title,
    expected: expectedText,
    actual: actualText,
    pass: expectedText === actualText,
    detail,
  };
}

export function runVerification(): VerificationGroup[] {
  const groups: VerificationGroup[] = [];

  // ── 到期边界 ─────────────────────────────────────────────
  {
    const result = simulate(
      [apply({ time: 0, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 })],
      TARGET,
      OPTIONS,
    );
    const ticks = result.records.filter((r) => r.kind === 'tick').map((r) => r.time);
    const boundary = result.records.filter((r) => r.time === 3000);
    groups.push({
      id: 'boundary',
      title: '到期边界：先移除，再处理该时刻事件',
      checks: [
        check('boundary-ticks', '到期边界不再触发跳数（跳点 1000/2000）', [1000, 2000], ticks),
        check('boundary-hp', '最终生命 = 1000 − 50×2', 900, result.finalState.hp),
        check('boundary-expire-first', '3000ms 第一条结算为到期', 'expire', boundary[0]?.kind),
        check(
          'boundary-skip',
          '记录到期边界跳过原因',
          '到期边界',
          boundary.find((r) => r.kind === 'skipped')?.delta.reason,
        ),
      ],
    });

    const shield = simulate(
      [apply({ time: 0, effectKind: 'shield', source: '盾', absorb: 100, durationMs: 2000 })],
      TARGET,
      OPTIONS,
    );
    groups[0].checks.push(
      check('boundary-shield-hp', '护盾到期不扣生命', 1000, shield.finalState.hp),
      check('boundary-shield-loss', '护盾到期不计入累计伤害', 0, shield.finalState.damageTaken),
      check(
        'boundary-shield-remain',
        '到期时剩余吸收量移除（面板显示剩余 100，但不再计入生效护盾）',
        { removedRemaining: 100, activeShield: 0 },
        {
          removedRemaining: shield.records.find((r) => r.kind === 'expire')?.delta.remaining,
          activeShield: shield.finalState.shieldTotal,
        },
      ),
    );
  }

  // ── 刷新节奏 ─────────────────────────────────────────────
  {
    const result = simulate(
      [
        apply({ time: 1000, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 }),
        apply({ time: 1800, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 }),
      ],
      TARGET,
      OPTIONS,
    );
    const ticks = result.records.filter((r) => r.kind === 'tick').map((r) => r.time);
    const refresh = result.records.find((r) => r.kind === 'refresh');
    groups.push({
      id: 'refresh',
      title: '刷新节奏：只延长持续时间',
      checks: [
        check('refresh-ticks', '临近触发点重施不改变跳点', [2000, 3000, 4000], ticks),
        check('refresh-next', '重施后下一跳仍为 2000ms', 2000, refresh?.delta.nextTickAt),
        check('refresh-expire', '重施后到期 = 1800 + 3000', 4800, refresh?.delta.expiresAt),
        check('refresh-hp', '最终生命 = 1000 − 50×3', 850, result.finalState.hp),
      ],
    });

    const valueLock = simulate(
      [
        apply({ time: 0, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 2000, tickDamage: 30 }),
        apply({ time: 500, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 4000, tickDamage: 999 }),
      ],
      TARGET,
      OPTIONS,
    );
    groups[1].checks.push(
      check(
        'refresh-value',
        '重施不改变每跳数值（新数值被忽略）',
        [30, 30, 30, 30],
        valueLock.records.filter((r) => r.kind === 'tick').map((r) => r.delta.tickDamage),
      ),
    );
  }

  // ── 来源隔离 ─────────────────────────────────────────────
  {
    const result = simulate(
      [
        apply({ time: 0, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 5000, tickDamage: 10 }),
        apply({ time: 0, effectKind: 'periodicDamage', source: '火', intervalMs: 1000, durationMs: 5000, tickDamage: 20 }),
        dispel(1500, 'periodicDamage', '毒'),
      ],
      TARGET,
      OPTIONS,
    );
    const ticks = result.records.filter((r) => r.kind === 'tick');
    groups.push({
      id: 'source',
      title: '来源隔离：驱散只移除选定来源',
      checks: [
        check('source-poison', '毒只留下 1000ms 的一跳', 1, ticks.filter((r) => r.delta.source === '毒').length),
        check('source-fire', '火完整跳 4 次', 4, ticks.filter((r) => r.delta.source === '火').length),
        check('source-hp', '最终生命 = 1000 − 10 − 80', 910, result.finalState.hp),
      ],
    });

    const miss = simulate(
      [
        apply({ time: 0, effectKind: 'shield', source: '盾A', absorb: 50, durationMs: 5000 }),
        dispel(1000, 'shield', '盾B'),
      ],
      TARGET,
      OPTIONS,
    );
    groups[2].checks.push(
      check('source-miss', '驱散不存在的来源记录为跳过', true, miss.records.some((r) => r.kind === 'skipped')),
      check('source-miss-shield', '错误来源的驱散不影响盾A', 50, stateAtTime(miss, 1000).shieldTotal),
    );
  }

  // ── 属性恢复 ─────────────────────────────────────────────
  {
    const stack = (time: number) =>
      apply({ time, effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 5000 });
    const result = simulate([stack(0), stack(100), stack(200)], TARGET, OPTIONS);
    groups.push({
      id: 'attack',
      title: '属性恢复：(基础 + 固定) × (1 + 百分比)，只乘一次',
      checks: [
        check('attack-stack3', '3 层：(100 + 30) × 1.30', 169, stateAtTime(result, 300).attack.effectiveAttack),
        check('attack-expire1', '第 1 层到期：(100 + 20) × 1.20', 144, stateAtTime(result, 5000).attack.effectiveAttack),
        check('attack-expire2', '第 2 层到期：(100 + 10) × 1.10', 121, stateAtTime(result, 5100).attack.effectiveAttack),
        check('attack-expire3', '第 3 层到期：恢复基础 100', 100, stateAtTime(result, 5200).attack.effectiveAttack),
        check(
          'attack-breakdown',
          '属性组成（基础/固定/百分比）',
          { baseAttack: 100, flatBonus: 30, pctBonus: 30 },
          (({ baseAttack, flatBonus, pctBonus }) => ({ baseAttack, flatBonus, pctBonus }))(
            stateAtTime(result, 300).attack,
          ),
        ),
      ],
    });

    const driftSchedule: TimelineEvent[] = [];
    for (let i = 0; i < 20; i += 1) driftSchedule.push(stack(i * 700));
    const drift = simulate(driftSchedule, TARGET, { horizonMs: 30000 });
    const attacks = new Set(drift.records.map((r) => r.after.attack.effectiveAttack));
    groups[3].checks.push(
      check('attack-drift-values', '20 次施加/到期只产生 169/144/121/100', [100, 121, 144, 169], [...attacks].sort()),
      check('attack-drift-final', '最终恢复基础攻击', 100, drift.finalState.attack.effectiveAttack),
      check(
        'attack-drift-integral',
        '所有攻击值均为整数（无浮点漂移）',
        true,
        [...attacks].every((value) => Number.isInteger(value)),
      ),
    );
  }

  // ── 时间跳转一致性 ───────────────────────────────────────
  {
    const scenario = getScenario('mixed');
    const full = simulate(scenario.events, scenario.target, OPTIONS);
    const times = [0, 500, 1000, 1500, 2500, 3000, 4000, 4500, 6000, 8000, 12000, 30000];
    const mismatches = times.filter((time) => {
      const jumped = simulate(scenario.events, scenario.target, { horizonMs: time });
      return stateFingerprint(jumped.finalState) !== stateFingerprint(stateAtTime(full, time));
    });
    const cursorMismatch = times.filter((time) => {
      const index = indexAtTime(full, time);
      return stateFingerprint(stateAtIndex(full, index)) !== stateFingerprint(stateAtTime(full, time));
    });
    const recordCount = full.records.length;
    stateAtTime(full, 4200);
    stateAtTime(full, 0);
    stateAtTime(full, 4200);

    const modified = scenario.events.map((event) =>
      event.id === 'm-hit-1' ? { ...event, time: 1600 } : event,
    );
    const edited = simulate(modified, scenario.target, OPTIONS);

    groups.push({
      id: 'seek',
      title: '时间跳转一致性：直接定位 = 连续运行',
      checks: [
        check('seek-times', '12 个时间点的定位结果与连续运行一致', [], mismatches),
        check('seek-cursor', '按记录游标回看与按时间定位一致', [], cursorMismatch),
        check('seek-replay', '回看不会重复触发结算（记录数不变）', recordCount, full.records.length),
        check('seek-hash', '修改时间表后结果指纹变化', true, edited.scheduleHash !== full.scheduleHash),
      ],
    });
  }

  // ── 同一时刻的次序 ───────────────────────────────────────
  {
    const shield = apply({ time: 1000, effectKind: 'shield', source: '盾', absorb: 100, durationMs: 2000 });
    const damageEvent = damage({ time: 1000, amount: 80 });
    const shieldFirst = simulate(
      [shield, { ...damageEvent, order: shield.order + 1 }],
      TARGET,
      OPTIONS,
    );
    const damageFirst = simulate(
      [{ ...damageEvent, order: shield.order - 1 }, shield],
      TARGET,
      OPTIONS,
    );
    const sameInstant = simulate(
      [
        apply({ time: 0, effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 5000, tickDamage: 50 }),
        dispel(2000, 'periodicDamage', '毒'),
      ],
      TARGET,
      OPTIONS,
    );
    groups.push({
      id: 'order',
      title: '同一时刻的次序：事件按 order，跳数在事件之后',
      checks: [
        check('order-shield-first', '护盾先结算：伤害全吸收，生命 1000', 1000, shieldFirst.finalState.hp),
        check('order-damage-first', '伤害先结算：扣血 80，生命 920', 920, damageFirst.finalState.hp),
        check(
          'order-dispel-cancels-tick',
          '同刻驱散发生在跳数之前，2000ms 那一跳被取消',
          [1000],
          sameInstant.records.filter((r) => r.kind === 'tick').map((r) => r.time),
        ),
      ],
    });
  }

  // ── 三组可重置例子 ───────────────────────────────────────
  {
    const refreshScenario = getScenario('refresh-near-tick');
    const refresh = simulate(refreshScenario.events, refreshScenario.target, OPTIONS);
    const stackScenario = getScenario('stack-expiry');
    const stacks = simulate(stackScenario.events, stackScenario.target, OPTIONS);
    const shieldScenario = getScenario('shield-depletion');
    const shields = simulate(shieldScenario.events, shieldScenario.target, OPTIONS);

    groups.push({
      id: 'examples',
      title: '三组可重置例子的已知数值',
      checks: [
        check(
          'example-refresh',
          '重施例子：毒雾 3 跳 + 烈焰 1 跳，5000ms 到期边界跳过',
          { hp: 820, poisonTicks: 3, fireTicks: 1, boundarySkipAt: 5000 },
          {
            hp: refresh.finalState.hp,
            poisonTicks: refresh.records.filter((r) => r.kind === 'tick' && r.delta.source === '毒雾').length,
            fireTicks: refresh.records.filter((r) => r.kind === 'tick' && r.delta.source === '烈焰').length,
            boundarySkipAt: refresh.records.find((r) => r.kind === 'skipped' && r.delta.reason === '到期边界')?.time,
          },
        ),
        check(
          'example-stack',
          '叠层例子：驱散号角后 / 三层逐一到期',
          { afterDispel: 169, afterFirst: 144, afterSecond: 121, afterThird: 100 },
          {
            afterDispel: stateAtTime(stacks, 1600).attack.effectiveAttack,
            afterFirst: stateAtTime(stacks, 2000).attack.effectiveAttack,
            afterSecond: stateAtTime(stacks, 3000).attack.effectiveAttack,
            afterThird: stateAtTime(stacks, 3500).attack.effectiveAttack,
          },
        ),
        check(
          'example-shield',
          '护盾例子：扣血 30，盾C到期剩余 30 不计伤害',
          { hp: 970, damageTaken: 30, shieldCExpireRemaining: 30 },
          {
            hp: shields.finalState.hp,
            damageTaken: shields.finalState.damageTaken,
            shieldCExpireRemaining: shields.records.find(
              (r) => r.kind === 'expire' && r.time === 6000,
            )?.delta.remaining,
          },
        ),
      ],
    });
  }

  return groups;
}
