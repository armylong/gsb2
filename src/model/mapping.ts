import {
  BlockReason,
  BlockedVariant,
  MAX_VELOCITY,
  MIN_VELOCITY,
  Mapping,
  PlannedZone,
  RotationCounters,
  TriggerPlan,
  ValidationIssue,
  Zone,
  clampVelocity,
} from './types';

/** 命中该力度的区域，按 low 升序 */
export function coveringZones(mapping: Mapping, velocity: number): Zone[] {
  return mapping.zones
    .filter((z) => z.low <= velocity && velocity <= z.high)
    .sort((a, b) => a.low - b.low || a.high - b.high);
}

/**
 * 计算各命中区域的混合权重，权重之和恒为 1。
 * 两个区域交叉时使用等功率曲线（cos/sin），避免线性叠加在交叉中点出现响度凹陷——
 * 这正是"边缘突然变响"的常见来源之一。
 * 三个及以上区域同时命中属于非法配置，退化为归一化线性权重并由校验报错。
 */
export function crossfadeWeights(zones: Zone[], velocity: number): number[] {
  if (zones.length === 0) return [];
  if (zones.length === 1) return [1];

  if (zones.length === 2) {
    const [a, b] = zones;
    const overlapLow = Math.max(a.low, b.low);
    const overlapHigh = Math.min(a.high, b.high);
    const span = overlapHigh - overlapLow;
    if (span <= 0) {
      // 零宽相接：边界点判给低区，高区从边界之上开始
      return velocity <= overlapLow ? [1, 0] : [0, 1];
    }
    const p = (velocity - overlapLow) / span; // 0..1
    const cp = Math.min(1, Math.max(0, p));
    const wA = Math.cos((cp * Math.PI) / 2);
    const wB = Math.sin((cp * Math.PI) / 2);
    return [wA, wB];
  }

  const raw = zones.map((z) => {
    const span = z.high - z.low;
    return span <= 0 ? 1 : 1 - Math.abs(velocity - (z.low + z.high) / 2) / span;
  });
  const sum = raw.reduce((acc, w) => acc + Math.max(0, w), 0) || 1;
  return raw.map((w) => Math.max(0, w) / sum);
}

/**
 * 纯函数：为一次触发制定播放计划。
 * - 轮转选择在计划阶段确定，每次尝试都推进计数器（即使素材未就绪被拦），
 *   因此重置计数器后，相同力度序列必然得到相同的变体选择。
 * - 不直接访问音频状态：调用方通过 sampleStatus 查询函数注入就绪情况。
 */
export function planTrigger(
  mapping: Mapping,
  rawVelocity: number,
  counters: RotationCounters,
  sampleStatus: (sampleId: string) => { status: string; reason?: string },
): { plan: TriggerPlan; nextCounters: RotationCounters } {
  const velocity = clampVelocity(rawVelocity);
  const zones = coveringZones(mapping, velocity);
  const blocked: BlockedVariant[] = [];
  const planned: PlannedZone[] = [];
  const nextCounters: RotationCounters = { ...counters };

  if (zones.length === 0) {
    blocked.push({
      zoneId: '',
      variantId: '',
      sampleId: null,
      reason: 'no-zone',
      detail: `力度 ${velocity} 没有命中任何区域`,
    });
  }

  const weights = crossfadeWeights(zones, velocity);

  zones.forEach((zone, zi) => {
    const count = nextCounters[zone.id] ?? 0;
    nextCounters[zone.id] = count + 1;

    if (zone.variants.length === 0) {
      blocked.push({
        zoneId: zone.id,
        variantId: '',
        sampleId: null,
        reason: 'empty-zone',
        detail: `区域「${zone.label}」没有配置变体`,
      });
      return;
    }

    const variantIndex = count % zone.variants.length;
    const variant = zone.variants[variantIndex];
    const sample = mapping.samples.find((s) => s.id === variant.sampleId);

    if (!sample) {
      blocked.push({
        zoneId: zone.id,
        variantId: variant.id,
        sampleId: variant.sampleId,
        reason: 'sample-missing',
        detail: `变体引用的素材 ${variant.sampleId} 不存在`,
      });
      return;
    }

    const st = sampleStatus(sample.id);
    if (st.status !== 'ready') {
      const reason: BlockReason =
        st.status === 'loading'
          ? 'sample-loading'
          : st.status === 'error'
            ? 'sample-error'
            : 'sample-idle';
      blocked.push({
        zoneId: zone.id,
        variantId: variant.id,
        sampleId: sample.id,
        reason,
        detail: st.reason ?? `素材「${sample.name}」状态为 ${st.status}`,
      });
      return;
    }

    planned.push({
      zoneId: zone.id,
      zoneLabel: zone.label,
      weight: weights[zi],
      variantId: variant.id,
      variantIndex,
      sampleId: sample.id,
    });
  });

  return {
    plan: { velocity, zones: planned, blocked, blocked_: blocked.length > 0 },
    nextCounters,
  };
}

