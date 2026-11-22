/**
 * 误差统计 / 重复顶点 / 接缝分析
 */
import type {
  AnalysisResult,
  BBox,
  DuplicateInfo,
  ErrorStats,
  MeshChunk,
  MeshModel,
  QuantResult,
  SeamPair,
} from './types';
import { AXES } from './types';

export function computeStats(errors: Float64Array): ErrorStats {
  if (errors.length === 0) {
    return { maxError: 0, meanError: 0, rmsError: 0, p50: 0, p90: 0, p99: 0 };
  }
  const sorted = Float64Array.from(errors).sort();
  let sum = 0;
  let sumSq = 0;
  for (const e of sorted) {
    sum += e;
    sumSq += e * e;
  }
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    maxError: sorted[sorted.length - 1],
    meanError: sum / sorted.length,
    rmsError: Math.sqrt(sumSq / sorted.length),
    p50: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
  };
}

export function bboxDiagonal(box: BBox): number {
  let s = 0;
  for (const a of AXES) {
    const d = box.max[a] - box.min[a];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * 同位置重复顶点检测：块内坐标完全相同（f64 严格相等）的顶点归为一组。
 * 使用分桶哈希避免 O(n²)；零厚度轴同样可处理（该轴不参与区分）。
 */
export function findDuplicates(chunks: MeshChunk[]): DuplicateInfo[] {
  const out: DuplicateInfo[] = [];
  for (const chunk of chunks) {
    const n = chunk.positions.length / 3;
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      // f64 位模式拼接作为 key，保证严格相等才同桶
      const buf = new Float64Array(3);
      buf[0] = chunk.positions[i * 3];
      buf[1] = chunk.positions[i * 3 + 1];
      buf[2] = chunk.positions[i * 3 + 2];
      const key = String(new BigUint64Array(buf.buffer).join(','));
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    }
    for (const list of buckets.values()) {
      if (list.length >= 2) {
        const i0 = list[0];
        out.push({
          chunkId: chunk.id,
          vertices: list,
          position: [
            chunk.positions[i0 * 3],
            chunk.positions[i0 * 3 + 1],
            chunk.positions[i0 * 3 + 2],
          ],
        });
      }
    }
  }
  return out;
}

/**
 * 接缝检测：分属不同块、原始空间中相邻（距离 <= neighborTol）的顶点对。
 *
 * 注意不能只取单三角形边的“边界顶点”：两块拼合时，共享边上的顶点在
 * 各自块内都有两个邻接三角形，但它们仍是接缝顶点。因此这里把所有顶点
 * 放入统一网格空间哈希，只做跨块近邻配对，避免 O(n²)。
 *
 * @param neighborTol 相邻判定距离，默认取整件对角线的 1e-3（最小 1e-7），
 *                    覆盖真实分块网格常见的亚毫米级物理缝隙
 */
export function findSeams(model: MeshModel, quant: QuantResult, neighborTol?: number): SeamPair[] {
  const diag = bboxDiagonal(model.bbox);
  const tol = neighborTol ?? Math.max(diag * 1e-3, 1e-7);
  const cell = tol;
  const grid = new Map<string, { chunkId: number; vertex: number }[]>();
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  // 插入所有顶点
  for (const chunk of model.chunks) {
    const n = chunk.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const key = keyOf(chunk.positions[i * 3], chunk.positions[i * 3 + 1], chunk.positions[i * 3 + 2]);
      const entry = { chunkId: chunk.id, vertex: i };
      const list = grid.get(key);
      if (list) list.push(entry);
      else grid.set(key, [entry]);
    }
  }

  const pairs: SeamPair[] = [];
  const seen = new Set<string>();

  for (const chunk of model.chunks) {
    const n = chunk.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const p = [chunk.positions[i * 3], chunk.positions[i * 3 + 1], chunk.positions[i * 3 + 2]];
      const cx = Math.floor(p[0] / cell);
      const cy = Math.floor(p[1] / cell);
      const cz = Math.floor(p[2] / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!list) continue;
            for (const other of list) {
              if (other.chunkId === chunk.id) continue;
              const q = vertexPos(model, other.chunkId, other.vertex);
              const dist = Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
              if (dist > tol) continue;
              const pairKey = chunk.id < other.chunkId
                ? `${chunk.id}:${i}|${other.chunkId}:${other.vertex}`
                : `${other.chunkId}:${other.vertex}|${chunk.id}:${i}`;
              if (seen.has(pairKey)) continue;
              seen.add(pairKey);

              const ra = restoredPos(quant, chunk.id, i);
              const rb = restoredPos(quant, other.chunkId, other.vertex);
              const restoredDistance = Math.sqrt(
                (ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2,
              );
              const gap = restoredDistance - dist;

              // 归一化：两块在该顶点处各轴步长的最大值
              const qa = quant.chunks.find((c) => c.chunkId === chunk.id)!;
              const qb = quant.chunks.find((c) => c.chunkId === other.chunkId)!;
              let maxStep = 0;
              for (const a of AXES) maxStep = Math.max(maxStep, qa.axes[a].step, qb.axes[a].step);
              pairs.push({
                chunkA: chunk.id,
                chunkB: other.chunkId,
                vertexA: i,
                vertexB: other.vertex,
                originalDistance: dist,
                restoredDistance,
                gap,
                gapInSteps: maxStep > 0 ? Math.abs(gap) / maxStep : 0,
              });
            }
          }
    }
  }
  return pairs;
}

