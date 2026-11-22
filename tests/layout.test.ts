import { describe, expect, it } from 'vitest';
import {
  candidateRect,
  layoutLabels,
  rectsOverlap,
  sortForLayout,
  type AnchorLayoutInput,
  type LayoutConfig,
} from '../src/core/layout';

const viewport = { width: 900, height: 600 };

function anchor(
  id: string,
  x: number,
  y: number,
  extra: Partial<AnchorLayoutInput> = {},
): AnchorLayoutInput {
  return {
    id,
    anchor: { x, y },
    width: 120,
    height: 38,
    priority: 3,
    locked: false,
    ...extra,
  };
}

function config(overrides: Partial<LayoutConfig> = {}): LayoutConfig {
  return { viewport, padding: 12, labelGap: 18, labelSpacing: 6, ...overrides };
}

function overlapsAny(
  id: string,
  placements: ReturnType<typeof layoutLabels>['placements'],
  spacing = 6,
): boolean {
  const target = placements.get(id);
  if (!target) return false;
  for (const [otherId, other] of placements) {
    if (otherId === id) continue;
    if (rectsOverlap(target.rect, other.rect, spacing)) return true;
  }
  return false;
}

function insideViewport(rect: { x: number; y: number; w: number; h: number }, padding = 12): boolean {
  return (
    rect.x >= padding - 1e-6 &&
    rect.y >= padding - 1e-6 &&
    rect.x + rect.w <= viewport.width - padding + 1e-6 &&
    rect.y + rect.h <= viewport.height - padding + 1e-6
  );
}

describe('layoutLabels 基本约束', () => {
  it('不重叠且不出界', () => {
    const anchors: AnchorLayoutInput[] = [];
    for (let i = 0; i < 14; i += 1) {
      anchors.push(anchor(`a${i}`, 60 + (i % 7) * 120, 90 + Math.floor(i / 7) * 90));
    }
    const result = layoutLabels(anchors, config());
    expect(result.placements.size).toBeGreaterThan(0);
    for (const [id, placement] of result.placements) {
      expect(insideViewport(placement.rect)).toBe(true);
      expect(overlapsAny(id, result.placements)).toBe(false);
    }
  });

  it('锚点挤在同一处时，标签被推开而不是叠在一起', () => {
    const anchors = [
      anchor('a', 400, 300),
      anchor('b', 404, 303),
      anchor('c', 397, 298),
      anchor('d', 402, 305),
    ];
    const result = layoutLabels(anchors, config());
    expect(result.placements.size).toBe(4);
    for (const [id] of result.placements) {
      expect(overlapsAny(id, result.placements)).toBe(false);
    }
  });

  it('靠近窗口边缘时自动换到另一侧', () => {
    const result = layoutLabels([anchor('edge', 890, 590)], config());
    const placement = result.placements.get('edge');
    expect(placement).toBeDefined();
    expect(insideViewport(placement!.rect)).toBe(true);
  });

  it('标签贴边时会把矩形夹回可视区', () => {
    const stickySlots = new Map([['edge', 0]]); // E 方向
    const result = layoutLabels([anchor('edge', 880, 300)], config({ stickySlots }));
    const placement = result.placements.get('edge');
    expect(placement).toBeDefined();
    expect(insideViewport(placement!.rect)).toBe(true);
    expect(placement!.sticky).toBe(true);
    expect(placement!.clamped).toBe(true);
  });
});

