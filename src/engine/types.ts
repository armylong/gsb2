/**
 * 结算模拟器的领域类型。
 *
 * 时间统一使用「毫秒」，绝对时间从 0 开始。事件和效果都按 (time, order) 排序，
 * order 是用户在事件表中看到的固定顺序，同一时刻内不会因插入/删除而改变相对次序。
 */

export type EffectKind = 'attackBuff' | 'periodicDamage' | 'shield';

export type EventKind = 'apply' | 'dispel' | 'damage';

export interface BaseEvent {
  /** 稳定的唯一 id，同时用于同一时刻的次序排序。 */
  id: string;
  /** 绝对时间，毫秒，0..30000。 */
  time: number;
  /** 同一时刻内的稳定结算顺序；由时间表维护。 */
  order: number;
  /** 事件说明，仅用于展示。 */
  label?: string;
}

export interface ApplyEffectEvent extends BaseEvent {
  kind: 'apply';
  effectKind: EffectKind;
  /** source 是来源标识；同来源重施会刷新而非叠加。 */
  source: string;
  /** 以下字段按效果类型使用。 */
  attackFlat?: number;
  attackPct?: number;
  /** 每一层的持续时间（毫秒），各层独立到期。 */
  durationMs?: number;
  /** 周期伤害的间隔（毫秒）。 */
  intervalMs?: number;
  /** 周期伤害每一跳的数值（施加时快照，刷新不改变）。 */
  tickDamage?: number;
  /** 护盾吸收量（施加时快照）。 */
  absorb?: number;
}

export interface DispelEvent extends BaseEvent {
  kind: 'dispel';
  effectKind: EffectKind;
  /** 只移除该来源的实例。 */
  source: string;
}

export interface DamageEvent extends BaseEvent {
  kind: 'damage';
  amount: number;
  source?: string;
}

export type TimelineEvent = ApplyEffectEvent | DispelEvent | DamageEvent;

export interface TargetConfig {
  maxHp: number;
  baseAttack: number;
  initialShield: number;
}

export type EffectStatus = 'active' | 'expired' | 'dispelled' | 'depleted';

export type EndReason = 'expired' | 'dispelled' | 'depleted';

export interface AttackStack {
  /** 单层 id，独立到期。 */
  id: string;
  /** 全模拟唯一的施加序号，决定同刻结算次序。 */
  sequence: number;
  appliedAt: number;
  expiresAt: number;
  removedAt?: number;
  removedReason?: 'expired' | 'dispelled';
  attackFlat: number;
  attackPct: number;
}

export interface AttackBuffInstance {
  id: string;
  kind: 'attackBuff';
  source: string;
  sequence: number;
  stacks: AttackStack[];
  status: EffectStatus;
  appliedAt: number;
  lastRefreshAt: number;
  endedAt?: number;
  endReason?: EndReason;
}

export interface PeriodicDamageInstance {
  id: string;
  kind: 'periodicDamage';
  source: string;
  sequence: number;
  status: EffectStatus;
  appliedAt: number;
  /** 最近一次重施时间（只刷新持续时间）。 */
  refreshedAt: number;
  intervalMs: number;
  tickDamage: number;
  expiresAt: number;
  nextTickAt: number;
  tickCount: number;
  endedAt?: number;
  endReason?: EndReason;
}

export interface ShieldInstance {
  id: string;
  kind: 'shield';
  source: string;
  sequence: number;
  status: EffectStatus;
  appliedAt: number;
  expiresAt: number;
  absorb: number;
  remaining: number;
  endedAt?: number;
  endReason?: EndReason;
}

export type EffectInstance = AttackBuffInstance | PeriodicDamageInstance | ShieldInstance;

export interface AttackBreakdown {
  baseAttack: number;
  /** 生效层数的固定值之和。 */
  flatBonus: number;
  /** 生效层数的百分比之和。 */
  pctBonus: number;
  effectiveAttack: number;
}

/** 某一时刻的完整目标状态快照（含效果实例副本），用于回看与前后对比。 */
export interface SimState {
  time: number;
  hp: number;
  maxHp: number;
  /** 实际扣除的生命总和（护盾吸收与护盾到期都不会计入）。 */
  damageTaken: number;
  attack: AttackBreakdown;
  shieldTotal: number;
  effects: EffectInstance[];
  dead: boolean;
  deadAt: number | null;
}

export type SettlementCategory =
  | 'apply'
  | 'stack'
  | 'refresh'
  | 'tick'
  | 'shieldAbsorb'
  | 'shieldBreak'
  | 'damage'
  | 'death'
  | 'dispel'
  | 'expire'
  | 'skipped';

export interface SettlementRecord {
  /** 结算序号，从 0 递增，用于稳定排序和回放。 */
  seq: number;
  time: number;
  /** 关联的用户事件 id（若有）。 */
  eventId?: string;
  /** 关联的效果实例 id（若有）。 */
  effectId?: string;
  kind: SettlementCategory;
  /** 人类可读说明与原因。 */
  text: string;
  /** 该条记录执行前后的数值快照。 */
  before: SimState;
  after: SimState;
  /** 更细的分解，例如吸收明细、跳数、到期跳过的说明。 */
  delta: Record<string, number | string>;
}

export interface EffectLifetime {
  /** 时间线行内唯一 key。 */
  key: string;
  effectId: string;
  kind: EffectKind;
  source: string;
  label: string;
  /** 攻击加成层的 id；其他效果为空。 */
  stackId?: string;
  start: number;
  /** Infinity 表示没有定时到期（初始护盾）。 */
  end: number;
  endReason?: 'expired' | 'dispelled' | 'depleted' | 'horizon';
  markers: {
    /** 关联的结算记录序号。 */
    recordSeq: number;
    time: number;
    kind: 'tick' | 'skipped' | 'absorb' | 'exhausted' | 'refresh';
    label: string;
  }[];
}

export interface SimulationOptions {
  /** 模拟总时长，默认 30000ms。 */
  horizonMs: number;
}

export interface SimulationResult {
  /** 事件表与目标配置的指纹；用于防止旧结果冒充新时间表。 */
  scheduleHash: string;
  schedule: TimelineEvent[];
  target: TargetConfig;
  records: SettlementRecord[];
  initialState: SimState;
  finalState: SimState;
  lifetimes: EffectLifetime[];
  horizonMs: number;
  dead: boolean;
}