function vertexPos(model: MeshModel, chunkId: number, vertex: number): number[] {
  const chunk = model.chunks.find((c) => c.id === chunkId)!;
  const i = vertex * 3;
  return [chunk.positions[i], chunk.positions[i + 1], chunk.positions[i + 2]];
}

function restoredPos(quant: QuantResult, chunkId: number, vertex: number): number[] {
  const ch = quant.chunks.find((c) => c.chunkId === chunkId)!;
  const i = vertex * 3;
  return [ch.quant.restored[i], ch.quant.restored[i + 1], ch.quant.restored[i + 2]];
}

/** 理论坐标数据量：名义（设定位数）与有效（实际编码位数）两种口径，单位 bit */
export function computeDataSize(model: MeshModel, quant: QuantResult) {
  let nominalBits = 0;
  let effectiveBits = 0;
  for (const ch of quant.chunks) {
    const chunk = model.chunks.find((c) => c.id === ch.chunkId)!;
    const n = chunk.positions.length / 3;
    for (const a of AXES) {
      nominalBits += n * ch.axes[a].bits;
      effectiveBits += n * ch.axes[a].effectiveBits;
    }
  }
  return {
    nominalBits,
    effectiveBits,
    nominalBytes: Math.ceil(nominalBits / 8),
    effectiveBytes: Math.ceil(effectiveBits / 8),
  };
}

export function analyzeModel(model: MeshModel, quant: QuantResult, seamTol?: number): AnalysisResult {
  const allErrors: number[] = [];
  const chunkStats: { chunkId: number; stats: ErrorStats }[] = [];
  for (const ch of quant.chunks) {
    const s = computeStats(ch.quant.errors);
    chunkStats.push({ chunkId: ch.chunkId, stats: s });
    for (const e of ch.quant.errors) allErrors.push(e);
  }
  const stats = computeStats(Float64Array.from(allErrors));
  const seams = findSeams(model, quant, seamTol);
  const modelDiag = bboxDiagonal(model.bbox);
  // 接缝张开判定（三者同时满足）：
  //  1) |张开量| 超过半个量化步长（量化格意义上可感知）
  //  2) |张开量| 超过该接缝的原始间距（量化确实让相邻边比原来离得更远/插得更深，
  //     而不是仅仅把本就存在的物理微缝照原样保留）
  //  3) 绝对值超过对角线 1e-9，过滤浮点噪声
  const noiseFloor = modelDiag * 1e-9;
  const separated = seams.filter(
    (s) =>
      Math.abs(s.gap) > halfStepOf(quant, s) &&
      Math.abs(s.gap) > s.originalDistance &&
      Math.abs(s.gap) > noiseFloor,
  );
  const seamThreshold = noiseFloor;
  const duplicates = findDuplicates(model.chunks);
  const size = computeDataSize(model, quant);

  return {
    quant,
    stats,
    chunkStats,
    seamPairs: seams,
    separatedSeams: separated,
    duplicates,
    modelDiagonal: modelDiag,
    seamThreshold,
    ...size,
  };
}

function halfStepOf(quant: QuantResult, s: SeamPair): number {
  const qa = quant.chunks.find((c) => c.chunkId === s.chunkA)!;
  const qb = quant.chunks.find((c) => c.chunkId === s.chunkB)!;
  let m = 0;
  for (const a of AXES) m = Math.max(m, qa.axes[a].step, qb.axes[a].step);
  return m * 0.5;
}