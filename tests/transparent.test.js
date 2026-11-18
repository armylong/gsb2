import { describe, expect, it } from 'vitest';
import { sortIndicesBackToFront } from '../src/render/transparentSort.js';

function triCenter(positions, indices, triangle) {
  const base = triangle * 3;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k < 3; k += 1) {
    const v = indices[base + k];
    x += positions[v * 3];
    y += positions[v * 3 + 1];
    z += positions[v * 3 + 2];
  }
  return [x / 3, y / 3, z / 3];
}

describe('透明面排序', () => {
  it('按相机距离从远到近排列三角形', () => {
    // 三个四边形面沿 z 排列：z=0 最远，z=2 最近。
    const positions = [];
    const indices = [];
    for (let i = 0; i < 3; i += 1) {
      const z = i;
      const base = positions.length / 3;
      positions.push(0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const camera = { x: 0, y: 0, z: 10 };
    const sorted = sortIndicesBackToFront(positions, indices, camera);

    expect(sorted).toHaveLength(indices.length);
    // 每个四边形由 2 个三角形组成，共 6 个；首尾即最远/最近。
    expect(triCenter(positions, sorted, 0)[2]).toBe(0);
    expect(triCenter(positions, sorted, 5)[2]).toBe(2);
    for (let t = 0; t < 6; t += 1) {
      if (t > 0) {
        expect(triCenter(positions, sorted, t)[2]).toBeGreaterThanOrEqual(
          triCenter(positions, sorted, t - 1)[2],
        );
      }
    }
  });

  it('相机换到另一侧后顺序反转', () => {
    const positions = [];
    const indices = [];
    for (let i = 0; i < 3; i += 1) {
      const z = i;
      const base = positions.length / 3;
      positions.push(0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const camera = { x: 0, y: 0, z: -10 };
    const sorted = sortIndicesBackToFront(positions, indices, camera);
    // 相机在负 z 侧时，z=2 最远、z=0 最近。
    expect(triCenter(positions, sorted, 0)[2]).toBe(2);
    expect(triCenter(positions, sorted, 5)[2]).toBe(0);
  });

  it('不修改原始索引数组', () => {
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0];
    const indices = [0, 1, 2];
    const copy = [...indices];
    sortIndicesBackToFront(positions, indices, { x: 0, y: 0, z: 5 });
    expect(indices).toEqual(copy);
  });

  it('原地复用输出缓存，结果与新建时一致', () => {
    const positions = [];
    const indices = [];
    for (let i = 0; i < 4; i += 1) {
      const z = (i * 7) % 5;
      const base = positions.length / 3;
      positions.push(0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const camera = { x: 3, y: 4, z: 5 };
    const cache = new Float64Array(indices.length / 3);
    const a = sortIndicesBackToFront(positions, indices, camera, cache);
    const b = sortIndicesBackToFront(positions, indices, camera, cache);
    expect(a).toEqual(b);
  });
});
