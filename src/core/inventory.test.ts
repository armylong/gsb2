import { describe, expect, it } from 'vitest';
import type { ItemDef, Placement, Rotation, WorldState } from './types';
import { cellKey, occupiedCells } from './geometry';
import {
  checkPlacement,
  countOccupiedCells,
  executeDrop,
  planDrop,
  validateLayout,
} from './inventory';
import { ITEMS } from './items';
import { SAMPLES } from './samples';

const item = (id: string): ItemDef => ITEMS.find((i) => i.id === id)!;

function worldOf(placements: Placement[]): WorldState {
  return {
    bags: [
      { id: 'bag-a', name: 'A', cols: 8, rows: 6 },
      { id: 'bag-b', name: 'B', cols: 6, rows: 5 },
    ],
    placements,
  };
}

const pl = (itemId: string, bagId: string, col: number, row: number, rotation: Rotation = 0): Placement =>
  ({ itemId, bagId, anchor: { col, row }, rotation });

/** 断言某物品在世界中的实际占格恰好等于给定全局格 */
function expectOccupied(world: WorldState, id: string, expected: string[]) {
  const def = item(id);
  const placement = world.placements.find((p) => p.itemId === id)!;
  const got = occupiedCells(def, placement).map(cellKey).sort();
  expect(got).toEqual([...expected].sort());
}

describe('落点检查 checkPlacement', () => {
  it('越界: 长条贴右边界超出时给出越界格', () => {
    const world = worldOf([]);
    const check = checkPlacement(ITEMS, world, 'bag-a', item('I02'), { col: 6, row: 0 }, 0);
    expect(check.ok).toBe(false);
    const oob = check.reasons.find((r) => r.kind === 'out-of-bounds')!;
    expect(oob.cells.map((c) => cellKey(c))).toContain('9,0');
  });

  it('碰撞: 与已有物品共享格时返回碰撞物品编号与具体格', () => {
    const world = worldOf([pl('I06', 'bag-a', 1, 1)]); // 占 (1,1)(2,1)(1,2)(2,2)
    // 候选 I06 锚 (2,2) 占 (2,2)(3,2)(2,3)(3,3), 仅 (2,2) 与已有格重叠
    const check = checkPlacement(ITEMS, world, 'bag-a', item('I06'), { col: 2, row: 2 }, 0);
    expect(check.ok).toBe(false);
    const col = check.reasons.find((r) => r.kind === 'collision')!;
    expect(col.hitItemIds).toEqual(['I06']);
    expect(col.cells.map((c) => cellKey(c))).toEqual(['2,2']);
  });

  it('排除自身后原位置不视为碰撞(拖动预留)', () => {
    const world = worldOf([pl('I06', 'bag-a', 1, 1)]);
    const check = checkPlacement(ITEMS, world, 'bag-a', item('I06'), { col: 1, row: 1 }, 0, ['I06']);
    expect(check.ok).toBe(true);
  });

  it('L 形的空缺部分允许容纳别的物品', () => {
    // I10 形状 (0,0)(1,0)(2,0)(2,1), 空缺 (0,1)(1,1)
    const world = worldOf([pl('I10', 'bag-a', 0, 0)]);
    // I12 占 (0,1)(1,1)(2,1), 其中 (2,1) 是 I10 实占格 => 碰撞
    const collide = checkPlacement(ITEMS, world, 'bag-a', item('I12'), { col: 0, row: 1 }, 0);
    expect(collide.ok).toBe(false);
    expect(collide.reasons.find((r) => r.kind === 'collision')?.hitItemIds).toEqual(['I10']);
    // I07 旋转1次 = (0,0)(1,0)(0,1), 锚(0,1) 占 (0,1)(1,1)(0,2),
    // 前两格恰好落在 I10 包围盒的空缺里, 不碰任何实占格
    const fitInHollow = checkPlacement(ITEMS, world, 'bag-a', item('I07'), { col: 0, row: 1 }, 1);
    expect(fitInHollow.ok).toBe(true);
  });
});

