import { describe, expect, it } from 'vitest';
import { buildPlan, type BatchPlan } from '../src/core/batching';
import { fitCamera, visibleWorldRect } from '../src/core/camera';
import { buildScene, SCENE_META, snapshotSprites } from '../src/core/scenes';
import type { SceneKey, Sprite } from '../src/core/types';

const KEYS: SceneKey[] = ['sparse', 'interleaved', 'dense'];

function planFor(key: SceneKey, zoomFactor = 1.0): { plan: BatchPlan; sprites: Sprite[] } {
  const scene = buildScene(key);
  const sprites = snapshotSprites(scene);
  const camera = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
  camera.zoom *= zoomFactor;
  return { plan: buildPlan(sprites, camera, 1280, 720), sprites };
}

/** 不变量 1：绘制顺序 = 入镜精灵按 (层, 层内次序, id) 的稳定排序。 */
function expectedOrder(sprites: readonly Sprite[], visible: readonly number[]): number[] {
  return visible.slice().sort((ia, ib) => {
    const a = sprites[ia]!;
    const b = sprites[ib]!;
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (a.order !== b.order) return a.order - b.order;
    return a.id - b.id;
  });
}

describe('场景生成', () => {
  it('固定种子生成完全相同的精灵分布', () => {
    for (const key of KEYS) {
      const a = buildScene(key);
      const b = buildScene(key);
      expect(a.sprites.length).toBe(b.sprites.length);
      for (let i = 0; i < a.sprites.length; i++) {
        expect(a.sprites[i]).toEqual(b.sprites[i]);
      }
    }
  });

  it('三组场景规模递增，并且都含 3 个可拖动探针', () => {
    const counts = KEYS.map((key) => buildScene(key).sprites.length);
    expect(counts[0]).toBeLessThan(counts[1]!);
    expect(counts[1]).toBeLessThan(counts[2]!);
    for (const key of KEYS) {
      const scene = buildScene(key);
      const probes = scene.sprites.filter((s) => s.draggable);
      expect(probes.map((p) => p.label)).toEqual(['A', 'B', 'C']);
    }
  });

  it('两种混合模式在场景中都存在', () => {
    for (const key of KEYS) {
      const scene = buildScene(key);
      const blends = new Set(scene.sprites.map((s) => s.blend));
      expect(blends.has('alpha')).toBe(true);
      expect(blends.has('additive')).toBe(true);
    }
  });

  it('层号都在 [0, layerCount) 范围内', () => {
    for (const key of KEYS) {
      const scene = buildScene(key);
      for (const sprite of scene.sprites) {
        expect(sprite.layer).toBeGreaterThanOrEqual(0);
        expect(sprite.layer).toBeLessThan(scene.layerCount);
      }
    }
  });
});