/** 对一串力度序列做计划（计数器从 0 开始），用于确定性校验/测试 */
export function planSequence(
  mapping: Mapping,
  velocities: number[],
  sampleStatus: (id: string) => { status: string; reason?: string } = () => ({ status: 'ready' }),
): TriggerPlan[] {
  let counters: RotationCounters = {};
  return velocities.map((v) => {
    const { plan, nextCounters } = planTrigger(mapping, v, counters, sampleStatus);
    counters = nextCounters;
    return plan;
  });
}

export function validateMapping(mapping: Mapping): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const zones = [...mapping.zones].sort((a, b) => a.low - b.low);

  if (mapping.maxVoices < 1) {
    issues.push({ level: 'error', message: '最大同时播放数必须 ≥ 1' });
  }

  for (const z of zones) {
    if (z.low < MIN_VELOCITY || z.high > MAX_VELOCITY || z.low > z.high) {
      issues.push({ level: 'error', zoneId: z.id, message: `区域「${z.label}」力度范围非法：${z.low}..${z.high}` });
    }
    if (z.variants.length === 0) {
      issues.push({ level: 'error', zoneId: z.id, message: `区域「${z.label}」至少需要 1 条变体` });
    }
    for (const v of z.variants) {
      if (!mapping.samples.some((s) => s.id === v.sampleId)) {
        issues.push({
          level: 'error',
          zoneId: z.id,
          message: `区域「${z.label}」的变体引用了不存在的素材 ${v.sampleId}`,
        });
      }
    }
  }

  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const lo = Math.max(zones[i].low, zones[j].low);
      const hi = Math.min(zones[i].high, zones[j].high);
      if (lo <= hi) {
        const others = zones.filter((z, k) => k !== i && k !== j && z.low <= hi && z.high >= lo);
        if (others.length > 0) {
          issues.push({
            level: 'error',
            zoneId: zones[i].id,
            message: `力度 ${lo}..${hi} 同时被三个区域覆盖，交叉区只支持两个区域`,
          });
        } else if (hi - lo > 0) {
          issues.push({
            level: 'warning',
            zoneId: zones[i].id,
            message: `区域「${zones[i].label}」与「${zones[j].label}」交叉区 ${lo}..${hi}（将等功率混合）`,
          });
        }
      }
    }
    if (i > 0) {
      const prev = zones[i - 1];
      if (prev.high + 1 < zones[i].low) {
        issues.push({
          level: 'warning',
          zoneId: zones[i].id,
          message: `力度 ${prev.high + 1}..${zones[i].low - 1} 没有任何区域覆盖，触发会被拦下`,
        });
      }
    }
  }
  return issues;
}

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  'no-zone': '无命中区域',
  'empty-zone': '区域无变体',
  'sample-missing': '素材缺失',
  'sample-loading': '素材加载中',
  'sample-idle': '素材尚未加载',
  'sample-error': '素材解码失败',
  'decode-failed': '解码失败',
  'polyphony-zero': '播放数为 0',
};
