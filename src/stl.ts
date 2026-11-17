/**
 * 网格导出：二进制 STL + JSON 元数据。
 * STL 顶点与画面使用同一份 BufferGeometry 数据，坐标系、朝向完全一致。
 */

import type { Mesh } from './marchingTets';

export interface ExportMeta {
  sampleId: string;
  sampleLabel: string;
  iso: number;
  resolution: number;
  units: string;
  rangeMin: number;
  rangeMax: number;
  gridSpacing: number;
  triangleCount: number;
  vertexCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  exportedAt: string;
  format: string;
}

/** 生成二进制 STL（小端）。facet 法线由顶点顺序计算，与顶点法线朝向一致。 */
export function meshToSTL(mesh: Mesh): ArrayBuffer {
  const triCount = mesh.triangleCount;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = 'SDF isosurface export (su)';
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  }
  view.setUint32(80, triCount, true);
  let offset = 84;
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 0; }
    view.setFloat32(offset, nx, true); offset += 4;
    view.setFloat32(offset, ny, true); offset += 4;
    view.setFloat32(offset, nz, true); offset += 4;
    for (const v of [a, b, c]) {
      view.setFloat32(offset, p[v], true); offset += 4;
      view.setFloat32(offset, p[v + 1], true); offset += 4;
      view.setFloat32(offset, p[v + 2], true); offset += 4;
    }
    view.setUint16(offset, 0, true); offset += 2;
  }
  return buffer;
}

export function buildMeta(
  mesh: Mesh,
  info: {
    sampleId: string;
    sampleLabel: string;
    iso: number;
    resolution: number;
    units: string;
    rangeMin: number;
    rangeMax: number;
    gridSpacing: number;
  },
): ExportMeta {
  return {
    sampleId: info.sampleId,
    sampleLabel: info.sampleLabel,
    iso: info.iso,
    resolution: info.resolution,
    units: info.units,
    rangeMin: info.rangeMin,
    rangeMax: info.rangeMax,
    gridSpacing: info.gridSpacing,
    triangleCount: mesh.triangleCount,
    vertexCount: mesh.vertexCount,
    boundsMin: [...mesh.boundsMin],
    boundsMax: [...mesh.boundsMax],
    exportedAt: new Date().toISOString(),
    format: 'stl-binary + json-meta',
  };
}

/** 解析二进制 STL（测试/核对用）。 */
export function parseSTL(buffer: ArrayBuffer): { triangleCount: number; vertices: Float32Array; normals: Float32Array } {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const vertices = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 3);
  let offset = 84;
  for (let t = 0; t < triangleCount; t++) {
    normals[t * 3] = view.getFloat32(offset, true);
    normals[t * 3 + 1] = view.getFloat32(offset + 4, true);
    normals[t * 3 + 2] = view.getFloat32(offset + 8, true);
    offset += 12;
    for (let v = 0; v < 9; v++) {
      vertices[t * 9 + v] = view.getFloat32(offset, true);
      offset += 4;
    }
    offset += 2;
  }
  return { triangleCount, vertices, normals };
}
