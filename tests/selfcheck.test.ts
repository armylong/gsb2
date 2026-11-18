import { describe, expect, it } from 'vitest';
import { runAllChecks } from '../src/core/selfcheck';

describe('内置自检（每个用例都断言已知前后关系，而非只看列表非空）', () => {
  const results = runAllChecks();
  for (const r of results) {
    it(r.name, () => {
      expect(r.pass, r.detail).toBe(true);
    });
  }

  it('自检数量固定为 7 项且全部通过', () => {
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});
