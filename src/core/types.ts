/**
 * 网格坐标压缩检查器 —— 核心类型定义
 *
 * 整条数据链路（原始坐标 -> 整数编码 -> 还原坐标 -> 误差/接缝分析 -> 导出回读）
 * 全部使用 number(f64) 计算，仅在渲染层转 Float32，保证「导出前」与「回读后」
 * 算出的误差逐位一致。
 */

/** 三个轴的标识 */
export type Axis = 0 | 1 | 2;
export const AXES: Axis[] = [0, 1, 2];
export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/** 每个轴的量化配置：位数 0..24；0 表示该轴厚度为 0，无需编码 */
export interface QuantBits {
  x: number;
  y: number;
  z: number;
}

/** 范围模式：整件共用一个包围盒 / 每块各自计算包围盒 */
export type RangeMode = 'global' | 'perChunk';

export interface QuantSettings {
  bits: QuantBits;
  rangeMode: RangeMode;
}

/** 一个分块（chunk）：自带索引的三角网格 */
export interface MeshChunk {
  id: number;
  name: string;
  /** 顶点坐标，长度 = vertexCount * 3，f64 */
  positions: Float64Array;
  /** 三角形索引 */
  indices: Uint32Array;
  /** 该块自己的包围盒（构建模型时算出） */
  bbox: BBox;
}

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface MeshModel {
  name: string;
  chunks: MeshChunk[];
  /** 整件包围盒 */
  bbox: BBox;
  vertexCount: number;
  triangleCount: number;
}

/** 单个轴的量化元数据（每块一份；global 模式下各块相同） */
export interface AxisMeta {
  axis: Axis;
  bits: number;
  min: number;
  max: number;
  /** 量化步长 q；零厚度轴为 0 */
  step: number;
  levels: number;
  /** 该块此轴实际用到的编码数（零厚度轴记 1） */
  usedLevels: number;
  /** 有效位数 = ceil(log2(usedLevels))；零厚度轴为 0 */
  effectiveBits: number;
  /** 是否为零厚度轴（min === max） */
  flat: boolean;
}

/** 单个顶点的量化结果 */
export interface VertexQuant {
  /** 还原坐标 f64 */
  restored: Float64Array;
  /** 逐轴整数编码，长度 vertexCount*3 */
  codes: Uint32Array;
  /** 逐顶点欧氏距离误差 */
  errors: Float64Array;
}

export interface ChunkQuantResult {
  chunkId: number;
  axes: [AxisMeta, AxisMeta, AxisMeta];
  quant: VertexQuant;
}

export interface QuantResult {
  settings: QuantSettings;
  chunks: ChunkQuantResult[];
}

/** 接缝顶点对：分属不同块、原始空间中相邻的两个边界顶点 */
export interface SeamPair {
  chunkA: number;
  chunkB: number;
  vertexA: number;
  vertexB: number;
  /** 原始坐标距离（判定为相邻的依据） */
  originalDistance: number;
  /** 还原后坐标距离 */
  restoredDistance: number;
  /** 接缝张开量 = restoredDistance - originalDistance（带符号，负值为互相插入） */
  gap: number;
  /** |gap| / 该顶点处所在块的步长（归一化，便于跨精度比较） */
  gapInSteps: number;
}

export interface DuplicateInfo {
  chunkId: number;
  /** 同位置顶点的块内索引列表（长度 >= 2） */
  vertices: number[];
  position: [number, number, number];
}

export interface ErrorStats {
  maxError: number;
  meanError: number;
  rmsError: number;
  /** 分位数（p50/p90/p99） */
  p50: number;
  p90: number;
  p99: number;
}

export interface AnalysisResult {
  quant: QuantResult;
  stats: ErrorStats;
  /** 每块各自的误差统计 */
  chunkStats: { chunkId: number; stats: ErrorStats }[];
  seamPairs: SeamPair[];
  /** 张开量超过判定阈值的接缝对 */
  separatedSeams: SeamPair[];
  duplicates: DuplicateInfo[];
  /** 整件对角线长度，用于归一化 */
  modelDiagonal: number;
  /** 接缝判定阈值（|gap| 大于它即认为分开） */
  seamThreshold: number;
  /** 理论坐标数据量（按设定位数名义计算 / 按有效位数实际计算），单位 bit */
  nominalBits: number;
  effectiveBits: number;
  nominalBytes: number;
  effectiveBytes: number;
}

/** 导出文件里的单个块（紧凑二进制 + 元数据） */
export interface ExportedChunk {
  id: number;
  name: string;
  vertexCount: number;
  triangleCount: number;
  indices: string; // base64, Uint32Array
  /** 每轴打包后的编码（base64），位数 <=8 用 u8，<=16 用 u16，否则 u32；零厚度轴为 null */
  codePacking: ('u8' | 'u16' | 'u32' | null)[];
  codes: (string | null)[];
  axes: AxisMeta[];
  /** 抽样探针：原始坐标 / 编码 / 还原坐标，用于回读校验 */
  probes: {
    index: number;
    original: [number, number, number];
    code: [number, number, number];
    restored: [number, number, number];
    error: number;
  }[];
}

export interface ExportedFile {
  format: 'mesh-quant-inspector';
  version: 1;
  exportedAt: string;
  sourceName: string;
  settings: QuantSettings;
  modelBBox: BBox;
  modelDiagonal: number;
  chunks: ExportedChunk[];
  /** 导出时的校验摘要，回读后必须一致 */
  checksum: {
    maxError: number;
    rmsError: number;
    meanError: number;
    seamMaxGap: number;
    seamSeparatedCount: number;
    duplicateCount: number;
    nominalBytes: number;
    effectiveBytes: number;
  };
  /** 导出时记录的接缝对（含还原坐标距离），冷加载回读时可直接复核 */
  seamSnapshot: {
    chunkA: number;
    chunkB: number;
    vertexA: number;
    vertexB: number;
    originalDistance: number;
    restoredDistance: number;
    gap: number;
  }[];
}