describe('跨背包移动', () => {
  it('空位合法时从 bag-a 移到 bag-b, 旧背包不再保留该物品', () => {
    const world = worldOf([pl('I03', 'bag-a', 0, 0), pl('I06', 'bag-a', 4, 4), pl('I12', 'bag-b', 3, 3)]);
    const req = {
      item: item('I03'),
      from: pl('I03', 'bag-a', 0, 0),
      toBagId: 'bag-b',
      anchor: { col: 0, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.ok).toBe(true);
    expect(plan.kind).toBe('move');
    const next = executeDrop(world, req, plan);
    expect(next.placements.find((p) => p.itemId === 'I03')?.bagId).toBe('bag-b');
    expect(next.placements.filter((p) => p.bagId === 'bag-a').map((p) => p.itemId)).toEqual(['I06']);
    // 编号不丢失、不复制
    expect(next.placements).toHaveLength(3);
    expectOccupied(next, 'I03', ['0,0', '0,1', '0,2']);
  });

  it('放回完全相同的位置/朝向为 no-op, 不产生变化', () => {
    const world = worldOf([pl('I03', 'bag-a', 0, 0)]);
    const req = {
      item: item('I03'),
      from: pl('I03', 'bag-a', 0, 0),
      toBagId: 'bag-a',
      anchor: { col: 0, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.kind).toBe('none');
    expect(executeDrop(world, req, plan)).toBe(world);
  });
});

describe('交换(双向, 原子生效)', () => {
  it('同包一对一交换: 两边都合法时一起生效, 被换物品保持原朝向回到原锚点', () => {
    // I12 在 (0,0) 横放, I03 在 (4,0) 竖放; 把 I12 拖到 I03 锚点(恰好碰撞一件)
    const world = worldOf([pl('I12', 'bag-a', 0, 0), pl('I03', 'bag-a', 4, 0)]);
    const req = {
      item: item('I12'),
      from: pl('I12', 'bag-a', 0, 0),
      toBagId: 'bag-a',
      anchor: { col: 4, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.kind).toBe('swap');
    expect(plan.ok).toBe(true);
    expect(plan.swapWith).toBe('I03');
    const next = executeDrop(world, req, plan);
    const p12 = next.placements.find((p) => p.itemId === 'I12')!;
    const p03 = next.placements.find((p) => p.itemId === 'I03')!;
    expect(p12.anchor).toEqual({ col: 4, row: 0 });
    expect(p03.anchor).toEqual({ col: 0, row: 0 });
    expect(p03.rotation).toBe(0); // 保持原朝向
    expectOccupied(next, 'I03', ['0,0', '0,1', '0,2']);
    expectOccupied(next, 'I12', ['4,0', '5,0', '6,0']);
  });

  it('跨包交换同样原子生效, 编号/背包/朝向一起变化', () => {
    const world = worldOf([pl('I12', 'bag-a', 0, 0), pl('I03', 'bag-b', 0, 0)]);
    const req = {
      item: item('I12'),
      from: pl('I12', 'bag-a', 0, 0),
      toBagId: 'bag-b',
      anchor: { col: 0, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.ok).toBe(true);
    const next = executeDrop(world, req, plan);
    expect(next.placements.find((p) => p.itemId === 'I12')?.bagId).toBe('bag-b');
    expect(next.placements.find((p) => p.itemId === 'I03')?.bagId).toBe('bag-a');
  });

  it('碰到多件物品时直接失败, 不挤走任何物品', () => {
    // I04(0,0..1,2) 与 I05(2,0..4,1) 相邻; I02 横条拖到 (0,0) 同时压两者
    const world = worldOf([pl('I04', 'bag-a', 0, 0), pl('I05', 'bag-a', 2, 0), pl('I02', 'bag-b', 0, 0)]);
    const req = {
      item: item('I02'),
      from: pl('I02', 'bag-b', 0, 0),
      toBagId: 'bag-a',
      anchor: { col: 0, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.ok).toBe(false);
    expect(plan.kind).toBe('none');
    expect(plan.message).toContain('2 件物品');
    // 库存原封不动
    expect(executeDrop(world, req, plan)).toBe(world);
    expect(world.placements.find((p) => p.itemId === 'I02')?.bagId).toBe('bag-b');
  });

  it('交换对侧放不下时整次失败并回滚(被换物品回原锚点会越界)', () => {
    // I02(5格横条)在 bag-b 的 col=1, 若 I01 从 bag-a 交换过去, I02 需回到 bag-a 锚点 (0,5):
    // 直接构造: bag-a 中 I01 占 (0,3..3,3), I02 拖向它; I01 回到 I02 原锚点 bag-b(1,0) 合法,
    // 因此改为让被换物品回不去: bag-b 里 I02 锚点 col=1, 被换的是 bag-a 的 I04(2x3 矩形),
    // I04 回到 bag-b(1,0) 会与 bag-b 既有 I06 冲突。
    const world = worldOf([
      pl('I04', 'bag-a', 0, 0),
      pl('I02', 'bag-b', 1, 0),
      pl('I06', 'bag-b', 1, 2), // 占据 I04 回到 (1,0) 后会用到的 (1,2)(2,2)
    ]);
    const req = {
      item: item('I02'),
      from: pl('I02', 'bag-b', 1, 0),
      toBagId: 'bag-a',
      anchor: { col: 0, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.kind).toBe('swap');
    expect(plan.ok).toBe(false);
    expect(plan.swapCheck?.ok).toBe(false);
    // 失败方案执行返回原世界, 逐件位置不变
    expect(executeDrop(world, req, plan)).toBe(world);
    const snapshot = JSON.stringify(world.placements);
    expect(snapshot).toContain('"bagId":"bag-b"');
    expect(world.placements.find((p) => p.itemId === 'I04')?.anchor).toEqual({ col: 0, row: 0 });
  });

  it('越界时不进入交换分支', () => {
    const world = worldOf([pl('I06', 'bag-a', 0, 0), pl('I02', 'bag-b', 0, 0)]);
    const req = {
      item: item('I02'),
      from: pl('I02', 'bag-b', 0, 0),
      toBagId: 'bag-a',
      anchor: { col: 6, row: 0 }, // 5 格横条, 6..10 越界
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    expect(plan.ok).toBe(false);
    expect(plan.kind).toBe('none');
    expect(plan.message).toContain('越界');
  });
});

describe('统计与布局校验', () => {
  it('三个样例布局全部合法, 且物品总数 12、已占格数一致', () => {
    for (const sample of SAMPLES) {
      const issues = validateLayout(ITEMS, sample.world);
      expect(issues, `${sample.label}: ${issues.map((i) => i.message).join('; ')}`).toEqual([]);
      expect(sample.world.placements).toHaveLength(12);
      expect(countOccupiedCells(ITEMS, sample.world)).toBe(
        ITEMS.reduce((n, i) => n + i.shape.length, 0),
      );
    }
  });

  it('拒绝: 编号重复 / 重叠 / 越界 / 缺失放置', () => {
    const dup = validateLayout([...ITEMS, { ...ITEMS[0] }], SAMPLES[0].world);
    expect(dup.some((i) => i.message.includes('编号重复'))).toBe(true);

    const overlapWorld = worldOf([pl('I06', 'bag-a', 0, 0), pl('I06', 'bag-a', 0, 0)].map(
      (p, idx) => (idx === 1 ? { ...p, itemId: 'I12' } : p),
    ));
    // I12 横放 (0,0..2,0) 与 I06 (0,0)(1,0) 重叠, 并补齐其它物品放置以隔离"缺失"噪音
    const others = ITEMS.filter((i) => !['I06', 'I12'].includes(i.id)).map((i) =>
      pl(i.id, 'bag-b', 0, 0),
    );
    const overlapIssues = validateLayout(ITEMS, {
      bags: overlapWorld.bags,
      placements: [...overlapWorld.placements, ...others],
    });
    expect(overlapIssues.some((i) => i.message.includes('重叠'))).toBe(true);

    const oobWorld = worldOf([
      pl('I02', 'bag-a', 6, 0),
      ...ITEMS.filter((i) => i.id !== 'I02').map((i) => pl(i.id, 'bag-b', 0, 0)),
    ]);
    expect(validateLayout(ITEMS, oobWorld).some((i) => i.message.includes('越界'))).toBe(true);

    const missing = validateLayout(
      ITEMS,
      worldOf(SAMPLES[0].world.placements.filter((p) => p.itemId !== 'I01')),
    );
    expect(missing.some((i) => i.message.includes('缺少放置'))).toBe(true);
  });

  it('统计在移动/交换前后保持不变(不丢格不复制)', () => {
    const world = worldOf([pl('I12', 'bag-a', 0, 0), pl('I03', 'bag-a', 4, 0), pl('I06', 'bag-b', 0, 0)]);
    const before = countOccupiedCells(ITEMS, world);
    const req = {
      item: item('I12'),
      from: pl('I12', 'bag-a', 0, 0),
      toBagId: 'bag-a',
      anchor: { col: 4, row: 0 },
      rotation: 0 as Rotation,
    };
    const plan = planDrop(ITEMS, world, req);
    const next = executeDrop(world, req, plan);
    expect(countOccupiedCells(ITEMS, next)).toBe(before);
  });
});
