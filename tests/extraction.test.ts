/**
 * 关键验证：提取正确性（尺寸/坐标/并集/空表面/边界截断/朝向）。
 */
import { describe, it, expect } from 'vitest';
import { getSample, sampleGrid } from '../src/field';
import { extractIsosurface, signedVolume, countBoundaryEdges } from '../src/marchingTets';

const N = 48;

describe('单球样例：尺寸与坐标', () => {
  const grid = sampleGrid(getSample('single'), N);
  const mesh = extractIsosurface(grid, 0);
  const h = grid.h;

  it('提取出非空网格', () => {
    expect(mesh.triangleCount).toBeGreaterThan(1000);
  });

  it('网格边界与球心±半径一致（误差 < h），无轴交换/镜像/平移', () => {
    for (let a = 0; a < 3; a++) {
      expect(mesh.boundsMin[a]).toBeGreaterThan(-5 - h);
      expect(mesh.boundsMin[a]).toBeLessThanOrEqual(-5 + h);
      expect(mesh.boundsMax[a]).toBeLessThan(5 + h);
      expect(mesh.boundsMax[a]).toBeGreaterThanOrEqual(5 - h);
    }
  });

  it('顶点质心位于球心（原点）附近', () => {
    let cx = 0, cy = 0, cz = 0;
    const n = mesh.vertexCount;
    for (let v = 0; v < n; v++) {
      cx += mesh.positions[v * 3];
      cy += mesh.positions[v * 3 + 1];
      cz += mesh.positions[v * 3 + 2];
    }
    expect(Math.abs(cx / n)).toBeLessThan(h);
    expect(Math.abs(cy / n)).toBeLessThan(h);
    expect(Math.abs(cz / n)).toBeLessThan(h);
  });

  it('有符号体积为正且接近球体体积（朝向正确、闭合）', () => {
    const vol = signedVolume(mesh.positions, mesh.indices);
    const exact = (4 / 3) * Math.PI * 125;
    expect(vol).toBeGreaterThan(0);
    expect(Math.abs(vol - exact) / exact).toBeLessThan(0.03);
  });

  it('闭合网格：无边界边', () => {
    expect(countBoundaryEdges(mesh.indices)).toBe(0);
  });

  it('所有顶点到球心距离 ≈ 半径（误差 < h）', () => {
    for (let v = 0; v < mesh.vertexCount; v += 7) {
      const r = Math.hypot(
        mesh.positions[v * 3],
        mesh.positions[v * 3 + 1],
        mesh.positions[v * 3 + 2],
      );
      expect(Math.abs(r - 5)).toBeLessThan(h);
    }
  });
});

describe('两球相交样例：并集', () => {
  const grid = sampleGrid(getSample('intersecting'), N);
  const mesh = extractIsosurface(grid, 0);
  const h = grid.h;

  it('网格边界与并集范围一致（x: ±7.5, y/z: ±4.5，误差 < h）', () => {
    const expectMin = [-7.5, -4.5, -4.5];
    const expectMax = [7.5, 4.5, 4.5];
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(mesh.boundsMin[a] - expectMin[a])).toBeLessThan(h);
      expect(Math.abs(mesh.boundsMax[a] - expectMax[a])).toBeLessThan(h);
    }
  });

  it('有符号体积接近并集解析体积 225π', () => {
    const vol = signedVolume(mesh.positions, mesh.indices);
    const exact = 225 * Math.PI; // 2 球体积 − 透镜交集
    expect(vol).toBeGreaterThan(0);
    expect(Math.abs(vol - exact) / exact).toBeLessThan(0.05);
  });

  it('交线区域存在：x≈0 处有顶点且 |y|≈√11.25', () => {
    // 两球面交线位于 x=0 平面、半径 √11.25 ≈ 3.354 的圆上
    const rIntersect = Math.sqrt(11.25);
    let found = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.positions[v * 3];
      const y = mesh.positions[v * 3 + 1];
      const z = mesh.positions[v * 3 + 2];
      if (Math.abs(x) < h * 0.6 && Math.abs(Math.hypot(y, z) - rIntersect) < h) found++;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('闭合网格：无边界边', () => {
    expect(countBoundaryEdges(mesh.indices)).toBe(0);
  });
});

describe('空表面', () => {
  const grid = sampleGrid(getSample('single'), 32);

  it('阈值高于场最大值 → 0 三角形', () => {
    const mesh = extractIsosurface(grid, 100);
    expect(mesh.triangleCount).toBe(0);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.positions.length).toBe(0);
  });

  it('阈值低于场最小值 → 0 三角形', () => {
    const mesh = extractIsosurface(grid, -100);
    expect(mesh.triangleCount).toBe(0);
    expect(mesh.vertexCount).toBe(0);
  });
});

describe('两球分离样例：边界截断', () => {
  const grid = sampleGrid(getSample('separated'), N);
  const mesh = extractIsosurface(grid, 0);
  const h = grid.h;

  it('左侧完整球边界 ≈ [-8, -2]（误差 < h）', () => {
    expect(Math.abs(mesh.boundsMin[0] - -8)).toBeLessThan(h);
  });

  it('右侧球在采样边界 x=10 处截断：maxX 恰好到边界且不越界', () => {
    expect(mesh.boundsMax[0]).toBeGreaterThan(10 - 1e-3);
    expect(mesh.boundsMax[0]).toBeLessThanOrEqual(10 + 1e-6);
    for (let v = 0; v < mesh.vertexCount; v++) {
      for (let a = 0; a < 3; a++) {
        const val = mesh.positions[v * 3 + a];
        expect(val).toBeGreaterThanOrEqual(-10 - 1e-4);
        expect(val).toBeLessThanOrEqual(10 + 1e-4);
      }
    }
  });

  it('截断处开口：存在边界边，且有顶点恰好落在 x=10 边界面上', () => {
    expect(countBoundaryEdges(mesh.indices)).toBeGreaterThan(0);
    let onBoundary = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      if (Math.abs(mesh.positions[v * 3] - 10) < 1e-4) onBoundary++;
    }
    expect(onBoundary).toBeGreaterThan(4);
  });

  it('截断不额外封口：x=10 处的顶点都位于截断圆附近（|y|,|z| ≤ r+h）', () => {
    // 球2 球心 (7.5,0,0) r=4，x=10 处截面圆半径 sqrt(16-6.25)≈3.122
    const rCross = Math.sqrt(16 - 6.25);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.positions[v * 3];
      if (Math.abs(x - 10) < 1e-4) {
        const r = Math.hypot(mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
        expect(r).toBeLessThan(rCross + h);
      }
    }
  });
});

describe('阈值语义', () => {
  const grid = sampleGrid(getSample('single'), N);

  it('负阈值表面内缩、正阈值表面外扩（SDF 含义：场值=到球面距离，内负外正）', () => {
    const mNeg = extractIsosurface(grid, -1);
    const mZero = extractIsosurface(grid, 0);
    const mPos = extractIsosurface(grid, 1);
    expect(mNeg.boundsMax[0]).toBeLessThan(mZero.boundsMax[0]);
    expect(mZero.boundsMax[0]).toBeLessThan(mPos.boundsMax[0]);
    // 半径变化量 ≈ 1（误差 < h）
    expect(Math.abs(mNeg.boundsMax[0] - 4)).toBeLessThan(grid.h);
    expect(Math.abs(mPos.boundsMax[0] - 6)).toBeLessThan(grid.h);
  });
});
