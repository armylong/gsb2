import { describe, it, expect } from 'vitest';
import { checkPointClearance, checkRouteClearance, segmentClearance } from '../src/core/collision';
import { Vec2, Rect } from '../src/core/geometry';

const ROOM = { w: 40, h: 30 };

describe('collision 圆形角色体积校验', () => {
  const obstacles: Rect[] = [{ x: 18, y: 10, w: 2, h: 10 }];

  it('圆心合法但要求保留半径间隙', () => {
    const ok = checkPointClearance({ x: 15, y: 15 }, 0.5, obstacles, ROOM.w, ROOM.h);
    expect(ok.ok).toBe(true);
    expect(ok.clearance).toBeGreaterThanOrEqual(0.5);

    // 中心线离墙 0.6: r=0.2 合法, r=0.8 非法(圆心 x=17.4, 墙边 x=18)
    const close: Vec2 = { x: 17.4, y: 15 };
    expect(checkPointClearance(close, 0.2, obstacles, ROOM.w, ROOM.h).ok).toBe(true);
    const big = checkPointClearance(close, 0.8, obstacles, ROOM.w, ROOM.h);
    expect(big.ok).toBe(false);
    expect(big.clearance).toBeCloseTo(0.6, 6);
  });

  it('房间边界同样按半径判定', () => {
    expect(checkPointClearance({ x: 0.5, y: 15 }, 0.4, obstacles, ROOM.w, ROOM.h).ok).toBe(true);
    const edge = checkPointClearance({ x: 0.5, y: 15 }, 0.8, obstacles, ROOM.w, ROOM.h);
    expect(edge.ok).toBe(false);
    expect(edge.reason).toContain('边界');
  });

  it('折线穿障时返回违例点与段号', () => {
    const route: Vec2[] = [
      { x: 5, y: 15 },
      { x: 19, y: 15 },
      { x: 35, y: 15 },
    ];
    const res = checkRouteClearance(route, 0.3, obstacles, ROOM.w, ROOM.h);
    expect(res.ok).toBe(false);
    expect(res.segmentIndex).toBe(0);
    expect(res.violationAt).toBeDefined();
  });

  it('合法绕行折线全程通过', () => {
    const route: Vec2[] = [
      { x: 5, y: 15 },
      { x: 15, y: 5 },
      { x: 25, y: 5 },
      { x: 35, y: 15 },
    ];
    const res = checkRouteClearance(route, 0.5, obstacles, ROOM.w, ROOM.h);
    expect(res.ok).toBe(true);
    expect(res.clearance).toBeGreaterThanOrEqual(0.5 - 1e-6);
  });

  it('segmentClearance 能量化中心线与墙体间隙', () => {
    // 竖墙 x∈[18,20], 中心线 y=15 水平穿过 -> 0
    expect(segmentClearance({ x: 2, y: 15 }, { x: 38, y: 15 }, obstacles, ROOM.w, ROOM.h)).toBe(0);
    // 从墙上方 y=8 经过(墙顶 y=10): 到墙间隙 2, 且大于到房间边界的间隙
    expect(segmentClearance({ x: 2, y: 8 }, { x: 38, y: 8 }, obstacles, ROOM.w, ROOM.h)).toBeCloseTo(2, 6);
  });
});
