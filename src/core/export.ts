/**
 * 压缩结果导出 / 回读
 *
 * 导出文件的压缩本体只有三类数据：
 *   1. 每轴整数编码（按实际位宽打包成 u8/u16/u32；零厚度轴不存储）
 *   2. 必要的坐标范围（AxisMeta：min/max/bits/step...）
 *   3. 索引
 * 另附探针（抽样原始坐标）、校验和与接缝快照用于回读复核。
 *
 * 回读解码走与导出前完全相同的 decodeValue 公式（f64），
 * 因此探针坐标与误差逐位一致；若当前会话仍有源模型，还会做整件全量比对。
 */
import type {
  AnalysisResult,
  AxisMeta,
  ExportedChunk,
  ExportedFile,
  MeshChunk,
  MeshModel,
  QuantResult,
} from './types';
import { AXES } from './types';
import { decodeChunk, decodeValue } from './quant';
import { computeStats, findSeams } from './analyze';

// ---------- base64（兼容浏览器，分块处理避免 call stack 限制） ----------
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function packingForBits(bits: number, flat: boolean): 'u8' | 'u16' | 'u32' | null {
  if (flat) return null;
  if (bits <= 8) return 'u8';
  if (bits <= 16) return 'u16';
  return 'u32';
}

function asArrayBuffer(buf: ArrayBuffer | SharedArrayBuffer): ArrayBuffer {
  return buf as ArrayBuffer;
}

function packCodes(codes: Uint32Array, packing: 'u8' | 'u16' | 'u32'): Uint8Array {
  const Ctor = packing === 'u8' ? Uint8Array : packing === 'u16' ? Uint16Array : Uint32Array;
  const view = new Ctor(codes.length);
  for (let i = 0; i < codes.length; i++) view[i] = codes[i];
  return new Uint8Array(asArrayBuffer(view.buffer.slice(0)));
}

