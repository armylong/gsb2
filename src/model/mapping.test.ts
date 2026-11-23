import { describe, expect, it } from 'vitest';
import { Mapping, Sample, Zone, uid } from './types';
import {
  BLOCK_REASON_TEXT,
  coveringZones,
  crossfadeWeights,
  planSequence,
  planTrigger,
  validateMapping,
} from './mapping';

function makeSample(id: string): Sample {
  return { id, name: id, source: { kind: 'builtin', synthId: id }, gainDb: 0 };
}

function makeZone(id: string, low: number, high: number, sampleIds: string[]): Zone {
  return {
    id,
    label: id,
    low,
    high,
    variants: sampleIds.map((sid) => ({ id: uid('v'), sampleId: sid })),
  };
}

function makeMapping(zones: Zone[], samples: Sample[] = [], maxVoices = 4): Mapping {
  return {
    keyId: 'k',
    keyLabel: '键',
    triggerCode: 'Space',
    maxVoices,
    zones,
    samples: samples.length ? samples : [makeSample('a'), makeSample('b'), makeSample('c')],
  };
}

const ready = (): { status: string } => ({ status: 'ready' });

describe('coveringZones', () => {
  it('按 low 升序返回命中区域，边界含端点', () => {
    const m = makeMapping([makeZone('z1', 1, 60, ['a']), makeZone('z2', 60, 127, ['b'])]);
    expect(coveringZones(m, 1).map((z) => z.id)).toEqual(['z1']);
    expect(coveringZones(m, 127).map((z) => z.id)).toEqual(['z2']);
    expect(coveringZones(m, 60).map((z) => z.id)).toEqual(['z1', 'z2']);
    expect(coveringZones(m, 128)).toEqual([]);
  });
});

