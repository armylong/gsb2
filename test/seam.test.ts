import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_RES, CHUNK_COUNT, CHUNK_SIZE, LOD_STEPS, WORLD_MIN } from '../src/terrain/config';
import { buildChunkMesh, extractEdgePositions } from '../src/terrain/chunkMesher';

const SEED = 1337;

test('固定种子下网格构建可复现', () => {
  const a = buildChunkMesh(3, 5, 1, SEED);
  const b = buildChunkMesh(3, 5, 1, SEED);
  assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
  assert.deepEqual(Array.from(a.indices), Array.from(b.indices));
});

test('LOD 越高三角形与顶点真实减少(不是改颜色或隐藏三角形)', () => {
  const m0 = buildChunkMesh(0, 0, 0, SEED);
  const m1 = buildChunkMesh(0, 0, 1, SEED);
  const m2 = buildChunkMesh(0, 0, 2, SEED);
  assert.ok(m0.vertexCount > m1.vertexCount, `v ${m0.vertexCount} > ${m1.vertexCount}`);
  assert.ok(m1.vertexCount > m2.vertexCount, `v ${m1.vertexCount} > ${m2.vertexCount}`);
  assert.ok(m0.triangleCount > m1.triangleCount);
  assert.ok(m1.triangleCount > m2.triangleCount);
  // 最粗层级的三角形数量应远小于最细层级
  assert.ok(m2.triangleCount < m0.triangleCount * 0.35);
});

test('每条公共边缘恰好包含 BASE_RES+1 个全分辨率顶点,且所有 LOD 一致', () => {
  for (const lod of [0, 1, 2]) {
    const m = buildChunkMesh(2, 3, lod, SEED);
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      const edge = extractEdgePositions(m, side);
      assert.equal(edge.length, BASE_RES + 1, `lod${lod} ${side} 边缘顶点数`);
    }
  }
});

test('相邻块不同 LOD 时公共边缘顶点世界坐标完全一致(无裂缝)', () => {
  // 让相邻块分别处于 LOD0 与 LOD2
  const left = buildChunkMesh(2, 3, 0, SEED);
  const right = buildChunkMesh(3, 3, 2, SEED);
  const east = extractEdgePositions(left, 'east');
  const west = extractEdgePositions(right, 'west');
  assert.equal(east.length, west.length);
  for (let i = 0; i < east.length; i++) {
    assert.ok(Math.abs(east[i][0] - west[i][0]) < 1e-6);
    assert.ok(Math.abs(east[i][1] - west[i][1]) < 1e-6, '边缘高度必须一致');
    assert.ok(Math.abs(east[i][2] - west[i][2]) < 1e-6);
  }
});

test('纵向相邻块不同 LOD 时公共边缘同样闭合', () => {
  const a = buildChunkMesh(4, 4, 1, SEED);
  const b = buildChunkMesh(4, 5, 0, SEED);
  const north = extractEdgePositions(a, 'north');
  const south = extractEdgePositions(b, 'south');
  assert.equal(north.length, south.length);
  for (let i = 0; i < north.length; i++) {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(north[i][k] - south[i][k]) < 1e-6);
    }
  }
});

test('角点处四块共享同一世界坐标顶点(多块交界完整)', () => {
  // 角点 (cx=3,cz=3) 的东北角 = (4,3) 西北角 = (3,4) 东南角 = (4,4) 西南角
  const cornerX = WORLD_MIN + 4 * CHUNK_SIZE;
  const cornerZ = WORLD_MIN + 4 * CHUNK_SIZE;
  const meshes = [
    buildChunkMesh(3, 3, 0, SEED),
    buildChunkMesh(4, 3, 1, SEED),
    buildChunkMesh(3, 4, 2, SEED),
    buildChunkMesh(4, 4, 0, SEED),
  ];
  const heights = meshes.map((m) => {
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[i * 3];
      const z = m.positions[i * 3 + 2];
      if (Math.abs(x - cornerX) < 1e-6 && Math.abs(z - cornerZ) < 1e-6) {
        return m.positions[i * 3 + 1];
      }
    }
    throw new Error('角点顶点缺失');
  });
  for (const h of heights) assert.ok(Math.abs(h - heights[0]) < 1e-6);
});

test('网格全部索引指向有效顶点且拓扑完整(宏单元多边形环铺满块面)', () => {
  for (const lod of [0, 1, 2]) {
    const m = buildChunkMesh(1, 1, lod, SEED);
    for (const idx of m.indices) {
      assert.ok(idx >= 0 && idx < m.vertexCount);
    }
    const k = LOD_STEPS[lod];
    const macroCells = (BASE_RES / k) * (BASE_RES / k);
    // 每个宏单元至少 2 个三角形(内部四边形),贴边界的宏单元因细分点更多
    assert.ok(m.triangleCount >= macroCells * 2, `lod${lod} triangles=${m.triangleCount}`);
    // 无退化三角形:每条索引三元组引用 3 个不同顶点
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      assert.notEqual(a, b);
      assert.notEqual(b, c);
      assert.notEqual(a, c);
    }
  }
});

test('LOD 步长配置为 1/2/4', () => {
  assert.deepEqual([...LOD_STEPS], [1, 2, 4]);
  assert.equal(CHUNK_COUNT * CHUNK_SIZE, 320);
});
