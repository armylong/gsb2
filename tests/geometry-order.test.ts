import { describe, expect, it } from 'vitest';
import type { Camera } from '../src/core/types';
import {
  GRID_SIZE,
  blockAABB,
  characterAABB,
  polygonsIntersect,
  project,
  screenToGround,
  silhouettePolygon,
} from '../src/core/geometry';
import { computeOrder } from '../src/core/ordering';
import { createDefaultScene } from '../src/core/scene';

const cam: Camera = { originX: 400, originY: 300, k: 32 };

describe('等距投影与反投影', () => {
  it('2:1 固定比例：x 方向屏幕增量 (k, k/2)，y 方向 (-k, k/2)', () => {
    const o = project({ x: 0, y: 0, z: 0 }, cam);
    const px = project({ x: 1, y: 0, z: 0 }, cam);
    const py = project({ x: 0, y: 1, z: 0 }, cam);
    expect(px.sx - o.sx).toBeCloseTo(32);
    expect(px.sy - o.sy).toBeCloseTo(16);
    expect(py.sx - o.sx).toBeCloseTo(-32);
    expect(py.sy - o.sy).toBeCloseTo(16);
  });

  it('任意平移/缩放参数下，屏幕->地面反投影与正投影互逆', () => {
    for (const c of [cam, { originX: 123, originY: 456, k: 47 } satisfies Camera]) {
      for (const w of [
        { x: 0, y: 0 },
        { x: 7.3, y: 4.8 },
        { x: 11.9, y: 11.9 },
        { x: 2.5, y: 9.1 },
      ]) {
        const s = project({ ...w, z: 0 }, c);
        const back = screenToGround(s.sx, s.sy, c);
        expect(back.x).toBeCloseTo(w.x);
        expect(back.y).toBeCloseTo(w.y);
      }
    }
  });
});

describe('剪影多边形与长条物遮挡几何', () => {
  const scene = createDefaultScene();
  const platform = scene.blocks.find((b) => b.label === '长条平台')!;
  const east = scene.blocks.find((b) => b.label === '平台东端箱子')!;

  it('叠放箱子与长条平台剪影有面积重叠（因此必须排先后）', () => {
    const inter = polygonsIntersect(
      silhouettePolygon(blockAABB(platform), cam),
      silhouettePolygon(blockAABB(east), cam),
    );
    expect(inter).toBe(true);
  });

  it('场景中所有积木占地都在 12×12 内且数量不超过 20', () => {
    expect(scene.blocks.length).toBeLessThanOrEqual(20);
    for (const b of scene.blocks) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.sx).toBeLessThanOrEqual(GRID_SIZE);
      expect(b.y + b.sy).toBeLessThanOrEqual(GRID_SIZE);
    }
  });

  it('初始布局无穿入、无排序环', () => {
    const entities = [
      ...scene.blocks.map((b) => ({ id: b.id, box: blockAABB(b) })),
      { id: 'character', box: characterAABB(scene.character) },
    ];
    const r = computeOrder(entities, cam, 'correct');
    expect(r.hasConflict).toBe(false);
    expect(r.interpenetrations).toHaveLength(0);
    expect(r.cycleEntities).toHaveLength(0);
    expect(r.order).toHaveLength(entities.length);
  });
});

describe('正确模式 vs 仅纵坐标对照模式（同一布局同一角色位置）', () => {
  it('对照模式在长条平台处产生至少一条违例，正确模式零违例', () => {
    const scene = createDefaultScene();
    const entities = [
      ...scene.blocks.map((b) => ({ id: b.id, box: blockAABB(b) })),
      { id: 'character', box: characterAABB(scene.character) },
    ];
    const correct = computeOrder(entities, cam, 'correct');
    const naive = computeOrder(entities, cam, 'naive');
    expect(correct.naiveViolations.length).toBe(0);
    expect(naive.naiveViolations.length).toBeGreaterThan(0);

    const platform = scene.blocks.find((b) => b.label === '长条平台')!;
    const east = scene.blocks.find((b) => b.label === '平台东端箱子')!;
    const west = scene.blocks.find((b) => b.label === '平台西端箱子')!;
    // 具体的已知错误：naive 把箱子排到了平台前面
    expect(naive.order.indexOf(east.id)).toBeLessThan(naive.order.indexOf(platform.id));
    expect(naive.order.indexOf(west.id)).toBeLessThan(naive.order.indexOf(platform.id));
    // 正确模式两端都在平台之后
    expect(correct.order.indexOf(platform.id)).toBeLessThan(correct.order.indexOf(east.id));
    expect(correct.order.indexOf(platform.id)).toBeLessThan(correct.order.indexOf(west.id));
  });
});