describe('空间不足时的优先级', () => {
  function tightConfig(extra: Partial<LayoutConfig> = {}): LayoutConfig {
    // 只有 260×170 的可视区，放不下 6 个 120×38 的标签
    return {
      viewport: { width: 260, height: 170 },
      padding: 8,
      labelGap: 12,
      labelSpacing: 4,
      ...extra,
    };
  }

  it('锁定项与高优先级项优先保留，低优先级被收起并报告', () => {
    const anchors = [
      anchor('low', 130, 85, { priority: 1 }),
      anchor('mid', 128, 82, { priority: 3 }),
      anchor('high', 132, 88, { priority: 5 }),
      anchor('locked', 126, 84, { priority: 1, locked: true }),
      anchor('low2', 134, 80, { priority: 1 }),
      anchor('low3', 130, 90, { priority: 2 }),
    ];
    const result = layoutLabels(anchors, tightConfig());
    const placedIds = new Set(result.placements.keys());
    const stowedIds = new Set(result.stowed.map((s) => s.id));

    expect(placedIds.has('locked')).toBe(true);
    expect(placedIds.has('high')).toBe(true);
    // 被收起的必须是低优先级项
    expect(stowedIds.has('locked')).toBe(false);
    expect(stowedIds.has('high')).toBe(false);
    if (placedIds.has('low') && !placedIds.has('low2')) {
      // 同优先级按稳定顺序，属正常
    }
    const stowedPriorities = result.stowed.map(
      (s) => anchors.find((a) => a.id === s.id)!.priority,
    );
    for (const p of stowedPriorities) {
      expect(p).toBeLessThanOrEqual(3);
    }
    // 每个被收起的都带有原因
    for (const s of result.stowed) expect(s.reason).toBe('space');
  });

  it('连锁定项都放不下时也会报告收起', () => {
    const config2: LayoutConfig = {
      viewport: { width: 130, height: 52 },
      padding: 8,
      labelGap: 8,
      labelSpacing: 2,
    };
    const anchors = [
      anchor('a', 65, 26, { locked: true, priority: 5 }),
      anchor('b', 66, 27, { priority: 1 }),
    ];
    const result = layoutLabels(anchors, config2);
    expect(result.placements.size + result.stowed.length).toBe(2);
    expect(result.stowed.length).toBeGreaterThanOrEqual(1);
  });

  it('视口比标签还窄时全部收起', () => {
    const result = layoutLabels([anchor('a', 40, 20)], {
      viewport: { width: 100, height: 40 },
      padding: 10,
    });
    expect(result.placements.size).toBe(0);
    expect(result.stowed[0]?.id).toBe('a');
  });

  it('排序规则：锁定 > 优先级 > 数据顺序', () => {
    const ordered = sortForLayout([
      anchor('d', 0, 0, { priority: 2, order: 3 }),
      anchor('c', 0, 0, { priority: 4, order: 2 }),
      anchor('b', 0, 0, { priority: 4, order: 1 }),
      anchor('a', 0, 0, { priority: 1, locked: true, order: 0 }),
    ]).map((a) => a.id);
    expect(ordered).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('粘滞（稳定性）', () => {
  it('锚点小幅移动时沿用同一 slot', () => {
    const first = layoutLabels([anchor('a', 400, 300)], config());
    const slot = first.placements.get('a')!.slot;
    const second = layoutLabels([anchor('a', 402, 301)], config({ stickySlots: first.slots }));
    const placement = second.placements.get('a')!;
    expect(placement.slot).toBe(slot);
    expect(placement.sticky).toBe(true);
  });

  it('缓慢转动时 slot 不会来回跳变', () => {
    // 模拟锚点绕中心缓慢移动 120 帧
    let slots = new Map<string, number>();
    const history: number[] = [];
    for (let frame = 0; frame < 120; frame += 1) {
      const angle = (frame / 120) * 0.35;
      const x = 450 + Math.cos(angle) * 130;
      const y = 300 + Math.sin(angle) * 90;
      const result = layoutLabels([anchor('a', x, y)], config({ stickySlots: slots }));
      slots = result.slots;
      history.push(result.placements.get('a')!.slot);
    }
    // 每帧的方向（slot % 8）最多变化一次，且整体不应出现左右往返
    let flips = 0;
    for (let i = 1; i < history.length; i += 1) {
      const prevDir = history[i - 1] % 8;
      const dir = history[i] % 8;
      if (prevDir !== dir) flips += 1;
    }
    expect(flips).toBeLessThanOrEqual(2);
  });

  it('不传 stickySlots 时按新视角重新选位', () => {
    const first = layoutLabels([anchor('a', 120, 120)], config());
    const forced = first.placements.get('a')!.slot;
    const fresh = layoutLabels([anchor('a', 120, 120)], config());
    expect(fresh.placements.get('a')!.slot).toBe(forced);
    expect(fresh.placements.get('a')!.sticky).toBe(false);
  });

  it('粘滞位被新出现的标签占用时让位给已放置的标签，自身换位', () => {
    const initial = layoutLabels([anchor('a', 400, 300)], config());
    const slotA = initial.placements.get('a')!.slot;
    const result = layoutLabels(
      [anchor('a', 400, 300), anchor('b', 400, 300, { locked: true, priority: 5 })],
      config({ stickySlots: initial.slots }),
    );
    const a = result.placements.get('a')!;
    const b = result.placements.get('b')!;
    expect(b.slot).toBe(slotA);
    expect(a.slot).not.toBe(slotA);
    expect(rectsOverlap(a.rect, b.rect)).toBe(false);
  });
});

describe('工具函数', () => {
  it('candidateRect 依据方向把标签摆在锚点外侧', () => {
    const east = candidateRect({ x: 100, y: 100 }, 80, 30, 0, 10);
    expect(east.x).toBeGreaterThan(100);
    expect(east.y + east.h / 2).toBeCloseTo(100);

    const west = candidateRect({ x: 100, y: 100 }, 80, 30, 1, 10);
    expect(west.x + west.w).toBeLessThan(100);

    const south = candidateRect({ x: 100, y: 100 }, 80, 30, 2, 10);
    expect(south.y).toBeGreaterThan(100);
  });

  it('障碍区（HUD）不会被标签压住', () => {
    const obstacle = { x: 0, y: 0, w: 220, h: 80 };
    const result = layoutLabels([anchor('a', 110, 40)], config({ obstacles: [obstacle] }));
    const placement = result.placements.get('a');
    expect(placement).toBeDefined();
    expect(rectsOverlap(placement!.rect, obstacle)).toBe(false);
    expect(insideViewport(placement!.rect)).toBe(true);
  });
});
