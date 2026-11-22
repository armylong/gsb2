/**
 * 核心数据结构。
 *
 * 说明（对应需求 1）：本工具严格区分两件事——
 *  - 几何重合：两个顶点坐标在容差内相同，但它们是不同的顶点编号；
 *  - 共享顶点：两个面引用同一个顶点编号（索引一致）。
 * 拓扑判定只认共享顶点，几何重合只作为“可焊接候选”的线索。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 焊接后的三角网格。索引是“位置编号”，不是渲染用的拆分顶点。 */
export interface MeshData {
  /** 顶点坐标是扁平数组 [x0,y0,z0, x1,...] */
  positions: number[];
  /** 每三个索引构成一个三角形 */
  indices: number[];
}

/** 一条边（无向，端点编号升序） */
export interface EdgeKey {
  a: number;
  b: number;
}

/** 边的拓扑类别 */
export type EdgeClass =
  /** 只被一个面使用：自由边 / 边界边 */
  | 'boundary'
  /** 恰好被两个面使用：正常流形边 */
  | 'manifold'
  /** 被三个及以上面使用：非流形（共享边超过两面） */
  | 'nonmanifold';

export interface EdgeInfo {
  a: number;
  b: number;
  /** 使用该边的面索引，按面索引升序 */
  faces: number[];
  cls: EdgeClass;
  /** 这条边的两个面朝向是否互相矛盾（同向使用同一条有向边） */
  orientationConflict: boolean;
}

export interface OrientationIssue {
  /** 冲突边 */
  edge: EdgeKey;
  /** 两个（或更多）面，彼此朝向不一致 */
  faces: number[];
}

export interface TopologyReport {
  /** 位置数组里的顶点总数（可能包含焊接后未被引用的顶点） */
  vertexCount: number;
  /** 被至少一个面引用的顶点数 */
  referencedVertexCount: number;
  /** 未被任何面引用的顶点数（焊接 / 导入残留） */
  unusedVertexCount: number;
  faceCount: number;
  edgeCount: number;
  /** 自由边 */
  boundaryEdges: EdgeInfo[];
  /** 共享边超过两个面的边 */
  nonManifoldEdges: EdgeInfo[];
  /** 朝向不一致的边 */
  orientationIssues: OrientationIssue[];
  /**
   * 所有“几何重合但索引不同”的顶点组（组内 >=2 个顶点）。
   * 用于说明：贴得很近 / 完全重合并不代表拓扑上已经接上。
   */
  coincidentVertexGroups: number[][];
  /** 几何上完全重合（索引不同）的面数：典型双层片的信号 */
  duplicateShellFaceCount: number;
  /** 面积为 0 的退化面数 */
  degenerateFaceCount: number;
  /** 通过共享边连通的独立外壳数量 */
  shellCount: number;
}

export interface MeshValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
