import { buildThickenedSolid } from './thickening';
import type { Side, SolidOptions, SurfaceModel, ThickenedSolid } from './types';
import { arraysEqual, hashMesh } from './vec';

export interface RegressionStep {
  label: string;
  thickness: number;
  side: Side;
  sourceHash: string;
  sourceLayerIntact: boolean;
  solidHash: string;
}

export interface RegressionReport {
  pass: boolean;
  steps: RegressionStep[];
  sourceLayerVertexMaxDelta: number;
  offsetLayerMaxDelta: number;
  restoredTriangleCount: number;
  referenceTriangleCount: number;
  messages: string[];
}

function solidHash(solid: ThickenedSolid): string {
  const relevant = new Uint32Array(solid.originalIndices.length + solid.offsetIndices.length + solid.sideIndices.length);
  relevant.set(solid.originalIndices, 0);
  relevant.set(solid.offsetIndices, solid.originalIndices.length);
  relevant.set(solid.sideIndices, solid.originalIndices.length + solid.offsetIndices.length);
  return hashMesh(solid.positions, relevant);
}

function maxPositionDelta(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

/**
 * 回归检查: 在当前厚度下记下源网格指纹, 把厚度调到 0 再调回,
 * 验证 (1) 源网格数组逐字节未变, (2) 原始层顶点与源网格完全一致,
 * (3) 恢复后的实体与第一次构建逐字节一致。
 */
export function runZeroThicknessRegression(
  model: SurfaceModel,
  options: SolidOptions,
): RegressionReport {
  const steps: RegressionStep[] = [];
  const sourceBefore = Float32Array.from(model.positions);
  const indicesBefore = Uint32Array.from(model.indices);
  const sourceNormalsBefore = Float32Array.from(model.normals);
  const hashBefore = hashMesh(model.positions, model.indices);
  const reference = buildThickenedSolid(model, options);
  const referenceHash = solidHash(reference);

  const record = (label: string, solid: ThickenedSolid): void => {
    const sourceVertexCount = model.positions.length / 3;
    const originalLayer = solid.positions.subarray(0, sourceVertexCount * 3);
    const sourceHash = hashMesh(model.positions, model.indices);
    steps.push({
      label,
      thickness: solid.thickness,
      side: solid.side,
      sourceHash,
      sourceLayerIntact: maxPositionDelta(originalLayer, model.positions) < 1e-7
        && sourceHash === hashBefore,
      solidHash: solidHash(solid),
    });
  };

  const zero = buildThickenedSolid(model, { thickness: 0, side: options.side });
  record('厚度 0', zero);
  const maybeThin = buildThickenedSolid(model, { thickness: options.thickness * 0.5, side: options.side });
  record('厚度 50%', maybeThin);
  const restored = buildThickenedSolid(model, options);
  record('恢复原厚度', restored);

  const sourceVertexCount = model.positions.length / 3;
  const sourceLayerMaxDelta = maxPositionDelta(
    restored.positions.subarray(0, sourceVertexCount * 3),
    model.positions,
  );
  const offsetLayerMaxDelta = Math.max(
    maxPositionDelta(
      restored.positions.subarray(sourceVertexCount * 3),
      reference.positions.subarray(sourceVertexCount * 3),
    ),
    maxPositionDelta(
      restored.positions.subarray(0, sourceVertexCount * 3),
      reference.positions.subarray(0, sourceVertexCount * 3),
    ),
  );

  const sourceUnchanged = arraysEqual(sourceBefore, model.positions)
    && arraysEqual(indicesBefore, model.indices)
    && arraysEqual(sourceNormalsBefore, model.normals)
    && hashMesh(model.positions, model.indices) === model.sourceHash;

  const zeroLayerIntact = steps[0].sourceLayerIntact;
  const restoredIdentical = steps[2].solidHash === referenceHash;
  const messages: string[] = [];
  if (!sourceUnchanged) messages.push('源网格被修改了, 这是缺陷。');
  if (!zeroLayerIntact) messages.push('厚度为 0 时原始层与源网格不一致。');
  if (!restoredIdentical) messages.push('恢复厚度后的实体与初始实体不一致。');
  if (zero.thickness !== 0) messages.push('零厚度构建未生效。');
  const pass = sourceUnchanged && zeroLayerIntact && restoredIdentical && steps.every((s) => s.sourceLayerIntact);
  if (pass) {
    messages.push('源网格未变; 厚度归零只影响偏移层与侧壁, 恢复后与初始完全一致。');
  }
  return {
    pass,
    steps,
    sourceLayerVertexMaxDelta: sourceLayerMaxDelta,
    offsetLayerMaxDelta,
    restoredTriangleCount: restored.triangleCount,
    referenceTriangleCount: reference.triangleCount,
    messages,
  };
}
