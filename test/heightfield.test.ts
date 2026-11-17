import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleHeight, queryHeight, isInsideTerrain } from '../src/terrain/heightfield';
import { buildChunkMesh, extractEdgePositions } from '../src/terrain/chunkMesher';
import { CHUNK_SIZE, HALF_TERRAIN, WORLD_MAX, WORLD_MIN } from '../src/terrain/config';

const SEED = 99;

test('同一种子同一坐标高度可复现,不同种子产生不同地形', () => {
  const h1 = sampleHeight(12.5, -33.2, SEED);
  const h2 = sampleHeight(12.5, -33.2, SEED);
  assert.equal(h1, h2);
  const hOther = sampleHeight(12.5, -33.2, SEED + 1);
  assert.notEqual(h1, hOther);
});

test('已知坐标在任意 LOD 网格中高度一致(查询以统一高度场为准)', () => {
  // 取块 (1,2) 内一个不会落在粗 LOD 格点上的坐标
  const x = WORLD_MIN + 1 * CHUNK_SIZE + 7.3;
  const z = WORLD_MIN + 2 * CHUNK_SIZE + 19.7;
  const fieldH = sampleHeight(x, z, SEED);
  const q = queryHeight(x, z, SEED);
  assert.equal(q.inside, true);
  assert.ok(Math.abs((q.height ?? NaN) - fieldH) < 1e-12);

  for (const lod of [0, 1, 2]) {
    const m = buildChunkMesh(1, 2, lod, SEED);
    let nearest = Infinity;
    for (let i = 0; i < m.vertexCount; i++) {
      const vx = m.positions[i * 3];
      const vz = m.positions[i * 3 + 2];
      nearest = Math.min(nearest, Math.hypot(vx - x, vz - z));
    }
    // 查询结果来自高度场本身,不依赖网格;网格最粗时该点附近仍有顶点覆盖
    assert.ok(nearest < 3.0, `lod${lod} 最近顶点距离 ${nearest}`);
  }
  // 边缘顶点高度在三个 LOD 下完全相同
  const edges = [0, 1, 2].map((lod) => extractEdgePositions(buildChunkMesh(1, 2, lod, SEED), 'north'));
  for (let i = 0; i < edges[0].length; i++) {
    assert.equal(edges[0][i][1], edges[1][i][1]);
    assert.equal(edges[0][i][1], edges[2][i][1]);
  }
});

test('地形外坐标明确判定为 outside,高度为 null 而非 0 或边界高度', () => {
  const cases: Array<[number, number]> = [
    [WORLD_MIN - 0.01, 0],
    [WORLD_MAX + 10, 0],
    [0, WORLD_MIN - 1],
    [HALF_TERRAIN + 50, HALF_TERRAIN + 50],
  ];
  for (const [x, z] of cases) {
    assert.equal(isInsideTerrain(x, z), false);
    const r = queryHeight(x, z, SEED);
    assert.equal(r.inside, false);
    assert.equal(r.height, null);
  }
});

test('边界上的坐标仍属于地形内并返回真实高度', () => {
  const r = queryHeight(WORLD_MAX, WORLD_MIN, SEED);
  assert.equal(r.inside, true);
  assert.notEqual(r.height, null);
  assert.equal(r.height, sampleHeight(WORLD_MAX, WORLD_MIN, SEED));
});

test('高度场呈现山脊、缓坡与低洼:范围内存在显著高低差', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= 64; i++) {
    for (let j = 0; j <= 64; j++) {
      const h = sampleHeight(-150 + i * 4.7, -150 + j * 4.7, SEED);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  assert.ok(max - min > 25, `高低差 ${max - min}`);
});
