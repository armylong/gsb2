import { describe, expect, it } from 'vitest';
import {
  detectOnset,
  depthFromViewZ,
  depthQuantum,
  depthStepWorld,
  geometricSchedule,
  predictedOnset,
  quantizeDepth,
  viewZFromDepth,
  worldGap,
} from '../src/core/depthMath';

describe('depthFromViewZ / viewZFromDepth', () => {
  const near = 0.1;
  const far = 100_000;

  it('maps near to 0 and far to 1 in direct mode', () => {
    expect(depthFromViewZ(near, near, far, 'direct')).toBeCloseTo(0, 12);
    expect(depthFromViewZ(far, near, far, 'direct')).toBeCloseTo(1, 12);
  });

  it('maps near to 1 and far to 0 in reversed mode', () => {
    expect(depthFromViewZ(near, near, far, 'reversed')).toBeCloseTo(1, 12);
    expect(depthFromViewZ(far, near, far, 'reversed')).toBeCloseTo(0, 12);
  });

  it('round-trips for both modes', () => {
    for (const mode of ['direct', 'reversed'] as const) {
      for (const z of [0.2, 1, 10, 1000, 50_000]) {
        const d = depthFromViewZ(z, near, far, mode);
        // 相对误差：近处 z 很小、远处 z 很大，绝对精度要求不能一刀切。
        const roundTrip = viewZFromDepth(d, near, far, mode);
        expect(Math.abs(roundTrip - z) / z).toBeLessThan(1e-7);
      }
    }
  });

  it('reversed depth is exactly 1 - direct depth for the same z', () => {
    for (const z of [0.2, 5, 500, 20_000]) {
      const direct = depthFromViewZ(z, near, far, 'direct');
      const reversed = depthFromViewZ(z, near, far, 'reversed');
      expect(reversed).toBeCloseTo(1 - direct, 12);
    }
  });
});

describe('storage quantisation', () => {
  it('fixed-point has a uniform quantum', () => {
    expect(depthQuantum(0.1, 'fixed16')).toBeCloseTo(1 / 0xffff, 15);
    expect(depthQuantum(0.9, 'fixed24')).toBeCloseTo(1 / 0xffffff, 15);
  });

  it('float32 has a much finer quantum near zero than near one', () => {
    expect(depthQuantum(1e-4, 'f32')).toBeLessThan(depthQuantum(0.9999, 'f32') / 1000);
  });

  it('fixed storage gives identical precision for direct and reversed', () => {
    const z = 10_000;
    const near = 0.1;
    const far = 1e5;
    const direct = depthStepWorld(z, near, far, 'direct', 'fixed24');
    const reversed = depthStepWorld(z, near, far, 'reversed', 'fixed24');
    expect(reversed).toBeCloseTo(direct, 12);
  });

  it('float storage is far more precise in reversed mode at depth', () => {
    const z = 10_000;
    const near = 0.1;
    const far = 1e5;
    const direct = depthStepWorld(z, near, far, 'direct', 'f32');
    const reversed = depthStepWorld(z, near, far, 'reversed', 'f32');
    expect(reversed).toBeLessThan(direct / 1000);
  });

  it('quantizes to the nearest code point', () => {
    expect(quantizeDepth(0.25, 'fixed16')).toBeCloseTo(Math.round(0.25 * 0xffff) / 0xffff, 15);
  });
});

describe('geometricSchedule', () => {
  it('keeps the exact endpoints and is strictly increasing', () => {
    const values = geometricSchedule(10, 90_000, 9);
    expect(values[0]).toBe(10);
    expect(values[values.length - 1]).toBe(90_000);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
  });

  it('is deterministic', () => {
    expect(geometricSchedule(1, 1e5, 50)).toEqual(geometricSchedule(1, 1e5, 50));
  });

  it('handles a single sample', () => {
    expect(geometricSchedule(5, 10, 1)).toEqual([5]);
  });
});

describe('predictedOnset', () => {
  const near = 0.1;
  const far = 1e5;

  it('grows with the gap ratio', () => {
    const small = predictedOnset(2e-5, near, far, 'direct', 'fixed24');
    const large = predictedOnset(3e-3, near, far, 'direct', 'fixed24');
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large as number).toBeGreaterThan(small as number);
  });

  it('is identical for direct and reversed under fixed storage', () => {
    const a = predictedOnset(1e-3, near, far, 'direct', 'fixed24');
    const b = predictedOnset(1e-3, near, far, 'reversed', 'fixed24');
    expect(a).toBeCloseTo(b as number, 9);
  });

  it('returns null when even the far plane stays precise enough', () => {
    expect(predictedOnset(1e-3, near, far, 'reversed', 'f32')).toBeNull();
  });
});

describe('detectOnset', () => {
  it('requires a sustained run above the threshold', () => {
    const samples = [
      { z: 1, ratio: 0 },
      { z: 2, ratio: 0.5 },
      { z: 3, ratio: 0 },
      { z: 4, ratio: 0.5 },
      { z: 5, ratio: 0.5 },
      { z: 6, ratio: 0.5 },
    ];
    expect(detectOnset(samples, 0.002, 3)).toBe(4);
  });

  it('returns null when the run never completes', () => {
    const samples = [
      { z: 1, ratio: 0.5 },
      { z: 2, ratio: 0.5 },
    ];
    expect(detectOnset(samples, 0.002, 3)).toBeNull();
  });

  it('treats the threshold as inclusive', () => {
    const samples = [
      { z: 1, ratio: 0.002 },
      { z: 2, ratio: 0.002 },
    ];
    expect(detectOnset(samples, 0.002, 2)).toBe(1);
  });
});

describe('worldGap', () => {
  it('scales with distance', () => {
    expect(worldGap(1e-3, 1000)).toBeCloseTo(1, 12);
  });
});
