import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ChunkRenderer } from '../src/render/ChunkRenderer.js';
import { createSampleWorld } from '../src/voxel/scene.js';
import { collectWorldFaces } from '../src/voxel/mesher.js';

function setup() {
  const scene = new THREE.Scene();
  const world = createSampleWorld();
  const renderer = new ChunkRenderer(world, scene);
  renderer.rebuildAll();
  return { scene, world, renderer };
}

function globalFaceCount(world) {
  const faces = collectWorldFaces(world);
  return faces.opaque.length + faces.transparent.length;
}

describe('分块渲染器', () => {
  it('初始构建为每个块建立记录，且可见面总数等于整世界网格化结果', () => {
    const { world, renderer } = setup();
    expect(renderer.records.size).toBe(world.chunks.length);
    expect(renderer.visibleFaceCount).toBe(globalFaceCount(world));
  });

  it('删除边界方块后只重建相邻块，面数立即更新且无残留', () => {
    const { world, renderer } = setup();
    const before = renderer.visibleFaceCount;

    // 找一个位于块边界、且有方块的坐标。
    const chunkSize = world.chunkSize;
    let target = null;
    for (let y = 1; y < world.sizeY && !target; y += 1) {
      for (let z = 0; z < world.sizeZ && !target; z += 1) {
        const x = chunkSize; // 位于两个块的分界
        if (world.hasBlock(x, y, z) && world.hasBlock(x - 1, y, z)) {
          target = { x, y, z };
        }
      }
    }
    expect(target).not.toBeNull();

    world.remove(target.x, target.y, target.z);
    const rebuilt = renderer.rebuildDirty();

    // 自身块 + 相邻块；至少两个块需要重建。
    expect(rebuilt).toBeGreaterThanOrEqual(2);
    expect(renderer.visibleFaceCount).toBe(globalFaceCount(world));
    expect(renderer.visibleFaceCount).not.toBe(before);
  });

  it('重建块会替换旧几何，不会把旧 mesh 留在场景里', () => {
    const { renderer } = setup();
    const chunk = renderer.world.chunks.find((c) => {
      const record = renderer.records.get(c.key);
      return record && record.opaqueMesh;
    });
    expect(chunk).toBeTruthy();

    const recordBefore = renderer.records.get(chunk.key);
    const oldMesh = recordBefore.opaqueMesh;
    const oldGeometry = oldMesh.geometry;

    // 在块内改一个方块并只重建该块。
    const { minX, minY, minZ } = chunk;
    renderer.world.set(minX, minY + 1, minZ + 1, 'stone');
    renderer.rebuildChunk(chunk);

    const recordAfter = renderer.records.get(chunk.key);
    expect(recordAfter.opaqueMesh).not.toBe(oldMesh);
    expect(recordAfter.opaqueMesh.geometry).not.toBe(oldGeometry);
    // 旧 group 已从根节点移除。
    expect(renderer.root.children).not.toContain(recordBefore.group);
    expect(renderer.root.children).toContain(recordAfter.group);
  });

  it('透明块单独成 mesh，且不透明与透明材质分开', () => {
    const { renderer } = setup();
    let transparentMeshes = 0;
    let opaqueMeshes = 0;
    for (const record of renderer.records.values()) {
      if (record.opaqueMesh) opaqueMeshes += 1;
      transparentMeshes += record.transparentMeshes.size;
    }
    expect(opaqueMeshes).toBeGreaterThan(0);
    expect(transparentMeshes).toBeGreaterThan(0);

    const pickMeshes = renderer.getPickMeshes();
    expect(pickMeshes.length).toBe(opaqueMeshes + transparentMeshes);
    for (const mesh of pickMeshes) {
      expect(mesh.geometry.getAttribute('position')).toBeTruthy();
      expect(mesh.geometry.getIndex()).toBeTruthy();
    }
  });

  it('相机移动后透明网格的索引顺序会重排', () => {
    const { renderer } = setup();
    const snapshot = () =>
      [...renderer.records.values()].flatMap((record) =>
        [...record.transparentMeshes.values()].map((mesh) =>
          Array.from(mesh.geometry.getIndex().array.slice(0, 18)).join(','),
        ),
      );

    const first = renderer.updateTransparentSort({
      x: 40,
      y: 40,
      z: 40,
    });
    expect(first).toBe(true);
    const before = snapshot();

    const moved = renderer.updateTransparentSort({
      x: -40,
      y: 40,
      z: -40,
    });
    expect(moved).toBe(true);
    const after = snapshot();

    let changed = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) changed += 1;
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('恢复初始快照后渲染面数回到初始值', () => {
    const { world, renderer } = setup();
    const initial = renderer.visibleFaceCount;
    const snapshot = world.toSnapshot();

    world.set(1, 12, 1, 'stone');
    world.set(2, 12, 1, 'glass');
    world.remove(12, 3, 12);
    renderer.rebuildDirty();
    expect(renderer.visibleFaceCount).not.toBe(initial);

    world.loadSnapshot(snapshot);
    renderer.rebuildDirty();
    expect(renderer.visibleFaceCount).toBe(initial);
    expect(renderer.visibleFaceCount).toBe(globalFaceCount(world));
  });
});
