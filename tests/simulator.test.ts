import { describe, expect, it } from 'vitest';
import {
  stateAtIndex,
  stateAtTime,
  stateFingerprint,
  simulate,
  attackBreakdown,
  scheduleHash,
  sortSchedule,
  stateBeforeTime,
} from '../src/engine/simulator';
import type { ApplyEffectEvent, DamageEvent, DispelEvent, TimelineEvent } from '../src/engine/types';
import { getScenario, normalizeEvents } from '../src/scenarios';
import { runVerification } from '../src/engine/verification';

const TARGET = { maxHp: 1000, baseAttack: 100, initialShield: 0 };
const options = (horizonMs = 30000) => ({ horizonMs });

let idCounter = 0;
function base(partial: Partial<TimelineEvent> & Pick<TimelineEvent, 'time' | 'kind'>): TimelineEvent {
  idCounter += 1;
  return { id: `t-${idCounter}`, order: idCounter, ...partial } as TimelineEvent;
}
function apply(time: number, fields: Omit<ApplyEffectEvent, 'id' | 'order' | 'time' | 'kind'>): ApplyEffectEvent {
  return base({ time, kind: 'apply', ...fields }) as ApplyEffectEvent;
}
function hit(time: number, amount: number): DamageEvent {
  return base({ time, kind: 'damage', amount }) as DamageEvent;
}
function dispel(time: number, effectKind: DispelEvent['effectKind'], source: string): DispelEvent {
  return base({ time, kind: 'dispel', effectKind, source }) as DispelEvent;
}

function kindsAt(records: ReturnType<typeof simulate>['records'], time: number) {
  return records.filter((r) => r.time === time).map((r) => r.kind);
}

describe('到期边界', () => {
  it('周期伤害在到期时刻先移除效果，不再触发该时刻跳数', () => {
    const result = simulate(
      [apply(0, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 })],
      TARGET,
      options(),
    );
    const ticks = result.records.filter((r) => r.kind === 'tick');
    expect(ticks.map((r) => r.time)).toEqual([1000, 2000]);
    expect(result.finalState.hp).toBe(900);
    expect(result.finalState.damageTaken).toBe(100);
    expect(result.finalState.effects.find((e) => e.kind === 'periodicDamage')?.status).toBe('expired');
    const boundary = result.records.find((r) => r.kind === 'expire' && r.time === 3000);
    expect(boundary).toBeDefined();
    expect(boundary?.delta.skippedTick).toBe(1);
    const skipped = result.records.find((r) => r.kind === 'skipped' && r.time === 3000);
    expect(skipped?.text).toContain('到期边界');
    // 到期时刻的次序：expire 记录必须先于该时刻的用户事件
    expect(kindsAt(result.records, 3000)[0]).toBe('expire');
  });

  it('到期时间早于下一跳时，不产生边界跳过', () => {
    const result = simulate(
      [apply(0, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 2500, tickDamage: 50 })],
      TARGET,
      options(),
    );
    expect(result.records.filter((r) => r.kind === 'tick').map((r) => r.time)).toEqual([1000, 2000]);
    expect(result.records.filter((r) => r.kind === 'skipped')).toHaveLength(0);
    expect(result.finalState.hp).toBe(900);
  });

  it('护盾到期只移除吸收量，不造成生命损失', () => {
    const result = simulate(
      [apply(0, { effectKind: 'shield', source: '盾', absorb: 100, durationMs: 2000 })],
      TARGET,
      options(),
    );
    const expiry = result.records.find((r) => r.kind === 'expire');
    expect(expiry?.delta.hpLost).toBe(0);
    expect(expiry?.delta.remaining).toBe(100);
    expect(result.finalState.hp).toBe(1000);
    expect(result.finalState.damageTaken).toBe(0);
    expect(result.finalState.shieldTotal).toBe(0);
  });

  it('到期清理先于同刻伤害：护盾到期后该时刻伤害直接扣血', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '盾', absorb: 100, durationMs: 2000 }),
        hit(2000, 50),
      ],
      TARGET,
      options(),
    );
    const at2000 = result.records.filter((r) => r.time === 2000);
    expect(at2000.map((r) => r.kind)).toEqual(['expire', 'damage']);
    expect(result.finalState.hp).toBe(950);
  });
});