describe('批次切分', () => {
  it('批次是对绘制顺序的连续切分，不重不漏', () => {
    for (const key of KEYS) {
      const { plan, sprites } = planFor(key);
      let covered = 0;
      let expectedFirst = 0;
      for (const batch of plan.batches) {
        expect(batch.first).toBe(expectedFirst);
        expect(batch.count).toBeGreaterThan(0);
        expectedFirst += batch.count;
        covered += batch.count;
        for (let r = batch.first; r < batch.first + batch.count; r++) {
          const si = plan.paintOrder[r]!;
          expect(plan.batchOfSprite[si]).toBe(batch.index);
          const sprite = sprites[si]!;
          expect(sprite.layer).toBe(batch.layer);
          expect(sprite.blend).toBe(batch.blend);
        }
      }
      expect(covered).toBe(plan.paintOrder.length);
      expect(plan.paintOrder.length).toBe(plan.visible.length);
    }
  });

  it('绘制顺序与排序键一致，且每个入镜精灵恰好出现一次', () => {
    for (const key of KEYS) {
      const { plan, sprites } = planFor(key);
      expect(plan.paintOrder).toEqual(expectedOrder(sprites, plan.visible));
      expect(new Set(plan.paintOrder).size).toBe(plan.paintOrder.length);
      for (const si of plan.visible) expect(plan.rankOfSprite[si]).toBeGreaterThanOrEqual(0);
      for (const si of plan.culled) expect(plan.rankOfSprite[si]).toBe(-1);
      expect(plan.visible.length + plan.culled.length).toBe(sprites.length);
    }
  });

  it('相邻批次一定在层或混合上不同（否则本该合并）', () => {
    for (const key of KEYS) {
      const { plan } = planFor(key);
      for (let i = 1; i < plan.batches.length; i++) {
        const a = plan.batches[i - 1]!;
        const b = plan.batches[i]!;
        expect(a.layer !== b.layer || a.blend !== b.blend).toBe(true);
      }
    }
  });

  it('切段原因统计与批次构造一致', () => {
    for (const key of KEYS) {
      const { plan } = planFor(key);
      const blend = plan.batches.filter((b) => b.cut === 'blend-switch').length;
      const layer = plan.batches.filter((b) => b.cut === 'layer-switch').length;
      const start = plan.batches.filter((b) => b.cut === 'scene-start').length;
      expect(blend).toBe(plan.counts.blendBreaks);
      expect(layer).toBe(plan.counts.layerBreaks);
      expect(start).toBe(plan.batches.length === 0 ? 0 : 1);
    }
  });

  it('同层夹进另一混合时，批次被打断但可见次序保留', () => {
    const scene = buildScene('interleaved');
    const sprites = snapshotSprites(scene);
    const camera = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
    camera.zoom *= 1.2;

    // 把三个探针放到同一层，顺序 A(透明) → B(叠加) → C(透明)。
    const probes = sprites.filter((s) => s.draggable);
    const baseLayer = 4;
    const baseX = scene.worldWidth / 2;
    const baseY = scene.worldHeight / 2;
    for (const [i, probe] of probes.entries()) {
      probe.layer = baseLayer;
      probe.x = baseX + i * 60;
      probe.y = baseY + i * 40;
    }
    const plan = buildPlan(sprites, camera, 1280, 720);
    const a = sprites.indexOf(probes[0]!);
    const b = sprites.indexOf(probes[1]!);
    const c = sprites.indexOf(probes[2]!);
    const ra = plan.rankOfSprite[a]!;
    const rb = plan.rankOfSprite[b]!;
    const rc = plan.rankOfSprite[c]!;
    expect(ra).toBeGreaterThanOrEqual(0);
    expect(rb).toBe(ra + 1);
    expect(rc).toBe(rb + 1);
    expect(plan.batchOfSprite[a]).not.toBe(plan.batchOfSprite[b]!);
    expect(plan.batchOfSprite[b]).not.toBe(plan.batchOfSprite[c]!);
    expect(plan.batchOfSprite[a]).not.toBe(plan.batchOfSprite[c]!);

    const pair = plan.interruptions.find(
      (it) => it.layer === baseLayer && it.before <= plan.batchOfSprite[a]! && it.after >= plan.batchOfSprite[c]!,
    );
    expect(pair).toBeDefined();
    expect(pair!.interrupters.length).toBeGreaterThan(0);
  });

  it('稀疏场景的批次近乎按层连续，密集场景切段更多', () => {
    const sparse = planFor('sparse', 1).plan;
    const dense = planFor('dense', 1).plan;
    expect(dense.counts.batches).toBeGreaterThan(sparse.counts.batches);
  });
});

describe('反例诊断（同层内按混合重排）', () => {
  it('重排会减少批次但不再是画家顺序', () => {
    const scene = buildScene('interleaved');
    const sprites = snapshotSprites(scene);
    const camera = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
    const normal = buildPlan(sprites, camera, 1280, 720);
    const broken = buildPlan(sprites, camera, 1280, 720, { reorderWithinLayer: true });
    expect(broken.counts.batches).toBeLessThan(normal.counts.batches);
    expect(broken.paintOrder).not.toEqual(normal.paintOrder);
    expect(broken.reordered).toBe(true);
    expect(normal.reordered).toBe(false);
    // 两组次序必须包含同一批入镜精灵。
    expect(new Set(broken.paintOrder)).toEqual(new Set(normal.paintOrder));
    expect(broken.visible.slice().sort()).toEqual(normal.visible.slice().sort());
    // 重排把同层内的前后关系拉平了，夹断统计不再适用。
    expect(broken.counts.interruptedPairs).toBe(0);
  });

  it('重排后同层的实例被按混合分组，破坏层内次序', () => {
    const scene = buildScene('interleaved');
    const sprites = snapshotSprites(scene);
    const camera = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
    const broken = buildPlan(sprites, camera, 1280, 720, { reorderWithinLayer: true });
    let inversions = 0;
    for (let i = 0; i < broken.paintOrder.length - 1; i++) {
      const a = sprites[broken.paintOrder[i]!]!;
      const b = sprites[broken.paintOrder[i + 1]!]!;
      if (a.layer === b.layer && a.order > b.order) inversions++;
    }
    expect(inversions).toBeGreaterThan(0);
  });
});