function unpackCodes(bytes: Uint8Array, packing: 'u8' | 'u16' | 'u32'): Uint32Array {
  const Ctor = packing === 'u8' ? Uint8Array : packing === 'u16' ? Uint16Array : Uint32Array;
  const view = new Ctor(asArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  return Uint32Array.from(view);
}

// ---------- 导出 ----------
const PROBE_COUNT = 64;

export function buildExport(
  model: MeshModel,
  analysis: AnalysisResult,
): ExportedFile {
  const quant: QuantResult = analysis.quant;
  const chunks: ExportedChunk[] = [];

  for (const chunk of model.chunks) {
    const qr = quant.chunks.find((c) => c.chunkId === chunk.id)!;
    const n = chunk.positions.length / 3;

    const codePacking = AXES.map((a) => packingForBits(qr.axes[a].bits, qr.axes[a].flat)) as ExportedChunk['codePacking'];
    const codes = AXES.map((a) => {
      const packing = codePacking[a];
      if (!packing) return null;
      const axisCodes = new Uint32Array(n);
      for (let i = 0; i < n; i++) axisCodes[i] = qr.quant.codes[i * 3 + a];
      return bytesToBase64(packCodes(axisCodes, packing));
    });

    // 均匀抽样探针（首尾必取）
    const probeIdx = new Set<number>();
    probeIdx.add(0);
    for (let k = 0; k < PROBE_COUNT; k++) {
      probeIdx.add(Math.floor((k / (PROBE_COUNT - 1)) * (n - 1)));
    }
    if (n > 1) probeIdx.add(n - 1);
    const probes = [...probeIdx].sort((a, b) => a - b).map((i) => ({
      index: i,
      original: [
        chunk.positions[i * 3],
        chunk.positions[i * 3 + 1],
        chunk.positions[i * 3 + 2],
      ] as [number, number, number],
      code: [
        qr.quant.codes[i * 3],
        qr.quant.codes[i * 3 + 1],
        qr.quant.codes[i * 3 + 2],
      ] as [number, number, number],
      restored: [
        qr.quant.restored[i * 3],
        qr.quant.restored[i * 3 + 1],
        qr.quant.restored[i * 3 + 2],
      ] as [number, number, number],
      error: qr.quant.errors[i],
    }));

    chunks.push({
      id: chunk.id,
      name: chunk.name,
      vertexCount: n,
      triangleCount: chunk.indices.length / 3,
      indices: bytesToBase64(new Uint8Array(asArrayBuffer(chunk.indices.buffer.slice(0)))),
      codePacking,
      codes,
      axes: AXES.map((a) => qr.axes[a]),
      probes,
    });
  }

  const seamMaxGap = analysis.seamPairs.reduce((m, s) => Math.max(m, Math.abs(s.gap)), 0);
  const file: ExportedFile = {
    format: 'mesh-quant-inspector',
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceName: model.name,
    settings: quant.settings,
    modelBBox: model.bbox,
    modelDiagonal: analysis.modelDiagonal,
    chunks,
    checksum: {
      maxError: analysis.stats.maxError,
      rmsError: analysis.stats.rmsError,
      meanError: analysis.stats.meanError,
      seamMaxGap,
      seamSeparatedCount: analysis.separatedSeams.length,
      duplicateCount: analysis.duplicates.length,
      nominalBytes: analysis.nominalBytes,
      effectiveBytes: analysis.effectiveBytes,
    },
    seamSnapshot: analysis.seamPairs.map((s) => ({
      chunkA: s.chunkA,
      chunkB: s.chunkB,
      vertexA: s.vertexA,
      vertexB: s.vertexB,
      originalDistance: s.originalDistance,
      restoredDistance: s.restoredDistance,
      gap: s.gap,
    })),
  };
  return file;
}

export function downloadExport(file: ExportedFile) {
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = file.sourceName.replace(/[^\w一-龥-]+/g, '_');
  a.download = `quant_${safe}_${file.settings.bits.x}b_${file.settings.rangeMode}.mqid.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 回读 ----------
export interface ImportedModel {
  file: ExportedFile;
  /** 用编码 + 范围还原出的模型（positions 为 f64 还原坐标） */
  restoredModel: MeshModel;
  /** 每块的轴元数据与编码，便于再次分析 */
  axes: Map<number, AxisMeta[]>;
  codes: Map<number, Uint32Array>;
}

export function readImport(jsonText: string): ImportedModel {
  const file = JSON.parse(jsonText) as ExportedFile;
  if (file.format !== 'mesh-quant-inspector' || file.version !== 1) {
    throw new Error('文件格式或版本不被支持');
  }
  const chunks: MeshChunk[] = [];
  const axes = new Map<number, AxisMeta[]>();
  const codesMap = new Map<number, Uint32Array>();

  for (const ec of file.chunks) {
    const n = ec.vertexCount;
    const codes = new Uint32Array(n * 3);
    for (const a of AXES) {
      const packing = ec.codePacking[a];
      if (!packing) continue;
      const axisCodes = unpackCodes(base64ToBytes(ec.codes[a]!), packing);
      for (let i = 0; i < n; i++) codes[i * 3 + a] = axisCodes[i];
    }
    const restored = decodeChunk(codes, ec.axes);
    const indexBytes = base64ToBytes(ec.indices);
    const indices = new Uint32Array(asArrayBuffer(indexBytes.buffer.slice(indexBytes.byteOffset)));

    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < restored.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (restored[i + a] < min[a]) min[a] = restored[i + a];
        if (restored[i + a] > max[a]) max[a] = restored[i + a];
      }
    }
    chunks.push({
      // 保留导出时的原块 id，使回读模型可与源模型逐块对齐
      id: ec.id,
      name: ec.name,
      positions: restored,
      indices,
      bbox: { min, max },
    });
    axes.set(ec.id, ec.axes);
    codesMap.set(ec.id, codes);
  }
  const restoredModel: MeshModel = {
    name: `${file.sourceName}（回读还原）`,
    chunks,
    bbox: file.modelBBox,
    vertexCount: chunks.reduce((s, c) => s + c.positions.length / 3, 0),
    triangleCount: chunks.reduce((s, c) => s + c.indices.length / 3, 0),
  };
  return { file, restoredModel, axes, codes: codesMap };
}

export interface ProbeCheck {
  chunk: string;
  index: number;
  original: [number, number, number];
  restored: [number, number, number];
  storedError: number;
  recomputedError: number;
  decodeExact: boolean;
  errorExact: boolean;
}

export interface ImportVerification {
  probes: ProbeCheck[];
  allExact: boolean;
  /** 若提供了同源原始模型，则给出整件全量比对 */
  fullComparison: null | {
    vertexCount: number;
    maxErrorMatch: boolean;
    rmsMatch: boolean;
    meanMatch: boolean;
    seamGapMax: number;
    seamGapMatch: boolean;
    restoredMaxDiff: number;
  };
  checksumEcho: ExportedFile['checksum'];
}

/**
 * 回读校验：
 * 1. 无条件执行探针级逐位校验（文件自带原始坐标样本）
 * 2. 若传入与导出时相同的源模型，执行整件全量误差与接缝比对
 */
export function verifyImport(imp: ImportedModel, source?: MeshModel): ImportVerification {
  const probes: ProbeCheck[] = [];
  let allExact = true;

  imp.file.chunks.forEach((ec) => {
    const axes = imp.axes.get(ec.id)!;
    const codes = imp.codes.get(ec.id)!;
    const restored = decodeChunk(codes, axes);
    for (const p of ec.probes) {
      const got: [number, number, number] = [
        restored[p.index * 3],
        restored[p.index * 3 + 1],
        restored[p.index * 3 + 2],
      ];
      const decodeExact = got.every((v, a) => Object.is(v, p.restored[a]));
      let sumSq = 0;
      for (let a = 0; a < 3; a++) {
        const d = got[a] - p.original[a];
        sumSq += d * d;
      }
      const recomputedError = Math.sqrt(sumSq);
      const errorExact = Object.is(recomputedError, p.error);
      if (!decodeExact || !errorExact) allExact = false;
      probes.push({
        chunk: ec.name,
        index: p.index,
        original: p.original,
        restored: got,
        storedError: p.error,
        recomputedError,
        decodeExact,
        errorExact,
      });
    }
  });

  let fullComparison: ImportVerification['fullComparison'] = null;
  if (source && source.chunks.length === imp.file.chunks.length) {
    let maxDiff = 0;
    const allErrors: number[] = [];
    let totalVerts = 0;
    let allMatch = true;
    source.chunks.forEach((sc, ord) => {
      const ec = imp.file.chunks[ord];
      if (sc.positions.length / 3 !== ec.vertexCount) {
        allMatch = false;
        return;
      }
      const axes = imp.axes.get(ec.id)!;
      const codes = imp.codes.get(ec.id)!;
      const n = ec.vertexCount;
      totalVerts += n;
      for (let i = 0; i < n; i++) {
        let sumSq = 0;
        for (let a = 0; a < 3; a++) {
          // 直接内联 decodeValue，与 quant.ts 的量化循环保持完全相同的运算顺序
          const r = axes[a].flat ? axes[a].min : axes[a].min + codes[i * 3 + a] * axes[a].step;
          const diff = r - sc.positions[i * 3 + a];
          if (Math.abs(diff) > maxDiff) maxDiff = Math.abs(diff);
          if (!Object.is(r, decodeValue(codes[i * 3 + a], axes[a]))) {
            allMatch = false;
          }
          sumSq += diff * diff;
        }
        allErrors.push(Math.sqrt(sumSq));
      }
    });

    if (allMatch) {
      const stats = computeStats(Float64Array.from(allErrors));
      const cs = imp.file.checksum;
      // 用回读还原模型重新检测接缝（与源模型配对）
      const quantLike: QuantResult = {
        settings: imp.file.settings,
        chunks: source.chunks.map((sc, ord) => {
          const ec = imp.file.chunks[ord];
          const axes = imp.axes.get(ec.id)! as [AxisMeta, AxisMeta, AxisMeta];
          const codes = imp.codes.get(ec.id)!;
          return {
            chunkId: sc.id,
            axes,
            quant: { restored: decodeChunk(codes, ec.axes), codes, errors: new Float64Array(ec.vertexCount) },
          };
        }),
      };
      const seams = findSeams(source, quantLike);
      const seamGapMax = seams.reduce((m, s) => Math.max(m, Math.abs(s.gap)), 0);
      fullComparison = {
        vertexCount: totalVerts,
        maxErrorMatch: Object.is(stats.maxError, cs.maxError),
        rmsMatch: Object.is(stats.rmsError, cs.rmsError),
        meanMatch: Object.is(stats.meanError, cs.meanError),
        seamGapMax,
        seamGapMatch: Object.is(seamGapMax, cs.seamMaxGap),
        restoredMaxDiff: maxDiff,
      };
      if (!fullComparison.maxErrorMatch || !fullComparison.rmsMatch || !fullComparison.seamGapMatch) {
        allExact = false;
      }
    }
  }

  return { probes, allExact, fullComparison, checksumEcho: imp.file.checksum };
}