describe('刷新节奏', () => {
  it('同来源重施只刷新持续时间，下一跳节奏保持不变', () => {
    const result = simulate(
      [
        apply(1000, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 }),
        apply(1800, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 }),
      ],
      TARGET,
      options(),
    );
    const ticks = result.records.filter((r) => r.kind === 'tick');
    expect(ticks.map((r) => r.time)).toEqual([2000, 3000, 4000]);
    expect(ticks[0].delta.tick).toBe(1);
    const refresh = result.records.find((r) => r.kind === 'refresh');
    expect(refresh?.delta.nextTickAt).toBe(2000);
    expect(refresh?.delta.expiresAt).toBe(4800);
    expect(result.finalState.hp).toBe(850);
  });

  it('重施不改变每跳数值', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 2000, tickDamage: 30 }),
        apply(500, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 4000, tickDamage: 999 }),
      ],
      TARGET,
      options(),
    );
    expect(result.records.filter((r) => r.kind === 'tick').map((r) => r.delta.tickDamage)).toEqual([30, 30, 30, 30]);
    expect(result.finalState.hp).toBe(880);
  });
});

describe('来源隔离', () => {
  it('驱散只移除选定来源，另一个来源继续跳', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 5000, tickDamage: 10 }),
        apply(0, { effectKind: 'periodicDamage', source: '火', intervalMs: 1000, durationMs: 5000, tickDamage: 20 }),
        dispel(1500, 'periodicDamage', '毒'),
      ],
      TARGET,
      options(),
    );
    const ticks = result.records.filter((r) => r.kind === 'tick');
    expect(ticks.filter((r) => r.delta.source === '毒')).toHaveLength(1);
    expect(ticks.filter((r) => r.delta.source === '火')).toHaveLength(4);
    expect(result.finalState.hp).toBe(1000 - 10 - 20 * 4);
  });

  it('驱散不存在的来源记录为跳过，不影响其他效果', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '盾A', absorb: 50, durationMs: 5000 }),
        dispel(1000, 'shield', '盾B'),
      ],
      TARGET,
      options(),
    );
    expect(result.records.some((r) => r.kind === 'skipped' && r.time === 1000)).toBe(true);
    expect(stateAtTime(result, 1000).shieldTotal).toBe(50);
  });

  it('攻击加成多来源分别记录、分别驱散', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 5000 }),
        apply(0, { effectKind: 'attackBuff', source: '号角', attackFlat: 20, attackPct: 0, durationMs: 5000 }),
        dispel(1000, 'attackBuff', '号角'),
      ],
      TARGET,
      options(),
    );
    const state = stateAtTime(result, 1000);
    expect(state.attack.effectiveAttack).toBe(121);
    expect(state.attack.flatBonus).toBe(10);
    expect(state.attack.pctBonus).toBe(10);
  });
});

