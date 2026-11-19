import { describe, expect, it } from 'vitest';
import { Grid } from '../src/core/Grid';
import { World, type WorldSnapshot } from '../src/core/World';
import { labelComponents } from '../src/core/connectivity';
import { SCENES, buildScene } from '../src/core/scenes';
import { generateTerrain } from '../src/core/generator';

describe('静态布局保存与载入', () => {
  it('序列化再载入后得到完全相同的连通块划分', () => {
    const world = new World(buildScene('bridge'));
    // 先做一轮挖补，制造非平凡的静态布局
    world.edit([{ x: 15, y: 9 }], 'dig');
    world.settle();
    world.edit([{ x: 20, y: 10 }, { x: 20, y: 11 }], 'fill');

    const snap = world.serialize();
    const restored = World.fromSnapshot(snap);

    expect(restored.grid.toRows()).toEqual(world.grid.toRows());
    const a = world.labeling;
    const b = restored.labeling;
    expect(b.count).toBe(a.count);
    expect(Array.from(b.sizes.entries()).sort((x, y) => x[0] - y[0])).toEqual(
      Array.from(a.sizes.entries()).sort((x, y) => x[0] - y[0]),
    );
    expect([...b.grounded].sort()).toEqual([...a.grounded].sort());
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        expect(b.compIdAt[y][x]).toBe(a.compIdAt[y][x]);
      }
    }
    // 载入的是纯静态布局：不含碎片、计数归零
    expect(restored.fragments).toHaveLength(0);
    expect(restored.removedCount).toBe(0);
  });

  it('resetTo 恢复初始布局并清空碎片与历史', () => {
    const initial = buildScene('multi');
    const world = new World(initial.clone());
    world.edit(
      Array.from({ length: 11 }, (_, x) => ({ x, y: 10 })),
      'dig',
    );
    expect(world.fragments.length).toBeGreaterThan(0);
    world.resetTo(initial.clone());
    expect(world.fragments).toHaveLength(0);
    expect(world.transitions).toHaveLength(0);
    expect(world.tick).toBe(0);
    expect(world.grid.toRows()).toEqual(initial.toRows());
  });

  it('拒绝损坏的存档', () => {
    expect(() =>
      World.fromSnapshot({ version: 99, width: 1, height: 1, rows: ['#'] } as unknown as WorldSnapshot),
    ).toThrow();
    expect(() =>
      World.fromSnapshot({ version: 1, width: 2, height: 1, rows: ['###'] }),
    ).toThrow();
  });
});

describe('内置现场', () => {
  for (const scene of SCENES) {
    it(`${scene.name}：初始无悬空碎片（所有实心块均接地）`, () => {
      const grid = buildScene(scene.id);
      const world = new World(grid);
      expect(world.fragments).toHaveLength(0);
      const labeling = labelComponents(grid);
      for (const id of labeling.sizes.keys()) {
        expect(labeling.grounded.has(id)).toBe(true);
      }
    });
  }

  it('切断桥梁现场：挖断桥点后恰好转出 1 个碎片', () => {
    const world = new World(buildScene('bridge'));
    // 细桥位于 y=12、x13..27；挖掉中央桥格 (20,12)
    const bridge = { x: 20, y: 12 };
    expect(world.grid.isSolid(bridge.x, bridge.y)).toBe(true);
    const before = world.totalCells;
    world.edit([bridge], 'dig');
    expect(world.fragments).toHaveLength(1);
    expect(world.totalCells).toBe(before - 1);
  });

  it('多块掉落现场：一次挖除同时转出 3 个碎片', () => {
    const world = new World(buildScene('multi'));
    const cut = Array.from({ length: 40 }, (_, x) => ({ x, y: 12 }));
    world.edit(cut, 'dig');
    expect(world.fragments).toHaveLength(3);
  });

  it('对角现场：挖掉右侧细柱后右岩体转出，左岩体保持接地', () => {
    const world = new World(buildScene('diagonal'));
    expect(world.labeling.count).toBe(2);
    // 右细柱位于 x=28、y=10..22（13 格）；右岩体 5x4=20 格
    world.edit(
      Array.from({ length: 13 }, (_, i) => ({ x: 28, y: 10 + i })),
      'dig',
    );
    expect(world.fragments).toHaveLength(1);
    expect(world.fragments[0].size).toBe(20);
    // 左岩体 (18..23, 10..14) 仍静态接地
    const leftId = world.labeling.compIdAt[12][20];
    expect(world.labeling.grounded.has(leftId)).toBe(true);
    // 碎片落地后停在右侧地基段上；补上对角缝与底行断口即可合并为单块
    world.settle();
    world.edit(
      [
        { x: 23, y: 9 },
        { x: 23, y: world.height - 1 },
        { x: 24, y: world.height - 1 },
      ],
      'fill',
    );
    expect(world.labeling.count).toBe(1);
    for (const id of world.labeling.sizes.keys()) {
      expect(world.labeling.grounded.has(id)).toBe(true);
    }
  });
});

describe('程序化地形生成', () => {
  it('同种子生成一致、尺寸受限且包含空洞与地基', () => {
    const a = generateTerrain({ width: 60, height: 36, seed: 7 });
    const b = generateTerrain({ width: 60, height: 36, seed: 7 });
    expect(a.toRows()).toEqual(b.toRows());
    expect(a.width).toBe(60);
    expect(a.height).toBe(36);

    let holes = 0;
    for (let y = 0; y < a.height - 2; y++) {
      for (let x = 0; x < a.width; x++) if (!a.isSolid(x, y)) holes++;
    }
    expect(holes).toBeGreaterThan(10);
    for (let x = 0; x < a.width; x++) {
      expect(a.isSolid(x, a.height - 1)).toBe(true);
    }
  });

  it('尺寸不超过 100x60，且初始地形全部接地', () => {
    const grid = generateTerrain({ width: 200, height: 90, seed: 1 });
    expect(grid.width).toBeLessThanOrEqual(100);
    expect(grid.height).toBeLessThanOrEqual(60);
    const labeling = labelComponents(grid);
    for (const id of labeling.sizes.keys()) {
      expect(labeling.grounded.has(id)).toBe(true);
    }
  });

  it('Grid 拒绝超过上限的尺寸', () => {
    expect(() => new Grid(101, 10)).toThrow();
    expect(() => new Grid(10, 61)).toThrow();
  });
});
