/**
 * 关键验证：导出数据核对（STL 顶点/朝向/边界与内存网格一致，元数据匹配）。
 */
import { describe, it, expect } from 'vitest';
import { getSample, sampleGrid } from '../src/field';
import { extractIsosurface, signedVolume } from '../src/marchingTets';
import { meshToSTL, parseSTL, buildMeta } from '../src/stl';

const grid = sampleGrid(getSample('single'), 40);
const mesh = extractIsosurface(grid, 0);

describe('STL 导出核对', () => {
  const stl = meshToSTL(mesh);
  const parsed = parseSTL(stl);

  it('三角形数量一致', () => {
    expect(parsed.triangleCount).toBe(mesh.triangleCount);
    expect(stl.byteLength).toBe(84 + mesh.triangleCount * 50);
  });

  it('顶点坐标与内存网格逐一一致', () => {
    for (let t = 0; t < mesh.triangleCount; t += 13) {
      for (let v = 0; v < 3; v++) {
        const srcIdx = mesh.indices[t * 3 + v] * 3;
        for (let a = 0; a < 3; a++) {
          expect(parsed.vertices[t * 9 + v * 3 + a]).toBeCloseTo(mesh.positions[srcIdx + a], 5);
        }
      }
    }
  });

  it('facet 法线朝外：与 (顶点−球心) 点积为正', () => {
    for (let t = 0; t < parsed.triangleCount; t += 11) {
      const cx = (parsed.vertices[t * 9] + parsed.vertices[t * 9 + 3] + parsed.vertices[t * 9 + 6]) / 3;
      const cy = (parsed.vertices[t * 9 + 1] + parsed.vertices[t * 9 + 4] + parsed.vertices[t * 9 + 7]) / 3;
      const cz = (parsed.vertices[t * 9 + 2] + parsed.vertices[t * 9 + 5] + parsed.vertices[t * 9 + 8]) / 3;
      const dot =
        parsed.normals[t * 3] * cx + parsed.normals[t * 3 + 1] * cy + parsed.normals[t * 3 + 2] * cz;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('解析回的 STL 有符号体积为正且接近球体体积', () => {
    // 用解析出的独立三角形重建索引网格计算体积
    const idx = new Uint32Array(parsed.triangleCount * 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    const vol = signedVolume(parsed.vertices, idx);
    const exact = (4 / 3) * Math.PI * 125;
    expect(vol).toBeGreaterThan(0);
    expect(Math.abs(vol - exact) / exact).toBeLessThan(0.05);
  });

  it('导出边界与内存网格边界一致', () => {
    let minX = Infinity, maxX = -Infinity;
    for (let v = 0; v < parsed.vertices.length; v += 3) {
      minX = Math.min(minX, parsed.vertices[v]);
      maxX = Math.max(maxX, parsed.vertices[v]);
    }
    expect(minX).toBeCloseTo(mesh.boundsMin[0], 5);
    expect(maxX).toBeCloseTo(mesh.boundsMax[0], 5);
  });
});

describe('导出元数据', () => {
  it('记录样例/阈值/分辨率/坐标范围，与网格统计一致', () => {
    const meta = buildMeta(mesh, {
      sampleId: 'single',
      sampleLabel: '单球（闭合）',
      iso: 0,
      resolution: 40,
      units: 'su',
      rangeMin: -10,
      rangeMax: 10,
      gridSpacing: grid.h,
    });
    expect(meta.sampleId).toBe('single');
    expect(meta.iso).toBe(0);
    expect(meta.resolution).toBe(40);
    expect(meta.rangeMin).toBe(-10);
    expect(meta.rangeMax).toBe(10);
    expect(meta.units).toBe('su');
    expect(meta.triangleCount).toBe(mesh.triangleCount);
    expect(meta.vertexCount).toBe(mesh.vertexCount);
    expect(meta.boundsMax[0]).toBeCloseTo(mesh.boundsMax[0], 6);
    expect(meta.gridSpacing).toBeCloseTo(20 / 39, 9);
  });
});