describe('属性恢复与叠层', () => {
  const stack = (time: number) =>
    apply(time, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 3000 });

  it('固定值先加、百分比后乘，且只乘一次', () => {
    expect(attackBreakdown(100, []).effectiveAttack).toBe(100);
    const one = simulate([stack(0)], TARGET, options());
    expect(stateAtTime(one, 100).attack.effectiveAttack).toBe(121);
    const two = simulate([stack(0), stack(100)], TARGET, options());
    expect(stateAtTime(two, 200).attack).toEqual({
      baseAttack: 100,
      flatBonus: 20,
      pctBonus: 20,
      effectiveAttack: Math.round(120 * 1.2),
    });
    const three = simulate([stack(0), stack(100), stack(200)], TARGET, options());
    expect(stateAtTime(three, 300).attack).toEqual({
      baseAttack: 100,
      flatBonus: 30,
      pctBonus: 30,
      effectiveAttack: Math.round(130 * 1.3),
    });
  });

  it('各层独立到期，攻击按剩余层数恢复', () => {
    const result = simulate([stack(0), stack(1000), stack(2000)], TARGET, options());
    expect(stateAtTime(result, 999).attack.effectiveAttack).toBe(121);
    expect(stateAtTime(result, 1000).attack.effectiveAttack).toBe(144);
    expect(stateAtTime(result, 2000).attack.effectiveAttack).toBe(169);
    // 第 1 层在 3000 到期，剩余两层；第 2 层 4000 到期，剩一层；第 3 层 5000 到期。
    expect(stateAtTime(result, 3000).attack.effectiveAttack).toBe(144);
    expect(stateAtTime(result, 4000).attack.effectiveAttack).toBe(121);
    expect(stateAtTime(result, 5000).attack.effectiveAttack).toBe(100);
  });

  it('反复施加与到期不会造成数值漂移', () => {
    let schedule: TimelineEvent[] = [];
    for (let i = 0; i < 8; i += 1) {
      schedule.push(stack(i * 1000));
    }
    const result = simulate(schedule, TARGET, options(12000));
    const attackValues = new Set(
      result.records.filter((r) => r.kind === 'expire').map((r) => r.after.attack.effectiveAttack),
    );
    expect([...attackValues].every((v) => [121, 144, 169, 100].includes(v))).toBe(true);
    const final = stateAtTime(result, 12000);
    expect(final.hp).toBe(1000);
    expect(Number.isInteger(final.attack.effectiveAttack)).toBe(true);
  });

  it('满 3 层时同来源重施刷新最早到期层，不新增层', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 1000 }),
        apply(100, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 1000 }),
        apply(200, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 1000 }),
        apply(300, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 5000 }),
      ],
      TARGET,
      options(),
    );
    const refresh = result.records.find((r) => r.kind === 'refresh' && r.time === 300);
    expect(refresh?.delta.expiresAt).toBe(5300);
    expect(refresh?.after.attack.effectiveAttack).toBe(169);
    expect(refresh?.after.effects.filter((e) => e.kind === 'attackBuff' && e.status === 'active')).toHaveLength(1);
    // 第 1 层被刷新到 5300，1000/1100/1200 只剩第 2、3 层依次到期。
    expect(stateAtTime(result, 1000).attack.effectiveAttack).toBe(169);
    expect(stateAtTime(result, 1100).attack.effectiveAttack).toBe(144);
    expect(stateAtTime(result, 1200).attack.effectiveAttack).toBe(121);
  });
});

describe('护盾吸收顺序', () => {
  it('较早到期者先吸收，剩余伤害扣生命', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '早', absorb: 100, durationMs: 2000 }),
        apply(0, { effectKind: 'shield', source: '晚', absorb: 100, durationMs: 5000 }),
        hit(500, 150),
      ],
      TARGET,
      options(),
    );
    const absorbs = result.records.filter((r) => r.kind === 'shieldAbsorb');
    expect(absorbs.map((r) => r.delta.source)).toEqual(['早', '晚']);
    expect(absorbs[0].delta.absorbed).toBe(100);
    expect(absorbs[1].delta.absorbed).toBe(50);
    expect(result.finalState.hp).toBe(1000);
    expect(stateAtTime(result, 600).shieldTotal).toBe(50);
  });

  it('到期相同按施加次序吸收', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '先', absorb: 40, durationMs: 2000 }),
        apply(100, { effectKind: 'shield', source: '后', absorb: 40, durationMs: 1900 }),
        hit(500, 50),
      ],
      TARGET,
      options(),
    );
    const absorbs = result.records.filter((r) => r.kind === 'shieldAbsorb');
    expect(absorbs.map((r) => r.delta.source)).toEqual(['先', '后']);
    expect(stateAtTime(result, 600).shieldTotal).toBe(30);
  });

  it('护盾耗尽后剩余伤害扣血，生命最低为 0', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '盾', absorb: 30, durationMs: 5000 }),
        hit(1000, 100),
        hit(2000, 2000),
        hit(3000, 50),
      ],
      { maxHp: 200, baseAttack: 100, initialShield: 0 },
      options(),
    );
    const death = result.records.find((r) => r.kind === 'death');
    expect(death?.time).toBe(2000);
    expect(result.finalState.hp).toBe(0);
    expect(result.finalState.damageTaken).toBe(200);
    expect(result.records.some((r) => r.kind === 'skipped' && r.time === 3000)).toBe(true);
  });

  it('同刻伤害在护盾施加之后结算时，按事件顺序使用新护盾', () => {
    const result = simulate(
      sortSchedule([
        apply(1000, { effectKind: 'shield', source: '盾', absorb: 100, durationMs: 2000 }),
        hit(1000, 80),
      ]),
      TARGET,
      options(),
    );
    expect(result.finalState.hp).toBe(1000);
    expect(stateAtTime(result, 1000).shieldTotal).toBe(20);
  });

  it('护盾到期不会被计入伤害或生命损失', () => {
    const result = simulate(
      [apply(0, { effectKind: 'shield', source: '盾', absorb: 100, durationMs: 3000 }), hit(1000, 10)],
      TARGET,
      options(),
    );
    expect(result.finalState.hp).toBe(1000);
    expect(result.finalState.damageTaken).toBe(0);
    const expiry = result.records.find((r) => r.kind === 'expire');
    expect(expiry?.after.hp).toBe(1000);
    expect(expiry?.after.damageTaken).toBe(0);
  });
});