describe('剔除与相机', () => {
  it('相机拉远后入镜数上升，拉近后下降', () => {
    const scene = buildScene('dense');
    const sprites = snapshotSprites(scene);
    const wide = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
    const narrow = { ...wide, zoom: wide.zoom * 4 };
    const widePlan = buildPlan(sprites, wide, 1280, 720);
    const narrowPlan = buildPlan(sprites, narrow, 1280, 720);
    expect(widePlan.counts.visible).toBeGreaterThan(narrowPlan.counts.visible);
    expect(narrowPlan.counts.visible).toBeGreaterThan(0);
  });

  it('可见矩形与剔除判定一致', () => {
    const scene = buildScene('sparse');
    const sprites = snapshotSprites(scene);
    const camera = fitCamera(scene.worldWidth, scene.worldHeight, 800, 600);
    const plan = buildPlan(sprites, camera, 800, 600);
    const rect = visibleWorldRect(camera, 800, 600);
    for (const si of plan.visible) {
      const s = sprites[si]!;
      expect(s.x + s.w / 2 >= rect.minX).toBe(true);
      expect(s.x - s.w / 2 <= rect.maxX).toBe(true);
      expect(s.y + s.h / 2 >= rect.minY).toBe(true);
      expect(s.y - s.h / 2 <= rect.maxY).toBe(true);
    }
  });

  it('把探针拖出画面后它退出统计与批次', () => {
    const scene = buildScene('interleaved');
    const sprites = snapshotSprites(scene);
    const camera = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
    const before = buildPlan(sprites, camera, 1280, 720);
    const probe = sprites.find((s) => s.draggable && s.label === 'B')!;
    const probeIndex = sprites.indexOf(probe);
    expect(before.rankOfSprite[probeIndex]).toBeGreaterThanOrEqual(0);
    probe.x = 999_999;
    probe.y = 999_999;
    const after = buildPlan(sprites, camera, 1280, 720);
    expect(after.rankOfSprite[probeIndex]).toBe(-1);
    expect(after.batchOfSprite[probeIndex]).toBe(-1);
    expect(after.visible).not.toContain(probeIndex);
    expect(after.culled).toContain(probeIndex);
    expect(after.counts.visible).toBe(before.counts.visible - 1);
    expect(after.paintOrder).not.toContain(probeIndex);
    for (const rank of after.paintOrder) {
      for (let r = 0; r < after.batches.length; r++) {
        void r;
      }
      void rank;
    }
    for (const batch of after.batches) {
      for (let r = batch.first; r < batch.first + batch.count; r++) {
        expect(after.paintOrder[r]).not.toBe(probeIndex);
      }
    }
  });

  it('改探针层号后它进入新层的批次范围', () => {
    const scene = buildScene('interleaved');
    const sprites = snapshotSprites(scene);
    const camera = fitCamera(scene.worldWidth, scene.worldHeight, 1280, 720);
    const probe = sprites.find((s) => s.draggable && s.label === 'B')!;
    const index = sprites.indexOf(probe);
    probe.layer = 0;
    const plan = buildPlan(sprites, camera, 1280, 720);
    const rank = plan.rankOfSprite[index]!;
    expect(rank).toBeGreaterThanOrEqual(0);
    const batch = plan.batches[plan.batchOfSprite[index]!]!;
    expect(batch.layer).toBe(0);
    expect(rank).toBeGreaterThanOrEqual(batch.first);
    expect(rank).toBeLessThan(batch.first + batch.count);
  });

  it('夹断关系与"被打断批次"标记互相自洽', () => {
    for (const key of KEYS) {
      const { plan } = planFor(key, 1.4);
      for (const it of plan.interruptions) {
        const before = plan.batches[it.before]!;
        const after = plan.batches[it.after]!;
        expect(before.layer).toBe(it.layer);
        expect(after.layer).toBe(it.layer);
        expect(before.blend).toBe(after.blend);
        expect(it.before).toBeLessThan(it.after);
        expect(it.between.length).toBeGreaterThan(0);
        for (const b of it.between) {
          const betweenBatch = plan.batches[b]!;
          expect(betweenBatch.layer).toBe(it.layer);
          expect(betweenBatch.blend).not.toBe(before.blend);
        }
        expect(plan.interruptedBatch[it.before]).toBe(true);
        expect(plan.interruptedBatch[it.after]).toBe(true);
      }
    }
  });

  it('没有精灵被绘制超过一次（每批次实例数之和 = 入镜数）', () => {
    for (const key of KEYS) {
      const { plan } = planFor(key, 0.6);
      const sum = plan.batches.reduce((acc, b) => acc + b.count, 0);
      expect(sum).toBe(plan.visible.length);
    }
  });

  it('三组场景的元信息与种子稳定', () => {
    for (const key of KEYS) {
      const scene = buildScene(key);
      expect(scene.seed).toBe(SCENE_META[key].seed);
      expect(scene.notes.length).toBeGreaterThan(0);
    }
  });
});
