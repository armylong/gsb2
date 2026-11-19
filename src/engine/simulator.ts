import type {
  AttackBreakdown,
  AttackBuffInstance,
  AttackStack,
  DamageEvent,
  DispelEvent,
  EffectInstance,
  EffectLifetime,
  EndReason,
  PeriodicDamageInstance,
  SettlementCategory,
  SettlementRecord,
  ShieldInstance,
  SimState,
  SimulationOptions,
  SimulationResult,
  TargetConfig,
  TimelineEvent,
  ApplyEffectEvent,
} from './types';

/**
 * 结算规则（界面「结算规则」面板展示的同一份文字）：
 *
 * 1. 每个时刻分三步，顺序固定：① 到期清理 → ② 用户事件（按 order）→ ③ 周期伤害跳数。
 *    到期先于该时刻事件，因此 nextTick 正好落在到期时刻时不会触发（时间线会记录「跳过」）。
 * 2. 同一时刻的用户事件按 (time, order) 排序，order 在事件表中可见、可调，修改后保持稳定。
 * 3. 攻击加成：每层独立到期，最多 3 层；同来源满层重施不新增层，而是刷新最早到期的一层
 *    （沿用该层数值）。最终攻击 = (基础攻击 + Σ固定值) × (1 + Σ百分比)，只乘一次。
 * 4. 周期伤害：第一次在施加后一个周期触发；同来源重施只刷新持续时间，nextTick 不变。
 *    驱散只移除指定来源的实例。
 * 5. 护盾：受击时按 (到期时间, 施加序号) 从早到晚吸收，剩余伤害扣生命；生命最低为 0。
 *    护盾到期/被驱散只是移除吸收量，绝不折算成生命损失。
 * 6. 目标死亡后，后续用户事件与跳数记录为「跳过」，到期清理继续执行以便回看。
 */
export const RULES_VERSION = 'settlement-v1';
export const MAX_ATTACK_STACKS = 3;
export const HORIZON_MS = 30000;

export const DEFAULT_TARGET: TargetConfig = {
  maxHp: 1000,
  baseAttack: 100,
  initialShield: 0,
};

export const DEFAULT_OPTIONS: SimulationOptions = { horizonMs: HORIZON_MS };

const EPS = 1e-9;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function attackBreakdown(baseAttack: number, effects: EffectInstance[]): AttackBreakdown {
  let flatBonus = 0;
  let pctBonus = 0;
  for (const effect of effects) {
    if (effect.kind !== 'attackBuff' || effect.status !== 'active') continue;
    for (const stack of effect.stacks) {
      if (stack.removedAt !== undefined) continue;
      flatBonus += stack.attackFlat;
      pctBonus += stack.attackPct;
    }
  }
  flatBonus = round2(flatBonus);
  pctBonus = round2(pctBonus);
  return {
    baseAttack,
    flatBonus,
    pctBonus,
    effectiveAttack: Math.round((baseAttack + flatBonus) * (1 + pctBonus / 100)),
  };
}

function activeStacks(effect: AttackBuffInstance): AttackStack[] {
  return effect.stacks.filter((s) => s.removedAt === undefined);
}

function cloneEffects(effects: EffectInstance[]): EffectInstance[] {
  return effects.map((effect) =>
    effect.kind === 'attackBuff'
      ? { ...effect, stacks: effect.stacks.map((s) => ({ ...s })) }
      : { ...effect },
  );
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '无到期';
  return `${Math.round(ms)}ms`;
}


export function sortSchedule(schedule: TimelineEvent[]): TimelineEvent[] {
  return [...schedule]
    .sort((a, b) => a.time - b.time || a.order - b.order)
    .map((event, index) => ({ ...event, order: index }));
}

