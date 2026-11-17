/**
 * 后台提取 Worker：接收 (sampleId, iso, resolution)，
 * 采样标量场并执行 Marching Tetrahedra，返回可转移的网格数据。
 */

import { getSample, sampleGrid } from './field';
import { extractIsosurface } from './marchingTets';

export interface ExtractRequest {
  id: number;
  sampleId: string;
  iso: number;
  resolution: number;
}

export interface ExtractSuccess {
  id: number;
  ok: true;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  /** 采样网格场值（切片显示使用，与提取同一份数据） */
  gridValues: Float32Array;
  gridN: number;
  gridSpacing: number;
  fieldMin: number;
  fieldMax: number;
  elapsedMs: number;
}

export interface ExtractFailure {
  id: number;
  ok: false;
  error: string;
}

export type ExtractResponse = ExtractSuccess | ExtractFailure;

self.onmessage = (ev: MessageEvent<ExtractRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  try {
    const sample = getSample(req.sampleId);
    const grid = sampleGrid(sample, req.resolution);
    const mesh = extractIsosurface(grid, req.iso);
    const res: ExtractSuccess = {
      id: req.id,
      ok: true,
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      triangleCount: mesh.triangleCount,
      vertexCount: mesh.vertexCount,
      boundsMin: mesh.boundsMin,
      boundsMax: mesh.boundsMax,
      gridValues: grid.values,
      gridN: grid.n,
      gridSpacing: grid.h,
      fieldMin: grid.minValue,
      fieldMax: grid.maxValue,
      elapsedMs: performance.now() - t0,
    };
    (self as unknown as Worker).postMessage(res, [
      res.positions.buffer,
      res.normals.buffer,
      res.indices.buffer,
      res.gridValues.buffer,
    ]);
  } catch (err) {
    const res: ExtractFailure = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(res);
  }
};