describe('死亡与跳过', () => {
  it('死亡后不再发生伤害与施加，但到期清理仍记录', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '盾', absorb: 50, durationMs: 3000 }),
        hit(1000, 5000),
        apply(2000, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 1000 }),
        hit(2500, 100),
      ],
      { maxHp: 1000, baseAttack: 100, initialShield: 0 },
      options(),
    );
    expect(result.finalState.hp).toBe(0);
    expect(result.finalState.dead).toBe(true);
    expect(result.records.find((r) => r.kind === 'death')?.time).toBe(1000);
    expect(result.records.some((r) => r.kind === 'skipped' && r.time === 2000)).toBe(true);
    expect(result.records.some((r) => r.kind === 'skipped' && r.time === 2500)).toBe(true);
    // 护盾在 1000ms 被 5000 点伤害打空，5000 中的 50 被吸收，其余 4950 扣血（生命只有 1000）。
    expect(result.finalState.damageTaken).toBe(1000);
    expect(result.finalState.effects.find((e) => e.kind === 'attackBuff')).toBeUndefined();
    expect(result.finalState.effects.find((e) => e.kind === 'shield')?.status).toBe('depleted');
  });
});

describe('时间跳转一致性', () => {
  const scenario = getScenario('mixed');

  it('直接定位到时间 T 与完整运行到 T 的状态一致', () => {
    const full = simulate(scenario.events, scenario.target, options());
    for (const time of [0, 1000, 1500, 2500, 3000, 4000, 4500, 6000, 8000, 12000, 30000]) {
      const jumped = simulate(scenario.events, scenario.target, options(time));
      expect(stateFingerprint(jumped.finalState)).toBe(stateFingerprint(stateAtTime(full, time)));
    }
  });

  it('记录游标回看得到与时刻定位相同的结果，且不会重复触发', () => {
    const full = simulate(scenario.events, scenario.target, options());
    const at = stateAtTime(full, 4200);
    const index = full.records.findLastIndex((r) => r.time <= 4200);
    expect(stateFingerprint(stateAtIndex(full, index))).toBe(stateFingerprint(at));
    // 回看后再前进不会改变记录
    const before = full.records.length;
    stateAtTime(full, 0);
    stateAtTime(full, 4200);
    expect(full.records.length).toBe(before);
    expect(stateFingerprint(stateBeforeTime(full, 4200))).toBe(stateFingerprint(stateAtTime(full, 4199)));
  });

  it('修改时间表后哈希变化，旧结果不能冒充新结果', () => {
    const a = simulate(scenario.events, scenario.target, options());
    const modified = scenario.events.map((event) =>
      event.id === 'm-hit-1' ? { ...event, time: 1600, amount: 120 } : event,
    );
    const b = simulate(modified, scenario.target, options());
    expect(a.scheduleHash).not.toBe(b.scheduleHash);
    const stale = simulate(scenario.events, scenario.target, options());
    expect(stale.scheduleHash).toBe(a.scheduleHash);
    expect(scheduleHash(b.schedule, scenario.target)).toBe(b.scheduleHash);
  });
});

