/** 基础类型：参数、网格与构建结果。几何计算在 XY 平面进行，映射到世界坐标 (x, 0, y)。 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface BranchParams {
  id: string;
  /** 中心线方向角（度，世界 XZ 平面内，逆时针） */
  angleDeg: number;
  /** 路宽，2–8 */
  width: number;
  /** 从交点到路端的长度，10–40 */
  length: number;
}

export interface IntersectionParams {
  /** 路缘转角半径，0–3 */
  cornerRadius: number;
  branches: BranchParams[];
}

export interface BranchRuntime {
  id: string;
  label: string;
  angleDeg: number;
  width: number;
  length: number;
  /** 沿中心线从交点到路口边界（截面完全进入本路走廊）的距离 */
  tClear: number;
  /** 停止线中心沿中心线的距离 */
  stopT: number;
  dashStart: number;
  dashEnd: number;
  dashCount: number;
}

export interface GeometryData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface MarkingQuad {
  branchLabel: string;
  kind: 'stop' | 'dash';
  /** 数学坐标（XY 平面）下的四个角点 */
  corners: Vec2[];
}

export interface BuildStats {
  vertexCount: number;
  triangleCount: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

export interface BuildSuccess {
  ok: true;
  /** 路面三角网格（世界坐标，y=0） */
  positions: Float32Array;
  indices: Uint32Array;
  /** 路口外轮廓（数学坐标，逆时针） */
  outline: Vec2[];
  branches: BranchRuntime[];
  centerMarkings: GeometryData;
  stopMarkings: GeometryData;
  markingQuads: MarkingQuad[];
  warnings: string[];
  stats: BuildStats;
}

export interface BuildFailure {
  ok: false;
  errors: string[];
}

export type BuildResult = BuildSuccess | BuildFailure;
