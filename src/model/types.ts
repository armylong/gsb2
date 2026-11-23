/**
 * 采样映射领域模型 —— 全部是可序列化的纯数据，
 * 与 AudioContext / React 无关，方便单测和持久化。
 */

/** 力度取值范围 1..127（MIDI 约定，0 留给"无声"） */
export const MIN_VELOCITY = 1;
export const MAX_VELOCITY = 127;

export type SampleKind = 'builtin' | 'upload';

export interface BuiltinSource {
  kind: 'builtin';
  /** 内置合成音色 id，见 audio/synth.ts */
  synthId: string;
}

export interface UploadSource {
  kind: 'upload';
  /** IndexedDB 中 blob 的 key */
  blobId: string;
  /** 仅用于展示，如 footsteps.wav */
  fileName: string;
}

export type SampleSource = BuiltinSource | UploadSource;

export interface Sample {
  id: string;
  name: string;
  source: SampleSource;
  /** 素材自身的增益修正（dB），用于平衡不同素材的响度 */
  gainDb: number;
}

export interface ZoneVariant {
  id: string;
  sampleId: string;
}

export interface Zone {
  id: string;
  label: string;
  /** 区域下界（含） */
  low: number;
  /** 区域上界（含） */
  high: number;
  /** 轮流播放的变体，至少 1 条 */
  variants: ZoneVariant[];
}

export interface Mapping {
  keyId: string;
  keyLabel: string;
  /** 触发该键的物理按键 code，如 Space / KeyF */
  triggerCode: string;
  maxVoices: number;
  zones: Zone[];
  samples: Sample[];
}

/** 素材在运行时的就绪状态 */
export type SampleStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 触发被拦下的原因码（与 i18n 文案分离，便于单测断言） */
export type BlockReason =
  | 'no-zone'
  | 'empty-zone'
  | 'sample-missing'
  | 'sample-loading'
  | 'sample-idle'
  | 'sample-error'
  | 'decode-failed'
  | 'polyphony-zero';

export interface BlockedVariant {
  zoneId: string;
  variantId: string;
  sampleId: string | null;
  reason: BlockReason;
  detail?: string;
}

/** 一次触发计划中，某个区域被选中的变体及其混合权重 */
export interface PlannedZone {
  zoneId: string;
  zoneLabel: string;
  /** 0..1，该区域在本次混合中的权重；所有区域权重之和恒为 1 */
  weight: number;
  variantId: string;
  variantIndex: number;
  sampleId: string;
}

export interface TriggerPlan {
  velocity: number;
  zones: PlannedZone[];
  blocked: BlockedVariant[];
  /** 为 true 时不能出声（blocked 非空或没有命中区域） */
  blocked_: boolean;
}

/** 轮转计数器：zoneId -> 已触发次数（选变体用 counter % variants.length） */
export type RotationCounters = Record<string, number>;

export interface ValidationIssue {
  level: 'error' | 'warning';
  zoneId?: string;
  message: string;
}

let seq = 0;
export function uid(prefix: 'z' | 'v' | 's' | 'e' | 'voice' = 's'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function clampVelocity(v: number): number {
  if (!Number.isFinite(v)) return MIN_VELOCITY;
  return Math.min(MAX_VELOCITY, Math.max(MIN_VELOCITY, Math.round(v)));
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
