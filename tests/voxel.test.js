import { describe, expect, it } from 'vitest';
import { VoxelWorld } from '../src/voxel/VoxelWorld.js';
import {
  FACE_DIRECTIONS,
  buildChunkGeometryData,
  collectChunkFaces,
  collectWorldFaces,
  isFaceVisible,
} from '../src/voxel/mesher.js';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_SIZE,
  createSampleWorld,
} from '../src/voxel/scene.js';

function makeWorld({ size = [8, 8, 8], chunkSize = 4 } = {}) {
  return new VoxelWorld({ size, chunkSize });
}

function faceKey(face) {
  return `${face.x},${face.y},${face.z}:${face.direction}:${face.material}`;
}

function sortedKeys(faces) {
  return faces.map(faceKey).sort();
}

function allFacesFromChunks(world) {
  const faces = [];
  for (const chunk of world.chunks) {
    const result = collectChunkFaces(world, chunk);
    faces.push(...result.opaque, ...result.transparent);
  }
  return faces;
}

describe('相邻方块增删', () => {
  it('单个方块的六个面全部可见', () => {
    const world = makeWorld();
    world.set(2, 2, 2, 'stone');
    const { opaque, transparent } = collectWorldFaces(world);
    expect(opaque).toHaveLength(6);
    expect(transparent).toHaveLength(0);
  });

  it('相邻实心方块之间不显示内部面', () => {
    const world = makeWorld();
    world.set(2, 2, 2, 'stone');
    world.set(3, 2, 2, 'stone');

    const { opaque } = collectWorldFaces(world);
    expect(opaque).toHaveLength(10);
    expect(opaque.some((f) => f.x === 2 && f.direction === '+x')).toBe(false);
    expect(opaque.some((f) => f.x === 3 && f.direction === '-x')).toBe(false);
  });

  it('删除相邻方块后表面恢复，且不残留旧面', () => {
    const world = makeWorld();
    world.set(2, 2, 2, 'stone');
    world.set(3, 2, 2, 'stone');
    expect(collectWorldFaces(world).opaque).toHaveLength(10);

    world.remove(3, 2, 2);
    const faces = collectWorldFaces(world).opaque;
    expect(faces).toHaveLength(6);
    expect(faces.some((f) => f.x === 2 && f.direction === '+x')).toBe(true);
  });

  it('重复添加/删除同一位置不会产生多余变化', () => {
    const world = makeWorld();
    expect(world.add(1, 1, 1, 'stone')).toBe(true);
    expect(world.add(1, 1, 1, 'dirt')).toBe(false);
    expect(world.remove(1, 1, 1)).toBe(true);
    expect(world.remove(1, 1, 1)).toBe(false);
    expect(world.getStats().total).toBe(0);
  });
});

