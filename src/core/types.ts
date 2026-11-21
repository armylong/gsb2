import type { Vector3 } from 'three';

/**
 * 标注点锚定在网格的某个三角形上，使用重心坐标保存。
 * 这样模型旋转 / 变形后，点依然落在同一块表面区域，不会漂移。
 */
export interface SurfaceAnchor {
  tri: number;
  /** [b0, b1, b2]，分别对应三角形 0/1/2 号顶点，和为 1 */
  bary: [number, number, number];
}

export type PathMethod = 'same-triangle' | 'smoothed' | 'midpoint';

export interface SegmentPathOk {
  ok: true;
  /** 网格局部坐标下的折线（已按三角形边界细分，每段都落在单个三角面上） */
  points: Vector3[];
  /** 每条折线段所属的网格三角形，长度 = points.length - 1 */
  pointTriangles: number[];
  /** 该段路线经过的表面三角形序列（A* 结果） */
  triangles: number[];
  /** 折线长度（世界单位，模型未缩放时等于场景单位） */
  length: number;
  method: PathMethod;
}

export interface SegmentPathFail {
  ok: false;
  reason: 'disconnected' | 'no-path' | 'invalid-anchor';
  points: [];
  pointTriangles: [];
  triangles: [];
  length: 0;
}

export type SegmentPath = SegmentPathOk | SegmentPathFail;

export interface ClosestSurfaceHit {
  tri: number;
  bary: [number, number, number];
  point: Vector3;
  distance: number;
}
