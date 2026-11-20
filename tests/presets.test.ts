import { describe, expect, it } from 'vitest';
import { BONE_COUNT } from '../src/weights/WeightModel';
import { blendWeights, buildInitialWeights, PRESETS, smoothstep } from '../src/weights/presets';

const LENGTH = 6;

describe('smoothstep', () => {
  it('端点与中点取值正确且单调', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});

describe('blendWeights 归一与归属', () => {
  it('任意位置、任意预设宽度下权重和恒为 1 且非负', () => {
    for (const preset of Object.values(PRESETS)) {
      for (let i = 0; i <= 60; i++) {
        const x = (i / 60) * LENGTH;
        const w = blendWeights(x, LENGTH, preset.blendWidth);
        expect(w).toHaveLength(BONE_COUNT);
        for (const v of w) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      }
    }
  });

  it('带起点完全属于骨骼0,带末端完全属于骨骼2', () => {
    const head = blendWeights(0, LENGTH, PRESETS.default.blendWidth);
    expect(head[0]).toBeCloseTo(1);
    expect(head[1]).toBeCloseTo(0);
    expect(head[2]).toBeCloseTo(0);

    const tail = blendWeights(LENGTH, LENGTH, PRESETS.default.blendWidth);
    expect(tail[0]).toBeCloseTo(0);
    expect(tail[1]).toBeCloseTo(0);
    expect(tail[2]).toBeCloseTo(1);
  });

  it('肘部预设过渡带更窄:关节附近中间骨骼的主导区间比尾部预设短', () => {
    const j1 = LENGTH / 3;
    const probe = j1 + 0.5;
    const elbow = blendWeights(probe, LENGTH, PRESETS.elbow.blendWidth);
    const tail = blendWeights(probe, LENGTH, PRESETS.tail.blendWidth);
    // 窄过渡(肘部)在关节外侧已经快速倒向骨骼1;宽过渡(尾部)仍保留大量骨骼0
    expect(elbow[1]).toBeGreaterThan(tail[1]);
    expect(tail[0]).toBeGreaterThan(elbow[0]);
  });
});

describe('buildInitialWeights', () => {
  it('输出扁平数组长度与顶点数匹配且逐顶点归一', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6];
    const data = buildInitialWeights(xs, LENGTH);
    expect(data).toHaveLength(xs.length * BONE_COUNT);
    for (let v = 0; v < xs.length; v++) {
      const s = data[v * 3] + data[v * 3 + 1] + data[v * 3 + 2];
      expect(s).toBeCloseTo(1);
    }
  });
});
