import { closestPointOnMesh, angleBetweenDeg, type IndexTriple } from './geometry';
import { sourceTriangleNormal } from './mesh';
import type {
  RegionInspection,
  SampleGap,
  SurfaceModel,
  ThickenedSolid,
  Vec3,
  Side,
} from './types';
import {
  distance,
  dot,
  meanVector,
  normalize,
  readVec3,
  scale,
  triangleArea,
} from './vec';

export interface RegionSelection {
  /** 源网格三角形索引 */
  triangles: number[];
  side: Side;
}

const MAX_SAMPLES = 24;

/**
 * 局部厚度/法线检查。
 *
 * - 名义厚度: 滑杆设定的 t。
 * - 配对间距: 原始顶点与其偏移顶点之间的距离, 无折叠时应恒等于 t。
 * - 实测间隙: 偏移三角形重心到原始曲面的最近距离。偏移面在凹角处
 *   穿过曲面时, 这个值会明显小于 t, 甚至趋近 0, 即"厚度被吃掉"。
 * - 法线偏差: 偏移三角形法线与源三角形法线(按加厚侧取向)的夹角。
 */
export function inspectRegion(
  model: SurfaceModel,
  solid: ThickenedSolid,
  selection: RegionSelection,
): RegionInspection {
  const triangleIds = [...new Set(selection.triangles)]
    .filter((id) => id >= 0 && id < model.indices.length / 3)
    .sort((a, b) => a - b);
  const sourceTriangles: IndexTriple[] = [];
  for (let t = 0; t < model.indices.length; t += 3) {
    sourceTriangles.push({
      a: model.indices[t],
      b: model.indices[t + 1],
      c: model.indices[t + 2],
    });
  }

  const vertexIds = new Set<number>();
  const sourceNormals: Vec3[] = [];
  const offsetNormals: Vec3[] = [];
  const distances: number[] = [];
  const pairedDistances: number[] = [];
  const areaRatios: number[] = [];
  const sampleGaps: SampleGap[] = [];
  let flipped = 0;
  let problem = 0;

  for (const id of triangleIds) {
    const ia = model.indices[id * 3];
    const ib = model.indices[id * 3 + 1];
    const ic = model.indices[id * 3 + 2];
    vertexIds.add(ia);
    vertexIds.add(ib);
    vertexIds.add(ic);

    const baseNormal = sourceTriangleNormal(model.positions, model.indices, id);
    const expected = scale(baseNormal, selection.side);
    sourceNormals.push(baseNormal);

    // 偏移三角形: 用实体里的实际绕序, 它随加厚侧翻转
    const oa = solid.offsetIndices[id * 3];
    const ob = solid.offsetIndices[id * 3 + 1];
    const oc = solid.offsetIndices[id * 3 + 2];
    const pA = readVec3(solid.positions, oa);
    const pB = readVec3(solid.positions, ob);
    const pC = readVec3(solid.positions, oc);
    const offsetNormal = normalize(
      [ (pB[1] - pA[1]) * (pC[2] - pA[2]) - (pB[2] - pA[2]) * (pC[1] - pA[1]),
        (pB[2] - pA[2]) * (pC[0] - pA[0]) - (pB[0] - pA[0]) * (pC[2] - pA[2]),
        (pB[0] - pA[0]) * (pC[1] - pA[1]) - (pB[1] - pA[1]) * (pC[0] - pA[0]) ],
    );
    offsetNormals.push(offsetNormal);
    if (dot(offsetNormal, expected) < 0) flipped++;

    const centroid: Vec3 = [
      (pA[0] + pB[0] + pC[0]) / 3,
      (pA[1] + pB[1] + pC[1]) / 3,
      (pA[2] + pB[2] + pC[2]) / 3,
    ];
    const closest = closestPointOnMesh(centroid, model.positions, sourceTriangles);
    if (closest) {
      distances.push(closest.distance);
      if (sampleGaps.length < MAX_SAMPLES) {
        sampleGaps.push({ from: centroid, to: closest.point, distance: closest.distance });
      }
    }

    const offsetVertexBase = model.positions.length / 3;
    for (const v of [ia, ib, ic]) {
      pairedDistances.push(distance(readVec3(model.positions, v), readVec3(solid.positions, v + offsetVertexBase)));
    }

    const sourceArea = triangleArea(
      readVec3(model.positions, ia),
      readVec3(model.positions, ib),
      readVec3(model.positions, ic),
    );
    const offsetArea = triangleArea(pA, pB, pC);
    areaRatios.push(sourceArea > 1e-14 ? offsetArea / sourceArea : 0);

    if (solid.validation.problemSourceTriangles.has(id)) problem++;
  }

  const meanBaseNormal = normalize(meanVector(sourceNormals));
  const meanOffsetNormal = normalize(meanVector(offsetNormals.map((n) => scale(n, selection.side))));

  return {
    modelId: model.id,
    side: selection.side,
    triangleIds,
    vertexIds: [...vertexIds].sort((a, b) => a - b),
    triangleCount: triangleIds.length,
    vertexCount: vertexIds.size,
    nominalThickness: solid.thickness,
    measuredMin: distances.length ? Math.min(...distances) : Number.NaN,
    measuredMean: distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : Number.NaN,
    measuredMax: distances.length ? Math.max(...distances) : Number.NaN,
    pairedDistanceMin: pairedDistances.length ? Math.min(...pairedDistances) : Number.NaN,
    pairedDistanceMax: pairedDistances.length ? Math.max(...pairedDistances) : Number.NaN,
    baseNormal: meanBaseNormal,
    topNormal: meanOffsetNormal,
    meanNormalDeviationDeg: offsetNormals.length
      ? offsetNormals.reduce((sum, n, i) => sum + angleBetweenDeg(n, scale(sourceNormals[i], selection.side)), 0)
        / offsetNormals.length
      : Number.NaN,
    maxNormalDeviationDeg: offsetNormals.length
      ? Math.max(...offsetNormals.map((n, i) => angleBetweenDeg(n, scale(sourceNormals[i], selection.side))))
      : Number.NaN,
    flippedTriangleCount: flipped,
    problemTriangleCount: problem,
    areaRatioMin: areaRatios.length ? Math.min(...areaRatios) : Number.NaN,
    areaRatioMax: areaRatios.length ? Math.max(...areaRatios) : Number.NaN,
    sampleGaps,
  };
}