describe('crossfadeWeights', () => {
  const zones = [makeZone('lo', 1, 80, ['a']), makeZone('hi', 60, 127, ['b'])];

  it('单区域权重恒为 1', () => {
    expect(crossfadeWeights([zones[0]], 30)).toEqual([1]);
  });

  it('交叉区等功率：两端为 1/0，中点为 sqrt(0.5)，权重平方和恒为 1', () => {
    const atLow = crossfadeWeights(zones, 60);
    expect(atLow[0]).toBeCloseTo(1, 6);
    expect(atLow[1]).toBeCloseTo(0, 6);

    const atHigh = crossfadeWeights(zones, 80);
    expect(atHigh[0]).toBeCloseTo(0, 6);
    expect(atHigh[1]).toBeCloseTo(1, 6);

    for (const v of [60, 64, 70, 76, 80]) {
      const w = crossfadeWeights(zones, v);
      expect(w[0] + w[1]).toBeGreaterThanOrEqual(1); // 等功率不是线性，内部和大于 1
      expect(w[0] * w[0] + w[1] * w[1]).toBeCloseTo(1, 6);
    }
    for (const v of [64, 70, 76]) {
      expect(crossfadeWeights(zones, v).reduce((a, b) => a + b, 0)).toBeGreaterThan(1);
    }
    const mid = crossfadeWeights(zones, 70);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('零宽相接的边界点不产生突变：低区拿到全权重', () => {
    const touching = [makeZone('lo', 1, 60, ['a']), makeZone('hi', 61, 127, ['b'])];
    const w = crossfadeWeights(touching, 60);
    expect(w).toEqual([1, 0]);
  });

  it('力度被夹到 1..127', () => {
    const m = makeMapping([makeZone('z1', 1, 127, ['a'])]);
    const { plan } = planTrigger(m, 9999, {}, ready);
    expect(plan.velocity).toBe(127);
  });
});

describe('planTrigger 轮转与确定性', () => {
  it('同区域连续触发按变体顺序轮换', () => {
    const m = makeMapping([makeZone('z1', 1, 127, ['a', 'b', 'c'])]);
    const plans = planSequence(m, [50, 50, 50, 50]);
    expect(plans.map((p) => p.zones[0].variantIndex)).toEqual([0, 1, 2, 0]);
    expect(plans.every((p) => !p.blocked_)).toBe(true);
  });

  it('重置计数器后相同力度序列给出完全相同的选择', () => {
    const m = makeMapping([
      makeZone('lo', 1, 80, ['a', 'b']),
      makeZone('hi', 60, 127, ['b', 'c']),
    ]);
    const velocities = [20, 70, 110, 65, 30, 75, 70, 10];
    const run1 = planSequence(m, velocities, ready).map((p) =>
      p.zones.map((z) => `${z.zoneId}:${z.variantIndex}:${z.weight.toFixed(4)}`).join('|'),
    );
    const run2 = planSequence(m, velocities, ready).map((p) =>
      p.zones.map((z) => `${z.zoneId}:${z.variantIndex}:${z.weight.toFixed(4)}`).join('|'),
    );
    expect(run2).toEqual(run1);
  });

  it('交叉力度同时选中两个区域且权重与 crossfadeWeights 一致', () => {
    const m = makeMapping([
      makeZone('lo', 1, 80, ['a']),
      makeZone('hi', 60, 127, ['b']),
    ]);
    const [plan] = planSequence(m, [70], ready);
    expect(plan.zones).toHaveLength(2);
    const w = crossfadeWeights(m.zones, 70);
    expect(plan.zones[0].weight).toBeCloseTo(w[0], 6);
    expect(plan.zones[1].weight).toBeCloseTo(w[1], 6);
    expect(plan.zones[0].sampleId).toBe('a');
    expect(plan.zones[1].sampleId).toBe('b');
  });
});

describe('planTrigger 拦截原因', () => {
  it('力度没有命中区域 -> no-zone', () => {
    const m = makeMapping([makeZone('z1', 40, 80, ['a'])]);
    const { plan } = planTrigger(m, 20, {}, ready);
    expect(plan.blocked_).toBe(true);
    expect(plan.blocked[0].reason).toBe('no-zone');
    expect(BLOCK_REASON_TEXT[plan.blocked[0].reason]).toBeTruthy();
  });

  it('空区域 -> empty-zone', () => {
    const m = makeMapping([makeZone('z1', 1, 127, [])]);
    const { plan } = planTrigger(m, 50, {}, ready);
    expect(plan.blocked[0].reason).toBe('empty-zone');
    expect(plan.zones).toHaveLength(0);
  });

  it('素材引用缺失 -> sample-missing', () => {
    const m = makeMapping([makeZone('z1', 1, 127, ['ghost'])]);
    const { plan } = planTrigger(m, 50, {}, ready);
    expect(plan.blocked[0].reason).toBe('sample-missing');
  });

  it('素材未就绪时按状态给出原因且不出计划层', () => {
    const m = makeMapping([makeZone('z1', 1, 127, ['a'])]);
    for (const [status, reason] of [
      ['loading', 'sample-loading'],
      ['error', 'sample-error'],
      ['idle', 'sample-idle'],
    ] as const) {
      const { plan } = planTrigger(m, 50, {}, () => ({ status, reason: '详情' }));
      expect(plan.blocked_).toBe(true);
      expect(plan.blocked[0].reason).toBe(reason);
      expect(plan.blocked[0].detail).toBe('详情');
      expect(plan.zones).toHaveLength(0);
    }
  });

  it('交叉区中一个素材未就绪 -> 整体拦下，且原因可定位到具体区域', () => {
    const m = makeMapping([
      makeZone('lo', 1, 80, ['a']),
      makeZone('hi', 60, 127, ['b']),
    ]);
    const { plan } = planTrigger(m, 70, {}, (id) =>
      id === 'b' ? { status: 'loading', reason: '解码中' } : { status: 'ready' },
    );
    expect(plan.blocked_).toBe(true);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0].zoneId).toBe('hi');
    expect(plan.blocked[0].reason).toBe('sample-loading');
  });

  it('被拦下的尝试仍推进轮转计数，下一次触发不会跳过或重复变体', () => {
    const m = makeMapping([makeZone('z1', 1, 127, ['a', 'b'])]);
    let counters = {};
    const r1 = planTrigger(m, 50, counters, () => ({ status: 'loading' }));
    counters = r1.nextCounters;
    expect(r1.plan.blocked_).toBe(true);
    const r2 = planTrigger(m, 50, counters, ready);
    counters = r2.nextCounters;
    expect(r2.plan.zones[0].variantIndex).toBe(1);
    const r3 = planTrigger(m, 50, counters, ready);
    expect(r3.plan.zones[0].variantIndex).toBe(0);
  });
});

describe('validateMapping', () => {
  it('三区域重叠报 error', () => {
    const m = makeMapping([
      makeZone('a', 1, 80, ['a']),
      makeZone('b', 60, 100, ['b']),
      makeZone('c', 70, 127, ['c']),
    ]);
    const issues = validateMapping(m);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('三个区域'))).toBe(true);
  });

  it('两区域交叉给 warning，力度空洞给 warning', () => {
    const m = makeMapping([
      makeZone('a', 1, 40, ['a']),
      makeZone('b', 60, 127, ['b']),
    ]);
    const issues = validateMapping(m);
    expect(issues.some((i) => i.message.includes('没有任何区域覆盖'))).toBe(true);

    const cross = makeMapping([makeZone('a', 1, 80, ['a']), makeZone('b', 60, 127, ['b'])]);
    const ci = validateMapping(cross);
    expect(ci.some((i) => i.level === 'warning' && i.message.includes('交叉区'))).toBe(true);
    expect(ci.every((i) => i.level !== 'error')).toBe(true);
  });

  it('maxVoices < 1 报 error', () => {
    const m = makeMapping([makeZone('a', 1, 127, ['a'])], [], 0);
    expect(validateMapping(m).some((i) => i.message.includes('最大同时播放数'))).toBe(true);
  });
});