describe('可重置例子', () => {
  it('重施临近触发点例子：刷新保持节奏并隔离来源', () => {
    const scenario = getScenario('refresh-near-tick');
    const result = simulate(scenario.events, scenario.target, options());
    const poisonTicks = result.records.filter((r) => r.kind === 'tick' && r.delta.source === '毒雾');
    expect(poisonTicks.map((r) => r.time)).toEqual([2000, 3000, 4000]);
    const fireTicks = result.records.filter((r) => r.kind === 'tick' && r.delta.source === '烈焰');
    expect(fireTicks.map((r) => r.time)).toEqual([4000]);
    expect(result.records.some((r) => r.kind === 'skipped' && r.delta.source === '冰霜')).toBe(true);
    expect(result.records.some((r) => r.kind === 'dispel' && r.delta.source === '烈焰')).toBe(true);
    const boundary = result.records.find((r) => r.kind === 'skipped' && r.delta.reason === '到期边界');
    expect(boundary?.time).toBe(5000);
    expect(boundary?.delta.source).toBe('毒雾');
    expect(result.finalState.hp).toBe(1000 - 50 * 3 - 30);
  });

  it('叠层分别到期例子：按剩余层数恢复并只驱散选定来源', () => {
    const scenario = getScenario('stack-expiry');
    const result = simulate(scenario.events, scenario.target, options());
    // 战歌 3 层 (+30/+30%) 与号角 (+20) 同时生效。
    expect(stateAtTime(result, 1599).attack.effectiveAttack).toBe(Math.round(150 * 1.3));
    // 1600 驱散号角，只移除号角来源。
    expect(stateAtTime(result, 1600).attack.effectiveAttack).toBe(Math.round(130 * 1.3));
    // 2000 第 1 层到期；1000/1500 层在 3000/3500 到期。
    expect(stateAtTime(result, 2000).attack.effectiveAttack).toBe(Math.round(120 * 1.2));
    expect(stateAtTime(result, 3000).attack.effectiveAttack).toBe(Math.round(110 * 1.1));
    expect(stateAtTime(result, 3500).attack.effectiveAttack).toBe(100);
  });

  it('护盾耗尽例子：吸收顺序、到期与生命值符合预期', () => {
    const scenario = getScenario('shield-depletion');
    const result = simulate(scenario.events, scenario.target, options());
    // 2000 盾A 100 + 盾B 50；2500 盾B 余 30 吸收后扣血 30；5500 盾C 吸收 20；
    // 8500 盾D 40 + 盾E 10，剩余 0 扣血。总计扣血 30。
    expect(result.finalState.hp).toBe(970);
    expect(result.finalState.damageTaken).toBe(30);
    const absorbed = result.records
      .filter((r) => r.kind === 'shieldAbsorb')
      .map((r) => `${r.time}:${r.delta.source}:${r.delta.absorbed}`);
    expect(absorbed).toEqual([
      '2000:盾A:100',
      '2000:盾B:50',
      '2500:盾B:30',
      '5500:盾C:20',
      '8500:盾D:40',
      '8500:盾E:10',
    ]);
    const shieldExpiry = result.records.filter((r) => r.kind === 'expire' && r.time === 6000);
    expect(shieldExpiry[0].delta.remaining).toBe(30);
    // 盾C 在 6000 到期，生命不变（5500 时已扣 0）
    expect(stateAtTime(result, 5999).hp).toBe(stateAtTime(result, 6000).hp);
  });

  it('综合演示例子：已知最终数值', () => {
    const scenario = getScenario('mixed');
    const result = simulate(scenario.events, scenario.target, options());
    // 初始盾 50 → 1500 伤害 120 吸收 50、扣血 70；毒雾 1000..5000 共 5 跳 200 点；
    // 4500 伤害 300 被护心 200 全吸收后扣血 100；6000 毒雾到期与下一跳同刻被跳过，
    // 护心到期移除剩余吸收量但不扣血。
    expect(result.finalState.hp).toBe(630);
    expect(result.finalState.damageTaken).toBe(370);
    expect(result.records.some((r) => r.kind === 'skipped' && r.time === 6000 && r.delta.reason === '到期边界')).toBe(true);
    expect(result.finalState.shieldTotal).toBe(0);
    expect(result.finalState.attack.effectiveAttack).toBe(100);
  });
});

describe('内置结算验证面板', () => {
  const groups = runVerification();
  it('所有验证项通过', () => {
    const failed = groups.flatMap((group) =>
      group.checks.filter((c) => !c.pass).map((c) => ({ group: group.id, ...c })),
    );
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });
});

