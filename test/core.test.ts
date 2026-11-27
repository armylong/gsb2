import { describe, it, expect } from 'vitest';
import { runAllChecks } from '../src/lib/checks';
import { dft, retainByAmplitude, orderComponents, reconstruct, reverseTraversal } from '../src/lib/dft';
import { resampleArcLength } from '../src/lib/geometry';
import { makeCircle, makeLeaf, translatePoints } from '../src/lib/presets';
import { analyzeDeviation } from '../src/lib/deviation';

describe('内置自检（浏览器面板与本测试共用）', () => {
  for (const c of runAllChecks()) {
    it(c.name, () => {
      expect(c.pass, c.detail).toBe(true);
    });
  }
});

describe('DFT 圆链', () => {
  it('成分数量等于采样数，频率覆盖 -N/2..N/2，半径非负', () => {
    const pts = resampleArcLength(makeLeaf(200), 200, true);
    const comps = dft(pts);
    expect(comps).toHaveLength(200);
    expect(comps.every((c) => c.r >= 0)).toBe(true);
    const ks = comps.map((c) => c.k);
    expect(ks).toContain(0);
    expect(ks).toContain(-1);
    expect(ks).toContain(1);
  });

  it('保留数上限：keep 超过成分数时不报错且误差为机器精度', () => {
    const pts = resampleArcLength(makeCircle(100, 128), 128, true);
    const comps = dft(pts);
    const kept = retainByAmplitude(comps, 999);
    const rebuilt = reconstruct(orderComponents(kept, 'frequency'), 128);
    const rpt = analyzeDeviation(pts, rebuilt);
    expect(rpt.stats.maxShapeError).toBeLessThan(1e-9);
  });

  it('反向手画再反转点序后重建点一致（z(-t) 共轭关系）', () => {
    const pts = resampleArcLength(makeLeaf(128), 128, true);
    const rev = reverseTraversal(pts);
    const back = reverseTraversal(rev);
    expect(back).toEqual(pts);
  });

  it('平移图形的傅里叶系数只有 c0 改变', () => {
    const pts = resampleArcLength(makeLeaf(128), 128, true);
    const shifted = translatePoints(pts, 20, -15);
    const a = new Map(dft(pts).map((c) => [c.k, c]));
    const b = new Map(dft(shifted).map((c) => [c.k, c]));
    for (const [k, ca] of a) {
      const cb = b.get(k)!;
      if (k === 0) {
        expect(Math.hypot(cb.re - ca.re - 20, cb.im - ca.im + 15)).toBeLessThan(1e-9);
      } else {
        expect(Math.hypot(cb.re - ca.re, cb.im - ca.im)).toBeLessThan(1e-9);
      }
    }
  });
});