export function scheduleHash(schedule: TimelineEvent[], target: TargetConfig): string {
  const events = [...schedule]
    .sort((a, b) => a.time - b.time || a.order - b.order)
    .map(({ id: _id, ...rest }) => rest);
  const text = JSON.stringify({ target, events });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${RULES_VERSION}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** 供测试与验证使用的稳定状态摘要（不包含时间，便于比较不同 horizon 的结果）。 */
export function stateFingerprint(state: SimState): string {
  return JSON.stringify({
    hp: round2(state.hp),
    damageTaken: round2(state.damageTaken),
    attack: state.attack,
    shieldTotal: round2(state.shieldTotal),
    dead: state.dead,
    effects: state.effects
      .filter((effect) => effect.status === 'active')
      .map((effect) => {
        if (effect.kind === 'attackBuff') {
          return {
            kind: effect.kind,
            source: effect.source,
            stacks: effect.stacks
              .filter((s) => s.removedAt === undefined)
              .map((s) => ({
                flat: round2(s.attackFlat),
                pct: round2(s.attackPct),
                expiresAt: s.expiresAt,
              })),
          };
        }
        if (effect.kind === 'periodicDamage') {
          return {
            kind: effect.kind,
            source: effect.source,
            nextTickAt: effect.nextTickAt,
            expiresAt: effect.expiresAt,
            tickDamage: round2(effect.tickDamage),
          };
        }
        return {
          kind: effect.kind,
          source: effect.source,
          remaining: round2(effect.remaining),
          expiresAt: effect.expiresAt,
        };
      }),
  });
}

class Simulator {
  private readonly target: TargetConfig;
  private readonly horizonMs: number;
  private time = 0;
  private hp: number;
  private damageTaken = 0;
  private effects: EffectInstance[] = [];
  private records: SettlementRecord[] = [];
  private sequence = 0;
  private dead = false;
  private deadAt: number | null = null;

  constructor(target: TargetConfig, options: SimulationOptions) {
    this.target = { ...target };
    this.horizonMs = options.horizonMs;
    this.hp = round2(target.maxHp);
    if (target.initialShield > 0) {
      this.sequence += 1;
      this.effects.push({
        id: 'initial-shield',
        kind: 'shield',
        source: '初始护盾',
        sequence: this.sequence,
        status: 'active',
        appliedAt: 0,
        // 初始护盾没有持续时间，只有被击穿或驱散才结束。
        expiresAt: Number.POSITIVE_INFINITY,
        absorb: target.initialShield,
        remaining: target.initialShield,
      });
    }
  }

  private snapshot(): SimState {
    return {
      time: this.time,
      hp: round2(this.hp),
      maxHp: this.target.maxHp,
      damageTaken: round2(this.damageTaken),
      attack: attackBreakdown(this.target.baseAttack, this.effects),
      shieldTotal: round2(
        this.effects
          .filter((e): e is ShieldInstance => e.kind === 'shield' && e.status === 'active')
          .reduce((sum, e) => sum + e.remaining, 0),
      ),
      effects: cloneEffects(this.effects),
      dead: this.dead,
      deadAt: this.deadAt,
    };
  }

  private push(
    kind: SettlementCategory,
    text: string,
    before: SimState,
    delta: Record<string, number | string> = {},
    extra: Pick<SettlementRecord, 'eventId' | 'effectId'> = {},
  ): void {
    this.records.push({
      seq: this.records.length,
      time: this.time,
      kind,
      text,
      before,
      after: this.snapshot(),
      delta,
      ...extra,
    });
  }

  private endEffect(effect: EffectInstance, reason: EndReason): void {
    effect.status = reason === 'expired' ? 'expired' : reason;
    effect.endedAt = this.time;
    effect.endReason = reason;
  }

  /** ① 到期清理。必须在本时刻用户事件之前执行。 */
  private expireDue(): void {
    for (const effect of this.effects) {
      if (effect.status !== 'active') continue;

      if (effect.kind === 'attackBuff') {
        for (const stack of effect.stacks) {
          if (stack.removedAt !== undefined || stack.expiresAt > this.time) continue;
          const before = this.snapshot();
          stack.removedAt = this.time;
          stack.removedReason = 'expired';
          const stacksLeft = activeStacks(effect).length;
          if (stacksLeft === 0) this.endEffect(effect, 'expired');
          this.push(
            'expire',
            `攻击加成 [${effect.source}] 一层到期（${formatMs(stack.expiresAt)}），按剩余层数恢复`,
            before,
            {
              source: effect.source,
              stackId: stack.id,
              flat: stack.attackFlat,
              pct: stack.attackPct,
              stacksLeft,
            },
            { effectId: effect.id },
          );
        }
        continue;
      }

      if (effect.kind === 'periodicDamage' && effect.expiresAt <= this.time) {
        const before = this.snapshot();
        const boundaryTick = effect.nextTickAt <= this.time;
        this.endEffect(effect, 'expired');
        this.push(
          'expire',
          `周期伤害 [${effect.source}] 到期，先移除效果${boundaryTick ? '；本时刻的跳数不再触发' : ''}`,
          before,
          {
            source: effect.source,
            expiresAt: effect.expiresAt,
            nextTickAt: effect.nextTickAt,
            skippedTick: boundaryTick ? 1 : 0,
          },
          { effectId: effect.id },
        );
        if (boundaryTick) {
          this.push(
            'skipped',
            `到期边界：周期伤害 [${effect.source}] 的第 ${effect.tickCount + 1} 跳被跳过（效果已先移除）`,
            this.snapshot(),
            {
              source: effect.source,
              reason: '到期边界',
              scheduledAt: effect.nextTickAt,
            },
            { effectId: effect.id },
          );
        }
        continue;
      }

      if (effect.kind === 'shield' && effect.expiresAt <= this.time) {
        const before = this.snapshot();
        const remaining = effect.remaining;
        this.endEffect(effect, 'expired');
        this.push(
          'expire',
          `护盾 [${effect.source}] 到期，剩余 ${round2(remaining)} 点吸收量移除；不扣生命`,
          before,
          { source: effect.source, remaining: round2(remaining), hpLost: 0 },
          { effectId: effect.id },
        );
      }
    }
  }

  private applyEffect(event: ApplyEffectEvent): void {
    const before = this.snapshot();
    if (this.dead) {
      this.push('skipped', `目标已死亡，施加 [${event.source}] 被跳过`, before, {
        source: event.source,
        reason: '目标已死亡',
      }, { eventId: event.id });
      return;
    }

    this.sequence += 1;
    const sequence = this.sequence;

    if (event.effectKind === 'attackBuff') {
      const existing = this.effects.find(
        (e): e is AttackBuffInstance =>
          e.kind === 'attackBuff' && e.source === event.source && e.status === 'active',
      );
      const duration = event.durationMs ?? 8000;
      const stack: AttackStack = {
        id: `${event.id}#L${sequence}`,
        sequence,
        appliedAt: this.time,
        expiresAt: this.time + duration,
        attackFlat: event.attackFlat ?? 0,
        attackPct: event.attackPct ?? 0,
      };
      if (existing) {
        const active = activeStacks(existing);
        if (active.length >= MAX_ATTACK_STACKS) {
          const oldest = active.reduce((a, b) =>
            a.expiresAt < b.expiresAt || (a.expiresAt === b.expiresAt && a.sequence < b.sequence) ? a : b,
          );
          oldest.expiresAt = this.time + duration;
          existing.lastRefreshAt = this.time;
          this.push(
            'refresh',
            `攻击加成 [${event.source}] 已满 ${MAX_ATTACK_STACKS} 层，不新增层；刷新最早到期的一层（沿用原数值）至 ${formatMs(oldest.expiresAt)}`,
            before,
            {
              source: event.source,
              stackId: oldest.id,
              stacks: active.length,
              expiresAt: oldest.expiresAt,
              note: '满层重施=刷新，避免层数与数值失控',
            },
            { eventId: event.id, effectId: existing.id },
          );
          return;
        }
        existing.stacks.push(stack);
        existing.lastRefreshAt = this.time;
        this.push(
          'stack',
          `攻击加成 [${event.source}] 叠至 ${active.length + 1} 层，新层到期 ${formatMs(stack.expiresAt)}（各层独立到期）`,
          before,
          {
            source: event.source,
            stackId: stack.id,
            stacks: active.length + 1,
            expiresAt: stack.expiresAt,
            flat: stack.attackFlat,
            pct: stack.attackPct,
          },
          { eventId: event.id, effectId: existing.id },
        );
        return;
      }
      const instance: AttackBuffInstance = {
        id: `buff-${event.id}-${sequence}`,
        kind: 'attackBuff',
        source: event.source,
        sequence,
        stacks: [stack],
        status: 'active',
        appliedAt: this.time,
        lastRefreshAt: this.time,
      };
      this.effects.push(instance);
      this.push(
        'apply',
        `施加攻击加成 [${event.source}] 1 层（+${stack.attackFlat} 固定 / +${stack.attackPct}%），到期 ${formatMs(stack.expiresAt)}`,
        before,
        {
          source: event.source,
          stacks: 1,
          expiresAt: stack.expiresAt,
          flat: stack.attackFlat,
          pct: stack.attackPct,
        },
        { eventId: event.id, effectId: instance.id },
      );
      return;
    }

    if (event.effectKind === 'periodicDamage') {
      const existing = this.effects.find(
        (e): e is PeriodicDamageInstance =>
          e.kind === 'periodicDamage' && e.source === event.source && e.status === 'active',
      );
      const interval = event.intervalMs ?? 1000;
      const duration = event.durationMs ?? 6000;
      if (existing) {
        // 只刷新到期时间；nextTickAt 不变，保留原有触发节奏。
        existing.refreshedAt = this.time;
        existing.expiresAt = this.time + duration;
        this.push(
          'refresh',
          `周期伤害 [${event.source}] 重施：只刷新到期至 ${formatMs(existing.expiresAt)}；下一跳仍为 ${formatMs(existing.nextTickAt)}`,
          before,
          {
            source: event.source,
            expiresAt: existing.expiresAt,
            nextTickAt: existing.nextTickAt,
            tickDamage: round2(existing.tickDamage),
            note: '重施不重置节奏，也不改变每跳数值',
          },
          { eventId: event.id, effectId: existing.id },
        );
        return;
      }
      const instance: PeriodicDamageInstance = {
        id: `dot-${event.id}-${sequence}`,
        kind: 'periodicDamage',
        source: event.source,
        sequence,
        status: 'active',
        appliedAt: this.time,
        refreshedAt: this.time,
        intervalMs: interval,
        tickDamage: event.tickDamage ?? 0,
        expiresAt: this.time + duration,
        nextTickAt: this.time + interval,
        tickCount: 0,
      };
      this.effects.push(instance);
      this.push(
        'apply',
        `施加周期伤害 [${event.source}]，第一跳在 ${formatMs(instance.nextTickAt)}，到期 ${formatMs(instance.expiresAt)}`,
        before,
        {
          source: event.source,
          nextTickAt: instance.nextTickAt,
          expiresAt: instance.expiresAt,
          tickDamage: round2(instance.tickDamage),
        },
        { eventId: event.id, effectId: instance.id },
      );
      return;
    }

    const absorb = event.absorb ?? 0;
    const duration = event.durationMs ?? 5000;
    const instance: ShieldInstance = {
      id: `shield-${event.id}-${sequence}`,
      kind: 'shield',
      source: event.source,
      sequence,
      status: 'active',
      appliedAt: this.time,
      expiresAt: this.time + duration,
      absorb,
      remaining: absorb,
    };
    this.effects.push(instance);
    this.push(
      'apply',
      `施加护盾 [${event.source}] ${round2(absorb)} 点，到期 ${formatMs(instance.expiresAt)}`,
      before,
      {
        source: event.source,
        absorb: round2(absorb),
        expiresAt: instance.expiresAt,
      },
      { eventId: event.id, effectId: instance.id },
    );
  }

  private dispel(event: DispelEvent): void {
    const before = this.snapshot();
    if (this.dead) {
      this.push('skipped', `目标已死亡，驱散 [${event.source}] 被跳过`, before, {
        source: event.source,
        reason: '目标已死亡',
      }, { eventId: event.id });
      return;
    }
    const matched = this.effects.filter(
      (e) => e.kind === event.effectKind && e.source === event.source && e.status === 'active',
    );
    if (matched.length === 0) {
      this.push('skipped', `驱散 [${event.source}]：该来源没有生效中的效果`, before, {
        source: event.source,
        reason: '来源无生效效果',
      }, { eventId: event.id });
      return;
    }
    for (const effect of matched) {
      const effectBefore = this.snapshot();
      if (effect.kind === 'attackBuff') {
        let removed = 0;
        for (const stack of effect.stacks) {
          if (stack.removedAt === undefined) {
            stack.removedAt = this.time;
            stack.removedReason = 'dispelled';
            removed += 1;
          }
        }
        this.endEffect(effect, 'dispelled');
        this.push(
          'dispel',
          `驱散攻击加成 [${effect.source}] 全部 ${removed} 层，攻击按剩余效果恢复`,
          effectBefore,
          { source: effect.source, removed, reason: '仅移除选定来源' },
          { eventId: event.id, effectId: effect.id },
        );
      } else if (effect.kind === 'periodicDamage') {
        this.endEffect(effect, 'dispelled');
        this.push(
          'dispel',
          `驱散周期伤害 [${effect.source}]，原定 ${formatMs(effect.nextTickAt)} 的跳数取消`,
          effectBefore,
          { source: effect.source, nextTickAt: effect.nextTickAt, reason: '仅移除选定来源' },
          { eventId: event.id, effectId: effect.id },
        );
      } else {
        const remaining = effect.remaining;
        effect.remaining = 0;
        this.endEffect(effect, 'dispelled');
        this.push(
          'dispel',
          `驱散护盾 [${effect.source}]，剩余 ${round2(remaining)} 点吸收量移除；不扣生命`,
          effectBefore,
          { source: effect.source, remaining: round2(remaining), hpLost: 0, reason: '仅移除选定来源' },
          { eventId: event.id, effectId: effect.id },
        );
      }
    }
  }

  private dealDamage(
    amount: number,
    eventId?: string,
    context: { trigger?: string; effectId?: string } = {},
  ): void {
    const cleanAmount = round2(amount);
    if (cleanAmount <= EPS) return;
    let remaining = cleanAmount;
    const shields = this.effects
      .filter(
        (e): e is ShieldInstance =>
          e.kind === 'shield' && e.status === 'active' && e.remaining > EPS,
      )
      .sort((a, b) => a.expiresAt - b.expiresAt || a.sequence - b.sequence);
    const absorbedParts: string[] = [];
    let totalAbsorbed = 0;

    for (const shield of shields) {
      if (remaining <= EPS) break;
      const before = this.snapshot();
      const absorbed = round2(Math.min(shield.remaining, remaining));
      shield.remaining = round2(shield.remaining - absorbed);
      remaining = round2(remaining - absorbed);
      totalAbsorbed = round2(totalAbsorbed + absorbed);
      absorbedParts.push(`${shield.source} ${absorbed}`);
      this.push(
        'shieldAbsorb',
        `伤害 ${cleanAmount}：护盾 [${shield.source}] 按到期次序吸收 ${absorbed}，剩余吸收量 ${round2(shield.remaining)}`,
        before,
        {
          source: shield.source,
          absorbed,
          remainingInShield: round2(shield.remaining),
          expiresAt: shield.expiresAt,
          incoming: cleanAmount,
        },
        { eventId, effectId: shield.id },
      );
      if (shield.remaining <= EPS) {
        const breakBefore = this.snapshot();
        shield.remaining = 0;
        this.endEffect(shield, 'depleted');
        this.push(
          'shieldBreak',
          `护盾 [${shield.source}] 耗尽，后续伤害转向下一护盾或生命`,
          breakBefore,
          { source: shield.source, hpLost: 0 },
          { eventId, effectId: shield.id },
        );
      }
    }

    const hpBefore = this.snapshot();
    if (remaining > EPS) {
      const actual = round2(Math.min(remaining, this.hp));
      this.hp = round2(this.hp - actual);
      this.damageTaken = round2(this.damageTaken + actual);
      this.push(
        'damage',
        absorbedParts.length
          ? `护盾吸收 ${totalAbsorbed} 后，剩余 ${remaining} 点伤害扣除生命 ${actual}`
          : `伤害 ${cleanAmount} 点扣除生命 ${actual}`,
        hpBefore,
        {
          incoming: cleanAmount,
          absorbed: totalAbsorbed,
          hpLost: actual,
          overflow: round2(remaining - actual),
          absorbedBy: absorbedParts.join('，') || '无护盾',
          ...(context.trigger ? { trigger: context.trigger } : {}),
        },
        { eventId, effectId: context.effectId },
      );
      if (this.hp <= EPS) {
        this.hp = 0;
        this.dead = true;
        this.deadAt = this.time;
        this.push(
          'death',
          '生命降至 0，目标死亡；此后的伤害/施加被跳过，到期清理仍会记录',
          this.snapshot(),
          { deadAt: this.time, ...(context.trigger ? { trigger: context.trigger } : {}) },
          { eventId },
        );
      }
    } else {
      this.push(
        'damage',
        `伤害 ${cleanAmount} 全部被护盾吸收（${absorbedParts.join('，')}），生命不变`,
        hpBefore,
        {
          incoming: cleanAmount,
          absorbed: totalAbsorbed,
          hpLost: 0,
          absorbedBy: absorbedParts.join('，'),
          ...(context.trigger ? { trigger: context.trigger } : {}),
        },
        { eventId, effectId: context.effectId },
      );
    }
  }

  private handleEvent(event: TimelineEvent): void {
    if (event.kind === 'apply') this.applyEffect(event);
    else if (event.kind === 'dispel') this.dispel(event);
    else {
      const before = this.snapshot();
      if (this.dead) {
        this.push('skipped', `目标已死亡，伤害 ${round2((event as DamageEvent).amount)} 被跳过`, before, {
          reason: '目标已死亡',
        }, { eventId: event.id });
        return;
      }
      if (round2((event as DamageEvent).amount) <= 0) {
        this.push('skipped', `伤害为 ${round2((event as DamageEvent).amount)}，没有可结算的伤害`, before, {
          reason: '伤害不大于 0',
        }, { eventId: event.id });
        return;
      }
      this.dealDamage((event as DamageEvent).amount, event.id);
    }
  }

  /** ③ 周期伤害跳数。在用户事件之后执行，因此同刻驱散可取消本跳。 */
  private tickDue(): void {
    const dots = this.effects
      .filter(
        (e): e is PeriodicDamageInstance =>
          e.kind === 'periodicDamage' && e.status === 'active' && e.nextTickAt <= this.time,
      )
      .sort((a, b) => a.nextTickAt - b.nextTickAt || a.sequence - b.sequence);

    for (const dot of dots) {
      const scheduled = dot.nextTickAt;
      if (this.dead) {
        const before = this.snapshot();
        dot.nextTickAt = scheduled + dot.intervalMs;
        this.push(
          'skipped',
          `目标已死亡，周期伤害 [${dot.source}] 原定 ${formatMs(scheduled)} 的跳数被跳过`,
          before,
          { source: dot.source, reason: '目标已死亡', scheduledAt: scheduled },
          { effectId: dot.id },
        );
        continue;
      }
      const before = this.snapshot();
      dot.tickCount += 1;
      dot.nextTickAt = scheduled + dot.intervalMs;
      this.push(
        'tick',
        `周期伤害 [${dot.source}] 第 ${dot.tickCount} 跳 ${round2(dot.tickDamage)}（下一次 ${formatMs(dot.nextTickAt)}）`,
        before,
        {
          source: dot.source,
          tick: dot.tickCount,
          tickDamage: round2(dot.tickDamage),
          nextTickAt: dot.nextTickAt,
        },
        { effectId: dot.id },
      );
      this.dealDamage(dot.tickDamage, undefined, {
        trigger: `${dot.source} 第 ${dot.tickCount} 跳`,
        effectId: dot.id,
      });
    }
  }

  /** 计算下一个需要结算的时刻；动态生成，刷新延长到期后也不会漏掉后续跳数。 */
  private nextTime(eventsByTime: Map<number, TimelineEvent[]>): number | null {
    let next: number | null = null;
    const consider = (t: number): void => {
      if (t > this.time && t <= this.horizonMs && (next === null || t < next)) next = t;
    };
    for (const effect of this.effects) {
      if (effect.status !== 'active') continue;
      if (effect.kind === 'attackBuff') {
        for (const stack of effect.stacks) {
          if (stack.removedAt === undefined) consider(stack.expiresAt);
        }
      } else {
        consider(effect.expiresAt);
        if (effect.kind === 'periodicDamage') consider(effect.nextTickAt);
      }
    }
    for (const t of eventsByTime.keys()) consider(t);
    return next;
  }

  private buildLifetimes(): EffectLifetime[] {
    const rows: EffectLifetime[] = [];
    const markerRecords = this.records.filter((r) => r.effectId !== undefined);
    for (const effect of this.effects) {
      const markers = markerRecords
        .filter((r) =>
          r.effectId === effect.id &&
          ['tick', 'skipped', 'shieldAbsorb', 'shieldBreak', 'refresh'].includes(r.kind),
        )
        .map((r) => ({
          recordSeq: r.seq,
          time: r.time,
          kind:
            r.kind === 'tick'
              ? ('tick' as const)
              : r.kind === 'skipped'
                ? ('skipped' as const)
                : r.kind === 'refresh'
                  ? ('refresh' as const)
                  : r.kind === 'shieldBreak'
                    ? ('exhausted' as const)
                    : ('absorb' as const),
          label: r.text,
        }));

      if (effect.kind === 'attackBuff') {
        effect.stacks.forEach((stack, index) => {
          const removed = stack.removedAt !== undefined;
          const end = removed ? stack.removedAt! : Math.min(stack.expiresAt, this.horizonMs);
          rows.push({
            key: `${effect.id}#${stack.id}`,
            effectId: effect.id,
            kind: effect.kind,
            source: effect.source,
            label: `${effect.source} · ${index + 1}层 @${formatMs(stack.appliedAt)}`,
            stackId: stack.id,
            start: stack.appliedAt,
            end,
            endReason: removed
              ? stack.removedReason ?? 'expired'
              : stack.expiresAt <= this.horizonMs
                ? 'expired'
                : 'horizon',
            markers: [],
          });
        });
        continue;
      }

      if (effect.kind === 'periodicDamage') {
        const end = effect.endedAt ?? Math.min(effect.expiresAt, this.horizonMs);
        rows.push({
          key: effect.id,
          effectId: effect.id,
          kind: effect.kind,
          source: effect.source,
          label: effect.source,
          start: effect.appliedAt,
          end,
          endReason: effect.endReason ?? (effect.expiresAt <= this.horizonMs ? 'expired' : 'horizon'),
          markers,
        });
        continue;
      }

      const end = effect.endedAt ?? Math.min(effect.expiresAt, this.horizonMs);
      rows.push({
        key: effect.id,
        effectId: effect.id,
        kind: effect.kind,
        source: effect.source,
        label: effect.source,
        start: effect.appliedAt,
        end,
        endReason: effect.endReason ?? (effect.expiresAt <= this.horizonMs ? 'expired' : 'horizon'),
        markers,
      });
    }
    return rows.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  }

  run(schedule: TimelineEvent[]): SimulationResult {
    const initialState = this.snapshot();
    const events = [...schedule].sort((a, b) => a.time - b.time || a.order - b.order);
    const eventsByTime = new Map<number, TimelineEvent[]>();
    for (const event of events) {
      if (event.time < 0 || event.time > this.horizonMs) continue;
      const bucket = eventsByTime.get(event.time) ?? [];
      bucket.push(event);
      eventsByTime.set(event.time, bucket);
    }

    // 从 0 开始：即使 0ms 没有事件，也保证初始快照时间为 0。
    let time: number | null = 0;
    while (time !== null) {
      this.time = time;
      // ① 到期清理
      this.expireDue();
      // ② 用户事件（同刻按 order）
      const due = eventsByTime.get(time) ?? [];
      for (const event of due) this.handleEvent(event);
      // ③ 周期伤害
      this.tickDue();
      time = this.nextTime(eventsByTime);
    }

    this.time = this.horizonMs;
    return {
      scheduleHash: scheduleHash(schedule, this.target),
      schedule: events,
      target: this.target,
      records: this.records,
      initialState,
      finalState: this.snapshot(),
      lifetimes: this.buildLifetimes(),
      horizonMs: this.horizonMs,
      dead: this.dead,
    };
  }
}

export function simulate(
  schedule: TimelineEvent[],
  target: TargetConfig = DEFAULT_TARGET,
  options: SimulationOptions = DEFAULT_OPTIONS,
): SimulationResult {
  return new Simulator(target, options).run(schedule);
}

/** 定位到某时刻结算完成后的状态（同一时刻的所有结算都已应用）。 */
export function stateAtTime(result: SimulationResult, time: number): SimState {
  let state = result.initialState;
  for (const record of result.records) {
    if (record.time > time) break;
    state = record.after;
  }
  return state;
}

/** 某时刻结算前的状态。 */
export function stateBeforeTime(result: SimulationResult, time: number): SimState {
  let state = result.initialState;
  for (const record of result.records) {
    if (record.time >= time) break;
    state = record.after;
  }
  return state;
}

/** 记录游标 → 状态。游标 -1 表示初始状态。 */
export function stateAtIndex(result: SimulationResult, index: number): SimState {
  if (index < 0 || result.records.length === 0) return result.initialState;
  return result.records[Math.min(index, result.records.length - 1)].after;
}

export function indexAtTime(result: SimulationResult, time: number): number {
  let index = -1;
  for (let i = 0; i < result.records.length; i += 1) {
    if (result.records[i].time > time) break;
    index = i;
  }
  return index;
}

