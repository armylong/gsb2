/**
 * 网格构建：把每个虚线区间的多边形用 earcut 三角化，合并为一份网格数据。
 * 不做路径布尔运算：各区间独立三角化，重叠区域不消除。
 */
import earcut from 'earcut';
import { Vec2 } from './math2d';
import { PolyPath } from './path';
import { planDashes, DashOptions } from './dash';
import { buildIntervalPolygon, JoinInfo } from './stroke';
import { StrokeOptions } from './types';

export interface StrokeMeshData {
  /** 三维位置（z=0），可直接交给 THREE.BufferAttribute */
  positions: Float32Array;
  /** 三角形索引（位置数组下标） */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** 每个区间的二维多边形（用于边线显示/验证） */
  polygons: Vec2[][];
  joins: JoinInfo[];
  intervalCount: number;
}

export interface BuildResult {
  mesh: StrokeMeshData | null;
  totalLength: number;
}

export function buildStrokeMesh(
  rawPoints: Vec2[],
  closed: boolean,
  stroke: StrokeOptions,
  dash: DashOptions,
): BuildResult {
  const path = new PolyPath(rawPoints, closed);
  if (!path.isValid || stroke.width <= 0) {
    return { mesh: null, totalLength: path.totalLength };
  }

  const intervals = planDashes(path, dash);
  const flat: number[] = [];
  const indices: number[] = [];
  const polygons: Vec2[][] = [];
  const joins: JoinInfo[] = [];
  let basePair = 0;

  for (const iv of intervals) {
    const { polygon, joins: js } = buildIntervalPolygon(path, iv.u0, iv.u1, stroke, iv.fullLoop);
    if (polygon.length < 3) continue;
    polygons.push(polygon);
    joins.push(...js);

    const coords: number[] = [];
    for (const p of polygon) coords.push(p.x, p.y);
    const tris = earcut(coords, undefined, 2);
    for (const t of tris) indices.push(basePair + t);
    for (let i = 0; i < polygon.length; i++) {
      flat.push(polygon[i].x, polygon[i].y, 0);
    }
    basePair += polygon.length;
  }

  if (basePair === 0) return { mesh: null, totalLength: path.totalLength };

  return {
    mesh: {
      positions: new Float32Array(flat),
      indices: new Uint32Array(indices),
      vertexCount: basePair,
      triangleCount: indices.length / 3,
      polygons,
      joins,
      intervalCount: intervals.length,
    },
    totalLength: path.totalLength,
  };
}
