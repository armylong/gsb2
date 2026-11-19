/**
 * 基于 meshoptimizer (quadric error metrics) 的网格简化封装。
 * 文档：https://github.com/zeux/meshoptimizer
 *
 * 重要口径：
 * - 目标面数 = round(原面数 × 保留比例)，并按 3 索引对齐；
 * - target_error 给一个很大的值并配合 ErrorAbsolute：
 *   误差预算以世界坐标绝对值计且不会提前终止，简化器会一直折叠到目标面数，
 *   只有拓扑约束（无法再安全折叠）才会让它提前停止；
 * - 简化器受拓扑约束可能无法达到目标（例如三角形已无法再折叠），
 *   此时如实返回实际面数与 reached=false，绝不复制原网格的面冒充结果；
 * - lockBorder 对应 LockBorder 标志：边界边的顶点不允许移动/折叠，
 *   因此被保留的边界顶点偏移严格为 0（容差 = 0），
 *   该保证只针对网格边界，不承诺任意拓扑或材质接缝的保护。
 */
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { MeshData, triangleCount } from './meshTypes';

export interface SimplifyOptions {
  /** 保留比例，范围 0.25 – 0.90（1.0 走“不简化”参照路径，不调用本模块） */
  ratio: number;
  lockBorder: boolean;
}

export interface SimplifyResult {
  mesh: MeshData;
  targetTriangles: number;
  actualTriangles: number;
  sourceTriangles: number;
  /** 实际面数是否落在目标容差内（±1 个三角形，索引按 3 对齐导致的舍入） */
  reached: boolean;
  lockBorder: boolean;
  /** meshoptimizer 报告的内部二次误差（仅调试用，UI 误差以真实距离采样为准） */
  internalError: number;
}

let readyPromise: Promise<void> | null = null;

export function ensureSimplifierReady(): Promise<void> {
  if (!readyPromise) {
    if (!MeshoptSimplifier.supported) {
      readyPromise = Promise.reject(
        new Error('当前环境不支持 WebAssembly，无法运行 meshoptimizer 简化器'),
      );
    } else {
      readyPromise = MeshoptSimplifier.ready;
    }
  }
  return readyPromise;
}

const UNUSED = 0xffffffff;

export function simplifyMesh(source: MeshData, options: SimplifyOptions): SimplifyResult {
  const sourceTriangles = triangleCount(source);
  // 目标索引数按 3 对齐
  const targetTriangles = Math.max(1, Math.round(sourceTriangles * options.ratio));
  const targetIndexCount = targetTriangles * 3;

  // ErrorAbsolute：内部误差以世界坐标绝对值表示（而非相对包围盒尺度）；
  // target_error 取极大值，保证误差预算不会让简化在达到目标面数前停止。
  const flags: Array<'LockBorder' | 'ErrorAbsolute'> = ['ErrorAbsolute'];
  if (options.lockBorder) flags.push('LockBorder');
  const [rawIndices, internalError] = MeshoptSimplifier.simplify(
    source.indices,
    source.positions,
    3, // 位置步长 = 3 个 float
    targetIndexCount,
    1e30,
    flags,
  );

  // compactMesh 原地把索引压缩为连续编号，并返回 [remap, 保留顶点数]：
  // remap[oldVertex] = 新顶点号，未被任何三角形引用的顶点标记为 UNUSED。
  // 不复制/伪造任何原顶点，未引用的原顶点直接丢弃。
  const [remap, usedVertexCount] = MeshoptSimplifier.compactMesh(rawIndices);
  const compactPositions = new Float32Array(usedVertexCount * 3);
  for (let old = 0; old < remap.length; old++) {
    const next = remap[old];
    if (next === UNUSED) continue;
    compactPositions[next * 3] = source.positions[old * 3];
    compactPositions[next * 3 + 1] = source.positions[old * 3 + 1];
    compactPositions[next * 3 + 2] = source.positions[old * 3 + 2];
  }
  // rawIndices 已被 compactMesh 原地重写为紧凑编号
  const finalIndices = rawIndices.slice();

  const actualTriangles = finalIndices.length / 3;
  const reached = Math.abs(actualTriangles - targetTriangles) <= 1;

  return {
    mesh: { positions: compactPositions, indices: finalIndices },
    targetTriangles,
    actualTriangles,
    sourceTriangles,
    reached,
    lockBorder: options.lockBorder,
    internalError,
  };
}
