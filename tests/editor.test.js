import { describe, expect, it } from 'vitest';
import { EditorState } from '../src/app/EditorState.js';
import { createSampleWorld } from '../src/voxel/scene.js';
import {
  collectChunkFaces,
  faceKey,
  verifyChunkConsistency,
} from '../src/voxel/mesher.js';

describe('表面自检', () => {
  it('初始样例的分块结果与整世界一致', () => {
    const world = createSampleWorld();
    const result = verifyChunkConsistency(world);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.duplicated).toEqual([]);
    expect(result.globalCount).toBe(result.chunkedCount);
    expect(result.ok).toBe(true);
  });

  it('沿块边界连续编辑后仍保持一致', () => {
    const world = createSampleWorld();
    const { chunkSize } = world;

    for (let x = chunkSize - 2; x <= chunkSize + 2; x += 1) {
      for (let z = 5; z <= 9; z += 1) {
        world.set(x, 11, z, 'stone');
      }
    }
    world.remove(chunkSize, 6, 6);
    world.set(chunkSize, 12, 6, 'glass');

    const result = verifyChunkConsistency(world);
    expect(result.ok).toBe(true);
  });

  it('检测出人为篡改的可见面集合（防止自检永远为真）', () => {
    const world = createSampleWorld();
    // 模拟一个“分块时漏掉某块”的 bug：临时移除一个确实含有可见面的块。
    const index = world.chunks.findIndex((chunk) => {
      const faces = collectChunkFaces(world, chunk);
      return faces.opaque.length + faces.transparent.length > 0;
    });
    expect(index).toBeGreaterThanOrEqual(0);

    const [saved] = world.chunks.splice(index, 1);
    const result = verifyChunkConsistency(world);
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);

    world.chunks.splice(index, 0, saved);
    expect(verifyChunkConsistency(world).ok).toBe(true);
  });
});

describe('编辑器状态', () => {
  it('添加、删除方块会更新统计与选中位置', () => {
    const state = new EditorState();
    const before = state.getStats().total;

    expect(state.placeBlock({ x: 0, y: 14, z: 0 })).toBe(true);
    expect(state.getStats().total).toBe(before + 1);
    expect(state.selected).toEqual({ x: 0, y: 14, z: 0 });

    expect(state.deleteBlock({ x: 0, y: 14, z: 0 })).toBe(true);
    expect(state.getStats().total).toBe(before);
  });

  it('恢复样例后统计与原样例一致', () => {
    const state = new EditorState();
    const expected = state.getStats();

    for (let x = 0; x < 5; x += 1) {
      for (let z = 0; z < 5; z += 1) {
        state.placeBlock({ x, y: 13, z });
      }
    }
    state.clearAll();
    expect(state.getStats().total).toBe(0);

    state.reset();
    expect(state.getStats()).toEqual(expected);
    expect(state.selfCheck().ok).toBe(true);
  });

  it('重置后脏块覆盖全部块', () => {
    const state = new EditorState();
    state.world.consumeDirtyChunks();
    state.reset();
    const dirty = state.world.consumeDirtyChunks();
    expect(dirty).toHaveLength(state.world.chunks.length);
  });

  it('未知材质被拒绝，不破坏当前状态', () => {
    const state = new EditorState();
    state.setMaterial('not-real');
    expect(state.currentMaterial).toBe('stone');
  });
});

describe('面标识', () => {
  it('同一位置不同朝向/材质的面标识不同', () => {
    const base = { x: 1, y: 2, z: 3, direction: '+x', material: 'stone' };
    expect(faceKey(base)).toBe('1,2,3:+x:stone');
    expect(faceKey({ ...base, direction: '-x' })).not.toBe(faceKey(base));
    expect(faceKey({ ...base, material: 'glass' })).not.toBe(faceKey(base));
  });
});