describe('跨块边界', () => {
  it('跨两个块相邻的方块共享面被正确剔除', () => {
    const world = makeWorld({ size: [8, 8, 8], chunkSize: 4 });
    world.set(3, 2, 2, 'stone'); // 块 0
    world.set(4, 2, 2, 'stone'); // 块 1

    const { opaque } = collectWorldFaces(world);
    expect(opaque).toHaveLength(10);
    expect(opaque.some((f) => f.x === 3 && f.direction === '+x')).toBe(false);
    expect(opaque.some((f) => f.x === 4 && f.direction === '-x')).toBe(false);

    const fromChunks = allFacesFromChunks(world);
    expect(sortedKeys(fromChunks)).toEqual(sortedKeys(opaque));
  });

  it('编辑边界方块后两侧块同时标记为脏', () => {
    const world = makeWorld({ size: [8, 8, 8], chunkSize: 4 });
    world.consumeDirtyChunks();

    world.set(3, 2, 2, 'stone');
    const dirty = world.consumeDirtyChunks().map((chunk) => chunk.key).sort();
    // x=3 位于块 0，但 +x 邻居在块 1，两块的边界都必须重建。
    expect(dirty).toContain('0,0,0');
    expect(dirty).toContain('1,0,0');
  });

  it('分块结果与整世界结果完全一致（无重复、无缺失）', () => {
    const world = createSampleWorld();
    const global = collectWorldFaces(world);
    const chunked = allFacesFromChunks(world);

    expect(sortedKeys(chunked)).toEqual(sortedKeys(global.opaque.concat(global.transparent)));
    expect(chunked).toHaveLength(global.opaque.length + global.transparent.length);
  });

  it('增量重建后的块数据等于全量重建', () => {
    const world = createSampleWorld();
    const keysBefore = new Map();
    for (const chunk of world.chunks) {
      keysBefore.set(chunk.key, sortedKeys(collectChunkFaces(world, chunk).opaque));
    }

    // 沿块边界连续编辑。
    for (let x = 4; x <= 14; x += 1) {
      world.set(x, 10, 5, 'stone');
    }
    world.remove(9, 3, 6);
    world.set(12, 9, 12, 'glass');

    // 逐块重建 = 直接根据当前世界重新收集。
    world.consumeDirtyChunks();
    for (const chunk of world.chunks) {
      const incremental = collectChunkFaces(world, chunk);
      const globalFaces = collectWorldFaces(world);
      const expected = globalFaces.opaque
        .concat(globalFaces.transparent)
        .filter(
          (face) =>
            face.x >= chunk.minX &&
            face.x < chunk.maxX &&
            face.y >= chunk.minY &&
            face.y < chunk.maxY &&
            face.z >= chunk.minZ &&
            face.z < chunk.maxZ,
        );
      expect(sortedKeys(incremental.opaque.concat(incremental.transparent))).toEqual(
        sortedKeys(expected),
      );
    }
    expect(keysBefore.size).toBe(world.chunks.length);
  });

  it('世界边缘的方块仍有外表面', () => {
    const world = makeWorld({ size: [4, 4, 4], chunkSize: 4 });
    world.set(0, 0, 0, 'stone');
    const { opaque } = collectWorldFaces(world);
    expect(opaque).toHaveLength(6);
  });
});

describe('透明交界', () => {
  it('实心与玻璃交界处，实心表面可见、玻璃共面不可见', () => {
    const world = makeWorld();
    world.set(2, 2, 2, 'stone');
    world.set(3, 2, 2, 'glass');

    const { opaque, transparent } = collectWorldFaces(world);

    expect(opaque.some((f) => f.x === 2 && f.direction === '+x')).toBe(true);
    expect(transparent.some((f) => f.x === 3 && f.direction === '-x')).toBe(false);
    expect(transparent.some((f) => f.x === 3 && f.direction === '+x')).toBe(true);
    expect(opaque).toHaveLength(6);
    expect(transparent).toHaveLength(5);
  });

  it('两个玻璃相邻时不显示内部共面', () => {
    const world = makeWorld();
    world.set(2, 2, 2, 'glass');
    world.set(3, 2, 2, 'glass');
    const { transparent } = collectWorldFaces(world);
    expect(transparent).toHaveLength(10);
    expect(transparent.some((f) => f.x === 2 && f.direction === '+x')).toBe(false);
    expect(transparent.some((f) => f.x === 3 && f.direction === '-x')).toBe(false);
  });

  it('玻璃与石头包围空气时，空气侧的面全部可见', () => {
    expect(isFaceVisible('stone', null)).toBe(true);
    expect(isFaceVisible('glass', null)).toBe(true);
    expect(isFaceVisible('stone', 'stone')).toBe(false);
    expect(isFaceVisible('stone', 'glass')).toBe(true);
    expect(isFaceVisible('glass', 'stone')).toBe(false);
    expect(isFaceVisible('glass', 'water')).toBe(false);
    expect(isFaceVisible('glass', 'glass')).toBe(false);
  });

  it('透明材质在块几何数据中单独分组', () => {
    const world = makeWorld({ size: [8, 8, 8], chunkSize: 4 });
    world.set(1, 1, 1, 'water');
    world.set(2, 1, 1, 'glass');
    const chunk = world.chunkByKey.get('0,0,0');
    const data = buildChunkGeometryData(world, chunk);
    expect(data.transparent).toHaveLength(2);
    expect(new Set(data.transparent.map((t) => t.material))).toEqual(
      new Set(['water', 'glass']),
    );
    const totalTransparentFaces = data.transparent.reduce(
      (sum, entry) => sum + entry.data.faceCount,
      0,
    );
    expect(totalTransparentFaces).toBe(10);
  });
});

