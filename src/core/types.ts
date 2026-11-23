export type Vec3 = [number, number, number];

/** 加厚方向: +1 = 沿顶点法线正方向, -1 = 沿法线负方向 */
export type Side = 1 | -1;

export interface Bounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
  radius: number;
}

export type LoopKind = 'outer' | 'hole';

export interface BoundaryLoop {
  id: number;
  /** 外边界只有一个; 其余为原始孔洞 */
  kind: LoopKind;
  /** 按边界有向边顺序排列的顶点索引, 不重复首尾 */
  vertices: number[];
  /** 相对相邻三角形的有符号面积 */
  signedArea: number;
  perimeter: number;
}

export interface BoundaryEdge {
  id: number;
  loopId: number;
  loopKind: LoopKind;
  a: number;
  b: number;
  /** 该有向边在源网格中唯一相邻的三角形 */
  sourceTriangle: number;
  /** 未加厚时的边长 */
  length: number;
}

export interface SurfaceModel {
  id: string;
  name: string;
  subtitle: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** 角度加权顶点法线, 指向凹侧 */
  normals: Float32Array;
  boundaries: BoundaryLoop[];
  /** 所有边界边, id 与侧壁三角形映射中的 edgeId 一致 */
  boundaryEdges: BoundaryEdge[];
  /** +1 表示顶点法线正侧是凹侧 */
  concaveSide: Side;
  defaultThickness: number;
  maxThickness: number;
  bounds: Bounds;
  /** 原始顶点/索引的稳定指纹, 用来证明源网格从未被改动 */
  sourceHash: string;
  notes: string[];
}

export interface SolidOptions {
  thickness: number;
  side: Side;
}

/** 侧壁三角形 -> 原始边界边的映射 */
export interface SideFaceMeta {
  edgeId: number;
  loopId: number;
  loopKind: LoopKind;
  /** 原始边端点顶点索引 (源网格) */
  a: number;
  b: number;
  sourceTriangle: number;
  /** 侧壁四边形中的第几个三角形 (0 或 1) */
  quadTriangle: 0 | 1;
}

export type TriangleKind = 'original' | 'offset' | 'side';

export interface SolidTriangle {
  id: number;
  kind: TriangleKind;
  /** 实体网格中的顶点索引: [0,n) 为原始层, [n,2n) 为偏移层 */
  a: number;
  b: number;
  c: number;
  /** original/offset 三角形对应的原始三角形索引; side 为 -1 */
  sourceTriangle: number;
  /** side 三角形对应的边界边 id; 其它为 -1 */
  edgeId: number;
}

export type FoldReason = 'flipped' | 'collapsed';

export interface FoldIssue {
  /** 实体网格中的偏移层三角形 id */
  triangle: number;
  sourceTriangle: number;
  /** 偏移层三角形与期望法线的夹角 (deg) */
  angleDeg: number;
  /** 偏移层面积 / 原始面积 */
  areaRatio: number;
  reason: FoldReason;
  centroid: Vec3;
}

export interface IntersectionIssue {
  a: number;
  b: number;
  aKind: TriangleKind;
  bKind: TriangleKind;
  aSourceTriangle: number;
  bSourceTriangle: number;
  aEdgeId: number;
  bEdgeId: number;
  point: Vec3;
}

export interface SideWallStatus {
  edgeId: number;
  loopId: number;
  loopKind: LoopKind;
  a: number;
  b: number;
  sourceTriangle: number;
  edgeLength: number;
  topEdgeLength: number;
  /** 期望的朝外方向 (边界切向 × 平均法线) */
  outwardNormal: Vec3;
  /** 侧壁两个三角形法线与期望方向的最大夹角 */
  normalDeviationDeg: number;
  problem: boolean;
  reasons: string[];
  intersects: boolean;
  flipped: boolean;
  degenerate: boolean;
}

export interface TopologyReport {
  vertexCount: number;
  triangleCount: number;
  edgeCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  inconsistentEdgeCount: number;
  degenerateTriangleCount: number;
  closed: boolean;
  manifold: boolean;
  eulerCharacteristic: number;
  signedVolume: number;
  orientationPositive: boolean;
}

export interface IntersectionCounts {
  originalOriginal: number;
  originalOffset: number;
  originalSide: number;
  offsetOffset: number;
  offsetSide: number;
  sideSide: number;
}

export interface ValidationReport {
  topology: TopologyReport;
  foldedOffsetTriangles: FoldIssue[];
  intersections: IntersectionIssue[];
  /** 相交对总数 (intersections 可能因 UI 上限被截断) */
  intersectionTotal: number;
  intersectionsTruncated: boolean;
  /** 被标记为问题的源三角形, 与 original/offset 共用索引空间 */
  problemSourceTriangles: Set<number>;
  problemSideEdges: Set<number>;
  intersectionCounts: IntersectionCounts;
  degenerateSourceTriangles: number[];
  degenerateSideEdges: number[];
  valid: boolean;
  messages: string[];
}

export interface ThickenedSolid extends SolidOptions {
  model: SurfaceModel;
  /** 2n 个顶点: [0,n) = 原始层, [n,2n) = 偏移层 */
  positions: Float32Array;
  originalIndices: Uint32Array;
  offsetIndices: Uint32Array;
  sideIndices: Uint32Array;
  /** 每个侧壁三角形 -> 原始边映射; 长度 = sideIndices.length / 3 */
  sideFaces: SideFaceMeta[];
  sideWalls: SideWallStatus[];
  triangles: SolidTriangle[];
  validation: ValidationReport;
  sourceTriangleCount: number;
  vertexCount: number;
  triangleCount: number;
  volume: number;
  /** 厚度为 0 时为 true, 此时实体退化 */
  degenerate: boolean;
  builtAt: number;
}

export interface SampleGap {
  from: Vec3;
  to: Vec3;
  distance: number;
}

export interface RegionInspection {
  modelId: string;
  side: Side;
  triangleIds: number[];
  vertexIds: number[];
  triangleCount: number;
  vertexCount: number;
  nominalThickness: number;
  /** 偏移层采样点到原始曲面的最近间隙 */
  measuredMin: number;
  measuredMean: number;
  measuredMax: number;
  /** 对应原始/偏移顶点的间距 (应等于名义厚度) */
  pairedDistanceMin: number;
  pairedDistanceMax: number;
  baseNormal: Vec3;
  topNormal: Vec3;
  meanNormalDeviationDeg: number;
  maxNormalDeviationDeg: number;
  flippedTriangleCount: number;
  problemTriangleCount: number;
  areaRatioMin: number;
  areaRatioMax: number;
  sampleGaps: SampleGap[];
}

export interface ObjReadbackReport {
  vertexCount: number;
  triangleCount: number;
  topology: TopologyReport;
  intersectionPairs: number;
  bbox: Bounds | null;
  groups: string[];
  groupFaceCounts: Record<string, number>;
  valid: boolean;
  messages: string[];
}

export interface ObjSceneData {
  positions: Float32Array;
  indices: Uint32Array;
  groups: string[];
  groupFaceCounts: Record<string, number>;
}
