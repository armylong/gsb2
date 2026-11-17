import { describe, expect, it } from 'vitest';
import { runAllChecks } from '../src/verify';

/**
 * 几何与状态验证:直接复用 src/verify.ts 中与页面内「运行验证」相同的检查,
 * 判断依据与容许误差见各 CheckResult.tolerance 及 README。
 */
describe('贴花投射几何与状态验证', () => {
  const results = runAllChecks();
  for (const r of results) {
    it(`${r.id}: ${r.name}`, () => {
      expect(r.detail).toBeTruthy();
      expect(r.pass, `${r.name} 失败: ${r.detail}`).toBe(true);
    });
  }
});
