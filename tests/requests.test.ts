/**
 * 关键验证：过期请求拒绝（只展示最新结果）。
 */
import { describe, it, expect } from 'vitest';
import { LatestGate } from '../src/requests';

describe('LatestGate：过期请求拒绝', () => {
  it('只有最新 id 被接受', () => {
    const gate = new LatestGate();
    const id1 = gate.next();
    const id2 = gate.next();
    const id3 = gate.next();
    expect(gate.isLatest(id1)).toBe(false);
    expect(gate.isLatest(id2)).toBe(false);
    expect(gate.isLatest(id3)).toBe(true);
  });

  it('模拟乱序完成：旧结果即使晚到也被丢弃', () => {
    const gate = new LatestGate();
    const ids = [gate.next(), gate.next(), gate.next()];
    const accepted: number[] = [];
    // 完成顺序：2 → 1 → 3（旧结果晚完成）
    for (const done of [ids[1], ids[0], ids[2]]) {
      if (gate.isLatest(done)) accepted.push(done);
    }
    expect(accepted).toEqual([ids[2]]);
  });

  it('新请求发起后，此前未完成的请求立即过期', () => {
    const gate = new LatestGate();
    const id1 = gate.next();
    expect(gate.isLatest(id1)).toBe(true);
    gate.next();
    expect(gate.isLatest(id1)).toBe(false);
  });
});