describe('重置与统计', () => {
  it('恢复快照后统计、面数据与初始状态一致', () => {
    const world = createSampleWorld();
    const snapshot = world.toSnapshot();
    const statsBefore = world.getStats();
    const facesBefore = sortedKeys(allFacesFromChunks(world));

    world.set(0, 14, 0, 'stone');
    world.remove(10, 2, 4);
    world.set(20, 10, 20, 'glass');
    expect(world.getStats().total).not.toBe(statsBefore.total);

    world.loadSnapshot(snapshot);

    expect(world.getStats()).toEqual(statsBefore);
    expect(sortedKeys(allFacesFromChunks(world))).toEqual(facesBefore);
  });

  it('清空后统计为零且没有任何面，再恢复样例后完全复原', () => {
    const world = createSampleWorld();
    const snapshot = world.toSnapshot();
    const statsBefore = world.getStats();
    const facesBefore = sortedKeys(allFacesFromChunks(world));

    world.clear();
    expect(world.getStats().total).toBe(0);
    expect(collectWorldFaces(world).opaque).toHaveLength(0);
    expect(collectWorldFaces(world).transparent).toHaveLength(0);

    world.loadSnapshot(snapshot);
    expect(world.getStats()).toEqual(statsBefore);
    expect(sortedKeys(allFacesFromChunks(world))).toEqual(facesBefore);
  });

  it('统计结果来自实际格子，不依赖增量缓存', () => {
    const world = createSampleWorld();
    const stats = world.getStats();
    let counted = 0;
    let transparent = 0;
    for (let index = 0; index < world.cells.length; index += 1) {
      if (world.cells[index] === 0) continue;
      counted += 1;
      if (world.get(...indexToCoord(world, index)) === 'glass') transparent += 1;
      if (world.get(...indexToCoord(world, index)) === 'water') transparent += 1;
    }
    expect(stats.total).toBe(counted);
    expect(stats.transparent).toBe(transparent);
    expect(stats.opaque + stats.transparent).toBe(stats.total);
  });

  it('恢复初始样例后尺寸与分块配置固定', () => {
    const world = createSampleWorld();
    expect(world.size).toEqual([...DEFAULT_SIZE]);
    expect(world.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(world.getStats().total).toBeGreaterThan(0);
  });
});

describe('几何数据', () => {
  it('每个可见面生成 4 顶点、6 索引，且索引指向有效顶点', () => {
    const world = makeWorld();
    world.set(1, 1, 1, 'stone');
    world.set(2, 1, 1, 'glass');
    const chunk = world.chunkByKey.get('0,0,0');
    const data = buildChunkGeometryData(world, chunk);

    expect(data.opaque.positions).toHaveLength(6 * 4 * 3);
    expect(data.opaque.indices).toHaveLength(6 * 6);
    const maxIndex = Math.max(...data.opaque.indices);
    expect(maxIndex).toBeLessThan(data.opaque.positions.length / 3);

    const glass = data.transparent.find((entry) => entry.material === 'glass');
    expect(glass.data.positions).toHaveLength(5 * 4 * 3);
    expect(glass.data.indices).toHaveLength(5 * 6);
  });

  it('每个面的法线与定义方向一致', () => {
    const world = makeWorld();
    world.set(1, 1, 1, 'stone');
    const chunk = world.chunkByKey.get('0,0,0');
    const data = buildChunkGeometryData(world, chunk);
    for (let i = 0; i < data.opaque.normals.length; i += 3) {
      const normal = [data.opaque.normals[i], data.opaque.normals[i + 1], data.opaque.normals[i + 2]];
      const matched = FACE_DIRECTIONS.some(
        (direction) =>
          direction.normal[0] === normal[0] &&
          direction.normal[1] === normal[1] &&
          direction.normal[2] === normal[2],
      );
      expect(matched).toBe(true);
    }
  });
});

function indexToCoord(world, index) {
  const x = index % world.sizeX;
  const z = Math.floor(index / world.sizeX) % world.sizeZ;
  const y = Math.floor(index / (world.sizeX * world.sizeZ));
  return [x, y, z];
}