describe('同一时刻的结算次序', () => {
  it('同刻事件按 order 结算：伤害在护盾之前/之后结果不同', () => {
    const shield = apply(1000, { effectKind: 'shield', source: '盾', absorb: 100, durationMs: 2000 });
    const damage = hit(1000, 80);
    const before = simulate(
      sortSchedule([{ ...shield, order: 0 }, { ...damage, order: 1 }]),
      TARGET,
      options(),
    );
    const after = simulate(
      sortSchedule([{ ...damage, order: 0 }, { ...shield, order: 1 }]),
      TARGET,
      options(),
    );
    expect(before.finalState.hp).toBe(1000);
    expect(after.finalState.hp).toBe(920);
  });

  it('同刻用户事件先于周期伤害跳数：同刻驱散可以取消这一跳', () => {
    const withDispel = simulate(
      sortSchedule([
        apply(0, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 5000, tickDamage: 50 }),
        dispel(2000, 'periodicDamage', '毒'),
      ]),
      TARGET,
      options(),
    );
    expect(withDispel.records.filter((r) => r.kind === 'tick').map((r) => r.time)).toEqual([1000]);
    const refreshOnly = simulate(
      sortSchedule([
        apply(0, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 }),
        apply(2000, { effectKind: 'periodicDamage', source: '毒', intervalMs: 1000, durationMs: 3000, tickDamage: 50 }),
      ]),
      TARGET,
      options(),
    );
    // 2000ms 的重施发生在跳数之前，但重施不取消已到点的跳数。
    expect(refreshOnly.records.filter((r) => r.kind === 'tick').map((r) => r.time)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('同刻次序重排后时间表哈希变化，且再次排序结果稳定', () => {
    const events = normalizeEvents([
      apply(500, { effectKind: 'shield', source: '盾', absorb: 40, durationMs: 1000 }),
      hit(500, 30),
      hit(500, 30),
    ]);
    const swapped = normalizeEvents([
      { ...events[1], order: 0 },
      { ...events[0], order: 1 },
      { ...events[2], order: 2 },
    ]);
    expect(scheduleHash(events, TARGET)).not.toBe(scheduleHash(swapped, TARGET));
    const first = simulate(events, TARGET, options());
    const second = simulate(normalizeEvents(simulate(events, TARGET, options()).schedule), TARGET, options());
    expect(stateFingerprint(first.finalState)).toBe(stateFingerprint(second.finalState));
    // 先施加护盾再吃两次 30：盾吸收 30 + 10，剩余 20 扣血。
    expect(first.finalState.hp).toBe(980);
    // 次序交换为先伤害再护盾：第一次 30 直接扣血，第二次被护盾吸收。
    expect(simulate(swapped, TARGET, options()).finalState.hp).toBe(970);
  });
});

describe('边界与异常输入', () => {
  it('周期等于持续时间时，第一跳正好落在到期边界，被跳过且不扣血', () => {
    const result = simulate(
      [apply(0, { effectKind: 'periodicDamage', source: '短毒', intervalMs: 1000, durationMs: 1000, tickDamage: 50 })],
      TARGET,
      options(),
    );
    expect(result.records.filter((r) => r.kind === 'tick')).toHaveLength(0);
    expect(result.records.find((r) => r.kind === 'skipped')?.delta.reason).toBe('到期边界');
    expect(result.finalState.hp).toBe(1000);
  });

  it('伤害为 0 记为跳过，不产生伤害记录', () => {
    const result = simulate([hit(500, 0)], TARGET, options());
    expect(result.records).toHaveLength(1);
    expect(result.records[0].kind).toBe('skipped');
    expect(result.records[0].delta.reason).toBe('伤害不大于 0');
    expect(result.finalState.hp).toBe(1000);
  });

  it('到期时刻正好在 30s 边界时仍会被处理', () => {
    const result = simulate(
      [apply(0, { effectKind: 'shield', source: '长盾', absorb: 10, durationMs: 30000 })],
      TARGET,
      options(),
    );
    const expiry = result.records.find((r) => r.kind === 'expire');
    expect(expiry?.time).toBe(30000);
    expect(result.finalState.shieldTotal).toBe(0);
    expect(result.finalState.hp).toBe(1000);
  });

  it('死亡时护盾先被耗尽；此后到期的攻击加成仍会记录到期', () => {
    const result = simulate(
      [
        apply(0, { effectKind: 'shield', source: '盾', absorb: 10, durationMs: 3000 }),
        apply(0, { effectKind: 'attackBuff', source: '战歌', attackFlat: 10, attackPct: 10, durationMs: 2000 }),
        hit(500, 2000),
      ],
      { maxHp: 1000, baseAttack: 100, initialShield: 0 },
      options(),
    );
    expect(result.finalState.dead).toBe(true);
    const shield = result.finalState.effects.find((e) => e.kind === 'shield');
    expect(shield?.status).toBe('depleted');
    const expiry = result.records.find((r) => r.kind === 'expire' && r.delta.source === '战歌');
    expect(expiry?.time).toBe(2000);
    expect(expiry?.after.hp).toBe(0);
    expect(expiry?.after.attack.effectiveAttack).toBe(100);
  });
});
